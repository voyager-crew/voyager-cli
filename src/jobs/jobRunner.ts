import {
  categoryOf,
  isOpName,
  type BridgeError,
  type JobStatus,
  type OpName,
} from '@voyager-crew/bridge-protocol';
/**
 * The job slots (spec §4.3/§4.4). One active job at a time, or several while
 * the extension allows parallel jobs (`./admission.ts`); a submit past that is
 * refused with `busy`, never queued. A job reaches its final status only once
 * its task slot is empty, so a cancelled job cannot overlap the next op on the
 * page, and jobs side by side take turns at the page (`./pageTurns.ts`).
 */
import { join } from 'node:path';

import {
  type CommandDef,
  conversationConflictKey,
  type JobContext,
  type PluginState,
} from '../plugins/api';
import { CALL_PLUGIN } from '../plugins/callPlugin';
import type { PluginRegistry } from '../plugins/registry';
import { type ExtensionState, policyFailure } from '../server/extensionState';
import type { LastConversation } from '../state/lastConversation';
import { type StoredPluginState, withSerialUpdates } from '../state/pluginState';
import { failure, toBridgeError } from '../util/errors';
import type { Logger } from '../util/log';
import { admissionFailure, jobCapacity } from './admission';
import type { BlobStore } from './blobStore';
import type { IncomingBlobStore } from './incomingBlobStore';
import { isTerminal, type JobRecord, type JobStore } from './jobStore';
import { createOpsClient } from './opsClient';
import { type PageTurnOptions, PageTurns } from './pageTurns';
import type { TaskSlot } from './taskSlot';

export interface JobRunnerDeps {
  readonly store: JobStore;
  readonly slot: TaskSlot;
  readonly registry: PluginRegistry;
  readonly extension: ExtensionState;
  readonly isPaired: () => boolean;
  readonly log: Logger;
  readonly blobs: BlobStore;
  /** Files the page downloaded for this job's `files.download` tasks. */
  readonly incoming: IncomingBlobStore;
  /** Told about the conversation of each job that succeeds with one (`ask --continue`). */
  readonly rememberConversation?: (entry: LastConversation) => Promise<void>;
  /** Each plugin's own state; kept in memory for the runner's life when not given. */
  readonly pluginState?: (plugin: string) => StoredPluginState;
  /** How long a job waits for its turn at the page; the defaults outside tests. */
  readonly pageTurns?: PageTurnOptions;
}

interface Active {
  readonly job: JobRecord;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly alone: boolean;
  /** What it works on: its command's key from the start, its conversation once that is known. */
  readonly conflictKeys: Set<string>;
}

/** A running job as `voyager status` shows it. */
export interface ActiveJobView {
  readonly jobId: string;
  readonly op?: OpName;
  /** `holding`: it acts on its page now; `waiting`: for another job to let go first. */
  readonly pageTurn?: 'holding' | 'waiting';
}

export interface SubmitOptions {
  /** `maxParallelJobs` from config.json: fewer jobs at once than the extension allows. */
  readonly maxParallelJobs?: number;
}

export class JobRunner {
  /** By job id, oldest first. */
  private readonly active = new Map<string, Active>();
  private readonly memoryState = new Map<string, unknown>();
  private readonly turns: PageTurns;
  /** Per plugin, its newest state update: updates of jobs side by side run one after another. */
  private readonly stateUpdates = new Map<string, { current: Promise<unknown> }>();

  constructor(private readonly deps: JobRunnerDeps) {
    this.turns = new PageTurns(deps.pageTurns);
  }

  /** Synchronous up to the busy check, so concurrent submits cannot both pass it. */
  submit(plugin: string, command: string, input: unknown, options: SubmitOptions = {}): JobRecord {
    const def = this.deps.registry.command(plugin, command);
    const running = [...this.active.values()].map((entry) => ({
      jobId: entry.job.jobId,
      alone: entry.alone,
      conflictKeys: [...entry.conflictKeys],
    }));
    const alone = plugin === CALL_PLUGIN;
    const conflictKey = conflictKeyOf(def, input);
    const capacity = jobCapacity(this.deps.extension.maxTasks, options.maxParallelJobs);
    const busy = admissionFailure(running, { alone, conflictKey }, capacity);
    if (busy !== undefined) throw busy;
    if (def === undefined) throw failure('bad-request', `unknown command ${plugin} ${command}`);
    if (!this.deps.isPaired()) {
      throw failure('not-paired', 'no extension is paired; run `voyager pair`');
    }
    const op = plugin === CALL_PLUGIN && isOpName(command) ? command : undefined;
    const refused = policyFailure(this.deps.extension.policy?.state, op);
    if (refused !== undefined) throw refused;
    const available = this.deps.extension.opNames();
    const required = this.deps.registry.plugin(plugin)?.requiresOps ?? [];
    const missing = available === null ? [] : required.filter((op) => !available.has(op));
    if (missing.length > 0) {
      throw failure(
        'unsupported-op',
        `the extension does not offer ${missing.join(', ')}; update the Voyager extension`,
        { missing },
      );
    }

    const job = this.deps.store.create(plugin, command, input);
    const controller = new AbortController();
    this.deps.store.appendEvent(job.jobId, 'status', { status: 'running' });
    const conflictKeys = new Set(conflictKey === undefined ? [] : [conflictKey]);
    const done = this.execute(job, def, controller);
    this.active.set(job.jobId, { job, controller, done, alone, conflictKeys });
    return job;
  }

  /** Every running job, oldest first, with the op it runs now and where it stands for the page turn. */
  activeJobs(): ActiveJobView[] {
    const holder = this.turns.current();
    const waiting = new Set(this.turns.waiting());
    return [...this.active.keys()].map((jobId) => {
      const op = this.deps.slot.taskOf(jobId)?.op;
      const pageTurn = holder === jobId ? 'holding' : waiting.has(jobId) ? 'waiting' : undefined;
      return {
        jobId,
        ...(op === undefined ? {} : { op }),
        ...(pageTurn === undefined ? {} : { pageTurn }),
      };
    });
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const job = await this.deps.store.get(jobId);
    if (job === undefined) throw failure('not-found', `no job ${jobId}`);
    const active = this.active.get(jobId);
    if (active?.job !== job) {
      throw failure('gone', `job ${jobId} has already ended (${job.status})`);
    }
    if (job.status !== 'cancelling') {
      this.setStatus(job, 'cancelling');
      active.controller.abort();
    }
    return job;
  }

  /** Resolves when every active job has fully ended. */
  async settled(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => entry.done));
  }

  private async execute(
    job: JobRecord,
    def: CommandDef,
    controller: AbortController,
  ): Promise<void> {
    // Let `submit` return (and record `active`) before the plugin starts.
    await Promise.resolve();
    let status: JobStatus;
    let error: BridgeError | undefined;
    let result: Readonly<Record<string, unknown>> | undefined;
    try {
      const output = await def.run(this.context(job, controller), job.input);
      if (controller.signal.aborted) throw failure('cancelled', 'job was cancelled');
      status = 'succeeded';
      result = output.data;
    } catch (thrown) {
      error = toBridgeError(thrown);
      // A cancel while the send was unconfirmed leaves the prompt possibly sent: say so, not "cancelled".
      if (controller.signal.aborted && error.code !== 'send-unverified') {
        error = toBridgeError(failure('cancelled', 'job was cancelled'));
      }
      status = statusForError(error, job.checkpoints);
    }
    // The page may still hold an abandoned task; the job ends only when it lets go.
    await this.deps.slot.idle(job.jobId);
    this.deps.blobs.forgetJob(job.jobId);
    // Downloads the job did not save go with it; a failed delete never changes its outcome.
    await this.deps.incoming.forgetJob(job.jobId).catch((error: unknown) => {
      this.deps.log.warn('could not delete unsaved downloads', {
        jobId: job.jobId,
        error: String(error),
      });
    });
    // Recorded before `done`, so a `--continue` right after the wait finds it.
    if (status === 'succeeded') await this.remember(job, result);
    this.deps.store.update(job, {
      status,
      ...(error === undefined ? {} : { error }),
      ...(result === undefined ? {} : { result }),
      // The plan changes; each result says which one the pages showed as it ended.
      account: this.deps.extension.account,
    });
    this.deps.store.appendEvent(job.jobId, 'status', { status });
    this.deps.store.appendEvent(job.jobId, 'done', {
      status,
      ...(error === undefined ? {} : { error }),
    });
    this.deps.log.info('job finished', { jobId: job.jobId, status, code: error?.code });
    this.active.delete(job.jobId);
  }

  private context(job: JobRecord, controller: AbortController): JobContext {
    const { store, slot, extension, log } = this.deps;
    const ops = createOpsClient({
      jobId: job.jobId,
      signal: controller.signal,
      slot,
      turns: this.turns,
      available: () => extension.opNames(),
      policy: () => extension.policy?.state,
      onStart: (op) => {
        if (op === 'turns.waitReply' && job.status === 'running')
          this.setStatus(job, 'waiting-reply');
      },
      onEnd: () => {
        if (job.status === 'waiting-reply') this.setStatus(job, 'running');
      },
      onProgress: (op, event) => store.appendEvent(job.jobId, 'progress', { op, event }),
    });
    return {
      jobId: job.jobId,
      signal: controller.signal,
      outputDir: store.outputDir(job.jobId),
      ops,
      blobs: {
        register: (path, options) => this.deps.blobs.register(job.jobId, path, options),
        save: (blob, name) =>
          this.deps.incoming.take(job.jobId, blob, join(store.outputDir(job.jobId), 'files'), name),
      },
      progress: (event) => store.appendEvent(job.jobId, 'progress', event),
      checkpoint: async (name, data) => {
        // Known now, so held from now: an `ask --chat <this id>` beside it would type into it too.
        if (typeof data.conversationId === 'string') {
          this.active
            .get(job.jobId)
            ?.conflictKeys.add(conversationConflictKey(data.conversationId));
        }
        job.checkpoints[name] = data;
        store.update(job, {});
        store.appendEvent(job.jobId, 'checkpoint', { name, data });
        try {
          await store.flush(job.jobId);
        } catch (error) {
          // The job stops here: a restart would not know what this checkpoint records,
          // and nothing after a `sent` checkpoint may send again.
          throw failure(
            'bad-request',
            `the ${name} checkpoint could not be saved: ${String(error)}`,
            {
              checkpoint: name,
            },
          );
        }
      },
      state: this.pluginState(job.plugin),
      log: {
        info: (message, fields) => {
          store.appendEvent(job.jobId, 'log', { level: 'info', message, ...fields });
          log.info(message, { jobId: job.jobId, ...fields });
        },
        warn: (message, fields) => {
          store.appendEvent(job.jobId, 'log', { level: 'warn', message, ...fields });
          log.warn(message, { jobId: job.jobId, ...fields });
        },
      },
    };
  }

  /** A plugin's state, whose `update`s from jobs side by side run one after another. */
  private pluginState(plugin: string): PluginState {
    const base: StoredPluginState = this.deps.pluginState?.(plugin) ?? {
      read: async () => this.memoryState.get(plugin),
      write: async (value: unknown) => void this.memoryState.set(plugin, value),
    };
    let last = this.stateUpdates.get(plugin);
    if (last === undefined) {
      last = { current: Promise.resolve() };
      this.stateUpdates.set(plugin, last);
    }
    return withSerialUpdates(base, last);
  }

  private async remember(
    job: JobRecord,
    result: Readonly<Record<string, unknown>> | undefined,
  ): Promise<void> {
    const conversationId = result?.conversationId;
    if (this.deps.rememberConversation === undefined || typeof conversationId !== 'string') return;
    const url = result?.conversationUrl;
    try {
      await this.deps.rememberConversation({
        conversationId,
        ...(typeof url === 'string' ? { url } : {}),
        jobId: job.jobId,
        command: job.command,
        at: Date.now(),
      });
    } catch (error) {
      this.deps.log.warn('could not record the last conversation', {
        jobId: job.jobId,
        error: String(error),
      });
    }
  }

  private setStatus(job: JobRecord, status: JobStatus): void {
    if (isTerminal(job.status)) return;
    this.deps.store.update(job, { status });
    this.deps.store.appendEvent(job.jobId, 'status', { status });
  }
}

/** The input is the client's JSON, unchecked: a key that cannot be read is no key. */
function conflictKeyOf(def: CommandDef | undefined, input: unknown): string | undefined {
  try {
    return def?.conflictKey?.(input);
  } catch {
    return undefined;
  }
}

/**
 * user-action → needs-user; a transient loss after the prompt went out →
 * detached (the conversation still exists); everything else → failed.
 */
export function statusForError(
  error: BridgeError,
  checkpoints: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): JobStatus {
  if (error.code === 'cancelled') return 'cancelled';
  const category = categoryOf(error.code);
  if (category === 'user-action') return 'needs-user';
  const knowsConversation = Object.values(checkpoints).some(
    (data) => typeof data.conversationId === 'string',
  );
  if (category === 'transient' && knowsConversation && error.code !== 'busy') return 'detached';
  return 'failed';
}

/**
 * The task slots (spec §2.2 delivery, §4.3 job slot): at most one task per job,
 * so a job's ops reach the page one after another. Jobs the runner lets run side
 * by side (the extension allows parallel jobs) each hold a slot of their own;
 * a poll carries one message, so their tasks go out on successive polls. A task
 * leaves its slot only when the extension can no longer be acting on it: its
 * result arrived, the extension stopped listing it after an abort, or the
 * extension stopped polling altogether.
 *
 * queued → dispatched → acked → running → (released)
 *   dispatched and absent from the next poll's `inflight`: delivered again, same taskId.
 *   acked/running and absent from `inflight`: failed as `extension-reloaded`, never again.
 *   abandoned (cancel, deadline): the promise rejects now; the next poll carries
 *   `abort`, and the slot stays taken until the extension lets go.
 */
import {
  bridgeError,
  EXTENSION_OFFLINE_MS,
  OP_VERSIONS,
  TASK_ACK_DEADLINE_MS,
  validateOpResult,
  type BridgeTask,
  type Envelope,
  type ErrorCode,
  type Issue,
  type OpName,
  type PolicyState,
  type PollResponse,
  type ValidatedBridgeTask,
} from '@voyager-crew/bridge-protocol';

import { policyFailure } from '../server/extensionState';
import { BridgeFailure, failure } from '../util/errors';
import { newId } from '../util/ids';

export interface TaskSlotOptions {
  readonly now?: () => number;
  readonly ackDeadlineMs?: number;
  readonly extensionOfflineMs?: number;
  /** Added to a task's own deadline before the server gives up on it. */
  readonly deadlineGraceMs?: number;
  /** How often an abort is sent again while the extension still lists the task. */
  readonly abortResendMs?: number;
}

type TaskState = 'queued' | 'dispatched' | 'acked' | 'running';

interface Entry {
  readonly task: { -readonly [K in keyof BridgeTask]: BridgeTask[K] };
  state: TaskState;
  delivered: boolean;
  abandoned?: ErrorCode;
  abortDelivered: boolean;
  abortSentAt: number;
  lastSeq: number;
  settled: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: BridgeFailure) => void;
  readonly onProgress?: (event: Readonly<Record<string, unknown>>) => void;
  ackTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  resendTimer?: NodeJS.Timeout;
}

export interface PollView {
  readonly inflight: ReadonlySet<string>;
  /** Ops the extension declared; null until it has polled once. */
  readonly ops: ReadonlySet<OpName> | null;
  readonly policy: PolicyState;
}

export interface RunTaskInput {
  readonly jobId: string;
  readonly op: OpName;
  /** Already checked with `validateOpParams`. */
  readonly params: unknown;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: Readonly<Record<string, unknown>>) => void;
}

export type TaskReply =
  | { readonly kind: 'ok' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly issues: readonly Issue[] };

const FINISHED_MEMORY = 64;

export interface SlotTask {
  readonly taskId: string;
  readonly jobId: string;
  readonly op: OpName;
}

export class TaskSlot {
  /** By task id, oldest first; one per job. */
  private readonly entries = new Map<string, Entry>();
  private readonly finished = new Map<string, 'done' | 'abandoned'>();
  /** Waiting for a job's slot to empty, or with `undefined` for every slot to. */
  private readonly idleWaiters: {
    readonly jobId: string | undefined;
    readonly wake: () => void;
  }[] = [];
  private readonly listeners = new Set<() => void>();
  /** Inside `poll`: a change it causes is told once it has returned (see `changed`). */
  private polling = false;
  private changePending = false;
  private offlineTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly ackDeadlineMs: number;
  private readonly extensionOfflineMs: number;
  private readonly deadlineGraceMs: number;
  private readonly abortResendMs: number;

  constructor(options: TaskSlotOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ackDeadlineMs = options.ackDeadlineMs ?? TASK_ACK_DEADLINE_MS;
    this.extensionOfflineMs = options.extensionOfflineMs ?? EXTENSION_OFFLINE_MS;
    this.deadlineGraceMs = options.deadlineGraceMs ?? 5_000;
    this.abortResendMs = options.abortResendMs ?? 2_000;
  }

  /** Run one op through the extension; waits for the job's slot to be free first. */
  async run(input: RunTaskInput): Promise<unknown> {
    await this.idle(input.jobId);
    if (input.signal?.aborted) throw failure('cancelled', 'job was cancelled');
    if (this.taskOf(input.jobId) !== undefined) return this.run(input);
    return new Promise<unknown>((resolve, reject) => {
      const entry: Entry = {
        task: {
          taskId: newId('t'),
          jobId: input.jobId,
          op: input.op,
          opVersion: OP_VERSIONS[input.op],
          params: input.params,
          deadlineMs: input.deadlineMs,
          issuedAt: 0,
        },
        state: 'queued',
        delivered: false,
        abortDelivered: false,
        abortSentAt: 0,
        lastSeq: -1,
        settled: false,
        resolve,
        reject,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      };
      this.entries.set(entry.task.taskId, entry);
      this.armOffline();
      input.signal?.addEventListener('abort', () => this.abandon(entry, 'cancelled'), {
        once: true,
      });
      this.changed();
    });
  }

  /** Every task in a slot, oldest first. */
  tasks(): SlotTask[] {
    return [...this.entries.values()].map(view);
  }

  /** The task `jobId` holds, if any. */
  taskOf(jobId: string): SlotTask | undefined {
    const entry = [...this.entries.values()].find((item) => item.task.jobId === jobId);
    return entry && view(entry);
  }

  /** Resolves once `jobId`'s slot is empty, or every slot when no job is named. */
  idle(jobId?: string): Promise<void> {
    if (this.isIdle(jobId)) return Promise.resolve();
    return new Promise((wake) => this.idleWaiters.push({ jobId, wake }));
  }

  /** Called whenever the slot may have something new for a held poll. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every poll proves the extension is alive, whatever it receives. */
  notePoll(): void {
    if (this.entries.size > 0) this.armOffline();
  }

  /**
   * What this poll should carry now, or undefined to keep holding it. Every slot
   * is brought up to date with what the poll lists; then the first one with
   * something to send (an abort first, then a task) sends it.
   */
  poll(view: PollView): PollResponse | undefined {
    this.polling = true;
    try {
      const waiting = [...this.entries.values()].filter((entry) => this.settleByPoll(entry, view));
      const abort = waiting.find((entry) => entry.abandoned !== undefined);
      if (abort !== undefined) return this.sendAbort(abort);
      const next = waiting.find(
        (entry) => entry.state === 'queued' || entry.state === 'dispatched',
      );
      return next === undefined ? undefined : this.dispatch(next);
    } finally {
      this.polling = false;
      if (this.changePending) {
        this.changePending = false;
        // After the poll's own caller has taken its answer: a held poll told synchronously
        // here would read the slots again before it sent the message just prepared.
        queueMicrotask(() => this.changed());
      }
    }
  }

  /**
   * Bring one slot up to date with a poll's `inflight`, without sending anything.
   * True when the slot has something to send: an abort due, or its task.
   */
  private settleByPoll(entry: Entry, view: PollView): boolean {
    const { taskId } = entry.task;
    const listed = view.inflight.has(taskId);

    if (entry.abandoned !== undefined) {
      if (!entry.delivered || (entry.abortDelivered && !listed)) {
        this.release(entry);
        return false;
      }
      // Still listed after an abort: that abort may have gone to a connection that had
      // already dropped, so send it again, at most once per resend interval.
      return !entry.abortDelivered || this.now() - entry.abortSentAt >= this.abortResendMs;
    }

    if ((entry.state === 'acked' || entry.state === 'running') && !listed) {
      // An acked task is never delivered twice: the page may already have acted on it.
      this.settle(
        entry,
        failure('extension-reloaded', `extension lost task ${taskId} (${entry.task.op})`),
      );
      this.release(entry);
      return false;
    }
    if (entry.state === 'dispatched' && listed) {
      entry.state = 'acked';
      clearTimeout(entry.ackTimer);
      return false;
    }
    if (entry.state === 'queued') {
      const refused = policyFailure(view.policy, entry.task.op);
      if (refused !== undefined) {
        this.settle(entry, refused);
        this.release(entry);
        return false;
      }
      if (view.ops !== null && !view.ops.has(entry.task.op)) {
        this.settle(
          entry,
          failure('unsupported-op', `the extension does not offer ${entry.task.op}`, {
            available: [...view.ops],
          }),
        );
        this.release(entry);
        return false;
      }
      return true;
    }
    return entry.state === 'dispatched';
  }

  private sendAbort(entry: Entry): PollResponse {
    entry.abortDelivered = true;
    entry.abortSentAt = this.now();
    clearTimeout(entry.resendTimer);
    entry.resendTimer = setTimeout(() => this.changed(), this.abortResendMs);
    return { kind: 'abort', taskId: entry.task.taskId, reason: entry.abandoned ?? 'cancelled' };
  }

  ack(taskId: string): TaskReply {
    const entry = this.match(taskId);
    if (entry === undefined) return this.unknown(taskId);
    if (entry.abandoned !== undefined) return { kind: 'gone' };
    if (entry.state === 'dispatched' || entry.state === 'queued') {
      entry.state = 'acked';
      clearTimeout(entry.ackTimer);
    }
    return { kind: 'ok' };
  }

  progress(taskId: string, seq: number, event: Readonly<Record<string, unknown>>): TaskReply {
    const entry = this.match(taskId);
    if (entry === undefined) return this.unknown(taskId);
    if (entry.abandoned !== undefined) return { kind: 'gone' };
    if (seq <= entry.lastSeq) return { kind: 'duplicate' };
    entry.lastSeq = seq;
    if (entry.state !== 'running') {
      entry.state = 'running';
      clearTimeout(entry.ackTimer);
    }
    entry.onProgress?.(event);
    return { kind: 'ok' };
  }

  /** The first result counts; later ones are acknowledged and dropped. */
  result(taskId: string, envelope: Envelope<unknown>): TaskReply {
    const entry = this.match(taskId);
    if (entry === undefined) {
      const finished = this.finished.get(taskId);
      if (finished === 'done') return { kind: 'duplicate' };
      return finished === 'abandoned' ? { kind: 'gone' } : { kind: 'not-found' };
    }
    if (entry.abandoned !== undefined) {
      this.release(entry);
      return { kind: 'gone' };
    }
    let reply: TaskReply = { kind: 'ok' };
    if (envelope.ok) {
      const checked = validateOpResult(entry.task.op, envelope.data);
      if (checked.ok) this.settle(entry, undefined, checked.value);
      else {
        reply = { kind: 'invalid', issues: checked.issues };
        this.settle(
          entry,
          failure('bad-request', `extension sent an invalid ${entry.task.op} result`, {
            issues: checked.issues,
          }),
        );
      }
    } else {
      this.settle(
        entry,
        new BridgeFailure(
          bridgeError(envelope.error.code, envelope.error.message, envelope.error.details),
        ),
      );
    }
    this.release(entry);
    return reply;
  }

  close(): void {
    for (const entry of this.entries.values()) {
      this.settle(entry, failure('server-unreachable', 'voyager serve stopped'));
      this.release(entry);
    }
  }

  private dispatch(entry: Entry): PollResponse {
    if (!entry.delivered) {
      entry.delivered = true;
      entry.task.issuedAt = this.now();
      entry.deadlineTimer = setTimeout(
        () => this.abandon(entry, 'timeout'),
        entry.task.deadlineMs + this.deadlineGraceMs,
      );
    }
    entry.state = 'dispatched';
    clearTimeout(entry.ackTimer);
    entry.ackTimer = setTimeout(() => {
      // Never acked: offer it again to whichever poll comes next.
      if (this.holds(entry) && entry.state === 'dispatched' && entry.abandoned === undefined) {
        entry.state = 'queued';
        this.changed();
      }
    }, this.ackDeadlineMs);
    // Params were validated against `op` before the task was created.
    return { kind: 'task', task: { ...entry.task } as ValidatedBridgeTask };
  }

  private abandon(entry: Entry, reason: ErrorCode): void {
    if (!this.holds(entry) || entry.abandoned !== undefined) return;
    const message = reason === 'timeout' ? `${entry.task.op} timed out` : 'job was cancelled';
    this.settle(entry, failure(reason, message));
    clearTimeout(entry.ackTimer);
    clearTimeout(entry.deadlineTimer);
    if (!entry.delivered) {
      this.release(entry);
      return;
    }
    entry.abandoned = reason;
    this.changed();
  }

  private armOffline(): void {
    clearTimeout(this.offlineTimer);
    this.offlineTimer = setTimeout(() => {
      // Nobody is polling, so nobody is running the tasks: every slot can be freed.
      for (const entry of this.entries.values()) {
        this.settle(
          entry,
          failure(
            'extension-offline',
            `no poll from the extension for ${this.extensionOfflineMs / 1000}s`,
          ),
        );
        this.release(entry);
      }
    }, this.extensionOfflineMs);
  }

  private settle(entry: Entry, error: BridgeFailure | undefined, value?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (error !== undefined) entry.reject(error);
    else entry.resolve(value);
  }

  private release(entry: Entry): void {
    if (!this.holds(entry)) return;
    clearTimeout(entry.ackTimer);
    clearTimeout(entry.deadlineTimer);
    clearTimeout(entry.resendTimer);
    this.entries.delete(entry.task.taskId);
    if (this.entries.size === 0) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = undefined;
    }
    this.finished.set(entry.task.taskId, entry.abandoned === undefined ? 'done' : 'abandoned');
    while (this.finished.size > FINISHED_MEMORY) {
      const oldest = this.finished.keys().next().value;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
    }
    for (const waiter of this.idleWaiters.filter((item) => this.isIdle(item.jobId))) {
      this.idleWaiters.splice(this.idleWaiters.indexOf(waiter), 1);
      waiter.wake();
    }
    this.changed();
  }

  private holds(entry: Entry): boolean {
    return this.entries.get(entry.task.taskId) === entry;
  }

  private isIdle(jobId: string | undefined): boolean {
    if (jobId === undefined) return this.entries.size === 0;
    return [...this.entries.values()].every((entry) => entry.task.jobId !== jobId);
  }

  private match(taskId: string): Entry | undefined {
    return this.entries.get(taskId);
  }

  private unknown(taskId: string): TaskReply {
    return this.finished.has(taskId) ? { kind: 'gone' } : { kind: 'not-found' };
  }

  private changed(): void {
    if (this.polling) {
      this.changePending = true;
      return;
    }
    for (const listener of this.listeners) listener();
  }
}

function view(entry: Entry): SlotTask {
  return { taskId: entry.task.taskId, jobId: entry.task.jobId, op: entry.task.op };
}

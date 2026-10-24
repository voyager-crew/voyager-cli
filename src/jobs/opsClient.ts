import {
  validateOpParams,
  WAIT_REPLY_MAX_TIMEOUT_MS,
  type OpName,
  type OpParamsMap,
  type OpResultMap,
  type PolicyState,
} from '@voyager-crew/bridge-protocol';

import type { OpCallOptions, OpsClient } from '../plugins/api';
import { policyFailure } from '../server/extensionState';
import { failure } from '../util/errors';
import { type PageTurns, takesPageTurn } from './pageTurns';
import type { TaskSlot } from './taskSlot';

/** Server-side wait for an op's result when the caller gives none. */
const DEFAULT_OP_TIMEOUT_MS: Readonly<Record<Exclude<OpName, 'turns.waitReply'>, number>> = {
  'conversation.open': 60_000,
  'conversation.close': 15_000,
  'conversation.ready': 30_000,
  'model.inspect': 15_000,
  'model.select': 30_000,
  'composer.attach': 120_000,
  'composer.send': 30_000,
  'turns.read': 30_000,
  // One click under a 20 s page lease.
  'turns.approve': 30_000,
  // The size is unknown until the page has the file; up to MAX_DOWNLOAD_BYTES in 4 MiB chunks.
  'files.download': 10 * 60_000,
  'project.list': 20_000,
  'project.create': 45_000,
  'project.open': 60_000,
  'project.files': 30_000,
  'project.upload': 120_000,
  'project.remove': 30_000,
  // The extension's own fetch gives up after 15 s.
  'catalog.refresh': 30_000,
};
const WAIT_REPLY_MARGIN_MS = 30_000;

export function defaultOpTimeout(op: OpName, params: unknown): number {
  if (op === 'turns.waitReply') {
    // No fixed wait: the page fails a reply that stops moving (`reply-stalled`); this is only its cap.
    const timeoutMs = (params as OpParamsMap['turns.waitReply']).timeoutMs;
    return (timeoutMs ?? WAIT_REPLY_MAX_TIMEOUT_MS) + WAIT_REPLY_MARGIN_MS;
  }
  return DEFAULT_OP_TIMEOUT_MS[op];
}

export interface OpsClientHooks {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly slot: TaskSlot;
  readonly turns: PageTurns;
  readonly available: () => ReadonlySet<OpName> | null;
  /** The policy the extension last reported; undefined until it has polled. */
  readonly policy: () => PolicyState | undefined;
  readonly onStart: (op: OpName) => void;
  readonly onEnd: (op: OpName) => void;
  readonly onProgress: (op: OpName, event: Readonly<Record<string, unknown>>) => void;
}

/** Turns one op call into one task in the slot and waits for its result. */
export function createOpsClient(hooks: OpsClientHooks): OpsClient {
  const { jobId, signal, slot, turns } = hooks;
  /**
   * Hold the page turn around `work`. It is given back only once the job's slot is empty:
   * a task given up early (cancel, deadline) may still be acting on the page.
   */
  const inTurn = async <T>(work: () => Promise<T>, cleanup = false): Promise<T> => {
    const giveBack = await turns.take(jobId, { signal, cleanup });
    try {
      return await work();
    } finally {
      await slot.idle(jobId);
      giveBack();
    }
  };
  return {
    exclusive: (work) => inTurn(work),
    async call<K extends OpName>(
      op: K,
      params: OpParamsMap[K],
      options: OpCallOptions = {},
    ): Promise<OpResultMap[K]> {
      if (hooks.signal.aborted) throw failure('cancelled', 'job was cancelled');
      const refused = policyFailure(hooks.policy(), op);
      if (refused !== undefined) throw refused;
      const available = hooks.available();
      if (available !== null && !available.has(op)) {
        throw failure('unsupported-op', `the extension does not offer ${op}`, {
          available: [...available],
        });
      }
      const checked = validateOpParams(op, params);
      if (!checked.ok) {
        throw failure('bad-request', `invalid params for ${op}`, { issues: checked.issues });
      }
      const deadlineMs = options.timeoutMs ?? defaultOpTimeout(op, checked.value);
      const run = async (): Promise<OpResultMap[K]> => {
        hooks.onStart(op);
        // While this job holds the page turn, the jobs waiting for it wait as long as this op may take.
        turns.opStarted(jobId, op, deadlineMs);
        try {
          const result = await slot.run({
            jobId,
            op,
            params: checked.value,
            deadlineMs,
            signal,
            onProgress: (event) => hooks.onProgress(op, event),
          });
          // TaskSlot validated the result with `validateOpResult(op, …)`.
          return result as OpResultMap[K];
        } finally {
          turns.opEnded(jobId);
          hooks.onEnd(op);
        }
      };
      // Closing the tab is the job's last step: a sibling's long turn may leave the tab open, never the job running.
      return takesPageTurn(op) ? inTurn(run, op === 'conversation.close') : run();
    },
  };
}

/**
 * Whose turn it is to act on a ChatGPT page. The extension lets one op type,
 * click, open or close at a time across all its tabs (its page lease), and
 * answers `busy` rather than queueing, so jobs that run side by side take turns
 * here before such an op goes out. Waits and reads never take a turn: replies of
 * several jobs are awaited at once. A job may hold its turn across several ops
 * (`ops.exclusive`); turns are first come, first served.
 *
 * Nobody waits on a fixed clock: the holder may take as long as its current op
 * may (that op's own deadline, `defaultOpTimeout` or the plugin's `timeoutMs`,
 * as in `./opsClient.ts`), plus `graceMs`; between its ops it has `graceMs`.
 * Only a holder past that fails the jobs waiting behind it, as `busy` before
 * their op goes out.
 */
import type { OpName } from '@voyager-crew/bridge-protocol';

import { type BridgeFailure, failure } from '../util/errors';

/** Ops that only watch or read a page, so they run beside another job's turn. */
const PASSIVE_OPS: ReadonlySet<OpName> = new Set<OpName>([
  'model.inspect',
  'turns.waitReply',
  'turns.read',
  'files.download',
  'project.list',
  'catalog.refresh',
]);

/** Ops the extension runs under its page lease, plus the tab ops that lease a step. */
export function takesPageTurn(op: OpName): boolean {
  return !PASSIVE_OPS.has(op);
}

/**
 * How far past its op's deadline the holder may go (the slot gives up on a task 5 s after
 * it, then waits for the extension to let go), and how long it may pause between ops.
 */
export const PAGE_TURN_GRACE_MS = 60_000;
/**
 * How long closing a job's tab waits: the job's outcome is settled by then and only a
 * tab is at stake, so another job's long turn leaves the tab open, never the job running.
 */
export const CLEANUP_TURN_WAIT_MS = 60_000;

export interface PageTurnOptions {
  readonly graceMs?: number;
  readonly cleanupWaitMs?: number;
}

export interface TakeOptions {
  readonly signal?: AbortSignal;
  /** A cleanup step (closing the tab): it waits `cleanupWaitMs` at most. */
  readonly cleanup?: boolean;
}

interface Waiter {
  readonly jobId: string;
  readonly grant: () => void;
  readonly fail: (error: BridgeFailure) => void;
}

export class PageTurns {
  private holder: string | undefined;
  private depth = 0;
  private readonly queue: Waiter[] = [];
  /** When the holder is overdue: its current op's deadline plus grace, or grace between ops. */
  private holderDue = 0;
  /** The op the holder runs now, for the message of the jobs it holds up. */
  private holderOp: OpName | undefined;
  private overdueTimer: NodeJS.Timeout | undefined;
  private readonly graceMs: number;
  private readonly cleanupWaitMs: number;

  constructor(options: PageTurnOptions = {}) {
    this.graceMs = options.graceMs ?? PAGE_TURN_GRACE_MS;
    this.cleanupWaitMs = options.cleanupWaitMs ?? CLEANUP_TURN_WAIT_MS;
  }

  /** Wait for `jobId`'s turn (at once when it already holds it); call the result to give it back. */
  async take(jobId: string, options: TakeOptions = {}): Promise<() => void> {
    const { signal } = options;
    if (signal?.aborted) throw failure('cancelled', 'job was cancelled');
    if (this.holder === undefined || this.holder === jobId) this.grant(jobId);
    else await this.wait(jobId, signal, options.cleanup === true);
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.giveBack();
    };
  }

  /** The holder started an op that may take `deadlineMs`; ignored from any other job. */
  opStarted(jobId: string, op: OpName, deadlineMs: number): void {
    if (this.holder !== jobId) return;
    this.holderOp = op;
    this.due(deadlineMs + this.graceMs);
  }

  /** The holder's op has left its slot; it has `graceMs` until the next one. */
  opEnded(jobId: string): void {
    if (this.holder !== jobId) return;
    this.holderOp = undefined;
    this.due(this.graceMs);
  }

  /** The job whose turn it is, if any. */
  current(): string | undefined {
    return this.holder;
  }

  /** Jobs waiting for their turn, first in line first. */
  waiting(): string[] {
    return this.queue.map((waiter) => waiter.jobId);
  }

  private wait(jobId: string, signal: AbortSignal | undefined, cleanup: boolean): Promise<void> {
    if (Date.now() >= this.holderDue) return Promise.reject(this.overdueFailure());
    return new Promise<void>((resolve, reject) => {
      const leave = (): boolean => {
        clearTimeout(cleanupTimer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.queue.indexOf(waiter);
        if (index < 0) return false;
        this.queue.splice(index, 1);
        return true;
      };
      const waiter: Waiter = {
        jobId,
        grant: () => {
          leave();
          resolve();
        },
        fail: (error) => {
          if (leave()) reject(error);
        },
      };
      const onAbort = (): void => waiter.fail(failure('cancelled', 'job was cancelled'));
      const cleanupTimer = cleanup
        ? setTimeout(() => waiter.fail(this.overdueFailure(this.cleanupWaitMs)), this.cleanupWaitMs)
        : undefined;
      this.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.armOverdue();
    });
  }

  private due(fromNowMs: number): void {
    this.holderDue = Date.now() + fromNowMs;
    this.armOverdue();
  }

  /** One timer for the whole queue: they all wait behind the same holder. */
  private armOverdue(): void {
    clearTimeout(this.overdueTimer);
    this.overdueTimer = undefined;
    if (this.holder === undefined || this.queue.length === 0) return;
    this.overdueTimer = setTimeout(
      () => {
        if (Date.now() < this.holderDue) {
          this.armOverdue();
          return;
        }
        const error = this.overdueFailure();
        // A copy: each failed waiter leaves the queue.
        for (const waiter of this.queue.slice()) waiter.fail(error);
      },
      Math.max(0, this.holderDue - Date.now()),
    );
  }

  private overdueFailure(cleanupWaitMs?: number): BridgeFailure {
    const holder = this.holder ?? '?';
    const step = this.holderOp === undefined ? 'between its steps' : `in ${this.holderOp}`;
    const why =
      cleanupWaitMs === undefined
        ? `job ${holder} has held the ChatGPT page past the time it may take (${step})`
        : `job ${holder} still holds the ChatGPT page (${step}) after ${Math.round(cleanupWaitMs / 1000)} s`;
    return failure('busy', `${why}; nothing was sent for this step`, {
      activeJobId: this.holder,
      pageTurn: true,
      ...(this.holderOp === undefined ? {} : { holderOp: this.holderOp }),
    });
  }

  private grant(jobId: string): void {
    if (this.holder !== jobId) {
      this.holder = jobId;
      this.holderOp = undefined;
      this.due(this.graceMs);
    }
    this.depth += 1;
  }

  private giveBack(): void {
    this.depth -= 1;
    if (this.depth > 0) return;
    this.holder = undefined;
    this.holderOp = undefined;
    const next = this.queue[0];
    if (next === undefined) {
      clearTimeout(this.overdueTimer);
      this.overdueTimer = undefined;
      return;
    }
    this.grant(next.jobId);
    next.grant();
    this.armOverdue();
  }
}

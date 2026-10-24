/**
 * Whether one more job may start (spec §4.3). One job runs at a time unless
 * the extension allows parallel jobs: then up to the jobs it runs at once, or
 * fewer when `maxParallelJobs` in config.json says so. Nothing is queued: a job
 * past the limit, one that works on what a running job works on (the same
 * conversation, the same project), or any job beside a raw `voyager call` is
 * refused as `busy`.
 */
import { failure, type BridgeFailure } from '../util/errors';

export interface RunningJob {
  readonly jobId: string;
  /** A raw single op (`voyager call`): it borrows whichever tab is free, so it runs alone. */
  readonly alone: boolean;
  /** What it works on (a conversation, the projects); another job on one of them is refused. */
  readonly conflictKeys: readonly string[];
}

/** The job about to start: its key is only what its input names. */
export interface NextJob {
  readonly alone: boolean;
  readonly conflictKey: string | undefined;
}

/** Jobs that may run at once: the extension's capacity, capped by the person's limit. */
export function jobCapacity(extensionMaxTasks: number | null, configured?: number): number {
  const extension = extensionMaxTasks ?? 1;
  return configured === undefined ? extension : Math.max(1, Math.min(extension, configured));
}

export function admissionFailure(
  running: readonly RunningJob[],
  next: NextJob,
  capacity: number,
): BridgeFailure | undefined {
  const first = running[0];
  if (first === undefined) return undefined;
  const details = {
    activeJobId: first.jobId,
    activeJobIds: running.map((job) => job.jobId),
    maxJobs: capacity,
  };
  if (capacity <= 1) return failure('busy', 'another job is running; it is not queued', details);
  if (next.alone || running.some((job) => job.alone)) {
    return failure(
      'busy',
      'voyager call runs only while no other job does; it is not queued',
      details,
    );
  }
  if (running.length >= capacity) {
    return failure(
      'busy',
      `${running.length} jobs are running, as many as may run at once; it is not queued`,
      details,
    );
  }
  const key = next.conflictKey;
  const clash =
    key === undefined ? undefined : running.find((job) => job.conflictKeys.includes(key));
  if (clash !== undefined) {
    return failure(
      'busy',
      `job ${clash.jobId} is working on ${next.conflictKey}; it is not queued`,
      { ...details, activeJobId: clash.jobId, conflict: next.conflictKey },
    );
  }
  return undefined;
}

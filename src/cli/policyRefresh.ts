/**
 * A stale extension policy refuses a job when it is submitted, before anything
 * reaches ChatGPT. `catalog.refresh` is the one op it lets through, and usually
 * all that is wrong is that the page data has not been fetched yet. So refresh it
 * and submit again. Only that refused submit is repeated: a job that started and
 * failed later may have sent its prompt, and is never sent twice.
 */
import {
  BRIDGE_PATHS,
  POLL_HOLD_MS,
  type JobSubmitResponse,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';

import type { ServeClient } from '../client/serveClient';
import { BridgeFailure, failure, toBridgeError } from '../util/errors';
import { isRecord } from '../util/isRecord';
import { note } from './output';
import { waitForJob } from './waitJob';

/** A refresh can fail once and work moments later, so one failure is not the answer yet. */
const REFRESH_ATTEMPTS = 2;
const REFRESH_WAIT_MS = 30_000;
/** The extension reports its policy when it polls, and a poll already held open has to end first. */
const POLICY_REPORT_WAIT_MS = POLL_HOLD_MS + 5_000;
const POLICY_POLL_MS = 200;

/** Why this refresh did not produce page data; undefined when it did. */
async function refreshOnce(client: ServeClient): Promise<string | undefined> {
  const { jobId } = await client.request<JobSubmitResponse>('POST', BRIDGE_PATHS.call, {
    op: 'catalog.refresh',
    params: {},
  });
  const { kind, job } = await waitForJob(client, jobId, REFRESH_WAIT_MS);
  if (kind === 'timeout') return 'the extension did not answer';
  if (job.status !== 'succeeded') return job.error?.message ?? job.status;
  const result = job.result?.result;
  if (!isRecord(result)) return 'the extension sent no result';
  if (result.status === 'updated' || result.status === 'unchanged') return undefined;
  return typeof result.reason === 'string' ? result.reason : String(result.status);
}

async function policyReported(client: ServeClient): Promise<boolean> {
  const deadline = Date.now() + POLICY_REPORT_WAIT_MS;
  while (Date.now() < deadline) {
    const status = await client.request<StatusResponse>('GET', BRIDGE_PATHS.status);
    if (status.extension.policy?.state !== 'stale') return true;
    await new Promise((resolve) => setTimeout(resolve, POLICY_POLL_MS));
  }
  return false;
}

/** Why the policy is still stale after trying to refresh it; undefined once it is not. */
async function refreshPolicy(client: ServeClient): Promise<string | undefined> {
  let reason: string | undefined;
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
    try {
      reason = await refreshOnce(client);
    } catch (thrown) {
      return toBridgeError(thrown).message;
    }
    if (reason === undefined) {
      return (await policyReported(client)) ? undefined : 'the extension still reports it stale';
    }
  }
  return reason;
}

/** Run `submit`; if a stale policy refuses it, refresh the policy and submit once more. */
export async function submitWithFreshPolicy<T>(
  client: ServeClient,
  submit: () => Promise<T>,
): Promise<T> {
  try {
    return await submit();
  } catch (thrown) {
    if (!(thrown instanceof BridgeFailure) || thrown.error.code !== 'policy-stale') throw thrown;
    note('the extension policy is out of date; refreshing it from voyager.nagi.fun');
    const reason = await refreshPolicy(client);
    if (reason !== undefined) {
      throw failure('policy-stale', `${thrown.message} (refreshing it failed: ${reason})`);
    }
  }
  return submit();
}

import {
  BRIDGE_PATHS,
  type BridgeError,
  bridgePath,
  isOpName,
  type JobSubmitResponse,
  type JobSummary,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';

import { ensureServe, type ServeClient } from '../../client/serveClient';
import type { JobDetail } from '../../jobs/jobStore';
import type { PluginRegistry } from '../../plugins/registry';
import type { StatePaths } from '../../state/paths';
import { BridgeFailure, failure } from '../../util/errors';
import { accountJson } from '../accountPlan';
import { parse, waitTimeout, WAIT_OPTIONS } from '../args';
import { EXIT } from '../exitCodes';
import { note, printJson, printLine } from '../output';
import { presentJob, UNTRUSTED_NOTICE } from '../present';
import { describeEvent, waitForJob } from '../waitJob';
import { warnIfExtensionAway } from './info';

/** Submit through `submit`, then wait and print; shared by plugin commands and `call`. */
export async function submitAndWait(
  client: ServeClient,
  registry: PluginRegistry,
  args: { json: boolean; noWait: boolean; timeoutMs: number },
  submit: () => Promise<JobSubmitResponse>,
): Promise<number> {
  const status = await warnIfExtensionAway(client);
  // A job still running has no plan of its own yet: the last one the extension reported.
  const account = accountJson(status.extension.account);
  let jobId: string;
  try {
    ({ jobId } = await submit());
  } catch (error) {
    if (error instanceof BridgeFailure && error.code === 'busy') {
      if (args.json) printJson({ ok: false, error: error.error });
      else note(busyNote(error.error));
      return EXIT.busy;
    }
    throw error;
  }
  if (args.noWait) {
    if (args.json) printJson({ jobId, status: 'running', ...account });
    else printLine(jobId);
    return EXIT.ok;
  }
  if (!args.json) note(`job ${jobId}`);
  return waitAndPresent(client, registry, jobId, { ...args, account });
}

/** Why a submit was refused, and which job to wait for. */
export function busyNote(error: BridgeError): string {
  const active = String(error.details?.activeJobId ?? '?');
  const maxJobs = error.details?.maxJobs;
  // One job at a time (an older Voyager, or parallel jobs off): the same words as before.
  if (typeof maxJobs !== 'number' || maxJobs <= 1) {
    return `busy: job ${active} is running. Wait with voyager job wait ${active}; jobs are not queued.`;
  }
  const others = error.details?.activeJobIds;
  const several =
    error.details?.conflict === undefined && Array.isArray(others) && others.length > 1;
  const which = several ? ` (running: ${others.join(', ')})` : '';
  return `busy: ${error.message}. Wait with voyager job wait ${active}${which}.`;
}

async function waitAndPresent(
  client: ServeClient,
  registry: PluginRegistry,
  jobId: string,
  args: { json: boolean; timeoutMs: number; account?: ReturnType<typeof accountJson> },
): Promise<number> {
  const outcome = await waitForJob(client, jobId, args.timeoutMs, (event) => {
    const line = args.json ? undefined : describeEvent(event);
    if (line !== undefined) note(line);
  });
  if (outcome.kind === 'timeout') {
    if (args.json) {
      printJson({
        jobId,
        status: outcome.job.status,
        waitTimedOut: true,
        // Still running: the plan the extension reports now.
        ...(args.account ??
          accountJson(
            (await client.request<StatusResponse>('GET', BRIDGE_PATHS.status)).extension.account,
          )),
      });
    } else
      note(
        `still ${outcome.job.status}; the job continues. Wait again with voyager job wait ${jobId}; do not resend the prompt.`,
      );
    return EXIT.waitTimeout;
  }
  return presentJob(outcome.job, registry, args.json);
}

export async function callCommand(
  paths: StatePaths,
  registry: PluginRegistry,
  argv: readonly string[],
): Promise<number> {
  const args = parse(argv, {
    ...WAIT_OPTIONS,
    params: { type: 'string', summary: 'op params as JSON' },
  });
  const op = args.positionals[0];
  if (!isOpName(op)) throw failure('bad-request', 'usage: voyager call <op> [--params JSON]');
  let params: unknown = {};
  if (typeof args.options.params === 'string') {
    try {
      params = JSON.parse(args.options.params) as unknown;
    } catch {
      throw failure('bad-request', '--params is not valid JSON');
    }
  }
  const client = await ensureServe(paths);
  const json = args.options.json === true;
  if (!json) note(UNTRUSTED_NOTICE);
  return submitAndWait(
    client,
    registry,
    { json, noWait: args.options['no-wait'] === true, timeoutMs: waitTimeout(args) },
    () => client.request<JobSubmitResponse>('POST', BRIDGE_PATHS.call, { op, params }),
  );
}

export async function jobCommand(
  paths: StatePaths,
  registry: PluginRegistry,
  argv: readonly string[],
): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parse(rest, WAIT_OPTIONS);
  const json = args.options.json === true;
  const jobId = args.positionals[0];
  const needId = (): string => {
    if (jobId === undefined) throw failure('bad-request', `usage: voyager job ${sub} <jobId>`);
    return jobId;
  };
  const client = await ensureServe(paths);

  switch (sub) {
    case 'list': {
      const { jobs } = await client.request<{ jobs: JobSummary[] }>('GET', BRIDGE_PATHS.jobs);
      if (json) printJson({ jobs });
      else
        for (const job of jobs)
          printLine(
            `${job.jobId}  ${job.status.padEnd(13)} ${job.plugin} ${job.command}  ${new Date(job.createdAt).toISOString()}`,
          );
      return EXIT.ok;
    }
    case 'show': {
      const job = await client.request<JobDetail>('GET', bridgePath.job(needId()));
      printJson(job);
      return EXIT.ok;
    }
    case 'wait':
      return waitAndPresent(client, registry, needId(), { json, timeoutMs: waitTimeout(args) });
    case 'cancel': {
      const job = await client.request<JobDetail>('POST', bridgePath.jobCancel(needId()));
      if (json) printJson({ jobId: job.jobId, status: job.status });
      else
        note(
          `job ${job.jobId} ${job.status}. A prompt already sent stays in ChatGPT; voyager job wait ${job.jobId} shows the end.`,
        );
      return EXIT.ok;
    }
    case 'harvest':
      await client.request('POST', bridgePath.jobHarvest(needId()));
      return EXIT.ok;
    default:
      throw failure(
        'bad-request',
        'usage: voyager job list | show <id> | wait <id> [--timeout 30m] | cancel <id> | harvest <id>',
      );
  }
}

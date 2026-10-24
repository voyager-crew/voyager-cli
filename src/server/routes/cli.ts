/** CLI endpoints (spec §2.2): CLI token, and no Origin at all. */
import {
  BRIDGE_PATHS,
  normalizePairingCode,
  validateMessage,
  type CommandsResponse,
  type JobEventsResponse,
  type JobSubmitResponse,
} from '@voyager-crew/bridge-protocol';

import { jobCapacity } from '../../jobs/admission';
import { CALL_PLUGIN } from '../../plugins/callPlugin';
import { loadConfig } from '../../state/config';
import { failure } from '../../util/errors';
import { CLI_VERSION } from '../../version';
import type { Route, ServerCore } from '../http';
import type { ServeStatus } from '../serveStatus';

const JOB = '([A-Za-z0-9_-]{1,128})';
const MAX_EVENTS_WAIT_S = 25;

export function cliRoutes(core: ServerCore): Route[] {
  const { pairing, extension, runner, store, registry } = core;

  /** The last unusable `maxParallelJobs` logged, so each mistake is logged once. */
  let warnedLimit: string | undefined;
  /** `maxParallelJobs`; a config.json that cannot be read limits nothing, and is logged. */
  const limits = async (): Promise<{ maxParallelJobs?: number }> => {
    const config = await loadConfig(core.paths).catch((error: unknown) => {
      core.log.warn('config.json could not be read', { error: String(error) });
      return { maxParallelJobs: undefined, invalidMaxParallelJobs: undefined };
    });
    const invalid = config.invalidMaxParallelJobs;
    if (invalid !== undefined && invalid !== warnedLimit) {
      core.log.warn(
        'maxParallelJobs in config.json is not a whole number of 1 or more; running one job at a time',
        { maxParallelJobs: invalid },
      );
    }
    warnedLimit = invalid;
    return config.maxParallelJobs === undefined ? {} : { maxParallelJobs: config.maxParallelJobs };
  };

  const requireJob = async (jobId: string) => {
    const job = await store.get(jobId);
    if (job === undefined) throw failure('not-found', `no job ${jobId}`);
    return job;
  };

  return [
    {
      method: 'GET',
      pattern: /^\/v1\/status$/,
      access: 'cli',
      handle: async () => {
        const current = pairing.current;
        const { maxParallelJobs } = await limits();
        const activeJobs = runner.activeJobs();
        const first = activeJobs[0];
        const activeJob =
          first === undefined
            ? undefined
            : { jobId: first.jobId, ...(first.op === undefined ? {} : { op: first.op }) };
        const data: ServeStatus = {
          extension: {
            paired: current !== null,
            lastPollAt: extension.lastPollAt,
            version: current?.extensionVersion ?? null,
            browser: current?.browser ?? null,
            policy: extension.policy,
            account: extension.account,
            maxTasks: extension.maxTasks,
          },
          ...(activeJob === undefined ? {} : { activeJob, activeJobs }),
          maxJobs: jobCapacity(extension.maxTasks, maxParallelJobs),
          serverVersion: CLI_VERSION,
        };
        return { status: 200, data };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/commands$/,
      access: 'cli',
      handle: () => {
        const data: CommandsResponse = {
          ops: extension.ops ?? [],
          commands: registry.listCommands(),
        };
        return { status: 200, data };
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/pairing-codes$/,
      access: 'cli',
      handle: () => ({ status: 200, data: pairing.issueCode() }),
    },
    {
      method: 'GET',
      pattern: /^\/v1\/pairing-codes\/([0-9-]{1,16})$/,
      access: 'cli',
      handle: ({ params }) => {
        const code = normalizePairingCode(params[0]);
        const state = code === undefined ? undefined : pairing.codeState(code);
        if (state === undefined) throw failure('not-found', 'no such pairing code');
        return { status: 200, data: state };
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/unpair$/,
      access: 'cli',
      handle: async () => {
        const revoked = await pairing.revoke();
        extension.forget();
        core.heldPoll?.();
        core.log.info('pairing revoked from the CLI');
        return { status: 200, data: { revoked } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/jobs$/,
      access: 'cli',
      handle: async ({ body }) => {
        const checked = validateMessage('jobSubmitRequest', body);
        if (!checked.ok) throw failure('bad-request', 'invalid job', { issues: checked.issues });
        const { plugin, command, input } = checked.value;
        if (plugin === CALL_PLUGIN)
          throw failure('bad-request', `use ${BRIDGE_PATHS.call} for single ops`);
        // Read before the synchronous submit, so two submits still meet its busy check in turn.
        const { maxParallelJobs } = await limits();
        const job = runner.submit(
          plugin,
          command,
          input,
          maxParallelJobs === undefined ? {} : { maxParallelJobs },
        );
        const data: JobSubmitResponse = { jobId: job.jobId };
        return { status: 202, data };
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/call$/,
      access: 'cli',
      handle: ({ body }) => {
        const checked = validateMessage('callRequest', body);
        if (!checked.ok) throw failure('bad-request', 'invalid call', { issues: checked.issues });
        const job = runner.submit(CALL_PLUGIN, checked.value.op, checked.value.params);
        const data: JobSubmitResponse = { jobId: job.jobId };
        return { status: 202, data };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/jobs$/,
      access: 'cli',
      handle: async () => ({ status: 200, data: { jobs: await store.list() } }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/v1/jobs/${JOB}$`),
      access: 'cli',
      handle: async ({ params }) => ({
        status: 200,
        data: store.detail(await requireJob(params[0])),
      }),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/v1/jobs/${JOB}/events$`),
      access: 'cli',
      handle: async ({ params, url }) => {
        await requireJob(params[0]);
        const after = Number(url.searchParams.get('after') ?? 0);
        const wait = Number(url.searchParams.get('wait') ?? 0);
        if (!Number.isInteger(after) || after < 0 || !Number.isFinite(wait) || wait < 0) {
          throw failure(
            'bad-request',
            'after must be a non-negative integer and wait a number of seconds',
          );
        }
        // Waiting only ends this request; it never touches the job.
        const events = await store.eventsAfter(
          params[0],
          after,
          Math.min(wait, MAX_EVENTS_WAIT_S) * 1000,
        );
        const data: JobEventsResponse = { events };
        return { status: 200, data };
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/jobs/${JOB}/cancel$`),
      access: 'cli',
      handle: async ({ params }) => ({
        status: 200,
        data: store.detail(await runner.cancel(params[0])),
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/jobs/${JOB}/harvest$`),
      access: 'cli',
      handle: async ({ params }) => {
        await requireJob(params[0]);
        throw failure('bad-request', 'harvest is not available yet (Phase C)');
      },
    },
  ];
}

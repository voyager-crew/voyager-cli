/** A stale policy against an in-process serve and a fake extension. */
import {
  BRIDGE_PATHS,
  OP_NAMES,
  type CatalogRefreshResult,
  type JobSubmitResponse,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { submitWithFreshPolicy } from '../../src/cli/policyRefresh';
import { ServeClient } from '../../src/client/serveClient';
import { BridgeFailure } from '../../src/util/errors';
import { ASK_HANDLERS, FakeExtension, pairFake } from '../helpers/fakeExtension';
import { data, startTestServer, until, type TestServer } from '../helpers/server';

const ALL_OPS = OP_NAMES.map((name) => ({ name, v: 1 }));
const ASK = { plugin: 'ask', command: 'ask', input: { prompt: 'hello' } };

const refresh = (
  status: CatalogRefreshResult['status'],
  reason?: string,
): CatalogRefreshResult => ({
  host: 'chatgpt.com',
  status,
  revision: status === 'failed' ? null : 42,
  extensionVersion: '2.3.1',
  ...(reason === undefined ? {} : { reason }),
});

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
});

/** A paired extension whose policy is stale, answering `catalog.refresh` with `answers` in turn. */
async function setup(answers: readonly CatalogRefreshResult[]) {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const server = await startTestServer();
  t = server;
  const left = [...answers];
  const extension: FakeExtension = new FakeExtension(server.port, {
    ...ASK_HANDLERS,
    'catalog.refresh': () => {
      const answer = left.shift() ?? refresh('failed', 'no answer left');
      if (answer.status !== 'failed') {
        extension.policy = { revision: 42, state: 'allowed' };
        extension.ops = ALL_OPS;
      }
      return answer;
    },
  });
  fake = extension;
  extension.policy = { revision: 0, state: 'stale' };
  extension.ops = [{ name: 'catalog.refresh', v: 1 }];
  await pairFake(extension, server.cli);
  extension.start();
  await until(async () => {
    const status = data<StatusResponse>(await server.cli('GET', BRIDGE_PATHS.status));
    return status.extension.policy?.state === 'stale';
  });
  const client = new ServeClient(server.port, server.cliToken);
  const submit = vi.fn(() => client.request<JobSubmitResponse>('POST', BRIDGE_PATHS.jobs, ASK));
  return { client, extension, submit };
}

const ops = (extension: FakeExtension) => extension.tasks.map((task) => task.op);

async function refusal(promise: Promise<unknown>): Promise<BridgeFailure> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(thrown instanceof BridgeFailure)) throw new Error('expected a BridgeFailure');
  return thrown;
}

describe('submitWithFreshPolicy', () => {
  it('refreshes a stale policy and submits again', async () => {
    const { client, extension, submit } = await setup([refresh('updated')]);

    const { jobId } = await submitWithFreshPolicy(client, submit);

    expect(jobId).toEqual(expect.any(String));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(ops(extension)[0]).toBe('catalog.refresh');
  });

  it('tries the refresh a second time when the first fails', async () => {
    const { client, extension, submit } = await setup([
      refresh('failed', 'Failed to fetch'),
      refresh('updated'),
    ]);

    await submitWithFreshPolicy(client, submit);

    expect(ops(extension).slice(0, 2)).toEqual(['catalog.refresh', 'catalog.refresh']);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('gives the reason and sends nothing when the refresh keeps failing', async () => {
    const { client, extension, submit } = await setup([
      refresh('failed', 'first failure'),
      refresh('failed', 'Failed to fetch'),
    ]);

    const failed = await refusal(submitWithFreshPolicy(client, submit));

    expect(failed.error.code).toBe('policy-stale');
    expect(failed.message).toContain('Failed to fetch');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(ops(extension)).toEqual(['catalog.refresh', 'catalog.refresh']);
  });

  it('leaves any other refusal alone', async () => {
    const { client, extension } = await setup([]);
    const submit = vi.fn(() =>
      client.request<JobSubmitResponse>('POST', BRIDGE_PATHS.jobs, { ...ASK, plugin: 'nope' }),
    );

    const failed = await refusal(submitWithFreshPolicy(client, submit));

    expect(failed.error.code).toBe('bad-request');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(extension.tasks).toEqual([]);
  });
});

import {
  BRIDGE_PATHS,
  bridgePath,
  type JobSubmitResponse,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import type { JobDetail } from '../../src/jobs/jobStore';
import { takesPageTurn } from '../../src/jobs/pageTurns';
import type { BridgeServerOptions } from '../../src/server/http';
import { loadConfig } from '../../src/state/config';
import { withSerialUpdates } from '../../src/state/pluginState';
import { ASK_HANDLERS, FakeExtension, pairFake, type OpHandler } from '../helpers/fakeExtension';
import { data, errorCode, startTestServer, until, type TestServer } from '../helpers/server';

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replies wait until `open()`; page ops take a moment, so overlapping ones would show. */
function handlers() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const slow =
    (handler: OpHandler | undefined): OpHandler =>
    async (...args) => {
      await pause(20);
      return handler?.(...args);
    };
  return {
    open,
    handlers: {
      ...ASK_HANDLERS,
      'conversation.open': slow(ASK_HANDLERS['conversation.open']),
      'model.select': slow(ASK_HANDLERS['model.select']),
      'composer.send': slow(ASK_HANDLERS['composer.send']),
      'turns.waitReply': async (...args) => {
        await opened;
        return ASK_HANDLERS['turns.waitReply']?.(...args);
      },
    } satisfies Partial<Record<string, OpHandler>>,
  };
}

/** A paired extension that runs `maxTasks` tasks at once and has polled once. */
async function setup(maxTasks: number | undefined, overrides: Partial<BridgeServerOptions> = {}) {
  t = await startTestServer(overrides);
  const replies = handlers();
  fake = new FakeExtension(t.port, replies.handlers);
  fake.maxTasks = maxTasks;
  await pairFake(fake, t.cli);
  fake.start();
  const server = t;
  await until(async () => {
    const status = data<StatusResponse>(await server.cli('GET', BRIDGE_PATHS.status));
    return status.extension.lastPollAt !== null;
  });
  return { t: server, fake, open: replies.open };
}

function submitAsk(server: TestServer, input: Record<string, unknown> = {}) {
  return server.cli('POST', BRIDGE_PATHS.jobs, {
    plugin: 'ask',
    command: 'ask',
    input: { prompt: 'Reply with OK', keepTab: false, ...input },
  });
}

async function waitingReplies(extension: FakeExtension, count: number): Promise<void> {
  await until(
    () =>
      extension.timeline.filter((e) => e.at === 'start' && e.task.op === 'turns.waitReply')
        .length >= count,
  );
}

async function finished(server: TestServer, jobId: string): Promise<JobDetail> {
  let job: JobDetail | undefined;
  await until(async () => {
    job = data<JobDetail>(await server.cli('GET', bridgePath.job(jobId)));
    return !['running', 'waiting-reply', 'cancelling'].includes(job.status);
  }, 8_000);
  if (job === undefined) throw new Error('unreachable');
  return job;
}

const details = (response: { json: unknown }) =>
  (response.json as { error: { details: Record<string, unknown> } }).error.details;

describe('parallel jobs', () => {
  it('runs one job at a time while the extension does not allow parallel jobs', async () => {
    const { t, fake } = await setup(undefined);
    const first = await submitAsk(t);
    expect(first.status).toBe(202);
    await waitingReplies(fake, 1);
    const second = await submitAsk(t);
    expect(errorCode(second)).toBe('busy');
    expect(details(second)).toMatchObject({ maxJobs: 1 });
  });

  it('runs jobs side by side once allowed, waits for their replies at once, and refuses one too many', async () => {
    const { t, fake, open } = await setup(2);
    const a = data<JobSubmitResponse>(await submitAsk(t)).jobId;
    const b = data<JobSubmitResponse>(await submitAsk(t)).jobId;
    await waitingReplies(fake, 2);

    const third = await submitAsk(t);
    expect(errorCode(third)).toBe('busy');
    expect(details(third)).toMatchObject({ maxJobs: 2, activeJobIds: [a, b] });
    const status = data<StatusResponse>(await t.cli('GET', BRIDGE_PATHS.status));
    expect(status.maxJobs).toBe(2);
    expect(status.activeJobs?.map((job) => job.jobId)).toEqual([a, b]);

    open();
    expect((await finished(t, a)).status).toBe('succeeded');
    expect((await finished(t, b)).status).toBe('succeeded');
  });

  it('takes turns at the page: no two jobs ever type or click at once', async () => {
    const { t, fake, open } = await setup(3);
    const jobs = await Promise.all([submitAsk(t), submitAsk(t), submitAsk(t)]);
    await waitingReplies(fake, 3);
    open();
    for (const job of jobs) {
      expect((await finished(t, data<JobSubmitResponse>(job).jobId)).status).toBe('succeeded');
    }

    const onPage = new Set<string>();
    for (const event of fake.timeline) {
      if (!takesPageTurn(event.task.op)) continue;
      if (event.at === 'end') onPage.delete(event.task.taskId);
      else {
        expect([...onPage]).toEqual([]);
        onPage.add(event.task.taskId);
      }
    }
    // A job's model choice and its send are one turn: no other job acts on a page in between.
    for (const job of jobs) {
      const { jobId } = data<JobSubmitResponse>(job);
      const own = fake.timeline.flatMap((event, index) =>
        event.task.jobId === jobId ? [index] : [],
      );
      const select = own.find((index) => fake?.timeline[index]?.task.op === 'model.select');
      const sent = own.findLast(
        (index) =>
          fake?.timeline[index]?.task.op === 'composer.send' && fake.timeline[index]?.at === 'end',
      );
      const between = fake.timeline.slice(select, sent).filter((e) => e.task.jobId !== jobId);
      expect(between.filter((e) => takesPageTurn(e.task.op))).toEqual([]);
    }
  });

  it('holds parallel jobs to maxParallelJobs from config.json', async () => {
    const { t, fake } = await setup(4);
    await writeFile(t.paths.config, JSON.stringify({ maxParallelJobs: 1 }));
    expect((await submitAsk(t)).status).toBe(202);
    await waitingReplies(fake, 1);
    const second = await submitAsk(t);
    expect(errorCode(second)).toBe('busy');
    expect(details(second)).toMatchObject({ maxJobs: 1 });
  });

  it('runs one job at a time, and says so once, when maxParallelJobs is not usable', async () => {
    const warnings: unknown[] = [];
    const log = { info() {}, error() {}, warn: (message: string) => void warnings.push(message) };
    const { t, fake } = await setup(4, { log });
    await writeFile(t.paths.config, JSON.stringify({ maxParallelJobs: 0 }));
    expect((await submitAsk(t)).status).toBe(202);
    await waitingReplies(fake, 1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = await submitAsk(t);
      expect(errorCode(next)).toBe('busy');
      expect(details(next)).toMatchObject({ maxJobs: 1 });
    }
    expect(warnings.filter((m) => String(m).includes('maxParallelJobs'))).toHaveLength(1);
  });

  it('refuses an ask --chat into the conversation a new ask beside it has just sent to', async () => {
    const { t, fake } = await setup(2);
    const first = data<JobSubmitResponse>(await submitAsk(t)).jobId;
    await waitingReplies(fake, 1);
    const job = data<JobDetail>(await t.cli('GET', bridgePath.job(first)));
    const conversationId = job.checkpoints.sent?.conversationId;
    expect(conversationId).toBe('c-1');
    const same = await submitAsk(t, { conversationId });
    expect(errorCode(same)).toBe('busy');
    expect(details(same)).toMatchObject({ activeJobId: first, conflict: 'conversation c-1' });
  });

  it('refuses a second ask into a conversation another job is asking in', async () => {
    const { t, fake } = await setup(2);
    const first = data<JobSubmitResponse>(await submitAsk(t, { conversationId: 'c-9' })).jobId;
    await waitingReplies(fake, 1);
    const same = await submitAsk(t, { conversationId: 'c-9' });
    expect(errorCode(same)).toBe('busy');
    expect(details(same)).toMatchObject({ activeJobId: first, conflict: 'conversation c-9' });
    expect((await submitAsk(t, { conversationId: 'c-10' })).status).toBe(202);
  });

  it('runs a raw voyager call only while no other job runs', async () => {
    const { t, fake } = await setup(2);
    expect((await submitAsk(t)).status).toBe(202);
    await waitingReplies(fake, 1);
    const call = await t.cli('POST', BRIDGE_PATHS.call, { op: 'model.inspect', params: {} });
    expect(errorCode(call)).toBe('busy');
  });
});

describe('plugin state of jobs side by side', () => {
  it('keeps both writes when two jobs update it at the same time', async () => {
    let stored: unknown;
    const slowStore = {
      read: async () => {
        await pause(10);
        return stored;
      },
      write: async (value: unknown) => {
        stored = value;
      },
    };
    const last = { current: Promise.resolve() as Promise<unknown> };
    const add = (name: string) =>
      withSerialUpdates(slowStore, last).update((current) => ({
        ...(current as Record<string, true> | undefined),
        [name]: true,
      }));
    await Promise.all([add('a.zip'), add('b.zip')]);
    expect(stored).toEqual({ 'a.zip': true, 'b.zip': true });
  });

  it('treats unreadable state as empty, as before, and keeps the queue going after a failure', async () => {
    let stored: unknown = 'kept';
    const last = { current: Promise.resolve() as Promise<unknown> };
    const failing = withSerialUpdates(
      {
        read: async () => {
          throw new Error('corrupt');
        },
        write: async () => {
          throw new Error('disk full');
        },
      },
      last,
    );
    await expect(failing.update(() => 1)).rejects.toThrow('disk full');
    const working = withSerialUpdates(
      { read: async () => stored, write: async (value) => void (stored = value) },
      last,
    );
    await working.update((current) => `${String(current)}+1`);
    expect(stored).toBe('kept+1');
  });
});

describe('maxParallelJobs in config.json', () => {
  it.each([0, -2, 1.5, '3', null])('counts %j as one job at a time', async (value) => {
    t = await startTestServer();
    await writeFile(t.paths.config, JSON.stringify({ maxParallelJobs: value }));
    expect(await loadConfig(t.paths)).toMatchObject({
      maxParallelJobs: 1,
      invalidMaxParallelJobs: JSON.stringify(value),
    });
  });

  it('keeps a whole number of 1 or more, and leaves an unset limit to the extension', async () => {
    t = await startTestServer();
    await writeFile(t.paths.config, JSON.stringify({ maxParallelJobs: 3 }));
    const set = await loadConfig(t.paths);
    expect(set.maxParallelJobs).toBe(3);
    expect(set.invalidMaxParallelJobs).toBeUndefined();
    await writeFile(t.paths.config, JSON.stringify({ port: 47_321 }));
    expect((await loadConfig(t.paths)).maxParallelJobs).toBeUndefined();
  });
});

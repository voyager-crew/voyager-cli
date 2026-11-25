/**
 * `voyager read` and `voyager ask --chat / --continue` against the fake
 * extension: which conversation each one opens, what it reads, and what it
 * remembers for the next `--continue`.
 */
import { BRIDGE_PATHS, bridgePath, type JobSubmitResponse } from '@voyager-crew/bridge-protocol';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { askPlugin, type AskInput } from '../../plugins/ask/index';
import { parse, WAIT_OPTIONS } from '../../src/cli/args';
import type { JobDetail } from '../../src/jobs/jobStore';
import type { ForegroundContext } from '../../src/plugins/api';
import { readLastConversation, recordLastConversation } from '../../src/state/lastConversation';
import { BridgeFailure } from '../../src/util/errors';
import { sha256Hex } from '../../src/util/hash';
import { ASK_HANDLERS, FakeExtension, OpError, pairFake } from '../helpers/fakeExtension';
import { data, startTestServer, tempHome, until, type TestServer } from '../helpers/server';

const ID = '6ad3f5e3-4464-83ed-8167-4abe151af1ff';

/** `turns.read` answering with `markdown` and, when given, one file the reply offers. */
function readBack(markdown: string, withFile = false) {
  return () => ({
    markdown,
    turnKey: 't-2',
    textSha256: sha256Hex(markdown),
    files: withFile
      ? [{ kind: 'sandbox', label: 'a.csv', href: 'sandbox:/mnt/data/a.csv', controlRef: 'm-a' }]
      : [],
  });
}

/** Whether the job wrote a `response.md`. */
async function wroteResponse(server: TestServer, jobId: string): Promise<boolean> {
  return access(join(server.paths.jobs, jobId, 'output', 'response.md')).then(
    () => true,
    () => false,
  );
}

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
});

async function setup() {
  t = await startTestServer();
  fake = new FakeExtension(t.port, {
    ...ASK_HANDLERS,
    'conversation.open': (params) => {
      const id = (params as { conversationId?: string }).conversationId ?? null;
      const url = id === null ? 'https://chatgpt.com/' : `https://chatgpt.com/c/${id}`;
      return {
        tabId: 7,
        url,
        docNonce: 'nonce-1',
        ready: { url, conversationId: id, loggedIn: true, mode: 'chat', evidence: {} },
      };
    },
    'composer.send': () => ({
      conversationId: ID,
      url: `https://chatgpt.com/c/${ID}`,
      userTurnKey: 't-9',
    }),
  });
  await pairFake(fake, t.cli);
  fake.start();
  return { t, fake };
}

async function submit(server: TestServer, plugin: string, input: unknown): Promise<string> {
  const response = await server.cli('POST', BRIDGE_PATHS.jobs, { plugin, command: plugin, input });
  return data<JobSubmitResponse>(response).jobId;
}

async function finished(server: TestServer, jobId: string): Promise<JobDetail> {
  let job: JobDetail | undefined;
  await until(async () => {
    job = data<JobDetail>(await server.cli('GET', bridgePath.job(jobId)));
    return ['succeeded', 'failed', 'cancelled', 'needs-user', 'detached'].includes(job.status);
  }, 8_000);
  if (job === undefined) throw new Error('unreachable');
  return job;
}

function foreground(last?: { conversationId: string }): ForegroundContext {
  return {
    cwd: '/',
    stagingDir: () => Promise.reject(new Error('no staging in this test')),
    note: () => {},
    lastConversation: async () => last,
  };
}

/** `voyager ask <argv>` up to the job input, through the real option definitions. */
function prepareAsk(argv: string[], fg: ForegroundContext): Promise<AskInput> {
  const def = askPlugin.commands.ask;
  return def.prepare(fg, parse(argv, { ...WAIT_OPTIONS, ...def.options }));
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof BridgeFailure ? error.code : String(error);
  }
  return undefined;
}

describe('voyager read', () => {
  it('opens the named conversation, reads its latest reply, closes the tab and remembers it', async () => {
    const { t, fake } = await setup();
    const job = await finished(t, await submit(t, 'read', { conversationId: ID, keepTab: false }));

    expect(job.status).toBe('succeeded');
    expect(fake.tasks.map((task) => [task.op, task.params])).toEqual([
      ['conversation.open', { conversationId: ID }],
      ['turns.read', { conversationId: ID, latest: true }],
      ['conversation.close', { tabId: 7 }],
    ]);
    expect(await readFile(String(job.result?.responsePath), 'utf8')).toBe('OK');
    expect(job.result?.response).toMatchObject({ markdown: 'OK', untrusted: true });
    expect(job.result?.conversationUrl).toBe(`https://chatgpt.com/c/${ID}`);
    expect(await readLastConversation(t.paths)).toMatchObject({ conversationId: ID });
    expect(fake.protocolErrors).toEqual([]);
  });

  it('fails without remembering anything while the last reply is still written, and still closes the tab', async () => {
    const { t, fake } = await setup();
    fake.handlers['turns.read'] = () => {
      throw new OpError('unverified');
    };
    const job = await finished(t, await submit(t, 'read', { conversationId: ID, keepTab: false }));

    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('unverified');
    expect(fake.tasks.at(-1)).toMatchObject({ op: 'conversation.close', params: { tabId: 7 } });
    expect(await readLastConversation(t.paths)).toBeUndefined();
  });

  it('fails as unverified, writing no response.md, when the reply reads back with no text and no files', async () => {
    const { t, fake } = await setup();
    fake.handlers['turns.read'] = readBack(' \n');
    const jobId = await submit(t, 'read', { conversationId: ID, keepTab: false });
    const job = await finished(t, jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'unverified', details: { conversationId: ID } });
    expect(await wroteResponse(t, jobId)).toBe(false);
    expect(fake.tasks.at(-1)).toMatchObject({ op: 'conversation.close', params: { tabId: 7 } });
    expect(await readLastConversation(t.paths)).toBeUndefined();
  });

  it.each([
    ['no text', ''],
    ['only whitespace', '  \n'],
  ])('succeeds when the reply offers files and %s', async (_name, markdown) => {
    const { t, fake } = await setup();
    fake.handlers['turns.read'] = readBack(markdown, true);
    const job = await finished(
      t,
      await submit(t, 'read', { conversationId: ID, keepTab: false, noFiles: true }),
    );

    expect(job.status).toBe('succeeded');
    expect(await readFile(String(job.result?.responsePath), 'utf8')).toBe(markdown);
  });
});

describe('voyager ask in an existing conversation', () => {
  it('fails after the send when the reply reads back empty, and says not to resend', async () => {
    const { t, fake } = await setup();
    fake.handlers['turns.read'] = readBack('');
    const jobId = await submit(t, 'ask', {
      prompt: 'and now?',
      keepTab: false,
      conversationId: ID,
    });
    const job = await finished(t, jobId);

    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('unverified');
    expect(job.error?.message).toContain('do not resend');
    expect(job.error?.message).toContain(`voyager read ${ID}`);
    expect(await wroteResponse(t, jobId)).toBe(false);
    expect(fake.tasks.filter((task) => task.op === 'composer.send')).toHaveLength(1);
  });

  it('opens the given conversation instead of a new chat and sends there', async () => {
    const { t, fake } = await setup();
    const job = await finished(
      t,
      await submit(t, 'ask', { prompt: 'and now?', keepTab: false, conversationId: ID }),
    );

    expect(job.status).toBe('succeeded');
    expect(fake.tasks[0]).toMatchObject({
      op: 'conversation.open',
      params: { conversationId: ID },
    });
    expect(fake.tasks.map((task) => task.op)).toContain('composer.send');
    expect(await readLastConversation(t.paths)).toMatchObject({ conversationId: ID });
  });

  it('has the page refuse the send unless the tab still shows the conversation asked for', async () => {
    const { t, fake } = await setup();
    await finished(
      t,
      await submit(t, 'ask', { prompt: 'and now?', keepTab: false, conversationId: ID }),
    );
    await finished(t, await submit(t, 'ask', { prompt: 'hi', keepTab: false }));

    const sends = fake.tasks.filter((task) => task.op === 'composer.send');
    expect(sends[0]?.params).toEqual({ text: 'and now?', expect: { conversationId: ID } });
    expect(sends[1]?.params).toEqual({ text: 'hi' });
  });

  it('sends nothing into a work-mode conversation the extension refuses', async () => {
    const { t, fake } = await setup();
    fake.handlers['conversation.open'] = () => {
      throw new OpError('mode-unavailable');
    };
    const job = await finished(
      t,
      await submit(t, 'ask', { prompt: 'and now?', keepTab: false, conversationId: ID }),
    );

    expect(job.status).toBe('needs-user');
    expect(job.error?.code).toBe('mode-unavailable');
    expect(fake.tasks.map((task) => task.op)).toEqual(['conversation.open']);
  });

  it('closes the tab after a failure, also when it switched the mode to chat, so the mode goes back', async () => {
    const { t, fake } = await setup();
    fake.handlers['conversation.open'] = () => ({
      tabId: 7,
      url: 'https://chatgpt.com/',
      docNonce: 'nonce-1',
      ready: {
        url: 'https://chatgpt.com/',
        conversationId: null,
        loggedIn: true,
        mode: 'chat',
        switchedMode: { from: 'work', to: 'chat' },
        evidence: {},
      },
    });
    fake.handlers['composer.send'] = () => {
      throw new OpError('composer-busy');
    };
    const job = await finished(t, await submit(t, 'ask', { prompt: 'hi', keepTab: false }));

    expect(job.error?.code).toBe('composer-busy');
    expect(fake.tasks.at(-1)).toMatchObject({ op: 'conversation.close', params: { tabId: 7 } });
  });

  it('sends nothing when the mode is unknown, and says only zh-CN labels were measured', async () => {
    const { t, fake } = await setup();
    fake.handlers['conversation.open'] = () => ({
      tabId: 7,
      url: 'https://chatgpt.com/',
      docNonce: 'nonce-1',
      ready: {
        url: 'https://chatgpt.com/',
        conversationId: null,
        loggedIn: true,
        mode: 'unknown',
        evidence: { lang: 'en-US', composerLabels: ['Ask anything'] },
      },
    });
    const job = await finished(t, await submit(t, 'ask', { prompt: 'hi', keepTab: false }));

    expect(job.error?.code).toBe('mode-unknown');
    expect(job.error?.message).toContain('zh-CN');
    expect(job.error?.details).toMatchObject({ lang: 'en-US', composerLabels: ['Ask anything'] });
    expect(fake.tasks.map((task) => task.op)).toEqual(['conversation.open', 'conversation.close']);
  });

  it('remembers the conversation a plain ask started, for the next --continue', async () => {
    const { t } = await setup();
    await finished(t, await submit(t, 'ask', { prompt: 'hi', keepTab: false }));
    const last = await readLastConversation(t.paths);
    expect(last).toMatchObject({ conversationId: ID, url: `https://chatgpt.com/c/${ID}` });
    expect(await prepareAsk(['--continue', 'more'], foreground(last))).toMatchObject({
      conversationId: ID,
      prompt: 'more',
    });
  });
});

describe('ask --chat / --continue arguments', () => {
  it('takes --chat as a conversation link', async () => {
    const input = await prepareAsk(
      ['--chat', `https://chatgpt.com/g/g-p-68f1c2a01b2c-thesis/c/${ID}`, 'next', 'step'],
      foreground(),
    );
    expect(input).toMatchObject({ conversationId: ID, prompt: 'next step' });
  });

  it('refuses --chat with something that is not a conversation', async () => {
    expect(await codeOf(prepareAsk(['--chat', 'https://chatgpt.com/', 'hi'], foreground()))).toBe(
      'bad-request',
    );
  });

  it('refuses --continue when no earlier conversation is recorded', async () => {
    expect(await codeOf(prepareAsk(['--continue', 'hi'], foreground()))).toBe('bad-request');
  });

  it('refuses --chat and --continue together', async () => {
    expect(
      await codeOf(
        prepareAsk(['--chat', ID, '--continue', 'hi'], foreground({ conversationId: ID })),
      ),
    ).toBe('bad-request');
  });

  it('starts a new chat when neither is given', async () => {
    const input = await prepareAsk(['hi'], foreground({ conversationId: ID }));
    expect(input).not.toHaveProperty('conversationId');
  });
});

describe('last conversation record', () => {
  it('is private to the user and reads back as nothing when absent', async () => {
    const paths = await tempHome();
    try {
      expect(await readLastConversation(paths)).toBeUndefined();
      await recordLastConversation(paths, {
        conversationId: ID,
        jobId: 'j',
        command: 'ask',
        at: 1,
      });
      expect((await stat(paths.lastConversation)).mode & 0o777).toBe(0o600);
      expect(await readLastConversation(paths)).toMatchObject({ conversationId: ID });
    } finally {
      await rm(paths.home, { recursive: true, force: true });
    }
  });
});

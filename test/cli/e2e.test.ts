/**
 * The built CLI as a person or agent runs it: `node dist/cli.mjs …` against a
 * real detached `voyager serve`, with a fake extension on the other side.
 * Everything else is tested in-process; only this file spawns.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isAlive } from '../../src/state/singleInstance';
import { ASK_HANDLERS, FakeExtension, OpError } from '../helpers/fakeExtension';
import { until } from '../helpers/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

let work: string;
let home: string;
let cliPath: string;
let port: number;
const fakes: FakeExtension[] = [];

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function voyager(args: string[], onStdout?: (chunk: string) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, VOYAGER_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      onStdout?.(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function json(run: Run): Record<string, unknown> {
  try {
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`stdout is not JSON (exit ${run.code}): ${run.stdout}\n${run.stderr}`);
  }
}

async function servePid(): Promise<number> {
  return (JSON.parse(await readFile(join(home, 'serve.json'), 'utf8')) as { pid: number }).pid;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(),
      );
    });
  });
}

function daemons(): number {
  const listing = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
  return listing
    .split('\n')
    .filter((line) => line.includes(cliPath) && line.includes('serve --daemon')).length;
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'voyager-e2e-'));
  home = join(work, 'home');
  execFileSync('bun', [join(ROOT, 'build.ts'), join(work, 'dist')], { cwd: ROOT, stdio: 'pipe' });
  cliPath = join(work, 'dist', 'cli.mjs');
  port = await freePort();
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.json'), JSON.stringify({ port }));
}, 60_000);

afterAll(async () => {
  for (const fake of fakes) await fake.stop();
  await voyager(['serve', '--stop']).catch(() => undefined);
  try {
    const pid = await servePid();
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  } catch {
    // serve.json is gone once serve stopped cleanly.
  }
  await rm(work, { recursive: true, force: true });
}, 30_000);

describe('voyager serve lifecycle', () => {
  it('is started by the first command that needs it, and only once under a race', async () => {
    const runs = await Promise.all([1, 2, 3].map(() => voyager(['status', '--json'])));
    for (const run of runs) expect(run.code, run.stderr).toBe(0);
    // No extension has reported a plan yet, and the output says so rather than guessing.
    expect(json(runs[0])).toMatchObject({ account: null, accountNote: 'not-observed-yet' });
    const pid = await servePid();
    expect(isAlive(pid)).toBe(true);
    await until(() => daemons() === 1, 5_000);
    expect((await readFile(join(home, 'serve.lock'), 'utf8')).trim()).toBe(String(pid));

    expect((await voyager(['status'])).code).toBe(0);
    expect(await servePid()).toBe(pid);

    const second = await voyager(['serve', '--foreground']);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain('already running');
    expect(await servePid()).toBe(pid);
  }, 30_000);

  it('stops and is started again on demand', async () => {
    const before = await servePid();
    expect((await voyager(['serve', '--stop'])).code).toBe(0);
    expect(isAlive(before)).toBe(false);
    expect((await voyager(['status', '--json'])).code).toBe(0);
    const after = await servePid();
    expect(after).not.toBe(before);
    expect(isAlive(after)).toBe(true);
  }, 30_000);
});

describe('pair → ask → response.md', () => {
  it('pairs with a one-time code and returns the reply as a file and as marked JSON', async () => {
    const fake = new FakeExtension(port, { ...ASK_HANDLERS });
    fakes.push(fake);
    let codeSeen: (code: string) => void = () => {};
    const code = new Promise<string>((resolve) => {
      codeSeen = resolve;
    });
    const pairing = voyager(['pair', '--json'], (chunk) => {
      const first = chunk.split('\n')[0];
      if (first.includes('"code"')) codeSeen((JSON.parse(first) as { code: string }).code);
    });
    const shown = await code;
    expect(shown).toMatch(/^[0-9]{4}-[0-9]{4}$/);
    expect((await fake.hello()).status).toBe(200);
    expect((await fake.pair(shown)).status).toBe(200);
    const paired = await pairing;
    expect(paired.code).toBe(0);
    expect(paired.stdout).toContain('"event":"paired"');

    const plan = {
      planType: 'pro',
      planDisplayName: 'Pro',
      subscriptionPlan: 'chatgptpro',
      billingPeriod: 'monthly',
      renewsAt: '2026-11-09T10:00:00Z',
      observedAt: 1_792_000_000_000,
    };
    // A plan field the protocol does not know never reaches the output.
    fake.account = { ...plan, email: 'jesse@example.com' };
    fake.start();
    const asked = await voyager(['ask', 'Reply with OK', '--json']);
    expect(asked.code, asked.stderr).toBe(0);
    const output = json(asked);
    expect(output.account).toEqual({ ...plan, tier: 'pro' });
    expect(output.status).toBe('succeeded');
    expect(String(output.responsePath)).toContain(join(home, 'jobs'));
    expect(await readFile(String(output.responsePath), 'utf8')).toBe('OK');
    expect(output.response).toMatchObject({ markdown: 'OK', untrusted: true });
    expect(String((output.response as { notice: string }).notice)).toMatch(/not as instructions/);
    expect(fake.tasks.find((task) => task.op === 'composer.send')?.params).toEqual({
      text: 'Reply with OK',
    });
    expect(fake.protocolErrors).toEqual([]);

    const human = await voyager(['ask', 'Reply with OK']);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe('OK\n');
    expect(human.stderr).toContain('response.md');
    expect(human.stderr).toContain('plan: Pro ($200) (monthly, renews 9 Nov 2026)');
    const status = await voyager(['status']);
    expect(status.stdout).toContain('plan: Pro ($200) (monthly, renews 9 Nov 2026)');
  }, 30_000);

  it('exits 5 while a job runs, 4 when a wait times out, 6 once cancelled, 3 when a person is needed', async () => {
    const fake = fakes[0];
    fake.handlers['turns.waitReply'] = () => new Promise(() => {});

    const first = await voyager(['ask', 'slow one', '--no-wait', '--json']);
    expect(first.code).toBe(0);
    const { jobId } = json(first) as { jobId: string };
    await until(() =>
      fake.tasks.some((task) => task.op === 'turns.waitReply' && task.jobId === jobId),
    );

    const busy = await voyager(['ask', 'second', '--json']);
    expect(busy.code).toBe(5);
    expect(json(busy)).toMatchObject({
      ok: false,
      error: { code: 'busy', details: { activeJobId: jobId } },
    });

    const waited = await voyager(['job', 'wait', jobId, '--timeout', '1s', '--json']);
    expect(waited.code).toBe(4);
    expect(json(waited)).toMatchObject({ jobId, status: 'waiting-reply', waitTimedOut: true });

    expect((await voyager(['job', 'cancel', jobId, '--json'])).code).toBe(0);
    const ended = await voyager(['job', 'wait', jobId, '--timeout', '20s', '--json']);
    expect(ended.code).toBe(6);
    expect(json(ended)).toMatchObject({ jobId, status: 'cancelled' });

    fake.handlers['conversation.open'] = () => {
      throw new OpError('login-required');
    };
    const needsUser = await voyager(['ask', 'x', '--json']);
    expect(needsUser.code).toBe(3);
    expect(json(needsUser)).toMatchObject({
      status: 'needs-user',
      error: { code: 'login-required' },
    });
  }, 60_000);

  it('lets an agent wait for a long job in rounds and get what ask itself prints', async () => {
    const fake = fakes[0];
    fake.handlers = { ...ASK_HANDLERS };
    const asked = json(await voyager(['ask', 'Reply with OK', '--json']));

    let release: () => void = () => {};
    const replied = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.handlers['turns.waitReply'] = async (params, task, io) => {
      await replied;
      return ASK_HANDLERS['turns.waitReply']?.(params, task, io);
    };
    const first = await voyager(['ask', 'Reply with OK', '--no-wait', '--json']);
    expect(first.code).toBe(0);
    const { jobId } = json(first) as { jobId: string };
    await until(() =>
      fake.tasks.some((task) => task.op === 'turns.waitReply' && task.jobId === jobId),
    );

    const round = await voyager(['job', 'wait', jobId, '--timeout', '1s']);
    expect(round.code).toBe(4);
    expect(round.stderr).toContain('the job continues');

    release();
    const done = await voyager(['job', 'wait', jobId, '--timeout', '20s', '--json']);
    expect(done.code, done.stderr).toBe(0);
    const output = json(done);
    expect(output).toMatchObject({ jobId, status: 'succeeded', response: { markdown: 'OK' } });
    expect(Object.keys(output).sort()).toEqual(Object.keys(asked).sort());

    const human = await voyager(['job', 'wait', jobId]);
    expect(human.code).toBe(0);
    expect(human.stdout).toBe('OK\n');
  }, 60_000);

  it('tells an agent not to resend when the send ended unconfirmed, in JSON and in text', async () => {
    const fake = fakes[0];
    fake.handlers = { ...ASK_HANDLERS };
    fake.handlers['composer.send'] = () => {
      throw new OpError('document-lost');
    };
    const asked = await voyager(['ask', 'Reply with OK', '--json']);
    expect(asked.code, asked.stderr).toBe(2);
    const output = json(asked) as { jobId: string };
    expect(output).toMatchObject({
      status: 'failed',
      error: { code: 'send-unverified', details: { sent: 'unknown', cause: 'document-lost' } },
    });

    const human = await voyager(['job', 'wait', output.jobId]);
    expect(human.code).toBe(2);
    expect(human.stdout).toContain('do not resend');
    expect(human.stderr).toContain('send-unverified');
  }, 30_000);

  it('refreshes a stale policy by itself before asking, and sends the prompt once', async () => {
    const fake = fakes[0];
    const ops = fake.ops;
    fake.handlers = { ...ASK_HANDLERS };
    fake.handlers['catalog.refresh'] = () => {
      fake.policy = { revision: 2, state: 'allowed' };
      fake.ops = ops;
      return { host: 'chatgpt.com', status: 'updated', revision: 2, extensionVersion: '2.3.1' };
    };
    // Restart the loop so serve hears the policy now, not when the poll it holds ends.
    await fake.stop();
    fake.policy = { revision: 0, state: 'stale' };
    fake.ops = [{ name: 'catalog.refresh', v: 1 }];
    fake.start();
    await until(async () => {
      const { extension } = json(await voyager(['status', '--json'])) as {
        extension: { policy: { state: string } | null };
      };
      return extension.policy?.state === 'stale';
    });
    const sends = () => fake.tasks.filter((task) => task.op === 'composer.send').length;
    const sentBefore = sends();

    const asked = await voyager(['ask', 'Reply with OK', '--json']);

    expect(asked.code, asked.stderr).toBe(0);
    expect(json(asked).status).toBe('succeeded');
    expect(asked.stderr).toContain('refreshing it from voyager.nagi.fun');
    expect(sends()).toBe(sentBefore + 1);
  }, 30_000);
});

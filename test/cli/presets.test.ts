import { BRIDGE_PATHS, type StatusResponse } from '@voyager-crew/bridge-protocol';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ASK_HANDLERS, FakeExtension, pairFake } from '../helpers/fakeExtension';
import { data, startTestServer, until, type TestServer } from '../helpers/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MATH =
  'Mathematical research session. This question comes from a long-running mathematics project. Treat it as research: expect a long session and prepare for hours of real work; depth and rigor come before speed. Every conclusion is either derived from the material given, verified, or marked explicitly as a conjecture together with what evidence would settle it. Work from the exact statement below rather than a paraphrase of it.';
const PROJECT = `g-p-${'a'.repeat(32)}`;

let work: string;
let cliPath: string;
let server: TestServer;
let fake: FakeExtension;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function voyager(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: work,
      env: { ...process.env, VOYAGER_HOME: server.paths.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function json(run: Run): Record<string, unknown> {
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function sent(jobId: string) {
  return fake.tasks.filter((task) => task.jobId === jobId && task.op === 'composer.send');
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'voyager-presets-'));
  execFileSync('bun', [join(ROOT, 'build.ts'), join(work, 'dist')], { cwd: ROOT, stdio: 'pipe' });
  cliPath = join(work, 'dist', 'cli.mjs');
  server = await startTestServer();
  await writeFile(server.paths.config, JSON.stringify({ port: server.port }));
  fake = new FakeExtension(server.port, {
    ...ASK_HANDLERS,
    'project.open': () => ({
      projectId: PROJECT,
      url: `https://chatgpt.com/g/${PROJECT}/project`,
      view: 'chat',
      name: null,
      evidence: {},
    }),
  });
  await pairFake(fake, server.cli);
  fake.start();
  await until(async () => {
    const status = data<StatusResponse>(await server.cli('GET', BRIDGE_PATHS.status));
    return status.extension.lastPollAt !== null;
  });
}, 60_000);

afterAll(async () => {
  await fake?.stop();
  await server?.close();
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

describe('voyager ask --preset', () => {
  it('sends the verbatim math opening before the prompt, even when a file is named math', async () => {
    await writeFile(join(work, 'math'), 'a different opening');
    const asked = json(await voyager(['ask', '--preset', 'math', 'Prove the claim.', '--json']));
    expect(sent(String(asked.jobId)).map((task) => task.params)).toEqual([
      { text: `${MATH}\n\nProve the claim.` },
    ]);
  });

  it('reads a relative UTF-8 file and trims it to one blank line before the prompt', async () => {
    await mkdir(join(work, 'openings'));
    await writeFile(
      join(work, 'openings', 'custom.txt'),
      '\n  研究这个问题。\nKeep every step. \n\t',
    );
    const asked = json(
      await voyager(['ask', '--preset', 'openings/custom.txt', 'Explain the result.', '--json']),
    );
    expect(sent(String(asked.jobId)).map((task) => task.params)).toEqual([
      { text: '研究这个问题。\nKeep every step.\n\nExplain the result.' },
    ]);
  });

  it('shows the combined prompt in a dry run without creating a job or sending', async () => {
    const beforeJobs = await readdir(server.paths.jobs);
    const beforeTasks = fake.tasks.length;
    const output = json(
      await voyager(['ask', '--preset', 'math', '--dry-run', 'Check this theorem.']),
    );
    expect(output).toMatchObject({
      dryRun: true,
      input: { prompt: `${MATH}\n\nCheck this theorem.` },
    });
    expect(await readdir(server.paths.jobs)).toEqual(beforeJobs);
    expect(fake.tasks).toHaveLength(beforeTasks);
  });

  it('leaves a prompt untouched without a preset', async () => {
    const prompt = 'First line.\n\nSecond line with  two spaces.';
    const asked = json(await voyager(['ask', prompt, '--json']));
    expect(sent(String(asked.jobId)).map((task) => task.params)).toEqual([{ text: prompt }]);
  });

  it.each([
    { target: 'an existing chat', flags: ['--chat', 'https://chatgpt.com/c/c-1'] },
    { target: 'a project', flags: ['--project', PROJECT] },
  ])('uses the same combined prompt in $target', async ({ flags }) => {
    const asked = json(
      await voyager(['ask', '--preset', 'math', ...flags, 'Continue the proof.', '--json']),
    );
    const sends = sent(String(asked.jobId));
    expect(sends).toHaveLength(1);
    expect(sends[0].params).toMatchObject({ text: `${MATH}\n\nContinue the proof.` });
  });

  it('stores the combined no-wait prompt once and job wait never re-reads the preset', async () => {
    await writeFile(join(work, 'saved.txt'), 'Original opening');
    const asked = json(
      await voyager(['ask', '--preset', 'saved.txt', '--no-wait', 'Solve it.', '--json']),
    );
    const jobId = String(asked.jobId);
    const stored = JSON.parse(
      await readFile(join(server.paths.jobs, jobId, 'job.json'), 'utf8'),
    ) as { input: { prompt: string } };
    expect(stored.input.prompt).toBe('Original opening\n\nSolve it.');
    await writeFile(join(work, 'saved.txt'), 'Changed opening');
    const waited = await voyager(['job', 'wait', jobId, '--timeout', '20s', '--json']);
    expect(json(waited)).toMatchObject({ jobId, status: 'succeeded' });
    expect(sent(jobId).map((task) => task.params)).toEqual([
      { text: 'Original opening\n\nSolve it.' },
    ]);
    expect((await voyager(['job', 'wait', jobId, '--json'])).code).toBe(0);
    expect(sent(jobId)).toHaveLength(1);
  });

  it('accepts 20,000 UTF-8 characters rather than counting their bytes', async () => {
    const opening = '🧮'.repeat(20_000);
    await writeFile(join(work, 'limit.txt'), opening);
    const output = json(
      await voyager(['ask', '--preset', 'limit.txt', '--dry-run', 'Check the limit.']),
    );
    const input = output.input as { prompt: string };
    expect(input.prompt === `${opening}\n\nCheck the limit.`).toBe(true);
  });

  it.each([
    { kind: 'missing', value: 'does-not-exist.txt', text: undefined, message: /read|preset|file/i },
    { kind: 'unreadable', value: 'openings', text: undefined, message: /read|file/i },
    { kind: 'empty', value: 'empty.txt', text: ' \n\t ', message: /empty/i },
    { kind: 'too long', value: 'long.txt', text: 'x'.repeat(20_001), message: /20,?000/i },
  ])(
    'rejects a $kind preset with usage exit 2 and sends nothing',
    async ({ value, text, message }) => {
      if (text !== undefined) await writeFile(join(work, value), text);
      const beforeJobs = await readdir(server.paths.jobs);
      const beforeTasks = fake.tasks.length;
      const failed = await voyager(['ask', '--preset', value, 'Do not send this.']);
      expect(failed.code).toBe(2);
      expect(failed.stdout).toBe('');
      expect(failed.stderr.trim().split('\n')).toHaveLength(1);
      expect(failed.stderr).toContain('--preset');
      expect(failed.stderr).toMatch(message);
      expect(await readdir(server.paths.jobs)).toEqual(beforeJobs);
      expect(fake.tasks).toHaveLength(beforeTasks);
    },
  );
});

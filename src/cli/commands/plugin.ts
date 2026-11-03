import { BRIDGE_PATHS, type JobSubmitResponse } from '@voyager-crew/bridge-protocol';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { ensureServe } from '../../client/serveClient';
import type { CommandDef, ForegroundContext, VoyagerPlugin } from '../../plugins/api';
import type { PluginRegistry } from '../../plugins/registry';
import { readLastConversation } from '../../state/lastConversation';
import type { StatePaths } from '../../state/paths';
import { newId } from '../../util/ids';
import { parse, waitTimeout, WAIT_OPTIONS } from '../args';
import { note, printJson } from '../output';
import { submitWithFreshPolicy } from '../policyRefresh';
import { submitAndWait } from './job';

/** Staging folders a command left behind (a refused submit, a dry run) go after a day. */
const STAGING_MAX_AGE_MS = 24 * 60 * 60_000;

async function sweepStaging(root: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - STAGING_MAX_AGE_MS;
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    } catch {
      // Another command may be sweeping too.
    }
  }
}

/** One staging folder per command, made on first use. */
function stagingFor(paths: StatePaths): () => Promise<string> {
  let dir: Promise<string> | undefined;
  return () => {
    dir ??= (async () => {
      await mkdir(paths.staging, { recursive: true, mode: 0o700 });
      await sweepStaging(paths.staging);
      const path = join(paths.staging, newId('s'));
      await mkdir(path, { mode: 0o700 });
      return path;
    })();
    return dir;
  };
}

/** A yes/no question on the terminal, default no; only when a person is there to answer. */
function terminalConfirm(): ((question: string) => Promise<boolean>) | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return async (question) => {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await prompt.question(`${question} [y/N] `);
      return /^y(?:es)?$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  };
}

/** `voyager <command> …` for a plugin command: prepare here, run in serve, wait, print. */
export async function pluginCommand(
  paths: StatePaths,
  registry: PluginRegistry,
  found: { plugin: VoyagerPlugin; command: string; def: CommandDef },
  argv: readonly string[],
): Promise<number> {
  const args = parse(argv, { ...WAIT_OPTIONS, ...found.def.options });
  const confirm = terminalConfirm();
  const fg: ForegroundContext = {
    cwd: process.cwd(),
    stagingDir: stagingFor(paths),
    note,
    lastConversation: () => readLastConversation(paths),
    ...(confirm === undefined ? {} : { confirm }),
  };
  const input = await found.def.prepare(fg, args);
  if (args.options['dry-run'] === true) {
    // Prepared, nothing submitted: what the job would get, staged files kept for a look.
    printJson({ dryRun: true, plugin: found.plugin.name, command: found.command, input });
    return 0;
  }
  const client = await ensureServe(paths);
  return submitAndWait(
    client,
    registry,
    {
      json: args.options.json === true,
      noWait: args.options['no-wait'] === true,
      timeoutMs: waitTimeout(args),
    },
    () =>
      submitWithFreshPolicy(client, () =>
        client.request<JobSubmitResponse>('POST', BRIDGE_PATHS.jobs, {
          plugin: found.plugin.name,
          command: found.command,
          input,
        }),
      ),
  );
}

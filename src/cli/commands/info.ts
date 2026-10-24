import {
  BRIDGE_PATHS,
  EXTENSION_OFFLINE_MS,
  type CommandsResponse,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';

import { ensureServe } from '../../client/serveClient';
import type { ActiveJobView, ServeStatus } from '../../server/serveStatus';
import type { StatePaths } from '../../state/paths';
import { accountJson, describeAccount } from '../accountPlan';
import { parse } from '../args';
import { note, printJson, printLine } from '../output';

export async function statusCommand(paths: StatePaths, argv: readonly string[]): Promise<number> {
  const args = parse(argv, { json: { type: 'boolean', summary: 'JSON output' } });
  const client = await ensureServe(paths);
  const status = await client.request<ServeStatus>('GET', BRIDGE_PATHS.status);
  if (args.options.json === true) {
    printJson({ ...status, port: client.port, ...accountJson(status.extension.account) });
    return 0;
  }
  const ext = status.extension;
  printLine(`serve: ${status.serverVersion} on 127.0.0.1:${client.port}`);
  if (!ext.paired) printLine('extension: not paired (run voyager pair)');
  else {
    const seen =
      ext.lastPollAt === null
        ? 'has not connected since serve started'
        : `last poll ${Math.round((Date.now() - ext.lastPollAt) / 1000)}s ago`;
    printLine(`extension: paired (${ext.browser ?? '?'}, Voyager ${ext.version ?? '?'}), ${seen}`);
    if (ext.policy !== null) {
      printLine(`policy: revision ${ext.policy.revision}, ${ext.policy.state}`);
    }
    const seenAt = ext.account?.observedAt;
    const age =
      seenAt === undefined
        ? ''
        : `, seen ${Math.max(0, Math.round((Date.now() - seenAt) / 60_000))} min ago`;
    printLine(`${describeAccount(ext.account)}${ext.account ? age : ''}`);
  }
  for (const line of statusJobLines(status)) printLine(line);
  return 0;
}

/** The active jobs and, while the extension is around, how many may run at once. */
export function statusJobLines(status: ServeStatus, now = Date.now()): string[] {
  const active: readonly ActiveJobView[] =
    status.activeJobs ?? (status.activeJob === undefined ? [] : [status.activeJob]);
  // Turns matter only between jobs: a job alone always has the page.
  const turns = active.length > 1;
  const named = active.map((job) => {
    const turn = !turns
      ? undefined
      : job.pageTurn === 'holding'
        ? 'has the page turn'
        : job.pageTurn === 'waiting'
          ? 'waiting for the page turn'
          : undefined;
    const notes = [job.op, turn].filter((part) => part !== undefined);
    return `${job.jobId}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
  });
  const label = named.length > 1 ? 'active jobs' : 'active job';
  const lines = [`${label}: ${named.length === 0 ? 'none' : named.join(', ')}`];
  const parallel = parallelLine(status, now);
  if (parallel !== undefined) lines.push(parallel);
  return lines;
}

/** Nothing while the extension is unpaired or away: its popup switch is unknown then. */
function parallelLine(status: ServeStatus, now: number): string | undefined {
  const ext = status.extension;
  const last = ext.lastPollAt;
  if (!ext.paired || last === null || now - last > EXTENSION_OFFLINE_MS) return undefined;
  const offered = ext.maxTasks;
  const maxJobs = status.maxJobs ?? 1;
  if (offered === undefined) {
    // A serve from before it reported the extension's own number.
    return maxJobs > 1 ? `parallel jobs: up to ${maxJobs} at once` : undefined;
  }
  if (offered === null) {
    return `parallel jobs: not in Voyager ${ext.version ?? '?'} (one job at a time; a newer Voyager runs several)`;
  }
  if (offered <= 1)
    return 'parallel jobs: off (one job at a time; turn it on in the Voyager popup)';
  if (maxJobs >= offered) return `parallel jobs: up to ${maxJobs} at once`;
  return `parallel jobs: up to ${maxJobs} at once (maxParallelJobs in config.json; the Voyager popup allows ${offered})`;
}

export async function commandsCommand(paths: StatePaths, argv: readonly string[]): Promise<number> {
  const args = parse(argv, { json: { type: 'boolean', summary: 'JSON output' } });
  const client = await ensureServe(paths);
  const listed = await client.request<CommandsResponse>('GET', BRIDGE_PATHS.commands);
  if (args.options.json === true) {
    printJson(listed);
    return 0;
  }
  printLine('commands:');
  for (const entry of listed.commands) printLine(`  voyager ${entry.command}  ${entry.summary}`);
  printLine('extension ops (voyager call <op>):');
  if (listed.ops.length === 0)
    printLine('  none yet: the extension has not polled since serve started');
  for (const op of listed.ops) printLine(`  ${op.name} v${op.v}`);
  return 0;
}

/** Before a job: say so when the extension has not been heard from lately. */
export async function warnIfExtensionAway(
  client: Awaited<ReturnType<typeof ensureServe>>,
): Promise<StatusResponse> {
  const status = await client.request<StatusResponse>('GET', BRIDGE_PATHS.status);
  const last = status.extension.lastPollAt;
  if (status.extension.paired && (last === null || Date.now() - last > EXTENSION_OFFLINE_MS)) {
    note('Waiting for the extension to connect (is the browser open with the ChatGPT bridge on?)…');
  }
  return status;
}

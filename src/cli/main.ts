/**
 * `voyager`: the local half of the Voyager Local Bridge.
 * Built-ins are dispatched here; anything else is looked up among plugin commands.
 */
import { PluginRegistry } from '../plugins/registry';
import { statePaths } from '../state/paths';
import { BridgeFailure, toBridgeError } from '../util/errors';
import { CLI_VERSION } from '../version';
import { extensionPluginCommand } from './commands/extensionPlugin';
import { commandsCommand, statusCommand } from './commands/info';
import { callCommand, jobCommand } from './commands/job';
import { pairCommand } from './commands/pair';
import { pluginCommand } from './commands/plugin';
import { serveCommand } from './commands/serve';
import { updateCommand } from './commands/update';
import { exitForError } from './exitCodes';
import { note, printJson, printLine } from './output';

const USAGE = `voyager ${CLI_VERSION}: drive ChatGPT through the Voyager extension, locally

usage:
  voyager pair [--revoke]              pair the browser extension (one-time code)
  voyager ask "<prompt>" [--json]      new conversation, send, wait, save response.md
                                       and the files the reply offers under files/
        [--attach <file|folder>]...    upload files; folders are zipped, credentials left out
        [--preset math]                prepend the mathematical research opening
        [--preset <file>]              prepend a UTF-8 text file, trimmed (up to 20,000 characters)
        [--dry-run]                    pack attachments and print the job input, send nothing
        [--chat <link|id> | --continue] ask in an existing conversation, or the last one used
        [--project <name|id>]          ask in a new chat of a ChatGPT project (its files are there)
        [--no-files]                   ask or read: leave the reply's files in ChatGPT
        [--timeout 30m] [--no-wait] [--keep-tab]
  voyager read <link|id> [--json]      save an existing conversation's last finished reply and its files
        [--keep-tab]                   leave its ChatGPT tab open
  voyager project list | create <name> | files <project>    ChatGPT projects; <project>: name or g-p- id
        | upload <project> <file|folder> replaces a same-name file (ChatGPT ignores re-uploads),
                                       skips one unchanged; a folder goes up as <folder>.zip
        | remove <project> <file> [--yes] deletes at once, no undo; asks, or needs --yes without a tty
        [--keep-tab]                   any project command: leave its ChatGPT tab open
  voyager status [--json]              serve, pairing, active jobs and how many may run at once
  voyager commands [--json]            plugin commands and extension ops
  voyager call <op> [--params JSON]    run one extension op (debugging); files.download saves the file
  voyager job list | show <id> | wait <id> [--timeout 30m] | cancel <id>
        long replies (Pro can take hours): ask --no-wait, then repeat job wait <id> --timeout 10m
        while it exits 4; never resend the prompt
  voyager plugin create <dir> | check <dir>   write a Voyager extension plugin
  voyager serve [--foreground | --stop]
  voyager update [--json]              update the CLI (global npm install), restart serve onto it,
                                       refresh the extension's page data, report its version

each job opens its own ChatGPT tab and closes it when it ends, also after a failure,
unless --keep-tab; one you need to look at (sign-in, an unconfirmed send) stays open
results name the ChatGPT plan the pages last showed (JSON: account; may trail a change)
exit codes: 0 ok, 2 failed (data), 3 needs a person, 4 wait timed out (job continues),
            5 busy (one job at a time, unless parallel jobs are on in the Voyager popup),
            6 transient/detached/reply-stalled, 7 not paired or extension offline
            a reply saved with some files not downloaded is 0: see failedFiles (JSON) or stderr
state: ~/.voyager (override with VOYAGER_HOME)`;

async function main(argv: readonly string[]): Promise<number> {
  const paths = statePaths();
  const registry = new PluginRegistry();
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printLine(USAGE);
      return 0;
    case '--version':
    case '-v':
      printLine(CLI_VERSION);
      return 0;
    case 'serve':
      return serveCommand(paths, rest);
    case 'pair':
      return pairCommand(paths, rest);
    case 'status':
      return statusCommand(paths, rest);
    case 'commands':
      return commandsCommand(paths, rest);
    case 'call':
      return callCommand(paths, registry, rest);
    case 'job':
      return jobCommand(paths, registry, rest);
    case 'plugin':
      return extensionPluginCommand(rest);
    case 'update':
      return updateCommand(paths, rest);
    default: {
      const found = registry.findCommand(command);
      if (found === undefined) {
        note(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
      }
      return pluginCommand(paths, registry, found, rest);
    }
  }
}

const argv = process.argv.slice(2);
main(argv).then(
  (code) => {
    process.exitCode = code;
  },
  (thrown: unknown) => {
    const error = toBridgeError(thrown);
    if (argv.includes('--json')) printJson({ ok: false, error });
    else note(`voyager: ${error.code}: ${error.message}`);
    if (!(thrown instanceof BridgeFailure))
      note(String(thrown instanceof Error ? thrown.stack : thrown));
    process.exitCode = exitForError(error);
  },
);

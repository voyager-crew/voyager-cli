/**
 * Official `project` plugin: ChatGPT projects and their files ("sources").
 *
 *   voyager project list | create <name> | files <project>
 *                   | upload <project> <file|folder> | remove <project> <file name>
 *
 * `<project>` is a name from the sidebar or an id (`g-p-…`, or a link into the
 * project). Two measured behaviours shape `upload` and `remove`:
 * - ChatGPT silently ignores an upload under a name the project already holds,
 *   so `upload` replaces: it removes the old file, uploads, and checks the
 *   project lists the new one exactly once. A file whose content matches what
 *   this machine last uploaded under that name is skipped.
 * - Removing is immediate and cannot be undone, so `remove` asks on a terminal
 *   and, without one (an agent), runs only with `--yes`.
 * Each job opens its own bridge tab and closes it when it ends, also after a
 * failure; `--keep-tab` keeps it.
 */
import type { ProjectFile } from '@voyager-crew/bridge-protocol';

import {
  definePlugin,
  type FinishedJob,
  type ForegroundContext,
  type JobContext,
  type JobResult,
  type ParsedArgs,
} from '../../src/plugins/api';
import { type StagedAttachment, stageAttachments } from '../../src/util/attach/stage';
import { failure } from '../../src/util/errors';
import { attachTimeoutMs } from '../ask/index';
import { inBridgeTab, openBridgeTab } from '../shared/response';
import { fingerprintOf, rememberUpload } from './fingerprints';
import { callProjectOp, PROJECT_OPS } from './ops';
import { resolveProject } from './resolve';

const ACTIONS = ['list', 'create', 'files', 'upload', 'remove'] as const;
type Action = (typeof ACTIONS)[number];

export interface ProjectInput {
  readonly action: Action;
  /** The project as given: a name, an id or a link. */
  readonly project?: string;
  /** `create`: the new project's name; `remove`: the file's name. */
  readonly name?: string;
  readonly upload?: StagedAttachment;
  readonly keepTab: boolean;
}

const USAGE =
  'usage: voyager project list | create <name> | files <project> | upload <project> <file|folder> | remove <project> <file name> [--yes]';

function needArgs(argv: ParsedArgs, count: number, usage: string): string[] {
  const rest = argv.positionals.slice(1);
  if (rest.length !== count || rest.some((arg) => arg.trim() === '')) {
    throw failure('bad-request', `usage: voyager project ${usage}`);
  }
  return rest;
}

async function confirmRemoval(
  fg: ForegroundContext,
  argv: ParsedArgs,
  project: string,
  name: string,
): Promise<void> {
  if (argv.options.yes === true) return;
  if (fg.confirm === undefined) {
    throw failure(
      'bad-request',
      `not removed: removing ${JSON.stringify(name)} from a project is immediate and cannot be undone; without a terminal to confirm on, pass --yes`,
      { reason: 'confirmation-required' },
    );
  }
  const yes = await fg.confirm(
    `Remove ${JSON.stringify(name)} from project ${JSON.stringify(project)}? ChatGPT deletes it at once and it cannot be undone.`,
  );
  if (!yes) throw failure('cancelled', `not removed: ${name} stays in the project`);
}

async function prepare(fg: ForegroundContext, argv: ParsedArgs): Promise<ProjectInput> {
  const action = ACTIONS.find((known) => known === argv.positionals[0]);
  if (action === undefined) throw failure('bad-request', USAGE);
  const keepTab = argv.options['keep-tab'] === true;
  switch (action) {
    case 'list':
      needArgs(argv, 0, 'list');
      return { action, keepTab };
    case 'create': {
      const name = argv.positionals.slice(1).join(' ').trim();
      if (name === '' || /[\r\n]/.test(name)) {
        throw failure('bad-request', 'usage: voyager project create <name> (one line)');
      }
      return { action, name, keepTab };
    }
    case 'files': {
      const [project] = needArgs(argv, 1, 'files <project>');
      return { action, project, keepTab };
    }
    case 'upload': {
      const [project, path] = needArgs(argv, 2, 'upload <project> <file|folder>');
      // Packed like `ask --attach`: a folder becomes <folder>.zip without credentials.
      const [upload] = await stageAttachments([path], {
        cwd: fg.cwd,
        stagingDir: fg.stagingDir,
        note: fg.note,
      });
      return { action, project, upload, keepTab };
    }
    case 'remove': {
      const [project, name] = needArgs(argv, 2, 'remove <project> <file name>');
      await confirmRemoval(fg, argv, project, name);
      return { action, project, name, keepTab };
    }
  }
}

function listed(files: readonly ProjectFile[], name: string): number {
  return files.filter((file) => file.name === name).length;
}

async function upload(
  ctx: JobContext,
  projectId: string,
  staged: StagedAttachment,
): Promise<Readonly<Record<string, unknown>>> {
  const { name } = staged;
  // Before the page: a staged file that changed or went missing stops the job here.
  const blob = await ctx.blobs.register(staged.path, {
    name,
    mime: staged.mime,
    size: staged.size,
    sha256: staged.sha256,
  });
  await callProjectOp(ctx, 'project.open', { projectId, view: 'sources' });
  const { files } = await callProjectOp(ctx, 'project.files', { projectId });
  const known = await fingerprintOf(ctx.state, projectId, name);
  const present = listed(files, name) > 0;
  if (present && known?.sha256 === staged.sha256) {
    return { outcome: 'unchanged', name, sha256: staged.sha256, files };
  }
  if (present) {
    // ChatGPT would keep the old file and drop this one without a word.
    await callProjectOp(ctx, 'project.remove', { projectId, name });
    await rememberUpload(ctx.state, projectId, name, undefined);
    await ctx.checkpoint('removed-old', { projectId, name });
  }
  const uploaded = await callProjectOp(
    ctx,
    'project.upload',
    { projectId, blob },
    { timeoutMs: attachTimeoutMs(blob.size) },
  );
  if (listed(uploaded.files, name) !== 1) {
    throw failure('unverified', `the project does not list ${name} exactly once after the upload`);
  }
  await rememberUpload(ctx.state, projectId, name, {
    sha256: staged.sha256,
    size: staged.size,
    source: staged.source,
    at: Date.now(),
  });
  return {
    outcome: present ? 'replaced' : 'uploaded',
    name,
    sha256: staged.sha256,
    size: staged.size,
    kind: staged.kind,
    source: staged.source,
    ...(staged.fileCount === undefined ? {} : { fileCount: staged.fileCount }),
    replacedUnknown: present && known === undefined,
    files: uploaded.files,
  };
}

async function act(
  ctx: JobContext,
  input: ProjectInput,
): Promise<Readonly<Record<string, unknown>>> {
  if (input.action === 'list') {
    const { projects } = await callProjectOp(ctx, 'project.list', {});
    return { projects };
  }
  if (input.action === 'create') {
    const name = input.name ?? '';
    const { projects } = await callProjectOp(ctx, 'project.list', {});
    const same = projects.filter((project) => project.name === name);
    if (same.length > 0) {
      throw failure(
        'bad-request',
        `a project named ${JSON.stringify(name)} already exists (${same.map((project) => project.projectId).join(', ')}); not creating another`,
        { ids: same.map((project) => project.projectId) },
      );
    }
    const created = await callProjectOp(ctx, 'project.create', { name });
    return { projectId: created.projectId, name: created.name, url: created.url };
  }
  const project = await resolveProject(ctx, input.project ?? '');
  await ctx.checkpoint('project', { projectId: project.projectId });
  const { projectId } = project;
  const named = { projectId, ...(project.name === undefined ? {} : { name: project.name }) };
  if (input.action === 'files') {
    await callProjectOp(ctx, 'project.open', { projectId, view: 'sources' });
    const { files } = await callProjectOp(ctx, 'project.files', { projectId });
    return { project: named, files };
  }
  if (input.action === 'upload') {
    if (input.upload === undefined) throw failure('bad-request', 'nothing to upload');
    return { project: named, ...(await upload(ctx, projectId, input.upload)) };
  }
  const name = input.name ?? '';
  await callProjectOp(ctx, 'project.open', { projectId, view: 'sources' });
  const removed = await callProjectOp(ctx, 'project.remove', { projectId, name });
  await rememberUpload(ctx.state, projectId, name, undefined);
  return { project: named, outcome: 'removed', name: removed.removed, files: removed.files };
}

async function run(ctx: JobContext, input: ProjectInput): Promise<JobResult> {
  const opened = await openBridgeTab(ctx, { new: true }, input.keepTab);
  return inBridgeTab(ctx, opened.tabId, input.keepTab, async () => {
    if (!opened.ready.loggedIn) throw failure('login-required', 'ChatGPT is not logged in');
    await ctx.checkpoint('opened', { tabId: opened.tabId, url: opened.url });
    const data = await act(ctx, input);
    return { data: { action: input.action, ...data } };
  });
}

function fileLines(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files.map(
    (file: ProjectFile) => `${file.name}${file.uploadedAt ? `  ${file.uploadedAt}` : ''}`,
  );
}

/** Human output: what changed on stdout, the rest as notes. */
function present(job: FinishedJob): { readonly stdout: string; readonly notes: readonly string[] } {
  const result = job.result ?? {};
  const lines = (list: readonly string[]): string =>
    list.length === 0 ? '' : `${list.join('\n')}\n`;
  switch (result.action) {
    case 'list': {
      const projects = (result.projects ?? []) as { projectId: string; name: string }[];
      return {
        stdout: lines(projects.map((project) => `${project.projectId}  ${project.name}`)),
        notes: projects.length === 0 ? ['no projects in the ChatGPT sidebar'] : [],
      };
    }
    case 'create':
      return {
        stdout: `${String(result.projectId)}  ${String(result.name)}\n`,
        notes: [String(result.url)],
      };
    case 'files': {
      const files = fileLines(result.files);
      return {
        stdout: lines(files),
        notes: files.length === 0 ? ['the project has no files'] : [],
      };
    }
    case 'upload': {
      const name = String(result.name);
      const note =
        result.outcome === 'unchanged'
          ? `skipped ${name}: unchanged since this machine uploaded it`
          : result.outcome === 'replaced'
            ? `replaced ${name}: removed the old copy, then uploaded (ChatGPT ignores an upload under a name it already holds)${result.replacedUnknown === true ? '; the old copy was not uploaded from this machine' : ''}`
            : `uploaded ${name}`;
      return { stdout: `${note}\n`, notes: [] };
    }
    default:
      return {
        stdout: `removed ${String(result.name)}\n`,
        notes: ['ChatGPT deletes it at once; it cannot be undone'],
      };
  }
}

export const projectPlugin = definePlugin({
  name: 'project',
  apiVersion: 1,
  requiresOps: ['conversation.open', 'conversation.close', ...PROJECT_OPS],
  commands: {
    project: {
      summary: 'ChatGPT projects: list, create, and list, upload or remove their files',
      args: [
        { name: 'action', summary: 'list | create | files | upload | remove' },
        { name: 'args', summary: 'the project (name or g-p- id), then a file', variadic: true },
      ],
      options: {
        yes: {
          type: 'boolean',
          summary: 'remove without asking (required without a terminal); removal cannot be undone',
        },
        'keep-tab': { type: 'boolean', summary: 'leave the bridge tab open afterwards' },
      },
      prepare,
      // A change checks what the projects hold before it acts (a name taken, a file listed
      // once): two at once would each see the other's half-done step. One project may go by
      // its name in one job and its id in another, so every change shares one key.
      conflictKey: (input: ProjectInput) =>
        input.action === 'create' || input.action === 'upload' || input.action === 'remove'
          ? 'project changes'
          : undefined,
      run,
      present,
    },
  },
});

import type {
  ApprovalChoice,
  BlobRef,
  ConversationOpenResult,
} from '@voyager-crew/bridge-protocol';
/**
 * Official `ask` plugin. New conversation (or an existing one: `--chat`, or
 * `--continue` for the last job's) → attach (with `--attach`) → send → wait
 * for the reply → `output/response.md`. `--model` (default `pro`) picks the
 * model right after the tab opens and leaves it selected (see `./model.ts`). `--out` arrives later in Phase C; the option exists now
 * so the command line is stable.
 *
 * `--attach` packs in the foreground (`stageAttachments`: files as they are,
 * folders as zips without credentials); `run` registers each staged file as a
 * blob, has the page attach them all, then sends with `expectAttachments`.
 *
 * `--project <name|id>` asks in a new chat inside that ChatGPT project: the tab
 * moves to the project in-app (`project.open`), which leaves it in chat mode or
 * fails; the project's files are there for the reply, beside any `--attach`.
 *
 * `--drive` puts files on Google Drive and `--repo` names a GitHub repository;
 * both only add to the prompt, for ChatGPT's own apps (`./drive.ts`, `./repo.ts`).
 * `--timebox` adds a countdown for long sandbox work (`./timebox.ts`).
 */
import { basename } from 'node:path';

import {
  conversationConflictKey,
  definePlugin,
  type ForegroundContext,
  type JobContext,
  type JobResult,
  type ParsedArgs,
} from '../../src/plugins/api';
import { sendOnce } from '../../src/plugins/sendGuard';
import { type StagedAttachment, stageAttachments } from '../../src/util/attach/stage';
import { parseConversationRef } from '../../src/util/conversationRef';
import { failure } from '../../src/util/errors';
import { callProjectOp } from '../project/ops';
import { resolveProject } from '../project/resolve';
import {
  EXTERNAL_CONTENT_NOTICE,
  inBridgeTab,
  openBridgeTab,
  presentResponse,
  responseBlock,
  saveReplyFiles,
  saveResponse,
} from '../shared/response';
import { parseApproveApps, waitReplyApproving } from './approval';
import { prepareDrive } from './drive';
import {
  type AskModel,
  chooseModel,
  DEFAULT_ASK_MODEL,
  type ModelReport,
  parseAskModel,
} from './model';
import { checkRepoReach, parseRepo, type RepoTarget, repoPromptBlock } from './repo';
import { parseTimebox, timeboxPromptBlock } from './timebox';

export { EXTERNAL_CONTENT_NOTICE };

export interface AskInput {
  readonly prompt: string;
  readonly keepTab: boolean;
  /** Ask in this existing conversation instead of a new one. */
  readonly conversationId?: string;
  readonly attachments?: readonly StagedAttachment[];
  /** Defaults to `pro`; `current` keeps the page's selection. */
  readonly model?: AskModel;
  /** Ask in a new chat of this project (a name, an id or a link). */
  readonly project?: string;
  /** `--no-files`: leave the files the reply offers in ChatGPT. */
  readonly noFiles?: boolean;
  /** `--repo`: a reply that says the repository is out of reach fails the job. */
  readonly repo?: RepoTarget;
  /** `--approve-apps`: how to answer ChatGPT's app approval card; unset ends the job on it. */
  readonly approveApps?: ApprovalChoice;
}

const PHASE_C_OPTIONS = ['out'] as const;

/** Upload budget for the page: the transfer and ChatGPT's own upload, sized by the bytes. */
export function attachTimeoutMs(bytes: number): number {
  const mib = bytes / (1024 * 1024);
  return Math.min(10 * 60_000, Math.round(120_000 + mib * 3_000));
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Tells ChatGPT what a zip is (spec Q11); a plain file needs no introduction. */
export function attachmentPreamble(attachments: readonly StagedAttachment[]): string {
  return attachments
    .filter((attachment) => attachment.kind === 'folder')
    .map(
      (attachment) =>
        `(${attachment.name} is a zip of the local folder ${basename(attachment.source)}, ${plural(attachment.fileCount ?? 0, 'file')}.)`,
    )
    .join('\n');
}

/** `--chat <link|id>` or `--continue` (the last succeeded job's conversation); neither is a new chat. */
async function targetConversation(
  fg: ForegroundContext,
  argv: ParsedArgs,
): Promise<string | undefined> {
  const chat = argv.options.chat;
  const continues = argv.options.continue === true;
  if (chat !== undefined && continues) {
    throw failure('bad-request', '--chat and --continue cannot be combined; give one');
  }
  if (typeof chat === 'string') return parseConversationRef(chat);
  if (!continues) return undefined;
  const last = await fg.lastConversation();
  if (last === undefined) {
    throw failure(
      'bad-request',
      'no earlier conversation to continue: no ask or read has succeeded yet. Use --chat <link> instead',
    );
  }
  fg.note(`continuing ${last.url ?? last.conversationId}`);
  return last.conversationId;
}

async function prepare(fg: ForegroundContext, argv: ParsedArgs): Promise<AskInput> {
  for (const name of PHASE_C_OPTIONS) {
    if (argv.options[name] !== undefined) {
      throw failure('bad-request', `--${name} is not available yet (Phase C)`);
    }
  }
  const asked = argv.positionals.join(' ').trim();
  if (asked === '') throw failure('bad-request', 'usage: voyager ask "<prompt>"');
  const model = parseAskModel(argv.options.model);
  const project =
    typeof argv.options.project === 'string' ? argv.options.project.trim() : undefined;
  if (project !== undefined) {
    if (project === '') throw failure('bad-request', '--project needs a project name or id');
    if (argv.options.chat !== undefined || argv.options.continue === true) {
      throw failure(
        'bad-request',
        '--project opens a new chat in the project; --chat and --continue already name a conversation (a project chat continues with them alone)',
      );
    }
  }
  const conversationId = await targetConversation(fg, argv);
  const raw = argv.options.attach;
  const paths = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
  const attachments =
    paths.length === 0
      ? []
      : await stageAttachments(paths, { cwd: fg.cwd, stagingDir: fg.stagingDir, note: fg.note });
  const drive = await prepareDrive(fg, optionList(argv.options.drive), {
    dryRun: argv.options['dry-run'] === true,
  });
  const repo = typeof argv.options.repo === 'string' ? parseRepo(argv.options.repo) : undefined;
  const approveApps = parseApproveApps(argv.options['approve-apps']);
  if (repo !== undefined) fg.note(`repo: ChatGPT is asked to write only to ${repo.branch}`);
  const timebox = parseTimebox(argv.options.timebox);
  const prompt = [
    asked,
    drive.block,
    repo === undefined ? '' : repoPromptBlock(repo),
    timebox === undefined ? '' : timeboxPromptBlock(timebox),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  return {
    prompt,
    keepTab: argv.options['keep-tab'] === true,
    model,
    ...(argv.options['no-files'] === true ? { noFiles: true } : {}),
    ...(project === undefined ? {} : { project }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(repo === undefined ? {} : { repo }),
    ...(approveApps === undefined ? {} : { approveApps }),
  };
}

function optionList(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
}

async function registerAll(
  ctx: JobContext,
  attachments: readonly StagedAttachment[],
): Promise<BlobRef[]> {
  const blobs: BlobRef[] = [];
  for (const attachment of attachments) {
    blobs.push(
      await ctx.blobs.register(attachment.path, {
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        sha256: attachment.sha256,
      }),
    );
  }
  return blobs;
}

async function run(ctx: JobContext, input: AskInput): Promise<JobResult> {
  const startedAt = Date.now();
  // Before any tab opens: a staged file that changed or went missing stops the job here.
  const attachments = input.attachments ?? [];
  const blobs = await registerAll(ctx, attachments);
  const existing = input.conversationId;
  // For an existing conversation the extension checks the tab shows it (`expect`).
  const opened = await openBridgeTab(
    ctx,
    existing === undefined ? { new: true } : { conversationId: existing },
    input.keepTab,
  );
  // Closed when the job ends, also after a failure, unless --keep-tab.
  return inBridgeTab(ctx, opened.tabId, input.keepTab, async () => {
    if (!opened.ready.loggedIn) throw failure('login-required', 'ChatGPT is not logged in');
    if (opened.ready.mode !== 'chat') {
      const work = opened.ready.mode === 'work';
      if (!work) {
        // The extension reads the mode from composer labels measured on the zh-CN UI only.
        const { lang, composerLabels } = opened.ready.evidence;
        throw failure(
          'mode-unknown',
          `could not confirm ChatGPT is in chat mode (page language ${JSON.stringify(lang ?? '')}, composer labels ${JSON.stringify(composerLabels ?? [])}); the mode labels have only been measured on the Chinese (zh-CN) ChatGPT interface so far`,
          { lang, composerLabels },
        );
      }
      throw failure(
        'mode-unavailable',
        existing !== undefined
          ? `conversation ${existing} is a ChatGPT Work conversation; voyager asks only in chat-mode conversations`
          : `ChatGPT is not in chat mode (${opened.ready.mode})`,
      );
    }
    // Kept free of `conversationId`: that key in a checkpoint marks a sent prompt.
    await ctx.checkpoint('opened', { tabId: opened.tabId, url: opened.url });
    if (input.project !== undefined) {
      const { projectId } = await resolveProject(ctx, input.project);
      // In chat mode on the project's page, or a failure: the bridge never switches it to Work.
      const shown = await callProjectOp(ctx, 'project.open', { projectId, view: 'chat' });
      await ctx.checkpoint('project', { projectId, url: shown.url });
    }
    const result = await askInTab(ctx, input, {
      startedAt,
      blobs,
      attachments,
      existing,
      opened,
    });
    if (input.repo !== undefined) checkRepoReach(input.repo, result);
    return result;
  });
}

async function askInTab(
  ctx: JobContext,
  input: AskInput,
  {
    startedAt,
    blobs,
    attachments,
    existing,
    opened,
  }: {
    readonly startedAt: number;
    readonly blobs: readonly BlobRef[];
    readonly attachments: readonly StagedAttachment[];
    readonly existing: string | undefined;
    readonly opened: ConversationOpenResult;
  },
): Promise<JobResult> {
  // One turn at the page from the model choice to the send: another job's model choice
  // in between could change what this prompt goes out on.
  const { model, sent } = await ctx.ops.exclusive(async () => {
    // Before anything is attached or typed: the prompt goes out on the model asked for.
    const chosen: ModelReport = await chooseModel(ctx, input.model ?? DEFAULT_ASK_MODEL);
    if (blobs.length > 0) {
      const bytes = blobs.reduce((sum, blob) => sum + blob.size, 0);
      const attached = await ctx.ops.call(
        'composer.attach',
        { blobs },
        { timeoutMs: attachTimeoutMs(bytes) },
      );
      await ctx.checkpoint('attached', {
        names: attached.attached.map((entry) => entry.name),
        bytes,
      });
    }

    const preamble = attachmentPreamble(attachments);
    const text = preamble === '' ? input.prompt : `${input.prompt}\n\n${preamble}`;
    // Anything but a confirmed send or a proven pre-click failure ends as send-unverified.
    const confirmed = await sendOnce(ctx, {
      text,
      ...(blobs.length > 0 ? { expectAttachments: blobs.map((blob) => blob.name) } : {}),
      // The person can switch chats after the open: a check after the send cannot take it back.
      ...(existing === undefined ? {} : { expect: { conversationId: existing } }),
    });
    return { model: chosen, sent: confirmed };
  });
  const sentAt = Date.now();
  if (existing !== undefined && sent.conversationId !== existing) {
    ctx.log.warn('the prompt went to another conversation than the one asked for', {
      expected: existing,
      actual: sent.conversationId,
    });
  }
  // From here on the prompt exists in ChatGPT: nothing sends it again.
  await ctx.checkpoint('sent', {
    conversationId: sent.conversationId,
    userTurnKey: sent.userTurnKey,
    url: sent.url,
    tabId: opened.tabId,
  });

  const reply = await waitReplyApproving(
    ctx,
    { conversationId: sent.conversationId, afterUserTurnKey: sent.userTurnKey, url: sent.url },
    input.approveApps,
  );
  const repliedAt = Date.now();
  const read = await ctx.ops.call('turns.read', {
    conversationId: sent.conversationId,
    assistantTurnKey: reply.assistantTurnKey,
  });

  const saved = await saveResponse(ctx, read);
  const { responsePath } = saved;
  await ctx.checkpoint('read', { assistantTurnKey: reply.assistantTurnKey, responsePath });
  const { files, failedFiles } = await saveReplyFiles(ctx, read, saved, {
    conversationId: sent.conversationId,
    assistantTurnKey: reply.assistantTurnKey,
    skip: input.noFiles === true,
  });

  return {
    data: {
      conversationUrl: sent.url,
      conversationId: sent.conversationId,
      responsePath,
      files,
      failedFiles,
      attachments: blobs.map((blob, index) => ({
        name: blob.name,
        size: blob.size,
        sha256: blob.sha256,
        kind: attachments[index]?.kind,
        source: attachments[index]?.source,
        ...(attachments[index]?.fileCount === undefined
          ? {}
          : { fileCount: attachments[index]?.fileCount }),
      })),
      model,
      timings: {
        startedAt,
        sentAt,
        repliedAt,
        finishedAt: Date.now(),
        waitMs: reply.elapsedMs,
      },
      response: responseBlock(read, saved),
    },
  };
}

export const askPlugin = definePlugin({
  name: 'ask',
  apiVersion: 1,
  // composer.attach is checked when an --attach run calls it, so text-only asks need no upload support.
  requiresOps: [
    'conversation.open',
    'composer.send',
    'turns.waitReply',
    'turns.read',
    'conversation.close',
    // Every ask selects a model unless `--model current`: an extension without it is told to update up front.
    'model.select',
  ],
  commands: {
    ask: {
      summary: 'Ask ChatGPT (a new conversation, or --chat / --continue) and save the reply',
      args: [{ name: 'prompt', summary: 'the message to send', variadic: true }],
      options: {
        'keep-tab': { type: 'boolean', summary: 'leave the bridge tab open afterwards' },
        chat: {
          type: 'string',
          summary: 'ask in this existing conversation (a chatgpt.com link or its id)',
        },
        project: {
          type: 'string',
          summary:
            'ask in a new chat of this ChatGPT project (its name or g-p- id); its files are there',
        },
        continue: {
          type: 'boolean',
          summary: 'ask in the conversation of the last ask or read that succeeded',
        },
        model: {
          type: 'string',
          summary:
            'GPT-6 effort: pro (default), extra-high, high, medium, instant; current keeps the page as it is',
        },
        drive: {
          type: 'string',
          multiple: true,
          summary:
            "file or folder to put on Google Drive with rclone and link in the prompt, for ChatGPT's Drive app (repeatable)",
        },
        repo: {
          type: 'string',
          summary:
            "GitHub repository for ChatGPT's GitHub app (owner/name[@ref]); it is asked to write only to a new chatgpt/* branch",
        },
        attach: {
          type: 'string',
          multiple: true,
          summary: 'file or folder to attach (repeatable; folders are zipped without credentials)',
        },
        timebox: {
          type: 'string',
          summary:
            'ask ChatGPT to wrap up and hand over what it has after this many minutes (70 for long Pro sandbox work)',
        },
        'dry-run': {
          type: 'boolean',
          summary: 'pack the attachments and print what would be sent, without sending',
        },
        out: { type: 'string', summary: 'also copy the outputs to this folder (Phase C)' },
        'approve-apps': {
          type: 'string',
          summary:
            "answer ChatGPT's app approval card (Google Drive, GitHub…) mid-reply: always (its Always allow, kept in your ChatGPT settings) or once; without it the job stops there (exit 3)",
        },
        'no-files': {
          type: 'boolean',
          summary: 'do not download the files the reply offers (saved under files/ otherwise)',
        },
      },
      prepare,
      // Two asks into one conversation would type into it from two tabs at once.
      conflictKey: (input: AskInput) =>
        input.conversationId === undefined
          ? undefined
          : conversationConflictKey(input.conversationId),
      run,
      present: presentResponse,
    },
  },
});

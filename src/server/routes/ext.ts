/**
 * Extension endpoints (spec §2.2): bearer ext-token and the paired Origin.
 * Uploads are read with `POST /v1/ext/blobs/:id/read` (a POST, so the
 * service worker's request always carries its Origin). Downloads come the
 * other way during a `files.download` task: `POST /v1/ext/blobs` creates one,
 * `POST /v1/ext/blobs/:id` appends a chunk, `POST /v1/ext/blobs/:id/commit`
 * checks it.
 */
import {
  base64DecodedLength,
  BRIDGE_PATHS,
  MAX_BLOB_CHUNK_BASE64,
  validateMessage,
  type BlobChunk,
  type BlobCreateResponse,
  type PollResponse,
} from '@voyager-crew/bridge-protocol';

import type { TaskReply } from '../../jobs/taskSlot';
import { failure } from '../../util/errors';
import { isRecord } from '../../util/isRecord';
import { bearer } from '../guards';
import type { Reply, Route, RouteContext, ServerCore } from '../http';
import { forbidden, HttpFailure } from '../respond';

const TASK = '([A-Za-z0-9_-]{1,128})';
/** A full chunk's base64 plus room for the rest of its JSON. */
const CHUNK_BODY_BYTES = MAX_BLOB_CHUNK_BASE64 + 1024;
/** Linear in the input: no group repeated per four characters. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Returns 'revoked' for a token that was replaced or revoked, so poll can say `unpaired`. */
function authorize(core: ServerCore, ctx: RouteContext): 'ok' | 'revoked' {
  const check = core.pairing.checkToken(bearer(ctx.req), ctx.origin);
  if (check === 'ok' || check === 'revoked') return check;
  if (check === 'bad-origin') throw forbidden('Origin is not the paired extension');
  throw failure('unauthorized', 'missing or wrong extension token');
}

function requirePaired(core: ServerCore, ctx: RouteContext): void {
  if (authorize(core, ctx) === 'revoked') throw failure('unauthorized', 'this pairing was revoked');
}

function taskReply(reply: TaskReply): Reply {
  switch (reply.kind) {
    case 'ok':
      return { status: 200, data: { accepted: true } };
    case 'duplicate':
      return { status: 200, data: { accepted: false } };
    case 'gone':
      throw failure('gone', 'the task has already ended');
    case 'not-found':
      throw failure('not-found', 'no such task');
    case 'invalid':
      throw new HttpFailure(
        400,
        failure('bad-request', 'invalid op result', { issues: reply.issues }).error,
      );
  }
}

/**
 * One chunk of an upload, as base64. Served only while the blob's own job
 * runs `composer.attach` or `project.upload`, so a paired extension cannot
 * read a job's files at any other time.
 */
async function readBlob(core: ServerCore, ctx: RouteContext): Promise<Reply> {
  requirePaired(core, ctx);
  const checked = validateMessage('blobChunkRange', ctx.body);
  if (!checked.ok) throw failure('bad-request', 'invalid chunk range', { issues: checked.issues });
  const blob = core.blobs.get(ctx.params[0]);
  if (blob === undefined) throw failure('not-found', 'no such blob');
  const task = core.slot.taskOf(blob.jobId);
  const uploads = task?.op === 'composer.attach' || task?.op === 'project.upload';
  if (task === undefined || !uploads) {
    throw failure('gone', 'no upload of this blob is running');
  }
  const { offset, length } = checked.value;
  if (offset + length > blob.size) throw failure('bad-request', 'the range lies outside the blob');
  const bytes = await core.blobs.read(blob, offset, length);
  const chunk: BlobChunk = { blobId: blob.blobId, offset, base64: bytes.toString('base64') };
  return { status: 200, data: chunk };
}

/** Downloads are written only by the job's own `files.download` task, while it runs. */
function requireDownloadTask(core: ServerCore, jobId: string, taskId: string): void {
  const task = core.slot.taskOf(jobId);
  if (task?.op !== 'files.download' || task.taskId !== taskId) {
    throw failure('gone', 'no files.download of this job is running as that task');
  }
}

/** The blob in the path, still owned by the task in the slot. */
function requireOwnedBlob(core: ServerCore, blobId: string): void {
  const owner = core.incoming.owner(blobId);
  if (owner === undefined) throw failure('not-found', 'no such blob');
  requireDownloadTask(core, owner.jobId, owner.taskId);
}

async function createDownload(core: ServerCore, ctx: RouteContext): Promise<Reply> {
  requirePaired(core, ctx);
  const checked = validateMessage('blobCreateRequest', ctx.body);
  if (!checked.ok) throw failure('bad-request', 'invalid blob', { issues: checked.issues });
  requireDownloadTask(core, checked.value.jobId, checked.value.taskId);
  const data: BlobCreateResponse = { blobId: await core.incoming.create(checked.value) };
  return { status: 200, data };
}

/**
 * The `blobChunk` validator's base64 pattern overflows V8's regex stack past
 * about 3 MiB of data (bridge-protocol 0.3.0), under a full chunk: `base64` is
 * checked here in linear time, everything else by the shared validator.
 */
function readChunk(body: unknown): BlobChunk {
  const base64 = isRecord(body) ? body.base64 : undefined;
  if (
    typeof base64 !== 'string' ||
    base64 === '' ||
    base64.length > MAX_BLOB_CHUNK_BASE64 ||
    !BASE64.test(base64) ||
    base64DecodedLength(base64) === undefined
  ) {
    throw failure('bad-request', 'invalid chunk: base64 must be padded base64 of one chunk');
  }
  // A short stand-in the pattern accepts; the real value was checked above.
  const checked = validateMessage('blobChunk', { ...(body as object), base64: 'AAAA' });
  if (!checked.ok) throw failure('bad-request', 'invalid chunk', { issues: checked.issues });
  return { ...checked.value, base64 };
}

async function appendDownload(core: ServerCore, ctx: RouteContext): Promise<Reply> {
  requirePaired(core, ctx);
  const chunk = readChunk(ctx.body);
  if (chunk.blobId !== ctx.params[0]) {
    throw failure('bad-request', 'the chunk names another blob than the path');
  }
  requireOwnedBlob(core, ctx.params[0]);
  const { received } = await core.incoming.append(chunk);
  return { status: 200, data: { blobId: ctx.params[0], received } };
}

async function commitDownload(core: ServerCore, ctx: RouteContext): Promise<Reply> {
  requirePaired(core, ctx);
  requireOwnedBlob(core, ctx.params[0]);
  return { status: 200, data: await core.incoming.commit(ctx.params[0]) };
}

async function poll(core: ServerCore, ctx: RouteContext): Promise<Reply> {
  if (authorize(core, ctx) === 'revoked') {
    const unpaired: PollResponse = { kind: 'unpaired' };
    return { status: 200, data: unpaired };
  }
  const checked = validateMessage('pollRequest', ctx.body);
  if (!checked.ok) throw failure('bad-request', 'invalid poll', { issues: checked.issues });
  const request = checked.value;
  core.extension.lastPollAt = core.now();
  core.extension.ops = request.capabilities.ops;
  core.extension.policy = request.policy;
  core.extension.account = request.account ?? null;
  // Absent from a Voyager without parallel jobs; `voyager status` tells that apart from "off".
  core.extension.maxTasks = request.maxTasks ?? null;
  core.slot.notePoll();
  // A newer poll replaces a held one (the service worker restarted, or retried).
  core.heldPoll?.();

  // Re-checked before a held poll takes a task: a pairing replaced meanwhile must not get it.
  const token = bearer(ctx.req);
  const stillPaired = (): boolean => core.pairing.checkToken(token, ctx.origin) === 'ok';
  const view = {
    inflight: new Set(request.inflight.map((entry) => entry.taskId)),
    ops: core.extension.opNames(),
    policy: request.policy.state,
  };
  const immediate = core.slot.poll(view);
  if (immediate !== undefined) return { status: 200, data: immediate };

  const held = await new Promise<PollResponse | undefined>((resolve) => {
    let finished = false;
    const finish = (response: PollResponse | undefined): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      if (core.heldPoll === end) core.heldPoll = undefined;
      resolve(response);
    };
    const end = (): void => finish(undefined);
    const timer = setTimeout(end, core.pollHoldMs);
    const unsubscribe = core.slot.onChange(() => {
      if (finished || ctx.res.destroyed) return;
      if (!stillPaired()) {
        end();
        return;
      }
      const response = core.slot.poll(view);
      if (response !== undefined) finish(response);
    });
    // A poll whose connection dropped must not take a task with it.
    ctx.res.once('close', end);
    core.heldPoll = end;
  });
  return held === undefined ? { status: 204 } : { status: 200, data: held };
}

export function extRoutes(core: ServerCore): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/v1\/ext\/poll$/,
      access: 'ext',
      handle: (ctx) => poll(core, ctx),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/tasks/${TASK}/ack$`),
      access: 'ext',
      handle: (ctx) => {
        requirePaired(core, ctx);
        return taskReply(core.slot.ack(ctx.params[0]));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/tasks/${TASK}/progress$`),
      access: 'ext',
      handle: (ctx) => {
        requirePaired(core, ctx);
        const checked = validateMessage('taskProgress', ctx.body);
        if (!checked.ok)
          throw failure('bad-request', 'invalid progress', { issues: checked.issues });
        return taskReply(core.slot.progress(ctx.params[0], checked.value.seq, checked.value.event));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/tasks/${TASK}/result$`),
      access: 'ext',
      handle: (ctx) => {
        requirePaired(core, ctx);
        const checked = validateMessage('taskResult', ctx.body);
        if (!checked.ok) throw failure('bad-request', 'invalid result', { issues: checked.issues });
        return taskReply(core.slot.result(ctx.params[0], checked.value));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/blobs/${TASK}/read$`),
      access: 'ext',
      handle: (ctx) => readBlob(core, ctx),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^${BRIDGE_PATHS.extBlobs}$`),
      access: 'ext',
      handle: (ctx) => createDownload(core, ctx),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^${BRIDGE_PATHS.extBlobs}/${TASK}$`),
      access: 'ext',
      maxBodyBytes: CHUNK_BODY_BYTES,
      handle: (ctx) => appendDownload(core, ctx),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^${BRIDGE_PATHS.extBlobs}/${TASK}/commit$`),
      access: 'ext',
      handle: (ctx) => commitDownload(core, ctx),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^${BRIDGE_PATHS.extUnpair.replace(/\//g, '\\/')}$`),
      access: 'ext',
      handle: async (ctx) => {
        requirePaired(core, ctx);
        await core.pairing.revoke();
        core.extension.forget();
        core.heldPoll?.();
        core.log.info('extension unpaired itself');
        return { status: 200, data: { revoked: true } };
      },
    },
  ];
}

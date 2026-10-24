import { OP_NAMES, type OpName, type PollResponse } from '@voyager-crew/bridge-protocol';
import { describe, expect, it } from 'vitest';

import { TaskSlot, type PollView } from '../../src/jobs/taskSlot';
import { BridgeFailure } from '../../src/util/errors';

const ALL_OPS: ReadonlySet<OpName> = new Set(OP_NAMES);
const view = (inflight: string[] = [], overrides: Partial<PollView> = {}): PollView => ({
  inflight: new Set(inflight),
  ops: ALL_OPS,
  policy: 'allowed',
  ...overrides,
});
const sendParams = { text: 'hi' };
const sendResult = { conversationId: 'c-1', url: 'https://chatgpt.com/c/c-1', userTurnKey: 't-1' };

function taskOf(response: PollResponse | undefined) {
  if (response?.kind !== 'task')
    throw new Error(`expected a task, got ${JSON.stringify(response)}`);
  return response.task;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BridgeFailure) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

function queue(
  slot: TaskSlot,
  options: { signal?: AbortSignal; deadlineMs?: number; jobId?: string } = {},
) {
  const promise = slot.run({
    jobId: options.jobId ?? 'j1',
    op: 'composer.send',
    params: sendParams,
    deadlineMs: options.deadlineMs ?? 30_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  promise.catch(() => undefined);
  return promise;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('task delivery', () => {
  it('delivers an unacked task again, with the same taskId, when the poll does not list it', async () => {
    const slot = new TaskSlot();
    void queue(slot);
    await tick();
    const first = taskOf(slot.poll(view()));
    const again = taskOf(slot.poll(view()));
    expect(again.taskId).toBe(first.taskId);
    expect(again.issuedAt).toBe(first.issuedAt);
    slot.close();
  });

  it('never delivers an acked task twice: a poll without it fails it as extension-reloaded', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    expect(slot.ack(task.taskId).kind).toBe('ok');
    expect(slot.poll(view([task.taskId]))).toBeUndefined();
    expect(slot.poll(view([]))).toBeUndefined();
    expect(await rejection(result)).toBe('extension-reloaded');
    expect(slot.tasks()).toEqual([]);
    expect(slot.poll(view([]))).toBeUndefined();
    expect(slot.ack(task.taskId).kind).toBe('gone');
  });

  it('counts only the first result and validates it against the op', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    expect(slot.result(task.taskId, { ok: true, data: sendResult }).kind).toBe('ok');
    expect(await result).toEqual(sendResult);
    expect(slot.result(task.taskId, { ok: true, data: sendResult }).kind).toBe('duplicate');

    const invalid = queue(slot);
    await tick();
    const second = taskOf(slot.poll(view()));
    const reply = slot.result(second.taskId, { ok: true, data: { conversationId: '../x' } });
    expect(reply.kind).toBe('invalid');
    expect(await rejection(invalid)).toBe('bad-request');
  });

  it('passes the extension error through with its category', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.result(task.taskId, {
      ok: false,
      error: { code: 'challenge', category: 'user-action', message: 'Cloudflare' },
    });
    expect(await rejection(result)).toBe('challenge');
  });

  it('drops repeated progress by seq', async () => {
    const slot = new TaskSlot();
    const seen: unknown[] = [];
    const result = slot.run({
      jobId: 'j1',
      op: 'composer.send',
      params: sendParams,
      deadlineMs: 30_000,
      onProgress: (event) => seen.push(event),
    });
    await tick();
    const task = taskOf(slot.poll(view()));
    expect(slot.progress(task.taskId, 1, { n: 1 }).kind).toBe('ok');
    expect(slot.progress(task.taskId, 1, { n: 1 }).kind).toBe('duplicate');
    expect(slot.progress(task.taskId, 2, { n: 2 }).kind).toBe('ok');
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    slot.result(task.taskId, { ok: true, data: sendResult });
    await result;
  });
});

describe('abandoning a task', () => {
  it('frees the slot at once when the task was never delivered', async () => {
    const slot = new TaskSlot();
    const controller = new AbortController();
    const result = queue(slot, { signal: controller.signal });
    await tick();
    controller.abort();
    expect(await rejection(result)).toBe('cancelled');
    expect(slot.tasks()).toEqual([]);
    expect(slot.poll(view())).toBeUndefined();
  });

  it('holds the slot after a cancel until the extension lets go of the task', async () => {
    const slot = new TaskSlot();
    const controller = new AbortController();
    const result = queue(slot, { signal: controller.signal });
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    controller.abort();
    expect(await rejection(result)).toBe('cancelled');

    let idle = false;
    void slot.idle().then(() => {
      idle = true;
    });
    expect(slot.poll(view([task.taskId]))).toEqual({
      kind: 'abort',
      taskId: task.taskId,
      reason: 'cancelled',
    });
    expect(slot.poll(view([task.taskId]))).toBeUndefined();
    await tick();
    expect(idle).toBe(false);
    // The next job's op waits behind it.
    const next = queue(slot);
    expect(slot.poll(view([]))).toBeUndefined();
    await tick();
    expect(idle).toBe(true);
    expect(taskOf(slot.poll(view([]))).taskId).not.toBe(task.taskId);
    slot.close();
    await next.catch(() => undefined);
  });

  it('sends the abort again when the extension still lists the task (the first went to a dropped poll)', async () => {
    const slot = new TaskSlot({ abortResendMs: 30 });
    const controller = new AbortController();
    void queue(slot, { signal: controller.signal });
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    controller.abort();
    expect(slot.poll(view([task.taskId]))?.kind).toBe('abort');
    expect(slot.poll(view([task.taskId]))).toBeUndefined();
    let woken = false;
    const unsubscribe = slot.onChange(() => {
      woken = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    unsubscribe();
    expect(woken).toBe(true);
    expect(slot.poll(view([task.taskId]))).toMatchObject({ kind: 'abort', taskId: task.taskId });
    expect(slot.poll(view([]))).toBeUndefined();
    expect(slot.tasks()).toEqual([]);
  });

  it('aborts with timeout when the result does not come within the deadline', async () => {
    const slot = new TaskSlot({ deadlineGraceMs: 0 });
    const result = queue(slot, { deadlineMs: 30 });
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    expect(await rejection(result)).toBe('timeout');
    expect(slot.poll(view([task.taskId]))).toMatchObject({ kind: 'abort', reason: 'timeout' });
    expect(slot.result(task.taskId, { ok: true, data: sendResult }).kind).toBe('gone');
    expect(slot.tasks()).toEqual([]);
  });

  it('fails the task and frees the slot when the extension stops polling', async () => {
    const slot = new TaskSlot({ extensionOfflineMs: 50 });
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    expect(await rejection(result)).toBe('extension-offline');
    expect(slot.tasks()).toEqual([]);
  });
});

describe('what the extension offers', () => {
  it('refuses an op the extension did not declare', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    expect(slot.poll(view([], { ops: new Set<OpName>(['turns.read']) }))).toBeUndefined();
    expect(await rejection(result)).toBe('unsupported-op');
  });

  it('refuses to dispatch while the policy denies the bridge', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    expect(slot.poll(view([], { policy: 'denied' }))).toBeUndefined();
    expect(await rejection(result)).toBe('policy-denied');
  });

  it('says the policy is stale, not that the op is unsupported, when the extension offers no ops', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    expect(slot.poll(view([], { policy: 'stale', ops: new Set() }))).toBeUndefined();
    expect(await rejection(result)).toBe('policy-stale');
  });
});

describe('slots of jobs side by side', () => {
  it('sends the tasks of two jobs on successive polls and settles each by its own result', async () => {
    const slot = new TaskSlot();
    const first = queue(slot, { jobId: 'j1' });
    const second = queue(slot, { jobId: 'j2' });
    await tick();
    const a = taskOf(slot.poll(view()));
    slot.ack(a.taskId);
    const b = taskOf(slot.poll(view([a.taskId])));
    slot.ack(b.taskId);
    expect([a.jobId, b.jobId]).toEqual(['j1', 'j2']);
    expect(slot.poll(view([a.taskId, b.taskId]))).toBeUndefined();

    slot.result(b.taskId, { ok: true, data: { ...sendResult, conversationId: 'c-2' } });
    expect(await second).toMatchObject({ conversationId: 'c-2' });
    expect(slot.tasks().map((task) => task.jobId)).toEqual(['j1']);
    slot.result(a.taskId, { ok: true, data: sendResult });
    expect(await first).toEqual(sendResult);
  });

  it("aborts one job's task and leaves the other's running", async () => {
    const slot = new TaskSlot();
    const controller = new AbortController();
    const cancelled = queue(slot, { jobId: 'j1', signal: controller.signal });
    const kept = queue(slot, { jobId: 'j2' });
    await tick();
    const a = taskOf(slot.poll(view()));
    slot.ack(a.taskId);
    const b = taskOf(slot.poll(view([a.taskId])));
    slot.ack(b.taskId);

    controller.abort();
    expect(await rejection(cancelled)).toBe('cancelled');
    expect(slot.poll(view([a.taskId, b.taskId]))).toEqual({
      kind: 'abort',
      taskId: a.taskId,
      reason: 'cancelled',
    });
    // The page let go of the aborted task only; the other is still in flight.
    expect(slot.poll(view([b.taskId]))).toBeUndefined();
    expect(slot.tasks().map((task) => task.jobId)).toEqual(['j2']);
    slot.result(b.taskId, { ok: true, data: sendResult });
    expect(await kept).toEqual(sendResult);
  });

  it("waits for one job's slot without waiting for another's", async () => {
    const slot = new TaskSlot();
    void queue(slot, { jobId: 'j1' });
    void queue(slot, { jobId: 'j2' });
    await tick();
    const a = taskOf(slot.poll(view()));
    slot.ack(a.taskId);
    let j1Idle = false;
    let allIdle = false;
    void slot.idle('j1').then(() => {
      j1Idle = true;
    });
    void slot.idle().then(() => {
      allIdle = true;
    });
    slot.result(a.taskId, { ok: true, data: sendResult });
    await tick();
    expect(j1Idle).toBe(true);
    expect(allIdle).toBe(false);
    slot.close();
    await tick();
    expect(allIdle).toBe(true);
  });
});

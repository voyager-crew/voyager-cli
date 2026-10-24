import { describe, expect, it } from 'vitest';

import { PageTurns } from '../../src/jobs/pageTurns';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('page turns', () => {
  it('gives the page to one job at a time, in the order they asked', async () => {
    const turns = new PageTurns();
    const order: string[] = [];
    const first = await turns.take('j1');
    const second = turns.take('j2').then((giveBack) => {
      order.push('j2');
      return giveBack;
    });
    const third = turns.take('j3').then((giveBack) => {
      order.push('j3');
      return giveBack;
    });
    await tick();
    expect(order).toEqual([]);
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(['j2', 'j3']);
    expect(turns.current()).toBeUndefined();
  });

  it('lets a job that holds its turn take it again inside it', async () => {
    const turns = new PageTurns();
    const outer = await turns.take('j1');
    const inner = await turns.take('j1');
    let other = false;
    void turns.take('j2').then(() => {
      other = true;
    });
    inner();
    await tick();
    expect(other).toBe(false);
    outer();
    await tick();
    expect(other).toBe(true);
  });

  it('drops a waiting job that was cancelled', async () => {
    const turns = new PageTurns();
    const held = await turns.take('j1');
    const controller = new AbortController();
    const waiting = turns.take('j2', { signal: controller.signal });
    expect(turns.waiting()).toEqual(['j2']);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    expect(turns.waiting()).toEqual([]);
    held();
    expect(turns.current()).toBeUndefined();
  });

  it('refuses a job already cancelled, even when the page is free', async () => {
    const turns = new PageTurns();
    const controller = new AbortController();
    controller.abort();
    await expect(turns.take('j1', { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(turns.current()).toBeUndefined();
  });

  it('keeps a turn it granted when the job is cancelled afterwards', async () => {
    const turns = new PageTurns();
    const held = await turns.take('j1');
    const controller = new AbortController();
    const waiting = turns.take('j2', { signal: controller.signal });
    held();
    const giveBack = await waiting;
    controller.abort();
    expect(turns.current()).toBe('j2');
    giveBack();
    expect(turns.current()).toBeUndefined();
  });

  it('keeps waiting while the holder runs a long step within its own deadline', async () => {
    const turns = new PageTurns({ graceMs: 30 });
    const held = await turns.take('j1');
    turns.opStarted('j1', 'composer.attach', 200);
    let settled = false;
    const waiting = turns.take('j2').finally(() => {
      settled = true;
    });
    await pause(120);
    expect(settled).toBe(false);
    turns.opEnded('j1');
    held();
    (await waiting)();
    expect(turns.current()).toBeUndefined();
  });

  it('fails every waiting job as busy, naming the holder, once its step overruns deadline and grace', async () => {
    const turns = new PageTurns({ graceMs: 30 });
    const held = await turns.take('j1');
    turns.opStarted('j1', 'composer.send', 40);
    const started = Date.now();
    const [late, next] = await Promise.allSettled([turns.take('j2'), turns.take('j3')]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(late).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'busy',
        message: expect.stringContaining('job j1'),
        error: { details: { activeJobId: 'j1', pageTurn: true, holderOp: 'composer.send' } },
      },
    });
    expect(next).toMatchObject({ status: 'rejected', reason: { code: 'busy' } });
    expect(turns.waiting()).toEqual([]);
    // Behind a holder already overdue, a new job fails at once.
    await expect(turns.take('j4')).rejects.toMatchObject({ code: 'busy' });
    held();
    expect(turns.current()).toBeUndefined();
  });

  it('gives a holder only the grace between its steps, and every new holder its own', async () => {
    const turns = new PageTurns({ graceMs: 40 });
    const held = await turns.take('j1');
    const second = turns.take('j2');
    await pause(20);
    held();
    const giveBack = await second;
    // j2 starts afresh: j3 waits for it, not for what is left of j1's time.
    const third = turns.take('j3');
    await expect(third).rejects.toMatchObject({
      code: 'busy',
      message: expect.stringContaining('job j2'),
    });
    giveBack();
  });

  it('gives a cleanup step its own, shorter wait', async () => {
    const turns = new PageTurns({ graceMs: 5_000, cleanupWaitMs: 20 });
    const held = await turns.take('j1');
    const step = turns.take('j2');
    await expect(turns.take('j3', { cleanup: true })).rejects.toMatchObject({ code: 'busy' });
    expect(turns.waiting()).toEqual(['j2']);
    held();
    (await step)();
  });
});

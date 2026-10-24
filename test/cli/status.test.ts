import { bridgeError } from '@voyager-crew/bridge-protocol';
import { describe, expect, it } from 'vitest';

import { statusJobLines } from '../../src/cli/commands/info';
import { busyNote } from '../../src/cli/commands/job';
import type { ServeStatus } from '../../src/server/serveStatus';

const NOW = 1_000_000;

function status(
  extension: Partial<ServeStatus['extension']>,
  rest: Partial<ServeStatus> = {},
): ServeStatus {
  return {
    extension: {
      paired: true,
      lastPollAt: NOW - 2_000,
      version: '2.2.1',
      browser: 'chrome',
      policy: null,
      ...extension,
    },
    maxJobs: 1,
    serverVersion: '0.5.0',
    ...rest,
  };
}

const parallel = (s: ServeStatus) => statusJobLines(s, NOW).slice(1);

describe('voyager status: parallel jobs', () => {
  it('says an older Voyager runs one job at a time, apart from a switch that is off', () => {
    expect(parallel(status({ maxTasks: null }))).toEqual([
      'parallel jobs: not in Voyager 2.2.1 (one job at a time; a newer Voyager runs several)',
    ]);
    expect(parallel(status({ maxTasks: 1 }))).toEqual([
      'parallel jobs: off (one job at a time; turn it on in the Voyager popup)',
    ]);
  });

  it('says how many run at once, and when config.json holds it below the popup', () => {
    expect(parallel(status({ maxTasks: 4 }, { maxJobs: 4 }))).toEqual([
      'parallel jobs: up to 4 at once',
    ]);
    expect(parallel(status({ maxTasks: 4 }, { maxJobs: 2 }))).toEqual([
      'parallel jobs: up to 2 at once (maxParallelJobs in config.json; the Voyager popup allows 4)',
    ]);
  });

  it('says nothing about it while the extension is unpaired or away', () => {
    expect(parallel(status({ paired: false, maxTasks: null }))).toEqual([]);
    expect(parallel(status({ lastPollAt: null, maxTasks: null }))).toEqual([]);
    expect(parallel(status({ lastPollAt: NOW - 10 * 60_000, maxTasks: 4 }))).toEqual([]);
  });

  it('names the job that has the page turn and the jobs waiting for it', () => {
    const lines = statusJobLines(
      status(
        { maxTasks: 3 },
        {
          maxJobs: 3,
          activeJobs: [
            { jobId: 'j1', op: 'composer.send', pageTurn: 'holding' },
            { jobId: 'j2', op: 'turns.waitReply' },
            { jobId: 'j3', pageTurn: 'waiting' },
          ],
        },
      ),
      NOW,
    );
    expect(lines[0]).toBe(
      'active jobs: j1 (composer.send, has the page turn), j2 (turns.waitReply), j3 (waiting for the page turn)',
    );
  });
});

describe('busy note', () => {
  it('keeps the one-job-at-a-time words, and gives the reason once jobs run side by side', () => {
    const one = bridgeError('busy', 'another job is running; it is not queued', {
      activeJobId: 'j1',
      maxJobs: 1,
    });
    expect(busyNote(one)).toBe(
      'busy: job j1 is running. Wait with voyager job wait j1; jobs are not queued.',
    );
    const conflict = bridgeError(
      'busy',
      'job j2 is working on conversation c-1; it is not queued',
      {
        activeJobId: 'j2',
        activeJobIds: ['j1', 'j2'],
        maxJobs: 3,
        conflict: 'conversation c-1',
      },
    );
    expect(busyNote(conflict)).toBe(
      'busy: job j2 is working on conversation c-1; it is not queued. Wait with voyager job wait j2.',
    );
    const full = bridgeError(
      'busy',
      '2 jobs are running, as many as may run at once; it is not queued',
      {
        activeJobId: 'j1',
        activeJobIds: ['j1', 'j2'],
        maxJobs: 2,
      },
    );
    expect(busyNote(full)).toContain('as many as may run at once');
    expect(busyNote(full)).toContain('(running: j1, j2)');
  });
});

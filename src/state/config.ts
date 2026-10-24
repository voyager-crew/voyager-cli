import { DEFAULT_PORT } from '@voyager-crew/bridge-protocol';

import { readJsonFile } from '../util/files';
import { isRecord } from '../util/isRecord';
import type { StatePaths } from './paths';

export interface Config {
  readonly port: number;
  /** rclone destination for `ask --drive`, such as `gdrive:Voyager`; `$VOYAGER_DRIVE_REMOTE` wins. */
  readonly driveRemote?: string;
  /**
   * At most this many jobs at once while the extension allows parallel jobs (the person
   * picks how many in its popup); unset follows the extension. Each running job is a
   * request of its own. A value that is not a whole number of 1 or more counts as 1.
   */
  readonly maxParallelJobs?: number;
  /** The `maxParallelJobs` config.json gives when it is not usable (as JSON), for a warning. */
  readonly invalidMaxParallelJobs?: string;
}

/** `config.json` is optional; anything unreadable in it falls back to the default. */
export async function loadConfig(paths: StatePaths): Promise<Config> {
  const raw = await readJsonFile(paths.config);
  const port = isRecord(raw) ? raw.port : undefined;
  const valid = typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536;
  const driveRemote =
    isRecord(raw) && typeof raw.driveRemote === 'string' ? raw.driveRemote.trim() : '';
  const maxJobs = isRecord(raw) ? raw.maxParallelJobs : undefined;
  const usable = typeof maxJobs === 'number' && Number.isSafeInteger(maxJobs) && maxJobs >= 1;
  return {
    port: valid ? port : DEFAULT_PORT,
    ...(driveRemote === '' ? {} : { driveRemote }),
    // A limit the person set but mistyped means fewer jobs, never as many as the extension allows.
    ...(maxJobs === undefined
      ? {}
      : usable
        ? { maxParallelJobs: maxJobs }
        : { maxParallelJobs: 1, invalidMaxParallelJobs: JSON.stringify(maxJobs) }),
  };
}

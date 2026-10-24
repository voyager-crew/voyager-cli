/**
 * A plugin's own small JSON state (`plugin-state/<plugin>.json`, 0600), kept
 * across jobs: `voyager project upload` remembers what it uploaded there.
 * Serve reads and writes it for the job that runs; nothing else does.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginState } from '../plugins/api';
import { readJsonFile, writeJsonAtomic } from '../util/files';
import type { StatePaths } from './paths';

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** What lies on disk; serve adds the serialized `update` for the jobs that share it. */
export type StoredPluginState = Pick<PluginState, 'read' | 'write'>;

export function pluginStateStore(paths: StatePaths, plugin: string): StoredPluginState {
  if (!PLUGIN_NAME.test(plugin)) throw new Error(`not a plugin name: ${plugin}`);
  const file = join(paths.pluginState, `${plugin}.json`);
  return {
    read: () => readJsonFile(file),
    write: async (value) => {
      await mkdir(paths.pluginState, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(file, value);
    },
  };
}

/**
 * `base` with an `update` that waits for the plugin's earlier updates (`last` holds the
 * newest), so jobs of one plugin side by side never lose each other's writes.
 */
export function withSerialUpdates(
  base: StoredPluginState,
  last: { current: Promise<unknown> },
): PluginState {
  return {
    read: () => base.read(),
    write: (value) => base.write(value),
    update: (change) => {
      const next = last.current.then(async () => {
        const current = await base.read().catch(() => undefined);
        await base.write(change(current));
      });
      last.current = next.catch(() => undefined);
      return next;
    },
  };
}

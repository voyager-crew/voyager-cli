/**
 * What `voyager project upload` last uploaded to each project, per file name:
 * the content's sha256 (a folder's zip is reproducible, so the same files give
 * the same hash). Kept in the plugin's state under `~/.voyager/plugin-state/`.
 * A file the project lists but this record does not know is treated as changed.
 */
import type { PluginState } from '../../src/plugins/api';
import { isRecord } from '../../src/util/isRecord';

export interface Fingerprint {
  readonly sha256: string;
  readonly size: number;
  readonly source: string;
  readonly at: number;
}

type Projects = Record<string, Record<string, Fingerprint>>;

const SHA256 = /^[0-9a-f]{64}$/;

function readFingerprint(raw: unknown): Fingerprint | undefined {
  if (!isRecord(raw) || typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) {
    return undefined;
  }
  return {
    sha256: raw.sha256,
    size: typeof raw.size === 'number' ? raw.size : 0,
    source: typeof raw.source === 'string' ? raw.source : '',
    at: typeof raw.at === 'number' ? raw.at : 0,
  };
}

/** The stored record, keeping only well-formed entries. */
async function load(state: PluginState): Promise<Projects> {
  try {
    return parse(await state.read());
  } catch {
    return {};
  }
}

function parse(raw: unknown): Projects {
  const projects: Projects = {};
  if (!isRecord(raw) || !isRecord(raw.uploads)) return projects;
  for (const [projectId, files] of Object.entries(raw.uploads)) {
    if (!isRecord(files)) continue;
    const kept: Record<string, Fingerprint> = {};
    for (const [name, entry] of Object.entries(files)) {
      const fingerprint = readFingerprint(entry);
      if (fingerprint) kept[name] = fingerprint;
    }
    projects[projectId] = kept;
  }
  return projects;
}

export async function fingerprintOf(
  state: PluginState,
  projectId: string,
  name: string,
): Promise<Fingerprint | undefined> {
  const projects = await load(state);
  return Object.hasOwn(projects, projectId) && Object.hasOwn(projects[projectId], name)
    ? projects[projectId][name]
    : undefined;
}

/** Record `name`'s upload, or forget it with `undefined`; other jobs' records stay. */
export async function rememberUpload(
  state: PluginState,
  projectId: string,
  name: string,
  fingerprint: Fingerprint | undefined,
): Promise<void> {
  await state.update((raw) => {
    const projects = parse(raw);
    const files = { ...(Object.hasOwn(projects, projectId) ? projects[projectId] : {}) };
    if (fingerprint) files[name] = fingerprint;
    else delete files[name];
    projects[projectId] = files;
    return { version: 1, uploads: projects };
  });
}

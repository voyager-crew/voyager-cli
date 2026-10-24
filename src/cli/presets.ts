import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { failure } from '../util/errors';

const BUILT_IN_PRESETS: Readonly<Record<string, string>> = {
  math: 'Mathematical research session. This question comes from a long-running mathematics project. Treat it as research: expect a long session and prepare for hours of real work; depth and rigor come before speed. Every conclusion is either derived from the material given, verified, or marked explicitly as a conjecture together with what evidence would settle it. Work from the exact statement below rather than a paraphrase of it.',
};

export async function resolvePreset(value: unknown, cwd: string): Promise<string> {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw failure('bad-request', '--preset needs a built-in name or a UTF-8 text file');
  }
  if (Object.hasOwn(BUILT_IN_PRESETS, value)) return BUILT_IN_PRESETS[value];

  const label = JSON.stringify(value);
  let text: string;
  try {
    text = await readFile(resolve(cwd, value), 'utf8');
  } catch {
    throw failure(
      'bad-request',
      `--preset ${label}: use a built-in name (math) or a readable UTF-8 text file`,
    );
  }
  if (Array.from(text).length > 20_000) {
    throw failure('bad-request', `--preset ${label}: file exceeds 20,000 characters`);
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw failure('bad-request', `--preset ${label}: file is empty after trimming whitespace`);
  }
  return trimmed;
}

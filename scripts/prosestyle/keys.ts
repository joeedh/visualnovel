/**
 * Key lookup for the two routes.
 *
 * Not `resolveKeys`, which reads env-var names out of a project's `project.yaml` and this repo
 * root has none. `KEY_VENDORS` and `SECRET_FILES` in `@vn/config` cover the vendors a `ChatVendor`
 * can name, and `openrouter` is not one, so the filenames live here instead.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Route } from './model.js';

interface KeySpec {
  env: string;
  files: string[];
}

const KEYS: Record<Route, KeySpec> = {
  anthropic: { env: 'ANTHROPIC_API_KEY', files: ['claude.txt', 'anthropic.txt'] },
  openrouter: { env: 'OPENROUTER_API_KEY', files: ['openrouter.txt'] },
};

/** Names where a key came from. Never carries the value. */
export type KeySource = { kind: 'env'; name: string } | { kind: 'file'; path: string };

export interface FoundKey {
  value: string;
  source: KeySource;
}

/**
 * Finds a key for one route, the env var first and then each directory in order. Throws naming
 * every place it looked, and never the value.
 */
export async function findKey(route: Route, dirs: string[]): Promise<FoundKey> {
  const spec = KEYS[route];
  const fromEnv = process.env[spec.env];
  if (fromEnv) return { value: fromEnv.trim(), source: { kind: 'env', name: spec.env } };

  for (const dir of dirs) {
    for (const file of spec.files) {
      const path = join(dir, file);
      try {
        const value = (await fs.readFile(path, 'utf8')).trim();
        if (value) return { value, source: { kind: 'file', path } };
      } catch {
        // Absent or unreadable; the next candidate answers, or the throw below does.
      }
    }
  }
  const looked = [spec.env, ...dirs.flatMap((d) => spec.files.map((f) => join(d, f)))];
  throw new Error(`no ${route} key. Looked at: ${looked.join(', ')}`);
}

/** The filenames a route accepts, for a message that has to list them. */
export function keyFilesFor(route: Route): string[] {
  return KEYS[route].files;
}

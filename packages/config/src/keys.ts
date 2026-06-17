import { dirname, join, resolve } from 'node:path';
import type { ProjectConfig } from '@vn/types';
import { ConfigError, exists, readText } from '@vn/util';

/** Resolved API keys. Values are secrets and MUST never be logged (report §8, §11). */
export interface ResolvedKeys {
  gemini: string;
  anthropic: string;
}

/** Filenames to look for when an env var is unset: `<secretsDir>/<file>`, by vendor. */
const SECRET_FILES: Record<keyof ResolvedKeys, string[]> = {
  gemini: ['gemini.txt'],
  anthropic: ['claude.txt', 'anthropic.txt'],
};

/** Files that mark the root of a repo/workspace when walking up from a project dir. */
const ROOT_MARKERS = ['pnpm-workspace.yaml', '.git'];

/** Walk up from `start` to the nearest enclosing repo/workspace root, if any. */
async function findRepoRoot(start: string): Promise<string | undefined> {
  let cur = resolve(start);
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (await exists(join(cur, marker))) return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * Ordered `keys/` directories to consult for a project, most specific first: the project's
 * own `keys/`, then the enclosing repo/workspace root's `keys/` (when the project lives
 * inside one). Lets a single shared `keys/` at the repo root serve every project under it.
 * Absolute and de-duplicated, so a project that *is* the repo root yields one entry.
 */
export async function secretDirsFor(projectDir: string): Promise<string[]> {
  const dirs = [resolve(projectDir, 'keys')];
  const root = await findRepoRoot(projectDir);
  if (root) {
    const rootKeys = resolve(root, 'keys');
    if (!dirs.includes(rootKeys)) dirs.push(rootKeys);
  }
  return dirs;
}

async function resolveOne(
  envName: string,
  files: string[],
  secretsDirs: string[],
): Promise<string | undefined> {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  for (const dir of secretsDirs) {
    for (const file of files) {
      const path = join(dir, file);
      if (await exists(path)) {
        const content = (await readText(path)).trim();
        if (content) return content;
      }
    }
  }
  return undefined;
}

/**
 * Resolve API keys from environment variables (named in config) first, then optional
 * secret files under each of `secretsDirs` (in order). Throws a ConfigError naming only
 * the *source*, never the value, if a required key is missing.
 */
export async function resolveKeys(
  config: ProjectConfig,
  opts: { secretsDirs?: string[]; require?: (keyof ResolvedKeys)[] } = {},
): Promise<ResolvedKeys> {
  const secretsDirs = opts.secretsDirs ?? [];
  const gemini = await resolveOne(config.keys.gemini, SECRET_FILES.gemini, secretsDirs);
  const anthropic = await resolveOne(config.keys.anthropic, SECRET_FILES.anthropic, secretsDirs);

  for (const name of opts.require ?? []) {
    const value = name === 'gemini' ? gemini : anthropic;
    if (!value) {
      const envName = name === 'gemini' ? config.keys.gemini : config.keys.anthropic;
      throw new ConfigError(
        `missing ${name} API key: set $${envName} or place ${SECRET_FILES[name][0]} in a keys/ dir`,
      );
    }
  }

  return { gemini: gemini ?? '', anthropic: anthropic ?? '' };
}

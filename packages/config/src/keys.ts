import { join } from 'node:path';
import type { ProjectConfig } from '@vn/types';
import { ConfigError, exists, readText } from '@vn/util';

/** Resolved API keys. Values are secrets and MUST never be logged (report §8, §11). */
export interface ResolvedKeys {
  gemini: string;
  anthropic: string;
}

/** Where to look for keys when an env var is unset: `<secretsDir>/<file>`. */
const SECRET_FILES: Record<keyof ResolvedKeys, string[]> = {
  gemini: ['gemini.txt'],
  anthropic: ['claude.txt', 'anthropic.txt'],
};

async function resolveOne(
  envName: string,
  files: string[],
  secretsDir: string | undefined,
): Promise<string | undefined> {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (!secretsDir) return undefined;
  for (const file of files) {
    const path = join(secretsDir, file);
    if (await exists(path)) {
      const content = (await readText(path)).trim();
      if (content) return content;
    }
  }
  return undefined;
}

/**
 * Resolve API keys from environment variables (named in config) first, then optional
 * secret files under `secretsDir`. Throws a ConfigError naming only the *source*, never
 * the value, if a required key is missing.
 */
export async function resolveKeys(
  config: ProjectConfig,
  opts: { secretsDir?: string; require?: (keyof ResolvedKeys)[] } = {},
): Promise<ResolvedKeys> {
  const gemini = await resolveOne(config.keys.gemini, SECRET_FILES.gemini, opts.secretsDir);
  const anthropic = await resolveOne(
    config.keys.anthropic,
    SECRET_FILES.anthropic,
    opts.secretsDir,
  );

  for (const name of opts.require ?? []) {
    const value = name === 'gemini' ? gemini : anthropic;
    if (!value) {
      const envName = name === 'gemini' ? config.keys.gemini : config.keys.anthropic;
      throw new ConfigError(
        `missing ${name} API key: set $${envName} or place ${SECRET_FILES[name][0]} in the secrets dir`,
      );
    }
  }

  return { gemini: gemini ?? '', anthropic: anthropic ?? '' };
}

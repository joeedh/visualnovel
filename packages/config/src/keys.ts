import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectConfig } from '@vn/types';
import { ConfigError, exists, readText } from '@vn/util';

/** Resolved API keys. Values are secrets and MUST never be logged (report §8, §11). */
export interface ResolvedKeys {
  gemini: string;
  anthropic: string;
}

/** The vendors a key is resolved for. Ordered, so a UI can offer them without inventing a list. */
export const KEY_VENDORS = ['gemini', 'anthropic'] as const;

/** Filenames to look for when an env var is unset: `<secretsDir>/<file>`, by vendor. */
const SECRET_FILES: Record<keyof ResolvedKeys, string[]> = {
  gemini: ['gemini.txt'],
  anthropic: ['claude.txt', 'anthropic.txt'],
};

/**
 * Where a vendor's key is *written*: the first filename `resolveKeys` looks for, so what a
 * writer puts down is what a reader picks up. The later names are read-only aliases.
 */
export function secretFileFor(vendor: keyof ResolvedKeys): string {
  return SECRET_FILES[vendor][0]!;
}

/**
 * The directory name user-level state lives under, on every platform. One name, so the app, the
 * CLI and the authoring agent cannot end up with two homes between them.
 */
const USER_DIR_NAME = 'vnauthor';

/**
 * What {@link userConfigDir} reads the world through. Both are injectable so the platform table
 * below is testable without a machine per row — which is the only reason this function is not
 * simply two lines of `process`.
 */
export interface UserDirEnv {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `os.homedir()`. */
  home?: string;
}

/** The platform-conventional directory, with no override and no legacy fallback applied. */
function nativeConfigDir({ platform, env, home }: Required<UserDirEnv>): string {
  if (platform === 'win32') {
    // Local, deliberately, not Roaming: `%APPDATA%` follows a domain user between machines, and
    // an API key is exactly what should not be copied off the machine it was pasted on.
    const local = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
    return join(local, USER_DIR_NAME);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', USER_DIR_NAME);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), USER_DIR_NAME);
}

function userDirEnv(opts: UserDirEnv): Required<UserDirEnv> {
  return {
    platform: opts.platform ?? process.platform,
    env: opts.env ?? process.env,
    home: opts.home ?? homedir(),
  };
}

/**
 * The one directory user-level state is **written** to: keys today, and any settings a later
 * plan adds — so settings and keys never end up in two homes.
 *
 * | Platform | Directory                                    |
 * | -------- | -------------------------------------------- |
 * | Windows  | `%LOCALAPPDATA%\vnauthor`                    |
 * | macOS    | `~/Library/Application Support/vnauthor`      |
 * | Linux    | `$XDG_CONFIG_HOME/vnauthor`, else `~/.config` |
 *
 * `$VNAUTHOR_HOME` overrides the whole thing. Tests set it, CI sets it, and so can anyone who
 * wants their config somewhere else. It is what keeps the branch above from being untestable.
 *
 * This is the directory an installer must not put inside the install and an uninstaller must not
 * delete by accident: it is the author's, not the build's.
 */
export function userConfigDir(opts: UserDirEnv = {}): string {
  const resolved = userDirEnv(opts);
  const override = resolved.env.VNAUTHOR_HOME?.trim();
  return override ? resolve(override) : nativeConfigDir(resolved);
}

/**
 * Every directory user-level state is **read** from, most specific first.
 *
 * That is {@link userConfigDir}, plus `~/.vnauthor` when it exists and the native directory does
 * not — so a key placed by hand before this landed keeps working and nothing has to be migrated.
 * The legacy directory is only ever read; writes go to {@link userConfigDir} alone, which is what
 * stops the two from drifting into a slow migration nobody finishes.
 *
 * `$VNAUTHOR_HOME` suppresses the fallback rather than sitting in front of it. An override says
 * *this* is where my config is; a test or a CI job that sets it to an empty directory and still
 * got the author's `~/.vnauthor` would be the exact leak the override exists to prevent.
 */
export function userConfigDirs(opts: UserDirEnv = {}): string[] {
  const resolved = userDirEnv(opts);
  const primary = userConfigDir(opts);
  if (resolved.env.VNAUTHOR_HOME?.trim()) return [primary];
  const legacy = join(resolved.home, `.${USER_DIR_NAME}`);
  if (legacy !== primary && !existsSync(primary) && existsSync(legacy)) return [primary, legacy];
  return [primary];
}

/** Where a user-level key file is written: `<user config dir>/keys`. */
export function userKeysDir(opts: UserDirEnv = {}): string {
  return join(userConfigDir(opts), 'keys');
}

/** Every `keys/` directory a user-level key is read from, in {@link userConfigDirs} order. */
export function userKeysDirs(opts: UserDirEnv = {}): string[] {
  return userConfigDirs(opts).map((dir) => join(dir, 'keys'));
}

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

export interface SecretDirsOptions extends UserDirEnv {
  /**
   * Whether to append the user-level `keys/` directories. **Defaults to `true`**, so every host
   * gets the last rung without a change and no host can forget it.
   *
   * `@vn/testkit` passes `false` explicitly: a test project is a closed world, and a test that
   * read the developer's own key would pass for the wrong reason on their machine and fail on CI.
   */
  includeUser?: boolean;
}

/**
 * Ordered `keys/` directories to consult for a project, most specific first: the project's
 * own `keys/`, then the enclosing repo/workspace root's `keys/` (when the project lives
 * inside one), then the user's own — {@link userKeysDirs}. Lets a single shared `keys/` at the
 * repo root serve every project under it, and a single one per author serve every project.
 * Absolute and de-duplicated, so a project that *is* the repo root yields one entry.
 */
export async function secretDirsFor(
  projectDir: string,
  opts: SecretDirsOptions = {},
): Promise<string[]> {
  const dirs = [resolve(projectDir, 'keys')];
  const root = await findRepoRoot(projectDir);
  if (root) {
    const rootKeys = resolve(root, 'keys');
    if (!dirs.includes(rootKeys)) dirs.push(rootKeys);
  }
  if (opts.includeUser !== false) {
    for (const dir of userKeysDirs(opts)) {
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/** Where a resolved key came from. Names a source; never carries the value. */
export type KeySource = { kind: 'env'; name: string } | { kind: 'file'; dir: string; file: string };

/** A resolved key and the source that answered, so a caller can report one without the other. */
interface Located {
  value?: string;
  source?: KeySource;
}

async function locateOne(
  envName: string,
  files: string[],
  secretsDirs: string[],
): Promise<Located> {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) {
    return { value: fromEnv.trim(), source: { kind: 'env', name: envName } };
  }
  for (const dir of secretsDirs) {
    for (const file of files) {
      const path = join(dir, file);
      if (await exists(path)) {
        const content = (await readText(path)).trim();
        if (content) return { value: content, source: { kind: 'file', dir, file } };
      }
    }
  }
  return {};
}

async function resolveOne(
  envName: string,
  files: string[],
  secretsDirs: string[],
): Promise<string | undefined> {
  return (await locateOne(envName, files, secretsDirs)).value;
}

/** What resolution found for one vendor — never the key itself. */
export interface VendorKeyStatus {
  vendor: keyof ResolvedKeys;
  /** Whether a key resolved at all. */
  resolved: boolean;
  /** Which source answered. Absent when nothing did. */
  source?: KeySource;
  /** The environment variable `project.yaml` names for this vendor, set or not. */
  envName: string;
  /**
   * Whether that variable is set. It is read before every file, so a set variable shadows a key
   * the author has just pasted — which is the honest answer to "why is it still asking me".
   */
  envShadow: boolean;
}

/**
 * For each vendor, whether a key resolved and **which source** answered. Reads the same way
 * {@link resolveKeys} does, throws for nothing, and returns no key values — so it is safe to send
 * to a renderer, to record, and to show in a pane.
 */
export async function keyStatus(
  config: ProjectConfig,
  opts: { secretsDirs?: string[] } = {},
): Promise<VendorKeyStatus[]> {
  const secretsDirs = opts.secretsDirs ?? [];
  return Promise.all(
    KEY_VENDORS.map(async (vendor) => {
      const envName = config.keys[vendor];
      const { value, source } = await locateOne(envName, SECRET_FILES[vendor], secretsDirs);
      return {
        vendor,
        resolved: value !== undefined,
        ...(source ? { source } : {}),
        envName,
        envShadow: (process.env[envName] ?? '').trim() !== '',
      };
    }),
  );
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

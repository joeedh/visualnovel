/**
 * Startup sanity checks. Runs before any workspace opens.
 *
 * `git` is the only check today, and it is a real dependency, not a nicety: `@vn/git` spawns
 * it for commit-on-save, `initRepoAt`, the undo journal's shadow refs and the repo map.
 * Without git a packaged app fails at the first save rather than degrading, so the check runs
 * before a workspace opens. A missing git is not fatal: watching a generated VN needs no git.
 *
 * No portable git is bundled. Bundling one would add tens of megabytes and a second thing to
 * keep patched, for a problem only Windows has. The dialog offers a link to the installer
 * instead.
 */
import { execFile } from 'node:child_process';

/** The download page offered when git is missing. Named once so the dialog and the note agree. */
export const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

/** The one sentence shown wherever a missing git is reported to the author. */
export const GIT_MISSING_MESSAGE =
  'Git is not on this machine’s PATH. The app still opens and plays, but saving, undo and ' +
  'project history all rest on git, so none of them will work until it is installed.';

/**
 * The oldest git the history reads work on: `%(trailers:only)` in a log format arrived in 2.13.
 * `status --porcelain=v2` (2.11) and `push --follow-tags` (1.8.3) are older.
 */
export const GIT_MIN_VERSION = '2.13';

/** The sentence shown when git is present but older than `GIT_MIN_VERSION`. */
export const GIT_OLD_MESSAGE =
  `This machine’s git is older than ${GIT_MIN_VERSION}. Saving works, but the History pane ` +
  'cannot read a save’s provenance from it; updating git fixes that.';

export interface GitHealth {
  ok: boolean;
  /** What `git --version` reported, when it could be read — for a bug report, not for logic. */
  version?: string;
  /** Set when the version parsed and is below `GIT_MIN_VERSION`. */
  old?: true;
}

/** The one impure part, injected so the check itself is testable without a machine. */
export type VersionProbe = () => Promise<{ code: number; stdout: string }>;

const spawnGit: VersionProbe = () =>
  new Promise((resolve) => {
    execFile('git', ['--version'], { windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: stdout.toString() });
    });
  });

/**
 * The number out of `git version 2.45.1.windows.1`. A missing number is not a failure: git ran,
 * and the string is only shown to a human.
 */
export function gitVersionOf(stdout: string): string | undefined {
  return /\b(\d+\.\d+(?:\.\d+)*)/.exec(stdout)?.[1];
}

/** Is `version` (`2.45.1`) below `floor` (`2.13`)? Compares number by number, missing parts as 0. */
export function olderThan(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Whether `git` is on PATH, and whether it is new enough. A probe that throws counts as absent,
 * like a non-zero exit. An unparseable version is not old: a git that ran is a git that works.
 */
export async function checkGit(run: VersionProbe = spawnGit): Promise<GitHealth> {
  const { code, stdout } = await run().catch(() => ({ code: 1, stdout: '' }));
  if (code !== 0) return { ok: false };
  const version = gitVersionOf(stdout);
  if (!version) return { ok: true };
  return olderThan(version, GIT_MIN_VERSION)
    ? { ok: true, version, old: true }
    : { ok: true, version };
}

/**
 * The startup finding, for code deciding whether to spawn git at all. Recording it is a separate
 * call from making it so that `checkGit` stays pure; a test that injects a probe would otherwise
 * leave its answer behind for every test after it.
 *
 * The default is `ok`, because everything that asks runs after startup has recorded a finding.
 */
let recorded: GitHealth = { ok: true };

export function noteGitHealth(health: GitHealth): GitHealth {
  recorded = health;
  return health;
}

export function gitHealth(): GitHealth {
  return recorded;
}

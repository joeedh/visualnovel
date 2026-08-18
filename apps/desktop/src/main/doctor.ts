/**
 * What the app needs from the machine it was installed on, asked once at startup.
 *
 * `git` is the only entry today, and it is a real dependency rather than a nicety: `@vn/git`
 * spawns it for commit-on-save, `initRepoAt`, the undo journal's shadow refs and the repo map.
 * Without it a packaged app does not degrade, it fails at the first save — so it is better said
 * before a workspace opens than discovered later in a dialog nobody can act on. It is
 * deliberately **not** fatal: someone who only wants to watch a generated VN should not need git
 * to do it.
 *
 * We do not bundle a portable git. It would add tens of megabytes and a second thing to keep
 * patched, to solve a problem only Windows has — where the answer is a link to the installer.
 */
import { execFile } from 'node:child_process';

/** Where a stranger goes to fix it. Named once, so the dialog and the note cannot disagree. */
export const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

/** What the author is told, in one sentence, wherever they are told it. */
export const GIT_MISSING_MESSAGE =
  'Git is not on this machine’s PATH. The app still opens and plays, but saving, undo and ' +
  'project history all rest on git, so none of them will work until it is installed.';

export interface GitHealth {
  ok: boolean;
  /** What `git --version` reported, when it could be read — for a bug report, not for logic. */
  version?: string;
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
 * The number out of `git version 2.45.1.windows.1`. Absent is not a failure — a git that ran is
 * a git that works, and the string is only ever shown to a human.
 */
export function gitVersionOf(stdout: string): string | undefined {
  return /\b(\d+\.\d+(?:\.\d+)*)/.exec(stdout)?.[1];
}

/** Whether `git` is on PATH. A probe that throws counts as absent, like a non-zero exit. */
export async function checkGit(run: VersionProbe = spawnGit): Promise<GitHealth> {
  const { code, stdout } = await run().catch(() => ({ code: 1, stdout: '' }));
  if (code !== 0) return { ok: false };
  const version = gitVersionOf(stdout);
  return version ? { ok: true, version } : { ok: true };
}

/**
 * The finding, once, for the code that must decide whether to spawn git at all. Recording it is a
 * separate call from making it so `checkGit` stays pure — a test that injects a probe would
 * otherwise leave its answer behind for every test after it.
 *
 * It reads `ok` until told otherwise, because everything that asks runs after startup did.
 */
let recorded: GitHealth = { ok: true };

export function noteGitHealth(health: GitHealth): GitHealth {
  recorded = health;
  return health;
}

export function gitHealth(): GitHealth {
  return recorded;
}

/**
 * Where the desktop app opens, and how a first launch gets something to open.
 *
 * `examples/sample` is a read-only **template**. A real run writes ~100 MB of generated art
 * into `vngen/`, and doing that inside the source tree buries `git status` and leaves no way
 * to tell "the sample we ship" from "the copy I've been messing with". So the app seeds a
 * scratch copy with its own git repo — gitignored by the parent, hence not a submodule — and
 * works there.
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openGit } from '@vn/git';

/**
 * Template entries that are never seeded: `vngen/` is a previous run's output (a fresh
 * workspace has not been run, and pretending otherwise would make the first `run` look like
 * a no-op), `keys/` is secrets, and the rest are machinery.
 */
const SKIP = new Set(['vngen', 'keys', '.git', 'node_modules']);

/** Used only when git can't already answer who the committer is. */
const FALLBACK_IDENTITY = { name: 'VN Studio', email: 'vnstudio@localhost' };

export interface SeedResult {
  root: string;
  /** False when the workspace already existed and was opened untouched. */
  seeded: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open `target`, creating it from `template` on first use. An existing directory is opened
 * **untouched** — never re-copied, never overwritten: it is the user's working copy and it is
 * the only thing between a stray reseed and a day's authoring. Resetting is deleting it.
 */
export async function seedWorkspace(template: string, target: string): Promise<SeedResult> {
  if (await exists(target)) return { root: target, seeded: false };
  if (!(await exists(template))) {
    throw new Error(`cannot seed ${target}: no project template at ${template}`);
  }

  await mkdir(target, { recursive: true });
  for (const entry of await readdir(template)) {
    if (SKIP.has(entry)) continue;
    await cp(join(template, entry), join(target, entry), { recursive: true });
  }

  const git = openGit(target);
  await git.init();
  // A fresh repo inherits no local identity, and `commit` fails outright without one — but a
  // global identity is the user's own, so only fill in what git can't already answer.
  if (!(await git.configGet('user.email'))) {
    await git.config('user.email', FALLBACK_IDENTITY.email);
    await git.config('user.name', FALLBACK_IDENTITY.name);
  }
  // Same reason testkit sets it: the branch editor patches scene prose byte-exactly.
  await git.config('core.autocrlf', 'false');
  await git.commit({ message: 'Sample project inputs', paths: ['-A'] });

  return { root: target, seeded: true };
}

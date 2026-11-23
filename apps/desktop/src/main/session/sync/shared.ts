import type { Git, InProgress } from '@vn/git';
import { GitError, noUpstream, remoteSentence, syncTarget } from '@vn/git';
import { NOT_OWNED, notCheckedOut, type RepoRole, type RepoSync } from '../../../shared/history.js';
import type { WorkspaceSession } from '../core.js';

/** What `git.resolve` and `git.continueSync` say when no sync is waiting on a decision. */
export const NO_SYNC_STOPPED = 'No sync is waiting on a decision.';

export type Refusal = { ok: false; reason: string };

export const refuse = (reason: string): Refusal => ({ ok: false, reason });

/** A repository the app may sync. */
export interface Owned {
  git: Git;
  root: string;
}

/** Builds a repository's part of a sync that ran no rebase; the caller adds the note saying why. */
export const nothing = (role: RepoRole): RepoSync => ({
  role,
  got       : 0,
  replayed  : 0,
  conflicted: [],
  rewrote   : [],
  finished  : true,
});

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The repository in `role`, or the refusal every write shares: busy, then not owned. */
export async function writable(
  session: WorkspaceSession,
  role: RepoRole,
  checkBusy = true,
): Promise<Owned | Refusal> {
  const busy = checkBusy ? session.busy() : undefined;
  if (busy) return refuse(`${busy} is still running; wait for it to finish.`);
  const found = await session.historyPart.repo(role);
  if (!found) return refuse(`This project has no ${role} repository.`);
  if (found.missing) return refuse(notCheckedOut(found.root));
  if (!found.owned) return refuse(NOT_OWNED);
  return { git: found.git, root: found.root };
}

/** The repository, with the remote `name` names, or the refusal. Empty names the sync target. */
export async function withRemote(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
  checkBusy = true,
): Promise<(Owned & { remote: string; remotes: string[] }) | Refusal> {
  const repo = await writable(session, role, checkBusy);
  if ('ok' in repo) return repo;
  const remotes = (await repo.git.remotes()).map((r) => r.name);
  let remote = name.trim();
  if (remote === '') {
    // Mid-rebase HEAD is detached, and the branch being rebased is the one with an upstream
    const branch = await repo.git.branch();
    const rebasing = branch === 'HEAD' ? (await repo.git.inProgress()).rebase?.branch : null;
    const target = await syncTarget(repo.git, rebasing ?? branch);
    if (!target) return refuse(noUpstream(remotes.length));
    remote = target.remote;
  }
  if (!remotes.includes(remote)) return refuse(`No shared copy named “${remote}”.`);
  return { ...repo, remote, remotes };
}

/** The repository with a rebase stopped in it, or the refusal. */
export async function stopped(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<(Owned & { state: InProgress }) | Refusal> {
  const repo = await writable(session, role);
  if ('ok' in repo) return repo;
  const state = await repo.git.inProgress();
  if (!state.rebase) return refuse(NO_SYNC_STOPPED);
  return { ...repo, state };
}

export async function conflicted(git: Git): Promise<string[]> {
  return (await git.branchStatus()).entries.filter((e) => e.unmerged).map((e) => e.path);
}

/** Runs a network verb, and rethrows git's own sentence when the remote refused. */
export async function network<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitError) throw new Error(remoteSentence(err.message));
    throw err;
  }
}

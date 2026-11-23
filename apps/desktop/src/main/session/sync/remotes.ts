import type { CheckResult } from '@vn/commands';
import { remoteNameProblem, remoteUrlProblem, syncTarget } from '@vn/git';
import type { RepoRole } from '../../../shared/history.js';
import type { WorkspaceSession } from '../core.js';
import { network, refuse, withRemote, writable, type Owned, type Refusal } from './shared.js';

// `git.addRemote`

export async function previewAddRemote(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
  url: string,
): Promise<CheckResult> {
  const plan = await planAddRemote(session, role, name, url);
  if ('ok' in plan) return plan;
  return {
    ok  : true,
    note: plan.first
      ? `Connects “${name.trim()}” at ${url.trim()} and syncs with it from now on.`
      : plan.keeps !== null
        ? `Connects “${name.trim()}” at ${url.trim()}; “${plan.keeps}” stays the copy this branch syncs with.`
        : `Connects “${name.trim()}” at ${url.trim()}.`,
  };
}

/**
 * Adds the remote. The first one a branch gets becomes the copy it syncs with, so a project
 * connected once needs nothing else before its first pull. A branch syncing with its only
 * remote by implication has that remote recorded first, since a second one ends the implication.
 */
export async function addRemote(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
  url: string,
): Promise<{ syncsWith: boolean }> {
  const plan = await planAddRemote(session, role, name, url);
  if ('ok' in plan) throw new Error(plan.reason);
  if (plan.keeps !== null && plan.branch !== null) {
    await plan.git.trackRemote(plan.branch, plan.keeps);
  }
  await plan.git.remoteAdd(name.trim(), url.trim());
  if (plan.first && plan.branch !== null) {
    await plan.git.trackRemote(plan.branch, name.trim());
    return { syncsWith: true };
  }
  return { syncsWith: false };
}

/** `keeps` names the implied sync target to record before the new remote joins it. */
async function planAddRemote(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
  url: string,
): Promise<(Owned & { first: boolean; keeps: string | null; branch: string | null }) | Refusal> {
  const repo = await writable(session, role, false);
  if ('ok' in repo) return repo;
  const remotes = (await repo.git.remotes()).map((r) => r.name);
  const problem = remoteNameProblem(name, remotes) ?? remoteUrlProblem(url);
  if (problem !== undefined) return refuse(problem);
  const branch = await repo.git.branch();
  const onBranch = branch !== 'HEAD';
  const target = onBranch ? await syncTarget(repo.git, branch) : null;
  return {
    ...repo,
    first : target === null,
    keeps : target?.implied ? target.remote : null,
    branch: onBranch ? branch : null,
  };
}

// `git.removeRemote`

export async function previewRemoveRemote(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<CheckResult> {
  const found = await withRemote(session, role, name, false);
  if ('ok' in found) return found;
  return {
    ok  : true,
    note: `Forgets “${found.remote}”. Nothing in this project is removed, and the copy itself is untouched.`,
  };
}

export async function removeRemote(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<{ remote: string }> {
  const found = await withRemote(session, role, name, false);
  if ('ok' in found) throw new Error(found.reason);
  await found.git.remoteRemove(found.remote);
  return { remote: found.remote };
}

// `git.setRemoteUrl`

export async function previewSetRemoteUrl(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
  url: string,
): Promise<CheckResult> {
  const found = await withRemote(session, role, name, false);
  if ('ok' in found) return found;
  const problem = remoteUrlProblem(url);
  if (problem !== undefined) return refuse(problem);
  return { ok: true, note: `Points “${found.remote}” at ${url.trim()}.` };
}

export async function setRemoteUrl(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
  url: string,
): Promise<{ remote: string }> {
  const found = await withRemote(session, role, name, false);
  if ('ok' in found) throw new Error(found.reason);
  const problem = remoteUrlProblem(url);
  if (problem !== undefined) throw new Error(problem);
  await found.git.remoteSetUrl(found.remote, url.trim());
  return { remote: found.remote };
}

// `git.syncWith`

export async function previewSyncWith(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<CheckResult> {
  const plan = await planSyncWith(session, role, name);
  if ('ok' in plan) return plan;
  return { ok: true, note: `Gets their saves from “${plan.remote}” from now on.` };
}

/** Writes `branch.<name>.remote` and `.merge`, where a terminal `git pull` reads them too. */
export async function syncWith(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<{ remote: string; branch: string }> {
  const plan = await planSyncWith(session, role, name);
  if ('ok' in plan) throw new Error(plan.reason);
  await plan.git.trackRemote(plan.branch, plan.remote);
  return { remote: plan.remote, branch: plan.branch };
}

async function planSyncWith(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<(Owned & { remote: string; branch: string }) | Refusal> {
  const found = await withRemote(session, role, name, false);
  if ('ok' in found) return found;
  const branch = await found.git.branch();
  if (branch === 'HEAD') return refuse('Not on a branch; check one out first.');
  return { ...found, branch };
}

// `git.fetch`

export async function previewFetch(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<CheckResult> {
  const found = await withRemote(session, role, name, false);
  if ('ok' in found) return found;
  return { ok: true, note: `Asks “${found.remote}” what it has; nothing here changes.` };
}

export async function fetchRemote(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<{ remote: string; behind: number | null }> {
  const found = await withRemote(session, role, name, false);
  if ('ok' in found) throw new Error(found.reason);
  await network(() => found.git.fetch(found.remote));
  const branch = await found.git.branch();
  const counts =
    branch === 'HEAD' ? null : await found.git.aheadBehind(`${found.remote}/${branch}`);
  return { remote: found.remote, behind: counts?.behind ?? null };
}

import type { CheckResult } from '@vn/commands';
import { DIRTY_TREE, finishRebase, noUpstream, syncTarget, type SyncTarget } from '@vn/git';
import {
  SYNC_UNFINISHED,
  type RepoRole,
  type RepoSync,
  type SyncOutcome,
} from '../../../shared/history.js';
import type { WorkspaceSession } from '../core.js';
import { baseLink, dirty, replay, type BaseLink } from './rebase.js';
import {
  conflicted,
  network,
  nothing,
  refuse,
  writable,
  type Owned,
  type Refusal,
} from './shared.js';

/**
 * The refusal `git.pull` gives on the project while the base art's own sync is stopped. The
 * project is pulled only after the base art has its collaborator's pictures.
 */
export const BASE_UNFINISHED =
  'Getting the base art’s saves is unfinished; finish or give it up in its history first.';
/** What `git.pull` on the project says when the base art has edits no save holds. */
export const BASE_DIRTY =
  'The base art has edits on disk not yet saved; save or discard them first.';

/**
 * A repository with the shared copy its branch syncs with. `branch` is the local branch and
 * `theirs` the branch of the same line on the copy; `implied` as in `SyncTarget`.
 */
type Pullable = Owned & { remote: string; branch: string; theirs: string; implied: boolean };

/** Builds the sync half of a `Pullable` for `branch` from the target it syncs with. */
const pullable = (target: SyncTarget, branch: string) => ({
  remote: target.remote,
  branch,
  theirs : target.branch,
  implied: target.implied,
});

export async function previewPull(session: WorkspaceSession, role: RepoRole): Promise<CheckResult> {
  const plan = await planPull(session, role);
  if ('ok' in plan) return plan;
  const adopts = plan.implied ? ` “${plan.remote}” becomes the copy this branch syncs with.` : '';
  const project = `Gets their saves from “${plan.remote}” and replays yours on top. A collision waits for your decision.${adopts}`;
  if (plan.base === undefined) return { ok: true, note: project };
  if ('note' in plan.base) return { ok: true, note: `${project} ${plan.base.note}` };
  const baseAdopts = plan.base.implied
    ? ` “${plan.base.remote}” becomes the copy the base art syncs with.`
    : '';
  return {
    ok  : true,
    note: `Gets the base art’s saves from “${plan.base.remote}” first, then the project’s from “${plan.remote}”, and replays yours on top of each. A collision waits for your decision, and the project waits for the base art’s.${baseAdopts}${adopts}`,
  };
}

/**
 * Gets the base art's saves first when the project is pulled, so the project's references are
 * then checked against the pictures they name. While the base art's rebase is stopped the
 * project is not pulled; the author pulls again once the base art's files are decided.
 */
export async function pull(session: WorkspaceSession, role: RepoRole): Promise<SyncOutcome> {
  const plan = await planPull(session, role);
  if ('ok' in plan) throw new Error(plan.reason);
  const repos: RepoSync[] = [];
  if (plan.base !== undefined && 'note' in plan.base) {
    repos.push({ ...nothing('base'), note: plan.base.note });
  } else if (plan.base !== undefined) {
    const base = await pullOne(session, 'base', plan.base);
    repos.push(base);
    if (!base.finished) return { repos };
  }
  repos.push(await pullOne(session, role, plan, plan.link));
  return { repos };
}

/**
 * Fetches the upstream and rebases the branch onto it. A rebase that stops on a collision is
 * returned as such, since the stopped state is what the conflict view shows; one that completes
 * carries the rewrite table for the saves it replayed. An implied target is recorded as the
 * branch's upstream once the fetch finds its branch there.
 */
async function pullOne(
  session: WorkspaceSession,
  role: RepoRole,
  plan: Pullable,
  link: BaseLink | null = null,
): Promise<RepoSync> {
  const { git, remote, branch, theirs } = plan;
  await network(() => git.fetch(remote));
  const upstream = `${remote}/${theirs}`;
  const onto = await git.resolve(upstream);
  const none = nothing(role);
  if (onto === null) {
    return { ...none, note: `“${remote}” has no ${theirs} yet; send your saves first.` };
  }
  if (plan.implied) await git.trackRemote(branch, remote, theirs);
  const counts = await git.aheadBehind(upstream);
  if (counts === null || counts.behind === 0) {
    return { ...none, note: `Nothing new to get; everything “${remote}” has is here.` };
  }
  const origHead = (await git.head())!;
  const completed = await replay(git, () => git.rebase(upstream), link);
  session.historyPart.dropMemo();
  if (!completed) {
    const stopped = await conflicted(git);
    return {
      role,
      got       : counts.behind,
      replayed  : 0,
      conflicted: stopped,
      rewrote   : [],
      finished  : false,
    };
  }
  const done = await finishRebase(git, onto, origHead);
  return {
    role,
    got       : counts.behind,
    replayed  : done.replayed,
    conflicted: [],
    rewrote   : done.rewrote,
    finished  : true,
  };
}

/**
 * Checks that the repository `role` names is ready to pull. For the project, also plans the base
 * art's pull, which is ready, skipped with a note, or refused (and a refusal stops both).
 */
async function planPull(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<(Pullable & { base?: Pullable | { note: string }; link: BaseLink | null }) | Refusal> {
  const repo = await writable(session, role);
  if ('ok' in repo) return repo;
  const link = role === 'project' ? await baseLink(session, repo.root) : null;
  const base = link === null ? undefined : await planBase(link);
  if (base !== undefined && 'ok' in base) return base;
  // The gitlink is exempt from the dirty check: a base art save moves it before commit-on-save
  // records it, and the rebase leaves that change in place
  const plan = await readyToPull(repo, link?.path ?? null);
  if ('ok' in plan) return plan;
  return { ...plan, link, ...(base === undefined ? {} : { base }) };
}

/**
 * Checks that `repo` is ready to pull and returns its branch and sync target, or the refusal.
 * `skip` names a gitlink edit to ignore.
 */
async function readyToPull(repo: Owned, skip: string | null): Promise<Pullable | Refusal> {
  const state = await repo.git.inProgress();
  if (state.rebase || state.merge || state.revert) return refuse(SYNC_UNFINISHED);
  const branch = await repo.git.branch();
  if (branch === 'HEAD') return refuse('Not on a branch; check one out first.');
  const target = await syncTarget(repo.git, branch);
  if (!target) return refuse(noUpstream((await repo.git.remotes()).length));
  if (await dirty(repo.git, skip)) return refuse(DIRTY_TREE);
  return { ...repo, ...pullable(target, branch) };
}

/**
 * Plans the base art's pull, which runs before the project's. A base art with no sync target,
 * or on no branch, is skipped with a note. One with a stopped sync or unsaved edits refuses the
 * whole pull.
 */
async function planBase(link: BaseLink): Promise<Pullable | { note: string } | Refusal> {
  const base = { git: link.git, root: link.root };
  const state = await base.git.inProgress();
  if (state.rebase || state.merge || state.revert) return refuse(BASE_UNFINISHED);
  const branch = await base.git.branch();
  if (branch === 'HEAD') return { note: 'The base art is on no branch, so it is skipped.' };
  const target = await syncTarget(base.git, branch);
  if (!target) {
    return (await base.git.remotes()).length === 0
      ? { note: 'The base art has no shared copy to get from, so it is skipped.' }
      : { note: 'The base art syncs with none of its shared copies, so it is skipped.' };
  }
  if (await dirty(base.git, null)) return refuse(BASE_DIRTY);
  return { ...base, ...pullable(target, branch) };
}

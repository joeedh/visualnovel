/**
 * The writes behind the `git.*` sync commands: the shared copies a repository has, getting a
 * collaborator's saves, sending the author's, and the three acts that finish or abandon a sync
 * that stopped on a collision. Each has a preview, which is the command's `check`, and a run that
 * repeats the preview first. The rules are `@vn/git`'s; git's own sentence is what a refusal from
 * the network says.
 */
import { join, relative, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CheckResult } from '@vn/commands';
import { resolutionProblem } from '@vn/model';
import { readDocFile, writeDocFile } from '@vn/store';
import { hasConflictMarkers, samePath, writeFileAtomic } from '@vn/util';
import {
  DIRTY_TREE,
  dirtyOutsideLogs,
  finishRebase,
  GitError,
  noUpstream,
  OWN_LOGS,
  REBASE_SIDE,
  remoteNameProblem,
  remoteSentence,
  remoteUrlProblem,
  syncTarget,
  unsentToTarget,
  type Git,
  type InProgress,
  type MySide,
  type SyncTarget,
} from '@vn/git';
import {
  NOT_OWNED,
  notCheckedOut,
  readableConflict,
  SYNC_UNFINISHED,
  type RepoRole,
  type RepoSync,
  type SyncOutcome,
} from '../../shared/history.js';
import { fileCache } from '../workspace/filecache.js';
import { DOC_WRITERS, relPath } from './core.js';
import type { WorkspaceSession } from './core.js';

/** What `git.resolve` and `git.continueSync` say when no sync is waiting on a decision. */
export const NO_SYNC_STOPPED = 'No sync is waiting on a decision.';
/** What `git.abandonSync` says when there is nothing to abandon. */
export const NOTHING_TO_ABANDON = 'Nothing is part way through; there is nothing to give up.';

const SCENE_PATH = /^scenes\/[^/]+\.md$/;

type Refusal = { ok: false; reason: string };

const refuse = (reason: string): Refusal => ({ ok: false, reason });

/** A repository the app may sync. */
interface Owned {
  git: Git;
  root: string;
}

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

/** The base art's repository, and the path of its gitlink in the project. */
interface BaseLink extends Owned {
  path: string;
}

/** Builds a repository's part of a sync that ran no rebase; the caller adds the note saying why. */
const nothing = (role: RepoRole): RepoSync => ({
  role,
  got       : 0,
  replayed  : 0,
  conflicted: [],
  rewrote   : [],
  finished  : true,
});

/** Builds the sync half of a `Pullable` for `branch` from the target it syncs with. */
const pullable = (target: SyncTarget, branch: string) => ({
  remote: target.remote,
  branch,
  theirs : target.branch,
  implied: target.implied,
});

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export class SyncPart {
  constructor(private readonly session: WorkspaceSession) {}

  /** The repository in `role`, or the refusal every write shares: busy, then not owned. */
  private async writable(role: RepoRole, checkBusy = true): Promise<Owned | Refusal> {
    const busy = checkBusy ? this.session.busy() : undefined;
    if (busy) return refuse(`${busy} is still running; wait for it to finish.`);
    const found = await this.session.historyPart.repo(role);
    if (!found) return refuse(`This project has no ${role} repository.`);
    if (found.missing) return refuse(notCheckedOut(found.root));
    if (!found.owned) return refuse(NOT_OWNED);
    return { git: found.git, root: found.root };
  }

  /** The repository, with the remote `name` names, or the refusal. Empty names the sync target. */
  private async withRemote(
    role: RepoRole,
    name: string,
    checkBusy = true,
  ): Promise<(Owned & { remote: string; remotes: string[] }) | Refusal> {
    const repo = await this.writable(role, checkBusy);
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

  // `git.addRemote`

  async previewAddRemote(role: RepoRole, name: string, url: string): Promise<CheckResult> {
    const plan = await this.planAddRemote(role, name, url);
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
  async addRemote(role: RepoRole, name: string, url: string): Promise<{ syncsWith: boolean }> {
    const plan = await this.planAddRemote(role, name, url);
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
  private async planAddRemote(
    role: RepoRole,
    name: string,
    url: string,
  ): Promise<(Owned & { first: boolean; keeps: string | null; branch: string | null }) | Refusal> {
    const repo = await this.writable(role, false);
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

  async previewRemoveRemote(role: RepoRole, name: string): Promise<CheckResult> {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) return found;
    return {
      ok  : true,
      note: `Forgets “${found.remote}”. Nothing in this project is removed, and the copy itself is untouched.`,
    };
  }

  async removeRemote(role: RepoRole, name: string): Promise<{ remote: string }> {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) throw new Error(found.reason);
    await found.git.remoteRemove(found.remote);
    return { remote: found.remote };
  }

  // `git.setRemoteUrl`

  async previewSetRemoteUrl(role: RepoRole, name: string, url: string): Promise<CheckResult> {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) return found;
    const problem = remoteUrlProblem(url);
    if (problem !== undefined) return refuse(problem);
    return { ok: true, note: `Points “${found.remote}” at ${url.trim()}.` };
  }

  async setRemoteUrl(role: RepoRole, name: string, url: string): Promise<{ remote: string }> {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) throw new Error(found.reason);
    const problem = remoteUrlProblem(url);
    if (problem !== undefined) throw new Error(problem);
    await found.git.remoteSetUrl(found.remote, url.trim());
    return { remote: found.remote };
  }

  // `git.syncWith`

  async previewSyncWith(role: RepoRole, name: string): Promise<CheckResult> {
    const plan = await this.planSyncWith(role, name);
    if ('ok' in plan) return plan;
    return { ok: true, note: `Gets their saves from “${plan.remote}” from now on.` };
  }

  /** Writes `branch.<name>.remote` and `.merge`, where a terminal `git pull` reads them too. */
  async syncWith(role: RepoRole, name: string): Promise<{ remote: string; branch: string }> {
    const plan = await this.planSyncWith(role, name);
    if ('ok' in plan) throw new Error(plan.reason);
    await plan.git.trackRemote(plan.branch, plan.remote);
    return { remote: plan.remote, branch: plan.branch };
  }

  private async planSyncWith(
    role: RepoRole,
    name: string,
  ): Promise<(Owned & { remote: string; branch: string }) | Refusal> {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) return found;
    const branch = await found.git.branch();
    if (branch === 'HEAD') return refuse('Not on a branch; check one out first.');
    return { ...found, branch };
  }

  // `git.fetch`

  async previewFetch(role: RepoRole, name: string): Promise<CheckResult> {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) return found;
    return { ok: true, note: `Asks “${found.remote}” what it has; nothing here changes.` };
  }

  async fetch(role: RepoRole, name: string): Promise<{ remote: string; behind: number | null }> {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) throw new Error(found.reason);
    await this.network(() => found.git.fetch(found.remote));
    const branch = await found.git.branch();
    const counts =
      branch === 'HEAD' ? null : await found.git.aheadBehind(`${found.remote}/${branch}`);
    return { remote: found.remote, behind: counts?.behind ?? null };
  }

  // `git.pull`

  async previewPull(role: RepoRole): Promise<CheckResult> {
    const plan = await this.planPull(role);
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
  async pull(role: RepoRole): Promise<SyncOutcome> {
    const plan = await this.planPull(role);
    if ('ok' in plan) throw new Error(plan.reason);
    const repos: RepoSync[] = [];
    if (plan.base !== undefined && 'note' in plan.base) {
      repos.push({ ...nothing('base'), note: plan.base.note });
    } else if (plan.base !== undefined) {
      const base = await this.pullOne('base', plan.base);
      repos.push(base);
      if (!base.finished) return { repos };
    }
    repos.push(await this.pullOne(role, plan, plan.link));
    return { repos };
  }

  /**
   * Fetches the upstream and rebases the branch onto it. A rebase that stops on a collision is
   * returned as such, since the stopped state is what the conflict view shows; one that completes
   * carries the rewrite table for the saves it replayed. An implied target is recorded as the
   * branch's upstream once the fetch finds its branch there.
   */
  private async pullOne(
    role: RepoRole,
    plan: Pullable,
    link: BaseLink | null = null,
  ): Promise<RepoSync> {
    const { git, remote, branch, theirs } = plan;
    await this.network(() => git.fetch(remote));
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
    const completed = await this.replay(git, () => git.rebase(upstream), link);
    this.session.historyPart.dropMemo();
    if (!completed) {
      const conflicted = await this.conflicted(git);
      return { role, got: counts.behind, replayed: 0, conflicted, rewrote: [], finished: false };
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
  private async planPull(
    role: RepoRole,
  ): Promise<(Pullable & { base?: Pullable | { note: string }; link: BaseLink | null }) | Refusal> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const link = role === 'project' ? await this.baseLink(repo.root) : null;
    const base = link === null ? undefined : await this.planBase(link);
    if (base !== undefined && 'ok' in base) return base;
    // The gitlink is exempt from the dirty check: a base art save moves it before commit-on-save
    // records it, and the rebase leaves that change in place
    const plan = await this.readyToPull(repo, link?.path ?? null);
    if ('ok' in plan) return plan;
    return { ...plan, link, ...(base === undefined ? {} : { base }) };
  }

  /**
   * Checks that `repo` is ready to pull and returns its branch and sync target, or the refusal.
   * `skip` names a gitlink edit to ignore.
   */
  private async readyToPull(repo: Owned, skip: string | null): Promise<Pullable | Refusal> {
    const state = await repo.git.inProgress();
    if (state.rebase || state.merge || state.revert) return refuse(SYNC_UNFINISHED);
    const branch = await repo.git.branch();
    if (branch === 'HEAD') return refuse('Not on a branch; check one out first.');
    const target = await syncTarget(repo.git, branch);
    if (!target) return refuse(noUpstream((await repo.git.remotes()).length));
    if (await this.dirty(repo.git, skip)) return refuse(DIRTY_TREE);
    return { ...repo, ...pullable(target, branch) };
  }

  /**
   * Plans the base art's pull, which runs before the project's. A base art with no sync target,
   * or on no branch, is skipped with a note. One with a stopped sync or unsaved edits refuses the
   * whole pull.
   */
  private async planBase(link: BaseLink): Promise<Pullable | { note: string } | Refusal> {
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
    if (await this.dirty(base.git, null)) return refuse(BASE_DIRTY);
    return { ...base, ...pullable(target, branch) };
  }

  /**
   * Finds the base art when it is a repository of its own nested in the project, owned and
   * checked out.
   */
  private async baseLink(projectRoot: string): Promise<BaseLink | null> {
    const found = await this.session.historyPart.repo('base');
    if (!found || found.missing || !found.owned || samePath(found.root, projectRoot)) return null;
    const path = relative(projectRoot, found.root).split(sep).join('/');
    return { git: found.git, root: found.root, path };
  }

  /**
   * Runs `step`, the rebase or its continue, and settles each stop on the base art's gitlink by
   * staging the base art's head, when that head holds the shared copy's side. A save whose only
   * change was the gitlink is then empty, and is skipped. A stop with other files in question
   * still waits for the author, with the gitlink already decided.
   */
  private async replay(
    git: Git,
    step: () => Promise<boolean>,
    link: BaseLink | null,
  ): Promise<boolean> {
    let completed = await step();
    while (!completed && link !== null) {
      const conflicted = await this.conflicted(git);
      if (!conflicted.includes(link.path) || !(await this.holdsCopy(git, link))) return false;
      await git.add([link.path]);
      if (conflicted.length > 1) return false;
      const empty = (await git.diff({ staged: true })) === '';
      completed = empty ? await git.rebaseSkip() : await git.rebaseContinue();
    }
    return completed;
  }

  /** Whether the base art's head holds the commit the shared copy's side of the gitlink names. */
  private async holdsCopy(git: Git, link: BaseLink): Promise<boolean> {
    // Mid-rebase, git's `ours` is the shared copy's saves with the author's replayed so far
    const copy = (await git.stagesOf(link.path))[2];
    const head = await link.git.head();
    if (copy === undefined || head === null) return false;
    return link.git.isAncestor(copy, head).catch(() => false);
  }

  /** Whether anything but the app's logs, and the gitlink `skip` names, is changed on disk. */
  private async dirty(git: Git, skip: string | null): Promise<boolean> {
    if (skip === null) return dirtyOutsideLogs(git);
    const status = await git.status();
    return status.entries.some(
      (e) => e.path !== skip && !OWN_LOGS.some((prefix) => e.path.startsWith(prefix)),
    );
  }

  // `git.push`

  async previewPush(role: RepoRole, name: string): Promise<CheckResult> {
    const plan = await this.planPush(role, name);
    if ('ok' in plan) return plan;
    return {
      ok  : true,
      note:
        (plan.ahead === null
          ? `Sends every save to “${plan.remote}”, which has none of them yet.`
          : `Sends ${plural(plan.ahead, 'save')} to “${plan.remote}”.`) +
        (plan.adopts ? ` “${plan.remote}” becomes the copy this branch syncs with.` : ''),
    };
  }

  /** Sends the branch, and records an implied sync target as its upstream once the send lands. */
  async push(role: RepoRole, name: string): Promise<{ remote: string; sent: number | null }> {
    const plan = await this.planPush(role, name);
    if ('ok' in plan) throw new Error(plan.reason);
    await this.network(() => plan.git.push(plan.remote, plan.branch));
    if (plan.adopts) await plan.git.trackRemote(plan.branch, plan.remote);
    return { remote: plan.remote, sent: plan.ahead };
  }

  /**
   * Every refusal a push can earn: no such copy, a sync part way through, nothing to send, and
   * saves of theirs not yet got, which under a rebase is the one way the author's line can carry
   * them. The project is also refused while its story bible has unsent saves of its own, since
   * the project's history would then name a bible save the copy does not hold.
   */
  private async planPush(
    role: RepoRole,
    name: string,
  ): Promise<
    (Owned & { remote: string; branch: string; ahead: number | null; adopts: boolean }) | Refusal
  > {
    const found = await this.withRemote(role, name, false);
    if ('ok' in found) return found;
    const state = await found.git.inProgress();
    if (state.rebase) return refuse(SYNC_UNFINISHED);
    const branch = await found.git.branch();
    if (branch === 'HEAD') return refuse('Not on a branch; check one out first.');
    const target = await syncTarget(found.git, branch);
    const adopts = target !== null && target.implied && target.remote === found.remote;
    const counts = await found.git.aheadBehind(`${found.remote}/${branch}`);
    if (counts !== null) {
      if (counts.behind > 0) {
        return refuse(
          `“${found.remote}” has ${plural(counts.behind, 'save')} you do not; get their saves first.`,
        );
      }
      if (counts.ahead === 0) return refuse(`Nothing to send; “${found.remote}” has every save.`);
    }
    if (role === 'project') {
      const held = await this.wikiUnsent(found.root);
      if (held !== null && held > 0) {
        return refuse(
          `The story bible has ${plural(held, 'save')} not yet sent; send those first, so the project does not name saves the copy lacks.`,
        );
      }
    }
    return { ...found, branch, ahead: counts?.ahead ?? null, adopts };
  }

  /** How many saves the story bible's own repository has not sent, or null when it has none nested here. */
  private async wikiUnsent(projectRoot: string): Promise<number | null> {
    const wiki = await this.session.historyPart.repo('wiki');
    if (!wiki || !wiki.owned || samePath(wiki.root, projectRoot)) return null;
    const unsent = await unsentToTarget(wiki.git);
    return unsent === null ? null : unsent.size;
  }

  // `git.resolve`

  async previewResolve(role: RepoRole, path: string, side: MySide): Promise<CheckResult> {
    const plan = await this.planResolve(role, path);
    if ('ok' in plan) return plan;
    return {
      ok  : true,
      note:
        side === 'mine'
          ? `Keeps your version of ${path} and drops theirs.`
          : `Takes their version of ${path} and drops yours.`,
    };
  }

  /** Resolves one conflicted path to a side and stages it, in git's inverted words for a rebase. */
  async resolve(role: RepoRole, path: string, side: MySide): Promise<{ written: string[] }> {
    const plan = await this.planResolve(role, path);
    if ('ok' in plan) throw new Error(plan.reason);
    await plan.git.resolveSide(path, REBASE_SIDE[side]);
    return { written: [relPath(this.session.dir, join(plan.root, path))] };
  }

  private async planResolve(role: RepoRole, path: string): Promise<Owned | Refusal> {
    const repo = await this.stopped(role);
    if ('ok' in repo) return repo;
    const conflicted = await this.conflicted(repo.git);
    if (!conflicted.includes(path)) return refuse(`${path} is not waiting on a decision.`);
    return repo;
  }

  // `git.conflictText`

  /** The worktree copy of a path waiting on a decision, markers and all. */
  async conflictText(role: RepoRole, path: string): Promise<{ text: string }> {
    const plan = await this.planMarked(role, path);
    if ('ok' in plan) throw new Error(plan.reason);
    return { text: plan.text };
  }

  // `git.writeResolution`

  async previewWriteResolution(role: RepoRole, path: string, text: string): Promise<CheckResult> {
    const plan = await this.planWriteResolution(role, path, text);
    if ('ok' in plan) return plan;
    return { ok: true, note: `Writes ${path} as edited and marks it decided.` };
  }

  /**
   * Writes the author's merge of a conflicted path over the worktree copy and stages it, so
   * Continue sees a decided file. A scene and anything that is not markdown are written verbatim;
   * a markdown document goes through the whole-file writer, as `git.restoreFile` does.
   */
  async writeResolution(
    role: RepoRole,
    path: string,
    text: string,
  ): Promise<{ written: string[] }> {
    const plan = await this.planWriteResolution(role, path, text);
    if ('ok' in plan) throw new Error(plan.reason);
    const abs = join(plan.root, path);
    const rel = relPath(this.session.dir, abs);
    if (SCENE_PATH.test(path) || !path.endsWith('.md')) {
      await writeFileAtomic(abs, text);
      await fileCache.note(abs, text);
    } else {
      const existing = await readDocFile(this.session.dir, rel);
      const seen = existing.ok ? existing.file.hash : '';
      const written = await writeDocFile(this.session.dir, rel, text, seen, DOC_WRITERS);
      if (!written.ok) throw new Error(written.reason);
      await fileCache.note(written.file, text);
    }
    await plan.git.add([path]);
    return { written: [rel] };
  }

  private async planWriteResolution(
    role: RepoRole,
    path: string,
    text: string,
  ): Promise<(Owned & { text: string }) | Refusal> {
    const plan = await this.planMarked(role, path);
    if ('ok' in plan) return plan;
    const problem = resolutionProblem(path, text);
    if (problem !== undefined) return refuse(problem);
    return plan;
  }

  /** The repository with `path` waiting on a decision and git's markers in its worktree copy. */
  private async planMarked(
    role: RepoRole,
    path: string,
  ): Promise<(Owned & { text: string }) | Refusal> {
    const repo = await this.planResolve(role, path);
    if ('ok' in repo) return repo;
    const text = await readFile(join(repo.root, path), 'utf8').catch(() => null);
    if (text === null || !readableConflict(path) || !hasConflictMarkers(text)) {
      return refuse(`${path} was not merged line by line; keep a side instead.`);
    }
    return { ...repo, text };
  }

  // `git.undoResolution`

  async previewUndoResolution(role: RepoRole, path: string): Promise<CheckResult> {
    const plan = await this.planUndoResolution(role, path);
    if ('ok' in plan) return plan;
    return { ok: true, note: `Puts ${path} back in question, both sides and the markers.` };
  }

  /** Recreates the conflict a decision replaced, from the index's memory of the two sides. */
  async undoResolution(role: RepoRole, path: string): Promise<{ written: string[] }> {
    const plan = await this.planUndoResolution(role, path);
    if ('ok' in plan) throw new Error(plan.reason);
    await plan.git.recreateConflict(path);
    return { written: [relPath(this.session.dir, join(plan.root, path))] };
  }

  private async planUndoResolution(role: RepoRole, path: string): Promise<Owned | Refusal> {
    const repo = await this.stopped(role);
    if ('ok' in repo) return repo;
    const decided = (await repo.git.resolvedPaths()).find((r) => r.path === path);
    if (!decided) return refuse(`${path} was not decided at this stop.`);
    if (decided.decision === 'removed') {
      return refuse(`${path} was removed; git cannot put a removed file back in question.`);
    }
    return repo;
  }

  // `git.continueSync`

  async previewContinue(role: RepoRole): Promise<CheckResult> {
    const plan = await this.planContinue(role);
    if ('ok' in plan) return plan;
    const { current, total } = plan.state.rebase!;
    return {
      ok  : true,
      note:
        current < total
          ? `Finishes save ${current} of ${total} and replays the next.`
          : `Finishes the last of ${plural(total, 'save')} being replayed.`,
    };
  }

  /**
   * Stages everything and continues the rebase, so edits made while the conflict view was up
   * ride into the replayed save. A completed rebase carries its rewrite table; one that stopped
   * again is returned as such.
   */
  async continueSync(role: RepoRole): Promise<SyncOutcome> {
    const plan = await this.planContinue(role);
    if ('ok' in plan) throw new Error(plan.reason);
    const { git, state } = plan;
    const { onto, origHead } = state.rebase!;
    await git.add(['-A']);
    const link = role === 'project' ? await this.baseLink(plan.root) : null;
    const completed = await this.replay(git, () => git.rebaseContinue(), link);
    this.session.historyPart.dropMemo();
    const none = nothing(role);
    if (!completed) {
      return { repos: [{ ...none, conflicted: await this.conflicted(git), finished: false }] };
    }
    if (origHead === null) return { repos: [none] };
    const done = await finishRebase(git, onto, origHead);
    return { repos: [{ ...none, replayed: done.replayed, rewrote: done.rewrote }] };
  }

  private async planContinue(role: RepoRole): Promise<(Owned & { state: InProgress }) | Refusal> {
    const repo = await this.stopped(role);
    if ('ok' in repo) return repo;
    const conflicted = await this.conflicted(repo.git);
    if (conflicted.length > 0) {
      return refuse(
        `${plural(conflicted.length, 'file')} still need${conflicted.length === 1 ? 's' : ''} a decision.`,
      );
    }
    const unfit = await this.unfitToCarry(repo);
    if (unfit !== null) return refuse(unfit);
    return repo;
  }

  /**
   * Why the replayed save could not carry the tree as it stands, or null: the first changed file
   * git merged line by line that still holds markers, or that its own kind refuses.
   */
  private async unfitToCarry(repo: Owned): Promise<string | null> {
    const entries = (await repo.git.status()).entries.filter((e) => readableConflict(e.path));
    for (const entry of entries) {
      const text = await readFile(join(repo.root, entry.path), 'utf8').catch(() => null);
      if (text === null) continue;
      if (hasConflictMarkers(text)) {
        return `${entry.path} still holds conflict markers; keep a side or edit them out first.`;
      }
      const problem = resolutionProblem(entry.path, text);
      if (problem !== undefined) return problem;
    }
    return null;
  }

  // `git.abandonSync`

  async previewAbandon(role: RepoRole): Promise<CheckResult> {
    const plan = await this.planAbandon(role);
    if ('ok' in plan) return plan;
    return {
      ok  : true,
      note:
        plan.operation === 'rebase'
          ? 'Puts your saves back exactly as they were before getting theirs.'
          : `Abandons the ${plan.operation} and puts every file back as it was.`,
    };
  }

  async abandonSync(role: RepoRole): Promise<{ operation: 'rebase' | 'merge' | 'revert' }> {
    const plan = await this.planAbandon(role);
    if ('ok' in plan) throw new Error(plan.reason);
    if (plan.operation === 'rebase') await plan.git.rebaseAbort();
    else if (plan.operation === 'merge') await plan.git.mergeAbort();
    else await plan.git.revertAbort();
    this.session.historyPart.dropMemo();
    return { operation: plan.operation };
  }

  private async planAbandon(
    role: RepoRole,
  ): Promise<(Owned & { operation: 'rebase' | 'merge' | 'revert' }) | Refusal> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const state = await repo.git.inProgress();
    const operation = state.rebase
      ? 'rebase'
      : state.merge
        ? 'merge'
        : state.revert
          ? 'revert'
          : null;
    if (operation === null) return refuse(NOTHING_TO_ABANDON);
    return { ...repo, operation };
  }

  // Shared

  /** The repository with a rebase stopped in it, or the refusal. */
  private async stopped(role: RepoRole): Promise<(Owned & { state: InProgress }) | Refusal> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const state = await repo.git.inProgress();
    if (!state.rebase) return refuse(NO_SYNC_STOPPED);
    return { ...repo, state };
  }

  private async conflicted(git: Git): Promise<string[]> {
    return (await git.branchStatus()).entries.filter((e) => e.unmerged).map((e) => e.path);
  }

  /** Runs a network verb, and rethrows git's own sentence when the remote refused. */
  private async network<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GitError) throw new Error(remoteSentence(err.message));
      throw err;
    }
  }
}

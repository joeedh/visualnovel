import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CheckResult } from '@vn/commands';
import { resolutionProblem } from '@vn/model';
import { hasConflictMarkers } from '@vn/util';
import { finishRebase, type InProgress } from '@vn/git';
import { readableConflict, type RepoRole, type SyncOutcome } from '../../../shared/history.js';
import type { WorkspaceSession } from '../core.js';
import { baseLink, replay } from './rebase.js';
import {
  conflicted,
  nothing,
  plural,
  refuse,
  stopped,
  writable,
  type Owned,
  type Refusal,
} from './shared.js';

/** What `git.abandonSync` says when there is nothing to abandon. */
export const NOTHING_TO_ABANDON = 'Nothing is part way through; there is nothing to give up.';

// `git.continueSync`

export async function previewContinue(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<CheckResult> {
  const plan = await planContinue(session, role);
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
export async function continueSync(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<SyncOutcome> {
  const plan = await planContinue(session, role);
  if ('ok' in plan) throw new Error(plan.reason);
  const { git, state } = plan;
  const { onto, origHead } = state.rebase!;
  await git.add(['-A']);
  const link = role === 'project' ? await baseLink(session, plan.root) : null;
  const completed = await replay(git, () => git.rebaseContinue(), link);
  session.historyPart.dropMemo();
  const none = nothing(role);
  if (!completed) {
    return { repos: [{ ...none, conflicted: await conflicted(git), finished: false }] };
  }
  if (origHead === null) return { repos: [none] };
  const done = await finishRebase(git, onto, origHead);
  return { repos: [{ ...none, replayed: done.replayed, rewrote: done.rewrote }] };
}

async function planContinue(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<(Owned & { state: InProgress }) | Refusal> {
  const repo = await stopped(session, role);
  if ('ok' in repo) return repo;
  const stoppedPaths = await conflicted(repo.git);
  if (stoppedPaths.length > 0) {
    return refuse(
      `${plural(stoppedPaths.length, 'file')} still need${stoppedPaths.length === 1 ? 's' : ''} a decision.`,
    );
  }
  const unfit = await unfitToCarry(repo);
  if (unfit !== null) return refuse(unfit);
  return repo;
}

/**
 * Why the replayed save could not carry the tree as it stands, or null: the first changed file
 * git merged line by line that still holds markers, or that its own kind refuses.
 */
async function unfitToCarry(repo: Owned): Promise<string | null> {
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

export async function previewAbandon(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<CheckResult> {
  const plan = await planAbandon(session, role);
  if ('ok' in plan) return plan;
  return {
    ok  : true,
    note:
      plan.operation === 'rebase'
        ? 'Puts your saves back exactly as they were before getting theirs.'
        : `Abandons the ${plan.operation} and puts every file back as it was.`,
  };
}

export async function abandonSync(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<{ operation: 'rebase' | 'merge' | 'revert' }> {
  const plan = await planAbandon(session, role);
  if ('ok' in plan) throw new Error(plan.reason);
  if (plan.operation === 'rebase') await plan.git.rebaseAbort();
  else if (plan.operation === 'merge') await plan.git.mergeAbort();
  else await plan.git.revertAbort();
  session.historyPart.dropMemo();
  return { operation: plan.operation };
}

async function planAbandon(
  session: WorkspaceSession,
  role: RepoRole,
): Promise<(Owned & { operation: 'rebase' | 'merge' | 'revert' }) | Refusal> {
  const repo = await writable(session, role);
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

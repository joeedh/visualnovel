import type { CheckResult } from '@vn/commands';
import { syncTarget, unsentToTarget } from '@vn/git';
import { samePath } from '@vn/util';
import { SYNC_UNFINISHED, type RepoRole } from '../../../shared/history.js';
import type { WorkspaceSession } from '../core.js';
import { network, plural, refuse, withRemote, type Owned, type Refusal } from './shared.js';

export async function previewPush(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<CheckResult> {
  const plan = await planPush(session, role, name);
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
export async function push(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<{ remote: string; sent: number | null }> {
  const plan = await planPush(session, role, name);
  if ('ok' in plan) throw new Error(plan.reason);
  await network(() => plan.git.push(plan.remote, plan.branch));
  if (plan.adopts) await plan.git.trackRemote(plan.branch, plan.remote);
  return { remote: plan.remote, sent: plan.ahead };
}

/**
 * Every refusal a push can earn: no such copy, a sync part way through, nothing to send, and
 * saves of theirs not yet got, which under a rebase is the one way the author's line can carry
 * them. The project is also refused while its story bible has unsent saves of its own, since
 * the project's history would then name a bible save the copy does not hold.
 */
async function planPush(
  session: WorkspaceSession,
  role: RepoRole,
  name: string,
): Promise<
  (Owned & { remote: string; branch: string; ahead: number | null; adopts: boolean }) | Refusal
> {
  const found = await withRemote(session, role, name, false);
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
    const held = await wikiUnsent(session, found.root);
    if (held !== null && held > 0) {
      return refuse(
        `The story bible has ${plural(held, 'save')} not yet sent; send those first, so the project does not name saves the copy lacks.`,
      );
    }
  }
  return { ...found, branch, ahead: counts?.ahead ?? null, adopts };
}

/** How many saves the story bible's own repository has not sent, or null when it has none nested here. */
async function wikiUnsent(session: WorkspaceSession, projectRoot: string): Promise<number | null> {
  const wiki = await session.historyPart.repo('wiki');
  if (!wiki || !wiki.owned || samePath(wiki.root, projectRoot)) return null;
  const unsent = await unsentToTarget(wiki.git);
  return unsent === null ? null : unsent.size;
}

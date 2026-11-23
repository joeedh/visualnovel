/**
 * The writes behind the `git.*` sync commands: the shared copies a repository has, getting a
 * collaborator's saves, sending the author's, and the three acts that finish or abandon a sync
 * that stopped on a collision. Each has a preview, which is the command's `check`, and a run that
 * repeats the preview first. The rules are `@vn/git`'s; git's own sentence is what a refusal from
 * the network says.
 */
import type { CheckResult } from '@vn/commands';
import type { MySide } from '@vn/git';
import type { RepoRole, SyncOutcome } from '../../shared/history.js';
import type { WorkspaceSession } from './core.js';
import * as conflicts from './sync/conflicts.js';
import * as finish from './sync/finish.js';
import * as pulls from './sync/pull.js';
import * as pushes from './sync/push.js';
import * as remotes from './sync/remotes.js';

export { NO_SYNC_STOPPED } from './sync/shared.js';
export { NOTHING_TO_ABANDON } from './sync/finish.js';
export { BASE_DIRTY, BASE_UNFINISHED } from './sync/pull.js';

export class SyncPart {
  constructor(private readonly session: WorkspaceSession) {}

  // `git.addRemote`

  previewAddRemote(role: RepoRole, name: string, url: string): Promise<CheckResult> {
    return remotes.previewAddRemote(this.session, role, name, url);
  }

  addRemote(role: RepoRole, name: string, url: string): Promise<{ syncsWith: boolean }> {
    return remotes.addRemote(this.session, role, name, url);
  }

  // `git.removeRemote`

  previewRemoveRemote(role: RepoRole, name: string): Promise<CheckResult> {
    return remotes.previewRemoveRemote(this.session, role, name);
  }

  removeRemote(role: RepoRole, name: string): Promise<{ remote: string }> {
    return remotes.removeRemote(this.session, role, name);
  }

  // `git.setRemoteUrl`

  previewSetRemoteUrl(role: RepoRole, name: string, url: string): Promise<CheckResult> {
    return remotes.previewSetRemoteUrl(this.session, role, name, url);
  }

  setRemoteUrl(role: RepoRole, name: string, url: string): Promise<{ remote: string }> {
    return remotes.setRemoteUrl(this.session, role, name, url);
  }

  // `git.syncWith`

  previewSyncWith(role: RepoRole, name: string): Promise<CheckResult> {
    return remotes.previewSyncWith(this.session, role, name);
  }

  syncWith(role: RepoRole, name: string): Promise<{ remote: string; branch: string }> {
    return remotes.syncWith(this.session, role, name);
  }

  // `git.fetch`

  previewFetch(role: RepoRole, name: string): Promise<CheckResult> {
    return remotes.previewFetch(this.session, role, name);
  }

  fetch(role: RepoRole, name: string): Promise<{ remote: string; behind: number | null }> {
    return remotes.fetchRemote(this.session, role, name);
  }

  // `git.pull`

  previewPull(role: RepoRole): Promise<CheckResult> {
    return pulls.previewPull(this.session, role);
  }

  pull(role: RepoRole): Promise<SyncOutcome> {
    return pulls.pull(this.session, role);
  }

  // `git.push`

  previewPush(role: RepoRole, name: string): Promise<CheckResult> {
    return pushes.previewPush(this.session, role, name);
  }

  push(role: RepoRole, name: string): Promise<{ remote: string; sent: number | null }> {
    return pushes.push(this.session, role, name);
  }

  // `git.resolve`

  previewResolve(role: RepoRole, path: string, side: MySide): Promise<CheckResult> {
    return conflicts.previewResolve(this.session, role, path, side);
  }

  resolve(role: RepoRole, path: string, side: MySide): Promise<{ written: string[] }> {
    return conflicts.resolve(this.session, role, path, side);
  }

  // `git.conflictText`

  conflictText(role: RepoRole, path: string): Promise<{ text: string }> {
    return conflicts.conflictText(this.session, role, path);
  }

  // `git.writeResolution`

  previewWriteResolution(role: RepoRole, path: string, text: string): Promise<CheckResult> {
    return conflicts.previewWriteResolution(this.session, role, path, text);
  }

  writeResolution(role: RepoRole, path: string, text: string): Promise<{ written: string[] }> {
    return conflicts.writeResolution(this.session, role, path, text);
  }

  // `git.undoResolution`

  previewUndoResolution(role: RepoRole, path: string): Promise<CheckResult> {
    return conflicts.previewUndoResolution(this.session, role, path);
  }

  undoResolution(role: RepoRole, path: string): Promise<{ written: string[] }> {
    return conflicts.undoResolution(this.session, role, path);
  }

  // `git.continueSync`

  previewContinue(role: RepoRole): Promise<CheckResult> {
    return finish.previewContinue(this.session, role);
  }

  continueSync(role: RepoRole): Promise<SyncOutcome> {
    return finish.continueSync(this.session, role);
  }

  // `git.abandonSync`

  previewAbandon(role: RepoRole): Promise<CheckResult> {
    return finish.previewAbandon(this.session, role);
  }

  abandonSync(role: RepoRole): Promise<{ operation: 'rebase' | 'merge' | 'revert' }> {
    return finish.abandonSync(this.session, role);
  }
}

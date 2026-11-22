import type { Change, Checkpoint, Diff, HistoryEntry, MySide } from '@vn/git';
import type { CheckResult } from '@vn/commands';
import type {
  BlobRead,
  HistoryPage,
  RepoEntry,
  RepoRole,
  RepoStatus,
  SyncOutcome,
} from '../../../shared/history.js';
import type { HistoryPart, HistoryFilter } from '../history.js';
import type { RecoveryPart } from '../recovery.js';
import type { SyncPart } from '../sync.js';
import { PipelineSurface } from './pipeline.js';
export abstract class GitSurface extends PipelineSurface {
  abstract readonly historyPart: HistoryPart;
  abstract readonly recoveryPart: RecoveryPart;
  abstract readonly syncPart: SyncPart;

  async gitRepos(): Promise<RepoEntry[]> {
    return this.historyPart.repos();
  }

  async gitHistory(role: RepoRole, filter?: HistoryFilter): Promise<HistoryPage> {
    return this.historyPart.history(role, filter);
  }

  async gitChanges(role: RepoRole, sha: string): Promise<Change[]> {
    return this.historyPart.changes(role, sha);
  }

  async gitDiff(role: RepoRole, sha: string, path: string): Promise<Diff | null> {
    return this.historyPart.diff(role, sha, path);
  }

  async gitBlob(role: RepoRole, sha: string, path: string): Promise<BlobRead | null> {
    return this.historyPart.blob(role, sha, path);
  }

  /** The bytes behind one `vngit://` request. */
  async gitBytes(role: RepoRole, ref: string, path?: string): Promise<Buffer | null> {
    return this.historyPart.bytesAt(role, ref, path);
  }

  async gitStatus(role: RepoRole, pending: number): Promise<RepoStatus> {
    return this.historyPart.status(role, pending);
  }

  previewSave(role: RepoRole): Promise<CheckResult> {
    return this.recoveryPart.previewSave(role);
  }

  gitSave(role: RepoRole): Promise<{ saved: boolean }> {
    return this.recoveryPart.save(role);
  }

  previewCheckpoint(role: RepoRole, name: string, sha: string): Promise<CheckResult> {
    return this.recoveryPart.previewCheckpoint(role, name, sha);
  }

  gitCheckpoint(
    role: RepoRole,
    name: string,
    sha: string,
    note: string,
  ): Promise<{ entry: HistoryEntry; slug: string; name: string }> {
    return this.recoveryPart.checkpoint(role, name, sha, note);
  }

  previewDropCheckpoint(role: RepoRole, name: string): Promise<CheckResult> {
    return this.recoveryPart.previewDropCheckpoint(role, name);
  }

  gitDropCheckpoint(role: RepoRole, name: string): Promise<Checkpoint> {
    return this.recoveryPart.dropCheckpoint(role, name);
  }

  previewTakeBack(role: RepoRole, sha: string): Promise<CheckResult> {
    return this.recoveryPart.previewTakeBack(role, sha);
  }

  gitTakeBack(role: RepoRole, sha: string): Promise<{ entry: HistoryEntry; written: string[] }> {
    return this.recoveryPart.takeBack(role, sha);
  }

  previewGoBack(role: RepoRole, sha: string): Promise<CheckResult> {
    return this.recoveryPart.previewGoBack(role, sha);
  }

  gitGoBack(
    role: RepoRole,
    sha: string,
  ): Promise<{ entry: HistoryEntry; written: string[]; checkpoint?: string }> {
    return this.recoveryPart.goBack(role, sha);
  }

  previewRestoreFile(role: RepoRole, sha: string, path: string): Promise<CheckResult> {
    return this.recoveryPart.previewRestore(role, sha, path);
  }

  gitRestoreFile(
    role: RepoRole,
    sha: string,
    path: string,
  ): Promise<{ path: string; diagnostic?: string }> {
    return this.recoveryPart.restoreFile(role, sha, path);
  }

  previewAddRemote(role: RepoRole, name: string, url: string): Promise<CheckResult> {
    return this.syncPart.previewAddRemote(role, name, url);
  }

  gitAddRemote(role: RepoRole, name: string, url: string): Promise<{ syncsWith: boolean }> {
    return this.syncPart.addRemote(role, name, url);
  }

  previewRemoveRemote(role: RepoRole, name: string): Promise<CheckResult> {
    return this.syncPart.previewRemoveRemote(role, name);
  }

  gitRemoveRemote(role: RepoRole, name: string): Promise<{ remote: string }> {
    return this.syncPart.removeRemote(role, name);
  }

  previewSetRemoteUrl(role: RepoRole, name: string, url: string): Promise<CheckResult> {
    return this.syncPart.previewSetRemoteUrl(role, name, url);
  }

  gitSetRemoteUrl(role: RepoRole, name: string, url: string): Promise<{ remote: string }> {
    return this.syncPart.setRemoteUrl(role, name, url);
  }

  previewSyncWith(role: RepoRole, name: string): Promise<CheckResult> {
    return this.syncPart.previewSyncWith(role, name);
  }

  gitSyncWith(role: RepoRole, name: string): Promise<{ remote: string; branch: string }> {
    return this.syncPart.syncWith(role, name);
  }

  previewFetch(role: RepoRole, remote: string): Promise<CheckResult> {
    return this.syncPart.previewFetch(role, remote);
  }

  gitFetch(role: RepoRole, remote: string): Promise<{ remote: string; behind: number | null }> {
    return this.syncPart.fetch(role, remote);
  }

  previewPull(role: RepoRole): Promise<CheckResult> {
    return this.syncPart.previewPull(role);
  }

  gitPull(role: RepoRole): Promise<SyncOutcome> {
    return this.syncPart.pull(role);
  }

  previewPush(role: RepoRole, remote: string): Promise<CheckResult> {
    return this.syncPart.previewPush(role, remote);
  }

  gitPush(role: RepoRole, remote: string): Promise<{ remote: string; sent: number | null }> {
    return this.syncPart.push(role, remote);
  }

  previewResolve(role: RepoRole, path: string, side: MySide): Promise<CheckResult> {
    return this.syncPart.previewResolve(role, path, side);
  }

  gitResolve(role: RepoRole, path: string, side: MySide): Promise<{ written: string[] }> {
    return this.syncPart.resolve(role, path, side);
  }

  gitConflictText(role: RepoRole, path: string): Promise<{ text: string }> {
    return this.syncPart.conflictText(role, path);
  }

  previewWriteResolution(role: RepoRole, path: string, text: string): Promise<CheckResult> {
    return this.syncPart.previewWriteResolution(role, path, text);
  }

  gitWriteResolution(role: RepoRole, path: string, text: string): Promise<{ written: string[] }> {
    return this.syncPart.writeResolution(role, path, text);
  }

  previewUndoResolution(role: RepoRole, path: string): Promise<CheckResult> {
    return this.syncPart.previewUndoResolution(role, path);
  }

  gitUndoResolution(role: RepoRole, path: string): Promise<{ written: string[] }> {
    return this.syncPart.undoResolution(role, path);
  }

  previewContinueSync(role: RepoRole): Promise<CheckResult> {
    return this.syncPart.previewContinue(role);
  }

  gitContinueSync(role: RepoRole): Promise<SyncOutcome> {
    return this.syncPart.continueSync(role);
  }

  previewAbandonSync(role: RepoRole): Promise<CheckResult> {
    return this.syncPart.previewAbandon(role);
  }

  gitAbandonSync(role: RepoRole): Promise<{ operation: 'rebase' | 'merge' | 'revert' }> {
    return this.syncPart.abandonSync(role);
  }
}

/**
 * The writes behind the `git.*` recovery commands: save, checkpoint, take a save back, go back
 * to one, and bring one file back. Each has a preview, which is the command's `check`, and a run
 * that repeats the preview first, since the tree may have moved between the two. The rules are
 * `@vn/git`'s, shared with the agent's tools, so a refusal reads the same from either.
 */
import { join } from 'node:path';
import type { CheckResult } from '@vn/commands';
import {
  checkpointNamed,
  dirtyOutsideLogs,
  previewCheckpoint,
  previewGoBack,
  previewTakeBack,
  type Checkpoint,
  type Git,
  type HistoryEntry,
} from '@vn/git';
import { sceneLoadProblem } from '@vn/model';
import { checkDocWrite, inSecretsDir, readDocFile, SECRETS_REFUSAL, writeDocFile } from '@vn/store';
import { writeFileAtomic } from '@vn/util';
import { ANY_DOCUMENT, UNDO_EXCLUDES, covers } from '../../shared/affects.js';
import { NOT_OWNED, type RepoRole } from '../../shared/history.js';
import { syncRefusal } from '../commands/syncstate.js';
import { fileCache } from '../workspace/filecache.js';
import { DOC_WRITERS, entityDiagnostic, relPath } from './core.js';
import type { WorkspaceSession } from './core.js';
import { isText } from './history.js';

/** What `git.save` says over a tree with nothing to save. */
export const NOTHING_CHANGED = 'Nothing has changed since the last save.';

const SESSION_FILE = '.vnstudio/session.json';

const SCENE_PATH = /^scenes\/([^/]+)\.md$/;

type Refusal = { ok: false; reason: string };

const refuse = (reason: string): Refusal => ({ ok: false, reason });

const short = (sha: string): string => sha.slice(0, 7);

/** A repository the app may write history in. */
interface Owned {
  git: Git;
  root: string;
}

/** What one restore would write: the file, its text, and how it is validated. */
interface RestorePlan {
  /** Workspace-relative, forward-slashed. */
  path: string;
  abs: string;
  text: string;
  scene: boolean;
  note: string;
}

export class RecoveryPart {
  constructor(private readonly session: WorkspaceSession) {}

  /** The repository in `role`, or the refusal every write shares: busy, then not owned. */
  private async writable(role: RepoRole, checkBusy = true): Promise<Owned | Refusal> {
    const busy = checkBusy ? this.session.busy() : undefined;
    if (busy) return refuse(`${busy} is still running; wait for it to finish.`);
    const found = await this.session.historyPart.repo(role);
    if (!found) return refuse(`This project has no ${role} repository.`);
    if (!found.owned) return refuse(NOT_OWNED);
    return { git: found.git, root: found.root };
  }

  /** A repository path as the workspace names it. */
  private wsPath(root: string, path: string): string {
    return relPath(this.session.dir, join(root, path));
  }

  // `git.save`

  async previewSave(role: RepoRole): Promise<CheckResult> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const syncing = await syncRefusal(repo.git);
    if (syncing) return refuse(syncing);
    if (!(await dirtyOutsideLogs(repo.git))) return refuse(NOTHING_CHANGED);
    const changed = (await repo.git.status()).entries.length;
    return {
      ok  : true,
      note: `Saves ${changed} changed file${changed === 1 ? '' : 's'} under this message.`,
    };
  }

  /**
   * Nothing is written here: commit-on-save commits the dirty tree once the command returns. A
   * tree found clean is not refused, since the edits it held may have been committed by the flush
   * that runs ahead of every act.
   */
  async save(role: RepoRole): Promise<{ saved: boolean }> {
    const repo = await this.writable(role);
    if ('ok' in repo) throw new Error(repo.reason);
    const syncing = await syncRefusal(repo.git);
    if (syncing) throw new Error(syncing);
    return { saved: await dirtyOutsideLogs(repo.git) };
  }

  // `git.checkpoint`

  async previewCheckpoint(role: RepoRole, name: string, sha: string): Promise<CheckResult> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const preview = await previewCheckpoint(repo.git, name, sha || 'HEAD');
    return preview.ok ? { ok: true, note: preview.note } : preview;
  }

  async checkpoint(
    role: RepoRole,
    name: string,
    sha: string,
    note: string,
  ): Promise<{ entry: HistoryEntry; slug: string; name: string }> {
    const repo = await this.writable(role);
    if ('ok' in repo) throw new Error(repo.reason);
    const preview = await previewCheckpoint(repo.git, name, sha || 'HEAD');
    if (!preview.ok) throw new Error(preview.reason);
    const trimmed = name.trim();
    const body = note.trim();
    await repo.git.tag(preview.slug, preview.entry.sha, body ? `${trimmed}\n\n${body}` : trimmed);
    return { entry: preview.entry, slug: preview.slug, name: trimmed };
  }

  // `git.dropCheckpoint`

  async previewDropCheckpoint(role: RepoRole, name: string): Promise<CheckResult> {
    const found = await this.findCheckpoint(role, name);
    if ('ok' in found) return found;
    return {
      ok  : true,
      note: `Drops the name “${found.checkpoint.name}”; the save it marks stays.`,
    };
  }

  async dropCheckpoint(role: RepoRole, name: string): Promise<Checkpoint> {
    const found = await this.findCheckpoint(role, name);
    if ('ok' in found) throw new Error(found.reason);
    await found.git.deleteTag(found.checkpoint.slug);
    return found.checkpoint;
  }

  /** The checkpoint `name` names in `role`. Not gated on busy: a tag touches no running work. */
  private async findCheckpoint(
    role: RepoRole,
    name: string,
  ): Promise<(Owned & { checkpoint: Checkpoint }) | Refusal> {
    const repo = await this.writable(role, false);
    if ('ok' in repo) return repo;
    const checkpoint = checkpointNamed(await repo.git.checkpoints(), name);
    if (!checkpoint) return refuse(`No checkpoint named “${name.trim()}”.`);
    return { ...repo, checkpoint };
  }

  // `git.takeBack`

  async previewTakeBack(role: RepoRole, sha: string): Promise<CheckResult> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const syncing = await syncRefusal(repo.git);
    if (syncing) return refuse(syncing);
    const preview = await previewTakeBack(repo.git, sha);
    return preview.ok ? { ok: true, note: preview.note } : preview;
  }

  /**
   * Reverses one save in the worktree and leaves it there for commit-on-save. A revert that does
   * not apply is undone in `revertIntoTree` before it returns, so the tree is never left mid-revert.
   */
  async takeBack(role: RepoRole, sha: string): Promise<{ entry: HistoryEntry; written: string[] }> {
    const repo = await this.writable(role);
    if ('ok' in repo) throw new Error(repo.reason);
    const syncing = await syncRefusal(repo.git);
    if (syncing) throw new Error(syncing);
    const preview = await previewTakeBack(repo.git, sha);
    if (!preview.ok) throw new Error(preview.reason);
    if (!(await repo.git.revertIntoTree(preview.entry.sha))) {
      throw new Error('Taking this save back did not apply cleanly; nothing was changed.');
    }
    const written = preview.entry.files.flatMap((f) =>
      [f.path, ...(f.oldPath ? [f.oldPath] : [])].map((p) => this.wsPath(repo.root, p)),
    );
    return { entry: preview.entry, written };
  }

  // `git.goBack`

  async previewGoBack(role: RepoRole, sha: string): Promise<CheckResult> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const syncing = await syncRefusal(repo.git);
    if (syncing) return refuse(syncing);
    const preview = await previewGoBack(repo.git, sha);
    return preview.ok ? { ok: true, note: preview.note } : preview;
  }

  /**
   * Puts the whole worktree back to how it was at `sha`, and leaves it there for commit-on-save.
   * `checkpoint` is the name the save carries, if any, for the new save's subject.
   */
  async goBack(
    role: RepoRole,
    sha: string,
  ): Promise<{ entry: HistoryEntry; written: string[]; checkpoint?: string }> {
    const repo = await this.writable(role);
    if ('ok' in repo) throw new Error(repo.reason);
    const syncing = await syncRefusal(repo.git);
    if (syncing) throw new Error(syncing);
    const preview = await previewGoBack(repo.git, sha);
    if (!preview.ok) throw new Error(preview.reason);
    const [from, to, checkpoints] = await Promise.all([
      repo.git.treeOf('HEAD'),
      repo.git.treeOf(preview.entry.sha),
      repo.git.checkpoints(),
    ]);
    await repo.git.applyTree(from, to);
    const checkpoint = checkpoints.find((c) => c.sha === preview.entry.sha)?.name;
    return {
      entry  : preview.entry,
      written: preview.paths.map((p) => this.wsPath(repo.root, p)),
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  // `git.restoreFile`

  async previewRestore(role: RepoRole, sha: string, path: string): Promise<CheckResult> {
    const plan = await this.planRestore(role, sha, path);
    return plan.ok ? { ok: true, note: plan.note } : plan;
  }

  /**
   * Writes one file as it was at `sha` over the working copy, through the same path a whole-file
   * save takes, so the write is hashed, cached and snapshotted like an author's own. A scene is
   * checked against the model first and then written verbatim, since `scenes/` has no whole-file
   * writer of its own.
   */
  async restoreFile(
    role: RepoRole,
    sha: string,
    path: string,
  ): Promise<{ path: string; diagnostic?: string }> {
    const plan = await this.planRestore(role, sha, path);
    if (!plan.ok) throw new Error(plan.reason);
    if (plan.scene) {
      await writeFileAtomic(plan.abs, plan.text);
      await fileCache.note(plan.abs, plan.text);
      return { path: plan.path };
    }
    const existing = await readDocFile(this.session.dir, plan.path);
    const seen = existing.ok ? existing.file.hash : '';
    const written = await writeDocFile(this.session.dir, plan.path, plan.text, seen, DOC_WRITERS);
    if (!written.ok) throw new Error(written.reason);
    await fileCache.note(written.file, plan.text);
    const diagnostic = entityDiagnostic(written.path, written.doc);
    return { path: plan.path, ...(diagnostic ? { diagnostic } : {}) };
  }

  /**
   * Every refusal a restore can earn, decided without writing: a sync part way (an undoable
   * write mid-rebase would be undone into a committed tree), a credential, the session file, a
   * cache the app rebuilds, a path the app does not write, a file the save does not hold, one
   * that is not text, a scene the model would reject, and everything `checkDocWrite` refuses.
   */
  private async planRestore(
    role: RepoRole,
    sha: string,
    path: string,
  ): Promise<({ ok: true } & RestorePlan) | Refusal> {
    const repo = await this.writable(role);
    if ('ok' in repo) return repo;
    const syncing = await syncRefusal(repo.git);
    if (syncing) return refuse(syncing);
    const rel = this.wsPath(repo.root, path);
    if (rel.startsWith('..')) return refuse(`${path} is outside the project.`);
    if (inSecretsDir(rel)) return refuse(SECRETS_REFUSAL);
    if (rel === SESSION_FILE)
      return refuse('The window layout is not a document; it is not brought back.');
    if (UNDO_EXCLUDES.some((dir) => covers([dir], rel))) {
      return refuse(
        `${rel} is something the app rebuilds, not a document; it is not brought back this way.`,
      );
    }
    if (!covers(ANY_DOCUMENT, rel)) return refuse(`${rel} is not a document the app writes.`);
    const resolved = await repo.git.resolve(sha);
    if (resolved === null) return refuse(`No save ${short(sha)} in this repository.`);
    const bytes = await repo.git.blob(resolved, path);
    if (bytes === null) return refuse(`That save has no ${path}.`);
    if (!isText(bytes))
      return refuse(`${rel} is not text; only a text file is brought back this way.`);
    const text = bytes.toString('utf8');
    const abs = join(this.session.dir, rel);
    const scene = SCENE_PATH.exec(rel);
    if (scene) {
      const problem = sceneLoadProblem(scene[1]!, text);
      if (problem !== undefined) return refuse(`${rel} as it was then would not load: ${problem}`);
      const now = await readDocFile(this.session.dir, rel);
      if (now.ok && now.file.text === text)
        return refuse(`${rel} already reads as it did at that save.`);
      return {
        ok  : true,
        path: rel,
        abs,
        text,
        scene: true,
        note : `Rewrites ${rel} as it was at save ${short(sha)}.`,
      };
    }
    const existing = await readDocFile(this.session.dir, rel);
    const seen = existing.ok ? existing.file.hash : '';
    const plan = await checkDocWrite(this.session.dir, rel, text, seen, DOC_WRITERS);
    if (!plan.ok) return plan;
    if (existing.ok && existing.file.hash === plan.hash) {
      return refuse(`${rel} already reads as it did at that save.`);
    }
    const verb = existing.ok ? 'Rewrites' : 'Brings back';
    return {
      ok  : true,
      path: rel,
      abs,
      text,
      scene: false,
      note : `${verb} ${rel} as it was at save ${short(sha)}.`,
    };
  }
}

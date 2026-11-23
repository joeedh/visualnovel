import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CheckResult } from '@vn/commands';
import { resolutionProblem } from '@vn/model';
import { readDocFile, writeDocFile } from '@vn/store';
import { hasConflictMarkers, writeFileAtomic } from '@vn/util';
import { REBASE_SIDE, type MySide } from '@vn/git';
import { readableConflict, type RepoRole } from '../../../shared/history.js';
import { fileCache } from '../../workspace/filecache.js';
import { DOC_WRITERS } from '../rules/docs.js';
import { relPath } from '../load/tree.js';
import type { WorkspaceSession } from '../core.js';
import { conflicted, refuse, stopped, type Owned, type Refusal } from './shared.js';

const SCENE_PATH = /^scenes\/[^/]+\.md$/;

// `git.resolve`

export async function previewResolve(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
  side: MySide,
): Promise<CheckResult> {
  const plan = await planResolve(session, role, path);
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
export async function resolve(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
  side: MySide,
): Promise<{ written: string[] }> {
  const plan = await planResolve(session, role, path);
  if ('ok' in plan) throw new Error(plan.reason);
  await plan.git.resolveSide(path, REBASE_SIDE[side]);
  return { written: [relPath(session.dir, join(plan.root, path))] };
}

async function planResolve(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
): Promise<Owned | Refusal> {
  const repo = await stopped(session, role);
  if ('ok' in repo) return repo;
  const stoppedPaths = await conflicted(repo.git);
  if (!stoppedPaths.includes(path)) return refuse(`${path} is not waiting on a decision.`);
  return repo;
}

// `git.conflictText`

/** The worktree copy of a path waiting on a decision, markers and all. */
export async function conflictText(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
): Promise<{ text: string }> {
  const plan = await planMarked(session, role, path);
  if ('ok' in plan) throw new Error(plan.reason);
  return { text: plan.text };
}

// `git.writeResolution`

export async function previewWriteResolution(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
  text: string,
): Promise<CheckResult> {
  const plan = await planWriteResolution(session, role, path, text);
  if ('ok' in plan) return plan;
  return { ok: true, note: `Writes ${path} as edited and marks it decided.` };
}

/**
 * Writes the author's merge of a conflicted path over the worktree copy and stages it, so
 * Continue sees a decided file. A scene and anything that is not markdown are written verbatim;
 * a markdown document goes through the whole-file writer, as `git.restoreFile` does.
 */
export async function writeResolution(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
  text: string,
): Promise<{ written: string[] }> {
  const plan = await planWriteResolution(session, role, path, text);
  if ('ok' in plan) throw new Error(plan.reason);
  const abs = join(plan.root, path);
  const rel = relPath(session.dir, abs);
  if (SCENE_PATH.test(path) || !path.endsWith('.md')) {
    await writeFileAtomic(abs, text);
    await fileCache.note(abs, text);
  } else {
    const existing = await readDocFile(session.dir, rel);
    const seen = existing.ok ? existing.file.hash : '';
    const written = await writeDocFile(session.dir, rel, text, seen, DOC_WRITERS);
    if (!written.ok) throw new Error(written.reason);
    await fileCache.note(written.file, text);
  }
  await plan.git.add([path]);
  return { written: [rel] };
}

async function planWriteResolution(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
  text: string,
): Promise<(Owned & { text: string }) | Refusal> {
  const plan = await planMarked(session, role, path);
  if ('ok' in plan) return plan;
  const problem = resolutionProblem(path, text);
  if (problem !== undefined) return refuse(problem);
  return plan;
}

/** The repository with `path` waiting on a decision and git's markers in its worktree copy. */
async function planMarked(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
): Promise<(Owned & { text: string }) | Refusal> {
  const repo = await planResolve(session, role, path);
  if ('ok' in repo) return repo;
  const text = await readFile(join(repo.root, path), 'utf8').catch(() => null);
  if (text === null || !readableConflict(path) || !hasConflictMarkers(text)) {
    return refuse(`${path} was not merged line by line; keep a side instead.`);
  }
  return { ...repo, text };
}

// `git.undoResolution`

export async function previewUndoResolution(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
): Promise<CheckResult> {
  const plan = await planUndoResolution(session, role, path);
  if ('ok' in plan) return plan;
  return { ok: true, note: `Puts ${path} back in question, both sides and the markers.` };
}

/** Recreates the conflict a decision replaced, from the index's memory of the two sides. */
export async function undoResolution(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
): Promise<{ written: string[] }> {
  const plan = await planUndoResolution(session, role, path);
  if ('ok' in plan) throw new Error(plan.reason);
  await plan.git.recreateConflict(path);
  return { written: [relPath(session.dir, join(plan.root, path))] };
}

async function planUndoResolution(
  session: WorkspaceSession,
  role: RepoRole,
  path: string,
): Promise<Owned | Refusal> {
  const repo = await stopped(session, role);
  if ('ok' in repo) return repo;
  const decided = (await repo.git.resolvedPaths()).find((r) => r.path === path);
  if (!decided) return refuse(`${path} was not decided at this stop.`);
  if (decided.decision === 'removed') {
    return refuse(`${path} was removed; git cannot put a removed file back in question.`);
  }
  return repo;
}

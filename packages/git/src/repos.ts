/**
 * Which repository owns a path — the multi-repo seam (`docs/plans/archive/repo-map-and-commit-on-save.md`).
 *
 * A project's story bible or base assets may each be their own repo, so nothing may assume one
 * root. The map is **discovered, not declared**: `git rev-parse --show-toplevel` is git's own
 * answer, so it handles worktrees, `.git` files and ceiling directories, and it gets the case
 * that matters right for free — git does not descend into a nested repository, so a `wiki/.git`
 * really is not the project repo's business.
 *
 * Mechanism only. Which roles exist, when to commit, and what to do with a path that belongs to
 * no repo are all the host's business.
 */
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Git } from './git.js';

/** The nearest ancestor of `path` that exists and is a directory, or null. */
async function nearestDir(path: string): Promise<string | null> {
  let current = resolve(path);
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // Missing: a path about to be written. Ask its parent instead.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export class RepoResolver {
  /** Directory → owning repo root, or null for "asked, and it is in no work tree". */
  private readonly roots = new Map<string, string | null>();
  private readonly handles = new Map<string, Git>();

  /**
   * The repo root owning `path`, or null when it is in no work tree. A path that does not exist
   * yet is resolved against its nearest existing ancestor, so a file about to be created has an
   * owner before it has bytes.
   */
  async rootOf(path: string): Promise<string | null> {
    const dir = await nearestDir(path);
    if (dir === null) return null;
    const cached = this.roots.get(dir);
    if (cached !== undefined) return cached;

    const out = await new Git(dir).topLevel();
    const root = out === null ? null : resolve(out);
    this.roots.set(dir, root);
    return root;
  }

  /** A handle on the repo owning `path`, memoized per root so two paths share one. */
  async gitFor(path: string): Promise<Git | null> {
    const root = await this.rootOf(path);
    if (root === null) return null;
    let git = this.handles.get(root);
    if (!git) this.handles.set(root, (git = new Git(root)));
    return git;
  }

  /** A handle on `root` itself, memoized alongside the resolved ones. */
  open(root: string): Git {
    const key = resolve(root);
    let git = this.handles.get(key);
    if (!git) this.handles.set(key, (git = new Git(key)));
    return git;
  }

  /**
   * Partition paths by owning root. Paths in no work tree are grouped under `null` rather than
   * dropped — a caller that ignores them should do so knowingly.
   */
  async group(paths: string[]): Promise<Map<string | null, string[]>> {
    const groups = new Map<string | null, string[]>();
    for (const path of paths) {
      const root = await this.rootOf(path);
      const bucket = groups.get(root);
      if (bucket) bucket.push(path);
      else groups.set(root, [path]);
    }
    return groups;
  }

  /**
   * Drop the cache. Needed after `git init`: the resolver remembers "no repo here" for a
   * directory that now has one, and nothing else would tell it otherwise.
   */
  forget(): void {
    this.roots.clear();
    this.handles.clear();
  }
}

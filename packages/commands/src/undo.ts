/**
 * Shadow snapshots for the command stack — `docs/history/gitUndoOptions.md` strategies D + E.
 *
 * Before and after every undoable command the journal captures the **document** tree into a
 * detached commit under `refs/vn/undo/<seq>/`. HEAD does not move, the index is not touched,
 * and nothing shows up in `git log`/`branch`/`status` or is ever pushed — though they are real
 * commits and `git log --all` does see them. Undo moves the working copy back to the `pre`
 * tree; redo moves it to the `post` tree.
 *
 * A project may span repos (the story bible or base assets in their own), so a journal holds
 * several: one act, one `seq`, one snapshot pair **per repo**. Drift is checked across all of
 * them before any is restored, so the common failure — a file edited in another editor — is a
 * clean refusal rather than a half-restore.
 *
 * Two things it deliberately does not do. It does not snapshot generated output — `paths`
 * excludes `build/` and `state/`, because assets are content-addressed and immutable and
 * "undoing" them would mean deleting bytes a later run would pay to regenerate. And it never
 * guesses: if the working copy is not where the record says it left it, `check` refuses and
 * says so rather than restoring over an edit nobody asked it to discard.
 */
import type { Git } from '@vn/git';

export interface UndoJournalOptions {
  /**
   * The repos an act may touch. The first is the **primary** — the project — and is the one
   * `Snapshot`'s bare `commit`/`tree` refer to, so a single-repo journal reads exactly as it
   * did before multi-repo existed.
   */
  git: Git | Git[];
  /**
   * Git pathspec bounding a snapshot — the document class. Callers pass their own exclusions,
   * e.g. `['.', ':(exclude)vngen/build', ':(exclude)vngen/state']`.
   */
  paths?: string[];
  /** How many commands' snapshots to keep. Older refs are dropped so `gc` can reclaim them. */
  keep?: number;
}

/** A captured document tree and the ref keeping it alive. */
export interface Snapshot {
  /** The primary repo's commit sha, as recorded on `CommandRecord.undo`. */
  commit: string;
  tree: string;
  /** Every repo that had something to snapshot, keyed by root. Includes the primary. */
  repos: Record<string, { commit: string; tree: string }>;
}

/**
 * What a record carries about one act's snapshots. `pre`/`post` are the primary repo's, so
 * history written before multi-repo stays readable and stays undoable.
 */
export interface UndoPoint {
  pre: string;
  post: string;
  /**
   * The two trees compared, not what the command claimed it wrote: false means the workspace
   * is provably identical either side, in every repo.
   */
  changed: boolean;
  /** Per-repo commit pairs, present only when an act spanned more than one repo. */
  repos?: Record<string, { pre: string; post: string }>;
}

const DEFAULT_KEEP = 50;
const REFS = 'refs/vn/undo';

export class UndoJournal {
  private readonly repos: Git[];
  private readonly paths: string[];
  private readonly keep: number;

  constructor(opts: UndoJournalOptions) {
    this.repos = Array.isArray(opts.git) ? opts.git : [opts.git];
    this.paths = opts.paths ?? ['.'];
    this.keep = opts.keep ?? DEFAULT_KEEP;
  }

  /**
   * Snapshot each repo's document tree and park it at `refs/vn/undo/<seq>/<label>`.
   *
   * Returns null when no repo has anything to snapshot into — the one case where undo is
   * simply unavailable rather than refused.
   */
  async capture(seq: number, label: 'pre' | 'post'): Promise<Snapshot | null> {
    const repos: Record<string, { commit: string; tree: string }> = {};
    let primary: { commit: string; tree: string } | null = null;
    for (const git of this.repos) {
      if (!(await git.isRepo())) continue;
      const tree = await git.writeTree(this.paths);
      const commit = await git.commitTree(tree, {
        message: `vn: ${label} ${seq}`,
        parents: [await git.head()],
      });
      await git.updateRef(`${REFS}/${seq}/${label}`, commit);
      repos[git.root] = { commit, tree };
      primary ??= { commit, tree };
    }
    return primary === null ? null : { ...primary, repos };
  }

  /**
   * The undo point a record carries, from the two snapshots bracketing an act. `repos` is
   * written only when the act spanned more than one, so a single-repo project's records stay
   * byte-identical to what it wrote before multi-repo existed.
   */
  point(pre: Snapshot, post: Snapshot): UndoPoint {
    const roots = [...new Set([...Object.keys(pre.repos), ...Object.keys(post.repos)])];
    return {
      pre: pre.commit,
      post: post.commit,
      changed: roots.some((root) => pre.repos[root]?.tree !== post.repos[root]?.tree),
      ...(roots.length > 1
        ? {
            repos: Object.fromEntries(
              roots
                .filter((root) => pre.repos[root] && post.repos[root])
                .map((root) => [
                  root,
                  { pre: pre.repos[root]!.commit, post: post.repos[root]!.commit },
                ]),
            ),
          }
        : {}),
    };
  }

  /** The document tree of the primary repo as it stands right now, without parking it. */
  async currentTree(): Promise<string | null> {
    const git = this.repos[0];
    if (!git || !(await git.isRepo())) return null;
    return git.writeTree(this.paths);
  }

  /**
   * Whether every repo's working copy is still exactly where `point`'s `side` left it.
   *
   * This is the §7 guard, and it closes path-scoped restore's worst failure mode: an author
   * who hand-edited a file since the command ran would otherwise have that edit eaten
   * silently. Trees are content-addressed, so each comparison is one sha — and all of them
   * happen before any repo is touched.
   */
  async check(
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ ok: true; trees: Record<string, string> } | { ok: false; error: string }> {
    const expected = this.expected(point, side);
    const trees: Record<string, string> = {};
    for (const git of this.repos) {
      const commit = expected[git.root];
      if (commit === undefined) continue;
      if (!(await git.isRepo()))
        return { ok: false, error: `${git.root} is no longer a git repository` };
      const tree = await git.writeTree(this.paths);
      if (tree !== (await git.treeOf(commit))) {
        const where = this.repos.length > 1 ? ` in ${git.root}` : '';
        return {
          ok: false,
          error:
            `the workspace has changed${where} since that command ran — undoing would discard ` +
            'those changes. Commit or revert them first.',
        };
      }
      trees[git.root] = tree;
    }
    if (Object.keys(trees).length === 0)
      return { ok: false, error: 'not a git repository, so nothing was snapshotted' };
    return { ok: true, trees };
  }

  /**
   * Move every repo's working copy from the checked trees to the `side` snapshot.
   *
   * Not atomic across repos — `check` has already established that none of them drifted, so
   * the remaining failure is an I/O error mid-restore. It reports rather than throws, so the
   * roots that did move are never lost: a caller that reported a no-op would be describing a
   * workspace that no longer exists.
   */
  async restore(
    trees: Record<string, string>,
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ moved: string[]; error?: string }> {
    const expected = this.expected(point, side);
    const moved: string[] = [];
    for (const git of this.repos) {
      const from = trees[git.root];
      const commit = expected[git.root];
      if (from === undefined || commit === undefined) continue;
      try {
        await git.applyTree(from, await git.treeOf(commit));
      } catch (err) {
        return { moved, error: err instanceof Error ? err.message : String(err) };
      }
      moved.push(git.root);
    }
    return { moved };
  }

  /**
   * Drop refs for all but the most recent `keep` commands, in every repo. Snapshots are cheap
   * but not free, and an unbounded ref namespace would keep every tree an author ever passed
   * through alive.
   */
  async prune(): Promise<void> {
    for (const git of this.repos) {
      if (!(await git.isRepo())) continue;
      const refs = await git.listRefs(REFS);
      const seqs = [...new Set(refs.map((r) => Number(r.ref.split('/')[3])))]
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
      for (const seq of seqs.slice(0, Math.max(0, seqs.length - this.keep))) {
        for (const label of ['pre', 'post']) await git.deleteRef(`${REFS}/${seq}/${label}`);
      }
    }
  }

  /** Repo root → the commit `side` says that repo should be at. */
  private expected(point: UndoPoint, side: 'pre' | 'post'): Record<string, string> {
    if (point.repos) {
      return Object.fromEntries(Object.entries(point.repos).map(([root, p]) => [root, p[side]]));
    }
    const primary = this.repos[0];
    return primary ? { [primary.root]: point[side] } : {};
  }
}

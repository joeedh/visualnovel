/**
 * Shadow snapshots for the command stack — `docs/gitUndoOptions.md` strategies D + E.
 *
 * Before and after every undoable command the journal captures the **document** tree into a
 * detached commit under `refs/vn/undo/<seq>/`. HEAD does not move, the index is not touched,
 * and nothing shows up in `git log`/`branch`/`status` or is ever pushed — though they are real
 * commits and `git log --all` does see them. Undo moves the working copy back to the `pre`
 * tree; redo moves it to the `post` tree.
 *
 * Two things it deliberately does not do. It does not snapshot generated output — `paths`
 * excludes `build/` and `state/`, because assets are content-addressed and immutable and
 * "undoing" them would mean deleting bytes a later run would pay to regenerate. And it never
 * guesses: if the working copy is not where the record says it left it, `check` refuses and
 * says so rather than restoring over an edit nobody asked it to discard.
 */
import type { Git } from '@vn/git';

export interface UndoJournalOptions {
  git: Git;
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
  /** The commit sha, as recorded on `CommandRecord.undo`. */
  commit: string;
  tree: string;
}

const DEFAULT_KEEP = 50;
const REFS = 'refs/vn/undo';

export class UndoJournal {
  private readonly git: Git;
  private readonly paths: string[];
  private readonly keep: number;

  constructor(opts: UndoJournalOptions) {
    this.git = opts.git;
    this.paths = opts.paths ?? ['.'];
    this.keep = opts.keep ?? DEFAULT_KEEP;
  }

  /**
   * Snapshot the document tree and park it at `refs/vn/undo/<seq>/<label>`.
   *
   * Returns null outside a repo — the one case where undo is simply unavailable rather than
   * refused, since there is nothing to snapshot into.
   */
  async capture(seq: number, label: 'pre' | 'post'): Promise<Snapshot | null> {
    if (!(await this.git.isRepo())) return null;
    const tree = await this.git.writeTree(this.paths);
    const commit = await this.git.commitTree(tree, {
      message: `vn: ${label} ${seq}`,
      parents: [await this.git.head()],
    });
    await this.git.updateRef(`${REFS}/${seq}/${label}`, commit);
    return { commit, tree };
  }

  /** The document tree as it stands right now, without parking it. */
  async currentTree(): Promise<string | null> {
    if (!(await this.git.isRepo())) return null;
    return this.git.writeTree(this.paths);
  }

  /**
   * Whether the working copy is still exactly where `expected` says it was left.
   *
   * This is the §7 guard, and it closes path-scoped restore's worst failure mode: an author
   * who hand-edited a file since the command ran would otherwise have that edit eaten
   * silently. Trees are content-addressed, so the comparison is one sha.
   */
  async check(
    expected: string,
  ): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
    const tree = await this.currentTree();
    if (tree === null)
      return { ok: false, error: 'not a git repository, so nothing was snapshotted' };
    if (tree !== (await this.git.treeOf(expected))) {
      return {
        ok: false,
        error:
          'the workspace has changed since that command ran — undoing would discard those ' +
          'changes. Commit or revert them first.',
      };
    }
    return { ok: true, tree };
  }

  /** Move the working copy from one snapshot's tree to another's. */
  async restore(fromTree: string, toCommit: string): Promise<void> {
    await this.git.applyTree(fromTree, await this.git.treeOf(toCommit));
  }

  /**
   * Drop refs for all but the most recent `keep` commands. Snapshots are cheap but not free,
   * and an unbounded ref namespace would keep every tree an author ever passed through alive.
   */
  async prune(): Promise<void> {
    const refs = await this.git.listRefs(REFS);
    const seqs = [...new Set(refs.map((r) => Number(r.ref.split('/')[3])))]
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    for (const seq of seqs.slice(0, Math.max(0, seqs.length - this.keep))) {
      for (const label of ['pre', 'post']) await this.git.deleteRef(`${REFS}/${seq}/${label}`);
    }
  }
}

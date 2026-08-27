/**
 * Snapshots for the command stack, over the content-addressed store in `content.ts`.
 *
 * Before and after every undoable command the journal captures the document tree into that store
 * and keeps its hash. Undo moves the working copy back to the `pre` tree; redo moves it to the
 * `post` tree. Nothing is written to disk to make a snapshot, no repository is involved, and
 * history is process-lifetime only: closing the app drops it.
 *
 * The journal deliberately does not snapshot generated output. Callers scope `exclude` to leave
 * out `build/` and `state/`, and the store leaves out media wherever it sits, because assets are
 * content-addressed and immutable and "undoing" them would mean deleting bytes a later run would
 * pay to regenerate. It also does not guess. If the working copy is not where the record says it
 * left it, `check` refuses and says so rather than restoring over an edit nobody asked it to
 * discard.
 */
import { promises as fs } from 'node:fs';
import type { UndoPoint } from './command.js';
import { ContentStore } from './content.js';

export interface UndoJournalOptions {
  /** The directory a snapshot covers. It need only be a directory; git has no part in this. */
  root: string;
  /**
   * Where the snapshots are held. Shared with a host that caches its own file I/O against the
   * same store, so a file the app just wrote is already hashed by the time a capture reaches it.
   */
  store?: ContentStore;
  /**
   * Root-relative, forward-slashed paths outside the document class, e.g.
   * `['vngen/build', 'vngen/state']`. Naming a directory prunes the walk under it.
   */
  exclude?: string[];
  /** How many commands' snapshots to keep. Older ones are dropped and their bytes collected. */
  keep?: number;
  /**
   * Ceiling on the bytes the store may hold. Older snapshots are dropped until it is met, so an
   * unusually large project loses undo depth rather than growing without bound. The newest
   * command's pair is kept whatever the total, since dropping it would leave nothing to undo.
   */
  maxBytes?: number;
}

const DEFAULT_KEEP = 50;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class UndoJournal {
  readonly store: ContentStore;
  private readonly root: string;
  private readonly skip: ReadonlySet<string>;
  private readonly keep: number;
  private readonly maxBytes: number;
  /** Every snapshot taken, oldest first, so pruning knows which are the recent ones. */
  private readonly taken: { seq: number; tree: string }[] = [];

  constructor(opts: UndoJournalOptions) {
    this.root = opts.root;
    this.store = opts.store ?? new ContentStore();
    this.skip = new Set(opts.exclude ?? []);
    this.keep = opts.keep ?? DEFAULT_KEEP;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Hash the document tree and hold it under `seq`.
   *
   * Returns null when the root is not a directory to walk — the one case where undo is simply
   * unavailable rather than refused.
   */
  async capture(seq: number): Promise<string | null> {
    const stat = await fs.stat(this.root).catch(() => null);
    if (!stat?.isDirectory()) return null;
    const tree = await this.store.capture(this.root, this.skip);
    this.taken.push({ seq, tree });
    return tree;
  }

  /** The undo point a record carries, from the two snapshots bracketing an act. */
  point(pre: string, post: string): UndoPoint {
    return { pre, post, changed: pre !== post };
  }

  /** The document tree as it stands right now, without holding it against pruning. */
  async currentTree(): Promise<string | null> {
    const stat = await fs.stat(this.root).catch(() => null);
    if (!stat?.isDirectory()) return null;
    return this.store.capture(this.root, this.skip);
  }

  /**
   * Checks whether the working copy is still exactly where `point`'s `side` left it, which is the
   * guard against a restore silently discarding a hand-edit an author made after the command ran.
   * The comparison is one hash, and it happens before anything is written.
   */
  async check(
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
    const expected = point[side];
    if (this.store.tree(expected) === undefined) {
      return {
        ok: false,
        error: `that command's snapshot is no longer held — undo reaches back ${this.keep} commands`,
      };
    }
    const tree = await this.currentTree();
    if (tree === null) return { ok: false, error: `${this.root} is no longer a directory` };
    if (tree !== expected) {
      return {
        ok: false,
        error:
          'the workspace has changed since that command ran — undoing would discard those ' +
          'changes. Commit or revert them first.',
      };
    }
    return { ok: true, tree };
  }

  /**
   * Move the working copy from the checked tree to the `side` snapshot, answering the paths it
   * moved so a restore reports what it touched the way any other write does.
   *
   * Reports rather than throws, so a failure part way through is described rather than read as a
   * no-op the caller can retry from where it started. `changed` is carried by the failure too,
   * because a partial move left those files somewhere new.
   */
  async restore(
    from: string,
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ error?: string; changed: string[] }> {
    const changed: string[] = [];
    try {
      await this.store.restore(this.root, from, point[side], changed);
      return { changed };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), changed };
    }
  }

  /**
   * Drop all but the most recent `keep` commands' snapshots, then keep dropping the oldest while
   * the store is over `maxBytes`, and collect what nothing reaches any more.
   */
  prune(): void {
    const seqs = [...new Set(this.taken.map((s) => s.seq))].sort((a, b) => a - b);
    let oldest = Math.max(0, seqs.length - this.keep);
    let bytes = this.forget(seqs[oldest - 1]);

    while (bytes > this.maxBytes && oldest < seqs.length - 1) {
      oldest++;
      bytes = this.forget(seqs[oldest - 1]);
    }
  }

  /**
   * Drop every snapshot taken at or before `seq`, collect what the rest no longer reaches, and
   * answer the bytes the surviving snapshots hold.
   */
  private forget(seq: number | undefined): number {
    if (seq !== undefined) {
      const kept = this.taken.filter((s) => s.seq > seq);
      this.taken.length = 0;
      this.taken.push(...kept);
    }
    return this.store.collect(this.taken.map((s) => s.tree));
  }
}

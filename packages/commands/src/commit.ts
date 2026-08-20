/**
 * Commit-on-save: every act that changed something becomes a commit, in each repo it touched.
 *
 * The sibling of `UndoJournal`, and opt-in the same way — a stack with no committer moves no
 * ref, exactly as before this existed. The two compose without ordering constraints: a commit
 * moves a branch ref and the index and changes no file in the worktree, so it cannot perturb a
 * snapshot tree taken either side of it.
 *
 * Scope is the whole worktree (`-A`) per repo, not the paths a command claimed it wrote — a
 * declared `written` set is unverified (`docs/history/gitUndoOptions.md` §3) and the invariant this
 * rests on is stronger anyway: the app opens on a clean worktree and every act ends with one,
 * so "everything dirty" and "what this act did" are the same set.
 */
import type { Git } from '@vn/git';
import type { CommandRecord } from './command.js';

/** One commit this act produced. */
export interface CommitResult {
  /** The repo root it landed in. */
  repo: string;
  sha: string;
}

export interface CommitterOptions {
  /**
   * The repos to commit in, newest map each call so a repo created since (project bootstrap,
   * a `git init` in `wiki/`) is picked up without rebuilding the stack.
   */
  repos(): Promise<Git[]> | Git[];
}

/** Git subjects are read in one line; anything longer belongs in the body. */
const SUBJECT_MAX = 72;

function subject(text: string, fallback: string): string {
  const line = text.trim().replace(/\.$/, '');
  if (line.length === 0) return fallback;
  return line.length <= SUBJECT_MAX ? line : `${line.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

function trailersOf(record: CommandRecord): Record<string, string> {
  const trailers: Record<string, string> = {
    'Vn-Command': record.id,
    'Vn-Seq': String(record.seq),
    'Vn-Invocation': record.invocation,
    'Vn-Source': record.source,
  };
  // An undo is a new commit restoring an earlier tree, never a reset — so the trailer is what
  // says which act it reverses; the reverted commit itself stays in the log.
  if (record.stack) {
    trailers[record.stack === 'undo' ? 'Vn-Undo' : 'Vn-Redo'] = String(
      record.props['target'] ?? '',
    );
  }
  return trailers;
}

export class Committer {
  constructor(private readonly opts: CommitterOptions) {}

  /** Commit whatever `record`'s command left on disk. A repo with nothing to commit is skipped. */
  async commit(record: CommandRecord): Promise<CommitResult[]> {
    return this.run(subject(record.message, record.invocation), trailersOf(record));
  }

  /**
   * Commit whatever is already there, attributed to nobody in particular.
   *
   * Two uses, one mechanism: the bootstrap step that brings a picked directory under version
   * control, and the open-time sweep that establishes the clean-worktree invariant by recording
   * edits made outside the app (a CLI run, another editor) as their own event rather than
   * folding them into the next authored act.
   */
  async checkpoint(reason: string): Promise<CommitResult[]> {
    return this.run(subject(reason, 'Checkpoint'), { 'Vn-Checkpoint': 'true' });
  }

  private async run(subject: string, trailers: Record<string, string>): Promise<CommitResult[]> {
    const commits: CommitResult[] = [];
    for (const git of await this.opts.repos()) {
      if (!(await git.isRepo())) continue;
      const sha = await git.commit({ message: subject, paths: ['-A'], trailers });
      if (sha) commits.push({ repo: git.root, sha });
    }
    return commits;
  }
}

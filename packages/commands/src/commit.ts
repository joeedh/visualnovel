/**
 * Commit-on-save: every act that changed something becomes a commit, in each repo it touched.
 *
 * This is opt-in the same way `UndoJournal` is, since a stack with no committer moves no ref.
 * The two compose without ordering constraints: a commit moves a branch ref and the index and
 * changes no file in the worktree, so it cannot perturb a snapshot tree taken either side of it.
 *
 * Scope is the whole worktree (`-A`) per repo rather than the paths a command claimed it wrote.
 * A declared `written` set is unverified (`docs/history/gitUndoOptions.md` §3). The whole worktree
 * rests on a stronger invariant anyway: the app opens on a clean worktree and every act ends with
 * one, so "everything dirty" and "what this act did" are the same set.
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
   * The repos to commit in, recomputed on each call so a repo created since (project bootstrap,
   * a `git init` in `wiki/`) is picked up without rebuilding the stack.
   */
  repos(): Promise<Git[]> | Git[];
}

/** Git subjects are read in one line; anything longer belongs in the body. */
const SUBJECT_MAX = 72;

/**
 * The first line of `text` as a git subject, or `fallback` when it has none. Only the first line
 * is taken: git reads a blank line as the start of a body, so truncating a longer text mid-word
 * would leave a stray paragraph of it as the commit message body.
 */
function subject(text: string, fallback: string): string {
  const line = text.trim().split('\n')[0]!.trim().replace(/\.$/, '');
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
  // An undo is a new commit restoring an earlier tree rather than a reset, so the trailer
  // records which act it reverses; the reverted commit itself stays in the log
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
    return this.run(
      subject(record.subject ?? record.message, record.invocation),
      trailersOf(record),
    );
  }

  /**
   * Commit whatever is already there, attributed to nobody in particular.
   *
   * Used by the bootstrap step that brings a picked directory under version control, and by the
   * open-time sweep that establishes the clean-worktree invariant by recording edits made outside
   * the app (a CLI run, another editor) as their own event rather than folding them into the next
   * authored act.
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

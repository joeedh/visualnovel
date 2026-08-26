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
 * one, so "everything dirty" and "what this act did" are the same set. A run of acts that defer
 * their commit is the one exception, and it widens the set rather than mixing it: everything
 * dirty is then what the whole run did, which is exactly what `commitBatch` describes. The stack
 * flushes the run before any other act runs, so no act's commit ever holds another's files.
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
 * would leave a stray paragraph of it as the commit message body. `max` is lowered by
 * `commitBatch` to reserve room for a suffix that must survive truncation.
 */
function subject(text: string, fallback: string, max = SUBJECT_MAX): string {
  const line = text.trim().split('\n')[0]!.trim().replace(/\.$/, '');
  const chosen = line.length === 0 ? fallback : line;
  return chosen.length <= max ? chosen : `${chosen.slice(0, max - 1).trimEnd()}…`;
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

/** First-seen order, so `Vn-Command` reads in the order the acts ran. */
function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * `seqs` as a comma-separated list with runs of two or more hyphenated: `41,43,45-72`. The seqs a
 * batch covers have gaps in them, so a first-to-last span would claim records the commit does not
 * contain. Exported so a host reporting a failed batch names the same acts the trailer would have.
 */
export function seqRanges(seqs: number[]): string {
  const sorted = [...seqs].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    parts.push(end > i ? `${sorted[i]}-${sorted[end]}` : String(sorted[i]));
    i = end + 1;
  }
  return parts.join(',');
}

/**
 * Provenance for a run of acts folded into one commit. `Vn-Seq` keeps its meaning — one integer,
 * the last record — so a reader that parses it as a number is not given a wrong answer; the span
 * goes in `Vn-Batch`. `Vn-Invocation` is dropped, since thirty invocations do not belong in a
 * commit message and each is already in `commands.jsonl` under a seq `Vn-Batch` names.
 */
function trailersOfBatch(records: CommandRecord[]): Record<string, string> {
  return {
    'Vn-Batch': `${records.length} seqs ${seqRanges(records.map((r) => r.seq))}`,
    'Vn-Seq': String(records[records.length - 1]!.seq),
    'Vn-Command': distinct(records.map((r) => r.id)).join(', '),
    'Vn-Source': distinct(records.map((r) => r.source)).join(', '),
  };
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
   * Commit a run of acts as one commit per repo. The subject names the last act, which is the
   * state the commit contains and the edit the author most recently made, and states how many
   * came with it. One record produces byte-identical output to `commit(record)`, and an empty
   * batch touches no repo.
   */
  async commitBatch(records: CommandRecord[]): Promise<CommitResult[]> {
    if (records.length === 0) return [];
    if (records.length === 1) return this.commit(records[0]!);

    const more = records.length - 1;
    const suffix = ` (and ${more} more edit${more === 1 ? '' : 's'})`;
    const last = records[records.length - 1]!;
    // The count is the one part of the line that says the commit is a batch, so the base subject
    // is capped short of it rather than the whole line being capped afterwards.
    const base = subject(
      last.subject ?? last.message,
      last.invocation,
      SUBJECT_MAX - suffix.length,
    );
    return this.run(`${base}${suffix}`, trailersOfBatch(records));
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

/**
 * The rules a history reader applies to commits and to a worktree, and the row shapes it hands
 * on. Pure functions over what `Git.history`, `Git.branchStatus` and `Git.inProgress` return, so
 * the desktop app and the authoring agent classify a save the same way, and a test needs no
 * repository.
 */
import { lineDiff, wordDiff, type DiffLine, type DiffParagraph } from '@vn/util';
import type { InProgress } from './git.js';
import type { HistoryEntry, StatusEntry } from './parse.js';

/** Who a save is attributed to, in the order the rail colours are assigned. */
export type Maker = 'author' | 'agent' | 'pipeline' | 'housekeeping' | 'other' | 'unknown';

/** A commit as the history list shows it. */
export interface Save extends HistoryEntry {
  maker: Maker;
  /** The checkpoint slugs that name this save. */
  checkpoints: string[];
  /**
   * Whether the branch's upstream holds this save. Null when the branch has no upstream, since
   * "unsent" only means something once there is somewhere to send to.
   */
  sent: boolean | null;
}

/** The trailer a commit-on-save commit carries for the command that produced it. */
const COMMAND = 'Vn-Command';
/** Commands whose commits are the pipeline's, however they were invoked. */
const PIPELINE =
  /^(pipeline\.(run|approveAndRun|draw)|art\.[a-zA-Z]+|asset\.regenerate|gengraph\.run)$/;

export interface MakerContext {
  /** The identity commit-on-save writes with; a commit by anyone else is a collaborator's. */
  local: { name: string | null; email: string | null };
  /** Subjects the app commits under when it scaffolds a project, which carry no trailer. */
  housekeeping?: readonly string[];
}

/**
 * Attributes one commit. A collaborator's identity wins over every trailer, since their app
 * writes the same trailers; then the trailerless housekeeping shapes; then the source and the
 * command the trailers name. A commit with no trailer that is none of those was made outside
 * the app.
 */
export function makerOf(commit: HistoryEntry, ctx: MakerContext): Maker {
  const { local } = ctx;
  const mine =
    (local.email !== null && commit.email === local.email) ||
    (local.email === null && local.name !== null && commit.author === local.name);
  if ((local.email !== null || local.name !== null) && !mine) return 'other';

  const t = commit.trailers;
  if ('Vn-Sweep' in t) return 'housekeeping';
  if (commit.parents.length === 0) return 'housekeeping';
  if (ctx.housekeeping?.includes(commit.subject)) return 'housekeeping';

  // A batch commit lists every command and every source it folded, comma-separated
  const commands = listed(t[COMMAND]);
  if (listed(t['Vn-Source']).includes('agent') || commands.includes('agent.run')) return 'agent';
  if (commands.some((c) => PIPELINE.test(c))) return 'pipeline';
  if (t[COMMAND] !== undefined || 'Vn-Undo' in t || 'Vn-Redo' in t) return 'author';
  return 'unknown';
}

const listed = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

/** What a changed file is, which chooses how its diff is built and drawn. */
export type FileKind =
  'picture' | 'scene' | 'sheet' | 'wiki' | 'storyboard' | 'project' | 'log' | 'other';

/** A diff shaped for its file kind. */
export type Diff =
  /** A line diff, for `other`, `storyboard` and `project` files. */
  | { kind: 'lines'; lines: DiffLine[] }
  /** A word diff by paragraph, for `wiki`, `sheet` and `scene` files. */
  | { kind: 'prose'; paragraphs: DiffParagraph[] }
  /** A log only grows; the line counts are the whole story. */
  | { kind: 'log'; added: number; removed: number }
  /** A picture on either side, as a URL the renderer can draw; null where the side lacks it. */
  | { kind: 'picture'; before: string | null; after: string | null }
  /** Bytes git could not diff, sized per side; null where the side lacks the file. */
  | { kind: 'binary'; before: number | null; after: number | null };

/** The kinds whose diff is built from the text of both sides. */
export type TextKind = Exclude<FileKind, 'picture' | 'log'>;

/** Builds the diff of one text file, given its kind and both sides (empty where absent). */
export function textDiff(kind: TextKind, before: string, after: string): Diff {
  switch (kind) {
    case 'wiki':
    case 'sheet':
    case 'scene':
      return { kind: 'prose', paragraphs: wordDiff(before, after) };
    default:
      return { kind: 'lines', lines: lineDiff(before, after) };
  }
}

/** What explains the state of a worktree; `clean` when nothing needs explaining. */
export type StatusCause = 'clean' | 'pending' | 'outside' | 'rebase' | 'merge' | 'revert';

/** The status view's data: the cause, and the entries that go with it. */
export interface WorktreeStatus {
  cause: StatusCause;
  /** Paths changed outside the app, for `outside`; empty otherwise. */
  outside: string[];
  /** Paths with an unresolved conflict, for `rebase` and `merge`; empty otherwise. */
  conflicted: string[];
  /** Acts waiting in the deferred batch, for `pending`; 0 otherwise. */
  pending: number;
}

/**
 * Explains a worktree. An operation in progress explains everything dirty about it; a pending
 * batch explains the rest; anything else dirty was changed outside the app, except under the
 * `own` prefixes, which are the app's own logs: a read appends to the command log without
 * committing, and that is not the author's doing.
 */
export function statusCause(
  entries: readonly StatusEntry[],
  pending: number,
  inProgress: InProgress,
  own: readonly string[] = [],
): WorktreeStatus {
  const conflicted = entries.filter((e) => e.unmerged).map((e) => e.path);
  const outside = entries
    .map((e) => e.path)
    .filter((path) => !own.some((prefix) => path.startsWith(prefix)));
  const none = { outside: [], conflicted: [], pending: 0 };
  if (inProgress.rebase) return { ...none, cause: 'rebase', conflicted };
  if (inProgress.merge) return { ...none, cause: 'merge', conflicted };
  if (inProgress.revert) return { ...none, cause: 'revert', conflicted };
  if (pending > 0) return { ...none, cause: 'pending', pending };
  if (outside.length > 0) return { ...none, cause: 'outside', outside };
  return { ...none, cause: 'clean' };
}

/**
 * What the History pane and the `git.*` reads share: the row and diff shapes from `@vn/git`, and
 * the grouping of a changed path into a file kind, which only the desktop does. A kind chooses
 * how `git.diff` builds a diff and how the pane draws it.
 */
import type { Decision, FileKind, InProgress, Save, WorktreeStatus } from '@vn/git';

export type { Decision, FileKind, Save, WorktreeStatus };

/** The repositories a project spans, as `git.repos` lists them. */
export type RepoRole = 'project' | 'wiki' | 'base';
export const REPO_ROLES = ['project', 'wiki', 'base'] as const;

/** One repository the History pane can show. */
export interface RepoEntry {
  role: RepoRole;
  root: string;
  /** False for a repository the project merely sits inside, where commit-on-save never writes. */
  owned: boolean;
  /** A submodule that is not checked out; `root` is its empty directory, and `owned` is false. */
  missing?: true;
}

/**
 * What every `git.*` write says over a repository the project merely sits inside. Both the
 * commands' checks and the pane's own refusals say it, so a greyed control and a refused command
 * read the same.
 */
export const NOT_OWNED =
  'This project sits inside a repository that is not its own; the app does not write history there.';

/**
 * Builds the sentence for a submodule that is not checked out, used by the open-time notice and
 * by the History pane. `dir` is the directory as the caller wants it shown.
 */
export function notCheckedOut(dir: string): string {
  return (
    `${dir} is a submodule that is not checked out, so nothing written there is saved. ` +
    'Run git submodule update --init in the project, then reopen it.'
  );
}

/**
 * What every command that plans from the worktree says while a rebase, merge or revert is in
 * progress, in the author's words; a merge or a revert is folded into "getting their saves".
 */
export const SYNC_UNFINISHED = 'Getting their saves is unfinished; finish or give it up first.';

/**
 * What every sync verb says over a branch with no shared copy to sync with. `@vn/git` says the
 * same, as `NO_UPSTREAM`; the renderer cannot import that package, so a test pins the two equal.
 */
export const NO_UPSTREAM = 'No shared copy is set to sync with; connect one first.';

/** What every restore and a pull say over edits on disk no save holds yet; `@vn/git`'s `DIRTY_TREE`. */
export const UNSAVED_EDITS = 'There are edits on disk not yet saved; save or discard them first.';

/** One shared copy, as the sync view lists it. */
export interface RemoteEntry {
  name: string;
  url: string;
  /** Saves this copy lacks, and saves it has that the branch lacks; null before the first fetch. */
  ahead: number | null;
  behind: number | null;
  /** Whether this is the copy the branch syncs with: where a pull comes from. */
  syncsWith: boolean;
}

/** The save a stopped rebase is replaying, for the conflict view's heading. */
export interface Replaying {
  sha: string;
  subject: string;
  /** 1-based position among the saves being replayed. */
  current: number;
  total: number;
}

/** What `git.status` answers: the worktree's cause plus the branch and its remotes. */
export interface RepoStatus extends WorktreeStatus {
  /** Null on an unborn branch, or when HEAD is detached outside a rebase. */
  branch: string | null;
  /** `remote/branch`, or null when the branch has no upstream. */
  upstream: string | null;
  /** Null until the upstream's tracking ref exists, as after adding a remote but before a fetch. */
  ahead: number | null;
  behind: number | null;
  remotes: RemoteEntry[];
  /** ISO time of the last fetch, or null when there has never been one. */
  lastFetch: string | null;
  inProgress: InProgress;
  /** Where a stopped rebase stands; null outside one. */
  replaying: Replaying | null;
  /**
   * The paths in `conflicted` whose worktree copy holds git's markers: the ones git merged line by
   * line, so the author can finish the merge in the text.
   */
  marked: string[];
  /** The files decided since this stop began, in the order git lists them; empty outside a rebase. */
  decided: DecidedFile[];
}

/** One file decided at the current stop, and how; `Decision` is in git's words for the sides. */
export interface DecidedFile {
  path: string;
  decision: Decision;
}

/** How a decided row says it was decided, translating git's sides for a rebase. */
export function decisionSentence(decision: Decision): string {
  switch (decision) {
    case 'ours':
      return 'took theirs';
    case 'theirs':
      return 'kept yours';
    case 'merged':
      return 'merged';
    case 'removed':
      return 'removed';
  }
}

/** Paths git never merges, by the project's `.gitattributes`: a conflict there is whole-file. */
const NO_MERGE = [
  /^\.vnstudio\/layouts\/[^/]+\.json$/,
  /^vngen\/state\/threads\/[^/]+\.native\.jsonl$/,
  /^vngen\/work\/graphs\/(lib\/)?[^/]+\.json$/,
];

/**
 * Whether a conflicted path is one the author can read both sides of: a text file git merged line
 * by line. A `-merge` file, a picture and a log offer only the two sides to keep.
 */
export function readableConflict(path: string): boolean {
  if (NO_MERGE.some((re) => re.test(path))) return false;
  const kind = kindOf(path);
  return kind !== 'picture' && kind !== 'log';
}

/** What `git.blob` answers for a path at a commit. */
export type BlobRead =
  | { kind: 'text'; text: string }
  /** Bytes the renderer loads from `url`, a `vngit://` address. */
  | { kind: 'bytes'; url: string; bytes: number };

/** Where `vngit://` serves one blob: the role as the host, the blob id and extension as the path. */
export function blobUrl(role: RepoRole, blobId: string, path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : 'bin';
  return `vngit://${role}/${blobId}.${ext}`;
}

/**
 * What one `vngit://` URL asks for, or null when it is malformed. One path segment names a blob
 * by id, as `blobUrl` spells it; a commit followed by a path names the file at that commit.
 */
export function parseGitUrl(
  url: string,
): { role: RepoRole; ref: string; path?: string; ext: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'vngit:') return null;
  const role = parsed.hostname as RepoRole;
  if (!REPO_ROLES.includes(role)) return null;
  const segments = parsed.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeURIComponent);
  const first = segments[0];
  if (first === undefined) return null;
  if (segments.length === 1) {
    const dot = first.lastIndexOf('.');
    if (dot <= 0) return { role, ref: first, ext: 'bin' };
    return { role, ref: first.slice(0, dot), ext: first.slice(dot + 1) };
  }
  const path = segments.slice(1).join('/');
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1) : 'bin';
  return { role, ref: first, path, ext };
}

/** One page of `git.history`. */
export interface HistoryPage {
  saves: Save[];
  /** The sha the next page starts after, or null when the history ended. */
  next: string | null;
}
export type { Change, Checkpoint, Diff, Maker, StatusCause } from '@vn/git';
export type { DiffLine, DiffParagraph, DiffSpan } from '@vn/util';

const PICTURE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
// Every `.jsonl` under `vngen/state/`: the command log, the notifications, and the conversation
// transcripts under `threads/`, which an agent turn appends to as it goes
const LOG = /^(vngen\/state\/.+\.jsonl|assets\/manifest\.json)$/;

/**
 * The kind of one workspace-relative path. The pictures test runs first so a `.png` under
 * `characters/` is a picture rather than a sheet; the logs test next, since the manifest sits
 * under `assets/` beside the base store.
 */
export function kindOf(path: string): FileKind {
  if (PICTURE.test(path)) return 'picture';
  if (LOG.test(path)) return 'log';
  // A scene is `scenes/<id>.md` since the import; the one-file screenplay is the retired form
  if (path.startsWith('scenes/') && /\.(md|fountain)$/.test(path)) return 'scene';
  if (/^(screenplay\/[^/]+|screenplay)\.(md|fountain)$/.test(path)) return 'scene';
  if (path.startsWith('characters/') || path.startsWith('locations/')) {
    return path.endsWith('.md') ? 'sheet' : 'other';
  }
  if (path.endsWith('.md')) return 'wiki';
  if (path.startsWith('vngen/work/shots/') || path.startsWith('vngen/work/graphs/')) {
    return 'storyboard';
  }
  if (path === 'project.yaml' || path.startsWith('.vnstudio/')) return 'project';
  // A story bible that is a submodule shows up in the project's history as the bare `wiki`
  // path (its gitlink) and as `.gitmodules`, both of which are the project's wiring
  if (path === 'wiki' || path === '.gitmodules') return 'project';
  return 'other';
}

/** The order the change view groups kinds in. */
export const KIND_ORDER: readonly FileKind[] = [
  'picture',
  'scene',
  'sheet',
  'wiki',
  'storyboard',
  'project',
  'other',
  'log',
];

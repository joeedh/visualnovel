/**
 * What the History pane and the `git.*` reads share: the row and diff shapes from `@vn/git`, and
 * the grouping of a changed path into a file kind, which only the desktop does. A kind chooses
 * how `git.diff` builds a diff and how the pane draws it.
 */
import type { FileKind, InProgress, Save, WorktreeStatus } from '@vn/git';

export type { FileKind, Save, WorktreeStatus };

/** The repositories a project spans, as `git.repos` lists them. */
export type RepoRole = 'project' | 'wiki' | 'base';
export const REPO_ROLES = ['project', 'wiki', 'base'] as const;

/** One repository the History pane can show. */
export interface RepoEntry {
  role: RepoRole;
  root: string;
  /** False for a repository the project merely sits inside, where commit-on-save never writes. */
  owned: boolean;
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
  remotes: { name: string; url: string }[];
  /** ISO time of the last fetch, or null when there has never been one. */
  lastFetch: string | null;
  inProgress: InProgress;
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
const LOG = /^(vngen\/state\/[^/]+\.jsonl|assets\/manifest\.json)$/;

/**
 * The kind of one workspace-relative path. The pictures test runs first so a `.png` under
 * `characters/` is a picture rather than a sheet; the logs test next, since the manifest sits
 * under `assets/` beside the base store.
 */
export function kindOf(path: string): FileKind {
  if (PICTURE.test(path)) return 'picture';
  if (LOG.test(path)) return 'log';
  if (path.startsWith('scenes/') && path.endsWith('.fountain')) return 'scene';
  if (path === 'screenplay.fountain') return 'scene';
  if (path.startsWith('characters/') || path.startsWith('locations/')) {
    return path.endsWith('.md') ? 'sheet' : 'other';
  }
  if (path.endsWith('.md')) return 'wiki';
  if (path.startsWith('vngen/work/shots/') || path.startsWith('vngen/work/graphs/')) {
    return 'storyboard';
  }
  if (path === 'project.yaml' || path.startsWith('.vnstudio/')) return 'project';
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

/**
 * Pure parsers for the machine-readable git output the history reads use: `log` with
 * `--numstat`, `diff-tree --raw --numstat`, `status --porcelain=v2 --branch` and the
 * checkpoint tag listing. Each takes the command's stdout and nothing else, so the shapes can
 * be tested without a repository.
 */
import { createHash } from 'node:crypto';

/** ASCII unit separator, `%x1f` in a log format. */
export const UNIT = '\x1f';
/** ASCII record separator, `%x1e` in a log format. */
export const RECORD = '\x1e';

/** One file a commit touched, as `--numstat` reports it. */
export interface TouchedFile {
  path: string;
  /** The path before a rename, when git detected one. */
  oldPath?: string;
  /** Null for a binary file, whose lines `--numstat` cannot count. */
  added: number | null;
  removed: number | null;
}

/** One commit from `Git.history`. */
export interface HistoryEntry {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, ISO 8601 with the author's offset. */
  date: string;
  subject: string;
  /** The message after the subject, with the trailer block removed. */
  body: string;
  /** The trailer block as key-value pairs; a repeated key keeps its last value. */
  trailers: Record<string, string>;
  files: TouchedFile[];
}

/**
 * The `--format` string `Git.history` passes to `git log`. The body and the trailer block can
 * hold newlines, so every field ends in a unit separator and the numstat block is whatever
 * follows the last one.
 */
export const HISTORY_FORMAT =
  '%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%(trailers:only)%x1f';

/** Parses the trailer block git prints: `Key: value` lines, a continuation line indented. */
export function parseTrailers(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of block.split('\n')) {
    if (line.length === 0) continue;
    if (/^\s/.test(line) && key !== null) {
      out[key] = `${out[key]} ${line.trim()}`;
      continue;
    }
    const at = line.indexOf(':');
    if (at <= 0) continue;
    key = line.slice(0, at).trim();
    out[key] = line.slice(at + 1).trim();
  }
  return out;
}

/** The path a numstat line names after a rename: `a/{b => c}/d` or `old => new`. */
function renamed(spec: string): { path: string; oldPath?: string } {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(spec);
  if (brace) {
    const [, pre, from, to, post] = brace;
    return { path: `${pre}${to}${post}`, oldPath: `${pre}${from}${post}` };
  }
  const arrow = spec.indexOf(' => ');
  if (arrow >= 0) return { path: spec.slice(arrow + 4), oldPath: spec.slice(0, arrow) };
  return { path: spec };
}

const count = (s: string): number | null => (s === '-' ? null : Number(s));

/** Parses `--numstat` lines: `added<TAB>removed<TAB>path`, with `-` for a binary file. */
export function parseNumstat(block: string): TouchedFile[] {
  const files: TouchedFile[] = [];
  for (const line of block.split('\n')) {
    const [a, r, spec] = line.split('\t');
    if (a === undefined || r === undefined || spec === undefined) continue;
    files.push({ ...renamed(spec), added: count(a), removed: count(r) });
  }
  return files;
}

/**
 * The message body with the trailer block taken off its end. Git's `%b` includes the block;
 * `%(trailers:only)` repeats it, which is what lets it be subtracted exactly.
 */
function bodyWithout(body: string, trailers: string): string {
  const b = body.trimEnd();
  const t = trailers.trimEnd();
  return t.length > 0 && b.endsWith(t) ? b.slice(0, -t.length).trimEnd() : b;
}

/** Parses the stdout of `git log --format=<HISTORY_FORMAT> --numstat`. */
export function parseHistory(stdout: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const record of stdout.split(RECORD)) {
    if (record.length === 0) continue;
    const [sha, parents, author, email, date, subject, body, trailers, numstat] =
      record.split(UNIT);
    if (sha === undefined || numstat === undefined) continue;
    entries.push({
      sha,
      parents : (parents ?? '').split(' ').filter((p) => p.length > 0),
      author  : author ?? '',
      email   : email ?? '',
      date    : date ?? '',
      subject : subject ?? '',
      body    : bodyWithout(body ?? '', trailers ?? ''),
      trailers: parseTrailers(trailers ?? ''),
      files   : parseNumstat(numstat),
    });
  }
  return entries;
}

/** A change's status letter from `diff-tree --raw`; `R` and `C` carry an `oldPath`. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

/** One path a commit changed, with both blob ids and the line counts. */
export interface Change {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  /** Null when the path did not exist on that side. */
  oldBlob: string | null;
  newBlob: string | null;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

const NO_BLOB = /^0+$/;
const blob = (sha: string): string | null => (NO_BLOB.test(sha) ? null : sha);

/**
 * Parses the stdout of `git diff-tree -r -M --root --raw --numstat --no-commit-id <sha>`: the
 * raw lines first, then the numstat lines, joined here by the path each names.
 */
export function parseChanges(stdout: string): Change[] {
  const changes: Change[] = [];
  const counts = new Map<string, TouchedFile>();
  for (const line of stdout.split('\n')) {
    if (line.startsWith(':')) {
      const [meta, ...paths] = line.slice(1).split('\t');
      const [, , oldBlob, newBlob, status] = (meta ?? '').split(' ');
      const letter = (status ?? 'X')[0] as ChangeStatus;
      const [first, second] = paths;
      if (first === undefined) continue;
      const path = second ?? first;
      changes.push({
        path,
        ...(second !== undefined ? { oldPath: first } : {}),
        status : letter,
        oldBlob: blob(oldBlob ?? '0'),
        newBlob: blob(newBlob ?? '0'),
        added  : null,
        removed: null,
      });
    } else if (line.length > 0) {
      for (const f of parseNumstat(line)) counts.set(f.path, f);
    }
  }
  for (const c of changes) {
    const f = counts.get(c.path);
    if (f) {
      c.added = f.added;
      c.removed = f.removed;
    }
  }
  return changes;
}

/** One entry from `status --porcelain=v2`, in the v1 `x`/`y` vocabulary the app already reads. */
export interface StatusEntry {
  x: string;
  y: string;
  path: string;
  /** The path before a rename or copy staged in the index. */
  origPath?: string;
  /** True for a path with an unresolved merge or rebase conflict. */
  unmerged: boolean;
}

/** The branch header and entries of `status --porcelain=v2 --branch`, one spawn. */
export interface BranchStatus {
  /** Null on an unborn branch. */
  oid: string | null;
  /** Null when HEAD is detached, which it is during a rebase. */
  head: string | null;
  /** `remote/branch`, or null when the branch has no upstream. */
  upstream: string | null;
  /** Null until the upstream's tracking ref exists, as after adding a remote but before a fetch. */
  ahead: number | null;
  behind: number | null;
  entries: StatusEntry[];
}

/** Parses the stdout of `git status --porcelain=v2 --branch`. */
export function parseStatusV2(stdout: string): BranchStatus {
  const status: BranchStatus = {
    oid     : null,
    head    : null,
    upstream: null,
    ahead   : null,
    behind  : null,
    entries : [],
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') status.head = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = line[0];
    if (kind === '1' || kind === '2' || kind === 'u') {
      const fixed = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const parts = line.split(' ');
      const xy = parts[1] ?? '  ';
      const tail = parts.slice(fixed).join(' ');
      const [path, origPath] = kind === '2' ? tail.split('\t') : [tail];
      status.entries.push({
        x   : xy[0] ?? ' ',
        y   : xy[1] ?? ' ',
        path: path ?? '',
        ...(origPath !== undefined ? { origPath } : {}),
        unmerged: kind === 'u',
      });
    } else if (kind === '?') {
      status.entries.push({ x: '?', y: '?', path: line.slice(2), unmerged: false });
    }
  }
  return status;
}

/** One commit's sha and the key `pairRewrites` matches it on across a rebase. */
export interface CommitKey {
  sha: string;
  key: string;
}

/** The `--format` `Git.rangeKeys` uses: the sha, then the author fields and the whole message. */
export const COMMIT_KEY_FORMAT = '%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%B';

/**
 * Parses the stdout of `git log --format=<COMMIT_KEY_FORMAT>`. The key is what a rebase keeps
 * of a commit: its author, the author date and a digest of the full message. The digest keeps a
 * key short whatever the message holds.
 */
export function parseCommitKeys(stdout: string): CommitKey[] {
  const out: CommitKey[] = [];
  for (const record of stdout.split(RECORD)) {
    const [sha, author, email, date, message] = record.replace(/^\n/, '').split(UNIT);
    if (!sha || sha.length !== 40) continue;
    const digest = createHash('sha256')
      .update(message ?? '')
      .digest('hex');
    out.push({ sha, key: [author ?? '', email ?? '', date ?? '', digest].join(UNIT) });
  }
  return out;
}

/** Where checkpoints live; the slug is the rest of the refname. */
export const CHECKPOINT_PREFIX = 'refs/tags/vn/checkpoint/';
/** The same place as `git tag` spells it: a tag name, without `refs/tags/`. */
export const CHECKPOINT_TAG = 'vn/checkpoint/';

/** One checkpoint: an annotated tag under `CHECKPOINT_PREFIX`. */
export interface Checkpoint {
  slug: string;
  /** The first line of the tag message: the name the author typed. */
  name: string;
  /** The rest of the message, trimmed; empty when the author gave none. */
  note: string;
  /** The commit the checkpoint names. */
  sha: string;
  tagSha: string;
  taggedAt: string;
}

/** The `for-each-ref` format `Git.checkpoints` uses; `%1f` is that command's spelling of `%x1f`. */
export const CHECKPOINT_FORMAT =
  '%(refname)%1f%(*objectname)%1f%(objectname)%1f%(taggerdate:iso-strict)%1f%(contents)%1e';

/** Parses the stdout of `git for-each-ref --format=<CHECKPOINT_FORMAT> <CHECKPOINT_PREFIX>`. */
export function parseCheckpoints(stdout: string): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const record of stdout.split(RECORD)) {
    const [ref, sha, tagSha, taggedAt, contents] = record.replace(/^\n/, '').split(UNIT);
    if (ref === undefined || !ref.startsWith(CHECKPOINT_PREFIX)) continue;
    const message = (contents ?? '').trim();
    const nl = message.indexOf('\n');
    out.push({
      slug    : ref.slice(CHECKPOINT_PREFIX.length),
      name    : nl < 0 ? message : message.slice(0, nl).trim(),
      note    : nl < 0 ? '' : message.slice(nl + 1).trim(),
      sha     : sha ?? '',
      tagSha  : tagSha ?? '',
      taggedAt: taggedAt ?? '',
    });
  }
  return out;
}

/**
 * A refname component for a checkpoint name: lowercased ASCII letters, digits, `.`, `_` and
 * `-`, with everything git refuses in a ref removed. Never empty.
 */
export function slugOf(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.lock$/, '');
  return slug.length > 0 ? slug : 'checkpoint';
}

/** `slugOf(name)`, with a numeric suffix when `taken` already holds it. */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugOf(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A thin, non-interactive wrapper over the `git` CLI (authoring-agent plan §5, M1). It
 * spawns `git` via `execFile` (never a shell, so paths/messages with spaces or quotes are
 * safe) and returns structured results. It holds no policy: gating reverts/restores,
 * dirty-tree checks, and commit granularity all live in the agent. Every method is scoped
 * to one repo `root`.
 */
import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { GitError, InProgressError } from './errors.js';
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_PREFIX,
  CHECKPOINT_TAG,
  HISTORY_FORMAT,
  parseChanges,
  parseCheckpoints,
  parseHistory,
  parseStatusV2,
  type BranchStatus,
  type Change,
  type Checkpoint,
  type HistoryEntry,
} from './parse.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A prompt from git or from ssh has nowhere to go under a hidden subprocess, so both are told to
 * fail instead. A credential helper with its own window (Git Credential Manager) still runs.
 */
const NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND    : 'ssh -oBatchMode=yes',
};

/** Run a git subcommand in `cwd`, capturing output. Never throws on non-zero exit. */
function run(cwd: string, args: string[], indexFile?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer  : 64 * 1024 * 1024,
        env: {
          ...process.env,
          ...NO_PROMPT_ENV,
          ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
        },
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

/** Run a git subcommand and keep stdout as bytes, for blob content. Never throws. */
function runBytes(cwd: string, args: string[]): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ code, stdout });
      },
    );
  });
}

/** Filters for `Git.history`; all optional. */
export interface HistoryOptions {
  /** How many commits at most; `HISTORY_LIMIT` when omitted. */
  limit?: number;
  /** Only commits older than this sha, which is what a page after it starts from. */
  before?: string;
  /** Only commits that touched this path. */
  path?: string;
  /** Only commits whose author name or email matches this pattern. */
  author?: string;
}

/** Commits per `history` call when the caller names no limit. */
export const HISTORY_LIMIT = 50;

/** What `diffPath` returns: the unified text, or a flag when git could not diff the bytes. */
export interface PathDiff {
  text: string;
  binary: boolean;
}

/** A rebase that has stopped, read from `rebase-merge/` (or the older `rebase-apply/`). */
export interface RebaseState {
  /** The branch being rebased; HEAD is detached until the rebase ends. Null if unreadable. */
  branch: string | null;
  onto: string;
  /** 1-based position of the commit being replayed, and how many there are. */
  current: number;
  total: number;
  /** The commit that could not be applied, when the rebase stopped on a conflict. */
  stoppedSha: string | null;
}

/** Which multi-step operation, if any, the repository is in the middle of. */
export interface InProgress {
  rebase: RebaseState | null;
  merge: boolean;
  revert: boolean;
}

const NOTHING_IN_PROGRESS: InProgress = { rebase: null, merge: false, revert: false };

/** The one operation `state` reports, or null for a quiet repository. */
export function operationOf(state: InProgress): 'rebase' | 'merge' | 'revert' | null {
  if (state.rebase) return 'rebase';
  if (state.merge) return 'merge';
  if (state.revert) return 'revert';
  return null;
}

/** Which side of a conflicted path to keep, in git's own words; see `resolveSide` for the mapping. */
export type ConflictSide = 'ours' | 'theirs';

/** What `revertDryRun` learned without leaving anything behind. */
export interface RevertPreview {
  clean: boolean;
  /** The paths that would conflict; empty when `clean`. */
  conflicts: string[];
  /** Git's sentence when the revert failed for a reason other than a conflict, such as a merge commit. */
  reason?: string;
}

/** One entry from `git log`. */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

/** Working-tree status: porcelain entries plus a dirty flag. */
export interface GitStatus {
  branch: string;
  dirty: boolean;
  /** Each entry is `{ x, y, path }` from porcelain v1 (X=index, Y=worktree). */
  entries: { x: string; y: string; path: string }[];
}

/** ASCII unit separator: a delimiter that never appears in commit metadata. */
const FIELD_SEP = '';

/** One `refs/…` entry. */
export interface RefInfo {
  ref: string;
  sha: string;
}

/** Distinguishes scratch index files within a process; the pid separates processes. */
let scratchIndexCount = 0;

/** A non-interactive handle to one git repository. */
export class Git {
  constructor(readonly root: string) {}

  private run(args: string[], indexFile?: string): Promise<RunResult> {
    return run(this.root, args, indexFile);
  }

  private async ok(args: string[], indexFile?: string): Promise<string> {
    const r = await this.run(args, indexFile);
    if (r.code !== 0) {
      throw new GitError(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  }

  /**
   * Run `fn` against a private, empty index file, then remove it.
   *
   * Every caller below stages into this rather than the repo's real index — a stray `git add`
   * against that would silently stage whatever the author had in progress.
   */
  private async withScratchIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
    const dir = (await this.ok(['rev-parse', '--absolute-git-dir'])).trim();
    const file = join(dir, `vn-index-${process.pid}-${++scratchIndexCount}`);
    try {
      return await fn(file);
    } finally {
      await rm(file, { force: true });
    }
  }

  /** True if `root` is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    const r = await this.run(['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  /**
   * The work-tree root containing `root`, or null when there is none. Unlike `isRepo` this
   * answers which repo: a `root` inside a nested repository reports the inner one, which is what
   * git itself would operate on.
   */
  async topLevel(): Promise<string | null> {
    const r = await this.run(['rev-parse', '--show-toplevel']);
    const out = r.stdout.trim();
    return r.code === 0 && out.length > 0 ? out : null;
  }

  /** Initialize a new repository at `root`. */
  async init(): Promise<void> {
    await this.ok(['init']);
  }

  /**
   * Set a repo-local config value (`git config --local`). Plumbing, not policy: a freshly
   * `init`ed repo has no committer identity, so whoever creates one has to supply
   * `user.name`/`user.email` before `commit` will work on a clean machine.
   */
  async config(key: string, value: string): Promise<void> {
    await this.ok(['config', '--local', key, value]);
  }

  /**
   * Read an effective config value (local, then global, then system), or null when unset.
   * Pairs with `config` so a caller can supply a fallback identity without stomping one the
   * user already has.
   */
  async configGet(key: string): Promise<string | null> {
    const r = await this.run(['config', '--get', key]);
    const value = r.stdout.trim();
    return r.code === 0 && value.length > 0 ? value : null;
  }

  /** Current branch name (or `HEAD` when detached / unborn). */
  async branch(): Promise<string> {
    const r = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : 'HEAD';
  }

  /** Parse `git status --porcelain` into structured entries. */
  async status(): Promise<GitStatus> {
    const out = await this.ok(['status', '--porcelain']);
    const entries = out
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => ({ x: l[0] ?? ' ', y: l[1] ?? ' ', path: l.slice(3) }));
    return { branch: await this.branch(), dirty: entries.length > 0, entries };
  }

  /** True if the working tree (or a given pathspec) has uncommitted changes. */
  async isDirty(pathspec?: string): Promise<boolean> {
    const args = ['status', '--porcelain'];
    if (pathspec) args.push('--', pathspec);
    const out = await this.ok(args);
    return out.split('\n').some((l) => l.trim().length > 0);
  }

  /** Stage paths (defaults to everything). */
  async add(paths: string[] = ['-A']): Promise<void> {
    await this.ok(['add', ...paths]);
  }

  /**
   * Commit staged changes. If `paths` is given, stage exactly those first so unrelated
   * dirty files are not swept in. Returns the new commit hash, or null when there was
   * nothing to commit.
   *
   * `trailers` are appended as a `Key: value` block after a blank line; commit-on-save writes a
   * command's seq and invocation there. What a given trailer means is the caller's business.
   */
  async commit(opts: {
    message: string;
    paths?: string[];
    trailers?: Record<string, string>;
  }): Promise<string | null> {
    // Before the add: `add -A` mid-rebase marks every conflicted path resolved, markers and all,
    // and the commit that followed would be adopted as the replayed save
    const busy = operationOf(await this.inProgress());
    if (busy) throw new InProgressError(busy);
    if (opts.paths && opts.paths.length > 0) await this.add(opts.paths);
    const before = await this.head();
    const entries = Object.entries(opts.trailers ?? {});
    const message =
      entries.length > 0
        ? `${opts.message}\n\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}`
        : opts.message;
    const r = await this.run(['commit', '-m', message]);
    if (r.code !== 0) {
      // Git phrases an empty commit as "nothing to commit" or "no changes added to commit"
      // depending on whether the tree is clean or just has nothing staged.
      if (/nothing to commit|no changes added to commit/i.test(r.stdout + r.stderr)) return null;
      throw new GitError(`git commit failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const after = await this.head();
    return after && after !== before ? after : null;
  }

  /** Current HEAD commit hash, or null in an unborn repo. */
  async head(): Promise<string | null> {
    const r = await this.run(['rev-parse', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Recent commits (newest first). */
  async log(limit = 20): Promise<CommitInfo[]> {
    const fmt = ['%H', '%h', '%an', '%ad', '%s'].join(FIELD_SEP);
    const r = await this.run(['log', `-n${limit}`, `--pretty=format:${fmt}`, '--date=short']);
    if (r.code !== 0) return []; // unborn repo: no commits yet
    return r.stdout
      .split('\n')
      .filter((l) => l.includes(FIELD_SEP))
      .map((l) => {
        const [hash, shortHash, author, date, subject] = l.split(FIELD_SEP);
        return {
          hash     : hash ?? '',
          shortHash: shortHash ?? '',
          author   : author ?? '',
          date     : date ?? '',
          subject  : subject ?? '',
        };
      });
  }

  /**
   * The newest commit that touched `path`, or null where history has never recorded it.
   * `commit` cannot answer this: a file already committed by somebody else's sweep produces no
   * new commit, and a caller still needs to know where it landed.
   */
  async lastCommitFor(path: string): Promise<string | null> {
    const r = await this.run(['log', '-n1', '--format=%H', '--', path]);
    const sha = r.stdout.trim();
    return r.code === 0 && sha.length > 0 ? sha : null;
  }

  // ---- history reads: one spawn each, parsed by `parse.ts` ----

  /**
   * Commits newest first, with parents, trailers and the files each touched. Pages with
   * `before`: the listing starts at that sha and drops it, so a root commit pages to nothing
   * rather than failing on `<sha>^`.
   */
  async history(opts: HistoryOptions = {}): Promise<HistoryEntry[]> {
    const limit = opts.limit ?? HISTORY_LIMIT;
    const args = ['log', `--format=${HISTORY_FORMAT}`, '--numstat', `-n${limit + 1}`];
    if (opts.author) args.push(`--author=${opts.author}`);
    args.push(opts.before ?? 'HEAD');
    if (opts.path) args.push('--', opts.path);
    const r = await this.run(args);
    if (r.code !== 0) return []; // unborn repo, or a sha that no longer exists
    const entries = parseHistory(r.stdout);
    if (opts.before && entries[0]?.sha === opts.before) entries.shift();
    return entries.slice(0, limit);
  }

  /** The paths one commit changed, with blob ids and line counts. */
  async changes(sha: string): Promise<Change[]> {
    const out = await this.ok([
      'diff-tree',
      '-r',
      '-M',
      '--root',
      '--raw',
      '--numstat',
      '--no-commit-id',
      sha,
    ]);
    return parseChanges(out);
  }

  /**
   * The unified diff of one path at `sha`, against its first parent unless `against` names
   * another commit. A root commit diffs against the empty tree.
   */
  async diffPath(sha: string, path: string, against?: string): Promise<PathDiff> {
    const args = against
      ? ['diff', against, sha, '--', path]
      : ['diff-tree', '-p', '--root', '--no-commit-id', sha, '--', path];
    const text = await this.ok(args);
    return { text, binary: /^Binary files .* differ$|^GIT binary patch$/m.test(text) };
  }

  /** The bytes of `path` at `sha`, or null when the commit has no such path. */
  async blob(sha: string, path: string): Promise<Buffer | null> {
    const r = await runBytes(this.root, ['show', `${sha}:${path}`]);
    return r.code === 0 ? r.stdout : null;
  }

  /**
   * Absolute paths inside the git directory, one per name. `.git` is a file in a linked
   * worktree, so nothing may spell `<root>/.git/<name>` itself.
   */
  private async gitPaths(...names: string[]): Promise<string[]> {
    const out = await this.ok(['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
    return out
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => resolvePath(this.root, l.trim()));
  }

  /**
   * Whether a rebase, merge or revert is in progress, and where a rebase stopped. Nothing is in
   * progress outside a repository.
   */
  async inProgress(): Promise<InProgress> {
    const paths = await this.gitPaths(
      'rebase-merge',
      'rebase-apply',
      'MERGE_HEAD',
      'REVERT_HEAD',
    ).catch(() => null);
    if (!paths) return NOTHING_IN_PROGRESS;
    const [merging, applying, mergeHead, revertHead] = paths;
    const exists = async (p: string | undefined): Promise<boolean> =>
      p !== undefined &&
      (await stat(p).then(
        () => true,
        () => false,
      ));
    const read = async (dir: string, name: string): Promise<string | null> =>
      readFile(join(dir, name), 'utf8').then(
        (s) => s.trim(),
        () => null,
      );
    let rebase: RebaseState | null = null;
    const dir = (await exists(merging)) ? merging : (await exists(applying)) ? applying : null;
    if (dir) {
      // the am backend's `rebase-apply` spells the position `next`/`last`
      const [head, onto, current, total, stopped] = await Promise.all([
        read(dir, 'head-name'),
        read(dir, 'onto'),
        read(dir, dir === merging ? 'msgnum' : 'next'),
        read(dir, dir === merging ? 'end' : 'last'),
        read(dir, 'stopped-sha'),
      ]);
      rebase = {
        branch    : head?.replace(/^refs\/heads\//, '') ?? null,
        onto      : onto ?? '',
        current   : Number(current ?? 0),
        total     : Number(total ?? 0),
        stoppedSha: stopped,
      };
    }
    return { rebase, merge: await exists(mergeHead), revert: await exists(revertHead) };
  }

  /** Every remote and its fetch URL. */
  async remotes(): Promise<{ name: string; url: string }[]> {
    const out = await this.ok(['remote', '-v']);
    const seen: { name: string; url: string }[] = [];
    for (const line of out.split('\n')) {
      const m = /^(\S+)\t(.*) \(fetch\)$/.exec(line);
      if (m) seen.push({ name: m[1]!, url: m[2]! });
    }
    return seen;
  }

  /**
   * The remote and branch `branch` tracks, or null when it tracks nothing. Defaults to the
   * current branch, which is the wrong one mid-rebase; pass `inProgress().rebase.branch` then.
   */
  async upstream(branch?: string): Promise<{ remote: string; branch: string } | null> {
    const name = branch ?? (await this.branch());
    if (name === 'HEAD') return null;
    const remote = await this.configGet(`branch.${name}.remote`);
    const merge = await this.configGet(`branch.${name}.merge`);
    if (!remote || !merge) return null;
    return { remote, branch: merge.replace(/^refs\/heads\//, '') };
  }

  /** The branch header and the worktree entries in one spawn (`status --porcelain=v2 --branch`). */
  async branchStatus(): Promise<BranchStatus> {
    return parseStatusV2(await this.ok(['status', '--porcelain=v2', '--branch']));
  }

  /** Creates the annotated tag `CHECKPOINT_PREFIX + slug` at `sha` with `message`. */
  async tag(slug: string, sha: string, message: string): Promise<void> {
    await this.ok(['tag', '-a', `${CHECKPOINT_TAG}${slug}`, '-m', message, sha]);
  }

  /** Every checkpoint, in refname order. */
  async checkpoints(): Promise<Checkpoint[]> {
    const out = await this.ok(['for-each-ref', `--format=${CHECKPOINT_FORMAT}`, CHECKPOINT_PREFIX]);
    return parseCheckpoints(out);
  }

  /** Deletes a checkpoint. Missing is not an error. */
  async deleteTag(slug: string): Promise<void> {
    await this.run(['tag', '-d', `${CHECKPOINT_TAG}${slug}`]);
  }

  /**
   * When any remote was last fetched, as an ISO timestamp, or null if never. Every fetch
   * rewrites `FETCH_HEAD`, so this cannot be answered per remote.
   */
  async lastFetch(): Promise<string | null> {
    const [file] = await this.gitPaths('FETCH_HEAD');
    if (!file) return null;
    return stat(file).then(
      (s) => s.mtime.toISOString(),
      () => null,
    );
  }

  /** Show a commit (metadata + patch). */
  async show(ref: string): Promise<string> {
    return this.ok(['show', ref]);
  }

  /** Unified diff. With no ref, the working tree vs HEAD; otherwise `git diff <ref>`. */
  async diff(opts: { ref?: string; paths?: string[]; staged?: boolean } = {}): Promise<string> {
    const args = ['diff'];
    if (opts.staged) args.push('--cached');
    if (opts.ref) args.push(opts.ref);
    if (opts.paths && opts.paths.length > 0) args.push('--', ...opts.paths);
    return this.ok(args);
  }

  /** Revert a commit, creating a new commit that undoes it (history-preserving). */
  async revert(ref: string): Promise<void> {
    await this.ok(['revert', '--no-edit', ref]);
  }

  /** Restore a path to its state at `ref` (defaults to HEAD). */
  async restore(path: string, ref = 'HEAD'): Promise<void> {
    await this.ok(['restore', '--source', ref, '--', path]);
  }

  // ---- remotes and sync ----

  /** Adds a remote. Git refuses a name already taken. */
  async remoteAdd(name: string, url: string): Promise<void> {
    await this.ok(['remote', 'add', name, url]);
  }

  /** Removes a remote and its tracking refs; the commits they named stay. */
  async remoteRemove(name: string): Promise<void> {
    await this.ok(['remote', 'remove', name]);
  }

  /** Changes a remote's URL. */
  async remoteSetUrl(name: string, url: string): Promise<void> {
    await this.ok(['remote', 'set-url', name, url]);
  }

  /** Makes `remote/branch` the upstream of the current branch, where `git pull` reads it too. */
  async setUpstream(remote: string, branch: string): Promise<void> {
    await this.ok(['branch', `--set-upstream-to=${remote}/${branch}`]);
  }

  /** Fetches one remote, tags included. */
  async fetch(remote: string): Promise<void> {
    await this.ok(['fetch', '--tags', remote]);
  }

  /** Pushes `branch` to `remote`, with any annotated tag reachable from it. Never forces. */
  async push(remote: string, branch: string): Promise<void> {
    await this.ok(['push', '--follow-tags', remote, branch]);
  }

  /**
   * Rebases the current branch onto `onto`. Answers whether it completed; false means it stopped
   * on a conflict and `inProgress()` now describes where.
   */
  async rebase(onto: string): Promise<boolean> {
    const r = await this.run(['rebase', onto]);
    if (r.code === 0) return true;
    if ((await this.inProgress()).rebase) return false;
    throw new GitError(`git rebase failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  /**
   * Continues a stopped rebase with whatever is staged. Answers whether it completed; false means
   * the next replayed commit stopped on a conflict of its own.
   */
  async rebaseContinue(): Promise<boolean> {
    // No editor: the replayed commit keeps its message
    const r = await this.run(['-c', 'core.editor=true', 'rebase', '--continue']);
    if (r.code === 0) return true;
    if ((await this.inProgress()).rebase) return false;
    throw new GitError(`git rebase --continue failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  /** Abandons a rebase, putting the branch back where it started. */
  async rebaseAbort(): Promise<void> {
    await this.ok(['rebase', '--abort']);
  }

  /** Abandons a merge someone started from a terminal. */
  async mergeAbort(): Promise<void> {
    await this.ok(['merge', '--abort']);
  }

  /**
   * Resolves one conflicted path to one side and stages it. `ours` and `theirs` are git's: during
   * a rebase `ours` is the branch being rebased onto (the collaborator's) and `theirs` the commit
   * being replayed (the author's). A side that deleted the path is resolved by deleting it.
   */
  async resolveSide(path: string, side: ConflictSide): Promise<void> {
    const r = await this.run(['checkout', `--${side}`, '--', path]);
    if (r.code === 0) {
      await this.add([path]);
      return;
    }
    // `checkout --ours` has no blob to write when that side deleted the path
    const stage = side === 'ours' ? '2' : '3';
    const listed = await this.ok(['ls-files', '-u', '--', path]);
    const present = listed.split('\n').some((l) => l.split('\t')[0]?.endsWith(` ${stage}`));
    if (present) throw new GitError(`git checkout --${side} failed: ${r.stderr.trim()}`);
    await this.ok(['rm', '--quiet', '--', path]);
  }

  /**
   * Whether reverting `sha` would apply cleanly, and which paths would conflict if not. Leaves
   * the worktree and index as they were. Callers must start from a clean tree: the fallback
   * for a git that leaves no `REVERT_HEAD` behind a clean dry run is `reset --hard HEAD`.
   */
  async revertDryRun(sha: string): Promise<RevertPreview> {
    const r = await this.run(['revert', '--no-commit', sha]);
    const conflicts =
      r.code === 0
        ? []
        : (await this.status()).entries
            .filter(
              (e) =>
                /U/.test(e.x + e.y) || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D'),
            )
            .map((e) => e.path);
    const aborted = await this.run(['revert', '--abort']);
    if (aborted.code !== 0) await this.ok(['reset', '--hard', 'HEAD']);
    if (r.code === 0) return { clean: true, conflicts: [] };
    return {
      clean: false,
      conflicts,
      ...(conflicts.length === 0 ? { reason: r.stderr.trim() || r.stdout.trim() } : {}),
    };
  }

  // ---- object plumbing: snapshots that never move HEAD or the index ----

  /**
   * The tree of the working copy as it stands, without touching HEAD, the index, or history.
   *
   * `paths` is a git pathspec, so `':(exclude)vngen/build'` scopes a snapshot to one data
   * class. Ignored files are excluded as usual, which is what keeps `keys/` out of a snapshot.
   * The resulting tree is unreferenced — park it under a ref (see `commitTree`/`updateRef`)
   * or `gc` may reclaim it.
   */
  async writeTree(paths: string[] = ['.']): Promise<string> {
    return this.withScratchIndex(async (index) => {
      await this.ok(['add', '-A', '--', ...paths], index);
      return (await this.ok(['write-tree'], index)).trim();
    });
  }

  /** Create a commit object for `tree`. Moves no ref — the caller decides where it lands. */
  async commitTree(
    tree: string,
    opts: { message: string; parents?: (string | null)[] },
  ): Promise<string> {
    const parents = (opts.parents ?? []).filter((p): p is string => Boolean(p));
    const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', opts.message];
    return (await this.ok(args)).trim();
  }

  /** The tree a commit points at. */
  async treeOf(commit: string): Promise<string> {
    return (await this.ok(['rev-parse', `${commit}^{tree}`])).trim();
  }

  /** Point a ref at `sha`, creating or moving it. */
  async updateRef(ref: string, sha: string): Promise<void> {
    await this.ok(['update-ref', ref, sha]);
  }

  /** Delete a ref. Missing is not an error. */
  async deleteRef(ref: string): Promise<void> {
    await this.run(['update-ref', '-d', ref]);
  }

  /** Every ref under `prefix`, e.g. `refs/vn/undo`. */
  async listRefs(prefix: string): Promise<RefInfo[]> {
    const out = await this.ok(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
    return out
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const [ref, sha] = l.trim().split(' ');
        return { ref: ref ?? '', sha: sha ?? '' };
      });
  }

  /**
   * Move the working copy from tree `from` to tree `to`, leaving HEAD, the index and history
   * alone. Paths in neither tree — anything the snapshot's pathspec excluded — are untouched.
   *
   * Seeding the scratch index with `from` is what makes the delete half work: a file created
   * after `from` is in neither tree, so a plain checkout would leave it behind. Git only knows
   * to remove it because the seeded index says it was there.
   */
  async applyTree(from: string, to: string): Promise<void> {
    await this.withScratchIndex(async (index) => {
      await this.ok(['read-tree', from], index);
      await this.ok(['read-tree', '-u', '--reset', to], index);
    });
  }
}

/** Convenience constructor mirroring the other packages' factories. */
export function openGit(root: string): Git {
  return new Git(root);
}

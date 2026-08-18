/**
 * A thin, non-interactive wrapper over the `git` CLI (authoring-agent plan §5, M1). It
 * spawns `git` via `execFile` (never a shell, so paths/messages with spaces or quotes are
 * safe) and returns structured results. It holds **no policy**: gating reverts/restores,
 * dirty-tree checks, and commit granularity all live in the agent. Every method is scoped
 * to one repo `root`.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError } from './errors.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a git subcommand in `cwd`, capturing output. Never throws on non-zero exit. */
function run(cwd: string, args: string[], indexFile?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        ...(indexFile ? { env: { ...process.env, GIT_INDEX_FILE: indexFile } } : {}),
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

/** Distinguishes scratch index files, so two processes on one repo cannot collide. */
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
   * answers *which* repo — a `root` inside a nested repository reports the inner one, which is
   * what git itself would operate on.
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
   * `trailers` are appended as a `Key: value` block after a blank line — the provenance seam
   * commit-on-save writes a command's seq and invocation into. Mechanical, like everything
   * else here: which trailers mean what is the caller's business.
   */
  async commit(opts: {
    message: string;
    paths?: string[];
    trailers?: Record<string, string>;
  }): Promise<string | null> {
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
          hash: hash ?? '',
          shortHash: shortHash ?? '',
          author: author ?? '',
          date: date ?? '',
          subject: subject ?? '',
        };
      });
  }

  /**
   * The newest commit that touched `path`, or null where history has never recorded it. The
   * question `commit` cannot answer: a file already committed by somebody else's sweep produces
   * no new commit, and a caller that wanted to know *where it landed* still needs an answer.
   */
  async lastCommitFor(path: string): Promise<string | null> {
    const r = await this.run(['log', '-n1', '--format=%H', '--', path]);
    const sha = r.stdout.trim();
    return r.code === 0 && sha.length > 0 ? sha : null;
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

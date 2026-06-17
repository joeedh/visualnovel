/**
 * A thin, non-interactive wrapper over the `git` CLI (authoring-agent plan §5, M1). It
 * spawns `git` via `execFile` (never a shell, so paths/messages with spaces or quotes are
 * safe) and returns structured results. It holds **no policy**: gating reverts/restores,
 * dirty-tree checks, and commit granularity all live in the agent. Every method is scoped
 * to one repo `root`.
 */
import { execFile } from 'node:child_process';
import { GitError } from './errors.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a git subcommand in `cwd`, capturing output. Never throws on non-zero exit. */
function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
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

/** A non-interactive handle to one git repository. */
export class Git {
  constructor(readonly root: string) {}

  private run(args: string[]): Promise<RunResult> {
    return run(this.root, args);
  }

  private async ok(args: string[]): Promise<string> {
    const r = await this.run(args);
    if (r.code !== 0) {
      throw new GitError(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  }

  /** True if `root` is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    const r = await this.run(['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  /** Initialize a new repository at `root`. */
  async init(): Promise<void> {
    await this.ok(['init']);
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
   */
  async commit(opts: { message: string; paths?: string[] }): Promise<string | null> {
    if (opts.paths && opts.paths.length > 0) await this.add(opts.paths);
    const before = await this.head();
    const r = await this.run(['commit', '-m', opts.message]);
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
}

/** Convenience constructor mirroring the other packages' factories. */
export function openGit(root: string): Git {
  return new Git(root);
}

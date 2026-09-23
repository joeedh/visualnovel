/**
 * The repositories commit-on-save writes to, kept current across the session. A submodule added
 * or a `git init` run in `wiki/` while the app is open is committed to from the next act, rather
 * than only after a restart.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspace } from '@vn/authoring';
import { openGit, type Git } from '@vn/git';
import { ProjectPaths } from '@vn/store';
import { adoptSubmodules, ownsRepo, type SubmoduleNotice } from './workspace.js';

export interface RepoListOptions {
  /** Called with what `adoptSubmodules` found on each lookup after the first. */
  notice?(notices: SubmoduleNotice[]): Promise<void> | void;
  /** Called for a part left out because it is not the project's own repository. */
  skipped?(message: string): void;
}

export class RepoList {
  private repos: Git[] = [];
  /** What `stamp()` answered at the last lookup; null before the first. */
  private seen: string | null = null;

  constructor(
    readonly root: string,
    private readonly opts: RepoListOptions = {},
  ) {}

  /**
   * Runs the full lookup at open and answers what `adoptSubmodules` found, for the caller to post
   * once its notification hub is open.
   */
  async open(): Promise<SubmoduleNotice[]> {
    return this.lookup();
  }

  /**
   * The owned repositories. Checks a handful of paths with `stat` first, and repeats the full
   * lookup, which spawns git several times, only when one of them changed.
   */
  async current(): Promise<Git[]> {
    if ((await this.stamp()) !== this.seen) {
      const notices = await this.lookup();
      if (notices.length > 0) await this.opts.notice?.(notices);
    }
    return this.repos;
  }

  /**
   * Everything that changes which repositories the project spans: a `.git` appearing or going
   * away at the project, `wiki/` or the base assets, and an edit to `.gitmodules`.
   */
  private async stamp(): Promise<string> {
    const paths = new ProjectPaths(this.root);
    // Only a `.git`'s kind: every commit writes inside the directory, which moves its mtime
    const gits = [this.root, paths.wikiDir, paths.baseAssets].map((dir) =>
      stat(join(dir, '.git')).then(
        (s) => (s.isDirectory() ? 'dir' : 'file'),
        () => '-',
      ),
    );
    const modules = stat(join(this.root, '.gitmodules')).then(
      (s) => String(s.mtimeMs),
      () => '-',
    );
    return (await Promise.all([...gits, modules])).join('|');
  }

  private async lookup(): Promise<SubmoduleNotice[]> {
    // Taken before the lookup, so a change made while it runs is seen by the next call
    this.seen = await this.stamp();
    // A project inside a larger repo is skipped, for the reason `commitScaffolding` skips it
    const notices = (await ownsRepo(this.root)) ? await adoptSubmodules(this.root) : [];
    const repos: Git[] = [];
    for (const ref of await new Workspace(this.root).repos()) {
      if (ref.owned) repos.push(openGit(ref.root));
      else if (ref.missing)
        this.opts.skipped?.(`${ref.root} is a submodule that is not checked out`);
      else this.opts.skipped?.(`${ref.role} sits inside ${ref.root}; not committing there`);
    }
    this.repos = repos;
    return notices;
  }
}

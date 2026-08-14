import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit, RepoResolver } from '../index.js';

/** A repo at `dir` with a deterministic identity (no global config bleed). */
async function initRepo(dir: string): Promise<void> {
  const git = openGit(dir);
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'Test');
  await git.config('core.autocrlf', 'false');
}

/**
 * Temp dirs are symlinked on some platforms (`/var` → `/private/var`) and git reports the
 * resolved path, so every expectation goes through the same realpath the resolver would see.
 */
async function tempTree(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const made = await fs.mkdtemp(join(tmpdir(), 'vn-repos-'));
  const root = await fs.realpath(made);
  return { root, cleanup: () => fs.rm(made, { recursive: true, force: true }) };
}

describe('RepoResolver', () => {
  it('resolves a path to its owning repo, and a nested repo to the inner one', async () => {
    const { root, cleanup } = await tempTree();
    try {
      const project = join(root, 'project');
      const wiki = join(project, 'wiki');
      await fs.mkdir(join(project, 'scenes'), { recursive: true });
      await fs.mkdir(join(wiki, 'history'), { recursive: true });
      await initRepo(project);
      await initRepo(wiki);

      const resolver = new RepoResolver();
      expect(await resolver.rootOf(join(project, 'scenes'))).toBe(project);
      expect(await resolver.rootOf(join(wiki, 'history'))).toBe(wiki);
    } finally {
      await cleanup();
    }
  });

  it('resolves a file that does not exist yet against its parent', async () => {
    const { root, cleanup } = await tempTree();
    try {
      await fs.mkdir(join(root, 'scenes'), { recursive: true });
      await initRepo(root);

      const resolver = new RepoResolver();
      expect(await resolver.rootOf(join(root, 'scenes', 'not-written-yet.md'))).toBe(root);
    } finally {
      await cleanup();
    }
  });

  it('answers null outside any work tree', async () => {
    const { root, cleanup } = await tempTree();
    try {
      expect(await new RepoResolver().rootOf(root)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('partitions a mixed list by owner, keeping the un-owned under null', async () => {
    const { root, cleanup } = await tempTree();
    try {
      const project = join(root, 'project');
      const wiki = join(project, 'wiki');
      const loose = join(root, 'loose');
      await fs.mkdir(wiki, { recursive: true });
      await fs.mkdir(loose, { recursive: true });
      await initRepo(project);
      await initRepo(wiki);

      const groups = await new RepoResolver().group([
        join(project, 'project.yaml'),
        join(wiki, 'canal.md'),
        join(loose, 'stray.md'),
        join(project, 'scenes', 'arrival.md'),
      ]);

      expect(groups.get(project)).toEqual([
        join(project, 'project.yaml'),
        join(project, 'scenes', 'arrival.md'),
      ]);
      expect(groups.get(wiki)).toEqual([join(wiki, 'canal.md')]);
      expect(groups.get(null)).toEqual([join(loose, 'stray.md')]);
    } finally {
      await cleanup();
    }
  });

  it('remembers "no repo here" until told to forget', async () => {
    const { root, cleanup } = await tempTree();
    try {
      const resolver = new RepoResolver();
      expect(await resolver.rootOf(root)).toBeNull();

      await initRepo(root);
      expect(await resolver.rootOf(root)).toBeNull(); // the cached answer, honestly stale
      resolver.forget();
      expect(await resolver.rootOf(root)).toBe(root);
    } finally {
      await cleanup();
    }
  });

  it('hands the same Git back for two paths in one repo', async () => {
    const { root, cleanup } = await tempTree();
    try {
      await fs.mkdir(join(root, 'a'), { recursive: true });
      await fs.mkdir(join(root, 'b'), { recursive: true });
      await initRepo(root);

      const resolver = new RepoResolver();
      const first = await resolver.gitFor(join(root, 'a'));
      const second = await resolver.gitFor(join(root, 'b'));
      expect(first).toBe(second);
      expect(first?.root).toBe(root);
      expect(resolver.open(root)).toBe(first);
    } finally {
      await cleanup();
    }
  });
});

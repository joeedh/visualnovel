import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, openGit } from './index.js';

/** Make an isolated temp repo with a deterministic identity (no global config bleed). */
async function tempRepo(): Promise<{ git: Git; dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-git-'));
  const git = openGit(dir);
  await git.init();
  // Local identity so commits work on a clean CI box.
  await (git as unknown as { run: (a: string[]) => Promise<unknown> }).run([
    'config',
    'user.email',
    'test@example.com',
  ]);
  await (git as unknown as { run: (a: string[]) => Promise<unknown> }).run([
    'config',
    'user.name',
    'Test',
  ]);
  // Keep line endings byte-exact so revert/restore round-trips compare cleanly on Windows.
  await (git as unknown as { run: (a: string[]) => Promise<unknown> }).run([
    'config',
    'core.autocrlf',
    'false',
  ]);
  return { git, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const write = (dir: string, name: string, body: string) => fs.writeFile(join(dir, name), body);

describe('@vn/git', () => {
  it('detects a repo and an unborn HEAD', async () => {
    const { git, cleanup } = await tempRepo();
    try {
      expect(await git.isRepo()).toBe(true);
      expect(await git.head()).toBeNull();
      expect(await git.log()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('reports a non-repo directory', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-nogit-'));
    try {
      expect(await openGit(dir).isRepo()).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('stages, commits, and logs', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      await write(dir, 'a.md', 'hello\n');
      expect(await git.isDirty()).toBe(true);
      const hash = await git.commit({ message: 'Add a.md', paths: ['a.md'] });
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
      expect(await git.isDirty()).toBe(false);
      const log = await git.log();
      expect(log).toHaveLength(1);
      expect(log[0]!.subject).toBe('Add a.md');
      expect(log[0]!.hash).toBe(hash);
    } finally {
      await cleanup();
    }
  });

  it('returns null when there is nothing to commit', async () => {
    const { git, cleanup } = await tempRepo();
    try {
      expect(await git.commit({ message: 'empty' })).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('commits only the named paths, leaving other dirty files', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      await write(dir, 'a.md', 'a\n');
      await write(dir, 'b.md', 'b\n');
      await git.commit({ message: 'Add a only', paths: ['a.md'] });
      const status = await git.status();
      expect(status.entries.some((e) => e.path === 'b.md')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('diffs the working tree against HEAD', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      await write(dir, 'a.md', 'one\n');
      await git.commit({ message: 'init', paths: ['a.md'] });
      await write(dir, 'a.md', 'two\n');
      const diff = await git.diff();
      expect(diff).toContain('-one');
      expect(diff).toContain('+two');
    } finally {
      await cleanup();
    }
  });

  it('reverts a commit (history-preserving)', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      await write(dir, 'a.md', 'base\n');
      await git.commit({ message: 'base', paths: ['a.md'] });
      await write(dir, 'a.md', 'changed\n');
      const target = await git.commit({ message: 'change', paths: ['a.md'] });
      await git.revert(target!);
      expect(await fs.readFile(join(dir, 'a.md'), 'utf8')).toBe('base\n');
      expect(await git.log()).toHaveLength(3); // base + change + revert
    } finally {
      await cleanup();
    }
  });

  it('restores a file to HEAD', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      await write(dir, 'a.md', 'committed\n');
      await git.commit({ message: 'init', paths: ['a.md'] });
      await write(dir, 'a.md', 'scratch\n');
      await git.restore('a.md');
      expect(await fs.readFile(join(dir, 'a.md'), 'utf8')).toBe('committed\n');
    } finally {
      await cleanup();
    }
  });
});

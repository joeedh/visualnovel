import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, openGit } from '../index.js';

/** Make an isolated temp repo with a deterministic identity (no global config bleed). */
async function tempRepo(): Promise<{ git: Git; dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-git-'));
  const git = openGit(dir);
  await git.init();
  // Local identity so commits work on a clean CI box.
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'Test');
  // Keep line endings byte-exact so revert/restore round-trips compare cleanly on Windows.
  await git.config('core.autocrlf', 'false');
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

  it('reads back repo-local config, and answers null for an unset key', async () => {
    const { git, cleanup } = await tempRepo();
    try {
      expect(await git.configGet('user.name')).toBe('Test');
      expect(await git.configGet('vn.nothing.set')).toBeNull();
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

  it('writes trailers as a block below the subject', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      await write(dir, 'a.md', 'a\n');
      await git.commit({
        message: 'Moved line L4 into rooftop',
        paths: ['-A'],
        trailers: { 'Vn-Command': 'story.moveLine', 'Vn-Seq': '12' },
      });
      const shown = await git.show('HEAD');
      expect(shown).toContain('Moved line L4 into rooftop');
      expect(shown).toContain('Vn-Command: story.moveLine');
      expect(shown).toContain('Vn-Seq: 12');
      // The subject stays the subject — trailers are body, not part of the one-line summary.
      expect((await git.log(1))[0]?.subject).toBe('Moved line L4 into rooftop');
    } finally {
      await cleanup();
    }
  });

  it('reports the work-tree root, and null outside one', async () => {
    const { git, dir, cleanup } = await tempRepo();
    try {
      expect(await git.topLevel()).toBe((await fs.realpath(dir)).replace(/\\/g, '/'));
    } finally {
      await cleanup();
    }
    const bare = await fs.mkdtemp(join(tmpdir(), 'vn-nogit-'));
    try {
      expect(await openGit(bare).topLevel()).toBeNull();
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
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

  describe('snapshot plumbing', () => {
    it('writes a tree of the working copy, honoring an exclude pathspec', async () => {
      const { git, dir, cleanup } = await tempRepo();
      try {
        await fs.mkdir(join(dir, 'gen'), { recursive: true });
        await write(dir, 'doc.md', 'authored\n');
        await write(dir, 'gen/big.bin', 'generated\n');

        const tree = await git.writeTree(['.', ':(exclude)gen']);
        const listed = await git.show(tree);
        expect(listed).toContain('doc.md');
        expect(listed).not.toContain('big.bin');
      } finally {
        await cleanup();
      }
    });

    it('leaves HEAD and the real index alone', async () => {
      const { git, dir, cleanup } = await tempRepo();
      try {
        await write(dir, 'a.md', 'one\n');
        await git.commit({ message: 'init', paths: ['a.md'] });
        await write(dir, 'untracked.md', 'not staged\n');

        const head = await git.head();
        await git.writeTree();

        expect(await git.head()).toBe(head);
        // Still untracked (`??`), not staged — a snapshot must not touch the author's index.
        const status = await git.status();
        expect(status.entries).toEqual([{ x: '?', y: '?', path: 'untracked.md' }]);
      } finally {
        await cleanup();
      }
    });

    it('moves the working copy between two trees, deletions included', async () => {
      const { git, dir, cleanup } = await tempRepo();
      try {
        await fs.mkdir(join(dir, 'gen'), { recursive: true });
        await write(dir, 'keep.md', 'before\n');
        await write(dir, 'doomed.md', 'exists\n');
        await write(dir, 'gen/out.bin', 'generated\n');
        const scope = ['.', ':(exclude)gen'];
        const before = await git.writeTree(scope);

        // A modification, a creation, and a deletion — the three cases undo has to reverse.
        await write(dir, 'keep.md', 'after\n');
        await write(dir, 'added.md', 'new\n');
        await fs.rm(join(dir, 'doomed.md'));
        await write(dir, 'gen/out.bin', 'regenerated\n');
        const after = await git.writeTree(scope);

        await git.applyTree(after, before);
        expect(await fs.readFile(join(dir, 'keep.md'), 'utf8')).toBe('before\n');
        expect(await fs.readFile(join(dir, 'doomed.md'), 'utf8')).toBe('exists\n');
        await expect(fs.access(join(dir, 'added.md'))).rejects.toThrow();
        // Outside the pathspec, so in neither tree: undo has no opinion about generated output.
        expect(await fs.readFile(join(dir, 'gen/out.bin'), 'utf8')).toBe('regenerated\n');

        await git.applyTree(before, after);
        expect(await fs.readFile(join(dir, 'keep.md'), 'utf8')).toBe('after\n');
        expect(await fs.readFile(join(dir, 'added.md'), 'utf8')).toBe('new\n');
      } finally {
        await cleanup();
      }
    });

    it('parks a snapshot under a private ref, invisible to the log', async () => {
      const { git, dir, cleanup } = await tempRepo();
      try {
        await write(dir, 'a.md', 'one\n');
        await git.commit({ message: 'init', paths: ['a.md'] });
        await write(dir, 'a.md', 'two\n');

        const tree = await git.writeTree();
        const snap = await git.commitTree(tree, {
          message: 'vn: pre 1',
          parents: [await git.head()],
        });
        await git.updateRef('refs/vn/undo/1/pre', snap);

        expect(await git.listRefs('refs/vn/undo')).toEqual([
          { ref: 'refs/vn/undo/1/pre', sha: snap },
        ]);
        expect(await git.treeOf(snap)).toBe(tree);
        // The author's history never mentions it.
        expect((await git.log()).map((c) => c.subject)).toEqual(['init']);

        await git.deleteRef('refs/vn/undo/1/pre');
        expect(await git.listRefs('refs/vn/undo')).toEqual([]);
        await git.deleteRef('refs/vn/undo/1/pre'); // missing is not an error
      } finally {
        await cleanup();
      }
    });

    it('snapshots an unborn repo', async () => {
      const { git, dir, cleanup } = await tempRepo();
      try {
        await write(dir, 'a.md', 'one\n');
        const tree = await git.writeTree();
        // No HEAD to parent onto — the snapshot is still a valid, restorable root commit.
        const snap = await git.commitTree(tree, { message: 'vn: pre 1', parents: [null] });
        expect(await git.treeOf(snap)).toBe(tree);
      } finally {
        await cleanup();
      }
    });
  });
});

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { UndoJournal } from '../undo.js';

/**
 * A real repo, because the journal's whole job is git behaviour: what a snapshot includes,
 * whether the working copy actually moves, and whether drift is detected. The stack's
 * bookkeeping around it is tested against a fake in `stack.test.ts`.
 */
async function tempWorkspace() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-undo-'));
  const git = openGit(dir);
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'Test');
  await git.config('core.autocrlf', 'false');
  await fs.mkdir(join(dir, 'gen'), { recursive: true });
  await fs.writeFile(join(dir, 'doc.md'), 'authored\n');
  await fs.writeFile(join(dir, 'gen/asset.bin'), 'generated\n');
  await git.commit({ message: 'init', paths: ['.'] });

  // The desktop app's scoping: documents in, generated output out.
  const journal = new UndoJournal({ git, paths: ['.', ':(exclude)gen'], keep: 2 });
  return { dir, git, journal, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const read = (dir: string, name: string) => fs.readFile(join(dir, name), 'utf8');

describe('UndoJournal', () => {
  it('captures, restores, and leaves generated output alone', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const pre = (await journal.capture(1, 'pre'))!;
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      await fs.writeFile(join(dir, 'gen/asset.bin'), 'regenerated\n');
      const post = (await journal.capture(1, 'post'))!;

      await journal.restore(post.tree, pre.commit);
      expect(await read(dir, 'doc.md')).toBe('authored\n');
      // Excluded from the pathspec, so it is in neither tree and undo has no opinion on it.
      expect(await read(dir, 'gen/asset.bin')).toBe('regenerated\n');

      await journal.restore(pre.tree, post.commit);
      expect(await read(dir, 'doc.md')).toBe('edited\n');
    } finally {
      await cleanup();
    }
  });

  it('round-trips a created and a deleted document', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const pre = (await journal.capture(1, 'pre'))!;
      await fs.writeFile(join(dir, 'new.md'), 'a new scene\n');
      await fs.rm(join(dir, 'doc.md'));
      const post = (await journal.capture(1, 'post'))!;

      // The half `git restore` cannot do: undoing a creation means *deleting* the file, and
      // undoing a deletion means bringing it back.
      await journal.restore(post.tree, pre.commit);
      await expect(read(dir, 'new.md')).rejects.toThrow(/ENOENT/);
      expect(await read(dir, 'doc.md')).toBe('authored\n');

      await journal.restore(pre.tree, post.commit);
      expect(await read(dir, 'new.md')).toBe('a new scene\n');
      await expect(read(dir, 'doc.md')).rejects.toThrow(/ENOENT/);
    } finally {
      await cleanup();
    }
  });

  it('accepts a workspace still where the snapshot left it, and refuses one that moved', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const snap = (await journal.capture(1, 'post'))!;
      expect(await journal.check(snap.commit)).toEqual({ ok: true, tree: snap.tree });

      await fs.writeFile(join(dir, 'doc.md'), 'hand-edited\n');
      const drifted = await journal.check(snap.commit);
      expect(drifted.ok).toBe(false);
      expect(drifted.ok === false && drifted.error).toMatch(/workspace has changed/);
    } finally {
      await cleanup();
    }
  });

  it('ignores changes to generated output when deciding whether the workspace moved', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const snap = (await journal.capture(1, 'post'))!;
      // A pipeline run between the command and the undo must not block it: `build/` is not
      // part of the document tree, so a new asset does not read as drift.
      await fs.writeFile(join(dir, 'gen/new-asset.bin'), 'more output\n');
      expect((await journal.check(snap.commit)).ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('keeps the refs private, and prunes to the most recent commands', async () => {
    const { dir, git, journal, cleanup } = await tempWorkspace();
    try {
      for (const seq of [1, 2, 3]) {
        await fs.writeFile(join(dir, 'doc.md'), `v${seq}\n`);
        await journal.capture(seq, 'pre');
        await journal.capture(seq, 'post');
      }
      expect(await git.listRefs('refs/vn/undo')).toHaveLength(6);
      // Nothing about this is visible in the author's own history.
      expect((await git.log()).map((c) => c.subject)).toEqual(['init']);

      await journal.prune();
      const kept = (await git.listRefs('refs/vn/undo')).map((r) => r.ref).sort();
      expect(kept).toEqual([
        'refs/vn/undo/2/post',
        'refs/vn/undo/2/pre',
        'refs/vn/undo/3/post',
        'refs/vn/undo/3/pre',
      ]);

      // Idempotent, and it never reaches into the window it is meant to keep.
      await journal.prune();
      expect(await git.listRefs('refs/vn/undo')).toHaveLength(4);
    } finally {
      await cleanup();
    }
  });

  it('keeps everything while under the limit, including on an empty namespace', async () => {
    const { journal, git, cleanup } = await tempWorkspace();
    try {
      await journal.prune();
      await journal.capture(1, 'pre');
      await journal.prune();
      expect(await git.listRefs('refs/vn/undo')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('reports no snapshot outside a repo rather than throwing', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-nogit-'));
    try {
      const journal = new UndoJournal({ git: openGit(dir) });
      expect(await journal.capture(1, 'pre')).toBeNull();
      expect(await journal.currentTree()).toBeNull();
      expect(await journal.check('anything')).toMatchObject({ ok: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

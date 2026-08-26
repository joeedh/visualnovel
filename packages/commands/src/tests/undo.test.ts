import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit, type Git } from '@vn/git';
import { UndoJournal, type UndoPoint } from '../undo.js';

/** A repo with a deterministic identity (no global config bleed). */
async function initRepo(dir: string): Promise<Git> {
  const git = openGit(dir);
  await git.init();
  await git.config('user.email', 'test@example.com');
  await git.config('user.name', 'Test');
  await git.config('core.autocrlf', 'false');
  return git;
}

/**
 * A real repo, because the journal's whole job is git behaviour: what a snapshot includes,
 * whether the working copy actually moves, and whether drift is detected. The stack's
 * bookkeeping around it is tested against a fake in `stack.test.ts`.
 */
async function tempWorkspace() {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-undo-')));
  const git = await initRepo(dir);
  await fs.mkdir(join(dir, 'gen'), { recursive: true });
  await fs.writeFile(join(dir, 'doc.md'), 'authored\n');
  await fs.writeFile(join(dir, 'gen/asset.bin'), 'generated\n');
  await git.commit({ message: 'init', paths: ['.'] });

  // The desktop app's scoping: documents in, generated output out.
  const journal = new UndoJournal({ git, paths: ['.', ':(exclude)gen'], keep: 2 });
  return { dir, git, journal, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A project with the story bible in its own nested repo — the multi-repo case, minimally. */
async function tempMultiRepo() {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-undo-multi-')));
  const project = await initRepo(dir);
  await fs.writeFile(join(dir, 'doc.md'), 'authored\n');
  await project.commit({ message: 'init', paths: ['.'] });

  const wikiDir = join(dir, 'wiki');
  await fs.mkdir(wikiDir);
  const wiki = await initRepo(wikiDir);
  await fs.writeFile(join(wikiDir, 'lore.md'), 'lore\n');
  await wiki.commit({ message: 'init', paths: ['.'] });

  const journal = new UndoJournal({ git: [project, wiki], keep: 2 });
  return {
    dir,
    wikiDir,
    journal,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

const read = (dir: string, name: string) => fs.readFile(join(dir, name), 'utf8');

/** Check then restore, the pair the stack always calls together. Throws on a refusal. */
async function move(
  journal: UndoJournal,
  point: UndoPoint,
  from: 'pre' | 'post',
  to: 'pre' | 'post',
): Promise<string[]> {
  const checked = await journal.check(point, from);
  if (!checked.ok) throw new Error(checked.error);
  const { moved, error } = await journal.restore(checked.trees, point, to);
  if (error !== undefined) throw new Error(error);
  return moved;
}

describe('UndoJournal', () => {
  it('captures, restores, and leaves generated output alone', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const pre = (await journal.capture(1, 'pre'))!;
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      await fs.writeFile(join(dir, 'gen/asset.bin'), 'regenerated\n');
      const post = (await journal.capture(1, 'post'))!;
      const point = journal.point(pre, post);
      expect(point.changed).toBe(true);
      expect(point.repos).toBeUndefined(); // one repo: the record keeps its old shape

      await move(journal, point, 'post', 'pre');
      expect(await read(dir, 'doc.md')).toBe('authored\n');
      // Excluded from the pathspec, so it is in neither tree and undo has no opinion on it.
      expect(await read(dir, 'gen/asset.bin')).toBe('regenerated\n');

      await move(journal, point, 'pre', 'post');
      expect(await read(dir, 'doc.md')).toBe('edited\n');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('round-trips a created and a deleted document', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const pre = (await journal.capture(1, 'pre'))!;
      await fs.writeFile(join(dir, 'new.md'), 'a new scene\n');
      await fs.rm(join(dir, 'doc.md'));
      const post = (await journal.capture(1, 'post'))!;
      const point = journal.point(pre, post);

      // The half `git restore` cannot do: undoing a creation means deleting the file, and
      // undoing a deletion means bringing it back.
      await move(journal, point, 'post', 'pre');
      await expect(read(dir, 'new.md')).rejects.toThrow(/ENOENT/);
      expect(await read(dir, 'doc.md')).toBe('authored\n');

      await move(journal, point, 'pre', 'post');
      expect(await read(dir, 'new.md')).toBe('a new scene\n');
      await expect(read(dir, 'doc.md')).rejects.toThrow(/ENOENT/);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('accepts a workspace still where the snapshot left it, and refuses one that moved', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const snap = (await journal.capture(1, 'post'))!;
      const point = journal.point(snap, snap);
      expect(await journal.check(point, 'post')).toEqual({ ok: true, trees: { [dir]: snap.tree } });

      await fs.writeFile(join(dir, 'doc.md'), 'hand-edited\n');
      const drifted = await journal.check(point, 'post');
      expect(drifted.ok).toBe(false);
      expect(drifted.ok === false && drifted.error).toMatch(/workspace has changed/);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('ignores changes to generated output when deciding whether the workspace moved', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const snap = (await journal.capture(1, 'post'))!;
      // A pipeline run between the command and the undo must not block it: `gen/` is excluded
      // from the document tree, so a new asset does not read as drift.
      await fs.writeFile(join(dir, 'gen/new-asset.bin'), 'more output\n');
      expect((await journal.check(journal.point(snap, snap), 'post')).ok).toBe(true);
    } finally {
      await cleanup();
    }
  }, 20_000);

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

      // Pruning again is idempotent; it never removes refs inside the window it keeps.
      await journal.prune();
      expect(await git.listRefs('refs/vn/undo')).toHaveLength(4);
    } finally {
      await cleanup();
    }
  }, 20_000);

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
  }, 20_000);

  it('reports no snapshot outside a repo rather than throwing', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-nogit-'));
    try {
      const journal = new UndoJournal({ git: openGit(dir) });
      expect(await journal.capture(1, 'pre')).toBeNull();
      expect(await journal.currentTree()).toBeNull();
      const point: UndoPoint = { pre: 'anything', post: 'anything', changed: false };
      expect(await journal.check(point, 'post')).toMatchObject({ ok: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('snapshots and restores every repo one act touched', async () => {
    const { dir, wikiDir, journal, cleanup } = await tempMultiRepo();
    try {
      const pre = (await journal.capture(1, 'pre'))!;
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      await fs.writeFile(join(wikiDir, 'lore.md'), 'more lore\n');
      const post = (await journal.capture(1, 'post'))!;

      const point = journal.point(pre, post);
      expect(point.changed).toBe(true);
      expect(Object.keys(point.repos ?? {}).sort()).toEqual([dir, wikiDir].sort());

      const moved = await move(journal, point, 'post', 'pre');
      expect(moved.sort()).toEqual([dir, wikiDir].sort());
      expect(await read(dir, 'doc.md')).toBe('authored\n');
      expect(await read(wikiDir, 'lore.md')).toBe('lore\n');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('refuses as a unit when one repo drifted, leaving both worktrees alone', async () => {
    const { dir, wikiDir, journal, cleanup } = await tempMultiRepo();
    try {
      const pre = (await journal.capture(1, 'pre'))!;
      await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
      await fs.writeFile(join(wikiDir, 'lore.md'), 'more lore\n');
      const point = journal.point(pre, (await journal.capture(1, 'post'))!);

      await fs.writeFile(join(wikiDir, 'lore.md'), 'hand-edited elsewhere\n');
      const checked = await journal.check(point, 'post');
      expect(checked.ok).toBe(false);
      expect(checked.ok === false && checked.error).toMatch(/wiki/);

      // The clean repo is not restored on the strength of a check that failed in the other one.
      expect(await read(dir, 'doc.md')).toBe('edited\n');
      expect(await read(wikiDir, 'lore.md')).toBe('hand-edited elsewhere\n');
    } finally {
      await cleanup();
    }
  }, 20_000);
});

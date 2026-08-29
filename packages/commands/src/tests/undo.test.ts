import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UndoPoint } from '../command.js';
import { UndoJournal } from '../undo.js';

/**
 * Real directories, because the journal's whole job is filesystem behaviour: what a snapshot
 * includes, whether the working copy actually moves, and whether drift is detected. The stack's
 * bookkeeping around it is tested against a fake in `stack.test.ts`.
 */
async function tempWorkspace(opts: { keep?: number; maxBytes?: number } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-undo-')));
  await fs.mkdir(join(dir, 'gen'), { recursive: true });
  await fs.writeFile(join(dir, 'doc.md'), 'authored\n');
  await fs.writeFile(join(dir, 'gen/output.txt'), 'generated\n');

  // The desktop app's scoping: documents in, generated output out.
  const journal = new UndoJournal({ root: dir, exclude: ['gen'], keep: 2, ...opts });
  return { dir, journal, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const read = (dir: string, name: string) => fs.readFile(join(dir, name), 'utf8');

/** Check then restore, the pair the stack always calls together. Throws on a refusal. */
async function move(
  journal: UndoJournal,
  point: UndoPoint,
  from: 'pre' | 'post',
  to: 'pre' | 'post',
): Promise<void> {
  const checked = await journal.check(point, from);
  if (!checked.ok) throw new Error(checked.error);
  const { error } = await journal.restore(checked.tree, point, to);
  if (error !== undefined) throw new Error(error);
}

/** The two snapshots bracketing an edit, with the edit made by `edit`. */
async function bracket(journal: UndoJournal, seq: number, edit: () => Promise<void>) {
  const pre = (await journal.capture(seq))!;
  await edit();
  const post = (await journal.capture(seq))!;
  return journal.point(pre, post);
}

describe('UndoJournal', () => {
  it('captures, restores, and leaves generated output alone', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const point = await bracket(journal, 1, async () => {
        await fs.writeFile(join(dir, 'doc.md'), 'edited\n');
        await fs.writeFile(join(dir, 'gen/output.txt'), 'regenerated\n');
      });
      expect(point.changed).toBe(true);

      await move(journal, point, 'post', 'pre');
      expect(await read(dir, 'doc.md')).toBe('authored\n');
      // Excluded, so it is in neither tree and undo has no opinion on it.
      expect(await read(dir, 'gen/output.txt')).toBe('regenerated\n');

      await move(journal, point, 'pre', 'post');
      expect(await read(dir, 'doc.md')).toBe('edited\n');
    } finally {
      await cleanup();
    }
  });

  it('round-trips a created and a deleted document', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const point = await bracket(journal, 1, async () => {
        await fs.writeFile(join(dir, 'new.md'), 'a new scene\n');
        await fs.rm(join(dir, 'doc.md'));
      });

      // Undoing a creation means deleting the file, and undoing a deletion means bringing it back.
      await move(journal, point, 'post', 'pre');
      await expect(read(dir, 'new.md')).rejects.toThrow(/ENOENT/);
      expect(await read(dir, 'doc.md')).toBe('authored\n');

      await move(journal, point, 'pre', 'post');
      expect(await read(dir, 'new.md')).toBe('a new scene\n');
      await expect(read(dir, 'doc.md')).rejects.toThrow(/ENOENT/);
    } finally {
      await cleanup();
    }
  });

  it('round-trips a whole directory of documents', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const point = await bracket(journal, 1, async () => {
        await fs.mkdir(join(dir, 'scenes/act1'), { recursive: true });
        await fs.writeFile(join(dir, 'scenes/act1/open.md'), 'INT. ROOM\n');
      });

      await move(journal, point, 'post', 'pre');
      await expect(fs.stat(join(dir, 'scenes'))).rejects.toThrow(/ENOENT/);

      await move(journal, point, 'pre', 'post');
      expect(await read(dir, 'scenes/act1/open.md')).toBe('INT. ROOM\n');
    } finally {
      await cleanup();
    }
  });

  it('leaves a skipped file behind when the directory around it is undone away', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const point = await bracket(journal, 1, async () => {
        await fs.mkdir(join(dir, 'work'), { recursive: true });
        await fs.writeFile(join(dir, 'work/notes.md'), 'notes\n');
      });
      // Written after the snapshot and never part of it: media is skipped wherever it sits.
      await fs.writeFile(join(dir, 'work/plate.png'), 'bytes');

      await move(journal, point, 'post', 'pre');
      await expect(read(dir, 'work/notes.md')).rejects.toThrow(/ENOENT/);
      expect(await read(dir, 'work/plate.png')).toBe('bytes');
    } finally {
      await cleanup();
    }
  });

  it('accepts a workspace still where the snapshot left it, and refuses one that moved', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const snap = (await journal.capture(1))!;
      const point = journal.point(snap, snap);
      expect(await journal.check(point, 'post')).toEqual({ ok: true, tree: snap });

      await fs.writeFile(join(dir, 'doc.md'), 'hand-edited\n');
      const drifted = await journal.check(point, 'post');
      expect(drifted.ok).toBe(false);
      expect(drifted.ok === false && drifted.error).toMatch(/workspace has changed/);
    } finally {
      await cleanup();
    }
  });

  it('ignores generated output and media when deciding whether the workspace moved', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const snap = (await journal.capture(1))!;
      // A pipeline run between the command and the undo must not block it: `gen/` is excluded
      // from the document tree, and art is skipped wherever it lands.
      await fs.writeFile(join(dir, 'gen/new-output.txt'), 'more output\n');
      await fs.writeFile(join(dir, 'portrait.png'), 'pretend art');
      // The temp sibling an atomic write leaves behind is mid-write by definition.
      await fs.writeFile(join(dir, 'doc.md.tmp-ab12cd'), 'half a save');
      expect((await journal.check(journal.point(snap, snap), 'post')).ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('re-reads a document only when it moved', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      await journal.capture(1);
      const before = journal.store.stats().blobs;
      expect(await journal.capture(1)).toBe(await journal.currentTree());
      expect(journal.store.stats().blobs).toBe(before);

      await fs.writeFile(join(dir, 'doc.md'), 'a different length entirely\n');
      await journal.capture(2);
      expect(journal.store.stats().blobs).toBe(before + 1);
    } finally {
      await cleanup();
    }
  });

  it('prunes to the most recent commands and refuses what it dropped', async () => {
    const { dir, journal, cleanup } = await tempWorkspace();
    try {
      const points: UndoPoint[] = [];
      for (const seq of [1, 2, 3]) {
        points.push(
          await bracket(journal, seq, () => fs.writeFile(join(dir, 'doc.md'), `v${seq}\n`)),
        );
      }
      journal.prune();

      // Two commands are kept, so the oldest one's starting tree is gone and undo says so rather
      // than restoring something it no longer holds. Its `post` tree survives because the next
      // command opened on the same bytes, and identical trees are one tree.
      const dropped = await journal.check(points[0]!, 'pre');
      expect(dropped.ok).toBe(false);
      expect(dropped.ok === false && dropped.error).toMatch(/no longer held/);
      expect((await journal.check(points[2]!, 'post')).ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('drops older commands to stay inside its byte ceiling', async () => {
    const { dir, journal, cleanup } = await tempWorkspace({ keep: 50, maxBytes: 4096 });
    try {
      const points: UndoPoint[] = [];
      for (const seq of [1, 2, 3, 4, 5]) {
        points.push(
          await bracket(journal, seq, () =>
            fs.writeFile(join(dir, 'doc.md'), `${String(seq).repeat(2000)}\n`),
          ),
        );
      }
      journal.prune();

      expect(journal.store.stats().bytes).toBeLessThanOrEqual(4096);
      // The newest command survives whatever the total, or there would be nothing to undo.
      expect((await journal.check(points[4]!, 'post')).ok).toBe(true);
      expect((await journal.check(points[0]!, 'post')).ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('is not charged for the bytes a host pinned beside it', async () => {
    const { dir, journal, cleanup } = await tempWorkspace({ keep: 50, maxBytes: 4096 });
    try {
      // A file cache sharing this store holds an asset against collection. Counting it against
      // the undo ceiling would trade the author's undo history for the host's cache.
      journal.store.pin(journal.store.putBlob(Buffer.alloc(8192, 7)));

      const points: UndoPoint[] = [];
      for (const seq of [1, 2, 3]) {
        points.push(
          await bracket(journal, seq, () => fs.writeFile(join(dir, 'doc.md'), `v${seq}\n`)),
        );
      }
      journal.prune();

      // The pin alone puts the store over the ceiling, and the oldest snapshot survives anyway.
      expect(journal.store.stats().bytes).toBeGreaterThan(4096);
      expect(journal.store.tree(points[0]!.pre)).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('reports no snapshot outside a directory rather than throwing', async () => {
    const journal = new UndoJournal({ root: join(tmpdir(), 'vn-undo-nowhere') });
    expect(await journal.capture(1)).toBeNull();
    expect(await journal.currentTree()).toBeNull();
    const point: UndoPoint = { pre: 'anything', post: 'anything', changed: false };
    expect(await journal.check(point, 'post')).toMatchObject({ ok: false });
  });
});

describe('UndoJournal, scoped to a subdirectory', () => {
  async function scopedWorkspace() {
    const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-undo-scoped-')));
    await fs.mkdir(join(dir, 'work/graphs'), { recursive: true });
    await fs.writeFile(join(dir, 'doc.md'), 'authored\n');
    await fs.writeFile(join(dir, 'work/graphs/scene.json'), '{"a":1}\n');
    const journal = new UndoJournal({ root: dir, keep: 2 });
    return { dir, journal, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }

  it('captures and restores within the subdirectory, leaving everything else alone', async () => {
    const { dir, journal, cleanup } = await scopedWorkspace();
    try {
      const pre = (await journal.captureScoped('work/graphs', 1))!;
      await fs.writeFile(join(dir, 'work/graphs/scene.json'), '{"a":2}\n');
      await fs.writeFile(join(dir, 'doc.md'), 'edited outside the scope\n');
      const post = (await journal.captureScoped('work/graphs', 1))!;
      const point = journal.point(pre, post);
      expect(point.changed).toBe(true);

      const restored = await journal.restoreScoped('work/graphs', post, point, 'pre');
      expect(restored.error).toBeUndefined();
      expect(await read(dir, 'work/graphs/scene.json')).toBe('{"a":1}\n');
      // Never part of the scoped tree, so a scoped restore has no opinion on it.
      expect(await read(dir, 'doc.md')).toBe('edited outside the scope\n');
    } finally {
      await cleanup();
    }
  });

  it('reports the current scoped tree without holding it against pruning', async () => {
    const { dir, journal, cleanup } = await scopedWorkspace();
    try {
      const snap = (await journal.captureScoped('work/graphs', 1))!;
      expect(await journal.currentTreeScoped('work/graphs')).toBe(snap);
      await fs.writeFile(join(dir, 'work/graphs/scene.json'), '{"a":2}\n');
      expect(await journal.currentTreeScoped('work/graphs')).not.toBe(snap);
    } finally {
      await cleanup();
    }
  });

  it('returns null when the scoped subdirectory does not exist yet, for both reads', async () => {
    const { journal, cleanup } = await scopedWorkspace();
    try {
      expect(await journal.captureScoped('work/missing', 1)).toBeNull();
      expect(await journal.currentTreeScoped('work/missing')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('pins a captureScoped tree under its own seq, the same way capture does', async () => {
    const { dir, journal, cleanup } = await scopedWorkspace();
    try {
      const first = (await journal.captureScoped('work/graphs', 1))!;
      await fs.writeFile(join(dir, 'work/graphs/scene.json'), '{"a":2}\n');
      const second = (await journal.captureScoped('work/graphs', 2))!;
      // keep: 2, so both survive; this is the guard against a checkpoint's own `post` capture
      // being collected out from under it by the very next prune.
      journal.prune();

      expect(journal.store.tree(first)).toBeDefined();
      expect(journal.store.tree(second)).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});

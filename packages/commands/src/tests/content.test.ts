import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentStore } from '../content.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-content-')));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = (rel: string, text: string) => fs.writeFile(join(dir, rel), text);

/** Let the clock move past the mtime just written, so the next read produces a trusted record. */
const settle = () => new Promise((done) => setTimeout(done, 5));

describe('ContentStore', () => {
  it('gives identical directory states the same hash, whatever order they were written in', async () => {
    await write('b.md', 'beta\n');
    await write('a.md', 'alpha\n');
    const first = await new ContentStore().capture(dir);

    await fs.rm(join(dir, 'a.md'));
    await write('a.md', 'alpha\n');
    expect(await new ContentStore().capture(dir)).toBe(first);
  });

  it('holds one blob for bytes that appear twice', async () => {
    const store = new ContentStore();
    await fs.mkdir(join(dir, 'nested'));
    await write('a.md', 'same\n');
    await write('nested/b.md', 'same\n');
    await store.capture(dir);
    expect(store.stats().blobs).toBe(1);
  });

  it('serves bytes back while the file is untouched, and stops once it moves', async () => {
    const store = new ContentStore();
    const path = join(dir, 'doc.md');
    await write('doc.md', 'written\n');
    // A record made in the same millisecond as the write is not trusted a second time: another
    // write inside the filesystem's timestamp resolution would be invisible to it.
    await settle();
    await store.capture(dir);

    expect(await store.cached(path)).toEqual(Buffer.from('written\n'));
    await write('doc.md', 'changed by somebody else\n');
    expect(await store.cached(path)).toBeUndefined();
  });

  it('takes bytes from a writer without reading them back', async () => {
    const store = new ContentStore();
    const path = join(dir, 'doc.md');
    await write('doc.md', 'written\n');
    const hash = await store.note(path, Buffer.from('written\n'));

    await settle();
    expect(store.blob(hash)).toEqual(Buffer.from('written\n'));
    // The capture finds the file already hashed, so it adds no second copy of the same bytes.
    await store.capture(dir);
    expect(store.stats().blobs).toBe(1);
  });

  it('drops what no tree reaches, and keeps what a pin holds', async () => {
    const store = new ContentStore();
    await write('doc.md', 'first\n');
    const first = await store.capture(dir);
    const pinned = store.putBlob(Buffer.from('nobody points at this\n'));
    store.pin(pinned);

    await write('doc.md', 'second\n');
    const second = await store.capture(dir);
    expect(store.stats().blobs).toBe(3);

    store.collect([second]);
    expect(store.tree(first)).toBeUndefined();
    expect(store.blob(pinned)).toBeDefined();
    expect(store.stats().blobs).toBe(2);

    store.release(pinned);
    store.collect([second]);
    expect(store.blob(pinned)).toBeUndefined();
  });

  it('refuses a restore whose bytes it no longer holds', async () => {
    const store = new ContentStore();
    await write('doc.md', 'first\n');
    const first = await store.capture(dir);
    await write('doc.md', 'second\n');
    const second = await store.capture(dir);

    store.collect([second]);
    await expect(store.restore(dir, second, first)).rejects.toThrow(/no longer held/);
  });

  it('leaves a file it did not change alone', async () => {
    const store = new ContentStore();
    await write('kept.md', 'unchanged\n');
    await write('edited.md', 'before\n');
    const first = await store.capture(dir);
    const stamp = (await fs.stat(join(dir, 'kept.md'))).mtimeMs;

    await write('edited.md', 'after\n');
    const second = await store.capture(dir);
    const changed = await store.restore(dir, second, first);

    expect(await fs.readFile(join(dir, 'edited.md'), 'utf8')).toBe('before\n');
    expect((await fs.stat(join(dir, 'kept.md'))).mtimeMs).toBe(stamp);
    // The file it left alone is not reported, which is what makes the list worth filtering on.
    expect(changed).toEqual(['edited.md']);
  });

  it('replaces a file with a directory of the same name, and back', async () => {
    const store = new ContentStore();
    await write('thing', 'a file\n');
    const asFile = await store.capture(dir);

    await fs.rm(join(dir, 'thing'));
    await fs.mkdir(join(dir, 'thing'));
    await write('thing/inside.md', 'a directory\n');
    const asDir = await store.capture(dir);

    const toFile = await store.restore(dir, asDir, asFile);
    expect(await fs.readFile(join(dir, 'thing'), 'utf8')).toBe('a file\n');
    // A kind change reports the deleted path and the created one separately.
    expect(toFile).toEqual(['thing/inside.md', 'thing']);

    const toDir = await store.restore(dir, asFile, asDir);
    expect(await fs.readFile(join(dir, 'thing/inside.md'), 'utf8')).toBe('a directory\n');
    expect(toDir).toEqual(['thing', 'thing/inside.md']);
  });

  /** Every path a restore moves, so a surface following one document can filter for its own. */
  describe('what a restore reports', () => {
    it('names a file it created and a file it deleted', async () => {
      const store = new ContentStore();
      await write('gone.md', 'here for now\n');
      const before = await store.capture(dir);

      await fs.rm(join(dir, 'gone.md'));
      await write('added.md', 'new\n');
      const after = await store.capture(dir);

      expect((await store.restore(dir, after, before)).sort()).toEqual(['added.md', 'gone.md']);
    });

    it('names a file nested under directories by its whole path', async () => {
      const store = new ContentStore();
      await fs.mkdir(join(dir, 'characters/aiko'), { recursive: true });
      await write('characters/aiko/character.md', 'before\n');
      const before = await store.capture(dir);

      await write('characters/aiko/character.md', 'after\n');
      const after = await store.capture(dir);

      expect(await store.restore(dir, after, before)).toEqual(['characters/aiko/character.md']);
    });

    it('names nothing where the two trees agree', async () => {
      const store = new ContentStore();
      await write('doc.md', 'settled\n');
      const tree = await store.capture(dir);

      expect(await store.restore(dir, tree, tree)).toEqual([]);
    });

    // A move that runs out of held bytes part way through has still moved what it reached, so the
    // caller is handed that list rather than left to assume the worktree never changed.
    it('keeps what it moved before it ran out of held bytes', async () => {
      const store = new ContentStore();
      await write('a.md', 'first\n');
      const before = await store.capture(dir);
      await write('a.md', 'second\n');
      const now = await store.capture(dir);

      // A target naming bytes the store never held. `putTree` sorts by name, so the move writes
      // `a.md` and then runs out on `b.md`.
      const restored = store.tree(before)!.find((e) => e.name === 'a.md')!;
      const target = store.putTree([
        restored,
        { name: 'b.md', kind: 'blob', hash: 'ab'.repeat(32) },
      ]);

      const changed: string[] = [];
      await expect(store.restore(dir, now, target, changed)).rejects.toThrow(/no longer held/);
      expect(changed).toEqual(['a.md']);
      expect(await fs.readFile(join(dir, 'a.md'), 'utf8')).toBe('first\n');
    });
  });
});

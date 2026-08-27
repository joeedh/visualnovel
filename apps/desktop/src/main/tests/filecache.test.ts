import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentStore } from '@vn/commands/snapshot';
import { FileCache } from '../filecache.js';

let root: string;
let store: ContentStore;
let cache: FileCache;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vn-filecache-'));
  store = new ContentStore();
  cache = new FileCache(store);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stored assets', () => {
  it('reads the file once and answers from memory after that', async () => {
    const path = join(root, 'deadbeef.png');
    await writeFile(path, 'pretend art');

    expect(Buffer.from(await cache.asset(path)).toString()).toBe('pretend art');
    // The name is the hash of the bytes, so there is nothing to revalidate: a file that changed
    // under a hashed name is a different asset with a different name.
    await rm(path);
    expect(Buffer.from(await cache.asset(path)).toString()).toBe('pretend art');
  });

  it('drops the oldest asset once it is over budget, and keeps the newest', async () => {
    const small = new FileCache(store, 24);
    const paths = ['a', 'b', 'c'].map((name) => join(root, `${name}.png`));
    for (const [index, path] of paths.entries()) await writeFile(path, `art-${index}`.repeat(2));
    for (const path of paths) await small.asset(path);

    await rm(paths[0]!);
    await expect(small.asset(paths[0]!)).rejects.toThrow(/ENOENT/);
    await rm(paths[2]!);
    expect(Buffer.from(await small.asset(paths[2]!)).toString()).toBe('art-2art-2');
  });

  it('lets go of what it held when the workspace changes under it', async () => {
    const path = join(root, 'deadbeef.png');
    await writeFile(path, 'pretend art');
    await cache.asset(path);

    cache.clear();
    store.collect([]);
    expect(store.stats().blobs).toBe(0);
  });
});

describe('documents', () => {
  it('re-reads a file that changed underneath it', async () => {
    const path = join(root, 'doc.md');
    await writeFile(path, 'first\n');
    expect(await cache.readText(path)).toBe('first\n');

    await writeFile(path, 'second\n');
    expect(await cache.readText(path)).toBe('second\n');
  });

  it('writes through to disk before it holds anything', async () => {
    const path = join(root, 'doc.md');
    await cache.write(path, 'saved\n');
    expect(await readFile(path, 'utf8')).toBe('saved\n');
    expect(await cache.readText(path)).toBe('saved\n');
  });

  it('holds bytes another writer put on disk, so a snapshot need not re-read them', async () => {
    const path = join(root, 'doc.md');
    await writeFile(path, 'written elsewhere\n');
    await cache.note(path, 'written elsewhere\n');
    expect(store.stats().blobs).toBe(1);

    // The capture finds those bytes already there rather than adding a second copy of them.
    await store.capture(root);
    expect(store.stats().blobs).toBe(1);
  });
});

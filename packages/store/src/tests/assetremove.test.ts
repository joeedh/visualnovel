/**
 * `AssetRoot.remove` and `reinstate`, which the collector and its undo use, and the
 * read-modify-write persist that stops an instance opened earlier from writing removed rows back.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRoot, AssetStore, ProjectPaths } from '../index.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const shot = { kind: 'shot_image' as const, sourceTask: 't', modelId: 'm' };

async function rowsIn(file: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { assets: { hash: string }[] };
  return parsed.assets.map((a) => a.hash);
}

describe('AssetRoot.remove and reinstate', () => {
  let root: string;
  let paths: ProjectPaths;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-remove-'));
    paths = new ProjectPaths(root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('removes the named rows and answers them, leaving the files alone', async () => {
    const store = await AssetStore.open(paths);
    const a = await store.write(bytes('A'), 'png', shot);
    const b = await store.write(bytes('B'), 'png', shot);

    const project = await AssetRoot.open(paths.assetsDir, paths.manifest);
    const removed = await project.remove([a.hash, 'not-a-row']);
    expect(removed.map((r) => r.hash)).toEqual([a.hash]);
    expect(await rowsIn(paths.manifest)).toEqual([b.hash]);
    expect(await readFile(store.pathOf(a), 'utf8')).toBe('A');
  });

  it('puts removed rows back as they were, skipping one the root already holds', async () => {
    const store = await AssetStore.open(paths);
    const a = await store.write(bytes('A'), 'png', shot);
    const project = await AssetRoot.open(paths.assetsDir, paths.manifest);
    const [row] = await project.remove([a.hash]);

    expect((await project.reinstate([row!])).map((r) => r.hash)).toEqual([a.hash]);
    expect(await project.reinstate([row!])).toEqual([]);
    const reopened = await AssetStore.open(paths);
    expect(reopened.get(a.hash)).toEqual(row);
  });

  it('does not bring back rows another instance removed when it persists later', async () => {
    const store = await AssetStore.open(paths);
    const a = await store.write(bytes('A'), 'png', shot);
    const b = await store.write(bytes('B'), 'png', shot);

    const stale = await AssetStore.open(paths);
    const collector = await AssetRoot.open(paths.assetsDir, paths.manifest);
    await collector.remove([a.hash]);
    // An unrelated write through the instance that still holds `a` in memory
    await stale.accept(b.hash);

    expect(await rowsIn(paths.manifest)).toEqual([b.hash]);
    expect((await AssetStore.open(paths)).get(b.hash)?.accepted).toBe(true);
  });
});

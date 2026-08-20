/**
 * The base/project store split (`docs/reference/asset-stores.md`): routing by kind, the union read, the
 * three base states, and the two compatibility guarantees — a legacy manifest keeps resolving,
 * and a single-record `satisfies` reads as a one-element list.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStore, ProjectPaths, baseAssetsOf } from '../index.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vn-roots-'));
}

const bytes = (s: string) => new TextEncoder().encode(s);
const meta = (kind: 'portrait' | 'shot_image', extra = {}) => ({
  kind,
  sourceTask: 't',
  modelId: 'm',
  ...extra,
});

describe('routing by kind', () => {
  it('writes base kinds to assets/ and shot images to vngen/build/', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);

    const portrait = await store.write(bytes('P'), 'png', meta('portrait'));
    const shot = await store.write(bytes('S'), 'png', meta('shot_image'));

    expect(store.pathOf(portrait)).toBe(paths.baseAssetFile(portrait.hash, 'png'));
    expect(store.pathOf(shot)).toBe(paths.assetFile(shot.hash, 'png'));
    expect(await readdir(paths.baseObjects)).toEqual([`${portrait.hash}.png`]);
    expect(await readdir(paths.assetsDir)).toEqual([`${shot.hash}.png`]);
  });

  it('reads both roots through one facade, and reopening finds both', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const portrait = await store.write(bytes('P'), 'png', meta('portrait'));
    const shot = await store.write(bytes('S'), 'png', meta('shot_image'));

    const reopened = await AssetStore.open(paths);
    expect(reopened.has(portrait.hash)).toBe(true);
    expect(reopened.has(shot.hash)).toBe(true);
    expect(new TextDecoder().decode(await reopened.read(portrait))).toBe('P');
    expect(new TextDecoder().decode(await reopened.read(shot))).toBe('S');
    expect(reopened.manifest()).toHaveLength(2);
    expect(reopened.base?.count).toBe(1);
  });

  // Content addressing means the two roots cannot disagree about bytes, only about provenance.
  it('deduplicates a hash held by both roots, base winning', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const shot = await store.write(bytes('SAME'), 'png', meta('shot_image', { sourceTask: 'p' }));
    const portrait = await store.write(bytes('SAME'), 'png', meta('portrait', { sourceTask: 'b' }));
    expect(portrait.hash).toBe(shot.hash);

    const manifest = (await AssetStore.open(paths)).manifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]!.kind).toBe('portrait');
    expect(manifest[0]!.sourceTask).toBe('b');
  });
});

describe('bindings', () => {
  it('merges a second binding into one record instead of replacing it', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    await store.write(bytes('SAME'), 'png', meta('shot_image', { satisfies: { shotId: 's1' } }));
    await store.write(bytes('SAME'), 'png', meta('shot_image', { satisfies: { shotId: 's2' } }));
    // Idempotent: writing the same binding twice does not grow the list.
    await store.write(bytes('SAME'), 'png', meta('shot_image', { satisfies: { shotId: 's2' } }));

    const asset = (await AssetStore.open(paths)).manifest()[0]!;
    expect(asset.satisfies).toEqual([{ shotId: 's1' }, { shotId: 's2' }]);
  });

  it('keeps acceptance across a re-write of the same bytes', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const ref = await store.write(bytes('P'), 'png', meta('portrait'));
    await store.accept(ref.hash);
    await store.write(bytes('P'), 'png', meta('portrait', { sourceTask: 'again' }));
    expect(store.manifest()[0]!.accepted).toBe(true);
  });
});

describe('base states', () => {
  it('absent: no assets/ directory, and the first base write creates it', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    expect(store.base?.state).toBe('absent');
    expect(store.base?.count).toBe(0);

    await store.write(bytes('P'), 'png', meta('portrait'));
    expect((await AssetStore.open(paths)).base?.state).toBe('ready');
  });

  // Exactly what a checkout missing the base repo/submodule leaves behind.
  it('unavailable: the directory is there and the manifest is not', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await mkdir(paths.baseAssets, { recursive: true });
    const store = await AssetStore.open(paths);
    expect(store.base?.state).toBe('unavailable');

    // Refusing the write is the last line: nothing may quietly re-index base art elsewhere.
    await expect(store.write(bytes('P'), 'png', meta('portrait'))).rejects.toThrow(/unavailable/);
    // A project asset is unaffected — it does not live there.
    await expect(store.write(bytes('S'), 'png', meta('shot_image'))).resolves.toBeDefined();
  });

  it('unavailable survives emptying a populated base root', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    await store.write(bytes('P'), 'png', meta('portrait'));
    await rm(paths.baseManifest);
    expect((await baseAssetsOf(paths)).state).toBe('unavailable');
  });

  it('baseAssetsOf agrees with the store without opening it', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    await store.write(bytes('P'), 'png', meta('portrait'));
    expect(await baseAssetsOf(paths)).toEqual(store.base);
  });
});

describe('manifests written before the split', () => {
  /** A pre-split `vngen/build/manifest.json`: base kinds indexed beside the shots. */
  async function writeLegacy(paths: ProjectPaths): Promise<void> {
    await mkdir(paths.assetsDir, { recursive: true });
    await writeFile(join(paths.assetsDir, 'abc.png'), bytes('P'));
    await writeFile(
      paths.manifest,
      JSON.stringify({
        version: 1,
        assets: [
          {
            hash: 'abc',
            ext: 'png',
            kind: 'portrait',
            sourceTask: 't',
            refs: [],
            modelId: 'm',
            satisfies: { characterId: 'aiko' },
            accepted: false,
          },
        ],
      }),
    );
  }

  it('keeps resolving base art from the project manifest — nothing moves', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await writeLegacy(paths);
    const store = await AssetStore.open(paths);

    expect(store.base?.state).toBe('absent');
    expect(store.has('abc')).toBe(true);
    expect(store.pathOf({ hash: 'abc', ext: 'png' })).toBe(paths.assetFile('abc', 'png'));
    expect(new TextDecoder().decode(await store.read({ hash: 'abc', ext: 'png' }))).toBe('P');
  });

  it('reads a single-record satisfies as a one-element list', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await writeLegacy(paths);
    const store = await AssetStore.open(paths);
    expect(store.manifest()[0]!.satisfies).toEqual([{ characterId: 'aiko' }]);

    // And normalizes it on the way back out, so the shim is needed once per file, not forever.
    await store.accept('abc');
    const written = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      assets: { satisfies: unknown }[];
    };
    expect(written.assets[0]!.satisfies).toEqual([{ characterId: 'aiko' }]);
  });
});

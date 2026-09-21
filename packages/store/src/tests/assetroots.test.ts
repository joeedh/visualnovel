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
  modelId   : 'm',
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

  // A hash in both roots names the same bytes with two provenances: a picture adopted across
  // them. The frame is the row bound to a slot, so it is the row reported.
  it('deduplicates a hash held by both roots, the project row winning when it is a frame', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const shot = await store.write(bytes('SAME'), 'png', meta('shot_image', { sourceTask: 'p' }));
    const portrait = await store.write(bytes('SAME'), 'png', meta('portrait', { sourceTask: 'b' }));
    expect(portrait.hash).toBe(shot.hash);

    const reopened = await AssetStore.open(paths);
    const manifest = reopened.manifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ kind: 'shot_image', sourceTask: 'p' });
    expect(reopened.get(shot.hash)).toMatchObject({ kind: 'shot_image' });

    // A flag write follows the same row, so accepting the frame leaves the base row alone.
    await reopened.accept(shot.hash);
    const base = JSON.parse(await readFile(paths.baseManifest, 'utf8')) as {
      assets: { accepted: boolean }[];
    };
    const project = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      assets: { accepted: boolean }[];
    };
    expect(base.assets[0]!.accepted).toBe(false);
    expect(project.assets[0]!.accepted).toBe(true);
    expect(reopened.manifestFileOf(shot.hash)).toBe(paths.manifest);
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

describe('hold and accept', () => {
  it('releases the takes it supersedes, and persists both halves together', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const old = await store.write(bytes('OLD'), 'png', meta('shot_image'));
    const fresh = await store.write(bytes('NEW'), 'png', meta('shot_image'));
    await store.hold(old.hash, []);
    await store.accept(old.hash);
    await store.hold(fresh.hash, [old.hash], { at: '2026-09-20T10:00:00.000Z', via: 'run' });

    // Read back from disk: a manifest recording two current takes is the state this prevents,
    // and the release leaves the old take's approval alone, as history.
    const reopened = (await AssetStore.open(paths)).manifest();
    expect(reopened.filter((a) => a.current).map((a) => a.hash)).toEqual([fresh.hash]);
    expect(reopened.find((a) => a.hash === old.hash)).toMatchObject({
      current : false,
      accepted: true,
    });
    expect(reopened.find((a) => a.hash === fresh.hash)).toMatchObject({
      current : true,
      accepted: false,
      at      : '2026-09-20T10:00:00.000Z',
      via     : 'run',
    });
  });

  it('restamps `at` on every hold and keeps the first `via`', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const ref = await store.write(bytes('A'), 'png', meta('shot_image'));
    await store.hold(ref.hash, [], { at: '2026-01-01T00:00:00.000Z', via: 'adopt' });
    await store.hold(ref.hash, [], { at: '2026-02-01T00:00:00.000Z', via: 'run' });
    expect(store.get(ref.hash)).toMatchObject({ at: '2026-02-01T00:00:00.000Z', via: 'adopt' });
  });

  it('accept sets the flag alone, so a take can be approved without being held', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const ref = await store.write(bytes('A'), 'png', meta('shot_image'));
    await store.accept(ref.hash);
    expect(store.get(ref.hash)).toMatchObject({ current: false, accepted: true });
  });

  it('a new row starts out held by nothing, and a re-write keeps the bits', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const ref = await store.write(bytes('P'), 'png', meta('portrait'));
    expect(store.get(ref.hash)!.current).toBe(false);
    await store.hold(ref.hash, [], { at: 't' });
    await store.write(bytes('P'), 'png', meta('portrait', { sourceTask: 'again' }));
    expect(store.get(ref.hash)).toMatchObject({ current: true, at: 't' });
  });

  it('routes the hold to the root the row lives in', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const portrait = await store.write(bytes('P'), 'png', meta('portrait'));
    const shot = await store.write(bytes('S'), 'png', meta('shot_image'));
    await store.hold(portrait.hash, []);
    await store.hold(shot.hash, []);
    const base = JSON.parse(await readFile(paths.baseManifest, 'utf8')) as {
      assets: { hash: string; current: boolean }[];
    };
    const project = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      assets: { hash: string; current: boolean }[];
    };
    expect(base.assets.map((a) => [a.hash, a.current])).toEqual([[portrait.hash, true]]);
    expect(project.assets.map((a) => [a.hash, a.current])).toEqual([[shot.hash, true]]);
  });

  it('refuses to hold base art while the base root is unavailable', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const first = await AssetStore.open(paths);
    const portrait = await first.write(bytes('P'), 'png', meta('portrait'));
    await rm(paths.baseManifest);
    const store = await AssetStore.open(paths);
    expect(store.base?.state).toBe('unavailable');
    // The row is not there to hold; nothing is written into another root in its place.
    await store.hold(portrait.hash, []);
    await store.accept(portrait.hash);
    expect(store.get(portrait.hash)).toBeUndefined();
    expect(store.manifest()).toEqual([]);
  });
});

describe('migrateTakes', () => {
  it('is owed while any row predates the bit, and goes quiet once every row is stamped', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await mkdir(paths.assetsDir, { recursive: true });
    await writeFile(
      paths.manifest,
      JSON.stringify({
        version: 1,
        assets: [
          {
            hash      : 'a',
            ext       : 'png',
            kind      : 'shot_image',
            sourceTask: 't',
            refs      : [],
            modelId   : 'm',
            accepted  : true,
            satisfies : [],
          },
          {
            hash      : 'b',
            ext       : 'png',
            kind      : 'shot_image',
            sourceTask: 't',
            refs      : [],
            modelId   : 'm',
            accepted  : false,
            satisfies : [],
          },
        ],
      }),
    );
    const store = await AssetStore.open(paths);
    expect(store.unstamped).toBe(true);
    await store.migrateTakes((row) =>
      row.hash === 'a' ? { current: true, via: 'migrated', at: 'then' } : { current: false },
    );
    expect(store.unstamped).toBe(false);
    const reopened = await AssetStore.open(paths);
    expect(reopened.unstamped).toBe(false);
    expect(reopened.get('a')).toMatchObject({ current: true, via: 'migrated', at: 'then' });
    expect(reopened.get('b')).toMatchObject({ current: false });
    expect(reopened.get('b')!.via).toBeUndefined();
  });

  it('backfills the angle onto an outfit binding that lacks one', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const sheet = await store.write(bytes('S'), 'png', {
      kind      : 'model_sheet',
      sourceTask: 't',
      modelId   : 'm',
      satisfies : { characterId: 'aiko', outfit: 'default' },
    });
    expect(store.unstamped).toBe(false);
    await store.migrateTakes(() => ({ current: true, angle: 'side' }));
    expect(store.get(sheet.hash)!.satisfies).toEqual([
      { characterId: 'aiko', outfit: 'default', angle: 'side' },
    ]);
    // A second pass leaves a binding that already names its angle alone.
    await store.migrateTakes(() => ({ current: true, angle: 'front' }));
    expect(store.get(sheet.hash)!.satisfies[0]!.angle).toBe('side');
  });

  it('stamps a hash both roots hold in both, so the trigger goes quiet', async () => {
    const paths = new ProjectPaths(await tempRoot());
    const store = await AssetStore.open(paths);
    const ref = await store.write(bytes('C'), 'png', meta('portrait'));
    await store.write(bytes('C'), 'png', meta('shot_image'));
    const decided: string[] = [];
    await store.migrateTakes((row) => {
      decided.push(row.kind);
      return { current: true };
    });
    // `decide` sees the project row, which answers for the hash; the base row is stamped false.
    expect(decided).toEqual(['shot_image']);
    expect(store.unstamped).toBe(false);
    expect(store.get(ref.hash)).toMatchObject({ kind: 'shot_image', current: true });
    const base = JSON.parse(await readFile(paths.baseManifest, 'utf8')) as {
      assets: { current: boolean }[];
    };
    expect(base.assets[0]!.current).toBe(false);
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

  // This is the state a checkout missing the base repo/submodule leaves behind.
  it('unavailable: the directory is there and the manifest is not', async () => {
    const paths = new ProjectPaths(await tempRoot());
    await mkdir(paths.baseAssets, { recursive: true });
    const store = await AssetStore.open(paths);
    expect(store.base?.state).toBe('unavailable');

    // The write is refused so base art is never re-indexed into another root.
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
            hash      : 'abc',
            ext       : 'png',
            kind      : 'portrait',
            sourceTask: 't',
            refs      : [],
            modelId   : 'm',
            satisfies : { characterId: 'aiko' },
            accepted  : false,
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

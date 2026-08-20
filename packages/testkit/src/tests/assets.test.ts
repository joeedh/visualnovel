import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskInputs } from '@vn/types';
import { AssetCache, isPlaceholderImage, requestKey } from '@vn/providers';
import { SCRIPTS, makeProject } from '../index.js';

const REAL_ART = new TextEncoder().encode('pretend this is 2 MB of generated art');

/** `store.read` hands back a Buffer; compare decoded contents rather than the container type. */
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The cache is opt-in and read-only from a fixture's side. These tests cover two properties: a
 * recording is actually served (the key the pipeline's request produces matches the key the
 * recorder wrote), and an unrecorded request degrades to a placeholder rather than to something
 * that merely looks generated.
 */
describe('makeProject({ assets: "cached" })', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(join(tmpdir(), 'vn-fixture-assets-'));
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('serves a recorded asset, and leaves everything unrecorded a placeholder', async () => {
    // Pass 1: a plain placeholder run, purely to learn what the pipeline will ask for.
    const probe = await makeProject({ script: SCRIPTS.linear });
    let recordedPrompt: string;
    try {
      await probe.run();
      const { graph } = await probe.reload();
      const plate = graph.all().find((t) => t.kind === 'location_ref');
      const { prompt, refs, params } = plate!.inputs as TaskInputs['location_ref'];
      expect(refs).toEqual([]); // no upstream bytes, so this link can be recorded on its own
      recordedPrompt = prompt;

      const cache = await AssetCache.open(cacheDir);
      await cache.put(
        requestKey('generate', prompt, [], params),
        { bytes: REAL_ART, ext: 'png', modelId: params.modelId },
        { op: 'generate', prompt, refs: [], params, fixture: 'linear' },
      );
    } finally {
      await probe.cleanup();
    }

    // Pass 2: a fresh project asking the same questions, now with the recording in place.
    const p = await makeProject({
      script: SCRIPTS.linear,
      assets: 'cached',
      assetCacheDir: cacheDir,
    });
    try {
      await p.run();
      const { store } = await p.reload();
      // By prompt, not by kind: `linear` has two location variants and only one was recorded.
      const plate = store.manifest().find((a) => a.prompt === recordedPrompt);
      const portrait = store.manifest().find((a) => a.kind === 'portrait');

      expect(text(await store.read({ hash: plate!.hash, ext: plate!.ext }))).toBe(text(REAL_ART));
      // Nothing recorded the portrait, so its bytes are a marked placeholder.
      expect(
        isPlaceholderImage(await store.read({ hash: portrait!.hash, ext: portrait!.ext })),
      ).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  /**
   * The committed corpus is only useful if the default `FIXTURE_ASSET_DIR` finds it, and that
   * path is `__dirname`-relative — which esbuild rewrites when it bundles. A recorder writing
   * to a plausible-but-wrong directory reports a full corpus and leaves every fixture on
   * placeholders. Assert reachability only: staleness must never gate a suite, since the fix
   * for it is a paid re-record.
   */
  it('reaches the committed corpus at the default path', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, assets: 'cached' });
    try {
      await p.run();
      const { store } = await p.reload();
      const assets = store.manifest();
      const real = [];
      for (const a of assets) {
        if (!isPlaceholderImage(await store.read({ hash: a.hash, ext: a.ext }))) real.push(a);
      }
      expect(real.length).toBeGreaterThan(0);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('defaults to placeholders, so a suite cannot depend on a cache being present', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, assetCacheDir: cacheDir });
    try {
      await p.run();
      const { store } = await p.reload();
      const assets = store.manifest();
      expect(assets.length).toBeGreaterThan(0);
      for (const a of assets) {
        expect(isPlaceholderImage(await store.read({ hash: a.hash, ext: a.ext }))).toBe(true);
      }
    } finally {
      await p.cleanup();
    }
  }, 30_000);
});

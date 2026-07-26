import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskInputs } from '@vn/types';
import { AssetCache, isPlaceholderImage, requestKey } from '@vn/providers';
import { SCRIPTS, makeProject } from '../index.js';

const REAL_ART = new TextEncoder().encode('pretend this is 2 MB of generated art');

/** `store.read` hands back a Buffer; compare contents, not the box around them. */
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The cache is opt-in and read-only from a fixture's side, so these prove the two things that
 * would make it dishonest: that a recording is actually served (the key the pipeline's request
 * produces has to match the key the recorder wrote), and that anything unrecorded degrades to
 * a placeholder rather than to something that merely looks generated.
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
      // Nothing recorded the portrait, so it is a placeholder — and says so in its bytes.
      expect(
        isPlaceholderImage(await store.read({ hash: portrait!.hash, ext: portrait!.ext })),
      ).toBe(true);
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

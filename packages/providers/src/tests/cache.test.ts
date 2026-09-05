import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageParams, ImageResult } from '@vn/types';
import { assetCacheIndexSchema } from '@vn/types';
import { sha256 } from '@vn/util';
import type { ImageBackend, ImageInput } from '../backend.js';
import { AssetCache, CachedImageBackend, requestKey } from '../cache.js';
import { placeholderPng } from '../placeholder.js';

const PARAMS: ImageParams = { modelId: 'test-image-1' };
const REF = (text: string): ImageInput => ({ bytes: new TextEncoder().encode(text), ext: 'png' });

/** Distinct bytes per call, and a call count — so "served from cache" is observable. */
class CountingBackend implements ImageBackend {
  calls = 0;
  readonly modelId = 'test-image-1';

  private next(tag: string): Promise<ImageResult> {
    this.calls += 1;
    return Promise.resolve({
      bytes  : new TextEncoder().encode(`${tag}#${this.calls}`),
      ext    : 'png',
      modelId: this.modelId,
    });
  }
  generate(): Promise<ImageResult> {
    return this.next('generate');
  }
  edit(): Promise<ImageResult> {
    return this.next('edit');
  }
}

async function tempCache(): Promise<{
  cache: AssetCache;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-cache-'));
  return {
    cache: await AssetCache.open(dir),
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }),
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('requestKey', () => {
  it('covers the operation, the prompt, the ref bytes and the params — and nothing else', () => {
    const base = requestKey('generate', 'a shot', [REF('portrait')], PARAMS);

    expect(requestKey('generate', 'a shot', [REF('portrait')], PARAMS)).toBe(base);
    expect(requestKey('generate', 'a shot ', [REF('portrait')], PARAMS)).not.toBe(base);
    expect(requestKey('generate', 'a shot', [REF('other')], PARAMS)).not.toBe(base);
    expect(requestKey('generate', 'a shot', [], PARAMS)).not.toBe(base);
    // modelId lives in params, so a recording can never be replayed for a different model.
    expect(requestKey('generate', 'a shot', [REF('portrait')], { modelId: 'other' })).not.toBe(
      base,
    );
    // An edit's base image is folded in as its first ref, so the op has to disambiguate.
    expect(requestKey('edit', 'a shot', [REF('portrait')], PARAMS)).not.toBe(base);
  });
});

describe('AssetCache', () => {
  it('round-trips bytes and records provenance a reader can check', async () => {
    const { cache, dir, cleanup } = await tempCache();
    try {
      const key = requestKey('generate', 'a plate', [REF('ref')], PARAMS);
      const entry = await cache.put(
        key,
        { bytes: new TextEncoder().encode('REAL ART'), ext: 'png', modelId: 'test-image-1' },
        {
          op     : 'generate',
          prompt : 'a plate',
          refs   : [REF('ref')],
          params : PARAMS,
          fixture: 'linear',
        },
      );
      expect(entry.refs).toEqual([sha256(REF('ref').bytes)]);
      expect(entry.bytes).toBe(8);

      const hit = await cache.get(key);
      expect(text(hit!.bytes)).toBe('REAL ART');
      expect(hit!.modelId).toBe('test-image-1');

      const index = assetCacheIndexSchema.parse(
        JSON.parse(await fs.readFile(join(dir, 'index.json'), 'utf8')),
      );
      expect(index.entries.map((e) => e.key)).toEqual([key]);
      expect(index.entries[0]!.fixture).toBe('linear');

      // Provenance is on disk, not just in memory: a fresh open finds the same entry.
      expect(text((await (await AssetCache.open(dir)).get(key))!.bytes)).toBe('REAL ART');
    } finally {
      await cleanup();
    }
  });

  it('treats an indexed entry whose file is gone as a miss', async () => {
    const { cache, dir, cleanup } = await tempCache();
    try {
      const key = requestKey('generate', 'a plate', [], PARAMS);
      const entry = await cache.put(
        key,
        { bytes: new TextEncoder().encode('REAL ART'), ext: 'png', modelId: 'test-image-1' },
        { op: 'generate', prompt: 'a plate', refs: [], params: PARAMS },
      );
      await fs.rm(join(dir, `${entry.key}.png`));
      expect(cache.has(key)).toBe(true);
      // The index records the entry; `get` still requires the bytes on disk.
      expect(await cache.get(key)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('refuses to record a mock placeholder', async () => {
    const { cache, cleanup } = await tempCache();
    try {
      const key = requestKey('generate', 'a plate', [], PARAMS);
      await expect(
        cache.put(
          key,
          { bytes: placeholderPng('deadbeef'), ext: 'png', modelId: 'mock-image' },
          { op: 'generate', prompt: 'a plate', refs: [], params: PARAMS },
        ),
      ).rejects.toThrow(/placeholder/);
      expect(cache.entries()).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('CachedImageBackend', () => {
  it('delegates a miss and leaves the cache alone unless recording', async () => {
    const { cache, cleanup } = await tempCache();
    try {
      const inner = new CountingBackend();
      const backend = new CachedImageBackend(cache, inner);
      const first = await backend.generate('a plate', [], PARAMS);
      const second = await backend.generate('a plate', [], PARAMS);

      expect(inner.calls).toBe(2); // every miss goes through; nothing was memoized
      expect(text(first.bytes)).toBe('generate#1');
      expect(text(second.bytes)).toBe('generate#2');
      expect(cache.entries()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('records once and serves every identical request from the recording', async () => {
    const { cache, cleanup } = await tempCache();
    try {
      const inner = new CountingBackend();
      const backend = new CachedImageBackend(cache, inner, { record: true, fixture: 'linear' });
      const recorded = await backend.generate('a plate', [REF('ref')], PARAMS);
      const replayed = await backend.generate('a plate', [REF('ref')], PARAMS);

      expect(inner.calls).toBe(1);
      expect(text(replayed.bytes)).toBe(text(recorded.bytes));
      expect(cache.entries()).toHaveLength(1);

      // A changed prompt is a different request, so it misses and is recorded separately.
      await backend.generate('a different plate', [REF('ref')], PARAMS);
      expect(inner.calls).toBe(2);
      expect(cache.entries()).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it('keeps an edit distinct from the generate that shares its texts', async () => {
    const { cache, cleanup } = await tempCache();
    try {
      const inner = new CountingBackend();
      const backend = new CachedImageBackend(cache, inner, { record: true });
      await backend.generate('a sheet', [REF('portrait')], PARAMS);
      const edited = await backend.edit(REF('portrait'), 'a sheet', [], PARAMS);

      expect(inner.calls).toBe(2);
      expect(text(edited.bytes)).toBe('edit#2');
      expect(
        cache
          .entries()
          .map((e) => e.op)
          .sort(),
      ).toEqual(['edit', 'generate']);
    } finally {
      await cleanup();
    }
  });

  it('reports the model that actually made the bytes, not the stub behind it', async () => {
    const { cache, dir, cleanup } = await tempCache();
    try {
      const key = requestKey('generate', 'a plate', [], PARAMS);
      await cache.put(
        key,
        { bytes: new TextEncoder().encode('REAL ART'), ext: 'png', modelId: 'gemini-2.5-flash' },
        { op: 'generate', prompt: 'a plate', refs: [], params: PARAMS },
      );
      const backend = new CachedImageBackend(await AssetCache.open(dir), new CountingBackend());
      const hit = await backend.generate('a plate', [], PARAMS);
      expect(hit.modelId).toBe('gemini-2.5-flash');
    } finally {
      await cleanup();
    }
  });
});

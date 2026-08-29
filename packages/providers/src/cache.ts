/**
 * Record/replay for image-model responses, so a fixture can hold real art without anyone
 * paying for it twice. The node suites assert only on structure — task counts, hashes,
 * manifest entries — which `StubImageBackend`'s placeholders already satisfy for free. The
 * cache exists so that a generated project is viewable, and the P7 refine loop reviewable,
 * by someone who has never held an API key.
 *
 * Plan: `docs/plans/archive/INDEX.md#sample-workspace-and-asset-cache`.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AssetCacheEntry, ImageParams, ImageResult } from '@vn/types';
import { assetCacheIndexSchema } from '@vn/types';
import { canonicalJson, ensureDir, exists, readText, sha256, writeFileAtomic } from '@vn/util';
import type { ImageBackend, ImageInput } from './backend.js';
import { isPlaceholderImage } from './placeholder.js';

/** Which backend call produced an entry. `edit` folds its base image in as the first ref. */
export type ImageOp = 'generate' | 'edit';

/**
 * The cache key covers everything that determines the image and nothing else.
 *
 * It is deliberately not a task hash — the backend never sees a task, and keying on the request
 * means one recording serves every task kind that would have issued it. `params` carries
 * `modelId`, so a recording can never be replayed for a different model.
 */
export function requestKey(
  op: ImageOp,
  prompt: string,
  refs: readonly ImageInput[],
  params: ImageParams,
): string {
  return sha256(canonicalJson({ op, prompt, refs: refs.map((r) => sha256(r.bytes)), params }));
}

/** What `put` records alongside the bytes. */
export interface RecordMeta {
  op: ImageOp;
  prompt: string;
  refs: readonly ImageInput[];
  params: ImageParams;
  /** The fixture whose run produced it, for the orphan report. */
  fixture?: string;
}

/**
 * A directory of recorded image bytes (`<key>.<ext>`) plus an `index.json` of provenance.
 * Reads are the common case and cheap; writes happen only under an explicit, human-initiated
 * recording run.
 */
export class AssetCache {
  private readonly index = new Map<string, AssetCacheEntry>();
  /** Serializes index writes: a recording run generates concurrently, like any other run. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(readonly dir: string) {}

  /** Open a cache directory. A missing one is simply an empty cache; a malformed index throws. */
  static async open(dir: string): Promise<AssetCache> {
    const cache = new AssetCache(dir);
    if (await exists(cache.indexFile)) {
      const parsed = assetCacheIndexSchema.parse(JSON.parse(await readText(cache.indexFile)));
      for (const entry of parsed.entries) cache.index.set(entry.key, entry);
    }
    return cache;
  }

  get indexFile(): string {
    return join(this.dir, 'index.json');
  }

  fileOf(entry: AssetCacheEntry): string {
    return join(this.dir, `${entry.key}.${entry.ext}`);
  }

  entries(): readonly AssetCacheEntry[] {
    return [...this.index.values()];
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  /**
   * Recorded bytes for a key, or null on a miss. An indexed entry whose file is gone is a
   * miss too: the index describes the bytes, it never stands in for them.
   */
  async get(key: string): Promise<ImageResult | null> {
    const entry = this.index.get(key);
    if (!entry) return null;
    const file = this.fileOf(entry);
    if (!(await exists(file))) return null;
    return { bytes: await fs.readFile(file), ext: entry.ext, modelId: entry.modelId };
  }

  /**
   * Record a response. Refuses placeholder bytes, because a recording run that fell back to
   * mocks would otherwise bake them in permanently, indistinguishable from a genuine recording
   * once committed.
   */
  async put(key: string, result: ImageResult, meta: RecordMeta): Promise<AssetCacheEntry> {
    if (isPlaceholderImage(result.bytes)) {
      throw new Error(`refusing to record a mock placeholder into the asset cache (key ${key})`);
    }
    const entry: AssetCacheEntry = {
      key,
      op: meta.op,
      ext: result.ext,
      modelId: result.modelId,
      prompt: meta.prompt,
      refs: meta.refs.map((r) => sha256(r.bytes)),
      params: { ...meta.params },
      bytes: result.bytes.length,
      recordedAt: new Date().toISOString(),
      ...(meta.fixture ? { fixture: meta.fixture } : {}),
    };
    await ensureDir(this.dir);
    await writeFileAtomic(this.fileOf(entry), result.bytes);
    this.index.set(key, entry);
    await this.persist();
    return entry;
  }

  /** Same single-writer discipline as the manifest: concurrent atomic renames fail on Windows. */
  private persist(): Promise<void> {
    const run = this.writeQueue.then(
      () => this.writeIndex(),
      () => this.writeIndex(),
    );
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeIndex(): Promise<void> {
    const entries = [...this.index.values()].sort((a, b) => a.key.localeCompare(b.key));
    await writeFileAtomic(this.indexFile, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
  }
}

export interface CachedImageOptions {
  /**
   * Write misses back into the cache. Off by default — only the deliberate, costed refresh
   * run records, and it runs against real providers.
   */
  record?: boolean;
  /** Recorded on each entry, so the refresh script can report orphans by fixture. */
  fixture?: string;
}

/**
 * One request as the backend saw it, in call order. Only this log knows which keys a fixture
 * asks for, while the cache knows only what it holds, so both halves of the refresh report
 * (reused vs. added, and which entries nothing asked for) derive from it.
 */
export interface ServedRequest {
  key: string;
  op: ImageOp;
  prompt: string;
  /** The cache answered it. */
  hit: boolean;
  /** The miss was written back. Always false without `record`. */
  recorded: boolean;
}

/**
 * An `ImageBackend` that serves recorded bytes when it has them and delegates otherwise, so
 * nothing above the seam changes.
 *
 * A miss is not fatal. It falls through to `inner` (placeholders, in a fixture), and
 * because a reference's bytes are part of both the cache key and the task hash, everything
 * downstream of a missed link misses too. There is no half-real run in which a placeholder
 * is quietly presented as generated art.
 */
export class CachedImageBackend implements ImageBackend {
  /** Every request this backend served, in call order. */
  readonly log: ServedRequest[] = [];

  constructor(
    private readonly cache: AssetCache,
    private readonly inner: ImageBackend,
    private readonly opts: CachedImageOptions = {},
  ) {}

  get modelId(): string {
    return this.inner.modelId;
  }

  generate(prompt: string, refs: ImageInput[], params: ImageParams): Promise<ImageResult> {
    return this.serve('generate', prompt, refs, params, () =>
      this.inner.generate(prompt, refs, params),
    );
  }

  edit(
    base: ImageInput,
    prompt: string,
    refs: ImageInput[],
    params: ImageParams,
  ): Promise<ImageResult> {
    return this.serve('edit', prompt, [base, ...refs], params, () =>
      this.inner.edit(base, prompt, refs, params),
    );
  }

  private async serve(
    op: ImageOp,
    prompt: string,
    refs: readonly ImageInput[],
    params: ImageParams,
    call: () => Promise<ImageResult>,
  ): Promise<ImageResult> {
    const key = requestKey(op, prompt, refs, params);
    const hit = await this.cache.get(key);
    // The recorded `modelId` is what actually made the bytes; `params.modelId` is in the key,
    // so a hit already agrees with what was asked for.
    if (hit) {
      this.log.push({ key, op, prompt, hit: true, recorded: false });
      return hit;
    }
    const result = await call();
    if (this.opts.record) {
      await this.cache.put(key, result, { op, prompt, refs, params, fixture: this.opts.fixture });
    }
    this.log.push({ key, op, prompt, hit: false, recorded: !!this.opts.record });
    return result;
  }
}

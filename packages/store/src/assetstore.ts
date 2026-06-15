import { promises as fs } from 'node:fs';
import type { Asset, AssetMeta, AssetRef, AssetStore as IAssetStore } from '@vn/types';
import { ensureDir, exists, readText, sha256, writeFileAtomic } from '@vn/util';
import { ProjectPaths } from './paths.js';

interface ManifestFile {
  version: 1;
  assets: Asset[];
}

/**
 * Content-addressed asset store + manifest (report §8). Image bytes are stored once at
 * `build/assets/<sha256>.<ext>`; identical outputs collapse to one file. The manifest
 * is the single provenance index a future engine-export step would read.
 */
export class AssetStore implements IAssetStore {
  private readonly index = new Map<string, Asset>();
  /** Serializes manifest writes so concurrent tasks never race on the atomic rename. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly paths: ProjectPaths) {}

  /** Open (or initialize) the store for a project, loading any existing manifest. */
  static async open(paths: ProjectPaths): Promise<AssetStore> {
    const store = new AssetStore(paths);
    if (await exists(paths.manifest)) {
      const parsed = JSON.parse(await readText(paths.manifest)) as ManifestFile;
      for (const asset of parsed.assets) store.index.set(asset.hash, asset);
    }
    return store;
  }

  has(hash: string): boolean {
    return this.index.has(hash);
  }

  async write(bytes: Uint8Array, ext: string, meta: AssetMeta): Promise<AssetRef> {
    const hash = sha256(bytes);
    const ref: AssetRef = { hash, ext };
    const file = this.paths.assetFile(hash, ext);
    // Content-addressed: only write the bytes if this exact image is new.
    if (!(await exists(file))) {
      await ensureDir(this.paths.assetsDir);
      await writeFileAtomic(file, bytes);
    }
    const asset: Asset = {
      hash,
      ext,
      kind: meta.kind,
      sourceTask: meta.sourceTask,
      prompt: meta.prompt,
      refs: meta.refs ?? [],
      modelId: meta.modelId,
      satisfies: meta.satisfies ?? {},
      accepted: meta.accepted ?? false,
    };
    this.index.set(hash, asset);
    await this.persist();
    return ref;
  }

  async read(ref: AssetRef): Promise<Uint8Array> {
    return fs.readFile(this.paths.assetFile(ref.hash, ref.ext));
  }

  pathOf(ref: AssetRef): string {
    return this.paths.assetFile(ref.hash, ref.ext);
  }

  manifest(): readonly Asset[] {
    return [...this.index.values()];
  }

  /** Mark an asset accepted (e.g. an approved portrait or accepted shot). */
  async accept(hash: string): Promise<void> {
    const asset = this.index.get(hash);
    if (asset && !asset.accepted) {
      asset.accepted = true;
      await this.persist();
    }
  }

  /**
   * Persist the manifest, serialized through a single-writer queue. The scheduler runs
   * tasks in parallel, so without this two `write`s would atomically rename onto
   * `manifest.json` at once — which fails on Windows (EPERM). Each call also re-snapshots
   * the live index, so a queued write always flushes the latest state.
   */
  private persist(): Promise<void> {
    const run = this.writeQueue.then(
      () => this.writeManifest(),
      () => this.writeManifest(),
    );
    // Isolate failures so one bad write does not poison subsequent persists.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeManifest(): Promise<void> {
    const file: ManifestFile = {
      version: 1,
      assets: [...this.index.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
    };
    await writeFileAtomic(this.paths.manifest, JSON.stringify(file, null, 2) + '\n');
  }
}

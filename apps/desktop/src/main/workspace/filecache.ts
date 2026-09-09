/**
 * The main process's own file reads and writes, over the content-addressed store undo snapshots
 * into. One store serves both, so a document the app just wrote is already hashed by the time a
 * snapshot reaches it and the walk needs neither a read nor a hash for it.
 *
 * Two kinds of file are cached, for different reasons. A stored asset is named by the hash of its
 * own bytes, so its identity can never go stale and the only bound is memory: those are held
 * against collection and dropped oldest-first past {@link ASSET_BUDGET}. A document is mutable,
 * so a cached read is served only while `(mtime, size)` still match what was recorded, and every
 * write goes to disk before it goes to the cache — nothing is ever durable only in memory.
 *
 * This wraps the calls this app makes; it does not change what `@vn/store` does. The embedded
 * agent writes through `@vn/store` and `@vn/util` directly, so its edits do not warm the cache.
 * That costs a re-read on the next look at those paths and nothing else, because a document entry
 * is only served after its stat is checked.
 */
import { readFile } from 'node:fs/promises';
import { ContentStore } from '@vn/commands/snapshot';
import { writeFileAtomic } from '@vn/util';

/** How many bytes of stored assets to keep. Roughly thirty portraits at their usual size. */
const ASSET_BUDGET = 64 * 1024 * 1024;

export class FileCache {
  /** Path → the hash held for it, in least-recently-used order. */
  private readonly assets = new Map<string, string>();
  private assetBytes = 0;

  constructor(
    private readonly store: ContentStore,
    private readonly budget = ASSET_BUDGET,
  ) {}

  /**
   * The bytes of a stored asset. The file is named by its own hash and so is never re-read once
   * held; a caller that wants a mutable file wants {@link readText}.
   */
  async asset(path: string): Promise<Uint8Array> {
    const held = this.assets.get(path);
    if (held !== undefined) {
      const bytes = this.store.blob(held);
      if (bytes) {
        // Moving the entry to the young end of the map is what makes it an LRU.
        this.assets.delete(path);
        this.assets.set(path, held);
        return bytes;
      }
      this.assets.delete(path);
    }

    const bytes = await readFile(path);
    const hash = this.store.putBlob(bytes);
    this.store.pin(hash);
    this.assets.set(path, hash);
    this.assetBytes += bytes.byteLength;
    this.evict();
    return bytes;
  }

  /** A document's text, re-read whenever the file moved since it was last seen. */
  async readText(path: string): Promise<string> {
    const held = await this.store.cached(path);
    if (held) return Buffer.from(held).toString('utf8');
    const bytes = await readFile(path);
    await this.store.note(path, bytes);
    return bytes.toString('utf8');
  }

  /** Write a document, atomically, and hold what was written. */
  async write(path: string, text: string): Promise<void> {
    const bytes = Buffer.from(text, 'utf8');
    await writeFileAtomic(path, bytes);
    await this.store.note(path, bytes);
  }

  /**
   * Holds bytes another writer has already put on disk at `path`. Used where this app calls the
   * writer rather than performing the write, so the bytes are known but the write is not ours.
   */
  async note(path: string, text: string): Promise<void> {
    await this.store.note(path, Buffer.from(text, 'utf8'));
  }

  /** Let go of every asset held. Documents need no eviction: a stale one is simply re-read. */
  clear(): void {
    for (const hash of this.assets.values()) this.store.release(hash);
    this.assets.clear();
    this.assetBytes = 0;
  }

  private evict(): void {
    for (const [path, hash] of this.assets) {
      if (this.assetBytes <= this.budget) return;
      this.assetBytes -= this.store.blob(hash)?.byteLength ?? 0;
      this.store.release(hash);
      this.assets.delete(path);
    }
  }
}

/**
 * The one store in the main process, shared by the cache and by undo. Held here rather than
 * beside the command stack because the cache outlives any one stack: a read made before the first
 * command still belongs in it.
 */
export const snapshotStore = new ContentStore();

export const fileCache = new FileCache(snapshotStore);

/**
 * Forget everything held. Called when the workspace switches, since the stack, its undo history
 * and the paths themselves are all rebuilt against the new root.
 */
export function forgetFiles(): void {
  fileCache.clear();
  snapshotStore.clear();
}

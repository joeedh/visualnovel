/**
 * A content-addressed mirror of a directory tree, held in memory.
 *
 * Files hash to blobs and directories hash to sorted entry lists, so two identical directory
 * states produce the same tree hash and comparing them is one string comparison rather than a
 * walk. The idea is git's; nothing here spawns git, reads `.git`, or writes to disk except when
 * a caller asks for a restore.
 *
 * A capture walks the tree and re-reads only the files whose `(mtime, size)` moved since the last
 * look, so the second capture of an unchanged project costs a stat per file. A restore diffs two
 * trees and touches only the paths that differ, which is what keeps it from churning the mtime of
 * every file an author did not edit.
 *
 * The store holds bytes, so what it snapshots has to stay small: media files are left out
 * entirely, and callers exclude the generated trees by path. {@link collect} drops everything no
 * live tree reaches, which is how a caller bounds what a long session accumulates.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { sha256, writeFileAtomic } from '@vn/util';

export type EntryKind = 'blob' | 'tree';

/** One name in a directory, and what it holds. */
export interface TreeEntry {
  name: string;
  kind: EntryKind;
  hash: string;
}

/** What the store is holding, for a caller deciding whether to drop older snapshots. */
export interface StoreStats {
  blobs: number;
  trees: number;
  /** Total blob bytes resident. Tree bookkeeping is not counted. */
  bytes: number;
}

/**
 * Extensions left out of every capture: generated art, uploaded reference images, audio, video
 * and archives. No undoable command writes one, and holding a project's art in memory would cost
 * hundreds of megabytes. A media file is therefore neither restored nor deleted by an undo, and
 * changing one is not workspace drift — the same treatment `vngen/build` already gets.
 */
export const MEDIA_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'psd',
  'svgz',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a',
  'mp4',
  'webm',
  'mov',
  'zip',
  'gz',
  'pdf',
  'ttf',
  'otf',
  'woff',
  'woff2',
]);

/** Directory names never walked, wherever they appear. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** The temp sibling `writeFileAtomic` leaves beside a file, which is mid-write by definition. */
const TEMP_SIBLING = /\.tmp-[0-9a-f]+$/;

/** The hash of a directory holding nothing, which is also the hash of an empty blob. */
export const EMPTY_HASH = sha256('');

function isMedia(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && MEDIA_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** Blobs and trees are addressed in the same namespace, so a tree hashes its own serialization. */
function hashTree(entries: TreeEntry[]): string {
  return sha256(entries.map((e) => `${e.kind} ${e.hash} ${e.name}`).join('\n'));
}

/**
 * What one path held when it was last read. `settled` is false when the file's mtime is not
 * strictly older than the moment it was read: a write landing inside the filesystem's timestamp
 * resolution would then leave `(mtime, size)` unchanged over different bytes, so such a record is
 * never trusted a second time and the file is read again. This is git's "racily clean" rule.
 */
interface PathRecord {
  mtimeMs: number;
  size: number;
  hash: string;
  settled: boolean;
}

export class ContentStore {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly trees = new Map<string, TreeEntry[]>();
  /** Blobs a caller is holding outside any tree, by how many holds are outstanding. */
  private readonly pinned = new Map<string, number>();
  /** Absolute path → what was last seen there, so an unchanged file is never re-read. */
  private readonly seen = new Map<string, PathRecord>();
  private held = 0;

  putBlob(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, bytes);
      this.held += bytes.byteLength;
    }
    return hash;
  }

  blob(hash: string): Uint8Array | undefined {
    return this.blobs.get(hash);
  }

  putTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const hash = hashTree(sorted);
    if (!this.trees.has(hash)) this.trees.set(hash, sorted);
    return hash;
  }

  tree(hash: string): TreeEntry[] | undefined {
    return this.trees.get(hash);
  }

  stats(): StoreStats {
    return { blobs: this.blobs.size, trees: this.trees.size, bytes: this.held };
  }

  /** Hold a blob against collection until the same number of {@link release} calls have run. */
  pin(hash: string): void {
    this.pinned.set(hash, (this.pinned.get(hash) ?? 0) + 1);
  }

  release(hash: string): void {
    const holds = this.pinned.get(hash);
    if (holds === undefined) return;
    if (holds <= 1) this.pinned.delete(hash);
    else this.pinned.set(hash, holds - 1);
  }

  /**
   * Drop every blob and tree that neither a pin nor one of `roots` reaches, and answer how many
   * blob bytes `roots` themselves hold.
   *
   * That figure excludes what only a pin keeps alive, so a caller trimming its own snapshots to a
   * budget is not charged for another caller's cache. Path records naming a dropped blob go too,
   * so the next capture re-reads that file rather than writing a tree that points at bytes the
   * store no longer holds.
   */
  collect(roots: Iterable<string>): number {
    const reached = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
      const hash = pending.pop()!;
      if (reached.has(hash)) continue;
      reached.add(hash);
      for (const entry of this.trees.get(hash) ?? []) pending.push(entry.hash);
    }

    let bytes = 0;
    for (const [hash, blob] of this.blobs) {
      if (reached.has(hash)) bytes += blob.byteLength;
      else if (this.pinned.has(hash)) continue;
      else {
        this.blobs.delete(hash);
        this.held -= blob.byteLength;
      }
    }
    for (const hash of this.trees.keys()) {
      if (!reached.has(hash) && !this.pinned.has(hash)) this.trees.delete(hash);
    }
    for (const [path, record] of this.seen) {
      if (!this.blobs.has(record.hash)) this.seen.delete(path);
    }
    return bytes;
  }

  /** Forget everything, which is what opening a different project asks for. */
  clear(): void {
    this.blobs.clear();
    this.trees.clear();
    this.pinned.clear();
    this.seen.clear();
    this.held = 0;
  }

  /**
   * Record bytes that were just written to `path`, so the next capture of the tree holding it
   * needs neither a read nor a hash. Answers the blob's hash.
   */
  async note(path: string, bytes: Uint8Array): Promise<string> {
    const at = Date.now();
    const hash = this.putBlob(bytes);
    const stat = await fs.stat(path).catch(() => null);
    if (stat) this.record(path, stat.mtimeMs, stat.size, hash, at);
    return hash;
  }

  /**
   * The bytes recorded for `path`, when the file on disk is still the one that was recorded.
   * Undefined means the caller has to read it, whether because nothing was recorded, because the
   * file moved since, or because the bytes have since been collected.
   */
  async cached(path: string): Promise<Uint8Array | undefined> {
    const stat = await fs.stat(path).catch(() => null);
    if (!stat) return undefined;
    const record = this.unchanged(path, stat.mtimeMs, stat.size);
    return record ? this.blobs.get(record.hash) : undefined;
  }

  /** The record for `path`, when it still describes what a stat just found and its bytes are held. */
  private unchanged(path: string, mtimeMs: number, size: number): PathRecord | undefined {
    const record = this.seen.get(path);
    if (!record?.settled) return undefined;
    if (record.mtimeMs !== mtimeMs || record.size !== size) return undefined;
    return this.blobs.has(record.hash) ? record : undefined;
  }

  private record(path: string, mtimeMs: number, size: number, hash: string, readAt: number): void {
    this.seen.set(path, { mtimeMs, size, hash, settled: mtimeMs < readAt });
  }

  /**
   * Hash `root` into the store and answer its tree hash. `skip` holds root-relative, forward-
   * slashed paths that are not part of the tree; naming a directory prunes the walk under it.
   *
   * Symlinks, sockets and device files are not documents and are passed over, as are media files
   * ({@link MEDIA_EXTS}) and the temp siblings an atomic write leaves behind. An empty directory
   * has no entry, so a restore neither creates nor removes one.
   */
  async capture(root: string, skip: ReadonlySet<string> = new Set()): Promise<string> {
    return this.captureDir(root, '', skip);
  }

  private async captureDir(
    root: string,
    prefix: string,
    skip: ReadonlySet<string>,
  ): Promise<string> {
    const dir = prefix === '' ? root : join(root, prefix);
    const listing = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const entries: TreeEntry[] = [];

    for (const dirent of listing) {
      const name = dirent.name;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (skip.has(rel)) continue;

      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        const hash = await this.captureDir(root, rel, skip);
        // Git has no empty trees in a commit, and neither does this: an entry for one would make
        // a restore create and remove directories nobody put anything in.
        if (hash !== EMPTY_HASH) entries.push({ name, kind: 'tree', hash });
        continue;
      }
      if (!dirent.isFile() || isMedia(name) || TEMP_SIBLING.test(name)) continue;

      const path = join(dir, name);
      const hash = await this.hashFile(path);
      if (hash !== null) entries.push({ name, kind: 'blob', hash });
    }

    return this.putTree(entries);
  }

  /** The file's hash, re-reading it only when the record no longer describes what is on disk. */
  private async hashFile(path: string): Promise<string | null> {
    const before = await fs.stat(path).catch(() => null);
    if (!before) return null;
    const known = this.unchanged(path, before.mtimeMs, before.size);
    if (known) return known.hash;

    const at = Date.now();
    const bytes = await fs.readFile(path).catch(() => null);
    if (bytes === null) return null;
    // Stat again after the read, so a write that landed during it is described by the record
    // rather than hidden by it.
    const after = (await fs.stat(path).catch(() => null)) ?? before;
    const hash = this.putBlob(bytes);
    this.record(path, after.mtimeMs, after.size, hash, at);
    return hash;
  }

  /**
   * Move `root` from tree `from` to tree `to`, writing only the files whose hashes differ and
   * deleting the paths `from` recorded that `to` does not. Anything in neither tree — everything
   * a capture skipped — is left where it is.
   *
   * Throws when a blob the move needs is no longer held, which is the one failure that means the
   * snapshot has outlived the window the store keeps.
   */
  async restore(root: string, from: string, to: string): Promise<void> {
    if (from === to) return;
    for (const hash of [from, to]) {
      if (!this.trees.has(hash)) throw new Error(`snapshot ${hash.slice(0, 8)} is no longer held`);
    }
    await this.restoreDir(root, '', from, to);
  }

  private async restoreDir(root: string, prefix: string, from: string, to: string): Promise<void> {
    const dir = prefix === '' ? root : join(root, prefix);
    const before = new Map((this.trees.get(from) ?? []).map((e) => [e.name, e]));
    const after = this.trees.get(to) ?? [];
    const wanted = new Set(after.map((e) => e.name));

    for (const entry of after) {
      const was = before.get(entry.name);
      if (was && was.kind === entry.kind && was.hash === entry.hash) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.kind === 'blob') {
        // A directory standing where a file belongs is what a kind change looks like on disk.
        if (was?.kind === 'tree') await this.removeDir(root, rel, was.hash);
        const bytes = this.blobs.get(entry.hash);
        if (!bytes) throw new Error(`the snapshot of ${rel} is no longer held`);
        await writeFileAtomic(path, bytes);
        await this.note(path, bytes);
      } else {
        if (was?.kind === 'blob') await this.removeFile(path);
        await fs.mkdir(path, { recursive: true });
        await this.restoreDir(root, rel, was?.kind === 'tree' ? was.hash : EMPTY_HASH, entry.hash);
      }
    }

    for (const [name, entry] of before) {
      if (wanted.has(name)) continue;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.kind === 'blob') await this.removeFile(join(dir, name));
      else await this.removeDir(root, rel, entry.hash);
    }
  }

  private async removeFile(path: string): Promise<void> {
    await fs.rm(path, { force: true });
    this.seen.delete(path);
  }

  /**
   * Delete what the tree at `rel` recorded, then the directory itself if that emptied it. Driven
   * by the tree rather than by `rm -r` so that a skipped path sitting in the same directory — a
   * generated asset, an ignored file — survives an undo that removes the documents beside it.
   */
  private async removeDir(root: string, rel: string, hash: string): Promise<void> {
    const dir = join(root, rel);
    for (const entry of this.trees.get(hash) ?? []) {
      if (entry.kind === 'blob') await this.removeFile(join(dir, entry.name));
      else await this.removeDir(root, `${rel}/${entry.name}`, entry.hash);
    }
    await fs.rmdir(dir).catch(() => {});
  }
}

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Asset,
  AssetBinding,
  AssetKind,
  AssetMeta,
  AssetRef,
  BaseAssetState,
  BaseAssets,
  AssetStore as IAssetStore,
} from '@vn/types';
import { ensureDir, exists, readText, sha256, writeFileAtomic } from '@vn/util';
import { ProjectPaths } from './paths.js';

interface ManifestFile {
  version: 1;
  assets: Asset[];
}

/** A binding that names nothing binds nothing, and does not belong in the list. */
function isEmpty(binding: AssetBinding): boolean {
  return Object.values(binding).every((v) => v === undefined);
}

const key = (binding: AssetBinding): string =>
  JSON.stringify(
    Object.entries(binding)
      .filter(([, v]) => v !== undefined)
      .sort(),
  );

/** Every manifest ever written stays readable: a lone record reads as a one-element list. */
function asList(satisfies: Asset['satisfies'] | AssetBinding | undefined): AssetBinding[] {
  if (satisfies === undefined) return [];
  if (Array.isArray(satisfies)) return satisfies.filter((b) => !isEmpty(b));
  return isEmpty(satisfies) ? [] : [satisfies];
}

/** Append `next` unless the record already carries an identical binding. */
function mergeBindings(existing: AssetBinding[] | undefined, next?: AssetBinding): AssetBinding[] {
  const list = existing ?? [];
  if (next === undefined || isEmpty(next)) return list;
  return list.some((b) => key(b) === key(next)) ? list : [...list, next];
}

/**
 * The kinds every later prompt references, and the ones the base root holds. `concept` is here
 * because it is authored-side art — a sketch of a place belongs beside that place's plates, and
 * promoting one to a plate must not have to move bytes between roots.
 */
const BASE_KINDS = new Set<AssetKind>([
  'location_ref',
  'portrait',
  'model_sheet',
  'outfit_sheet',
  'concept',
]);

/**
 * Whether a kind routes to the base root. Exported because routing is by kind and nothing else,
 * so a surface describing where an asset lives must ask the rule rather than restate it.
 */
export function isBaseKind(kind: AssetKind): boolean {
  return BASE_KINDS.has(kind);
}

/**
 * One content-addressed root: bytes at `<dir>/<hash>.<ext>` plus the manifest indexing them.
 *
 * Two of these make an {@link AssetStore}. Splitting them is what lets base art live in its own
 * subtree — and optionally its own git repo — without the provenance staying behind.
 */
export class AssetRoot {
  private readonly index = new Map<string, Asset>();
  /** Serializes manifest writes so concurrent tasks never race on the atomic rename. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly dir: string,
    readonly manifestFile: string,
    /** Whether a manifest was there to read. An absent one is not an error — see `AssetStore`. */
    readonly manifestFound: boolean,
    /** Whether the manifest's own directory exists: the subtree, with or without an index. */
    readonly dirFound: boolean,
  ) {}

  static async open(dir: string, manifestFile: string): Promise<AssetRoot> {
    const found = await exists(manifestFile);
    const root = new AssetRoot(
      dir,
      manifestFile,
      found,
      found || (await exists(dirname(manifestFile))),
    );
    if (found) {
      const parsed = JSON.parse(await readText(manifestFile)) as ManifestFile;
      for (const asset of parsed.assets) {
        root.index.set(asset.hash, { ...asset, satisfies: asList(asset.satisfies) });
      }
    }
    return root;
  }

  has(hash: string): boolean {
    return this.index.has(hash);
  }

  get(hash: string): Asset | undefined {
    return this.index.get(hash);
  }

  get count(): number {
    return this.index.size;
  }

  fileOf(ref: AssetRef): string {
    return join(this.dir, `${ref.hash}.${ref.ext}`);
  }

  assets(): readonly Asset[] {
    return [...this.index.values()];
  }

  async write(bytes: Uint8Array, ext: string, meta: AssetMeta): Promise<AssetRef> {
    const hash = sha256(bytes);
    const ref: AssetRef = { hash, ext };
    const file = this.fileOf(ref);
    // Content-addressed: only write the bytes if this exact image is new.
    if (!(await exists(file))) {
      await ensureDir(this.dir);
      await writeFileAtomic(file, bytes);
    }
    const existing = this.index.get(hash);
    this.index.set(hash, {
      hash,
      ext,
      kind: meta.kind,
      sourceTask: meta.sourceTask,
      prompt: meta.prompt,
      refs: meta.refs ?? [],
      modelId: meta.modelId,
      // One byte-stream can serve several things; the second writer must not erase the first.
      satisfies: mergeBindings(existing?.satisfies, meta.satisfies),
      accepted: meta.accepted ?? existing?.accepted ?? false,
      // A name a human gave outlives a write that has none to offer — promoting a concept must
      // not erase what it was asked for.
      ...((meta.title ?? existing?.title) ? { title: meta.title ?? existing?.title } : {}),
    });
    await this.persist();
    return ref;
  }

  async read(ref: AssetRef): Promise<Uint8Array> {
    return fs.readFile(this.fileOf(ref));
  }

  /** Mark an asset accepted (an approved portrait or an accepted shot). */
  async accept(hash: string): Promise<boolean> {
    const asset = this.index.get(hash);
    if (!asset || asset.accepted) return asset !== undefined;
    asset.accepted = true;
    await this.persist();
    return true;
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
    await ensureDir(dirname(this.manifestFile));
    await writeFileAtomic(this.manifestFile, JSON.stringify(file, null, 2) + '\n');
  }
}

/**
 * Content-addressed asset store + manifest (report §8), across two roots: base art (portraits,
 * model sheets, location refs) under `assets/`, and project art (shot frames) under
 * `vngen/build/`. Full write-up: `docs/asset-stores.md`.
 *
 * Routing is by {@link AssetKind} and nothing else, so no asset is ambiguous about where it
 * lives. Reads consult both — hashes are content hashes, so a byte present in both roots *is*
 * the same byte — which is also why a project written before the split keeps resolving: its
 * base art is still indexed in the project manifest, and nothing on disk has to move.
 */
export class AssetStore implements IAssetStore {
  private constructor(
    private readonly baseRoot: AssetRoot,
    private readonly projectRoot: AssetRoot,
    readonly base: BaseAssets,
  ) {}

  /** Open (or initialize) the store for a project, loading both manifests. */
  static async open(paths: ProjectPaths): Promise<AssetStore> {
    const base = await AssetRoot.open(paths.baseObjects, paths.baseManifest);
    const project = await AssetRoot.open(paths.assetsDir, paths.manifest);
    return new AssetStore(base, project, describe(paths, base));
  }

  has(hash: string): boolean {
    return this.baseRoot.has(hash) || this.projectRoot.has(hash);
  }

  async write(bytes: Uint8Array, ext: string, meta: AssetMeta): Promise<AssetRef> {
    const root = this.rootFor(meta.kind);
    const ref = await root.write(bytes, ext, meta);
    // The write created the base subtree and its manifest, so `absent` is no longer true — and
    // a surface reading `base` after a run must not describe the root as it was before it.
    if (root === this.baseRoot) {
      this.base.count = this.baseRoot.count;
      this.base.state = 'ready';
    }
    return ref;
  }

  async read(ref: AssetRef): Promise<Uint8Array> {
    return this.rootHolding(ref.hash).read(ref);
  }

  pathOf(ref: AssetRef): string {
    return this.rootHolding(ref.hash).fileOf(ref);
  }

  /**
   * Both manifests as one list, base first and deduped by hash. The roots cannot disagree about
   * content, so where both hold a hash the base record — the one that travels with the bytes a
   * later prompt references — is the one reported.
   */
  manifest(): readonly Asset[] {
    const all = [...this.baseRoot.assets()];
    for (const asset of this.projectRoot.assets()) {
      if (!this.baseRoot.has(asset.hash)) all.push(asset);
    }
    return all;
  }

  async accept(hash: string): Promise<void> {
    if (!(await this.baseRoot.accept(hash))) await this.projectRoot.accept(hash);
  }

  private rootFor(kind: AssetKind): AssetRoot {
    if (!BASE_KINDS.has(kind)) return this.projectRoot;
    if (this.base.state === 'unavailable') {
      throw new Error(
        `base assets at ${this.base.root} are unavailable (no manifest); refusing to write ${kind} there`,
      );
    }
    return this.baseRoot;
  }

  /** The root that holds `hash`, defaulting to the project root for one neither knows. */
  private rootHolding(hash: string): AssetRoot {
    return this.baseRoot.has(hash) ? this.baseRoot : this.projectRoot;
  }
}

/**
 * Three states, because "nothing generated yet" and "you didn't clone the base repo" must not
 * look alike: a missing directory is a legacy or brand-new project (write into it), whereas a
 * directory with no manifest is the shape a missing submodule leaves behind. Confusing the two
 * is what makes a run regenerate an entire approved base library.
 */
function describe(paths: ProjectPaths, base: AssetRoot): BaseAssets {
  const state: BaseAssetState = base.manifestFound
    ? 'ready'
    : base.dirFound
      ? 'unavailable'
      : 'absent';
  return { state, root: paths.baseAssets, count: base.count };
}

/**
 * The base root's state and size without opening the project store — for a surface that wants
 * to describe it (the workspace index) and has no reason to parse a whole build manifest.
 */
export async function baseAssetsOf(paths: ProjectPaths): Promise<BaseAssets> {
  return describe(paths, await AssetRoot.open(paths.baseObjects, paths.baseManifest));
}

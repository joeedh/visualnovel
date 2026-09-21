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
  TakeEdit,
  TakeStamp,
} from '@vn/types';
import { ensureDir, exists, readText, sha256, writeFileAtomic } from '@vn/util';
import { ProjectPaths } from './paths.js';

interface ManifestFile {
  version: 1;
  assets: Asset[];
}

/** True when the binding names no field. Such a binding is left out of the list. */
function isEmpty(binding: AssetBinding): boolean {
  return Object.values(binding).every((v) => v === undefined);
}

const key = (binding: AssetBinding): string =>
  JSON.stringify(
    Object.entries(binding)
      .filter(([, v]) => v !== undefined)
      .sort(),
  );

/** Normalizes `satisfies` to a list, so an older manifest's lone binding reads as one element. */
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
 * The kinds every later prompt references, which are the ones the base root holds. `concept` is
 * here because it is authored-side art: a sketch of a place belongs beside that place's plates,
 * and promoting one to a plate must not move bytes between roots. `reference` is here because it
 * is authored outright, being bytes a person chose rather than anything generated.
 */
const BASE_KINDS = new Set<AssetKind>([
  'location_ref',
  'portrait',
  'model_sheet',
  'outfit_sheet',
  'concept',
  'reference',
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
 * Two of these make an {@link AssetStore}. The split lets base art live in its own subtree (and
 * optionally its own git repo) while its provenance travels with it.
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
    /** Whether the manifest's own directory exists, with or without an index in it. */
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

  /**
   * The manifest's extension wins over the ref's, because a ref rebuilt from a bare hash (an
   * `approved_portrait`, a task's `output`) guesses `png`, and an image model may have answered
   * with a jpg.
   */
  fileOf(ref: AssetRef): string {
    const ext = this.index.get(ref.hash)?.ext ?? ref.ext;
    return join(this.dir, `${ref.hash}.${ext}`);
  }

  assets(): readonly Asset[] {
    return [...this.index.values()];
  }

  async write(bytes: Uint8Array, ext: string, meta: AssetMeta): Promise<AssetRef> {
    const hash = sha256(bytes);
    const ref: AssetRef = { hash, ext };
    const file = this.fileOf(ref);
    // Storage is content-addressed, so the bytes are written only when this image is new
    if (!(await exists(file))) {
      await ensureDir(this.dir);
      await writeFileAtomic(file, bytes);
    }
    const existing = this.index.get(hash);
    this.index.set(hash, {
      hash,
      ext,
      kind      : meta.kind,
      sourceTask: meta.sourceTask,
      prompt    : meta.prompt,
      refs      : meta.refs ?? [],
      modelId   : meta.modelId,
      ...(meta.transport === undefined ? {} : { transport: meta.transport }),
      // One byte-stream can serve several things; the second writer must not erase the first.
      satisfies: mergeBindings(existing?.satisfies, meta.satisfies),
      // The take bits belong to the slot's history, not to this write: a re-record of bytes the
      // slot already holds keeps them, and a new row starts out held by nothing
      current  : existing?.current ?? false,
      accepted : meta.accepted ?? existing?.accepted ?? false,
      ...(existing?.at === undefined ? {} : { at: existing.at }),
      ...(existing?.via === undefined ? {} : { via: existing.via }),
      // An existing title survives a write that carries none, so promoting a concept does not
      // erase the name it was given
      ...((meta.title ?? existing?.title) ? { title: meta.title ?? existing?.title } : {}),
    });
    await this.persist();
    return ref;
  }

  async read(ref: AssetRef): Promise<Uint8Array> {
    return fs.readFile(this.fileOf(ref));
  }

  /**
   * Make an asset the take its slot holds and release the takes it replaces, in one write. Returns
   * whether this root holds `hash`.
   *
   * The two halves are persisted together because a manifest recording two current rows leaves
   * the slot unresolvable, so a crash between two writes would be the state this is preventing.
   * Hashes in `supersede` that this root does not hold are ignored; `AssetStore.hold` routes the
   * call to the root the slot's art lives in, and a slot's candidates share a kind and so share a
   * root. `at` is restamped on every hold; `via` is written only where the row has none.
   */
  async hold(hash: string, supersede: readonly string[], stamp: TakeStamp = {}): Promise<boolean> {
    const asset = this.index.get(hash);
    if (!asset) return false;
    let changed = !asset.current;
    asset.current = true;
    if (stamp.at !== undefined && asset.at !== stamp.at) {
      asset.at = stamp.at;
      changed = true;
    }
    if (stamp.via !== undefined && asset.via === undefined) {
      asset.via = stamp.via;
      changed = true;
    }
    for (const other of supersede) {
      const sibling = other === hash ? undefined : this.index.get(other);
      if (!sibling?.current) continue;
      sibling.current = false;
      changed = true;
    }
    if (changed) await this.persist();
    return true;
  }

  /** Mark an asset approved by a person. Returns whether this root holds `hash`. */
  async accept(hash: string): Promise<boolean> {
    const asset = this.index.get(hash);
    if (!asset) return false;
    if (!asset.accepted) {
      asset.accepted = true;
      await this.persist();
    }
    return true;
  }

  /**
   * Un-accept an asset, leaving its slot with no answer. Returns whether this root holds `hash`.
   * The bytes stay; only the manifest flag moves, so the take is still there to accept again.
   */
  async unaccept(hash: string): Promise<boolean> {
    const asset = this.index.get(hash);
    if (!asset) return false;
    if (asset.accepted) {
      asset.accepted = false;
      await this.persist();
    }
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

  /** Whether any row predates takes being held, which is what the migration keys on. */
  get unstamped(): boolean {
    for (const asset of this.index.values()) if (asset.current === undefined) return true;
    return false;
  }

  /**
   * Rewrite every row's take fields in one write. `decide` answers for each row; the angle, when
   * given, goes onto the outfit binding it belongs to. Nothing is written when nothing changed.
   */
  async migrateTakes(decide: (asset: Asset) => TakeEdit): Promise<boolean> {
    let changed = false;
    for (const asset of this.index.values()) {
      const edit = decide(asset);
      if (asset.current !== edit.current) {
        asset.current = edit.current;
        changed = true;
      }
      if (edit.at !== undefined && asset.at === undefined) {
        asset.at = edit.at;
        changed = true;
      }
      if (edit.via !== undefined && asset.via === undefined) {
        asset.via = edit.via;
        changed = true;
      }
      if (edit.angle !== undefined) {
        for (const b of asset.satisfies) {
          if (b.characterId === undefined || b.outfit === undefined || b.angle !== undefined)
            continue;
          b.angle = edit.angle;
          changed = true;
        }
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  private async writeManifest(): Promise<void> {
    const file: ManifestFile = {
      version: 1,
      assets : [...this.index.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
    };
    await ensureDir(dirname(this.manifestFile));
    await writeFileAtomic(this.manifestFile, JSON.stringify(file, null, 2) + '\n');
  }
}

/**
 * Content-addressed asset store + manifest (report §8), across two roots: base art (portraits,
 * model sheets, location refs) under `assets/`, and project art (shot frames) under
 * `vngen/build/`. Full write-up: `docs/reference/asset-stores.md`.
 *
 * Routing is by {@link AssetKind} and nothing else, so where an asset lives is never ambiguous.
 * Reads consult both roots, which is safe because hashes are content hashes and a hash present in
 * both roots names the same bytes. It is also why a project written before the split keeps
 * resolving: its base art is still indexed in the project manifest, and nothing on disk moves.
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

  get(hash: string): Asset | undefined {
    return this.rowRoot(hash).get(hash);
  }

  async write(bytes: Uint8Array, ext: string, meta: AssetMeta): Promise<AssetRef> {
    const root = this.rootFor(meta.kind);
    const ref = await root.write(bytes, ext, meta);
    // The write created the base subtree and its manifest, so `absent` no longer holds and a
    // surface reading `base` after a run sees the root as it now is
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
   * The manifest recording `hash`, which is the file {@link hold}, {@link accept} and
   * {@link unaccept} rewrite.
   * Both follow {@link rowRoot}, so a caller reporting what it wrote has to ask which root
   * answered rather than naming one of the two.
   */
  manifestFileOf(hash: string): string {
    return this.rowRoot(hash).manifestFile;
  }

  /**
   * Both manifests as one list, deduped by hash. The roots cannot disagree about content, so
   * where both hold a hash one row is reported, chosen by {@link rowRoot}.
   */
  manifest(): readonly Asset[] {
    const all: Asset[] = [];
    for (const asset of this.baseRoot.assets()) all.push(this.rowRoot(asset.hash).get(asset.hash)!);
    for (const asset of this.projectRoot.assets()) {
      if (!this.baseRoot.has(asset.hash)) all.push(asset);
    }
    return all;
  }

  async hold(hash: string, supersede: readonly string[], stamp: TakeStamp = {}): Promise<void> {
    await this.rowRoot(hash).hold(hash, supersede, stamp);
  }

  async accept(hash: string): Promise<void> {
    await this.rowRoot(hash).accept(hash);
  }

  /** Whether either manifest has a row written before takes were held. */
  get unstamped(): boolean {
    return this.baseRoot.unstamped || this.projectRoot.unstamped;
  }

  /**
   * The migration's one write per root. `decide` sees the row {@link manifest} reports for a hash;
   * a hash's other row, in the root that does not answer for it, is stamped not current, so the
   * trigger goes quiet on every row.
   */
  async migrateTakes(decide: (asset: Asset) => TakeEdit): Promise<void> {
    for (const root of [this.baseRoot, this.projectRoot]) {
      await root.migrateTakes((asset) =>
        this.rowRoot(asset.hash) === root ? decide(asset) : { current: false },
      );
    }
  }

  async unaccept(hash: string): Promise<void> {
    await this.rowRoot(hash).unaccept(hash);
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

  /**
   * The root whose row answers for `hash`: the one whose manifest is reported for it and whose
   * flags a flag write moves.
   *
   * A hash both roots hold is a picture adopted across them: an upload or a concept in the base
   * root that became a shot frame in the project root. The project row is then the one bound to
   * a slot, so it wins whenever it carries a project kind. A project row carrying a base kind is a
   * manifest written before the split, and the base row wins as it always has. Bytes are the same
   * in both, so `read` and `pathOf` never need this distinction.
   */
  private rowRoot(hash: string): AssetRoot {
    const row = this.projectRoot.get(hash);
    if (row && !BASE_KINDS.has(row.kind)) return this.projectRoot;
    return this.rootHolding(hash);
  }
}

/**
 * There are three states so that "nothing generated yet" and "the base repo was never cloned" stay
 * distinguishable. A missing directory means a legacy or brand-new project, which is written into.
 * A directory with no manifest is what a missing submodule leaves behind. Confusing the two makes
 * a run regenerate an entire approved base library.
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

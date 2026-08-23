/**
 * The project model and the composition contracts (report §4). These tie the
 * deterministic and generative halves together; `@vn/types` is the single source of
 * truth for these shapes so every other package depends only on this one.
 */
import type {
  Asset,
  AssetBinding,
  AssetKind,
  AssetRef,
  Character,
  Location,
  Scene,
} from './entities.js';
import type { AnyTask, Task, TaskKind } from './tasks.js';
import type { Providers } from './providers.js';

/** A validation diagnostic produced while building the project model (report §P0). */
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** Entity id the diagnostic concerns, when applicable. */
  where?: string;
}

/** The in-memory project model built from parsed input files (report §P0, §6). */
export interface ProjectModel {
  title: string;
  characters: Map<string, Character>;
  locations: Map<string, Location>;
  scenes: Map<string, Scene>;
  /** Scene ids reachable from the entry scene. */
  reachable: Set<string>;
  /** Entry scene id: `project.yaml`'s `start:`, or the screenplay's first scene without one. */
  entry?: string;
  diagnostics: Diagnostic[];
}

/** Structured logger (implemented by `@vn/util`). */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Provenance metadata recorded when an asset is written (report §8). */
export interface AssetMeta {
  kind: AssetKind;
  sourceTask: string;
  prompt?: string;
  refs?: string[];
  modelId: string;
  /** What this asset is for. One binding per write; the store merges it into the record's list. */
  satisfies?: AssetBinding;
  accepted?: boolean;
  /** See {@link Asset.title}. */
  title?: string;
}

/**
 * Where the base asset root stands.
 *
 * `absent` (no directory) is a legacy or brand-new project and is written into freely.
 * `unavailable` — a directory with no manifest — is the shape a missing base repo leaves
 * behind, and must never be read as "nothing generated yet": that mistake regenerates an
 * entire approved base library at cost.
 */
export type BaseAssetState = 'absent' | 'unavailable' | 'ready';

/** The base asset root, as a surface (or a planner) needs to describe it. */
export interface BaseAssets {
  state: BaseAssetState;
  /** Absolute path of the base subtree, whether or not it exists. */
  root: string;
  count: number;
}

/** Content-addressed asset store + manifest (implemented by `@vn/store`). */
export interface AssetStore {
  has(hash: string): boolean;
  /** Persist bytes; returns the asset ref and registers provenance in the manifest. */
  write(bytes: Uint8Array, ext: string, meta: AssetMeta): Promise<AssetRef>;
  read(ref: AssetRef): Promise<Uint8Array>;
  /** Absolute path of a stored asset. */
  pathOf(ref: AssetRef): string;
  manifest(): readonly Asset[];
  /**
   * Mark an asset accepted (an approved portrait or an accepted shot), un-accepting the hashes in
   * `supersede` in the same write. Acceptance is exclusive per slot: a slot holding two accepted
   * candidates cannot be resolved, so it reads as empty.
   */
  accept(hash: string, supersede?: readonly string[]): Promise<void>;
  /** The base root's state; absent on a store that has only one root (test fakes). */
  readonly base?: BaseAssets;
}

/** Append-only, content-addressed task graph (implemented by `@vn/taskgraph`). */
export interface TaskGraph {
  /** Add a task if its hash is new; returns the canonical (possibly existing) node. */
  add<K extends TaskKind>(task: Task<K>): Task<K>;
  get(hash: string): AnyTask | undefined;
  all(): readonly AnyTask[];
  /** Tasks with no unmet dependencies that are still `pending`. */
  ready(): readonly AnyTask[];
  setStatus(hash: string, status: AnyTask['status'], patch?: Partial<AnyTask>): void;
  /** Topologically ordered task hashes; throws on a cycle. */
  topoOrder(): string[];
}

/** Outcome of running a single task. */
export interface TaskResult {
  status: 'done' | 'failed' | 'needs_human';
  output?: string;
  error?: string;
}

/** Execution context handed to a phase runner. */
export interface RunContext {
  model: ProjectModel;
  graph: TaskGraph;
  store: AssetStore;
  providers: Providers;
  logger: Logger;
}

/** A pipeline phase: a planner (emits/dedupes tasks) + a runner (executes one). */
export interface Phase {
  readonly name: string;
  /** Which task kinds this phase knows how to run. */
  readonly handles: readonly TaskKind[];
  plan(ctx: RunContext): void;
  run(task: AnyTask, ctx: RunContext): Promise<TaskResult>;
}

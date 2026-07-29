/**
 * The project model and the composition contracts (report §4). These tie the
 * deterministic and generative halves together; `@vn/types` is the single source of
 * truth for these shapes so every other package depends only on this one.
 */
import type { Asset, AssetKind, AssetRef, Character, Location, Scene } from './entities.js';
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
  satisfies?: Asset['satisfies'];
  accepted?: boolean;
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
  /** Mark an asset accepted (an approved portrait or an accepted shot). */
  accept(hash: string): Promise<void>;
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

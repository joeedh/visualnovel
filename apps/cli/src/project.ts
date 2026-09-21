import type { ProjectConfig, ResolvedKeys } from '@vn/config';
import type { LoadedInputs } from '@vn/parse';
import type { Logger, ProjectModel, Providers } from '@vn/types';
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { errors as modelErrors, modelFromInputs } from '@vn/model';
import { AssetStore, ProjectPaths, loadInputs, readAllShots } from '@vn/store';
import { TaskGraph, loadGraph } from '@vn/taskgraph';
import { readModelCatalog, repairCurrent } from '@vn/pipeline';
import {
  createImageBackend,
  createMockProviders,
  createProviders,
  projectModels,
  resolveRoutes,
  StubImageBackend,
  type ImageBackend,
  type RouteRequest,
} from '@vn/providers';

/** A fully-loaded project: config, paths, model, persisted store + task graph. */
export interface LoadedProject {
  dir: string;
  config: ProjectConfig;
  paths: ProjectPaths;
  model: ProjectModel;
  store: AssetStore;
  graph: TaskGraph;
  /**
   * The documents this model was built from, kept so a writer patches the files the decision was
   * made against. Entities are discovered by tag, so this is also the only answer to which file a
   * given character or location lives in.
   */
  inputs: LoadedInputs;
}

/**
 * Load and assemble everything from a project directory (report §P0): config, authored
 * input files → validated project model, the content-addressed asset store, and the task
 * graph replayed from `tasks.jsonl`. Validation diagnostics live on `model.diagnostics`;
 * callers decide whether error-severity diagnostics should abort. The manifest's `current`
 * bits are put right against the task log on the way in, so `vngen export` after an upgrade
 * reads the same takes a run would.
 */
export async function loadProject(dir: string): Promise<LoadedProject> {
  const config = await loadConfig(dir);
  const paths = new ProjectPaths(dir);
  const inputs = await loadInputs(paths);
  const model = modelFromInputs(inputs, { title: config.title, start: config.start });
  const store = await AssetStore.open(paths);
  const graph = await loadGraph(paths);
  await repairCurrent({ model, config, store, graph, shots: await readAllShots(paths, model) });
  return { dir, config, paths, model, store, graph, inputs };
}

/** Throw a readable error if the model has any error-severity diagnostics (report §P0). */
export function assertValid(model: ProjectModel): void {
  const errs = modelErrors(model);
  if (errs.length) {
    const lines = errs.map((d) => `  [${d.code}] ${d.message}`).join('\n');
    throw new Error(`project has ${errs.length} validation error(s):\n${lines}`);
  }
}

/** What a run reaches the outside world through, whether it runs tasks or a generation graph. */
export interface GenDeps {
  providers: Providers;
  /** The byte-level image seam a graph's image nodes call, beneath the provider the runners use. */
  imageBackend: ImageBackend;
  /** Absent under `mock`, where nothing is resolved and no vendor is reached. */
  keys?: ResolvedKeys;
}

/**
 * Build everything a run calls out through. `--mock` yields deterministic offline providers so a
 * sample project can be exercised end-to-end without API access. Otherwise real Gemini/Claude
 * clients are constructed, reading reference bytes back out of the asset store.
 */
export async function buildGenDeps(
  project: LoadedProject,
  opts: { mock?: boolean; logger?: Logger; routes?: RouteRequest } = {},
): Promise<GenDeps> {
  const loadRef = async (ref: { hash: string; ext: string }) => ({
    bytes: await project.store.read(ref),
    ext  : ref.ext,
  });
  if (opts.mock) {
    const imageBackend = new StubImageBackend();
    return { providers: createMockProviders({ refLoader: loadRef, imageBackend }), imageBackend };
  }

  // A run draws and reviews, so every configured model must have a route before it starts;
  // `vngen decompose` only writes text, and refusing it for a missing image key would be a
  // refusal the author cannot act on, so it passes its own list.
  const keys: ResolvedKeys = await resolveKeys(project.config, {
    secretsDirs: await secretDirsFor(project.dir),
  });
  resolveRoutes(project.config, keys, opts.routes ?? projectModels(project.config));
  // The cached listing says which OpenRouter models take a seed, so the router refuses one by
  // name rather than sending it
  const catalog = (await readModelCatalog())?.openrouter ?? [];
  return {
    providers   : createProviders({ config: project.config, keys, loadRef, catalog }),
    imageBackend: createImageBackend(project.config, keys, { catalog }),
    keys,
  };
}

/** The provider bundle alone, for a command that runs no graph. */
export async function buildProviders(
  project: LoadedProject,
  opts: { mock?: boolean; logger?: Logger; routes?: RouteRequest } = {},
): Promise<Providers> {
  return (await buildGenDeps(project, opts)).providers;
}

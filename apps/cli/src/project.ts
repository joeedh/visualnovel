import type { ProjectConfig, ResolvedKeys } from '@vn/config';
import type { LoadedInputs } from '@vn/parse';
import type { Logger, ProjectModel, Providers } from '@vn/types';
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { errors as modelErrors, modelFromInputs } from '@vn/model';
import { AssetStore, ProjectPaths, loadInputs } from '@vn/store';
import { TaskGraph, loadGraph } from '@vn/taskgraph';
import {
  createImageBackend,
  createMockProviders,
  createProviders,
  StubImageBackend,
  type ImageBackend,
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
 * callers decide whether error-severity diagnostics should abort.
 */
export async function loadProject(dir: string): Promise<LoadedProject> {
  const config = await loadConfig(dir);
  const paths = new ProjectPaths(dir);
  const inputs = await loadInputs(paths);
  const model = modelFromInputs(inputs, { title: config.title, start: config.start });
  const store = await AssetStore.open(paths);
  const graph = await loadGraph(paths);
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
  opts: { mock?: boolean; logger?: Logger; require?: (keyof ResolvedKeys)[] } = {},
): Promise<GenDeps> {
  const loadRef = async (ref: { hash: string; ext: string }) => ({
    bytes: await project.store.read(ref),
    ext: ref.ext,
  });
  if (opts.mock) {
    const imageBackend = new StubImageBackend();
    return { providers: createMockProviders({ refLoader: loadRef, imageBackend }), imageBackend };
  }

  // A run draws, so it needs the image key; `vngen decompose` only writes text, and refusing it
  // for a missing image key would be a refusal the author cannot act on.
  const keys: ResolvedKeys = await resolveKeys(project.config, {
    secretsDirs: await secretDirsFor(project.dir),
    require: opts.require ?? ['gemini'],
  });
  return {
    providers: createProviders({ config: project.config, keys, loadRef }),
    imageBackend: createImageBackend(project.config, keys),
    keys,
  };
}

/** The provider bundle alone, for a command that runs no graph. */
export async function buildProviders(
  project: LoadedProject,
  opts: { mock?: boolean; logger?: Logger; require?: (keyof ResolvedKeys)[] } = {},
): Promise<Providers> {
  return (await buildGenDeps(project, opts)).providers;
}

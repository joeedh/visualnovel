import type { ProjectConfig, ResolvedKeys } from '@vn/config';
import type { Logger, ProjectModel, Providers } from '@vn/types';
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { errors as modelErrors, modelFromInputs } from '@vn/model';
import { AssetStore, ProjectPaths, loadInputs } from '@vn/store';
import { TaskGraph, loadGraph } from '@vn/taskgraph';
import { createMockProviders, createProviders } from '@vn/providers';

/** A fully-loaded project: config, paths, model, persisted store + task graph. */
export interface LoadedProject {
  dir: string;
  config: ProjectConfig;
  paths: ProjectPaths;
  model: ProjectModel;
  store: AssetStore;
  graph: TaskGraph;
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
  return { dir, config, paths, model, store, graph };
}

/** Throw a readable error if the model has any error-severity diagnostics (report §P0). */
export function assertValid(model: ProjectModel): void {
  const errs = modelErrors(model);
  if (errs.length) {
    const lines = errs.map((d) => `  [${d.code}] ${d.message}`).join('\n');
    throw new Error(`project has ${errs.length} validation error(s):\n${lines}`);
  }
}

/**
 * Build the provider bundle for a run. `--mock` (or no resolvable keys when explicitly
 * requested) yields deterministic offline providers so a sample project can be exercised
 * end-to-end without API access; otherwise real Gemini/Claude clients are constructed,
 * reading reference bytes back out of the asset store.
 */
export async function buildProviders(
  project: LoadedProject,
  opts: { mock?: boolean; logger?: Logger } = {},
): Promise<Providers> {
  const loadRef = async (ref: { hash: string; ext: string }) => ({
    bytes: await project.store.read(ref),
    ext: ref.ext,
  });
  if (opts.mock) return createMockProviders({ refLoader: loadRef });

  const keys: ResolvedKeys = await resolveKeys(project.config, {
    secretsDirs: await secretDirsFor(project.dir),
    require: ['gemini'],
  });
  return createProviders({ config: project.config, keys, loadRef });
}

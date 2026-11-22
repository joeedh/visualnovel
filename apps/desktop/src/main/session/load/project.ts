import { loadConfig, type ProjectConfig } from '@vn/config';
import type { PhaseTimer } from '@vn/commands';
import { modelFromInputs } from '@vn/model';
import type { LoadedInputs } from '@vn/parse';
import { AssetStore, ProjectPaths, loadInputs, withProduction } from '@vn/store';
import { repairCurrent, type HostFacts } from '@vn/pipeline';
import { angleOfTask } from '@vn/stills';
import { loadGraph, type TaskGraph } from '@vn/taskgraph';
import type { ProjectModel } from '@vn/types';
import { sourcesOf, type SceneEditInput, type SceneSource } from '@vn/scriptedit/write';

/** A loaded project: config, paths, validated model, persisted store + task graph. */
export interface LoadedProject {
  dir: string;
  config: ProjectConfig;
  paths: ProjectPaths;
  model: ProjectModel;
  store: AssetStore;
  graph: TaskGraph;
  /** The files this model's scenes were built from — the files a prose edit patches. */
  sources: SceneSource[];
  /** Every discovered sheet and scene chunk, each carrying the file it was found in. Entities are
   * discovered by tag rather than by path, so this record is the only place that knows which
   * file holds which entity. */
  inputs: LoadedInputs;
}

/** The inputs `@vn/scriptedit` decides and writes against, built from one loaded project. */
export const editInputOf = (project: LoadedProject): SceneEditInput => ({
  paths  : project.paths,
  sources: project.sources,
  ...(project.config.start === undefined ? {} : { entry: project.config.start }),
});

/**
 * The project's model with every persisted storyboard in its production map, for a reader that
 * resolves shot slots. `project.model` keeps the map the builder left, which a run plans from.
 */
export async function withShots(project: LoadedProject): Promise<ProjectModel> {
  return withProduction(project.paths, project.model);
}

/**
 * Builds the facts the session solves the project's family over and seeds sheets from: the loaded
 * project's config, task log and manifest, over `model` (usually {@link withShots}'s), with a
 * sheet row's angle read off its task. The kinds memoise on the object returned, so a caller
 * builds new facts after changing either.
 */
export function sessionFacts(project: LoadedProject, model: ProjectModel): HostFacts {
  return {
    model,
    config : project.config,
    tasks  : project.graph,
    assets : project.store.manifest(),
    angleOf: angleOfTask(project.graph),
  };
}

/**
 * Reads the project as it is on disk, writing nothing. Validation reads through this, because
 * {@link loadProject}'s repair would put right the over-held slots it is meant to report.
 */
export async function readProject(dir: string, timing?: PhaseTimer): Promise<LoadedProject> {
  const paths = new ProjectPaths(dir);
  const config = timing
    ? await timing.measure('configReadMs', () => loadConfig(dir))
    : await loadConfig(dir);
  const inputs = timing
    ? await timing.measure('inputsReadMs', () => loadInputs(paths))
    : await loadInputs(paths);
  const build = () => modelFromInputs(inputs, config);
  const model = timing ? timing.measureSync('modelBuildMs', build) : build();
  const store = timing
    ? await timing.measure('assetsReadMs', () => AssetStore.open(paths))
    : await AssetStore.open(paths);
  const graph = timing
    ? await timing.measure('graphReadMs', () => loadGraph(paths))
    : await loadGraph(paths);
  return { dir, config, paths, model, store, graph, sources: sourcesOf(inputs), inputs };
}

export async function loadProject(dir: string, timing?: PhaseTimer): Promise<LoadedProject> {
  const project = timing
    ? await timing.measure('projectReadMs', () => readProject(dir, timing))
    : await readProject(dir);
  const { config, store, graph } = project;
  // `current` is a cache of the task log, and a slot holding two current rows resolves to
  // nothing, so every surface reading this project would show it as unrendered; the manifest is
  // put right as it is read, and migrated once on a project written before takes were held
  const shotModel = timing
    ? await timing.measure('projectShotsMs', () => withShots(project))
    : await withShots(project);
  const repair = () => repairCurrent({ model: shotModel, config, store, graph });
  if (timing) await timing.measure('projectRepairMs', repair);
  else await repair();
  return project;
}

/**
 * A cheap project index (authoring-agent plan §6.1). It assembles `loadInputs` +
 * `modelFromInputs` into a flat list of which characters/locations/scenes exist — ids, names,
 * and the file each lives in — without holding full bodies. The agent uses it to know
 * what's there before reading anything. `load()` exposes the full model + raw docs for
 * tools that need to read or edit prose; `index()` is the lightweight summary.
 */
import { join } from 'node:path';
import { parseFrontMatter, type FrontMatterDoc, type LoadedInputs } from '@vn/parse';
import { modelFromInputs } from '@vn/model';
import { loadInputs, ProjectPaths } from '@vn/store';
import { sourcesOf, type SceneEditInput } from '@vn/scriptedit/write';
import { loadConfig } from '@vn/config';
import { exists, readText } from '@vn/util';
import type { CharacterStatus, Diagnostic, ProjectModel } from '@vn/types';

/** A single character row in the index. */
export interface CharacterEntry {
  id: string;
  name: string;
  status: CharacterStatus;
  file: string;
}

/** A single location row in the index. */
export interface LocationEntry {
  id: string;
  name: string;
  mined: boolean;
  file: string;
}

/** A single scene row in the index. */
export interface SceneEntry {
  id: string;
  location: string;
  characters: string[];
  choices: number;
  reachable: boolean;
  /** The `scenes/<id>.md` this scene lives in; absent only if the scene was built some other way. */
  file?: string;
}

/** The lightweight structural snapshot the agent keeps in context. */
export interface WorkspaceIndex {
  root: string;
  title: string;
  /**
   * A retired `screenplay/` script the project still holds. Not an input — its presence is why
   * `diagnostics` names `vngen import`; the agent surfaces it so the author can convert.
   */
  screenplay?: string;
  characters: CharacterEntry[];
  locations: LocationEntry[];
  scenes: SceneEntry[];
  entry?: string;
  diagnostics: Diagnostic[];
}

/** Full load result: the built model plus the raw docs (for editing/serialization). */
export interface LoadedWorkspace {
  title: string;
  model: ProjectModel;
  inputs: LoadedInputs;
}

/** Bind a workspace to a project root; all paths are resolved through `ProjectPaths`. */
export class Workspace {
  readonly paths: ProjectPaths;

  constructor(readonly root: string) {
    this.paths = new ProjectPaths(root);
  }

  /** Load all inputs and build the validated project model. */
  async load(): Promise<LoadedWorkspace> {
    const inputs = await loadInputs(this.paths);
    let title = 'Untitled';
    let start: string | undefined;
    try {
      const config = await loadConfig(this.root);
      title = config.title;
      start = config.start;
    } catch {
      // No (or invalid) project.yaml: the agent still operates, title is a placeholder.
    }
    const model = modelFromInputs(inputs, { title, start });
    return { title, model, inputs };
  }

  /** Build the lightweight index from the model. */
  async index(): Promise<WorkspaceIndex> {
    const { title, model, inputs } = await this.load();
    // Both come from the load, not from a second look at the directory: which file is the
    // screenplay is the loader's decision, and it is the only one that reports it.
    const chunkFiles = new Map(inputs.sceneDocs.map((c) => [c.id, c.file]));
    const screenplay = inputs.legacyScreenplay;

    const characters: CharacterEntry[] = [...model.characters.values()].map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      file: this.paths.characterFile(c.id),
    }));
    const locations: LocationEntry[] = [...model.locations.values()].map((l) => ({
      id: l.id,
      name: l.name,
      mined: l.mined,
      file: join(this.paths.locationsDir, `${l.id}.md`),
    }));
    const scenes: SceneEntry[] = [...model.scenes.values()].map((s) => ({
      id: s.id,
      location: s.location,
      characters: s.characters,
      choices: s.choices.length,
      reachable: model.reachable.has(s.id),
      ...(chunkFiles.has(s.id) ? { file: chunkFiles.get(s.id)! } : {}),
    }));

    return {
      root: this.root,
      title,
      ...(screenplay ? { screenplay } : {}),
      characters,
      locations,
      scenes,
      entry: model.entry,
      diagnostics: model.diagnostics,
    };
  }

  /**
   * Everything a scene edit is decided and patched against, off **one** load — which is the
   * contract, not an optimization: a writer must patch the files the model it decided against was
   * built from, or it re-decides which file is authoritative halfway through.
   */
  async sceneEditInput(): Promise<SceneEditInput> {
    const { model, inputs } = await this.load();
    return {
      paths: this.paths,
      sources: sourcesOf(inputs),
      ...(model.entry === undefined ? {} : { entry: model.entry }),
    };
  }

  /** Read a character's raw doc (for editing). Returns null if the file is absent. */
  async characterDoc(id: string): Promise<FrontMatterDoc | null> {
    const file = this.paths.characterFile(id);
    if (!(await exists(file))) return null;
    return parseFrontMatter(await readText(file));
  }

  /** Read a location's raw doc (for editing). Returns null if the file is absent. */
  async locationDoc(id: string): Promise<FrontMatterDoc | null> {
    const file = join(this.paths.locationsDir, `${id}.md`);
    if (!(await exists(file))) return null;
    return parseFrontMatter(await readText(file));
  }
}

/** Render an index as a compact human/agent-readable summary. */
export function formatIndex(index: WorkspaceIndex): string {
  const lines = [`# ${index.title}`, ''];
  lines.push(`Characters (${index.characters.length}):`);
  for (const c of index.characters) lines.push(`  - ${c.id} "${c.name}" [${c.status}]`);
  lines.push(`Locations (${index.locations.length}):`);
  for (const l of index.locations)
    lines.push(`  - ${l.id} "${l.name}"${l.mined ? ' (mined)' : ''}`);
  lines.push(`Scenes (${index.scenes.length}):`);
  for (const s of index.scenes) {
    const flags = [s.reachable ? '' : 'unreachable', s.choices ? `${s.choices} choices` : '']
      .filter(Boolean)
      .join(', ');
    lines.push(`  - ${s.id} @${s.location}${flags ? ` (${flags})` : ''}`);
  }
  const errs = index.diagnostics.filter((d) => d.severity === 'error').length;
  const warns = index.diagnostics.filter((d) => d.severity === 'warning').length;
  lines.push('', `Diagnostics: ${errs} error(s), ${warns} warning(s)`);
  return lines.join('\n');
}

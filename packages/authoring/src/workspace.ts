/**
 * A cheap project index (authoring-agent plan §6.1). It assembles `loadInputs` +
 * `modelFromInputs` into a flat list of which characters/locations/scenes exist — ids, names,
 * and the file each lives in — without holding full bodies. The agent uses it to know
 * what's there before reading anything. `load()` exposes the full model + raw docs for
 * tools that need to read or edit prose; `index()` is the lightweight summary.
 */
import type { EntityDoc, LoadedInputs } from '@vn/parse';
import { modelFromInputs } from '@vn/model';
import { openBible, type Bible } from '@vn/bible';
import { baseAssetsOf, loadInputs, readShots, ProjectPaths } from '@vn/store';
import {
  moveShot,
  setSceneOutfit,
  setShotOutfit,
  wardrobesOf,
  type BranchOp,
  type LineOp,
  type SceneMap,
  type SceneOutfitOp,
  type ScriptState,
  type ShotOutfitOp,
} from '@vn/scriptedit';
import { sourcesOf, type SceneEditInput, type SceneSource } from '@vn/scriptedit/write';
import { loadConfig } from '@vn/config';
import { RepoResolver } from '@vn/git';
import { exists, readText, VnError, writeFileAtomic } from '@vn/util';
import { join, relative, resolve, sep } from 'node:path';
import type { BaseAssets, CharacterStatus, Diagnostic, ProjectModel } from '@vn/types';
import {
  countsOf,
  GENERATED_CONTEXT_FILE,
  isGenerated,
  projectMap,
  renderGeneratedContext,
  type GeneratedCounts,
} from './generated.js';

/** A single character row in the index. */
export interface CharacterEntry {
  id: string;
  name: string;
  status: CharacterStatus;
  /** The sheet this character was discovered in. Reported from the load, never rebuilt from
   * the id — a tagged entity lives wherever its file lives. */
  file?: string;
}

/** A single location row in the index. */
export interface LocationEntry {
  id: string;
  name: string;
  mined: boolean;
  /** Absent for a mined location, which has no authored sheet yet; see {@link CharacterEntry}. */
  file?: string;
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

/** A git repository the project spans, and what part of the project it holds. */
export interface RepoRef {
  role: 'project' | 'wiki' | 'base';
  /** The work-tree root git reports for that part — not the directory that was asked about. */
  root: string;
  /**
   * True when the directory *is* that root. False means the project sits inside a larger repo
   * (a monorepo checkout, say), whose history is somebody else's to write.
   */
  owned: boolean;
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
  /**
   * How many files the story bible holds. A count, never contents: the index tells the agent a
   * bible exists so it knows to reach for `search_bible`; the bible itself is never pasted.
   */
  bibleFiles: number;
  /**
   * The base asset root — state, path, and how many assets it indexes. Carried so a surface can
   * say "unavailable" rather than draw an empty gallery, which is the same picture as "none yet".
   */
  baseAssets: BaseAssets;
  /** Which repo owns which part of the project. See {@link Workspace.repos}. */
  repos: RepoRef[];
  diagnostics: Diagnostic[];
}

/** Where the generated context sits, and whether the generator may replace what is there. */
export interface GeneratedContextState {
  /** Absolute path of `AICONTEXT.generated.md`, whether or not it exists. */
  file: string;
  exists: boolean;
  /** True when the file carries the generator's banner — so ours to overwrite, and ours to load. */
  generated: boolean;
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
  private opened?: Promise<Bible>;

  constructor(readonly root: string) {
    this.paths = new ProjectPaths(root);
  }

  /**
   * The story bible under `wiki/`, opened once and reused — the index re-walks on every query,
   * so a long-lived handle stays current without the caller tracking edits.
   */
  bible(): Promise<Bible> {
    return (this.opened ??= openBible(this.paths.wikiDir));
  }

  /**
   * The repos this project spans: its own, plus the story bible's and the base assets' when
   * `wiki/` or `assets/` is a repository rather than a directory inside the project's.
   *
   * Discovered through `git rev-parse`, never declared — a `repos:` block in `project.yaml`
   * would be a second source of truth, wrong the moment someone runs `git init` in `wiki/`.
   * Resolved fresh each call for the same reason.
   */
  async repos(): Promise<RepoRef[]> {
    const resolver = new RepoResolver();
    const found: RepoRef[] = [];
    const seen = new Set<string>();
    const parts = [
      ['project', this.root],
      ['wiki', this.paths.wikiDir],
      ['base', this.paths.baseAssets],
    ] as const;
    for (const [role, dir] of parts) {
      const root = await resolver.rootOf(dir);
      if (root === null || seen.has(root)) continue;
      seen.add(root);
      found.push({ role, root, owned: root === resolve(dir) });
    }
    return found;
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
    const characterFiles = new Map(inputs.characterDocs.map((d) => [d.id, d.file]));
    const locationFiles = new Map(inputs.locationDocs.map((d) => [d.id, d.file]));
    const screenplay = inputs.legacyScreenplay;
    const bible = await this.bible();
    await bible.refresh();

    const characters: CharacterEntry[] = [...model.characters.values()].map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      ...(characterFiles.has(c.id) ? { file: characterFiles.get(c.id)! } : {}),
    }));
    const locations: LocationEntry[] = [...model.locations.values()].map((l) => ({
      id: l.id,
      name: l.name,
      mined: l.mined,
      ...(locationFiles.has(l.id) ? { file: locationFiles.get(l.id)! } : {}),
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
      bibleFiles: bible.files().length,
      baseAssets: await baseAssetsOf(this.paths),
      repos: await this.repos(),
      diagnostics: model.diagnostics,
    };
  }

  /** Where the generated context lives for this project, and whether it is ours to replace. */
  async generatedContext(): Promise<GeneratedContextState> {
    const file = join(this.root, GENERATED_CONTEXT_FILE);
    if (!(await exists(file))) return { file, exists: false, generated: false };
    return { file, exists: true, generated: isGenerated(await readText(file)) };
  }

  /**
   * Regenerate `AICONTEXT.generated.md` from one load of the project plus the bible's table of
   * contents. **Refuses** rather than overwrites a file at that path that does not carry the
   * generator's banner: an author who wrote one there did not donate it. The output is a pure
   * function of the project — no timestamp — so re-running over an unchanged project rewrites
   * the same bytes and leaves git alone.
   */
  async writeGeneratedContext(
    opts: { budget?: number } = {},
  ): Promise<{ file: string; counts: GeneratedCounts }> {
    const state = await this.generatedContext();
    if (state.exists && !state.generated) {
      throw new VnError(
        'GENERATED_CONTEXT',
        `${GENERATED_CONTEXT_FILE} exists and was not written by workspace.reindex — ` +
          'move or delete it first. Nothing was written.',
      );
    }
    const { model, inputs } = await this.load();
    const bible = await this.bible();
    await bible.refresh();
    const map = projectMap(this.root, model, inputs, bible.files());
    await writeFileAtomic(state.file, renderGeneratedContext(map, opts));
    return { file: state.file, counts: countsOf(map) };
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

  /**
   * The decision behind `edit_scene`'s `moveShot`, which is the one act whose *rule* needs the
   * storyboard: `planSceneEdit` hands its callback the script state and nothing else, so the shots
   * are read here and curried in. Same shape as the desktop's `session.shotOrder`, deliberately —
   * one authorial act, one answer.
   */
  async shotOrder(
    sceneId: string,
    shot: string,
    after: string,
  ): Promise<(state: ScriptState) => LineOp> {
    const { model } = await this.load();
    const scene = model.scenes.get(sceneId);
    if (!scene) return () => ({ ok: false, error: `No scene "${sceneId}".` });
    const loaded = await readShots(this.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    if (!loaded) {
      return () => ({
        ok: false,
        error: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
      });
    }
    return moveShot(loaded.shots, { shot, after });
  }

  /**
   * A rewire decided against the scenes as they load, plus the files its patch would target.
   * `decide` is passed in rather than the edits for the reason `session.editBranches` takes one:
   * the decision and the patch must see the same load, or the rule answers about a graph the
   * writer is no longer editing.
   */
  async branchEdit(
    decide: (scenes: SceneMap) => BranchOp,
  ): Promise<{ op: BranchOp; sources: SceneSource[] }> {
    const { model, inputs } = await this.load();
    return { op: decide(model.scenes), sources: sourcesOf(inputs) };
  }

  /**
   * The scene-marker outfit rule, plus the files its patch would target — off one load, for the
   * same reason {@link sceneEditInput} is: the marker is spliced into the bytes the rule read.
   * Same shape as the desktop's `session.sceneOutfitRule`, deliberately.
   */
  async sceneOutfit(
    sceneId: string,
    character: string,
    outfit: string,
  ): Promise<{ op: SceneOutfitOp; sources: SceneSource[] }> {
    const { model, inputs } = await this.load();
    const wardrobes = wardrobesOf(model.characters);
    return {
      op: setSceneOutfit(model.scenes, wardrobes, { scene: sceneId, character, outfit }),
      sources: sourcesOf(inputs),
    };
  }

  /**
   * The shot-override rule. The storyboard is read here for the reason {@link shotOrder} reads
   * it — the rule needs the shots, and nothing above this hands them down.
   */
  async shotOutfit(
    sceneId: string,
    shotId: string,
    character: string,
    outfit: string,
  ): Promise<ShotOutfitOp> {
    const { model } = await this.load();
    const scene = model.scenes.get(sceneId);
    if (!scene) return { ok: false, error: `No scene "${sceneId}".` };
    const loaded = await readShots(this.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
    if (!loaded) {
      return {
        ok: false,
        error: `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
      };
    }
    const wardrobes = wardrobesOf(model.characters);
    return setShotOutfit(loaded.shots, scene, wardrobes, { shot: shotId, character, outfit });
  }

  /**
   * The discovered sheet for a character, or null when no file claims that id. Comes off a load
   * rather than a path built from the id — same contract as {@link sceneEditInput}: an editor
   * patches the file the doc it decided against was read from.
   */
  async characterDoc(id: string): Promise<EntityDoc | null> {
    const { inputs } = await this.load();
    return inputs.characterDocs.find((d) => d.id === id) ?? null;
  }

  /** The discovered sheet for a location; see {@link characterDoc}. */
  async locationDoc(id: string): Promise<EntityDoc | null> {
    const { inputs } = await this.load();
    return inputs.locationDocs.find((d) => d.id === id) ?? null;
  }
}

/**
 * What the author had open, as the one sentence a turn's `context` message carries.
 *
 * Resolved against the index rather than passed through, so a scene id nothing knows about — a
 * stale selection, a scene deleted since — says **nothing** instead of asserting a scene that is
 * not there. A host with no selection and a host with a bad one therefore look the same, which is
 * the honest answer in both cases.
 */
export function focusOnScene(index: WorkspaceIndex, sceneId: string): string | undefined {
  const scene = index.scenes.find((s) => s.id === sceneId);
  if (!scene) return undefined;
  const cast = scene.characters.length ? `cast ${scene.characters.join(', ')}` : 'no cast';
  const file = scene.file ? ` in ${relative(index.root, scene.file).split(sep).join('/')}` : '';
  return (
    `The author is looking at scene "${scene.id}" (location ${scene.location}; ${cast})${file}. ` +
    'Read it before answering anything about "this scene", "here", or "the current scene" — those ' +
    'mean that one unless they name another.'
  );
}

/**
 * Render an index as a compact human/agent-readable summary.
 *
 * Every row that has a sheet **names it**. Without that, authoring `locations/rooftop.md` for a
 * place the screenplay already mentions changed nothing on screen — `mergeMinedLocations` keys on
 * the same slug, so the row was converted rather than added, and the only visible difference was
 * a dropped `(mined)`. To a model re-reading its own transcript that is indistinguishable from the
 * tool not having noticed the write. The file is the proof that it did.
 */
export function formatIndex(index: WorkspaceIndex): string {
  const at = (file: string | undefined): string =>
    file ? ` — ${relative(index.root, file).split(sep).join('/')}` : '';
  const lines = [`# ${index.title}`, ''];
  lines.push(`Characters (${index.characters.length}):`);
  for (const c of index.characters)
    lines.push(`  - ${c.id} "${c.name}" [${c.status}]${at(c.file)}`);
  lines.push(`Locations (${index.locations.length}):`);
  for (const l of index.locations)
    lines.push(
      `  - ${l.id} "${l.name}"${l.file ? at(l.file) : ' (mined from the screenplay — no sheet yet)'}`,
    );
  lines.push(`Scenes (${index.scenes.length}):`);
  for (const s of index.scenes) {
    const flags = [s.reachable ? '' : 'unreachable', s.choices ? `${s.choices} choices` : '']
      .filter(Boolean)
      .join(', ');
    lines.push(`  - ${s.id} @${s.location}${flags ? ` (${flags})` : ''}${at(s.file)}`);
  }
  if (index.bibleFiles > 0)
    lines.push(
      '',
      `Story bible: ${index.bibleFiles} file(s) under wiki/ — search it with search_bible.`,
    );
  const errs = index.diagnostics.filter((d) => d.severity === 'error').length;
  const warns = index.diagnostics.filter((d) => d.severity === 'warning').length;
  lines.push('', `Diagnostics: ${errs} error(s), ${warns} warning(s)`);
  return lines.join('\n');
}

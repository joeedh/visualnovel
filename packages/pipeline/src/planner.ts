import type {
  AnyTask,
  AssetRef,
  BaseAssets,
  Character,
  ImageParams,
  Logger,
  ProjectModel,
  Scene,
  Shot,
  TaskGraph,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { Providers } from '@vn/types';
import { outfitFor } from '@vn/model';
import { type ProjectPaths, readShots, writeShots } from '@vn/store';
import { makeTask } from '@vn/taskgraph';
import { baseRefusal } from '@vn/artgen';
import {
  buildLocationPrompt,
  buildModelSheetPrompt,
  buildPortraitPrompt,
  buildShotPrompt,
  imageParams,
} from './prompts.js';
import { decomposeScene } from './p5.js';
import { proseHash } from './drift.js';
import { isApproved, sceneUnblocked } from './gate.js';

/** Model-sheet angles generated per outfit once a character is approved (report §P4). */
export const MODEL_SHEET_ANGLES = ['front', 'side', 'back'] as const;

/** The angle a shot references. One, not three: a frame needs the clothes, not a turnaround. */
const SHEET_FRONT = MODEL_SHEET_ANGLES[0];

const PNG = 'png';

/** Characters that appear in at least one reachable scene (everyone else is dead weight). */
function usedCharacters(model: ProjectModel): Character[] {
  const ids = new Set<string>();
  for (const scene of model.scenes.values()) {
    if (!model.reachable.has(scene.id)) continue;
    for (const id of scene.characters) ids.add(id);
  }
  return [...ids].map((id) => model.characters.get(id)).filter((c): c is Character => !!c);
}

/** Reachable scenes only — never spend generation on unreachable branches. */
function reachableScenes(model: ProjectModel): Scene[] {
  return [...model.scenes.values()].filter((s) => model.reachable.has(s.id));
}

/**
 * The outfits a run actually needs, character id → outfit ids in the order they were found: the
 * character's default first (anything with no opinion inherits it), then every `[[outfit:]]` marker
 * and shot override over reachable scenes. Authoring a wardrobe therefore costs nothing until
 * something puts a character in it — a sheet is three image calls per outfit.
 *
 * The set is exactly the range of {@link outfitFor} over this model, an id it does not author
 * included: `outfitText` falls back to the id for the sheet prompt just as it does for the shot's,
 * so a shot can never depend on a sheet nothing planned.
 */
function usedOutfits(model: ProjectModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (characterId: string, outfit: string | undefined): void => {
    const set = out.get(characterId) ?? new Set<string>();
    if (!out.has(characterId)) {
      // The default goes in first whoever asks, so a wardrobe-less project plans what it always did.
      const fallback = model.characters.get(characterId)?.defaultOutfit;
      if (fallback) set.add(fallback);
      out.set(characterId, set);
    }
    if (outfit) set.add(outfit);
  };

  for (const scene of reachableScenes(model)) {
    const marks = scene.outfits ?? {};
    // The cast, plus anyone a marker names who is not in it — a marker for someone the scene
    // forgot to list is still an outfit something asked for.
    for (const id of new Set([...scene.characters, ...Object.keys(marks)])) add(id, marks[id]);
    // Shots exist only once a scene has been decomposed, so an override reaches this on a later
    // wave than the marker does — which is what incremental planning is for.
    for (const shot of scene.shots) {
      for (const subject of shot.subjects) add(subject.characterId, subject.outfit);
    }
  }
  return out;
}

/**
 * One model-sheet task. Built in two places — P4 fans them out, and a shot in a non-default outfit
 * names one as a ref — so the identity is written down once or the shot would depend on a hash
 * nothing planned.
 */
function modelSheetTask(
  character: Character,
  outfit: string,
  angle: string,
  portrait: AssetRef,
  config: ProjectConfig,
  params: ImageParams,
): AnyTask {
  return makeTask('model_sheet', {
    characterId: character.id,
    outfit,
    angle,
    prompt: buildModelSheetPrompt(character, outfit, angle, config),
    refs: [portrait],
    params,
  });
}

/** Locations referenced by a reachable scene, paired with the variants those scenes use. */
function usedLocationVariants(model: ProjectModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const scene of reachableScenes(model)) {
    const location = model.locations.get(scene.location);
    if (!location) continue;
    const set = out.get(location.id) ?? new Set<string>();
    // Generate every declared variant for a used location so shots can pick any.
    for (const v of location.variants.length ? location.variants : [{ id: 'day' }]) set.add(v.id);
    out.set(location.id, set);
  }
  return out;
}

/**
 * A scene's shots: the persisted decomposition when one exists, otherwise a fresh one written
 * out immediately. Re-decomposing is never done over an existing file — the LLM path is
 * non-deterministic, so it would change shot ids, hence task identities, hence regenerate art.
 */
async function shotsFor(
  scene: Scene,
  model: ProjectModel,
  providers: Providers,
  paths?: ProjectPaths,
  logger?: Logger,
  readOnly = false,
): Promise<Shot[]> {
  if (paths) {
    const known = new Set(scene.lines.map((l) => l.id));
    const loaded = await readShots(paths, scene.id, known);
    if (loaded) {
      for (const d of loaded.dropped) {
        logger?.warn('shot covers lines the screenplay no longer has; dropped', {
          scene: scene.id,
          shot: d.shotId,
          lines: d.lineIds,
        });
      }
      return loaded.shots;
    }
  }
  const shots = await decomposeScene(scene, model, providers);
  if (paths && !readOnly) await writeShots(paths, scene.id, shots);
  return shots;
}

/**
 * Copy what the run produced onto the in-memory shot. The task graph is the authority, so a
 * shots file restored from an old commit cannot convince anything that work is done — the
 * stale values it loaded are overwritten here.
 *
 * `proseHash` is the exception, and deliberately: it is stamped only when *these* bytes are new.
 * A rerun reporting the same image must not re-baseline the prose under it, or a drift the author
 * has not acted on would be silently cleared by a run that did no work.
 */
function refreshShotData(shot: Shot, task: AnyTask, scene: Scene): void {
  const before = shot.image;
  const stamp = (): void => {
    if (shot.image !== undefined && shot.image !== before) {
      shot.proseHash = proseHash(scene, shot.coversLines);
    }
  };
  if (task.status === 'done' && task.output) {
    shot.status = 'accepted';
    shot.image = task.output;
    stamp();
    return;
  }
  if (task.status === 'needs_human') {
    shot.status = 'needs_human';
    const last = task.attempts[task.attempts.length - 1]?.output;
    if (last) shot.image = last;
    stamp();
    return;
  }
  shot.status = 'prompted';
  delete shot.image;
  // No image, so nothing the hash could describe; `serialize` would drop it anyway.
  delete shot.proseHash;
}

/**
 * Why planning is refused, or `undefined` to plan normally.
 *
 * An `unavailable` base root — the directory is there, its manifest is not — is the shape a
 * clone without the base repo leaves behind, and the whole plan rests on it: the four base kinds
 * would be re-generated from scratch, and every shot references a location plate and a portrait
 * whose bytes are equally gone. So nothing is plannable, and saying that in one sentence is the
 * point of the state existing at all. The sentence lives in `@vn/artgen` because generating one
 * image on demand must refuse in exactly the same words.
 */
export { baseRefusal } from '@vn/artgen';

/** Find an already-produced asset for a task identity, if it ran and succeeded. */
function doneOutput(graph: TaskGraph, hash: string): AssetRef | undefined {
  const task = graph.get(hash);
  if (task?.status === 'done' && task.output) return { hash: task.output, ext: PNG };
  return undefined;
}

/**
 * Emit/dedupe the tasks that are *currently runnable* given the model's approval state
 * (report §5, §7, §P3 gate-as-barrier). This is intentionally incremental: it is called
 * once per scheduler wave so that tasks whose identity depends on an upstream output
 * (shot images reference the produced location plate) only appear after that upstream task
 * is `done`, and shot tasks for a scene only appear once every character in it is approved.
 *
 * Returns the tasks added or refreshed this pass. Decomposes scenes lazily (mutating
 * `model`) the first time a scene clears the gate.
 *
 * With `paths`, decompositions are persisted under `work/shots/` and preferred over
 * re-decomposing; without it planning is pure, which is what the unit tests want.
 *
 * An `unavailable` base root plans **nothing** — see {@link baseRefusal}.
 */
export async function planTasks(opts: {
  model: ProjectModel;
  graph: TaskGraph;
  config: ProjectConfig;
  providers: Providers;
  /** Enables shot persistence. Omit to plan without touching disk. */
  paths?: ProjectPaths;
  logger?: Logger;
  /** The store's base root, when the caller has one. Absent means "no opinion" — plan normally. */
  base?: BaseAssets;
  /**
   * Read persisted shots but never write. A dry run plans with mock providers, and a mock
   * decomposition must not be left behind for a later real run to reuse.
   */
  readOnlyShots?: boolean;
}): Promise<AnyTask[]> {
  const { model, graph, config, providers, paths, logger, base, readOnlyShots } = opts;
  const refusal = baseRefusal(base);
  if (refusal) {
    logger?.error('plan.refused', { reason: refusal, root: base?.root });
    return [];
  }
  const params = imageParams(config);
  const planned: AnyTask[] = [];

  // P2: location reference plates — no upstream deps, always plannable.
  for (const [locationId, variants] of usedLocationVariants(model)) {
    const location = model.locations.get(locationId);
    if (!location) continue;
    for (const variant of variants) {
      const prompt = buildLocationPrompt(location, variant, config);
      const task = makeTask('location_ref', { locationId, variant, prompt, refs: [], params });
      planned.push(graph.add(task));
    }
  }

  const wardrobe = usedOutfits(model);

  // P3: one portrait task per used character (the human-approval gate sits on its output).
  for (const character of usedCharacters(model)) {
    const prompt = buildPortraitPrompt(character, config);
    const task = makeTask('portrait', { characterId: character.id, prompt, refs: [], params });
    planned.push(graph.add(task));

    // P4: model sheets derive from the *approved* portrait, so only after the gate — and only for
    // the outfits something puts this character in, not for every one the sheet authors.
    if (isApproved(character) && character.approvedPortrait) {
      const portraitRef: AssetRef = { hash: character.approvedPortrait, ext: PNG };
      for (const outfit of wardrobe.get(character.id) ?? [character.defaultOutfit]) {
        for (const angle of MODEL_SHEET_ANGLES) {
          planned.push(
            graph.add(modelSheetTask(character, outfit, angle, portraitRef, config, params)),
          );
        }
      }
    }
  }

  // P5–P7: shots, but only for scenes that have fully cleared the character gate.
  for (const scene of reachableScenes(model)) {
    if (!sceneUnblocked(model, scene.id)) continue;
    if (scene.shots.length === 0)
      scene.shots = await shotsFor(scene, model, providers, paths, logger, readOnlyShots);

    for (const shot of scene.shots) {
      // A shot can only be hashed once its location plate exists (its hash is a ref).
      const locTaskHash = makeTask('location_ref', {
        locationId: scene.location,
        variant: shot.location,
        prompt: buildLocationPrompt(model.locations.get(scene.location)!, shot.location, config),
        refs: [],
        params,
      }).hash;
      const locAsset = doneOutput(graph, locTaskHash);
      if (!locAsset) continue;

      // Each subject contributes its approved portrait as an identity reference — and, when it is
      // not in the character's default, that outfit's front sheet, so the clothes are something to
      // copy rather than words to interpret. The portrait alone shows the default.
      const subjectRefs: AssetRef[] = [];
      const sheetDeps: string[] = [];
      let missingRef = false;
      for (const subject of shot.subjects) {
        const character = model.characters.get(subject.characterId);
        if (!character?.approvedPortrait) {
          missingRef = true;
          break;
        }
        const portraitRef: AssetRef = { hash: character.approvedPortrait, ext: PNG };
        subjectRefs.push(portraitRef);

        const outfit = outfitFor(subject, scene, character);
        if (outfit.id === character.defaultOutfit) continue;
        const sheet = modelSheetTask(
          character,
          outfit.id,
          SHEET_FRONT,
          portraitRef,
          config,
          params,
        );
        const sheetAsset = doneOutput(graph, sheet.hash);
        if (!sheetAsset) {
          missingRef = true;
          break;
        }
        subjectRefs.push(sheetAsset);
        sheetDeps.push(sheet.hash);
      }
      if (missingRef) continue;

      const prompt = buildShotPrompt(shot, scene, model, config);
      shot.prompt = prompt;
      const task = makeTask(
        'shot_image',
        { shotId: shot.id, prompt, refs: [locAsset, ...subjectRefs], params },
        [locTaskHash, ...sheetDeps],
      );
      const node = graph.add(task);
      planned.push(node);
      refreshShotData(shot, node, scene);
    }

    // Once per pass, including the final one the scheduler runs after the last wave — which
    // is what gets a completed run's outputs into the file.
    if (paths && !readOnlyShots) await writeShots(paths, scene.id, scene.shots);
  }

  return planned;
}

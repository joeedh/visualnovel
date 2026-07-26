import type {
  AnyTask,
  AssetRef,
  Character,
  Logger,
  ProjectModel,
  Scene,
  Shot,
  TaskGraph,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { Providers } from '@vn/types';
import { type ProjectPaths, readShots, writeShots } from '@vn/store';
import { makeTask } from '@vn/taskgraph';
import {
  buildLocationPrompt,
  buildModelSheetPrompt,
  buildPortraitPrompt,
  buildShotPrompt,
  imageParams,
} from './prompts.js';
import { decomposeScene } from './p5.js';
import { isApproved, sceneUnblocked } from './gate.js';

/** Model-sheet angles generated per outfit once a character is approved (report §P4). */
export const MODEL_SHEET_ANGLES = ['front', 'side', 'back'] as const;

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
 */
function refreshShotData(shot: Shot, task: AnyTask): void {
  if (task.status === 'done' && task.output) {
    shot.status = 'accepted';
    shot.image = task.output;
    return;
  }
  if (task.status === 'needs_human') {
    shot.status = 'needs_human';
    const last = task.attempts[task.attempts.length - 1]?.output;
    if (last) shot.image = last;
    return;
  }
  shot.status = 'prompted';
  delete shot.image;
}

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
 */
export async function planTasks(opts: {
  model: ProjectModel;
  graph: TaskGraph;
  config: ProjectConfig;
  providers: Providers;
  /** Enables shot persistence. Omit to plan without touching disk. */
  paths?: ProjectPaths;
  logger?: Logger;
  /**
   * Read persisted shots but never write. A dry run plans with mock providers, and a mock
   * decomposition must not be left behind for a later real run to reuse.
   */
  readOnlyShots?: boolean;
}): Promise<AnyTask[]> {
  const { model, graph, config, providers, paths, logger, readOnlyShots } = opts;
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

  // P3: one portrait task per used character (the human-approval gate sits on its output).
  for (const character of usedCharacters(model)) {
    const prompt = buildPortraitPrompt(character, config);
    const task = makeTask('portrait', { characterId: character.id, prompt, refs: [], params });
    planned.push(graph.add(task));

    // P4: model sheets derive from the *approved* portrait, so only after the gate.
    if (isApproved(character) && character.approvedPortrait) {
      const portraitRef: AssetRef = { hash: character.approvedPortrait, ext: PNG };
      for (const outfit of character.outfits) {
        for (const angle of MODEL_SHEET_ANGLES) {
          const sheetPrompt = buildModelSheetPrompt(character, outfit.id, angle, config);
          const sheet = makeTask('model_sheet', {
            characterId: character.id,
            outfit: outfit.id,
            angle,
            prompt: sheetPrompt,
            refs: [portraitRef],
            params,
          });
          planned.push(graph.add(sheet));
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

      // Each subject contributes its approved portrait as an identity reference.
      const subjectRefs: AssetRef[] = [];
      let missingSubject = false;
      for (const subject of shot.subjects) {
        const character = model.characters.get(subject.characterId);
        if (!character?.approvedPortrait) {
          missingSubject = true;
          break;
        }
        subjectRefs.push({ hash: character.approvedPortrait, ext: PNG });
      }
      if (missingSubject) continue;

      const prompt = buildShotPrompt(shot, scene, model, config);
      shot.prompt = prompt;
      const task = makeTask(
        'shot_image',
        { shotId: shot.id, prompt, refs: [locAsset, ...subjectRefs], params },
        [locTaskHash],
      );
      const node = graph.add(task);
      planned.push(node);
      refreshShotData(shot, node);
    }

    // Once per pass, including the final one the scheduler runs after the last wave — which
    // is what gets a completed run's outputs into the file.
    if (paths && !readOnlyShots) await writeShots(paths, scene.id, scene.shots);
  }

  return planned;
}

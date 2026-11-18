/**
 * A frozen copy of `planTasks` as it stood before the constraint solver, kept as the oracle the
 * solver's planner is compared against (`docs/plans/contracts-into-code-and-workflows.md`, stage
 * 1). The gate and sheet-key helpers it calls are copied too, because later stages rewrite those
 * as readers of solver state, and an oracle calling them would end up comparing the solver with
 * itself. Prompt composition stays live; the pinned hashes in `oracle.test.ts` guard it.
 *
 * Test-only, and deleted at the end of stage 6. Nothing here may change behaviour: a difference
 * from the live planner is what the oracle exists to report.
 */
import type {
  AnyTask,
  Asset,
  AssetRef,
  BaseAssets,
  Character,
  ImageParams,
  Logger,
  PagePanel,
  PanelBox,
  ProjectModel,
  Scene,
  Shot,
  TaskGraph,
} from '@vn/types';
import { bindsTo, defectReportSchema } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { Providers } from '@vn/types';
import {
  outfitFor,
  reachableScenes,
  allCharacters,
  allLocationVariants,
  usedOutfits,
} from '@vn/model';
import { type ProjectPaths, readShots, writeShots } from '@vn/store';
import { makeTask } from '@vn/taskgraph';
import {
  baseRefusal,
  cycleRefusal,
  firstCycle,
  layoutDefect,
  sheetGroups,
  sheetKey,
  sheetSeeds,
} from '@vn/artgen';
import { VnError } from '@vn/util';
import { checkRequest } from '@vn/providers';
import {
  imageParams,
  locationTask,
  modelSheetInputs,
  portraitInputs,
  shotInputs,
  MODEL_SHEET_ANGLES,
  SHEET_FRONT,
} from '../prompts.js';
import { decomposeScene, storyboardStyle, type StoryboardStyle } from '../p5.js';
import { proseHash } from '../drift.js';

const PNG = 'png';

// ─── The gate, copied from `packages/artgen/src/gate.ts` ────────────────────

/** The hash the sheet's mirror names, when its status says it is approved. */
function mirrored(character: Character): string | undefined {
  return (character.status === 'approved' || character.status === 'locked') &&
    character.approvedPortrait
    ? character.approvedPortrait
    : undefined;
}

/** The portrait a character's look is approved with, or `undefined` while the gate is closed. */
function approvedPortraitOf(character: Character, assets?: readonly Asset[]): string | undefined {
  if (assets === undefined || character.status === 'locked') return mirrored(character);
  const row = assets.find(
    (a) =>
      a.kind === 'portrait' &&
      a.current === true &&
      a.accepted &&
      bindsTo(a, { characterId: character.id }),
  );
  return row?.hash;
}

function isApproved(character: Character, assets?: readonly Asset[]): boolean {
  return approvedPortraitOf(character, assets) !== undefined;
}

/** A scene can have its shots generated only once every character in it is approved. */
function sceneUnblocked(model: ProjectModel, sceneId: string, assets?: readonly Asset[]): boolean {
  const scene = model.scenes.get(sceneId);
  if (!scene) return false;
  return scene.characters.every((id) => {
    const character = model.characters.get(id);
    return character ? isApproved(character, assets) : false;
  });
}

// ─── Sheet keys, copied from `packages/artgen/src/sheet.ts` ─────────────────

/** The key each of the scene's staging-sheet groups puts into its members' params. */
function sheetKeys(
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
  assets: readonly Asset[],
): Map<string, string> {
  const keys = new Map<string, string>();
  for (const group of sheetGroups(scene)) {
    const seeds = sheetSeeds(scene, group, model, config, assets);
    if (seeds) keys.set(group, sheetKey(seeds));
  }
  return keys;
}

// ─── The planner, copied from `packages/pipeline/src/planner.ts` ────────────

function modelSheetTask(
  character: Character,
  outfit: string,
  angle: string,
  portrait: AssetRef,
  config: ProjectConfig,
  params: ImageParams,
): AnyTask {
  return makeTask(
    'model_sheet',
    modelSheetInputs(character, outfit, angle, portrait, config, params),
  );
}

type Storyboard = Pick<Scene, 'shots' | 'sheets'>;

async function shotsFor(
  scene: Scene,
  model: ProjectModel,
  providers: Providers,
  style: StoryboardStyle,
  paths?: ProjectPaths,
  logger?: Logger,
  readOnly = false,
): Promise<Storyboard> {
  if (paths) {
    const known = new Set(scene.lines.map((l) => l.id));
    const loaded = await readShots(paths, scene.id, known);
    if (loaded) {
      for (const d of loaded.dropped) {
        logger?.warn('shot covers lines the screenplay no longer has; dropped', {
          scene: scene.id,
          shot : d.shotId,
          lines: d.lineIds,
        });
      }
      for (const u of loaded.unpanelled) {
        logger?.warn('line_in_no_panel: a page covers lines no panel letters', {
          scene: scene.id,
          shot : u.shotId,
          lines: u.lineIds,
        });
      }
      return { shots: loaded.shots, ...(loaded.sheets ? { sheets: loaded.sheets } : {}) };
    }
  }
  const decomposition = await decomposeScene(scene, model, providers, style);
  checkRequest();
  if (decomposition.source === 'baseline') {
    logger?.warn('decomposition fell back to the deterministic storyboard', {
      scene : scene.id,
      reason: decomposition.reason,
    });
  }
  if (paths && !readOnly) {
    await writeShots(paths, scene.id, decomposition.shots, { sheets: decomposition.sheets });
  }
  return {
    shots: decomposition.shots,
    ...(decomposition.sheets ? { sheets: decomposition.sheets } : {}),
  };
}

function refreshShotData(shot: Shot, task: AnyTask, scene: Scene): void {
  const before = shot.image;
  const stamp = (): void => {
    if (shot.image === undefined || shot.image === before) return;
    shot.proseHash = proseHash(scene, shot.coversLines);
    const boxes = observedBoxes(task, shot.image, shot.panels);
    if (boxes) shot.panelBoxes = boxes;
    else delete shot.panelBoxes;
  };
  if (task.status === 'done' && task.output) {
    shot.image = task.output;
    stamp();
    return;
  }
  if (task.status === 'needs_human') {
    const last = task.attempts[task.attempts.length - 1]?.output;
    if (last) shot.image = last;
    stamp();
    return;
  }
  delete shot.image;
  delete shot.proseHash;
  delete shot.panelBoxes;
}

function observedBoxes(
  task: AnyTask,
  image: string,
  panels: readonly PagePanel[] | undefined,
): PanelBox[] | undefined {
  const attempt = task.attempts.find((a) => a.output === image);
  const measured: PanelBox[][] = [];
  for (const review of attempt?.reviews ?? []) {
    const parsed = defectReportSchema.safeParse(review);
    if (parsed.success && parsed.data.observed)
      measured.push(parsed.data.observed.panels.map((p) => p.box));
  }
  const matched = panels && measured.find((boxes) => layoutDefect(panels, boxes) === undefined);
  return matched ?? measured[0];
}

function doneOutput(graph: TaskGraph, hash: string): AssetRef | undefined {
  const task = graph.get(hash);
  if (task?.status === 'done' && task.output) return { hash: task.output, ext: PNG };
  return undefined;
}

/** `planTasks` as it stood on 2026-11-17, with its options unchanged. */
export async function oraclePlanTasks(opts: {
  model: ProjectModel;
  graph: TaskGraph;
  config: ProjectConfig;
  providers: Providers;
  paths?: ProjectPaths;
  logger?: Logger;
  base?: BaseAssets;
  readOnlyShots?: boolean;
  assets?: readonly Asset[];
}): Promise<AnyTask[]> {
  const { model, graph, config, providers, paths, logger, base, readOnlyShots } = opts;
  const assets = opts.assets ?? [];
  const refusal = baseRefusal(base);
  if (refusal) {
    logger?.error('plan.refused', { reason: refusal, root: base?.root });
    return [];
  }
  const params = imageParams(config);
  const planned: AnyTask[] = [];

  for (const [locationId, variants] of allLocationVariants(model)) {
    const location = model.locations.get(locationId);
    if (!location) continue;
    for (const variant of variants) {
      planned.push(graph.add(locationTask(location, variant, config, params)));
    }
  }

  const wardrobe = usedOutfits(model);

  for (const character of allCharacters(model)) {
    planned.push(graph.add(makeTask('portrait', portraitInputs(character, config, params))));
    const approved = approvedPortraitOf(character, opts.assets);
    if (approved !== undefined) {
      const portraitRef: AssetRef = { hash: approved, ext: PNG };
      for (const outfit of wardrobe.get(character.id) ?? []) {
        for (const angle of MODEL_SHEET_ANGLES) {
          planned.push(
            graph.add(modelSheetTask(character, outfit, angle, portraitRef, config, params)),
          );
        }
      }
    }
  }

  for (const scene of reachableScenes(model)) {
    if (!sceneUnblocked(model, scene.id, opts.assets)) continue;
    if (scene.shots.length === 0) {
      const storyboard = await shotsFor(
        scene,
        model,
        providers,
        storyboardStyle(config),
        paths,
        logger,
        readOnlyShots,
      );
      scene.shots = storyboard.shots;
      if (storyboard.sheets) scene.sheets = storyboard.sheets;
    }
    const sheets = sheetKeys(scene, model, config, assets);

    for (const shot of scene.shots) {
      const locTaskHash = locationTask(
        model.locations.get(scene.location)!,
        shot.location,
        config,
        params,
      ).hash;
      const locAsset = doneOutput(graph, locTaskHash);
      if (!locAsset) continue;

      const subjectRefs: AssetRef[] = [];
      const sheetDeps: string[] = [];
      let missingRef = false;
      for (const subject of shot.subjects) {
        const character = model.characters.get(subject.characterId);
        const approved = character ? approvedPortraitOf(character, opts.assets) : undefined;
        if (!character || approved === undefined) {
          missingRef = true;
          break;
        }
        const portraitRef: AssetRef = { hash: approved, ext: PNG };
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

      const inputs = shotInputs(
        shot,
        scene,
        model,
        config,
        params,
        [locAsset, ...subjectRefs],
        shot.sheet === undefined ? undefined : sheets.get(shot.sheet),
      );
      shot.prompt = inputs.prompt;
      const task = makeTask('shot_image', inputs, [locTaskHash, ...sheetDeps]);
      const node = graph.add(task);
      planned.push(node);
      refreshShotData(shot, node, scene);
    }

    if (paths && !readOnlyShots) await writeShots(paths, scene.id, scene.shots);
  }

  const cycle = firstCycle({
    model,
    shots: new Map([...model.scenes].map(([id, s]) => [id, s.shots])),
  });
  if (cycle) throw new VnError('REF_CYCLE', cycleRefusal(cycle));

  return planned;
}

/**
 * What an interactive run seeds a graph with, derived for the slot its target output binds, so
 * `gengraph.run` draws what the scheduled run would draw. The prompt comes from the same
 * builders the planner hashes, the references from the manifest rather than from a task graph
 * (an upstream picture not yet drawn is simply absent), and a shot in a staging-sheet group
 * seeds the sheet's prompt and references beside its own.
 */
import type { ProjectConfig } from '@vn/config';
import {
  SHEET_FRONT,
  imageParams,
  locationInputs,
  modelSheetInputs,
  parseSlot,
  portraitInputs,
  resolveBinding,
  sheetSeeds,
  shotInputs,
} from '@vn/artgen';
import { genNodeSpec } from '@vn/gengraph';
import type { Graph, GraphId } from '@vn/gengraph';
import type { GenExecuteOptions } from '@vn/gengraph/state';
import { outfitFor } from '@vn/model';
import { readShots } from '@vn/store';
import type { Asset, AssetRef, ProjectModel, RefBinding, Scene, Shot } from '@vn/types';
import type { LoadedProject } from './core.js';

export type GraphSeeds = NonNullable<GenExecuteOptions['seeds']>;

/** The slot the target binds, when the target is an output node naming one. */
function boundSlot(graph: Graph, target: GraphId): RefBinding | undefined {
  const node = graph.nodeIdMap.get(target);
  const key = node === undefined ? undefined : genNodeSpec(node.def.typeName)?.slotProp;
  if (node === undefined || key === undefined) return undefined;
  const said = node.props[key]?.getValue();
  return typeof said === 'string' ? parseSlot(said) : undefined;
}

function refOf(hash: string | undefined, assets: readonly Asset[]): AssetRef | undefined {
  if (hash === undefined) return undefined;
  const asset = assets.find((a) => a.hash === hash);
  return asset === undefined ? undefined : { hash, ext: asset.ext };
}

/**
 * The plate and the cast pictures a shot task leads its references with, as the manifest
 * resolves them now: the variant's plate, then each subject's approved portrait and, for a
 * subject out of the default outfit, that outfit's front sheet.
 */
function shotUpstream(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  assets: readonly Asset[],
): AssetRef[] {
  const ctx = { model, assets };
  const refs: AssetRef[] = [];
  const plate = refOf(
    resolveBinding({ kind: 'plate', locationId: scene.location, variant: shot.location }, ctx),
    assets,
  );
  if (plate) refs.push(plate);

  for (const subject of shot.subjects) {
    const character = model.characters.get(subject.characterId);
    const portrait = refOf(character?.approvedPortrait, assets);
    if (!character || !portrait) continue;
    refs.push(portrait);

    const outfit = outfitFor(subject, scene, character).id;
    if (outfit === character.defaultOutfit) continue;
    const sheet = refOf(
      resolveBinding({ kind: 'sheet', characterId: character.id, outfit, angle: SHEET_FRONT }, ctx),
      assets,
    );
    if (sheet) refs.push(sheet);
  }
  return refs;
}

/** The scene with its persisted storyboard on it, or undefined when it has none. */
async function storyboarded(project: LoadedProject, sceneId: string): Promise<Scene | undefined> {
  const scene = project.model.scenes.get(sceneId);
  if (scene === undefined) return undefined;
  const loaded = await readShots(project.paths, sceneId, new Set(scene.lines.map((l) => l.id)));
  if (!loaded) return undefined;
  return { ...scene, shots: loaded.shots, ...(loaded.sheets ? { sheets: loaded.sheets } : {}) };
}

function seedsOf(
  prompt: string,
  refs: readonly AssetRef[],
  sheet?: { prompt: string; refs: readonly AssetRef[] },
): GraphSeeds {
  return {
    GenDerivedPrompt: { prompt },
    GenTaskRefs     : { assets: JSON.stringify(refs) },
    ...(sheet === undefined
      ? {}
      : {
          GenSheetPrompt: { prompt: sheet.prompt },
          GenSheetRefs  : { assets: JSON.stringify(sheet.refs) },
        }),
  };
}

/**
 * The seeds for a run to `target`. A target that is no output, or one whose slot the project
 * no longer describes, seeds nothing, and the graph's seeded nodes run on their empty
 * defaults, as they did before any host seeded them.
 */
export async function graphSeeds(
  project: LoadedProject,
  graph: Graph,
  target: GraphId,
): Promise<GraphSeeds> {
  const binding = boundSlot(graph, target);
  if (binding === undefined) return {};

  const { model, config } = project;
  const params = imageParams(config);
  switch (binding.kind) {
    case 'portrait': {
      const character = model.characters.get(binding.characterId);
      if (!character) return {};
      const inputs = portraitInputs(character, config, params);
      return seedsOf(inputs.prompt, inputs.refs);
    }
    case 'plate': {
      const location = model.locations.get(binding.locationId);
      if (!location) return {};
      const inputs = locationInputs(location, binding.variant, config, params);
      return seedsOf(inputs.prompt, inputs.refs);
    }
    case 'sheet': {
      const character = model.characters.get(binding.characterId);
      const portrait = refOf(character?.approvedPortrait, project.store.manifest());
      if (!character || !portrait) return {};
      const inputs = modelSheetInputs(
        character,
        binding.outfit,
        binding.angle,
        portrait,
        config,
        params,
      );
      return seedsOf(inputs.prompt, inputs.refs);
    }
    case 'shot':
      return shotSeeds(project, binding.sceneId, binding.shotId, config, params);
    // A pinned asset is a picture rather than a slot the pipeline derives a prompt for
    case 'asset':
      return {};
  }
}

async function shotSeeds(
  project: LoadedProject,
  sceneId: string,
  shotId: string,
  config: ProjectConfig,
  params: ReturnType<typeof imageParams>,
): Promise<GraphSeeds> {
  const scene = await storyboarded(project, sceneId);
  const shot = scene?.shots.find((s) => s.id === shotId);
  if (!scene || !shot) return {};

  const { model } = project;
  const assets = project.store.manifest();
  const sheet =
    shot.sheet === undefined ? undefined : sheetSeeds(scene, shot.sheet, model, config, assets);
  const inputs = shotInputs(
    shot,
    scene,
    model,
    config,
    params,
    shotUpstream(shot, scene, model, assets),
  );
  return seedsOf(inputs.prompt, inputs.refs, sheet);
}

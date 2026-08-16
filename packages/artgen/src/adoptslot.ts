/**
 * Adopting bytes as a slot's output — "this picture *is* the café's night plate", not "point at
 * this picture" (`docs/plans/adopting-an-uploaded-asset.md`).
 *
 * The generalization of `promoteConcept`, which was this act with one slot kind hard-coded. A slot
 * is a `RefBinding`, the address the reference graph, the cycle refusal and `prompt.addRef` already
 * speak, so nothing here invents a second way to say which picture.
 *
 * `adopt`'s safety property is not weakened: the task's inputs are derived here from the project as
 * it stands and handed over as inputs, never as a remembered hash, so an adoption cannot mark done
 * a task the project no longer describes.
 */
import type {
  Asset,
  AssetBinding,
  AssetRef,
  ImageParams,
  ProjectModel,
  RefBinding,
  Scene,
  Shot,
  TaskGraph,
  TaskInputs,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { modelFromInputs, outfitFor } from '@vn/model';
import { loadInputs, readShots, writeShots, type AssetStore, type ProjectPaths } from '@vn/store';
import { loadGraph, makeTask } from '@vn/taskgraph';
import { isPlaceholderImage } from '@vn/providers';
import { VnError } from '@vn/util';
import {
  imageParams,
  locationInputs,
  modelSheetInputs,
  shotInputs,
  MODEL_SHEET_ANGLES,
  SHEET_FRONT,
} from './prompts.js';
import { proseHash } from './drift.js';
import { adopt } from './adopt.js';
import { baseRefusal } from './base.js';
import { slotLabel } from './refcycle.js';

export interface AdoptSlotDeps {
  config: ProjectConfig;
  paths: ProjectPaths;
  store: AssetStore;
}

export interface AdoptSlotRequest {
  /** The asset whose bytes become the slot's output. Already in the store. */
  hash: string;
  /** Which picture in the project this is — `plate:cafe/night`, as `parseSlot` reads it. */
  slot: RefBinding;
  /** Supersede the render already holding this slot. See `AdoptRequest.replace`. */
  replace?: boolean;
  /**
   * The bytes, for a decision made before they are filed — an upload that names a slot has to hear
   * the refusal at the picker rather than after the copy. Ignored once the store holds the hash,
   * and never used by {@link adoptSlot}, which adopts what is in the store.
   */
  bytes?: Uint8Array;
}

/** The three slots a picture can be adopted onto. A portrait is the gate's, and an asset is itself. */
type SlotKind = 'location_ref' | 'model_sheet' | 'shot_image';

/** What an adoption would do, once the model, the manifest and the graph have been asked. */
export interface AdoptSlotPlan {
  kind: SlotKind;
  /** The planner's own identity for this slot, computed from the project as it stands. */
  taskHash: string;
  /** `slotLabel(slot)` — ids, because this names a picture's place rather than the art. */
  label: string;
  /** The asset currently recorded as this slot's output, when a render already holds it. */
  supersedes?: string;
  /** The sentence a surface shows before committing to it. */
  note: string;
}

export type Decided<T> = { ok: false; code: string; reason: string } | { ok: true; plan: T };

export interface AdoptSlotResult {
  ref: AssetRef;
  plan: AdoptSlotPlan;
}

/**
 * A slot resolved against the project: the task it names, and — for a shot — the file whose frame
 * has to be stamped, since `serialize` drops `proseHash` unless the image is written with it.
 */
type Resolved =
  | { kind: 'location_ref'; inputs: TaskInputs['location_ref'] }
  | { kind: 'model_sheet'; inputs: TaskInputs['model_sheet'] }
  | {
      kind: 'shot_image';
      inputs: TaskInputs['shot_image'];
      stamp: { scene: Scene; shot: Shot; shots: Shot[] };
    };

/** The manifest binding a slot writes. The angle is not one: it lives in the task's inputs (§8). */
function bindingOf(slot: RefBinding): AssetBinding {
  switch (slot.kind) {
    case 'sheet':
      return { characterId: slot.characterId, outfit: slot.outfit };
    case 'plate':
      return { locationId: slot.locationId, variant: slot.variant };
    case 'shot':
      return { sceneId: slot.sceneId, shotId: slot.shotId };
    default:
      return {};
  }
}

/** The task identity a resolved slot has. Switched rather than generic: the pair has to correlate. */
function taskHashOf(r: Resolved): string {
  switch (r.kind) {
    case 'location_ref':
      return makeTask('location_ref', r.inputs).hash;
    case 'model_sheet':
      return makeTask('model_sheet', r.inputs).hash;
    case 'shot_image':
      return makeTask('shot_image', r.inputs).hash;
  }
}

/** The upstream art a shot's identity is built on, in the order the planner puts it in. */
function shotUpstream(
  model: ProjectModel,
  scene: Scene,
  shot: Shot,
  config: ProjectConfig,
  params: ImageParams,
  graph: TaskGraph,
): Decided<AssetRef[]> {
  const missing = (what: string): Decided<AssetRef[]> => ({
    ok: false,
    code: 'UPSTREAM_MISSING',
    reason: `${what} has not been rendered, and a frame's identity is built on it — run the pipeline far enough to produce it, then adopt.`,
  });
  const output = (hash: string): AssetRef | undefined => {
    const task = graph.get(hash);
    return task?.status === 'done' && task.output ? { hash: task.output, ext: 'png' } : undefined;
  };

  const location = model.locations.get(scene.location);
  if (!location) {
    return {
      ok: false,
      code: 'NO_SUCH_SLOT',
      reason: `Scene ${scene.id} is set in "${scene.location}", which is not a location this project has.`,
    };
  }
  const plate = output(
    makeTask('location_ref', locationInputs(location, shot.location, config, params)).hash,
  );
  if (!plate) return missing(`The "${shot.location}" plate for ${location.id}`);

  const refs: AssetRef[] = [plate];
  for (const subject of shot.subjects) {
    const character = model.characters.get(subject.characterId);
    if (!character?.approvedPortrait) return missing(`${subject.characterId}'s portrait`);
    const portrait: AssetRef = { hash: character.approvedPortrait, ext: 'png' };
    refs.push(portrait);

    const outfit = outfitFor(subject, scene, character);
    if (outfit.id === character.defaultOutfit) continue;
    const sheet = output(
      makeTask(
        'model_sheet',
        modelSheetInputs(character, outfit.id, SHEET_FRONT, portrait, config, params),
      ).hash,
    );
    if (!sheet) return missing(`${character.id}'s "${outfit.id}" sheet`);
    refs.push(sheet);
  }
  return { ok: true, plan: refs };
}

/** A slot against the project as loaded: which task it is, and what that task's inputs are. */
async function resolve(
  deps: AdoptSlotDeps,
  slot: RefBinding,
  graph: TaskGraph,
): Promise<Decided<Resolved>> {
  const params = imageParams(deps.config);
  const inputs = await loadInputs(deps.paths);
  const model = modelFromInputs(inputs, {
    title: deps.config.title,
    ...(deps.config.start ? { start: deps.config.start } : {}),
  });
  const gone = (what: string): Decided<Resolved> => ({
    ok: false,
    code: 'NO_SUCH_SLOT',
    reason: `${what} — nothing in this project plans that picture.`,
  });

  switch (slot.kind) {
    case 'plate': {
      const location = model.locations.get(slot.locationId);
      if (!location) return gone(`There is no location "${slot.locationId}"`);
      if (!location.variants.some((v) => v.id === slot.variant))
        return gone(`${location.id} has no "${slot.variant}" variant`);
      return {
        ok: true,
        plan: {
          kind: 'location_ref',
          inputs: locationInputs(location, slot.variant, deps.config, params),
        },
      };
    }
    case 'sheet': {
      const character = model.characters.get(slot.characterId);
      if (!character) return gone(`There is no character "${slot.characterId}"`);
      if (!character.approvedPortrait) {
        return {
          ok: false,
          code: 'NOT_APPROVED',
          reason: `${character.id}'s look has not been approved, and a sheet is drawn from the approved portrait — approve one with gate.approve first.`,
        };
      }
      if (!character.outfits.some((o) => o.id === slot.outfit))
        return gone(`${character.id} has no "${slot.outfit}" outfit`);
      if (!(MODEL_SHEET_ANGLES as readonly string[]).includes(slot.angle))
        return gone(`"${slot.angle}" is not one of the ${MODEL_SHEET_ANGLES.join(', ')} angles`);
      return {
        ok: true,
        plan: {
          kind: 'model_sheet',
          inputs: modelSheetInputs(
            character,
            slot.outfit,
            slot.angle,
            { hash: character.approvedPortrait, ext: 'png' },
            deps.config,
            params,
          ),
        },
      };
    }
    case 'shot': {
      const scene = model.scenes.get(slot.sceneId);
      if (!scene) return gone(`There is no scene "${slot.sceneId}"`);
      const loaded = await readShots(
        deps.paths,
        slot.sceneId,
        new Set(scene.lines.map((l) => l.id)),
      );
      const shot = loaded?.shots.find((s) => s.id === slot.shotId);
      if (!loaded || !shot) return gone(`Scene ${scene.id} has no shot "${slot.shotId}"`);
      const upstream = shotUpstream(model, scene, shot, deps.config, params, graph);
      if (!upstream.ok) return upstream;
      return {
        ok: true,
        plan: {
          kind: 'shot_image',
          inputs: shotInputs(shot, scene, model, deps.config, params, upstream.plan),
          stamp: { scene, shot, shots: loaded.shots },
        },
      };
    }
    // The two the vocabulary can spell and adoption will not do, each refused by what it is.
    case 'portrait':
      return {
        ok: false,
        code: 'GATED_SLOT',
        reason: `A portrait is not adopted: approving one writes ${slot.characterId}'s sheet and releases every scene they are in. Use gate.approve.`,
      };
    case 'asset':
      return {
        ok: false,
        code: 'NOT_A_SLOT',
        reason:
          'An upload and a concept are their own identity — there is no task under them to be the output of.',
      };
  }
}

/**
 * Every refusal an adoption can give, and the record it would write. Asked again by
 * {@link adoptSlot} rather than trusted, so a check that has gone stale cannot let one through.
 *
 * Async where `promotionOf` and `uploadOf` are not: a slot is resolved against the model, the shots
 * on disk and the graph, and none of those can be answered from the manifest alone.
 */
export async function adoptionForSlot(
  deps: AdoptSlotDeps,
  req: AdoptSlotRequest,
): Promise<Decided<AdoptSlotPlan>> {
  const refusal = baseRefusal(deps.store.base);
  if (refusal) return { ok: false, code: 'BASE_UNAVAILABLE', reason: refusal };

  const short = req.hash.slice(0, 8);
  const asset = deps.store.manifest().find((a) => a.hash === req.hash);
  const bytes = asset ? await deps.store.read({ hash: asset.hash, ext: asset.ext }) : req.bytes;
  if (!bytes)
    return { ok: false, code: 'UNKNOWN_ASSET', reason: `No asset "${req.hash}" in the store.` };
  if (isPlaceholderImage(bytes)) {
    return {
      ok: false,
      code: 'MOCK_PLACEHOLDER',
      reason: `Asset ${short} is a placeholder from a mock run, and mock art never becomes real output.`,
    };
  }

  const graph = await loadGraph(deps.paths);
  const resolved = await resolve(deps, req.slot, graph);
  if (!resolved.ok) return resolved;

  const label = slotLabel(req.slot);
  const taskHash = taskHashOf(resolved.plan);
  const node = graph.get(taskHash);
  const held = node?.status === 'done' && node.output !== req.hash ? node.output : undefined;
  if (held && !req.replace) {
    return {
      ok: false,
      code: 'ALREADY_RENDERED',
      reason: `The ${label} is already the render ${held.slice(0, 8)}, and nothing about it has changed — adopting ${short} would replace real work. Adopt with replace to supersede it; the old bytes stay in the store.`,
    };
  }
  return {
    ok: true,
    plan: {
      kind: resolved.plan.kind,
      taskHash,
      label,
      ...(held ? { supersedes: held } : {}),
      note: held
        ? `Would make ${short} the ${label}, superseding the render ${held.slice(0, 8)}. The old bytes stay in the store.`
        : `Would make ${short} the ${label}, so the next run adopts it instead of rendering one.`,
    },
  };
}

/** The `done` record, written through `adopt` so the one guard stays the one guard. */
async function record(
  deps: AdoptSlotDeps,
  resolved: Resolved,
  output: Asset,
  replace: boolean | undefined,
  graph: TaskGraph,
): Promise<void> {
  const ctx = { has: (h: string) => deps.store.has(h), node: (h: string) => graph.get(h) };
  const flag = replace ? { replace: true } : {};
  // Spelled out per kind because `adopt` is generic: only a narrowed pair type-checks.
  const done = await (resolved.kind === 'location_ref'
    ? adopt(deps.paths, { kind: resolved.kind, inputs: resolved.inputs, output, ...flag }, ctx)
    : resolved.kind === 'model_sheet'
      ? adopt(deps.paths, { kind: resolved.kind, inputs: resolved.inputs, output, ...flag }, ctx)
      : adopt(deps.paths, { kind: resolved.kind, inputs: resolved.inputs, output, ...flag }, ctx));
  if (!done.ok) throw new VnError(done.code, done.reason);
}

/**
 * Record bytes already in the store as a slot's output.
 *
 * Three writes, each depending on the last: the bytes are re-recorded under the slot's kind — which
 * is what routes them to the right root — a shot slot's frame is stamped into `work/shots/`, and
 * the task identity is logged `done`. That last one is the mechanism: `loadGraph` replays the
 * record, `TaskGraph.add` returns the existing `done` node, and `ready()` skips it.
 *
 * Nothing is accepted here. Adoption says "this is that task's output", not "a human approved it".
 */
export async function adoptSlot(
  deps: AdoptSlotDeps,
  req: AdoptSlotRequest,
): Promise<AdoptSlotResult> {
  const decided = await adoptionForSlot(deps, req);
  if (!decided.ok) throw new VnError(decided.code, decided.reason);

  const graph = await loadGraph(deps.paths);
  const resolved = await resolve(deps, req.slot, graph);
  if (!resolved.ok) throw new VnError(resolved.code, resolved.reason);
  // What is adopted is what the store holds; `req.bytes` is for the decision only.
  const asset = deps.store.manifest().find((a) => a.hash === req.hash);
  if (!asset) throw new VnError('UNKNOWN_ASSET', `No asset "${req.hash}" in the store.`);

  const bytes = await deps.store.read({ hash: asset.hash, ext: asset.ext });
  const ref = await deps.store.write(bytes, asset.ext, {
    kind: resolved.plan.kind,
    sourceTask: decided.plan.taskHash,
    prompt: resolved.plan.inputs.prompt,
    refs: resolved.plan.inputs.refs.map((r) => r.hash),
    modelId: asset.modelId,
    // `mergeBindings` keeps what the bytes already served, so the tree still shows where an adopted
    // picture came from — the same thing promotion has always done.
    satisfies: bindingOf(req.slot),
  });

  if (resolved.plan.kind === 'shot_image') {
    // Beside the image, because that is the only place the hash means anything: a frame handed in
    // by an artist is answerable for the lines it was drawn from exactly as a rendered one is.
    const { scene, shot, shots } = resolved.plan.stamp;
    shot.image = ref.hash;
    shot.proseHash = proseHash(scene, shot.coversLines);
    await writeShots(deps.paths, scene.id, shots);
  }

  const written = deps.store.manifest().find((a) => a.hash === ref.hash)!;
  await record(deps, resolved.plan, written, req.replace, graph);
  return { ref, plan: decided.plan };
}

/**
 * Every picture this project implies, whether or not anything has drawn one yet.
 *
 * `planTasks` is incremental by construction: a `shot_image`'s inputs embed its plate's and its
 * cast's **asset** hashes, and `taskHash` covers the whole inputs object, so a shot's identity does
 * not exist until those have rendered. A graph of task hashes is therefore structurally incapable of
 * showing the future, and a surface that wants to show one has to guess — which is what the Task
 * Graph pane's ghost clusters were.
 *
 * So the full graph is a graph of **slots**: the addresses `refcycle.ts` already speaks, which exist
 * before anything is rendered and survive a re-plan. The planner's real identity is attached to the
 * slots the project can currently state one for, and the ones it cannot carry the sentence saying
 * why — the same sentence adoption refuses with, because it is the same question.
 *
 * Three contracts, each load-bearing:
 *
 * - **Sheets are enumerated for every used outfit whether or not the gate has cleared.** That is
 *   exactly the difference between a slot graph and a plan. It follows that this is **not** a
 *   prediction of what `planTasks` emits this wave — `vngen cost` remains that answer.
 * - **Shots come only from persisted decompositions.** A scene with no `work/shots/<id>.json` has no
 *   shot slots, and none are fabricated: decomposing is an explicit act with a price, never a read.
 * - **`hash` and `candidates` are different answers and both are needed.** See {@link SlotNode}.
 *
 * The reverse index lives here rather than on `TaskGraph` deliberately: `Task.deps` is documented
 * incomplete and is not hashed, so inverting it would answer a question nobody asks.
 */
import type { AnyTask, AssetRef, RefBinding, Scene, Shot, TaskInputs, TaskStatus } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import {
  outfitFor,
  reachableScenes,
  usedCharacters,
  usedLocationVariants,
  usedOutfits,
} from '@vn/model';
import { makeTask } from '@vn/taskgraph';
import { type BindingContext, candidatesFor, resolveBinding } from './refs.js';
import { refsOfSlot, slotKey, slotLabel } from './refcycle.js';
import type { RungContext } from './resolve.js';
import {
  imageParams,
  locationInputs,
  modelSheetInputs,
  portraitInputs,
  shotInputs,
  MODEL_SHEET_ANGLES,
  SHEET_FRONT,
} from './prompts.js';
import { isApproved } from './gate.js';

/** A decision that either carries a plan or names, in a sentence, why there is none. */
export type Decided<T> = { ok: false; code: string; reason: string } | { ok: true; plan: T };

/** What stating a slot's identity reads — deliberately not the manifest, which it never consults. */
export interface SlotResolveContext extends RungContext {
  config: ProjectConfig;
  /**
   * The task graph as loaded. Optional, and its absence is meaningful: without it no `shot:` slot
   * can state an identity, and the graph is pure shape — which is all a caller that has not read
   * `state/tasks.jsonl` is entitled to.
   */
  graph?: { get(hash: string): AnyTask | undefined };
}

/** What walking the whole graph reads: identity, plus the manifest that says what fills each slot. */
export interface SlotGraphContext extends SlotResolveContext, BindingContext {}

/** A slot resolved against the project: which task it is, and what that task's inputs are. */
export type ResolvedSlot =
  | { kind: 'portrait'; inputs: TaskInputs['portrait'] }
  | { kind: 'location_ref'; inputs: TaskInputs['location_ref'] }
  | { kind: 'model_sheet'; inputs: TaskInputs['model_sheet'] }
  | { kind: 'shot_image'; inputs: TaskInputs['shot_image'] };

/** The task identity a resolved slot has. Switched rather than generic: the pair has to correlate. */
export function slotTaskHash(r: ResolvedSlot): string {
  switch (r.kind) {
    case 'portrait':
      return makeTask('portrait', r.inputs).hash;
    case 'location_ref':
      return makeTask('location_ref', r.inputs).hash;
    case 'model_sheet':
      return makeTask('model_sheet', r.inputs).hash;
    case 'shot_image':
      return makeTask('shot_image', r.inputs).hash;
  }
}

/** The upstream art a shot's identity is built on, in the order the planner puts it in. */
function shotUpstream(scene: Scene, shot: Shot, ctx: SlotResolveContext): Decided<AssetRef[]> {
  const params = imageParams(ctx.config);
  const missing = (what: string): Decided<AssetRef[]> => ({
    ok: false,
    code: 'UPSTREAM_MISSING',
    reason: `${what} has not been rendered, and a frame's identity is built on it — run the pipeline far enough to produce it.`,
  });
  const output = (hash: string): AssetRef | undefined => {
    const task = ctx.graph?.get(hash);
    return task?.status === 'done' && task.output ? { hash: task.output, ext: 'png' } : undefined;
  };

  const location = ctx.model.locations.get(scene.location);
  if (!location) {
    return {
      ok: false,
      code: 'NO_SUCH_SLOT',
      reason: `Scene ${scene.id} is set in "${scene.location}", which is not a location this project has.`,
    };
  }
  const plate = output(
    makeTask('location_ref', locationInputs(location, shot.location, ctx.config, params)).hash,
  );
  if (!plate) return missing(`The "${shot.location}" plate for ${location.id}`);

  const refs: AssetRef[] = [plate];
  for (const subject of shot.subjects) {
    const character = ctx.model.characters.get(subject.characterId);
    if (!character?.approvedPortrait) return missing(`${subject.characterId}'s portrait`);
    const portrait: AssetRef = { hash: character.approvedPortrait, ext: 'png' };
    refs.push(portrait);

    const outfit = outfitFor(subject, scene, character);
    if (outfit.id === character.defaultOutfit) continue;
    const sheet = output(
      makeTask(
        'model_sheet',
        modelSheetInputs(character, outfit.id, SHEET_FRONT, portrait, ctx.config, params),
      ).hash,
    );
    if (!sheet) return missing(`${character.id}'s "${outfit.id}" sheet`);
    refs.push(sheet);
  }
  return { ok: true, plan: refs };
}

/**
 * The planner's own identity for a slot, computed from the project as it stands — or the sentence
 * saying why the project cannot state one yet.
 *
 * Pure: everything it reads is already loaded by the caller, which is what lets a whole-graph pass
 * call it once per slot. `adoptSlot` is the other caller and loads the model, the manifest and the
 * shots itself before calling; the `portrait:` refusal it gives belongs to *adoption*, not to
 * identity, so it stays there rather than here.
 */
export function resolveSlot(slot: RefBinding, ctx: SlotResolveContext): Decided<ResolvedSlot> {
  const params = imageParams(ctx.config);
  const gone = (what: string): Decided<ResolvedSlot> => ({
    ok: false,
    code: 'NO_SUCH_SLOT',
    reason: `${what} — nothing in this project plans that picture.`,
  });

  switch (slot.kind) {
    case 'portrait': {
      const character = ctx.model.characters.get(slot.characterId);
      if (!character) return gone(`There is no character "${slot.characterId}"`);
      return {
        ok: true,
        plan: { kind: 'portrait', inputs: portraitInputs(character, ctx.config, params) },
      };
    }
    case 'plate': {
      const location = ctx.model.locations.get(slot.locationId);
      if (!location) return gone(`There is no location "${slot.locationId}"`);
      if (!location.variants.some((v) => v.id === slot.variant))
        return gone(`${location.id} has no "${slot.variant}" variant`);
      return {
        ok: true,
        plan: {
          kind: 'location_ref',
          inputs: locationInputs(location, slot.variant, ctx.config, params),
        },
      };
    }
    case 'sheet': {
      const character = ctx.model.characters.get(slot.characterId);
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
            ctx.config,
            params,
          ),
        },
      };
    }
    case 'shot': {
      const scene = ctx.model.scenes.get(slot.sceneId);
      if (!scene) return gone(`There is no scene "${slot.sceneId}"`);
      const shot = ctx.shots?.get(slot.sceneId)?.find((s) => s.id === slot.shotId);
      if (!shot) return gone(`Scene ${scene.id} has no shot "${slot.shotId}"`);
      const upstream = shotUpstream(scene, shot, ctx);
      if (!upstream.ok) return upstream;
      return {
        ok: true,
        plan: {
          kind: 'shot_image',
          inputs: shotInputs(shot, scene, ctx.model, ctx.config, params, upstream.plan),
        },
      };
    }
    case 'asset':
      return {
        ok: false,
        code: 'NOT_A_SLOT',
        reason:
          'An upload and a concept are their own identity — there is no task under them to be the output of.',
      };
  }
}

/** One picture this project implies, whether or not anything has drawn it. */
export interface SlotNode {
  /** `slotKey(binding)` — the identity, stable across re-plans and the address a command names. */
  key: string;
  binding: RefBinding;
  /** `slotLabel(binding)` — ids, because this names a picture's place rather than the art. */
  label: string;
  /** Upstream slot keys. May name a slot `nodes` has no entry for; see {@link buildSlotGraph}. */
  refs: string[];
  /** The planner's identity, where the project can state one. */
  taskHash?: string;
  status?: TaskStatus;
  /** {@link resolveSlot}'s own sentence, when it cannot. */
  blocked?: string;
  /**
   * The asset that settles this slot — `resolveBinding`'s answer, which declines whenever the
   * answer is not certain.
   */
  hash?: string;
  /**
   * Every manifest asset bound here, accepted or not. **Empty is what "not yet rendered" means**,
   * and `hash === undefined` is not: a portrait resolves off the gate and so is unset before
   * approval even with three drafts filed, and `pick` declines when two unaccepted candidates tie.
   * Either would report real bytes as unrendered.
   */
  candidates: string[];
  /**
   * Whether a human has blessed what fills this slot. **Asymmetric, deliberately**: a `portrait:`
   * answers to the P3 gate (`isApproved`), everything else to `Asset.accepted`. Two different acts
   * wearing one word, and conflating them is the bug this graph exists to prevent.
   */
  approved: boolean;
}

export interface SlotGraph {
  nodes: Map<string, SlotNode>;
  /** The reverse index `TaskGraph` has never had — slot key → the slots drawn from it. */
  dependents: Map<string, string[]>;
  /** Upstream before downstream: the order approval has to happen in. */
  order: string[];
}

/** Every slot this project implies, keyed by address, with its edges inverted. */
export function buildSlotGraph(ctx: SlotGraphContext): SlotGraph {
  const bindings: RefBinding[] = [];

  for (const [locationId, variants] of usedLocationVariants(ctx.model))
    for (const variant of variants) bindings.push({ kind: 'plate', locationId, variant });

  for (const character of usedCharacters(ctx.model))
    bindings.push({ kind: 'portrait', characterId: character.id });

  const shots = new Map<string, readonly Shot[]>();
  for (const scene of reachableScenes(ctx.model)) {
    const persisted = ctx.shots?.get(scene.id);
    if (persisted) shots.set(scene.id, persisted);
  }
  for (const [characterId, outfits] of usedOutfits(ctx.model, shots))
    for (const outfit of outfits)
      for (const angle of MODEL_SHEET_ANGLES)
        bindings.push({ kind: 'sheet', characterId, outfit, angle });

  for (const [sceneId, list] of shots)
    for (const shot of list) bindings.push({ kind: 'shot', sceneId, shotId: shot.id });

  const nodes = new Map<string, SlotNode>();
  for (const binding of bindings) {
    const key = slotKey(binding);
    if (nodes.has(key)) continue;
    const candidates = candidatesFor(binding, ctx);
    const hash = resolveBinding(binding, ctx);
    const decided = resolveSlot(binding, ctx);
    const task = decided.ok ? slotTaskHash(decided.plan) : undefined;
    const status = task ? ctx.graph?.get(task)?.status : undefined;
    const character =
      binding.kind === 'portrait' ? ctx.model.characters.get(binding.characterId) : undefined;

    nodes.set(key, {
      key,
      binding,
      label: slotLabel(binding),
      // Not filtered to enumerated keys: an edge to an authored `asset:<hash>` pin is real, and a
      // consumer treats a key `nodes` has no entry for as an opaque upstream.
      refs: refsOfSlot(binding, ctx).map(slotKey),
      ...(task ? { taskHash: task } : {}),
      ...(status ? { status } : {}),
      ...(decided.ok ? {} : { blocked: decided.reason }),
      ...(hash ? { hash } : {}),
      candidates: candidates.map((a) => a.hash),
      approved:
        binding.kind === 'portrait'
          ? !!character && isApproved(character)
          : !!hash && candidates.some((a) => a.hash === hash && a.accepted),
    });
  }

  const dependents = new Map<string, string[]>();
  for (const node of nodes.values())
    for (const ref of node.refs) dependents.set(ref, [...(dependents.get(ref) ?? []), node.key]);

  // Post-order depth-first, so an upstream is emitted before everything drawn from it. The
  // `visiting` guard is the one `suspendedAssets` uses and for its reason: enforcement stops a
  // cycle being *written*, and this stops a project that somehow holds one wedging the app.
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const walk = (key: string): void => {
    if (done.has(key) || visiting.has(key)) return;
    visiting.add(key);
    for (const ref of nodes.get(key)?.refs ?? []) walk(ref);
    visiting.delete(key);
    done.add(key);
    if (nodes.has(key)) order.push(key);
  };
  for (const key of nodes.keys()) walk(key);

  return { nodes, dependents, order };
}

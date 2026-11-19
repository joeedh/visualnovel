/**
 * A slot's identity: the task the planner adds for it, or the sentence saying why the project
 * cannot state one yet (`planSlot`, `resolveSlot`), and the context the stills family reads.
 *
 * A `shot_image`'s inputs embed its plate's and its cast's asset hashes, and `taskHash` covers the
 * whole inputs object, so a shot has no identity until those have rendered. Its slot exists before
 * that, under an address `refcycle.ts` speaks, and carries the sentence instead. Adoption refuses
 * with the same sentence, because it answers the same question.
 *
 * `solve(stillsFamily, facts)` enumerates the slots, and every reader takes its slot states from
 * that one answer.
 */
import type { AnyTask, Asset, AssetRef, RefBinding, Scene, Shot, TaskInputs } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { Decided } from '@vn/constraint-solver';
import { shotsOf } from '@vn/types';
import { outfitFor, usedOutfits, variantIds } from '@vn/model';
import { makeTask } from '@vn/taskgraph';
import { type BindingContext, candidatesFor, sheetAngleOf } from './refs.js';
import { slotsOf } from './refcycle.js';
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
import { approvedPortraitOf } from './gate.js';
import { sheetKeys } from './sheet.js';

export type { Decided };

/**
 * The fields stating a slot's identity reads. The manifest enters through the approved portrait
 * (`approvedPortraitOf`): with `assets`, a sheet or a frame is keyed on the portrait the gate
 * approves off the row; without them, on the sheet's mirror, which is what a pure plan reads. It
 * also enters a staging-sheet member's identity through the sheet's references (`sheetKeys`),
 * which resolve to none without `assets`, as they do in a plan given no manifest.
 */
export interface SlotResolveContext extends RungContext {
  config: ProjectConfig;
  assets?: readonly Asset[];
  /** `usedOutfits(model)`, when the caller has it already; computed per call without it. */
  outfits?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The task graph as loaded. Its absence is meaningful: without it no `shot:` slot can state an
   * identity and the result is pure shape, which is all a caller that has not read
   * `state/tasks.jsonl` is entitled to.
   */
  graph?: { get(hash: string): AnyTask | undefined };
}

/** What walking the whole graph reads: identity, plus the manifest that says what fills each slot. */
export interface SlotGraphContext extends Omit<SlotResolveContext, 'assets'>, BindingContext {}

/** A slot resolved against the project: which task it is, and what that task's inputs are. */
export type ResolvedSlot =
  | { kind: 'portrait'; inputs: TaskInputs['portrait'] }
  | { kind: 'location_ref'; inputs: TaskInputs['location_ref'] }
  | { kind: 'model_sheet'; inputs: TaskInputs['model_sheet'] }
  | { kind: 'shot_image'; inputs: TaskInputs['shot_image'] };

/**
 * The task identity a resolved slot has. Written as a switch rather than a generic so that a kind
 * and its inputs stay correlated.
 */
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

/** What a shot is drawn from: the upstream art, and the tasks that drew the plate and the sheets. */
interface Upstream {
  /** In the order the planner puts them in the shot's inputs. */
  refs: AssetRef[];
  /** The plate's task and each non-default sheet's; a portrait's is not one. */
  tasks: string[];
}

/** Finds the upstream art a shot's identity is built on, or says which piece is not drawn yet. */
function shotUpstream(scene: Scene, shot: Shot, ctx: SlotResolveContext): Decided<Upstream> {
  const params = imageParams(ctx.config);
  const missing = (what: string): Decided<Upstream> => ({
    ok    : false,
    code  : 'UPSTREAM_MISSING',
    reason: `${what} has not been rendered, and a frame's identity is built on it — run the pipeline far enough to produce it.`,
  });
  const output = (hash: string): AssetRef | undefined => {
    const task = ctx.graph?.get(hash);
    return task?.status === 'done' && task.output ? { hash: task.output, ext: 'png' } : undefined;
  };

  const location = ctx.model.locations.get(scene.location);
  if (!location) {
    return {
      ok    : false,
      code  : 'NO_SUCH_SLOT',
      reason: `Scene ${scene.id} is set in "${scene.location}", which is not a location this project has.`,
    };
  }
  const plateTask = makeTask(
    'location_ref',
    locationInputs(location, shot.location, ctx.config, params),
  ).hash;
  const plate = output(plateTask);
  if (!plate) return missing(`The "${shot.location}" plate for ${location.id}`);

  const refs: AssetRef[] = [plate];
  const tasks = [plateTask];
  for (const subject of shot.subjects) {
    const character = ctx.model.characters.get(subject.characterId);
    const approved = character ? approvedPortraitOf(character, ctx.assets) : undefined;
    if (!character || !approved) return missing(`${subject.characterId}'s portrait`);
    const portrait: AssetRef = { hash: approved, ext: 'png' };
    refs.push(portrait);

    const outfit = outfitFor(subject, scene, character);
    if (outfit.id === character.defaultOutfit) continue;
    const sheetTask = makeTask(
      'model_sheet',
      modelSheetInputs(character, outfit.id, SHEET_FRONT, portrait, ctx.config, params),
    ).hash;
    const sheet = output(sheetTask);
    if (!sheet) return missing(`${character.id}'s "${outfit.id}" sheet`);
    refs.push(sheet);
    tasks.push(sheetTask);
  }
  return { ok: true, plan: { refs, tasks } };
}

/** A slot's task as the planner adds it: the resolved slot, and the tasks it runs after. */
export interface PlannedSlot {
  resolved: ResolvedSlot;
  /**
   * Task hashes for `Task.deps`, which `topoOrder` reads: a shot's plate and its non-default
   * sheets, and none for any other slot. A portrait is not one, because a shot keys on the
   * approved row rather than on the portrait task.
   */
  deps: string[];
}

/**
 * The planner's own task for a slot, computed from the project as it stands — or the sentence
 * saying why the project cannot state one yet.
 *
 * Pure, because everything it reads is already loaded by the caller, which is what lets a
 * whole-graph pass call it once per slot. `adoptSlot` reaches it through {@link resolveSlot} and
 * loads the model, the manifest and the shots itself before calling. Its `portrait:` refusal
 * belongs to adoption rather than to identity, so it stays there rather than here.
 */
export function planSlot(slot: RefBinding, ctx: SlotResolveContext): Decided<PlannedSlot> {
  const params = imageParams(ctx.config);
  const planned = (resolved: ResolvedSlot, deps: string[] = []): Decided<PlannedSlot> => ({
    ok  : true,
    plan: { resolved, deps },
  });
  const gone = (what: string): Decided<PlannedSlot> => ({
    ok    : false,
    code  : 'NO_SUCH_SLOT',
    reason: `${what} — nothing in this project plans that picture.`,
  });

  switch (slot.kind) {
    case 'portrait': {
      const character = ctx.model.characters.get(slot.characterId);
      if (!character) return gone(`There is no character "${slot.characterId}"`);
      return planned({ kind: 'portrait', inputs: portraitInputs(character, ctx.config, params) });
    }
    case 'plate': {
      const location = ctx.model.locations.get(slot.locationId);
      if (!location) return gone(`There is no location "${slot.locationId}"`);
      if (!variantIds(location).has(slot.variant))
        return gone(`${location.id} has no "${slot.variant}" variant`);
      return planned({
        kind  : 'location_ref',
        inputs: locationInputs(location, slot.variant, ctx.config, params),
      });
    }
    case 'sheet': {
      const character = ctx.model.characters.get(slot.characterId);
      if (!character) return gone(`There is no character "${slot.characterId}"`);
      const approved = approvedPortraitOf(character, ctx.assets);
      if (!approved) {
        return {
          ok    : false,
          code  : 'NOT_APPROVED',
          reason: `${character.id}'s look has not been approved, and a sheet is drawn from the approved portrait — approve one with gate.approve first.`,
        };
      }
      // `usedOutfits` keeps an outfit a shot names that the sheet does not author, and the planner
      // draws its sheet from the id alone
      if (
        !character.outfits.some((o) => o.id === slot.outfit) &&
        !(ctx.outfits ?? usedOutfits(ctx.model)).get(character.id)?.has(slot.outfit)
      )
        return gone(`${character.id} has no "${slot.outfit}" outfit`);
      if (!(MODEL_SHEET_ANGLES as readonly string[]).includes(slot.angle))
        return gone(`"${slot.angle}" is not one of the ${MODEL_SHEET_ANGLES.join(', ')} angles`);
      return planned({
        kind  : 'model_sheet',
        inputs: modelSheetInputs(
          character,
          slot.outfit,
          slot.angle,
          { hash: approved, ext: 'png' },
          ctx.config,
          params,
        ),
      });
    }
    case 'shot': {
      const scene = ctx.model.scenes.get(slot.sceneId);
      if (!scene) return gone(`There is no scene "${slot.sceneId}"`);
      const shot = shotsOf(ctx.model, slot.sceneId).find((s) => s.id === slot.shotId);
      if (!shot) return gone(`Scene ${scene.id} has no shot "${slot.shotId}"`);
      const upstream = shotUpstream(scene, shot, ctx);
      if (!upstream.ok) return upstream;
      // Without a manifest the sheet is keyed on no references, which is what the planner does
      const sheet =
        shot.sheet === undefined
          ? undefined
          : sheetKeys(scene, ctx.model, ctx.config, ctx.assets ?? []).get(shot.sheet);
      return planned(
        {
          kind  : 'shot_image',
          inputs: shotInputs(shot, scene, ctx.model, ctx.config, params, upstream.plan.refs, sheet),
        },
        upstream.plan.tasks,
      );
    }
    case 'asset':
      return {
        ok    : false,
        code  : 'NOT_A_SLOT',
        reason:
          'An upload and a concept are their own identity — there is no task under them to be the output of.',
      };
  }
}

/** Answers {@link planSlot}'s task for a slot without its deps, which is a slot's identity. */
export function resolveSlot(slot: RefBinding, ctx: SlotResolveContext): Decided<ResolvedSlot> {
  const decided = planSlot(slot, ctx);
  return decided.ok ? { ok: true, plan: decided.plan.resolved } : decided;
}

/**
 * The current rows that holding `asset` releases: every other current candidate of every slot the
 * asset serves. Currency is exclusive per slot because `pick` declines a slot holding two current
 * rows, and the slot then reads as empty and everything drawn from it re-renders. A row bound to
 * two slots is current for both or neither, so both slots' other rows are listed.
 *
 * A sheet's angle comes off its binding, or off its task where the binding predates the angle
 * being stored; a row with neither could be any of the four, so it releases nothing rather than
 * a sibling of another angle.
 */
export function heldBy(asset: Asset, ctx: BindingContext): string[] {
  const out = new Set<string>();
  const angle = sheetAngleOf(asset, ctx);
  if (angle === undefined && (asset.kind === 'model_sheet' || asset.kind === 'outfit_sheet')) {
    return [];
  }
  for (const slot of slotsOf(asset, angle)) {
    for (const other of candidatesFor(slot, ctx)) {
      if (other.current && other.hash !== asset.hash) out.add(other.hash);
    }
  }
  return [...out];
}

/**
 * The stills family as `@vn/constraint-solver` sees it: four slot kinds and the slots a project
 * implies. Each kind wraps the functions the slot graph already calls (`slotKey`, `refsOfSlot`,
 * `resolveSlot`, `candidatesFor`, `resolveBinding`), so `solve(stillsFamily, facts)` and
 * `buildSlotGraph` answer the same slot for slot until stage 6b retires the latter.
 */
import type { Asset, RefBinding, TaskInputs, TaskKind } from '@vn/types';
import { shotsOf } from '@vn/types';
import { allCharacters, allLocationVariants, liveScenes, usedOutfits } from '@vn/model';
import { contract, type Contract } from '@vn/contracts';
import {
  identitySlotsBeforeTasks,
  slot,
  type Decided,
  type Family,
  type Held,
  type Slot,
  type SlotKind,
  type SolverFacts,
} from '@vn/constraint-solver';
import { candidatesFor, resolveBinding } from './refs.js';
import { refsOfSlot } from './refcycle.js';
import { parseSlot, slotKey, slotLabel } from './slotaddr.js';
import { MODEL_SHEET_ANGLES } from './prompts.js';
import { newestFirst, resolveSlot, type ResolvedSlot, type SlotGraphContext } from './slotgraph.js';

/** What the stills kinds read: the solver's facts plus the model, the config and the manifest. */
export interface StillsFacts extends SolverFacts, Omit<SlotGraphContext, 'assets' | 'graph'> {
  /** Both roots, as `BindingContext` reads them; an empty list where the caller holds no store. */
  assets: readonly Asset[];
}

/** The four bindings a stills slot is addressed by; `asset:` names a pin, not a slot. */
type SlotPrefix = Exclude<RefBinding['kind'], 'asset'>;
type Bound<P extends SlotPrefix> = Extract<RefBinding, { kind: P }>;

/** Narrows `resolveSlot`'s answer to the inputs of the one task kind this slot kind fills. */
function inputsFor<K extends TaskKind>(
  task: K,
  decided: Decided<ResolvedSlot>,
): Decided<TaskInputs[K]> {
  if (!decided.ok) return decided;
  if (decided.plan.kind !== task)
    throw new Error(`resolveSlot planned a ${decided.plan.kind} task for a ${task} slot`);
  return { ok: true, plan: decided.plan.inputs as TaskInputs[K] };
}

export const takesApprovedMeansAccepted = contract({
  id      : 'takes.approvedMeansAccepted',
  rule: 'A stills slot is approved when the take it holds (`pick`: its one current row, else its only row) is a row a person accepted. Every kind, the portrait included, answers through the one test on `SlotKind.approved`, `heldAccepted`.',
  prevents:
    'Each surface deciding approval its own way per kind, so the document tree, the gate pane and export disagree about whether a slot still waits for a person.',
  subjects: [
    'function:packages/stills/src/family.ts#heldAccepted',
    'function:packages/stills/src/slotgraph.ts#SlotNode',
    'function:packages/stills/src/refs.ts#pick',
  ],
  detail:
    "The P3 gate's `approvedPortraitOf` asks for a row that is both current and accepted, so the " +
    'two differ in one case: a portrait slot whose only row is accepted but not current is ' +
    "approved here and not by the gate. `buildSlotGraph`'s `SlotNode.approved` uses the same " +
    'test as the kinds.',
});

export const planningSheetsOnlyWhenWorn = contract({
  id      : 'planning.sheetsOnlyWhenWorn',
  rule: 'Every authored character has a portrait slot and every authored location variant a plate slot, cast or not. Sheet slots exist only for the outfits `usedOutfits` finds over live scenes, so an uncast character has none even once approved.',
  prevents:
    'Paying three sheet calls per outfit for a character no shot can show, or hiding the portrait an author drew before writing the scenes that cast them.',
  subjects: [
    'function:packages/stills/src/family.ts#stillsFamily',
    'module:packages/stills/src/slotgraph.ts',
    'module:packages/pipeline/src/planner.ts',
    'function:packages/model/src/used.ts#allCharacters',
    'function:packages/model/src/used.ts#allLocationVariants',
    'function:packages/model/src/used.ts#usedOutfits',
  ],
  see     : ['docs/plans/archive/INDEX.md#drawing-a-character-before-a-scene-casts-them'],
  detail:
    "The planner's P2 and P3 plan over `allLocationVariants` and `allCharacters`, and P4 fans " +
    'sheets out over `usedOutfits`. `stillsFamily` and `buildSlotGraph` enumerate from the same ' +
    'three, and a test plans a mock project to exhaustion and asserts the slot graph promises ' +
    'exactly what was planned. `usedOutfits` gives everyone a live scene casts their default ' +
    'outfit, plus each `[[outfit:]]` marker and shot override. The gate is a separate question: ' +
    "`gateStatus` walks live scenes' casts, so an uncast character's unapproved portrait halts " +
    "nothing and shows in the document tree's Awaiting approval branch.",
});

/** Says whether the take a slot holds is one a person accepted, the same test for every kind. */
export function heldAccepted(_binding: unknown, _facts: StillsFacts, held: Held): boolean {
  return !!held.pick && held.rows.some((a) => a.hash === held.pick && a.accepted);
}

/** Builds one stills slot kind over the shared slot-address and slot-graph functions. */
function stillsKind<P extends SlotPrefix, K extends TaskKind>(
  prefix: P,
  task: K,
  contracts: readonly Contract[],
): SlotKind<StillsFacts, Bound<P>, K> {
  return {
    prefix,
    task,
    contracts,
    key       : slotKey,
    parse: (key) => {
      const binding = parseSlot(key);
      return binding?.kind === prefix ? (binding as Bound<P>) : undefined;
    },
    label     : slotLabel,
    refs      : (binding, facts) => refsOfSlot(binding, facts).map(slotKey),
    resolve: (binding, facts) =>
      inputsFor(
        task,
        resolveSlot(binding, {
          model : facts.model,
          config: facts.config,
          assets: facts.assets,
          graph : facts.tasks,
        }),
      ),
    candidates: (binding, facts) => newestFirst(candidatesFor(binding, facts)),
    pick      : (binding, facts) => resolveBinding(binding, facts),
    approved  : heldAccepted,
  };
}

const EVERY_KIND = [identitySlotsBeforeTasks, takesApprovedMeansAccepted];
const AUTHORED = [...EVERY_KIND, planningSheetsOnlyWhenWorn];

export const plateKind = stillsKind('plate', 'location_ref', AUTHORED);
export const portraitKind = stillsKind('portrait', 'portrait', AUTHORED);
export const sheetKind = stillsKind('sheet', 'model_sheet', AUTHORED);
export const shotKind = stillsKind('shot', 'shot_image', EVERY_KIND);

/**
 * Lists the slots `buildSlotGraph` lists, in its order: every authored location variant's plate
 * and every authored character's portrait, a sheet per angle of each used outfit, and the shots
 * of each live scene's storyboard in the production map, each shot in its scene's unit.
 */
function enumerate(facts: StillsFacts): Slot<StillsFacts>[] {
  const out: Slot<StillsFacts>[] = [];
  for (const [locationId, variants] of allLocationVariants(facts.model))
    for (const variant of variants)
      out.push(slot(plateKind, { kind: 'plate', locationId, variant }));

  for (const character of allCharacters(facts.model))
    out.push(slot(portraitKind, { kind: 'portrait', characterId: character.id }));

  for (const [characterId, outfits] of usedOutfits(facts.model))
    for (const outfit of outfits)
      for (const angle of MODEL_SHEET_ANGLES)
        out.push(slot(sheetKind, { kind: 'sheet', characterId, outfit, angle }));

  for (const scene of liveScenes(facts.model))
    for (const shot of shotsOf(facts.model, scene.id))
      out.push(slot(shotKind, { kind: 'shot', sceneId: scene.id, shotId: shot.id }, scene.id));
  return out;
}

export const stillsFamily: Family<StillsFacts> = {
  id   : 'stills',
  kinds: [plateKind, portraitKind, sheetKind, shotKind],
  enumerate,
};

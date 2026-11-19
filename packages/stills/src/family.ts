/**
 * The stills family as `@vn/constraint-solver` sees it: four slot kinds and the slots a project
 * implies. Each kind wraps the slot functions the rest of the package shares (`slotKey`,
 * `refsOfSlot`, `planSlot`, `candidatesFor`, `pick`), and `solve(stillsFamily, facts)` is what the
 * planner plans from.
 */
import type { Asset, RefBinding, TaskInputs, TaskKind } from '@vn/types';
import { shotsOf } from '@vn/types';
import { allCharacters, allLocationVariants, liveScenes, usedOutfits } from '@vn/model';
import { contract, type Contract } from '@vn/contracts';
import {
  identitySlotsBeforeTasks,
  slot,
  solve,
  type Decided,
  type Family,
  type Held,
  type Slot,
  type SlotKind,
  type SolverFacts,
} from '@vn/constraint-solver';
import { type BindingContext, candidatesFor, pick } from './refs.js';
import { refsOfSlot } from './refcycle.js';
import { parseSlot, slotKey, slotLabel } from './slotaddr.js';
import { MODEL_SHEET_ANGLES } from './prompts.js';
import {
  newestFirst,
  planSlot,
  type PlannedSlot,
  type SlotGraph,
  type SlotGraphContext,
  type SlotNode,
  type SlotResolveContext,
} from './slotgraph.js';

/** The four bindings a stills slot is addressed by; `asset:` names a pin, not a slot. */
type SlotPrefix = Exclude<RefBinding['kind'], 'asset'>;
type Bound<P extends SlotPrefix> = Extract<RefBinding, { kind: P }>;

/**
 * What the stills kinds read: the solver's facts plus the model and the config. Without `assets`
 * the gate reads each character sheet's mirror, as a plan with no store does, and no slot holds a
 * row. The kinds memoise each slot's plan on the facts object, so a caller that changes the model
 * or the task log builds new facts before solving again.
 */
export interface StillsFacts extends SolverFacts, Omit<SlotGraphContext, 'assets' | 'graph'> {}

/** The context `planSlot` reads, with the manifest left absent when the caller has none. */
const resolveCtx = (facts: StillsFacts): SlotResolveContext => ({
  model : facts.model,
  config: facts.config,
  assets: facts.assets,
  graph : facts.tasks,
});

/** Each facts object's slot plans by address, so a shot's `resolve` and `deps` share one walk. */
const plans = new WeakMap<StillsFacts, Map<string, Decided<PlannedSlot>>>();

/** Answers `planSlot` for a slot, once per facts object. */
function planOf(binding: RefBinding, facts: StillsFacts): Decided<PlannedSlot> {
  let memo = plans.get(facts);
  if (!memo) plans.set(facts, (memo = new Map()));
  const key = slotKey(binding);
  let plan = memo.get(key);
  if (!plan) memo.set(key, (plan = planSlot(binding, resolveCtx(facts))));
  return plan;
}

/** Each facts object's manifest rows, grouped under every id their bindings name. */
const near = new WeakMap<StillsFacts, Map<string, Asset[]>>();

/** Gives the id a slot's rows are grouped under: every row `candidatesFor` keeps names it. */
function nearKey(binding: Bound<SlotPrefix>): string {
  switch (binding.kind) {
    case 'portrait':
    case 'sheet':
      return `character:${binding.characterId}`;
    case 'plate':
      return `location:${binding.locationId}`;
    case 'shot':
      return `scene:${binding.sceneId}`;
  }
}

/**
 * Answers the context binding reads, holding only the rows that name the slot's character,
 * location or scene, in manifest order. `candidatesFor` filters those as it would the whole
 * manifest. With no manifest, no slot holds a row.
 */
function bindingCtx(binding: Bound<SlotPrefix>, facts: StillsFacts): BindingContext {
  if (!facts.assets) return { ...facts, assets: [] };
  let groups = near.get(facts);
  if (!groups) {
    groups = new Map();
    for (const row of facts.assets) {
      const keys = new Set<string>();
      for (const b of row.satisfies) {
        if (b.characterId !== undefined) keys.add(`character:${b.characterId}`);
        if (b.locationId !== undefined) keys.add(`location:${b.locationId}`);
        if (b.sceneId !== undefined) keys.add(`scene:${b.sceneId}`);
      }
      for (const key of keys) {
        const rows = groups.get(key);
        if (rows) rows.push(row);
        else groups.set(key, [row]);
      }
    }
    near.set(facts, groups);
  }
  return { ...facts, assets: groups.get(nearKey(binding)) ?? [] };
}

/** Narrows `planSlot`'s answer to the inputs of the one task kind this slot kind fills. */
function inputsFor<K extends TaskKind>(
  task: K,
  decided: Decided<PlannedSlot>,
): Decided<TaskInputs[K]> {
  if (!decided.ok) return decided;
  const { resolved } = decided.plan;
  if (resolved.kind !== task)
    throw new Error(`planSlot planned a ${resolved.kind} task for a ${task} slot`);
  return { ok: true, plan: resolved.inputs as TaskInputs[K] };
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
    "approved here and not by the gate. `slotGraph`'s `SlotNode.approved` is the kinds' answer.",
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
    '`stillsFamily` enumerates plates over `allLocationVariants`, portraits over ' +
    '`allCharacters` and sheets over `usedOutfits`, and the planner plans from its slots. ' +
    '`usedOutfits` gives everyone a live scene casts their default outfit, plus each ' +
    '`[[outfit:]]` marker and shot override. The gate is a separate question: ' +
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
    resolve   : (binding, facts) => inputsFor(task, planOf(binding, facts)),
    deps: (binding, facts) => {
      const planned = planOf(binding, facts);
      return planned.ok ? planned.plan.deps : [];
    },
    candidates: (binding, facts) => newestFirst(candidatesFor(binding, bindingCtx(binding, facts))),
    pick      : (_binding, _facts, rows) => pick(rows),
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
 * Lists every authored location variant's plate and every authored character's portrait, a sheet
 * per angle of each used outfit whether or not the gate has cleared, and the shots of each live
 * scene's storyboard in the production map, each shot in its scene's unit. A scene the map holds
 * no storyboard for has no shot slots; none are made up, because decomposing costs a model call.
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

/** Lists the live scenes whose storyboard the production map does not hold, in model order. */
function owed(facts: StillsFacts): string[] {
  return liveScenes(facts.model)
    .filter((scene) => shotsOf(facts.model, scene.id).length === 0)
    .map((scene) => scene.id);
}

export const stillsFamily: Family<StillsFacts> = {
  id   : 'stills',
  kinds: [plateKind, portraitKind, sheetKind, shotKind],
  enumerate,
  owed,
};

/**
 * Answers `solve(stillsFamily, ctx)` in the `SlotGraph` shape that the document tree, the gate pane,
 * the Task Graph pane, takes and the gen-graph loader read. A context with no task log reads as an
 * empty one, so no shot slot states an identity.
 */
export function slotGraph(ctx: SlotGraphContext): SlotGraph {
  const { graph, ...rest } = ctx;
  const solved = solve(stillsFamily, { ...rest, tasks: graph ?? { get: () => undefined } });
  const nodes = new Map<string, SlotNode>();
  for (const [key, state] of solved.slots) {
    nodes.set(key, {
      key,
      binding: state.binding as RefBinding,
      label  : state.label,
      refs   : [...state.refs],
      ...(state.taskHash ? { taskHash: state.taskHash } : {}),
      ...(state.status ? { status: state.status } : {}),
      ...(state.blocked === undefined ? {} : { blocked: state.blocked }),
      ...(state.pick ? { hash: state.pick } : {}),
      candidates: [...state.candidates],
      approved  : state.approved,
    });
  }
  return { nodes, dependents: solved.dependents, order: solved.order };
}

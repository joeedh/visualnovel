/**
 * The stills family as `@vn/constraint-solver` sees it: four slot kinds, the slots a project
 * implies, and the P3 gate each scene waits on. Each kind wraps the slot functions the rest of the
 * package shares (`slotKey`, `refsOfSlot`, `planSlot`, `candidatesFor`), and
 * `solve(stillsFamily, facts)` is what the planner plans from.
 */
import type { Asset, ProjectModel, RefBinding, TaskInputs, TaskKind } from '@vn/types';
import { shotsOf } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { allCharacters, allLocationVariants, liveScenes, usedOutfits } from '@vn/model';
import { contract, type Contract } from '@vn/contracts';
import {
  identitySlotsBeforeTasks,
  slot,
  solve,
  unitGates,
  type Decided,
  type DrawnFrom,
  type Family,
  type Held,
  type Slot,
  type SlotKind,
  type SolverFacts,
} from '@vn/constraint-solver';
import { type BindingContext, candidatesFor, resolveBinding, sheetAngleOf } from './refs.js';
import { attachedRefs } from './upstream.js';
import { refsOfSlot, slotOf } from './refcycle.js';
import { parseSlot, slotKey, slotLabel } from './slotaddr.js';
import { MODEL_SHEET_ANGLES } from './prompts.js';
import { keptSlots } from './kept.js';
import { approvedPortraitOf } from './gate.js';
import {
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
 * row. Without `config` no slot states an identity, which the gate does not need. The kinds
 * memoise on the facts object, so a caller that changes the model or the task log builds new facts
 * before solving again.
 */
export interface StillsFacts
  extends SolverFacts, Omit<SlotGraphContext, 'assets' | 'graph' | 'config'> {
  readonly config?: ProjectConfig;
}

/** Stills facts that can state identities, as each host's one builder makes them. */
export interface PlanFacts extends StillsFacts {
  readonly config: ProjectConfig;
}

/** Each facts object's `usedOutfits`, which the enumeration and every sheet's plan read. */
const wardrobes = new WeakMap<StillsFacts, Map<string, Set<string>>>();

/** Answers `usedOutfits` for the facts' model, once per facts object. */
function wardrobe(facts: StillsFacts): Map<string, Set<string>> {
  let outfits = wardrobes.get(facts);
  if (!outfits) wardrobes.set(facts, (outfits = usedOutfits(facts.model)));
  return outfits;
}

/** Each facts object's slot plans by address, so a shot's `resolve` and `deps` share one walk. */
const plans = new WeakMap<StillsFacts, Map<string, Decided<PlannedSlot>>>();

/** Answers `planSlot` for a slot, once per facts object. */
function planOf(binding: RefBinding, facts: StillsFacts): Decided<PlannedSlot> {
  let memo = plans.get(facts);
  if (!memo) plans.set(facts, (memo = new Map()));
  const key = slotKey(binding);
  let plan = memo.get(key);
  if (!plan) memo.set(key, (plan = planned(binding, facts)));
  return plan;
}

/** Runs `planSlot` over the facts, with the manifest left absent when the caller has none. */
function planned(binding: RefBinding, facts: StillsFacts): Decided<PlannedSlot> {
  if (!facts.config) {
    return {
      ok    : false,
      code  : 'NO_CONFIG',
      reason: 'These facts carry no project config, so no slot states an identity.',
    };
  }
  const ctx: SlotResolveContext = {
    model  : facts.model,
    config : facts.config,
    assets : facts.assets,
    outfits: wardrobe(facts),
    graph  : facts.tasks,
  };
  return planSlot(binding, ctx);
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
    'function:packages/constraint-solver/src/take.ts#pick',
  ],
  detail:
    "The P3 gate does not ask this: the portrait kind's `clears` reads `approvedPortraitOf`, and " +
    '`gate.perUnit` lists the cases where the two answers differ. ' +
    "`slotGraph`'s `SlotNode.approved` is the kinds' answer.",
});

export const takesCurrencyExclusive = contract({
  id      : 'takes.currencyExclusive',
  rule: "A slot holds one take: its one `current` row, else its only row (the solver's `pick`). Two current rows hold nothing, and `overHeld` says which stays. `current` (the slot holds it) and `accepted` (a person approved it) are set by different acts, and neither clears the other.",
  prevents:
    'A slot read as holding two pictures, so the Task Graph pane, every pinned reference and everything drawn from the slot disagree about the take, or an approval that silently follows a re-render.',
  subjects: [
    'function:packages/constraint-solver/src/take.ts#pick',
    'function:packages/constraint-solver/src/take.ts#newestFirst',
    'function:packages/constraint-solver/src/take.ts#loggedTake',
    'function:packages/constraint-solver/src/take.ts#overHeld',
    'function:packages/stills/src/slotgraph.ts#heldBy',
    'function:packages/artgen/src/takes.ts#repairCurrent',
    'function:packages/artgen/src/takes.ts#migrateCurrent',
    'function:packages/artgen/src/adoptslot.ts#adoptSlot',
    'command:asset.restore',
    'command:asset.accept',
  ],
  see: [
    'docs/plans/archive/slot-history-on-the-manifest-row.md',
    'docs/plans/contracts-into-code-and-workflows.md#stage-6-the-constraint-solver-with-stills-as-its-first-family',
  ],
  detail:
    '`pick` reads `current` and never `accepted`: one current row is the take, two resolve to ' +
    'nothing (the slot reads as empty and everything drawn from it becomes unsettled), and a slot ' +
    'with a single row and no current one resolves to that row. `AssetStore.hold(hash, ' +
    'supersede, stamp)` sets `current` on one row and clears it on the takes being replaced in ' +
    'the same manifest write; `heldBy` computes that list from every slot the row serves. It ' +
    'restamps `at` (the hold time) and writes `via` (`run | graph | adopt | promote | upload | ' +
    'migrated`) only where the row has none. `AssetStore.accept(hash)` sets `accepted` alone. ' +
    'Every writer holds: the runners on a clean output and on the last output of a `needs_human` ' +
    'task (the flawed frame stays on screen), adoption, promotion, upload and restore through ' +
    '`adoptSlot`, and the gate and `vngen approve`, which hold and then accept. A run accepts ' +
    'nothing. A re-render leaves the approved take behind as history, `accepted` and not ' +
    'current. Approved, for a plate, sheet or frame, is `assetApproved`: current and accepted. ' +
    'The prerequisite check reads `assetBlessed` (`accepted` alone), because a frame drawn from a ' +
    'plate that was approved and has since been superseded was still drawn from an approved ' +
    'plate. A portrait reads the same two bits. `acceptRefusal` refuses to accept a take its slot ' +
    'does not hold, naming `asset.restore`, which holds and then accepts. A sheet binding written ' +
    'since takes were held carries its `angle`; an older row is told apart from its siblings ' +
    "through its task's inputs (`angleOf`), and a row with neither releases nothing when held, " +
    'since four angles share one binding. `current` is a cache of the task log (`loggedTake`): ' +
    "where a slot's identity is `done`, its `output` is the take; where it is `needs_human`, its " +
    'last output is; otherwise (`pending` after a re-key, `running`, `failed`) the row is ' +
    'authoritative. `repairCurrent` (`@vn/artgen`, re-exported from `@vn/pipeline`) runs on every ' +
    "open and every non-dry run, from the CLI's and `vnauthor`'s project load too: it rewrites " +
    'the bit to what the log says and puts any slot left with two current rows back to one by ' +
    "`overHeld`'s keep rule (a row the kind names, which for a shot is the storyboard's take, " +
    "else the identity's logged output, else the newest `at` or last render, else the lowest " +
    'hash), logged as `manifest.repair`. A clean manifest is not written. Validation is the one ' +
    'project read that skips the repair. `validateProject` (`@vn/gengraph/state`, with its asset ' +
    "half `validateAssets` in `@vn/artgen`) and the desktop's `readProject` open the manifests " +
    'and the task log as they are on disk, so a slot with two current rows is reported rather ' +
    "than fixed. `project.validate` and the agent's `validate_project` write nothing. " +
    '`migrateCurrent` runs first, once per manifest, keyed on a row with no `current` field, and ' +
    "stamps every row: the identity's output, else the last `needs_human` output, else the one " +
    'accepted candidate, else the newest by attempt time then lowest hash, else the sole ' +
    "candidate, with `via: 'migrated'`; every other row gets `current: false`. Logged as " +
    '`manifest.migrate`, naming characters whose approved portrait is no longer the take the ' +
    "slot holds. The row's `at` orders a slot's takes newest first (`newestFirst`, which the " +
    "solver applies to every slot's candidates); rows never stamped sort last, in hash order, and " +
    'no surface may present one of those as the latest. Publishing an unapproved current take is ' +
    'refused; watching one is not. `buildPlayable` projects what each slot holds and asks ' +
    'nothing, so the in-app player shows it; `unapprovedTakes` (`@vn/export`) lists every frame ' +
    'and cast portrait that would show unapproved, and `story.export`, `project.installPages` ' +
    "and `vngen export` refuse on the first of them with one sentence, the command's `check` and " +
    "its `run` (`VnError('UNAPPROVED')`) alike. `vngen accept --hash | --all` and the testkit's " +
    '`acceptAll` accept through `acceptTake`, the same rule `asset.accept` applies.',
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
    '`[[outfit:]]` marker and shot override, and is computed once per facts object. The gate is ' +
    "a separate question: a live scene waits on its cast's portraits (`gate.perUnit`), so an " +
    "uncast character's unapproved portrait halts nothing and shows in the document tree's " +
    'Awaiting approval branch.',
});

export const gatePerUnit = contract({
  id      : 'gate.perUnit',
  rule: "A live scene is not decomposed, and none of its slots is ready, until every character in `scene.characters` has an approved portrait: a portrait row that is both current and accepted. The solver applies it per unit; the stills family lists the cast's portraits.",
  prevents:
    'Paying to decompose and draw a scene whose cast may still change, including cast members no shot shows, or drawing from a re-rendered portrait nobody accepted.',
  subjects: [
    'function:packages/stills/src/family.ts#stillsFamily',
    'function:packages/stills/src/family.ts#gateStatus',
    'function:packages/stills/src/gate.ts#approvedPortraitOf',
    'function:packages/constraint-solver/src/solve.ts#unitGates',
    'function:packages/pipeline/src/planner.ts#planTasks',
    'task:shot_image',
    'command:gate.approve',
    'command:gate.lock',
  ],
  see: [
    'docs/plans/contracts-into-code-and-workflows.md#stage-6-the-constraint-solver-with-stills-as-its-first-family',
    'docs/plans/archive/slot-history-on-the-manifest-row.md',
  ],
  detail:
    'The gate is not a task dependency. A scene is a unit, its shots are its slots, and ' +
    "`Family.gates` lists the portraits of the scene's cast; `Solution.units` and " +
    '`SlotState.ready` report it, and the planner decomposes only open units and adds only ' +
    'ready slots. A scene with no cast is never held, and a cast member with no character sheet ' +
    "holds it. A portrait clears through its kind's `clears`, which asks " +
    '`approvedPortraitOf(character, assets)`. A re-render puts an unapproved draft in the slot, ' +
    'so the gate closes until the author accepts the draft or restores the approved take; ' +
    'nothing already drawn is touched. The sheet is a mirror: `AssetStore.accept` on the ' +
    'portrait a slot holds writes `status: approved`, `approved_portrait:` and `approved.png`, ' +
    'and `unaccept` clears them when the sheet names that hash. A reader with no manifest (a pure ' +
    'plan) reads the mirror, which is valid because nothing else writes it; `repairCurrent` ' +
    'catches up a sheet an older tool approved by hand. `status: locked` (`gate.lock`) holds the ' +
    'approval at the hash the sheet names, whatever the slot holds. `vngen run` halts at the ' +
    'gate with nothing ready; `gate.approve` and `vngen approve` hold the chosen portrait and ' +
    'accept it, and choosing an older draft is a restore that `holdPortrait` logs, so the choice ' +
    "outlasts `repairCurrent`. `gateStatus` reports the same units: a live scene's cast member " +
    "is pending until their portrait clears. The portrait slot's `approved` " +
    '(`takes.approvedMeansAccepted`) differs from `clears` in four cases: a portrait whose only ' +
    'row is accepted but not current is approved and does not clear; with no manifest the slot ' +
    'holds no row and is not approved, while the gate reads the mirror; a locked character ' +
    'clears whatever the slot holds; and a slot holding two current rows picks neither and is ' +
    'not approved, while the gate clears if either is accepted.',
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
    candidates: (binding, facts) => candidatesFor(binding, bindingCtx(binding, facts)),
    approved  : heldAccepted,
  };
}

/** Each facts object's shot images, which every shot slot's `named` answers with. */
const images = new WeakMap<StillsFacts, Set<string>>();

/** Lists the image of every shot in the production map, once per facts object. */
function shotImages(_binding: Bound<'shot'>, facts: StillsFacts): ReadonlySet<string> {
  let named = images.get(facts);
  if (!named) {
    named = new Set();
    for (const board of facts.model.production.values())
      for (const shot of board.shots) if (shot.image) named.add(shot.image);
    images.set(facts, named);
  }
  return named;
}

/**
 * Says whether a character's portrait opens the scenes that cast them, by the gate's own reading:
 * `approvedPortraitOf` over the rows that name the character, or over the sheet's mirror when the
 * facts carry no manifest.
 */
function portraitClears(binding: Bound<'portrait'>, facts: StillsFacts): boolean {
  const character = facts.model.characters.get(binding.characterId);
  if (!character) return false;
  const rows = facts.assets && bindingCtx(binding, facts).assets;
  return approvedPortraitOf(character, rows) !== undefined;
}

const EVERY_KIND = [identitySlotsBeforeTasks, takesApprovedMeansAccepted, takesCurrencyExclusive];
const AUTHORED = [...EVERY_KIND, planningSheetsOnlyWhenWorn];

export const plateKind = stillsKind('plate', 'location_ref', AUTHORED);
export const portraitKind: SlotKind<StillsFacts, Bound<'portrait'>, 'portrait'> = {
  ...stillsKind('portrait', 'portrait', [...AUTHORED, gatePerUnit]),
  clears: portraitClears,
};
export const sheetKind = stillsKind('sheet', 'model_sheet', AUTHORED);
export const shotKind: SlotKind<StillsFacts, Bound<'shot'>, 'shot_image'> = {
  ...stillsKind('shot', 'shot_image', [...EVERY_KIND, gatePerUnit]),
  named: shotImages,
};

/** Pairs a binding with the kind its prefix names. */
function slotFor(binding: Bound<SlotPrefix>): Slot<StillsFacts> {
  switch (binding.kind) {
    case 'plate':
      return slot(plateKind, binding);
    case 'portrait':
      return slot(portraitKind, binding);
    case 'sheet':
      return slot(sheetKind, binding);
    case 'shot':
      return slot(shotKind, binding);
  }
}

const short = (hash: string): string => hash.slice(0, 8);

/** Answers the take a binding names, reading only the rows grouped under its slot's subject. */
function takeOf(binding: RefBinding, facts: StillsFacts): string | undefined {
  const ctx = binding.kind === 'asset' ? { ...facts, assets: [] } : bindingCtx(binding, facts);
  return resolveBinding(binding, ctx);
}

/**
 * Answers what a row was drawn from: its task's references, then the pins an author attached on
 * clauses that are not muted. The first attached pin whose slot now holds another take is named.
 */
function drawnFrom(row: Asset, facts: StillsFacts): DrawnFrom {
  const attached = attachedRefs(row, facts);
  const refs = [...row.refs, ...attached.map(({ ref }) => ref.pin)];
  for (const { chunk, ref } of attached) {
    if (!ref.from) continue;
    const now = takeOf(ref.from, facts);
    if (now === undefined || now === ref.pin) continue;
    return {
      refs,
      moved:
        `its "${chunk}" reference to ${slotLabel(ref.from)} has moved — ` +
        `pinned ${short(ref.pin)}, now ${short(now)}`,
    };
  }
  return { refs };
}

/** Answers the slot a row's first binding names; a sheet row's angle may come off its task. */
function filledBy(row: Asset, facts: StillsFacts): Slot<StillsFacts> | undefined {
  const binding = slotOf(row, sheetAngleOf(row, facts));
  return binding && binding.kind !== 'asset' ? slotFor(binding) : undefined;
}

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

  for (const [characterId, outfits] of wardrobe(facts))
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

/** Lists the portraits a scene waits on: one per member of its cast, shown in a shot or not. */
function gates(sceneId: string, facts: StillsFacts): string[] {
  const scene = facts.model.scenes.get(sceneId);
  return (scene?.characters ?? []).map((characterId) => slotKey({ kind: 'portrait', characterId }));
}

export const stillsFamily: Family<StillsFacts> = {
  id   : 'stills',
  kinds: [plateKind, portraitKind, sheetKind, shotKind],
  enumerate,
  owed,
  gates,
  kept: (facts) => keptSlots(facts.model).flatMap((b) => (b.kind === 'asset' ? [] : [slotFor(b)])),
  slotOf: filledBy,
  drawnFrom,
};

/** The character-approval gate (report §P3): who is still holding a live scene back. */
export interface GateStatus {
  /** Characters a live scene casts whose portrait has not cleared. */
  pending: string[];
  /** Characters a live scene casts whose portrait has cleared. */
  approved: string[];
  /** No live scene is held. */
  cleared: boolean;
}

const NO_TASKS: StillsFacts['tasks'] = { get: () => undefined };

/** Reads the character id back out of a portrait address, whatever characters the id holds. */
const castMember = (key: string): string => key.slice(key.indexOf(':') + 1);

/**
 * Answers the gate from `unitGates(stillsFamily, …)` over every live scene, so a character no live
 * scene casts never appears. Reads no config and no task log, which the gate never needs.
 */
export function gateStatus(model: ProjectModel, assets?: readonly Asset[]): GateStatus {
  const pending = new Set<string>();
  const approved = new Set<string>();
  for (const unit of unitGates(stillsFamily, { model, assets, tasks: NO_TASKS }).values()) {
    for (const key of unit.gates)
      (unit.holding.includes(key) ? pending : approved).add(castMember(key));
  }
  return {
    pending : [...pending].sort(),
    approved: [...approved].sort(),
    cleared : pending.size === 0,
  };
}

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

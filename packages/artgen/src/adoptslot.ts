/**
 * Records bytes as a slot's output, so the slot becomes that picture rather than a pointer to it
 * (`docs/plans/archive/INDEX.md#adopting-an-uploaded-asset`).
 *
 * This generalizes `promoteConcept`, which performed the same act with one slot kind hard-coded. A
 * slot is a `RefBinding`, the same address used by the reference graph, the cycle refusal and
 * `prompt.addRef`, so there is no second way here to say which picture is meant.
 *
 * `adopt`'s safety property still holds: the task's inputs are derived here from the project as it
 * stands and handed over as inputs rather than as a remembered hash, so an adoption cannot mark
 * done a task the project no longer describes.
 *
 * An interactive graph run files what it drew through the same writes ({@link fileGraphDraw}), so
 * a picture becomes a slot's take in one place whether an author brought it or a graph drew it.
 */
import type {
  Asset,
  AssetBinding,
  AssetRef,
  ProjectModel,
  RefBinding,
  Scene,
  Shot,
  TakeVia,
  TaskGraph,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { modelFromInputs } from '@vn/model';
import { loadInputs, readShots, writeShots, type AssetStore, type ProjectPaths } from '@vn/store';
import { loadGraph } from '@vn/taskgraph';
import { isPlaceholderImage } from '@vn/providers';
import { VnError } from '@vn/util';
import { proseHash } from './drift.js';
import { adopt } from './adopt.js';
import { baseRefusal } from './base.js';
import { slotLabel } from './slotaddr.js';
import { type Decided, type ResolvedSlot, heldBy, resolveSlot, slotTaskHash } from './slotgraph.js';
import { angleOfTask } from './takes.js';

export interface AdoptSlotDeps {
  config: ProjectConfig;
  paths: ProjectPaths;
  store: AssetStore;
  /** Injected clock for the hold's `at` and the attempt's; a caller without one stamps neither. */
  now?: () => string;
}

/** How adopted bytes entered the slot. A restore is recorded on the attempt, never on the row. */
export type AdoptVia = Extract<TakeVia, 'adopt' | 'promote' | 'upload'> | 'restore';

export interface AdoptSlotRequest {
  /** The asset whose bytes become the slot's output. Already in the store. */
  hash: string;
  /** Which picture in the project this is — `plate:cafe/night`, as `parseSlot` reads it. */
  slot: RefBinding;
  /** Supersede the render already holding this slot. See `AdoptRequest.replace`. */
  replace?: boolean;
  /** How the bytes came to be adopted. Stamped on the row by the first hold; see `TakeVia`. */
  via: AdoptVia;
  /**
   * The bytes, for a decision made before they are filed — an upload that names a slot has to hear
   * the refusal at the picker rather than after the copy. Ignored once the store holds the hash,
   * and never used by {@link adoptSlot}, which adopts what is in the store.
   */
  bytes?: Uint8Array;
  /**
   * Record the prompt these bytes already carry rather than the slot's current one.
   *
   * For an upload the slot's prompt is the only one there is. For a render being put back in a
   * slot a later render took over, stamping today's prompt would claim the picture was drawn from
   * words written after it, and drift would then report none. Ignored for an asset carrying no
   * prompt of its own.
   */
  keepPrompt?: boolean;
}

/**
 * The three slots a picture can be adopted onto. A portrait is approved at the gate instead, and an
 * `asset` binding names a hash rather than a slot.
 */
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

export interface AdoptSlotResult {
  ref: AssetRef;
  plan: AdoptSlotPlan;
}

/** The storyboard entry a shot adoption stamps: `serialize` drops `proseHash` without the image. */
interface ShotStamp {
  scene: Scene;
  shot: Shot;
  shots: Shot[];
}

/**
 * A slot resolved against the project. Carries the task the slot names, the model it was resolved
 * against, and for a shot the frame to stamp.
 *
 * {@link resolveSlot} supplies the identity half, so adoption and the slot graph cannot disagree
 * about what task a picture is. The stamp belongs to the filing alone: nothing else rewrites the
 * storyboard.
 */
type Resolved = { model: ProjectModel } & (
  | { slot: Exclude<ResolvedSlot, { kind: 'shot_image' }>; stamp?: undefined }
  | { slot: Extract<ResolvedSlot, { kind: 'shot_image' }>; stamp: ShotStamp }
);

/** A resolved slot adoption may hand bytes to: any kind but a portrait, which the gate owns. */
type Adoptable = Resolved & { slot: Exclude<ResolvedSlot, { kind: 'portrait' }> };

/** The manifest binding a slot writes, with a sheet's angle so the row alone says which sheet it is. */
function bindingOf(slot: RefBinding): AssetBinding {
  switch (slot.kind) {
    case 'portrait':
      return { characterId: slot.characterId };
    case 'sheet':
      return { characterId: slot.characterId, outfit: slot.outfit, angle: slot.angle };
    case 'plate':
      return { locationId: slot.locationId, variant: slot.variant };
    case 'shot':
      return { sceneId: slot.sceneId, shotId: slot.shotId };
    default:
      return {};
  }
}

/**
 * Resolve a slot against the project as loaded. {@link resolveSlot} decides identity; this function
 * does the loading — the model, and for a shot the storyboard the frame will be stamped into.
 */
async function resolve(
  deps: AdoptSlotDeps,
  slot: RefBinding,
  graph: TaskGraph,
): Promise<Decided<Resolved>> {
  const inputs = await loadInputs(deps.paths);
  const model = modelFromInputs(inputs, {
    title: deps.config.title,
    ...(deps.config.start ? { start: deps.config.start } : {}),
  });

  // A shot's frame is stamped where the scene was decomposed, so this loads the storyboard and
  // passes it to `resolveSlot` too, which needs the same shots to compute the frame's identity.
  const shots = new Map<string, readonly Shot[]>();
  let stamp: ShotStamp | undefined;
  if (slot.kind === 'shot') {
    const scene = model.scenes.get(slot.sceneId);
    if (scene) {
      const loaded = await readShots(deps.paths, scene.id, new Set(scene.lines.map((l) => l.id)));
      if (loaded) {
        shots.set(scene.id, loaded.shots);
        const shot = loaded.shots.find((s) => s.id === slot.shotId);
        if (shot) stamp = { scene, shot, shots: loaded.shots };
      }
    }
  }

  const decided = resolveSlot(slot, { model, shots, config: deps.config, graph });
  if (!decided.ok) return decided;
  const plan = decided.plan;
  if (plan.kind === 'shot_image') {
    // Unreachable: `resolveSlot` found the same shot in the same map, so a stamp was taken.
    if (!stamp)
      return { ok: false, code: 'NO_SUCH_SLOT', reason: `No such shot: ${slotLabel(slot)}.` };
    return { ok: true, plan: { model, slot: plan, stamp } };
  }
  return { ok: true, plan: { model, slot: plan } };
}

/**
 * Every refusal an adoption can give, and the record it would write. {@link adoptSlot} calls this
 * again rather than trusting an earlier answer, so a check that has gone stale cannot let an
 * adoption through.
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
      ok    : false,
      code  : 'MOCK_PLACEHOLDER',
      reason: `Asset ${short} is a placeholder from a mock run, and mock art never becomes real output.`,
    };
  }

  const graph = await loadGraph(deps.paths);
  const resolved = await resolve(deps, req.slot, graph);
  if (!resolved.ok) return resolved;
  const adoptable = gated(resolved.plan);
  if (!adoptable.ok) return adoptable;

  const label = slotLabel(req.slot);
  const taskHash = slotTaskHash(resolved.plan.slot);
  const held = heldRender(graph, taskHash, req.hash);
  if (held && !req.replace) {
    return {
      ok    : false,
      code  : 'ALREADY_RENDERED',
      reason: `The ${label} is already the render ${held.slice(0, 8)}, and nothing about it has changed — adopting ${short} would replace real work. Adopt with replace to supersede it; the old bytes stay in the store.`,
    };
  }
  return {
    ok  : true,
    plan: {
      kind: adoptable.plan.slot.kind,
      taskHash,
      label,
      ...(held ? { supersedes: held } : {}),
      note: held
        ? `Would make ${short} the ${label}, superseding the render ${held.slice(0, 8)}. The old bytes stay in the store.`
        : `Would make ${short} the ${label}, so the next run adopts it instead of rendering one.`,
    },
  };
}

/** How a filing enters the log and the row. */
interface Filing {
  via: TakeVia | 'restore';
  replace: boolean;
  /** Keep the prompt the row already carries over the slot's current one; see `AdoptSlotRequest`. */
  keepPrompt: boolean;
}

/**
 * The gate's refusal for a portrait slot. A portrait is a real task, but not one a picture may be
 * handed to: approving a portrait is the gate's act, and it releases scenes.
 */
function gated(resolved: Resolved): Decided<Adoptable> {
  if (resolved.slot.kind === 'portrait') {
    return {
      ok    : false,
      code  : 'GATED_SLOT',
      reason: `A portrait is not adopted: approving one writes ${resolved.slot.inputs.characterId}'s sheet and releases every scene they are in. Use gate.approve.`,
    };
  }
  return { ok: true, plan: resolved as Adoptable };
}

/** The render already logged as the task's output, when it is a different picture. */
function heldRender(graph: TaskGraph, taskHash: string, hash: string): string | undefined {
  const node = graph.get(taskHash);
  return node?.status === 'done' && node.output !== hash ? node.output : undefined;
}

/** Write the `done` record through `adopt`, so `adopt` stays the only guard on that write. */
async function record(
  deps: AdoptSlotDeps,
  slot: Resolved['slot'],
  output: Asset,
  filing: Filing,
  graph: TaskGraph,
): Promise<void> {
  const ctx = { has: (h: string) => deps.store.has(h), node: (h: string) => graph.get(h) };
  const at = deps.now?.();
  const flag = {
    ...(filing.replace ? { replace: true } : {}),
    via: filing.via,
    ...(at === undefined ? {} : { at }),
  };
  // Spelled out per kind because `adopt` is generic: only a narrowed pair type-checks.
  const done = await (slot.kind === 'location_ref'
    ? adopt(deps.paths, { kind: slot.kind, inputs: slot.inputs, output, ...flag }, ctx)
    : slot.kind === 'model_sheet'
      ? adopt(deps.paths, { kind: slot.kind, inputs: slot.inputs, output, ...flag }, ctx)
      : slot.kind === 'portrait'
        ? adopt(deps.paths, { kind: slot.kind, inputs: slot.inputs, output, ...flag }, ctx)
        : adopt(deps.paths, { kind: slot.kind, inputs: slot.inputs, output, ...flag }, ctx));
  if (!done.ok) throw new VnError(done.code, done.reason);
}

/**
 * The writes that make bytes already in the store a slot's take, each depending on the last: the
 * bytes are re-recorded under the slot's kind — which is what routes them to the right root — the
 * row is held as the slot's current take, a shot slot's frame is stamped into `work/shots/`, and
 * the task identity is logged `done`. That last one is the mechanism: `loadGraph` replays the
 * record, `TaskGraph.add` returns the existing `done` node, and `ready()` skips it.
 *
 * Nothing is accepted here. A filing says "this is that task's output", not "a human approved it".
 */
async function file(
  deps: AdoptSlotDeps,
  resolved: Resolved,
  asset: Asset,
  taskHash: string,
  slot: RefBinding,
  filing: Filing,
  graph: TaskGraph,
): Promise<AssetRef> {
  const bytes = await deps.store.read({ hash: asset.hash, ext: asset.ext });
  const ref = await deps.store.write(bytes, asset.ext, {
    kind      : resolved.slot.kind,
    sourceTask: taskHash,
    prompt:
      filing.keepPrompt && asset.prompt !== undefined ? asset.prompt : resolved.slot.inputs.prompt,
    refs      : resolved.slot.inputs.refs.map((r) => r.hash),
    modelId   : asset.modelId,
    // `mergeBindings` keeps what the bytes already served, so the tree still shows where an adopted
    // picture came from — the same thing promotion has always done.
    satisfies : bindingOf(slot),
  });

  // The hold releases the slot's other takes; `via` lands only on a row that has none, so a
  // restored take keeps saying where its bytes came from
  const held = deps.store.manifest().find((a) => a.hash === ref.hash)!;
  const at = deps.now?.();
  await deps.store.hold(
    ref.hash,
    heldBy(held, {
      model  : resolved.model,
      assets : deps.store.manifest(),
      angleOf: angleOfTask(graph),
    }),
    {
      ...(at === undefined ? {} : { at }),
      ...(filing.via === 'restore' ? {} : { via: filing.via }),
    },
  );

  // A stamp is taken for a shot slot and no other, so this is that branch.
  if (resolved.stamp) {
    // `proseHash` is stamped beside the image, so a frame handed in by an artist reports drift
    // against the lines it was drawn from exactly as a rendered one does
    const { scene, shot, shots } = resolved.stamp;
    shot.image = ref.hash;
    shot.proseHash = proseHash(scene, shot.coversLines);
    await writeShots(deps.paths, scene.id, shots);
  }

  const written = deps.store.manifest().find((a) => a.hash === ref.hash)!;
  await record(deps, resolved.slot, written, filing, graph);
  return ref;
}

/**
 * Record bytes already in the store as a slot's output, through {@link file}. Adoption says "this
 * is that task's output", not "a human approved it".
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

  const ref = await file(
    deps,
    resolved.plan,
    asset,
    decided.plan.taskHash,
    req.slot,
    { via: req.via, replace: req.replace === true, keepPrompt: req.keepPrompt === true },
    graph,
  );
  return { ref, plan: decided.plan };
}

/** A picture an interactive graph run terminated on, as the executor hands it back. */
export interface GraphDrawRequest {
  bytes: Uint8Array;
  ext: string;
  /** The slot the run's output binds. */
  slot: RefBinding;
  /** What the node that drew it reports; empty when the graph read the picture rather than drew it. */
  prompt: string;
  modelId: string;
}

/** What filing a graph draw did: the row written, and the render it superseded, if any. */
export interface GraphDrawFiled {
  ref: AssetRef;
  taskHash: string;
  label: string;
  supersedes?: string;
}

/**
 * Files what an interactive graph run drew as the take of the slot its output binds, with
 * `via: 'graph'`. The same writes as adoption, with two differences: the bytes come from the
 * executor rather than the store, and the author asked for this draw, so it supersedes whatever
 * the slot held without a `replace` question. A portrait is filed too — it is a draft for the
 * gate, exactly as a scheduled portrait draw is — and mock-marked bytes are refused by name, so
 * a mock run stays journal-only however it is called.
 */
export async function fileGraphDraw(
  deps: AdoptSlotDeps,
  req: GraphDrawRequest,
): Promise<Decided<GraphDrawFiled>> {
  const refusal = baseRefusal(deps.store.base);
  if (refusal) return { ok: false, code: 'BASE_UNAVAILABLE', reason: refusal };
  if (isPlaceholderImage(req.bytes)) {
    return {
      ok    : false,
      code  : 'MOCK_PLACEHOLDER',
      reason:
        'The graph drew a placeholder from a mock run, and mock art never becomes real output.',
    };
  }

  const graph = await loadGraph(deps.paths);
  const resolved = await resolve(deps, req.slot, graph);
  if (!resolved.ok) return resolved;
  const taskHash = slotTaskHash(resolved.plan.slot);
  const label = slotLabel(req.slot);

  // Written once here with the drawing's own provenance, then re-recorded by `file` under the
  // slot's identity; the two writes share a hash, so the manifest holds one row.
  const inputs = resolved.plan.slot.inputs;
  const drawn = await deps.store.write(req.bytes, req.ext, {
    kind      : resolved.plan.slot.kind,
    sourceTask: taskHash,
    prompt    : req.prompt.length > 0 ? req.prompt : inputs.prompt,
    refs      : inputs.refs.map((r) => r.hash),
    modelId   : req.modelId,
    satisfies : bindingOf(req.slot),
  });
  const asset = deps.store.manifest().find((a) => a.hash === drawn.hash)!;
  const supersedes = heldRender(graph, taskHash, drawn.hash);
  const ref = await file(
    deps,
    resolved.plan,
    asset,
    taskHash,
    req.slot,
    { via: 'graph', replace: true, keepPrompt: true },
    graph,
  );
  return {
    ok  : true,
    plan: { ref, taskHash, label, ...(supersedes === undefined ? {} : { supersedes }) },
  };
}

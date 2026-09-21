/**
 * `current` as a cache of the task log, kept true by two passes every host runs.
 *
 * Where a slot's identity is `done`, its `output` is the take the slot holds and the row bit is
 * rewritten to match; where it is `needs_human`, its last output is. Otherwise (`pending` after a
 * re-key, `running`, `failed`) the row is authoritative, because that is the window an author's
 * old take is kept on screen through. The planner never reads `current`; it keys downstream tasks
 * on `doneOutput` as it always has.
 *
 * The migration runs once per manifest, keyed on a row that predates the bit, and stamps every
 * row so it runs once. It lives here rather than in `@vn/pipeline` because `vnauthor` may not
 * import the pipeline and has to run it too.
 */
import type {
  AnyTask,
  Asset,
  AssetStore,
  Logger,
  ProjectModel,
  RefBinding,
  Shot,
  TaskGraph,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { AssetStore as DiskStore, readAllShots, type ProjectPaths } from '@vn/store';
import { loadGraph } from '@vn/taskgraph';
import { candidatesFor } from './refs.js';
import { assetSlotLabel } from './describe.js';
import { lastRenderedAt, overHeld, type OverHeld, type OverHeldContext } from './overheld.js';
import { acceptRefusal, assetApproved, type PrereqContext } from './prereq.js';
import {
  buildSlotGraph,
  newestFirst,
  resolveSlot,
  slotTaskHash,
  type SlotGraphContext,
} from './slotgraph.js';

export interface TakeDeps {
  model: ProjectModel;
  config: ProjectConfig;
  store: AssetStore;
  graph: TaskGraph;
  /** Every scene's persisted storyboard: a shot slot's identity and its named take both read it. */
  shots: ReadonlyMap<string, readonly Shot[] | null>;
  logger?: Logger;
}

/**
 * Opens the repair's inputs from disk, for a host that holds only the model and the paths. The
 * desktop session and the scheduler already hold every one of these and build the deps directly.
 */
export async function openTakeDeps(
  paths: ProjectPaths,
  model: ProjectModel,
  config: ProjectConfig,
  logger?: Logger,
): Promise<TakeDeps & { store: DiskStore }> {
  const [store, graph, shots] = await Promise.all([
    DiskStore.open(paths),
    loadGraph(paths),
    readAllShots(paths, model),
  ]);
  return { model, config, store, graph, shots, ...(logger ? { logger } : {}) };
}

/** What the migration decided, for the log and for a host that wants to say what moved. */
export interface Migration {
  /** Slots that now hold a take, with the hash each holds. */
  held: Record<string, string>;
  /** Characters whose approved portrait is no longer the take the slot holds. */
  unapprovedPortraits: string[];
}

/** The angle a sheet task was for, off the task log. */
export function angleOfTask(graph: {
  get(hash: string): AnyTask | undefined;
}): (sourceTask: string | undefined) => string | undefined {
  return (sourceTask) => {
    const task = sourceTask === undefined ? undefined : graph.get(sourceTask);
    return task && 'angle' in task.inputs ? task.inputs.angle : undefined;
  };
}

/** The take the log says a slot holds, or `undefined` where the row is authoritative. */
function logged(task: AnyTask | undefined): string | undefined {
  if (!task) return undefined;
  if (task.status === 'done') return task.output;
  if (task.status === 'needs_human') return task.output ?? task.attempts.at(-1)?.output;
  return undefined;
}

function contextOf(deps: TakeDeps): SlotGraphContext {
  return {
    model  : deps.model,
    config : deps.config,
    graph  : deps.graph,
    shots  : deps.shots,
    assets : deps.store.manifest(),
    angleOf: angleOfTask(deps.graph),
  };
}

const isSheet = (asset: Asset): boolean =>
  asset.kind === 'model_sheet' || asset.kind === 'outfit_sheet';

/**
 * Stamps `current` onto a manifest written before takes were held, once. For every slot the graph
 * enumerates, upstream first, the current row is the identity's output when its task is `done`,
 * else its last output when `needs_human`, else the one accepted candidate, else the most recently
 * rendered candidate (then the lowest hash), else the sole candidate. A row bound to two slots is
 * decided by the first slot that names it. Sheet bindings are backfilled with the angle their task
 * recorded. Every other row gets `current: false`, which is what makes this one-shot.
 */
export async function migrateCurrent(deps: TakeDeps): Promise<Migration | undefined> {
  if (!deps.store.unstamped) return undefined;
  const ctx = contextOf(deps);
  const slots = buildSlotGraph(ctx);
  const renderedAt = lastRenderedAt(deps.graph);
  const chosen = new Map<string, string | undefined>();
  const held: Record<string, string> = {};

  for (const key of slots.order) {
    const node = slots.nodes.get(key)!;
    const candidates = candidatesFor(node.binding, ctx);
    const already = candidates.find((a) => chosen.has(a.hash));
    if (already) {
      held[key] = already.hash;
      continue;
    }
    const task = node.taskHash ? deps.graph.get(node.taskHash) : undefined;
    const pick = migrationPick(candidates, logged(task), renderedAt);
    if (!pick) continue;
    chosen.set(pick.hash, renderedAt(pick.sourceTask));
    held[key] = pick.hash;
  }

  const angleOf = angleOfTask(deps.graph);
  await deps.store.migrateTakes((row) => {
    const at = chosen.get(row.hash);
    const angle = isSheet(row) ? angleOf(row.sourceTask) : undefined;
    return {
      current: chosen.has(row.hash),
      ...(chosen.has(row.hash) ? { via: 'migrated' as const } : {}),
      ...(at === undefined ? {} : { at }),
      ...(angle === undefined ? {} : { angle }),
    };
  });

  const unapprovedPortraits = [...deps.model.characters.values()]
    .filter((c) => {
      const now = held[`portrait:${c.id}`];
      return c.approvedPortrait !== undefined && now !== undefined && now !== c.approvedPortrait;
    })
    .map((c) => c.id);
  const report = { held, unapprovedPortraits };
  deps.logger?.info('manifest.migrate', {
    slots: Object.keys(held).length,
    unapprovedPortraits,
  });
  return report;
}

/** The migration's arms, in order. `renderedAt` orders candidates no row stamp can. */
function migrationPick(
  candidates: readonly Asset[],
  fromLog: string | undefined,
  renderedAt: (sourceTask: string) => string | undefined,
): Asset | undefined {
  const logged = fromLog === undefined ? undefined : candidates.find((a) => a.hash === fromLog);
  if (logged) return logged;
  const accepted = candidates.filter((a) => a.accepted);
  if (accepted.length === 1) return accepted[0];
  if (candidates.length <= 1) return candidates[0];
  const stamped = candidates.map((a) => ({ ...a, at: a.at ?? renderedAt(a.sourceTask) }));
  return newestFirst(stamped)[0];
}

/**
 * Rewrites `current` to what the task log says, and puts any slot left with two current rows
 * back to one. Repeating the repair changes nothing, and a clean manifest is not written. The
 * migration runs first when the manifest is owed one.
 */
export async function repairCurrent(deps: TakeDeps): Promise<OverHeld[]> {
  await migrateCurrent(deps);
  const ctx = contextOf(deps);
  const slots = buildSlotGraph(ctx);
  const byHash = new Map(ctx.assets.map((a) => [a.hash, a]));
  const fixes: OverHeld[] = [];

  for (const key of slots.order) {
    const node = slots.nodes.get(key)!;
    const wanted = logged(node.taskHash ? deps.graph.get(node.taskHash) : undefined);
    if (wanted === undefined || !node.candidates.includes(wanted)) continue;
    const current = node.candidates.filter((h) => byHash.get(h)?.current);
    if (current.length === 1 && current[0] === wanted) continue;
    const drop = current.filter((h) => h !== wanted);
    await deps.store.hold(wanted, drop);
    fixes.push({ slot: key, keep: wanted, drop });
  }

  const identityOutput = (slot: RefBinding): string | undefined => {
    const decided = resolveSlot(slot, ctx);
    return decided.ok ? logged(deps.graph.get(slotTaskHash(decided.plan))) : undefined;
  };
  // Read again, because the holds above changed which rows are current
  const rest: OverHeldContext = {
    ...ctx,
    assets: deps.store.manifest(),
    identityOutput,
    renderedAt: lastRenderedAt(deps.graph),
  };
  for (const fix of overHeld(rest)) {
    await deps.store.hold(fix.keep, fix.drop);
    fixes.push(fix);
  }
  fixes.push(...(await catchUpMirrors(deps)));

  for (const fix of fixes) deps.logger?.info('manifest.repair', { ...fix });
  return fixes;
}

/**
 * A sheet that says `approved` with a hash no portrait row of the character has caught up with
 * was written by an older tool, straight into the file. The row is the authority now, so the
 * sheet's hash is held and accepted to match — once, since an accepted row of the slot is what
 * the next pass finds. A slot with an accepted row is left alone whatever the sheet names.
 */
async function catchUpMirrors(deps: TakeDeps): Promise<OverHeld[]> {
  const fixes: OverHeld[] = [];
  for (const character of deps.model.characters.values()) {
    const hash = character.approvedPortrait;
    if (hash === undefined) continue;
    if (character.status !== 'approved' && character.status !== 'locked') continue;
    const rows = candidatesFor({ kind: 'portrait', characterId: character.id }, contextOf(deps));
    if (rows.some((a) => a.accepted) || !rows.some((a) => a.hash === hash)) continue;
    const drop = rows.filter((a) => a.current && a.hash !== hash).map((a) => a.hash);
    await deps.store.hold(hash, drop);
    await deps.store.accept(hash);
    fixes.push({ slot: `portrait:${character.id}`, keep: hash, drop });
  }
  return fixes;
}

/** One current take a person could accept, with the refusal it would meet today. */
export interface Acceptable {
  hash: string;
  /** What it is, in the project's own terms — `cafe — night plate`. */
  label: string;
  /** The slot it holds, as `slotKey` spells it. */
  slot: string;
  /** Why accepting it would be refused right now — a prerequisite not yet approved. */
  refusal?: string;
}

function prereqContextOf(deps: TakeDeps): PrereqContext {
  return {
    model  : deps.model,
    assets : deps.store.manifest(),
    angleOf: angleOfTask(deps.graph),
    shots  : deps.shots,
  };
}

/**
 * Every current take nobody has approved, upstream first, so accepting them in this order lets
 * one pass finish a whole chain. Portraits are left out: their approval is the gate's. Rows the
 * gate or `approvable` would list are the same rows, since both walk the slot graph.
 */
export function acceptableTakes(deps: TakeDeps): Acceptable[] {
  const ctx = contextOf(deps);
  const prereqs = prereqContextOf(deps);
  const byHash = new Map(ctx.assets.map((a) => [a.hash, a]));
  const out: Acceptable[] = [];
  const seen = new Set<string>();
  const slots = buildSlotGraph(ctx);
  for (const key of slots.order) {
    if (key.startsWith('portrait:')) continue;
    const node = slots.nodes.get(key)!;
    for (const hash of node.candidates) {
      const asset = byHash.get(hash);
      if (!asset?.current || seen.has(hash) || assetApproved(asset)) continue;
      seen.add(hash);
      const label = assetSlotLabel(asset);
      const refusal = acceptRefusal(asset, label, prereqs);
      out.push({ hash, label, slot: key, ...(refusal === undefined ? {} : { refusal }) });
    }
  }
  return out;
}

/**
 * Accepts one non-portrait take through the rule every host applies: refused for a portrait (the
 * gate's), a concept or an upload (nothing to bless), a take its slot no longer holds (naming
 * `asset.restore`), and one drawn from something not yet approved.
 */
export async function acceptTake(
  deps: TakeDeps,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const asset = deps.store.manifest().find((a) => a.hash === hash);
  if (!asset) return { ok: false, message: `No asset ${hash} in the manifest.` };
  const label = assetSlotLabel(asset);
  if (asset.kind === 'portrait') {
    return {
      ok     : false,
      message: `${label} is a portrait; approving one is the gate's, not accept's.`,
    };
  }
  if (asset.kind === 'concept' || asset.kind === 'reference') {
    return {
      ok     : false,
      message: `${label} is a ${asset.kind}; nothing generated it, so there is nothing to accept.`,
    };
  }
  const refusal = acceptRefusal(asset, label, prereqContextOf(deps));
  if (refusal !== undefined) return { ok: false, message: refusal };
  if (assetApproved(asset)) return { ok: true, message: `${label} is already accepted.` };
  await deps.store.accept(hash);
  return { ok: true, message: `Accepted ${label} (${hash.slice(0, 8)}).` };
}

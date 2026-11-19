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
import type { Asset, AssetStore, Logger, ProjectModel, RefBinding, TaskGraph } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { AssetStore as DiskStore, withProduction, type ProjectPaths } from '@vn/store';
import { loadGraph } from '@vn/taskgraph';
import {
  acceptRefusal,
  angleOfTask,
  assetApproved,
  assetSlotLabel,
  candidatesFor,
  stillsFamily,
  type PlanFacts,
  type PrereqContext,
  type StillsFacts,
} from '@vn/stills';
import {
  lastRenderedAt,
  loggedTake,
  newestFirst,
  overHeld,
  solve,
  type OverHeld,
} from '@vn/constraint-solver';

export interface TakeDeps {
  /**
   * The model, with every persisted storyboard in its production map: a shot slot's identity and
   * its named take both read it.
   */
  model: ProjectModel;
  config: ProjectConfig;
  store: AssetStore;
  graph: TaskGraph;
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
  const [store, graph, withShots] = await Promise.all([
    DiskStore.open(paths),
    loadGraph(paths),
    withProduction(paths, model),
  ]);
  return { model: withShots, config, store, graph, ...(logger ? { logger } : {}) };
}

/** What the migration decided, for the log and for a host that wants to say what moved. */
export interface Migration {
  /** Slots that now hold a take, with the hash each holds. */
  held: Record<string, string>;
  /** Characters whose approved portrait is no longer the take the slot holds. */
  unapprovedPortraits: string[];
}

/**
 * Builds the facts this module solves the stills family over: the model, the config, the task log,
 * the manifest as it stands now, and each sheet row's angle off its task. A host's bound graphs are
 * not among them, so no slot reports graph drift.
 */
function storeFacts(deps: TakeDeps): PlanFacts & { readonly assets: readonly Asset[] } {
  return {
    model  : deps.model,
    config : deps.config,
    tasks  : deps.graph,
    assets : deps.store.manifest(),
    angleOf: angleOfTask(deps.graph),
  };
}

const isSheet = (asset: Asset): boolean =>
  asset.kind === 'model_sheet' || asset.kind === 'outfit_sheet';

/**
 * Stamps `current` onto a manifest written before takes were held, once. For every slot the solver
 * enumerates, upstream first, the current row is the identity's output when its task is `done`,
 * else its last output when `needs_human`, else the one accepted candidate, else the most recently
 * rendered candidate (then the lowest hash), else the sole candidate. A row bound to two slots is
 * decided by the first slot that names it. Sheet bindings are backfilled with the angle their task
 * recorded. Every other row gets `current: false`, which is what makes this one-shot.
 */
export async function migrateCurrent(deps: TakeDeps): Promise<Migration | undefined> {
  if (!deps.store.unstamped) return undefined;
  const facts = storeFacts(deps);
  const solved = solve(stillsFamily, facts);
  const renderedAt = lastRenderedAt(deps.graph);
  const chosen = new Map<string, string | undefined>();
  const held: Record<string, string> = {};

  for (const key of solved.order) {
    const state = solved.slots.get(key)!;
    // In manifest order, which decides the row a slot that shares one with an earlier slot names
    const candidates = candidatesFor(state.binding as RefBinding, facts);
    const already = candidates.find((a) => chosen.has(a.hash));
    if (already) {
      held[key] = already.hash;
      continue;
    }
    const task = state.taskHash ? deps.graph.get(state.taskHash) : undefined;
    const pick = migrationPick(candidates, loggedTake(task), renderedAt);
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
  const facts = storeFacts(deps);
  const solved = solve(stillsFamily, facts);
  const byHash = new Map(facts.assets.map((a) => [a.hash, a]));
  const fixes: OverHeld[] = [];

  for (const key of solved.order) {
    const state = solved.slots.get(key)!;
    const wanted = loggedTake(state.taskHash ? deps.graph.get(state.taskHash) : undefined);
    if (wanted === undefined || !state.candidates.includes(wanted)) continue;
    const current = state.candidates.filter((h) => byHash.get(h)?.current);
    if (current.length === 1 && current[0] === wanted) continue;
    const drop = current.filter((h) => h !== wanted);
    await deps.store.hold(wanted, drop);
    fixes.push({ slot: key, keep: wanted, drop });
  }

  // The manifest is read again, because the holds above changed which rows are current. A slot's
  // identity is still resolved over the rows read before them, through a new facts object, since
  // the kinds memoise on one
  const before: StillsFacts = { ...facts };
  const after: StillsFacts = { ...facts, assets: deps.store.manifest() };
  for (const fix of overHeld(stillsFamily, after, before)) {
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
    const rows = candidatesFor({ kind: 'portrait', characterId: character.id }, storeFacts(deps));
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
  };
}

/**
 * Every current take nobody has approved, upstream first, so accepting them in this order lets
 * one pass finish a whole chain. Portraits are left out: their approval is the gate's. Rows the
 * gate or `approvable` would list are the same rows, since both read the solver's slots.
 */
export function acceptableTakes(deps: TakeDeps): Acceptable[] {
  const facts = storeFacts(deps);
  const prereqs = prereqContextOf(deps);
  const byHash = new Map(facts.assets.map((a) => [a.hash, a]));
  const out: Acceptable[] = [];
  const seen = new Set<string>();
  const solved = solve(stillsFamily, facts);
  for (const key of solved.order) {
    if (key.startsWith('portrait:')) continue;
    const state = solved.slots.get(key)!;
    for (const hash of state.candidates) {
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

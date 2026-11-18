/**
 * A slot with more than one current row. `pick` refuses to choose between current rows, so such a
 * slot resolves to nothing: the Task Graph pane cannot open its picture, a reference pinned to it
 * reads as unfilled, and everything drawn from it re-renders. A hold releases the rows it replaces
 * (`heldBy`), but a writer that skipped it, or a crash between two roots' writes, can still leave
 * the duplicates, and this is how they are put right.
 */
import type { Asset, RefBinding, Shot } from '@vn/types';
import { candidatesFor, sheetAngleOf, type BindingContext } from './refs.js';
import { slotOf } from './refcycle.js';
import { slotKey } from './slotaddr.js';

/** One over-held slot: the row that stays current and the ones that lose the bit. */
export interface OverHeld {
  slot: string;
  keep: string;
  drop: string[];
}

export interface OverHeldContext extends BindingContext {
  /** Each scene's persisted shots; a shot's own `image` is the take its slot keeps. */
  shots?: ReadonlyMap<string, readonly Shot[] | null>;
  /** The slot's identity's `output` where its task is `done`, which is the take the log says. */
  identityOutput?: (slot: RefBinding) => string | undefined;
  /**
   * When an asset's task last produced anything, for a row never stamped with `at`. Unset, or
   * undefined for a task, falls back to the hash order the manifest is written in, which at least
   * makes the choice stable.
   */
  renderedAt?: (sourceTask: string) => string | undefined;
}

/**
 * Every slot holding more than one current row, with the one to keep. The keep rule has four
 * arms, in order: a shot slot keeps the take its storyboard names; any slot keeps its identity's
 * `output` when the task is `done`; else the row most recently held; else the lowest hash.
 */
export function overHeld(ctx: OverHeldContext): OverHeld[] {
  const seen = new Set<string>();
  const out: OverHeld[] = [];
  const named = new Set<string>();
  for (const shots of ctx.shots?.values() ?? []) {
    for (const shot of shots ?? []) if (shot.image) named.add(shot.image);
  }
  const stamp = (asset: Asset): string => asset.at ?? ctx.renderedAt?.(asset.sourceTask) ?? '';

  for (const asset of ctx.assets) {
    if (!asset.current) continue;
    const slot = slotOf(asset, sheetAngleOf(asset, ctx));
    if (!slot) continue;
    const key = slotKey(slot);
    if (seen.has(key)) continue;
    seen.add(key);

    const current = candidatesFor(slot, ctx).filter((a) => a.current);
    if (current.length < 2) continue;
    const output = ctx.identityOutput?.(slot);
    const keep =
      (slot.kind === 'shot' ? current.find((a) => named.has(a.hash)) : undefined) ??
      current.find((a) => a.hash === output) ??
      [...current].sort(
        (a, b) => stamp(b).localeCompare(stamp(a)) || a.hash.localeCompare(b.hash),
      )[0]!;
    out.push({
      slot: key,
      keep: keep.hash,
      drop: current.filter((a) => a.hash !== keep.hash).map((a) => a.hash),
    });
  }
  return out;
}

/** The latest `at` stamp among a task's attempts, which is when it last drew something. */
export function lastRenderedAt(graph: {
  get(hash: string): { attempts: { at?: string }[] } | undefined;
}): (sourceTask: string) => string | undefined {
  return (sourceTask) => {
    const task = graph.get(sourceTask);
    if (!task) return undefined;
    let latest: string | undefined;
    for (const attempt of task.attempts) {
      if (attempt.at !== undefined && (latest === undefined || attempt.at > latest)) {
        latest = attempt.at;
      }
    }
    return latest;
  };
}

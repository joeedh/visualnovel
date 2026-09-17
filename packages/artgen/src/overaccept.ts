/**
 * A slot with more than one accepted take. `pick` refuses to choose between accepted candidates,
 * so such a slot resolves to nothing: the Task Graph pane cannot open its picture, a reference
 * pinned to it reads as unfilled, and everything drawn from it re-renders. Accepting a take is
 * meant to un-accept the others (`supersededBy`), but manifests written before that rule, or by a
 * writer that skipped it, still carry the duplicates, and this is how they are put right.
 */
import type { Asset, Shot } from '@vn/types';
import { candidatesFor, type BindingContext } from './refs.js';
import { slotOf } from './refcycle.js';
import { slotKey } from './slotaddr.js';

/** One over-accepted slot: the take that stays accepted and the ones that lose the flag. */
export interface OverAccepted {
  slot: string;
  keep: string;
  drop: string[];
}

export interface OverAcceptContext extends BindingContext {
  /** Each scene's persisted shots; a shot's own `image` is the take its slot keeps. */
  shots?: ReadonlyMap<string, readonly Shot[] | null>;
  /**
   * When an asset's task last produced anything, for choosing the newest take where the
   * storyboard does not say. Unset, or undefined for a task, falls back to the hash order the
   * manifest is written in, which at least makes the choice stable.
   */
  renderedAt?: (sourceTask: string) => string | undefined;
}

/**
 * Every slot holding more than one accepted take, with the one to keep. A shot slot keeps the
 * take its storyboard names; any other slot keeps the take rendered last. A portrait is never
 * listed, because the gate holds that answer on the character sheet, and a sheet is listed only
 * when `angleOf` can tell the four angles apart.
 */
export function overAccepted(ctx: OverAcceptContext): OverAccepted[] {
  const seen = new Set<string>();
  const out: OverAccepted[] = [];
  const named = new Set<string>();
  for (const shots of ctx.shots?.values() ?? []) {
    for (const shot of shots ?? []) if (shot.image) named.add(shot.image);
  }
  const stamp = (asset: Asset): string => ctx.renderedAt?.(asset.sourceTask) ?? '';

  for (const asset of ctx.assets) {
    if (!asset.accepted) continue;
    const slot = slotOf(asset, ctx.angleOf?.(asset.sourceTask));
    if (!slot || slot.kind === 'portrait') continue;
    if (slot.kind === 'sheet' && !ctx.angleOf) continue;
    const key = slotKey(slot);
    if (seen.has(key)) continue;
    seen.add(key);

    const accepted = candidatesFor(slot, ctx).filter((a) => a.accepted);
    if (accepted.length < 2) continue;
    const keep =
      accepted.find((a) => named.has(a.hash)) ??
      [...accepted].sort(
        (a, b) => stamp(b).localeCompare(stamp(a)) || a.hash.localeCompare(b.hash),
      )[0]!;
    out.push({
      slot: key,
      keep: keep.hash,
      drop: accepted.filter((a) => a.hash !== keep.hash).map((a) => a.hash),
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

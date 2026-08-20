/**
 * Suspension: what a changed upstream asset does to everything downstream of it
 * (`docs/plans/archive/chunked-prompts.md` §13).
 *
 * An asset is suspended when a reference on it has drifted, **or** when anything it references is
 * suspended. Nothing about that is stored. A flag would need a cascade pass that can be interrupted
 * halfway and then disagrees with the disk; a walk on read cannot be, and it costs one pass over a
 * manifest that is already in memory.
 *
 * The point of suspending rather than regenerating is that the bytes stay: they are marked out of
 * date and the author picks re-approve or regenerate. Auto-cascade and suspension are the same fork
 * in the road, and the pinned reference (§13) is what buys the second one.
 */
import { refDrift, resolveBinding, type BindingContext } from './refs.js';
import { slotLabel } from './refcycle.js';
import type { RungContext } from './resolve.js';
import { attachedRefs } from './upstream.js';

/** Everything the walk reads: the manifest and the rungs an override could be stored at. */
export interface SuspendContext extends BindingContext, RungContext {}

/** One suspended asset and why — the sentence a surface shows and an agent acts on. */
export interface Suspension {
  hash: string;
  reason: string;
  /** The suspended asset this one inherited it from; absent when the drift is its own. */
  via?: string;
}

const short = (hash: string): string => hash.slice(0, 8);

/**
 * Every suspended asset, upstream before downstream — the order an agent clearing a subtree has to
 * work in, which is why this is a listing and not a per-asset predicate.
 *
 * A cycle that reached disk some other way is stepped over by the `visiting` guard rather than
 * hung on; naming it is `firstCycle`'s job, and the planner's. That redundancy is deliberate:
 * enforcement stops a cycle being written, the guard stops a corrupt project wedging the app.
 */
export function suspendedAssets(ctx: SuspendContext): Suspension[] {
  const byHash = new Map(ctx.assets.map((a) => [a.hash, a]));
  const decided = new Map<string, Suspension | undefined>();
  const visiting = new Set<string>();
  const order: Suspension[] = [];

  const walk = (hash: string): Suspension | undefined => {
    if (decided.has(hash)) return decided.get(hash);
    if (visiting.has(hash)) return undefined;
    const asset = byHash.get(hash);
    if (!asset) return undefined;
    visiting.add(hash);

    let found: Suspension | undefined;
    const attached = attachedRefs(asset, ctx);
    for (const { chunk, ref } of attached) {
      if (!refDrift(ref, ctx)) continue;
      const now = resolveBinding(ref.from!, ctx)!;
      found = {
        hash,
        reason:
          `its "${chunk}" reference to ${slotLabel(ref.from!)} has moved — ` +
          `pinned ${short(ref.pin)}, now ${short(now)}`,
      };
      break;
    }

    if (!found) {
      // Whatever it was generated from, plus whatever an author attached: the first two are the
      // manifest's own record, so an asset predating chunked prompts still cascades correctly.
      const upstream = [...asset.refs, ...attached.map(({ ref }) => ref.pin)];
      for (const up of upstream) {
        const sus = walk(up);
        if (!sus) continue;
        found = { hash, reason: `it references ${short(up)}, which is suspended`, via: up };
        break;
      }
    }

    visiting.delete(hash);
    decided.set(hash, found);
    if (found) order.push(found);
    return found;
  };

  for (const asset of ctx.assets) walk(asset.hash);
  return order;
}

/** The same answer indexed by hash, for a surface asking about one asset. */
export function suspensionMap(ctx: SuspendContext): Map<string, Suspension> {
  return new Map(suspendedAssets(ctx).map((s) => [s.hash, s]));
}

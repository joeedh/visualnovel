/**
 * What one asset rests on: the pictures that were fed to the model that made it.
 *
 * Two halves, and both are needed. `Asset.refs` is the manifest's own record of what the task sent,
 * so an asset that predates chunked prompts still answers; the author's attached references live at
 * the prompt rung instead, and a muted chunk contributes none of them because its clause is not
 * being sent.
 *
 * This is deliberately a **hash** walk, not a slot walk. It says what these bytes were drawn from,
 * which is a question about history and is therefore answerable for a concept and an upload too —
 * neither of which fills a slot. "Has the slot moved since" is a different question with its own
 * walk and its own sentence, and that is `suspend.ts`.
 */
import type { Asset, ChunkRef } from '@vn/types';
import { overrideAt, rungOf, type RungContext } from './resolve.js';

/** The references an author attached to this asset's prompt, by chunk. A muted chunk has none. */
export function attachedRefs(asset: Asset, ctx: RungContext): { chunk: string; ref: ChunkRef }[] {
  const rung = rungOf(asset);
  const o = rung && overrideAt(rung, ctx);
  if (!o?.refs) return [];
  const muted = new Set(o.mute ?? []);
  const out: { chunk: string; ref: ChunkRef }[] = [];
  for (const [chunk, refs] of Object.entries(o.refs)) {
    if (muted.has(chunk)) continue;
    for (const ref of refs) out.push({ chunk, ref });
  }
  return out;
}

/**
 * Every hash this asset was drawn from — what it was generated from, plus what an author attached.
 *
 * Derived-first, matching the order a task's `refs` are composed in, so a surface listing these
 * shows a frame's plate before its portraits before the author's pins. Not deduped: a caller that
 * cares says so, and suspension's walk is memoized anyway.
 */
export function upstreamOf(asset: Asset, ctx: RungContext): string[] {
  return [...asset.refs, ...attachedRefs(asset, ctx).map(({ ref }) => ref.pin)];
}

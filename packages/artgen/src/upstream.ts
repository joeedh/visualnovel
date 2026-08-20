/**
 * The pictures that were fed to the model that made an asset.
 *
 * Two sources are combined, and both are needed. `Asset.refs` is the manifest's own record of what
 * the task sent, so an asset predating chunked prompts still answers. The author's attached
 * references live at the prompt rung instead, and a muted chunk contributes none of them because
 * its clause is not sent.
 *
 * This walk is over hashes rather than slots. It answers what these bytes were drawn from, a
 * question about history, so it also answers for a concept and an upload, neither of which fills
 * a slot. Whether the slot has moved since is a separate question, answered in `suspend.ts`.
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
 * Derived references come first, matching the order a task's `refs` are composed in, so a surface
 * listing these shows a frame's plate, then its portraits, then the author's pins. The result is
 * not deduped; a caller that needs that does it itself, and suspension's walk is memoized anyway.
 */
export function upstreamOf(asset: Asset, ctx: RungContext): string[] {
  return [...asset.refs, ...attachedRefs(asset, ctx).map(({ ref }) => ref.pin)];
}

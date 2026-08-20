/**
 * The pure half of `prompt.moveChunk`: what the chunk list's effective order is, and what a drop
 * would make it (`docs/plans/archive/chunked-prompts.md` §7).
 *
 * It is in `shared/` for the same reason `coverage.ts` is — the pane runs these mid-drag to draw
 * what a drop would produce, and `prompt.reorder` (`interactions.ts`) enumerates its targets with
 * them, so the preview and the commit are one rule rather than two copies that can disagree.
 *
 * `effectiveOrder` deliberately mirrors `reorder` in `@vn/artgen`'s `chunks.ts` rather than
 * importing it: artgen is node-side and this file is in the browser bundle. The mirroring is
 * pinned by a test that walks the same partial-order cases.
 */

/** Just enough of a chunk to reason about order. */
export interface OrderChunk {
  key: string;
  muted?: boolean;
  text?: string;
}

/** What the gesture is judged against: the chunks in derivation order, and the mode in force. */
export interface PromptOrderState {
  /** Derivation order — what the builder emitted, before any stored `order` is applied. */
  chunks: readonly OrderChunk[];
  order?: readonly string[];
  mode: 'chunks' | 'custom' | 'agent';
}

export type MoveChunkOp =
  | { ok: true; order: string[]; message: string }
  | { ok: false; error: string; noop: boolean };

/** The insertion point above the first chunk — `prompt.moveChunk`'s empty `after`. */
export const TOP_CHUNK = 'top';

/**
 * The keys in the order they would be sent: the ones a stored `order` names, in the order it names
 * them, then everything else in derivation order.
 *
 * A key naming no chunk is ignored, and a chunk a later builder adds still appears — silently
 * losing a new clause because an old override did not list it is the failure this shape prevents.
 */
export function effectiveOrder(
  chunks: readonly OrderChunk[],
  order?: readonly string[],
): OrderChunk[] {
  if (!order?.length) return [...chunks];
  const rank = new Map(order.map((key, i) => [key, i]));
  const named = chunks.filter((c) => rank.has(c.key));
  named.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...named, ...chunks.filter((c) => !rank.has(c.key))];
}

/** The chunks that contribute text — muted ones and empty ones are not sent. */
export function enabledChunks(chunks: readonly OrderChunk[]): OrderChunk[] {
  return chunks.filter((c) => !c.muted && (c.text ?? '').length > 0);
}

/**
 * Move `chunk` so it sits directly after `after` — or first, when `after` is empty.
 *
 * Returns the complete key order rather than a partial one. The stored form tolerates a partial
 * list (see {@link effectiveOrder}), but a gesture that writes only the two keys it touched would
 * leave the rest to derivation order and quietly undo an earlier move.
 *
 * A drop that changes nothing refuses with `noop: true`, so a caller enumerating targets can leave
 * it out of the list entirely rather than offer an accept the author would learn nothing from —
 * exactly the distinction `planShotMove` draws.
 */
export function moveChunk(
  state: PromptOrderState,
  args: { chunk: string; after: string },
): MoveChunkOp {
  const current = effectiveOrder(state.chunks, state.order);
  const keys = current.map((c) => c.key);
  if (!keys.includes(args.chunk)) {
    return { ok: false, error: `No chunk "${args.chunk}" in this prompt.`, noop: false };
  }
  if (args.after !== '' && !keys.includes(args.after)) {
    return { ok: false, error: `No chunk "${args.after}" to sit after.`, noop: false };
  }
  if (args.after === args.chunk) {
    return { ok: false, error: `${args.chunk} is already where it is.`, noop: true };
  }

  const rest = keys.filter((k) => k !== args.chunk);
  const at = args.after === '' ? 0 : rest.indexOf(args.after) + 1;
  const order = [...rest.slice(0, at), args.chunk, ...rest.slice(at)];
  if (sameOrder(order, keys)) {
    return { ok: false, error: `${args.chunk} is already where it is.`, noop: true };
  }

  const where = args.after === '' ? 'first' : `after ${args.after}`;
  // Reordering is the one chunk edit a condensation cannot survive: the agent chose that sentence
  // order for the image model, so the fingerprint moves and the prompt is held until it is redone.
  const warning =
    state.mode === 'agent'
      ? ' The condensed prompt will be held until it is recondensed — the chunks it was given have moved.'
      : '';
  return { ok: true, order, message: `${args.chunk} now sits ${where}.${warning}` };
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

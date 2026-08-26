/**
 * The chunk model: a derived prompt made addressable, and the collapse back to the flat string
 * every task hash is computed over (`docs/plans/archive/chunked-prompts.md` §1).
 *
 * The builders stay authoritative. What changes is that each clause they already assembled is now
 * a named `PromptChunk`, so an author can mute, replace, append to or reorder one — and a project
 * that overrides nothing gets character-for-character the string it got before.
 */
import type { ChunkCategory, ChunkEdit, ChunkOrigin, PromptChunk, PromptOverride } from '@vn/types';
import { sha256 } from '@vn/util';

/** Represents a chunk together with what an override did to it. `text` holds what would actually be sent. */
export interface EffectiveChunk extends PromptChunk {
  /** The builder's own text, before any edit. */
  derived: string;
  edit?: 'replace' | 'append';
  /** The author's words alone — the replacement, or the appendix. */
  authored?: string;
  muted: boolean;
  /**
   * The edit was written against text that has since changed. `undefined` when the edit records
   * no `of` — unknown, never stale, the same posture `Shot.proseHash` takes.
   */
  editStale?: boolean;
}

/** The result of applying an override to a derived chunk list. */
export interface Composed {
  /** The one string that would be sent to the image model. */
  text: string;
  mode: 'chunks' | 'custom' | 'agent';
  /** Every chunk, in effective order, muted ones included and marked. */
  chunks: EffectiveChunk[];
  /**
   * `mode === 'agent'` and the chunks have moved since the agent condensed them. The stale
   * condensation is still what gets sent, because re-rendering would move the task hash and
   * re-render the asset, which is exactly what holding exists to prevent.
   */
  held: boolean;
}

/**
 * Collapse chunks to the flat prompt string. Character for character the tail every builder used
 * to end with (`.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()`), which is what makes
 * byte-identity structural rather than lucky.
 */
export function renderPrompt(chunks: readonly PromptChunk[]): string {
  return chunks
    .map((c) => c.text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a chunk, or nothing when the clause contributes no words — the same thing the builders'
 * `.filter(Boolean)` did to an empty clause.
 *
 * Text is trimmed and its whitespace collapsed here rather than at the end. That is equivalent to
 * the old global collapse, because the join between chunks is a single space: `paletteClause`
 * returns a string with a leading space, and the space this trims is exactly the one `join(' ')`
 * puts back. An all-whitespace clause used to survive `.filter(Boolean)` and be erased by the final
 * collapse; here it is dropped up front, to the same effect.
 */
export function chunk(
  key: string,
  category: ChunkCategory,
  text: string | undefined,
  origin: ChunkOrigin,
  also?: ChunkOrigin,
): PromptChunk | undefined {
  const said = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!said) return undefined;
  return also ? { key, category, text: said, origin, also } : { key, category, text: said, origin };
}

/** Drop the chunks that contributed nothing, keeping the builder's order. */
export function chunkList(...parts: (PromptChunk | undefined)[]): PromptChunk[] {
  return parts.filter((c): c is PromptChunk => c !== undefined);
}

/** `undefined` — meaning unknown — when the edit never recorded what it was written against. */
function staleness(edit: ChunkEdit, derived: string): boolean | undefined {
  return edit.of === undefined ? undefined : edit.of !== sha256(derived);
}

/**
 * Apply the per-chunk half of an override: replace → append → mute, then reorder. The whole-prompt
 * half (custom, agent) sits on top of this and is `composePrompt`'s business.
 */
export function effectiveChunks(
  chunks: readonly PromptChunk[],
  o?: PromptOverride,
): EffectiveChunk[] {
  const muted = new Set(o?.mute ?? []);
  const applied = chunks.map((c): EffectiveChunk => {
    const base: EffectiveChunk = { ...c, derived: c.text, muted: muted.has(c.key) };
    const replace = o?.replace?.[c.key];
    if (replace) {
      base.text = replace.text.replace(/\s+/g, ' ').trim();
      base.edit = 'replace';
      base.authored = replace.text;
      base.editStale = staleness(replace, c.text);
    }
    const append = o?.append?.[c.key];
    if (append) {
      const added = append.text.replace(/\s+/g, ' ').trim();
      if (added) base.text = base.text ? `${base.text} ${added}` : added;
      base.edit = base.edit ?? 'append';
      base.authored = base.edit === 'append' ? append.text : `${base.authored} ${append.text}`;
      base.editStale = base.editStale ?? staleness(append, c.text);
    }
    return base;
  });
  return reorder(applied, o?.order);
}

/**
 * A partial order: the keys named, in the order named, then everything else in derivation order.
 * A key that names no chunk is ignored, and a chunk a later builder adds still appears — silently
 * losing a new clause because an old override did not list it is the failure this shape prevents.
 */
function reorder(chunks: EffectiveChunk[], order?: readonly string[]): EffectiveChunk[] {
  if (!order?.length) return chunks;
  const rank = new Map(order.map((key, i) => [key, i]));
  const named = chunks.filter((c) => rank.has(c.key));
  named.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...named, ...chunks.filter((c) => !rank.has(c.key))];
}

/** The chunks that contribute text — and, in Part II, the chunks whose references are sent. */
export function enabledChunks(chunks: readonly EffectiveChunk[]): EffectiveChunk[] {
  return chunks.filter((c) => !c.muted && c.text.length > 0);
}

/**
 * What an agent-condensed prompt was condensed from: `key\ntext` of the enabled chunks, in
 * effective order. Muting and unmuting round-trips to the same fingerprint; reordering does not —
 * the agent chose that sentence order for the image model, so a reorder is a real change to what
 * it was asked to condense.
 */
export function chunkFingerprint(chunks: readonly PromptChunk[], o?: PromptOverride): string {
  return sha256(
    enabledChunks(effectiveChunks(chunks, o))
      .map((c) => `${c.key}\n${c.text}`)
      .join('\n'),
  );
}

/**
 * The whole override, resolved to one string plus the chunk list a surface draws.
 *
 * In `agent` mode the stored text is always returned, never a fallback to freshly rendered
 * chunks. Falling back would move the prompt, and therefore the task hash, and therefore
 * re-render the asset without anyone asking; `held` says the condensation is out of date instead.
 */
export function composePrompt(chunks: readonly PromptChunk[], o?: PromptOverride): Composed {
  const effective = effectiveChunks(chunks, o);
  const mode = o?.mode ?? 'chunks';
  const custom = o?.custom?.trim();
  if (mode === 'custom' && custom) {
    return { text: custom, mode, chunks: effective, held: false };
  }
  if (mode === 'agent' && o?.agent) {
    return {
      text: o.agent.text,
      mode,
      chunks: effective,
      held: o.agent.of !== chunkFingerprint(chunks, o),
    };
  }
  return {
    text: renderPrompt(enabledChunks(effective)),
    mode: 'chunks',
    chunks: effective,
    held: false,
  };
}

/**
 * The chunk model behind an editable image prompt (`docs/plans/archive/chunked-prompts.md`).
 *
 * A prompt is still a flat string everywhere it matters — `TaskInputs.*.prompt` is inside the task
 * hash, so it cannot become structured without re-keying every task in every project. Chunks are
 * the authoring view of the same string: each builder's array of clauses, made addressable, with
 * `renderPrompt` collapsing them exactly as the builders always did.
 *
 * The shapes live here rather than in `@vn/artgen` because the entity types that *store* an
 * override are here too, and a type in two places is a type that drifts.
 */

/** What a chunk contributes, for the tag on its card and for nothing else. */
export type ChunkCategory =
  | 'style'
  | 'subject'
  | 'description'
  | 'mood'
  | 'variant'
  | 'palette'
  | 'camera'
  | 'framing'
  | 'art-notes'
  | 'scaffolding'
  | 'request';

/**
 * Where a chunk's words came from — an address a surface can open, not a position. `builder` is
 * the one origin with no document behind it: the scaffolding sentences the builders write.
 */
export type ChunkOrigin =
  | { kind: 'project'; field: 'art_style' }
  | { kind: 'character'; id: string; field: string }
  | { kind: 'outfit'; id: string; outfit: string }
  | { kind: 'location'; id: string; field: string }
  | { kind: 'variant'; id: string; variant: string }
  | { kind: 'shot'; sceneId: string; shotId: string; field: string }
  /** An `art.setNotes` address, e.g. `character:aiko` or `shot:arrival/arrival__a`. */
  | { kind: 'art-notes'; target: string }
  /** A concept's authored sentence. */
  | { kind: 'request' }
  /** Scaffolding — no document behind it. */
  | { kind: 'builder' };

/** One clause of a derived prompt, addressable by {@link PromptChunk.key}. */
export interface PromptChunk {
  /**
   * Stable across re-derivation — an override is keyed by it. Derived from the origin address,
   * never from position or text, so editing art notes keeps the override attached.
   */
  key: string;
  category: ChunkCategory;
  /** The sentence this chunk contributes, already punctuated. */
  text: string;
  origin: ChunkOrigin;
  /**
   * A second rung that fed the same sentence, when the builder folded two into one — the outfit
   * inside a model sheet's subject line, the entity note beside a narrow one. Presentational: it
   * lets a card name the rung a word came from without splitting the chunk and moving the prompt.
   */
  also?: ChunkOrigin;
}

/**
 * Authored text plus the derived text it was written against. `of` is what makes a replacement
 * carryable forward: when the derivation underneath moves, the old text, the new text and the
 * author's replacement together are enough to rewrite it. Absent reads as unknown, never as stale.
 */
export interface ChunkEdit {
  text: string;
  /** sha256 of the chunk's derived text when this was written. */
  of?: string;
}

/** An agent-condensed whole prompt, held in place until it is recondensed. */
export interface AgentPrompt {
  text: string;
  /** `chunkFingerprint` of the chunk list this condensed. A mismatch means held, not stale text. */
  of: string;
  modelId?: string;
  /** ISO timestamp of the condensation. */
  at?: string;
}

/**
 * The logical slot a linked reference was resolved from — never a hash, because the point of a
 * binding is to survive the slot's contents changing. `asset` is the degenerate one: a concept or
 * an upload has no slot behind it, so its identity *is* the hash and it can never drift.
 */
export type RefBinding =
  | { kind: 'portrait'; characterId: string }
  | { kind: 'sheet'; characterId: string; outfit: string; angle: string }
  | { kind: 'plate'; locationId: string; variant: string }
  | { kind: 'shot'; sceneId: string; shotId: string }
  | { kind: 'asset'; hash: string };

/**
 * A reference image attached to one chunk — evidence for that clause, so muting the clause drops
 * its references too.
 *
 * The pin is what reaches `TaskInputs.refs` and therefore the task hash, so nothing re-renders on
 * its own when the slot underneath moves; drift is the comparison `resolveBinding(from) !== pin`,
 * derived on read. A ref with no {@link from} is a custom upload: there is no slot to compare
 * against and it can never drift.
 */
export interface ChunkRef {
  /** Asset hash of the bytes actually fed to the model. */
  pin: string;
  ext: string;
  from?: RefBinding;
  note?: string;
}

/**
 * An author's override of one derived prompt, stored at the rung that names the whole picture.
 * Everything here is optional and nothing has a default: an override that says nothing must
 * serialize to no key at all, or every sheet grows an empty block on its first edit.
 */
export interface PromptOverride {
  mode: 'chunks' | 'custom' | 'agent';
  /** Chunk keys to drop. A muted chunk contributes no text and no references. */
  mute?: string[];
  /** Partial order of chunk keys; anything unlisted keeps derivation order, after. */
  order?: string[];
  replace?: Record<string, ChunkEdit>;
  append?: Record<string, ChunkEdit>;
  /** `mode === 'custom'`: sent verbatim, trimmed only. */
  custom?: string;
  agent?: AgentPrompt;
  /** Reference images, by chunk key, in authored order. */
  refs?: Record<string, ChunkRef[]>;
}

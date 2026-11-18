/**
 * The chunk model behind an editable image prompt (`docs/plans/archive/INDEX.md#chunked-prompts`).
 *
 * A prompt is still a flat string everywhere it matters — `TaskInputs.*.prompt` is inside the task
 * hash, so it cannot become structured without re-keying every task in every project. Chunks are
 * the authoring view of the same string: each builder's array of clauses, made addressable, with
 * `renderPrompt` collapsing them exactly as the builders always did.
 *
 * The shapes live here rather than in `@vn/stills` because the entity types that store an
 * override are here too, and the two copies would drift apart if the type were declared twice.
 */
import { contract } from '@vn/contracts';

/** What a chunk contributes. Used only for the tag on its card. */
export type ChunkCategory =
  | 'style'
  | 'subject'
  | 'description'
  | 'mood'
  | 'variant'
  | 'palette'
  | 'camera'
  | 'framing'
  /** One panel of a page shot: its framing, cast and camera. */
  | 'panel'
  /** The words a page shot letters, under `lettering: model`. */
  | 'lettering'
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

export const promptsClauseList = contract({
  id      : 'prompts.clauseList',
  rule: 'A derived prompt is a `PromptChunk[]` of keyed clauses, which `renderPrompt` collapses to the flat string a task hashes. An override edits that list at the one rung naming the whole picture, and a project with no override composes byte-identical prompts.',
  prevents:
    'Every existing task re-keying, and so every picture re-rendering, when prompts became editable; and an agent-condensed prompt re-rendering its asset because an unrelated note moved a clause under it.',
  subjects: [
    'module:packages/types/src/prompt.ts',
    'function:packages/types/src/prompt.ts#PromptChunk',
    'function:packages/types/src/prompt.ts#PromptOverride',
    'function:packages/stills/src/chunks.ts#renderPrompt',
    'function:packages/stills/src/chunks.ts#effectiveChunks',
    'function:packages/stills/src/chunks.ts#composePrompt',
    'command:prompt.setChunk',
    'command:prompt.clear',
  ],
  see     : ['docs/plans/archive/INDEX.md#chunked-prompts'],
  detail:
    'Every builder in `@vn/stills` assembles the list. Each clause is keyed, categorised, and ' +
    'carries an origin (a builder, or the document and field its sentence came from) that a ' +
    "surface can open. `renderPrompt` is the `.filter(Boolean).join(' ')` tail the flat builders " +
    'ended with, and `prompthash.test.ts` pins the sorted hash list against a literal written ' +
    'before chunks existed. The override rungs are `Character` for a portrait, the outfit entry ' +
    'for a sheet, the location variant for a plate and the `Shot` for a frame, never a rung that ' +
    'only contributes a clause, so there is one place to look. Setting `mode` alone overrides ' +
    'nothing: every mode falls back to the derived chunks when the shape it names is empty, and ' +
    'each writer calls `promptOverrideIsEmpty` to clear the key. `TaskInputs.*.prompt` stays a ' +
    'flat string, because `taskHash` hashes the whole inputs object with no allow-list; a chunk ' +
    "reaches a hash only through `composePrompt`'s text. An override edit re-keys exactly the " +
    'tasks its rung reaches, as an art note does. An agent-condensed prompt records the chunk list ' +
    'it condensed (`chunkFingerprint`). When those chunks move, `composePrompt` in `agent` mode ' +
    'still returns the stored text and reports `held`, and never falls back to fresh chunks; the ' +
    'staleness is derived on read and shown on the pane, never stored.',
});
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
   * A second rung that fed the same sentence, when the builder folded two into one (the outfit
   * inside a model sheet's subject line, or an entity note beside a narrower rung). Purely
   * presentational: a card can name the rung a word came from without splitting the chunk, which
   * would change the prompt.
   */
  also?: ChunkOrigin;
}

/**
 * Authored text plus the derived text it was written against. `of` is what lets a replacement be
 * carried forward: when the derivation underneath moves, the old text, the new text and the
 * author's replacement together are enough to rewrite it. An absent `of` means unknown, not stale.
 */
export interface ChunkEdit {
  text: string;
  /** sha256 of the chunk's derived text when this was written. */
  of?: string;
}

/** An agent-condensed whole prompt, held in place until it is recondensed. */
export interface AgentPrompt {
  text: string;
  /**
   * `chunkFingerprint` of the chunk list this condensed. A mismatch means the text is held in
   * place rather than treated as stale.
   */
  of: string;
  modelId?: string;
  /** ISO timestamp of the condensation. */
  at?: string;
}

/**
 * The logical slot a linked reference was resolved from — never a hash, because the point of a
 * binding is to survive the slot's contents changing. `asset` is the degenerate case: a concept or
 * an upload has no slot behind it, so the hash identifies it and it can never drift.
 */
export type RefBinding =
  | { kind: 'portrait'; characterId: string }
  | { kind: 'sheet'; characterId: string; outfit: string; angle: string }
  | { kind: 'plate'; locationId: string; variant: string }
  | { kind: 'shot'; sceneId: string; shotId: string }
  | { kind: 'asset'; hash: string };

export const promptsRefOnClause = contract({
  id      : 'prompts.refOnClause',
  rule: 'A reference is a `ChunkRef` on one clause: muting the clause drops it, the task hashes its `pin` rather than its slot, authored refs follow the derived ones in `TaskInputs.refs`, and a ref with no `from` names an asset by hash and never drifts.',
  prevents:
    'An upstream approval silently re-rendering everything that points at it, a muted clause still feeding the model its pictures, and every task with no authored reference re-keying, since `canonicalJson` maps arrays by position.',
  subjects: [
    'module:packages/types/src/prompt.ts',
    'function:packages/types/src/prompt.ts#ChunkRef',
    'function:packages/types/src/prompt.ts#RefBinding',
    'function:packages/stills/src/refs.ts#authoredRefs',
    'function:packages/stills/src/refs.ts#refDrift',
    'function:apps/desktop/src/main/agent/promptedit.ts#applyPromptEdit',
    'command:prompt.addRef',
    'command:prompt.repin',
  ],
  see     : ['docs/plans/archive/INDEX.md#chunked-prompts'],
  detail:
    'A linked ref carries a `RefBinding` naming the slot it was taken from (`plate:cafe/night`, ' +
    '`sheet:aiko/gala/front`). Drift is `resolveBinding(from) !== pin`, derived on read, and a ' +
    'slot that cannot be resolved reports none; a moved slot suspends what was pinned to its old ' +
    'hash rather than re-rendering it. `prompt.addRef` attaches a bare asset hash with no `from`, ' +
    'because an upload or a concept has no slot under it. `applyPromptEdit` refuses a reference on ' +
    'a clause the prompt does not have, and the same pin twice on one clause, since `refs` is ' +
    'positional and inside the hash. The cycle refusal is `prompts.refsAcyclic`.',
});
/** A reference image attached to one chunk, as evidence for that clause ({@link promptsRefOnClause}). */
export interface ChunkRef {
  /** Asset hash of the bytes actually fed to the model. */
  pin: string;
  ext: string;
  from?: RefBinding;
  note?: string;
}

/**
 * An author's override of one derived prompt, stored at the rung that names the whole picture.
 * Everything here is optional and nothing has a default, so an override with no content
 * serializes to no key at all. Otherwise every sheet would grow an empty block on its first edit.
 */
export interface PromptOverride {
  mode: 'chunks' | 'custom' | 'agent';
  /** Chunk keys to drop. A muted chunk contributes no text and no references. */
  mute?: string[];
  /** Partial order of chunk keys. Unlisted keys follow, in derivation order. */
  order?: string[];
  replace?: Record<string, ChunkEdit>;
  append?: Record<string, ChunkEdit>;
  /** `mode === 'custom'`: sent verbatim, trimmed only. */
  custom?: string;
  agent?: AgentPrompt;
  /** Reference images, by chunk key, in authored order. */
  refs?: Record<string, ChunkRef[]>;
}

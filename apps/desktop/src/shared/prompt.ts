/**
 * A composed prompt as a surface sees it (`docs/plans/archive/chunked-prompts.md` §6).
 *
 * `@vn/artgen` is node-side and `src/shared/` is in the browser bundle, so `EffectiveChunk` and
 * `Composed` cannot cross — this re-declares them as plain data, the way `AssetInfo` already
 * projects `Asset`. `session.ts` maps between the two in one place. The vocabulary itself
 * (`ChunkCategory`, `ChunkOrigin`) comes from `@vn/types`, which is zod-only and crosses fine.
 */
import type { ChunkCategory, ChunkOrigin } from '@vn/types';

/**
 * One reference image attached to a chunk, as the strip under the card draws it. The images are
 * evidence for that clause, so a muted chunk sends none of them.
 */
export interface ChunkRefInfo {
  /** The hash actually fed to the model, and what the task hashes over. */
  pin: string;
  ext: string;
  /** What the picture is called, the same name the document tree gives it. */
  label: string;
  /** The slot it follows, as an address (`plate:cafe/night`). Absent means it pins itself. */
  from?: string;
  /** The slot holds something else now: `prompt.repin` is what moves the pin to it. */
  drift?: boolean;
}

/** One chunk of a derived prompt, with whatever the override did to it. */
export interface PromptChunkInfo {
  key: string;
  category: ChunkCategory;
  origin: ChunkOrigin;
  /** A second document the chunk speaks for — the outfit inside a model sheet's subject sentence. */
  also?: ChunkOrigin;
  /** What would actually be sent for this chunk: the derived text with the author's edit applied. */
  text: string;
  /** The builder's own words, before any edit. */
  derived: string;
  edit?: 'replace' | 'append';
  /** The author's words alone — the replacement, or the appendix. */
  authored?: string;
  muted: boolean;
  /**
   * The edit was written against derived text that has since changed. Absent means unknown: an
   * edit that recorded no `of` is never reported as stale, the posture `Shot.proseHash` takes.
   */
  editStale?: boolean;
  /**
   * Whether the whole-prompt text still appears to say this chunk. Only meaningful in `custom` and
   * `agent` mode, and only ever a heuristic — a surface says "not found", never "it was dropped".
   */
  represented?: boolean;
  /** The reference images attached to this chunk, in authored order. Absent when there are none. */
  refs?: ChunkRefInfo[];
}

/** Everything the prompt half of the asset editor draws for one asset. */
export interface PromptView {
  hash: string;
  mode: 'chunks' | 'custom' | 'agent';
  /** The one string that would be sent to the image model. */
  text: string;
  /** Every chunk, in effective order, muted ones included and marked. */
  chunks: PromptChunkInfo[];
  /**
   * `mode === 'agent'` and the chunks have moved since it condensed them. The stale condensation
   * is still what gets sent — re-rendering would move the task hash — so this says so instead.
   */
  held: boolean;
  /** Chunk keys the effective text does not appear to say. Advisory; see {@link PromptChunkInfo}. */
  missing: string[];
  /** Why nothing here can be edited — a concept's prompt was authored, not derived. */
  frozen?: string;
  /** The custom text as written, when there is one. */
  custom?: string;
  /** What condensed the agent prompt, when there is one. */
  agent?: { modelId?: string; at?: string };
}

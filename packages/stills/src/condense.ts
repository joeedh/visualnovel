/**
 * Rewrite a chunk list into one prompt an image model handles well
 * (`docs/plans/archive/INDEX.md#chunked-prompts` §4).
 *
 * Condensing is an authoring-time action. It never runs during planning, which is what keeps
 * `planTasks` deterministic and offline — and it is why `ArtGenDeps` is not widened to carry a
 * `TextLLM`: an optional `text` there would tell every reader that concept generation might call a
 * model, which it does not. The caller already holds `providers.text`.
 */
import { condensedPromptSchema, type PromptChunk, type TextLLM } from '@vn/types';
import { renderPrompt } from './chunks.js';
import { coverage, type ChunkCoverage } from './coverage.js';

export interface Condensation {
  prompt: string;
  /**
   * What the local check makes of the result. `coverage.ts` explains why the check answers this
   * rather than the model.
   */
  coverage: ChunkCoverage[];
  /** `fallback` means the model was unavailable or unusable and the chunks were simply joined. */
  source: 'llm' | 'fallback';
  /** What the model claimed it could not fit. Advisory; empty on a fallback. */
  omitted: string[];
}

const SYSTEM = [
  'You rewrite image-generation prompts. You are given the numbered clauses of one prompt, each',
  'prefixed with its key in square brackets. Return a SINGLE prompt that an image model handles',
  'well: fluent, ordered from subject outwards, free of repetition and of instructions to the',
  'reader. Every clause must still be represented — you may merge and rephrase, but you may not',
  'drop a fact, and you must not invent one. If a clause genuinely cannot be fitted, name its key',
  'in `omitted` rather than silently losing it. Respond ONLY with JSON of the form',
  '{"prompt":"…","omitted":["key"]}.',
].join(' ');

const KEEP = [
  'The author has already written this prompt by hand:',
  '',
  '%s',
  '',
  'Preserve its wording and intent wherever the clauses below allow it — you are reconciling it',
  'against them, not replacing it.',
].join('\n');

/**
 * Condense `chunks` into one prompt. `keep` is an existing custom prompt to reconcile against —
 * what `prompt.condense(force=true)` supplies so that switching from a hand-written prompt to an
 * agent one does not throw the author's words away.
 *
 * On any failure — no key, a malformed answer, a schema mismatch that outlives the retry — this
 * falls back to `renderPrompt(chunks)`, the same string chunks mode would have produced. That is
 * what makes `--mock` and an offline machine behave, and it is the P1/P5 posture applied here.
 */
export async function condensePrompt(
  chunks: readonly PromptChunk[],
  text: TextLLM,
  keep?: string,
): Promise<Condensation> {
  const flat = renderPrompt(chunks);
  if (chunks.length === 0) {
    return { prompt: flat, coverage: [], source: 'fallback', omitted: [] };
  }

  const prompt = [
    ...(keep?.trim() ? [KEEP.replace('%s', keep.trim()), ''] : []),
    'Clauses:',
    ...chunks.map((c) => `[${c.key}] ${c.text}`),
  ].join('\n');

  try {
    const result = await text.structured(
      prompt,
      (raw) => condensedPromptSchema.parse(JSON.parse(raw)),
      SYSTEM,
    );
    const condensed = result.prompt.replace(/\s+/g, ' ').trim();
    if (!condensed) throw new Error('empty prompt');
    return {
      prompt  : condensed,
      coverage: coverage(chunks, condensed),
      source  : 'llm',
      omitted : result.omitted,
    };
  } catch {
    return { prompt: flat, coverage: coverage(chunks, flat), source: 'fallback', omitted: [] };
  }
}

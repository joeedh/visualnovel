/**
 * Checks whether a rewritten prompt still says what each chunk said
 * (`docs/plans/archive/chunked-prompts.md` §1, §4).
 *
 * A condensed or hand-written prompt is one string with no structure in it, so the only way to ask
 * whether a clause survived is to look for its words. That check is a heuristic, and it is the
 * whole reason this module exists rather than trusting the model: a model asked "did you cover
 * everything?" answers yes. The model's `omitted` list is advisory; this check is the authoritative
 * answer, and even so nothing rejects a prompt over it. Every surface says "not found", never "it
 * was dropped".
 */

/** What a chunk contributed, for the purposes of the check. Any chunk shape satisfies it. */
export interface CoverageInput {
  key: string;
  text: string;
}

export interface ChunkCoverage {
  key: string;
  found: boolean;
  /** The distinctive words the check looked for; empty when the chunk had none. */
  words: string[];
  /** The words of that list the check could not find. */
  missing: string[];
}

/**
 * Words that carry no identity. Ordinary English function words, plus the builders' own
 * connectives — the label a builder prints in front of the author's words (`Palette: …`,
 * `Camera: …`, `Art direction: …`) and the negations it always appends (`No characters, no
 * text.`). Those recur in every prompt, so leaving them in would make every chunk look covered by
 * any prompt that happened to keep one prefix — and would report the scaffolding as lost the
 * moment a condensation phrased it differently.
 */
// prettier-ignore
const NOISE = new Set([
  // function words
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'with', 'no',
  'not', 'their', 'they', 'them', 'her', 'his', 'him', 'she', 'he', 'up', 'out', 'over', 'under',
  // the builders' own scaffolding vocabulary
  'palette', 'mood', 'camera', 'subjects', 'subject', 'art', 'direction', 'time', 'day',
  'condition', 'style', 'shot', 'view', 'render', 'single', 'image', 'illustration', 'wearing',
  'characters', 'text', 'ui', 'watermarks', 'frame',
]);

/**
 * A string as a bag of content words: lowercase, punctuation gone, noise dropped, one-character
 * tokens dropped. Numbers survive, which is what makes a hex palette checkable.
 */
export function contentWords(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || NOISE.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * How much of a chunk has to survive to count. A condensation is meant to compress, so
 * demanding every word back would report every successful rewrite as a loss; demanding one word
 * would pass on an accidental collision. A majority is the honest middle, and the number is here
 * rather than inline because it is a judgement call a reader should be able to find.
 */
const KEEP = 0.5;

/** Which chunks the prompt still appears to say. Order follows the chunks given. */
export function coverage(chunks: readonly CoverageInput[], prompt: string): ChunkCoverage[] {
  const said = new Set(contentWords(prompt));
  return chunks.map((c) => {
    const words = contentWords(c.text);
    const missing = words.filter((w) => !said.has(w));
    const kept = words.length - missing.length;
    // A chunk with no distinctive words of its own — pure scaffolding — is never "not found":
    // there was nothing to look for, and reporting it would be noise on every condensation.
    return { key: c.key, found: words.length === 0 || kept >= words.length * KEEP, missing, words };
  });
}

/** Just the keys the prompt does not appear to say — what {@link coverage} is usually asked for. */
export function missingChunks(chunks: readonly CoverageInput[], prompt: string): string[] {
  return coverage(chunks, prompt)
    .filter((c) => !c.found)
    .map((c) => c.key);
}

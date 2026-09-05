/**
 * The fact-checker's pure half.
 *
 * This is the only component that reads the original text, so anything it emits is contaminated
 * by the prose the tool exists to remove. It therefore emits no text at all: the model quotes the
 * drifted words, the quotation is converted to offsets into the revised block, and the string is
 * dropped. A repair sees numbers.
 */

export type FactVerdict = 'unchanged' | 'equivalent' | 'drifted' | 'unverifiable';

export interface FactFinding {
  /** Index of the block in the document's block list. */
  at: number;
  verdict: FactVerdict;
  /** Where the drift sits in the revised block. Present only for `drifted`. */
  span?: { start: number; end: number };
}

export const FACTCHECK_SYSTEM = [
  'You compare an original passage with a revision of it and look only for changes of meaning.',
  'A change of meaning is a claim the revision makes that the original did not, a fact the',
  'revision drops, or an altered name, number, identifier, path or code symbol.',
  'Rewording, reordering and changes of style are not changes of meaning; ignore them.',
  'If the revision changes meaning, reply with the exact words from the REVISION that carry the',
  'change, copied character for character, and nothing else.',
  'If it does not, reply with exactly SAME. Never explain and never quote the original.',
].join(' ');

export function factcheckPrompt(original: string, revised: string): string {
  return `ORIGINAL:\n---\n${original}\n---\n\nREVISION:\n---\n${revised}\n---`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The shortest quotation that locates anything in particular. */
const MIN_SPAN = 6;

/**
 * Finds the quoted words in the revised block, tolerating a different line break inside the
 * quotation because the model sees wrapped prose. Undefined when the quotation is absent, which
 * makes the claim unverifiable rather than true.
 */
export function locateSpan(
  answer: string,
  revised: string,
): { start: number; end: number } | undefined {
  const span = answer
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (span.length < MIN_SPAN) return undefined;

  const at = revised.indexOf(span);
  if (at >= 0) return { start: at, end: at + span.length };

  const loose = new RegExp(escapeRegExp(span).replace(/\s+/g, '\\s+'));
  const match = loose.exec(revised);
  if (!match) return undefined;
  return { start: match.index, end: match.index + match[0].length };
}

/** Reads one answer into a verdict. `SAME` and an empty answer both mean no drift. */
export function readAnswer(answer: string, revised: string): Omit<FactFinding, 'at'> {
  const text = answer.trim();
  if (!text || /^same\b/i.test(text)) return { verdict: 'equivalent' };
  const span = locateSpan(text, revised);
  return span ? { verdict: 'drifted', span } : { verdict: 'unverifiable' };
}

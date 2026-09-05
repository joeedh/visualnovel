/**
 * The revision prompt, which is the artifact stage 2 measures. Changing the contract below
 * invalidates a recorded fixture run.
 */
import { promises as fs } from 'node:fs';

/**
 * Appended after the rules. States the priority the plan settles — a missed violation costs more
 * than a needless rewrite — and the structural constraints that keep a revision spliceable back
 * into the document it came from.
 */
export const CONTRACT = `
You are revising one block of Markdown from a technical document so that it follows the rules
above. You are shown the block and nothing else.

Return the revised block and nothing else. No preamble, no explanation, no code fence around it,
no commentary on what you changed.

Rules for the revision:

- Revise when the call is close. Leaving a violation in place is worse than rewriting a passage
  that was already acceptable. If a sentence arguably breaks a rule, rewrite it.
- Do not change what the text claims. Keep every fact, name, number, identifier and file path
  exactly as given. You may not add information you were not given, and a sentence you cannot
  rewrite without inventing a fact should be left alone.
- Keep the block's Markdown structure. A bullet stays a bullet with the same marker and
  indentation, a heading stays a heading at the same level, inline code stays in backticks, and
  a link keeps its target.
- If the block already follows every rule, return it exactly as given, byte for byte.
`.trim();

/** Builds the system prompt: the rules verbatim, then the contract. */
export async function buildSystem(rulesPath: string): Promise<string> {
  const rules = await fs.readFile(rulesPath, 'utf8');
  return `${rules.trim()}\n\n---\n\n${CONTRACT}`;
}

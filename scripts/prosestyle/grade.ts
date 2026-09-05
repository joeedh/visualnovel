/**
 * Targeted assertions: the half of the rule set whose violation is a construction a regular
 * expression can find. A rule with no entry here is graded by the judge instead, so adding one
 * moves a rule off a model call and onto an exact test.
 *
 * Each pattern matches the violation, so a match in a revision means the violation survived.
 */

const PATTERNS: Record<string, RegExp> = {
  // "…the named window when it still exists, else the focused window…"
  'clause-a-else-b'             : /,\s+else\s/i,
  // "cannot be relied on not to"
  'double-negative'             : /\b(cannot|can ?not|never)\b[^.!?]{0,60}\bnot\b/i,
  // "the next pointerdown anywhere"
  'non-assertive-under-definite': /\bthe\b[^.!?,;]{0,40}\b(any|anywhere|anytime|ever)\b/i,
  // "The prompt an asset is generated from, as commands"
  'head-noun-as'                : /,\s+(as|in the form of)\s+[^.!?]{0,40}[.!?]?\s*$/i,
  // Bold or italic opening after a word has already appeared on the line. One marker or two,
  // since a single asterisk is italic. A list marker is skipped before the test, so the bolded
  // lead-in that labels a bullet does not count as emphasis.
  'rhetorical-emphasis':
    /^[ \t]*(?:[-*+]\s+|\d+\.\s+)?[^\n*_]*[A-Za-z0-9][^\n*_]*(\*{1,2}|_{1,2})\S/m,
};

/**
 * Replaces inline code spans with a bare word. A glob such as `renderer/**` reads as emphasis
 * markup and an identifier carries underscores, so scanning prose rules over code spans reports
 * violations that are not there.
 */
function proseOnly(text: string): string {
  return text.replace(/`[^`]*`/g, 'CODE');
}

/**
 * Whether the named rule's violation is still present. Undefined when no assertion covers the
 * rule, which is the signal to ask the judge.
 */
export function stillViolates(rule: string, text: string): boolean | undefined {
  const pattern = PATTERNS[rule];
  if (!pattern) return undefined;
  return pattern.test(proseOnly(text));
}

/** The rules an assertion covers, so a report can say which results cost nothing to grade. */
export function assertedRules(): string[] {
  return Object.keys(PATTERNS);
}

/**
 * What the judge is asked to look for, one line per rule. Phrased as the violation rather than
 * as the remedy, because the judge answers whether the construction is still there.
 */
const RULE_TEXT: Record<string, string> = {
  'inverted-syntax': 'a sentence in inverted order, where the subject follows the verb',
  personification: 'a non-human subject given a human capacity, such as wanting or remembering',
  'metaphorical-equation':
    'a claim that one thing IS, or is AS, another, standing in for a statement of what happens. ' +
    'For example "The leak scan is the refusal", "what ships is identity", or a sentence whose ' +
    'subject is a clause and whose verb is "is"',
  'fragment-opener':
    'an opening that names a placeholder and defers the real content behind a colon or dash, ' +
    'leaving the first clause without a predicate',
  'double-negative'             : 'a negation of a negation in place of a positive claim',
  'dangling-pronoun':
    'a pronoun or definite phrase with no antecedent anywhere in the passage shown, such as ' +
    '"the second case", "the other two", or "the same applies" where the passage never says ' +
    'which case, which two, or what applies',
  'clause-a-else-b'             : 'an "A, else B" construction in place of separate sentences',
  'adverb-hung': 'an adverb hung off the end of a noun phrase, such as "the handler above"',
  'non-assertive-under-definite':
    'a non-assertive word ("any", "anywhere", "ever") inside a definite description',
  'rhetorical-emphasis'         : 'bold or italic markup used for emphasis inside a sentence',
  'head-noun-as':
    'a head noun that is not what the thing is, retracted through a trailing ", as X" ' +
    'or ", in the form of X"',
  'backticks-non-code':
    'backticks around something that is not an identifier, type, command or glob the reader ' +
    'would type. A documentation file path cited as a reference, such as ' +
    '`docs/reference/thing.md`, must not carry them; a path inside Markdown link text may',
  'comma-fenced-alternative':
    'a subordinate alternative fenced with paired commas where parentheses are needed',
  'jargon-substitute':
    'a non-standard substitute for ordinary engineering jargon, such as "wanted" for "requested"',
  'unquoted-jargon':
    'a word used in a special technical sense that mirrors an everyday word, carrying neither ' +
    'quotation marks nor a parenthesized gloss. For example "the pure half of the renderer", ' +
    'where "pure" means validation-only and is not marked as a term of art',
};

/**
 * The judge's instructions. It must quote the offending words rather than assert that they are
 * there, because a yes/no judge over rules this fuzzy reported a violation in half of all
 * conforming blocks — almost any sentence can be argued to carry mild personification or an
 * outward-pointing reference.
 */
export const JUDGE_SYSTEM = [
  'You look for one specific construction in a passage of technical prose.',
  'If the passage contains it, reply with the exact words from the passage that make up the',
  'construction, copied character for character, and nothing else.',
  'If it does not contain the construction, reply with exactly NONE.',
  'Never explain, never name the rule, and never quote words that are not in the passage.',
  'Reply NONE only when the construction is absent. A borderline or mild instance still counts,',
  'so quote it rather than letting it pass.',
].join(' ');

/** The user turn for one judge call. */
export function judgePrompt(rule: string, text: string): string {
  return `Construction: ${ruleDescription(rule)}\n\nPassage:\n---\n${text}\n---`;
}

const NORMALIZE = /\s+/g;

function normalize(text: string): string {
  return text.replace(NORMALIZE, ' ').trim().toLowerCase();
}

/** The shortest quotation that counts, below which a span identifies nothing in particular. */
const MIN_SPAN = 6;

/**
 * Whether the judge pointed at words the passage actually contains. An answer of NONE, an empty
 * one, and a quotation the passage does not carry all read as no violation — a judge that cannot
 * show the construction has not found one.
 */
export function spanSupported(answer: string, text: string): boolean {
  const span = answer
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!span || /^none\b/i.test(span)) return false;
  const needle = normalize(span);
  return needle.length >= MIN_SPAN && normalize(text).includes(needle);
}

/** The sentence the judge is given for a rule. Throws on an id no fixture should carry. */
export function ruleDescription(rule: string): string {
  const text = RULE_TEXT[rule];
  if (!text) throw new Error(`no judge description for rule "${rule}"`);
  return text;
}

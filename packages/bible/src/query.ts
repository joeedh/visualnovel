/**
 * Grep-shaped ranking over the index. Deliberately simple and deterministic, so a test can pin
 * the result order. This is the layer an embedding store would replace wholesale.
 */
import type { Excerpt, QueryOptions } from './types.js';
import type { IndexedFile } from './indexer.js';

/** Words carrying no signal in a search over prose. */
const STOPWORDS = new Set(
  `a an and are as at be by do does for from how in is it of on or that the this to was were
   what when where which who with`.split(/\s+/),
);

/** Lines of context kept either side of a matching line. */
const CONTEXT = 2;
/** Most windows taken from any one file, so a single long note cannot crowd out the rest. */
const PER_FILE = 3;
const DEFAULT_LIMIT = 8;
const DEFAULT_BUDGET = 4000;
/** Below this many characters left in the budget, ranking stops rather than emitting a stub. */
const MIN_EXCERPT = 120;

/** The searchable terms in a query string. Empty when the query is all stopwords. */
export function terms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const token = raw.replace(/^'+|'+$/g, '');
    if (token.length > 1 && !STOPWORDS.has(token)) seen.add(token);
  }
  return [...seen];
}

/** How many of `tokens` appear anywhere in `haystack`. */
function hits(haystack: string, tokens: string[]): number {
  const lower = haystack.toLowerCase();
  return tokens.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0);
}

/**
 * What a file is worth before any line matches. Title and tags are weighted above headings
 * because they are what a human skimming the tree would have gone by.
 */
function fileScore(file: IndexedFile, tokens: string[]): number {
  return (
    hits(file.title, tokens) * 3 +
    hits(file.tags.join(' '), tokens) * 2 +
    hits(file.headings.join(' '), tokens)
  );
}

/** The best non-overlapping windows in one file, most relevant first. */
function windowsOf(file: IndexedFile, tokens: string[], bonus: number): Excerpt[] {
  const scored: { index: number; score: number }[] = [];
  file.lines.forEach((line, index) => {
    const score = hits(line, tokens);
    if (score > 0) scored.push({ index, score: line.startsWith('#') ? score * 2 : score });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const out: Excerpt[] = [];
  const taken: [number, number][] = [];
  for (const { index, score } of scored) {
    if (out.length >= PER_FILE) break;
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(file.lines.length - 1, index + CONTEXT);
    if (taken.some(([s, e]) => start <= e && end >= s)) continue;
    taken.push([start, end]);
    const text = file.lines
      .slice(start, end + 1)
      .join('\n')
      .trim();
    if (!text) continue;
    const heading = file.headingAt[index];
    out.push({
      file: file.file,
      line: start + 1,
      ...(heading ? { heading } : {}),
      text,
      score: score + bonus,
    });
  }
  return out;
}

/**
 * Rank passages across the index. The returned excerpts never total more characters than
 * `budget`; the last one is truncated rather than exceeding the cap.
 */
export function rank(index: IndexedFile[], text: string, opts: QueryOptions = {}): Excerpt[] {
  const tokens = terms(text);
  if (tokens.length === 0) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const budget = opts.budget ?? DEFAULT_BUDGET;

  const all: Excerpt[] = [];
  for (const file of index) {
    const bonus = fileScore(file, tokens);
    all.push(...windowsOf(file, tokens, bonus));
  }
  all.sort(
    (a, b) =>
      b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line,
  );

  const out: Excerpt[] = [];
  let spent = 0;
  for (const excerpt of all) {
    if (out.length >= limit) break;
    const room = budget - spent;
    if (room < MIN_EXCERPT) break;
    const text = excerpt.text.length <= room ? excerpt.text : `${excerpt.text.slice(0, room - 1)}…`;
    out.push({ ...excerpt, text });
    spent += text.length;
  }
  return out;
}

/**
 * A line diff between two texts, and its unified rendering. Small and dependency-free: the texts
 * it sees are documents an agent edits, a few hundred lines at most, so the quadratic longest
 * common subsequence is fine and Myers is not needed.
 */

/** One line of a diff: kept in both texts, taken out of the first, or added by the second. */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** The longest common subsequence table, `lcs[i][j]` for `a.slice(i)` against `b.slice(j)`. */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array[] {
  const table: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i++) table.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  return table;
}

/** The lines of `text`, without a trailing empty line for a text that ends in a newline. */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Every item of both sequences, in order, each marked by which sequence has it. */
function sequenceDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const table = lcsTable(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'removed', text: a[i]! });
  for (; j < b.length; j++) out.push({ kind: 'added', text: b[j]! });
  return out;
}

/** Every line of both texts, in order, each marked by which text has it. */
export function lineDiff(before: string, after: string): DiffLine[] {
  return sequenceDiff(linesOf(before), linesOf(after));
}

/** A run of text inside a paragraph, marked like a `DiffLine`. */
export type DiffSpan = DiffLine;

/**
 * One paragraph of a word diff. `changed` carries word-level spans; the other three carry one
 * span holding the whole paragraph.
 */
export interface DiffParagraph {
  kind: 'same' | 'removed' | 'added' | 'changed';
  spans: DiffSpan[];
}

/** Words past which a changed paragraph is shown whole rather than word by word. */
export const WORD_DIFF_CAP = 2000;

/**
 * Words, each with the whitespace after it, so the spans join back into the paragraph and a
 * replaced word does not leave its space behind as a match between two changes.
 */
const tokensOf = (text: string): string[] => text.match(/\S+\s*|\s+/g) ?? [];

/** Paragraphs are runs of lines between blank lines, each kept with its inner newlines. */
const paragraphsOf = (text: string): string[] =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.length > 0);

/** Merges adjacent spans of the same kind, which the LCS walk produces one word at a time. */
function coalesce(spans: DiffSpan[]): DiffSpan[] {
  const out: DiffSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/**
 * A diff of two prose texts by paragraph, with the words compared inside each paragraph that
 * changed. A removed paragraph next to an added one is read as the same paragraph edited; a
 * paragraph over `cap` words is shown whole on both sides instead.
 */
export function wordDiff(before: string, after: string, cap = WORD_DIFF_CAP): DiffParagraph[] {
  const lines = sequenceDiff(paragraphsOf(before), paragraphsOf(after));
  const out: DiffParagraph[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'same') {
      out.push({ kind: 'same', spans: [{ kind: 'same', text: line.text }] });
      i++;
      continue;
    }
    // A run of removed paragraphs followed by a run of added ones pairs off in order
    const removed: string[] = [];
    const added: string[] = [];
    while (i < lines.length && lines[i]!.kind === 'removed') removed.push(lines[i++]!.text);
    while (i < lines.length && lines[i]!.kind === 'added') added.push(lines[i++]!.text);
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const a = tokensOf(removed[k]!);
      const b = tokensOf(added[k]!);
      if (a.length > cap || b.length > cap) {
        out.push({ kind: 'removed', spans: [{ kind: 'removed', text: removed[k]! }] });
        out.push({ kind: 'added', spans: [{ kind: 'added', text: added[k]! }] });
      } else {
        out.push({ kind: 'changed', spans: coalesce(sequenceDiff(a, b)) });
      }
    }
    for (const text of removed.slice(pairs)) {
      out.push({ kind: 'removed', spans: [{ kind: 'removed', text }] });
    }
    for (const text of added.slice(pairs))
      out.push({ kind: 'added', spans: [{ kind: 'added', text }] });
  }
  return out;
}

/** How many unchanged lines a hunk carries either side of a change. */
const CONTEXT = 3;

/**
 * The diff as `git diff` prints it, minus the file header: `@@ -from,count +from,count @@` over
 * each run of changes with `CONTEXT` lines either side, ` `, `-` and `+` marking the lines.
 * Empty when the texts are the same.
 */
export function unifiedDiff(before: string, after: string, context = CONTEXT): string {
  const lines = lineDiff(before, after);
  if (!lines.some((l) => l.kind !== 'same')) return '';

  // Line numbers in each text, per diff line, so a hunk header can be written from its first line
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const line of lines) {
    oldAt.push(o);
    newAt.push(n);
    if (line.kind !== 'added') o++;
    if (line.kind !== 'removed') n++;
  }

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind === 'same') {
      i++;
      continue;
    }
    // A hunk runs from `context` before this change to `context` after the last change whose gap
    // from the previous one is within twice the context, as git merges them
    const start = Math.max(0, i - context);
    let end = i;
    let last = i;
    while (end < lines.length) {
      if (lines[end]!.kind !== 'same') last = end;
      else if (end - last > context * 2) break;
      end++;
    }
    end = Math.min(lines.length, last + context + 1);

    const chunk = lines.slice(start, end);
    const oldCount = chunk.filter((l) => l.kind !== 'added').length;
    const newCount = chunk.filter((l) => l.kind !== 'removed').length;
    // An empty side is numbered from the line before it, as git does
    const from = (at: number, count: number): number => (count === 0 ? at - 1 : at);
    out.push(
      `@@ -${from(oldAt[start]!, oldCount)},${oldCount} +${from(newAt[start]!, newCount)},${newCount} @@`,
    );
    for (const line of chunk) {
      const mark = line.kind === 'same' ? ' ' : line.kind === 'removed' ? '-' : '+';
      out.push(`${mark}${line.text}`);
    }
    i = end;
  }
  return out.join('\n');
}

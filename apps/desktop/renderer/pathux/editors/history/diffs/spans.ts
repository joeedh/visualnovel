/**
 * What every text diff shares: the spans of a paragraph drawn as struck and underlined runs, the
 * paragraphs cut down to the changed ones and their neighbours, and a paragraph's spans split
 * into lines so the scene diff can draw each line as the Script pane would.
 */
import type { DiffParagraph, DiffSpan } from '../../../../../src/shared/history.js';

/** Unchanged items kept either side of a change; the rest fold behind a count. */
export const CONTEXT = 2;
/** A run of unchanged items shorter than this is shown rather than folded. */
const SHORTEST_FOLD = 4;

/** A paragraph to draw, or a run of unchanged ones folded behind their count. */
export type Shown =
  { kind: 'paragraph'; paragraph: DiffParagraph } | { kind: 'fold'; count: number };

/**
 * Which items to draw: every changed one, `CONTEXT` unchanged ones either side, and any run of
 * unchanged ones too short to be worth a fold. A diff with no change at all is shown whole, since
 * folding everything would draw nothing.
 */
export function kept(changed: readonly boolean[]): boolean[] {
  if (!changed.some(Boolean)) return changed.map(() => true);
  const keep = changed.map((_, i) => {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(changed.length - 1, i + CONTEXT); j++) {
      if (changed[j]) return true;
    }
    return false;
  });
  let start = -1;
  for (let i = 0; i <= keep.length; i++) {
    if (i < keep.length && !keep[i]) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start < SHORTEST_FOLD) keep.fill(true, start, i);
    start = -1;
  }
  return keep;
}

/** The paragraphs worth drawing, with each folded run as one entry. */
export function withContext(paragraphs: readonly DiffParagraph[]): Shown[] {
  const keep = kept(paragraphs.map((p) => p.kind !== 'same'));
  const out: Shown[] = [];
  let folded = 0;
  for (const [i, paragraph] of paragraphs.entries()) {
    if (keep[i]) {
      if (folded > 0) out.push({ kind: 'fold', count: folded });
      folded = 0;
      out.push({ kind: 'paragraph', paragraph });
    } else {
      folded++;
    }
  }
  if (folded > 0) out.push({ kind: 'fold', count: folded });
  return out;
}

/** The fold row's sentence. */
export function foldSentence(count: number): string {
  return `${count} unchanged paragraph${count === 1 ? '' : 's'}`;
}

/**
 * Draws the spans into `into`: removed text struck, added text underlined, the rest plain. The
 * colour is on the words alone, which is the one place the pane uses jade and vermilion.
 */
export function drawSpans(into: HTMLElement, spans: readonly DiffSpan[]): void {
  for (const span of spans) {
    if (span.kind === 'same') {
      into.appendChild(document.createTextNode(span.text));
      continue;
    }
    const node = document.createElement(span.kind === 'removed' ? 'del' : 'ins');
    node.className = `hd-${span.kind}`;
    node.textContent = span.text;
    into.appendChild(node);
  }
}

/** One line of a paragraph, as the spans that fall on it. */
export interface SpanLine {
  spans: DiffSpan[];
  /** The line's text with the marks dropped, which is what classifies it. */
  text: string;
}

/**
 * A paragraph's spans split at every newline, so a line can be drawn on its own while each of its
 * words keeps its mark. A span that ends in a newline ends its line; the newline itself is not
 * drawn, since the line is.
 */
export function linesOf(paragraph: DiffParagraph): SpanLine[] {
  const lines: SpanLine[] = [{ spans: [], text: '' }];
  for (const span of paragraph.spans) {
    const pieces = span.text.split('\n');
    for (const [i, piece] of pieces.entries()) {
      if (i > 0) lines.push({ spans: [], text: '' });
      if (piece === '') continue;
      const line = lines[lines.length - 1]!;
      line.spans.push({ kind: span.kind, text: piece });
      line.text += piece;
    }
  }
  // A paragraph is kept with its inner newlines and never a trailing one; a blank last line is
  // the trailing whitespace of a token, not a line
  while (lines.length > 1 && lines[lines.length - 1]!.text.trim() === '') lines.pop();
  return lines;
}

/**
 * The word diff of a scene, drawn as the Script pane draws the scene: a cue over its dialogue,
 * action as prose, a line's id in the gutter, a marker in the mono face. There is no `+`/`-`
 * gutter; a removed word is struck and an added one underlined, inside the line it belongs to.
 *
 * A paragraph is classified from its text with the marks dropped, so a cue whose name changed is
 * still a cue. The classes mirror `script.css` so the same line looks the same in both panes.
 */
import type { DiffParagraph } from '../../../../../src/shared/history.js';
import { drawSpans, foldSentence, linesOf, withContext, type SpanLine } from './spans.js';

const LINE_ID = /^\[\[line:\s*([^\]]+)\]\]$/;
const MARKER = /^\[\[.*\]\]$/;
const FRONT_MATTER = /^---$/;
const HEADING = /^(INT|EXT|EST|INT\.?\/EXT|I\/E)[\s.]/i;
const TRANSITION = /^[A-Z][A-Z\s]*TO:$/;
const PARENTHETICAL = /^\(.*\)$/;

export type LineKind =
  'heading' | 'cue' | 'dialogue' | 'parenthetical' | 'action' | 'transition' | 'marker' | 'data';

/** A cue is an uppercase line that has dialogue under it. */
function isCue(line: SpanLine, hasMore: boolean): boolean {
  const text = line.text.trim();
  return hasMore && text.length > 0 && text === text.toUpperCase() && /[A-Z]/.test(text);
}

/** The kinds of each line of one paragraph, read in order, since a cue changes what follows it. */
export function classify(lines: SpanLine[], data: boolean): LineKind[] {
  const kinds: LineKind[] = [];
  let inDialogue = false;
  const spoken = lines.filter((l) => !LINE_ID.test(l.text.trim()) && !MARKER.test(l.text.trim()));
  for (const [i, line] of lines.entries()) {
    const text = line.text.trim();
    if (data) kinds.push('data');
    else if (MARKER.test(text)) kinds.push('marker');
    else if (i === 0 && HEADING.test(text)) kinds.push('heading');
    else if (i === 0 && TRANSITION.test(text)) kinds.push('transition');
    else if (!inDialogue && spoken[0] === line && isCue(line, spoken.length > 1)) {
      kinds.push('cue');
      inDialogue = true;
    } else if (inDialogue && PARENTHETICAL.test(text)) kinds.push('parenthetical');
    else kinds.push(inDialogue ? 'dialogue' : 'action');
  }
  return kinds;
}

export function drawScene(paragraphs: readonly DiffParagraph[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hd-scene';
  for (const shown of withContext(paragraphs)) {
    if (shown.kind === 'fold') {
      const fold = document.createElement('div');
      fold.className = 'hd-fold';
      fold.textContent = foldSentence(shown.count);
      root.appendChild(fold);
      continue;
    }
    const lines = linesOf(shown.paragraph);
    const block = document.createElement('div');
    block.className = `hd-block hd-p-${shown.paragraph.kind}`;
    // The front matter has no blank line inside it, so it is the one paragraph opening with `---`
    const kinds = classify(lines, FRONT_MATTER.test(lines[0]?.text.trim() ?? ''));
    let id = '';
    for (const [i, line] of lines.entries()) {
      const text = line.text.trim();
      const named = LINE_ID.exec(text);
      // A line id captions the line under it, the way the Script pane's gutter does
      if (named && kinds[i] !== 'data') {
        id = named[1] ?? '';
        continue;
      }
      const row = document.createElement('div');
      row.className = `hd-line hd-${kinds[i]}`;
      const gutter = document.createElement('span');
      gutter.className = 'hd-lid';
      gutter.textContent = id;
      const body = document.createElement('span');
      body.className = 'hd-text';
      drawSpans(body, line.spans);
      row.append(gutter, body);
      block.appendChild(row);
      id = '';
    }
    root.appendChild(block);
  }
  return root;
}

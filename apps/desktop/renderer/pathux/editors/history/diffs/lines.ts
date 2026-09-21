/**
 * The line diff of a storyboard, a graph, `project.yaml`, a layout, or anything else that is
 * text but not prose, in the mono face. The colour is on the changed line's text, with the same
 * two-line context and folds the prose diffs use, so a long file reads as its changes.
 */
import type { DiffLine } from '../../../../../src/shared/history.js';
import { foldSentence, kept } from './spans.js';

export function drawLines(lines: readonly DiffLine[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hd-lines';
  const keep = kept(lines.map((l) => l.kind !== 'same'));
  let folded = 0;
  const flush = () => {
    if (folded === 0) return;
    const fold = document.createElement('div');
    fold.className = 'hd-fold';
    fold.textContent = foldSentence(folded).replace('paragraph', 'line');
    root.appendChild(fold);
    folded = 0;
  };
  for (const [i, line] of lines.entries()) {
    if (!keep[i]) {
      folded++;
      continue;
    }
    flush();
    const row = document.createElement('div');
    row.className = `hd-code hd-${line.kind}`;
    row.textContent = line.text === '' ? ' ' : line.text;
    root.appendChild(row);
  }
  flush();
  return root;
}

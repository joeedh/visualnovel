/**
 * The word diff of a wiki note or a sheet, drawn as paragraphs in the prose face: removed words
 * struck, added words underlined, unchanged paragraphs folded away beyond the two either side of
 * a change. A sheet's front matter is one paragraph of `key: value` lines, drawn in the mono
 * face so it reads as the data it is.
 */
import type { DiffParagraph } from '../../../../../src/shared/history.js';
import { drawSpans, foldSentence, withContext } from './spans.js';

const FRONT_MATTER = /^---\n/;

/** Whether the paragraph is a sheet's front matter block rather than its prose. */
function isData(paragraph: DiffParagraph): boolean {
  return FRONT_MATTER.test(paragraph.spans.map((s) => s.text).join(''));
}

export function drawProse(paragraphs: readonly DiffParagraph[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hd-prose';
  for (const shown of withContext(paragraphs)) {
    if (shown.kind === 'fold') {
      const fold = document.createElement('div');
      fold.className = 'hd-fold';
      fold.textContent = foldSentence(shown.count);
      root.appendChild(fold);
      continue;
    }
    const { paragraph } = shown;
    const p = document.createElement('p');
    p.className = `hd-p hd-p-${paragraph.kind}${isData(paragraph) ? ' hd-data' : ''}`;
    drawSpans(p, paragraph.spans);
    root.appendChild(p);
  }
  return root;
}

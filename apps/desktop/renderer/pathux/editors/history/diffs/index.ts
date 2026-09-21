/**
 * One diff drawn for its kind. The shape `git.diff` answered decides most of it; a prose diff of
 * a scene is drawn as script and of anything else as paragraphs.
 */
import type { Diff, FileKind } from '../../../../../src/shared/history.js';
import { drawLines } from './lines.js';
import { drawBinary, drawLog } from './log.js';
import { drawPicture } from './picture.js';
import { drawProse } from './prose.js';
import { drawScene } from './scene.js';

export function drawDiff(diff: Diff, kind: FileKind): HTMLElement {
  switch (diff.kind) {
    case 'prose':
      return kind === 'scene' ? drawScene(diff.paragraphs) : drawProse(diff.paragraphs);
    case 'lines':
      return drawLines(diff.lines);
    case 'picture':
      return drawPicture(diff);
    case 'log':
      return drawLog(diff);
    case 'binary':
      return drawBinary(diff);
  }
}

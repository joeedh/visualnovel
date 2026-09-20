/** The Wiki pane's situations: whether a page is open, and whether it has changed. */
import { situations } from './situation.js';
import type { WikiState } from '../wiki.js';

export const SITUATIONS = situations<WikiState>(
  {
    name : 'none-open',
    why  : 'No page is open, so Save and the text box are refused; reload stays offered.',
    state: { path: '', dirty: false },
  },
  {
    name : 'open',
    why  : 'A page is open and unchanged, so Save is refused with Nothing to save.',
    state: { path: 'characters/aiko/character.md', dirty: false },
  },
  {
    name : 'open-read-only',
    why  : 'The open page cannot be written, so the toolbar refuses to place a picture in it.',
    state: { path: 'characters/aiko/character.md', dirty: false, readOnly: true },
  },
  {
    name : 'open-detached',
    why: 'A form the author typed into has closed with its answers unapplied, so the footer offers to discard them.',
    state: { path: 'characters/aiko/character.md', dirty: true, detached: 1 },
  },
  {
    name : 'open-raw',
    why: 'The page is shown as Markdown source, so the bar offers the rich view back and the box is the source.',
    state: { path: 'characters/aiko/character.md', dirty: false, raw: true },
  },
  {
    name : 'open-raw-stale',
    why: 'Source typed into the raw view was overtaken by an edit to the document, so the footer offers to discard it.',
    state: { path: 'characters/aiko/character.md', dirty: true, raw: true, stale: true },
  },
  {
    name : 'open-dirty',
    why: 'The open page has changed, so Save is offered, and one picture drawn from it opens in the asset editor.',
    state: {
      path : 'characters/aiko/character.md',
      dirty: true,
      strip: {
        assets : [{ hash: 'a1b2c3d4', label: 'Aiko — uniform / front', accepted: true }],
        visible: ['wiki'],
      },
    },
  },
);

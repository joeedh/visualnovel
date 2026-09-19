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
    name : 'open-detached',
    why: 'A form the author typed into has closed with its answers unapplied, so the footer offers to discard them.',
    state: { path: 'characters/aiko/character.md', dirty: true, detached: 1 },
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

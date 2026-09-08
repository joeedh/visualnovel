/** The Wiki pane's situations: whether a page is open, and whether it has changed. */
import { situations } from './situation.js';
import type { WikiState } from '../wiki.js';

export const SITUATIONS = situations<WikiState>(
  {
    name : 'none-open',
    why  : 'No page is open, so Save is refused.',
    state: { path: '', dirty: false },
  },
  {
    name : 'open',
    why  : 'A page is open and unchanged, so Save is refused with Nothing to save.',
    state: { path: 'characters/aiko/character.md', dirty: false },
  },
  {
    name : 'open-dirty',
    why  : 'The open page has changed, so Save is offered.',
    state: { path: 'characters/aiko/character.md', dirty: true },
  },
);

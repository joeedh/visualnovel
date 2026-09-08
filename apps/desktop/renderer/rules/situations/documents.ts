/** The Documents pane's situations: whether a row holds the rename box. */
import { situations } from './situation.js';
import type { DocumentsState } from '../documents.js';

export const SITUATIONS = situations<DocumentsState>(
  { name: 'idle', why: 'Only the New… button is drawn.', state: {} },
  {
    name : 'renaming',
    why  : 'A row holds the rename box, which commits doc.rename on the document it stands in.',
    state: { renaming: { path: 'characters/aiko/character.md', name: 'Aiko' } },
  },
);

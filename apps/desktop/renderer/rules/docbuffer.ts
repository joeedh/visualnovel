/** What a document buffer's Save button offers, shared by the wiki and skills panes. */
import { refuse, type Offer } from './anchors.js';

/**
 * Write the open file back to disk. The text and the hash it was read at belong to the buffer
 * rather than the bar, so the click supplies them. Refuses with no file open, then with nothing
 * changed, in that order.
 */
export function saveOffer(path: string, dirty: boolean): Offer {
  const control = {
    id      : 'doc.write',
    label   : 'Save',
    tooltip : 'Write this file back to disk, and commit it',
    supplies: ['text', 'seenHash'],
  };
  if (path === '') return { ...refuse('No document is open.'), ...control };
  if (!dirty) return { ...refuse('Nothing to save'), ...control };
  return { ok: true, props: { path }, ...control };
}

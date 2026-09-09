/** What a document buffer's bar and text box offer, shared by the wiki and skills panes. */
import { refuse, type Offer } from './anchors.js';
import { view } from './effects.js';

/** The bar's `⟳`; `tooltip` names what is re-read. */
export function reloadOffer(tooltip: string): Offer {
  return { ok: true, ...view('reload'), on: 'reload', label: '⟳', tooltip };
}

/**
 * The text box the open file is edited in. Its contents are what Save supplies, so the box is the
 * same write under `text`, refused only while no file is open.
 */
export function textBox(path: string, tooltip: string): Offer {
  const control = {
    id   : 'doc.write',
    on   : 'text',
    label: 'The file, as text',
    tooltip,
    supplies: ['text', 'seenHash'],
  };
  if (path === '') return { ...refuse('No document is open.'), ...control };
  return { ok: true, props: { path }, ...control };
}

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

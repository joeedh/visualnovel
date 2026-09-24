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
 * Answers why a move of `paths` is refused before it runs, or `undefined`: one of them, or a
 * file inside a folder among them, has unsaved edits in `dirty`. A move does not carry a draft
 * along, so the author saves first. The Paste entry and Ctrl+V both use this sentence.
 */
export function unsavedRefusal(
  paths: readonly string[],
  dirty: readonly string[],
): string | undefined {
  const held = dirty.find((path) => paths.some((p) => path === p || path.startsWith(`${p}/`)));
  return held === undefined ? undefined : `Save ${held} first — it has unsaved edits.`;
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

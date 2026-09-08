/** What the Documents pane's two writes offer. Neither is ever refused. */
import type { Offer } from './anchors.js';

/** What the Documents pane reads when it draws its bar and its rename box. */
export interface DocumentsState {
  /** The document whose row holds the rename box, while one does. */
  renaming?: { path: string; name: string };
}

/**
 * Start a new document. The button rather than the row it opens, because pressing it is where
 * writing a document starts, and the kind and the name are both typed after it.
 */
export function createAction(): Offer {
  return {
    ok      : true,
    id      : 'doc.create',
    props   : {},
    label   : 'New…',
    tooltip : 'Add a character, location, page or skill to this project',
    supplies: ['kind', 'name'],
  };
}

/** Rename one document. The box's text is the new name, so the commit supplies it. */
export function renameAction(target: { path: string; name: string }): Offer {
  return {
    ok      : true,
    id      : 'doc.rename',
    props   : { path: target.path },
    label   : target.name,
    tooltip : 'Type the new name — Enter renames the document, Escape leaves it as it was',
    supplies: ['name'],
  };
}

/** Every offer the Documents pane draws from this module. */
export function controls(state: DocumentsState): readonly Offer[] {
  const list: Offer[] = [createAction()];
  if (state.renaming) list.push(renameAction(state.renaming));
  return list;
}

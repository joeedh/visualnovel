/** What the Wiki pane offers: one write over the buffer it holds, its bar, and the art strip. */
import type { EditorId } from '../../src/shared/editors.js';
import type { Offer } from './anchors.js';
import { cellAction, type StripAsset } from './assetstrip.js';
import { reloadOffer, saveOffer, textBox } from './docbuffer.js';

export const TEXT_TIP =
  'Edit the document as markdown, front-matter and all. Ctrl+S saves and commits.';
export const RELOAD_TIP = 'Re-read this document from disk (discards an unsaved draft)';

/** What the Wiki pane reads when it draws its bar, its box and its strip. */
export interface WikiState {
  /** The open page's path, or the empty string with nothing open. */
  path: string;
  dirty: boolean;
  /** The art drawn from the open page, and the editors some pane shows, which routes a pick. */
  strip?: { assets: readonly StripAsset[]; visible: readonly EditorId[] };
}

/** Every offer the Wiki pane draws from this module: Save, reload, the box, then the strip. */
export function controls(state: WikiState): readonly Offer[] {
  const strip = state.strip;
  return [
    saveOffer(state.path, state.dirty),
    reloadOffer(RELOAD_TIP),
    textBox(state.path, TEXT_TIP),
    ...(strip ? strip.assets.map((asset) => cellAction(asset, strip.visible)) : []),
  ];
}

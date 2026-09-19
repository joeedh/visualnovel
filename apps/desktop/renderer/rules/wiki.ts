/** What the Wiki pane offers: one write over the buffer it holds, its bar, and the art strip. */
import type { EditorId } from '../../src/shared/editors.js';
import type { Offer } from './anchors.js';
import { cellAction, type StripAsset } from './assetstrip.js';
import { reloadOffer, saveOffer, textBox } from './docbuffer.js';
import { view } from './effects.js';

export const TEXT_TIP =
  'Edit the document; a sheet shows its front matter as a form. Ctrl+S saves and commits.';
export const RELOAD_TIP = 'Re-read this document from disk (discards an unsaved draft)';

/** What the Wiki pane reads when it draws its bar, its box and its strip. */
export interface WikiState {
  /** The open page's path, or the empty string with nothing open. */
  path: string;
  dirty: boolean;
  /** Form answers typed into a view that has since closed, which a save refuses until resolved. */
  detached?: number;
  /** The art drawn from the open page, and the editors some pane shows, which routes a pick. */
  strip?: { assets: readonly StripAsset[]; visible: readonly EditorId[] };
}

/**
 * The footer's way out of a refused save: drop the answers a closed form left behind. Shown only
 * while there are some, so it is never refused.
 */
export function discardOffer(detached: number): Offer {
  const answers = detached === 1 ? 'the answer' : `the ${detached} answers`;
  return {
    ok: true,
    ...view('reload'),
    on     : 'discard',
    label  : 'Discard pending edits',
    tooltip: `Drop ${answers} a form that has since closed left unapplied, so the document can be saved`,
  };
}

/** Every offer the Wiki pane draws from this module: Save, reload, the box, then the strip. */
export function controls(state: WikiState): readonly Offer[] {
  const strip = state.strip;
  const detached = state.detached ?? 0;
  return [
    saveOffer(state.path, state.dirty),
    reloadOffer(RELOAD_TIP),
    textBox(state.path, TEXT_TIP),
    ...(detached > 0 ? [discardOffer(detached)] : []),
    ...(strip ? strip.assets.map((asset) => cellAction(asset, strip.visible)) : []),
  ];
}

/** What the Wiki pane offers: one write over the buffer it holds, its bar, and the art strip. */
import type { EditorId } from '../../src/shared/editors.js';
import { refuse, type Offer } from './anchors.js';
import { cellAction, type StripAsset } from './assetstrip.js';
import { reloadOffer, saveOffer, textBox } from './docbuffer.js';
import { view } from './effects.js';

export const TEXT_TIP =
  'Edit the document; a sheet shows its front matter as a form. Ctrl+S saves and commits.';
export const RAW_TIP =
  'Edit the document as Markdown source, front matter included. Ctrl+S saves and commits.';
export const RELOAD_TIP = 'Re-read this document from disk (discards an unsaved draft)';

/** What the Wiki pane reads when it draws its bar, its box and its strip. */
export interface WikiState {
  /** The open page's path, or the empty string with nothing open. */
  path: string;
  dirty: boolean;
  /** Whether the pane shows Markdown source in place of the rich view. Off on every open. */
  raw?: boolean;
  /** Form answers typed into a view that has since closed, which a save refuses until resolved. */
  detached?: number;
  /** Whether the document moved under source typed into the raw view, which a save then refuses. */
  stale?: boolean;
  /** The art drawn from the open page, and the editors some pane shows, which routes a pick. */
  strip?: { assets: readonly StripAsset[]; visible: readonly EditorId[] };
}

/**
 * The bar's switch between the rich view and the document's Markdown source. Labelled with the
 * view a press shows, since the tooltip describes that view. Both views edit one session, so an
 * edit made in either is one step in the same undo history.
 */
export function rawOffer(raw: boolean, path: string): Offer {
  const mode = view('mode');
  const control = raw
    ? {
        id     : mode.id,
        on     : 'raw',
        label  : 'Rich',
        tooltip:
          'Show this document in the rich view; the source typed here is applied first, as one undoable edit',
      }
    : {
        id     : mode.id,
        on     : 'raw',
        label  : 'Raw',
        tooltip:
          'Show this document as Markdown source; edits here and in the rich view share one undo history',
      };
  if (path === '') return { ...refuse('No document is open.'), ...control };
  return { ok: true, props: mode.props, ...control };
}

/**
 * The footer's way out of a refused save: drop the answers a closed form left behind, or source
 * typed into the raw view after the document moved under it. Shown only while there is something
 * to drop, so it is never refused.
 */
export function discardOffer(detached: number, stale = false): Offer {
  const answers = detached === 1 ? 'the answer' : `the ${detached} answers`;
  const what =
    detached === 0 && stale
      ? 'the source typed here, which the document has changed under,'
      : `${answers} a form that has since closed left unapplied`;
  return {
    ok: true,
    ...view('reload'),
    on     : 'discard',
    label  : 'Discard pending edits',
    tooltip: `Drop ${what} so the document can be saved`,
  };
}

/** Every offer the Wiki pane draws from this module: the bar, the box, the footer, the strip. */
export function controls(state: WikiState): readonly Offer[] {
  const strip = state.strip;
  const detached = state.detached ?? 0;
  const raw = state.raw === true;
  const stale = state.stale === true;
  return [
    saveOffer(state.path, state.dirty),
    reloadOffer(RELOAD_TIP),
    rawOffer(raw, state.path),
    textBox(state.path, raw ? RAW_TIP : TEXT_TIP),
    ...(detached > 0 || stale ? [discardOffer(detached, stale)] : []),
    ...(strip ? strip.assets.map((asset) => cellAction(asset, strip.visible)) : []),
  ];
}

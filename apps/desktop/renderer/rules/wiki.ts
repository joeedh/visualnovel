/** What the Wiki pane offers: one write over the buffer it holds, its bar, and the art strip. */
import type { EditorId } from '../../src/shared/editors.js';
import type { DocNode } from '../../src/shared/ipc.js';
import { refuse, type Offer } from './anchors.js';
import { cellAction, type StripAsset } from './assetstrip.js';
import { reloadOffer, saveOffer, textBox } from './docbuffer.js';
import { publish, view } from './effects.js';
import { openOf, routeFor } from './route.js';

export const TEXT_TIP =
  'Edit the document; a sheet shows its front matter as a form. Ctrl+S saves and commits.';
export const RAW_TIP =
  'Edit the document as Markdown source, front matter included. Ctrl+S saves and commits.';
export const RELOAD_TIP = 'Re-read this document from disk (discards an unsaved draft)';
export const PICTURE_TIP = "Pick a picture from the project's assets and place it at the cursor";
export const LINK_TIP =
  'Link to a character, location, scene or page in this project (or type [[ in the text)';

/** What the Wiki pane reads when it draws its bar, its box and its strip. */
export interface WikiState {
  /** The open page's path, or the empty string with nothing open. */
  path: string;
  dirty: boolean;
  /** Whether the pane shows Markdown source in place of the rich view. Off on every open. */
  raw?: boolean;
  /** Whether the open document cannot be written, which refuses the toolbar's picture and link. */
  readOnly?: boolean;
  /** Form answers typed into a view that has since closed, which a save refuses until resolved. */
  detached?: number;
  /** Whether the document moved under source typed into the raw view, which a save then refuses. */
  stale?: boolean;
  /** The art drawn from the open page, and the editors some pane shows, which routes a pick. */
  strip?: { assets: readonly StripAsset[]; visible: readonly EditorId[] };
  /** The documents a typed `[[` is offering links to, while the completion is open. */
  completion?: { targets: readonly DocNode[]; visible: readonly EditorId[] };
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
 * The rich view's Insert a picture. The pick lands in the text Save writes, so the button is the
 * same write as the box under its own `on`; refused with nothing open, then for a document the
 * app cannot write.
 */
export function pictureOffer(path: string, readOnly = false): Offer {
  const control = {
    id      : 'doc.write',
    on      : 'picture',
    label   : 'Insert a picture',
    tooltip : PICTURE_TIP,
    supplies: ['text', 'seenHash'],
  };
  if (path === '') return { ...refuse('No document is open.'), ...control };
  if (readOnly) return { ...refuse('This document cannot be written'), ...control };
  return { ok: true, props: { path }, ...control };
}

/**
 * The rich view's Insert a link. A press types `[[` at the cursor and opens the completion the
 * typed pair opens, so the pick lands in the text Save writes and the button is that write under
 * its own `on`; refused with nothing open, then for a document the app cannot write.
 */
export function linkOffer(path: string, readOnly = false): Offer {
  const control = {
    id      : 'doc.write',
    on      : 'link',
    label   : 'Insert a link',
    tooltip : LINK_TIP,
    supplies: ['text', 'seenHash'],
  };
  if (path === '') return { ...refuse('No document is open.'), ...control };
  if (readOnly) return { ...refuse('This document cannot be written'), ...control };
  return { ok: true, props: { path }, ...control };
}

/**
 * One row of the link completion. Enter or a click writes a link to the document into the prose
 * and opens nothing, so the row records where the link would lead: the `view.open` its route
 * gives, or the selection alone for a document nothing claims, so the sweep sees what a pick
 * writes to. Keyed `link/doc/<path>`.
 */
export function linkRow(target: DocNode, visible: readonly EditorId[]): Offer {
  const path = target.path ?? '';
  const open = openOf(routeFor({ node: target, visible }));
  return {
    ok: true,
    ...(open ?? publish({ docPath: path })),
    on     : `link/doc/${path}`,
    label  : target.label,
    tooltip: `Link to ${target.label} (${path}) — Enter or a click writes it into the text`,
  };
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

/** Every offer the Wiki pane draws from this module: the bar, the box, its toolbar, the footer, the strip. */
export function controls(state: WikiState): readonly Offer[] {
  const strip = state.strip;
  const completion = state.completion;
  const detached = state.detached ?? 0;
  const raw = state.raw === true;
  const stale = state.stale === true;
  return [
    saveOffer(state.path, state.dirty),
    reloadOffer(RELOAD_TIP),
    rawOffer(raw, state.path),
    textBox(state.path, raw ? RAW_TIP : TEXT_TIP),
    ...(raw
      ? []
      : [
          pictureOffer(state.path, state.readOnly === true),
          linkOffer(state.path, state.readOnly === true),
        ]),
    ...(detached > 0 || stale ? [discardOffer(detached, stale)] : []),
    ...(strip ? strip.assets.map((asset) => cellAction(asset, strip.visible)) : []),
    ...(completion ? completion.targets.map((target) => linkRow(target, completion.visible)) : []),
  ];
}

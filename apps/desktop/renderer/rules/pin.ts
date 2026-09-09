/** What the pin toggle in a pinnable pane's header offers: hold the pane, or follow again. */
import { EDITORS, PIN_NOUN, type EditorId, type PinField } from '../../src/shared/editors.js';
import type { Offer } from './anchors.js';
import { pin } from './effects.js';

/** What the toggle reads when it is drawn. */
export interface PinState {
  /** Whether the pane is held on its subject. */
  pinned: boolean;
}

/** One editor that can be pinned, and the selection field it holds. */
export interface Pinnable {
  editor: EditorId;
  field: PinField;
}

/** Every editor that declares `pins`, in `EDITORS` order. */
export const PINNABLE: readonly Pinnable[] = EDITORS.flatMap((entry) =>
  'pins' in entry ? [{ editor: entry.id, field: entry.pins }] : [],
);

/** The toggle: pinning holds the pane, unpinning lets it follow the selection again. */
export function pinAction(field: PinField, pinned: boolean): Offer {
  const noun = PIN_NOUN[field];
  return {
    ok: true,
    ...pin(!pinned),
    label  : `pin ${noun}`,
    tooltip: pinned
      ? `Pinned to this ${noun}. Click to follow the selection again.`
      : `Keep this pane on this ${noun} while the rest of the app moves on.`,
  };
}

/** Every offer the toggle draws from this module, for the pane holding `field`. */
export function controls(field: PinField, state: PinState): readonly Offer[] {
  return [pinAction(field, state.pinned)];
}

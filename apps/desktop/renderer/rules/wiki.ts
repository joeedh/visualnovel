/** What the Wiki pane's bar offers: one write, over the buffer it holds. */
import type { Offer } from './anchors.js';
import { saveOffer } from './docbuffer.js';

/** What the Wiki pane reads when it draws its bar. */
export interface WikiState {
  /** The open page's path, or the empty string with nothing open. */
  path: string;
  dirty: boolean;
}

/** Every offer the Wiki pane draws from this module. */
export function controls(state: WikiState): readonly Offer[] {
  return [saveOffer(state.path, state.dirty)];
}

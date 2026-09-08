/**
 * What the approvals popup offers: one row per picture waiting on approval. A row closes the
 * popup and opens the picture in the Asset editor, which is where the author sees it before
 * deciding; nothing here approves. The popup is an anchor home like the header, so its anchors
 * are live while it is up and gone when it closes.
 */
import type { Approvable } from '@vn/authoring';
import type { Offer } from './anchors.js';
import { closePopup } from './effects.js';

/** What the popup reads when it draws its rows. */
export interface ApprovalsState {
  items: readonly Approvable[];
}

/**
 * One picture's row. A blocked row is offered like any other, because what it is waiting on is
 * worth reading and the Asset editor is where the author acts on it.
 */
export function rowAction(item: Approvable): Offer {
  return {
    ok: true,
    ...closePopup('approvals'),
    on     : item.hash,
    label  : `[${item.kind}] ${item.label} — ${item.slot}`,
    tooltip: item.blocked
      ? `${item.blocked} Opens ${item.label} in the Asset editor all the same.`
      : `Open ${item.label} in the Asset editor.`,
    then: [{ id: 'view.open', props: { editor: 'asset', where: 'elsewhere', subject: item.hash } }],
  };
}

/** Every offer the popup draws from this module: one row per picture, in the order listed. */
export function controls(state: ApprovalsState): readonly Offer[] {
  return state.items.map(rowAction);
}

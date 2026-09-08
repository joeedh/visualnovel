/**
 * Typed builders for the effect half of an offer. `Offer.props` is an untyped record, so a closed
 * value is enforced here by construction: a menu name outside `MENUS` is a compile error in the
 * rule module and a parse error in the driver's test. One function per effect, each returning the
 * `Action` a control's offer or `then` list carries.
 */
import type { Action } from './anchors.js';
import type { PropValue } from '../../src/shared/ipc.js';
import {
  agentAnswer,
  dragStart,
  historyMove,
  menuOpen,
  paneScroll,
  panePin,
  paneView,
  popupClose,
  popupOpen,
  screenArrange,
  treeExpand,
  uiPublish,
  type Answered,
  type Arrangement,
  type MenuName,
  type Move,
  type PopupName,
  type Published,
  type ViewWhat,
} from '../../src/shared/effects.js';
import type { INTERACTION_IDS } from '../../src/shared/interactions.js';

export type InteractionId = (typeof INTERACTION_IDS)[number];

/** The fields a click publishes, each to the value it sets. */
export type Publishes = Partial<Record<Published, string>>;

const action = (id: string, props: Record<string, PropValue>): Action => ({ id, props });

/** Every node, for {@link expand}. */
export const EVERY_NODE = '*';

export const publish = (fields: Publishes): Action => action(uiPublish.id, { ...fields });
export const expand = (node: string): Action => action(treeExpand.id, { node });
export const openMenu = (menu: MenuName): Action => action(menuOpen.id, { menu });
export const openPopup = (popup: PopupName): Action => action(popupOpen.id, { popup });
export const closePopup = (popup: PopupName): Action => action(popupClose.id, { popup });
export const view = (what: ViewWhat): Action => action(paneView.id, { what });
export const scrollTo = (to: string): Action => action(paneScroll.id, { to });
export const pin = (pinned: boolean): Action => action(panePin.id, { pinned });
export const arrange = (what: Arrangement): Action => action(screenArrange.id, { what });
export const startDrag = (interaction: InteractionId): Action =>
  action(dragStart.id, { interaction });
export const move = (to: Move): Action => action(historyMove.id, { to });
export const answer = (to: Answered, reply: string): Action =>
  action(agentAnswer.id, { to, answer: reply });

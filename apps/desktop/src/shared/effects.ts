/**
 * The app's effect vocabulary: what a control does to the surface it sits on, named. An effect
 * is recorded beside a command in the anchor layer and the derived UX model, and never runs from
 * the palette or CDP, because its handler is a closure in the renderer.
 *
 * In `shared/` rather than in the renderer because both halves read it: the catalog entry
 * verifies and projects it, and the rule modules build offers from its value lists. No DOM, so
 * `scripts/lib/load-entry.mjs` bundles it for node.
 */
import { defineEffect, EffectRegistry, prop } from '@vn/commands';
import { INTERACTION_IDS } from './interactions.js';

/** Every menu a control can open, by name. The last three are the header's submenus. */
export const MENUS = [
  'app',
  'view',
  'edit',
  'help',
  'model',
  'threads',
  'filters',
  'tree',
  'shot',
  'line',
  'card',
  'recent',
  'editors',
  'layout',
  'nodes',
  'scenes',
] as const;
export type MenuName = (typeof MENUS)[number];

/** Every popup a control can open or close. `box` is an inline editor drawn in place. */
export const POPUPS = [
  'palette',
  'picker',
  'notifications',
  'approvals',
  'diagnostics',
  'preview',
  'box',
] as const;
export type PopupName = (typeof POPUPS)[number];

/** What a `pane.view` control changes about the pane. */
export const VIEWS = [
  'reload',
  'fit',
  'tidy',
  'filter',
  'scope',
  'mode',
  'page',
  'step',
  'mark',
] as const;
export type ViewWhat = (typeof VIEWS)[number];

export const ARRANGEMENTS = ['split', 'close'] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

export const MOVES = ['undo', 'redo'] as const;
export type Move = (typeof MOVES)[number];

export const ANSWERED = ['plan', 'confirm', 'question'] as const;
export type Answered = (typeof ANSWERED)[number];

/** The `ui.*` selection fields a click can publish, as `app/state.ts` names them. */
export const PUBLISHED = [
  'sceneId',
  'shotId',
  'characterId',
  'docPath',
  'assetHash',
  'taskHash',
  'graphSlug',
] as const;
export type Published = (typeof PUBLISHED)[number];

const selection = Object.fromEntries(
  PUBLISHED.map((field) => [field, prop.string(`the ${field} to select`, { default: '' })]),
);

export const uiPublish = defineEffect({
  id         : 'ui.publish',
  title      : 'Select',
  description: 'Selects a subject, which every pane following that field then shows.',
  props      : selection,
});

export const treeExpand = defineEffect({
  id         : 'tree.expand',
  title      : 'Expand or collapse',
  description: 'Opens or closes one tree node, or every node when `node` is `*`.',
  props      : { node: prop.string('the node, or `*` for all of them') },
});

export const menuOpen = defineEffect({
  id         : 'menu.open',
  title      : 'Open a menu',
  description: 'Drops down a menu of entries, each of which is a command or an effect of its own.',
  props      : { menu: prop.oneOf(MENUS, 'which menu') },
});

export const popupOpen = defineEffect({
  id         : 'popup.open',
  title      : 'Open a popup',
  description: 'Shows a popup or an inline box over the pane.',
  props      : { popup: prop.oneOf(POPUPS, 'which popup') },
});

export const popupClose = defineEffect({
  id         : 'popup.close',
  title      : 'Close a popup',
  description: 'Dismisses a popup or an inline box, discarding nothing the project holds.',
  props      : { popup: prop.oneOf(POPUPS, 'which popup') },
});

export const paneView = defineEffect({
  id         : 'pane.view',
  title      : 'Change the view',
  description: 'Changes what the pane shows and nothing the project holds.',
  props      : { what: prop.oneOf(VIEWS, 'what changes') },
});

export const paneScroll = defineEffect({
  id         : 'pane.scroll',
  title      : 'Scroll to',
  description: 'Brings something already on the pane into view.',
  props      : { to: prop.string('what to bring into view') },
});

export const panePin = defineEffect({
  id         : 'pane.pin',
  title      : 'Pin',
  description: 'Holds the pane on its subject, or lets it follow the selection again.',
  props      : { pinned: prop.boolean('whether the pane is held') },
});

export const screenArrange = defineEffect({
  id         : 'screen.arrange',
  title      : 'Arrange the screen',
  description: 'Starts a gesture that splits an area or closes a pane.',
  props      : { what: prop.oneOf(ARRANGEMENTS, 'split or close') },
});

export const dragStart = defineEffect({
  id         : 'drag.start',
  title      : 'Start a drag',
  description: 'Arms a gesture the interaction registry declares.',
  props      : { interaction: prop.oneOf(INTERACTION_IDS, 'which gesture') },
});

export const historyMove = defineEffect({
  id         : 'history.move',
  title      : 'Undo or redo',
  description: 'Moves one step through the command history.',
  props      : { to: prop.oneOf(MOVES, 'which way') },
});

export const agentAnswer = defineEffect({
  id         : 'agent.answer',
  title      : 'Answer the agent',
  description: 'Approves or rejects a plan, allows or denies a confirm, or replies to a question.',
  props: {
    to    : prop.oneOf(ANSWERED, 'what is being answered'),
    answer: prop.string('the answer'),
  },
});

export const EFFECTS = [
  uiPublish,
  treeExpand,
  menuOpen,
  popupOpen,
  popupClose,
  paneView,
  paneScroll,
  panePin,
  screenArrange,
  dragStart,
  historyMove,
  agentAnswer,
] as const;

export const EFFECT_IDS: readonly string[] = EFFECTS.map((effect) => effect.id);

/** Whether an id names an effect rather than a command. The two registries never share an id. */
export function isEffectId(id: string): boolean {
  return EFFECT_IDS.includes(id);
}

/** Every effect the app declares, verified against the commands by the catalog entry. */
export function createDesktopEffects(): EffectRegistry {
  const registry = new EffectRegistry();
  registry.registerAll(EFFECTS);
  return registry;
}

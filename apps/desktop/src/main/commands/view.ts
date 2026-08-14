/**
 * UI state as commands. These run in main like every other command and push an effect the
 * renderer applies, so the palette, the menu bar and CDP all reach the same vocabulary
 * rather than the renderer maintaining a second registry to keep in sync.
 *
 * They address **editors**, not rooms. The shell is a mesh of panes, so what an author (or the
 * agent driving for one) wants to say is "show me the coverage strip", optionally "beside the
 * script" — `view.open`, `view.focus`, and the two layout verbs. The names come from
 * `shared/editors.ts`, which is also what the renderer registers them under.
 */
import { defineFor, prop } from '@vn/commands';
import { EDITOR_IDS, editorTitle, type OpenWhere } from '../../shared/editors.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

const WHERE: Record<OpenWhere, string> = {
  here: 'in this pane',
  right: 'to the right',
  below: 'below',
};

export const viewOpen = define({
  id: 'view.open',
  title: 'Show an editor',
  description:
    'Show an editor: in the active pane, or in a new pane split off it. Already open ' +
    'and asked for here, it is focused rather than opened twice.',
  mutating: false,
  props: {
    editor: prop.oneOf(EDITOR_IDS, 'which editor to show'),
    where: prop.oneOf(['here', 'right', 'below'] as const, 'where to put it', { default: 'here' }),
  },
  run({ editor, where }, ctx) {
    ctx.host.ui({ type: 'view', action: 'open', editor, where });
    return Promise.resolve({ message: `Showing ${editorTitle(editor)} ${WHERE[where]}.` });
  },
});

export const viewFocus = define({
  id: 'view.focus',
  title: 'Focus an editor',
  description: 'Make the pane already showing an editor the active one, without moving anything.',
  mutating: false,
  props: { editor: prop.oneOf(EDITOR_IDS, 'which editor to focus') },
  run({ editor }, ctx) {
    ctx.host.ui({ type: 'view', action: 'focus', editor });
    return Promise.resolve({ message: `Focused ${editorTitle(editor)}.` });
  },
});

export const viewClose = define({
  id: 'view.close',
  title: 'Close the active pane',
  description: 'Collapse the active pane into its neighbour. The last pane is kept.',
  mutating: false,
  props: {},
  run(_props, ctx) {
    ctx.host.ui({ type: 'view', action: 'close' });
    return Promise.resolve({ message: 'Closed the pane.' });
  },
});

export const viewLayout = define({
  id: 'view.layout',
  title: 'Reset the layout',
  description: 'Throw the remembered arrangement away and rebuild the default one.',
  mutating: false,
  props: {},
  run(_props, ctx) {
    ctx.host.ui({ type: 'view', action: 'reset' });
    return Promise.resolve({ message: 'Layout reset.' });
  },
});

export const viewPalette = define({
  id: 'view.palette',
  title: 'Toggle palette',
  description: 'Open or close the command palette.',
  mutating: false,
  props: { open: prop.boolean('true to open, false to close', { default: true }) },
  run({ open }, ctx) {
    ctx.host.ui({ type: 'palette', open });
    return Promise.resolve({ message: open ? 'Palette opened.' : 'Palette closed.' });
  },
});

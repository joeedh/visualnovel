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
import { EDITOR_IDS, OPEN_WHERE, editorTitle, type OpenWhere } from '../../shared/editors.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

const WHERE: Record<OpenWhere, string> = {
  here: 'in this pane',
  left: 'to the left',
  right: 'to the right',
  above: 'above',
  below: 'below',
  elsewhere: 'in another pane',
};

/** What the optional subject is, said once — both `view.*` verbs take it and mean the same. */
const SUBJECT =
  'what to show once it is there: a workspace-relative path for the Wiki editor, an asset ' +
  'hash for the Asset editor';

/** ` on wiki/history.md`, or nothing — the half of the sentence a subject adds. */
const onSubject = (subject: string): string => (subject ? ` on ${subject}` : '');

export const viewOpen = define({
  id: 'view.open',
  title: 'Show an editor',
  description:
    'Show an editor: in the active pane, in a new pane split off it, or `elsewhere` — the ' +
    'biggest pane that is not the active one. Already open and asked for `here` or ' +
    '`elsewhere`, it is focused rather than opened twice.',
  mutating: false,
  props: {
    editor: prop.oneOf(EDITOR_IDS, 'which editor to show'),
    where: prop.oneOf(OPEN_WHERE, 'where to put it', { default: 'here' }),
    subject: prop.string(SUBJECT, { default: '' }),
  },
  run({ editor, where, subject }, ctx) {
    ctx.host.ui({ type: 'view', action: 'open', editor, where, subject });
    return Promise.resolve({
      message: `Showing ${editorTitle(editor)}${onSubject(subject)} ${WHERE[where]}.`,
    });
  },
});

export const viewFocus = define({
  id: 'view.focus',
  title: 'Focus an editor',
  description: 'Make the pane already showing an editor the active one, without moving anything.',
  mutating: false,
  props: {
    editor: prop.oneOf(EDITOR_IDS, 'which editor to focus'),
    subject: prop.string(SUBJECT, { default: '' }),
  },
  run({ editor, subject }, ctx) {
    ctx.host.ui({ type: 'view', action: 'focus', editor, subject });
    return Promise.resolve({ message: `Focused ${editorTitle(editor)}${onSubject(subject)}.` });
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

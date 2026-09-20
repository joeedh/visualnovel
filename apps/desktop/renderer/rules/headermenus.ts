/**
 * What the header's four menus offer, as data. Each row is a command with its props, an effect
 * the header handles, or a submenu, so the derived model lists the menus and the sweep can read
 * them, and the one menu builder in `chrome/showmenu.ts` draws them beside the right-click menus.
 *
 * A row that runs a closure carries an effect id and is keyed for the header's handler table by
 * `entryKey`; {@link HANDLED} lists those keys, and the header's table is typed over it, so a row
 * with no handler fails to compile there and a handler with no row fails the test here.
 */
import type { LayoutSummary } from '../../src/shared/layouts.js';
import {
  editorTitle,
  editorTooltip,
  OFFERED_EDITOR_IDS,
  type EditorId,
} from '../../src/shared/editors.js';
import type { MenuName } from '../../src/shared/effects.js';
import { MENU_SEP, SEPARATOR, type MenuEntry } from '../pathux/chrome/contextmenu.js';
import { arrange, move, openMenu, openPopup, view } from './effects.js';
import { MENU_BUTTONS, runAction, type MenuButton } from './headerbar.js';
import { shortcutOf } from './shortcuts.js';

/** What the header reads when it builds its menus, assembled when a menu is opened. */
export interface HeaderMenuState {
  /** Which long-running work is in flight, or an empty string. */
  busyWhat: string;
  /** Whether this window can call a model, as opposed to a browser preview. */
  live: boolean;
  agentMode: string;
  /** The remembered projects, and the one that is open, as `workspace.recent` last answered. */
  recents: readonly string[];
  current: string;
  /** The project's layout templates, and which one the window is showing. */
  layouts: readonly LayoutSummary[];
  activeSlug: string;
  /** The arrangement on screen, serialized for saving, or an empty string where it cannot be. */
  layout: string;
  /** Whether this project carries the GitHub page builder, which decides one label. */
  pagesInstalled: boolean;
  /** The editor the active pane shows, which Move Pane to New Window moves, or `''` with none. */
  activeEditor: string;
}

/** The keys of every row the header runs itself rather than through `exec` or a form. */
export const HANDLED = [
  'popup.open',
  'history.move',
  'screen.arrange',
  'pane.view#enter',
  'pane.view#exit',
  'gengraph.createGroup',
  'gengraph.ungroup',
  'view.open#report',
  'agent.setMode',
] as const;
export type HandledKey = (typeof HANDLED)[number];

/** The last segment of a path. Not `node:path`, since this module is in the browser bundle. */
export function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A submenu row: the effect that opens it, and the rows it holds. */
function submenu(
  label: string,
  menu: MenuName,
  tooltip: string,
  rows: readonly MenuEntry[],
): MenuEntry {
  return { label, ...openMenu(menu), tooltip, submenu: rows };
}

const UNDO: MenuEntry = {
  label: 'Undo',
  ...move('undo'),
  shortcut: shortcutOf(move('undo')),
  tooltip : 'Put the project back the way it was before the last act',
};

const REDO: MenuEntry = {
  label: 'Redo',
  ...move('redo'),
  shortcut: shortcutOf(move('redo')),
  tooltip : 'Reapply the act that was just undone',
};

/**
 * The app menu. Run Pipeline is fired rather than formed: it and the header's button run the
 * same act with the same props, so the author sees the same refusal whichever they clicked. The
 * advanced entry opens the command's own form, where the flags live; `mock` is seeded from
 * whether this is a live app, since a preview has no keys and a dry run is all it could do.
 */
export function appMenu(state: HeaderMenuState): MenuEntry[] {
  const run = runAction(state.busyWhat, state.live);
  return [
    {
      label: 'Command Palette…',
      ...openPopup('palette'),
      shortcut: shortcutOf(openPopup('palette')),
      tooltip : 'Search every command by name and fill in its arguments',
    },
    SEPARATOR,
    UNDO,
    REDO,
    SEPARATOR,
    {
      label   : 'Save All',
      id      : 'doc.saveAll',
      shortcut: shortcutOf({ id: 'doc.saveAll', props: {} }),
      tooltip : 'Save every wiki page and skill with unsaved edits, in every window',
    },
    SEPARATOR,
    {
      label  : 'Run Pipeline',
      id     : run.id,
      tooltip: run.tooltip,
      ...(run.ok ? { props: run.props } : { refused: run.refusal.reason }),
    },
    {
      label  : 'Run Pipeline (adv)…',
      id     : 'pipeline.run',
      props  : { mock: !state.live },
      form   : true,
      tooltip: 'Start a run with the flags spelled out — dry run, scene filter, task limit',
    },
    // The checkbox is ticked here rather than in the command, whose own default has always been
    // "the project goes here"
    {
      label  : 'New Project…',
      id     : 'workspace.create',
      props  : { newFolder: true },
      form   : true,
      tooltip: 'Scaffold a project in a new folder and open it, closing this one',
    },
    // These two take no argument and ask for no confirmation, so the palette would be an empty
    // form the author dismisses with the same click; the chooser `workspace.pick` opens is its
    // own confirmation
    {
      label  : 'Open Project…',
      id     : 'workspace.pick',
      tooltip: 'Choose a project folder and open it, closing this one',
    },
    submenu(
      'Recent Projects',
      'recent',
      'Reopen a project you worked on before',
      recentMenu(state.recents, state.current),
    ),
    {
      label  : 'Reindex Project',
      id     : 'workspace.reindex',
      tooltip: 'Rebuild the map the authoring agent reads: cast, locations, story graph, bible',
    },
    // The Setup pane rather than `project.setKey`'s bare form: a box asking for a credential is
    // no use to someone who does not yet have one, and the pane is the same box with the steps
    // for getting there above it
    {
      label  : 'Set Up API Keys…',
      id     : 'view.open',
      props  : { editor: 'onboarding', where: 'elsewhere' },
      tooltip: 'How to get a model key, which of yours are set, and where they are read from',
    },
    SEPARATOR,
    // `upload.pick` is `confirm`, so the dialog runs first and says what the command is about to
    // do before the OS chooser takes over the screen
    {
      label  : 'Upload Files…',
      id     : 'upload.pick',
      form   : true,
      tooltip: 'Copy files into the project archive, verbatim, under a dated folder',
    },
    {
      label: state.pagesInstalled ? 'Update GitHub Page Builder…' : 'Install GitHub Page Builder…',
      id     : 'project.installPages',
      form   : true,
      tooltip:
        'Commit a GitHub Actions workflow that publishes this story as a web page when you push',
    },
    SEPARATOR,
    {
      label   : 'Plan ⇄ Execute',
      id      : 'agent.setMode',
      props   : { mode: state.agentMode === 'plan' ? 'execute' : 'plan' },
      shortcut: shortcutOf({ id: 'agent.setMode', props: {} }),
      tooltip : 'Switch the agent between reading only and being allowed to apply edits',
    },
    SEPARATOR,
    {
      label   : 'Quit',
      id      : 'window.quit',
      shortcut: shortcutOf({ id: 'window.quit', props: {} }),
      tooltip : 'Close every window and quit vnstudio',
    },
  ];
}

/**
 * The projects this install has opened, one `workspace.open` each. The open project is kept in
 * the list, ticked and refused: dropping it made a list of one project render `(none)`, so the
 * menu looked empty while telling the truth.
 */
export function recentMenu(recents: readonly string[], current: string): MenuEntry[] {
  if (recents.length === 0) {
    return [{ label: '(none)', id: 'workspace.open', refused: 'No project has been opened yet' }];
  }
  return recents.map((root) =>
    root === current
      ? {
          label  : `${projectName(root)} ✓`,
          id     : 'workspace.open',
          props  : { path: root },
          refused: `${root} is the project you have open`,
        }
      : {
          label  : projectName(root),
          id     : 'workspace.open',
          props  : { path: root },
          tooltip: `Close this project and open ${root}`,
        },
  );
}

/**
 * Undo, redo, the group entries, and the pass that finishes the art.
 *
 * Undo and redo are also on the app menu and on two buttons in this same bar, deliberately: an
 * author looking for undo looks under Edit, and a menu called Edit without it would read as
 * broken. The group entries act on the Gen Graph pane that is the active one, the same pane its
 * own keys would reach, so their props come from that pane rather than from the row.
 */
export function editMenu(): MenuEntry[] {
  return [
    UNDO,
    REDO,
    SEPARATOR,
    {
      label   : 'Create Group',
      id      : 'gengraph.createGroup',
      supplies: ['slug', 'nodes'],
      shortcut: shortcutOf({ id: 'gengraph.createGroup', props: {} }),
      tooltip:
        'Move the selected nodes of the active Gen Graph pane into a new group, and leave an ' +
        'instance of it in their place',
    },
    {
      label   : 'Ungroup',
      id      : 'gengraph.ungroup',
      supplies: ['slug', 'node'],
      shortcut: shortcutOf({ id: 'gengraph.ungroup', props: {} }),
      tooltip : 'Put a copy of each selected group’s nodes where the instance stands',
    },
    {
      label: 'Edit Group',
      ...view('scope'),
      on      : 'enter',
      shortcut: shortcutOf(view('scope'), 'enter'),
      tooltip : 'Open the selected group’s definition, which every instance of it follows',
    },
    {
      label: 'Exit Group',
      ...view('scope'),
      on     : 'exit',
      tooltip: 'Go back up one level, to the graph the open group sits in',
    },
    SEPARATOR,
    // A dialog rather than a direct run, because the command is `confirm`: it says how many
    // pictures it is about to approve and how many tasks it is about to run
    {
      label  : 'Approve & Generate All…',
      id     : 'pipeline.approveAndRun',
      form   : true,
      tooltip:
        'Approve every picture that is waiting and run the pipeline, repeatedly, until nothing ' +
        'is left to approve or generate. Spends real model calls.',
    },
  ];
}

/**
 * The View menu is two lists — which editor a pane shows, and how the whole window is arranged —
 * followed by the acts that split, close and move panes and windows. Close Pane… and Split Area
 * are gestures rather than commands: which pane, and where the line falls, are answers only a
 * pointer can give. Moving a pane is two invocations rather than a third command: `window.new`,
 * then `view.close` only if the window opened.
 */
export function viewMenu(state: HeaderMenuState): MenuEntry[] {
  return [
    submenu('Editors', 'editors', 'Show a different editor in this pane', editorsMenu()),
    submenu(
      'Layout',
      'layout',
      'Rearrange the whole window',
      layoutMenu(state.layouts, state.activeSlug, state.layout),
    ),
    SEPARATOR,
    {
      label: 'Close Pane…',
      ...arrange('close'),
      tooltip: 'Point at a pane to close it — it is outlined and crossed out. Escape cancels.',
    },
    {
      label: 'Split Area',
      ...arrange('split'),
      tooltip: 'Drag a line across a pane to divide it in two.',
    },
    SEPARATOR,
    {
      label   : 'Zoom In',
      id      : 'view.zoom',
      props   : { move: 'in' },
      shortcut: shortcutOf({ id: 'view.zoom', props: { move: 'in' } }),
      tooltip : 'Make text and widgets in every window one step bigger',
    },
    {
      label   : 'Zoom Out',
      id      : 'view.zoom',
      props   : { move: 'out' },
      shortcut: shortcutOf({ id: 'view.zoom', props: { move: 'out' } }),
      tooltip : 'Make text and widgets in every window one step smaller',
    },
    {
      label   : 'Reset Zoom',
      id      : 'view.zoom',
      props   : { move: 'reset' },
      shortcut: shortcutOf({ id: 'view.zoom', props: { move: 'reset' } }),
      tooltip : 'Put every window back at 100%',
    },
    SEPARATOR,
    {
      label   : 'New Window',
      id      : 'window.new',
      shortcut: shortcutOf({ id: 'window.new', props: {} }),
      tooltip : 'Open another window onto this project — one app, panes across two monitors',
    },
    {
      label   : 'Close Window',
      id      : 'window.close',
      shortcut: shortcutOf({ id: 'window.close', props: {} }),
      tooltip : 'Close this window; closing the last one quits',
    },
    {
      label  : 'Move Pane to New Window',
      id     : 'window.new',
      tooltip: 'Reopen the active pane’s editor in a window of its own and close it here',
      ...(state.activeEditor
        ? { props: { editor: state.activeEditor }, then: [{ id: 'view.close', props: {} }] }
        : { refused: 'There is no pane to move.' }),
    },
  ];
}

/**
 * Every editor an author browses to, each entry a `view.open` into this pane. Built from
 * `OFFERED_EDITOR_IDS`, the same predicate the shell hands path.ux's own area menu, so an editor
 * reachable from one place only is listed in neither switcher.
 */
export function editorsMenu(): MenuEntry[] {
  return OFFERED_EDITOR_IDS.map((id: EditorId) => ({
    label  : editorTitle(id),
    id     : 'view.open',
    props  : { editor: id },
    tooltip: editorTooltip(id),
  }));
}

/**
 * The project's named arrangements, then the two acts that maintain them. A template that cannot
 * be applied is still offered, refused with the file's own problem: `view.applyLayout` refuses it
 * with the same sentence, and an entry silently missing is worse than one that explains itself.
 * Saving takes the mesh serialized by the caller, because only the renderer can serialize one.
 */
export function layoutMenu(
  layouts: readonly LayoutSummary[],
  activeSlug: string,
  layout: string,
): MenuEntry[] {
  const rows: MenuEntry[] = layouts.map((entry) => ({
    label: entry.slug === activeSlug ? `${entry.title} ✓` : entry.title,
    id   : 'view.applyLayout',
    props: { name: entry.slug },
    ...(entry.problem === undefined
      ? { tooltip: `Rearrange the window: ${entry.description}` }
      : { refused: `Cannot be used: ${entry.problem}` }),
  }));
  return [
    ...(rows.length
      ? rows
      : [{ label: '(none)', id: 'view.applyLayout', refused: 'This project has no layouts yet' }]),
    SEPARATOR,
    {
      label  : 'Save Current Layout As…',
      id     : 'view.saveLayout',
      tooltip: 'File the arrangement on screen in the project under a name of your own',
      ...(layout
        ? { props: { layout }, form: true }
        : { refused: 'This arrangement could not be serialized.' }),
    },
    {
      label  : 'Reset View Layout…',
      id     : 'view.resetLayout',
      form   : true,
      tooltip: 'Put the layouts that ship with the app back the way they shipped — undoable',
    },
  ];
}

/**
 * The update check takes no arguments and answers in one sentence, so it runs from the row. The
 * report entry opens the Report pane as a popup once the conversation list has been fetched, which
 * is the header's `view.open#report` handler.
 */
export function helpMenu(): MenuEntry[] {
  return [
    {
      label  : 'Check for Updates…',
      id     : 'app.checkForUpdates',
      tooltip:
        'Ask GitHub whether a newer VN Studio has been released. Downloads nothing — if there ' +
        'is one, the notification takes you to the page.',
    },
    SEPARATOR,
    {
      label  : 'Report a Difficult Agent…',
      id     : 'view.open',
      props  : { editor: 'report', where: 'popup' },
      on     : 'report',
      tooltip:
        'Have a conversation that went wrong read by a debug agent, and draft a bug report ' +
        'from it. Runs on your own model key; names from your story are replaced first.',
    },
  ];
}

/** One bar menu: its button, and its rows over a state. */
export interface HeaderMenu extends MenuButton {
  entries(state: HeaderMenuState): MenuEntry[];
}

const buttonOf = (menu: MenuName): MenuButton =>
  MENU_BUTTONS.find((button) => button.menu === menu) as MenuButton;

/** The four menus, in bar order. */
export const HEADER_MENUS: readonly HeaderMenu[] = [
  { ...buttonOf('app'), entries: appMenu },
  { ...buttonOf('edit'), entries: () => editMenu() },
  { ...buttonOf('view'), entries: viewMenu },
  { ...buttonOf('help'), entries: () => helpMenu() },
];

/** The four menus built over a state, each under `header/<menu>`, which is how the model files them. */
export function headerMenus(state: HeaderMenuState): { when: string; entries: MenuEntry[] }[] {
  return HEADER_MENUS.map((menu) => ({
    when   : `header/${menu.menu}`,
    entries: menu.entries(state),
  }));
}

/** Every row of every bar menu, its submenus included, in draw order. */
export function headerEntries(state: HeaderMenuState): MenuEntry[] {
  const walk = (entries: readonly MenuEntry[]): MenuEntry[] =>
    entries.flatMap((entry) =>
      entry.id === MENU_SEP ? [] : [entry, ...walk(entry.submenu ?? [])],
    );
  return HEADER_MENUS.flatMap((menu) => walk(menu.entries(state)));
}

import {
  appMenu,
  editMenu,
  HANDLED,
  headerEntries,
  helpMenu,
  layoutMenu,
  recentMenu,
  viewMenu,
  type HeaderMenuState,
} from '../headermenus.js';
import { SITUATIONS } from '../situations/headermenus.js';
import { entryKey, needsCheck, type MenuEntry } from '../../pathux/chrome/contextmenu.js';
import { isEffectId } from '../../../src/shared/effects.js';
import { BUSY_RUN } from '../../../src/shared/ipc.js';

const fresh = SITUATIONS[0]!.state;
const project = SITUATIONS.find((s) => s.name === 'project')!.state;

const ids = (entries: readonly MenuEntry[]) => entries.map((e) => e.id);

describe('appMenu', () => {
  it('runs the pipeline with the header button’s props, and refuses with its sentence', () => {
    const run = appMenu(fresh).find((e) => e.label === 'Run Pipeline')!;
    expect(run).toMatchObject({ id: 'pipeline.run', props: { mock: false } });
    const busy = appMenu({ ...fresh, busyWhat: BUSY_RUN }).find((e) => e.label === 'Run Pipeline')!;
    expect(busy).toMatchObject({
      id     : 'pipeline.run',
      refused: `Cannot start: ${BUSY_RUN} is already in progress.`,
    });
    expect(busy.props).toBeUndefined();
  });

  it('opens the palette, moves through history and quits, each with its shortcut', () => {
    const rows = appMenu(fresh);
    expect(rows[0]).toMatchObject({
      id      : 'popup.open',
      props   : { popup: 'palette' },
      shortcut: 'Ctrl+Shift+P',
    });
    expect(rows.find((e) => e.label === 'Undo')).toMatchObject({
      id      : 'history.move',
      props   : { to: 'undo' },
      shortcut: 'Ctrl+Z',
    });
    expect(rows.find((e) => e.label === 'Quit')).toMatchObject({
      id      : 'window.quit',
      shortcut: 'Ctrl+Q',
    });
  });

  it('flips the agent’s mode the way the header button does', () => {
    expect(appMenu(fresh).find((e) => e.label === 'Plan ⇄ Execute')).toMatchObject({
      id   : 'agent.setMode',
      props: { mode: 'execute' },
    });
    expect(appMenu(project).find((e) => e.label === 'Plan ⇄ Execute')).toMatchObject({
      props: { mode: 'plan' },
    });
  });

  it('names the page builder row by whether it is installed, as a form either way', () => {
    expect(appMenu(fresh).find((e) => e.id === 'project.installPages')).toMatchObject({
      label: 'Install GitHub Page Builder…',
      form : true,
    });
    expect(appMenu(project).find((e) => e.id === 'project.installPages')?.label).toBe(
      'Update GitHub Page Builder…',
    );
  });

  it('opens the dialogs as forms, with the checkbox and the mock flag seeded', () => {
    const rows = appMenu({ ...fresh, live: false });
    expect(rows.find((e) => e.label === 'Run Pipeline (adv)…')).toMatchObject({
      id   : 'pipeline.run',
      props: { mock: true },
      form : true,
    });
    expect(rows.find((e) => e.label === 'New Project…')).toMatchObject({
      id   : 'workspace.create',
      props: { newFolder: true },
      form : true,
    });
    expect(rows.find((e) => e.label === 'Upload Files…')).toMatchObject({
      id  : 'upload.pick',
      form: true,
    });
  });
});

describe('recentMenu', () => {
  it('keeps the open project in the list, ticked and refused', () => {
    const rows = recentMenu(project.recents, project.current);
    expect(rows).toEqual([
      {
        label  : 'transfer ✓',
        id     : 'workspace.open',
        props  : { path: 'C:/stories/transfer' },
        refused: 'C:/stories/transfer is the project you have open',
      },
      {
        label  : 'harbour',
        id     : 'workspace.open',
        props  : { path: 'C:/stories/harbour' },
        tooltip: 'Close this project and open C:/stories/harbour',
      },
    ]);
  });

  it('says so with nothing remembered, rather than drawing an empty menu', () => {
    expect(recentMenu([], '')).toEqual([
      { label: '(none)', id: 'workspace.open', refused: 'No project has been opened yet' },
    ]);
  });

  it('is the app menu’s Recent submenu', () => {
    const recent = appMenu(project).find((e) => e.label === 'Recent Projects')!;
    expect(recent).toMatchObject({ id: 'menu.open', props: { menu: 'recent' } });
    expect(recent.submenu).toEqual(recentMenu(project.recents, project.current));
  });
});

describe('editMenu', () => {
  it('lets the active Gen Graph pane supply the group commands’ props', () => {
    const rows = editMenu();
    expect(rows.find((e) => e.label === 'Create Group')).toMatchObject({
      id      : 'gengraph.createGroup',
      supplies: ['slug', 'nodes'],
      shortcut: 'Ctrl+G',
    });
    expect(rows.find((e) => e.label === 'Ungroup')).toMatchObject({
      id      : 'gengraph.ungroup',
      shortcut: 'Ctrl+Alt+G',
    });
  });

  it('tells Edit Group and Exit Group apart by `on`, since both change the pane’s scope', () => {
    const rows = editMenu();
    expect(entryKey(rows.find((e) => e.label === 'Edit Group')!)).toBe('pane.view#enter');
    expect(entryKey(rows.find((e) => e.label === 'Exit Group')!)).toBe('pane.view#exit');
  });

  it('opens Approve & Generate All as a form, because the command confirms', () => {
    expect(editMenu().at(-1)).toMatchObject({ id: 'pipeline.approveAndRun', form: true });
  });
});

describe('viewMenu', () => {
  it('lists every offered editor as a view.open into this pane', () => {
    const editors = viewMenu(fresh).find((e) => e.label === 'Editors')!;
    expect(editors).toMatchObject({ id: 'menu.open', props: { menu: 'editors' } });
    expect(editors.submenu!.every((e) => e.id === 'view.open')).toBe(true);
    expect(editors.submenu!.some((e) => e.props?.['editor'] === 'script')).toBe(true);
    expect(editors.submenu!.every((e) => e.props?.['where'] === undefined)).toBe(true);
  });

  it('moves the active pane by opening a window, then closing the pane, only with a pane', () => {
    expect(viewMenu(fresh).find((e) => e.label === 'Move Pane to New Window')).toMatchObject({
      id   : 'window.new',
      props: { editor: 'script' },
      then : [{ id: 'view.close', props: {} }],
    });
    expect(
      viewMenu({ ...fresh, activeEditor: '' }).find((e) => e.label === 'Move Pane to New Window'),
    ).toMatchObject({ id: 'window.new', refused: 'There is no pane to move.' });
  });

  it('records the split and close gestures as arrangements', () => {
    expect(ids(viewMenu(fresh))).toEqual([
      'menu.open',
      'menu.open',
      '-',
      'screen.arrange',
      'screen.arrange',
      '-',
      'window.new',
      'window.close',
      'window.new',
    ]);
  });
});

describe('layoutMenu', () => {
  it('ticks the active layout and refuses an unusable one with its problem', () => {
    const rows = layoutMenu(project.layouts, project.activeSlug, project.layout);
    expect(rows[0]).toMatchObject({
      label  : 'Writing ✓',
      id     : 'view.applyLayout',
      props  : { name: 'writing' },
      tooltip: 'Rearrange the window: the script beside the tree, the conversation below',
    });
    expect(rows[1]).toMatchObject({
      label  : 'Review',
      refused: 'Cannot be used: it names an editor this build does not have',
    });
  });

  it('saves the serialized mesh through the form, or refuses without one', () => {
    const save = (layout: string) =>
      layoutMenu([], '', layout).find((e) => e.id === 'view.saveLayout');
    expect(save('{"vnstudio":"layout/1"}')).toMatchObject({
      props: { layout: '{"vnstudio":"layout/1"}' },
      form : true,
    });
    expect(save('')).toMatchObject({ refused: 'This arrangement could not be serialized.' });
    expect(layoutMenu([], '', '')[0]).toMatchObject({
      label  : '(none)',
      refused: 'This project has no layouts yet',
    });
  });
});

describe('helpMenu', () => {
  it('opens the report pane as a popup, keyed for the header’s seeding handler', () => {
    const report = helpMenu().find((e) => e.label === 'Report a Difficult Agent…')!;
    expect(report).toMatchObject({
      id   : 'view.open',
      props: { editor: 'report', where: 'popup' },
    });
    expect(entryKey(report)).toBe('view.open#report');
  });
});

describe('the handler table', () => {
  const handled = (state: HeaderMenuState) =>
    headerEntries(state)
      .filter((e) => isEffectId(e.id) || e.supplies !== undefined || e.on !== undefined)
      .filter((e) => e.submenu === undefined)
      .map(entryKey);

  it('names every row the header runs itself, over every situation', () => {
    for (const situation of SITUATIONS) {
      for (const key of handled(situation.state)) expect(HANDLED).toContain(key);
    }
  });

  it('carries no key that no row uses', () => {
    const used = new Set(SITUATIONS.flatMap((s) => headerEntries(s.state).map(entryKey)));
    for (const key of HANDLED) expect(used.has(key)).toBe(true);
  });

  it('checks every other row before it is drawn, or opens its form', () => {
    for (const entry of headerEntries(project)) {
      if (HANDLED.includes(entryKey(entry) as (typeof HANDLED)[number])) continue;
      if (entry.submenu !== undefined) continue;
      expect(needsCheck(entry) || entry.form === true || entry.refused !== undefined).toBe(true);
    }
  });
});

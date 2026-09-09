import {
  MENU_BUTTONS,
  approvalsAction,
  controls,
  menuAction,
  modeAction,
  modelAction,
  notificationsAction,
  problemsAction,
  redoAction,
  runAction,
  stopAction,
  undoAction,
  viewActions,
  type HeaderState,
} from '../headerbar.js';
import { busyControls } from '../busy.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import { BUSY_REPORT, BUSY_RUN } from '../../../src/shared/ipc.js';

describe('runAction', () => {
  it('runs for real in a live app and dry in a preview, and says which', () => {
    expect(runAction('', true)).toEqual({
      ok     : true,
      id     : 'pipeline.run',
      props  : { mock: false },
      label  : '▶ Run',
      tooltip: 'Plan and render everything that is ready, to the next gate',
    });
    expect(runAction('', false)).toMatchObject({
      ok     : true,
      props  : { mock: true },
      tooltip: expect.stringContaining('cannot call a model'),
    });
  });

  it('refuses while other work is in flight, and still names the command', () => {
    expect(runAction(BUSY_RUN, true)).toMatchObject({
      ok     : false,
      id     : 'pipeline.run',
      label  : '▶ Run',
      refusal: { reason: `Cannot start: ${BUSY_RUN} is already in progress.` },
    });
  });
});

describe('stopAction', () => {
  it('stops whatever the header drew a spinner for, saying what stopping does', () => {
    expect(stopAction(busyControls(BUSY_RUN))).toMatchObject({
      ok     : true,
      id     : 'pipeline.stop',
      tooltip: busyControls(BUSY_RUN)!.stops,
    });
    expect(stopAction(busyControls(BUSY_REPORT))).toMatchObject({ ok: true, id: 'report.stop' });
  });

  it('refuses when nothing it stops is running', () => {
    expect(stopAction(undefined)).toMatchObject({
      ok     : false,
      id     : 'pipeline.stop',
      refusal: { reason: 'Nothing is running.' },
    });
  });
});

describe('modeAction', () => {
  it('names the mode it would move to, and labels the one it is in', () => {
    expect(modeAction('plan')).toEqual({
      ok     : true,
      id     : 'agent.setMode',
      props  : { mode: 'execute' },
      label  : 'PLAN',
      tooltip: 'Plan mode: the agent reads but never writes. Click to let it apply edits.',
    });
    expect(modeAction('execute')).toMatchObject({ props: { mode: 'plan' }, label: 'EXECUTE' });
  });
});

describe('the popup openers', () => {
  it('count the problems, errors before warnings, and open the diagnostics', () => {
    expect(problemsAction(2, 1)).toEqual({
      ok     : true,
      id     : 'popup.open',
      props  : { popup: 'diagnostics' },
      on     : 'diagnostics',
      label  : '2 errors',
      tooltip: 'List them — 2 errors and 1 warning in this project',
    });
    expect(problemsAction(0, 1)).toMatchObject({
      label  : '1 warning',
      tooltip: 'List what validation says is wrong with this project',
    });
  });

  it('count the art waiting and the unread notifications', () => {
    expect(approvalsAction(3)).toMatchObject({
      id     : 'popup.open',
      props  : { popup: 'approvals' },
      label  : '🎨 3',
      tooltip: 'Show the art waiting on approval — 3',
    });
    expect(approvalsAction(0)).toMatchObject({
      label  : '🎨',
      tooltip: 'No art is waiting on approval',
    });
    expect(notificationsAction(5)).toMatchObject({
      id     : 'popup.open',
      props  : { popup: 'notifications' },
      label  : '🔔 5',
      tooltip: 'Show notifications — 5 unread',
    });
    expect(notificationsAction(0)).toMatchObject({ label: '🔔', tooltip: 'Show notifications' });
  });

  it('are keyed by the popup each opens, which is what a popup-closed answer rings', () => {
    expect(keyOf(problemsAction(1, 0))).toBe('fx:popup.open#diagnostics');
    expect(keyOf(approvalsAction(0))).toBe('fx:popup.open#approvals');
    expect(keyOf(notificationsAction(0))).toBe('fx:popup.open#notifications');
  });
});

describe('the menu buttons and the arrows', () => {
  it('drop each menu down, keyed by its name', () => {
    expect(MENU_BUTTONS.map((button) => button.menu)).toEqual(['app', 'edit', 'view', 'help']);
    expect(menuAction(MENU_BUTTONS[1]!)).toEqual({
      ok     : true,
      id     : 'menu.open',
      props  : { menu: 'edit' },
      on     : 'edit',
      label  : 'Edit',
      tooltip: 'Undo and redo, and the one act that approves and renders the art in a single pass.',
    });
  });

  it('move through the history, refused with nothing to move to', () => {
    expect(undoAction('set speaker')).toEqual({
      ok     : true,
      id     : 'history.move',
      props  : { to: 'undo' },
      on     : 'undo',
      label  : '⟲',
      tooltip: 'Undo set speaker',
    });
    expect(undoAction(null)).toMatchObject({ ok: false, refusal: { reason: 'Nothing to undo' } });
    expect(redoAction('retype line')).toMatchObject({
      props  : { to: 'redo' },
      tooltip: 'Redo retype line',
    });
    expect(redoAction('')).toMatchObject({ ok: true, tooltip: 'Redo' });
    expect(redoAction(null)).toMatchObject({ ok: false, refusal: { reason: 'Nothing to redo' } });
  });
});

describe('controls', () => {
  const counts = { errors: 0, warnings: 0, needsApproval: 0, unread: 0, undo: null, redo: null };
  const states: HeaderState[] = [
    { busyWhat: '', live: true, agentMode: 'plan', model: 'claude-opus-5', ...counts },
    { busyWhat: BUSY_RUN, live: false, agentMode: 'execute', model: '', ...counts },
    { busyWhat: BUSY_REPORT, live: true, agentMode: 'plan', model: 'claude-opus-5', ...counts },
    { busyWhat: '', live: true, agentMode: 'plan', model: '', ...counts, errors: 1, unread: 2 },
  ];

  it('lists every control the functions produce, each key once', () => {
    for (const state of states) {
      const listed = controls(state);
      const each = [
        ...MENU_BUTTONS.map(menuAction),
        ...viewActions(),
        runAction(state.busyWhat, state.live),
        stopAction(busyControls(state.busyWhat)),
        ...(state.errors || state.warnings ? [problemsAction(state.errors, state.warnings)] : []),
        undoAction(state.undo),
        redoAction(state.redo),
        modeAction(state.agentMode),
        modelAction(state.model),
        approvalsAction(state.needsApproval),
        notificationsAction(state.unread),
      ];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });

  it('draws the problem button only while validation counted something', () => {
    const [idle, , , counted] = states;
    expect(controls(idle!).map(keyOf)).not.toContain('fx:popup.open#diagnostics');
    expect(controls(counted!).map(keyOf)).toContain('fx:popup.open#diagnostics');
  });
});

describe('viewActions', () => {
  it('reaches two commands from the one button, each supplied by its rows', () => {
    const [open, layout] = viewActions();
    expect(open).toEqual({
      ok      : true,
      id      : 'view.open',
      props   : {},
      supplies: ['editor'],
      label   : 'View',
      tooltip : 'Split and close panes, and switch between the saved window layouts.',
    });
    expect(layout).toMatchObject({ ok: true, id: 'view.applyLayout', supplies: ['name'] });
    expect(layout.label).toBe(open.label);
    expect(layout.tooltip).toBe(open.tooltip);
  });
});

describe('modelAction', () => {
  it('names the model in use, and says so when none is chosen yet', () => {
    expect(modelAction('claude-opus-5')).toEqual({
      ok      : true,
      id      : 'agent.setModel',
      props   : {},
      label   : 'claude-opus-5',
      tooltip : 'Which model the agent answers with. Switching takes effect next turn.',
      supplies: ['modelId'],
    });
    expect(modelAction('').label).toBe('model…');
  });
});

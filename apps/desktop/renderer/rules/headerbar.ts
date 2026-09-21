/**
 * What the header's own buttons offer. Split out of the editor so the invocation each one runs is
 * a value a test can read, which is what lets the anchor and the click come from one object.
 *
 * Undo and redo are `history.move` effects: they go through `command:undo` and `command:redo`
 * rather than through the registry, so a step names the effect rather than a command.
 */
import type { MenuName } from '../../src/shared/effects.js';
import { refuse, type Offer } from './anchors.js';
import { busyControls, type BusyControls } from './busy.js';
import { move, openMenu, openPopup } from './effects.js';

/** One bar menu's button: its name in the effect vocabulary, and what the button says. */
export interface MenuButton {
  menu: MenuName;
  title: string;
  tooltip: string;
}

/** The four bar menus' buttons, in bar order; `headermenus.ts` hangs each menu's rows on one. */
export const MENU_BUTTONS: readonly MenuButton[] = [
  {
    menu   : 'app',
    title  : 'VN STUDIO',
    tooltip:
      'Open, create and export a project, and everything that acts on the workspace as a whole.',
  },
  {
    menu   : 'edit',
    title  : 'Edit',
    tooltip: 'Undo and redo, and the one act that approves and renders the art in a single pass.',
  },
  {
    menu   : 'view',
    title  : 'View',
    tooltip: 'Split and close panes, and switch between the saved window layouts.',
  },
  {
    menu   : 'help',
    title  : 'Help',
    tooltip: 'Whether there is a newer VN Studio, and what to do about an agent that misbehaved.',
  },
];

/** One bar menu's button, which drops the menu down. */
export function menuAction(button: MenuButton): Offer {
  return {
    ok: true,
    ...openMenu(button.menu),
    on     : button.menu,
    label  : button.title,
    tooltip: button.tooltip,
  };
}

/** What the header reads when it draws its command buttons and its three popup openers. */
export interface HeaderState {
  /** What Undo would take back, or `null` while there is nothing to undo. */
  undo: string | null;
  /** The act undo stops at when `undo` is null and something has changed; empty otherwise. */
  undoBlocked?: string;
  /** What Redo would put back, or `null` while there is nothing to redo. */
  redo: string | null;
  /** Which long-running work is in flight, or an empty string. */
  busyWhat: string;
  /** Whether Stop was already pressed on that work and it has not yet stopped. */
  stopping?: boolean;
  /** Whether this window can call a model, as opposed to a browser preview. */
  live: boolean;
  agentMode: string;
  /** The model the agent answers with, or an empty string before one is chosen. */
  model: string;
  /** What validation counted. The problem button is drawn only while either is above zero. */
  errors: number;
  warnings: number;
  needsApproval: number;
  unread: number;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The problem count, which opens the diagnostics popup. Errors displace warnings: one count,
 * showing the more severe kind. A button rather than a label, because a count the author cannot
 * click to list is a number they cannot act on.
 */
export function problemsAction(errors: number, warnings: number): Offer {
  return {
    ok: true,
    ...openPopup('diagnostics'),
    on     : 'diagnostics',
    label  : errors ? plural(errors, 'error') : plural(warnings, 'warning'),
    tooltip:
      errors && warnings
        ? `List them — ${plural(errors, 'error')} and ${plural(warnings, 'warning')} in this project`
        : 'List what validation says is wrong with this project',
  };
}

/** The badge counting art waiting on approval, which opens the approvals popup. */
export function approvalsAction(waiting: number): Offer {
  return {
    ok: true,
    ...openPopup('approvals'),
    on     : 'approvals',
    label  : waiting ? `🎨 ${waiting}` : '🎨',
    tooltip: waiting
      ? `Show the art waiting on approval — ${waiting}`
      : 'No art is waiting on approval',
  };
}

/** The bell, which opens the notification popup. */
export function notificationsAction(unread: number): Offer {
  return {
    ok: true,
    ...openPopup('notifications'),
    on     : 'notifications',
    label  : unread ? `🔔 ${unread}` : '🔔',
    tooltip: unread ? `Show notifications — ${unread} unread` : 'Show notifications',
  };
}

/**
 * The View menu's button rather than its rows: the rows exist only while the menu is open, and the
 * author's choice among them supplies the prop. Two commands are reached from it, and both present
 * the one button the same way.
 */
export function viewActions(): [Offer, Offer] {
  const views = {
    label  : 'View',
    tooltip: 'Split and close panes, and switch between the saved window layouts.',
  };
  return [
    { ok: true, id: 'view.open', props: {}, supplies: ['editor'], ...views },
    { ok: true, id: 'view.applyLayout', props: {}, supplies: ['name'], ...views },
  ];
}

/** The model menu's button. The rows supply the id; the label names the model in use. */
export function modelAction(model: string): Offer {
  return {
    ok      : true,
    id      : 'agent.setModel',
    props   : {},
    label   : model || 'model…',
    tooltip : 'Which model the agent answers with. Switching takes effect next turn.',
    supplies: ['modelId'],
  };
}

/**
 * Start a run. `mock` follows whether this is a live app rather than the author's intent: a browser
 * preview has no keys and no main process, so a dry run is the only thing it could do.
 */
export function runAction(busy: string, live: boolean): Offer {
  const label = '▶ Run';
  const tooltip = live
    ? 'Plan and render everything that is ready, to the next gate'
    : 'Preview what a run would do. This window cannot call a model.';
  if (busy !== '') {
    return {
      ...refuse(`Cannot start: ${busy} is already in progress.`),
      id: 'pipeline.run',
      label,
      tooltip,
    };
  }
  return { ok: true, id: 'pipeline.run', props: { mock: !live }, label, tooltip };
}

/**
 * Stop whatever the header is showing a spinner for. Refuses when nothing it stops is running.
 * Once a stop is pending, the same button offers the abort instead, through the command's own
 * form so the author confirms before anything in flight is cut off.
 */
export function stopAction(controls: BusyControls | undefined, stopping = false): Offer {
  if (!controls) {
    return {
      ...refuse('Nothing is running.'),
      id     : 'pipeline.stop',
      label  : '■',
      tooltip: 'Stop the work in progress after the step it is on',
    };
  }
  if (stopping && controls.aborts) {
    return {
      ok     : true,
      id     : controls.stop,
      props  : { abort: true },
      label  : '■',
      tooltip: controls.aborts,
      form   : true,
    };
  }
  return { ok: true, id: controls.stop, props: {}, label: '■', tooltip: controls.stops };
}

/** Flip the agent between reading and writing. The label names the mode the agent is in now. */
export function modeAction(mode: string): Offer {
  const plan = mode === 'plan';
  return {
    ok     : true,
    id     : 'agent.setMode',
    props  : { mode: plan ? 'execute' : 'plan' },
    label  : plan ? 'PLAN' : 'EXECUTE',
    tooltip: plan
      ? 'Plan mode: the agent reads but never writes. Click to let it apply edits.'
      : 'Execute mode: the agent may apply edits. Click to make it read-only again.',
  };
}

/**
 * The `⟲` arrow, refused with nothing to undo. Refused by name when the newest change cannot be
 * undone, since undo does not reach past it: after a save is taken back, the undo history from
 * before no longer applies.
 */
export function undoAction(undo: string | null, blocked = ''): Offer {
  const control = { ...move('undo'), on: 'undo', label: '⟲' };
  if (undo === null) {
    const why = blocked ? `Undo stops at ${blocked}, which cannot be undone` : 'Nothing to undo';
    return { ...refuse(why), ...control, tooltip: 'Undo' };
  }
  return { ok: true, ...control, tooltip: undo ? `Undo ${undo}` : 'Undo' };
}

/** The `⟳` arrow, refused with nothing to redo. */
export function redoAction(redo: string | null): Offer {
  const control = { ...move('redo'), on: 'redo', label: '⟳' };
  if (redo === null) return { ...refuse('Nothing to redo'), ...control, tooltip: 'Redo' };
  return { ok: true, ...control, tooltip: redo ? `Redo ${redo}` : 'Redo' };
}

/**
 * Every offer the header draws from this module, in the order it draws them: the four menu
 * buttons, the View button's two commands, Run and Stop, the problem count, the two arrows, the
 * mode and model buttons, and the two badges.
 */
export function controls(state: HeaderState): readonly Offer[] {
  return [
    ...MENU_BUTTONS.map(menuAction),
    ...viewActions(),
    runAction(state.busyWhat, state.live),
    stopAction(busyControls(state.busyWhat), state.stopping ?? false),
    ...(state.errors || state.warnings ? [problemsAction(state.errors, state.warnings)] : []),
    undoAction(state.undo, state.undoBlocked),
    redoAction(state.redo),
    modeAction(state.agentMode),
    modelAction(state.model),
    approvalsAction(state.needsApproval),
    notificationsAction(state.unread),
  ];
}

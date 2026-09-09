/**
 * What the conversation editor's bar offers. The refusals were already the app's own sentences;
 * moving them here makes each one a value beside the invocation it refuses, which is what lets the
 * button and its anchor come from one object.
 */
import { effortChoicesFor, effortLabel, type BudgetChoice, type EffortChoice } from '@vn/types';
import { contextDetail, threadDetail, threadLabel, type Convo } from '../../src/shared/convo.js';
import type { ThreadHeader } from '../../src/shared/convo.js';
import type { OpenedThread } from '../../src/shared/threads.js';
import { resumeRefusal } from '../../src/shared/threads.js';
import { refuse, type Offer } from './anchors.js';
import { modeAction, modelAction } from './headerbar.js';
import { SEPARATOR, type MenuEntry } from '../pathux/chrome/contextmenu.js';

/** What the conversation editor's bar reads when it draws. */
export interface ConvoBarState {
  convo: Convo;
  /** The saved conversation open for reading, if one is. */
  opened: OpenedThread | undefined;
  model: string;
  agentMode: string;
  effort: EffortChoice;
  budget: BudgetChoice;
  /** What the turn in flight has spent against the budget, in tokens the cache did not serve. */
  spent: number;
}

/** A token count at a glance: `842`, `12.3k`, `1.4M`. The exact figures are in the tooltip. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** The Threads button. The menu it opens picks the conversation, so the id is supplied there. */
export function threadsAction(): Offer {
  return {
    ok      : true,
    id      : 'agent.openThread',
    props   : {},
    label   : 'Threads',
    tooltip:
      'Saved conversations. Reopening one is read-only — the agent is not shown it until ' +
      'Continue hands it back.',
    supplies: ['id'],
  };
}

/**
 * The effort menu's button. A model with no thinking knob gets it greyed rather than hidden: the
 * setting is kept across a model switch, so what the author picked is still true, only not in use.
 */
export function effortAction(model: string, effort: EffortChoice): Offer {
  const control = {
    id      : 'agent.setEffort',
    label   : `effort: ${effortLabel(effort)}`,
    tooltip : 'How hard the model thinks before answering. Higher costs more.',
    supplies: ['effort'],
  };
  if (effortChoicesFor(model).length === 0) {
    return { ...refuse(`${model || 'this model'} has no reasoning-effort setting.`), ...control };
  }
  return { ok: true, props: {}, ...control };
}

/**
 * The budget menu's button: the ceiling, and what the turn in flight has spent against it. The
 * label is retitled in place as the spend moves, so the bar is not rebuilt under an open menu.
 */
export function budgetAction(budget: BudgetChoice, spent: number): Offer {
  const limit =
    budget === 'unlimited'
      ? 'This turn runs until it finishes or hits the 200-step runaway stop.'
      : `This turn stops once it has spent ${budget}.`;
  return {
    ok      : true,
    id      : 'agent.setBudget',
    props   : {},
    label:
      spent === 0 || budget === 'unlimited'
        ? `budget ${budget}`
        : `budget ${compact(spent)}/${budget}`,
    tooltip:
      `What one turn may spend, counting fresh input and output but not what the cache served. ` +
      `${limit} ` +
      (spent === 0
        ? 'Nothing spent on the last turn yet.'
        : `${spent.toLocaleString()} spent on this turn so far.`) +
      ' The setting is remembered between sessions.',
    supplies: ['budget'],
  };
}

/**
 * Fold the transcript into a summary. Refused while a turn is running, while a saved conversation
 * is open for reading, and where there is nothing new since the last fold. The tooltip says how
 * much the agent is carrying, which is what the button is retitled with between turns.
 */
export function compactAction(state: Convo, reopened: boolean): Offer {
  const label = 'Compact';
  const tooltip = contextDetail(state);
  const no = (reason: string): Offer => ({
    ...refuse(reason),
    id: 'agent.compact',
    label,
    tooltip,
  });
  if (state.busy) return no('A turn is still running; wait for it to finish.');
  if (reopened)
    return no('This conversation is open for reading. Continue it before compacting it.');
  const last = state.feed[state.feed.length - 1];
  if (!last) return no('Nothing has been said in this conversation yet.');
  if (state.compactions[state.compactions.length - 1]?.afterId === last.id) {
    return no('This conversation was compacted already, and nothing has been said since.');
  }
  return { ok: true, id: 'agent.compact', props: {}, label, tooltip };
}

/**
 * Hand a saved conversation back to the agent. The refusal is the renderer's four checks; main
 * runs a fifth over the protocol its backend speaks, which only main knows.
 */
export function resumeAction(opened: OpenedThread | undefined, model: string): Offer {
  const label = 'Continue';
  const tooltip = 'Continue this conversation — the agent is shown everything above.';
  if (!opened) {
    return {
      ...refuse('No saved conversation is open.'),
      id: 'agent.resumeThread',
      label,
      tooltip,
    };
  }
  const refusal = resumeRefusal(opened.title, opened.resume, { model });
  if (refusal !== undefined) {
    return { ...refuse(refusal), id: 'agent.resumeThread', label, tooltip };
  }
  return { ok: true, id: 'agent.resumeThread', props: { id: opened.id }, label, tooltip };
}

/** End the turn after the step it is on. Refused when the agent is not saying anything. */
export function stopTurnAction(busy: boolean): Offer {
  const label = 'Stop';
  const tooltip = 'Stop the agent after the step it is on. What it already did is kept.';
  if (!busy) return { ...refuse('The agent is not running.'), id: 'agent.stop', label, tooltip };
  return { ok: true, id: 'agent.stop', props: {}, label, tooltip };
}

/** Save this conversation and start a fresh one. Always available: there is always one to save. */
export function newThreadAction(): Offer {
  return {
    ok     : true,
    id     : 'agent.newThread',
    props  : {},
    label  : 'New',
    tooltip:
      'Save this conversation and start a fresh one in plan mode. Nothing is lost — the old one ' +
      'stays under Threads.',
  };
}

/** What the Threads menu is built over: the saved conversations, and the one that is open. */
export interface ThreadsMenuState {
  threads: readonly ThreadHeader[];
  active?: string;
}

/**
 * The Threads menu: one `agent.openThread` row per saved conversation, the open one marked, then
 * the same fresh start the bar's New button offers. With nothing saved, one refused row says so
 * rather than the menu opening empty.
 */
export function threadsMenu(state: ThreadsMenuState): MenuEntry[] {
  const rows: MenuEntry[] =
    state.threads.length === 0
      ? [
          {
            label  : '(nothing saved yet)',
            id     : 'agent.openThread',
            refused: 'A conversation is saved once you have said something in it.',
          },
        ]
      : state.threads.map((thread) => ({
          label  : `${thread.id === state.active ? '• ' : ''}${threadLabel(thread)}`,
          id     : 'agent.openThread',
          props  : { id: thread.id },
          on     : thread.id,
          tooltip: threadDetail(thread),
        }));
  return [
    ...rows,
    SEPARATOR,
    { label: 'New conversation', id: 'agent.newThread', tooltip: 'Save this one and start again.' },
  ];
}

/**
 * Every offer the conversation editor draws from a rule module, in the order it draws them. The
 * mode button is the header's offer, drawn here a second time.
 */
export function controls(state: ConvoBarState): readonly Offer[] {
  return [
    modeAction(state.agentMode),
    modelAction(state.model),
    effortAction(state.model, state.effort),
    budgetAction(state.budget, state.spent),
    threadsAction(),
    newThreadAction(),
    compactAction(state.convo, state.opened !== undefined),
    resumeAction(state.opened, state.model),
    stopTurnAction(state.convo.busy),
  ];
}

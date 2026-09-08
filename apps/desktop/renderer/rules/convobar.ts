/**
 * What the conversation editor's bar offers. The refusals were already the app's own sentences;
 * moving them here makes each one a value beside the invocation it refuses, which is what lets the
 * button and its anchor come from one object.
 */
import { contextDetail, type Convo } from '../../src/shared/convo.js';
import type { OpenedThread } from '../../src/shared/threads.js';
import { resumeRefusal } from '../../src/shared/threads.js';
import { refuse, type Offer } from './anchors.js';
import { modeAction } from './headerbar.js';

/** What the conversation editor's bar reads when it draws. */
export interface ConvoBarState {
  convo: Convo;
  /** The saved conversation open for reading, if one is. */
  opened: OpenedThread | undefined;
  model: string;
  agentMode: string;
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

/**
 * Every offer the conversation editor draws from a rule module, in the order it draws them. The
 * mode button is the header's offer, drawn here a second time.
 */
export function controls(state: ConvoBarState): readonly Offer[] {
  return [
    modeAction(state.agentMode),
    newThreadAction(),
    compactAction(state.convo, state.opened !== undefined),
    resumeAction(state.opened, state.model),
    stopTurnAction(state.convo.busy),
  ];
}

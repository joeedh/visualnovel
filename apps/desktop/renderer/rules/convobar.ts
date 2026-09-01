/**
 * What the conversation editor's bar offers. The refusals were already the app's own sentences;
 * moving them here makes each one a value beside the invocation it refuses, which is what lets the
 * button and its anchor come from one object.
 */
import type { Convo } from '../../src/shared/convo.js';
import type { OpenedThread } from '../../src/shared/threads.js';
import { resumeRefusal } from '../../src/shared/threads.js';
import type { Offer } from './anchors.js';

/** The thread menu picks the conversation, so its id is not a prop the bar can record. */
export const THREAD_SUPPLIES = ['id'];

/**
 * Fold the transcript into a summary. Refused while a turn is running, while a saved conversation
 * is open for reading, and where there is nothing new since the last fold.
 */
export function compactAction(state: Convo, reopened: boolean): Offer {
  const no = (reason: string): Offer => ({ ok: false, id: 'agent.compact', reason });
  if (state.busy) return no('A turn is still running; wait for it to finish.');
  if (reopened)
    return no('This conversation is open for reading. Continue it before compacting it.');
  const last = state.feed[state.feed.length - 1];
  if (!last) return no('Nothing has been said in this conversation yet.');
  if (state.compactions[state.compactions.length - 1]?.afterId === last.id) {
    return no('This conversation was compacted already, and nothing has been said since.');
  }
  return { ok: true, id: 'agent.compact', props: {}, label: 'Compact' };
}

/**
 * Hand a saved conversation back to the agent. The refusal is the renderer's four checks; main
 * runs a fifth over the protocol its backend speaks, which only main knows.
 */
export function resumeAction(opened: OpenedThread | undefined, model: string): Offer {
  if (!opened)
    return { ok: false, id: 'agent.resumeThread', reason: 'No saved conversation is open.' };
  const refusal = resumeRefusal(opened.title, opened.resume, { model });
  if (refusal !== undefined) return { ok: false, id: 'agent.resumeThread', reason: refusal };
  return { ok: true, id: 'agent.resumeThread', props: { id: opened.id }, label: 'Continue' };
}

/** End the turn after the step it is on. Refused when the agent is not saying anything. */
export function stopTurnAction(busy: boolean): Offer {
  if (!busy) return { ok: false, id: 'agent.stop', reason: 'The agent is not running.' };
  return { ok: true, id: 'agent.stop', props: {}, label: 'Stop' };
}

/** Save this conversation and start a fresh one. Always available: there is always one to save. */
export function newThreadAction(): Offer {
  return { ok: true, id: 'agent.newThread', props: {}, label: 'New' };
}

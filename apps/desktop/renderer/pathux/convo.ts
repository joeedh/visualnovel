/**
 * The vnauthor conversation as a value: the transcript, the agent's last word, the plan waiting
 * for a decision, and whether a turn is in flight.
 *
 * `useAgent` kept all of this in React state and reduced the event stream inside a `useEffect`,
 * so what one `agent:event` does to the conversation was never testable on its own. Here the
 * reduction is a pure function of `(Convo, event)` and the subscription is somebody else's
 * problem — `agent.ts` holds the live one.
 *
 * Ids come from `Convo.seq` rather than a module counter, which is what keeps `received` pure;
 * clearing carries the counter over, so a cleared conversation never reuses an id.
 */
import type { AgentEvent, PlanRequest } from '../../src/shared/ipc.js';

/** A rendered line in the transcript. */
export interface FeedItem {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'blocked';
  text: string;
}

export interface Convo {
  feed: readonly FeedItem[];
  /** What the dialogue box says: the agent's last word, never a transcript line. */
  line: string;
  /** A plan awaiting approval — the gate between plan mode and execute mode. */
  plan: PlanRequest | null;
  /** A turn is in flight, so the composer is closed. Also raised by a pipeline run. */
  busy: boolean;
  /** Feed ids issued so far. */
  seq: number;
}

export function emptyConvo(line: string): Convo {
  return { feed: [], line, plan: null, busy: false, seq: 0 };
}

function push(convo: Convo, role: FeedItem['role'], text: string): Convo {
  const seq = convo.seq + 1;
  return { ...convo, seq, feed: [...convo.feed, { id: seq, role, text }] };
}

/** The author's turn, the moment it is sent — the transcript shows it before the agent reads it. */
export function asked(convo: Convo, text: string): Convo {
  return { ...push(convo, 'user', text), busy: true };
}

/**
 * The turn came back. A refused or empty run leaves the last thing the agent said standing:
 * blanking the dialogue box would erase the only record of what it did.
 */
export function answered(convo: Convo, final: string | null): Convo {
  return { ...convo, busy: false, line: final ?? convo.line };
}

/**
 * One streamed event. A `mode` event is the *shell's* — `ui.agentMode` is what the header reads —
 * and a `plan` event only reports a decision that `permission:plan` already asked for, so neither
 * changes the conversation.
 */
export function received(convo: Convo, event: AgentEvent): Convo {
  switch (event.type) {
    case 'tool':
      return push(convo, 'tool', event.tool);
    case 'blocked':
      return push(convo, 'blocked', `${event.tool} blocked — ${event.reason}`);
    case 'message':
    case 'final':
      return { ...convo, line: event.text };
    default:
      return convo;
  }
}

export function proposed(convo: Convo, request: PlanRequest): Convo {
  return { ...convo, plan: request };
}

/** The plan card is answered and gone; what the decision *means* is the agent's to say. */
export function decided(convo: Convo): Convo {
  return { ...convo, plan: null };
}

/** Start over, keeping the id counter so no two feed items ever share an id in one session. */
export function cleared(convo: Convo, line: string): Convo {
  return { ...emptyConvo(line), seq: convo.seq };
}

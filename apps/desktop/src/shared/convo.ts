/**
 * The vnauthor conversation as a value: the transcript, the agent's last word, the plan waiting
 * for a decision, and whether a turn is in flight.
 *
 * `useAgent` kept all of this in React state and reduced the event stream inside a `useEffect`,
 * so what one `agent:event` does to the conversation was never testable on its own. Here the
 * reduction is a pure function of `(Convo, event)` and the subscription is somebody else's
 * problem — `renderer/pathux/agent.ts` holds the live one.
 *
 * It is **shared** rather than renderer-only because main writes the same transcript to
 * `vngen/state/threads/<id>.jsonl` as it emits. Two reducers over one event stream would drift
 * within a week, so there is one, and the file and the screen are derived from it identically.
 *
 * Ids come from `Convo.seq` rather than a module counter, which is what keeps `received` pure;
 * clearing carries the counter over, so a cleared conversation never reuses an id.
 */
import type { AgentEvent, AskRequest, ConfirmRequest, PlanRequest } from './ipc.js';

/** A rendered line in the transcript. */
export interface FeedItem {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'blocked';
  text: string;
}

/**
 * A saved conversation's header. Beside `FeedItem` rather than beside the store in
 * `main/threads.ts` because both sides of the bridge hold one — main writes it, and
 * `agent.threads` hands it to the dropdown — and `main/` is node-only.
 */
export interface ThreadHeader {
  id: string;
  title: string;
  startedAt: string;
  /** The commit the conversation opened at — what turns a decision into the tree it was made against. */
  commit?: string;
  model?: string;
}

/** A whole saved conversation: the header plus every transcript line, in order. */
export interface ThreadRecord extends ThreadHeader {
  items: FeedItem[];
}

export interface Convo {
  feed: readonly FeedItem[];
  /** What the dialogue box says: the agent's last word, never a transcript line. */
  line: string;
  /** A plan awaiting approval — the gate between plan mode and execute mode. */
  plan: PlanRequest | null;
  /** A question the agent asked and is parked on. */
  question: AskRequest | null;
  /** An always-confirm tool parked on a yes. */
  confirm: ConfirmRequest | null;
  /** A turn is in flight, so the composer is closed. Also raised by a pipeline run. */
  busy: boolean;
  /**
   * Ways to phrase the next turn, offered by whatever opened the conversation. They are chips
   * that *fill* the composer rather than messages that are sent — the point is to teach the shape
   * of a good prompt, and sending one removes the moment where the author edits it into what they
   * actually meant. Nothing writes them to a thread: a suggestion is not something anyone said.
   */
  suggestions: readonly string[];
  /** Feed ids issued so far. */
  seq: number;
}

export function emptyConvo(line: string): Convo {
  return {
    feed: [],
    line,
    plan: null,
    question: null,
    confirm: null,
    busy: false,
    suggestions: [],
    seq: 0,
  };
}

function push(convo: Convo, role: FeedItem['role'], text: string): Convo {
  const seq = convo.seq + 1;
  return { ...convo, seq, feed: [...convo.feed, { id: seq, role, text }] };
}

/** The author's turn, the moment it is sent — the transcript shows it before the agent reads it. */
export function asked(convo: Convo, text: string): Convo {
  // Whatever was suggested has been answered, taken or ignored; leaving the chips up would offer
  // to start a conversation that is already under way.
  return { ...push(convo, 'user', text), busy: true, suggestions: [] };
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
 *
 * What the agent says goes to **both** places, the way a visual novel's dialogue box and its
 * backlog hold the same line: the box is what is being said now, the transcript is what was said.
 * A transcript of only the author's turns and the tools they caused is a record of an argument
 * with one side missing — and it is the side a saved thread is reopened to read.
 */
export function received(convo: Convo, event: AgentEvent): Convo {
  switch (event.type) {
    case 'tool':
      return push(convo, 'tool', event.tool);
    case 'blocked':
      return push(convo, 'blocked', `${event.tool} blocked — ${event.reason}`);
    case 'message':
    case 'final':
      return { ...push(convo, 'agent', event.text), line: event.text };
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

export function queried(convo: Convo, request: AskRequest): Convo {
  return { ...convo, question: request };
}

/**
 * The answer is the author's own turn, so it goes into the transcript as one. A card that
 * vanished leaving only the question behind reads as unanswered, and the agent's next sentence
 * then makes no sense. An empty answer is a real answer — "nothing to add" — and says so.
 */
export function answeredQuestion(convo: Convo, answer: string): Convo {
  const said = answer.trim() === '' ? '(no answer)' : answer;
  return { ...push(convo, 'user', said), question: null };
}

export function confirmAsked(convo: Convo, request: ConfirmRequest): Convo {
  return { ...convo, confirm: request };
}

/** A refusal is worth a line — the agent reports an allow itself, but a deny it may not mention. */
export function confirmDecided(convo: Convo, allowed: boolean): Convo {
  const tool = convo.confirm?.tool ?? '';
  const next: Convo = { ...convo, confirm: null };
  return allowed ? next : push(next, 'blocked', `${tool} denied — you said no`);
}

/** Start over, keeping the id counter so no two feed items ever share an id in one session. */
export function cleared(convo: Convo, line: string): Convo {
  return { ...emptyConvo(line), seq: convo.seq };
}

/**
 * A fresh conversation somebody else opened — an upload, today — with the question it arrived
 * with in the dialogue box and the chips under it. `cleared` plus the openers, deliberately: what
 * came before belongs to the thread that was just saved, not to the one being asked about.
 */
export function offered(convo: Convo, line: string, suggestions: readonly string[]): Convo {
  return { ...cleared(convo, line), suggestions: [...suggestions] };
}

/**
 * A saved thread put back on screen. The banner is the dialogue box rather than a transcript line
 * because it is not something anyone said — and because it must be the sentence still visible when
 * the author has scrolled the replayed turns out of sight.
 *
 * Stored items keep the ids they were written with, and `seq` resumes past the highest of them, so
 * a turn typed after a replay cannot collide with one being replayed.
 */
export function replayed(convo: Convo, items: readonly FeedItem[], banner: string): Convo {
  const highest = items.reduce((max, item) => Math.max(max, item.id), 0);
  return { ...emptyConvo(banner), feed: [...items], seq: Math.max(convo.seq, highest) };
}

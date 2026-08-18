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
import { charge } from '@vn/types';
import type { AgentEvent, AskRequest, ConfirmRequest, PlanDecision, PlanRequest } from './ipc.js';

/** What a tool was called with and what came back — the half of a turn `text` cannot hold. */
export interface ToolDetail {
  /** The arguments, JSON-stringified. Clamped on the way to disk, like everything else. */
  args?: string;
  ok?: boolean;
  output?: string;
}

/**
 * A rendered line in the transcript.
 *
 * `full` and `detail` are for a reader that is not a person: a transcript is clamped so the log
 * stays a log, but an analyst asked *why the agent did that* needs the sentence that was cut and
 * the call that was summarised. Nothing on screen reads either — the renderer draws `text`.
 */
export interface FeedItem {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'blocked';
  text: string;
  /** The text at full length, present only when `text` was clamped writing it down. */
  full?: string;
  /** For a `tool` item: what it was called with and whether it worked. */
  detail?: ToolDetail;
  /**
   * When the line was written down. Absent on a live item and stamped by `appendItem`, so it is
   * present on anything read back — which is what lets a report line a conversation up against
   * `commands.jsonl` and say what the app was doing while it was being had.
   */
  at?: string;
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
  /**
   * What the conversation was last had on. Written at line 0 and again whenever the author
   * switches mid-thread, so reopening one comes back on the binding it ended with rather than the
   * one it started with — a thread thought through on Opus is not a thread to answer on Haiku.
   */
  model?: string;
  effort?: string;
  /**
   * Where this conversation was put into git, oldest first. Written when a thread is closed, so a
   * transcript the author has moved on from is recoverable from history rather than only from the
   * file it may since have been edited out of.
   */
  archived?: ThreadArchive[];
}

/**
 * One commit that holds a thread as it stood at a moment. The commit is what a diagnostic reads:
 * `git show <commit>:vngen/state/threads/<id>.jsonl` is the conversation as it was before whatever
 * happened next, and `git log --grep='Vn-Thread: <id>'` finds every such commit even where this
 * record is missing — the record is the fast path, not the only one.
 */
export interface ThreadArchive {
  commit: string;
  at: string;
}

/** A whole saved conversation: the header plus every transcript line, in order. */
export interface ThreadRecord extends ThreadHeader {
  items: FeedItem[];
}

/**
 * How a conversation reads in a list, and what the row says on hover. Here rather than in the pane
 * that first drew one, because two surfaces now offer the same list — the Threads menu and the
 * report dialog's dropdown — and a conversation should not be named differently by each.
 */
export function threadLabel(thread: ThreadHeader): string {
  const at = new Date(thread.startedAt);
  if (Number.isNaN(at.getTime())) return thread.title;
  const when = at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${thread.title} · ${when}`;
}

/** The tooltip: the facts the row had no room for. */
export function threadDetail(thread: ThreadHeader): string {
  const at = new Date(thread.startedAt);
  const parts = [Number.isNaN(at.getTime()) ? thread.startedAt : at.toLocaleString()];
  if (thread.model) parts.push(thread.model);
  if (thread.effort) parts.push(`effort: ${thread.effort}`);
  if (thread.commit) parts.push(thread.commit.slice(0, 8));
  const saved = thread.archived?.[thread.archived.length - 1];
  if (saved) parts.push(`saved in git as ${saved.commit.slice(0, 8)}`);
  return parts.join(' · ');
}

/**
 * The tokens counter's tooltip — the exact figures the glanceable label rounds off, and what the
 * cache did with them. Here rather than in the pane that draws it for the reason `threadDetail`
 * is: it is prose about a value, and the editor above it is meant to be thin rendering.
 *
 * The cache sentence appears only where the provider reported something, and is worded as an
 * estimate where what it reported was a matched prefix rather than a bill. Saying "read from
 * cache" of Gemini's count would promise an exactness that is not there — it says nothing at all
 * on many calls that hit, so a low share may mean *not said* rather than *missed*.
 */
export function tokensDetail(tokens: Convo['tokens']): string {
  const { input, output, cacheRead, cacheWrite, cacheEstimated } = tokens;
  if (input + output === 0) return 'What this conversation has cost so far. Nothing counted yet.';

  const lines = [
    `${input.toLocaleString()} in, ${output.toLocaleString()} out, this conversation.`,
  ];
  // The percentage is of input, because that is the number caching moves.
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    // What the counter itself shows, said before the split it comes from — a provider that
    // reported no split has nothing to subtract, and the line above is already that number.
    lines.unshift(
      `${uncachedTokens(tokens).toLocaleString()} the cache did not serve — what the counter ` +
        'shows.',
    );
    const read = cacheRead ?? 0;
    const share = input === 0 ? 0 : Math.round((read / input) * 100);
    lines.push(
      cacheEstimated
        ? `Of the input, roughly ${read.toLocaleString()} (${share}%) was already cached — an ` +
            'estimate, because the provider reports what it matched rather than what it billed, ' +
            'and says nothing at all on many calls that did hit.'
        : `Of the input, ${read.toLocaleString()} read from cache (${share}%) and ` +
            `${(cacheWrite ?? 0).toLocaleString()} written to it.`,
    );
  }
  lines.push('Retried steps are counted every time. Clearing the conversation resets it.');
  return lines.join(' ');
}

/**
 * What the counter counts: fresh input plus output, cache reads excluded — the same arithmetic
 * the turn budget is measured in, and the number that moves with the bill. Total input is the
 * wrong figure to show: a long conversation re-sends its whole cached prefix on every step, so a
 * counter reading it climbs by tens of thousands for a turn that said one sentence.
 *
 * A provider that reports no cache split spends its whole input, because absent means it said
 * nothing, which here is the same as nothing having been cached.
 */
export function uncachedTokens(tokens: Convo['tokens']): number {
  return charge(tokens);
}

/**
 * A tool line, as the transcript shows it: the tool's name and the one argument that says what it
 * acted on. `read_file` alone is a line that could be about anything, and a transcript of forty
 * of them is unreadable; `read_file wiki/hollow-court.md` is the record the author came for.
 *
 * One argument, not all of them — the whole call is in `detail.args`, which is what an analyst
 * reads. The headline is the first field present from a fixed list, so the choice does not depend
 * on JSON key order, and it is clamped because a `write_file` carries a whole document.
 */
export function toolSummary(tool: string, args: unknown): string {
  const shown = headlineArg(args);
  return shown ? `${tool} ${shown}` : tool;
}

/** The fields worth putting on a transcript line, in the order they are preferred. */
const HEADLINE_KEYS = [
  'path',
  'file',
  'target',
  'sceneId',
  'scene',
  'id',
  'characterId',
  'locationId',
  'hash',
  'slot',
  'query',
  'pattern',
  'text',
  'name',
  'skill',
  'rule',
];

/** Where a headline stops being a glance. The full value is in `detail.args`. */
const HEADLINE_MAX = 60;

function headlineArg(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const bag = args as Record<string, unknown>;
  for (const key of HEADLINE_KEYS) {
    const said = scalar(bag[key]);
    if (said) return said;
  }
  // Nothing recognised: a one-field call still says what it was about, and a call with several
  // unrecognised fields says nothing rather than picking one at random.
  const values = Object.values(bag);
  return values.length === 1 ? scalar(values[0]) : '';
}

function scalar(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : Array.isArray(value)
          ? value.filter((v) => typeof v === 'string' || typeof v === 'number').join(', ')
          : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= HEADLINE_MAX ? flat : `${flat.slice(0, HEADLINE_MAX).trimEnd()}…`;
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
  /**
   * What this conversation has cost, in tokens the provider billed — the running total the
   * composer's bar shows. It counts *calls*, not turns: a step the backend had to retry was paid
   * for every time. Nothing writes it to a thread, so a reopened one starts at zero and says so;
   * the number is about the money being spent now.
   *
   * `cacheRead`/`cacheWrite` are part of `input`, not extra: they say how much of it was billed
   * at the cache rates. They stay absent until some step reports one, because a provider that
   * says nothing about caching is not a cache that missed. `cacheEstimated` says that split is a
   * matched-prefix count rather than a bill, which is all Gemini's implicit cache can offer.
   */
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheEstimated?: boolean;
  };
  /**
   * What the turn in flight has spent against its budget: fresh input plus output, cache reads
   * excluded, which is the same arithmetic the loop's own meter runs. Zeroed when a turn is sent
   * rather than when one ends, so the label a finished turn leaves behind says what it cost.
   */
  turnSpend: number;
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
    tokens: { input: 0, output: 0 },
    turnSpend: 0,
    seq: 0,
  };
}

function push(convo: Convo, role: FeedItem['role'], text: string, detail?: ToolDetail): Convo {
  const seq = convo.seq + 1;
  const item: FeedItem = { id: seq, role, text, ...(detail ? { detail } : {}) };
  return { ...convo, seq, feed: [...convo.feed, item] };
}

/**
 * Tool args as a string. A tool call arrives as parsed JSON, so there is nothing to cycle — but
 * this is on the path every turn takes, and a thrown `TypeError` here would lose the turn rather
 * than one field of it.
 */
function stringifyArgs(args: unknown): string {
  if (args === undefined) return '';
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/** The author's turn, the moment it is sent — the transcript shows it before the agent reads it. */
export function asked(convo: Convo, text: string): Convo {
  // Whatever was suggested has been answered, taken or ignored; leaving the chips up would offer
  // to start a conversation that is already under way.
  return { ...push(convo, 'user', text), busy: true, suggestions: [], turnSpend: 0 };
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
 *
 * A `tool` event's args and result go into `detail` rather than into the line: the transcript says
 * which tool ran, and what it ran on is evidence, not display. Sizing is somebody else's job —
 * `text` is held in full here too, and clamped where it is written down.
 */
export function received(convo: Convo, event: AgentEvent): Convo {
  switch (event.type) {
    case 'tool':
      return push(convo, 'tool', toolSummary(event.tool, event.args), {
        args: stringifyArgs(event.args),
        ok: event.result.ok,
        output: event.result.output,
      });
    case 'blocked':
      return push(
        convo,
        'blocked',
        `${toolSummary(event.tool, event.args)} blocked — ${event.reason}`,
        event.args === undefined ? undefined : { args: stringifyArgs(event.args), ok: false },
      );
    case 'usage': {
      const tokens: Convo['tokens'] = {
        input: convo.tokens.input + event.input,
        output: convo.tokens.output + event.output,
      };
      if (convo.tokens.cacheRead !== undefined || event.cacheRead !== undefined) {
        tokens.cacheRead = (convo.tokens.cacheRead ?? 0) + (event.cacheRead ?? 0);
      }
      if (convo.tokens.cacheWrite !== undefined || event.cacheWrite !== undefined) {
        tokens.cacheWrite = (convo.tokens.cacheWrite ?? 0) + (event.cacheWrite ?? 0);
      }
      // Sticky, like the sum it qualifies: a running total that mixed a bill with a guess is a
      // guess, and Gemini reports nothing at all for the first calls of a conversation.
      if (convo.tokens.cacheEstimated || event.cacheEstimated) tokens.cacheEstimated = true;
      return { ...convo, tokens, turnSpend: convo.turnSpend + charge(event) };
    }
    case 'message':
    case 'final':
      return { ...push(convo, 'agent', event.text), line: event.text };
    default:
      return convo;
  }
}

/**
 * A plan card, and the transcript line that says one was offered. The card is transient — it is
 * answered and gone — and a thread that held only the answer read as a decision about nothing,
 * which is precisely the turn a report on a bad conversation needs to see.
 */
export function proposed(convo: Convo, request: PlanRequest): Convo {
  const { summary, steps, files, risks } = request.plan;
  const detail = [
    steps.length ? `Steps:\n${steps.map((s) => `- ${s}`).join('\n')}` : '',
    files.length ? `Files: ${files.join(', ')}` : '',
    risks?.length ? `Risks:\n${risks.map((r) => `- ${r}`).join('\n')}` : '',
  ].filter(Boolean);
  const text = [`Proposed a plan: ${summary}`, ...detail].join('\n\n');
  return { ...push(convo, 'agent', text), plan: request };
}

/**
 * The plan card is answered and gone. The decision is the author's turn, so it is written as one;
 * what it *means* is still the agent's to say.
 */
export function decided(convo: Convo, decision?: PlanDecision): Convo {
  const next: Convo = { ...convo, plan: null };
  if (!decision) return next;
  const said = decision.approved ? 'Approved the plan.' : 'Declined the plan.';
  const why = decision.feedback?.trim();
  return push(next, 'user', why ? `${said} ${why}` : said);
}

/**
 * A question the agent asked, in the transcript beside the answer to it. The option list goes
 * down with it: an answer of "the second one" is unreadable without the list it picked from.
 */
export function queried(convo: Convo, request: AskRequest): Convo {
  const options = request.choices?.length
    ? `\n${request.choices.map((c) => `- ${c}`).join('\n')}` +
      (request.multi ? '\n(more than one may be picked)' : '')
    : '';
  return { ...push(convo, 'agent', `${request.question}${options}`), question: request };
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

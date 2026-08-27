/**
 * The vnauthor conversation as a value: the transcript, the agent's last word, the plan waiting
 * for a decision, and whether a turn is in flight.
 *
 * The reduction is a pure function of `(Convo, event)`; the live subscription lives in
 * `renderer/pathux/agent.ts`. This module is shared rather than renderer-only because main writes
 * the same transcript to `vngen/state/threads/<id>.jsonl` as it emits, and one reducer keeps the
 * file and the screen from drifting apart.
 *
 * Ids come from `Convo.seq` rather than a module counter, which keeps `received` pure. Clearing
 * carries the counter over, so a cleared conversation never reuses an id.
 */
import { charge } from '@vn/types';
import type { ChatVendor } from '@vn/types';
// Type-only, for the reason `ipc.ts` gives: `@vn/authoring` reads the filesystem, and these
// shapes are named here only as data that has already crossed the wire.
import type { BackendKind, CacheVerdict, SystemSection } from '@vn/authoring';
import type {
  AgentEvent,
  AskQuestion,
  AskRequest,
  ConfirmRequest,
  PlanDecision,
  PlanRequest,
} from './ipc.js';

/** What a tool was called with and what came back. The transcript line itself is in `text`. */
export interface ToolDetail {
  /** The arguments, JSON-stringified. Clamped when written to disk. */
  args?: string;
  ok?: boolean;
  output?: string;
}

/**
 * A rendered line in the transcript.
 *
 * `full` and `detail` exist for the report analyst rather than the screen: the transcript is
 * clamped, and the analyst needs the sentence that was cut and the call that was summarised. The
 * renderer draws `text` and reads neither.
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
   * When the line was written down. Absent on a live item and stamped by `appendItem`, so every
   * line read back carries one, which lets a report line a conversation up against
   * `commands.jsonl`.
   */
  at?: string;
}

/**
 * What one API call cost, written down. A receipt is not a transcript line — nobody said it — so it
 * is a record of its own rather than a `FeedItem`, and it carries the step it belongs to so a
 * reader can line it up against the transcript without matching timestamps.
 *
 * `verdict` is what the call did to the prompt cache, and is present only where the backend's
 * figures can be compared across calls. Absent means the question was not answerable.
 */
export interface ThreadUsage {
  step: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheEstimated?: boolean;
  verdict?: CacheVerdict;
  at: string;
}

/**
 * A saved conversation's header. It lives here rather than beside the store in `main/threads.ts`
 * because both sides of the bridge hold one (main writes it, and `agent.threads` hands it to the
 * dropdown) and `main/` is node-only.
 */
export interface ThreadHeader {
  id: string;
  title: string;
  startedAt: string;
  /**
   * The model the conversation last ran on. Written at line 0 and again whenever the author
   * switches mid-thread, so reopening a thread resumes on the model it ended with rather than the
   * one it started with.
   */
  model?: string;
  effort?: string;
  /**
   * Where this conversation was put into git, oldest first. Written when a thread is closed, so a
   * transcript stays recoverable from history even after the file it lived in changes.
   */
  archived?: ThreadArchive[];
}

/**
 * One commit holding a thread as it stood at a moment. A diagnostic reads the thread back with
 * `git show <commit>:vngen/state/threads/<id>.jsonl`. Where this record is missing,
 * `git log --grep='Vn-Thread: <id>'` still finds every such commit.
 */
export interface ThreadArchive {
  commit: string;
  at: string;
}

/**
 * A compaction as the transcript shows it: where the rule is drawn, how much of the conversation
 * the summary stands in for, and the summary itself. `text` is clamped where it is written down,
 * exactly as a {@link FeedItem} is, and `full` carries what was cut.
 */
export interface CompactionMark {
  /** The feed item the rule is drawn under. Zero when nothing had been said above it. */
  afterId: number;
  /** How many messages the summary replaced, for the rule's sentence. */
  covers: number;
  text: string;
  full?: string;
  at?: string;
  /** The model that wrote the summary. */
  model?: string;
}

/**
 * A whole saved conversation: the header plus every transcript line, in order.
 *
 * `usage` is absent on a thread that recorded no receipts, which is every thread written before
 * they were recorded and every thread had on a backend that reports nothing.
 */
export interface ThreadRecord extends ThreadHeader {
  items: FeedItem[];
  /** Every compaction the conversation has had, oldest first. */
  compactions: CompactionMark[];
  usage?: ThreadUsage[];
}

/**
 * Line 0 of a thread's native log — what the conversation was recorded through. It lives here for
 * the reason {@link ThreadHeader} does: the renderer greys the Continue button on the same check
 * main runs, so both sides name this shape.
 */
export interface ResumeHeader {
  /** Format version. A log written by a newer version is refused rather than read on a guess. */
  v: number;
  /** The thread this log belongs to, so a file separated from its name still says which. */
  thread: string;
  at: string;
  backend: BackendKind;
  /**
   * The vendor in force when the thread was written. Stored rather than recomputed on read: every
   * copy of the rule falls back to `gemini` for an id it does not know, so recomputing it over a
   * model the current table has forgotten would answer `gemini` without saying it was guessing.
   */
  vendor: ChatVendor;
  model?: string;
  effort?: string;
  /** The system prompt as named sections, in `joinSections` order. */
  sections: SystemSection[];
}

/**
 * How a conversation reads as a list row. Shared rather than kept in one pane because two surfaces
 * offer the same list (the Threads menu and the report dialog's dropdown) and a conversation
 * should not be named differently by each.
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

/** Tooltip for a thread row, carrying the facts the label has no room for. */
export function threadDetail(thread: ThreadHeader): string {
  const at = new Date(thread.startedAt);
  const parts = [Number.isNaN(at.getTime()) ? thread.startedAt : at.toLocaleString()];
  if (thread.model) parts.push(thread.model);
  if (thread.effort) parts.push(`effort: ${thread.effort}`);
  const saved = thread.archived?.[thread.archived.length - 1];
  if (saved) parts.push(`saved in git as ${saved.commit.slice(0, 8)}`);
  return parts.join(' · ');
}

/**
 * Tooltip for the tokens counter, carrying the exact figures the label rounds off and what the
 * cache did with them. It lives here rather than in the pane that draws it, for the same reason
 * `threadDetail` does: prose about a value belongs outside an editor that stays thin rendering.
 *
 * It is written for an author rather than for whoever wrote the counter, which is why it says what
 * a token is every time and spends words on the cache being cheaper rather than on the split being
 * reported. The words the API uses for these numbers — input, output, cache read, cache write — are
 * not in it: the reader is being told what their conversation cost, not what a response body said.
 *
 * The cache sentence appears only where the provider reported something, and is hedged where the
 * report was a matched prefix rather than a bill. Gemini reports nothing at all on many calls that
 * did hit the cache, so a low share there may mean the provider stayed silent rather than that the
 * cache missed.
 */
export function tokensDetail(tokens: Convo['tokens']): string {
  const { input, output, cacheRead, cacheWrite, cacheEstimated } = tokens;
  const what =
    'Tokens are how a model measures text — about three quarters of a word each, and what you ' +
    'are charged for.';
  if (input + output === 0) return `${what} Nothing used in this conversation yet.`;

  const lines = [what];
  const sent = `It has sent ${input.toLocaleString()} and got ${output.toLocaleString()} back.`;
  if (cacheRead === undefined && cacheWrite === undefined) {
    lines.push(sent);
  } else {
    // The counter's own figure is listed before the two it is derived from, so it is the first
    // number the reader meets, matching the figure they were hovering over
    lines.push(
      `The counter shows ${uncachedTokens(tokens).toLocaleString()} — the part charged at full ` +
        'price.',
      sent,
    );
    const read = cacheRead ?? 0;
    // The share is computed against input tokens, since caching moves the sent half rather than the received half
    const share = input === 0 ? 0 : Math.round((read / input) * 100);
    lines.push(
      cacheEstimated
        ? `Roughly ${read.toLocaleString()} of what it sent (${share}%) was text the model had ` +
            'already been given, so it came back from the cache far cheaper. Roughly, because ' +
            'this provider says what it recognised rather than what it charged for, and often ' +
            'says nothing at all on a call the cache did help.'
        : `${read.toLocaleString()} of what it sent (${share}%) was text the model had already ` +
            'been given, so it came back from the cache far cheaper, and ' +
            `${(cacheWrite ?? 0).toLocaleString()} was put there for next time.`,
    );
  }
  lines.push('Retries count every time. Clearing the conversation starts the count over.');
  return lines.join(' ');
}

/**
 * Fresh input plus output, cache reads excluded. This is the arithmetic the turn budget is
 * measured in and the number that tracks the bill. Total input would be the wrong figure to show:
 * a long conversation re-sends its whole cached prefix on every step, so a counter reading it
 * climbs by tens of thousands for a turn that said one sentence.
 *
 * A provider that reports no cache split is charged for its whole input, since a missing split is
 * treated the same as nothing having been cached.
 */
export function uncachedTokens(tokens: Convo['tokens']): number {
  return charge(tokens);
}

/**
 * How much conversation the agent may be carrying before the Compact button asks for attention.
 * Measured against `Convo.context`, which is one request's input rather than a running total.
 */
export const COMPACT_HINT_TOKENS = 120_000;

/** Tooltip for the Compact button: what compacting does, and how much there is to compact. */
export function contextDetail(convo: Convo): string {
  const what =
    'Summarize what has been said so far, so the agent carries a summary instead of every turn. ' +
    'Nothing is deleted — the summary is added to the saved conversation, and the turns above it ' +
    'stay readable.';
  if (convo.context === undefined) {
    return `${what} How much the agent is carrying is not known until a turn has run.`;
  }
  const size = `The last turn sent it ${convo.context.toLocaleString()} tokens of conversation.`;
  return convo.context >= COMPACT_HINT_TOKENS
    ? `${what} ${size} That is large enough to be worth compacting.`
    : `${what} ${size}`;
}

/**
 * A tool line as the transcript shows it: the tool's name plus the one argument saying what it
 * acted on, so a row reads `read_file wiki/hollow-court.md` rather than `read_file`.
 *
 * Only one argument appears; the whole call is in `detail.args`, which is what an analyst reads.
 * The headline is the first field present from `HEADLINE_KEYS`, so the choice does not depend on
 * JSON key order, and it is clamped because a `write_file` carries a whole document.
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

/** Longest headline argument a transcript line shows. The full value is in `detail.args`. */
const HEADLINE_MAX = 60;

function headlineArg(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const bag = args as Record<string, unknown>;
  for (const key of HEADLINE_KEYS) {
    const said = scalar(bag[key]);
    if (said) return said;
  }
  // No recognised key. A one-field call is headlined by that field; a call with several
  // unrecognised fields gets no headline rather than an arbitrary one
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
   * Ways to phrase the next turn, offered by whatever opened the conversation. Picking one fills
   * the composer rather than sending a message, which leaves the author a chance to edit it.
   * Nothing writes suggestions to a thread, because nobody said them.
   */
  suggestions: readonly string[];
  /**
   * What this conversation has cost, in tokens the provider billed, and the running total the
   * composer's bar shows. It counts API calls rather than turns, so a step the backend retried is
   * counted every time. Nothing writes it to a thread, so a reopened thread starts at zero and
   * says so; the number covers only what is being spent now.
   *
   * `cacheRead` and `cacheWrite` are part of `input` rather than extra, and say how much of it was
   * billed at the cache rates. Both stay absent until some step reports one, because a provider
   * that says nothing about caching has not reported a miss. `cacheEstimated` marks the split as a
   * matched-prefix count rather than a bill, which is all Gemini's implicit cache offers.
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
  /**
   * How much conversation the last request carried, in tokens — the whole prefix, cached part
   * included, which is what compaction shrinks. Absent until a turn has run, and dropped again by
   * a compaction, because what the next request will carry is not known until it has been made.
   */
  context?: number;
  /** The compactions this conversation has had, oldest first, each drawn as a rule. */
  compactions: readonly CompactionMark[];
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
    compactions: [],
    seq: 0,
  };
}

function push(convo: Convo, role: FeedItem['role'], text: string, detail?: ToolDetail): Convo {
  const seq = convo.seq + 1;
  const item: FeedItem = { id: seq, role, text, ...(detail ? { detail } : {}) };
  return { ...convo, seq, feed: [...convo.feed, item] };
}

/**
 * Tool args as a string. A tool call arrives as parsed JSON, so there is no cycle to hit, but
 * every turn passes through here and a thrown `TypeError` would lose the whole turn rather than
 * one field of it.
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
  // Clears the suggestions: they have been answered, taken or ignored, and leaving them up would
  // offer to start a conversation that is already under way
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
 * One streamed event. A `mode` event belongs to the shell, whose header reads `ui.agentMode`, and
 * a `plan` event only reports a decision `permission:plan` already asked for, so neither changes
 * the conversation.
 *
 * What the agent says goes to both the dialogue box and the transcript: the box holds what is
 * being said now, the transcript what was said. A transcript carrying only the author's turns and
 * the tools they caused would leave out the side a saved thread is reopened to read.
 *
 * A `tool` event's args and result go into `detail` rather than into the line, so the transcript
 * says which tool ran and what it ran on stays available as evidence. `text` is held in full here
 * and clamped where it is written down.
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
      // Sticky once set. A running total that mixes a bill with a guess is a guess, and Gemini
      // reports nothing at all for the first calls of a conversation
      if (convo.tokens.cacheEstimated || event.cacheEstimated) tokens.cacheEstimated = true;
      // `input` is the whole prefix the call sent, cache reads included, so the newest one is how
      // much conversation the agent is carrying right now
      return {
        ...convo,
        tokens,
        turnSpend: convo.turnSpend + charge(event),
        context: event.input,
      };
    }
    case 'message':
    case 'final':
      return { ...push(convo, 'agent', event.text), line: event.text };
    default:
      return convo;
  }
}

/**
 * Raises a plan card and writes the transcript line saying one was offered. The card itself is
 * cleared once answered, so a thread holding only the answer would read as a decision about
 * nothing, and that turn is what a report on a bad conversation needs to see.
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
 * Clears the plan card once it is answered. The decision is written into the transcript as the
 * author's turn; interpreting it remains the agent's job.
 */
export function decided(convo: Convo, decision?: PlanDecision): Convo {
  const next: Convo = { ...convo, plan: null };
  if (!decision) return next;
  const said = decision.approved ? 'Approved the plan.' : 'Declined the plan.';
  const why = decision.feedback?.trim();
  return push(next, 'user', why ? `${said} ${why}` : said);
}

/** One question of a form as the transcript reads it: the question, then what it offered. */
function questionText(item: AskQuestion): string {
  const options = item.choices?.length
    ? `\n${item.choices.map((c) => `- ${c}`).join('\n')}` +
      (item.multi ? '\n(more than one may be picked)' : '')
    : '';
  return `${item.question}${options}`;
}

/**
 * Records a form the agent asked, so the transcript holds it beside the answers. Each option list
 * is written down with its question, because an answer of "the second one" is unreadable without
 * the list it was picked from. A form of several questions becomes one transcript line rather than
 * one per question, so the author's reply (also one line) sits directly beneath it.
 */
export function queried(convo: Convo, request: AskRequest): Convo {
  const text = request.questions.map(questionText).join('\n\n');
  return { ...push(convo, 'agent', text), question: request };
}

/**
 * The answers are the author's own turn, so they go into the transcript as one. Clearing the card
 * without recording them would leave the question reading as unanswered, and the agent's next
 * sentence would then make no sense. An empty answer is deliberate and is written down as
 * `(no answer)`.
 *
 * A form of several questions is numbered, because the answers are positional and nothing else in
 * the line says which question a bare "yes" belongs to.
 */
export function answeredQuestion(convo: Convo, answers: readonly string[]): Convo {
  const said = (text: string): string => (text.trim() === '' ? '(no answer)' : text.trim());
  const text =
    answers.length <= 1
      ? said(answers[0] ?? '')
      : answers.map((a, i) => `${i + 1}. ${said(a)}`).join('\n');
  return { ...push(convo, 'user', text), question: null };
}

export function confirmAsked(convo: Convo, request: ConfirmRequest): Convo {
  return { ...convo, confirm: request };
}

/** A refusal is worth a line: the agent reports an allow itself, but may not mention a denial. */
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
 * Opens a fresh conversation on somebody else's behalf (an upload, today), putting the question it
 * arrived with in the dialogue box and the suggestions under it. This clears the feed deliberately:
 * what came before belongs to the thread that was just saved.
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
export function replayed(
  convo: Convo,
  items: readonly FeedItem[],
  banner: string,
  marks: readonly CompactionMark[] = [],
): Convo {
  const highest = items.reduce((max, item) => Math.max(max, item.id), 0);
  return {
    ...emptyConvo(banner),
    feed: [...items],
    compactions: [...marks],
    seq: Math.max(convo.seq, highest),
  };
}

/**
 * A compaction landed. Its rule joins the transcript, and the context figure is dropped: what the
 * next request will carry is not known until it has been made.
 */
export function compacted(convo: Convo, mark: CompactionMark): Convo {
  const { context: _context, ...rest } = convo;
  return { ...rest, compactions: [...convo.compactions, mark] };
}

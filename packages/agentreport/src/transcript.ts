/**
 * The evidence a difficult-agent report is written from: one saved conversation, plus the
 * commands the app executed while it was open, rendered as a single markdown document.
 *
 * Pure and node-testable. It is handed already-read data — the caller reads the thread and
 * `commands.jsonl` — so the whole join is a function of its arguments and a fixture is a literal.
 */
import type { CommandRecord } from '@vn/commands';
import type { Redactor } from './redact.js';

/**
 * A transcript line, as `readThread` gives it back.
 *
 * Declared here rather than imported: the desktop app owns thread storage
 * (`apps/desktop/src/main/threads.ts`), and a package may not import an app. The shapes are
 * structurally identical on purpose, so main passes its `ThreadRecord` straight in — and if the
 * app ever adds a role this package does not know, the call site is where that should fail.
 */
export interface FeedItem {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'blocked';
  text: string;
  /** The text at full length, present only when `text` was clamped writing it down. */
  full?: string;
  /** For a `tool` item: what it was called with and whether it worked. */
  detail?: { args?: string; ok?: boolean; output?: string };
  /** When the line was written down. Present on anything read back from disk. */
  at?: string;
}

/**
 * One call's receipt, as the thread recorded it. Structurally the desktop app's `ThreadUsage`, and
 * declared here for the same reason `FeedItem` is.
 *
 * `verdict` is what the call did to the prompt cache, and is present only where the backend's
 * figures can be compared across calls. Absent means the question was not answerable, never that
 * the cache worked.
 */
export interface ThreadUsage {
  step: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheEstimated?: boolean;
  verdict?: 'cold' | 'hit' | 'expired' | 'miss';
  at: string;
}

/** One saved conversation. Structurally the desktop app's `ThreadRecord`. */
export interface ThreadRecord {
  id: string;
  title: string;
  startedAt: string;
  commit?: string;
  model?: string;
  items: FeedItem[];
  /** Absent on a thread that recorded no receipts, which is every thread written before they were. */
  usage?: ThreadUsage[];
}

/** What the host knows about the run that the thread file does not record. */
export interface ReportContext {
  /** The app build the report is written from, so a maintainer knows which code to read. */
  appVersion?: string;
  /** The reasoning effort the conversation ran at. */
  effort?: string;
}

export interface Evidence {
  thread: ThreadRecord;
  /** Command records whose window overlaps the thread — what the agent actually did. */
  acts: CommandRecord[];
  /**
   * True when the thread predates the detailed format, so the report can say its evidence is
   * thin rather than leaving a maintainer to read a missing detail as proof nothing happened.
   */
  thin: boolean;
  context: ReportContext;
}

/**
 * Every string in the evidence that says anything about the author, replaced.
 *
 * Applied once, at the boundary, so nothing downstream has to remember: the analyst's prompt, the
 * rendered issue body and the copy saved to disk are all derived from an already-clean value
 * rather than each redacting for itself. Redaction is idempotent, so the second application in
 * `openingMessage` costs nothing and is kept as a second line of defence.
 *
 * Ids, sequence numbers, statuses and timestamps are left alone — they name nothing outside this
 * report. Everything `toMarkdown` renders is covered, and a field it starts rendering must be
 * added here at the same time.
 */
export function redactEvidence(evidence: Evidence, redactor: Redactor): Evidence {
  const scrub = (text: string): string => redactor.apply(text);
  return {
    ...evidence,
    // Field by field rather than by spreading, because a spread would carry a field added to
    // `ThreadRecord` later into the report unscrubbed. Everything named here either holds no
    // authored text or is scrubbed on the way past.
    thread: {
      id       : evidence.thread.id,
      startedAt: evidence.thread.startedAt,
      ...(evidence.thread.commit === undefined ? {} : { commit: evidence.thread.commit }),
      ...(evidence.thread.model === undefined ? {} : { model: evidence.thread.model }),
      ...(evidence.thread.usage === undefined ? {} : { usage: evidence.thread.usage }),
      title: scrub(evidence.thread.title),
      items: evidence.thread.items.map((item) => ({
        ...item,
        text: scrub(item.text),
        ...(item.full === undefined ? {} : { full: scrub(item.full) }),
        ...(item.detail === undefined
          ? {}
          : {
              detail: {
                ...item.detail,
                ...(item.detail.args === undefined ? {} : { args: scrub(item.detail.args) }),
                ...(item.detail.output === undefined ? {} : { output: scrub(item.detail.output) }),
              },
            }),
      })),
    },
    acts: evidence.acts.map((act) => ({
      ...act,
      invocation: scrub(act.invocation),
      message   : scrub(act.message),
      ...(act.error === undefined ? {} : { error: scrub(act.error) }),
      ...(act.written === undefined ? {} : { written: act.written.map(scrub) }),
    })),
  };
}

function time(iso: string | undefined): number {
  const ms = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * The window the thread was open for: its start, and the last line written in it. An unstamped
 * line contributes nothing — a thread whose lines carry no `at` gets a zero-width window and
 * therefore no acts, which is the honest answer rather than a guessed one.
 */
function windowOf(thread: ThreadRecord): { from: number; to: number } {
  const from = time(thread.startedAt);
  let to = from;
  for (const item of thread.items) {
    const at = time(item.at);
    if (!Number.isNaN(at) && !(at <= to)) to = at;
  }
  return { from, to };
}

/**
 * Whether the transcript is missing what the analyst wants.
 *
 * A tool line is decisive: the old format recorded the name alone, so tool lines with no `detail`
 * mean the thread was written before Stage 1 of the report plan. With no tool lines at all there
 * is nothing decisive to read, and a thread whose every line happened to be short is flagged
 * along with a genuinely old one — a false positive that costs one caveat sentence.
 */
function isThin(items: FeedItem[]): boolean {
  const tools = items.filter((item) => item.role === 'tool');
  if (tools.length > 0) return tools.every((item) => !item.detail);
  return items.length > 0 && items.every((item) => !item.full && !item.detail);
}

/**
 * Join the conversation to the acts it caused. Records are matched by overlapping the thread's
 * window rather than by any recorded link, because there is none: a command the agent ran and one
 * the author ran by hand are the same record, and for reading a bad conversation back that is
 * right — what happened in the project while the conversation was open is the evidence.
 */
export function assemble(
  thread: ThreadRecord,
  records: CommandRecord[],
  context: ReportContext = {},
): Evidence {
  const { from, to } = windowOf(thread);
  const acts = Number.isNaN(from)
    ? []
    : records
        .filter((record) => {
          const started = time(record.startedAt);
          const finished = time(record.finishedAt);
          const begin = Number.isNaN(started) ? finished : started;
          const end = Number.isNaN(finished) ? started : finished;
          return !Number.isNaN(begin) && begin <= to && end >= from;
        })
        .slice()
        .sort((a, b) => a.seq - b.seq);

  return { thread, acts, thin: isThin(thread.items), context };
}

/**
 * A fence long enough to hold `text` whatever it contains. Tool output is arbitrary — a report on
 * an agent that mangled a markdown file would otherwise end its own code block mid-way.
 */
function fence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function block(text: string): string {
  const bars = fence(text);
  return `${bars}\n${text.replace(/\n+$/, '')}\n${bars}`;
}

const ROLES: Record<FeedItem['role'], string> = {
  user   : 'author',
  agent  : 'agent',
  tool   : 'tool',
  blocked: 'blocked',
};

function renderItem(item: FeedItem): string {
  const parts = [`### ${item.id} · ${ROLES[item.role]}`, block(item.full ?? item.text)];
  const detail = item.detail;
  if (detail) {
    if (detail.args) parts.push(`Called with:\n\n${block(detail.args)}`);
    if (detail.ok !== undefined) parts.push(detail.ok ? 'It succeeded.' : '**It failed.**');
    if (detail.output) parts.push(`It returned:\n\n${block(detail.output)}`);
  }
  return parts.join('\n\n');
}

function renderAct(record: CommandRecord): string {
  const head = `- \`#${record.seq}\` ${record.invocation} — **${record.status}**`;
  const lines = [record.status === 'error' ? (record.error ?? record.message) : record.message]
    .filter((line) => line && line.trim() !== '')
    .map((line) => `  - ${line.replace(/\s+/g, ' ').trim()}`);
  if (record.written?.length) lines.push(`  - wrote: ${record.written.join(', ')}`);
  return [head, ...lines].join('\n');
}

const THIN_NOTE =
  '> This conversation was recorded before transcripts kept what tools were called with. ' +
  'Tool lines carry a name and nothing else, and long lines were cut with no copy kept — ' +
  'so the evidence below is thinner than a recent one, and silence in it is not innocence.';

/**
 * What the prompt cache did over the conversation, or nothing at all.
 *
 * A thread whose backend does not report comparable figures carries no verdicts, and the section is
 * left out entirely rather than rendered empty — an empty heading reads as a cache that never
 * missed. A miss is named by step and by what it cost to re-send, because that is the number that
 * says whether it mattered.
 */
function renderCache(usage: ThreadUsage[]): string[] {
  const judged = usage.filter((call) => call.verdict !== undefined);
  if (judged.length === 0) return [];

  const counts = new Map<string, number>();
  for (const call of judged) {
    const verdict = call.verdict as string;
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  const tally = [...counts]
    .map(([verdict, n]) => `- ${verdict}: ${n}`)
    .sort()
    .join('\n');

  const missed = judged
    .filter((call) => call.verdict === 'miss')
    .map((call) => `- call ${call.step} re-sent ${call.cacheWrite ?? call.input} tokens`);

  const out = ['## What the prompt cache did', tally];
  if (missed.length > 0) {
    out.push(
      'The prefix broke on these calls while it was still readable, so everything before the ' +
        'break was billed again:',
      missed.join('\n'),
    );
  }
  return out;
}

/**
 * The evidence as one document. This is the only thing the analyst is shown, and it goes through
 * the redactor before it goes anywhere — so nothing here may be a shape the redactor cannot see
 * into, which is why args and output are rendered as text rather than re-encoded.
 */
export function toMarkdown(evidence: Evidence): string {
  const { thread, acts, thin, context } = evidence;
  const facts = [
    ['Model', thread.model],
    ['Effort', context.effort],
    ['Commit', thread.commit],
    ['App version', context.appVersion],
    ['Started', thread.startedAt],
  ].filter((pair): pair is [string, string] => Boolean(pair[1]));

  const out = [
    `# Conversation: ${thread.title}`,
    facts.map(([label, value]) => `- ${label}: ${value}`).join('\n'),
  ];
  if (thin) out.push(THIN_NOTE);

  out.push('## The conversation');
  out.push(
    thread.items.length === 0
      ? 'Nothing was said in it.'
      : thread.items.map(renderItem).join('\n\n'),
  );

  out.push(...renderCache(thread.usage ?? []));

  out.push('## What the app did while it was open');
  out.push(
    acts.length === 0
      ? 'No commands were executed in this window.'
      : acts.map(renderAct).join('\n'),
  );

  return `${out.join('\n\n')}\n`;
}

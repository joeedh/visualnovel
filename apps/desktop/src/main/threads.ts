/**
 * Conversation threads on disk: one append-only JSONL log per thread under
 * `vngen/state/threads/<id>.jsonl`.
 *
 * `vngen/state/` is where this project already keeps its append-only logs (`tasks.jsonl`,
 * `commands.jsonl`), `vngen/` is committed in a user's project so a transcript travels with the
 * work it produced, and undo's snapshots exclude `vngen/state` — so undoing the edit a
 * conversation made never deletes the conversation that explains it.
 *
 * It lives in the desktop app rather than `@vn/store` because a transcript is not one of a
 * project's authored files. Nothing in the format assumes the desktop, so when `vnauthor`'s REPL
 * wants threads too this module moves down to `@vn/authoring` and both hosts read the same files.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonl, ensureDir } from '@vn/util';
import type { ProjectPaths } from '@vn/store';
import type { AgentMessage, SystemSection } from '@vn/authoring';
import type {
  CompactionMark,
  FeedItem,
  ResumeHeader,
  ThreadArchive,
  ThreadHeader,
  ThreadRecord,
  ThreadUsage,
  ToolDetail,
} from '../shared/convo.js';

export type { CompactionMark, ResumeHeader, ThreadArchive, ThreadHeader, ThreadRecord };
// Re-exported so a reader of the native log finds the version beside the writer of it. The
// declaration is in `shared/` because the resume check compares against it from both processes.
export { NATIVE_VERSION } from '../shared/threads.js';

/** The title a thread is created with, before a first turn names it. */
export const NEW_THREAD_TITLE = 'New conversation';

/** Longest title kept. The full text is in the transcript either way. */
const TITLE_MAX = 60;

/**
 * Longest transcript line kept. A tool line is already a digest, but without this cap a tool that
 * reports a whole file would put it in the log twice: once as the tool's own line and once as
 * whatever it wrote.
 */
const TEXT_MAX = 400;

/**
 * Longest evidence kept. `full` and a tool's args and output are written for an analyst rather
 * than a reader, so they are allowed to be longer than a transcript line. These caps are what keep
 * a thread a log rather than an archive.
 */
const FULL_MAX = 8000;
const ARGS_MAX = 600;
const OUTPUT_MAX = 2000;

type ThreadLine =
  | ({ v: 1; type: 'thread' } & ThreadHeader)
  | ({ type: 'item'; at: string } & FeedItem)
  | { type: 'title'; title: string; at: string }
  | { type: 'binding'; model?: string; effort?: string; at: string }
  | ({ type: 'compaction'; at: string } & CompactionMark)
  | ({ type: 'archived' } & ThreadArchive)
  | ({ type: 'usage' } & ThreadUsage);

export function threadsDir(paths: ProjectPaths): string {
  return join(paths.state, 'threads');
}

export function threadFile(paths: ProjectPaths, id: string): string {
  return join(threadsDir(paths), `${id}.jsonl`);
}

/**
 * What marks the second file a thread has, holding the backend's own messages verbatim. The native
 * log is described where its readers and writers are, at the foot of this file.
 */
const NATIVE_SUFFIX = '.native.jsonl';

/** A thread's title, from the first thing the author said: one line, trimmed at a word boundary. */
export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX) return flat || NEW_THREAD_TITLE;
  const cut = flat.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function clamp(text: string, max = TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/**
 * A tool's evidence, sized for the log. Absent fields stay absent rather than becoming empty
 * strings: an item written before this format existed and one whose tool took no arguments should
 * read the same way, because they mean the same thing.
 */
function clampDetail(detail: ToolDetail): ToolDetail {
  return {
    ...(detail.args === undefined ? {} : { args: clamp(detail.args, ARGS_MAX) }),
    ...(detail.ok === undefined ? {} : { ok: detail.ok }),
    ...(detail.output === undefined ? {} : { output: clamp(detail.output, OUTPUT_MAX) }),
  };
}

function stamp(at: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

/**
 * Every line a file holds that parses. A crash mid-append leaves a half-written last line, and a
 * bad line is skipped rather than thrown over so the rest of the transcript still lists.
 *
 * `refuseConflicts` turns that tolerance off for one case: a conflict marker means a three-way
 * merge wrote two versions into the file, and skipping the unparseable lines would hand back a
 * quietly truncated log. The check runs before `keep`, so a filtered read still catches it.
 */
async function lines<T = ThreadLine>(
  file: string,
  opts: { keep?: (raw: string) => boolean; refuseConflicts?: boolean } = {},
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: T[] = [];
  for (const raw of text.split('\n')) {
    if (opts.refuseConflicts && raw.startsWith('<<<<<<<')) throw new ConflictedLogError(file);
    if (raw.trim() === '' || (opts.keep && !opts.keep(raw))) continue;
    try {
      out.push(JSON.parse(raw) as T);
    } catch {
      // A line that will not parse is a line that was never finished being written.
    }
  }
  return out;
}

function headerOf(id: string, parsed: ThreadLine[]): ThreadHeader | undefined {
  const first = parsed.find((line) => line.type === 'thread');
  if (!first) return undefined;

  const { title, startedAt, model, effort } = first;
  const renamed = parsed.filter((line) => line.type === 'title');
  const last = renamed[renamed.length - 1];
  // A conversation is had at whatever it was last switched to, so the newest binding wins over
  // the one line 0 opened with — and a rebind that named only the effort leaves the model alone.
  const bound = { model, effort };
  for (const line of parsed) {
    if (line.type !== 'binding') continue;
    if (line.model !== undefined) bound.model = line.model;
    if (line.effort !== undefined) bound.effort = line.effort;
  }
  // Keeps every archive record rather than only the last, because a thread closed, reopened by a
  // later feature and closed again has two commits worth reading and either may hold the line a
  // diagnostic wants
  const archived = parsed
    .filter((line) => line.type === 'archived')
    .map(({ commit: sha, at }) => ({ commit: sha, at }));
  return {
    id,
    title: last ? last.title : title,
    startedAt,
    ...(bound.model === undefined ? {} : { model: bound.model }),
    ...(bound.effort === undefined ? {} : { effort: bound.effort }),
    ...(archived.length === 0 ? {} : { archived }),
  };
}

/**
 * Every saved thread, newest first. Only the header and any retitles are parsed — ids are
 * timestamps, so the directory listing already sorts and there is no index file to keep true, and
 * nothing here is expensive enough to cache and then have to invalidate.
 */
export async function listThreads(paths: ProjectPaths): Promise<ThreadHeader[]> {
  let files: string[];
  try {
    files = await readdir(threadsDir(paths));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  // A native log is the same conversation and would otherwise list a second time — and listing it
  // means running the pre-filter over every verbatim line the model was ever sent. Thread ids are
  // timestamps, so none ends in `.native` and is excluded by accident.
  const ids = files
    .filter((f) => f.endsWith('.jsonl') && !f.endsWith(NATIVE_SUFFIX))
    .map((f) => f.slice(0, -'.jsonl'.length));
  const headers: ThreadHeader[] = [];
  for (const id of ids.sort().reverse()) {
    // Tool args are in the file too, so this filter lets the odd item line through to be parsed
    // and then dropped by `headerOf`. That is a wasted parse, not a wrong answer.
    const keep = (raw: string) =>
      raw.includes('"thread"') ||
      raw.includes('"title"') ||
      raw.includes('"binding"') ||
      raw.includes('"archived"');
    const header = headerOf(id, await lines(threadFile(paths, id), { keep }));
    if (header) headers.push(header);
  }
  return headers;
}

/** One thread in full. A file with no header line is not a thread; the throw names the id. */
export async function readThread(paths: ProjectPaths, id: string): Promise<ThreadRecord> {
  const parsed = await lines(threadFile(paths, id));
  const header = headerOf(id, parsed);
  if (!header) throw new Error(`no such conversation: ${id}`);

  // Field by field rather than by spreading the line, so `type` stays in the file where it
  // belongs. `full`, `detail` and `at` come back for whoever asked for the whole record, and the
  // screen reads only `text`.
  const items = parsed
    .filter((line) => line.type === 'item')
    .map(({ id: itemId, role, text, full, detail, at }) => ({
      id: itemId,
      role,
      text,
      ...(full === undefined ? {} : { full }),
      ...(detail === undefined ? {} : { detail }),
      ...(at === undefined ? {} : { at }),
    }));
  // A thread whose backend reported nothing gets no `usage` field, which is also every thread
  // written before receipts were recorded
  const usage = parsed
    .filter((line) => line.type === 'usage')
    .map(({ step, input, output, cacheRead, cacheWrite, cacheEstimated, verdict, at }) => ({
      step,
      input,
      output,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(cacheEstimated === undefined ? {} : { cacheEstimated }),
      ...(verdict === undefined ? {} : { verdict }),
      at,
    }));
  const compactions = parsed
    .filter((line) => line.type === 'compaction')
    .map(({ afterId, covers, text, full, at, model }) => ({
      afterId,
      covers,
      text,
      ...(full === undefined ? {} : { full }),
      ...(at === undefined ? {} : { at }),
      ...(model === undefined ? {} : { model }),
    }));
  return { ...header, items, compactions, ...(usage.length === 0 ? {} : { usage }) };
}

/**
 * Start a thread: allocate an id and write line 0. Called by the first turn and never by opening
 * the app — launching the desktop and saying nothing must leave no trace, or every launch litters
 * the project with an empty conversation.
 */
export async function openThread(
  paths: ProjectPaths,
  info: { title?: string; model?: string; effort?: string } = {},
  now = new Date(),
): Promise<ThreadHeader> {
  await ensureDir(threadsDir(paths));
  const taken = new Set(await readdir(threadsDir(paths)));

  const base = stamp(now);
  let id = base;
  for (let n = 2; taken.has(`${id}.jsonl`); n++) id = `${base}-${n}`;

  const header: ThreadHeader = {
    id,
    title    : info.title ?? NEW_THREAD_TITLE,
    startedAt: now.toISOString(),
    ...(info.model === undefined ? {} : { model: info.model }),
    ...(info.effort === undefined ? {} : { effort: info.effort }),
  };
  await appendJsonl(threadFile(paths, id), { v: 1, type: 'thread', ...header });
  return header;
}

/**
 * One transcript line, clamped for reading and kept for evidence: `text` is what a person sees,
 * `full` is what was cut and only when something was, `detail` is what the tool was actually
 * handed. Writing `full` unconditionally would double the log to say nothing.
 */
export async function appendItem(
  paths: ProjectPaths,
  id: string,
  item: FeedItem,
  now = new Date(),
): Promise<void> {
  const text = clamp(item.text);
  const full = item.full ?? item.text;
  await appendJsonl(threadFile(paths, id), {
    type: 'item',
    ...item,
    text,
    ...(full.length > text.length ? { full: clamp(full, FULL_MAX) } : {}),
    ...(item.detail ? { detail: clampDetail(item.detail) } : {}),
    at: now.toISOString(),
  });
}

/**
 * One call's receipt. Written as its own record rather than folded into a transcript line, because
 * a receipt is not something anyone said and a turn can spend several calls. Absent figures stay
 * absent: a vendor that reported nothing must not read back as a zero.
 */
export async function appendUsage(
  paths: ProjectPaths,
  id: string,
  usage: ThreadUsage,
): Promise<void> {
  await appendJsonl(threadFile(paths, id), { type: 'usage', ...usage });
}

/**
 * The rule a compaction leaves in the display log. Nothing above it is touched: the transcript a
 * reader scrolls is the same after compacting as before, and this line only says where the agent's
 * own memory of it was replaced by a summary. Clamped exactly as a transcript line is.
 */
export async function appendCompaction(
  paths: ProjectPaths,
  id: string,
  mark: CompactionMark,
  now = new Date(),
): Promise<void> {
  const text = clamp(mark.text);
  const full = mark.full ?? mark.text;
  await appendJsonl(threadFile(paths, id), {
    type: 'compaction',
    ...mark,
    text,
    ...(full.length > text.length ? { full: clamp(full, FULL_MAX) } : {}),
    at: mark.at ?? now.toISOString(),
  });
}

/**
 * Record that the conversation changed model or reasoning level, mid-thread. Appended for the
 * same reason a retitle is: line 0 says what the conversation opened at, and a thread reopened a
 * week later should come back on the model it was actually had on rather than the one it started
 * on. Naming one field leaves the other where it was.
 */
export async function bindThread(
  paths: ProjectPaths,
  id: string,
  binding: { model?: string; effort?: string },
  now = new Date(),
): Promise<void> {
  if (binding.model === undefined && binding.effort === undefined) return;
  await appendJsonl(threadFile(paths, id), {
    type: 'binding',
    ...(binding.model === undefined ? {} : { model: binding.model }),
    ...(binding.effort === undefined ? {} : { effort: binding.effort }),
    at: now.toISOString(),
  });
}

/**
 * Write down which commit holds this thread. Appended after the commit has been made, which is
 * the only order available (a commit cannot name itself) so the pointer line is deliberately
 * outside the commit it points at. That costs one dirty line until the next sweep, and it means a
 * reader never has to search history to find out whether a transcript was saved.
 */
export async function archiveThread(
  paths: ProjectPaths,
  id: string,
  commit: string,
  now = new Date(),
): Promise<void> {
  await appendJsonl(threadFile(paths, id), {
    type: 'archived',
    commit,
    at: now.toISOString(),
  });
}

/**
 * Rename a thread by appending, never by rewriting line 0; the reader takes the last `title`
 * record. Rewriting line 0 would stop this being an append-only log.
 */
export async function retitleThread(
  paths: ProjectPaths,
  id: string,
  title: string,
  now = new Date(),
): Promise<void> {
  await appendJsonl(threadFile(paths, id), { type: 'title', title, at: now.toISOString() });
}

// ---- The native log ----

// The backend's own messages, verbatim. None of the clamps above apply: a transcript a model can
// continue from has to be exactly what the model was sent. The separate file is also what keeps a
// reader of the display log walking kilobytes of feed rather than megabytes of tool output.

/** Refuses a native log that a three-way merge wrote two versions into. */
export class ConflictedLogError extends Error {
  constructor(readonly file: string) {
    super(`${file} holds a merge conflict, so the conversation in it is no longer intact`);
  }
}

/**
 * One message as the log stores it. `n` counts messages ever appended to this thread and never
 * restarts, so it still names a message after a compaction rebuilds the live array from zero.
 */
export interface StoredMessage extends AgentMessage {
  n: number;
}

/** A compaction: the summary that stands in for `covers`, and what producing it cost. */
export interface ThreadCompaction {
  /** The `n` range the summary replaces, inclusive. */
  covers: { from: number; to: number };
  role: AgentMessage['role'];
  content: string;
  at: string;
  model?: string;
  usage?: { input: number; output: number };
}

/** A thread's native log, folded into the four things a reader asks it for. */
export interface NativeLog {
  header: ResumeHeader;
  messages: StoredMessage[];
  /** The header's sections with every later delta folded on, in order. */
  sections: SystemSection[];
  /** The newest compaction, when the author has compacted. */
  compaction?: ThreadCompaction;
}

export type NativeLine =
  | ({ type: 'resume' } & ResumeHeader)
  | ({ type: 'msg'; at: string } & StoredMessage)
  | { type: 'sections'; n: number; at: string; set: SystemSection[]; unset: string[] }
  | ({ type: 'compact' } & ThreadCompaction);

export function nativeFile(paths: ProjectPaths, id: string): string {
  return join(threadsDir(paths), `${id}${NATIVE_SUFFIX}`);
}

/** Append one line. Callers are the session's `onMessage` hook and its compaction. */
export async function appendNative(
  paths: ProjectPaths,
  id: string,
  line: NativeLine,
): Promise<void> {
  await appendJsonl(nativeFile(paths, id), line);
}

/** Line 0's fields, without the `type` that belongs only in the file. */
function resumeHeaderOf(line: { type: 'resume' } & ResumeHeader): ResumeHeader {
  const { v, thread, at, backend, vendor, model, effort, sections } = line;
  return {
    v,
    thread,
    at,
    backend,
    vendor,
    sections: sections ?? [],
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/**
 * Line 0 alone, for a caller deciding whether a thread can be continued. A `msg` line holding the
 * words `"type":"resume"` would have to have been written with those quotes unescaped, which JSON
 * does not do, so the pre-filter reaches line 0 and nothing else.
 */
export async function nativeHeader(
  paths: ProjectPaths,
  id: string,
): Promise<ResumeHeader | undefined> {
  const parsed = await lines<NativeLine>(nativeFile(paths, id), {
    keep           : (raw) => raw.includes('"type":"resume"'),
    refuseConflicts: true,
  });
  const first = parsed.find((line) => line.type === 'resume');
  return first ? resumeHeaderOf(first) : undefined;
}

/**
 * The whole log. Answers `undefined` for a thread that has no native file and for one carrying no
 * header — every thread written before the format existed is one of those, and a resume refuses
 * them by name rather than treating an absent file as an error.
 */
export async function readNative(paths: ProjectPaths, id: string): Promise<NativeLog | undefined> {
  const parsed = await lines<NativeLine>(nativeFile(paths, id), { refuseConflicts: true });
  const first = parsed.find((line) => line.type === 'resume');
  if (!first) return undefined;
  const header = resumeHeaderOf(first);

  // A delta replaces a section of the same name where it stands, because `joinSections`
  // concatenates in order and the author's context has to keep reading last.
  const sections = [...header.sections];
  const compactions: ThreadCompaction[] = [];
  const messages: StoredMessage[] = [];
  for (const line of parsed) {
    if (line.type === 'msg') {
      const { n, role, content, toolUseId } = line;
      messages.push({ n, role, content, ...(toolUseId === undefined ? {} : { toolUseId }) });
    } else if (line.type === 'sections') {
      for (const name of line.unset ?? []) {
        const at = sections.findIndex((section) => section.name === name);
        if (at >= 0) sections.splice(at, 1);
      }
      for (const section of line.set ?? []) {
        const at = sections.findIndex((held) => held.name === section.name);
        if (at >= 0) sections[at] = section;
        else sections.push(section);
      }
    } else if (line.type === 'compact') {
      const { covers, role, content, at, model, usage } = line;
      compactions.push({
        covers,
        role,
        content,
        at,
        ...(model === undefined ? {} : { model }),
        ...(usage === undefined ? {} : { usage }),
      });
    }
  }

  const newest = compactions[compactions.length - 1];
  return {
    header,
    messages,
    sections,
    ...(newest === undefined ? {} : { compaction: newest }),
  };
}

/**
 * The conversation a resume hands the agent: the newest summary, then every message it does not
 * cover. A log that has never been compacted answers with all of its messages. A second compaction
 * covers everything the first did, so only the newest is read.
 */
export function liveMessages(log: NativeLog): AgentMessage[] {
  const { compaction } = log;
  const kept = compaction ? log.messages.filter((m) => m.n > compaction.covers.to) : log.messages;
  const messages = kept.map(({ n: _n, ...message }) => message);
  if (!compaction) return messages;
  return [{ role: compaction.role, content: compaction.content }, ...messages];
}

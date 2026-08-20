/**
 * Conversation threads on disk: one append-only JSONL log per thread under
 * `vngen/state/threads/<id>.jsonl`.
 *
 * `vngen/state/` is where this project already keeps its append-only logs (`tasks.jsonl`,
 * `commands.jsonl`), `vngen/` is committed in a user's project so a transcript travels with the
 * work it produced, and undo's shadow snapshots exclude `vngen/state` — so undoing the edit a
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
import type {
  FeedItem,
  ThreadArchive,
  ThreadHeader,
  ThreadRecord,
  ToolDetail,
} from '../shared/convo.js';

export type { ThreadArchive, ThreadHeader, ThreadRecord };

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
  | ({ type: 'archived' } & ThreadArchive);

export function threadsDir(paths: ProjectPaths): string {
  return join(paths.state, 'threads');
}

export function threadFile(paths: ProjectPaths, id: string): string {
  return join(threadsDir(paths), `${id}.jsonl`);
}

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
 */
async function lines(file: string, keep?: (raw: string) => boolean): Promise<ThreadLine[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: ThreadLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || (keep && !keep(raw))) continue;
    try {
      out.push(JSON.parse(raw) as ThreadLine);
    } catch {
      // A line that will not parse is a line that was never finished being written.
    }
  }
  return out;
}

function headerOf(id: string, parsed: ThreadLine[]): ThreadHeader | undefined {
  const first = parsed.find((line) => line.type === 'thread');
  if (!first) return undefined;

  const { title, startedAt, commit, model, effort } = first;
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
    ...(commit === undefined ? {} : { commit }),
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

  const ids = files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
  const headers: ThreadHeader[] = [];
  for (const id of ids.sort().reverse()) {
    // Tool args are in the file too, so this filter lets the odd item line through to be parsed
    // and then dropped by `headerOf`. That is a wasted parse, not a wrong answer.
    const keep = (raw: string) =>
      raw.includes('"thread"') ||
      raw.includes('"title"') ||
      raw.includes('"binding"') ||
      raw.includes('"archived"');
    const header = headerOf(id, await lines(threadFile(paths, id), keep));
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
  return { ...header, items };
}

/**
 * Start a thread: allocate an id and write line 0. Called by the first turn and never by opening
 * the app — launching the desktop and saying nothing must leave no trace, or every launch litters
 * the project with an empty conversation.
 */
export async function openThread(
  paths: ProjectPaths,
  info: { title?: string; commit?: string; model?: string; effort?: string } = {},
  now = new Date(),
): Promise<ThreadHeader> {
  await ensureDir(threadsDir(paths));
  const taken = new Set(await readdir(threadsDir(paths)));

  const base = stamp(now);
  let id = base;
  for (let n = 2; taken.has(`${id}.jsonl`); n++) id = `${base}-${n}`;

  const header: ThreadHeader = {
    id,
    title: info.title ?? NEW_THREAD_TITLE,
    startedAt: now.toISOString(),
    ...(info.commit === undefined ? {} : { commit: info.commit }),
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

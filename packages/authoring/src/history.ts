/**
 * Tools for reading a conversation's own history, including the part a compaction summarized away.
 *
 * The reader is an interface rather than a filesystem call because the log a host keeps is the
 * host's business: `@vn/authoring` knows only that a conversation has numbered messages. The
 * desktop app implements it over its native log and splices these two tools into the registry;
 * `vnauthor` keeps no transcript, so it registers neither.
 */
import { z } from 'zod';
import { messageText } from './backend.js';
import type { Tool, ToolResult } from './tools.js';

/** One message as the log kept it, before any compaction replaced it. */
export interface HistoryMessage {
  /** The number the log gave it, which never restarts and is what `read_history` takes. */
  n: number;
  role: string;
  /** Blocks are flattened to their text here, so a host hands back what it stored. */
  content: string | unknown[];
}

/** Where the history comes from. Implemented by the host that keeps the log. */
export interface HistoryReader {
  /** Every message of the open conversation, oldest first. Empty when none has been kept. */
  messages(): Promise<HistoryMessage[]>;
}

/** Hits one search may report. */
export const HISTORY_HITS = 20;

/** Characters one search answer may run to, across every hit. */
export const HISTORY_CHARS = 4_000;

/** Characters either side of a match, so a hit reads as a phrase rather than a word. */
export const HISTORY_WINDOW = 80;

/** Characters of one message `read_history` hands back. */
export const HISTORY_MESSAGE = 4_000;

const ok = (output: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: true,
  output,
  ...extra,
});
const fail = (output: string): ToolResult => ({ ok: false, output });

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A match in its surroundings, on one line, marked where it was cut. */
function around(content: string, at: number, length: number): string {
  const from = Math.max(0, at - HISTORY_WINDOW);
  const to = Math.min(content.length, at + length + HISTORY_WINDOW);
  const text = content.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${text}${to < content.length ? '…' : ''}`;
}

function searchHistory(reader: HistoryReader): Tool<{
  query: string;
  regex?: boolean;
  limit?: number;
}> {
  return {
    name       : 'search_history',
    description:
      'Search this conversation for a string or regex, including the turns a compaction ' +
      'summarized away. Returns one line per hit: the message number, who said it, and the text ' +
      'around the match. Read a whole message with read_history. Other conversations are not ' +
      'searched.',
    mutating   : false,
    args: z.object({
      query: z.string().min(1),
      regex: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    }),
    async run(a) {
      let re: RegExp;
      try {
        re = new RegExp(a.regex ? a.query : escapeRegExp(a.query), 'gi');
      } catch (err) {
        return fail(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }

      const messages = await reader.messages();
      const cap = Math.min(a.limit ?? HISTORY_HITS, HISTORY_HITS);
      const lines: string[] = [];
      let chars = 0;
      let stopped = false;
      for (const message of messages) {
        if (stopped) break;
        const content = messageText(message.content);
        re.lastIndex = 0;
        for (let m = re.exec(content); m; m = re.exec(content)) {
          // A pattern that can match nothing would otherwise sit on one index forever
          if (m[0].length === 0) re.lastIndex += 1;
          const line =
            `#${message.n} ${message.role} (${content.length} chars): ` +
            around(content, m.index, m[0].length);
          if (lines.length >= cap || (lines.length > 0 && chars + line.length > HISTORY_CHARS)) {
            stopped = true;
            break;
          }
          lines.push(line);
          chars += line.length;
        }
      }

      if (lines.length === 0) {
        // The scope is named because the agent reading an empty answer would otherwise conclude the
        // phrase was never said at all, rather than never said here.
        return ok(
          `No matches for "${a.query}" in this conversation's ${messages.length} message(s), ` +
            'compacted turns included. No other conversation is searched.',
          { data: [] },
        );
      }
      const more = stopped ? '\n(more matches were not shown — narrow the query)' : '';
      return ok(lines.join('\n') + more, { data: lines });
    },
  };
}

function readHistory(reader: HistoryReader): Tool<{ n: number }> {
  return {
    name       : 'read_history',
    description:
      'Read one message of this conversation in full, by the number search_history reported. ' +
      'Works on a turn a compaction replaced with a summary.',
    mutating   : false,
    args       : z.object({ n: z.number().int().describe('the number from search_history') }),
    async run(a) {
      const messages = await reader.messages();
      const found = messages.find((message) => message.n === a.n);
      if (!found) {
        const range = messages.length
          ? `The numbers run ${messages[0]!.n} to ${messages[messages.length - 1]!.n}.`
          : 'This conversation has no kept history to read.';
        return fail(`There is no message #${a.n} in this conversation. ${range}`);
      }
      const content = messageText(found.content);
      const clipped = content.length > HISTORY_MESSAGE;
      const body = clipped ? content.slice(0, HISTORY_MESSAGE) : content;
      const head = clipped
        ? `#${found.n} ${found.role} (${content.length} chars, first ${HISTORY_MESSAGE} shown)`
        : `#${found.n} ${found.role}`;
      return ok(`${head}\n${body}`);
    },
  };
}

/** Both tools, ready to hand to `createRegistry`. */
export function historyTools(reader: HistoryReader): Tool[] {
  return [searchHistory(reader) as Tool, readHistory(reader) as Tool];
}

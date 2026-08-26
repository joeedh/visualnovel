/**
 * The two tools the analyst gets when the author lets it read the requests the app actually sent.
 *
 * These exist for one class of failure: a provider that rejects a body by position —
 * `messages.1.content.0: unexpected "tool_use_id"` — where the position means nothing without the
 * body, and nothing else keeps the body. `@vn/providers`' capture ring keeps it; this reads it.
 *
 * They deliberately cannot hand back a long verbatim span. The capture holds the author's whole
 * conversation as it went over the wire — their fiction, their file contents — which is not in the
 * report and must not get into it. The default answer is a structural outline rather than content;
 * a path returns one node's string values, decoded, redacted and capped per read; and base64
 * blocks are refused by kind rather than merely being expensive. The prompt asks for the same
 * restraint, but that is a second layer on top of this mechanism.
 *
 * The snapshot is frozen (`captureSnapshot()`) before the analysis starts, because the analyst
 * takes many turns to read one of these and a live ring would evict entries — possibly the one it
 * was opened to read — between the listing and the read.
 */
import { z } from 'zod';
import type { CaptureSnapshot } from '@vn/providers';
import type { Tool, ToolResult } from '@vn/authoring';
import type { Redactor } from './redact.js';
import { Budget } from './sourcetools.js';

const ok = (output: string): ToolResult => ({ ok: true, output });
const fail = (output: string): ToolResult => ({ ok: false, output });

/**
 * Characters of decoded content one `read_request` may hand back.
 *
 * Small on purpose: enough to see which tool call carried the wrong id, and not enough to
 * reconstruct a scene.
 */
export const MAX_VALUE = 2_000;

/** Blocks that hold encoded bytes rather than text. Refused by kind, whatever the budget says. */
const OPAQUE = new Set(['image', 'document']);

export interface RequestToolOptions {
  /** The frozen ring. */
  snapshot: CaptureSnapshot;
  /** Everything handed back goes through this redactor, like everything else the analyst sees. */
  redactor: Redactor;
  /** Shared with the source tools when both are on, so one analysis has one budget. */
  budget?: Budget;
  /** Characters per read. Defaults to {@link MAX_VALUE}. */
  maxValue?: number;
}

/** A size a reader can compare at a glance. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The first line of a failure, which is the part that names a position. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

/**
 * Describes a content block in one line: its kind, its name, and its size, never what it says.
 * Used to answer a positional error without returning any content.
 */
function describeBlock(block: unknown): string {
  if (typeof block === 'string') return `text, ${block.length} chars`;
  if (typeof block !== 'object' || block === null) return typeof block;
  const b = block as Record<string, unknown>;
  const kind = typeof b.type === 'string' ? b.type : 'untyped';
  const bits: string[] = [kind];
  if (typeof b.name === 'string') bits.push(`name=${b.name}`);
  if (typeof b.id === 'string') bits.push(`id=${b.id}`);
  if (typeof b.tool_use_id === 'string') bits.push(`tool_use_id=${b.tool_use_id}`);
  if (typeof b.text === 'string') bits.push(`${b.text.length} chars`);
  if (typeof b.thinking === 'string') bits.push(`${b.thinking.length} chars`);
  if (b.input !== undefined) bits.push(`input: ${Object.keys(b.input as object).join(', ')}`);
  if (b.cache_control !== undefined) bits.push('cache_control');
  const source = b.source as Record<string, unknown> | undefined;
  if (source && typeof source.data === 'string') {
    bits.push(`${size(source.data.length)} of base64 — not readable`);
  }
  return bits.join(', ');
}

/** What one message is, in one line plus one per block. */
function describeMessage(path: string, message: unknown): string[] {
  if (typeof message !== 'object' || message === null) return [`${path}  ${typeof message}`];
  const m = message as Record<string, unknown>;
  const role = typeof m.role === 'string' ? m.role : '?';
  const content = m.content;
  if (typeof content === 'string') {
    return [`${path}  role=${role}, text, ${content.length} chars`];
  }
  if (!Array.isArray(content)) return [`${path}  role=${role}, content is ${typeof content}`];
  const lines = [`${path}  role=${role}, ${content.length} block(s)`];
  content.forEach((block, i) => lines.push(`  ${path}/content/${i}  ${describeBlock(block)}`));
  return lines;
}

/**
 * The shape of a request, top to bottom.
 *
 * Every line is addressed by the JSON Pointer that would reach it, so a following call can name a
 * node straight from the outline, and `messages.1.content.0` in a provider's error reads straight
 * off it.
 */
function outline(body: unknown): string {
  if (typeof body !== 'object' || body === null) return `The body is ${typeof body}.`;
  const b = body as Record<string, unknown>;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(b)) {
    if (key === 'messages' && Array.isArray(value)) {
      lines.push(`/messages  ${value.length} message(s)`);
      value.forEach((m, i) => lines.push(...describeMessage(`/messages/${i}`, m)));
    } else if (key === 'system' && Array.isArray(value)) {
      lines.push(`/system  ${value.length} block(s)`);
      value.forEach((block, i) => lines.push(`  /system/${i}  ${describeBlock(block)}`));
    } else if (key === 'tools' && Array.isArray(value)) {
      const named = value
        .map((t) => (t as { name?: unknown }).name)
        .filter((n): n is string => typeof n === 'string');
      lines.push(`/tools  ${value.length}: ${named.join(', ')}`);
    } else if (Array.isArray(value)) {
      lines.push(`/${key}  ${value.length} item(s)`);
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`/${key}  {${Object.keys(value).join(', ')}}`);
    } else if (typeof value === 'string') {
      lines.push(`/${key}  string, ${value.length} chars`);
    } else {
      lines.push(`/${key}  ${JSON.stringify(value)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Walk a JSON Pointer (RFC 6901), or say where it stopped.
 *
 * A pointer that misses returns a refusal naming the segment that failed rather than an empty
 * answer. The analyst is reading positions out of an error message, and "there is no such node" is
 * a fact about the request worth as much as the node would have been.
 */
function walk(body: unknown, pointer: string): { node?: unknown; why?: string } {
  if (pointer === '' || pointer === '/') return { node: body };
  if (!pointer.startsWith('/')) {
    return { why: `"${pointer}" is not a JSON Pointer — it must start with "/".` };
  }
  let node: unknown = body;
  const walked: string[] = [];
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        return { why: `/${walked.join('/')} has ${node.length} item(s), so there is no "${key}".` };
      }
      node = node[index];
    } else if (typeof node === 'object' && node !== null && key in node) {
      node = (node as Record<string, unknown>)[key];
    } else {
      const where = walked.length ? `/${walked.join('/')}` : 'the body';
      return { why: `${where} has no "${key}".` };
    }
    walked.push(key);
  }
  return { node };
}

/** Whether this node is bytes rather than text, whatever its size turns out to be. */
function opaque(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;
  if (typeof n.type === 'string' && OPAQUE.has(n.type)) return true;
  const source = n.source as Record<string, unknown> | undefined;
  return Boolean(source && source.type === 'base64');
}

/** Every string under a node, addressed by pointer, in the order they appear. */
function strings(node: unknown, at: string, into: { path: string; value: string }[]): void {
  if (typeof node === 'string') {
    into.push({ path: at, value: node });
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => strings(item, `${at}/${i}`, into));
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      // A base64 payload is not text, and the outline has already said how big it is
      if (opaque(node) && key === 'source') continue;
      strings(value, `${at}/${key}`, into);
    }
  }
}

function listTool(opts: RequestToolOptions): Tool<Record<string, never>> {
  return {
    name: 'list_requests',
    description:
      'List the requests this app sent to the model API in this session, newest last. Headers ' +
      'only — number, when, size, and the failure if there was one. Start here.',
    mutating: false,
    args: z.object({}),
    async run() {
      const headers = opts.snapshot.headers();
      if (headers.length === 0) {
        return ok('No requests were captured — the failure happened before anything was sent.');
      }
      const lines = headers.map((h) => {
        const bits = [`#${h.seq}`, h.label, h.at, size(h.bytes)];
        if (h.dropped) bits.push('too large to keep — header only');
        if (h.error) bits.push(`FAILED: ${opts.redactor.apply(firstLine(h.error))}`);
        return bits.join('  ');
      });
      return ok(lines.join('\n'));
    },
  };
}

function readTool(opts: RequestToolOptions): Tool<{ seq: number; path?: string }> {
  const cap = opts.maxValue ?? MAX_VALUE;
  const budget = opts.budget ?? new Budget();
  return {
    name: 'read_request',
    description:
      'Read one captured request. With no path you get its structure — every field and, per ' +
      'message, its blocks by type, name and size — which is what a positional error like ' +
      '"messages.1.content.0" points into. With a JSON Pointer path ("/messages/1/content/0") ' +
      "you get that node's text values, shortened. Content is never returned in bulk.",
    mutating: false,
    args: z.object({
      seq: z.number().int().describe('the number from list_requests'),
      path: z
        .string()
        .optional()
        .describe('a JSON Pointer such as /messages/1/content/0; omit it for the structure'),
    }),
    async run(a) {
      const header = opts.snapshot.headers().find((h) => h.seq === a.seq);
      if (!header)
        return fail(`There is no request #${a.seq}. Call list_requests for the numbers.`);
      const json = opts.snapshot.body(a.seq);
      if (!json) {
        return fail(
          `Request #${a.seq} was captured but its body was not kept (${size(header.bytes)}, over ` +
            `the ring's limit). Its header is all there is.`,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(json);
      } catch (err) {
        return fail(`Request #${a.seq} did not parse as JSON: ${String(err)}`);
      }

      if (a.path === undefined || a.path === '') {
        const text = outline(body);
        const over = budget.take(text.length);
        return over ? fail(over) : ok(text);
      }

      const { node, why } = walk(body, a.path);
      if (why) return fail(why);
      if (opaque(node)) {
        return fail(
          `${a.path} is an encoded ${(node as { type?: string }).type ?? 'binary'} block, not ` +
            `text. Its size is in the structure listing; its bytes are not readable here.`,
        );
      }

      const found: { path: string; value: string }[] = [];
      strings(node, a.path, found);
      if (found.length === 0) {
        return ok(`${a.path} holds no text. Its shape is: ${JSON.stringify(node).slice(0, 200)}`);
      }

      // Cap first, redact second: the redactor may lengthen a span (a name becomes
      // "Character A"), and a cap applied after it would cut inside the substitution.
      const lines = found.map(({ path, value }) => {
        const clipped = value.length > cap;
        const shown = opts.redactor.apply(clipped ? value.slice(0, cap) : value);
        // A shortened value says so in its own line, so the analyst does not report on text
        // that is not there
        return clipped
          ? `${path}  (${value.length} chars, first ${cap} shown)\n${shown}`
          : `${path}\n${shown}`;
      });
      const text = lines.join('\n\n');
      const over = budget.take(text.length);
      return over ? fail(over) : ok(text);
    },
  };
}

/** Both tools, keyed by name, ready to splice into the analyst's registry. */
export function createRequestTools(opts: RequestToolOptions): Map<string, Tool> {
  const tools: Tool[] = [listTool(opts) as Tool, readTool(opts) as Tool];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

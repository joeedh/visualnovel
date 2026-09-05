/**
 * The three tools the analyst gets when the author lets it read the source.
 *
 * They are read tools and nothing else. An agent that has just read someone's private conversation
 * must not also be a way to send it somewhere, which matters more than any convenience here. That
 * is why `fetch_api_docs` takes a provider and a topic rather than a URL, and why every other tool
 * ends at the filesystem.
 */
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  inSecretsDir,
  readDocFile,
  resolveInWorkspace,
  SECRETS_REFUSAL,
  workspacePath,
} from '@vn/store';
import { sha256 } from '@vn/util';
import type { Tool, ToolResult } from '@vn/authoring';
import { denied, normalize, readableSourcePath, READABLE, textFile } from './sourcemap.js';

const ok = (output: string): ToolResult => ({ ok: true, output });
const fail = (output: string): ToolResult => ({ ok: false, output });

/** Files walked before grep gives up and says so. */
const MAX_FILES = 4000;
/** Matches returned from one grep. */
const MAX_MATCHES = 100;
/** Characters of any one matching line. */
const MAX_LINE = 300;
/** Bytes handed to the model across every read of one analysis. */
export const DEFAULT_READ_BUDGET = 250_000;

/**
 * What the analyst is allowed to spend on reading, in bytes of text handed back.
 *
 * A cap that silently returns less is worse than no cap: the model reads a truncated file as the
 * whole file and reports on what is not there. So every refusal here says it is a budget.
 */
export class Budget {
  private used = 0;
  constructor(private readonly limit: number = DEFAULT_READ_BUDGET) {}

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** Charge `bytes`, or refuse with a sentence naming the budget. */
  take(bytes: number): string | undefined {
    if (bytes > this.remaining) {
      return (
        `The reading budget for this analysis is spent (${this.used} of ${this.limit} bytes). ` +
        `Write the report from what you have already read, and say in it that you stopped early.`
      );
    }
    this.used += bytes;
    return undefined;
  }
}

/**
 * The two places the analyst may read from. Optional-with-a-fallback rather than `.default()`,
 * so zod's input and output types stay the same one — which is what `Tool<A>` asks for.
 */
const WHERE = z
  .enum(['source', 'project'])
  .optional()
  .describe('"source" (the default) is the app itself; "project" is the author\'s own files');

type Where = 'source' | 'project';

export interface SourceToolOptions {
  /** The app's own source tree. */
  sourceRoot: string;
  /** The project the bad conversation was about. */
  projectRoot: string;
  budget?: Budget;
  /** Where fetched documentation is cached. Absent means fetch every time. */
  cacheDir?: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** Today, as `YYYY-MM-DD`. The cache is keyed by it, so docs go stale by a day at most. */
  today?: string;
}

/**
 * A symlink inside a readable root escapes it: `resolveInWorkspace` is path arithmetic with no
 * `realpath`, and with pnpm a `node_modules` is a forest of exactly that. Every segment from the
 * root down is checked, because a link in the middle of a path is as good as one at the end.
 */
async function symlinked(root: string, abs: string): Promise<boolean> {
  let cur = abs;
  const stop = resolve(root);
  while (cur.length >= stop.length) {
    try {
      if ((await fs.lstat(cur)).isSymbolicLink()) return true;
    } catch {
      // Not there yet; the read itself will report that.
    }
    if (cur === stop) return false;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}

/**
 * The refusal a path earns before anything is opened, or `undefined` when there is none.
 * Credentials are tested first because the general refusal would also catch `keys/`, but it would
 * say "build output" about a secret.
 */
function refuseByPolicy(where: Where, rel: string): string | undefined {
  if (where === 'project' && inSecretsDir(normalize(rel))) return SECRETS_REFUSAL;
  if (denied(rel)) {
    return `${rel} is not part of what this build ships for reading (build output, dependencies, or credentials).`;
  }
  if (where === 'source' && !readableSourcePath(rel)) {
    return `${rel} is outside the readable part of the source. Readable roots: ${READABLE.join(', ')}.`;
  }
  return undefined;
}

interface Roots {
  source: string;
  project: string;
}

/** Walk one root for text files, refusing to follow links and stopping at the file cap. */
async function collect(root: string, where: Where): Promise<string[]> {
  const out: string[] = [];
  let capped = false;

  const walk = async (dir: string): Promise<void> => {
    if (capped) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capped) return;
      const abs = join(dir, entry.name);
      const rel = workspacePath(root, abs);
      if (denied(rel)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && textFile(entry.name)) {
        out.push(abs);
        if (out.length >= MAX_FILES) capped = true;
      }
    }
  };

  // A readable root may be a file, as CLAUDE.md is
  const add = async (name: string): Promise<void> => {
    const abs = join(root, name);
    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) await walk(abs);
    else if (stat.isFile() && textFile(name)) out.push(abs);
  };

  if (where === 'source') {
    for (const entry of READABLE) await add(entry);
  } else {
    await walk(root);
  }
  return out;
}

function grepTool(
  roots: Roots,
  budget: Budget,
): Tool<{ pattern: string; where?: Where; glob?: string }> {
  return {
    name       : 'grep',
    description:
      'Search the shipped source, its documentation, or the project files for a regular ' +
      'expression. Returns file:line matches.',
    mutating   : false,
    args: z.object({
      pattern: z.string().min(1).describe('a JavaScript regular expression, case-insensitive'),
      where  : WHERE,
      glob: z
        .string()
        .optional()
        .describe('a substring of the path to narrow to, e.g. "apps/desktop" or ".md"'),
    }),
    async run(a) {
      let re: RegExp;
      try {
        re = new RegExp(a.pattern, 'i');
      } catch (err) {
        return fail(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }

      const where = a.where ?? 'source';
      const root = where === 'source' ? roots.source : roots.project;
      const files = (await collect(root, where)).filter(
        (abs) => !a.glob || workspacePath(root, abs).includes(a.glob),
      );

      const lines: string[] = [];
      let truncated = false;
      let scanned = 0;
      for (const abs of files) {
        if (lines.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        scanned++;
        let text: string;
        try {
          text = await fs.readFile(abs, 'utf8');
        } catch {
          continue;
        }
        const rel = workspacePath(root, abs);
        text.split('\n').forEach((line, i) => {
          if (lines.length >= MAX_MATCHES || !re.test(line)) return;
          const trimmed = line.trim();
          const shown = trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE)}…` : trimmed;
          lines.push(`${rel}:${i + 1}: ${shown}`);
        });
      }

      const body = lines.join('\n');
      const over = budget.take(Buffer.byteLength(body, 'utf8'));
      if (over) return fail(over);

      if (lines.length === 0) {
        return ok(`No matches in ${scanned} file(s) under ${where}.`);
      }
      // The note names the cap, because a cap read as "that's all there is" produces a
      // confidently wrong report
      const note = truncated
        ? `\n\n(Stopped at ${MAX_MATCHES} matches with ${files.length - scanned} file(s) unscanned — there may be more. Narrow the pattern or pass a glob.)`
        : '';
      return ok(`${body}${note}`);
    },
  };
}

function readTool(roots: Roots, budget: Budget): Tool<{ path: string; where?: Where }> {
  return {
    name       : 'read_file',
    description:
      'Read one text file from the shipped source or from the project. Paths are relative to ' +
      'whichever root you name.',
    mutating   : false,
    args: z.object({
      path : z.string().min(1).describe('relative to the root, forward slashes'),
      where: WHERE,
    }),
    async run(a) {
      const where = a.where ?? 'source';
      const root = where === 'source' ? roots.source : roots.project;
      const abs = resolveInWorkspace(root, a.path);
      if (!abs) return fail(`"${a.path}" is outside the ${where} root.`);

      const rel = workspacePath(root, abs);
      const refusal = refuseByPolicy(where, rel);
      if (refusal) return fail(refusal);
      if (await symlinked(root, abs)) {
        return fail(`${rel} is a symbolic link, or reached through one, and is not followed.`);
      }

      const read = await readDocFile(root, rel);
      if (!read.ok) return fail(read.reason);

      const over = budget.take(read.file.bytes);
      if (over) return fail(over);
      return ok(read.file.text);
    },
  };
}

/**
 * The documentation the analyst may fetch, by provider and topic. A fixed list rather than a URL
 * argument: this is the one tool that talks to the network, and an arbitrary-URL fetch in the
 * hands of an agent holding a private transcript is an exfiltration channel, which the fixed list
 * closes.
 */
export const API_DOCS: Record<string, Record<string, string>> = {
  anthropic: {
    messages           : 'https://docs.claude.com/en/api/messages',
    'tool-use'         : 'https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview',
    'structured-output': 'https://docs.claude.com/en/docs/build-with-claude/structured-outputs',
    'extended-thinking': 'https://docs.claude.com/en/docs/build-with-claude/extended-thinking',
    models             : 'https://docs.claude.com/en/docs/about-claude/models/overview',
    errors             : 'https://docs.claude.com/en/api/errors',
  },
  gemini: {
    'text-generation'  : 'https://ai.google.dev/gemini-api/docs/text-generation',
    'function-calling' : 'https://ai.google.dev/gemini-api/docs/function-calling',
    'structured-output': 'https://ai.google.dev/gemini-api/docs/structured-output',
    models             : 'https://ai.google.dev/gemini-api/docs/models',
    errors             : 'https://ai.google.dev/gemini-api/docs/troubleshooting',
  },
};

/** The catalogue, as a sentence, so a wrong topic is answered with the right ones. */
function docIndex(): string {
  return Object.entries(API_DOCS)
    .map(([provider, topics]) => `${provider}: ${Object.keys(topics).join(', ')}`)
    .join('; ');
}

/** Enough of an HTML page to read as prose. Not a parser — a de-tagger with a size bound. */
function asText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MAX_DOC_CHARS = 40_000;

function docsTool(
  opts: SourceToolOptions,
  budget: Budget,
): Tool<{ provider: string; topic: string }> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const day = () => opts.today ?? new Date().toISOString().slice(0, 10);

  return {
    name       : 'fetch_api_docs',
    description:
      `Read a page of a model provider's API documentation. Takes a provider and a topic from ` +
      `a fixed list, never a URL. Available: ${docIndex()}.`,
    mutating   : false,
    args: z.object({
      provider: z.string().min(1).describe('anthropic or gemini'),
      topic   : z.string().min(1).describe('one of the topics listed for that provider'),
    }),
    async run(a) {
      const topics = API_DOCS[a.provider.toLowerCase()];
      if (!topics) return fail(`No documentation for "${a.provider}". Available — ${docIndex()}.`);
      const url = topics[a.topic.toLowerCase()];
      if (!url) {
        return fail(
          `No "${a.topic}" page for ${a.provider}. Topics: ${Object.keys(topics).join(', ')}.`,
        );
      }

      const cached = opts.cacheDir ? join(opts.cacheDir, `${sha256(`${url}\n${day()}`)}.txt`) : '';
      if (cached) {
        try {
          const hit = await fs.readFile(cached, 'utf8');
          const over = budget.take(Buffer.byteLength(hit, 'utf8'));
          return over ? fail(over) : ok(hit);
        } catch {
          // Not cached today; fetch it.
        }
      }

      let body: string;
      try {
        const res = await doFetch(url, {
          method  : 'GET',
          redirect: 'follow',
          signal  : AbortSignal.timeout(10_000),
        });
        if (!res.ok) return fail(`${url} answered ${res.status}.`);
        body = await res.text();
      } catch (err) {
        return fail(
          `could not reach the documentation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const text = asText(body).slice(0, MAX_DOC_CHARS);
      const over = budget.take(Buffer.byteLength(text, 'utf8'));
      if (over) return fail(over);

      if (cached) {
        try {
          await fs.mkdir(dirname(cached), { recursive: true });
          await fs.writeFile(cached, text, 'utf8');
        } catch {
          // A cache that will not write is a slower analysis, not a failed one.
        }
      }
      return ok(text);
    },
  };
}

/** The registry the analyst runs with. Read tools only; nothing here writes anything. */
export function createSourceTools(opts: SourceToolOptions): Map<string, Tool> {
  const budget = opts.budget ?? new Budget();
  const roots: Roots = {
    source : resolve(opts.sourceRoot),
    project: resolve(opts.projectRoot),
  };
  const tools: Tool[] = [
    grepTool(roots, budget) as Tool,
    readTool(roots, budget) as Tool,
    docsTool(opts, budget) as Tool,
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

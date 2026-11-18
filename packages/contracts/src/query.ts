/**
 * `@vn/contracts/query`: the generated contract index and the lookups every host answers from.
 *
 * The index is `packages/contracts/contracts.json`, which `pnpm gen:contracts` writes from the
 * declarations and a jest test keeps current. Hosts read the committed file rather than importing
 * the declarations, so `vnauthor`, which may not import the pipeline, sees the same contracts as
 * the desktop app.
 *
 * A lookup answers summaries (id, rule, subjects) unless it asks for the full record, and at most
 * {@link MAX_RESULTS} of them, with a count of the rest, so a broad query reads as cut rather
 * than complete.
 */
import data from '../contracts.json';
import { SUBJECT_PREFIXES } from './index.js';

/** One contract as the index records it. */
export interface ContractRecord {
  id: string;
  rule: string;
  prevents: string;
  subjects: string[];
  see?: string[];
  detail?: string;
  /** The repo-relative file whose exported const declares it. */
  declared: string;
}

/** What a lookup returns unless it asks for the full record. */
export type ContractSummary = Pick<ContractRecord, 'id' | 'rule' | 'subjects'>;

/** The generated file: every contract, and the ids attached to each subject. */
export interface ContractIndex {
  contracts: ContractRecord[];
  bySubject: Record<string, string[]>;
}

/** The committed index. */
export const INDEX = data as ContractIndex;

/** Contracts one lookup returns before it says how many it left out. */
export const MAX_RESULTS = 20;

export interface QueryOptions {
  /** Return `prevents`, `detail`, `see` and the declaring file as well. */
  full?: boolean;
  /** Defaults to {@link MAX_RESULTS}. */
  limit?: number;
  /** Defaults to the committed {@link INDEX}. */
  index?: ContractIndex;
}

/** The contracts a lookup matched, cut to its limit, and how many matched beyond that. */
export interface Found {
  contracts: (ContractSummary | ContractRecord)[];
  omitted: number;
}

function summaryOf(record: ContractRecord, full: boolean): ContractSummary | ContractRecord {
  return full ? record : { id: record.id, rule: record.rule, subjects: record.subjects };
}

function cut(records: ContractRecord[], opts: QueryOptions): Found {
  const limit = opts.limit ?? MAX_RESULTS;
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  return {
    contracts: sorted.slice(0, limit).map((r) => summaryOf(r, opts.full === true)),
    omitted  : Math.max(0, sorted.length - limit),
  };
}

/** The contract with this id, or undefined. */
export function byId(
  id: string,
  opts: QueryOptions = {},
): ContractSummary | ContractRecord | undefined {
  const record = (opts.index ?? INDEX).contracts.find((c) => c.id === id.trim());
  return record ? summaryOf(record, opts.full === true) : undefined;
}

/**
 * The contracts attached to `subject` or to any subject it is a prefix of, so
 * `module:packages/stills/` lists everything attached to that package's files. A `module:` query
 * also matches the `function:` subjects inside the same path.
 */
export function bySubject(subject: string, opts: QueryOptions = {}): Found {
  const index = opts.index ?? INDEX;
  const asked = subject.trim();
  const prefixes = [asked];
  if (asked.startsWith('module:')) prefixes.push(`function:${asked.slice('module:'.length)}`);
  const ids = new Set<string>();
  for (const [key, attached] of Object.entries(index.bySubject)) {
    if (prefixes.some((p) => key.startsWith(p))) for (const id of attached) ids.add(id);
  }
  return cut(
    index.contracts.filter((c) => ids.has(c.id)),
    opts,
  );
}

/** The contracts whose id, rule, failure, detail or subjects contain every word of `text`. */
export function search(text: string, opts: QueryOptions = {}): Found {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (opts.index ?? INDEX).contracts.filter((c) => {
    const hay = [c.id, c.rule, c.prevents, c.detail ?? '', ...c.subjects].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return cut(words.length === 0 ? [] : matches, opts);
}

/** Whether `text` names a subject, by its prefix. */
export function isSubject(text: string): boolean {
  const colon = text.indexOf(':');
  return colon > 0 && (SUBJECT_PREFIXES as readonly string[]).includes(text.slice(0, colon));
}

/** One contract as text: a summary line, or the full record over several lines. */
export function formatContract(c: ContractSummary | ContractRecord, full = false): string {
  const head = `${c.id}: ${c.rule} [${c.subjects.join(', ')}]`;
  if (!full || !('prevents' in c)) return head;
  return [
    head,
    `  prevents: ${c.prevents}`,
    ...(c.detail ? [`  detail: ${c.detail}`] : []),
    ...(c.see?.length ? [`  see: ${c.see.join(', ')}`] : []),
    `  declared in: ${c.declared}`,
  ].join('\n');
}

/** What a lookup found, as the text an agent tool or the CLI prints. */
export function formatFound(found: Found, asked: string, full = false): string {
  if (found.contracts.length === 0) return `No contract matches ${asked}.`;
  const lines = found.contracts.map((c) => formatContract(c, full));
  if (found.omitted > 0) {
    lines.push(`${found.omitted} more matched and were left out; narrow the query to see them.`);
  }
  return lines.join(full ? '\n\n' : '\n');
}

/** A lookup by id, by subject or by text. `answer` reads the first of the three that is set. */
export interface ContractQuery {
  id?: string;
  subject?: string;
  text?: string;
  full?: boolean;
}

/** The sentence a tool or the CLI gives when a query names nothing to look up. */
export const EMPTY_QUERY =
  'Give an id, a subject (module:, function:, command:, tool:, …) or text.';

/** Answers a query as text, or refuses one that names nothing to look up. */
export function answer(
  q: ContractQuery,
  opts: Omit<QueryOptions, 'full'> = {},
): { ok: boolean; output: string } {
  const full = q.full === true;
  if (q.id?.trim()) {
    const found = byId(q.id, { ...opts, full });
    return {
      ok    : true,
      output: found ? formatContract(found, full) : `No contract has the id "${q.id.trim()}".`,
    };
  }
  if (q.subject?.trim()) {
    const asked = q.subject.trim();
    return { ok: true, output: formatFound(bySubject(asked, { ...opts, full }), asked, full) };
  }
  if (q.text?.trim()) {
    const asked = `"${q.text.trim()}"`;
    return { ok: true, output: formatFound(search(q.text, { ...opts, full }), asked, full) };
  }
  return { ok: false, output: EMPTY_QUERY };
}

/** The tool description both agents' `query_contracts` share. */
export const QUERY_CONTRACTS_DESCRIPTION =
  'Look up the pipeline contracts: the rules the code enforces and the failures they prevent. ' +
  'Ask by `subject` for what applies to a file, command or tool (`module:<repo path>`, ' +
  '`function:<path>#<export>`, `command:<id>`, `tool:<name>`, `task:<kind>`, `slot:<prefix>`; a ' +
  'prefix matches everything under it), by `id`, or by `text`. Answers one summary line per ' +
  `contract, at most ${MAX_RESULTS}, and says how many it left out; \`full\` adds what each rule prevents, its ` +
  'detail and its plan links. Use it when a tool refuses and you want the rule behind the refusal.';

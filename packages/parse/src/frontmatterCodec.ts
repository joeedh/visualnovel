/**
 * The front-matter codec a form editor edits YAML through: `read` projects a fenced block to
 * plain JSON, and `patch` writes changed values back into the author's source in place, so the
 * comments, quoting and key order around them survive. Shaped to path.ux's `FrontmatterCodec`
 * without importing it, since this package sits below the renderer.
 *
 * The fence is this package's own (`---` at the top of the block, `---` closing it), so the codec
 * accepts exactly the blocks `parseFrontMatter` reads as front-matter and no others. What it
 * cannot patch safely it refuses by throwing, and the caller keeps the edit for a raw-source path.
 */
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
  type Node,
  type Pair,
} from 'yaml';
import { frontMatterSpan } from './frontmatter.js';

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** The structural twin of path.ux's `FrontmatterCodec`; tsgo checks the shape at the call site. */
export interface FrontmatterCodec {
  /** Throws when the block is not front-matter this codec will edit. */
  read(source: string): JsonValue;
  /** Throws when a change cannot be written into the source without rewriting more than it. */
  patch(source: string, values: JsonValue): string;
}

/** Past this a block is no longer something a form edits field by field. */
export const MAX_FRONT_MATTER_BYTES = 65_536;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;

interface Parsed {
  doc: ReturnType<typeof parseDocument>;
  value: JsonObject;
  yaml: string;
  start: number;
  end: number;
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * What `Document.toJS` gives back, checked into JSON: the `core` schema yields only plain
 * objects, arrays, strings, finite or infinite numbers, booleans and null, and the one of those
 * JSON cannot carry is a non-finite number.
 */
function jsonOf(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Front matter holds a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonOf);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, JsonValue> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = jsonOf(v);
    return out;
  }
  throw new Error('Front matter holds a value that is not JSON');
}

function read(source: string): Parsed {
  if (new TextEncoder().encode(source).length > MAX_FRONT_MATTER_BYTES) {
    throw new Error('Front matter exceeds 64 KiB');
  }
  const span = frontMatterSpan(source);
  if (!span) throw new Error('Not a front-matter block: the fence must open at the first line');
  const yaml = source.slice(span.start, span.end);
  const doc = parseDocument(yaml, { strict: true, uniqueKeys: true, schema: 'core' });
  if (doc.errors.length || doc.warnings.length) {
    const first = doc.errors[0] ?? doc.warnings[0];
    throw new Error(`Malformed or unsupported YAML: ${first!.message}`);
  }
  let count = 0;
  visit(doc, (_key, node, path) => {
    if (++count > MAX_NODES || path.length > MAX_DEPTH) {
      throw new Error('YAML exceeds depth or node limits');
    }
    if (isAlias(node) || (isNode(node) && (node.tag || ('anchor' in node && node.anchor)))) {
      throw new Error('YAML aliases, anchors and tags require raw source editing');
    }
  });
  if (doc.contents && !isMap(doc.contents)) throw new Error('Front matter must be a mapping');
  const value = jsonOf(doc.toJS({ maxAliasCount: 0 }) ?? {});
  if (!isJsonObject(value)) throw new Error('Front matter must be a mapping');
  return { doc, value, yaml, start: span.start, end: span.end };
}

function hasComments(node: Node): boolean {
  let found = false;
  visit(node, (_key, value) => {
    if (isNode(value) && (value.comment || value.commentBefore)) found = true;
  });
  return found;
}

const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9 _./-]*$/;

/** The source text for a replacement scalar, keeping the author's quoting where it still fits. */
function scalarText(node: Node, after: JsonValue): string {
  if (isScalar(node) && typeof after === 'string' && !/[\r\n]/.test(after)) {
    if (node.type === 'QUOTE_SINGLE') return `'${after.replaceAll("'", "''")}'`;
    if (
      node.type === 'PLAIN' &&
      PLAIN_SAFE.test(after) &&
      after.trim() === after &&
      parseDocument(after).toJS() === after
    ) {
      return after;
    }
  }
  return JSON.stringify(after);
}

interface Edit {
  from: number;
  to: number;
  text: string;
  /** Gathering order; two insertions at one offset land in it. */
  seq: number;
}

/** The source and the edits `patch` gathers over it; offsets are into `yaml` before any edit. */
interface Patch {
  yaml: string;
  eol: string;
  edits: Edit[];
}

function edit(patch: Patch, from: number, to: number, text: string): void {
  patch.edits.push({ from, to, text, seq: patch.edits.length });
}

/** JSON with object keys sorted, so two values compare equal whatever order a form wrote them in. */
function canonical(value: JsonValue): string {
  if (isJsonObject(value)) {
    const sorted = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`);
    return `{${sorted.join(',')}}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return JSON.stringify(value);
}

function same(a: JsonValue, b: JsonValue): boolean {
  return canonical(a) === canonical(b);
}

function isScalarValue(value: JsonValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

/** A flow sequence's item: plain where the text can be, quoted where it cannot. */
function flowItemText(value: string | number | boolean | null): string {
  if (
    typeof value === 'string' &&
    PLAIN_SAFE.test(value) &&
    parseDocument(value).toJS() === value
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function lineStart(yaml: string, offset: number): number {
  return yaml.lastIndexOf('\n', offset - 1) + 1;
}

/** The offset just past the line ending that follows `offset`, or the end of the text. */
function lineEnd(yaml: string, offset: number): number {
  if (offset > 0 && yaml[offset - 1] === '\n') return offset;
  const newline = yaml.indexOf('\n', offset);
  return newline < 0 ? yaml.length : newline + 1;
}

/** `value` as block YAML, every line at `indent`, ending in the patch's line ending. */
function blockText(patch: Patch, value: JsonValue, indent: string): string {
  const lines = stringify(value, { lineWidth: 0 }).replace(/\n$/, '').split('\n');
  return lines.map((line) => indent + line + patch.eol).join('');
}

/**
 * Removes the lines an entry occupies, from the start of the line its first token is on
 * through the line ending after its value, or refuses when the line carries anything else.
 */
function removeLines(patch: Patch, first: Node, last: Node, prefix: RegExp, what: string): void {
  const { yaml } = patch;
  if (!first.range || !last.range || hasComments(first) || hasComments(last)) {
    throw new Error(`Removing this ${what} requires raw source editing`);
  }
  const from = lineStart(yaml, first.range[0]);
  if (!prefix.test(yaml.slice(from, first.range[0]))) {
    throw new Error(`Removing this ${what} requires raw source editing`);
  }
  edit(patch, from, lineEnd(yaml, last.range[2]), '');
}

/** A map entry whose key and value both have source ranges. */
interface Entry {
  key: Node;
  value: Node;
}

/** The entries of a map by their JSON key, with any pair the codec cannot place refused. */
function pairsOf(node: { items: Pair[] }): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const pair of node.items) {
    if (!isScalar(pair.key) || !isNode(pair.value) || !pair.key.range || !pair.value.range) {
      throw new Error('This collection requires raw source editing');
    }
    out.set(String(pair.key.value), { key: pair.key, value: pair.value });
  }
  return out;
}

/**
 * The edits that turn a block map's `before` into `after`: a key at the same position with a
 * new name and the same value is renamed in the key's own range, a key kept recurses, a key
 * dropped loses its lines, and a key added is appended at the map's indent.
 */
function patchMap(
  patch: Patch,
  node: { items: Pair[] },
  before: JsonObject,
  after: JsonObject,
): void {
  const { yaml } = patch;
  const pairs = pairsOf(node);
  const bKeys = Object.keys(before);
  const aKeys = Object.keys(after);
  const renamed = new Map<string, string>();
  for (let i = 0; i < Math.min(bKeys.length, aKeys.length); i++) {
    const [from, to] = [bKeys[i]!, aKeys[i]!];
    if (
      from !== to &&
      !Object.hasOwn(after, from) &&
      !Object.hasOwn(before, to) &&
      same(before[from]!, after[to]!)
    ) {
      renamed.set(from, to);
    }
  }
  for (const key of bKeys) {
    const pair = pairs.get(key);
    if (!pair) throw new Error('This collection requires raw source editing');
    const to = renamed.get(key);
    if (to !== undefined) {
      if (hasComments(pair.key) || hasComments(pair.value)) {
        throw new Error('Renaming this field requires raw source editing');
      }
      const range = pair.key.range!;
      edit(patch, range[0], range[1], scalarText(pair.key, to));
    } else if (Object.hasOwn(after, key)) {
      replaceIn(patch, pair.value, before[key]!, after[key]!);
    } else {
      removeLines(patch, pair.key, pair.value, /^\s*$/, 'field');
    }
  }
  const targets = [...renamed.values()];
  const added = aKeys.filter((key) => !Object.hasOwn(before, key) && !targets.includes(key));
  if (!added.length) return;
  const last = pairs.get(bKeys.at(-1)!)!;
  const column = last.key.range![0] - lineStart(yaml, last.key.range![0]);
  const at = lineEnd(yaml, last.value.range![2]);
  const text = added.map((key) => blockText(patch, { [key]: after[key]! }, ' '.repeat(column)));
  edit(patch, at, at, text.join(''));
}

type SeqOp =
  { op: 'keep'; index: number } | { op: 'del'; index: number } | { op: 'ins'; value: JsonValue };

/** A longest-common-subsequence alignment of two item lists, by value. */
function seqOps(before: readonly JsonValue[], after: readonly JsonValue[]): SeqOp[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const lcs: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i]![j] = same(before[i]!, after[j]!)
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: SeqOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && same(before[i]!, after[j]!)) {
      ops.push({ op: 'keep', index: i++ });
      j++;
    } else if (j < after.length && (i >= before.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ op: 'ins', value: after[j++]! });
    } else {
      ops.push({ op: 'del', index: i++ });
    }
  }
  return ops;
}

/**
 * The edits that turn a block sequence's `before` into `after`: an item in both stays, one
 * replaced at its position is patched in place, one dropped loses its lines, and one added is
 * written before the next kept item or after the last.
 */
function patchSeq(
  patch: Patch,
  node: { items: unknown[] },
  before: readonly JsonValue[],
  after: readonly JsonValue[],
): void {
  const { yaml } = patch;
  const items = node.items.map((item) => {
    if (!isNode(item) || !item.range)
      throw new Error('This collection requires raw source editing');
    return item;
  });
  const first = items[0]!;
  const prefix = yaml.slice(lineStart(yaml, first.range![0]), first.range![0]);
  if (!/^\s*-\s*$/.test(prefix)) throw new Error('This collection requires raw source editing');
  const indent = ' '.repeat(prefix.indexOf('-'));
  const itemText = (value: JsonValue) => {
    const lines = stringify(value, { lineWidth: 0 }).replace(/\n$/, '').split('\n');
    return lines.map((line, n) => indent + (n === 0 ? '- ' : '  ') + line + patch.eol).join('');
  };
  let dels: number[] = [];
  let inss: JsonValue[] = [];
  const flush = (at: number) => {
    while (dels.length && inss.length) {
      const index = dels.shift()!;
      replaceIn(patch, items[index], before[index]!, inss.shift()!);
    }
    for (const index of dels) removeLines(patch, items[index]!, items[index]!, /^\s*-\s*$/, 'item');
    if (inss.length) edit(patch, at, at, inss.map(itemText).join(''));
    dels = [];
    inss = [];
  };
  for (const op of seqOps(before, after)) {
    if (op.op === 'keep') flush(lineStart(yaml, items[op.index]!.range![0]));
    else if (op.op === 'del') dels.push(op.index);
    else inss.push(op.value);
  }
  flush(lineEnd(yaml, items.at(-1)!.range![2]));
}

/** Rewrites a block scalar's text as a literal block, keeping the content's indent. */
function patchBlockScalar(patch: Patch, node: Node, after: string): void {
  const { yaml } = patch;
  if (hasComments(node)) throw new Error('This block scalar requires raw source editing');
  const [from, to] = node.range!;
  const contentStart = lineEnd(yaml, from);
  const indent = /^[ \t]*/.exec(yaml.slice(contentStart, to))![0] || '  ';
  const block = stringify(after, { blockQuote: 'literal', lineWidth: 0 });
  const lines = block.replace(/\n$/, '').split('\n');
  const text = block.startsWith('|')
    ? lines.map((line, n) => (n === 0 ? line : line && indent + line) + patch.eol).join('')
    : JSON.stringify(after) + patch.eol;
  edit(patch, from, to, text);
}

/**
 * The edits that turn `before` into `after` under `node`: block maps and sequences are edited
 * entry by entry, a flow sequence of scalars is rewritten as one, a scalar is replaced within
 * its own range, and anything else is rewritten inline or refused.
 */
function replaceIn(patch: Patch, node: unknown, before: JsonValue, after: JsonValue): void {
  if (same(before, after)) return;
  if (!isNode(node) || !node.range) throw new Error('Value has no safe source range');
  const { yaml } = patch;
  if (isMap(node) && isJsonObject(before) && isJsonObject(after)) {
    if (!node.flow && Object.keys(after).length && Object.keys(before).length) {
      patchMap(patch, node, before, after);
      return;
    }
    if (Object.keys(before).sort().join('\0') === Object.keys(after).sort().join('\0')) {
      for (const [key, next] of Object.entries(after)) {
        replaceIn(patch, node.get(key, true), before[key]!, next);
      }
      return;
    }
  }
  if (isSeq(node) && Array.isArray(before) && Array.isArray(after)) {
    if (!node.flow && after.length && before.length) {
      patchSeq(patch, node, before, after);
      return;
    }
    if (before.length === after.length) {
      after.forEach((next, index) => replaceIn(patch, node.items[index], before[index]!, next));
      return;
    }
    if (node.flow && after.every(isScalarValue)) {
      edit(patch, node.range[0], node.range[1], `[${after.map(flowItemText).join(', ')}]`);
      return;
    }
  }
  if (isScalar(node) && (node.type === 'BLOCK_FOLDED' || node.type === 'BLOCK_LITERAL')) {
    if (typeof after === 'string') {
      patchBlockScalar(patch, node, after);
      return;
    }
    throw new Error('This block scalar requires raw source editing');
  }
  if (!isScalar(node) && hasComments(node)) {
    throw new Error('This collection requires raw source editing');
  }
  // A block collection's range runs through its final line ending; the replacement is inline
  let to = node.range[1];
  while (to > node.range[0] && /\s/.test(yaml[to - 1]!)) to--;
  edit(patch, node.range[0], to, scalarText(node, after));
}

/**
 * Bounded core YAML in, range patching out. `patch` keeps comments, quoting, key order, line
 * endings and every value the edit did not touch. Inside a block map or sequence it adds,
 * removes and renames entries line by line; a flow collection is rewritten inline; an entry
 * that carries a comment is never removed or renamed.
 */
export const frontmatterCodec: FrontmatterCodec = {
  read: (source) => read(source).value,
  patch(source, input) {
    if (!isJsonObject(input)) throw new Error('Form values must be an object');
    const parsed = read(source);
    const { doc, value, yaml, start, end } = parsed;
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const patch: Patch = { yaml, eol, edits: [] };
    if (isMap(doc.contents) && !doc.contents.flow && doc.contents.items.length) {
      patchMap(patch, doc.contents, value, input);
    } else if (Object.keys(value).length) {
      replaceIn(patch, doc.contents, value, input);
    } else if (Object.keys(input).length) {
      if (isMap(doc.contents) && doc.contents.flow) {
        throw new Error('Flow-map insertion requires raw source editing');
      }
      const at = yaml.length;
      const lead = yaml && !yaml.endsWith('\n') ? eol : '';
      edit(patch, at, at, lead + blockText(patch, input, ''));
    }
    let patched = yaml;
    const ordered = patch.edits.sort((a, b) => b.from - a.from || b.to - a.to || b.seq - a.seq);
    for (const e of ordered) {
      patched = patched.slice(0, e.from) + e.text + patched.slice(e.to);
    }
    const result = source.slice(0, start) + patched + source.slice(end);
    if (!same(read(result).value, input)) {
      throw new Error('YAML patch did not preserve the requested values');
    }
    return result;
  },
};

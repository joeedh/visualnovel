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
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit, type Node } from 'yaml';
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
}

/**
 * The edits that turn `before` into `after` under `node`: equal-shape maps and sequences recurse,
 * a scalar is replaced within its own range, and anything else is refused rather than rewritten.
 */
function replaceIn(
  yaml: string,
  node: unknown,
  before: JsonValue,
  after: JsonValue,
  edits: Edit[],
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (!isNode(node) || !node.range) throw new Error('Value has no safe source range');
  if (
    isMap(node) &&
    isJsonObject(before) &&
    isJsonObject(after) &&
    Object.keys(before).join('\0') === Object.keys(after).join('\0')
  ) {
    for (const [key, next] of Object.entries(after)) {
      replaceIn(yaml, node.get(key, true), before[key]!, next, edits);
    }
    return;
  }
  if (isSeq(node) && Array.isArray(before) && Array.isArray(after)) {
    if (before.length === after.length) {
      after.forEach((next, index) =>
        replaceIn(yaml, node.items[index], before[index]!, next, edits),
      );
      return;
    }
  }
  if (
    (!isScalar(node) && hasComments(node)) ||
    (isScalar(node) && (node.type === 'BLOCK_FOLDED' || node.type === 'BLOCK_LITERAL'))
  ) {
    throw new Error('This collection or block scalar requires raw source editing');
  }
  // A block collection's range runs through its final line ending; the replacement is inline
  let to = node.range[1];
  while (to > node.range[0] && /\s/.test(yaml[to - 1]!)) to--;
  edits.push({ from: node.range[0], to, text: scalarText(node, after) });
}

/** The edit that removes a top-level key and its whole line, or a refusal when it shares one. */
function removalOf(parsed: Parsed, key: string): Edit {
  const { doc, yaml } = parsed;
  const pair = isMap(doc.contents)
    ? doc.contents.items.find((p) => isScalar(p.key) && p.key.value === key)
    : undefined;
  if (
    !pair ||
    !isNode(pair.key) ||
    !pair.key.range ||
    !isNode(pair.value) ||
    !pair.value.range ||
    hasComments(pair.key) ||
    hasComments(pair.value)
  ) {
    throw new Error('Removing this field requires raw source editing');
  }
  const from = yaml.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
  const valueEnd = pair.value.range[2];
  const newline = yaml.indexOf('\n', valueEnd);
  const to =
    valueEnd > 0 && yaml[valueEnd - 1] === '\n'
      ? valueEnd
      : newline < 0
        ? yaml.length
        : newline + 1;
  if (yaml.slice(from, pair.key.range[0]).trim()) {
    throw new Error('Flow-map removal requires raw source editing');
  }
  return { from, to, text: '' };
}

/**
 * Bounded core YAML in, scalar-range patching out. `patch` keeps comments, quoting, key order,
 * line endings and every key the values did not change; a new top-level key is appended, a
 * dropped one has its line removed, and a reshaped collection is refused.
 */
export const frontmatterCodec: FrontmatterCodec = {
  read: (source) => read(source).value,
  patch(source, input) {
    if (!isJsonObject(input)) throw new Error('Form values must be an object');
    const parsed = read(source);
    const { value, yaml, start, end } = parsed;
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const edits: Edit[] = [];
    for (const [key, before] of Object.entries(value)) {
      if (Object.hasOwn(input, key)) {
        replaceIn(yaml, parsed.doc.get(key, true), before, input[key]!, edits);
      } else {
        edits.push(removalOf(parsed, key));
      }
    }
    let additions = '';
    for (const [key, next] of Object.entries(input)) {
      if (!Object.hasOwn(value, key)) {
        additions += `${JSON.stringify(key)}: ${JSON.stringify(next)}${eol}`;
      }
    }
    if (additions && isMap(parsed.doc.contents) && parsed.doc.contents.flow) {
      throw new Error('Flow-map insertion requires raw source editing');
    }
    let patched = yaml;
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      patched = patched.slice(0, edit.from) + edit.text + patched.slice(edit.to);
    }
    if (additions) patched += (patched && !patched.endsWith('\n') ? eol : '') + additions;
    const result = source.slice(0, start) + patched + source.slice(end);
    if (JSON.stringify(read(result).value) !== JSON.stringify(input)) {
      throw new Error('YAML patch did not preserve the requested values');
    }
    return result;
  },
};

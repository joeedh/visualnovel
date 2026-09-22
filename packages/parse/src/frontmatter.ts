import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** A markdown document split into its YAML front-matter and prose body. */
export interface FrontMatterDoc {
  /** Parsed front-matter (empty object when absent). */
  data: Record<string, unknown>;
  /** The markdown body after the front-matter block. */
  body: string;
}

// Group 1 is the YAML with its final line ending, so a splice at its end lands before the closer
const FENCE = /^---[ \t]*\r?\n([\s\S]*?\r?\n)---[ \t]*(?:\r?\n|$)/;

const BOM = '﻿';

/**
 * Split a file into the front-matter block and the body, byte-exactly: `prefix + body` is the
 * file, less a BOM. A patcher that rewrites only prose splices its result back onto `prefix`, so
 * the YAML the author wrote (key order, spacing, comments) survives instead of being
 * re-serialized.
 */
export function splitFrontMatter(text: string): { prefix: string; body: string } {
  const normalized = text.startsWith(BOM) ? text.slice(1) : text;
  const match = FENCE.exec(normalized);
  if (!match) return { prefix: '', body: normalized };
  return { prefix: match[0], body: normalized.slice(match[0].length) };
}

/**
 * Where the YAML of a leading front-matter block sits in `text`, as offsets into `text` itself:
 * from the line after the opening fence to the start of the closing one, so the slice ends with a
 * line ending. Undefined when the text does not open with a fence.
 */
export function frontMatterSpan(text: string): { start: number; end: number } | undefined {
  const bom = text.startsWith(BOM) ? 1 : 0;
  const match = FENCE.exec(text.slice(bom));
  if (!match) return undefined;
  const start = bom + match[0].indexOf('\n') + 1;
  return { start, end: start + match[1]!.length };
}

/**
 * Read YAML front-matter delimited by `---` fences at the top of a markdown file.
 * Files without a fence parse to `{ data: {}, body: <whole text> }`.
 */
export function parseFrontMatter(text: string): FrontMatterDoc {
  const { prefix, body } = splitFrontMatter(text);
  if (!prefix) return { data: {}, body };
  const yaml = FENCE.exec(prefix)?.[1] ?? '';
  return { data: (parseYaml(yaml) ?? {}) as Record<string, unknown>, body };
}

/** Serialize front-matter + body back into a markdown file (round-trips `parse`). */
export function stringifyFrontMatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** Why `text` is not YAML, or undefined when it parses. */
export function yamlProblem(text: string): string | undefined {
  try {
    parseYaml(text);
    return undefined;
  } catch (err) {
    return (err as Error).message.split('\n')[0];
  }
}

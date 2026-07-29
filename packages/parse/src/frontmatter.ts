import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** A markdown document split into its YAML front-matter and prose body. */
export interface FrontMatterDoc {
  /** Parsed front-matter (empty object when absent). */
  data: Record<string, unknown>;
  /** The markdown body after the front-matter block. */
  body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The front-matter block and the body as byte-exact halves: `prefix + body` is the file, less
 * a BOM. A patcher that rewrites only prose splices its result back onto `prefix`, so YAML the
 * author wrote — key order, spacing, comments — survives where re-serializing it would not.
 */
export function splitFrontMatter(text: string): { prefix: string; body: string } {
  const normalized = text.startsWith('﻿') ? text.slice(1) : text;
  const match = FENCE.exec(normalized);
  if (!match) return { prefix: '', body: normalized };
  return { prefix: match[0], body: normalized.slice(match[0].length) };
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

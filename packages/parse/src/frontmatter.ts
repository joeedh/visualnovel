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
 * Read YAML front-matter delimited by `---` fences at the top of a markdown file.
 * Files without a fence parse to `{ data: {}, body: <whole text> }`.
 */
export function parseFrontMatter(text: string): FrontMatterDoc {
  const normalized = text.startsWith('﻿') ? text.slice(1) : text;
  const match = FENCE.exec(normalized);
  if (!match) return { data: {}, body: normalized };
  const data = (parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>;
  return { data, body: normalized.slice(match[0].length) };
}

/** Serialize front-matter + body back into a markdown file (round-trips `parse`). */
export function stringifyFrontMatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/**
 * The index: a walk of the bible root, each file's metadata and its lines held in memory so a
 * query is arithmetic rather than I/O. Rebuilt per file by mtime, so an author editing one note
 * does not pay to re-read a hundred.
 */
import { promises as fs } from 'node:fs';
import { basename, relative } from 'node:path';
import { parseFrontMatter } from '@vn/parse';
import { listMarkdownTree } from '@vn/store';
import { readText } from '@vn/util';
import type { BibleFile } from './types.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** A file plus everything a query needs from it. `lines` is the grep index. */
export interface IndexedFile extends BibleFile {
  abs: string;
  mtimeMs: number;
  lines: string[];
  /** Nearest enclosing heading for each line, parallel to `lines`. */
  headingAt: (string | undefined)[];
}

/** Front-matter values that read as a list of strings; anything else contributes nothing. */
function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Read one bible file. Bible files are arbitrary prose, so unparseable front-matter is not an
 * error here — the file is simply indexed as the text it is.
 */
export async function readIndexed(
  abs: string,
  root: string,
  mtimeMs: number,
): Promise<IndexedFile> {
  const text = await readText(abs);
  let data: Record<string, unknown> = {};
  try {
    data = parseFrontMatter(text).data;
  } catch {
    // Indexed as raw text: a broken YAML fence does not stop the file being indexed
  }

  // Lines cover the whole file, front matter included, so a reported `file:line` is the line
  // an editor shows
  const lines = text.split('\n');
  const headings: string[] = [];
  const headingAt: (string | undefined)[] = [];
  let current: string | undefined;
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      current = m[2]!;
      headings.push(current);
    }
    headingAt.push(current);
  }

  const file = relative(root, abs).split('\\').join('/');
  const title =
    (typeof data['title'] === 'string' && data['title']) ||
    (typeof data['name'] === 'string' && data['name']) ||
    headings[0] ||
    basename(abs).replace(/\.md$/i, '');

  return {
    file,
    title,
    tags: [...stringList(data['tags']), ...stringList(data['type'])],
    headings,
    bytes: text.length,
    abs,
    mtimeMs,
    lines,
    headingAt,
  };
}

/**
 * Walk the root and return the index, reusing any entry from `previous` whose file has not
 * changed. Ordered by path, like the walk itself.
 */
export async function buildIndex(
  root: string,
  previous: Map<string, IndexedFile> = new Map(),
): Promise<IndexedFile[]> {
  const out: IndexedFile[] = [];
  for (const abs of await listMarkdownTree(root)) {
    const { mtimeMs } = await fs.stat(abs);
    const cached = previous.get(abs);
    out.push(cached && cached.mtimeMs === mtimeMs ? cached : await readIndexed(abs, root, mtimeMs));
  }
  return out;
}

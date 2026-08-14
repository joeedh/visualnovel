/**
 * Markdown tree walking. Shared by entity discovery (which reads a file's tag) and by the
 * story-bible reader (which reads its prose), so both see the same files in the same order.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { exists } from '@vn/util';
import type { ProjectPaths } from './paths.js';

/** Every `.md` under a directory tree, depth-first and name-ordered so a load is deterministic. */
export async function listMarkdownTree(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listMarkdownTree(full)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(full);
  }
  return found;
}

/** Every markdown file in the story bible. Empty when the project has no `wiki/`. */
export function listWikiFiles(paths: ProjectPaths): Promise<string[]> {
  return listMarkdownTree(paths.wikiDir);
}

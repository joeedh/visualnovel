/**
 * `@vn/bible` — retrieval over the story bible (`wiki/`).
 *
 * The bible is an arbitrary markdown tree and is **never pasted into the agent's context**:
 * it is reached by query, under a character budget, one passage at a time. This package holds
 * the ranking policy that `@vn/store` (which only walks and reads) deliberately does not.
 *
 * Rooted at a **directory**, not a `ProjectPaths`: the bible may live in its own git repo, and
 * nothing here may assume it shares one with the project.
 */
import { resolve } from 'node:path';
import { buildIndex, type IndexedFile } from './indexer.js';
import { rank } from './query.js';
import type { Bible, BibleFile, Excerpt, QueryOptions } from './types.js';

export type { Bible, BibleFile, Excerpt, QueryOptions } from './types.js';
export { terms } from './query.js';

class GrepBible implements Bible {
  private index: IndexedFile[] = [];

  private constructor(readonly root: string) {}

  static async open(root: string): Promise<GrepBible> {
    const bible = new GrepBible(resolve(root));
    await bible.refresh();
    return bible;
  }

  /** Re-walk, re-reading only the files whose mtime moved. */
  async refresh(): Promise<void> {
    this.index = await buildIndex(this.root, new Map(this.index.map((f) => [f.abs, f])));
  }

  files(): BibleFile[] {
    return this.index.map(({ file, title, tags, headings, bytes }) => ({
      file,
      title,
      tags,
      headings,
      bytes,
    }));
  }

  async query(text: string, opts?: QueryOptions): Promise<Excerpt[]> {
    await this.refresh();
    return rank(this.index, text, opts);
  }
}

/**
 * Open the bible at `root`. A directory that does not exist is not an error — a project with
 * no `wiki/` has an empty bible, and every caller then behaves as it does today.
 */
export function openBible(root: string): Promise<Bible> {
  return GrepBible.open(root);
}

/** Render excerpts the way the agent's other search tools render matches. */
export function formatExcerpts(excerpts: Excerpt[]): string {
  return excerpts
    .map((e) => `${e.file}:${e.line}${e.heading ? ` (${e.heading})` : ''}\n${e.text}`)
    .join('\n\n');
}

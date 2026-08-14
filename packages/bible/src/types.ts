/**
 * The retrieval seam. `query(text) → ranked excerpts` is deliberately the *only* way in:
 * there is no API here that returns a whole file, which is what makes "the bible is not
 * pasted into the context window" a property of the code rather than a habit. A grep index
 * satisfies this interface today; an embedding store could satisfy it without a caller
 * changing.
 */

/** One file in the bible, as the index sees it. */
export interface BibleFile {
  /** Path relative to the bible root, with `/` separators. */
  file: string;
  /** Front-matter `title:`, else the first H1, else the filename stem. */
  title: string;
  /** Front-matter `tags:`, plus `type:` when the file is a tagged entity sheet. */
  tags: string[];
  headings: string[];
  bytes: number;
}

/** A passage worth reading, with enough context to be read on its own. */
export interface Excerpt {
  file: string;
  /** 1-based line of the excerpt's first line. */
  line: number;
  /** Nearest enclosing markdown heading, when the passage is under one. */
  heading?: string;
  text: string;
  score: number;
}

export interface QueryOptions {
  /** Most excerpts to return (default 8). */
  limit?: number;
  /** Most characters to return in total (default 4000). The last excerpt is truncated. */
  budget?: number;
}

export interface Bible {
  /** Absolute path of the bible root. */
  readonly root: string;
  /** Re-walk the root, re-reading only what changed. `query` does this for itself. */
  refresh(): Promise<void>;
  /** What the index held as of the last walk. Metadata only — never file contents. */
  files(): BibleFile[];
  /** Rank passages against a query. Empty when the query has no searchable terms. */
  query(text: string, opts?: QueryOptions): Promise<Excerpt[]>;
}

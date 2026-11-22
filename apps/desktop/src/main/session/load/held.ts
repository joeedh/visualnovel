import { stat } from 'node:fs/promises';
import type { LoadedGraph } from '@vn/pipeline';
import type { GraphSlug } from '../../doctree/graphs.js';

/** One loaded graph, keyed by the slug its document and its journal are both filed under. */
export interface LoadedGraphDoc extends LoadedGraph {
  slug: GraphSlug;
}

/** What one file looked like when something was recorded about it. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * One document's last answer, and what every file it was built from looked like at the time: its
 * own, and the definition file of each group it resolved. A file that was absent is held as
 * undefined, so its arrival reads as a change too.
 */
export interface HeldDoc<R> {
  read: R;
  stamps: Map<string, FileStamp | undefined>;
}

/** The stamp for `file`, or undefined when there is nothing there to stamp. */
export async function statOf(file: string): Promise<FileStamp | undefined> {
  const found = await stat(file).catch(() => null);
  return found ? { mtimeMs: found.mtimeMs, size: found.size } : undefined;
}

export async function stampsOf(
  files: readonly string[],
): Promise<Map<string, FileStamp | undefined>> {
  const out = new Map<string, FileStamp | undefined>();
  for (const file of files) out.set(file, await statOf(file));
  return out;
}

/** True while every file a held answer was built from still looks the way it did. */
export async function unmoved(held: HeldDoc<unknown>): Promise<boolean> {
  for (const [file, was] of held.stamps) {
    const now = await statOf(file);
    if (was?.mtimeMs !== now?.mtimeMs || was?.size !== now?.size) return false;
  }
  return true;
}

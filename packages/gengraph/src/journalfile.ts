import type { ProjectPaths } from '@vn/store';
import { appendJsonl, readText } from '@vn/util';

import { emptyJournal, replayJournal } from './journal.js';
import type { GraphJournal, GraphJournalRecord } from './journal.js';
import { graphJournalFile } from './paths.js';

/**
 * Appends one record. The file is only ever appended to, so a re-run adds a record
 * rather than rewriting the one it supersedes. It lives under `state/`, which undo
 * already excludes, so a node's run history survives an undo of the edit that caused it.
 */
export async function appendGraphJournal(
  paths: ProjectPaths,
  slug: string,
  record: GraphJournalRecord,
): Promise<void> {
  await appendJsonl(graphJournalFile(paths, slug), record);
}

/** Replays a graph's journal. A graph that has never run gives an empty one. */
export async function readGraphJournal(paths: ProjectPaths, slug: string): Promise<GraphJournal> {
  let text: string;
  try {
    text = await readText(graphJournalFile(paths, slug));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyJournal();
    }
    throw err;
  }
  return replayJournal(text);
}

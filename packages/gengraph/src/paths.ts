import type { ProjectPaths } from '@vn/store';
import { join } from '@vn/util';

import type { GenBlobRef } from './services.js';

/**
 * Where a project keeps its generation graphs. A graph document is authored and
 * committed under `work/`, and everything a run of it produces sits under `state/`,
 * which is the split the task pipeline already uses.
 */

/** Graph documents, one file per graph. */
export function graphsDir(paths: ProjectPaths): string {
  return join(paths.work, 'graphs');
}

/** Group definitions, which a graph document references by name rather than by path. */
export function graphLibDir(paths: ProjectPaths): string {
  return join(graphsDir(paths), 'lib');
}

export function graphDocFile(paths: ProjectPaths, slug: string): string {
  return join(graphsDir(paths), `${slug}.json`);
}

export function graphGroupFile(paths: ProjectPaths, ref: string): string {
  return join(graphLibDir(paths), `${ref}.json`);
}

/** Run journals and blobs, for every graph in the project. */
export function graphStateDir(paths: ProjectPaths): string {
  return join(paths.state, 'graphs');
}

/** One graph's append-only run journal. */
export function graphJournalFile(paths: ProjectPaths, slug: string): string {
  return join(graphStateDir(paths), `${slug}.jsonl`);
}

/**
 * One graph's blobs. They sit beside the journal rather than in either asset root,
 * because what a node hands the node below it is not an asset until an Output node
 * fills a slot with it.
 */
export function graphBlobDir(paths: ProjectPaths, slug: string): string {
  return join(graphStateDir(paths), slug);
}

export function graphBlobFile(paths: ProjectPaths, slug: string, ref: GenBlobRef): string {
  return join(graphBlobDir(paths, slug), `${ref.hash}.${ref.ext}`);
}

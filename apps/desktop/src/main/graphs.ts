/**
 * The graph documents at `vngen/work/graphs/`, as this app reaches them. The reading and
 * writing themselves live in `@vn/gengraph/state`, because the authoring agent loads the same
 * files; what is added here is the summary the document tree lists them by.
 */
import { graphPath, graphSlugs, readGraphDoc } from '@vn/gengraph/state';
import type { GraphSlug } from '@vn/gengraph/state';

export {
  bindGroupLibrary,
  deleteGraphDoc as deleteGraph,
  graphPath,
  graphSlugs,
  isGraphSlug,
  nodeIdOf,
  readGraphDoc as readGraph,
  readGroupDef,
  writeGraphDoc as writeGraph,
  writeGroupDef,
} from '@vn/gengraph/state';
export type { GraphRead, GraphSlug } from '@vn/gengraph/state';

/** One graph as the document tree lists it, without the graph itself being loaded. */
export interface GraphSummary {
  slug: GraphSlug;
  /** Workspace-relative and forward-slashed, which is what `written` reports. */
  path: string;
  /** Why this graph cannot be opened, when something is wrong with the file. */
  problem?: string;
}

/** Every graph the project holds, with an unreadable one carrying its problem. */
export async function listGraphs(root: string): Promise<GraphSummary[]> {
  const out: GraphSummary[] = [];

  for (const slug of await graphSlugs(root)) {
    const read = await readGraphDoc(root, slug);
    out.push({
      slug,
      path: graphPath(root, slug),
      ...(read.ok ? {} : { problem: read.reason }),
    });
  }

  return out;
}

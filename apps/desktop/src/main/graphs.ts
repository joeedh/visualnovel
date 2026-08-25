/**
 * The graph documents at `vngen/work/graphs/`, as this app reaches them. The reading and
 * writing themselves live in `@vn/gengraph/state`, because the authoring agent loads the same
 * files; what is added here is git. A conflicted graph is refused by name, worded the way
 * layout templates word theirs, because both are files git must not merge.
 */
import { graphPath, graphSlugs, graphsDir, readGraphDoc } from '@vn/gengraph/state';
import type { GraphRead, GraphSlug } from '@vn/gengraph/state';
import type { Git } from '@vn/git';
import { ProjectPaths, workspacePath } from '@vn/store';

import { isConflictCode } from './layouts.js';

export {
  bindGroupLibrary,
  deleteGraphDoc as deleteGraph,
  graphPath,
  graphSlugs,
  isGraphSlug,
  nodeIdOf,
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

/** Every graph the project holds, with a conflicted or unreadable one carrying its problem. */
export async function listGraphs(root: string, git?: Git): Promise<GraphSummary[]> {
  const out: GraphSummary[] = [];

  for (const slug of await graphSlugs(root)) {
    const path = graphPath(root, slug);
    const read = await readGraph(root, slug, git);
    out.push({ slug, path, ...(read.ok ? {} : { problem: read.reason }) });
  }

  return out;
}

/** One graph, refused first if git is mid-merge over it and there is no one graph to open. */
export async function readGraph(root: string, slug: GraphSlug, git?: Git): Promise<GraphRead> {
  const path = graphPath(root, slug);
  if ((await conflictedGraphs(root, git)).has(path)) {
    return {
      ok: false,
      reason:
        `${path} is mid-merge, so there is no one graph to open. Pick a side with ` +
        `\`git checkout --ours ${path}\` or \`--theirs\`, then \`git add\` it.`,
    };
  }

  return readGraphDoc(root, slug);
}

/** Which graph paths git is currently reporting as conflicted, workspace-relative. */
async function conflictedGraphs(root: string, git: Git | undefined): Promise<Set<string>> {
  if (!git) return new Set();

  const dir = workspacePath(root, graphsDir(new ProjectPaths(root)));
  try {
    const status = await git.status();
    return new Set(
      status.entries
        .filter((entry) => isConflictCode(entry.x, entry.y) && entry.path.startsWith(`${dir}/`))
        .map((entry) => entry.path),
    );
  } catch {
    return new Set();
  }
}

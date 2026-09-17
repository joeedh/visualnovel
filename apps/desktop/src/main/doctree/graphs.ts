/**
 * Graph documents under `vngen/work/graphs/`, insofar as this app touches them. Reading
 * and writing them lives in `@vn/gengraph/state` and is shared with the authoring agent; what
 * this adds is the summary the document tree lists them by.
 */
import { bindSlots } from '@vn/gengraph';
import type { Graph } from '@vn/gengraph';
import {
  graphPath,
  graphSlugs,
  groupPath,
  groupRefs,
  isGraphSlug,
  readGraphDoc,
  readGroupDoc,
} from '@vn/gengraph/state';
import type { GraphSlug } from '@vn/gengraph/state';

export {
  bindGroupLibrary,
  deleteGraphDoc as deleteGraph,
  graphPath,
  graphSlugs,
  groupPath,
  groupRefs,
  isGraphSlug,
  nextGroupRef,
  nodeIdOf,
  readGraphDoc as readGraph,
  readGroupDef,
  readGroupDoc,
  readGroupLibrary,
  writeGraphDoc as writeGraph,
  writeGroupDef,
} from '@vn/gengraph/state';
export type { GraphRead, GraphSlug, GroupRead } from '@vn/gengraph/state';

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

/** One group definition as a list names it: its ref, its file, and what is wrong with it. */
export interface GroupSummary {
  ref: string;
  path: string;
  problem?: string;
}

/** Every group definition under `lib/`, with an unreadable one carrying its problem. */
export async function listGroups(root: string): Promise<GroupSummary[]> {
  const out: GroupSummary[] = [];

  for (const ref of await groupRefs(root)) {
    const read = await readGroupDoc(root, ref);
    out.push({
      ref,
      path: groupPath(root, ref),
      ...(read.ok ? {} : { problem: read.reason }),
    });
  }

  return out;
}

/** Reports that another graph already draws this slot, through the rule a run binds by. */
export async function claimOf(
  root: string,
  slugs: readonly GraphSlug[],
  slot: string,
): Promise<string | undefined> {
  const loaded: { slug: GraphSlug; graph: Graph }[] = [];
  for (const slug of slugs) {
    const read = await readGraphDoc(root, slug);
    // An unreadable graph is reported where it is listed; what it claims cannot be read here.
    if (read.ok) loaded.push({ slug, graph: read.graph });
  }

  const { bound, conflicts } = bindSlots(loaded);
  const owner = bound.get(slot);
  if (owner !== undefined) return `the ${owner.entry.slug} graph already draws ${slot}`;
  if (conflicts.includes(slot)) {
    return `more than one graph already claims ${slot}, so that slot is bound to none of them`;
  }
  return undefined;
}

/** Turns a slot address or any other phrase into a graph name, replacing what a name cannot carry. */
export function slugOfName(said: string): string {
  const slug = said
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return isGraphSlug(slug) ? slug : 'graph';
}

/** The first of `base`, `base-2`, `base-3` that no graph file already carries. */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

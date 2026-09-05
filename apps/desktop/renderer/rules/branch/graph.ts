/**
 * Projecting a `StoryGraph` into the neutral shapes `renderer/graph/` lays out.
 *
 * The inverse is `scenesOf`, which rebuilds each scene's `choices`/`next` from the edges being
 * drawn so a drop can be judged mid-drag by the real `branchops`. It lives in
 * `src/shared/interactions.ts` with the gestures that need it.
 */
import type { StoryGraph } from '../../../src/shared/ipc';
import type { Graph } from '../../graph/types.js';

/**
 * Cards are one size. Layout never measures, so a size that varied with the synopsis would
 * either need a measurement pass or a guess at line wrapping; a fixed card clamps its prose
 * instead, and the ranks stay aligned.
 */
export const CARD = { width: 194, height: 96 };

/** A `goto` with no scene behind it: smaller, and never a drop target. */
export const STUB = { width: 150, height: 48 };

export interface BranchGraph {
  graph: Graph;
  /** Ids that appear only as an edge target — every one of them is a dangling `goto`. */
  stubs: Set<string>;
}

/** Scenes and edges as nodes and wires, with a stub node standing in for each dangling goto. */
export function branchGraph(story: StoryGraph): BranchGraph {
  const real = new Set(story.scenes.map((s) => s.id));
  const stubs = new Set<string>();
  for (const edge of story.edges) if (!real.has(edge.to)) stubs.add(edge.to);

  return {
    stubs,
    graph: {
      nodes: [
        ...story.scenes.map((s) => ({ id: s.id, ...CARD })),
        ...[...stubs].map((id) => ({ id, ...STUB })),
      ],
      edges: story.edges.map((e) => ({
        id  : e.id,
        from: e.from,
        to  : e.to,
        kind: e.inert ? 'inert' : e.kind,
        ...(e.label !== undefined ? { label: e.label } : {}),
      })),
    },
  };
}

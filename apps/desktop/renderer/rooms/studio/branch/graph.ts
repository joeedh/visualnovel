/**
 * Projecting a `StoryGraph` into the neutral shapes `renderer/graph/` lays out — and back.
 *
 * The inverse (`scenesOf`) is the load-bearing half. It rebuilds each scene's `choices`/`next`
 * from the edges the view is drawing, so the editor can ask the *real* `branchops` whether a
 * drop would be accepted while the pointer is still down. Without it the drag would have to
 * carry its own copy of the splice rules, and a copy is a thing that can disagree.
 */
import type { SceneMap } from '../../../../src/shared/branchops';
import type { StoryEdge, StoryGraph } from '../../../../src/shared/ipc';
import type { Graph } from '../../../graph/types.js';

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
        id: e.id,
        from: e.from,
        to: e.to,
        kind: e.inert ? 'inert' : e.kind,
        ...(e.label !== undefined ? { label: e.label } : {}),
      })),
    },
  };
}

/**
 * The branch structure the graph describes, back in `Scene` terms. Choice order comes from
 * `StoryEdge.index` rather than array position, so it is the same index the command takes.
 */
export function scenesOf(story: StoryGraph): SceneMap {
  const scenes = new Map<string, { id: string; choices: { label: string; goto: string }[] }>();
  for (const scene of story.scenes) scenes.set(scene.id, { id: scene.id, choices: [] });

  const nexts = new Map<string, string>();
  const choices = new Map<string, { index: number; label: string; goto: string }[]>();
  for (const edge of story.edges) {
    if (!scenes.has(edge.from)) continue;
    if (edge.kind === 'next') nexts.set(edge.from, edge.to);
    else {
      const list = choices.get(edge.from) ?? [];
      list.push({ index: edge.index ?? list.length, label: edge.label ?? '', goto: edge.to });
      choices.set(edge.from, list);
    }
  }

  const out = new Map<string, { id: string; choices: { label: string; goto: string }[] }>();
  for (const [id, scene] of scenes) {
    const list = (choices.get(id) ?? [])
      .sort((a, b) => a.index - b.index)
      .map(({ label, goto }) => ({ label, goto }));
    const next = nexts.get(id);
    out.set(id, { ...scene, choices: list, ...(next !== undefined ? { next } : {}) });
  }
  return out;
}

/** The `story.spliceScene` arguments that address an edge. A `next` edge has no index. */
export const edgeTarget = (edge: StoryEdge): { from: string; edge?: number } => ({
  from: edge.from,
  ...(edge.kind === 'choice' && edge.index !== undefined ? { edge: edge.index } : {}),
});

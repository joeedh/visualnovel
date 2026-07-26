/**
 * The task DAG, derived from a `PipelineStatus`. Everything the graph view draws that is *not*
 * literally in `Task[]` is computed here, in pure functions, because all three of those things
 * are inferences and an inference the app cannot test is one it should not draw.
 *
 * There are exactly three of them:
 *
 * 1. **The gate is not an edge.** It is a planner predicate (`sceneUnblocked`), so a blocked run
 *    has no edge explaining itself. A synthetic barrier node is inserted, and ranking-only edges
 *    force everything it holds up *below* it.
 * 2. **`deps` understates coupling.** A `shot_image` lists only its location plate as a dep; the
 *    subject portraits reach it through `inputs.refs`. Both are drawn — deps solid, resolved
 *    refs dashed.
 * 3. **The graph is deliberately partial.** Planning is incremental, so work that is not yet
 *    plannable is simply absent. Ghost clusters stand in for it, so an empty region reads as
 *    "not yet" rather than "nothing to do".
 */
import type { PipelineStatus, StoryGraph, Task } from '../../../src/shared/ipc';
import type { Graph, GraphEdge, GraphNode } from '../../graph/types.js';

/** One size for tasks and ghosts, so the two never misalign within a rank. */
export const TASK_NODE = { width: 178, height: 46 };
/** The barrier reserves a rank of its own; the rule itself is drawn across the layout bounds. */
export const BARRIER_NODE = { width: 268, height: 34 };
export const BARRIER_ID = 'gate:barrier';

/** What a node in the task graph stands for — the view renders one shape per member. */
export type TaskNodeView =
  | { kind: 'task'; id: string; task: Task; subject: string }
  | { kind: 'ghost'; id: string; ghost: Ghost }
  | { kind: 'barrier'; id: string; pending: string[] };

/**
 * A cluster of work the planner cannot emit yet. Deliberately *not* individually addressable:
 * shot counts come from `decomposeScene`, which is LLM-backed with a deterministic fallback, so
 * `count` is an estimate and a node per estimated shot would be a promise the run may not keep.
 */
export interface Ghost {
  id: string;
  /** What the cluster is, in the view's words — "arrival · shots". */
  label: string;
  /** Approximate node count, when the baseline decomposition makes one derivable. */
  count?: number;
  /** Task hashes this work will hang off once it exists. */
  after: string[];
  /** Held up by the character-approval gate, as opposed to merely not run yet. */
  gated: boolean;
}

export interface TaskGraphModel {
  /** Nodes plus *ranking* edges — what `layoutGraph` is given. */
  graph: Graph;
  /** The edges actually drawn. A subset of `graph.edges`: the barrier's are structural only. */
  edges: GraphEdge[];
  nodes: Map<string, TaskNodeView>;
  ghosts: Ghost[];
  /** Present only while the gate holds something up. */
  barrier: { pending: string[]; below: Set<string> } | null;
}

/** The human-facing subject of a task: what it is *of*, as opposed to what kind it is. */
export function subjectOf(task: Task): string {
  const inputs = task.inputs;
  if ('shotId' in inputs) return inputs.shotId;
  if ('characterId' in inputs) {
    return 'angle' in inputs
      ? `${inputs.characterId} · ${inputs.outfit}/${inputs.angle}`
      : inputs.characterId;
  }
  if ('locationId' in inputs) return `${inputs.locationId} · ${inputs.variant}`;
  if ('target' in inputs) return inputs.target;
  return '';
}

/** Shot ids are namespaced `<sceneId>__<raw>` by `shotId()`, which is the only scene link. */
const sceneOfShot = (shotId: string): string => shotId.split('__')[0] ?? shotId;

const refsOf = (task: Task): readonly { hash: string }[] =>
  'refs' in task.inputs ? task.inputs.refs : [];

/**
 * The dashed half of the edge set: an input reference resolved back to the task that produced
 * it. A ref with no producing task is skipped rather than drawn to nowhere — an author-supplied
 * reference image is exactly that case and is not a graph edge at all. A ref that is *also* a
 * dep is skipped too, so the pair renders once, solid: the scheduler orders on it.
 */
export function buildRefEdges(tasks: readonly Task[]): GraphEdge[] {
  const producer = new Map<string, string>();
  for (const task of tasks) if (task.output) producer.set(task.output, task.hash);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const deps = new Set(task.deps);
    for (const ref of refsOf(task)) {
      const from = producer.get(ref.hash);
      if (!from || from === task.hash || deps.has(from)) continue;
      const id = `ref:${from}->${task.hash}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, from, to: task.hash, kind: 'ref' });
    }
  }
  return edges;
}

/** Dependency edges, dropping any whose upstream is not in the graph (a pruned earlier run). */
export function buildDepEdges(tasks: readonly Task[]): GraphEdge[] {
  const present = new Set(tasks.map((t) => t.hash));
  const edges: GraphEdge[] = [];
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!present.has(dep) || dep === task.hash) continue;
      edges.push({ id: `dep:${dep}->${task.hash}`, from: dep, to: task.hash, kind: 'dep' });
    }
  }
  return edges;
}

/**
 * Work the planner has not emitted yet, as one cluster per scene (shots) and per gate-pending
 * character (model sheets). The shot estimate is the deterministic baseline — one establishing
 * shot plus one per character — which is a floor, not a promise; the sheet count is left off
 * entirely because outfits are not visible from here and a wrong number is worse than none.
 */
export function ghostsFor(status: PipelineStatus, story: StoryGraph | null): Ghost[] {
  if (!story) return [];
  const pending = new Set(status.gatePending);

  const scenesWithShots = new Set<string>();
  const charactersWithSheets = new Set<string>();
  const platesFor = new Map<string, string[]>();
  const portraitOf = new Map<string, string>();
  for (const task of status.tasks) {
    const inputs = task.inputs;
    if ('shotId' in inputs) scenesWithShots.add(sceneOfShot(inputs.shotId));
    else if (task.kind === 'location_ref' && 'locationId' in inputs) {
      platesFor.set(inputs.locationId, [...(platesFor.get(inputs.locationId) ?? []), task.hash]);
    } else if (task.kind === 'portrait' && 'characterId' in inputs) {
      portraitOf.set(inputs.characterId, task.hash);
    } else if (task.kind === 'model_sheet' && 'characterId' in inputs) {
      charactersWithSheets.add(inputs.characterId);
    }
  }

  const ghosts: Ghost[] = [];
  for (const character of status.gatePending) {
    if (charactersWithSheets.has(character)) continue;
    const portrait = portraitOf.get(character);
    ghosts.push({
      id: `ghost:sheets:${character}`,
      label: `${character} · model sheets`,
      after: portrait ? [portrait] : [],
      gated: true,
    });
  }

  for (const scene of story.scenes) {
    if (!scene.reachable || scenesWithShots.has(scene.id)) continue;
    ghosts.push({
      id: `ghost:shots:${scene.id}`,
      label: `${scene.id} · shots`,
      count: 1 + scene.characters.length,
      after: platesFor.get(scene.location) ?? [],
      gated: scene.characters.some((c) => pending.has(c)),
    });
  }
  return ghosts;
}

/**
 * The synthetic gate barrier: who it is waiting on, and every node it holds up. Ghosts declare
 * their own `gated` flag; a real task lands below the line only in the case that flag cannot
 * cover — a shot whose subject was un-approved after it was planned.
 */
export function barrierFor(
  status: PipelineStatus,
  story: StoryGraph | null,
  ghosts: readonly Ghost[],
): { pending: string[]; below: Set<string> } | null {
  if (status.gatePending.length === 0) return null;
  const pending = new Set(status.gatePending);
  const cast = new Map((story?.scenes ?? []).map((s) => [s.id, s.characters]));

  const below = new Set<string>();
  for (const ghost of ghosts) if (ghost.gated) below.add(ghost.id);
  for (const task of status.tasks) {
    if (!('shotId' in task.inputs)) continue;
    const characters = cast.get(sceneOfShot(task.inputs.shotId)) ?? [];
    if (characters.some((c) => pending.has(c))) below.add(task.hash);
  }
  return { pending: [...status.gatePending], below };
}

/**
 * Compose the whole view model. The layout graph carries ranking-only edges into and out of the
 * barrier — every node above it points at it, and it points at every node it blocks — which is
 * what makes "blocked work is beneath the line" true of the layout rather than of a guess about
 * where to draw the line. Those edges are never routed; `edges` is the drawn set.
 */
export function taskGraphOf(status: PipelineStatus, story: StoryGraph | null): TaskGraphModel {
  const ghosts = ghostsFor(status, story);
  const barrier = barrierFor(status, story, ghosts);

  const nodes = new Map<string, TaskNodeView>();
  const boxes: GraphNode[] = [];
  for (const task of status.tasks) {
    nodes.set(task.hash, { kind: 'task', id: task.hash, task, subject: subjectOf(task) });
    boxes.push({ id: task.hash, ...TASK_NODE });
  }
  for (const ghost of ghosts) {
    nodes.set(ghost.id, { kind: 'ghost', id: ghost.id, ghost });
    boxes.push({ id: ghost.id, ...TASK_NODE });
  }

  const edges: GraphEdge[] = [
    ...buildDepEdges(status.tasks),
    ...buildRefEdges(status.tasks),
    ...ghosts.flatMap((ghost) =>
      ghost.after.map((from) => ({
        id: `ghost:${from}->${ghost.id}`,
        from,
        to: ghost.id,
        kind: 'ghost',
      })),
    ),
  ];

  const ranking: GraphEdge[] = [];
  if (barrier) {
    nodes.set(BARRIER_ID, { kind: 'barrier', id: BARRIER_ID, pending: barrier.pending });
    boxes.push({
      id: BARRIER_ID,
      ...BARRIER_NODE,
      width: BARRIER_NODE.width + Math.max(0, barrier.pending.length - 1) * 96,
    });
    for (const box of boxes) {
      if (box.id === BARRIER_ID) continue;
      const gated = barrier.below.has(box.id);
      ranking.push(
        gated
          ? { id: `gate>${box.id}`, from: BARRIER_ID, to: box.id }
          : { id: `gate<${box.id}`, from: box.id, to: BARRIER_ID },
      );
    }
  }

  return { graph: { nodes: boxes, edges: [...edges, ...ranking] }, edges, nodes, ghosts, barrier };
}

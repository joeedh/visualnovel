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
 * 3. **A slot and the task that fills it are one picture.** `status.slots` is every picture the
 *    project implies; `status.tasks` is only what was plannable at the last wave. Where a slot
 *    has a task the planner actually emitted, the two collapse into a single node keyed by the
 *    task hash — otherwise the future would be drawn twice, once as a promise and once as work.
 *    An unplanned slot is an addressable picture with a real name, so nothing here estimates.
 */
import type { PipelineStatus, SlotNode, StoryGraph, Task } from '../../src/shared/ipc';
import type { Graph, GraphEdge, GraphNode } from '../graph/types.js';

/** One size for tasks and slots, so the two never misalign within a rank. */
export const TASK_NODE = { width: 178, height: 46 };
/** The barrier reserves a rank of its own; the rule itself is drawn across the layout bounds. */
export const BARRIER_NODE = { width: 268, height: 34 };
export const BARRIER_ID = 'gate:barrier';

/** What a node in the task graph stands for — the view renders one shape per member. */
export type TaskNodeView =
  | { kind: 'task'; id: string; task: Task; subject: string }
  | { kind: 'slot'; id: string; slot: SlotNode }
  | { kind: 'barrier'; id: string; pending: string[] };

/** A slot drawn as itself gets a node id of its own, so it can never collide with a task hash. */
export const slotNodeId = (key: string): string => `slot:${key}`;

export interface TaskGraphModel {
  /** Nodes plus *ranking* edges — what `layoutGraph` is given. */
  graph: Graph;
  /** The edges actually drawn. A subset of `graph.edges`: the barrier's are structural only. */
  edges: GraphEdge[];
  nodes: Map<string, TaskNodeView>;
  /** The slots drawn as themselves — pictures the project implies that nothing has planned. */
  unplanned: SlotNode[];
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
 * Where each slot is drawn: its task's hash when the planner has actually emitted that task,
 * otherwise a `slot:` id of its own. A slot carrying a `taskHash` the graph has never seen is
 * still unplanned — the identity is computable from the project, which is not the same as work
 * having been filed for it.
 */
export function slotNodeIds(status: PipelineStatus): Map<string, string> {
  const planned = new Set(status.tasks.map((t) => t.hash));
  return new Map(
    status.slots.map((slot) => [
      slot.key,
      slot.taskHash && planned.has(slot.taskHash) ? slot.taskHash : slotNodeId(slot.key),
    ]),
  );
}

/**
 * The edges the slot graph knows and `deps`/`refs` cannot: what a picture will be drawn from,
 * before either end of it exists. A ref naming a slot outside the graph — an authored
 * `asset:<hash>` pin — is skipped rather than drawn to nowhere, exactly as `buildRefEdges` skips
 * an author-supplied image. A pair already carrying a dep or ref edge is skipped too, so a
 * coupling the planner has filed renders once, as the firmer of the two.
 */
export function buildSlotEdges(status: PipelineStatus, drawn: readonly GraphEdge[]): GraphEdge[] {
  const ids = slotNodeIds(status);
  const seen = new Set(drawn.map((e) => `${e.from}|${e.to}`));
  const edges: GraphEdge[] = [];
  for (const slot of status.slots) {
    const to = ids.get(slot.key);
    for (const ref of slot.refs) {
      const from = ids.get(ref);
      if (!from || !to || from === to || seen.has(`${from}|${to}`)) continue;
      seen.add(`${from}|${to}`);
      edges.push({ id: `slot:${from}->${to}`, from, to, kind: 'slot' });
    }
  }
  return edges;
}

/**
 * The synthetic gate barrier: who it is waiting on, and every node it holds up.
 *
 * A slot is held up when a portrait the gate is still pending sits anywhere upstream of it — which
 * is the gate predicate stated as reachability rather than guessed at per kind, and it is why the
 * sheets and shots of a pending character land below the line without either being named here. A
 * pending portrait is not below its own gate: it is the work the gate is waiting for.
 *
 * A real task lands below only in the case that walk cannot cover — a shot planned while its
 * subject was approved, whose approval was withdrawn afterwards. That one still reads the cast off
 * the story graph, because the task's own inputs no longer agree with the model.
 */
export function barrierFor(
  status: PipelineStatus,
  story: StoryGraph | null,
): { pending: string[]; below: Set<string> } | null {
  if (status.gatePending.length === 0) return null;
  const pending = new Set(status.gatePending);
  const cast = new Map((story?.scenes ?? []).map((s) => [s.id, s.characters]));
  const ids = slotNodeIds(status);

  // `slots` arrives in `SlotGraph.order`, upstream first, so one forward pass closes the walk.
  const gated = new Set<string>();
  const seeds = new Set(status.gatePending.map((c) => `portrait:${c}`));
  const below = new Set<string>();
  for (const slot of status.slots) {
    if (seeds.has(slot.key)) {
      gated.add(slot.key);
      continue;
    }
    if (!slot.refs.some((ref) => gated.has(ref))) continue;
    gated.add(slot.key);
    const id = ids.get(slot.key);
    if (id) below.add(id);
  }

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
  const barrier = barrierFor(status, story);
  const ids = slotNodeIds(status);
  const unplanned = status.slots.filter((slot) => ids.get(slot.key) === slotNodeId(slot.key));

  const nodes = new Map<string, TaskNodeView>();
  const boxes: GraphNode[] = [];
  for (const task of status.tasks) {
    nodes.set(task.hash, { kind: 'task', id: task.hash, task, subject: subjectOf(task) });
    boxes.push({ id: task.hash, ...TASK_NODE });
  }
  for (const slot of unplanned) {
    const id = slotNodeId(slot.key);
    nodes.set(id, { kind: 'slot', id, slot });
    boxes.push({ id, ...TASK_NODE });
  }

  const planned = [...buildDepEdges(status.tasks), ...buildRefEdges(status.tasks)];
  const edges: GraphEdge[] = [...planned, ...buildSlotEdges(status, planned)];

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

  return {
    graph: { nodes: boxes, edges: [...edges, ...ranking] },
    edges,
    nodes,
    unplanned,
    barrier,
  };
}

/**
 * The task DAG, derived from a `PipelineStatus`. Everything the graph view draws that is not
 * literally in `Task[]` is computed here, in pure functions, so each inference is testable.
 *
 * There are exactly three of them:
 *
 * 1. The gate is not an edge. It is a planner predicate (`sceneUnblocked`), so a blocked run has
 *    no edge explaining itself. A synthetic barrier node is inserted, and ranking-only edges
 *    force everything it holds up below it.
 * 2. `deps` understates coupling. A `shot_image` lists only its location plate as a dep; the
 *    subject portraits reach it through `inputs.refs`. Both are drawn — deps solid, resolved
 *    refs dashed.
 * 3. A slot and the task that fills it are drawn as one node. `status.slots` is every picture the
 *    project implies; `status.tasks` is only what was plannable at the last wave. Where a slot
 *    has a task the planner actually emitted, the two collapse into a single node keyed by the
 *    task hash, rather than drawing the same future twice — once as a promise and once as work.
 *    An unplanned slot is an addressable picture with a real name, so nothing here estimates.
 */
import type { PipelineStatus, SlotNode, StoryGraph, Task, TaskStatus } from '../../src/shared/ipc';
import type { Graph, GraphEdge, GraphNode } from '../graph/types.js';

/** One size for tasks and slots, so the two never misalign within a rank. */
export const TASK_NODE = { width: 178, height: 46 };
/** The barrier reserves a rank of its own; the rule itself is drawn across the layout bounds. */
export const BARRIER_NODE = { width: 268, height: 34 };
export const BARRIER_ID = 'gate:barrier';
/** A cluster carries a line of counts the other kinds do not, so it is the taller box. */
export const CLUSTER_NODE = { width: 196, height: 62 };

/** What a node in the task graph stands for — the view renders one shape per member. */
export type TaskNodeView =
  | { kind: 'task'; id: string; task: Task; subject: string }
  | { kind: 'slot'; id: string; slot: SlotNode }
  | { kind: 'barrier'; id: string; pending: string[] };

/** What a cluster is of. `other` is the bucket for a task that names no subject at all. */
export type ClusterKind = 'scene' | 'char' | 'loc' | 'other';

/**
 * Every task and slot with one subject, drawn as a single box. The overview is built from these
 * rather than from tasks: a portrait referenced by thirty shots puts all thirty in one rank, and
 * the picture is then too wide to read at any zoom that still shows a node.
 */
export interface ClusterNodeView {
  kind: 'cluster';
  /** `<ClusterKind>:<subject>` — what `clusterMembers` takes back to open it. */
  id: string;
  group: ClusterKind;
  label: string;
  /** How many members are in each task state. */
  counts: Record<TaskStatus, number>;
  /** Members that are slots: pictures the project implies that nothing has planned. */
  unplanned: number;
  members: number;
}

/** Every shape a node in a drawn graph can take. */
export type GraphNodeView = TaskNodeView | ClusterNodeView;

/** A slot drawn as itself gets a node id of its own, so it can never collide with a task hash. */
export const slotNodeId = (key: string): string => `slot:${key}`;

export interface TaskGraphModel {
  /** Nodes plus ranking edges — what `layoutGraph` is given. */
  graph: Graph;
  /** The edges actually drawn: a subset of `graph.edges`, since the barrier's are structural. */
  edges: GraphEdge[];
  nodes: Map<string, GraphNodeView>;
  /** The slots drawn as themselves — pictures the project implies that nothing has planned. */
  unplanned: SlotNode[];
  /** Present only while the gate holds something up. */
  barrier: { pending: string[]; below: Set<string> } | null;
}

/** The human-facing subject of a task: what it is of, as opposed to what kind it is. */
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
 * reference image is exactly that case and is not a graph edge at all. A ref that is also a dep
 * is skipped, so the pair renders once as the solid dep edge the scheduler orders on.
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
 * The node id each slot is drawn at. A slot whose task the planner has actually emitted is drawn
 * at that task's hash; every other slot gets a `slot:` id of its own. A slot carrying a
 * `taskHash` the graph has never seen is still unplanned — the identity is computable from the
 * project, which is not the same as work having been filed for it.
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
 * before either end of it exists. A ref naming a slot outside the graph (an authored
 * `asset:<hash>` pin) is skipped rather than drawn to nowhere, exactly as `buildRefEdges` skips
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
 * A slot is held up when a portrait the gate is still pending sits upstream of it. The gate
 * predicate is stated as reachability rather than guessed at per kind, so the sheets and the shots
 * of a pending character land below the line without being named here. A pending portrait is not
 * below its own gate: it is the work the gate is waiting for.
 *
 * A real task lands below only in the case the slot walk cannot cover — a shot planned while its
 * subject was approved, whose approval was withdrawn afterwards. For that case the cast is read
 * off the story graph, because the task's own inputs no longer agree with the model.
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

/** The barrier's box, which grows so each further pending character's button fits on it. */
const barrierBox = (pending: readonly string[]): GraphNode => ({
  id: BARRIER_ID,
  ...BARRIER_NODE,
  width: BARRIER_NODE.width + Math.max(0, pending.length - 1) * 96,
});

/** A ranking-only edge placing one node above or below the barrier. Never routed. */
const rankingEdge = (id: string, gated: boolean): GraphEdge =>
  gated
    ? { id: `gate>${id}`, from: BARRIER_ID, to: id }
    : { id: `gate<${id}`, from: id, to: BARRIER_ID };

/**
 * Composes the whole view model. The layout graph carries ranking-only edges into and out of the
 * barrier: every node above it points at it, and it points at every node it blocks, so blocked
 * work sits beneath the line in the layout itself rather than at a guessed cutoff. Those edges are
 * never routed; `edges` is the drawn set.
 */
export function taskGraphOf(status: PipelineStatus, story: StoryGraph | null): TaskGraphModel {
  const barrier = barrierFor(status, story);
  const ids = slotNodeIds(status);
  const unplanned = status.slots.filter((slot) => ids.get(slot.key) === slotNodeId(slot.key));

  const nodes = new Map<string, GraphNodeView>();
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
    boxes.push(barrierBox(barrier.pending));
    for (const box of boxes) {
      if (box.id === BARRIER_ID) continue;
      ranking.push(rankingEdge(box.id, barrier.below.has(box.id)));
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

const zeroCounts = (): Record<TaskStatus, number> => ({
  pending    : 0,
  running    : 0,
  done       : 0,
  failed     : 0,
  needs_human: 0,
});

/** Which coupling survives when a cluster pair carries more than one edge between its members. */
const FIRMNESS: Record<string, number> = { dep: 3, ref: 2, slot: 1 };

/**
 * The cluster a node belongs to. The barrier belongs to none, and neither does a cluster itself.
 *
 * A task and a slot are read from different fields — `task.inputs` and `slot.binding` — so nothing
 * here is shared with `subjectOf` or with the editor's `pickSlot`.
 */
export function clusterKeyOf(view: GraphNodeView): string | null {
  if (view.kind === 'task') {
    const inputs = view.task.inputs;
    if ('shotId' in inputs) return `scene:${sceneOfShot(inputs.shotId)}`;
    if ('characterId' in inputs) return `char:${inputs.characterId}`;
    if ('locationId' in inputs) return `loc:${inputs.locationId}`;
    // A review or a refinement is about one task rather than about a subject, so it stands alone.
    return `other:${view.task.hash}`;
  }
  if (view.kind === 'slot') {
    const binding = view.slot.binding;
    if (binding.kind === 'shot') return `scene:${binding.sceneId}`;
    if (binding.kind === 'portrait' || binding.kind === 'sheet') {
      return `char:${binding.characterId}`;
    }
    if (binding.kind === 'plate') return `loc:${binding.locationId}`;
    // `buildSlotGraph` never emits an `asset` binding, so no real slot reaches this line.
    return `other:${view.slot.key}`;
  }
  return null;
}

const groupOf = (clusterId: string): ClusterKind =>
  clusterId.slice(0, clusterId.indexOf(':')) as ClusterKind;

/** The subject a cluster is named by. An `other:` cluster is named by its one member instead. */
function clusterLabel(clusterId: string, view: GraphNodeView): string {
  if (groupOf(clusterId) !== 'other') return clusterId.slice(clusterId.indexOf(':') + 1);
  if (view.kind === 'task') return view.subject || view.task.kind;
  return view.kind === 'slot' ? view.slot.label : clusterId;
}

/**
 * The overview: one box per scene, character and location, with the edges between them.
 *
 * Cluster ids and cluster edges are both emitted in sorted order rather than in the order the
 * members were walked, because `layoutGraph` promises the same graph draws the same picture and
 * its input order is part of the graph.
 *
 * A cluster ranks below the barrier when any of its members does. The one exception is a
 * gate-pending character's own cluster, which is given no ranking edge at all: it holds both the
 * portrait the gate is waiting for (above the line) and the sheets drawn from it (below), so
 * neither side is the truth about the cluster as a whole.
 */
export function clusteredGraphOf(model: TaskGraphModel): TaskGraphModel {
  const clusterOf = new Map<string, string>();
  const clusters = new Map<string, ClusterNodeView>();
  const gated = new Set<string>();

  for (const [id, view] of model.nodes) {
    const key = clusterKeyOf(view);
    if (!key) continue;
    clusterOf.set(id, key);
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = {
        kind     : 'cluster',
        id       : key,
        group    : groupOf(key),
        label    : clusterLabel(key, view),
        counts   : zeroCounts(),
        unplanned: 0,
        members  : 0,
      };
      clusters.set(key, cluster);
    }
    cluster.members++;
    if (view.kind === 'task') cluster.counts[view.task.status]++;
    else cluster.unplanned++;
    if (model.barrier?.below.has(id)) gated.add(key);
  }

  const ids = [...clusters.keys()].sort();
  const nodes = new Map<string, GraphNodeView>();
  const boxes: GraphNode[] = [];
  for (const id of ids) {
    nodes.set(id, clusters.get(id) as ClusterNodeView);
    boxes.push({ id, ...CLUSTER_NODE });
  }

  const firmest = new Map<string, GraphEdge>();
  for (const edge of model.edges) {
    const from = clusterOf.get(edge.from);
    const to = clusterOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const id = `cluster:${from}->${to}`;
    const held = firmest.get(id);
    if (held && (FIRMNESS[held.kind ?? ''] ?? 0) >= (FIRMNESS[edge.kind ?? ''] ?? 0)) continue;
    firmest.set(id, { id, from, to, kind: edge.kind });
  }
  const edges = [...firmest.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const ranking: GraphEdge[] = [];
  const barrier = model.barrier;
  if (barrier) {
    nodes.set(BARRIER_ID, { kind: 'barrier', id: BARRIER_ID, pending: barrier.pending });
    boxes.push(barrierBox(barrier.pending));
    const mixed = new Set(barrier.pending.map((character) => `char:${character}`));
    for (const id of ids) {
      if (mixed.has(id)) continue;
      ranking.push(rankingEdge(id, gated.has(id)));
    }
  }

  return {
    graph: { nodes: boxes, edges: [...edges, ...ranking] },
    edges,
    nodes,
    unplanned: model.unplanned,
    barrier,
  };
}

/**
 * One scope of the task graph, at task granularity: the kept nodes, the edges with both ends among
 * them, and the barrier only where the caller says the scope has anything to do with the gate.
 */
function scopedView(
  model: TaskGraphModel,
  keep: ReadonlySet<string>,
  withBarrier: boolean,
): TaskGraphModel {
  const nodes = new Map<string, GraphNodeView>();
  const boxes: GraphNode[] = [];
  const unplanned: SlotNode[] = [];
  for (const [id, view] of model.nodes) {
    if (!keep.has(id)) continue;
    nodes.set(id, view);
    boxes.push({ id, ...TASK_NODE });
    if (view.kind === 'slot') unplanned.push(view.slot);
  }

  const edges = model.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));

  const ranking: GraphEdge[] = [];
  const barrier = withBarrier ? model.barrier : null;
  if (barrier) {
    nodes.set(BARRIER_ID, { kind: 'barrier', id: BARRIER_ID, pending: barrier.pending });
    boxes.push(barrierBox(barrier.pending));
    for (const box of boxes) {
      if (box.id === BARRIER_ID) continue;
      ranking.push(rankingEdge(box.id, barrier.below.has(box.id)));
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

/** What one cluster holds, laid out as tasks and slots again. Empty for a cluster that is gone. */
export function clusterMembers(model: TaskGraphModel, clusterId: string): TaskGraphModel {
  const keep = new Set<string>();
  for (const [id, view] of model.nodes) if (clusterKeyOf(view) === clusterId) keep.add(id);
  return scopedView(model, keep, false);
}

/** Whether a node is a portrait the gate is still waiting on: the work the gate is about. */
function isGateSeed(view: GraphNodeView, pending: ReadonlySet<string>): boolean {
  if (view.kind === 'task') {
    const inputs = view.task.inputs;
    return (
      view.task.kind === 'portrait' && 'characterId' in inputs && pending.has(inputs.characterId)
    );
  }
  if (view.kind === 'slot') {
    const binding = view.slot.binding;
    return binding.kind === 'portrait' && pending.has(binding.characterId);
  }
  return false;
}

/**
 * Everything one picture is drawn from: `targetId` plus its ancestors, walked backwards over the
 * drawn edges. The barrier's ranking edges are not walked — they are not in `model.edges` — and the
 * barrier is drawn only when the target is held up by the gate or is what the gate is waiting for,
 * so a picture with nothing to do with the gate does not gain a rule it has no relationship to.
 */
export function subgraphFor(model: TaskGraphModel, targetId: string): TaskGraphModel {
  const target = model.nodes.get(targetId);
  if (!target) return scopedView(model, new Set(), false);

  const sources = new Map<string, string[]>();
  for (const edge of model.edges) {
    sources.set(edge.to, [...(sources.get(edge.to) ?? []), edge.from]);
  }

  const keep = new Set([targetId]);
  const queue = [targetId];
  for (let i = 0; i < queue.length; i++) {
    for (const from of sources.get(queue[i] as string) ?? []) {
      if (keep.has(from)) continue;
      keep.add(from);
      queue.push(from);
    }
  }

  const barrier = model.barrier;
  const concerns =
    barrier !== null &&
    (barrier.below.has(targetId) || isGateSeed(target, new Set(barrier.pending)));
  return scopedView(model, keep, concerns);
}

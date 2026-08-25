/**
 * Commands over the generation graphs at `vngen/work/graphs/`. A graph is an authored document
 * like a scene, so it has one write path and this is it: `doc.*` refuses the directory, and every
 * mutation here goes through `decideGenEdit`, which is the same rule the authoring agent's graph
 * tool runs. A refusal therefore reads identically in both hosts.
 *
 * Two props are strings that carry something richer. `gengraph.setProp` takes its value as text
 * and lets the node's own property decide how to read it, and `gengraph.apply` takes a whole DSL
 * description as text and parses it. Neither is a design choice about graphs: `@vn/commands` has
 * no JSON prop kind, and the string DSL a command is typed in is text throughout.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import { Graph, decideGenEdit, estimateSentence, readGenPropValue } from '@vn/gengraph';
import type { GenApplied, GenEdit, GenPricedEstimate, GraphId } from '@vn/gengraph';
import {
  deleteGraph,
  isGraphSlug,
  listGraphs,
  nodeIdOf,
  readGraph,
  writeGraph,
} from '../graphs.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** What a command builds from the graph it is about to edit, or the sentence refusing it. */
type EditPlan = GenEdit | { refuse: string };

type Decided =
  | { ok: false; reason: string }
  | { ok: true; note: string; graph: Graph; apply: () => GenApplied };

/**
 * Reads the graph and decides one edit against it. Nothing is written, so a `check` and the `run`
 * beside it call this and get the same answer.
 */
async function decide(
  ctx: { root: string; git: Parameters<typeof readGraph>[2] },
  slug: string,
  plan: (graph: Graph) => EditPlan,
): Promise<Decided> {
  const read = await readGraph(ctx.root, slug, ctx.git);
  if (!read.ok) return { ok: false, reason: read.reason };

  const edit = plan(read.graph);
  if ('refuse' in edit) return { ok: false, reason: edit.refuse };

  const decided = decideGenEdit(read.graph, edit);
  if (!decided.ok) return { ok: false, reason: decided.reason };
  return { ok: true, note: decided.note, graph: read.graph, apply: decided.apply };
}

function verdict(decided: Decided): CheckResult {
  return decided.ok ? { ok: true, note: decided.note } : { ok: false, reason: decided.reason };
}

/** Decides an edit, writes what it produced, and reports the sentence the decision carried. */
async function edit(
  ctx: { root: string; git: Parameters<typeof readGraph>[2] },
  slug: string,
  plan: (graph: Graph) => EditPlan,
): Promise<{ message: string; data: { node?: GraphId }; written: string[] }> {
  const decided = await decide(ctx, slug, plan);
  if (!decided.ok) throw new Error(decided.reason);

  const applied = decided.apply();
  const path = await writeGraph(ctx.root, slug, applied.graph);
  return {
    message: decided.note,
    data: applied.node === undefined ? {} : { node: applied.node },
    written: [path],
  };
}

const SLUG = 'which graph, by the name its file carries';
const NODE = 'the id of the node, as the graph lists it';

export const gengraphList = define({
  id: 'gengraph.list',
  title: 'List the generation graphs',
  description:
    'Every graph this project holds, with the file it lives in. A graph that will not load ' +
    'carries the reason instead, so a conflicted or corrupt one is visible rather than absent.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const graphs = await listGraphs(ctx.root, ctx.git);
    const broken = graphs.filter((entry) => entry.problem !== undefined).length;
    const said = broken === 0 ? '' : `, ${broken} of them unreadable`;
    return {
      message: `${graphs.length} graph${graphs.length === 1 ? '' : 's'}${said}.`,
      data: { graphs },
    };
  },
});

export const gengraphCreate = define({
  id: 'gengraph.create',
  title: 'Create a generation graph',
  description:
    'Start an empty graph at `vngen/work/graphs/<name>.json`. Nothing is drawn by it until an ' +
    'output node in it binds a slot and is made the active one.',
  mutating: true,
  undoable: true,
  props: {
    name: prop.string('what to call it; the filename is this name'),
  },
  async check({ name }, ctx) {
    if (!isGraphSlug(name)) {
      return { ok: false, reason: `'${name}' is not a graph name` };
    }
    const read = await readGraph(ctx.root, name, ctx.git);
    if (read.ok) return { ok: false, reason: `this project already has a ${name} graph` };
    return { ok: true, note: `writes vngen/work/graphs/${name}.json` };
  },
  async run({ name }, ctx) {
    if (!isGraphSlug(name)) throw new Error(`'${name}' is not a graph name`);
    const read = await readGraph(ctx.root, name, ctx.git);
    if (read.ok) throw new Error(`this project already has a ${name} graph`);

    const path = await writeGraph(ctx.root, name, new Graph());
    return { message: `Created the ${name} graph.`, data: { slug: name, path }, written: [path] };
  },
});

export const gengraphDelete = define({
  id: 'gengraph.delete',
  title: 'Delete a generation graph',
  description:
    'Remove a graph document. Its journal and its blobs are left where they are, because they ' +
    'record runs that happened and a slot the graph drew still points at the pictures.',
  mutating: true,
  undoable: true,
  confirm: true,
  props: {
    slug: prop.string(SLUG),
  },
  async check({ slug }, ctx) {
    const read = await readGraph(ctx.root, slug, ctx.git);
    if (!read.ok) return { ok: false, reason: read.reason };
    const count = read.graph.nodes.length;
    return { ok: true, note: `deletes ${read.path} and the ${count} nodes in it` };
  },
  async run({ slug }, ctx) {
    const read = await readGraph(ctx.root, slug, ctx.git);
    if (!read.ok) throw new Error(read.reason);
    const path = await deleteGraph(ctx.root, slug);
    return { message: `Deleted the ${slug} graph.`, data: { slug }, written: [path] };
  },
});

export const gengraphAddNode = define({
  id: 'gengraph.addNode',
  title: 'Add a node',
  description:
    'Put one node of the named type into a graph. A type no plugin provides is refused by name, ' +
    'so a graph never gains a node the run cannot execute.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    type: prop.string('the node type, such as `GenImage`'),
    x: prop.number('where to place it across the canvas', { default: 0 }),
    y: prop.number('where to place it down the canvas', { default: 0 }),
  },
  async check({ slug, type, x, y }, ctx) {
    return verdict(await decide(ctx, slug, () => ({ op: 'addNode', type, pos: [x, y] })));
  },
  async run({ slug, type, x, y }, ctx) {
    return edit(ctx, slug, () => ({ op: 'addNode', type, pos: [x, y] }));
  },
});

export const gengraphRemoveNode = define({
  id: 'gengraph.removeNode',
  title: 'Remove a node',
  description: 'Take one node out of a graph, along with every link into or out of it.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    node: prop.string(NODE),
  },
  async check({ slug, node }, ctx) {
    return verdict(
      await decide(ctx, slug, (graph) => ({ op: 'removeNode', node: nodeIdOf(graph, node) })),
    );
  },
  async run({ slug, node }, ctx) {
    return edit(ctx, slug, (graph) => ({ op: 'removeNode', node: nodeIdOf(graph, node) }));
  },
});

export const gengraphLink = define({
  id: 'gengraph.link',
  title: 'Link two nodes',
  description:
    "Feed one node's input from another node's output. A link whose types disagree is " +
    'refused, and so is one that would make a cycle, because a cycle has no order to run in.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    from: prop.string('the id of the node the value comes from'),
    fromSocket: prop.string('which of its outputs'),
    to: prop.string('the id of the node the value goes to'),
    toSocket: prop.string('which of its inputs'),
  },
  async check({ slug, from, fromSocket, to, toSocket }, ctx) {
    return verdict(
      await decide(ctx, slug, (graph) => ({
        op: 'link',
        from: nodeIdOf(graph, from),
        fromSocket,
        to: nodeIdOf(graph, to),
        toSocket,
      })),
    );
  },
  async run({ slug, from, fromSocket, to, toSocket }, ctx) {
    return edit(ctx, slug, (graph) => ({
      op: 'link',
      from: nodeIdOf(graph, from),
      fromSocket,
      to: nodeIdOf(graph, to),
      toSocket,
    }));
  },
});

export const gengraphUnlink = define({
  id: 'gengraph.unlink',
  title: 'Sever a link',
  description:
    'Cut what feeds one input. Naming a source cuts that one link; leaving it empty cuts every ' +
    'link into the input.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    to: prop.string('the id of the node being fed'),
    toSocket: prop.string('which of its inputs'),
    from: prop.string('the id of one source to cut, or empty for all of them', { default: '' }),
    fromSocket: prop.string("which of that source's outputs", { default: '' }),
  },
  async check({ slug, to, toSocket, from, fromSocket }, ctx) {
    return verdict(
      await decide(ctx, slug, (graph) => unlinkOf(graph, { to, toSocket, from, fromSocket })),
    );
  },
  async run({ slug, to, toSocket, from, fromSocket }, ctx) {
    return edit(ctx, slug, (graph) => unlinkOf(graph, { to, toSocket, from, fromSocket }));
  },
});

/** Builds the unlink edit, leaving the source out entirely when none was named. */
function unlinkOf(
  graph: Graph,
  said: { to: string; toSocket: string; from: string; fromSocket: string },
): EditPlan {
  const named = said.from.trim().length > 0;
  if (named && said.fromSocket.trim().length === 0) {
    return { refuse: 'naming a source also needs the output on it that the link comes from' };
  }
  return {
    op: 'unlink',
    to: nodeIdOf(graph, said.to),
    toSocket: said.toSocket,
    ...(named ? { from: nodeIdOf(graph, said.from), fromSocket: said.fromSocket } : {}),
  };
}

export const gengraphSetProp = define({
  id: 'gengraph.setProp',
  title: 'Set a node property',
  description:
    'Write one authored value on a node — a model id, an aspect ratio, the slot an output ' +
    "binds. The value is typed as text and the node's own property decides how to read it, " +
    'so a boolean property takes `true` and a numeric one takes a number. A slot string that ' +
    'does not parse is refused, and so is one addressing an asset rather than a slot.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    node: prop.string(NODE),
    key: prop.string('which property, by the name the node declares it under'),
    value: prop.string('the new value, written as text'),
  },
  async check({ slug, node, key, value }, ctx) {
    return verdict(await decide(ctx, slug, (graph) => propOf(graph, node, key, value)));
  },
  async run({ slug, node, key, value }, ctx) {
    return edit(ctx, slug, (graph) => propOf(graph, node, key, value));
  },
});

function propOf(graph: Graph, node: string, key: string, value: string): EditPlan {
  const id = nodeIdOf(graph, node);
  const read = readGenPropValue(graph, id, key, value);
  return read.ok ? { op: 'setProp', node: id, key, value: read.value } : { refuse: read.reason };
}

export const gengraphSetActiveOutput = define({
  id: 'gengraph.setActiveOutput',
  title: 'Choose the active output',
  description:
    'Make one output node the one a run of this graph terminates on, standing every rival output ' +
    'for the same slot down. Which output is active is part of the document, so it is undoable ' +
    'and it shows up in a diff.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    node: prop.string(NODE),
  },
  async check({ slug, node }, ctx) {
    return verdict(
      await decide(ctx, slug, (graph) => ({ op: 'setActiveOutput', node: nodeIdOf(graph, node) })),
    );
  },
  async run({ slug, node }, ctx) {
    return edit(ctx, slug, (graph) => ({ op: 'setActiveOutput', node: nodeIdOf(graph, node) }));
  },
});

export const gengraphApply = define({
  id: 'gengraph.apply',
  title: 'Replace a graph from a description',
  description:
    "Rewrite a whole graph from a JSON description in path.ux's graph DSL. A node the " +
    'description keeps by id keeps its journal, so replacing the graph does not by itself spend ' +
    'anything. A description that will not build leaves the graph on disk untouched.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    description: prop.string('the whole graph, as DSL JSON', { digest: true, multiline: true }),
  },
  async check({ slug, description }, ctx) {
    return verdict(await decide(ctx, slug, () => applyOf(description)));
  },
  async run({ slug, description }, ctx) {
    return edit(ctx, slug, () => applyOf(description));
  },
});

function applyOf(description: string): EditPlan {
  try {
    return { op: 'apply', description: JSON.parse(description) };
  } catch (err) {
    return { refuse: `that description is not JSON: ${(err as Error).message}` };
  }
}

export const gengraphEstimate = define({
  id: 'gengraph.estimate',
  title: 'Estimate what a graph costs',
  description:
    'What one run of a graph is expected to spend if it runs from nothing, priced against the ' +
    'table the app ships with. The refine tail is counted `max_refine_attempts` times, so the ' +
    'figure is the worst case rather than the cost of a run that passes first time.',
  mutating: false,
  props: {
    slug: prop.string(SLUG),
  },
  async run({ slug }, ctx) {
    const counted = await ctx.host.session.graphEstimate(slug);
    if (!counted.ok) throw new Error(counted.reason);
    return { message: estimateLine(counted), data: counted.estimate };
  },
});

/** One sentence pricing a graph, which is also what `gengraph.run` confirms against. */
function estimateLine(counted: { estimate: GenPricedEstimate; stale: boolean }): string {
  return estimateSentence(counted.estimate, counted.stale);
}

export const gengraphRun = define({
  id: 'gengraph.run',
  title: 'Run a generation graph',
  description:
    'Execute a graph now, through the same executor and journal a scheduled run uses. Every node ' +
    'whose hash still matches its last record resumes from the journal rather than running ' +
    'again. Nothing enters the asset store: a picture becomes an asset on the bound path, where ' +
    "a task's slot names the graph that draws it. `force` re-runs every paid node feeding " +
    'the target instead of resuming it.',
  mutating: true,
  undoable: false,
  confirm: true,
  props: {
    slug: prop.string(SLUG),
    node: prop.string('which output to run to, or empty for the active one', { default: '' }),
    force: prop.boolean('re-run the paid nodes rather than resuming them', { default: false }),
  },
  async check({ slug, force }, ctx) {
    const read = await readGraph(ctx.root, slug, ctx.git);
    if (!read.ok) return { ok: false, reason: read.reason };

    const counted = await ctx.host.session.graphEstimate(slug);
    if (!counted.ok) return { ok: false, reason: counted.reason };

    const resumed = force ? 'runs every paid node again' : 'resumes what the journal already holds';
    return { ok: true, note: `${estimateLine(counted)} It ${resumed}.` };
  },
  async run({ slug, node, force }, ctx) {
    const ran = await ctx.host.session.runGraph(slug, {
      ...(node.trim().length === 0 ? {} : { node: node.trim() }),
      force,
    });
    if (!ran.ok) throw new Error(ran.message);
    return { message: ran.message, data: { slug }, written: ran.written };
  },
});

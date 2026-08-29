/**
 * Commands over the generation graphs at `vngen/work/graphs/`. A graph is an authored document
 * like a scene, so it has one write path and this is it: `doc.*` refuses the directory, and every
 * mutation here goes through `decideGenEdit`, which is the same rule the authoring agent's graph
 * tool runs. A refusal therefore reads identically in both hosts.
 *
 * Three props are strings that carry something richer. `gengraph.setProp` takes its value as text
 * and lets the node's own property decide how to read it, `gengraph.apply` takes a whole DSL
 * description as text and parses it, and `gengraph.moveNodes` takes its list of positions the same
 * way. None is a design choice about graphs: `@vn/commands` has no JSON or list prop kind, and the
 * string DSL a command is typed in is text throughout.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import {
  Graph,
  bindSlots,
  decideGenEdit,
  defaultSlotGraph,
  estimateSentence,
  readGenPropValue,
  slotRefusal,
} from '@vn/gengraph';
import type { GenApplied, GenEdit, GenNodeMove, GenPricedEstimate, GraphId } from '@vn/gengraph';
import {
  deleteGraph,
  graphSlugs,
  isGraphSlug,
  listGraphs,
  nodeIdOf,
  readGraph,
  writeGraph,
} from '../graphs.js';
import type { GraphSlug } from '../graphs.js';
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
  ctx: { root: string },
  slug: string,
  plan: (graph: Graph) => EditPlan,
): Promise<Decided> {
  const read = await readGraph(ctx.root, slug);
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
  ctx: { root: string },
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
  notes:
    'Every generation graph the project holds, with the sentence an unreadable one earns instead of opening.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const graphs = await listGraphs(ctx.root);
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
  notes:
    'Start an empty graph at `vngen/work/graphs/<slug>.json`. The slug comes from the name once, at creation, so a graph is renamed the way a scene is — not at all.',
  mutating: true,
  undoable: true,
  props: {
    name: prop.string('what to call it; the filename is this name'),
  },
  async check({ name }, ctx) {
    if (!isGraphSlug(name)) {
      return { ok: false, reason: `'${name}' is not a graph name` };
    }
    const read = await readGraph(ctx.root, name);
    if (read.ok) return { ok: false, reason: `this project already has a ${name} graph` };
    return { ok: true, note: `writes vngen/work/graphs/${name}.json` };
  },
  async run({ name }, ctx) {
    if (!isGraphSlug(name)) throw new Error(`'${name}' is not a graph name`);
    const read = await readGraph(ctx.root, name);
    if (read.ok) throw new Error(`this project already has a ${name} graph`);

    const path = await writeGraph(ctx.root, name, new Graph());
    return { message: `Created the ${name} graph.`, data: { slug: name, path }, written: [path] };
  },
});

export const gengraphCreateForSlot = define({
  id: 'gengraph.createForSlot',
  title: 'Create a graph for a slot',
  description:
    'Start a graph that draws one slot, wired the way the pipeline draws it: the derived prompt ' +
    'and the task references feed an image node, and its picture fills the slot. A slot another ' +
    'graph already draws is refused, because two graphs claiming one slot bind neither.',
  notes:
    'Start a graph that draws one slot, wired the way the pipeline draws it: the derived prompt and the task references feed an image node, and its picture fills the slot. An empty `name` is derived from the slot address, and takes the next free `<base>-2` where a graph of that name exists. A slot another graph already draws is refused, because two active outputs claiming one slot leave it bound to neither. `open` shows the new graph in the Gen Graph editor, focusing a pane already open on one rather than making a second. This is what _Create a graph for this slot_ dispatches, on a slot row and on a picture a slot claims alike.',
  mutating: true,
  undoable: true,
  props: {
    slot: prop.string('which slot the graph fills, as the document tree writes it'),
    name: prop.string('what to call it; an empty name is derived from the slot', { default: '' }),
    open: prop.boolean('show the new graph in the Gen Graph editor', { default: true }),
  },
  async check({ slot, name }, ctx) {
    const planned = await planForSlot(ctx, slot, name);
    if ('refuse' in planned) return { ok: false, reason: planned.refuse };
    return {
      ok: true,
      note: `writes vngen/work/graphs/${planned.slug}.json, bound to ${slot.trim()}`,
    };
  },
  async run({ slot, name, open }, ctx) {
    const planned = await planForSlot(ctx, slot, name);
    if ('refuse' in planned) throw new Error(planned.refuse);

    const said = slot.trim();
    const path = await writeGraph(ctx.root, planned.slug, defaultSlotGraph(said));
    // Shows the graph by the route a click on the slot now takes, so the four nodes are on screen
    // rather than somewhere the author has to go looking for. A Gen Graph pane already open is
    // focused and re-pointed rather than duplicated, and the tree that raised the menu is left be
    if (open) {
      ctx.host.ui(
        {
          type: 'view',
          action: 'open',
          editor: 'gengraph',
          where: 'elsewhere',
          subject: planned.slug,
        },
        ctx.origin,
      );
    }
    return {
      message: `Created the ${planned.slug} graph, which draws ${said}.`,
      data: { slug: planned.slug, slot: said, path },
      written: [path],
    };
  },
});

/**
 * Decides what to call the graph a slot is about to be given, or refuses the request in one
 * sentence. The `check` and the `run` beside it both call this, so the name the check reports
 * is the name the run writes.
 */
async function planForSlot(
  ctx: { root: string },
  slot: string,
  name: string,
): Promise<{ slug: string } | { refuse: string }> {
  const said = slot.trim();
  if (said === '') return { refuse: 'a graph bound to a slot needs the slot it draws' };

  const bad = slotRefusal(said);
  if (bad !== undefined) return { refuse: bad };

  const slugs = await graphSlugs(ctx.root);
  const claimed = await claimOf(ctx, slugs, said);
  if (claimed !== undefined) return { refuse: claimed };

  const taken = new Set<string>(slugs);
  const wanted = name.trim();
  if (wanted === '') return { slug: freeName(slugOfSlot(said), taken) };

  if (!isGraphSlug(wanted)) return { refuse: `'${wanted}' is not a graph name` };
  if (taken.has(wanted)) return { refuse: `this project already has a ${wanted} graph` };
  return { slug: wanted };
}

/** Reports that another graph already draws this slot, through the rule a run binds by. */
async function claimOf(
  ctx: { root: string },
  slugs: readonly GraphSlug[],
  slot: string,
): Promise<string | undefined> {
  const loaded: { slug: GraphSlug; graph: Graph }[] = [];
  for (const slug of slugs) {
    const read = await readGraph(ctx.root, slug);
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

/** Turns a slot address into a graph name, replacing the punctuation a name cannot carry. */
function slugOfSlot(slot: string): string {
  const said = slot
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return isGraphSlug(said) ? said : 'graph';
}

/** The first of `base`, `base-2`, `base-3` that no graph file already carries. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export const gengraphDelete = define({
  id: 'gengraph.delete',
  title: 'Delete a generation graph',
  description:
    'Remove a graph document. Its journal and its blobs are left where they are, because they ' +
    'record runs that happened and a slot the graph drew still points at the pictures.',
  notes:
    "Remove a graph's document. Its journal and blobs under `vngen/state/graphs/` stay, being the record of runs that happened.",
  mutating: true,
  undoable: true,
  confirm: true,
  props: {
    slug: prop.string(SLUG),
  },
  async check({ slug }, ctx) {
    const read = await readGraph(ctx.root, slug);
    if (!read.ok) return { ok: false, reason: read.reason };
    const count = read.graph.nodes.length;
    return { ok: true, note: `deletes ${read.path} and the ${count} nodes in it` };
  },
  async run({ slug }, ctx) {
    const read = await readGraph(ctx.root, slug);
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
  notes:
    'Place one node of a registered type. A type no plugin provides is refused by name rather than written and reported on the next load.',
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

export const gengraphDuplicateNode = define({
  id: 'gengraph.duplicateNode',
  title: 'Duplicate a node',
  description:
    'Add a copy of one node, carrying over the values it authored. The copy takes a fresh id, ' +
    'so it starts with no run journal of its own and runs the first time the graph does; links ' +
    'are not carried over.',
  mutating: true,
  undoable: true,
  props: {
    slug: prop.string(SLUG),
    node: prop.string(NODE),
    x: prop.number('where to place the copy across the canvas', { default: 0 }),
    y: prop.number('where to place the copy down the canvas', { default: 0 }),
  },
  async check({ slug, node, x, y }, ctx) {
    return verdict(
      await decide(ctx, slug, (graph) => ({
        op: 'duplicateNode',
        node: nodeIdOf(graph, node),
        pos: [x, y],
      })),
    );
  },
  async run({ slug, node, x, y }, ctx) {
    return edit(ctx, slug, (graph) => ({
      op: 'duplicateNode',
      node: nodeIdOf(graph, node),
      pos: [x, y],
    }));
  },
});

export const gengraphRemoveNode = define({
  id: 'gengraph.removeNode',
  title: 'Remove a node',
  description: 'Take one node out of a graph, along with every link into or out of it.',
  notes: 'Delete one node and every link touching it.',
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
  notes:
    "Feed one node's input from another node's output. A pair whose types cannot coerce is refused, and so is a link that would close a cycle.",
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
  notes:
    'Sever what feeds an input. Naming a source severs that one edge; naming none severs every edge into the socket.',
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
  notes:
    "Write one node property. The value is typed as text and the node's own property decides how to read it, so a number field refuses prose.",
  mutating: true,
  undoable: true,
  // Dragging a slider sends one of these per frame, and each is a separate undo point either way.
  defersCommit: true,
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
  notes:
    "Choose which Output node a run targets and which slot binding counts. An Output filling no slot is refused, because a task's slot is what names the graph that draws it.",
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

export const gengraphMoveNodes = define({
  id: 'gengraph.moveNodes',
  title: 'Move nodes',
  description:
    'Put nodes where a drag left them. One drag is one edit, so a graph is never half-moved and ' +
    'one undo puts every node back. A move naming a node the graph has lost is refused whole.',
  mutating: true,
  undoable: true,
  // A drag across the canvas sends one of these per frame, the way `gengraph.setProp` does.
  defersCommit: true,
  props: {
    slug: prop.string(SLUG),
    moves: prop.string('the new positions, as JSON `[{"node":"1","x":0,"y":0}]`', {
      digest: true,
      multiline: true,
    }),
  },
  async check({ slug, moves }, ctx) {
    return verdict(await decide(ctx, slug, (graph) => movesOf(graph, moves)));
  },
  async run({ slug, moves }, ctx) {
    return edit(ctx, slug, (graph) => movesOf(graph, moves));
  },
});

/** Reads the move list, refusing anything that is not a list of node ids with two numbers. */
function movesOf(graph: Graph, said: string): EditPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(said);
  } catch (err) {
    return { refuse: `that move list is not JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { refuse: 'a move list is a JSON array' };

  const moves: GenNodeMove[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      return { refuse: 'every move in the list is an object naming a node and where it went' };
    }
    const move = entry as { node?: unknown; x?: unknown; y?: unknown };
    if (typeof move.x !== 'number' || typeof move.y !== 'number') {
      return { refuse: 'every move in the list needs a numeric `x` and `y`' };
    }
    if (typeof move.node !== 'string' && typeof move.node !== 'number') {
      return { refuse: 'every move in the list needs the `node` it is about' };
    }
    moves.push({ node: nodeIdOf(graph, String(move.node)), x: move.x, y: move.y });
  }

  return { op: 'moveNodes', moves };
}

export const gengraphApply = define({
  id: 'gengraph.apply',
  title: 'Replace a graph from a description',
  description:
    "Rewrite a whole graph from a JSON description in path.ux's graph DSL. A node the " +
    'description keeps by id keeps its journal, so replacing the graph does not by itself spend ' +
    'anything. A description that will not build leaves the graph on disk untouched.',
  notes:
    "Rewrite a whole graph from a JSON description in path.ux's graph DSL, diffed by node id so a node the description leaves alone keeps its position and its journal. The description is a string prop because `@vn/commands` has no JSON kind.",
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
  notes:
    'What one run would cost, per paid node and in total, from the shipped price table. Writes nothing.',
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
  notes:
    'Execute the graph through the same executor and journal the scheduler uses, targeting the active Output or the named one. Confirmed, quoting the estimate. Not undoable: what it writes is a journal record and a blob under `vngen/state`. `force` re-runs every paid node feeding the target rather than resuming from the journal.',
  mutating: true,
  undoable: false,
  confirm: true,
  props: {
    slug: prop.string(SLUG),
    node: prop.string('which output to run to, or empty for the active one', { default: '' }),
    force: prop.boolean('re-run the paid nodes rather than resuming them', { default: false }),
  },
  async check({ slug, force }, ctx) {
    const read = await readGraph(ctx.root, slug);
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

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
 *
 * A group definition under `vngen/work/graphs/lib/` is edited by the same commands with the `group`
 * prop set: the command then reads the definition rather than the graph, judges the edit against
 * the definition's subgraph, and writes the definition file. A node inside a group instance is
 * named by its key, `<instance id>/<inner id>`, and takes value edits only.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import {
  Graph,
  bindSlots,
  decideGenEdit,
  defaultSlotGraph,
  estimateSentence,
  instancedRefs,
  readGenPropValue,
  slotRefusal,
} from '@vn/gengraph';
import type { GenApplied, GenEdit, GenNodeMove, GenPricedEstimate, GraphId } from '@vn/gengraph';
import {
  deleteGraph,
  graphSlugs,
  isGraphSlug,
  listGraphs,
  listGroups,
  nextGroupRef,
  nodeIdOf,
  readGraph,
  readGroupDef,
  readGroupDoc,
  readGroupLibrary,
  writeGraph,
  writeGroupDef,
} from '../graphs.js';
import type { GraphSlug } from '../graphs.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** What a command builds from the graph it is about to edit, or the sentence refusing it. */
type EditPlan = GenEdit | { refuse: string };

type Decided =
  { ok: false; reason: string } | { ok: true; note: string; graph: Graph; apply: () => GenApplied };

/** The document one edit reads and writes: a graph's file, or a definition's. */
interface Target {
  graph: Graph;
  /** Writes the graph back to the file it came from, answering the path `written` reports. */
  write(graph: Graph): Promise<string>;
}

/**
 * Opens what the edit is about: the slug's graph when `group` is empty, and the definition's
 * subgraph otherwise. A definition edit writes its own file, so the `group` here also decides
 * which file the edit lands in.
 */
async function target(
  ctx: { root: string },
  slug: string,
  group: string,
): Promise<{ ok: true; target: Target } | { ok: false; reason: string }> {
  const ref = group.trim();
  if (ref === '') {
    const read = await readGraph(ctx.root, slug);
    if (!read.ok) return read;
    return {
      ok    : true,
      target: { graph: read.graph, write: (graph) => writeGraph(ctx.root, slug, graph) },
    };
  }

  const read = await readGroupDoc(ctx.root, ref);
  if (!read.ok) return read;
  const def = read.def;
  return {
    ok    : true,
    target: {
      graph: def.subgraph,
      // The subgraph is edited in place, so the definition holding it is what gets written
      write: () => writeGroupDef(ctx.root, ref, def),
    },
  };
}

/**
 * Reads the document and decides one edit against it. Nothing is written, so a `check` and the
 * `run` beside it call this and get the same answer.
 */
async function decide(
  ctx: { root: string },
  slug: string,
  plan: (graph: Graph) => EditPlan,
  group = '',
): Promise<Decided & { target?: Target }> {
  const opened = await target(ctx, slug, group);
  if (!opened.ok) return opened;

  const graph = opened.target.graph;
  const edit = plan(graph);
  if ('refuse' in edit) return { ok: false, reason: edit.refuse };

  const decided = decideGenEdit(graph, edit);
  if (!decided.ok) return { ok: false, reason: decided.reason };
  return { ok: true, note: decided.note, graph, apply: decided.apply, target: opened.target };
}

function verdict(decided: Decided): CheckResult {
  return decided.ok ? { ok: true, note: decided.note } : { ok: false, reason: decided.reason };
}

/**
 * Decides an edit, writes what it produced, and reports the sentence the decision carried. A
 * definition the edit created is written before the graph that instances it, so the graph file
 * never names a definition that is not on disk yet; `written` names every file.
 */
async function edit(
  ctx: { root: string },
  slug: string,
  plan: (graph: Graph) => EditPlan,
  group = '',
): Promise<{ message: string; data: { node?: GraphId }; written: string[] }> {
  const decided = await decide(ctx, slug, plan, group);
  if (!decided.ok) throw new Error(decided.reason);

  const applied = decided.apply();
  const written: string[] = [];
  for (const made of applied.definitions ?? []) {
    written.push(await writeGroupDef(ctx.root, made.ref, made.def));
  }
  written.push(await decided.target!.write(applied.graph));
  return {
    message: decided.note,
    data   : applied.node === undefined ? {} : { node: applied.node },
    written,
  };
}

const SLUG = 'which graph, by the name its file carries';
const NODE =
  'the id of the node, as the graph lists it; `<instance>/<id>` names one inside a group';
const GROUP =
  'set, edit the named group definition under `lib/` instead of the graph, and write its file';
const GROUP_ONLY = 'which group definition under `lib/`, by the name its file carries';

/** The `group` prop the editing commands share. Empty means the graph itself. */
const groupProp = () => prop.string(GROUP, { default: '' });

export const gengraphList = define({
  id         : 'gengraph.list',
  title      : 'List the generation graphs',
  description:
    'Every graph this project holds, with the file it lives in. A graph that will not load ' +
    'carries the reason instead, so a conflicted or corrupt one is visible rather than absent.',
  notes:
    'Every generation graph the project holds, with the sentence an unreadable one earns instead of opening.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const graphs = await listGraphs(ctx.root);
    const broken = graphs.filter((entry) => entry.problem !== undefined).length;
    const said = broken === 0 ? '' : `, ${broken} of them unreadable`;
    return {
      message: `${graphs.length} graph${graphs.length === 1 ? '' : 's'}${said}.`,
      data   : { graphs },
    };
  },
});

export const gengraphCreate = define({
  id         : 'gengraph.create',
  title      : 'Create a generation graph',
  description:
    'Start an empty graph at `vngen/work/graphs/<name>.json`. Nothing is drawn by it until an ' +
    'output node in it binds a slot and is made the active one.',
  notes:
    'Start an empty graph at `vngen/work/graphs/<slug>.json`. The slug comes from the name once, at creation, so a graph is renamed the way a scene is — not at all.',
  mutating   : true,
  undoable   : true,
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
  id         : 'gengraph.createForSlot',
  title      : 'Create a graph for a slot',
  description:
    'Start a graph that draws one slot, wired the way the pipeline draws it: the derived prompt ' +
    'and the task references feed an image node, and its picture fills the slot. A slot another ' +
    'graph already draws is refused, because two graphs claiming one slot bind neither.',
  notes:
    'Start a graph that draws one slot, wired the way the pipeline draws it: the derived prompt and the task references feed an image node, and its picture fills the slot. An empty `name` is derived from the slot address, and takes the next free `<base>-2` where a graph of that name exists. A slot another graph already draws is refused, because two active outputs claiming one slot leave it bound to neither. `open` shows the new graph in the Gen Graph editor, focusing a pane already open on one rather than making a second. This is what _Create a graph for this slot_ dispatches, on a slot row and on a picture a slot claims alike.',
  mutating   : true,
  undoable   : true,
  props: {
    slot: prop.string('which slot the graph fills, as the document tree writes it'),
    name: prop.string('what to call it; an empty name is derived from the slot', { default: '' }),
    open: prop.boolean('show the new graph in the Gen Graph editor', { default: true }),
  },
  async check({ slot, name }, ctx) {
    const planned = await planForSlot(ctx, slot, name);
    if ('refuse' in planned) return { ok: false, reason: planned.refuse };
    return {
      ok  : true,
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
          type   : 'view',
          action : 'open',
          editor : 'gengraph',
          where  : 'elsewhere',
          subject: planned.slug,
        },
        ctx.origin,
      );
    }
    return {
      message: `Created the ${planned.slug} graph, which draws ${said}.`,
      data   : { slug: planned.slug, slot: said, path },
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
  id         : 'gengraph.delete',
  title      : 'Delete a generation graph',
  description:
    'Remove a graph document. Its journal and its blobs are left where they are, because they ' +
    'record runs that happened and a slot the graph drew still points at the pictures.',
  notes:
    "Remove a graph's document. Its journal and blobs under `vngen/state/graphs/` stay, being the record of runs that happened.",
  mutating   : true,
  undoable   : true,
  confirm    : true,
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
  id         : 'gengraph.addNode',
  title      : 'Add a node',
  description:
    'Put one node of the named type into a graph. A type no plugin provides is refused by name, ' +
    'so a graph never gains a node the run cannot execute.',
  notes:
    'Place one node of a registered type. A type no plugin provides is refused by name rather than written and reported on the next load.',
  mutating   : true,
  undoable   : true,
  props: {
    slug : prop.string(SLUG),
    type : prop.string('the node type, such as `GenImage`'),
    x    : prop.number('where to place it across the canvas', { default: 0 }),
    y    : prop.number('where to place it down the canvas', { default: 0 }),
    group: groupProp(),
  },
  async check({ slug, type, x, y, group }, ctx) {
    return verdict(await decide(ctx, slug, () => ({ op: 'addNode', type, pos: [x, y] }), group));
  },
  async run({ slug, type, x, y, group }, ctx) {
    return edit(ctx, slug, () => ({ op: 'addNode', type, pos: [x, y] }), group);
  },
});

export const gengraphDuplicateNode = define({
  id         : 'gengraph.duplicateNode',
  title      : 'Duplicate a node',
  description:
    'Add a copy of one node, carrying over the values it authored. The copy takes a fresh id, ' +
    'so it starts with no run journal of its own and runs the first time the graph does; links ' +
    'are not carried over. A copied group instance keeps its group and its overrides.',
  mutating   : true,
  undoable   : true,
  props: {
    slug : prop.string(SLUG),
    node : prop.string(NODE),
    x    : prop.number('where to place the copy across the canvas', { default: 0 }),
    y    : prop.number('where to place the copy down the canvas', { default: 0 }),
    group: groupProp(),
  },
  async check({ slug, node, x, y, group }, ctx) {
    return verdict(
      await decide(
        ctx,
        slug,
        (graph) => ({ op: 'duplicateNode', node: nodeIdOf(graph, node), pos: [x, y] }),
        group,
      ),
    );
  },
  async run({ slug, node, x, y, group }, ctx) {
    return edit(
      ctx,
      slug,
      (graph) => ({ op: 'duplicateNode', node: nodeIdOf(graph, node), pos: [x, y] }),
      group,
    );
  },
});

export const gengraphRemoveNode = define({
  id         : 'gengraph.removeNode',
  title      : 'Remove a node',
  description: 'Take one node out of a graph, along with every link into or out of it.',
  notes      : 'Delete one node and every link touching it.',
  mutating   : true,
  undoable   : true,
  props: {
    slug : prop.string(SLUG),
    node : prop.string(NODE),
    group: groupProp(),
  },
  async check({ slug, node, group }, ctx) {
    return verdict(
      await decide(
        ctx,
        slug,
        (graph) => ({ op: 'removeNode', node: nodeIdOf(graph, node) }),
        group,
      ),
    );
  },
  async run({ slug, node, group }, ctx) {
    return edit(ctx, slug, (graph) => ({ op: 'removeNode', node: nodeIdOf(graph, node) }), group);
  },
});

export const gengraphLink = define({
  id         : 'gengraph.link',
  title      : 'Link two nodes',
  description:
    "Feed one node's input from another node's output. A link whose types disagree is " +
    'refused, and so is one that would make a cycle, because a cycle has no order to run in.',
  notes:
    "Feed one node's input from another node's output. A pair whose types cannot coerce is refused, and so is a link that would close a cycle.",
  mutating   : true,
  undoable   : true,
  props: {
    slug      : prop.string(SLUG),
    from      : prop.string('the id of the node the value comes from'),
    fromSocket: prop.string('which of its outputs'),
    to        : prop.string('the id of the node the value goes to'),
    toSocket  : prop.string('which of its inputs'),
    group     : groupProp(),
  },
  async check({ slug, from, fromSocket, to, toSocket, group }, ctx) {
    return verdict(
      await decide(
        ctx,
        slug,
        (graph) => ({
          op  : 'link',
          from: nodeIdOf(graph, from),
          fromSocket,
          to: nodeIdOf(graph, to),
          toSocket,
        }),
        group,
      ),
    );
  },
  async run({ slug, from, fromSocket, to, toSocket, group }, ctx) {
    return edit(
      ctx,
      slug,
      (graph) => ({
        op  : 'link',
        from: nodeIdOf(graph, from),
        fromSocket,
        to: nodeIdOf(graph, to),
        toSocket,
      }),
      group,
    );
  },
});

export const gengraphUnlink = define({
  id         : 'gengraph.unlink',
  title      : 'Sever a link',
  description:
    'Cut what feeds one input. Naming a source cuts that one link; leaving it empty cuts every ' +
    'link into the input.',
  notes:
    'Sever what feeds an input. Naming a source severs that one edge; naming none severs every edge into the socket.',
  mutating   : true,
  undoable   : true,
  props: {
    slug      : prop.string(SLUG),
    to        : prop.string('the id of the node being fed'),
    toSocket  : prop.string('which of its inputs'),
    from: prop.string('the id of one source to cut, or empty for all of them', { default: '' }),
    fromSocket: prop.string("which of that source's outputs", { default: '' }),
    group     : groupProp(),
  },
  async check({ slug, to, toSocket, from, fromSocket, group }, ctx) {
    return verdict(
      await decide(
        ctx,
        slug,
        (graph) => unlinkOf(graph, { to, toSocket, from, fromSocket }),
        group,
      ),
    );
  },
  async run({ slug, to, toSocket, from, fromSocket, group }, ctx) {
    return edit(ctx, slug, (graph) => unlinkOf(graph, { to, toSocket, from, fromSocket }), group);
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
    op      : 'unlink',
    to      : nodeIdOf(graph, said.to),
    toSocket: said.toSocket,
    ...(named ? { from: nodeIdOf(graph, said.from), fromSocket: said.fromSocket } : {}),
  };
}

export const gengraphSetProp = define({
  id          : 'gengraph.setProp',
  title       : 'Set a node property',
  description:
    'Write one authored value on a node — a model id, an aspect ratio, the slot an output ' +
    "binds. The value is typed as text and the node's own property decides how to read it, " +
    'so a boolean property takes `true` and a numeric one takes a number. A slot string that ' +
    'does not parse is refused, and so is one addressing an asset rather than a slot. Written on ' +
    'a node inside a group instance, named `<instance>/<id>`, the value is an override on that ' +
    'instance alone.',
  notes:
    "Write one node property. The value is typed as text and the node's own property decides how to read it, so a number field refuses prose. Addressed by node key into a group instance, the write is an override on that instance.",
  mutating    : true,
  undoable    : true,
  // Dragging a slider sends one of these per frame, and each is a separate undo point either way.
  defersCommit: true,
  props: {
    slug : prop.string(SLUG),
    node : prop.string(NODE),
    key  : prop.string('which property, by the name the node declares it under'),
    value: prop.string('the new value, written as text'),
    group: groupProp(),
  },
  async check({ slug, node, key, value, group }, ctx) {
    return verdict(await decide(ctx, slug, (graph) => propOf(graph, node, key, value), group));
  },
  async run({ slug, node, key, value, group }, ctx) {
    return edit(ctx, slug, (graph) => propOf(graph, node, key, value), group);
  },
});

function propOf(graph: Graph, node: string, key: string, value: string): EditPlan {
  const id = nodeIdOf(graph, node);
  const read = readGenPropValue(graph, id, key, value);
  return read.ok ? { op: 'setProp', node: id, key, value: read.value } : { refuse: read.reason };
}

export const gengraphSetActiveOutput = define({
  id         : 'gengraph.setActiveOutput',
  title      : 'Choose the active output',
  description:
    'Make one output node the one a run of this graph terminates on, standing every rival output ' +
    'for the same slot down. Which output is active is part of the document, so it is undoable ' +
    'and it shows up in a diff.',
  notes:
    "Choose which Output node a run targets and which slot binding counts. An Output filling no slot is refused, because a task's slot is what names the graph that draws it.",
  mutating   : true,
  undoable   : true,
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
  id          : 'gengraph.moveNodes',
  title       : 'Move nodes',
  description:
    'Put nodes where a drag left them. One drag is one edit, so a graph is never half-moved and ' +
    'one undo puts every node back. A move naming a node the graph has lost is refused whole.',
  mutating    : true,
  undoable    : true,
  // A drag across the canvas sends one of these per frame, the way `gengraph.setProp` does.
  defersCommit: true,
  props: {
    slug : prop.string(SLUG),
    moves: prop.string('the new positions, as JSON `[{"node":"1","x":0,"y":0}]`', {
      digest   : true,
      multiline: true,
    }),
    group: groupProp(),
  },
  async check({ slug, moves, group }, ctx) {
    return verdict(await decide(ctx, slug, (graph) => movesOf(graph, moves), group));
  },
  async run({ slug, moves, group }, ctx) {
    return edit(ctx, slug, (graph) => movesOf(graph, moves), group);
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
  id         : 'gengraph.apply',
  title      : 'Replace a graph from a description',
  description:
    "Rewrite a whole graph from a JSON description in path.ux's graph DSL. A node the " +
    'description keeps by id keeps its journal, so replacing the graph does not by itself spend ' +
    'anything. A description that will not build leaves the graph on disk untouched.',
  notes:
    "Rewrite a whole graph from a JSON description in path.ux's graph DSL, diffed by node id so a node the description leaves alone keeps its position and its journal. The description is a string prop because `@vn/commands` has no JSON kind.",
  mutating   : true,
  undoable   : true,
  props: {
    slug       : prop.string(SLUG),
    description: prop.string('the whole graph, as DSL JSON', { digest: true, multiline: true }),
  },
  async check({ slug, description }, ctx) {
    const plan = await applyOf(ctx, description);
    return verdict(await decide(ctx, slug, () => plan));
  },
  async run({ slug, description }, ctx) {
    const plan = await applyOf(ctx, description);
    return edit(ctx, slug, () => plan);
  },
});

/**
 * Parses the description and loads the whole group library with it, so the description can
 * instance a definition the graph did not hold before; the builder binds each instance as it
 * goes, which is what leaves nothing to resolve before the write.
 */
async function applyOf(ctx: { root: string }, description: string): Promise<EditPlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(description);
  } catch (err) {
    return { refuse: `that description is not JSON: ${(err as Error).message}` };
  }
  return { op: 'apply', description: parsed, groups: await readGroupLibrary(ctx.root) };
}

export const gengraphListGroups = define({
  id         : 'gengraph.listGroups',
  title      : 'List the group definitions',
  description:
    'Every group definition under `vngen/work/graphs/lib/`, with the file it lives in. One that ' +
    'will not load carries the reason instead, so a broken definition is visible rather than absent.',
  notes:
    'Every group definition the project holds, with the sentence an unreadable one earns instead of opening. What Add Group offers.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const groups = await listGroups(ctx.root);
    const broken = groups.filter((entry) => entry.problem !== undefined).length;
    const said = broken === 0 ? '' : `, ${broken} of them unreadable`;
    return {
      message: `${groups.length} group${groups.length === 1 ? '' : 's'}${said}.`,
      data   : { groups },
    };
  },
});

export const gengraphCreateGroup = define({
  id         : 'gengraph.createGroup',
  title      : 'Create a group',
  description:
    'Move the named nodes into a new group definition under `lib/` and put one instance of it ' +
    'where they stood, with the links that crossed the selection rewired through the instance. ' +
    'An empty name takes the next free `group-<n>`. An output node is refused, because it binds ' +
    'the whole graph to a slot and belongs at the root.',
  notes:
    'Move the selected nodes into a new definition file under `lib/` and leave an instance in their place; every link that crossed the selection is rewired through the instance. Writes both files. What Ctrl+G and Edit ▸ Create Group run.',
  mutating   : true,
  undoable   : true,
  props: {
    slug : prop.string(SLUG),
    nodes: prop.string('the ids of the nodes to group, separated by commas'),
    name: prop.string('what to call the group; empty takes the next free `group-<n>`', {
      default: '',
    }),
    group: groupProp(),
  },
  async check({ slug, nodes, name, group }, ctx) {
    const ref = await refFor(ctx, name);
    if ('refuse' in ref) return { ok: false, reason: ref.refuse };
    return verdict(await decide(ctx, slug, (graph) => createGroupOf(graph, nodes, ref.ref), group));
  },
  async run({ slug, nodes, name, group }, ctx) {
    const ref = await refFor(ctx, name);
    if ('refuse' in ref) throw new Error(ref.refuse);
    return edit(ctx, slug, (graph) => createGroupOf(graph, nodes, ref.ref), group);
  },
});

/** The ref a new group takes: the name given, or the next free one when none was. */
async function refFor(
  ctx: { root: string },
  name: string,
): Promise<{ ref: string } | { refuse: string }> {
  const wanted = name.trim();
  if (wanted === '') return { ref: await nextGroupRef(ctx.root) };
  if (!isGraphSlug(wanted)) {
    return { refuse: `'${wanted}' is not a group name; use letters, digits and dashes` };
  }
  if ((await readGroupDef(ctx.root, wanted)) !== undefined) {
    return { refuse: `this project already has a ${wanted} group` };
  }
  return { ref: wanted };
}

function createGroupOf(graph: Graph, nodes: string, ref: string): EditPlan {
  const ids = nodes
    .split(/[,\s]+/)
    .filter((id) => id !== '')
    .map((id) => nodeIdOf(graph, id));
  if (ids.length === 0) return { refuse: 'grouping needs at least one node' };
  return { op: 'createGroup', nodes: ids, ref };
}

export const gengraphUngroup = define({
  id         : 'gengraph.ungroup',
  title      : 'Ungroup an instance',
  description:
    'Replace one group instance with a copy of what is inside it, overrides included, wired the ' +
    'way the instance was. The definition file stays for the other instances of it.',
  notes:
    "Inline a copy of the instance's subgraph, overrides included, where the instance stood. The definition under `lib/` is left for its other instances. What Edit ▸ Ungroup runs.",
  mutating   : true,
  undoable   : true,
  props: {
    slug : prop.string(SLUG),
    node : prop.string('the id of the group instance'),
    group: groupProp(),
  },
  async check({ slug, node, group }, ctx) {
    return verdict(
      await decide(ctx, slug, (graph) => ({ op: 'ungroup', node: nodeIdOf(graph, node) }), group),
    );
  },
  async run({ slug, node, group }, ctx) {
    return edit(ctx, slug, (graph) => ({ op: 'ungroup', node: nodeIdOf(graph, node) }), group);
  },
});

export const gengraphAddGroup = define({
  id         : 'gengraph.addGroup',
  title      : 'Add a group instance',
  description:
    'Put one instance of an existing group definition into a graph. Its sockets and forwarded ' +
    'controls are the definition’s, and editing the definition later reaches this instance too. ' +
    'A definition cannot be added inside itself, directly or through another group.',
  notes:
    'Place one instance of a definition under `lib/`, bound at once so the file never holds an unresolved instance. What the Add Group menu runs.',
  mutating   : true,
  undoable   : true,
  props: {
    slug : prop.string(SLUG),
    ref  : prop.string('which group definition to instance, by the name its file carries'),
    x    : prop.number('where to place it across the canvas', { default: 0 }),
    y    : prop.number('where to place it down the canvas', { default: 0 }),
    group: groupProp(),
  },
  async check({ slug, ref, x, y, group }, ctx) {
    const plan = await addGroupOf(ctx, ref, [x, y], group);
    return verdict(await decide(ctx, slug, () => plan, group));
  },
  async run({ slug, ref, x, y, group }, ctx) {
    const plan = await addGroupOf(ctx, ref, [x, y], group);
    return edit(ctx, slug, () => plan, group);
  },
});

/**
 * Loads the definition an instance is about to be made of, so the instance is bound at once.
 * Placed inside a definition, the instance must not lead back to it: two reads of one file are
 * two objects, so the chain is checked here by ref rather than left to the decision's identity
 * check.
 */
async function addGroupOf(
  ctx: { root: string },
  ref: string,
  pos: readonly [number, number],
  group: string,
): Promise<EditPlan> {
  const said = ref.trim();
  if (!isGraphSlug(said)) return { refuse: `'${said}' is not a group name` };
  const def = await readGroupDef(ctx.root, said);
  if (def === undefined) return { refuse: `there is no ${said} group in this project` };

  const host = group.trim();
  if (host !== '' && (host === said || instancedRefs(def.subgraph).includes(host))) {
    return { refuse: 'a group cannot contain itself, directly or through another group' };
  }
  return { op: 'addGroup', ref: said, def, pos };
}

const ROW = 'which forwarded row, counting from 0 in the order the group lists them';
const EXPOSED_KEY = "which of the node's properties; empty forwards the node's whole control panel";

export const gengraphExpose = define({
  id         : 'gengraph.expose',
  title      : 'Expose a control on a group',
  description:
    "Forward one inner node's property, or its whole control panel, onto every instance of the " +
    'group, so an author editing an instance can set it without entering the group. The row is ' +
    'added at the end; reorder it afterwards.',
  notes:
    "Add a forwarded row to a definition: one inner node's property, or the node's whole panel when no key is named. Every instance shows it. What the designer's Expose runs.",
  mutating   : true,
  undoable   : true,
  props: {
    group: prop.string(GROUP_ONLY),
    node : prop.string('the id of the inner node, as the definition lists it'),
    key  : prop.string(EXPOSED_KEY, { default: '' }),
    label: prop.string('what to call the row; empty takes the property’s own name', {
      default: '',
    }),
  },
  async check({ group, node, key, label }, ctx) {
    return verdict(await decide(ctx, '', (graph) => exposeOf(graph, node, key, label), group));
  },
  async run({ group, node, key, label }, ctx) {
    return edit(ctx, '', (graph) => exposeOf(graph, node, key, label), group);
  },
});

function exposeOf(graph: Graph, node: string, key: string, label: string): EditPlan {
  const said = key.trim();
  return {
    op  : 'expose',
    kind: said === '' ? 'nodeUI' : 'prop',
    node: nodeIdOf(graph, node),
    ...(said === '' ? {} : { key: said }),
    ...(label.trim() === '' ? {} : { label: label.trim() }),
  };
}

export const gengraphUnexpose = define({
  id         : 'gengraph.unexpose',
  title      : 'Remove a forwarded row',
  description:
    'Stop forwarding one row onto the group’s instances. The inner node keeps its value; only ' +
    'the control on the instances goes.',
  mutating   : true,
  undoable   : true,
  props: {
    group: prop.string(GROUP_ONLY),
    index: prop.number(ROW),
  },
  async check({ group, index }, ctx) {
    return verdict(
      await decide(ctx, '', () => rowOf(index, (at) => ({ op: 'unexpose', index: at })), group),
    );
  },
  async run({ group, index }, ctx) {
    return edit(ctx, '', () => rowOf(index, (at) => ({ op: 'unexpose', index: at })), group);
  },
});

/** Applies `plan` to a row index. Refuses an index that is not a non-negative whole number. */
function rowOf(index: number, plan: (at: number) => GenEdit): EditPlan {
  if (!Number.isInteger(index) || index < 0) {
    return { refuse: 'a row is counted from 0 in whole numbers' };
  }
  return plan(index);
}

export const gengraphReorderExposed = define({
  id         : 'gengraph.reorderExposed',
  title      : 'Reorder the forwarded rows',
  description:
    'Move one forwarded row to another position, which is the order every instance of the ' +
    'group shows its controls in.',
  mutating   : true,
  undoable   : true,
  props: {
    group: prop.string(GROUP_ONLY),
    from : prop.number(ROW),
    to   : prop.number('where the row goes, counting the same way'),
  },
  async check({ group, from, to }, ctx) {
    return verdict(
      await decide(
        ctx,
        '',
        () =>
          rowOf(
            from,
            (a) => rowOf(to, (b) => ({ op: 'reorderExposed', from: a, to: b })) as GenEdit,
          ),
        group,
      ),
    );
  },
  async run({ group, from, to }, ctx) {
    return edit(
      ctx,
      '',
      () =>
        rowOf(from, (a) => rowOf(to, (b) => ({ op: 'reorderExposed', from: a, to: b })) as GenEdit),
      group,
    );
  },
});

export const gengraphRepointExposed = define({
  id         : 'gengraph.repointExposed',
  title      : 'Repoint a forwarded row',
  description:
    'Point one forwarded row at a different inner node, or a different property of one, keeping ' +
    'its place and its label. A row forwarding a property needs a property; one forwarding a ' +
    'whole panel takes a node alone.',
  mutating   : true,
  undoable   : true,
  props: {
    group: prop.string(GROUP_ONLY),
    index: prop.number(ROW),
    node : prop.string('the id of the inner node the row now points at'),
    key: prop.string("which of that node's properties, for a row that forwards one", {
      default: '',
    }),
  },
  async check({ group, index, node, key }, ctx) {
    return verdict(await decide(ctx, '', (graph) => repointOf(graph, index, node, key), group));
  },
  async run({ group, index, node, key }, ctx) {
    return edit(ctx, '', (graph) => repointOf(graph, index, node, key), group);
  },
});

function repointOf(graph: Graph, index: number, node: string, key: string): EditPlan {
  const said = key.trim();
  return rowOf(index, (at) => ({
    op   : 'repointExposed',
    index: at,
    node : nodeIdOf(graph, node),
    ...(said === '' ? {} : { key: said }),
  }));
}

const DIR = "which side of the group: 'in' for an input, 'out' for an output";

export const gengraphAddBoundary = define({
  id         : 'gengraph.addBoundary',
  title      : 'Add a group socket',
  description:
    'Declare a new input or output on the group, of a registered socket type. Every instance ' +
    'gains the socket, and inside the definition it appears on the group’s input or output node ' +
    'to be wired from.',
  mutating   : true,
  undoable   : true,
  props: {
    group: prop.string(GROUP_ONLY),
    dir  : prop.string(DIR),
    key  : prop.string('what to call the socket'),
    type : prop.string('the socket type, such as `TextSocket`'),
  },
  async check({ group, dir, key, type }, ctx) {
    return verdict(
      await decide(
        ctx,
        '',
        () => sideOf(dir, (side) => ({ op: 'addBoundary', dir: side, key: key.trim(), type })),
        group,
      ),
    );
  },
  async run({ group, dir, key, type }, ctx) {
    return edit(
      ctx,
      '',
      () => sideOf(dir, (side) => ({ op: 'addBoundary', dir: side, key: key.trim(), type })),
      group,
    );
  },
});

export const gengraphRemoveBoundary = define({
  id         : 'gengraph.removeBoundary',
  title      : 'Remove a group socket',
  description:
    'Take one input or output off the group. Every link into it inside the definition is ' +
    'severed, and every instance loses the socket along with whatever fed it.',
  mutating   : true,
  undoable   : true,
  props: {
    group: prop.string(GROUP_ONLY),
    dir  : prop.string(DIR),
    key  : prop.string('which socket, by name'),
  },
  async check({ group, dir, key }, ctx) {
    return verdict(
      await decide(
        ctx,
        '',
        () => sideOf(dir, (side) => ({ op: 'removeBoundary', dir: side, key: key.trim() })),
        group,
      ),
    );
  },
  async run({ group, dir, key }, ctx) {
    return edit(
      ctx,
      '',
      () => sideOf(dir, (side) => ({ op: 'removeBoundary', dir: side, key: key.trim() })),
      group,
    );
  },
});

/** Reads a socket side as typed, refusing anything but the two words a side can be. */
function sideOf(dir: string, plan: (side: 'in' | 'out') => GenEdit): EditPlan {
  const said = dir.trim();
  if (said !== 'in' && said !== 'out') return { refuse: "a side is 'in' or 'out'" };
  return plan(said);
}

export const gengraphEstimate = define({
  id         : 'gengraph.estimate',
  title      : 'Estimate what a graph costs',
  description:
    'What one run of a graph is expected to spend if it runs from nothing, priced against the ' +
    'table the app ships with. The refine tail is counted `max_refine_attempts` times, so the ' +
    'figure is the worst case rather than the cost of a run that passes first time.',
  notes:
    'What one run would cost, per paid node and in total, from the shipped price table. Writes nothing.',
  mutating   : false,
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
  id         : 'gengraph.run',
  title      : 'Run a generation graph',
  description:
    'Execute a graph now, through the same executor and journal a scheduled run uses. Every node ' +
    'whose hash still matches its last record resumes from the journal rather than running ' +
    'again. Nothing enters the asset store: a picture becomes an asset on the bound path, where ' +
    "a task's slot names the graph that draws it. `force` re-runs every paid node feeding " +
    'the target instead of resuming it.',
  notes:
    'Execute the graph through the same executor and journal the scheduler uses, targeting the active Output or the named one. Confirmed, quoting the estimate. Not undoable: what it writes is a journal record and a blob under `vngen/state`. `force` re-runs every paid node feeding the target rather than resuming from the journal.',
  mutating   : true,
  undoable   : false,
  confirm    : true,
  props: {
    slug : prop.string(SLUG),
    node : prop.string('which output to run to, or empty for the active one', { default: '' }),
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

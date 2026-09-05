/**
 * A node inside a group instance is addressed by its key, hashed as part of its root, run as
 * part of its root and journaled under that key; a definition is edited as a plain graph; and
 * the DSL carries an instance as one entry naming its definition. What is checked here is that
 * each of those holds together, and that the sentences an author reads when one is refused are
 * the ones this package promises.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GenDerivedPrompt,
  GenImage,
  GenOutput,
  GenTemplate,
  Graph,
  GroupDef,
  GroupNode,
  TextSocket,
  applyGraphDSL,
  decideGenEdit,
  graphToDSL,
  isNodeKey,
  nodeKey,
  registerGenNodes,
  registerGenRuntimes,
  replayJournal,
  resolveNodeKey,
  validateGenGraph,
} from '../index.js';
import type { GenApplied, GenEdit, GenEditResult, GraphJournalRecord, Node } from '../index.js';
import { executeGenGraph } from '../execute.js';
import type { GenRunContext } from '../execute.js';
import { graphHashes } from '../hash.js';
import { groupRefs, nextGroupRef, readGroupDoc, writeGroupDef } from '../document.js';
import { mockServices } from '../nodes/tests/__fixtures__/services.js';
import type { MockServices } from '../nodes/tests/__fixtures__/services.js';

registerGenNodes();
registerGenRuntimes();

/** A definition whose one inner node adds ", in ink wash" to whatever feeds the group's input. */
function inkWashDef(): { def: GroupDef; inner: GenTemplate } {
  const def = new GroupDef();
  const inner = new GenTemplate();
  def.subgraph.add(inner);

  const inText = def.declareInput('text', new TextSocket('in'));
  const outText = def.declareOutput('text', new TextSocket('out'));
  def.subgraph.connect(inText, inner.inputs.varA);
  def.subgraph.connect(inner.outputs.text, outText);
  inner.props.template!.setValue('{varA}, in ink wash');

  return { def, inner };
}

/** An instance of `def`, bound and synced the way a resolved load leaves it. */
function instanceOf(graph: Graph, ref: string, def: GroupDef): GroupNode {
  const node = new GroupNode();
  node.ref = ref;
  graph.add(node);
  node.setDefinition(ref, def);
  node.syncToDefinition();
  return node;
}

interface Chain {
  graph: Graph;
  prompt: GenDerivedPrompt;
  group: GroupNode;
  inner: GenTemplate;
  image: GenImage;
  output: GenOutput;
}

/** A derived prompt feeding an ink-wash instance, feeding an image, feeding the output. */
function chain(): Chain {
  const graph = new Graph();
  const { def, inner } = inkWashDef();
  const prompt = new GenDerivedPrompt();
  const image = new GenImage();
  const output = new GenOutput();

  graph.add(prompt);
  const group = instanceOf(graph, 'inkwash', def);
  graph.add(image);
  graph.add(output);
  graph.connect(prompt.outputs.prompt, group.inputs.text!);
  graph.connect(group.outputs.text!, image.inputs.prompt);
  graph.connect(image.outputs.image, output.inputs.image);
  output.props.slot!.setValue('portrait:aiko');

  return { graph, prompt, group, inner, image, output };
}

/** The inner template as the instance holds it, which is where an override lives. */
function innerOf(group: GroupNode, inner: GenTemplate): GenTemplate {
  return group.subgraph.nodeIdMap.get(inner.id) as GenTemplate;
}

const reason = (r: GenEditResult): string => (r.ok ? '' : r.reason);

function apply(graph: Graph, edit: GenEdit): GenApplied {
  const decided = decideGenEdit(graph, edit);
  if (!decided.ok) throw new Error(decided.reason);
  return decided.apply();
}

describe('node keys', () => {
  it('keys a root node by its id and an inner node by its chain', () => {
    const { graph, prompt, group, inner } = chain();
    const key = `${group.id}/${inner.id}`;

    expect(nodeKey(prompt)).toBe(prompt.id);
    expect(nodeKey(innerOf(group, inner))).toBe(key);
    expect(isNodeKey(key)).toBe(true);
    expect(isNodeKey(prompt.id)).toBe(false);
    expect(resolveNodeKey(graph, key)).toBe(innerOf(group, inner));
    expect(resolveNodeKey(graph, prompt.id)).toBe(prompt);
  });

  it('answers nothing for a chain that breaks', () => {
    const { graph, prompt, group } = chain();

    expect(resolveNodeKey(graph, `${group.id}/99`)).toBeUndefined();
    expect(resolveNodeKey(graph, `${prompt.id}/0`)).toBeUndefined();
    expect(resolveNodeKey(graph, '99/0')).toBeUndefined();
  });
});

describe('hashing a graph with groups', () => {
  it('keys an inner node by its chain, so a colliding root id keeps its own hash', () => {
    const { graph, prompt, group, inner } = chain();
    const hashes = graphHashes(graph);

    expect(inner.id).toBe(prompt.id);
    expect(hashes.get(prompt.id)).toBeDefined();
    expect(hashes.get(`${group.id}/${inner.id}`)).toBeDefined();
    expect(hashes.get(`${group.id}/${inner.id}`)).not.toBe(hashes.get(prompt.id));
    expect(hashes.has(group.id)).toBe(false);
  });

  it('hashes two instances of one definition apart once one carries an override', () => {
    const graph = new Graph();
    const { def, inner } = inkWashDef();
    const a = instanceOf(graph, 'inkwash', def);
    const b = instanceOf(graph, 'inkwash', def);
    const before = graphHashes(graph);
    expect(before.get(`${a.id}/${inner.id}`)).toBe(before.get(`${b.id}/${inner.id}`));

    innerOf(b, inner).props.template!.setValue('{varA}, in charcoal');
    const after = graphHashes(graph);

    expect(after.get(`${a.id}/${inner.id}`)).toBe(before.get(`${a.id}/${inner.id}`));
    expect(after.get(`${b.id}/${inner.id}`)).not.toBe(before.get(`${b.id}/${inner.id}`));
  });

  it("carries an instance's boundary default into the inner node's hash", () => {
    const graph = new Graph();
    const { def, inner } = inkWashDef();
    const group = instanceOf(graph, 'inkwash', def);
    const key = `${group.id}/${inner.id}`;
    const before = graphHashes(graph).get(key);

    group.inputs.text!.defaultProp.setValue('a heron at dusk');

    expect(graphHashes(graph).get(key)).not.toBe(before);
  });
});

describe('running a graph with groups', () => {
  let mock: MockServices;

  beforeEach(() => {
    mock = mockServices();
  });

  function context(into: GraphJournalRecord[]): GenRunContext {
    return {
      services: mock,
      journal : replayJournal(into.map((r) => JSON.stringify(r)).join('\n')),
      record: (record) => {
        into.push(record);
        return Promise.resolve();
      },
      now     : () => new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  const SEEDS = { GenDerivedPrompt: { prompt: 'a lantern at dusk' } };

  it("runs the instance's inner nodes in order and journals them by key", async () => {
    const { graph, prompt, group, inner, image, output } = chain();
    const records: GraphJournalRecord[] = [];
    const key = `${group.id}/${inner.id}`;

    const result = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(result.failures).toEqual([]);
    expect(result.ran).toEqual([prompt.id, key, image.id, output.id]);
    expect(mock.images[0]?.prompt).toBe('a lantern at dusk, in ink wash');
    expect(records.filter((r) => r.nodeId === key).map((r) => r.status)).toEqual([
      'running',
      'done',
    ]);
  });

  it('runs to a target inside an instance, named by its key', async () => {
    const { graph, prompt, group, inner } = chain();
    const key = `${group.id}/${inner.id}`;

    const result = await executeGenGraph(graph, context([]), { targets: [key], seeds: SEEDS });

    expect(result.ran).toEqual([prompt.id, key]);
    expect(mock.images).toHaveLength(0);
  });

  it('refuses the instance itself as a target, since it is its inner nodes that run', async () => {
    const { graph, group } = chain();

    await expect(executeGenGraph(graph, context([]), { targets: [group.id] })).rejects.toThrow(
      'a group rather than a node that runs',
    );
  });

  it('reads a boundary default through the proxy without tripping the cycle check', async () => {
    const { graph, prompt, group, output } = chain();
    graph.disconnect(prompt.outputs.prompt, group.inputs.text!);
    group.inputs.text!.defaultProp.setValue('a heron');

    const result = await executeGenGraph(graph, context([]), { targets: [output.id] });

    expect(result.failures).toEqual([]);
    expect(mock.images[0]?.prompt).toBe('a heron, in ink wash');
  });

  it('resumes a root node from a record written before keys existed', async () => {
    const { graph, prompt, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    expect(records.some((r) => r.nodeId === prompt.id)).toBe(true);

    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });
    expect(second.ran).toEqual([]);
    expect(second.skipped).toHaveLength(4);
  });
});

describe('the DSL with groups', () => {
  it('describes an instance as one entry naming its definition', () => {
    const { graph, group, prompt, image } = chain();
    const dsl = graphToDSL(graph);

    expect(dsl.nodes?.find((n) => n.id === group.id)).toEqual({
      id   : group.id,
      type : 'GroupNode',
      group: 'inkwash',
    });
    expect(dsl.links).toEqual(
      expect.arrayContaining([
        [prompt.id, 'prompt', group.id, 'text'],
        [group.id, 'text', image.id, 'prompt'],
      ]),
    );
  });

  it('round-trips an instance with its ref, its links and its overrides', () => {
    const { graph, group, inner, image } = chain();
    innerOf(group, inner).props.template!.setValue('{varA}, in charcoal');
    group.inputs.text!.defaultProp.setValue('a heron');

    const applied = applyGraphDSL(graph, graphToDSL(graph));
    expect(applied.diagnostics).toEqual([]);
    expect(applied.kept).toContain(group.id);

    const kept = applied.graph.nodeIdMap.get(group.id) as GroupNode;
    expect(kept.definition).toBe(group.definition);
    expect(innerOf(kept, inner).props.template!.getValue()).toBe('{varA}, in charcoal');
    expect(kept.inputs.text!.defaultProp.getValue()).toBe('a heron');
    expect(applied.graph.nodeIdMap.get(image.id)!.inputs.prompt!.edges).toHaveLength(1);
  });

  it('adds an instance of a definition the caller hands it', () => {
    const graph = new Graph();
    const { def } = inkWashDef();
    const groups = new Map([['inkwash', def]]);

    const applied = applyGraphDSL(
      graph,
      { nodes: [{ id: 'wash', type: 'GroupNode', group: 'inkwash' }] },
      groups,
    );

    expect(applied.diagnostics).toEqual([]);
    const added = applied.graph.nodeIdMap.get('wash') as GroupNode;
    expect(added.definition).toBe(def);
    expect(Object.keys(added.inputs)).toEqual(['text']);
  });

  it('refuses a definition nothing holds, a proxy at the root, and an id written like a key', () => {
    const graph = new Graph();

    const unknown = applyGraphDSL(graph, {
      nodes: [{ id: 'wash', type: 'GroupNode', group: 'nowhere' }],
    });
    expect(unknown.diagnostics.map((d) => d.code)).toEqual(['unknown-group']);

    const proxy = applyGraphDSL(graph, { nodes: [{ id: 'p', type: 'GroupInputNode' }] });
    expect(proxy.diagnostics.map((d) => d.code)).toEqual(['unknown-node-type']);

    const keyed = applyGraphDSL(graph, { nodes: [{ id: '3/7', type: 'GenTemplate' }] });
    expect(keyed.diagnostics.map((d) => d.code)).toEqual(['bad-node-id']);
    expect(keyed.graph).toBe(graph);
  });
});

describe('editing a graph with groups', () => {
  it('groups a selection into a definition and hands the definition back', () => {
    const { graph, prompt, image, output } = chain();
    const decided = decideGenEdit(graph, {
      op   : 'createGroup',
      nodes: [prompt.id, image.id],
      ref  : 'front',
    });
    expect(decided.ok && decided.note).toBe("Groups 2 nodes into 'front'.");
    if (!decided.ok) return;

    const applied = decided.apply();
    expect(applied.definitions?.map((d) => d.ref)).toEqual(['front']);
    const instance = graph.nodeIdMap.get(applied.node!) as GroupNode;
    expect(instance.ref).toBe('front');
    expect(instance.definition).toBe(applied.definitions![0]!.def);
    const producer = output.inputs.image.resolvedEdges()[0]?.owningNode as Node | undefined;
    expect(producer?.def.typeName).toBe('GenImage');
  });

  it('refuses to group an output node, which binds the graph to its slot', () => {
    const { graph, image, output } = chain();
    expect(
      reason(
        decideGenEdit(graph, { op: 'createGroup', nodes: [image.id, output.id], ref: 'tail' }),
      ),
    ).toBe(
      'the Output image node fills a slot for the whole graph, so it stays at the root rather than inside a group',
    );
  });

  it('refuses a ref that cannot be a file name', () => {
    const { graph, prompt } = chain();
    expect(
      reason(decideGenEdit(graph, { op: 'createGroup', nodes: [prompt.id], ref: 'no spaces' })),
    ).toBe("'no spaces' is not a group name; use letters, digits and dashes");
  });

  it("refuses a structural edit inside an instance with path.ux's sentence", () => {
    const { graph, group, inner } = chain();
    const key = `${group.id}/${inner.id}`;
    const sentence =
      "a group instance takes value edits only; structural edits belong to the group's definition";

    expect(reason(decideGenEdit(graph, { op: 'removeNode', node: key }))).toBe(sentence);
    expect(reason(decideGenEdit(graph, { op: 'duplicateNode', node: key }))).toBe(sentence);
    expect(
      reason(decideGenEdit(graph, { op: 'moveNodes', moves: [{ node: key, x: 0, y: 0 }] })),
    ).toBe(sentence);
  });

  it('writes a value edit inside an instance as an override', () => {
    const { graph, group, inner } = chain();
    const key = `${group.id}/${inner.id}`;

    apply(graph, { op: 'setProp', node: key, key: 'template', value: '{varA}, in charcoal' });

    expect(innerOf(group, inner).props.template!.getValue()).toBe('{varA}, in charcoal');
    expect(innerOf(group, inner).props.template!.wasSet).toBe(true);
    expect(inner.props.template!.getValue()).toBe('{varA}, in ink wash');
  });

  it('keeps the ref and the definition when an instance is duplicated', () => {
    const { graph, group } = chain();

    const copy = graph.nodeIdMap.get(
      apply(graph, { op: 'duplicateNode', node: group.id }).node!,
    ) as GroupNode;

    expect(copy).not.toBe(group);
    expect(copy.ref).toBe('inkwash');
    expect(copy.definition).toBe(group.definition);
    expect(Object.keys(copy.inputs)).toEqual(['text']);
  });

  it('inlines an instance, and refuses to inline one that has not loaded', () => {
    const { graph, group, image } = chain();
    const decided = decideGenEdit(graph, { op: 'ungroup', node: group.id });
    expect(decided.ok && decided.note).toBe(
      "Inlines the 1 node of group 'inkwash' where the instance stands.",
    );
    apply(graph, { op: 'ungroup', node: group.id });

    expect(graph.nodes.some((n) => n instanceof GroupNode)).toBe(false);
    const source = image.inputs.prompt.edges[0]?.owningNode as Node | undefined;
    expect(source?.def.typeName).toBe('GenTemplate');

    const waiting = new GroupNode();
    waiting.ref = 'later';
    graph.add(waiting);
    expect(reason(decideGenEdit(graph, { op: 'ungroup', node: waiting.id }))).toBe(
      "group 'later' has not loaded, so there is nothing to inline",
    );
  });

  it('adds an instance, bound at once when the definition is handed over', () => {
    const graph = new Graph();
    const { def } = inkWashDef();

    const bound = graph.nodeIdMap.get(
      apply(graph, { op: 'addGroup', ref: 'inkwash', def, pos: [10, 20] }).node!,
    ) as GroupNode;
    expect(bound.definition).toBe(def);
    expect(Object.keys(bound.outputs)).toEqual(['text']);
    expect([...bound.pos]).toEqual([10, 20]);

    const waiting = graph.nodeIdMap.get(apply(graph, { op: 'addGroup', ref: 'later' }).node!);
    expect((waiting as GroupNode).definition).toBeUndefined();
  });

  it('edits the forwarded rows of a definition through its subgraph', () => {
    const { def, inner } = inkWashDef();
    const graph = def.subgraph;

    const decided = decideGenEdit(graph, {
      op  : 'expose',
      kind: 'prop',
      node: inner.id,
      key : 'template',
    });
    expect(decided.ok && decided.note).toBe(
      "Exposes 'template' of the Text node on every instance of the group.",
    );
    apply(graph, { op: 'expose', kind: 'prop', node: inner.id, key: 'template' });
    expect(def.exposed.map((e) => String(e.propKey))).toEqual(['template']);

    expect(
      reason(decideGenEdit(graph, { op: 'expose', kind: 'prop', node: inner.id, key: 'template' })),
    ).toBe('that is already exposed');
    expect(
      reason(decideGenEdit(graph, { op: 'expose', kind: 'prop', node: inner.id, key: 'nope' })),
    ).toBe("the Text node has no property 'nope'");

    apply(graph, { op: 'expose', kind: 'nodeUI', node: inner.id, label: 'Wash' });
    apply(graph, { op: 'reorderExposed', from: 1, to: 0 });
    expect(def.exposed.map((e) => e.kind)).toEqual(['nodeUI', 'prop']);
    apply(graph, { op: 'unexpose', index: 0 });
    expect(def.exposed.map((e) => e.kind)).toEqual(['prop']);
    expect(reason(decideGenEdit(graph, { op: 'unexpose', index: 4 }))).toBe(
      'the group has no forwarded row 4',
    );
  });

  it('edits the boundary of a definition through its subgraph', () => {
    const { def } = inkWashDef();
    const graph = def.subgraph;

    apply(graph, { op: 'addBoundary', dir: 'in', key: 'mood', type: 'TextSocket' });
    expect(Object.keys(def.inputs)).toEqual(['text', 'mood']);
    expect(Object.keys(def.inputNode().outputs)).toEqual(['text', 'mood']);

    expect(
      reason(
        decideGenEdit(graph, { op: 'addBoundary', dir: 'in', key: 'mood', type: 'TextSocket' }),
      ),
    ).toBe("the group already has an input named 'mood'");
    expect(
      reason(decideGenEdit(graph, { op: 'addBoundary', dir: 'out', key: 'x', type: 'Nope' })),
    ).toBe("there is no socket type 'Nope' registered here");

    const decided = decideGenEdit(graph, { op: 'removeBoundary', dir: 'in', key: 'text' });
    expect(decided.ok && decided.note).toBe(
      "Removes the group's input 'text' and severs the 1 link into it; every instance loses the socket.",
    );
    apply(graph, { op: 'removeBoundary', dir: 'in', key: 'text' });
    expect(Object.keys(def.inputs)).toEqual(['mood']);
  });

  it('refuses a definition edit on a graph that is not a definition', () => {
    const { graph, group } = chain();
    const sentence =
      'this graph is not a group definition, so it has no boundary or forwarded rows to edit';

    expect(
      reason(decideGenEdit(graph, { op: 'addBoundary', dir: 'in', key: 'x', type: 'TextSocket' })),
    ).toBe(sentence);
    expect(reason(decideGenEdit(group.subgraph, { op: 'unexpose', index: 0 }))).toBe(sentence);
  });
});

describe('validating a graph with groups', () => {
  it('diagnoses an output node inside an instance, keyed by its chain', () => {
    const graph = new Graph();
    const def = new GroupDef();
    const output = new GenOutput();
    def.subgraph.add(output);
    const group = instanceOf(graph, 'bad', def);

    const found = validateGenGraph(graph);
    expect(found.map((d) => [d.code, d.nodeId])).toEqual([
      ['output-in-group', `${group.id}/${output.id}`],
    ]);

    expect(validateGenGraph(def.subgraph).map((d) => [d.code, d.nodeId])).toEqual([
      ['output-in-group', output.id],
    ]);
  });

  it('checks the nodes inside an instance as part of the graph', () => {
    const { graph } = chain();
    expect(validateGenGraph(graph)).toEqual([]);
  });
});

describe('the group library on disk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-groups-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('allocates the next ref past what exists, whatever its case', async () => {
    expect(await nextGroupRef(root)).toBe('group-1');
    await writeGroupDef(root, 'Group-1', inkWashDef().def);
    expect(await groupRefs(root)).toEqual(['Group-1']);
    expect(await nextGroupRef(root)).toBe('group-2');
  });

  it('opens a definition as a document, validated as a subgraph', async () => {
    await writeGroupDef(root, 'inkwash', inkWashDef().def);
    const read = await readGroupDoc(root, 'inkwash');
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.path).toBe('vngen/work/graphs/lib/inkwash.json');
    expect(read.diagnostics).toEqual([]);
    expect(Object.keys(read.def.inputs)).toEqual(['text']);
    expect(read.def.subgraph.groupLoader).toBeDefined();

    const bad = new GroupDef();
    bad.subgraph.add(new GenOutput());
    await writeGroupDef(root, 'bad', bad);
    const opened = await readGroupDoc(root, 'bad');
    expect(opened.ok && opened.diagnostics.map((d) => d.code)).toEqual(['output-in-group']);
  });

  it('says why a definition cannot be had', async () => {
    expect(await readGroupDoc(root, 'missing')).toEqual({
      ok    : false,
      reason: 'there is no missing group in this project',
    });
    expect(await readGroupDoc(root, '../etc')).toEqual({
      ok    : false,
      reason: "'../etc' is not a group name",
    });
  });
});

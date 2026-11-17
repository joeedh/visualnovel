import {
  GenTemplate,
  Graph,
  defaultSlotGraph,
  journalRecord,
  readGraphFile,
  replayJournal,
  writeGraphFile,
} from '../index.js';
import type { GraphJournal, Node } from '../index.js';
import { authoredHashes, graphDrift, graphHashes, isDefaultGraph } from '../state.js';
import {
  TestOutput,
  TestSeeded,
  TestSource,
  registerTestNodes,
  setProp,
} from './__fixtures__/nodes.js';

registerTestNodes();

function pair(): { graph: Graph; source: TestSource; output: TestOutput } {
  const graph = new Graph();
  const source = new TestSource();
  const output = new TestOutput();

  graph.add(source);
  graph.add(output);
  graph.connect(source.outputs.blob, output.inputs.image);

  return { graph, source, output };
}

/** The journal a completed run of every node in `graph` would have left behind. */
function ranClean(graph: Graph): GraphJournal {
  const authored = authoredHashes(graph);
  const lines = [...graphHashes(graph)].map(([nodeId, nodeHash]) =>
    JSON.stringify(
      journalRecord({
        nodeId,
        nodeHash,
        authoredHash: authored.get(nodeId)!,
        status      : 'done',
        at          : '2026-08-25T10:00:00.000Z',
      }),
    ),
  );
  return replayJournal(lines.join('\n'));
}

describe('drift', () => {
  it('reports an output node whose upstream prop changed', () => {
    const { graph, source, output } = pair();
    const journal = ranClean(graph);

    setProp(source, 'label', 'blue hour');

    const drifted = graphDrift(graph, journal);
    expect(drifted.map((d) => d.nodeId)).toEqual([output.id]);
    expect(drifted[0]?.recorded).not.toBe(drifted[0]?.current);
  });

  it('reports nothing after a node is only moved', () => {
    const { graph, output } = pair();
    const journal = ranClean(graph);

    output.pos[0] = 512;
    output.label = 'final frame';

    expect(graphDrift(graph, journal)).toEqual([]);
  });

  it('reports nothing before the graph has ever run', () => {
    const { graph, source } = pair();
    setProp(source, 'label', 'blue hour');

    expect(graphDrift(graph, replayJournal(''))).toEqual([]);
  });

  it('reports nothing while the graph still matches its last run', () => {
    const { graph } = pair();

    expect(graphDrift(graph, ranClean(graph))).toEqual([]);
  });

  it('reports nothing when only a host-seeded input changed', () => {
    const graph = new Graph();
    const seeded = new TestSeeded();
    const output = new TestOutput();

    graph.add(seeded);
    graph.add(output);
    graph.connect(seeded.outputs.blob, output.inputs.image);

    const journal = ranClean(graph);
    const before = graphHashes(graph).get(output.id);
    seeded.inputs.amount.defaultProp!.setValue(4);

    // The run hash moves, which is what makes a refine pass re-run the tail; drift is measured
    // against the authored hash instead, so the same change is not an edit.
    expect(graphHashes(graph).get(output.id)).not.toBe(before);
    expect(graphDrift(graph, journal)).toEqual([]);
  });

  it('reports nothing against a record written before authored hashes existed', () => {
    const { graph, source, output } = pair();
    const line = JSON.stringify(
      journalRecord({
        nodeId  : output.id,
        nodeHash: graphHashes(graph).get(output.id)!,
        status  : 'done',
        at      : '2026-08-25T10:00:00.000Z',
      }),
    );

    setProp(source, 'label', 'blue hour');

    expect(graphDrift(graph, replayJournal(line))).toEqual([]);
  });

  it('says nothing about a node that fills no slot', () => {
    const { graph, source } = pair();
    const journal = ranClean(graph);

    setProp(source, 'label', 'blue hour');

    expect(graphDrift(graph, journal).some((d) => d.nodeId === source.id)).toBe(false);
  });
});

function nodeOf(graph: Graph, typeName: string): Node {
  const node = graph.nodes.find((n) => n.def.typeName === typeName);
  if (node === undefined) throw new Error(`the graph holds no ${typeName} node`);
  return node;
}

describe('isDefaultGraph', () => {
  const SLOT = 'portrait:aiko';

  it('accepts the default graph, before and after a trip through its file', () => {
    const graph = defaultSlotGraph(SLOT);
    const read = readGraphFile(JSON.parse(JSON.stringify(writeGraphFile(graph))) as unknown);

    expect(isDefaultGraph(graph, nodeOf(graph, 'GenOutput').id)).toBe(true);
    expect(read.graph).toBeDefined();
    expect(isDefaultGraph(read.graph!, nodeOf(read.graph!, 'GenOutput').id)).toBe(true);
  });

  it('accepts a default graph whose nodes were moved, relabelled, or joined by loose ones', () => {
    const graph = defaultSlotGraph(SLOT);
    const output = nodeOf(graph, 'GenOutput');
    nodeOf(graph, 'GenImage').pos[0] = 900;
    output.label = 'final frame';
    graph.add(new GenTemplate());

    expect(isDefaultGraph(graph, output.id)).toBe(true);
  });

  it('ignores how the slot is spelled', () => {
    const graph = defaultSlotGraph(` ${SLOT} `);

    expect(isDefaultGraph(graph, nodeOf(graph, 'GenOutput').id)).toBe(true);
  });

  it('rejects a graph whose output descends from an edited node', () => {
    const graph = defaultSlotGraph(SLOT);
    setProp(nodeOf(graph, 'GenImage'), 'model', 'another-model');

    expect(isDefaultGraph(graph, nodeOf(graph, 'GenOutput').id)).toBe(false);
  });

  it('rejects a key that names no output', () => {
    const graph = defaultSlotGraph(SLOT);

    expect(isDefaultGraph(graph, nodeOf(graph, 'GenImage').id)).toBe(false);
    expect(isDefaultGraph(graph, 'nothing/here')).toBe(false);
  });
});

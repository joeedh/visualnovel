import { Graph, journalRecord, replayJournal } from '../index.js';
import type { GraphJournal } from '../index.js';
import { graphDrift, graphHashes } from '../state.js';
import { TestOutput, TestSource, registerTestNodes, setProp } from './__fixtures__/nodes.js';

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
  const lines = [...graphHashes(graph)].map(([nodeId, nodeHash]) =>
    JSON.stringify(
      journalRecord({ nodeId, nodeHash, status: 'done', at: '2026-08-25T10:00:00.000Z' }),
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

  it('says nothing about a node that fills no slot', () => {
    const { graph, source } = pair();
    const journal = ranClean(graph);

    setProp(source, 'label', 'blue hour');

    expect(graphDrift(graph, journal).some((d) => d.nodeId === source.id)).toBe(false);
  });
});

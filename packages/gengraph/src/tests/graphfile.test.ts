import { Graph, readGraphFile, writeGraphFile } from '../index.js';
import type { GraphId } from '../index.js';
import {
  TestOutput,
  TestSource,
  propValue,
  registerTestNodes,
  setProp,
} from './__fixtures__/nodes.js';

registerTestNodes();

/** A two-node graph with one link and one authored prop on each node. */
function buildGraph(): { graph: Graph; sourceId: GraphId; outputId: GraphId } {
  const graph = new Graph();
  const source = new TestSource();
  const output = new TestOutput();

  graph.add(source);
  graph.add(output);
  graph.connect(source.outputs.blob, output.inputs.image);

  setProp(source, 'label', 'the base plate');
  setProp(output, 'slot', 'plate:cafe/day');

  return { graph, sourceId: source.id, outputId: output.id };
}

/** Serialization is asserted over JSON values, so the round trip crosses real text. */
function roundTrip(graph: Graph): Graph {
  const json: unknown = JSON.parse(JSON.stringify(writeGraphFile(graph)));
  const read = readGraphFile(json);

  expect(read.diagnostics).toEqual([]);
  expect(read.graph).toBeDefined();

  return read.graph as Graph;
}

describe('the graph file', () => {
  it('carries nodes, links and prop values through JSON', () => {
    const { graph, sourceId, outputId } = buildGraph();
    const loaded = roundTrip(graph);

    expect(loaded.nodes.length).toBe(2);

    const source = loaded.nodeIdMap.get(sourceId);
    const output = loaded.nodeIdMap.get(outputId);
    expect(source).toBeInstanceOf(TestSource);
    expect(output).toBeInstanceOf(TestOutput);

    expect(propValue(source!, 'label')).toBe('the base plate');
    expect(propValue(output!, 'slot')).toBe('plate:cafe/day');

    const image = output!.inputs['image'];
    expect(image?.edges.length).toBe(1);
    expect(image?.edges[0]).toBe(source!.outputs['blob']);

    expect(loaded.sort().cycles).toEqual([]);
  });

  it('writes what it read, byte for byte', () => {
    const { graph } = buildGraph();
    const once = JSON.stringify(writeGraphFile(graph));
    const twice = JSON.stringify(writeGraphFile(roundTrip(graph)));

    expect(twice).toBe(once);
  });

  it('reports a file that does not match the graph layout rather than throwing', () => {
    const read = readGraphFile({ nodes: 'not a list' });

    expect(read.graph).toBeUndefined();
    expect(read.diagnostics.map((d) => d.code)).toEqual(['malformed-graph-file']);
    expect(read.diagnostics[0]?.message).not.toBe('');
  });
});

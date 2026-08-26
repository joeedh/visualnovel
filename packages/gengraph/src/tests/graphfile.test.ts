import { PropFlags } from 'pathux-toolprop';

import { GenImage, Graph, readGraphFile, registerGenNodes, writeGraphFile } from '../index.js';
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

/** The metadata a row is drawn from, as a file written before it was declared carries it. */
interface FileProp {
  uiname: string;
  description: string;
  flag: number;
}

// A socket declaring no default is written as null rather than left out.
function blank(prop: FileProp | null | undefined): void {
  if (prop === null || prop === undefined) return;

  prop.uiname = '';
  prop.description = '';
  prop.flag = 0;
}

registerGenNodes();

/**
 * A property is serialized whole, so a graph written before a name or a description was declared
 * carries the empty ones. The node editor draws its rows from that metadata, so a file left to
 * speak for itself would draw a control with no tooltip.
 */
describe('what a file is not trusted for', () => {
  it("puts a node type's declared row text and flags back", () => {
    const graph = new Graph();
    graph.add(new GenImage());

    const json = JSON.parse(JSON.stringify(writeGraphFile(graph))) as {
      nodes: { props: FileProp[]; inputs: { defaultProp?: FileProp | null }[] }[];
    };
    for (const prop of json.nodes[0]!.props) blank(prop);
    for (const input of json.nodes[0]!.inputs) blank(input.defaultProp);

    const node = readGraphFile(json).graph?.nodes[0];
    const model = node?.props['model'];
    expect(model?.uiname).toBe('Model');
    expect(model?.description).not.toBe('');
    expect((model?.flag ?? 0) & (PropFlags.NO_UNDO ?? 0)).not.toBe(0);

    // The socket defaults are the rows this matters most for: they are the ones path.ux binds.
    const prompt = node?.inputs['prompt']?.defaultProp;
    expect(prompt?.uiname).toBe('Prompt');
    expect(prompt?.description).not.toBe('');
  });
});

import { StringProperty } from 'pathux-toolprop';

import { Graph, Node, registerNodeType, validateGenGraph } from '../index.js';
import type { GenDiagnostic, NodeDef } from '../index.js';
import { TestOutput, TestSource, registerTestNodes, setProp } from './__fixtures__/nodes.js';

registerTestNodes();

/** Registered with path.ux but never with the generator, which is what a missing plugin looks like. */
class Unregistered extends Node {
  static override graphDef(): NodeDef {
    return { typeName: 'Unregistered' };
  }
}
registerNodeType(Unregistered);

function codes(diagnostics: GenDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe('semantic validation', () => {
  it('accepts a well-formed graph, bound or unbound', () => {
    const graph = new Graph();
    const source = new TestSource();
    const output = new TestOutput();

    graph.add(source);
    graph.add(output);
    graph.connect(source.outputs.blob, output.inputs.image);

    expect(validateGenGraph(graph)).toEqual([]);

    setProp(output, 'slot', 'shot:cafe/1');
    expect(validateGenGraph(graph)).toEqual([]);
  });

  it('names the node type it does not know', () => {
    const graph = new Graph();
    graph.add(new Unregistered());

    const found = validateGenGraph(graph);
    expect(codes(found)).toEqual(['unknown-node-type']);
    expect(found[0]?.message).toContain("'Unregistered'");
  });

  it('reports a prop the node type does not declare', () => {
    const graph = new Graph();
    const source = new TestSource();
    graph.add(source);

    // A load keeps a file's props under their apiname even where the type dropped them.
    source.props['retired'] = new StringProperty('', 'retired');

    expect(codes(validateGenGraph(graph))).toEqual(['unknown-prop']);
  });

  it('reports a socket the node type does not declare', () => {
    const graph = new Graph();
    const output = new TestOutput();
    graph.add(output);

    // The flag a load sets on a socket the file carried and the definition lacks.
    output.inputs.image.orphaned = true;

    expect(codes(validateGenGraph(graph))).toEqual(['orphaned-socket']);
  });

  it('reports a link whose ends cannot coerce', () => {
    const graph = new Graph();
    const source = new TestSource();
    const output = new TestOutput();

    graph.add(source);
    graph.add(output);
    graph.connect(source.outputs.amount, output.inputs.image);

    const found = validateGenGraph(graph);
    expect(codes(found)).toEqual(['link-type-mismatch']);
    expect(found[0]?.message).toContain("'float'");
  });

  it('reports a slot address it cannot parse', () => {
    const graph = new Graph();
    const output = new TestOutput();
    graph.add(output);
    setProp(output, 'slot', 'plate:cafe');

    expect(codes(validateGenGraph(graph))).toEqual(['slot-unparsed']);
  });

  it('refuses an asset by name, because an asset fills no slot', () => {
    const graph = new Graph();
    const output = new TestOutput();
    graph.add(output);
    setProp(output, 'slot', 'asset:0123456789abcdef');

    const found = validateGenGraph(graph);
    expect(codes(found)).toEqual(['slot-is-asset']);
    expect(found[0]?.message).toContain('an asset is fixed content');
  });
});

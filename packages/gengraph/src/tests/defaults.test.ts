/**
 * The graph a host builds when an author asks for one rather than wiring it. What matters is
 * that it validates, that it binds the slot it was asked for, and that the two nodes a run
 * seeds are the ones feeding the picture, because a run seeds them by type name.
 */
import { bindSlots, defaultSlotGraph, validateGenGraph } from '../index.js';
import type { Graph, Node } from '../index.js';

const typeNames = (graph: Graph): string[] => graph.nodes.map((n) => n.def.typeName).sort();

function nodeOf(graph: Graph, typeName: string): Node {
  const node = graph.nodes.find((n) => n.def.typeName === typeName);
  if (node === undefined) throw new Error(`the default graph holds no ${typeName} node`);
  return node;
}

describe('the default graph a slot starts with', () => {
  it('wires the seeded prompt and refs into one image node, and validates', () => {
    const graph = defaultSlotGraph('plate:cafe/night');

    expect(typeNames(graph)).toEqual(['GenDerivedPrompt', 'GenImage', 'GenOutput', 'GenTaskRefs']);
    expect(validateGenGraph(graph)).toEqual([]);

    const image = nodeOf(graph, 'GenImage');
    expect(image.inputs.prompt!.edges).toHaveLength(1);
    expect(image.inputs.refs!.edges).toHaveLength(1);
    expect(nodeOf(graph, 'GenOutput').inputs.image!.edges).toHaveLength(1);
  });

  it('binds the slot it was asked for, through the rule a run reads', () => {
    const graph = defaultSlotGraph('shot:cafe/1');
    const { bound, conflicts } = bindSlots([{ graph }]);

    expect(conflicts).toEqual([]);
    expect(bound.get('shot:cafe/1')?.target).toBe(nodeOf(graph, 'GenOutput').id);
  });

  it('leaves an empty slot bound to nothing, so an author binds it later', () => {
    expect(bindSlots([{ graph: defaultSlotGraph('') }]).bound.size).toBe(0);
  });

  it('places its nodes apart, so nothing opens stacked on the node under it', () => {
    const graph = defaultSlotGraph('shot:cafe/1');
    const seen = new Set(graph.nodes.map((n) => `${n.pos[0]},${n.pos[1]}`));
    expect(seen.size).toBe(graph.nodes.length);
  });
});

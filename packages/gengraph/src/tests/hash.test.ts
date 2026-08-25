import { FloatProperty, StringProperty } from 'pathux-toolprop';

import { Graph, Node } from '../index.js';
import type { NodeDef } from '../index.js';
import { graphHashes, nodeHash } from '../state.js';
import { TestOutput, TestSource, registerTestNodes, setProp } from './__fixtures__/nodes.js';

registerTestNodes();

/** Two props with falsy defaults, which the zero and empty-string cases need. */
class HashProbe extends Node {
  static override graphDef(): NodeDef {
    return {
      typeName: 'HashProbe',
      props: { amount: new FloatProperty(0), note: new StringProperty('') },
    };
  }
}

/** A source feeding an output: the smallest graph an edit can propagate along. */
function pair(): { graph: Graph; source: TestSource; output: TestOutput } {
  const graph = new Graph();
  const source = new TestSource();
  const output = new TestOutput();

  graph.add(source);
  graph.add(output);
  graph.connect(source.outputs.blob, output.inputs.image);

  return { graph, source, output };
}

describe('node identity', () => {
  it('hashes two identically built graphs the same way', () => {
    const a = graphHashes(pair().graph);
    const b = graphHashes(pair().graph);

    expect([...a.values()]).toEqual([...b.values()]);
  });

  it('ignores position and label, so arranging the editor cannot re-run a node', () => {
    const { graph, output } = pair();
    const before = graphHashes(graph).get(output.id);

    output.pos[0] = 320;
    output.pos[1] = -40;
    output.label = 'the one that ships';

    expect(graphHashes(graph).get(output.id)).toBe(before);
  });

  it('propagates an upstream prop edit to every node below it', () => {
    const { graph, source, output } = pair();
    const before = graphHashes(graph);

    setProp(source, 'label', 'blue hour');
    const after = graphHashes(graph);

    expect(after.get(source.id)).not.toBe(before.get(source.id));
    expect(after.get(output.id)).not.toBe(before.get(output.id));
  });

  it('leaves a node the edit does not feed alone', () => {
    const { graph, source } = pair();
    const bystander = new TestSource();
    graph.add(bystander);

    const before = graphHashes(graph).get(bystander.id);
    setProp(source, 'label', 'blue hour');

    expect(graphHashes(graph).get(bystander.id)).toBe(before);
  });

  it('hashes zero and the empty string like any other value', () => {
    const node = new HashProbe();
    const atDefaults = nodeHash(node, {});

    setProp(node, 'amount', 0);
    setProp(node, 'note', '');
    expect(nodeHash(node, {})).toBe(atDefaults);

    setProp(node, 'amount', 1);
    expect(nodeHash(node, {})).not.toBe(atDefaults);
  });

  it('separates two types that carry the same props', () => {
    const probe = new HashProbe();
    const twin = new (class extends Node {
      static override graphDef(): NodeDef {
        return {
          typeName: 'HashProbeTwin',
          props: { amount: new FloatProperty(0), note: new StringProperty('') },
        };
      }
    })();

    expect(nodeHash(twin, {})).not.toBe(nodeHash(probe, {}));
  });
});

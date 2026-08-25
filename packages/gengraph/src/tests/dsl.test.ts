import { Graph, applyGraphDSL, graphToDSL, placeNewNodes } from '../index.js';
import {
  TestOutput,
  TestSource,
  propValue,
  registerTestNodes,
  setProp,
} from './__fixtures__/nodes.js';

registerTestNodes();

/** A source feeding an output, which is the smallest graph carrying a link. */
function pair(): { graph: Graph; source: TestSource; output: TestOutput } {
  const graph = new Graph();
  const source = new TestSource();
  const output = new TestOutput();

  graph.add(source);
  graph.add(output);
  graph.connect(source.outputs.blob, output.inputs.image);

  return { graph, source, output };
}

describe('the description a graph reads out as', () => {
  it('names every node and every link', () => {
    const { graph, source, output } = pair();
    const dsl = graphToDSL(graph);

    expect(dsl.nodes).toEqual([
      { id: source.id, type: 'TestSource' },
      { id: output.id, type: 'TestOutput' },
    ]);
    expect(dsl.links).toEqual([[source.id, 'blob', output.id, 'image']]);
  });

  it('carries an authored prop and leaves a default out', () => {
    const { graph, output } = pair();
    setProp(output, 'slot', 'shot:cafe/1');

    const dsl = graphToDSL(graph);

    expect(dsl.nodes?.[1]?.props).toEqual({ slot: 'shot:cafe/1' });
    expect(dsl.nodes?.[0]?.props).toBeUndefined();
  });

  it('carries no layout, so arranging the editor changes nothing it says', () => {
    const { graph, output } = pair();
    const before = graphToDSL(graph);

    output.pos[0] = 400;
    output.label = 'final frame';

    expect(graphToDSL(graph)).toEqual(before);
  });
});

describe('applying a description', () => {
  it('round-trips a graph as a no-op diff', () => {
    const { graph, source, output } = pair();
    setProp(output, 'slot', 'shot:cafe/1');

    const applied = applyGraphDSL(graph, graphToDSL(graph));

    expect(applied.diagnostics).toEqual([]);
    expect(applied.added).toEqual([]);
    expect(applied.removed).toEqual([]);
    expect(applied.kept).toEqual([source.id, output.id]);

    const rebuilt = applied.graph.nodeIdMap.get(output.id);
    expect(propValue(rebuilt!, 'slot')).toBe('shot:cafe/1');
    expect(rebuilt?.inputs.image?.edges).toHaveLength(1);
  });

  it('keeps position, size and label on a node that survives', () => {
    const { graph, output } = pair();
    output.pos[0] = 320;
    output.pos[1] = -80;
    output.size[0] = 200;
    output.label = 'final frame';

    const dsl = graphToDSL(graph);
    dsl.nodes?.forEach((n) => {
      if (n.id === output.id) n.props = { slot: 'shot:cafe/2' };
    });

    const kept = applyGraphDSL(graph, dsl).graph.nodeIdMap.get(output.id);

    expect([kept?.pos[0], kept?.pos[1]]).toEqual([320, -80]);
    expect(kept?.size[0]).toBe(200);
    expect(kept?.label).toBe('final frame');
    expect(propValue(kept!, 'slot')).toBe('shot:cafe/2');
  });

  it('reads a renamed id as a removal and an addition', () => {
    const { graph, source, output } = pair();
    const applied = applyGraphDSL(graph, {
      nodes: [
        { id: source.id, type: 'TestSource' },
        { id: 'renamed', type: 'TestOutput' },
      ],
      links: [[source.id, 'blob', 'renamed', 'image']],
    });

    expect(applied.kept).toEqual([source.id]);
    expect(applied.added).toEqual(['renamed']);
    expect(applied.removed).toEqual([output.id]);
  });

  it('places an added node clear of everything already placed', () => {
    const { graph, source, output } = pair();
    source.pos[0] = 0;
    output.pos[0] = 300;

    const applied = applyGraphDSL(graph, {
      nodes: [
        { id: source.id, type: 'TestSource' },
        { id: output.id, type: 'TestOutput' },
        { id: 'second', type: 'TestOutput' },
      ],
    });

    const added = applied.graph.nodeIdMap.get('second');
    expect(added!.pos[0]).toBeGreaterThan(output.pos[0] + output.size[0]);
  });

  it('hands back every diagnostic instead of throwing', () => {
    const { graph } = pair();
    const applied = applyGraphDSL(graph, { nodes: [{ id: 'a', type: 'NoSuchNode' }] });

    expect(applied.diagnostics.map((d) => d.code)).toEqual(['unknown-node-type']);
    expect(applied.diagnostics[0]?.message).toContain("'NoSuchNode'");
  });

  it('accepts the description as JSON text', () => {
    const { graph, source } = pair();
    const applied = applyGraphDSL(graph, JSON.stringify(graphToDSL(graph)));

    expect(applied.diagnostics).toEqual([]);
    expect(applied.kept).toContain(source.id);
  });

  it('leaves the graph alone when the text is not JSON', () => {
    const { graph } = pair();
    const applied = applyGraphDSL(graph, '{ nodes: [');

    expect(applied.graph).toBe(graph);
    expect(applied.diagnostics.map((d) => d.code)).toEqual(['bad-json']);
    expect(applied.added).toEqual([]);
    expect(applied.removed).toEqual([]);
  });
});

describe('placing new nodes', () => {
  it('starts at the origin when nothing is placed yet', () => {
    const fresh = [new TestSource(), new TestOutput()];
    placeNewNodes([], fresh);

    expect(fresh[0]!.pos[0]).toBe(0);
    expect(fresh[0]!.pos[1]).toBe(0);
    expect(fresh[1]!.pos[1]).toBeGreaterThan(0);
  });

  it('starts a second column once the first is full', () => {
    const fresh = Array.from({ length: 7 }, () => new TestSource());
    placeNewNodes([], fresh);

    expect(fresh[6]!.pos[0]).toBeGreaterThan(fresh[5]!.pos[0]);
    expect(fresh[6]!.pos[1]).toBe(fresh[0]!.pos[1]);
  });
});

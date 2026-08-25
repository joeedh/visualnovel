import { FloatProperty, StringProperty } from 'pathux-toolprop';

import {
  FloatSocket,
  Graph,
  Node,
  estimateGraph,
  mergeCostLines,
  refineEntry,
  registerGenNode,
} from '../index.js';
import type { GenCostLine, NodeDef, Sockets } from '../index.js';
import { TestBlobSocket, registerTestNodes, setProp } from './__fixtures__/nodes.js';

registerTestNodes();

/** The derived prompt, which a refine pass falls back to when nothing else is wired. */
class CostPrompt extends Node<Sockets, { text: TestBlobSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'CostPrompt',
      outputs: { text: new TestBlobSocket('out') },
      props: { model: new StringProperty('gemini-2.5-flash') },
    };
  }
}

/** An image node, which is what the refine input is wired to. */
class CostImage extends Node<
  { prompt: TestBlobSocket; refine: TestBlobSocket },
  { image: TestBlobSocket }
> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'CostImage',
      inputs: { prompt: new TestBlobSocket('in'), refine: new TestBlobSocket('in') },
      outputs: { image: new TestBlobSocket('out') },
      props: { model: new StringProperty('gemini-2.5-flash-image'), count: new FloatProperty(1) },
    };
  }
}

/** A critique, which spends only while an image is wired into it. */
class CostReview extends Node<{ image: TestBlobSocket }, { notes: TestBlobSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'CostReview',
      inputs: { image: new TestBlobSocket('in') },
      outputs: { notes: new TestBlobSocket('out') },
      props: { model: new StringProperty('gemini-2.5-flash') },
    };
  }
}

/** A node with no estimate at all, which every total must leave out. */
class CostFree extends Node<{ any: FloatSocket }, Sockets> {
  static override graphDef(): NodeDef {
    return { typeName: 'CostFree', inputs: { any: new FloatSocket('in') } };
  }
}

registerGenNode({
  cls: CostPrompt,
  refineFallback: true,
  estimate: (props) => [
    { service: 'text', model: String(props.model), unit: 'mtok-in', count: 0.001 },
  ],
});

registerGenNode({
  cls: CostImage,
  spends: true,
  refineInput: 'refine',
  estimate: (props) => [
    { service: 'image', model: String(props.model), unit: 'image', count: Number(props.count) },
  ],
});

registerGenNode({
  cls: CostReview,
  spends: true,
  estimate: (props, ctx) =>
    ctx.connected.has('image')
      ? [{ service: 'text', model: String(props.model), unit: 'mtok-out', count: 0.002 }]
      : [],
});

registerGenNode({ cls: CostFree });

/** Prompt into image into review, which is the shape a refine pass loops around. */
function chain(): { graph: Graph; prompt: CostPrompt; image: CostImage; review: CostReview } {
  const graph = new Graph();
  const prompt = new CostPrompt();
  const image = new CostImage();
  const review = new CostReview();

  graph.add(prompt);
  graph.add(image);
  graph.add(review);
  graph.connect(prompt.outputs.text, image.inputs.prompt);
  graph.connect(image.outputs.image, review.inputs.image);

  return { graph, prompt, image, review };
}

function countOf(lines: readonly GenCostLine[], model: string): number | undefined {
  return lines.find((l) => l.model === model)?.count;
}

describe('estimating a graph', () => {
  it('adds up what each node expects to spend', () => {
    const { graph } = chain();
    const estimate = estimateGraph(graph);

    expect(estimate.lines).toEqual([
      { service: 'text', model: 'gemini-2.5-flash', unit: 'mtok-in', count: 0.001 },
      { service: 'image', model: 'gemini-2.5-flash-image', unit: 'image', count: 1 },
      { service: 'text', model: 'gemini-2.5-flash', unit: 'mtok-out', count: 0.002 },
    ]);
  });

  it('leaves out a node type that declares no estimate', () => {
    const { graph } = chain();
    graph.add(new CostFree());

    expect(estimateGraph(graph).byNode.size).toBe(3);
  });

  it('tells a node which of its inputs are wired', () => {
    const graph = new Graph();
    const review = new CostReview();
    graph.add(review);

    expect(estimateGraph(graph).lines).toEqual([]);
  });

  it('counts a node twice when its prop asks for two calls', () => {
    const { graph, image } = chain();
    setProp(image, 'count', 2);

    expect(countOf(estimateGraph(graph).lines, 'gemini-2.5-flash-image')).toBe(2);
  });
});

describe('the refine multiplier', () => {
  it('multiplies the tail below a wired refine input and nothing above it', () => {
    const { graph, prompt, image } = chain();
    const refine = new CostPrompt();
    graph.add(refine);
    graph.connect(refine.outputs.text, image.inputs.refine);

    const estimate = estimateGraph(graph, { maxRefineAttempts: 4 });

    expect(estimate.refineTail).toEqual(expect.arrayContaining([image.id]));
    expect(estimate.refineTail).not.toContain(prompt.id);
    expect(countOf(estimate.lines, 'gemini-2.5-flash-image')).toBe(4);
    // Both prompts sit above the entry point and run once; the review below it runs four times.
    expect(estimate.lines.find((l) => l.unit === 'mtok-in')?.count).toBe(0.002);
    expect(estimate.lines.find((l) => l.unit === 'mtok-out')?.count).toBe(0.008);
  });

  it('falls back to the derived prompt while no refine input is wired', () => {
    const { graph, prompt } = chain();
    const estimate = estimateGraph(graph, { maxRefineAttempts: 3 });

    expect(refineEntry(graph)?.id).toBe(prompt.id);
    expect(estimate.refineTail).toHaveLength(3);
    expect(countOf(estimate.lines, 'gemini-2.5-flash-image')).toBe(3);
  });

  it('applies nothing at one attempt', () => {
    const { graph } = chain();
    const estimate = estimateGraph(graph, { maxRefineAttempts: 1 });

    expect(estimate.refineTail).toEqual([]);
    expect(countOf(estimate.lines, 'gemini-2.5-flash-image')).toBe(1);
  });
});

describe('merging cost lines', () => {
  it('adds up the lines naming the same service, model and unit', () => {
    const merged = mergeCostLines([
      { service: 'image', model: 'a', unit: 'image', count: 1 },
      { service: 'image', model: 'a', unit: 'image', count: 2 },
      { service: 'image', model: 'b', unit: 'image', count: 1 },
    ]);

    expect(merged).toEqual([
      { service: 'image', model: 'a', unit: 'image', count: 3 },
      { service: 'image', model: 'b', unit: 'image', count: 1 },
    ]);
  });

  it('keeps two units of one model apart', () => {
    const merged = mergeCostLines([
      { service: 'text', model: 'a', unit: 'mtok-in', count: 1 },
      { service: 'text', model: 'a', unit: 'mtok-out', count: 1 },
    ]);

    expect(merged).toHaveLength(2);
  });
});

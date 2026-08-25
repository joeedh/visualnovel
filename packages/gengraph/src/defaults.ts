/**
 * The graph an author gets when they ask for one rather than wiring it themselves. Every
 * host builds the same four nodes, so a graph created from the document tree, the CLI or
 * the authoring agent runs the same way the pipeline's own path does.
 */
import { Graph } from 'pathux-graph';
import type { Node } from 'pathux-graph';

import {
  GenDerivedPrompt,
  GenImage,
  GenOutput,
  GenTaskRefs,
  registerGenNodes,
} from './nodes/types.js';

/** How far apart the default layout sets nodes, in graph space. */
const COLUMN = 220;
const ROW = 120;

/**
 * Builds the graph a slot starts with: the host's derived prompt and reference pictures
 * feeding one image node, whose picture fills `slot`. The seeded nodes are the two the
 * pipeline fills in before a run, so the graph draws what the slot's task would have drawn.
 * An empty `slot` leaves the graph bound to nothing, so an author binds it later.
 */
export function defaultSlotGraph(slot: string): Graph {
  registerGenNodes();

  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const refs = new GenTaskRefs();
  const image = new GenImage();
  const output = new GenOutput();

  place(prompt, 0, 0);
  place(refs, 0, ROW);
  place(image, COLUMN, ROW / 2);
  place(output, COLUMN * 2, ROW / 2);

  for (const node of [prompt, refs, image, output]) {
    graph.add(node);
  }

  graph.connect(prompt.outputs.prompt, image.inputs.prompt);
  graph.connect(refs.outputs.refs, image.inputs.refs);
  graph.connect(image.outputs.image, output.inputs.image);

  output.props.slot?.setValue(slot);
  return graph;
}

function place(node: Node, x: number, y: number): void {
  node.pos[0] = x;
  node.pos[1] = y;
}

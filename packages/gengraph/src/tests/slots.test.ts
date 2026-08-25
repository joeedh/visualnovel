/**
 * Which graph draws which slot. The rule has one implementation because three callers read it —
 * the runner's index, the desktop document tree, and the CLI's report — and a slot two of them
 * disagreed about would be drawn by whichever happened to run last.
 */
import { Graph } from 'pathux-graph';

import { GenOutput, registerGenNodes } from '../nodes/types.js';
import { activeOutputs, bindSlots } from '../slots.js';

registerGenNodes();

/** A graph holding one output node per slot named, each active unless `inactive` lists it. */
function graphOf(slots: readonly string[], inactive: readonly string[] = []): Graph {
  const graph = new Graph();
  for (const slot of slots) {
    const output = new GenOutput();
    graph.add(output);
    output.props['slot']!.setValue(slot);
    if (inactive.includes(slot)) output.props['active']!.setValue(false);
  }
  return graph;
}

describe('the output nodes a run may target', () => {
  it('reports an output naming no slot, because a run can still terminate on it', () => {
    expect(activeOutputs(graphOf([''])).map((o) => o.slot)).toEqual(['']);
  });

  it('leaves out an output the author switched off', () => {
    const outputs = activeOutputs(graphOf(['portrait:aiko', 'plate:gate/day'], ['portrait:aiko']));
    expect(outputs.map((o) => o.slot)).toEqual(['plate:gate/day']);
  });
});

describe('binding slots to graphs', () => {
  it('binds each named slot to the graph whose active output claims it', () => {
    const { bound, conflicts } = bindSlots([
      { slug: 'portraits', graph: graphOf(['portrait:aiko']) },
      { slug: 'plates', graph: graphOf(['plate:gate/day', '']) },
    ]);

    expect([...bound].map(([slot, { entry }]) => [slot, entry.slug])).toEqual([
      ['portrait:aiko', 'portraits'],
      ['plate:gate/day', 'plates'],
    ]);
    expect(conflicts).toEqual([]);
  });

  it('names the output node inside the graph, so a run has a target', () => {
    const graph = graphOf(['portrait:aiko']);
    const { bound } = bindSlots([{ slug: 'portraits', graph }]);
    expect(bound.get('portrait:aiko')?.target).toBe(graph.nodes[0]?.id);
  });

  it('leaves a slot two graphs claim unbound rather than picking by load order', () => {
    const { bound, conflicts } = bindSlots([
      { slug: 'first', graph: graphOf(['portrait:aiko']) },
      { slug: 'second', graph: graphOf(['portrait:aiko', 'plate:gate/day']) },
    ]);

    expect(bound.has('portrait:aiko')).toBe(false);
    expect(conflicts).toEqual(['portrait:aiko']);
    // The conflict costs that one slot and nothing else the same graph draws.
    expect(bound.get('plate:gate/day')?.entry.slug).toBe('second');
  });

  it('counts two outputs on one slot inside a single graph as a conflict too', () => {
    const { bound, conflicts } = bindSlots([
      { slug: 'portraits', graph: graphOf(['portrait:aiko', 'portrait:aiko']) },
    ]);

    expect(bound.size).toBe(0);
    expect(conflicts).toEqual(['portrait:aiko']);
  });

  it('does not treat two outputs naming nothing as claiming the same slot', () => {
    const { bound, conflicts } = bindSlots([{ slug: 'draft', graph: graphOf(['', '']) }]);
    expect(bound.size).toBe(0);
    expect(conflicts).toEqual([]);
  });
});

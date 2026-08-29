import { GenImage, GenOutput, Graph, registerGenNodes } from '@vn/gengraph';
import type { GraphEdit } from 'pathux';

import {
  commandFor,
  contestedSlots,
  drawnSlot,
  genEditFor,
  newDocSync,
  noActiveOutput,
  shouldReload,
  type DocSync,
} from '../gengraph.js';

/** The kinds that reach a command, so a gesture the pane can write is never refused by mistake. */
describe('a gesture read as an edit', () => {
  it('writes a single drag as the same one-node move a multi-drag writes', () => {
    const one = genEditFor({ kind: 'moveNode', graphPath: '', nodeId: '3', x: 10, y: 20 });
    expect(one).toEqual({
      ok: true,
      edit: { op: 'moveNodes', moves: [{ node: '3', x: 10, y: 20 }] },
    });
  });

  it('reads a box drag and an auto-arrange the same way', () => {
    const moves = [
      { nodeId: '1', x: 0, y: 0 },
      { nodeId: '2', x: 40, y: 0 },
    ];
    const dragged = genEditFor({ kind: 'moveNodes', graphPath: '', moves });
    const arranged = genEditFor({ kind: 'arrange', graphPath: '', moves });
    expect(dragged).toEqual(arranged);
    expect(dragged).toMatchObject({ edit: { moves: [{ node: '1' }, { node: '2' }] } });
  });

  it('carries the drop position an added node was placed at', () => {
    expect(
      genEditFor({ kind: 'addNode', graphPath: '', nodeType: 'GenImage', x: 5, y: 7 }),
    ).toEqual({ ok: true, edit: { op: 'addNode', type: 'GenImage', pos: [5, 7] } });
  });

  it('carries the node id and the drop position a duplicate was placed at', () => {
    expect(genEditFor({ kind: 'duplicateNode', graphPath: '', nodeId: '3', x: 5, y: 7 })).toEqual({
      ok: true,
      edit: { op: 'duplicateNode', node: '3', pos: [5, 7] },
    });
  });

  it('names both ends of a link, and of the link a drag severs', () => {
    const ends = {
      graphPath: '',
      srcNode: '1',
      srcSocket: 'image',
      dstNode: '2',
      dstSocket: 'base',
    } as const;
    expect(genEditFor({ kind: 'connect', ...ends })).toEqual({
      ok: true,
      edit: { op: 'link', from: '1', fromSocket: 'image', to: '2', toSocket: 'base' },
    });
    // An unlink gesture always names its source, so it cuts the one link rather than the input.
    expect(genEditFor({ kind: 'disconnect', ...ends })).toEqual({
      ok: true,
      edit: { op: 'unlink', to: '2', toSocket: 'base', from: '1', fromSocket: 'image' },
    });
  });
});

/**
 * A refusal here is what stops path.ux performing an edit the application would never write. The
 * verdict has to be the refusal rather than silence, because `_dispatch` performs whatever
 * `check` accepts and then resyncs from a graph that never changed.
 */
describe('a gesture with no command behind it', () => {
  const KINDS = ['replaceNode', 'exposeEntry', 'reorderEntry', 'repointEntry', 'removeEntry'];

  it.each(KINDS)('refuses %s by name', (kind) => {
    const result = genEditFor({ kind, graphPath: '' } as unknown as GraphEdit);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it('answers for a kind it has never heard of rather than throwing', () => {
    const result = genEditFor({ kind: 'teleport', graphPath: '' } as unknown as GraphEdit);
    expect(result).toEqual({ ok: false, reason: "'teleport' is not offered here" });
  });
});

describe('the command an edit is written through', () => {
  it('sends a move list as the JSON the command parses', () => {
    const command = commandFor('plates', {
      op: 'moveNodes',
      moves: [{ node: 7, x: 1.5, y: -2 }],
    });
    expect(command.id).toBe('gengraph.moveNodes');
    expect(JSON.parse(String(command.props.moves))).toEqual([{ node: '7', x: 1.5, y: -2 }]);
  });

  it('places a node at the origin when the edit named no position', () => {
    expect(commandFor('plates', { op: 'addNode', type: 'GenOutput' }).props).toEqual({
      slug: 'plates',
      type: 'GenOutput',
      x: 0,
      y: 0,
    });
  });

  it('names the source node a duplicate carries, and where it lands', () => {
    const command = commandFor('plates', { op: 'duplicateNode', node: 3, pos: [10, 20] });
    expect(command.id).toBe('gengraph.duplicateNode');
    expect(command.props).toEqual({ slug: 'plates', node: '3', x: 10, y: 20 });
  });

  // The command reads an empty source as "cut every link into this input", which is what an
  // unlink carrying no source means.
  it('leaves the source empty when the edit named none', () => {
    expect(commandFor('plates', { op: 'unlink', to: '2', toSocket: 'base' }).props).toEqual({
      slug: 'plates',
      to: '2',
      toSocket: 'base',
      from: '',
      fromSocket: '',
    });
  });

  it('types a property value as text, whatever the value is', () => {
    const props = commandFor('plates', { op: 'setProp', node: '1', key: 'active', value: true });
    expect(props.props).toEqual({ slug: 'plates', node: '1', key: 'active', value: 'true' });
  });

  it('sends a whole-graph description as JSON', () => {
    const command = commandFor('plates', { op: 'apply', description: { nodes: [] } });
    expect(command.id).toBe('gengraph.apply');
    expect(JSON.parse(String(command.props.description))).toEqual({ nodes: [] });
  });

  it('names an id the same way whether it arrived as a string or a number', () => {
    expect(commandFor('plates', { op: 'removeNode', node: 4 }).props.node).toBe('4');
    expect(commandFor('plates', { op: 'setActiveOutput', node: '4' }).props.node).toBe('4');
  });
});

/**
 * A pane edits its own copy before the write that edit became has been answered, so an echo can
 * describe a state it has already moved past. These are the four cases that decides.
 */
describe('whether an echo means re-read', () => {
  const at = (over: Partial<DocSync>): DocSync => ({ ...newDocSync(), ...over });

  it('passes over every echo while a write this pane sent is outstanding', () => {
    // Both an echo naming a version and the version-less one an undo raises: the pane's copy is
    // ahead of anything main can report either way.
    expect(shouldReload(at({ inflight: 1 }), 7)).toBe(false);
    expect(shouldReload(at({ inflight: 1 }), undefined)).toBe(false);
  });

  // A refusal recorded while other writes are still outstanding is acted on by the one that
  // settles the last of them, so holding it here loses nothing.
  it('waits for the outstanding writes even when one has already refused', () => {
    expect(shouldReload(at({ inflight: 1, stale: true }), 4)).toBe(false);
  });

  it('passes over the echo of a write this pane made', () => {
    expect(shouldReload(at({ mine: 4, latest: 4 }), 4)).toBe(false);
  });

  it('passes over an echo older than what this pane has written', () => {
    expect(shouldReload(at({ mine: 4, latest: 4 }), 3)).toBe(false);
  });

  it('re-reads a write somebody else made', () => {
    expect(shouldReload(at({ mine: 4, latest: 5 }), 5)).toBe(true);
  });

  // The catch-up the last outstanding write performs: two echoes were passed over while it was in
  // flight, and only one of them was this pane's own.
  it('re-reads once the last outstanding write settles behind a foreign one', () => {
    expect(shouldReload(at({ mine: 4, latest: 6 }), 6)).toBe(true);
  });

  // The pane applies an edit before sending it, so a refused write leaves an edit on screen that
  // the file never took, and only a read puts it back.
  it('re-reads after a refusal, even though no version moved', () => {
    expect(shouldReload(at({ mine: 4, latest: 4, stale: true }), 4)).toBe(true);
  });

  it('re-reads a signal that named no version once nothing is outstanding', () => {
    expect(shouldReload(at({ mine: 4, latest: 4 }), undefined)).toBe(true);
  });

  it('starts out re-reading nothing', () => {
    expect(shouldReload(newDocSync(), 0)).toBe(false);
  });
});

registerGenNodes();

/** One output node per entry, each active unless the entry says otherwise. */
function graphOf(outputs: readonly { slot: string; active?: boolean }[]): Graph {
  const graph = new Graph();
  for (const entry of outputs) {
    const output = new GenOutput();
    graph.add(output);
    output.props['slot']!.setValue(entry.slot);
    if (entry.active === false) output.props['active']!.setValue(false);
  }
  return graph;
}

/**
 * A node added to a graph arrives active, so two outputs on one slot is a state an author reaches
 * by adding the second one. The pane reports it and keeps the button that resolves it live.
 */
describe('slots more than one active output claims', () => {
  it('finds nothing where each slot is claimed once', () => {
    const graph = graphOf([{ slot: 'portrait:aiko' }, { slot: 'plate:gate/day' }]);
    expect(contestedSlots(graph)).toEqual([]);
  });

  it('names a slot once, however many outputs claim it', () => {
    const claims = [
      { slot: 'portrait:aiko' },
      { slot: 'portrait:aiko' },
      { slot: 'portrait:aiko' },
    ];
    expect(contestedSlots(graphOf(claims))).toEqual(['portrait:aiko']);
  });

  it('reads an output the author stood down as no claim at all', () => {
    const graph = graphOf([{ slot: 'portrait:aiko' }, { slot: 'portrait:aiko', active: false }]);
    expect(contestedSlots(graph)).toEqual([]);
  });

  // Two outputs naming no slot bind nothing, so neither contests the other.
  it('leaves an unnamed slot out', () => {
    expect(contestedSlots(graphOf([{ slot: '' }, { slot: '' }]))).toEqual([]);
  });
});

/**
 * Unticking the last active output leaves a graph that draws nothing. The pane reports that
 * rather than refusing the edit, so the report has to tell the two silent cases apart.
 */
describe('a graph with nothing left to draw', () => {
  it('reports a graph whose every output was stood down', () => {
    const graph = graphOf([
      { slot: 'portrait:aiko', active: false },
      { slot: 'plate:gate/day', active: false },
    ]);
    expect(noActiveOutput(graph)).toBe(true);
  });

  it('says nothing while one output is still active', () => {
    const graph = graphOf([{ slot: 'portrait:aiko' }, { slot: 'plate:gate/day', active: false }]);
    expect(noActiveOutput(graph)).toBe(false);
  });

  // An output naming no slot still terminates a run, so a graph carrying one is not silent.
  it('counts an active output that names no slot', () => {
    expect(noActiveOutput(graphOf([{ slot: '' }]))).toBe(false);
  });

  it('says nothing about a graph with no output node yet', () => {
    const graph = new Graph();
    graph.add(new GenImage());
    expect(noActiveOutput(graph)).toBe(false);
    expect(noActiveOutput(new Graph())).toBe(false);
  });
});

/**
 * Which slot the pane's Asset button opens. It answers only where the graph can be held to one
 * picture, because the two silent states above bind no slot at all and a contested one binds
 * neither claimant.
 */
describe('the slot a graph draws', () => {
  it('names the one slot its active output claims', () => {
    const graph = graphOf([{ slot: 'portrait:aiko' }, { slot: 'plate:gate/day', active: false }]);
    expect(drawnSlot(graph)).toBe('portrait:aiko');
  });

  it('names none where two outputs are live, however they claim', () => {
    expect(drawnSlot(graphOf([{ slot: 'portrait:aiko' }, { slot: 'plate:gate/day' }]))).toBe('');
    expect(drawnSlot(graphOf([{ slot: 'portrait:aiko' }, { slot: 'portrait:aiko' }]))).toBe('');
  });

  it('names none for a graph that draws nothing, or nothing it can name', () => {
    expect(drawnSlot(graphOf([{ slot: 'portrait:aiko', active: false }]))).toBe('');
    expect(drawnSlot(graphOf([{ slot: '' }]))).toBe('');
    expect(drawnSlot(new Graph())).toBe('');
  });
});

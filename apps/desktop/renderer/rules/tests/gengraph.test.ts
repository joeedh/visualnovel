import {
  GenImage,
  GenOutput,
  GenTemplate,
  Graph,
  GroupNode,
  createGroup,
  registerGenNodes,
  type NodePropName,
} from '@vn/gengraph';
import type { GraphEdit } from 'pathux';

import {
  commandFor,
  contestedSlots,
  docPathFor,
  drawnSlot,
  genEditFor,
  keyOf,
  newDocSync,
  noActiveOutput,
  reloadsOnAck,
  shouldReload,
  targetFor,
  type DocSync,
  type EditTarget,
} from '../gengraph.js';

/** A prop name as path.ux types one, which is a string it brands. */
const SEED = 'seed' as unknown as NodePropName;

/** The graph itself, which is where every edit went before groups. */
const ROOT: EditTarget = { slug: 'plates', group: '', prefix: [] };

/** A definition level: the edits go to `lib/wash.json`, under the definition's own ids. */
const DEFINITION: EditTarget = { slug: 'plates', group: 'wash', prefix: [] };

/** Inside an instance of a group at the root: the ids are keyed under the instance's. */
const INSTANCE: EditTarget = { slug: 'plates', group: '', prefix: ['4'] };

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

  // The view fills no ref of its own, since the renderer's graph has no `newGroupRef` seam; main
  // allocates one. A ref the gesture did carry is passed on as the name to use.
  it('groups the selection under no name unless the gesture named one', () => {
    const group = {
      kind: 'createGroup' as const,
      graphPath: '',
      storePath: '',
      nodeIds: ['1', '2'],
    };
    expect(genEditFor(group)).toEqual({
      ok: true,
      edit: { op: 'createGroup', nodes: ['1', '2'] },
    });
    expect(genEditFor({ ...group, ref: 'wash' })).toEqual({
      ok: true,
      edit: { op: 'createGroup', nodes: ['1', '2'], ref: 'wash' },
    });
  });

  it('reads an added GroupNode as an instance of the definition it names', () => {
    expect(
      genEditFor({
        kind: 'addNode',
        graphPath: '',
        nodeType: 'GroupNode',
        ref: 'wash',
        x: 5,
        y: 7,
      }),
    ).toEqual({ ok: true, edit: { op: 'addGroup', ref: 'wash', pos: [5, 7] } });
  });

  it('carries an ungroup and the definition edits through by name', () => {
    expect(genEditFor({ kind: 'ungroup', graphPath: '', nodeId: '4' })).toEqual({
      ok: true,
      edit: { op: 'ungroup', node: '4' },
    });
    expect(
      genEditFor({
        kind: 'exposeEntry',
        graphPath: '',
        entry: { kind: 'prop', nodeId: '1', propKey: 'template', label: 'Prompt' },
      }),
    ).toEqual({
      ok: true,
      edit: { op: 'expose', kind: 'prop', node: '1', key: 'template', label: 'Prompt' },
    });
    expect(
      genEditFor({ kind: 'exposeEntry', graphPath: '', entry: { kind: 'nodeUI', nodeId: '1' } }),
    ).toEqual({ ok: true, edit: { op: 'expose', kind: 'nodeUI', node: '1' } });
    expect(genEditFor({ kind: 'reorderEntry', graphPath: '', from: 2, to: 0 })).toEqual({
      ok: true,
      edit: { op: 'reorderExposed', from: 2, to: 0 },
    });
    expect(
      genEditFor({ kind: 'repointEntry', graphPath: '', index: 1, nodeId: '2', propKey: SEED }),
    ).toEqual({ ok: true, edit: { op: 'repointExposed', index: 1, node: '2', key: 'seed' } });
    expect(genEditFor({ kind: 'removeEntry', graphPath: '', index: 1 })).toEqual({
      ok: true,
      edit: { op: 'unexpose', index: 1 },
    });
    expect(
      genEditFor({
        kind: 'addBoundary',
        graphPath: '',
        dir: 'in',
        key: 'extra',
        socketType: 'TextSocket',
      }),
    ).toEqual({
      ok: true,
      edit: { op: 'addBoundary', dir: 'in', key: 'extra', type: 'TextSocket' },
    });
    expect(genEditFor({ kind: 'removeBoundary', graphPath: '', dir: 'out', key: 'extra' })).toEqual(
      {
        ok: true,
        edit: { op: 'removeBoundary', dir: 'out', key: 'extra' },
      },
    );
  });
});

/**
 * A refusal here is what stops path.ux performing an edit the application would never write. The
 * verdict has to be the refusal rather than silence, because `_dispatch` performs whatever
 * `check` accepts and then resyncs from a graph that never changed.
 */
describe('a gesture with no command behind it', () => {
  it('refuses retyping a node by name', () => {
    const result = genEditFor({ kind: 'replaceNode', graphPath: '' } as unknown as GraphEdit);
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
    const command = commandFor(ROOT, {
      op: 'moveNodes',
      moves: [{ node: 7, x: 1.5, y: -2 }],
    });
    expect(command.id).toBe('gengraph.moveNodes');
    expect(JSON.parse(String(command.props.moves))).toEqual([{ node: '7', x: 1.5, y: -2 }]);
  });

  it('places a node at the origin when the edit named no position', () => {
    expect(commandFor(ROOT, { op: 'addNode', type: 'GenOutput' }).props).toEqual({
      slug: 'plates',
      type: 'GenOutput',
      x: 0,
      y: 0,
    });
  });

  it('names the source node a duplicate carries, and where it lands', () => {
    const command = commandFor(ROOT, { op: 'duplicateNode', node: 3, pos: [10, 20] });
    expect(command.id).toBe('gengraph.duplicateNode');
    expect(command.props).toEqual({ slug: 'plates', node: '3', x: 10, y: 20 });
  });

  // The command reads an empty source as "cut every link into this input", which is what an
  // unlink carrying no source means.
  it('leaves the source empty when the edit named none', () => {
    expect(commandFor(ROOT, { op: 'unlink', to: '2', toSocket: 'base' }).props).toEqual({
      slug: 'plates',
      to: '2',
      toSocket: 'base',
      from: '',
      fromSocket: '',
    });
  });

  it('types a property value as text, whatever the value is', () => {
    const props = commandFor(ROOT, { op: 'setProp', node: '1', key: 'active', value: true });
    expect(props.props).toEqual({ slug: 'plates', node: '1', key: 'active', value: 'true' });
  });

  it('sends a whole-graph description as JSON', () => {
    const command = commandFor(ROOT, { op: 'apply', description: { nodes: [] } });
    expect(command.id).toBe('gengraph.apply');
    expect(JSON.parse(String(command.props.description))).toEqual({ nodes: [] });
  });

  it('names an id the same way whether it arrived as a string or a number', () => {
    expect(commandFor(ROOT, { op: 'removeNode', node: 4 }).props.node).toBe('4');
    expect(commandFor(ROOT, { op: 'setActiveOutput', node: '4' }).props.node).toBe('4');
  });

  // The pane sends the selection and no name: main allocates the ref, which is why this edit
  // reloads on acknowledgement rather than being applied here.
  it('groups the selection under the name main allocates', () => {
    const command = commandFor(ROOT, { op: 'createGroup', nodes: ['1', 2] });
    expect(command.id).toBe('gengraph.createGroup');
    expect(command.props).toEqual({ slug: 'plates', nodes: '1,2', name: '' });
    expect(reloadsOnAck('createGroup')).toBe(true);
    expect(reloadsOnAck('ungroup')).toBe(true);
    expect(reloadsOnAck('addGroup')).toBe(true);
    expect(reloadsOnAck('setProp')).toBe(false);
  });

  it('names the definition an instance stands for, and where it lands', () => {
    expect(commandFor(ROOT, { op: 'addGroup', ref: 'wash', pos: [3, 4] })).toEqual({
      id: 'gengraph.addGroup',
      props: { slug: 'plates', ref: 'wash', x: 3, y: 4 },
    });
    expect(commandFor(ROOT, { op: 'ungroup', node: 4 }).props).toEqual({
      slug: 'plates',
      node: '4',
    });
  });

  // The commands default `group` to the graph itself, so a root edit carries none and reads the
  // same as it did before groups existed.
  it('carries the definition a level is inside, and nothing at the root', () => {
    const edit = { op: 'removeNode', node: '2' } as const;
    expect(commandFor(ROOT, edit).props).not.toHaveProperty('group');
    expect(commandFor(DEFINITION, edit).props).toEqual({
      slug: 'plates',
      node: '2',
      group: 'wash',
    });
    expect(commandFor(DEFINITION, { op: 'createGroup', nodes: ['1'] }).props.group).toBe('wash');
    expect(commandFor(DEFINITION, { op: 'addGroup', ref: 'other' }).props.group).toBe('wash');
  });

  // An instance's inner node is main's `<instance>/<id>`, on every prop that names a node.
  it('keys a node inside an instance under the instance', () => {
    expect(keyOf(INSTANCE, 2)).toBe('4/2');
    expect(keyOf(ROOT, 2)).toBe('2');
    expect(
      commandFor(INSTANCE, { op: 'setProp', node: 2, key: 'template', value: 'x' }).props,
    ).toEqual({ slug: 'plates', node: '4/2', key: 'template', value: 'x' });
    expect(
      commandFor(INSTANCE, { op: 'link', from: 1, fromSocket: 'a', to: 2, toSocket: 'b' }).props,
    ).toMatchObject({ from: '4/1', to: '4/2' });
    const moves = commandFor(INSTANCE, { op: 'moveNodes', moves: [{ node: 1, x: 0, y: 0 }] });
    expect(JSON.parse(String(moves.props.moves))).toEqual([{ node: '4/1', x: 0, y: 0 }]);
  });

  it('addresses a definition edit to the definition alone', () => {
    expect(
      commandFor(DEFINITION, { op: 'expose', kind: 'prop', node: 1, key: 'template' }).props,
    ).toEqual({ group: 'wash', node: '1', key: 'template', label: '' });
    expect(commandFor(DEFINITION, { op: 'expose', kind: 'nodeUI', node: 1 }).props).toEqual({
      group: 'wash',
      node: '1',
      key: '',
      label: '',
    });
    expect(commandFor(DEFINITION, { op: 'unexpose', index: 2 })).toEqual({
      id: 'gengraph.unexpose',
      props: { group: 'wash', index: 2 },
    });
    expect(commandFor(DEFINITION, { op: 'reorderExposed', from: 2, to: 0 }).props).toEqual({
      group: 'wash',
      from: 2,
      to: 0,
    });
    expect(
      commandFor(DEFINITION, { op: 'repointExposed', index: 1, node: 2, key: 'seed' }).props,
    ).toEqual({ group: 'wash', index: 1, node: '2', key: 'seed' });
    expect(
      commandFor(DEFINITION, { op: 'addBoundary', dir: 'in', key: 'extra', type: 'TextSocket' }),
    ).toEqual({
      id: 'gengraph.addBoundary',
      props: { group: 'wash', dir: 'in', key: 'extra', type: 'TextSocket' },
    });
    expect(commandFor(DEFINITION, { op: 'removeBoundary', dir: 'out', key: 'extra' })).toEqual({
      id: 'gengraph.removeBoundary',
      props: { group: 'wash', dir: 'out', key: 'extra' },
    });
  });

  it('writes a definition level to its own file and the rest to the graph', () => {
    expect(docPathFor(ROOT)).toBe('vngen/work/graphs/plates.json');
    expect(docPathFor(INSTANCE)).toBe('vngen/work/graphs/plates.json');
    expect(docPathFor(DEFINITION)).toBe('vngen/work/graphs/lib/wash.json');
  });
});

/**
 * The target is read off the view's descent, which names each step by node id and by which side
 * of the group it went into. A definition's ids are its own; an instance's are keyed.
 */
describe('the target a level writes to', () => {
  /** A root graph holding one instance of a one-node definition, and the instance itself. */
  function grouped(): { graph: Graph; instance: GroupNode; inner: string | number } {
    const graph = new Graph();
    const template = new GenTemplate();
    graph.add(template);
    const inner = template.id;
    createGroup(graph, [template.id], 'wash');
    const instance = graph.nodes.find((node) => node instanceof GroupNode) as GroupNode;
    return { graph, instance, inner };
  }

  it('is the graph itself at the root', () => {
    const { graph } = grouped();
    expect(targetFor('plates', graph, [])).toEqual(ROOT);
  });

  it('is the definition at a definition level, under its own ids', () => {
    const { graph, instance } = grouped();
    const target = targetFor('plates', graph, [{ nodeId: instance.id, into: 'definition' }]);
    expect(target).toEqual({ slug: 'plates', group: 'wash', prefix: [] });
  });

  it('is the graph keyed by the instance inside an instance', () => {
    const { graph, instance } = grouped();
    const target = targetFor('plates', graph, [{ nodeId: instance.id, into: 'instance' }]);
    expect(target).toEqual({ slug: 'plates', group: '', prefix: [String(instance.id)] });
  });

  it('answers nothing for a step that no longer resolves', () => {
    const { graph, instance, inner } = grouped();
    expect(targetFor('plates', graph, [{ nodeId: 'gone', into: 'instance' }])).toBeUndefined();
    // A step into a node that is no group, and a step past a step that failed.
    expect(targetFor('plates', graph, [{ nodeId: inner, into: 'instance' }])).toBeUndefined();
    expect(
      targetFor('plates', graph, [
        { nodeId: 'gone', into: 'definition' },
        { nodeId: instance.id, into: 'instance' },
      ]),
    ).toBeUndefined();
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

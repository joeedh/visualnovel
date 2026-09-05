/**
 * The rules one edit passes before a graph changes. Both the desktop `gengraph.*` commands and
 * the authoring agent's graph tool decide through `decideGenEdit`, so a refusal proved here is
 * the sentence both surfaces show.
 */
import {
  Graph,
  decideGenEdit,
  readGenPropValue,
  registerGenNodes,
  GenImage,
  GenImageFile,
  GenOutput,
  GenRefList,
  GenTemplate,
} from '../index.js';
import type { GenEdit, GenEditResult } from '../index.js';

registerGenNodes();

const reason = (r: GenEditResult): string => (r.ok ? '' : r.reason);
const note = (r: GenEditResult): string => (r.ok ? r.note : `refused: ${r.reason}`);

/** Applies an edit, failing the test with the refusal rather than the shape of the result. */
function apply(graph: Graph, edit: GenEdit): Graph {
  const decided = decideGenEdit(graph, edit);
  if (!decided.ok) throw new Error(decided.reason);
  return decided.apply().graph;
}

/** An image node feeding an output, which is the smallest graph that fills a slot. */
function bound(): { graph: Graph; image: GenImage; output: GenOutput } {
  const graph = new Graph();
  const image = new GenImage();
  const output = new GenOutput();
  graph.add(image);
  graph.add(output);
  graph.connect(image.outputs.image, output.inputs.image);
  return { graph, image, output };
}

describe('adding and removing a node', () => {
  it('adds a registered type and reports the id it took', () => {
    const graph = new Graph();
    const decided = decideGenEdit(graph, { op: 'addNode', type: 'GenOutput' });
    expect(note(decided)).toBe('Adds a Output image node.');
    if (!decided.ok) return;

    const { node } = decided.apply();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodeIdMap.get(node!)?.def.typeName).toBe('GenOutput');
  });

  it('places a node where it is asked to, and finds it room otherwise', () => {
    const graph = new Graph();
    apply(graph, { op: 'addNode', type: 'GenOutput', pos: [40, 90] });
    expect([...graph.nodes[0]!.pos]).toEqual([40, 90]);

    apply(graph, { op: 'addNode', type: 'GenOutput' });
    expect([...graph.nodes[1]!.pos]).not.toEqual([...graph.nodes[0]!.pos]);
  });

  it('refuses a type nothing registered, and says a plugin may be missing', () => {
    const graph = new Graph();
    expect(reason(decideGenEdit(graph, { op: 'addNode', type: 'GenUpscale' }))).toBe(
      "there is no node type 'GenUpscale' registered here; the plugin providing it may not be installed",
    );
  });

  it('removes a node and counts the links going with it', () => {
    const { graph, output } = bound();
    const decided = decideGenEdit(graph, { op: 'removeNode', node: output.id });
    expect(note(decided)).toBe('Removes the Output image node and the 1 link it carries.');

    apply(graph, { op: 'removeNode', node: output.id });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.outputs.image!.edges).toHaveLength(0);
  });

  it('refuses a node this graph does not hold', () => {
    const graph = new Graph();
    expect(reason(decideGenEdit(graph, { op: 'removeNode', node: 7 }))).toBe(
      'this graph holds no node 7',
    );
  });
});

describe('duplicating a node', () => {
  it('copies the authored values onto a fresh id, and carries no link', () => {
    const { graph, image, output } = bound();
    image.props['model']!.setValue('gemini-3');

    const decided = decideGenEdit(graph, { op: 'duplicateNode', node: image.id, pos: [50, 60] });
    expect(note(decided)).toBe('Adds a copy of the Generate image node.');
    if (!decided.ok) return;

    const { node } = decided.apply();
    expect(node).not.toBe(image.id);
    const copy = graph.nodeIdMap.get(node!)!;
    expect(copy.props['model']!.getValue()).toBe('gemini-3');
    expect([...copy.pos]).toEqual([50, 60]);
    expect(copy.outputs.image!.edges).toHaveLength(0);
    // The source is untouched, output still fed by the original alone.
    expect(output.inputs.image!.edges).toHaveLength(1);
  });

  it('places a duplicate where an add would land, when asked for no position', () => {
    const { graph, image } = bound();
    const decided = decideGenEdit(graph, { op: 'duplicateNode', node: image.id });
    if (!decided.ok) throw new Error(decided.reason);

    const { node } = decided.apply();
    expect([...graph.nodeIdMap.get(node!)!.pos]).not.toEqual([...image.pos]);
  });

  it('copies the value rather than sharing the property, so the two drift independently', () => {
    const { graph, image } = bound();
    image.props['model']!.setValue('gemini-3');

    const decided = decideGenEdit(graph, { op: 'duplicateNode', node: image.id });
    if (!decided.ok) throw new Error(decided.reason);
    const { node } = decided.apply();

    image.props['model']!.setValue('gemini-4');
    expect(graph.nodeIdMap.get(node!)!.props['model']!.getValue()).toBe('gemini-3');
  });

  it('refuses a node this graph does not hold', () => {
    const graph = new Graph();
    expect(reason(decideGenEdit(graph, { op: 'duplicateNode', node: 7 }))).toBe(
      'this graph holds no node 7',
    );
  });
});

describe('linking and unlinking', () => {
  it('feeds an input, and says which node feeds which', () => {
    const graph = new Graph();
    const image = new GenImage();
    const output = new GenOutput();
    graph.add(image);
    graph.add(output);

    const edit: GenEdit = {
      op        : 'link',
      from      : image.id,
      fromSocket: 'image',
      to        : output.id,
      toSocket  : 'image',
    };
    expect(note(decideGenEdit(graph, edit))).toBe(
      "Feeds 'image' on the Output image node from the Generate image node.",
    );
    apply(graph, edit);
    expect(output.inputs.image.edges).toHaveLength(1);
  });

  it('says a second link into a single input replaces what was there', () => {
    const { graph, output } = bound();
    const other = new GenImageFile();
    graph.add(other);

    const edit: GenEdit = {
      op        : 'link',
      from      : other.id,
      fromSocket: 'image',
      to        : output.id,
      toSocket  : 'image',
    };
    expect(note(decideGenEdit(graph, edit))).toBe(
      "Rewires 'image' on the Output image node, replacing what feeds it.",
    );
    apply(graph, edit);
    expect(output.inputs.image.edges).toHaveLength(1);
  });

  it('refuses a socket the type does not declare, naming the side it is on', () => {
    const { graph, image, output } = bound();
    expect(
      reason(
        decideGenEdit(graph, {
          op        : 'link',
          from      : image.id,
          fromSocket: 'picture',
          to        : output.id,
          toSocket  : 'image',
        }),
      ),
    ).toBe("node type 'GenImage' declares no output 'picture'");
    expect(
      reason(
        decideGenEdit(graph, {
          op        : 'link',
          from      : image.id,
          fromSocket: 'image',
          to        : output.id,
          toSocket  : 'picture',
        }),
      ),
    ).toBe("node type 'GenOutput' declares no input 'picture'");
  });

  it('refuses a link between socket types nothing coerces', () => {
    const graph = new Graph();
    const image = new GenImage();
    const template = new GenTemplate();
    graph.add(image);
    graph.add(template);

    expect(
      reason(
        decideGenEdit(graph, {
          op        : 'link',
          from      : image.id,
          fromSocket: 'image',
          to        : template.id,
          toSocket  : 'varA',
        }),
      ),
    ).toBe("a 'image' output cannot feed the 'text' input 'varA'");
  });

  it('refuses a link that closes a cycle, because a cycle has no order', () => {
    const graph = new Graph();
    const a = new GenTemplate();
    const b = new GenTemplate();
    graph.add(a);
    graph.add(b);
    graph.connect(a.outputs.text, b.inputs.varA);

    expect(
      reason(
        decideGenEdit(graph, {
          op        : 'link',
          from      : b.id,
          fromSocket: 'text',
          to        : a.id,
          toSocket  : 'varA',
        }),
      ),
    ).toBe('linking these makes a cycle, and a cycle has no order to run in');
  });

  it('severs what feeds an input when no source is named', () => {
    const graph = new Graph();
    const list = new GenRefList();
    const one = new GenImage();
    graph.add(list);
    graph.add(one);
    graph.connect(one.outputs.image, list.inputs.a);

    const edit: GenEdit = { op: 'unlink', to: list.id, toSocket: 'a' };
    expect(note(decideGenEdit(graph, edit))).toBe(
      "Severs the 1 link into 'a' on the Reference list node.",
    );
    apply(graph, edit);
    expect(list.inputs.a.edges).toHaveLength(0);
  });

  it('severs one named link and leaves the input beside it alone', () => {
    const graph = new Graph();
    const list = new GenRefList();
    const one = new GenImage();
    const two = new GenImageFile();
    graph.add(list);
    graph.add(one);
    graph.add(two);
    graph.connect(one.outputs.image, list.inputs.a);
    graph.connect(two.outputs.image, list.inputs.b);

    apply(graph, { op: 'unlink', to: list.id, toSocket: 'b', from: two.id, fromSocket: 'image' });
    expect(list.inputs.b.edges).toHaveLength(0);
    expect(list.inputs.a.edges[0]!.owningNode).toBe(one);
  });

  it('refuses unlinking what was never linked', () => {
    const { graph, image, output } = bound();
    expect(reason(decideGenEdit(graph, { op: 'unlink', to: image.id, toSocket: 'prompt' }))).toBe(
      "nothing feeds 'prompt' on the Generate image node",
    );

    const other = new GenImageFile();
    graph.add(other);
    expect(
      reason(
        decideGenEdit(graph, {
          op        : 'unlink',
          to        : output.id,
          toSocket  : 'image',
          from      : other.id,
          fromSocket: 'image',
        }),
      ),
    ).toBe("the Image file node does not feed 'image' on the Output image node");
  });
});

describe('setting a prop', () => {
  it('sets a declared prop and quotes what it set', () => {
    const { graph, image } = bound();
    const edit: GenEdit = { op: 'setProp', node: image.id, key: 'aspect', value: '3:4' };
    expect(note(decideGenEdit(graph, edit))).toBe(
      'Sets \'aspect\' on the Generate image node to "3:4".',
    );
    apply(graph, edit);
    expect(image.props.aspect!.getValue()).toBe('3:4');
  });

  it('refuses a prop the type does not declare', () => {
    const { graph, image } = bound();
    expect(
      reason(decideGenEdit(graph, { op: 'setProp', node: image.id, key: 'style', value: 'x' })),
    ).toBe("node type 'GenImage' declares no prop or editable input 'style'");
  });

  it('refuses a value of the wrong kind', () => {
    const { graph, output } = bound();
    expect(
      reason(decideGenEdit(graph, { op: 'setProp', node: output.id, key: 'active', value: 'yes' })),
    ).toBe("'active' on a Output image node takes a boolean value");
  });

  it('refuses a slot that does not parse, and one addressing fixed content', () => {
    const { graph, output } = bound();
    expect(
      reason(decideGenEdit(graph, { op: 'setProp', node: output.id, key: 'slot', value: 'cafe' })),
    ).toBe("'cafe' is not a slot address");
    expect(
      reason(
        decideGenEdit(graph, {
          op   : 'setProp',
          node : output.id,
          key  : 'slot',
          value: 'asset:abc123',
        }),
      ),
    ).toMatch(/addresses an asset rather than a slot/);
  });

  it('allows clearing a slot, which is how an unbound graph is authored', () => {
    const { graph, output } = bound();
    apply(graph, { op: 'setProp', node: output.id, key: 'slot', value: 'shot:cafe/1' });
    apply(graph, { op: 'setProp', node: output.id, key: 'slot', value: '' });
    expect(output.props.slot!.getValue()).toBe('');
  });
});

describe('reading a prop value written as text', () => {
  it('reads text as the kind the property takes', () => {
    const { graph, image, output } = bound();
    expect(readGenPropValue(graph, output.id, 'active', 'false')).toEqual({
      ok   : true,
      value: false,
    });
    expect(readGenPropValue(graph, image.id, 'aspect', ' 3:4 ')).toEqual({
      ok   : true,
      value: ' 3:4 ',
    });
  });

  it('refuses text a typed property cannot be read out of', () => {
    const { graph, output } = bound();
    const read = readGenPropValue(graph, output.id, 'active', 'sometimes');
    expect(read.ok).toBe(false);
    expect(read.ok ? '' : read.reason).toBe("'active' on a Output image node takes true or false");
  });
});

describe('choosing the active output', () => {
  it('stands down the rival claiming the same slot, and leaves other slots alone', () => {
    const { graph, output } = bound();
    const rival = new GenOutput();
    const elsewhere = new GenOutput();
    graph.add(rival);
    graph.add(elsewhere);
    apply(graph, { op: 'setProp', node: output.id, key: 'slot', value: 'shot:cafe/1' });
    apply(graph, { op: 'setProp', node: rival.id, key: 'slot', value: 'shot:cafe/1' });
    apply(graph, { op: 'setProp', node: elsewhere.id, key: 'slot', value: 'shot:cafe/2' });
    apply(graph, { op: 'setProp', node: output.id, key: 'active', value: false });

    const edit: GenEdit = { op: 'setActiveOutput', node: output.id };
    expect(note(decideGenEdit(graph, edit))).toBe(
      "Makes this the output run for 'shot:cafe/1', and stands 1 output down.",
    );
    apply(graph, edit);

    expect(output.props.active!.getValue()).toBe(true);
    expect(rival.props.active!.getValue()).toBe(false);
    expect(elsewhere.props.active!.getValue()).toBe(true);
  });

  it('refuses a node that fills no slot', () => {
    const { graph, image } = bound();
    expect(reason(decideGenEdit(graph, { op: 'setActiveOutput', node: image.id }))).toBe(
      'the Generate image node fills no slot, so it cannot be an active output',
    );
  });
});

describe('moving nodes', () => {
  it('writes every position in one edit, and names the node when there is only one', () => {
    const { graph, image, output } = bound();

    expect(
      note(decideGenEdit(graph, { op: 'moveNodes', moves: [{ node: image.id, x: 5, y: 6 }] })),
    ).toBe('Moves the Generate image node.');

    const edit: GenEdit = {
      op   : 'moveNodes',
      moves: [
        { node: image.id, x: 5, y: 6 },
        { node: output.id, x: 70, y: 80 },
      ],
    };
    expect(note(decideGenEdit(graph, edit))).toBe('Moves 2 nodes.');
    apply(graph, edit);

    expect([...image.pos]).toEqual([5, 6]);
    expect([...output.pos]).toEqual([70, 80]);
  });

  it('refuses a move naming no node at all', () => {
    expect(reason(decideGenEdit(new Graph(), { op: 'moveNodes', moves: [] }))).toBe(
      'this move names no node',
    );
  });

  it('moves nothing when one node in the drag has gone, and lists every problem', () => {
    const { graph, image } = bound();
    const before = [...image.pos];

    const decided = decideGenEdit(graph, {
      op   : 'moveNodes',
      moves: [
        { node: image.id, x: 5, y: 6 },
        { node: 4242, x: 7, y: 8 },
      ],
    });

    expect(reason(decided)).toBe('this graph holds no node 4242');
    expect(decided.ok ? [] : decided.details).toEqual(['this graph holds no node 4242']);
    expect([...image.pos]).toEqual(before);
  });

  it('refuses a position that is not a number, because the file would carry it', () => {
    const { graph, image } = bound();
    expect(
      reason(decideGenEdit(graph, { op: 'moveNodes', moves: [{ node: image.id, x: NaN, y: 0 }] })),
    ).toBe('the Generate image node was moved to a position that is not a number');
  });
});

describe('replacing the whole graph with a description', () => {
  it('keeps a node the description names by id and counts what changed', () => {
    const { graph, image, output } = bound();
    const decided = decideGenEdit(graph, {
      op         : 'apply',
      description: {
        nodes: [
          { id: image.id, type: 'GenImage' },
          { id: output.id, type: 'GenOutput' },
          { id: 'fresh', type: 'GenTemplate' },
        ],
        links: [[image.id, 'image', output.id, 'image']],
      },
    });
    expect(note(decided)).toBe('Replaces the graph: keeps 2 nodes, adds 1, removes 0.');
    if (!decided.ok) return;
    expect(decided.apply().graph.nodes).toHaveLength(3);
  });

  it('refuses a description with a problem in it, quoting the first', () => {
    const { graph } = bound();
    const decided = decideGenEdit(graph, {
      op         : 'apply',
      description: { nodes: [{ id: 'fresh', type: 'GenUpscale' }], links: [] },
    });
    expect(reason(decided)).toMatch(/^the description cannot be applied: /);
  });
});

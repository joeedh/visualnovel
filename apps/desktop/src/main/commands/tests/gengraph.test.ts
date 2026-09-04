/**
 * The `gengraph.*` commands over a real project directory. They are the only write path to
 * `vngen/work/graphs/`, so what is checked here is that the document on disk is what the edits
 * said, that each declared refusal comes back with its own sentence, and that undo restores the
 * document the way it restores a scene.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestProps } from '@vn/commands';
import type { CommandContext } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import { GroupNode, bindSlots } from '@vn/gengraph';
import { openGit } from '@vn/git';
import type { UiEffect } from '../../../shared/ipc.js';
import { readGraph, readGroupDoc } from '../../graphs.js';
import { UNDO_EXCLUDES } from '../../workspace.js';
import {
  gengraphAddBoundary,
  gengraphAddGroup,
  gengraphAddNode,
  gengraphApply,
  gengraphCreate,
  gengraphCreateForSlot,
  gengraphCreateGroup,
  gengraphDelete,
  gengraphDuplicateNode,
  gengraphExpose,
  gengraphLink,
  gengraphList,
  gengraphListGroups,
  gengraphMoveNodes,
  gengraphRemoveBoundary,
  gengraphRemoveNode,
  gengraphReorderExposed,
  gengraphRepointExposed,
  gengraphSetActiveOutput,
  gengraphSetProp,
  gengraphUnexpose,
  gengraphUngroup,
  gengraphUnlink,
} from '../gengraph.js';
import type { CommandHost } from '../host.js';

let root: string;

/** Where a command's `view` effects land, so a run that moves the author can be read back. */
let pushed: UiEffect[] = [];

beforeEach(async () => {
  pushed = [];
  root = await mkdtemp(join(tmpdir(), 'vn-gengraph-'));
  await writeFile(join(root, 'project.yaml'), 'title: Graphs\n');
  const git = openGit(root);
  await git.init();
  await git.config('user.name', 'Test');
  await git.config('user.email', 'test@example.com');
  await git.add(['.']);
  await git.commit({ message: 'Start' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** Enough context for commands that never reach the session, which is every editing one. */
function ctx(): CommandContext<CommandHost> {
  return {
    root,
    git: openGit(root),
    log: () => {},
    host: { ui: (effect: UiEffect) => pushed.push(effect) },
  } as unknown as CommandContext<CommandHost>;
}

/** A command's props with the `group` the editing ones share left to default, as the registry would. */
type Given<P> = Omit<P, 'group'> & { group?: string };

/** Runs one command and reports what it wrote, the way the executor does. */
async function run<P extends Record<string, never> | object, T>(
  command: { run: (props: P, c: CommandContext<CommandHost>) => Promise<T> },
  props: Given<P>,
): Promise<T> {
  return command.run({ group: '', ...props } as P, ctx());
}

/** The sentence one command's `check` refuses with, failing the test if it accepts. */
async function refusal<P>(
  command: { check?: (props: P, c: CommandContext<CommandHost>) => Promise<unknown> },
  props: Given<P>,
): Promise<string> {
  const verdict = (await command.check!({ group: '', ...props } as P, ctx())) as {
    ok: boolean;
    reason?: string;
  };
  expect(verdict.ok).toBe(false);
  return verdict.reason ?? '';
}

/** The graph on disk, which is the only place a command's effect can be read back from. */
async function loaded(slug: string) {
  const read = await readGraph(root, slug);
  if (!read.ok) throw new Error(read.reason);
  return read.graph;
}

/** The definition on disk, resolved the way a graph instancing it would resolve it. */
async function loadedGroup(ref: string) {
  const read = await readGroupDoc(root, ref);
  if (!read.ok) throw new Error(read.reason);
  return read.def;
}

/** Adds one node of a type and reports the id the edit gave it. */
async function addNode(slug: string, type: string, group = ''): Promise<string> {
  const added = await gengraphAddNode.run({ slug, type, x: 0, y: 0, group }, ctx());
  return String((added.data as { node?: unknown }).node);
}

describe('the gengraph commands over a project', () => {
  it('round-trips a graph from create through apply', async () => {
    await run(gengraphCreate, { name: 'portrait' });
    expect(
      await readFile(join(root, 'vngen', 'work', 'graphs', 'portrait.json'), 'utf8'),
    ).toContain('"nodes"');

    const prompt = await addNode('portrait', 'GenDerivedPrompt');
    const image = await addNode('portrait', 'GenImage');
    const output = await addNode('portrait', 'GenOutput');

    await run(gengraphLink, {
      slug: 'portrait',
      from: prompt,
      fromSocket: 'prompt',
      to: image,
      toSocket: 'prompt',
    });
    await run(gengraphLink, {
      slug: 'portrait',
      from: image,
      fromSocket: 'image',
      to: output,
      toSocket: 'image',
    });
    await run(gengraphSetProp, {
      slug: 'portrait',
      node: output,
      key: 'slot',
      value: 'shot:cafe/1',
    });
    await run(gengraphSetActiveOutput, { slug: 'portrait', node: output });

    const built = await loaded('portrait');
    expect(built.nodes.map((n) => n.def.typeName).sort()).toEqual([
      'GenDerivedPrompt',
      'GenImage',
      'GenOutput',
    ]);
    const bound = built.nodeIdMap.get(Number(output))!;
    expect(bound.props.slot!.getValue()).toBe('shot:cafe/1');
    expect(bound.inputs.image!.edges).toHaveLength(1);

    // The same graph described back to itself keeps every node, so nothing loses its journal.
    const described = {
      nodes: [
        { id: Number(prompt), type: 'GenDerivedPrompt' },
        { id: Number(image), type: 'GenImage' },
        { id: Number(output), type: 'GenOutput', props: { slot: 'shot:cafe/1' } },
      ],
      links: [
        [Number(prompt), 'prompt', Number(image), 'prompt'],
        [Number(image), 'image', Number(output), 'image'],
      ],
    };
    const applied = await run(gengraphApply, {
      slug: 'portrait',
      description: JSON.stringify(described),
    });
    expect(applied.message).toContain('3');
    expect((await loaded('portrait')).nodes).toHaveLength(3);
  }, 20_000);

  it('lists what the project holds, and stops listing a graph that was deleted', async () => {
    await run(gengraphCreate, { name: 'portrait' });
    await run(gengraphCreate, { name: 'plate' });
    expect((await run(gengraphList, {})).message).toContain('2 graphs');

    await run(gengraphDelete, { slug: 'plate' });
    expect((await run(gengraphList, {})).message).toContain('1 graph');
  }, 20_000);

  it('creates a graph a slot is already bound to, named after the address', async () => {
    const made = await run(gengraphCreateForSlot, {
      slot: 'plate:cafe/night',
      name: '',
      open: true,
    });
    expect((made.data as { slug: string }).slug).toBe('plate-cafe-night');

    const graph = await loaded('plate-cafe-night');
    expect(graph.nodes.map((n) => n.def.typeName).sort()).toEqual([
      'GenDerivedPrompt',
      'GenImage',
      'GenOutput',
      'GenTaskRefs',
    ]);
    expect(bindSlots([{ graph }]).bound.has('plate:cafe/night')).toBe(true);
    // The graph the author just asked for is the one on screen, named as the subject rather than
    // left for the selection to catch up with
    expect(pushed).toEqual([
      {
        type: 'view',
        action: 'open',
        editor: 'gengraph',
        where: 'elsewhere',
        subject: 'plate-cafe-night',
      },
    ]);
  }, 20_000);

  it('leaves the panes alone when the run was not asked to show it', async () => {
    await run(gengraphCreateForSlot, { slot: 'plate:cafe/day', name: '', open: false });
    expect(pushed).toEqual([]);
  }, 20_000);

  it('takes the next free name where the derived one is a graph already', async () => {
    await run(gengraphCreate, { name: 'shot-cafe-1' });
    const made = await run(gengraphCreateForSlot, { slot: 'shot:cafe/1', name: '', open: false });
    expect((made.data as { slug: string }).slug).toBe('shot-cafe-1-2');
  }, 20_000);

  it('severs one named link, and every link into an input when none is named', async () => {
    await run(gengraphCreate, { name: 'sw' });
    const a = await addNode('sw', 'GenImage');
    const b = await addNode('sw', 'GenImage');
    const sw = await addNode('sw', 'GenSwitch');
    const link = (from: string, toSocket: string) =>
      run(gengraphLink, { slug: 'sw', from, fromSocket: 'image', to: sw, toSocket });

    await link(a, 'a');
    await link(b, 'b');
    await run(gengraphUnlink, {
      slug: 'sw',
      to: sw,
      toSocket: 'a',
      from: a,
      fromSocket: 'image',
    });
    const cut = await loaded('sw');
    expect(cut.nodeIdMap.get(Number(sw))!.inputs.a!.edges).toHaveLength(0);
    expect(cut.nodeIdMap.get(Number(sw))!.inputs.b!.edges).toHaveLength(1);

    await run(gengraphUnlink, { slug: 'sw', to: sw, toSocket: 'b', from: '', fromSocket: '' });
    expect((await loaded('sw')).nodeIdMap.get(Number(sw))!.inputs.b!.edges).toHaveLength(0);
  }, 20_000);
});

describe('what the gengraph commands refuse', () => {
  beforeEach(async () => {
    await run(gengraphCreate, { name: 'portrait' });
  });

  it('refuses a second graph of the same name, and a name that cannot be a file', async () => {
    expect(await refusal(gengraphCreate, { name: 'portrait' })).toContain('already has');
    expect(await refusal(gengraphCreate, { name: 'not a slug' })).toContain('is not a graph name');
  });

  it('refuses a slot another graph draws, an address that is not one, and no slot', async () => {
    await run(gengraphCreateForSlot, { slot: 'shot:cafe/1', name: '', open: false });

    expect(
      await refusal(gengraphCreateForSlot, { slot: 'shot:cafe/1', name: '', open: false }),
    ).toBe('the shot-cafe-1 graph already draws shot:cafe/1');
    expect(await refusal(gengraphCreateForSlot, { slot: 'cafe', name: '', open: false })).toBe(
      "'cafe' is not a slot address",
    );
    expect(await refusal(gengraphCreateForSlot, { slot: '  ', name: '', open: false })).toContain(
      'needs the slot it draws',
    );
    expect(
      await refusal(gengraphCreateForSlot, { slot: 'shot:cafe/2', name: 'portrait', open: false }),
    ).toContain('already has a portrait graph');
  }, 20_000);

  it('names a graph that is not there rather than reporting an empty one', async () => {
    expect(await refusal(gengraphAddNode, { slug: 'missing', type: 'GenImage', x: 0, y: 0 })).toBe(
      'there is no missing graph in this project',
    );
  });

  it('refuses a node type nothing provides, and says the plugin may be absent', async () => {
    const reason = await refusal(gengraphAddNode, {
      slug: 'portrait',
      type: 'GenNonesuch',
      x: 0,
      y: 0,
    });
    expect(reason).toContain("no node type 'GenNonesuch'");
    expect(reason).toContain('plugin');
  });

  it('refuses a node id the graph does not hold', async () => {
    expect(await refusal(gengraphRemoveNode, { slug: 'portrait', node: '99' })).toBe(
      'this graph holds no node 99',
    );
  });

  it('refuses a link whose socket types disagree, and one that would make a cycle', async () => {
    const image = await addNode('portrait', 'GenImage');
    const output = await addNode('portrait', 'GenOutput');
    const rewrite = await addNode('portrait', 'GenRewrite');

    expect(
      await refusal(gengraphLink, {
        slug: 'portrait',
        from: image,
        fromSocket: 'image',
        to: output,
        toSocket: 'nope',
      }),
    ).toContain("declares no input 'nope'");

    expect(
      await refusal(gengraphLink, {
        slug: 'portrait',
        from: image,
        fromSocket: 'image',
        to: rewrite,
        toSocket: 'text',
      }),
    ).toContain('cannot feed');

    // Two text nodes, because a cycle needs a pair of links the socket types both allow.
    const first = await addNode('portrait', 'GenTemplate');
    const second = await addNode('portrait', 'GenTemplate');
    await run(gengraphLink, {
      slug: 'portrait',
      from: first,
      fromSocket: 'text',
      to: second,
      toSocket: 'varA',
    });
    expect(
      await refusal(gengraphLink, {
        slug: 'portrait',
        from: second,
        fromSocket: 'text',
        to: first,
        toSocket: 'varA',
      }),
    ).toContain('cycle');
  }, 20_000);

  it('asks for the output a named source is cut at', async () => {
    const image = await addNode('portrait', 'GenImage');
    const output = await addNode('portrait', 'GenOutput');
    expect(
      await refusal(gengraphUnlink, {
        slug: 'portrait',
        to: output,
        toSocket: 'image',
        from: image,
        fromSocket: '',
      }),
    ).toContain('the output on it');
  }, 20_000);

  it('refuses a property the node does not declare, and a value it cannot read', async () => {
    const sw = await addNode('portrait', 'GenSwitch');
    expect(
      await refusal(gengraphSetProp, { slug: 'portrait', node: sw, key: 'nope', value: 'x' }),
    ).toContain("declares no prop or editable input 'nope'");
    expect(
      await refusal(gengraphSetProp, { slug: 'portrait', node: sw, key: 'useB', value: 'maybe' }),
    ).toContain('takes true or false');
  }, 20_000);

  it('refuses a node that fills no slot as the active output', async () => {
    const image = await addNode('portrait', 'GenImage');
    expect(await refusal(gengraphSetActiveOutput, { slug: 'portrait', node: image })).toContain(
      'fills no slot',
    );
  }, 20_000);

  it('writes a whole drag at once, and refuses a move list that is not JSON', async () => {
    const image = await addNode('portrait', 'GenImage');
    const output = await addNode('portrait', 'GenOutput');

    await run(gengraphMoveNodes, {
      slug: 'portrait',
      moves: JSON.stringify([
        { node: image, x: 12, y: 34 },
        { node: output, x: 200, y: 34 },
      ]),
    });

    const built = await loaded('portrait');
    expect([...built.nodeIdMap.get(Number(image))!.pos]).toEqual([12, 34]);
    expect([...built.nodeIdMap.get(Number(output))!.pos]).toEqual([200, 34]);

    expect(await refusal(gengraphMoveNodes, { slug: 'portrait', moves: '[{nope' })).toContain(
      'not JSON',
    );
    expect(
      await refusal(gengraphMoveNodes, { slug: 'portrait', moves: '[{"node":"1"}]' }),
    ).toContain('numeric `x` and `y`');
  }, 20_000);

  it('refuses a description that is not JSON, and leaves the graph alone', async () => {
    await addNode('portrait', 'GenImage');
    expect(await refusal(gengraphApply, { slug: 'portrait', description: '{nope' })).toContain(
      'not JSON',
    );
    expect((await loaded('portrait')).nodes).toHaveLength(1);
  }, 20_000);
});

/**
 * Groups: a selection becomes a definition file under `lib/` with an instance in its place, the
 * same commands edit the definition when `group` is set, and a node inside an instance is reached
 * by key for value edits alone. What is pinned is which file each edit writes, since a definition
 * edit that landed in the graph file would be an override rather than a change every instance sees.
 */
describe('groups', () => {
  const LIB = 'vngen/work/graphs/lib/group-1.json';
  const DOC = 'vngen/work/graphs/portrait.json';

  /** A template feeding an image feeding an output, with the two paid nodes grouped. */
  async function grouped() {
    await run(gengraphCreate, { name: 'portrait' });
    const template = await addNode('portrait', 'GenTemplate');
    const image = await addNode('portrait', 'GenImage');
    const output = await addNode('portrait', 'GenOutput');
    await run(gengraphLink, {
      slug: 'portrait',
      from: template,
      fromSocket: 'text',
      to: image,
      toSocket: 'prompt',
    });
    await run(gengraphLink, {
      slug: 'portrait',
      from: image,
      fromSocket: 'image',
      to: output,
      toSocket: 'image',
    });
    const made = await run(gengraphCreateGroup, {
      slug: 'portrait',
      nodes: `${template}, ${image}`,
      name: '',
    });
    const instance = String((made.data as { node?: unknown }).node);
    const def = await loadedGroup('group-1');
    const inner = (type: string) =>
      String(def.subgraph.nodes.find((n) => n.def.typeName === type)!.id);
    return { made, output, instance, template: inner('GenTemplate'), image: inner('GenImage') };
  }

  it('creates a group from a selection, writing the definition before the graph', async () => {
    const { made, output, instance } = await grouped();
    expect(made.written).toEqual([LIB, DOC]);
    expect(made.message).toBe("Groups 2 nodes into 'group-1'.");

    const graph = await loaded('portrait');
    expect(graph.nodes.map((n) => n.def.typeName).sort()).toEqual(['GenOutput', 'GroupNode']);
    const node = graph.nodeIdMap.get(Number(instance)) as GroupNode;
    expect(node.ref).toBe('group-1');
    expect(node.definition).toBeDefined();
    // The output is still fed, through the instance now
    expect(graph.nodeIdMap.get(Number(output))!.inputs.image!.resolvedEdges()).toHaveLength(1);
    expect((await run(gengraphListGroups, {})).message).toBe('1 group.');
  }, 20_000);

  it('refuses an output node, a taken name, a name that is not one, and no nodes', async () => {
    const { output } = await grouped();
    expect(
      await refusal(gengraphCreateGroup, { slug: 'portrait', nodes: output, name: '' }),
    ).toContain('stays at the root');
    expect(
      await refusal(gengraphCreateGroup, { slug: 'portrait', nodes: output, name: 'group-1' }),
    ).toBe('this project already has a group-1 group');
    expect(
      await refusal(gengraphCreateGroup, { slug: 'portrait', nodes: output, name: 'not a name' }),
    ).toContain('is not a group name');
    expect(await refusal(gengraphCreateGroup, { slug: 'portrait', nodes: ' ', name: '' })).toBe(
      'grouping needs at least one node',
    );
  }, 20_000);

  it('edits the definition with group set, writing its file and not the graph', async () => {
    const { instance } = await grouped();
    const before = await readFile(join(root, DOC), 'utf8');

    const added = await run(gengraphAddNode, {
      slug: 'portrait',
      type: 'GenRewrite',
      x: 0,
      y: 0,
      group: 'group-1',
    });
    expect(added.written).toEqual([LIB]);
    expect(await readFile(join(root, DOC), 'utf8')).toBe(before);

    const def = await loadedGroup('group-1');
    expect(def.subgraph.nodes.some((n) => n.def.typeName === 'GenRewrite')).toBe(true);
    // The instance in the graph follows the definition on its next load
    const node = (await loaded('portrait')).nodeIdMap.get(Number(instance)) as GroupNode;
    expect(node.subgraph.nodes.some((n) => n.def.typeName === 'GenRewrite')).toBe(true);
  }, 20_000);

  it('forwards rows onto the instances, reorders, repoints and removes them', async () => {
    const { template, image } = await grouped();
    const exposed = await run(gengraphExpose, {
      group: 'group-1',
      node: template,
      key: 'template',
      label: '',
    });
    expect(exposed.written).toEqual([LIB]);
    expect(exposed.message).toContain("Exposes 'template' of the");
    await run(gengraphExpose, { group: 'group-1', node: image, key: '', label: 'Picture' });
    expect((await loadedGroup('group-1')).exposed.map((e) => e.kind)).toEqual(['prop', 'nodeUI']);

    await run(gengraphReorderExposed, { group: 'group-1', from: 1, to: 0 });
    expect((await loadedGroup('group-1')).exposed.map((e) => e.kind)).toEqual(['nodeUI', 'prop']);

    await run(gengraphRepointExposed, { group: 'group-1', index: 0, node: template, key: '' });
    expect(String((await loadedGroup('group-1')).exposed[0]!.nodeId)).toBe(template);

    await run(gengraphUnexpose, { group: 'group-1', index: 1 });
    expect((await loadedGroup('group-1')).exposed).toHaveLength(1);

    expect(await refusal(gengraphUnexpose, { group: 'group-1', index: 5 })).toBe(
      'the group has no forwarded row 5',
    );
    expect(await refusal(gengraphUnexpose, { group: 'group-1', index: 1.5 })).toContain(
      'whole numbers',
    );
    expect(
      await refusal(gengraphExpose, { group: 'group-1', node: template, key: 'nope', label: '' }),
    ).toContain("has no property 'nope'");
    expect(
      await refusal(gengraphExpose, { group: 'missing', node: template, key: '', label: '' }),
    ).toBe('there is no missing group in this project');
  }, 20_000);

  it('adds and removes boundary sockets, which every instance gains and loses', async () => {
    const { instance } = await grouped();
    const added = await run(gengraphAddBoundary, {
      group: 'group-1',
      dir: 'in',
      key: 'extra',
      type: 'TextSocket',
    });
    expect(added.written).toEqual([LIB]);
    expect('extra' in (await loadedGroup('group-1')).inputs).toBe(true);
    const node = (await loaded('portrait')).nodeIdMap.get(Number(instance)) as GroupNode;
    expect('extra' in node.inputs).toBe(true);

    expect(
      await refusal(gengraphAddBoundary, {
        group: 'group-1',
        dir: 'sideways',
        key: 'x',
        type: 'TextSocket',
      }),
    ).toBe("a side is 'in' or 'out'");
    expect(
      await refusal(gengraphAddBoundary, {
        group: 'group-1',
        dir: 'in',
        key: 'x',
        type: 'NopeSocket',
      }),
    ).toContain("no socket type 'NopeSocket'");

    await run(gengraphRemoveBoundary, { group: 'group-1', dir: 'in', key: 'extra' });
    expect('extra' in (await loadedGroup('group-1')).inputs).toBe(false);
    expect(
      await refusal(gengraphRemoveBoundary, { group: 'group-1', dir: 'in', key: 'extra' }),
    ).toBe("the group has no input named 'extra'");
  }, 20_000);

  it('adds an instance of a definition, and refuses one that is missing or its own', async () => {
    await grouped();
    const added = await run(gengraphAddGroup, { slug: 'portrait', ref: 'group-1', x: 10, y: 20 });
    expect(added.message).toBe("Adds an instance of group 'group-1'.");
    expect(added.written).toEqual([DOC]);
    const instances = (await loaded('portrait')).nodes.filter((n) => n instanceof GroupNode);
    expect(instances).toHaveLength(2);
    expect(instances.every((n) => (n as GroupNode).definition !== undefined)).toBe(true);

    expect(await refusal(gengraphAddGroup, { slug: 'portrait', ref: 'missing', x: 0, y: 0 })).toBe(
      'there is no missing group in this project',
    );
    expect(
      await refusal(gengraphAddGroup, {
        slug: 'portrait',
        ref: 'group-1',
        x: 0,
        y: 0,
        group: 'group-1',
      }),
    ).toContain('cannot contain itself');
  }, 20_000);

  it('overrides an inner value by key, keeps the group on a copy, and ungroups', async () => {
    const { instance, template } = await grouped();
    const key = `${instance}/${template}`;

    const set = await run(gengraphSetProp, {
      slug: 'portrait',
      node: key,
      key: 'template',
      value: 'in ink wash',
    });
    expect(set.written).toEqual([DOC]);
    const node = (await loaded('portrait')).nodeIdMap.get(Number(instance)) as GroupNode;
    const inner = node.subgraph.nodeIdMap.get(Number(template))!;
    expect(inner.props.template!.getValue()).toBe('in ink wash');
    // The definition is untouched: the value is this instance's own
    const def = await loadedGroup('group-1');
    expect(def.subgraph.nodeIdMap.get(Number(template))!.props.template!.getValue()).not.toBe(
      'in ink wash',
    );

    expect(await refusal(gengraphRemoveNode, { slug: 'portrait', node: key })).toBe(
      "a group instance takes value edits only; structural edits belong to the group's definition",
    );

    const copied = await run(gengraphDuplicateNode, {
      slug: 'portrait',
      node: instance,
      x: 0,
      y: 0,
    });
    const copy = (await loaded('portrait')).nodeIdMap.get(
      (copied.data as { node: number }).node,
    ) as GroupNode;
    expect(copy.ref).toBe('group-1');

    const inlined = await run(gengraphUngroup, { slug: 'portrait', node: instance });
    expect(inlined.message).toBe(
      "Inlines the 2 nodes of group 'group-1' where the instance stands.",
    );
    const after = await loaded('portrait');
    const templates = after.nodes.filter((n) => n.def.typeName === 'GenTemplate');
    expect(templates).toHaveLength(1);
    expect(templates[0]!.props.template!.getValue()).toBe('in ink wash');
    expect(after.nodes.filter((n) => n instanceof GroupNode)).toHaveLength(1);
  }, 20_000);

  it('applies a description that instances a definition the graph never held', async () => {
    await grouped();
    await run(gengraphCreate, { name: 'other' });
    await run(gengraphApply, {
      slug: 'other',
      description: JSON.stringify({
        nodes: [{ id: 1, type: 'GroupNode', group: 'group-1' }],
        links: [],
      }),
    });
    const node = (await loaded('other')).nodeIdMap.get(1) as GroupNode;
    expect(node.ref).toBe('group-1');
    expect(node.definition).toBeDefined();
  }, 20_000);

  it('undoes a createGroup as a whole, taking the definition file with it', async () => {
    await run(gengraphCreate, { name: 'portrait' });
    const a = await addNode('portrait', 'GenTemplate');
    const b = await addNode('portrait', 'GenImage');

    const journal = new UndoJournal({ root, exclude: UNDO_EXCLUDES });
    const before = await journal.capture(1);
    await run(gengraphCreateGroup, { slug: 'portrait', nodes: `${a},${b}`, name: '' });
    const after = await journal.capture(1);

    const point = journal.point(before!, after!);
    const checked = await journal.check(point, 'post');
    expect(checked.ok).toBe(true);
    const restored = await journal.restore((checked as { tree: string }).tree, point, 'pre');
    expect(restored.error).toBeUndefined();

    expect((await loaded('portrait')).nodes).toHaveLength(2);
    await expect(readFile(join(root, LIB))).rejects.toThrow();
  }, 20_000);

  it('records the group prop, so provenance says which file an edit went to', async () => {
    const digested = await digestProps(gengraphAddNode.props, {
      slug: 'portrait',
      type: 'GenRewrite',
      x: 0,
      y: 0,
      group: 'group-1',
    });
    expect(digested.group).toBe('group-1');
  });
});

describe('undoing a graph edit', () => {
  it('restores the document, because a graph is inside the class undo snapshots', async () => {
    await run(gengraphCreate, { name: 'portrait' });

    const journal = new UndoJournal({ root, exclude: UNDO_EXCLUDES });
    const before = await journal.capture(1);
    expect(before).not.toBeNull();

    await addNode('portrait', 'GenImage');
    const after = await journal.capture(1);
    expect(after).not.toBe(before);

    const point = journal.point(before!, after!);
    const checked = await journal.check(point, 'post');
    expect(checked.ok).toBe(true);

    const restored = await journal.restore((checked as { tree: string }).tree, point, 'pre');
    expect(restored.error).toBeUndefined();
    expect((await loaded('portrait')).nodes).toHaveLength(0);
  }, 20_000);
});

/**
 * No `gengraph.*` command takes a `prop.secret`, so this pins the property that makes that safe to
 * rely on rather than the redaction: what the provenance log records is what the author typed, and
 * a graph is described entirely by node types, socket names and authored values.
 */
describe('what a graph command records', () => {
  it('digests the whole-graph description instead of copying it into the log', async () => {
    const description = JSON.stringify({ nodes: [{ id: 1, type: 'GenImage' }], links: [] });
    const digested = await digestProps(gengraphApply.props, { slug: 'portrait', description });

    expect(digested.slug).toBe('portrait');
    expect(String(digested.description)).not.toContain('GenImage');
  });

  it('takes no secret in any of its properties', () => {
    const commands = [
      gengraphAddNode,
      gengraphApply,
      gengraphCreate,
      gengraphDelete,
      gengraphLink,
      gengraphMoveNodes,
      gengraphRemoveNode,
      gengraphSetActiveOutput,
      gengraphSetProp,
      gengraphUnlink,
    ];
    for (const command of commands) {
      for (const spec of Object.values(command.props)) {
        expect(spec.kind).not.toBe('secret');
      }
    }
  });
});

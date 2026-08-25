/**
 * The `gengraph.*` commands over a real project directory. They are the only write path to
 * `vngen/work/graphs/`, so what is checked here is that the document on disk is what the edits
 * said, that each declared refusal comes back with its own sentence, and that undo restores the
 * document the way it restores a scene.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UndoJournal, digestProps } from '@vn/commands';
import type { CommandContext } from '@vn/commands';
import { openGit } from '@vn/git';
import { readGraph } from '../../graphs.js';
import { UNDO_PATHS } from '../../workspace.js';
import {
  gengraphAddNode,
  gengraphApply,
  gengraphCreate,
  gengraphDelete,
  gengraphLink,
  gengraphList,
  gengraphRemoveNode,
  gengraphSetActiveOutput,
  gengraphSetProp,
  gengraphUnlink,
} from '../gengraph.js';
import type { CommandHost } from '../host.js';

let root: string;

beforeEach(async () => {
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
  return { root, git: openGit(root), log: () => {} } as unknown as CommandContext<CommandHost>;
}

/** Runs one command and reports what it wrote, the way the executor does. */
async function run<P extends Record<string, never> | object, T>(
  command: { run: (props: P, c: CommandContext<CommandHost>) => Promise<T> },
  props: P,
): Promise<T> {
  return command.run(props, ctx());
}

/** The sentence one command's `check` refuses with, failing the test if it accepts. */
async function refusal<P>(
  command: { check?: (props: P, c: CommandContext<CommandHost>) => Promise<unknown> },
  props: P,
): Promise<string> {
  const verdict = (await command.check!(props, ctx())) as { ok: boolean; reason?: string };
  expect(verdict.ok).toBe(false);
  return verdict.reason ?? '';
}

/** The graph on disk, which is the only place a command's effect can be read back from. */
async function loaded(slug: string) {
  const read = await readGraph(root, slug, openGit(root));
  if (!read.ok) throw new Error(read.reason);
  return read.graph;
}

/** Adds one node of a type and reports the id the edit gave it. */
async function addNode(slug: string, type: string): Promise<string> {
  const added = await gengraphAddNode.run({ slug, type, x: 0, y: 0 }, ctx());
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
      toSocket: 'a',
    });
    expect(
      await refusal(gengraphLink, {
        slug: 'portrait',
        from: second,
        fromSocket: 'text',
        to: first,
        toSocket: 'a',
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

  it('refuses a description that is not JSON, and leaves the graph alone', async () => {
    await addNode('portrait', 'GenImage');
    expect(await refusal(gengraphApply, { slug: 'portrait', description: '{nope' })).toContain(
      'not JSON',
    );
    expect((await loaded('portrait')).nodes).toHaveLength(1);
  }, 20_000);
});

describe('undoing a graph edit', () => {
  it('restores the document, because a graph lives inside the undo pathspec', async () => {
    await run(gengraphCreate, { name: 'portrait' });
    await openGit(root).add(['.']);
    await openGit(root).commit({ message: 'Add the graph' });

    const journal = new UndoJournal({ git: openGit(root), paths: UNDO_PATHS });
    const before = await journal.capture(1, 'pre');
    expect(before).not.toBeNull();

    await addNode('portrait', 'GenImage');
    const after = await journal.capture(1, 'post');
    expect(after!.tree).not.toBe(before!.tree);

    const point = journal.point(before!, after!);
    const checked = await journal.check(point, 'post');
    expect(checked.ok).toBe(true);

    const moved = await journal.restore(
      (checked as { trees: Record<string, string> }).trees,
      point,
      'pre',
    );
    expect(moved.error).toBeUndefined();
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

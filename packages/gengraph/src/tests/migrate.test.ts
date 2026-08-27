import {
  GenTemplate,
  Graph,
  migrateGraphJSON,
  migrateGroupJSON,
  readGraphFile,
  registerGenNode,
  registerGenNodes,
  writeGraphFile,
} from '../index.js';
import { TEST_RENAMES, TestRenamed, registerTestNodes, setProp } from './__fixtures__/nodes.js';

registerGenNodes();
registerTestNodes();

/** One node as the file writes it, cut down to the fields a rename touches. */
function node(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _structName: 'graph.TestRenamed',
    id,
    typeVersion: 1,
    props: [{ apiname: 'name', data: '' }],
    inputs: [{ name: 'src' }],
    outputs: [{ name: 'out' }],
    ...over,
  };
}

const file = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  VERSION: 1,
  nodes: [node('0'), node('1')],
  links: [{ srcNode: '0', srcKey: 'out', dstNode: '1', dstKey: 'src' }],
  ...over,
});

const migrated = (json: unknown): Record<string, unknown> =>
  migrateGraphJSON(json).json as Record<string, unknown>;

const nodes = (json: unknown): Record<string, unknown>[] =>
  (migrated(json).nodes as Record<string, unknown>[]) ?? [];

const keys = (list: unknown): string[] => (list as { name: string }[]).map((socket) => socket.name);

describe('replaying a rename over a graph file', () => {
  it('moves the sockets and props every declared step names', () => {
    const [first] = nodes(file());

    expect(keys(first?.inputs)).toEqual(['from']);
    expect(keys(first?.outputs)).toEqual(['blob']);
    expect((first?.props as { apiname: string }[])[0]?.apiname).toBe('label');
  });

  it('carries the links onto the keys the sockets moved to', () => {
    expect(migrated(file()).links).toEqual([
      { srcNode: '0', srcKey: 'blob', dstNode: '1', dstKey: 'from' },
    ]);
  });

  it('leaves a link into a node it did not touch alone', () => {
    const other = { srcNode: '9', srcKey: 'out', dstNode: '8', dstKey: 'src' };
    const links = migrated(file({ links: [other] })).links;

    expect(links).toEqual([other]);
  });

  it('stamps the version the last step lands on, and says what it did', () => {
    const run = migrateGraphJSON(file());

    expect((run.json as { nodes: { typeVersion: number }[] }).nodes[0]?.typeVersion).toBe(3);
    expect(run.notes).toEqual(['2 TestRenamed nodes updated to v3']);
  });

  it('runs the steps a node is behind on and no others', () => {
    // Already past the output rename, so only the input step is owed.
    const half = node('0', { typeVersion: 2, outputs: [{ name: 'blob' }], props: [] });
    const [only] = nodes(file({ nodes: [half] }));

    expect(keys(only?.inputs)).toEqual(['from']);
    expect(keys(only?.outputs)).toEqual(['blob']);
  });

  it('changes nothing on a file already at the current version', () => {
    const current = file({ nodes: [node('0', { typeVersion: 3 })] });
    const run = migrateGraphJSON(current);

    expect(run.notes).toEqual([]);
    expect(run.json).toBe(current);
  });

  it('is idempotent, because the second pass finds nothing behind', () => {
    const once = migrateGraphJSON(file()).json;

    expect(migrateGraphJSON(once).json).toEqual(once);
  });

  it('leaves the argument it was given untouched', () => {
    const original = file();
    migrateGraphJSON(original);

    expect(original).toEqual(file());
  });

  it('descends into the subgraph a group instance carries', () => {
    const outer = { _structName: 'graph.GroupNode', id: '0', typeVersion: 1, subgraph: file() };
    const run = migrateGraphJSON({ VERSION: 1, nodes: [outer], links: [] });
    const inner = (run.json as { nodes: { subgraph: { nodes: unknown[] } }[] }).nodes[0]?.subgraph;

    expect(keys((inner?.nodes[0] as Record<string, unknown>).inputs)).toEqual(['from']);
  });

  it('says nothing about a node type no rename was declared for', () => {
    const unknown = node('0', { _structName: 'graph.TestSource' });

    expect(migrateGraphJSON(file({ nodes: [unknown] })).notes).toEqual([]);
  });
});

describe('the text a rename leaves pointing at the old name', () => {
  it('follows the inputs its placeholders name', () => {
    const authored = node('0', { props: [{ apiname: 'name', data: '{src} and {src} again' }] });
    const [only] = nodes(file({ nodes: [authored] }));

    expect((only?.props as { data: string }[])[0]?.data).toBe('{from} and {from} again');
  });

  it('keeps a token naming something the rename never mentioned', () => {
    const authored = node('0', { props: [{ apiname: 'name', data: '{src} at {elsewhere}' }] });
    const [only] = nodes(file({ nodes: [authored] }));

    expect((only?.props as { data: string }[])[0]?.data).toBe('{from} at {elsewhere}');
  });
});

describe('a group definition', () => {
  const groupFile = (): Record<string, unknown> => ({
    subgraph: file(),
    inputs: [],
    outputs: [],
    exposed: [{ kind: 'prop', nodeId: '0', propKey: 'name' }],
  });

  it('moves the forwarded rows onto the prop keys its nodes took', () => {
    const run = migrateGroupJSON(groupFile());

    expect((run.json as { exposed: unknown[] }).exposed).toEqual([
      { kind: 'prop', nodeId: '0', propKey: 'label' },
    ]);
  });

  it('leaves a row naming a node nothing renamed where it is', () => {
    const rows = [{ kind: 'prop', nodeId: '7', propKey: 'name' }];
    const run = migrateGroupJSON({ ...groupFile(), exposed: rows });

    expect((run.json as { exposed: unknown[] }).exposed).toEqual(rows);
  });
});

describe('the template node, which renamed a, b and c at v2', () => {
  /** A v2 file written back down to what v1 wrote, which is what an old project holds. */
  function asWrittenAtV1(): unknown {
    const graph = new Graph();
    const source = new GenTemplate();
    const sink = new GenTemplate();

    graph.add(source);
    graph.add(sink);
    graph.connect(source.outputs.text, sink.inputs.varA);
    setProp(sink, 'template', 'a {a} in a {b}');

    const json = JSON.parse(JSON.stringify(writeGraphFile(graph))) as {
      nodes: Record<string, unknown>[];
      links: Record<string, unknown>[];
    };
    const back: Record<string, string> = { varA: 'a', varB: 'b', varC: 'c' };
    for (const entry of json.nodes) {
      entry.typeVersion = 1;
      for (const socket of entry.inputs as { name: string }[]) {
        socket.name = back[socket.name] ?? socket.name;
      }
    }
    for (const link of json.links) {
      link.dstKey = back[String(link.dstKey)] ?? link.dstKey;
    }
    return json;
  }

  it('reads back with the wiring and the authored text the author left', () => {
    const read = readGraphFile(asWrittenAtV1());
    const graph = read.graph as Graph;
    const [source, sink] = graph.nodes as GenTemplate[];

    expect(read.diagnostics).toEqual([]);
    expect(read.migrated).toEqual(['2 GenTemplate nodes updated to v2']);
    expect(sink?.props.template?.getValue()).toBe('a {varA} in a {varB}');
    expect(sink?.inputs.varA.orphaned).toBe(false);
    expect(sink?.inputs.varA.edges).toEqual([source?.outputs.text]);
  });

  it('says nothing about a file written since the rename', () => {
    const graph = new Graph();
    graph.add(new GenTemplate());

    expect(
      readGraphFile(JSON.parse(JSON.stringify(writeGraphFile(graph)))).migrated,
    ).toBeUndefined();
  });
});

describe('a rename that does not match the class it was declared for', () => {
  const withSteps =
    (steps: (typeof TEST_RENAMES)[number][]): (() => void) =>
    (): void =>
      registerGenNode({ cls: TestRenamed, migrations: steps });

  afterEach(() => registerTestNodes());

  it('is refused when a step renames onto a key the type does not have', () => {
    expect(withSteps([{ to: 3, inputs: { src: 'gone' } }])).toThrow(
      "TestRenamed: a migration renames to 'gone', which is no input",
    );
  });

  it('is refused when it stops short of the version the type declares', () => {
    expect(withSteps([{ to: 2, outputs: { out: 'blob' } }])).toThrow(
      'TestRenamed: its migrations land on v2, but the type declares v3',
    );
  });

  it('is refused when its placeholders name no prop', () => {
    expect(withSteps([{ to: 3, placeholders: ['nowhere'] }])).toThrow(
      "TestRenamed: a migration reads placeholders from 'nowhere', which is no prop",
    );
  });
});

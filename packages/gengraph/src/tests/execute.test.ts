import {
  GenDerivedPrompt,
  GenImage,
  GenOutput,
  GenSlotRef,
  GenTaskRefs,
  GenTemplate,
  Graph,
  registerGenRuntimes,
  replayJournal,
} from '../index.js';
import type { GraphJournalRecord, Node } from '../index.js';
import { executeGenGraph } from '../execute.js';
import type { GenRunContext } from '../execute.js';
import { bytes, mockServices, putAsset } from '../nodes/tests/__fixtures__/services.js';
import type { MockServices } from '../nodes/tests/__fixtures__/services.js';

registerGenRuntimes();

let mock: MockServices;

beforeEach(() => {
  mock = mockServices();
});

/**
 * A context whose records accumulate in `into`, with the journal replayed from whatever
 * was already there. A second harness over the same array is what a resumed run sees.
 */
function context(into: GraphJournalRecord[]): GenRunContext {
  const journal = replayJournal(into.map((record) => JSON.stringify(record)).join('\n'));

  return {
    services: mock,
    journal,
    record: (record) => {
      into.push(record);
      return Promise.resolve();
    },
    now   : () => new Date('2026-01-01T00:00:00.000Z'),
  };
}

function setProp(node: Node, key: string, value: unknown): void {
  const prop = node.props[key];
  if (prop === undefined) {
    throw new Error(`this node has no prop '${key}'`);
  }
  prop.setValue(value);
}

interface Chain {
  graph: Graph;
  prompt: GenDerivedPrompt;
  image: GenImage;
  output: GenOutput;
}

/** A derived prompt feeding one image node, feeding the output bound to a slot. */
function chain(): Chain {
  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const image = new GenImage();
  const output = new GenOutput();

  graph.add(prompt);
  graph.add(image);
  graph.add(output);
  graph.connect(prompt.outputs.prompt, image.inputs.prompt);
  graph.connect(image.outputs.image, output.inputs.image);
  setProp(output, 'slot', 'portrait:aiko');

  return { graph, prompt, image, output };
}

const SEEDS = { GenDerivedPrompt: { prompt: 'a lantern at dusk' } };

describe('running a graph', () => {
  it('runs the target and its ancestors, journaling every transition', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    const result = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(result.ran).toEqual([prompt.id, image.id, output.id]);
    expect(result.failures).toEqual([]);
    expect(records.map((r) => [r.nodeId, r.status])).toEqual([
      [prompt.id, 'running'],
      [prompt.id, 'done'],
      [image.id, 'running'],
      [image.id, 'done'],
      [output.id, 'running'],
      [output.id, 'done'],
    ]);
    expect(mock.images).toHaveLength(1);
  });

  it('sends the seeded prompt to the model', async () => {
    const { graph, output } = chain();

    await executeGenGraph(graph, context([]), { targets: [output.id], seeds: SEEDS });

    expect(mock.images[0]?.prompt).toBe('a lantern at dusk');
  });

  it('reports the picture the output node terminates on', async () => {
    const { graph, output } = chain();

    const result = await executeGenGraph(graph, context([]), {
      targets: [output.id],
      seeds  : SEEDS,
    });
    const image = result.outputs.get(output.id)?.image as { store: string; hash: string };

    expect(image.store).toBe('blob');
    expect(await mock.blobs.read(image.hash)).toEqual(bytes('drawn picture'));
  });

  it('refuses a target the graph does not hold', async () => {
    const { graph } = chain();

    await expect(executeGenGraph(graph, context([]), { targets: ['nowhere'] })).rejects.toThrow(
      'which this graph does not hold',
    );
  });

  it('leaves a branch no target descends from unrun', async () => {
    const { graph, output } = chain();
    const scratch = new GenImage();
    graph.add(scratch);

    const result = await executeGenGraph(graph, context([]), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(result.ran).not.toContain(scratch.id);
    expect(mock.images).toHaveLength(1);
  });
});

describe('resuming a run', () => {
  it('skips every node whose record still matches its hash', async () => {
    const { graph, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.ran).toEqual([]);
    expect(second.skipped).toHaveLength(3);
    expect(mock.images).toHaveLength(1);
  });

  it('re-runs a node whose props changed, and everything below it', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    setProp(image, 'aspect', '3:2');
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.skipped).toEqual([prompt.id]);
    expect(second.ran).toEqual([image.id, output.id]);
    expect(mock.images).toHaveLength(2);
  });

  it('re-runs a node whose seeded input changed', async () => {
    const { graph, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : { GenDerivedPrompt: { prompt: 'a lantern at dawn' } },
    });

    expect(second.ran).toHaveLength(3);
    expect(mock.images[1]?.prompt).toBe('a lantern at dawn');
  });

  it('resumes a picture without reading its bytes again', async () => {
    const { graph, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const first = records.filter((r) => r.status === 'done' && r.nodeId === output.id);
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.outputs.get(output.id)).toEqual(first[0]?.output);
  });
});

describe('a deliberate re-render', () => {
  it('invalidates each paid ancestor and re-runs it while prep still resumes', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const before = records.length;
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
      force  : true,
    });

    expect(records.slice(before, before + 1).map((r) => [r.nodeId, r.status])).toEqual([
      [image.id, 'invalidated'],
    ]);
    expect(second.skipped).toEqual([prompt.id]);
    expect(second.ran).toEqual([image.id, output.id]);
    expect(mock.images).toHaveLength(2);
  });

  it('reports what the re-run drew rather than what the run before it drew', async () => {
    const { graph, output } = chain();
    const records: GraphJournalRecord[] = [];

    const first = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });
    mock.drawn = { ...mock.drawn, bytes: bytes('a second take') };
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
      force  : true,
    });
    const image = second.outputs.get(output.id)?.image as { hash: string };

    expect(second.outputs.get(output.id)).not.toEqual(first.outputs.get(output.id));
    expect(await mock.blobs.read(image.hash)).toEqual(bytes('a second take'));
  });

  it('leaves the last completed run readable for drift, which reads done records', async () => {
    const { graph, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
      force  : true,
    });
    const journal = replayJournal(records.map((r) => JSON.stringify(r)).join('\n'));

    expect(journal.lastDone.get(image.id)?.status).toBe('done');
    expect(journal.latest.get(image.id)?.status).toBe('done');
  });
});

describe('a node that fails', () => {
  it('records why, and blocks its downstream without running it', async () => {
    const graph = new Graph();
    const missing = new GenSlotRef();
    const image = new GenImage();
    const output = new GenOutput();

    graph.add(missing);
    graph.add(image);
    graph.add(output);
    graph.connect(missing.outputs.image, image.inputs.refs);
    graph.connect(image.outputs.image, output.inputs.image);
    setProp(missing, 'slot', 'plate:library');

    const records: GraphJournalRecord[] = [];
    const result = await executeGenGraph(graph, context(records), { targets: [output.id] });

    expect(result.failures).toEqual([
      { nodeId: missing.id, error: "the slot 'plate:library' holds no asset yet" },
    ]);
    expect(result.blocked).toEqual([image.id, output.id]);
    expect(mock.images).toEqual([]);
    expect(records[records.length - 1]?.status).toBe('failed');
  });

  it('runs the branches beside it', async () => {
    const graph = new Graph();
    const missing = new GenSlotRef();
    const held = new GenSlotRef();
    const blockedOut = new GenOutput();
    const goodOut = new GenOutput();

    graph.add(missing);
    graph.add(held);
    graph.add(blockedOut);
    graph.add(goodOut);
    graph.connect(missing.outputs.image, blockedOut.inputs.image);
    graph.connect(held.outputs.image, goodOut.inputs.image);
    setProp(missing, 'slot', 'plate:library');
    setProp(held, 'slot', 'plate:hall');
    mock.slotAssets.set('plate:hall', putAsset(mock, 'a hall'));

    const result = await executeGenGraph(graph, context([]), {
      targets: [blockedOut.id, goodOut.id],
    });

    expect(result.failures).toHaveLength(1);
    expect(result.blocked).toEqual([blockedOut.id]);
    expect(result.ran).toContain(goodOut.id);
  });
});

describe('seeding', () => {
  it('refuses a seed naming an input the type does not declare', async () => {
    const { graph, output } = chain();

    await expect(
      executeGenGraph(graph, context([]), {
        targets: [output.id],
        seeds  : { GenDerivedPrompt: { nope: '' } },
      }),
    ).rejects.toThrow("takes no seeded input 'nope'");
  });

  it('carries a seeded reference list down to the model', async () => {
    const graph = new Graph();
    const refs = new GenTaskRefs();
    const image = new GenImage();
    const output = new GenOutput();
    const asset = putAsset(mock, 'a sheet');

    graph.add(refs);
    graph.add(image);
    graph.add(output);
    graph.connect(refs.outputs.refs, image.inputs.refs);
    graph.connect(image.outputs.image, output.inputs.image);

    await executeGenGraph(graph, context([]), {
      targets: [output.id],
      seeds  : { GenTaskRefs: { assets: JSON.stringify([asset]) } },
    });

    expect(mock.images[0]?.refs.map((r) => r.bytes)).toEqual([bytes('a sheet')]);
  });

  it('leaves a seeded input the author wired something into alone', async () => {
    const graph = new Graph();
    const authored = new GenTemplate();
    const refs = new GenTaskRefs();
    const image = new GenImage();
    const output = new GenOutput();
    const wired = putAsset(mock, 'the wired sheet');
    const seeded = putAsset(mock, 'the seeded sheet');

    graph.add(authored);
    graph.add(refs);
    graph.add(image);
    graph.add(output);
    graph.connect(authored.outputs.text, refs.inputs.assets);
    graph.connect(refs.outputs.refs, image.inputs.refs);
    graph.connect(image.outputs.image, output.inputs.image);
    setProp(authored, 'template', JSON.stringify([wired]));

    await executeGenGraph(graph, context([]), {
      targets: [output.id],
      seeds  : { GenTaskRefs: { assets: JSON.stringify([seeded]) } },
    });

    expect(mock.images[0]?.refs.map((r) => r.bytes)).toEqual([bytes('the wired sheet')]);
  });
});

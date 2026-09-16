import {
  GenDerivedPrompt,
  GenEditImage,
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
import { graphDrift } from '../drift.js';
import { executeGenGraph, invalidateGenGraph } from '../execute.js';
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

  it('re-runs a node whose props changed, and everything below it that its new picture feeds', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    setProp(image, 'aspect', '3:2');
    mock.drawn = { ...mock.drawn, bytes: bytes('a wider take') };
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.skipped).toEqual([prompt.id]);
    expect(second.ran).toEqual([image.id, output.id]);
    expect(mock.images).toHaveLength(2);
  });

  it('re-runs a node whose seeded input changed', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : { GenDerivedPrompt: { prompt: 'a lantern at dawn' } },
    });

    expect(second.ran).toEqual([prompt.id, image.id]);
    expect(mock.images[1]?.prompt).toBe('a lantern at dawn');
    // The mock draws the same bytes for any prompt, so the output node was fed what it was before
    expect(second.skipped).toEqual([output.id]);
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

function journalOf(records: readonly GraphJournalRecord[]) {
  return replayJournal(records.map((r) => JSON.stringify(r)).join('\n'));
}

describe('resuming by run key', () => {
  it('resumes a picture the node drew before an intervening change, and clears drift', async () => {
    const { graph, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    const first = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });
    setProp(image, 'model', 'other/model');
    mock.drawn = { ...mock.drawn, bytes: bytes("the other model's take") };
    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    setProp(image, 'model', '');
    const before = records.length;
    const third = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(mock.images).toHaveLength(2);
    expect(third.ran).toEqual([]);
    expect(third.outputs.get(output.id)).toEqual(first.outputs.get(output.id));
    // The latest done records were the other model's, so the resumed nodes re-record
    // themselves under the current hashes and the output node no longer reads as drifted
    const fresh = records.slice(before);
    expect(fresh.map((r) => [r.nodeId, r.status])).toEqual([
      [image.id, 'done'],
      [output.id, 'done'],
    ]);
    expect(fresh.every((r) => r.runKey !== undefined && r.usage === undefined)).toBe(true);
    expect(graphDrift(graph, journalOf(records))).toEqual([]);
  });

  it('runs a node whose upstream answered differently at the same hash', async () => {
    // A feeds B. After a force redraws A and B fails on it, flipping A's model away and back
    // resumes A's redraw, and B must run: its only answers were drawn from A's other pictures.
    const graph = new Graph();
    const prompt = new GenDerivedPrompt();
    const a = new GenImage();
    const b = new GenEditImage();
    const output = new GenOutput();
    graph.add(prompt);
    graph.add(a);
    graph.add(b);
    graph.add(output);
    graph.connect(prompt.outputs.prompt, a.inputs.prompt);
    graph.connect(a.outputs.image, b.inputs.base);
    graph.connect(prompt.outputs.prompt, b.inputs.prompt);
    graph.connect(b.outputs.image, output.inputs.image);
    setProp(output, 'slot', 'portrait:aiko');
    const records: GraphJournalRecord[] = [];
    const edit = mock.image.edit;

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });

    mock.drawn = { ...mock.drawn, bytes: bytes('a redrawn base') };
    mock.image.edit = () => Promise.reject(new Error('the edit model is down'));
    const forced = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
      force  : true,
    });
    expect(forced.failures.map((f) => f.nodeId)).toEqual([b.id]);

    mock.image.edit = edit;
    setProp(a, 'model', 'other/model');
    mock.drawn = { ...mock.drawn, bytes: bytes("the other model's base") };
    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });

    setProp(a, 'model', '');
    const edits = mock.images.filter((call) => call.kind === 'edit').length;
    const back = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(back.skipped).toContain(a.id);
    expect(back.ran).toContain(b.id);
    expect(mock.images.filter((call) => call.kind === 'edit')).toHaveLength(edits + 1);
    expect(mock.images[mock.images.length - 1]?.base?.bytes).toEqual(bytes('a redrawn base'));
  });

  it('resumes a node below one that ran again when the bytes came back the same', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
      force  : true,
    });

    expect(second.ran).toEqual([image.id]);
    expect(second.skipped).toEqual([prompt.id, output.id]);
  });

  it('records the new authored hash on a node whose output an edit left unchanged', async () => {
    const graph = new Graph();
    const prompt = new GenDerivedPrompt();
    const template = new GenTemplate();
    const image = new GenImage();
    const output = new GenOutput();
    graph.add(prompt);
    graph.add(template);
    graph.add(image);
    graph.add(output);
    graph.connect(prompt.outputs.prompt, template.inputs.varA);
    graph.connect(template.outputs.text, image.inputs.prompt);
    graph.connect(image.outputs.image, output.inputs.image);
    setProp(template, 'template', '{varA}');
    setProp(output, 'slot', 'portrait:aiko');
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    // varC is unwired and empty, so the template's text does not change
    setProp(template, 'template', '{varA}{varC}');
    expect(graphDrift(graph, journalOf(records)).map((d) => d.nodeId)).toEqual([output.id]);
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.ran).toEqual([template.id]);
    expect(second.skipped).toEqual([prompt.id, image.id, output.id]);
    expect(mock.images).toHaveLength(1);
    expect(graphDrift(graph, journalOf(records))).toEqual([]);
  });

  it('runs a node whose recorded picture is no longer in the store', async () => {
    const { graph, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    const first = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });
    const drawn = first.outputs.get(image.id)?.image as { hash: string };
    mock.blobs.stored.delete(drawn.hash);
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.ran).toContain(image.id);
    expect(mock.images).toHaveLength(2);
  });

  it('resumes a pre-key journal as a pure chain', async () => {
    const { graph, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const preKey = records.map(({ runKey: _runKey, ...rest }) => ({ ...rest, v: 1 }));
    const second = await executeGenGraph(graph, context(preKey), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.ran).toEqual([]);
    expect(second.skipped).toHaveLength(3);
    expect(mock.images).toHaveLength(1);
  });

  it('runs a pre-key node below the first node that resumed by key', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const mixed = records.map(({ runKey, ...rest }) =>
      rest.nodeId === image.id ? { ...rest, runKey } : { ...rest, v: 1 },
    );
    const second = await executeGenGraph(graph, context(mixed), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.skipped).toEqual([prompt.id, image.id]);
    expect(second.ran).toEqual([output.id]);
    expect(mock.images).toHaveLength(1);
  });

  it('feeds a socket with two sources the resumed values', async () => {
    const build = (): { graph: Graph; composed: GenImage; output: GenOutput } => {
      const graph = new Graph();
      const prompt = new GenDerivedPrompt();
      const left = new GenImage();
      const right = new GenImage();
      const composed = new GenImage();
      const output = new GenOutput();
      graph.add(prompt);
      graph.add(left);
      graph.add(right);
      graph.add(composed);
      graph.add(output);
      setProp(left, 'seed', '1');
      setProp(right, 'seed', '2');
      setProp(output, 'slot', 'portrait:aiko');
      composed.inputs.refs.multiSocket = true;
      graph.connect(prompt.outputs.prompt, left.inputs.prompt);
      graph.connect(prompt.outputs.prompt, right.inputs.prompt);
      graph.connect(prompt.outputs.prompt, composed.inputs.prompt);
      graph.connect(left.outputs.image, composed.inputs.refs);
      graph.connect(right.outputs.image, composed.inputs.refs);
      graph.connect(composed.outputs.image, output.inputs.image);
      return { graph, composed, output };
    };
    const records: GraphJournalRecord[] = [];

    const first = build();
    await executeGenGraph(first.graph, context(records), {
      targets: [first.output.id],
      seeds  : SEEDS,
    });
    expect(mock.images).toHaveLength(3);
    expect(mock.images[2]?.refs).toHaveLength(1);

    // A fresh graph object, as a reload gives, so nothing is memoized from the first run
    const second = build();
    const rerun = await executeGenGraph(second.graph, context(records), {
      targets: [second.output.id],
      seeds  : SEEDS,
    });

    expect(rerun.ran).toEqual([]);
    expect(rerun.skipped).toContain(second.composed.id);
    expect(mock.images).toHaveLength(3);
  });

  it('reads a slot again on every run, and redraws below it when the slot moved', async () => {
    // A slot-ref node answers from the project rather than from its inputs, so no record of
    // it is an answer for this run. The edit below it keys on the picture it hands down.
    const graph = new Graph();
    const plate = new GenSlotRef();
    const prompt = new GenDerivedPrompt();
    const edit = new GenEditImage();
    const output = new GenOutput();
    graph.add(plate);
    graph.add(prompt);
    graph.add(edit);
    graph.add(output);
    graph.connect(plate.outputs.image, edit.inputs.base);
    graph.connect(prompt.outputs.prompt, edit.inputs.prompt);
    graph.connect(edit.outputs.image, output.inputs.image);
    setProp(plate, 'slot', 'plate:hall');
    setProp(output, 'slot', 'portrait:aiko');
    const records: GraphJournalRecord[] = [];

    mock.slotAssets.set('plate:hall', putAsset(mock, 'the first hall'));
    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const same = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(same.ran).toEqual([plate.id]);
    expect(same.skipped).toEqual([prompt.id, edit.id, output.id]);
    expect(mock.images).toHaveLength(1);

    mock.slotAssets.set('plate:hall', putAsset(mock, 'the hall, redrawn'));
    mock.drawn = { ...mock.drawn, bytes: bytes('the edit over the redrawn hall') };
    const moved = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(moved.ran).toEqual([plate.id, edit.id, output.id]);
    expect(mock.images).toHaveLength(2);
    expect(mock.images[1]?.base?.bytes).toEqual(bytes('the hall, redrawn'));
  });
});

describe('a deliberate re-render', () => {
  it('invalidates each paid ancestor and re-runs it while prep still resumes', async () => {
    const { graph, prompt, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    const before = records.length;
    mock.drawn = { ...mock.drawn, bytes: bytes('a second take') };
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

  it('runs a forced node although an older answer matches, and resumes the new one after', async () => {
    const { graph, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    const first = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });
    mock.drawn = { ...mock.drawn, bytes: bytes('a second take') };
    await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
      force  : true,
    });
    const third = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(mock.images).toHaveLength(2);
    expect(third.ran).toEqual([]);
    expect(third.skipped).toContain(image.id);
    expect(third.outputs.get(output.id)).not.toEqual(first.outputs.get(output.id));
  });

  it('honours an invalidation written at rest, the way a regenerate writes one', async () => {
    const { graph, image, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(records), { targets: [output.id], seeds: SEEDS });
    await invalidateGenGraph(
      graph,
      {
        record: (record) => {
          records.push(record);
          return Promise.resolve();
        },
        now   : () => new Date('2026-01-01T00:00:00.000Z'),
      },
      [output.id],
    );
    const second = await executeGenGraph(graph, context(records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.ran).toContain(image.id);
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

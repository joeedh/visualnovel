/**
 * An image node whose model prop is empty draws with the project's image model: the runtime
 * resolves it, the run hash carries it, and the estimate prices it.
 */
import {
  GenDerivedPrompt,
  GenEditImage,
  GenImage,
  GenOutput,
  Graph,
  estimateGraph,
  genNodeRuntime,
  registerGenRuntimes,
  replayJournal,
} from '../index.js';
import type { GraphJournalRecord } from '../index.js';
import { executeGenGraph } from '../execute.js';
import type { GenRunContext } from '../execute.js';
import { authoredHashes, graphHashes } from '../hash.js';
import { mockServices, MOCK_IMAGE_MODEL } from '../nodes/tests/__fixtures__/services.js';
import type { MockServices } from '../nodes/tests/__fixtures__/services.js';

registerGenRuntimes();

const PROJECT_MODEL = 'openai/gpt-image-2';
const OTHER_MODEL = 'bfl/flux-2';
const SEEDS = { GenDerivedPrompt: { prompt: 'a lantern at dusk' } };

/** A derived prompt feeding one image node, feeding the output bound to a slot. */
function chain(): { graph: Graph; image: GenImage; output: GenOutput } {
  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const image = new GenImage();
  const output = new GenOutput();

  graph.add(prompt);
  graph.add(image);
  graph.add(output);
  graph.connect(prompt.outputs.prompt, image.inputs.prompt);
  graph.connect(image.outputs.image, output.inputs.image);
  output.props.slot!.setValue('portrait:aiko');

  return { graph, image, output };
}

function context(mock: MockServices, into: GraphJournalRecord[]): GenRunContext {
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

describe('the model an image node draws with', () => {
  it('defaults to empty on both image nodes', () => {
    expect(new GenImage().props.model!.getValue()).toBe('');
    expect(new GenEditImage().props.model!.getValue()).toBe('');
  });

  it('is the project’s while the prop is empty, so no backend sees an empty id', async () => {
    const mock = mockServices({ imageModel: PROJECT_MODEL });
    const run = genNodeRuntime('GenImage')!;

    await run({ prompt: 'a lantern' }, { model: '', aspect: '', seed: '' }, mock);
    await run({ prompt: 'a lantern' }, { model: '  ', aspect: '', seed: '' }, mock);

    expect(mock.images.map((call) => call.params.modelId)).toEqual([PROJECT_MODEL, PROJECT_MODEL]);
  });

  it('is the node’s own where it names one', async () => {
    const mock = mockServices({ imageModel: PROJECT_MODEL });
    const run = genNodeRuntime('GenEditImage')!;
    const base = await mock.blobs.write(new TextEncoder().encode('a take'), 'png');

    await run(
      { base: { store: 'blob', hash: base.hash, ext: 'png' }, prompt: 'warmer' },
      { model: OTHER_MODEL, aspect: '', seed: '' },
      mock,
    );

    expect(mock.images[0]?.params.modelId).toBe(OTHER_MODEL);
  });
});

describe('the run hash of an inherit node', () => {
  it('moves with the project’s model and holds still under the same one', () => {
    const { graph, image } = chain();

    const underA = graphHashes(graph, { imageModel: PROJECT_MODEL }).get(image.id);
    const underAAgain = graphHashes(graph, { imageModel: PROJECT_MODEL }).get(image.id);
    const underB = graphHashes(graph, { imageModel: OTHER_MODEL }).get(image.id);

    expect(underAAgain).toBe(underA);
    expect(underB).not.toBe(underA);
  });

  it('equals the hash of a node naming that model outright', () => {
    const inherit = chain();
    const literal = chain();
    literal.image.props.model!.setValue(PROJECT_MODEL);

    expect(graphHashes(inherit.graph, { imageModel: PROJECT_MODEL }).get(inherit.image.id)).toBe(
      graphHashes(literal.graph).get(literal.image.id),
    );
  });

  it('leaves a node naming its own model alone', () => {
    const { graph, image } = chain();
    image.props.model!.setValue(OTHER_MODEL);

    expect(graphHashes(graph, { imageModel: PROJECT_MODEL }).get(image.id)).toBe(
      graphHashes(graph).get(image.id),
    );
  });

  it('is not part of the authored hash, which the file alone decides', () => {
    const { graph, image } = chain();
    const before = authoredHashes(graph).get(image.id);

    expect(graphHashes(graph, { imageModel: OTHER_MODEL }).get(image.id)).not.toBe(before);
    expect(authoredHashes(graph).get(image.id)).toBe(before);
  });
});

describe('resuming across a change of project model', () => {
  it('runs the image node again rather than handing back the old model’s picture', async () => {
    const { graph, output } = chain();
    const records: GraphJournalRecord[] = [];

    const first = mockServices({ imageModel: PROJECT_MODEL });
    await executeGenGraph(graph, context(first, records), { targets: [output.id], seeds: SEEDS });
    expect(first.images.map((call) => call.params.modelId)).toEqual([PROJECT_MODEL]);

    const second = mockServices({ imageModel: OTHER_MODEL });
    const rerun = await executeGenGraph(graph, context(second, records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(second.images.map((call) => call.params.modelId)).toEqual([OTHER_MODEL]);
    expect(rerun.ran).toContain(graph.nodes.find((n) => n instanceof GenImage)!.id);
  });

  it('resumes the image node while the project model is unchanged', async () => {
    const { graph, output } = chain();
    const records: GraphJournalRecord[] = [];

    await executeGenGraph(graph, context(mockServices(), records), {
      targets: [output.id],
      seeds  : SEEDS,
    });
    const again = mockServices();
    const rerun = await executeGenGraph(graph, context(again, records), {
      targets: [output.id],
      seeds  : SEEDS,
    });

    expect(again.images).toEqual([]);
    expect(rerun.skipped).toContain(graph.nodes.find((n) => n instanceof GenImage)!.id);
    expect(again.image.defaultModel).toBe(MOCK_IMAGE_MODEL);
  });
});

describe('estimating an inherit node', () => {
  it('prices it against the project model the caller passes', () => {
    const { graph } = chain();

    const lines = estimateGraph(graph, { imageModel: PROJECT_MODEL }).lines;

    expect(lines).toEqual([{ service: 'image', model: PROJECT_MODEL, unit: 'image', count: 1 }]);
  });

  it('prices it as an unnamed model when the caller passes none', () => {
    const { graph } = chain();

    expect(estimateGraph(graph).lines).toEqual([
      { service: 'image', model: '', unit: 'image', count: 1 },
    ]);
  });

  it('prices a node naming its own model against that one', () => {
    const { graph, image } = chain();
    image.props.model!.setValue(OTHER_MODEL);

    expect(estimateGraph(graph, { imageModel: PROJECT_MODEL }).lines).toEqual([
      { service: 'image', model: OTHER_MODEL, unit: 'image', count: 1 },
    ]);
  });
});

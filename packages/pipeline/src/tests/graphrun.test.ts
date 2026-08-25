/**
 * A task whose slot a generation graph is bound to. The runner seeds the graph's host-seeded
 * inputs from the task and stores whatever the active output terminates on, so the picture
 * reaches the asset store through the same write the unbound runners use. What the graph adds
 * is where the prompt comes from and how a critique re-enters, and both are checked here
 * against a real project on disk running through the real scheduler.
 */
import {
  GenDerivedPrompt,
  GenImage,
  GenOutput,
  GenRefinePrompt,
  GenTemplate,
  Graph,
  registerGenRuntimes,
} from '@vn/gengraph';
import type { GraphJournalRecord, Node } from '@vn/gengraph';
import { graphJournalFile } from '@vn/gengraph/state';
import { writeShots } from '@vn/store';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { Asset, Shot } from '@vn/types';
import { readText } from '@vn/util';

jest.setTimeout(120_000);

registerGenRuntimes();

/** The key the testkit files this graph's journal and blobs under. */
const SLUG = 'bound';

const BLOCKING =
  '{"reviewer":"r","defects":[{"severity":"blocking","category":"outfit","description":"wrong"}]}';

function setProp(node: Node, key: string, value: unknown): void {
  const prop = node.props[key];
  if (prop === undefined) {
    throw new Error(`this node has no prop '${key}'`);
  }
  prop.setValue(value);
}

/** The derived prompt drawn straight through one image node into the bound output. */
function plainGraph(slot: string): Graph {
  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const image = new GenImage();
  const output = new GenOutput();

  graph.add(prompt);
  graph.add(image);
  graph.add(output);
  graph.connect(prompt.outputs.prompt, image.inputs.prompt);
  graph.connect(image.outputs.image, output.inputs.image);
  setProp(output, 'slot', slot);

  return graph;
}

/** The same chain with an authored template in it, whose text the derived prompt cannot supply. */
function templateGraph(slot: string, template: string): Graph {
  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const text = new GenTemplate();
  const image = new GenImage();
  const output = new GenOutput();

  graph.add(prompt);
  graph.add(text);
  graph.add(image);
  graph.add(output);
  graph.connect(prompt.outputs.prompt, text.inputs.a);
  graph.connect(text.outputs.text, image.inputs.prompt);
  graph.connect(image.outputs.image, output.inputs.image);
  setProp(text, 'template', template);
  setProp(output, 'slot', slot);

  return graph;
}

interface RefineGraph {
  graph: Graph;
  /** The authored text ahead of the image node, which a critique must not disturb. */
  text: GenTemplate;
  critique: GenRefinePrompt;
  image: GenImage;
}

/** A chain whose image node also takes a critique, so a refine pass re-enters below the text. */
function refineGraph(slot: string): RefineGraph {
  const graph = new Graph();
  const prompt = new GenDerivedPrompt();
  const text = new GenTemplate();
  const critique = new GenRefinePrompt();
  const image = new GenImage();
  const output = new GenOutput();

  graph.add(prompt);
  graph.add(text);
  graph.add(critique);
  graph.add(image);
  graph.add(output);
  graph.connect(prompt.outputs.prompt, text.inputs.a);
  graph.connect(text.outputs.text, image.inputs.prompt);
  graph.connect(critique.outputs.text, image.inputs.refine);
  graph.connect(image.outputs.image, output.inputs.image);
  setProp(text, 'template', '{a}');
  setProp(output, 'slot', slot);

  return { graph, text, critique, image };
}

/** How many runs each node finished, counted from the journal the run appended to. */
async function runsPerNode(p: TestProject): Promise<Map<string, number>> {
  const text = await readText(graphJournalFile(p.paths, SLUG));
  const counts = new Map<string, number>();

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const record = JSON.parse(line) as GraphJournalRecord;
    if (record.status === 'done') {
      const id = String(record.nodeId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  return counts;
}

async function portraitOf(p: TestProject): Promise<Asset> {
  const { store } = await p.reload();
  const asset = store.manifest().find((a) => a.kind === 'portrait');
  if (asset === undefined) {
    throw new Error('the run drew no portrait');
  }
  return asset;
}

describe('a task whose slot a graph is bound to', () => {
  it('draws what the graph asks for rather than what the task derived', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const summary = await p.run({
        graphs: { [SLUG]: templateGraph('portrait:aiko', '{a}, in ink wash') },
      });

      expect(summary.failed).toEqual([]);
      expect(summary.ran.some((t) => t.kind === 'portrait' && t.status === 'done')).toBe(true);
      expect((await portraitOf(p)).prompt).toMatch(/, in ink wash$/);
    } finally {
      await p.cleanup();
    }
  });

  it('leaves every other slot on the path it took before graphs existed', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const summary = await p.run({ graphs: { [SLUG]: plainGraph('portrait:aiko') } });
      const plates = summary.ran.filter((t) => t.kind === 'location_ref');

      expect(plates.length).toBeGreaterThan(0);
      expect(plates.every((t) => t.status === 'done')).toBe(true);
    } finally {
      await p.cleanup();
    }
  });

  it('records the picture exactly as the unbound runner records one', async () => {
    const bound = await makeProject({ script: SCRIPTS.linear });
    const plain = await makeProject({ script: SCRIPTS.linear });
    try {
      await bound.run({ graphs: { [SLUG]: plainGraph('portrait:aiko') } });
      await plain.run();

      // The graph passes the derived prompt through unchanged and the stub backend derives its
      // bytes from the prompt and the refs, so the two records agree down to the content hash.
      expect(await portraitOf(bound)).toEqual(await portraitOf(plain));
    } finally {
      await bound.cleanup();
      await plain.cleanup();
    }
  });
});

describe('a refine pass through a bound graph', () => {
  it('re-runs the tail below the refine node and resumes everything above it', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, config: { max_refine_attempts: 2 } });
    try {
      const shot: Shot = {
        id: 's1',
        sceneId: 'arrival',
        framing: 'medium',
        location: 'day',
        subjects: [{ characterId: 'aiko' }],
        camera: 'static',
        coversLines: [],
        status: 'pending',
      };
      await writeShots(p.paths, 'arrival', [shot]);
      await p.run();
      await p.approve('aiko');

      const { graph, text, critique, image } = refineGraph('shot:arrival/s1');
      const summary = await p.run({ graphs: { [SLUG]: graph }, reviewResponses: [BLOCKING] });
      const runs = await runsPerNode(p);

      // The critique repeats unchanged on the second attempt, so the frame is handed to a human
      // rather than drawn a third time.
      expect(summary.needsHuman.map((t) => t.kind)).toContain('shot_image');
      expect(runs.get(String(critique.id))).toBe(2);
      expect(runs.get(String(image.id))).toBe(2);
      expect(runs.get(String(text.id))).toBe(1);
    } finally {
      await p.cleanup();
    }
  });
});

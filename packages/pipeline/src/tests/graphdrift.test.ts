/**
 * Editing a generation graph redraws the slots it is bound to. A task's hash does not move
 * when a graph is edited, because the graph is the slot's runner rather than part of what the
 * slot is, so a run compares each bound graph against what its journal recorded and puts the
 * tasks whose graph has changed back to `pending`. Checked against a real project on disk
 * running through the real scheduler.
 */
import {
  GenDerivedPrompt,
  GenImage,
  GenOutput,
  GenTemplate,
  Graph,
  registerGenRuntimes,
} from '@vn/gengraph';
import type { Node } from '@vn/gengraph';
import { SCRIPTS, makeProject } from '@vn/testkit';

jest.setTimeout(120_000);

registerGenRuntimes();

/** The key the testkit files this graph's journal and blobs under. */
const SLUG = 'bound';

function setProp(node: Node, key: string, value: unknown): void {
  const prop = node.props[key];
  if (prop === undefined) {
    throw new Error(`this node has no prop '${key}'`);
  }
  prop.setValue(value);
}

/** The derived prompt through an authored template, whose text is the edit each test makes. */
function templateGraph(slot: string): { graph: Graph; text: GenTemplate } {
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
  setProp(text, 'template', '{a}');
  setProp(output, 'slot', slot);

  return { graph, text };
}

describe('a run whose bound graph has not been edited', () => {
  it('leaves the slot it already drew alone', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { graph } = templateGraph('portrait:aiko');
      await p.run({ graphs: { [SLUG]: graph } });

      // The prompt and refs a run seeds land on input defaults and so move the run hashes,
      // which is why drift is measured against the graph's authored hashes instead. Without
      // that, an unedited graph would ask to be redrawn on every run for ever.
      const second = await p.run({ graphs: { [SLUG]: graph } });

      expect(second.redrawn).toEqual([]);
      expect(second.ran).toEqual([]);
    } finally {
      await p.cleanup();
    }
  });
});

describe('a run whose bound graph has been edited', () => {
  it('redraws the slot the edited graph fills, and nothing beside it', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { graph, text } = templateGraph('portrait:aiko');
      const first = await p.run({ graphs: { [SLUG]: graph } });
      const drawn = first.ran.find((t) => t.kind === 'portrait');
      expect(drawn).toBeDefined();

      setProp(text, 'template', '{a}, in ink wash');
      const second = await p.run({ graphs: { [SLUG]: graph } });

      expect(second.redrawn).toEqual([drawn!.hash]);
      expect(second.ran.map((t) => t.hash)).toEqual([drawn!.hash]);

      const { store } = await p.reload();
      const prompts = store
        .manifest()
        .filter((a) => a.kind === 'portrait')
        .map((a) => a.prompt);
      expect(prompts).toContainEqual(expect.stringMatching(/, in ink wash$/));
    } finally {
      await p.cleanup();
    }
  });

  it('asks for the redraw once, because the redraw records the graph it ran', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { graph, text } = templateGraph('portrait:aiko');
      await p.run({ graphs: { [SLUG]: graph } });

      setProp(text, 'template', '{a}, in ink wash');
      await p.run({ graphs: { [SLUG]: graph } });
      const third = await p.run({ graphs: { [SLUG]: graph } });

      expect(third.redrawn).toEqual([]);
      expect(third.ran).toEqual([]);
    } finally {
      await p.cleanup();
    }
  });
});

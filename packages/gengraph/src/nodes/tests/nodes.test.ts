import { buildPortraitChunks, renderPrompt } from '@vn/artgen';
import { projectConfig } from '@vn/types';
import type { Character } from '@vn/types';
import { PropFlags } from 'pathux-toolprop';
import type { ToolProperty } from 'pathux-toolprop';

import {
  GenDerivedPrompt,
  GenEditImage,
  GenImage,
  GenImageFile,
  GenOutput,
  GenRefList,
  GenRefinePrompt,
  GenRewrite,
  GenSlotRef,
  GenSwitch,
  GenTaskRefs,
  GenTemplate,
  Graph,
  genNodeRuntime,
  genNodeSpec,
  genNodeTypes,
  nodePropKeys,
  nodePropTarget,
  registerGenRuntimes,
} from '../../index.js';
import type {
  GenImageRef,
  GenInputs,
  GenOutputs,
  GenProps,
  NodeTypeConstructor,
} from '../../index.js';
import { bytes, mockServices, putAsset } from './__fixtures__/services.js';
import type { MockServices } from './__fixtures__/services.js';

registerGenRuntimes();

let mock: MockServices;

beforeEach(() => {
  mock = mockServices();
});

/** The props a freshly built node of this type carries, which is what a run starts from. */
function defaults(cls: NodeTypeConstructor): GenProps {
  const props: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(new cls().props)) {
    props[key] = prop.getValue();
  }
  return props;
}

function run(
  cls: NodeTypeConstructor,
  inputs: GenInputs = {},
  props: GenProps = {},
): Promise<GenOutputs> {
  const typeName = cls.graphDef().typeName;
  const runtime = genNodeRuntime(typeName);
  if (runtime === undefined) {
    throw new Error(`${typeName} has no runtime`);
  }
  return runtime(inputs, { ...defaults(cls), ...props }, mock);
}

const AIKO: Character = {
  id: 'aiko',
  name: 'Aiko',
  description: 'A tall archivist in a grey coat.',
  traits: ['reserved'],
  palette: ['#334455', '#ddccbb'],
  status: 'approved',
  defaultOutfit: 'default',
  outfits: [{ id: 'default', characterId: 'aiko', description: 'grey coat' }],
  artNotes: 'ink-wash linework',
};

describe('the seeded input nodes', () => {
  it('passes the derived prompt through unchanged', async () => {
    const seeded = '  Art style: watercolor.  Two   spaces kept.  ';

    await expect(run(GenDerivedPrompt, { prompt: seeded })).resolves.toEqual({ prompt: seeded });
  });

  it('reproduces byte for byte what the runner composes for a slot', () => {
    const config = projectConfig.parse({
      title: 'Test',
      art_style: 'watercolor',
      models: { vision: ['gemini', 'claude'] },
    });
    const composed = renderPrompt(buildPortraitChunks(AIKO, config));

    return expect(run(GenDerivedPrompt, { prompt: composed })).resolves.toEqual({
      prompt: composed,
    });
  });

  it('reads the seeded task refs as assets', async () => {
    const seeded = JSON.stringify([
      { hash: 'aa', ext: 'png' },
      { hash: 'bb', ext: 'webp' },
    ]);

    await expect(run(GenTaskRefs, { assets: seeded })).resolves.toEqual({
      refs: [
        { store: 'asset', hash: 'aa', ext: 'png' },
        { store: 'asset', hash: 'bb', ext: 'webp' },
      ],
    });
  });

  it('reads an unseeded task-refs node as no references at all', async () => {
    await expect(run(GenTaskRefs)).resolves.toEqual({ refs: [] });
  });

  it('refuses seeded refs that are not JSON', async () => {
    await expect(run(GenTaskRefs, { assets: '[oops' })).rejects.toThrow('not JSON');
  });

  it('refuses a seeded ref naming no hash', async () => {
    await expect(run(GenTaskRefs, { assets: '[{"ext":"png"}]' })).rejects.toThrow(
      'no hash and ext',
    );
  });

  it('carries no critique until a refine pass writes one', async () => {
    await expect(run(GenRefinePrompt)).resolves.toEqual({ text: '' });
    await expect(run(GenRefinePrompt, { text: 'the hands are wrong' })).resolves.toEqual({
      text: 'the hands are wrong',
    });
  });
});

describe('the nodes that read a store', () => {
  it('reads whatever asset a slot holds', async () => {
    const ref = putAsset(mock, 'a plate');
    mock.slotAssets.set('plate:library', ref);

    await expect(run(GenSlotRef, {}, { slot: 'plate:library' })).resolves.toEqual({
      image: { store: 'asset', hash: ref.hash, ext: 'png' },
    });
  });

  it('refuses a slot that holds nothing yet', async () => {
    await expect(run(GenSlotRef, {}, { slot: 'plate:library' })).rejects.toThrow('holds no asset');
  });

  it('refuses a slot-ref node naming no slot', async () => {
    await expect(run(GenSlotRef)).rejects.toThrow('names no slot');
  });

  it('names a picture already in the asset store', async () => {
    const ref = putAsset(mock, 'an upload');

    await expect(run(GenImageFile, {}, { hash: ref.hash, ext: 'png' })).resolves.toEqual({
      image: { store: 'asset', hash: ref.hash, ext: 'png' },
    });
  });

  it('refuses a hash the store does not hold', async () => {
    await expect(run(GenImageFile, {}, { hash: 'nothing' })).rejects.toThrow('is in the store');
  });
});

describe('the text nodes', () => {
  it('fills a template from its inputs', async () => {
    await expect(
      run(GenTemplate, { a: 'a cat', b: 'dusk' }, { template: '{a} at {b}, {a} again.' }),
    ).resolves.toEqual({ text: 'a cat at dusk, a cat again.' });
  });

  it('sends a template naming no placeholder as plain text', async () => {
    await expect(run(GenTemplate, {}, { template: 'plain words' })).resolves.toEqual({
      text: 'plain words',
    });
  });

  it('sends the instruction above the text it rewrites', async () => {
    mock.reply = 'tightened';

    const out = await run(
      GenRewrite,
      { text: 'a long line' },
      { model: 'mock-text', instruction: 'Shorten this.', system: 'You edit prose.' },
    );

    expect(out).toEqual({ text: 'tightened' });
    expect(mock.texts).toEqual([
      { modelId: 'mock-text', prompt: 'Shorten this.\n\na long line', system: 'You edit prose.' },
    ]);
  });

  it('sends the text alone when nothing instructs the model', async () => {
    await run(GenRewrite, { text: 'a long line' });

    expect(mock.texts[0]?.prompt).toBe('a long line');
    expect(mock.texts[0]?.system).toBeUndefined();
  });
});

describe('the image nodes', () => {
  it('joins the derived prompt and a refine pass critique', async () => {
    await run(GenImage, { prompt: 'a lantern', refine: 'warmer light' });

    expect(mock.images[0]?.prompt).toBe('a lantern\n\nwarmer light');
  });

  it('sends the prompt alone while no critique has been written', async () => {
    await run(GenImage, { prompt: 'a lantern', refine: '' });

    expect(mock.images[0]?.prompt).toBe('a lantern');
  });

  it('stores what the model drew as a blob', async () => {
    const out = await run(GenImage, { prompt: 'a lantern' });
    const image = out.image as GenImageRef;

    expect(image.store).toBe('blob');
    expect(await mock.blobs.read(image.hash)).toEqual(bytes('drawn picture'));
  });

  it('reads reference pictures out of the store each one names', async () => {
    const asset = putAsset(mock, 'a sheet');
    const blob = await mock.blobs.write(bytes('an earlier take'), 'png');
    const refs: GenImageRef[] = [
      { store: 'asset', ...asset },
      { store: 'blob', ...blob },
    ];

    await run(GenImage, { prompt: 'a lantern', refs });

    expect(mock.images[0]?.refs.map((r) => r.bytes)).toEqual([
      bytes('a sheet'),
      bytes('an earlier take'),
    ]);
  });

  it('passes the aspect and seed the node authors', async () => {
    await run(GenImage, { prompt: 'a lantern' }, { model: 'mock-image', aspect: '3:2', seed: '0' });

    expect(mock.images[0]?.params).toEqual({ modelId: 'mock-image', aspect: '3:2', seed: 0 });
  });

  it('leaves an unauthored seed out rather than sending zero', async () => {
    await run(GenImage, { prompt: 'a lantern' });

    expect(mock.images[0]?.params.seed).toBeUndefined();
  });

  it('refuses a seed that is not a number', async () => {
    await expect(run(GenImage, { prompt: 'a lantern' }, { seed: 'later' })).rejects.toThrow(
      "seed 'later' is not a number",
    );
  });

  it('sends the base picture an edit redraws', async () => {
    const asset = putAsset(mock, 'the first take');

    await run(GenEditImage, { base: { store: 'asset', ...asset }, prompt: 'open the curtains' });

    expect(mock.images[0]?.kind).toBe('edit');
    expect(mock.images[0]?.base?.bytes).toEqual(bytes('the first take'));
  });

  it('refuses an edit with nothing to redraw', async () => {
    await expect(run(GenEditImage, { prompt: 'open the curtains' })).rejects.toThrow(
      "no picture on its 'base' input",
    );
  });

  it('refuses a reference the store has lost', async () => {
    const refs: GenImageRef[] = [{ store: 'blob', hash: 'gone', ext: 'png' }];

    await expect(run(GenImage, { prompt: 'a lantern', refs })).rejects.toThrow('holds no bytes');
  });
});

describe('the wiring nodes', () => {
  const one: GenImageRef = { store: 'blob', hash: 'one', ext: 'png' };
  const two: GenImageRef = { store: 'blob', hash: 'two', ext: 'png' };
  const three: GenImageRef = { store: 'blob', hash: 'three', ext: 'png' };

  it('keeps the list input ahead of the single pictures', async () => {
    await expect(run(GenRefList, { list: [one], a: two, b: three })).resolves.toEqual({
      refs: [one, two, three],
    });
  });

  it('leaves out the picture inputs nothing feeds', async () => {
    await expect(run(GenRefList, { b: two })).resolves.toEqual({ refs: [two] });
  });

  it('passes on whichever branch the switch names', async () => {
    await expect(run(GenSwitch, { a: one, b: two })).resolves.toEqual({ image: one });
    await expect(run(GenSwitch, { a: one, b: two }, { useB: true })).resolves.toEqual({
      image: two,
    });
  });

  it('refuses a switch whose chosen branch carries nothing', async () => {
    await expect(run(GenSwitch, { a: one }, { useB: true })).rejects.toThrow(
      "no picture on its 'b' input",
    );
  });

  it('carries the terminal picture on the output node', async () => {
    await expect(run(GenOutput, { image: one }, { slot: 'portrait:aiko' })).resolves.toEqual({
      image: one,
    });
  });

  it('refuses an output node with nothing feeding it', async () => {
    await expect(run(GenOutput, {}, { slot: 'portrait:aiko' })).rejects.toThrow(
      "no picture on its 'image' input",
    );
  });
});

describe('the specs the registry carries', () => {
  it('marks the three nodes that spend money', () => {
    const spending = [...['GenImage', 'GenEditImage', 'GenRewrite']].filter(
      (name) => genNodeSpec(name)?.spends === true,
    );

    expect(spending).toHaveLength(3);
    expect(genNodeSpec('GenTemplate')?.spends).toBeUndefined();
  });

  it('names the socket a refine pass re-enters at, and the node it falls back to', () => {
    expect(genNodeSpec('GenImage')?.refineInput).toBe('refine');
    expect(genNodeSpec('GenDerivedPrompt')?.refineFallback).toBe(true);
  });

  it('names the prop an output node fills a slot from', () => {
    expect(genNodeSpec('GenOutput')?.slotProp).toBe('slot');
  });
});

describe('the socket types', () => {
  it('reads one picture as a one-item reference list', () => {
    const graph = new Graph();
    const file = new GenImageFile();
    const list = new GenRefList();

    graph.add(file);
    graph.add(list);
    graph.connect(file.outputs.image, list.inputs.list);
    file.outputs.image.setValue({ store: 'blob', hash: 'one', ext: 'png' });

    expect(list.inputs.list.getValue()).toEqual([{ store: 'blob', hash: 'one', ext: 'png' }]);
  });

  it('reads an unwired text input as the empty string', () => {
    expect(new GenTemplate().inputs.a.getValue()).toBe('');
  });
});

describe('what a node type declares about its editable values', () => {
  /** Every value the node editor draws a row for, across all twelve types. */
  function editable(): { where: string; prop: ToolProperty }[] {
    const found: { where: string; prop: ToolProperty }[] = [];
    for (const cls of genNodeTypes().values()) {
      const node = new cls();
      for (const key of nodePropKeys(node)) {
        const prop = nodePropTarget(node, key);
        if (prop !== undefined) found.push({ where: `${node.def.typeName}.${key}`, prop });
      }
    }
    return found;
  }

  it('names and describes every one, because the row it is drawn as needs a tooltip', () => {
    const bare = editable()
      .filter(({ prop }) => !prop.uiname || !prop.description)
      .map(({ where }) => where);

    expect(bare).toEqual([]);
  });

  it("keeps every one off path.ux's own undo stack", () => {
    // path.ux types its flag table as a plain string record, so the constant reads as optional.
    const noUndo = PropFlags.NO_UNDO ?? 0;
    const undoable = editable()
      .filter(({ prop }) => (prop.flag & noUndo) === 0)
      .map(({ where }) => where);

    expect(undoable).toEqual([]);
  });
});

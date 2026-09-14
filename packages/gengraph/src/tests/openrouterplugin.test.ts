/**
 * The shipped OpenRouter plugin, installed and run the way an author's would be: one node
 * type this package does not declare, reaching OpenRouter's image endpoint through the
 * services alone with a key the host resolved.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as esbuild from 'esbuild';

import { bytes, mockServices } from '../nodes/tests/__fixtures__/services.js';
import type { MockFetchReply } from '../nodes/tests/__fixtures__/services.js';
import { activateGenPlugin, esbuildPluginBundler, userPluginsDir } from '../pluginload.js';
import { genPriceAgents } from '../priceagent.js';
import { genNodeRuntime, genNodeSpec } from '../registry.js';
import type { GenOutputs } from '../registry.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const PLUGIN = join(REPO_ROOT, 'plugins', 'openrouter');

const MODEL = 'google/gemini-2.5-flash-image';

const bundle = esbuildPluginBundler(esbuild);

/** What OpenRouter answers with, carrying one picture and its cost the way a real reply does. */
function drew(text: string, mime = 'image/png', cost?: number): MockFetchReply {
  const b64_json = Buffer.from(bytes(text)).toString('base64');
  return {
    body: JSON.stringify({
      created: 1,
      data   : [{ b64_json, media_type: mime }],
      ...(cost === undefined ? {} : { usage: { cost } }),
    }),
  };
}

/** Bytes that pass the plugin's own check that a reference is a picture. */
function png(tail: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes(tail)]);
}

interface SentBody {
  model: string;
  prompt: string;
  aspect_ratio?: string;
  seed?: number;
  input_references?: { type: string; image_url: { url: string } }[];
  provider?: { data_collection?: string };
}

function sentBody(services: ReturnType<typeof mockServices>): SentBody {
  return JSON.parse(String(services.fetches[0]?.init.body)) as SentBody;
}

let home = '';

// Activated once for the file: registration is global, and a second activation re-registers
// the same node class with path.ux, which warns about it.
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gengraph-openrouter-'));
  const dir = join(userPluginsDir({ env: { VNAUTHOR_HOME: home } }), 'openrouter');
  mkdirSync(dir, { recursive: true });
  cpSync(PLUGIN, dir, { recursive: true });

  const activated = await activateGenPlugin(dir, bundle);
  expect(activated).toMatchObject({ ok: true });
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('what the plugin registers', () => {
  it('declares one node type, spending and priced at one image of the named model', () => {
    const spec = genNodeSpec('OpenRouterImage');
    expect(spec?.spends).toBe(true);
    expect(spec?.refineInput).toBe('refine');
    expect(spec?.estimate?.({ model: MODEL }, { connected: new Set() })).toEqual([
      { service: 'image', model: MODEL, unit: 'image', count: 1 },
    ]);
  });

  it('registers no price agent, because OpenRouter prices each model as its provider does', () => {
    expect(genPriceAgents()).not.toContain('openrouter');
  });
});

describe('drawing a picture', () => {
  const props = { model: MODEL, aspect: '3:4', seed: '7' };

  it('asks the model named on the node and stores what came back, with its cost', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => drew('a drawing', 'image/png', 0.04),
    });
    const run = genNodeRuntime('OpenRouterImage');

    const out = (await run?.(
      { prompt: 'a cat', refine: 'brighter' },
      props,
      services,
    )) as GenOutputs;

    expect(out['modelId']).toBe(MODEL);
    expect(out['prompt']).toBe('a cat\n\nbrighter');
    expect(out['cost']).toBe(0.04);

    const image = out['image'] as { store: string; hash: string; ext: string };
    expect(image.store).toBe('blob');
    expect(image.ext).toBe('png');
    expect(services.blobs.stored.get(image.hash)).toEqual(bytes('a drawing'));
  });

  it('names a jpeg by its short extension and carries no cost the reply did not state', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => drew('a photo', 'image/jpeg'),
    });
    const out = (await genNodeRuntime('OpenRouterImage')?.(
      { prompt: 'a cat' },
      props,
      services,
    )) as GenOutputs;
    expect((out['image'] as { ext: string }).ext).toBe('jpg');
    expect('cost' in out).toBe(false);
  });

  it('sends the key as a bearer header, the ratio, the seed and a deny on data collection', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => drew('a drawing'),
    });
    await genNodeRuntime('OpenRouterImage')?.({ prompt: 'a cat' }, props, services);

    const call = services.fetches[0];
    expect(call?.url).toBe('https://openrouter.ai/api/v1/images');
    expect(call?.url).not.toContain('a-key');
    expect(call?.init.headers?.['authorization']).toBe('Bearer a-key');

    const sent = sentBody(services);
    expect(sent.model).toBe(MODEL);
    expect(sent.prompt).toBe('a cat');
    expect(sent.aspect_ratio).toBe('3:4');
    expect(sent.seed).toBe(7);
    expect(sent.provider?.data_collection).toBe('deny');
    expect('input_references' in sent).toBe(false);
  });

  it('leaves the ratio and the seed out when the node states neither', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => drew('a drawing'),
    });
    await genNodeRuntime('OpenRouterImage')?.(
      { prompt: 'a cat' },
      { model: MODEL, aspect: '', seed: '' },
      services,
    );
    const sent = sentBody(services);
    expect('aspect_ratio' in sent).toBe(false);
    expect('seed' in sent).toBe(false);
  });

  it('carries each reference as a data url, in order', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => drew('a drawing'),
    });
    const first = await services.blobs.write(png(' one'), 'png');
    const second = await services.blobs.write(png(' two'), 'png');

    await genNodeRuntime('OpenRouterImage')?.(
      {
        prompt: 'a cat',
        refs: [
          { store: 'blob', ...first },
          { store: 'blob', ...second },
        ],
      },
      props,
      services,
    );

    const refs = sentBody(services).input_references ?? [];
    expect(refs.map((r) => r.type)).toEqual(['image_url', 'image_url']);
    expect(refs[0]?.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from(png(' one')).toString('base64')}`,
    );
    expect(refs[1]?.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from(png(' two')).toString('base64')}`,
    );
  });

  it('names a placeholder rather than letting the provider refuse the bytes', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => drew('a drawing'),
    });
    const ref = await services.blobs.write(bytes('not a picture'), 'png');
    await expect(
      genNodeRuntime('OpenRouterImage')?.(
        { prompt: 'a cat', refs: [{ store: 'blob', ...ref }] },
        props,
        services,
      ),
    ).rejects.toThrow('--mock');
    expect(services.fetches).toEqual([]);
  });

  it('refuses with no key rather than sending an unauthenticated request', async () => {
    const services = mockServices({ answer: () => drew('a drawing') });
    await expect(
      genNodeRuntime('OpenRouterImage')?.({ prompt: 'a cat' }, props, services),
    ).rejects.toThrow('no openrouter key is set');
    expect(services.fetches).toEqual([]);
  });

  it('quotes what OpenRouter said when it refuses', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => ({ status: 400, body: '{"error":{"message":"aspect_ratio 7:3 unsupported"}}' }),
    });
    await expect(
      genNodeRuntime('OpenRouterImage')?.({ prompt: 'a cat' }, props, services),
    ).rejects.toThrow(
      'OpenRouter answered 400: {"error":{"message":"aspect_ratio 7:3 unsupported"}}',
    );
  });

  it('refuses a reply that carries no picture', async () => {
    const services = mockServices({
      keys  : { openrouter: 'a-key' },
      answer: () => ({ body: '{"created":1,"data":[]}' }),
    });
    await expect(
      genNodeRuntime('OpenRouterImage')?.({ prompt: 'a cat' }, props, services),
    ).rejects.toThrow(`OpenRouter returned no picture (${MODEL})`);
  });
});

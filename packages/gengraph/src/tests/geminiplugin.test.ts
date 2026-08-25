/**
 * The shipped Gemini plugin, installed and run the way an author's would be. It proves the
 * port: two node types this package does not declare, reaching the vendor through the
 * services alone.
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
const PLUGIN = join(REPO_ROOT, 'plugins', 'gemini');

const bundle = esbuildPluginBundler(esbuild);

/** What the vendor answers with, carrying one picture the way a real reply does. */
function drew(text: string, mime = 'image/png'): MockFetchReply {
  const data = Buffer.from(bytes(text)).toString('base64');
  return {
    body: JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: mime, data } }] } }],
    }),
  };
}

/** Bytes that pass the plugin's own check that a reference is a picture. */
function png(tail: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes(tail)]);
}

function base64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

let home = '';

// Activated once for the file: registration is global, and a second activation re-registers
// the same node classes with path.ux, which warns about every one of them.
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gengraph-gemini-'));
  const dir = join(userPluginsDir({ env: { VNAUTHOR_HOME: home } }), 'gemini');
  mkdirSync(dir, { recursive: true });
  cpSync(PLUGIN, dir, { recursive: true });

  const activated = await activateGenPlugin(dir, bundle);
  expect(activated).toMatchObject({ ok: true });
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('what the plugin registers', () => {
  it('declares both node types, each spending and priced at one image', () => {
    const spec = genNodeSpec('GeminiImage');
    expect(spec?.spends).toBe(true);
    expect(spec?.refineInput).toBe('refine');
    expect(spec?.estimate?.({ model: 'gemini-2.5-flash-image' }, { connected: new Set() })).toEqual(
      [{ service: 'image', model: 'gemini-2.5-flash-image', unit: 'image', count: 1 }],
    );
    expect(genNodeSpec('GeminiEditImage')?.spends).toBe(true);
  });

  it('registers a price agent, which is what a refresh looks up', () => {
    expect(genPriceAgents()).toContain('gemini');
  });
});

describe('drawing a picture', () => {
  const props = { model: 'gemini-2.5-flash-image', aspect: '16:9', seed: '7' };

  it('asks the model named on the node and stores what came back', async () => {
    const services = mockServices({ keys: { gemini: 'a-key' }, answer: () => drew('a drawing') });
    const run = genNodeRuntime('GeminiImage');

    const out = (await run?.(
      { prompt: 'a cat', refine: 'brighter' },
      props,
      services,
    )) as GenOutputs;

    expect(out['modelId']).toBe('gemini-2.5-flash-image');
    expect(out['prompt']).toBe('a cat\n\nbrighter');

    const image = out['image'] as { store: string; hash: string; ext: string };
    expect(image.store).toBe('blob');
    expect(image.ext).toBe('png');
    expect(services.blobs.stored.get(image.hash)).toEqual(bytes('a drawing'));
  });

  it('sends the key as a header and the prompt in the body, and never in the url', async () => {
    const services = mockServices({ keys: { gemini: 'a-key' }, answer: () => drew('a drawing') });
    await genNodeRuntime('GeminiImage')?.({ prompt: 'a cat' }, props, services);

    const call = services.fetches[0];
    expect(call?.url).toContain('/gemini-2.5-flash-image:generateContent');
    expect(call?.url).not.toContain('a-key');
    expect(call?.init.headers?.['x-goog-api-key']).toBe('a-key');

    const sent = JSON.parse(String(call?.init.body)) as {
      contents: { parts: { text?: string }[] }[];
      generationConfig: { seed?: number; imageConfig?: { aspectRatio?: string } };
    };
    expect(sent.contents[0]?.parts.at(-1)?.text).toBe('a cat');
    expect(sent.generationConfig.seed).toBe(7);
    expect(sent.generationConfig.imageConfig?.aspectRatio).toBe('16:9');
  });

  it('refuses with no key rather than sending an unauthenticated request', async () => {
    const services = mockServices({ answer: () => drew('a drawing') });
    await expect(
      genNodeRuntime('GeminiImage')?.({ prompt: 'a cat' }, props, services),
    ).rejects.toThrow('no gemini key is set');
    expect(services.fetches).toEqual([]);
  });

  it('quotes what the vendor said when it refuses', async () => {
    const services = mockServices({
      keys: { gemini: 'a-key' },
      answer: () => ({ status: 400, body: '{"error":{"message":"bad part 3"}}' }),
    });
    await expect(
      genNodeRuntime('GeminiImage')?.({ prompt: 'a cat' }, props, services),
    ).rejects.toThrow('bad part 3');
  });
});

describe('redrawing a picture', () => {
  it('sends the base picture first, ahead of the references', async () => {
    const services = mockServices({ keys: { gemini: 'a-key' }, answer: () => drew('redrawn') });
    const base = await services.blobs.write(png(' the base'), 'png');
    const ref = await services.blobs.write(png(' a reference'), 'png');

    await genNodeRuntime('GeminiEditImage')?.(
      {
        base: { store: 'blob', ...base },
        prompt: 'make it night',
        refs: [{ store: 'blob', ...ref }],
      },
      { model: 'gemini-2.5-flash-image', aspect: '', seed: '' },
      services,
    );

    const sent = JSON.parse(String(services.fetches[0]?.init.body)) as {
      contents: { parts: { inlineData?: { data: string } }[] }[];
    };
    const parts = sent.contents[0]?.parts ?? [];
    expect(parts[0]?.inlineData?.data).toBe(base64(png(' the base')));
    expect(parts[1]?.inlineData?.data).toBe(base64(png(' a reference')));
  });

  it('names a placeholder rather than letting the vendor refuse the bytes', async () => {
    const services = mockServices({ keys: { gemini: 'a-key' }, answer: () => drew('redrawn') });
    const base = await services.blobs.write(bytes('not a picture'), 'png');

    await expect(
      genNodeRuntime('GeminiEditImage')?.(
        { base: { store: 'blob', ...base }, prompt: 'make it night' },
        { model: 'gemini-2.5-flash-image', aspect: '', seed: '' },
        services,
      ),
    ).rejects.toThrow('--mock');
  });
});

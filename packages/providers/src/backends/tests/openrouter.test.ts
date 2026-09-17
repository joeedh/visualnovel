/**
 * The OpenRouter image backend against a fake endpoint: what the request carries, how each
 * shape of answer is read, and which failures the retry policy and the fault classifier see.
 */
import { ProviderError, RetryableProviderError } from '@vn/util';
import { capturedRequest, capturedRequests, clearCaptures } from '../capture.js';
import { faultKind } from '../transient.js';
import { createOpenRouterImage, OPENROUTER_IMAGES_URL, OpenRouterError } from '../openrouter.js';
import { placeholderPng } from '../../placeholder.js';

const MODEL = 'openai/gpt-image-2';

/** Bytes that pass the reference guard. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

interface SentBody {
  model: string;
  prompt: string;
  aspect_ratio?: string;
  seed?: number;
  input_references?: { type: string; image_url: { url: string } }[];
  provider?: { data_collection?: string };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: SentBody;
}

/** What OpenRouter answers with, carrying one picture the way a real reply does. */
function drew(text: string, mime = 'image/png'): Response {
  const b64_json = Buffer.from(text).toString('base64');
  return new Response(JSON.stringify({ created: 1, data: [{ b64_json, media_type: mime }] }), {
    status: 200,
  });
}

/** A fake endpoint replaying `answers` in order, the last one repeating, and keeping what it was sent. */
function endpoint(answers: (() => Response)[]): {
  fetchImpl: typeof fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body   : JSON.parse(String(init.body)) as SentBody,
    });
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)]!;
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function backend(answers: (() => Response)[]) {
  const fake = endpoint(answers);
  return { ...fake, image: createOpenRouterImage('a-key', MODEL, { fetchImpl: fake.fetchImpl }) };
}

beforeEach(() => clearCaptures());

describe('what the request carries', () => {
  it('posts the model, the prompt, a deny on data collection and the bearer key', async () => {
    const { image, sent } = backend([() => drew('a drawing')]);

    const result = await image.generate('a cat', [], { modelId: MODEL });

    expect(result.modelId).toBe(MODEL);
    expect(result.ext).toBe('png');
    expect(Buffer.from(result.bytes).toString()).toBe('a drawing');
    expect(sent[0]?.url).toBe(OPENROUTER_IMAGES_URL);
    expect(sent[0]?.headers['authorization']).toBe('Bearer a-key');
    expect(sent[0]?.body.model).toBe(MODEL);
    expect(sent[0]?.body.prompt).toBe('a cat');
    expect(sent[0]?.body.provider?.data_collection).toBe('deny');
    expect('aspect_ratio' in sent[0]!.body).toBe(false);
    expect('seed' in sent[0]!.body).toBe(false);
    expect('input_references' in sent[0]!.body).toBe(false);
  });

  it('sends the ratio and the seed only when set', async () => {
    const { image, sent } = backend([() => drew('a drawing')]);

    await image.generate('a cat', [], { modelId: MODEL, aspect: '3:4', seed: 7 });

    expect(sent[0]?.body.aspect_ratio).toBe('3:4');
    expect(sent[0]?.body.seed).toBe(7);
  });

  it('refuses a seed by name for a model the catalog says takes none, before any request', async () => {
    const fake = endpoint([() => drew('a drawing')]);
    const image = createOpenRouterImage('a-key', MODEL, { fetchImpl: fake.fetchImpl, seed: false });

    await expect(image.generate('a cat', [], { modelId: MODEL, seed: 7 })).rejects.toThrow(
      `${MODEL} takes no seed`,
    );
    expect(fake.sent).toHaveLength(0);

    await image.generate('a cat', [], { modelId: MODEL });
    expect(fake.sent).toHaveLength(1);
  });

  it('carries each reference as a data url, the edit base first', async () => {
    const { image, sent } = backend([() => drew('a drawing')]);
    const base = { bytes: new Uint8Array([...PNG, 9]), ext: 'png' };
    const ref = { bytes: new Uint8Array([...JPEG, 8]), ext: 'jpg' };

    await image.edit(base, 'a cat', [ref], { modelId: MODEL });

    const refs = sent[0]?.body.input_references ?? [];
    expect(refs.map((r) => r.type)).toEqual(['image_url', 'image_url']);
    expect(refs[0]?.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from(base.bytes).toString('base64')}`,
    );
    expect(refs[1]?.image_url.url).toBe(
      `data:image/jpeg;base64,${Buffer.from(ref.bytes).toString('base64')}`,
    );
  });

  it('names a jpeg by its short extension', async () => {
    const { image } = backend([() => drew('a photo', 'image/jpeg')]);
    expect((await image.generate('a cat', [], { modelId: MODEL })).ext).toBe('jpg');
  });

  it('refuses a placeholder before any request goes out', async () => {
    const { image, sent } = backend([() => drew('a drawing')]);
    const mockRef = { bytes: placeholderPng('deadbeefcafe0123'), ext: 'png' };

    await expect(image.generate('a cat', [mockRef], { modelId: MODEL })).rejects.toThrow(
      /--mock placeholder/,
    );
    expect(sent).toEqual([]);
  });
});

describe('the captured request', () => {
  it('keeps the body with the references replaced by a count and a size', async () => {
    const { image } = backend([() => drew('a drawing')]);
    const ref = { bytes: new Uint8Array([...PNG, 8]), ext: 'png' };

    await image.generate('a cat', [ref, ref], { modelId: MODEL });

    const header = capturedRequests().find((h) => h.label === 'openrouter-image');
    expect(header).toBeDefined();
    const body = JSON.parse(capturedRequest(header!.seq) ?? '{}') as Record<string, unknown>;
    expect(body['prompt']).toBe('a cat');
    expect(String(body['input_references'])).toMatch(/^2 references, \d+ bytes$/);
    expect(JSON.stringify(body)).not.toContain('base64,');
    expect(JSON.stringify(body)).not.toContain('a-key');
  });
});

describe('how a refusal is shaped', () => {
  it('quotes a 400 to the cap, with the code first, and classes it a request fault', async () => {
    const long = 'x'.repeat(1000);
    const { image, sent } = backend([() => new Response(long, { status: 400 })]);

    const err = await image.generate('a cat', [], { modelId: MODEL }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err).not.toBeInstanceOf(RetryableProviderError);
    expect((err as OpenRouterError).status).toBe(400);
    expect((err as Error).message).toBe(`400 OpenRouter: ${'x'.repeat(400)}`);
    expect(faultKind(err)).toBe('request');
    expect(sent).toHaveLength(1);
  });

  it('classes a 401 as an auth fault', async () => {
    const { image } = backend([() => new Response('{"error":"bad key"}', { status: 401 })]);
    const err = await image.generate('a cat', [], { modelId: MODEL }).catch((e: unknown) => e);
    expect(faultKind(err)).toBe('auth');
    expect((err as Error).message).not.toContain('a-key');
  });

  it('retries a 429 through the retry policy, honouring retry-after', async () => {
    const limited = () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    const { image, sent } = backend([limited, () => drew('a drawing')]);

    const result = await image.generate('a cat', [], { modelId: MODEL });

    expect(Buffer.from(result.bytes).toString()).toBe('a drawing');
    expect(sent).toHaveLength(2);
  });

  it('gives up on a 5xx that does not lift, and says it was transient', async () => {
    const { image, sent } = backend([
      () => new Response('down', { status: 503, headers: { 'retry-after': '0' } }),
    ]);

    const err = await image.generate('a cat', [], { modelId: MODEL }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableProviderError);
    expect((err as Error).message).toContain('503 OpenRouter: down');
    expect(faultKind(err)).toBe('transient');
    expect(sent).toHaveLength(3);
  });

  it('refuses a reply that is not JSON, once', async () => {
    const { image, sent } = backend([() => new Response('<html>', { status: 200 })]);
    const err = await image.generate('a cat', [], { modelId: MODEL }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(RetryableProviderError);
    expect((err as Error).message).toContain('not JSON: <html>');
    expect(sent).toHaveLength(1);
  });

  it('refuses a reply that carries no picture, once', async () => {
    const { image, sent } = backend([
      () => new Response('{"created":1,"data":[]}', { status: 200 }),
    ]);
    await expect(image.generate('a cat', [], { modelId: MODEL })).rejects.toThrow(
      `OpenRouter returned no picture (${MODEL})`,
    );
    expect(sent).toHaveLength(1);
  });
});

/**
 * The OpenRouter model listing against a fake endpoint: which fields become a catalog entry, how a
 * price is read off the endpoints record, and what a failure at each of the two reads does.
 */
import {
  listOpenRouterImageModels,
  OPENROUTER_MODELS_URL,
  perImagePrice,
} from '../openrouterlist.js';

type Answer = () => Response;

/** A fake endpoint answering by URL, with `answers` keyed by the path after the listing URL. */
function endpoint(answers: Record<string, Answer>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((url: string) => {
    urls.push(url);
    const key = url === OPENROUTER_MODELS_URL ? '' : url.slice(OPENROUTER_MODELS_URL.length);
    const answer = answers[key] ?? (() => new Response('not found', { status: 404 }));
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const json =
  (body: unknown): Answer =>
  () =>
    new Response(JSON.stringify(body), { status: 200 });

const LISTING = {
  data: [
    {
      id                  : 'openai/gpt-image-2',
      name                : 'OpenAI: GPT Image 2',
      supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] } },
    },
    {
      id                  : 'bytedance-seed/seedream-4.5',
      name                : 'ByteDance: Seedream 4.5',
      supported_parameters: { aspect_ratio: { values: ['1:1'] }, seed: { type: 'integer' } },
    },
    { id: 'krea/krea-2-large' },
  ],
};

const perToken = {
  endpoints: [{ pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }] }],
};

const perImage = {
  endpoints: [
    {
      pricing: [
        { billable: 'input_image', unit: 'image', cost_usd: 0 },
        { billable: 'output_image', unit: 'image', cost_usd: 0.04 },
        { billable: 'output_image', unit: 'image', cost_usd: 0.09, variant: 'high_resolution' },
      ],
    },
  ],
};

describe('perImagePrice', () => {
  it('reads the base output_image row billed per image', () => {
    expect(perImagePrice(perImage)).toBe(0.04);
  });

  it('takes the cheapest tier where every row names a variant', () => {
    expect(
      perImagePrice({
        endpoints: [
          {
            pricing: [
              { billable: 'output_image', unit: 'image', cost_usd: 0.06, variant: 'low_2k' },
              { billable: 'output_image', unit: 'image', cost_usd: 0.04, variant: 'low_1k' },
            ],
          },
        ],
      }),
    ).toBe(0.04);
  });

  it('answers nothing for a model billed per token or per megapixel, or with no pricing', () => {
    expect(perImagePrice(perToken)).toBeUndefined();
    expect(
      perImagePrice({
        endpoints: [{ pricing: [{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.03 }] }],
      }),
    ).toBeUndefined();
    expect(perImagePrice({ endpoints: [{}] })).toBeUndefined();
    expect(perImagePrice({ endpoints: [] })).toBeUndefined();
    expect(perImagePrice('nonsense')).toBeUndefined();
  });
});

describe('listOpenRouterImageModels', () => {
  it('reads the listing and each endpoints record into catalog entries', async () => {
    const fake = endpoint({
      ''                                      : json(LISTING),
      '/openai/gpt-image-2/endpoints'         : json(perToken),
      '/bytedance-seed/seedream-4.5/endpoints': json(perImage),
      '/krea/krea-2-large/endpoints'          : json({ endpoints: [{ pricing: [] }] }),
    });

    const listed = await listOpenRouterImageModels(fake.fetchImpl);

    expect(listed.unpriced).toEqual([]);
    expect(listed.models).toEqual([
      {
        id     : 'openai/gpt-image-2',
        name   : 'OpenAI: GPT Image 2',
        aspects: ['1:1', '16:9'],
        seed   : false,
      },
      {
        id      : 'bytedance-seed/seedream-4.5',
        name    : 'ByteDance: Seedream 4.5',
        aspects : ['1:1'],
        seed    : true,
        priceUsd: 0.04,
      },
      { id: 'krea/krea-2-large', name: 'krea/krea-2-large', aspects: [], seed: false },
    ]);
    expect(fake.urls[0]).toBe(OPENROUTER_MODELS_URL);
    expect(fake.urls).toHaveLength(4);
  });

  it('lists a model whose endpoints call failed, unpriced and by name', async () => {
    const fake = endpoint({
      ''                                      : json(LISTING),
      '/openai/gpt-image-2/endpoints'         : () => new Response('gone', { status: 500 }),
      '/bytedance-seed/seedream-4.5/endpoints': () => new Response('<html>', { status: 200 }),
      '/krea/krea-2-large/endpoints'          : json({ endpoints: [] }),
    });

    const listed = await listOpenRouterImageModels(fake.fetchImpl);

    expect(listed.unpriced).toEqual(['openai/gpt-image-2', 'bytedance-seed/seedream-4.5']);
    expect(listed.models.map((m) => m.priceUsd)).toEqual([undefined, undefined, undefined]);
    expect(listed.models.map((m) => m.seed)).toEqual([false, true, false]);
  });

  it('throws on a listing that fails or does not read, so nothing is written from it', async () => {
    await expect(
      listOpenRouterImageModels(
        endpoint({ '': () => new Response('busy', { status: 503 }) }).fetchImpl,
      ),
    ).rejects.toThrow('503 OpenRouter: busy');
    await expect(
      listOpenRouterImageModels(
        endpoint({ '': () => new Response('<html>', { status: 200 }) }).fetchImpl,
      ),
    ).rejects.toThrow('not JSON');
    await expect(
      listOpenRouterImageModels(endpoint({ '': json({ data: [{ name: 'no id' }] }) }).fetchImpl),
    ).rejects.toThrow('did not read');
  });
});

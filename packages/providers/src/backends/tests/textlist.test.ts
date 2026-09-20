/**
 * The text-model listings against fake endpoints: which rows become an entry, which are filtered
 * out, where the key rides, and how a vendor that is skipped or down is reported.
 */
import {
  ANTHROPIC_MODELS_URL,
  GEMINI_MODELS_URL,
  OPENROUTER_TEXT_MODELS_URL,
  listAnthropicTextModels,
  listGeminiTextModels,
  listOpenRouterTextModels,
  listTextModels,
} from '../textlist.js';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake endpoint answering by URL prefix, keeping every call it was sent. */
function endpoint(answers: Record<string, () => Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    const answer = key ? answers[key]! : () => new Response('not found', { status: 404 });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

const ANTHROPIC = {
  data: [
    { id: 'claude-opus-4-8-20260101', display_name: 'Claude Opus 4.8', type: 'model' },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', type: 'model' },
  ],
  has_more: false,
};

const GEMINI = {
  models: [
    {
      name                      : 'models/gemini-2.5-pro',
      displayName               : 'Gemini 2.5 Pro',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name                      : 'models/gemini-2.5-flash-image',
      displayName               : 'Gemini 2.5 Flash Image',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name                      : 'models/embedding-001',
      displayName               : 'Embedding 001',
      supportedGenerationMethods: ['embedContent'],
    },
  ],
};

const OPENROUTER = {
  data: [
    {
      id          : 'anthropic/claude-opus-4.8',
      name        : 'Anthropic: Claude Opus 4.8',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
    {
      id          : 'openai/gpt-image-2',
      name        : 'OpenAI: GPT Image 2',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
    },
    { id: 'meta/llama-4', name: 'Meta: Llama 4' },
  ],
};

describe('listAnthropicTextModels', () => {
  it('sends the key in the header and reads each row into an entry', async () => {
    const fake = endpoint({ [ANTHROPIC_MODELS_URL]: json(ANTHROPIC) });
    const models = await listAnthropicTextModels('sk-test', fake.fetchImpl);
    expect(models).toEqual([
      { id: 'claude-opus-4-8-20260101', name: 'Claude Opus 4.8', vendor: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', vendor: 'anthropic' },
    ]);
    expect(fake.calls[0]?.headers['x-api-key']).toBe('sk-test');
    expect(fake.calls[0]?.url).not.toContain('sk-test');
  });

  it('refuses with the status and no key when the vendor refuses', async () => {
    const fake = endpoint({
      [ANTHROPIC_MODELS_URL]: () => new Response('{"error":"bad key"}', { status: 401 }),
    });
    await expect(listAnthropicTextModels('sk-test', fake.fetchImpl)).rejects.toThrow(
      '401 Anthropic',
    );
  });
});

describe('listGeminiTextModels', () => {
  it('keeps generateContent models that are not image or embedding models, without the prefix', async () => {
    const fake = endpoint({ [GEMINI_MODELS_URL]: json(GEMINI) });
    const models = await listGeminiTextModels('g-key', fake.fetchImpl);
    expect(models).toEqual([{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', vendor: 'gemini' }]);
    expect(fake.calls[0]?.headers['x-goog-api-key']).toBe('g-key');
  });
});

describe('listOpenRouterTextModels', () => {
  it('keeps the models that answer with text and drops the image ones', async () => {
    const fake = endpoint({ [OPENROUTER_TEXT_MODELS_URL]: json(OPENROUTER) });
    const models = await listOpenRouterTextModels(fake.fetchImpl);
    expect(models.map((m) => m.id)).toEqual(['anthropic/claude-opus-4.8', 'meta/llama-4']);
    expect(models[0]?.vendor).toBe('openrouter');
  });
});

describe('listTextModels', () => {
  it('skips a vendor with no key, names one that failed, and keeps the rest', async () => {
    const fake = endpoint({
      [ANTHROPIC_MODELS_URL]      : () => new Response('down', { status: 500 }),
      [OPENROUTER_TEXT_MODELS_URL]: json(OPENROUTER),
    });
    const listing = await listTextModels({ anthropic: 'sk-test' }, fake.fetchImpl);
    expect(listing.skipped).toEqual(['gemini']);
    expect(listing.failed.map((f) => f.vendor)).toEqual(['anthropic']);
    expect(listing.failed[0]?.reason).toContain('500 Anthropic');
    expect(listing.models.map((m) => m.id)).toEqual(['anthropic/claude-opus-4.8', 'meta/llama-4']);
  });
});

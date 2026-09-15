/**
 * The image router: which backend each call reaches, decided by the model id on its params, and
 * the vendor set a run is required to hold keys for.
 */
import { projectConfig } from '@vn/types';
import type { ResolvedKeys } from '@vn/config';
import { ConfigError, ProviderError } from '@vn/util';
import type { ImageBackend, ImageInput } from '../backend.js';
import { createImageBackend, requiredVendors } from '../factory.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** A backend that records what it was asked and answers with its own id. */
function stub(modelId: string, seen: string[]): ImageBackend {
  const draw = async (
    prompt: string,
    _refs: ImageInput[],
    params: { modelId: string },
  ): Promise<{ bytes: Uint8Array; ext: string; modelId: string }> => {
    seen.push(`${modelId}:${params.modelId}:${prompt}`);
    return { bytes: PNG, ext: 'png', modelId };
  };
  return {
    modelId,
    generate: draw,
    edit    : (base, prompt, refs, params) => draw(prompt, [base, ...refs], params),
  };
}

const config = projectConfig.parse({
  title : 'T',
  models: { image: 'gemini-2.5-flash-image' },
});

function router(keys: Partial<ResolvedKeys>) {
  const seen: string[] = [];
  const built: string[] = [];
  const backend = createImageBackend(
    config,
    { gemini: '', anthropic: '', openrouter: '', ...keys },
    {
      build: (vendor, apiKey, modelId) => {
        built.push(`${vendor}:${apiKey}:${modelId}`);
        return stub(modelId, seen);
      },
    },
  );
  return { backend, seen, built };
}

const keys = { gemini: 'g-key', openrouter: 'or-key' };

describe('createImageBackend', () => {
  it('names the project’s model and routes each call by the model on its params', async () => {
    const { backend, seen, built } = router(keys);

    expect(backend.modelId).toBe('gemini-2.5-flash-image');
    const direct = await backend.generate('a', [], { modelId: 'gemini-2.5-flash-image' });
    const routed = await backend.edit({ bytes: PNG, ext: 'png' }, 'b', [], {
      modelId: 'openai/gpt-image-2',
    });

    expect(direct.modelId).toBe('gemini-2.5-flash-image');
    expect(routed.modelId).toBe('openai/gpt-image-2');
    expect(built).toEqual([
      'gemini:g-key:gemini-2.5-flash-image',
      'openrouter:or-key:openai/gpt-image-2',
    ]);
    expect(seen).toEqual([
      'gemini-2.5-flash-image:gemini-2.5-flash-image:a',
      'openai/gpt-image-2:openai/gpt-image-2:b',
    ]);
  });

  it('builds a backend once per model and keeps it', async () => {
    const { backend, built } = router(keys);

    await backend.generate('a', [], { modelId: 'openai/gpt-image-2' });
    await backend.generate('b', [], { modelId: 'openai/gpt-image-2' });
    await backend.generate('c', [], { modelId: 'google/gemini-2.5-flash-image' });

    expect(built).toEqual([
      'openrouter:or-key:openai/gpt-image-2',
      'openrouter:or-key:google/gemini-2.5-flash-image',
    ]);
  });

  it('refuses an empty model id by name rather than guessing', async () => {
    const { backend, built } = router(keys);

    const err = await backend.generate('a', [], { modelId: '' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain('named no model');
    expect(built).toEqual([]);
  });

  it('refuses a vendor with no key in resolveKeys’s own words, and never a value', async () => {
    const { backend, built } = router({ gemini: 'g-key' });

    const err = await backend
      .generate('a', [], { modelId: 'openai/gpt-image-2' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'missing openrouter API key: set $OPENROUTER_API_KEY or place openrouter.txt in a keys/ dir',
    );
    expect(built).toEqual([]);
  });

  // The default builder is the one the hosts use, so the catalog's seed flag is checked through it
  // with a fetch that must never be reached: the refusal comes ahead of the request.
  it('reads the catalog’s seed flag into the OpenRouter backend it builds', async () => {
    const backend = createImageBackend(
      config,
      { gemini: '', anthropic: '', openrouter: 'or-key' },
      { catalog: [{ id: 'openai/gpt-image-2', seed: false }] },
    );

    await expect(
      backend.generate('a', [], { modelId: 'openai/gpt-image-2', seed: 4 }),
    ).rejects.toThrow('openai/gpt-image-2 takes no seed');
  });
});

describe('requiredVendors', () => {
  it('is the union over the image model, the reviewers and the text model', () => {
    const mixed = projectConfig.parse({
      title : 'T',
      models: {
        image : 'openai/gpt-image-2',
        vision: ['gemini-2.5-flash', 'claude-opus-4-8'],
        text  : 'claude-opus-4-8',
      },
    });
    expect(requiredVendors(mixed)).toEqual(['openrouter', 'gemini', 'anthropic']);
  });

  it('asks for no gemini key from a project that never calls Gemini', () => {
    const noGemini = projectConfig.parse({
      title : 'T',
      models: { image: 'openai/gpt-image-2', vision: ['claude-opus-4-8'], text: 'claude-opus-4-8' },
    });
    expect(requiredVendors(noGemini)).toEqual(['openrouter', 'anthropic']);
    expect(requiredVendors(config)).toEqual(['gemini', 'anthropic']);
  });
});

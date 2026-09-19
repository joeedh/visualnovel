/**
 * The image router: which backend each call reaches, decided by the model id on its params, and
 * the route every configured model takes before a run starts.
 */
import { projectConfig } from '@vn/types';
import type { ResolvedKeys } from '@vn/config';
import { ConfigError, ProviderError } from '@vn/util';
import type { ImageBackend, ImageInput } from '../backend.js';
import { requestKey } from '../cache.js';
import { createImageBackend, createProviders, projectModels, resolveRoutes } from '../factory.js';

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
      build: (route, apiKey) => {
        built.push(`${route.transport}:${apiKey}:${route.wireId}`);
        return stub(route.wireId, seen);
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

  it('refuses a model no key can carry in the pre-run check’s own words, and never a value', async () => {
    const { backend, built } = router({ gemini: 'g-key' });

    const err = await backend
      .generate('a', [], { modelId: 'openai/gpt-image-2' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'missing openrouter API key for openai/gpt-image-2: set $OPENROUTER_API_KEY or place openrouter.txt in a keys/ dir',
    );
    expect(built).toEqual([]);

    const bare = router({ anthropic: 'a-key' });
    const gemini = await bare.backend
      .generate('a', [], { modelId: 'gemini-2.5-flash-image' })
      .catch((e: unknown) => e);
    expect((gemini as Error).message).toBe(
      'missing gemini API key for gemini-2.5-flash-image: set $GEMINI_API_KEY or place gemini.txt in a keys/ dir, or set $OPENROUTER_API_KEY to route it through OpenRouter',
    );
  });

  it('draws a Gemini id through OpenRouter on that key alone, under the author’s spelling', async () => {
    const { backend, seen, built } = router({ openrouter: 'or-key' });

    const result = await backend.generate('a', [], { modelId: 'gemini-2.5-flash-image' });

    expect(built).toEqual(['openrouter:or-key:google/gemini-2.5-flash-image']);
    expect(seen).toEqual(['google/gemini-2.5-flash-image:gemini-2.5-flash-image:a']);
    // The stub answered with the wire id; the router puts the author's spelling back
    expect(result.modelId).toBe('gemini-2.5-flash-image');
    expect(result.transport).toBe('openrouter');
  });

  it('stamps the transport on a native draw too, and prefers the native key', async () => {
    const { backend, built } = router(keys);
    const result = await backend.generate('a', [], { modelId: 'gemini-2.5-flash-image' });
    expect(built).toEqual(['gemini:g-key:gemini-2.5-flash-image']);
    expect(result.transport).toBe('gemini');
  });

  it('keys the dedupe request identically whichever transport draws', () => {
    const params = { modelId: 'gemini-2.5-flash-image', aspect: '16:9' };
    expect(requestKey('generate', 'a cat', [], params)).toBe(
      requestKey('generate', 'a cat', [], { ...params }),
    );
    // The key reads `params.modelId`, which the router never rewrites; a route is not an input
    expect(requestKey('generate', 'a cat', [], params)).not.toBe(
      requestKey('generate', 'a cat', [], { ...params, modelId: 'google/gemini-2.5-flash-image' }),
    );
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

describe('resolveRoutes', () => {
  const mixed = projectConfig.parse({
    title : 'T',
    models: {
      image : 'gemini-2.5-flash-image',
      vision: ['gemini-2.5-flash', 'claude-opus-4-8'],
      text  : 'claude-opus-4-8',
    },
  });

  it('routes the default project end to end on an OpenRouter key alone', () => {
    const routes = resolveRoutes(
      mixed,
      { gemini: '', anthropic: '', openrouter: 'or-key' },
      projectModels(mixed),
    );
    expect([...routes.keys()]).toEqual([
      'gemini-2.5-flash',
      'claude-opus-4-8',
      'gemini-2.5-flash-image',
    ]);
    expect(routes.get('claude-opus-4-8')).toEqual({
      modelId  : 'claude-opus-4-8',
      native   : 'anthropic',
      transport: 'openrouter',
      wireId   : 'anthropic/claude-opus-4.8',
    });
    expect(routes.get('gemini-2.5-flash-image')?.wireId).toBe('google/gemini-2.5-flash-image');
  });

  it('moves each vendor back onto its own key independently', () => {
    const routes = resolveRoutes(
      mixed,
      { gemini: '', anthropic: 'a-key', openrouter: 'or-key' },
      projectModels(mixed),
    );
    expect(routes.get('claude-opus-4-8')?.transport).toBe('anthropic');
    expect(routes.get('gemini-2.5-flash')?.transport).toBe('openrouter');
    expect(routes.get('gemini-2.5-flash-image')?.transport).toBe('openrouter');
  });

  it('refuses the first id no key can carry, naming both ways out', () => {
    const err = (() => {
      try {
        resolveRoutes(
          mixed,
          { gemini: 'g-key', anthropic: '', openrouter: '' },
          projectModels(mixed),
        );
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'missing anthropic API key for claude-opus-4-8: set $ANTHROPIC_API_KEY or place claude.txt in a keys/ dir, or set $OPENROUTER_API_KEY to route it through OpenRouter',
    );
  });

  it('names the OpenRouter key alone for an id the author spelled for it', () => {
    expect(() =>
      resolveRoutes(
        mixed,
        { gemini: 'g-key', anthropic: 'a-key', openrouter: '' },
        { image: ['openai/gpt-image-2'] },
      ),
    ).toThrow(
      'missing openrouter API key for openai/gpt-image-2: set $OPENROUTER_API_KEY or place openrouter.txt in a keys/ dir',
    );
  });
});

describe('createProviders', () => {
  const loadRef = async () => ({ bytes: PNG, ext: 'png' });
  const mixed = projectConfig.parse({
    title : 'T',
    models: {
      image : 'gemini-2.5-flash-image',
      vision: ['gemini-2.5-flash', 'claude-opus-4-8'],
      text  : 'claude-opus-4-8',
    },
  });

  it('labels a reviewer by its native vendor whatever key carries it', () => {
    const viaOpenRouter = createProviders({
      config: mixed,
      keys  : { gemini: '', anthropic: '', openrouter: 'or-key' },
      loadRef,
    });
    expect(viaOpenRouter.reviewers.map((r) => r.id)).toEqual(['gemini', 'claude']);
  });

  it('builds a bundle for a model nothing carries, and refuses at the first call in the pre-run words', async () => {
    const providers = createProviders({
      config: mixed,
      keys  : { gemini: '', anthropic: 'a-key', openrouter: '' },
      loadRef,
    });
    expect(providers.reviewers.map((r) => r.id)).toEqual(['gemini', 'claude']);
    await expect(
      providers.reviewers[0]!.review(
        { hash: 'h', ext: 'png' },
        { description: 'x', characters: [], location: 'y' },
        [],
      ),
    ).rejects.toThrow(
      'missing gemini API key for gemini-2.5-flash: set $GEMINI_API_KEY or place gemini.txt in a keys/ dir, or set $OPENROUTER_API_KEY to route it through OpenRouter',
    );
  });
});

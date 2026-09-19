/**
 * The route rule: which key carries a model id, and the OpenRouter spelling of a native id.
 */
import {
  TEXT_MODELS,
  chatRouteFor,
  imageRouteFor,
  nativeIdFor,
  openRouterIdFor,
  projectConfig,
  type KeysPresent,
} from '../index.js';

const DEFAULT_IMAGE = projectConfig.parse({ title: 'T' }).models.image;

const none: KeysPresent = { anthropic: false, gemini: false, openrouter: false };
const all: KeysPresent = { anthropic: true, gemini: true, openrouter: true };
const onlyOpenRouter: KeysPresent = { ...none, openrouter: true };

describe('openRouterIdFor', () => {
  it('spells each curated model the way OpenRouter lists it', () => {
    expect(openRouterIdFor('claude-opus-4-8')).toBe('anthropic/claude-opus-4.8');
    expect(openRouterIdFor('claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4.6');
    expect(openRouterIdFor('claude-haiku-4-5')).toBe('anthropic/claude-haiku-4.5');
    expect(openRouterIdFor('claude-fable-5')).toBe('anthropic/claude-fable-5');
    expect(openRouterIdFor('claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(openRouterIdFor('gemini-2.5-flash')).toBe('google/gemini-2.5-flash');
    expect(openRouterIdFor('gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(openRouterIdFor('gemini-2.5-flash-image')).toBe('google/gemini-2.5-flash-image');
  });

  it('returns an OpenRouter id as is and strips the @google/genai long form', () => {
    expect(openRouterIdFor('anthropic/claude-opus-4.8')).toBe('anthropic/claude-opus-4.8');
    expect(openRouterIdFor('openai/gpt-image-2')).toBe('openai/gpt-image-2');
    expect(openRouterIdFor('models/gemini-2.5-flash-image')).toBe('google/gemini-2.5-flash-image');
  });

  it('leaves a dated Anthropic id unrewritten', () => {
    expect(openRouterIdFor('claude-opus-4-8-20260101')).toBe('anthropic/claude-opus-4-8-20260101');
  });

  it('cannot spell an id under no known vendor', () => {
    expect(openRouterIdFor('some-local-model')).toBeUndefined();
    expect(openRouterIdFor('')).toBeUndefined();
  });
});

describe('nativeIdFor', () => {
  it('is the inverse of openRouterIdFor over every curated model and the default image', () => {
    for (const id of [...TEXT_MODELS, DEFAULT_IMAGE, 'claude-opus-5']) {
      const wire = openRouterIdFor(id);
      expect(wire).toBeDefined();
      expect(nativeIdFor(wire!)).toBe(id);
    }
  });

  it('leaves an id under an unknown prefix unchanged', () => {
    expect(nativeIdFor('openai/gpt-5')).toBe('openai/gpt-5');
    expect(nativeIdFor('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('chatRouteFor', () => {
  it('prefers the native key when it resolves', () => {
    expect(chatRouteFor('claude-opus-4-8', all)).toEqual({
      modelId  : 'claude-opus-4-8',
      native   : 'anthropic',
      transport: 'anthropic',
      wireId   : 'claude-opus-4-8',
    });
    expect(chatRouteFor('gemini-2.5-flash', all)).toEqual({
      modelId  : 'gemini-2.5-flash',
      native   : 'gemini',
      transport: 'gemini',
      wireId   : 'gemini-2.5-flash',
    });
  });

  it('falls back to OpenRouter under its spelling when only that key resolves', () => {
    expect(chatRouteFor('claude-opus-4-8', onlyOpenRouter)).toEqual({
      modelId  : 'claude-opus-4-8',
      native   : 'anthropic',
      transport: 'openrouter',
      wireId   : 'anthropic/claude-opus-4.8',
    });
    expect(chatRouteFor('gemini-2.5-flash', onlyOpenRouter)?.wireId).toBe(
      'google/gemini-2.5-flash',
    );
  });

  it('is per vendor: an Anthropic key does not carry a Gemini id', () => {
    const route = chatRouteFor('gemini-2.5-flash', { ...none, anthropic: true });
    expect(route).toBeUndefined();
  });

  it('routes an id with a slash through OpenRouter whatever else resolves', () => {
    expect(chatRouteFor('anthropic/claude-opus-4.8', all)).toEqual({
      modelId  : 'anthropic/claude-opus-4.8',
      native   : 'anthropic',
      transport: 'openrouter',
      wireId   : 'anthropic/claude-opus-4.8',
    });
    expect(chatRouteFor('google/gemini-2.5-pro', all)?.native).toBe('gemini');
    expect(chatRouteFor('openai/gpt-5', all)?.native).toBeUndefined();
    expect(
      chatRouteFor('anthropic/claude-opus-4.8', { ...all, openrouter: false }),
    ).toBeUndefined();
  });

  it('answers nothing when no key resolves, or when the id cannot be spelled', () => {
    expect(chatRouteFor('claude-opus-4-8', none)).toBeUndefined();
    expect(chatRouteFor('some-local-model', onlyOpenRouter)).toBeUndefined();
  });
});

describe('imageRouteFor', () => {
  it('draws a Gemini id natively, or through OpenRouter when only that key resolves', () => {
    expect(imageRouteFor(DEFAULT_IMAGE, all)?.transport).toBe('gemini');
    expect(imageRouteFor(DEFAULT_IMAGE, onlyOpenRouter)).toEqual({
      modelId  : DEFAULT_IMAGE,
      native   : 'gemini',
      transport: 'openrouter',
      wireId   : 'google/gemini-2.5-flash-image',
    });
    expect(imageRouteFor('models/gemini-2.5-flash-image', onlyOpenRouter)?.wireId).toBe(
      'google/gemini-2.5-flash-image',
    );
  });

  it('routes an OpenRouter id as spelled, and refuses it without the key', () => {
    expect(imageRouteFor('openai/gpt-image-2', all)).toEqual({
      modelId  : 'openai/gpt-image-2',
      native   : undefined,
      transport: 'openrouter',
      wireId   : 'openai/gpt-image-2',
    });
    expect(imageRouteFor('openai/gpt-image-2', { ...all, openrouter: false })).toBeUndefined();
  });
});

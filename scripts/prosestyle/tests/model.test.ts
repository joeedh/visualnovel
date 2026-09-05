import { baseUrlFor, parseModelRef } from '../model.js';

describe('parseModelRef', () => {
  it('splits on the first slash only, so an OpenRouter id keeps its own', () => {
    expect(parseModelRef('openrouter/anthropic/claude-opus-4.6')).toEqual({
      route: 'openrouter',
      model: 'anthropic/claude-opus-4.6',
    });
  });

  it('reads a first-party id', () => {
    expect(parseModelRef('anthropic/claude-opus-5')).toEqual({
      route: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('refuses an id with no route', () => {
    expect(() => parseModelRef('claude-opus-5')).toThrow(/must start with/);
  });

  it('refuses an unknown route', () => {
    expect(() => parseModelRef('together/some-model')).toThrow(/must start with/);
  });

  it('refuses a route with no model', () => {
    expect(() => parseModelRef('anthropic/')).toThrow(/names a route and no model/);
  });
});

describe('baseUrlFor', () => {
  it('leaves the first-party route on the SDK default', () => {
    expect(baseUrlFor('anthropic')).toBeUndefined();
  });

  it('overrides from the environment', () => {
    const before = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = 'https://example.test/api';
    try {
      expect(baseUrlFor('openrouter')).toBe('https://example.test/api');
    } finally {
      if (before === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = before;
    }
  });
});

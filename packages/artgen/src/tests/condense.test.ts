/**
 * Condensing a chunk list into one prompt, and the local check that says what survived
 * (`docs/plans/archive/INDEX.md#chunked-prompts` §4).
 */
import type { PromptChunk, TextLLM } from '@vn/types';
import { condensePrompt, contentWords, coverage, missingChunks, renderPrompt } from '../index.js';

const chunks: PromptChunk[] = [
  {
    key     : 'style',
    category: 'style',
    text    : 'Watercolour illustration.',
    origin  : { kind: 'builder' },
  },
  {
    key     : 'subject',
    category: 'subject',
    text    : 'Character portrait of AIKO.',
    origin  : { kind: 'builder' },
  },
  {
    key     : 'palette',
    category: 'palette',
    text    : 'Palette: #112233.',
    origin  : { kind: 'character', id: 'aiko', field: 'palette' },
  },
  {
    key     : 'scaffolding',
    category: 'scaffolding',
    text    : 'Neutral pose, plain background.',
    origin  : { kind: 'builder' },
  },
];

/** A `TextLLM` that answers with whatever is handed to it — or throws, which is the fallback path. */
function llm(answer: string | Error, seen: string[] = []): TextLLM {
  return {
    complete  : () => Promise.resolve(''),
    structured: <T>(prompt: string, parse: (raw: string) => T) => {
      seen.push(prompt);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(parse(answer));
    },
  };
}

const answer = (prompt: string, omitted: string[] = []): string =>
  JSON.stringify({ prompt, omitted });

describe('contentWords', () => {
  it('keeps what identifies a clause and drops what every prompt says', () => {
    expect(contentWords('Palette: #112233.')).toEqual(['112233']);
    expect(contentWords('Camera: low angle.')).toEqual(['low', 'angle']);
    expect(contentWords('The art direction is in the mood of a shot.')).toEqual([]);
  });

  it('is a set, so a repeated word is looked for once', () => {
    expect(contentWords('Aiko and Aiko.')).toEqual(['aiko']);
  });
});

describe('coverage', () => {
  it('finds every chunk in the prompt they were joined into', () => {
    const found = coverage(chunks, renderPrompt(chunks));
    expect(found.every((c) => c.found)).toBe(true);
    expect(found.every((c) => c.missing.length === 0)).toBe(true);
  });

  it('survives a rewrite that keeps the facts and changes the words around them', () => {
    const rewritten =
      'A watercolour illustration: a portrait of AIKO in a #112233 palette, neutral pose, ' +
      'against a plain background.';
    expect(missingChunks(chunks, rewritten)).toEqual([]);
  });

  it('names the chunk a rewrite dropped, and says which words it looked for', () => {
    const lost = 'A watercolour portrait of AIKO. Neutral pose, plain background.';
    expect(missingChunks(chunks, lost)).toEqual(['palette']);
    const palette = coverage(chunks, lost).find((c) => c.key === 'palette')!;
    expect(palette).toMatchObject({ found: false, words: ['112233'], missing: ['112233'] });
  });

  // Reporting pure scaffolding as lost would mark every condensation as incomplete
  it('never reports a chunk that had nothing distinctive to look for', () => {
    const only = [{ key: 'noise', text: 'Render as a single image, no text.' }];
    expect(coverage(only, 'Anything at all.')).toEqual([
      { key: 'noise', found: true, words: [], missing: [] },
    ]);
  });
});

describe('condensePrompt', () => {
  it('returns what the model wrote, checked locally', async () => {
    const written =
      'Watercolour portrait of AIKO, #112233 palette, neutral pose, plain background.';
    const result = await condensePrompt(chunks, llm(answer(written)));
    expect(result).toMatchObject({ prompt: written, source: 'llm', omitted: [] });
    expect(result.coverage.every((c) => c.found)).toBe(true);
  });

  it('numbers the clauses by key, which is what the model is asked to answer about', async () => {
    const seen: string[] = [];
    await condensePrompt(chunks, llm(answer('Anything.'), seen));
    expect(seen[0]).toContain('[palette] Palette: #112233.');
    expect(seen[0]).toContain('Clauses:');
    expect(seen[0]).not.toContain('already written this prompt by hand');
  });

  it('hands an existing custom prompt over as the thing to preserve', async () => {
    const seen: string[] = [];
    await condensePrompt(chunks, llm(answer('Anything.'), seen), '  Just Aiko, from behind.  ');
    expect(seen[0]).toContain('already written this prompt by hand');
    expect(seen[0]).toContain('Just Aiko, from behind.');
  });

  // The model's account of what it dropped is recorded but not trusted, because the local
  // coverage check decides what actually survived
  it('records what the model claims it omitted without acting on it', async () => {
    const written =
      'Watercolour portrait of AIKO, #112233 palette, neutral pose, plain background.';
    const result = await condensePrompt(chunks, llm(answer(written, ['palette'])));
    expect(result.omitted).toEqual(['palette']);
    expect(missingChunks(chunks, result.prompt)).toEqual([]);
    expect(result.source).toBe('llm');
  });

  it('falls back to the flat join when the model is unavailable', async () => {
    const result = await condensePrompt(chunks, llm(new Error('no key')));
    expect(result).toMatchObject({ prompt: renderPrompt(chunks), source: 'fallback', omitted: [] });
    expect(result.coverage.every((c) => c.found)).toBe(true);
  });

  it('falls back on an answer that is not the shape it asked for', async () => {
    for (const bad of ['not json', '{"prompt":""}', '{"omitted":[]}']) {
      const result = await condensePrompt(chunks, llm(bad));
      expect(result.source).toBe('fallback');
      expect(result.prompt).toBe(renderPrompt(chunks));
    }
  });

  it('collapses the model’s whitespace, the way every other prompt in the system is collapsed', async () => {
    const result = await condensePrompt(chunks, llm(answer('  Watercolour \n\n portrait.  ')));
    expect(result.prompt).toBe('Watercolour portrait.');
  });

  it('has nothing to condense when there are no chunks', async () => {
    const result = await condensePrompt([], llm(answer('Something.')));
    expect(result).toEqual({ prompt: '', coverage: [], source: 'fallback', omitted: [] });
  });
});

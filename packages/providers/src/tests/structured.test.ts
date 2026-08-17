import { z } from 'zod';
import { StructuredOutputError } from '@vn/util';
import { extractJson, parseStructured, withStructuredRetry } from '../index.js';

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('reads JSON from a ```json fence', () => {
    expect(extractJson('Here:\n```json\n{"a":2}\n```\nthanks')).toEqual({ a: 2 });
  });
  it('ignores trailing prose after the closing brace', () => {
    expect(extractJson('{"a":3} and some commentary')).toEqual({ a: 3 });
  });
  it('keeps the object when one of its strings quotes a code fence', () => {
    const raw = '{"final":"Write it like:\\n\\n```\\ntitus: Yeesh!\\n```\\n\\nThat is all."}';
    expect(extractJson(raw)).toEqual({
      final: 'Write it like:\n\n```\ntitus: Yeesh!\n```\n\nThat is all.',
    });
  });
  it('falls back to a fence when the prose before it holds a stray brace', () => {
    expect(extractJson('Use {placeholder}, then:\n```json\n{"a":4}\n```')).toEqual({ a: 4 });
  });
  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow(StructuredOutputError);
  });
  it('quotes what the model actually said', () => {
    expect(() => extractJson('sorry, I cannot')).toThrow(/got: sorry, I cannot/);
    expect(() => extractJson('   ')).toThrow(/the model returned nothing/);
  });
});

const schema = z.object({ name: z.string(), n: z.number() });

describe('parseStructured', () => {
  it('validates against a schema', () => {
    expect(parseStructured('{"name":"x","n":1}', schema)).toEqual({ name: 'x', n: 1 });
  });
  it('throws on schema mismatch', () => {
    expect(() => parseStructured('{"name":"x"}', schema)).toThrow(/schema validation/);
  });
});

describe('withStructuredRetry', () => {
  it('retries past malformed output then returns the valid parse', async () => {
    const responses = ['not json', '{"name":"ok"}', '{"name":"ok","n":5}'];
    let i = 0;
    const result = await withStructuredRetry(schema, () => Promise.resolve(responses[i++]!));
    expect(result).toEqual({ name: 'ok', n: 5 });
    expect(i).toBe(3);
  });

  it('rejects after exhausting retries on persistently malformed output', async () => {
    await expect(
      withStructuredRetry(schema, () => Promise.resolve('garbage'), { attempts: 2 }),
    ).rejects.toThrow(StructuredOutputError);
  });
});

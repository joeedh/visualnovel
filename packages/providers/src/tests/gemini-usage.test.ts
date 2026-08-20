/**
 * What Gemini's reply says a call cost, and in particular what it says about caching. The SDK is
 * injected through the same `GeminiClient` seam the retry tests use, because the real one arrives
 * via a dynamic `import()` jest's CJS runtime refuses.
 *
 * The shapes below are real: measured against `gemini-2.5-flash` on 2026-08-18, five calls
 * carrying a byte-identical 3,452-token prefix reported no `cachedContentTokenCount` at all for
 * the first two and 3,045 for the rest — and a second run reported one on call 4 alone. That an
 * identical request is answered either way is why an absent count must stay absent rather than
 * become a zero, and why a reported one is marked an estimate. See
 * `docs/plans/archive/gemini-estimated-cache-hit-rate.md`.
 */
import { createGeminiChat, type GeminiClient } from '../index.js';

/** A text reply carrying whatever `usageMetadata` the case is about. */
function fakeSdk(usageMetadata: unknown): GeminiClient {
  const res = { text: 'ok', candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata };
  return () => Promise.resolve({ models: { generateContent: () => Promise.resolve(res) } });
}

const ask = (usageMetadata: unknown) =>
  createGeminiChat('k', 'gemini-2.5-flash', fakeSdk(usageMetadata)).messageWithUsage!({
    prompt: 'Say "one".',
  });

describe('what a Gemini call reports it cost', () => {
  it('counts thinking as output, because that is how it is billed', async () => {
    const reply = await ask({
      promptTokenCount: 4886,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 31,
    });
    expect(reply.usage).toEqual({ input: 4886, output: 33 });
  });

  it('keeps no receipt at all when the reply carried no metadata', async () => {
    expect((await ask(undefined)).usage).toBeUndefined();
  });

  describe('the cache split', () => {
    it('carves a matched prefix out of the input rather than adding it beside', async () => {
      const reply = await ask({
        promptTokenCount: 3452,
        candidatesTokenCount: 2,
        cachedContentTokenCount: 3045,
      });
      // `input` is unchanged because `promptTokenCount` already includes the cached tokens, and
      // `cacheRead` reports how much of that total was already cached.
      expect(reply.usage).toEqual({
        input: 3452,
        output: 2,
        cacheRead: 3045,
        cacheEstimated: true,
      });
    });

    // Calls 1 and 2 of an identical prefix report nothing. Zero here would read as a cache that
    // missed, and the tooltip would show 0% of a cache that works on the very next call.
    it('leaves the split absent when the reply did not mention one', async () => {
      const usage = (await ask({ promptTokenCount: 3452, candidatesTokenCount: 2 })).usage!;
      expect(usage.cacheRead).toBeUndefined();
      expect(usage.cacheEstimated).toBeUndefined();
    });

    it('never invents a cache-write, which Gemini does not bill', async () => {
      const usage = (await ask({ promptTokenCount: 3452, cachedContentTokenCount: 3045 })).usage!;
      expect(usage.cacheWrite).toBeUndefined();
    });
  });
});

/**
 * The seam that decides whether a provider failure is worth paying for again. The SDK is
 * injected rather than mocked: the real client arrives through a dynamic `import()`, which
 * jest's CJS runtime rejects outright (see `scripts/jest-esbuild.cjs`).
 */
import { ProviderError, RetryableProviderError } from '@vn/util';
import { providerError } from '../backends/transient.js';
import { createGeminiImage, isTransient, retryAfterMs, type GeminiClient } from '../index.js';

/** An SDK error the way the vendors raise it: a numeric status beside the message. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** A Gemini response carrying one inline PNG — the only shape `extractImage` accepts. */
const oneImage = {
  candidates: [
    { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } },
  ],
};

/** A fake `@google/genai` whose `generateContent` replays `outcomes`, counting the calls. */
function fakeSdk(outcomes: (Error | typeof oneImage)[]): {
  client: GeminiClient;
  calls: () => number;
} {
  let calls = 0;
  const generateContent = (): Promise<unknown> => {
    const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  return { client: () => Promise.resolve({ models: { generateContent } }), calls: () => calls };
}

const params = { modelId: 'gemini-2.5-flash-image', aspect: '16:9' as const };

describe('isTransient', () => {
  it('retries rate limits and the server’s own faults', () => {
    expect(isTransient(httpError(429, 'rate limited'))).toBe(true);
    expect(isTransient(httpError(503, 'Service Unavailable'))).toBe(true);
    expect(isTransient(httpError(500, 'internal'))).toBe(true);
  });

  it('reads a status the SDK only stringified', () => {
    expect(isTransient(new Error('got status: 503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'))).toBe(
      true,
    );
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
    expect(isTransient(new Error('fetch failed'))).toBe(true);
  });

  // The expensive direction to be wrong in: three refusals cost three times one refusal.
  it('treats a bad request, a refusal, and anything unrecognized as terminal', () => {
    expect(isTransient(httpError(400, 'invalid argument'))).toBe(false);
    expect(isTransient(httpError(403, 'permission denied'))).toBe(false);
    expect(isTransient(new Error('the prompt was blocked by safety filters'))).toBe(false);
    expect(isTransient('something opaque')).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe('createGeminiImage — retry in place', () => {
  it('rides out two 503s and returns the image the third call produced', async () => {
    const unavailable = httpError(503, 'Service Unavailable');
    const sdk = fakeSdk([unavailable, unavailable, oneImage]);
    const backend = createGeminiImage('k', params.modelId, sdk.client);

    expect((await backend.generate('a room', [], params)).ext).toBe('png');
    expect(sdk.calls()).toBe(3);
  }, 15_000);

  it('gives up at once on a 400 — one call, and the class says why', async () => {
    const sdk = fakeSdk([httpError(400, 'invalid argument')]);
    const backend = createGeminiImage('k', params.modelId, sdk.client);

    const err = await backend.generate('a room', [], params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(RetryableProviderError);
    expect((err as Error).message).toContain('invalid argument');
    expect(sdk.calls()).toBe(1);
  });

  it('exhausts the budget when the outage does not lift, and says it was transient', async () => {
    const sdk = fakeSdk([httpError(503, 'Service Unavailable')]);
    const backend = createGeminiImage('k', params.modelId, sdk.client);

    await expect(backend.generate('a room', [], params)).rejects.toBeInstanceOf(
      RetryableProviderError,
    );
    expect(sdk.calls()).toBe(3);
  }, 15_000);

  // Decided before the network, so another attempt would send the same bad bytes.
  it('never retries an unusable reference image', async () => {
    const sdk = fakeSdk([oneImage]);
    const backend = createGeminiImage('k', params.modelId, sdk.client);
    const notAnImage = { bytes: new Uint8Array([1, 2, 3, 4]), ext: 'png' };

    await expect(backend.generate('a room', [notAnImage], params)).rejects.toThrow(
      /not a valid PNG/,
    );
    expect(sdk.calls()).toBe(0);
  });
});

describe('what the provider said to wait', () => {
  const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('reads a count of seconds, however the SDK filed the headers', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '30' } }, NOW)).toBe(30_000);
    expect(retryAfterMs({ responseHeaders: { 'Retry-After': '1.5' } }, NOW)).toBe(1_500);
    expect(retryAfterMs({ response: { headers: { 'RETRY-AFTER': '2' } } }, NOW)).toBe(2_000);
  });

  it('reads a `Headers` object, which is what a fetch-based SDK hands over', () => {
    const headers = new Headers({ 'retry-after': '5' });
    expect(retryAfterMs({ headers }, NOW)).toBe(5_000);
  });

  it('reads an HTTP-date as the time to wait until', () => {
    const at = new Date(NOW + 20_000).toUTCString();
    expect(retryAfterMs({ headers: { 'retry-after': at } }, NOW)).toBe(20_000);
  });

  // Each of these says nothing, which is different from saying zero: the caller falls back to
  // its own backoff rather than trying again immediately.
  it('says nothing when the header is absent, unreadable or already past', () => {
    expect(retryAfterMs({})).toBeUndefined();
    expect(retryAfterMs({ headers: { 'retry-after': 'soon' } }, NOW)).toBeUndefined();
    expect(retryAfterMs({ headers: { 'retry-after': '' } }, NOW)).toBeUndefined();
    const gone = new Date(NOW - 20_000).toUTCString();
    expect(retryAfterMs({ headers: { 'retry-after': gone } }, NOW)).toBeUndefined();
  });

  it('travels on the wrapped error, and only on the retryable one', () => {
    const limited = providerError(
      'chat',
      Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '7' } }),
    );
    expect(limited).toBeInstanceOf(RetryableProviderError);
    expect((limited as RetryableProviderError).retryAfterMs).toBe(7_000);

    // A terminal failure has no wait to carry, whatever the response happened to include.
    const refused = providerError(
      'chat',
      Object.assign(new Error('bad key'), { status: 401, headers: { 'retry-after': '7' } }),
    );
    expect(refused).toBeInstanceOf(ProviderError);
    expect(refused).not.toBeInstanceOf(RetryableProviderError);
  });
});

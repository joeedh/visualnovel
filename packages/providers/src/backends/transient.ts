/**
 * Transient-vs-terminal classification for vendor SDK failures, and the in-place retry the
 * backends wrap their network calls in. This is the only layer that sees a status code, so it
 * is the only layer that can tell a rate limit from a content refusal.
 */
import { ProviderError, RetryableProviderError, retry } from '@vn/util';

/** Attempts and backoff for one network call. Deliberately small — the scheduler retries too. */
const ATTEMPTS = 3;
const BASE_MS = 500;

/** Best-effort one-line description of an SDK/HTTP error for the wrapped message. */
export function causeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Rate limiting and the server's own faults; a 4xx other than 429 is the caller's problem. */
const retryableStatus = (s: number): boolean => s === 429 || (s >= 500 && s < 600);

/**
 * Transport failures and the vendors' symbolic names for the same conditions. The connection
 * never carried a real answer, so nothing about the request is known to be wrong.
 */
const TRANSIENT_TEXT =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|fetch failed|socket hang up|network error|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|overloaded/i;

/** A status code named in the message, for SDKs that stringify rather than attach one. */
const STATUS_IN_TEXT = /\b(?:status|code)\b\W{0,4}(\d{3})\b/i;

/**
 * Whether another attempt could plausibly get a different answer. The SDKs put the status in
 * more than one place and sometimes only in the message, so all of them are read. Anything
 * unrecognized is **terminal**: retrying a refusal costs three times as much for the same
 * refusal, which is the expensive direction to be wrong in.
 */
export function isTransient(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [e?.status, e?.code, e?.response?.status]) {
    if (typeof value === 'number' && retryableStatus(value)) return true;
  }
  const message = causeMessage(err);
  if (TRANSIENT_TEXT.test(message)) return true;
  const named = STATUS_IN_TEXT.exec(message)?.[1];
  return named !== undefined && retryableStatus(Number(named));
}

/** One header off whatever the SDK put the response headers in — an object, or a `Headers`. */
function headerOf(err: unknown, name: string): string | undefined {
  const bags = [
    (err as { headers?: unknown })?.headers,
    (err as { responseHeaders?: unknown })?.responseHeaders,
    (err as { response?: { headers?: unknown } })?.response?.headers,
  ];
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue;
    const get = (bag as { get?: unknown }).get;
    if (typeof get === 'function') {
      const value = (get as (k: string) => unknown).call(bag, name);
      if (typeof value === 'string') return value;
      continue;
    }
    // A plain object: header names are case-insensitive, so match that way rather than trusting
    // whichever casing this SDK happened to preserve.
    for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
      if (key.toLowerCase() === name && typeof value === 'string') return value;
    }
  }
  return undefined;
}

/**
 * What the provider said to wait, in ms. `Retry-After` is either a count of seconds or an
 * HTTP-date, and both are in the wild — Anthropic sends seconds, and a proxy in front of any of
 * them may send the date. A value that is absent, unparseable or in the past says nothing, and
 * the caller falls back to its own backoff.
 */
export function retryAfterMs(err: unknown, now = Date.now()): number | undefined {
  const raw = headerOf(err, 'retry-after')?.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return at > now ? at - now : undefined;
}

/**
 * Wrap an SDK failure, choosing the class from whether another attempt could help — and carrying
 * the provider's own `retry-after` where it sent one, because the layer that knows when a limit
 * resets is the response, and nothing above here can see it.
 */
export function providerError(what: string, err: unknown): ProviderError {
  const message = `${what}: ${causeMessage(err)}`;
  if (!isTransient(err)) return new ProviderError(message, { cause: err });
  const after = retryAfterMs(err);
  return new RetryableProviderError(message, {
    cause: err,
    ...(after === undefined ? {} : { retryAfterMs: after }),
  });
}

/**
 * Run one SDK call, retrying only while the failure looks transient. A `ProviderError` the
 * caller raised itself — an unusable reference, an empty response — passes straight through,
 * because it was decided before or after the network and another attempt cannot change it.
 */
export function callWithRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  return retry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        throw err instanceof ProviderError ? err : providerError(what, err);
      }
    },
    {
      attempts: ATTEMPTS,
      baseMs: BASE_MS,
      shouldRetry: (err) => err instanceof RetryableProviderError,
      // The vendors all say the same thing: honour `retry-after` when it is there, back off
      // exponentially when it is not. This is the first half; `baseMs` above is the second.
      delayFor: (err) => (err instanceof RetryableProviderError ? err.retryAfterMs : undefined),
    },
  );
}

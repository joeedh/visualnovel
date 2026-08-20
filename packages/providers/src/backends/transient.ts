/**
 * Transient-vs-terminal classification for vendor SDK failures, and the in-place retry the
 * backends wrap their network calls in. This is the only layer that sees a status code, so it
 * is the only layer that can tell a rate limit from a content refusal.
 */
import { ConfigError, ProviderError, RetryableProviderError, retry } from '@vn/util';

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
 * unrecognized is treated as terminal: retrying a refusal costs three times as much for the
 * same refusal, which is the expensive direction to be wrong in.
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

/**
 * What sort of fault this was, for a host deciding what to offer the author about it.
 *
 * This refines {@link isTransient} rather than replacing it: `transient` means the same thing
 * here, and the other three split what `isTransient` lumps together as "terminal".
 *
 * - `transient` — a 429, a 5xx, a dead socket. Another attempt is worth making.
 * - `auth` — 401, 403, a {@link ConfigError}. The fix is the key rather than a bug report.
 * - `request` — a terminal 4xx that is neither: the body itself was rejected.
 * - `unknown` — unrecognized, and deliberately treated as no information.
 */
export type FaultKind = 'transient' | 'auth' | 'request' | 'unknown';

/** 4xx that reject the caller's identity rather than the contents of the request. */
const authStatus = (s: number): boolean => s === 401 || s === 403;

/** Every status this error carries, wherever the SDK put it, including one named in the message. */
function statuses(err: unknown): number[] {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const found: number[] = [];
  for (const value of [e?.status, e?.code, e?.response?.status]) {
    if (typeof value === 'number') found.push(value);
  }
  const named = STATUS_IN_TEXT.exec(causeMessage(err))?.[1];
  if (named !== undefined) found.push(Number(named));
  return found;
}

/**
 * Classify a failure, unwrapping `cause` as far as it goes.
 *
 * The unwrapping is what makes this work. {@link providerError} wraps the SDK error as
 * `new ProviderError(message, { cause: err })`, so by the time a host catches one the status is on
 * `.cause` — and Anthropic's own message, `400 {"type":"error",…}`, matches neither
 * {@link STATUS_IN_TEXT} (no "status"/"code" word before the number) nor anything else here. A
 * classifier that read only the outermost error would answer `unknown` for every real 400.
 */
export function faultKind(err: unknown): FaultKind {
  // By class, without needing a status at all: this is what the retry policy already decided.
  if (err instanceof RetryableProviderError) return 'transient';
  if (err instanceof ConfigError) return 'auth';

  let seen: unknown = err;
  const chain: unknown[] = [];
  // Bounded, because a `cause` cycle is a hang rather than a wrong answer, and a wrong answer is
  // the recoverable one.
  for (let depth = 0; seen !== undefined && seen !== null && depth < 8; depth++) {
    chain.push(seen);
    seen = (seen as { cause?: unknown }).cause;
  }
  for (const link of chain) {
    if (link instanceof ConfigError) return 'auth';
    if (isTransient(link)) return 'transient';
    const found = statuses(link);
    if (found.some(authStatus)) return 'auth';
    // 4xx only. The `code` field often holds a number that is not an HTTP status — an `errno`,
    // a vendor's own code — and reading one as a rejection would offer a bug report for a typo.
    if (found.some((s) => s >= 400 && s < 500)) return 'request';
    // Anthropic and Gemini both put the code at the head of the message with no word before it,
    // which is the one shape `STATUS_IN_TEXT` deliberately will not match.
    const lead = /^\s*(\d{3})\b/.exec(causeMessage(link))?.[1];
    if (lead !== undefined) {
      const status = Number(lead);
      if (authStatus(status)) return 'auth';
      if (status >= 400 && status < 500) return 'request';
    }
  }
  return 'unknown';
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
 * the provider's own `retry-after` where it sent one, because only the response says when a limit
 * resets and nothing above here can see it.
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
      // Every vendor asks for the same policy: honour `retry-after` where one was sent, and back
      // off exponentially where none was. `delayFor` covers the first case and `baseMs` the second
      delayFor: (err) => (err instanceof RetryableProviderError ? err.retryAfterMs : undefined),
    },
  );
}

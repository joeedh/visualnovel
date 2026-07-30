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

/** Wrap an SDK failure, choosing the class from whether another attempt could help. */
export function providerError(what: string, err: unknown): ProviderError {
  const Cls = isTransient(err) ? RetryableProviderError : ProviderError;
  return new Cls(`${what}: ${causeMessage(err)}`, { cause: err });
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
    },
  );
}

/**
 * Bounded async pool (report §7, §10): run async tasks with a hard concurrency cap,
 * preserving input order in the result array. The scheduler uses this to respect a
 * configurable concurrency limit while running independent tasks in parallel.
 */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let next = 0;

  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}

/**
 * Retry an async op with exponential backoff. Throws the last error on exhaustion, and
 * immediately when `shouldRetry` rules an error out — the default retries everything.
 *
 * `delayFor` reads a wait out of the failure itself, typically a `retry-after`. A number from it
 * is used in place of the computed backoff, because a provider that names a delay is reporting
 * when its own limit resets: a shorter wait gets another 429 and a longer one wastes the
 * difference.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    attempts?: number;
    baseMs?: number;
    shouldRetry?: (err: unknown) => boolean;
    delayFor?: (err: unknown, attempt: number) => number | undefined;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 250;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !(opts.shouldRetry?.(err) ?? true)) break;
      const asked = opts.delayFor?.(err, attempt);
      const wait = asked === undefined ? baseMs * 2 ** (attempt - 1) : asked;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}

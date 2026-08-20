import { retry } from '../pool.js';

/** A function that rejects with `err` until `succeedAt`, counting its calls. */
function flaky(
  succeedAt: number,
  err: unknown,
): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    fn: () => (++calls < succeedAt ? Promise.reject(err) : Promise.resolve('ok')),
    calls: () => calls,
  };
}

describe('retry', () => {
  it('retries every error by default, up to the budget', async () => {
    const f = flaky(3, new Error('boom'));
    expect(await retry(f.fn, { attempts: 3, baseMs: 0 })).toBe('ok');
    expect(f.calls()).toBe(3);

    const doomed = flaky(99, new Error('boom'));
    await expect(retry(doomed.fn, { attempts: 3, baseMs: 0 })).rejects.toThrow('boom');
    expect(doomed.calls()).toBe(3);
  });

  // The predicate exists so that a failure another attempt cannot fix costs only one attempt
  it('stops immediately, and throws the same error, when shouldRetry says no', async () => {
    const f = flaky(99, new Error('terminal'));
    await expect(retry(f.fn, { attempts: 5, baseMs: 0, shouldRetry: () => false })).rejects.toThrow(
      'terminal',
    );
    expect(f.calls()).toBe(1);
  });

  it('asks the predicate about the error it actually saw', async () => {
    const seen: string[] = [];
    const f = flaky(3, new Error('transient'));
    await retry(f.fn, {
      attempts: 3,
      baseMs: 0,
      shouldRetry: (err) => (seen.push((err as Error).message), true),
    });
    expect(seen).toEqual(['transient', 'transient']);
  });
});

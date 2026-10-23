import { z } from 'zod';
import { RetryableProviderError } from '@vn/util';
import { callWithRetry } from '../backends/transient.js';
import { reportingRetries, withRequestStop, withStructuredRetry } from '../index.js';

it('interrupts retry backoff and never sends the retry', async () => {
  const stop = new AbortController();
  let waiting!: () => void;
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const call = jest.fn(async () => {
    throw new RetryableProviderError('rate limited', { retryAfterMs: 60_000 });
  });
  const running = withRequestStop({ signal: stop.signal }, () =>
    reportingRetries(
      () => waiting(),
      () => callWithRetry('test', call),
    ),
  );
  const rejected = running.catch((err: unknown) => err);
  await entered;
  stop.abort();
  expect(await rejected).toBe(stop.signal.reason);
  expect(call).toHaveBeenCalledTimes(1);
});

it('keeps an in-flight response but refuses a later request in the same scope', async () => {
  const stop = new AbortController();
  let release!: (value: string) => void;
  const response = new Promise<string>((resolve) => {
    release = resolve;
  });
  const call = jest.fn(() => response);
  const first = withRequestStop({ signal: stop.signal }, () => callWithRetry('test', call));
  stop.abort();
  release('paid response');
  await expect(first).resolves.toBe('paid response');
  await expect(
    withRequestStop({ signal: stop.signal }, () => callWithRetry('test', call)),
  ).rejects.toBeDefined();
  expect(call).toHaveBeenCalledTimes(1);
  await expect(callWithRetry('unrelated', async () => 'ok')).resolves.toBe('ok');
});

it('does not start a structured-output repair after stop', async () => {
  const stop = new AbortController();
  const call = jest.fn(async () => {
    stop.abort();
    return 'invalid JSON';
  });
  await expect(
    withRequestStop({ signal: stop.signal }, () =>
      withStructuredRetry(z.object({ value: z.string() }), call),
    ),
  ).rejects.toBeDefined();
  expect(call).toHaveBeenCalledTimes(1);
});

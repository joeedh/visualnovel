import { AsyncLocalStorage } from 'node:async_hooks';

/** Signals a cooperative stop at a request boundary without spending a task retry. */
export class RequestStopped extends Error {
  constructor() {
    super('Stopped before the next API request.');
  }
}

const scope = new AsyncLocalStorage<{ signal?: AbortSignal; abort?: AbortSignal }>();

/** Keeps cancellation local to the task, including provider retries beneath it. */
export function withRequestStop<T>(
  signals: { signal?: AbortSignal; abort?: AbortSignal },
  body: () => Promise<T>,
): Promise<T> {
  return scope.run(signals, body);
}

export function requestSignal(): AbortSignal | undefined {
  const signals = scope.getStore();
  const all = [signals?.signal, signals?.abort].filter((s): s is AbortSignal => s !== undefined);
  return all.length ? AbortSignal.any(all) : undefined;
}

/** Refuses another request while allowing an outstanding response to be saved. */
export function checkRequest(): void {
  if (requestSignal()?.aborted) throw new RequestStopped();
}

/** Fences late answers from a task whose owner has already abandoned it. */
export function checkRequestWrite(): void {
  if (scope.getStore()?.abort?.aborted) throw new RequestStopped();
}

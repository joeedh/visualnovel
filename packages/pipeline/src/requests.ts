import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { GenServices } from '@vn/gengraph';
import type { AssetStore, Providers } from '@vn/types';
import { checkRequest, checkRequestWrite } from '@vn/providers';
import { hashParts, sha256, writeFileAtomic } from '@vn/util';
export { RequestStopped, checkRequest, checkRequestWrite, withRequestStop } from '@vn/providers';

/** Hashes byte arguments without putting request bodies or credentials in the journal. */
function requestArgs(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: sha256(value) };
  if (typeof value === 'function') return String(value);
  if (Array.isArray(value)) return value.map(requestArgs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, requestArgs(v)]));
  }
  return value;
}

/** Saves successful responses before returning them to a runner; resumes across processes. */
export class TaskRequests {
  private counts = new Map<string, number>();
  private pending = new Set<Promise<unknown>>();
  private writes = new Set<Promise<unknown>>();

  constructor(private readonly dir: string) {}

  call<T>(name: string, args: unknown[], body: () => Promise<T>): Promise<T> {
    const key = hashParts(name, requestArgs(args));
    const occurrence = this.counts.get(key) ?? 0;
    this.counts.set(key, occurrence + 1);
    const work = this.perform(join(this.dir, `${key}-${occurrence}.bin`), body);
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }

  private async perform<T>(file: string, body: () => Promise<T>): Promise<T> {
    checkRequestWrite();
    try {
      const bytes = await readFile(file);
      checkRequestWrite();
      return deserialize(bytes) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    checkRequest();
    const answer = await body();
    checkRequestWrite();
    await this.write(() =>
      writeFileAtomic(file, serialize(answer), async () => checkRequestWrite()),
    );
    return answer;
  }

  /** A failed sibling must not release the task while another request is still settling. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Drains local writes before an immediate abort releases execution ownership. */
  async writesSettled(): Promise<void> {
    await Promise.allSettled([...this.writes]);
  }

  write<T>(body: () => Promise<T>): Promise<T> {
    checkRequestWrite();
    const work = body();
    this.writes.add(work);
    void work.then(
      () => this.writes.delete(work),
      () => this.writes.delete(work),
    );
    return work;
  }

  store(store: AssetStore): AssetStore {
    return new Proxy(store, {
      get: (object, key) => {
        const value: unknown = Reflect.get(object, key, object);
        if (typeof value !== 'function') return value;
        const method = value as (...args: unknown[]) => unknown;
        if (key === 'write' || key === 'hold') {
          return (...args: unknown[]) =>
            this.write(() => method.apply(object, args) as Promise<unknown>);
        }
        return method.bind(object);
      },
    });
  }

  private wrap<T extends object>(target: T, name: string, methods: readonly string[]): T {
    return new Proxy(target, {
      get: (object, key, receiver) => {
        const value: unknown = Reflect.get(object, key, receiver);
        if (typeof key !== 'string' || !methods.includes(key) || typeof value !== 'function') {
          return value;
        }
        const method = value as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) =>
          this.call(`${name}.${key}`, args, () => method.apply(object, args));
      },
    });
  }

  providers(providers: Providers): Providers {
    return {
      image    : this.wrap(providers.image, 'image', ['generate', 'edit']),
      text     : this.wrap(providers.text, 'text', ['complete', 'structured']),
      reviewers: providers.reviewers.map((reviewer, i) =>
        this.wrap(reviewer, `review.${i}.${reviewer.id}`, ['review']),
      ),
    };
  }

  services(services: GenServices, namespace = 'graph'): GenServices {
    return {
      ...services,
      image: this.wrap(services.image, `${namespace}.image`, ['generate', 'edit']),
      text : this.wrap(services.text, `${namespace}.text`, ['complete', 'structured']),
      fetch: (...args) => this.call(`${namespace}.fetch`, args, () => services.fetch(...args)),
      blobs: {
        read : (hash) => services.blobs.read(hash),
        has  : (ref) => services.blobs.has(ref),
        write: (...args) => this.write(() => services.blobs.write(...args)),
      },
    };
  }
}

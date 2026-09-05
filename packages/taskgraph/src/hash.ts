import type { Task, TaskInputs, TaskKind } from '@vn/types';
import { hashParts } from '@vn/util';

/**
 * The content-addressed dedupe key (report §7): a task's identity is a hash of
 * everything that determines its output — its kind plus its fully-specified inputs
 * (normalized prompt, ordered reference asset hashes, model id, params). Two requests
 * that resolve to the same inputs produce the same hash, so they become one shared task.
 */
export function taskHash<K extends TaskKind>(kind: K, inputs: TaskInputs[K]): string {
  return hashParts(kind, inputs as unknown);
}

/** Construct a task node with its hash computed from (kind, inputs). */
export function makeTask<K extends TaskKind>(
  kind: K,
  inputs: TaskInputs[K],
  deps: string[] = [],
): Task<K> {
  return {
    hash: taskHash(kind, inputs),
    kind,
    deps: [...new Set(deps)].sort(),
    inputs,
    status  : 'pending',
    attempts: [],
  };
}

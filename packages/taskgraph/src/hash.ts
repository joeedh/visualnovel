import type { Task, TaskInputs, TaskKind } from '@vn/types';
import { hashParts } from '@vn/util';

/**
 * The content-addressed dedupe key (report §7): a task's identity is a hash of everything that
 * determines its output — its kind plus its fully-specified inputs (normalized prompt, ordered
 * reference asset hashes, params) — except the model id. Two requests that resolve to the same
 * inputs produce the same hash, so they become one shared task.
 *
 * The model id is left out so that changing the project's image model does not re-key every
 * task in the project: a rendered slot keeps its picture until it is regenerated, and only then
 * is the new model used. The model an asset was drawn with is recorded on the asset itself.
 */
export function taskHash<K extends TaskKind>(kind: K, inputs: TaskInputs[K]): string {
  return hashParts(kind, identityOf(inputs));
}

/** `inputs` with the model id removed, wherever the kind carries it. */
function identityOf(inputs: unknown): unknown {
  if (typeof inputs !== 'object' || inputs === null) return inputs;
  const {
    modelId: _model,
    params,
    ...rest
  } = inputs as {
    modelId?: string;
    params?: { modelId?: string };
  };
  if (params === undefined) return rest;
  const { modelId: _paramsModel, ...stripped } = params;
  return { ...rest, params: stripped };
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

import { contract } from '@vn/contracts';
import type { Task, TaskInputs, TaskKind } from '@vn/types';
import { hashParts } from '@vn/util';

export const identityTaskHash = contract({
  id      : 'identity.taskHash',
  rule: 'A task is identified by `sha256(kind, inputs)`, where the inputs are the normalized prompt, the ordered reference asset hashes and the params, and never the model id. Identical work therefore collapses to one node.',
  prevents:
    'Changing `models.image` re-keying every task, so that every drawn slot is drawn again, or two requests for the same picture each paying for it.',
  subjects: [
    'function:packages/taskgraph/src/hash.ts#taskHash',
    'function:packages/taskgraph/src/hash.ts#makeTask',
    'function:packages/taskgraph/src/graph.ts#TaskGraph',
    'function:packages/stills/src/prompts.ts#seedFor',
    'function:packages/stills/src/prompts.ts#aspectFor',
    'function:packages/stills/src/prompts.ts#modelFor',
  ],
  see: [
    'docs/history/vn-generator-report.md',
    'docs/plans/archive/openrouter-backend-and-the-image-model-default.md',
    'docs/plans/openrouter-as-a-fallback-transport.md',
    'docs/plans/archive/INDEX.md#contracts-into-code-and-workflows',
  ],
  detail:
    'The model id is left out so that changing `models.image` in `project.yaml` does not re-key ' +
    'every task: a rendered slot keeps its picture, and the new model is used for slots not yet ' +
    "drawn, for a regenerate, and where a slot's own `model` override names it. `taskHash` " +
    'removes `modelId` from the inputs and from their `params` before hashing. A node that has ' +
    'not drawn yet (`pending` or `failed`) takes the inputs of the latest planning pass in ' +
    "`TaskGraph.add`, so it follows the project's current model; a `done` or `needs_human` node " +
    'keeps the inputs it ran with. The asset records the model that drew it (`Asset.modelId`, ' +
    "always the author's spelling, never OpenRouter's) and, optionally, the key that carried the " +
    'call (`Asset.transport`). A picture drawn through OpenRouter has the same identity as one ' +
    "drawn natively, so adding a vendor's key later redraws nothing. `params` is `image_params` " +
    'with the narrowest authored seed applied (`seedFor`) and, for a shot, its own `aspect` in ' +
    "place of the project's (`aspectFor`). Both return the project's params by identity when " +
    'nothing was authored, so a project that authored neither hashes as it did before either ' +
    'field existed. The model id is resolved the same way (`modelFor`: the narrowest ' +
    '`imageModel` rung, else `models.image`) but, being outside the hash, changes nothing about ' +
    'identity. Because identical work collapses to one node, dedupe, resumability and staleness ' +
    'come at no extra cost: `TaskGraph.add` answers the existing node for a known hash and adds ' +
    'any new dependency edges to it. `packages/pipeline/src/tests/prompthash.test.ts` guards the ' +
    "hashes of a real project against a committed baseline that is never regenerated; this rule's " +
    'pinning test checks `taskHash` and `TaskGraph.add` directly.',
});

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

/**
 * Refusals that stop a whole project rather than one slot. `solve` reports them on
 * `Solution.refusal`, and a host that must refuse before it solves asks {@link projectRefusal}.
 */
import type { BaseAssets } from '@vn/types';
import { contract } from '@vn/contracts';
import type { SolverFacts } from './family.js';

export const storageBaseUnavailable = contract({
  id      : 'storage.baseUnavailable',
  rule: 'A base asset root whose directory exists without a readable manifest is `unavailable`, and the project is refused: `solve` reports the refusal with no slot ready, the planner plans nothing, and every act that would write to the root refuses in the same sentence.',
  prevents:
    'Regenerating an approved library at cost over a checkout that is missing the base repo, which a check that only counts assets cannot tell from a root where nothing has been generated yet.',
  subjects: [
    'function:packages/constraint-solver/src/refuse.ts#baseRefusal',
    'function:packages/constraint-solver/src/refuse.ts#projectRefusal',
    'function:packages/constraint-solver/src/solve.ts#solve',
    'function:packages/pipeline/src/planner.ts#planTasks',
    'module:packages/scheduler/src/scheduler.ts',
    'module:packages/artgen/src/base.ts',
  ],
  see: [
    'docs/plans/archive/INDEX.md#base-and-project-asset-stores',
    'docs/plans/contracts-into-code-and-workflows.md#stage-6-the-constraint-solver-with-stills-as-its-first-family',
  ],
  detail:
    'A checkout missing the base repo leaves the same state behind. The planner produces no ' +
    'plan when the root is `unavailable`, because the work downstream of base art references it, ' +
    'and it logs `plan.refused` with the root. The run stops before its wave loop and reports a ' +
    'single sentence, `baseRefusal`, that names the root and says to restore it rather than ' +
    'regenerate. On-demand art, adoption, promotion and upload refuse with the same sentence. An ' +
    '`absent` root (a new or legacy project) and a `ready` one refuse nothing, and facts with no ' +
    'base root have no opinion.',
});

/**
 * Answers why a base root cannot be written to, or `undefined` when it can. `unavailable` means the
 * directory is there and its manifest is not.
 */
export function baseRefusal(base?: BaseAssets): string | undefined {
  if (base?.state !== 'unavailable') return undefined;
  return `base assets at ${base.root} are unavailable: the directory exists but has no readable manifest.json (a checkout without the base repo looks exactly like this). Nothing was written — restore it rather than generating over it.`;
}

/** Answers why nothing in the project may be planned, or `undefined` when it may. */
export function projectRefusal(facts: SolverFacts): string | undefined {
  return baseRefusal(facts.base);
}

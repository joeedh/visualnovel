/**
 * Suspension as the CLI, the desktop session and the agent's tools ask for it, from a context that
 * holds the model, the manifest and the sheet angles. The rule is the solver's `suspensions`, run
 * over the stills family (`takes.suspensionDerived`).
 */
import { suspensions, type Suspension } from '@vn/constraint-solver';
import { stillsFamily, type BindingContext, type RungContext, type StillsFacts } from '@vn/stills';

export type { Suspension };

/** Everything the walk reads: the manifest and the rungs an override could be stored at. */
export interface SuspendContext extends BindingContext, RungContext {}

const NO_TASKS: StillsFacts['tasks'] = { get: () => undefined };

/** Lists every suspended asset, upstream before downstream. */
export function suspendedAssets(ctx: SuspendContext): Suspension[] {
  return suspensions(stillsFamily, { ...ctx, tasks: NO_TASKS });
}

/** Answers the same listing indexed by hash, for a surface asking about one asset. */
export function suspensionMap(ctx: SuspendContext): Map<string, Suspension> {
  return new Map(suspendedAssets(ctx).map((s) => [s.hash, s]));
}

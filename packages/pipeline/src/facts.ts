/**
 * The one place `@vn/pipeline` builds the facts it solves the stills family over and seeds sheets
 * from, so the planner and the scheduled runner cannot assemble different ones.
 */
import type { Asset, BaseAssets, ProjectModel } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { PlanFacts, StillsFacts } from '@vn/stills';

const NO_TASKS: StillsFacts['tasks'] = { get: () => undefined };

/**
 * Builds the facts for one wave, or for one runner, from what the caller holds. Without `tasks` no
 * shot states an identity; without `assets` approval reads each character sheet's mirror; without
 * `base` nothing refuses the project. The kinds memoise on the object returned, so a caller builds
 * new facts after changing the model or the task log.
 */
export function waveFacts(opts: {
  model: ProjectModel;
  config: ProjectConfig;
  tasks?: StillsFacts['tasks'];
  assets?: readonly Asset[];
  base?: BaseAssets;
}): PlanFacts {
  return {
    model : opts.model,
    config: opts.config,
    tasks : opts.tasks ?? NO_TASKS,
    ...(opts.assets ? { assets: opts.assets } : {}),
    ...(opts.base ? { base: opts.base } : {}),
  };
}

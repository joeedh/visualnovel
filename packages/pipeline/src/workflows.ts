/**
 * The family each workflow a project can select produces its art with, which a host looks up
 * from `config.workflow`.
 */
import type { Workflow } from '@vn/types';
import type { Family } from '@vn/constraint-solver';
import { stillsFamily, type PlanFacts } from '@vn/stills';

/**
 * The facts every host builds, through `waveFacts` or the desktop's `sessionFacts`, and solves
 * each workflow's family over.
 */
export type HostFacts = PlanFacts;

/**
 * Keyed over every `Workflow`, so a workflow named without a family does not compile. A family
 * that reads only what `HostFacts` carries is registered as it is; one whose facts carry fields of
 * their own is registered as `withFacts(family, build)`, with `build` deriving them from the host's.
 */
const FAMILIES: { readonly [W in Workflow]: Family<HostFacts> } = {
  vn: stillsFamily,
};

/** Answers the family a workflow produces its art with. */
export function familyOf(workflow: Workflow): Family<HostFacts> {
  return FAMILIES[workflow];
}

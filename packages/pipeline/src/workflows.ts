/**
 * The family each workflow a project can select produces its art with, which a host looks up
 * from `config.workflow`.
 */
import type { Workflow } from '@vn/types';
import type { Family } from '@vn/constraint-solver';
import { stillsFamily, type StillsFacts } from '@vn/stills';

/** Keyed over every `Workflow`, so a workflow named without a family does not compile. */
const FAMILIES: { readonly [W in Workflow]: Family<StillsFacts> } = {
  vn: stillsFamily,
};

/** Answers the family a workflow produces its art with. */
export function familyOf(workflow: Workflow): Family<StillsFacts> {
  return FAMILIES[workflow];
}

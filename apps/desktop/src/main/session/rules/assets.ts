import { familyOf } from '@vn/pipeline';
import { suspensions, type Suspension } from '@vn/constraint-solver';
import { driftOf } from '@vn/stills';
import type { AssetKind, ProjectModel, RetiredTaskKind, TaskKind } from '@vn/types';
import { shotsOf } from '@vn/types';
import { sessionFacts, type LoadedProject } from '../load/project.js';

/**
 * The task kinds that render a picture. Each one's prompt opens with the project's art style, so
 * this is exactly the set of tasks a style change re-keys. It keeps the retired `outfit_sheet`,
 * so a record of one in an older log is counted as before.
 */
export const IMAGE_KINDS = new Set<TaskKind | RetiredTaskKind>([
  'location_ref',
  'portrait',
  'model_sheet',
  'outfit_sheet',
  'shot_image',
]);

/**
 * The kinds `previewAccept` does not refuse outright. The excluded kinds have no approval to
 * grant or withhold: a portrait is approved through the character gate, a concept is consumed by
 * nothing, and an upload was never generated in the first place.
 */
export const ACCEPTABLE = new Set<AssetKind>([
  'location_ref',
  'model_sheet',
  'outfit_sheet',
  'shot_image',
]);

/**
 * Which assets are suspended, keyed by hash. One walk answers both the listing and the one-asset
 * question, so a pane and `asset.suspended` can never disagree about a reason.
 */
export function suspensionsOf(
  project: LoadedProject,
  model: ProjectModel,
): Map<string, Suspension> {
  const family = familyOf(project.config.workflow);
  return new Map(suspensions(family, sessionFacts(project, model)).map((s) => [s.hash, s]));
}

/**
 * The frames whose scene has moved on since they were drawn. Re-derived on every call, like every
 * other reading of drift, and the same walk `doctree.ts` makes for the Stale branch — so what the
 * tree files as stale and what the approval queue leaves out cannot disagree.
 */
export function driftedFrames(model: ProjectModel): Set<string> {
  const out = new Set<string>();
  for (const scene of model.scenes.values()) {
    for (const shot of shotsOf(model, scene.id)) {
      if (shot.image !== undefined && driftOf(scene, shot) === 'drifted') out.add(shot.image);
    }
  }
  return out;
}

/** Why an asset of this kind has no chunks to edit — the sentence `PromptView.frozen` carries. */
export function frozenReason(kind: AssetKind): string {
  return kind === 'concept'
    ? 'A concept’s prompt was typed, not derived, so it has no chunks. art.redraw rewrites it.'
    : 'The project no longer describes this asset, so its prompt cannot be re-derived.';
}

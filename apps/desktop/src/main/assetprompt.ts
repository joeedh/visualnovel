/**
 * The prompt an asset would be generated with *today*, re-derived from the current inputs.
 *
 * The planner does this on every pass and folds the result into the task hash, so an asset whose
 * recorded prompt no longer matches this one was rendered from words the project has since
 * changed — which is exactly what an art-notes edit produces, and the one thing the asset editor
 * has to be able to say out loud. Deliberately a re-derivation rather than a stored flag: the
 * builders are the authority on what a prompt is, and a flag would go stale the first time one
 * of them improved.
 */
import type { ProjectConfig } from '@vn/config';
import {
  buildLocationPrompt,
  buildModelSheetPrompt,
  buildPortraitPrompt,
  buildShotPrompt,
} from '@vn/pipeline';
import type { AnyTask, Asset, ProjectModel, Shot } from '@vn/types';

/** What the derivation needs beyond the asset: the model, the config, and the storyboards. */
export interface DerivePromptContext {
  model: ProjectModel;
  config: ProjectConfig;
  /** A scene's persisted shots, by scene id. A frame whose storyboard is gone derives nothing. */
  shots?: ReadonlyMap<string, readonly Shot[] | null>;
  /** The task that produced the asset — the only place a model sheet's angle is recorded. */
  task?: AnyTask;
}

/**
 * The prompt for `asset` as the builders would write it now, or `undefined` when the project no
 * longer describes this asset at all (its character was deleted, its storyboard is gone). Absent
 * is not "unchanged" — a caller comparing against the recorded prompt must treat it as unknown.
 */
export function derivePrompt(asset: Asset, ctx: DerivePromptContext): string | undefined {
  // A concept has no builder and no task: its prompt was a sentence somebody typed once, so there
  // is nothing to re-derive and it can never be stale.
  if (asset.kind === 'concept') return undefined;
  const binding = asset.satisfies[0];
  if (!binding) return undefined;

  switch (asset.kind) {
    case 'portrait': {
      const character = binding.characterId && ctx.model.characters.get(binding.characterId);
      return character ? buildPortraitPrompt(character, ctx.config) : undefined;
    }
    case 'model_sheet':
    case 'outfit_sheet': {
      const character = binding.characterId && ctx.model.characters.get(binding.characterId);
      const angle =
        ctx.task && 'angle' in ctx.task.inputs ? (ctx.task.inputs.angle as string) : undefined;
      if (!character || !binding.outfit || !angle) return undefined;
      return buildModelSheetPrompt(character, binding.outfit, angle, ctx.config);
    }
    case 'location_ref': {
      const location = binding.locationId && ctx.model.locations.get(binding.locationId);
      if (!location || !binding.variant) return undefined;
      return buildLocationPrompt(location, binding.variant, ctx.config);
    }
    case 'shot_image': {
      if (!binding.sceneId || !binding.shotId) return undefined;
      const scene = ctx.model.scenes.get(binding.sceneId);
      const shot = ctx.shots?.get(binding.sceneId)?.find((s) => s.id === binding.shotId);
      if (!scene || !shot) return undefined;
      return buildShotPrompt(shot, scene, ctx.model, ctx.config);
    }
  }
}

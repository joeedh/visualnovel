/**
 * The prompt an asset would be generated with now, re-derived from the current inputs.
 *
 * The planner derives the same prompt on every pass and folds it into the task hash, so an asset
 * whose recorded prompt no longer matches was rendered from words the project has since changed.
 * An art-notes edit produces exactly that, and the asset editor reports it. This is a
 * re-derivation rather than a stored flag because the builders are the authority on what a prompt
 * is, and a flag would go stale as soon as a builder changed.
 */
import type { ProjectConfig } from '@vn/config';
import {
  buildLocationChunks,
  buildModelSheetChunks,
  buildPortraitChunks,
  buildShotChunks,
  composePrompt,
  overrideOf,
} from '@vn/artgen';
import type { AnyTask, Asset, ProjectModel, PromptChunk, Shot } from '@vn/types';

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
 * The clauses `asset`'s prompt is built from now, or `undefined` on the same terms as
 * {@link derivePrompt}. The chunks come back in the builders' own order with no override applied;
 * `composePrompt` turns them into the text that would be sent.
 */
export function deriveChunks(asset: Asset, ctx: DerivePromptContext): PromptChunk[] | undefined {
  // A concept has no builder and no task. Its prompt was authored rather than derived, so there is
  // nothing to re-derive and it never goes stale
  if (asset.kind === 'concept') return undefined;
  const binding = asset.satisfies[0];
  if (!binding) return undefined;

  switch (asset.kind) {
    case 'portrait': {
      const character = binding.characterId && ctx.model.characters.get(binding.characterId);
      return character ? buildPortraitChunks(character, ctx.config) : undefined;
    }
    case 'model_sheet':
    case 'outfit_sheet': {
      const character = binding.characterId && ctx.model.characters.get(binding.characterId);
      const angle =
        ctx.task && 'angle' in ctx.task.inputs ? (ctx.task.inputs.angle as string) : undefined;
      if (!character || !binding.outfit || !angle) return undefined;
      return buildModelSheetChunks(character, binding.outfit, angle, ctx.config);
    }
    case 'location_ref': {
      const location = binding.locationId && ctx.model.locations.get(binding.locationId);
      if (!location || !binding.variant) return undefined;
      return buildLocationChunks(location, binding.variant, ctx.config);
    }
    case 'shot_image': {
      if (!binding.sceneId || !binding.shotId) return undefined;
      const scene = ctx.model.scenes.get(binding.sceneId);
      const shot = ctx.shots?.get(binding.sceneId)?.find((s) => s.id === binding.shotId);
      if (!scene || !shot) return undefined;
      return buildShotChunks(shot, scene, ctx.model, ctx.config);
    }
  }
}

/**
 * The prompt for `asset` as the builders would write it now, or `undefined` when the project no
 * longer describes this asset at all (its character was deleted, its storyboard is gone). A caller
 * comparing against the recorded prompt must read `undefined` as unknown rather than as unchanged.
 *
 * The author's override is included, because the planner folds it into the task hash. A derivation
 * that ignored the override would report every overridden asset as drifting from itself.
 */
export function derivePrompt(asset: Asset, ctx: DerivePromptContext): string | undefined {
  const chunks = deriveChunks(asset, ctx);
  if (!chunks) return undefined;
  return composePrompt(chunks, overrideOf(asset, ctx)).text;
}

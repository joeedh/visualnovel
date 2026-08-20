/**
 * Which rung owns a prompt, and what it currently says (`docs/plans/archive/chunked-prompts.md` §2).
 *
 * An override lives at exactly the rung that names one whole picture, so answering "which override
 * applies" is a lookup and never a merge chain. The builders resolve their own rung from the entity
 * they were already handed; this module is the other direction — from an **asset** back to the rung
 * that would be written — which is what a surface needs to show or edit one.
 */
import type { Asset, ProjectModel, PromptOverride, Shot } from '@vn/types';

/** The rung that owns one derived prompt. Character- and location-level rungs never hold one. */
export type PromptRung =
  | { kind: 'character'; characterId: string }
  | { kind: 'outfit'; characterId: string; outfit: string }
  | { kind: 'variant'; locationId: string; variant: string }
  | { kind: 'shot'; sceneId: string; shotId: string };

/** What a rung lookup reads: the model, plus the storyboards a shot rung lives in. */
export interface RungContext {
  model: ProjectModel;
  /** A scene's persisted shots, by scene id — the same shape `derivePrompt` takes. */
  shots?: ReadonlyMap<string, readonly Shot[] | null>;
}

/**
 * The rung an asset's prompt is overridden at, or `undefined` when it has none.
 *
 * A `concept`'s prompt was typed by a human in the first place — there is nothing derived under it
 * to override — and every other kind answers from its binding. A model sheet's angle is recorded
 * only on the task, so one rung covers all four angles of an outfit; that coarseness is deliberate
 * (§2), and the pane says so rather than the plan inventing a per-task home for one kind.
 */
export function rungOf(asset: Asset): PromptRung | undefined {
  const b = asset.satisfies[0];
  if (!b) return undefined;
  switch (asset.kind) {
    case 'portrait':
      return b.characterId ? { kind: 'character', characterId: b.characterId } : undefined;
    case 'model_sheet':
    case 'outfit_sheet':
      return b.characterId && b.outfit
        ? { kind: 'outfit', characterId: b.characterId, outfit: b.outfit }
        : undefined;
    case 'location_ref':
      return b.locationId && b.variant
        ? { kind: 'variant', locationId: b.locationId, variant: b.variant }
        : undefined;
    case 'shot_image':
      return b.sceneId && b.shotId
        ? { kind: 'shot', sceneId: b.sceneId, shotId: b.shotId }
        : undefined;
    default:
      return undefined;
  }
}

/** The override stored at a rung today, or `undefined` when the rung is unwritten or gone. */
export function overrideAt(rung: PromptRung, ctx: RungContext): PromptOverride | undefined {
  switch (rung.kind) {
    case 'character':
      return ctx.model.characters.get(rung.characterId)?.promptOverride;
    case 'outfit':
      return ctx.model.characters.get(rung.characterId)?.outfits.find((o) => o.id === rung.outfit)
        ?.promptOverride;
    case 'variant':
      return ctx.model.locations.get(rung.locationId)?.variants.find((v) => v.id === rung.variant)
        ?.promptOverride;
    case 'shot':
      return ctx.shots?.get(rung.sceneId)?.find((s) => s.id === rung.shotId)?.promptOverride;
  }
}

/** The override an asset's prompt would be composed with, in one call. */
export function overrideOf(asset: Asset, ctx: RungContext): PromptOverride | undefined {
  const rung = rungOf(asset);
  return rung && overrideAt(rung, ctx);
}

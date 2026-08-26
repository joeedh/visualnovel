/**
 * Outfit resolution — the one place the inheritance chain is written down.
 *
 * An outfit is optional at two levels, and an unspecified one is inherited rather than empty: a
 * shot subject's own `outfit` overrides the scene's `[[outfit: aiko=uniform]]` marker, which
 * overrides the character's `default_outfit`. Nothing else may re-derive that order — the prompt
 * builders, the planner and the desktop all come here.
 */
import type { Character, Scene, ShotSubject } from '@vn/types';

/**
 * Which level answered for a subject's outfit. The desktop shows it, because "the scene marker
 * did nothing" is otherwise indistinguishable from "the scene marker is what you are seeing".
 */
export type OutfitOrigin = 'shot' | 'scene' | 'default';

/** A resolved outfit: the id in force, and which level said so. */
export interface ResolvedOutfit {
  id: string;
  origin: OutfitOrigin;
}

/**
 * Resolves the outfit a subject wears in a scene, and which level answered. `character` may
 * be absent, because a shot can name a subject the model does not have. When it is absent,
 * only the two authored levels can answer, and the fallback is the literal `default`.
 */
export function outfitFor(
  subject: Pick<ShotSubject, 'characterId' | 'outfit'>,
  scene: Pick<Scene, 'outfits'> | undefined,
  character: Pick<Character, 'defaultOutfit'> | undefined,
): ResolvedOutfit {
  if (subject.outfit) return { id: subject.outfit, origin: 'shot' };
  const marked = scene?.outfits?.[subject.characterId];
  if (marked) return { id: marked, origin: 'scene' };
  return { id: character?.defaultOutfit ?? 'default', origin: 'default' };
}

/**
 * What a prompt says the character is wearing: the authored description when there is one, and
 * the outfit id when there is not. Falling back to the id costs a project that has never authored
 * a wardrobe nothing: the prompt, and so the task hash, is unchanged until an author describes
 * the clothes.
 */
export function outfitText(character: Character | undefined, outfitId: string): string {
  const described = character?.outfits.find((o) => o.id === outfitId)?.description.trim();
  return described || outfitId;
}

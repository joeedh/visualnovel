/** Outfit resolution: which outfit a subject wears in a scene, and which level said so. */
import { contract } from '@vn/contracts';
import type { Character, Scene, ShotSubject } from '@vn/types';

export const scriptOutfitInherited = contract({
  id      : 'script.outfitInherited',
  rule: "`outfitFor` alone resolves what a subject wears, in order: the shot subject's own `outfit`, then the scene's `[[outfit: id=outfit]]` marker, then the character's `default_outfit`. An absent field defers to the next level.",
  prevents:
    'The prompt builders, the planner and the desktop resolving an outfit in different orders, so a shot is drawn in one outfit while its reference sheet, or the surface describing it, names another.',
  subjects: [
    'module:packages/model/src/outfits.ts',
    'function:packages/model/src/outfits.ts#outfitFor',
    'function:packages/model/src/outfits.ts#outfitText',
    'function:packages/model/src/used.ts#usedOutfits',
    'function:packages/stills/src/storyboard.ts#deterministicShots',
  ],
  see     : ['docs/plans/archive/INDEX.md#outfits-at-scene-and-shot-level'],
  detail:
    'A `ShotSubject` with no `outfit` inherits, which is why `deterministicShots` and the ' +
    'decomposer emit shots without one. `ResolvedOutfit.origin` names the level that answered, so a ' +
    'surface can say which rather than "inherited". `outfitText` falls back to the outfit id when ' +
    'nothing describes the outfit, so a wardrobe can be named before it is described and an ' +
    'undescribed project keeps its prompts. An outfit edit re-renders, unlike other scene edits: ' +
    'the outfit is in `buildShotPrompt`, so a change re-keys exactly the shots it reaches. The sheet ' +
    "fan-out follows from the same function: `usedOutfits` is the character's default plus every " +
    "scene marker and shot override over live scenes, which is `outfitFor`'s range, so a " +
    'character no live scene casts plans no sheets and a shot cannot depend on a sheet nothing ' +
    "planned. A subject out of its default takes that outfit's front sheet as a reference (a frame " +
    'needs the clothes, not a turnaround), which reaches the planner a wave later, the way a shot ' +
    'waits on its plate.',
});

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

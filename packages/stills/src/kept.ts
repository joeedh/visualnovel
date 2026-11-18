/**
 * The slots whose art a collection keeps. `@vn/artgen`'s `planAssetCollection` reads the disk and
 * decides the rest.
 */
import { allCharacters, allLocationVariants } from '@vn/model';
import type { ProjectModel, RefBinding } from '@vn/types';
import { shotsOf } from '@vn/types';
import { MODEL_SHEET_ANGLES } from './prompts.js';

/**
 * Lists every slot the collector keeps art for. The list is wider than `buildSlotGraph`'s, so art
 * the planner has not reached yet is not lost. It holds the shots of every storyboard in the model's
 * production map, wired into the story or not, and sheets for every outfit a character defines or
 * anything names, cast or not.
 */
export function keptSlots(model: ProjectModel): RefBinding[] {
  const out: RefBinding[] = [];
  for (const [locationId, variants] of allLocationVariants(model)) {
    for (const variant of variants) out.push({ kind: 'plate', locationId, variant });
  }

  const outfits = new Map<string, Set<string>>();
  const wear = (characterId: string, outfit: string | undefined): void => {
    if (outfit === undefined || !model.characters.has(characterId)) return;
    const set = outfits.get(characterId) ?? new Set<string>();
    set.add(outfit);
    outfits.set(characterId, set);
  };
  for (const character of allCharacters(model)) {
    out.push({ kind: 'portrait', characterId: character.id });
    wear(character.id, character.defaultOutfit);
    for (const outfit of character.outfits) wear(character.id, outfit.id);
  }
  for (const scene of model.scenes.values()) {
    for (const [id, outfit] of Object.entries(scene.outfits ?? {})) wear(id, outfit);
    for (const shot of shotsOf(model, scene.id)) {
      for (const subject of shot.subjects) wear(subject.characterId, subject.outfit);
    }
  }
  for (const [characterId, set] of outfits) {
    for (const outfit of set) {
      for (const angle of MODEL_SHEET_ANGLES)
        out.push({ kind: 'sheet', characterId, outfit, angle });
    }
  }

  for (const [sceneId, board] of model.production) {
    for (const shot of board.shots) out.push({ kind: 'shot', sceneId, shotId: shot.id });
  }
  return out;
}

/**
 * What a run actually needs, enumerated from the model alone.
 *
 * These four answers used to be private to `planTasks`, which was fine while the planner was the
 * only thing that wanted them. It is not any more: the slot graph promises every picture the
 * project implies, and a promise the planner never plans is the one bug that shape of graph can
 * have. So the enumeration lives here, above both, and there is exactly one of it.
 *
 * All four are pure over a `ProjectModel` — no disk, no providers, no task graph.
 */
import type { Character, ProjectModel, Scene, Shot } from '@vn/types';

/** Reachable scenes only — never spend generation on unreachable branches. */
export function reachableScenes(model: ProjectModel): Scene[] {
  return [...model.scenes.values()].filter((s) => model.reachable.has(s.id));
}

/** Characters that appear in at least one reachable scene (everyone else is dead weight). */
export function usedCharacters(model: ProjectModel): Character[] {
  const ids = new Set<string>();
  for (const scene of reachableScenes(model)) for (const id of scene.characters) ids.add(id);
  return [...ids].map((id) => model.characters.get(id)).filter((c): c is Character => !!c);
}

/**
 * The outfits a run actually needs, character id → outfit ids in the order they were found: the
 * character's default first (anything with no opinion inherits it), then every `[[outfit:]]` marker
 * and shot override over reachable scenes. Authoring a wardrobe therefore costs nothing until
 * something puts a character in it — a sheet is three image calls per outfit.
 *
 * The set is exactly the range of `outfitFor` over this model, an id it does not author included:
 * `outfitText` falls back to the id for the sheet prompt just as it does for the shot's, so a shot
 * can never depend on a sheet nothing planned.
 *
 * `shots` overrides where the shot overrides are read from. The planner leaves it out and gets
 * `Scene.shots`, which it populates itself wave by wave; a caller holding the persisted
 * decompositions passes them instead and gets the whole answer at once.
 */
export function usedOutfits(
  model: ProjectModel,
  shots?: ReadonlyMap<string, readonly Shot[]>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (characterId: string, outfit: string | undefined): void => {
    const set = out.get(characterId) ?? new Set<string>();
    if (!out.has(characterId)) {
      // The default goes in first whoever asks, so a wardrobe-less project plans what it always did.
      const fallback = model.characters.get(characterId)?.defaultOutfit;
      if (fallback) set.add(fallback);
      out.set(characterId, set);
    }
    if (outfit) set.add(outfit);
  };

  for (const scene of reachableScenes(model)) {
    const marks = scene.outfits ?? {};
    // The cast, plus anyone a marker names who is not in it — a marker for someone the scene
    // forgot to list is still an outfit something asked for.
    for (const id of new Set([...scene.characters, ...Object.keys(marks)])) add(id, marks[id]);
    for (const shot of shots?.get(scene.id) ?? scene.shots) {
      for (const subject of shot.subjects) add(subject.characterId, subject.outfit);
    }
  }
  return out;
}

/** Locations referenced by a reachable scene, paired with the variants those scenes use. */
export function usedLocationVariants(model: ProjectModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const scene of reachableScenes(model)) {
    const location = model.locations.get(scene.location);
    if (!location) continue;
    const set = out.get(location.id) ?? new Set<string>();
    // Generate every declared variant for a used location so shots can pick any.
    for (const v of location.variants.length ? location.variants : [{ id: 'day' }]) set.add(v.id);
    out.set(location.id, set);
  }
  return out;
}

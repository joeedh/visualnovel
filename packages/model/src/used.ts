/**
 * What a run draws, enumerated from the model alone.
 *
 * These four answers used to be private to `planTasks`, which was fine while the planner was the
 * only thing that wanted them. The slot graph now promises every picture the project implies, and
 * a promise the planner never plans is the one bug that shape of graph can have, so the
 * enumeration lives here, above both callers, and there is exactly one of it.
 *
 * Two of them are scoped to the story and two to the sheets. A portrait and a plate are owed to
 * whoever authored one, because that is what an author asks the pipeline for first; a model sheet
 * is three image calls that exist to be referenced, so it waits for a scene to reference them.
 *
 * All four are pure over a `ProjectModel` — no disk, no providers, no task graph.
 */
import type { Character, Location, ProjectModel, Scene } from '@vn/types';
import { shotsOf } from '@vn/types';

/**
 * The scenes the narrative engine reports live, in the order the model holds them. Generation is
 * never spent on a scene that is not part of the story.
 */
export function liveScenes(model: ProjectModel): Scene[] {
  return [...model.scenes.values()].filter((s) => model.narrative.live(s.id));
}

/**
 * Every character the project authored, cast or not. A cast sheet exists to be looked at, so a
 * portrait is owed to whoever has one — an author draws the cast, then writes scenes for the cast
 * they have, and a character invisible until a scene names them has that backwards.
 *
 * Deliberately not the question the P3 gate asks. `gateStatus` keeps its own live-scene walk
 * so an uncast character's unapproved portrait halts nothing.
 */
export function allCharacters(model: ProjectModel): Character[] {
  return [...model.characters.values()];
}

/**
 * The outfits a run actually needs, character id → outfit ids in the order they were found: the
 * character's default first (anything with no opinion inherits it), then every `[[outfit:]]` marker
 * and shot override over live scenes. Authoring a wardrobe therefore costs nothing until
 * something puts a character in it — a sheet is three image calls per outfit.
 *
 * The set is exactly the range of `outfitFor` over this model, an id it does not author included:
 * `outfitText` falls back to the id for the sheet prompt just as it does for the shot's, so a shot
 * can never depend on a sheet nothing planned.
 *
 * The shot overrides are read from `model.production`. The planner's model holds the storyboards
 * it has populated wave by wave; a model filled from every persisted storyboard gets the whole
 * answer at once.
 */
export function usedOutfits(model: ProjectModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (characterId: string, outfit: string | undefined): void => {
    const set = out.get(characterId) ?? new Set<string>();
    if (!out.has(characterId)) {
      // The default goes in first for every caller, so a wardrobe-less project plans what it
      // always did.
      const fallback = model.characters.get(characterId)?.defaultOutfit;
      if (fallback) set.add(fallback);
      out.set(characterId, set);
    }
    if (outfit) set.add(outfit);
  };

  for (const scene of liveScenes(model)) {
    const marks = scene.outfits ?? {};
    // The cast, plus anyone a marker names who is not in it — a marker for someone the scene
    // forgot to list is still an outfit something asked for.
    for (const id of new Set([...scene.characters, ...Object.keys(marks)])) add(id, marks[id]);
    for (const shot of shotsOf(model, scene.id)) {
      for (const subject of shot.subjects) add(subject.characterId, subject.outfit);
    }
  }
  return out;
}

/**
 * Every authored location paired with every variant it declares, whether or not a scene sits there
 * yet — for the same reason as {@link allCharacters}. A location that declares no variants gets
 * `day`, so a plate is planned for it rather than nothing.
 */
export function allLocationVariants(model: ProjectModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Every declared variant, so a shot can pick any of them without a second wave
  for (const location of model.locations.values()) out.set(location.id, variantIds(location));
  return out;
}

/** Lists the variants a location has plates for: the ones it declares, else `day`. */
export function variantIds(location: Pick<Location, 'variants'>): Set<string> {
  return new Set(location.variants.length ? location.variants.map((v) => v.id) : ['day']);
}

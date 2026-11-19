import type { Character, Location, NarrativeStructure, ProjectModel, Scene } from '@vn/types';

/**
 * In-memory entity factories for unit tests of the pure planners, where building a project
 * on disk would be noise. Anything that asserts against generated state wants
 * {@link makeProject} instead — these produce a model, not a run.
 */

/**
 * A character with one default outfit, undescribed — exactly what `characterFromDoc` synthesizes
 * for a sheet with no `outfits:` map, so a prompt built from this says `wearing default`.
 * `palette` is fixed so prompt assertions can pin it.
 */
export function character(
  id: string,
  status: Character['status'] = 'draft',
  approvedPortrait?: string,
): Character {
  return {
    id,
    name       : id.toUpperCase(),
    description: `${id} description`,
    traits     : [],
    palette    : ['#112233'],
    status,
    defaultOutfit: 'default',
    outfits      : [{ id: 'default', characterId: id, description: '' }],
    approvedPortrait,
  };
}

/** A location with a single `day` variant. */
export function location(id: string): Location {
  return {
    id,
    name       : id,
    description: `${id} desc`,
    palette    : [],
    variants   : [{ id: 'day', description: '' }],
    mined      : false,
  };
}

/** A scene with a cast but no lines — enough to plan shots against; fill `lines` to cover. */
export function scene(id: string, characters: string[] = [], loc = 'classroom'): Scene {
  return { id, location: loc, characters, lines: [], choices: [] };
}

/**
 * A stand-in narrative for a model assembled by hand: `live` plays in that order, the first being
 * the entry, and `rest` are scenes the model holds outside the story.
 */
export function liveOnly(
  live: readonly string[],
  rest: readonly string[] = [],
): NarrativeStructure {
  const set = new Set(live);
  const order = [...live, ...rest];
  return {
    engine     : 'linear',
    entry      : live[0],
    scenes     : () => order,
    live       : (id) => set.has(id),
    exits: (id) => {
      const next = set.has(id) ? live[live.indexOf(id) + 1] : undefined;
      return { choices: [], ...(next === undefined ? {} : { next }) };
    },
    diagnostics: () => [],
  };
}

/** Assemble a model in which every scene is live and the first one is the entry. */
export function model(
  characters: Character[],
  scenes: Scene[],
  locations: Location[],
): ProjectModel {
  const ids = scenes.map((s) => s.id);
  return {
    title      : 'Test',
    characters : new Map(characters.map((c) => [c.id, c])),
    locations  : new Map(locations.map((l) => [l.id, l])),
    scenes     : new Map(scenes.map((s) => [s.id, s])),
    narrative  : liveOnly(ids),
    reachable  : new Set(ids),
    entry      : scenes[0]?.id,
    diagnostics: [],
    production : new Map(),
  };
}

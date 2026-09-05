import type { Character, Location, ProjectModel, Scene } from '@vn/types';

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
  return { id, location: loc, characters, lines: [], choices: [], shots: [] };
}

/** Assemble a model in which every scene is reachable and the first one is the entry. */
export function model(
  characters: Character[],
  scenes: Scene[],
  locations: Location[],
): ProjectModel {
  return {
    title      : 'Test',
    characters : new Map(characters.map((c) => [c.id, c])),
    locations  : new Map(locations.map((l) => [l.id, l])),
    scenes     : new Map(scenes.map((s) => [s.id, s])),
    reachable  : new Set(scenes.map((s) => s.id)),
    entry      : scenes[0]?.id,
    diagnostics: [],
  };
}

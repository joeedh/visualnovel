import type { Character, Diagnostic, Location, ProjectModel, Scene } from '@vn/types';
import {
  type EntityDoc,
  type FountainScript,
  type LoadedInputs,
  type SceneChunkDoc,
} from '@vn/parse';
import { characterFromDoc, locationFromDoc, sceneFromDoc } from './entities.js';
import { splitScenes, type MinedLocation } from './scenes.js';
import { computeReachable, successors } from './graph.js';
import { slug } from './slug.js';

/** Parsed input documents that the project model is assembled from (report §P0). */
export interface BuildInputs {
  title: string;
  characterDocs: EntityDoc[];
  locationDocs: EntityDoc[];
  /** Authored scene chunks — how a project on disk stores scenes, and what `loadInputs` reads. */
  sceneDocs?: SceneChunkDoc[];
  /**
   * A whole multi-scene screenplay instead, split by its `[[scene:]]` markers. No reader produces
   * one any more (`vngen import` converts a `screenplay/` project). It stays because Fountain is
   * still a form scenes can arrive in: a caller holding one string, and the tests that exercise
   * validation over a whole story, do not have to write chunks to disk first.
   */
  script?: FountainScript;
  /**
   * The entry scene from `project.yaml`'s `start:`. Required with `sceneDocs`, which have no
   * document order to fall back on; with `script` the first scene is the fallback.
   */
  start?: string;
  /** Diagnostics from reading the inputs, carried through so they are reported with the rest. */
  diagnostics?: Diagnostic[];
}

/** The scenes a build starts from, whichever form they were authored in. */
function readScenes(inputs: BuildInputs): {
  scenes: Scene[];
  mined: MinedLocation[];
  diagnostics: Diagnostic[];
} {
  if (!inputs.sceneDocs?.length) {
    return inputs.script ? splitScenes(inputs.script) : { scenes: [], mined: [], diagnostics: [] };
  }

  const scenes: Scene[] = [];
  const mined: MinedLocation[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const chunk of inputs.sceneDocs) {
    const res = sceneFromDoc(chunk.doc, chunk.id);
    if (!res.ok) {
      diagnostics.push(res.diagnostic);
      continue;
    }
    scenes.push(res.value.scene);
    mined.push(...res.value.mined);
    diagnostics.push(...res.value.diagnostics);
  }
  return { scenes, mined, diagnostics };
}

/**
 * The entry scene. A chunk project has no document order to fall back on, so a missing `start:`
 * is an error naming the fix rather than the scene whose filename sorts first, because an entry
 * chosen alphabetically moves silently the day a scene is renamed.
 */
function entryOf(
  inputs: BuildInputs,
  scenes: Map<string, Scene>,
  first: string | undefined,
  diagnostics: Diagnostic[],
): string | undefined {
  if (inputs.start === undefined) {
    if (!inputs.sceneDocs?.length) return first;
    if (scenes.size > 0) {
      diagnostics.push({
        severity: 'error',
        code    : 'missing_start',
        message: `project.yaml has no start:, and scenes/ has no order to take an entry scene from; add start: <scene id>`,
      });
    }
    return undefined;
  }
  if (!scenes.has(inputs.start)) {
    diagnostics.push({
      severity: 'error',
      code    : 'unknown_start',
      message : `project.yaml start: names unknown scene "${inputs.start}"`,
      where   : inputs.start,
    });
    return undefined;
  }
  return inputs.start;
}

function mergeMinedLocations(
  userLocations: Map<string, Location>,
  mined: MinedLocation[],
): Map<string, Location> {
  const variantsById = new Map<string, Set<string>>();
  const nameById = new Map<string, string>();
  for (const m of mined) {
    if (!variantsById.has(m.id)) variantsById.set(m.id, new Set());
    variantsById.get(m.id)!.add(m.variant);
    nameById.set(m.id, m.name);
  }

  const locations = new Map(userLocations);
  for (const [id, variants] of variantsById) {
    const existing = locations.get(id);
    if (existing) {
      const have = new Set(existing.variants.map((v) => v.id));
      for (const v of variants)
        if (!have.has(v)) existing.variants.push({ id: v, description: '' });
    } else {
      locations.set(id, {
        id,
        name       : nameById.get(id) ?? id,
        description: '',
        palette    : [],
        variants   : [...variants].map((v) => ({ id: v, description: '' })),
        mined      : true,
      });
    }
  }
  return locations;
}

/**
 * The id a file's name implies, against the id it declares. Entities are discovered by tag, so the
 * carried file is where an editor writes and the front-matter id is what the rest of the model
 * refers to; when they disagree, every path derived from the id points somewhere the entity is not.
 * The disagreement is reported and the entity is dropped, never resolved by picking one side,
 * matching how `sceneFromDoc` already treats the same disagreement for scenes.
 */
function idAgrees(
  kind: 'character' | 'location',
  declared: string,
  doc: EntityDoc,
  diagnostics: Diagnostic[],
): boolean {
  if (declared === doc.id) return true;
  diagnostics.push({
    severity: 'error',
    code    : 'entity_id_mismatch',
    message: `${doc.file} declares ${kind} id "${declared}" but its name says "${doc.id}"; the two must agree`,
    where   : doc.id,
  });
  return false;
}

/** Index character ids by their uppercased display name, for cue resolution. */
function nameIndex(characters: Map<string, Character>): Map<string, string> {
  const byName = new Map<string, string>();
  for (const c of characters.values()) byName.set(c.name.toUpperCase(), c.id);
  return byName;
}

/** Resolve a single uppercase Fountain cue name to a character id, or undefined. */
function cueToId(
  cue: string,
  characters: Map<string, Character>,
  byName: Map<string, string>,
): string | undefined {
  const baseName = cue
    .replace(/\([^)]*\)/g, '')
    .trim()
    .toUpperCase();
  return characters.has(slug(baseName)) ? slug(baseName) : byName.get(baseName);
}

/**
 * `reference_images:` was storage for a feature nothing ever read — no builder, no planner, no
 * provider — so a project that set it never saw an effect and there is nothing to convert. It is
 * named here, once, so an author who filled it in learns where those paths went.
 */
function retiredReferenceImages(id: string, data: Record<string, unknown>): Diagnostic | undefined {
  const paths = data['reference_images'];
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  return {
    severity: 'warning',
    code    : 'retired_reference_images',
    message:
      `character "${id}" sets reference_images (${paths.join(', ')}), which nothing has ever ` +
      `read; upload the files with \`asset.upload\` and attach them to a prompt clause instead`,
    where   : id,
  };
}

/** Resolve uppercase Fountain cue names to character ids; returns ids + diagnostics. */
function resolveCast(
  scene: Scene,
  characters: Map<string, Character>,
  byName: Map<string, string>,
): { ids: string[]; diagnostics: Diagnostic[] } {
  const ids: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const cue of scene.characters) {
    const id = cueToId(cue, characters, byName);
    if (id) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      diagnostics.push({
        severity: 'warning',
        code    : 'unknown_character',
        message : `scene "${scene.id}" references unknown character cue "${cue}"`,
        where   : scene.id,
      });
    }
  }
  return { ids, diagnostics };
}

/**
 * Check the scene's `[[outfit:]]` markers against the cast sheets, dropping any that name a
 * character the project does not have or an outfit that character has not authored. A dropped
 * marker fails safely: the shot falls back to the default and renders, where honouring the marker
 * would put a word in the prompt that nothing describes.
 */
function validateSceneOutfits(scene: Scene, characters: Map<string, Character>): Diagnostic[] {
  if (!scene.outfits) return [];
  const diagnostics: Diagnostic[] = [];
  const kept: Record<string, string> = {};
  for (const [characterId, outfit] of Object.entries(scene.outfits)) {
    const character = characters.get(characterId);
    if (!character) {
      diagnostics.push({
        severity: 'warning',
        code    : 'unknown_outfit_character',
        message: `[[outfit: ${characterId}=${outfit}]] in scene "${scene.id}" names no character; ignored`,
        where   : scene.id,
      });
      continue;
    }
    if (!character.outfits.some((o) => o.id === outfit)) {
      const has = character.outfits.map((o) => `"${o.id}"`).join(', ');
      diagnostics.push({
        severity: 'warning',
        code    : 'unknown_outfit',
        message: `scene "${scene.id}" puts "${characterId}" in "${outfit}", which they do not have (they have ${has}); ignored`,
        where   : scene.id,
      });
      continue;
    }
    kept[characterId] = outfit;
  }
  scene.outfits = Object.keys(kept).length > 0 ? kept : undefined;
  return diagnostics;
}

/**
 * Build and validate the in-memory project model (report §P0, §6). Validation never
 * throws — every problem is recorded as a `Diagnostic` so the caller can report all of
 * them before any money is spent on generation.
 */
export function buildModel(inputs: BuildInputs): ProjectModel {
  const diagnostics: Diagnostic[] = [...(inputs.diagnostics ?? [])];

  const characters = new Map<string, Character>();
  for (const doc of inputs.characterDocs) {
    const res = characterFromDoc(doc.doc);
    if (!res.ok) {
      diagnostics.push(res.diagnostic);
      continue;
    }
    if (!idAgrees('character', res.value.id, doc, diagnostics)) continue;
    const retired = retiredReferenceImages(res.value.id, doc.doc.data);
    if (retired) diagnostics.push(retired);
    if (characters.has(res.value.id)) {
      diagnostics.push({
        severity: 'error',
        code    : 'duplicate_character',
        message : `duplicate character id "${res.value.id}"`,
        where   : res.value.id,
      });
    }
    const c = res.value;
    // a wardrobe that omits the default outfit is a typo; the outfit is still synthesized (every
    // subject must have an outfit to resolve to), so this is only a warning
    if (c.outfits.length > 1 && !c.outfits.some((o) => o.description && o.id === c.defaultOutfit)) {
      diagnostics.push({
        severity: 'warning',
        code    : 'undescribed_default_outfit',
        message:
          `character "${c.id}" wears "${c.defaultOutfit}" by default, which its outfits map ` +
          `does not describe (it describes ${c.outfits.map((o) => `"${o.id}"`).join(', ')})`,
        where   : c.id,
      });
    }
    characters.set(c.id, c);
  }

  const userLocations = new Map<string, Location>();
  for (const doc of inputs.locationDocs) {
    const res = locationFromDoc(doc.doc);
    if (!res.ok) {
      diagnostics.push(res.diagnostic);
      continue;
    }
    if (!idAgrees('location', res.value.id, doc, diagnostics)) continue;
    userLocations.set(res.value.id, res.value);
  }

  const { scenes: sceneList, mined, diagnostics: sceneDiagnostics } = readScenes(inputs);
  diagnostics.push(...sceneDiagnostics);
  const locations = mergeMinedLocations(userLocations, mined);

  const byName = nameIndex(characters);
  const scenes = new Map<string, Scene>();
  for (const scene of sceneList) {
    if (scenes.has(scene.id)) {
      diagnostics.push({
        severity: 'error',
        code    : 'duplicate_scene',
        message : `duplicate scene id "${scene.id}"`,
        where   : scene.id,
      });
    }
    const cast = resolveCast(scene, characters, byName);
    scene.characters = cast.ids;
    // remap each line's speaker cue to a character id, by the same resolution the cast list uses,
    // keeping the raw cue when it resolves to nothing so a name still shows
    for (const line of scene.lines) {
      if (line.speaker) line.speaker = cueToId(line.speaker, characters, byName) ?? line.speaker;
    }
    diagnostics.push(...cast.diagnostics);
    diagnostics.push(...validateSceneOutfits(scene, characters));
    scenes.set(scene.id, scene);
  }

  const entry = entryOf(inputs, scenes, sceneList[0]?.id, diagnostics);
  const reachable = computeReachable(scenes, entry);

  // Validate edges and reachability.
  for (const scene of scenes.values()) {
    for (const next of successors(scene)) {
      if (!scenes.has(next)) {
        diagnostics.push({
          severity: 'error',
          code    : 'dangling_goto',
          message : `scene "${scene.id}" points to unknown scene "${next}"`,
          where   : scene.id,
        });
      }
    }
    if (!locations.has(scene.location)) {
      diagnostics.push({
        severity: 'error',
        code    : 'unknown_location',
        message : `scene "${scene.id}" references unknown location "${scene.location}"`,
        where   : scene.id,
      });
    }
    if (!reachable.has(scene.id)) {
      diagnostics.push({
        severity: 'warning',
        code    : 'unreachable_scene',
        message : `scene "${scene.id}" is unreachable from the entry scene`,
        where   : scene.id,
      });
    }
  }

  return { title: inputs.title, characters, locations, scenes, reachable, entry, diagnostics };
}

/**
 * Build the model from documents as read off disk. Every caller that loads a project (CLI,
 * desktop session, authoring workspace, testkit) goes through here, so a change to how authored
 * input becomes a model is one edit rather than four. Takes the config fields it needs, not a
 * `ProjectConfig`: `@vn/model` does not depend on `@vn/config`.
 */
export function modelFromInputs(
  inputs: LoadedInputs,
  opts: { title: string; start?: string },
): ProjectModel {
  return buildModel({
    title        : opts.title,
    start        : opts.start,
    characterDocs: inputs.characterDocs,
    locationDocs : inputs.locationDocs,
    sceneDocs    : inputs.sceneDocs,
    diagnostics  : inputs.diagnostics,
  });
}

/** True when the model has no error-severity diagnostics. */
export function isValid(model: ProjectModel): boolean {
  return !model.diagnostics.some((d) => d.severity === 'error');
}

/** All error-severity diagnostics. */
export function errors(model: ProjectModel): Diagnostic[] {
  return model.diagnostics.filter((d) => d.severity === 'error');
}

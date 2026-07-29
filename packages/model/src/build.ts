import type { Character, Diagnostic, Location, ProjectModel, Scene } from '@vn/types';
import {
  parseFountain,
  type FountainScript,
  type FrontMatterDoc,
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
  characterDocs: FrontMatterDoc[];
  locationDocs: FrontMatterDoc[];
  /** Authored scene chunks. When any are present `script` is ignored — the forms never mix. */
  sceneDocs?: SceneChunkDoc[];
  script: FountainScript;
  /**
   * The entry scene from `project.yaml`'s `start:`. Required with `sceneDocs`, which have no
   * document order to fall back on; honoured for a screenplay too, where the first scene is the
   * fallback.
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
  if (!inputs.sceneDocs?.length) return splitScenes(inputs.script);

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
 * is an error naming the fix rather than the scene whose filename sorts first — an entry chosen
 * by alphabetics is one that silently moves the day a scene is renamed.
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
        code: 'missing_start',
        message: `project.yaml has no start:, and scenes/ has no order to take an entry scene from; add start: <scene id>`,
      });
    }
    return undefined;
  }
  if (!scenes.has(inputs.start)) {
    diagnostics.push({
      severity: 'error',
      code: 'unknown_start',
      message: `project.yaml start: names unknown scene "${inputs.start}"`,
      where: inputs.start,
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
        name: nameById.get(id) ?? id,
        description: '',
        palette: [],
        variants: [...variants].map((v) => ({ id: v, description: '' })),
        mined: true,
      });
    }
  }
  return locations;
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
        code: 'unknown_character',
        message: `scene "${scene.id}" references unknown character cue "${cue}"`,
        where: scene.id,
      });
    }
  }
  return { ids, diagnostics };
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
    const res = characterFromDoc(doc);
    if (!res.ok) {
      diagnostics.push(res.diagnostic);
      continue;
    }
    if (characters.has(res.value.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate_character',
        message: `duplicate character id "${res.value.id}"`,
        where: res.value.id,
      });
    }
    characters.set(res.value.id, res.value);
  }

  const userLocations = new Map<string, Location>();
  for (const doc of inputs.locationDocs) {
    const res = locationFromDoc(doc);
    if (!res.ok) {
      diagnostics.push(res.diagnostic);
      continue;
    }
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
        code: 'duplicate_scene',
        message: `duplicate scene id "${scene.id}"`,
        where: scene.id,
      });
    }
    const cast = resolveCast(scene, characters, byName);
    scene.characters = cast.ids;
    // Remap each line's speaker cue to a resolved character id (keep the raw cue if unknown,
    // so a name still shows). Uses the same resolution as the cast above.
    for (const line of scene.lines) {
      if (line.speaker) line.speaker = cueToId(line.speaker, characters, byName) ?? line.speaker;
    }
    diagnostics.push(...cast.diagnostics);
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
          code: 'dangling_goto',
          message: `scene "${scene.id}" points to unknown scene "${next}"`,
          where: scene.id,
        });
      }
    }
    if (!locations.has(scene.location)) {
      diagnostics.push({
        severity: 'error',
        code: 'unknown_location',
        message: `scene "${scene.id}" references unknown location "${scene.location}"`,
        where: scene.id,
      });
    }
    if (!reachable.has(scene.id)) {
      diagnostics.push({
        severity: 'warning',
        code: 'unreachable_scene',
        message: `scene "${scene.id}" is unreachable from the entry scene`,
        where: scene.id,
      });
    }
  }

  return { title: inputs.title, characters, locations, scenes, reachable, entry, diagnostics };
}

/**
 * Build the model from documents as read off disk — the one place `parseFountain` and
 * `buildModel` are sequenced. Every caller that loads a project (CLI, desktop session,
 * authoring workspace, testkit) goes through here, so a change to how authored input becomes
 * a model is one edit rather than four. Takes the config fields it needs, not a
 * `ProjectConfig`: `@vn/model` does not depend on `@vn/config`.
 */
export function modelFromInputs(
  inputs: LoadedInputs,
  opts: { title: string; start?: string },
): ProjectModel {
  return buildModel({
    title: opts.title,
    start: opts.start,
    characterDocs: inputs.characterDocs,
    locationDocs: inputs.locationDocs,
    sceneDocs: inputs.sceneDocs,
    script: parseFountain(inputs.scriptText),
    diagnostics: inputs.diagnostics,
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

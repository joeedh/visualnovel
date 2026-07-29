import {
  characterFrontMatter,
  locationFrontMatter,
  sceneFrontMatter,
  type Character,
  type Diagnostic,
  type Location,
  type Outfit,
  type Scene,
} from '@vn/types';
import { parseFountain, type FrontMatterDoc } from '@vn/parse';
import { splitScenes, type MinedLocation } from './scenes.js';

/** A parsed entity, or the diagnostic explaining why a doc was rejected. */
export type EntityResult<T> = { ok: true; value: T } | { ok: false; diagnostic: Diagnostic };

/** Every issue a doc's front-matter produced, as one message. */
function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

/** Build a Character from a parsed `character.md` doc; body is the canonical description. */
export function characterFromDoc(doc: FrontMatterDoc): EntityResult<Character> {
  const parsed = characterFrontMatter.safeParse(doc.data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'character_frontmatter',
        message: issuesOf(parsed.error),
        where: typeof doc.data['id'] === 'string' ? (doc.data['id'] as string) : undefined,
      },
    };
  }
  const fm = parsed.data;
  const defaultOutfit: Outfit = {
    id: fm.default_outfit,
    characterId: fm.id,
    description: 'default outfit',
  };
  const character: Character = {
    id: fm.id,
    name: fm.name,
    description: doc.body.trim(),
    traits: fm.traits,
    palette: fm.palette,
    referenceImages: fm.reference_images,
    status: fm.status,
    defaultOutfit: fm.default_outfit,
    outfits: [defaultOutfit],
    approvedPortrait: fm.approved_portrait,
  };
  return { ok: true, value: character };
}

/** A scene chunk read back: the scene, what its heading mined, and what its marks got wrong. */
export interface LoadedScene {
  scene: Scene;
  /** Locations mined from the heading, as `splitScenes` reports them for a whole screenplay. */
  mined: MinedLocation[];
  /** Line-id problems and any ignored `[[scene:]]` marker; the scene is still usable. */
  diagnostics: Diagnostic[];
}

/**
 * Build a Scene from a parsed `scenes/<id>.md` doc, where `id` is the filename stem and is the
 * authority on the scene's identity. The body goes through the same `parseFountain` +
 * `splitScenes` the single-file form does, with the id forced, so line ids come out
 * `${id}:L<n>` and one parser stays responsible for both formats.
 */
export function sceneFromDoc(doc: FrontMatterDoc, id: string): EntityResult<LoadedScene> {
  const parsed = sceneFrontMatter.safeParse(doc.data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'scene_frontmatter',
        message: issuesOf(parsed.error),
        where: id,
      },
    };
  }
  if (parsed.data.scene !== id) {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'scene_id',
        message: `scenes/${id}.md declares scene "${parsed.data.scene}"; the filename and the scene: key must agree`,
        where: id,
      },
    };
  }

  const split = splitScenes(parseFountain(doc.body), { sceneId: id });
  const [scene] = split.scenes;
  if (!scene || split.scenes.length > 1) {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'scene_body',
        message: scene
          ? `scenes/${id}.md has ${split.scenes.length} scene headings; a chunk body is exactly one scene`
          : `scenes/${id}.md has no scene heading; a chunk body is one whole scene, heading included`,
        where: id,
      },
    };
  }
  return { ok: true, value: { scene, mined: split.mined, diagnostics: split.diagnostics } };
}

/** Build a user-authored Location from a parsed `locations/<id>.md` doc. */
export function locationFromDoc(doc: FrontMatterDoc): EntityResult<Location> {
  const parsed = locationFrontMatter.safeParse(doc.data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code: 'location_frontmatter',
        message: issuesOf(parsed.error),
        where: typeof doc.data['id'] === 'string' ? (doc.data['id'] as string) : undefined,
      },
    };
  }
  const fm = parsed.data;
  const location: Location = {
    id: fm.id,
    name: fm.name,
    description: doc.body.trim(),
    mood: fm.mood,
    lighting: fm.lighting,
    palette: fm.palette,
    variants: fm.variants.map((id) => ({ id, description: '' })),
    mined: false,
  };
  return { ok: true, value: location };
}

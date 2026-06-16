/**
 * Write-back / round-trip serialization (authoring-agent plan §5, M1). The readers in
 * `entities.ts` / `scenes.ts` turn authored files into entities; these functions are the
 * inverse, so the authoring agent can edit an entity and persist it without ever writing
 * malformed front-matter or Fountain. The contract is `fromDoc(toDoc(x)) ≡ x` for the
 * fields that survive a doc round-trip (proven by the property tests).
 *
 * Edits go through `apply*Edit`, which patches an *existing* doc — preserving untouched
 * front-matter keys and prose — and re-validates the result through the `@vn/types`
 * schemas before returning, so a bad edit fails loudly instead of being written.
 */
import type { Character, CharacterStatus, Location, Scene } from '@vn/types';
import { stringifyFrontMatter, type FrontMatterDoc } from '@vn/parse';
import { characterFromDoc, locationFromDoc, type EntityResult } from './entities.js';
import { slug } from './slug.js';

/** Drop `undefined` values so they never reach the YAML serializer as `null`. */
function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
}

/** Serialize a Character into a `character.md` doc (inverse of `characterFromDoc`). */
export function characterToDoc(character: Character): FrontMatterDoc {
  return {
    data: compact({
      id: character.id,
      name: character.name,
      status: character.status,
      default_outfit: character.defaultOutfit,
      traits: character.traits,
      palette: character.palette,
      reference_images: character.referenceImages,
      approved_portrait: character.approvedPortrait,
    }),
    body: character.description,
  };
}

/** Serialize a Location into a `locations/<id>.md` doc (inverse of `locationFromDoc`). */
export function locationToDoc(location: Location): FrontMatterDoc {
  return {
    data: compact({
      id: location.id,
      name: location.name,
      mood: location.mood,
      lighting: location.lighting,
      palette: location.palette,
      variants: location.variants.map((v) => v.id),
    }),
    body: location.description,
  };
}

/** Render a doc as the markdown file text it would be written to disk as. */
export function docToMarkdown(doc: FrontMatterDoc): string {
  return stringifyFrontMatter(doc.data, doc.body.trimStart());
}

/** A scene heading reconstructed from a location id (variant info is not on the Scene). */
function headingFor(scene: Scene): string {
  return `INT. ${scene.location.replace(/[-_]/g, ' ').toUpperCase()} - DAY`;
}

/**
 * Serialize a Scene back into a Fountain block: heading, the branch markers that carry
 * its id / choices / linear next, an optional synopsis, then the narrative body. Re-parsing
 * the result (`parseFountain` → `splitScenes`) recovers the scene's graph fields — id,
 * location, choices, next, synopsis (body/cast reconstruction is best-effort, since the
 * body is stored as flattened prose). Used for new-scene scaffolds and diff previews.
 */
export function sceneToFountain(scene: Scene): string {
  const lines: string[] = [headingFor(scene), ''];
  lines.push(`[[scene: ${scene.id}]]`);
  for (const choice of scene.choices) {
    lines.push(`[[choice: "${choice.label}" -> ${choice.goto}]]`);
  }
  if (scene.next) lines.push(`[[next: ${scene.next}]]`);
  lines.push('');
  if (scene.synopsis) {
    lines.push(`= ${scene.synopsis}`, '');
  }
  if (scene.body.trim()) lines.push(scene.body.trim(), '');
  return lines.join('\n');
}

/** A partial edit to a character; only the provided fields are changed. */
export interface CharacterEdit {
  name?: string;
  description?: string;
  status?: CharacterStatus;
  defaultOutfit?: string;
  traits?: string[];
  palette?: string[];
  referenceImages?: string[];
  approvedPortrait?: string;
}

/** A patched doc plus the entity it re-validated to. */
export interface AppliedEdit<T> {
  doc: FrontMatterDoc;
  value: T;
}

/**
 * Apply a partial edit to an existing `character.md` doc, re-validating the result. Unset
 * front-matter keys (including any the user added by hand) and the body are preserved
 * unless the edit names them. Returns the rejected diagnostic if the patch is invalid.
 */
export function applyCharacterEdit(
  doc: FrontMatterDoc,
  edit: CharacterEdit,
): EntityResult<AppliedEdit<Character>> {
  const data = { ...doc.data };
  if (edit.name !== undefined) data['name'] = edit.name;
  if (edit.status !== undefined) data['status'] = edit.status;
  if (edit.defaultOutfit !== undefined) data['default_outfit'] = edit.defaultOutfit;
  if (edit.traits !== undefined) data['traits'] = edit.traits;
  if (edit.palette !== undefined) data['palette'] = edit.palette;
  if (edit.referenceImages !== undefined) data['reference_images'] = edit.referenceImages;
  if (edit.approvedPortrait !== undefined) data['approved_portrait'] = edit.approvedPortrait;
  const body = edit.description !== undefined ? edit.description : doc.body;
  const next: FrontMatterDoc = { data, body };
  const res = characterFromDoc(next);
  if (!res.ok) return res;
  return { ok: true, value: { doc: next, value: res.value } };
}

/** A partial edit to a location; only the provided fields are changed. */
export interface LocationEdit {
  name?: string;
  description?: string;
  mood?: string;
  lighting?: string;
  palette?: string[];
  variants?: string[];
}

/** Apply a partial edit to an existing `locations/<id>.md` doc, re-validating the result. */
export function applyLocationEdit(
  doc: FrontMatterDoc,
  edit: LocationEdit,
): EntityResult<AppliedEdit<Location>> {
  const data = { ...doc.data };
  if (edit.name !== undefined) data['name'] = edit.name;
  if (edit.mood !== undefined) data['mood'] = edit.mood;
  if (edit.lighting !== undefined) data['lighting'] = edit.lighting;
  if (edit.palette !== undefined) data['palette'] = edit.palette;
  if (edit.variants !== undefined) data['variants'] = edit.variants;
  const body = edit.description !== undefined ? edit.description : doc.body;
  const next: FrontMatterDoc = { data, body };
  const res = locationFromDoc(next);
  if (!res.ok) return res;
  return { ok: true, value: { doc: next, value: res.value } };
}

/** Build a fresh character.md doc from minimal fields (new-character scaffold). */
export function newCharacterDoc(name: string, description = ''): FrontMatterDoc {
  return { data: compact({ id: slug(name), name }), body: description };
}

/** Build a fresh locations/<id>.md doc from minimal fields (new-location scaffold). */
export function newLocationDoc(name: string, description = ''): FrontMatterDoc {
  return { data: compact({ id: slug(name), name }), body: description };
}

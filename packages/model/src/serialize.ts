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
import type { Character, CharacterStatus, Location, LocationVariant, Scene } from '@vn/types';
import { stringifyFrontMatter, type FrontMatterDoc } from '@vn/parse';
import { characterFromDoc, locationFromDoc, type EntityResult } from './entities.js';
import { slug } from './slug.js';

/** Drop `undefined` values so they never reach the YAML serializer as `null`. */
function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
}

/**
 * The wardrobe as front-matter, or `undefined` when there is nothing to say — a lone default with
 * no description is what `characterFromDoc` synthesizes, so writing it back would grow a key in
 * every character sheet on its first edit.
 */
function wardrobeData(character: Character): Record<string, unknown> | undefined {
  const outfits = character.outfits;
  const synthesized =
    outfits.length === 1 &&
    outfits[0]?.id === character.defaultOutfit &&
    !outfits[0]?.description &&
    !outfits[0]?.artNotes;
  if (outfits.length === 0 || synthesized) return undefined;
  // The long form only when there is art direction to carry: a wardrobe that is descriptions
  // alone stays the one-line-per-outfit map it was authored as.
  return Object.fromEntries(
    outfits.map((o) => [
      o.id,
      o.artNotes === undefined
        ? o.description
        : compact({ description: o.description, art_notes: o.artNotes }),
    ]),
  );
}

/** A variant as front-matter: the bare id unless it has something more to say. */
function variantData(variant: LocationVariant): unknown {
  if (!variant.description && variant.artNotes === undefined) return variant.id;
  return compact({
    id: variant.id,
    description: variant.description || undefined,
    art_notes: variant.artNotes,
  });
}

/** Serialize a Character into a `character.md` doc (inverse of `characterFromDoc`). */
export function characterToDoc(character: Character): FrontMatterDoc {
  return {
    data: compact({
      id: character.id,
      name: character.name,
      status: character.status,
      default_outfit: character.defaultOutfit,
      outfits: wardrobeData(character),
      traits: character.traits,
      palette: character.palette,
      reference_images: character.referenceImages,
      art_notes: character.artNotes,
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
      variants: location.variants.map(variantData),
      art_notes: location.artNotes,
    }),
    body: location.description,
  };
}

/** Options for {@link sceneToFountain}. */
export interface SceneWriteOptions {
  /**
   * Write the `[[scene: id]]` marker (default true). A chunk file carries its id in
   * front-matter, so writing the marker as well would give one id two homes — and reading it
   * back warns, since the marker is the single-file form's mechanism.
   */
  sceneMarker?: boolean;
}

/** Render a doc as the markdown file text it would be written to disk as. */
export function docToMarkdown(doc: FrontMatterDoc): string {
  return stringifyFrontMatter(doc.data, doc.body.trimStart());
}

// Mirrors `SCENE_PREFIX` and the character-cue test in `@vn/parse`'s fountain.ts. Duplicated
// rather than exported from there for the same reason `branchpatch.ts` duplicates the first:
// this is one caller's need, and the parser is on the hot path for every consumer.
const SCENE_PREFIX = /^(int\.?\/ext\.?|int\.?|ext\.?|est\.?|i\/e)[ .]/i;
const CUE_SHAPE = /^[A-Z0-9][A-Z0-9 .'`-]*(\([^)]*\))?\s*\^?$/;

/** The local part of a composed `${sceneId}:L<n>` line id — what a `[[line:]]` mark carries. */
function localOf(id: string): string {
  const colon = id.lastIndexOf(':');
  return colon < 0 ? id : id.slice(colon + 1);
}

/**
 * The allocator to write when the scene carries none. Derived the way `splitScenes` derives
 * it — past every id in use — so a scene that has never been through a read still gets a mark
 * that cannot hand out an id twice.
 */
function nextLineIdOf(scene: Scene): number {
  let max = 0;
  for (const line of scene.lines) {
    const m = /^L(\d+)$/.exec(localOf(line.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Whether `text` would be read as a character cue rather than an action paragraph. */
function looksLikeCue(text: string): boolean {
  return CUE_SHAPE.test(text) && /[A-Z]/.test(text) && text === text.toUpperCase();
}

/**
 * Whether an action paragraph has to be forced with `!` to come back as itself. Every
 * alternative reading the parser has is tested, including the ones that also require a blank
 * line above: the surrounding blanks are this writer's to arrange, but a serializer that is
 * only correct because of its own layout breaks the moment anything reformats it.
 */
function needsForcedAction(text: string): boolean {
  const t = text.trim();
  if (t === '' || text.startsWith('!')) return true;
  if (/^[#=~>]/.test(t)) return true;
  if (t.startsWith('.') && !t.startsWith('..')) return true;
  if (SCENE_PREFIX.test(t)) return true;
  if (/[A-Z][A-Z ]*TO:$/.test(t)) return true;
  return looksLikeCue(t);
}

/** The scene heading, written from the fields the heading was read into. */
function headingOf(scene: Scene): string {
  const name = scene.location.replace(/[-_]/g, ' ').toUpperCase();
  const variant = (scene.locationVariant ?? 'day').replace(/[-_]/g, ' ').toUpperCase();
  // No prefix means the heading was forced, and a forced heading has to stay forced — without
  // the leading `.` the line is an action paragraph and the scene stops existing.
  const head = scene.headingPrefix ? `${scene.headingPrefix} ${name}` : `.${name}`;
  return `${head} - ${variant}`;
}

/**
 * Serialize a Scene back into a Fountain block, losslessly: `parse(write(scene)) ≡ scene` for
 * every field the model carries except `shots`, which is not serialized. The heading comes from
 * the scene's own heading fields — a heading reconstructed from the location slug alone is
 * wrong about the variant, and the variant is what the location plate is generated from.
 *
 * Line ids are written as `[[line:]]` marks and the allocator as `[[nextline:]]`, the same
 * placement `assignLineIds` uses, so a scene this wrote and a scene an author marked by hand
 * are the same file. A human-facing (unmarked) rendering is a separate concern.
 *
 * Three blank-line rules govern the body, because `parseFountain` tests blankness on the *raw*
 * line and a `[[…]]` marker line is not blank:
 *
 * - a cue always gets a blank line above it, including as the scene's first element;
 * - nothing goes between a cue and its first dialogue line except a `[[line:]]` mark;
 * - anything that could be read as another element is written in its forced form.
 */
export function sceneToFountain(scene: Scene, opts: SceneWriteOptions = {}): string {
  const out: string[] = [headingOf(scene), ''];
  if (opts.sceneMarker !== false) out.push(`[[scene: ${scene.id}]]`);
  for (const choice of scene.choices) {
    out.push(`[[choice: "${choice.label}" -> ${choice.goto}]]`);
  }
  if (scene.next) out.push(`[[next: ${scene.next}]]`);
  for (const [characterId, outfit] of Object.entries(scene.outfits ?? {})) {
    out.push(`[[outfit: ${characterId}=${outfit}]]`);
  }
  out.push(`[[nextline: ${scene.nextLineId ?? nextLineIdOf(scene)}]]`, '');
  if (scene.synopsis) out.push(`= ${scene.synopsis}`, '');

  /** Open a new block: everything but a continuing dialogue line needs a blank line above. */
  const gap = (): void => {
    if (out[out.length - 1] !== '') out.push('');
  };
  let openSpeaker: string | undefined;

  for (const line of scene.lines) {
    const mark = `[[line: ${localOf(line.id)}]]`;
    const attributed = line.kind === 'dialogue' || line.kind === 'parenthetical';
    if (attributed && line.speaker !== undefined) {
      if (line.speaker !== openSpeaker) {
        gap();
        // A mixed-case speaker is not a cue by the auto-detection rules; `@` forces it.
        out.push(looksLikeCue(line.speaker) ? line.speaker : `@${line.speaker}`);
        openSpeaker = line.speaker;
      }
      out.push(mark, line.kind === 'parenthetical' ? `(${line.text})` : line.text);
      continue;
    }

    openSpeaker = undefined;
    gap();
    out.push(mark);
    if (line.kind === 'transition') {
      // Always the forced `>` form: the unforced `CUT TO:` needs a blank line above it, and
      // the line's own `[[line:]]` mark is sitting there.
      out.push(`>${line.text}`);
    } else if (line.kind === 'lyric') {
      out.push(`~${line.text}`);
    } else if (line.kind === 'centered') {
      out.push(`>${line.text}<`);
    } else {
      // An unattributed dialogue/parenthetical is unreachable from `parseFountain` — both live
      // inside a block a cue opened — so it falls here with the narration.
      const text = line.kind === 'parenthetical' ? `(${line.text})` : line.text;
      out.push(needsForcedAction(text) ? `!${text}` : text);
    }
  }

  gap();
  return out.join('\n');
}

/**
 * Serialize a Scene into a `scenes/<id>.md` doc (inverse of `sceneFromDoc`). Front-matter is
 * the scene's id and nothing else; every other field is written into the Fountain body, where
 * `sceneToFountain` already puts it losslessly.
 */
export function sceneToDoc(scene: Scene): FrontMatterDoc {
  return { data: { scene: scene.id }, body: sceneToFountain(scene, { sceneMarker: false }) };
}

/** A partial edit to a character; only the provided fields are changed. */
export interface CharacterEdit {
  name?: string;
  description?: string;
  status?: CharacterStatus;
  defaultOutfit?: string;
  /**
   * Replaces the whole wardrobe map, outfit id → description, or → `{description, art_notes}`
   * for an outfit with art direction of its own.
   */
  outfits?: Record<string, string | { description?: string; art_notes?: string }>;
  traits?: string[];
  palette?: string[];
  referenceImages?: string[];
  /** Art direction for every prompt this character reaches; `''` clears it. */
  artNotes?: string;
  approvedPortrait?: string;
}

/** Write an optional string field, or remove the key when the edit clears it to empty. */
function setOrClear(data: Record<string, unknown>, key: string, value: string): void {
  if (value) data[key] = value;
  else delete data[key];
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
  if (edit.outfits !== undefined) data['outfits'] = edit.outfits;
  if (edit.traits !== undefined) data['traits'] = edit.traits;
  if (edit.palette !== undefined) data['palette'] = edit.palette;
  if (edit.referenceImages !== undefined) data['reference_images'] = edit.referenceImages;
  if (edit.artNotes !== undefined) setOrClear(data, 'art_notes', edit.artNotes);
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
  /** Replaces the whole variant list; an entry may be a bare id or the long form. */
  variants?: (string | { id: string; description?: string; art_notes?: string })[];
  /** Art direction for every plate of this location; `''` clears it. */
  artNotes?: string;
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
  if (edit.artNotes !== undefined) setOrClear(data, 'art_notes', edit.artNotes);
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

import type {
  AssetRef,
  Character,
  ImageParams,
  Location,
  ProjectModel,
  PromptChunk,
  PromptOverride,
  Scene,
  Shot,
  Task,
  TaskInputs,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { outfitFor, outfitText } from '@vn/model';
import { makeTask } from '@vn/taskgraph';
import { chunk, chunkList, composePrompt } from './chunks.js';
import { authoredRefs } from './refs.js';

/**
 * The angles a model sheet is generated at once a character is approved (report §P4). Here rather
 * than in the planner because it is part of what a sheet *is*: the cycle walk and adoption both
 * have to name an angle, and three spellings of one list is how a shot ends up referencing a sheet
 * nothing planned.
 */
export const MODEL_SHEET_ANGLES = ['front', 'side', 'back'] as const;

/** The angle a shot references. One, not three: a frame needs the clothes, not a turnaround. */
export const SHEET_FRONT = MODEL_SHEET_ANGLES[0];

/** Image params derived from project config + the configured image model id. */
export function imageParams(config: ProjectConfig): ImageParams {
  return {
    modelId: config.models.image,
    aspect: config.image_params.aspect,
    seed: config.image_params.seed,
  };
}

/**
 * `params` with the narrowest authored seed applied — the only place that chain is written down.
 *
 * Rungs are passed widest-first (character then outfit; location then variant; a shot alone) and
 * the last one that authored a seed wins, falling back to `config.image_params.seed`. A rung that
 * authored none returns `params` untouched, so every existing task keeps the hash it had — the
 * same guarantee {@link artClause} gives.
 *
 * Every builder below calls it, so the planner, adoption and `promoteConcept` all agree without
 * each having to know the chain — a disagreement here strands a shot on a plate nothing planned.
 */
export function seedFor(params: ImageParams, ...rungs: (number | undefined)[]): ImageParams {
  const authored = rungs.filter((s): s is number => s !== undefined).at(-1);
  return authored === undefined ? params : { ...params, seed: authored };
}

/** The art-style preamble injected into every image prompt for style consistency (§5). */
export function stylePreamble(config: ProjectConfig): string {
  const style = config.art_style.trim();
  return style ? `Art style: ${style}.` : 'Art style: clean modern visual-novel illustration.';
}

/** `Palette: a, b.` — exported so a concept grounds itself in the same words a plate does. */
export function paletteClause(palette: string[]): string {
  return palette.length ? ` Palette: ${palette.join(', ')}.` : '';
}

/**
 * Authored art direction, in order from the widest rung to the narrowest. Appended to the derived
 * prompt rather than replacing it — the style preamble, the reference instructions and the closing
 * framing sentence are what keep a generation on-model, and a hand-written prompt would freeze this
 * asset against every later improvement to the builders. Empty notes add nothing, which is what
 * keeps every existing task hash exactly where it was.
 */
export function artClause(...notes: (string | undefined)[]): string {
  const said = notes.map((n) => n?.trim()).filter((n): n is string => !!n);
  return said.length ? `Art direction: ${said.join(' ')}` : '';
}

/**
 * P3 portrait chunks: one chunk per clause the builder has always assembled (report §P3).
 *
 * The one-slot-one-chunk rule is not a style preference — splitting a clause in two would change
 * the rendered string and re-key every task in every existing project.
 */
export function buildPortraitChunks(character: Character, config: ProjectConfig): PromptChunk[] {
  const id = character.id;
  return chunkList(
    chunk('style', 'style', stylePreamble(config), { kind: 'project', field: 'art_style' }),
    chunk('subject', 'subject', `Character portrait of ${character.name}.`, {
      kind: 'character',
      id,
      field: 'name',
    }),
    chunk('description', 'description', character.description, {
      kind: 'character',
      id,
      field: 'description',
    }),
    chunk('palette', 'palette', paletteClause(character.palette), {
      kind: 'character',
      id,
      field: 'palette',
    }),
    chunk('art-notes', 'art-notes', artClause(character.artNotes), {
      kind: 'art-notes',
      target: `character:${id}`,
    }),
    chunk(
      'scaffolding',
      'scaffolding',
      'Neutral pose and expression, plain neutral background, head-and-shoulders framing.',
      { kind: 'builder' },
    ),
  );
}

/**
 * P3 portrait prompt: neutral pose/expression, plain background (report §P3).
 *
 * The override defaults to the one stored at this prompt's own rung (§2), so every existing caller
 * — the planner, the desktop's re-derivation — gets the authored answer without passing anything.
 * `override` is the preview seam: a surface showing what a not-yet-saved edit *would* send passes a
 * candidate here rather than writing it first. A project authoring none renders the derived chunks,
 * character for character as before.
 */
export function buildPortraitPrompt(
  character: Character,
  config: ProjectConfig,
  override?: PromptOverride,
): string {
  return composePrompt(buildPortraitChunks(character, config), override ?? character.promptOverride)
    .text;
}

/**
 * The reference images an author attached to this prompt, to be appended **after** whatever the
 * planner derived (§12). A sibling of each `build*Prompt` rather than a call the planner assembles,
 * for the same reason the override is: a caller cannot forget what it never passes.
 */
export function portraitRefs(
  character: Character,
  config: ProjectConfig,
  override?: PromptOverride,
): AssetRef[] {
  return authoredRefs(buildPortraitChunks(character, config), override ?? character.promptOverride);
}

/**
 * One portrait task's inputs. Beside {@link locationInputs} for the reason that one exists: the
 * planner fans these out and adoption re-derives them, and a helper each computes from is the only
 * way the two cannot disagree about a hash.
 */
export function portraitInputs(
  character: Character,
  config: ProjectConfig,
  params: ImageParams,
): TaskInputs['portrait'] {
  return {
    characterId: character.id,
    prompt: buildPortraitPrompt(character, config),
    refs: portraitRefs(character, config),
    // A portrait is the character rung and nothing narrower — it wears no outfit of its own.
    params: seedFor(params, character.seed),
  };
}

/** P2 location plate chunks for one time-of-day/weather variant (report §P2). */
export function buildLocationChunks(
  location: Location,
  variant: string,
  config: ProjectConfig,
): PromptChunk[] {
  // The variant is named by id here, and the id is all a plain `- night` entry says; a variant
  // that describes itself or carries art direction is looked up rather than passed in.
  const authored = location.variants.find((v) => v.id === variant);
  const id = location.id;
  return chunkList(
    chunk('style', 'style', stylePreamble(config), { kind: 'project', field: 'art_style' }),
    chunk('subject', 'subject', `Establishing shot of ${location.name}.`, {
      kind: 'location',
      id,
      field: 'name',
    }),
    chunk('description', 'description', location.description, {
      kind: 'location',
      id,
      field: 'description',
    }),
    chunk('mood', 'mood', location.mood ? `Mood: ${location.mood}.` : '', {
      kind: 'location',
      id,
      field: 'mood',
    }),
    chunk('variant', 'variant', `Time of day / condition: ${variant}.`, {
      kind: 'variant',
      id,
      variant,
    }),
    chunk('variant-desc', 'variant', authored?.description, { kind: 'variant', id, variant }),
    chunk('palette', 'palette', paletteClause(location.palette), {
      kind: 'location',
      id,
      field: 'palette',
    }),
    // One chunk even though two rungs feed it: `artClause` emits a single `Art direction:`
    // sentence, and two chunks would emit the prefix twice. The variant rung rides along as
    // `also`, so a card can still name where the narrower half came from.
    chunk(
      'art-notes',
      'art-notes',
      artClause(location.artNotes, authored?.artNotes),
      { kind: 'art-notes', target: `location:${id}` },
      authored?.artNotes ? { kind: 'art-notes', target: `location:${id}/${variant}` } : undefined,
    ),
    chunk('scaffolding', 'scaffolding', 'No characters, no text.', { kind: 'builder' }),
  );
}

/** P2 location reference prompt for a specific time-of-day/weather variant (report §P2). */
export function buildLocationPrompt(
  location: Location,
  variant: string,
  config: ProjectConfig,
  override?: PromptOverride,
): string {
  // Per-variant, so the plate's rung is the variant entry — a location-level override would be
  // read by nothing, which is why there is no such field.
  const stored = location.variants.find((v) => v.id === variant)?.promptOverride;
  return composePrompt(buildLocationChunks(location, variant, config), override ?? stored).text;
}

/** {@link portraitRefs} for a plate. */
export function locationRefs(
  location: Location,
  variant: string,
  config: ProjectConfig,
  override?: PromptOverride,
): AssetRef[] {
  const stored = location.variants.find((v) => v.id === variant)?.promptOverride;
  return authoredRefs(buildLocationChunks(location, variant, config), override ?? stored);
}

/**
 * One plate task. Built in three places — P2 fans them out, a shot names its plate as a ref, and
 * `promoteConcept` adopts one — so the identity is written down here rather than three times; a
 * disagreement would strand the shot on a hash nothing planned.
 */
export function locationInputs(
  location: Location,
  variant: string,
  config: ProjectConfig,
  params: ImageParams,
): TaskInputs['location_ref'] {
  return {
    locationId: location.id,
    variant,
    prompt: buildLocationPrompt(location, variant, config),
    refs: locationRefs(location, variant, config),
    params: seedFor(params, location.seed, location.variants.find((v) => v.id === variant)?.seed),
  };
}

/** {@link locationInputs} hashed. Adoption takes the inputs instead — it may not be given a hash. */
export function locationTask(
  location: Location,
  variant: string,
  config: ProjectConfig,
  params: ImageParams,
): Task<'location_ref'> {
  return makeTask('location_ref', locationInputs(location, variant, config, params));
}

/** P4 model-sheet chunks for one angle, derived from the approved portrait (report §P4). */
export function buildModelSheetChunks(
  character: Character,
  outfit: string,
  angle: string,
  config: ProjectConfig,
): PromptChunk[] {
  const id = character.id;
  const worn = character.outfits.find((o) => o.id === outfit);
  return chunkList(
    chunk('style', 'style', stylePreamble(config), { kind: 'project', field: 'art_style' }),
    // There is no `wardrobe` chunk: the builder puts the outfit *inside* the subject sentence, and
    // splitting it out would change this prompt for every project and re-key every sheet task. The
    // outfit rides along as a second source instead, so a card can still name the rung.
    chunk(
      'subject',
      'subject',
      `Full-body ${angle} view of ${character.name} wearing ${outfitText(character, outfit)}.`,
      { kind: 'character', id, field: 'name' },
      { kind: 'outfit', id, outfit },
    ),
    chunk(
      'reference',
      'scaffolding',
      'Preserve the exact face and look from the reference image.',
      {
        kind: 'builder',
      },
    ),
    chunk('description', 'description', character.description, {
      kind: 'character',
      id,
      field: 'description',
    }),
    chunk('palette', 'palette', paletteClause(character.palette), {
      kind: 'character',
      id,
      field: 'palette',
    }),
    chunk(
      'art-notes',
      'art-notes',
      artClause(character.artNotes, worn?.artNotes),
      { kind: 'art-notes', target: `character:${id}` },
      worn?.artNotes ? { kind: 'art-notes', target: `character:${id}/${outfit}` } : undefined,
    ),
    chunk(
      'scaffolding',
      'scaffolding',
      'Neutral background, consistent lighting, turnaround model-sheet style.',
      { kind: 'builder' },
    ),
  );
}

/** P4 model-sheet prompt for one angle, derived from the approved portrait (report §P4). */
export function buildModelSheetPrompt(
  character: Character,
  outfit: string,
  angle: string,
  config: ProjectConfig,
  override?: PromptOverride,
): string {
  // The angle is recorded on the task alone, so the outfit's override covers all four sheets. A
  // known coarseness (§2), stated on the card rather than fixed by a per-task override home.
  const stored = character.outfits.find((o) => o.id === outfit)?.promptOverride;
  return composePrompt(buildModelSheetChunks(character, outfit, angle, config), override ?? stored)
    .text;
}

/** {@link portraitRefs} for a model sheet — one rung, so all four angles get the same references. */
export function modelSheetRefs(
  character: Character,
  outfit: string,
  angle: string,
  config: ProjectConfig,
  override?: PromptOverride,
): AssetRef[] {
  const stored = character.outfits.find((o) => o.id === outfit)?.promptOverride;
  return authoredRefs(buildModelSheetChunks(character, outfit, angle, config), override ?? stored);
}

/**
 * One model-sheet task's inputs. The approved portrait is passed in rather than read off the
 * character, because a sheet derives from the portrait *the caller resolved* — and it leads the
 * refs: arrays are positional in the hash, so this is the one order that leaves a project
 * authoring no references byte-identical (§12).
 */
export function modelSheetInputs(
  character: Character,
  outfit: string,
  angle: string,
  portrait: AssetRef,
  config: ProjectConfig,
  params: ImageParams,
): TaskInputs['model_sheet'] {
  return {
    characterId: character.id,
    outfit,
    angle,
    prompt: buildModelSheetPrompt(character, outfit, angle, config),
    refs: [portrait, ...modelSheetRefs(character, outfit, angle, config)],
    // The angle is not a rung, so one outfit seed covers all four sheets — as its notes do.
    params: seedFor(params, character.seed, character.outfits.find((o) => o.id === outfit)?.seed),
  };
}

/** P6 shot chunks, synthesized from the terse shot description + entities (report §P6). */
export function buildShotChunks(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
): PromptChunk[] {
  const location = model.locations.get(scene.location);
  const subjects = shot.subjects.map((s) => {
    const character = model.characters.get(s.characterId);
    const name = character?.name ?? s.characterId;
    const bits = [name, `wearing ${outfitText(character, outfitFor(s, scene, character).id)}`];
    if (s.pose) bits.push(`pose: ${s.pose}`);
    if (s.expression) bits.push(`expression: ${s.expression}`);
    return bits.join(', ');
  });
  const at = { sceneId: shot.sceneId, shotId: shot.id } as const;
  return chunkList(
    chunk('style', 'style', stylePreamble(config), { kind: 'project', field: 'art_style' }),
    chunk(
      'framing',
      'framing',
      `${shot.framing} shot${location ? ` in ${location.name}` : ''} (${shot.location}).`,
      { kind: 'shot', ...at, field: 'framing' },
    ),
    chunk(
      'subject',
      'subject',
      subjects.length ? `Subjects: ${subjects.join('; ')}.` : 'No characters in frame.',
      { kind: 'shot', ...at, field: 'subjects' },
    ),
    chunk('camera', 'camera', shot.camera ? `Camera: ${shot.camera}.` : '', {
      kind: 'shot',
      ...at,
      field: 'camera',
    }),
    // The shot's own notes only. A character's and a location's reach this frame through the
    // sheets and plates it references, which were generated with them; saying them again here
    // would double the voice.
    chunk('art-notes', 'art-notes', artClause(shot.artNotes), {
      kind: 'art-notes',
      target: `shot:${shot.sceneId}/${shot.id}`,
    }),
    chunk('scaffolding', 'scaffolding', 'Render as a single illustrated frame, no UI text.', {
      kind: 'builder',
    }),
  );
}

/** P6 shot prompt synthesis from the terse shot description + entities (report §P6). */
export function buildShotPrompt(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
  override?: PromptOverride,
): string {
  return composePrompt(buildShotChunks(shot, scene, model, config), override ?? shot.promptOverride)
    .text;
}

/** {@link portraitRefs} for a shot frame. */
export function shotRefs(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
  override?: PromptOverride,
): AssetRef[] {
  return authoredRefs(buildShotChunks(shot, scene, model, config), override ?? shot.promptOverride);
}

/**
 * One shot task's inputs. `upstream` is what the caller resolved and this cannot — the plate the
 * shot is set in and the portrait/sheet of each subject — and it leads the refs, with the authored
 * ones appended after, the order the hash has always seen (§12).
 */
export function shotInputs(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
  params: ImageParams,
  upstream: AssetRef[],
): TaskInputs['shot_image'] {
  return {
    shotId: shot.id,
    prompt: buildShotPrompt(shot, scene, model, config),
    refs: [...upstream, ...shotRefs(shot, scene, model, config)],
    // A frame is its own rung: the cast it draws is carried in as references, not as a seed.
    params: seedFor(params, shot.seed),
  };
}

/**
 * What this shot is meant to depict: its own framing and cast first, the prose of the lines
 * it covers as context.
 *
 * Deliberately *not* the scene synopsis. A scene describes action no single shot is
 * responsible for, so a reviewer handed it flags every shot for the characters the scene
 * mentions but the shot never ordered — and since a background plate can never satisfy that,
 * the refine loop cannot converge and burns every attempt. `characters` is the authority on
 * who must be in frame, and the description says so out loud.
 */
function shotDescription(shot: Shot, scene: Scene): string {
  const covered = shot.coversLines.length
    ? scene.lines.filter((l) => shot.coversLines.includes(l.id))
    : [];
  const prose = covered.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join(' ');
  return [
    `A single ${shot.framing} shot set in ${shot.location}.`,
    shot.subjects.length
      ? `Characters that must be in frame: ${shot.subjects.map((s) => s.characterId).join(', ')}.`
      : 'This is a background plate: no characters are intended in frame, and their absence is not a defect.',
    shot.camera ? `Camera: ${shot.camera}.` : '',
    prose ? `Narrative context, for setting and mood only: ${prose}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A reviewer-facing spec for a shot (report §P7). `model` is what lets the outfit resolve all the
 * way down to the character's default; without it only the two authored levels can answer.
 */
export function shotSpec(
  shot: Shot,
  scene: Scene,
  model?: ProjectModel,
): {
  description: string;
  characters: string[];
  outfit?: string;
  location: string;
  expression?: string;
  framing?: string;
} {
  const lead = shot.subjects[0];
  return {
    description: shotDescription(shot, scene),
    characters: shot.subjects.map((s) => s.characterId),
    outfit: lead && outfitFor(lead, scene, model?.characters.get(lead.characterId)).id,
    location: shot.location,
    expression: shot.subjects[0]?.expression,
    framing: shot.framing,
  };
}

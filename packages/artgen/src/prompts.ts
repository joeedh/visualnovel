import type { Character, ImageParams, Location, ProjectModel, Scene, Shot } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { outfitFor, outfitText } from '@vn/model';

/** Image params derived from project config + the configured image model id. */
export function imageParams(config: ProjectConfig): ImageParams {
  return {
    modelId: config.models.image,
    aspect: config.image_params.aspect,
    seed: config.image_params.seed,
  };
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

/** P3 portrait prompt: neutral pose/expression, plain background (report §P3). */
export function buildPortraitPrompt(character: Character, config: ProjectConfig): string {
  return [
    stylePreamble(config),
    `Character portrait of ${character.name}.`,
    character.description,
    paletteClause(character.palette),
    artClause(character.artNotes),
    'Neutral pose and expression, plain neutral background, head-and-shoulders framing.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** P2 location reference prompt for a specific time-of-day/weather variant (report §P2). */
export function buildLocationPrompt(
  location: Location,
  variant: string,
  config: ProjectConfig,
): string {
  // The variant is named by id here, and the id is all a plain `- night` entry says; a variant
  // that describes itself or carries art direction is looked up rather than passed in.
  const authored = location.variants.find((v) => v.id === variant);
  return [
    stylePreamble(config),
    `Establishing shot of ${location.name}.`,
    location.description,
    location.mood ? `Mood: ${location.mood}.` : '',
    `Time of day / condition: ${variant}.`,
    authored?.description ?? '',
    paletteClause(location.palette),
    artClause(location.artNotes, authored?.artNotes),
    'No characters, no text.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** P4 model-sheet prompt for one angle, derived from the approved portrait (report §P4). */
export function buildModelSheetPrompt(
  character: Character,
  outfit: string,
  angle: string,
  config: ProjectConfig,
): string {
  return [
    stylePreamble(config),
    `Full-body ${angle} view of ${character.name} wearing ${outfitText(character, outfit)}.`,
    'Preserve the exact face and look from the reference image.',
    character.description,
    paletteClause(character.palette),
    artClause(character.artNotes, character.outfits.find((o) => o.id === outfit)?.artNotes),
    'Neutral background, consistent lighting, turnaround model-sheet style.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** P6 shot prompt synthesis from the terse shot description + entities (report §P6). */
export function buildShotPrompt(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
): string {
  const location = model.locations.get(scene.location);
  const subjects = shot.subjects.map((s) => {
    const character = model.characters.get(s.characterId);
    const name = character?.name ?? s.characterId;
    const bits = [name, `wearing ${outfitText(character, outfitFor(s, scene, character).id)}`];
    if (s.pose) bits.push(`pose: ${s.pose}`);
    if (s.expression) bits.push(`expression: ${s.expression}`);
    return bits.join(', ');
  });
  return [
    stylePreamble(config),
    `${shot.framing} shot${location ? ` in ${location.name}` : ''} (${shot.location}).`,
    subjects.length ? `Subjects: ${subjects.join('; ')}.` : 'No characters in frame.',
    shot.camera ? `Camera: ${shot.camera}.` : '',
    // The shot's own notes only. A character's and a location's reach this frame through the
    // sheets and plates it references, which were generated with them; saying them again here
    // would double the voice.
    artClause(shot.artNotes),
    'Render as a single illustrated frame, no UI text.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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

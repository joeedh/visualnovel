import type { Character, ImageParams, Location, ProjectModel, Scene, Shot } from '@vn/types';
import type { ProjectConfig } from '@vn/config';

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

function paletteClause(palette: string[]): string {
  return palette.length ? ` Palette: ${palette.join(', ')}.` : '';
}

/** P3 portrait prompt: neutral pose/expression, plain background (report §P3). */
export function buildPortraitPrompt(character: Character, config: ProjectConfig): string {
  return [
    stylePreamble(config),
    `Character portrait of ${character.name}.`,
    character.description,
    paletteClause(character.palette),
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
  return [
    stylePreamble(config),
    `Establishing shot of ${location.name}.`,
    location.description,
    location.mood ? `Mood: ${location.mood}.` : '',
    `Time of day / condition: ${variant}.`,
    paletteClause(location.palette),
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
    `Full-body ${angle} view of ${character.name} wearing ${outfit}.`,
    'Preserve the exact face and look from the reference image.',
    character.description,
    paletteClause(character.palette),
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
    const bits = [name, `wearing ${s.outfit}`];
    if (s.pose) bits.push(`pose: ${s.pose}`);
    if (s.expression) bits.push(`expression: ${s.expression}`);
    return bits.join(', ');
  });
  return [
    stylePreamble(config),
    `${shot.framing} shot${location ? ` in ${location.name}` : ''} (${shot.location}).`,
    subjects.length ? `Subjects: ${subjects.join('; ')}.` : 'No characters in frame.',
    shot.camera ? `Camera: ${shot.camera}.` : '',
    'Render as a single illustrated frame, no UI text.',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A reviewer-facing spec for a shot (report §P7). */
export function shotSpec(
  shot: Shot,
  scene: Scene,
): {
  description: string;
  characters: string[];
  outfit?: string;
  location: string;
  expression?: string;
  framing?: string;
} {
  return {
    description: scene.synopsis ?? scene.body.slice(0, 200),
    characters: shot.subjects.map((s) => s.characterId),
    outfit: shot.subjects[0]?.outfit,
    location: shot.location,
    expression: shot.subjects[0]?.expression,
    framing: shot.framing,
  };
}

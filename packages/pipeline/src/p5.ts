import type { Providers, Scene, Shot, ProjectModel } from '@vn/types';
import { shotDecompositionSchema } from '@vn/types';

/** Namespaced shot id so shot ids are unique across scenes (used as the task subject). */
export function shotId(sceneId: string, raw: string): string {
  return `${sceneId}__${raw}`;
}

/**
 * Deterministic shot decomposition (report §P5 baseline). Without an LLM we still produce
 * a runnable storyboard: one establishing shot of the scene's location plus one medium
 * shot per character present. Every shot defaults to the scene's primary location variant.
 */
export function deterministicShots(scene: Scene, model: ProjectModel): Shot[] {
  const location = model.locations.get(scene.location);
  const variant = location?.variants[0]?.id ?? 'day';
  // The establishing shot carries the scene's narration + non-attributed action beats.
  const establishingLines = scene.lines
    .filter((l) => l.kind === 'narration' || l.kind === 'action')
    .map((l) => l.id);
  const shots: Shot[] = [
    {
      id: shotId(scene.id, 'establishing'),
      sceneId: scene.id,
      framing: 'establishing',
      location: variant,
      subjects: [],
      coversLines: establishingLines,
      status: 'pending',
    },
  ];
  scene.characters.forEach((characterId, i) => {
    const character = model.characters.get(characterId);
    // A character's medium shot covers that character's dialogue lines.
    const coversLines = scene.lines
      .filter((l) => l.kind === 'dialogue' && l.speaker === characterId)
      .map((l) => l.id);
    shots.push({
      id: shotId(scene.id, `beat${i + 1}`),
      sceneId: scene.id,
      framing: 'medium',
      location: variant,
      subjects: [{ characterId, outfit: character?.defaultOutfit ?? 'default' }],
      coversLines,
      status: 'pending',
    });
  });
  return shots;
}

const DECOMP_SYSTEM = [
  'You are a visual-novel storyboard artist. Decompose a scene into a short ordered list',
  'of illustrated shots. Each shot names its framing (wide|medium|close|establishing), a',
  'location variant id, and the subjects (characterId + outfit + optional pose/expression).',
  'Cover the scene with as few shots as tell it clearly. Respond ONLY with JSON of the form',
  '{"shots":[{"id","framing","location","subjects":[{"characterId","outfit","pose?","expression?"}],"camera?","coversLines":[]}]}.',
].join(' ');

/**
 * Decompose a scene into shots (report §P5). Uses the text LLM with structured-output
 * enforcement, falling back to the deterministic storyboard if the model is unavailable
 * or returns nothing usable. Shot ids are namespaced under the scene id.
 */
export async function decomposeScene(
  scene: Scene,
  model: ProjectModel,
  providers: Providers,
): Promise<Shot[]> {
  const location = model.locations.get(scene.location);
  const variants = location?.variants.map((v) => v.id) ?? ['day'];
  const prompt = [
    `Scene id: ${scene.id}`,
    `Location: ${scene.location} (variants: ${variants.join(', ')})`,
    `Characters present: ${scene.characters.join(', ') || 'none'}`,
    scene.synopsis ? `Synopsis: ${scene.synopsis}` : '',
    '',
    scene.body,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await providers.text.structured(
      prompt,
      (raw) => shotDecompositionSchema.parse(JSON.parse(raw)),
      DECOMP_SYSTEM,
    );
    if (!result.shots.length) return deterministicShots(scene, model);
    // Only accept line ids the scene actually has, so the LLM cannot invent bindings.
    const realLineIds = new Set(scene.lines.map((l) => l.id));
    return result.shots.map((s) => ({
      id: shotId(scene.id, s.id),
      sceneId: scene.id,
      framing: s.framing,
      location: variants.includes(s.location) ? s.location : (variants[0] ?? 'day'),
      subjects: s.subjects.map((sub) => ({
        characterId: sub.characterId,
        outfit: sub.outfit,
        pose: sub.pose,
        expression: sub.expression,
      })),
      camera: s.camera,
      coversLines: s.coversLines.filter((id) => realLineIds.has(id)),
      status: 'pending' as const,
    }));
  } catch {
    return deterministicShots(scene, model);
  }
}

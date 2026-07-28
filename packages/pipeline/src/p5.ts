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
 *
 * The establishing shot carries the scene's cast, not an empty frame: it covers the
 * narration and action beats, and those describe the characters doing things. An empty
 * subject list would order a bare plate whose own lines contradict it — which the P2
 * location reference already produces anyway. A cast-less scene still gets a bare plate.
 */
export function deterministicShots(scene: Scene, model: ProjectModel): Shot[] {
  const location = model.locations.get(scene.location);
  const variant = location?.variants[0]?.id ?? 'day';
  // The establishing shot carries every unattributed line — narration, transitions, lyrics,
  // centered text. Each character's medium shot below takes that character's dialogue.
  const establishingLines = scene.lines
    .filter((l) => l.kind !== 'dialogue' && l.kind !== 'parenthetical')
    .map((l) => l.id);
  const shots: Shot[] = [
    {
      id: shotId(scene.id, 'establishing'),
      sceneId: scene.id,
      framing: 'establishing',
      location: variant,
      subjects: scene.characters.map((characterId) => ({
        characterId,
        outfit: model.characters.get(characterId)?.defaultOutfit ?? 'default',
      })),
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
  'Cover the scene with as few shots as tell it clearly.',
  'The scene is given to you as numbered lines, each prefixed with its id in square brackets.',
  '`coversLines` lists the ids of the lines a shot is on screen for — copy them verbatim from',
  'the prompt. Assign EVERY line to exactly one shot, in order: a shot with no lines is never',
  'displayed, and a line with no shot leaves the previous image on screen. Respond ONLY with',
  'JSON of the form {"shots":[{"id","framing","location",',
  '"subjects":[{"characterId","outfit","pose?","expression?"}],"camera?",',
  '"coversLines":["scene:L1","scene:L2"]}]}.',
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
  // The identified lines, each prefixed with its id: `coversLines` asks for line ids, so
  // handing over flattened prose and expecting ids back is unanswerable.
  const lines = scene.lines.map(
    (l) => `[${l.id}] ${l.speaker ? `${l.kind}/${l.speaker}` : l.kind}: ${l.text}`,
  );
  const prompt = [
    `Scene id: ${scene.id}`,
    `Location: ${scene.location} (variants: ${variants.join(', ')})`,
    `Characters present: ${scene.characters.join(', ') || 'none'}`,
    scene.synopsis ? `Synopsis: ${scene.synopsis}` : '',
    '',
    'Lines:',
    ...lines,
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
    const shots: Shot[] = result.shots.map((s) => ({
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
    return withCoverage(shots, scene, model);
  } catch {
    return deterministicShots(scene, model);
  }
}

/**
 * Guarantee the storyboard actually binds to the screenplay. Coverage is what makes a shot
 * reachable — the exporter emits a `show` beat only where the covering shot changes — so a
 * decomposition that binds nothing renders every one of its images and displays none of them.
 * That is not a stylistic difference from the baseline; it is an unplayable scene, and it is
 * what a model returns when asked for line ids it was never shown.
 *
 * `coversLines` is not part of a shot's task hash (`buildShotPrompt` ignores it), so repairing
 * coverage here rehashes nothing.
 */
function withCoverage(shots: Shot[], scene: Scene, model: ProjectModel): Shot[] {
  const covered = new Set(shots.flatMap((s) => s.coversLines));
  if (!scene.lines.some((l) => covered.has(l.id))) return deterministicShots(scene, model);
  // A scene has to open on something: with the first line uncovered there is no `show` before
  // the first beat, so the runner starts on a blank frame no matter how good the rest is.
  const first = scene.lines[0];
  if (first && !covered.has(first.id) && shots[0]) shots[0].coversLines.unshift(first.id);
  return shots;
}

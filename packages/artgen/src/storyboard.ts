import type { Providers, Scene, Shot, ShotDecomposition, ProjectModel } from '@vn/types';
import { shotDecompositionSchema } from '@vn/types';

/**
 * Scene decomposition (report §P5) — the prompt, the parse, and the deterministic fallback.
 *
 * This is generative *policy* with no pipeline dependency, which is why it lives here: the
 * pipeline's `decomposeAll`, the desktop app and the authoring agent's `propose_storyboard` all
 * need the same call, and the agent may not import the pipeline. Persistence stays with the
 * callers — nothing in this module writes a shots file.
 */

/** Namespaced shot id so shot ids are unique across scenes (used as the task subject). */
export function shotId(sceneId: string, raw: string): string {
  return `${sceneId}__${raw}`;
}

/**
 * A storyboard and where it came from.
 *
 * The provenance is the whole point of the type. A baseline inside a run is the deterministic
 * fallback contract working as designed; a baseline written to `work/shots/` is permanent, because
 * an absent file is the signal that means "decompose this". One scene at a time nobody
 * notices, and a batch over a whole project with one bad key silently baselines everything — so a
 * caller that persists has to be able to tell the two apart, and now it can.
 */
export interface Decomposition {
  shots: Shot[];
  /** `baseline` means no model answered — see {@link reason}, which is always set with it. */
  source: 'model' | 'baseline';
  /** Why the model's answer was not used, in a sentence a caller can report verbatim. */
  reason?: string;
}

function baseline(scene: Scene, model: ProjectModel, reason: string): Decomposition {
  return { shots: deterministicShots(scene, model), source: 'baseline', reason };
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
      // No outfit: a decomposer does not choose clothes. Absent means inherit, so a later
      // scene marker or a change of default reaches this shot instead of being shadowed.
      subjects: scene.characters.map((characterId) => ({ characterId })),
      coversLines: establishingLines,
      status: 'pending',
    },
  ];
  scene.characters.forEach((characterId, i) => {
    // A character's medium shot covers that character's dialogue lines.
    const coversLines = scene.lines
      .filter((l) => l.kind === 'dialogue' && l.speaker === characterId)
      .map((l) => l.id);
    shots.push({
      id: shotId(scene.id, `beat${i + 1}`),
      sceneId: scene.id,
      framing: 'medium',
      location: variant,
      subjects: [{ characterId }],
      coversLines,
      status: 'pending',
    });
  });
  return shots;
}

/**
 * Resolve a decomposition's `characterId` to a character the model actually has.
 *
 * The planner needs an approved portrait per subject and skips a shot whose subject it cannot
 * find — silently and forever, since the decomposition is persisted. So an invented id is not a
 * cosmetic error: it is a shot that never renders and never says why. Ids are lowercase slugs, so
 * matching case-insensitively resolves the common miss (prose says `Aiko`, the sheet is `aiko`)
 * without guessing; anything else is dropped, like an invented line id.
 */
function resolveSubject(raw: string, model: ProjectModel): string | undefined {
  if (model.characters.has(raw)) return raw;
  const wanted = raw.toLowerCase();
  for (const id of model.characters.keys()) if (id.toLowerCase() === wanted) return id;
  return undefined;
}

const DECOMP_SYSTEM = [
  'You are a visual-novel storyboard artist. Decompose a scene into a short ordered list',
  'of illustrated shots. Each shot names its framing (wide|medium|close|establishing), a',
  'location variant id, and the subjects (characterId + optional pose/expression).',
  'Cover the scene with as few shots as tell it clearly.',
  'The scene is given to you as numbered lines, each prefixed with its id in square brackets.',
  '`coversLines` lists the ids of the lines a shot is on screen for — copy them verbatim from',
  'the prompt. Assign EVERY line to exactly one shot, in order: a shot with no lines is never',
  'displayed, and a line with no shot leaves the previous image on screen. Respond ONLY with',
  'JSON of the form {"shots":[{"id","framing","location",',
  '"subjects":[{"characterId","pose?","expression?"}],"camera?",',
  '"coversLines":["scene:L1","scene:L2"]}]}.',
].join(' ');

/**
 * Decompose a scene into shots (report §P5). Uses the text LLM with structured-output
 * enforcement, falling back to the deterministic storyboard if the model is unavailable
 * or returns nothing usable. Shot ids are namespaced under the scene id.
 *
 * Never throws: every failure becomes a `baseline` {@link Decomposition} naming its own cause, so
 * a run always has a storyboard and a caller that persists can still refuse to write one.
 */
export async function decomposeScene(
  scene: Scene,
  model: ProjectModel,
  // Only the text half: the agent's `propose_storyboard` has a text seam and no image provider,
  // and a full `Providers` still satisfies this signature.
  providers: Pick<Providers, 'text'>,
): Promise<Decomposition> {
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
    return realizeDecomposition(result, scene, model);
  } catch (err) {
    return baseline(scene, model, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Turn a parsed decomposition into real, validated shots: ids namespaced under the scene (already-
 * namespaced ids are kept, so a proposal read back is not double-prefixed), locations coerced to a
 * variant the scene's location has, subjects resolved to characters the model actually holds,
 * invented line ids dropped, and the coverage backstop applied.
 *
 * Public because `write_storyboard` runs the same gauntlet over the shot list the agent restates:
 * a proposal approved in conversation must be repaired at persist time the way the batch would
 * have repaired it, or the two paths write different storyboards from the same answer.
 */
export function realizeDecomposition(
  raw: ShotDecomposition,
  scene: Scene,
  model: ProjectModel,
): Decomposition {
  if (!raw.shots.length) return baseline(scene, model, 'the model returned no shots');
  const location = model.locations.get(scene.location);
  const variants = location?.variants.map((v) => v.id) ?? ['day'];
  // Only accept line ids the scene actually has, so the LLM cannot invent bindings.
  const realLineIds = new Set(scene.lines.map((l) => l.id));
  const shots: Shot[] = raw.shots.map((s) => ({
    id: s.id.startsWith(`${scene.id}__`) ? s.id : shotId(scene.id, s.id),
    sceneId: scene.id,
    framing: s.framing,
    location: variants.includes(s.location) ? s.location : (variants[0] ?? 'day'),
    // `outfit` is dropped even if the model volunteers one: clothes are the author's, and a
    // baked value here would shadow the scene marker the author writes later.
    subjects: s.subjects.flatMap((sub) => {
      const characterId = resolveSubject(sub.characterId, model);
      if (!characterId) return [];
      return [{ characterId, pose: sub.pose, expression: sub.expression }];
    }),
    camera: s.camera,
    coversLines: s.coversLines.filter((id) => realLineIds.has(id)),
    status: 'pending' as const,
  }));
  return withCoverage(shots, scene, model);
}

/**
 * Guarantee the storyboard actually binds to the screenplay. Coverage is what makes a shot
 * reachable — the exporter emits a `show` beat only where the covering shot changes — so a
 * decomposition that binds nothing renders every one of its images and displays none of them.
 * That is not a stylistic difference from the baseline; it is an unplayable scene, and it is
 * what a model returns when asked for line ids it was never shown.
 *
 * Exported with the module: callers that build shots some other way (a hand-made storyboard is
 * `@vn/scriptedit`'s business, not this backstop's) mostly want {@link realizeDecomposition},
 * which ends here.
 *
 * `coversLines` is not part of a shot's task hash (`buildShotPrompt` ignores it), so repairing
 * coverage here rehashes nothing.
 */
export function withCoverage(shots: Shot[], scene: Scene, model: ProjectModel): Decomposition {
  const covered = new Set(shots.flatMap((s) => s.coversLines));
  if (!scene.lines.some((l) => covered.has(l.id))) {
    return baseline(scene, model, 'the decomposition bound none of the scene’s lines');
  }
  // A scene has to open on something: with the first line uncovered there is no `show` before
  // the first beat, so the runner starts on a blank frame no matter how good the rest is.
  const first = scene.lines[0];
  if (first && !covered.has(first.id) && shots[0]) shots[0].coversLines.unshift(first.id);
  return { shots, source: 'model' };
}

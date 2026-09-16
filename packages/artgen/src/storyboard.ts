import type {
  PagePanel,
  ProjectConfig,
  Providers,
  Scene,
  SheetGroup,
  Shot,
  ShotDecomposition,
  ProjectModel,
} from '@vn/types';
import { shotDecompositionSchema } from '@vn/types';
import { LAYOUT_TEMPLATES, shapesFor } from './layout.js';
import { MAX_SHEET_CELLS } from './sheet.js';

/**
 * Scene decomposition (report §P5) — the prompt, the parse, and the deterministic fallback.
 *
 * This is generative policy with no pipeline dependency. The pipeline's `decomposeAll`, the desktop
 * app and the authoring agent's `propose_storyboard` all need the same call, and the agent may not
 * import the pipeline. Persistence stays with the callers — nothing in this module writes a shots
 * file.
 */

/** Namespaced shot id so shot ids are unique across scenes (used as the task subject). */
export function shotId(sceneId: string, raw: string): string {
  return `${sceneId}__${raw}`;
}

/**
 * A storyboard and where it came from.
 *
 * A baseline inside a run is the deterministic fallback contract working as designed. A baseline
 * written to `work/shots/` is permanent, because an absent file is the signal that means
 * "decompose this", and a batch over a whole project with one bad key would silently baseline every
 * scene. A caller that persists therefore needs to tell the two apart.
 */
export interface Decomposition {
  shots: Shot[];
  /** `baseline` means no model answered — see {@link reason}, which is always set with it. */
  source: 'model' | 'baseline';
  /** Why the model's answer was not used, in a sentence a caller can report verbatim. */
  reason?: string;
  /** The staging groups the model proposed, when it proposed any; written beside the shots. */
  sheets?: Record<string, SheetGroup>;
}

function baseline(scene: Scene, model: ProjectModel, reason: string): Decomposition {
  return { shots: deterministicShots(scene, model), source: 'baseline', reason };
}

/**
 * Deterministic shot decomposition (report §P5 baseline). Without an LLM we still produce
 * a runnable storyboard: one establishing shot of the scene's location plus one medium
 * shot per character present. Every shot defaults to the scene's primary location variant.
 *
 * The establishing shot carries the scene's cast rather than an empty frame, because it covers the
 * narration and action beats and those describe the characters doing things. An empty subject list
 * would order a bare plate whose own lines contradict it, and the P2 location reference already
 * produces such a plate. A cast-less scene still gets a bare plate.
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
      id         : shotId(scene.id, 'establishing'),
      sceneId    : scene.id,
      framing    : 'establishing',
      location   : variant,
      // A decomposer does not choose clothes, so no outfit is set. Absent means inherit, so a
      // later scene marker or a change of default reaches this shot instead of being shadowed.
      subjects   : scene.characters.map((characterId) => ({ characterId })),
      coversLines: establishingLines,
      status     : 'pending',
    },
  ];
  scene.characters.forEach((characterId, i) => {
    const coversLines = scene.lines
      .filter((l) => l.kind === 'dialogue' && l.speaker === characterId)
      .map((l) => l.id);
    shots.push({
      id      : shotId(scene.id, `beat${i + 1}`),
      sceneId : scene.id,
      framing : 'medium',
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
 * The planner needs an approved portrait per subject and silently skips a shot whose subject it
 * cannot find. The skip is permanent, because the decomposition is persisted, so an invented id is
 * a shot that never renders and never says why. Ids are lowercase slugs, so matching
 * case-insensitively resolves the common miss (prose says `Aiko`, the sheet is `aiko`) without
 * guessing. Anything else is dropped, like an invented line id.
 */
function resolveSubject(raw: string, model: ProjectModel): string | undefined {
  if (model.characters.has(raw)) return raw;
  const wanted = raw.toLowerCase();
  for (const id of model.characters.keys()) if (id.toLowerCase() === wanted) return id;
  return undefined;
}

/**
 * What the decomposer is told about the project's look and its storyboarding, read off
 * `project.yaml` by {@link storyboardStyle}. Both are prose; either may be empty.
 */
export interface StoryboardStyle {
  /** `art_style`, so the storyboard is composed for the look the frames will be drawn in. */
  artStyle: string;
  /** `storyboard_notes`: how a scene is storyboarded, as distinct from how a frame is drawn. */
  storyboardNotes: string;
}

/** The {@link StoryboardStyle} a project config states. */
export function storyboardStyle(
  config: Pick<ProjectConfig, 'art_style' | 'storyboard_notes'>,
): StoryboardStyle {
  return { artStyle: config.art_style, storyboardNotes: config.storyboard_notes };
}

const DECOMP_ROLE = [
  'You are a visual-novel storyboard artist. Decompose a scene into a short ordered list',
  'of illustrated shots. Each shot names its framing (wide|medium|close|establishing), a',
  'location variant id, and the subjects (characterId + optional pose/expression).',
  'Cover the scene with as few shots as tell it clearly.',
  'The scene is given to you as numbered lines, each prefixed with its id in square brackets.',
  '`coversLines` lists the ids of the lines a shot is on screen for — copy them verbatim from',
  'the prompt. Assign EVERY line to exactly one shot, in order: a shot with no lines is never',
  'displayed, and a line with no shot leaves the previous image on screen.',
].join(' ');

const DECOMP_FORMAT = [
  'Respond ONLY with JSON of the form {"shots":[{"id","framing","location",',
  '"subjects":[{"characterId","pose?","expression?"}],"camera?",',
  '"coversLines":["scene:L1","scene:L2"]}]}.',
].join(' ');

/** The most panels a page may carry; the schema refuses more, so the model is told the bound. */
export const MAX_PANELS = 6;

/**
 * What the model is told about pages, only when the author's notes are set: a project that
 * storyboards plain frames never hears the word "panel", so its decompositions do not grow them.
 */
const DECOMP_PAGES = [
  `Where the notes ask for pages, a shot may be a manga page instead of one frame: give it`,
  `"panels", one to ${MAX_PANELS} in reading order, each with its own framing, an optional camera`,
  '(extreme close-up, low angle, over-the-shoulder, insert, splash), the subjects in it, and the',
  '"coversLines" it letters; the page\'s own "coversLines" is the union of its panels\' and its',
  '"subjects" the union of theirs. Name a "layout" for the page from:',
  `${Object.entries(LAYOUT_TEMPLATES)
    .map(([name, shapes]) => `${name} (${shapes.length} panels)`)
    .join(', ')};`,
  'a page whose panel count matches none of them is split into even tiers. A shot without',
  '"panels" is a single frame as before. Where the notes ask for staging sheets, give shots',
  'that play out in one continuous space a shared "sheet" group id, contiguous beats up to',
  `${MAX_SHEET_CELLS} shots per group, and list each group under "sheets" with optional "notes"`,
  'on what stays fixed across it; the group is drawn once as a grid and every member is drawn',
  'from its cell.',
].join(' ');

const DECOMP_FORMAT_PAGES = [
  'Respond ONLY with JSON of the form {"shots":[{"id","framing","location",',
  '"subjects":[{"characterId","pose?","expression?"}],"camera?","layout?",',
  '"panels?":[{"framing","camera?","subjects":[{"characterId","pose?","expression?"}],',
  '"coversLines":["scene:L1"]}],"sheet?","coversLines":["scene:L1","scene:L2"]}],',
  '"sheets?":{"<group>":{"notes?"}}}.',
].join(' ');

/**
 * The decomposer's system prompt. The style sits between the role and the answer format, so
 * a project that states neither gets the prompt every decomposition before this was made with,
 * byte for byte. Storyboard notes bring the page vocabulary and the wider answer format with them.
 */
export function decompSystem(style: StoryboardStyle): string {
  const artStyle = style.artStyle.trim();
  const notes = style.storyboardNotes.trim();
  return [
    DECOMP_ROLE,
    ...(artStyle ? [`The frames will be drawn in this art style: ${artStyle}.`] : []),
    ...(notes ? [`Storyboard notes from the author: ${notes}.`, DECOMP_PAGES] : []),
    notes ? DECOMP_FORMAT_PAGES : DECOMP_FORMAT,
  ].join(' ');
}

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
  style: StoryboardStyle,
): Promise<Decomposition> {
  const location = model.locations.get(scene.location);
  const variants = location?.variants.map((v) => v.id) ?? ['day'];
  // Each line is prefixed with its id, because `coversLines` asks for line ids and flattened
  // prose gives the model nothing to answer with.
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
      decompSystem(style),
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
 * invented line ids dropped, a page's panels realized ({@link realizePanels}) with its cast and
 * coverage derived from them, and the coverage backstop applied.
 *
 * Public because `write_storyboard` applies the same repairs to the shot list the agent restates.
 * A proposal approved in conversation must be repaired at persist time the way the batch would
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
  const rank = new Map(scene.lines.map((l, i) => [l.id, i]));
  const shots: Shot[] = raw.shots.map((s) => {
    // `outfit` is dropped even if the model volunteers one: clothes are the author's, and a
    // baked value here would shadow the scene marker the author writes later.
    const subjects = s.subjects.flatMap((sub) => {
      const characterId = resolveSubject(sub.characterId, model);
      if (!characterId) return [];
      return [{ characterId, pose: sub.pose, expression: sub.expression }];
    });
    const panels = s.panels ? realizePanels(s.panels, s.layout, model, realLineIds) : undefined;
    // A page's cast is the union of its panels' with whoever the shot named itself; the panel
    // rung holds the poses, so a character reached only through a panel is cast bare.
    for (const sub of panels?.flatMap((p) => p.subjects) ?? []) {
      if (!subjects.some((x) => x.characterId === sub.characterId)) {
        subjects.push({ characterId: sub.characterId, pose: undefined, expression: undefined });
      }
    }
    const lettered = panels?.flatMap((p) => p.coversLines) ?? [];
    const coversLines = [
      ...new Set([...s.coversLines.filter((id) => realLineIds.has(id)), ...lettered]),
    ].sort((a, b) => rank.get(a)! - rank.get(b)!);
    const shot: Shot = {
      id      : s.id.startsWith(`${scene.id}__`) ? s.id : shotId(scene.id, s.id),
      sceneId : scene.id,
      // A page that named no framing takes its first panel's; the page prompt ignores it anyway
      framing : s.framing ?? panels?.[0]?.framing ?? 'medium',
      location: variants.includes(s.location) ? s.location : (variants[0] ?? 'day'),
      subjects,
      camera: s.camera,
      aspect: s.aspect,
      coversLines,
      status: 'pending' as const,
    };
    if (panels) shot.panels = panels;
    if (s.sheet !== undefined) shot.sheet = s.sheet;
    return shot;
  });
  const realized = withCoverage(shots, scene, model);
  if (realized.source === 'model' && raw.sheets && Object.keys(raw.sheets).length) {
    realized.sheets = raw.sheets;
  }
  return realized;
}

/**
 * A page's panels as real {@link PagePanel}s: outlines from the named layout wherever a panel
 * carried none, subjects resolved like a shot's, invented line ids dropped, and a line claimed by
 * two panels kept in the first, so the panels partition the page's lines.
 */
function realizePanels(
  raw: NonNullable<ShotDecomposition['shots'][number]['panels']>,
  layout: string | undefined,
  model: ProjectModel,
  realLineIds: ReadonlySet<string>,
): PagePanel[] {
  const drawn = raw.every((p) => p.shape !== undefined);
  const shapes = drawn ? raw.map((p) => p.shape!) : shapesFor(layout, raw.length);
  const claimed = new Set<string>();
  return raw.map((p, i) => {
    const coversLines = p.coversLines.filter((id) => realLineIds.has(id) && !claimed.has(id));
    for (const id of coversLines) claimed.add(id);
    const panel: PagePanel = {
      shape   : shapes[i]!,
      framing : p.framing,
      subjects: p.subjects.flatMap((sub) => {
        const characterId = resolveSubject(sub.characterId, model);
        if (!characterId) return [];
        return [
          {
            characterId,
            ...(sub.pose === undefined ? {} : { pose: sub.pose }),
            ...(sub.expression === undefined ? {} : { expression: sub.expression }),
          },
        ];
      }),
      coversLines,
    };
    if (p.camera !== undefined) panel.camera = p.camera;
    if (p.artNotes !== undefined) panel.artNotes = p.artNotes;
    return panel;
  });
}

/**
 * Guarantee the storyboard actually binds to the screenplay. The exporter emits a `show` beat only
 * where the covering shot changes, so a decomposition that binds no lines renders every one of its
 * images and displays none of them, which leaves the scene unplayable. A model asked for line ids
 * it was never shown returns exactly that.
 *
 * Exported so that callers building shots some other way can reach it (a hand-made storyboard is
 * `@vn/scriptedit`'s business rather than this backstop's). Most callers want
 * {@link realizeDecomposition}, which ends here.
 *
 * `coversLines` is not part of a shot's task hash (`buildShotPrompt` ignores it), so repairing
 * coverage here rehashes nothing.
 */
export function withCoverage(shots: Shot[], scene: Scene, model: ProjectModel): Decomposition {
  const covered = new Set(shots.flatMap((s) => s.coversLines));
  if (!scene.lines.some((l) => covered.has(l.id))) {
    return baseline(scene, model, 'the decomposition bound none of the scene’s lines');
  }
  // A scene has to open on something. With the first line uncovered there is no `show` before
  // the first beat, so the runner starts on a blank frame however good the rest is.
  const first = scene.lines[0];
  if (first && !covered.has(first.id) && shots[0]) {
    shots[0].coversLines.unshift(first.id);
    // A page letters its lines by panel, so the repaired line opens the first panel too
    shots[0].panels?.[0]?.coversLines.unshift(first.id);
  }
  return { shots, source: 'model' };
}

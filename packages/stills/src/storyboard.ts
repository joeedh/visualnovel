import type {
  PagePanel,
  ProjectConfig,
  Providers,
  Scene,
  SheetGroup,
  Shot,
  ShotDecomposition,
  ShotForm,
  ProjectModel,
} from '@vn/types';
import { shotDecompositionSchema } from '@vn/types';
import { contract } from '@vn/contracts';
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

export const providersTextFallback = contract({
  id      : 'providers.textFallback',
  rule: 'The text steps (P1 location enrichment, P5 shot decomposition) call the LLM with structured-output enforcement and fall back to a deterministic baseline when the step fails, so a whole run completes with mock providers and no API calls.',
  prevents:
    'A run that stops at the first text step a mock, missing or failing model cannot answer, which would make the pipeline impossible to run end to end without paid calls.',
  subjects: [
    'module:packages/stills/src/storyboard.ts',
    'function:packages/stills/src/storyboard.ts#decomposeScene',
    'function:packages/stills/src/storyboard.ts#deterministicShots',
    'function:packages/pipeline/src/p1.ts#enrichLocation',
    'function:packages/pipeline/src/p1.ts#deterministicBreakdown',
    'function:packages/providers/src/mock.ts#createMockProviders',
  ],
  detail:
    "P5's baseline is one establishing shot carrying the scene's cast plus one medium shot per " +
    "character, each on the location's first variant. The establishing shot carries the cast " +
    'because it covers the narration and action beats, which describe the characters doing ' +
    'things; a scene with no cast gets a bare plate. `decomposeScene` never throws: a failure ' +
    'becomes a `baseline` decomposition with a `reason`, so a caller that persists can refuse to ' +
    'write it (`planning.storyboardOnRequest`). P1 keeps the mined location when enrichment fails. ' +
    'Changing the baseline changes the prompt and re-keys establishing tasks, but shots are ' +
    'persisted, so an existing project keeps its old decomposition until `vngen/work/shots/*.json` ' +
    'is deleted or edited.',
});

/**
 * Deterministic shot decomposition (report §P5 baseline): one establishing shot of the scene's
 * location, carrying its cast, plus one medium shot per character present. Every shot defaults
 * to the scene's primary location variant.
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
  /** `shot_form`: whether each shot is a single frame or a page of panels. */
  shotForm: ShotForm;
}

/** The {@link StoryboardStyle} a project config states. */
export function storyboardStyle(
  config: Pick<ProjectConfig, 'art_style' | 'storyboard_notes' | 'shot_form'>,
): StoryboardStyle {
  return {
    artStyle       : config.art_style,
    storyboardNotes: config.storyboard_notes,
    shotForm       : config.shot_form,
  };
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
 * What the model is told about pages, only under `shot_form: pages`: a project that storyboards
 * plain frames never hears the word "panel", so its decompositions do not grow them.
 */
const DECOMP_PAGES = [
  'The author storyboards in manga pages: make every shot a page rather than one frame, unless',
  'the notes ask for a single frame somewhere. A page has',
  `"panels", one to ${MAX_PANELS} in reading order, each with its own framing, an optional camera`,
  '(extreme close-up, low angle, over-the-shoulder, insert, splash), the subjects in it, and the',
  '"coversLines" it letters; the page\'s own "coversLines" is the union of its panels\' and its',
  '"subjects" the union of theirs. Name a "layout" for the page from:',
  `${Object.entries(LAYOUT_TEMPLATES)
    .map(([name, shapes]) => `${name} (${shapes.length} panels)`)
    .join(', ')};`,
  'a page whose panel count matches none of them is split into even tiers. A shot without',
  '"panels" is a single frame.',
].join(' ');

/** What the model is told about staging sheets, only when the author's notes are set. */
const DECOMP_SHEETS = [
  'Where the notes ask for staging sheets, give shots',
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
 * The decomposer's system prompt. The style sits between the role and the answer format, so a
 * project that states none of it gets the prompt every decomposition before this was made with,
 * byte for byte. `shot_form: pages` brings the page vocabulary, and storyboard notes the staging
 * sheets; either brings the wider answer format with it.
 */
export function decompSystem(style: StoryboardStyle): string {
  const artStyle = style.artStyle.trim();
  const notes = style.storyboardNotes.trim();
  const pages = style.shotForm === 'pages';
  return [
    DECOMP_ROLE,
    ...(artStyle ? [`The frames will be drawn in this art style: ${artStyle}.`] : []),
    ...(notes ? [`Storyboard notes from the author: ${notes}.`] : []),
    ...(pages ? [DECOMP_PAGES] : []),
    ...(notes ? [DECOMP_SHEETS] : []),
    pages || notes ? DECOMP_FORMAT_PAGES : DECOMP_FORMAT,
  ].join(' ');
}

export const promptsDecomposeByLineId = contract({
  id      : 'prompts.decomposeByLineId',
  rule: "P5 receives the scene as identified lines, `[<lineId>] <kind>/<speaker>: <text>`, never as flattened prose, and a decomposition that binds none of the scene's real line ids falls back to the baseline.",
  prevents:
    'A model copying an empty `"coversLines":[]` from the response template, which produces shots that are drawn and never displayed, because the exporter shows a shot only where its lines are.',
  subjects: [
    'function:packages/stills/src/storyboard.ts#decomposeScene',
    'function:packages/stills/src/storyboard.ts#realizeDecomposition',
    'function:packages/stills/src/storyboard.ts#withCoverage',
    'tool:propose_storyboard',
    'tool:write_storyboard',
  ],
  see     : ['docs/plans/archive/INDEX.md#shot-timeline-editor'],
  detail:
    'The system prompt asks the model to assign every line to exactly one shot, in order; the code ' +
    'does not enforce that, and a line the answer leaves uncovered stays uncovered. What the code ' +
    'enforces: line ids the scene does not have are dropped, a decomposition that binds no real ' +
    'line falls back to the baseline (`withCoverage`), and an uncovered first line goes to the ' +
    "first shot, so a scene cannot open on a blank frame. `coversLines` is not in a frame's task " +
    'inputs, so these repairs re-key nothing.',
});

/**
 * Decompose a scene into shots (report §P5). Uses the text LLM with structured-output
 * enforcement, falling back to the deterministic storyboard if the model is unavailable
 * or returns nothing usable. Shot ids are namespaced under the scene id.
 *
 * Never throws: every failure becomes a `baseline` {@link Decomposition} naming its own cause.
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
 * Falls back to the baseline when the shots bind none of the scene's lines, and gives an uncovered
 * first line to the first shot.
 *
 * Exported so that callers building shots some other way can reach it (a hand-made storyboard is
 * `@vn/scriptedit`'s business rather than this backstop's). Most callers want
 * {@link realizeDecomposition}, which ends here.
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

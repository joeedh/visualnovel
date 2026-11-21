import type {
  AssetRef,
  Character,
  ImageParams,
  Lettering,
  Location,
  PagePanel,
  ProjectModel,
  PromptChunk,
  PromptOverride,
  Scene,
  SceneLine,
  Shot,
  ShotSpec,
  ShotSubject,
  Task,
  TaskInputs,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { contract } from '@vn/contracts';
import { outfitFor, outfitText } from '@vn/model';
import { makeTask } from '@vn/taskgraph';
import { chunk, chunkList, composePrompt } from './chunks.js';
import { layoutWords, shapeWords } from './layout.js';
import { authoredRefs } from './refs.js';

/**
 * The angles a model sheet is generated at once a character is approved (report §P4). Here rather
 * than in the planner because the cycle walk and adoption both have to name an angle; a second
 * copy of the list lets a shot reference a sheet nothing planned.
 */
export const MODEL_SHEET_ANGLES = ['front', 'side', 'back'] as const;

/** The one angle a shot references. A frame needs the clothes rather than a turnaround. */
export const SHEET_FRONT = MODEL_SHEET_ANGLES[0];

/** Image params derived from project config + the configured image model id. */
export function imageParams(config: ProjectConfig): ImageParams {
  return {
    modelId: config.models.image,
    aspect : config.image_params.aspect,
    seed   : config.image_params.seed,
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

/**
 * `params` with the narrowest authored image model applied, over the same rungs as
 * {@link seedFor}. Unlike the seed, the model is not part of the task hash, so authoring one
 * changes nothing until the picture is next drawn; a rung that authored none returns `params`
 * untouched.
 */
export function modelFor(params: ImageParams, ...rungs: (string | undefined)[]): ImageParams {
  const authored = rungs.filter((m): m is string => m !== undefined && m !== '').at(-1);
  return authored === undefined ? params : { ...params, modelId: authored };
}

/**
 * `params` with the shot's own aspect ratio applied, where it authored one, and otherwise the
 * project's `page_aspect` on a page shot. A frame that authored none returns `params` untouched,
 * so every existing task keeps the hash it had — the same guarantee {@link seedFor} gives.
 */
export function aspectFor(
  params: ImageParams,
  shot: Pick<Shot, 'aspect' | 'panels'>,
  pageAspect?: string,
): ImageParams {
  const aspect = shot.aspect ?? (shot.panels && pageAspect);
  return aspect === undefined ? params : { ...params, aspect };
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

export const promptsArtNotesAppended = contract({
  id      : 'prompts.artNotesAppended',
  rule: "Authored `artNotes` are appended to what a builder derived, entity note first and the narrower rung second, and an empty note adds nothing, so a project that authors no notes composes byte-identical prompts. A shot's prompt reads only the shot's own notes.",
  prevents:
    'Re-keying every task in every project that authors no notes, and losing the style preamble, reference scaffolding and closing frame clause that keep a picture on-model, which a replaced prompt would drop.',
  subjects: [
    'module:packages/stills/src/prompts.ts',
    'function:packages/stills/src/prompts.ts#artClause',
    'function:packages/stills/src/prompts.ts#buildPortraitChunks',
    'function:packages/stills/src/prompts.ts#buildLocationChunks',
    'function:packages/stills/src/prompts.ts#buildModelSheetChunks',
    'function:packages/stills/src/prompts.ts#buildShotChunks',
  ],
  see: [
    'docs/plans/archive/INDEX.md#asset-names-and-the-asset-editor',
    'docs/plans/archive/INDEX.md#agent-art-revision',
  ],
  detail:
    '`artNotes` is an optional free-text field at five rungs: `Character`, `Location`, `Shot`, each ' +
    '`Outfit` and each `LocationVariant`. Setting a note costs money by design, like an outfit and ' +
    'unlike a scene edit: the note is in the prompt, so it re-keys exactly the tasks its rung ' +
    'reaches. `buildShotPrompt` leaves out the entity notes because they already reach the frame ' +
    'through the plates and sheets it references. The test worth having is the byte-identical ' +
    'output of a project with no notes, not the feature. Where the notes, seeds and image models ' +
    'are written is `prompts.artRungsShared`, in `@vn/artgen`.',
});

/** Authored art direction, in order from the widest rung to the narrowest. */
export function artClause(...notes: (string | undefined)[]): string {
  const said = notes.map((n) => n?.trim()).filter((n): n is string => !!n);
  return said.length ? `Art direction: ${said.join(' ')}` : '';
}

/**
 * P3 portrait chunks: one chunk per clause the builder has always assembled (report §P3).
 *
 * One clause per chunk: splitting a clause across two chunks would change the rendered string and
 * re-key every task in every existing project.
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
      kind  : 'art-notes',
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
 * `override` is the preview seam: a surface showing what a not-yet-saved edit would send passes a
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
 * The reference images an author attached to this prompt, to be appended after whatever the
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
    prompt     : buildPortraitPrompt(character, config),
    refs       : portraitRefs(character, config),
    // A portrait is the character rung and nothing narrower — it wears no outfit of its own.
    params     : modelFor(seedFor(params, character.seed), character.imageModel),
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
    refs  : locationRefs(location, variant, config),
    params: modelFor(
      seedFor(params, location.seed, location.variants.find((v) => v.id === variant)?.seed),
      location.imageModel,
      location.variants.find((v) => v.id === variant)?.imageModel,
    ),
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
    // There is no `wardrobe` chunk: the builder puts the outfit inside the subject sentence, and
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
  // The angle is recorded on the task alone, so the outfit's override covers all three sheets.
  // That coarseness is known (§2) and is stated on the card rather than fixed by giving each
  // task its own override rung
  const stored = character.outfits.find((o) => o.id === outfit)?.promptOverride;
  return composePrompt(buildModelSheetChunks(character, outfit, angle, config), override ?? stored)
    .text;
}

/** {@link portraitRefs} for a model sheet — one rung, so all three angles get the same references. */
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
 * character, because a sheet derives from the portrait the caller resolved — and it leads the
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
    refs  : [portrait, ...modelSheetRefs(character, outfit, angle, config)],
    // The angle is not a rung, so one outfit seed covers all three sheets, as the outfit's art
    // notes do
    params: modelFor(
      seedFor(params, character.seed, character.outfits.find((o) => o.id === outfit)?.seed),
      character.imageModel,
      character.outfits.find((o) => o.id === outfit)?.imageModel,
    ),
  };
}

/**
 * A cast member as a prompt names them: name, the outfit they resolve to through the shot's own
 * subject entry, then whatever pose and expression `rung` states. On a frame the rung is the
 * subject itself; on a page it is the panel's entry, since the page's cast holds the clothes and
 * each panel holds the pose.
 */
export function subjectWords(
  cast: ShotSubject,
  rung: { pose?: string; expression?: string },
  scene: Scene,
  model: ProjectModel,
): string {
  const character = model.characters.get(cast.characterId);
  const name = character?.name ?? cast.characterId;
  const bits = [name, `wearing ${outfitText(character, outfitFor(cast, scene, character).id)}`];
  if (rung.pose) bits.push(`pose: ${rung.pose}`);
  if (rung.expression) bits.push(`expression: ${rung.expression}`);
  return bits.join(', ');
}

/** The line as a page letters it: the speaker's name and the words, or a bare caption. */
function letteredLine(line: SceneLine, model: ProjectModel): string {
  const said = JSON.stringify(line.text);
  if (!line.speaker) return `caption ${said}`;
  const name = model.characters.get(line.speaker)?.name ?? line.speaker;
  return `${name} says ${said}`;
}

/**
 * The words a page shot's lettering chunk carries under `lettering: model`: each panel's lines in
 * page order, quoted verbatim, so the image model letters exactly what the scene says. Empty under
 * `lettering: runner`, where the page is drawn wordless and the runner draws the bubbles.
 */
function letteringClause(
  panels: readonly PagePanel[],
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
): string {
  if (config.lettering !== 'model') return '';
  const parts = panels.flatMap((p, i) => {
    const lines = scene.lines.filter((l) => p.coversLines.includes(l.id));
    if (!lines.length) return [];
    return [`panel ${i + 1}: ${lines.map((l) => letteredLine(l, model)).join(', ')}`];
  });
  return parts.length ? `Lettering, verbatim: ${parts.join('; ')}.` : '';
}

export const promptsPagePanels = contract({
  id      : 'prompts.pagePanels',
  rule: "A storyboard is single frames or manga pages, as `shot_form` decides. A page's panels carry their own cast, drawn from the shot's, and their own lettered lines. Under `lettering: model` those lines are in the page's prompt and hash; a panel's bubbles are in no prompt.",
  prevents:
    "Storyboard notes or an art style turning frames into pages on their own, a panel casting someone no sheet was drawn for, a lettered page's redraw left out of a coverage edit's price, and a bubble placement re-rendering the page it sits on.",
  subjects: [
    'function:packages/stills/src/storyboard.ts#decompSystem',
    'function:packages/stills/src/storyboard.ts#MAX_PANELS',
    'function:packages/stills/src/prompts.ts#buildShotChunks',
    'function:packages/stills/src/layout.ts#matchPanels',
    'function:packages/stills/src/layout.ts#LAYOUT_IOU',
    'function:packages/types/src/production/shots.ts#PagePanel',
    'function:packages/types/src/production/shots.ts#PanelBubble',
    'function:packages/store/src/shots.ts#readShots',
    'function:packages/scriptedit/src/bubbles.ts#setBubbles',
    'function:packages/scriptedit/src/panels.ts#setPanels',
    'function:packages/scriptedit/src/coverage.ts#letteredPagesNote',
    'function:packages/pipeline/src/runners.ts#layoutReport',
    'module:packages/pipeline/src/planner.ts',
    'function:packages/export/src/playable.ts#buildPlayable',
    'command:project.setShotForm',
    'command:story.setPanels',
    'command:story.setBubbles',
    'tool:propose_storyboard',
    'tool:set_panels',
    'function:packages/authoring/src/tools/storyboard.ts#setBubblesTool',
    'task:shot_image',
  ],
  see     : ['docs/plans/manga-style.md', 'docs/research/manga-live-tests.md'],
  detail:
    '`shot_form` (`frames`, the default, or `pages`) decides whether a new storyboard is single ' +
    'frames or manga pages of panels. Under `pages`, `decompSystem` tells the model to make every ' +
    'shot a page and adds the page vocabulary: the layout template names with their panel counts, ' +
    'the camera vocabulary and the `MAX_PANELS` bound. Under `frames` it adds none of that, whatever ' +
    'the art style or the notes say, so the notes cannot turn frames into pages on their own. ' +
    'Storyboard notes add the staging-sheet paragraph, and either `pages` or notes brings the wider ' +
    "answer format, whose optional `panels?` key is then the only mention of panels in the prompt's " +
    "own text. The agent's `propose_storyboard` reads the same field and takes a `form` argument " +
    'that overrides it for one scene, to be passed only when the author explicitly asks for the ' +
    'other form. The desktop writes the field through `project.setShotForm`, a dropdown on the ' +
    'Project pane. A shot with `panels` is a page: one image of several panels, each with an ' +
    'outline in page fractions, its own framing, camera and cast, and the lines it letters. ' +
    "`readShots` refuses a file whose panel casts someone outside the shot's `subjects`, with " +
    '`panel_subject_not_in_cast`. A covered line no panel letters comes back in ' +
    '`LoadedShots.unpanelled`, the planner logs it as a `line_in_no_panel` warning, `setPanels` ' +
    "names it in its message, and the page still renders. A page's prompt is built by " +
    '`buildPageChunks`, which `buildShotChunks` calls for a shot with panels. Under ' +
    '`lettering: model` the lettered lines are in the prompt verbatim, so the text and its panel ' +
    'assignment are in the task hash: a coverage take on a page, or a line edit inside one, re-keys ' +
    "the page. Every host's coverage take says so through `letteredPagesNote` in `@vn/scriptedit`. " +
    "`lettering` defaults to `runner`, which draws the page wordless, because the manga plan's " +
    'Stage 2 live check found the default image model unfit for lettering and only the expensive ' +
    "ones fit; a project that wants the model to letter says so. A panel's `bubbles` " +
    '(`PanelBubble`: the line, an anchor, an optional tail and an optional name flag, in page ' +
    'fractions) are authored and outside the prompt: no builder reads them, so `story.setBubbles` ' +
    "and the agent's `set_bubbles` (one rule, `setBubbles` in `@vn/scriptedit`) re-key nothing. " +
    "`set_bubbles` is defined and exported, but `ALL_TOOLS` does not list it, so the agent's " +
    'registry does not offer it. ' +
    '`setBubbles` refuses a frame, a line no panel letters, a line named twice and a point off the ' +
    "page. A bubble's line must be one its panel letters: `readShots` drops a bubble whose line " +
    'left the panel, and `setPanels` drops one whose line it moved to another panel, since the ' +
    'anchor was placed against the old one. The exporter (`buildPlayable`) copies bubbles into the ' +
    'playable only under `lettering: runner`. `shotData.panelBoxes` holds the panel boxes a ' +
    "reviewer measured on the image the shot holds (a `done` output, or a `needs_human` shot's " +
    'last attempt), from `DefectReport.observed`, which the review fills only for a page. It is ' +
    'derived, like `proseHash`: the planner stamps it only with new image bytes, so a rerun that ' +
    "reports the same image leaves it alone. The runner's `layoutReport` matches every measuring " +
    "reviewer's boxes against the intended outlines (`matchPanels`, IoU at or above `LAYOUT_IOU`) " +
    "and files a `layout` defect of its own only when none of them match, because a reviewer's " +
    'measurement can be off while none invents a match for a wrong page; a page no reviewer ' +
    "measured gets no layout verdict. The boxes stamped are the matching reviewer's, or the first " +
    "reviewer's when none matched.",
});

/**
 * P6 chunks for a page shot. In place of the frame's `framing`, `subject` and `camera` chunks the
 * page carries one `page` chunk (the panel count, the location and the derived layout), one
 * `panel-<i>` chunk per panel (framing, cast, camera, the panel's own notes) and a `lettering`
 * chunk, then the shot's notes and a page scaffolding sentence. Keyed by index rather than by
 * text, so an override survives an edit to the panel's words.
 */
function buildPageChunks(
  shot: Shot,
  panels: readonly PagePanel[],
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
): PromptChunk[] {
  const location = model.locations.get(scene.location);
  const at = { sceneId: shot.sceneId, shotId: shot.id } as const;
  const cast = new Map(shot.subjects.map((s) => [s.characterId, s]));
  const panelChunks = panels.map((p, i) => {
    const who = p.subjects.flatMap((s) => {
      const member = cast.get(s.characterId);
      return member ? [subjectWords(member, s, scene, model)] : [];
    });
    const bits = [
      `Panel ${i + 1} (${p.framing} shot): ${who.length ? who.join('; ') : 'no characters'}`,
      p.camera ? `camera: ${p.camera}` : '',
      p.artNotes?.trim() ? `art direction: ${p.artNotes.trim()}` : '',
    ].filter(Boolean);
    return chunk(`panel-${i + 1}`, 'panel', `${bits.join('. ')}.`, {
      kind: 'shot',
      ...at,
      field: 'panels',
    });
  });
  const wordless = config.lettering === 'runner';
  return chunkList(
    chunk('style', 'style', stylePreamble(config), { kind: 'project', field: 'art_style' }),
    chunk(
      'page',
      'framing',
      `A manga page of ${panels.length} panel${panels.length === 1 ? '' : 's'}` +
        `${location ? ` in ${location.name}` : ''} (${shot.location}). ` +
        `Layout: ${layoutWords(panels)}.`,
      { kind: 'shot', ...at, field: 'panels' },
    ),
    ...panelChunks,
    chunk('lettering', 'lettering', letteringClause(panels, scene, model, config), {
      kind: 'shot',
      ...at,
      field: 'coversLines',
    }),
    chunk('art-notes', 'art-notes', artClause(shot.artNotes), {
      kind  : 'art-notes',
      target: `shot:${shot.sceneId}/${shot.id}`,
    }),
    chunk(
      'scaffolding',
      'scaffolding',
      wordless
        ? 'Render as one complete comic page with drawn panel borders; no text or lettering of any kind.'
        : 'Render as one complete comic page with drawn panel borders; no UI text.',
      { kind: 'builder' },
    ),
  );
}

/**
 * P6 shot chunks, synthesized from the terse shot description + entities (report §P6). A shot
 * with panels takes {@link buildPageChunks} instead; a frame's chunks are what they always were.
 */
export function buildShotChunks(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
): PromptChunk[] {
  if (shot.panels) return buildPageChunks(shot, shot.panels, scene, model, config);
  const location = model.locations.get(scene.location);
  const subjects = shot.subjects.map((s) => subjectWords(s, s, scene, model));
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
    // Only the shot's own notes. A character's notes and a location's already reach this frame
    // through the sheets and plates it references, which were generated with them, so repeating
    // them here would state them twice
    chunk('art-notes', 'art-notes', artClause(shot.artNotes), {
      kind  : 'art-notes',
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

export const identityHeadingRekeysShots = contract({
  id      : 'identity.headingRekeysShots',
  rule: "A shot's task inputs carry its location twice: `buildShotPrompt` names the location, and the plate's asset hash leads `refs`. So rewriting a scene's heading re-keys every shot in the scene, unlike retyping a line, which re-keys nothing.",
  prevents:
    'Treating a heading edit as free, like other prose edits, when the next run re-renders every shot in the scene; the price has to be shown before the edit runs.',
  subjects: [
    'function:packages/stills/src/prompts.ts#shotInputs',
    'function:packages/stills/src/prompts.ts#buildShotChunks',
    'function:packages/scriptedit/src/lineops.ts#setHeading',
    'command:story.setHeading',
    'task:shot_image',
  ],
  detail:
    "The planner passes the plate first in `upstream`, then each subject's portrait and outfit " +
    'sheet. A heading edit inverts the rule that prose edits are reported as drift rather than ' +
    're-rendered, so the price counts these shots as `restaged`, never as `drifted` ' +
    '(`script.headingRestagesShots`, in `@vn/scriptedit`).',
});

/**
 * One shot task's inputs. `upstream` is what the caller resolved and this cannot — the plate the
 * shot is set in and the portrait/sheet of each subject — and it leads the refs, with the authored
 * ones appended after, the order the hash has always seen (§12). `sheet` is the key of the staging
 * sheet a member shot is drawn from (`sheetKey`), carried in `params.extra`; a shot in no group
 * passes none and keeps the params it had.
 */
export function shotInputs(
  shot: Shot,
  scene: Scene,
  model: ProjectModel,
  config: ProjectConfig,
  params: ImageParams,
  upstream: AssetRef[],
  sheet?: string,
): TaskInputs['shot_image'] {
  // A frame is its own rung: the cast it draws is carried in as references, not as a seed.
  const own = aspectFor(
    modelFor(seedFor(params, shot.seed), shot.imageModel),
    shot,
    config.image_params.page_aspect,
  );
  return {
    shotId: shot.id,
    prompt: buildShotPrompt(shot, scene, model, config),
    refs  : [...upstream, ...shotRefs(shot, scene, model, config)],
    params: sheet === undefined ? own : { ...own, extra: { ...own.extra, sheet } },
  };
}

export const promptsReviewerSpec = contract({
  id      : 'prompts.reviewerSpec',
  rule: 'The P7 reviewer sees only what `shotSpec` says about the shot: its own framing, location and cast, with the prose of its covered lines marked as context only. `spec.characters` decides who must be in frame, and an empty list means an absence is not a defect.',
  prevents:
    'A reviewer handed the scene synopsis flagging every shot, plates included, for characters the scene mentions but the shot never ordered, so the refine loop spends every attempt and lands on `needs_human`.',
  subjects: [
    'function:packages/stills/src/prompts.ts#shotSpec',
    'command:story.requireCast',
    'task:shot_image',
  ],
  detail:
    '`Shot.castOptional` exempts a shot that has a cast from the same trap: the subjects stay on ' +
    'the shot, so their sheets still reach the generator as references, but `shotSpec` hands the ' +
    'reviewer an empty `characters` and the description says an absence is not a defect. Without ' +
    'it, a frame the reviewer will never accept (a figure seen from behind, a crowd, a hand) spends ' +
    'the whole cap. `story.requireCast` writes the field, normally from the Shot Coverage strip. ' +
    "`shotSpec`'s output never enters a task's `inputs`, and `castOptional` is read only by " +
    '`shotSpec`, so neither re-keys the shot: setting the field changes what the next review asks ' +
    'and does not by itself redraw the frame.',
});

/**
 * What the description says about who is in frame. A shot with `castOptional` names its subjects
 * and then says their absence is not a defect, so the sheets still reach the image as references
 * while nothing is required of the result.
 */
function castLine(shot: Shot): string {
  const named = shot.subjects.map((s) => s.characterId).join(', ');
  if (shot.subjects.length === 0) {
    return 'This is a background plate: no characters are intended in frame, and their absence is not a defect.';
  }
  return shot.castOptional
    ? `Characters this frame may show: ${named}. None of them has to be in frame, and an absence is not a defect.`
    : `Characters that must be in frame: ${named}.`;
}

function shotDescription(shot: Shot, scene: Scene): string {
  const covered = shot.coversLines.length
    ? scene.lines.filter((l) => shot.coversLines.includes(l.id))
    : [];
  const prose = covered.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join(' ');
  const what = shot.panels
    ? `A manga page of ${shot.panels.length} panel(s) set in ${shot.location}.`
    : `A single ${shot.framing} shot set in ${shot.location}.`;
  return [
    what,
    castLine(shot),
    // A page's cameras are per panel and reach the reviewer through `panels`
    shot.camera && !shot.panels ? `Camera: ${shot.camera}.` : '',
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
 *
 * `characters` is empty on a `castOptional` shot, because that field is what the reviewer reads as
 * the casting instruction: leaving the subjects in it would ask for the defect the flag exists to
 * stop. The description still names them, so the generator has them.
 *
 * A page adds `panels`, which asks the reviewer to report the boxes it sees, and — when
 * `lettering` says the model drew the words — the lines each panel should carry, so a misspelt
 * or misplaced line is a defect. A frame's spec has neither key, so its review is unchanged.
 */
export function shotSpec(
  shot: Shot,
  scene: Scene,
  model?: ProjectModel,
  lettering?: Lettering,
): ShotSpec {
  const lead = shot.subjects[0];
  const spec: ShotSpec = {
    description: shotDescription(shot, scene),
    characters : shot.castOptional ? [] : shot.subjects.map((s) => s.characterId),
    outfit     : lead && outfitFor(lead, scene, model?.characters.get(lead.characterId)).id,
    location   : shot.location,
    expression : shot.subjects[0]?.expression,
    framing    : shot.framing,
  };
  if (!shot.panels) return spec;
  spec.panels = shot.panels.map((p, i) => ({
    index     : i + 1,
    shapeWords: shapeWords(p.shape),
    framing   : p.framing,
    characters: p.subjects.map((s) => s.characterId),
  }));
  if (lettering === 'model') {
    spec.lettering = shot.panels.flatMap((p, i) => {
      const lines = scene.lines.filter((l) => p.coversLines.includes(l.id)).map((l) => l.text);
      return lines.length ? [{ panel: i + 1, lines }] : [];
    });
  }
  return spec;
}

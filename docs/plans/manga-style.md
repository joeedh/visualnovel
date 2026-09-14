# Colour manga as a second visual style

**Status: planned.** Nothing here is built. Pressure-tested once; the findings and what
each one changed are at the end.

## What this adds

Today every prompt, the decomposer and the reviewer speak visual-novel vocabulary, and the
only style control is the free-text `config.art_style`. This plan makes a colour-manga
project possible with four additions, none of which is a project-level mode:

- **Page shots.** A shot that renders one manga page made of several panels, each panel
  with its own framing, camera and cast, covering its own lines. A shot without panels
  keeps its current meaning (one frame), and a project mixes the two freely: a page for a
  conversation, a single cinematic frame for a beat that deserves one. Per-shot `aspect`
  comes with it, because a page is not 16:9.
- **A decomposer and reviewer that know about pages**, told what the project wants through
  `art_style` and a new `storyboard_notes` string rather than a switch.
- **Lettering, staged.** First the image model draws the words (`lettering: model`); later
  the runner draws bubbles the author or agent placed (`lettering: runner`).
- **A sheet as a staging reference.** An optional gen graph that draws a group of shots at
  once as a grid of cells, crops each cell, and hands the crop to that shot's own
  full-resolution generation as a reference. Its purpose is perspective coherence: a
  sequence like establishing → mid → over-the-shoulder → reverse → reverse in one room is
  drawn against one internal model of the room, so a reverse is the reverse of the frame
  before it rather than a re-invented one.

[`../research/manga-shot-composition.md`](../research/manga-shot-composition.md) is the
prior research. This plan agrees with its "one mode, not two" conclusion and its per-shot
`aspect` stage, and adds the page and sheet work it stopped short of. Its other stages
(front sheet for every subject, camera enums, a geometric scale check, screen placement)
are independent of this plan and are not taken up here.

## Facts the plan rests on

Each was checked against the code during the review.

- A task's identity is `sha256(kind, inputs)`, and `TaskInputs.shot_image` is
  `{ shotId, prompt, refs, params }` (`packages/types/src/tasks.ts`). Any change to a
  prompt string re-keys every task that renders it, so a new chunk renders empty for
  existing shots, the pattern `artClause`, `paletteClause` and `seedFor` follow
  (`packages/artgen/src/prompts.ts`).
- `buildShotChunks` reads no `coversLines` (`packages/artgen/src/prompts.ts:382-428`), so
  coverage is not in the hash. Prose drift is reported through `proseHash`
  (`packages/artgen/src/drift.ts`), never by re-keying. Four places say so in words:
  `set_coverage`'s description (`packages/authoring/src/tools/storyboard.ts:100-105`),
  `WorkspaceSession.setCoverage`'s doc (`apps/desktop/src/main/session/story.ts:428-430`),
  `docs/reference/pipeline-contracts.md` (twice), and the `full-production` skill.
- `shotSpec` (what the reviewer reads; defined in `packages/artgen/src/prompts.ts`,
  re-exported through `packages/pipeline/src/prompts.ts`) is not hashed and can change
  freely. It is called from `packages/pipeline/src/runners.ts:150` without the config,
  though `makeShotRunner(config)` has it.
- `ChatVisionReviewer.review` returns `{ reviewer, defects }` only
  (`packages/providers/src/review.ts:50`), and `defectReportSchema` is a non-strict
  `z.object` (`packages/types/src/schemas.ts:339-351`), so an extra field the model
  answers is stripped by zod.
- The runner records reviews on `task.attempts` (`runners.ts:180-187`); the planner's
  `refreshShotData` (`packages/pipeline/src/planner.ts:114-138`) copies task results onto
  the in-memory `Shot`, which is flat, and `serialize` in `packages/store/src/shots.ts`
  files the derived half under `shotData`.
- **The built-in Gemini image backend does not send `params.aspect`.**
  `packages/providers/src/backends/gemini.ts:216-222` sends `responseModalities` and
  `seed` only; only the Gemini plugin sends `imageConfig.aspectRatio`
  (`plugins/gemini/draw.ts:108`). Every project's `16:9` is in the hash and unsent.
- Under a bound graph the task's `params` never reach the image node: `drawThroughGraph`
  (`runners.ts:59-78`) passes prompt, refs and critique, and `GenImage` reads model,
  aspect and seed from its own props (`packages/gengraph/src/nodes/runtimes.ts:101-115`).
  `runBoundGraph` sees strings only (`packages/pipeline/src/graphrun.ts:234-238`). The
  desktop's interactive `gengraph.run` passes no seeds
  (`apps/desktop/src/main/session/gengraph.ts:291-294`).
- A seeded node type must be registered with `seededInput`
  (`packages/gengraph/src/nodes/types.ts:405-448`) or `seedInputs` throws
  (`packages/gengraph/src/execute.ts:254-258`). `graphDrift` compares authored hashes only
  (`packages/gengraph/src/drift.ts`), so a seed shared across tasks has no drift signal.
  `executeGenGraph` resumes a node whose hash matches its last `done` record
  (`execute.ts:131-143`), and `invalidateGenGraph` invalidates only nodes that `spend`
  (`execute.ts:218`).
- Nothing in the repo manipulates pixels; `docs/reference/gen-graphs.md` records that a
  Blend node is deliberately absent. `GenServices` is implemented by `createGenServices`
  (`packages/pipeline/src/genservices.ts:130`), the gengraph node-test fixture, the
  plugin-load test and the testkit, and is the plugin-facing capability API. The renderer
  imports `@vn/gengraph`'s main entry, so a native or heavy dependency cannot live there.
- `ImageParams.extra` exists, is documented as "model-specific extra params"
  (`packages/types/src/entities.ts:38`), reaches the hash, and no provider reads it.
- `say` and `narrate` beats carry no line id (`packages/export/src/playable.ts:140-144`),
  and `framesOf` (`apps/desktop/renderer/pathux/play/playback.ts`) folds `show` into the
  frames after it. `showBeatSchema` is `{ type, shot?, image? }`, playable `version` is
  the literal 1. `timeline.css:310` hard-codes `aspect-ratio: 16 / 9`; the asset editor
  already uses `object-fit: contain`.
- Shot-level `subjects` has four writers: `setShotOutfit`
  (`packages/scriptedit/src/outfits.ts`), `setShotSubjects` and `requireShotCast`
  (`packages/scriptedit/src/cast.ts`), and the agent's `set_outfit`. The planner pushes
  one portrait ref per subject in order (`planner.ts:252-278`), and `refs` is positional
  in the hash.
- `setCoverage` lives in `packages/scriptedit/src/coverage.ts:64-119`, works over the
  structural `CoverShot`, and returns `{ id, coversLines }` per changed shot; the desktop
  (`story.ts:451-456`) and the authoring tool apply that to full shots themselves.
  `withCoverage` (`packages/artgen/src/storyboard.ts:214-224`) prepends the scene's first
  line to `shots[0].coversLines`.
- The two plans this one used to hedge on are largely landed: `newShot`/`deleteShot`
  (`packages/scriptedit/src/shotcreate.ts`), `write_storyboard` and `propose_storyboard`
  with `.strict()` shapes (`packages/authoring/src/tools/storyboard.ts:161-197`),
  `setShotVariant` (`packages/scriptedit/src/variants.ts`), `basePromptOf`
  (`packages/pipeline/src/p6.ts`). Their rows in `index.md` still read "planned"; that is
  their bookkeeping, not this plan's.
- `project.setArtStyle` splices `art_style:` into `project.yaml` through `withArtStyle`
  (`packages/config/src/config.ts:74`) and its check prices the re-key
  (`apps/desktop/src/main/session/project.ts:52-64`).
- `decomposeScene(scene, model, providers)` takes no config. Callers: `planner.ts:91`,
  `packages/pipeline/src/decompose.ts:76` (`decomposeAll`, whose options carry no config),
  and `packages/authoring/src/tools/storyboard.ts:146`, where `Workspace.load()` reads
  `project.yaml` for `title` and `start` only
  (`packages/authoring/src/workspace.ts:176-189`).

## Decisions

1.  **No project-level mode.** The first draft had a `style_profile: 'vn' | 'manga'`
    owning the preamble default, every scaffolding sentence, the decomposer and reviewer
    personas, lettering and page aspect. The research doc's objection holds against the
    code: the differences that matter are per shot (a page beside a single frame, a tall
    page beside a wide frame), and everything cross-cutting the profile would have carried
    is either free text that already reaches every prompt (`art_style`) or a property of
    pages rather than of the project. What replaces it:
    - `art_style` stays the one style string and is now also handed to the decomposer, so
      "full-colour manga" in `project.yaml` reaches the storyboard as well as the paint.
    - `config.storyboard_notes: string`, default `''`: author guidance to the decomposer
      ("storyboard as manga pages of four to six panels; one splash per scene"). Empty
      means what it means today: frames only.
    - `config.lettering: 'model' | 'runner'`, default `'model'`. Applies to page shots
      only (decision 9).
    - `config.image_params.page_aspect: string`, default `'3:4'`: the aspect a page shot
      takes when its own `aspect` is unset.
    - `project.setStoryboardNotes` and `project.setLettering` beside
      `project.setArtStyle`, through a `withConfigKey` that generalizes `withArtStyle`'s
      splice; the lettering command's check prices the re-key of every page shot.

2.  **Per-shot `aspect`.** `Shot.aspect?: string`, resolved by `aspectFor(params, shot)`
    with the same shape as `seedFor`: unset on a frame returns `params` untouched (no hash
    moves); unset on a page shot takes `page_aspect`; set takes the value. This is the
    research doc's stage 3 and is required for pages.

3.  **The built-in Gemini backend sends the aspect.** `createGeminiImage` gains
    `imageConfig: { aspectRatio: params.aspect }`. No hash moves, but a re-render of any
    existing task can look different, because the `16:9` it has always carried was never
    sent. This is stated in the commit and in `docs/guides/cli.md`'s `--mock` and
    re-render notes, and lands as its own commit before anything renders a page.

4.  **Panels are a field on `Shot`, not a new task kind.** `Shot.panels?: PagePanel[]`.
    Absent means one frame. One task, one slot, one `shot_image` asset, one `show` beat,
    one `proseHash`, one art-notes rung, one prompt override: coverage, export, the slot
    graph, the document tree, adoption and the coverage strip keep working with no second
    `kind` case.

5.  **Panel geometry is a polygon in page fractions.** `PagePanel.shape` is a list of
    `[x, y]` points, clockwise, at least three, each coordinate in `[0, 1]`. A rectangle
    is four points; a diagonal gutter is four points with two off-axis; a bleed runs to
    the page edge. Manga panels are routinely not rectangles. Named layout templates
    (`two-tier`, `three-tier`, `diagonal-split`, `splash-with-insets`) in
    `packages/artgen/src/layout.ts` are polygon lists an author or the decomposer starts
    from.

6.  **The prompt's layout words are derived from the polygons** by `layout.ts` ("panel 2:
    tall, left column, lower edge cut on a diagonal"), so words and data cannot disagree.

7.  **The reviewer reports bounding boxes, and only checks.** When the spec lists panels,
    the reviewer is asked for one box per panel it sees, in reading order, under
    `DefectReport.observed.panels`. Boxes are matched to intended polygons by overlap; a
    count mismatch or an unmatched panel is a blocking `layout` defect. Boxes are recorded
    beside the image as `Shot.panelBoxes` in memory and `shotData.panelBoxes` on disk,
    stamped by `refreshShotData` when `image` changes (the `proseHash` rule), and used for
    nothing else. Every consumer reads the intended polygon.

8.  **The shot-level cast stays authored; panels name who is in them.**
    `PagePanel.subjects` is `{ characterId; pose?; expression? }[]`. `Shot.subjects`
    remains the cast list carrying `outfit`, so `setShotOutfit`, `setShotSubjects`,
    `requireShotCast` and `set_outfit` keep working unchanged, and the planner's one
    portrait ref per subject stays deduplicated and positional. A character wears one
    outfit across a page. On a page shot the shot-level `pose` and `expression` are not
    read; the panel's are. `realizeDecomposition` builds the cast as the deduplicated
    union of the panels; the validator reports a panel naming a character outside the cast
    (`panel_subject_not_in_cast`, error) rather than anything normalizing at write time.
    `Shot.framing` stays required and is set to the first panel's framing; the page prompt
    does not read it and `shotDescription` says "page" instead of "single `framing` shot".

9.  **Coverage stays shot-level and panels partition it.** `Shot.coversLines` remains the
    authority for coverage, the slot graph and the strip. `PagePanel.coversLines` must
    partition it; a covered line in no panel is a `line_in_no_panel` warning (the page
    still renders; the line is unlettered and stepping shows the whole page). The
    mechanism for edits: `CoverShot` gains optional `panels: { coversLines }[]`,
    `CoverageOp.changed` carries the new panel assignment beside `coversLines`, and both
    hosts apply both. A line gained by a page shot lands in the panel covering the nearest
    earlier line, or the first panel; a line lost leaves the panel that held it.
    `withCoverage`'s first-line repair lands the line in the first panel.

10. **Lettering applies to page shots only.** A single frame is never lettered: the
    runner's text box is its lettering, and a manga single frame is a cinematic panel
    rather than a page. Under `lettering: model` a `lettering` chunk lists each panel's
    dialogue and captions verbatim from its covered lines; under `runner` the chunk is
    empty and the page scaffolding says no text. The reviewer, given `spec.lettering`,
    checks the drawn text against it and reports a mismatch as blocking.

11. **Model lettering is a deliberate exception to "coverage is free".** On a page shot
    under `lettering: model`, the covered lines' text and their assignment to panels are
    in the prompt and so in the hash. A line edit or a coverage edit re-renders the page.
    That is correct, because the page shows the words, and it is recorded in the four
    places that say coverage is free (facts above), each gaining the page-shot clause.
    `story.setCoverage`'s `check` states the re-render on a lettered page shot the way
    `story.setHeading` states its cost.

12. **The `framing` enum stays.** Manga camera vocabulary (extreme close-up, low angle,
    over-the-shoulder, insert, splash) goes in the free-text `camera` field, which the
    decomposer is told to use when `storyboard_notes` asks for pages. The research doc's
    stage 2 (camera enums) would be a further refinement and is not blocked by this.

13. **The sheet is a gen graph; sheet membership is authored on the shot and the group is
    a record in the shots file.** `Shot.sheet?: string` names a group within the scene;
    `shotsFile.sheets?: Record<string, { seed?: number; notes?: string }>` holds the
    group. The decomposer proposes groups (pages under manga notes, continuous beats
    otherwise, at most eight members) and the author edits them.

14. **Sheet identity is in the task hash.** On a member shot `shotInputs` puts
    `params.extra.sheet = sha256(sheet prompt, sheet ref hashes in order, group seed)`
    where the sheet prompt and refs are what the graph will be seeded with (decision 16).
    Anything the sheet is drawn from — the member list and order, each member's framing,
    camera and cast, the plate, the group's seed — therefore re-keys every member, which
    is right because they were all drawn against one sheet. The alternative, extending
    `graphDrift` to compare seeds, is rejected below. A shot with no `sheet` puts nothing
    in `extra`, so no existing hash moves; `extra`'s doc comment is rewritten to say it
    carries identity as well as provider parameters. The legacy (no graph) runner ignores
    the field.

15. **A sheet is redrawn through its inputs, never by `force`.** `gengraph.run` with
    `force` is refused on a graph holding a node that feeds more than one output
    (`sheet_graph_force`), naming the group's `seed` as the way to reroll: bumping it
    re-keys every member through decision 14, so the sheet and all its members redraw
    together. A forced sheet under resumed crops would leave every other member drawn
    against a sheet that no longer exists, and `invalidateGenGraph` cannot reach the crops
    because they do not spend.

16. **The graph shape.** `GenSheetPrompt` and `GenSheetRefs` (host-seeded, registered with
    `seededInput` like the three existing seeds) → `GenImage` (the sheet) → one `GenCrop`
    per cell → per member: `GenRefList` (the crop, the whole sheet, the task's
    `GenTaskRefs`) and a `GenTemplate` ("This is cell {varA} of the attached sequence
    sheet; match its staging and camera. {varB}" with `varB` from `GenDerivedPrompt`) →
    `GenImage` (the shot; `aspect` prop written from `aspectFor`) → `GenOutput` for that
    member's slot. The cell words live in the authored graph, in the authored hash, not in
    the derived prompt, so the legacy path's prompt is untouched. Multi-output graphs
    already share an upstream through the journal, so the sheet is drawn once per group
    and resumed for each sibling. Under a bound graph the shot's own `seed` rung does not
    apply, which is already true of every bound graph today. `gengraph.scaffoldSheet`
    writes this graph for a group, following `createForSlot`/`planForSlot`/`claimOf`
    (`apps/desktop/src/main/commands/gengraph.ts:212-315`) and refusing when any member
    slot already has a claim.

17. **Seeds are computed by a shared helper and threaded through the run.**
    `sheetSeeds(scene, group, model, config, upstreamByShot)` in `@vn/artgen` returns
    `{ prompt, refs }`; the planner computes it once per group (it already resolves each
    member's upstream through `shotUpstream`) and passes the sheet key into `shotInputs`;
    `makeShotRunner` (which has the scene from `findShot`) passes the seeds to
    `runBoundGraph` through a new `GraphRunOptions.seeds`; the desktop's interactive
    `runGraph` computes them through the same helper when the graph holds a sheet node, so
    Run on a sheet graph draws the same sheet the pipeline would.

18. **`GenCrop` is the repo's first pixel node, behind `GenServices.pixels`.** The seam is
    `pixels: { crop(bytes, ext, rect): Promise<{ bytes, ext }> }`, a plugin-visible
    capability. The implementation lives in `@vn/pipeline` (`jimp`: pure JS, PNG and JPEG,
    no native rebuild in the packaged app), never in `@vn/gengraph`, because the renderer
    imports that package's main entry. The gengraph test fixture, the plugin-load test and
    the testkit implement the seam with a stub that returns its input. A crop is an exact
    pixel copy plus a lossless re-encode; the rectangle is the cell, and no mask is needed
    for a fixed grid. The Blend note in `gen-graphs.md` is updated to say what pixel work
    the repo now does.

19. **The whole sheet also goes in as a reference** (decision 16's `GenRefList`). A crop
    alone loses the geography the sheet exists to establish.

20. **Sheets are bounded** at eight cells, 16:9 cells for frames and `page_aspect` cells
    for pages; a group mixing the two takes the page cell. A longer scene becomes
    sequential groups, each group's sheet given the previous group's sheet as a reference
    (a `GenSlotRef` is not enough because a sheet is a blob, so `GenSheetRefs` carries the
    previous group's last sheet hash from the journal when one exists).

21. **The runner shows the whole page first.** Stage 2 exports a page shot as one `show`
    beat with the page image; the dialogue plays in the ordinary text box under it. Stage
    3 adds `show.panels?: { shape, lines }[]` and an optional `line` (the line id) on
    `say` and `narrate` beats, both optional so the playable `version` stays 1; `framesOf`
    sets `Frame.panel` by matching the beat's `line` to a panel's `lines`, and the PLAY
    editor highlights the panel's polygon. The site renderer ignores both fields.

## Data model

```ts
/** One panel of a page shot. */
interface PagePanel {
    /** Page fractions, clockwise, at least three points. */
    shape: [number, number][];
    framing: Shot["framing"];
    camera?: string;
    /** Who is in this panel; the outfit comes from the shot's cast. */
    subjects: { characterId: string; pose?: string; expression?: string }[];
    /** A partition of the shot's `coversLines`. */
    coversLines: string[];
    artNotes?: string;
}

interface Shot {
    // …existing fields…
    aspect?: string;
    panels?: PagePanel[];
    /** The sheet group this shot is staged with, scoped to its scene. */
    sheet?: string;
    /** Derived: the reviewer's observed boxes, recorded with `image`. */
    panelBoxes?: { x: number; y: number; w: number; h: number }[];
}

// shotsFile
interface ShotsFile {
    // …existing fields…
    sheets?: Record<string, { seed?: number; notes?: string }>;
}
```

- `shotsFileSchema`: `aspect`, `panels`, `sheet` authored (top level); `panelBoxes` under
  `shotData`; `sheets` a top-level record. `serialize` stays byte-stable for a file
  without any of them, which the existing round-trip test pins.
- `shotDecompositionSchema` gains optional `aspect`, `panels` (subjects by name as today),
  `sheet`, and a top-level `sheets`. `realizeDecomposition` resolves subjects per panel
  with the same case-insensitive rule, drops invented line ids per panel, builds the cast
  from the panels, and coerces `framing`. `deterministicShots` stays frames-only.
- `ShotSpec` gains `panels?: { index; shapeWords; framing; characters }[]` and
  `lettering?: { panel; lines: string[] }[]`. `REVIEW_SYSTEM` gains two generic rules,
  applied only when the spec carries those fields: report observed boxes; check the drawn
  text. No per-project persona.
- `DefectReport` gains `observed?: { panels: { box }[] }`; `defectReportSchema` and the
  reviewer's return type carry it.
- `ImageParams.extra.sheet` on a member shot; absent otherwise.
- `PromptChunk` categories gain `'panel'` and `'lettering'`. Chunk keys are `page`,
  `panel-<i>` and `lettering`, keyed by index so an override survives an edit to the
  panel's words.
- `CoverShot.panels?`, `CoverageOp.changed[].panels?`.
- Playable: `show.panels?`, `say.line?`, `narrate.line?`.

## Prompt shape of a page shot

`buildShotChunks` on a shot with panels emits, in order: `style`, `page` (replacing
`framing`: "A manga page of N panels in <location> (<variant>)." plus the layout words),
`panel-<i>` for each panel (replacing `subject`: framing, cast with outfit from the shot's
cast, camera, the panel's art notes), `lettering`, `art-notes` (shot-level), `scaffolding`
("Render as one complete comic page with drawn panel borders; no UI text." under `model`
lettering, "…; no text or lettering of any kind." under `runner`). The shot-level `camera`
chunk is empty on a page. On a shot without panels the chunk list is exactly today's,
which the existing literal-string pins in `packages/artgen/src/tests/prompts.test.ts` and
`packages/pipeline/src/tests/pipeline.test.ts` continue to assert.

## Stages

Each stage lands green under `pnpm check && pnpm test && pnpm lint`.

### Stage 1 — aspect reaches the model, and the config gains its three keys

- `createGeminiImage` sends `imageConfig.aspectRatio` (decision 3). Own commit.
- `Shot.aspect`, `aspectFor` beside `seedFor` in `packages/artgen/src/prompts.ts`,
  `shotInputs` uses it; `shotsFileSchema` and `shotDecompositionSchema` gain `aspect`.
- `projectConfig`: `storyboard_notes`, `lettering`, `image_params.page_aspect`.
  `withConfigKey` in `packages/config/src/config.ts` generalizing `withArtStyle`;
  `project.setStoryboardNotes`, `project.setLettering` in
  `apps/desktop/src/main/commands/` following `project.setArtStyle`, the lettering check
  counting page shots (zero until stage 2, and the command is still correct then).
- `decomposeScene` gains a `style: { artStyle; storyboardNotes }` argument; the four
  callers pass it (`planner.ts:91`, `decompose.ts:76` through `DecomposeAllOptions`,
  `packages/authoring/src/tools/storyboard.ts:146` through `LoadedWorkspace`, which starts
  reading the two keys off `project.yaml`). `DECOMP_SYSTEM` becomes a function of the
  style and says nothing about pages yet.
- Tests: `aspectFor` unset returns the same object; the existing prompt and pipeline hash
  pins are unchanged; a decomposition test asserts the notes reach the system prompt.

### Stage 2 — page shots, model lettering, whole-page display

- Types and schemas as above. `packages/store/src/shots.ts` reads and writes `panels`,
  `sheet`, `sheets` and `shotData.panelBoxes`; the validator gains
  `panel_subject_not_in_cast` and `line_in_no_panel`.
- `packages/artgen/src/layout.ts`: templates, polygon → words, overlap matching.
- `buildShotChunks`, `shotInputs`, `shotSpec` as above; `castLine` and `shotDescription`
  say "page" for a page.
- `DECOMP_SYSTEM` (`packages/artgen/src/storyboard.ts:102-114`) learns pages: emit
  `panels` only when the notes ask for pages, templates by name, the camera vocabulary, at
  most six panels. `realizeDecomposition` as above.
- `setCoverage`, `CoverShot`, `CoverageOp`, both hosts, and `withCoverage` (decision 9).
  `story.setCoverage`'s check and the four "coverage is free" sentences (decision 11).
- `REVIEW_SYSTEM`'s two conditional rules; `defectReportSchema.observed`;
  `ChatVisionReviewer.review` returns it; `refreshShotData` stamps `panelBoxes`.
- `write_storyboard`'s strict shape gains `aspect`, `panels` (a strict sub-shape) and
  `sheet`; `propose_storyboard` prints them so the agent can restate a page.
- `newShot` never creates panels (the panel editor is stage 3).
- Timeline: `timeline.css:310`'s `16 / 9` becomes per-asset, read from the image. The
  shot-menu rule module (`apps/desktop/renderer/rules/shotmenu/`) gains a page-shot
  situation, then `pnpm gen:uxmodel`.
- Export: no change; the page is the shot's image.
- Docs: `pipeline-contracts.md` (decision 11, `observed`), `playable-format.md` (a page
  shot is one `show` beat; nothing else changes yet).

### Stage 3 — panel stepping and the panel editor

- `buildPlayable` emits `show.panels` and `say.line`/`narrate.line`; `framesOf` sets
  `Frame.panel`; the PLAY editor draws the polygon outline and dims the rest of the page.
- A panel editor in the asset pane: drag polygon vertices, pick a template, assign lines
  to panels, per-panel cast and camera. Writes through `story.setPanels` (undoable,
  `affects` the shots subtree); its check prices the re-key. Situations and
  `pnpm gen:uxmodel`. `set_panels` for the agent over the same rule.
- Docs: `playable-format.md`, `desktop-app.md`.

### Stage 4 — the sheet graph

- `Shot.sheet`, `shotsFile.sheets`, the decomposer proposing groups, `params.extra.sheet`
  through `sheetSeeds` and `shotInputs` (decisions 13, 14, 17).
- `buildSheetChunks(scene, members, model, config)` in `@vn/artgen`: the plate, the cast,
  then the ordered members as camera moves in one space, unlettered, into a fixed grid of
  cells.
- `GenSheetPrompt`, `GenSheetRefs`, `GenCrop` in `packages/gengraph/src/nodes/`
  (`registerGenNodes` gains the two `seededInput`s; the `gen-graphs.md` node table goes
  from twelve to fifteen). `GenServices.pixels`, implemented in
  `packages/pipeline/src/genservices.ts` with `jimp` and stubbed in the three fixtures.
- `GraphRunOptions.seeds`; `makeShotRunner` and the desktop `runGraph` compute them.
- `gengraph.run`'s `sheet_graph_force` refusal.
- `gengraph.scaffoldSheet(scene, sheet)`.
- The reviewer is handed the crop as an extra ref with a sentence in `spec.description`
  ("matches the staging of the attached cell").
- Trial on one scene of an example project before the decomposer proposes groups by
  default; `storyboard_notes` is where an author turns it on until then.
- The fixture asset cache key includes `params` (`schemas.ts:475`), so a recorded fixture
  for a member shot is invalidated by `extra.sheet`. Accepted: only member shots carry it,
  and none exists before this stage.
- Docs: `gen-graphs.md` (node table, seeds, the pixel seam, the Blend note, the force
  refusal), `pipeline-contracts.md` (identity: `params.extra.sheet`).

### Stage 5 — runner-drawn bubbles

- `PagePanel.bubbles?: { lineId; anchor: [number, number]; tail?: [number, number] }[]`,
  authored in the panel editor or proposed by the agent from `panelBoxes`.
- `project.setLettering runner`; the `lettering` chunk goes empty and the scaffolding
  changes, re-keying every page shot, which the command's check prices.
- The runner draws the bubble for the current line inside its panel. The site renderer
  stays text-under-page, because it is a bundle committed into author repositories.
- Deferred until stages 2–4 have run on a real project, because the bubble placement UI is
  the largest piece of editor work in the plan and its shape depends on how well observed
  boxes match intended polygons in practice.

## Contracts to update

- `pipeline-contracts.md`, Identity: `Shot.aspect` in `params`, `params.extra.sheet`, and
  the page-shot exception to "coverage is free" (decision 11).
- `pipeline-contracts.md`, Generation and review: `ShotSpec.panels`/`lettering`,
  `DefectReport.observed`, `panelBoxes` recorded like `proseHash`.
- `gen-graphs.md`: three node types, two seeds, `GenServices.pixels`, the Blend note, the
  force refusal, the interactive run's seeds (its claim that `runGraph` seeds today is
  wrong and is corrected in stage 4).
- `playable-format.md`: `show.panels`, `say.line`, `narrate.line` (stage 3), bubbles
  (stage 5).

## Cost to undo

- Stage 1's backend change is the one that reaches every project: with `aspectRatio` sent,
  a re-render of any existing task can look different, and reverting changes it back. No
  hash moves either way.
- Stage 1's config keys and `Shot.aspect` are optional and contribute nothing when unset;
  deleting them restores byte-identical prompts.
- Stage 2 adds optional fields. A project that never authored a page shot has no page
  tasks; removing the feature leaves page shots as frames with no panels, which re-render
  as single frames. Every page rendered under `lettering: model` is re-keyed by stage 5's
  switch and again by a revert of it.
- Stage 4's `params.extra.sheet` re-keys member shots when removed, the same cost as
  changing their camera, and only for shots that opted in.
- `ShotSpec.panels` and `lettering` are on the wire once stage 2 ships, so recorded
  attempts and the reports `report.agent` reads carry them. Harmless.

## Rejected alternatives

- **A project-level style profile.** The first draft. Rejected for the research doc's
  reasons and one more: every string the profile would have owned is either already free
  text on every prompt or a property of pages, so the profile would have doubled the
  decomposer, reviewer and scaffolding contracts to carry nothing a per-shot field does
  not (decision 1).
- **Sheet → split → upscale as the final pixels.** Cells are too small, page panels are
  not 16:9, and generative upscaling drifts. The sheet is a reference (decision 16).
- **A `page_image` task kind.** Every consumer of `shot_image` would grow a second case
  (decision 4).
- **Extending `graphDrift` to compare seeds.** Would give a sheet seed change a drift
  signal without touching the task hash, but drift is a report rather than a plan, so the
  siblings would be flagged and not re-planned; and it would make the graph, which is
  meant to change only how a slot is drawn, into something that changes when the slot
  should be redrawn. Putting the sheet in the hash keeps one identity rule (decision 14).
- **Normalizing the shot-level cast and coverage from the panels at write time.** Would
  erase four existing writers' edits on the next write (decision 8) and undo a coverage
  edit applied at shot level (decision 9).
- **A reviewer persona on the spec.** With no profile there is no persona; the page rules
  are conditional on spec fields (data model).
- **Widening the `framing` enum** (decision 12).
- **Boxes for panel geometry** (decision 5).
- **Cell words in the derived prompt.** Would put the cell index into the legacy path's
  prompt and hash (decision 16).

## Open questions

- Whether a page shot with one panel (a splash) should be a page or a frame with a tall
  `aspect`. The plan allows both; the decomposer is told a splash is a one-panel page so
  it can be lettered.
- Other image providers in the four-vendors plan may not accept `3:4`; `page_aspect` is a
  string the provider validates, and a refused value surfaces as a provider error.
- Whether `lettering` should also be settable per shot. Not until a project needs both
  modes at once.

## Review findings

From the fresh-context review, numbered as the reviewer ranked them. Each is fixed in the
text above or answered here.

1.  The built-in Gemini backend ignores `params.aspect`. **Fixed**: decision 3, stage 1,
    cost to undo.
2.  Under a bound graph `params` never reach the image node. **Fixed**: decision 16 writes
    the aspect into the node prop and states that the seed rung does not apply.
3.  `params.extra.sheet` hashed less than the sheet is drawn from. **Fixed**: decision 14
    hashes the seeded prompt and refs; decision 17 says where the planner gets them.
4.  Normalizing `subjects` from panels overwrites four writers; the union was undefined.
    **Fixed**: decision 8 keeps the cast authored, panels name characters, no
    normalization.
5.  `setCoverage` returns only `coversLines` and both hosts apply it themselves.
    **Fixed**: decision 9 names `CoverShot.panels` and `CoverageOp.changed[].panels`.
6.  Four shipped sentences say coverage is free. **Fixed**: listed in the facts, updated
    under decision 11, `story.setCoverage`'s check states the cost.
7.  `refreshShotData` writes derived fields, not the runner; `observed` is stripped twice;
    no in-memory field named. **Fixed**: decision 7, data model.
8.  `Frame.panel` cannot be computed without a line id on beats. **Fixed**: decision 21
    adds `say.line`/`narrate.line`.
9.  The research doc argues against a mode. **Adopted**: decision 1 drops the profile.
10. Both open plans are largely landed; `write_storyboard` is strict. **Fixed**: facts,
    stage 2. Their index rows are left to their own plans.
11. `force` on a sheet resumes stale crops. **Fixed**: decision 15 refuses `force` and
    gives the group a seed.
12. `runBoundGraph` sees strings; the desktop run passes no seeds. **Fixed**: decision 17.
13. `decomposeScene` and `shotSpec` cannot reach the config. **Fixed** for the decomposer
    (stage 1 names the four callers); `shotSpec` no longer needs the config because the
    persona is gone.
14. The cell words had no home. **Fixed**: decision 16 puts them in an authored
    `GenTemplate`.
15. `jimp` cannot live in `@vn/gengraph`; the seam is plugin-visible. **Fixed**:
    decision 18.
16. Imprecise facts (`conceptPrompt` as a sixth builder, `shotSpec`'s path, `proseHash`'s
    file, `extra`'s doc comment, a page's `framing`, `asset.css`). **Fixed** in the facts
    and decisions 8 and 14; the builder count no longer matters with the profile gone.
17. The before/after hash test is not writable as described; the fixture cache key
    includes `params`. **Fixed**: stage 1 extends the existing pins; stage 4 accepts the
    fixture invalidation.
18. Further undo costs. **Fixed**: cost to undo.
19. Unactionable steps (decomposer file, shot-menu module, `scaffoldSheet`'s precedent,
    `seededInput` registration, the node count, no command for switching). **Fixed** in
    stages 1, 2 and 4 and decision 16.

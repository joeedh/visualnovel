# Colour manga as a second visual style

**Status: partial.** Stage 1 has landed and Stage 2 is in progress; the As-shipped section
at the end records each commit and every deviation. The proposal completed one review
pass; the findings and resulting modifications are documented before that.

## What this adds

Prompt construction, the scene decomposer, and the visual reviewer currently rely on
visual-novel conventions, with style configuration limited to the free-text
`config.art_style` field. This design enables color-manga generation through four targeted
additions without introducing a global project-level mode:

- **Page shots.** A shot that renders a multi-panel manga page, where each panel specifies
  distinct framing, camera angles, cast members, and dialogue line coverage. Panel-less
  shots retain single-frame semantics, allowing projects to mix multi-panel pages (e.g.,
  dialogue sequences) and full cinematic frames. Per-shot `aspect` ratios are supported to
  accommodate non-16:9 page dimensions.
- **Page-aware decomposer and reviewer.** The decomposer and reviewer are instructed via
  `art_style` and a new `storyboard_notes` configuration string rather than a dedicated
  style toggle.
- **Staged lettering.** Initial implementations support direct model-rendered text
  (`lettering: model`); subsequent iterations enable runner-rendered dialogue bubbles
  positioned by authors or agents (`lettering: runner`).
- **Staging reference sheets.** An optional generation graph draws a sequence of shots as
  one picture, a grid of cells, then crops each cell and passes the crop as an image
  reference to the shot's full-resolution generation pass. This maintains spatial and
  perspective coherence across sequential shots in a shared environment (e.g.,
  establishing → medium → over-the-shoulder → reverse angles).

This document builds on
[`../research/manga-shot-composition.md`](../research/manga-shot-composition.md). It
adopts that document's single-mode architecture and per-shot `aspect` stages while
implementing the page and staging-sheet workflows deferred by that research. Other
proposals in that document (per-subject front sheets, camera enums, geometric scale
checks, and screen placement) remain independent and are excluded from this specification.

## Facts the plan rests on

The following implementation details have been validated against the codebase:

- Task identity is computed as `sha256(kind, inputs)`, where `TaskInputs.shot_image` is
  `{ shotId, prompt, refs, params }` (`packages/types/src/tasks.ts`). Modifying a prompt
  string invalidates the cache key for all tasks rendering it. Consequently, newly added
  prompt chunks must evaluate to empty strings for existing shots, following the pattern
  in `artClause`, `paletteClause`, and `seedFor` (`packages/artgen/src/prompts.ts`).
- `buildShotChunks` does not read `coversLines`
  (`packages/artgen/src/prompts.ts:382-428`), excluding line coverage from the task hash.
  Content drift is tracked via `proseHash` (`packages/artgen/src/drift.ts`) rather than
  cache invalidation. This contract is codified in four locations: `set_coverage`
  documentation (`packages/authoring/src/tools/storyboard.ts:100-105`),
  `WorkspaceSession.setCoverage` documentation
  (`apps/desktop/src/main/session/story.ts:428-430`),
  `docs/reference/pipeline-contracts.md` (two occurrences), and the `full-production`
  agent skill.
- `shotSpec` defines reviewer input (`packages/artgen/src/prompts.ts`, re-exported in
  `packages/pipeline/src/prompts.ts`) and is excluded from task hashing, allowing safe
  modifications. It is invoked without config context from
  `packages/pipeline/src/runners.ts:150`, though `makeShotRunner(config)` maintains config
  access.
- `ChatVisionReviewer.review` returns strictly `{ reviewer, defects }`
  (`packages/providers/src/review.ts:50`). Because `defectReportSchema` is a non-strict
  `z.object` (`packages/types/src/schemas.ts:339-351`), unrecognized model output fields
  are stripped during Zod parsing.
- The runner records review results in `task.attempts` (`runners.ts:180-187`). The
  planner's `refreshShotData` (`packages/pipeline/src/planner.ts:114-138`) populates task
  results onto the flat in-memory `Shot` instance, and `serialize`
  (`packages/store/src/shots.ts`) persists derived values under `shotData`.
- The built-in Gemini image backend does not transmit `params.aspect`:
  `packages/providers/src/backends/gemini.ts:216-222` passes only `responseModalities` and
  `seed`. Only the external Gemini plugin forwards `imageConfig.aspectRatio`
  (`plugins/gemini/draw.ts:108`). Default `16:9` values are therefore present in task
  hashes but ignored by the built-in backend.
- Under a bound graph, task `params` do not reach the image node: `drawThroughGraph`
  (`runners.ts:59-78`) passes only prompt, reference, and critique strings, while
  `GenImage` sources model, aspect ratio, and seed from node properties
  (`packages/gengraph/src/nodes/runtimes.ts:101-115`). `runBoundGraph` processes string
  inputs only (`packages/pipeline/src/graphrun.ts:234-238`). Desktop interactive execution
  via `gengraph.run` does not inject seeds
  (`apps/desktop/src/main/session/gengraph.ts:291-294`).
- Seeded node types must register via `seededInput`
  (`packages/gengraph/src/nodes/types.ts:405-448`); otherwise, `seedInputs` throws
  (`packages/gengraph/src/execute.ts:254-258`). `graphDrift` evaluates authored hashes
  only (`packages/gengraph/src/drift.ts`), providing no drift detection for cross-task
  seeds. `executeGenGraph` resumes any node whose hash matches its prior `done` record
  (`execute.ts:131-143`), while `invalidateGenGraph` purges only nodes with `spend` side
  effects (`execute.ts:218`).
- The repository contains no pixel manipulation utilities; `docs/reference/gen-graphs.md`
  notes the intentional omission of a `Blend` node. `GenServices` defines the
  plugin-facing capability interface, implemented by `createGenServices`
  (`packages/pipeline/src/genservices.ts:130`), the gengraph node test fixture, the plugin
  loading test, and the testkit. Because the desktop renderer imports the `@vn/gengraph`
  entry point, native or heavy dependencies cannot live in that package.
- `ImageParams.extra` is typed and documented as "model-specific extra params"
  (`packages/types/src/entities.ts:38`) and is included in task hashes, but no provider
  currently reads it.
- `say` and `narrate` beats do not store line IDs
  (`packages/export/src/playable.ts:140-144`), and `framesOf`
  (`apps/desktop/renderer/pathux/play/playback.ts`) collapses `show` beats into subsequent
  frames. `showBeatSchema` is defined as `{ type, shot?, image? }`, and playable data
  version is pinned to `1`. `timeline.css:310` enforces a fixed `aspect-ratio: 16 / 9`,
  while the asset editor uses `object-fit: contain`.
- Shot-level `subjects` has four mutating call sites: `setShotOutfit`
  (`packages/scriptedit/src/outfits.ts`), `setShotSubjects` and `requireShotCast`
  (`packages/scriptedit/src/cast.ts`), and the agent tool `set_outfit`. The planner
  appends one portrait reference per subject in stable order (`planner.ts:252-278`), and
  `refs` ordering affects the task hash.
- `setCoverage` (`packages/scriptedit/src/coverage.ts:64-119`) operates on structural
  `CoverShot` records and returns `{ id, coversLines }` per modified shot; desktop session
  handlers (`story.ts:451-456`) and authoring tools reconcile these changes against full
  shot records. `withCoverage` (`packages/artgen/src/storyboard.ts:214-224`) prepends the
  first line of a scene to `shots[0].coversLines`.
- The two open plans that touch the same code
  ([`creating-shots-by-hand-and-by-agent.md`](creating-shots-by-hand-and-by-agent.md) and
  [`refine-corrections-tool-schemas-shot-variants-and-commit-subjects.md`](refine-corrections-tool-schemas-shot-variants-and-commit-subjects.md))
  have largely landed: `newShot` and `deleteShot`
  (`packages/scriptedit/src/shotcreate.ts`), `.strict()` validation for `write_storyboard`
  and `propose_storyboard` (`packages/authoring/src/tools/storyboard.ts:161-197`),
  `setShotVariant` (`packages/scriptedit/src/variants.ts`), and `basePromptOf`
  (`packages/pipeline/src/p6.ts`). Their rows in `index.md` still read "planned"; that is
  their bookkeeping, not this plan's.
- `project.setArtStyle` updates `art_style:` in `project.yaml` via `withArtStyle`
  (`packages/config/src/config.ts:74`), and its pre-flight validation calculates cache
  invalidation costs (`apps/desktop/src/main/session/project.ts:52-64`).
- `decomposeScene(scene, model, providers)` does not accept configuration arguments. Its
  call sites are `planner.ts:91`, `packages/pipeline/src/decompose.ts:76` (`decomposeAll`,
  whose options omit config), and `packages/authoring/src/tools/storyboard.ts:146` (where
  `Workspace.load()` parses only `title` and `start` from `project.yaml`,
  `packages/authoring/src/workspace.ts:176-189`).

## Decisions

1. **No project-level mode.** The initial design introduced
   `style_profile: 'vn' | 'manga'` to manage prompt defaults, scaffolding strings,
   decomposer/reviewer personas, lettering modes, and page aspect ratios. This abstraction
   was rejected: stylistic variance occurs per shot (e.g., standard frames alongside
   multi-panel pages or varying aspect ratios), while global style directives are already
   handled by `art_style`. The adopted replacement includes:

    - `art_style` remains the primary style description and is now forwarded to the
      decomposer, aligning storyboard composition with prompt generation (e.g.,
      "full-colour manga").
    - `config.storyboard_notes: string` (default `''`): author directives supplied to the
      decomposer (e.g., "storyboard as manga pages of four to six panels; one splash per
      scene"). An empty string retains legacy single-frame decomposition.
    - `config.lettering: 'model' | 'runner'` (default `'model'`): applies strictly to page
      shots (Decision 10).
    - `config.image_params.page_aspect: string` (default `'3:4'`): default aspect ratio
      applied to page shots when `aspect` is omitted.
    - `project.setStoryboardNotes` and `project.setLettering` complement
      `project.setArtStyle`, backed by a generalized `withConfigKey` helper. Changing
      lettering computes the invalidation cost across all page shots.

2. **Per-shot `aspect`.** Add `Shot.aspect?: string`, resolved via
   `aspectFor(params, shot)` mirroring `seedFor`. An unset aspect on a standard frame
   preserves `params` unmodified (preserving task hashes); an unset aspect on a page shot
   defaults to `page_aspect`; an explicit value overrides defaults. This implements Stage
   3 of the research document.

3. **Built-in Gemini backend aspect transmission.** Update `createGeminiImage` to transmit
   `imageConfig: { aspectRatio: params.aspect }`. This changes no task hashes, but
   re-rendering existing shots may alter output because the implicit `16:9` ratio was
   previously omitted from provider requests. This change will land in an isolated commit
   accompanied by documentation updates in `docs/guides/cli.md` regarding `--mock` and
   re-rendering behavior prior to page generation rollout.

4. **Panels modeled on `Shot` rather than as a new task kind.** Add
   `Shot.panels?: PagePanel[]`, where omission signifies a single frame. Retaining a
   single task kind preserves existing single-slot semantics, `shot_image` asset
   pipelines, `show` playback beats, `proseHash` tracking, art-notes evaluation, prompt
   overrides, slot graphing, export workflows, and coverage UI without branching on task
   type.

5. **Panel geometry defined as normalized polygon coordinates.** `PagePanel.shape`
   represents a clockwise sequence of at least three `[x, y]` vertices normalized to
   `[0, 1]`. Rectangles require four points, diagonal gutters specify non-orthogonal
   coordinates, and bleeds extend to the unit boundary. Standard layouts (`two-tier`,
   `three-tier`, `diagonal-split`, `splash-with-insets`) are predefined in
   `packages/artgen/src/layout.ts` as starting templates for authors and the decomposer.

6. **Deterministic layout prompt derivation.** Prompt layout descriptions are
   deterministically generated from panel polygon definitions via `layout.ts` (e.g.,
   "panel 2: tall, left column, lower edge cut on a diagonal"), preventing
   desynchronization between data structures and model instructions.

7. **Reviewer panel validation via bounding box extraction.** When inspecting panel specs,
   the reviewer outputs observed bounding boxes in reading order under
   `DefectReport.observed.panels`. Boxes are evaluated against intended polygons via
   intersection-over-union; panel count mismatches or unmapped panels trigger a blocking
   `layout` defect. Detected boxes are persisted alongside the image in `Shot.panelBoxes`
   (in memory) and `shotData.panelBoxes` (on disk), updated by `refreshShotData` upon
   image updates (following `proseHash` semantics). Downstream consumers consume the
   intended polygon definitions rather than detected boxes.

8. **Authored shot cast with panel-level character assignments.** `PagePanel.subjects` is
   typed as `{ characterId: string; pose?: string; expression?: string }[]`.
   `Shot.subjects` remains the authoritative cast list governing character outfits,
   preserving `setShotOutfit`, `setShotSubjects`, `requireShotCast`, and `set_outfit`
   without altering reference deduplication or hash order. Characters maintain a single
   outfit across a given page. On page shots, top-level `pose` and `expression` fields are
   ignored in favor of panel-level values. `realizeDecomposition` derives the shot cast
   from the union of panel subjects. The model validator reports a panel naming a
   character outside the cast as a `panel_subject_not_in_cast` error rather than mutating
   data at write time. `Shot.framing` remains required and defaults to the framing of the
   first panel; page prompts ignore it, and `shotDescription` describes the shot as a
   "page" rather than a single framed shot.

9. **Shot-level coverage partitioned across panels.** `Shot.coversLines` remains
   authoritative for coverage, the slot graph, and the timeline UI.
   `PagePanel.coversLines` partitions the shot's covered lines; a covered line in no panel
   is a `line_in_no_panel` warning (the page still renders, the line is unlettered, and
   playback shows the whole page for it). For structural edits, `CoverShot` introduces
   optional `panels: { coversLines }[]`, and `CoverageOp.changed` includes updated panel
   assignments alongside `coversLines`. Lines added to a page shot are assigned to the
   panel containing the preceding line (or panel 1 if none match); removed lines are
   purged from their respective panels. `withCoverage`'s first-line repair puts the
   scene's first line in the first panel.

10. **Lettering scoped exclusively to page shots.** Single-frame shots are not lettered
    in-image; dialogue is rendered via the runner UI, treating single frames as cinematic
    compositions. When `lettering: model` is active, a `lettering` chunk embeds line text
    and panel assignments directly into the prompt. Under `lettering: runner`, the chunk
    is empty and the page's scaffolding sentence says no text. The reviewer checks
    generated text against `spec.lettering` and flags mismatches as blocking defects.

11. **Model lettering invalidates task identity on coverage edits.** Under
    `lettering: model`, dialogue text and panel mappings are embedded in the prompt,
    making the task hash sensitive to line and coverage modifications. Editing a covered
    line's text, or which panel covers it, re-keys the task and forces re-rendering. This
    exception to the "coverage edits do not re-render" invariant is written into the four
    places listed in the facts above, each gaining the page-shot clause.
    `story.setCoverage` surfaces invalidation costs for lettered page shots analogously to
    `story.setHeading`.

12. **Retention of the `framing` enum.** Manga-specific framing and staging instructions
    (e.g., extreme close-up, low angle, over-the-shoulder, insert, splash) are specified
    in the free-text `camera` field, which the decomposer populates when
    `storyboard_notes` requests manga formatting. Formalizing camera enums remains
    deferred to future iterations.

13. **Staging sheets implemented via generation graphs.** `Shot.sheet?: string` assigns a
    shot to a scene-scoped staging group, tracked in
    `shotsFile.sheets?: Record<string, { seed?: number; notes?: string }>`. The decomposer
    proposes groupings (up to eight shots per sheet, grouping pages under manga directives
    or contiguous beats in standard workflows), which authors can reconfigure.

14. **Sheet identity tracked in task input hashes.** Member shots include
    `params.extra.sheet = sha256(sheet prompt, sheet ref hashes in order, group seed)` in
    `shotInputs`, capturing the generation inputs of the upstream sheet graph (Decision
    16). Any modification to what the sheet is drawn from (member list and order, each
    member's framing, camera and cast, the background plate, or the group seed) re-keys
    every member shot in the group. Non-member shots omit `extra.sheet`, preserving
    existing task hashes. `extra`'s doc comment is rewritten to say it carries task
    identity as well as provider parameters. The legacy runner ignores this field.

15. **Sheet invalidation managed through seed mutations.** Invoking `gengraph.run` with
    `force` on a graph holding a node that feeds more than one output is refused
    (`sheet_graph_force`). Rerolling requires incrementing the group `seed`, which re-keys
    all member tasks concurrently via Decision 14. Forcing single-node execution without
    invalidating dependent tasks would create desynchronization, as downstream crop nodes
    do not incur spend and would not be invalidated by `invalidateGenGraph`.

16. **Staging sheet graph topology.** The graph pipeline is structured as:
    `GenSheetPrompt` and `GenSheetRefs` (registered as seeded inputs) → `GenImage`
    (renders sequence sheet) → `GenCrop` (slices cell per member) → Per member:
    `GenRefList` (aggregates cropped cell, full sequence sheet, and task references) and
    `GenTemplate` ("This is cell {varA} of the attached sequence sheet; match its staging
    and camera. {varB}", resolving `{varB}` via `GenDerivedPrompt`) → `GenImage` (renders
    final shot using `aspectFor`) → `GenOutput` (maps to slot). Cell instructions reside
    strictly within the authored graph template, keeping derived prompt strings clean for
    the legacy path. Shared upstreams are cached in the execution journal, rendering the
    sheet once per group. Under a bound graph the shot's own `seed` rung does not apply,
    which is already true of every bound graph today. `gengraph.scaffoldSheet` generates
    this graph structure, following `createForSlot`/`planForSlot`/`claimOf`
    (`apps/desktop/src/main/commands/gengraph.ts:212-315`) and refusing when any member
    slot already has a claim. The per-member chain (`GenCrop` → `GenRefList` →
    `GenTemplate` → `GenImage`) is written once as a group definition,
    `lib/sheet-cell.json`, on the project's first scaffold, and instanced per member with
    the cell rectangle and index as overrides; the outputs stay at the root because an
    output cannot be grouped. The definition is project-owned, like the pages bundle
    `project.installPages` commits, so an author can change the cell chain (swap the image
    node, add an edit pass) and every cell follows. No cross-project library is added;
    `gen-graphs.md` lists that as deliberately unbuilt and this plan keeps it so.

17. **Centralized seed calculation and propagation.** A shared helper
    `sheetSeeds(scene, group, model, config, upstreamByShot)` in `@vn/artgen` generates
    `{ prompt, refs }`. The planner computes this once per group and injects the resulting
    sheet key into `shotInputs`. `makeShotRunner` supplies these seeds to `runBoundGraph`
    via `GraphRunOptions.seeds`. The interactive desktop execution command `runGraph`
    invokes the same helper, ensuring parity between manual runs and pipeline execution.

18. **`GenCrop` pixel processing via `GenServices.pixels`.** Pixel operations are exposed
    through the plugin interface
    `pixels: { crop(bytes, ext, rect): Promise<{ bytes, ext }> }`. The concrete
    implementation resides in `@vn/pipeline` using `jimp` (pure JavaScript, supporting
    PNG/JPEG without native bindings in the desktop shell) rather than `@vn/gengraph`,
    keeping the renderer package free of heavy dependencies. Test harnesses and fixtures
    implement a pass-through stub. Cell cropping performs a lossless extraction and
    re-encode of the target rectangular bounds.

19. **Full sheet injected as global reference.** `GenRefList` incorporates both the
    cropped cell and the uncropped staging sheet. Providing the complete sheet preserves
    global spatial orientation that isolated cell crops discard.

20. **Sheet sizing and multi-group scaling.** Staging sheets support up to eight cells,
    dimensioned at 16:9 for single frames and `page_aspect` for page shots (mixed groups
    default to `page_aspect` cells). Longer sequences are partitioned into sequential
    groups, where subsequent sheets receive the preceding sheet as an image reference via
    `GenSheetRefs`, which reads the previous group's last sheet hash from the journal (a
    `GenSlotRef` cannot do this, because a sheet is a blob rather than an asset).

21. **Initial whole-page playback and panel highlight progression.** Stage 2 outputs a
    page shot as a single `show` beat referencing the page asset, displaying dialogue in
    the standard overlay box. Stage 3 introduces optional
    `show.panels?: { shape, lines }[]` along with `say.line` and `narrate.line`
    references, maintaining playable format `version: 1`. `framesOf` matches beat line IDs
    to panel definitions to populate `Frame.panel`, enabling the desktop player to
    highlight active panels while dimming background elements. The static web renderer
    safely ignores these optional properties.

## Data model

```ts
/** One panel of a page shot. */
interface PagePanel {
    /** Page fractions, clockwise, at least three points. */
    shape: [number, number][];
    framing: Shot["framing"];
    camera?: string;
    /** Character assignments; outfits inherit from the parent shot cast. */
    subjects: { characterId: string; pose?: string; expression?: string }[];
    /** A partition of the parent shot's `coversLines`. */
    coversLines: string[];
    artNotes?: string;
}

interface Shot {
    // …existing fields…
    aspect?: string;
    panels?: PagePanel[];
    /** Staging sheet group ID, scoped to the parent scene. */
    sheet?: string;
    /** Derived: reviewer-detected bounding boxes, persisted alongside `image`. */
    panelBoxes?: { x: number; y: number; w: number; h: number }[];
}

// shotsFile
interface ShotsFile {
    // …existing fields…
    sheets?: Record<string, { seed?: number; notes?: string }>;
}
```

- `shotsFileSchema`: `aspect`, `panels`, and `sheet` are authored top-level properties;
  `panelBoxes` persists under `shotData`; `sheets` is a top-level dictionary. `serialize`
  preserves byte-stability for files omitting these fields, as verified by existing
  round-trip tests.
- `shotDecompositionSchema`: gains optional `aspect`, `panels` (with subjects declared by
  name), `sheet`, and top-level `sheets`. `realizeDecomposition` resolves character IDs
  case-insensitively, discards ungrounded line IDs, derives the shot cast from panel
  subjects, and normalizes `framing`. `deterministicShots` remains frame-only.
- `ShotSpec`: gains `panels?: { index; shapeWords; framing; characters }[]` and
  `lettering?: { panel; lines: string[] }[]`. `REVIEW_SYSTEM` adds two conditional
  instructions: bounding box extraction and lettering verification.
- `DefectReport`: adds `observed?: { panels: { box }[] }`, exposed through
  `defectReportSchema` and reviewer return signatures.
- `ImageParams.extra.sheet`: present on staging sheet member shots; omitted otherwise.
- `PromptChunk`: adds `'panel'` and `'lettering'` categories. Emitted chunk keys are
  `page`, `panel-<i>`, and `lettering`, keyed by index so overrides survive text edits.
- Coverage types: `CoverShot.panels?` and `CoverageOp.changed[].panels?` added.
- Playable schema: `show.panels?`, `say.line?`, and `narrate.line?` added.

## Prompt shape of a page shot

For shots containing `panels`, `buildShotChunks` generates chunks in the following order:
`style`, `page` (replaces `framing`: "A manga page of N panels in <location> (<variant>)."
and includes derived layout text), `panel-<i>` for each panel (replaces `subject`:
framing, cast with inherited outfits, camera angle, and panel art notes), `lettering`,
shot-level `art-notes`, and `scaffolding` ("Render as one complete comic page with drawn
panel borders; no UI text." for `lettering: model`; "…; no text or lettering of any kind."
for `runner`). Shot-level `camera` chunks evaluate to empty strings on page shots. Shots
without panels preserve the existing chunk sequence, matching literal string assertions in
`packages/artgen/src/tests/prompts.test.ts` and
`packages/pipeline/src/tests/pipeline.test.ts`.

## Stages

Each stage must pass `pnpm check && pnpm test && pnpm lint` prior to merging, and Stages
1, 2 and 4 additionally pass their live-model check (below) before the stage counts as
done. The OpenRouter plugin the live checks need is Stage 1's first commit.

### Stage 1 — aspect reaches the model, and the config gains its three keys

- `plugins/openrouter/` and the `openrouter` key row (Live-model testing), so the rest of
  the stage can be checked against more than one model.
- Update `createGeminiImage` to transmit `imageConfig.aspectRatio` (Decision 3) in an
  isolated commit.
- Implement `Shot.aspect` and `aspectFor` in `packages/artgen/src/prompts.ts` alongside
  `seedFor`; integrate into `shotInputs`; add `aspect` to `shotsFileSchema` and
  `shotDecompositionSchema`.
- Extend `projectConfig` with `storyboard_notes`, `lettering`, and
  `image_params.page_aspect`. Add generalized `withConfigKey` in
  `packages/config/src/config.ts`; implement `project.setStoryboardNotes` and
  `project.setLettering` in `apps/desktop/src/main/commands/`, pricing invalidations
  across page shots.
- Update `decomposeScene` to accept `style: { artStyle; storyboardNotes }`; update the
  call sites (`planner.ts:91`; `decompose.ts:76` through `DecomposeAllOptions`;
  `packages/authoring/src/tools/storyboard.ts:146` through `LoadedWorkspace`, which starts
  reading the two keys off `project.yaml`). `DECOMP_SYSTEM` becomes a function of the
  style and says nothing about pages yet.
- Tests: verify `aspectFor` returns inputs unmodified when unset; assert prompt and
  pipeline hashes remain unchanged; verify `storyboard_notes` reach the decomposition
  system prompt.

### Stage 2 — page shots, model lettering, whole-page display

- Implement data models and schemas. Update `packages/store/src/shots.ts` to serialize
  `panels`, `sheet`, `sheets`, and `shotData.panelBoxes`; add `panel_subject_not_in_cast`
  and `line_in_no_panel` validations.
- Implement `packages/artgen/src/layout.ts` for layout templates, polygon-to-prose
  conversion, and bounding-box overlap matching.
- Update `buildShotChunks`, `shotInputs`, and `shotSpec`; adjust `castLine` and
  `shotDescription` to output "page" for multi-panel shots.
- Update `DECOMP_SYSTEM` (`packages/artgen/src/storyboard.ts:102-114`) to emit `panels` up
  to a maximum of six when requested by `storyboard_notes`, utilizing named templates and
  camera vocabulary. Implement `realizeDecomposition` resolution logic.
- Update `setCoverage`, `CoverShot`, `CoverageOp`, session hosts, and `withCoverage`
  (Decision 9). Update `story.setCoverage` invalidation pricing and documentation
  regarding coverage invalidations (Decision 11).
- Add conditional rules to `REVIEW_SYSTEM`; add `observed` to `defectReportSchema` and
  `ChatVisionReviewer.review`; update `refreshShotData` to populate `panelBoxes`.
- Update `write_storyboard` and `propose_storyboard` strict schemas to support `aspect`,
  `panels`, and `sheet`.
- Restrict `newShot` from generating panels (deferred to Stage 3).
- Timeline: update `timeline.css:310` to read aspect ratios per asset. Add a page-shot
  situation to the shot-menu rule module (`apps/desktop/renderer/rules/shotmenu/`) and
  regenerate via `pnpm gen:uxmodel`.
- Export: preserve single-image export for page shots.
- Documentation: update `pipeline-contracts.md` (Decision 11, `observed`) and
  `playable-format.md`.

### Stage 3 — panel stepping and the panel editor

- Update `buildPlayable` to export `show.panels`, `say.line`, and `narrate.line`; update
  `framesOf` to set `Frame.panel`; the PLAY treatment (lit panel, dimmed page, cut under
  reduced motion) follows the design section above.
- Add the panel editor to the desktop asset pane, built under the `frontend-design` skill
  as described in "Designing the editor surfaces": the design plan is written and reviewed
  against the brief before the first widget, and the stage does not land without its
  screenshot critique. Polygon vertex editing, template selection, line assignment, and
  per-panel cast/camera. Route mutations through `story.setPanels` with undo support and
  invalidation pricing. Regenerate UI models via `pnpm gen:uxmodel` and expose
  `set_panels` to the agent.
- Documentation: update `playable-format.md` and `desktop-app.md`.

### Stage 4 — the sheet graph

- Implement `Shot.sheet`, `shotsFile.sheets`, decomposer group suggestions, and
  `params.extra.sheet` via `sheetSeeds` and `shotInputs` (Decisions 13, 14, 17).
- Implement `buildSheetChunks(scene, members, model, config)` in `@vn/artgen` to arrange
  scene cast, background plate, and sequential camera cells into an unlettered grid.
- Add `GenSheetPrompt`, `GenSheetRefs`, and `GenCrop` to `packages/gengraph/src/nodes/`
  (register seeded inputs in `registerGenNodes`). Implement `GenServices.pixels` in
  `packages/pipeline/src/genservices.ts` using `jimp`, stubbing execution in test
  fixtures.
- Add `GraphRunOptions.seeds`; wire seed generation into `makeShotRunner` and desktop
  `runGraph`.
- Implement `sheet_graph_force` execution refusal in `gengraph.run`.
- Implement `gengraph.scaffoldSheet(scene, sheet)`.
- Forward cropped reference cells to the reviewer as auxiliary references with
  instructions in `spec.description`.
- The Stage 4 live check (the six-shot room sequence, three ways, on each model) decides
  whether the decomposer proposes groups by default; until then `storyboard_notes` is
  where an author turns sheets on.
- The fixture asset cache key includes `params` (`schemas.ts:475`), so a recorded fixture
  for a member shot is invalidated by `extra.sheet`. Accepted: only member shots carry it,
  and none exists before this stage.
- Documentation: update `gen-graphs.md` (node tables, seeded inputs, pixel capability
  interface, `Blend` notes, force-run constraints) and `pipeline-contracts.md`.

### Stage 5 — runner-drawn bubbles

- Add
  `PagePanel.bubbles?: { lineId; anchor: [number, number]; tail?: [number, number] }[]`,
  configured via the panel editor or populated by the agent using `panelBoxes`.
- Implement `project.setLettering runner`; clear prompt `lettering` chunks and update
  scaffolding, pricing the resulting invalidation of all page shots.
- The bubble editor extends the panel editor under the same design plan; the runner draws
  the bubble for the current line inside its panel. Preserve existing text overlay
  rendering in the standalone web player.
- Defer implementation until Stages 2–4 have been validated on production projects to
  confirm alignment between detected bounding boxes and intended geometries.

## Designing the editor surfaces

Three surfaces in this plan are new UI rather than a new row in an existing one, and each
is built under the `frontend-design` skill: a written design brief, the skill's design
plan (palette, type, layout with wireframes, principles) reviewed against that brief
before any code, and a screenshot critique before the stage lands. The design plan and its
critique are filed beside the plan as `docs/plans/manga-style-design.md` so the choices
survive the conversation that made them.

- **The panel editor** (Stage 3) is the one that matters most. Its brief: the page is the
  canvas. The author sees the rendered page (or the empty page aspect before a render)
  with the intended polygons drawn over it and, once a render exists, the reviewer's
  observed boxes as a second, quieter layer, so a mismatch is visible without a label.
  Vertices are dragged directly; a line is assigned to a panel by dragging it from a list
  of the shot's covered lines onto the panel; a template is picked from a row of small
  page glyphs rather than a dropdown of names. Cast and camera per panel are edited in a
  side column that follows the selected panel. Every control goes through `act()`, carries
  a tooltip, and the two commands behind it (`story.setPanels`, `story.setCoverage`) price
  the re-render in their `check`, which the surface shows verbatim on the control.
- **Panel stepping in PLAY** (Stage 3): the current panel is the whole idea, so the
  treatment is a single move — the page stays put, the current panel's polygon is lit and
  the rest of the page dims, with no motion beyond the crossfade between panels.
  Reduced-motion is respected by cutting instead of fading.
- **The bubble editor** (Stage 5) is the panel editor with one more layer: a bubble anchor
  per line dropped inside its panel, the tail dragged to the speaker. It reuses the panel
  editor's plan rather than getting its own.

The brief's fixed points, which the skill is told to follow exactly: path.ux's theme
supplies the palette and type, since the editor sits beside sixteen others that share
them; the memorable element is the page-as-canvas interaction, and everything around it
stays quiet; and the words on the surface name what the author does ("Assign this line to
panel 3", "Re-renders this page") rather than what the system does. Page display in the
timeline and asset editor (Stage 2) is a per-asset aspect ratio inside an existing surface
and does not go through the skill.

## Live-model testing

The mock tests prove the plumbing. Whether an image model honours a polygon layout,
letters a page verbatim, or keeps one room across a sheet is model behaviour, and each
stage that depends on it is checked against real models before the stage counts as done.
Gemini and OpenRouter keys are available for this.

### The harness: an OpenRouter plugin and bound graphs

- The pipeline has one live image backend, `createGeminiImage`, and the host's key
  vocabulary does not include `openrouter` (`scripts/prosestyle/keys.ts` keeps its own
  filename table for that reason). So the comparison runs through a plugin,
  `plugins/openrouter/`, built like `plugins/gemini/`: one `OpenRouterImage` node with
  `model`, `aspect` and `seed` props, calling `/api/v1/chat/completions` with
  `modalities: ['image', 'text']` over the host's recorded transport, declaring
  `keys: ["openrouter"]`. The host's key table gains the `openrouter` row
  (`OPENROUTER_API_KEY`, `keys/openrouter.txt`) so `resolveKeys` can hand it over.
- A bound graph changes how a slot is drawn without moving its hash, so the same shot is
  drawn by several models by binding one graph per model to the same slot in turn, with
  identical prompts and references. That is the whole harness; no test-only code path.
- Models: the built-in Gemini backend (direct, after Stage 1's aspect fix) is the
  baseline. Through OpenRouter, whichever image-output models it lists at the time —
  Google's image models are the ones known to be there; `gpt-image` and Flux endpoints are
  checked at the time rather than assumed. Model ids churn, so the research doc records
  which were run, not this plan.
- The plugin is not a `@vn/providers` backend, so it does not pre-empt
  [`four-chat-vendors-and-two-more-image-providers.md`](four-chat-vendors-and-two-more-image-providers.md);
  if that plan lands first the same comparison runs through its backends.
- Privacy:
  [`../research/openrouter-vs-direct-image-api-privacy.md`](../research/openrouter-vs-direct-image-api-privacy.md)
  finds that only Google's image models route ZDR on OpenRouter. The live tests run on
  `templates/basic` and the example projects, which hold nothing private, so non-ZDR
  models are allowed for the comparison and `zdr` is left off. A real manuscript is never
  used for a live test.
- Recording: `scripts/record-fixture-assets.mjs` records live image calls into the
  committed corpus `makeProject({ assets: 'cached' })` replays
  ([`../guides/testkit.md`](../guides/testkit.md#refreshing-the-corpus)). A page render is
  larger than the current entries (9 entries, 11.3 MB), so one representative page and one
  sheet are recorded per stage and the rest are not committed.

### What each stage checks live

- **Stage 1 — aspect is honoured.** One shot drawn at `16:9`, `3:4` and `9:16` on each
  model; the check is the returned image's pixel dimensions, read from the bytes, not a
  look. A model that refuses a ratio must surface a provider error, not a wrong-shaped
  image. This is the check the research doc says nobody has run.
- **Stage 2 — layout and lettering.** Each layout template drawn as a page on each model,
  several seeds each, under `lettering: model`. Two numbers per model, both from data the
  stage already produces: the layout-honoured rate (the reviewer's observed boxes matched
  to the intended polygons by the same overlap rule that files the `layout` defect) and
  the lettering exact-match rate. Plus attempts-to-accept and spend from `vngen cost`. The
  result decides the default `page_aspect`, the overlap threshold, the panel bound the
  decomposer is told, and whether any model is unfit for pages.
- **Stage 4 — perspective coherence.** The stage exists for this. One six-shot sequence in
  one room (establishing, mid, over-the-shoulder, reverse, pan, reverse) drawn three ways:
  per shot with no sheet, per shot with the sheet crop and full sheet as references
  through the graph, and the sheet at two cell counts. Judged by a vision reviewer given a
  fixed question list across the six frames (same room and furniture; shot 4 is the
  reverse of shot 3; the eyeline holds) and by a person looking at the six side by side,
  because the survey the research doc cites puts vision models at 55% on composition. The
  result decides whether the decomposer proposes groups by default, and the cell bound.
- **Stages 3 and 5** have no live-model step; the runner does not call a model.

### Rules

- A live pass runs after the stage's mock tests are green, never instead of them.
- Every pass is budgeted up front (`vngen cost` before the run, the spend recorded after)
  and bounded to the shots listed above; nothing loops on a model until it passes.
- Keys go through `resolveKeys` and are never printed; a failing call is quoted by its
  error text, never its request.
- Results are written to `docs/research/manga-live-tests.md` (per the research convention)
  as one table per stage — model, what was drawn, the rate, attempts, spend — and the
  decisions they settled are copied into this plan's As-shipped section.

## Contracts to update

- `pipeline-contracts.md`: identity specifications for `Shot.aspect` in `params`,
  `params.extra.sheet`, and the invalidation exception for lettered page shots (Decision
  11). Update generation and review sections with `ShotSpec.panels`/`lettering`,
  `DefectReport.observed`, and `panelBoxes` persistence rules.
- `gen-graphs.md`: document three new node types, two seeded inputs, `GenServices.pixels`,
  updated `Blend` rationale, force execution restrictions, and interactive runner seeding
  corrections.
- `playable-format.md`: document `show.panels`, `say.line`, `narrate.line` (Stage 3), and
  speech bubble definitions (Stage 5).

## Cost to undo

- **Stage 1 (Backend Aspect):** Transmitting `aspectRatio` affects all project tasks.
  Reverting restores prior behavior, but active re-renders will reflect output shifts.
  Task hashes remain unchanged across both states.
- **Stage 1 (Config/Aspect Types):** Fields are optional; removing them restores
  byte-identical prompt generation.
- **Stage 2 (Page Shots):** Fields are optional; removing the feature causes existing page
  shots to evaluate as standard single frames and re-render accordingly. Toggling between
  Stage 2 and Stage 5 re-keys all page shots rendered under `lettering: model`.
- **Stage 4 (Staging Sheets):** Removing `params.extra.sheet` invalidates cache keys only
  for shots explicitly assigned to staging groups.
- **Reviewer Specifications:** Exposing `ShotSpec.panels` and `lettering` adds metadata to
  execution logs and agent reports with no downstream side effects.

## Rejected alternatives

- **Project-level style profile.** Rejected because style directives are already handled
  via `art_style`, and structural requirements (aspect ratio, layout, lettering) vary per
  shot. Introducing a global profile would duplicate existing configuration paths without
  functional benefit (Decision 1).
- **Generating final pixels via sheet crop upscaling.** Rejected because cell resolutions
  are insufficient, panel geometries deviate from 16:9, and generative upscaling
  introduces detail drift. Sheets are restricted to staging references (Decision 16).
- **Dedicated `page_image` task kind.** Rejected to avoid branching logic across asset
  storage, export pipelines, document graphs, and coverage workflows (Decision 4).
- **Tracking sheet drift via `graphDrift` seed comparison.** Rejected because drift
  evaluation reports discrepancies without forcing re-planning, and graphs should dictate
  execution behavior rather than task invalidation timing. Ingestion into task input
  hashes preserves unified identity semantics (Decision 14).
- **Automated normalization of shot cast and coverage at write time.** Rejected because
  overwriting shot-level fields erases explicit edits from four existing mutators
  (Decision 8) and overrides manual coverage adjustments (Decision 9).
- **Reviewer personas in `ShotSpec`.** Rejected alongside style profiles; panel inspection
  rules are applied conditionally based on spec field presence.
- **Expanding the `framing` enum.** Rejected; staging nuance is handled via free-text
  `camera` inputs (Decision 12).
- **Bounding-box panel geometry.** Rejected; manga paneling requires non-orthogonal
  polygon definitions (Decision 5).
- **Injecting cell descriptions into derived prompts.** Rejected to prevent polluting task
  prompts and hashes in the legacy execution path (Decision 16).

## Open questions

- **Single-panel page representation:** Determine whether a single-panel page (splash)
  should be authored as a page shot or a standard frame with a vertical `aspect`. Both are
  supported; the decomposer currently emits splash shots as single-panel pages to enable
  lettering workflows.
- **Vendor aspect ratio validation:** Third-party providers in the four-vendor plan may
  reject `3:4` aspect ratios. `page_aspect` is passed directly to the active provider,
  surfacing unsupported ratios as provider validation errors.
- **Per-shot lettering configuration:** Determine whether `lettering` requires per-shot
  overrides rather than project-level configuration once mixed workflows are required.

## Review findings

The following findings from the initial design review have been addressed in this
specification:

1. **Gemini backend ignored `params.aspect`:** Resolved in Decision 3, Stage 1, and Cost
   to Undo.
2. **Bound graphs dropped task `params` before reaching image nodes:** Resolved in
   Decision 16 by writing the aspect into the node property and stating that the shot's
   `seed` rung does not apply under a bound graph.
3. **`params.extra.sheet` omitted generation dependencies:** Resolved in Decisions 14 and
   17 by hashing seeded prompt strings and ordered reference hashes.
4. **Cast normalization overwrote explicit author mutators:** Resolved in Decision 8 by
   keeping shot cast authoritative and validating panel assignments via schema checks.
5. **`setCoverage` lacked panel handling:** Resolved in Decision 9 by adding panel support
   to `CoverShot` and `CoverageOp.changed`.
6. **Inaccurate "coverage is free" invariant:** Resolved in Decision 11, adding explicit
   invalidation warnings and pricing to `story.setCoverage`.
7. **Derived review data flow desynchronization:** Resolved in Decision 7 and Data Model
   by persisting observed boxes via `refreshShotData` under `shotData.panelBoxes`.
8. **Missing playback beat line IDs:** Resolved in Decision 21 by adding optional
   `say.line` and `narrate.line` fields to playback beats.
9. **Global style profile coupling:** Resolved in Decision 1 by removing style profiles in
   favor of targeted per-shot properties.
10. **Landed status of the two open plans this one hedged on:** Corrected in the codebase
    facts section and Stage 2.
11. **Force runs on staging graphs produced stale crops:** Resolved in Decision 15 by
    rejecting force execution on multi-output graphs and routing invalidations through
    group seeds.
12. **Bound graph seed starvation:** Resolved in Decision 17 by computing seeds centrally
    and passing them through `GraphRunOptions`.
13. **Missing config context in `decomposeScene` and `shotSpec`:** Resolved in Stage 1 by
    updating decomposer call sites; removed config requirements from `shotSpec` by
    eliminating personas.
14. **Unallocated cell staging prompt text:** Resolved in Decision 16 by embedding cell
    directives in authored `GenTemplate` nodes.
15. **Inappropriate dependency placement for image manipulation:** Resolved in Decision 18
    by locating `jimp` operations in `@vn/pipeline` behind `GenServices.pixels`.
16. **Inaccurate codebase references:** Corrected file paths, line references, and
    terminology across codebase facts and Decisions 8 and 14.
17. **Invalid test verification strategy for fixture hashes:** Resolved in Stages 1 and 4
    by updating existing test pins and documenting fixture invalidation costs.
18. **Incomplete undo cost analysis:** Documented all rollback costs in Cost to Undo.
19. **Ambiguous implementation steps:** Clarified explicit tasks, file targets, and
    command structures across Stages 1, 2, and 4 and Decision 16.

## As-shipped

### Stage 1

- **The OpenRouter plugin posts to `/api/v1/images`, not `/api/v1/chat/completions`.** The
  harness section names the chat-completions route with `modalities: ['image', 'text']`.
  At implementation time OpenRouter documents a dedicated image endpoint,
  `POST /api/v1/images`, and that is the only route carrying `aspect_ratio`, `seed` and
  `input_references`, which are the three things the Stage 1 check needs. Its reply is
  `{ data: [{ b64_json, media_type }], usage: { cost } }`. The plugin sends
  `provider: { data_collection: 'deny' }` on every call (the privacy research's
  recommendation) and leaves `zdr` off, as the harness section says.
- **The plugin records `cost`.** OpenRouter reports what each call cost in the reply, so
  the node writes it to the run's journal as a `cost` output beside `modelId` and
  `prompt`. Nothing reads it yet; it is what the live-test spend column comes from.
- **The plugin declares no `prices` fragment and no price agent.** OpenRouter prices each
  model as its provider does (per image for some, per token for Google's), and the
  plugin's estimate is one `image` line for the named model, which an author's own price
  table can price or leave unpriced.
- **`KeyVendor` is a superset of `ChatVendor`, not a widening of it.** `KEY_VENDORS` gains
  `openrouter`, and `ResolvedKeys` is `Record<KeyVendor, string>`. `ChatVendor` stays
  `'gemini' | 'anthropic'`, because no chat backend calls OpenRouter and `threads.ts` and
  `convo.ts` index by it. `resolveKeys` now loops the vendor list rather than naming each
  vendor.
- **`project.testKey('openrouter')` calls `GET /api/v1/key`.** The generic path finds a
  configured chat model for the vendor and there is none for OpenRouter, so the Setup
  pane's test button would have refused. The key endpoint describes the key it was sent
  and bills nothing, which is the cheap call the button promises.
- **The key guide gains an `## OpenRouter` section** because `keyGuideProblems` requires
  one per `KEY_VENDORS` entry; the intro now says the OpenRouter key is optional.
- **A shot's `aspect` and `image_params.page_aspect` are validated as `W:H`.** Both
  schemas share one `aspectRatio` string type with a whole-number `W:H` pattern, so a
  shots file or a `project.yaml` saying `4x3` or `1.5` is refused at parse time rather
  than reaching a backend. `Shot.aspect` itself stays a plain string.
- **`project.setLettering` prices zero page shots for now.** Its preview says how many
  page shots the change re-keys, and `pageShotCount` answers zero until Stage 2 gives a
  shot panels. Both new commands mirror `project.setArtStyle` exactly: mutating, undoable,
  `affects: ['project.yaml']`, no confirmation.
- **The two commands are palette-only, and Stage 1 regenerated the UX model after all.**
  Every registered command must be a drawn control in `ux-model.json` or a `paletteOnly`
  entry with a reason, and `anchors.json` pins the registry's full id list, so adding a
  command with no control means an entry in `apps/desktop/renderer/rules/paletteonly.ts`,
  `pnpm gen:uxmodel`, and a re-sweep of `anchors.json`. The plan said Stage 1 touched no
  rule module; the reasons list lives under `rules/**` all the same. The entry must come
  out again in the stage that draws the fields, because the list is checked both ways. The
  re-sweep ran against `examples/mySampleRepo` in `--mock`, as the earlier sweeps did, and
  its only other change is the OpenRouter row the Setup pane now draws.
- **`decompSystem(style)` splices the style between the role and the format.** The two
  style sentences (`The frames will be drawn in this art style: …` and
  `Storyboard notes from the author: …`) go between the unchanged role paragraph and the
  unchanged format paragraph, each only when its key is set, so with both keys empty the
  prompt is byte for byte the old `DECOMP_SYSTEM`. The pinned prompt tests check that.
  `LoadedWorkspace` carries the pair as one `style: StoryboardStyle` field.
- **`@google/genai` is bumped from 0.3.1 to 2.22.0, because 0.3.1 never sent the ratio.**
  The live check found the built-in backend returning 1024×1024 at every ratio: the old
  SDK's config converter copies a fixed list of fields onto the wire and `imageConfig` is
  not on it, so the field commit 3ecd62b5 added was dropped in the process. The same
  backend code through 2.22.0 returns 1344×768, 864×1184 and 768×1344. The bump is its own
  commit; the backend's call shape (`generateContent`, `res.text`, `candidates`,
  `usageMetadata`) is unchanged across the two versions, and the fake-SDK tests never
  loaded the real one.
- **The live check ran through a scratch driver, not bound graphs.** The harness section
  binds one graph per model to a slot, which the pipeline-running stages need. Stage 1
  needs only bytes, so the driver bundled the backend, the plugin's `drawWithOpenRouter`
  and `buildShotPrompt` and called them directly. Results, spend and the model table are
  in [`../research/manga-live-tests.md`](../research/manga-live-tests.md): 40 of 52
  OpenRouter models honour all three ratios within 3%, every miss is a quoted provider
  refusal, and `3:4` stands as the default `page_aspect`. Two things the check turned up
  and Stage 1 leaves alone: Recraft's four `styles` models declare ratios their endpoint
  refuses, and its vector models answer with an SVG the plugin passes through as
  `ext: 'svg+xml'`.

### Stage 2

- **The decomposition schema makes `framing` optional and takes a `layout` name.** A page
  the model writes has no single framing, so the schema lets a page leave it out and
  `realizeDecomposition` gives it the first panel's (`medium` when a frame leaves it out
  too). Panels may carry outlines or not: a page whose panels all carry `shape` keeps
  them, and any other page takes `shapesFor(layout, n)`, which is the named template at
  its own panel count and `evenLayout(n)` (tiers of two, an odd last panel spanning its
  tier) otherwise. The decomposition schema caps `panels` at six, the bound `MAX_PANELS`
  tells the model; the shots-file schema caps nothing, since the file is the author's.
- **A page's cast is the union of what the shot named and what its panels name.** Decision
  8 derives the cast from the panels alone; keeping the shot's own list as well lets the
  model cast a silent character on the page without a panel naming them. A character
  reached only through a panel is cast bare, since the panel rung holds the pose.
- **The page vocabulary reaches the decomposer with `storyboard_notes` alone.**
  `art_style` says how a frame is drawn, not whether scenes are pages, so a project with a
  manga art style and empty notes still storyboards frames, and its prompt never contains
  the word "panel". With notes set the system prompt gains a page paragraph (the template
  names with their panel counts, the camera vocabulary, the bound) and the wider answer
  format.
- **`panel_subject_not_in_cast` is thrown by `readShots`, and `line_in_no_panel` is a list
  it returns.** The plan filed both under "the model validator", but `@vn/model` never
  reads a shots file; the store does. A panel naming someone outside the shot's cast makes
  the file unloadable with that code, like any malformed file, because either the cast or
  the panel could be the mistake. A covered line no panel letters is
  `LoadedShots.unpanelled`, which the planner logs; the page still renders. A panel line
  the shot itself does not cover is cut at read, silently, because the shot's
  `coversLines` is the authority and a screenplay edit that drops a line is already
  reported once through `dropped`.
- **`sheets` is carried by `writeShots` like `nextShot`.** A writer that says nothing
  keeps the file's groups; `Decomposition.sheets` carries the model's proposal to the
  three writers of a fresh storyboard. Nothing reads the groups until Stage 4.
- **`LAYOUT_IOU` is `0.5`, pending the live check.** `matchPanels` claims, per intended
  panel in reading order, the best unclaimed observed box at or above it; a page is
  honoured when every panel matched and no box was left over. The same rule files the
  `layout` defect and scores the live table.
- **The `layout` defect is filed by the runner, as a report of its own.** The plan's
  Decision 7 has the reviewer file it, but the reviewer never sees the intended outlines
  (`ShotSpec.panels` carries words, not geometry) and `@vn/providers` holds no layout
  rule. `makeShotRunner` takes the first review that measured anything, matches its boxes
  with `layoutDefect`, and appends `{ reviewer: 'layout', defects }` to the attempt's
  reviews before merging, so the verdict is attributable. A page no reviewer measured gets
  no verdict at all, which is what keeps the mock reviewers (and any vision model that
  answers nothing about panels) from blocking every page.
- **`shotSpec` takes the lettering mode as a fourth argument, not the config.** The runner
  passes `config.lettering`; every other caller passes nothing and gets a spec without the
  `lettering` key. The reviewer's system prompt is now assembled per spec: the unchanged
  base sentence, plus the panel rule when `spec.panels` is set and the lettering rule when
  `spec.lettering` is, so a frame's review is byte for byte what it was. `observed` is
  kept only on a page's report, whatever a model volunteers on a frame.
- **The page prompt's exact shape.** `style`; `page` ("A manga page of N panels in
  <location> (<variant>). Layout: panel 1: …; panel 2: …"); one `panel-<i>` per panel
  ("Panel i (<framing> shot): <cast with clothes, pose, expression>. camera: …. art
  direction: …."); `lettering` ("Lettering, verbatim: panel 1: caption "…", NAME says "…";
  …", empty under `runner`); the shot's `art-notes`; and the scaffolding sentence, which
  says "no UI text" under `model` and "no text or lettering of any kind" under `runner`. A
  panel's cast is drawn from the shot's `subjects` (a panel naming anyone else contributes
  nothing, and the store refuses the file), and the page's own `camera` is ignored, as the
  plan says.
- **`panelBoxes` is stamped only with new bytes, from the attempt that drew them.** The
  same rule as `proseHash`: a rerun that reports the same image leaves the boxes alone,
  and a page with no image has none. The planner re-parses the attempt's review through
  `defectReportSchema`, since attempts record reviews untyped.

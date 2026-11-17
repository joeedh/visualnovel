# Workflows and narrative engines

This note looks at how the repo would support more than one production workflow (visual
novel, manga, storyboard, previz, animation, film) and more than one narrative engine
(linear, branching graph, storylets). It records where the code fuses those concerns
today, proposes where the seams should go, and lists the decisions that need to be made
before anyone writes a plan. A storylet engine is assumed to live in its own repository.

<!-- toc -->

- [Three axes that are fused today](#three-axes-that-are-fused-today)
- [Where the fusion is in the code](#where-the-fusion-is-in-the-code)
    - [Narrative structure lives on `Scene` and `ProjectModel`](#narrative-structure-lives-on-scene-and-projectmodel)
    - [Production data hangs off `Scene` in memory, but not on disk](#production-data-hangs-off-scene-in-memory-but-not-on-disk)
    - [The task vocabulary is closed in several places](#the-task-vocabulary-is-closed-in-several-places)
    - [What is already modular](#what-is-already-modular)
- [Proposed shape](#proposed-shape)
    - [Three layers](#three-layers)
    - [The narrative seam](#the-narrative-seam)
    - [The storylet repo boundary](#the-storylet-repo-boundary)
    - [Workflows as planner modules over an open task registry](#workflows-as-planner-modules-over-an-open-task-registry)
    - [Two production families, not six workflows](#two-production-families-not-six-workflows)
    - [Data model packages](#data-model-packages)
    - [Hosts: desktop editors and agent tools](#hosts-desktop-editors-and-agent-tools)
- [Reconciling this with manga's "one mode, not two"](#reconciling-this-with-mangas-one-mode-not-two)
- [Risks and invariants](#risks-and-invariants)
- [Suggested sequence](#suggested-sequence)
- [Decisions needed](#decisions-needed)

<!-- tocstop -->

## Three axes that are fused today

- **Script.** Characters, locations, scenes, lines and line ids. This is the authored
  content, and it is the same whatever the output medium or the narrative engine.
- **Narrative structure.** How scenes connect: a straight sequence, an explicit graph of
  choices, or storylets selected at runtime by conditions on state.
- **Production.** What gets made from the script: VN frames, manga pages, storyboard
  boards, previz shots, animation clips, film shots. This decides the asset kinds, the
  task kinds, the decomposer, the reviewer, and the export format.

Today the code treats all three as one thing, the visual-novel model. Supporting new
workflows and engines is mostly a matter of pulling these three apart along seams that are
already partly visible.

## Where the fusion is in the code

### Narrative structure lives on `Scene` and `ProjectModel`

- `Scene.choices` and `Scene.next` (`packages/types/src/entities.ts`) are the branching
  model. `ProjectModel.entry` and `ProjectModel.reachable` (`packages/types/src/model.ts`)
  are its derived state.
- `@vn/parse` owns the branch syntax (`[[choice: … -> id]]`, `[[next: id]]`), and
  `@vn/model` validates it (every `goto` targets a real scene, reachability, dead scenes).
- Consumers of `.choices`/`.next` span `@vn/model`, `@vn/scriptedit`, `@vn/authoring`,
  `@vn/export`, `@vn/providers`, the desktop main process and the renderer (the Branches
  editor).
- The planner iterates `reachableScenes(model)` (`packages/pipeline/src/planner.ts:314`).
  That is the only thing production needs from the narrative: which scenes are worth
  paying for.
- The playable keeps per-scene beats separate from the branch edges
  (`packages/export/src/playable.ts:224`), so the presentation side is already close to
  engine-neutral.

### Production data hangs off `Scene` in memory, but not on disk

- `Scene.shots` and `Scene.sheets` are production data on a script object. The planner
  assigns them (`scene.shots = storyboard.shots`, `planner.ts:326`).
- On disk they are already separate: shots live in `work/shots/<sceneId>.json`, which
  `@vn/store` reads and writes, while the scene chunk under `scenes/` holds only the
  script. The split this note proposes exists in the files and is lost only when the model
  is built.
- `Shot` has accumulated the manga fields (`panels`, `aspect`, `sheet`, `panelBoxes`), so
  the one production type already carries two styles.
- Moving these fields is wide but mechanical: `.shots` has about 148 references in 50
  files, and `.sheets` about 22 in 12 files, outside tests.

### The task vocabulary is closed in several places

Adding a task kind today means editing all of these:

- `TaskKind` and `TaskInputs` in `packages/types/src/tasks.ts` (a closed union and a
  closed map).
- `createRunners` in `packages/pipeline/src/runners.ts`, which returns
  `Record<TaskKind, Runner>`. Three of its seven entries are placeholders that fail.
- `costPreview` in `packages/pipeline/src/pipeline.ts`, which branches on kind names.
- `AssetKind` and `AssetBinding` in `entities.ts`. `AssetBinding` is a fixed set of
  optional fields (`characterId`, `outfit`, `angle`, `locationId`, `variant`, `sceneId`,
  `shotId`).
- `slotKey`, `slotLabel` and `parseSlot` in `packages/artgen/src/slotaddr.ts`, a closed
  switch over `portrait | sheet | plate | shot | asset`.
- `planTasks` (`planner.ts`), a single function that runs P2 to P7 in sequence.

`packages/types/src/model.ts` also declares a `Phase` interface (`handles`, `plan`, `run`)
that nothing implements or imports. It is an early version of the modular planner this
note proposes, and it should either be revived in the shape below or deleted.

### What is already modular

- `@vn/taskgraph` itself is generic: hashing, the DAG, the status log. It is 566 lines and
  knows nothing about VN beyond the `TaskKind` type parameter.
- `@vn/gengraph` already decides _how_ one slot is produced, and its plugins can add node
  types. New output media (video, audio) would arrive as node types and providers. What
  gengraph cannot do is decide _which_ slots exist; that is the planner's job.
- `@vn/commands` is domain-agnostic, and `@vn/providers` is behind a backend seam.
- `prompthash.test.ts` in `packages/pipeline/src/tests` pins every task hash for a fixture
  project. That test is the guard the whole refactor needs, and it already exists.

## Proposed shape

### Three layers

- **Script layer.** Characters, locations, scenes, lines, line ids, outfits, and the
  scene-chunk format. No branching and no shots. Every engine and every workflow reads it.
- **Narrative layer.** One implementation per engine. It owns its own syntax and
  validation, and exposes a small interface to production (below).
- **Production layer.** One module per production family. Each module declares its task
  kinds, its planner phases, its unit types (shot, page, board, clip), and its exporters.
  A shared base-asset module (portraits, model sheets, location plates) sits under all of
  the visual families, because every one of them needs consistent characters and sets.

### The narrative seam

Production needs very little from the narrative engine. A sketch:

```ts
interface NarrativeStructure {
    /** Engine id: 'linear', 'branching', or an external engine's name. */
    readonly engine: string;
    /** Scene ids in a stable order, which the planner and the editors list by. */
    scenes(): readonly string[];
    /** Whether a scene is worth producing art for. Today this is reachability. */
    live(sceneId: string): boolean;
    diagnostics(): readonly Diagnostic[];
}
```

- `branching` is today's code moved behind the interface: the markers, `goto` checks,
  reachability, the Branches editor.
- `linear` is the cheap second implementation that proves the seam: scene order is the
  file order or a list in `project.yaml`, and every scene is live. If the planner, the
  playable and the editors work under `linear` without special cases, the seam is real.
- Continuity across scene boundaries (staging, outfits carried over) may later want an
  adjacency query. Add it when a workflow needs it, not up front.

### The storylet repo boundary

- **Recommendation: the boundary is a file format, not a code import.** This matches how
  the repo already treats Fountain on the way in and `story.play.json` on the way out.
- Scenes stay in this repo's scene-chunk format. The storylet repo authors the selection
  logic (qualities, preconditions, effects) and writes a manifest that names the scene ids
  each storylet presents.
- A `storylet` narrative adapter in this repo reads that manifest and implements
  `NarrativeStructure`. Liveness comes from the storylet solver's own reachability
  verdict, if it exposes one, or else every referenced scene is live.
- The storylet runtime does the routing at play time, so for a storylet project the
  playable's branch edges are omitted and only the per-scene beats and assets are
  exported.
- If the storylet repo also wants to read and write scene chunks in code, it needs the
  script layer as a publishable package with no dependency on production. That is the
  strongest argument for the package split below.
- Open question: storylets often vary a scene by state (a character wears something
  different if a quality is set). Each variant is a separate production unit and a
  separate cost. The manifest needs a way to name variants, and the planner needs a way to
  price them before generating.

### Workflows as planner modules over an open task registry

- Replace the closed `TaskKind` union with a registry of kind specs:

    ```ts
    interface TaskKindSpec<I> {
        /** Stable name; it enters the task hash, so it never changes once shipped. */
        kind: string;
        inputs: z.ZodType<I>;
        run: Runner;
        /** The slot a done task fills, for `slotKey`, the asset browser and the gallery. */
        slotOf?(inputs: I): SlotBinding;
        cost?(task: Task<I>): CostLine;
    }
    ```

- `createRunners`, `costPreview` and the slot vocabulary then read from the registry
  rather than switching on names.
- [`pipeline-contracts-into-code.md`](pipeline-contracts-into-code.md#merging-the-generation-graph-with-gengraph)
  changes this sketch. If every slot runs through a gen graph, `run` becomes a default
  subgraph, and a new medium arrives as node types rather than as a runner.
- A planner phase emits tasks given the model, the graph and the assets. `planTasks`
  becomes a loop over the workflow's phases: the base-asset phases (today's P2 to P4) and
  then the family's production phases (today's P5 to P7 for stills).
- A workflow is a value that lists its kind specs, its phases, its unit schema, its
  decomposer and reviewer prompts, and its exporters. The project selects one in
  `project.yaml` (for example `workflow: vn`), defaulting to today's behaviour.
- Keep it typed. A fully dynamic plugin registry is not needed yet; workflows can be
  compiled-in modules until a third party needs to add one. gengraph plugins already cover
  the "add a new kind of generator" case.

### Two production families, not six workflows

- **Stills.** VN, manga and storyboard all produce still images bound to lines. They share
  the base assets, the `shot_image` task, the decomposer shape and the review-and-refine
  loop. They differ in per-shot properties (aspect, panels, lettering) and in export
  (playable, site, page PDF, animatic).
- **Time-based.** Previz, animation and film produce material with duration: clips, camera
  moves, timing, and eventually audio. They need new providers (video models), new task
  kinds, a unit with duration, and a timeline export (OpenTimelineIO or an EDL), none of
  which exists today.
- Storyboard is the cheapest workflow for proving the seams. It is a stills workflow with
  timing and camera notes, reuses almost every task kind, and adds one new export (an
  animatic or a board PDF). Building it first exercises the workflow module and the
  exporter seam without also needing video generation.

### Data model packages

- `@vn/types` holds every shape in the project. Splitting it into separate packages is
  wide churn. The repo already uses second entry points (`@vn/scriptedit/write`,
  `@vn/gengraph/state`), so the first step can be subpath entries: `@vn/types/script`,
  `@vn/types/narrative`, `@vn/types/production`. If each entry is a folder, registering it
  as a `vn/element-types` element forbids the script entry from importing the others
  ([`pipeline-contracts-into-code.md`](pipeline-contracts-into-code.md#what-in-code-means-for-each-contract)
  covers what the rule can express).
- `@vn/parse` splits the same way: Fountain and line ids belong to the script layer, and
  the `[[choice]]`/`[[next]]` markers belong to the branching engine.
- `@vn/model` keeps the builder, but the builder composes a script model, a narrative
  structure and, separately, the production data loaded from `work/`.
- Promote the script layer to a real package (working name `@vn/script`) only when a
  second repository needs to import it. Until then, subpath entries give the same
  dependency discipline for less churn.

### Hosts: desktop editors and agent tools

- Editors and agent tools stay in the hosts, because `vn/element-types` keeps renderer
  code out of `packages/`. A workflow does not own its editors.
- The hosts gate by the project's workflow and engine instead. The Branches editor appears
  for `branching`; Shot Coverage and the storyboard tools (`set_coverage` and related,
  `packages/authoring/src/tools/storyboard.ts`) appear for the stills family.
- Agent skills such as `full-production` are workflow-specific and should say which
  workflow they assume.

## Reconciling this with manga's "one mode, not two"

[`manga-shot-composition.md`](manga-shot-composition.md#one-mode-not-two) argued against a
project-level manga mode. Its argument holds, and this note does not reopen it:

- VN and manga differ in per-shot properties, so they stay one family and can be mixed
  shot by shot, as shipped.
- The argument does not extend across families. A clip's duration, motion and audio are
  not per-shot properties of a still frame. They need different providers, task kinds and
  exporters, which is exactly the doubling of contracts the manga note wanted to avoid
  inside one family.
- So the project-level setting proposed here selects a family and an engine, never a style
  inside the stills family.

## Risks and invariants

- **Task identity.** A task's hash is `hashParts(kind, identityOf(inputs))`
  (`packages/taskgraph/src/hash.ts`). The registry must keep every shipped kind name and
  every input shape byte-identical, or every existing project regenerates its art.
  `prompthash.test.ts` must pass unchanged at every step, and its baseline must never be
  regenerated to make a refactor pass.
- **Slot addresses** are typed by authors and stored in graphs (`plate:cafe/night`,
  `shot:s1/a`). New families add new prefixes; the existing ones never change spelling.
- **The playable and the committed site renderer** ship into authors' repositories. A new
  family gets its own exporter rather than a branch inside `buildPlayable`.
- **`work/shots/<sceneId>.json`** is already the production file. A new family adds its
  own file under `work/` rather than widening `Shot` again.
- **Undo and `affects`.** New production files need entries in the `affects` vocabulary
  (`apps/desktop/src/shared/affects.ts`).

## Suggested sequence

Every step moves code across package boundaries; `vn/element-types` and `vn/no-cycle`
check each one, and a new package or subpath entry is added to their element list as it
lands.

1. **Separate production from script in the in-memory model.** Move `Scene.shots` and
   `Scene.sheets` into a production map keyed by scene id, matching the on-disk layout. No
   behaviour changes; hashes are pinned.
2. **Narrative seam.** Introduce `NarrativeStructure`, move branching behind it, and add
   `linear` with tests that run the planner and the exporter over a linear project.
3. **Open task registry.** Replace the closed `TaskKind`, `createRunners`, `costPreview`
   and the slot switch with the registry. Delete or replace the unused `Phase` interface.
4. **Planner phases.** Split `planTasks` into the base-asset phases and the stills
   production phases, and assemble today's VN workflow from them.
5. **Storyboard workflow** as the first new workflow, which proves the module and exporter
   seams.
6. **Storylet adapter**, once the storylet repo has a manifest to read. Publish the script
   layer as a package at that point if the storylet repo needs code access.
7. **Time-based family** (previz, animation, film): video providers, clip units, timeline
   export. This is the largest step and depends on all of the above.

Steps 1 to 4 change no behaviour and can each land green on their own. Steps 1 and 2 are
independent of each other.

## Decisions needed

| #   | Decision                                                  | Leaning                                                                 |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Storylet boundary: file format or code dependency         | File format (a manifest of scene ids); code access only if needed       |
| 2   | Is the project-level setting a family, or a workflow name | A workflow name that maps to a family; styles mix within a family       |
| 3   | Can one project mix families (film with VN extras)        | No, until a real project needs it                                       |
| 4   | Split `@vn/types` into packages or subpath entries        | Subpath entries now; a `@vn/script` package when a second repo needs it |
| 5   | First new workflow                                        | Storyboard, because it reuses the stills family                         |
| 6   | Registry: compiled-in modules or runtime plugins          | Compiled-in; gengraph plugins already cover new generators              |
| 7   | Where the repo and package names stop saying "vn"         | Not now; revisit if the time-based family ships                         |

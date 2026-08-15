# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository. This file is the map:
what the packages are, what the invariants are, and where the full write-up of each area
lives. Deep as-shipped detail is in [`docs/`](docs) — follow the pointers rather than
duplicating them here.

## What this is

**VN Generator** — a pnpm/TypeScript monorepo that turns authored inputs (characters, a
branching Fountain screenplay, optional locations + reference images) into a **deduped,
resumable pipeline of generated art assets plus a provenance manifest**.

The design separates **deterministic plumbing** (parse, validate, dedupe, layout,
schedule) from **generative steps** (LLM / image-model calls). Package boundaries mirror
that split and are enforced by lint rules, so the input-side packages can be reused
without pulling in the generative pipeline.

- Docs index: [`docs/index.md`](docs/index.md)
- Design: [`docs/vn-generator-report.md`](docs/vn-generator-report.md)
- Pipeline contracts (the invariants below, in full):
  [`docs/pipeline-contracts.md`](docs/pipeline-contracts.md)
- Debugging guide: [`docs/debugGuide.md`](docs/debugGuide.md) — read this before debugging
  anything in this repo; tools ordered cheapest-first, evidence over reproduction
- **Out of scope:** _external_ engine export (Ren'Py/Ink/etc.). The generative pipeline core
  stops at a populated `build/` + `manifest.json`. On top of that sits a small, in-house
  **playable** (`vngen export` → `story.play.json`) and a **desktop runner** to actually
  watch a generated VN.

Alongside the pipeline is **`vnauthor`**, a plan-first conversational agent that helps an
author write and refine the _inputs_ (characters, screenplay, locations). It lives entirely
on the input side and is forbidden — by a boundaries lint rule — from importing the
generative pipeline.

## Commands

Run from the repo root.

| Task                         | Command                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Typecheck (the gate)         | `pnpm check`                                                            |
| Test (all)                   | `pnpm test`                                                             |
| Test one package             | `pnpm exec jest --selectProjects @vn/taskgraph`                         |
| Lint (eslint + format check) | `pnpm lint`                                                             |
| Auto-format                  | `pnpm format`                                                           |
| Update docs TOCs             | `pnpm markdown-toc` (skips `docs/plans/*.md`)                           |
| Bundle everything            | `pnpm build` (turbo: `vngen`, `vnauthor`, and the desktop app)          |
| Run the CLI                  | `node apps/cli/dist/cli.js <cmd>` (or `pnpm vngen <cmd>`)               |
| Run the authoring agent      | `node apps/authoring/dist/vnauthor.js [dir]` (or `pnpm vnauthor [dir]`) |
| Run the desktop app          | `pnpm vndesktop [--mock]` (built app, CDP on 9222)                      |

`pnpm check`, `pnpm test`, and `pnpm lint` should all be green before and after any change.

The toolchain's shape — and every deliberate deviation from the original plan — is
[`docs/toolchain.md`](docs/toolchain.md). Four things bite often enough to repeat here:

- `pnpm check` is **two** passes: the flat workspace check plus `pnpm check:renderer`, because
  `apps/desktop/renderer/**` lives outside `src/` and nothing else typechecks it.
- **Tests must live in a `tests/` subfolder** beside the code they cover; a `*.test.ts`
  anywhere else is silently never run.
- Internal packages are **source-only** (no per-package `dist`) — consumers import
  `src/index.ts` directly. esbuild transpiles; only `tsgo` type-checks.
- Imports use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).

## Architecture

### Package layering

Acyclic, enforced by `eslint-plugin-boundaries` + `import/no-cycle`. What each package is
responsible for, and the rules behind this diagram, are in
[`docs/packages.md`](docs/packages.md).

```
types  util
  │     │
config  parse
  │     │ │
  │   model store ─ export scriptedit bible artgen   git ──── commands
  │     │   │  │  ╲     │
  │     │  taskgraph ╲  │
providers   │      ╲ ╲  │
  │  │      │       authoring ── authoring-app (vnauthor)
  └──┴── pipeline
            │
        scheduler
            │
           cli
```

- **The pipeline spine and the authoring branch are disjoint below `@vn/store`.**
  `@vn/authoring` reuses the input-side packages but **must never import `@vn/pipeline` or
  `@vn/scheduler`**.
- **Four leaves share that constrained allow-list** — `@vn/export`, `@vn/scriptedit`,
  `@vn/bible`, `@vn/artgen` — each because two hosts (the desktop app and `vnauthor`) must run
  the same rules, so the rules can live in neither.
- **The boundaries rule is per import statement, not transitive**, so reaching the pipeline
  through a leaf is not a loophole.
- **Two packages sit outside the graph.** `@vn/debug2d` imports nothing from `packages/` and is
  dev-only in the renderer; `@vn/testkit` may import every layer and **nothing may import it**.

### Core ideas

Each is a contract that costs money or corrupts provenance when broken. Full statements, each
with the failure it prevents: [`docs/pipeline-contracts.md`](docs/pipeline-contracts.md).

- **Content-addressed task graph.** Identity is `sha256(kind, inputs)`; replaying
  `state/tasks.jsonl` rebuilds the graph, which is what makes a run resumable and crash-safe.
- **Content-addressed asset store, in two roots.** Base art at `assets/`, shot frames at
  `vngen/build/assets/`, each with its own manifest; a base root present without a readable one is
  `unavailable` and the planner plans **nothing**. ([`docs/asset-stores.md`](docs/asset-stores.md))
- **Gate-as-barrier.** The P3 character-approval gate is a planner predicate, not a task
  dependency: a run halts with nothing ready. Scenes with no cast render immediately.
- **Incremental planning.** The planner runs once per wave, so `vngen cost` counts only
  _currently-plannable_ work and undercounts what a later wave unlocks.
- **A terminal task records why, is retried once, and is reported from the live plan** — both the
  requeue and `RunSummary.failed` intersect the planned set, because `tasks.jsonl` holds orphans.
- **Shot decompositions are persisted, not re-derived.** `work/shots/<sceneId>.json` wins forever
  after it exists; `buildShotPrompt` ignores `coversLines`, so coverage edits rehash nothing.
- **A shot's order is where its lines sit**, so `story.moveShot` is a prose edit that rehashes
  nothing; a non-contiguous shot is refused by name.
- **What a character wears is inherited, and the chain is written down once** — `outfitFor`:
  shot-subject override → the scene's `[[outfit:]]` marker → `character.defaultOutfit`. Unlike
  every other scene edit it **does** re-render, because the outfit is in `buildShotPrompt`.
  ([`docs/plans/outfits-at-scene-and-shot-level.md`](docs/plans/outfits-at-scene-and-shot-level.md))
- **Art direction is an authored field, and it deliberately re-renders.** `artNotes` is free text
  at five rungs, **appended** to what was derived; authoring none leaves prompts byte-identical.
  ([`docs/plans/asset-names-and-the-asset-editor.md`](docs/plans/asset-names-and-the-asset-editor.md))
- **A concept is a picture the pipeline never asked for**: bound to what it sketches, never
  planned, consumed, exported or `accepted`, and its `sourceTask` hashes the request.
- **A concept's prompt is authored, so it is the one prompt an author may edit** — `art.redraw`
  files the rewrite as a new sketch, and `asset.regenerate` refuses a concept by name.
- **Promotion adopts rather than regenerates**: `promoteConcept` writes the variant, re-records
  the bytes, and logs the plate's task `done` — the one such record written outside the scheduler,
  computed from the sheet it just wrote so it cannot forge work.
  ([`docs/plans/on-demand-concept-images.md`](docs/plans/on-demand-concept-images.md))
- **No scene edit invalidates art, so drift is reported instead** — `Shot.proseHash` beside the
  image, `driftOf` re-derived on every read; never a stored flag, never the task hash.
- **Line ids are allocated and written down, and reading never writes.** Persisting is the
  undoable `story.assignLineIds`, which re-parses its own patch and discards it unless the scenes
  come back identical.
- **A scene survives a trip through text: `parse(write(scene)) ≡ scene`.** `sceneToFountain`
  writes from `Scene.lines` (there is no `Scene.body`) and forces anything re-readable as another
  element. Blank lines are structural.
- **One scene, one file — and a writer patches the file the model was built from.** A multi-chunk
  patch is computed in full before any of it is written; front-matter is spliced byte-exactly.
- **An entity is found by its tag, and the file it was found in travels with it** — every
  `type:`-tagged sheet is an `EntityDoc` carrying its own path, and `entityFile(docs, id)` is the
  only way to ask where one lives. Conflicts are diagnostics, never a throw.
  ([`docs/plans/entity-discovery-by-meta-tag.md`](docs/plans/entity-discovery-by-meta-tag.md))
- **The story bible is reached by query, never pasted** — no whole-file API, and that absence is
  the guarantee. ([`docs/story-bible.md`](docs/story-bible.md))
- **P7 generate→critique→refine is folded into the `shot_image` runner**, capped by
  `config.max_refine_attempts`, flagging `needs_human` rather than looping. The reviewer is told
  what the _shot_ ordered, never the scene synopsis.
- **Deterministic fallbacks.** P1/P5 use the LLM with structured-output enforcement but fall back
  to a baseline on any failure, so the pipeline runs end-to-end with mock providers.
- **Provider seams.** The scheduler never imports a concrete provider — only `Task`, `deps`,
  `status`. Backends swap by changing model ids in `project.yaml`.

## CLI

```
vngen run | approve | status | graph | export | cost | import | screenplay   [dir]
```

Flags, `--mock` semantics, key resolution, the on-disk project layout, and the
`examples/sample` walkthrough: [`docs/cli.md`](docs/cli.md). Two things worth knowing before
running anything: `--mock` writes no assets and needs no keys, and in a real project `vngen/` is
**committed** — it is the reproducible output of a run, not something to gitignore.

## Playable & desktop app

The pipeline is presentation-agnostic — it stops at `manifest.json`. `@vn/export` projects the
model + manifest into a small in-house **playable** (`story.play.json`), and the Electron app
plays it. This is deliberately **not** an external DSL export.

- Playable format: [`docs/playable-format.md`](docs/playable-format.md).
- The app — shell, canvas, the twelve editors, the session store, the seeded workspace:
  [`docs/desktop-app.md`](docs/desktop-app.md). What persists where:
  [`docs/desktopAppState.md`](docs/desktopAppState.md). The sidebar's document tree:
  [`docs/document-tree.md`](docs/document-tree.md).
- **One workspace at a time, and opening another is a teardown** — the session, the command stack
  and the undo journal are rebuilt against the new root, so undo never crosses a project boundary
  and nothing may cache the root. **Creating one scaffolds where opening does not**:
  `workspace.create` writes a three-file skeleton whose model builds with no error diagnostics,
  commits it, then opens it through the same path — and refuses a directory that already has files
  in it. ([`docs/plans/new-and-open-project.md`](docs/plans/new-and-open-project.md))
- **A document that is not a scene is written as text, and only by `doc.*`.** A save presents the
  hash it read at and is refused by **content**, never mtime; `scenes/**` is refused outright,
  because prose has one write path and it is `story.*`. A _named field_ inside a sheet may still
  be set by a command that round-trips through `@vn/model`'s `apply*Edit`.
- **An asset is named, and one pane answers for it** — the document tree labels assets by what
  they are, and the asset editor shows the derived prompt read-only beside editable art notes.
  ([`docs/plans/asset-names-and-the-asset-editor.md`](docs/plans/asset-names-and-the-asset-editor.md))
- **What was drawn from a document is one widget, and a scene is a subject like any other** —
  backlinks are keyed by `scene:<id>` as well as by entity, `DocTree.pathIndex` inverts the key
  convention for a pane that holds only a path, and `renderAssetStrip` is the read-only strip
  Documents, Wiki and Script all draw. Nothing binds to a lore note, and the strip says so.
  ([`docs/plans/asset-cross-references.md`](docs/plans/asset-cross-references.md))

The renderer is a **path.ux screen mesh**: the window subdivides into panes, each pane shows one
editor. path.ux is a git submodule at `vendor/path.ux` — a fresh clone needs
`git submodule update --init --recursive`, and `pnpm doctor` says so by name. There is no React
and no room vocabulary. The rules are stated in full in
[`docs/desktop-app.md`](docs/desktop-app.md); the ones that bite hardest:

- **The twelve editors are named in one place** (`apps/desktop/src/shared/editors.ts`), and
  **`registerEditor(cls, 'vn.Name')`** is the only way to register one — a hand-written name is
  minified and every remembered pane comes back as the same editor.
- **That same list says what each editor will show for a clicked document**, as a `claims`
  predicate over the node; the ranking — visible before primary, `EDITORS` order last — is pure in
  `renderer/pathux/route.ts` beside the pane arithmetic. A visible _secondary_ beats a hidden
  _primary_, deliberately.
- **`src/shared/` is in the browser bundle**, so whatever it imports must be node-free; neither
  `tsgo` pass catches a violation, only `vite build`.
- **A raw DOM surface goes in the shadow root via `VnEditor.appendSurface`** and carries its own
  sheet via `adoptStyle`; `styles/index.css` import order IS cascade order, and `tokens.css` is
  the design contract (`--sodium` authored, `--signal` machine — no new accent hues).
- **Pure logic goes in `.ts` with a `tests/` sibling; the editor stays thin rendering.** The jest
  desktop project is node-only, so surfaces are verified live over CDP.
- **A mid-gesture verdict must be the verdict that would happen**, and layout changes on commit,
  never during a gesture.
- **The script editor edits a list of lines, not a buffer**, and **an editor with an open text row
  stops its own keydown** — the screen keymap is a bubble-phase window listener.

## Command system

Every desktop action is a **registered command** rather than a bespoke IPC channel: typed
properties, a string DSL (`namespace.command(a='x' b=1)`), git-stamped provenance, one JSON
catalog. Full write-up: [`docs/command-system.md`](docs/command-system.md).

- **`@vn/commands` is the framework; the desktop app owns the commands** — the definitions live
  in `apps/desktop/src/main/commands/` as thin wrappers over `WorkspaceSession`.
- **Commands are the only write path** — scene prose through `session.editScene`, branch markers
  through `session.editBranches`, and `work/shots/<sceneId>.json` only through the handful of
  commands named in that doc. `vnauthor` runs the same `@vn/scriptedit` rules and gets the same
  refusals.
- **Props are declarative specs, not zod** (the repo is on zod 3); `coerceProps` is the single
  validation authority.
- **A mutating command declares its refusal before it runs** — `stack.check` answers `accept` |
  `refuse` | `undeclared`, and absence of a check is not permission.
- **Provenance, undo and commits are each opt-in.** Executions append to
  `vngen/state/commands.jsonl`; undo restores a shadow snapshot under `refs/vn/undo/<seq>/` and
  **refuses rather than guesses** when the worktree drifted; the `Committer` commits the whole
  worktree per repo, in each repo an act touched.
  ([`docs/repos-and-commits.md`](docs/repos-and-commits.md))
- **`view.*` commands run in main** and push a `command:ui` effect naming an **editor**, never a
  room; main answers optimistically and the mesh returns a correction.
- **CDP is opt-in in the app and on by default in the developer launchers** — `VN_CDP_PORT`,
  `127.0.0.1`, full renderer control, so a packaged app opens nothing.
  `node scripts/vn-cdp.mjs "workspace.index()"`.

## The four satellite areas

- **`vnauthor`** — plan-first, git-backed authoring agent; plan mode is read-only, one commit per
  approved plan, edits round-trip through `@vn/model`'s serializers, and context precedence is
  input contract > `AICONTEXT.md` > `AICONTEXT.generated.md` > defaults. The generated half is a
  **map, not content**: cast, locations, story graph, and the bible's table of contents — never a
  line of what any file says. [`docs/vnauthor.md`](docs/vnauthor.md).
- **`@vn/bible`** — retrieval over `wiki/`. `openBible(dir)` takes a directory, `query` is
  budgeted and is the only door, and a missing `wiki/` is an empty bible, not an error.
  [`docs/story-bible.md`](docs/story-bible.md).
- **`@vn/testkit`** — real projects on disk run through the real scheduler with mock providers.
  Fidelity is the point, nothing may import it, the gate is per scene, and mock art is **marked**
  art the real backend refuses. [`docs/testkit.md`](docs/testkit.md).
- **`@vn/debug2d`** — source-agnostic 2D debugging for the renderer: fragment IR, query engine,
  causal `explainPick`. Zero deps and dev-only, so `vite build` drops it; DOM frames are honestly
  `sampled`, and `.explain()`/`.table()` are the only projections that survive CDP.
  [`docs/debugGuide.md`](docs/debugGuide.md).

## Conventions

- **Secrets.** The `keys/` directory is gitignored (the generated `vngen/` tree is not). API
  key _values_ must never be logged or committed. `project.yaml` records only model ids and
  env-var names.
  `resolveKeys` throws errors naming the _source_ (env var / file), never the value.
- **Imports** use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).
  jest's `moduleNameMapper` strips them; esbuild and `tsgo` resolve them.
- **Validation at the boundary.** Parse files and machine-consumed LLM output through the
  zod schemas in `@vn/types` so malformed data never reaches the deterministic core.
- Keep new packages inside the layering graph above; the boundaries lint rule will reject
  an illegal cross-layer import.

### Comments

- **Non-doc comments use `//`.** Doc comments use proper `/** … */` brackets. Don't use
  `/* … */` for ordinary inline commentary.
- **Non-doc comments are at most 3 lines.** A longer block comment is allowed sparingly —
  budget roughly one per 500 lines of a file — for genuinely load-bearing context that
  can't be stated in three lines.
- **Doc comments stay reasonably concise.** Say what the thing is and any non-obvious
  contract; don't restate the signature or narrate the implementation.
- **Temporary comments are marked `CLAUDENOTE:`.** Any scratch/working comment Claude
  writes gets that prefix, and all of them must be removed before the final commit of a
  plan (or at the end of the plan, whichever comes first).

### Plans

- **Plans live in [`docs/plans/`](docs/plans).** Any implementation plan gets written to
  `docs/plans/<descriptive-name>.md` before the work starts, and is kept up to date as the
  work proceeds — not left only in the conversation. the plan should have a properly
  descriptive name.
- **`todos.md` at the repo root is the author's running list, and a finished item gets its
  checkbox checked** — `[ ]:` becomes `[x]:` as part of finishing the work, not later. Leave
  the wording, ordering and whitespace of the entry alone: it is hand-written, it is
  deliberately outside prettier's idea of markdown, and reformatting it loses the author's
  own shorthand.

### Research

- **Research lives in [`docs/research/`](docs/research).** Any survey, investigation
  write-up, or report goes in `docs/research/<descriptive-name>.md` — not at the `docs/`
  root and not only in the conversation. Design docs and implementation plans keep their
  existing homes (`docs/`, `docs/plans/`).

### Documentation

- **This file is the map, not the territory.** Keep CLAUDE.md to what a contributor needs
  in-hand: the layering, the commands, the invariants in one or two lines each, and a pointer
  to the doc that states them in full. When a section here grows past roughly a screen of
  as-shipped detail, move it under `docs/` and leave the pointer — a `docs/` page is read on
  demand, whereas everything here is carried into every session.
- **Every new `docs/` page is listed in [`docs/index.md`](docs/index.md)** with a one-line
  summary of what it covers.
- **Lint and format markdown by naming the files.** After a docs-only change run
  `pnpm exec prettier --check <the files you touched>`, not a blanket `pnpm lint` — that runs
  eslint over the whole workspace and prettier over every file in the repo to check a page or
  two, which is slow and reports on files the change never touched.

### Finishing a plan

Before a plan is considered done:

1. **Audit the comments** in all code the plan touched — stale, redundant, or
   over-long comments get fixed or deleted, and every `CLAUDENOTE:` is gone.
2. **Update the docs the plan affects** — the relevant file(s) under `docs/` (design,
   plan, runner notes) and `CLAUDE.md` itself, so the described architecture, commands,
   and conventions match the code as shipped.

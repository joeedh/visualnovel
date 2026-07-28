# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**VN Generator** — a pnpm/TypeScript monorepo that turns authored inputs (characters, a
branching Fountain screenplay, optional locations + reference images) into a **deduped,
resumable pipeline of generated art assets plus a provenance manifest**.

The design separates **deterministic plumbing** (parse, validate, dedupe, layout,
schedule) from **generative steps** (LLM / image-model calls). Package boundaries mirror
that split and are enforced by lint rules, so the input-side packages can be reused
without pulling in the generative pipeline.

- Design: [`docs/vn-generator-report.md`](docs/vn-generator-report.md)
- Implementation plan: [`docs/plans/initial-implementation.md`](docs/plans/initial-implementation.md)
- Authoring agent plan: [`docs/plans/authoring-agent-implementation.md`](docs/plans/authoring-agent-implementation.md)
- Runner plan: [`docs/plans/runner.md`](docs/plans/runner.md)
- Command system: [`docs/command-system.md`](docs/command-system.md)
- Debugging guide: [`docs/debugGuide.md`](docs/debugGuide.md) — read this before debugging
  anything in this repo; tools ordered cheapest-first, evidence over reproduction
- Docs index: [`docs/index.md`](docs/index.md)
- **Out of scope:** _external_ engine export (Ren'Py/Ink/etc.). The generative pipeline core
  stops at a populated `build/` + `manifest.json`. On top of that sits a small, in-house
  **playable** (`vngen export` → `story.play.json`) and a **desktop runner** to actually
  watch a generated VN — see [Playable & runner](#playable--desktop-runner) below.

Alongside the pipeline is **`vnauthor`**, a plan-first conversational agent that helps an
author write and refine the _inputs_ (characters, screenplay, locations). It lives entirely
on the input side and is forbidden — by a boundaries lint rule — from importing the
generative pipeline. See [Authoring agent](#authoring-agent-vnauthor) below.

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

`pnpm check`, `pnpm test`, and `pnpm lint` should all be green before and after any change.

### Toolchain notes (deviations from the plan — intentional)

- **Typecheck is flat, not project-references.** `pnpm check` runs
  `tsgo --noEmit -p tsconfig.json` over the whole workspace, not `tsgo -b`. The root
  `tsconfig.json` maps every `@vn/*` package to its `src/index.ts` via **relative**
  `paths` (TypeScript 7 / `tsgo` removed `baseUrl`, so non-relative paths are rejected).
- **The renderer is checked by a second pass.** Root `tsconfig.json` includes only
  `*/src/**`, and the desktop renderer deliberately lives outside `src` (at
  `apps/desktop/renderer/**`) so the root check never sees its JSX. `pnpm check` is therefore
  `tsgo -p tsconfig.json && pnpm check:renderer`, the latter running
  `tsgo --noEmit -p renderer/tsconfig.json` in `apps/desktop`. Without that second pass
  nothing typechecks the renderer at all — `vite build` uses esbuild, which never checks.
  `renderer/tsconfig.json` has its own `paths` map; add `@vn/*` entries there as needed,
  relative-form only. Its `types` carries `node` and `jest` — renderer `tests/` siblings are
  typechecked by that pass, not the root one.
- **`tsgo`** comes from `@typescript/native-preview` (TS7 dev). `"jest"` is in
  `compilerOptions.types` so test globals typecheck.
- **`esbuild` transpiles; `tsgo` verifies.** esbuild never type-checks. It is used in
  exactly two places: bundling the CLI (`scripts/esbuild.cli.mjs`) and as the jest
  transform (`scripts/jest-esbuild.cjs`). Internal packages are **source-only** — no
  per-package `dist`; consumers import `src/index.ts` directly.
- **`turbo` orchestrates the bundles.** Each app owns a `build` script (`apps/cli`,
  `apps/authoring`, `apps/desktop`); `pnpm build` is `turbo run build` (all three), and
  `build:cli` / `build:authoring` / `build:desktop` are thin `--filter=…` wrappers for one
  app at a time. Because internal packages are source-only (no build
  task of their own), their sources can't be picked up via `dependsOn: ["^build"]` — so
  `turbo.json` lists `packages/*/src/**`, the esbuild scripts, and the tsconfigs as
  `globalDependencies`, which is what actually invalidates an app's cache. Outputs are
  `dist/**`; the local cache lives in `.turbo` (gitignored).
- **The desktop bundle has a third step, `build:catalog`.** `scripts/gen-command-catalog.mjs`
  bundles `apps/desktop/src/main/commands/catalog-entry.ts` and writes
  `apps/desktop/dist/commands.json` (see [Command system](#command-system)). Both bundle
  scripts share one alias map, `scripts/aliases.mjs`, so their package lists can't drift.
- **The boundaries rule needs the TypeScript import resolver.** `eslint.config.mjs` sets
  `'import/resolver': { typescript: … }`. With the legacy node resolver it resolved nothing
  (source-only packages have an `exports` map and no `main`), and an _unresolved_ import is
  an unclassified one — which `boundaries/element-types` silently passes. The layering below
  was advertised but not actually enforced until that was fixed.
- **jest config is `jest.config.cjs`** (the plan said `.ts`) to avoid bootstrapping
  ts-node just to read config. One display-named project per package. **Tests live in a
  `tests/` subfolder beside the code they cover** (`packages/model/src/tests/model.test.ts`,
  `packages/debug2d/src/dom/tests/stacking.test.ts`); every project's `testMatch` is
  `**/<scope>/**/tests/*.test.ts`, so a `*.test.ts` outside a `tests/` dir is silently
  never run.
- **Formatting uses standard `prettier`** (the plan mentioned a `@pathtx/prettier` fork,
  which is not available here). `docs/**` and `Readme.MD` are in `.prettierignore`.
- pnpm needs `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` so esbuild's postinstall
  runs.

## Architecture

### Package layering (acyclic; enforced by `eslint-plugin-boundaries` + `import/no-cycle`)

```
types  util
  │     │
config  parse
  │     │ │
  │   model store ──── export      git ──── commands
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

The pipeline spine (`pipeline → scheduler → cli`) and the authoring branch
(`authoring → authoring-app`) are disjoint below `@vn/store`/`@vn/providers`: `@vn/authoring`
reuses the input-side packages (types, util, config, parse, model, store, providers, git) but
**must never import `@vn/pipeline` or `@vn/scheduler`** — enforced by `eslint-plugin-boundaries`.
`@vn/export` is a similarly-constrained leaf: it projects the manifest into `story.play.json`
and is likewise forbidden from the generative pipeline/scheduler.

Two packages sit **outside the graph entirely** (neither is drawn above). `@vn/debug2d`
imports nothing from `packages/` and is imported only by the desktop renderer's dev-only
debug glue (`debug2d: []` in `eslint.config.mjs`), so it stays strippable from production
builds — see [2D debug layer](#2d-debug-layer-vndebug2d). `@vn/testkit` is the mirror image:
it may import _every_ layer, and **nothing may import it** — see
[Test fixtures](#test-fixtures-vntestkit).

| Package             | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vn/types`         | All entity/task/provider types + **zod schemas** for files and structured LLM output. Single source of truth for shapes. Depends only on `zod`.                                                                                                                                                                                                                                                                           |
| `@vn/util`          | `sha256`/canonical-JSON hashing, atomic fs writes, JSONL append/read, structured logger, bounded async `pool`, `retry`, typed errors.                                                                                                                                                                                                                                                                                     |
| `@vn/config`        | Load/validate `project.yaml`; resolve API keys from env then secret files. **Never logs key values**; errors name only the source.                                                                                                                                                                                                                                                                                        |
| `@vn/parse`         | Fountain parser + `[[choice: … -> id]]` / `[[scene: id]]` / `[[next: id]]` branch markers; markdown front-matter. Pure, no I/O policy. Shared with the future authoring agent.                                                                                                                                                                                                                                            |
| `@vn/model`         | Build + validate the in-memory project model (refs resolve, every `goto` targets a real scene, reachability/dead-scene detection); emit `story.graph.mmd`.                                                                                                                                                                                                                                                                |
| `@vn/store`         | Content-addressed asset store (`build/assets/<sha256>.<ext>`), `manifest.json` provenance, and the `work/` tree — including `shots/<sceneId>.json`, whose reader/writer is the only place the flat in-memory `Shot` and its nested `shotData` are mapped.                                                                                                                                                                 |
| `@vn/export`        | Leaf projector: `buildPlayable(model, store)` → `story.play.json` (flattened ordered beats + branch edges; asset refs by `{hash,ext}`). Input-side only — forbidden from `pipeline`/`scheduler` (boundaries-enforced).                                                                                                                                                                                                    |
| `@vn/commands`      | The command framework: typed prop specs, registry, `namespace.command(a='x' b=1)` DSL, execution stack with git provenance, JSON catalog projection, and the `UndoJournal` behind opt-in undo/redo. Domain-agnostic — the commands themselves are defined by the host app.                                                                                                                                                |
| `@vn/debug2d`       | Source-agnostic 2D graphics debugging: fragment IR, space registry, DOM adapter (stacking-order z with culprit retention), query engine, `explainPick` rejection logs. Zero deps, outside the layering graph; dev-only in the desktop renderer. See [2D debug layer](#2d-debug-layer-vndebug2d).                                                                                                                          |
| `@vn/taskgraph`     | `Task` node model, content-addressed dedupe key, DAG + topological order, `tasks.jsonl` status log, staleness/resume.                                                                                                                                                                                                                                                                                                     |
| `@vn/providers`     | Provider-agnostic `ImageProvider` / `VisionReviewer` / `TextLLM` over a low-level `ChatBackend`/`ImageBackend` seam. Gemini + Claude backends (lazy-imported). Structured-output enforcement + retry live here, as does the record/replay `AssetCache` + `CachedImageBackend`.                                                                                                                                            |
| `@vn/pipeline`      | The phases P1–P7 as deterministic prompt builders, an incremental task **planner**, per-kind **runners**, the approval **gate**, and a cost-preview facade.                                                                                                                                                                                                                                                               |
| `@vn/scheduler`     | Plan → run-ready-wave → replan loop under a concurrency cap; gates as barriers; crash-safe via the status log; dry-run cost preview.                                                                                                                                                                                                                                                                                      |
| `@vn/cli`           | `vngen run \| approve \| status \| graph \| export \| cost`. Bundled by esbuild.                                                                                                                                                                                                                                                                                                                                          |
| `@vn/git`           | Thin promisified wrapper over the `git` CLI (`isRepo`/`status`/`commit`/`log`/`show`/`diff`/`revert`/`restore`/`init`/`config`), plus the plumbing undo rests on (`writeTree`/`commitTree`/`treeOf`/`applyTree`/`updateRef`/`deleteRef`/`listRefs`, all against a scratch index so HEAD and the real index are untouched). Spawns via `node:child_process`, never interactive. **No policy** — gating lives in the agent. |
| `@vn/authoring`     | The `vnauthor` agent core: workspace index, `AICONTEXT.md` loader, tool registry, ReAct/native agent loop, plan-mode + permission gate, skills. Input-side only; cannot import pipeline/scheduler.                                                                                                                                                                                                                        |
| `@vn/authoring-app` | `vnauthor` interactive REPL: renders plan diffs, prompts for approval, streams turns, `/status` and `/skills` commands. Bundled by esbuild like `vngen`.                                                                                                                                                                                                                                                                  |
| `@vn/testkit`       | **Test-only** fixtures: `makeProject` (real inputs on disk → real run with mock providers), `synthProject` (deterministic scale), `SCRIPTS`, in-memory entity factories, and the recorded-art corpus at `assets/`. Imports every layer; nothing may import it. See [Test fixtures](#test-fixtures-vntestkit).                                                                                                             |

### Core ideas

- **Content-addressed task graph.** A task's identity is `sha256(kind, inputs)` where
  inputs include the normalized prompt, ordered reference asset hashes, model id, and
  params. Identical work collapses to one node → dedupe, resumability, and staleness for
  free. Every status transition is appended to `state/tasks.jsonl`; replaying it (last
  writer wins per hash) rebuilds the graph, which makes runs crash-safe and resumable.
- **Content-addressed asset store.** Image bytes are stored once at
  `build/assets/<hash>.<ext>`; `manifest.json` is the provenance index. Manifest writes are
  serialized through a single-writer queue so parallel tasks don't race on the atomic
  rename (this matters on Windows).
- **Gate-as-barrier.** The character-approval gate (P3) is not a task dependency — it's
  enforced by the planner: shot tasks for a scene are only emitted once every character in
  that scene is `approved`. A `vngen run` naturally halts at the gate with nothing left
  ready. Approving (via `vngen approve`) flips `character.md`; the next `run` plans and
  executes the downstream work. Scenes with no characters render immediately.
- **Incremental planning.** The planner is called once per scheduler wave. Tasks whose
  identity depends on an upstream output (a shot references its produced location plate)
  only appear after that upstream task is `done`. Consequence: `vngen cost` is a snapshot
  of _currently-plannable_ work and undercounts tasks that only become plannable after an
  earlier wave finishes.
- **Shot decompositions are persisted, not re-derived.** P5 is an LLM step, so re-running it
  would produce different shot ids — hence different task hashes — and regenerate art for no
  reason. The planner writes each scene's decomposition to `work/shots/<sceneId>.json` and
  prefers it forever after; it only calls `decomposeScene` when no file exists. The file is
  human-editable, and a malformed one throws rather than being silently re-decomposed over.
  Authored fields sit at the top level; what a run produced is nested under **`shotData`** and
  rewritten wholesale each pass — `tasks.jsonl` and `manifest.json` stay the authority, so a
  shots file restored from an old commit cannot convince the pipeline that work is done. Line
  ids the screenplay no longer has are dropped with a warning, and since `buildShotPrompt`
  ignores `coversLines`, coverage edits rehash nothing. Dry runs read the file but never write
  it — a mock decomposition must not be left for a real run to reuse.
- **P7 generate→critique→refine loop** is folded into the `shot_image` runner (a
  documented deviation from the report's separate `vision_review`/`prompt_refine` nodes).
  Each attempt generates, has every configured reviewer critique against the shot spec,
  and merges verdicts; a blocking verdict triggers a deterministic prompt refinement and
  another attempt, capped at `config.max_refine_attempts`, after which the shot is flagged
  `needs_human`. Every attempt is recorded on the task for provenance. It also **stops early
  when a refinement changes nothing** — refinement is deterministic, so an unchanged prompt
  means the critique repeated verbatim and the next attempt would issue the identical request;
  spending the rest of the cap on that is a re-roll, not a refinement.
- **The reviewer is told what the _shot_ ordered, not what the scene contains.** `shotSpec`
  (`packages/pipeline/src/prompts.ts`) describes the shot's own framing, location and cast,
  and demotes the prose of its covered lines to "context only"; `spec.characters` is the
  authority on who must be in frame, and an empty one says outright that a missing character
  is not a defect. Handing over the scene synopsis instead made every background plate fail
  for the characters the scene mentions but the shot never ordered — unsatisfiable, so the
  loop burned every attempt and landed on `needs_human`. `shotSpec`'s output never enters a
  task's `inputs`, so this rehashes nothing.
- **Deterministic fallbacks.** Text steps (P1 location enrichment, P5 shot decomposition)
  use the LLM with structured-output enforcement but fall back to a deterministic baseline
  on any failure, so the whole pipeline runs end-to-end with mock providers and no API
  calls. P5's baseline is one establishing shot **carrying the scene's cast** plus one medium
  shot per character; only a cast-less scene gets a bare plate, since the establishing shot
  covers the narration and action beats and those describe the characters doing things.
  Because this changes the prompt it rehashes establishing tasks — but shots are persisted,
  so an existing project keeps its old decomposition until `vngen/work/shots/*.json` is
  deleted or edited.
- **P5 is shown the scene as identified lines, not prose.** `coversLines` asks for line ids, so
  `decomposeScene` enumerates the scene as `[<lineId>] <kind>/<speaker>: <text>` and requires
  every line be assigned to exactly one shot. Handing over the flattened `scene.body` and a
  response template containing `"coversLines":[]` made the question unanswerable, and the model
  did the only thing it could — copied the empty array, producing shots that were generated and
  never displayed. `withCoverage` is the backstop: a decomposition binding no real line falls
  back to the baseline, and an uncovered first line goes to the first shot so a scene cannot
  open on a blank frame. See [`docs/plans/shot-timeline-editor.md`](docs/plans/shot-timeline-editor.md).
- **Provider seams.** The scheduler never imports a concrete provider — only `Task`,
  `deps`, `status`. Backends are swapped purely by changing model ids in `project.yaml`.
  Tests inject `RecordedChatBackend`/`StubImageBackend` (see `@vn/providers` `mock.ts` /
  `createMockProviders`) to exercise the contracts without network.

## CLI

```
vngen run [dir] [--mock]            parse → validate → execute to the next gate
vngen approve [dir] [--character][--hash][--yes]  interactively approve pending portraits
vngen status [dir]                  task/asset/approval summary
vngen graph [dir]                   emit the story branch graph (Mermaid)
vngen export [dir]                  write vngen/build/story.play.json (the playable)
vngen cost [dir]                    dry-run cost preview
```

`--mock` makes `run` a **dry run**: it plans, writes the story graph, and previews the work
(like `cost`) but calls no model and writes no assets — no API keys needed. Without `--mock`,
`run` constructs real Gemini/Claude clients and requires a Gemini key (env var named in
`project.yaml`, or a secret file under `<dir>/keys/` — or a shared `keys/` at the enclosing
repo root, consulted after the project's own). `vngen run --mock` writes no assets at all;
mock providers used directly (tests, `@vn/testkit`) emit **marked placeholder PNGs** that a
real backend refuses as references — see [Test fixtures](#test-fixtures-vntestkit).

### Project layout on disk

Authored input lives at the project root (`project.yaml`, `characters/<id>/character.md`,
`locations/<id>.md`, `screenplay/*.fountain`). Everything generated lives under `vngen/`:
`work/` (human-editable: story graph, candidates, `approved.png`, `shots/<sceneId>.json`),
`build/` (machine: `assets/`, `manifest.json`), `state/` (`tasks.jsonl`, reviews). In a user's
own project `vngen/` is **committed** — it is the reproducible output of a run, not
gitignored. `examples/sample` is the one exception: it is a template this repo ships, so it
stays inputs-only (see below).

### Sample project

[`examples/sample`](examples/sample) is a small branching VN, and a **read-only template**:
the desktop app copies it rather than running in it (see
[Seeded workspace](#seeded-workspace-examplesmysamplerepo)). The CLI has no such indirection,
so a real run against it writes generated art into the source tree — point it at a copy if
you want to keep `git status` legible. Preview offline, then generate:

```sh
pnpm build
node apps/cli/dist/cli.js graph  examples/sample
node apps/cli/dist/cli.js run    examples/sample --mock      # dry run: previews planned work
# a real run needs a Gemini key (see above); it generates portraits, then halts at the gate:
node apps/cli/dist/cli.js run    examples/sample
node apps/cli/dist/cli.js approve examples/sample            # interactively approve portraits
node apps/cli/dist/cli.js run    examples/sample             # clears the gate, renders shots
node apps/cli/dist/cli.js status examples/sample
node apps/cli/dist/cli.js export examples/sample             # write the playable (story.play.json)
```

## Playable & desktop runner

The pipeline is presentation-agnostic — it stops at `manifest.json`. To actually _watch_ a
generated VN, `@vn/export` projects the model + manifest into a small in-house **playable**
and the desktop app plays it. This is deliberately **not** an external DSL export; it is a
thin, ordered view over the existing `Scene`/`Shot`/`Asset` types. See
[`docs/plans/runner.md`](docs/plans/runner.md).

### `story.play.json` (the playable)

`vngen export [dir]` writes `vngen/build/story.play.json` via `buildPlayable(model, store)`
(pure, in `@vn/export`). Each scene flattens into ordered **beats** plus its branch edges:

```jsonc
{
  "version": 1,
  "title": "…",
  "start": "arrival", // entry scene id
  "characters": { "aiko": { "name": "Aiko", "portrait": { "hash": "…", "ext": "png" } } },
  "scenes": {
    "arrival": {
      "beats": [
        { "type": "show", "image": { "hash": "…", "ext": "png" } }, // bg/shot (image omitted if none)
        { "type": "say", "who": "aiko", "text": "Um… hello." }, // attributed dialogue/parenthetical
        { "type": "narrate", "text": "She bows, a little too deeply." }, // narration/action
      ],
      "choices": [{ "label": "Introduce yourself", "goto": "greet" }],
      "next": "rooftop", // followed when choices is empty
    },
  },
}
```

- **Real line ids drive per-line art.** Scenes carry structured `lines` (`SceneLine`, derived
  from the screenplay at model build with stable `${sceneId}:L<n>` ids); `Shot.coversLines`
  binds shots to exact lines. The exporter walks `scene.lines`, emitting a `show` beat
  whenever the covering shot changes, then a `say`/`narrate`. A model rebuilt from disk carries
  no shots, so callers pass `loadSceneShots(paths, model)` — the persisted decompositions —
  into `buildPlayable`; only with no file at all does it reconstruct the deterministic shot
  grouping. Reconstructing over an LLM decomposition names shot ids no run produced, and every
  `show` then comes out image-less.
- **Asset refs are `{hash, ext}`**, resolved by the runner (never inlined). A missing asset
  is **omitted, not an error** — a partially- or un-generated project still plays (placeholder
  background/portrait). `@vn/export` is a boundaries-constrained leaf: like `@vn/authoring` it
  must not import `@vn/pipeline`/`@vn/scheduler`.

### Renderer layout (`apps/desktop/renderer`)

One directory per room, a thin shell, and a stylesheet split along the same seams. `main.tsx`
is the only `.tsx` at the root.

```
renderer/
  main.tsx              entry; installs @vn/debug2d behind import.meta.env.DEV
  app/                  App.tsx (shell only), Topbar.tsx, Palette.tsx, useAgent.ts
  graph/                Canvas.tsx + pure layout · edges · hit · viewport (see below)
  rooms/studio/         Studio.tsx  Rail.tsx  Convo.tsx  PlanCard.tsx
       …/branch/        BranchEditor.tsx  SceneCard.tsx  useBranch.ts
                        graph.ts · grab.ts · tween.ts (pure)
  rooms/floor/          Floor.tsx   TaskBoard.tsx  Inspector.tsx  AttemptLoop.tsx
                        TaskGraphView.tsx · attempts.ts · taskGraph.ts (pure) · GateOverlay.tsx
       …/timeline/      Timeline.tsx  ShotBracket.tsx · coverage.ts (pure)
  rooms/play/           Runner.tsx
  ui/                   Resizable.tsx — shared by two rooms, so it belongs to neither
  styles/               index.css @imports tokens · shell · studio · floor · play · graph ·
                        branch · taskgraph · timeline
```

- **`App.tsx` owns only the shell**: `room`, `paletteOpen`, the workspace index/status, and
  the `command:ui` subscription (`view.*` commands target the shell). The agent conversation —
  feed, `dboxLine`, plan requests, `send`/`toggleMode`/`clear` — lives in `useAgent.ts` and is
  passed to STUDIO as one object. `busy` is deliberately shell-wide, not agent-only: a
  pipeline run from FLOOR disables the composer too.
- **`styles/index.css` import order IS cascade order.** It reproduces the top-to-bottom order
  of the single sheet this was split from, so a room's `@media` block still overrides the base
  rule it narrows. Add a new sheet at the **end**, not the middle. Vite inlines the `@import`s
  at build time, so one stylesheet still ships.
- **`tokens.css` is the design contract**: `--sodium` `#f4a24c` is warm — the authored/human
  side; `--signal` `#45c8d6` is cool — the machine/pipeline side; `--ink*` is the surface ramp;
  `--disp`/`--prose`/`--mono` are display/prose/machine-data type. That split already encodes
  "who made this", so **don't add new accent hues** — spend these two.
- **Pure logic goes in `.ts` with a `tests/` sibling; `.tsx` stays thin rendering.** Jest's
  desktop project is `**/apps/desktop/**/tests/*.test.ts` — `.ts` only, node environment, no
  jsdom. Layout math, hit-testing, and derivation are exactly what you want under test and
  exactly what jsdom can't help with; components are not tested. Same impure-shell/pure-core
  split as `@vn/debug2d`, for the same reason. No jsdom, no React Testing Library.
- **The FLOOR inspector renders the P7 refine loop**, since `shot_image` folds
  generate → critique → refine into one runner and the task board would otherwise show one node
  that made four image calls for no visible reason. `AttemptLoop.tsx` stacks the attempts with
  the `Corrections:` clause that caused each next one in the gap between them; `attempts.ts` is
  the pure half. Two contracts: `blocking` is computed exactly as `mergeReports`
  (`@vn/providers`) computes it, so the UI can't disagree with the verdict the runner acted on;
  and every attempt's bytes are in the store (`store.write` runs per attempt, `store.accept`
  only on the clean one), so rejected frames are viewable over `vnasset://`. Plan and its
  as-shipped notes: [`docs/plans/refine-loop-inspector.md`](docs/plans/refine-loop-inspector.md).
- **`prototype.html`** (at `apps/desktop/prototype.html`) is the original design reference and
  shares class names with the stylesheet. It is neither built nor imported — leave it alone,
  and don't treat it as the source of truth for tokens; `tokens.css` is.

### Graph canvas (`renderer/graph`) and the branch editor (STUDIO)

`renderer/graph/` is the shared, domain-free canvas: `layout.ts` (layered DAG layout),
`edges.ts` (routes + the polyline every hit test uses), `hit.ts` (`pick`), `viewport.ts`
(pan/zoom), and `Canvas.tsx`, the only impure file. The branch editor is its first consumer;
the [task DAG view](#task-dag-view-floor) is the second, and it reuses the layer unchanged.
Plan: [`docs/plans/story-branch-editor.md`](docs/plans/story-branch-editor.md).

- **One geometry, drawn and hit-tested.** `routeEdges` emits the SVG path and its sampled
  polyline together, so an edge can't be clickable where it isn't drawn. Slop is authored in
  **screen** pixels and divided by the scale before it meets world geometry — `pick` does that
  conversion itself so callers can't do it backwards.
- **Two co-transformed layers**: an SVG one for wires, an HTML one for cards and labels (typeset
  material, and SVG text has no wrapping). They carry the same viewport, via `transformOf` for
  SVG and **`cssTransformOf` for HTML** — the two syntaxes are not interchangeable, and CSS drops
  a transform it can't parse _silently_. The node layer is `pointer-events: none`; an element
  that needs a real DOM target (an inline label editor) opts itself back in.
- **No manual node positions, so every drag is semantic.** `Scene` has no `x`/`y` and layout is
  automatic: dragging a card's handle to another card wires it (`story.setChoice`/`setNext`),
  dropping a card on a wire splices it in (`story.spliceScene`), pulling a wire's arrowhead off
  its target unwires it. Each commits **one** command on release — a drag is continuous, its
  commit is discrete.
- **The refusal shown mid-drag is the refusal that would happen.** `src/shared/interactions.ts`
  asks the same `branchops.ts` the command runs, so while a card is carried every wire is marked
  accept/refuse with the reason the command would have given — and `interaction.targets` answers
  an agent with that same verdict list.
- **`grab.ts` resolves the handle and the arrowhead before `pick` does.** Both discs straddle a
  card boundary, where `pick` answers "background" or "that card" — testing them first is what
  makes them the size they look.
- **Relayout is animated (`tween.ts`)** because a splice re-ranks the graph: the card does not
  stay where it was dropped, and without the transition that reads as breakage.

### Task DAG view (FLOOR)

FLOOR's first two modes are `list` | `graph` (a segmented control in the floorbar,
`view.mode(room=floor mode=graph)`), sharing one selection and one `Inspector` — the flat list
is better for scanning, the graph for structure. Both are read-only: the only mutations from
these two are `pipeline.run` and `gate.approve`. `taskGraph.ts` is the pure derivation,
`TaskGraphView.tsx` the thin surface over `renderer/graph/`. Plan and as-shipped notes:
[`docs/plans/task-dag-view.md`](docs/plans/task-dag-view.md).

The view exists because a literal rendering of `Task.deps` would be dishonest in three ways,
and each fix is a pure function tested in node:

- **The gate is not an edge.** P3 approval is a planner predicate (`sceneUnblocked`), so a
  halted run has nothing ready and no edge saying why. `barrierFor` synthesizes a barrier node
  and `taskGraphOf` positions it with **ranking-only edges** — handed to `layoutGraph` but not
  to `routeEdges`, so the rank is real and the wires are never drawn. It renders as a dashed
  rule marked `derived`, carrying one `RESOLVE →` per pending character.
- **`deps` understates coupling.** A `shot_image`'s deps hold only its location plate; the
  subject portraits arrive through `inputs.refs`. `buildRefEdges` matches an `AssetRef.hash`
  back to the task whose `output` equals it — **deps solid, ref edges dashed**. A ref no task
  produced (an author-supplied image) is not an edge.
- **The graph is deliberately partial.** Planning is incremental, so shot tasks don't exist
  until their plate is `done`; an empty region means "not yet plannable", not "nothing to do".
  `ghostsFor` reads the story graph (not the task list — those two states look identical from
  the tasks alone) and ghosts each scene's expected work at `decomposeScene`'s deterministic
  baseline. Ghosts are **clusters, never addressable**: `onPick` acts on real tasks only, so
  the UI can't offer an estimate as a fact.

### Coverage timeline (FLOOR)

FLOOR's third mode, `timeline` (`view.mode(room=floor mode=timeline)`): a scene's screenplay
down the page with the shots covering it bracketed beside it. It runs **vertically** because
screenplays do, and it takes the full width — the task inspector is about other material, so
`.floor-body.wide` drops it. This is the only surface that edits `Shot.coversLines`, which
`buildShotPrompt` ignores, so every edit here is free: nothing rehashes and no art is
invalidated. Plan and as-shipped notes:
[`docs/plans/shot-timeline-editor.md`](docs/plans/shot-timeline-editor.md).

- **One rule, previewed and committed.** `src/shared/coverage.ts` (`setCoverage`) is run by the
  `story.setCoverage` command in main _and_ by the strip mid-drag — same split as
  `branchops.ts`/`intent.ts`, so a refusal shown while an edge is carried is the refusal that
  would happen. One command per drop; a drag is continuous, its commit is not.
- **A drag previews; it never re-lanes.** Lanes are greedy first-fit over shot _extents_, so
  re-deriving coverage per pointer move moves brackets the author never touched into other
  columns and changes the grid's column count under the cursor. The strip therefore draws
  committed coverage for the whole gesture and `previewOf` draws the proposal over it — ghost
  brackets in the dragged shot's **existing** lane, plus a tint on the rows it would claim and
  release. Same rule as the branch editor's animated relayout: layout changes on commit, not
  during the gesture. It also keeps the grabbed handle under the pointer.
- **Claiming a line takes it from whatever held it.** The exporter shows the _first_ shot
  covering a line, so double coverage silently hides the second shot's frame. Released lines
  become **gaps** — a vermilion gutter — rather than being handed to a neighbour: an uncovered
  line renders with no image, and revealing that is the point of the surface. But a claim that
  would leave another shot covering **nothing** is refused, because releasing does not give lines
  back: a drag that swept across a neighbour and returned would destroy it, and the return trip
  could not undo it. Revealing a shot that covers nothing is this surface's job; manufacturing
  one is not. The dragged shot may still empty itself via the command DSL — only the side effect
  is refused.
- **Coverage is a set, never a range.** `timeline/coverage.ts` splits a shot into contiguous
  _segments_ and lanes shots by extent, so the decomposer's interleaving (plate takes the
  narration, each medium one speaker) draws as separate columns instead of nested brackets.
  Only a shot's outermost handles drag; a shot covering nothing is listed under
  `COVERS NOTHING` instead of being drawn.
- **Rows are grid rows, so wrapped prose sizes itself.** The one thing measured is which row
  the pointer is over: a full-width `.tl-band` behind each row, reached by `elementFromPoint`
  once `.tl-grid.dragging` drops pointer events on the script and the brackets.

### Desktop runner (`apps/desktop`, PLAY room)

The Electron app's third room (**STUDIO · FLOOR · PLAY**) is the runner, in
`renderer/rooms/play/Runner.tsx`:

- **Live, no file needed.** The renderer calls the `story:play` IPC channel; the main process
  builds the playable in-process from the loaded model + store (`session.playable()`).
- **Image delivery — `vnasset://`.** A privileged custom protocol (registered in
  `src/main/index.ts`) streams `build/assets/<hash>.<ext>` for `vnasset://<hash>.<ext>`, so
  `<img src="vnasset://…">` loads content-addressed bytes. This is the app's only image path.
- **Playthrough.** State is a navigation stack (`{ sceneId, frameIndex }[]`, last = current):
  click / Space / → advances a beat; at scene end it shows choice buttons or auto-follows
  `next`; a leaf scene shows "The End". **Back** (← / Backspace) rewinds. **Save / Load /
  Reset** persist the stack to `localStorage`, keyed by workspace title.

### Remembered UI state (`.vndesktop/session.json`)

Panel widths (and anything else the shell should remember) live in a flat key/value file the
main process owns — `apps/desktop/src/main/sessionstore.ts`, gitignored, **global per install**
rather than per workspace. `VN_DESKTOP_HOME` relocates it; the default is one line away from
`~/.vndesktop` once the app is installed rather than run from the repo.

- **Multi-instance by construction.** Nothing stops two app instances sharing the file, so a
  flush takes a `mkdir` lock (stale ones, >5s, are broken), re-reads the file _inside_ the
  lock, and applies **only its dirty keys** over what it finds. Different keys from different
  instances both survive; the same key is last-flush-wins.
- **Synchronous first read.** The preload does one `sendSync('session:snapshot:sync')` and
  `useSessionValue` seeds `useState` from it, so a saved width is the first thing painted
  rather than a jump away from the default.
- **One hook, both orientations.** `usePanelWidth(saveId, { defaultWidth, min, max, edge })`
  (`renderer/ui/Resizable.tsx`) stores under `panel.<saveId>.width`, hands back a
  `--panel-w` `trackStyle` for the grid container and a `<ResizeHandle>`'s props. The STUDIO
  rail (`edge: 'left'`) and the FLOOR inspector (`edge: 'right'`) use it unchanged. A drag
  keeps the width local and persists once on release; `view.panelSize` is the scriptable path.

### Seeded workspace (`examples/mySampleRepo`)

With no `VN_PROJECT`, the app opens **`examples/mySampleRepo`** and seeds it from
`examples/sample` on first launch (`apps/desktop/src/main/workspace.ts`). It is resolved once
in `app.whenReady()`, before the asset protocol or any session exists.

- **Why**: a real run writes ~100 MB into `vngen/`, and doing that in the source tree buries
  `git status` and erases the line between the sample we ship and the copy you've been messing
  with. `examples/mySampleRepo` is **gitignored**, so its own git repo is invisible to the
  parent — no submodule, no `gitlink`, no `--recursive` clone.
- **Seeding copies inputs only** — everything in the template except `vngen/` (a fresh
  workspace has not been run) and `keys/` (secrets) — then `git init`s and commits them as
  `Sample project inputs`. A local `user.*` is set only when git can't already answer who the
  committer is; `core.autocrlf false` is always set, since the branch editor patches the
  screenplay byte-exactly.
- **An existing directory is opened untouched.** Never re-copied, never overwritten: it is the
  user's working copy. Resetting it is `rm -rf examples/mySampleRepo`, which needs no code and
  cannot misfire.
- Packaged builds have no repo-relative `examples/`, so the scratch workspace falls back to
  `app.getPath('userData')/mySampleRepo`; a missing template then fails by name.

Try it: `pnpm --filter @vn/desktop build && pnpm --filter @vn/desktop start` (mock mode by
default; `VN_PROJECT=<dir>` overrides the workspace).

**Live dev loop:** `pnpm --filter @vn/desktop dev` (`scripts/dev.desktop.mjs`) runs the three
moving parts together — esbuild `--watch` (main + preload), the Vite renderer server with
HMR, and Electron launched against it once it's up (`VITE_DEV_SERVER_URL`, which
`src/main/index.ts` loads instead of the built file). Quitting the window (or Ctrl-C) tears
the whole tree down. `VN_DEV_PORT` overrides the renderer port (default 5176); `VN_MOCK`/
`VN_PROJECT` pass through to the main process. Main-process edits need a restart (the renderer
hot-reloads on its own). The dev loop also defaults `VN_CDP_PORT=9222` — see
[Command system](#command-system).

## Command system

Every desktop action the shell can take is a **registered command** rather than a bespoke IPC
channel: typed properties, a string DSL, git-stamped provenance, one JSON catalog. The palette,
the menus, the agent, and an external CDP client all reach the same registry. Full write-up:
[`docs/command-system.md`](docs/command-system.md) (the implementation plan is
[`docs/plans/command-system.md`](docs/plans/command-system.md)).

- **`@vn/commands` is the framework, the desktop app owns the commands.** The package holds
  prop specs, the registry, the DSL, the execution stack, the interaction layer, and the catalog
  projection — it is domain-agnostic (deps: `types`, `util`, `git`). The 24 definitions live in
  `apps/desktop/src/main/commands/` (`gate`, `pipeline`, `story`, `agent`, `workspace`, `view`,
  `interaction`)
  as thin wrappers over `WorkspaceSession`. The `story.*` branch mutators
  (`setChoice`/`removeChoice`/`setNext`/`spliceScene`) all go through
  `session.editBranches(decide)` → `applySceneBranchEdit` → reload, so the branch editor never
  writes the screenplay by another path; `story.setCoverage` is the same arrangement one layer
  down, the only writer of `work/shots/<sceneId>.json` outside the planner.
- **Props are declarative specs, not zod.** The repo is on zod 3 (no `z.toJSONSchema`), and
  one spec map feeds coercion, the DSL, the catalog's JSON Schema, and a future properties
  panel. `coerceProps` is the single validation authority — it applies defaults, coerces the
  loose values JSON/CDP callers send, and rejects unknown keys, so `run` always receives every
  key present.
- **DSL:** `namespace.command(a='x' b=1)` — commas optional, barewords parse as strings (so
  `agent.setMode(mode=execute)` works). `formatCommand` is the inverse; a round-trip test pins
  them together.
- **Provenance.** Each execution appends a `CommandRecord` to `vngen/state/commands.jsonl`
  (alongside `tasks.jsonl`) carrying `gitHead`, `gitDirty`, `written` paths, and the replayable
  `invocation` — plus, for an undoable command, the pair of snapshots below.
- **Undo is opt-in, and restores a shadow snapshot of the _document_ tree.** With an
  `UndoJournal` wired, the stack brackets an `undoable` command with two captures of the
  worktree into detached commits under `refs/vn/undo/<seq>/{pre,post}` — HEAD never moves, the
  index is never touched. Snapshots exclude `vngen/build` and `vngen/state`: those are
  content-addressed and append-only, rolling them back would discard work a run has to pay for
  again, and excluding them is also what keeps a `pipeline.run` between two edits from reading
  as drift. Only the five `story.*` document mutators opt in; `gate.approve` straddles both
  data classes and is deliberately out. Undo **refuses rather than guesses** when the worktree
  no longer matches the record's `post` tree, redo **restores the post-state rather than
  replaying**, and `undo.changed` (the two trees compared, not what the command _claimed_ it
  wrote) keeps a no-op edit from becoming the undo point. A stack with no journal refuses both,
  exactly as before undo landed. Survey: [`docs/gitUndoOptions.md`](docs/gitUndoOptions.md);
  plan: [`docs/plans/command-undo-redo.md`](docs/plans/command-undo-redo.md).
- **Interactions declare the gestures; commands stay the only write path.** A command says what
  the app can do; on the direct-manipulation surfaces that omits most of the interface. An
  `Interaction` (`packages/commands/src/interaction.ts`) adds a name, a carried object, and —
  the point — `targets(state, carried)`, a **query** returning every candidate marked accept
  (with the invocation a drop would run) or refuse (with the sentence the command itself would
  have given). It never writes: every gesture terminates in a registered command, and
  `InteractionRegistry.verify` fails the build if it names one the app lacks. The branch
  editor's three (`branch.connect`/`splice`/`unwire`) live in `src/shared/interactions.ts`
  beside `branchops.ts`, for the same reason — `BranchEditor` draws its mid-drag verdict overlay
  from `branchSplice.targets` and `interaction.targets` runs the same call in main, so an author
  and an agent can't be told different things about one drop. Inline label editing is
  deliberately _not_ an interaction: no carried object, no enumerable targets. Plan:
  [`docs/plans/interaction-model.md`](docs/plans/interaction-model.md).
- **Catalog.** `pnpm build` writes `apps/desktop/dist/commands.json` for external tooling. The
  `command:catalog` IPC channel serves the **live** registry, never the file, so the app can't
  be misled by a stale one; a test asserts the two match.
- **CDP.** Setting `VN_CDP_PORT` makes the app open Chrome's own remote-debugging port, bound
  to `127.0.0.1`. It is **opt-in and off by default** — the port grants full control of the
  renderer. The preload exposes `window.vn` (`exec`/`catalog`/`history`/`undo`/`redo`) over
  the existing IPC, so DevTools and CDP share one entry point:

  ```sh
  node scripts/vn-cdp.mjs "workspace.index()"
  node scripts/vn-cdp.mjs --catalog
  node scripts/vn-cdp.mjs --history 5      # exits non-zero on a failed command
  ```

- **`view.*` commands run in main** and push a `command:ui` effect the renderer applies, rather
  than there being a second, renderer-side registry to keep in sync. `Room` stays a three-value
  union — an editor is a **mode within a room**, reached by `view.mode(room, mode)` and a
  `{ type: 'mode' }` effect (STUDIO: `convo` | `branches`; FLOOR: `list` | `graph` |
  `timeline`). Which
  modes a room _has_ is a pairing, so `view.mode` re-checks it in `run` and refuses a bad one
  by throwing; `UiEffect`'s mode member is split per room so the renderer can't cross them
  either.

## Test fixtures (`@vn/testkit`)

A test-only package that builds **real projects on disk** and runs them through the **real
scheduler** with mock providers, so a test asserts against generated state rather than a
hand-built model. Plan: [`docs/plans/test-fixtures.md`](docs/plans/test-fixtures.md).

```ts
import { SCRIPTS, makeProject, synthProject } from '@vn/testkit';

const p = await makeProject({ script: SCRIPTS.branching, git: true });
try {
  await p.run(); // real runPipeline + createMockProviders → halts at the gate
  await p.approveAll(); // writes character.md AND store.accept(), like `vngen approve`
  await p.run(); // gate clears; model sheets + shots render
  const { model, store, graph } = await p.reload();
} finally {
  await p.cleanup(); // always, in a finally
}
```

- **Fidelity is the point.** Every method goes through the code path production uses — inputs
  are parsed from files, approval is written to front-matter, the scheduler runs for real — so
  a fixture cannot pass by being kinder than the app. `characters`/`locations` are inferred
  from the script by the same `splitScenes` the model build uses, so ids can't drift.
- **Nothing may import it.** The boundaries rule grants `testkit` permission to import every
  layer and grants no one permission to import `testkit`; since `boundaries/element-types`
  defaults to `disallow`, a production import is a lint error. Test files are exempt from the
  rule, which is the only place it belongs. It must never appear in an app's `dependencies`.
- **The gate is per scene.** A scene with no cast renders on the _first_ run, before any
  approval. Assert on `summary.blockedOnGate` / `summary.gate.pending` / specific shot ids —
  never on "no shots ran".
- **`synthProject({ scenes, fanout, characters, locations })`** generates a `fanout`-ary scene
  tree with **no randomness** (task identity is `sha256(kind, inputs)`; a randomized script
  would change the task set every run). Scenes are not nodes: a fully-run project settles at
  `L + 4C + 2N` tasks, and reaching that total needs a real `run()`, not a `dryRun`.
- **Mock runs produce placeholder art, and it is marked as such.** `StubImageBackend` emits a
  real 64×36 PNG (`packages/providers/src/placeholder.ts`) — colour and stripe derived from the
  same seed, so a mock project is _viewable_ in the desktop app instead of a strip of broken
  thumbnails, and distinct shots look distinct. The bytes are hand-encoded with stored deflate
  blocks rather than `zlib`, because they are content-addressed and zlib's output is only
  stable per library version. Every placeholder carries a `tEXt` chunk keyed
  `vn-mock-placeholder`; `imagePart` in the Gemini backend rejects any reference carrying it.
  That marker _is_ the "never mix mock assets into a real run" guarantee now — a placeholder
  decodes fine, so magic-byte sniffing can no longer tell it from generated art.
- **`makeProject({ assets: 'cached' })` replays _real_ recorded art** out of
  `packages/testkit/assets/` (`<key>.<ext>` + an `index.json` of provenance), for the fixtures
  that exist to be _looked at_ — the PLAY room, the FLOOR inspector — rather than asserted on.
  The corpus is recorded and committed: **9 entries, 11.3 MB**, covering `linear` end to end.
  `CachedImageBackend` (`@vn/providers`) wraps `StubImageBackend`, keyed on
  `sha256(op, prompt, ordered ref-byte hashes, params)` — not the task hash, since the backend
  never sees a task. Default is `'placeholder'`, so no suite can pass only on a machine that
  has the corpus. Three contracts: a ref's bytes are in both the task hash _and_ the cache key,
  so **a cache is whole-chain or nothing** — a hole misses, and everything downstream of it
  misses too and degrades to placeholders rather than mixing; a hit reports the **recorded**
  model id, because the recording is the authority on its own provenance; and `put` refuses
  placeholder bytes, so a recording run that fell back to mocks can't bake them in. Recording
  is not reachable from `makeProject` — it lives on `CachedImageBackend({ record: true })`,
  which only the refresh script uses.
- **The refresh script records image calls only.**
  `node scripts/record-fixture-assets.mjs [--fixture linear] [--check]` — a thin driver over
  `packages/testkit/src/record.ts`, which is in the package (not the script) so it is
  typechecked and inside the boundaries graph. Recording runs the fixture with
  `createMockProviders({ imageBackend: cached })`: **mock text and vision, real image model**,
  because P5 decomposition is an LLM step and a recording made against a real text model would
  carry shot descriptions no replaying fixture ever asks for again — the corpus would be dead
  bytes. Mock text pins the run to the deterministic baseline, which is what a replay produces;
  the price is that a recorded P7 loop is one attempt deep. `--check` is free and offline and
  **reports, never gates** — a suite that failed on a stale entry would put a paid re-record in
  the way of an ordinary prompt change. It derives reused/missed/orphaned from
  `CachedImageBackend.log`, and marks the orphan list suspect whenever anything missed, since
  past the first miss the chain constraint re-keys every later request. A **failed task** is a
  different thing from a stale entry and is never quiet: `runFixture` collects `task.end` errors
  through a `logger` passed to testkit's `run()` (the scheduler stores a failure's message
  nowhere else — `RunSummary.ran` counts failures as terminal), `formatReport` prints them, and
  the script exits non-zero. A full re-record of `linear` is 9 image calls, ~$0.35, and is
  always full — a changed prompt re-keys everything downstream of it.
- **The recorder's bundle location and `cacheDir` are both load-bearing.** The model SDKs are
  `EXTERNAL` and lazy-imported, and `@google/genai` is a dependency of `@vn/providers` alone, so
  the bundle is emitted into `packages/providers/` — from anywhere else node cannot resolve it
  and every image task fails on first use. And `FIXTURE_ASSET_DIR` is `__dirname`-relative,
  which esbuild rewrites to the _output_ directory, so the script passes `cacheDir` explicitly
  rather than letting a bundle write a complete corpus somewhere adjacent and plausible. Both
  cost a paid run to discover; see `docs/plans/sample-workspace-and-asset-cache.md`.
- **In-memory factories** (`character`, `location`, `scene`, `model`) are also exported, for
  unit tests of the pure planners where building on disk would just be noise.

## 2D debug layer (`@vn/debug2d`)

A source-agnostic debugging layer for the desktop renderer's 2D UI: a neutral **fragment
IR** captured from the DOM (canvas/SVG adapters later), a **query engine** over frames, and
a causal **`explainPick`** that answers "why did my click miss / why is this on top" from
ground truth instead of screenshots. Design:
[`docs/research/2d-graphics-debug-api.md`](docs/research/2d-graphics-debug-api.md); plan:
[`docs/plans/2d-graphics-debug-api.md`](docs/plans/2d-graphics-debug-api.md); usage
recipes: [`docs/debugGuide.md`](docs/debugGuide.md).

- **Isolation is the design.** `@vn/debug2d` has zero dependencies (it even duplicates ~50
  lines of `Rect`/`Mat3` helpers in `geom.ts` — do not "deduplicate"), sits outside the
  layering graph, and is imported only by `apps/desktop/renderer/debug/install.ts`. The
  install is a dynamic import behind `import.meta.env.DEV` in `main.tsx`, so `vite build`
  drops the whole package from the production bundle.
- **Impure shell, pure core.** `dom/snapshot.ts` does all browser reads in one batched pass
  → plain snapshot tree; stacking order (CSS 2.1 walk with **culprit retention** — the
  ancestor whose `transform`/`opacity`/… scoped your `z-index` is recorded on the fragment),
  pick, and attribution are pure functions over that tree, unit-tested in node. jsdom has no
  layout engine, so the shell stays thin and is validated live instead.
- **Console + CDP surface.** Dev builds install `window.__vnDebug`
  (`at`, `inAABB`, `byOwner`, `byTag`, `bySource`, `where`, `owners`, `capture`,
  `explainPick`). Query results are chainable; `.explain()` / `.table()` are the plain-data
  projections — the only things that survive CDP's `returnByValue`, so remote expressions
  must end in one:

  ```sh
  node scripts/vn-cdp.mjs --raw "window.__vnDebug.explainPick(400, 300)"
  node scripts/vn-cdp.mjs --raw "window.__vnDebug.at(400, 300).explain()"
  ```

- **Honesty contract.** DOM frames are `fidelity: 'sampled'` with `exactZ: false`; the
  `elementsFromPoint` oracle is captured per query and a disagreement with the computed
  stack prints a `⚠` line rather than being resolved silently. Explain output is
  fixed-precision and deterministically ordered — the golden tests pin it verbatim.

## Authoring agent (`vnauthor`)

A plan-first, git-backed conversational agent that helps an author write and refine the
inputs the pipeline consumes. It does **not** run the generative pipeline — it stops at
well-formed, validated input files in a clean commit.

```
vnauthor [dir] [--mock] [--native]
```

- `--mock` runs offline with no model (read-only smoke test — exercises workspace/skill
  loading and the REPL without API keys).
- `--native` uses provider-native function-calling (Path B) when the configured model
  supports `chatWithTools`; otherwise the agent falls back to structured ReAct (Path A).
- Model + keys resolve exactly like `vngen`: `models.text` in `project.yaml`, key via env
  var or a secret file under `<dir>/keys/` (falling back to a shared `keys/` at the
  enclosing repo root).

REPL commands: `/help`, `/mode` (plan vs. execute), `/model [id]` (switch the text model;
no arg → interactive menu), `/effort [level]` (set reasoning effort — `low`…`max` map to
Anthropic `output_config.effort` + adaptive thinking, ignored on models that don't support
it; no arg → interactive menu), `/clear` (reset the conversation context, back to plan
mode), `/status` (project index), `/skills` (available skills), `/exit` (or `/quit`).
**Shift-Tab** cycles between plan and execute mode. `/model` and `/effort` rebuild the
backend and hot-swap it into the running agent, preserving conversation state.

### How it works

- **Two-mode state machine (`@vn/authoring` `loop.ts`).** The agent starts in **plan mode
  (read-only)**: only non-mutating tools dispatch; any mutating tool is blocked until the
  user approves a proposed plan. Approving a plan switches to **execute mode**, where edits
  apply, `validate_inputs` runs, and `git_commit` is **blocked while error-severity
  diagnostics remain** (soft/style issues only warn). One commit per approved plan.
- **Always-confirm.** `git_revert`/`git_restore` and the first run of a script-bearing
  skill route through the permission gate regardless of mode.
- **Agent backend seam.** The loop targets an internal `AgentBackend`; `StructuredAgentBackend`
  (Path A) drives tools as zod-validated JSON over the text seam, `NativeAgentBackend`
  (Path B) drives them through the vendor tool protocol. The loop is the arg-validation
  authority, so Path B advertises permissive tool params and re-validates via the registry.
- **Context precedence:** built-in input contract > `AICONTEXT.md` (+ nested per-dir files
  and `@import` lines; `AGENTS.md`/`CLAUDE.md` as fallbacks) > inferred defaults.
  `update_context` turns a chat instruction into a durable line in `AICONTEXT.md`.
- **Round-trip safety.** Edits go through `@vn/model`'s `*ToDoc` / `applyCharacterEdit` /
  `applyLocationEdit` serializers (`fromDoc(toDoc(x)) ≡ x`), rewriting only changed
  front-matter so untouched prose and branch markers are preserved.

### Skills

Reusable authoring playbooks live under `<dir>/.aiagent/skills/<id>/SKILL.md`
(front-matter: `name`, `description`, `when-to-use`). A pure-prose skill returns its body as
guidance; a skill with a `run.{mjs,js,cjs,sh}` script runs a vetted command — and **each run
is permissioned** (always-confirm), executing in the workspace root with the workspace path
as its first argument. See [`examples/sample/.aiagent/skills/new-character`](examples/sample/.aiagent/skills/new-character).

### Try it (offline)

```sh
pnpm build
printf '/skills\n/status\n/exit\n' | node apps/authoring/dist/vnauthor.js examples/sample --mock
```

[`examples/sample/AICONTEXT.md`](examples/sample/AICONTEXT.md) shows project guidance the
agent honors.

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

### Research

- **Research lives in [`docs/research/`](docs/research).** Any survey, investigation
  write-up, or report goes in `docs/research/<descriptive-name>.md` — not at the `docs/`
  root and not only in the conversation. Design docs and implementation plans keep their
  existing homes (`docs/`, `docs/plans/`).

### Finishing a plan

Before a plan is considered done:

1. **Audit the comments** in all code the plan touched — stale, redundant, or
   over-long comments get fixed or deleted, and every `CLAUDENOTE:` is gone.
2. **Update the docs the plan affects** — the relevant file(s) under `docs/` (design,
   plan, runner notes) and `CLAUDE.md` itself, so the described architecture, commands,
   and conventions match the code as shipped.

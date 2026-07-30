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
  watch a generated VN — see [Playable & desktop app](#playable--desktop-app) below.

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

### Package layering (acyclic; enforced by `eslint-plugin-boundaries` + `import/no-cycle`)

```
types  util
  │     │
config  parse
  │     │ │
  │   model store ──── export  scriptedit    git ──── commands
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
and is likewise forbidden from the generative pipeline/scheduler. `@vn/scriptedit` shares that
allow-list and exists for a sharper reason: it holds the scene-edit rules and write path, and both
the desktop app's `story.*` commands _and_ `vnauthor` must run the same ones — so they cannot live
in either (`docs/plans/scene-edit-package.md`).

Two packages sit **outside the graph entirely** (neither is drawn above). `@vn/debug2d`
imports nothing from `packages/` and is imported only by the desktop renderer's dev-only
debug glue (`debug2d: []` in `eslint.config.mjs`), so it stays strippable from production
builds — see [2D debug layer](#2d-debug-layer-vndebug2d). `@vn/testkit` is the mirror image:
it may import _every_ layer, and **nothing may import it** — see
[Test fixtures](#test-fixtures-vntestkit).

| Package             | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vn/types`         | All entity/task/provider types + **zod schemas** for files and structured LLM output. Single source of truth for shapes. Depends only on `zod`.                                                                                                                                                                                                                                                                                        |
| `@vn/util`          | `sha256`/canonical-JSON hashing, atomic fs writes, JSONL append/read, structured logger, bounded async `pool`, `retry`, typed errors.                                                                                                                                                                                                                                                                                                  |
| `@vn/config`        | Load/validate `project.yaml`; resolve API keys from env then secret files. **Never logs key values**; errors name only the source.                                                                                                                                                                                                                                                                                                     |
| `@vn/parse`         | Fountain parser + note markers: `[[choice: … -> id]]` / `[[scene: id]]` / `[[next: id]]` for branching, `[[line: L4]]` / `[[nextline: 12]]` for allocated line ids; markdown front-matter, including the byte-exact `splitFrontMatter` a prose patcher splices under. Also the `LoadedInputs` / `SceneChunkDoc` shapes the reader and the model builder both name. Pure, no I/O policy. Shared with the authoring agent.               |
| `@vn/model`         | Build + validate the in-memory project model (refs resolve, every `goto` targets a real scene, reachability/dead-scene detection); emit `story.graph.mmd`. Also the **writers**: `sceneToFountain` (lossless — `parse(write(scene)) ≡ scene`), the surgical `branchpatch`/`lineids` patchers, the `*ToDoc` serializers, and the two pure halves of import/export: `sceneChunksFromScript` and `scriptFromScenes`.                      |
| `@vn/store`         | The only reader of a project's files: `loadInputs` (authored `scenes/<id>.md` chunks; a leftover `screenplay/` is reported by `findScreenplay`, never read), the content-addressed asset store (`build/assets/<sha256>.<ext>`), `manifest.json` provenance, and the `work/` tree — including `shots/<sceneId>.json`, whose reader/writer is the only place the flat in-memory `Shot` and its nested `shotData` are mapped.             |
| `@vn/export`        | Leaf projector: `buildPlayable(model, store)` → `story.play.json` (flattened ordered beats + branch edges; asset refs by `{hash,ext}`). Input-side only — forbidden from `pipeline`/`scheduler` (boundaries-enforced).                                                                                                                                                                                                                 |
| `@vn/scriptedit`    | The scene-edit rules (`lineops`: nine pure decisions over a scene set) + their consequences (`shotfallout`) + the write path (`sourcesOf` → `planSceneEdit` → `applyScenePlan`). Shared by the desktop's `story.*` commands and `vnauthor`, so one authorial act has one answer. **Two entries**: the barrel is pure and browser-safe (the renderer runs `moveLine` to preview a drag); the filesystem half is `@vn/scriptedit/write`. |
| `@vn/commands`      | The command framework: typed prop specs, registry, `namespace.command(a='x' b=1)` DSL, execution stack with git provenance, JSON catalog projection, and the `UndoJournal` behind opt-in undo/redo. Domain-agnostic — the commands themselves are defined by the host app.                                                                                                                                                             |
| `@vn/debug2d`       | Source-agnostic 2D graphics debugging: fragment IR, space registry, DOM adapter (stacking-order z with culprit retention), query engine, `explainPick` rejection logs. Zero deps, outside the layering graph; dev-only in the desktop renderer. See [2D debug layer](#2d-debug-layer-vndebug2d).                                                                                                                                       |
| `@vn/taskgraph`     | `Task` node model, content-addressed dedupe key, DAG + topological order, `tasks.jsonl` status log, staleness/resume.                                                                                                                                                                                                                                                                                                                  |
| `@vn/providers`     | Provider-agnostic `ImageProvider` / `VisionReviewer` / `TextLLM` over a low-level `ChatBackend`/`ImageBackend` seam. Gemini + Claude backends (lazy-imported). Structured-output enforcement + retry live here, as does the record/replay `AssetCache` + `CachedImageBackend`.                                                                                                                                                         |
| `@vn/pipeline`      | The phases P1–P7 as deterministic prompt builders, an incremental task **planner**, per-kind **runners**, the approval **gate**, and a cost-preview facade.                                                                                                                                                                                                                                                                            |
| `@vn/scheduler`     | Plan → run-ready-wave → replan loop under a concurrency cap; gates as barriers; crash-safe via the status log; dry-run cost preview.                                                                                                                                                                                                                                                                                                   |
| `@vn/cli`           | `vngen run \| approve \| status \| graph \| export \| cost \| import \| screenplay`. Bundled by esbuild.                                                                                                                                                                                                                                                                                                                               |
| `@vn/git`           | Thin promisified wrapper over the `git` CLI (`isRepo`/`status`/`commit`/`log`/`show`/`diff`/`revert`/`restore`/`init`/`config`), plus the plumbing undo rests on (`writeTree`/`commitTree`/`treeOf`/`applyTree`/`updateRef`/`deleteRef`/`listRefs`, all against a scratch index so HEAD and the real index are untouched). Spawns via `node:child_process`, never interactive. **No policy** — gating lives in the agent.              |
| `@vn/authoring`     | The `vnauthor` agent core: workspace index, `AICONTEXT.md` loader, tool registry, ReAct/native agent loop, plan-mode + permission gate, skills. Input-side only; cannot import pipeline/scheduler.                                                                                                                                                                                                                                     |
| `@vn/authoring-app` | `vnauthor` interactive REPL: renders plan diffs, prompts for approval, streams turns, `/status` and `/skills` commands. Bundled by esbuild like `vngen`.                                                                                                                                                                                                                                                                               |
| `@vn/testkit`       | **Test-only** fixtures: `makeProject` (real inputs on disk → real run with mock providers), `synthProject` (deterministic scale), `SCRIPTS`, in-memory entity factories, and the recorded-art corpus at `assets/`. Imports every layer; nothing may import it. See [Test fixtures](#test-fixtures-vntestkit).                                                                                                                          |

### Core ideas

Each of these is a contract that costs money or corrupts provenance when broken; the full
statement of every one — with the failure it prevents — is in
[`docs/pipeline-contracts.md`](docs/pipeline-contracts.md).

- **Content-addressed task graph.** Task identity is `sha256(kind, inputs)` (normalized
  prompt, ordered ref hashes, model id, params), so identical work collapses to one node.
  Every status transition appends to `state/tasks.jsonl`; replaying it rebuilds the graph,
  which is what makes runs resumable and crash-safe.
- **Content-addressed asset store.** Bytes live once at `build/assets/<hash>.<ext>`;
  `manifest.json` is the provenance index, written through a single-writer queue.
- **Gate-as-barrier.** The P3 character-approval gate is a planner predicate, not a task
  dependency: a run simply halts with nothing ready. Scenes with no cast render immediately.
- **Incremental planning.** The planner runs once per wave, so `vngen cost` only counts
  _currently-plannable_ work and undercounts what a later wave unlocks.
- **Shot decompositions are persisted, not re-derived.** `work/shots/<sceneId>.json` is
  preferred forever after it exists; authored fields at top level, run output under
  `shotData`. `buildShotPrompt` ignores `coversLines`, so coverage edits rehash nothing.
- **Line ids are allocated and written down, and reading never writes.** `[[line: L4]]` marks
  bind art to lines; allocation is in-memory and persisting is the undoable
  `story.assignLineIds`, which re-parses its own patch and discards it unless the scenes come
  back identical.
- **A scene survives a trip through text: `parse(write(scene)) ≡ scene`.** `sceneToFountain`
  writes from `Scene.lines` (there is no `Scene.body`), keeps the heading's prefix and
  time-of-day variant, and forces (`!`, `@`, `>`, `~`) anything that could be re-read as
  another element. Blank lines are structural.
- **One scene, one file — and a writer patches the file the model was built from.** Prose writers
  derive their target list from the same `loadInputs` result that produced the model, so nothing
  re-decides which file is authoritative; a patch spanning several chunks is computed in full
  before any of it is written, and front-matter is spliced byte-exactly rather than
  re-serialized, so hand-written YAML comments survive.
- **P7 generate→critique→refine is folded into the `shot_image` runner**, capped by
  `config.max_refine_attempts`, stopping early when a refinement changes nothing, and flagging
  `needs_human` rather than looping. The reviewer is told what the _shot_ ordered, never the
  scene synopsis.
- **Deterministic fallbacks.** P1/P5 use the LLM with structured-output enforcement but fall
  back to a deterministic baseline on any failure, so the whole pipeline runs end-to-end with
  mock providers and no API calls.
- **Provider seams.** The scheduler never imports a concrete provider — only `Task`, `deps`,
  `status`. Backends swap by changing model ids in `project.yaml`.

## CLI

```
vngen run [dir] [--mock]            parse → validate → execute to the next gate
vngen approve [dir] [--character][--hash][--yes]  interactively approve pending portraits
vngen status [dir]                  task/asset/approval summary
vngen graph [dir]                   emit the story branch graph (Mermaid)
vngen export [dir]                  write vngen/build/story.play.json (the playable)
vngen cost [dir]                    dry-run cost preview
vngen import [dir]                  convert a retired screenplay/*.fountain into scenes/<id>.md
vngen screenplay [dir] [-o f|-][--clean]  project the scenes back to one Fountain file
```

`export` and `screenplay` are different artifacts: `export` writes the playable the desktop app
runs, `screenplay` writes Fountain a human (or `vngen import`) can read. `import` runs once per
project, refuses over an existing `scenes/`, and moves the original aside as `.fountain.imported`.

`--mock` makes `run` a **dry run**: it plans, writes the story graph, and previews the work
(like `cost`) but calls no model and writes no assets — no API keys needed. Without `--mock`,
`run` constructs real Gemini/Claude clients and requires a Gemini key (env var named in
`project.yaml`, or a secret file under `<dir>/keys/` — or a shared `keys/` at the enclosing
repo root, consulted after the project's own). `vngen run --mock` writes no assets at all;
mock providers used directly (tests, `@vn/testkit`) emit **marked placeholder PNGs** that a
real backend refuses as references — see [Test fixtures](#test-fixtures-vntestkit).

### Project layout on disk

Authored input lives at the project root (`project.yaml`, `characters/<id>/character.md`,
`locations/<id>.md`, `scenes/<id>.md`). Everything generated lives under `vngen/`:
`work/` (human-editable: story graph, candidates, `approved.png`, `shots/<sceneId>.json`),
`build/` (machine: `assets/`, `manifest.json`), `state/` (`tasks.jsonl`, reviews). In a user's
own project `vngen/` is **committed** — it is the reproducible output of a run, not
gitignored. `examples/sample` is the one exception: it is a template this repo ships, so it
stays inputs-only (see below).

**A scene is one file, and it is the only form scenes load from.** `scenes/<id>.md` holds
`scene: <id>` front-matter — identity and nothing else, matching the filename — over a body
that is a complete one-scene Fountain screenplay, heading and `[[…]]` markers included. A
directory has no document order, so the entry scene is `start:` in `project.yaml`. The older
one-contended-file form (`screenplay/*.fountain`) is **not read**: a project holding one and no
`scenes/` gets an error naming `vngen import`, and one left beside chunks is a warning to delete
or rename it `.fountain.imported`. What a body may contain:
[`docs/fountain.md`](docs/fountain.md#where-the-fountain-lives-project-specific).

### Sample project

[`examples/sample`](examples/sample) is a small branching VN, and a **read-only template**:
the desktop app copies it rather than running in it (see
[`docs/desktop-app.md`](docs/desktop-app.md#seeded-workspace-examplesmysamplerepo)). The CLI
has no such indirection, so a real run against it writes generated art into the source tree —
point it at a copy if you want to keep `git status` legible. Preview offline, then generate:

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

## Playable & desktop app

The pipeline is presentation-agnostic — it stops at `manifest.json`. `@vn/export` projects the
model + manifest into a small in-house **playable** (`story.play.json`), and the Electron app
plays it. This is deliberately **not** an external DSL export; it is a thin, ordered view over
the existing `Scene`/`Shot`/`Asset` types.

- Playable format and its contracts: [`docs/playable-format.md`](docs/playable-format.md)
  (plan: [`docs/plans/runner.md`](docs/plans/runner.md)).
- The app — renderer layout, the shared graph canvas, the STUDIO branch editor, FLOOR's task
  DAG and coverage timeline, the PLAY runner, the session store, and the seeded workspace:
  [`docs/desktop-app.md`](docs/desktop-app.md).
- What persists where: [`docs/desktopAppState.md`](docs/desktopAppState.md).

Rules worth knowing before touching the renderer:

- **Pure logic goes in `.ts` with a `tests/` sibling; `.tsx` stays thin rendering.** The jest
  desktop project is node-only — no jsdom, no React Testing Library, components untested.
- **`src/shared/` is in the browser bundle**, so whatever it imports must be node-free — which is
  why `@vn/scriptedit`'s barrel is pure and its filesystem half is `@vn/scriptedit/write`. Neither
  `tsgo` pass catches a violation; only `vite build` does.
- **`styles/index.css` import order IS cascade order** — add a new sheet at the end.
- **`tokens.css` is the design contract**: `--sodium` (warm) is the authored/human side,
  `--signal` (cool) the machine/pipeline side. Don't add new accent hues.
- **A mid-gesture verdict must be the verdict that would happen** — the drag overlays call the
  same pure rule the command runs. Layout changes on commit, never during a gesture.

Try it: `pnpm --filter @vn/desktop build && pnpm --filter @vn/desktop start` (mock mode by
default; `VN_PROJECT=<dir>` overrides the workspace). Live dev loop:
`pnpm --filter @vn/desktop dev`.

## Command system

Every desktop action the shell can take is a **registered command** rather than a bespoke IPC
channel: typed properties, a string DSL, git-stamped provenance, one JSON catalog. The palette,
the menus, the agent, and an external CDP client all reach the same registry. Full write-up:
[`docs/command-system.md`](docs/command-system.md); plan:
[`docs/plans/command-system.md`](docs/plans/command-system.md).

- **`@vn/commands` is the framework; the desktop app owns the commands.** The 37 definitions
  live in `apps/desktop/src/main/commands/` (`gate`, `pipeline`, `story`, `agent`, `workspace`,
  `view`, `interaction`, `command`) as thin wrappers over `WorkspaceSession`.
- **Commands are the only write path.** The `story.*` branch mutators go through
  `session.editBranches(decide)` → `applySceneBranchEdit` → reload, and the nine scene editors
  through `session.editScene(decide)`, so no surface writes scene prose by another path. Outside the
  planner, `work/shots/<sceneId>.json` has exactly two writers: `story.setCoverage`, and
  `editScene`, which carries a shot's coverage across a split, merge or delete rather than
  stranding it.
- **Props are declarative specs, not zod** (the repo is on zod 3). `coerceProps` is the single
  validation authority — defaults, coercion of loose JSON/CDP values, unknown-key rejection.
- **DSL:** `namespace.command(a='x' b=1)`; commas optional, barewords are strings.
  `formatCommand` is the inverse and a round-trip test pins them together.
- **Provenance and undo.** Each execution appends a `CommandRecord` to
  `vngen/state/commands.jsonl`. Undo is **opt-in** (the six `story.*` document mutators only)
  and restores a shadow snapshot of the document tree under `refs/vn/undo/<seq>/{pre,post}` —
  HEAD and the index are never touched, `vngen/build` and `vngen/state` are excluded, and undo
  **refuses rather than guesses** when the worktree has drifted.
- **Interactions declare the gestures** (`packages/commands/src/interaction.ts`): a carried
  string token plus `targets(state, carried)`, a pure synchronous query returning every
  candidate marked accept (with the invocation a drop would run) or refuse (with the sentence
  the command itself would give). They never write.
- **A mutating command declares its refusal before it runs.** `stack.check(id, props)` answers
  `accept` | `refuse` | `undeclared` — absence of a check is not permission. It never gates
  `exec`, which re-decides for itself.
- **`view.*` commands run in main** and push a `command:ui` effect; there is no second,
  renderer-side registry. `Room` stays a three-value union — an editor is a **mode within a
  room** (STUDIO: `convo` | `branches`; FLOOR: `list` | `graph` | `timeline`).
- **The catalog is generated, and the palette is a view of it.** `pnpm build` writes
  `apps/desktop/dist/commands.json` for external tooling; the `command:catalog` IPC channel
  serves the **live** registry, and a test asserts the two match.
- **CDP is opt-in** via `VN_CDP_PORT` (bound to `127.0.0.1`; the port grants full control of
  the renderer). `window.vn` (`exec`/`check`/`catalog`/`history`/`undo`/`redo`) is the one
  entry point DevTools and CDP share:

  ```sh
  node scripts/vn-cdp.mjs "workspace.index()"
  node scripts/vn-cdp.mjs --catalog
  node scripts/vn-cdp.mjs --history 5      # exits non-zero on a failed command
  ```

## Test fixtures (`@vn/testkit`)

A test-only package that builds **real projects on disk** and runs them through the **real
scheduler** with mock providers, so a test asserts against generated state rather than a
hand-built model. Full write-up: [`docs/testkit.md`](docs/testkit.md); plan:
[`docs/plans/test-fixtures.md`](docs/plans/test-fixtures.md).

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

- **Fidelity is the point** — every method goes through the code path production uses, so a
  fixture cannot pass by being kinder than the app.
- **Nothing may import it.** A production import is a lint error; it must never appear in an
  app's `dependencies`.
- **The gate is per scene.** A cast-less scene renders on the _first_ run — assert on
  `summary.blockedOnGate` / `summary.gate.pending` / specific shot ids, never on "no shots ran".
- **`synthProject`** is deterministic by construction (randomness would re-key every task);
  a fully-run project settles at `L + 4C + 2N` tasks.
- **Mock art is marked art.** Placeholder PNGs carry a `vn-mock-placeholder` `tEXt` chunk and
  the Gemini backend refuses any reference carrying it — that marker _is_ the "never mix mock
  assets into a real run" guarantee. `makeProject({ assets: 'cached' })` replays the real
  recorded corpus instead, whole-chain or not at all.

## 2D debug layer (`@vn/debug2d`)

A source-agnostic debugging layer for the desktop renderer's 2D UI: a neutral **fragment IR**
captured from the DOM, a **query engine** over frames, and a causal **`explainPick`** that
answers "why did my click miss / why is this on top" from ground truth instead of screenshots.
Design: [`docs/research/2d-graphics-debug-api.md`](docs/research/2d-graphics-debug-api.md);
plan: [`docs/plans/2d-graphics-debug-api.md`](docs/plans/2d-graphics-debug-api.md); usage
recipes: [`docs/debugGuide.md`](docs/debugGuide.md).

- **Isolation is the design.** Zero dependencies (it even duplicates ~50 lines of `Rect`/`Mat3`
  helpers in `geom.ts` — do not "deduplicate"), outside the layering graph, imported only by
  `apps/desktop/renderer/debug/install.ts` behind `import.meta.env.DEV`, so `vite build` drops
  the whole package from production.
- **Impure shell, pure core.** `dom/snapshot.ts` does all browser reads in one batched pass;
  stacking order (with **culprit retention**), pick, and attribution are pure functions over
  that snapshot, unit-tested in node.
- **Honesty contract.** DOM frames are `fidelity: 'sampled'` with `exactZ: false`; a
  disagreement with the `elementsFromPoint` oracle prints a `⚠` rather than being resolved
  silently. Explain output is fixed-precision and deterministically ordered — golden tests pin
  it verbatim.
- Dev builds install `window.__vnDebug`; query results are chainable and `.explain()` /
  `.table()` are the only projections that survive CDP's `returnByValue`, so remote expressions
  must end in one.

## Authoring agent (`vnauthor`)

A plan-first, git-backed conversational agent that helps an author write and refine the inputs
the pipeline consumes. It does **not** run the generative pipeline — it stops at well-formed,
validated input files in a clean commit. Full write-up: [`docs/vnauthor.md`](docs/vnauthor.md);
design: [`docs/authoring-agent-report.md`](docs/authoring-agent-report.md).

```
vnauthor [dir] [--mock] [--native]
```

- **Plan mode is read-only.** Mutating tools are blocked until the user approves a proposed
  plan; approving switches to execute mode, and `git_commit` stays blocked while
  error-severity diagnostics remain. One commit per approved plan.
- **Always-confirm** for `git_revert`/`git_restore` and the first run of a script-bearing skill.
- **Round-trip safety.** Edits go through `@vn/model`'s `*ToDoc` / `apply*Edit` serializers
  (`fromDoc(toDoc(x)) ≡ x`), rewriting only changed front-matter.
- **Context precedence:** built-in input contract > `AICONTEXT.md` (+ nested files and
  `@import`s; `AGENTS.md`/`CLAUDE.md` as fallbacks) > inferred defaults.

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

### Documentation

- **This file is the map, not the territory.** Keep CLAUDE.md to what a contributor needs
  in-hand: the layering, the commands, the invariants in one or two lines each, and a pointer
  to the doc that states them in full. When a section here grows past roughly a screen of
  as-shipped detail, move it under `docs/` and leave the pointer — a `docs/` page is read on
  demand, whereas everything here is carried into every session.
- **Every new `docs/` page is listed in [`docs/index.md`](docs/index.md)** with a one-line
  summary of what it covers.

### Finishing a plan

Before a plan is considered done:

1. **Audit the comments** in all code the plan touched — stale, redundant, or
   over-long comments get fixed or deleted, and every `CLAUDENOTE:` is gone.
2. **Update the docs the plan affects** — the relevant file(s) under `docs/` (design,
   plan, runner notes) and `CLAUDE.md` itself, so the described architecture, commands,
   and conventions match the code as shipped.

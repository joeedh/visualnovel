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

One package sits **outside the graph entirely**: `@vn/debug2d` (not drawn above) imports
nothing from `packages/` and is imported only by the desktop renderer's dev-only debug glue
(`debug2d: []` in `eslint.config.mjs`), so it stays strippable from production builds — see
[2D debug layer](#2d-debug-layer-vndebug2d).

| Package             | Responsibility                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@vn/types`         | All entity/task/provider types + **zod schemas** for files and structured LLM output. Single source of truth for shapes. Depends only on `zod`.                                                                                                                                                  |
| `@vn/util`          | `sha256`/canonical-JSON hashing, atomic fs writes, JSONL append/read, structured logger, bounded async `pool`, `retry`, typed errors.                                                                                                                                                            |
| `@vn/config`        | Load/validate `project.yaml`; resolve API keys from env then secret files. **Never logs key values**; errors name only the source.                                                                                                                                                               |
| `@vn/parse`         | Fountain parser + `[[choice: … -> id]]` / `[[scene: id]]` / `[[next: id]]` branch markers; markdown front-matter. Pure, no I/O policy. Shared with the future authoring agent.                                                                                                                   |
| `@vn/model`         | Build + validate the in-memory project model (refs resolve, every `goto` targets a real scene, reachability/dead-scene detection); emit `story.graph.mmd`.                                                                                                                                       |
| `@vn/store`         | Content-addressed asset store (`build/assets/<sha256>.<ext>`), `manifest.json` provenance, and the `work/` markdown tree.                                                                                                                                                                        |
| `@vn/export`        | Leaf projector: `buildPlayable(model, store)` → `story.play.json` (flattened ordered beats + branch edges; asset refs by `{hash,ext}`). Input-side only — forbidden from `pipeline`/`scheduler` (boundaries-enforced).                                                                           |
| `@vn/commands`      | The command framework: typed prop specs, registry, `namespace.command(a='x' b=1)` DSL, execution stack with git provenance, JSON catalog projection. Domain-agnostic — the commands themselves are defined by the host app. Undo-less by decision (see [Command system](#command-system)).       |
| `@vn/debug2d`       | Source-agnostic 2D graphics debugging: fragment IR, space registry, DOM adapter (stacking-order z with culprit retention), query engine, `explainPick` rejection logs. Zero deps, outside the layering graph; dev-only in the desktop renderer. See [2D debug layer](#2d-debug-layer-vndebug2d). |
| `@vn/taskgraph`     | `Task` node model, content-addressed dedupe key, DAG + topological order, `tasks.jsonl` status log, staleness/resume.                                                                                                                                                                            |
| `@vn/providers`     | Provider-agnostic `ImageProvider` / `VisionReviewer` / `TextLLM` over a low-level `ChatBackend`/`ImageBackend` seam. Gemini + Claude backends (lazy-imported). Structured-output enforcement + retry live here.                                                                                  |
| `@vn/pipeline`      | The phases P1–P7 as deterministic prompt builders, an incremental task **planner**, per-kind **runners**, the approval **gate**, and a cost-preview facade.                                                                                                                                      |
| `@vn/scheduler`     | Plan → run-ready-wave → replan loop under a concurrency cap; gates as barriers; crash-safe via the status log; dry-run cost preview.                                                                                                                                                             |
| `@vn/cli`           | `vngen run \| approve \| status \| graph \| export \| cost`. Bundled by esbuild.                                                                                                                                                                                                                 |
| `@vn/git`           | Thin promisified wrapper over the `git` CLI (`isRepo`/`status`/`commit`/`log`/`show`/`diff`/`revert`/`restore`/`init`). Spawns via `node:child_process`, never interactive. **No policy** — gating lives in the agent.                                                                           |
| `@vn/authoring`     | The `vnauthor` agent core: workspace index, `AICONTEXT.md` loader, tool registry, ReAct/native agent loop, plan-mode + permission gate, skills. Input-side only; cannot import pipeline/scheduler.                                                                                               |
| `@vn/authoring-app` | `vnauthor` interactive REPL: renders plan diffs, prompts for approval, streams turns, `/status` and `/skills` commands. Bundled by esbuild like `vngen`.                                                                                                                                         |

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
- **P7 generate→critique→refine loop** is folded into the `shot_image` runner (a
  documented deviation from the report's separate `vision_review`/`prompt_refine` nodes).
  Each attempt generates, has every configured reviewer critique against the shot spec,
  and merges verdicts; a blocking verdict triggers a deterministic prompt refinement and
  another attempt, capped at `config.max_refine_attempts`, after which the shot is flagged
  `needs_human`. Every attempt is recorded on the task for provenance.
- **Deterministic fallbacks.** Text steps (P1 location enrichment, P5 shot decomposition)
  use the LLM with structured-output enforcement but fall back to a deterministic baseline
  on any failure, so the whole pipeline runs end-to-end with mock providers and no API
  calls.
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
repo root, consulted after the project's own). Mock runs never produce image bytes, so they
can't be mixed into a real run's reference assets.

### Project layout on disk

Authored input lives at the project root (`project.yaml`, `characters/<id>/character.md`,
`locations/<id>.md`, `screenplay/*.fountain`). Everything generated lives under `vngen/`:
`work/` (human-editable: story graph, candidates, `approved.png`), `build/` (machine:
`assets/`, `manifest.json`), `state/` (`tasks.jsonl`, reviews). `vngen/` is committed (it is
the reproducible output of a run), not gitignored.

### Sample project

[`examples/sample`](examples/sample) is a small branching VN. Preview offline, then generate:

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
  whenever the covering shot changes, then a `say`/`narrate`. When a run's shots aren't
  in-memory, it reconstructs the deterministic shot grouping so `show` boundaries still land.
- **Asset refs are `{hash, ext}`**, resolved by the runner (never inlined). A missing asset
  is **omitted, not an error** — a partially- or un-generated project still plays (placeholder
  background/portrait). `@vn/export` is a boundaries-constrained leaf: like `@vn/authoring` it
  must not import `@vn/pipeline`/`@vn/scheduler`.

### Desktop runner (`apps/desktop`, PLAY room)

The Electron app's third room (**STUDIO · FLOOR · PLAY**) is the runner, in
`renderer/Runner.tsx`:

- **Live, no file needed.** The renderer calls the `story:play` IPC channel; the main process
  builds the playable in-process from the loaded model + store (`session.playable()`).
- **Image delivery — `vnasset://`.** A privileged custom protocol (registered in
  `src/main/index.ts`) streams `build/assets/<hash>.<ext>` for `vnasset://<hash>.<ext>`, so
  `<img src="vnasset://…">` loads content-addressed bytes. This is the app's only image path.
- **Playthrough.** State is a navigation stack (`{ sceneId, frameIndex }[]`, last = current):
  click / Space / → advances a beat; at scene end it shows choice buttons or auto-follows
  `next`; a leaf scene shows "The End". **Back** (← / Backspace) rewinds. **Save / Load /
  Reset** persist the stack to `localStorage`, keyed by workspace title.

Try it: `pnpm --filter @vn/desktop build && pnpm --filter @vn/desktop start` (defaults to the
bundled sample in mock mode; `VN_PROJECT=<dir>` overrides the workspace).

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
  prop specs, the registry, the DSL, the execution stack, and the catalog projection — it is
  domain-agnostic (deps: `types`, `util`, `git`). The 13 definitions live in
  `apps/desktop/src/main/commands/` (`gate`, `pipeline`, `story`, `agent`, `workspace`, `view`)
  as thin wrappers over `WorkspaceSession`.
- **Props are declarative specs, not zod.** The repo is on zod 3 (no `z.toJSONSchema`), and
  one spec map feeds coercion, the DSL, the catalog's JSON Schema, and a future properties
  panel. `coerceProps` is the single validation authority — it applies defaults, coerces the
  loose values JSON/CDP callers send, and rejects unknown keys, so `run` always receives every
  key present.
- **DSL:** `namespace.command(a='x' b=1)` — commas optional, barewords parse as strings (so
  `agent.setMode(mode=execute)` works). `formatCommand` is the inverse; a round-trip test pins
  them together.
- **Provenance, not undo.** Each execution appends a `CommandRecord` to
  `vngen/state/commands.jsonl` (alongside `tasks.jsonl`) carrying `gitHead`, `gitDirty`,
  `written` paths, and the replayable `invocation`. **v1 registers nothing undoable**:
  `stack.undo()`/`.redo()` refuse and point at
  [`docs/gitUndoOptions.md`](docs/gitUndoOptions.md), which surveys the strategies so the
  choice is made deliberately later.
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
  than there being a second, renderer-side registry to keep in sync.

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

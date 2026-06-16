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
- **Out of scope:** engine export (turning the manifest into a runnable VN). The pipeline
  stops at a populated `build/` + `manifest.json`.

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
| Bundle the CLIs              | `pnpm build` (both `vngen` and `vnauthor`)                              |
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
- **jest config is `jest.config.cjs`** (the plan said `.ts`) to avoid bootstrapping
  ts-node just to read config. One display-named project per package.
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
  │   model store      git
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

| Package             | Responsibility                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vn/types`         | All entity/task/provider types + **zod schemas** for files and structured LLM output. Single source of truth for shapes. Depends only on `zod`.                                                                        |
| `@vn/util`          | `sha256`/canonical-JSON hashing, atomic fs writes, JSONL append/read, structured logger, bounded async `pool`, `retry`, typed errors.                                                                                  |
| `@vn/config`        | Load/validate `project.yaml`; resolve API keys from env then secret files. **Never logs key values**; errors name only the source.                                                                                     |
| `@vn/parse`         | Fountain parser + `[[choice: … -> id]]` / `[[scene: id]]` / `[[next: id]]` branch markers; markdown front-matter. Pure, no I/O policy. Shared with the future authoring agent.                                         |
| `@vn/model`         | Build + validate the in-memory project model (refs resolve, every `goto` targets a real scene, reachability/dead-scene detection); emit `story.graph.mmd`.                                                             |
| `@vn/store`         | Content-addressed asset store (`build/assets/<sha256>.<ext>`), `manifest.json` provenance, and the `work/` markdown tree.                                                                                              |
| `@vn/taskgraph`     | `Task` node model, content-addressed dedupe key, DAG + topological order, `tasks.jsonl` status log, staleness/resume.                                                                                                  |
| `@vn/providers`     | Provider-agnostic `ImageProvider` / `VisionReviewer` / `TextLLM` over a low-level `ChatBackend`/`ImageBackend` seam. Gemini + Claude backends (lazy-imported). Structured-output enforcement + retry live here.        |
| `@vn/pipeline`      | The phases P1–P7 as deterministic prompt builders, an incremental task **planner**, per-kind **runners**, the approval **gate**, and a cost-preview facade.                                                            |
| `@vn/scheduler`     | Plan → run-ready-wave → replan loop under a concurrency cap; gates as barriers; crash-safe via the status log; dry-run cost preview.                                                                                   |
| `@vn/cli`           | `vngen run \| approve \| status \| graph \| cost`. Bundled by esbuild.                                                                                                                                                 |
| `@vn/git`           | Thin promisified wrapper over the `git` CLI (`isRepo`/`status`/`commit`/`log`/`show`/`diff`/`revert`/`restore`/`init`). Spawns via `node:child_process`, never interactive. **No policy** — gating lives in the agent. |
| `@vn/authoring`     | The `vnauthor` agent core: workspace index, `AICONTEXT.md` loader, tool registry, ReAct/native agent loop, plan-mode + permission gate, skills. Input-side only; cannot import pipeline/scheduler.                     |
| `@vn/authoring-app` | `vnauthor` interactive REPL: renders plan diffs, prompts for approval, streams turns, `/status` and `/skills` commands. Bundled by esbuild like `vngen`.                                                               |

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
vngen run [dir] [--mock]            parse → validate → preview → execute to the next gate
vngen approve <char> <hash> [dir]   approve a character portrait by asset hash
vngen status [dir]                  task/asset/approval summary
vngen graph [dir]                   emit the story branch graph (Mermaid)
vngen cost [dir]                    dry-run cost preview
```

`--mock` uses deterministic offline providers (no API keys needed). Without it, `run`
constructs real Gemini/Claude clients and requires a Gemini key (env var named in
`project.yaml`, or a secret file under `<dir>/keys/`).

### Project layout on disk

Authored input lives at the project root (`project.yaml`, `characters/<id>/character.md`,
`locations/<id>.md`, `screenplay/*.fountain`). Everything generated lives under `.vngen/`:
`work/` (human-editable: story graph, candidates, `approved.png`), `build/` (machine:
`assets/`, `manifest.json`), `state/` (`tasks.jsonl`, reviews). `.vngen/` is gitignored.

### Sample project

[`examples/sample`](examples/sample) is a small branching VN. End-to-end with mocks:

```sh
pnpm build
node apps/cli/dist/cli.js graph  examples/sample
node apps/cli/dist/cli.js cost   examples/sample
node apps/cli/dist/cli.js run    examples/sample --mock      # halts at the aiko gate
# copy a portrait hash from .vngen/build/manifest.json:
node apps/cli/dist/cli.js approve aiko <hash> examples/sample
node apps/cli/dist/cli.js run    examples/sample --mock      # clears the gate
node apps/cli/dist/cli.js status examples/sample
```

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
  var or a secret file under `<dir>/keys/`.

REPL commands: `/help`, `/mode` (plan vs. execute), `/status` (project index),
`/skills` (available skills), `/exit`.

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

- **Secrets.** The `keys/` directory and `.vngen/` are gitignored. API key _values_ must
  never be logged or committed. `project.yaml` records only model ids and env-var names.
  `resolveKeys` throws errors naming the _source_ (env var / file), never the value.
- **Imports** use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).
  jest's `moduleNameMapper` strips them; esbuild and `tsgo` resolve them.
- **Validation at the boundary.** Parse files and machine-consumed LLM output through the
  zod schemas in `@vn/types` so malformed data never reaches the deterministic core.
- Keep new packages inside the layering graph above; the boundaries lint rule will reject
  an illegal cross-layer import.

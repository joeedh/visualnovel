# Initial Implementation Plan — VN Generator

> Implements the design in [`docs/vn-generator-report.md`](../vn-generator-report.md).
> Scope: a pnpm/TypeScript monorepo that turns authored inputs (characters,
> branching screenplay, optional locations + reference images) into a deduped,
> resumable pipeline of generated art assets + a provenance manifest. Engine export
> is out of scope, per the report.

---

## 1. Guiding architecture decisions

The report separates **deterministic plumbing** (parse, dedupe, layout, scheduling)
from **generative steps** (LLM/image calls). Package boundaries mirror that split,
with strict layering so the future authoring agent
([`docs/authoring-agent-report.md`](../authoring-agent-report.md)) can reuse the
input-side packages without pulling in the generative pipeline.

Two decisions up front:

- **Source-only internal packages.** Internal packages expose `src/index.ts`
  directly via their `exports` map — no per-package `dist` build. `tsgo` typechecks
  the whole workspace via project references; `esbuild` bundles *only* at the app
  boundary (the CLI), resolving `workspace:*` deps from source. This removes
  build-order coupling and keeps the inner loop fast. Any package can later be
  switched to a published, pre-built artifact without touching consumers.
- **esbuild transpiles, tsgo verifies.** esbuild never type-checks; `tsgo --noEmit`
  is the gate (in `pnpm check` and CI). Declaration emit is only added if/when we
  publish a package.

### Toolchain

| Concern | Tool |
|---|---|
| Package manager / workspaces | pnpm + `pnpm-workspace.yaml` |
| Language / typecheck | TypeScript via native `tsgo` (`tsgo -b --noEmit`) |
| Transpile / bundle | esbuild (CLI bundle + jest transform only) |
| Tests | jest, transpiled through esbuild |
| Lint | eslint (typescript-eslint) + import-cycle + layering boundaries |
| Format | `@pathtx/prettier` fork |

---

## 2. Monorepo layout

```
visualnovel/
├─ pnpm-workspace.yaml
├─ package.json                 # root: scripts, devDeps (eslint, jest, esbuild, tsgo, prettier fork)
├─ tsconfig.base.json           # shared compiler opts
├─ tsconfig.json                # solution file: references every package
├─ eslint.config.mjs            # flat config; shared + layering rules
├─ prettier.config.cjs          # uses @pathtx/prettier
├─ jest.config.ts               # projects: one per package
├─ scripts/
│  └─ esbuild.cli.mjs           # bundles @vn/cli → bin
├─ packages/
│  ├─ types/                    # @vn/types        — entities, zod schemas, LLM I/O schemas
│  ├─ util/                     # @vn/util         — hashing, fs, logging, async pool, errors
│  ├─ config/                   # @vn/config       — project.yaml, key/secret loading
│  ├─ parse/                    # @vn/parse        — Fountain + branch markers, front-matter
│  ├─ model/                    # @vn/model        — project model + validation + graph
│  ├─ store/                    # @vn/store        — asset store, manifest, work-tree files
│  ├─ taskgraph/                # @vn/taskgraph    — content-addressed tasks, DAG, status log
│  ├─ providers/                # @vn/providers    — Gemini image/vision, Claude, LLM text
│  ├─ pipeline/                 # @vn/pipeline     — phases P1–P7 as task producers/runners
│  └─ scheduler/                # @vn/scheduler    — topo execution, gates, cost preview
└─ apps/
   ├─ cli/                      # @vn/cli          — `vngen run|approve|status|graph`
   └─ authoring-agent/          # (later) reuses parse+model+store+config
```

---

## 3. Package catalog

| Package | Responsibility | Report § | Depends on |
|---|---|---|---|
| `@vn/types` | All entity types (Character, Outfit, Location, Scene, Shot, Asset, Task), front-matter shapes, **zod schemas** for files and structured LLM output (defect lists, mined locations). Single source of truth for shapes. | §3, §7 | zod only |
| `@vn/util` | `sha256` content hashing, atomic fs writes, append-only JSONL helper, structured logger, bounded async pool (concurrency cap), typed error hierarchy. | §7, §10 | — |
| `@vn/config` | Load/validate `project.yaml` (title, art-style, model ids/params); resolve API keys from env/secret files (never logged). | §8, §11 | types, util |
| `@vn/parse` | Fountain parser + the `[[choice: … -> id]]` branch-marker layer; markdown front-matter read/write. Pure, no I/O policy. **Shared with authoring agent.** | §P0, §6 | types, util |
| `@vn/model` | Build the in-memory **project model** from parsed files; validate (refs resolve, every `goto` targets a real scene, reachability/dead-scene detection); emit `story.graph.mmd`. | §P0, §6 | types, util, parse |
| `@vn/store` | Persistence: content-addressed asset store (`build/assets/<hash>.ext`), `manifest.json` with provenance, and the `work/` markdown tree (characters/locations/scenes, candidates, approved.png). Read/write entity files. | §8, §9 | types, util, parse |
| `@vn/taskgraph` | `Task` node model, content-addressed dedupe key (`sha256(kind, prompt, [ref hashes], model, params)`), DAG build, topological order, `tasks.jsonl` status log, staleness/invalidation, resumability. | §7, §10 | types, util, store |
| `@vn/providers` | Provider-agnostic interfaces + concrete clients: `ImageProvider` (Gemini gen + reference edit), `VisionReviewer` (Gemini and Claude read-back, structured JSON), `TextLLM` (mining, decomposition, prompt refine). Retry/rate-limit/structured-output enforcement here. | §8, §P6, §P7 | types, util, config |
| `@vn/pipeline` | The phases. Each phase is a **planner** (emits Task nodes into the graph) + **runners** (execute a node). P1 location mining/breakdown, P2 ref shots (+ variant editing), P3 candidates, P4 model sheets/outfits, P5 scene→shot decomposition, P6 prompt synthesis, P7 generate→critique→refine (≤4). | §P1–P7, §5 | types, model, store, taskgraph, providers |
| `@vn/scheduler` | Walk the DAG, run tasks in dependency order under a concurrency cap, enforce **approval gates as barriers**, dry-run **cost preview** (N image calls / M reviews), crash-safe resume. | §7, §10 | taskgraph, pipeline, util |
| `@vn/cli` | `vngen` commands: `run` (parse→validate→preview→execute-to-gate), `approve <char> <hash>`, `status`, `graph`, `cost`. Bundled by esbuild into a single executable. | §10 | all of the above |

### Dependency graph (acyclic, strictly layered)

```
types  util
  │     │
config  parse
  │     │ │
  │   model store
  │     │   │  │
  │     │  taskgraph
providers   │
  │  │      │
  └──┴── pipeline
            │
        scheduler
            │
           cli
```

This graph is enforced by an eslint layering rule, not just documented.

---

## 4. Central contracts (the spine)

These interfaces in `@vn/types` define how everything composes; the rest is
implementation detail.

```ts
// A unit of generative work. Identity == content hash → dedupe + resumability.
interface Task<K extends TaskKind = TaskKind> {
  hash: string;                 // sha256(kind, prompt, refHashes, modelId, params)
  kind: K;                      // location_ref | portrait | model_sheet | outfit_sheet
                                // | shot_image | vision_review | prompt_refine
  deps: string[];               // upstream task hashes (DAG edges)
  inputs: TaskInputs[K];        // fully-specified, hashed into `hash`
  status: 'pending' | 'running' | 'done' | 'failed' | 'needs_human';
  output?: string;              // asset hash when done
  attempts: TaskAttempt[];      // full provenance per try
}

// Generative providers — swappable via project.yaml model ids.
interface ImageProvider {
  generate(prompt: string, refs: AssetRef[], params: ImageParams): Promise<ImageResult>;
  edit(base: AssetRef, prompt: string, refs: AssetRef[]): Promise<ImageResult>; // variants/outfits
}
interface VisionReviewer {                       // Gemini AND Claude both implement this
  review(image: AssetRef, spec: ShotSpec, refs: AssetRef[]): Promise<DefectReport>; // structured JSON
}

// A phase plugs into the scheduler as planner + runner pair.
interface Phase {
  plan(model: ProjectModel, graph: TaskGraph): void;       // emit/dedupe Task nodes
  run(task: Task, ctx: RunContext): Promise<TaskResult>;   // execute one node
}
```

The P7 loop, gate barriers, dedupe, and cost preview all fall out of these: the
scheduler only knows `Task`, `deps`, and `status`; it never imports a provider
directly.

---

## 5. Toolchain wiring details

**pnpm-workspace.yaml**
```yaml
packages: ['packages/*', 'apps/*']
```

**TypeScript + tsgo.** `tsconfig.base.json` holds strict opts (`strict`,
`moduleResolution: "bundler"`, `verbatimModuleSyntax`, `noEmit`). Each package has a
`tsconfig.json` extending base with `references` to its workspace deps; the root
solution `tsconfig.json` references all packages. `pnpm check` runs
`tsgo -b --noEmit` across the graph (native speed, incremental via `.tsbuildinfo`).
Internal imports resolve through each package's `exports → src/index.ts`, so no
intermediate build is needed.

**esbuild.** Only `apps/cli` is bundled: `scripts/esbuild.cli.mjs` bundles `@vn/cli`
with `platform: 'node'`, `format: 'esm'`, `bundle: true`, externalizing only SDK
deps that ship binaries. Workspace packages are pulled from source and tree-shaken.
Dev uses `--watch`. This is the one place runtime transpilation happens.

**jest + esbuild.** Tests run via a thin esbuild transform in `jest.config.ts` so
test transpile matches the bundler — no separate ts-jest type-checking pass (tsgo
owns types). `projects: [...]` defines one display-named project per package, so
`pnpm test --filter @vn/taskgraph` works. The generative SDKs are mocked behind the
`@vn/types` interfaces; provider packages test against recorded fixtures.

**eslint** at root (typescript-eslint), with `import/no-cycle` and a layering rule
(e.g. `eslint-plugin-boundaries`) enforcing the §3 dependency graph. Stylistic rules
defer to the formatter.

**Formatting** via `@pathtx/prettier`; `pnpm format` runs the fork across the tree.

Root scripts:
```jsonc
{
  "check": "tsgo -b --noEmit",
  "test": "jest",
  "lint": "eslint . && pnpm format:check",
  "format": "<pathtx-prettier> --write .",
  "build": "node scripts/esbuild.cli.mjs",
  "vngen": "node apps/cli/dist/cli.js"
}
```

---

## 6. Build order (milestones)

Each milestone is independently testable; the expensive generative pieces come last,
behind interfaces already exercised by mocks.

1. **Skeleton + toolchain.** Workspace, tsgo/esbuild/jest/eslint/prettier wired,
   `@vn/types` + `@vn/util` with the four spine interfaces and `sha256`. Acceptance:
   `pnpm check`, `pnpm test`, `pnpm build` all green with a trivial CLI.
2. **Input side.** `@vn/parse`, `@vn/model`, `@vn/config`. Fully testable with no API
   keys; also unblocks the authoring agent. Validation + `story.graph.mmd` here.
   Acceptance: parse a sample Fountain + branch markers into a validated project
   model; reject dangling `goto`s and unreachable scenes.
3. **State backbone.** `@vn/store` + `@vn/taskgraph`: content-addressed store,
   manifest, dedupe key, JSONL status, staleness/resume. Acceptance: identical task
   inputs collapse to one hash; re-run skips `done`; editing an upstream input marks
   only downstream tasks stale.
4. **Providers.** `@vn/providers` interfaces + Gemini/Claude clients, structured-output
   enforcement, against recorded fixtures. Acceptance: each provider satisfies its
   interface contract test; malformed model output is retried/rejected.
5. **Pipeline + scheduler.** Phases P1→P7 incrementally, scheduler with gates and cost
   preview, then real `vngen run`. Acceptance: a sample project runs parse → preview →
   execute-to-character-gate → (approve) → continue, producing a populated `build/`
   and manifest; P7 caps at 4 attempts and flags `needs_human`.

---

## 7. Open questions

- **Provider package granularity** — single `@vn/providers` vs. per-vendor packages
  (`@vn/provider-gemini`, `@vn/provider-claude`). Starting unified; split if vendor
  deps get heavy.
- **State storage** — `tasks.jsonl` append-only log first (simplest, git-friendly);
  add the optional `cache.sqlite` index (report §7) only if scan cost demands it.
- **tsgo project-reference incrementality** — confirm `tsgo -b` `.tsbuildinfo`
  behavior on the target version; fall back to `tsgo --noEmit` per-package if needed.

# Node-based asset generation

Status: **planned**. This plan distills
[`../research/node-based-asset-generation.md`](../research/node-based-asset-generation.md)
into committable stages. The research doc settled nine load-bearing decisions with the user
on 2026-08-24; none of them is reopened here, and where a stage below elaborates one it says
which. The fresh-context pressure-test that conventions.md requires ran on 2026-08-24
(seventeen findings, three blocking) and every finding is folded in below — the typecheck
wiring in Stage 1, the nstructjs pinning, the executor's target set, the requeue decision,
the refine scope, the claims/pins enabling work in Stage 10, and the plugin install
location are all sentences that review changed.

<!-- toc -->

- [Context](#context)
- [Verified ground truth](#verified-ground-truth)
- [The nine decisions, restated as constraints](#the-nine-decisions-restated-as-constraints)
- [Where `@vn/gengraph` sits](#where-vngengraph-sits)
- [Stages](#stages)
  - [Stage 1 — the package, the node model, and the wiring](#stage-1--the-package-the-node-model-and-the-wiring)
  - [Stage 2 — node identity, the journal, and drift](#stage-2--node-identity-the-journal-and-drift)
  - [Stage 3 — the DSL: read, replace, diff](#stage-3--the-dsl-read-replace-diff)
  - [Stage 4 — the cost model and the shipped price table](#stage-4--the-cost-model-and-the-shipped-price-table)
  - [Stage 5 — the built-in node set](#stage-5--the-built-in-node-set)
  - [Stage 6 — the executor and the graph runner](#stage-6--the-executor-and-the-graph-runner)
  - [Stage 7 — graph documents and the `gengraph.*` commands](#stage-7--graph-documents-and-the-gengraph-commands)
  - [Stage 8 — the agent tools](#stage-8--the-agent-tools)
  - [Stage 9 — CLI surfacing](#stage-9--cli-surfacing)
  - [Stage 10 — the Gen Graph editor pane](#stage-10--the-gen-graph-editor-pane)
  - [Stage 11 — plugins: manifest, toolchain, confirmed install](#stage-11--plugins-manifest-toolchain-confirmed-install)
  - [Stage 12 — prices from plugins, and porting the built-in providers](#stage-12--prices-from-plugins-and-porting-the-built-in-providers)
- [Verification](#verification)
- [Docs touched](#docs-touched)
- [Deliberately cut](#deliberately-cut)

<!-- tocstop -->

## Context

Today a slot's art is produced by a fixed runner: `makeShotRunner` and its siblings compose
a derived prompt, call the one hardcoded image backend, loop generate→critique→refine, and
write the winning bytes into the asset store. The node-based generator replaces the middle
of that sentence — how the picture is made — with a graph the author can see and edit: model
calls, prompt rewrites, reference lists and image edits as nodes, wired per slot or shared
across a cast. The two ends of the sentence do not move. A task keeps today's identity
(`hashParts(kind, inputs)` over the derived prompt, refs and params), and only the terminal
image enters the asset store.

The graph model is path.ux's own `Graph` (a submodule this repo already vendors, written by
the user), serialized as nstructjs JSON. The graph library side — sockets, nodes, groups,
the LLM DSL, ToolOps — is already built in path.ux (library stages 1–7 plus the headless
contract addendum, all checked off in
vendor/path.ux/documentation/plans/node-editor-tasklist.md). The editor widget this app
will host (`NodeGraphView`, stage V2 of vendor/path.ux/documentation/plans/node-editor-view.md)
is planned there and is **not replanned here**; only the app-side editor pane that hosts it
is (Stage 10).

Everything else is this repo's work: a new rules package `@vn/gengraph`, an executor wired
into the runner seam, `gengraph.*` commands as the only write path, a built-in node set,
agent tools, the Gen Graph pane, and a plugin system for third-party model nodes.

## Verified ground truth

Facts the stages below build on, checked against the working tree on 2026-08-24.

- `Runner` is `(task, deps) => Promise<TaskResult>` (packages/pipeline/src/runners.ts:24);
  `makeShotRunner` (runners.ts:103) holds the generate→critique→refine loop with
  `maxAttempts = Math.max(1, config.max_refine_attempts)`; `createRunners(config)`
  (runners.ts:181) is the one table of runners, consumed by the scheduler at
  packages/scheduler/src/scheduler.ts:136. This is the seam the graph runner plugs into.
- `max_refine_attempts` defaults to 4 (packages/types/src/schemas.ts:320).
- Task identity is `hashParts(kind, inputs)` (packages/taskgraph/src/hash.ts:10). The
  provider cache key is separate and stays separate: `requestKey` hashes
  `{op, prompt, ref hashes, params}` (packages/providers/src/cache.ts).
- Slot strings have one spelling: `slotKey` (packages/artgen/src/refcycle.ts:23),
  `slotLabel` (refcycle.ts:39) and `parseSlot` (refcycle.ts:59) in the same file. Output
  nodes bind slots in this vocabulary. `parseSlot` accepts `asset:<hash>` and bare hex as
  `asset` bindings, so an Output-slot check needs a refusal of its own for those (Stage 1).
- The image backend is hardcoded: `createProviders` builds
  `createGeminiImage(keys.gemini, config.models.image)` unconditionally
  (packages/providers/src/factory.ts). `ImageResult` and `ImageProvider` are the interfaces
  behind it (packages/types/src/providers.ts:9 and :19).
- Undo already excludes the journal's home: shadow-snapshot callers scope `paths` to
  exclude `build/` and `state/` (packages/commands/src/undo.ts doc comment), so a journal
  at `vngen/state/graphs/` is outside undo with no new mechanism.
- `costPreview` (packages/pipeline/src/pipeline.ts:48) counts calls against the planned
  wave only — the undercount the research doc contrasts graph estimates with.
- The agent reaches pipeline actions by injected capability, not import:
  `PipelineControl` (packages/authoring/src/tools.ts:126). `run_asset_graph` follows this
  pattern.
- `buildSlotGraph` (packages/artgen/src/slotgraph.ts:304) is the existing slot-level view
  the drift surface joins.
- The editor list is one array, `EDITORS` (apps/desktop/src/shared/editors.ts:22), with
  sixteen entries. Task Graph claims every `slot` node at tier `primary` unconditionally
  (editors.ts:56); EDITORS order breaks claim ties in favor of the earlier entry; a claim
  predicate sees only `ClaimNode` — `{kind, path?}` (editors.ts:133) — and `PinField` is a
  closed union with `PIN_NOUN` beside it (editors.ts:180). Stage 10 has to grow all three
  before a Gen Graph claim can win a bound slot. renderer/tsconfig.json's `paths` maps
  only five `@vn/*` packages today.
- Only the renderer resolves path.ux today: the `pathux` alias lives in
  apps/desktop/vite.config.ts:21 and nowhere else. The esbuild bundles (main, preload,
  CLI, authoring) share the `@vn/*` alias map in scripts/aliases.mjs, which knows nothing
  of path.ux; jest.config.cjs keeps its own per-package project list. Stage 1 wires all
  three, which path.ux's headless-contract addendum exists to make legal: `scripts/graph`
  imports in plain Node with no DOM.
- Runtime cleanliness is not typecheck cleanliness. The graph module's import chain pulls
  in `ToolProperty`, `Vector2` and `DataStruct` for real (vendor/path.ux/scripts/graph/node.ts:3-5),
  and that chain reaches `navigator` and `window.console` in path-controller's util —
  while the flat workspace program checks under `lib: ["ES2023"]` with no DOM
  (tsconfig.base.json:5). Vendor source therefore cannot join the flat check; the repo's
  existing answer is declarations: `pnpm --dir apps/desktop check` runs
  `build:pathux-types` first, and renderer/tsconfig.json maps `pathux` to
  `dist/pathux-types/pathux.d.ts`. The `paths` map the flat check reads lives entirely in
  the root tsconfig.json (the base has none, and a child's `paths` replaces its parent's
  wholesale); the root `check` script runs the flat pass before `check:renderer`
  (package.json:21), so the declaration build must move ahead of it.
- path.ux reaches the bare `nstructjs` specifier through
  path-controller/util/nstructjs.ts:3 (`export * from "nstructjs"`). The desktop jest
  project maps it to `vendor/nstructjs/build/_nstructjs.js` (jest.config.cjs:96 — the
  published package's ESM `main` cannot load in the CJS runner), but the shared mapper
  does not; the pathux-types build maps its types to
  `vendor/nstructjs/build/structjs.d.ts` (apps/desktop/pathux-types.tsconfig.json:23);
  scripts/aliases.mjs knows nothing of it, so an esbuild bundle would resolve it to
  path.ux's own installed copy. Two copies of nstructjs in one process means two STRUCT
  registries: the graph module registers its STRUCTs in one while `readJSON`/`validateJSON`
  consult the other, and every graph load fails. None of the three gates can see this.
- path.ux's graph module already exports what the DSL stages consume:
  `validateGraphDSL` and `buildGraphFromDSL` (vendor/path.ux/scripts/graph/dsl.ts:43 and
  :53), `registerNodeType`, `graphDef()`, groups, and the graph and socket STRUCTs. No
  island/auto-arrange helper exists yet — auto-arrange is a stage-V3 deliverable there, so
  Stage 5 ships its own placement fallback.
- A project's `.gitattributes` is grown by merge-append: `GITATTRIBUTES_BLOCKS` and the
  writer that adds only missing lines (apps/desktop/src/main/workspace.ts:275 and :304).
  The `work/graphs/*.json -merge` line lands there.
- The source-only package template is packages/artgen/package.json: `private`, `type:
  module`, `exports` naming `./src/index.ts`, `workspace:*` deps, no build script.

## The nine decisions, restated as constraints

Each stage cites these by number. The full argument for each is in the research doc.

1. **A bound graph is the slot's runner.** The graph changes how a task runs, never what
   it is. Task hashes do not move when a graph is edited; the difference shows as drift.
   One journal serves scheduled and interactive runs.
2. **The path.ux graph is the model.** Main holds real `Graph` objects; files are
   nstructjs JSON checked by nstructjs's `validateJSON` on load, with the semantic pass
   (props against spec, socket compatibility, slot-key parse) in `@vn/gengraph`.
3. **Plugins install by explicit confirmation and run trusted**, against a capability-only
   `services` API. A sandbox is a later harness change, not a v1 requirement.
4. **Groups ship in v1**, from path.ux stage 5, loaded through the app's
   `groupLoader`/`groupSaver` from `work/graphs/lib/<name>.json`.
5. **A graph may carry several Output nodes**, each with a slot-key prop. Same-target
   outputs resolve Blender-style to an app-tracked active flag — document state written by
   a command. Editor-side selection mechanics wait for the pane.
6. **The refine loop wraps the graph run.** Critic and `max_refine_attempts` stay host
   policy in the runner. Critique enters through a wired Refine input node reaching the
   active Output; with none wired, the refiner modifies the derived prompt. Only the tail
   downstream of the entry point re-runs.
7. **Intermediates are repo-saved but never assets.** Journal-referenced content-addressed
   blobs under `vngen/state/graphs/<slug>/`, no `AssetKind`, only the terminal image enters
   the asset store.
8. **Prices come from the release and the plugins.** A shipped table refreshed at release
   (`pricesAsOf`), plus a per-user (not per-project) table at `userConfigDir` populated by
   model plugins only on the author's request, optionally via a declared price-agent
   capability running on the author's own key through the provider ring.
9. **Names.** `@vn/gengraph`, `gengraph.*` commands, a pane titled Gen Graph.

## Where `@vn/gengraph` sits

A constrained leaf beside `@vn/artgen`, one rung wider: it may import `types`, `util`,
`config`, `model`, `store`, `taskgraph` and `artgen` (for `parseSlot` and the slot
vocabulary), and deliberately not `providers`, `pipeline` or `scheduler` — every model call
goes through the injected `services` interface the package itself declares. Three consumers
add `gengraph` to their allow-lists: `pipeline` (the graph runner), `authoring` (the three
agent tools' rules), and `desktop`. `authoring` importing `gengraph` is legal the same way
its `artgen` import is: the leaf carries rules, and execution reaches the agent only as an
injected capability. eslint.config.mjs gets the `ALLOWED` entry, the boundaries element
pattern, and the three consumer-list additions in Stage 1.

The executor — the code that walks a sorted graph and runs node runtimes — lives inside
`@vn/gengraph`. What lives beside the pipeline spine is only the thin runner wrapper
(Stage 6) that hands it providers-backed services, which keeps the executor reachable from
the CLI scheduler and the desktop while `@vn/authoring` never gains a path to it.

## Stages

Every stage is one commit, green on its own under `pnpm check`, `pnpm test` and
`pnpm lint`, with tests in `tests/` siblings. Stages 1–9 have no dependency on path.ux
stage V2; Stage 10 does and says so.

### Stage 1 — the package, the node model, and the wiring

Create `packages/gengraph` from the artgen template (decision 9). Wire the toolchain in the
same commit, because nothing in the package resolves without it:

- `pnpm-workspace.yaml` needs no edit (it globs `packages/*`); jest.config.cjs `PACKAGES`
  gains `'gengraph'`; scripts/aliases.mjs `PACKAGES` gains `'gengraph'`.
- One new alias name, `pathux-graph`, through which `@vn/gengraph` alone imports the
  graph module. It resolves to **source** where code runs and to **declarations** where
  code is only checked. Source: scripts/aliases.mjs (picked up by esbuild.desktop.mjs,
  esbuild.cli.mjs, esbuild.authoring.mjs and gen-command-catalog.mjs), jest's shared
  `moduleNameMapper`, and apps/desktop/vite.config.ts beside the existing `pathux` alias.
  Declarations: the root tsconfig.json's `paths` — the one map the flat check reads —
  points at graph declarations emitted by the existing `build:pathux-types` pass (its
  `rootDir` already spans `scripts/`), and the root `check` script runs that build before
  the flat `tsgo` pass. The addendum's runtime headlessness never promised typecheck
  cleanliness, and the graph module's import chain reaches DOM types the flat program's
  `lib` lacks — declarations are how the repo already solves this for the renderer.
- One type-identity rule with the split: every checker surface that sees both `pathux` and
  `pathux-graph` resolves the graph module through the *same* declaration output. path.ux
  classes carry private members, so a source-typed `Graph` and a declaration-typed `Graph`
  are nominally incompatible duplicates.
- `nstructjs` pinned to the `vendor/nstructjs` submodule on every new surface, or the
  graph module and `@vn/gengraph` end up in different STRUCT registries: an entry beside
  the `@vn/*` map in scripts/aliases.mjs, the desktop jest project's mapping promoted to
  the shared `moduleNameMapper`, and `vendor/nstructjs/build/structjs.d.ts` in the root
  tsconfig `paths` (the pathux-types config's own mapping is the template).
- docs/guides/toolchain.md records the new aliases and the declaration-build ordering in
  this stage — it is the file that documents every toolchain deviation.

The package's first content, all pure and browser-safe:

- **Node type registry.** A node type has up to three parts (research §"What a node type
  is"): the shared class+spec (a path.ux `Node` subclass with `graphDef()`, sockets and
  `ToolProperty` props, plus app metadata: `typeVersion`, a `spends` flag, the cost
  entries Stage 4 reads); a runtime `run(inputs, props, services)` registered by type
  name; an optional `createUI` the renderer alone registers. Stage 1 ships the registry
  and the spec half; runtimes arrive in Stage 5.
- **Load/save.** `readGraphFile` / `writeGraphFile` over nstructjs `writeJSON`/`readJSON`
  with `validateJSON` at the boundary (decision 2), returning diagnostics rather than
  throwing.
- **Semantic validation.** The pass after `readJSON`: props match the registered spec,
  links join compatible sockets, every Output node's slot prop parses under `parseSlot`
  and is not an `asset` binding — `parseSlot` accepts `asset:<hash>` and bare hex, and an
  immutable content address is nothing a generator output can bind, so it is refused by
  name — and unknown node types are reported by name (a plugin not installed here).
  Unbound graphs — no Output node, or an Output with an empty slot — are legal
  (decision 5's scratch-graph analogue of a concept image).
- **`GenServices`.** The capability interface node runtimes and plugins see: image
  generate/edit, chat, blob read/write, asset-store read (Stage 5's Slot-ref and
  Image-file nodes read existing art), a fetch routed through the provider request ring
  (Stage 12's price agent declares it in its manifest), and key lookup by declared name.
  The derived prompt is deliberately absent: the host computes it and seeds it as a node
  input on both the scheduled and the interactive path (Stages 6 and 7), which keeps the
  project model out of the services surface. Declared here, implemented by hosts in
  Stage 6 (decision 3 depends on this being the only surface).

Tests: registry round-trip, a graph file round-trip through JSON, each semantic-diagnostic
case, and a headless import test that spawns an actual `node` child process — inside jest
the esbuild transform and the module mapper stand between the test and the module, so an
in-runner import would prove less than path.ux's own addendum test does.

### Stage 2 — node identity, the journal, and drift

Pure logic, no I/O beyond an injected blob store.

- **`nodeHash`** = `hashParts(typeName + typeVersion, canonicalProps, orderedInputHashes)`
  — image inputs by content hash, scalars by canonical JSON, so dirtiness propagates by
  construction (research §"Node identity"). Zero and empty-string prop values hash like
  every other value; presence tests stay `=== undefined` per the artNotes precedent.
- **Paths.** One module fixes both roots: graph documents at `work/graphs/<slug>.json`
  (with `work/graphs/lib/` for groups) and journals plus blobs under `vngen/state/graphs/`.
  Stage 6's index and its tests read these constants; Stage 7 builds the commands on them.
- **Journal.** `vngen/state/graphs/<slug>.jsonl`, append-only full snapshots
  `{v, nodeId, nodeHash, status, output?, usage?, error?, at}` — `v` on every line, the
  notifications.jsonl precedent for a committed file that will outlive its schema —
  replayed last-writer-wins the way `state/tasks.jsonl` is. Deliberately outside undo,
  like the rest of `state/` (the exclusion already in undo.ts covers it). One journal per
  graph serves the scheduler and the interactive pane alike.
- **Blob store.** Content-addressed bytes under `vngen/state/graphs/<slug>/`, written by
  hash, referenced from journal records, committed to the project repo, never entering
  either asset root (decision 7).
- **Drift.** `graphDrift(graph, journal)`: recompute the active Output node's hash and
  compare with the journal's last `done` record for that node. Reported, never an
  invalidation — the same posture as `Shot.proseHash`.

Tests: hash stability and propagation, journal replay including a crashed half-written
line, blob round-trip, drift on a prop edit and no drift on a layout move.

### Stage 3 — the DSL: read, replace, diff

The agent's editing surface, built on path.ux's `validateGraphDSL`/`buildGraphFromDSL`
(dsl.ts:43, :53) and shared later by `gengraph.*` and the tools.

- `graphToDSL(graph)` — the text form, no layout in it.
- `applyGraphDSL(graph, text)` — validate (diagnostics returned for self-repair, never a
  throw), build, then diff against the live graph **by node id**: surviving nodes keep
  their positions and their journal history; removed nodes go; new nodes are placed by a
  deterministic placement helper (a grid right of the existing bounds). The helper is a
  stopgap path.ux stage V3's auto-arrange replaces; it is pure and tested so the swap is
  one call site.
- Whole-graph replacement is the only mutation the DSL path offers (research §"How the
  agent edits") — partial patches are the editor's and the commands' job.

Tests: round-trip `applyGraphDSL(g, graphToDSL(g))` is a no-op diff; a renamed-id node is
a delete-plus-add; positions survive edits; each diagnostic reaches the caller.

### Stage 4 — the cost model and the shipped price table

- Each spec may declare `estimate(props, inputContext) → [{service, model, unit, count}]`
  with `unit` one of `image`, `mtok-in`, `mtok-out`. A whole-graph estimate is the sum
  over a topological walk — possible here and impossible for `vngen cost`, because every
  edge is known up front (research §"Cost"). The refine wrap adds a bounded multiplier of
  `max_refine_attempts` over the tail downstream of the refine entry point (decision 6).
- The shipped price table: a JSON module in `@vn/gengraph` carrying `pricesAsOf` and
  per-model unit prices, refreshed at release (decision 8). A model absent from every
  table prices as an explicitly `unpriced` line naming the model — never silently zero.
- Actual usage lands in the journal's `usage` field (Stage 2's shape) so estimates can be
  audited against spend.

Tests: a three-node graph's estimate, the refine multiplier hitting only the tail, the
unpriced line, and a `pricesAsOf` staleness helper (pure date math, no clock read inside
the package).

### Stage 5 — the built-in node set

The starter set from research §"The starter set", specs plus runtimes, runnable entirely
against mock services (no live keys anywhere in tests): Derived prompt, Task refs, Slot
ref, Text/Template, LLM rewrite, Generate image, Edit image, Reference list, Image file,
Refine prompt (empty until a refine pass supplies it), Switch/Blend, Output image. Model
nodes are configurable to emit any output type the host supports (decision 6's tail
re-run depends on this). Runtimes reach models only through `GenServices`. The
Derived-prompt node's runtime is a pass-through of a host-seeded input on both paths —
the scheduled runner seeds it from the task, and `gengraph.run` has the session compute
it from the bound slot via the existing `build*Chunks` derivation — because the
derivation needs the project model, which `GenServices` deliberately does not carry.

Tests: each node's runtime against a scripted mock service; the Derived-prompt node
reproducing byte-identically what the current runner composes for a fixture slot, which is
the property decision 1 rests on.

### Stage 6 — the executor and the graph runner

- **Executor** (in `@vn/gengraph`): takes the graph and a **target node set**, and
  evaluates only the targets' ancestors in path.ux's Tarjan `sort()` order — a scheduled
  run targets the slot's active Output, an interactive run targets the output the author
  asked for, and `spends` nodes on a scratch branch or under another target's subtree
  never fire. Nodes whose journal record already matches their hash are skipped (resume
  for free); the rest run through their runtimes, every transition is journaled, and
  intermediates land as blobs. A failing node writes a terminal record with `error` and
  stops its downstream, matching the failure-record posture of tasks.
- **A deliberate re-render is an invalidation, not a re-walk.** With every node clean, a
  plain requeue of a bound slot would skip straight to the cached image — a silent
  regression from today's `regenerate`, which re-rolls the model. Decided here:
  `PipelineControl.regenerate` on a bound slot, and `gengraph.run` with an explicit
  `force` flag, append an `invalidated` journal record for each `spends` ancestor of the
  target output, so those nodes and their downstream re-run while deterministic prep
  still resumes.
- **Runner wrapper** (in `@vn/pipeline`): when the task's slot is bound to a graph, the
  runner seeds the Derived-prompt and Task-refs inputs from the task, executes the graph
  against the slot's active Output, and — for `shot_image` only — wraps it in the
  existing refine loop: critic unchanged, `max_refine_attempts` unchanged, critique
  entering through a wired Refine node reaching the active Output or else modifying the
  derived prompt, with only the tail re-running per attempt (decision 6). The critique
  loop exists only for shots today (reviewers judge against a `ShotSpec`, runners.ts:103);
  a bound `portrait`, `model_sheet` or `location_ref` task runs its graph in a single
  pass, matching those runners' loop-free shape now. The terminal image goes through the same `deps.store.write` call the
  current runners use, with the same metadata, so nothing downstream can tell which path
  drew it (decision 1). An unbound slot runs exactly today's code.
- **Services implementation**: providers-backed `GenServices` built beside
  `createRunners`, shared by the CLI scheduler and the desktop session, carrying the
  asset-store read and the ring-routed fetch Stage 1 declares. Plugin and built-in
  requests alike pass through the provider ring.
- The slot→graph index: built on load by scanning every graph's Output bindings
  (decision 5), owned by the host session, consulted by the runner wrapper.

Tests (testkit): a bound fixture graph runs end to end through the real scheduler with
mock providers; resume skips clean nodes; a refine attempt re-runs only the tail; the
asset store's record is shape-identical between graph and legacy paths; `adoptSlot`'s
refusals are untouched.

### Stage 7 — graph documents and the `gengraph.*` commands

Graphs become authored documents, writable only through commands.

- `work/graphs/<slug>.json` (nstructjs JSON), inside undo scope like the rest of `work/`;
  group library files at `work/graphs/lib/<name>.json` behind the app's
  `groupLoader`/`groupSaver` (decision 4). The project `.gitattributes` writer
  (workspace.ts:275) gains `work/graphs/*.json -merge` and `work/graphs/lib/*.json
  -merge`, refusing a conflicted graph by name the way layout templates are refused.
- New command file apps/desktop/src/main/commands/gengraph.ts: `gengraph.create`,
  `gengraph.delete`, `gengraph.addNode`, `gengraph.removeNode`, `gengraph.link`,
  `gengraph.unlink`, `gengraph.setProp`, `gengraph.setActiveOutput` (decision 5's active
  flag — document state, undoable, diffable), `gengraph.apply` (the Stage-3 whole-DSL
  replacement as a command), `gengraph.estimate`, `gengraph.run`. Each mutating command
  declares its refusal through `check`; `gengraph.run` quotes the Stage-4 estimate in its
  confirmation. Output-slot binding is `gengraph.setProp` on the Output node, refused
  when the slot string does not parse.
- `gengraph.run` executes interactively through the same executor and journal the
  scheduler uses (decision 1), targeting the active Output by default or a named one by
  prop; a run against a spending graph is the one confirm-gated command here. Its
  `force` flag performs Stage 6's invalidation before running, so re-running an
  unchanged bound slot is a real request rather than a silent no-op.
- `doc.*` refuses `work/graphs/**` the way it refuses `scenes/**`. Without the refusal
  the path is live: `isTextPath` counts `.json` as text (editors.ts:157) and Wiki claims
  text files primary, so a graph would open as a textarea and a save would go past
  `validateJSON` and every `gengraph.*` check. The document tree lists a graph as a
  graph node, never as editable text.

Tests: command round-trips over a temp project (create → addNode → link → apply → undo),
each declared refusal, the `-merge` line landing exactly once, and provenance records
carrying no key material (`prop.secret` is not needed here — no command takes a secret).

### Stage 8 — the agent tools

Three tools in `@vn/authoring`, sharing decisions with the commands via `@vn/gengraph`
imports, not registry transport (the command-system precedent):

- `read_asset_graph(slug)` — the DSL form, no layout.
- `edit_asset_graph(slug, dsl)` — Stage 3's validate-then-apply; diagnostics come back to
  the model for self-repair; the write itself goes through the same rules module
  `gengraph.apply` uses.
- `run_asset_graph(slug)` — an injected capability beside `PipelineControl`
  (tools.ts:126), quoting the same estimate and requiring the same confirmation as the
  human path; plan mode blocks it.

Desktop wiring hands the session's implementations in; `vnauthor` gets the same tools with
the same refusals. Tool descriptions state their scope truthfully (the
improving-the-authoring-agent rule).

Tests: tool-level round-trip against a fixture project, a refused run in plan mode, a
diagnostic fed back verbatim, and a boundaries check that `@vn/authoring` still imports
neither `pipeline` nor `scheduler`.

### Stage 9 — CLI surfacing

`vngen` needs no new subcommand to run graphs (the runner seam covers `vngen run`), but
two places must stop lying: `vngen cost` estimates every bound slot the slot graph
enumerates (`buildSlotGraph`), planned or not, replacing the call-count line for those
slots — pricing only planned pending tasks would re-import the incremental-planning
undercount the graph estimate exists to fix — and `vngen status` names a drifted graph
the way it names failed tasks. Both readers reach `@vn/gengraph` through `@vn/pipeline`,
which re-exports Stage 2's and Stage 4's pure functions; the CLI adds no direct import,
keeping the allow-list consumers at three.

Tests: cost and status output over a testkit project with one bound slot.

### Stage 10 — the Gen Graph editor pane

**Prerequisite: path.ux stage V2** (`NodeGraphView` and the `NodeGraphDelegate` seam,
vendor/path.ux/documentation/plans/node-editor-view.md). This stage starts when V2 lands
and not before; nothing in Stages 1–9 waits on it.

- Enabling work first, because the current claim machinery cannot express this editor:
  `ClaimNode` (editors.ts:133) is `{kind, path?}` and carries no binding information, so
  it grows an optional `boundGraph` slug, stamped by main where the document tree is
  built; the `PinField` union (editors.ts:180) is closed, so it gains `'graphSlug'` with
  a `PIN_NOUN` entry and the selection plumbing behind it; and
  renderer/tsconfig.json's `paths` gains `@vn/gengraph`, `pathux-graph` and their deps
  so the renderer pass still typechecks.
- Editor #17: an `EDITORS` entry `{id: 'gengraph', title: 'Gen Graph', what: …}` in
  apps/desktop/src/shared/editors.ts, offered (unlike Setup and Debug Agent). Claim
  resolution is decided by tier, not by `EDITORS` order — Task Graph's slot claim
  (editors.ts:56) is today unconditionally `primary`, and `CLAIMS` is built in `EDITORS`
  order, so an appended #17 would always lose the tie. Instead: Gen Graph answers
  `primary` for a slot whose `ClaimNode.boundGraph` is set, Task Graph answers
  `secondary` for those and keeps its unconditional `primary` on unbound slots. `pins:
  'graphSlug'` pins a pane to one graph.
- renderer/pathux/editors/nodes.ts subclasses `VnEditor`, hosts `NodeGraphView` via
  `appendSurface` with its own adopted sheet, and installs a delegate that routes every
  mutating gesture into `gengraph.*` commands, honoring the mid-gesture-verdict rule via
  `stack.check`. `createUI` registrations for the built-in nodes land here, renderer-only.
- Active-output display and click-to-activate go through `gengraph.setActiveOutput`
  (decision 5: no path.ux-side active-output support).
- Tooltips on every control, per CLAUDE.md; command-backed controls take the registry's
  own text.
- docs/plans/desktop-editors-tracking.md records "Prompt node editor — Not being built"
  (~line 155); this pane supersedes that verdict, and the tracking doc is updated when
  the pane ships.

Tests: the pure routing/claims logic in a `tests/` sibling; the surface itself verified
live over CDP, as with every editor.

### Stage 11 — plugins: manifest, toolchain, confirmed install

- A plugin is a directory with `plugin.json` (name, version, node types, services called,
  key names, price-table fragment) and `.ts` sources split the same three ways as
  built-ins (research §"Plugins"). The public surface is `@vn/gengraph/plugin`, a
  versioned subpath export (the `scriptedit/write` precedent in aliases.mjs `SUBPATHS`).
- A shipped esbuild-based transpile step bundles a plugin against that API at install
  time. Whether the packaged app carries the native esbuild binary or esbuild-wasm is the
  one open packaging question the research doc leaves; this stage decides it by
  measuring both in `pnpm package` and records the answer here.
- Install is an explicit confirmation naming the manifest's declared services and key
  names (decision 3); installed plugins run trusted. Keys resolve through the existing
  four-place `resolveKeys` chain and are set by `project.setKey`; nothing new touches key
  storage. Plugin model calls pass through the provider ring like every other request.
- Plugins install per-user, under `userConfigDir`'s `plugins/<name>/` — deliberately not
  per-project, because the install confirmation is a trust act by the person at the
  machine, and a cloned repo must not arrive pre-confirmed. The transpiled bundle is
  cached beside the sources. The cost is named: opening the project on another machine
  gets Stage 1's unknown-node diagnostic naming the plugin, not a silent substitute.
- The agent's raw file writers refuse those paths outright (the `create_skill` /
  `edit_skill` precedent): a plugin the confirm dialog names was put there by a person.

Tests: manifest schema cases, a fixture plugin transpiled and loaded with its node type
registered and runnable against mock services, the writer refusal, and a packaged-app
smoke assertion in `pnpm smoke` that the transpile toolchain resolves.

### Stage 12 — prices from plugins, and porting the built-in providers

- The per-user price table at `userConfigDir` (decision 8: per-user, deliberately not
  per-project), populated by a model plugin only on the author's explicit request. A
  plugin whose provider publishes no pricing API may declare the price-agent capability:
  an LLM call with web fetch on the author's own key, through the provider ring, declared
  in the manifest and shown at install.
- The first-party image provider becomes the first real plugin: the Gemini generate/edit
  node runtimes ported onto the plugin API, so `createGeminiImage`'s hardcoded seat in
  factory.ts stops being load-bearing for graph runs. The legacy non-graph path keeps
  using factory.ts unchanged; retiring it is out of scope.
- Table precedence when both tables price a model: the per-user entry wins, and the
  estimate names which table priced each line.

Tests: table merge precedence, the request-gated population flow with a scripted agent,
and the ported Gemini plugin running a fixture graph against mock services.

## Verification

- Every stage: `pnpm check`, `pnpm test`, `pnpm lint` green before commit.
- Decision 1's core property gets a standing test (Stage 5/6): binding a graph that
  reproduces the derived prompt changes no task hash, and editing that graph moves drift,
  not hashes.
- The end-to-end pass after Stage 10: author a graph in the pane, bind it, run the
  pipeline, watch the frame in PLAY — the same ritual script-composition used.
- No test or fixture ever contains a real key; mock art carries the testkit marker the
  real backend refuses.

## Docs touched

- CLAUDE.md: the package graph diagram and packages.md gain `gengraph`; a Core-ideas
  bullet for graphs-as-runners once Stage 6 ships.
- docs/reference/packages.md, docs/reference/pipeline-contracts.md,
  docs/reference/command-system.md (the `gengraph.*` namespace),
  docs/reference/desktop-app.md and desktopAppState.md (the pane, `work/graphs/`,
  `vngen/state/graphs/`): each updated in the stage that makes them stale.
- docs/guides/toolchain.md: Stage 1's alias wiring — the `pathux-graph` entry in
  aliases.mjs, the declaration build ordered before the flat `tsgo` pass, and the
  type-identity rule.
- docs/plans/desktop-editors-tracking.md: Stage 10 supersedes the "Prompt node editor —
  Not being built" entry; updated when the pane ships.
- docs/plans/index.md: this plan's row, kept current per stage.

## Deliberately cut

- A plugin sandbox (decision 3 defers it to a harness change).
- Editor-side active-output selection mechanics beyond click-to-activate (decision 5).
- Retiring the legacy non-graph runner path and factory.ts's provider seat.
- Automatic price refresh on a schedule (decision 8: author-requested only).
- path.ux stages V2–V4 themselves — planned and tracked in
  vendor/path.ux/documentation/plans/node-editor-view.md.

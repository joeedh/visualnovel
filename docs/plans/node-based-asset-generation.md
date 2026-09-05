# Node-based asset generation

Status: **in progress**, Stages 1 to 9 shipped. This plan distills
[`../research/node-based-asset-generation.md`](../research/node-based-asset-generation.md)
into committable stages. The research doc settled nine load-bearing decisions with the
user on 2026-08-24. No stage below reopens one, and a stage that elaborates a decision
names the decision it elaborates. The fresh-context pressure-test that conventions.md
requires ran on 2026-08-24 (seventeen findings, three blocking) and every finding is
folded in below. Review changed the sentences on the typecheck wiring in Stage 1, the
nstructjs pinning, the executor's target set, the requeue decision, the refine scope, the
claims/pins enabling work in Stage 10, and the plugin install location.
[`../reference/gen-graphs.md`](../reference/gen-graphs.md) describes as shipped everything
this plan built; this file keeps the stages and the deviations each stage took.

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

Today a slot's art is produced by a fixed runner. `makeShotRunner` and its siblings
compose a derived prompt, call the one hardcoded image backend, loop
generate→critique→refine, and write the winning bytes into the asset store. The node-based
generator replaces the middle step, the one that makes the picture, with a graph the
author can see and edit, whose nodes are model calls, prompt rewrites, reference lists and
image edits, wired per slot or shared across a cast. The steps on either side do not
change. A task keeps today's identity (`hashParts(kind, inputs)` over the derived prompt,
refs and params), and only the terminal image enters the asset store.

The graph model is path.ux's own `Graph` (a submodule this repo already vendors, written
by the user), serialized as nstructjs JSON. The graph library side (sockets, nodes,
groups, the LLM DSL, ToolOps) is already built in path.ux (library stages 1–7 plus the
headless contract addendum, all checked off in
vendor/path.ux/documentation/plans/node-editor-tasklist.md). The editor widget this app
will host (`NodeGraphView`, stage V2 of
vendor/path.ux/documentation/plans/node-editor-view.md) is planned there and is not
replanned here. This plan covers only the app-side editor pane that hosts it (Stage 10).

This repo builds everything else: a new rules package `@vn/gengraph`, an executor wired
into the runner seam, `gengraph.*` commands as the only write path, a built-in node set,
agent tools, the Gen Graph pane, and a plugin system for third-party model nodes.

## Verified ground truth

The stages below build on these facts, which were checked against the working tree on
2026-08-24.

- `Runner` is `(task, deps) => Promise<TaskResult>` (packages/pipeline/src/runners.ts:24);
  `makeShotRunner` (runners.ts:103) holds the generate→critique→refine loop with
  `maxAttempts = Math.max(1, config.max_refine_attempts)`; `createRunners(config)`
  (runners.ts:181) is the one table of runners, which the scheduler consumes at
  packages/scheduler/src/scheduler.ts:136. The graph runner plugs into that table.
- `max_refine_attempts` defaults to 4 (packages/types/src/schemas.ts:320).
- Task identity is `hashParts(kind, inputs)` (packages/taskgraph/src/hash.ts:10). The
  provider cache key remains separate. `requestKey` hashes
  `{op, prompt, ref hashes, params}` (packages/providers/src/cache.ts).
- Slot strings have one spelling, set by `slotKey` (packages/artgen/src/refcycle.ts:23),
  `slotLabel` (refcycle.ts:39) and `parseSlot` (refcycle.ts:59) in the same file. Output
  nodes bind slots with these names. `parseSlot` accepts `asset:<hash>` and bare hex as
  `asset` bindings, so an Output-slot check must refuse those cases itself (Stage 1).
- The image backend is hardcoded. `createProviders` builds
  `createGeminiImage(keys.gemini, config.models.image)` unconditionally
  (packages/providers/src/factory.ts). `ImageResult` and `ImageProvider` are the
  interfaces the image backend implements (packages/types/src/providers.ts:9 and :19).
- Undo already excludes the directory that holds the journal. Shadow-snapshot callers
  scope `paths` to exclude `build/` and `state/` (see the doc comment in
  packages/commands/src/undo.ts), so a journal at `vngen/state/graphs/` is outside undo
  and needs no new mechanism.
- `costPreview` (packages/pipeline/src/pipeline.ts:48) counts only the calls in the
  planned wave. The research doc contrasts this undercount with graph estimates.
- The agent reaches pipeline actions through an injected capability rather than an import:
  `PipelineControl` (packages/authoring/src/tools.ts:126). `run_asset_graph` follows this
  pattern.
- `buildSlotGraph` (packages/artgen/src/slotgraph.ts:304) is the existing slot-level view,
  and the drift surface joins it.
- The editor list is one array, `EDITORS` (apps/desktop/src/shared/editors.ts:22), with
  sixteen entries. Task Graph claims every `slot` node at tier `primary` without any
  condition (editors.ts:56). Ties between claims go to whichever entry comes earlier in
  `EDITORS`. A claim predicate sees only `ClaimNode`, which is `{kind, path?}`
  (editors.ts:133), and `PinField` is a closed union with `PIN_NOUN` beside it
  (editors.ts:180). Stage 10 must extend all three before a Gen Graph claim can win a
  bound slot. The `paths` field in renderer/tsconfig.json maps only five `@vn/*` packages
  today.
- Only the renderer resolves path.ux today. The `pathux` alias appears in
  apps/desktop/vite.config.ts:21 and nowhere else. The esbuild bundles (main, preload,
  CLI, authoring) share the `@vn/*` alias map in scripts/aliases.mjs, which has no entry
  for path.ux, and jest.config.cjs defines its own per-package project list. Stage 1 wires
  all three. The headless-contract addendum to path.ux makes that legal: scripts/graph
  imports in plain Node with no DOM.
- Passing the typecheck does not mean the code runs cleanly. The graph module's import
  chain pulls in `ToolProperty`, `Vector2` and `DataStruct` as real imports
  (vendor/path.ux/scripts/graph/node.ts:3-5), and that chain reaches `navigator` and
  `window.console` in path-controller's util, while the flat workspace program checks
  under `lib: ["ES2023"]` with no DOM (tsconfig.base.json:5). Vendor source therefore
  cannot join the flat check. The repo already answers this with generated declarations:
  `pnpm --dir apps/desktop check` runs `build:pathux-types` first, and
  renderer/tsconfig.json maps `pathux` to `dist/pathux-
- path.ux reaches the bare `nstructjs` specifier through
  path-controller/util/nstructjs.ts:3 (`export * from "nstructjs"`). The desktop jest
  project maps it to vendor/nstructjs/build/\_nstructjs.js at jest.config.cjs:96, because
  the published package's ESM `main` cannot load in the CJS runner. The shared mapper does
  not map it. The pathux-types build maps its types to
  vendor/nstructjs/build/structjs.d.ts at apps/desktop/pathux-types.tsconfig.json:23.
  scripts/aliases.mjs knows nothing of it, so an esbuild bundle would resolve it to
  path.ux's own installed copy. Two copies of nstructjs in one process give two STRUCT
  registries. The graph module registers its STRUCTs in one registry while `readJSON` and
  `validateJSON` consult the other, so every graph load fails. None of the three gates
  catches the duplicate copy.
- path.ux's graph module already exports what the DSL stages consume: `validateGraphDSL`
  and `buildGraphFromDSL` (vendor/path.ux/scripts/graph/dsl.ts:43 and :53),
  `registerNodeType`, `graphDef()`, groups, and the graph and socket STRUCTs. No
  island/auto-arrange helper exists yet. Auto-arrange is a stage-V3 deliverable there, so
  Stage 5 ships its own placement fallback.
- A project's `.gitattributes` grows by merge-append. `GITATTRIBUTES_BLOCKS` holds the
  lines, and the writer adds only the ones that are missing
  (apps/desktop/src/main/workspace.ts:275 and :304). The `work/graphs/*.json -merge` line
  is added this way.
- packages/artgen/package.json is the template for a source-only package. It sets
  `private` and `type: module`, names `./src/index.ts` under `exports`, uses `workspace:*`
  deps, and has no build script.

## The nine decisions, restated as constraints

Each stage cites these by number. The full argument for each is in the research doc.

1.  1. **A bound graph runs the slot's task.** The graph changes how a task runs, not the
       task's identity. Editing a graph does not move task hashes. The difference appears
       as drift, and the next run resets the drifted slot's task to `pending` instead of
       giving it a new identity. One journal serves scheduled and interactive runs.
2.  2. **Main models the graph with path.ux.** Main holds real `Graph` objects. Files are
       nstructjs JSON, and nstructjs's `validateJSON` checks them on load. `@vn/gengraph`
       runs the semantic pass: props against spec, socket compatibility, and slot-key
       parse.
3.  3. **Plugins install by explicit confirmation and run trusted**, against a
       capability-only `services` API. Sandboxing comes later as a harness change and is
       not required for v1.
4.  4. **Groups ship in v1**, from path.ux stage 5, loaded through the app's
       `groupLoader`/`groupSaver` from `work/graphs/lib/<name>.json`.
       [`archive/group-nodes-in-the-gen-graph-editor.md`](archive/group-nodes-in-the-gen-graph-editor.md)
       carried this out and replaced the saver with the `group` prop on the `gengraph.*`
       commands. Only a command writes a definition, and the renderer's loader reads it
       over `gengraph:group`.
5.  5. **A graph may carry several Output nodes**, each with a slot-key prop. Same-target
       outputs resolve Blender-style against an app-tracked active flag, which is document
       state that a command writes. Editor-side selection mechanics are deferred to the
       pane.
6.  6. **The refine loop wraps the graph run.** The critic and `max_refine_attempts`
       remain host policy in the runner. Critique enters through a wired Refine input node
       that reaches the active Output. If no such node is wired, the refiner modifies the
       derived prompt. Only the tail downstream of the entry point re-runs.
7.  7. **Intermediates are saved in the repo but are never assets.** The journal
       references them as content-addressed blobs under `vngen/state/graphs/<slug>/`. They
       carry no `AssetKind`, and only the terminal image enters the asset store.
8.  8. **Prices come from the release and the plugins.** The release ships a price table
       that is refreshed at release time (`pricesAsOf`). A second table sits at
       `userConfigDir` and is per-user rather than per-project; model plugins populate it
       only when the author asks, optionally through a declared price-agent capability
       that runs on the author's own key through the provider ring.
9.  9. **Names.** The names are `@vn/gengraph`, the `gengraph.*` commands, and a pane
       titled Gen Graph.

## Where `@vn/gengraph` sits

`gengraph` is a constrained leaf beside `@vn/artgen`, and its allow-list is one rung
wider. It may import `types`, `util`, `config`, `model`, `store`, `taskgraph` and `artgen`
(for `parseSlot` and the slot vocabulary), and deliberately not `providers`, `pipeline` or
`scheduler`, because every model call goes through the injected `services` interface the
package itself declares. Three consumers add `gengraph` to their allow-lists: `pipeline`
(the graph runner), `authoring` (the three agent tools' rules), and `desktop`. `authoring`
may import `gengraph` for the same reason it may import `artgen`: the leaf contains only
rules, and the agent receives execution as an injected capability. Stage 1 adds the
`ALLOWED` entry, the boundaries element pattern, and the three consumer-list additions to
eslint.config.mjs.

The executor (the code that walks a sorted graph and runs node runtimes) lives inside
`@vn/gengraph`. Only the thin runner wrapper (Stage 6) lives beside the pipeline spine,
and it hands the executor providers-backed services. This arrangement keeps the executor
reachable from the CLI scheduler and the desktop while `@vn/authoring` never gains a path
to it.

## Stages

Every stage is one commit that passes `pnpm check`, `pnpm test` and `pnpm lint` on its
own, with tests in `tests/` siblings. Stages 1–9 do not depend on path.ux stage V2; Stage
10 depends on it and says so.

### Stage 1 — the package, the node model, and the wiring

Create `packages/gengraph` from the artgen template (decision 9). Wire the toolchain in
the same commit, because nothing in the package resolves without it:

- `pnpm-workspace.yaml` needs no edit, because it globs `packages/*`. Add `'gengraph'` to
  `PACKAGES` in jest.config.cjs and to `PACKAGES` in scripts/aliases.mjs.
- Two new alias names, `pathux-graph` and `pathux-toolprop`, through which `@vn/gengraph`
  alone imports the graph module and the `ToolProperty` classes. The plan called for one.
  `scripts/graph/index.ts` re-exports the node, socket and graph classes but not the
  property classes a node spec declares its props with, and reaching them through the
  `pathux` alias would put a second copy of path.ux in the bundle, so the second name is
  wired the same way and in the same five places as the first. They resolve to source
  where code runs and to declarations where code is only checked. The source aliases live
  in scripts/aliases.mjs (picked up by esbuild.desktop.mjs, esbuild.cli.mjs,
  esbuild.authoring.mjs and gen-command-catalog.mjs), jest's shared `moduleNameMapper`,
  and apps/desktop/vite.config.ts beside the existing `pathux` alias. The declarations
  come from the root tsconfig.json's `paths` (the one map the flat check reads), which
  points at graph declarations emitted by the existing `build:pathux-types` pass (its
  `rootDir` already spans `scripts/`), and the root `check` script runs that build before
  the flat `tsgo` pass. The addendum's runtime headlessness never promised typecheck
  cleanliness, and the graph module's import chain reaches DOM types the flat program's
  `lib` lacks; the repo already solves this for the renderer with declarations.
- The split adds one type-identity rule: every checker surface that sees both `pathux` and
  `pathux-graph` must resolve the graph module through the same declaration output.
  path.ux classes carry private members, so a source-typed `Graph` and a declaration-typed
  `Graph` are nominally incompatible duplicates.
- Every new surface pins `nstructjs` to the vendor/nstructjs submodule, or the graph
  module and `@vn/gengraph` end up in different STRUCT registries. Three places need the
  pin: an entry beside the `@vn/*` map in scripts/aliases.mjs, the desktop jest project's
  mapping promoted to the shared `moduleNameMapper`, and
  `vendor/nstructjs/build/structjs.d.ts` in the root tsconfig `paths`. The pathux-types
  config's own mapping is the template.
- docs/guides/toolchain.md records the new aliases and the declaration-build ordering in
  this stage. That file documents every toolchain deviation.

The package's first content is all "pure" (side-effect-free) and browser-safe:

- **Node type registry.** A node type has up to three parts (research §"What a node type
  is"). The first is the shared class+spec, a path.ux `Node` subclass with `graphDef()`,
  sockets and `ToolProperty` props, plus app metadata (`typeVersion`, a `spends` flag, and
  the cost entries Stage 4 reads). The second is a runtime `run(inputs, props, services)`
  registered by type name. The third is an optional `createUI` that the renderer alone
  registers. Stage 1 ships the registry and the spec half; runtimes arrive in Stage 5.
- **Load/save.** `readGraphFile` and `writeGraphFile` wrap the nstructjs `writeJSON` and
  `readJSON` calls, and run `validateJSON` at the boundary (decision 2). Both return
  diagnostics rather than throwing.
- **Semantic validation.** This pass runs after `readJSON`. It checks that props match the
  registered spec, that links join compatible sockets, and that every Output node's slot
  prop parses under `parseSlot` and is not an `asset` binding. `parseSlot` accepts
  `asset:<hash>` and bare hex, and a generator output cannot bind an immutable content
  address, so an `asset` binding is refused by name. Unknown node types are reported by
  name (a plugin not installed here). Unbound graphs are legal. A graph with no Output
  node (or with an Output whose slot is empty) is decision 5's scratch-graph analogue of a
  concept image.
- **`GenServices`.** Node runtimes and plugins call this capability interface. It provides
  image generate/edit, chat, blob read/write, asset-store read (Stage 5's Slot-ref and
  Image-file nodes read existing art), a fetch routed through the provider request ring
  (Stage 12's price agent declares it in its manifest), and key lookup by declared name.
  The derived prompt is deliberately absent. The host computes it and seeds it as a node
  input on both the scheduled and the interactive path (Stages 6 and 7), which keeps the
  project model out of the services surface. It is declared here and implemented by hosts
  in Stage 6 (decision 3 depends on this being the only surface).

Tests cover the registry round-trip, a graph file round-trip through JSON, each
semantic-diagnostic case, and a headless import that spawns an actual `node` child
process. Inside jest, the test loads the module through the esbuild transform and the
module mapper, so an in-runner import would prove less than path.ux's own addendum test
does.

Three things had to change in path.ux before this stage could pass. Each is recorded here
because the plan assumed the library as it stood.

- `ToolProperty.STRUCT` declared `subtype : int;` while `ToolProperty.subtype` is optional
  and defaults to `undefined`, so `writeJSON` emitted no value and `validateJSON` rejected
  every graph carrying a property. The STRUCT now writes `0` when the field is unset,
  which is what allows the boundary check in decision 2 to run.
- Importing path.ux started a 250 ms interval that sweeps expired `TimeoutPromise`s, and
  node holds its event loop open for a pending interval, so a headless host never exited.
  The timer is now `unref`'d, which has no effect in a browser because a timer id there is
  a number.
- eslint's TypeScript resolver follows `pathux-graph` to the declaration tree under
  `apps/desktop/dist/`, so the `boundaries/element-types` rule read every use of the
  vendored library as `@vn/gengraph` importing the desktop app. eslint.config.mjs
  classifies that tree as its own `pathux` element, listed before `desktop` so that the
  `pathux` element matches first.

### Stage 2 — node identity, the journal, and drift

Contains pure logic and performs no I/O beyond an injected blob store.

- **`nodeHash`** =
  `hashParts(typeName + typeVersion, canonicalProps, orderedInputHashes)`. Image inputs
  are hashed by content, scalars by canonical JSON, so dirtiness propagates by
  construction (research §"Node identity"). Zero and empty-string prop values hash like
  every other value, and presence tests stay `=== undefined` per the artNotes precedent.
- **Paths.** One module defines both roots: graph documents at `work/graphs/<slug>.json`
  (with `work/graphs/lib/` for groups) and journals plus blobs under
  `vngen/state/graphs/`. Stage 6's index and its tests read these constants; Stage 7
  builds the commands on them.
- **Journal.** `vngen/state/graphs/<slug>.jsonl` holds append-only full snapshots of the
  form `{v, nodeId, nodeHash, authoredHash, status, output?, usage?, error?, at}`. Every
  line carries `v`, following the notifications.jsonl precedent for a committed file that
  will outlive its schema. Replay is last-writer-wins, as it is for `state/tasks.jsonl`.
  The journal sits outside undo deliberately, like the rest of `state/`, and the exclusion
  already in undo.ts covers it. One journal per graph serves the scheduler and the
  interactive pane alike.
- **Blob store.** Holds content-addressed bytes under `vngen/state/graphs/<slug>/`. Each
  blob is written by hash, referenced from journal records, and committed to the project
  repo. No blob enters either asset root (decision 7).
- **Drift.** `graphDrift(graph, journal)` recomputes the active Output node's hash and
  compares it with the journal's last `done` record for that node. The plan reported this
  drift and never acted on it, the same posture as `Shot.proseHash`. Drift now invalidates
  the slot, and the two paragraphs below record how.

Tests cover hash stability and propagation, journal replay including a crashed
half-written line, blob round-trip, drift on a prop edit and no drift on a layout move.

The package gained a second entry point here, which the plan did not call for. Paths,
hashing, the journal's file half and the blob store all reach `node:` modules, and in
Stage 10 the desktop renderer imports `@vn/gengraph`, so those four live at
`@vn/gengraph/state` and the main entry keeps none of them. `@vn/scriptedit` and
`@vn/scriptedit/write` already split the same way, and the split is wired in the same
three places: the package's `exports`, the root tsconfig's `paths`, and `SUBPATHS` in
scripts/aliases.mjs. The journal's record types and its replay reach no `node:` modules,
so they stay on the main entry beside the validator. `nodeHash` needs no `typeVersion` on
`GenNodeSpec` after all, because path.ux already carries one on `NodeDef` and writes it
onto every node.

Every record carries a second hash, which the plan did not call for. Stage 6's runner
seeds the task's prompt, its references and the critique onto input defaults before
hashing, so `nodeHash` moves with the task a run was made for. The seeding has two
effects. A task whose artNotes changed redraws rather than resuming the cached picture,
and a refine attempt's new critique re-runs the tail. Comparing `nodeHash` against the
graph on disk therefore reports drift after every run, whether or not anyone edited
anything. `authoredHashes` reads each host-seeded input as though nothing had been seeded
onto it, so `authoredHashes` covers the authored graph alone, and drift is measured
against `authoredHashes`. A node type names the input a host fills through `seededInput`
on its registration, and `seedInputs` refuses to seed an input that is not declared, so a
fourth seeded node type cannot quietly reinstate the false positive. A record written
before the field existed reports no drift.

Drift invalidates the slot instead of only being reported, reversing this stage's last
bullet. `requeueDrifted` (`@vn/scheduler`) moves every planned `done` or `needs_human`
task whose bound graph has drifted back to `pending`, once per run and before the wave
loop, and `RunSummary.redrawn` names those tasks for the CLI and the run notification.
Decision 1 still holds because the task's hash does not move: requeueing changes the
status of a task the plan already asked for rather than adding a new task. `requeueFailed`
and its attempt budget handle a `failed` task. A successful redraw clears the drift by
writing the graph's new authored hash into the journal, and a graph that fails writes no
such record, so requeueing a failure here would ask for the same paid work on every run
forever. The requeue happens at run time rather than at the graph write because undo
excludes `state/` and `build/`: undoing a graph edit restores the authored hash, the drift
disappears, and nothing is redrawn.

### Stage 3 — the DSL: read, replace, diff

Provides the agent's editing surface, built on path.ux's
`validateGraphDSL`/`buildGraphFromDSL` (dsl.ts:43, :53), and is shared later by
`gengraph.*` and the tools.

- `graphToDSL(graph)` — serializes the graph to the text form, which carries no layout.
- `applyGraphDSL(graph, text)` — validates, builds, then diffs against the live graph by
  node id. Validation returns diagnostics for self-repair and never throws. Surviving
  nodes keep their positions and their journal history, removed nodes go, and new nodes
  are placed by a deterministic placement helper (a grid right of the existing bounds).
  The helper is a stopgap path that ux stage V3's auto-arrange replaces; it is pure and
  tested, so the swap is one call site.
- Whole-graph replacement is the only mutation the DSL path offers (research §"How the
  agent edits"). Partial patches are the job of the editor and the commands.

Tests check that the round-trip `applyGraphDSL(g, graphToDSL(g))` produces a no-op diff,
that a renamed-id node becomes a delete plus an add, that positions survive edits, and
that each diagnostic reaches the caller.

`applyGraphDSL` takes a parsed value or the JSON text of one, because the commands hold
text and the tools hold a value. JSON that does not parse produces a `bad-json` diagnostic
and returns the live graph as-is. A prop is written into the description only where it
differs from a freshly built node of the same type, which keeps a description short
without changing what it builds. Links are read from each input socket's authored `edges`
rather than from `resolvedEdges()`, so a group's proxy sockets remain internal to the
group and do not appear as links an agent has to reproduce.

### Stage 4 — the cost model and the shipped price table

- Each spec may declare `estimate(props, inputContext) → [{service, model, unit, count}]`
  with `unit` one of `image`, `mtok-in`, `mtok-out`. A whole-graph estimate sums the
  per-spec estimates over a topological walk. That sum works here because every edge is
  known up front, and it does not work for `vngen cost` (research §"Cost"). The refine
  wrap adds a bounded multiplier of `max_refine_attempts` over the tail downstream of the
  refine entry point (decision 6).
- The shipped price table is a JSON module in `@vn/gengraph` that holds `pricesAsOf` and
  per-model unit prices, and is refreshed at release (decision 8). A model absent from
  every table is reported as an explicitly `unpriced` line naming the model, and is never
  priced at zero.
- Actual usage is recorded in the journal's `usage` field (Stage 2's shape), so estimates
  can be audited against spend.

Tests cover a three-node graph's estimate, the refine multiplier applying only to the
tail, the unpriced line, and a `pricesAsOf` staleness helper (pure date math, with no
clock read inside the package).

As built, this deviates from the plan. The refine entry point is found from two new spec
markers rather than from node type names, because Stage 5 introduces the types the rule
names. `refineInput` names the socket a refine pass re-enters at, and `refineFallback`
marks the node the pass falls back to while that socket is unwired. Stage 5 sets both
markers on the Generate-image and Derived-prompt nodes. A node's estimate receives the set
of its wired input keys, which is enough for a critique node to report nothing while
nothing feeds it. It receives no upstream values, because those do not exist before a run.
The shipped table covers the models this repository configures by default rather than
every model a project can name. A figure nobody has checked is worse than an unpriced
line, and the release refresh and the user-level table of Stage 12 fill the rest in.

### Stage 5 — the built-in node set

The starter set from research §"The starter set" covers specs plus runtimes and runs
entirely against mock services (no live keys anywhere in tests): Derived prompt, Task
refs, Slot ref, Text/Template, LLM rewrite, Generate image, Edit image, Reference list,
Image file, Refine prompt (empty until a refine pass supplies it), Switch/Blend, Output
image. Model nodes are configurable to emit any output type the host supports (decision
6's tail re-run depends on this). Runtimes reach models only through `GenServices`. The
Derived-prompt node's runtime passes through a host-seeded input on both paths. The
scheduled runner seeds it from the task, and `gengraph.run` has the session compute it
from the bound slot via the existing `build*Chunks` derivation. That derivation needs the
project model, which `GenServices` deliberately does not carry.

Tests each node's runtime against a scripted mock service. Tests that the Derived-prompt
node reproduces byte-identically what the current runner composes for a fixture slot.
Decision 1 rests on that byte-identical reproduction.

The code as built deviates in several ways. Three socket types are declared alongside the
nodes, because path.ux ships float and vec3 and both describe geometry. A picture on a
socket records the store that holds its bytes rather than only its hash, so a node reading
an asset does not have to copy it into the blob store first, and an image output feeds a
reference-list input as a one-item list through the destination half of path.ux's
coercion. The three host-seeded nodes take their value on an input socket rather than in a
prop, which lets `graphHashes` read a seeded value through the socket's `defaultProp` with
no special case and keeps the seeded prompt out of the document's authored state. Task
refs are seeded on a text input as the JSON an `AssetRef[]` writes to, because a
reference-list socket has no `ToolProperty` to carry a default. The image nodes hold their
seed as a string where empty means unauthored, because a `FloatProperty` always carries a
value and zero is a valid seed; a seed that does not parse as a number is refused rather
than dropped. An LLM-rewrite node's estimate uses nominal token counts, since an estimate
runs before any input has a value. The output node declares no output socket, and its
runtime returns the terminal picture so that the journal's `done` record states what the
slot holds. Blend is left out of the Switch/Blend pair and stays unimplemented, because
nothing in the repository composites two pictures and a blend node could only refuse.

### Stage 6 — the executor and the graph runner

- **Executor** (in `@vn/gengraph`): takes the graph and a target node set, and evaluates
  only the targets' ancestors, in path.ux's Tarjan `sort()` order. A scheduled run targets
  the slot's active Output, an interactive run targets the output the author asked for,
  and `spends` nodes on a scratch branch or under another target's subtree are never
  evaluated. Nodes whose journal record already matches their hash are skipped, so a
  resumed run does not recompute them. The rest run through their runtimes, every
  transition is journaled, and intermediates are stored as blobs. A failing node writes a
  terminal record with `error` and stops its downstream nodes, the same way tasks record
  failures.
- **A deliberate re-render invalidates nodes rather than re-walking them.** With every
  node clean, a plain requeue of a bound slot would skip straight to the cached image.
  Today's `regenerate` re-rolls the model, so that skip would be a silent regression. This
  document decides that `PipelineControl.regenerate` on a bound slot, and `gengraph.run`
  with an explicit `force` flag, append an `invalidated` journal record for each `spends`
  ancestor of the target output, so those nodes and their downstream re-run while
  deterministic prep still resumes.
- **Runner wrapper** (in `@vn/pipeline`): when the task's slot is bound to a graph, the
  runner seeds the Derived-prompt and Task-refs inputs from the task, executes the graph
  against the slot's active Output, and writes the result. For `shot_image` tasks only,
  the runner wraps that execution in the existing refine loop. The critic is unchanged and
  `max_refine_attempts` is unchanged. Critique enters through a wired Refine node that
  reaches the active Output; if no such node is wired, the critique modifies the derived
  prompt instead. Only the tail re-runs on each attempt (decision 6). The critique loop
  exists only for shots today, because reviewers judge against a `ShotSpec`
  (runners.ts:103). A bound `portrait`, `model_sheet` or `location_ref` task runs its
  graph in a single pass, matching the loop-free shape those runners have now. The
  terminal image goes through the same `deps.store.write` call the current runners use,
  with the same metadata, so downstream code cannot distinguish the two paths (decision
  1). An unbound slot runs exactly today's code.
- **Services implementation**: The providers-backed `GenServices` is built beside
  `createRunners` and shared by the CLI scheduler and the desktop session. It supplies the
  asset-store read and the ring-routed fetch that Stage 1 declares. Plugin requests and
  built-in requests both pass through the provider ring.
- The host session owns the slot→graph index and builds it on load by scanning every
  graph's Output bindings (decision 5). The runner wrapper consults it.

The testkit tests run a bound fixture graph end to end through the real scheduler with
mock providers. Resume skips clean nodes, and a refine attempt re-runs only the tail. The
tests also check that the asset store's record is shape-identical between the graph and
legacy paths, and that `adoptSlot`'s refusals are untouched.

The system as built deviates. A node hash covers what feeds a node rather than what the
node produced, so a node that ran again may have produced a different result at the same
hash. The executor tracks the nodes it ran and forces everything below them, which makes
the resume rule correct rather than merely cheap. `runBoundGraph` advances the binding's
journal to the state the run left behind, so a refine attempt resumes the nodes the
attempt before it already ran. The journal's maps are read-only, so the binding is given a
replacement object instead of being mutated. A failure blocks only the branch below the
node that failed, and branches beside it still run, so one failed model call does not
throw away the graph's deterministic prep.

`GenServices` lives on each loaded graph rather than on the runtime, because the blob
store is kept per graph slug and a service object shared across graphs has no single slug
to use. The image service exposes the byte-level `ImageBackend` seam, so a graph and a
task runner draw the same picture from the same prompt and refs; `createImageBackend`
builds the real one and the testkit passes a mock. The text service ignores a node's
`model` prop and answers from the project's one text provider, because Stage 12 adds
building a backend per call along with the plugin port. `params` on a bound run come from
the graph's own image nodes rather than from the task, since an author adds the node in
order to choose them. A picture's asset record still names the task's refs, because the
manifest addresses assets and a graph reference may be a blob. `indexGraphs` binds no
graph to a slot that two active outputs claim, and reports the conflict, because otherwise
which graph drew the picture would depend on the order the host loaded the graphs in. The
run context takes a `usage` hook that the host implements, since the services report no
usage of their own.

`invalidateGenGraph` ships here as `executeGenGraph`'s `force` path and as an exported
function. `PipelineControl.regenerate` is wired to it in Stage 7, because a session holds
no graphs until `work/graphs/` exists, so there is nothing for a regenerate to invalidate
yet.

### Stage 7 — graph documents and the `gengraph.*` commands

Graphs are documents that people author, and commands are the only way to write to them.

- The graph file lives at `work/graphs/<slug>.json` as nstructjs JSON, inside undo scope
  like the rest of `work/`. Group library files live at `work/graphs/lib/<name>.json`
  behind the app's `groupLoader`/`groupSaver` (decision 4). The project `.gitattributes`
  writer (workspace.ts:275) gains `work/graphs/*.json -merge` and
  `work/graphs/lib/*.json -merge`, and refuses a conflicted graph by name the way layout
  templates are refused.
- New command file apps/desktop/src/main/commands/gengraph.ts: `gengraph.create`,
  `gengraph.delete`, `gengraph.addNode`, `gengraph.removeNode`, `gengraph.link`,
  `gengraph.unlink`, `gengraph.setProp`, `gengraph.setActiveOutput` (sets decision 5's
  active flag, which is document state, so it is undoable and diffable), `gengraph.apply`
  (a command that performs the Stage-3 whole-DSL replacement), `gengraph.estimate`,
  `gengraph.run`. Each mutating command states its refusal condition in `check`, and the
  confirmation for `gengraph.run` shows the Stage-4 estimate. Binding an output slot uses
  `gengraph.setProp` on the Output node, and is refused when the slot string does not
  parse.
- `gengraph.run` executes interactively through the same executor and journal the
  scheduler uses (decision 1). It targets the active Output by default, or a named Output
  when a prop supplies one. A run against a spending graph is the only confirm-gated
  command here. Its `force` flag performs Stage 6's invalidation before running, so
  re-running an unchanged bound slot issues a real request rather than silently doing
  nothing.
- `doc.*` refuses `work/graphs/**` as it refuses `scenes/**`. Without that refusal the
  path stays open: `isTextPath` counts `.json` as text (editors.ts:157) and Wiki claims
  text files as primary, so a graph would open as a textarea and a save would bypass
  `validateJSON` and every `gengraph.*` check. The document tree lists a graph as a graph
  node, never as editable text.

Tests cover command round-trips over a temp project (create → addNode → link → apply →
undo), each declared refusal, the `-merge` line landing exactly once, and provenance
records carrying no key material. `prop.secret` is not needed here, because no command
takes a secret.

The implementation deviates from the plan in three places. `gengraph.apply` takes its
description as a string prop and parses it, because `@vn/commands` has no JSON prop kind.
`gengraph.setProp` takes a string `value` for the same reason, read through
`readGenPropValue` against the type the node's own property declares.
`PropBuilders.string`'s digest overload was widened to accept `multiline`, because no
command before this one needed both and a whole DSL description needs the text box.

A twelfth command, `gengraph.list`, was added beyond the eleven listed above, because the
document tree and the palette both enumerate graphs and neither can call `listGraphs`
directly. The interactive `gengraph.run` writes journal records and blobs but never an
asset. A picture enters the store only through the bound or scheduled path, so `adoptSlot`
remains the one `done` record produced outside the scheduler.

The refusal message for `doc.*` names a different writer on each side. The message shown
in the desktop app names `gengraph.*`, and the message shown to the authoring agent names
the desktop app's Gen Graph editor, because the agent has no graph tool until Stage 8 and
a refusal must not name something the author cannot reach. Stage 8 changes the agent's
half to `edit_asset_graph`.

The desktop reports a conflicted graph and a doubly-claimed slot as notifications rather
than throwing; `@vn/testkit` throws instead. `nodeIdOf` lives in
apps/desktop/src/main/graphs.ts rather than in the command file, because
`session.runGraph` resolves a typed node id the same way the commands do and path.ux keys
nodes by number by default. `readGraph` calls `registerGenNodes()` itself rather than
leaving it to each caller, because deserialization refers to node types by name and a
missing call makes a valid file look corrupt.

The group library needed two changes the plan did not anticipate. `readGraph` binds
`groupLoader`/`groupSaver` to `work/graphs/lib/` and then calls `resolveGroups()`, folding
each failed reference into an `unresolved-group` diagnostic against the instance that
references it, so a graph still opens when its definition is missing. `validateGenGraph`
skips path.ux's own `GroupNode`, `GroupInputNode` and `GroupOutputNode`, because those
types have no registry entry and would otherwise be reported as a missing plugin.

### Stage 8 — the agent tools

`@vn/authoring` holds three tools. The tools share decisions with the commands through
`@vn/gengraph` imports rather than registry transport, following the command-system
precedent:

- `read_asset_graph(slug)` — returns the DSL form, without layout.
- `edit_asset_graph(slug, dsl)` — Runs Stage 3's validate-then-apply. Diagnostics come
  back to the model for self-repair, and the write itself goes through the same rules
  module `gengraph.apply` uses.
- `run_asset_graph(slug)` is injected as a capability beside `PipelineControl`
  (tools.ts:126). It quotes the same estimate and requires the same confirmation as the
  human path, and plan mode blocks it.

The desktop wiring supplies the session's implementations. `vnauthor` receives the same
tools with the same refusals. Tool descriptions state their scope truthfully (the
improving-the-authoring-agent rule).

Tests cover a tool-level round-trip against a fixture project, a refused run in plan mode,
a diagnostic fed back verbatim, and a boundaries check that `@vn/authoring` still imports
neither `pipeline` nor `scheduler`.

The implementation deviates from the plan. Reading and writing a graph document moved out
of the desktop app into packages/gengraph/src/document.ts, reachable as
`@vn/gengraph/state`. Only the run is an injected capability, so the two read tools have
to reach the files themselves, and `@vn/authoring` cannot import the desktop app. That
move also takes `nodeIdOf`, which Stage 7's note places in
apps/desktop/src/main/graphs.ts. That file keeps the git code and still refuses a
conflicted graph, because `gengraph`'s boundaries allow-list excludes `@vn/git`. The moved
names are re-exported from apps/desktop/src/main/graphs.ts under the identifiers its
existing callers already use, so `writeGraph` and `deleteGraph` still resolve.

Stage 7's `estimateLine` became `estimateSentence` in `prices.ts`, so the desktop
confirmation and the agent's quote use one sentence for the figure rather than two
spellings of it. `GenEditResult`'s refusal gained `details?: string[]`, filled from the
diagnostics `decideApply` already had, because a model repairing a description it wrote
needs every problem in that description, not just the first.

Each tool's arguments differ in one way from the line shown above. `read_asset_graph`'s
`slug` is optional, and omitting it lists the project's graphs, because nothing else among
the three tools names a graph. `edit_asset_graph` takes `nodes` and `links` as structured
zod arguments rather than the string `gengraph.apply` must take, because a tool schema has
no reason to inherit `@vn/commands`'s missing JSON prop kind. `run_asset_graph` leaves
`confirm` unset and calls `ctx.confirm` with a priced card, the way `approve_assets` does,
because loop.ts's generic prompt shows a tool name and its arguments and cannot carry an
estimate.

Two wiring changes came with them. `AGENT_WRITERS.graphs` now names `edit_asset_graph`,
which is the change Stage 7's note anticipated. `apps/desktop/renderer/tsconfig.json`
gained the `pathux-graph` and `pathux-toolprop` aliases the root config already carried,
because the renderer's typecheck now reaches `@vn/gengraph` through `@vn/authoring`.

### Stage 9 — CLI surfacing

`vngen` needs no new subcommand to run graphs, because the runner seam covers `vngen run`.
Two places still need changes. `vngen cost` estimates every bound slot the slot graph
enumerates (`buildSlotGraph`), planned or not, and replaces the call-count line for those
slots; pricing only planned pending tasks would re-import the incremental-planning
undercount that the graph estimate exists to fix. `vngen status` names a drifted graph the
way it names failed tasks. Both readers reach `@vn/gengraph` through `@vn/pipeline`, which
re-exports Stage 2's and Stage 4's pure functions. The CLI adds no direct import, so the
allow-list consumers stay at three.

Tests the cost and status output over a testkit project with one bound slot.

**Deviation, Stage 9.** Four things differ from the preceding paragraph, and the CLI's
allow-list forces three of them rather than them being deliberate choices.

`apps/cli` may import neither `@vn/gengraph` nor `@vn/artgen`, so it too reaches
`buildSlotGraph` through `@vn/pipeline`. packages/pipeline/src/graphload.ts holds the code
both hosts use to work with a project's graphs: `readProjectGraphs` (which takes the
reader as a parameter, because the desktop session reads a graph through git and the CLI
reads the file), `graphRuntime`, `reportGraphs`, `unrenderedBoundSlots` and `priceSlots`.
The CLI names no artgen or gengraph symbol.

`vngen run` had never set `RunDeps.graphs`, so the CLI ignored generation graphs entirely
and Stage 6's runner seam covered only the desktop app. Binding slots in `cost` for
pricing while `run` drew them the old way would have quoted a number no run could produce,
so the run wiring is done here. `apps/cli/src/project.ts` gained `buildGenDeps`, which
returns the image backend beside the providers, and `buildProviders` now returns only the
provider part of that result.

`costPreview` takes a `drawnByGraph` predicate and reports `CostPreview.boundTasks`. A
task a graph draws is still counted as pending, but contributes no image or review calls,
because the graph prices it node by node in its own estimate and counting both would
charge for it twice. The scheduler supplies the predicate from the same `boundGraph` index
the runner consults.

The rule that an output node binds a slot when it names one and is active had three
implementations (`indexGraphs`, the desktop session, and this stage's report). That rule
now has a single implementation, `activeOutputs` in `packages/gengraph/src/slots.ts`,
which all three call.

`vngen status` reports that the next run redraws a drifted node. `vngen run` counts the
tasks it reset to `pending` alongside the ones it retried. The cost preview counts those
tasks under its pending line, so `vngen cost` includes the redraw before it is paid for.

### Stage 10 — the Gen Graph editor pane

Stage 10 requires path.ux stage V2 (`NodeGraphView` and the `NodeGraphDelegate` seam,
vendor/path.ux/documentation/plans/node-editor-view.md). This stage starts when V2 lands
and not before; nothing in Stages 1–9 waits on it. path.ux marks editor stages V1 through
V4 complete in vendor/path.ux/documentation/plans/node-editor-tasklist.md, so the
prerequisite is met and Stage 10 is unblocked. Stage 10 keeps its position in the order
for the reasons given below rather than because it is waiting.

- The enabling work comes first, because the current claim machinery cannot express this
  editor. `ClaimNode` (editors.ts:133) is `{kind, path?}` and carries no binding
  information, so it takes an optional `boundGraph` slug, stamped by main where the
  document tree is built. The `PinField` union (editors.ts:180) is closed, so
  `'graphSlug'` is added to it with a `PIN_NOUN` entry and the selection plumbing behind
  it. And `@vn/gengraph`, `pathux-graph` and their deps are added to
  renderer/tsconfig.json's `paths` so the renderer pass still typechecks. `@vn/gengraph`'s
  main entry is not yet loadable in the renderer: validate.ts takes the slot vocabulary
  from `@vn/artgen`, whose barrel reaches `node:fs/promises` through upload.ts, and the
  renderer imports `@vn/artgen` type-only today for that reason (ipc.ts:230). Neither
  `tsgo` pass catches this, so it surfaces at `vite build`. This stage moves `parseSlot`
  and the vocabulary beside it to a pure entry both packages import, rather than routing
  gengraph's import around the barrel.
- Editor #17 is an `EDITORS` entry `{id: 'gengraph', title: 'Gen Graph', what: …}` in
  apps/desktop/src/shared/editors.ts, and it is offered (unlike Setup and Debug Agent).
  Claim resolution is decided by tier, not by `EDITORS` order. Task Graph's slot claim
  (editors.ts:56) is unconditionally `primary` today, and `CLAIMS` is built in `EDITORS`
  order, so an appended #17 would always lose the tie. Instead, Gen Graph answers
  `primary` for a slot whose `ClaimNode.boundGraph` is set, and Task Graph answers
  `secondary` for those slots while keeping its unconditional `primary` on unbound slots.
  `pins: 'graphSlug'` pins a pane to one graph.
- renderer/pathux/editors/nodes.ts subclasses `VnEditor`, hosts `NodeGraphView` through
  `appendSurface` with its own adopted sheet, and installs a delegate that routes every
  mutating gesture into a `gengraph.*` command and applies the mid-gesture-verdict rule
  through `stack.check`. This file also holds the `createUI` registrations for the
  built-in nodes, which are renderer-only.
- Active-output display and click-to-activate go through `gengraph.setActiveOutput`
  (decision 5 rules out active-output support on the path.ux side).
- Every control has a tooltip, as CLAUDE.md requires. A command-backed control takes its
  tooltip text from the registry.
- docs/plans/desktop-editors-tracking.md records "Prompt node editor — Not being built"
  (~line 155). This pane overrides that entry, and the tracking doc is updated when the
  pane ships.

Tests cover the pure routing/claims logic in a `tests/` sibling. The surface itself is
verified live over CDP, as with every editor.

**Deviation, Stage 10.** The "pure" entry that the first bullet leaves unnamed is
`@vn/artgen/slotaddr`, a second export of `@vn/artgen` holding `slotKey`, `slotLabel` and
`parseSlot`. The alternative was a separate package, and it would not have been worth one:
the rest of `@vn/artgen` is written in terms of the three functions, and moving them out
would have inverted that package's dependency on its own addresses. The barrel re-exports
the new module, so every existing `@vn/artgen` consumer is unchanged, and `@vn/gengraph`
names the subpath rather than the barrel.

The stage is split into two green commits rather than one, because the enabling work
stands on its own. The slot move, `ClaimNode.boundGraph`, the `'graphSlug'` pin and the
renderer tsconfig paths form a commit a reader would want to land on without the pane's
surface code in front of them.

**Deviation, Stage 10b.** Before it can draw anything, the pane needs four things that the
preceding bullets do not name.

The renderer gains an IPC channel, `gengraph:doc`, that reads a graph document. Before
this stage no channel named a graph. The closest are `workspace:doctree` and
`story:graph`, and neither reaches `vngen/work/graphs/`. The channel sends the file's
nstructjs JSON rather than the DSL, because `graphToDSL` carries topology and authored
values and no layout at all, and the pane needs each node's `pos` and `size` to draw it
where the author left it. Both `nstructjs` and `pathux-graph` are already aliased for the
renderer, so the renderer reads the JSON back into a `Graph` through `readGraphFile`.

`GenEdit` gains a `moveNodes` op and `gengraph.*` gains a `gengraph.moveNodes` command,
because path.ux's delegate emits `moveNode`, `moveNodes` and `arrange` and the seven ops
`GenEdit` shipped with include no move. Without them a drag has no op to commit into and
the pane cannot lay a graph out at all. The move list is encoded as text on the command,
following `gengraph.apply`, because `@vn/commands` has no JSON or list prop kind.

The delegate's `check` calls `decideGenEdit` in the renderer rather than `stack.check`
over IPC. `NodeGraphDelegate.check` is synchronous and runs per frame during a drag
(`_previewMove` dims a frame whose move would be refused, and `linkdrag._targetOk` calls
it once per candidate socket), while `command:check` is an async round trip. Both sides
run the same decision function, so the mid-gesture verdict still matches the verdict on
commit, as the rule requires. `perform` then dispatches the matching `gengraph.*` command
through `command:exec`, so every write still goes through the registry.

`Selection` gains a `graphSlug` field, which supplies the selection plumbing the first
bullet leaves unnamed. `selectionForNode` had no `slot` case, so clicking a slot row
returned the selection unchanged and `pick` returned early without routing the click.
Clicking a bound slot now selects the graph that draws it, which both publishes
`ui.graphSlug` and routes the click to whichever editor claims the row.

Fifth, node properties are not edited through path.ux's datapath binding. The pane leaves
`graphPath` empty, so `NodeGraphView.watchPath` installs no datapath watch, but
`syncGraph` still stamps every non-group frame with
`` `${currentGraphPath}.nodes[<id>]` ``, which is `.nodes["1"]` rather than the empty
string the two guards in `NodeFrame` test for. path.ux therefore builds prop rows and
inline socket editors against a path that cannot resolve. The pane subclasses
`NodeGraphView` and clears each frame's `nodePath` after `syncGraph` runs, which is safe
because `propEditRow` catches its own resolution failure and the resync is synchronous, so
no unresolvable row reaches a paint. Each built-in node's `createUI` is then registered
renderer-side, drawing controls that dispatch `gengraph.setProp` through `command:exec`.
The rejected alternative is registering the graph as a `DataStruct` in `defineShellApi`.
`Node`'s own `props` list writes with `target.setValue(val)` directly, so every prop edit
would bypass the command registry, which is the one write path this application has.

The sixth move takes `executeGenGraph` and `invalidateGenGraph` from the package's main
entry to `@vn/gengraph/state`. Stage 2 put the four filesystem modules there and left the
executor on the main entry, which looked "pure" (it opens no file itself) but hashes every
node through `@vn/util`, which reaches `node:crypto`. No check caught the dependency until
this stage, because the pane is the renderer's first value import of `@vn/gengraph` and
only `vite build` resolves a `node:` module for the browser. The two callers are
`@vn/pipeline`'s graph runner and the desktop session, both of which already import the
state entry.

### Stage 11 — plugins: manifest, toolchain, confirmed install

- A plugin is a directory with `plugin.json` (name, version, node types, services called,
  key names, price-table fragment) and `.ts` sources split the same three ways as
  built-ins (research §"Plugins"). The public surface is `@vn/gengraph/plugin`, a
  versioned subpath export (`scriptedit/write` sets the precedent in aliases.mjs
  `SUBPATHS`).
- A shipped esbuild-based transpile step bundles a plugin against that API at install
  time. The research doc leaves one packaging question open: whether the packaged app
  carries the native esbuild binary or esbuild-wasm. This stage measures both in
  `pnpm package`, decides which one to carry, and records the answer here.

    **The answer is native `esbuild`.** Size does not decide it: the two hoisted installs
    come to 11 MB native against 12 MB wasm, and both work with pnpm's build scripts
    blocked. Speed does not decide it either, at the scale a plugin install runs at — one
    transform takes 74 ms native against 288 ms wasm. What decides it is that
    `esbuild-wasm` does not avoid spawning a process. Its Node API builds the same
    service-and-child-process machinery the native package does, and
    `esbuildCommandAndArgs()` in esbuild-wasm/lib/main.js spawns literally
    `node bin/esbuild` — a `node` on PATH that a packaged app cannot assume. Its browser
    build avoids that, but it needs a global `self`, which the Electron main process must
    not be given because both model SDKs branch on it, and its Go shim stubs `fs` with
    ENOSYS, so it cannot read a plugin's entry file to bundle it at all. Native esbuild
    ships and pins its own binary and needs nothing on the machine. The cost is one
    `asarUnpack` entry in apps/desktop/electron-builder.yml, which previously recorded
    that nothing was unpacked. That note was a finding rather than a trust boundary, and
    `extraResources` already ships an unpacked `source/`, so the file now records the
    binary and why. Unpacking it is not enough on its own: esbuild derives the binary's
    path from its own file, its own file is inside the asar, and Electron redirects a read
    into the unpacked tree but not a spawn, so the spawn fails with ENOENT. The app sets
    `ESBUILD_BINARY_PATH` — esbuild's own override — to the unpacked path before the
    import, and only when packaged. `pnpm smoke` runs a transform in the built binary
    rather than resolving the module, because a module that resolves while its binary
    cannot be spawned passes a resolution check and fails the first install.
    `apps/desktop/src/main/plugins.ts` still defers the import until a plugin needs
    building, so a machine with no plugin installed never starts the child process.

- Installing a plugin requires an explicit confirmation that names the manifest's declared
  services and key names (decision 3). Installed plugins run trusted. Keys resolve through
  the existing four-place `resolveKeys` chain and are set by `project.setKey`; nothing new
  touches key storage. Plugin model calls pass through the provider ring like every other
  request.
- Plugins install per-user, under `userConfigDir`'s `plugins/<name>/`, deliberately not
  per-project, because the person at the machine confirms each install, and a cloned repo
  must not carry that confirmation with it. The transpiled bundle is cached beside the
  sources. The cost is that opening the project on another machine produces Stage 1's
  unknown-node diagnostic naming the plugin rather than a silent substitute.
- The agent's raw file writers refuse those paths outright (following the `create_skill` /
  `edit_skill` precedent) because a person put the plugin that the confirm dialog names at
  that path.

Tests cover manifest schema cases, a fixture plugin transpiled and loaded with its node
type registered and runnable against mock services, the writer refusal, and a packaged-app
smoke assertion in `pnpm smoke` that the transpile toolchain resolves.

**Deviation, Stage 11.** Six things differ from the bullets listed above.

The agent's writer refusal checks an absolute path and runs before the workspace check
rather than after it. `write_file` and `edit_file` resolve their path through
`resolveInWorkspace`, which already refuses anything outside the open workspace, and the
plugins root is outside every workspace. If the refusal ran after that check, it could
never fire, and the agent would be told the path is out of bounds rather than that a
plugin is installed by a person. `pluginWriteRefusal` therefore takes the absolute path
both tools were handed, before either resolves it.

A plugin receives the plugin API as the argument to `activate`, not as a specifier its
bundle resolves at run time. A per-user directory cannot resolve `@vn/gengraph/plugin`,
and bundling the package in instead would give the plugin a second copy of the registry
maps, so every node type it registered would go into a map the host never reads. A plugin
imports the subpath type-only, esbuild marks it `external`, and `buildGenPlugin` refuses a
bundle whose text still names the specifier.

esbuild is injected rather than depended on. `@vn/gengraph` declares the `GenEsbuild`
shape it needs and takes a `GenPluginBundler` from its caller, so the package carries no
build tool and the desktop app decides which esbuild build ships with the app.

The bundle format is CommonJS and it is loaded with `createRequire`. Both hosts that load
a plugin are CommonJS. The desktop app's main bundle is `dist/main/index.cjs`, and jest's
runtime cannot import an ES module at all.

`plugin.install` does not use the command framework's `confirm: true` flag. That flag
produces one static question naming the command's title, and the author needs to read
which services and key names this particular manifest declared. The command therefore
calls `ctx.confirm` itself with `installDescription`'s sentence, and refuses outright when
no gate is wired into the context.

The fixture plugin lives at `packages/testkit/src/plugin/` rather than under
`packages/gengraph/src/tests/`. `boundaryRules.gengraph` carries no self-entry and the
rule defaults to `disallow`, so a file inside `packages/gengraph` importing
`@vn/gengraph/plugin` is a lint error. `testkit` already lists `gengraph`, and nothing may
import `testkit`, so the loader's tests can reach the fixture and the shipping graph
cannot. Keeping it in a package also means its sources are typechecked, linted and
formatted like the rest of the repository instead of being written into a temporary
directory by a test. The fixture's node class is named for the type it declares, because
`registerNodeType` refuses a class whose name and `graphDef().typeName` differ.

### Stage 12 — prices from plugins, and porting the built-in providers

- The price table lives at `userConfigDir` and is per-user (decision 8: per-user,
  deliberately not per-project). A model plugin populates it only on the author's explicit
  request. A plugin whose provider publishes no pricing API may declare the price-agent
  capability, which makes an LLM call with web fetch on the author's own key through the
  provider ring; the capability is declared in the manifest and shown at install.
- The first-party image provider becomes the first real plugin. The Gemini generate/edit
  node runtimes are ported onto the plugin API, so graph runs no longer depend on
  `createGeminiImage`'s hardcoded entry in factory.ts. The legacy non-graph path keeps
  using factory.ts unchanged; retiring it is out of scope.
- The per-user entry wins when both tables price a model. The estimate names which table
  priced each line.

Tests table merge precedence, the request-gated population flow with a scripted agent, and
the ported Gemini plugin running a fixture graph against mock services.

Stage 12 deviates from the preceding bullets in five ways.

Stage 5 already shipped precedence between tables, so the third bullet's work is
attribution rather than ordering. `priceEstimate` already read an ordered list of tables
and used the first table that priced a model. Stage 12 adds `table` on each priced line,
naming the table that supplied the price, and `genPriceTables`, which orders the tables as
the bullet describes: the author's table, then the shipped table, then each installed
plugin's table. Assembling that list needs the filesystem, so the host-side call that
reads the author's table and the installed manifests is `hostPriceTables` in
`@vn/pipeline`. `hostPriceTables` cannot live in `@vn/cli`, because the boundaries rule
forbids `@vn/cli` from importing `@vn/gengraph`.

No web-search interface is available to a price agent, so the Gemini agent fetches the
vendor's pricing page through `services.fetch` and hands the text to `services.text`.
Routing the request through `services.fetch` records it in the provider ring, which the
bullet requires, and the page shows the vendor's own published prices rather than a search
result. The agent refuses when the page cannot be read instead of reporting a figure the
model produced without a source, because an unpublished figure is worse than no figure.

A plugin's price agent names the model it requests for reading the page, but that name
does not select a backend. `createGenServices`'s text service answers every call with the
project's one configured text provider, so the named model records which model the plugin
was written against. Giving a plugin a text backend of its own is not part of this stage.

The Gemini plugin's sources live in a repo-root `plugins/gemini/` directory rather than in
a package. Installing a plugin copies its directory under `userConfigDir()/plugins/`, so
that directory has to be self-contained. It also imports `@vn/gengraph/plugin`, and the
boundaries rule forbids that import to anything under `packages/` or `apps/`. The
directory is in the root tsconfig's `include`, so its sources are typechecked, linted and
formatted like the rest of the repository. The boundaries block matches neither
`plugins/**` path.

Porting the two node runtimes did not remove `createGeminiImage` from factory.ts. The
plugin's runtimes register under their own type names (`GeminiImage`, `GeminiEditImage`)
alongside the built-in ones rather than replacing them, so a graph reaches the vendor
directly only once the author installs the plugin and uses those node types. The built-in
image node still runs through the host's image backend, and a project with no plugins
installed depends on that backend.

## Verification

- Run `pnpm check`, `pnpm test`, and `pnpm lint` at every stage, and commit only when all
  three pass.
- Stage 5/6 carries a standing test for the core property of Decision 1. Binding a graph
  that reproduces the derived prompt changes no task hash, and editing that graph moves
  drift rather than hashes.
- The end-to-end pass after Stage 10 is to author a graph in the pane, bind it, run the
  pipeline, and watch the frame in PLAY. Script-composition used the same sequence.
- No test or fixture contains a real key. Mock art carries the testkit marker, which the
  real backend refuses.

## Docs touched

- In CLAUDE.md, the package graph diagram and packages.md gain `gengraph`. Once Stage 6
  ships, add a Core-ideas bullet describing graphs as runners.
- docs/reference/packages.md, docs/reference/pipeline-contracts.md,
  docs/reference/command-system.md (the `gengraph.*` namespace),
  docs/reference/desktop-app.md and desktopAppState.md (the pane, `work/graphs/`,
  `vngen/state/graphs/`) are each updated in the stage that makes them stale.
- docs/guides/toolchain.md: Documents Stage 1's alias wiring, covering the `pathux-graph`
  entry in aliases.mjs, the declaration build ordered before the flat `tsgo` pass, and the
  type-identity rule.
- docs/plans/desktop-editors-tracking.md: Stage 10 supersedes the "Prompt node editor —
  Not being built" entry. Update that entry when the pane ships.
- docs/plans/index.md: this plan's row is kept current at each stage.

## Deliberately cut

- A plugin sandbox (decision 3 defers it to a harness change).
- Editor-side active-output selection mechanics beyond click-to-activate (decision 5).
- Retires the legacy non-graph runner path and the provider slot in `factory.ts`.
- Automatic price refresh on a schedule (decision 8 allows author-requested refresh only).
- path.ux stages V2–V4 are themselves planned and tracked in
  vendor/path.ux/documentation/plans/node-editor-view.md.

# Node-based asset generation

Design study, 24 August 2026. A node-based asset generator: per-slot graphs drawn in
path.ux's upcoming node editor, executed by the app itself, with pluggable provider nodes
(Gemini image, OpenAI image, FLUX, text LLMs), persistent knowledge of which nodes need
re-execution across app restarts, a DSL the authoring agent edits graphs through without
touching visual layout, and a cost estimate computed before anything spends money.

Nine decisions were settled with the user on 2026-08-24 and are written into the design
below rather than listed as options:

1. **A bound graph is the slot's runner, and also runs interactively.** The slot's task
   keeps today's identity; the scheduler's runner executes the graph with the derived
   prompt and refs as inputs and records its image as the task's output. The editor can
   also run the same graph interactively, sharing one execution journal.
2. **The path.ux graph is the model.** The document is nstructjs JSON validated by
   nstructjs's own `validateJSON` at the boundary; main holds real `Graph` objects. The
   verification that makes this safe is recorded below.
3. **Plugins install by explicit confirmation** and run trusted, against a
   capability-only API shaped so a sandbox can be added later without rewriting plugins.
4. **Groups ship in v1**, consumed from path.ux stage 5.
5. **A graph may contain several Output nodes.** Each binds an output target, so one
   graph can feed several slots; among Output nodes with the same target, only the
   active one — the most recently selected, Blender-style — is used. The editor-side
   selection mechanics are deferred until the path.ux node editor lands.
6. **The refine loop wraps the graph run.** The runner keeps `shot_image`'s critique
   loop. The critique enters through the graph's Refine input node when one is wired
   into a path that reaches the slot's active Output node; when none is wired, the
   refiner modifies the derived prompt itself between attempts. Model nodes —
   configurable to emit any output type their model supports — can process the refine
   prompt into a more detailed one on the way.
7. **Intermediates are saved in the project repo but are not assets.** Only the
   terminal image enters the asset store; intermediate node outputs are
   journal-referenced blobs with no `AssetKind`.
8. **Prices come from the release and from the plugins.** The shipped table is
   refreshed as part of the release process, and a user-level table — per user,
   deliberately not per project — can be populated automatically, owned by the model
   plugins. Where a provider exposes no per-key pricing API, a plugin may request
   access to an LLM agent with web fetch to read published pricing.
9. **Names.** The rules package is `@vn/gengraph`, the command namespace is
   `gengraph.*`, and the editor pane is titled Gen Graph. An earlier `agraph.*`
   placeholder was rejected because it reads as "acyclic graph".

<!-- toc -->

- [What already exists](#what-already-exists)
  * [The path.ux node graph](#the-pathux-node-graph)
  * [The attachment point: slots](#the-attachment-point-slots)
  * [Identity, resume, and the runner seam](#identity-resume-and-the-runner-seam)
  * [Providers and money](#providers-and-money)
  * [The desktop shell](#the-desktop-shell)
  * [The standing objection](#the-standing-objection)
- [Architecture](#architecture)
  * [A graph is a project document whose Output nodes bind slots](#a-graph-is-a-project-document-whose-output-nodes-bind-slots)
  * [The path.ux graph is the model](#the-pathux-graph-is-the-model)
  * [A node type has three parts](#a-node-type-has-three-parts)
  * [Output nodes](#output-nodes)
  * [Execution](#execution)
  * [The refine loop](#the-refine-loop)
  * [Cost estimation](#cost-estimation)
  * [Slot coverage](#slot-coverage)
  * [Agent integration](#agent-integration)
  * [Groups](#groups)
  * [Plugins](#plugins)
  * [The editor pane](#the-editor-pane)
- [Asks of path.ux](#asks-of-pathux)
- [Phasing](#phasing)

<!-- tocstop -->

## What already exists

### The path.ux node graph

The design is `vendor/path.ux/documentation/research/nodeEditor.md`; the implementation
plans are `documentation/plans/node-editor.md` (the library, stages 1–7, all done — the
graph module lives at vendor/path.ux/scripts/graph/: socket.ts, node.ts, graph.ts,
group.ts, dsl.ts) and `node-editor-view.md` (the editor; V1, the pan/zoom container, is
done and V2–V4 are unstarted). The facts that shape this design:

- **The library owns structure, not evaluation.** Nodes have no `exec` method. The graph
  provides typed sockets with coercion, dirty tracking, a topological sort flattened
  through group boundaries, and serialization; the client walks the order and decides what
  running a node means. Whatever executor this app builds, that division was already
  decided for it.
- **Stage 6 ships an LLM DSL.** A flat `nodes: [{id, type, props}]` /
  `links: [[from, "out", to, "in"]]` format with `validateGraphDSL` returning diagnostics
  rather than throwing, so a model can repair its own output, and `buildGraphFromDSL`
  producing a real `Graph`. With the library graph as the model, both are consumed
  directly.
- **Stage 5 ships groups**: instanced subgraphs whose definitions live in other files
  (client-supplied `groupLoader`/`groupSaver`), with per-instance sparse property
  overrides tracked by `wasSet`. This maps directly onto "one pipeline, instanced per
  character, with per-character tweaks that survive updates to the shared definition".
- **The view plan builds `NodeGraphView`**, a hostable widget owning the canvas — node
  bodies as real path.ux containers, a canvas link underlay, auto-arrange via
  `graphPack`/`graphGetIslands` — with `NodeEditor extends Area` as a thin shell around
  it, registered by the consumer.
- Stage 7 ships ToolOps and a datapath API for the library's own undo and forwarded UI.
  The desktop app has its own command stack and undo, so it installs a `NodeGraphDelegate`
  that routes editor gestures into commands rather than into the library's ToolOps (see
  "Asks of path.ux").

### The attachment point: slots

A slot is a `RefBinding` (packages/types/src/prompt.ts:94) with a canonical string form
from `slotKey` (packages/artgen/src/refcycle.ts:23): `portrait:aiko`,
`sheet:aiko/gala/front`, `plate:cafe/night`, `shot:greet/s2`. `buildSlotGraph`
(packages/artgen/src/slotgraph.ts:304) already enumerates every picture the project
implies — whether or not anything has drawn one — with stable addresses that survive a
re-plan, a reverse dependency index, and per-slot status. That graph of slots, not the
task graph of hashes, is the right thing to attach a generator graph to: a slot address
is stable across regeneration, a task hash is not.

### Identity, resume, and the runner seam

Three pieces of existing machinery this design extends rather than replaces:

- **Task identity** is `hashParts(kind, inputs)` — canonical-JSON, key-order-insensitive
  (packages/taskgraph/src/hash.ts:10, packages/util/src/hash.ts:29) — with upstream
  *outputs'* content hashes embedded in `inputs.refs`. Embedding output hashes is what
  makes dirtiness propagate: change an upstream picture and every downstream identity
  moves. The graph-bound slot keeps exactly this identity; the graph changes how the task
  is *run*, never what it *is*.
- **Resume is emergent.** `state/tasks.jsonl` is an append-only log of full task
  snapshots, replayed last-writer-wins (packages/taskgraph/src/log.ts:18); a replayed
  `done` node is simply never ready again. "Re-run this" is one appended `pending`
  snapshot (apps/desktop/src/main/session.ts:2561).
- **A runner** is `(task, deps) => Promise<TaskResult>`
  (packages/pipeline/src/runners.ts:24), chosen by task kind, with providers reached only
  through `RunDeps` — the scheduler never imports a concrete backend. A graph runner
  slots into this seam the way `makeShotRunner` (runners.ts:103) does.

The provider layer already has a record/replay cache keyed by
`sha256(canonicalJson({op, prompt, ref byte-hashes, params}))`
(packages/providers/src/cache.ts:27) — a request-identity memo, which is the shape a
nondeterministic node's cache key takes below.

### Providers and money

`ImageProvider` is `generate(prompt, refs, params)` / `edit(base, prompt, refs, params)`
(packages/types/src/providers.ts:9). Images are currently hardcoded to Gemini
(packages/providers/src/factory.ts:51). Accounting is tokens only — `TokenUsage` reaches
the desktop as usage events, image calls report nothing, and **no price data exists
anywhere in the repo**: `vngen cost` (packages/pipeline/src/pipeline.ts:48) counts calls,
not dollars, and undercounts because planning is incremental. Every provider request
passes through the bounded in-memory ring that the API-fault diagnosis reads; plugin
nodes must not lose that.

### The desktop shell

Editor #17 is one `EDITORS` entry (apps/desktop/src/shared/editors.ts:22) plus a
`registerEditor(cls, 'vn.Nodes', fields)` call; the Asset editor is the binding precedent
(subject `ui.assetHash`, `pins: 'assetHash'`) and Task Graph is the canvas precedent.
Commands are the only write path; undo shadow-snapshots the document class and excludes
`vngen/build` and `vngen/state` (packages/commands/src/undo.ts:16), so a graph document
under `work/` is undoable and an execution journal under `vngen/state/` deliberately is
not. Project convention: json for documents read whole, jsonl for append-only logs;
per-file layout state is marked `-merge` in `.gitattributes` the way layout templates
are.

### The standing objection

`docs/plans/desktop-editors-tracking.md:155` records "Prompt node editor" under **Not
being built**: it "converts deterministic plumbing into user data, and every edit rehashes
downstream tasks — casual fiddling silently invalidates generated art." The
graph-as-runner decision answers both halves directly:

1. **The deterministic plumbing stays derived.** Planning, task identity, dedup and
   resume all keep reading the derived prompt, refs and params. The graph replaces only
   the generative step — the one step that was never deterministic — and only for slots
   that opt in. A slot with no graph is untouched.
2. **A graph edit moves no hashes.** The task's identity does not include the graph, so
   editing a graph invalidates nothing and discards nothing. The edit is reported as
   drift — the journal records the hash of the Output node that produced the slot's
   current art, and a mismatch against the current document shows as "graph changed
   since last render", the way a prose edit shows against `Shot.proseHash`. Re-rendering stays an
   explicit requeue, and interactive runs quote their cost first.

## Architecture

### A graph is a project document whose Output nodes bind slots

One graph, one JSON document, at `work/graphs/<slug>.json`. Binding lives on the graph's
Output nodes rather than in the filename or a document-level field: each Output node
carries a slot-key prop (`sheet:aiko/gala/front`), so one graph may feed several slots —
a sheet graph with three Output nodes drives all three angles from one shared trunk. The
pipeline finds a slot's graph through an index built by scanning the documents' output
bindings on load. A graph whose Output nodes bind nothing is legal — a scratch graph is
the node-based analogue of a concept image, and its results enter the pipeline the way a
concept's do (adoption/promotion), which keeps `adoptSlot`'s existing refusals intact.
The file is:

- nstructjs JSON (`writeJSON`), checked by `validateJSON` on load (see the next section);
- written only by commands (a new `gengraph.*` namespace);
- inside the undo scope (`work/` is in the document class);
- marked `-merge` in `.gitattributes`: like a layout, two authors' versions merged line
  by line make a graph neither of them built.

### The path.ux graph is the model

Decided. Main holds a real `Graph` per open graph document; commands mutate it;
`writeJSON` serializes it; the renderer's editor views the same graph. Two objections
were raised against this and both were checked and cleared:

- **Boundary validation.** nstructjs's `validateJSON(json, cls)`
  (vendor/nstructjs/documentation/jsonGuide.md) checks missing fields, wrong types,
  unknown keys, and a polymorphic discriminator naming a non-subclass, with positional
  error context. That is structural validation equivalent to a zod schema for this
  format. The checks a schema cannot express — props matching the node type's declared
  spec, link socket compatibility, a slot key that parses — are semantic and live in the
  rules package regardless of format, as a pass after `readJSON`.
- **Node-cleanliness.** The graph module's imports of `Container`, `IContextBase` and
  `DataAPI` are all `import type` and vanish at compile time. Its runtime chain —
  nstructjs, `ToolProperty`, vectormath, path-controller util — was checked for
  module-scope DOM access: `navigator` and `window` uses in util.ts sit inside functions
  (`isMobile`, the base64 helpers) or behind `debug_cacherings = false` (util.ts:678).
  Electron main and the node-only CLI can import the graph module today. This is
  currently an incidental property; the asks below make it a stated contract.

Two consequences of the decision: stage 6's `buildGraphFromDSL` and stage 5's group
machinery are consumed wholesale rather than reimplemented, and the main-process and CLI
bundles need the same `pathux` alias vite gives the renderer. nstructjs is a first-party
submodule at vendor/nstructjs, so format-level needs (there should be few) are
changeable, with the usual publish-and-bump for path.ux's own dependency when they land.

The one cost of this route that stays real: editor gestures must dispatch commands
rather than library ToolOps, so the command stack remains the only write path and
`stack.check` supplies the mid-gesture verdict. That is the gesture-delegate ask below.

### A node type has three parts

1. **Class + spec** (shared): the path.ux `Node` subclass — sockets, `ToolProperty`
   props, `NodeDef` — plus app metadata the library does not carry: `typeVersion`, a
   `spends` flag, and the cost model. The graph module is browser-safe and node-clean, so
   these classes live in shared code both processes import (the `src/shared/` node-free
   rule is satisfied).
2. **Runtime** (main and CLI): `run(inputs, props, services) → outputs`, registered by
   type name, where `services` is a capability object the executor hands in — provider
   access, key resolution, the asset store, a fetch that passes through the request ring.
   Runtimes never get ambient `fs`/`net`.
3. **UI** (renderer only, optional): a `createUI` body for nodes whose props deserve more
   than generated widgets. Most nodes need nothing here.

A first-party starter set: **Derived prompt** (the task's derived prompt — inside a
scheduler run this is the running task's own prompt; interactively it is computed from
the bound slot via the existing `build*Chunks` derivation), **Task refs** (the task's
ordered refs, same dual sourcing), **Slot ref** (a specific upstream slot's current asset
by `slotKey`), **Text** / **Template**, **LLM rewrite** (text model call), **Generate
image** (Gemini today), **Edit image** (base + refs), **Reference list** (ordered — order
is part of request identity), **Image file** (an adopted upload or concept by hash),
**Refine prompt** (the refiner's critique text — empty on the first pass; see the refine
loop), **Switch/Blend** utilities, and **Output image** (the special terminal; next
section).

### Output nodes

The Output node is the special terminal a run is read from, and a graph may contain any
number of them:

- **Different targets fan out.** Each Output node binds one slot key, so a sheet graph
  binds three Output nodes to its three angles and each angle's task evaluates from its
  own Output node. The tasks share the trunk upstream of the split, and the journal's
  node cache means a shared node runs once, for whichever task reaches it first.
- **Several Output nodes on one target are variants, resolved Blender-style.** Exactly
  one Output node per target is active, and selecting an Output node in the editor makes
  it the active one for its target. The active flag is document state written by a
  command — undoable, diffable, and reachable from the agent's DSL — rather than
  ephemeral selection. The editor-side mechanics (how a selection gesture reaches that
  command) wait for the path.ux node editor, and nothing here asks path.ux for
  active-output support; the app tracks the flag itself.
- **Drift is measured at the active Output node.** An Output node's `nodeHash` (next
  section) transitively embeds everything upstream of it, so a slot's drift check is one
  comparison: the active Output node's recomputed hash against the journal's last `done`
  record. An edit to a branch that does not feed a slot's active output does not drift
  that slot, and switching the active output is itself a drift-visible change.

### Execution

- **The graph runner.** When a slot carries a graph binding, the pipeline's runner for
  that task loads the document, feeds the task's prompt and refs into the Derived-prompt
  and Task-refs input nodes, evaluates the flattened `sort()` order up to the slot's
  active Output node executing what is dirty, and records that node's image as the
  task's output and attempt — the same `TaskResult` shape every runner returns. Sibling
  tasks bound into one graph each evaluate from their own Output node and meet in the
  shared journal, so the common trunk runs once. Task failure records and the single retry
  behave as they do for any task. The executor lives beside the pipeline spine so both
  the CLI scheduler and the desktop reach it; `@vn/authoring` never imports it — the
  agent's run tool goes through an injected capability, the `PipelineControl` pattern
  (packages/authoring/src/tools.ts:126).
- **Interactive runs** from the editor use the same executor with the same journal, so a
  node already computed by a scheduler wave is not recomputed in the editor and vice
  versa. Interactive runs evaluate lazily from a requested output and quote their cost
  before any `spends` node fires.
- **Node identity**: `nodeHash = hashParts(typeName + typeVersion, canonicalProps,
  orderedInputHashes)`, where an image input hashes by content and a scalar input by
  canonical JSON. This is the task-graph identity rule transplanted one level down:
  upstream output hashes are embedded, so dirtiness propagates by construction and no
  separate invalidation bookkeeping exists to go stale.
- **Journal**: `vngen/state/graphs/<slug>.jsonl`, append-only full snapshots per node
  transition (`{nodeId, nodeHash, status, output?, usage?, error?, at}`), replayed
  last-writer-wins like `tasks.jsonl`. On load, recompute each node's `nodeHash` from the
  document and compare with the journal: a match with a `done` record is clean, anything
  else is dirty. That is the whole restart story, and it is correctly outside the undo
  scope — undo can rewind the document; it must not pretend to rewind spend. The drift
  report reads the same comparison at the active Output node, so no separate
  document-hash record exists to fall out of step.
- **Outputs**: the terminal image recorded as the task's output enters the
  content-addressed asset store the way every runner's art does. Intermediate node
  outputs are deliberately not assets — no `AssetKind`, no store root, invisible to the
  slot graph and the exporters — but they are saved in the project repo so restart and
  the journal's caching keep their evidence across clones: content-addressed blobs under
  `vngen/state/graphs/<slug>/`, beside the journal that references them (proposed
  layout; the decision is only that they live in the repo without being assets). Scalars
  and strings live inline in the journal record.

### The refine loop

The critique loop wraps the graph run, and a Refine input node inside the graph is where
the refiner's prompt enters. `shot_image`'s generate→critique→refine shape — the critic,
`config.max_refine_attempts`, `needs_human` at the cap — stays in the runner rather than
becoming nodes, so the cap and the critic are host policy applied to every graph alike.

- **The Refine prompt node carries the critique in when one is wired.** It emits an
  empty string on the first pass; after each critique the runner sets it to the refine
  prompt and re-evaluates the slot's active Output node.
- **An unwired graph is still refined, through its prompt.** If no path connects the
  Refine input to a slot's active Output node, the refiner instead modifies the derived
  prompt between attempts — the value the Derived-prompt node emits. Every graph gets
  the critique loop; wiring the Refine input changes where the critique enters, not
  whether it happens. The wiring test is judged per output, like drift.
- **Only the tail downstream of the entry point re-runs.** An attempt changes the value
  of one node — the Refine input when wired, the Derived-prompt node otherwise — so
  only hashes downstream of it move, the trunk above stays cached in the journal, and a
  Refine input wired in late keeps attempts cheap where a rewritten derived prompt
  re-runs most of the graph.
- **A model node can expand the prompt en route.** Model nodes are configurable to emit
  any output type their backing model supports, so the author can route the refine
  prompt through a text-model node that turns a terse critique into a more detailed
  prompt before it reaches the image node.

### Cost estimation

The one structural advantage a graph has over the pipeline: **all edges are known up
front**, so a complete estimate is a single pass over the dirty set — no
incremental-planning undercount, which is the thing `vngen cost` cannot fix.

- Each node type's cost model: `estimate(props, inputContext) → [{service, model, unit:
  'image' | 'mtok-in' | 'mtok-out', count}]`.
- Refinement adds a bounded multiplier: the tail downstream of the critique's entry
  point (the Refine input when wired, the Derived-prompt node otherwise) can re-run up
  to `config.max_refine_attempts` times, so the estimate shows the first pass plus the
  worst-case refine spend rather than pricing a single attempt.
- A **price table** converts units to dollars. None exists in the repo. Two layers,
  and the more specific wins: a shipped table, refreshed as part of the release process
  and stamped with a `pricesAsOf` date, and a user-level table at `userConfigDir` the
  author can have populated automatically — per user rather than per project, because
  prices follow the author's account and keys, which are already user-level state.
  Model plugins own population (see Plugins). Populating runs only when the author asks
  — nothing is scheduled — and every priced figure keeps the call counts beside the
  dollars so a stale table degrades to what `vngen cost` already honestly does.
  (docs/research/a-less-technical-mode.md already flagged "the app can name call
  counts but never money" as the missing fuel gauge; this is where it gets built.)
- **Actuals**: the journal records each spending node's reported usage (tokens for text;
  call counts for images, which report no usage today) and the priced estimate at run
  time, so the graph header can show estimated vs. actual for the last run.

### Slot coverage

Because the graph is the runner and adoption is not involved, every slot kind is
coverable, including `portrait:` — the P3 gate approves a portrait after it is drawn,
whichever runner drew it, and `gate.approve` stays the only writer of
`character.approvedPortrait`. `adoptSlot`'s refusal of portraits is untouched; it only
ever concerned the side-channel path, which remains reserved for unbound scratch graphs
and uploads.

### Agent integration

The agent gets tools, not registry access, per the command-system seam:

- `read_asset_graph(slot | name)` returns the DSL form (nodes, links, props — no layout).
- `edit_asset_graph` takes a whole replacement graph in DSL. The host validates with
  `validateGraphDSL` (diagnostics back to the model for self-repair), builds via
  `buildGraphFromDSL`, diffs by node id against the current document, preserves positions
  for surviving nodes, and auto-places new ones — `graphGetIslands`/`graphPack` seeded
  with existing positions held fixed, so the author's arrangement survives the agent's
  edit. Whole-graph replacement is fine at this scale (tens of nodes) and avoids
  inventing a delta grammar.
- `run_asset_graph` quotes the estimate and goes through the same confirm the human path
  uses; plan mode blocks it.
- The graph rules (validate, diff, apply, refusals) live in a constrained leaf package
  beside `@vn/artgen` — `@vn/gengraph` — so desktop commands and agent tools
  share decisions, not transport.

### Groups

In v1, from path.ux stage 5. Definitions live at `work/graphs/lib/<name>.json`, served by
an app `groupLoader`/`groupSaver` over that directory; instances carry sparse `wasSet`
overrides, so "the shared portrait pipeline, tweaked for one character" survives updates
to the shared definition. The executor needs nothing special — the library's `sort()` is
already flattened through group boundaries — and a group instance's node hashes
incorporate its resolved (overridden) props like any other node's.

### Plugins

Plugin nodes are TypeScript files we transpile — not arbitrary packages with their own
build:

- A plugin is a directory: `plugin.json` manifest (name, version, node types it declares,
  services it calls, key names it needs, its price-table fragment) plus `.ts` sources for
  the class/spec, runtime, and optional UI, split the same three ways as first-party
  nodes.
- We ship the build tool: esbuild bundles each part against a declared, versioned API
  (`@vn/gengraph/plugin`) at install time or on change. esbuild is a root devDependency
  today and not a desktop runtime dependency; shipping this means adding it (native
  binary through electron-builder, or `esbuild-wasm` to sidestep binary packaging — a
  question for the packaging pass).
- **Trust** (decided): installation is a deliberate confirmed act by a person, the
  agent's file writers refuse plugin paths — the `create_skill`/`edit_skill` precedent —
  and the code runs trusted thereafter. The runtime API is capability-only from day one
  (runtimes see nothing but `services`), so a worker sandbox can be added later as a
  change of harness, not of plugins.
- **Keys** resolve through the existing four-place `resolveKeys` order; the manifest
  names the key id, `project.setKey` stores it, `prop.secret` redaction applies, and
  plugin requests go through the provider ring so the API-fault diagnosis works for them
  too.
- A model plugin declares the output types its model supports, and each node instance
  is configured to choose which it emits — a text model emits prose or a prompt, an
  image model an image or a caption where the backend offers one. The refine loop leans
  on this: a refine prompt routed through a text-model node comes out as a more
  detailed prompt.
- Model plugins own price population. A plugin ships its price-table fragment in the
  manifest and may implement a fetch hook that writes current prices into the
  user-level table when the author asks for a refresh. Where its provider offers a
  per-key pricing API, the hook calls it; where it does not, the plugin may request the
  price-agent capability through `services` — an LLM agent with web fetch, run on the
  author's own key, its requests through the provider ring. The hook and the agent
  request are both declared in the manifest, so the install confirmation names them.
- First-party providers (Gemini today; OpenAI image, BFL FLUX as wanted) ship as
  built-in plugins through the same registry, so the seam is exercised from day one and
  factory.ts's hardcoded Gemini stops being load-bearing for graphs.

### The editor pane

Editor #17, titled Gen Graph: an `EDITORS` entry (`id: 'gengraph'`, tooltip per the
catalog), a
`renderer/pathux/editors/nodes.ts` subclassing `VnEditor`, `pins` on the graph (or its
slot), and a `claims` predicate for `slot`-selection contending with Task Graph's
`primary` claim (EDITORS order breaks the tie).

The hosting problem: the view plan builds `NodeEditor extends Area`, but desktop editors
extend `VnEditor`, and a class cannot extend both. The clean fix is in path.ux: split the
view so the pan/zoom surface, node frames, link underlay and gesture handling live in a
hostable widget (`NodeGraphView`, a container), and `NodeEditor extends Area` becomes a
thin shell around it. The desktop then hosts the widget inside a `VnEditor` via
`appendSurface`. The view plan is a draft, so this is a plan amendment, not rework.

## Asks of path.ux

All three asks were folded into the path.ux plans on 2026-08-24:

1. **`NodeGraphView` as a hostable widget** with `NodeEditor` as a thin Area shell.
   Recorded as a settled decision in node-editor-view.md and worked into its stage V2.
2. **A gesture delegate seam** (`NodeGraphDelegate`, with a `check` that answers a
   proposed edit's verdict mid-gesture) defaulting to the library's ToolOps, so a host
   routes edits into its own command system. Recorded beside the widget decision;
   V2 defines the seam and V3 routes every editing gesture through it.
3. **A stated headless contract for the graph module**: a test that imports
   scripts/graph in plain Node, so the module-scope DOM cleanliness verified above cannot
   silently regress under a util refactor. Recorded as an unchecked library addendum in
   node-editor-tasklist.md, since the library stages themselves are complete.

## Phasing

1. **path.ux view stage V2** — the library stages and V1 are already done, so the one
   remaining prerequisite is the `NodeGraphView` widget with its delegate seam.
2. **`@vn/gengraph`**: node classes and specs, semantic validation, node hashing, DSL
   diff/apply, cost model, journal format. Pure logic, tested with the testkit's mock
   providers.
3. **Executor and the graph runner** wired into the runner seam, plus `gengraph.*` commands
   and the built-in node set — no editor yet. Graphs are authored via the agent DSL or
   seeded from templates, run by the scheduler and from the palette. This proves
   identity, resume, drift and cost end to end before any canvas exists.
4. **The editor pane**, once the V2 widget split lands.
5. **Plugins**: manifest, transpile toolchain, confirmed-install plumbing; port the
   built-in providers onto the seam.

Each phase is separately shippable, and 3 before 4 means the agent and the scheduler can
use graphs before the human editor exists — which also pressure-tests the DSL while it is
cheap to change.


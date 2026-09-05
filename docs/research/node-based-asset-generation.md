# Node-based asset generation

Design study, 24 August 2026. The subject is a node-based asset generator. It draws one
graph per slot in path.ux's upcoming node editor and executes that graph in the app
itself. Provider nodes are pluggable and cover Gemini image, OpenAI image, FLUX, and text
LLMs. The app records which nodes need re-execution and keeps that record across restarts.
A DSL lets the authoring agent edit graphs without touching visual layout, and a cost
estimate is computed before any money is spent.

The user settled nine decisions on 2026-08-24. The design below applies them rather than
listing them as options:

1.  1. **A bound graph runs the slot, and the editor can also run it interactively.** The
       slot's task keeps its current identity; the scheduler's runner executes the graph
       with the derived prompt and refs as inputs and records the resulting image as the
       task's output. The editor can run the same graph interactively, and both runs share
       one execution journal.
2.  2. **The model is stored as a path.ux graph.** The document is nstructjs JSON, and
       nstructjs's own `validateJSON` validates it at the boundary; main holds real
       `Graph` objects. The section below records the verification that makes this
       arrangement safe.
3.  3. **Plugins install by explicit confirmation.** They run as trusted code against a
       capability-only API, and that API is shaped so a sandbox can be added later without
       rewriting plugins.
4.  4. **Groups ship in v1** and are consumed from path.ux stage 5.
5.  5. **A graph may contain several Output nodes.** Each binds an output target, so one
       graph can feed several slots. Among Output nodes with the same target, only the
       active one (the most recently selected, as in Blender) is used. The editor-side
       selection mechanics are deferred until the path.ux node editor is in place.
6.  6. **The refine loop wraps the graph run.** The runner keeps `shot_image`'s critique
       loop. The critique enters through the graph's Refine input node when one is wired
       into a path that reaches the slot's active Output node. When none is wired, the
       refiner modifies the derived prompt itself between attempts. Model nodes
       (configurable to emit any output type their model supports) can process the refine
       prompt into a more detailed one on the way.
7.  **Intermediates are saved in the project repo but are not assets.** Only the terminal
    image enters the asset store; intermediate node outputs are journal-referenced blobs
    with no `AssetKind`.
8.  8. **Prices come from the release and from the plugins.** The shipped table is
       refreshed as part of the release process. The model plugins own a user-level table
       (per user, deliberately not per project) and can populate it automatically. Where a
       provider exposes no per-key pricing API, a plugin may request access to an LLM
       agent with web fetch to read published pricing.
9.  **Names.** The rules package is `@vn/gengraph`, the command namespace is `gengraph.*`,
    and the editor pane is titled Gen Graph. An earlier `agraph.*` placeholder was
    rejected because it reads as "acyclic graph".

<!-- toc -->

- [What already exists](#what-already-exists)
    - [The path.ux node graph](#the-pathux-node-graph)
    - [The attachment point: slots](#the-attachment-point-slots)
    - [Identity, resume, and the runner seam](#identity-resume-and-the-runner-seam)
    - [Providers and money](#providers-and-money)
    - [The desktop shell](#the-desktop-shell)
    - [The standing objection](#the-standing-objection)
- [Architecture](#architecture)
    - [A graph is a project document whose Output nodes bind slots](#a-graph-is-a-project-document-whose-output-nodes-bind-slots)
    - [The path.ux graph is the model](#the-pathux-graph-is-the-model)
    - [A node type has three parts](#a-node-type-has-three-parts)
    - [Output nodes](#output-nodes)
    - [Execution](#execution)
    - [The refine loop](#the-refine-loop)
    - [Cost estimation](#cost-estimation)
    - [Slot coverage](#slot-coverage)
    - [Agent integration](#agent-integration)
    - [Groups](#groups)
    - [Plugins](#plugins)
    - [The editor pane](#the-editor-pane)
- [Asks of path.ux](#asks-of-pathux)
- [Phasing](#phasing)

<!-- tocstop -->

## What already exists

### The path.ux node graph

The design is vendor/path.ux/documentation/research/nodeEditor.md. The implementation
plans are documentation/plans/node-editor.md (the library: stages 1–7 are all done, and
the graph module lives at vendor/path.ux/scripts/graph/, which holds socket.ts, node.ts,
graph.ts, group.ts, dsl.ts) and node-editor-view.md (the editor: V1 is the pan/zoom
container and is done, while V2–V4 are unstarted). The following facts shape this design:

- **The library defines structure and does not evaluate.** Nodes have no `exec` method.
  The graph provides typed sockets with coercion, dirty tracking, a topological sort
  flattened through group boundaries, and serialization; the client walks that order and
  decides what running a node means. Any executor this app builds keeps this split between
  structure and evaluation.
- **Stage 6 ships an LLM DSL.** The DSL uses a flat format of `nodes: [{id, type, props}]`
  and `links: [[from, "out", to, "in"]]`. `validateGraphDSL` returns diagnostics rather
  than throwing, so a model can repair its own output, and `buildGraphFromDSL` produces a
  real `Graph`. The library graph is the model, so `validateGraphDSL` and
  `buildGraphFromDSL` consume it directly.
- **Stage 5 ships groups.** A group is an instanced subgraph whose definition lives in
  another file, loaded and saved by the client-supplied `groupLoader`/`groupSaver`, and
  each instance tracks sparse property overrides in `wasSet`. Groups map directly onto
  "one pipeline, instanced per character, with per-character tweaks that survive updates
  to the shared definition".
- The view plan builds `NodeGraphView`, a hostable widget that owns the canvas. Node
  bodies are real path.ux containers, a canvas underlay draws the links, and auto-arrange
  runs through `graphPack`/`graphGetIslands`. `NodeEditor extends Area` is a thin shell
  around the widget, and the consumer registers it.
- Stage 7 ships ToolOps and a datapath API for the library's own undo and forwarded UI.
  The desktop app has its own command stack and undo, so it installs a `NodeGraphDelegate`
  that routes editor gestures into commands rather than into the library's ToolOps (see
  "Asks of path.ux").

### The attachment point: slots

A slot is a `RefBinding` (packages/types/src/prompt.ts:94) with a canonical string form
from `slotKey` (packages/artgen/src/refcycle.ts:23): `portrait:aiko`,
`sheet:aiko/gala/front`, `plate:cafe/night`, `shot:greet/s2`. `buildSlotGraph`
(packages/artgen/src/slotgraph.ts:304) already enumerates every picture the project
implies (whether or not one has been drawn), with stable addresses that survive a re-plan,
a reverse dependency index, and per-slot status. Attach the generator graph to that graph
of slots rather than to the task graph of hashes, because a slot address is stable across
regeneration and a task hash is not.

### Identity, resume, and the runner seam

This design extends three pieces of existing machinery rather than replacing them:

- **Task identity** is `hashParts(kind, inputs)`, a canonical-JSON, key-order-insensitive
  hash (packages/taskgraph/src/hash.ts:10, packages/util/src/hash.ts:29), with the content
  hashes of upstream outputs embedded in `inputs.refs`. Embedding those output hashes
  propagates dirtiness: a change to an upstream picture moves every downstream identity.
  The graph-bound slot keeps this same identity. The graph changes how the task runs, not
  what the task is.
- **Resume needs no separate mechanism.** `state/tasks.jsonl` is an append-only log of
  full task snapshots, replayed last-writer-wins (packages/taskgraph/src/log.ts:18), and a
  replayed `done` node is never ready again. Re-running a task appends one `pending`
  snapshot (apps/desktop/src/main/session.ts:2561).
- **A runner** is `(task, deps) => Promise<TaskResult>`
  (packages/pipeline/src/runners.ts:24), chosen by task kind. Providers are reached only
  through `RunDeps`, so the scheduler never imports a concrete backend. A graph runner
  attaches at the same point as `makeShotRunner` (runners.ts:103).

The provider layer already has a record/replay cache keyed by
`sha256(canonicalJson({op, prompt, ref byte-hashes, params}))`
(packages/providers/src/cache.ts:27). That key memoizes on request identity, and a
nondeterministic node's cache key below takes the same shape.

### Providers and money

`ImageProvider` declares `generate(prompt, refs, params)` and
`edit(base, prompt, refs, params)` (packages/types/src/providers.ts:9). Images are
currently hardcoded to Gemini (packages/providers/src/factory.ts:51). Accounting covers
tokens only: `TokenUsage` reaches the desktop as usage events, image calls report nothing,
and the repo holds no price data. `vngen cost` (packages/pipeline/src/pipeline.ts:48)
counts calls rather than dollars, and undercounts because planning is incremental. Every
provider request passes through the bounded in-memory ring that the API-fault diagnosis
reads, and plugin nodes must keep that ring.

### The desktop shell

Editor #17 consists of one `EDITORS` entry (apps/desktop/src/shared/editors.ts:22) and a
`registerEditor(cls, 'vn.Nodes', fields)` call; the Asset editor supplies the binding
precedent (subject `ui.assetHash`, `pins: 'assetHash'`) and Task Graph supplies the canvas
precedent. Every write goes through a command. Undo shadow-snapshots the document class
and excludes `vngen/build` and `vngen/state` (packages/commands/src/undo.ts:16), so a
graph document under `work/` is undoable while an execution journal under `vngen/state/`
deliberately is not. By project convention, documents read whole are stored as json and
append-only logs as jsonl; per-file layout state is marked `-merge` in `.gitattributes`
the way layout templates are.

### The standing objection

docs/plans/desktop-editors-tracking.md:155 records "Prompt node editor" under **Not being
built**: it "converts deterministic plumbing into user data, and every edit rehashes
downstream tasks — casual fiddling silently invalidates generated art." The
graph-as-runner decision resolves both concerns:

1.  1. **The deterministic plumbing stays derived.** Planning, task identity, dedup and
       resume all keep reading the derived prompt, refs and params. The graph replaces
       only the generative step (the one step that was never deterministic) and only for
       slots that opt in. A slot with no graph is untouched.
2.  2. **A graph edit changes no hashes.** The task's identity does not include the graph,
       so editing a graph invalidates nothing and discards nothing. The edit is reported
       as drift. The journal records the hash of the Output node that produced the slot's
       current art, and a mismatch against the current document shows as "graph changed
       since last render", just as a prose edit shows against `Shot.proseHash`.
       Re-rendering still requires an explicit requeue, and interactive runs quote their
       cost first.

## Architecture

### A graph is a project document whose Output nodes bind slots

Each graph is one JSON document at `work/graphs/<slug>.json`. Binding is declared on the
graph's Output nodes rather than in the filename or a document-level field: each Output
node carries a slot-key prop (`sheet:aiko/gala/front`), so one graph may feed several
slots. A sheet graph with three Output nodes drives all three angles from one shared
trunk. The pipeline finds a slot's graph through an index built by scanning the documents'
output bindings on load. A graph whose Output nodes bind nothing is legal: such a scratch
graph is the node-based analogue of a concept image, and its results enter the pipeline
the way a concept image's results do (adoption/promotion), which keeps `adoptSlot`'s
existing refusals intact. The file is:

- nstructjs JSON written by `writeJSON`, checked by `validateJSON` on load (see the next
  section);
- written only by commands (a new `gengraph.*` namespace);
- inside the undo scope (`work/` is in the document class);
- marked `-merge` in `.gitattributes`, like a layout, because merging two authors'
  versions line by line produces a graph neither author built.

### The path.ux graph is the model

This is decided. Main holds a real `Graph` per open graph document; commands mutate it;
`writeJSON` serializes it; the renderer's editor views the same graph. Two objections were
raised against this design, and both were checked and cleared:

- **Boundary validation.** nstructjs's `validateJSON(json, cls)`
  (vendor/nstructjs/documentation/jsonGuide.md) checks missing fields, wrong types,
  unknown keys, and a polymorphic discriminator naming a non-subclass, with positional
  error context. Those checks are structural validation equivalent to a zod schema for
  this format. A schema cannot express whether props match the node type's declared spec,
  whether link sockets are compatible, or whether a slot key parses. These semantic checks
  live in the rules package regardless of format, as a pass after `readJSON`.
- **Node-cleanliness.** The graph module's imports of `Container`, `IContextBase` and
  `DataAPI` are all `import type` and are erased at compile time. Its runtime chain
  (nstructjs, `ToolProperty`, vectormath, path-controller util) was checked for
  module-scope DOM access: the `navigator` and `window` uses in util.ts are inside
  functions (`isMobile`, the base64 helpers) or behind `debug_cacherings = false`
  (util.ts:678). Electron main and the node-only CLI can import the graph module today.
  Node-cleanliness is currently an incidental property; the requests below make it a
  stated contract.

The decision has two consequences. Stage 6's `buildGraphFromDSL` and stage 5's group
machinery are consumed wholesale rather than reimplemented, and the main-process and CLI
bundles need the same `pathux` alias vite gives the renderer. nstructjs is a first-party
submodule at vendor/nstructjs, so format-level needs (there should be few) can be changed
there, and each change reaches path.ux's own dependency through the usual
publish-and-bump.

This route has one real cost. Editor gestures must dispatch commands rather than library
ToolOps, so the command stack remains the only write path and `stack.check` supplies the
mid-gesture verdict. The gesture-delegate request below covers that cost.

### A node type has three parts

1.  1. **Class + spec** (shared): The class and spec pair the path.ux `Node` subclass —
       sockets, `ToolProperty` props, `NodeDef` — with app metadata the library does not
       carry: `typeVersion`, a `spends` flag, and the cost model. The graph module is
       browser-safe and node-clean, so these classes live in shared code that both
       processes import, which satisfies the `src/shared/` node-free rule.
2.  2. **Runtime** (main and CLI): `run(inputs, props, services) → outputs`, registered by
       type name. The executor hands in `services`, a capability object that holds
       provider access, key resolution, the asset store, and a fetch that passes through
       the request ring. Runtimes never receive ambient `fs`/`net`.
3.  3. **UI** (renderer only, optional): Supplies a `createUI` body for nodes whose props
       need more than generated widgets. Most nodes need nothing here.

The first-party starter set contains **Derived prompt** (the task's derived prompt —
inside a scheduler run this is the running task's own prompt, and interactively it is
computed from the bound slot via the existing `build*Chunks` derivation), **Task refs**
(the task's ordered refs, with the same dual sourcing), **Slot ref** (a specific upstream
slot's current asset by `slotKey`), **Text** / **Template**, **LLM rewrite** (text model
call), **Generate image** (Gemini today), **Edit image** (base + refs), **Reference list**
(ordered, because order is part of request identity), **Image file** (an adopted upload or
concept by hash), **Refine prompt** (the refiner's critique text, which is empty on the
first pass; see the refine loop), **Switch/Blend** utilities, and **Output image** (the
special terminal; see the next section).

### Output nodes

The Output node is a special terminal, and a run is read from it. A graph may contain any
number of Output nodes:

- **Different targets fan out.** Each Output node binds one slot key, so a sheet graph
  binds three Output nodes to its three angles and each angle's task evaluates from its
  own Output node. The tasks share the trunk upstream of the split. Because of the
  journal's node cache, a shared node runs once for whichever task reaches it first.
- **Several Output nodes on one target are variants, resolved Blender-style.** Exactly one
  Output node per target is active, and selecting an Output node in the editor makes it
  the active one for its target. A command writes the active flag into document state, so
  the flag is undoable, diffable, and reachable from the agent's DSL rather than being
  ephemeral selection. The editor-side mechanics (how a selection gesture reaches that
  command) are left until the path.ux node editor is in place. This design does not
  require active-output support from path.ux; the app tracks the flag itself.
- **Drift is measured at the active Output node.** An Output node's `nodeHash` (next
  section) transitively embeds everything upstream of it, so a slot's drift check is a
  single comparison of the active Output node's recomputed hash against the journal's last
  `done` record. An edit to a branch that does not feed a slot's active output does not
  drift that slot, and switching the active output shows up as drift.

### Execution

- **The graph runner.** When a slot carries a graph binding, the pipeline's runner for
  that task loads the document, feeds the task's prompt and refs into the Derived-prompt
  and Task-refs input nodes, evaluates the flattened `sort()` order up to the slot's
  active Output node, executing what is dirty, and records that node's image as the task's
  output and attempt. That record uses the same `TaskResult` shape every runner returns.
  Sibling tasks bound into one graph each evaluate from their own Output node and share
  one journal, so the common trunk runs once. Task failure records and the single retry
  behave as they do for any task. The executor sits beside the pipeline spine so that both
  the CLI scheduler and the desktop can reach it. `@vn/authoring` never imports it. The
  agent's run tool goes through an injected capability (the `PipelineControl` pattern,
  packages/authoring/src/tools.ts:126).
- **Interactive runs** from the editor use the same executor with the same journal, so the
  editor does not recompute a node a scheduler wave has already computed, and a scheduler
  wave does not recompute a node the editor has already computed. Interactive runs
  evaluate lazily from a requested output and quote their cost before any `spends` node
  fires.
- **Node identity**:
  `nodeHash = hashParts(typeName + typeVersion, canonicalProps, orderedInputHashes)`,
  where an image input hashes by content and a scalar input by canonical JSON. Node
  hashing applies the task-graph identity rule one level down: upstream output hashes are
  embedded, so dirtiness propagates by construction and no separate invalidation
  bookkeeping exists to go stale.
- **Journal**: `vngen/state/graphs/<slug>.jsonl` holds append-only full snapshots per node
  transition (`{nodeId, nodeHash, status, output?, usage?, error?, at}`), replayed
  last-writer-wins like `tasks.jsonl`. On load, recompute each node's `nodeHash` from the
  document and compare it with the journal. A node whose hash matches a `done` record is
  clean, and every other node is dirty. That comparison is all a restart needs, and it
  sits correctly outside the undo scope: undo rewinds the document, and it does not rewind
  spend. The drift report reads the same comparison at the active Output node, so there is
  no separate document-hash record to keep in sync.
- **Outputs**: The terminal image recorded as the task's output enters the
  content-addressed asset store the way every runner's art does. Intermediate node outputs
  are deliberately not assets: they have no `AssetKind` and no store root, and neither the
  slot graph nor the exporters see them. The project repo still saves them, as
  content-addressed blobs under `vngen/state/graphs/<slug>/` beside the journal that
  references them, so that a restart and the journal's caching still have them across
  clones (proposed layout; the decision is only that they live in the repo without being
  assets). Scalars and strings live inline in the journal record.

### The refine loop

The critique loop wraps the graph run, and a Refine input node inside the graph receives
the refiner's prompt. `shot_image`'s generate→critique→refine shape (the critic,
`config.max_refine_attempts`, and `needs_human` at the cap) stays in the runner rather
than becoming nodes, so the runner applies the same cap and the same critic to every
graph.

- **The Refine prompt node carries the critique when a critique is wired in.** The node
  emits an empty string on the first pass. After each critique, the runner sets the node
  to the refine prompt and re-evaluates the slot's active Output node.
- **An unwired graph is still refined through its prompt.** If no path connects the Refine
  input to a slot's active Output node, the refiner modifies the derived prompt between
  attempts instead. The derived prompt is the value the Derived-prompt node emits. Every
  graph runs the critique loop. Wiring the Refine input changes where the critique enters,
  and does not change whether the critique runs. The wiring test is judged per output, and
  drift is judged per output too.
- **Only the tail downstream of the entry point re-runs.** An attempt changes the value of
  one node. That node is the Refine input if one is wired, and the Derived-prompt node
  otherwise. Only hashes downstream of that node change, and the trunk above it stays
  cached in the journal. Wiring a Refine input in late keeps attempts cheap, while a
  rewritten derived prompt re-runs most of the graph.
- **A model node can expand the prompt before it reaches the image node.** A model node
  can be configured to emit any output type its backing model supports, so the author can
  route the refine prompt through a text-model node that turns a terse critique into a
  more detailed prompt.

### Cost estimation

A graph has one structural advantage over the pipeline. All edges are known up front, so a
complete estimate is a single pass over the dirty set. This avoids the
incremental-planning undercount, which `vngen cost` cannot fix.

- Each node type has a cost model,
  `estimate(props, inputContext) → [{service, model, unit: 'image' | 'mtok-in' | 'mtok-out', count}]`.
- Refinement raises the estimate by a bounded factor. The tail downstream of the
  critique's entry point can re-run up to `config.max_refine_attempts` times, so the
  estimate shows the first pass plus the worst-case refine spend rather than pricing a
  single attempt. The entry point is the Refine input if it is wired, and the
  Derived-prompt node otherwise.
- A **price table** converts units to dollars. None exists in the repo. There are two
  layers, and the more specific one wins. The shipped table is refreshed as part of the
  release process and stamped with a `pricesAsOf` date. The user-level table sits at
  `userConfigDir` and can be populated automatically for the author. It is per user rather
  than per project, because prices follow the author's account and keys, which are already
  user-level state. Model plugins populate it (see Plugins). Population runs only when the
  author asks, and nothing is scheduled. Every priced figure keeps the call counts beside
  the dollars, so a stale table degrades to the call counts `vngen cost` already reports.
  (docs/research/a-less-technical-mode.md already flagged "the app can name call counts
  but never money" as the missing fuel gauge; the price table described here supplies it.)
- **Actuals**: The journal records each spending node's reported usage and the priced
  estimate at run time, so the graph header can show estimated vs. actual for the last
  run. Reported usage is tokens for text and call counts for images, which report no usage
  today.

### Slot coverage

The graph acts as the runner and no adoption step is involved, so every slot kind is
coverable, including `portrait:`. The P3 gate approves a portrait after it is drawn, no
matter which runner drew it, and `gate.approve` remains the only writer of
`character.approvedPortrait`. `adoptSlot` still refuses portraits. That refusal only ever
concerned the side-channel path, which remains reserved for unbound scratch graphs and
uploads.

### Agent integration

Under the command-system seam, the agent receives tools rather than registry access:

- `read_asset_graph(slot | name)` returns the DSL form, which contains nodes, links and
  props but no layout.
- `edit_asset_graph` takes a whole replacement graph in DSL. The host validates with
  `validateGraphDSL` (diagnostics back to the model for self-repair), builds via
  `buildGraphFromDSL`, diffs by node id against the current document, preserves positions
  for surviving nodes, and auto-places new ones by seeding `graphGetIslands`/`graphPack`
  with the existing positions held fixed, so the author's arrangement survives the agent's
  edit. Whole-graph replacement is fine at this scale (tens of nodes) and avoids inventing
  a delta grammar.
- `run_asset_graph` quotes the estimate and asks for the same confirmation the human path
  asks for. Plan mode blocks the call.
- The graph rules (validate, diff, apply, refusals) live in a constrained leaf package
  `@vn/gengraph`, beside `@vn/artgen`. Desktop commands and agent tools share its
  decisions rather than its transport.

### Groups

In v1, from path.ux stage 5, definitions live at `work/graphs/lib/<name>.json`, served by
an app `groupLoader`/`groupSaver` over that directory. Instances carry sparse `wasSet`
overrides, so "the shared portrait pipeline, tweaked for one character" survives updates
to the shared definition. The executor needs nothing special, because the library's
`sort()` is already flattened through group boundaries. A group instance's node hashes
incorporate its resolved (overridden) props like any other node's.

### Plugins

Plugin nodes are TypeScript files that we transpile rather than arbitrary packages with
their own build:

- A plugin is a directory. It holds a `plugin.json` manifest that lists the name, version,
  node types it declares, services it calls, key names it needs, and its price-table
  fragment. It also holds `.ts` sources for the class/spec, runtime, and optional UI,
  split the same three ways as first-party nodes.
- We ship the build tool. esbuild bundles each part against a declared, versioned API
  (`@vn/gengraph/plugin`) at install time or on change. esbuild is a root devDependency
  today and not a desktop runtime dependency, so shipping this means adding it (as a
  native binary through electron-builder, or as `esbuild-wasm` to sidestep binary
  packaging). The packaging pass decides between them.
- **Trust** (decided): a person installs a plugin as a deliberate confirmed act, the
  agent's file writers refuse plugin paths (following the `create_skill`/`edit_skill`
  precedent), and the code runs trusted thereafter. The runtime API is capability-only
  from day one (runtimes see nothing but `services`), so a worker sandbox can be added
  later as a change of harness rather than a change of plugins.
- **Keys** resolve through the existing four-place `resolveKeys` order. The manifest names
  the key id, `project.setKey` stores it, and `prop.secret` redaction applies to it.
  Plugin requests go through the provider ring, so the API-fault diagnosis works for them
  too.
- A model plugin declares the output types its model supports, and each node instance is
  configured to choose which one it emits. A text model emits prose or a prompt. An image
  model emits an image, or a caption where the backend offers one. The refine loop uses
  this behavior, so a refine prompt routed through a text-model node comes out as a more
  detailed prompt.
- Model plugins populate prices. A plugin ships its price-table fragment in the manifest
  and may implement a fetch hook that writes current prices into the user-level table when
  the author asks for a refresh. If its provider offers a per-key pricing API, the hook
  calls that API. Otherwise the plugin may request the price-agent capability through
  `services`, which runs an LLM agent with web fetch on the author's own key and routes
  its requests through the provider ring. The hook and the agent request are both declared
  in the manifest, so the install confirmation names them.
- First-party providers (Gemini today, OpenAI image and BFL FLUX if needed) ship as
  built-in plugins through the same registry, so the "seam" (the provider plugin boundary)
  is exercised from day one and graphs no longer depend on the hardcoded Gemini in
  factory.ts.

### The editor pane

Editor #17 is titled Gen Graph. It consists of an `EDITORS` entry (`id: 'gengraph'`,
tooltip per the catalog), a `renderer/pathux/editors/nodes.ts` subclassing `VnEditor`,
`pins` on the graph (or on its slot), and a `claims` predicate for `slot`-selection that
contends with Task Graph's `primary` claim. The `EDITORS` order breaks the tie.

Hosting the editor on the desktop is blocked. The view plan builds
`NodeEditor extends Area`, but desktop editors extend `VnEditor`, and a class cannot
extend both. Fix this in path.ux by splitting the view so that the pan/zoom surface, node
frames, link underlay and gesture handling live in a hostable widget (`NodeGraphView`, a
container), while `NodeEditor extends Area` becomes a thin shell around it. The desktop
then hosts the widget inside a `VnEditor` via `appendSurface`. The view plan is a draft,
so this is a plan amendment, not rework.

## Asks of path.ux

All three requests were incorporated into the path.ux plans on 2026-08-24:

1.  1. **`NodeGraphView` is a hostable widget**, and `NodeEditor` is a thin Area shell
       around it. This decision is recorded as settled in node-editor-view.md and is
       worked into its stage V2.
2.  2. **A gesture delegate seam.** `NodeGraphDelegate` has a `check` method that returns
       a verdict on a proposed edit mid-gesture, and it defaults to the library's ToolOps,
       so a host routes edits into its own command system. Recorded beside the widget
       decision; V2 defines the seam and V3 routes every editing gesture through it.
3.  3. **A stated headless contract for the graph module**: A test imports scripts/graph
       in plain Node, so a util refactor cannot silently regress the module-scope DOM
       cleanliness verified above. node-editor-tasklist.md records this as an unchecked
       library addendum, since the library stages themselves are complete.

## Phasing

1. **path.ux view stage V2** — the library stages and V1 are already done, so the one
   remaining prerequisite is the `NodeGraphView` widget with its delegate seam.
2.  2. **`@vn/gengraph`**: Provides node classes and specs, semantic validation, node
       hashing, DSL diff/apply, the cost model, and the journal format. It is pure logic
       and is tested with the testkit's mock providers.
3.  3. **Executor and the graph runner** are wired into the runner seam, along with
       `gengraph.*` commands and the built-in node set. There is no editor yet. Graphs are
       authored via the agent DSL or seeded from templates, and run by the scheduler and
       from the palette. This stage proves identity, resume, drift and cost end to end
       before any canvas exists.
4.  4. **The editor pane** (once the V2 widget split lands).
5.  5. **Plugins**: add the manifest, the transpile toolchain and the confirmed-install
       plumbing, then port the built-in providers onto the "seam".

Each phase is separately shippable. Running phase 3 before phase 4 lets the agent and the
scheduler use graphs before the human editor exists, and it exercises the DSL while the
DSL is still cheap to change.

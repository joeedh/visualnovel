# Generation graphs

A generation graph is a node network that draws a slot's picture. An author opts into it per slot. It is an authored
document, edited in the desktop app's Gen Graph pane or rewritten whole by the authoring agent, and the pipeline runs it
in place of the fixed runner the slot would otherwise use. This page describes the whole feature as shipped: the package,
the node types, how a node is identified and journaled, how a run works, what it costs, the commands, groups, the pane,
the CLI and plugins.

path.ux supplies the graph model. The `Graph`, `Node` and socket classes, the group machinery, the DSL and the
`NodeGraphView` widget are documented in
[`../../vendor/path.ux/documentation/NodeEditor.md`](../../vendor/path.ux/documentation/NodeEditor.md). This page covers
what the application adds on top. The design was settled in
[`../research/node-based-asset-generation.md`](../research/node-based-asset-generation.md) and implemented across two
plans, [`../plans/node-based-asset-generation.md`](../plans/node-based-asset-generation.md) and
[`../plans/archive/group-nodes-in-the-gen-graph-editor.md`](../plans/archive/group-nodes-in-the-gen-graph-editor.md),
which record stage by stage what was built and where the work deviated from the plan.

<!-- toc -->

- [What a graph is](#what-a-graph-is)
- [Where things live on disk](#where-things-live-on-disk)
- [The package](#the-package)
- [Node types](#node-types)
  * [`GenServices`](#genservices)
- [Identity, the journal and drift](#identity-the-journal-and-drift)
- [Slots and outputs](#slots-and-outputs)
- [Running a graph](#running-a-graph)
- [Cost](#cost)
- [The DSL and the agent](#the-dsl-and-the-agent)
- [The commands](#the-commands)
- [Groups](#groups)
- [The Gen Graph pane](#the-gen-graph-pane)
- [The CLI](#the-cli)
- [Plugins](#plugins)
- [Deliberately not built](#deliberately-not-built)
- [History](#history)

<!-- tocstop -->

## What a graph is

- **A bound graph runs the slot.** A task keeps the identity it has always had, `hashParts(kind, inputs)` over the
  derived prompt, the references and the params. Binding a graph to the task's slot changes how the picture is made, not
  what the task is, so a graph edit moves no task hash. The difference shows as drift instead (below), and the next run
  puts the drifted slot's task back to `pending` rather than giving it a new identity. A slot that no graph claims runs
  exactly the code it ran before graphs existed.
- **The model is stored as a path.ux graph.** Main holds real `Graph` objects. A file is nstructjs JSON, checked on
  load by nstructjs's `validateJSON`. `@vn/gengraph` runs the semantic pass, which checks props against the registered
  spec, socket compatibility, and the slot an output names.
- **Names.** The package is `@vn/gengraph`, the commands are `gengraph.*`, the pane is titled Gen Graph, and a graph is
  addressed by its slug, which is the file name under `work/graphs/`. A slug matches `[a-z0-9][a-z0-9-]*`, and slugs are
  compared case-insensitively because the filesystem may compare them that way.
- **One journal serves scheduled and interactive runs.** `vngen run`, `pipeline.run` in the app, and `gengraph.run` all
  execute through the same executor and append to the same journal, so a node that ran under one of these entry points
  resumes under the others.

## Where things live on disk

Every path below is read from one module, `paths.ts` in `@vn/gengraph`.

| Path                                    | Holds                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vngen/work/graphs/<slug>.json`         | A graph document, nstructjs JSON with layout. Written only by `gengraph.*` commands; `doc.*` refuses the directory the way it refuses `scenes/`. |
| `vngen/work/graphs/lib/<ref>.json`      | A group definition. Every graph that instances `<ref>` follows this file.                                                                         |
| `vngen/state/graphs/<slug>.jsonl`       | The graph's run journal, append-only, one full record per line.                                                                                  |
| `vngen/state/graphs/<slug>/<hash>.<ext>` | The blobs a run produced, content-addressed, referenced from journal records.                                                                     |
| `<userConfigDir>/plugins/<name>/`       | An installed plugin, with its cached bundle beside the sources.                                                                                   |
| `<userConfigDir>/prices.json`           | The author's own price table, refreshed only on request.                                                                                          |

- `work/` is inside undo scope and `state/` is outside it, which is the split the task pipeline
  already makes. Undoing a graph edit restores the document; the journal and the blobs stay.
- The project's `.gitattributes` gains `vngen/work/graphs/*.json -merge` and
  `vngen/work/graphs/lib/*.json -merge`, so a conflicted graph is refused by name rather than
  half-merged. The desktop reports a conflicted graph as a notification; `@vn/testkit` throws.
- Intermediates are saved in the repo but are never assets. A blob has no `AssetKind` and enters neither asset root.
  Only the picture the active output terminates on enters the asset store, and it enters only on the bound path.
- `@vn/gengraph/state` reads and writes a graph document and a group definition (`readGraphDoc`, `writeGraphDoc`,
  `readGroupDef`, `writeGroupDef`, `readGroupLibrary`), because the authoring agent loads the same files and cannot
  import the desktop app. The desktop's `main/graphs.ts` adds the git handling, refuses a conflicted graph, and builds
  the summary that the document tree uses to list graphs. A read returns diagnostics rather than throwing, and main
  caches a parse behind an mtime-and-size check on the graph file and on every definition file it resolved.

## The package

`@vn/gengraph` is a constrained leaf that sits beside `@vn/artgen`. It may import `types`, `util`, `config`, `model`,
`store`, `taskgraph` and `artgen` (for the slot vocabulary at `@vn/artgen/slotaddr`), and deliberately may not import
`providers`, `pipeline` or `scheduler`. Every model call goes through the `GenServices` interface the package declares.
Three consumers list it: `pipeline` (the graph runner), `authoring` (the agent tools' rules) and `desktop`. The layering
rules are in [`packages.md`](packages.md), and the module list is in
[`module-map.md`](module-map.md#vngengraph--generation-graphs-packagesgengraph).

- **It reaches path.ux through two aliases of its own.** `pathux-graph` is the graph module, and `pathux-toolprop` is
  the `ToolProperty` classes a spec declares props with. Both resolve to source where code runs and to declarations where
  the code is only checked. `nstructjs` is pinned to the `vendor/nstructjs` submodule on every surface, because two
  copies of nstructjs in one process create two STRUCT registries and every graph load then fails. The wiring is recorded
  in [`../guides/toolchain.md`](../guides/toolchain.md).
- **Four entries.** The barrel depends on no `fs` and no DOM APIs, so the renderer imports it. `@vn/gengraph/state`
  holds everything that touches the project tree: the paths, `nodeHash` and `graphHashes`, the journal's file half, the
  blob store, `graphDrift`, the executor (which hashes through `@vn/util` and so depends on `node:crypto`), the documents
  and the group library, and plugin installation. `@vn/gengraph/plugin` is the versioned surface a plugin is written
  against, and `@vn/gengraph/migrate` is the JSON migration the reader runs first.
- **Validation runs at the boundary.** `validateGenGraph` runs after `readJSON` and checks that props match the
  registered spec, links join compatible sockets, and every output node's slot parses under `parseSlot` and is not an
  `asset` binding. It reports an unknown node type by name (a plugin not installed here), and reports an output node
  inside a group as `output-in-group`. An unbound graph (one with no output, or with an output naming no slot) is legal.

## Node types

A node type has up to three parts. Every host shares the class and the spec. The class is a path.ux `Node` subclass whose
`graphDef()` declares sockets and `ToolProperty` props, and the spec is a `GenNodeSpec` carrying what the generator needs
to know. A runtime, `run(inputs, props, services)`, is registered by type name, and only in a host that can supply
services (`registerGenRuntimes`). A `customPropUX` entry on the definition draws one prop differently; a model prop uses
such an entry to draw a dropdown over the priced models.

`GenNodeSpec` fields:

- `spends` marks a type whose run calls a paid model. A forced re-run invalidates only spending nodes, and a scratch
  branch of spending nodes runs only when a target descends from it.
- `slotProp` names the prop holding the slot the node fills. Only an output node has a `slotProp`.
- `estimate(props, {connected})` returns what one run is expected to spend, before anything has run, in `image`,
  `mtok-in` or `mtok-out` units. A type with no estimate counts as spending nothing.
- `seededInput` names the input socket a host fills before a run. Its value belongs to the task rather than to the
  graph, so `authoredHashes` ignores the seeded value.
- `refineInput` names the socket that a refine pass re-enters at. `refineFallback` marks the node that a refine pass
  falls back to when nothing is wired to a refine input.
- `migrations` lists every rename the type has been through. `registerGenNode` refuses a migration whose targets name
  nothing on the class or whose last step stops short of the declared `typeVersion`. The contract is in
  [`pipeline-contracts.md`](pipeline-contracts.md), under renaming a socket or prop.

Three socket types are declared beside the nodes, because path.ux ships float and vec3, and both describe geometry.
`TextSocket` carries a string. `ImageSocket` carries a `GenImageRef`, which names the store holding the bytes as well as
the hash, so a node reading an asset does not copy it into the blob store first. `RefsSocket` carries a list of
`GenImageRef`s, and an image output feeds a refs input as a one-item list through path.ux's coercion.

`registerGenNodes` registers the twelve built-in types:

| Type               | Shown as        | What it does                                                                                                               | Spec                          |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `GenDerivedPrompt` | Derived prompt  | Passes through the prompt the host derived for the bound slot.                                                             | seeded `prompt`, refine fallback |
| `GenTaskRefs`      | Task refs       | Passes through the task's reference pictures, seeded as the JSON an `AssetRef[]` writes to.                                | seeded `assets`               |
| `GenRefinePrompt`  | Refine prompt   | Carries the critique a refine pass wrote; empty until one has run.                                                         | seeded `text`                 |
| `GenSlotRef`       | Slot ref        | Reads whatever asset another slot holds when the graph runs, such as a plate or a sheet.                                   |                               |
| `GenImageFile`     | Image file      | Names a picture already in the asset store, by content hash and extension.                                                 |                               |
| `GenTemplate`      | Text            | Authored text with `{varA}`, `{varB}` and `{varC}` replaced by what feeds those inputs. A template naming none is plain text. | migration v1→v2               |
| `GenRewrite`       | LLM rewrite     | Rewrites its input through a text model, under an instruction and a system prompt.                                         | spends                        |
| `GenImage`         | Generate image  | Draws a picture from a prompt, references and an optional critique, with model, aspect and seed props.                     | spends, refine input `refine` |
| `GenEditImage`     | Edit image      | Redraws the picture feeding it, guided by a prompt and further references.                                                 | spends                        |
| `GenRefList`       | Reference list  | Collects pictures into one ordered list: the list input first, then `a`, `b` and `c`.                                      |                               |
| `GenSwitch`        | Switch          | Passes on picture `a` or picture `b`, so a branch is tried without rewiring.                                               |                               |
| `GenOutput`        | Output image    | Fills the named slot with the picture feeding it. Declares no output socket; its runtime returns the terminal picture.    | slot prop `slot`, `active`    |

- The three host-seeded nodes take their value on an input socket rather than in a prop. Taking the value on a socket
  lets `graphHashes` read a seeded value through the socket's default with no special case, and keeps the seeded prompt
  out of the document's authored state. `seedInputs` refuses to seed an input the type does not declare, so a fourth
  seeded type cannot count task state as authored.
- The image nodes store their seed as a string, and an empty string means the seed is unauthored, because a
  `FloatProperty` always carries a value and zero is a valid seed. A seed that does not read as a number is refused
  rather than dropped. `GenRewrite`'s estimate uses nominal token counts, because an estimate runs before any input has a
  value. Blend is deliberately absent from the Switch/Blend pair, because nothing in the repository composites two
  pictures.
- The Derived-prompt node reproduces byte for byte what the fixed runner composes for a slot, and the first bullet of
  this page rests on that reproduction. The scheduled runner seeds the node from the task. In `gengraph.run`, the session
  computes it from the bound slot through the existing `build*Chunks` derivation, because the derivation needs the
  project model, which `GenServices` deliberately does not carry.
- `defaultSlotGraph(slot)` builds the graph an author gets when they ask for one rather than wiring it. It holds
  Derived prompt and Task refs feeding Generate image, and the picture from Generate image fills the slot. Every host
  builds the same four nodes, so a graph created from the document tree, the CLI or the agent runs the way the pipeline's
  own path does.

### `GenServices`

Holds everything a node runtime may reach outside its own inputs and props. The host supplies it, so the same type runs
against real providers in the app and against mocks in a test:

- `image.generate(prompt, refs, params)` and `image.edit(base, prompt, refs, params)` take reference pictures as bytes,
  because a node's references come from the blob store its upstream wrote to. The image service is the byte-level
  `ImageBackend` seam, so a graph and a task runner produce the same picture from the same prompt and refs.
- `text.complete(modelId, prompt, system?)` and `text.structured(...)`. The host's text service sends every call to the
  project's one configured text provider. The model specified by a node is recorded rather than used for routing.
- `blobs.read(hash)` and `blobs.write(bytes, ext)` are kept per graph slug, which is why a services object lives on
  each loaded graph rather than on the runtime.
- The Slot-ref and Image-file nodes read the asset store through `assets.read(ref)` and `assets.slot(slotKey)`.
- Calls `fetch(url, init?)` through the provider request ring, so a fault can be read against the body that caused it.
- `key(name)` returns the value of a declared key through the ordinary `resolveKeys` chain, or undefined.

The derived prompt is absent by design, and the host passes it in as an input value. `@vn/pipeline`'s `createGenServices`
builds the real implementation from the project's providers, asset store and keys, and the CLI scheduler and the desktop
session share that implementation. The testkit passes a mock.

## Identity, the journal and drift

- **A node's hash is computed from its content.** `nodeHash` runs `hashParts` over the type name with its version, the
  authored props, and whatever feeds each input. A connected input contributes the hash of the node feeding it together
  with the socket it came from, so dirtiness propagates by construction. A picture contributes its content hash rather
  than its bytes. An unconnected input contributes its own default value, and that is how a host's seeded prompt reaches
  the hash. Id, label and position are absent, so moving a node cannot re-run it. Nodes inside a cycle are absent from
  the result, because a hash there would have to contain itself.
- **Two hashes per node.** `graphHashes` changes with the task a run was made for, so a task whose art notes changed
  redraws instead of resuming the cached picture, and a refine attempt's new critique re-runs the tail. `authoredHashes`
  reads each host-seeded input as though nothing had been seeded onto it, so it covers the authored graph alone. Drift is
  measured on `authoredHashes`.
- **A node inside a group is keyed by its id chain.** Every graph's id counter starts at zero, so a node inside a group
  instance normally shares its id with some root node. `nodeKey` names a node by the chain from the root (`3/7` for node
  7 inside instance 3), and a root node's key is its id, so a graph with no groups reads exactly as before. The hashes,
  the journal, the executor's target set, its result lists and the cost walk are all keyed this way, and `resolveNodeKey`
  walks a key back to the node. A DSL id containing `/` is refused, so a key can never be mistaken for an id. An input
  reaching an instance's boundary default through the group's proxy contributes that default to the hash (as an
  unconnected input does), so two instances that differ only in that default hash apart.
- **The journal only appends, and each append is a full snapshot.** Each line of `state/graphs/<slug>.jsonl` holds one
  node's whole state as `{v, nodeId, nodeHash, authoredHash?, status, output?, usage?, error?, at}`. Every line carries
  `v` because git union-merges the file across clones. `status` is `running`, `done`, `failed` or `invalidated`. Replay
  keeps the last line written for each node, the same way `state/tasks.jsonl` is replayed. A line that does not parse (a
  crash mid-append) is counted and skipped rather than raised as an error. A record written before `authoredHash` existed
  reports no drift.
- **Drift is reported per output node and acted on at run time.** `graphDrift` recomputes each active output's authored
  hash and compares it against the journal's last `done` record for that node. `requeueDrifted` in `@vn/scheduler`
  returns every planned `done` or `needs_human` task whose bound graph has drifted to `pending`, once per run and before
  the wave loop, and `RunSummary.redrawn` names them for the CLI and the run notification. A successful redraw clears the
  drift by writing the new authored hash; a graph that fails writes no such record, so `requeueFailed` and its attempt
  budget handle the failure rather than requeuing it forever. The requeue happens at run time rather than at the graph
  write because undo excludes `state/`. Undoing the edit restores the authored hash, so the drift disappears before
  anything is redrawn. The contract is stated in [`pipeline-contracts.md`](pipeline-contracts.md).
- **A deliberate re-render marks nodes invalid instead of re-walking the graph.** With every node clean, a plain
  requeue would skip straight to the cached image. `PipelineControl.regenerate` on a bound slot, and `gengraph.run` with
  `force`, append an `invalidated` record for each spending ancestor of the target, so those nodes and everything below
  them run again while deterministic prep still resumes.

## Slots and outputs

- An output node binds a slot by naming it in its `slot` prop, in the vocabulary that `slotKey`, `slotLabel` and
  `parseSlot` share (`@vn/artgen/slotaddr`). `asset:<hash>` and a bare hex hash parse as asset bindings. A generator
  output cannot bind an immutable content address, so both forms are refused by name.
- A graph may contain several output nodes, each binding its own slot, so sibling tasks share one upstream graph.
  Same-slot outputs resolve to the one whose `active` flag is set; `gengraph.setActiveOutput` clears the flag on the
  other outputs bound to that slot, and the flag is document state, so it is undoable and appears in a diff. A graph
  whose outputs are all inactive is a legal state and falls back to the built-in runner.
- `activeOutputs(graph)` is the single definition of which outputs count, and `bindSlots` builds the slot-to-graph
  index from it. Three readers call it: the pipeline's `indexGraphs`, the desktop session and the CLI's report. A slot
  claimed by two active outputs in different graphs is left bound to no graph and is reported, because otherwise the
  graph that drew the picture would depend on load order.
- `gengraph.createForSlot` starts a graph that draws one slot, wired the way the pipeline draws it, and refuses a slot
  another graph already draws. The document tree's _Create a graph for this slot_ runs this command.

## Running a graph

- **The executor** (`executeGenGraph`, in `@vn/gengraph/state`) takes the graph and a target set by node key and
  evaluates only the targets' ancestors, in path.ux's Tarjan `sort()` order over the flattened graph, so the executor
  runs a group instance's inner nodes. A node whose journal record already matches its hash resumes from the record. A
  node hash covers what feeds a node rather than what it produces, so the executor tracks the nodes it ran and forces
  everything below them. That is why the resume rule is correct and not merely cheap. Every transition is journaled,
  intermediates are written as blobs, and a failing node writes a `failed` record and blocks only the branch below it;
  branches beside it still run. A target inside a cycle throws, because a cycle has no order to run in.
- **The runner wrapper** lives in `@vn/pipeline` (`graphrun.ts`). When a task's slot is bound, the runner seeds the
  Derived-prompt and Task-refs inputs from the task, executes the graph against the slot's active output, and writes the
  terminal picture through the same `deps.store.write` the unbound runners use, with the same metadata, so downstream
  code sees no difference between the two paths. `params` come from the graph's own image nodes rather than from the
  task, since the author added those nodes in order to choose them; the asset record still names the task's refs, because
  the manifest addresses assets and a graph reference may be a blob. `runBoundGraph` advances the binding's journal to
  the state the run produced, so a refine attempt resumes from the nodes the previous attempt already ran.
- **The refine loop wraps the graph run.** It applies to `shot_image` only, because reviewers judge against a
  `ShotSpec` and the other kinds have no loop today. The critic and `max_refine_attempts` stay host policy in the runner.
  The critique enters through a wired Refine-prompt node reaching the active output (`refinesThroughNode`). Otherwise the
  refiner modifies the derived prompt. Only the tail downstream of that entry point re-runs per attempt.
- The slot-to-graph index is built on load by scanning every graph's output bindings. The host session owns it, and the
  runner consults it. `vngen run` builds it through `buildGenDeps`; the desktop session builds it when the workspace
  opens; `@vn/testkit`'s `p.run({ graphs })` binds graphs for one run ([`../guides/testkit.md`](../guides/testkit.md)).
- **An interactive run**, `gengraph.run`, goes through the same executor and journal, and targets the active output or
  a named one. The confirmation quotes the estimate. It writes journal records and blobs but never an asset, because a
  picture enters the store only through the bound or scheduled path, so `adoptSlot` remains the one `done` record
  produced outside the scheduler. The agent's `run_asset_graph` performs the same run behind the same confirmation. A
  failed run's message names the node by key.

## Cost

- Each spec may declare an estimate, and a whole-graph estimate (`estimateGraph`) is the sum over a topological walk. A
  whole-graph estimate is possible here and impossible for the rest of `vngen cost`, because every edge is known up
  front. The refine wrap adds a bounded multiplier of `max_refine_attempts` over the tail downstream of the refine entry
  point, so the figure gives the worst case rather than the cost of a run that passes first time.
- `priceEstimate` turns expected calls into dollars against an ordered list of tables, and the first table that holds a
  unit price for the model supplies that price. `genPriceTables` builds the order: the author's own table (named
  `yours`), the table shipped with the app, then each installed plugin's fragment. A priced line names the table that
  supplied the price. A model that no table covers is reported as an unpriced line naming the model, and is never counted
  as free, so a total does not shrink as models are added.
- The shipped table (`prices.json`, with `pricesAsOf`) covers the models this repository configures by default rather
  than every model a project can name, because an unverified figure is worse than an unpriced line. `pricesAreStale`
  reports a table as stale after `PRICES_STALE_DAYS`, and `estimateSentence` produces the single sentence used by both
  the desktop confirmation and the agent's quote.
- Actual usage is recorded in the journal's `usage` field, in the units a table charges for, so an estimate can be
  audited against spend. The services report no usage of their own; the host's provider adapter supplies the run
  context's `usage` hook.
- `vngen cost` prices every bound slot the slot graph enumerates, whether or not it is planned, because pricing only
  planned pending tasks would reintroduce the incremental-planning undercount that the graph estimate corrects. A task a
  graph draws is still counted as pending but contributes no image or review calls, because the graph's own estimate
  prices it node by node and counting both would charge twice. Drifted tasks are counted under the pending line, so a
  redraw is quoted before it is paid for.

## The DSL and the agent

- `graphToDSL(graph)` returns the description an agent reads and writes. The description holds topology and authored
  values and no layout at all, so re-authoring a graph never moves the layout the author arranged. A prop equal to its
  type's default is left out. A group instance is one entry with `type: "GroupNode"` and `group: <ref>`, and that entry
  does not spell out what is inside the group or any override on it. Links are read from each input's authored edges
  rather than the resolved ones, so an agent never has to reproduce a group's proxy sockets.
- `applyGraphDSL(graph, description, groups?)` validates the description, builds a graph from it and diffs that graph
  against the live graph by node id. A surviving node keeps its position, size, label and journal history. A removed node
  is dropped. A new node is placed by a deterministic helper on a grid right of the existing bounds. A kept instance
  keeps its overrides if its ref is unchanged, and a new instance builds against the library the caller loaded, so a
  description can instance a definition the graph never held. The function returns diagnostics rather than throwing. JSON
  that does not parse yields a `bad-json` diagnostic and the live graph is handed straight back, and a proxy node at the
  root is refused. Whole-graph replacement is the only mutation this path offers, and the commands handle partial edits.
- The agent's three tools (`read_asset_graph`, `edit_asset_graph` and `run_asset_graph`) take the same decisions as the
  commands because they import `@vn/gengraph` rather than invoking the registry. The agent can round-trip a graph holding
  groups and add an instance of an existing definition. It cannot edit a definition. The tools are documented in
  [`vnauthor.md`](vnauthor.md#generation-graphs).

## The commands

Every write to a graph is made by a `gengraph.*` command, registered in `apps/desktop/src/main/commands/gengraph.ts` and
listed with its props in [`command-namespaces.md`](command-namespaces.md#gengraph). A command's `check` and its `run`
call the same `decide()` over the same document, so the palette shows the same message that a refused run would report.

| Group       | Commands                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Documents   | `list`, `create`, `createForSlot`, `delete`                                                               |
| Structure   | `addNode`, `duplicateNode`, `removeNode`, `link`, `unlink`, `moveNodes`                                   |
| Values      | `setProp`, `setActiveOutput`                                                                              |
| Whole graph | `apply`                                                                                                   |
| Groups      | `listGroups`, `createGroup`, `ungroup`, `addGroup`                                                        |
| Definitions | `expose`, `unexpose`, `reorderExposed`, `repointExposed`, `addBoundary`, `removeBoundary`                 |
| Runs        | `estimate`, `run`                                                                                         |

- **One decision function across three hosts.** Every mutation goes through `decideGenEdit`, which checks a `GenEdit`
  against one `Graph` and returns either an `apply` closure or a refusal sentence. The desktop commands, the pane's
  mid-gesture check and the agent's tool all call it, so a refusal reads the same in all three.
- **A `node` prop holds a key.** The value is resolved through `resolveNodeKey`, so `4/3` names node 3 inside instance 4.
  A value written that way overrides only that instance, and path.ux refuses a structural edit there with its own
  sentence.
- **A `group` prop redirects the edit to a definition.** When it is set on `addNode`, `duplicateNode`, `removeNode`,
  `link`, `unlink`, `setProp`, `moveNodes`, `createGroup`, `ungroup` or `addGroup`, the command reads `lib/<group>.json`
  instead of the slug's graph, validates the edit against the definition's subgraph, and writes the definition file.
  `slug` is still required and names the graph the author was looking at, for provenance. The six definition commands
  take `group` alone. `setActiveOutput` and `apply` do not declare it, so the registry refuses the unknown prop.
- **Three props carry richer values as text**, because `@vn/commands` has no JSON or list kind. `setProp` takes its
  value as text, and the node's own property defines how to read it (`readGenPropValue`), `apply` takes a whole DSL
  description, and `moveNodes` takes its list of positions the same way. `createGroup`'s `nodes` is a comma-separated
  string.
- **Each write reports every file it touched.** `written` lists the graph file. For `createGroup` it also lists the
  definition that command created, and that definition is written before the graph, so every definition the graph names
  is already on disk. `documents:wrote` stamps a version for each file.
- `setProp` and `moveNodes` declare `defersCommit`, since a drag sends one per frame and the whole run commits once
  ([`repos-and-commits.md`](repos-and-commits.md)). Each is still its own undo point.
- **`run` is the one confirm-gated command here.** It quotes the estimate and cannot be undone, because it writes a
  journal record and a blob under `state/`. `delete` also confirms, and leaves the journal and blobs in place, because
  they record runs that happened.

## Groups

A group is a definition file that several graphs instance. Selecting nodes and grouping them writes `lib/<ref>.json` and
leaves a `GroupNode` in their place. Entering the instance edits the file, and every graph that instances it follows. The
mechanics (definitions, instances, reconciliation, overrides, the grouping and exposure functions, the level stack) are
path.ux's and are documented in [`NodeEditor.md`](../../vendor/path.ux/documentation/NodeEditor.md#groups). The
application decides the following:

- **Main binds both the loader and the saver; the renderer binds only the loader.** `bindGroupLibrary` points a graph's
  `groupLoader` and `groupSaver` at `lib/`, and `readGraphDoc` runs `resolveGroups()` after every read, folding a failed
  reference into an `unresolved-group` diagnostic against the instance so a graph whose definition is missing still
  opens. A definition's subgraph binds the library too, so a definition that instances another definition resolves it.
  The renderer resolves definitions over the `gengraph:group` channel and never sets a saver, so every write goes through
  a command.
- Only a command writes a definition, through the `group` prop shown above. The exposure and boundary commands apply
  path.ux's own functions over the `GroupDef`, so they need no toolstack in main.
- **A ref is a slug allocated by main.** `gengraph.createGroup` takes an optional name and otherwise allocates
  `group-<n>` against the files in `lib/` (`nextGroupRef`), and the comparison is case-insensitive. The call refuses a
  name that is not a slug, and refuses a name already taken.
- **An output node cannot be grouped.** A slot's output binds the graph to the pipeline, so it belongs at the root.
  `validateGenGraph` walks the flattened order and reports `output-in-group` for an output found inside an instance or a
  definition.
- **Groups nest, but a definition may not contain itself.** `addGroup` and `createGroup` take `group` too, so an
  instance or a new group can be placed inside a definition. A definition may not contain itself, directly or through
  another group; the command checks the chain by ref, because two reads of one file produce two objects, which path.ux's
  identity check reports as different.
- **The other edits preserve an instance's ref and overrides.** `duplicateNode` clones through path.ux's `cloneNode`,
  so a copied instance keeps its ref and its overrides. `ungroup` inlines a copy of the instance's subgraph, overrides
  included, with the same wiring the instance had, and leaves the definition in place for the other instances. The
  agent's whole-graph rewrite keeps an instance under `group: <ref>`.
- **Editing a definition reloads every pane whose graph instances it.** `touchesGraph` takes the refs a graph instances
  (`instancedRefs`), so a `documents:wrote` naming a definition file matches each pane that draws an instance of it.

Four things are deliberately not built: the agent editing a definition (a definition-level DSL is a follow-on),
`gengraph.apply` with `group`, renaming or deleting a definition (an unused file is harmless, a delete is a file
operation the mtime check sees, and a rename would break every instance), and sharing definitions between projects.

## The Gen Graph pane

`apps/desktop/renderer/pathux/editors/nodes.ts`, editor #17. Task Graph shows whether a slot has been drawn; this pane
shows how it will be drawn. It claims a `graph` node primary and a `slot` row primary only while the slot is bound to a
graph (`ClaimNode.boundGraph`, stamped by main where the document tree is built). Task Graph takes such a row as a
secondary claim, so only one of the two handles a given click. The pane pins to `graphSlug`, and clicking a bound slot or
a picture a slot claims publishes `ui.graphSlug`, so a pane that is already open updates to match
([`document-tree.md`](document-tree.md)). [`desktop-app-editors-pipeline.md`](desktop-app-editors-pipeline.md#gen-graph)
describes how this pane fits among the other pipeline editors.

The pane hosts path.ux's `NodeGraphView` inside `appendSurface` and adopts `styles/gengraph.css` into the pane's own
shadow root. `readGraphFile` reads the graph over the `gengraph:doc` channel as the file's nstructjs JSON and parses it
back into a `Graph` instance, because the DSL carries topology and authored values but no layout, and each frame has to
be drawn where the author left it. A strip above the canvas shows diagnostics from the read and from the file itself.

- **Every mutating gesture becomes a `gengraph.*` command.** `renderer/rules/gengraph.ts` holds the "pure"
  (side-effect-free) half. It reads one of path.ux's gesture kinds as a `GenEdit` and names the command that writes it,
  and it refuses by name the one kind this application has no command for (retyping a node in place), since a node's
  identity is what its journal is keyed by. The delegate's `check` runs `decideGenEdit` locally rather than `stack.check`
  over IPC, because path.ux's check is synchronous and runs once per frame per pointer move while `command:check` is an
  async round trip. Both sides run the same decision function, so the mid-gesture verdict matches the verdict on commit.
  A refused gesture is reported, except a refused drag, which path.ux already shows by fading the frame it would not
  move.
  - An edit is applied to the pane's own copy of the graph before it is sent, so the author sees it at once and the
    pane never re-reads the file for its own write. `createGroup`, `ungroup` and `addGroup` are the three exceptions,
    because main allocates a group's ref and an instance is unresolved until its definition is loaded. These three edits
    are sent first and are shown when the acknowledgement reloads the graph, and the reload selects the node the
    acknowledgement named.
- **The pane hosts path.ux's levels, and main is never told which level the view is on.** The view shows the root
  graph, a group's definition, or the inside of one instance, and a breadcrumb strip names the current level. `targetFor`
  reads the view's descent and builds the `EditTarget` that an edit is addressed by. An `EditTarget` holds the definition
  file a definition level writes to (the `group` prop every editing command takes) and the instance-id prefix that keys a
  node inside an instance, so a node on screen is named to main as `<instance>/<id>`. A definition's ids are its own, so
  a definition level has an empty prefix.
  - Ctrl+G groups the selection and Ctrl+Alt+G inlines the selected instances; Tab enters the one selected group's
    definition or leaves the level; a double-click on an instance's title enters it too. The keymap is built from
    `view.hotkeys()`, so it cannot drift from path.ux's example app, and the header's Group and Ungroup buttons go
    through `act()` and use the refusal for the current selection as their disabled tooltip. The Edit menu's four group
    entries (Create Group, Ungroup, Edit Group and Exit Group) reach the same methods on the active pane
    ([`desktop-app-shell.md`](desktop-app-shell.md#the-shell)).
  - At a definition level a designer is shown next to the canvas, listing the definition's boundary sockets and the
    rows it forwards. Each edit to those issues a `gengraph.expose`, `unexpose`, `reorderExposed`, `repointExposed`,
    `addBoundary` or `removeBoundary` with `group` set. Inside an instance, `decideGenEdit` refuses structural edits, and
    a value edit writes an override through `gengraph.setProp` on the keyed node.
  - The renderer resolves definitions through a `groupLoader` over the `gengraph:group` channel, and the pane awaits
    `resolveGroups()` after every parse so the view has definitions to enter and forwarded rows to draw. The loader first
    waits for the pane's own outstanding writes. The view's save-and-resolve pass runs while a definition edit is still
    unacknowledged, and a load at that point would return the old file.
  - One struct field, `descentJson`, persists the level across a restart, holding the descent and the slug it was saved
    in. A read of that slug applies the saved descent, and a read of another slug drops it.
- **Delete and duplicate open a checkpoint**
  ([`command-system.md`](command-system.md#checkpoints-group-several-commands-into-one-undo-point)), so a multi-node
  selection lands as one undo point instead of one per node. The delegate's `undoStepBegin`/`undoStepEnd` open and close
  that checkpoint, and `vendor/path.ux` widens both to a real `Promise<void>` that takes the gesture's label and message.
  `send` tags its `exec` calls onto the open handle. A refused open dispatches nothing, because path.ux's `AsyncGateOp`
  skips the gesture's callback when the bracketing hook throws. A refused close can follow edits already applied
  optimistically to the graph on screen, so it forces a reload the same way a refused write does.
- **Node properties are bound through a data API scoped to this pane.** `defineGraphApi` builds a `DataAPI` rooted on
  one member (the graph on screen), and the editor installs it through `ctx.override({api})` at `init`, one per instance,
  because two panes may be open on different slugs and one member cannot represent both. The app-wide API in
  `renderer/pathux/app/api.ts` is unchanged and still defines nothing for graphs. With the view pointed at `graph`,
  path.ux's `NodeFrame` builds the prop rows itself, and an unconnected input's editor sits on the socket's own row;
  connecting the socket removes that editor.
  - Every bound write arrives on a `change` listener registered per property, is judged by `decideGenEdit`, and is sent
    as the command that writes it. A refused write is put back through the same API rather than prevented, because
    `change` only notifies and cannot cancel the write. Each listener belongs to the level that draws the row. A group
    instance's frame draws the rows its definition forwards, which bind an inner node of the instance's own copy, so
    those rows are listened to under the instance's key and a write to one produces the override described above.
  - `active` on an output is edited through a checkbox: ticking it sends `gengraph.setActiveOutput`, which deactivates
    the other outputs claiming the same slot, and unticking it sends a plain `gengraph.setProp active=false`. The strip
    above the canvas shows when a graph whose outputs are all inactive falls back to the built-in runner.
  - Every bound property is declared `PropFlags.NO_UNDO`, so path.ux's own datapath undo does not record a write that
    the app's undo stack already holds. Each property also carries a `uiname` and a `description`, so each row is
    labelled and tooltipped from the declaration. `readGraphFile` restamps `NO_UNDO`, `uiname`, and `description` after a
    read, because nstructjs serializes a property whole and a file written before those fields existed loads with them
    empty.
- **A pane does not reload on its own write, and uses version numbers to recognise the writes of other panes.** A
  write's "echo" (the `documents:wrote` event) names the paths it touched and the version each now carries, and `exec`'s
  answer names the versions this pane's own write produced. `DocSync` in `rules/gengraph.ts` keeps both per document
  path, for the graph's own file and for the definition file of every group the graph instances, which is known after
  `resolveGroups`. `shouldReload` decides whether an echo reports a change the pane has not already applied. It returns
  false while any write of this pane's is outstanding, because the pane's copy is ahead of whatever main can report, and
  the write that settles the last of them asks again. It returns true after a refusal, because the pane holds an edit the
  file never took. It returns true for an echo that names no version, because an undo restores files no command declared.
  Otherwise it returns true only for a version past the pane's own. A second pane open on the same graph therefore
  reloads on the first pane's writes, because those versions are not its own.
- **An edit to the graph changes what it draws.** A gesture that changes the authored graph costs nothing when it is
  made. The next `pipeline.run` puts the bound slot's task back to `pending` and draws it again, so a picture can change
  without the author asking for it, and the run's notification reports how many were redrawn for an edited graph. The
  task's hash does not move, because the graph runs the slot rather than forming part of what the slot is. Undoing the
  edit before the next run leaves nothing to redraw, since the journal that the comparison reads sits under `state/`,
  which undo excludes.
- Four plans measured and cut the cost of an edit, and are tracked in
  [`../plans/gengraph-editing-cost-tasklist.md`](../plans/gengraph-editing-cost-tasklist.md): the batched commit, the
  scoped data API, the per-document versions described above, and precise write signals.
- **Theme.** The app's theme overrides path.ux's group keys (`GroupAccent`, `GroupHeaderBG`, `ProxyHeaderBG`) and the
  view's breadcrumb and level keys (`CrumbBG`, `CrumbFont`, `CrumbActiveFont`, `LevelDefinitionColor`,
  `LevelInstanceColor`) in the app's own palette. The overrides live in renderer/pathux/app/theme.ts.

## The CLI

`vngen` requires no new subcommand to run graphs. Three verbs accept graphs ([`../guides/cli.md`](../guides/cli.md)):

- `vngen run` loads the project's graphs, indexes them by bound slot, and runs a bound slot's task through its graph. A
  graph that will not load (or a slot claimed by two active outputs) is printed rather than treated as fatal. The run
  summary counts the tasks put back to `pending` for drift separately from the ones retried.
- `vngen status` prints the graph count, how many slots are bound, any doubly-claimed slot, and each drifted output as
  `drifted: <slug> node <key> (<slot>)`. It also prints that the next run redraws each drifted output.
- `vngen cost` prices the bound slots as described under Cost.

`apps/cli` may import neither `@vn/gengraph` nor `@vn/artgen`, so everything both hosts do with a
project's graphs lives in `@vn/pipeline`'s `graphload.ts`: `readProjectGraphs` (which takes the
reader as a parameter, because the desktop reads a graph through git and the CLI reads the file),
`graphRuntime`, `reportGraphs`, `unrenderedBoundSlots` and `priceSlots`.

## Plugins

A plugin is a directory holding `plugin.json` and TypeScript sources. It adds node types in the same three ways a
built-in node type is split.

- **The manifest** declares `name` (a slug that is also the directory name under the plugins root), `version`,
  `apiVersion`, a one-line `description`, `nodeTypes`, the `services` its runtimes call, the `keys` it resolves, an
  `entry` module, an optional `prices` fragment, and `priceAgent`. The installer checks `apiVersion` against
  `GEN_PLUGIN_API_VERSION`, so a mismatch is refused before the first run of a node. Registering a type outside
  `nodeTypes` is refused. The install confirmation names the `services` and the `keys`. The `prices` fragment is
  consulted last.
- **Install asks for an explicit confirmation and installs per-user.** `plugin.install` reads the manifest and confirms
  the sentence it declares, naming the services and key names, then copies the directory under
  `<userConfigDir>/plugins/<name>/` and activates it. An installed plugin runs with the application's own permissions;
  sandboxing would require a later change to the harness. Plugins install per-user rather than per-project because the
  person at the machine confirms the install, and a cloned repo must not arrive pre-confirmed. Opening the project
  elsewhere reports the unknown-node diagnostic naming the plugin, and never substitutes a node silently. `plugin.list`,
  `plugin.remove` and `plugin.prices` are the other three commands; none touches the workspace and none is undoable.
- **The API is passed in as a value.** A plugin imports `@vn/gengraph/plugin` for types only. `GenPluginApi` (the
  `Node` class, the three socket classes, the property classes, `registerNode`, `registerRuntime`, `registerPriceAgent`)
  is the argument to the plugin's `activate` function. A bundle that resolved the module at load time would carry a
  second registry and register its types into that registry, which the host never reads, so `buildGenPlugin` refuses a
  bundle whose text still names the specifier.
- **The bundle is CommonJS, built by native esbuild.** Both hosts that load a plugin are CommonJS (the desktop main
  bundle and jest). `@vn/gengraph` declares the `GenEsbuild` shape it needs and takes a bundler from its caller, so the
  package carries no build tool. The desktop ships the native binary (unpacked from the asar with `ESBUILD_BINARY_PATH`
  set when packaged) and `pnpm smoke` runs a transform in the built binary. `esbuild-wasm` was measured and rejected
  because its Node API spawns `node bin/esbuild`, which a packaged app cannot assume is on `PATH`.
- **Keys and requests use the ordinary mechanisms.** A plugin's keys resolve through the four-place `resolveKeys` chain
  and are set by `project.setKey`, and its model calls go through the provider ring like every other request. The agent's
  raw file writers (`write_file`, `edit_file`) refuse the plugins root outright. That check compares the absolute path
  and runs before the workspace check, so the refusal applies.
- **Prices.** A plugin whose vendor publishes no pricing API may declare `priceAgent`. On `plugin.prices` the plugin
  fetches the vendor's published page through `services.fetch` and reads it with `services.text`, using the author's own
  key. It fetches at no other time. If the page cannot be read, the plugin refuses instead of falling back on a
  model-supplied price. The fetched price is folded into the author's table.
- The first plugin is Gemini, at the repo-root `plugins/gemini/`. It is a directory rather than a package because a
  plugin is installed by copying and imports a subpath that the boundaries rule forbids under `packages/`. Its
  `GeminiImage` and `GeminiEditImage` types register beside the built-in image nodes rather than replacing them, so a
  graph reaches the vendor directly only once the author installs the plugin and uses those types. The built-in image
  node still runs through the host's image backend, which a project with no plugins depends on. The fixture plugin the
  loader's tests use lives in `packages/testkit/src/plugin/`.

## Deliberately not built

- Sandboxes plugins.
- Covers editor-side active-output mechanics beyond the checkbox.
- Retiring the legacy non-graph runner path and removing `createGeminiImage` from `packages/providers/src/factory.ts`.
- Automatic price refresh on a schedule.
- Deferring the graph file write is unsafe. With an in-memory accumulator in main, a pipeline run would hash a stale
  file to the old content address and return a dedupe hit, and no error would be raised.
- A general data API for the application is excluded. The pane's scoped `DataAPI` is the one exception, and covers a
  single editor over data that path.ux already describes.
- The group cuts listed above.

## History

- [`../research/node-based-asset-generation.md`](../research/node-based-asset-generation.md) — the research that
  settled the nine decisions.
- [`../plans/node-based-asset-generation.md`](../plans/node-based-asset-generation.md) covers the twelve stages that
  built the package, the runner, the commands, the tools, the pane and plugins, and records the as-built deviations of
  each stage.
- [`../plans/archive/group-nodes-in-the-gen-graph-editor.md`](../plans/archive/group-nodes-in-the-gen-graph-editor.md)
  covers the desktop half of groups, and
  [`group-node-authoring.md`](../../vendor/path.ux/documentation/plans/group-node-authoring.md) covers the path.ux half.
- [`../plans/gengraph-editing-cost-tasklist.md`](../plans/gengraph-editing-cost-tasklist.md) and
  the four plans it tracks.
- [`../plans/archive/gengraph-node-editor-data-api.md`](../plans/archive/gengraph-node-editor-data-api.md)
  and its pressure test,
  [`../research/pressure-test-gengraph-node-editor-data-api.md`](../research/pressure-test-gengraph-node-editor-data-api.md).

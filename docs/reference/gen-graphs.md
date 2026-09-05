# Generation graphs

A generation graph is the node network a slot's picture is drawn by. It is an authored document
an author opts into per slot, edited in the desktop app's Gen Graph pane or rewritten whole by the
authoring agent, and run by the pipeline in place of the fixed runner a slot would otherwise use.
This page is the as-shipped description of the whole feature: the package, the node types, how a
node is identified and journaled, how a run works, what it costs, the commands, groups, the pane,
the CLI and plugins.

The graph model itself is path.ux's: the `Graph`, `Node` and socket classes, the group machinery,
the DSL and the `NodeGraphView` widget are documented in
[`../../vendor/path.ux/documentation/NodeEditor.md`](../../vendor/path.ux/documentation/NodeEditor.md).
This page covers what the application adds on top. The design was settled in
[`../research/node-based-asset-generation.md`](../research/node-based-asset-generation.md) and
built by two plans, [`../plans/node-based-asset-generation.md`](../plans/node-based-asset-generation.md)
and [`../plans/archive/group-nodes-in-the-gen-graph-editor.md`](../plans/archive/group-nodes-in-the-gen-graph-editor.md),
which keep the stage-by-stage record of what was built and what deviated from the plan.

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

- **A bound graph is the slot's runner.** A task keeps the identity it has always had,
  `hashParts(kind, inputs)` over the derived prompt, the references and the params. Binding a
  graph to the task's slot changes how the picture is made, never what the task is, so a graph
  edit moves no task hash. The difference shows as drift instead (below), and the next run puts
  the drifted slot's task back to `pending` rather than giving it a new identity. A slot no graph
  claims runs exactly the code it ran before graphs existed.
- **The path.ux graph is the model.** Main holds real `Graph` objects. A file is nstructjs JSON,
  checked by nstructjs's `validateJSON` on load, with the semantic pass (props against the
  registered spec, socket compatibility, the slot an output names) in `@vn/gengraph`.
- **Names.** The package is `@vn/gengraph`, the commands are `gengraph.*`, the pane is titled Gen
  Graph, and a graph is addressed by its slug, the file name under `work/graphs/`. A slug matches
  `[a-z0-9][a-z0-9-]*`, compared case-insensitively because the filesystem may.
- **One journal serves scheduled and interactive runs.** `vngen run`, `pipeline.run` in the app,
  and `gengraph.run` all execute through the same executor and append to the same journal, so a
  node that ran once resumes everywhere.

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
- Intermediates are repo-saved but never assets. A blob has no `AssetKind` and enters neither
  asset root. Only the picture the active output terminates on enters the asset store, and only on
  the bound path.
- A graph document and a group definition are read and written by `@vn/gengraph/state`
  (`readGraphDoc`, `writeGraphDoc`, `readGroupDef`, `writeGroupDef`, `readGroupLibrary`), because
  the authoring agent loads the same files and cannot import the desktop app. The desktop's
  `main/graphs.ts` adds the git half, refusing a conflicted graph, and the summary the document tree
  lists graphs by. A read answers diagnostics rather than throwing, and a parse is held in main
  behind an mtime-and-size check on the graph file and on every definition file it resolved.

## The package

`@vn/gengraph` is a constrained leaf beside `@vn/artgen`. It may import `types`, `util`,
`config`, `model`, `store`, `taskgraph` and `artgen` (for the slot vocabulary at
`@vn/artgen/slotaddr`) and deliberately not `providers`, `pipeline` or `scheduler`; every model
call goes through the `GenServices` interface the package declares. Three consumers list it:
`pipeline` (the graph runner), `authoring` (the agent tools' rules) and `desktop`. The layering
rules are in [`packages.md`](packages.md) and the module list in
[`module-map.md`](module-map.md#vngengraph--generation-graphs-packagesgengraph).

- **It reaches path.ux through two aliases of its own.** `pathux-graph` is the graph module and
  `pathux-toolprop` the `ToolProperty` classes a spec declares props with. Both resolve to source
  where code runs and to declarations where it is only checked, and `nstructjs` is pinned to the
  `vendor/nstructjs` submodule on every surface, because two copies of nstructjs in one process
  are two STRUCT registries and every graph load fails. The wiring is recorded in
  [`../guides/toolchain.md`](../guides/toolchain.md).
- **Four entries.** The barrel reaches no `fs` and no DOM, so the renderer imports it. Everything
  that touches the project tree is `@vn/gengraph/state`: the paths, `nodeHash` and `graphHashes`,
  the journal's file half, the blob store, `graphDrift`, the executor (which hashes through
  `@vn/util` and so reaches `node:crypto`), the documents and the group library, and plugin
  installation. `@vn/gengraph/plugin` is the versioned surface a plugin is written against, and
  `@vn/gengraph/migrate` is the JSON migration the reader runs first.
- **Validation is at the boundary.** `validateGenGraph` runs after `readJSON`: props match the
  registered spec, links join compatible sockets, every output node's slot parses under
  `parseSlot` and is not an `asset` binding, an unknown node type is reported by name (a plugin
  not installed here), and an output node inside a group is reported as `output-in-group`. An
  unbound graph, with no output or an output naming no slot, is legal.

## Node types

A node type has up to three parts. The class and spec are shared by every host: a path.ux `Node`
subclass whose `graphDef()` declares sockets and `ToolProperty` props, plus a `GenNodeSpec`
carrying what the generator needs to know. A runtime, `run(inputs, props, services)`, is
registered by type name only in a host that can supply services (`registerGenRuntimes`). A
`customPropUX` entry on the definition draws one prop differently, which is how a model prop
becomes a dropdown over the priced models.

`GenNodeSpec` fields:

- `spends` marks a type whose run calls a paid model. Only spending nodes are invalidated by a
  forced re-run, and a scratch branch of them never fires unless a target descends from it.
- `slotProp` names the prop holding the slot the node fills. Only an output node has one.
- `estimate(props, {connected})` answers what one run is expected to spend, before anything has
  run, in `image`, `mtok-in` or `mtok-out` units. A type with no estimate is taken to spend nothing.
- `seededInput` names the input socket a host fills before a run. Its value belongs to the task
  rather than to the graph, so `authoredHashes` reads it as though nothing had been seeded.
- `refineInput` names the socket a refine pass re-enters at; `refineFallback` marks the node the
  pass falls back to while nothing is wired to a refine input.
- `migrations` lists every rename the type has been through. `registerGenNode` refuses one whose
  targets name nothing on the class or whose last step stops short of the declared `typeVersion`.
  The contract is in [`pipeline-contracts.md`](pipeline-contracts.md), under renaming a socket or
  prop.

Three socket types are declared beside the nodes, because path.ux ships float and vec3 and both
describe geometry. `TextSocket` carries a string. `ImageSocket` carries a `GenImageRef`, which
names the store holding the bytes as well as the hash, so a node reading an asset does not copy it
into the blob store first. `RefsSocket` carries a list of them, and an image output feeds a refs
input as a one-item list through path.ux's coercion.

The twelve built-in types, registered by `registerGenNodes`:

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

- The three host-seeded nodes take their value on an input socket rather than in a prop. That is
  what lets `graphHashes` read a seeded value through the socket's default with no special case,
  and keeps the seeded prompt out of the document's authored state. `seedInputs` refuses to seed an
  input the type does not declare, so a fourth seeded type cannot quietly count task state as
  authored.
- The image nodes hold their seed as a string where empty means unauthored, because a
  `FloatProperty` always carries a value and zero is a valid seed; a seed that does not read as a
  number refuses rather than being dropped. `GenRewrite`'s estimate uses nominal token counts,
  since an estimate runs before any input has a value. Blend is deliberately absent from the
  Switch/Blend pair: nothing in the repository composites two pictures.
- The Derived-prompt node reproduces byte for byte what the fixed runner composes for a slot, which
  is the property the first bullet of this page rests on. The scheduled runner seeds it from the
  task; `gengraph.run` has the session compute it from the bound slot through the existing
  `build*Chunks` derivation, because the derivation needs the project model, which `GenServices`
  deliberately does not carry.
- `defaultSlotGraph(slot)` is the graph an author gets when they ask for one rather than wiring
  it: Derived prompt and Task refs feeding Generate image, whose picture fills the slot. Every host
  builds the same four nodes, so a graph created from the document tree, the CLI or the agent runs
  the way the pipeline's own path does.

### `GenServices`

Everything a node runtime may reach outside its own inputs and props, supplied by the host so the
same type runs against real providers in the app and against mocks in a test:

- `image.generate(prompt, refs, params)` and `image.edit(base, prompt, refs, params)`, taking
  reference pictures as bytes because a node's references come from the blob store its upstream
  wrote to. The image service is the byte-level `ImageBackend` seam, which is what lets a graph
  and a task runner draw the same picture from the same prompt and refs.
- `text.complete(modelId, prompt, system?)` and `text.structured(...)`. The host's text service
  answers every call with the project's one configured text provider; the model a node names is
  recorded rather than routed.
- `blobs.read(hash)` / `blobs.write(bytes, ext)`, kept per graph slug, which is why a services
  object lives on each loaded graph rather than on the runtime.
- `assets.read(ref)` and `assets.slot(slotKey)`, the asset-store read the Slot-ref and Image-file
  nodes use.
- `fetch(url, init?)`, routed through the provider request ring so a fault can be read against the
  body that caused it.
- `key(name)`, the value of a declared key through the ordinary `resolveKeys` chain, or undefined.

The derived prompt is deliberately absent; the host seeds it as an input value. `@vn/pipeline`'s
`createGenServices` builds the real implementation from the project's providers, asset store and
keys, shared by the CLI scheduler and the desktop session; the testkit passes a mock.

## Identity, the journal and drift

- **A node's hash is its content address.** `nodeHash` is `hashParts` over the type name with its
  version, the authored props, and whatever feeds each input: a connected input contributes the
  hash of the node feeding it together with the socket it came from, so dirtiness propagates by
  construction; a picture contributes its content hash rather than its bytes; an unconnected input
  contributes its own default value, which is where a host's seeded prompt reaches the hash. Id,
  label and position are absent, so moving a node cannot re-run it. Nodes inside a cycle are absent
  from the result, because a hash there would have to contain itself.
- **Two hashes per node.** `graphHashes` moves with the task a run was made for, which is what
  makes a task whose art notes changed redraw rather than resume the cached picture, and what makes
  a refine attempt's new critique re-run the tail. `authoredHashes` reads each host-seeded input as
  though nothing had been seeded onto it, so it covers the authored graph alone. Drift is measured
  on the second.
- **A node inside a group is keyed by its id chain.** Every graph's id counter starts at zero, so a
  node inside a group instance shares its id with some root node as the normal case. `nodeKey`
  names a node by the chain from the root, `3/7` for node 7 inside instance 3, and a root node's
  key is its id, so a graph with no groups reads exactly as before. The hashes, the journal, the
  executor's target set, its result lists and the cost walk are all keyed this way, and
  `resolveNodeKey` walks a key back to the node. A DSL id containing `/` is refused, so a key can
  never be mistaken for an id. An input reaching an instance's boundary default through the group's
  proxy contributes that default to the hash, as an unconnected input does, so two instances
  differing only there hash apart.
- **The journal is append-only full snapshots.** Each line of `state/graphs/<slug>.jsonl` is one
  node's whole state, `{v, nodeId, nodeHash, authoredHash?, status, output?, usage?, error?, at}`,
  with `v` on every line because git union-merges the file across clones. `status` is `running`,
  `done`, `failed` or `invalidated`. Replay is last-writer-wins per node, the way `state/tasks.jsonl`
  is replayed, and a line that does not parse (a crash mid-append) is counted and skipped rather
  than thrown on. A record written before `authoredHash` existed reports no drift.
- **Drift is reported per output node and acted on at run time.** `graphDrift` recomputes each
  active output's authored hash and compares it against the journal's last `done` record for that
  node. `requeueDrifted` in `@vn/scheduler` puts every planned `done` or `needs_human` task whose
  bound graph has drifted back to `pending`, once per run and before the wave loop, and
  `RunSummary.redrawn` names them for the CLI and the run notification. A successful redraw clears
  the drift by writing the new authored hash; a graph that fails writes no such record, so a failure
  is left to `requeueFailed` and its attempt budget rather than requeued forever. The requeue is at
  run time rather than at the graph write because undo excludes `state/`: undoing the edit restores
  the authored hash and the drift disappears before anything is redrawn. The contract is stated in
  [`pipeline-contracts.md`](pipeline-contracts.md).
- **A deliberate re-render is an invalidation, not a re-walk.** With every node clean, a plain
  requeue would skip straight to the cached image. `PipelineControl.regenerate` on a bound slot,
  and `gengraph.run` with `force`, append an `invalidated` record for each spending ancestor of the
  target, so those nodes and everything below them run again while deterministic prep still
  resumes.

## Slots and outputs

- An output node binds a slot by naming it in its `slot` prop, in the vocabulary `slotKey`,
  `slotLabel` and `parseSlot` share (`@vn/artgen/slotaddr`). `asset:<hash>` and a bare hex hash
  parse as asset bindings, and an immutable content address is nothing a generator output can
  bind, so they are refused by name.
- A graph may carry several output nodes, each binding its own slot, so sibling tasks share one
  trunk. Same-slot outputs resolve to the one whose `active` flag is set; `gengraph.setActiveOutput`
  stands the rivals down, and the flag is document state, so it is undoable and shows in a diff. A
  graph whose outputs are all inactive is a legal state and falls back to the built-in runner.
- `activeOutputs(graph)` is the one rule that says which outputs count, and `bindSlots` builds the
  slot-to-graph index from it. Three readers call it: the pipeline's `indexGraphs`, the desktop
  session and the CLI's report. A slot two active outputs claim, across graphs, is left bound to no
  graph and reported, because which graph drew the picture would otherwise depend on load order.
- `gengraph.createForSlot` starts a graph that draws one slot, wired the way the pipeline draws it,
  and refuses a slot another graph already draws. It is what the document tree's _Create a graph
  for this slot_ runs.

## Running a graph

- **The executor** (`executeGenGraph`, in `@vn/gengraph/state`) takes the graph and a target set
  by node key and evaluates only the targets' ancestors, in path.ux's Tarjan `sort()` order over
  the flattened graph, so a group instance runs as its inner nodes. A node whose journal record
  already matches its hash resumes from the record. A node hash covers what feeds a node rather
  than what it produced, so the executor tracks the nodes it ran and forces everything below them,
  which is what makes the resume rule correct rather than merely cheap. Every transition is
  journaled, intermediates land as blobs, and a failing node writes a `failed` record and blocks
  only the branch below it; branches beside it still run. A target inside a cycle throws, because
  a cycle has no order to run in.
- **The runner wrapper** lives in `@vn/pipeline` (`graphrun.ts`). When a task's slot is bound, the
  runner seeds the Derived-prompt and Task-refs inputs from the task, executes the graph against
  the slot's active output, and writes the terminal picture through the same `deps.store.write` the
  unbound runners use, with the same metadata, so nothing downstream can tell which path drew it.
  `params` come from the graph's own image nodes rather than from the task, since choosing them is
  what the author put the node there for; the asset record still names the task's refs, because the
  manifest addresses assets and a graph reference may be a blob. `runBoundGraph` advances the
  binding's journal to what the run left behind, so a refine attempt resumes the nodes the attempt
  before it already ran.
- **The refine loop wraps the graph run**, for `shot_image` only, because reviewers judge against a
  `ShotSpec` and the other kinds have no loop today. The critic and `max_refine_attempts` stay host
  policy in the runner. The critique enters through a wired Refine-prompt node reaching the active
  output (`refinesThroughNode`), or else the refiner modifies the derived prompt, and only the tail
  downstream of that entry point re-runs per attempt.
- **The slot-to-graph index** is built on load by scanning every graph's output bindings, owned by
  the host session, and consulted by the runner. `vngen run` builds it through `buildGenDeps`;
  the desktop session builds it when the workspace opens; `@vn/testkit`'s `p.run({ graphs })` binds
  graphs for one run ([`../guides/testkit.md`](../guides/testkit.md)).
- **An interactive run**, `gengraph.run`, goes through the same executor and journal, targeting
  the active output or a named one, and is confirmed quoting the estimate. It writes journal
  records and blobs but never an asset: a picture enters the store only through the bound or
  scheduled path, which keeps `adoptSlot` the one `done` record produced outside the scheduler. The
  agent's `run_asset_graph` is the same run behind the same confirmation. A failed run's message
  names the node by key.

## Cost

- Each spec may declare an estimate, and a whole-graph estimate (`estimateGraph`) is the sum over a
  topological walk. That is possible here and impossible for the rest of `vngen cost`, because every
  edge is known up front. The refine wrap adds a bounded multiplier of `max_refine_attempts` over
  the tail downstream of the refine entry point, so the figure is the worst case rather than a run
  that passes first time.
- `priceEstimate` turns expected calls into dollars against an ordered list of tables, the first
  holding the model's unit winning. `genPriceTables` puts them in order: the author's own table
  (named `yours`), the table shipped with the app, then each installed plugin's fragment. A priced
  line names the table that answered. A model no table covers is reported as an unpriced line
  naming the model, never counted as free, which is what keeps a total from quietly shrinking as
  models are added.
- The shipped table (`prices.json`, with `pricesAsOf`) covers the models this repository configures
  by default and not every model a project can name, because a figure nobody has checked is worse
  than an unpriced line. `pricesAreStale` calls a table out after `PRICES_STALE_DAYS`, and
  `estimateSentence` is the one sentence both the desktop confirmation and the agent's quote use.
- Actual usage lands in the journal's `usage` field, in the units a table charges for, so an
  estimate can be audited against spend. The services report no usage of their own; the host's
  provider adapter answers the run context's `usage` hook.
- `vngen cost` prices every bound slot the slot graph enumerates, planned or not, since pricing
  only planned pending tasks would re-import the incremental-planning undercount the graph estimate
  exists to fix. A task a graph draws is still counted as pending but contributes no image or review
  calls, because the graph's own estimate prices it node by node and counting both would charge
  twice. Drifted tasks are counted under the pending line, so a redraw is quoted before it is paid
  for.

## The DSL and the agent

- `graphToDSL(graph)` is the description an agent reads and writes. It carries topology and
  authored values and no layout at all, so re-authoring a graph never moves what the author
  arranged. A prop equal to its type's default is left out. A group instance is one entry with
  `type: "GroupNode"` and `group: <ref>`; what is inside the group, and any override on it, is the
  group's own business. Links are read from each input's authored edges rather than the resolved
  ones, so a group's proxy sockets are never something an agent has to reproduce.
- `applyGraphDSL(graph, description, groups?)` validates, builds and diffs against the live graph by
  node id: a surviving node keeps its position, size, label and its journal history; a removed
  node goes; a new node is placed by a deterministic helper (a grid right of the existing bounds).
  A kept instance keeps its overrides when its ref is unchanged, and a new instance builds against
  the library the caller loaded, so a description can instance a definition the graph never held.
  Diagnostics come back rather than throwing, JSON that does not parse is a `bad-json` diagnostic
  with the live graph handed straight back, and a proxy node at the root is refused. Whole-graph
  replacement is the only mutation this path offers; partial edits are the commands' job.
- The agent's three tools, `read_asset_graph`, `edit_asset_graph` and `run_asset_graph`, share
  their decisions with the commands by importing `@vn/gengraph` rather than by invoking the
  registry. The agent can round-trip a graph holding groups and add an instance of an existing
  definition; it cannot edit a definition. The tools are written up in
  [`vnauthor.md`](vnauthor.md#generation-graphs).

## The commands

Every write to a graph is a `gengraph.*` command, registered in
`apps/desktop/src/main/commands/gengraph.ts` and listed with its props in
[`command-namespaces.md`](command-namespaces.md#gengraph). A command's `check` and its `run`
call the same `decide()` over the same document, so the sentence the palette shows is the sentence
the run would refuse with.

| Group       | Commands                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Documents   | `list`, `create`, `createForSlot`, `delete`                                                               |
| Structure   | `addNode`, `duplicateNode`, `removeNode`, `link`, `unlink`, `moveNodes`                                   |
| Values      | `setProp`, `setActiveOutput`                                                                              |
| Whole graph | `apply`                                                                                                   |
| Groups      | `listGroups`, `createGroup`, `ungroup`, `addGroup`                                                        |
| Definitions | `expose`, `unexpose`, `reorderExposed`, `repointExposed`, `addBoundary`, `removeBoundary`                 |
| Runs        | `estimate`, `run`                                                                                         |

- **One decision function, three hosts.** Every mutation goes through `decideGenEdit`, which
  judges a `GenEdit` against one `Graph` and answers an `apply` closure or a refusal sentence. The
  desktop commands, the pane's mid-gesture check and the agent's tool all run it, so a refusal reads
  identically everywhere.
- **A `node` prop is a key.** It is resolved through `resolveNodeKey`, so `4/3` names node 3
  inside instance 4. A value written that way is an override on that instance alone; a structural
  edit there is refused with path.ux's own sentence.
- **A `group` prop redirects the edit to a definition.** Set on `addNode`, `duplicateNode`,
  `removeNode`, `link`, `unlink`, `setProp`, `moveNodes`, `createGroup`, `ungroup` and `addGroup`,
  the command reads `lib/<group>.json` instead of the slug's graph, judges the edit against the
  definition's subgraph, and writes the definition file. `slug` is still required and names the
  graph the author was looking at, for provenance. The six definition commands take `group` alone.
  `setActiveOutput` and `apply` do not declare it, so the registry refuses the unknown prop.
- **Three props carry richer values as text**, because `@vn/commands` has no JSON or list kind.
  `setProp` takes its value as text and lets the node's own property decide how to read it
  (`readGenPropValue`), `apply` takes a whole DSL description, and `moveNodes` takes its list of
  positions the same way. `createGroup`'s `nodes` is a comma-separated string.
- **A write names every file it touched.** `written` lists the graph file, and for `createGroup`
  the definition it made as well, written before the graph so the graph never names a definition
  that is not on disk. `documents:wrote` stamps a version for each.
- **`setProp` and `moveNodes` declare `defersCommit`**, since a drag sends one per frame, and a run
  of them commits once ([`repos-and-commits.md`](repos-and-commits.md)). Each is still its own undo
  point.
- **`run` is the one confirm-gated command here.** It quotes the estimate and is not undoable,
  because what it writes is a journal record and a blob under `state/`. `delete` confirms too, and
  leaves the journal and blobs where they are, because they record runs that happened.

## Groups

A group is a definition file several graphs instance. Selecting nodes and grouping them writes
`lib/<ref>.json` and leaves a `GroupNode` in their place; entering the instance edits the file,
and every graph that instances it follows. The mechanics (definitions, instances, reconciliation,
overrides, the grouping and exposure functions, the level stack) are path.ux's and are documented
in [`NodeEditor.md`](../../vendor/path.ux/documentation/NodeEditor.md#groups). What the
application decides:

- **Main binds both store seams; the renderer binds the loader only.** `bindGroupLibrary` points a
  graph's `groupLoader` and `groupSaver` at `lib/`, and `readGraphDoc` runs `resolveGroups()`
  after every read, folding a failed reference into an `unresolved-group` diagnostic against the
  instance so a graph whose definition went missing still opens. A definition's subgraph binds the
  library too, so a definition that instances another resolves. The renderer resolves definitions
  over the `gengraph:group` channel and never sets a saver: every write is a command.
- **A definition is written only by a command**, through the `group` prop above. The exposure and
  boundary commands apply path.ux's own functions over the `GroupDef`, which is why they need no
  toolstack in main.
- **A ref is a slug allocated by main.** `gengraph.createGroup` takes an optional name and
  otherwise allocates `group-<n>` against the files in `lib/` (`nextGroupRef`), comparing
  case-insensitively. A name that is not a slug, or one already taken, is refused by sentence.
- **Grouping refuses an output node.** A slot's output is the graph's binding to the pipeline and
  belongs at the root. `validateGenGraph` walks the flattened order, so an output found inside an
  instance or a definition is diagnosed as `output-in-group`.
- **Nesting is allowed and self-containment is refused.** `addGroup` and `createGroup` take
  `group` too, so an instance or a new group can be placed inside a definition. A definition may
  not contain itself, directly or through another group; the command checks the chain by ref,
  because two reads of one file are two objects and path.ux's identity check cannot see through
  that.
- **An instance keeps its identity through the other edits.** `duplicateNode` clones through
  path.ux's `cloneNode`, so a copied instance keeps its ref and its overrides. `ungroup` inlines a
  copy of the instance's subgraph, overrides included, wired the way the instance was, and leaves
  the definition for its other instances. The agent's whole-graph rewrite keeps an instance under
  `group: <ref>`.
- **A definition edited anywhere reloads every pane whose graph instances it.** `touchesGraph`
  takes the refs a graph instances (`instancedRefs`), so a `documents:wrote` naming a definition
  file reaches each pane that draws an instance of it.

Not built, deliberately: the agent editing a definition (a definition-level DSL is a follow-on),
`gengraph.apply` with `group`, renaming or deleting a definition (an unused file is harmless, a
delete is a file operation the mtime check sees, and a rename would break every instance), and
sharing definitions between projects.

## The Gen Graph pane

`apps/desktop/renderer/pathux/editors/nodes.ts`, editor #17. Task Graph says whether a slot has
been drawn; this pane says how it will be. It claims a `graph` node primary and a `slot` row
primary only while the slot is bound to a graph (`ClaimNode.boundGraph`, stamped by main where the
document tree is built); Task Graph takes such a row as a secondary claim, so the two never fight
over one click. The pane pins to `graphSlug`, and clicking a bound slot or a picture a slot claims
publishes `ui.graphSlug`, so a pane already open follows the click
([`document-tree.md`](document-tree.md)). How it sits among the other pipeline editors is in
[`desktop-app-editors-pipeline.md`](desktop-app-editors-pipeline.md#gen-graph).

The pane hosts path.ux's `NodeGraphView` inside `appendSurface`, with `styles/gengraph.css`
adopted into the pane's own shadow root. The graph is read over the `gengraph:doc` channel as the
file's nstructjs JSON and parsed back into a real `Graph` by `readGraphFile`, because the DSL
carries topology and authored values and no layout, and a frame has to be drawn where the author
left it. Diagnostics from the read and from the file itself are shown in a strip above the canvas.

- **Every mutating gesture becomes a `gengraph.*` command.** `renderer/rules/gengraph.ts` is the
  pure half: it reads one of path.ux's gesture kinds as a `GenEdit` and names the command that
  writes it, and it refuses by name the one kind this application has no command for, retyping a
  node in place, since a node's identity is what its journal is keyed by. The delegate's `check`
  runs `decideGenEdit` locally rather than `stack.check` over IPC, because path.ux's check is
  synchronous and runs once per frame per pointer move while `command:check` is an async round
  trip. Both sides run the same decision function, so the mid-gesture verdict matches the verdict
  on commit. A refused gesture says its refusal, except a refused drag, which path.ux already
  shows by fading the frame it would not move.
  - An edit is applied to the pane's own copy of the graph before it is sent, so the author sees
    it at once and the pane never re-reads the file for its own write. Three edits are the
    exception, `createGroup`, `ungroup` and `addGroup`, because main allocates a group's ref
    and an instance is unresolved until its definition is loaded; those are sent first and shown
    when the acknowledgement reloads the graph, with the node the ack named selected.
- **The pane hosts path.ux's levels, and main never learns which one it is on.** The view shows
  the root graph, a group's definition, or the inside of one instance, with a breadcrumb strip
  saying which. An edit is addressed by an `EditTarget` that `targetFor` reads off the view's
  descent: the definition file a definition level writes to (the `group` prop every editing
  command takes), and the instance-id prefix a node inside an instance is keyed by, so a node on
  screen is named to main as `<instance>/<id>`. A definition's ids are its own, so a definition
  level has an empty prefix.
  - Ctrl+G groups the selection and Ctrl+Alt+G inlines the selected instances; Tab enters the one
    selected group's definition or leaves the level; a double-click on an instance's title enters
    it too. The keymap is built from `view.hotkeys()`, so it cannot drift from path.ux's example
    app, and the header's Group and Ungroup buttons go through `act()` with the refusal for the
    current selection as the disabled tooltip. The Edit menu's four group entries, Create Group,
    Ungroup, Edit Group and Exit Group, reach the same methods on the active pane
    ([`desktop-app-shell.md`](desktop-app-shell.md#the-shell)).
  - At a definition level a designer sits beside the canvas: the definition's boundary sockets
    and the rows it forwards, each edit of which is a `gengraph.expose`, `unexpose`,
    `reorderExposed`, `repointExposed`, `addBoundary` or `removeBoundary` with `group` set.
    Inside an instance, structural edits are refused by `decideGenEdit`'s own sentence and a
    value edit is an override, written as `gengraph.setProp` on the keyed node.
  - Definitions resolve in the renderer through a `groupLoader` over the `gengraph:group`
    channel, and the pane awaits `resolveGroups()` after every parse so the view has definitions
    to enter and forwarded rows to draw. The loader first waits for the pane's own outstanding
    writes, because the view's save-and-resolve pass fires while a definition edit is still
    unacknowledged, and a load then would hand back the old file.
  - The level survives a restart as one struct field, `descentJson`, holding the descent and the
    slug it was saved in; it is applied only to a read of that slug, and dropped otherwise.
- **Delete and duplicate open a checkpoint**
  ([`command-system.md`](command-system.md#checkpoints-group-several-commands-into-one-undo-point)),
  so a multi-node selection lands as one undo point instead of one per node: the delegate's
  `undoStepBegin`/`undoStepEnd`, widened in `vendor/path.ux` to a real `Promise<void>` taking the
  gesture's label and message, open and close it, and `send` tags its `exec` calls onto the open
  handle. A refused open dispatches nothing, since path.ux's `AsyncGateOp` skips the gesture's
  callback when the bracketing hook throws; a refused close can follow edits already applied
  optimistically to the graph on screen, so it forces a reload the same way a refused write does.
- **Node properties are bound through a data API scoped to this pane.** `defineGraphApi` builds a
  `DataAPI` rooted on one member, the graph on screen, and the editor installs it through
  `ctx.override({api})` at `init`, one per instance, because two panes may be open on different
  slugs and one member cannot answer for both. The app-wide API in `renderer/pathux/app/api.ts` is
  unchanged and still defines nothing for graphs. With the view pointed at `graph`, path.ux's
  `NodeFrame` builds the prop rows itself, and an unconnected input's editor sits on the socket's
  own row; connecting the socket removes it.
  - Every bound write is heard through a `change` listener per property, judged by
    `decideGenEdit`, and sent as the command that writes it. A refused write is put back through
    the same API rather than prevented, because `change` is a notification and cannot veto. The
    listeners are the level's: a group instance's frame draws the rows its definition forwards,
    which bind an inner node of the instance's own copy, so those are listened to under the
    instance's key and a write to one is the override described above.
  - `active` on an output binds as a checkbox: ticking sends `gengraph.setActiveOutput`, which
    stands the rivals claiming its slot down, and unticking sends a plain
    `gengraph.setProp active=false`. The strip above the canvas says when a graph whose outputs
    are all inactive falls back to the built-in runner.
  - Every bound property is declared `PropFlags.NO_UNDO`, so path.ux's own datapath undo never
    sees a write the app's undo stack already holds, and it carries a `uiname` and a `description`
    so each row is labelled and tooltipped from the declaration. `readGraphFile` restamps all
    three after a read: nstructjs serializes a property whole, so a file written before those
    fields existed loads carrying empty ones.
- **A pane does not reload on its own write, and recognises everyone else's by version.** A
  write's echo (`documents:wrote`) names the paths it touched and the version each now carries,
  and `exec`'s answer names the versions this pane's own write produced. `DocSync` in
  `rules/gengraph.ts` keeps both per document path, the graph's own file and the definition file
  of every group the graph instances, known after `resolveGroups`, and `shouldReload` says
  whether an echo is news: not while any write of this pane's is outstanding (its copy is ahead of
  whatever main can report, and the write that settles the last of them asks again), yes after a
  refusal (the pane holds an edit the file never took), yes for an echo that names no version (an
  undo restores files no command declared), and otherwise only for a version past the pane's own.
  A second pane open on the same graph therefore reloads on the first pane's writes, because those
  versions are not its own.
- **An edit here redraws what the graph draws.** A gesture that changes the authored graph spends
  nothing when it is made, and the next `pipeline.run` puts the bound slot's task back to `pending`
  and draws it again, so a picture can change without the author naming it, and the run's
  notification says how many were redrawn for an edited graph. The task's hash does not move,
  because the graph is the slot's runner rather than part of what the slot is. Undoing the edit
  before the next run leaves nothing to redraw, since the journal the comparison reads sits under
  `state/`, which undo excludes.
- **What the edit costs** was measured and cut down by four plans tracked in
  [`../plans/gengraph-editing-cost-tasklist.md`](../plans/gengraph-editing-cost-tasklist.md):
  the batched commit, the scoped data API, the per-document versions above, and precise write
  signals.
- **Theme.** The app's theme overrides path.ux's group keys (`GroupAccent`, `GroupHeaderBG`,
  `ProxyHeaderBG`) and the view's breadcrumb and level keys (`CrumbBG`, `CrumbFont`,
  `CrumbActiveFont`, `LevelDefinitionColor`, `LevelInstanceColor`) in the app's own palette, in
  `renderer/pathux/app/theme.ts`.

## The CLI

`vngen` needs no new subcommand to run graphs. Three verbs know about them
([`../guides/cli.md`](../guides/cli.md)):

- `vngen run` loads the project's graphs, indexes them by bound slot, and draws a bound slot's
  task through its graph. A graph that will not load, and a slot two active outputs claim, are
  printed rather than fatal. The run summary counts the tasks it put back to `pending` for drift
  beside the ones it retried.
- `vngen status` prints the graph count, how many slots are bound, any doubly-claimed slot, and
  each drifted output as `drifted: <slug> node <key> (<slot>)`, saying the next run redraws it.
- `vngen cost` prices the bound slots as described under Cost.

`apps/cli` may import neither `@vn/gengraph` nor `@vn/artgen`, so everything both hosts do with a
project's graphs lives in `@vn/pipeline`'s `graphload.ts`: `readProjectGraphs` (which takes the
reader as a parameter, because the desktop reads a graph through git and the CLI reads the file),
`graphRuntime`, `reportGraphs`, `unrenderedBoundSlots` and `priceSlots`.

## Plugins

A plugin is a directory holding `plugin.json` and TypeScript sources, adding node types the same
three ways a built-in is split.

- **The manifest** declares `name` (a slug, which is also the directory name under the plugins
  root), `version`, `apiVersion` (checked against `GEN_PLUGIN_API_VERSION` at install, so a
  mismatch is refused before the first run of a node), a one-line `description`, `nodeTypes`
  (registering any other type is refused), the `services` its runtimes call and the `keys` it
  resolves (both named in the install confirmation), an `entry` module, an optional `prices`
  fragment consulted last, and `priceAgent`.
- **Install is an explicit confirmation and per-user.** `plugin.install` reads the manifest and
  confirms the sentence it declares, naming the services and key names, then copies the directory
  under `<userConfigDir>/plugins/<name>/` and activates it. An installed plugin runs with the
  application's own permissions; a sandbox is a later harness change. Plugins are per-user rather
  than per-project because the confirmation is a trust act by the person at the machine, and a
  cloned repo must not arrive pre-confirmed. Opening the project elsewhere gets the unknown-node
  diagnostic naming the plugin, never a silent substitute. `plugin.list`, `plugin.remove` and
  `plugin.prices` are the other three commands; none touches the workspace and none is undoable.
- **The API arrives as a value.** A plugin imports `@vn/gengraph/plugin` for types only; the
  `GenPluginApi` (the `Node` class, the three socket classes, the property classes,
  `registerNode`, `registerRuntime`, `registerPriceAgent`) is the argument to its `activate`
  function. A bundle that resolved the module at load time would carry a second registry and
  register its types where the host never reads, so `buildGenPlugin` refuses a bundle whose text
  still names the specifier.
- **The bundle is CommonJS, built by native esbuild.** Both hosts that load a plugin are CommonJS
  (the desktop main bundle and jest). `@vn/gengraph` declares the `GenEsbuild` shape it needs and
  takes a bundler from its caller, so the package carries no build tool. The desktop ships the
  native binary, unpacked from the asar with `ESBUILD_BINARY_PATH` set when packaged, and
  `pnpm smoke` runs a transform in the built binary. `esbuild-wasm` was measured and rejected: its
  Node API spawns `node bin/esbuild`, which a packaged app cannot assume is on `PATH`.
- **Keys and requests take the ordinary routes.** A plugin's keys resolve through the four-place
  `resolveKeys` chain and are set by `project.setKey`; its model calls pass through the provider
  ring like every other request. The agent's raw file writers (`write_file`, `edit_file`) refuse
  the plugins root outright, checked against the absolute path ahead of the workspace check, so the
  refusal can fire at all.
- **Prices.** A plugin whose vendor publishes no pricing API may declare `priceAgent`: on
  `plugin.prices`, and only then, the plugin fetches the vendor's published page through
  `services.fetch` and reads it with `services.text`, on the author's own key, and refuses when
  the page cannot be read rather than falling back on what a model remembers. The answer is folded
  into the author's table.
- **The first plugin is Gemini**, at the repo-root `plugins/gemini/`, a directory rather than a
  package because a plugin is installed by copying and imports a subpath the boundaries rule
  forbids under `packages/`. Its `GeminiImage` and `GeminiEditImage` types register beside the
  built-in image nodes rather than replacing them, so a graph reaches the vendor directly only once
  the author installs the plugin and uses those types. The built-in image node still runs through
  the host's image backend, which a project with no plugins depends on. The fixture plugin the
  loader's tests use lives in `packages/testkit/src/plugin/`.

## Deliberately not built

- A plugin sandbox.
- Editor-side active-output mechanics beyond the checkbox.
- Retiring the legacy non-graph runner path and `createGeminiImage`'s seat in
  `packages/providers/src/factory.ts`.
- Automatic price refresh on a schedule.
- Deferring the graph file write. An in-memory accumulator in main would let a pipeline run hash a
  stale file to the old content address and return a dedupe hit, with no error anywhere.
- A general data API for the application; the pane's scoped `DataAPI` is an exception for one
  editor over data path.ux already describes.
- The group cuts listed above.

## History

- [`../research/node-based-asset-generation.md`](../research/node-based-asset-generation.md), the
  research that settled the nine decisions.
- [`../plans/node-based-asset-generation.md`](../plans/node-based-asset-generation.md), the twelve
  stages that built the package, the runner, the commands, the tools, the pane and plugins, each
  with its as-built deviations.
- [`../plans/archive/group-nodes-in-the-gen-graph-editor.md`](../plans/archive/group-nodes-in-the-gen-graph-editor.md),
  the desktop half of groups, and
  [`group-node-authoring.md`](../../vendor/path.ux/documentation/plans/group-node-authoring.md), the
  path.ux half.
- [`../plans/gengraph-editing-cost-tasklist.md`](../plans/gengraph-editing-cost-tasklist.md) and
  the four plans it tracks.
- [`../plans/archive/gengraph-node-editor-data-api.md`](../plans/archive/gengraph-node-editor-data-api.md)
  and its pressure test,
  [`../research/pressure-test-gengraph-node-editor-data-api.md`](../research/pressure-test-gengraph-node-editor-data-api.md).

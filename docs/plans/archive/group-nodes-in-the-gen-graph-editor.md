# Group nodes in the Gen Graph editor

Status: **done** (D1–D4, 2026-09-04). The Gen Graph pane gains groups: an author selects
nodes and presses Ctrl+G or picks Edit ▸ Create Group, and the selection becomes a definition
file under `vngen/work/graphs/lib/` with an instance standing in its place; entering the
instance edits that file, and every graph that instances it follows. The editor gestures, the
ops, the level stack and the designer panel are path.ux's and are planned in
[`../../../vendor/path.ux/documentation/plans/group-node-authoring.md`](../../../vendor/path.ux/documentation/plans/group-node-authoring.md)
(the path.ux plan). This plan is the desktop half: what `@vn/gengraph` must know about a
node inside a group, the `gengraph.*` commands the view's edits become, and the pane, menu
and IPC that host it. It carries out decision 4 of
[`../node-based-asset-generation.md`](../node-based-asset-generation.md), which shipped the
file layout and the resolve pass but no way to make a group. The as-shipped description is
[`../../reference/gen-graphs.md`](../../reference/gen-graphs.md#groups).

<!-- toc -->

- [What exists, verified against the code](#what-exists-verified-against-the-code)
- [The three problems this plan has to solve](#the-three-problems-this-plan-has-to-solve)
- [Decisions](#decisions)
- [Stages](#stages)
  - [Stage D1 — `@vn/gengraph` learns about nodes inside groups](#stage-d1--vngengraph-learns-about-nodes-inside-groups)
  - [Stage D2 — the commands](#stage-d2--the-commands)
  - [Stage D3 — the pane, the menu, the keys](#stage-d3--the-pane-the-menu-the-keys)
  - [Stage D4 — docs and the tour sweep](#stage-d4--docs-and-the-tour-sweep)
- [Verification](#verification)
- [Deliberately cut](#deliberately-cut)
- [Pressure test](#pressure-test)

<!-- tocstop -->

## What exists, verified against the code

Checked on 2026-09-04.

- `readGraphDoc` (`packages/gengraph/src/document.ts`) binds `groupLoader`/`groupSaver` to
  `vngen/work/graphs/lib/<ref>.json` through `bindGroupLibrary` on the root graph only
  (`:124-129`) and runs `resolveGroups()`, reporting a failed load as an `unresolved-group`
  diagnostic. `readGroupDef`/`writeGroupDef` and `graphfile.ts`'s
  `readGroupFile`/`writeGroupFile` exist; nothing calls the writer. `graphSlugs` skips `lib/`
  because a directory does not end in `.json`, and `isGraphSlug` (`:29`) accepts
  `[a-z0-9][a-z0-9-]*` case-insensitively.
- `validateGenGraph` (`validate.ts:39`) walks the root's `graph.nodes` and skips the three
  structural types, so a node inside a group is never validated; `migrateGraph` is
  group-aware.
- `graphHashes` and `authoredHashes` (`hash.ts:50-68`) walk `graph.sort().order` — the
  flattened order, so an instance's inner nodes are in it and the `GroupNode` itself is not
  — and key the result by `node.id`. Every graph's `idgen` starts at zero, so an inner node
  sharing an id with a root node is the normal case, and the later write wins. A group input
  with no outside link resolves through the proxy to the instance's own socket, whose owner
  is the `GroupNode`; the hash walk then finds no entry for it (`:63-65`) and the boundary
  default's value never enters the hash.
- `executeGenGraph` (`execute.ts:259-276`) builds `wanted` through `ancestorsOf`, which looks
  sources up in the root graph's `nodeIdMap`, so an inner node's ancestor with a colliding id
  resolves to the wrong root node, one without resolves to nothing, and a boundary default's
  owner resolves to the `GroupNode`, which is absent from the order and trips the
  "inside a cycle" check (`:71-75`). The journal (`journal.ts`) records `nodeId: GraphId`,
  which is `number | string`, and `parseRecord` (`:120`) accepts both. `cost.ts:40` walks
  the flattened order and `:81` walks `graph.nodes`.
- `genNodeTypes()` (`dsl.ts`) is the registry `applyGraphDSL` rebuilds from and holds no
  `GroupNode`; path.ux's `buildGraphFromDSL` diagnoses the entry as `unknown-node-type` and
  `decideApply` (`edit.ts:399-409`) refuses on any diagnostic, so an agent's `edit_asset_graph`
  on a graph holding a group is refused whole. `graphToDSL` emits a `GroupNode` with
  `type: "GroupNode"` and no ref. The agent's `edit_asset_graph` schema
  (`packages/authoring/src/tools.ts:2570-2589`) declares each node as `{id, type, props?}` and
  zod strips unknown keys, so a `group` field would be dropped before the DSL saw it.
  `@vn/types` holds no DSL schema.
- `decideGenEdit` (`edit.ts`) judges nine `GenEdit` kinds against one `Graph`, looks every
  `node` up in `graph.nodeIdMap` (ten sites), never consults `structuralEditsRefused()`,
  and `decideDuplicate` (`:131-153`) rebuilds by `new cls()` plus authored props, which for a
  `GroupNode` yields an instance with no ref. The desktop delegate
  (`renderer/rules/gengraph.ts:31-34`) refuses `replaceNode` and the four exposure kinds
  with "a generation graph is one flat graph", and `commandFor` (`:16-19`) maps the rest to
  `gengraph.*` with string, number and boolean props.
- The commands (`apps/desktop/src/main/commands/gengraph.ts:70-85`) take a `slug`, read
  through `session.graphDoc`, apply a decision, and write the one graph file; `written`
  names it, and `GenApplied` (`edit.ts:41-46`) has no way to hand a second file back.
  `documents:wrote` stamps a version for every path in `written`
  (`apps/desktop/src/main/index.ts:205-212`). `pnpm lint` runs `check:commandtable`, so a
  new command needs `pnpm gen:command-table`. `graphDoc` (`session.ts:5630-5636`) stats the
  graph file alone, and `forgetGraphDocs` (`:5664-5669`) drops the held parse for any path
  under `vngen/work/graphs/` — but only through `noteWrites`, so a `lib/` file changed by a
  checkout serves stale instances.
- The undo snapshot is the project root minus `vngen/build` and `vngen/state`
  (`packages/commands/src/undo.ts:29-33`), and a checkpoint's scope `GRAPH_DOCS_DIR`
  (`apps/desktop/src/shared/writes.ts:41`) is a prefix check, so `lib/` is inside both.
  `graphDocPath` (`writes.ts:49`) is the one place the version-map key is spelled.
- The pane (`renderer/pathux/editors/nodes.ts`) parses the JSON with `readGraphFile` and
  never sets a `groupLoader`, so a `GroupNode` on screen has an instance subgraph but no
  definition: no forwarded rows, and nothing to enter. It applies a decision locally before
  sending (`:421-441`) and records the ack's version as its own so the echo is not reloaded
  (`:458-474`); `subscribe` (`:488`) walks `this.graph.nodes` and `revert` (`:543`)
  hard-codes a root path, so a bound row on an inner node has no write seam; `weigh`
  (`:443`) judges against `this.graph`. Its `DocSync` tracks one document, the slug's, and
  `touchesGraph` reloads on a write naming that path. The pane's header buttons record no
  anchors (`:235-243`).
- `editMenu()` (`renderer/pathux/editors/header.ts:677`) holds Undo, Redo and Approve &
  Generate All; the shell keymap leaves Ctrl+G and Tab free; the pane's keymap holds Delete
  and Shift+D. `panes.ts` defines the active pane as the one the pointer last entered.
- `graphDrift` (`drift.ts:29`) and `driftedTasks` (`packages/pipeline/src/graphrun.ts:175`)
  compare root targets only. `session.runGraph` names a failed node by id in its message
  (`session.ts:5771`).

## The three problems this plan has to solve

1. **Identity of a node inside a group.** Hashes, the journal, the executor's `wanted` set
   and the `node` prop of every command address a node by a bare id that is only unique
   within its own graph. Once groups exist, "node 3" is ambiguous.
2. **A second kind of document.** A definition is a file that several graphs instance, so
   an edit inside a group writes `lib/<ref>.json` rather than the graph the pane opened, and
   a write to it must be echoed to every pane whose graph instances it.
3. **The agent's whole-DSL edit.** `applyGraphDSL` rebuilds kept nodes from the registry,
   which has no `GroupNode`, and the DSL has no way to say which definition an instance
   names.

## Decisions

1. **A node key is its id chain from the root.** `nodeKey(node)` answers the node's own
   `id` for a root node, and `"<owner key>/<id>"` for a node inside an instance, walking
   `node.graph.groupOwner`. Root keys are unchanged, so an existing journal's records still
   match; an inner node's key is a string like `3/7`. `graphHashes`, `authoredHashes`, the
   journal, `executeGenGraph`'s `wanted` set and its result lists, `invalidateGenGraph`,
   `seedInputs` and both loops in `cost.ts` all work over the flattened order keyed by
   `nodeKey`, and `resolveNodeKey(graph, key)` walks the chain back to the node, replacing
   every `nodeIdMap` lookup in `edit.ts`. A DSL id containing `/` is refused by
   `applyGraphDSL`, so a key can never be mistaken for an id. A source socket whose owner is
   not in the flattened order is a boundary default reached through a proxy: it contributes
   the default's value to the hash, as an unconnected input does, and `ancestorsOf` skips
   it. A failed run's message names the key (`node 3/7 failed`), which is what the journal
   holds.
2. **A definition-level edit is the same command with a `group` prop.** Every structural
   and property command keeps its `slug` and gains an optional `group` ref. Set, the command
   reads `lib/<group>.json` and not the slug's graph, judges the edit against the
   definition's subgraph — which is a plain `Graph`, so `decideGenEdit` needs no second
   entry point — and writes the definition file; `written` names it. `slug` is still
   required and names the graph the author was looking at, for provenance.
   `setActiveOutput` refuses with `group` set: an active output belongs to a graph, not a
   definition. The exposure and boundary commands take `group` alone and apply path.ux's
   functions over the `GroupDef` (its plan's decision 7), which is why they need no
   toolstack in main.
3. **An instance's override is a property write addressed by key.** `gengraph.setProp` with
   `node='3/7'` and no `group` writes into instance 3's subgraph in the root file, which is
   exactly what path.ux's reconciliation preserves as an override. Structural edits with a
   key path are refused by `decideGenEdit`, which now consults `structuralEditsRefused()`
   and answers with that sentence.
4. **Grouping refuses an output node.** A slot's Output node is the graph's binding to the
   pipeline and belongs at the root; `decideGenEdit` refuses a `createGroup` whose selection
   holds one. `validateGenGraph` walks the flattened order, so a node inside an instance is
   checked as part of its root and an Output found there is diagnosed; `readGroupDoc`
   validates a definition's subgraph on its own the same way.
5. **The DSL says `group: <ref>` on an instance.** `graphToDSL` emits it; the `nodeTypes`
   handed to `buildGraphFromDSL` gain `GroupNode` and not the two proxies, so the agent
   cannot place a proxy at the root; `applyGraphDSL` keeps a kept instance's object when its
   ref is unchanged (so its overrides survive) and builds a fresh `GroupNode` with the ref
   for a new one. The command that applies binds the library on the rebuilt graph and
   resolves before writing, so the file never holds an unresolved instance. The agent's
   `edit_asset_graph` schema gains the optional `group` string, and both tools' descriptions
   say what it means. The agent therefore round-trips a graph holding groups and can add an
   instance of an existing definition; it cannot edit a definition, which is cut below.
6. **The renderer resolves definitions over IPC, only while nothing of its own is in
   flight.** A `gengraph:group` channel serves `lib/<ref>.json`; the pane sets `groupLoader`
   to it and awaits `resolveGroups()` after every parse, so the view has definitions to
   enter and forwarded rows to draw. The loader first awaits the pane's in-flight writes,
   because the view's own save-and-resolve pass can fire while a definition edit this pane
   sent is still unacknowledged, and a load then would hand back the old file. The renderer
   never sets `groupSaver`: every write is a command. `readGroupDoc` binds the library on a
   definition's subgraph too, so a definition that instances another resolves in main, and
   `graphDoc`'s held parse records the definition files it resolved and re-reads when any
   of them moved, so a checkout touching `lib/` is seen.
7. **Three edits reload on acknowledgement; the rest apply optimistically.** The pane keeps
   applying a decision to its own copy before sending and recognising the echo by version,
   which is what keeps a drag smooth — at a definition level too, because path.ux's pass
   now ignores moves. `createGroup`, `ungroup` and `addGroup` cannot be applied locally:
   main allocates the ref, and an instance is unresolved until an asynchronous load. Those
   three mark the sync stale so the ack reloads the graph; `refreshGraph` keeps the pane's
   descent and selection, and the path.ux op's own `selectNodes` is replaced by selecting
   the ack's returned id.
8. **Sync is per document path.** `DocSync` becomes a map keyed by the path an edit writes
   — the slug's file at the root level, the definition file at a definition level, spelled
   by a `graphGroupPath(ref)` beside `graphDocPath` — and `touchesGraph` reloads on the
   slug's own file and on the definition file of any ref the graph instances, known after
   `resolveGroups`. A `createGroup` writes two files and the ack names both. A write to a
   definition file from anywhere else reloads every pane whose graph instances it, through
   the same `documents:wrote` echo.
9. **The view keeps the level; main never knows it.** Which level a pane is on is renderer
   state, read from `view.currentLevel()` when an edit is routed; the `group` prop carries
   what main needs. The pane persists its descent through `saveData`/`loadData`, since it
   hosts the bare view rather than path.ux's `NodeEditor`. At a definition or instance level
   the pane's bound-row subscriptions, `weigh` and `revert` work over the level's graph and
   path rather than the root's.
10. **Ctrl+G and the Edit menu reach the active pane.** The pane's keymap is built from
    `view.hotkeys()` so it cannot drift from the example app's; Edit ▸ Create Group,
    Ungroup, Edit Group and Exit Group act on the `GenGraphEditor` that is the active pane
    in `panes.ts`'s sense, and say through the header's own `say` when it is not one. The
    header's Group and Ungroup buttons go through `act()` so the tour anchors record them.
11. **A group ref is a slug allocated by main.** `gengraph.createGroup` takes an optional
    `name` and otherwise allocates `group-<n>` against the files in `lib/`, comparing
    case-insensitively since the filesystem may; the ref must satisfy `isGraphSlug`, and a
    name that does not is refused by sentence.

## Stages

Each stage is one commit, green under `pnpm check && pnpm test && pnpm lint`. Path.ux's G1
and G2 land and the gitlink is bumped before D1, which imports the pure functions and the
DSL `group` field from `pathux-graph`; G3 and G4 land and the gitlink is bumped again before
D3, which needs `currentLevel`, `hotkeys`, `enterDefinition`, the designer and
`addGroupMenuTemplate`. Each bump regenerates the declarations `build:pathux-types` writes.

### Stage D1 — `@vn/gengraph` learns about nodes inside groups

Files: `packages/gengraph/src/{nodekey.ts (new), hash.ts, execute.ts, journal.ts, cost.ts,
dsl.ts, edit.ts, validate.ts, document.ts, state.ts, index.ts}`,
`packages/authoring/src/tools.ts`, and their `tests/`.

- `nodekey.ts`: `nodeKey`, `resolveNodeKey`, `isNodeKey`, in the barrel.
- `hash.ts`, `journal.ts`, `execute.ts`, `cost.ts`: decision 1, including the boundary
  default rule and `ancestorsOf` walking by node object over the flattened order.
- `dsl.ts` and the tool schema: decision 5, and the `/` refusal.
- `edit.ts`: `GenEdit` gains `createGroup {nodes, ref?}`, `ungroup {node}`, `addGroup
  {ref, x, y}`, the four exposure kinds and `addBoundary`/`removeBoundary`, each judged by
  `decideGenEdit` and applied through path.ux's functions; `GenApplied` gains the
  definitions a decision wrote, so `createGroup` can hand its new `GroupDef` to the
  command; `decideDuplicate` clones through path.ux's `cloneNode` so an instance keeps its
  ref and overrides; `structuralEditsRefused()` consulted for every structural kind;
  decision 4; every `node` field resolved by key.
- `document.ts`/`state.ts`: `readGroupDoc(root, ref)` (definition, diagnostics, path, with
  the library bound on its subgraph), `groupRefs(root)`, `nextGroupRef(root)`;
  `writeGroupDef` gains the same atomic write the graph file has.
- `validate.ts`: decision 4's walk.

Tests: the hash of an instance's inner node is keyed `3/7` and differs between two
instances of one definition when one carries an override; a colliding inner id no longer
overwrites a root hash; an instance's boundary default enters the inner node's hash and
changing it changes the hash; `executeGenGraph` with a target downstream of an instance
runs the instance's inner nodes in order, journals them by key, and does not trip the cycle
check on a boundary default; a journal from before this stage still matches root nodes;
DSL round-trips an instance with its ref and keeps its override, and a proxy at the root is
refused; the tool schema keeps `group`; `createGroup` over an output node refuses by
sentence; a structural edit on an instance subgraph refuses with path.ux's sentence;
duplicating an instance keeps its ref; `nextGroupRef` skips existing files regardless of
case.

**Status: done, 2026-09-04.** Landed as written, with these deviations:

- `createGroup.ref` is required rather than optional. `decideGenEdit` is pure and cannot
  read the library, so the caller (the D2 command) picks the name with `nextGroupRef` and
  passes it; the decision only checks it is a group name.
- `addGroup` takes `{ref, def?, pos?}` rather than `{ref, x, y}`: the definition comes in
  from the command, which loaded it, and the position is optional.
- `GenEdit` gained `apply {description, groups?}` so the agent's whole-graph rewrite
  reaches the definitions it names; `applyGraphDSL` takes the same map. The tool loads the
  whole library, applies, then binds and resolves before writing.
- The exposure and boundary kinds are decided against the graph passed in, which must be a
  definition's subgraph (`definitionOfSubgraph`); a root graph refuses with
  `this graph is not a group definition, so it has no boundary or forwarded rows to edit`.
- `document.ts` gained `groupPath`, `groupRefs`, `nextGroupRef` and `readGroupDoc`;
  `writeGroupDef` was already atomic. `isGraphSlug` moved to `slug.ts` (re-exported).
  `state.ts` needed no change, since it re-exports `document.ts`.
- `validate.ts` reports an output node inside a definition or an instance as
  `output-in-group`.
- The renderer's `commandFor` throws for the new kinds until D2 wires them.
- Path.ux gained `DSLRegistries.groups` (the DSL builder binds an instance to its
  definition, or reports `unknown-group`) and two boundary-default fixes: an unlinked
  instance output no longer resolves to its own inner producer, and a boundary default is
  read through the proxy chain without recursing into the inner consumer.

### Stage D2 — the commands

Files: `apps/desktop/src/main/commands/gengraph.ts`, `apps/desktop/src/main/session.ts`,
`apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/writes.ts`,
`apps/desktop/src/main/ipc.ts`, the generated command tables, and tests.

- `gengraph.createGroup(slug, nodes, name?)`, `gengraph.ungroup(slug, node)`,
  `gengraph.addGroup(slug, group, x, y)`, `gengraph.listGroups`, `gengraph.expose(group,
  node, key?, label?)`, `gengraph.unexpose(group, index)`, `gengraph.reorderExposed(group,
  from, to)`, `gengraph.repointExposed(group, index, node, key?)`, `gengraph.addBoundary
  (group, dir, key, type)`, `gengraph.removeBoundary(group, dir, key)`.
- The `group` prop on `addNode`, `duplicateNode`, `removeNode`, `link`, `unlink`,
  `setProp`, `moveNodes` (decision 2); `setActiveOutput` refuses it; `apply` refuses it
  (cut below). Each is routed through one `target(ctx, slug, group)` helper that reads
  either document and writes the right file, and `edit()` learns to write the definitions
  a decision hands back and to name every file it wrote.
- `session.groupDoc(ref)`, the `gengraph:group` channel, `graphGroupPath`, and the held
  parse's definition mtimes (decision 6).
- `pnpm gen:command-table`, since `pnpm lint` checks it.
- Every prop carries a description an author can read in the palette; the `group` prop's
  says what setting it changes.

Tests: each new command through the registry with a real project on disk; a definition
edit writes `lib/<ref>.json` and not the graph file; `createGroup` names both files in
`written`; undo restores both files; provenance records the `group` prop; `createGroup`
with a bad name refuses; a changed definition file is re-read by `graphDoc` without a
`noteWrites`.

### Stage D3 — the pane, the menu, the keys

Files: `apps/desktop/renderer/pathux/editors/nodes.ts`, `renderer/rules/gengraph.ts`,
`renderer/pathux/editors/header.ts`, `renderer/pathux/app/theme.ts`,
`renderer/styles/gengraph.css` and tests.

- `groupLoader` over `gengraph:group`, gated on the pane's in-flight count;
  `resolveGroups()` after parse (decision 6).
- `genEditFor` covers every new `GraphEdit` kind; `commandFor(target, edit)` takes the
  level's target; `UNSUPPORTED` shrinks to `replaceNode`.
- The three reload-on-ack kinds (decision 7); `DocSync` per path and `touchesGraph` over
  the instanced refs (decision 8); subscriptions, `weigh` and `revert` over the level's
  graph; descent through `saveData`/`loadData` (decision 9).
- The keymap from `view.hotkeys()`; header buttons Group and Ungroup beside Delete and
  Duplicate through `act()`, each with a tooltip stating what it does and, when refused,
  why; Edit menu entries (decision 10).
- Theme overrides for the path.ux keys the look introduces, in the app's own palette.

Tests: the delegate maps `createGroup` to `gengraph.createGroup` with the selection and no
name; an edit at a definition level carries `group`; a `documents:wrote` naming a
definition file this pane did not write reloads; one this pane wrote does not; a
`createGroup` ack reloads; a bound prop change on an inner node at a definition level sends
`setProp` with `group`, and at an instance level sends it with a key.

**D2 status: done, 2026-09-04.** Landed as written, with these deviations:

- `gengraph.addGroup` names the definition it instances with `ref`, not `group`, so `group`
  keeps one meaning across every command: the definition being edited. `addGroup` therefore
  also takes `group`, which places an instance inside another definition; the self-containment
  check runs in the command by ref, because two reads of one file are two objects and
  path.ux's identity check cannot see through that.
- `gengraph.createGroup` takes `group` too, so a nested group can be made inside a
  definition. `nodes` is one comma-separated string, since `@vn/commands` has no list kind.
- `setActiveOutput` and `apply` do not declare `group`; the registry refuses the unknown prop,
  which is the refusal decision 2 asked for. `apply` loads the whole library through
  `readGroupLibrary` so a description can instance a definition the graph never held.
- `gengraph.expose` takes no `at`; a row is added at the end and `reorderExposed` moves it.
- The held parses in `session.ts` stamp every file they came from, the definition files
  included, and `groupDoc` is held the same way; `forgetGraphDocs` still drops both maps on any
  write under the graph directory.
- `touchesGraph` gained a third argument, the refs a graph instances, rather than a second
  predicate, so D3 has one call to make.
- `anchors.json` was re-swept against `examples/mySampleRepo` because the coverage test pins
  the command list; the ten new commands are palette-only until D3 draws their controls.

**D3 status: done, 2026-09-04.** Landed as written, with these deviations:

- `renderer/rules/gengraph.ts` addresses an edit with an `EditTarget` — `slug`, the `group`
  a definition level is inside, and the instance-id `prefix` a node key carries — read off
  the view's descent by `targetFor`. A definition level has an empty prefix, since the
  definition's ids are its own; inside an instance the prefix is the instance chain.
- `GenEdit.createGroup.ref` became optional in `@vn/gengraph`, so the pane can judge a
  grouping against its own copy without a ref; `apply` throws without one, and only main,
  which allocates the ref, applies it. A ref the gesture carried is sent as `name`.
- A forwarded row on a group instance's frame binds an inner node of the instance's own
  copy, so the pane also listens to those, under the key `<instance>/<id>`; the resulting
  `setProp` names that key, which is the override decision 3 describes. The same key form is
  what `decideGenEdit` resolves against the level's graph, so `weigh` needs no second path.
- `DocSync` per path, as decision 8 said, with one pane-wide gate: while any write is
  outstanding every echo is passed over, and an undo's version-less echo is noted as stale so
  the settling write re-reads. A reload also marks each sync caught up to the latest version
  reported, so a foreign write seen once does not reload on every later settle.
- The saved level is one struct field, `descentJson`, holding the slug it was saved in as
  well as the descent, and it is applied only to a read of that slug; the pane hosts the bare
  view, so `saveData`/`loadData` was not needed.
- The group designer sits beside the canvas inside the pane rather than in a dock panel,
  because the pane's surface is a plain element and path.ux's panel manager is `NodeEditor`'s.
- The Group and Ungroup buttons re-record their anchors whenever the selection or the level
  changes, so the tour's record and the disabled tooltip both carry the refusal current for
  the selection. The Edit menu's four entries reach the active pane through `paneToUse` and a
  type-only import of the editor, so header and pane stay uncoupled at runtime.
- Verified live over CDP against `examples/test4`'s `probe` graph: grouping the template
  node wrote `lib/group-1.json` and the graph and the ack reloaded the pane with the
  instance selected; entering the definition showed the designer, the crumbs and the
  definition's own watches; exposing `template` sent `gengraph.expose(group='group-1' …)` and
  applied without a reload; leaving showed the instance's forwarded row, and writing it sent
  `gengraph.setProp(… node='4/3' …)`, which landed in the instance's subgraph; ungroup inlined
  the node, and undo put the instance back through the version-less echo. The tests the plan
  named for the pane's reload behaviour are those observations; the version rules behind them
  are unit-tested in `rules/tests/gengraph.test.ts`.
- The anchors sweep is left to D4, with the docs, since D4 re-runs it anyway.

### Stage D4 — docs and the tour sweep

- `docs/reference/desktop-app-editors-pipeline.md` (the Gen Graph section: groups, levels,
  the designer, the keys; the delegate now refuses one kind, not six; the echo suppression
  is `DocSync`, not the `onExec` skip it still describes), `desktop-app-shell.md` (the Edit
  menu), `pipeline-contracts.md` (the journal is keyed by node key), `desktopAppState.md`
  (a new graphs section covering `lib/`), `packages.md` (`@vn/gengraph/state`'s contents),
  `api-map.md` (`nodekey.ts`), [`../index.md`](../index.md), and
  `node-based-asset-generation.md`'s decision-4 row pointing here. The command tables are
  generated in D2.
- The `anchors.json` sweep re-run per
  [`../../reference/guided-tours.md`](../../reference/guided-tours.md), since the pane gains
  controls that record.
- Verified live over CDP against `examples/test4`: create a group from two nodes, enter it,
  expose a prop, leave, see the instance's row, run the graph, read the journal keys.
- On completion the index row flips and the file moves to `archive/`.

**D4 status: done, 2026-09-04.** Landed as written, with these notes:

- `api-map.md` does not exist under `docs/reference/`, although `CLAUDE.md` points at it, so
  `nodekey.ts` is described in `packages.md`'s `@vn/gengraph` row instead. `vnauthor.md` gained
  the sentence about `group: <ref>` in the DSL, which the D4 list did not name.
- The run check against `examples/test4`'s `probe` graph, holding the group D3 made, journaled
  the inner template as `nodeId: "4/3"` with the instance's override as its output. The image
  node after it failed with `Gemini returned no image (gemini-2.5-flash-image)` under `--mock`,
  the same failure the example's older journals hold from before this plan; noted, not
  chased here.
- The anchors sweep was re-run against `examples/mySampleRepo`, which adds the Group and
  Ungroup buttons and their refusals to `anchors.json`.

## Verification

- The three gates per stage.
- `pnpm build` after D3, since the renderer bundles path.ux.
- A run of a graph holding a group in `examples/test4` against the mock providers produces
  journal records keyed `<id>/<id>` for the inner nodes and a drift report that is quiet
  until the definition is edited.

## Deliberately cut

- The agent editing a definition. `edit_asset_graph` keeps groups and can instance one; a
  definition-level DSL is a follow-on once the group prop has been used by hand.
- `gengraph.apply` with `group`. The pane never sends `apply`, so this has no UI
  consequence.
- Renaming or deleting a definition. An unused `lib/<ref>.json` is harmless; a delete is a
  file operation an author can do outside the app, and decision 6's mtime check means the
  app sees it; a rename would break every instance.
- Sharing definitions between projects.

## Pressure test

Run 2026-09-04 by a fresh-context agent against the first draft. Twenty-six findings; each
is folded in above or answered here.

- Blockers. The hash walk dropped a boundary default and the executor's cycle check threw
  on it (decision 1). A drag inside a definition would have run path.ux's save-and-resolve
  pass per frame, which here is a file round trip per frame: path.ux's decision 9 now keys
  on topology, and the renderer's loader waits for the pane's own writes (decision 6). D3
  depended on path.ux G3 and G4 and the plan sequenced only G1 and G2: the stage preamble
  now sequences both bumps.
- Should-fix, folded in: the three edits that cannot be applied optimistically reload on
  ack (decision 7); the definition edits had no pure form main could call, which the path.ux
  plan now provides (decision 2); the agent schema strips `group` (decision 5, D1 files);
  the old claim that a group was "dropped" by the agent's edit was wrong, it is refused
  whole, and the proxies stay out of the registry (verified list, decision 5);
  `createGroup` writes two files and `edit()` learns to (decision 8, D2); bound rows inside
  a group had no write seam (decision 9); `decideDuplicate` lost a ref (D1); validation
  never entered a group (decision 4); D2 must regenerate the command tables; the D4 list
  was missing `api-map.md`, the `desktopAppState.md` section, the stale delegate and echo
  sentences in the editors doc, and the archive move.
- Notes, folded in: the true assumptions written into the verified list (undo scope,
  `written` versions, the journal's id type, `commandFor`'s prop types, the ten `nodeIdMap`
  sites); `graphGroupPath` beside `graphDocPath`; `isGraphSlug` is case-insensitive
  (decision 11); drift needs only the keying and the failure message names a key
  (decision 1); `touchesGraph` filters on instanced refs (decision 8); the active pane is
  `panes.ts`'s, descent persists through `saveData`, `slug` stays required, nested
  definitions bind the library too (decisions 6, 9, 10); the held parse goes stale on a
  checkout (decision 6); header buttons record anchors through `act()` (decision 10); the
  apply command resolves before writing (decision 5); `cost.ts`'s second loop (decision 1).
  No layering violation was found: the new module is pure, the file readers stay in
  `@vn/gengraph/state`, and the renderer's new `GraphEdit` kinds are types.

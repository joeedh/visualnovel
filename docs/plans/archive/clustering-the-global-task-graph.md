# Plan: clustering the global task graph

**Status:** shipped.
**Depends on:** [task DAG view](task-dag-view.md) (the editor and `renderer/graph/`
primitives this plan extends), [the full slot graph and approving upstream first](the-full-slot-graph-and-approving-upstream-first.md)
(`SlotNode`, `barrierFor`'s walk).
**Size:** medium. Two new pure derivations plus a scope state in one existing editor; no
change to `renderer/graph/layout.ts`, `edges.ts`, `canvas.ts` or `hit.ts`, and no change to
`Selection` — see Pressure test, Finding 1.

## Why

The task graph editor (`apps/desktop/renderer/pathux/editors/graph.ts`) lays out every task
and unplanned slot in one flat `layoutGraph` call. That reads fine for a small project, and
breaks down for a real one: a shared portrait or location plate is `refs`'d by every shot that
uses it, so every one of those shots lands in the same rank (`rankNodes` in
`renderer/graph/layout.ts` — longest-path ranking gives a node one rank below its deepest
parent, and "every shot of character X" is all the same distance from the roots). A character
who appears in thirty scenes produces a thirty-wide rank before crossing-reduction even runs.
The result is a graph too wide to read at any zoom level that also shows individual nodes.

Two `todos.md` items name this:

- *"do not use sugiyama layout for the global task graph view — it might work for individual
  asset subgraphs, so use it for those and we'll try it."*
- *"the task graph should have a searchable list of asset slots, clicking one lets you see just
  the graph uses to generate the slot. it should arrange the nodes in a nice manner."*

Read together, they name one design: keep the existing layered layout — it is deterministic,
tested, and already shared with the branch editor — but stop handing it the raw per-task graph
for the *overview*. Reserve it for graphs that are small by construction: a scene's or
character's own cluster, or the ancestor set of one slot. This plan builds both pieces, because
they share the same underlying fix (never lay out more than one scene/character/location's
worth of nodes at once) and the search feature is how an author reaches the scoped view once
the global view stops showing individual tasks.

## The three pieces

### 1. Cluster the global view by scene, character and location

A new pure derivation, `clusteredGraphOf`, groups the existing `TaskGraphModel` (from
`taskGraphOf`, unchanged) into clusters and projects the edges between them:

- **Cluster key.** `clusterKeyOf` takes two forms, one per node kind — it does not literally
  share code with `subjectOf`/`pickSlot`, only the fields they each already switch on (see
  Pressure test, Finding 3): for a *task*, it reads `task.inputs` the way `subjectOf` does
  (`shotId` → `scene:<sceneId>` via `sceneOfShot`; `characterId` → `char:<characterId>`;
  `locationId` → `loc:<locationId>`; anything else, i.e. `target`, → its own singleton
  `other:<hash>` — see Risks); for a *slot*, it reads `slot.binding.kind` the way `pickSlot`
  does (`'shot'` → `scene:<sceneId>`; `'portrait'|'sheet'` → `char:<characterId>`; `'plate'` →
  `loc:<locationId>`; `'asset'` never appears — see Pressure test, Finding 4).
- **Cluster edges.** Every edge in `model.edges` (dep, ref, slot) is projected through
  `clusterKeyOf` on both ends; a self-loop (both ends in the same cluster) is dropped, and
  duplicate cluster-to-cluster edges collapse into one, kept as the strongest kind present
  (`dep` > `ref` > `slot`) so the view still distinguishes real scheduling order from a resolved
  reference at a glance.
- **Cluster status.** Each cluster node carries a count per `TaskStatus` plus an "unplanned"
  count, rolled up from its members, so the cluster reads at a glance the way a single task's
  status dot does today — no per-member detail until it is opened.
- **The barrier stays a real node.** A cluster ranks below the barrier if *any* of its members
  is in `barrier.below`; a cluster that is itself a gate-pending character's own cluster is
  never given a ranking edge to the barrier at all, because that cluster mixes a gated seed
  (the portrait itself, not below) with anything downstream of it (its sheets, below) — see
  Risks for why this can't be resolved into a single above/below verdict per cluster in general.
  The `⟂ GATE` node keeps its per-character `RESOLVE →` buttons unchanged.
- **Size.** Cluster count is bounded by scene count + character count + location count, which
  for a real project is tens, not hundreds — the same order of magnitude the branch editor
  already lays out. `layoutGraph` runs on this graph exactly as it does today.

### 2. Scoped subgraphs stay on the layered layout

Two new pure functions produce small task-level graphs that keep using `layoutGraph` unchanged,
matching the todo's "it might work for individual asset subgraphs, so use it for those":

- **`clusterMembers(model, clusterId)`** — the tasks/slots belonging to one cluster, with only
  the edges internal to it. This is what opens when a cluster in the overview is clicked.
- **`subgraphFor(model, targetId)`** — the ancestor closure of one task or slot: walk
  `model.edges` backward from `targetId` (dep, ref and slot edges only — not the barrier's
  ranking edges) and keep every node reached, plus `targetId` itself. This is "just the graph
  used to generate the slot" from the todo. The barrier is included only if `targetId` is
  itself in `barrier.below` or is a pending seed, so a slot with nothing to do with the gate
  does not gain a rule it has no relationship to.

Both return a `TaskGraphModel`-shaped value so the editor's existing `renderNode`/`onPick` code
for task and slot nodes needs no branching by which of the two produced it.

### 3. A searchable slot list, and a scope state in the editor

`TaskGraphEditor` gains one new field:

```ts
type Scope = { kind: 'cluster'; id: string } | { kind: 'slot'; id: string } | null;
private scope: Scope = null;
```

- **No scope:** `rebuild()` lays out `clusteredGraphOf(this.model)` — the overview.
- **`{ kind: 'cluster' }`:** lays out `clusterMembers(this.model, id)` — one cluster's tasks.
- **`{ kind: 'slot' }`:** lays out `subgraphFor(this.model, id)` — one slot's ancestors.

The bar gains a text input that filters `status.slots` by label as the author types (the same
kind of filter the document-tree search todo wants, built independently since that tree has no
graph-shaped result to click into) and a result list; picking a result sets
`scope = { kind: 'slot', id }`. A "← Overview" button appears whenever `scope` is set and clears
it. `renderNode` gains a case for a synthetic `kind: 'cluster'` view (label, per-status counts,
nothing else — no thumbnails, matching the existing task node's own restraint); `onPick` routes
a cluster click to `scope = { kind: 'cluster', id }` and, before opening it, sets
`ui.sceneId`/`ui.characterId` the way `pickSlot` already does for a `scene:`/`char:` cluster.
A `loc:` cluster moves no selection field — see Pressure test, Finding 1.

`scope` is not persisted like `tidy` (`registerEditor(..., ['tidy : bool'])`) — it names a
specific node id that can stop existing on the next plan (`rebuild()` clears `scope` back to
`null` if the id it names is absent from the fresh model, with the overview shown instead of an
empty canvas).

## Files

```
apps/desktop/renderer/rules/taskGraph.ts    clusterKeyOf, clusteredGraphOf, clusterMembers,
                                             subgraphFor, ClusterNodeView
apps/desktop/renderer/rules/tests/taskGraph.test.ts
apps/desktop/renderer/pathux/editors/graph.ts   scope state, search bar, cluster rendering
```

No changes to `renderer/graph/layout.ts`, `edges.ts`, `canvas.ts`, or `hit.ts` — the point of
this plan is that the existing layered layout is fine at the sizes it is now always given.

## Verification

- `pnpm test` — cluster-key assignment for every `RefBinding` kind and for a target-based
  export task; cluster edge projection (dedup, self-loop drop, kind priority); status rollup;
  the mixed-cluster barrier rule (a gate-pending character's own cluster gets no ranking edge;
  a downstream character's cluster does); `subgraphFor`'s ancestor walk on a graph with a
  diamond (two ref producers feeding one shot) and on a slot with no upstream; `clusterMembers`
  round-tripping a cluster's own members with no cross-cluster edges leaking in.
- A synthetic fixture in the test file with one character referenced by fifty shots across ten
  scenes: assert the clustered graph's widest rank has at most the scene/character/location
  count, not fifty — the regression guard for the bug this plan fixes.
- Live on a bigger project than `templates/basic` (an existing `@vn/testkit` fixture or a
  synthetic one, since `templates/basic` is small enough that clustering barely changes the
  picture): the overview should show one node per scene/character/location rather than per
  task; clicking a cluster opens its members laid out with `layoutGraph`; searching a slot label
  and picking a result opens its ancestor subgraph; "← Overview" returns cleanly.
- Live with the gate closed: the pending character's cluster shows the same `RESOLVE →`
  affordance the barrier already offers, and its own cluster is not misplaced above or below
  the barrier rule.

## Risks

- **The mixed-cluster barrier case is a real modeling gap, not just an edge case.** A
  gate-pending character's cluster holds both the gated portrait and its (below-the-gate)
  sheets. This plan resolves it by exempting that one cluster from barrier ranking entirely
  rather than by finding a single above/below verdict for it — which is correct today because
  `barrierFor`'s walk already keeps a pending portrait out of its own `below` set, but would
  need revisiting if a future change made a cluster gated on more than one axis at once.
- **The `other:<hash>` singleton bucket does not solve the width problem for export-kind
  tasks** — if a project ever has many, they will still fan out one cluster per task. Accepted
  for now because export tasks are rare (typically one per project); flagged rather than solved.
- **Determinism.** `layoutGraph` promises the same graph produces the same picture; cluster id
  generation and cluster-edge dedup must iterate in a stable order (sorted by cluster key, not
  `Map` insertion order from a `Set`) so two runs over an unchanged `PipelineStatus` lay out
  identically. Needs a test that runs the derivation twice and compares node order, not just a
  single pass.
- **Cluster labels can be long** (a location id plus variant, a character id) — cap and
  ellipsize the same way `slotNode`'s subject line already does, rather than growing
  `TASK_NODE`'s fixed width per cluster.
- **The mixed-cluster barrier problem is not unique to the character cluster.** `barrierFor`
  gates a shot task by its *scene's whole cast*, not by which characters the shot itself
  actually shows — so a `scene:<sceneId>` cluster can hold both shots gated on a pending
  character and shots that are not, the same mixing the character-cluster case describes above.
  This plan accepts the same fix for both: a cluster ranks below the barrier if any member is
  below, and is exempted from ranking (not forced above or below) only in the one case where it
  is itself a pending character's own cluster — a scene cluster is never exempted, since a scene
  is never itself the gate's subject the way a character's own portrait is.

## Out of scope

- Editing, retrying, or any write path from the graph — unchanged from the original plan.
- Replay (scrubbing through a run) — already deferred in
  [`task-dag-view.md`](task-dag-view.md#stretch-replay).
- Any change to `renderer/graph/`'s layout, routing, or hit-testing code.
- The document tree's own search bar (a separate `todos.md` item) — this plan's search is local
  to the task graph editor and returns slots, not documents.

## Pressure test

A fresh-context agent attacked this plan against the actual code before implementation, per
[`docs/reference/conventions.md`](../../reference/conventions.md). Findings and dispositions:

1. **Fixed.** The plan originally claimed a cluster click could move the shared selection "the
   way `pickSlot` already does" for every cluster kind, including location. There is no
   `pickSlot` case for `binding.kind === 'plate'`, and — more to the point — `Selection`
   (`apps/desktop/renderer/pathux/selection.ts`) has no `locationId` field at all. This is not
   an oversight: `doctree.ts` states outright, "A location has no `ui.locationId` to publish, so
   its sheet is the whole selection" — a location is addressed through `docPath`, the same as a
   wiki note or a skill. Adding a `locationId` field would contradict that existing design. The
   plan now states plainly that a `loc:` cluster click moves no selection field (§3, above), and
   drops the earlier plan to touch `selection.ts`. Resolving a location plate's own document path
   from inside the task graph editor — so a `loc:` cluster *could* move `ui.docPath` the way
   `doctree.ts` does — is a real follow-on but needs the doc-tree's node lookup wired into a
   place that today only sees `PipelineStatus`/`StoryGraph`; out of scope here.
2. **Fixed (Risks).** The mixed-cluster barrier problem was stated only for the character
   cluster; `barrierFor` gates a shot by its scene's whole cast, so the same mixing applies to
   `scene:<sceneId>` clusters. Recorded in Risks with the same resolution (rank-below-if-any-
   member-below, no exemption for scene clusters since a scene is never the gate's own subject).
3. **Fixed.** "`clusterKeyOf` reads the same fields `subjectOf`/`pickSlot` already read" invited
   an implementer to literally share code between a task-shaped and a slot-shaped input. Reworded
   in §1 to state the two branches explicitly: `task.inputs` for a task node, `slot.binding.kind`
   for a slot node.
4. **Fixed.** Added a one-line note that `RefBinding.kind === 'asset'` never appears on a real
   `SlotNode` — `buildSlotGraph` (`packages/artgen/src/slotgraph.ts`) never emits it — so
   `clusterKeyOf`'s slot branch does not need a case for it, and the `other:<hash>` fallback in
   the task branch is unrelated to this (already noted in Risks).
5. **Verified, no change.** `subgraphFor`'s exclusion of the barrier's ranking-only edges from
   its backward walk is consistent with `taskGraphOf`, which keeps those edges only in
   `model.graph.edges`, never in `model.edges` (the drawn set `subgraphFor` should walk).
6. **Verified, no change (Size).** Reassessed after Finding 1 removed the `selection.ts` touch;
   "medium" stands.
7. **Verified, no change.** `clusterMembers`'s "no cross-cluster edges leaking in" claim matches
   how `buildDepEdges`/`buildRefEdges`/`buildSlotEdges` already scope edges to nodes present in
   the graph they're building.
8. **Verified, no change.** The todo's literal wording ("searchable list of asset slots") maps
   to §3's slot search feeding `subgraphFor`, not to a search over clusters — the plan already
   matches this.

## Done

- [x] `clusterKeyOf` / `clusteredGraphOf` / `clusterMembers` / `subgraphFor`, tested
- [x] Overview shows clusters, not individual tasks, and stays narrow on a many-shots-per-
      character fixture
- [x] Searchable slot list opens a slot's ancestor subgraph via `subgraphFor`
- [x] Clicking a cluster opens `clusterMembers`, moving the shared selection for a `scene:`/
      `char:` cluster (a `loc:` cluster moves none, per Pressure test Finding 1)
- [x] "← Overview" returns to the clustered view
- [x] Gate barrier renders correctly at cluster granularity, including the mixed-cluster case

Verified live over CDP against `examples/test4` (503 tasks, 232 slots): the raw graph put every
shot sharing a portrait in one rank, and the clustered overview draws 93 boxes across 2 ranks.
Searching `auria` listed four slots; picking the portrait drew one node, and picking the model
sheet drew its two ancestors. Opening the `ud_final_boss` cluster drew its eleven `shot_image`
members, and "← Overview" returned to the 93-box view.

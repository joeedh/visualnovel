# Plan: task DAG view

**Status:** shipped.
**Depends on:** [desktop renderer restructure](desktop-renderer-restructure.md), and
[story branch editor](story-branch-editor.md) for the `renderer/graph/` primitives.
**Size:** medium. An upgrade to an existing surface, not a new one —
[`../../research/graphThingsReport.md`](../../research/graphThingsReport.md) §2.

## Why

FLOOR already renders every task as a card with kind, hash, and status (`Floor.tsx:44`).
That flat list is fine at 20 tasks and useless at 300, and it cannot show *why* anything is
blocked: the gate appears as a separate bar above the list (`Floor.tsx:33`), visually
disconnected from the tasks it holds up.

Read-only. No new IPC channel — `pipeline:status` already returns full `Task[]`.

## The three honesty problems

A naive rendering of `Task.deps` would be wrong in three specific ways, and handling them is
most of the value here.

### 1. The gate is not an edge

The P3 approval gate is a planner predicate (`sceneUnblocked`,
`packages/pipeline/src/gate.ts:12`), not a dependency. A run halts with nothing ready and no
edge explaining it.

The view must **synthesize** a barrier: a horizontal rule across the graph with the pending
characters on it, positioned between the portrait tasks and everything downstream of them,
with blocked tasks rendered beneath it. Mark it visually as derived — it is the app's
inference, not data. Reuse the existing `⟂ GATE` glyph and the `RESOLVE →` affordance from
`Floor.tsx:39` so the gate bar becomes part of the graph rather than a second UI for the same
thing.

### 2. `deps` understates coupling

`planner.ts:145` puts only the `location_ref` task in a `shot_image`'s `deps`. The subject
portraits enter through `inputs.refs` as `AssetRef`s taken from `character.approvedPortrait`
— so the character→shot relationship exists in the data but not in the edge set.

Draw both, distinguished: **`deps` solid** (what the scheduler orders on) and **derived
ref-edges dashed** (what actually fed the prompt). Resolving a ref edge means matching an
`AssetRef.hash` back to the task whose `output` equals it — an index built once per status
refresh, in a pure function.

### 3. The graph is deliberately partial

Planning is incremental — one pass per scheduler wave — so shot tasks do not exist until
their location plate is `done` (`planner.ts:127`). An empty region is not "nothing to do";
it is "not yet plannable."

Show unplanned downstream work as ghosted placeholders derived from the model (scene count ×
expected shots), clearly styled as not-yet-real. Without this the view reads as a stalled
pipeline, which is the same misreading that makes `vngen cost` undercount.

## Design

Pure machine side: `--signal` for structure, `--mono` for hashes, no `--prose` anywhere. This
is an instrument, not a document — the boldness budget was spent in the branch editor, and
spending it again here would make the two rooms compete.

Status is the only color that varies, reusing the tokens already bound to task status in
`floor.css`: `--jade` done, `--signal` running, `--mist-dim` pending, `--vermilion` failed,
`--sodium` `needs_human` (warm, because it is the one status that wants a human — the
sodium/signal split already means exactly that).

Nodes are compact: kind in `--mono`, 8-char hash, a status dot. No thumbnails — at 300 nodes
they would be noise, and the inspector is one click away.

**Keep the flat list.** It is better for scanning and for small projects; the graph is better
for structure. A segmented control in the floorbar switches between them, and both drive the
same selection state and the same `Inspector`. Do not delete working UI to make room for new
UI.

## Files

```
renderer/rooms/floor/
  Floor.tsx           adds the list/graph toggle
  TaskGraphView.tsx   the graph surface (thin; layout comes from renderer/graph/)
  taskGraph.ts        pure: Task[] → nodes + edges + barrier + ghosts
  tests/taskGraph.test.ts
```

`taskGraph.ts` is where the three honesty problems get solved, and all three are pure
functions over `PipelineStatus`, so all three are testable in node:

- `buildRefEdges(tasks)` — hash→producer index, then ref edges, skipping refs with no
  producing task (user-supplied references have none).
- `barrierFor(status)` — which tasks sit below the gate, given `gatePending`.
- `ghostsFor(status, index)` — placeholders for not-yet-plannable work.

Layout comes from `renderer/graph/layout.ts` unchanged. If the branch editor's layered layout
does not handle 300 nodes acceptably, fix it there — both views benefit.

## Stretch: replay

Every status transition is appended to `vngen/state/tasks.jsonl`, so the graph can scrub
through a run rather than only showing its end state. Genuinely useful for understanding wave
structure and where time went.

Explicitly deferred: it needs a new IPC channel to read the log, a time control, and a
decision about whether replay is a mode or a separate view. Do not start it in the same pass;
land the static graph first.

## Verification

- `pnpm test` — ref-edge resolution (including refs with no producer), barrier placement,
  ghost derivation.
- Live on `templates/basic` in mock mode: the gate barrier should appear with `aiko` pending,
  and shot tasks should be ghosts, not absent.
- Live after approving a portrait: barrier clears, ghosts become real nodes.
- Synthetic 300-node fixture for layout performance before trusting it on a real project.

## Risks

- **Layout performance.** 300 nodes in SVG with per-frame transforms is fine; 3000 is not.
  Set the expectation now by testing at scale, and cull off-screen nodes in the viewport
  rather than optimizing later.
- **Ghost inference can be wrong.** Shot counts depend on `decomposeScene`, which is
  LLM-backed with a deterministic fallback — so a ghost count is an estimate. Render ghosts
  as an approximate cluster ("~6 shots"), never as individually addressable nodes that turn
  out not to exist.

## Out of scope

Editing tasks, retrying from the graph, prompt inspection, replay (above), and any write
path whatsoever. FLOOR mutates through `pipeline.run` and `gate.approve` only.

## Done

- [x] List/graph toggle in the floorbar; both drive the same inspector
- [x] `deps` solid, ref-edges dashed, both correct on `templates/basic`
- [x] Gate rendered as a barrier in the graph, marked as derived, with `RESOLVE →`
- [x] Not-yet-plannable work shown as ghosts, not omitted
- [x] Pure derivation under test; acceptable at 300 nodes

## As shipped

**Files.** `renderer/rooms/floor/taskGraph.ts` (pure) + `tests/taskGraph.test.ts`,
`renderer/rooms/floor/TaskGraphView.tsx` (the only impure file),
`renderer/styles/taskgraph.css`, and the toggle in `Floor.tsx`. `renderer/graph/` was reused
**unchanged** — the layered layout needed no work to take the task DAG, which was the point of
splitting it out in the branch editor.

- **The barrier is a real node, placed by ranking-only edges.** `routeEdges` takes its edge
  list separately from `layoutGraph`, so `taskGraphOf` hands layout a set of `ranking` edges
  (`gate>…` into every gated node, `gate<…` out of every ungated one) that are never routed and
  never drawn. The gate is therefore positioned by the same longest-path ranking as everything
  else — *below* the portrait tasks, *above* everything it holds up — while still being drawn
  as a rule rather than as wires, because a predicate has no arrows. A test asserts the ranking
  edges are absent from the routed set, and another that every blocked node ranks strictly
  below the line.
- **Deviation: the derivations take the `StoryGraph`, not just the status.** The plan wrote
  `ghostsFor(status, index)` / `barrierFor(status)`. What is not-yet-plannable cannot be read
  off the task list at all — an empty task list and a finished project are the same `Task[]` on
  the ghost question — so both take the story graph (fetched once over the existing
  `story:graph` channel) and infer from scenes: a ghost cluster per reachable scene with no
  shot tasks, sized by the **deterministic baseline** (`decomposeScene`'s fallback: one
  establishing shot plus one per character), hung off the location plates it will reference.
  Model-sheet ghosts are countless, since the sheet count is not knowable up front.
- **Ghosts are clusters, never addressable.** `onPick` acts on `view.kind === 'task'` only, so
  a ghost cannot be selected into the inspector — it is an estimate and the UI never pretends
  otherwise. The `~6 shots` count and the `derived` marker on the gate are the two places the
  view labels its own inference.
- **A ref edge is only drawn when the ref has a producer**, matching `AssetRef.hash` back to
  the task whose `output` equals it; author-supplied references resolve to nothing and are
  skipped, and a ref that duplicates a `dep` is not double-drawn.
- **FLOOR's gate bars are hidden in graph mode**, because the barrier carries the same
  `RESOLVE →` affordance and two gate UIs on one screen is worse than either. `.gate-cta` opts
  back into `pointer-events` — the node layer is `pointer-events: none` so that `pick` is the
  single answer to "what is under the cursor", and a real button is the documented exception.
- **`view.mode` grew a second room.** `room: studio | floor`, `mode: convo | branches | list |
  graph`; the *pairing* is checked in `run` and refused with a throw
  (`STUDIO has no "graph" mode — try convo or branches.`), since the prop layer can only say
  "one of these four". `UiEffect`'s mode member is split per room, so the renderer's handler
  can't cross the wires either.
- **Verified live** over CDP against two on-disk `@vn/testkit` fixtures (mock `pipeline.run` is
  a dry run and produces no tasks, so the app alone can't make them): gate-halted — 12 nodes, 4
  gated ghosts, the barrier with `aiko →`/`haruki →`; gate-cleared — 19 real `done` nodes, no
  barrier, no ghosts, 7 dep wires and 9 dashed ref wires.

Replay (the stretch) was not started, as planned.

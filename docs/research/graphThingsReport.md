# Graph-shaped things in this project

<!-- toc -->

- [The unified model, first](#the-unified-model-first)
- [1. Story branch graph](#1-story-branch-graph)
- [2. Task DAG](#2-task-dag)
- [3. Prompt assembly](#3-prompt-assembly)
- [4. Pipeline schematic (kind-level)](#4-pipeline-schematic-kind-level)
- [5. Asset provenance](#5-asset-provenance)
- [6. The refine loop, unfolded](#6-the-refine-loop-unfolded)
- [7. Shot sequence / scene timeline](#7-shot-sequence--scene-timeline)
- [8. Character → outfit → sheet, and the gate](#8-character-%E2%86%92-outfit-%E2%86%92-sheet-and-the-gate)
- [9. Agent trace (`vnauthor`)](#9-agent-trace-vnauthor)
- [10. Command history](#10-command-history)
- [Out of scope for the unified model](#out-of-scope-for-the-unified-model)
    - [debug2d fragment / stacking tree](#debug2d-fragment--stacking-tree)
    - [Package layering graph](#package-layering-graph)
- [Summary](#summary)
- [Open questions](#open-questions)

<!-- tocstop -->

_Status: survey, partly built. The three highest-ranked candidates shipped, each as a mode
within an existing room rather than a new one: §1 the story branch editor (STUDIO's
`branches`,
[`../plans/archive/INDEX.md#story-branch-editor`](../plans/archive/INDEX.md#story-branch-editor)),
§2 the task DAG viewer (FLOOR's `graph`,
[`../plans/archive/INDEX.md#task-dag-view`](../plans/archive/INDEX.md#task-dag-view)), and
§7 the shot timeline (FLOOR's `timeline`,
[`../plans/archive/INDEX.md#shot-timeline-editor`](../plans/archive/INDEX.md#shot-timeline-editor)).
They share one canvas (`apps/desktop/renderer/graph/`) but do not use the heterogeneous
adapter proposed below. Each view projects its own node/edge model. §§3–6 and 8–10 remain
unbuilt._

Inventories the structures in this repo that could back a node-based editor or visualizer,
states what each one's nodes and edges are, and identifies the ones for which a graph view
would show something you cannot already see.

The scope question is not which data is stored as an explicit node graph. Adapter classes
are assumed throughout to project whatever shape the data is in, so a linear array, a
tree, or a set of ids joined across three files all count equally. What separates the
candidates is what the projection reveals, not what it costs.

## The unified model, first

Most of the candidates below are the same graph seen through different filters. The list
below writes out its main structure:

```
Config ─────┐
Character ──┼→ Scene → SceneLine → Shot → Task → Asset
Location ───┘    │                   │      │      │
                 └── choice/next ──→ Scene  └ refs ┘
```

Every view in this document applies a node-type filter, then an edge-type filter over the
result:

| View             | Node types           | Edge types           |
| ---------------- | -------------------- | -------------------- |
| Story branch     | `Scene`              | `choice`, `next`     |
| Task DAG         | `Task`               | `deps`               |
| Shot timeline    | `SceneLine`, `Shot`  | `coversLines`        |
| Asset provenance | `Asset`, `Task`      | `refs`, `sourceTask` |
| Gate blockers    | `Character`, `Scene` | `Scene.characters`   |
| Production spine | all                  | all                  |

We recommend building one heterogeneous adapter over a `{id, type, …}` /
`{from, to, type}` model and defining the views as declarative filters, rather than
writing six independent adapters. One adapter gives cross-view navigation at no extra
cost: click a scene in the branch graph to filter to its shots, click a shot to jump to
its task subtree, click the task to unfold its refine loop. That traversal matters more
than any single graph, and the individual graphs are entry points into it.

Two structures do not fit the unified model and should stay out of it: the
[debug2d fragment tree](#debug2d-fragment--stacking-tree) (deliberately isolated,
dev-only, zero-dependency) and the [package layering graph](#package-layering-graph)
(build-time metadata, not project data).

## 1. Story branch graph

**Nodes:** `Scene` (packages/types/src/entities.ts:145). **Edges:** `Choice.goto`
(entities.ts:81), which carries a label, and `Scene.next` for the linear continuation.

`toMermaid` in packages/model/src/graph.ts:35 already serializes the graph. `vngen graph`
exposes it and writes `story.graph.mmd`, dashing unreachable scenes via `model.reachable`.
`successors()` and `computeReachable()` in the same file are the traversal primitives.

This is the only candidate that justifies an editor rather than a viewer. The edges have a
canonical text source (the `[[choice: … -> id]]` and `[[next: id]]` markers parsed by
`@vn/parse`), and `@vn/model` already ships round-trip-safe serializers
(`fromDoc(toDoc(x)) ≡ x`, `applyCharacterEdit` / `applyLocationEdit`, see
packages/model/src/serialize.ts). So a dragged edge can be written back to the screenplay
without destroying prose or reformatting untouched markers.

It shows what text cannot: overall branch topology, dead scenes, and convergence points.
If nodes render the first accepted shot image as a thumbnail, it is also a
storyboard/graph hybrid.

**Priority: first.** This is built as STUDIO's `branches` mode. It has the highest
author-facing value, and the write-back path already exists. It writes back through
`applySceneBranchEdit` via the `story.*` commands, which is the first of the two options
in the open questions below.

## 2. Task DAG

**Nodes:** A node is a `Task`, keyed by content hash (`packages/types/src/tasks.ts:65`)
and typed by one of seven `TaskKind`s. Each task carries `status`
(`pending | running | done | failed | needs_human`), `output`, and `attempts[]`.
**Edges:** `Task.deps` holds the hashes of the upstream tasks.

`TaskGraph` (`packages/taskgraph/src/graph.ts`) exposes `all()`, `ready()`, `topoOrder()`
(Kahn, throws on cycle), and `prune()`, which together cover what a layout needs. Every
status transition is appended to `vngen/state/tasks.jsonl`, so the graph can be replayed
as a timeline instead of only shown as a snapshot.

This read-only view is the most valuable for three reasons:

- **The gate is invisible in the data.** The P3 character-approval gate is a planner
  predicate (`sceneUnblocked`, packages/pipeline/src/gate.ts:12), not a dependency edge. A
  run halts with nothing ready and no edge to account for the halt. A graph view has to
  synthesize the barrier in order to display it (see §4).
- **`deps` is narrower than the true data dependency.** In planner.ts:223, a `shot_image`
  task lists only its `location_ref` task in `deps`, while `refs` holds the subject
  portraits as `AssetRef`s taken from `character.approvedPortrait`. The scheduling DAG is
  therefore a subgraph of the real provenance graph, and only `refs` records the
  character→shot edges (§5). A view that draws `deps` alone understates coupling.
- **The graph is deliberately partial.** Planning is incremental (it runs once per
  scheduler wave), so shot tasks do not exist until their location plate is `done`
  (`planner.ts:202-203`). A view that does not distinguish "not yet plannable" from
  "nothing to do" looks like a stalled pipeline. The same caveat makes `vngen cost` a
  snapshot of currently-plannable work.

Each node is worth giving actions that inspect `attempts[]`, open the produced asset,
retry, and jump to the owning shot/scene.

**Priority: second.** It is read-only, but it explains dedupe, staleness, and the gate. It
is built as FLOOR's `graph` mode, which synthesizes the gate as an explicit barrier node
and draws `refs` edges alongside `deps`, matching the three caveats above.

## 3. Prompt assembly

The nodes are the inputs to the four builders in `packages/pipeline/src/prompts.ts`:
`config.art_style` (via `stylePreamble`), entity fields, palettes, and per-kind fixed
clauses. The edges are dataflow into a concatenation.

`buildShotPrompt` (prompts.ts:81) alone pulls from `config.art_style`, `shot.framing`,
`scene.location` → `Location.name`, `shot.location` (the variant id), each `ShotSubject`'s
resolved character name, outfit, pose and expression, `shot.camera`, and two fixed
clauses, then joins the parts with `.filter(Boolean).join(' ')`. The code expresses that
dataflow as a string concatenation. `buildPortraitPrompt`, `buildLocationPrompt`, and
`buildModelSheetPrompt` have the same shape and are smaller.

The read-only version is a decent inspector that answers why a prompt says what it says.
The larger goal is making prompts authorable: per-`TaskKind` prompt graphs stored as
project data, replacing the hardcoded builders. Two consequences need to be designed
around before committing:

- **Editing a prompt graph re-hashes everything downstream.** The normalized prompt is
  part of the task dedupe key, so a small node tweak invalidates generated art in bulk.
  That invalidation is intended, but the editor needs a live "this change invalidates N
  tasks / costs $X" readout, driven by `costPreview`
  (packages/pipeline/src/pipeline.ts:48).
- It moves prompt construction out of deterministic plumbing and into user data, which
  cuts against the repo's core deterministic-vs-generative split. The change is
  defensible, but it is an architecture decision rather than a UI one.

**The priority is a cheap, useful inspector. The authorable version is a separate
design.**

## 4. Pipeline schematic (kind-level)

**Nodes** are the seven `TaskKind`s plus the P3 gate as an explicit barrier. **Edges** are
the fixed dependency rules encoded in `planTasks` (packages/pipeline/src/planner.ts:132).

There are roughly ten nodes. `location_ref` has no dependencies and is always plannable.
Both `location_ref` and `portrait` feed the gate. `model_sheet` and `outfit_sheet` sit
past the gate and work off the approved portrait. `shot_image` consumes a location plate
plus subject portraits. `vision_review` and `prompt_refine` are declared, but the
`shot_image` runner (§6) folds them in, so neither is ever planned as a standalone node.

This graph does not exist anywhere in the data, which is why it is worth drawing. The
instance DAG is an unrolling of this template, the gate barrier can be drawn here as a
first-class thing, and the graph makes a natural legend/filter chrome for §2. It is cheap
to build: a static diagram plus live counts per kind.

## 5. Asset provenance

**Nodes:** A node is an `Asset` (`entities.ts:179`). **Edges:** An edge is either
`Asset.refs` (ordered reference hashes fed into generation) or `Asset.sourceTask`, which
points back into the task DAG.

All of it is already in `manifest.json`, including `satisfies` (`characterId` / `outfit` /
`locationId` / `variant` / `sceneId` / `shotId`). Grouping and coloring therefore require
no extra work.

This view is the task DAG one hop over. The asset-centric framing answers the question a
human actually has ("why is this character's hair the wrong color in scene 3"), and it
includes the character→shot edges that `deps` omits (§2). Ref order participates in the
dedupe hash, and ordered edges are the only form that preserves it.

## 6. The refine loop, unfolded

Each node is an attempt. The edges run generate → review (each configured reviewer) →
merge verdicts → `refinePrompt` → generate, a cycle capped at
`config.max_refine_attempts`.

This is folded into the `shot_image` runner (packages/pipeline/src/runners.ts) as a
documented deviation from the report's separate `vision_review` and `prompt_refine` nodes,
so the instance DAG shows one node that accounts for four API calls, and nothing in the
DAG explains the count. But `TaskAttempt[]` (tasks.ts:51) already persists every
iteration: prompt, refs, output, reviews, error. `refinePrompt`
(packages/pipeline/src/p6.ts:9) is deterministic and folds each `Defect`'s `suggestedFix`
into a `Corrections:` clause, so the prompt delta between attempts is attributable to
specific defects. Those defects make good edge labels.

This is the best debugging artifact in the inventory, and it projects data that is already
on disk. It requires no new persistence and no new instrumentation.

## 7. Shot sequence / scene timeline

**Nodes:** `SceneLine` (`entities.ts:97`, allocated `${sceneId}:L<n>` ids written back as
`[[line:]]` markers) and `Shot` (`entities.ts:118`). **Edges:** `Shot.coversLines` maps
many lines to one shot.

The data is intrinsically linear, so a node graph is the wrong structure for it. A
video-editor timeline fits better: it draws the lines as a strip and each shot as a clip
spanning a range of those lines, with draggable boundaries. Dragging edits `coversLines`,
which decides where `show` beats land in the exported playable —
packages/export/src/playable.ts walks `scene.lines` and emits a `show` whenever the
covering shot changes (reconstructing the deterministic grouping from `deterministicShots`
when a run's shots are not in memory).

It is also where `framing`, `location` (variant), `subjects[]`, and `camera` are edited
for each shot.

**The sleeper.** This is not a graph, but it becomes the highest-frequency editing surface
once art starts landing. It is built as FLOOR's `timeline` mode. Dragging a clip boundary
runs `story.setCoverage`, the only writer of `work/shots/<sceneId>.json` outside the
planner.

## 8. Character → outfit → sheet, and the gate

The nodes form a tree: `Character` → `Outfit[]` → `sheet` entries (angle/expression label
→ `AssetRef`). `approvedPortrait` and `defaultOutfit` are distinguished pointers.

It is not graph-editor material on its own, but it is the natural surface for the approval
gate (`draft → candidates → approved → locked`). It also carries a cross-cutting edge from
a character to the scenes they appear in (`Scene.characters`), filtered to reachable
scenes the way `usedCharacters` does (planner.ts:31).

The bipartite projection places unapproved characters on one side and the scenes they
block on the other. It is the single clearest answer to "why is my run halted", and it is
worth building even if no other graph view ships.

## 9. Agent trace (`vnauthor`)

Nodes are turns, tool calls, tool results, the proposed plan, its approval, and the
resulting commit. Edges represent causality, and also the plan→execute mode transition,
which is a state change.

It is not stored as a tree, and the REPL presents it linearly. The same argument applies
as in §6, because the linear transcript hides structure that matters when debugging why
the agent did something. It is worth less than the pipeline views, because sessions are
short and the transcript is right there.

## 10. Command history

**Nodes** are `CommandRecord` entries in `vngen/state/commands.jsonl`. Each entry records
`gitHead`, `gitDirty`, the `written` paths, and the replayable `invocation`.

The log is linear. Undo shipped
([`../plans/archive/INDEX.md#command-undo-redo`](../plans/archive/INDEX.md#command-undo-redo)),
so records carry `pre`/`post` snapshot commits and the stack's own undo/redo entries are
tagged. The graph-shaped version joins the log against git history: it draws commands in a
lane beside commits and shows which files each command touched. The snapshot commits
already sit in the object database, so that side branch can be drawn from them.

This is low priority, but it is cheap and it de-risks a pending decision.

## Out of scope for the unified model

### debug2d fragment / stacking tree

`@vn/debug2d` already holds a fragment IR, a space registry, and stacking order with
culprit retention; `explainPick` emits an ordered rejection log. Drawing the same data as
a tree (containing block, then stacking context, then fragment, with the culprit ancestor
highlighted) gives a legitimately good debugging visual, and the design doc already
anticipates a node-editor domain layer (2d-graphics-debug-api.md §10: `wiresCrossing`,
`hitTargets`, `snapCandidates`, `hairline`) for exactly the story editor that §1 proposes.

But the isolation is by design: the package has zero dependencies, sits outside the
layering graph, and is dynamically imported behind `import.meta.env.DEV`. It remains a
dev-only overlay rather than a "room", and it must not be wired into the project-data
adapter.

### Package layering graph

The dependency graph in [`../../CLAUDE.md`](../../CLAUDE.md) is enforced by
`eslint-plugin-boundaries` and `import/no-cycle`. Generating the rendering from
`eslint.config.mjs` would keep the doc honest, but the graph changes rarely and the
rendering has no runtime value.

## Summary

| #   | Graph              | Kind                  | Value                                      | Cost                            | Status                                                             |
| --- | ------------------ | --------------------- | ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------ |
| 1   | Story branch       | **Editor**            | High — authors are blind to topology today | Low; write-back exists          | **built** (STUDIO `branches`)                                      |
| 2   | Task DAG           | Viewer                | High — explains gate/dedupe/staleness      | Low; `TaskGraph` gives topology | **built** (FLOOR `graph`)                                          |
| 6   | Refine loop        | Viewer                | High — best debugging artifact             | Very low; pure projection       | —                                                                  |
| 8   | Gate blockers      | Viewer                | High — answers "why halted"                | Very low                        | partly — the barrier node in FLOOR `graph`, not the bipartite view |
| 7   | Shot timeline      | **Editor** (timeline) | High once art lands                        | Medium; new interaction model   | **built** (FLOOR `timeline`)                                       |
| 4   | Pipeline schematic | Diagram               | Medium — legend for #2                     | Very low                        | —                                                                  |
| 5   | Asset provenance   | Viewer                | Medium                                     | Low                             | —                                                                  |
| 3   | Prompt assembly    | Viewer → Editor       | Medium → high                              | Low → architectural             | —                                                                  |
| 9   | Agent trace        | Viewer                | Low–medium                                 | Low                             | —                                                                  |
| 10  | Command history    | Viewer                | Low                                        | Low                             | —                                                                  |

Build the story branch editor if only one thing gets built. Add the task DAG viewer if two
get built. If the heterogeneous adapter proposed at the top gets written first, the story
branch editor and the task DAG viewer are its first two views, and the rest are filters.

The build did not follow that one recommendation. #1, #2 and #7 shipped as three
independent projections sharing a domain-blind layout/routing canvas
(`apps/desktop/renderer/graph/`, which "may not know about scenes, choices or tasks"),
rather than as filters over one heterogeneous project-data adapter. Cross-view navigation
is therefore still hand-wired per view. Whether the adapter is worth writing now, with
three views already built against the seam, remains open, and writing it is no longer
cheap.

## Open questions

- ~~Does the branch editor write back through `@vn/model`'s serializers, or does it own a
  separate mutation path?~~ **Answered:** the branch editor writes back through the
  serializers. The path is `story.*` → `session.editBranches` → `applySceneBranchEdit`, so
  the branch editor has no second write path.
- ~~Is a graph room a fourth room alongside STUDIO · FLOOR · PLAY, or a mode within
  FLOOR?~~ Answered: a graph room is a mode within a room. `Room` stayed a three-value
  union. Branches sit under STUDIO, and the DAG and timeline sit under FLOOR.
- ~~Every mutation should route through `@vn/commands`~~ — it does; commands are the only
  write path. The coalescing question is still open. A continuous drag resolves to one
  command record at commit, so the intermediate states are not in the log and layout
  changes on commit rather than during the gesture.
- If prompt graphs become project data (§3), do they live in `project.yaml`, or in their
  own authored files alongside characters and locations?

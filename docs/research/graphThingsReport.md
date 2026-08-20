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
  * [debug2d fragment / stacking tree](#debug2d-fragment--stacking-tree)
  * [Package layering graph](#package-layering-graph)
- [Summary](#summary)
- [Open questions](#open-questions)

<!-- tocstop -->

_Status: survey, **partly built**. The three highest-ranked candidates shipped, each as a mode
within an existing room rather than a new one: §1 the story branch editor (STUDIO's `branches`,
[`../plans/archive/story-branch-editor.md`](../plans/archive/story-branch-editor.md)), §2 the task DAG viewer
(FLOOR's `graph`, [`../plans/archive/task-dag-view.md`](../plans/archive/task-dag-view.md)), and §7 the shot
timeline (FLOOR's `timeline`, [`../plans/archive/shot-timeline-editor.md`](../plans/archive/shot-timeline-editor.md)).
They share one canvas (`apps/desktop/renderer/graph/`) but **not** the heterogeneous adapter
proposed below — each view projects its own node/edge model. §§3–6 and 8–10 remain unbuilt._

An inventory of the structures in this repo that could back a node-based editor or
visualizer, what each one's nodes and edges actually are, and which ones a graph view would
tell you something you can't already see.

The scope question is **not** "which data is stored as an explicit node graph" — it is
assumed throughout that adapter classes will project whatever shape the data is in. So a
linear array, a tree, or a set of ids joined across three files all count equally. What
separates the candidates is what the projection reveals, not what it costs.

## The unified model, first

Most of the candidates below are the same graph seen through different filters. Written
out, the spine is:

```
Config ─────┐
Character ──┼→ Scene → SceneLine → Shot → Task → Asset
Location ───┘    │                   │      │      │
                 └── choice/next ──→ Scene  └ refs ┘
```

Every view in this document is a node-type filter plus an edge-type filter over that:

| View                | Node types           | Edge types                |
| ------------------- | -------------------- | ------------------------- |
| Story branch        | `Scene`              | `choice`, `next`          |
| Task DAG            | `Task`               | `deps`                    |
| Shot timeline       | `SceneLine`, `Shot`  | `coversLines`             |
| Asset provenance    | `Asset`, `Task`      | `refs`, `sourceTask`      |
| Gate blockers       | `Character`, `Scene` | `Scene.characters`        |
| Production spine    | all                  | all                       |

**Recommendation: build one heterogeneous adapter** over a `{id, type, …}` /
`{from, to, type}` model and define the views as declarative filters, rather than writing
six independent adapters. The payoff is cross-view navigation for free — click a scene in
the branch graph, filter to its shots, click a shot, jump to its task subtree, click the
task, unfold its refine loop. That traversal is the actual product; the individual graphs
are entry points into it.

Two structures resist the unified model and should stay out of it: the
[debug2d fragment tree](#debug2d-fragment--stacking-tree) (deliberately isolated, dev-only,
zero-dependency) and the [package layering graph](#package-layering-graph) (build-time
metadata, not project data).

## 1. Story branch graph

**Nodes:** `Scene` (`packages/types/src/entities.ts:145`).
**Edges:** `Choice.goto`, labeled (`entities.ts:81`), plus `Scene.next` for the linear
continuation.

Already serialized: `toMermaid` in `packages/model/src/graph.ts:35`, exposed as
`vngen graph` → `story.graph.mmd`, with unreachable scenes dashed via `model.reachable`.
`successors()` and `computeReachable()` in the same file are the traversal primitives.

**This is the only candidate that justifies an editor rather than a viewer.** The edges have
a canonical text source — the `[[choice: … -> id]]` and `[[next: id]]` markers parsed by
`@vn/parse` — and `@vn/model` already ships round-trip-safe serializers
(`fromDoc(toDoc(x)) ≡ x`, `applyCharacterEdit` / `applyLocationEdit`, see
`packages/model/src/serialize.ts`). So a dragged edge can be written back to the screenplay
without destroying prose or reformatting untouched markers.

What it shows that text cannot: overall branch topology, dead scenes, convergence points,
and — if nodes render the first accepted shot image as a thumbnail — a storyboard/graph
hybrid.

**Priority: first.** Highest author-facing value, and the write-back path already exists.
**Built** as STUDIO's `branches` mode; it writes back through `applySceneBranchEdit` via the
`story.*` commands, which is the first of the two options in the open questions below.

## 2. Task DAG

**Nodes:** `Task`, keyed by content hash (`packages/types/src/tasks.ts:65`), typed by one of
seven `TaskKind`s, each carrying `status` (`pending | running | done | failed | needs_human`),
`output`, and `attempts[]`.
**Edges:** `Task.deps` — upstream task hashes.

`TaskGraph` (`packages/taskgraph/src/graph.ts`) hands a layout everything it needs:
`all()`, `ready()`, `topoOrder()` (Kahn, throws on cycle), `prune()`. And because every
status transition is appended to `vngen/state/tasks.jsonl`, the graph can be **replayed as a
timeline** rather than only shown as a snapshot.

Three things make this the most valuable read-only view:

- **The gate is invisible in the data.** The P3 character-approval gate is not a dependency
  edge — it is a planner predicate (`sceneUnblocked`, `packages/pipeline/src/gate.ts:12`).
  A run halts with nothing ready and no edge explaining why. A graph view has to synthesize
  the barrier to be honest about it (see §4).
- **`deps` is narrower than the true data dependency.** In `planner.ts:223`, a `shot_image`
  task lists only its `location_ref` task in `deps`, while the subject portraits enter
  through `refs` as `AssetRef`s taken from `character.approvedPortrait`. The scheduling DAG
  is therefore a subgraph of the real provenance graph; the character→shot edges are only
  recoverable via `refs` (§5). A view that draws `deps` alone will understate coupling.
- **The graph is deliberately partial.** Planning is incremental — called once per scheduler
  wave — so shot tasks do not exist until their location plate is `done`
  (`planner.ts:202-203`). The view must distinguish "not yet plannable" from "nothing to
  do", or it reads as a stalled pipeline. This is the same caveat that makes `vngen cost` a
  snapshot of currently-plannable work.

Per-node actions worth having: inspect `attempts[]`, open the produced asset, retry, jump to
the owning shot/scene.

**Priority: second.** Read-only, but it is what makes dedupe, staleness, and the gate
comprehensible instead of mysterious. **Built** as FLOOR's `graph` mode, which does synthesize
the gate as an explicit barrier node and draws `refs` edges alongside `deps`, exactly as the
three caveats above demanded.

## 3. Prompt assembly

**Nodes:** the inputs to the four builders in `packages/pipeline/src/prompts.ts` —
`config.art_style` (via `stylePreamble`), entity fields, palettes, and per-kind fixed
clauses. **Edges:** dataflow into a concatenation.

`buildShotPrompt` (`prompts.ts:81`) alone pulls from `config.art_style`, `shot.framing`,
`scene.location` → `Location.name`, `shot.location` (the variant id), each `ShotSubject`'s
resolved character name / outfit / pose / expression, `shot.camera`, and two fixed clauses —
then `.filter(Boolean).join(' ')`. That is a dataflow graph written as a string
concatenation. `buildPortraitPrompt`, `buildLocationPrompt`, and `buildModelSheetPrompt` are
the same shape, smaller.

Read-only, this is a decent inspector: "why does this prompt say that." The larger prize is
making prompts **authorable** — per-`TaskKind` prompt graphs stored as project data,
replacing the hardcoded builders. Two consequences to design around before committing:

- **Editing a prompt graph re-hashes everything downstream.** The normalized prompt is part
  of the task dedupe key, so a casual node tweak invalidates generated art in bulk. That is
  staleness working correctly, but the editor needs a live "this change invalidates N tasks
  / costs $X" readout, driven by `costPreview` (`packages/pipeline/src/pipeline.ts:48`).
- **It moves prompt construction from deterministic plumbing into user data**, which cuts
  against the repo's core deterministic-vs-generative split. Defensible, but it is an
  architecture decision, not a UI one.

**Priority: inspector cheap and useful; authorable version is a separate design.**

## 4. Pipeline schematic (kind-level)

**Nodes:** the seven `TaskKind`s plus the P3 gate as an explicit barrier.
**Edges:** the fixed dependency rules encoded in `planTasks`
(`packages/pipeline/src/planner.ts:132`).

Roughly ten nodes: `location_ref` (no deps, always plannable) → the gate ← `portrait`;
`model_sheet` and `outfit_sheet` past the gate off the approved portrait; `shot_image`
consuming a location plate plus subject portraits; `vision_review` and `prompt_refine`
declared but folded into the `shot_image` runner (§6) and never planned as standalone nodes.

This graph does not exist anywhere in the data — which is exactly why it is worth drawing.
It is the template the instance DAG is an unrolling of, it is where the gate barrier can be
drawn as a first-class thing, and it makes a natural legend/filter chrome for §2. Cheap:
it is a static diagram plus live counts per kind.

## 5. Asset provenance

**Nodes:** `Asset` (`entities.ts:179`).
**Edges:** `Asset.refs` (ordered reference hashes fed into generation) and `Asset.sourceTask`
back into the task DAG.

All of it is already in `manifest.json`, including `satisfies`
(`characterId` / `outfit` / `locationId` / `variant` / `sceneId` / `shotId`), which gives
free grouping and coloring.

Strictly this is the task DAG one hop over — but the asset-centric framing answers the
question a human actually has ("why is this character's hair the wrong color in scene 3"),
and it carries the character→shot edges that `deps` omits (§2). Ref **order** participates
in the dedupe hash and is only legible as ordered edges.

## 6. The refine loop, unfolded

**Nodes:** attempts. **Edges:** generate → review (each configured reviewer) → merge
verdicts → `refinePrompt` → generate, a cycle capped at `config.max_refine_attempts`.

This is folded into the `shot_image` runner (`packages/pipeline/src/runners.ts`) as a
documented deviation from the report's separate `vision_review` / `prompt_refine` nodes — so
the instance DAG shows one node that inexplicably made four API calls. But `TaskAttempt[]`
(`tasks.ts:51`) already persists every iteration: prompt, refs, output, reviews, error.
`refinePrompt` (`packages/pipeline/src/p6.ts:9`) is deterministic and folds each `Defect`'s
`suggestedFix` into a `Corrections:` clause, so the prompt delta between attempts is exactly
attributable to specific defects — which makes good edge labels.

**This is the best debugging artifact in the inventory and it is pure projection over data
already on disk.** No new persistence, no new instrumentation.

## 7. Shot sequence / scene timeline

**Nodes:** `SceneLine` (`entities.ts:97`, allocated `${sceneId}:L<n>` ids written back as
`[[line:]]` markers) and `Shot` (`entities.ts:118`). **Edges:** `Shot.coversLines` — many
lines to one shot.

Intrinsically linear, so a node graph is the wrong metaphor. What this wants is a
**video-editor timeline**: lines as a strip, shots as clips spanning ranges of them, with
draggable boundaries. Dragging edits `coversLines`, which is what decides where `show` beats
land in the exported playable — `packages/export/src/playable.ts` walks `scene.lines` and
emits a `show` whenever the covering shot changes (reconstructing the deterministic grouping
from `deterministicShots` when a run's shots aren't in memory).

It is also the natural home for editing `framing`, `location` (variant), `subjects[]`, and
`camera` per shot.

**The sleeper.** Not a graph, but the highest-frequency editing surface once art starts
landing. **Built** as FLOOR's `timeline` mode; dragging a clip boundary runs
`story.setCoverage`, the only writer of `work/shots/<sceneId>.json` outside the planner.

## 8. Character → outfit → sheet, and the gate

**Nodes:** `Character` → `Outfit[]` → `sheet` entries (angle/expression label → `AssetRef`),
with `approvedPortrait` and `defaultOutfit` as distinguished pointers. A tree.

Not graph-editor material on its own, but it is the natural surface for the approval gate
(`draft → candidates → approved → locked`). The interesting edge is cross-cutting:
character → the scenes they appear in (`Scene.characters`), filtered to reachable scenes the
way `usedCharacters` does (`planner.ts:31`).

**That bipartite projection — unapproved characters on one side, the scenes they block on
the other — is the single clearest answer to "why is my run halted."** It is worth building
even if no other graph view ships.

## 9. Agent trace (`vnauthor`)

**Nodes:** turns, tool calls, tool results, the proposed plan, its approval, the resulting
commit. **Edges:** causality, plus the plan→execute mode transition as a state change.

Not stored as a tree; the REPL presents it linearly. Same argument as §6 — the linear
transcript hides structure that matters when debugging why the agent did something. Lower
value than the pipeline views because sessions are short and the transcript is right there.

## 10. Command history

**Nodes:** `CommandRecord` entries in `vngen/state/commands.jsonl`, each stamped with
`gitHead`, `gitDirty`, `written` paths, and the replayable `invocation`.

The log is linear, but it is no longer flat: undo shipped
([`../plans/archive/command-undo-redo.md`](../plans/archive/command-undo-redo.md)), so records carry `pre`/`post`
snapshot commits and the stack's own undo/redo entries are tagged. The graph-shaped version is
the **join against git history**: commands as a lane beside commits, showing which files each
touched — with the snapshot commits already sitting in the object database, waiting to be
drawn as the side branch they are.

**Priority: low, but cheap and it de-risks a pending decision.**

## Out of scope for the unified model

### debug2d fragment / stacking tree

`@vn/debug2d` already holds a fragment IR, a space registry, and stacking order with culprit
retention; `explainPick` emits an ordered rejection log. The same data as a tree — containing
block → stacking context → fragment, culprit ancestor highlighted — is a legitimately good
debugging visual, and the design doc already anticipates a node-editor domain layer
(`2d-graphics-debug-api.md` §10: `wiresCrossing`, `hitTargets`, `snapCandidates`, `hairline`)
for exactly the story editor §1 proposes.

But the package's isolation is the design: zero dependencies, outside the layering graph,
dynamically imported behind `import.meta.env.DEV`. It stays a dev-only overlay, not a room,
and it must not be wired into the project-data adapter.

### Package layering graph

The dependency graph in [`../../CLAUDE.md`](../../CLAUDE.md), enforced by
`eslint-plugin-boundaries` + `import/no-cycle`. Generating the rendering from
`eslint.config.mjs` would keep the doc honest, but it changes rarely and has no runtime
value.

## Summary

| # | Graph | Kind | Value | Cost | Status |
| - | ----- | ---- | ----- | ---- | ------ |
| 1 | Story branch | **Editor** | High — authors are blind to topology today | Low; write-back exists | **built** (STUDIO `branches`) |
| 2 | Task DAG | Viewer | High — explains gate/dedupe/staleness | Low; `TaskGraph` gives topology | **built** (FLOOR `graph`) |
| 6 | Refine loop | Viewer | High — best debugging artifact | Very low; pure projection | — |
| 8 | Gate blockers | Viewer | High — answers "why halted" | Very low | partly — the barrier node in FLOOR `graph`, not the bipartite view |
| 7 | Shot timeline | **Editor** (timeline) | High once art lands | Medium; new interaction model | **built** (FLOOR `timeline`) |
| 4 | Pipeline schematic | Diagram | Medium — legend for #2 | Very low | — |
| 5 | Asset provenance | Viewer | Medium | Low | — |
| 3 | Prompt assembly | Viewer → Editor | Medium → high | Low → architectural | — |
| 9 | Agent trace | Viewer | Low–medium | Low | — |
| 10 | Command history | Viewer | Low | Low | — |

If exactly one thing gets built: **the story branch editor**. If two: add the **task DAG**
viewer. If the heterogeneous adapter proposed at the top gets written
first, those two are its first two views and the rest are filters.

That is the one recommendation the build did *not* follow: #1, #2 and #7 shipped as three
independent projections sharing a domain-blind layout/routing canvas
(`apps/desktop/renderer/graph/`, which "may not know about scenes, choices or tasks"), not as
filters over one heterogeneous project-data adapter. Cross-view navigation is therefore still
hand-wired per view. Whether the adapter is worth writing now, with three views already built
against the seam, is an open question and no longer a cheap one.

## Open questions

- ~~Does the branch editor write back through `@vn/model`'s serializers, or does it own a
  separate mutation path?~~ **Answered: the serializers.** `story.*` → `session.editBranches`
  → `applySceneBranchEdit`, so the branch editor has no second write path.
- ~~Where does a graph room live relative to STUDIO · FLOOR · PLAY — a fourth room, or a mode
  within FLOOR?~~ **Answered: a mode within a room**, and `Room` stayed a three-value union —
  branches under STUDIO, the DAG and timeline under FLOOR.
- ~~Every mutation should route through `@vn/commands`~~ **— it does**; commands are the only
  write path. The coalescing question survives: a continuous drag still resolves to **one**
  command record at commit, so the intermediate states are not in the log and layout changes
  on commit rather than during the gesture.
- If prompt graphs become project data (§3), do they live in `project.yaml`, or as their own
  authored files alongside characters and locations?

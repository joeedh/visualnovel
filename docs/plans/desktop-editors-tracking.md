# Desktop editors — tracking

Live status across the desktop editor plans. Update this file as work lands; it is the index
the individual plans hang off. Survey that motivated them:
[`../research/graphThingsReport.md`](../research/graphThingsReport.md).

## Plans

| # | Plan | Kind | Status | Depends on |
| - | ---- | ---- | ------ | ---------- |
| 0 | [desktop-renderer-restructure](desktop-renderer-restructure.md) | refactor | not started | — |
| 1 | [refine-loop-inspector](refine-loop-inspector.md) | upgrade | not started | 0 |
| 2 | [story-branch-editor](story-branch-editor.md) | **new editor** | not started | 0 |
| 3 | [task-dag-view](task-dag-view.md) | upgrade | not started | 0, 2 (`renderer/graph/`) |
| 4 | [shot-timeline-editor](shot-timeline-editor.md) | **new editor** | blocked | 0, shot persistence, a real run |

Recommended order: **0 → 1 → 2 → 3 → 4.** 1 is small and independent, so it is a good first
exercise of the restructured layout. 2 creates `renderer/graph/`, which 3 consumes. 4 is last
because it needs generated art to be testable at all.

## Blockers found while planning

Three things turned up that were not visible from the outside. Each one changes the shape of
the work it touches, and two of them are pipeline concerns rather than UI concerns.

### The renderer is not typechecked (plan 0, Wave 1)

Root `pnpm check` includes only `packages/*/src` and `apps/*/src`. The renderer lives at
`apps/desktop/renderer/**` with its own `tsconfig.json` that **no script invokes**, and
`vite build` transpiles via esbuild without checking. Renderer type errors are invisible
until runtime today. Fixed first, before any new renderer code.

### There is no round-trip-safe screenplay writer (plan 2, Wave 1)

`sceneToFountain` (`packages/model/src/serialize.ts:71`) is documented as lossy —
`Scene.body` is flattened prose, so re-serializing destroys character cues and
parentheticals. It is for scaffolds and diff previews. `Scene` also carries no source
provenance.

The branch editor therefore needs a **surgical marker patcher** that rewrites only
`[[choice:]]` / `[[next:]]` lines and preserves every other byte, with a re-parse assertion
as the safety net. Mitigating factor: there is exactly one screenplay file
(`packages/store/src/worktree.ts:43` reads `fountain[0]` only).

### Shots are never persisted (plan 4, Wave 1)

`planTasks` decomposes scenes lazily into `scene.shots` in memory
(`packages/pipeline/src/planner.ts:116`); nothing writes them to disk. A shot editor has
nowhere to save an edit.

Worth fixing regardless of the editor: because the LLM decomposition path is
non-deterministic, two runs of the same project can produce different shots, which quietly
undermines dedupe and resumability for everything downstream of P5.

## Cross-cutting decisions

These apply to every plan; changing one is a decision to revisit here, not in a single plan.

- **Mutations route through `@vn/commands`**, never new IPC channels. One completed gesture →
  one command → one `CommandRecord`. No continuous drag mutates state mid-drag, so the
  coalescing problem never arises.
- **No manual node positions — so every drag is semantic.** `Scene` and `Task` have no
  coordinates, and adding a position store means inventing a UI-state file and deciding
  whether it is committed. Auto-layout only. The consequence is a rule, not a limitation:
  dragging a node never moves a box, it rewires the graph. In the branch editor that means
  connect (from an edge handle) and splice (drop a card on an edge); both are discrete acts
  that commit on drop. Revisit only if auto-layout proves unusable on a real script.
- **Read-only graphs stay read-only.** Splice applies to the branch editor only. The task DAG
  is derived from content hashes and has no authorable topology — dragging in it does nothing.
- **Pure logic in `.ts` with `tests/` siblings; `.tsx` stays thin.** Jest's desktop project is
  `**/apps/desktop/**/tests/*.test.ts` — `.ts` only, node environment, no jsdom. Layout,
  hit-testing, coverage math, and derivation are all pure and all tested; components are not.
- **No new accent hues.** The existing `--sodium` (warm — authored/human) and `--signal`
  (cool — machine/pipeline) split already encodes provenance. Editors spend those two.
- **Spend boldness once.** The branch editor's wire-typeset choice labels and the timeline's
  vertical script column are the two signature elements. Everything else — the DAG view
  especially — stays quiet instrument design.
- **`Room` stays a three-value union.** It is part of the command catalog contract. Editors
  are modes within rooms, reached via a new `view.mode(room, mode)` command and a
  `{ type: 'mode' }` `UiEffect`.

## Not being built

Decided against in the survey, recorded here so it does not get re-proposed:

- **Prompt node editor.** Converts deterministic plumbing into user data, and every edit
  rehashes downstream tasks — casual fiddling silently invalidates generated art. A read-only
  prompt breakdown in the inspector gets most of the value at none of the cost.
- **Agent trace visualizer** — not an editor, not a current pain point.
- **Command history / git lane view** — low value until an undo strategy is chosen
  ([`../gitUndoOptions.md`](../gitUndoOptions.md)).
- **debug2d fragment tree UI** — stays a dev-only console/CDP surface; wiring it into the app
  would violate the isolation that makes it strippable.
- **Package layering graph** — build-time metadata, changes rarely, no runtime value.

## Checklist

### 0 · Restructure

- [ ] `pnpm check` covers the renderer and is green
- [ ] `App.tsx` under 120 lines; shell only
- [ ] One directory per room
- [ ] `styles/` split, cascade order preserved
- [ ] `CLAUDE.md` toolchain notes updated

### 1 · Refine-loop inspector

- [ ] `reviews` validated at the main-process boundary
- [ ] Attempts render as a causal spine with defects and thumbnails
- [ ] Correction delta correct across strip-and-replace
- [ ] `needs_human` explains itself

### 2 · Story branch editor

- [ ] `applySceneBranchEdit` + re-parse assertion, multi-scene edits applied atomically
- [ ] `renderer/graph/` primitives, deterministic, tested
- [ ] `story.*` commands registered and CDP-driveable
- [ ] Drag-to-splice: four semantic rules held, refusals visible during the drag
- [ ] Edge rewire changes only marker lines in `git diff`
- [ ] `vngen graph` and the editor agree

### 3 · Task DAG view

- [ ] List/graph toggle; shared inspector
- [ ] `deps` solid, ref-edges dashed
- [ ] Gate rendered as a derived barrier
- [ ] Not-yet-plannable work ghosted, not omitted
- [ ] Acceptable at 300 nodes

### 4 · Shot timeline

- [ ] Shots persist under `vngen/work/`, schema-validated
- [ ] Stale line ids drop with a diagnostic
- [ ] Gaps and overlaps visible; non-contiguous coverage handled
- [ ] `coversLines` edits provably do not rehash
- [ ] Round-trip verified through `story.play.json`

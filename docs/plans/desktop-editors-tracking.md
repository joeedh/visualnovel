# Desktop editors — tracking

Live status across the desktop editor plans. Update this file as work lands; it is the index
the individual plans hang off. Survey that motivated them:
[`../research/graphThingsReport.md`](../research/graphThingsReport.md).

## Plans

| # | Plan | Kind | Status | Depends on |
| - | ---- | ---- | ------ | ---------- |
| — | [test-fixtures](test-fixtures.md) | groundwork | **done** | — |
| 0 | [desktop-renderer-restructure](desktop-renderer-restructure.md) | refactor | **done** | — |
| 1 | [refine-loop-inspector](refine-loop-inspector.md) | upgrade | **done** | 0, testkit |
| 2 | [story-branch-editor](story-branch-editor.md) | **new editor** | **done** | 0, testkit |
| 3 | [task-dag-view](task-dag-view.md) | upgrade | not started | 0, 2 (`renderer/graph/`), testkit |
| 4 | [shot-timeline-editor](shot-timeline-editor.md) | **new editor** | blocked | 0, testkit, shot persistence, a real run |

Recommended order: **test-fixtures → 0 → 1 → 2 → 3 → 4.** test-fixtures and 0 are both
"make the ground testable" work and are independent of each other, so they can run in
parallel. 1 is small and independent, so it is a good first exercise of the restructured
layout. 2 creates `renderer/graph/`, which 3 consumes. 4 is last because it needs generated
art to be testable at all.

## Blockers found while planning

Four things turned up that were not visible from the outside. Each one changes the shape of
the work it touches, and two of them are pipeline concerns rather than UI concerns.

### There is no on-disk project fixture (test-fixtures, all plans)

Twelve test files roll their own `mkdtemp`, and the two most complete fixtures are
incompatible — `apps/cli` writes a one-character/one-scene project to disk, while `pipeline`
and `scheduler` hand-build in-memory `ProjectModel` literals. Nothing produces a git-backed,
multi-scene, actually-*run* project, which is what four of the five checklists below assert
against. Split out into [test-fixtures](test-fixtures.md).

**Resolved** — `@vn/testkit` ships `makeProject` / `synthProject` / `SCRIPTS`; the `cli`,
`scheduler`, `pipeline`, `export` and `authoring-app` fixtures are migrated onto it, and
`WorkspaceSession` has a suite for the first time.

### The renderer is not typechecked (plan 0, Wave 1)

Root `pnpm check` includes only `packages/*/src` and `apps/*/src`. The renderer lives at
`apps/desktop/renderer/**` with its own `tsconfig.json` that **no script invokes**, and
`vite build` transpiles via esbuild without checking. Renderer type errors are invisible
until runtime today. Fixed first, before any new renderer code.

**Resolved** — `pnpm check` is now `tsgo -p tsconfig.json && pnpm check:renderer`, the second
pass running `tsgo --noEmit -p renderer/tsconfig.json` in `apps/desktop`. It was clean on the
first run and was verified to fail on a deliberately introduced type error.

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
- **Project fixtures come from `@vn/testkit`, not from a new `mkdtemp` block.** Anything an
  editor test asserts against — a branching screenplay, a git repo, a completed mock run —
  is built by [test-fixtures](test-fixtures.md). A new bespoke builder is a signal that
  testkit is missing an option.
- **No new accent hues.** The existing `--sodium` (warm — authored/human) and `--signal`
  (cool — machine/pipeline) split already encodes provenance. Editors spend those two.
- **Spend boldness once.** The branch editor's wire-typeset choice labels and the timeline's
  vertical script column are the two signature elements. Everything else — the DAG view
  especially — stays quiet instrument design.
- **`Room` stays a three-value union.** It is part of the command catalog contract. Editors
  are modes within rooms, reached via a new `view.mode(room, mode)` command and a
  `{ type: 'mode' }` `UiEffect`.

## Debugging lessons

These plans touch three surfaces that are awkward to debug — an Electron main/renderer split,
an auto-laid-out canvas, and a content-addressed task graph where a wrong hash shows up as
silently-repeated work rather than an error. What is learned getting each one working is
worth more than the code, and it is exactly what gets forgotten by the next plan.

So, in addition to the two steps in CLAUDE.md's [Finishing a plan](../../CLAUDE.md#finishing-a-plan):

- **At the end of every plan, append a section to
  [`../research/debug-lessons-learned.md`](../research/debug-lessons-learned.md)** — created
  by whichever plan finishes first. One section per plan, headed with the plan name; the
  append lands in that plan's own final commit, so the file accumulates in history as the
  work proceeds. Record what actually went wrong and how it was found: the symptom as first
  observed, the tool or query that produced the evidence, and the false trail if there was
  one. A lesson with no symptom attached is not a lesson.
  - Prefer concrete artifacts over prose — the `__vnDebug` expression, the `vn-cdp.mjs`
    invocation, the jest incantation, the assertion that finally pinned it.
  - Note anything that made a bug *hard* to see, not just the bug: a swallowed rejection, a
    dev/prod behavioral split, a Windows-only path or line-ending difference.
  - Negative results count. "Screenshots were useless here, `explainPick` answered it in one
    call" is the sort of thing [`../debugGuide.md`](../debugGuide.md) exists to say.
- **When all plans in the table above are done, consolidate that file into
  [`../debugGuide.md`](../debugGuide.md)** — reorganized by symptom and kept cheapest-first,
  matching the guide's existing shape rather than appended as a log. Lessons that turned out
  to be one-offs get dropped in the consolidation; that editorial pass is the point.
  `debug-lessons-learned.md` is scratch that earns its way into the guide, so it is deleted
  once consolidated — but **in two commits, never one**:
  1. Commit `debug-lessons-learned.md` complete, with every plan's section present and the
     file otherwise untouched. This is the commit that puts the raw material in history.
  2. Then, separately, commit the consolidated `debugGuide.md` **and** the deletion.

  Deleting in the same commit that rewrites the content makes the dropped one-offs
  recoverable only by reading a diff. Two commits means `git show <commit>:<path>` returns
  the full file, and the second commit's diff shows exactly what the editorial pass chose
  to drop.

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

### — · Test fixtures

- [x] `@vn/testkit` builds, typechecks, and has its own green jest project
- [x] `makeProject` → run → approve → run clears the gate, on disk, from disk
- [x] `synthProject` deterministic; scenes-to-tasks ratio pinned
- [x] Project-shaped `mkdtemp` sites migrated
- [x] One end-to-end on-disk run test and one `WorkspaceSession` test exist

### 0 · Restructure

- [x] `pnpm check` covers the renderer and is green
- [x] `App.tsx` under 120 lines; shell only
- [x] One directory per room
- [x] `styles/` split, cascade order preserved
- [x] `CLAUDE.md` toolchain notes updated

### 1 · Refine-loop inspector

- [x] `reviews` validated at the main-process boundary
- [x] Attempts render as a causal spine with defects and thumbnails
- [x] Correction delta correct across strip-and-replace
- [x] `needs_human` explains itself

### 2 · Story branch editor

- [x] `applySceneBranchEdit` + re-parse assertion, multi-scene edits applied atomically
- [x] `renderer/graph/` primitives, deterministic, tested
- [x] `story.*` commands registered and CDP-driveable
- [x] Drag-to-splice: four semantic rules held, refusals visible during the drag
- [x] Edge rewire changes only marker lines in `git diff`
- [x] `vngen graph` and the editor agree

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

### Debug lessons

One box per plan, ticked when that plan appends its section to
`../research/debug-lessons-learned.md`. The last box is the consolidation — it is the only
item in this file that cannot be done early.

- [x] test-fixtures
- [x] 0 · Restructure
- [x] 1 · Refine-loop inspector
- [x] 2 · Story branch editor
- [ ] 3 · Task DAG view
- [ ] 4 · Shot timeline
- [ ] Scratch file committed complete, on its own, before any consolidation edits
- [ ] Consolidated into `../debugGuide.md`, reorganized by symptom; scratch file deleted in a
      second commit

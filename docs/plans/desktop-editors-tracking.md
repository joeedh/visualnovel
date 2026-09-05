# Desktop editors — tracking

Tracks live status across the desktop editor plans. Update this file as work lands; it indexes the individual plans.
The survey that motivated them is [`../research/graphThingsReport.md`](../research/graphThingsReport.md).

## Plans

| # | Plan | Kind | Status | Depends on |
| - | ---- | ---- | ------ | ---------- |
| — | [test-fixtures](archive/INDEX.md#test-fixtures) | groundwork | **done** | — |
| 0 | [desktop-renderer-restructure](archive/INDEX.md#desktop-renderer-restructure) | refactor | **done** | — |
| 1 | [refine-loop-inspector](archive/INDEX.md#refine-loop-inspector) | upgrade | **done** | 0, testkit |
| 2 | [story-branch-editor](archive/INDEX.md#story-branch-editor) | **new editor** | **done** | 0, testkit |
| 3 | [task-dag-view](archive/INDEX.md#task-dag-view) | upgrade | **done** | 0, 2 (`renderer/graph/`), testkit |
| 4 | [shot-timeline-editor](archive/INDEX.md#shot-timeline-editor) | **new editor** | **done** | 0, testkit, ~~shot persistence~~, ~~a real run~~ |

Recommended order: test-fixtures → 0 → 1 → 2 → 3 → 4. test-fixtures and 0 both make the existing code testable and are
independent of each other, so they can run in parallel. 1 is small and independent, so it is a good first exercise of
the restructured layout. 2 creates `renderer/graph/`, which 3 consumes. 4 is last because it needs generated art to be
testable at all. Mock runs now supply that art as marked placeholder PNGs, so only the final acceptance pass depends on
a real run.

## Blockers found while planning

Four things turned up that were not visible from the outside. Each one changes the work it affects, and two of them are
pipeline concerns rather than UI concerns.

### There is no on-disk project fixture (test-fixtures, all plans)

Twelve test files roll their own `mkdtemp`, and the two most complete fixtures are incompatible: `apps/cli` writes a
one-character/one-scene project to disk, while `pipeline` and `scheduler` hand-build in-memory `ProjectModel` literals.
Four of the five checklists below assert against a git-backed, multi-scene project that has actually been run, and no
fixture produces one. Split out into [test-fixtures](archive/INDEX.md#test-fixtures).

**Resolved** — `@vn/testkit` ships `makeProject` / `synthProject` / `SCRIPTS`; the `cli`,
`scheduler`, `pipeline`, `export` and `authoring-app` fixtures are migrated onto it, and
`WorkspaceSession` has a suite for the first time.

### The renderer is not typechecked (plan 0, Wave 1)

Root `pnpm check` includes only `packages/*/src` and `apps/*/src`. The renderer source is under
`apps/desktop/renderer/**` and has its own `tsconfig.json`, which no script invokes, and `vite build` transpiles via
esbuild without checking. Renderer type errors therefore surface only at runtime today. Fix this first, before writing
any new renderer code.

**Resolved** — `pnpm check` is now `tsgo -p tsconfig.json && pnpm check:renderer`. The second pass runs `tsgo --noEmit
-p renderer/tsconfig.json` in `apps/desktop`. It was clean on the first run and was verified to fail on a deliberately
introduced type error.

### There is no round-trip-safe screenplay writer (plan 2, Wave 1)

`sceneToFountain` (packages/model/src/serialize.ts:71) is documented as lossy. `Scene.body` is flattened prose, so
re-serializing destroys character cues and parentheticals. `sceneToFountain` serves scaffolds and diff previews.
`Scene` also carries no source provenance.

The branch editor therefore needs a surgical marker patcher that rewrites only `[[choice:]]` and `[[next:]]` lines and
preserves every other byte, with a re-parse assertion as the safety net. One fact mitigates this: there is exactly one
screenplay file (`packages/store/src/worktree.ts:43` reads `fountain[0]` only).

**Resolved** — [`archive/INDEX.md#lossless-scene-serialization`](archive/INDEX.md#lossless-scene-serialization) rewrote
`sceneToFountain` against `Scene.lines` and retired `Scene.body` entirely. A property test enforces the contract
`parse(write(scene)) ≡ scene`. The surgical patcher stays for inherited files, where it preserves the author's
formatting.

### Shots are never persisted (plan 4, Wave 1)

`planTasks` decomposes scenes lazily into `scene.shots` in memory (packages/pipeline/src/planner.ts:116); nothing
writes them to disk. A shot editor has nowhere to save an edit.

This is worth fixing regardless of the editor. The LLM decomposition path is non-deterministic, so two runs of the same
project can produce different shots, which undermines dedupe and resumability for everything downstream of P5.

## Cross-cutting decisions

These apply to every plan. Change one here rather than in a single plan.

- **Mutations route through `@vn/commands`**, never new IPC channels. Each completed gesture produces one command,
  and each command produces one `CommandRecord`. No continuous drag mutates state mid-drag, so nothing needs
  coalescing.
- **No manual node positions.** `Scene` and `Task` have no coordinates, and adding a position store means inventing a
  UI-state file and deciding whether it is committed. Auto-layout only. Every drag is therefore semantic: dragging a
  node rewires the graph rather than moving a box. In the branch editor that means connect (from an edge handle) and
  splice (drop a card on an edge), and both are discrete acts that commit on drop. Revisit only if auto-layout proves
  unusable on a real script.
- **Read-only graphs are not editable.** Splice applies to the branch editor only. The task DAG is derived from
  content hashes and has no authorable topology, so dragging in it does nothing.
- **Pure logic lives in `.ts` with `tests/` siblings, and `.tsx` stays thin.** Jest's desktop project is
  `**/apps/desktop/**/tests/*.test.ts` (`.ts` only, node environment, no jsdom). Layout, hit-testing, coverage math,
  and derivation are all "pure" (side-effect-free) and all tested. Components are neither pure nor tested.
- **Project fixtures come from `@vn/testkit`, not from a new `mkdtemp` block.**
  [test-fixtures](archive/INDEX.md#test-fixtures) builds anything an editor test asserts against (a branching
  screenplay, a git repo, a completed mock run). A new bespoke builder indicates that testkit is missing an option.
- **No new accent hues.** The existing `--sodium` (warm — authored/human) and `--signal` (cool — machine/pipeline)
  split already encodes provenance. Editors use those two hues and add none.
- **Use bold styling in only two places.** The branch editor's wire-typeset choice labels and the timeline's vertical
  script column are the two signature elements. Everything else (the DAG view above all) follows a restrained
  instrument design.
- **`Room` stays a three-value union.** That union is part of the command catalog contract. An editor is a mode
  within a room, reached through a new `view.mode(room, mode)` command and a `{ type: 'mode' }` `UiEffect`.

## Debugging lessons

These plans touch three surfaces that are awkward to debug: an Electron main/renderer split, an auto-laid-out canvas,
and a content-addressed task graph where a wrong hash shows up as silently-repeated work rather than an error. What a
person learns getting each one working is worth more than the code, and it is what whoever writes the next plan has
forgotten.

**Done** — every plan appended its section, and the accumulated file was consolidated into
[`../guides/debugGuide.md`](../guides/debugGuide.md) and deleted. The full scratch file is in history at `git show
6d1029b:docs/research/debug-lessons-learned.md`; the consolidation commit's diff records what the editorial pass chose
to drop. The procedure below was followed, and is kept because the next batch of plans should follow it too:

- **At the end of every plan, append a section to `../research/debug-lessons-learned.md`** — whichever plan finishes
  first creates the file. Each plan adds one section headed with the plan name, and the append lands in that plan's own
  final commit, so the file accumulates in history as the work proceeds. Record what actually went wrong and how it was
  found: the symptom as first observed, the tool or query that produced the evidence, and the false trail if there was
  one. Every lesson must state the symptom it came from.
  - Prefer concrete artifacts over prose: the `__vnDebug` expression, the `vn-cdp.mjs` invocation, the jest
    incantation, the assertion that pinned the bug.
  - Note anything that made a bug hard to see, not just the bug: a swallowed rejection, a dev/prod behavioral split,
    a Windows-only path or line-ending difference.
  - Negative results count. [`../guides/debugGuide.md`](../guides/debugGuide.md) is where a note like "Screenshots
    were useless here, `explainPick` answered it in one call" belongs.
- **When all plans in the table above are done, consolidate that file into
  [`../guides/debugGuide.md`](../guides/debugGuide.md)**. Reorganize the entries by symptom and keep them
  cheapest-first, matching the guide's existing shape rather than appending them as a log. Drop lessons that turned out
  to be one-offs; the consolidation exists for that editorial pass. `debug-lessons-learned.md` holds scratch notes
  until they are consolidated into the guide, so delete it once that is done, in two commits, never one:
  1. 1. Commit the complete `debug-lessons-learned.md`, with every plan's section present and the file otherwise
     untouched. This commit puts the raw material into history.
  2. 2. Then, separately, commit the consolidated `debugGuide.md` and the deletion.

  Deleting in the same commit that rewrites the content leaves the dropped one-offs recoverable only by reading a diff.
  With two commits, `git show <commit>:<path>` returns the full file, and the diff of the second commit shows exactly
  what the editorial pass dropped.

## Not being built

The survey decided against the following. They are recorded here so that they are not re-proposed:

- **Prompt node editor.** Superseded by the Gen Graph pane
  ([`node-based-asset-generation.md`](node-based-asset-generation.md), shipped and described in
  [`../reference/gen-graphs.md`](../reference/gen-graphs.md)), which answers the objection this entry was written for.
  The objection was that turning deterministic plumbing into user data rehashes downstream tasks on every edit, so
  casual fiddling silently invalidates generated art. A generation graph is a document the author opts into per slot,
  the deterministic runners are still there for every slot nothing is bound to, and a node's journal records what each
  hash produced, so the journal names which work an edit invalidates.
- **Agent trace visualizer** — This is a viewer rather than an editor, and no current pain point calls for it.
- **Command history / git lane view** — this stays low value until an undo strategy is chosen
  ([`../history/gitUndoOptions.md`](../history/gitUndoOptions.md)).
- **debug2d fragment tree UI** — remains a dev-only console/CDP surface. Wiring it into the app would break the
  isolation that keeps it strippable.
- **Package layering graph** — build-time metadata that changes rarely and has no runtime value.

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

- [x] List/graph toggle; shared inspector
- [x] `deps` solid, ref-edges dashed
- [x] Gate rendered as a derived barrier
- [x] Not-yet-plannable work ghosted, not omitted
- [x] Acceptable at 300 nodes

### 4 · Shot timeline

- [x] Shots persist under `vngen/work/`, schema-validated _(Wave 1)_
- [x] Stale line ids drop with a diagnostic _(Wave 1)_
- [x] Gaps and overlaps visible; non-contiguous coverage handled _(Wave 2)_
- [x] `coversLines` edits provably do not rehash _(Wave 1)_
- [x] Round-trip verified through `story.play.json` _(Wave 2, live over CDP)_
- [x] Acceptance pass on a real non-mock run _(run against `examples/mySampleRepo` with real
      Gemini art and a real Claude text model for P5: the fixed P5 prompt produced one shot per
      scene covering every line with no gaps, and `rooftop`'s alternating-speaker coverage read
      correctly on real art — see
      [`archive/INDEX.md#shot-timeline-editor`](archive/INDEX.md#shot-timeline-editor))_

### Debug lessons

Each plan has one box, ticked when that plan appends its section to `../research/debug-lessons-learned.md`. The last
box tracks the consolidation, which is the only item in this file that cannot be done early.

- [x] test-fixtures
- [x] 0 · Restructure
- [x] 1 · Refine-loop inspector
- [x] 2 · Story branch editor
- [x] 3 · Task DAG view
- [x] 4 · Shot timeline
- [x] Scratch file committed complete, before any consolidation edits — `6d1029b`, plan 4's
      own final commit, which is where the last section landed
- [x] Consolidated into `../debugGuide.md`, reorganized by symptom; scratch file deleted in a
      second commit

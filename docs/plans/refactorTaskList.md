# Refactor task list

**Draft.** The master tracker for the refactor from the app as shipped to the app
[`../designRequirementsEtc.md`](../designRequirementsEtc.md) describes. Like
[`desktop-editors-tracking.md`](desktop-editors-tracking.md), this is not a plan — it is the
list of plans, their ordering constraints, and the decisions that bind them. Each work item
below either links to its plan or is marked **needs plan**; a plan is the authority on its own
scope, [`index.md`](index.md) stays the authority on status.

## Decisions taken so far

- **The UX is rewritten on path.ux** — frame manager *and* widget library, because
  `FrameManager.ts` hard-imports the widget modules and `Area`/`ScreenArea` are `UIBase`
  custom elements; "frame manager alone" was found not to be separable. React is displaced
  from the renderer. path.ux will be cloned from GitHub as a **git submodule**.
- **path-controller is not adopted** as the app↔UX glue. Its DataAPI/pathwatch assumes a
  long-lived mutable in-memory model; this app's renderer state is immutable IPC snapshots,
  and `@vn/commands` already covers what `toolsys`/`toolprop` would provide, with git
  provenance and the `stack.check` refusal protocol. What we take is the *pattern* of a
  generated, machine-readable path/API catalog (path.ux's `API_PATHS.md` /
  `KnownDataPath`), which mirrors the existing `commands.json`.
- **Requirements are the spec.** `docs/designRequirementsEtc.md` §UX *specifies* the
  subdividing dockable UX; linear-workflow concerns are constraints to satisfy inside the
  pane model, not reasons to revisit it.

## Work items

| # | Item | Status | Plan / artifact |
| --- | --- | --- | --- |
| 0 | Codebase migration report — how the non-UX codebase gets to the new requirements | **written** | [`../research/codebase-migration-for-new-requirements.md`](../research/codebase-migration-for-new-requirements.md) |
| 1 | Desktop app rewrite on path.ux (submodule, screen mesh, editors as Areas, keymaps, theme) | **all six steps shipped** — the submodule + build wiring, the shell (screen boot, theme, persistence, header/menu, palette), ports 1–7 (Play runner, task graph, task list + inspector, coverage timeline, branch canvas, script pane, vnauthor conversation), the flag flip (the app boots path.ux; `--react` boots the room shell), the room vocabulary's retirement (`view.*` addresses editors) and the docs, reorganized by editor. Outstanding: deleting the retired React shell, the `--react` flag and `react`/`react-dom`, held one release | [`pathux-desktop-rewrite.md`](pathux-desktop-rewrite.md) |
| 2 | Entity discovery by meta tag (character/location files found by tag, not fixed path; `LoadedInputs` carries source paths for all doc kinds) | **shipped** | [`entity-discovery-by-meta-tag.md`](entity-discovery-by-meta-tag.md) |
| 3 | Story bible / `wiki/` subtree + retrieval (grep-first), agent tools over it | **shipped** | [`story-bible-and-retrieval.md`](story-bible-and-retrieval.md) → [`../story-bible.md`](../story-bible.md) |
| 4 | Repo map + commit-on-save policy (multi-repo: project / wiki / base assets; revisit of [`../gitUndoOptions.md`](../gitUndoOptions.md) under the new constraint) | **shipped** | [`repo-map-and-commit-on-save.md`](repo-map-and-commit-on-save.md) → [`../repos-and-commits.md`](../repos-and-commits.md) |
| 5 | Base vs project asset store split (two content-addressed roots, one provenance story) | **shipped** | [`base-and-project-asset-stores.md`](base-and-project-asset-stores.md) → [`../asset-stores.md`](../asset-stores.md) |
| 6 | Outfits at scene and shot level (forces the "front-matter is identity only" revisit that [`index.md`](index.md#decisions-that-span-the-batch) already marks as due) | **shipped** | [`outfits-at-scene-and-shot-level.md`](outfits-at-scene-and-shot-level.md) |
| 7 | Shot ordering / shots as line containers (reorder shots inside a scene) | **shipped** | [`shot-ordering-in-scenes.md`](shot-ordering-in-scenes.md) |
| 8 | Agent context regeneration (manual `workspace.reindex`-style command first, automatic later) | **shipped** | [`agent-context-regeneration.md`](agent-context-regeneration.md) |
| 9 | Backlink / document-tree index (character → bible file, base assets, scenes and shots; backs the sidebar tree) | **shipped** | [`document-tree-and-backlinks.md`](document-tree-and-backlinks.md) → [`../document-tree.md`](../document-tree.md) |
| 10 | Project bootstrap (directory picker, `git init`, auto-commit of existing files) | **shipped** | [`project-bootstrap-and-workspace-picker.md`](project-bootstrap-and-workspace-picker.md) — `openWorkspace`, `workspace.open`/`pick`/`recent`, an in-place switch, and a launch precedence that remembers the last project; the `git init` + auto-commit half had already shipped as `ensureRepo` in [`repo-map-and-commit-on-save.md`](repo-map-and-commit-on-save.md) |
| 11 | Bug: `App.tsx:100` `{ mock: !isLive \|\| true }` makes the FLOOR run button always a dry run | **fixed** | `apps/desktop/renderer/app/App.tsx` now passes `{ mock: !isLive }` |

Ordering constraints, and the design decisions each plan must settle first, are in the
migration report (item 0) — it is the input to writing plans 2–10. Item 1 is independent of
2–10 in code (it replaces the renderer; the main process, IPC shapes and command registry
carry over) but every new backend capability lands as commands + index shapes that the new
editors then present, so plans should state which side of that seam they are on.

## Sequencing sketch (from the report)

1. Item 2 (tag discovery + source paths) is the foundation — 3, 6 and 9 all sit on it.
2. Item 4 (repo map + commit policy) blocks 3's "wiki in its own repo" option and 10.
3. Item 5 (asset split) is independent of the wiki work; only 9 reads both.
4. Items 7 and 6 touch the same files (`work/shots/<sceneId>.json`, scene chunks). **Ordered
   7 before 6**: shot ordering adds no authored field to the shots file and re-renders
   nothing, while outfits add one and deliberately re-hash shots — so what a shot's *position*
   is gets settled before the outfit override arrives into that file. See
   [`shot-ordering-in-scenes.md`](shot-ordering-in-scenes.md).
5. Item 1 (path.ux rewrite) can start in parallel; it consumes whatever index/command
   surface exists at the time.

## Keeping this file true

Update the row when an item gets its plan (link it) or ships (mark it, and add the plan to
[`index.md`](index.md)). Decisions that bind more than one plan get recorded under
"Decisions taken so far" in the same commit that takes them.

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
| 1 | Desktop app rewrite on path.ux (submodule, screen mesh, editors as Areas, keymaps, theme) | **planned** | [`pathux-desktop-rewrite.md`](pathux-desktop-rewrite.md) |
| 2 | Entity discovery by meta tag (character/location files found by tag, not fixed path; `LoadedInputs` carries source paths for all doc kinds) | **planned** | [`entity-discovery-by-meta-tag.md`](entity-discovery-by-meta-tag.md) |
| 3 | Story bible / `wiki/` subtree + retrieval (grep-first), agent tools over it | needs plan | — |
| 4 | Repo map + commit-on-save policy (multi-repo: project / wiki / base assets; revisit of [`../gitUndoOptions.md`](../gitUndoOptions.md) under the new constraint) | needs plan | — |
| 5 | Base vs project asset store split (two content-addressed roots, one provenance story) | needs plan | — |
| 6 | Outfits at scene and shot level (forces the "front-matter is identity only" revisit that [`index.md`](index.md#decisions-that-span-the-batch) already marks as due) | needs plan | — |
| 7 | Shot ordering / shots as line containers (reorder shots inside a scene) | needs plan | — |
| 8 | Agent context regeneration (manual `workspace.reindex`-style command first, automatic later) | needs plan | — |
| 9 | Backlink / document-tree index (character → bible file, base assets, scenes and shots; backs the sidebar tree) | needs plan | — |
| 10 | Project bootstrap (directory picker, `git init`, auto-commit of existing files) | needs plan | — |
| 11 | Bug: `App.tsx:100` `{ mock: !isLive \|\| true }` makes the FLOOR run button always a dry run | **open bug** | independent of everything above; fix any time |

Ordering constraints, and the design decisions each plan must settle first, are in the
migration report (item 0) — it is the input to writing plans 2–10. Item 1 is independent of
2–10 in code (it replaces the renderer; the main process, IPC shapes and command registry
carry over) but every new backend capability lands as commands + index shapes that the new
editors then present, so plans should state which side of that seam they are on.

## Sequencing sketch (from the report)

1. Item 2 (tag discovery + source paths) is the foundation — 3, 6 and 9 all sit on it.
2. Item 4 (repo map + commit policy) blocks 3's "wiki in its own repo" option and 10.
3. Item 5 (asset split) is independent of the wiki work; only 9 reads both.
4. Items 7 and 6 touch the same files (`work/shots/<sceneId>.json`, scene chunks) — order
   them relative to each other when planned.
5. Item 1 (path.ux rewrite) can start in parallel; it consumes whatever index/command
   surface exists at the time.

## Keeping this file true

Update the row when an item gets its plan (link it) or ships (mark it, and add the plan to
[`index.md`](index.md)). Decisions that bind more than one plan get recorded under
"Decisions taken so far" in the same commit that takes them.

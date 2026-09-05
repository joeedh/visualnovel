# The cost of editing a generation graph — tasklist

Status: **shipped**. Dragging a slider or typing into a field in the Gen Graph pane is slow,
and the causes lie outside the graph. Four plans, independent of each other, address that same
complaint.

Each plan is the authority on its own scope and decisions. This page records what the four
plans are, why they are separate, and what order they can be taken in.

| # | Plan | Covers |
| --- | --- | --- |
| 1 | [`archive/deferring-commit-on-save.md`](archive/deferring-commit-on-save.md) | Batching the git commit a run of consecutive edits produces, in `@vn/commands`. Shipped |
| 2 | [`archive/gengraph-node-editor-data-api.md`](archive/gengraph-node-editor-data-api.md) | A scoped path.ux DataAPI over the live graph, so the pane stops rebuilding every widget by hand and stops reloading the whole file per edit. Shipped |
| 3 | [`archive/document-versions-and-live-reads.md`](archive/document-versions-and-live-reads.md) | Per-document write versions, so a pane can tell the echo of its own write from somebody else's and stops snapping a dragged node back. Shipped |
| 4 | [`archive/precise-write-signals.md`](archive/precise-write-signals.md) | Undo reporting the paths it moved, one `touchesInputs` predicate, the header following writes rather than commands, and a project's documents read in parallel. Shipped |

## What the cost is made of

One node property edit runs one command, and that command does four things. Three of those four
steps run whether or not the author is dragging.

- **A read.** `decide()` in apps/desktop/src/main/commands/gengraph.ts:49 reads the graph
  from disk on every edit by calling `readGraph(ctx.root, slug, ctx.git)`, including on `check`
  during a drag.
- **A write.** `edit()` writes the whole graph JSON back
  (`apps/desktop/src/main/commands/gengraph.ts:79`).
- **Seven or more git invocations.** `packages/commands/src/stack.ts:131` awaits the commit
  inline in the command's execution path, and `packages/commands/src/commit.ts:89` passes
  `paths: ['-A']`, covering the whole worktree with no exclusions and never consulting the undo
  journal's pathspec. The commit is not the only pass over the worktree. `gitState`
  (`stack.ts:98`) runs `git status --porcelain` over the same whole worktree before the command
  even starts, and two `write-tree` snapshots bracket it. In a real project `vngen/` is
  committed, generated assets included, so each of those scans walks a tree that may hold
  thousands of images. Nobody has measured which one dominates, and plan 1 measures before
  making any change.
- **The pane reloads.** apps/desktop/renderer/pathux/bridge.ts:187 invalidates on every
  successful mutating command, and the Gen Graph pane's `load()` re-reads the whole file and
  rebuilds the view.

Plan 1 covers the commit. Plan 2 covers the reload and the widget rebuild that comes with it.
Both plans deliberately leave the write alone: deferring it would leave the file on disk out of
date, which affects the pipeline, undo, and the content-addressed task hash at once. Both plans
name it as a non-goal rather than scheduling it.

Plans 3 and 4 came out of two more layers found under the reload. Plan 2 stopped the pane
rebuilding its widgets, but the pane still adopted the echo of its own write, which is why a
dragged node snapped backwards. Plan 3 addresses that. Beneath that layer, every command made
every window reload and revalidate the whole project, measured at ~400 ms per window on a
mid-size project for a write that touched one file under `vngen/work/graphs/`. Plan 4 addresses
that.

## Why the two are separate

They share a symptom and nothing else.

Plan 1 lives in `@vn/commands` and does not concern graphs. It would speed up any run of
consecutive commands in any editor. It changes no UI and needs no path.ux work.

Plan 2 is confined to `apps/desktop/renderer/pathux/editors/nodes.ts` and the DataAPI beside
it. It changes no main-process behaviour, so it leaves undo, provenance, the pipeline and
commit-on-save untouched.

Neither depends on the other, and either alone is a real improvement. Taking plan 1 first is
recommended only because it is smaller and its risk is better understood.

## The list

- [x] 1 — defer and batch commit-on-save
- [x] 2 — a scoped DataAPI for the node editor
- [x] 3 — document versions, so a pane skips the echo of its own write
- [x] 4 — precise write signals, and loading a project in parallel

## Non-goals for the batch

- **Deferring the graph file write.** An in-memory accumulator in main (with `readGraph`
  routed through it) is the third and largest of the three deferrals. It needs a second undo
  snapshot class holding serialized graph state, a `:(exclude)vngen/work/graphs` entry in the
  journal's pathspec, and a content-sha drift check at flush. It also opens a failure mode the
  other two do not: node props feed `nodeHash` (packages/gengraph/src/hash.ts:16), so a
  pipeline run against a stale file hashes to the old content address and returns a dedupe hit.
  The author sees an instant "done" and the unchanged picture, and nothing reports an error. It
  is not scheduled.
- **A general data API for the application.** `apps/desktop/renderer/pathux/api.ts`
  deliberately maps `ShellState` alone, because the project model is reached through IPC and
  mutated through commands. Plan 2 adds a scoped exception for one editor over data that
  path.ux already describes; it does not reverse that stance.

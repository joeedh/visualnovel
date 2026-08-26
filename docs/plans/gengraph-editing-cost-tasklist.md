# The cost of editing a generation graph — tasklist

Status: **planned**. Two plans, independent of each other, both aimed at the same complaint:
dragging a slider or typing into a field in the Gen Graph pane is slow, and it is slow for
reasons that have nothing to do with the graph.

Each plan is the authority on its own scope and decisions. This page records what the two
are, why they are separate, and what order they can be taken in.

| # | Plan | Covers |
| --- | --- | --- |
| 1 | [`archive/deferring-commit-on-save.md`](archive/deferring-commit-on-save.md) | Batching the git commit a run of consecutive edits produces, in `@vn/commands`. Shipped |
| 2 | [`gengraph-node-editor-data-api.md`](gengraph-node-editor-data-api.md) | A scoped path.ux DataAPI over the live graph, so the pane stops rebuilding every widget by hand and stops reloading the whole file per edit |

## What the cost is made of

One node property edit runs one command, and that command does four things. Three of them are
paid whether or not the author is dragging.

- **A read.** `decide()` in `apps/desktop/src/main/commands/gengraph.ts:49` calls
  `readGraph(ctx.root, slug, ctx.git)` from disk on every edit, including on `check` during a
  drag.
- **A write.** `edit()` writes the whole graph JSON back
  (`apps/desktop/src/main/commands/gengraph.ts:79`).
- **Seven or more git invocations.** `packages/commands/src/stack.ts:131` awaits the commit
  inline in the command's execution path, and `packages/commands/src/commit.ts:89` passes
  `paths: ['-A']` — the whole worktree, no exclusions, never consulting the undo journal's
  pathspec. The commit is not alone: `gitState` (`stack.ts:98`) runs `git status --porcelain`
  over the same whole worktree before the command even starts, and two `write-tree` snapshots
  bracket it. In a real project `vngen/` is committed, generated assets included, so each of
  those scans walks a tree that may hold thousands of images. Which one dominates has not been
  measured, and plan 1 measures before it changes anything.
- **A reload.** `apps/desktop/renderer/pathux/bridge.ts:187` invalidates on every successful
  mutating command, and the Gen Graph pane's `load()` re-reads the whole file and rebuilds the
  view.

Plan 1 takes the commit. Plan 2 takes the reload, and the widget rebuild that comes with it.
The write is deliberately left alone by both: deferring it means the file on disk stops being
current, which reaches the pipeline, undo, and the content-addressed task hash all at once.
It is named as a non-goal in both plans rather than scheduled.

## Why the two are separate

They share a symptom and nothing else.

Plan 1 lives in `@vn/commands` and is not about graphs at all — it would speed up any run of
consecutive commands in any editor. It changes no UI and needs no path.ux work.

Plan 2 lives entirely inside `apps/desktop/renderer/pathux/editors/nodes.ts` and the DataAPI
beside it. It changes no main-process behaviour, so undo, provenance, the pipeline and
commit-on-save are untouched by it.

Neither depends on the other, and either alone is a real improvement. Taking plan 1 first is
recommended only because it is smaller and its risk is better understood.

## The list

- [x] 1 — defer and batch commit-on-save
- [ ] 2 — a scoped DataAPI for the node editor

## Non-goals for the batch

- **Deferring the graph file write.** An in-memory accumulator in main, with `readGraph`
  routed through it, is the third and largest of the three deferrals. It needs a second undo
  snapshot class holding serialized graph state, a `:(exclude)vngen/work/graphs` entry in the
  journal's pathspec, and a content-sha drift check at flush. It also opens a failure mode the
  other two do not: node props feed `nodeHash` (`packages/gengraph/src/hash.ts:16`), so a
  pipeline run against a stale file hashes to the old content address and returns a dedupe
  hit. The author sees an instant "done" and the unchanged picture, with no error anywhere.
  Not scheduled.
- **A general data API for the application.** `apps/desktop/renderer/pathux/api.ts` maps
  `ShellState` alone, deliberately, because the project model is reached through IPC and
  mutated through commands. Plan 2 is a scoped exception for one editor over data path.ux
  already describes, not a reversal of that stance.

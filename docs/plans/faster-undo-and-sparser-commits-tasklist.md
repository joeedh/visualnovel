# Faster undo and sparser commits — tasklist

Status: **in progress**. Two plans, staged rather than independent — Design A is a
prerequisite measurement and a smaller, better-understood change; Design B builds on top of
it and is only worth designing in detail once A has landed and been re-measured. Both trace
back to [`docs/research/faster-undo-and-sparser-commits.md`](../research/faster-undo-and-sparser-commits.md),
the design report this tasklist implements.

| # | Plan | Covers | Status |
| --- | --- | --- | --- |
| 1 | `faster-undo-batch-undo-capture.md` (not yet written) | Batch `UndoJournal.capture('pre'/'post')` onto the same deferral window `Committer` already batches commits with, in `@vn/commands`. | Planned |
| 2 | not yet written | An in-memory, content-addressed snapshot store behind `UndoJournal`, with git itself committed on a slower, separate policy. | Deferred until 1 ships and is re-measured |

## Why staged rather than parallel

Design A alone removes the growth term that motivated this investigation — a per-frame drag
paying a full undo-capture pair on every frame even though thirty of those frames collapse
into one deferred commit
([`faster-undo-and-sparser-commits.md#1-the-gap`](../research/faster-undo-and-sparser-commits.md#1-the-gap-commit-batching-exists-undo-capture-batching-does-not)).
It is a two-to-three-day change confined to `packages/commands/src/stack.ts` and `undo.ts`.

Design B's payoff — sparser git commits, decoupled from git process cost entirely — only
pays for its two-to-three-week cost (an in-memory snapshot store, a WAL for crash durability,
a sparse-commit policy layered over the existing flush triggers) if the per-frame problem is
still expensive after A ships. The research report's own recommendation is to land A, re-measure,
then decide whether B is still worth it
([`faster-undo-and-sparser-commits.md#recommendation`](../research/faster-undo-and-sparser-commits.md#recommendation)).
Writing Design B's implementation plan before that re-measurement would be planning against a
number that is about to change.

## The list

- [ ] 1 — batch undo-capture the way commit-on-save is already batched (plan: see row 1 above)
- [ ] 2 — in-memory snapshot store + sparse git autocommit (plan not yet written — write after 1 ships)

## Non-goals

- **Making git itself faster** (compiling to wasm, updating node-git bindings). Explicitly
  declined by the user at the start of this investigation; both designs work within the
  existing `git` subprocess model.
- **CRDT/operational-merge semantics.** Named and declined in the research report
  ([`faster-undo-and-sparser-commits.md#4-what-not-to-change`](../research/faster-undo-and-sparser-commits.md#4-what-not-to-change)) —
  `commands.jsonl` already is the operation log, and most commands aren't invertible, so
  tree-snapshot undo stays the right structure.
- **An out-of-process versioning service.** Declined in the research report
  ([`faster-undo-and-sparser-commits.md#38-where-it-lives-in-process-argued-from-the-code`](../research/faster-undo-and-sparser-commits.md#38-where-it-lives-in-process-argued-from-the-code)) —
  only the desktop app runs a live `CommandStack` today; `vnauthor` never constructs a
  `Committer`. Revisit only if the two hosts need to run live against the same open project
  simultaneously.

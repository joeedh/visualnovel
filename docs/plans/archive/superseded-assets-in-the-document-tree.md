# Superseded assets in the document tree

Status: **shipped**

`todos.md`: _"can the document tree's asset subtree use asset slots instead of hashes to prune out
old/rejected assets?"_

## The problem

`assetBranch` in `apps/desktop/src/main/doctree.ts` groups the whole manifest by `AssetKind` and
lists every hash. A project that has re-rendered a portrait four times shows four portraits, three
of which nobody will ever look at again. Worse, `labelAssets` gives them all the same words —
`Aiko — uniform / front` — and appends `(hash8)` to break the tie, so the branch reads as four
near-identical rows distinguished by eight hex digits.

The slot graph already knows which one is current. The tree is already handed it as
`DocTreeInput.slots`, for the Unapproved branch.

## The rule

For each `SlotNode`, what fills it **now** is:

- `slot.hash`, when it resolved — `pick` returns the accepted candidate, and a `portrait:` resolves
  off `character.approvedPortrait`.
- **every** `slot.candidates` entry when `hash` is undefined. `pick` declines whenever the answer is
  not certain, so three undecided drafts are three live drafts, not zero.

**Superseded** = a candidate of some slot that is not in that current set. That is precisely
"old/rejected": a render an accepted one replaced, or a portrait draft the gate passed over.

**An asset no slot mentions is kept.** The slot graph can only speak for slots it enumerates, so
its silence about a concept, a reference, an upload or a base-root asset is not a verdict. Pruning
on silence would delete every concept sketch in the project. It also keeps an orphan whose scene was
deleted — the tree is not the place to decide that a `shot_image` is garbage.

`stale` assets are not superseded: an asset can be the current one for its slot and have drifted
from the prose. The `stale` badge already says so.

## The change

`assetBranch` gains a superseded set derived from `input.slots`, and each kind group becomes:

```
Portraits (2)            ← the count of what is shown
  Aiko                   ← current
  Ren
  Superseded (3)         ← a child branch, collapsed by default
    Aiko
    Aiko
    Ren
```

- The group heading counts the current rows, because a heading that counts what it does not draw is
  the bug `capped` exists to prevent.
- The superseded rows are a **nested branch**, not dropped. `defaultExpanded` expands only the
  roots, so a nested branch is collapsed until asked for — the rows are out of the way but still
  reachable, which matters because deleting one is a right-click on the row itself.
- Its id is `superseded:<kind>`, distinct from `more:assetkind:<kind>`, so a group that is both
  pruned and capped does not emit two nodes with one id.
- Both lists go through `capped`. The superseded branch's `note` says what it holds, because a
  pathless row carries no hover text otherwise.
- `input.slots` absent → the branch is exactly what it is today. That optionality is already the
  contract on the field: a caller that has not built the graph must not be made to claim anything.

Nothing else changes. The rows keep their `asset:<hash>` ids, so selection, routing, the asset
editor and the right-click menu all work in the new branch with no renderer change — the same
reason the Unapproved branch reuses them.

## Tests

`apps/desktop/src/main/tests/doctree.test.ts`:

- A superseded render is under `Superseded`, and the accepted one is not.
- The kind heading counts the current rows only.
- With `slots` omitted, the branch is byte-identical to today's — no `Superseded` node at all.
- A slot with two unaccepted candidates and no `hash` supersedes neither.
- A concept, which no slot claims, stays in its group.

## As shipped

Built as planned, as `supersededAssets` + a split inside `assetBranch`'s per-kind map. One thing
worth recording: a group whose every asset is superseded reads `Portraits (0)` with a single
`Superseded` child, and that is correct rather than a special case — the heading counts what it
draws, and a zero says the truth about a kind whose current take was deleted.

**Replaced, later (todos item 37).** The attic is gone. Filing every group's old takes together
answered "which of these is stale" but not "how many times did we draw *this*", which is the
question an author asking about a picture actually has — and a kind with four re-rendered slots put
twelve unrelated rows in one drawer. So the split became a nesting: one row per slot, its own
earlier takes under it. The rule about what is current survived intact and is still the reason any
of this works; what changed is where the old ones are filed. `supersededAssets` no longer exists —
"superseded" is now just "not the head of its slot's list" — and `docs/document-tree.md` carries the
contract.

## Docs

- `docs/document-tree.md` — the Assets branch section.
- `CLAUDE.md` — the asset-naming bullet, which is where the tree's asset labelling is stated.
- This plan's As-shipped section.
- `todos.md` line 57 `[ ]:` → `[x]:`.

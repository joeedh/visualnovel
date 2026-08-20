# Plan: undo/redo for the command stack

**Status:** shipped. Two amendments since the plan was written: a bracketed command that
[changed nothing is not an undo point](#amendment--a-command-that-changed-nothing-is-not-an-undo-point),
and the snapshot refs are [private, not invisible](#amendment--private-refs-are-not-invisible-refs).
**Depends on:** [command system](command-system.md) (shipped), and the strategy survey in
[`../../history/gitUndoOptions.md`](../../history/gitUndoOptions.md) — this plan is that document's §8 recommendation
being carried out.
**Size:** medium.

<!-- toc -->

## Why now

`@vn/commands` shipped undo-less by decision. That was right while the command vocabulary was
read-mostly, and it stopped being right when the story editors landed: the branch editor and the
coverage timeline both commit destructive document edits from a *gesture*, and a gesture is easy
to make by accident. The coverage strip proved it — a drag that swept a bracket across a
one-line neighbour deleted that shot's coverage, and the only recovery was `git checkout` in a
terminal, which also discards everything else the author had been doing.

The refusal added to `setCoverage` prevents that specific destruction. Undo is the general
answer, and it is the one the palette, the menus and CDP have all been advertising a button for.

## Strategy: D + E, gated by §7

Straight from [`../../history/gitUndoOptions.md`](../../history/gitUndoOptions.md) §8, unchanged:

- **Shadow snapshots (D)** for document state — snapshot the worktree into a detached commit
  under `refs/vn/undo/*` without moving `HEAD` or touching the index.
- **Split by data class (E)** — snapshot documents only. `vngen/build/` and `vngen/state/` are
  generated, content-addressed and append-only; restoring them is the wrong operation, and
  hashing 100 MB of assets on every command would be the wrong cost.
- **Refuse rather than guess (§7)** whenever the repo has moved underneath the record.

Rejected as before: per-command inverses (Strategy A — every command pays forever, and there is
no inverse to a model call), path-scoped restore (B — `written` is unverified, and it silently
eats concurrent edits), commit-per-command (C — collides with `vnauthor`'s one-commit-per-plan
contract).

### Verified up front

The plumbing was prototyped against a throwaway repo before any code was written, because the
whole approach rests on two claims:

- `GIT_INDEX_FILE=<scratch> git add -A -- . ':(exclude)vngen/build' ':(exclude)vngen/state'`
  followed by `git write-tree` produces a document-only tree in **~0.1 s** on
  `examples/mySampleRepo` (a real 51-asset run), and leaves the author's real index untouched.
- Seeding a scratch index with `git read-tree <from>` and then running
  `git read-tree -u --reset <to>` moves the worktree between two snapshots **including
  deletions** — a file created after the snapshot is removed — while paths outside the snapshot's
  pathspec (`build/`) are left alone. `git restore` cannot do the delete half, which is the
  sharp edge §5 warned about.

## Wave 1 — `@vn/git` plumbing

Seven methods, all policy-free, matching the package's existing character:

| Method                             | Wraps                                     |
| ---------------------------------- | ----------------------------------------- |
| `writeTree(paths?)`                | scratch-index `add -A` + `write-tree`     |
| `commitTree(tree, {message,parents})` | `commit-tree`                          |
| `treeOf(commit)`                   | `rev-parse <commit>^{tree}`               |
| `updateRef(ref, sha)`              | `update-ref`                              |
| `deleteRef(ref)`                   | `update-ref -d`                           |
| `listRefs(prefix)`                 | `for-each-ref`                            |
| `applyTree(from, to)`              | scratch-index `read-tree` ×2              |

`writeTree` and `applyTree` each run two git calls, but each is **one concept** — "the tree of
the worktree right now, without touching the index" and "move the worktree between two trees,
without touching HEAD or the index". The scratch index is a per-call unique file under
`.git/`, removed in a `finally`, so two processes cannot collide on it.

## Wave 2 — the journal in `@vn/commands`

`undo.ts` adds `UndoJournal`: capture, park, prune, restore. `CommandStack` owns one when the
host supplies it, and it changes nothing about a stack that does not.

**Record shape** — additive, as promised:

```ts
/** Shadow snapshots taken around an undoable command. Absent ⇒ the record is not undoable. */
undo?: { pre: string; post: string; changed: boolean };
/** Set on the stack's own undo/redo entries, which are history, not undo points. */
stack?: 'undo' | 'redo';
```

`Command.undoable` widens from `?: false` to `?: boolean`.

**Semantics:**

- The undo candidate is the most recent record that is `mutating`, `status: 'ok'`, has no
  `stack` tag, and has not already been undone. Non-mutating and failed records are skipped —
  a `view.room` between two edits must not sit in the way.
- If the candidate has no `undo` field, undo **refuses and names it** rather than skipping to an
  older one. Skipping would silently undo an edit the author did not point at.
- **Drift check.** Snapshot now; if that tree is not the candidate's `post` tree, refuse: the
  workspace changed since the command ran, and undoing would discard those changes. This is
  Strategy B's worst failure mode, closed.
- **Redo is restore-post-state, not replay** (§8 step 5). Replay stays available as
  `invocation`, which is a *re-run* and is labelled as one.
- Any new mutating command clears the redo stack.
- Undo and redo each append their own `CommandRecord`, tagged `stack`, so `commands.jsonl` does
  not lie about what touched the worktree.

Refs live at `refs/vn/undo/<seq>/{pre,post}`, outside `refs/heads/` — see
[the amendment below](#amendment--private-refs-are-not-invisible-refs) for exactly how private
that is. The journal prunes to the last 50 undoable commands.

## Wave 3 — opting commands in, and the UI

**Opted in:** the five `story.*` document mutators — `setChoice`, `removeChoice`, `setNext`,
`spliceScene`, `setCoverage`. These write the screenplay and `vngen/work/shots/*.json`, both
squarely in the document class, and they are the ones reachable from a drag.

**Deliberately not opted in, and why:**

- `gate.approve` — its `written` set straddles both data classes. Undoing the document half
  (`character.md` front-matter, `approved.png`) would leave `manifest.json` still marking that
  asset `accepted`, which the gate-candidates list reads. The real gate is the front-matter, so
  the pipeline would behave correctly, but one surface would show a checkmark for an approval
  that no longer exists. `gitUndoOptions.md` §8 step 4 suggested starting here; tracing the
  manifest read changed that. It needs the manifest re-pointed as part of the undo — Strategy A
  as an escape hatch, §2's one sanctioned use — and that is a follow-up.
- `story.export`, `pipeline.run` — generated output only. A snapshot of the document tree would
  not change across them, so an undo would claim to have done something and have done nothing.
- `agent.run` — the authoring agent owns its own commits, one per approved plan. Two components
  owning "when to commit" is exactly what Strategy C was rejected for.

**UI.** `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` (plus `Ctrl+Y`), suppressed inside an `input` or
`textarea` where they belong to the text field; a pair of topbar buttons whose tooltip is the
candidate's **exact invocation**, so undo is never a leap of faith; and a transient
`.shell-notice`, shell-wide because a refusal has to be readable from whichever room you drove
it from. The stack broadcasts a `{ type: 'undo' }` `UiEffect` from `onRecord`, so every path that
runs a command — the palette, a drag, CDP — keeps the buttons honest without polling.

After an undo the room remounts (`key={revision}` in `App`), which is what forces the fresh read:
`loadProject` has no cache, so a remount re-reads from disk. `revision` counts **undo/redo moves
only** — an ordinary command is already followed by a refresh in the surface that issued it, and
remounting on every one of those would reset scroll and selection mid-edit. Room-local selection
is still lost on an undo, which is the correct trade for a state change the author did not make
by hand.

## Amendment — a command that changed nothing is not an undo point

Found in live testing, not in the unit tests: `story.setNext(scene='greet' goto='rooftop')` when
`greet` already continues to `rooftop` succeeds, reports "already wired that way — nothing
written", and — as first written — became the undo candidate. Undo would then have restored an
identical tree and announced `Undid story.setNext(…)`, with nothing on screen changing. That is
precisely the half-working undo this plan set out to avoid: an author who sees no effect learns
not to trust the button.

`undo.changed` is the fix, and it is **the two trees compared**, not what the command reported
it wrote. `written` is a claim (Strategy B was rejected for trusting it); two equal tree shas are
proof. `undoCandidate` walks past a bracketed record with `changed: false`, which is only safe
_because_ it is proof — the workspace is provably identical either side, so nothing can be
skipped over. A candidate with **no** `undo` field at all still blocks and is still named; that
case means "not opted in", which is a different fact and must not be silently stepped over.

## Amendment — private refs are not invisible refs

The plan claimed the snapshots are "invisible to `git log`, `git branch` and the author's
history". Three-quarters right, and worth stating exactly:

- `git log`, `git log --graph`, `git branch`, `git status` — nothing. HEAD does not move and the
  index is never touched (verified: after an edit the change is unstaged, and `rev-parse HEAD` is
  the seed commit).
- `git log --all`, `gitk --all`, `git fsck` — **the snapshots are there**, as `vn: pre 3` /
  `vn: post 3` under `refs/vn/undo/*`. They are real commits kept alive by real refs; that is
  what makes them restorable.
- `git push` — not pushed. The default refspec covers `refs/heads/*`, and `--all` means
  branches, not all refs.

## Verification

- Unit (`@vn/git`): snapshot excludes an excluded path; round-trip restores a modification,
  a creation (deleted on undo) and a deletion; the real index is untouched throughout; the
  refs are parked outside the log; an unborn repo snapshots.
- Unit (`@vn/commands` — `undo.test.ts`, against a **real** repo, since the journal's whole job
  is git behaviour): capture/restore leaves excluded generated output alone; a created document
  is deleted on undo and a deleted one comes back; drift is detected on documents and *not* on
  generated output; refs stay out of `git log`; prune keeps the window, is idempotent, and does
  nothing while under the limit; outside a repo it reports rather than throws.
- Unit (`@vn/commands` — `stack.test.ts`, against a fake workspace-as-one-value, so the
  bookkeeping is testable without a repo): only an opted-in *mutating* command is bracketed —
  `undoable` without `mutating` snapshots nothing; a failed command is never an undo point even
  when it half-wrote; candidate selection skips non-mutating, failed, `stack`-tagged and
  `changed: false` records; a non-undoable candidate is refused **by name** rather than reached
  past; undo *and* redo refuse on drift without consuming the entry; a failed restore surfaces
  and leaves the candidate retryable; redo restores the post state; a new mutating command
  clears the redo stack while a non-mutating one does not; a snapshot failure degrades to no
  undo point rather than failing the command.
- The five new stack/journal cases were **mutation-checked** — the `mutating` guard, the drift
  check, and `applyTree`'s `from` seed were each broken in turn, and each test failed. A test
  that cannot fail is not evidence.
- **Live over CDP**, against a throwaway workspace seeded from `templates/basic` (not
  `mySampleRepo` — that is the user's working copy). All confirmed:
  - `story.setNext` → undo → redo leaves `screenplay/script.fountain` byte-identical at each
    step (`git hash-object` compared: `9ec59d5…` → `84552a5…` → `9ec59d5…` → `84552a5…`).
  - HEAD unmoved, the edit unstaged, four refs parked under `refs/vn/undo/`, none in `git log`.
  - A hand-edit to `characters/aiko/character.md` makes undo refuse by name; reverting it lets
    the same undo succeed.
  - Writing `vngen/build/assets/deadbeef.png` and appending to `vngen/state/tasks.jsonl`
    between the command and the redo is **neither drift nor rolled back** — the data-class
    split, working.
  - Running the same `setNext` twice records `changed: true` then `changed: false`, and undo
    targets the first (`stack.undo(target=2)`).
  - The topbar buttons track it without polling (`Undo story.setNext(scene='greet'
    goto='ending')` / `Nothing to redo`), clicking one shows the notice, and the branch editor
    goes 7 edges → 6 across an undo with no manual refresh — the remount re-reading from disk.

## Out of scope

Undoing generated output, `gate.approve` (above), undo across a `vnauthor` commit (§7 says
refuse, and the drift check does), and any cross-process coordination beyond the drift check.

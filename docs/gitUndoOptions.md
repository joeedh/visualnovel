# Undo strategies for the command stack

`@vn/commands` ships **without undo**. `CommandStack.undo()` and `.redo()` refuse and point
here. This document exists so that choice stays deliberate: it records what v1 already
captures, what each candidate strategy would cost, and which one to reach for first.

The short version: **the record shape is the commitment; the mechanism is not.** Every
strategy below is built from fields v1 already writes, so adopting one is additive.

---

## 1. Where v1 leaves off

Every executed command appends a `CommandRecord` to `vngen/state/commands.jsonl`. Four of
its fields exist purely to keep the door open:

| Field        | What it is                                     | Why undo needs it                                                 |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| `gitHead`    | Document-repo HEAD at exec time (`null` if not a repo / unborn) | The "before" commit every git-based strategy restores from.       |
| `gitDirty`   | Whether the worktree was dirty when it ran     | Tells you whether `gitHead` is actually the pre-state. See §7.     |
| `written`    | Workspace-relative paths the command wrote     | The scope to restore — the difference between path-scoped and whole-tree undo. |
| `invocation` | The DSL rendering of the call                  | Replay for redo, and a copy-pasteable repro line for debugging.    |

`seq` gives a total order; `status` distinguishes a command that half-ran from one that
never started. `Command.undoable` is typed `?: false` — a placeholder that will widen when a
strategy lands, so today nothing can accidentally claim to be reversible.

What v1 deliberately does **not** capture: file contents before the write, and any record of
generated assets beyond what the pipeline's own `tasks.jsonl` already holds.

---

## 2. Strategy A — per-command inverse (memento)

Each command supplies its own `undo(props, ctx)`, and the stack calls it.

**For.** Maximally precise; the only approach that can undo something git doesn't see (an
in-memory setting, an external side effect). No git plumbing.

**Against.** Every command pays authoring cost, forever, and the inverse is the part nobody
tests. It fails outright for the commands that matter most: `pipeline.run` spends money and
writes content-addressed assets, and there is no meaningful inverse to a model call. It also
composes badly — an inverse written against one version of a document is wrong once another
command has touched it.

**Verdict.** Not as the primary mechanism. Possibly as an escape hatch for the handful of
commands git can't describe.

---

## 3. Strategy B — path-scoped restore

```sh
git restore --source <record.gitHead> -- <record.written…>
```

**For.** Cheap, exact, and one command. Uses `written` and `gitHead` exactly as recorded.
Touches nothing outside the paths the command claimed.

**Against.** Three sharp edges:

- A path that did not exist at `gitHead` can't be restored — it must be **deleted**, which
  means classifying each written path as created-vs-modified at undo time.
- It **silently discards concurrent edits** to those paths. If the author hand-edited a file
  after the command ran, undo eats that edit with no warning.
- `written` is hand-declared by each command. A command that under-reports leaves debris; one
  that over-reports clobbers files it never touched. Nothing verifies the claim today.

**Verdict.** Viable for narrow, well-behaved document commands (`gate.approve`). Not a
general mechanism while `written` is unverified.

---

## 4. Strategy C — commit per mutating command

Every mutating command commits; undo is `git revert`.

**For.** Durable, shareable, survives restarts, and needs no new storage concept. Reverts
compose and conflict visibly rather than silently.

**Against.** It pollutes history — a per-keystroke-ish commit log buries the author's own
narrative. Worse, it **collides directly with the authoring agent's contract**: `vnauthor`
commits once per approved plan (`packages/authoring/src/loop.ts`), gated on validation. Two
components both owning "when to commit" is a design smell, and interleaving them produces a
history neither one intended. It also forces a commit on a dirty worktree, sweeping unrelated
in-progress edits into the command's commit.

**Verdict.** No — unless commit ownership is unified first, which is a much bigger change.

---

## 5. Strategy D — shadow snapshots (currently the strongest candidate)

Before a mutating command, snapshot the worktree **without moving HEAD or touching the
index**, and park it under a private ref:

```sh
git add -A                                    # into a TEMPORARY index, via GIT_INDEX_FILE
tree=$(git write-tree)
snap=$(git commit-tree "$tree" -p "$gitHead" -m "vn: pre <seq> <id>")
git update-ref refs/vn/undo/<seq> "$snap"
```

Undo restores that tree into the worktree; redo replays `invocation`, or restores the
corresponding post-snapshot.

**For.**

- **Full fidelity.** Captures dirty and untracked state, so it is correct regardless of
  `gitDirty` — the one strategy that doesn't need the worktree to be clean.
- **Invisible.** `refs/vn/*` doesn't appear in `git log`, `git branch`, or the author's
  history. Nothing is pushed.
- **Doesn't depend on `written`.** Correctness no longer rests on each command honestly
  declaring its writes — which removes §3's worst failure mode.
- **Prunable.** Drop refs beyond the last N commands and let `gc` reclaim them.
- **Cheap.** Trees are content-addressed; an unchanged file costs nothing.

**Against.** The most plumbing of any option, and it must be done carefully — a stray
`git add -A` against the *real* index would stage the author's work, so the snapshot has to
run with `GIT_INDEX_FILE` pointed at a scratch file. `@vn/git` is currently a thin porcelain
wrapper (`status`/`commit`/`log`/`show`/`diff`/`revert`/`restore`) and has none of
`write-tree`/`commit-tree`/`update-ref`; adding them widens a package whose whole virtue is
that it is small and policy-free. Restoring is also not simply `checkout` — it must handle
files that exist now but not in the snapshot.

Snapshots also say nothing about **why** something changed, so they pair best with §6.

---

## 6. Strategy E — split by data class

Stop treating "the workspace" as one thing. It is two:

- **Documents** (`characters/`, `locations/`, `screenplay/`, `project.yaml`) — hand-authored,
  small, genuinely mutable. Undo here means restoring bytes → **Strategy D**.
- **Generated output** (`vngen/build/assets/`, `manifest.json`, `tasks.jsonl`) — already
  content-addressed and append-only. Assets are immutable by construction; the manifest is an
  index. "Undo" is **re-pointing the index**, not deleting bytes — and deleting them would be
  actively wrong, since a later run would just regenerate them at cost.

**Verdict.** This is less an alternative than a constraint on the others: any strategy that
tries to `git restore` the `vngen/` tree wholesale is solving the wrong problem for half its
inputs. Whatever lands should scope document undo tightly and leave generated output to the
existing task graph.

---

## 7. Cross-cutting problems

Independent of mechanism, these decide whether undo is trustworthy:

- **Dirty worktree at exec time.** `gitHead` is only the pre-state if the tree was clean.
  When `gitDirty` is true, every commit-based strategy restores to a state that never
  existed. Snapshots (§5) are the only clean answer; the alternative is refusing to record an
  undo point when dirty, and saying so.
- **Interleaving with `vnauthor`'s commits.** The agent commits between commands. Undoing a
  command that predates an agent commit means rewriting or reverting across it. Undo should
  almost certainly **refuse** once HEAD has moved past `record.gitHead`, rather than guess.
- **Redo validity.** Redo by replaying `invocation` is not equivalent to redo by restoring a
  post-state: a model call is non-deterministic, and an intervening edit changes the inputs.
  These should be named differently, not conflated.
- **`vngen/` is committed output.** Unlike a typical build directory it is tracked
  (CLAUDE.md § Project layout), so it participates in every git operation. Undo must scope
  its pathspecs deliberately instead of inheriting whole-tree behavior.
- **Multi-process access.** The desktop app, `vngen`, and a terminal can all touch the repo.
  Nothing serializes them. An undo stack that assumes it is the only writer will be wrong
  eventually; the `gitHead` check above is the cheap guard.

---

## 8. Recommendation

**D + E, gated by the §7 checks** — shadow snapshots for document state, the existing task
graph for generated output, and a hard refusal (not a guess) whenever the repo has moved
underneath the record.

Migration, in order, none of which changes the v1 `CommandRecord`:

1. Add `writeTree` / `commitTree` / `updateRef` / `readTree` to `@vn/git`. Still policy-free.
2. Snapshot before each mutating command into `refs/vn/undo/<seq>`; record the snapshot sha
   as a **new optional field** on `CommandRecord`. Records without it are simply not
   undoable — old history stays readable.
3. Implement `undo()` for the document paths only, refusing when HEAD has moved past
   `record.gitHead` or when no snapshot was recorded.
4. Widen `Command.undoable` from `?: false` and opt commands in one at a time, starting with
   `gate.approve`.
5. Decide redo explicitly: restore-post-state, not replay. Replay stays available as
   `invocation` — which is a *re-run*, and should be labelled as one.

Until step 1 lands, `undo()` refusing loudly is the correct behavior. A half-working undo on
an author's only copy of their screenplay is worse than none.

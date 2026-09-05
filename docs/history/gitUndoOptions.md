# Undo strategies for the command stack

<!-- toc -->

- [1. Where v1 leaves off](#1-where-v1-leaves-off)
- [2. Strategy A — per-command inverse (memento)](#2-strategy-a--per-command-inverse-memento)
- [3. Strategy B — path-scoped restore](#3-strategy-b--path-scoped-restore)
- [4. Strategy C — commit per mutating command](#4-strategy-c--commit-per-mutating-command)
- [5. Strategy D — shadow snapshots (currently the strongest candidate)](#5-strategy-d--shadow-snapshots-currently-the-strongest-candidate)
- [6. Strategy E — split by data class](#6-strategy-e--split-by-data-class)
- [7. Cross-cutting problems](#7-cross-cutting-problems)
- [8. Recommendation](#8-recommendation)
    - [As carried out](#as-carried-out)
    - [Afterword: §4's rejection was reversed](#afterword-%C2%A74s-rejection-was-reversed)

<!-- tocstop -->

**Status: §8 has been carried out** — see [§8](#8-recommendation) for what shipped and
where it deviated, and
[`../plans/archive/INDEX.md#command-undo-redo`](../plans/archive/INDEX.md#command-undo-redo)
for the implementation. The survey below is left as written, in the present tense, and
describes the `@vn/commands` that shipped without undo. It records what v1 already
captured, what each candidate strategy would cost, and which one to try first. The choice
rests on that reasoning, which is worth re-reading when the next data class needs undo.

In short, the record shape is what is committed to, and the mechanism is not. Every
strategy below is built from fields v1 already writes, so adopting one is additive.

That last sentence was then tested.
[`../plans/archive/undo-refactor.md`](../plans/archive/undo-refactor.md) replaced the git
shadow commits §8 recommended with an in-memory content-addressed store of the same
blob/tree shape, and neither the record shape nor any of §8's three properties (snapshots
of the document tree, split by data class, refuse rather than guess) had to change. Undo
history now lasts a session rather than living in an object database, a snapshot covers a
directory rather than a repository, and the merge-conflict refusal §7 asked for is
deferred rather than shipped. Read §5 for the reasoning and
[`../reference/command-system.md`](../reference/command-system.md#undo-is-opt-in-and-rests-on-content-addressed-snapshots)
for what is running now.

---

## 1. Where v1 leaves off

Every executed command appends a `CommandRecord` to `vngen/state/commands.jsonl`. Four of
its fields are reserved for later use:

| Field        | What it is                                                      | Why undo needs it                                                              |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `gitHead`    | Document-repo HEAD at exec time (`null` if not a repo / unborn) | The "before" commit every git-based strategy restores from.                    |
| `gitDirty`   | Whether the worktree was dirty when it ran                      | Tells you whether `gitHead` is actually the pre-state. See §7.                 |
| `written`    | Workspace-relative paths the command wrote                      | The scope to restore — the difference between path-scoped and whole-tree undo. |
| `invocation` | The DSL rendering of the call                                   | Replay for redo, and a copy-pasteable repro line for debugging.                |

`seq` gives a total order, and `status` distinguishes a command that half-ran from one
that never started. `Command.undoable` is typed `?: false`. That type is a placeholder and
will widen when a strategy is added, so today no command can accidentally claim to be
reversible.

v1 deliberately does not capture file contents before the write, and it keeps no record of
generated assets beyond what the pipeline's own `tasks.jsonl` already holds.

---

## 2. Strategy A — per-command inverse (memento)

Each command supplies its own `undo(props, ctx)`, and the stack calls it.

**For.** This approach is maximally precise, and it is the only one that can undo
something git does not see (an in-memory setting, an external side effect). It needs no
git plumbing.

**Against.** Every command costs authoring effort forever, and nobody tests the inverse.
The inverse fails outright for the commands that matter most: `pipeline.run` spends money
and writes content-addressed assets, and a model call has no meaningful inverse. Inverses
also compose badly, because an inverse written against one version of a document is wrong
once another command has touched it.

**Verdict.** Do not use this as the primary mechanism. It may serve as an escape hatch for
the handful of commands git cannot describe.

---

## 3. Strategy B — path-scoped restore

```sh
git restore --source <record.gitHead> -- <record.written…>
```

**For.** Runs as one cheap, exact command. Uses `written` and `gitHead` exactly as
recorded. Touches nothing outside the paths the command claimed.

**Against.** There are three problems:

- A path that did not exist at `gitHead` cannot be restored and must be deleted instead,
  so undo classifies each written path as created or modified.
- It discards concurrent edits to those paths without warning. If the author hand-edited a
  file after the command ran, undo overwrites that edit and reports nothing.
- `written` is hand-declared by each command. A command that under-reports leaves files
  behind. A command that over-reports clobbers files it never touched. Nothing verifies
  the declaration today.

**Verdict.** The approach is viable for narrow, well-behaved document commands
(`gate.approve`). It is not a general mechanism while `written` is unverified.

---

## 4. Strategy C — commit per mutating command

Every mutating command creates a commit. To undo a change, run `git revert`.

**For.** The approach is durable and shareable, survives restarts, and needs no new
storage concept. Reverts compose, and a conflict between two reverts is visible rather
than hidden.

**Against.** A per-keystroke-ish commit log buries the author's own narrative. It also
collides with the authoring agent's contract: `vnauthor` commits once per approved plan
(`packages/authoring/src/loop.ts`), gated on validation. Two components that both decide
when to commit conflict, and interleaving them produces a history neither one intended.
Committing on a dirty worktree also sweeps unrelated in-progress edits into the command's
commit.

**Verdict.** No, unless commit ownership is unified first. Unifying commit ownership is a
much bigger change.

---

## 5. Strategy D — shadow snapshots (currently the strongest candidate)

Before a mutating command, snapshot the worktree without moving HEAD or touching the
index, and store the snapshot under a private ref:

```sh
git add -A                                    # into a TEMPORARY index, via GIT_INDEX_FILE
tree=$(git write-tree)
snap=$(git commit-tree "$tree" -p "$gitHead" -m "vn: pre <seq> <id>")
git update-ref refs/vn/undo/<seq> "$snap"
```

Undo restores that tree into the worktree. Redo either replays `invocation` or restores
the corresponding post-snapshot.

**For.**

- **Full fidelity.** Captures dirty and untracked state, so it is correct regardless of
  `gitDirty`. It is the only strategy that does not require a clean worktree.
- **Private.** `refs/vn/*` doesn't appear in `git log`, `git branch`, `git status`, or the
  author's history, and nothing is pushed (the default refspec covers `refs/heads/*`).
  Private is not the same as invisible: `git log --all` and `git fsck` do show these refs.
  They have to show them, because they are real commits kept alive by real refs, which is
  what makes them restorable.
- **Does not depend on `written`.** Correctness no longer rests on each command declaring
  its writes accurately, which removes §3's worst failure mode.
- **Prunable.** Drop refs beyond the last N commands and let `gc` reclaim them.
- **Cheap.** Trees are content-addressed; an unchanged file costs nothing.

**Against.** This option relies on the most plumbing of any option, and it must be done
carefully — a stray `git add -A` against the real index would stage the author's work, so
the snapshot has to run with `GIT_INDEX_FILE` pointed at a scratch file. `@vn/git` is
currently a thin porcelain wrapper
(`status`/`commit`/`log`/`show`/`diff`/`revert`/`restore`) and has none of
`write-tree`/`commit-tree`/`update-ref`; adding them widens a package whose whole virtue
is that it is small and policy-free. Restoring also takes more than `checkout`, because it
must handle files that exist now but not in the snapshot.

Snapshots also record nothing about why something changed, so they work best alongside §6.

---

## 6. Strategy E — split by data class

Do not treat the workspace as one thing. It has two parts:

- **Documents** (`characters/`, `locations/`, `scenes/`, `project.yaml`) — these files are
  hand-authored, small, and genuinely mutable. Undoing a change here restores bytes →
  Strategy D.
- **Generated output** (`vngen/build/assets/`, `manifest.json`, `tasks.jsonl`) — already
  content-addressed and append-only. Assets are immutable by construction, and the
  manifest indexes them. Undo re-points the index rather than deleting bytes. Deleting
  them would be wrong, since a later run would regenerate them at cost.

**Verdict.** This constrains the other options rather than competing with them. A strategy
that tries to `git restore` the `vngen/` tree wholesale solves the wrong problem for half
its inputs. Document undo should be scoped tightly, and generated output left to the
existing task graph.

---

## 7. Cross-cutting problems

Whatever the mechanism, the points below determine whether undo is trustworthy:

- **Dirty worktree at exec time.** `gitHead` records the pre-state only when the tree was
  clean. When `gitDirty` is true, every commit-based strategy restores to a state that
  never existed. Snapshots (§5) are the only strategy that restores a state that existed.
  The alternative is to refuse to record an undo point while the tree is dirty and to
  report that refusal.
- **Interleaving with `vnauthor`'s commits.** The agent commits between commands. Undoing
  a command that predates an agent commit means rewriting or reverting across it. Undo
  should almost certainly refuse once HEAD has moved past `record.gitHead` instead of
  guessing.
- **Redo validity.** Redo by replaying `invocation` is not equivalent to redo by restoring
  a post-state: a model call is non-deterministic, and an intervening edit changes the
  inputs. The two forms of redo should carry different names rather than be conflated.
- **`vngen/` is committed output.** Unlike a typical build directory, git tracks it
  (CLAUDE.md § Project layout), so every git operation includes it. Undo must set its
  pathspecs explicitly rather than defaulting to whole-tree behavior.
- **Multi-process access.** The desktop app, `vngen`, and a terminal can all write to the
  repo, and nothing serializes them. An undo stack that assumes it is the only writer will
  eventually be wrong, so the `gitHead` check described above guards the stack cheaply.

---

## 8. Recommendation

**D + E, gated by the §7 checks** — Uses shadow snapshots for document state and the
existing task graph for generated output, and refuses outright rather than guessing
whenever the repo no longer matches the record.

The migration steps below run in order, and none of them changes the v1 `CommandRecord`:

1.  1. Add `writeTree` / `commitTree` / `updateRef` / `treeOf` / `applyTree` to `@vn/git`.
       These remain policy-free. (Shipped with `deleteRef` / `listRefs` alongside them.)
2.  2. Snapshot before each mutating command into `refs/vn/undo/<seq>`; record the
       snapshot sha as a new optional field on `CommandRecord`. A record without that
       field cannot be undone, and old history stays readable.
3.  3. Implement `undo()` for the document paths only. It refuses when HEAD has moved past
       `record.gitHead` or when no snapshot was recorded.
4.  Widen `Command.undoable` from `?: false` and opt commands in one at a time, starting
    with `gate.approve`.
5.  5. Decide redo explicitly. Redo restores the post-state rather than replaying. Replay
       stays available as `invocation`, which is a re-run and should be labelled as one.

Until step 1 lands, `undo()` is correct to refuse and report the refusal. A half-working
undo on an author's only copy of their screenplay is worse than no undo at all.

### As carried out

Steps 1, 2, 3 and 5 shipped as written. Three things came out differently, each for a
reason that only became clear during implementation:

- **Step 4 did not start with `gate.approve`.** Its `written` set covers both data
  classes: undoing the document half (`character.md` front-matter, `approved.png`) would
  leave `manifest.json` still marking that asset `accepted`, which the gate-candidates
  list reads. The pipeline would still behave correctly, because the front-matter decides
  the gate, but one surface would show a checkmark for an approval that no longer exists.
  The six `story.*` document mutators went first instead. They are pure-document, and they
  are the ones reachable from a drag, which carried the risk. Undoing `gate.approve`
  requires re-pointing the manifest, so it uses the escape hatch in §2 — the one
  sanctioned use of that escape hatch.
- **The record carries a pair of snapshots, not one** (`undo?: { pre, post, changed }`),
  because redo needs the post-state and the drift check needs something to compare
  against. `changed` comes from comparing the two trees rather than from `written`.
  `written` is only what the command claims, which §3 was rejected for trusting, and a
  command that wrote nothing must not become the undo point.
- **The drift check compares trees, not HEAD.** Step 3 said "refusing when HEAD has moved
  past `record.gitHead`", but the common case is that HEAD never moves and the worktree
  changes. Snapshotting now and comparing to `post` catches both cases, and catches an
  edit made in another editor between the command and the undo.

Scoping the snapshot to the document class
(`['.', ':(exclude)vngen/build', ':(exclude)vngen/state']`) turned out to do three jobs at
once rather than the one job §6 promised. It keeps the hash under a second on a 100 MB
workspace, it keeps undo from rolling back generated work a later run would have to pay
for again, and it keeps a `pipeline.run` between two edits from reading as drift.

### Afterword: §4's rejection was reversed

§4 was rejected as an undo mechanism, and that verdict stands: undo restores a tree rather
than running a `git revert`. §4 was also rejected as a commit policy — "no, unless commit
ownership is unified first, which is a much bigger change" — and a later requirement
reversed that half. The design requirements ask the app to commit every save, so commit
ownership had to be settled anyway, and §4's blocking objection became the work item.

The unification is smaller than §4 feared. Two components owning when to commit demands
only that no single act have two owners, not that there be one owner overall.
`Command.commitsItself` marks the commands whose implementation already commits
(`vnauthor`'s plan loop), the CLI wires no committer at all, and each surface keeps its
own granularity. §4 also objected that a dirty worktree would sweep unrelated edits into a
command's commit. The invariant answers that objection instead of scoping: the app opens
on a clean worktree and every act ends with one, so the files left dirty are exactly the
files that act changed.

§4 and §5 now coexist without interfering, and the reason is worth recording. A commit
moves a branch ref and the index but changes no file in the worktree, so it cannot perturb
a snapshot tree taken on either side of it. The two mechanisms answer different questions
and keep different scopes for that reason. §4 records what changed. §5 records what may be
rolled back. [`../reference/repos-and-commits.md`](../reference/repos-and-commits.md)
documents what shipped; the survey above stays as written.

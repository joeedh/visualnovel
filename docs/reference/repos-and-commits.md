# Repos and commits

How the app decides **which git repository owns a path** and **when history gets written**.
Design and rationale: [`../plans/archive/repo-map-and-commit-on-save.md`](../plans/archive/repo-map-and-commit-on-save.md).
Undo used to be the other half of the same machinery and no longer is: it snapshots into an
in-memory content-addressed store rather than into git
([`command-system.md`](command-system.md#undo-is-opt-in-and-rests-on-content-addressed-snapshots),
[`../plans/archive/undo-refactor.md`](../plans/archive/undo-refactor.md)). Commit-on-save is untouched by that, and
the two still compose — see [How undo composes with it](#how-undo-composes-with-it).

<!-- toc -->

- [The repo map](#the-repo-map)
- [Commit-on-save](#commit-on-save)
  * [The invariant](#the-invariant)
  * [Message shape](#message-shape)
  * [Deferral](#deferral)
  * [Who does not commit](#who-does-not-commit)
- [Bootstrap](#bootstrap)
  * [The `.gitattributes` a project gets](#the-gitattributes-a-project-gets)
- [The one thing git is told not to merge](#the-one-thing-git-is-told-not-to-merge)
- [How undo composes with it](#how-undo-composes-with-it)
- [Multi-repo](#multi-repo)

<!-- tocstop -->

## The repo map

A project spans one repo, or more: the story bible under `wiki/` and (later) a base-asset
library may each be a repository of their own.

The map is **discovered, never declared**. `RepoResolver` (`@vn/git`) asks
`git rev-parse --show-toplevel` from a path's directory and caches the answer per directory:

```ts
const resolver = new RepoResolver();
await resolver.rootOf('/proj/wiki/lore/houses.md'); // → '/proj/wiki' if wiki/ is its own repo
await resolver.gitFor(path); //  a Git scoped to that root, memoized
await resolver.group(paths); //  Map<root|null, paths[]> — un-owned paths under null
resolver.forget(); //            after a `git init` the cache remembers as absent
```

A `repos:` block in `project.yaml` would be a second source of truth, wrong the moment a user
runs `git init` in `wiki/`. Discovery *is* git's own answer: it handles `.git` files (worktrees,
submodules), `GIT_DIR`, and ceiling directories, and it gets the important case right for free —
git does not descend into a nested repository, so `wiki/.git` genuinely is not the project repo's
business.

`Workspace.repos()` (`@vn/authoring`) applies the project's layout to that mechanism and is what
`WorkspaceIndex.repos` reports:

```ts
interface RepoRef {
  role: 'project' | 'wiki';
  root: string; // what git reports — not the directory asked about
  owned: boolean; // false when the directory merely *sits inside* that root
}
```

`owned: false` is the load-bearing distinction. A project opened inside a larger repo (a checkout
of this monorepo, say) resolves to that repo, and committing everything dirty there would sweep in
files that have nothing to do with the project. The app reports the repo and **declines to commit
in it** rather than guessing at a narrower scope.

Which is exactly why **creating** a project gets a repository of its own. `workspace.create`
promises "a starter scene, a story bible page, project.yaml and a git repo", so it initializes one
**at** the new root whatever encloses it, and the project comes back `owned: true` with
commit-on-save working. Its check still says what happened — *"{repo} already owns this path, so
the new project will be a repository nested inside it"* — but as a fact appended to an accept, not
the warning it used to be, because a nested repository is a thing this codebase already understands:
git does not descend into one, so the outer repo sees the project as a single untracked directory.

## Commit-on-save

Every act that changed something becomes a commit, in each repo it touched.
`Committer` (`@vn/commands`) is a sibling of `UndoJournal` and opt-in the same way: a
`CommandStack` with no `committer` moves no ref at all, which is what keeps testkit, the CLI, and
the existing tests out of anyone's history.

Scope is the **whole worktree** (`git add -A`) per repo — not `record.written`, which is a
hand-declared claim nothing verifies ([`../history/gitUndoOptions.md`](../history/gitUndoOptions.md) §3), and not the
undo pathspec. A `pipeline.run` that writes five hundred assets therefore needs no special case to
become one commit.

### The invariant

**The app opens on a clean worktree, and every act ends with one, except inside a run of acts
that defer their commit.** Under it, "everything dirty" and "what this act did" are the same
set, so the simplest scope is also the correct one. A run of deferring acts is the one place
the worktree stays dirty between acts, and the next act that does commit flushes the run before
it runs, so the set is never mixed. "Deferral" below covers it.

Session open establishes it with a **sweep commit** in each owned repo:
`Committer.sweep(reason)` commits whatever is already there under a `Vn-Sweep: true`
trailer. That is where a `vngen run` from the terminal, or an edit made in another editor, gets
recorded — as its own event rather than folded into whatever the author does next.

### Message shape

The subject is the command's own one-liner (`CommandRecord.message`), stripped of a trailing
period, cut at the first newline and capped at 72 characters; provenance goes in trailers:

```
Moved line L4 into rooftop

Vn-Command: story.moveLine
Vn-Seq: 12
Vn-Invocation: story.moveLine(lineId='L4' toScene='rooftop')
Vn-Source: ui
```

A command whose `message` is prose rather than a summary sets `CommandRecord.subject`, and the
commit is named after that instead. `agent.run` is the only one that does: its message is the
agent's whole reply, which the conversation pane renders, so the commit takes `Agent turn: <ask>`.

An undo or redo adds `Vn-Undo:` / `Vn-Redo:` naming the seq it reverses. A sweep carries
`Vn-Sweep: true` and no command fields.

The resulting shas land on `CommandRecord.commits` (`{ repo, sha }[]`) in
`vngen/state/commands.jsonl`, absent on a record that changed nothing, ran without a committer,
or deferred its commit into a batch.

### Deferral

A gesture sends one command per frame, and each one committing costs five git subprocesses that
nobody reads the result of. A command declares `defersCommit: true` to join a batch instead:
`gengraph.setProp` and `gengraph.moveNodes` are the two that do. The record is written as
usual, carries `commitDeferred: true` and no `commits`, and the files it wrote stay on disk
uncommitted until the batch flushes.

Five things flush a batch, and the first four are what keep the invariant above true:

- a mutating command that does not defer, before it runs rather than before it commits, so the
  flush commit holds the deferred edits and nothing else;
- `undo()` and `redo()`, so a deferred edit is in history before a restore overwrites it;
- a workspace switch, which drops the stack the batch lives on;
- quit, which the app holds open for the commit;
- 1500 ms of idleness (`BATCH_IDLE_MS`), which bounds how long an author who edits and then
  stops leaves a dirty worktree behind.

Mutating commands are serialized end to end over that flush, so a deferring command cannot run
inside another command's `-A` commit. Non-mutating commands stay concurrent and do not flush.

A batch of one commits exactly as it would have undeferred. A batch of more takes the last
act's subject with the count appended, and its trailers name the run rather than one
invocation:

```
Sets 'aspect' on the Generate image node to "4:3" (and 3 more edits)

Vn-Batch: 4 seqs 27,30,33,36
Vn-Seq: 36
Vn-Command: gengraph.setProp
Vn-Source: cdp
```

`Vn-Seq` stays one integer holding the last seq, because a reader that parses it as a number
must not get a range. `Vn-Batch` carries the count and the exact seqs, hyphenating runs of two
or more and leaving the gaps that non-mutating commands took. `Vn-Invocation` is dropped, since
`commands.jsonl` holds each one under the seq the range names. Two distinct commands in one
batch produce two `Vn-Command` trailers.

A flush that fails keeps the batch for the next flush to retry and files a durable notification
naming the count and the seq range. The edits are on disk either way; what a lost batch costs
is the attribution, since the next session's sweep commit picks the bytes up under
"Changes made outside the app".

### Who does not commit

| Surface | Why |
| --- | --- |
| `vngen` CLI | A CLI run is a build step; build steps do not author history, and a headless run in CI that committed would be a surprise. Its output is picked up by the next session's sweep commit. |
| `vnauthor` | It already commits once per approved plan, and that plan — not each `edit_character` inside it — is the authorial event. A command whose implementation owns its commits declares `commitsItself: true` and the committer leaves it alone. |
| A project inside a foreign repo | See `owned` above. |

One owner per act, therefore — which is what "two components owning when to commit" actually
demanded: not that there be one committer, but that no act have two.

## Bootstrap

`ensureRepo(root)` (`apps/desktop/src/main/workspace.ts`) is the "initializes a git repository if
necessary, and automatically commits existing files" half of project bootstrap. It is idempotent
and stops at the first question: a directory already inside a work tree is left entirely alone,
whether or not it is that tree's root. Otherwise it runs `git init`, fills in a fallback identity
only when git cannot already answer who the committer is, sets `core.autocrlf false` (scene prose
is patched byte-exactly), and commits what is there.

`initRepoAt(root, message)` is its deliberate opposite, and the half `ensureRepo` now delegates to:
it inits **at** `root` without asking what encloses it. Only `createWorkspace` calls it directly,
because "create a new project here" is a request for a project and a project has a repo — a
directory the author already had must not silently grow a nested one, which is why `open` keeps
`ensureRepo`.

`seedWorkspace` uses `ensureRepo` for the sample workspace, with its own first-commit
subject, and so does `openWorkspace(root)` — the directory the user picked, made a project if it
is not one yet (a one-line `project.yaml`) and then brought under version control. Which project
is open, and what a switch tears down, is
[`desktop-app.md`](desktop-app.md#which-project-is-open).

### The `.gitattributes` a project gets

Bootstrap writes the only `.gitattributes` this app puts into a project, and it carries exactly
two rules — one per thing git would otherwise get wrong. This is the first.

`openWorkspace` runs `ensureGitAttributes(root)` — an idempotent append of

```
vngen/state/notifications.jsonl merge=union
```

before `ensureRepo`, so a project created before the notification log existed picks it up on next
open (committed on its own, as "Union-merge the notification log"). `skeleton()` writes the same
line into a new project. `ensureLayouts` appends the second rule the same way, in the same place,
and is the subject of [the section below](#the-one-thing-git-is-told-not-to-merge).

**Both of those commits ask `ownsRepo(root)` first**, and this is the load-bearing part.
Scaffolding may *write* into a project that sits inside a larger repo — the files belong to the
project either way — but the history does not belong to the app, on exactly the grounds
`owned: false` gives above. `isRepo()` is the wrong question here: it is true of a directory that
merely sits inside a work tree, so asking it is how opening a scratch folder inside a checkout
files two commits onto somebody's branch. `ownsRepo` compares `git rev-parse --show-toplevel`
against the root itself, which is `RepoRef.owned` asked of one directory and without loading a
model. A repo `ensureRepo` just initialized needs no check: it is the project's by construction,
and the scaffolding is already in its first commit.

`openWorkspace` is not enough on its own, because the ordinary launch never calls it: `main`
resolves a root from the recents list or `VN_PROJECT` and goes straight to `openRepos()`. So
`openRepos()` calls `adoptGitAttributes(root)` — the same ensure, plus that separate commit —
between `ensureRepo` and the `sweep`, which is what keeps the line out of "Changes made
outside the app". Its caller skips it when the project sits inside a larger repo, and it asks
`ownsRepo` again itself: the guard travels with the write rather than living only at the one call
site that happens to remember it.

Union merge is what makes an append-only log survive a branch merge: both sides' lines are kept.
It duplicates a line whose read/hidden flags each side changed, which is why the reader dedupes by
id and **ORs** the flags — both are monotonic, so the set bit wins. See
[`../plans/archive/notifications.md`](../plans/archive/notifications.md).

This repo's own `* text=auto eol=lf` is deliberately **not** copied into a project. `merge` and
`text`/`eol` are orthogonal attributes, and a project is the user's repo; `initRepoAt` already
sets `core.autocrlf=false` for the byte-exact reasons the branch editor needs.

**Notification writes ride along in the next act's commit**, because `Committer.commit` stages the
whole worktree. That is not new — `vngen/state/commands.jsonl` has always behaved this way, and
the open-time sweep exists to absorb it.

## The one thing git is told not to merge

The second rule, and the one with teeth:

```gitattributes
.vnstudio/layouts/*.json text eol=lf -merge
```

A [layout template](desktop-app.md#layout-templates) is one blob describing a whole window: which
panes exist, how big they are, what each holds. Two authors' versions merged line by line make an
arrangement neither of them built, so git is told not to try. `-merge` rather than a registered
custom merge driver, because a driver needs `git config merge.<driver>.driver` installed in every
clone to work at all, and nothing this app runs reaches a collaborator's machine. `-merge` needs
nothing: git conflicts the path, leaves **ours** in the worktree, and the author picks a side with
`git checkout --ours` or `--theirs` and then `git add`. The comment block written above the rule
says exactly that.

`ensureLayouts` **appends** it: a `.gitattributes` an author wrote is theirs, and only the rule
that is missing is added. `skeleton()` writes it outright for a new project, so it is in the first
commit.

Conflict resolution stays out of scope, and so does *noticing* one. The app used to read `git
status` porcelain codes and refuse a mid-merge layout or graph by name; that was dropped with the
undo refactor, because it only ever served an author running their own git workflow over the
project and it was the last thing asking git a question on a read path. Until a better-designed
answer to merge conflicts exists, the app opens whichever side is in the worktree — which `-merge`
guarantees is **ours**, unmangled.

## How undo composes with it

The two mechanisms compose **without ordering constraints**, which is what made commit-on-save a
small change rather than a redesign, and it is also why undo could be lifted out of git without
disturbing this half: a commit moves a branch ref and the index and changes no file in the
worktree, so it cannot perturb a snapshot taken either side of it.

- **Undo commits its restore; it never resets.** `git reset` rewrites history, and with
  commit-on-save the commit it would discard may be the only record of a save. Not `git revert`
  either — that applies an inverse *diff* and can conflict, whereas we hold the exact tree.
- **Undo's scope stays the document class** (`UNDO_EXCLUDES`, plus the media the store skips
  wherever it sits) and does not widen to match the commit scope. The two answer different
  questions: *what changed* versus *what may be rolled back*. An undo therefore commits a worktree
  that is documents-rolled-back plus generated-as-is, which is exactly what is on disk.
- **The drift refusal gets stronger.** A clean worktree is the norm between acts of different
  kinds, so a check that fails means something really did change outside the app — which is why
  `undo()` and `redo()` flush a pending batch first rather than letting a deferred edit read as
  drift.
- Undo also works where commit-on-save refuses: a snapshot is held in memory and writes nobody's
  history, so a project nested in a larger repo snapshots like any other.
- **A checkpoint narrows undo's scope further, to one declared subtree, for the span of one
  grouped undo point.** Its rollback commit uses the same `record`/`commit(true, record)` pair an
  ordinary undo restore uses, so it lands in `commands.jsonl` the same way. Full design:
  [`command-system.md#checkpoints-group-several-commands-into-one-undo-point`](command-system.md#checkpoints-group-several-commands-into-one-undo-point).

## Multi-repo

The repo map is a commit-on-save concept, and only that. `Committer` takes the repo list, commits
each repo that had something to commit, and reports what landed per repo.

Undo has no such notion any more. A snapshot covers a **directory** — the project root — so a
`wiki/` or `assets/` that happens to be its own repository is snapshotted as part of the project
like any other subdirectory, and there is no repo-boundary detection on that path at all. What
used to be "refuse as a unit across repos" is now simply one tree hash compared against one other.

Out of scope everywhere here: remotes, push/pull, conflict resolution, and rewriting the save
history. A user who wants a tidier log has `git rebase`; the app never rewrites what it wrote.

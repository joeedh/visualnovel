# Repos and commits

This page covers how the app decides which git repository owns a path and when it writes
history. The design and rationale are in
[`../plans/archive/INDEX.md#repo-map-and-commit-on-save`](../plans/archive/INDEX.md#repo-map-and-commit-on-save).
Undo once shared this machinery, and now snapshots into an in-memory content-addressed
store rather than into git
([`command-system.md`](command-system.md#undo-is-opt-in-and-rests-on-content-addressed-snapshots),
[`../plans/archive/undo-refactor.md`](../plans/archive/undo-refactor.md)). That change
leaves commit-on-save untouched, and undo and commit-on-save still compose (see
[How undo composes with it](#how-undo-composes-with-it)).

<!-- toc -->

- [The repo map](#the-repo-map)
- [Commit-on-save](#commit-on-save)
    - [The invariant](#the-invariant)
    - [Message shape](#message-shape)
    - [Deferral](#deferral)
    - [Who does not commit](#who-does-not-commit)
- [Bootstrap](#bootstrap)
    - [The `.gitattributes` a project gets](#the-gitattributes-a-project-gets)
- [The one thing git is told not to merge](#the-one-thing-git-is-told-not-to-merge)
- [How undo composes with it](#how-undo-composes-with-it)
- [Multi-repo](#multi-repo)
    - [Submodules](#submodules)

<!-- tocstop -->

## The repo map

A project can span more than one repository. The story bible under `wiki/` and (later) a
base-asset library may each be a repository of their own.

Nothing declares the map. `RepoResolver` (`@vn/git`) discovers it by running
`git rev-parse --show-toplevel` in a path's directory, and it caches the answer per
directory:

```ts
const resolver = new RepoResolver();
await resolver.rootOf("/proj/wiki/lore/houses.md"); // → '/proj/wiki' if wiki/ is its own repo
await resolver.gitFor(path); //  a Git scoped to that root, memoized
await resolver.group(paths); //  Map<root|null, paths[]> — un-owned paths under null
resolver.forget(); //            after a `git init` the cache remembers as absent
```

A `repos:` block in `project.yaml` would be a second source of truth, and it would be
wrong as soon as a user ran `git init` in `wiki/`. Deferring discovery to git handles
`.git` files (worktrees, submodules), `GIT_DIR`, and ceiling directories. Deferring also
gets the important case right without extra work, because git does not descend into a
nested repository, so `wiki/.git` falls outside the project repo.

`Workspace.repos()` (`@vn/authoring`) applies the project's layout to that mechanism.
`WorkspaceIndex.repos` reports the result:

```ts
interface RepoRef {
    role: "project" | "wiki" | "base";
    root: string; // what git reports — not the directory asked about
    owned: boolean; // false when the directory merely *sits inside* that root
    missing?: true; // a submodule that is not checked out; see Submodules below
}
```

`owned: false` records the distinction that the behavior depends on. A project opened
inside a larger repo (a checkout of this monorepo, for example) resolves to that repo, and
committing everything dirty there would commit files that have nothing to do with the
project. The app reports the repo and declines to commit in it rather than guessing at a
narrower scope.

A new project therefore has a repository of its own. The `workspace.create` contract
states that it produces "a starter scene, a story bible page, project.yaml and a git
repo", so it initializes a repository at the new root regardless of what encloses that
root, and returns the project with `owned: true` and commit-on-save working. The check
still reports the outcome: "{repo} already owns this path, so the new project will be a
repository nested inside it". That text is appended to an "accept" as a fact rather than
raised as the warning it used to be, because git already handles a nested repository. Git
does not descend into a nested repository, so the outer repo sees the project as a single
untracked directory.

## Commit-on-save

Every action that changes something creates a commit in each repo it touches. `Committer`
(`@vn/commands`) sits alongside `UndoJournal` and is opt-in in the same way: a
`CommandStack` with no `committer` moves no ref, so testkit, the CLI, and the existing
tests write nothing to history.

The commit stages the whole worktree of each repo (`git add -A`). The scope is not
`record.written`, which is a hand-declared claim that nothing verifies
([`../history/gitUndoOptions.md`](../history/gitUndoOptions.md) §3), and it is not the
undo pathspec. A `pipeline.run` that writes five hundred assets therefore needs no special
case to become one commit.

### The invariant

The app opens on a clean worktree, and every act ends with a clean worktree, except inside
a run of acts that defer their commit. On a clean worktree, "everything dirty" and "what
this act did" are the same set, so the simplest scope is also the correct scope. The
worktree stays dirty between acts only inside a run of deferring acts, and the next act
that does commit flushes the run before that act runs, so the set is never mixed. The text
below calls such a run a "deferral".

Opening a session establishes it with a sweep commit in each owned repo.
`Committer.sweep(reason)` commits whatever is already there under a `Vn-Sweep: true`
trailer. A `vngen run` from the terminal (or an edit made in another editor) is recorded
in that commit as its own event rather than folded into whatever the author does next.

### Message shape

The subject is the command's own one-liner (`CommandRecord.message`), stripped of a
trailing period, cut at the first newline and capped at 72 characters. Provenance goes in
trailers:

```
Moved line L4 into rooftop

Vn-Command: story.moveLine
Vn-Seq: 12
Vn-Invocation: story.moveLine(lineId='L4' toScene='rooftop')
Vn-Source: ui
```

A command whose `message` is prose rather than a summary sets `CommandRecord.subject`, and
the commit takes its name from that subject rather than from `message`. `agent.run` is the
only command that sets `CommandRecord.subject`. Its message is the agent's whole reply,
which the conversation pane renders, so the commit takes `Agent turn: <ask>`.

An undo or redo adds a `Vn-Undo:` or `Vn-Redo:` field that names the seq it reverses. A
sweep has `Vn-Sweep: true` and no command fields.

A document the Wiki or Skills pane writes on its own timer, a minute after the last edit,
goes through `doc.write` with `auto=true`, and its message — so its subject — starts
`Autosaved` rather than `Saved`. Nothing else about the commit differs; the subject is how
`git log` tells an author's Ctrl+S from the pane catching up on their behalf
([`desktop-app-editors-misc.md`](desktop-app-editors-misc.md#wiki)).

The resulting shas are written to `CommandRecord.commits` (`{ repo, sha }[]`) in
`vngen/state/commands.jsonl`. The field is absent on a record that changed nothing, on a
record that ran without a committer, and on a record that deferred its commit into a
batch.

### Deferral

A gesture sends one command per frame, and committing each one costs five git subprocesses
whose results no caller reads. A command declares `defersCommit: true` to join a batch
instead. The two commands that do so are `gengraph.setProp` and `gengraph.moveNodes`. The
record is written as usual and carries `commitDeferred: true` and no `commits`. The files
the command wrote stay on disk uncommitted until the batch flushes.

Five conditions flush a batch. The first four keep the earlier invariant true:

- a mutating command that does not defer (before it runs rather than before it commits),
  so the flush commit holds the deferred edits and nothing else;
- `undo()` and `redo()`, so a deferred edit is in history before a restore overwrites it;
- a workspace switch drops the stack that holds the batch;
- quit, which the app holds open for the commit;
- 1500 ms of idleness (`BATCH_IDLE_MS`). The delay bounds how long a dirty worktree
  remains after an author stops editing.

Mutating commands are serialized end to end over that flush, so a deferring command cannot
run inside another command's `-A` commit. Non-mutating commands stay concurrent and do not
flush.

A batch of one commits exactly as it would have without deferral. A batch of more than one
takes the last act's subject with the count appended, and that commit's trailers refer to
the run rather than to a single invocation:

```
Sets 'aspect' on the Generate image node to "4:3" (and 3 more edits)

Vn-Batch: 4 seqs 27,30,33,36
Vn-Seq: 36
Vn-Command: gengraph.setProp
Vn-Source: cdp
```

`Vn-Seq` stays one integer holding the last seq, because a reader that parses it as a
number must not get a range. `Vn-Batch` carries the count and the exact seqs. Runs of two
or more seqs are hyphenated, and the gaps that non-mutating commands took are left in
place. `Vn-Invocation` is dropped, since `commands.jsonl` holds each invocation under the
seq the range names. Two distinct commands in one batch produce two `Vn-Command` trailers.

A flush that fails keeps the batch for the next flush to retry and files a durable
notification naming the count and the seq range. The edits are on disk either way, so a
lost batch costs only the attribution. The next session's sweep commit picks the bytes up
under "Changes made outside the app".

### Who does not commit

| Surface                         | Why                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vngen` CLI                     | A CLI run is a build step; build steps do not author history, and a headless run in CI that committed would be a surprise. Its output is picked up by the next session's sweep commit.                                                     |
| `vnauthor`                      | It already commits once per approved plan, and that plan — not each `edit_character` inside it — is the authorial event. A command whose implementation owns its commits declares `commitsItself: true` and the committer leaves it alone. |
| A project inside a foreign repo | See `owned` above.                                                                                                                                                                                                                         |

Each act therefore has one owner. The problem of two components owning when to commit
requires that each act have exactly one owner; it does not require that a single committer
own every act.

## Bootstrap

`ensureRepo(root)` (`apps/desktop/src/main/workspace/workspace.ts`) handles half of
project bootstrap by initializing a git repository if necessary and committing existing
files automatically. It is idempotent. A directory already inside a work tree is left
alone (whether or not it is that tree's root). Otherwise it runs `git init`, fills in a
fallback identity only when git does not already have a committer identity, sets
`core.autocrlf false` (scene prose is patched byte-exactly), and commits the files already
present.

`initRepoAt(root, message)` initializes a repo at `root` and deliberately does not check
what encloses `root`, and `ensureRepo` now delegates to it. Only `createWorkspace` calls
`initRepoAt` directly, because "create a new project here" is a request for a project, and
a project has a repo. `open` keeps `ensureRepo` so that a directory the author already had
does not silently gain a nested repo.

`seedWorkspace` uses `ensureRepo` for the sample workspace, with its own first-commit
subject. `openWorkspace(root)` uses `ensureRepo` too. It takes the directory the user
picked, makes it a project if it is not one yet (writing a one-line `project.yaml`), and
then brings it under version control.
[`desktop-app-state.md`](desktop-app-state.md#which-project-is-open) covers which project
is open and what a switch tears down.

### The `.gitattributes` a project gets

Bootstrap writes the only `.gitattributes` this app puts into a project: a merge rule for
each file git would otherwise merge incorrectly, each under a comment saying why.

`openWorkspace` runs `ensureGitAttributes(root)`, which idempotently appends whichever of
these blocks the file lacks (`GITATTRIBUTES_BLOCKS` in `workspace/workspace.ts`):

```
vngen/state/notifications.jsonl merge=union
vngen/state/threads/*.native.jsonl -merge
vngen/work/graphs/*.json -merge
vngen/work/graphs/lib/*.json -merge
vngen/state/commands.jsonl merge=union
```

before `ensureRepo`, so a project created before a rule existed picks it up on the next
open (committed on its own, under "Set how git merges the state logs"). `skeleton()`
writes the same text into a new project. `ensureLayouts` appends the layout rule the same
way, in the same place, and is the subject of
[the section below](#the-one-thing-git-is-told-not-to-merge). A new block goes last in the
list: a project owed several gets them in that order, one that got them a release at a
time has them in release order, and two collaborators upgraded at different times collide
on the file itself unless the two orders agree.

The same rules are written again to the repository's own `info/attributes`
(`ensureRepoAttributes`, for a project that is its own repository), which git reads ahead
of the worktree's file. A sync replays each unsent save under that save's own
`.gitattributes`, so a save from before a rule was committed would otherwise replay
without it, and so would every save in a collaborator's copy until they got the commit.

Both of those commits call `ownsRepo(root)` first, and that check is the essential one.
Scaffolding may write files into a project that sits inside a larger repo, since the files
belong to the project either way, but the history does not belong to the app, for the
reason `owned: false` gives above. `isRepo()` is not enough here, because it returns true
for a directory that merely sits inside a work tree. A scratch folder opened inside a
checkout would pass it, and the app would file two commits onto somebody's branch.
`ownsRepo` compares `git rev-parse --show-toplevel` against the root itself, which is the
check `RepoRef.owned` performs, applied to one directory and without loading a model. A
repo that `ensureRepo` has just initialized needs no check, since it is the project's by
construction and the scaffolding is already in its first commit.

`openWorkspace` is not enough on its own, because the ordinary launch never calls it:
`main` resolves a root from the recents list or `VN_PROJECT` and goes straight to
`openRepos()`. So `openRepos()` runs the same steps itself, in this order:

- `writeScaffolding(root)` writes the layout templates, the merge attributes and the
  session ignore line. It runs before any git, because the files are needed whether or not
  git is installed.
- `ensureRepo(root)` brings the project under version control.
- `adoptSubmodules(root)` checks the project's submodules ([Submodules](#submodules)). It
  runs only when `ownsRepo(root)` is true.
- `Workspace.repos()` builds the list of owned repos the committer commits in.
- `commitScaffolding(root, wrote)` commits what `writeScaffolding` wrote, one subject per
  file, so none of it lands under "Changes made outside the app". It checks `ownsRepo`
  itself.
- The sweep commits anything else changed outside the app.

Union merge keeps both sides' lines, so an append-only log survives a branch merge. Union
merge duplicates a line whose read/hidden flags each side changed, so the reader dedupes
by id and ORs the flags. Both flags are monotonic, so the OR keeps a flag that either side
set. See
[`../plans/archive/INDEX.md#notifications`](../plans/archive/INDEX.md#notifications).

This repo deliberately does not copy its own `* text=auto eol=lf` into a project. `merge`
and `text`/`eol` are orthogonal attributes, and a project is the user's own repository.
`initRepoAt` already sets `core.autocrlf=false`, because the branch editor needs
byte-exact behavior.

Notification writes are included in the next act's commit, because `Committer.commit`
stages the whole worktree. `vngen/state/commands.jsonl` has always been included in the
next act's commit for the same reason, and the open-time sweep absorbs notification
writes. The command log is union-merged for the same reason the notification log is: two
collaborators both append to it between syncs, and a reader finds a record by the save
that names it rather than by its place in the file.

## The one thing git is told not to merge

The second rule is the one that constrains:

```gitattributes
.vnstudio/layouts/*.json text eol=lf -merge
```

A [layout template](desktop-app-shell.md#layout-templates) is one blob describing a whole
window: which panes exist, how big they are, and what each pane holds. Two authors'
versions merged line by line make an arrangement neither of them built, so the path is
marked `-merge`. The rule uses `-merge` rather than a registered custom merge driver,
because a driver needs `git config merge.<driver>.driver` installed in every clone to work
at all, and nothing this app runs reaches a collaborator's machine. `-merge` requires no
setup. Git marks the path as conflicted and leaves the "ours" (local) version in the
worktree, and the author picks a side with `git checkout --ours` or `--theirs` and then
`git add`. The comment block above the rule records these same instructions.

`ensureLayouts` appends the rule to an existing `.gitattributes` rather than rewriting the
file, so it preserves what the author wrote and adds only the missing rule. For a new
project, `skeleton()` writes the file outright, so the file lands in the first commit.

A conflict on one of these paths is whole-file by construction, which is what the History
pane's conflict view offers: keep mine or take theirs, with no middle to read
([`history-pane.md`](history-pane.md#the-conflict-view)). Outside a sync the app still
opens whichever side is in the worktree; with `-merge` that is git's "ours", left
unmangled.

## How undo composes with it

The two mechanisms compose with no ordering constraints. Because they compose,
commit-on-save was a small change rather than a redesign, and undo could be lifted out of
git without disturbing commit-on-save. A commit moves a branch ref and the index and
changes no file in the worktree, so a commit cannot perturb a snapshot taken before or
after it.

-   - **Undo commits its restore and never resets.** `git reset` rewrites history, and
      with commit-on-save the commit it would discard may be the only record of a save.
      Undo does not use `git revert` either, because `git revert` applies an inverse diff
      and can conflict, whereas undo holds the exact tree.
-   - The undo scope stays the document class (`UNDO_EXCLUDES`, plus the media the store
      skips wherever it sits) and does not widen to match the commit scope. The commit
      scope covers what changed. The undo scope covers what may be rolled back. An undo
      therefore commits a worktree in which the documents are rolled back and the
      generated files are left as they are, which matches what is on disk.
-   - **Refusing on drift now checks more strictly.** A clean worktree is the norm between
      acts of different kinds, so a failed check means something changed outside the app.
      `undo()` and `redo()` therefore flush a pending batch first, so that a deferred edit
      does not count as drift.
- Undo also works where commit-on-save does not run. The snapshot is held in memory and is
  never written to any history, so a project nested in a larger repo is snapshotted like
  any other.
-   - **A checkpoint narrows the scope of undo further to one declared subtree, for the
      span of one grouped undo point.** The checkpoint's rollback commit uses the same
      `record`/`commit(true, record)` pair an ordinary undo restore uses, so it is
      recorded in `commands.jsonl` the same way. The scope is asserted by whoever opens
      the checkpoint rather than derived from the commands it groups; each command's own
      [`affects`](command-system.md#every-mutating-command-declares-what-it-may-touch) is
      what a derivation would read, and doing so is a follow-up. The full design is in
      [`command-system.md#checkpoints-group-several-commands-into-one-undo-point`](command-system.md#checkpoints-group-several-commands-into-one-undo-point).

## Multi-repo

The repo map is part of commit-on-save and is used only there. `Committer` takes the repo
list, commits each repo that had something to commit, and reports what was committed in
each repo. It commits nested repos before the repo that contains them (`byDepth`, from
`@vn/git/depth`). Committing in that order has two effects:

- The project's `add -A` stages the wiki's new HEAD as its gitlink, rather than the HEAD
  from one act earlier.
- A `wiki/` that has files but no commit yet gets its first commit before the project's
  `add -A` meets it. Git refuses to add a nested repo with no commit checked out.

`vnauthor`'s `git_commit` follows the same order. It splits its paths by owning repo and
commits each group in its own repo, nested repos first. The repo containing a nested one
also stages the nested repo's path, so the gitlink moves even when the agent wrote nothing
in the project itself ([`vnauthor.md`](vnauthor.md#how-it-works)).

Undo has no such notion any more. A snapshot covers a directory (the project root), so a
`wiki/` or `assets/` that happens to be its own repository is snapshotted as part of the
project like any other subdirectory, and there is no repo-boundary detection on that path
at all. Undo now compares one tree hash against another instead of refusing as a unit
across repos.

Remotes, getting and sending saves, and conflict resolution are the History pane's
([`history-pane.md`](history-pane.md#shared-copies)), and each repository syncs on its
own: the project's push is refused while a nested story bible has unsent saves, so the
project's history never names a bible save the shared copy lacks. The app rewrites history
in exactly one place: a pull rebases the author's unsent saves onto the collaborator's,
which gives them new shas, and the pull's record carries the table from old to new. Saves
that have been sent are never rewritten, and a force push is never offered.

### Submodules

`wiki/` (or `assets/`) can be a git submodule of the project, which lets several projects
share one story bible, or gives a bible a history of its own. The repo map needs nothing
extra: `git rev-parse --show-toplevel` reads a submodule's `.git` file the same way it
reads a `.git` directory, so a checked-out submodule is an owned `wiki` repo like any
other nested repo. The plan is
[`../plans/archive/wiki-submodule.md`](../plans/archive/wiki-submodule.md).

- **The wiki leads, and the project records.** The wiki's worktree follows its own branch.
  The project's gitlink follows the wiki's HEAD through the project's ordinary `add -A`.
  The app never runs `git submodule update` and never moves the wiki to match the project.
- **Commit order.** Nested repos commit first, as described above, so the project's
  history records which bible save each project save saw.
- **Submodules are found in the index.** `Git.gitlinks()` lists the index entries of mode
  `160000`. `.gitmodules` is optional and is read only for a branch name. This works for a
  plain nested `git init` too, which gets a gitlink with no `.gitmodules` entry.
  `git submodule status` fails outright on such an entry.
- **A detached submodule is put on a branch at open, when that loses nothing.** A
  recursive clone or `submodule update --init` leaves the submodule on no branch, so its
  saves could not be pushed. `adoptSubmodules` picks a branch: the one `.gitmodules`
  names, else a remote branch that already contains HEAD, else `main` or `master` where
  one exists, else `main`.
    - When that branch is absent or an ancestor of HEAD, the app runs `checkout -B` and
      posts an info notice naming the branch and the undo (`git checkout --detach`).
    - When the branch has moved on without HEAD, the app checks nothing out and posts a
      warning naming both commits.
    - A submodule in the middle of a rebase counts as busy, not detached, and is left
      alone.
- **A submodule that is not checked out is reported, not initialized.** A clone without
  `--recurse-submodules` leaves `wiki/` as an empty directory. The project's `add -A` then
  skips every file written there, so those notes are on disk and in no history. At open, a
  warning names the directory and the command to run (`git submodule update --init`).
  Running it is a network act the app leaves to the author. `Workspace.repos()` reports
  such a directory as `{ role, root: <dir>, owned: false, missing: true }`. The History
  pane's strip, its empty list and its refusals say the submodule is not checked out. Its
  reads refuse too, where they would otherwise answer with the project's history.
- **Undo does not touch repository structure.** The snapshot walk skips `.git` whether it
  is a directory or a submodule's file, and `.gitmodules` is in `UNDO_EXCLUDES`.
- **Adding or removing a submodule** is done in a terminal, never from the app.

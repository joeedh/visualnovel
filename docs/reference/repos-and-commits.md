# Repos and commits

How the app decides **which git repository owns a path** and **when history gets written**.
Design and rationale: [`../plans/archive/repo-map-and-commit-on-save.md`](../plans/archive/repo-map-and-commit-on-save.md).
For undo — which is the other half of the same machinery — see
[`command-system.md`](command-system.md#undo-is-opt-in-and-rests-on-shadow-snapshots) and the survey it came from,
[`../history/gitUndoOptions.md`](../history/gitUndoOptions.md).

<!-- toc -->

- [The repo map](#the-repo-map)
- [Commit-on-save](#commit-on-save)
  * [The invariant](#the-invariant)
  * [Message shape](#message-shape)
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

**The app opens on a clean worktree, and every act ends with one.** Under it, "everything dirty"
and "what this act did" are the same set, so the simplest scope is also the correct one.

Session open establishes it with a **checkpoint commit** in each owned repo:
`Committer.checkpoint(reason)` commits whatever is already there under a `Vn-Checkpoint: true`
trailer. That is where a `vngen run` from the terminal, or an edit made in another editor, gets
recorded — as its own event rather than folded into whatever the author does next.

### Message shape

The subject is the command's own one-liner (`CommandRecord.message`), stripped of a trailing
period and capped at 72 characters; provenance goes in trailers:

```
Moved line L4 into rooftop

Vn-Command: story.moveLine
Vn-Seq: 12
Vn-Invocation: story.moveLine(lineId='L4' toScene='rooftop')
Vn-Source: ui
```

An undo or redo adds `Vn-Undo:` / `Vn-Redo:` naming the seq it reverses. A checkpoint carries
`Vn-Checkpoint: true` and no command fields.

The resulting shas land on `CommandRecord.commits` (`{ repo, sha }[]`) in
`vngen/state/commands.jsonl`, absent on a record that changed nothing or ran without a committer.

### Who does not commit

| Surface | Why |
| --- | --- |
| `vngen` CLI | A CLI run is a build step; build steps do not author history, and a headless run in CI that committed would be a surprise. Its output is picked up by the next session's checkpoint commit. |
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
between `ensureRepo` and the `checkpoint`, which is what keeps the line out of "Changes made
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
the open-time checkpoint exists to absorb it.

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

Conflict resolution stays out of scope, but *noticing* one does not. `listLayouts` reads
`git status` porcelain codes (`isConflictCode`: `DD AU UD UA DU AA UU`) and marks the template
unusable; `view.applyLayout` refuses it, naming the path and quoting the two commands. Applying half
a mesh would be worse than saying so.

## How undo composes with it

The two mechanisms compose **without ordering constraints**, which is what makes commit-on-save a
small change rather than a redesign: a commit moves a branch ref and the index and changes no file
in the worktree, so it cannot perturb a snapshot tree taken either side of it.

- **Undo commits its restore; it never resets.** `git reset` rewrites history, and with
  commit-on-save the commit it would discard may be the only record of a save. Not `git revert`
  either — that applies an inverse *diff* and can conflict, whereas we hold the exact tree.
- **Undo's scope stays the document class** (`['.', ':(exclude)vngen/build', ':(exclude)vngen/state']`)
  and does not widen to match the commit scope. The two answer different questions: *what changed*
  versus *what may be rolled back*. An undo therefore commits a worktree that is
  documents-rolled-back plus generated-as-is, which is exactly what is on disk.
- **The drift refusal gets stronger.** A clean worktree becomes the norm, so a check that fails now
  means something really did change outside the app.
- Undo also works where commit-on-save refuses: a shadow ref writes nobody's history, so a project
  nested in a larger repo still snapshots as it did before.

## Multi-repo

`UndoJournal` takes a repo list. One act has one `seq`, and each repo gets its own snapshot pair
under its own `refs/vn/undo/<seq>/{pre,post}`; the first repo in the list is the **primary**, and
`UndoPoint.pre`/`post` stay its commits, so records written before multi-repo existed stay readable
and stay undoable. `UndoPoint.repos` appears only when an act spanned more than one.

`check` inspects **every** repo before **any** is restored, and refuses as a unit — which makes the
common failure (someone edited a wiki file in another editor) a clean refusal rather than a
half-restore. It does not make the restore atomic: an I/O error between two repos still leaves one
moved, so `restore` returns the roots that did move and the failure message names them rather than
pretending the operation was a no-op.

Out of scope everywhere here: remotes, push/pull, conflict resolution, and rewriting the save
history. A user who wants a tidier log has `git rebase`; the app never rewrites what it wrote.

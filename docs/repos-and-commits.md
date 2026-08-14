# Repos and commits

How the app decides **which git repository owns a path** and **when history gets written**.
Design and rationale: [`plans/repo-map-and-commit-on-save.md`](plans/repo-map-and-commit-on-save.md).
For undo — which is the other half of the same machinery — see
[`command-system.md`](command-system.md#undo) and the survey it came from,
[`gitUndoOptions.md`](gitUndoOptions.md).

<!-- toc -->

- [The repo map](#the-repo-map)
- [Commit-on-save](#commit-on-save)
  * [The invariant](#the-invariant)
  * [Message shape](#message-shape)
  * [Who does not commit](#who-does-not-commit)
- [Bootstrap](#bootstrap)
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

## Commit-on-save

Every act that changed something becomes a commit, in each repo it touched.
`Committer` (`@vn/commands`) is a sibling of `UndoJournal` and opt-in the same way: a
`CommandStack` with no `committer` moves no ref at all, which is what keeps testkit, the CLI, and
the existing tests out of anyone's history.

Scope is the **whole worktree** (`git add -A`) per repo — not `record.written`, which is a
hand-declared claim nothing verifies ([`gitUndoOptions.md`](gitUndoOptions.md) §3), and not the
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

`seedWorkspace` uses the same function for the sample workspace, with its own first-commit
subject, and so does `openWorkspace(root)` — the directory the user picked, made a project if it
is not one yet (a one-line `project.yaml`) and then brought under version control. Which project
is open, and what a switch tears down, is
[`desktop-app.md`](desktop-app.md#which-project-is-open).

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

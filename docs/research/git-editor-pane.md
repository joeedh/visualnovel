# A History pane for the desktop app

<!-- toc -->

- [Summary](#summary)
- [What exists today](#what-exists-today)
    - [The git wrapper](#the-git-wrapper)
    - [Commit-on-save and what a commit carries](#commit-on-save-and-what-a-commit-carries)
    - [Deferral and the clean-worktree invariant](#deferral-and-the-clean-worktree-invariant)
    - [Undo, and how it differs from history](#undo-and-how-it-differs-from-history)
    - [Repositories, ignores and merge attributes](#repositories-ignores-and-merge-attributes)
    - [How an editor is added](#how-an-editor-is-added)
- [Who the pane is for](#who-the-pane-is-for)
    - [The vocabulary the pane uses](#the-vocabulary-the-pane-uses)
- [The top workflows](#the-top-workflows)
    - [1. What did I change today?](#1-what-did-i-change-today)
    - [2. What did the agent do in that turn?](#2-what-did-the-agent-do-in-that-turn)
    - [3. Take that turn back](#3-take-that-turn-back)
    - [4. Get yesterday's rooftop scene back](#4-get-yesterdays-rooftop-scene-back)
    - [5. Name a milestone](#5-name-a-milestone)
    - [6. Which pictures did the last run add?](#6-which-pictures-did-the-last-run-add)
    - [7. Go back to before the bad run](#7-go-back-to-before-the-bad-run)
    - [8. Something changed outside the app](#8-something-changed-outside-the-app)
    - [9. Working with a collaborator](#9-working-with-a-collaborator)
    - [10. First time connecting to GitHub](#10-first-time-connecting-to-github)
- [Required views](#required-views)
    - [The repo strip](#the-repo-strip)
    - [The status view](#the-status-view)
    - [The history list](#the-history-list)
    - [The change view](#the-change-view)
    - [The checkpoint list](#the-checkpoint-list)
    - [The sync view](#the-sync-view)
    - [The conflict view](#the-conflict-view)
        - [Sync is a rebase](#sync-is-a-rebase)
- [The command set](#the-command-set)
    - [Reads](#reads)
    - [Writes](#writes)
    - [What the agent may have](#what-the-agent-may-have)
- [Interaction with the existing systems](#interaction-with-the-existing-systems)
    - [Undo and git](#undo-and-git)
    - [Commit-on-save](#commit-on-save)
    - [The provenance log](#the-provenance-log)
    - [The pipeline running](#the-pipeline-running)
    - [Several repositories](#several-repositories)
    - [`.vnstudio/` and the other files git must not merge](#vnstudio-and-the-other-files-git-must-not-merge)
- [Visual design](#visual-design)
    - [The plan](#the-plan)
    - [Wireframes](#wireframes)
    - [Distinguishing an agent's save](#distinguishing-an-agents-save)
    - [Empty states](#empty-states)
    - [Loading states](#loading-states)
    - [What the notification box says](#what-the-notification-box-says)
- [Plumbing the pane needs](#plumbing-the-pane-needs)
- [Deferred: viewing the project at a save](#deferred-viewing-the-project-at-a-save)
- [Future: history inside the Wiki and Script panes](#future-history-inside-the-wiki-and-script-panes)
- [Non-goals and risks](#non-goals-and-risks)
    - [Non-goals](#non-goals)
    - [Risks](#risks)
- [Open questions for the owner](#open-questions-for-the-owner)

<!-- tocstop -->

This is a requirements and workflow-design report for a new editor pane over the project's
git repositories. It is not an implementation plan. It records what the code already does,
what an author needs from history, the views and commands the pane requires, and the
decisions the owner still has to make. Code is cited as `path:line` against the `todos`
worktree on 2026-09-20.

The pane is called **History** in this report rather than **Git**. Every sentence an
author reads in it is about saves, changes and collaborators, and the word "git" appears
only where the author has to type it somewhere else (a remote URL, a GitHub setting). The
editor id and the command namespace are `git.*` in the code. Whether the pane's title
follows the author's vocabulary or the engineer's is the first open question at the end.

## Summary

- The app already writes a complete, well-attributed history and reads almost none of it
  back. Every act is a commit with `Vn-*` trailers
  (`packages/commands/src/commit.ts:49-64`), the agent commits once per approved plan
  (`packages/authoring/src/loop.ts:1016-1035`), and the open-time sweep records what
  happened outside the app (`apps/desktop/src/main/runtime/workspacelifecycle.ts:207`). No
  pane shows any of it.
- The pane is read-mostly. Its main job is to let an author see what changed, who changed
  it, and to recover from a bad change without a terminal. The write operations it needs
  are a manual save, a named checkpoint, three recoveries (take back one save, go back to
  a save, bring back one file), and sync with a collaborator through one or more remotes.
- Every recovery is a new save. The pane never rewrites history that exists, which is the
  rule undo already follows (`docs/reference/repos-and-commits.md:312-315`). The one
  exception is sync: getting a collaborator's saves rebases the author's unsent saves on
  top of them, so a save that has not left the machine can be rewritten, and a save that
  has cannot. (Decided 2026-09-20; see [Sync is a rebase](#sync-is-a-rebase).)
- The `@vn/git` wrapper needs five additions before the pane can be built: a log that
  returns trailers, parents and per-file stats; a per-commit change list; a blob read; the
  three network verbs; and the merge and conflict verbs. None exist today
  (`packages/git/src/git.ts:74-336`;
  `docs/research/git-library-vs-git-process.md:174-181`).
- Every worktree-changing git command refuses while the session is busy, on the pattern
  `project.installPages` already uses
  (`apps/desktop/src/main/commands/project.ts:353-354`).
- The agent gets tool wrappers for reads, checkpoints and the two per-file or per-save
  recoveries it already has (`git_restore`, `git_revert`). It gets no wrapper for
  whole-tree restore, push, pull or conflict resolution.

## What exists today

### The git wrapper

`packages/git/src/git.ts` is the only place that spawns `git`. It runs `execFile`, never a
shell, and returns `{code, stdout, stderr}` rather than throwing (`git.ts:20-42`). The
methods the pane can use as they stand, and what each lacks, are below.

| Method                                 | Where            | What the pane can use it for            | What it lacks for the pane                                                                     |
| -------------------------------------- | ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `isRepo`, `topLevel`, `branch`, `head` | `git.ts:106-151` | Repo identity and the current branch    | Nothing                                                                                        |
| `status`                               | `git.ts:154-161` | Working-tree entries, conflict codes    | Ahead/behind counts, in-progress merge or rebase state                                         |
| `log(limit)`                           | `git.ts:214-231` | Subject, author, date, hash             | Trailers, body, parents, per-file stats, paging (`before`), a path filter, an author filter    |
| `lastCommitFor(path)`                  | `git.ts:238-242` | The newest save touching one file       | The full per-file history                                                                      |
| `show(ref)`, `diff(opts)`              | `git.ts:245-256` | Raw unified text                        | A structured change list per commit, a diff for one path at one commit, binary detection       |
| `revert(ref)`, `restore(path, ref)`    | `git.ts:259-266` | Take back one save, bring back one file | `revert` commits by itself with no trailers, and conflicts leave the worktree mid-revert       |
| `commit`                               | `git.ts:184-205` | The manual save                         | Nothing                                                                                        |
| `writeTree`, `treeOf`, `applyTree`     | `git.ts:278-335` | Whole-tree restore to a save's state    | Nothing; this is the primitive `git.goBack` is built from                                      |
| `updateRef`, `deleteRef`, `listRefs`   | `git.ts:301-320` | Checkpoints as tags                     | An annotated tag with a message needs `tag -a -m`; `update-ref` makes a lightweight one        |
| `config`, `configGet`                  | `git.ts:132-145` | Reading `remote.origin.url`             | Nothing                                                                                        |
| Any network verb                       | absent           | —                                       | `fetch`, `pull`, `push`, `remote add` do not exist anywhere in the repository                  |
| Any merge verb                         | absent           | —                                       | `merge`, `merge --abort`, `checkout --ours/--theirs`, `add` of a resolved path, `merge` commit |
| A blob read (`show <sha>:<path>`)      | absent           | —                                       | Needed for the image side-by-side and for viewing a deleted file                               |

`RepoResolver` (`packages/git/src/repos.ts:31-96`) discovers which repository owns a path
by running `git rev-parse --show-toplevel` and memoizes the answer per directory.
`Workspace.repos()` applies the project layout to it and reports `role`
(`project | wiki | base`), `root` and `owned`
(`packages/authoring/src/workspace.ts:91-98`, `175-188`). `openRepos` keeps only the owned
ones in `ctx.ownedRepos` and warns about the rest
(`apps/desktop/src/main/runtime/workspacelifecycle.ts:199-203`). The pane reads the same
list.

### Commit-on-save and what a commit carries

`Committer` (`packages/commands/src/commit.ts:103-158`) is constructed per call with the
owned repo list (`apps/desktop/src/main/runtime/context.ts:135-137`) and stages the whole
worktree of each repo with `-A` (`commit.ts:153`). The subject is the command's own
message cut to 72 characters (`commit.ts:35-47`), and the trailers are:

| Trailer              | Written by           | Meaning                                                                                              |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `Vn-Command`         | `commit.ts:51`       | The command id, or several ids comma-separated for a batch (`commit.ts:98`)                          |
| `Vn-Seq`             | `commit.ts:52`, `97` | The record's seq in `vngen/state/commands.jsonl`; for a batch, the last seq                          |
| `Vn-Invocation`      | `commit.ts:53`       | The DSL line; digested props appear as `<sha256:…>`; dropped from a batch commit (`commit.ts:88-92`) |
| `Vn-Source`          | `commit.ts:54`       | `ui`, `menu`, `dsl`, `cdp` or `agent`                                                                |
| `Vn-Undo`, `Vn-Redo` | `commit.ts:58-62`    | The seq the restore reverses                                                                         |
| `Vn-Batch`           | `commit.ts:96`       | `N seqs a,b-c` for a flushed run of deferring commands                                               |
| `Vn-Sweep`           | `commit.ts:146`      | An open-time sweep; no command fields                                                                |

Three kinds of commit in an author's project carry no trailer at all:

- Scaffolding commits at open time (`apps/desktop/src/main/workspace/workspace.ts:88-95`),
  under fixed subjects for `.gitattributes`, layouts and `.gitignore`.
- The first commit `initRepoAt` makes (`workspace.ts:171`).
- The agent's own `git_commit` tool (`packages/authoring/src/tools/git.ts:52-72`). The
  loop scopes its paths to what the turn wrote (`loop.ts:1024-1028`) and blocks it while
  error-severity diagnostics stand (`loop.ts:1016-1023`), but the message is the model's
  own sentence and nothing marks the commit as agent-written.

The last point matters for the pane. In the desktop app, `agent.run` is `mutating` and
does not declare `commitsItself` (`apps/desktop/src/main/commands/agent.ts:20-44`;
`docs/plans/archive/deferring-commit-on-save.md:48-54` records that no shipped command
sets it). One agent turn therefore produces up to two commits: the tool's own commit for
the plan, with no trailers, and then the committer's `-A` commit of whatever the turn left
dirty, with `Vn-Command: agent.run` and the subject `Agent turn: <ask>` (`agent.ts:42`).
The pane can identify the second by trailer. It can identify the first only by adjacency:
a trailerless commit whose parent is, or whose child is, an `agent.run` commit, made
during the seconds that record spans. That is a heuristic, and the requirement in
[Plumbing the pane needs](#plumbing-the-pane-needs) removes the need for it.

`CommandRecord.commits` holds `{repo, sha}[]` for every commit the committer made
(`packages/commands/src/command.ts` via `stack.ts:291-292`), so the pane can go from a
record to its commits. The reverse walk, from a commit to its record, is `Vn-Seq` looked
up in `commands.jsonl`.

### Deferral and the clean-worktree invariant

The app opens on a clean worktree and every act ends with one
(`docs/reference/repos-and-commits.md:92-99`). The exceptions are a run of `defersCommit`
commands, which is `gengraph.setProp` and `gengraph.moveNodes` today, flushed by the next
non-deferring mutator, undo, redo, a workspace switch, quit or 1500 ms of idleness
(`packages/commands/src/stack.ts:30`, `188-196`, `245`). A dirty worktree the pane
observes therefore means one of three things: a deferred batch is pending, something
changed outside the app since the last act, or a rebase, merge or revert is in progress.
The status view has to say which.

### Undo, and how it differs from history

Undo snapshots the document class into an in-memory `ContentStore`; no repository is
involved and the history ends with the process (`packages/commands/src/undo.ts:1-15`,
`44-45`). Undo commits its restore and never resets (`repos-and-commits.md:312-315`), and
it refuses when the worktree is not where its record left it
(`docs/reference/command-system.md:337-339`). Git history is durable, covers the whole
worktree including generated output, and survives a restart. The two do not conflict; a
commit moves no file (`command-system.md:409-411`). A git operation that changes the
worktree does invalidate every undo point behind it, because the next `undo()` hashes the
tree and finds it is not the candidate's `post` tree. The pane has to say so at the moment
it happens, rather than leaving the header's undo arrow to refuse later.

### Repositories, ignores and merge attributes

- `keys/` and `.vnstudio/session.json*` are gitignored
  (`apps/desktop/src/main/workspace/workspace.ts:34`, `41`). `vngen/` is committed on
  purpose (`workspace.ts:37-39`).
- `.vnstudio/layouts/*.json` is `-merge` (`docs/reference/desktop-app-shell.md:531-536`);
  `vngen/state/notifications.jsonl` is `merge=union`;
  `vngen/state/threads/*.native.jsonl`, `vngen/work/graphs/*.json` and
  `vngen/work/graphs/lib/*.json` are `-merge` (`workspace.ts:261-287`). On a conflict git
  leaves the local side in the worktree and marks the path conflicted; nothing in the app
  reads that state today (`repos-and-commits.md:297-302`).
- A project can span more than one repository, and the app commits only in the ones it
  owns (`repos-and-commits.md:29-67`).
- The app never pushes (`docs/guides/github-pages.md:34`). `project.installPages` writes a
  workflow and tells the author to push from elsewhere
  (`apps/desktop/src/main/commands/project.ts:398-406`). Its `check` refuses when the
  session is busy, when there is no repo, no branch, or no `origin`
  (`project.ts:352-375`), which is the shape every git write in the pane should copy.
- On a machine without git the app opens read-only and files a durable note
  (`workspacelifecycle.ts:242-249`; `apps/desktop/src/main/bootstrap/doctor.ts:19`, `69`).

### How an editor is added

- `EDITORS` in `apps/desktop/src/shared/editors.ts:22-149` names every editor with `id`,
  `title`, `what`, an optional `claims` predicate over a document-tree node, an optional
  `pins` field, and `offered: false` for one that is named but not listed. The `what`
  sentence becomes the pane tab's tooltip and the View ▸ Editors entry
  (`editors.ts:352-355`).
- The class extends `VnEditor` and is registered by
  `registerEditor(cls, 'vn.Name', fields)`
  (`apps/desktop/renderer/pathux/app/editor.ts:282-301`). Raw DOM goes in through
  `appendSurface` and gets its own sheet through `adoptStyle` (`editor.ts:217-236`).
  Subscriptions go through `watch`, which re-arms after a tab switch
  (`editor.ts:185-208`).
- The Project pane is the smallest model to copy: a bar built once in `init()` with a
  label, buttons wired through `redrawing(editor, part).act(node, offer, run)`, a surface
  of cards, a footer note, and a `load()` that reads through a non-mutating command
  (`apps/desktop/renderer/pathux/editors/project.ts:55-124`, `204-233`).
- Every offer comes from a rule module in `renderer/rules/<pane>.ts` whose
  `controls(state)` returns the full list, and `renderer/rules/situations/<pane>.ts` names
  the states it is run over; `pnpm gen:uxmodel` writes them to `ux-model.json` and a jest
  test compares (`renderer/rules/projectbar.ts:131-142`,
  `renderer/rules/situations/projectbar.ts:31-63`, `renderer/rules/model.ts:35-62`). A
  refused offer is greyed with its reason above the tooltip
  (`renderer/rules/anchors.ts:93-107`).
- `act()`, `record()` and `pick()` are the three ways a control is drawn
  (`renderer/pathux/tour/anchors.ts:92-124`), and the offer is the one object that carries
  the tooltip, so every control has one (CLAUDE.md, Tooltips).
- The footer line and note conventions come from the Wiki pane: a `wk-foot` strip in the
  mono face holding the path, an uppercase badge, one note that turns vermilion when bad,
  and at most one control (`apps/desktop/renderer/styles/wiki.css:82-142`). The header's
  note frame is the only `noteframe-x` on screen (`editor.ts:163-171`), reached through
  `say()`; durable notices go to the bell through `notify()`
  (`apps/desktop/src/main/commands/project.ts:22`, `398-406`).
- The design tokens are fixed: `--sodium` is the warm accent for the authored side,
  `--signal` the cool accent for the machine side, `--jade` and `--vermilion` for
  outcomes, the `--ink*` ramp for surfaces, and `--sans`/`--prose`/`--mono` for type. No
  new accent hues (`apps/desktop/renderer/styles/tokens.css:8-30`;
  `desktop-app-shell.md:178-184`).
- Thumbnails load over `vnasset://<hash>.<ext>` from the file cache and never from disk on
  a repeat (`apps/desktop/src/main/assets/assetprotocol.ts:29-43`).

## Who the pane is for

The pane is for people who write and direct a visual novel and have never opened a
terminal. Four personas cover the workflows.

| Persona            | What they do all day                                                                      | What they need from history                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Solo writer        | Types in Script and Wiki; runs the agent for drafts; runs the pipeline a few times a week | See what changed today; get yesterday's version of a scene back; name a milestone                       |
| Agent-heavy author | Approves plans in Convo; reviews what the agent wrote afterwards                          | Tell agent saves from their own; read exactly what one turn changed; take one turn back                 |
| Art director       | Approves art, edits art notes and graphs, runs long pipeline passes                       | See which pictures a run added, with the picture; compare the old take and the new one; recover a plate |
| Two collaborators  | A writer and an artist on one project through GitHub                                      | Send saves, get the other's saves, and resolve a collision without learning git words                   |

### The vocabulary the pane uses

Every string in the pane is written in the author's words. The table is the whole mapping,
and a control that needs a word not in it is a sign the feature needs redesigning.

| The pane says                        | Git means                                      |
| ------------------------------------ | ---------------------------------------------- |
| a save                               | a commit                                       |
| now, the latest save                 | `HEAD`                                         |
| what changed since the last save     | the working tree's diff against `HEAD`         |
| unsaved changes made outside the app | untracked or modified paths not from a command |
| a checkpoint                         | an annotated tag                               |
| take back this save                  | `git revert`, committed with trailers          |
| go back to here                      | restore the tree of a commit as a new commit   |
| bring back this file                 | `git restore --source <sha> -- <path>`         |
| a shared copy                        | a remote                                       |
| the shared copy you sync with        | the current branch's upstream remote           |
| send my saves                        | `git push`                                     |
| get their saves                      | `git fetch` + `git rebase`                     |
| both of you changed this             | a conflicted path                              |
| keep mine / take theirs              | the author's side / the collaborator's side    |
| the app's housekeeping               | sweep and scaffolding commits                  |

"Keep mine" and "take theirs" are named from the author's point of view, not git's. During
a rebase git's `--ours` is the upstream side and `--theirs` is the author's own save being
replayed, the reverse of what the words suggest, so the command maps the author's choice
to the flag rather than exposing the flag.

Branch is deliberately absent. The pane shows the current branch name in the repo strip
because a collaborator's `git` shows it too, but it never asks the author to create or
switch one. See [Non-goals](#non-goals-and-risks).

## The top workflows

Each scenario names the persona, the goal, and the steps as the pane performs them. The
command each step runs is in brackets.

### 1. What did I change today?

Solo writer. Opens History. The list shows saves newest first, each with a time, a
one-line subject, a rail colour for who made it, and a count of files. Today's saves are
grouped under a "Today" heading. She clicks a save; the right column lists the files it
touched, grouped by kind (scenes, characters, wiki, pictures, project files). She clicks
`scenes/rooftop.fountain`; the diff shows the changed lines in script form.
[`git.history`, `git.changes`, `git.diff`]

### 2. What did the agent do in that turn?

Agent-heavy author. Filters the list to "Agent" with the who-filter. Each agent save shows
the ask (`Agent turn: make the café scene sadder`) as its subject. Opening it lists every
file the turn wrote, and a link "Open the conversation" opens Convo on the thread. If the
turn produced the agent's own plan commit and the app's commit of the leftovers, the pane
draws them as one row with two saves inside, so the author reads the turn as one event.
[`git.history(who=agent)`, `git.changes`, `view.open(editor=convo, subject=<thread>)`]

### 3. Take that turn back

Same author, same save. The detail header offers "Take back this save". The check reports
whether it applies cleanly ("Reverses 3 files. Nothing since then touched them.") or
refuses by name ("`rooftop.fountain` was changed again in 2 later saves; go back to a save
instead, or bring back the file"). She confirms. A new save appears at the top: "Took
back: Agent turn: make the café scene sadder". Undo history from before this moment is
announced as no longer applying. [`git.takeBack`, `confirm: true`]

### 4. Get yesterday's rooftop scene back

Solo writer. Pins the History pane to `scenes/rooftop.fountain` (the pin follows
`docPath`), so the list shows only saves touching that file. She picks the one from
yesterday evening, reads the diff, and presses "Bring back this file". The scene is
written through the validated path, committed as "Brought back scenes/rooftop.fountain
from yesterday 18:42", and the Script pane re-reads it. This one is undoable, because it
is an ordinary document write. [`git.restoreFile`]

### 5. Name a milestone

Anyone. "Add a checkpoint" in the bar opens a small form: a name and an optional note. The
checkpoint appears as a marker in the list beside the save it names, and the checkpoint
filter lists them alone. A checkpoint can be dropped from its own row. [`git.checkpoint`,
`git.dropCheckpoint`]

### 6. Which pictures did the last run add?

Art director. The list marks pipeline saves with the cool rail and a subject like
"Generated 14 assets". The detail groups pictures first: a grid of thumbnails, one per
picture the save added, each with its slot address. A picture that replaced an earlier
take in the same slot draws both, old on the left, with a wipe handle between them.
Clicking a thumbnail opens the Asset editor elsewhere. [`git.changes`, `git.diff` for the
manifest, `vnasset://` for both sides]

### 7. Go back to before the bad run

Art director. She approved a batch that turned out wrong and the pipeline has redrawn on
top of it. She picks the checkpoint from before the run and presses "Go back to here". The
check says what it will do: "Restores 212 files to how they were at the checkpoint, as a
new save. Nothing in history is deleted." She confirms; the app commits the restored tree
under "Went back to checkpoint: before the rain pass". The pipeline sees the earlier
manifest and task log because `vngen/` moved with the tree. [`git.goBack`,
`confirm: true`]

### 8. Something changed outside the app

Solo writer edited a wiki page in another editor while the app was open. The status strip
at the top of the list reads "2 files changed outside the app" with the two paths. "Save
these" commits them under a subject she types. Until she does, "Go back to here" and "Get
their saves" are refused, because a restore would overwrite the edit and a merge would
land on a dirty tree. [`git.status`, `git.save`]

### 9. Working with a collaborator

Two collaborators. The repo strip shows "Shared copy: github.com/… · 3 saves to send · 1
to get". "Get their saves" fetches and rebases the author's three unsent saves onto the
collaborator's one. If nothing collides, the list shows their save beneath the author's
three and a note says so. If a path collides, the pane switches to the conflict view: one
row per file with "Keep mine" and "Take theirs", and for a text document a third choice,
"Open both", which opens two Wiki panes side by side. A layout template, a graph or a
thread log gets only the two buttons, because those files are marked `-merge`. "Continue"
is refused until every row is decided, and it is refused for a scene that still holds
conflict markers. Because a rebase replays one save at a time, "Continue" may bring a
second round of collisions from the next unsent save; the view says which save is being
replayed ("Replaying 2 of 3: Moved line L4 into rooftop") so the author knows how far
along they are. Then "Send my saves" pushes. [`git.fetch`, `git.pull`, `git.resolve`,
`git.continueSync`, `git.push`]

### 10. First time connecting to GitHub

Two collaborators, day one. The repo strip reads "No shared copy yet". "Add a shared
copy…" takes a name and a URL; the first one added becomes the copy the project syncs
with. The pane does not create the repository on GitHub and does not hold a token; the
author's own git credential helper answers the first push. If it cannot, the refusal is
git's own sentence and a link to the keys guide's GitHub section. [`git.addRemote`,
`git.push`]

A project can have more than one shared copy: a GitHub repository the collaborator reads,
and a second on a NAS or a USB drive as a backup. The sync view lists them all with their
own counts, "Send my saves" is offered per copy, and "Get their saves" comes from the one
marked as the copy the project syncs with, which the author can change. [`git.addRemote`,
`git.removeRemote`, `git.setRemoteUrl`, `git.syncWith`]

## Required views

The pane has five views. One is always the list; the detail column shows whichever of the
other four the selection calls for.

### The repo strip

One line at the top of the pane, per repository the project spans. It is the only place
the branch name and the remote appear.

- Role (Project, Story bible, Base art), root path on hover, branch, "N saves to send · M
  to get" against the remote the branch syncs with when one is known, "No shared copy yet"
  otherwise. With more than one remote the strip names the one it is counting against and
  the sync view lists the rest.
- A project inside a foreign repository (`owned: false`) shows the enclosing root and the
  sentence the app already logs: the app does not write history there
  (`workspacelifecycle.ts:202`). The list is read-only for that repo and every write
  control is refused with that reason.
- With more than one owned repo the strip is a segmented control; the list below follows
  the chosen one. Most projects have one and see no control.

### The status view

The top of the list, present only when the worktree is not clean. It states which of the
three causes applies and offers the one act that clears it.

| Cause                         | How the pane knows                                                        | What it says                                      | Offer                   |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------- |
| A deferred batch is pending   | The stack's pending record count, exposed on `git.status`                 | "Saving 4 graph edits…"                           | none; it clears itself  |
| Files changed outside the app | `status --porcelain` entries with no pending batch and no merge in flight | "2 files changed outside the app", with the paths | Save these…             |
| A rebase is in progress       | `.git/rebase-merge/` exists                                               | "Getting their saves: 3 files need a decision"    | opens the conflict view |
| A merge is in progress        | `.git/MERGE_HEAD` exists; only a terminal can start one                   | "A merge started outside the app is unfinished"   | Give up                 |
| A revert stopped part way     | `.git/REVERT_HEAD` exists                                                 | "Taking back a save stopped part way"             | Give up / Finish        |

### The history list

- Newest first, paged by `before=<sha>` in pages of 50. Grouped by day.
- Each row: time, subject, a rail colour for the maker, the file count, a marker for a
  checkpoint on that save, and a `⇡` glyph on saves not yet sent when a remote is known.
- A batch commit (`Vn-Batch`) reads "and 3 more edits" as the committer already writes it.
- An agent turn's two saves fold into one row that expands.
- Filters in the bar, each recorded as one offer supplying its prop: who (All, Me, Agent,
  Pipeline, Housekeeping), file or entity (from the document tree's vocabulary, so the
  dropdown lists scenes, characters, locations and wiki pages by name rather than by
  path), checkpoints only, and a text search over subjects.
- The pin follows `docPath`. A pinned History pane is the per-file history, and opening it
  from a file's right-click menu ("Show history") is
  `view.open(editor='history' subject=<path>)`.

The maker of a save is derived, in this order, and the derivation is a pure function with
tests:

| Rail         | Rule                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Author       | `Vn-Source` is `ui`, `menu` or `dsl`, and `Vn-Command` is not `agent.run` or `pipeline.*`               |
| Agent        | `Vn-Command` is `agent.run`, or the commit carries the agent trailers proposed below                    |
| Pipeline     | `Vn-Command` is `pipeline.run`, `pipeline.approveAndRun`, `art.*`, `asset.regenerate` or `gengraph.run` |
| Housekeeping | `Vn-Sweep`, a scaffolding subject, or the first commit                                                  |
| Someone else | The author name differs from the local `user.name`, whatever the trailers say                           |
| Unknown      | No trailer and none of the above; drawn in mist with "made outside the app"                             |

### The change view

For one selected save.

- Header: subject, maker, time, the seq and invocation from `commands.jsonl` when `Vn-Seq`
  resolves (shown as "Ran: story.moveLine(lineId='L4' toScene='rooftop')" in the mono
  face), and the three recovery controls.
- Files grouped by kind, in this order: pictures, scenes, characters and locations, wiki,
  storyboards and graphs, project files, logs. Logs (`vngen/state/*.jsonl`,
  `assets/manifest.json`) are folded by default with a count, because every pipeline save
  touches them and they are noise to an author.
- Clicking a file shows its diff in the same column, below the list at large sizes and in
  place of it at small sizes.

The diff renders differently per kind:

| Kind                                                 | Detection                                     | Rendering                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene (`scenes/*.fountain`)                          | path                                          | Script form. Each changed element is drawn as the Script pane draws it (speaker cue, dialogue, action, `[[marker]]`), removed text struck in vermilion, added text underlined in jade. Unchanged context is two elements either side. No `+`/`-` gutter.                                              |
| Sheet (`characters/**`, `locations/*`)               | path, or `type:` in front matter              | Two parts. The front matter is a field table: field, was, now, with added and removed fields marked. The body is a word diff inside paragraphs, because the Wiki pane writes each paragraph as one line (`desktop-app-editors-misc.md:133-140`) and a line diff would show whole paragraphs churning. |
| Wiki note, skill, markdown                           | `.md` outside the two above                   | Word diff inside paragraphs, prose face                                                                                                                                                                                                                                                               |
| Picture (`assets/objects/*`, `vngen/build/assets/*`) | extension                                     | Added: the thumbnail. Replaced in a slot: old and new with a wipe handle. Removed: the old thumbnail greyed with "removed". Bytes come from `vnasset://` when the store still holds them, which is always for content-addressed art, and from the blob read otherwise.                                |
| Storyboard, graph, `project.yaml`, layout            | `.json`, `.yaml`                              | A key-path diff ("`shots[2].camera`: was `wide`, now `close`"), falling back to a line diff for a file that does not parse                                                                                                                                                                            |
| Logs                                                 | `vngen/state/*.jsonl`, `assets/manifest.json` | A count of lines appended, and for the manifest, the slots whose accepted take changed                                                                                                                                                                                                                |
| Anything else                                        | —                                             | A line diff in the mono face; a binary reads "binary, N KB → M KB"                                                                                                                                                                                                                                    |

### The checkpoint list

The checkpoint filter on the history list, with each row carrying its note and a "Drop"
control. Adding one is a bar control that opens `git.checkpoint`'s own form on the
selected save, or on the latest when nothing is selected.

### The sync view

Reached from the repo strip. It lists every remote of the chosen repository: name, URL,
last fetch time, saves to send and to get, and a "Send my saves" control per remote. One
is marked as the copy the project syncs with ("Get their saves" comes from it), and a
control on each of the others makes it the one. Below the list are "Add a shared copy…"
(name and URL), and per row "Change address…" and "Remove". Removing a remote removes
nothing from the project; the sentence says so. It is the only view with a progress state
that can last seconds, and it is the only view whose refusals come from outside the app
(authentication, network). Every refusal is git's stderr sentence, trimmed, in the footer,
and a durable notification when the act was a push or a pull.

The remote list is git's own (`git remote -v` and `branch.<name>.remote`), so a remote
added from a terminal appears, and one the pane adds is visible to a terminal. The app
keeps no list of its own.

### The conflict view

Replaces the change view while a rebase is in progress. One row per conflicted path from
the porcelain codes (`DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`), grouped by kind as above,
under a heading that names the save being replayed and its position ("Replaying 2 of 3:
Moved line L4 into rooftop").

- A `-merge` path (layouts, graphs, thread logs) gets Keep mine and Take theirs. During a
  rebase git's `-merge` fallback leaves the _upstream_ side in the worktree (git's "ours"
  is the branch being rebased onto), so the worktree holds the collaborator's version, not
  the author's, until a side is chosen. The row must not describe the file on disk as
  "mine".
- A text document gets those two plus Open both, which opens two panes: the collaborator's
  side from the worktree and the author's side through the blob read of the save being
  replayed, both read-only until a side is chosen.
- A scene gets the same three, and Continue is refused while `<<<<<<<` markers remain in
  any file under `scenes/`, because the Script pane would fail to parse it.
- Notifications never appear, because union merge resolves them.
- Continue (`git.continueSync`) stages the decided paths and runs `rebase --continue`. If
  the next replayed save collides too, the view stays up with the new heading; otherwise
  the list returns with a note saying how many saves were replayed.
- Give up (`git.abandonSync`) runs `rebase --abort`, which puts the author's saves back
  exactly as they were, and says so.

#### Sync is a rebase

The first draft of this report proposed a `--no-rebase` merge on pull, on the grounds that
a rebase replays one save at a time and so can raise the same `-merge` conflict once per
unsent save. The owner chose rebase (2026-09-20). What that buys and costs:

- An author's history stays a single line, which is what the list draws. There is no merge
  commit to explain, no row with two parents, and "go back to here" has one meaning at
  every row.
- A `-merge` file that both sides touched can conflict on each replayed save that touched
  it. In practice these files (layouts, graphs, thread logs) are written by the app in
  bursts, so a run of unsent saves rarely each touch the same one; the view's "Replaying N
  of M" heading is what keeps the repeated case legible rather than mysterious.
- The author's unsent saves get new shas. That is the exception to "the pane never
  rewrites history", and it is safe only because those saves have never left the machine.
  It breaks the sha-keyed link from a commit to its record in `commands.jsonl`
  (`CommandRecord.commits[]`), so `git.pull`'s own record carries a rewrite table, old sha
  to new, built by pairing `ORIG_HEAD`'s unsent commits with the replayed ones by their
  `Vn-Seq` trailer (trailers survive a rebase; shas do not). The pane resolves a sha
  through every rewrite table on file before it gives up. See
  [The provenance log](#the-provenance-log).
- `git.push` refuses while the branch is behind its remote ("Get their saves first"),
  which under rebase is the only way an author's line can carry the collaborator's saves.
  A force push is never offered.

## The command set

Every command lives in `apps/desktop/src/main/commands/git.ts`, is a thin wrapper over a
session method, and follows the existing definition shape (`command.ts:59-117`). `repo` is
a `prop.oneOf(['project', 'wiki', 'base'])` with default `project`, resolved against
`Workspace.repos()`. Every mutating command declares `check`, and every check refuses
first on `session.busy()` (`apps/desktop/src/main/session/core.ts:878-880`), then on
`owned: false`, then on its own conditions.

A note on `affects`. The vocabulary is closed (`apps/desktop/src/shared/affects.ts:46-71`)
and a mutator must declare a non-empty list drawn from it (`command-system.md:277-279`). A
command that writes only `.git/` names nothing in that vocabulary. The report proposes a
second sentinel beside `<user>` (`affects.ts:39`), spelled `<git>`, that `snapshotted()`
answers false for (`affects.ts:116-119`), so a history-only command is a legal declaration
and is forced non-undoable by the existing rule. A command that changes the worktree
declares `ANY_DOCUMENT` plus `<git>`.

### Reads

| Command       | Props                                                                                   | Returns                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git.repos`   | none                                                                                    | One entry per repo: role, root, owned, branch, head, dirty count, rebase/merge/revert in progress, and `remotes[]` (name, URL, ahead, behind, last fetch, whether it is the one the branch syncs with) |
| `git.history` | `repo`, `limit=50`, `before`, `path`, `entity`, `who=all`, `checkpoints=false`, `query` | Commits with parsed trailers, parents, author, date, per-file counts, maker, the checkpoint names on each, and whether it is sent                                                                      |
| `git.changes` | `repo`, `sha`                                                                           | Files touched: path, status, kind, entity, old and new blob ids, line counts                                                                                                                           |
| `git.diff`    | `repo`, `sha`, `path`, `against=parent`                                                 | The structured diff for one path in the shape the kind table above needs                                                                                                                               |
| `git.blob`    | `repo`, `sha`, `path`                                                                   | Text for a text file, refused over a size cap; for a binary, a `vngit://<repo>/<sha>/<path>` URL served by a protocol handler like `vnasset://`                                                        |
| `git.status`  | `repo`                                                                                  | The status view's data: cause, entries, pending batch count, conflicted paths                                                                                                                          |

Reads are non-mutating and run concurrently. Each is one spawn where git allows it:
`git.history` is one `log` with `--numstat` and a `%(trailers)` format; `git.changes` is
one `show --numstat --format=`; results are cached by sha, since a commit is immutable.

### Writes

| Command              | Props                                 | Undoable | `affects`               | `check` refuses when                                                                                                                                          | Confirm |
| -------------------- | ------------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `git.save`           | `repo`, `message`                     | no       | `<git>`                 | busy; not owned; the worktree is clean ("Nothing has changed since the last save"); a rebase or merge is in progress                                          | no      |
| `git.checkpoint`     | `repo`, `name`, `sha=HEAD`, `note=''` | no       | `<git>`                 | busy; not owned; the name is taken; the sha is unknown                                                                                                        | no      |
| `git.dropCheckpoint` | `repo`, `name`                        | no       | `<git>`                 | not owned; no such checkpoint                                                                                                                                 | no      |
| `git.takeBack`       | `repo`, `sha`                         | no       | `ANY_DOCUMENT`, `<git>` | busy; not owned; dirty; the sha is a merge, a sweep or the first commit; a dry run reports a conflict, naming the files and the later saves that touched them | yes     |
| `git.goBack`         | `repo`, `sha`                         | no       | `ANY_DOCUMENT`, `<git>` | busy; not owned; dirty; a rebase or merge is in progress; the sha is `HEAD` ("The project is already here")                                                   | yes     |
| `git.restoreFile`    | `repo`, `sha`, `path`                 | yes      | `ANY_DOCUMENT`          | busy; not owned; the path is under `keys/` or is the session file; a scene that would not parse; a document with unsaved edits in an open pane                | no      |
| `git.addRemote`      | `repo`, `name`, `url`                 | no       | `<git>`                 | not owned; the name is taken or not a valid ref component; the URL is empty or not `https://`, `git@` or a filesystem path                                    | no      |
| `git.removeRemote`   | `repo`, `name`                        | no       | `<git>`                 | not owned; no such remote                                                                                                                                     | yes     |
| `git.setRemoteUrl`   | `repo`, `name`, `url`                 | no       | `<git>`                 | not owned; no such remote; the URL fails the same test as `addRemote`                                                                                         | no      |
| `git.syncWith`       | `repo`, `name`                        | no       | `<git>`                 | not owned; no such remote; not on a branch                                                                                                                    | no      |
| `git.fetch`          | `repo`, `remote=<upstream>`           | no       | `<git>`                 | not owned; no such remote                                                                                                                                     | no      |
| `git.pull`           | `repo`                                | no       | `ANY_DOCUMENT`, `<git>` | busy; not owned; no upstream remote; dirty; a rebase, merge or revert is in progress; nothing to get                                                          | no      |
| `git.push`           | `repo`, `remote=<upstream>`           | no       | `<git>`                 | not owned; no such remote; nothing to send; behind that remote ("Get their saves first"); a rebase is in progress                                             | no      |
| `git.resolve`        | `repo`, `path`, `side=mine\|theirs`   | no       | `ANY_DOCUMENT`          | no rebase in progress; the path is not conflicted                                                                                                             | no      |
| `git.continueSync`   | `repo`                                | no       | `ANY_DOCUMENT`, `<git>` | no rebase in progress; conflicted paths remain; a `scenes/**` file holds markers                                                                              | no      |
| `git.abandonSync`    | `repo`                                | no       | `ANY_DOCUMENT`, `<git>` | no rebase or merge in progress                                                                                                                                | yes     |

Notes on the table:

- `git.takeBack` and `git.goBack` do not commit through `Git.revert` or `git commit`
  themselves. They change the worktree and let commit-on-save commit the result, so the
  save carries `Vn-Command: git.goBack` and `Vn-Invocation` like every other act, and the
  subject comes from the command's message ("Went back to checkpoint: before the rain
  pass"). `git.goBack` is `applyTree(treeOf(HEAD), treeOf(sha))` (`git.ts:330-335`) over
  the whole tree with no exclusions. `git.takeBack` is `revert --no-commit` followed by a
  reset of the index, or a refusal if the dry run conflicts; the mid-revert state must
  never be left behind.
- `git.restoreFile` writes bytes through the ordinary write path, not `Git.restore`, so
  the `seenHash` refusal, `onWrote` and the undo journal all see it. A scene is parsed
  first through `@vn/parse`. The file is outside `UNDO_EXCLUDES` in every case the check
  allows.
- `git.pull` is `fetch` of the upstream remote plus `rebase <remote>/<branch>`. It runs
  with `commitsItself: true`, because the rebase moves the branch itself and there is
  nothing left for the committer to record; its record instead carries the rewrite table
  described under [Sync is a rebase](#sync-is-a-rebase). When the rebase stops on a
  conflict the command returns normally with the conflict state, since the stopped rebase
  is what the conflict view is for; it is `git.abandonSync` that must never be skipped on
  the failure path of anything else.
- `git.continueSync` stages every resolved path and runs `rebase --continue`. The replayed
  saves keep their own subjects and trailers; the pane makes no commit of its own for a
  sync, and no commit in an author's history ever has two parents unless a terminal made
  it.
- `git.syncWith` sets `branch.<current>.remote` and `branch.<current>.merge`, which is
  where git itself keeps the answer, so a terminal `git pull` agrees with the pane.
- The `affects` executed test tier
  (`apps/desktop/src/main/commands/tests/affects.test.ts`) runs commands over two testkit
  projects. The network commands go in `SKIPS` with the reason that they need a remote;
  `git.goBack` and `git.takeBack` run against a fixture with two commits.
- Every write is serialized on the stack's chain like any other mutator
  (`stack.ts:224-229`), so a pull cannot land inside a command's `-A` commit.

### What the agent may have

| Command                                                            | Tool wrapper | Reason                                                                                                                                        |
| ------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.history`, `git.changes`, `git.diff`, `git.blob`, `git.status` | yes          | Reads; `git_status`, `git_log`, `git_show`, `git_diff` exist already and should return the structured shape instead of raw text               |
| `git.checkpoint`                                                   | yes          | Harmless and useful before a big plan ("I will checkpoint before rewriting act two")                                                          |
| `git.restoreFile`                                                  | yes, confirm | Already `git_restore` with `confirm: true` (`tools/git.ts:86-96`); routing it through the command gives it the parse check and the undo point |
| `git.takeBack`                                                     | yes, confirm | Already `git_revert` with `confirm: true` (`tools/git.ts:74-84`); the dry-run refusal is an improvement                                       |
| `git.save`                                                         | no           | The loop's `git_commit` remains the agent's commit; two save verbs would give the model two ways to commit                                    |
| `git.goBack`                                                       | no           | Whole-tree restore reverses the author's own work as well as the agent's; a person does this                                                  |
| `git.pull`, `git.push`, `git.fetch`, and the four remote commands  | no           | Publication and collaboration are the author's acts; a model must not send saves anywhere or decide where they go                             |
| `git.resolve`, `git.continueSync`, `git.abandonSync`               | no           | Choosing a side of a collision is a judgement the author makes once, with both sides open                                                     |

The tools share the command's rule and refusal sentence without reaching the registry, on
the pattern `edit_scene` uses (`command-system.md:1048-1054`).

## Interaction with the existing systems

### Undo and git

- A `git.goBack`, `git.takeBack`, `git.pull` or `git.resolve` changes the worktree. Every
  undo point before it stops applying, since `undo()` refuses on drift. The pane says so
  in its footer at the moment of the act ("Undo history from before this save no longer
  applies"), and the header's undo label should read the same.
- `git.restoreFile` is an ordinary document write and is undoable. Undo of it commits the
  restore back, as every undo does.
- A mutating git command clears the redo stack like every other mutator (`stack.ts:295`).

### Commit-on-save

- `git.save` is the one command whose commit is itself the act. It runs `Committer.commit`
  with the author's message as the subject rather than a second subject. It does not
  declare `commitsItself`, so the committer runs, finds the tree clean, and commits
  nothing further.
- `git.goBack`, `git.takeBack`, `git.resolve` and `git.pull` leave the worktree dirty at
  the end of `run` and rely on the committer to make the save. That is the same
  arrangement every document command uses.
- A pending deferred batch is flushed before any of these run (`stack.ts:245`), so a batch
  can never be swept into a restore's commit.

### The provenance log

- `Vn-Seq` on a commit indexes `vngen/state/commands.jsonl`; the change view shows the
  invocation from the record. A batch commit's `Vn-Batch` lists the seqs, and the pane
  shows them as "4 edits" that expand to the invocations.
- `commands.jsonl` is itself committed on the next act, so the record for a save is in the
  save after it. The pane reads the live file, not the committed one.
- The log is append-only, and a `git.goBack` restores an older `commands.jsonl` from the
  tree. The pane must not treat a seq that later records reuse as the same act. The record
  the pane shows for a commit is the one whose `commits[]` names that sha, found by sha,
  and `Vn-Seq` is a hint rather than a key.
- A `git.pull` rebases the unsent saves, so the shas in their records' `commits[]` stop
  naming anything on the branch. The pull's own record carries `rewrote: {from, to}[]`,
  and the lookup from a commit to its record is: the sha itself, then the sha mapped back
  through every `rewrote` table in the log, newest first. A record is never edited after
  it is written.

### The pipeline running

- `session.busy()` names a pipeline run, an approve-and-generate pass, an agent turn or a
  report (`apps/desktop/src/shared/ipc.ts:85-101`). Every worktree-changing git command
  refuses while any of them runs, with the sentence `project.installPages` already uses
  ("… is still running; wait for it to finish", `project.ts:353-354`).
- The reverse also holds. `pipeline.run`'s check must refuse while a rebase, a merge or a
  revert is in progress, because a run plans from a tree that is half one thing and half
  another.
- After `git.goBack`, `vngen/build`, `vngen/state/tasks.jsonl` and `assets/manifest.json`
  are the versions at that save, because the restore covers the whole tree. The content
  store under `assets/objects` and `vngen/build/assets` is never pruned by git, so a
  picture that was "removed" in a later save is still on disk under its hash.

### Several repositories

- The pane follows `ctx.ownedRepos` and shows each in the strip. Commands take `repo` by
  role. A wiki repo has its own history, its own remote and its own conflicts.
- `git.goBack` is per repository. Going back in the project repo does not move the wiki
  repo, and the check's note says so when there is more than one.

### `.vnstudio/` and the other files git must not merge

- `.vnstudio/session.json*` is ignored, never committed, never in a diff.
- `.vnstudio/layouts/*.json` is committed and `-merge`. It appears in the change view like
  any file, and in the conflict view with only the two side buttons. Undo restores the
  template file and the shell re-applies it by fingerprint
  (`desktop-app-shell.md:537-541`); the same watch handles a `git.goBack`.
- The pane's own state (which repo is chosen, which filter, the list's scroll position) is
  euphemeral and goes through `saveUIData`/`loadUIData`, not into a struct field, so it is
  never committed.

## Visual design

### The plan

The pane draws inside the app's fixed token set, so the palette is not a choice to make.
What is chosen is how history is drawn, and the one place the pane spends its boldness.

- **Colour.** `--ink` for the pane, `--ink-raised` for the strip and footer,
  `--ink-sunken` for diff bodies. `--sodium` is the author's rail, `--signal` the agent's
  and the pipeline's, `--mist-dim` for housekeeping and for saves made outside the app.
  `--jade` and `--vermilion` are used only inside a diff and only for added and removed
  text. A collaborator's saves take no colour of their own; they are marked by the author
  name.
- **Type.** `--sans` (Archivo) for the list, the strip and every control. `--mono` (IBM
  Plex Mono) for hashes, paths, invocations and the diff of a file that is code or data.
  `--prose` (Newsreader) for the diff of a scene, a sheet's body and a wiki note, at the
  Wiki pane's 16px and 1.6 leading, so a changed line of dialogue reads as dialogue.
- **Layout.** Two columns at width. The list is a fixed 320px on the left with the strip
  and the status view above it; the detail fills the rest, with the file list on top and
  the diff beneath. Left-aligned throughout; nothing is centred except an empty state.
- **The memorable element.** The prose diff. A scene's change is drawn as script, in the
  prose face, with removed words struck and added words underlined. There is no `+`/`-`
  gutter and no hunk header anywhere the author reads prose. A picture's change is a wipe
  between two takes rather than two thumbnails side by side.
- **Principles.** Every row says who, when and what in that order. A refused control stays
  visible and greyed with the reason (the app's rule). Nothing animates on load; the one
  motion is the wipe handle, which answers a drag.

Reviewed against the generic version of this page: a git history pane is usually a commit
list with hashes, a `+`/`-` unified diff in monospace, a branch graph on the left, and
green and red backgrounds. This design has none of those in the author's path. Hashes are
a tooltip on the time, the diff for prose is prose, there is no graph because the pane
exposes no branches, and colour on a diff is applied to the words, not the lines.

### Wireframes

Large (≥ 900px):

```
┌ HISTORY   [All ▾] [Anything ▾] [Checkpoints] [search…]  [+ Checkpoint] [⟳] ┐
│ Project · main · shared copy github.com/mara/rooftop · 3 to send · 0 to get │
├────────────────────────────┬────────────────────────────────────────────────┤
│ 2 files changed outside    │  Moved line L4 into rooftop                    │
│ the app        [Save these…]│  You · today 14:02 · Ran story.moveLine(…)    │
│────────────────────────────│  [Take back this save] [Go back to here]       │
│ Today                      │────────────────────────────────────────────────│
│ ▌14:02 Moved line L4 …  2  │  Scenes                                        │
│ ▌13:40 Agent turn: make …  │    scenes/rooftop.fountain       +3 −1         │
│ ▌13:12 Generated 14 assets │    scenes/cafe.fountain          +0 −1         │
│ ▌12:58 Autosaved wiki/…  1 │  Logs (2)                                  ▸    │
│ Yesterday                  │────────────────────────────────────────────────│
│ ▌18:42 Saved scenes/roof…  │  MARA                                          │
│ ⚑ before the rain pass     │  I never said that. ~~Not to you.~~ Not out    │
│ ▌18:10 Went back to …      │  loud.                                         │
│                            │                                                │
│                            │  [[goto: alley]]                                │
├────────────────────────────┴────────────────────────────────────────────────┤
│ scenes/rooftop.fountain · a1b2c3d                       Undo still applies  │
└─────────────────────────────────────────────────────────────────────────────┘
```

The rail `▌` at the start of each row is the maker colour. `⚑` is a checkpoint marker
drawn on the save it names, not a row of its own.

Small (< 560px): one column. The strip collapses to the branch and the counts. The list is
the whole pane; selecting a row replaces it with the detail under a "← History" control in
the bar; selecting a file replaces the file list with the diff under "← Files". The status
view becomes a single badge line above the list that opens the same act.

Middle (560–900px): two columns, list at 260px, the diff opens over the file list rather
than beneath it.

### Distinguishing an agent's save

- The rail is `--signal`.
- The subject is the ask, as the committer already writes it (`Agent turn: <ask>`).
- The row carries a small "agent" badge in the Wiki pane's badge style
  (`wiki.css:103-111`) with `--signal` in place of `--sodium`.
- The detail header adds "Open the conversation" when the thread is known.
- A turn with two saves is one row with a `2` count that expands into both, so the author
  reads one event and an engineer can still see two commits.

### Empty states

| Situation                     | The pane says                                                                                                         | Offer                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| No git on this machine        | "Saving history needs git, which was not found. The project still works; nothing is recorded." plus the doctor's link | Download git           |
| Project inside a foreign repo | "This project sits inside `<root>`, which the app does not write history to. Showing that repository read-only."      | none                   |
| A repo with one commit        | "Every save will appear here. Edit anything and it is saved."                                                         | none                   |
| Filter matches nothing        | "No saves touch `wiki/houses.md` yet."                                                                                | Clear filter           |
| No remote                     | "No shared copy yet. Connect one to work with someone else."                                                          | Connect a shared copy… |
| Selected save has only logs   | "This save changed nothing an author edits; it updated the task log."                                                 | Show logs              |

### Loading states

Every git call is a subprocess costing about 40 ms on Windows before it does anything
(`git-library-vs-git-process.md:190-194`), and a pull or a push can take seconds.

- A read that lands within 150 ms shows no loading state.
- A slower read keeps the previous content on screen at reduced opacity and puts a
  sentence in the footer ("Reading history…"). The list never blanks.
- A pull or push shows its sentence in the footer with the elapsed time ("Getting their
  saves… 4 s") and the bar's controls refuse with "Still getting their saves" until it
  returns. No spinner in the list.
- A read that fails puts git's sentence in the footer in vermilion and keeps the stale
  content.

### What the notification box says

Two channels exist. The header's note frame (`say()`) is for the sentence a click
produces; the bell (`notify()`) is for what has to survive the frame. The pane uses them
as follows.

| Event                                 | Note frame                                                                    | Durable notification                                              |
| ------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Saved, checkpoint added or dropped    | the command's message                                                         | none                                                              |
| Took back a save, went back to a save | the command's message, plus "Undo history from before this no longer applies" | none                                                              |
| Got their saves with no collision     | "Got 5 saves from the shared copy"                                            | none                                                              |
| Got their saves with a collision      | "3 files need a decision"                                                     | yes: the count and the paths, linking to the History pane         |
| Sent saves                            | "Sent 3 saves"                                                                | none                                                              |
| A push or pull refused by the remote  | git's sentence                                                                | yes: the sentence, with a link to the keys guide's GitHub section |
| A batch flush failed                  | already filed (`repos-and-commits.md:181-184`)                                | already filed                                                     |

## Plumbing the pane needs

These are additions to code that exists, each cited to where it goes. None is an
implementation plan; each is a requirement the pane depends on.

| Need                                                                                                                                        | Where                                                               | Why                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Git.log` returning trailers, parents, body, `--numstat`, with `before`, `path` and `author` filters                                        | `packages/git/src/git.ts:214-231`                                   | The list, the maker rule and the per-file history                            |
| `Git.changes(sha)` and `Git.diffPath(sha, path)`                                                                                            | new methods beside `show`/`diff`, `git.ts:245-256`                  | The change view and the per-kind diff                                        |
| `Git.blob(sha, path)` and a `vngit://` protocol handler                                                                                     | `git.ts`; beside `assetprotocol.ts:29-43`                           | A deleted picture's old side; the other side of a conflict                   |
| `Git.tag`, `Git.listTags`, `Git.deleteTag` for annotated tags                                                                               | `git.ts:301-320` area                                               | Checkpoints with notes; `update-ref` makes lightweight tags with no message  |
| `Git.fetch`, `Git.push`, `Git.rebase`, `Git.remotes`, `Git.remoteAdd/Remove/SetUrl`, `Git.upstream`, `Git.setUpstream`, `Git.aheadBehind`   | new; `run` gains `GIT_TERMINAL_PROMPT=0` (`git.ts:20-42`)           | Sync; a prompt for a password must fail rather than hang a hidden subprocess |
| `Git.inProgress` (rebase, merge, revert), `Git.checkoutSide`, `Git.rebaseContinue`, `Git.rebaseAbort`, `Git.mergeAbort`, `Git.revertDryRun` | new                                                                 | The status and conflict views and the take-back refusal                      |
| The open-time sweep leaving a stopped rebase, merge or revert alone                                                                         | `apps/desktop/src/main/runtime/workspacelifecycle.ts:207`           | A sweep commit on top of a half-replayed tree would bury the conflict        |
| `rewrote: {from, to}[]` on `CommandRecord`, written by `git.pull`                                                                           | `packages/commands/src/command.ts`; `stack.ts:291-292`              | The commit-to-record lookup survives the rebase of unsent saves              |
| Trailers on the agent's `git_commit`: `Vn-Source: agent`, `Vn-Thread: <id>`, `Vn-Plan: <n>`                                                 | `packages/authoring/src/tools/git.ts:67`, `loop.ts:1024-1029`       | Removes the adjacency heuristic for the agent's own save                     |
| A `<git>` sentinel in the `affects` vocabulary                                                                                              | `apps/desktop/src/shared/affects.ts:39-71`, `116-119`               | History-only commands need a legal, non-snapshotted declaration              |
| `pipeline.run` refusing mid-rebase, mid-merge and mid-revert                                                                                | `apps/desktop/src/main/commands/pipeline.ts:51`, `128`, `155`       | A run must not plan from a half-replayed tree                                |
| A `history` entry in `EDITORS` with `pins: 'docPath'` and a `claims` on `file`, `scene`, `wiki`, `character`, `location` as `secondary`     | `apps/desktop/src/shared/editors.ts:22-149`                         | So the tree, the pin and `view.open` reach it                                |
| "Show history" in the document tree's right-click table                                                                                     | `renderer/pathux/doctree/doctree.ts`                                | The per-file history entry point                                             |
| A maker classifier, a per-kind diff renderer and the status-cause rule as pure modules with tests                                           | `renderer/rules/history.ts`, `renderer/rules/situations/history.ts` | The rule-module pattern; `pnpm gen:uxmodel` and the anchor sweep follow      |

## Deferred: viewing the project at a save

Requested 2026-09-20: a "View project at this save" control on a row, which opens the
whole project as it stood at that commit, read-only, so the author can walk it in the
ordinary editors rather than one diff at a time. It is deferred to a plan of its own
because it touches the workspace lifecycle rather than the pane, but the shape is recorded
here so the pane's plumbing does not cut it off.

- **What it is.** The project at commit X, opened in the app with every editor in
  read-only mode: Script, Wiki, Shot Coverage, the asset editors, the playable. No command
  that writes runs, `stack.check` refuses every mutator with one sentence ("Viewing the
  project as it was on 18 Sep at 18:42; changes are not possible here"), the agent is not
  offered, and the pipeline does not run.
- **The two ways to build it.** (a) A detached worktree:
  `git worktree add --detach <cache-dir>/<sha> <sha>` and open that directory as the
  workspace. Every editor works unchanged because it is reading a real directory, and
  pictures resolve because the content store under `assets/objects` is by hash. (b) A
  virtual workspace: a document source that answers reads from `git.blob` at X instead of
  the filesystem. Nothing is written to disk, but every editor and every read path in
  `WorkspaceSession` has to accept a second source, which is a far larger change.
- **The recommendation is (a)**, with these consequences the plan has to take on:
    - Only one workspace is open at a time (`desktop-app.md:48-49`), so viewing at X
      either replaces the live workspace for the duration, with a persistent banner and
      one control ("Back to now"), or the single-workspace rule is relaxed for a read-only
      second one in its own window (`window.*` exists, `plans/multiple-windows.md`).
      Replacing is the smaller change and is enough for the workflow; the author is
      looking, not comparing side by side.
    - The open-time sweep and the scaffolding commits must not run in a detached worktree.
      A read-only open mode already exists for the no-git case (`workspacelifecycle.ts`,
      `noticeMissingGit`); the plan generalizes it into a mode the lifecycle takes as an
      argument rather than infers from the machine.
    - `.vnstudio/session.json` and `keys/` are gitignored, so the detached worktree has
      neither; the layout comes from the committed template and the session file is not
      written. Keys are not needed because nothing generative runs.
    - A checkout of `vngen/build` at X copies every asset at X into the cache dir. For a
      large project that is hundreds of megabytes per viewed save, so the cache is bounded
      (the last two or three views) and cleared on quit with `git worktree remove`; a
      sparse checkout that excludes `vngen/build/assets` and lets `vnasset://` resolve
      pictures by hash from the live store is the optimization if the copy proves slow.
- **What the pane does now** so this stays open: `git.blob` and the `vngit://` handler are
  built as general reads rather than diff helpers, and rows carry their sha in a form
  `view.open` can later take (`view.open(editor=… subject=… at=<sha>)` is the likely
  spelling).

## Future: history inside the Wiki and Script panes

Also requested 2026-09-20, and out of scope for this pane: a history menu on the editors
themselves, so an author in the Wiki pane can pick an earlier version of the page they are
looking at without going to History. The pane's plumbing is what makes this cheap later.

- **Wiki, sheets, notes.** Easy. The editor asks `git.history(path=…)` for the list,
  `git.blob(sha, path)` for a version, and lands the text in memory as an unsaved edit.
  The author's next save is an ordinary document write, committed as a new save through
  the usual path, and undoable. No new command is needed beyond the two reads; the editor
  already owns an in-memory buffer and a save.
- **Script.** Harder, for reasons that are the scene round-trip's, not git's. A scene's
  text carries `[[line:]]` ids that the storyboard, `work/shots/<sceneId>.json` and the
  approved assets are keyed on; an older version of the scene may hold ids that have since
  been moved to another scene by `story.moveLine`, or lack ids that later work depends on.
  Landing old text in memory is fine; writing it back is where `seenHash`, the lossless
  round-trip refusal and the line-id contract all have a say, and the write may need to be
  a reconciliation (keep the current ids where the elements match, flag the ones that do
  not) rather than a byte-for-byte restore. That reconciliation is the work of the future
  plan; `git.restoreFile`'s parse check is its first, coarse form.
- **Pictures.** An earlier take of a slot is already reachable through the manifest's
  history and the content store, and the Asset editor's own history is the slot's, not the
  file's. `docs/research/slots-as-asset-history.md` is the relevant thread.

## Non-goals and risks

### Non-goals

- **Rewriting history that has left the machine.** No amend, reset or force-push, and no
  rebase of anything a remote already holds. A save that is wrong is taken back by a new
  save. This is the rule undo already follows and the rule the provenance log depends on
  (`repos-and-commits.md:349-351`). Renaming a save's subject is therefore out too; a
  checkpoint's note is where an author names a moment. The one rewrite the pane performs
  is the rebase of unsent saves inside `git.pull`, and the rewrite table in its record is
  what keeps the provenance log honest about it.
- **Branches.** The pane shows the current branch name and creates none. An author's
  branching is the story's, and the app's own files (layouts, graphs, thread logs) are
  marked `-merge` because they cannot be merged, so a workflow built on merging branches
  would fail on the first template change. If a second line of work is ever needed, it is
  a second clone.
- **Detached HEAD.** The pane never checks out a commit. "Go back" restores a tree as a
  new save on the current branch. If an author detaches HEAD from a terminal, the strip
  says "Not on a branch" and every write is refused with that sentence, the same way
  `project.installPages` refuses (`project.ts:362-368`).
- **Submodules.** A generated project has none (`git-library-vs-git-process.md:617-625`).
  The pane lists a submodule path as an ordinary changed path and offers nothing on it.
- **Creating the repository on GitHub, or holding a token.** The pane takes a URL and the
  author's own credential helper does the rest.
- **A git library.** Everything stays on the subprocess, per the standing recommendation
  (`git-library-vs-git-process.md:56-76`), and the pane must not become the reason to
  revisit it; the section "What would change the recommendation" already names "the app
  starts pushing" as a reason to stay on the subprocess
  (`git-library-vs-git-process.md:716-718`).

### Risks

- **Large binary assets in git.** `vngen/` is committed by design, so a project's history
  grows by every picture the pipeline draws, and a push sends all of it. A project with
  two thousand assets is hundreds of megabytes of history. Git LFS would move the bytes
  off the repository but needs an install on every collaborator's machine and a setting in
  the hosting service. The pane cannot fix this; it can report the repository's size in
  the strip and refuse a push that GitHub will reject (over 2 GB, or a single file over
  100 MB) before spending the upload.
- **Credentials.** A push from a hidden subprocess with no terminal either uses the helper
  or fails. On Windows Git Credential Manager opens its own window, which works. On a
  machine with no helper the failure sentence names nothing an author can act on, so the
  refusal must link to a written guide.
- **Repeated conflicts under rebase.** A `-merge` file both sides touched conflicts once
  per replayed save that touched it, so an author with ten unsent saves that each moved a
  graph node could answer the same question ten times. The mitigation is the "Replaying N
  of M" heading and the fact that the app's own files are written in bursts; if it proves
  common in practice, `rerere` (`git config rerere.enabled true` in the project repo)
  records each answer and replays it, at the cost of a resolution the author did not see
  being applied on their behalf.
- **A rebase interrupted by a crash or a quit.** `.git/rebase-merge/` outlives the
  process. The open-time sweep must not commit on top of a stopped rebase; it has to see
  the state and leave the worktree to the status view, which offers Continue and Give up.
  That is a change to `workspacelifecycle.ts:207`, listed under plumbing.
- **Conflict markers in prose.** A scene that merges textually and ends up with markers is
  a file the Script pane cannot parse. The conflict view refuses to finish while any file
  under `scenes/` holds them, and `pipeline.run` refuses mid-rebase, but an author who
  resolves from a terminal bypasses both. The sweep commit would then commit the markers.
  That is an existing exposure the pane narrows but does not close.
- **The provenance seq after a restore.** `git.goBack` restores an older `commands.jsonl`,
  and the next act appends a record whose seq collides with a later one from before the
  restore. The pane looks records up by sha, never by seq alone.
- **Two saves per agent turn.** Until the agent's commit carries trailers, the fold in the
  list rests on adjacency, and a turn whose `git_commit` was blocked by diagnostics
  produces one save rather than two. The rule must handle both shapes.
- **Spawn cost in the list.** A history page is one spawn, but a per-row maker rule that
  needed a second spawn per commit would cost two seconds for fifty rows on Windows. The
  requirement that `git.history` return trailers in one call is what keeps the list fast.
- **`git status` on a large worktree.** About 50 ms on a project-shaped repository and 170
  ms in this monorepo (`git-library-vs-git-process.md:196-199`). The status view polls
  nothing; it re-reads on `onExec`, on `onInvalidate` and on focus.

## Open questions for the owner

1. **Title.** "History" (the author's word) or "Git" (the engineer's, and what the task
   named)? The report uses History; the editor id is `history` and the commands are
   `git.*` either way.
2. ~~**Pull strategy.**~~ Decided 2026-09-20: rebase. The report is written to it; see
   [Sync is a rebase](#sync-is-a-rebase) for what the choice costs and how the provenance
   log absorbs the rewrite.
3. **Trailers on the agent's commit.** Should `git_commit` in `@vn/authoring` write `Vn-*`
   trailers, which puts desktop provenance vocabulary into a package `vnauthor` also runs?
   The alternative is `commitsItself: true` on `agent.run` so a turn makes one save, which
   changes the shape of every agent commit today.
4. ~~**Whole-tree scope of Go back.**~~ Decided 2026-09-20: the whole tree. `git.goBack`
   restores `vngen/build` and `vngen/state` with the documents. The per-editor history
   menus described under [Future](#future-history-inside-the-wiki-and-script-panes) are
   where a narrower, one-file restore will live.
5. **Rename a save.** Is amending the latest save's subject, only while it is unsent,
   worth an exception to the no-rewrite rule? The report says no. The rebase decision
   makes the exception smaller than it was, since an unsent save is already one the pane
   may rewrite, but the answer stays no until a workflow needs it.
6. **Repository size.** Should the pane warn at a threshold, and is Git LFS ever going to
   be an option for `vngen/build/assets`?
7. **Agent tool for `git.goBack`.** The report withholds it. Is there a workflow where the
   agent should restore the whole project on its own, under confirm?
8. **A base-art repository.** `Workspace.repos()` already knows a `base` role
   (`packages/authoring/src/workspace.ts:91`). Does the pane need to ship with three roles
   in the strip, or two?
9. **The document tree's history entry.** Should "Show history" be on every node, or only
   on files and entities with a sheet?
10. **Where "View project at this save" lands.** Replace the live workspace for the
    duration with a banner and "Back to now", or relax the one-workspace rule for a
    read-only second window? The deferred section recommends replacing; the multiple
    windows plan may have moved the ground by the time the plan is written.
11. **`rerere`.** Turn it on in an author's repository so a `-merge` conflict answered
    once is answered the same way on every replayed save, at the cost of a resolution the
    author does not see applied? The report leaves it off until the repeated case is seen
    in practice.

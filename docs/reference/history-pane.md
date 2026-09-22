# The History pane

The History pane is the app's view of a project's git history: every save, who made it,
what it changed, the ways back, and the shared copies a collaborator works from. It was
built from [`../research/git-editor-pane.md`](../research/git-editor-pane.md) through
[`../plans/archive/history-pane.md`](../plans/archive/history-pane.md), whose per-stage
"As built" notes record where the shipped code departs from the plan. The author-facing
side of syncing is [`../guides/collaborating.md`](../guides/collaborating.md).

<!-- toc -->

- [Where the code is](#where-the-code-is)
- [Vocabulary](#vocabulary)
- [The list and the strip](#the-list-and-the-strip)
- [The change view](#the-change-view)
- [The status view and the recovery controls](#the-status-view-and-the-recovery-controls)
- [Shared copies](#shared-copies)
- [Sync is a rebase](#sync-is-a-rebase)
- [The conflict view](#the-conflict-view)
    - [Deciding a file by editing it](#deciding-a-file-by-editing-it)
- [The app's logs during a rebase](#the-apps-logs-during-a-rebase)
- [From the agent](#from-the-agent)
- [Testing](#testing)

<!-- tocstop -->

## Where the code is

- `@vn/git` holds every rule both hosts share. `git.ts` is the wrapper (reads, writes,
  `inProgress()`, the rebase verbs), `parse.ts` the parsers for `log`, `diff-tree`,
  porcelain v2 and `for-each-ref`, `history.ts` the `Save`/`Maker`/`Change`/`Diff` types
  with `makerOf` and `statusCause`, `recovery.ts` the take-back, go-back, restore and
  checkpoint rules with their refusal sentences, and `sync.ts` the remote-name and address
  rules, `finishRebase` and the rewrite table.
- The desktop's main side is three parts of `WorkspaceSession`: `session/history.ts`
  (`HistoryPart`: the reads, paged and memoized), `session/recovery.ts` (`RecoveryPart`:
  the six local writes) and `session/sync.ts` (`SyncPart`: the ten sync writes). The
  commands in `main/commands/git.ts` are thin wrappers over them. `assets/gitprotocol.ts`
  serves `vngit://` for a blob at a save.
- The renderer is `renderer/pathux/editors/history.ts` (`HistoryEditor`, area name
  `history`) with the diff renderers under `editors/history/diffs/`, the pure rules in
  `renderer/rules/history.ts` (every control is an `Offer`, so `ux-model.json` records
  it), the situations in `rules/situations/history.ts`, and `styles/history.css`.
- `apps/desktop/src/shared/history.ts` carries what both processes name: `kindOf`,
  `KIND_ORDER`, `parseGitUrl`/`blobUrl`, and the refusal sentences the renderer draws
  before a command has answered (`NOT_OWNED`, `SYNC_UNFINISHED`, `NO_UPSTREAM`,
  `UNSAVED_EDITS`), pinned to `@vn/git`'s by a test because the renderer must not import
  the package.

## Vocabulary

The pane never says commit, branch, remote, push, pull, rebase or conflict. A commit is a
_save_; a tag under `refs/tags/vn/checkpoint/` is a _checkpoint_; a remote is a _shared
copy_; a push _sends_ saves and a fetch-and-rebase _gets_ them; a rebase that stopped is a
_file waiting on a decision_. Every refusal is one sentence in those words, and a greyed
control shows the sentence its command's `check` gave.

Repositories are named by role, `project`, `wiki` (a story bible that is its own
repository nested in the project) and `base` (base art), and every `git.*` command takes
`repo` as one of those. The app writes only in a repository the project owns; a project
that merely sits inside a larger repository reads its history and refuses every write with
`NOT_OWNED`.

## The list and the strip

The list is `git.history` paged by `before=<sha>` at `PAGE` (50) rows, grouped by day,
with a maker rail, the file count, a checkpoint marker and an unsent glyph per row. The
`who` filter is a post-filter on the `Vn-*` trailers, so the session over-fetches in pages
until a page fills or `SCAN_CAP` commits have been scanned. The path chip follows the
document tree's selection ("Show history" on any node that names one file); the text
search and the chip re-read, the maker and checkpoint filters filter what was read. A read
carries a token so a stale answer is dropped; one slower than `SLOW_MS` dims the body.
Every mutating command reloads the pane, and while `git.status` reports a pending batch
the pane polls it for the deferred commit.

`makerOf` attributes a save by email, then by name, against the local identity: the
author, a collaborator by name, the agent (a `Vn-Source: agent` trailer, or a trailerless
commit whose first child is an `agent.run` commit by the same identity within
`AGENT_FOLD_MS`, which is how history from before the trailer reads), and housekeeping
(the scaffolding subjects and a commit carrying only `Vn-Thread`).

The strip says `<role> · <branch> · shared copy <remote>/<branch> · N to send · M to get`,
"not yet compared" while the counts are null, "getting their saves" mid-rebase, and what
to do when HEAD is detached. The branch comes from `rebase-merge/head-name` during a
rebase, because `git branch` answers `HEAD` then.

## The change view

Selecting a save shows its subject, maker, time, the invocation from the trailers ("Ran:
`story.editLine(...)`", or "30 acts: story.editLine, story.setSpeaker" for a batch), the
checkpoints on it, and its files grouped by kind in `KIND_ORDER` with the app's logs
folded. A file opens its diff: a scene as script (element classes mirroring `script.css`,
struck and underlined words), a note or a sheet as paragraphs with a word diff, other text
as mono lines, a picture as a thumbnail (old and new for a replaced one, with a wipe for a
modified path), and a log as a count, or for the manifest the slots that hold a different
picture. Whole added or removed paragraphs take a colour and a rail; the strike and the
underline are for words changed inside a paragraph. Over `LINE_DIFF_CAP` lines a side the
diff is git's own hunks. At full width the diff sits beneath the file list; narrower, it
takes the list's place under a bar with "← Files" and the path. A picture at a save is
served as `vngit://<role>/<blobId>.<ext>`.

"Open the conversation" on an agent save reads `Vn-Thread`, falling back to the
`vngen/state/threads/<id>.jsonl` the save touched, and opens the Convo pane on that
thread.

## The status view and the recovery controls

With nothing selected the detail column shows the worktree's state through `statusCause`:
clean, a batch pending its commit, changes made outside the app (with "Save these…"
running `git.save`), a sync part way, or a repository the project does not own. The app's
own logs under `vngen/state/` are quiet: a read appends to `commands.jsonl` without a
commit, and would otherwise read as a change made outside the app.

The detail header offers "Take back this save" (`git.takeBack`: `revert --no-commit`, then
the index reset so the committer sees a plain dirty tree), "Go back to here"
(`git.goBack`: `applyTree(treeOf(HEAD), treeOf(sha))`, no exclusions), and "Drop
checkpoint" per checkpoint; the diff view offers "Bring back this file"
(`git.restoreFile`, text only, a scene checked through `sceneTextProblem` first). The bar
has "⚑ Checkpoint…" (`git.checkpoint`, the name slugged into the tag and kept as the
message's first line). The pane asks each command's `check` when a row is selected and
after every reload, and draws a refusal with the check's own sentence. After a take-back
or a go-back the undo history from before no longer applies, and the footer and the
header's undo arrow both say so.

## Shared copies

The strip's "Shared copies" toggle opens the sync view: every remote, the one the branch
syncs with first, each with what it has to send and get, when it was last checked, and
"Send my saves", "Check", "Sync with this copy", "Change address…" and "Remove"; below
them, "Add a shared copy…". The first remote a branch gets becomes the one it syncs with
(`branch.<name>.remote`/`.merge`, where a terminal `git pull` reads it too). A remote name
and an address are checked by `remoteNameProblem` and `remoteUrlProblem`: `https://`,
`git@host:`, `ssh://` or a filesystem path. The app never creates the copy.

A send is `push --follow-tags <remote> <branch>`, so checkpoints travel with their saves.
It is refused while there is nothing to send, while the copy has saves not yet got (under
a rebase, getting theirs is the only way the author's line can carry them), while a sync
is part way, and for the project while a nested story bible has unsent saves of its own,
since the project's history would then name a bible save the copy lacks. A copy that
refuses answers in git's own sentence (`remoteSentence`), and the notification links to
the collaborating guide. Git runs with `GIT_TERMINAL_PROMPT=0` and `ssh -oBatchMode=yes`,
so a sign-in prompt fails instead of hanging; a credential helper with its own window
still works.

## Sync is a rebase

"Get their saves" (`git.pull`) fetches the upstream and runs
`rebase --autostash <remote>/<branch>`. The author's unsent saves are replayed on top of
the collaborator's, so history stays one line and every row keeps one meaning. That is the
one place the app rewrites history, and it is safe because those saves have never left the
machine; a force push is never offered.

A replayed save gets a new sha, which breaks the sha-keyed link from a commit to its
record in `commands.jsonl`. The command that completes the rebase (`git.pull`, or
`git.continueSync` after a stop) therefore records `rewrote`, old sha to new, paired by
what a rebase preserves: author name, email, author date and a hash of the message
(`pairRewrites`; `Vn-Seq` restarts each session and position fails when a save is
dropped). A save the copy already had is dropped and recorded with `to: null`. Checkpoints
on a rewritten save are re-pointed through the same table, and `recordForCommit` in
`@vn/commands` resolves a sha through every table newest first. A pull that stopped
records nothing; `orig-head` and `onto` under `rebase-merge/` carry the range to the
command that finishes it.

Every sync outcome carries `got`, `replayed`, `conflicted`, `rewrote` and `finished`.
`finished: false` with nothing in `conflicted` is a stop git explains in its own words,
reported as part way rather than done.

## The conflict view

A rebase that stops replaces the detail column with the conflict view: "Replaying N of M:
<subject>" from `inProgress().rebase`, then one row per unmerged path with "Keep mine",
"Take theirs" and, for a file git merged line by line, "Edit" and "Ask the agent". "Mine"
is git's `theirs` during a rebase and the other way round (`REBASE_SIDE`); a side that
deleted the file deletes it. `git.resolve` checks the side out and stages it. "Continue"
(`git.continueSync`) stages everything — edits made while the view was up ride into the
replayed save, which the footer says — and runs `rebase --continue`; it is refused while a
path is still unmerged or a changed file git merges textually still holds `<<<<<<<`
markers, since nothing would parse it. "Give up" (`git.abandonSync`) is `rebase --abort`,
and also abandons a merge or a revert a terminal left. The strip's "Shared copies" toggle
is refused while a file is waiting, since the column is the conflict's.

### Deciding a file by editing it

"Edit" opens the whole file beneath the list, as git left it, markers and all, in a field
that fills the column and scrolls itself to the first marker; a scene or a note gets the
prose face, everything else the mono one. The text is `git.conflictText`, which reads the
worktree copy. "Save" is `git.writeResolution(repo, path, text)`: it writes the field over
the file and stages it, so the decision is git's and not just the disk's. "Cancel" closes
the editor and changes nothing. Only one file is open at a time, and nothing is autosaved
— the footer says so while the editor is up.

What Save will take is `resolutionProblem(path, text)` in `@vn/model`, which the agent's
tool shares: a scene must load with no error diagnostic, a sheet must pass its schema,
JSON and YAML must parse, and markers are refused outright in a data file and in a note's
front matter, since YAML reads a marker line as a scalar. Markers left in the _body_ of a
scene or a note are allowed at Save and refused at Continue, so a merge can be saved part
way.

The rows for files already decided follow the list, greyed, each with how it was decided —
"kept yours", "took theirs", "merged", "removed" — and "Undo decision"
(`git.undoResolution`), which is `checkout -m` over the index's memory of the three
stages. How it was decided is read off the stage blobs (`Git.resolvedPaths`,
`ls-files --resolve-undo`) rather than remembered from the button that was pressed, so a
decision made in a terminal reads the same. A decision that _removed_ the file cannot be
undone: git keeps the record but `checkout -m` refuses a path without all three versions,
and the row says so. Git drops the records itself at the next rebase stop.

While a scene is waiting on a decision, the Script pane draws it as the parser reads it
under one notice row — "This scene is waiting on a merge decision. Open History to decide
it." — with a `view.open` to this pane. Every write on it is refused first, by
`conflictedRefusal` in `@vn/scriptedit`, which both planners run, so `story.*`, the
agent's `edit_scene` and CDP all get one host-neutral sentence.

Every command that commits is guarded while a rebase is in progress: `Git.commit` throws
`InProgressError`, the committer skips the repository, the four sync commands that act
inside a rebase are `commitsItself`, and `pipeline.run`, `pipeline.approveAndRun`,
`pipeline.draw` and `gengraph.run` refuse with `SYNC_UNFINISHED`
([`command-system.md`](command-system.md#commit-on-save-is-the-journals-sibling)).
`commitScaffolding` swallows the refusal, so a project reopened with a stopped sync opens.

Which files can wait on a decision follows from the project's merge attributes
([`repos-and-commits.md`](repos-and-commits.md#the-gitattributes-a-project-gets)): a
layout, a graph and a thread log are `-merge`, so a collision there is whole-file; the two
state logs are `merge=union`, so they never wait; everything else git merges by line, and
a scene may hold markers.

## The app's logs during a rebase

The app appends to `vngen/state/commands.jsonl` and `notifications.jsonl` while a rebase
runs: a read command records itself, a notification is filed. Git will neither start a
rebase over unstaged edits nor replay a commit that touches a file with any. So:

- `Git.rebase` runs with `--autostash`, and the stash is applied when the rebase ends.
- `Git.rebase` and `Git.rebaseContinue` absorb a stop that is not a conflict. The edits
  are staged; when the stop is a refused replay rather than a conflict stop (`stopped-sha`
  absent), they are folded into the commit replayed last (`commit --amend --no-edit`), or
  into a commit of their own under `ABSORBED_SUBJECT` when none has been replayed yet;
  then the rebase continues, `ABSORB_TRIES` times at most. Nothing is absorbed while a
  path is unmerged, since those edits are the author's decision.
- `commands.jsonl` is `merge=union` like the notification log, or every two-author sync
  collided on it. Because a rebase checks out each replayed save's own `.gitattributes`,
  the rules are also written to the repository's `info/attributes` on every open
  (`ensureRepoAttributes`), which git reads first.

## From the agent

The agent's `git_log`, `git_show`, `git_diff` and `git_status` return the same structured
rows the pane draws, with `makerOf` applied; `git_revert`, `git_restore` and
`git_checkpoint` share `@vn/git`'s rules and sentences with `git.takeBack`,
`git.restoreFile` and `git.checkpoint`, without invoking the command registry. There is no
agent tool for a shared copy, a send or a get: publication and collaboration are the
author's acts, and a model must not send saves anywhere or decide where they go.
`git_commit` refuses while a rebase is in progress, by the same `Git.commit` guard, and
answers with the sentence that says who finishes the sync instead; `git_restore` refuses
for the same reason.

A file waiting on a decision is the agent's to merge, though not to decide alone. "Ask the
agent" on a row runs `agent.mergeConflict`, which opens the conversation with the request
already in the composer and sends nothing: `mergeOpener` names the file and the save being
replayed, asks for the merge, and says not to commit. The tool is
`resolve_conflict(path, text)` — the whole file, marker lines gone — which refuses until
the file has been read this conversation, refuses a path the sync is not waiting on, and
holds the text to `resolutionProblem`, the check Save shares. An ordinary `write_file` or
`edit_file` on a file in question is refused too (`conflictRefusal`), because a plain
write leaves git still waiting on the path and Continue would refuse it. Nothing the agent
can call continues or abandons a sync.

## Testing

- `packages/git/src/tests/`: `parse.test.ts` (parsers, no repository), `reads.test.ts`,
  `recovery.test.ts` and `sync.test.ts` against temporary repositories, including a
  stopped rebase, the rewrite pairing, and the two absorbed stops with a post-commit hook
  standing in for the app's log writes.
- `apps/desktop/src/main/commands/tests/affects.test.ts`: the executed affects tier runs
  the six local writes over an owned project with a committer, and the ten sync writes
  over a bare repository and two projects (`SYNC_CONNECT`, `SYNC_COLLIDE`), so none has a
  `SKIPS` entry.
- `apps/desktop/renderer/rules/tests/history.test.ts` covers the offers, sentences and
  control orders; `pnpm gen:uxmodel` records every control and refusal from the situations
  in `rules/situations/history.ts`.
- The anchor sweep (`scripts/sweep-anchors.mjs`) runs against `examples/mySampleRepo` in a
  mock app; its `SETTLE_MS` is 1200 because the character sheet's wardrobe rows wait on
  the manifest.

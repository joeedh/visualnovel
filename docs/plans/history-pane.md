# The History pane

<!-- toc -->

- [Scope](#scope)
- [Decided before the work starts](#decided-before-the-work-starts)
- [Decided as the work goes](#decided-as-the-work-goes)
- [Evidence projects](#evidence-projects)
- [How the UX is reviewed while it is built](#how-the-ux-is-reviewed-while-it-is-built)
- [What every stage that adds a command must do](#what-every-stage-that-adds-a-command-must-do)
- [Stages](#stages)
    - [Stage 1 — `@vn/git` reads](#stage-1--vngit-reads)
    - [Stage 2 — `@vn/git` writes, the framework, and the mid-rebase guards](#stage-2--vngit-writes-the-framework-and-the-mid-rebase-guards)
    - [Stage 3 — The read commands and the pure modules](#stage-3--the-read-commands-and-the-pure-modules)
    - [Stage 4 — The pane: list, strip, status, empty and loading states](#stage-4--the-pane-list-strip-status-empty-and-loading-states)
    - [Stage 5 — The change view and the diffs](#stage-5--the-change-view-and-the-diffs)
    - [Stage 6 — Local writes and the agent's tools](#stage-6--local-writes-and-the-agents-tools)
    - [Stage 7 — Sync](#stage-7--sync)
    - [Stage 8 — Docs and finishing](#stage-8--docs-and-finishing)
- [Risks specific to the build order](#risks-specific-to-the-build-order)
- [A wiki that is a submodule](#a-wiki-that-is-a-submodule)
- [What it costs to undo](#what-it-costs-to-undo)
- [Pressure test](#pressure-test)

<!-- tocstop -->

Implements the pane specified in
[`../research/git-editor-pane.md`](../research/git-editor-pane.md). The report is the
authority on what the pane shows, says and refuses; this plan is the authority on the
order the work lands in, what is decided before the first commit, and what is decided
later against something running. Where the two disagree, fix the report, since the plan
cites it rather than repeating it.

Status: planned. Branch `git-editor`. Pressure-tested 2026-09-20; the findings and what
became of each are in [Pressure test](#pressure-test).

## Scope

- In: the `@vn/git` additions, the `git.*` command set, the pane (list, status, change,
  checkpoint, sync and conflict views), the agent's tool wrappers, and the docs.
- Out, each with its own future plan: viewing the project read-only at a save (report,
  [Deferred](../research/git-editor-pane.md#deferred-viewing-the-project-at-a-save));
  history menus inside the Wiki and Script panes (report,
  [Future](../research/git-editor-pane.md#future-history-inside-the-wiki-and-script-panes)).
  This plan keeps them open by building `git.blob` and `git.history(path=…)` as general
  reads and by carrying a save's sha on every row in a form `view.open` can later take.
- Out for good: rewriting history a remote already holds, branches, detached HEAD, a git
  library (report, [Non-goals](../research/git-editor-pane.md#non-goals)).

## Decided before the work starts

These shape the data model, the command catalog, a file format or a refname, which is why
they are fixed now. Each is written into the report, or added to it by this plan where the
pressure test found a gap.

| Decision                                                                          | Where it binds                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pull is fetch + rebase of unsent saves; no merge commit is ever made              | `git.pull`, `git.continueSync`, `git.abandonSync`; the conflict view's "Replaying N of M"                                                                                            |
| A repository may have several remotes; one is the branch's upstream               | `git.addRemote`, `git.removeRemote`, `git.setRemoteUrl`, `git.syncWith`; `remote=` on fetch and push                                                                                 |
| "Go back" restores the whole tree, `vngen/build` and `vngen/state` included       | `git.goBack` is `applyTree` with no exclusions                                                                                                                                       |
| A `<git>` sentinel joins the `affects` vocabulary and is never snapshotted        | `apps/desktop/src/shared/affects.ts`; every history-only command declares it and is non-undoable                                                                                     |
| `git.pull`'s record carries `rewrote: {from, to}[]`, `to` null for a dropped save | `CommandRecord` in `packages/commands/src/command.ts`; `commands.jsonl` stays append-only                                                                                            |
| A checkpoint is an annotated tag at `refs/tags/vn/checkpoint/<slug>`              | The author's name is the tag message's first line; the slug is derived from it. `push` uses `--follow-tags`; `git.pull` re-points a checkpoint on a rewritten save through `rewrote` |
| No commit is made in a repository while a rebase, merge or revert is in progress  | `Committer` skips such a repo; `Git.commit` refuses; `git.resolve`, `git.continueSync`, `git.abandonSync` are `commitsItself`                                                        |
| Command ids and props are the report's tables                                     | The catalog is public to the palette, CDP and the agent, so a rename after landing is a breaking change                                                                              |
| Every string in the pane uses the author's vocabulary                             | The report's [vocabulary table](../research/git-editor-pane.md#the-vocabulary-the-pane-uses)                                                                                         |
| Every worktree-changing command refuses while `session.busy()`                    | The `project.installPages` pattern, `apps/desktop/src/main/commands/project.ts:462-463`                                                                                              |
| The pure rules both hosts need live in `@vn/git`                                  | `@vn/authoring` may not import the desktop app; `makerOf`, `statusCause`, the row and change types, and `revertDryRun` are package code                                              |

## Decided as the work goes

Each of these is cheaper to decide with the thing running than on paper, and none of them
changes a format, an id or a refname. The stage that decides it names the evidence it
needs, and the answer is written into this file under the stage when it is made. The
pressure test judged each deferral safe on that ground (finding 20), with the two caveats
noted in the table.

| Decision                                                                                                                                                                | Decided at          | Evidence that decides it                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The pane's title: History or Git                                                                                                                                        | Stage 4             | The tab drawn beside the others; the first UX review. The id `history` is fixed either way, since stored layouts name it                                                                                                               |
| How the agent's two saves per turn fold into one row, and whether to add trailers to the agent's commit or set `commitsItself` on `agent.run` (report, open question 3) | Stage 4, lands in 6 | Real histories from the example projects in the list; how often the trailerless shape appears; whether adjacency misfires. Must land before `makerOf` ships to authors, because it changes the message shape every later reader parses |
| Whether a sheet needs the field-table diff and JSON the key-path diff, or the word and line diffs carry them                                                            | Stage 5             | The change view over real sheet and storyboard edits; the second UX review                                                                                                                                                             |
| The wipe handle for a replaced picture, versus two thumbnails                                                                                                           | Stage 5             | A real slot with two takes; the second UX review                                                                                                                                                                                       |
| `vngit://` protocol handler versus a data URL from `git.blob` for a picture's old side                                                                                  | Stage 5             | Measured: how often the content store already holds the bytes (it should be always for content-addressed art)                                                                                                                          |
| Column widths, breakpoints and the small layout                                                                                                                         | Stage 4, 5          | The UX reviews, with the pane at 320, 560 and 900 px                                                                                                                                                                                   |
| Whether "Show history" is on every tree node or on files and sheets only (open question 9)                                                                              | Stage 4             | The tree's right-click table as it stands; what `git.history(path=…)` returns for a directory node                                                                                                                                     |
| Whether the file filter needs the document tree's entity vocabulary or a path list suffices                                                                             | Stage 4             | Using the filter on a project with forty scenes                                                                                                                                                                                        |
| `rerere` on in an author's repository (open question 11)                                                                                                                | Stage 7             | Whether the same `-merge` file conflicts twice in one rebase during the sync test                                                                                                                                                      |
| A repository-size warning and its threshold (open question 6)                                                                                                           | Stage 7             | A run project's `.git` size after a pipeline pass                                                                                                                                                                                      |
| Whether a base-art repository gets its own strip entry (open question 8)                                                                                                | Stage 4             | Whether any example project has one; if none does, the strip handles it as a third role and no one designs for it                                                                                                                      |

## Evidence projects

`examples/` is gitignored (`.gitignore:9`) and exists only in the main checkout, at
`C:\dev\visualnovel\examples`. Every stage that says "a real history" means
`C:\dev\visualnovel\examples\test4` (fourteen agent conversations) and
`C:\dev\visualnovel\examples\mySampleRepo` (a run project), read from the branch's
checkout and launched with `pnpm vndesktop C:\dev\visualnovel\examples\mySampleRepo`. The
app takes CDP port 9223 when the main checkout's instance holds 9222.

## How the UX is reviewed while it is built

The owner asked for the frontend design skill to review the pane as it takes shape rather
than once at the end. Three reviews, each a gate on its stage:

- **When.** At the end of Stage 4 (list, strip, status, empty and loading states), Stage 5
  (change view and every diff kind) and Stage 7 (sync and conflict views). The first two
  review a pane that reads and cannot write, since the write controls arrive in Stage 6;
  the third reviews the write controls too.
- **How.** Build (`pnpm build`), launch `pnpm vndesktop` against the run project, open the
  pane through `node scripts/vn-cdp.mjs "view.open(editor='history')"`, and take
  screenshots over CDP at 320, 560 and 900 px. Then invoke the `frontend-design` skill
  with the screenshots, the report's
  [Visual design](../research/git-editor-pane.md#visual-design) section and the token file
  (`apps/desktop/renderer/styles/tokens.css`), and ask it to review against that design:
  what reads as a generic git client, where the type or the colour leaves the token set,
  where a control lacks a tooltip or a refused state, and what an author who has never
  seen git would misread.
- **What happens to the findings.** Each is fixed in the stage, or recorded under the
  stage with the reason it is not. The review leaves a trace in this file either way, on
  the same rule the pressure test follows.
- **What the review does not decide.** Command ids, refusal sentences and the vocabulary
  table are the report's; a review that wants a word changed changes the report first.

## What every stage that adds a command must do

Collected here because the pressure test found each of them missing from at least one
stage. A stage that adds or anchors a command is not green until all of these are done.

- `apps/desktop/src/main/tests/commands.test.ts` pins three lists: the namespaces (`:36`;
  add `git` once), the mutating commands (`:83`) and the commands with a `check` (`:360`).
  Every new command joins the lists it belongs to in the same commit.
- `pnpm gen:command-table` regenerates `docs/reference/command-table.md` and
  `command-namespaces.md`; `pnpm lint` runs `check:commandtable` and fails otherwise.
- `apps/desktop/renderer/rules/paletteonly.ts` lists "the commands no drawn control runs".
  `apps/desktop/src/main/tests/uxmodel.test.ts` fails a live command that is neither
  anchored by a control nor listed (`:73-76`), fails a listed entry that matches nothing
  (`:83-88`), and fails an anchored id that is not in the registry (`:56`). So: a command
  with no control yet is listed; when a later stage draws a control for it, the entry is
  removed in that commit; a control is never drawn for a command that does not exist yet.
  `git.status` is already covered by the `*.status` glob (`:51`).
- A mutating command joins `RUNS` or `SKIPS` in
  `apps/desktop/src/main/commands/tests/affects.test.ts`, which must partition every
  mutator (`:674-686`).
- `pnpm gen:uxmodel` after any change under `renderer/rules/**`, and the anchor sweep
  (`docs/reference/guided-tours.md`) after any change under `renderer/pathux/editors/**`.

## Stages

Each stage is one or more commits, green under `pnpm check`, `pnpm test` and `pnpm lint`,
and lands on `master` by fast-forward. A stage with nothing visible (1, 2, 3) is still a
stage, because the next one is reviewable only if these are already in.

### Stage 1 — `@vn/git` reads

Additions to `packages/git/src/git.ts`, tests in `packages/git/src/tests/git.test.ts`
against temporary repositories the test creates. No consumer yet. Every `.git/<name>` path
is resolved through `git rev-parse --git-path <name>`, never as `<root>/.git/<name>`,
because `.git` is a file in a linked worktree.

- `history(opts)` is a **new** method beside `log(limit)`, which stays as it is: some
  fifty call sites in `workspace.test.ts`, `commit.test.ts` and `git.test.ts` use `log()`
  and its `hash`/`subject` fields. `history` takes `{limit, before, path, author}` and
  returns each commit with `sha`, `parents[]`, `author`, `email`, `date`, `subject`,
  `body`, `trailers: Record<string, string>` and `files: {path, added, removed}[]`. One
  spawn: `--format` with `%x1f` field and `%x1e` record separators and
  `%(trailers:only,unfold)`, plus `--numstat`; the numstat block follows each record after
  a blank line. The parser is a pure function with its own tests: `-` for a binary file's
  counts, and `old => new` (with the brace form `a/{b => c}/d`) for a rename.
- `changes(sha)`: one spawn, `diff-tree -r -M --root --raw --numstat <sha>` (`--root` or
  the first commit prints nothing but its sha), out as
  `{path, status, oldBlob, newBlob, added, removed}[]`.
- `diffPath(sha, path, against = parent)`: the unified text for one path, and a
  `binary: boolean`.
- `blob(sha, path)`: a `Buffer`, or `null` when the path is absent at that commit.
- `inProgress()`:
  `{rebase?: {branch, onto, current, total, stoppedSha}, merge: boolean, revert: boolean}`
  from `rebase-merge/` (`head-name`, `onto`, `msgnum`, `end`, `stopped-sha`), `MERGE_HEAD`
  and `REVERT_HEAD`. `branch` comes from `head-name`, because HEAD is detached during a
  rebase and `Git.branch()` answers `HEAD`; the strip and every sync check use this branch
  name while a rebase is in progress, and never the detached-HEAD refusal.
- `remotes()`: `{name, url}[]`; `upstream()`: `{remote, branch} | null`; `branchStatus()`:
  one spawn of `status --porcelain=v2 --branch`, giving the entries, the upstream and the
  ahead/behind counts together, with `ahead`/`behind` `null` (not `0`) when the
  remote-tracking ref does not exist yet, as for a freshly added remote.
- `tag(slug, sha, message)` on `refs/tags/vn/checkpoint/<slug>`, `checkpoints()` with
  `for-each-ref --format` over that prefix giving `%(*objectname)` and the message, and
  `deleteTag(slug)`. `slugOf(name)` is a pure function with tests: lowercased, spaces to
  hyphens, anything git refuses in a refname removed, and a numeric suffix on collision.
- `lastFetch()`: the mtime of `FETCH_HEAD`, or `null`. It is the last fetch of **any**
  remote, since every fetch rewrites the file; the sync view labels it that way.

**As built (2026-09-21).** Everything above, in `packages/git/src/git.ts` with the parsers
in a new `packages/git/src/parse.ts` (exported from the package) and tests in
`tests/parse.test.ts` (parsers, no repository) and `tests/reads.test.ts` (against temp
repositories, including a stopped rebase). Two things differ from the text: `upstream()`
reads `branch.<name>.remote`/`.merge` from config rather than `@{u}`, so it answers during
a rebase when given `inProgress().rebase.branch`; and the tag name and the refname are two
constants (`CHECKPOINT_TAG = 'vn/checkpoint/'` for `git tag`,
`CHECKPOINT_PREFIX = 'refs/tags/vn/checkpoint/'` for `for-each-ref`), because `git tag`
given a full refname creates `refs/tags/refs/tags/…`. `Git.log` is untouched.

### Stage 2 — `@vn/git` writes, the framework, and the mid-rebase guards

- `packages/git/src/git.ts`: `fetch(remote)`, `push(remote, branch)` with `--follow-tags`,
  `rebase(onto)`, `rebaseContinue()`, `rebaseAbort()`, `mergeAbort()`,
  `resolveSide(path, side)` — `checkout --ours|--theirs -- <path>` then `add`, or `rm` for
  the side that deleted the file (`DU`, `UD`, `AU`, `UA`) — `remoteAdd`, `remoteRemove`,
  `remoteSetUrl`, `setUpstream(remote, branch)`. `revertDryRun(sha)` is
  `revert --no-commit`, read the conflicted paths, then `revert --abort`, falling back to
  `reset --hard HEAD` if the abort refuses on a git that leaves no `REVERT_HEAD` for a
  clean dry run; the fallback is safe only because every caller has already required a
  clean worktree, and the method says so. `run` gains `GIT_TERMINAL_PROMPT=0` and
  `GIT_SSH_COMMAND=ssh -oBatchMode=yes` in its environment for every call, so a credential
  or passphrase prompt fails instead of hanging a hidden subprocess; Windows Git
  Credential Manager's own window is unaffected.
- `Git.commit` refuses (returns a failure, throws nothing new) while `inProgress()`
  reports anything. This covers the agent's `git_commit` in both hosts without a new
  `check` on `agent.run`, which stays the one mutator without one
  (`commands.test.ts:344-347`).
- `Committer.run` (`packages/commands/src/commit.ts:149-157`) skips a repository whose
  `inProgress()` reports anything and returns it in a `skipped` list the caller logs. This
  is the guard against the pressure test's first finding: `add -A` during a stopped rebase
  marks every conflicted path resolved, markers included, and the commit succeeds and is
  adopted as the replayed save. The guard sits in `Committer` rather than in
  `workspacelifecycle.ts` because it then covers the sweep, `commitScaffolding` and every
  commit-on-save in one place, and because `commit.test.ts` can test it while nothing
  tests `workspacelifecycle.ts` (it imports `electron`). The open-time sweep therefore
  needs no change of its own.
- `apps/desktop/src/shared/affects.ts`: `GIT_ROOT = '<git>'` beside `USER_ROOT`, in
  `AFFECTS_ROOTS`, and `snapshotted` answers false for it. The affects test that validates
  the vocabulary learns the new root.
- `packages/commands/src/command.ts`:
  `rewrote?: readonly {from: string; to: string | null}[]` on `CommandOutput` and
  `CommandRecord`, `to: null` meaning the rebase dropped the commit; `stack.ts` copies it
  through beside `written`. A test in `packages/commands/src/tests/` writes a record with
  it and reads it back.
- `CommandStack.pendingCount()` (the deferred-batch count, today private at
  `stack.ts:123`) and a `CommandHost` member for it, plus a host member listing the owned
  repositories (`ownedRepos` lives on `AppContext`, `runtime/context.ts:52`, which a
  command cannot see; `host.ts:44-127` is what it sees).
- `apps/desktop/src/main/commands/pipeline.ts` (`pipeline.run`, `pipeline.approveAndRun`,
  `pipeline.draw`) and `commands/gengraph.ts` (`gengraph.run`, `:1147`) refuse in `check`
  while a rebase, merge or revert is in progress, with one sentence: "Getting their saves
  is unfinished; finish or give it up first."
- `apps/desktop/src/main/index.ts:33-37`: `vngit` joins `registerSchemesAsPrivileged`
  before `app.ready`, so Stage 3's handler can be registered.

**As built (2026-09-21).** Everything above, with these particulars:

- `Git.commit`'s refusal is a thrown `InProgressError` (a `GitError` subclass carrying the
  operation), which `Committer.run` catches and reports through a new
  `CommitterOptions.onSkip(repo, operation)`; the desktop's committer logs it. One
  `inProgress()` spawn per commit, in `Git.commit` only.
- `Git.resolveSide(path, side)` is the method name (`checkoutSide` in the text); it takes
  git's `ours`/`theirs` and the command layer maps the author's words. `Git.rebase` and
  `rebaseContinue` answer a boolean: false is "stopped on a conflict", anything else
  throws. `rebaseContinue` runs with `core.editor=true` so the replayed commit keeps its
  message without opening an editor. `revertDryRun` reports `reason` when the failure was
  not a conflict (a merge commit, say).
- The host members are `ownedRepos()` and `pendingCommits()`; the affects fixture answers
  `[]` and `0`.
- The doctor gained `GIT_MIN_VERSION = '2.13'`, `olderThan`, `GitHealth.old` and
  `GIT_OLD_MESSAGE`, filed through the same notice as a missing git.
- The one refusal sentence lives in `commands/syncstate.ts` (`SYNC_UNFINISHED`,
  `syncRefusal(git)`), so the four checks and Stage 6's commands share it.
- The rebase fixtures clone with `-c core.autocrlf=false`; set after the clone, a global
  `autocrlf=true` has already left every file modified in the clone's worktree, and the
  "conflict" the test then sees is a line-ending one.

### Stage 3 — The read commands and the pure modules

- `packages/git/src/history.ts` (new, in `@vn/git` so both hosts read it): the `Save` row
  type, the `Maker` union, the `Change` type and the structured `Diff` variants the
  report's kind table names, and two pure functions with tests:
  `makerOf(commit, localName)` (the report's
  [maker table](../research/git-editor-pane.md#the-history-list)) and
  `statusCause(porcelain, pendingBatch, inProgress)` (the report's
  [status table](../research/git-editor-pane.md#the-status-view)).
  `apps/desktop/src/shared/history.ts` re-exports the types and adds `kindOf(path)` for
  the grouping, since only the desktop groups.
- `apps/desktop/src/main/commands/git.ts`: `git.repos`, `git.history`, `git.changes`,
  `git.diff`, `git.blob`, `git.status`, each a thin wrapper over a method of a new
  `apps/desktop/src/main/session/history.ts` rather than more lines in `core.ts`. `repo`
  is `prop.oneOf(['project', 'wiki', 'base'])` resolved against the host's owned-repo
  list. `git.history`'s `who` filter is a post-filter on trailers (`git log` filters
  natively on author only), so the session over-fetches in pages of 50 until 50 rows match
  or the history ends, with a cap of 1000 commits scanned per call; the response carries
  the sha the next page starts from. Per-sha results (`changes`, `diff`, `blob`) are
  memoized for the session; the list is keyed on HEAD and is not. The memo is dropped on
  `git.pull`, `git.continueSync` and `git.abandonSync`, because a rebase changes which
  shas exist.
- `git.blob` returns text under a size cap and, for a binary, a `vngit://` URL served by a
  handler beside `apps/desktop/src/main/assets/assetprotocol.ts`. Whether it stays or a
  data URL replaces it is Stage 5's call.
- `git.diff` produces the structured shape per kind. The line diff comes from `@vn/util`'s
  `lineDiff`; a `wordDiff` is added beside it in `packages/util/src/diff.ts`, the same LCS
  over tokens, **run per paragraph** with a fallback to a line diff for a paragraph over a
  token cap, because `lcsTable` allocates (n+1)×(m+1) words and a whole 5,000-word page
  would be ~100 MB. Scene diffs are parsed into elements through `@vn/parse` on both sides
  and diffed per element.
- The six reads join `paletteonly.ts` (all but `git.status`), the namespace list gains
  `git`, and `pnpm gen:command-table` runs.

**As built (2026-09-21).** Everything above, with these particulars:

- `makerOf(commit, ctx)` takes `{ local: { name, email }, housekeeping }` rather than a
  name: the identity is compared by email first, by name when no email is configured, and
  with neither configured nothing is "someone else". The housekeeping subjects come from
  `SCAFFOLDING_SUBJECTS`, now exported by `workspace/workspace.ts`, so a new scaffolding
  commit is listed once. A batch's `Vn-Source` and `Vn-Command` are read as
  comma-separated lists.
- `statusCause(entries, pending, inProgress, own)` takes a fourth argument, prefixes of
  the app's own logs (`vngen/state/`). A read appends to `commands.jsonl` without a
  commit, so on the sample project every status read otherwise said "changed outside the
  app" about the command log.
- **Scene diffs are not parsed through `@vn/parse`.** Fountain elements are separated by
  blank lines, so the paragraph word diff already compares element by element; the
  renderer classifies each paragraph (speaker, dialogue, action, marker) when it draws.
  Sheet front matter diffs as one paragraph for now; the field table is Stage 5's call, as
  planned. The `Diff` union has five kinds: `lines`, `prose`, `log`, `picture`, `binary`.
- `wordDiff` tokens are a word plus its trailing whitespace, so a replaced word does not
  leave its space behind as a match between two changes. The paragraph cap
  (`WORD_DIFF_CAP`, 2000 tokens) shows the paragraph whole on both sides rather than
  falling to a line diff. Over `LINE_DIFF_CAP` (3000 lines a side) a line diff is git's
  own hunks, with each `@@` header kept as a context line.
- `git.history` answers `{ saves, next }`; `next` is the last commit scanned, matched or
  not, so a `who` page never rescans. `Save` carries `sent: boolean | null` from a new
  `Git.unsent()` (`rev-list @{upstream}..HEAD`) and the checkpoint slugs by sha.
  `HistoryOptions.grep` maps to `--fixed-strings --regexp-ignore-case --grep`.
- `git.blob` answers `{ kind: 'text', text }` or `{ kind: 'bytes', url, bytes }`; text is
  valid UTF-8 with no NUL under 2 MB. `vngit://<role>/<blobId>.<ext>` names a blob by the
  id `git.changes` reports (`Git.catBlob`), and `vngit://<role>/<sha>/<path>` a path at a
  commit; `parseGitUrl` and `blobUrl` live in `shared/history.ts`. The handler is
  `assets/gitprotocol.ts`, registered beside the asset one, and answers with an immutable
  cache header.
- `kindOf` and `KIND_ORDER` are in `apps/desktop/src/shared/history.ts`; `.png` under
  `characters/` is a picture, `screenplay.fountain` a scene, `.vnstudio/**` project.
- `Committer` no longer imports `@vn/git` at runtime: Stage 2's
  `instanceof InProgressError` had put `node:child_process` into the renderer bundle
  through the `@vn/commands` barrel, and `pnpm build` failed. The check is by shape
  (`operation` is a string). `pnpm build` is now part of what a stage runs before it
  lands.
- The anchor sweep was re-run against `examples/mySampleRepo`, and the six reads were
  exercised over CDP there before the sweep.

### Stage 4 — The pane: list, strip, status, empty and loading states

- `apps/desktop/src/shared/editors.ts`: a `history` entry with `title` per the Stage 4
  decision, `what: "every save of the project, who made it and what it changed"`,
  `pins: 'docPath'`, and `claims` returning `secondary` for `file`, `scene`, `wiki`,
  `character` and `location` nodes. The editor count moves from eighteen to nineteen in
  `CLAUDE.md:190`, `docs/reference/desktop-app-shell.md` (`:27`, `:210`, `:217`, `:231`,
  which today say seventeen in one place and eighteen in the others) and
  `docs/reference/module-map.md:305`.
- `apps/desktop/renderer/pathux/editors/history.ts`: extends `VnEditor`, registered as
  `vn.History`; bar built once in `init()`, list and detail as `appendSurface` roots,
  `adoptStyle` over `apps/desktop/renderer/styles/history.css`. The Project pane
  (`editors/project.ts`) is the model for the bar and `load()`; the Wiki pane's footer
  strip (`styles/wiki.css:82-142`) is the model for the footer.
- `apps/desktop/renderer/rules/history.ts` and `rules/situations/history.ts`: every
  control as an `Offer`, filters included, so `pnpm gen:uxmodel` records them and a
  refused control greys with its reason. The reads a control runs (`git.history` through
  the filters, `git.repos`) leave `paletteonly.ts` in this commit.
- **No write control is drawn in this stage or the next.** The status view shows its cause
  sentence with no control; the detail header has no recovery controls. They arrive with
  their commands in Stage 6, because a control naming an unregistered command fails
  `uxmodel.test.ts:56`.
- The list pages by `before=<sha>` at 50, grouped by day; rows carry the maker rail, the
  file count, the checkpoint marker and the unsent glyph. The strip shows the repo role,
  the branch (from `inProgress().rebase.branch` during a rebase), and the upstream counts,
  or "not yet compared" when they are `null`.
- The document tree's right-click table (`renderer/pathux/doctree/doctree.ts`) gains "Show
  history" → `view.open(editor='history' subject=<path>)`, on the node kinds the Stage 4
  decision names.
- Empty states and loading states as the report's tables have them. The list never blanks;
  a slow read dims and the footer says "Reading history…".
- Pane state (chosen repo, filter, scroll) goes through `saveUIData`/`loadUIData`.
- **UX review 1.** Decisions taken here: the title; how the agent's two saves fold (draw
  both shapes and look at the fourteen-conversation project's history); the entity filter;
  "Show history" placement; the base-art role.

**As built (2026-09-21).** Everything above, with these particulars:

- The editor is `HistoryEditor` in `editors/history.ts`, registered as `vn.HistoryEditor`
  (the struct name follows the class, as the other panes do), area name `history`. It pins
  `docPath`, and `SUBJECT_OF` in `rules/route.ts` maps it there so
  `view.open(editor='history' subject=<path>)` works. The pane adopts `ui.docPath` on its
  first sighting and on every change, because `view.open` publishes the subject before the
  pane's first frame; clearing the chip does not publish, so the tree's selection is
  untouched. `claims` returns `secondary` for `scene`, `wiki`, `character` and `location`
  nodes with a path, and for a `file` node only when `isTextPath` — a `.png` in file mode
  had routed to History, which `route.test` caught. Under the existing visibility-first
  rule, a wiki clicked with History visible and Wiki hidden focuses History; that is the
  rule working, not a special case.
- **The five decisions.** The title is **History**. **The agent fold** — evidence from
  test4: every writing agent turn is two commits, a trailerless one whose subject is the
  agent's own summary (`00739d3 c10_the_world_breaks: split monologues…`) a few seconds
  before `Agent turn: <ask>` with `Vn-Command: agent.run` / `Vn-Source: ui`; today the
  first shows as "Made outside the app". `Close conversation: …` is trailerless too.
  Adjacency (the `agent.run` commit's first parent, same identity, within seconds) folds
  every one of them cleanly and misfires on none, but the durable fix is trailers on the
  agent's own commit, and that lands in Stage 6 with `git_commit`'s trailers. **No entity
  dropdown**: the document tree is the picker (test4 has 52 scenes, and a dropdown would
  duplicate the tree's search); the file filter is a chip set from the tree, and the one
  thing to do with it in the pane is take it off. **"Show history"** is on any tree node
  that names one file — `scene`, `character`, `location`, `wiki` and `file` — and on
  nothing else (folders, `wikidir`, skills, assets); `git.history(path=<dir>)` would
  answer, but the row would open a pane narrowed to a folder that no other surface can
  name. **Base art** is a third strip role handled generically; no example project has
  one, so nothing was designed for it.
- **Reading.** `load()` reads `git.repos`, resolves the chip's path to a repo through the
  owned roots (`resolvePath`, longest root wins, slashes normalised because each
  `rev-parse` prints its own), then `git.status` and `git.history` together. A read
  carries a token so a stale answer is dropped. A read slower than `SLOW_MS` dims the body
  and the footer says "Reading history…"; a failure goes to the footer in `--vermilion`.
  `onInvalidate` reloads after every mutating command; while `git.status` says `pending`
  the pane polls it every `PENDING_POLL_MS` for the deferred batch's commit.
- **Filters.** Who and the checkpoint tick filter what was read; text and path re-read.
  The repo, `who` and `checkpointsOnly` persist through `saveData` (spread over
  `super.saveData()`, since `Area`'s carries `_area_id`); the search text and the path do
  not, because the path follows the tree and a stale search would hide saves silently.
  Times are on the 24-hour clock (`hourCycle: 'h23'`).
- **UX review 1** ran over screenshots at 320, 560 and 940 px against the report's Visual
  design section and `tokens.css`. Fixed in this stage: the sha was invisible (now the
  time's tooltip, so the footer stays free for Stage 5's path·sha); the `+a −r` counts
  were coloured like a diff (now `--mist-dim`, since a count is not a change); the time
  column borrowed `--mono` (now `--sans` with tabular figures — `--mono` is for paths and
  hashes only); day and kind headings were uppercase (now sentence case, 11 px `--mist`);
  the strip overflowed at 320 px (a narrow form drops the shared copy's name); the empty
  path chip drew a border with nothing in it (now borderless, greyed, with a tooltip
  saying how to narrow); the maker rail sat under the window's left edge (now an inset
  `::before`). Kept against the review, per the brief: the `·`-joined strip (the report's
  own wording), the uppercase `AGENT` badge (the report's vocabulary table), and the
  per-row `⇡` (moved inline into the count column; whether it belongs on every unsent row
  is Stage 7's call once the strip can send). Pre-existing and left alone: the pane
  header's label ("HISTORY", like "BRANCHES") clips at the window's left edge — app
  chrome, outside this plan.
- **Submodule items done here** (from the section below): path→repo resolution for "Show
  history" on a wiki node; the detached-HEAD strip sentence says what to do ("check one
  out in `<root>` to save there"); `kindOf` answers `project` for the bare `wiki` path and
  for `.gitmodules`. Not done, because `RepoRef.missing` does not exist on this branch
  yet: the strip's "never checked out" entry, and skipping submodule entries in the
  project's porcelain status.
- `vngen/state/**/*.jsonl` are all logs (the transcripts under `threads/` too, since an
  agent turn appends to them), so a turn's file count does not include its own transcript.
- Observed, not fixed: opening test4 with `--mock` rewrites `assets/manifest.json` and
  `vngen/build/manifest.json` (`accepted: true → false`) without a commit, so the status
  view reports "2 files changed outside the app" on every mock launch. That is the mock
  path writing where a real run would not, outside this plan.
- The editor count is nineteen in `CLAUDE.md`, `desktop-app-shell.md` (whose parenthetical
  list had also dropped `page`) and `module-map.md`. The anchor sweep and
  `pnpm gen:uxmodel` were re-run.

### Stage 5 — The change view and the diffs

- The detail column: header (subject, maker, time, "Ran: …" from the record found by sha),
  files grouped by kind in the report's order, logs folded, and the diff beneath or in
  place of the file list per width.
- Renderers, one per kind in `renderer/pathux/editors/history/diffs/`: line (mono), word
  in paragraphs (prose face), scene as script (the Script pane's element styles, struck
  and underlined words, no gutter), picture (thumbnail; old and new for a replaced slot),
  logs (a count, and for the manifest the slots whose accepted take changed). The sheet
  field table and the JSON key-path diff are built only if the review says the word and
  line diffs do not carry them.
- "Open the conversation" on an agent save → `view.open(editor='convo' subject=<thread>)`
  when `Vn-Thread` or the record gives the thread.
- **UX review 2.** Decisions taken here: field-table and key-path diffs; the wipe handle;
  `vngit://` versus a data URL; the middle and small layouts for the detail column.

**As built (2026-09-21).** Everything above, with these particulars:

- The renderers are in `renderer/pathux/editors/history/diffs/`: `scene.ts` (script form),
  `prose.ts` (paragraphs), `lines.ts` (mono), `picture.ts`, `log.ts` (logs and the binary
  sentence), with `spans.ts` holding what they share — the struck and underlined runs, the
  context rule, and a paragraph's spans split into lines. `index.ts` picks by the diff's
  kind, and by the file's kind for a `prose` diff, since `git.diff` shapes a scene and a
  note the same way. The context rule is two unchanged paragraphs (or lines) either side
  of a change, with a run shorter than four shown rather than folded, because "1 unchanged
  line" hides less than it says. Whole added or removed paragraphs take the colour and a 2
  px rail, not a decoration on every word; the strike and the underline are for the words
  that changed inside a paragraph. That was UX review 2's first finding: a note added in
  one save had underlined 480 lines.
- **The scene file is `scenes/<id>.md`**, not `.fountain` — the report's detection table
  predates the import. `kindOf` reads `scenes/*.md` and `scenes/*.fountain` as scenes, and
  the one-file screenplay under `screenplay/` as well. The script renderer classifies each
  line of a paragraph from its text with the marks dropped: front matter (a paragraph
  opening with `---`) as data in the mono face, `[[line: L7]]` as the gutter id of the
  line under it, any other `[[…]]` as a marker, an uppercase first line with dialogue
  under it as a cue, `(…)` under a cue as a parenthetical, `INT.`/`EXT.` as a heading,
  `… TO:` as a transition, and the rest as dialogue or action. The classes mirror
  `script.css`.
- **"Ran …" comes from the trailers, not from `commands.jsonl`.** `Vn-Invocation` is on
  every single-act commit; a batch has `Vn-Batch` and the command list, shown as "30 acts:
  story.editLine, story.setSpeaker". No read of the log was needed.
- **"Open the conversation" finds the thread in the save's files.** No trailer names it,
  and `agent.run`'s record carries no thread id, but every agent turn appends to
  `vngen/state/threads/<id>.jsonl`, so that path is the thread. The control is
  `agent.openThread(id)` then `view.open(editor='convo' where='elsewhere')`, and it is
  drawn greyed with its reason on every other save, like the pane's other refused
  controls. It cannot fire in the anchor sweep, which opens the pane with nothing
  selected; the sweep reports it as derived but not drawn.
- **`--full-diff` on a path-filtered history.** `git log --numstat -- <path>` lists only
  that path under each commit, so a row's count and its file list were wrong whenever the
  chip was on. The path now picks the commits and each still lists every file.
- **The manifest's log diff lists the slots that hold a different picture**, from
  `heldTakes` in `session/history.ts`: the `current` row per slot, or the accepted row in
  a manifest written before takes were held. `Diff`'s `log` variant carries `slots?` for
  it. A manifest that does not parse holds nothing.
- **Layouts.** At full width the diff sits beneath the file list and there is no diff bar
  — UX review 2's second finding was the path written three times (the lit row, a bar, the
  footer). In the two narrower layouts the diff takes the file list's place under a bar
  with "← Files" and the path. The footer names `path · sha` while a diff is open.
- **Decided at the review.** No field table and no key-path diff: a sheet's front matter
  is one mono data paragraph, so a changed field is a changed word on a `key: value` line,
  and the JSON line diff shows `"nextShot": 3,` → `6,` on its own. `vngit://` serves both
  sides of a picture; `vnasset://` would only ever be a cache of the same bytes. The wipe
  is built for a modified picture path (`M`), with the new take clipped over the old at a
  handle that follows the pointer; no example project has a modified picture, so it is
  unverified live. A save that touched only logs says so with "Show logs" as the one
  control. The invocation wraps with `overflow-wrap: anywhere` (it had broken mid-word).
- The plan's report was wrong in one more place: `Vn-Thread` does not exist. The trailer
  Stage 6 adds to the agent's own commit should carry the thread id, so the files rule
  above becomes a fallback for history written before then.

### Stage 6 — Local writes and the agent's tools

- `git.save`, `git.checkpoint`, `git.dropCheckpoint`, `git.takeBack`, `git.goBack`,
  `git.restoreFile` in `apps/desktop/src/main/commands/git.ts`, with `check`, `affects`,
  `confirm` and refusal sentences as the report's
  [writes table](../research/git-editor-pane.md#writes) has them, and these
  clarifications:
    - `git.save` is `mutating: true`, checks that the tree is dirty, and returns
      `{message, subject}` with the author's text as `subject`. It calls nothing on the
      committer; ordinary commit-on-save commits the dirty tree under
      `Vn-Command: git.save` and the author's subject. (`CommandOutput.subject` is the
      open commit-subjects plan's addition and is already on `agent.run`, `agent.ts:42`.)
    - `git.takeBack` runs `revertDryRun`, then `revert --no-commit` followed by `reset` of
      the index, which removes `REVERT_HEAD`, so the committer sees a plain dirty tree and
      not a revert in progress.
    - `git.goBack` is `applyTree(treeOf(HEAD), treeOf(sha))` with no exclusions.
    - `git.restoreFile` writes through the ordinary document path after parsing a scene
      through `@vn/parse`.
    - `git.checkpoint` takes the author's name, slugs it, refuses on a slug collision by
      name, and stores the name as the tag message's first line and the note as its body.
- The status view's control and the detail header's three recovery controls are drawn now,
  and the six commands leave `paletteonly.ts` if a control runs them (`git.save`,
  `git.checkpoint`, `git.dropCheckpoint`, `git.takeBack`, `git.goBack`; `git.restoreFile`
  is run from a file row, so it too).
- The affects executed tier (`apps/desktop/src/main/commands/tests/affects.test.ts`) gains
  a second `describe` whose project is `makeProject({ git: true })` with a second commit
  made in the test and a stack built with a committer, since the existing harness has
  neither (`affects.test.ts:591`, `__fixtures__/affects.ts:74-77`). The six join `RUNS`
  there.
- After `git.takeBack` or `git.goBack` the footer and the header's undo label say undo
  history from before no longer applies.
- `packages/authoring/src/tools/git.ts`: `git_log` returns `Git.history`'s structured rows
  with `makerOf` applied (both from `@vn/git`, which `@vn/authoring` already imports);
  `git_show`, `git_diff` and `git_status` return the structured shapes. `git_revert` runs
  `revertDryRun` first and refuses with the same sentence the command uses; `git_restore`
  parses a scene through `@vn/parse` before writing; both keep `confirm: true`.
  `git_checkpoint` is new. The desktop commands and these tools share `@vn/git`'s methods,
  not a session; there is no desktop code the tools can reach.
- **Decision from Stage 4, executed here:** trailers on `git_commit` (`Vn-Source: agent`,
  `Vn-Thread`, `Vn-Plan`) or `commitsItself: true` on `agent.run`. Whichever it is,
  `makerOf` and the fold handle both the new shape and the trailerless history that
  already exists.

### Stage 7 — Sync

- `git.addRemote`, `git.removeRemote`, `git.setRemoteUrl`, `git.syncWith`, `git.fetch`,
  `git.pull`, `git.push`, `git.resolve`, `git.continueSync`, `git.abandonSync`, per the
  report, with `git.resolve`, `git.continueSync` and `git.abandonSync` marked
  `commitsItself: true` (a rebase in progress is a state in which the committer must not
  run, and the `Committer` guard from Stage 2 enforces it regardless).
- `git.pull` is `commitsItself: true`. Before the rebase it records
  `rev-list <upstream>..HEAD` with each commit's pairing key; after, it lists the same
  range again and pairs old to new by a key a rebase preserves — author name, email,
  author date and a hash of the full message — never by `Vn-Seq`, which restarts at 1 per
  session (`stack.ts:121`) and is not unique across unsent saves, and never by position,
  which fails when the rebase drops a commit (`--empty=drop` is the merge backend's
  default and an already-upstream cherry-pick is dropped too). An unpaired old sha is
  recorded with `to: null`. `ORIG_HEAD` is not used; the rebase writes it itself.
  Checkpoint tags on a rewritten save are re-pointed through the same table.
- The provenance lookup (commit → record) is by sha, then by sha mapped back through every
  `rewrote` table newest first.
- Edits an author makes while the conflict view is up are not committed (the `Committer`
  skips the repo) and ride into the replayed save when `git.continueSync` runs `add -A`
  and `rebase --continue`. The conflict view's footer says so: "Edits you make now become
  part of the save being replayed."
- The sync view and the conflict view as the report has them, including the "Replaying N
  of M" heading from `inProgress().rebase`, "Keep mine"/"Take theirs" mapped to git's
  inverted `--ours`/`--theirs` during a rebase, `rm` for a deleted side, and "Open both"
  through two read-only Wiki panes.
- Notifications: the report's
  [table](../research/git-editor-pane.md#what-the-notification-box-says).
- A test drives a rebase conflict end to end: two `makeProject({ git: true })` projects
  and a bare repository at a filesystem path as their shared remote (a plain path needs no
  `protocol.file.allow`), local `user.name`/`user.email` in each so global config is never
  touched. Project A pushes; project B edits the same `-merge` layout file, pulls,
  resolves, continues, pushes. All ten mutators run in the affects tier against this
  fixture, so none needs a `SKIPS` entry.
- A "Working with a collaborator" guide at `docs/guides/collaborating.md`: what a shared
  copy is, credential helpers on the three platforms, and what a push refusal means.
  `docs/guides/api-keys.md` has no GitHub section, so the refusal's link points here.
- **UX review 3.** Decisions taken here: `rerere`; the size warning.

### Stage 8 — Docs and finishing

- `docs/reference/desktop-app-editors-misc.md` gets the pane's as-shipped section, or a
  new `docs/reference/history-pane.md` if it runs long; `desktop-app.md` links it.
- `docs/reference/command-system.md`: the `<git>` sentinel under `affects`, `rewrote` on
  the record, and `Git.commit`'s refusal. `docs/reference/repos-and-commits.md`: the
  `Committer` guard, the sync semantics and the one rewrite the app performs.
  `docs/reference/vnauthor.md`: the tool changes. `docs/index.md` and
  `docs/plans/index.md` rows. `CLAUDE.md`'s command table if a script was added.
- The report's "Plumbing" table gets an as-shipped column, since it is the requirements
  list this plan built against, and its stale `project.ts:353-354` citation becomes
  `:462-463`.
- Finishing checklist per
  [`../reference/conventions.md`](../reference/conventions.md#finishing-a-plan): comment
  audit over every touched file, no `CLAUDENOTE:` left, `pnpm lint:comments` clean,
  `pnpm gen:uxmodel`, `pnpm gen:command-table` and the anchor sweep re-run, `todos.md`
  untouched (its item was the report and is already checked).

## Risks specific to the build order

- Stages 4 and 5 ship a pane that reads and cannot write. That is a complete thing, and it
  is the shape the first two UX reviews see.
- The rebase fixture in Stage 7 needs a bare repository on disk; jest's per-worker
  `VNAUTHOR_HOME` isolates user state but not `git config --global`, so the fixture sets
  `user.name`/`user.email` locally.
- `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND` also apply to `vnauthor`'s CLI host, where
  a terminal exists. A commit never prompts, so nothing changes today; a future network
  verb in the CLI host would need to opt out.
- No minimum git version is enforced (`bootstrap/doctor.ts` probes presence only).
  `status --porcelain=v2 --branch` needs 2.11, `%(trailers:only,unfold)` 2.13, and
  `--follow-tags` 1.8.3; the doctor gains a version probe in Stage 2 that warns below 2.13
  and the guide names it.

## A wiki that is a submodule

Added 2026-09-21 from `docs/plans/wiki-submodule.md`, a separate plan on `master` (not on
this branch yet, so named rather than linked) that makes `wiki/` work as a git submodule
of the project. The repo map already treats a submodule as an owned `wiki` repo, so the
pane's second strip entry is a submodule in practice. That plan fixes commit ordering
(nested repos commit first, so the parent's gitlink is current), puts a detached submodule
on a branch at open, reports a submodule that was never checked out (`RepoRef.missing`),
and makes `vnauthor`'s `git_commit` span repos. Its Stage 1 (commit order, `byDepth`
exported from `@vn/git`) is independent; its Stages 2 and 3 wait for this plan's Stages
1–3 to be on `master`, because they read `inProgress()` and add a parser to `parse.ts`.
What is left touches this plan, stage by stage; none of it changes a command id or a
refname.

- **Stage 3/4 — the parser and the strip.** `diff-tree --raw` prints a submodule bump with
  mode `160000` and a _commit_ sha in the blob columns. `parseChanges` discards the modes,
  `git.blob`/`catBlob` on that sha fails, and `diffPath` for it is the two-line
  `-Subproject commit a…`/`+Subproject commit b…`. Keep the modes, give `Change` a way to
  say "gitlink", and give `kindOf` answers for a bare `wiki` path and for `.gitmodules`
  (both project kind). The strip reads `RepoRef.missing` to show a wiki entry that has no
  history, with the reason.
- **Stage 3/4 — the project's status.** `status --porcelain=v2` prints a submodule as an
  ordinary entry with `S<C><M><U>` in the sub field, which `parseStatusV2` drops. A moved
  or dirty wiki then makes `statusCause` on the project say "changed outside the app"
  about `wiki`. Keep the sub field; skip submodule entries in the project's status, or
  attribute them to the wiki role.
- **Stage 4 — "Show history" on a wiki node must ask the wiki repo.**
  `git.history(path=…)` against the project returns nothing for a path under a submodule.
  Resolve the node's path to a role through the owned-repo roots (the longest root that
  prefixes the path) before choosing `repo=`. `git.diff` and Stage 6's `git.restoreFile`
  on a path take the same resolution.
- **Stage 4 — the detached-HEAD refusal.** A submodule checks out detached, and until the
  other plan lands that is what the pane sees for the wiki. The refusal's sentence should
  say what to do ("check out a branch in `wiki/`") rather than only what is wrong.
- **Stage 5 — a sixth diff.** The change view needs a shape for a gitlink bump: "the story
  bible moved from save X to save Y", opening the wiki repo's history at Y.
- **Stage 6 — `git.goBack` on the project does not move the wiki.** `read-tree -u --reset`
  changes the gitlink in the index and leaves the submodule's worktree alone, and the next
  act's `add -A` re-stages the wiki's real HEAD. The confirm text for a project with a
  wiki repo should say so: "The story bible keeps its own history; go back there
  separately."
- **Stage 6 — `git_commit` is path-scoped, and the other plan partitions its paths by
  repo.** `loop.ts:1039-1043` unions `editedPaths` into the tool's `paths`, so a
  workspace-relative `git add wiki/x.md` in the project stages the gitlink (no gitlink
  yet) or fatals (gitlink present). The other plan's Stage 3 splits the paths with
  `RepoResolver.group`, commits nested repos first and adds each nested path to the
  parent's pathspec; `result.data` becomes `{ root, sha, paths }[]`. The trailers this
  stage adds to `git_commit` (`Vn-Source: agent`, `Vn-Thread`, `Vn-Plan`) go on every
  repo's commit, and `git_log`'s `repo` argument should default to the project.
- **Stage 6 — a checkpoint pins a wiki sha through the gitlink but does not tag the
  wiki.** Either tag both repos under one slug when the project has a wiki repo, or say in
  the checkpoint's tooltip that it covers the project only.
- **Stage 7 — sync order.** Pushing the parent before the wiki publishes a gitlink to a
  commit the remote does not have. Push nested repos first (`@vn/git` will export a
  `byDepth` order for the committer; reuse it), and refuse to push the parent while the
  wiki has unsent saves. Pulling the parent brings a gitlink the wiki's worktree may not
  match; the wiki's own pull, along its branch, catches it up, and the parent's gitlink
  follows at the next act. `git.pull` never runs `submodule update`, and the app never
  moves the wiki to match the parent.
- **Stage 7 — the collaborating guide** says a clone needs `--recurse-submodules`, and
  names the other plan's "not checked out" notification as what a clone without it looks
  like.

## What it costs to undo

- Stage 1: additive; one file.
- Stage 2: `<git>` in `AFFECTS_ROOTS` is referenced by every later declaration, so it is a
  one-file revert only until Stage 6. The `Committer` guard and `Git.commit`'s refusal are
  one file each.
- Stage 3: additive; the memo and the `vngit` scheme registration are two files.
- Stage 4: `EDITORS` is what validates stored layouts (`EDITOR_IDS`,
  `editors.ts:323-325`). Once an author has saved a layout naming `history`, removing the
  entry breaks that template. Not additive after it ships.
- Stage 6 and 7: commits, tags, remotes and rebased histories in an author's repository
  cannot be undone; the app can only stop producing them. `rewrote` once written into an
  author's `commands.jsonl` is permanent data, harmless to a reader that ignores unknown
  fields.

## Pressure test

A fresh-context agent reviewed the first draft against the code on 2026-09-20 (git
behaviour verified in scratch repositories on git 2.55). Twenty-two findings; what became
of each:

1. **Commit-on-save runs mid-rebase and bakes conflict markers into the replayed commit.**
   Fixed: the guard moved into `Committer` (Stage 2), `Git.commit` refuses, and the three
   conflict commands are `commitsItself`. The `workspacelifecycle.ts` change was dropped
   as redundant and untestable.
2. **Placeholder-refused controls fail `uxmodel.test.ts:56`.** Fixed: no write control is
   drawn before its command exists; Stages 4–5 ship read-only.
3. **`paletteonly.ts` described backwards; pinned lists and `gen:command-table` missing.**
   Fixed: the "every stage that adds a command" section.
4. **`log(limit)` change touches ~50 call sites.** Fixed: `history(opts)` is a new method;
   `log` is untouched.
5. **`rewrote` pairing by `Vn-Seq` or position is unsound; `ORIG_HEAD` timing.** Fixed:
   pairing by author ident + date + message hash over `rev-list <upstream>..HEAD` taken
   before and after; `to: null` for a dropped commit.
6. **HEAD is detached during a rebase, so the detached-HEAD rule refuses the conflict
   view.** Fixed: `inProgress()` returns the branch from `rebase-merge/head-name`; paths
   through `rev-parse --git-path`.
7. **Layering: the agent's tools cannot reach a desktop session rule.** Fixed: the pure
   modules and `revertDryRun` live in `@vn/git`; the tools share package code, not a
   session.
8. **`ownedRepos`, `committer()` and `pending` are unreachable from a command.** Fixed:
   host members for the owned repos and `pendingCount()`; `git.save` returns a subject and
   lets commit-on-save commit.
9. **The affects tier has no git repo and no committer.** Fixed: a second `describe` with
   `makeProject({ git: true })`.
10. **Checkpoint tag format, namespace, push and rebase behaviour were undecided
    formats.** Fixed: added to "Decided before"; `--follow-tags`; re-pointing through
    `rewrote`.
11. **`revertDryRun` needs a version floor or a fallback; `checkoutSide` fails on a
    deleted side; `gengraph.run` is in `gengraph.ts`; `pipeline.draw` omitted.** Fixed:
    `reset --hard` fallback justified by the clean-tree precondition; `rm` for a deleted
    side; both commands named; a doctor version probe.
12. **`lastFetch(remote)` cannot be per-remote.** Fixed: `lastFetch()` is for any remote
    and labelled so.
13. **`who=` is a post-filter and breaks paging.** Fixed: over-fetch to 50 matches with a
    1000-commit scan cap.
14. **`aheadBehind` errors before the first fetch.** Fixed: `branchStatus()` from
    `status --porcelain=v2 --branch`, `null` counts when unknown.
15. **`GIT_TERMINAL_PROMPT=0` does not stop an ssh passphrase prompt.** Fixed:
    `GIT_SSH_COMMAND=ssh -oBatchMode=yes`.
16. **`vngit://` needs boot-time scheme registration.** Fixed: Stage 2, `index.ts:33-37`.
17. **Doc pointers wrong.** Fixed: the editor count's three real homes named; the keys
    guide's missing GitHub section acknowledged; the report's stale citation scheduled for
    Stage 8.
18. **`wordDiff` is quadratic in memory.** Fixed: per paragraph with a token cap.
19. **`examples/` is not in the worktree.** Fixed: the Evidence projects section.
20. **Deferral safety.** Accepted: the two unsafe-as-written deferrals (agent commit
    shape; checkpoint refname) are now one hard-scheduled decision and one up-front
    decision.
21. **Undo costs corrected.** Fixed: the section is rewritten from the finding.
22. **Smaller factual points** (`diff-tree --root`, rename numstat form, memo invalidation
    on `continueSync`/`abandonSync`, list keyed on HEAD). All fixed in Stages 1 and 3.

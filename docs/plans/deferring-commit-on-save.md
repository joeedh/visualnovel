# Deferring commit-on-save

Status: **planned**

A run of consecutive commands that opted into deferral should produce one git commit rather
than one per command. The batching lives in `@vn/commands` beside the committer, because
nothing about it is specific to graphs, but it is motivated by and must be verified against
editing a node property in the Gen Graph editor.

## The problem

Editing a node property in the Gen Graph editor sends one command per change. The editor's
`perform` delegate calls `send`, which calls `exec` with no coalescing
(apps/desktop/renderer/pathux/editors/nodes.ts:227, :240, :273-277), so every committed field
edit is one `gengraph.setProp` and every finished node drag is one `gengraph.moveNodes`. Each
of those reads the graph file, writes it back
(apps/desktop/src/main/commands/gengraph.ts:54, :79) and then commits.

The commit is on the command's critical path:

- packages/commands/src/stack.ts:131 —
  `const commits = await this.commit(command.mutating && !command.commitsItself, record);`
  The commit is awaited inside `exec`, between the `post` snapshot and the record being
  appended, so the edit does not answer until git has finished.
- packages/commands/src/commit.ts:89 —
  `const sha = await git.commit({ message: subject, paths: ['-A'], trailers });`
  The scope is the whole worktree per repo, with no exclusions and no reference to the undo
  journal's pathspec. `Git.commit` runs `git add -A` first (packages/git/src/git.ts:189,
  :172-174). In a real project `vngen/` is committed, generated assets included, so the add
  stats a tree that may hold thousands of images. Stage 0 measured that scan and found it flat
  in the number of images, so the size of that tree is not what the time is made of.

Two corrections to that reading, both of which change what this plan can promise.

**The commit is not the only whole-worktree git call per command.** `CommandStack.exec` calls
`gitState()` before every command (stack.ts:98, :389-397), and `gitState` calls `git.isDirty()`,
which is `git status --porcelain` over the whole worktree (packages/git/src/git.ts:164-169).
That is the same scan class as `git add -A`. `isRepo()` and `head()` are two more spawns.
An undoable command adds two `git write-tree` calls over the document pathspec
(undo.ts:89, called from stack.ts:117 and :121). So a single `gengraph.setProp` today spawns
git many times over, and deferring the commit removes only the spawns the commit itself makes.
If `isDirty` is the dominant term rather than `add -A`, this plan buys less than it looks like
it will, which is why Stage 0 measures before Stage 5 changes anything. Stage 0 counted 26
spawns per edit and found that the commit makes 5 of them; the numbers are under "Measured"
below.

**`commitsItself` is a framework field with no shipped user.** It is declared at
packages/commands/src/command.ts:81 and read at stack.ts:131, and the only place that sets it
is a test (packages/commands/src/tests/commit.test.ts:185). `agent.run` does not declare it
(apps/desktop/src/main/commands/agent.ts:19-24); `vnauthor` avoids double-committing by
running a stack with no committer at all. It is still the right precedent for the shape of
the opt-in — a boolean on the command definition that the stack reads — but the plan should
not claim it is load-bearing today.

## Findings this plan rests on

Each was checked against the working tree on the `gengraph` branch. Findings 7 to 9 came from
the pressure test at
[`../research/pressure-test-deferring-commit-on-save.md`](../research/pressure-test-deferring-commit-on-save.md),
which verified the citations below and attacked the design; what it found is folded in here
rather than left in the report.

1. **Undo's correctness is unaffected; undo's own commit is not.** Undo rests on shadow
   snapshots parked under `refs/vn/undo/<seq>/{pre,post}` (undo.ts:84-99) on the journal's own
   pathspec (undo.ts:33-34), and `check`/`restore` compare and move trees rather than reading
   HEAD (undo.ts:142-197). Deferring a commit changes no file in the worktree, so it cannot
   perturb a snapshot tree, and `docs/reference/repos-and-commits.md:223-237` states the
   independence directly. What deferral does reach is the commit undo makes afterwards:
   `move` calls `this.commit(true, record)` (stack.ts:333), which takes `-A`, so an undo run
   with a batch pending would sweep the deferred edits into the undo's own commit. That is
   finding 5's failure mode wearing a different hat, and the fix is the same — flush first.
   The brief's claim that "deferring commits does not reach undo" is right about the mechanism
   and wrong about the commit, and the plan treats undo and redo as flush triggers because of it.
2. **The pipeline is unaffected.** A bound graph is read from disk by `readGraphDoc`
   (packages/gengraph/src/document.ts:65), which reads the file and never asks git anything.
   The desktop's `readGraph` wrapper adds a conflict check (apps/desktop/src/main/graphs.ts:50-62)
   that reads `git status` and filters for conflict codes only, so an uncommitted modification
   is invisible to it.
3. **Durability is unaffected.** `writeGraphDoc` writes the file atomically
   (packages/gengraph/src/document.ts:103-111) whether or not a commit follows.
4. **Crash recovery covers the bytes, not the attribution.** `openRepos` runs
   `committer().checkpoint('Changes made outside the app')` at
   apps/desktop/src/main/index.ts:384, guarded by `gitHealth().ok` at :374, precisely to record
   edits made outside the app. A batch lost to a kill is picked up there, so nothing is lost
   from disk. What is lost is the subject and the trailers: thirty graph edits come back as one
   checkpoint whose subject says they were made outside the app, and `commands.jsonl` still
   holds each record with no commit beside it. The brief calls this "already covered"; it is
   covered for durability and not for provenance, and Stage 3's idle timer exists to bound the
   window in which it can happen.
5. **The clean-worktree invariant is the one real cost, and it is stated as an invariant.**
   docs/reference/repos-and-commits.md:84-90 and packages/commands/src/commit.ts:8-11 both say
   the app opens on a clean worktree and every act ends with one, which is what makes `-A` the
   correct scope. Break it and the next command that does commit sweeps the accumulated graph
   edits into its own commit under its own subject and its own `Vn-Invocation` trailer. The
   corrupted commit is the innocent one, not any of the deferred ones. Flushing before any
   other command commits, and before undo or redo, reduces batching to runs of consecutive
   deferring commands.
6. **`CommandRecord.commits` has no production reader.** It is declared at
   packages/commands/src/command.ts:158-162, written at stack.ts:132 and stack.ts:334, and read
   nowhere outside packages/commands/src/tests/commit.test.ts:215, :232, :245. The only reader
   of `vngen/state/commands.jsonl` in code is `readCommandLog`
   (apps/desktop/src/main/commandlog.ts:25-45), which parses each line as a `CommandRecord` and
   keeps lines with a numeric `seq`; `@vn/agentreport`'s `renderAct`
   (packages/agentreport/src/transcript.ts:228-235) renders `seq`, `invocation`, `status`,
   `error`, `message` and `written` and never touches `commits`. The `onRecord` hook
   (apps/desktop/src/main/index.ts:702-731) reads `stack`, `mutating`, `source`, `status`, `id`,
   `message` and `error`. So the field's shape is free to change, and the risk is not a broken
   reader but a silent lie: absent `commits` currently means "nothing was committed", and a
   batched record would make it also mean "a commit is coming later". Stage 2 adds a field
   that separates the two.

7. **`exec` is not serialized, and the codebase says so deliberately.** `CommandStack.exec`
   takes no lock (stack.ts:71-150), and its own doc comment carries `origin` as a per-execution
   overlay rather than a field "because commands genuinely overlap: a mutable field would be
   clobbered by the next invocation while this one was still running" (stack.ts:66-69).
   `docs/reference/command-system.md:517-522` states the same, and the node editor dispatches
   fire-and-forget with `void exec(...)` (nodes.ts:276). So a deferring command can be sitting
   inside `await command.run` while a non-deferring one flushes and then commits `-A`, which
   sweeps the first command's write into the innocent commit — finding 5's corruption reached
   through a door a sequential test never opens. Flushing before `run` is necessary and not
   sufficient, and the design section below adds the serialization that makes it sufficient.
8. **A machine without git still gets a committer.** The desktop passes `committer: committer()`
   unconditionally (index.ts:701), and the stack's commit path guards on `!committer`
   (stack.ts:364) rather than on the repo list. `ownedRepos` being empty means the committer
   runs and commits nothing, not that no committer exists, so a batch would accumulate forever
   with every record marked `commitDeferred`. Stage 2 must decide what an empty commit result
   means, which is finding 9.
9. **An empty commit result is ambiguous.** `Committer` returns `[]` both for "no repos owned"
   and for "every repo was already clean" (commit.ts:85-93). A flush that returns `[]` must
   clear the batch rather than keep it, or the git-less case never drains; the failure path that
   keeps the batch is a thrown error, not an empty result.

Two more facts the design leans on:

- **`Committer` commits every owned repo that is dirty**, looping `await this.opts.repos()`
  and skipping a repo with nothing to commit (commit.ts:85-93). It does not resolve a
  per-command repo and never calls `RepoResolver`. `ownedRepos` is a module-level array in the
  desktop app (index.ts:356), filled from `Workspace.repos()` for roots with `owned: true`
  (index.ts:376-380) and passed to the committer through a thunk (index.ts:468-470) so it
  always sees the current contents.
- **Undo and redo bypass the registry.** `handle('command:undo', () => getStack().undo())` and
  the redo line beside it (index.ts:804-805) call the stack directly, so a flush placed in
  `CommandStack.undo()` and `.redo()` cannot be routed around.

## Non-goals

- **Deferring the file write.** Every deferring command still reads the graph, applies its
  edit and writes the file before it returns. Holding the document in memory and writing it
  later is a larger piece of work — it changes what `readGraphDoc` sees, what the pipeline
  reads mid-edit, and what `written` means — and it is not designed here.
- **The DataAPI rewrite of the node editor.** Coalescing a slider drag into one command in the
  renderer would attack the same cost from the other end. That is
  [`gengraph-node-editor-data-api.md`](gengraph-node-editor-data-api.md), a separate change that
  does not block this one; the two compose, since fewer commands and cheaper commands are
  independent wins.
- **Narrowing the commit scope.** Committing `record.written` instead of `-A` is refused by
  docs/history/gitUndoOptions.md §3 (a declared write set is an unverified claim), and a
  pathspec narrower than the worktree would leave other dirty files behind and break the
  invariant in finding 5 a different way.
- **Reducing the other per-command git spawns.** `gitState`'s three calls and the journal's two
  `write-tree` calls stay as they are. Stage 0 measures them so a later plan can decide.
- **Batching across a non-deferring command.** A batch never spans one, by construction.
- **Per-window batches.** See Decisions.
- **An author-facing "commit now" control.** Nothing new appears in a menu.

## Design

### Who opts in

A new optional field on the command definition:

```ts
/** Whether this command's commit may be held back and folded into the next flush. */
defersCommit?: boolean;
```

The stack reads it exactly where it reads `commitsItself` today (stack.ts:131). Only
`gengraph.setProp` and `gengraph.moveNodes` set it in Stage 5.

The alternatives and why they lost:

- **A prop on the invocation.** A prop goes through `coerceProps`, lands in `record.props`,
  reaches `digestProps` and shows up in `Vn-Invocation`, which would put a performance
  decision into the provenance of the act. It would also let the palette and the editor
  disagree about the same command.
- **A mode the caller enters and leaves.** A `beginBatch()` / `endBatch()` pair around a drag
  would give the tightest possible batches, and it is the wrong shape here for two reasons.
  The gesture lives in the renderer and the batch lives in main, so the bracket crosses an IPC
  boundary and a dropped `endBatch` — a renderer crash, a window closed mid-drag, an exception
  between the two calls — leaves the batch open with nothing to close it and the invariant
  broken indefinitely. The command-level flag has no open state to lose: the batch is closed by
  the next thing that happens, whatever that is.

### What ends a batch

`CommandStack` holds one pending batch: an array of `CommandRecord`s whose commits were held
back. It is flushed by all of the following, and by nothing else.

| Trigger | Where | Why |
| --- | --- | --- |
| A mutating command that does not defer | `exec`, before `command.run` | Finding 5. Flushing before `run` rather than before the commit matters: at that moment the only dirty content is the deferred edits, so the flush commit contains exactly them. Necessary but not sufficient on its own — see Serialization below. |
| `undo()` | top of `CommandStack.undo` | Undo commits its restored tree with `-A` (stack.ts:333). Without a flush, that commit carries the deferred edits under a `Vn-Undo` trailer. |
| `redo()` | top of `CommandStack.redo` | Same commit path, same reason. |
| An idle interval with nothing further deferred | a timer in the stack | Bounds the window in finding 4. |
| Workspace switch | `switchWorkspace`, at the top | index.ts:321 drops the stack and :327 refills `ownedRepos`, so an unflushed batch would be abandoned. It flushes at the top rather than beside `stack = null` because `notifications().suspend()` (index.ts:318) clears pending notifications and `workspaceRoot` is reassigned at :319 — a flush placed after either would drop an `onCommitError` note or file it into the project the author just opened. |
| App quit | the existing `before-quit` flush race | index.ts:1109-1116 already calls `event.preventDefault()` and races `state.close()` against `QUIT_FLUSH_MS`. The flush is joined with `Promise.all` alongside `state.close()`, so the race is against both settling rather than against whichever finishes first. |

Deliberately not triggers:

- **A non-mutating command.** It commits nothing, so it cannot steal the batch, and flushing
  on every `asset.info` or `bible.search` would undo most of the saving.
- **A window closing.** One app instance owns the workspace and all its windows
  ([`multiple-windows.md`](multiple-windows.md)), `window.close` is not mutating
  (docs/reference/command-system.md:503-506), and the worktree does not belong to the window
  that is going away.
- **A write that commits outside `exec`.** There is none that can sweep a batch. `commitScaffolding`
  and `commitThread` pass narrow pathspecs rather than `-A`, `initRepoAt` runs only where there is
  no repo yet, and the agent's `git_commit` tool stages nothing without paths. The trigger table is
  exhaustive because of that, and it is written down here so a later reader does not have to
  re-establish it. One registered handler does bypass the stack — `handle('agent:run', …)`
  (index.ts:764-768) — but the renderer reaches the agent through the `agent.run` command, and that
  handler commits nothing itself.
- **A repo boundary.** The committer already loops every owned repo and skips the clean ones
  (commit.ts:85-93), so a flush commits every repo the batch dirtied, each under its own
  commit. There is no per-repo pending list to keep, and nothing calls `RepoResolver` on this
  path. In practice only the project repo is in play, since graph documents live under
  `vngen/work/graphs/`. The brief's "a batch is per-repo" is answered by the existing loop
  rather than by splitting the batch.
- **The pipeline starting a run.** `pipeline.run` and `gengraph.run` are mutating commands that
  do not defer, so the first row of the table already covers them.
- **Anything that reads git without committing.** `readGraph`'s conflict check
  (graphs.ts:65-79), `listLayouts`, and `gitState` all read status and commit nothing. A dirty
  worktree changes one thing for them: `record.gitDirty` reads `true` for every command run
  while a batch is pending, where today it is almost always `false`. That is a real change in
  the shape of recorded provenance and is documented rather than worked around, because it is
  also true: the worktree really is dirty.

### Serialization

Finding 7 makes the flush ordering insufficient by itself. Two `exec` calls overlap freely
today, and nothing in this plan's flush placement stops a deferring command's write from
landing on disk while a non-deferring command's `-A` commit is running. The window is not
theoretical: the node editor dispatches with `void exec(...)` (nodes.ts:276), so a keystroke
that arrives during a menu action is exactly this case.

`CommandStack` gains one mutual-exclusion chain covering the span from the flush through
`command.run` to the commit, entered by every mutating command whether or not it defers. A
non-mutating command does not enter it, so `asset.info` and `bible.search` stay as concurrent
as they are now.

This narrows the concurrency the stack allows today, and that is a real behaviour change rather
than a free fix. Mutating commands already contend for one worktree and one `-A` commit scope,
so overlapping them was never safe in the way the doc comment's `origin` reasoning implies —
that comment is about a field being clobbered, not about writes being isolated. The change is
worth naming in Stage 6's docs pass rather than made silently.

`flushCommits` is additionally single-flight: a second caller awaits the first rather than
starting a second commit over the same repos.

### The subject and trailers of a batched commit

`Committer` gains `commitBatch(records: CommandRecord[])`. With one record it produces
byte-identical output to today's `commit(record)`, so the common path does not change at all.

With more than one, the subject names the last act and states how many came with it, capped at
`SUBJECT_MAX` by the existing `subject()` helper (commit.ts:32, :39-43):

```
Set model on GenImage (and 29 more edits)

Vn-Batch: 30 seqs 41,43,45-72
Vn-Seq: 72
Vn-Command: gengraph.setProp, gengraph.moveNodes
Vn-Source: ui
```

The last record names the subject because it is the state the commit actually contains, and it
is the edit the author most recently made.

`Vn-Seq` stays what it is today: one integer, the last record in the batch. Widening it in place
to a range would change the meaning of an existing trailer without renaming it, so a reader that
parses it as a number gets a wrong answer rather than no answer, and `Vn-Batch` only warns the
reader who already knows to look for it. The span goes in the new trailer instead.

`Vn-Batch` carries the count and the exact seqs. The seqs a batch covers are not contiguous:
`exec` allocates a seq before it knows whether the command defers (stack.ts:99), so a
non-mutating command between two deferring ones consumes one without joining the batch, and so
does a deferring command that throws. The seqs are written as a comma-separated list with runs of
two or more hyphenated, and the recovery story in finding 4 depends on the list being exact
rather than on it looking tidy.

`Vn-Invocation` is dropped for a multi-record batch: thirty invocations do not belong in a
commit message, and each one is already in `commands.jsonl` keyed by a seq `Vn-Batch` names.
`Vn-Command` and `Vn-Source` list the distinct values, comma-separated, which is one value each
in the case this plan is for.

The count must survive truncation. `subject()` caps at `SUBJECT_MAX` and appends an ellipsis
(commit.ts:32, :39-43), so appending `(and 29 more edits)` to a long base subject and then
capping would eat the count — the one part of the line that says the commit is a batch.
`commitBatch` truncates the base subject to leave room for the suffix, then appends. Stage 1
therefore gave `subject()` an optional cap, and applied it to the fallback as well as to the
message: a record with no message falls back to its invocation, which has no length bound of its
own, so leaving that branch untruncated would push the count past the cap in the one case the
suffix exists for.

### `record.commits` and the record's shape

A batched record carries no `commits`, because the sha does not exist when the record is
appended and `commands.jsonl` is append-only (index.ts:707) so it cannot be rewritten later. To
stop absent `commits` from meaning two different things, a batched record gains:

```ts
/** Set when this act's commit was held back to be folded into a later flush. */
commitDeferred?: true;
```

Nothing reads it yet, by finding 6. Both halves of this are hard to take back: a commit that
folded thirty acts cannot be re-split afterwards, and `commands.jsonl` is append-only, so every
`commitDeferred` line written under a wrong rule stays wrong. That is why finding 9's
empty-result rule has to be right the first time rather than corrected later. It is added so
that the first reader that wants the distinction can have it, and so `commands.jsonl` does not quietly assert that thirty acts
committed nothing. The flush's own commit is discoverable from the other direction: its
`Vn-Seq` range names every record it contains.

### Multiple windows

The pending batch is per instance. There is one `CommandStack` per open workspace
(index.ts:627-735), one `Committer` over one `ownedRepos` array, and one worktree. `ctx.origin`
is deliberately absent from `CommandRecord` (command.ts:36-39,
docs/reference/command-system.md:524-527), so a batch could not be keyed by window even if
that were wanted. An edit dragged in window A and an edit typed in window B fold into the same
commit, which is correct: they changed one worktree, and the commit describes the worktree.

### What deferral does not batch

**Undo.** Both commands that opt in are `undoable: true` (commands/gengraph.ts:414, :465), and
the journal is untouched by this plan, so thirty edits folded into one commit are still thirty
undo points. Reversing that commit takes thirty presses, each of which commits its own restored
tree. The asymmetry is a consequence of batching only the commit, it is not a defect, and it is
recorded here because a reader of the git log would otherwise expect one press to undo one
commit.

**The flushing command's own `gitDirty`.** `exec` captures `dirty` at stack.ts:98, before the
flush this plan adds at :120, so a non-deferring command that flushes records the worktree as
dirty even though its own commit runs against a clean one. Recording the state as it was when
the act started is the existing contract rather than a bug introduced here, and moving the
capture would change what `gitDirty` means for every command. Left as-is and named in Stage 6.

### Failure at flush

Today a failed commit is swallowed and logged as a warning (stack.ts:362-371), on the rule
that provenance must not fail a command that already ran and already wrote. That rule still
holds, and it degrades badly at thirty acts: one warning in a console nobody is reading would
be the only trace that a batch never landed.

The flush therefore does three things on failure. It keeps the batch pending rather than
clearing it, so the next flush retries and the records are not lost. It calls a new
`onCommitError(error, records)` stack option, which the desktop wires to a durable
notification at `vngen/state/notifications.jsonl` through `notify`
(apps/desktop/src/main/notifications.ts, used at index.ts:712) with `category: 'error'` and
`level: 'error'`. The message names the count, the seq range and git's own error, and says the
edits are on disk and uncommitted — which is what the author needs to know and can act on.
The open-time checkpoint (index.ts:384) stays the final backstop.

A machine without git is not the free case an earlier reading of this plan claimed. The desktop
wires `committer: committer()` unconditionally (index.ts:701) and the stack guards on
`!committer` (stack.ts:364), so the committer exists, owns no repos, and commits nothing. By
finding 9 a flush that returns `[]` therefore clears the batch: only a thrown error keeps it.
Without that rule the batch grows for the whole session on a machine that can never drain it,
and every record is marked `commitDeferred` for a commit that is not coming.

### The idle timer

`BATCH_IDLE_MS` defaults to 1500. Each deferring command resets it; firing flushes the batch.
The timer is injectable the way `now()` already is (stack.ts:26, :339-341), so tests drive it
rather than sleeping.

The timer is owned rather than left running. `CommandStack` gains `dispose()`, which cancels a
pending timer and flushes, and `flushCommits` cancels the timer itself rather than relying on
the next firing finding an empty batch. `switchWorkspace` drops the stack with `stack = null`
(index.ts:321) and refills the module-level `ownedRepos` with the next project's repos
(index.ts:327-329) while the committer holds that same array through a thunk (index.ts:356,
:468-470). A timer surviving that boundary would fire against a discarded stack and commit into
the project the author just opened.

Stage 3 gave `dispose()` one thing beyond cancel-and-flush: a disposed stack stops deferring, so
a command that reaches it after the host let it go commits for itself. Without that, `dispose()`
and `flushCommits()` would be the same call under two names, and a late act would join a batch
with nothing left to drain it.

Killed with the timer pending, the batch is exactly finding 4: the bytes are on disk, and the
next session's checkpoint commits them under "Changes made outside the app". The subject is
then inaccurate about where the edits came from, and this plan accepts that rather than
widening the checkpoint's vocabulary — from the next session's point of view the edits did
arrive from outside it, and the alternative is a second checkpoint subject that would have to
be chosen without knowing which case applies.

## Stages

Each stage lands green under `pnpm check && pnpm test && pnpm lint` on its own.

### Stage 0 — measure

No production code changes. Add a throwaway script under the scratchpad (not committed) that
runs N `gengraph.setProp` invocations against a project seeded with a realistic
`vngen/build/assets/` tree, timing:

- `exec` end to end,
- `gitState()` alone,
- `Committer.commit` alone,
- the journal's two `capture` calls.

Record the four numbers in this file under a "Measured" heading. This stage exists because the
premise — that the commit dominates — is read from the code rather than measured, and
`gitState`'s `git status --porcelain` is the same whole-worktree scan as `git add -A`. If the
commit is not dominant, Stage 5 still lands but the plan's claim about the win is corrected
here rather than after the fact.

#### Measured

Windows 11, git 2.51, one repo, warm cache. The harness seeds a temp project — 20 scenes, a
default `portrait` slot graph, and N 32 KB files under `vngen/build/assets/`, all committed —
and then runs the real `gengraphSetProp` through a real `CommandStack` with a real
`UndoJournal` on `UNDO_PATHS` and a real `Committer`. One warm-up edit, then 20 timed edits,
each setting the `GenImage` node's `aspect`. Every term is timed inside the same `exec` rather
than in a phase of its own, and the timing follows the async call chain, so a git call made
inside `capture` or `commit` is not also counted against `gitState`.

Per edit, mean over 20 edits, at 2000 committed assets:

| Term | ms | Share of `exec` | git subprocesses |
| --- | --- | --- | --- |
| `exec` end to end | 1004 | 100% | 24 |
| `gitState()` | 113 | 11% | 3 |
| the journal's two `capture` calls | 566 | 56% | 14 |
| `Committer.commit` | 232 | 23% | 5 |
| the read, the write and everything else | 93 | 9% | 2 |

`journal.prune` costs a further 73 ms over 2 subprocesses. The stack starts it without awaiting
it (stack.ts:136, :379), so it lands outside `exec` and outside the table.

**The commit is not dominant, and Stage 5 wins about a quarter of an edit.** The undo journal's
two `capture` calls cost 2.4 times what the commit costs. Deferring commit-on-save takes 232 ms
off 1004, which is worth having and is not the bulk of the cost. The other three quarters stay
where they are: `capture` cannot be deferred without changing what undo can restore, and
`gitState` runs before the command that would have opted out of it.

**The time is process startup, not tree size.** The same 20 edits cost 1012 ms each at 0
assets, 1004 ms at 2000, and 1011 ms at 6000. git's index stat cache makes an unchanged tree
cheap to rescan, so neither `git add -A` nor `git status --porcelain` grows with
`vngen/build/assets/`. What the 1004 ms is made of is 26 git subprocesses at roughly 35 ms
each, which is 913 ms of it: 3 for `gitState`, 7 per undo snapshot, 5 for the commit, 2 for
`prune`, and 2 for `readGraph`'s conflict check. So batching wins by removing spawns rather
than by avoiding a large scan, which is worth 5 spawns per deferred edit — a run of thirty
saves 29 × 5, about 5 seconds. It also means any alternative that narrows a pathspec instead
buys nothing.

**Serializing mutating commands costs throughput, and the node editor does not pay it.** The
same 20 edits run four at a time take 320 ms of wall clock each while each `exec` still takes
1115 ms, so git's subprocesses overlap well and Stage 2's chain gives that up. What pays for
that is a host issuing mutating commands back to back, which means the agent's tool loop. The
node editor is not one: `perform` fires once per finished drag
(vendor/path.ux/scripts/editors/nodeeditor/nodegraphview.ts:466-490, and the per-pointer-move
call at :456 is `check`, which stays in the renderer), and a value row commits on DOM `change`
rather than on input (nodes.ts:349-352), so its commands are one per authorial act and arrive
separated by human time. The chain also removes a race the overlap creates: two edits of one
graph file read, decide and write with no lock (gengraph.ts:75-79), so today's final state is
whichever write lands last rather than the last edit the author made.

### Stage 1 — `Committer.commitBatch`

`packages/commands/src/commit.ts` gains `commitBatch(records: CommandRecord[])` and a
`trailersOfBatch` beside the existing `trailersOf`. One record delegates to today's path.
Nothing calls it yet, so behavior is unchanged.

Tests in `packages/commands/src/tests/commit.test.ts`, over the existing `tempProject` helper:
a one-record batch produces the same subject and trailers as `commit(record)`; a thirty-record
batch produces the count subject, `Vn-Seq` still holding the last seq as an integer, a
`Vn-Batch` naming the count and the exact seqs, distinct `Vn-Command` values and no
`Vn-Invocation`; a batch over non-contiguous seqs renders the gaps rather than a span across
them; a base subject long enough to hit `SUBJECT_MAX` still ends with its count; an empty batch
commits nothing and returns `[]`; a batch spanning two repos produces one commit in each.

### Stage 2 — the pending batch in the stack

`Command.defersCommit` on the definition (command.ts), `CommandRecord.commitDeferred`, and the
pending array plus `flushCommits(): Promise<CommitResult[]>` on `CommandStack`. Flush triggers
wired for the three that live in the stack: a non-deferring mutating command in `exec`, and
the tops of `undo()` and `redo()`. A flush returning `[]` clears the batch, by finding 9. No
shipped command declares `defersCommit`, so shipped behavior is unchanged.

The mutual-exclusion chain from the Serialization section lands here too, because finding 7
makes it part of what the flush placement is for rather than a later hardening. It covers flush
→ `run` → commit for every mutating command, single-flights `flushCommits`, and leaves
non-mutating commands concurrent.

Tests in `packages/commands/src/tests/commit.test.ts` and `stack.test.ts`:

- Three deferring commands in a row produce zero commits, and each record carries
  `commitDeferred: true` and no `commits`.
- A fourth, non-deferring mutating command produces two commits: the flush, then its own.
- **The regression test finding 5 demands.** Three deferring commands write `a.md`, `b.md`,
  `c.md`; a non-deferring command then writes `d.md`. Assert with `git show --name-only` that
  the non-deferring command's commit names `d.md` and none of the other three, and that the
  flush commit names the three and not `d.md`. This is the test that proves the corruption
  cannot happen, and it is the reason flush runs before `command.run` rather than before the
  commit.
- A non-mutating command between two deferring ones does not flush, and the seq it consumed is
  absent from the eventual `Vn-Batch`.
- `undo()` with a batch pending flushes first, so the deferred edit is in history before the
  restore overwrites it.

  Stage 2 corrected this bullet, which asked for the flush to be observed through the undo's own
  commit not naming the deferred files. That state is unreachable. `UndoJournal.check` compares
  the current tree against the target point's snapshot (undo.ts:142-197), so a pending edit to
  any file other than the target's own is drift and undo refuses before it commits anything. The
  one case that does reach the restore is a deferring command that is itself the undo target,
  and there the flush is what keeps its edit in history at all: without it the restore deletes a
  file that was never committed. The test asserts that instead.
- A stack with no committer never defers anything and never sets `commitDeferred`.
- A committer that owns no repos drains: three deferring commands then a flush leaves nothing
  pending, and the fourth deferring command's batch starts empty.
- **The interleaving test finding 7 demands.** Start a deferring command whose `run` blocks on a
  gate the test controls, and while it is inside `run`, `exec` a non-deferring mutating command.
  Release the gate. Assert that the deferring command's file appears in exactly one commit, and
  that the non-deferring command's commit names only its own file. Without the serialization
  chain this test fails while Stage 2's sequential tests pass, which is precisely why it is
  written.

### Stage 3 — the idle timer and the failure hook

`BATCH_IDLE_MS`, an injectable timer, `dispose()`, and `onCommitError` on
`CommandStackOptions`. A failed flush keeps the batch and calls the hook; an empty result
clears it.

Tests: the timer fires and flushes with no further command; `flushCommits` cancels a pending
timer so it cannot fire against an empty batch; `dispose()` cancels and flushes; a flush that
throws leaves the batch pending, calls `onCommitError` once with the records, and a later
successful flush commits all of them under one subject.

### Stage 4 — desktop wiring

- `switchWorkspace` (index.ts:299) awaits `stack?.dispose()` on the stack it is dropping, before
  `notifications().suspend()` (:318) and before `workspaceRoot` is reassigned (:319).
- The second `before-quit` handler (index.ts:1109) races `Promise.all([state.close(), flush])`
  against `QUIT_FLUSH_MS` rather than adding a third racer that would let the quit proceed as
  soon as `state.close()` settled.
- `QUIT_FLUSH_MS` is revisited against Stage 0's measurement. Its current 2000 was chosen for
  losing a panel width (index.ts:1098-1100), and this plan's own premise is that `add -A` is
  slowest on exactly the projects that accumulate the largest batches.
- `getStack()` (index.ts:684) passes `onCommitError`, wired to `notify`.

Stage 4 corrected three of those bullets.

**One call at the switch, not a flush and then a dispose.** The bullet asked for
`getStack().flushCommits()` at the top of the function and `dispose()` later. Two things make
that wrong. `getStack()` builds a stack where none exists, so a switch before the first command
would construct one only to drop it; the local `stack` is asked instead. And the top of the
function is ahead of the workspace lock (index.ts:304-311) and `openWorkspace` (:313), either of
which can throw — a stack disposed there would stop deferring for the rest of a session that
never switched. The single call sits after both, still ahead of `suspend()` and the root moving.

**`dispose()` does not take the mutual-exclusion chain.** `switchWorkspace` is reached only from
`host.openWorkspace`, and all three commands that call it are `mutating: true`
(commands/workspace.ts:107, :137, :157), so it always runs inside a command that already holds
the chain. A serialized flush there would queue behind the command awaiting it and never return,
hanging the app on every project switch. The direct flush is also safe rather than merely
necessary: that command flushed before it ran, and a deferring act is mutating and so cannot have
started since, which leaves the batch provably empty at that point.
`flushCommits()` keeps the chain and stays the entry point for a caller outside a command, which
is what quit is. A test in commit.test.ts calls `dispose()` from inside a mutating command, so
the deadlock cannot come back.

**`QUIT_FLUSH_MS` stays at 2000.** The premise the bullet asked it to be revisited against is the
one Stage 0 falsified: a commit costs about 230 ms and does not grow with the project, because
the cost is git's own process startup rather than the size of the tree `-A` stages. Its comment
now names both writes the quit is holding open for.

The desktop jest project is node-only, so these are covered by the existing main-process tests
plus a manual check over CDP in Stage 5.

### Stage 5 — the two gengraph commands opt in

`gengraph.setProp` (commands/gengraph.ts:405) and `gengraph.moveNodes` (:458) declare
`defersCommit: true`. Nothing else does.

Verification: over CDP, drag a slider on a node and then run a `story.*` edit; assert with
`git log` that the drag produced one commit whose `Vn-Batch` names the run, and that the story
edit's commit names only the scene file. Re-run Stage 0's measurement and record the delta.

### Stage 6 — docs

- `docs/reference/repos-and-commits.md` — a subsection under "Commit-on-save" stating the
  deferral, the flush triggers, the batched message shape, and the amended invariant: the
  worktree is clean at the start and end of every act except a run of deferring ones, and the
  next non-deferring act flushes before it runs. The sentence at :234-235 saying a clean
  worktree becomes the norm is falsified by this change and is rewritten rather than left.
- `docs/reference/command-system.md` — `defersCommit` and `commitDeferred` in the
  `CommandRecord` block (:207-226) and the commit-on-save section (:265-278). The overlap
  sentence at :517-522 is amended: mutating commands are serialized, non-mutating ones are not.
- `packages/commands/src/command.ts:159-162` — the doc comment on `commits` enumerates the two
  meanings an absent field has today, and a third one now exists. It gains `commitDeferred`.
- `packages/commands/src/commit.ts:8-11` — the comment justifying `-A` by the clean-worktree
  invariant. Reworded for the run of deferring acts, per the open question below.
- `CLAUDE.md` — the commit bullet under "Command system" gains a clause naming deferral.
- This file's status flips and it moves to `docs/plans/archive/`.

## Decisions

| Decision | Alternative it beat | Why |
| --- | --- | --- |
| Opt in on the command definition (`defersCommit`) | A prop on the invocation | A prop reaches `record.props`, `digestProps` and `Vn-Invocation`, putting a performance decision into the act's provenance, and lets two callers of one command disagree. |
| Opt in on the command definition | A caller-entered batch mode | The bracket would cross the IPC boundary between the renderer's gesture and main's stack, and a dropped close leaves the batch open with nothing to close it. A flag has no open state to lose. |
| Flush before `command.run`, not before its commit | Flush immediately before the non-deferring commit | Before `run`, the only dirty content is the deferred edits, so the flush commit contains exactly them. After `run`, the new command's writes are already on disk and would be split arbitrarily between the two commits. |
| Batched records carry no `commits`, plus `commitDeferred: true` | Write the sha back after the flush | `commands.jsonl` is append-only (index.ts:707); a record already written cannot gain a field. The commit's own `Vn-Seq` range recovers the mapping from the other side. |
| The subject names the last act and the count | The first act's subject; a generic "N edits" | The last act is the state the commit contains and the edit the author just made. A bare count says nothing in `git log`. |
| Drop `Vn-Invocation` on a multi-record batch | List all invocations | Thirty invocations in a commit message are unreadable, and `commands.jsonl` already holds each one under the seq the range names. |
| One pending batch per app instance | Per window | One instance owns the workspace and all its windows, `ctx.origin` is absent from `CommandRecord` by design, and there is one worktree to describe. |
| Keep the batch on flush failure and file a notification | Clear it and log a warning, as today | Today's swallow loses one act's provenance; deferred it would lose thirty silently. Keeping the batch retries, and the notification is durable. |
| An idle timer at 1500 ms | No timer, relying on the next flush trigger | Without one, an author who edits and then stops leaves a dirty worktree for as long as the app stays open, and a kill turns the whole run into a checkpoint with the wrong subject. |
| Serialize mutating commands end to end | Rely on the flush placement alone | `exec` overlaps freely today (stack.ts:66-69), so a deferring command inside `run` during another command's `-A` commit reproduces the corruption the flush placement is meant to prevent. |
| `Vn-Seq` stays an integer; the span goes in `Vn-Batch` | Widen `Vn-Seq` to a range | Redefining an existing trailer in place gives a reader that parses it as a number a wrong answer rather than no answer. |
| `Vn-Batch` lists exact seqs, gaps and all | A first-to-last span | A non-mutating command between two deferring ones consumes a seq without joining the batch (stack.ts:99), so a span would claim records the commit does not contain. |
| An empty flush result clears the batch | Keep it, as the failure path does | `Committer` returns `[]` both for no repos and for nothing to commit (commit.ts:85-93), so keeping it would make a git-less machine accumulate forever. Only a throw keeps the batch. |
| Keep `git add -A` | Narrow the scope to `record.written` or a pathspec | `written` is an unverified claim (docs/history/gitUndoOptions.md §3), and any scope narrower than the worktree leaves dirty files behind, breaking the same invariant this plan is careful about. |

## Acceptance criteria

- Thirty consecutive `gengraph.setProp` invocations produce exactly one commit.
- That commit's subject names the last edit and the count, and keeps the count even where the
  base subject would otherwise fill `SUBJECT_MAX`. Its trailers carry a `Vn-Batch` naming the
  count and the exact seqs, a `Vn-Seq` still holding one integer, and no `Vn-Invocation`.
- A deferring command running concurrently with a non-deferring one lands in exactly one commit,
  and the non-deferring command's commit names only its own files.
- A committer owning no repos never leaves a batch pending.
- A non-deferring command run after a batch produces two commits, and `git show --name-only`
  on its commit names only the files it wrote.
- `undo()` after a batch flushes first, so the batch is in history before the restore runs.
- Every batched `CommandRecord` in `commands.jsonl` carries `commitDeferred: true` and no
  `commits`; every non-batched one is unchanged.
- A single deferring command followed by an idle interval commits with today's subject and
  today's trailers, byte for byte.
- A flush that fails files a notification naming the count and the seq range, leaves the batch
  pending, and commits everything on the next successful flush.
- A workspace switch and an app quit each leave no batch pending.
- Stage 0's measurement is recorded in this file, and Stage 5's re-measurement beside it.
- `pnpm check && pnpm test && pnpm lint` green at every stage.

## Open questions

- **How much concurrency does serializing mutating commands actually cost?** Answered by Stage
  0: four `gengraph.setProp` invocations at once cost 320 ms of wall clock each against 1185 ms
  run one at a time, so the chain gives up a factor of 3.7 on this machine where a host issues
  mutating commands back to back. The node editor does not, for the reasons under "Measured", so
  the cost falls on the agent's tool loop, whose mutating commands touch different files and were
  not measured here.
- **Should prose typing defer too?** The scene editors send one command per authorial act
  rather than per keystroke (docs/reference/command-system.md:529-531), so they are not the
  same problem. Whether `art.setNotes` or the `prompt.*` chunk editors would benefit is not
  answered here.
- **Should losing window focus flush?** It would shorten the window in finding 4 without a
  timer firing, and it needs a main-process focus hook this plan does not otherwise touch.
  Left out of Stage 3; revisit if the timer proves too coarse.
- **What should `BATCH_IDLE_MS` be?** 1500 is a guess, and Stage 0 leaves it standing. One
  commit costs 232 ms, and a serialized edit costs about 770 ms once the commit is deferred, so
  1500 ms is roughly two edits' worth: long enough that a drag cannot cross it and short enough
  that an author who stops leaves nothing pending for long.
- **Should the open-time checkpoint distinguish a lost batch?** It would need to tell edits
  made outside the app from edits made inside it and never flushed, and nothing on disk
  records the difference today. Accepted as-is, and named here so a future reader does not
  assume it was missed.
- **Does the invariant's wording need to change in `commit.ts`'s doc comment?** The comment at
  commit.ts:8-11 justifies `-A` by the invariant. It stays true between acts of different
  kinds and becomes false within a run of deferring ones. Stage 6 rewords it; the exact
  sentence is not settled here.

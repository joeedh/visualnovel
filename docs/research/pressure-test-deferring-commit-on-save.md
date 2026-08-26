# Pressure test: deferring commit-on-save

A fresh-context review of docs/plans/deferring-commit-on-save.md against the working tree on the
`gengraph` branch. Findings are numbered and carry a severity. The plan's strengths are stated in
findings 13 through 16 rather than left implicit.

## Where the plan is right, up front

Every file:line citation I checked said what the plan claimed, and the plan corrects its own brief
twice in ways that make it weaker and more honest. The two claims the review was asked to break —
that `CommandRecord.commits` has no production reader, and that undo's mechanism is untouched — both
hold. The one load-bearing claim that does not hold is the flush-before-`run` argument, and it fails
for a reason the plan never considers: `exec` is re-entrant.

## Blocking

### 1. `CommandStack.exec` is not serialized, so flushing before `command.run` does not establish what the plan says it establishes

Severity: **blocking**.

The plan's central safety argument is docs/plans/deferring-commit-on-save.md:172 — "at that moment
the only dirty content is the deferred edits, so the flush commit contains exactly them" — and the
Decisions table repeats it at :387. That is true only if no other command is between its own write
and its own commit while the flush runs. Nothing enforces that.

`exec` is a plain `async` method with no lock, no queue and no in-flight guard
(packages/commands/src/stack.ts:71-150). The codebase does not merely permit overlap, it documents
and tests it: `origin` is a per-execution overlay "because commands genuinely overlap: a mutable
field would be clobbered by the next invocation while this one was still running"
(packages/commands/src/command.ts:30-37), and docs/reference/command-system.md:517-522 says the same
and names `packages/commands/src/tests/origin.test.ts`, which "parks one command inside `run` while
another goes through". The renderer supplies the overlap for free: the node editor's `send` is
fire-and-forget, `void exec(command.id, command.props)`
(apps/desktop/renderer/pathux/editors/nodes.ts:276), so a slider drag dispatches without awaiting the
previous invocation.

The concrete corruption, with A a deferring `gengraph.setProp` and B a non-deferring mutating
command:

1. A enters `exec`, writes the graph file at apps/desktop/src/main/commands/gengraph.ts:79, and is
   still inside `await command.run` (stack.ts:120).
2. B enters `exec` and flushes. The pending batch holds records 1..29 but not A, because A has not
   reached the point where it would join.
3. B runs and commits with `-A` (packages/commands/src/commit.ts:89). A's write is on disk, so it
   lands in B's commit, under B's subject and B's `Vn-Invocation`.
4. A finishes and joins the batch. The next flush finds nothing to commit for A, so A's record
   carries `commitDeferred: true` and points at a commit that does not exist.

That is exactly the failure the plan says finding 5 is about, reintroduced through the door the plan
did not check. The Stage 2 regression test as written (:331-336) runs the four commands
sequentially, so it passes while the shipping path fails.

A second form of the same problem: two flushes can be in flight at once — an idle timer firing while
a non-deferring command flushes, or two windows dispatching non-deferring commands together. Both
call `git add -A` and `git commit` on the same repo, and git serializes those with `index.lock`, so
one throws. The plan's failure handling then keeps a batch whose files another flush has already
committed.

Fix: make the region from the flush through `command.run` through the commit mutually exclusive for
mutating commands — a promise chain on the stack that each mutating `exec` awaits and extends — and
make `flushCommits` single-flight, returning the in-flight promise rather than starting a second
one. A deferring command must join the batch under the same lock. Then add the interleaved case to
Stage 2's tests: park a deferring command inside `run` the way origin.test.ts already does, run a
non-deferring one through, and assert the two commits' `--name-only` sets.

### 2. The idle timer has no owner, and outlives the stack it belongs to

Severity: **blocking**.

Stage 3 adds a timer to the stack (:342-350) and Stage 4 flushes on workspace switch (:353), but
nothing disposes of the timer. `switchWorkspace` drops the stack by assignment,
`stack = null` (apps/desktop/src/main/index.ts:321), and a pending `setTimeout` on the discarded
stack keeps running.

That is worse than a leak, because the committer holds a live reference rather than a snapshot:
`committer()` is `new Committer({ repos: () => ownedRepos })` (index.ts:468-470) over a module-level
array (index.ts:356) that `switchWorkspace` empties at :327 and `openRepos` refills with the new
project's repos at :329 and :376-380. A stale timer firing after the switch therefore commits into
the project the author just opened. The flush the plan puts before `stack = null` empties the batch,
so in the ordinary case the stale timer flushes nothing — but that is an accident of an empty array
rather than a decision, and it stops being true the moment a flush fails and the plan's own rule
keeps the batch pending (:260-262).

The same gap applies at quit: a timer created without `.unref()` holds the event loop open, and the
two `before-quit` handlers (index.ts:1102-1116) do not clear it.

Fix: give `CommandStack` a `dispose()` that cancels the timer and rejects further deferral, call it
from `switchWorkspace` after the flush and from the quit path, and have `flushCommits` cancel the
timer as its first act rather than relying on the batch being empty.

## Should-fix

### 3. `Vn-Seq` as a range is wrong whenever the batch's seqs are not contiguous

Severity: **should-fix**.

The plan writes `Vn-Seq: 41-70` and justifies dropping `Vn-Invocation` on the grounds that "each one
is already in `commands.jsonl` keyed by the seq the range points into" (:221-224), and the acceptance
criteria repeat it (:399-400). A batch's seqs are not contiguous:

- A non-mutating command between two deferring ones deliberately does not flush (:180-182) but does
  consume a seq — `const seq = ++this.seq` runs before anything else in `exec`
  (packages/commands/src/stack.ts:99), for every command whatever its kind.
- A deferring command whose `run` throws consumes a seq, takes the error path
  (stack.ts:138-149) and never joins the batch.
- `check` does not consume a seq, so a refused invocation is not a hole. Everything else is.

So `41-70` can name thirty records of which twenty-six are in the commit, and a reader following the
range lands on acts that are not there. The plan's recovery story runs in exactly that direction.

Fix: emit the seqs the batch actually holds. A comma-separated list is unreadable at thirty, so keep
the range as an approximation and make the count authoritative — or emit the list and cap it. Either
way, reconcile from `commitDeferred` in commands.jsonl rather than from the range alone, and say so
in the plan.

### 4. Changing `Vn-Seq`'s type in place is a silent break, and `Vn-Batch` does not save it

Severity: **should-fix**.

`Vn-Seq` is an integer today — `'Vn-Seq': String(record.seq)`
(packages/commands/src/commit.ts:48) — and two tests assert it as one
(packages/commands/src/tests/commit.test.ts:66, packages/git/src/tests/git.test.ts:120). The plan is
right that no production code reads the trailer, so nothing crashes. The problem is a reader who
parses `Vn-Seq` and only afterwards learns that `Vn-Batch` exists. "`Vn-Batch` is what a reader greps
for to know the range is a range" (:224-225) requires knowing to grep for it first.

Fix: leave `Vn-Seq` a single number — the last act's, which is the one the subject names — and put
the span in the new trailer, `Vn-Batch: 30 (41-70)`. Nothing then changes meaning, and the new
trailer is the only thing a reader has to learn.

### 5. The batched subject can truncate its own count away

Severity: **should-fix**.

The plan says the subject is "capped at `SUBJECT_MAX` by the existing `subject()` helper (commit.ts:32,
:39-43)" (:207-208). That helper cuts at 72 characters and appends an ellipsis
(packages/commands/src/commit.ts:42). Run `Set model on GenImage (and 29 more edits)` through it and
a long base eats the suffix: a 60-character message yields `Set … (and 29 mo…`, and a 72-character
one loses the count entirely. The count is the whole point of the batched subject.

Fix: build the suffix first, truncate the base to `SUBJECT_MAX - suffix.length`, then append, and do
not re-cap. State it in the plan, because an implementer reading :207-208 will write the wrong thing.

### 6. The `switchWorkspace` flush is placed after the three statements that make its failure path unreportable

Severity: **should-fix**.

Stage 4 says `switchWorkspace` "awaits `getStack().flushCommits()` before `stack = null`"
(:353), which is apps/desktop/src/main/index.ts:321. Three earlier statements in the same function
have already run:

- `notifications().suspend()` at :318, which sets `ready = false` and clears the pending queue
  (apps/desktop/src/main/notifications.ts:256-259).
- `workspaceRoot = opened.root` at :319, and the notification hub resolves its log path per post
  from that variable (`file: () => (workspaceRoot ? new ProjectPaths(workspaceRoot)… )`,
  index.ts:481).

So an `onCommitError` notification raised by that flush — the plan's whole answer to a lost batch,
:260-265 — is held by a suspended hub and then either dropped by the next `suspend()` or written into
the log of the project the author just opened, describing edits in the project they just left.
`openWorkspace` at :313 also runs first and can commit scaffolding (workspace.ts:102-108), which is
narrow-pathspec and harmless, but it means the flush is not the first git write of the switch either.

Fix: flush at the very top of `switchWorkspace`, before the lock acquisition at :304, while the old
root, the old repos and a live notification hub are all still in place.

### 7. The quit flush inherits a deadline chosen for a much smaller loss, and "joins that race" is under-specified

Severity: **should-fix**.

`QUIT_FLUSH_MS` is 2000 and the comment beside it states the tradeoff it was chosen for: "losing a
remembered panel width is a smaller failure than a quit that never lands"
(apps/desktop/src/main/index.ts:1098-1100). Losing thirty acts of provenance is not that failure, and
the plan reuses the constant without arguing for it (:176-177, :354-355).

The premise makes it worse. The plan's own motivation is that `git add -A` over a project holding a
populated `vngen/build/assets/` is slow (:26-29). The batches most worth saving are the ones on the
projects where the commit is slowest, so the quit flush is likeliest to miss its deadline exactly
where it matters.

"Joins that race" is also ambiguous in a way that decides the behaviour. The existing line is
`Promise.race([state.close().catch(() => {}), deadline])` (index.ts:1115). Adding the flush as a
third racer quits as soon as `state.close()` settles, which is typically immediate — the flush would
almost never complete. The intended shape is `Promise.race([Promise.all([state.close(), flush()]),
deadline])`.

Fix: say `Promise.all` inside the race explicitly, and give the commit flush its own longer deadline
constant rather than sharing the session store's.

### 8. On a machine without git the batch accumulates forever, contradicting the plan's own paragraph

Severity: **should-fix**.

The plan says: "A machine without git needs no new case: `ownedRepos` is only populated under
`gitHealth().ok` (index.ts:374-380), so the committer has no repos, `commitBatch` returns an empty
list, and nothing is ever pending" (:268-270).

The desktop wires a committer unconditionally — `committer: committer()` at
apps/desktop/src/main/index.ts:701, outside any `gitHealth()` branch — and the stack's own guard is
`if (!committer || !when) return []` (packages/commands/src/stack.ts:364). A committer object exists;
it just has an empty repo list. So on a git-less machine every deferring command joins the batch,
`commitBatch` returns `[]`, and the batch grows without bound while every record is written with
`commitDeferred: true`, asserting a commit that will never come.

This also exposes an undecided question the plan should have answered: `Committer.run` returns `[]`
both when there are no repos and when git had nothing to commit
(packages/commands/src/commit.ts:85-93, and `Git.commit` returns null on "nothing to commit",
packages/git/src/git.ts:196-204). The plan says to keep the batch on failure (:260-262) and says
nothing about an empty success. An implementer must guess whether `[]` clears the batch or keeps it,
and the two guesses give opposite behaviour here.

Fix: decide deferral on whether there is anything to commit into rather than on the committer's
existence — check the repo list, or add a `Committer.canCommit()` — and state that an empty result
clears the batch while a throw keeps it.

### 9. Batching commits does not batch undo, and the plan does not say so

Severity: **should-fix**.

Both commands that opt in are `undoable: true`
(apps/desktop/src/main/commands/gengraph.ts:414, :465). Thirty `setProp` invocations that became one
commit are still thirty undo points, each of which restores a tree and then commits it with `-A`
(packages/commands/src/stack.ts:333). Walking a drag back therefore writes up to thirty undo commits
reversing one batch commit, and the git log reads as one edit followed by thirty reversals.

That is defensible — undo is about acts and the commit is about the worktree — but it is a visible
consequence of the change, it makes the "one commit per drag" win look smaller from `git log`, and
it belongs in the plan and in Stage 6's doc text. The plan discusses undo only as a flush trigger.

### 10. The flushing command's own `gitDirty` is a stale read

Severity: **should-fix**.

The plan documents that `gitDirty` reads `true` for commands run while a batch is pending, and calls
it accurate "because it is also true: the worktree really is dirty" (:196-200). For the deferring
commands that is right. For the command that triggers the flush it is not: `gitState()` runs at
packages/commands/src/stack.ts:98, before the flush the plan inserts at :120, so the record says the
worktree was dirty when in fact the flush cleaned it before `run` ever started.

Fix: either recompute `gitState` after the flush for the flushing command, or narrow the plan's
sentence to say the flushing command's own `gitDirty` describes the moment before its flush.

### 11. Two docs the change falsifies are not in Stage 6's list

Severity: **should-fix**.

Stage 6 (:370-379) names a subsection of repos-and-commits.md, two spans of command-system.md, and a
CLAUDE.md bullet. Two more statements go false:

- docs/reference/repos-and-commits.md:234-235 — "The drift refusal gets stronger. A clean worktree
  becomes the norm, so a check that fails now means something really did change outside the app."
  A pending batch makes a dirty worktree normal again.
- packages/commands/src/command.ts:159-162 — the doc comment on `commits` enumerates exactly two
  reasons the field is absent ("a stack with no committer", "one that changed nothing"). The plan
  adds a third. Stage 6 updates the mirror of this block in command-system.md:207-226 but not the
  declaration itself.

The plan's own open question about commit.ts:8-11's invariant comment (:430-433) is the same class of
change and is correctly named; these two are the ones it missed.

## Notes

### 12. The flush triggers are, as far as I can find, exhaustive — and the plan should record the search

Severity: **note**.

I looked for a mutating write path that commits without going through `exec`. Every whole-worktree
commit in the app is one of:

- `Committer.run` (packages/commands/src/commit.ts:89), reached from stack.ts:131, stack.ts:333, and
  the open-time checkpoint at apps/desktop/src/main/index.ts:384. The plan covers all three.
- `initRepoAt` (apps/desktop/src/main/workspace.ts:198), which runs only for a directory that is not
  a repository yet, so no batch can be pending.
- `packages/testkit/src/project.ts:161`, which nothing may import.

The narrow-pathspec commits cannot sweep a batch: `commitScaffolding` names `.gitattributes`, the
layout files and `.gitignore` (workspace.ts:106-108), and `SessionState.commitThread` names the
thread log and its native sibling (apps/desktop/src/main/session.ts:1573-1577). The agent's
`git_commit` tool passes `paths` straight through
(packages/authoring/src/tools.ts:1822) and its description tells the model to send the message alone,
in which case `Git.commit` stages nothing (packages/git/src/git.ts:189) and returns null.

This is a real strength of the plan and it should be written into it, because the next reader will
otherwise redo the search.

One dead-but-registered path is worth naming: `handle('agent:run', …)` calls
`getSession().runAgent(input)` directly (index.ts:764-768), bypassing the stack entirely. The pathux
renderer does not use it — it goes through the `agent.run` command
(apps/desktop/renderer/pathux/agent.ts:102) — so it is not a hole today. It is a registered IPC
channel that writes files and would never flush, and it should either be removed or noted.

### 13. Every citation I checked is accurate

Severity: **note**.

I verified: stack.ts:26, :98, :131, :333, :339-341, :362-371; commit.ts:8-11, :32, :39-43, :85-93,
:89; command.ts:36-39, :81, :158-162; undo.ts:33-34, :84-99, :142-197; git.ts:164-169, :172-174,
:189; index.ts:299, :321, :327, :356, :374-380, :384, :468-470, :627-735, :684, :702-731, :707, :712,
:804-805, :1109-1116; graphs.ts:50-62 and :65-79 (the plan cites the two halves of the same conflict
check separately, and both spans are correct); document.ts:65, :103-111; gengraph.ts:54, :79, :405,
:458; commandlog.ts:25-45; transcript.ts:228-235; commit.test.ts:185, :215, :232, :245; nodes.ts:227,
:240, :273-277; repos-and-commits.md:84-90, :223-237; command-system.md:207-226, :265-278, :503-506,
:524-527, :529-531; gitUndoOptions.md §3. None misstated its target.

The two self-corrections in "The problem" (:31-49) are the plan's best pages. `gitState`'s
`git status --porcelain` really is the same whole-worktree scan class as `git add -A`
(git.ts:164-169 against :172-174), so Stage 0 measuring before Stage 5 changes anything is the right
call, and `commitsItself` really is set only by a test.

### 14. `CommandRecord.commits` has no production reader, and `commitDeferred` breaks nothing

Severity: **note**. Confirmed.

`commits` is declared at packages/commands/src/command.ts:162, written at stack.ts:132 and :334, and
read only at commit.test.ts:215, :232 and :245. `readCommandLog` parses each line and keeps it on a
numeric `seq` alone (apps/desktop/src/main/commandlog.ts:34-44); `renderAct` renders `seq`,
`invocation`, `status`, `error`, `message` and `written` (packages/agentreport/src/transcript.ts:228-235);
`onRecord` reads `stack`, `mutating`, `source`, `status`, `id`, `message` and `error`
(index.ts:702-731). Adding an optional field to a JSON line is invisible to all of them.

### 15. Undo's mechanism is genuinely untouched

Severity: **note**. Confirmed.

`UndoJournal.check` compares the worktree's `write-tree` against `treeOf(commit)` for the parked
snapshot (packages/commands/src/undo.ts:153-154) and never reads HEAD, so a pending batch cannot make
undo refuse. `capture` parks a `commit-tree` under `refs/vn/undo/<seq>/<label>` (undo.ts:89-94), and a
commit changes no file, so a flush between two captures cannot move a tree sha. The plan's finding 1
is right about the mechanism and right to treat undo's own `-A` commit (stack.ts:333) as the part
that needs a flush.

### 16. What it costs to undo

Severity: **note**.

Cheap to reverse: `defersCommit` on two definitions, `Committer.commitBatch`, the pending array and
the idle timer are all additive and deletable.

Stuck once shipped, and only the third is named in the plan:

- Commits already written with a batched subject and a `Vn-Batch` trailer cannot be re-split. A
  project's history permanently contains commits that describe thirty acts under one subject, and
  anything later built on per-act commits (a per-command blame view, a "what did this command
  change" query) has a gap over that period.
- `commitDeferred: true` lines in `vngen/state/commands.jsonl` are permanent, because the log is
  append-only (index.ts:707). The field's meaning is frozen at first ship, so it must be right the
  first time. Since finding 8 shows a git-less machine writing that field on every record, getting
  the guard wrong writes a permanent lie into every such project's log.
- A batch lost to a kill is swept into the next session's checkpoint under "Changes made outside the
  app" (index.ts:384). That attribution is unrecoverable. The plan names this at :277-283 and accepts
  it, which is the right call; the acceptance would read better with the first two consequences
  beside it.

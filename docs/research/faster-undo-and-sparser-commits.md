# Faster undo and sparser commits

<!-- toc -->

- [Recommendation](#recommendation)
- [1. The gap: commit batching exists, undo-capture batching does not](#1-the-gap-commit-batching-exists-undo-capture-batching-does-not)
  * [1.1 What runs today, unconditionally](#11-what-runs-today-unconditionally)
  * [1.2 What it costs, and why two different measurements agree](#12-what-it-costs-and-why-two-different-measurements-agree)
  * [1.3 The queueing consequence](#13-the-queueing-consequence)
- [2. Design A — batch undo-capture the way commit-on-save is already batched](#2-design-a--batch-undo-capture-the-way-commit-on-save-is-already-batched)
  * [2.1 Mechanism](#21-mechanism)
  * [2.2 What happens to `CommandRecord.undo` mid-batch](#22-what-happens-to-commandrecordundo-mid-batch)
  * [2.3 `undo()`/`redo()` must pick their candidate after the flush, not before](#23-undoredo-must-pick-their-candidate-after-the-flush-not-before)
  * [2.4 `canUndo()` during an open batch](#24-canundo-during-an-open-batch)
  * [2.5 Drift detection is unaffected, stated explicitly](#25-drift-detection-is-unaffected-stated-explicitly)
  * [2.6 Combined effect with the seeded scratch index](#26-combined-effect-with-the-seeded-scratch-index)
  * [2.7 API sketch](#27-api-sketch)
  * [2.8 Sizing](#28-sizing)
- [3. Design B — an in-memory versioning store, git committed sparsely](#3-design-b--an-in-memory-versioning-store-git-committed-sparsely)
  * [3.1 What it holds](#31-what-it-holds)
  * [3.2 Drift detection without a git process](#32-drift-detection-without-a-git-process)
  * [3.3 Crash durability](#33-crash-durability)
  * [3.4 Multi-repo](#34-multi-repo)
  * [3.5 Attribution: one commit per policy window](#35-attribution-one-commit-per-policy-window)
  * [3.6 The autocommit policy](#36-the-autocommit-policy)
  * [3.7 What the clean-worktree invariant gives up, and what it keeps](#37-what-the-clean-worktree-invariant-gives-up-and-what-it-keeps)
  * [3.8 Where it lives: in-process, argued from the code](#38-where-it-lives-in-process-argued-from-the-code)
  * [3.9 API sketch](#39-api-sketch)
  * [3.10 Sizing](#310-sizing)
- [4. What not to change](#4-what-not-to-change)
- [5. What would change the recommendation](#5-what-would-change-the-recommendation)
- [How the cost claims are grounded](#how-the-cost-claims-are-grounded)
- [Primary sources](#primary-sources)

<!-- tocstop -->

Design-only. No source file in this repository is changed by this report. It proposes two
additive changes to `@vn/commands`: batching the undo journal's snapshot captures the way
`Committer` already batches commits (Design A), and a faster in-memory snapshot store sitting
under the same journal API, with git itself committed on a coarser, separate cadence (Design B).
Both build directly on top of the "Stage 0" fixes in
[`git-library-vs-git-process.md`](git-library-vs-git-process.md) (seed the scratch index,
memoize the repo-invariant probes) rather than duplicating or contradicting them.

## Recommendation

Batch undo-capture first: extend `CommandStack`'s existing deferral machinery so
`capture('pre')` runs once at the start of a run of deferring commands and `capture('post')`
runs once when it flushes, instead of once per queued command — this is a day-scale change,
additive with the seeded-index fix, and removes the growth term entirely for the case that
motivated this report (a per-frame drag). Land it before anything else here. Second, replace
the undo journal's snapshot backend with an in-memory, content-addressed store scoped to the
same document set `UndoJournal` already snapshots, keep every disk write exactly as immediate
as it is today, and move git commits onto a slower, explicit policy (an interval, "commit now",
and the same hard triggers — undo, redo, workspace switch, quit — that already force a flush).
Keep both changes in-process inside `@vn/commands`: `vnauthor` never runs a `Committer` at all
(it declares `commitsItself: true` and commits once per approved plan — see
[`repos-and-commits.md`](../reference/repos-and-commits.md#who-does-not-commit)), so only the
desktop app has a live `CommandStack` today, and a service buys cross-host sharing nobody
needs at the cost of IPC latency on the hot path and crash-recovery complexity nobody has
designed for.

## 1. The gap: commit batching exists, undo-capture batching does not

### 1.1 What runs today, unconditionally

`CommandStack.runCommand` (`packages/commands/src/stack.ts:169-234`) runs, per mutating,
undoable command: a flush of any pending batch when the command does not itself defer
(`:173`), `gitState()` (`:176`), `capture(journal, seq, 'pre')` (`:195`), the command's own
`run` (`:198`), `capture(journal, seq, 'post')` (`:199`), and then either a deferred commit
(`:209-212`) or an immediate one (`:214-216`). `defers` gates the last step only — the branch
at `:209` sets `record.commitDeferred = true` and pushes onto `this.pending`, but the two
`capture` calls above it run identically whether or not `defers` is true. `command.defersCommit`
never reaches the `journal` variable at all (`:194`). This is stated as an invariant nowhere —
it is simply the order the function is written in — which is exactly the kind of gap this report
exists to close.

The two commands that declare `defersCommit: true`, `gengraph.setProp` and `gengraph.moveNodes`
([`repos-and-commits.md:124-126`](../reference/repos-and-commits.md#deferral)), are sent once
per frame from a drag or a slider (`apps/desktop/renderer/pathux/editors/nodes.ts:386-390`,
`void exec(command.id, command.props)` — fire-and-forget, with the local model already updated
optimistically by `weighed.decision.apply()` at `:367` before the IPC call resolves). Every one
of those frames still pays two full `capture` calls, even though thirty of them will collapse
into one deferred commit.

### 1.2 What it costs, and why two different measurements agree

`docs/plans/archive/deferring-commit-on-save.md`'s Stage 0 table (lines 429-437) measured the
journal's two `capture` calls at 566 ms per edit, mean over 20 edits, at 2000 committed assets
under `vngen/build/assets/` — 56% of a 1004 ms `exec`, 2.4 times what `Committer.commit` cost.
Its Stage 5 re-measurement (lines 599-608) shows that cost unmoved by commit-batching:
542.6 ms before, 550.4 ms after — because commit-batching removes spawns from the *commit*,
and capture never went through that path.

`git-library-vs-git-process.md` measured the same seven-spawn `capture()` sequence independently,
on a different machine and a different git version, and found it scales with the number of
*documents* under the snapshot pathspec: 388.4 ms at 200 documents, 574.1 ms in this monorepo,
1268.9 ms at 2000 documents (lines 230-236), because `withScratchIndex` starts from an empty
index file and `git add -A` against it re-hashes every file in the pathspec with no stat cache
to consult (lines 224-228). Seeding the scratch index from the real `.git/index` before staging
drops that to 214.3-218.9 ms regardless of document count (lines 244-249), producing a
byte-identical tree either way.

These two findings look contradictory — one says the cost is flat, the other says it grows —
and they are not. The deferral plan varied the number of files under `vngen/build`, which
`UNDO_PATHS` (`packages/commands/src/undo.ts:33-34`, `['.', ':(exclude)vngen/build',
':(exclude)vngen/state']`) excludes from the snapshot pathspec by construction, so that axis
was never inside the scan the scratch index has to build. The research doc varied document
count, which *is* inside the pathspec. Asset count under the excluded prefix genuinely does not
matter to `capture()`'s cost; document count under the included prefix does, until the scratch
index is seeded from a warm one. A drag that edits one graph pays the flat cost either way, but
a project with a large `wiki/` or many scenes pays the scaling one, and only the seeding fix
touches that term.

A quick benchmark run earlier in this investigation, replaying `capture('pre')`/`capture('post')`
back to back against a real project, measured 600-650 ms per pre+post pair — inside the
566-670 ms range the two source documents report independently on different machines and git
versions, which is the corroboration this report relies on rather than a third independent
measurement.

### 1.3 The queueing consequence

Every mutating command serializes on one chain: `command.mutating ? this.serialize(run) :
run()` (`stack.ts:158`). A drag that sends thirty frames in two seconds of pointer motion
queues thirty `runCommand` calls end to end on that chain, each one paying ~600 ms of capture
cost whether or not its commit defers. The drag itself does not block — the renderer already
moved on (`nodes.ts:367-368`) — but the chain does not drain until roughly eighteen seconds
after the pointer is released, and that chain is also what `undo()`, `redo()`, a workspace
switch and quit all wait on or flush (`stack.ts:372-376`, `dispose()` at `:476-480`). A fast
gesture leaves a long tail of queued subprocess work competing with exactly the operations an
author reaches for immediately after finishing an edit.

## 2. Design A — batch undo-capture the way commit-on-save is already batched

### 2.1 Mechanism

Extend the same `defers` flag `runCommand` already computes (`stack.ts:144-150`) to gate the
capture calls, not only the commit. `CommandStack` gains one field, the batch's pending pre
snapshot:

```ts
/** The pre-snapshot for the run of deferring commands currently pending, if any was taken. */
private batchPre: Snapshot | null = null;
```

`runCommand` captures `pre` once, on the first deferring command of a run, and skips `post`
entirely for a deferring command — the batch's post is captured once, at flush:

```ts
const journal = command.undoable && command.mutating ? this.opts.journal : undefined;
const pre = defers
  ? (this.batchPre ??= await this.capture(journal, seq, 'pre'))
  : await this.capture(journal, seq, 'pre');
...
if (defers) {
  record.commitDeferred = true;
  record.undoDeferred = true;
  this.pending.push(record);
  this.arm();
} else {
  const commits = await this.commit(command.mutating && !command.commitsItself, record);
  if (commits.length > 0) record.commits = commits;
}
```

`flush()` (`stack.ts:508-533`) gains the matching finalization, run before `commitBatch` so a
failed commit still leaves the batch's undo point resolvable from memory:

```ts
private async flush(): Promise<CommitResult[]> {
  this.cancel();
  if (this.flushing) return this.flushing;
  if (this.pending.length === 0) return Promise.resolve([]);
  const records = this.pending;
  this.pending = [];
  const pre = this.batchPre;
  this.batchPre = null;
  const journal = this.opts.journal;
  const last = journal && pre ? [...records].reverse().find((r) => r.mutating) : undefined;
  if (journal && pre && last) {
    const post = await this.capture(journal, last.seq, 'post');
    if (post) last.undo = journal.point(pre, post); // in-memory only — see §2.2
  }
  const run = (async () => { /* unchanged: commitBatch(records), retry-on-throw */ })();
  ...
}
```

The five flush triggers are unchanged — a non-deferring mutating command before it runs, `undo`,
`redo`, a workspace switch, and quit, plus the idle timer at `BATCH_IDLE_MS`
([`repos-and-commits.md:129-137`](../reference/repos-and-commits.md#deferral)) — because they
already exist to keep the git-commit half of the invariant true, and the same boundaries are
exactly where an undo-capture batch has to close too: the worktree cannot be legitimately dirty
in a way neither the commit nor the undo snapshot accounts for.

### 2.2 What happens to `CommandRecord.undo` mid-batch

Today every record gets `undo: journal.point(pre, post)` whenever both captures succeeded
(`stack.ts:207`) — one undo point per frame. Under Design A, only the last undoable record in a
batch carries the batch's `UndoPoint`; every earlier deferring record carries
`undoDeferred: true` and no `undo`, mirroring `commitDeferred`/absent `commits` on the commit
side (`packages/commands/src/command.ts:166-174`). This is a deliberate loss of per-frame undo
granularity, and it is a real behavior change worth stating plainly: `undo()` after a
multi-frame drag today reverses one frame per press
([`pressure-test-deferring-commit-on-save.md`, finding 9](pressure-test-deferring-commit-on-save.md#9-batching-commits-does-not-batch-undo-and-the-plan-does-not-say-so)),
even though the commit already collapsed to one. After this change, one press reverses the
whole drag, which finally matches what `git log` already shows — the asymmetry that pressure
test accepted as a known cost of the commit-only design is the thing this design closes.

The batch's `UndoPoint` is written to the *in-memory* `CommandRecord`, not re-emitted to
`vngen/state/commands.jsonl` — that record's on-disk line was already appended by
`this.record(record)` (`stack.ts:219`) at the moment it was created, and the log is append-only
(cited at `apps/desktop/src/main/index.ts:707` by both the deferral plan and its pressure test).
This is the same shape as the existing gap around `CommandRecord.commits`: the on-disk line for
a batched act never carries the sha that eventually committed it either, and the batch's git
history is recovered from `Vn-Batch`/`Vn-Seq` on the flush commit instead
([`repos-and-commits.md:142-159`](../reference/repos-and-commits.md#deferral)). Nothing today
reconstructs undo history from `commands.jsonl` after a restart — `CommandStack` is built fresh
per workspace open with an empty `records` array (`apps/desktop/src/main/index.ts:687`,
`stack.ts:83`), so undo/redo have always been scoped to the running session. Attaching the
batch's `undo` only in memory does not narrow that scope; it stays exactly what it already was.

### 2.3 `undo()`/`redo()` must pick their candidate after the flush, not before

This is the one place a straightforward read of "just gate the captures" is wrong, and it is
worth spelling out because it would ship broken otherwise. `undo()` today calls
`this.undoCandidate()` (`stack.ts:331`) *before* `this.move(...)`, and only `move` flushes
(`stack.ts:372-373`, "a pending batch has to land as its own commit before either of those
touches the deferred edits"). `undoCandidate()` (`stack.ts:295-305`) walks the record list
backward and returns the first mutating, `ok`, non-`undone` record that is not explicitly
filtered — it does *not* skip a record merely because `record.undo` is absent; that check
happens afterward, in `undo()` itself (`stack.ts:333-335`, `if (!target.undo) return { ok:
false, error: ... was not recorded as undoable }`).

Under Design A, the most recent record while a batch is open has no `.undo` yet — it is
computed at flush, which has not run. Pressing undo mid-batch with the mechanism as sketched in
§2.1 alone would select that record as the candidate and immediately refuse it as
"not recorded as undoable", which is a correctness regression from today's per-frame capture
(where `.undo` is always already present). The fix is to flush before selecting the candidate,
not only before restoring it, which means restructuring `undo()` and `redo()` around
`moveBody`'s existing shared body rather than around `move`'s pre-resolved target:

```ts
async undo(): Promise<CommandOutcome> {
  const journal = this.opts.journal;
  if (!journal) return { ok: false, error: NO_JOURNAL };
  return this.serialize(async () => {
    await this.flush();
    const target = this.undoCandidate();
    if (!target) return { ok: false, error: 'nothing to undo' };
    if (!target.undo) return { ok: false, error: `"${target.id}" was not recorded as undoable` };
    return this.moveBody({ target, kind: 'undo', point: target.undo, from: 'post', to: 'pre',
      done: () => this.undone.push(target) });
  });
}
```

`redo()` takes the same shape. This is a real refactor, not a one-line move — `move()` as
written today (`stack.ts:369-376`) is shared by both directions and takes an already-resolved
`Move`, so `redo()`'s own candidate selection (`this.undone[this.undone.length - 1]`,
`stack.ts:356`) needs the same reordering for the same reason: a redo target that was itself the
last record of an unflushed batch would otherwise be evaluated before its `undo` field exists.

### 2.4 `canUndo()` during an open batch

`undoState()` (`stack.ts:307-317`) calls `undoCandidate()` synchronously and does not flush —
it backs the UI's Undo button and its tooltip, and is polled far more often than an actual
undo is pressed. Under Design A, while a batch is open (up to `BATCH_IDLE_MS`, 1500 ms, after
the last deferring command), the most recent record has no `.undo`, so `undoable = Boolean(
this.opts.journal && undo?.undo)` (`stack.ts:310`) evaluates false and the button reports
disabled, even though an undo would in fact succeed once the pending batch flushed.

Today this window does not exist — capture runs per frame, so `.undo` is always live the
instant a command completes. This report accepts the regression rather than designs around it:
the window is bounded by construction (at most `BATCH_IDLE_MS`, and shorter whenever another
trigger flushes first), it applies only to the two highest-frequency commands this design exists
to make cheaper, and the alternative — having `undoState()` opportunistically flush and
recompute on every poll — reintroduces exactly the per-call capture cost this design removes,
which would make the UI affordance more expensive than the action it is checking. If the
momentary "not ready yet" state proves visible enough to matter, the cheap fix is cosmetic: a
distinct tooltip string while a batch is open, not a behavior change to `undoState()` itself.
That is left as an implementation-time UI decision, not a design decision this report needs to
make.

### 2.5 Drift detection is unaffected, stated explicitly

`UndoJournal.check` compares the current working tree's `write-tree` against `treeOf(commit)`
for the snapshot side being asked about (`undo.ts:140-166`) and never reads git status or HEAD.
Batching changes *when* `capture` runs, not what it compares against, and the worktree is
legitimately dirty between an act inside a batch and the batch's own flush by the same logic
that already governs commit batching
([`repos-and-commits.md:83-90`](../reference/repos-and-commits.md#the-invariant)): "everything
dirty" and "what this run did" stay the same set, because the run has not ended yet. `undo()`
and `redo()` already flush before touching the worktree
([`repos-and-commits.md:284-287`](../reference/repos-and-commits.md#how-undo-composes-with-it),
"a check that fails means something really did change outside the app — which is why `undo()`
and `redo()` flush a pending batch first rather than letting a deferred edit read as drift"), and
that sentence does not change: it is exactly what §2.3's reordering preserves, just applied one
step earlier, to candidate selection as well as to the restore.

### 2.6 Combined effect with the seeded scratch index

The two changes are additive along different axes and should be sized together rather than
separately. Batching reduces *how many times* `capture` runs across a run of N deferring
commands, from 2N to 2 (one pre, one post) regardless of N. Seeding the scratch index reduces
*the cost of each* capture that still runs, from the document-count-scaling figures in
§1.2 (388-1269 ms) to a flat ~214-219 ms
([`git-library-vs-git-process.md:244-249`](git-library-vs-git-process.md#the-scratch-index-re-hashes-every-document-every-snapshot)).

For a run of thirty frames — a plausible single drag — batching alone is the dominant term:
it turns roughly 30 × 600 ms ≈ 18 s of capture cost into one pair, ≈ 600 ms, an arithmetic
consequence of the mechanism rather than a new measurement. Seeding then shrinks that one
remaining pair further, to roughly 430-440 ms (two captures at ~215-220 ms each). Seeding
matters most on its own terms for the *unbatched* case — a single `story.moveLine` or any
command that is undoable but never defers still pays one pre/post pair per act, and that pair is
exactly what seeding was measured against. The two fixes should land in either order; neither
one's correctness depends on the other having shipped.

### 2.7 API sketch

No new public interface — `UndoJournalOptions`, `Snapshot` and `UndoPoint` (`undo.ts:23-62`)
are unchanged, since batching decides *when* `journal.capture`/`journal.point` are called, not
what they return. The additions are two private fields and one optional record flag:

```ts
// stack.ts, CommandStack private state
private batchPre: Snapshot | null = null;

// command.ts, CommandRecord
/** Set when this act's undo snapshot was folded into the batch's own pre/post pair. */
undoDeferred?: true;
```

### 2.8 Sizing

Comparable to Stage 2 of `deferring-commit-on-save.md` (the pending-batch stage) in shape and
smaller in surface area, since the commit-batching machinery this reuses (`arm`, `cancel`, the
five triggers, `flush`'s single-flight guard) already exists and needs no change. The new work
is: gating the two `capture` calls in `runCommand`, the finalization step in `flush`, and the
`undo()`/`redo()` reorder in §2.3, which is the part likeliest to need its own regression test —
a park-inside-`run` interleaving test in the shape of the one
[the pressure test asked for](pressure-test-deferring-commit-on-save.md#1-commandstackexec-is-not-serialized-so-flushing-before-commandrun-does-not-establish-what-the-plan-says-it-establishes)
for commit batching, but asserting that undo mid-batch flushes and then succeeds rather than
refusing. Call it two to three days: a day for the capture-gating and finalization, a day for
the `undo()`/`redo()` restructure and its tests, and a half day for `prune()`'s interaction —
fewer captures means fewer refs created in the first place, so `journal.prune()`
(`undo.ts:202-213`) has proportionally less to do, which is a free side effect worth measuring
rather than a change to design.

## 3. Design B — an in-memory versioning store, git committed sparsely

### 3.1 What it holds

In-memory, content-addressed snapshots of the exact document set `UndoJournal` snapshots
today — `UNDO_PATHS`, never `vngen/build` or `vngen/state` (`undo.ts:33-34`) — with structural
sharing between versions: a snapshot is a map from relative path to a content hash and a
reference to the buffer, and consecutive snapshots share every entry for a file that did not
change. Given that a project's document set runs to hundreds or low thousands of small text
files rather than millions, this needs no persistent-tree data structure; a shallow copy of the
top-level map per snapshot, replacing only the entries that changed, is the structural sharing
this design needs.

Disk writes stay exactly as immediate as they are today — `command.run()` already writes files
synchronously before `capture('post')` runs (`gengraph.ts:54,79` writes; `undo.ts` captures
after). This store is an *additional*, faster place undo history lives, not a replacement for
the write path, and it composes with Design A rather than replacing it: batching still decides
when a snapshot is taken; this section decides what taking one costs.

### 3.2 Drift detection without a git process

`UndoJournal.check`'s guarantee today is byte-exact: it re-runs `write-tree` over the current
worktree and compares the resulting tree hash against the snapshot's recorded one (`undo.ts:151-
152`), which is what lets its own doc comment promise "if the working copy is not where the
record says it left it, `check` refuses and says so rather than restoring over an edit nobody
asked it to discard" (`undo.ts:17-19`). Re-deriving that guarantee for every check without
spawning git means not re-reading and re-hashing every document on every check either, which is
the same cost class `write-tree` pays today.

The design: each snapshot entry records not just a content hash but the `mtime` and `size` git
itself observed when it was captured. A `check` first compares the live filesystem's `mtime`
and `size` for every path against the snapshot's recorded values. A path whose `mtime` and
`size` both still match is trusted without re-reading its bytes. A path where either differs is
re-read and re-hashed, and *that* hash is compared against the snapshot's recorded one — not
treated as an automatic refusal. This keeps the check's cost proportional to what changed, not
to the document count, and it keeps the final adjudication content-based rather than stat-based:
a file touched with identical content (same size, same bytes, new `mtime`) does not spuriously
refuse an undo the way a stat-only check would.

The guarantee that is actually lost is narrower than "byte-exact becomes probabilistic": it is
the pathological case of a file whose content changed while its size and `mtime` both stayed
identical to what was recorded, which requires either a deliberately adversarial rewrite or
filesystem timestamp resolution coarse enough to alias two writes within one tick. This is the
same edge case git's own index-based status cache already accepts and has for years — it is not
a new category of weakness this design introduces, and it is stated here as a plainly weaker
guarantee rather than elided, per the instruction to name what a plan-review pass would flag.
Where the fast path is ambiguous — a file whose `mtime` sits within the same tick as the last
write the store made — the design should treat it as suspicious and force the hash comparison,
the same defensive move git's own racily-clean handling makes.

### 3.3 Crash durability

This is the sharpest real cost of Design B, and it is a different shape of loss than it first
looks. Today, `capture()` writes an actual git commit object per snapshot — `commit-tree` plus
`update-ref` (`undo.ts:90-94`) — which is durable to git's object store the moment the call
returns. An in-memory store has nothing durable until something writes it out: a crash between
two captures does not just lose *metadata* about which snapshot paired with which, it loses the
*content* of every intermediate version, because nothing but git's object store was ever holding
those bytes. Only the most recent state is safe, because only the most recent state is what is
on disk as the actual document files.

Two options, and a recommendation. Accept the loss: on crash, undo history collapses to
whatever the last real git snapshot was — the last flush, or the open-time checkpoint
(`Committer.checkpoint`, called from `apps/desktop/src/main/index.ts:384`) — and the current
file content is never at risk, only the ability to step back through recent history. This is
comparable to what most editors' in-memory undo stacks already promise, and is defensible on
its own. Or: an append-only WAL beside `vngen/state/commands.jsonl`, reusing that file's
format and durability story — one line per changed document per snapshot, holding the new full
content (not a diff; documents in `UNDO_PATHS` are KB-sized text, not the assets under
`vngen/build` this store never touches, so a WAL of full content per change is cheap relative to
the git spawns it replaces, even though it duplicates the idea of git's own object store rather
than avoiding durable storage altogether).

Recommend the WAL. The loss Design B is trading away — durable intermediate undo history — is
exactly the property `refs/vn/undo/*` exists for today, and losing it silently on every crash
would be a regression nobody asked for in exchange for latency nobody would notice on the
snapshot path specifically (crash is rare; a drag frame is not). The WAL is replayed on next
open to reconstruct the in-memory store before the first command runs, the same way the checkpoint
commit already exists to absorb whatever happened while the app was closed.

### 3.4 Multi-repo

`UndoJournal` already takes a repo list, snapshots each independently, and keys `Snapshot.repos`
and `UndoPoint.repos` by root, with the first repo as primary so single-repo records stay
byte-identical to pre-multi-repo history (`undo.ts:23-29,44-46,52-62`). Design B mirrors this
exactly: one in-memory store per repo root, captured together — trivially "atomic" in-process,
since there is no subprocess race to worry about across repos the way there would be across
separate `git` invocations. `check`'s existing contract — inspect every repo before restoring
any, refuse as a unit, and report which roots did move on a partial failure
([`repos-and-commits.md:298-302`](../reference/repos-and-commits.md#multi-repo)) — carries over
unchanged, because that correctness property belongs to `UndoJournal`'s composition logic, not
to what backend each per-repo store uses underneath it.

### 3.5 Attribution: one commit per policy window

`commands.jsonl` is unaffected by any of this — it already records one line per act, independent
of git entirely (`stack.ts:219`, `apps/desktop/src/main/index.ts:707`). What changes is only how
densely git itself is asked to snapshot. The existing `Vn-Batch`/`Vn-Seq` trailer shape
(`commit.ts:88-100`, [`repos-and-commits.md:142-159`](../reference/repos-and-commits.md#deferral))
already generalizes to an arbitrary run: `seqRanges` hyphenates contiguous runs and leaves the
gaps a non-mutating or interleaved command left, and `trailersOfBatch` already lists distinct
`Vn-Command`/`Vn-Source` values rather than assuming one of each. A sparse autocommit widens the
run a `commitBatch` call covers from one gesture to one policy window — potentially many
distinct commands over several minutes — and needs no new trailer shape to say so, only a
caller willing to hand it a longer `records` array.

### 3.6 The autocommit policy

The two axes commit batching and undo-capture batching used to share — "defer this one act's
git work" — split apart once undo no longer needs git at all. Design A's `defersCommit` flag
stays meaningful for deciding whether one act's *disk write* joins a run; it says nothing about
how often git itself gets asked to snapshot, because Design B answers that with a policy that
sits above individual commands entirely rather than per-command.

Recommend a second, coarser policy layered on top of `CommandStack`'s existing flush, not a
replacement for it: `CommandStack` keeps flushing exactly as it does today (Design A's
triggers), but the flush no longer calls `Committer.commitBatch` directly — it hands the
finished `CommandRecord[]` to a `SparseCommitPolicy` that accumulates records across many
flushes and calls `commitBatch` on its own cadence:

- an interval timer, default a small number of minutes, resettable the way `BATCH_IDLE_MS`
  already is;
- an explicit "commit now" action. The original commit-batching plan declined this as a
  non-goal — "nothing new appears in a menu" (`deferring-commit-on-save.md`, Non-goals) —
  because at gesture scale there was nothing for an author to ask for that the idle timer did
  not already give them in 1.5 seconds. At policy-window scale (minutes), an author who is about
  to close the laptop or hand the project to someone else has a real reason to ask for a
  checkpoint sooner than the interval, which is exactly the scenario the original ask
  ("whenever the user asks") named. The non-goal no longer holds once the window is minutes
  rather than milliseconds, and this report reverses it deliberately rather than by omission;
- the four flush triggers that encode real invariants rather than mere batching convenience —
  `undo()`, `redo()`, a workspace switch, and quit — stay hard ceilings on the sparse policy too,
  forcing an immediate `commitBatch` rather than waiting for the interval. `undo`/`redo` commit
  their own restored tree with `-A` regardless of batching
  (`stack.ts:419`, [`repos-and-commits.md:277-279`](../reference/repos-and-commits.md#how-undo-composes-with-it)),
  and an undo or redo happens rarely enough per session that forcing an immediate commit there
  costs nothing worth avoiding, in exchange for giving the author's explicit "put this back" act
  its own precise commit boundary rather than folding it into an unrelated interval's window.
  Workspace switch and quit stay hard ceilings for the reasons `deferring-commit-on-save.md`
  already established them as triggers: a switch drops the repo array the committer holds a live
  reference to (`index.ts:327-329`), and quit is the last chance to write anything at all.

"A non-deferring mutating command, before it runs" — the trigger that keeps a fast gesture's
commit from swallowing an unrelated edit — drops out of the sparse policy's own trigger list,
because under this design nothing commits individually any more except the four hard ceilings
and the coarse interval; there is no narrower "this command doesn't defer" case left to flush
against once *every* mutating command's git work funnels into the same sparse buffer. It stays
relevant only as Design A's own trigger, one layer down, for deciding when an *undo-capture*
batch closes — which is a different question, now fully decoupled from how often git commits.

### 3.7 What the clean-worktree invariant gives up, and what it keeps

The invariant is stated in two places: "the app opens on a clean worktree, and every act ends
with one, except inside a run of acts that defer their commit"
([`repos-and-commits.md:85-90`](../reference/repos-and-commits.md#the-invariant)), and the same
idea justifies `-A` as the commit scope in `commit.ts:8-14`. Today the exception is bounded to
one run of consecutive `defersCommit` commands, closed within `BATCH_IDLE_MS` at the outside. A
sparse autocommit widens that exception to the whole policy window — potentially several
minutes, and spanning commands that never declared `defersCommit` at all, since under Design B
essentially every mutating command's git work is deferred to the sparse policy rather than only
the two gengraph ones. This is a materially larger version of the same exception, not a new
kind of exception, and the report states that explicitly rather than let it read as a small
extension of the existing one.

What survives unmodified: `journal.check`'s drift refusal, because Design B decouples it from
git commit state entirely (§3.2) — undo/redo correctness no longer depends on the worktree being
clean at any particular commit boundary, only on the in-memory store's own mtime/hash bookkeeping
being current, which it is by construction since every command's write updates it. This is a
genuine benefit of pairing the two designs rather than shipping Design B alone: a sparse commit
cadence would otherwise leave `journal.check`'s current git-based implementation asking a
question ("does the worktree match this commit's tree") that a long-dirty worktree answers
"no" to constantly, for reasons that have nothing to do with an author's edit conflicting with
anything.

What still needs the open-time checkpoint: `ensureRepo`/`openRepos`'s
`committer().checkpoint('Changes made outside the app')` (`index.ts:384`) stays the backstop for
exactly the case it already covers — a batch lost to a kill before its flush landed — and a
sparse policy only makes that window longer, not different in kind
([finding 4](../plans/archive/deferring-commit-on-save.md#findings-this-plan-rests-on) and its
pressure-test corroboration already establish that the checkpoint absorbs the bytes and loses
only the attribution). What breaks and has to be re-decided: any code that currently treats
`gitDirty` on a `CommandRecord` as rare, or that assumes a clean worktree is the norm between
unrelated acts — `repos-and-commits.md:284-285`'s own sentence ("a clean worktree is the norm
between acts of different kinds") is falsified by this design exactly as it was already falsified,
in miniature, by commit batching, and needs the same kind of rewording commit batching's own
Stage 6 gave it.

### 3.8 Where it lives: in-process, argued from the code

`vnauthor` never constructs a `Committer` at all — it avoids double-committing by running a
`CommandStack` with no committer wired, and commits once per approved plan through its own
mechanism, declaring `commitsItself: true` on the commands that need it
([`repos-and-commits.md:166-175`](../reference/repos-and-commits.md#who-does-not-commit),
`command.ts:78-81`). So today exactly one host — the desktop app — has a live `CommandStack`
with commit-on-save and undo wired, one `Committer` over one `ownedRepos` array
(`index.ts:356,687`). An out-of-process versioning service would exist to let two hosts share
one workspace's live history, and nobody needs that yet: opening the same project in `vnauthor`
and the desktop app simultaneously is not a supported scenario today, and it is a file-locking
problem before it is an undo-sharing problem — two processes writing the same documents with no
coordination is a correctness question this report does not have to answer because the premise
does not exist.

A service would also put the store's read/write path behind IPC, which is exactly the latency
this report is trying to remove from the hot path — every `capture` would gain a round trip
instead of losing a subprocess. And it adds a second thing to keep alive, crash-recover, and
version-skew against the app that talks to it, for a benefit (cross-host sharing) that has no
current consumer. Keep the store inside `@vn/commands`, alongside `UndoJournal` and `Committer`,
as a pluggable backend behind the same interface `UndoJournalOptions.git` already abstracts.

What would change this: `vnauthor` and the desktop app needing to run live against the same open
project at the same time. That is the scenario that would make cross-process sharing a real
requirement rather than a speculative one, and it is a bigger design question — file locking,
conflict handling between two live editors of the same documents — than this report's scope.

### 3.9 API sketch

`UndoJournalOptions.git: Git | Git[]` stays the shape callers see; the backend behind it becomes
pluggable rather than always a real `Git`:

```ts
/** What UndoJournal needs from a snapshot backend — real git, or the in-memory store. */
interface SnapshotBackend {
  isRepo(): Promise<boolean>;
  /** Content-addressed tree of the current worktree over `paths`. */
  writeTree(paths: string[]): Promise<string>;
  /** Move the worktree from tree `from` to tree `to`. */
  applyTree(from: string, to: string): Promise<void>;
  root: string;
}

/** In-memory store: structural-sharing snapshots plus an mtime/size drift cache. */
class MemorySnapshotStore implements SnapshotBackend {
  constructor(opts: { root: string; wal: AppendOnlyWal; paths: string[] });
  // capture()/check()/restore() reuse UndoJournal's existing pre/post/point vocabulary;
  // this class only replaces what backs writeTree/applyTree.
}

/** Buffers CommandRecords across CommandStack flushes and commits them on its own cadence. */
interface SparseCommitPolicy {
  /** Called from CommandStack.flush() instead of committer.commitBatch directly. */
  enqueue(records: CommandRecord[]): void;
  /** The four hard ceilings — undo, redo, workspace switch, quit. */
  forceCommit(): Promise<CommitResult[]>;
  /** "Commit now." */
  commitNow(): Promise<CommitResult[]>;
}
```

`MemorySnapshotStore` still returns real content-addressed hashes as its "tree" identifiers, so
`UndoPoint.pre`/`.post` and the `repos` map keep their existing shape and meaning — only the
string format changes from a git commit sha to whatever content-address scheme the store uses
internally, which is an implementation detail `UndoJournal`'s callers never inspect today.

### 3.10 Sizing

Larger than Design A and should follow it, not precede it — Design A alone removes most of the
per-frame cost this report exists to address, at a fraction of the risk. Design B's cost centers
on three genuinely hard pieces, each worth its own implementation stage: the `MemorySnapshotStore`
and its mtime/hash drift check (the correctness-sensitive core, and the one that most needs a
differential test against real git's `write-tree`/`read-tree` the way
[`git-library-vs-git-process.md`'s own recommendation](git-library-vs-git-process.md#5-the-recommendation-sized)
insists on for any change to this subsystem); the WAL and its replay-on-open path; and the
`SparseCommitPolicy` plus the `undo()`/`redo()`/switch/quit wiring that makes it a hard ceiling
rather than a suggestion. Call it two to three weeks across those three pieces plus the doc
updates §3.7 names, versus Design A's two to three days — which is the concrete argument for
landing Design A on its own first and re-evaluating whether Design B is still worth its cost
once the per-frame problem it was motivated by is already gone.

## 4. What not to change

- **Remotes, push, pull.** Out of scope, matching the existing scope of every git use in this
  codebase — there is no network git anywhere in `packages/git`, `apps/desktop/src/main`, or
  `packages/authoring/src`
  ([`git-library-vs-git-process.md:174-179`](git-library-vs-git-process.md#what-is-not-there)).
- **Conflict resolution.** Declined for the same reason `repos-and-commits.md` already declines
  it for layout templates — `-merge` plus author-driven `git checkout --ours`/`--theirs`
  ([`repos-and-commits.md:245-269`](../reference/repos-and-commits.md#the-one-thing-git-is-told-not-to-merge)) —
  and nothing here changes what merges or how.
- **Rewriting history.** `repos-and-commits.md:304-305` states it directly: "a user who wants a
  tidier log has `git rebase`; the app never rewrites what it wrote." A sparser autocommit does
  not change that — it changes how often a commit is made, never what an existing one contains.
- **CRDT or operational-merge semantics.** The original framing that motivated this report —
  "similar to a hybrid CRDT/git workflow" — is a red herring worth naming and declining
  explicitly. `commands.jsonl` already is the operation log, and most commands are not
  invertible: `pipeline.run` has no inverse, and undo works today by restoring a tree snapshot,
  not by replaying an inverse operation
  ([`repos-and-commits.md`, "Undo also works where commit-on-save
  refuses"](../reference/repos-and-commits.md#how-undo-composes-with-it), and `redo()`'s own doc
  comment, `stack.ts:346-352`, "a replay is a re-run... and it would produce a different result").
  Tree-snapshot undo is the right structure for what this codebase's commands are, not an
  operational one, and Design B is a faster *store* for that same snapshot design — not a
  different design.

## 5. What would change the recommendation

- **Seeding the scratch index cannot produce identical trees under `UNDO_PATHS`'s `:(exclude)`
  terms.** This is already flagged as unverified in `git-library-vs-git-process.md`'s own
  "Unverified items", and it is load-bearing for §2.6's sizing of the combined effect — if it
  fails, batching alone (Design A) still stands, but the residual per-capture cost stays at the
  document-count-scaling figures rather than the flat ~215-220 ms this report assumes for the
  combined case.
- **`vnauthor` and the desktop app need to run live against the same open project
  simultaneously.** The single strongest argument in §3.8 for keeping this in-process rather than
  as a service. If that scenario becomes real, it also needs a file-locking design independent
  of this report, and the versioning-store question should be revisited alongside it rather than
  solved first in isolation.
- **The mtime/size drift heuristic proves unreliable in practice** — a filesystem or workflow
  where the pathological same-size-same-mtime case is not rare (a sync tool, a backup restore
  that deliberately preserves timestamps). §3.2's fallback to full content hashing on any
  suspicious mismatch should catch the common cases; if it does not, the recommendation should
  fall back to hashing every path on every check, which removes most of Design B's win over
  `write-tree` and weakens the case for it independent of Design A.
- **An author reports losing meaningful undo history to a crash**, before the WAL in §3.3 ships.
  That would argue for landing the WAL in the same stage as the in-memory store rather than as a
  follow-up, rather than for abandoning the design.

## How the cost claims are grounded

Every cost figure in this report is one of: a number already published in
`docs/plans/archive/deferring-commit-on-save.md`'s Stage 0 and Re-measured tables (lines 429-457,
592-612), a number already published in `git-library-vs-git-process.md` (its scratch-index and
Stage 0 tables, lines 230-286), or arithmetic performed over those two sources and labeled as
such (§1.2's quick-benchmark corroboration, §2.6's combined-effect estimate). No new precise
timing was measured for this report; where a number could not be derived from the two sources
above, this report says "roughly" or names the estimate as arithmetic rather than presenting it
as measured.

## Primary sources

Repository: `packages/commands/src/stack.ts` ·
`packages/commands/src/undo.ts` · `packages/commands/src/commit.ts` ·
`packages/commands/src/command.ts` · `packages/git/src/git.ts` ·
`apps/desktop/renderer/pathux/editors/nodes.ts` · `apps/desktop/src/main/index.ts` ·
`apps/desktop/src/main/commands/gengraph.ts` ·
[`docs/reference/repos-and-commits.md`](../reference/repos-and-commits.md) ·
[`docs/reference/proseStyle.md`](../reference/proseStyle.md) ·
[`docs/research/git-library-vs-git-process.md`](git-library-vs-git-process.md) ·
[`docs/plans/archive/deferring-commit-on-save.md`](../plans/archive/deferring-commit-on-save.md) ·
[`docs/research/pressure-test-deferring-commit-on-save.md`](pressure-test-deferring-commit-on-save.md)

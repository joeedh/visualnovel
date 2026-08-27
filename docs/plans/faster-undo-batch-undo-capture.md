# Batching undo-capture

Status: **planned**

A run of consecutive commands that opted into commit deferral should pay one pair of undo
snapshots rather than one pair each. The batching lives in `@vn/commands` beside the deferral
machinery it reuses, and it is motivated by, and must be verified against, dragging a node in
the Gen Graph editor.

This is Design A of
[`../research/faster-undo-and-sparser-commits.md`](../research/faster-undo-and-sparser-commits.md).
Design B of that report — an in-memory snapshot store behind `UndoJournal` with git committed on
a sparse policy — is a separate, later plan and is not implemented, prepared for, or referenced
by anything here beyond this sentence.

## The problem

`CommandStack.runCommand` brackets every mutating, undoable command with two `UndoJournal`
captures (`packages/commands/src/stack.ts:195`, `:199`) and turns them into an `UndoPoint` on the
record (`:207`). The `defers` flag that `exec` computes (`:144-150`) gates the commit only: the
branch at `:209-216` chooses between joining the pending batch and committing immediately, and
nothing above it consults `defers`. `command.defersCommit` never reaches the `journal` variable
at `:194`.

The two commands that declare `defersCommit: true` are `gengraph.setProp`
(`apps/desktop/src/main/commands/gengraph.ts:416`) and `gengraph.moveNodes` (`:469`), and both
are `undoable: true` (`:414`, `:467`). Both are sent once per frame from a drag or a slider, and
the renderer dispatches them fire-and-forget with `void exec(...)`
(`apps/desktop/renderer/pathux/editors/nodes.ts`). So a thirty-frame gesture that collapses into
one commit still pays thirty capture pairs.

That pair costs 566 ms per edit, mean over 20 edits, which is 56% of a 1004 ms `exec` and 2.4
times what the commit costs
([`archive/deferring-commit-on-save.md#measured`](archive/deferring-commit-on-save.md#measured)).
Commit batching did not move it: 542.6 ms before, 550.4 ms after, in the same table's
re-measurement. Every mutating command runs on one serialization chain (`stack.ts:158`), so
thirty queued frames do not drain until roughly eighteen seconds after the pointer is released,
and that chain is what `undo()`, `redo()`, a workspace switch and quit all wait on.

## Findings this plan rests on

Each was checked against the working tree on `master` at the time of writing. Findings 6 to 9
came from attacking this plan's own first draft; see
[Self-critique](#self-critique-what-a-fresh-reviewer-would-attack) for the reasoning, and note
that findings 6 and 7 falsify sketches in the research report rather than merely extending them.

1. **The capture calls are unconditional, and nothing states that as an invariant.**
   `stack.ts:194-199` computes `journal` from `command.undoable && command.mutating` and captures
   `pre` before `command.run` and `post` after it, with no reference to `defers`. It is the order
   the function is written in rather than a decision anything documents.
2. **`UndoPoint` is derived, not stored.** `journal.point(pre, post)` (`undo.ts:106-125`) is a
   pure function of two `Snapshot`s. Nothing about it requires the two snapshots to bracket a
   single command, so widening the bracket to a run needs no change inside `UndoJournal` at all.
3. **Drift detection never reads HEAD or git status.** `UndoJournal.check` re-runs `write-tree`
   over the current worktree and compares it with `treeOf(commit)` for the side being asked about
   (`undo.ts:140-166`, the comparison at `:151-152`). It cannot be perturbed by when a commit
   happens, only by what is on disk.
4. **`CommandRecord.undo` has one production reader, and it is the stack itself.** It is declared
   at `command.ts:165`, written at `stack.ts:207`, and read at `stack.ts:300` (`undoCandidate`'s
   `changed` skip), `:310` (`undoState`), `:333` and `:357` (the two refusals) and `:337`/`:359`
   (the point handed to `move`). `readCommandLog` keeps a line on a numeric `seq` alone
   (`apps/desktop/src/main/commandlog.ts`), and `@vn/agentreport`'s `renderAct` never touches it.
   So the field's population rule is free to change; the risk is a silent lie in the log rather
   than a broken reader, which is what finding 5 and `undoDeferred` are for.
5. **Undo history is already session-scoped.** The desktop builds a `CommandStack` per workspace
   open with an empty `records` array (`stack.ts:83`), and nothing reconstructs undo state from
   `vngen/state/commands.jsonl`. Attaching a batch's `UndoPoint` to an in-memory record only,
   after its on-disk line was already appended by `this.record(record)` (`stack.ts:219`), narrows
   nothing that was not already narrow.
6. **"The last mutating record in the batch" is the wrong selector, and the codebase already
   holds a counterexample.** `CommandRecord` carries `mutating` but not `undoable`
   (`command.ts:139-180`), so the research report's sketch —
   `[...records].reverse().find((r) => r.mutating)` — can select a record whose command never had
   a journal. `demo.slow` in `packages/commands/src/tests/commit.test.ts:449-462` is exactly that
   command: `mutating: true`, `defersCommit: true`, no `undoable`. Under the sketch it would
   receive an `UndoPoint` bracketing writes it never declared undoable. The batch's point must be
   selected by the new `undoDeferred` flag, which is set only where `journal` was defined.
7. **`flush()`'s single-flight guard is order-sensitive, and awaiting a capture before it breaks
   it.** `flush` is deliberately a synchronous-entry method returning a promise: it cancels the
   timer, takes `this.pending`, builds the IIFE and assigns `this.flushing = run` with no `await`
   in between (`stack.ts:508-533`, the assignment at `:531`). The research report's sketch makes
   `flush` `async` and awaits `this.capture(...)` before that assignment, which lets a second
   caller entering during the capture see `this.flushing === null` and start a second flush — two
   `commitBatch` calls racing on the same `index.lock`, and two `post` captures. The capture must
   run inside the IIFE.
8. **The desktop samples `undoState()` only from `onRecord`.** The `command:ui` `undo` effect is
   broadcast from the `onRecord` hook (`apps/desktop/src/main/index.ts:740-744`), and the header
   binds the button's `disabled` and `description` to it
   (`apps/desktop/renderer/pathux/editors/header.ts:281-282`). Nothing polls. So a `canUndo:
   false` pushed on the last frame of a drag is not corrected when the batch flushes 1500 ms
   later — it stands until the next record is appended, which may be minutes. The research
   report's claim that the stale window is "bounded by construction" at `BATCH_IDLE_MS` (§2.4) is
   true of the stack and false of the app, and this plan fixes `undoState()` rather than accepting
   it.
9. **`prune` runs per command and has nothing to do for a deferring one.** `stack.ts:220` calls
   `this.prune(journal)` after every undoable mutating command, and `journal.prune`
   (`undo.ts:202-213`) costs `listRefs` plus a `deleteRef` per dropped seq — 73 ms over two
   subprocesses per edit in the Stage 0 table. A command that captured nothing created no ref, so
   pruning after it can only ever find the same set the previous prune found.

## Non-goals

- **Design B.** The in-memory snapshot store and the sparse commit policy are a separate plan,
  deferred until this one ships and is re-measured
  ([`../research/faster-undo-and-sparser-commits.md#3-design-b--an-in-memory-versioning-store-git-committed-sparsely`](../research/faster-undo-and-sparser-commits.md#3-design-b--an-in-memory-versioning-store-git-committed-sparsely)).
  Nothing here is shaped to make it easier or harder.
- **Making git itself faster.** No wasm build, no library binding, no change to `@vn/git`'s
  subprocess model. Declined at the top of the investigation this plan comes out of.
- **Seeding the scratch index.** Reducing what one capture costs is
  [`../research/git-library-vs-git-process.md`](../research/git-library-vs-git-process.md)'s
  change, on a different axis. The two are additive and neither's correctness depends on the
  other; this plan reduces how many captures run and says nothing about what each costs.
- **CRDT or operational-merge semantics.** Undo restores a tree rather than replaying an inverse,
  and most commands have no inverse. Named and declined in the research report's §4.
- **New flush triggers.** The five that exist
  ([`../reference/repos-and-commits.md#deferral`](../reference/repos-and-commits.md#deferral)) are
  exactly the boundaries an undo-capture batch has to close at, for the same reason they close a
  commit batch. None is added, removed or reordered.
- **Widening deferral to more commands.** `gengraph.setProp` and `gengraph.moveNodes` stay the
  only two that declare `defersCommit`. Whether prose typing should defer is the same open
  question the commit-batching plan left open, and this plan does not reopen it.
- **Per-frame undo granularity.** Losing it is the point, not a regression to be mitigated; see
  Decisions.
- **Rewriting `commands.jsonl` after the fact.** The log is append-only, so a batch's `UndoPoint`
  lives in memory only, exactly as `commits` already does for a batched commit.

## Design

### Gating the two captures

`runCommand` keeps computing `journal` as it does today and captures `pre` once per run of
deferring commands rather than once per command. `CommandStack` gains one field for it:

```ts
/** The pre-snapshot of the run of deferring commands currently pending, if one was taken. */
private batchPre: Snapshot | null = null;
```

In `runCommand`, replacing `stack.ts:195`:

```ts
const journal = command.undoable && command.mutating ? this.opts.journal : undefined;
let pre: Snapshot | null;
if (defers) {
  this.batchPre ??= await this.capture(journal, seq, 'pre');
  pre = this.batchPre;
} else {
  pre = await this.capture(journal, seq, 'pre');
}
```

The `??=` is written as a statement rather than folded into the expression because
`this.capture` returns `null` for an absent journal and for a failed one, and a `null` left in
the field must not be retried on every subsequent frame of the same batch. It is retried, and
that is deliberate: a capture that failed once because the repo was mid-`index.lock` should get
another chance on the next frame rather than disabling undo for the whole run. What must not
happen is a second *successful* capture overwriting the first, and `??=` prevents that.

`post` is skipped entirely for a deferring command, so the `try` block becomes:

```ts
const output = await command.run(props as never, ctx);
const post = defers ? null : await this.capture(journal, seq, 'post');
```

and the record's `undo` spread at `:207` is unchanged — with `post` null it contributes nothing,
which is what leaves the field absent on every record of a batch until the flush attaches it.

The `defers` branch at `:209-216` gains one line:

```ts
if (defers) {
  record.commitDeferred = true;
  if (journal) record.undoDeferred = true;
  this.pending.push(record);
  this.arm();
}
```

`if (journal)` rather than an unconditional set is finding 6: `undoDeferred` marks a record whose
snapshot was folded into the batch's pair, and a record that never had a journal has no snapshot
to fold. It is what the flush selects on and what `undoCandidate` skips on, so setting it too
widely is a correctness bug rather than a cosmetic one.

`prune` moves with the captures, per finding 9: `this.prune(journal)` at `:220` becomes
`if (!defers) this.prune(journal)`, and the flush prunes once for the batch it just captured
into.

### The flush's finalization

`flush()` keeps its synchronous entry, its `cancel()`, its `flushing` guard and its assignment
order exactly as they are (finding 7). The batch's `pre` is taken out of the field synchronously
alongside `this.pending`, and the capture happens inside the IIFE, before `commitBatch`:

```ts
private flush(): Promise<CommitResult[]> {
  this.cancel();
  if (this.flushing) return this.flushing;
  if (this.pending.length === 0) return Promise.resolve([]);
  const records = this.pending;
  this.pending = [];
  const pre = this.batchPre;
  this.batchPre = null;
  const run = (async () => {
    await this.close(records, pre);
    try {
      return (await this.opts.committer?.commitBatch(records)) ?? [];
    } catch (err) {
      // unchanged: restore the batch, log, report
    } finally {
      this.flushing = null;
    }
  })();
  this.flushing = run;
  return run;
}

/** Give the flushed run its one undo point, from the batch's `pre` and a `post` taken now. */
private async close(records: CommandRecord[], pre: Snapshot | null): Promise<void> {
  const journal = this.opts.journal;
  if (!journal || !pre) return;
  const last = [...records].reverse().find((r) => r.undoDeferred);
  if (!last) return;
  const post = await this.capture(journal, last.seq, 'post');
  if (post) last.undo = journal.point(pre, post);
  this.prune(journal);
}
```

Three things about that ordering are load-bearing.

**`close` runs before `commitBatch`, so a failed commit still leaves the run undoable.** The
batch's records are restored to `this.pending` on a throw and retried by the next flush, but the
undo point is already attached and stays attached; the retry finds `batchPre` null and `close`
returns immediately rather than attaching a second point over the first.

**The `post` capture is taken before the commit rather than after, and both would give the same
tree.** A commit moves a branch ref and the index and changes no file in the worktree
(`packages/commands/src/commit.ts:5-7`), so the choice is about failure behaviour rather than
about which tree is captured.

**`post` is labelled with the last record's `seq`.** The ref lands at
`refs/vn/undo/<lastSeq>/post` and pairs with `refs/vn/undo/<firstSeq>/pre`, so a batch's two refs
are under different seq directories. That is already true of nothing else, and `prune` copes
because it drops both labels of an old seq and a missing ref is not an error
(`undo.ts:209-210`); a `pre` whose seq is pruned before its `post` leaves an unusable point,
which is the same outcome pruning has always had for an old record.

### Which record carries the point

Only the last `undoDeferred` record of the flushed batch gets `.undo`. Every record of the batch,
including that one, carries `undoDeferred: true` on disk, exactly mirroring `commitDeferred` on
the commit side (`command.ts:173-174`): the flag says the capture was folded into the run's pair,
which is true of the last record as much as of the first. The difference between them is the
in-memory `.undo`, which was never on disk for anyone.

`CommandRecord` gains:

```ts
/** Set when this act's undo snapshots were folded into its batch's own pre/post pair. */
undoDeferred?: true;
```

The existing doc comment on `undo` (`command.ts:159-165`) enumerates what an absent field means
and gains this third case, the same way `commits`'s comment gained `commitDeferred`.

### Candidate selection

`undoCandidate()` walks backward and returns the first mutating, `ok`, non-`stack` record that is
not already undone, deliberately returning a record with no snapshots so undo can name it and
refuse rather than reach past it (`stack.ts:285-305`). Two changes.

**A folded record is walked past.** After a batch's last record has been undone, the record
before it in the same batch has no point of its own and never will — the point that covered it
has already been used. Returning it would refuse with "was not recorded as undoable" on the
second press of a two-press undo, where today the second press reverses the previous frame. The
walk gains, after the `changed` skip:

```ts
// A folded record's edit is inside its batch's point, which a later record carries. Once that
// point has been used, reaching past this record is reaching past nothing.
if (record.undoDeferred && !record.undo && !this.waiting(record)) continue;
```

**A record whose point has not been computed yet is not walked past.** `waiting(record)` is
`this.batchPre !== null && this.pending.includes(record)`: the batch is still open and this
record is in it, so a flush would give it a point. The backward walk reaches the newest such
record first, which is the one `close` will select, so the candidate the UI names before the
flush is the record the flush makes undoable. `pending` is at most a gesture long, so the
`includes` is a scan of tens of entries on a path that is already doing a linear walk.

The case this leaves: a batch whose captures all failed — no repo, or a git error every frame —
flushes with `batchPre` null, no record gets a point, and the whole run is walked past rather
than named and refused. That is a deliberate narrowing of the "name it and refuse" rule, on the
grounds that a capture failure is a property of the repo rather than of one frame, so every
record in the run lacks a point and naming an arbitrary frame of a drag communicates nothing the
older candidate does not communicate better.

### `undoState()` during an open batch

`undoState()` (`stack.ts:307-317`) is synchronous, must stay synchronous, and must not flush:
making it flush would reintroduce per-call capture cost on the affordance that exists to check
whether the action is available, which is worse than the cost this plan removes.

By finding 8 the app cannot absorb a stale `canUndo: false`, because it samples this only from
`onRecord` and the flush produces no record. So `undoState` reports what the flush would produce:

```ts
undoState(): UndoState {
  const undo = this.undoCandidate();
  const redo = this.undone[this.undone.length - 1] ?? null;
  const undoable = Boolean(this.opts.journal && undo && (undo.undo || this.waiting(undo)));
  ...
}
```

With that, the state pushed on the last frame of a drag is already correct — `canUndo: true`,
labelled with that frame's invocation — and stays correct after the flush attaches the real
point, so no re-broadcast is needed and the desktop is untouched by this plan. The alternative,
broadcasting a corrected `undo` effect from the flush, would need main to hold a hook the stack
does not have and would push a second effect per gesture for a value that did not change.

This is honest rather than optimistic in one specific sense: `waiting` is true only when
`batchPre` is non-null, which means a snapshot really was taken, so the only way the subsequent
undo can still fail is a `post` capture failing at flush or `check` finding drift — both of which
can equally happen to an unbatched record between `undoState()` and the button being pressed.

### `undo()` and `redo()` select after the flush

Today `undo()` picks its candidate at `stack.ts:331` and only then calls `move()`, which
serializes and flushes (`:369-376`). Under batching the newest record has no `.undo` until the
flush runs, so selecting first and flushing second refuses with `"gengraph.setProp" was not
recorded as undoable` on the first press after a drag — a correctness regression from today,
where `.undo` is always present the instant a command completes.

`move()` is deleted and its two callers take the shape it was factoring out, so that selection
happens inside the serialized region and after the flush:

```ts
async undo(): Promise<CommandOutcome> {
  const journal = this.opts.journal;
  if (!journal) return { ok: false, error: NO_JOURNAL };
  return this.serialize(async () => {
    await this.flush();
    const target = this.undoCandidate();
    if (!target) return { ok: false, error: 'nothing to undo' };
    if (!target.undo) {
      return { ok: false, error: `"${target.id}" was not recorded as undoable` };
    }
    return this.moveBody({
      target,
      kind: 'undo',
      point: target.undo,
      from: 'post',
      to: 'pre',
      done: () => this.undone.push(target),
    });
  });
}

async redo(): Promise<CommandOutcome> {
  const journal = this.opts.journal;
  if (!journal) return { ok: false, error: NO_JOURNAL };
  return this.serialize(async () => {
    await this.flush();
    const target = this.undone[this.undone.length - 1];
    if (!target?.undo) return { ok: false, error: 'nothing to redo' };
    return this.moveBody({
      target,
      kind: 'redo',
      point: target.undo,
      from: 'pre',
      to: 'post',
      done: () => void this.undone.pop(),
    });
  });
}
```

`redo()` needs the same treatment and not a weaker one. Its candidate is
`this.undone[this.undone.length - 1]` (`:356`), and a record enters `undone` only through
`undo()`'s own `done` callback, which by then holds a real point — so the reorder is not required
for `redo` to find a point. It is required because `redo` must not evaluate `target.undo` before
a flush that could change what is on disk under it, and because leaving the two methods in
different shapes would invite the next reader to restore the symmetry in the wrong direction.

The `Move` interface and `moveBody` are unchanged. The flush moves from `move()` into each
caller, so the number of flushes per undo is unchanged at one, and the two comments `move()`
carried about why a restore must flush first move with it.

Two properties this preserves. The whole sequence still runs inside `this.serialize`, so an undo
cannot interleave with a mutating command (`stack.ts:158`), which is what makes "flush, then
select" observe a stable record list. And the flush still happens before `journal.check` reads
the worktree, so a deferred edit still cannot read as drift — the sentence at
[`../reference/repos-and-commits.md#how-undo-composes-with-it`](../reference/repos-and-commits.md#how-undo-composes-with-it)
stays true, applied one step earlier.

### Drift detection is unaffected in mechanism, only in timing

`journal.check` compares `write-tree` over the current worktree against `treeOf(commit)` for the
side asked about and never reads git status or HEAD (finding 3). Batching changes when `capture`
runs and not what `check` compares, so the guarantee is the same one.

The timing change is that a batch's `pre` describes the worktree before the first frame rather
than before the last, and its `post` describes it at the flush. Between them the worktree is
legitimately dirty, which is the same widening the clean-worktree invariant already took for
commit batching: within a run, "everything dirty" and "what the run did" are the same set
([`../reference/repos-and-commits.md#the-invariant`](../reference/repos-and-commits.md#the-invariant)).
Undo and redo flush before they check, so no `check` ever runs against a half-open batch.

### `journal.prune()`

Fewer captures create fewer refs, so `prune` has proportionally less to reclaim: a thirty-frame
drag creates two refs where it created sixty. Combined with finding 9's move of the call itself,
a deferring frame stops paying `prune`'s two subprocesses entirely and the batch pays them once.
`DEFAULT_KEEP` (50, `undo.ts:64`) is unchanged, and it now bounds fifty *acts* where a drag used
to consume thirty of them, so a session's reachable undo history gets longer rather than shorter.
This is a consequence of the mechanism, and no part of the design depends on it.

## Self-critique: what a fresh reviewer would attack

Per [`../reference/conventions.md`](../reference/conventions.md), this plan is handed to a
fresh-context agent before the work starts. What follows is this author's own attack on the
draft, in the shape
[`../research/pressure-test-deferring-commit-on-save.md`](../research/pressure-test-deferring-commit-on-save.md)
took against the commit-batching plan, so the review can start past these rather than at them.
Findings 6 to 9 above came out of it; the four below are the objections that did not change the
design, recorded with the reason.

**"Is `exec` actually serialized against `undo()`/`redo()`, or is that assumed?"** It is, and by
one chain rather than two. `exec` routes every mutating command through `this.serialize(run)`
(`stack.ts:158`), `undo()` and `redo()` reach `serialize` through `move()` today and directly
under this plan, and `serialize` extends one `this.chain` field (`:448-455`). That is the
serialization pressure-test finding 1 asked for and Stage 2 of the commit-batching plan shipped.
Non-mutating commands stay off the chain, and none of them touches `pending`, `batchPre` or
`records`. The one path that flushes off-chain is `dispose()`, which the archived plan documents
as safe because its only caller already holds the chain
([`archive/deferring-commit-on-save.md`](archive/deferring-commit-on-save.md), Stage 4); this plan
adds an `await this.capture(...)` inside that flush, which lengthens that off-chain window but
does not widen what it touches — `dispose()` is reached from inside a mutating command, so no
other mutating command can start during it.

**"Does `undoState()` become expensive now that it consults `pending`?"** `waiting()` is a null
check plus an `Array.prototype.includes` over the pending batch, on a method that already walks
`records` backward. `pending` is bounded by one gesture, and the walk it sits inside is bounded
by the same `records` array it always was. Nothing async is introduced, no capture is taken, and
the method stays callable from a synchronous IPC handler. The alternative that would have been
expensive — flushing opportunistically on every poll — is rejected in the design above.

**"Does a batch mixing commands with different `undoable`/`mutating` flags pick the right last
record?"** This is finding 6, and the first draft got it wrong by copying the research report's
`find((r) => r.mutating)`. Selecting on `undoDeferred` answers it: a batch can only hold mutating
records (`defers` requires `command.mutating`, `stack.ts:144-150`), and among them only the ones
that had a journal are flagged, so a `demo.slow`-shaped command — mutating, deferring, not
undoable — is passed over and the point lands on the newest record that actually declared itself
undoable. The test named in Stage 2 is built from exactly that mixture.

**"What if a deferring command throws mid-batch?"** It takes the error path at `stack.ts:222-233`,
never joins `pending`, and never gets `undoDeferred`. Its writes, if any, are on disk and fall
inside the batch's pre/post bracket, so undoing the run reverses them too. That is what already
happens to its commit — the same writes land in the batch's commit under another act's subject —
so this plan makes undo agree with the commit rather than introducing a new asymmetry.

**"What does it cost to undo this change?"** The gating, the field, `close` and the `prune` move
are additive and deletable. Two things are not cheap to reverse. `undoDeferred: true` lines in
`vngen/state/commands.jsonl` are permanent, because the log is append-only, so the flag's meaning
is frozen at first ship and finding 6's rule has to be right the first time — which is why it is
stated as a rule about `journal` rather than about `mutating`. And the `undo()`/`redo()`
restructure changes the shape of two public methods; reverting it means reinstating `move()`,
which is mechanical but touches the paths a drift refusal travels.

**"Is the granularity loss really acceptable?"** One press now reverses a whole drag instead of
one frame. This is the asymmetry pressure-test finding 9 named and accepted as a known cost of
batching only the commit: thirty acts folded into one commit that took thirty presses to reverse,
so `git log` and Ctrl+Z disagreed about what one edit was. Closing it is the intent. It is also
not a new kind of coarseness — the same edit already produces one commit, and the renderer
already coalesces a pointer drag into one command per finished gesture in the path.ux node view
rather than one per pointer move.

## Stages

Each stage lands green under `pnpm check && pnpm test && pnpm lint` on its own, and each is one
commit.

### Stage 0 — measure (half a day)

No production code changes. Rebuild the Stage 0 harness from
[`archive/deferring-commit-on-save.md#measured`](archive/deferring-commit-on-save.md#measured) in
the scratchpad (not committed): a temp project of 20 scenes, a default `portrait` slot graph and
N committed assets under `vngen/build/assets/`, running the real `gengraphSetProp` through a real
`CommandStack` with a real `UndoJournal` on `UNDO_PATHS` and a real `Committer`. One warm-up
edit, then 30 timed edits, the run ending in `dispose()` so the batch's own captures and commit
are charged to the run that deferred them.

Time, per edit: `exec` end to end, `gitState()`, the journal's captures, `Committer.commit`,
`journal.prune`, and git subprocess count. Record them in this file under a "Measured" heading.

The stage exists because the two numbers this plan quotes were measured on two machines for two
other documents, and the arithmetic in the research report's §2.6 (thirty pairs becoming one) is
a prediction rather than a measurement. If the capture cost has moved since — a git version, a
faster disk — the plan's claim is corrected here rather than after the fact.

### Stage 1 — the selection reorder, as a no-op refactor (half a day)

`CommandRecord.undoDeferred` on the type, `waiting()` on the stack, the `undoCandidate` skip, the
`undoState` clause, and `undo()`/`redo()` restructured to flush before selecting, with `move()`
deleted.

Nothing sets `undoDeferred` yet and `batchPre` does not exist yet, so `waiting()` is always false
and both new branches are unreachable: shipped behaviour is unchanged and every existing test in
`stack.test.ts` and `commit.test.ts` stays green as written. That is the point of landing it
alone — the restructure is the risky part of this plan, and it is verified against today's
semantics before anything changes what it operates on.

Tests, in `packages/commands/src/tests/stack.test.ts` beside the existing undo cases:

- `undo()` with a batch pending still flushes before it restores, asserted through the flush
  commit existing before the undo's own — the existing case, re-asserted after the reorder.
- `undo()` refuses a mutating, non-undoable most-recent record by name, unchanged.
- `redo()` after an `undo()` restores the same point it did before.
- A stack with no journal refuses both with `NO_JOURNAL`, before any flush is attempted — the
  guard stays outside `serialize`, so a journal-less stack does not queue on the chain to be told
  undo is unavailable.

### Stage 2 — batch the captures (one day)

The `batchPre` field, the gating in `runCommand`, the `undoDeferred` set, the `prune` move, and
`flush`'s `close` step. This is where behaviour changes.

Tests, in `packages/commands/src/tests/commit.test.ts` over the existing `batchSetup` helper
(`:422-495`), which already registers a deferring undoable command, a deferring non-undoable one
(`demo.slow`) and a fake timer:

- Three `demo.defer` invocations with `journal: true` produce exactly two `refs/vn/undo` refs
  after the idle timer fires, not six, and the last record carries an `undo` whose `pre` is the
  tree before the first act and whose `post` is the tree after the third.
- Each of the three records carries `undoDeferred: true`; the first two carry no `undo`.
- **Finding 6's test.** A batch of `demo.defer`, `demo.slow`, `demo.defer`, `demo.slow` — the two
  `slow` invocations released before the flush — attaches the point to the *third* record, the
  last one that declared itself undoable, and leaves both `demo.slow` records without `undo` and
  without `undoDeferred`.
- Undoing that batch restores the worktree to before the first act, so all four files are gone in
  one press, and a second press reaches the act before the batch rather than refusing.
- `undoState().canUndo` is true immediately after the third deferring command, before any flush,
  and its `undoLabel` names that command; it is still true after the flush.
- A stack with a committer and no journal defers commits, sets `commitDeferred`, sets no
  `undoDeferred`, and captures nothing.
- A flush whose `commitBatch` throws still leaves the last record undoable, and the retrying
  flush does not attach a second point.
- **The interleaving test.** Park a `demo.slow` inside `run` with the existing `latch`, and while
  it is held, call `stack.undo()` from the test. Release the gate. Assert that the undo does not
  refuse with "was not recorded as undoable", that exactly one flush commit landed, and that the
  restored worktree is the one before the batch's first act. Without Stage 1's reorder this test
  fails while every sequential test above passes, which is why it is written this way rather than
  as a sequence of awaits. This is the shape
  [pressure-test finding 1](../research/pressure-test-deferring-commit-on-save.md#1-commandstackexec-is-not-serialized-so-flushing-before-commandrun-does-not-establish-what-the-plan-says-it-establishes)
  asked for on the commit side, asserting undo rather than commit contents.
- **Finding 7's test.** Two `flushCommits()` calls started in the same tick, with a journal wired,
  produce one flush commit and one `post` capture, not two. Written by counting refs under
  `refs/vn/undo` rather than by instrumenting the stack, so it fails against the research
  report's `async flush` sketch.

### Stage 3 — verify and re-measure (half a day)

No production code changes beyond what a defect found here demands.

Re-run Stage 0's harness against the shipped change and record the delta in this file under
"Re-measured", beside Stage 0's table.

Over CDP against a real project: drag a node, wait out `BATCH_IDLE_MS`, and confirm that the
Undo button is enabled and its tooltip names the drag throughout; press it once and confirm the
whole drag is reversed in one press and that `git log` shows one batch commit followed by one
undo commit. Then repeat with the drag followed immediately by a `story.*` edit, and confirm the
flush commit and the story commit name disjoint file sets, as
[`archive/deferring-commit-on-save.md`](archive/deferring-commit-on-save.md)'s Stage 5 check
already establishes for commits alone.

### Stage 4 — docs (half a day)

- [`../reference/repos-and-commits.md`](../reference/repos-and-commits.md) — the "Deferral"
  section states that a deferring run costs one undo point as well as one commit, and "How undo
  composes with it" gains the flush-before-selection ordering. The five flush triggers are
  unchanged and stay stated once.
- [`../reference/command-system.md`](../reference/command-system.md) — `undoDeferred` in the
  `CommandRecord` block beside `commitDeferred`, and the undo section's description of one point
  per act amended to one point per act or per deferring run.
- `packages/commands/src/command.ts` — the doc comment on `undo` gains the folded-into-a-batch
  case, the way `commits`'s comment already carries `commitDeferred`.
- `packages/commands/src/stack.ts` — the file's own header comment says an undoable command "is
  bracketed by two captures"; it gains the run.
- `CLAUDE.md` — the deferral clause under "Command system" names undo alongside the commit.
- This file's status flips to shipped, its row in
  [`faster-undo-and-sparser-commits-tasklist.md`](faster-undo-and-sparser-commits-tasklist.md)
  and in [`index.md`](index.md) flips with it, and the file is `git mv`ed into `archive/` with
  every link to it updated in the same change.

## Decisions

| Decision | Alternative it beat | Why |
| --- | --- | --- |
| Gate the captures on the existing `defers` flag | A separate `defersUndo` opt-in | Two flags would let a command batch its commit and not its captures, and nothing wants that: the five flush triggers exist because those are the boundaries where a dirty worktree stops being attributable, which is the same reason a capture batch must close there. |
| One point per batch, on the last `undoDeferred` record | One point per record, computed at flush from adjacent snapshots | There are no adjacent snapshots — the whole change is that they were not taken. Synthesising per-frame points would mean capturing per frame. |
| Select on `undoDeferred` | Select on `mutating`, as the research report sketched | `CommandRecord` has no `undoable`, and a mutating deferring command need not be undoable (`demo.slow`, `commit.test.ts:449-462`). Finding 6. |
| `undoDeferred` on every record of the batch, including the one that gets the point | Only on the records that get no point | The flag describes how the snapshot was taken, which is true of all of them, and it is written to `commands.jsonl` at exec time — before the flush knows which record wins. Setting it later would mean rewriting an append-only log. |
| Capture `post` inside `flush`'s IIFE, after `this.flushing` is assigned | An `async flush` awaiting the capture first, as the research report sketched | The assignment is the single-flight guard; awaiting before it lets a second caller start a second flush, double-capturing and racing `index.lock`. Finding 7. |
| `close` before `commitBatch` | After it, or inside the success path | A commit changes no worktree file, so both give the same tree; running first means a failed commit still leaves the run undoable, and the retry finds `batchPre` cleared and does not attach a second point. |
| `undoState()` reports a pending batch as undoable | Accept a stale "cannot undo" bounded by `BATCH_IDLE_MS` | The desktop samples `undoState()` only from `onRecord` and the flush emits no record, so the stale state is not bounded by the timer at all — it stands until the next command. Finding 8. |
| Fix it in `undoState()` | Broadcast a corrected `undo` effect from the flush | The stack has no hook to broadcast from, main would need one, and it would push a second effect per gesture carrying a value that did not change. |
| `undoState()` never flushes | Flush opportunistically on each call | It is polled far more often than undo is pressed; flushing there would put the capture cost back on the affordance that exists to check whether the action is worth taking. |
| Walk past a folded record with no point | Name it and refuse, as an unbracketed record is | Its edit is inside a point a later record carries. Once that point is used, the record stands for nothing, and refusing on the second press of a two-press undo would be a worse regression than the one this plan removes. |
| Delete `move()` and inline it into both callers | Give `move()` a callback that selects the target after the flush | A callback that runs inside `move` to produce the `Move` that `move` was given is a shape nobody reads twice. Both callers are eight lines. |
| Keep `post`'s ref under the last record's seq | A new ref layout for batches | `prune` already handles a missing label, and inventing a layout for one case would make `refs/vn/undo` mean two things. |
| Skip `prune` for a deferring command | Leave it per command | A command that captured nothing created no ref, so its prune can only find what the last one found. Finding 9. |
| Retry a failed `pre` capture on the next frame of the same batch | Take one attempt per batch | A capture fails on a transient lock as easily as on a missing repo, and disabling undo for a whole gesture over one transient failure is a worse answer than one extra attempt. |

## Acceptance criteria

- Thirty consecutive `gengraph.setProp` invocations produce exactly two `refs/vn/undo` refs and
  exactly one undo point, on the last of the thirty records.
- Every one of those records carries `undoDeferred: true` in `commands.jsonl`, and none carries
  `undo`.
- One press of Undo after that drag reverses the whole drag; a second press reaches the act
  before it rather than refusing.
- `undoState().canUndo` is true from the moment the last deferring command completes, before the
  batch has flushed, and its label names that command.
- `undo()` pressed while a batch is open flushes, selects, and succeeds, rather than refusing with
  "was not recorded as undoable".
- A batch mixing undoable and non-undoable deferring commands attaches its point to the last
  undoable one and flags no non-undoable one.
- A flush whose commit throws still leaves the batch's undo point attached, and the retry attaches
  no second point.
- Two flushes started in the same tick produce one commit and one `post` capture.
- A stack with no journal is unchanged in every respect, including refusing undo before it
  queues on the chain.
- Undo's own commit still contains the restored tree and nothing deferred, and `journal.check`
  still refuses on a real outside edit.
- Stage 0's measurement is recorded in this file, and Stage 3's re-measurement beside it.
- `pnpm check && pnpm test && pnpm lint` green at every stage.

## Open questions

- **Should `DEFAULT_KEEP` come down?** Fifty acts now means fifty authorial acts rather than fifty
  frames, so the reachable history is longer and the ref namespace smaller. Whether fifty is still
  the right number is not answered here, and nothing in this plan depends on it.
- **Should a `pre` capture that fails on every frame of a run be surfaced?** Today a failed
  capture logs a warning through `context.log` (`stack.ts:439`) and the record silently has no
  point. Under batching one warning stands for a whole gesture rather than for one frame, which is
  strictly less noise for the same information. Whether an author should be told that undo is
  unavailable at all is a question about the affordance rather than about batching.
- **Does the agent's tool loop want batching too?** Its mutating commands touch different files
  and arrive back to back, which is the case the serialization chain costs most
  ([`archive/deferring-commit-on-save.md`](archive/deferring-commit-on-save.md), open questions).
  Nothing there declares `defersCommit`, so it is unaffected, and widening deferral is a non-goal
  above.

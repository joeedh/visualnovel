# Undo checkpoints: grouping several commands into one undo point

Status: **planned**

## What this builds

A way to run several `@vn/commands` invocations as one undo point. Today every undoable,
mutating command gets its own content-addressed snapshot pair (`pre`/`post`) and its own
entry in the undo stack (`packages/commands/src/stack.ts`, `seq` incremented once per
command). Duplicating or deleting three selected nodes in the Gen Graph editor dispatches
three separate `gengraph.*` commands, so undoing that one gesture today takes three
presses of Ctrl+Z, each restoring one node at a time.

This plan adds `CommandStack.beginCheckpoint(shortLabel, message, scope)` /
`CommandStack.endCheckpoint(handle)`, threads a `CheckpointHandle` through `exec()`/
`execDsl()`, and wires `apps/desktop`'s IPC and renderer bridge so a renderer-side caller
(starting with `GenGraphEditor`) can open one, run several commands into it, and close it
as a single undo/redo entry — with automatic rollback to the checkpoint's start if any
command inside it fails.

Alongside that, it extends `vendor/path.ux`'s `NodeGraphDelegate.undoStepBegin`/
`undoStepEnd` (added in the socket-highlight/undo-grouping commit this plan follows on
from) to carry the same two strings, so `NodeGraphView.deleteSelected()`/
`duplicateSelected()` can hand a host delegate text to open a checkpoint with, instead of
the host having to invent its own.

Scoped to `packages/commands`, `apps/desktop` (main, shared, and the renderer's
`pathux/editors/nodes.ts` and `pathux/bridge.ts`), and `vendor/path.ux`'s node-editor
files. It does not touch commit-on-save granularity, `@vn/testkit`, the CLI, or
`packages/authoring` — see [Not in scope](#not-in-scope).

## Why

Raised while fixing `GenGraphEditor` after the path.ux commit that added
`NodeGraphDelegate.undoStepBegin`/`undoStepEnd` (for path.ux's own generic
`ToolOpDelegate` to batch its `ToolMacro` calls). `GenGraphEditor` doesn't use that
toolstack at all — it dispatches `gengraph.*` commands directly — so those two methods
were left as no-ops there. That means `duplicateSelected()`/`deleteSelected()` on several
nodes at once already work (each dispatches its own command), but produce one undo point
per node rather than one for the whole gesture, which is what this plan fixes.

## What changes

### 1. `packages/commands/src/stack.ts`: the checkpoint itself

```ts
export interface CheckpointHandle {
  readonly seq: number;
}
```

Deliberately just `{ seq: number }` — no methods, no closed-over state — so it survives a
JSON round-trip over IPC unchanged; the renderer holds the same shape the main process
does.

**Naming.** `packages/commands/src/commit.ts:145`'s pre-existing `Committer.checkpoint(reason)`
— the open-time sweep commit under a `Vn-Checkpoint: true` trailer
(`docs/reference/repos-and-commits.md:93-96`) — is unrelated to undo grouping and shares
only the English word. This plan renames it to `Committer.sweep(reason)` and its trailer to
`Vn-Sweep: true`. The third review pass found the full site list is longer than first
written down; every one of these needs the rename, confirmed by grepping `checkpoint`
case-insensitively across the affected files:

- `packages/commands/src/commit.ts:145` (the method itself), `:146` (the fallback commit
  subject string `'Checkpoint'` passed to `subject(reason, 'Checkpoint')`, and the
  `'Vn-Checkpoint'` trailer key).
- `packages/commands/src/tests/commit.test.ts:130` (the `it(...)` description, "marks a
  checkpoint as its own kind of event"), `:134` (the call site), `:140` (asserts
  `'Vn-Checkpoint: true'` in the commit body).
- `apps/desktop/src/main/index.ts:401, 411, 413, 419, 504` (five comments referring to
  "the checkpoint"/"open-time checkpoint"), `:414` (the call site), `:416` (a
  `console.log` reading `` `[vnstudio] checkpoint ${c.sha.slice(0, 8)} in ${c.repo}` ``).
- `docs/reference/repos-and-commits.md:93-96, 116-117, 165, 172, 229, 245` (every prose
  mention, including the `Vn-Checkpoint: true` trailer example).

so `grep -i checkpoint` in this codebase means the one thing defined here, not two.

```ts
async beginCheckpoint(shortLabel: string, message: string, scope: string): Promise<CheckpointHandle>;
async endCheckpoint(handle: CheckpointHandle): Promise<CommandOutcome>;
```

**`scope`** is a single root-relative directory the checkpoint's snapshot is confined
to — see "Interaction with the authoring agent" below for why this replaced an earlier,
unsound attempt at detecting out-of-scope writes after the fact instead of making them
structurally impossible to see. `UndoJournal` gains a scoped counterpart to its existing
whole-tree `capture()`/`currentTree()`/`restore()`:

```ts
async captureScoped(subpath: string, seq: number): Promise<string | null> {
  const dir = join(this.root, subpath);
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const tree = await this.store.capture(dir, this.skip); // same ContentStore, narrower root
  this.taken.push({ seq, tree });
  return tree;
}
```

`null` means "the scope directory doesn't exist yet," the scoped equivalent of the
whole-tree `capture()`'s own documented "root is not a directory to walk" case.
`beginCheckpoint` treats it as fatal rather than passing it through: reject with `` `no
${scope} to checkpoint` `` and never set `this.openCheckpoint`, releasing the gate
immediately. This is not purely defensive — a fourth review pass found the naive path
choice below stats a directory that doesn't exist, which made this the *normal* case
rather than an edge case until the path itself was fixed. With the corrected path, opening
a checkpoint from `deleteSelected`/`duplicateSelected` can't hit it in practice (both
require an existing node, which requires the graph document — and therefore its directory
— to already be on disk), but a generic `beginCheckpoint` still has to answer the
question rather than silently coerce `null` into whatever `UndoPoint.pre: string` expects.

`currentTreeScoped(subpath)` and `restoreScoped(subpath, from, point, side)` follow the
same pattern, passing `join(this.root, subpath)` as `ContentStore`'s root instead of
`this.root` itself. `this.skip` (the whole-tree exclude list, `UNDO_EXCLUDES`) is passed
through unmodified; none of its entries (`vngen/build`, `vngen/state`, `assets/objects`,
`keys`, the session file) nest inside the graphs directory, so it excludes nothing here —
inert rather than wrong, but worth stating rather than leaving to be discovered. No new
diffing capability is needed: a scoped restore already reports `changed: string[]` the
same way the whole-tree one does (`ContentStore.restore`'s existing behavior), which is
all the aggregate and rollback records need for their own `written` fields.

**The scope path, and what it actually covers.** `packages/gengraph/src/paths.ts:13`'s
`graphsDir` resolves to `join(paths.work, 'graphs')`, and `ProjectPaths.work`
(`packages/store/src/paths.ts`) is `<root>/vngen/work` — confirmed independently by
`apps/desktop/src/shared/writes.ts:41`'s `export const GRAPH_DOCS_DIR =
'vngen/work/graphs';`. **The scope is `'vngen/work/graphs'`, not `'work/graphs'`** — an
earlier draft of this section used the wrong literal, which a fourth review pass caught:
with the wrong path, `captureScoped` stats a directory that never exists and returns
`null` on every real checkpoint, silently protecting and restoring nothing. Every command
this plan wires to a checkpoint — the Gen Graph node-editing family
(`addNode`/`removeNode`/`link`/`unlink`/`setProp`/`moveNodes`/`setActiveOutput`/
`duplicateNode`) — writes exclusively through `graphDocFile`/`graphsDir`, so
`'vngen/work/graphs'` is exact for those. It is **not** exact for `gengraph.run` or
`gengraph.apply`/`gengraph.estimate`: those write run-journal and blob state under
`vngen/state/graphs/` (`packages/gengraph/src/journal.ts`), outside this scope entirely.
That's fine only because neither of those three is ever dispatched from
`GenGraphEditor.delegate()`'s `deleteSelected`/`duplicateSelected` path (they run from a
separate, non-checkpointed UI action) — but it means **`scope` must be understood as
"what the checkpoint's own commands are expected to write," decided per checkpoint by
whoever opens it, not a single fact about the whole `gengraph.*` command family.**
Whoever wires a second checkpoint-eligible command family in the future has to re-derive
its own correct scope the same way, rather than assume "the command's package" implies a
directory.

Commands used inside a checkpoint are trusted to write only under its `scope`, but that
trust gets one cheap check rather than none: on a **successful** inner command (the one
case `CommandRecord.written` is reliably populated — the failure case is why this plan
does not lean on `written` for anything load-bearing, see the round-3 finding above),
`failCheckpoint`/`endCheckpoint`'s bookkeeping asserts every path in that record's
`written` starts with `scope` and logs (does not refuse) if one doesn't. This exists to
catch a future command wired into a checkpoint whose writes don't match the scope its
caller declared — exactly the kind of assumption that turned out wrong twice already in
this plan's own review history — without pretending it can catch a failing command's
unrecorded partial write, which it structurally cannot.

**Concurrency.** `CommandStack` is one instance shared across the whole workspace — every
window, the agent, CDP and the DSL all call `exec()` on the same stack
(`apps/desktop/src/main/index.ts`'s `getStack()`). `exec()` has no notion of caller
identity today, so a checkpoint needs a way to tell "a command meant for this checkpoint"
apart from "an unrelated command that happened to arrive while it's open" — otherwise
either an unrelated command could run inside the checkpoint's rollback window, or a
checkpoint's own commands would deadlock behind the very serialization it's holding open.
`CheckpointHandle` is that: `exec()`/`execDsl()` grow an optional final parameter, and
`runCommand`'s existing `command.mutating ? this.serialize(run) : run()` branch becomes:

- No handle passed, no checkpoint open → today's behavior, unchanged.
- No handle passed, a checkpoint **is** open → `this.serialize(run)` as today, which
  queues behind the checkpoint's hold on `this.chain` (see below) exactly the way it
  already queues behind any other in-flight mutating command. Correct, if slower than the
  caller probably wanted — this is the foot-gun case a caller forgot the handle in.
- A handle passed, but it doesn't match the open checkpoint (wrong seq, or none open) →
  refuse immediately: `{ ok: false, error: "no open checkpoint <seq>" }`.
- A handle passed and it matches → chain onto `openCheckpoint.tail` (below) rather than
  `this.chain`.

**Holding the chain across two calls.** `beginCheckpoint` has to occupy `this.chain` from
the moment it returns until `endCheckpoint()` releases it, but the caller needs the handle
back *before* the hold ends — that's two different "when this finished" signals from one
`serialize()` call. Implemented with a manually-resolved gate:

```ts
async beginCheckpoint(shortLabel: string, message: string, scope: string): Promise<CheckpointHandle> {
  if (this.openCheckpoint) throw new Error('a checkpoint is already open');
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const ready = withResolvers<CheckpointHandle>(); // resolve/reject captured, same pattern

  void this.serialize(async () => {
    try {
      await this.flush(); // land any pending deferred-commit batch first, as runCommand does
      const seq = ++this.seq;
      const pre = await this.opts.journal.captureScoped(scope, seq);
      this.openCheckpoint = {
        seq, shortLabel, message, scope, pre, failed: null, release: releaseGate,
        tail: Promise.resolve(),             // per-checkpoint mini-chain, see below
        timer: setTimeout(() => this.timeoutCheckpoint(seq), CHECKPOINT_TIMEOUT_MS),
      };
      ready.resolve({ seq });
    } catch (err) {
      ready.reject(err);
      return; // nothing to hold open — never set this.openCheckpoint
    }
    await gate; // holds this.chain until endCheckpoint (or the failure/timeout path) resolves it
  });

  return ready.promise;
}
```

**Ordering commands inside a checkpoint without forcing the caller to await each one.**
`GenGraphEditor.send()` is fire-and-forget by design (§6 covers why that's fine to leave
alone), so several checkpoint-routed `exec()` IPC calls can land in main back to back with
nothing on the renderer side serializing them. `exec()`'s checkpoint branch does not run
`runCommand` inline; it chains onto the checkpoint's own tail:

```ts
openCheckpoint.tail = openCheckpoint.tail.then(async () => {
  if (openCheckpoint.failed) return refused(openCheckpoint.failed);
  const outcome = await runCommand(..., { checkpoint: openCheckpoint });
  if (!outcome.ok) this.failCheckpoint(openCheckpoint, outcome.error);
  return outcome;
});
return openCheckpoint.tail;
```

so however many `command:exec` messages arrive concurrently, main runs them one at a time
in arrival order, and the instant one fails, every command still queued behind it on the
same tail — including ones already in flight from the renderer's synchronous dispatch
loop — is refused rather than applied. This is what makes "the checkpoint has to know the
moment one of them fails so it can stop dispatching the rest" true without any renderer
code needing to `await` between iterations.

**Timeout, and cleanup on abandonment.** `CommandStack` is one instance for the entire
workspace (every window, the agent, CDP, the DSL — this plan's own concurrency section
above), so a checkpoint that is never closed — a crashed renderer, a force-closed window, a
lost IPC round-trip between `beginCheckpoint` resolving in main and the message reaching
the renderer — must not wedge every future mutating command in the app forever.
`beginCheckpoint` arms a timer (`CHECKPOINT_TIMEOUT_MS = 120_000`, two minutes: the second
review pass found the real cost driver is not a single IPC round-trip but git-subprocess
overhead compounding across a large batch — every non-deferring `gengraph.*` node command
inside a checkpoint still commits individually, serialized on `openCheckpoint.tail`, so
duplicating or deleting a few hundred nodes could genuinely take tens of seconds; two
minutes gives that room while still clearing an abandoned checkpoint well within one
sitting, rather than the 30s first proposed against the wrong premise — see
[Finding 6](#second-pass-the-revised-design)); `timeoutCheckpoint(seq)` is exactly
`failCheckpoint(openCheckpoint,
'checkpoint timed out')` (below) followed by forcing `endCheckpoint` closed as if the
caller had called it: read `openCheckpoint.tail` to let any already-queued command finish
being refused, then run the same failure-close path `endCheckpoint` runs when
`openCheckpoint.failed` is set. A live `endCheckpoint(handle)` call that arrives after the
timeout already fired sees `openCheckpoint` cleared and answers
`{ ok: false, error: 'no open checkpoint <seq>' }`, same as any other stale handle.
`clearTimeout(openCheckpoint.timer)` on every exit path (`endCheckpoint`, the timeout
itself) so a normal, prompt close doesn't leave a dangling timer.

**`failCheckpoint(openCheckpoint, error)`** is the one rollback path, used by both an inner
command's failure and a timeout:

- Sets `openCheckpoint.failed = error`, refusing every further checkpoint-tagged `exec()`.
- Restores straight to `openCheckpoint.pre` — no drift check, because (see "Interaction
  with the authoring agent" below) the checkpoint's snapshot is scoped to a caller-declared
  subpath, so there is nothing outside that subpath for the restore to touch, let alone
  clobber.
- Builds a synthetic record the same way `moveBody`'s own `stack.undo`/`stack.redo`
  records are built — `seq: openCheckpoint.seq`, `id: 'stack.checkpointRollback'`,
  `invocation: `stack.checkpointRollback(seq=${seq})``, `props: {}`, `source: 'system'`,
  `mutating: true`, `status: 'error'`, `message: `Rolled back "${shortLabel}": ${error}``,
  `checkpoint: openCheckpoint.seq` (tagged the same as every inner record, so
  `undoCandidate` skips it) — then calls **both** `this.record(record)` and
  `this.commit(true, record)`, exactly the two calls `moveBody` makes
  (stack.ts:421-423), in that order. Restoring the tree is a real change to the
  worktree; `docs/reference/repos-and-commits.md`'s stated exemptions from appearing in
  `commands.jsonl` are "changed nothing, ran without a committer, or deferred its commit
  into a batch" — a rollback fits none of them, so it needs the same `record()` +
  `commit()` pair as every other restore path, not just the commit half. This also
  retires any commit any inner command in the checkpoint already made individually
  before the failure: the rollback commit lands on top of it, so `git log` shows the
  attempt and its reversal rather than a commit whose content no longer exists on disk
  with nothing explaining why. A deferring inner command's still-`pending` record (if
  any) is dropped from `this.pending` at the same time, so a later flush cannot commit
  the now-reverted content under its message.
- Calls `this.prune(journal)` after the restore, same as every other capture/restore path,
  so a checkpoint's snapshots are bounded by the same `keep`/`maxBytes` ceilings as
  everything else (`undo.ts:43-44`) instead of growing unbounded.
- Appends **no *aggregate*** record to the undo stack proper — the checkpoint net-changed
  nothing from the author's perspective, so nothing here becomes an undo/redo candidate,
  the same way a refused ordinary command leaves no undo point. The rollback record above
  is persisted for provenance (`commands.jsonl`) but carries `checkpoint`, not a bare
  `stack.checkpoint` id, so it reads as part of the failed group rather than as a second
  undo point sitting next to it.

`endCheckpoint(handle)`:

- Refuses if `handle.seq` doesn't match `this.openCheckpoint?.seq`.
- Awaits `openCheckpoint.tail` first, so a command still queued behind an earlier one on
  the same checkpoint gets to run (or be refused) before the checkpoint closes.
- If `openCheckpoint.failed` is now set (an inner command failed, or the timeout already
  fired and forced a close), the failure path above has already run; return
  `{ ok: false, error: openCheckpoint.failed }`, clear `openCheckpoint`, call `release()`.
- Otherwise takes the `post` capture via `journal.captureScoped(openCheckpoint.scope,
  openCheckpoint.seq)` — **not** `currentTreeScoped`, and this distinction matters: a
  fourth review pass found the first draft of this bullet used the non-pinning
  `currentTreeScoped` (mirroring the whole-tree `currentTree()`, which deliberately
  doesn't hold its result against pruning), and the very next line's `this.prune(journal)`
  call could collect that unpinned tree immediately, leaving the checkpoint's own aggregate
  record's `post` snapshot dangling the moment it was created. `captureScoped(scope, seq)`
  pushes `{ seq: openCheckpoint.seq, tree }` onto `journal.taken` — the same `seq` `pre`
  was captured under — so the pair survives pruning exactly like any ordinary command's
  `pre`/`post` pair does. Then calls `this.prune(journal)`, appends one aggregate
  `CommandRecord` (below), clears `openCheckpoint`, calls `release()`, and returns
  `{ ok: true, record }`.

**The aggregate record**, appended by a successful `endCheckpoint`:

```ts
{
  seq: openCheckpoint.seq,
  id: 'stack.checkpoint',
  invocation: `stack.checkpoint(seq=${seq})`,   // a name, not a repro line — see CommandRecord.label below
  label: shortLabel,
  props: {},
  source: 'ui',
  mutating: true,
  status: 'ok',
  message,                                       // the long string, shown by report() same as any command
  undo: journal.point(openCheckpoint.pre, post),
  // no `written` field: `CommandRecord.written` is `string[] | undefined`, set only when
  // a command's own commit actually wrote paths (stack.ts:415-417). This record's own
  // `run` writes nothing itself, so it's omitted here the same way `moveBody` omits it
  // whenever nothing was restored — matching an ordinary no-op command's record shape.
  gitHead, gitDirty, startedAt, finishedAt,       // as every other record
}
```

No separate `this.commit()` call for a *successful* close: every inner command already
committed (or deferred) its own write under commit-on-save's existing, unchanged rules (see
[Not in scope](#not-in-scope)); the aggregate record writes nothing new itself, so it omits
`written` rather than asserting a value the field's real type (`string[] | undefined`)
can't express for "nothing."

**Interaction with the authoring agent.** `CommandStack` is one instance shared by every
window, the agent, CDP and the DSL (this section's own concurrency note), which reads as
"the agent's writes are subject to the same serialization as everything else" — but that is
not true today. `docs/reference/command-system.md`'s "From the agent" section states
plainly: "wiring the authoring agent's tool loop to the registry is a follow-on, **not
shipped**." Right now the agent — whether the standalone `vnauthor` CLI or the desktop
app's own in-process Convo pane, both backed by the same `@vn/scriptedit`/`@vn/artgen`
rule functions — writes scene, branch, and storyboard files **directly**, bypassing
`CommandStack.exec()` and `this.chain` entirely. It is also, by design, a normal mode of
this app for a human to be editing the Gen Graph in one pane while the embedded agent is
mid-turn editing scenes in another.

`UndoJournal.capture`/`.restore` (`packages/commands/src/undo.ts`) snapshot and restore an
entire directory under `root`, not the specific files a command touched (confirmed by
reading `undo.ts`: `capture()` hashes the whole tree passed to it, `restore()` calls
`this.store.restore(root, from, point[side], changed)` against that same root). Ordinary
undo/redo is safe from an out-of-band write only because `moveBody` calls `journal.check()`
first and refuses if the tree has drifted from the one snapshot it expects. The first two
drafts of this plan had `failCheckpoint` skip any such check on the (wrong, for the agent's
current architecture) reasoning that "nothing outside this checkpoint could have touched
the tree while it holds `this.chain` exclusively"; the third draft tried to detect an
out-of-band write after the fact by diffing `pre` against the tree at failure time and
comparing the changed paths to each inner command's own reported `written` set — a review
pass then found that check unsound on the very case it exists for, because a *failing*
command's record never gets a `written` value in the first place (`runCommand`'s catch
path doesn't set it), so the command most likely to have left an unaccounted partial write
is exactly the one the check couldn't see.

The fix that survived: `beginCheckpoint`'s new `scope` parameter (above) confines the
journal's capture/restore to a caller-declared subdirectory — `'vngen/work/graphs'` for
`GenGraphEditor` — instead of the whole project tree. An agent edit to a scene or
screenplay file, which lives elsewhere under `vngen/work/`, is not merely *undetected* by
this; it is never captured in the first place, so there is nothing for a rollback to
clobber and nothing to reconcile. This trades generality for the correctness guarantee: a
checkpoint can only safely group edits that stay within one declared subtree, which costs
nothing today (the Gen Graph node-editing commands this plan wires to a checkpoint only
ever write under `vngen/work/graphs`) but means a future checkpoint spanning two
subsystems would need a shared scope wide enough to cover both — at which point it
reopens exactly this question rather than solving it.

The corollary, once the agent's tool loop *is* wired to the registry (the stated
follow-on) and starts calling `exec()` like everything else: it would then queue behind
`this.chain`/a checkpoint's `tail` exactly like CDP or the DSL already do, so a lengthy
human checkpoint (now up to `CHECKPOINT_TIMEOUT_MS` = two minutes, worst case) could stall
the agent's next tool call for that long. That is an availability cost, not a correctness
one — worth the agent's own tool-calling layer being aware of a multi-second-to-two-minute
stall as a normal possibility once that follow-on lands, but not something this plan needs
to solve, since it is the same queuing behavior any other in-flight mutating command
already imposes today.

### 2. `packages/commands/src/command.ts`: two new fields

```ts
export interface CommandRecord {
  // ...
  /**
   * A human sentence naming this record for display, in place of `invocation`. Set only on a
   * checkpoint's aggregate record, from the text `beginCheckpoint` was given — `invocation`
   * there is a synthetic, non-replayable string (`stack.checkpoint(seq=…)`), kept only for
   * `commands.jsonl` consistency with `stack.undo`/`redo`'s own synthetic invocations.
   */
  label?: string;
  /**
   * Set on every record run inside a checkpoint, naming the checkpoint's own `seq`. `undoCandidate`
   * skips these — the checkpoint's own aggregate record (`stack.checkpoint`, `seq` equal to this
   * field) is the undo point that stands in for the whole group.
   */
  checkpoint?: number;
}
```

`stack.ts` changes to read/write these:

- `undoCandidate()`'s loop gains `if (record.checkpoint !== undefined) continue;` — the
  same shape as the existing `record.stack` skip, right beside it.
- `undoState()` and `moveBody()`'s "Undid/Redid …" sentence read `record.label ??
  record.invocation` wherever they read `invocation` today, so an ordinary command's
  tooltip/toast is unchanged and a checkpoint's shows the short label instead of
  `stack.checkpoint(seq=7)`.
- `runCommand` takes the checkpoint (if any) as an added parameter from its caller
  (`exec`), skips its own `pre`/`post` capture when one is open (this is the "one walk,
  not N" saving), and stamps `record.checkpoint = openCheckpoint.seq` instead of
  `record.undo`.

### 3. `apps/desktop`: IPC and the renderer bridge

`apps/desktop/src/shared/ipc.ts`:

```ts
export interface CommandExecRequest {
  id?: string;
  props?: Record<string, PropValue>;
  dsl?: string;
  source?: CommandSource;
  checkpoint?: CheckpointHandle; // new
}
```

and two new channels:

```ts
'command:checkpointBegin': (request: { shortLabel: string; message: string; scope: string }) => CheckpointHandle;
'command:checkpointEnd': (handle: CheckpointHandle) => CommandOutcome;
```

`apps/desktop/src/main/index.ts`'s `registerIpc()` gains the two handlers (`getStack()`
already lazily builds the one stack instance) and `command:exec`'s handler passes
`request.checkpoint` through to `getStack().exec(...)`.

`apps/desktop/renderer/pathux/bridge.ts` gains:

```ts
export function beginCheckpoint(shortLabel: string, message: string, scope: string): Promise<CheckpointHandle> {
  return api.invoke('command:checkpointBegin', { shortLabel, message, scope });
}

export async function endCheckpoint(checkpoint: CheckpointHandle): Promise<CommandOutcome> {
  const outcome = await api.invoke('command:checkpointEnd', checkpoint);
  report(outcome);
  return outcome;
}
```

and `exec()` grows an optional `checkpoint?: CheckpointHandle` parameter, forwarded into
the `command:exec` request body.

### 4. `vendor/path.ux`: the delegate shape carries the two strings

`scripts/editors/nodeeditor/delegate.ts`:

```ts
interface NodeGraphDelegate {
  undoStepBegin(ctx: GraphContext, shortLabel: string, message: string): Promise<void>;
  check(ctx: GraphContext, edit: GraphEdit): EditVerdict;
  perform(ctx: GraphContext, edit: GraphEdit): void;
  undoStepEnd(ctx: GraphContext): Promise<void>;
}
```

`perform` stays synchronous — nothing below needs it to change. `undoStepBegin`/
`undoStepEnd` become `Promise<void>` because a delegate that wants to open a real
checkpoint has to `await` an IPC round-trip before the batch can safely start.
`ToolOpDelegate.undoStepBegin`/`undoStepEnd` do nothing async today (they open/close a
local `ToolMacro`), so they stay trivially compatible, wrapped in an already-resolved
promise.

The problem this raises is that path.ux's toolstack (`scripts/path-controller/toolsys/
toolsys.ts`) is otherwise synchronous end to end: `ToolStack.execTool` runs a non-modal
op's `exec()` inline and returns, and `NodeGraphView`'s gesture code
(`gesture_ops.ts`, `_commitMove`, `addNodeAt`, the context menu's Delete/Duplicate,
`packSelected`) calls `_dispatch()`/`perform()` synchronously from event-handler
callbacks with nothing to `await`. A real `undoStepBegin` implementation (`GenGraphEditor`'s
own — see §6) has to `await` an IPC round-trip, and there is no way to hide that from
`singleUndoStep`'s own caller: `await` always defers past the current synchronous turn even
against an already-resolved promise, so no amount of wrapping makes `deleteSelected()`
finish before `undoStepBegin` actually resolves. **`deleteSelected()`/`duplicateSelected()`
and `singleUndoStep` have to become genuinely `async`, returning real promises** — there is
no MVP that avoids this once a delegate hook does real async work. The one concrete cost is
`tests/nodeeditor_view.test.ts:399-429` ("a link is selectable and delete severs it"), which
calls `view.deleteSelected()` unawaited and asserts the edit already happened; it needs one
line changed to `await view.deleteSelected();` and the enclosing `it` to become `async`.
Nothing else in the test suite calls either method synchronously (confirmed by the second
review pass).

### 5. `AsyncGateOp`: locking input for the duration, not faking synchronicity

What path.ux's existing modal-op mechanism *is* good for here is stopping a second gesture
from starting a competing checkpoint while the first one's async close is still in flight —
a real risk once `undoStepEnd` is an awaited IPC round-trip rather than an instant local
call. A modal op's `modalStart` calls `EventHandler.pushModal`/`pushPointerModal`
(`scripts/path-controller/util/events.ts`), which routes pointer/keyboard dispatch to the
op exclusively until it calls `modalEnd()`; `AsyncGateOp` reuses that lock for the
checkpoint's async window instead of a drag, and `singleUndoStep` awaits its completion
directly rather than going through `execTool`'s `void` return:

```ts
class AsyncGateOp<CTX extends ContextLike> extends ToolOp<{}, {}, CTX> {
  static override tooldef(): ToolDef {
    return { toolpath: 'app.asyncgate', is_modal: true, undoflag: UndoFlags.NO_UNDO };
  }

  constructor(private readonly run: (ctx: CTX) => Promise<void>) {
    super();
  }

  // Ignore every key while the async work is in flight — there is nothing a keypress can
  // safely cancel mid-checkpoint, and the default Escape/Enter handling would call
  // modalEnd() before `run`'s promise settles.
  override on_keydown(): void {}

  override modalStart(ctx: CTX): Promise<unknown> {
    const promise = super.modalStart(ctx); // registers the input lock synchronously
    this.run(ctx).then(
      () => this.modalEnd(false),
      (err) => { this.error(String(err)); this.modalEnd(true); },
    );
    return promise;
  }
}
```

`UndoFlags.NO_UNDO` keeps it out of the toolstack's own undo array (`execTool` skips
`this.cur++`/`this[this.cur] = toolop` for `NO_UNDO` ops) — it is purely a lock around
whatever undoable work `run` does, never an undo entry itself. `singleUndoStep` calls
`modalStart` directly rather than `ctx.toolstack.execTool` (the gate needs none of
`execTool`'s other bookkeeping — memory limits, `canRun`, the undo push — and `execTool`'s
own return type is `void`, which is exactly the problem here) and awaits the returned
promise, with the `try`/`finally` restored so `undoStepEnd` always runs even if `cb()`
throws:

```ts
async singleUndoStep<T>(cb: () => T, shortLabel: string, message: string): Promise<T> {
  let result!: T;
  const gate = new AsyncGateOp<CTX>(async (ctx) => {
    await this.delegate.undoStepBegin(this.graphContext, shortLabel, message);
    try {
      result = cb();
    } finally {
      await this.delegate.undoStepEnd(this.graphContext);
    }
  });
  await gate.modalStart(this.ctx); // resolves only once modalEnd() fires, i.e. after `run` settles
  return result;
}
```

`ctx.toolstack.onTick()` still finds the gate (`modalStart` pushes onto the module-level
`modalstack` array regardless of how it was started), so anything relying on that array's
presence during a modal op is unaffected. A gesture's own `execTool` calls made from inside
`run` (`ToolOpDelegate`'s existing per-edit `pendingMacro.add(tool)` accumulation, or
`GenGraphEditor`'s own edits — see §6) are unaffected either way: the input lock governs
incoming pointer/keyboard dispatch, not programmatic calls the running code makes itself.

Every place implementing `NodeGraphDelegate` needs the two new parameters and the
`Promise<void>` return on `undoStepBegin`/`undoStepEnd`: `ToolOpDelegate` (`delegate.ts`).
`example/editors/nodeeditor/nodeeditor_tab.ts` does not implement the interface at all
(nothing to change there), and `tests/nodeeditor_edit.test.ts` /
`tests/nodeeditor_view.test.ts` build delegate literals that already omit both methods
today and typecheck clean only because `tests/*.ts` is outside `tsconfig.json`'s included
set — neither exercises `undoStepBegin`/`undoStepEnd` (both drive `_dispatch`-only paths),
so neither needs that particular change (`nodeeditor_view.test.ts` still needs the one
`await` from above, which is unrelated to its delegate literal).

### 6. `GenGraphEditor`: still no ripple into `perform()`/`_dispatch`

`GenGraphEditor.dispatch()` → `send()` stays exactly as it is today: synchronous local
mutation (`weighed.decision.apply()`) followed by a fire-and-forget `void exec(...)`.
`perform()` does not need to become async, because correctness inside a checkpoint is
enforced on the main-process side (§1's per-checkpoint `tail` chain), not by the renderer
awaiting each dispatch. `GenGraphEditor.delegate()`'s `undoStepBegin`/`undoStepEnd` open
and close the real checkpoint:

```ts
private checkpoint: CheckpointHandle | undefined;

private delegate(): NodeGraphDelegate {
  return {
    undoStepBegin: async (_ctx, shortLabel, message): Promise<void> => {
      this.checkpoint = await beginCheckpoint(shortLabel, message, 'vngen/work/graphs');
    },
    check: (_ctx, edit): EditVerdict => this.judge(edit),
    perform: (_ctx, edit): void => this.dispatch(edit),
    undoStepEnd: async (): Promise<void> => {
      if (this.checkpoint) await endCheckpoint(this.checkpoint);
      this.checkpoint = undefined;
    },
  };
}
```

`send()` grows a branch that passes `this.checkpoint` into `exec()`'s new parameter when
one is open; nothing else about it changes. `deleteSelected()`/`duplicateSelected()`'s
existing synchronous `for` loop over the selection keeps calling `_dispatch()` per node
without awaiting — each call's `send()` fires its `command:exec` immediately, main queues
and runs them in order on `openCheckpoint.tail`, and a failure partway through refuses
whatever is still queued behind it. `GenGraphEditor` doesn't route `perform()` through the
toolstack at all (it isn't `ToolOpDelegate`-based), so its `async` `undoStepBegin`/
`undoStepEnd` are simply awaited by `singleUndoStep`'s `AsyncGateOp` the same way any
delegate's are — `GenGraphEditor` is a consumer of the widened interface and of
`AsyncGateOp`'s input lock (which still matters for it: it stops a user from starting a
second gesture while `beginCheckpoint`'s or `endCheckpoint`'s IPC round-trip is pending),
just not of the toolstack's per-edit `execTool`/undo-array machinery, which it never used.

Once a command inside the checkpoint fails and the server-side tree is rolled back,
`GenGraphEditor`'s **in-memory** `this.graph` (mutated eagerly by every
`weighed.decision.apply()` along the way) is stale — it reflects edits that no longer
exist on disk. The failure path needs to force a reload (`this.load(this.slug)`) rather
than trusting the optimistic local copy, same as an ordinary refused write already sets
`this.sync.stale = true` to trigger one.

## Not in scope

- **Commit-on-save granularity.** A checkpoint groups *undo*, not git commits. Every
  command inside one still commits (or defers, per its own `defersCommit`) exactly as it
  does today; `docs/reference/repos-and-commits.md`'s "How undo composes with it" already
  establishes the two mechanisms as independent, and this plan keeps them that way rather
  than opening a second question (should a checkpoint be one commit too?) inside this one.
- **Nested checkpoints.** `beginCheckpoint` while one is already open throws. A generic
  nesting/reentrancy scheme is not needed for the one caller this plan has
  (`GenGraphEditor`, one gesture at a time) and would multiply the concurrency surface
  above for no present use.
- **DSL/CDP-driven checkpoints.** `execDsl` grows the parameter for symmetry with `exec`,
  but no DSL syntax for `beginCheckpoint`/`endCheckpoint` is added — CDP and the palette
  keep working exactly as today, one command at a time.
- **`@vn/testkit` and the CLI.** Neither drives multi-command UI gestures; `CommandStack`
  usage there is unaffected beyond the two new optional methods existing.
- **path.ux's `ToolOpDelegate`/`ToolMacro` undo grouping.** Unrelated mechanism, already
  shipped in the commit this plan follows; its `undoStepBegin`/`undoStepEnd` just widen
  their signature to match the interface and stay synchronous internally (wrapped in an
  already-resolved promise).

## Open questions for review

- Is `checkpoint.exec(...)`-as-a-method (a real object with a bound method) preferable to
  the bare-token-plus-parameter shape chosen here? The token shape was picked because it
  has to cross IPC as plain data; a bound-method handle would need a second, IPC-specific
  wrapper type anyway, so the plan collapses the two into one shape rather than keeping
  both. Worth a second opinion.
- Should a checkpoint that runs zero commands before `endCheckpoint()` (an empty group)
  produce a `changed: false` aggregate record (today's per-command capture already
  degrades gracefully this way — `journal.point(pre, post)` with `pre === post` sets
  `changed: false`, and `undoCandidate()` already walks past a `changed: false` record) —
  confirm this falls out of the existing logic for free rather than needing a special
  case.
- Exact short/long wording for `deleteSelected()`/`duplicateSelected()` in path.ux is left
  open above; settle it against how the strings actually render (tooltip truncation,
  toast line length) rather than in the abstract.

## Review

Pressure-tested against the actual code (`packages/commands/src/stack.ts`,
`command.ts`, `undo.ts`, `vendor/path.ux`'s node-editor files, `apps/desktop`'s
`nodes.ts`/`bridge.ts`/`ipc.ts`/`main/index.ts`, and `docs/reference/repos-and-commits.md`
/ `command-system.md`). Findings below; each is confirmed against the code, not inferred
from the plan's prose.

### Findings

1. **A checkpoint left open forever wedges the whole shared stack, and nothing ever
   unsticks it.** `CommandStack` is one instance for the entire workspace (every window,
   the agent, CDP, the DSL — this plan's own §1). `beginCheckpoint`'s gate
   (`stack.ts` proposal) is released only by an explicit `endCheckpoint()` call or by the
   in-`exec()` failure-rollback path; there is no timeout and no cleanup hook for a
   renderer that dies, a window that is force-closed, or an IPC round-trip that is lost
   between `beginCheckpoint` resolving in main and the message reaching the renderer.
   Once that happens, `this.chain` never settles, so **every** future mutating command
   from every window, the agent, and CDP queues behind it indefinitely — an app-wide hang,
   not a per-window one. `dispose()` (stack.ts:478-482) doesn't touch `openCheckpoint` or
   `this.chain` either, so the only real escape is a workspace switch, which discards the
   whole stack object (and the undo history with it). The plan does not mention this at
   all, despite raising the "one instance shared across the whole workspace" fact itself.

2. **`perform()` is never widened, so §5's proposed fix cannot work as described.** The
   plan widens only `undoStepBegin`/`undoStepEnd` to `Promise<void>`
   (`delegate.ts` interface in §4); `perform(ctx, edit): void` stays synchronous. But the
   actual async work — `GenGraphEditor`'s fire-and-forget `send()`
   (`apps/desktop/renderer/pathux/editors/nodes.ts:414-430`, `void exec(...).then(...)`) —
   runs inside `perform` (nodes.ts:363, `perform: (_ctx, edit): void => this.dispatch(edit)`),
   which `_dispatch` (`vendor/path.ux/scripts/editors/nodeeditor/nodegraphview.ts:590-595`)
   calls synchronously and gives nothing back to await. So "the loop needs to become
   await-ed per iteration" (§5) has nothing to await: `perform`'s `void` return type is
   exactly what has to change for ordering to be real, and that ripples to *every* call
   site of `_dispatch` in `nodegraphview.ts`, not just `deleteSelected`/`duplicateSelected`:
   `_commitMove` (lines 568 and 577, drag-move), `addNodeAt` (622), the node context
   menu's Delete/Duplicate (815, 823), and `packSelected`'s arrange (803). None of those
   are named in §5.

3. **Converting `deleteSelected`/`duplicateSelected` to `async` breaks an existing
   passing test, and by extension any synchronous caller.** `singleUndoStep` (§4's
   rewrite) `await`s `undoStepBegin`, `cb()`, and `undoStepEnd` in sequence; an `await` on
   an already-resolved promise still yields a microtask, so the edit no longer completes
   within the calling turn even against the default, "trivially compatible" `ToolOpDelegate`
   the plan says stays synchronous internally. `vendor/path.ux/tests/nodeeditor_view.test.ts:399-429`
   ("a link is selectable and delete severs it") calls `view.deleteSelected();` without
   awaiting it and then synchronously asserts `m.inputs.a.edges.length` and
   `ctx.toolstack.length` — this test breaks the moment `deleteSelected` returns a
   `Promise` instead of running to completion inline. The plan's §4 list of call sites
   needing changes never considers this test, or any other synchronous caller (a header
   button reading updated selection state right after the call, a keybind handler).

4. **The plan's own list of "every place implementing `NodeGraphDelegate`" is wrong in
   both directions.** Grepping the whole `vendor/path.ux` tree for `NodeGraphDelegate`
   confirms only five files reference it at all: `delegate.ts`, `nodegraphview.ts`,
   `groupui.ts` (a type reference only, no implementation, needs nothing), and the two
   named test files. But `tests/nodeeditor_edit.test.ts` (lines 197-202, 234-238) and
   `nodeeditor_view.test.ts` (lines 310-315) already build delegate object literals typed
   as `NodeGraphDelegate` that omit `undoStepBegin`/`undoStepEnd` **today**, and
   `pnpm run typecheck` is clean — because `tsconfig.json`'s `exclude` already drops
   `tests/*.ts` and `scripts/**/*.test.ts` from the type-checked set (verified: ran
   `tsgo --noEmit`, zero errors). So the widened signature will not be enforced against
   those two files by the compiler, and at runtime neither test exercises
   `undoStepBegin`/`undoStepEnd` in the first place (both drive `_dispatch`-only paths —
   link-drag connect and move-commit). `example/editors/nodeeditor/nodeeditor_tab.ts` does
   not reference `NodeGraphDelegate` at all, so there is nothing there to check either.
   Net effect: the two test files named in §4 don't need the change the plan describes;
   the one test that does break (finding 3) isn't one of them.

5. **A checkpoint's own snapshots are never pruned.** Ordinary `runCommand` calls
   `this.prune(journal)` after every capture (stack.ts:220). The plan's
   `beginCheckpoint`/`endCheckpoint` pseudocode never calls `this.prune()`, and
   checkpoint-routed inner commands skip capture entirely by design, so nothing prunes a
   checkpoint's pre/post pair. `UndoJournal`'s `keep`/`maxBytes` ceilings (`undo.ts:43-44`)
   stop being enforced for checkpoint snapshots — unbounded content-store growth over a
   session with many checkpointed gestures.

6. **Rollback-on-failure doesn't compose with commit-on-save, contradicting the stated
   invariant.** `docs/reference/repos-and-commits.md` states the worktree invariant
   ("every act ends with one [clean worktree], except inside a run of acts that defer
   their commit") and that undo's own restore always re-commits
   ("Undo commits its restore; it never resets" — line 282; `moveBody` does call
   `this.commit(true, record)` after every restore, stack.ts:421). The plan's checkpoint
   rollback restores the tree to `openCheckpoint.pre` but calls no commit and appends no
   record ("no aggregate record on failure", §1). Two concrete consequences: (a) any
   earlier command in the same checkpoint that already committed individually (every
   `gengraph.*` command except `setProp`/`moveNodes`, per `repos-and-commits.md`'s
   deferral list) leaves git HEAD naming a commit for content the rollback just erased
   from disk, with no compensating commit — a dirty worktree with nothing to explain it,
   unlike every other restore path in this codebase. (b) if a deferring inner command
   (`gengraph.setProp`/`moveNodes`) pushed a record onto `this.pending` before the
   checkpoint failed, rollback never removes it; the next flush (idle timer, or the very
   next non-deferring command anywhere in the app) commits whatever is now on disk — the
   reverted, pre-checkpoint content — under a commit subject and `Vn-*` trailers
   describing the discarded edit. The plan doesn't raise or rule out either case.

7. **The aggregate `stack.checkpoint` record carries no `written`, unlike every other
   undo point.** The shape in §1 has no `written` field. `moveBody`'s own `stack.undo`/
   `stack.redo` records deliberately set `written: restored`, "so a surface following a
   document hears about an undo on the same channel as the command it is undoing"
   (stack.ts:415-417). Each inner command inside a checkpoint still fires its own
   `onRecord`/broadcast individually (confirmed: `runCommand` still calls `this.record()`
   per inner command even when capture is skipped), so live document-tree invalidation
   isn't lost operationally — but a reader of `commands.jsonl`, or anything built on
   `command:history`, sees the checkpoint's own entry — "the one undo point that stands in
   for the whole group" — with nothing recorded about what it touched.

### Revision after the findings above

The design in [What changes](#what-changes) above was rewritten to answer findings 1–3 and
5–7 directly, rather than leaving them as known gaps:

- **Finding 1 (unbounded hold)** → §1 now arms a timeout on `beginCheckpoint` and defines
  `failCheckpoint` as the one path both an inner failure and a timeout use, which always
  releases the chain-holding gate. Confirmed with the reviewing agent's own framing: "on
  failure it should roll back to checkpoint start" now also covers "on timeout."
- **Finding 2 (`perform()` never widened) and finding 3 (async `deleteSelected` breaks a
  test)** → replaced with the `AsyncGateOp` design (new §5): `perform()` stays
  synchronous, `deleteSelected`/`duplicateSelected` keep their `void` signatures, and
  ordering inside a checkpoint is enforced by a per-checkpoint `tail` chain on the main
  process (§1) rather than by the renderer awaiting each dispatch. `GenGraphEditor` (§6)
  needs no change to `_dispatch`/`perform`/the selection loops at all.
- **Finding 5 (no pruning)** → `failCheckpoint` and a successful `endCheckpoint` both now
  call `this.prune(journal)`, matching every other capture/restore path.
- **Finding 6 (rollback doesn't compose with commit-on-save)** → `failCheckpoint` now
  commits its restore (`this.commit(true, record)`, mirroring `moveBody`) and drops any
  pending deferred-commit record from the failed checkpoint before returning.
- **Finding 7 (aggregate record has no `written`)** → the aggregate record shape in §1 now
  sets `written: false` explicitly on a successful close (it wrote nothing new itself);
  the failure path appends no record at all, so `written` doesn't apply there.

Finding 4 (the plan's list of files needing a `NodeGraphDelegate` signature change was
wrong in both directions) is folded into the revised §5's own file list, corrected against
what the reviewing agent verified.

This revision has not itself been pressure-tested by a fresh-context agent yet — that
should happen before implementation starts, per this repo's convention, the same way the
first draft was.

### Open questions, answered

- **Bound-method handle vs. bare token:** the stated reasoning (has to cross IPC as
  plain data) holds up; the bare-token shape is fine. The real risk in this area isn't
  confusion/replay — a stale `{seq}` simply fails to match once that checkpoint closes,
  since `exec()` only ever compares against the *currently* open one — it's the unbounded
  hold in finding 1.
- **Multi-window blocking:** confirmed real, and the plan already states the mechanism
  (queuing behind `this.chain`). What's missing is that the hold has no upper bound
  (finding 1), which is what turns "slower than the caller wanted" into "wedged until a
  workspace switch."
- **Empty checkpoint → `changed: false` for free:** confirmed. `journal.point(pre, post)`
  with nothing run between the two captures produces identical hashes, `undoCandidate()`
  already walks past `changed: false`, and no special case is needed — independent of the
  pruning gap in finding 5.
- **`GraphContext.selectSockets`/`deselectSockets` gap:** checked; confirmed pre-existing
  and unimplemented anywhere in the desktop renderer (only a fully commented-out `SelectOp`
  class in `delegate.ts:118-176` references them). This plan doesn't touch selection, so
  the gap stays orthogonal — no new interaction found.

### Second pass: the revised design

Pressure-tested again against the actual code (`vendor/path.ux/scripts/path-controller/
toolsys/toolsys.ts`, `.../util/events.ts` and `simple_events.ts`,
`vendor/path.ux/scripts/editors/nodeeditor/delegate.ts` and `nodegraphview.ts`,
`vendor/path.ux/tests/nodeeditor_view.test.ts`, `packages/commands/src/stack.ts`,
`command.ts` and `commit.ts`, `docs/reference/repos-and-commits.md`). This pass targets
only the mechanisms new in this revision — `AsyncGateOp`, the timeout, the per-checkpoint
`tail`, and the rollback commit — not the findings already superseded above.

1. **`AsyncGateOp` cannot make `singleUndoStep` synchronous, because `await` always defers
   at least one microtask — this is JavaScript semantics, not an implementation detail, so
   no version of this design fixes it.** `execTool`'s modal branch
   (`toolsys.ts:1840-1863`) calls `toolop.modalStart(ctx)` and returns `void`; nothing
   awaits it. `AsyncGateOp.modalStart` calls `super.modalStart(ctx)` (synchronous: builds
   the promise, pushes `modalstack`, calls `pushModal`/`pushPointerModal`) and then calls
   `this.run(ctx)` — an `async` function, which runs synchronously only up to its first
   `await`. Its very first line is `await this.delegate.undoStepBegin(...)`, so `cb()`
   never runs before `execTool` returns, **even when the delegate's own work is already
   resolved** (`ToolOpDelegate`'s "trivially compatible" wrapper included) — an `await` on
   an already-settled promise still yields a microtask before the continuation runs. Two
   concrete consequences, both directly contradicting what this revision was written to
   guarantee:
   - The proposed `singleUndoStep<T>(cb): T { ... return result; }` returns `result` while
     it is still the `let result!: T` non-null assertion's lie — `cb()` has not run yet.
     Nothing currently reads this return value (`deleteSelected`/`duplicateSelected` don't
     use it), but the method's own generic signature promises a synchronous result, and
     silently returning `undefined` cast as `T` is a live footgun for the next caller.
   - **`vendor/path.ux/tests/nodeeditor_view.test.ts:399-429`** ("a link is selectable and
     delete severs it") — the exact test finding 3 named — calls `view.deleteSelected();`
     with no `await` and immediately asserts `m.inputs.a.edges.length` and
     `ctx.toolstack.length`. Under `AsyncGateOp`, `deleteSelected` returns before `cb()` has
     run, so `_dispatch`'s `DisconnectOp` hasn't executed and `ctx.toolstack.length` is
     still `0`, not `1`. **The revision does not fix finding 3; it reproduces it through a
     different call path**, despite §5's stated rationale ("no test that calls them
     synchronously breaks, because the method itself never returns a promise") — the return
     type was never the problem; the timing is, and `AsyncGateOp` does not change the
     timing.
   - This also means §6's claim that "`GenGraphEditor` ... is a consumer of the widened
     interface, not of the toolstack lock itself" undersells the exposure: `GenGraphEditor`
     reaches `singleUndoStep` through the shared `NodeGraphView.deleteSelected()`/
     `duplicateSelected()` (`nodegraphview.ts:659-668, 671-683`), the same code path
     `ToolOpDelegate` uses. It is not insulated from this finding.

2. **Dropping `try`/`finally` around `cb()` reopens the unbounded-hold problem finding 1
   already fixed once.** Today's `singleUndoStep` (`nodegraphview.ts:659-668`) wraps
   `undoStepEnd` in `finally`, so it always runs even if `cb()` throws. The proposed
   `AsyncGateOp`-based rewrite (§5) has no `try`/`catch` around `result = cb()`: a throw
   there rejects `run(ctx)`'s promise, which `AsyncGateOp`'s `.then(fulfilled, rejected)`
   routes to `this.error(...); this.modalEnd(true);` — releasing path.ux's own modal
   lock — but `undoStepEnd()` (and therefore `GenGraphEditor`'s `endCheckpoint()`) is never
   called. `this.checkpoint` stays open in main until `CHECKPOINT_TIMEOUT_MS` (30 s)
   expires, while the UI already looks unlocked. `deleteSelected`'s own loop
   (`nodegraphview.ts:671-683`) can throw for perfectly ordinary reasons (e.g. a
   `_dispatch`/`syncGraph` failure), so this is not a corner case reachable only through
   misuse.

3. **Escape ends the lock without cancelling or waiting for the async work, so a checkpoint
   can be left open while the app appears free.** `AsyncGateOp` inherits `ToolOp`'s default
   `on_keydown` (`toolsys.ts:930-942`), which calls `this.modalEnd(true)` on Escape.
   `modalEnd` (`toolsys.ts:1058-1095`) unconditionally clears `modalRunning`/`is_modal` and
   calls `super.popModal()`, releasing the input lock (`simple_events.ts:818-861`)
   immediately — it has no way to cancel `this.run(ctx)`'s in-flight promise, which keeps
   running in the background and calls `modalEnd` a second time once it settles (harmless
   in itself: `_modalstate`/`_accept` are already cleared, so the second call is a no-op on
   `modalstack`/the promise). Between the Escape and that eventual settlement, the checkpoint
   is still open in main (`beginCheckpoint`'s gate is not released), but the UI has no lock
   indicator and nothing tells the user a checkpoint is still pending. A second gesture
   attempted in that window calls `beginCheckpoint` again, which throws `'a checkpoint is
   already open'` (§1); `undoStepBegin` has no `try`/`catch`, so the throw propagates out of
   `run(ctx)` and is swallowed by `AsyncGateOp`'s rejection handler as a `console.warn` —
   the second gesture silently does nothing. Nothing in the plan proposes a visible lock
   indicator, a cancel path, or even logging visible to the author for this case.

4. **§1's own aggregate-record sample does not typecheck.** `CommandRecord.written` is
   `string[] | undefined` (`command.ts:171`), matching every existing use —
   `moveBody` sets `written: restored` only `restored.length > 0`
   (`stack.ts:415-417`). The revised §1 record literal sets `written: false` (a boolean) to
   answer finding 7. This is a type error against the real field, not a stylistic
   mismatch — the fix for finding 7 needs a different shape (e.g. omitting `written`
   entirely on a no-op close, the same way `moveBody` omits it when nothing restored).

5. **`failCheckpoint`'s rollback commit and finding 7's "no aggregate record" are in
   tension, and the plan never reconciles them.** The finding-6 fix says `failCheckpoint`
   "commits its restore (`this.commit(true, record)`, mirroring `moveBody`)"; §1 separately
   says a failed checkpoint "appends no aggregate record ... leaves no trace on the undo
   stack." `commit()` (`stack.ts:550-559`) only writes a git commit; the caller decides
   separately whether to call `this.record()`, which is what actually pushes to
   `this.records`/persists to `commands.jsonl` (`stack.ts:585-592`). `moveBody` always does
   both (`stack.ts:421-423`). The plan never says whether `failCheckpoint` calls
   `this.record()` for its synthetic record. If it does not, the rollback's commit sha has
   no corresponding entry anywhere in `commands.jsonl`, which contradicts
   `docs/reference/repos-and-commits.md:119-121` ("resulting shas land on
   `CommandRecord.commits` ... in `vngen/state/commands.jsonl`, absent on a record that
   changed nothing, ran without a committer, or deferred its commit into a batch" — a
   rollback commit fits none of those three exemptions). Constructing that record also
   needs a `seq`, an `id`, an `invocation` and a `message`/`source` the plan never names.

6. **`CHECKPOINT_TIMEOUT_MS = 30_000` is sized against a premise the codebase doesn't
   support, and the real cost driver is undercounted.** The plan's own justification
   ("generous for a human-paced gesture plus IPC round trips") and this review's task
   framing both float "real image-generation-adjacent writes" as the slow case, but
   `gengraph.*` commands only edit the generation graph document (per
   `docs/reference/repos-and-commits.md:127`, only `gengraph.setProp` and
   `gengraph.moveNodes` defer) — actual image generation is a separate, non-interactive
   pipeline step this plan's commands never touch. The real cost is git-subprocess
   overhead: every other `gengraph.*` node command (`addNode`, `deleteNode`,
   `duplicateNode`, …) commits individually (`stack.ts:214`, `command(...) &&
   !command.commitsItself`), and inside a checkpoint those individual commits still run,
   serialized, on `openCheckpoint.tail` — a checkpoint groups *undo*, not commits (Not in
   scope, confirmed). A duplicate/delete of a few hundred nodes is therefore a few hundred
   real `git commit` subprocesses back to back before `endCheckpoint` can even take its
   `post` capture. No test or doc in this repo measures that cost, so 30 s is asserted, not
   measured — worth a throwaway timing check (duplicate ~200 nodes end to end) before
   picking a number, and worth reconsidering whether a checkpoint should force
   `defersCommit` semantics on its inner commands regardless of their standalone flag,
   since none of those individual commits' shas are what the checkpoint's own aggregate
   record advertises anyway (§1: `written: false`, no `commits` field on success).

7. **Minor: name collision with an existing, unrelated concept.** `Committer.checkpoint(reason)`
   (`commit.ts:145-147`) already exists — a bootstrap/open-time sweep commit under a
   `Vn-Checkpoint: true` trailer (`docs/reference/repos-and-commits.md:93-96`), unrelated to
   undo grouping. `CommandStack.beginCheckpoint`/`endCheckpoint` introduces a second,
   different "checkpoint" in the same package. Not a functional conflict — different
   classes, different vocabulary scope — but worth a different name (e.g. `beginGroup`/
   `endGroup`) so `grep checkpoint` and the docs don't need a disambiguating footnote.

None of findings 1–3 are reachable only through `GenGraphEditor`'s IPC-backed delegate —
they reproduce with `ToolOpDelegate`'s trivial, already-resolved wrapper too, which is the
case the revision explicitly claims stays "trivially compatible." That claim does not hold.

### Revision 2, after the second pass

- **Findings 1–3** → `deleteSelected()`/`duplicateSelected()`/`singleUndoStep` in the
  revised §4/§5 are now genuinely `async`, returning real promises; there is no MVP that
  avoids this once a delegate hook does real async work, so the plan stops trying to hide
  it. `singleUndoStep` now `await`s `AsyncGateOp.modalStart` directly rather than firing
  it via `execTool` and returning early, restores the `try`/`finally` around `cb()` so
  `undoStepEnd` always runs, and `AsyncGateOp` overrides `on_keydown` to a no-op so Escape
  can no longer end the input lock while the async work is still pending.
  `tests/nodeeditor_view.test.ts:399-429` needs one `await` added — a contained, named
  fix, not a re-opened ripple.
- **Finding 4 (`written: false` doesn't typecheck)** → the aggregate record now omits
  `written` entirely on a successful close, matching how `moveBody` omits it whenever
  nothing was restored.
- **Finding 5 (rollback commit had no `commands.jsonl` entry)** → `failCheckpoint` now
  builds a synthetic `stack.checkpointRollback` record and calls both `this.record(record)`
  and `this.commit(true, record)`, mirroring `moveBody`'s own two calls exactly.
- **Findings 6 and 7 are left open, deliberately, rather than silently resolved:**
  - Finding 6 (the 30s timeout is sized against the wrong cost — actual risk is many
    per-node git-commit subprocesses inside a large batch, not image generation) has an
    available fix (force every inner command in a checkpoint to defer its commit
    regardless of its own standalone flag, landing one commit at a successful
    `endCheckpoint` instead of N along the way) — but that changes the commit-on-save
    granularity this plan currently declares [out of scope](#not-in-scope), so it needs a
    decision rather than a silent edit.
  - Finding 7 (`CommandStack.beginCheckpoint`/`endCheckpoint` collides in name, not in
    behavior, with the pre-existing `Committer.checkpoint()`) is a naming call — the user
    chose "checkpoint" for this feature by name in the conversation that produced this
    plan, so renaming it is not this revision's call to make unilaterally.

This second revision has not itself been pressure-tested yet.

### Revision 3: the two remaining decisions, and a correctness gap found while answering a question about the agent

- **Finding 6 (timeout sizing)** → resolved by decision: `CHECKPOINT_TIMEOUT_MS = 120_000`
  (two minutes), sized against the real cost driver the second pass identified
  (per-command git-subprocess overhead across a large batch), not the originally-assumed
  IPC latency.
- **Finding 7 (naming collision)** → resolved by decision: `Committer.checkpoint()` is
  renamed to `Committer.sweep()`, its `Vn-Checkpoint: true` trailer to `Vn-Sweep: true`,
  per §1's new "Naming" note — the user's own call, since "checkpoint" was their chosen
  name for the feature this plan adds, not the pre-existing one.
- **New finding, not from a review pass:** asked how this design interacts with the
  desktop app's authoring agent, checking `docs/reference/command-system.md` and
  `packages/commands/src/undo.ts` directly (not run through a fresh-context review)
  surfaced that `failCheckpoint`'s "no drift check first" reasoning in every prior draft
  was wrong given the agent's *current*, unwired architecture — see "Interaction with the
  authoring agent" in §1 above for the failure mode and the fix (scoping the drift check
  to paths outside the checkpoint's own `written` sets, rather than skipping it). This is
  exactly the kind of thing a fresh pressure-test pass exists to catch, so the revised §1
  should be checked again rather than taken on faith because it was found "the same way."

### Third pass: the drift check and the two decisions

Pressure-tested against the actual code (`packages/commands/src/stack.ts`, `command.ts`,
`undo.ts`, `content.ts`, `commit.ts`, `apps/desktop/src/main/index.ts`,
`apps/desktop/src/main/commands/gengraph.ts`, `apps/desktop/src/main/workspace.ts`,
`packages/authoring/src/tools.ts`, `packages/commands/src/tests/commit.test.ts`). Scoped
to Revision 3's two decisions and the new drift-check mechanism only, per the review
brief — findings already settled in the first two passes are not re-litigated.

1. **The drift check's one input, `CommandRecord.written`, is never set on the exact kind
   of record that triggers it.** `runCommand`'s catch block (`stack.ts:222-233`) builds a
   failed command's record with no `written` field at all — confirmed by reading the code;
   only the success branch (`stack.ts:206`) copies `output.written` across. `failCheckpoint`
   runs precisely because an inner command failed, so the one record most likely to carry
   an unreported partial write — the failing command's own — is structurally excluded from
   the "expected" union `failCheckpoint` builds before deciding whether to restore.
   `stack.ts:192`'s own comment states the premise this fix ignores: "a command that fails
   partway through can still have written files, and only the pre-state describes where it
   started." Today's `gengraph.*` commands (routed through the shared `edit()` helper,
   `gengraph.ts:70-85`) happen not to trip this, only because their one write goes through
   `writeFileAtomic` (`packages/util/src/fs.ts:20-29`, temp-file-then-rename) and their only
   throw point (`decide()` failing) sits before any write — an aborted `gengraph.*` command
   leaves nothing on disk to misattribute. That is an accident of the current command set,
   not a property the mechanism enforces or the plan states. A future command, or a
   `gengraph.*` command later changed to write more than one file, that throws after a
   partial write reproduces exactly the false "unaccounted drift" the check exists to avoid
   — refusing the one rollback that would clean up its own failure.

2. **No diff primitive exists between two tree hashes; the plan's "diff `openCheckpoint.pre`
   against `journal.currentTree()`" names an operation that has to be built.**
   `ContentStore.restore()` (`content.ts:311-318`) and `UndoJournal.restore()`
   (`undo.ts:126-138`) produce a `changed` path list only as a side effect of actually
   writing and deleting files on disk — calling either one to "see what would change" would
   perform the write. Neither file offers a read-only tree-to-tree diff. This is a real,
   moderate-sized addition (a recursive walk over two `TreeEntry[]` trees, structurally
   close to `restoreDir` minus the `fs` calls) that the plan should name as new code, not
   describe in passing as though `pre` and `currentTree()` were already comparable off the
   shelf.

3. **The rename is incomplete against the plan's own stated goal.** §1's "Naming" paragraph
   claims two call sites (`apps/desktop/src/main/index.ts:414`, `commit.test.ts:134`) plus
   "every mention" in the docs. Grepping `apps/desktop/src/main/index.ts` for "checkpoint"
   independently turns up five more references the rename doesn't cover: comments at lines
   401, 411-413 and 419 ("Everything down to the checkpoint spawns `git`...", "Before the
   checkpoint...", "Opened only after the checkpoint..."), a `console.log` at line 416
   (`` `[vnstudio] checkpoint ${c.sha...}` ``), and a comment at line 504 ("before the
   open-time checkpoint has swept the worktree"). `commit.ts:146`'s fallback subject string
   `'Checkpoint'` (used when `reason` is empty) and `commit.test.ts:130`'s
   `it('marks a checkpoint as its own kind of event', ...)` description are two further
   textual mentions outside the two named "call sites." None of these break anything left
   as-is, but the plan's own reason for the rename — "so `grep checkpoint` in this codebase
   means the one thing defined here" — does not hold with this list untouched.

4. **A second, unrelated writer already bypasses the checkpoint's serialization at the git
   level, not only at the document-tree level, and neither revision mentions it.** The new
   "Interaction with the authoring agent" prose scopes the risk to `UndoJournal`'s
   whole-tree snapshot/restore. But `packages/authoring/src/tools.ts:1824` has the agent's
   plan-approval flow call `ctx.git.commit(...)` directly — a second `Git` handle, entirely
   outside `CommandStack`, `this.chain`, and `Committer`. A checkpoint's own inner
   `gengraph.*` commands each run their own `git commit -A` (`stack.ts:214`, serialized only
   on `openCheckpoint.tail`), so an agent's plan-approval commit landing mid-checkpoint is a
   second, unsynchronized `git commit` invocation against the same repository at the same
   time. Whether git's own locking turns that into a clean failure or something worse isn't
   established either way in this plan; it is simply not discussed.

**Checked and found to hold up:**

- **The scenario is not moot.** `UNDO_EXCLUDES` (`apps/desktop/src/main/workspace.ts:47-53`)
  excludes `vngen/build`, `vngen/state`, `assets/objects`, `keys`, and the session file —
  none of which cover the screenplay/character/storyboard documents
  `@vn/scriptedit`/`@vn/artgen` write. A whole-tree diff would genuinely catch an agent's
  concurrent scene edit; this part of the revision's premise is correct.
- **The reverse case — a `written` path that doesn't show up as changed — is inert.** It
  only shrinks how much of the diffed set a command accounts for; it cannot by itself
  manufacture a false "unaccounted drift" refusal.
- **No new race from the checkpoint's own commands.** `failCheckpoint` runs either
  synchronously inside the same tail-chain `.then()` that produced the failing `outcome`
  (nothing else on `openCheckpoint.tail` can be mid-flight at that instant, since the tail
  runs one command fully before starting the next) or, on timeout, only after explicitly
  awaiting `openCheckpoint.tail`. No checkpoint-owned command can be mid-write and
  unrecorded at the moment the diff is taken.
- **The refusal branch doesn't reopen the round-1 unbounded-hold wedge.** `failCheckpoint`
  only sets `openCheckpoint.failed`; clearing `openCheckpoint` and releasing the
  chain-holding gate happens in `endCheckpoint`, on an explicit call or forced by the
  timeout, and that happens whether the restore ran or was refused. A refused rollback
  still resolves within `CHECKPOINT_TIMEOUT_MS` at the latest.
- **`CHECKPOINT_TIMEOUT_MS = 120_000` collides with nothing found in this codebase.** No
  `ipcRenderer.invoke` timeout exists (Electron's has none built in), no `apps/desktop`
  `jest` config overrides `testTimeout`, and no "still working" UI-indicator constant
  exists to compare it against.

**Verdict:** the drift-check mechanism as specified is not sound as written — not because
scoping the check to outside-the-checkpoint paths is the wrong idea, but because it rests
on a field, `CommandRecord.written`, that this same codebase already documents as
unreliable in exactly the circumstance the check runs in (a command that failed partway
through), and because it invokes a tree-diff operation that does not exist yet and is
described as if it did. Before this ships, `failCheckpoint` needs either (a) a real,
non-destructive tree-diff primitive, plus a way to attribute a failing command's own
partial writes despite `written` being absent on its error record, or (b) a more
conservative fallback than "refuse to roll back" for the case where attribution is known to
be incomplete. The rename (finding 3) is a mechanical fix, not a design problem. The
agent/git concurrency gap (finding 4) at minimum needs a sentence in the plan acknowledging
it is unaddressed, even if resolving it is out of this plan's scope.

### Revision 4: dropping the diff, scoping the snapshot instead

Rather than fix option (a) or (b) above, this revision abandons after-the-fact drift
detection entirely, for a reason findings 1 and 2 both point at: the diff-based check
needed new code (finding 2) to serve a comparison built on data this codebase's own
`stack.ts:192` already documents as unreliable on failure (finding 1) — fixing finding 2
alone would still leave finding 1 standing, so building the diff primitive was never going
to make the mechanism sound by itself.

- **Findings 1 and 2** → `beginCheckpoint` gains a required `scope` parameter (a single
  root-relative directory); `UndoJournal` gains scoped counterparts to its whole-tree
  `capture`/`currentTree`/`restore` (§1). `failCheckpoint` goes back to restoring with no
  drift check at all — sound this time, because the snapshot structurally cannot contain a
  path outside `scope`, so there is nothing an out-of-band write could do to it. Confirmed
  against the actual source that this scoping is exact, not approximate, for the Gen Graph
  node-editing commands (`packages/gengraph/src/paths.ts:13,22`), and that scene/
  screenplay files the agent touches live outside it. No tree-diff primitive needs
  building; a scoped restore already reports `changed: string[]` the same way the
  whole-tree one does, which is all the aggregate/rollback records need. **Correction from
  the fourth pass below: this note originally gave the scope path itself as
  `'work/graphs'`, which is wrong (it should be `'vngen/work/graphs'`) — fixed in §1, and
  called out rather than quietly edited away, since it's exactly the kind of "confirmed
  against the actual source" claim this plan's own review history says not to take on
  faith.**
- **Finding 3** → §1's "Naming" note now lists every site the third pass found: the two
  comment clusters and the `console.log` in `apps/desktop/src/main/index.ts`, the fallback
  subject string and trailer key in `commit.ts`, and the test description in
  `commit.test.ts`, alongside the two call sites named before.
- **Finding 4 (the agent's own `git commit` racing a checkpoint's inner commits at the git
  level)** is recorded here rather than fixed: `packages/authoring/src/tools.ts:1824`'s
  plan-approval commit bypasses `CommandStack` the same way the agent's document writes do,
  and this plan does not resolve that — it is a pre-existing gap in how the agent commits
  relative to the desktop app's own commit machinery, not something checkpoints introduce
  or make meaningfully worse (the agent could already race an ordinary, non-checkpoint
  command's commit today, with or without this plan). Left as a known, out-of-scope
  limitation rather than silently ignored.

This revision has not itself been pressure-tested yet.

### Fourth pass: scoping instead of diffing

Pressure-tested against the actual code (`packages/store/src/paths.ts`,
`packages/gengraph/src/paths.ts`, `packages/gengraph/src/blobs.ts`,
`packages/commands/src/undo.ts`, `content.ts`, `command.ts`, `stack.ts`,
`apps/desktop/src/main/index.ts`, `workspace.ts`, `session.ts`,
`apps/desktop/src/main/commands/gengraph.ts`, `apps/desktop/renderer/pathux/doctree.ts`,
`apps/desktop/src/shared/writes.ts`). Scoped to Revision 4's scoping mechanism only, per the
review brief.

1. **The scope string this revision hinges on is wrong: `'work/graphs'` is not where graph
   documents live.** `UndoJournal`'s `root` is the bare project root — the same `root` object
   passed into `context: { root, ... }` that `gengraph.ts`'s commands use as `ctx.root`
   (`apps/desktop/src/main/index.ts:720-733`). `ProjectPaths.work` resolves to
   `<root>/vngen/work` (`packages/store/src/paths.ts:75-80`: `vngen` joins `'vngen'` onto
   `root`, `work` joins `'work'` onto `vngen`), so `graphsDir()`
   (`packages/gengraph/src/paths.ts:13-15`, cited correctly by line number in §1) is
   root-relative `vngen/work/graphs`, not `work/graphs` — independently confirmed by
   `apps/desktop/src/shared/writes.ts:41`: `export const GRAPH_DOCS_DIR = 'vngen/work/graphs';`.
   §1's own sentence — "every one of its writes already goes through `graphDocFile`/`graphsDir`
   ... which resolve under `work/graphs` and nowhere else — confirmed by reading the source
   rather than assumed" — is the one claim in this revision that reading the cited source
   actually contradicts. Concretely, `captureScoped('work/graphs', seq)`
   (`fs.stat(join(root, 'work/graphs'))`) stats a directory that does not exist and, per its
   own sketch, returns `null`. Every `GenGraphEditor` checkpoint would silently capture
   nothing and, on failure, `restoreScoped` would restore nothing — the real graph documents
   at `vngen/work/graphs` are never touched by either side of the mechanism. This is not a
   narrower-than-needed scope; it is a scope that points at an empty directory next to the
   one that matters, so "sound because nothing outside `scope` can be touched" is true only
   because nothing *inside* the intended scope is captured either.

2. **Neither `captureScoped`'s `null` return nor a null `pre` is handled anywhere in the
   sketch, and `journal.point`/`UndoPoint` cannot express it.** `captureScoped` is typed
   `Promise<string | null>` (§1), matching `capture()`'s existing null-when-not-a-directory
   case. But `beginCheckpoint`'s sketch assigns `const pre = await
   this.opts.journal.captureScoped(scope, seq);` straight into `openCheckpoint.pre` with no
   check, and the aggregate record (§1) builds `undo: journal.point(openCheckpoint.pre,
   post)` unconditionally. `UndoPoint.pre`/`post` are non-nullable `string`
   (`packages/commands/src/command.ts:133-135`), and `journal.point(pre: string, post:
   string)` is typed to match — a `string | null` argument does not typecheck. This is the
   same class of miss the second pass caught in finding 4 (`written: false` didn't
   typecheck against `string[] | undefined`), recurring in the one new code path this
   revision adds. Given finding 1, this is not a hypothetical edge case: `pre` is `null` on
   every real checkpoint as specified, so this branch is not a corner case, it is the only
   case.

3. **`endCheckpoint`'s `post` capture uses `currentTreeScoped`, which — mirroring
   `currentTree()` exactly, as §1 states — never pins its tree into `UndoJournal.taken`, so
   the very next `this.prune(journal)` call in the same `endCheckpoint` can garbage-collect
   the checkpoint's own `post` tree before anything reads it.** Ordinary commands avoid this
   because `runCommand` captures *both* sides through `journal.capture(seq)`
   (`stack.ts:195,199`), and `capture()` (`undo.ts:69-75`) always does `this.taken.push({seq,
   tree})`; `currentTree()` (`undo.ts:82-87`) deliberately does not — it exists for read-only
   comparisons, which is exactly how the (now-abandoned) diff-based drift check used it in
   Revision 3. `UndoJournal.prune()` calls `forget(seqs[oldest - 1])`
   (`undo.ts:144-153`), and `forget()` unconditionally ends with `return
   this.store.collect(this.taken.map((s) => s.tree))` (`undo.ts:159-166`) even when nothing
   is old enough to drop (`seq === undefined` short-circuits only the filter, not the
   `collect()` call). `ContentStore.collect()` (`content.ts:164-190`) deletes every tree/blob
   not reachable from its `roots` argument. Since `post`'s hash was never added to `taken`,
   `endCheckpoint`'s own `this.prune(journal)` call — which §1 places immediately after
   taking the `post` capture and before appending the aggregate record — can delete the very
   tree the aggregate record's `undo.post` is about to name, unless it happens to coincide
   with a tree already reachable from an unrelated `taken` entry. The practical effect: a
   checkpoint's own successful-close undo point can be unredoable (`journal.check` reports
   "that command's snapshot is no longer held", `undo.ts:100-103`) immediately after the
   checkpoint that created it, not after `keep` commands' worth of later activity the way
   pruning is supposed to work.

4. **The claim that "every one of [`gengraph.*`'s] writes" stays under the graph-docs
   directory is false in general, even once finding 1's path is corrected — it is true only
   of the specific commands `GenGraphEditor` dispatches.** `gengraphRun`
   (`apps/desktop/src/main/commands/gengraph.ts:598-633`) is `mutating: true` and reports
   `written: [relPath(this.dir, graphJournalFile(project.paths, slug))]`
   (`apps/desktop/src/main/session.ts:5487`); `graphJournalFile` resolves to
   `vngen/state/graphs/<slug>.jsonl` (`packages/gengraph/src/paths.ts:36-38`), and a run also
   writes blob files under `graphBlobDir`/`graphBlobFile`
   (`packages/gengraph/src/blobs.ts:14-15`), also under `vngen/state/graphs/<slug>/` and not
   even named in `written`. Both are outside any `work/graphs` (or `vngen/work/graphs`)
   scope by construction — `state/` and `work/` are siblings under `vngen/`
   (`packages/store/src/paths.ts:75-86`). In the current wiring this does not bite:
   `gengraph.run`/`gengraph.estimate` are dispatched from the document-tree context menu
   (`apps/desktop/renderer/pathux/doctree.ts:372-373`), a path that never has access to
   `GenGraphEditor`'s private `this.checkpoint` field, so neither would ever be passed a
   checkpoint handle; separately, `vngen/state` is already outside ordinary whole-tree undo
   via `UNDO_EXCLUDES` (`apps/desktop/src/main/workspace.ts:47-53`). But the plan states the
   soundness argument at the level of the `gengraph.*` id family ("`gengraph.*` is the one
   family this plan wires up"), not at the level of "the specific handful of commands
   `GenGraphEditor.send()` actually calls." A future change that lets a run be bundled into a
   checkpoint (or that widens which commands `send()` routes through `this.checkpoint`)
   would reproduce, silently, exactly the unaccounted-write failure mode scoping was
   supposed to make structurally impossible — because the claim licensing "no drift check
   needed" was never actually checked against `gengraph.run`.

5. **Minor: `captureScoped` passes `this.skip` unmodified into a `ContentStore.capture(dir,
   this.skip)` call where `dir` is already narrowed to the scope subdirectory, and
   `ContentStore.captureDir` computes exclusion matches relative to whatever root it is
   given** (`content.ts:249-262`: `rel` is built relative to the passed-in `root`/`dir`, and
   checked against `skip.has(rel)`). `this.skip`'s entries (`'vngen/build'`, `'vngen/state'`,
   `'assets/objects'`, `'keys'`, `.vnstudio/session.json'` —
   `apps/desktop/src/main/workspace.ts:47-53`) are relative to the *project* root, so none of
   them can ever match a `rel` computed under a scope subdirectory. This is inert rather than
   wrong for the one scope in play — none of `UNDO_EXCLUDES` nests inside the graph-docs
   directory — but it means the exclude set silently does nothing for every scoped capture,
   which the plan doesn't state. A future scope that nested inside (or contained) one of
   those excluded paths would need `skip` re-relativized to `dir`; nothing today would
   surface the gap.

**Checked and found to hold up:** `graphLibDir` is genuinely nested inside `graphsDir`
(`packages/gengraph/src/paths.ts:18-20`: `join(graphsDir(paths), 'lib')`), so a single scope
directory is structurally sufficient for the node-edit command family once its value is
corrected — group definitions are not a sibling directory needing a second scope string, as
§1's own reasoning assumed. The concurrency, timeout and rollback-commit machinery carried
over unchanged from the third pass were not re-examined here, per the review brief.

**Verdict:** the scoped-snapshot mechanism is not sound as specified, and the two most severe
findings (1 and 3) are not edge cases — they fire on every checkpoint `GenGraphEditor` would
ever open. Finding 1 (wrong scope string) means the mechanism currently protects and restores
nothing at all, which is a stronger failure than the whole-tree drift-check gaps rounds 1-3
found, because those at least captured the right tree; this captures an empty one. Finding 3
(unpinned `post` tree) would still break redo even after finding 1 is fixed. Before this
ships: (a) fix the scope literal to `'vngen/work/graphs'`, (b) decide what `beginCheckpoint`
does when `captureScoped` returns `null` (refuse the checkpoint, the same way whole-tree
`capture()` returning `null` degrades to "no undo point" today, rather than assigning it into
a field typed to require a string), (c) make the checkpoint's `post` capture use a
`taken`-pinning path (e.g. a scoped `capture` rather than a scoped `currentTree`) so
`prune()` cannot collect it out from under the record that names it, and (d) narrow the
"every write stays in scope" claim to the exact command set `GenGraphEditor` dispatches
rather than the whole `gengraph.*` namespace, since `gengraph.run` is a concrete
counterexample to the broader claim even if not currently reachable through a checkpoint.

### Revision 5: fixing (a)–(d), all four addressed directly in §1

Each of the fourth pass's four required fixes is now applied, in the same order:

- **(a) Scope literal corrected** to `'vngen/work/graphs'` everywhere it appears — §1's
  scope discussion, the "Interaction with the authoring agent" prose, and
  `GenGraphEditor.delegate()`'s `beginCheckpoint` call in §6. Verified independently via
  `packages/store/src/paths.ts`'s `ProjectPaths.work` and
  `apps/desktop/src/shared/writes.ts:41`'s `GRAPH_DOCS_DIR`, not just re-trusted from the
  same `paths.ts` reasoning that produced the wrong literal the first time. Revision 4's
  own now-incorrect claim is corrected in place with a note explaining why, rather than
  silently rewritten, per this plan's own practice of not erasing a wrong claim once it
  was believed and acted on.
- **(b) `null` handling specified**: `captureScoped` returning `null` (scope directory
  doesn't exist yet) makes `beginCheckpoint` reject with `` `no ${scope} to checkpoint`
  `` rather than assign `null` into `UndoPoint.pre: string`. Noted that the corrected path
  makes this unreachable in practice for `GenGraphEditor` specifically (a node can't be
  selected to delete/duplicate unless its graph document, and therefore
  `vngen/work/graphs`, already exists) — but `beginCheckpoint` is a general `CommandStack`
  method, not a `GenGraphEditor`-only one, so it still has to answer the question.
- **(c) `post` capture pinned**: `endCheckpoint` now calls `journal.captureScoped(scope,
  openCheckpoint.seq)` — the pinning method, tagged with the checkpoint's own `seq` so it
  survives `prune()` exactly like an ordinary command's `pre`/`post` pair — instead of the
  non-pinning `currentTreeScoped` the previous draft used by analogy with `currentTree()`
  without checking whether pinning mattered here.
- **(d) The "every write stays in scope" claim narrowed**: §1 now states plainly that
  `'vngen/work/graphs'` is exact for the Gen Graph node-editing command family
  (`addNode`/`removeNode`/`link`/`unlink`/`setProp`/`moveNodes`/`setActiveOutput`/
  `duplicateNode`) and explicitly not for `gengraph.run`/`apply`/`estimate`, which write
  under `vngen/state/graphs/` and are never dispatched through a checkpoint today — and
  states the general rule this implies (`scope` is a fact about what a *specific*
  checkpoint's commands write, decided by whoever opens it, not a fact about a whole
  command namespace). A lightweight success-path check (comparing a successful inner
  command's own `written` against `scope`) is added as well, to catch a future violation
  of that rule without relying on `written` for anything the failure path needs, since
  `written` is only reliable on success.

On finishing the plan, update any related documentation in the main repo and in pathux.

This is the plan's fifth revision. It has not itself been pressure-tested.

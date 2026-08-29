# Undo checkpoints: grouping several commands into one undo point

Status: **shipped**

This is a condensed rewrite of a plan that went through five review-driven revisions.
Only the final, resolved design is kept below; the revision history and the bugs each
pass found have been folded into the design rather than narrated. Implementers should
still sanity-check the design against the code before relying on any specific claim
below (line numbers, "every write stays in scope," etc.) — that habit is what caught the
bugs the earlier drafts had.

## What this builds

A way to run several `@vn/commands` invocations as one undo point. Today every
undoable, mutating command gets its own content-addressed snapshot pair (`pre`/`post`)
and its own entry in the undo stack (`packages/commands/src/stack.ts`, `seq`
incremented once per command). Deleting or duplicating several selected nodes in the
Gen Graph editor dispatches one `gengraph.*` command per node, so undoing that one
gesture today takes one Ctrl+Z per node.

Adds `CommandStack.beginCheckpoint(shortLabel, message, scope)` /
`CommandStack.endCheckpoint(handle)`, threads a `CheckpointHandle` through
`exec()`/`execDsl()`, and wires `apps/desktop`'s IPC and renderer bridge so
`GenGraphEditor` can open a checkpoint, run several commands into it, and close it as
one undo/redo entry — with automatic rollback to the checkpoint's start if any command
inside it fails.

Also extends `vendor/path.ux`'s `NodeGraphDelegate.undoStepBegin`/`undoStepEnd` to
carry a short label and a long message, so `NodeGraphView.deleteSelected()`/
`duplicateSelected()` can hand a host delegate text to open a checkpoint with.

## Why

Raised while fixing `GenGraphEditor` after the path.ux commit that added
`NodeGraphDelegate.undoStepBegin`/`undoStepEnd` (for path.ux's own generic
`ToolOpDelegate` to batch its `ToolMacro` calls). `GenGraphEditor` doesn't use that
toolstack — it dispatches `gengraph.*` commands directly — so those two methods were
left as no-ops there, which is what produces the one-undo-point-per-node behavior this
plan fixes.

## Scope

Touches `packages/commands`, `apps/desktop` (main, shared, and the renderer's
`pathux/editors/nodes.ts` and `pathux/bridge.ts`), and `vendor/path.ux`'s node-editor
files. Does not touch commit-on-save granularity, `@vn/testkit`, the CLI, or
`packages/authoring` — see [Not in scope](#not-in-scope).

## Design

### 1. Rename the pre-existing `Committer.checkpoint()` first, as its own commit

`packages/commands/src/commit.ts:145`'s `Committer.checkpoint(reason)` — the open-time
sweep commit under a `Vn-Checkpoint: true` trailer
(`docs/reference/repos-and-commits.md:93-96`) — is unrelated to undo grouping and
shares only the English word with the feature below. Rename it to `Committer.sweep(reason)`
and its trailer to `Vn-Sweep: true` before starting the feature work, as a separate
mechanical commit. Every site (found by grepping `checkpoint` case-insensitively):

- `packages/commands/src/commit.ts:145` (method), `:146` (fallback subject string
  `'Checkpoint'`, and the `'Vn-Checkpoint'` trailer key).
- `packages/commands/src/tests/commit.test.ts:130` (`it(...)` description), `:134`
  (call site), `:140` (asserts `'Vn-Checkpoint: true'`).
- `apps/desktop/src/main/index.ts:401, 411, 413, 419, 504` (comments), `:414` (call
  site), `:416` (`console.log` reading `` `[vnstudio] checkpoint ${c.sha.slice(0,
  8)} in ${c.repo}` ``).
- `docs/reference/repos-and-commits.md:93-96, 116-117, 165, 172, 229, 245` (every
  prose mention).

### 2. `packages/commands/src/stack.ts`: the checkpoint itself

```ts
export interface CheckpointHandle {
  readonly seq: number;
}
async beginCheckpoint(shortLabel: string, message: string, scope: string): Promise<CheckpointHandle>;
async endCheckpoint(handle: CheckpointHandle): Promise<CommandOutcome>;
```

`CheckpointHandle` is deliberately just `{ seq: number }` — no methods, no closed-over
state — so it round-trips over IPC unchanged.

**Scope.** `scope` is a single root-relative directory the checkpoint's snapshot is
confined to. `UndoJournal` gains scoped counterparts to its whole-tree
`capture()`/`currentTree()`/`restore()`: `captureScoped(subpath, seq)`,
`currentTreeScoped(subpath)`, `restoreScoped(subpath, from, point, side)`, each passing
`join(this.root, subpath)` as `ContentStore`'s root. `captureScoped` returns `null`
when the scope directory doesn't exist yet (the scoped analog of whole-tree
`capture()`'s "root is not a directory" case); `beginCheckpoint` treats that as fatal —
reject with `` `no ${scope} to checkpoint` `` and never set `openCheckpoint` — rather
than assigning `null` into `UndoPoint.pre: string`. `this.skip` (the whole-tree exclude
list) is passed through unmodified; none of its entries nest inside the graphs
directory, so it's inert here, not wrong.

**Confirmed exact scope value: `'vngen/work/graphs'`** (not `'work/graphs'` —
`ProjectPaths.work` is `<root>/vngen/work`; independently confirmed by
`apps/desktop/src/shared/writes.ts:41`'s `GRAPH_DOCS_DIR`). This is exact for the Gen
Graph node-editing command family this plan wires up
(`addNode`/`removeNode`/`link`/`unlink`/`setProp`/`moveNodes`/`setActiveOutput`/
`duplicateNode`), all of which write only through `graphDocFile`/`graphsDir`. It is
**not** exact for `gengraph.run`/`apply`/`estimate`, which write run-journal and blob
state under `vngen/state/graphs/` — those are never dispatched from
`GenGraphEditor.delegate()`'s checkpointed path today, but `scope` must be understood
as "what this specific checkpoint's commands are expected to write," decided per
checkpoint by whoever opens it, not a fact about a whole command-id namespace. A
lightweight success-path check (comparing a successful inner command's own `written`
against `scope`, logging rather than refusing on mismatch) catches a future violation
of that rule; it can't do anything for a failing command's own unrecorded partial
write, and doesn't need to — see the rollback design below.

**Why no drift check on rollback.** Earlier drafts tried to detect an out-of-band write
(e.g. from the authoring agent, which currently writes scene/screenplay files directly,
bypassing `CommandStack` entirely — `docs/reference/command-system.md`'s "From the
agent" section: wiring the agent's tool loop to the registry is a stated, not-yet-shipped
follow-on) by diffing `pre` against the tree at failure time. That check is unsound: it
relies on `CommandRecord.written`, which a *failing* command's record never has
(`runCommand`'s catch path doesn't set it) — exactly the case most likely to need it. The
scoped snapshot sidesteps the problem instead of solving it: an agent edit to a scene or
screenplay file lives outside `vngen/work/graphs`, so it is never captured by this
checkpoint's snapshot in the first place, and there is nothing for a rollback to
reconcile. The cost is that a checkpoint can only safely group edits that stay within
one declared subtree; a future checkpoint spanning two subsystems reopens this question.
(A separate, un-fixed gap: the agent's plan-approval flow, `packages/authoring/src/tools.ts:1824`,
calls `git.commit()` directly through its own `Git` handle, outside `CommandStack`
entirely — a checkpoint's own inner commits are serialized only on its own `tail`, so an
agent commit landing mid-checkpoint is a second, unsynchronized `git commit` against the
same repo. This is a pre-existing condition the agent could already trigger against any
ordinary command today, not something checkpoints introduce; left as a known limitation.)

**Concurrency.** `CommandStack` is one instance shared by every window, the agent, CDP
and the DSL. `exec()`/`execDsl()` grow an optional final `CheckpointHandle` parameter:

- No handle, no checkpoint open → today's behavior.
- No handle, a checkpoint **is** open → queues behind it via `this.serialize(run)`
  exactly like any other in-flight mutating command (slower than intended, but correct
  — this is the foot-gun case for a caller that forgot the handle).
- Handle passed but stale (wrong seq, or none open) → refuse immediately:
  `{ ok: false, error: "no open checkpoint <seq>" }`.
- Handle passed and current → chains onto `openCheckpoint.tail` (a per-checkpoint
  mini-chain, `Promise.resolve()` initially) instead of `this.chain`, so however many
  `command:exec` calls arrive concurrently from the renderer's fire-and-forget dispatch,
  main runs them one at a time in arrival order, and the instant one fails everything
  still queued behind it on that tail is refused.

**Holding `this.chain` across two calls.** `beginCheckpoint` occupies `this.chain` from
when it returns until `endCheckpoint()` releases it, via a manually-resolved gate inside
a `this.serialize(...)` call: flush any pending deferred-commit batch, take the `pre`
capture, set up `openCheckpoint` (with a `release()` closure and a timeout timer),
resolve the returned handle, then `await gate` to hold the chain open until
`endCheckpoint`/timeout releases it.

**Timeout.** `CHECKPOINT_TIMEOUT_MS = 120_000` (two minutes) — sized against the real
cost driver (every non-deferring `gengraph.*` node command inside a checkpoint still
commits individually, serialized on `openCheckpoint.tail`, so a batch of a few hundred
nodes is a few hundred real `git commit` subprocesses before `endCheckpoint` can even
take its `post` capture), not against IPC latency. `timeoutCheckpoint(seq)` runs
`failCheckpoint` then forces the same close `endCheckpoint` would run. A late
`endCheckpoint` call after the timeout fired sees a cleared `openCheckpoint` and answers
the same stale-handle refusal as any other. `clearTimeout` on every exit path.

**`failCheckpoint(openCheckpoint, error)`** — the one rollback path, used by both an
inner-command failure and a timeout:

- Sets `openCheckpoint.failed = error`, refusing further checkpoint-tagged `exec()`.
- Restores to `openCheckpoint.pre` via `restoreScoped` — no drift check (see above).
- Builds a synthetic `CommandRecord` (`id: 'stack.checkpointRollback'`, `status:
  'error'`, `checkpoint: openCheckpoint.seq` so `undoCandidate` skips it, message
  `` `Rolled back "${shortLabel}": ${error}` ``) and calls **both** `this.record(record)`
  and `this.commit(true, record)` — the same two calls `moveBody` makes for an ordinary
  restore, so the rollback's commit lands in `commands.jsonl` with a reason attached
  rather than as an unexplained dirty-then-clean worktree, and so it retires any commit
  an inner command already made individually before the failure.
- Drops any still-`pending` deferred-commit record from the failed checkpoint, so a
  later flush can't commit the now-reverted content under its message.
- Calls `this.prune(journal)`, same as every other capture/restore path.
- Appends **no aggregate** undo-stack record — the checkpoint net-changed nothing from
  the author's perspective. The rollback record above is persisted for provenance only.

**`endCheckpoint(handle)`:**

- Refuses if `handle.seq` doesn't match `openCheckpoint?.seq`.
- Awaits `openCheckpoint.tail` first, so a still-queued command gets to run or be
  refused before closing.
- If `openCheckpoint.failed` is now set, the failure path above already ran: return
  `{ ok: false, error: openCheckpoint.failed }`, clear `openCheckpoint`, release.
- Otherwise takes the `post` capture via **`journal.captureScoped(scope, seq)`** — not
  `currentTreeScoped`. This distinction matters: `captureScoped` pins the tree into
  `journal.taken` under the checkpoint's own `seq`, the same way `pre` was pinned;
  `currentTreeScoped` (the non-pinning analog of `currentTree()`) does not, and the very
  next `this.prune(journal)` call could then garbage-collect the checkpoint's own `post`
  tree before anything reads it, silently breaking redo. Then: `this.prune(journal)`,
  append one aggregate `CommandRecord` (below), clear `openCheckpoint`, release, return
  `{ ok: true, record }`.

**The aggregate record**, appended on a successful close:

```ts
{
  seq: openCheckpoint.seq,
  id: 'stack.checkpoint',
  invocation: `stack.checkpoint(seq=${seq})`,  // synthetic, non-replayable, for commands.jsonl consistency
  label: shortLabel,
  props: {},
  source: 'ui',
  mutating: true,
  status: 'ok',
  message,
  undo: journal.point(openCheckpoint.pre, post),
  // no `written`: CommandRecord.written is string[] | undefined, set only when a
  // command's own commit actually wrote paths; this record's own `run` writes nothing
  // new itself, matching how moveBody omits `written` whenever nothing was restored.
  gitHead, gitDirty, startedAt, finishedAt,
}
```

No separate commit call on a successful close: every inner command already committed
(or deferred) under commit-on-save's existing, unchanged rules.

### 3. `packages/commands/src/command.ts`: two new `CommandRecord` fields

- `label?: string` — a human sentence naming a checkpoint's aggregate record, shown in
  place of `invocation` wherever the UI reads it.
- `checkpoint?: number` — set on every record run inside a checkpoint, naming its
  `seq`; `undoCandidate()` skips these (same shape as its existing `record.stack`
  skip), since the checkpoint's own `stack.checkpoint` aggregate record is the one undo
  point that stands in for the group.

`stack.ts` changes to use them:

- `undoCandidate()` gains `if (record.checkpoint !== undefined) continue;`.
- `undoState()`/`moveBody()`'s "Undid/Redid …" text reads `record.label ??
  record.invocation`.
- `runCommand` takes the open checkpoint (if any) from its caller, skips its own
  `pre`/`post` capture when one is open, and stamps `record.checkpoint =
  openCheckpoint.seq` instead of `record.undo`.

### 4. `apps/desktop`: IPC and the renderer bridge

- `apps/desktop/src/shared/ipc.ts`: `CommandExecRequest` gains an optional
  `checkpoint?: CheckpointHandle`; two new channels, `command:checkpointBegin`
  (`{shortLabel, message, scope}` → `CheckpointHandle`) and `command:checkpointEnd`
  (`CheckpointHandle` → `CommandOutcome`).
- `apps/desktop/src/main/index.ts`'s `registerIpc()` gains the two handlers
  (`getStack()` already builds the lazily-created stack instance), and `command:exec`'s
  handler forwards `request.checkpoint` into `getStack().exec(...)`.
- `apps/desktop/renderer/pathux/bridge.ts` gains `beginCheckpoint(shortLabel, message,
  scope)` and `endCheckpoint(checkpoint)` wrapping the two new `api.invoke` calls
  (`endCheckpoint` also calls `report(outcome)`), and `exec()` grows an optional
  `checkpoint?: CheckpointHandle` parameter forwarded into the request body.

### 5. `vendor/path.ux`: the delegate carries the two strings, and the async boundary is real

`NodeGraphDelegate.undoStepBegin`/`undoStepEnd` widen to `Promise<void>` and take
`(ctx, shortLabel, message)` / `(ctx)`. `perform` stays synchronous — it doesn't need
to change, because ordering inside a checkpoint is enforced on the main-process side
(the per-checkpoint `tail` chain in §2), not by the renderer awaiting each dispatch.

**`deleteSelected()`/`duplicateSelected()`/`singleUndoStep` become genuinely `async`,
returning real promises.** An earlier draft tried to keep them looking synchronous by
wrapping the async delegate calls in a modal op (`AsyncGateOp`, below) and having
`singleUndoStep` return before the wrapped work settled; that doesn't work; `await`
always defers past the current synchronous turn even against an already-resolved
promise, so no wrapping makes the call finish inline. There is no MVP that avoids this
once a delegate hook does real async work, so the plan stops trying to hide it. The one
concrete fallout: `vendor/path.ux/tests/nodeeditor_view.test.ts:399-429` ("a link is
selectable and delete severs it") calls `view.deleteSelected()` unawaited and asserts
synchronously — needs `await view.deleteSelected();` and its enclosing `it` marked
`async`. No other call site in the test suite calls either method synchronously.

**`AsyncGateOp`** is still useful, but for a narrower purpose than originally proposed:
locking pointer/keyboard input for the duration of the async window (so a second
gesture can't open a competing checkpoint while the first is still closing), not for
faking synchronicity. It reuses path.ux's existing modal-op input lock
(`EventHandler.pushModal`/`pushPointerModal`), overrides `on_keydown` to a no-op (so
Escape can't release the lock mid-flight and leave a checkpoint open with no visible
indicator), and `singleUndoStep` `await`s `gate.modalStart(ctx)` directly — not through
`execTool`'s `void`-returning path — with a restored `try`/`finally` around `cb()` so
`undoStepEnd` (and therefore a real `endCheckpoint`) always runs even if `cb()` throws.

Every `NodeGraphDelegate` implementer needs the widened signature: `ToolOpDelegate`
(`delegate.ts`, stays synchronous internally, wrapped in an already-resolved promise).
`example/editors/nodeeditor/nodeeditor_tab.ts` doesn't implement the interface.
`tests/nodeeditor_edit.test.ts` / `tests/nodeeditor_view.test.ts` build delegate
literals that already omit both methods and typecheck clean today (`tests/*.ts` is
outside `tsconfig.json`'s included set) and don't exercise either method at runtime, so
neither needs the signature change — only the one `await` above.

### 6. `GenGraphEditor`: no ripple into `perform()`/`_dispatch`

`GenGraphEditor.dispatch()` → `send()` stays exactly as today: synchronous local
mutation followed by a fire-and-forget `void exec(...)`. `GenGraphEditor.delegate()`
opens and closes the real checkpoint:

```ts
private checkpoint: CheckpointHandle | undefined;

private delegate(): NodeGraphDelegate {
  return {
    undoStepBegin: async (_ctx, shortLabel, message) => {
      this.checkpoint = await beginCheckpoint(shortLabel, message, 'vngen/work/graphs');
    },
    check: (_ctx, edit) => this.judge(edit),
    perform: (_ctx, edit) => this.dispatch(edit),
    undoStepEnd: async () => {
      if (this.checkpoint) await endCheckpoint(this.checkpoint);
      this.checkpoint = undefined;
    },
  };
}
```

`send()` grows a branch passing `this.checkpoint` into `exec()`'s new parameter when
one is open. `deleteSelected()`/`duplicateSelected()`'s existing synchronous loop over
the selection keeps dispatching per-node without awaiting; main serializes and runs them
in order on `openCheckpoint.tail`, refusing anything still queued once one fails.

On failure, `GenGraphEditor`'s in-memory `this.graph` (mutated eagerly by every
`weighed.decision.apply()` along the way) is stale relative to the rolled-back tree on
disk. The failure path must force a reload (`this.load(this.slug)`), the same way an
ordinary refused write already sets `this.sync.stale = true` to trigger one.

## Not in scope

- **Commit-on-save granularity.** A checkpoint groups undo, not git commits; every
  inner command still commits/defers under its own existing rules.
- **Nested checkpoints.** `beginCheckpoint` while one is open throws.
- **DSL/CDP-driven checkpoints.** `execDsl` grows the parameter for symmetry with
  `exec`, but no DSL syntax to open/close one is added.
- **`@vn/testkit` and the CLI.** Neither drives multi-command UI gestures.
- **path.ux's `ToolOpDelegate`/`ToolMacro` undo grouping.** Unrelated, already-shipped
  mechanism; its `undoStepBegin`/`undoStepEnd` just widen to match the interface.

## Open questions / known limitations

- **Token-vs-method handle shape:** resolved — a bare `{seq}` token is right, since it
  has to cross IPC as plain data; a bound-method handle would need its own IPC wrapper
  type anyway. A stale handle just fails to match once its checkpoint closes.
- **Empty checkpoint (zero commands before `endCheckpoint`):** confirmed to fall out of
  existing logic for free — `journal.point(pre, post)` with `pre === post` produces
  `changed: false`, and `undoCandidate()` already walks past that, same as any no-op
  command.
- **Exact short/long label wording** for `deleteSelected()`/`duplicateSelected()` is
  left open — settle it against actual tooltip/toast rendering rather than in the
  abstract.
- **Agent/git concurrency gap** (noted in §2): the authoring agent's plan-approval flow
  commits directly through its own `Git` handle, outside `CommandStack` and this
  checkpoint mechanism entirely. Not introduced or worsened by this plan, but not
  resolved by it either — left as a known, pre-existing limitation.

## As shipped

No sixth pressure-test pass was run on this condensed plan before implementation — the
five rounds folded into **Design** above cover the design, not this specific write-up of
it. Implemented in the order **Design** lists, one commit per numbered section (the
`Committer.sweep()` rename first, as its own mechanical commit); nothing it described
turned out to be wrong against the code. Six things the plan left open or unshown in its
sketches, and what was decided:

- **`endCheckpoint`'s post-capture failure is treated as fatal.** `UndoJournal.point`'s
  `pre`/`post` are non-nullable `string`s, so a `null` back from `journal.captureScoped`
  (the scope directory vanished between open and close) can't be assigned in; it calls
  `failCheckpoint` and refuses, mirroring how `beginCheckpoint` already treats a `null`
  `pre` capture.
- **`failCheckpoint` tolerates a `null` `currentTreeScoped`** (the scope directory is
  already gone) by skipping the restore step and logging a warning rather than throwing,
  consistent with `stack.ts`'s existing "degrade gracefully, log, never let bookkeeping
  fail the command" pattern.
- **Settled the label-wording open question above:** `deleteSelected()`/
  `duplicateSelected()` pass `("Delete", "Delete selected nodes")` and `("Duplicate",
  "Duplicate selected nodes")` through to `beginCheckpoint`.
- **`GenGraphEditor.delegate()`'s `undoStepBegin` reports and rethrows a `beginCheckpoint`
  rejection** (`say(...)`, then rethrow) — not shown in §6's sketch. Rethrowing means
  `AsyncGateOp` never runs `cb`, so a refused open dispatches nothing; nothing was
  written, so nothing needs a reload.
- **`undoStepEnd`'s failure branch forces a reload** through the existing
  `sync.stale`/`shouldReload` pair `send()` already uses for a refused write, per §6's
  prose ("the failure path must force a reload") rather than adding a separate mechanism.
- **path.ux's own test suite carries 14 pre-existing failures** (`graph_api`,
  `graph_ops`, `graph_socket`, `nodeeditor_edit` — a `defaultProp`/`copy()` issue
  unrelated to this plan), confirmed present on the branch tip before any of this
  plan's commits by stashing and re-running. Not touched by this work.

Related documentation updated: [`../../reference/command-system.md`](../../reference/command-system.md#checkpoints-group-several-commands-into-one-undo-point),
[`../../reference/repos-and-commits.md`](../../reference/repos-and-commits.md), and
[`../../reference/desktop-app.md`](../../reference/desktop-app.md) in this repo;
`documentation/NodeEditor.md` in `vendor/path.ux`.

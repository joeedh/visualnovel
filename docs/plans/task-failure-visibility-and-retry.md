# Task failure: visibility and retry

Status: **shipped.** See [As shipped](#as-shipped). Two gaps in the scheduler, found by the end-to-end
acceptance test of [`script-composition-in-studio.md`](script-composition-in-studio.md) and
recorded in that plan's step 8 rather than fixed there: a failed task does not record why, and a
failed task is terminal while the run still reports success.

<!-- toc -->

<!-- tocstop -->

## Why

While generating a scene authored in the desktop app, one `shot_image` task failed. Everything
about that failure was lost:

- `vngen/state/tasks.jsonl` held `{"status":"failed","attempts":[]}` for the hash and **no
  reason**. The message existed for one instant, on the logger's `task.end` event, and the app
  had swallowed stdout.
- The next `vngen run` planned nothing for it and printed `Ran 0 task(s). … Gate cleared — all
  reachable shots generated.` while `vngen status` on the same project reported `failed: 1` and
  the scene had no art.
- Diagnosis took a hand-edit of `tasks.jsonl` (deleting the two log lines for the hash so the
  node would replan). The re-run **succeeded** — the failure was transient. A single retry would
  have cost nothing and saved the whole investigation.

So the money was spent, the frame is missing, no artifact says why, and the CLI says it went
fine. Each of those is a separate defect and this plan fixes them in that order.

## What is broken today

**The reason is thrown away at exactly one line.** `packages/scheduler/src/scheduler.ts:95`:

```ts
graph.setStatus(task.hash, result.status, { output: result.output });
```

`result` is a `TaskResult` (`packages/types/src/model.ts:79`) carrying `error?: string` — built
by the scheduler's own `catch` two lines above, and returned deliberately by `makeShotRunner`
for `needs_human` (`packages/pipeline/src/runners.ts:163`). It is dropped here and again in the
type: `TaskAttempt` has `error?: string` but `Task` (`packages/types/src/tasks.ts:65`) does not.
`setStatus` already does `Object.assign(node, patch)`, so the field is all that's missing.

**Nothing sets `TaskAttempt.error` in production either.** Runners push an attempt record only
after a successful generate (`runners.ts:140`). A task that threw before its first attempt has
`attempts: []`, which is why FLOOR's inspector can say nothing about it: `survivingDefects`
reads the last attempt's reviews, and `Triage` renders only for `needs_human`
(`apps/desktop/renderer/rooms/floor/Inspector.tsx:56`). The renderer already has a `'failed'`
attempt outcome keyed on `attempt.error` (`attempts.ts:82`) — a branch no production code can
currently reach.

**A `failed` node is terminal.** `TaskGraph.ready()` returns `status === 'pending'` only
(`packages/taskgraph/src/graph.ts:32`), and `graph.add` returns the existing node for a known
hash, so re-planning re-derives the same identity and re-finds it `failed`. No code path
anywhere sets a `failed` node back to `pending`.

**The failed shot is invisible in the model too.** `refreshShotData` maps any non-`done`,
non-`needs_human` task to `shot.status = 'prompted'` with the image deleted
(`packages/pipeline/src/planner.ts:121`) — indistinguishable from a shot that never ran. `Shot`
has no `'failed'` status and does not need one; the task graph is the authority.

**The report claims success it cannot support.** `cmdRun` counts failures from
`summary.ran` — this process's transitions — so a failure inherited from an earlier run counts
zero, and the `else` branch prints `Gate cleared — all reachable shots generated.`
(`apps/cli/src/commands.ts:274-288`). The gate genuinely was clear; the sentence's second half
is the lie. `pipeline.run` in the desktop app has the same shape (`ran` and `blockedOnGate`,
nothing about failure).

**Image calls have no retry at all.** `text.structured` retries through `@vn/util`'s `retry`
(`packages/providers/src/structured.ts:65`); `BackendImageProvider` does not, so one 503 from
Gemini is a dead task. And the classification the retry would need is claimed but not
implemented: `ProviderError`'s doc comment says "failed in a way that is **not** retriable"
(`packages/util/src/errors.ts:22`) while `backends/gemini.ts` wraps every failure — transport
blip and content refusal alike — in it.

## Two constraints the fix has to respect

Both were found while designing this and both make the naive version wrong.

**1. `TaskGraph.prune` is never called in production.** The only call sites are its own tests.
So `tasks.jsonl` accumulates **orphans**: when a prompt or a reference changes, the task gets a
new hash and the old node lingers in the log forever. Consequences:

- A blind "requeue every `failed` node" would re-run orphaned work, spending real money on a
  frame nothing wants.
- A blind "report every `failed` node in the graph" would make `vngen run` exit non-zero forever
  for a project that failed once and then had its prompt edited.

The live set is available: `planTasks` returns every task it planned this pass, **including the
deduped existing nodes** (`planned.push(graph.add(task))`, `planner.ts:172`). Both the requeue
and the report must intersect with that set. Pruning the orphans is a separate problem — see
[Out of scope](#out-of-scope).

**2. `attempts.length` is not a retry counter.** A `needs_human` shot has one attempt per P7
refine pass, up to `max_refine_attempts`. Counting those as retries would exhaust a run-level
budget on the very shots the P7 loop handled correctly. The run-level counter must be **attempt
records that carry an `error`**, which only the scheduler writes.

## Design decisions

- **The reason lives on the node, not only in the log line.** `Task.error` is the field; the log
  line is a whole-node snapshot, so it carries it for free, and `loadGraph` replays it with no
  schema change (it is `readJsonl<AnyTask>`, unvalidated).
- **`error` is the reason for the terminal state, whatever the state.** `needs_human` sets it
  too — the P7 give-up sentence the runner already returns and the scheduler already drops.
- **Success clears it.** The scheduler passes `error: result.error` unconditionally; on `done`
  that is `undefined`, `Object.assign` overwrites the stale string, and `JSON.stringify` omits
  the key, so the log stays clean. No "clear" API.
- **Adding the field cannot invalidate anything.** `taskHash` is `hashParts(kind, inputs)`
  (`packages/taskgraph/src/hash.ts:11`) — the node's mutable state is not in its identity.
- **A failure also gets an attempt record.** `{ attempt: n, refs, error, at }`, so the failure
  appears in the causal chain FLOOR already renders, and so the retry budget has a counter that
  survives a restart.
- **Retry is across runs, once per run, before the wave loop.** Requeueing inside the loop would
  re-run a task that just failed, in the same process, against the same transient condition —
  and could spin. Requeueing once, after the first `planTasks` and before the loop, means "a
  fresh `vngen run` retries what the last one lost", which is what a user expects.
- **A dry run requeues in memory and writes nothing.** `vngen cost` should count the retry it
  would perform, and `costPreview` counts `pending` nodes. The requeue is skipped from
  `logTask`, so the on-disk log is untouched; the in-memory divergence dies with the process.
- **`needs_human` is never auto-retried.** It is a request for a human, not a fault. The human's
  path (re-approve, edit the shot) rehashes the task anyway.
- **Transient vs terminal is classified at the backend, which is the only layer that sees the
  status code.** A 429/5xx/transport error retries in place; a 400, a content refusal, or a
  placeholder-reference rejection does not — retrying those is three times the cost for the same
  answer. Default to **not** retryable when the error is unrecognizable.
- **Exit code 1 for a live failed task; 0 for `needs_human`.** A failure means the artifact the
  command promised does not exist. `needs_human` means it exists and wants review.

## Steps

Each step is one commit and leaves `pnpm check` / `pnpm test` / `pnpm lint` green.

### 1. Record the reason ✅

- `packages/types/src/tasks.ts`: add `error?: string` to `Task`, documented as "why the task
  reached a terminal non-`done` state (`failed` or `needs_human`)".
- `packages/scheduler/src/scheduler.ts`: pass `{ output: result.output, error: result.error }`.
- Same site: when `result.status === 'failed'`, push a `TaskAttempt` before `logTask` —
  `attempt: task.attempts.length + 1`, `refs` from the task's inputs where the kind has them
  (`prompt_refine` does not), `error`, `at: now?.()`.
- Tests (`packages/scheduler/src/tests/scheduler.test.ts`): with an image backend that throws,
  the node carries the message, the **last log record** for that hash carries it after
  `loadGraph`, and one failure attempt is recorded. Extend the existing `needs_human` case to
  assert `task.error` is the give-up sentence.
- To inject the throwing backend, add `imageBackend?: ImageBackend` to `@vn/testkit`'s
  `RunOptions` (`packages/testkit/src/project.ts:48`) and thread it into
  `createMockProviders`. `run({ providers })` can already do this by hand; the option keeps the
  test to one line and keeps it on the production path.

### 2. Retry a failed task on the next run, bounded ✅

- `packages/types/src/schemas.ts`: `max_task_attempts: z.number().int().positive().default(2)`
  — total run-level attempts, so the default is one retry. Orthogonal to
  `max_refine_attempts`, which caps the P7 loop **within** one run; say so in the doc comment.
- `packages/scheduler/src/scheduler.ts`: after the first `planTasks` call and before the
  `dryRun` return, requeue. A node is requeued when it is `failed`, its hash is in the planned
  set, and its recorded failure attempts (`attempts.filter((a) => a.error).length`) are under
  the cap. Set `pending`, clear `error`, and `logTask` each one **only when `!dryRun`**.
- `RunSummary` gains `retried: string[]` (the hashes requeued).
- Keep the requeue a small exported function so it is unit-testable without a run
  (`requeueFailed(graph, plannedHashes, max)` → the nodes it changed).
- Tests: a backend that throws on the first call and succeeds after it — first run leaves the
  task `failed` with one failure attempt, second run requeues it and it goes `done` with the
  asset in the manifest. A second test with `max_task_attempts: 1` shows no requeue. A third
  pins the orphan constraint: a `failed` node whose hash is not in the plan is left alone.

### 3. Stop reporting success over a failure ✅

- `RunSummary` gains `failed: AnyTask[]` and `needsHuman: AnyTask[]`, both **intersected with
  the last planning pass's hashes** — capture that pass's `planned` inside the loop.
- `apps/cli/src/commands.ts`, `cmdRun`: count from `summary.failed` / `summary.needsHuman`
  rather than `summary.ran`; print one line per failure (`kind`, short hash, `error`), capped at
  five with `… and N more`; note `retried.length` when non-empty. Replace the unconditional
  success sentence — with a live failure it becomes `Gate cleared, but N task(s) failed — art
  is missing.` plus whether the attempt budget still has room. Return `1` when
  `summary.failed.length > 0` (`main` already propagates the number as the exit code).
- `cmdStatus`: after the `failed: N` line, print each failed task's reason. Add a sentence to
  its doc comment: `status` does not plan, so its counts include orphaned nodes the current plan
  no longer wants.
- Desktop: `PipelineRunResult` (`apps/desktop/src/shared/ipc.ts`) gains `failed: number` and
  `failures: { hash, kind, error }[]`; `session.runPipeline` fills them; `pipeline.run`'s
  message appends `, N failed` so the palette does not claim success either.
- FLOOR: render `Triage` for `failed` as well as `needs_human`, and show `task.error` when no
  blocking defect survived (a task that threw has neither reviews nor defects). Put the sentence
  choice in a pure helper in `rooms/floor/attempts.ts` with tests, per the renderer rule — the
  `.tsx` change stays a conditional.
- Tests: `apps/cli/src/tests/commands.test.ts` — a run over a project with a live failed task
  returns `1` and prints the reason; a clean run still returns `0` and still prints the original
  sentence.

### 4. Retry a transient provider error in place ✅

- `packages/providers/src/backends/gemini.ts`: classify the caught SDK error (HTTP 429 and 5xx,
  plus transport errors like `ECONNRESET`/`ETIMEDOUT`/`fetch failed`) and wrap the SDK call in
  `retry` from `@vn/util` with a small budget (3 attempts, 500 ms base). Everything else throws
  as it does today, unretried — including `imagePart`'s placeholder and non-image rejections,
  which are thrown before the network and must stay immediate.
- Do the same for the Anthropic backend's image/chat calls if the shape matches; otherwise say
  so in the As-shipped notes rather than pretending both are covered.
- Fix `ProviderError`'s doc comment in `packages/util/src/errors.ts`, which currently claims the
  class means non-retriable. Either it does — and transient failures need their own class — or
  the comment is wrong. Decide when implementing; a `RetryableProviderError` subclass is the
  cheaper of the two and lets the scheduler log the distinction.
- Tests (`packages/providers/src/tests/`): a fake SDK that fails twice with a 503 then succeeds
  produces one image and three calls; one that fails with a 400 produces one call and throws.

### 5. Docs ✅

- `docs/pipeline-contracts.md`, `## Scheduling`: a new contract — a terminal task records why,
  a failed task is retried on the next run up to `max_task_attempts`, and a run's report is
  derived from the live plan, never from what this process happened to touch.
- `CLAUDE.md`: one invariant line pointing at it, beside gate-as-barrier and incremental
  planning.
- `docs/plans/index.md`: the row exists already (added with this file); flip its status.
- This file: tick the steps and add an `## As shipped` section, including anywhere the plan was
  wrong or silent.

## As shipped

All five steps landed as written. The contract is in
[`../pipeline-contracts.md`](../pipeline-contracts.md#scheduling). What follows is where the plan
was wrong, silent, or made a call it deferred to implementation.

**Both backends are covered, and Claude's messages got longer.** Step 4 hedged on Anthropic; the
shape matched, so both backends route their SDK calls through one `callWithRetry`. The classifier
lives in a new `packages/providers/src/backends/transient.ts` (`isTransient` + `providerError` +
`callWithRetry`) rather than inside `gemini.ts`, because two backends needed it. Side effect worth
knowing: a Claude failure message now includes the cause's text, where before it carried the cause
only as `error.cause`.

**`ProviderError` kept its meaning and grew a subclass.** The plan left the choice open;
`RetryableProviderError extends ProviderError` is what shipped, so the doc comment's claim is now
true of the base class and every layer above the backend branches on `instanceof`.

**`@vn/util`'s `retry` gained a `shouldRetry` predicate.** Not in the plan — but a retry loop that
cannot be told an error is hopeless would have paid three times for every 400. Default behaviour is
unchanged (retry everything up to the budget); `packages/util/src/tests/pool.test.ts` pins both.

**`withStructuredRetry` now stops on any `ProviderError`.** Also not in the plan, and a real bug it
would have introduced: with the backend retrying 3× and `withStructuredRetry` retrying 3× on top,
one outage became nine calls. A transient error reaching the structured layer has already exhausted
its budget; a terminal one cannot improve. Schema-mismatch retries — the reason that layer exists —
are untouched.

**The Gemini factories take an injectable client.** `createGeminiChat`/`createGeminiImage` gained a
third parameter, `client: GeminiClient = lazyClient(apiKey)`. The plan assumed "a fake SDK" was
reachable; it is not. The real client arrives through a dynamic `import()`, and esbuild's
`transformSync` — what `scripts/jest-esbuild.cjs` runs — never lowers `import()` to `require` for
any platform, so jest's CJS runtime rejects it before a `jest.mock` could take effect. (No
`jest.mock` call exists anywhere in this repo.) Injection is the only seam; the transform file
gained a doc comment saying so.

**`cmdRun` gained a `providers` test seam.** A non-`--mock` run resolves real API keys and builds
real backends, which a test of the _reporting_ cannot stand in for. The optional third parameter is
the counterpart of the existing `ApproveIO`, and is documented as such.

**FLOOR's triage is a helper, not a widened conditional.** `triageOf(task)` in
`rooms/floor/attempts.ts` returns the headline, the surviving defects, and the prose shown when
there are none — the two states read differently (`needs_human` means the reviewers kept blocking,
so the defects _are_ the answer; a `failed` task usually threw and has neither reviews nor defects,
leaving `task.error` as the only account of it). `Inspector.tsx` stayed thin, per the renderer rule.

**Also touched, briefly.** `apps/desktop/src/shared/ipc.ts` was importing `TaskKind` only to
re-export it, so naming it in `PipelineRunResult` was a typecheck error until it joined the
top-level `import type` block. `pipeline.run`'s message appends `, N failed` before the gate
clause.

## Out of scope

- **Pruning orphaned tasks.** `TaskGraph.prune` exists, is tested, and is called by nothing.
  Wiring it into `planTasks` would need a rule for what counts as reachable across an
  incremental plan (a task not planned this pass is not necessarily dead — it may be waiting on
  an upstream output), and getting that wrong deletes provenance. This plan works around
  orphans by intersecting with the planned set; retiring them is its own plan.
- **A `story`/`pipeline` command to retry one task by hash.** The requeue here is automatic and
  bounded; a manual override is a separate affordance and would want undo semantics.
- **Compacting `tasks.jsonl`.** It grows one line per transition and this plan adds a few more.
- **Surfacing failure in the PLAY runner or the playable.** `@vn/export` already omits a
  missing asset by design (`docs/playable-format.md`).

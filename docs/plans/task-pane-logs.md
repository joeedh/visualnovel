# Task pane: expandable per-task log and reviewer transcripts

## Context

The Tasks pane (`apps/desktop/renderer/pathux/editors/tasks.ts`) shows one card per
pipeline task. The only failure detail on a card is the one-line `task.error`. Everything
else that happened during a task is lost:

- Provider retries (429s, 5xx) appear briefly as activity text, then are gone.
- The scheduler keeps only `err.message` from a runner that threw.
- `withStructuredRetry` discards the bad JSON responses it retried past.
- The reviewer (`ChatVisionReviewer`, `packages/providers/src/review.ts`) keeps only its
  parsed `DefectReport`. Its system prompt, user prompt, raw response and errors are never
  written, except to the debug-only `VN_DUMP_REQUESTS` dump.

Goal: each task card gets a small ▸ disclosure. Expanding it shows a **Log** view (API
errors, retries, reviewer errors, the final failure) and a **Reviewer** view (the saved
reviewer transcripts, grouped by attempt). The persistence half comes first, because
nothing is saved today.

## Decisions

- **Logs are local and gitignored.** They live at `vngen/state/tasklogs/<hash>.jsonl`, and
  that directory is added to the project's ignores scaffolding (`IGNORES_COMMIT`,
  `apps/desktop/src/main/.../workspace.ts:370`). They are machine diagnostics, not
  provenance:
    - they are never committed and never synced to a collaborator;
    - turning the feature off later leaves nothing in any repo's history.
- **A command is the read path.** A non-mutating `pipeline.taskLog(hash)` command, so CDP
  and the debug agent can reach it too. The renderer calls it through the registry.
- **Best effort.** A failed log write never fails or slows a task.
- **Logs are not deleted** by "Clear finished" (a renderer-only filter that deletes
  nothing) or by tombstones (which are undoable). Orphan cleanup is out of scope. A later
  collector could remove files whose hash no record in `tasks.jsonl` names.

## 1. Persistence

### Schema

The schema is zod, in `packages/types/src/tasks.ts`, beside `Task`. Every entry carries
`execution` (the task's `checkpoint.id` for that run) and `at`.

- `{ t: 'log', execution, at, level: 'info'|'retry'|'error', source, text, attempt? }`
    - `source` is `scheduler`, `runner`, `reviewer:<id>` (also used for structured-retry
      and transport-retry lines raised inside that reviewer's call), or `provider`
      (retries outside any reviewer, such as the image call).
- `{ t: 'system', hash, text }`: a reviewer system prompt, written once per file per
  distinct hash.
- `{ t: 'review', execution, at, attempt, reviewer, model?, system /* hash */, prompt, images: ImageNote[], responses: string[], error?, ms }`
    - `responses` holds the raw text, one entry per structured try, so the bad ones that
      were retried past are visible.
    - No `report`. The parsed verdict is already on `TaskAttempt.reviews`, and the
      renderer joins it to the entry by `attempt`.
    - `ImageNote` is `{ hash }` for an `AssetRef`. A bytes-only `ReviewRef` (the
      sheet-seeded graph refs, `runners.ts:175-182`) gets
      `{ hash: sha256(bytes), ext, inline: true }`.
- `attempt` is the persisted attempt index (`records[attempt - 1]`, `runners.ts:336`), so
  it lines up with `TaskAttempt` across re-executions.
- Caps: `RESPONSE_MAX`, `PROMPT_MAX`, and `TEXT_MAX` per field. `TASKLOG_MAX_BYTES` per
  file; once a file exceeds it, the oldest execution's entries are dropped on the next
  append (a rewrite through a temp file and rename).

### Layering: an interface in providers, a file sink in the scheduler

- `packages/providers/src/tasklog.ts` holds only:
    - a `TaskLogSink` interface (`log(entry)`, `review(entry)`,
      `scope({source?, attempt?})` returning a child sink);
    - the `AsyncLocalStorage` helpers `withTaskLog(sink, fn)` and `taskLog()`.

    This copies the existing `reportingRetries` pattern in `backends/transient.ts`,
    because a reviewer's arguments cannot carry a sink.

- The scheduler builds the file-backed sink beside `TaskRequests`
  (`packages/scheduler/src/scheduler.ts:503-504`), using `paths.taskLog(hash)` from
  `packages/store/src/paths.ts` (new `taskLogs` dir and `taskLog(hash)`).
- The sink is passed down as a new `RunDeps.taskLog?` field
  (`packages/pipeline/src/pipeline.ts:13-36`). `runTask` (`runners.ts:416-434`) wraps the
  run in `withTaskLog(deps.taskLog, …)`.
- The file sink:
    - **Ordering:** writes go through one per-sink promise chain, so parallel reviewers
      never interleave appends. File order is completion order, and the reader sorts by
      `at`.
    - **Fencing:** every append calls `checkRequestWrite()` and is registered through
      `requests.write(...)` (`pipeline/src/requests.ts:70-79`), so `writesSettled()`
      drains it on abort. A late answer after a stop is dropped, and a swallowed
      `RequestStopped` is silent. Add this fence to `docs/reference/pipeline-contracts.md`
      beside the journal/attempt fence (:356-357).
    - **Redaction:** error text passes through a redactor that strips `key=`/`api_key=`
      query params, `Authorization`/`x-api-key`/`x-goog-api-key` header values, and
      anything matching a resolved key's prefix pattern. Stacks are not written;
      `err.cause` messages are, after redaction. Even though the logs are gitignored,
      CLAUDE.md forbids logging key values at all.

### Producers

- **Retries:** at `runners.ts:430`, the `reportingRetries` listener tees each note into a
  `retry` line, besides `activity`. The source comes from the ambient scope, so a retry
  inside a reviewer's call is tagged `reviewer:<id>`.
- **Reviewer** (`review.ts`, `ChatVisionReviewer.review`):
    - It opens `taskLog()?.scope({ source: 'reviewer:' + id })` around its work.
    - Raw text is captured inside the lambda passed to `withStructuredRetry`
      (`review.ts:75-77`), so that function's signature and its other callers stay
      unchanged.
    - Each response that fails to parse adds a `retry` line ("response 1 of 3 did not
      parse: …").
    - One `review` entry is written on success. On a throw, one entry with `error` and the
      responses so far is written, and the error is rethrown.
- **Attempt:** the shot runner sets the scope's attempt for each loop iteration
  (`runners.ts:311`), using the persisted index.
- **Terminal outcomes:** the scheduler writes these directly to the sink object it built,
  because the catch at `scheduler.ts:528-535` runs outside the ambient scope.
    - In the catch: an `error` line with the redacted message and cause.
    - After `setStatus` (:555): for any non-`done` terminal status, an `error` line
      (`failed`) or `info` line (`needs_human`) carrying `result.error`. This covers
      runners that return a failure rather than throw, such as `unsupported`
      (`runners.ts:395-398`) and the shot runner's `needs_human` (:379-385).
- **Replay:** reviews are journaled one level above `review()` (`requests.ts:114-116`), so
  a replayed answer never reaches review.ts and writes nothing. An abort that lands
  between a transcript append and the journal save does re-make the call on resume. That
  second paid call gets its own entry, which is correct, and `execution`/`at` tell the two
  apart.

### Command `affects`

`pipeline.run` and `pipeline.draw`
(`apps/desktop/src/main/commands/pipeline.ts:37-44, :101, :118-125, :150-155`) and the
asset command at `asset.ts:345, :373` declare exact state subtrees in `affects` and
`written`. Add `vngen/state/tasklogs` to each, add it to the closed vocabulary in
`src/shared/affects.ts` if needed, and regenerate `command-table.md` /
`command-namespaces.md`.

## 2. Main process: `pipeline.taskLog`

- A non-mutating command `pipeline.taskLog(hash)` → `TaskLogView`, implemented in
  `apps/desktop/src/main/session/pipeline.ts`. It needs a palette-only entry in
  `paletteonly.ts`, per the existing rule that every new command gets one.
- It reads the file, parses each line with the zod schema, skips lines that fail (for
  example, a truncated last line), and resolves `system` hashes to text.
- **Synthesizing older failures:**
    - For each `attempts[]` entry with an `error` and an `at` older than the file's first
      entry (or all of them when there is no file), emit one `error` line.
    - Add `task.error` only when it differs from the last attempt's error. The scheduler
      writes the same string to both (`scheduler.ts:555-570`), so this avoids showing
      every failure twice.
- `TaskLogView` is `{ entries, reviews: count, logs: count }`. The wire types go in
  `apps/desktop/src/shared/ipc.ts`.

## 3. Renderer

### State (`tasks.ts`)

- `expanded: ReadonlySet<hash>`, `logMode: Map<hash, 'log'|'review'>`,
  `openDetails: Set<string>` (keys for open prompt folds), and
  `logs: Map<hash, { gen, view }>`.
- `stateKey()` (:181) gains the expanded set, the modes, the open folds, and each expanded
  hash's `gen`. A log fetch arriving bumps `gen`, which triggers the redraw.
- **No panel churn during a run:** `onBusy` triggers `rebuild()` on every activity push
  (:104-114). Rebuilding is fine for the cards, but an expanded panel's DOM node is kept
  in a per-hash cache and reattached unchanged when its `(gen, mode, openDetails)` is the
  same. That preserves scroll position and text selection inside it.

### Card and panel

- A `▸`/`▾` raw `<button>` goes first in the head row, before `dot()`, styled after the
  History "Logs" fold (`history.ts:1092`). It is wired through `this.anchors.act(...)` and
  calls `event.stopPropagation()`.
- The panel is appended as a sibling after the card in `this.list`, not inside `box`, so
  no click in it reaches the card's select / `view.open` handler (tasks.ts:401).
- **Segmented toggle** `Log 4 | Reviewer 6`. Each half goes through `act()`. The Reviewer
  half is refused when the count is 0, with the tooltip "This task made no reviewer calls
  that were saved".
- **Log view:** monospace rows of time · level tag · source · text. Tag colours are
  `vermilion` for error, `sodium` for retry and `mist-dim` for info. Text wraps and is
  selectable.
- **Reviewer view:** grouped by execution (newest first, labelled by its time), then by
  attempt. Each review shows:
    - reviewer and model, the duration, and a verdict chip computed from
      `task.attempts[attempt].reviews` for that reviewer;
    - the system and user prompts, folded (`<details>`, open state kept in `openDetails`);
    - the raw responses in `<pre>`, with retried-past ones dimmed and labelled;
    - defects, each with a severity colour, taken from the attempt record;
    - image chips (the hash, or "inline" for a bytes-only ref);
    - an error banner when the review threw.
- **Fetching:** `pipeline.taskLog` on expand. The view is re-fetched on `onInvalidate`,
  when the task's `status`/`attempts.length` changes, and on `onBusy` while the task is
  running (throttled to about one per second). A token drops out-of-order replies, as
  `pipeline:status` does.
- **Styling:** a new `apps/desktop/renderer/styles/tasklist.css`, loaded with
  `this.adoptStyle(...)` in `init()`. It covers hover, the fold mark, the segmented
  control, `<details>` and `<pre>`, using the existing custom properties. The card body
  keeps its inline `TOKENS` styling.

### Rules (`apps/desktop/renderer/rules/tasklist.ts`)

- `foldAction(hash, open)`:
  `{ok:true, ...view('mode'), on:`log/${hash}`, label, tooltip}`, with the tooltips "Show
  this task's log and reviewer transcripts" / "Hide this task's log".
- `logModeAction(hash, mode, count)`: `on:`logmode/${hash}/${mode}``. The Reviewer half
  returns `refuse(...)` when the count is 0.
- `TaskListState.cards` (:85-92) gains `expanded`, `mode` and `{logs, reviews}` counts, so
  `controls(state)` (:222) can emit both offers for each card.
- New situations in `rules/situations/tasklist.ts`: folded; open with zero reviews (the
  refusal case); open in Reviewer mode. Then run `pnpm gen:uxmodel`.

## Tests and side effects

- `createMockProviders` uses real `ChatVisionReviewer`s (`providers/src/mock.ts:86-97`),
  so any test that runs tasks through the scheduler will now write `tasklogs/` files. They
  are gitignored, so tree and commit assertions in the desktop session tests should not
  change. Run the full suite and fix any test that lists `vngen/state`.
- New tests (in `tests/` folders):
    - `providers/src/tests/tasklog.test.ts`: scope nesting and source inheritance; no sink
      means no-op.
    - `review.test.ts`: bad JSON then good JSON gives one `review` entry with two
      responses and one `retry` line tagged `reviewer:<id>`. A throwing backend gives an
      entry with `error`, and the error is rethrown. A bytes-only ref is recorded as
      inline with a sha256.
    - Scheduler tests:
        - a throwing runner leaves an `error` line;
        - a runner that returns `needs_human` leaves its reason;
        - two parallel reviewers produce well-formed lines;
        - an append after an abort is dropped;
        - the size cap trims the oldest execution.
    - A redactor test with a Gemini `?key=` URL and an `x-api-key` header.
    - `pipeline.taskLog` tests:
        - skips a truncated last line;
        - synthesizes entries for a task with no file without doubling `task.error`;
        - synthesizes only the attempts older than the file.
- Gates:
    - `pnpm gen:uxmodel`;
    - the anchor CDP sweep against `examples/mySampleRepo`;
    - regenerate the command docs;
    - `pnpm check && pnpm test && pnpm lint`.
- **Manual:** `pnpm vndesktop --mock` (mock providers), then run
  `pipeline.run(mock=false)`, because the default `mock=true` is a dry run that runs
  nothing. Then:
    - Expand a shot task. The Log view has entries, and the Reviewer view shows the
      recorded reviewer transcripts with verdicts.
    - Clicking anything in the panel does not select the card.
    - Folds stay open while another task is running.
    - Force a failure with an invalid key. The redacted API error and the retries appear
      in the Log view.

## Docs

- `docs/reference/pipeline-contracts.md`: the task log file; that it is best effort,
  local, gitignored and not provenance; and the fence from §1.
- `docs/reference/desktopAppState.md`: a row for `vngen/state/tasklogs/` (local,
  gitignored).
- `docs/guides/cli.md` on-disk layout: `vngen/state/tasklogs/`.
- `docs/reference/desktop-app.md`, Tasks editor: the disclosure and its two views.
- `docs/reference/command-system.md` and the generated command tables: `pipeline.taskLog`.

## Review findings (fresh-context pressure test, 2026-10-24)

Each finding is fixed above unless noted.

1. The writer had no path → interface in providers, file sink in the scheduler,
   `RunDeps.taskLog`.
2. The catch is outside the ambient scope → the scheduler writes to its sink directly.
3. Returned failures were missed → log `result.error` for every terminal non-`done`
   status.
4. Late writes after abort → `checkRequestWrite` + `requests.write`; contracts doc note.
5. Replay duplicates → stated; a re-made call is a second paid call and gets its own
   entry.
6. Attempt collisions across executions → `execution` field, persisted index, size cap.
7. Bytes-only `ReviewRef` → sha256 + `inline`.
8. Parallel appends → per-sink promise chain; the reader sorts by `at`.
9. Ambiguous `structured` tag → reviewer scope sets `source: reviewer:<id>`.
10. Where to capture raw text → inside the lambda; `withStructuredRetry` unchanged.
11. Deleting logs on clear/tombstone → dropped; logs are never deleted by those.
12. Committing transcripts → decided with the author: gitignored.
13. Secrets in error text → redactor, no stacks, test.
14. `affects`/`written` stale → added; command docs regenerated.
15. IPC vs command → `pipeline.taskLog` command.
16. Synthesized duplicates → dedupe against the last attempt; synthesize by age.
17. Panel clicks select the card → the panel is a sibling of the card.
18. Rebuild churn → cached panel nodes, `gen` in `stateKey`, open folds kept in state.
19. Anchor key collisions → per-hash `on` keys.
20. `controls()` cannot see per-card state → `TaskListState.cards` extended; situations
    added.
21. Mock/testkit side effects and the dry-run default → spelled out above.
22. Data duplication → no `report` in the log; system prompt stored once by hash.
23. Docs gaps → desktopAppState row, contracts fence, command tables; threads precedent
    dropped.
24. Session-noise line → removed.

## Implementation notes (2026-10-24)

Where the code departs from the plan above:

- **The pane reads through IPC `pipeline:taskLog`, not the command.** Every command, reads
  included, is appended to the committed `commands.jsonl` (`onRecord` in
  `runtime/stack.ts`). A drawer re-reading a running task's log once a second would have
  filled that log. `pipeline.taskLog` still exists for the palette, CDP and the agent, and
  both paths call `PipelinePart.taskLog`.
- **The file sink lives in `@vn/pipeline`, not `@vn/scheduler`.** It is beside
  `TaskRequests` (`packages/pipeline/src/tasklog.ts`), because it registers its appends
  with that class. The scheduler constructs it.
- **The `<details>` folds for prompts are native elements and are not drawn through
  `act()`.** Their open state is kept in the pane (`openDetails`) and they carry a
  tooltip, but they record no anchor.
- **The scaffolding ignore commit has a new subject.** `IGNORES_COMMIT` names task logs
  now, and the old subject stays in `SCAFFOLDING_SUBJECTS` so that existing commits are
  still read as housekeeping.

# Watching and stopping an agent report

Status: **planned**

## Context

`report.agent` is the longest thing the desktop app does on the author's own key, and it is the
only long thing that says nothing while it does it.

Observed on 2026-08-20, from outside the process over CDP: a report started at 08:55:06Z and was
still running seventeen minutes later. Everything about it was healthy — main answered
`command.check` instantly, the socket to `api.anthropic.com` opened four seconds after the last
logged command and was still established, bytes were still arriving — but **none of that was
visible in the app**. The only in-app evidence that anything was happening at all was the Run
button being disabled with `an agent report is already in progress.` Diagnosing "is it still
alive?" required `Get-NetTCPConnection` and process IO counters, which is not a thing an author
can do.

Why it is silent, exactly:

- **`while()` pushes a busy state that the report never fills in.** `busyState()`
  (`apps/desktop/src/main/session.ts:758`) carries `{what, ran, pending}`, and main broadcasts it
  on both edges of the work and on every step between (`index.ts:517`). The pipeline sets
  `this.progress` from the scheduler's `onProgress` (`session.ts:4185`); `reportAgent`
  (`session.ts:1345`) sets nothing, so the report broadcasts `ran: 0, pending: 0` for its whole
  run.
- **The header only draws a spinner for one kind of busy.** `runControls`
  (`renderer/pathux/editors/header.ts:305`) returns early unless `busyWhat === 'a pipeline run'`,
  and the tooltip it would otherwise show is hardcoded to the pipeline's vocabulary — `"The
  pipeline is running — N task(s) done"` (`header.ts:365`). So a report gets a correctly disabled
  Run button and nothing else: no spinner, no counter, no stop.
- **The analyst loop already emits everything needed and nobody is listening.** `Agent` takes an
  `onEvent` callback and has a cooperative `stop()` (`packages/authoring/src/loop.ts:507`, `:585`);
  the authoring turn uses both (`session.ts:911`). `analyzeWithTools`
  (`packages/agentreport/src/analyze.ts:251`) constructs its Agent with neither.
- **There is no way to stop it.** `stopAgent()` gates on `busy() === 'an agent turn'`
  (`session.ts:796`) and `stopPipeline()` on a live `this.cancel`. A report matches neither, so the
  only exit is finishing or killing the app.

What bounds a report today, for reference: the tool loop is capped at `maxIterations: 24`
(`analyze.ts:256`) and inherits the default 200k-token budget (`DEFAULT_BUDGET`,
`packages/types/src/budget.ts:28`). Both are real ceilings — it cannot run forever — but twenty-four
turns of a raised-effort model reading source is comfortably half an hour, which is long enough
that "is it broken?" is a reasonable thing for an author to conclude.

This plan covers the two `todos.md` items — a progress field on the difficult-agent report, and a
stop button — plus one bug that only exists once stopping does.

## The bug that stopping exposes

`analyze()` (`analyze.ts:280`) falls back to the cheap single call whenever the tool loop finished
without filing a report:

```ts
const { analysis, why } = await analyzeWithTools(opts, ctx);
if (analysis) { … }
return { analysis: scrub(await analyzeDirectly(opts), opts.redactor), model, readSource: false, fellBack: why };
```

That fallback is right for what it was written for — an analyst that wandered off and never called
`submit` should still produce something, because the author has already described a bad experience
and should not be told the reporting tool misbehaved too. **A stopped loop lands in exactly that
branch.** So Stop, implemented naively, would spend another model call on the author's key
*after* they asked it to stop, and hand back a report they did not want. A stop has to be a
distinct outcome from "finished without filing", not a special case of it.

## Decisions this plan settles

- **Progress rides the busy push that already exists; it is not a new channel.** `ran` is steps
  taken, `pending` is steps left of the cap. That makes the counter correct in every window for
  free (`pushBusy` broadcasts, `index.ts:517`), survives a crashed run the same way the pipeline's
  does — because no surface keeps a flag of its own — and needs no new IPC message to get a
  visible indicator on screen. The richer per-step detail (stage 3) is additive on top of a thing
  that already works.
- **The analyst's events must not go out on `agent:event`.** `Session.onEvent` for an authoring
  turn does `this.record((convo) => received(convo, event))` (`session.ts:911`) — it *appends the
  event to the author's thread*. Reusing that channel would write the debug analyst's turns into
  the conversation being analysed, which corrupts the evidence for the next report of the same
  thread. The report gets its own broadcast, `report:step`, and its own `deps` hook.
- **Nothing the analyst wrote is shown live.** `scrub()` runs on the filed analysis, not on the
  loop's intermediate messages, so a `message` event may contain fictional names the model echoed
  back before the report was scrubbed. The progress surface shows **step counts, tool names and
  spend** — facts about the run, generated by us — and never model prose. This is a boundary, not
  a filter: there is nothing to leak because nothing authored by the model is on the path. If live
  prose is ever wanted, it goes through the redactor first, and that is a separate decision.
- **Stop is cooperative, and the button says so.** `Agent.stop()` is read between steps
  (`loop.ts:606`), and no backend streams — `grep -n stream packages/providers/src/backends/anthropic.ts`
  is empty — so a stop lands only after the request in flight returns, which at raised effort is
  minutes. The tooltip carries that consequence in the wording `agent.stop`'s check already uses:
  *"Stops after the step it is on."* A button that looks instant and is not reads as broken.
- **The single-call path cannot be stopped, and the button is refused rather than hidden.** With
  neither reading box ticked, the analysis is one `analyzeDirectly` call — no loop, no step
  boundary — and there is no `AbortSignal` anywhere in `@vn/providers` to cut it short. Per the
  tooltips convention, the disabled control's tooltip is its refusal, stated as fact: *"This
  analysis is a single model call, so there is no step to stop after."* This is also the case
  least in need of a stop: one call, not twenty-four.
- **`stopAgent()` is not widened.** It stays keyed to `'an agent turn'`. A report gets its own
  handle and its own command, because the alternative is the convo editor's Stop button silently
  claiming authority over a report it knows nothing about.
- **The interruption primitive is an `AbortController` on the session, mirroring `this.cancel`.**
  The pipeline already does this (`session.ts:4183`, `signal: cancel.signal`), which also means the
  seam is already the right shape for the day a provider call takes a signal. `analyze` takes
  `signal?: AbortSignal`, subscribes `agent.stop()` to it, and checks `signal.aborted` to tell a
  stop from a wander.
- **A stopped report writes nothing and opens nothing.** `report.agent` is `mutating: false` and
  writes only at the end (`keepReport`, `session.ts:1378`), so a stop needs no undo or cleanup
  story at all. The command returns a message and no `data`, which is already enough for
  `installReportPreview` (`renderer/pathux/report.ts:41`) to not open a preview — it requires
  `draft?.body`.
- **The progress popup opens off the busy state, not off the button press.** Same reasoning
  `installReportPreview` records for the preview: bound to the command rather than to the dialog,
  so the palette and a seeded opening get it too. It opens in the window that asked (`ctx.origin`),
  while the header spinner — which every window shows — is what the other windows get. Two windows
  do not both raise a popup.

## Stages

Each stage is green on its own (`pnpm check`, `pnpm test`, `pnpm lint`) and is worth landing
separately.

### 1. A report is visibly running

The smallest change that removes the "is it dead?" question entirely.

- `packages/agentreport/src/analyze.ts` — `AnalyzeOptions` grows
  `onStep?: (step: number, of: number) => void`; `analyzeWithTools` passes an `onEvent` to the
  Agent that counts steps and calls it. Counting off the loop's own events rather than reaching
  into it keeps the package's dependency on `@vn/authoring` exactly what it is today.
- `apps/desktop/src/main/agentreport.ts` — `AnalysisRequest` grows the same optional hook and
  passes it through `analyseThread` to `analyze`.
- `apps/desktop/src/main/session.ts` — `reportAgent` sets `this.progress` and calls
  `announceBusy()`, exactly as the pipeline's `onProgress` does at `:4185`.
- `apps/desktop/renderer/pathux/editors/header.ts` — `runControls` learns a small table keyed by
  busy kind: the sentence to show and, where one exists, the command that stops it. `'a pipeline
  run'` keeps today's behaviour verbatim; `'an agent report'` gains the spinner. `sayProgress`
  reads its sentence from the table instead of naming the pipeline.
  **`'an agent turn'` is deliberately not added** — the convo editor owns that control, and a
  second stop button for it in the header would be two things to keep in agreement.

A report with neither box ticked has one step and no loop; it shows the spinner with a sentence
that says so rather than a counter, because `1 of 1` twenty seconds apart is worse than no number.

### 2. A report can be stopped

- `apps/desktop/src/main/session.ts` — a `reportCancel?: AbortController` field beside `cancel`,
  taken in `reportAgent` and cleared in its `finally`, plus `stopReport(): boolean` and an
  `interruptible` predicate (true when the run has a tool loop, i.e. `source || detail`).
- `apps/desktop/src/main/commands/report.ts` — a `report.stop` command, `mutating: false`, whose
  `check` returns the three sentences: idle, not interruptible, or `ok` with *"Stops after the step
  it is on."*
- `packages/agentreport/src/analyze.ts` — `AnalyzeOptions.signal`; `analyzeWithTools` wires
  `signal.addEventListener('abort', () => agent.stop())` and returns a distinct
  `{ stopped: true }`.
- **The fallback fix**: `analyze()` returns the stopped outcome without calling `analyzeDirectly`.
  `analyseThread`/`reportAgent` turn it into a thrown-or-returned "stopped" that
  `report.agent`'s `run` reports as a message with no draft.
- `header.ts` — the stop button the stage-1 table already provides for, pointed at `report.stop`,
  and disabled with the check's own refusal on the single-call path.

### 3. The progress field in the dialog

- `apps/desktop/src/main/index.ts` — `pushReportStep`, broadcasting `report:step` with
  `{ step, of, tool?, spent? }`. A new `command:ui` effect rather than `agent:event`, for the
  reason in the decisions above.
- `apps/desktop/renderer/pathux/reportprogress.ts` — a popup modelled on `reportpreview.ts`
  (`Preview` is the pattern: a `Popup` from `Screen.popup`, `stylePopup`, `onPopupClosed`): a line
  saying what step it is on of twenty-four, a scrolling list of what it has read — tool names
  only — the running spend, and the Stop button. It opens when the busy push first names an agent
  report in the window that asked, and hands over to `openReportPreview` when the draft arrives.
- Dismissing the popup does **not** stop the run; the header spinner is still there and still
  stops it. The popup's close tooltip says so, because a dialog that silently kills a paid-for
  analysis on an idle click is the expensive misreading.

### 4. Documentation

`docs/reference/desktop-app.md` (the report section) and the `CLAUDE.md` bullet on reporting a
difficult agent gain the sentence that a report is watchable and interruptible; `docs/plans/index.md`
gets its row and the file moves to `archive/` when the row flips.

## Out of scope, and why

- **Aborting a request mid-flight.** Threading an `AbortSignal` through `ChatBackend` and into the
  vendor SDKs would make the single-call path stoppable and make a stop land instantly instead of
  after the current step. It is a `@vn/providers` API change affecting every caller including the
  pipeline, it is worth doing on its own terms, and none of stages 1–3 has to be rewritten when it
  arrives — `stopReport` already owns an `AbortController` whose signal is what such a change would
  consume.
- **Live analyst prose.** Covered in the decisions: it needs the redactor on the live path, which
  is a privacy decision rather than a UI one.
- **Progress for `agent.run`.** The convo editor already streams its events; this plan does not
  touch it.

## Tests

- `packages/agentreport/src/tests/` — a fake backend that emits N tool calls: `onStep` is called
  once per step with the cap; an aborted signal stops the loop and returns the stopped outcome;
  **and the regression that matters — an aborted run does not call the single-call path.** Assert
  it by counting backend invocations, since a spurious fallback is exactly one extra call.
- `apps/desktop/src/main/tests/` — `report.stop`'s three check sentences; `busyState()` carries the
  counter during a report and is cleared after it.
- The header is a rendered surface, so it is verified live over CDP per the repo rule: run a report
  with `--mock` refused, so a real one against a cheap model, and read the spinner's description
  and the stop button's disabled state off the mesh.

## Review

*Owed: this plan has not yet been pressure-tested by a fresh-context agent
(`docs/reference/conventions.md#plans`). Findings go here.*

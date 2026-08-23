# The debug agent as a conversation

Status: **shipped**

Supersedes most of [`watching-and-stopping-an-agent-report.md`](watching-and-stopping-an-agent-report.md).
Two parts of that plan survive here and are carried in full: the busy state the header draws a
spinner from, and the fallback bug a stop exposes.

## Context

Help ▸ Report a Difficult Agent… opens a command dialog on `report.agent`. The dialog collects six
props, the command blocks for a minute or twenty, and the analysis arrives as the command's
outcome, which `installReportPreview` turns into a read-only
preview popup (`renderer/pathux/report.ts:40`). Between pressing Run and the preview appearing there is nothing: no turn, no reply,
no stop, and no sign the run is alive. `todos.md` asks for five things on top of that shape —
progress, further responses from the author, a stop button, granting source access part way
through, and a clearer hand-off to the issue — and each of them is a thing a conversation has
already.

So the dialog becomes a conversation. The analyst stops being one call the app makes on the
author's behalf and becomes an agent the author talks to, in a pane, with the report as something
it files during the conversation rather than as the conversation's only output.

What makes this cheap: `Agent` (`packages/authoring/src/loop.ts:411`) already keeps `messages`
across calls, so a second `run(text)` continues the same conversation. It already has `stop()`
(`:517`), an `onEvent` hook (`:200`), a registry it builds a tool catalog from at the top of each
`run` (`toolSpecs`, `:572`) and `refreshSystem` (`:547`). `analyzeWithTools` (`analyze.ts:235`)
builds one of these, runs it once and throws it away. The main-side work is holding it instead.

## Decisions this plan settles

### The editor

- **A new editor, not a `ConvoEditor` subclass.** `ConvoEditor` reads the module store in
  `renderer/pathux/agent.ts`, which is fed by `agent:event`, and its bar is ten vnauthor
  controls (plan/execute, model, effort, budget, tokens, Threads, New) of which none apply
  to an analyst. A subclass would override nearly every method and inherit the one thing that is
  actively wrong, because the analyst's events must never travel on `agent:event` — see the
  channel decision below. The report editor gets its own class and its own store,
  `renderer/pathux/reportconvo.ts`, built the same way `agent.ts` is.
- **What is shared is the presentation, and it is extracted rather than copied.** The transcript,
  the dialogue box, the composer row and `STUDIO_CSS` are lifted into
  `renderer/pathux/chatsurface.ts`, and `ConvoEditor` is moved onto it in the same stage. Two
  copies of the composer would drift, and the second copy is the one nobody looks at.
- **The pane is a popup, through machinery that already exists.** `view.open(editor,
  where='popup')` opens a floating pane with a titlebar and a close button
  (`renderer/pathux/view.ts:129`).
- **Help ▸ Report a Difficult Agent… opens the pane; the pane starts the analysis.** The menu entry
  (`renderer/pathux/editors/header.ts:673`) seeds the setup card and runs
  `view.open(editor='report' where='popup')`. The pane mounts, reads `report.state`, and draws the
  setup card; the card's Start button invokes `report.open`, which creates the analyst session, runs
  the opening turn and pushes the `command:ui` effect naming the editor — a focus, since the pane is
  already up. The API-error seam (`bridge.ts:323`) calls the same renderer helper with both reading
  boxes ticked and its note, so both entry points land on the same card.

  An earlier draft of this bullet had the menu entry invoke `report.open` directly, on the grounds
  that "the session the pane reads has to exist before the pane mounts". That premise is false:
  `report.state` answers `{ busy: false, granted: {…}, rows: [] }` with no thread, which is exactly
  what an unstarted setup card needs. The two readings also could not both hold — a menu entry that
  starts the analysis leaves the setup card nothing to set up — and starting a paid model call from
  a menu click with nothing to confirm is the worse of the two.
- **It is named but not listed.** `{ id: 'report', title: 'Debug Agent', offered: false }` in
  `src/shared/editors.ts` keeps it out of View ▸ Editors (`OFFERED_EDITOR_IDS`) and out of the
  pane header's own dropdown (`isOfferedEditor`, installed once as path.ux's `setAreaMenuFilter`).
  It claims nothing: no document-tree node names a conversation. This is the third editor to carry
  the flag, after Setup and System Prompt, and for the same reason — it is somewhere the app sends
  the author, not somewhere they arrange a window to keep.
- **Popup size becomes a property of the editor.** `POPUP_SIZE` is one constant, `520 × 420`
  (`view.ts:101`), sized for the task list. A conversation needs about twice that. The constant
  becomes a per-editor lookup with today's value as the default, so the task list is unchanged.
- **The dialog's form becomes the first card in the transcript.** Thread, model, effort and the two
  reading boxes are drawn as one card with a Start button — the same rows `report.ts` builds today,
  with `previewReport`'s sentence as the card's advice line and its refusal as Start's disabled
  tooltip. Once started the card collapses to a line saying what was chosen.
- **The `note` prop stops being a field and becomes the first turn.** "What you had wanted the
  agent to do" is a message, and typing it into the composer is the point of the rework. `note`
  survives on `report.agent` for the headless path.

### The analyst

- **`analyze.ts` grows a factory and keeps its function.** `createAnalyst(opts)` returns a handle
  — `ask(text)`, `stop()`, `grant(tools, paragraph)`, and the filed report — and `analyze()`
  becomes a thin wrapper that creates one, asks once and reads the sink. Existing callers and the
  package's tests keep their shape.
- **The evidence, the redactor and the backend are assembled in one place, and both paths use it.**
  `analyseThread` (`main/agentreport.ts:135`) builds all of them today and then calls `analyze`.
  It splits: the assembly becomes its own function returning the parts, `reportAgent` keeps calling
  `analyze` with them, and `report.open` hands the same parts to `createAnalyst`. Assembling them
  twice is how the two paths would come to redact differently, which is the one difference nobody
  would notice until a name shipped.
- **A turn is bounded; the conversation is not.** Each `ask` runs under the same per-turn token
  ceiling and the same `maxIterations: 24` a headless analysis uses, so a runaway turn still ends.
  There is deliberately no conversation-wide ceiling: the author is at the keyboard, the stop
  button is the bound, and the spend is on the author's own key. What is bounded on disk is the
  transcript ring, which is a different limit and is not a spending one.
- **The conversational path always runs a loop.** With neither box ticked the analysis today is one
  structured call and no loop, which is nothing to talk to. The report editor therefore always
  builds an `Agent`, if only over `submit_report`. The cheap single call survives only under
  headless `report.agent`. This costs more per report than today's unticked path, and it is the
  reason the pending plan's "a single-call analysis has no step to stop after" refusal is not
  needed here.
- **A report turn is busy work; an idle report conversation is not.** `while()` (`session.ts:778`)
  holds `'an agent report'` in the in-flight set for as long as the call it wraps, and `busy()`
  (`:763`) answers with the set's *first* entry. Wrapping a whole conversation would therefore make
  `busy()` say `'an agent report'` for as long as the pane is open, and both `stopAgent()` (`:804`)
  and `agent.stop`'s check (`commands/agent.ts:48`) test `busy() !== 'an agent turn'` — so an
  authoring turn started while the pane sat open could not be stopped, and the header would draw
  the report's state over the pipeline's. Two changes prevent it. Each analyst *turn* is wrapped,
  not the conversation, so the set is empty between turns. And the two stop paths ask whether a
  named kind is in flight rather than whether it is first, which is what they meant in the first
  place; `busy()` keeps its single-string contract for the header, answering by a fixed precedence
  — a pipeline run, then a report turn, then an agent turn — rather than by insertion order.
- **Turn events get their own channel, `report:event`.** `Session.onEvent` for an authoring turn
  does `this.record((convo) => received(convo, event))` (`session.ts:921`), which appends the event
  to the author's thread. Putting the analyst on `agent:event` would write the debug agent's turns
  into the conversation being analysed, corrupting the evidence for the next report of the same
  thread. `EventChannels` in `src/shared/ipc.ts` gains one entry and main broadcasts on it.
- **Everything the analyst writes is redacted before it is shown.** `scrub()` runs on the filed
  analysis today, so intermediate prose carries the author's real character names. The author owns
  those names and the machine is theirs, so showing them is not a leak — but a chat that says
  "Yuki" beside a report that says "Character A" reads as a bug, and one rule is easier to keep
  than two. Live prose goes through the same `Redactor` the report does. **This reverses the
  decision recorded in the superseded plan**, which kept model prose off the progress surface
  entirely; a conversation the author cannot read is not a conversation.
- **Stop is cooperative, and the button says so.** `Agent.stop()` sets a flag that `run` reads at
  the top of each step (`loop.ts:663`) and no backend streams, so a stop lands after the request in
  flight returns. The composer's stop button carries that consequence in the words `agent.stop`
  already uses: *"The turn ends after the step it is on."*
- **A stopped run is not a run that wandered off.** `analyze()` (`analyze.ts:288`) falls back to
  `analyzeDirectly` whenever the loop ends without a filed report. A stop lands in exactly that
  branch, so Stop implemented naively spends another model call after the author asked it to stop.
  The analyst returns a distinct stopped outcome and the fallback is not taken. This is the bug the
  superseded plan found, and it is fixed here in the stage that makes stopping possible.
- **`submit_report` is a card in the transcript, not the end of anything.** The conversation stays
  open, so "you did not mention that it ignored the outfit marker" produces a revised report and a
  second card. A later `submit_report` supersedes the earlier draft; the earlier card stays in the
  transcript showing what it said. The card carries the Review-and-file buttons and the warning
  that the issue body has to be pasted, in the palette's warning colour.
- **The protocol paragraph is per-turn on the conversational path.** `LOOP_PROTOCOL`
  (`analyze.ts:61`) says "call submit_report exactly once. Do not finish your turn without it.",
  which contradicts a second report an author asked for. The headless path keeps that sentence
  verbatim. The conversational path is told instead to file a report before finishing any turn it
  has concluded in, and to file a revised one whenever the author's next message changes the
  conclusion. Two constants picked by path, rather than one sentence that is wrong for one of them.
- **The issue body becomes the paste instruction, and the clipboard behaviour is already right.**
  `openIssue` (`session.ts:1446`) already puts the *whole* report on the clipboard on every call,
  before opening the URL (`:1458`) — only the URL's own copy is trimmed to fit, and `previewIssue`
  adds a sentence about that when it happens. What changes is the URL copy: the prefilled body is
  always `paste report here (it should be in your clipboard)`, so `fitBody`, the `truncated` flag
  and the conditional sentence all go. A URL-length limit that changes what the author has to do is
  a limit they have to learn. `docs/reference/agent-report.md` documents the current split and is
  rewritten with it.
- **The analyst can already ask, and on this path someone answers.** `toolSpecs` appends
  `CONTROL_TOOLS` unconditionally (`loop.ts:579`), so `ask_user`, `ask_choice` and `propose_plan`
  are advertised on every run today — including the headless one, where `unattended()`
  (`analyze.ts:182`) answers every question with "Nobody is here to answer". On the conversational
  path that sentence is false and is replaced: `ask` parks the turn and puts an ask card in the
  transcript, using the same form paging the convo editor already draws. `approvePlan` still
  approves automatically, because the registry holds nothing that could act on a plan, and
  `confirmAction` still refuses. `unattended()` stays, unchanged, for `report.agent`.

### Granting access part way through

- **Source access and request access can both be turned on between turns, and a grant made during
  one takes effect on the next.** `run` builds the tool catalog once, before its step loop
  (`loop.ts:656`), and passes that same array to every step (`:675`) — so a tool added to the
  registry while a turn is in flight is not advertised until the next `run`. Granting is therefore:
  add the tools to the registry, and file the matching paragraph (`SOURCE_ACCESS`,
  `REQUEST_ACCESS`) through `refreshSystem`'s supersede path, which the loop drains at the top of
  the next `run` (`:649`). Ticking a box while the analyst is answering is accepted rather than
  refused — it ticks, and its tooltip becomes "The analyst gets these with your next message."
- **A grant costs a cache miss, which is a reason to grant early rather than a reason to refuse.**
  The tool catalog sits in the byte-stable prefix everything else caches behind, so changing it
  re-reads the conversation once at full price. The setup card is where both boxes are cheapest to
  tick, and it offers them first for that reason.
- **Each box is refused by name when there is nothing to grant:** `NO_SOURCE`
  (`main/agentreport.ts:69`) when the build shipped no source, and the "nothing was sent to the
  model API in this session" sentence `previewReport` already writes when the capture ring is
  empty.
- **Granting is one-way.** Tools already used cannot be un-remembered from the transcript, so a box
  that unticked would promise something the conversation cannot deliver. Once ticked it is disabled
  with a tooltip saying the analyst has already been shown them.

### Commands

- **`report.agent` is left alone**, and stays the headless one-shot that scripts, CDP, the API-error
  auto-open seam and the existing commands test use. Five commands are added — `report.open`,
  `report.say`, `report.stop`, `report.grant`, `report.state` — and both paths go through
  `createAnalyst`. The cost is two entries into one factory; the alternative is rewriting
  `report.agent`'s contract and every caller that reads its outcome.
- **`report.state` is how a pane that arrives late catches up.** A broadcast carries what happens
  next and nothing that already did, so an editor mounted mid-conversation — reopened, or opened in
  a second window — would show an empty transcript beside a running analyst. The editor asks
  `report.state` on mount and reduces the rows it returns exactly as it reduces live events, so
  there is one reducer and not a second read path that can disagree with it.
- **A second message while the analyst is answering is refused, and the composer says why.**
  `report.say`'s check answers "The analyst is still answering" while a turn is in flight, and the
  send button shows that sentence as its refusal. `report.stop` is the one command accepted
  mid-turn; `report.grant` is accepted and lands on the next turn, as above.
- **All of them are `mutating: false`.** The analysis writes nothing into the project, which is why
  `report.agent` is already `mutating: false`, and the transcripts this plan adds are written
  outside any repository. Nothing here is undoable and nothing is committed.
- **One report session per app instance.** The popup opens in the window that asked (`ctx.origin`);
  every other window that opens the editor follows the same broadcast and shows the same
  transcript, the way the pipeline's busy state already reaches every window.

### The transcripts on disk

- **A debug conversation is kept at `<userConfigDir>/debug-transcripts/`.** `userConfigDir` from
  `@vn/config` is `%LOCALAPPDATA%\vnauthor` on Windows, `~/Library/Application Support/vnauthor` on
  macOS and `$XDG_CONFIG_HOME/vnauthor` (else `~/.config/vnauthor`) on Linux, which is where
  `CLAUDE.md` says user-level state goes. `$VNAUTHOR_HOME` overrides it, which is what makes this
  testable.
- **Ten, then the oldest goes.** The directory holds at most ten transcripts; a new one prunes by
  name, oldest first, and the name starts with an ISO stamp so name order is time order. Pruning
  happens when a conversation starts rather than when it ends, so a crashed run cannot leave
  eleven.
- **One JSON object per line, each carrying its own version.** The same shape
  `notifications.jsonl` uses, for the same reason: a line whose version is unknown is skipped
  rather than failing the read of the file it sits in.
- **What is written is exactly the redacted rows the pane showed.** Author turns, redacted analyst
  prose, tool names, and the filed reports. **Tool results are never written** — the request
  captures in particular are the author's own traffic, read on the author's own key, and a file
  that is easy to attach to an issue must not carry them.
- **It is not a thread under `vngen/state/threads/`.** A project thread is committed with the
  project, appears in the Threads menu, and becomes eligible to be reported on itself. A debug
  conversation is about the tool rather than about the story, so it lives with the tool.
- **The app owns where the file lands, not the package.** The writer and the prune live in
  `apps/desktop/src/main/agentreport.ts` beside `saveReport`, which already answers that question
  for the report archive. `@vn/agentreport` answers for the analysis; a leaf package that also
  picked a directory in the user's home would be two places to look for one policy.
- **The existing report archive is left where it is, and the discrepancy is recorded.**
  `saveReport` (`main/agentreport.ts:81`) writes to Electron's `userData/reports/`, which is
  Roaming on Windows and therefore follows the user to another machine. That disagrees with the
  rule this plan follows for the transcripts. Moving it is a migration with its own decisions
  (what happens to the copies already there), so this plan states the inconsistency and does not
  create a second one: the transcripts go where the convention says.

### Kept from the superseded plan

- **Progress rides the busy push that already exists.** `reportAgent` sets `this.progress` and
  calls `announceBusy()` the way the pipeline's `onProgress` does (`session.ts:4203`), so every
  window shows a report is running whether or not it has the pane open. `runControls`
  (`renderer/pathux/editors/header.ts:330`) learns a small table keyed by busy kind instead of
  returning early on anything but `'a pipeline run'`. `'an agent turn'` is still deliberately not
  in that table: the convo editor owns that control.
- **`stopAgent()` is not widened.** It stays keyed to `'an agent turn'`. A report gets its own
  handle, because the alternative is the convo editor's Stop button claiming authority over a
  report it knows nothing about.

## Stages

Each stage is green on its own (`pnpm check`, `pnpm test`, `pnpm lint`) and is worth landing
separately.

### 1. One chat surface

Pure refactor, no behaviour change. `renderer/pathux/chatsurface.ts` takes `STUDIO_CSS` plus the
transcript, dialogue-box, ask-form and composer builders out of `ConvoEditor`, and `ConvoEditor` is
rebuilt on it. Nothing the report editor does not reuse moves. Verified by the convo pane behaving
identically over CDP, and by the existing renderer tests.

This stays first even though it delays every stage that shows the author something, because the
alternative is a second composer written in stage 3 and a merge of the two afterwards — and the
copy that gets fixed is always the one an author uses daily, which is not this one.

### 2. The analyst is a conversation, headless

No UI. `packages/agentreport/src/analyze.ts` gains `createAnalyst`, the conversational protocol
constant and the attended `Permission`; `analyze()` becomes its wrapper; a stopped run returns a
stopped outcome and the single-call fallback is not taken. `analyseThread`'s assembly is split out
so both paths build the evidence, the redactor and the backend once.
`apps/desktop/src/main/session.ts` holds the live analyst beside `this.cancel`, wraps each turn in
`while('an agent report', …)`, sets `this.progress` per step, and pushes `report:event`. The two
stop paths move from `busy() !== …` to asking whether a kind is in flight, and `busy()` answers by
precedence. `report.stop` and `report.state` land here, with their checks' sentences.

The whole stage is provable in `packages/agentreport/src/tests/` against a fake backend before any
pane exists.

### 3. The Debug Agent editor

`{ id: 'report', offered: false }` in `editors.ts`; `POPUP_SIZE` becomes per-editor;
`renderer/pathux/reportconvo.ts` reduces `report:event` and the rows `report.state` returns;
`renderer/pathux/editors/report.ts` draws the setup card, the transcript, the composer and the
filed-report card. `report.open` and `report.say` land with it. `openReportDialog` and its
`ReportSeed` become `seedReport`, which seeds the setup card and opens the pane; Help ▸ Report a
Difficult Agent… (`header.ts:673`) and the API-error path (`bridge.ts:323`) both call it, so the
error path still lands on a card with both boxes ticked. The setup card's Start button is what
invokes `report.open`. The finished-report card hands over to the existing `openReportPreview`,
unchanged.

An `ask_user` from the analyst is deliberately not drawn here. `permission:ask` is one channel
shared with the authoring agent and carries no origin, so the convo pane draws every ask, including
the analyst's. Giving the ask an origin belongs with the attended-permission work rather than with
the pane.

The issue hand-off changes here too, because this is where the author reaches it: `openIssue` fills
the URL with the paste instruction rather than the report, `fitBody` and `truncated` go, and
`previewIssue` loses its conditional sentence. `docs/reference/agent-report.md`'s account of the
split is rewritten with them rather than in stage 6, so the doc is never describing a behaviour
that has already gone.

### 4. Granting access part way through

`report.grant`, the two checkboxes, the registry growing in place, the supersede message that
announces it on the next turn, and the two refusals. Landed after the pane exists because the
refusals are tooltips.

The supersede message needed no new code: `createAnalyst.grant` already called
`agent.refreshSystem`, and `Agent.refreshSystem` on a live transcript files each changed section as
a message that supersedes it by name. What the stage adds is `session.previewGrant`, which answers
what a grant would do without doing it, and `report.grant`, whose `check` is that answer. The pane's
opened card grows the same two boxes the setup card offers, each ticking through the command and
each disabled once granted, with the command's own refusal as its tooltip.

The boxes on the opened card cannot be reached under `--mock`, because a mock workspace refuses to
open a conversation at all. Their decision is therefore `grantBox` in `renderer/rules/`, covered by
jest; what CDP verifies is that `report.grant` refuses both accesses by name with nothing open, that
the catalog carries its two-value enum, and that the setup card still draws.

### 5. Transcripts, ten deep

`<userConfigDir>/debug-transcripts/`, the versioned line format, the prune, and the rule that tool
results are not written.

A line is taken from the same reducer the pane draws with, rather than written a second time from
the row: `transcriptBody` runs one `ReportRow` through `asked` or `received` and writes the feed
item's role and text, dropping `FeedItem.detail`. That is where the tool results go, and dropping
the whole field is what keeps them out. A row about the machinery — a token count, a retry —
produces no line at all.

Two lines are not rows of the conversation. `opened` is the setup card as it collapsed, and
`granted` is each access handed over part way through; neither carries content of its own, and
together they are what explains the tool names that follow. The `opened` line names the thread by
id rather than by title, because a title is the author's own words and nothing outside the redacted
evidence has been through the redactor. A filed report is written without the path its archived
copy went to, for the same reason: that path sits under the author's home directory.

Writes are queued rather than awaited. The events of a turn arrive from a synchronous push, and a
transcript that cannot be written must not take down the conversation it is recording — so
`beginTranscript` returns nothing when the directory cannot be opened, and a failed append is
dropped while the next line still tries.

### 6. The header, and the documentation

The busy-kind table and the spinner. Then `docs/reference/agent-report.md` and the
`CLAUDE.md` bullet on reporting a difficult agent gain the sentence that the debug agent is a
conversation with a stop button and a bounded on-disk history; `docs/reference/desktop-app.md`
gains the editor. A sixteenth editor means the four places that count them say sixteen —
`CLAUDE.md:216`, `CLAUDE.md:303`, `docs/reference/desktop-app.md:182` and `:201`, the last of which
also lists the ids. `docs/plans/index.md` rows flip and both files move to `archive/`. The
`todos.md` line naming this plan is ticked.

## Tests

- `packages/agentreport/src/tests/` — an analyst keeps its messages across two `ask` calls; a
  stopped run returns the stopped outcome **and does not call the single-call path**, asserted by
  counting backend invocations, since a spurious fallback is exactly one extra call; live events
  reach `onEvent` already redacted; a tool granted while a turn is in flight is absent from that
  turn's catalog and present in the next one, which is the mechanism stated rather than the
  behaviour hoped for; the attended permission turns an `ask_user` call into an event and the
  author's answer into the tool's result.
- `apps/desktop/src/main/tests/` — each `report.*` check's sentences, including `report.say`'s
  refusal mid-turn; `agent.stop` still accepts an authoring turn while a report turn is in flight,
  and the other way round; the transcript directory prunes to ten oldest-first; a transcript holds
  no tool results; `busyState()` carries the counter during a report and is cleared after it;
  `openIssue` puts the whole report on the clipboard and the paste instruction in the URL.
- `apps/desktop/src/shared/tests/editors.test.ts` — `report` is absent from `OFFERED_EDITOR_IDS`
  and `isOfferedEditor('report')` is false. It goes here, beside the existing coverage of both, and
  not in the renderer's tests: `editors.ts` is shared code and this is a fact about the list.
- `apps/desktop/renderer/rules/tests/reportconvo.test.ts` — the `reportconvo` reducers, which are
  pure, over both a live event and a `report.state` row. They live in `renderer/rules/` rather than
  beside the store in `renderer/pathux/`, because the store reaches `renderer/api.ts`, which reads
  `window` at module scope; the node-only jest project cannot load anything importing it, which is
  what splits this stage's renderer work across two files.
- The pane is a rendered surface, so it is verified live over CDP per the repo rule: run a report
  against a cheap model, read the composer's stop button and the two grant checkboxes off the mesh,
  and confirm the pane is absent from both menus an author browses.

## Out of scope, and why

- **Resumable and compacted threads.** `todos.md` asks separately for agent threads to be resumable
  with a compacted history and a search tool over the uncompacted part. That is a change to the
  authoring agent's own threads; the transcripts here are a bounded ring for reading back, not a
  resume format. Doing both at once would settle the compaction question inside a plan about a
  dialog.
- **Aborting a request mid-flight.** Threading an `AbortSignal` through `ChatBackend` into the
  vendor SDKs would make a stop land immediately instead of after the current step. It is a
  `@vn/providers` API change affecting every caller including the pipeline, and nothing here has to
  be rewritten when it arrives.
- **Wiring the analyst's tools through the command registry.** The agent reaches commands'
  decisions and never their transport, and that stays true here.
- **Moving `userData/reports/`.** Recorded above as a known inconsistency, with its own migration.

## Review

Pressure-tested by a fresh-context agent, 2026-08-21. Twenty findings, each answered above; the
four that changed a decision were verified against the code first.

**Changed a decision.**

1. *The grant mechanism was wrong.* The plan said the registry "is read on every step", so a
   granted tool would appear immediately. `run` builds the catalog once at `loop.ts:656` and passes
   the same array to every step. Fixed: a grant lands on the next turn, the checkbox says so, and
   the test asserts the mechanism rather than the hope. The cache cost of changing the catalog is
   recorded with it.
2. *An open report conversation would have broken `agent.stop`.* `busy()` returns the in-flight
   set's first entry (`session.ts:763`) and both stop paths compare it to `'an agent turn'`
   (`:804`, `commands/agent.ts:48`). Fixed: turns are wrapped rather than conversations, the stop
   paths ask whether a kind is in flight, and `busy()` answers the header by precedence.
3. *`report.openIssue`'s description was factually wrong.* The whole report already goes to the
   clipboard on every call (`session.ts:1458`); only the URL's copy is trimmed. Fixed, the change
   narrowed to what actually changes, and given a place in stage 3 along with the doc it
   contradicts.
4. *`unattended()`'s reasoning was wrong.* `CONTROL_TOOLS` are appended unconditionally
   (`loop.ts:579`), so the analyst has been able to ask all along and is being told nobody is
   there. Fixed with an attended permission on the conversational path.

**Filled a gap.** 5. `analyseThread` named as the one assembly point for evidence, redactor and
backend. 6. `report.state` added, because a pane mounted mid-conversation had no way to catch up.
7. `report.say` refused mid-turn, with the composer showing the refusal. 8. The per-turn budget and
`maxIterations` stated, and the absence of a conversation-wide ceiling made a decision rather than
an omission. 9. `LOOP_PROTOCOL`'s "exactly once" reconciled with a report that can be superseded.
10. The transcript writer placed in `main/` beside `saveReport`. 11. The Help entry's route settled
— the menu calls `seedReport`, which fills the setup card in and opens the pane, and the card's
Start button is what invokes `report.open`. The command still ends in `view.open`, which is how the
palette and CDP raise a pane the menu did not. 12. Stage 6 counts the sixteenth editor in the four places that say fifteen. 13. The
editors assertion moved to `apps/desktop/src/shared/tests/`, where both functions are already
covered.

**Recorded, not changed.** 14. The reviewer questioned stage 1 coming first, since it shows the
author nothing. Kept, with the reason in the stage: the alternative is two composers, and the copy
that gets fixed afterwards is the one an author uses daily.

**Citations.** 15–20. Six line numbers had drifted (`loop.ts` 410, 516, 199, 546, 606;
`report.ts:41`; `header.ts:305`; `session.ts` 911, 4185) and the stop button quoted a tooltip
`agent.stop` does not have. All corrected against the files; the two that were only decorative were
dropped rather than re-pinned.

## As shipped

Six stages, landed in order, each green on its own. Every decision above holds; what follows is what
the code settled that the plan left open, beyond the per-stage notes already recorded above.

`ask_user` from the analyst is still not drawn in the pane. `permission:ask` is one channel shared
with the authoring agent and carries no origin, so the convo pane draws every ask including the
analyst's; giving an ask an origin belongs with the attended-permission work. The attended
`Permission` exists in `@vn/agentreport` and is covered by its tests, so the headless "nobody is
here to answer" is confined to `report.agent` as planned — what is missing is only the pane that
would draw the question.

The header's table is `busyControls` in `renderer/rules/busy.ts` rather than a literal inside
`runControls`. It names renderer command ids and the sentences a tooltip and a spinner show, so it
belongs with the renderer's other pure logic, where jest can reach it; `header.ts` keeps the handle
it returns so the spinner is retitled from the same table it was drawn from. `stopsWhat` stays in
`src/shared/ipc.ts` unchanged, so `pipeline.stop`'s own answer and the header's tooltip are one
sentence. The report's Stop tooltip is a literal in the table rather than the catalog's text,
because `renderer/rules/catalog.ts` offers no per-id lookup.

The Tests section asks for `busyState()` carrying the counter during a report and being cleared
after it. That is not covered by jest: driving it needs a real turn, and a mock workspace refuses to
open a conversation at all, so there is nothing to assert against under `--mock`. The mechanism it
would have tested is `while()`, which already zeroes `this.progress` when the in-flight set empties
and is exercised by the pipeline's own coverage; what is new here is `showReport` bumping
`progress.ran` per tool event, which CDP reads off a live turn.

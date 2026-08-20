# Diagnosing an API error from the request that caused it

Status: **shipped** (pressure-tested; § [What the pressure test changed](#what-the-pressure-test-changed) records what moved and why)

<!-- toc -->

<!-- tocstop -->

## What this is

When the authoring agent hits an API error that is the *request's* fault — a 400 naming a message
and a block index, an unsupported parameter, a malformed tool block — the author is offered
**Report this to the maintainers** on the recovery card they are already being shown, and taking it
opens **Report a Difficult Agent** with two boxes ticked: the existing **let the debug agent read
the source code**, and a new **process detailed transcript**. With the second on, the debug agent
can read the exact request bodies that were sent, from a ring the provider keeps in memory on every
run.

The point is that a positional 400 is unreadable without the body it indexes into, and the body is
assembled rather than written at the call site (`buildConvoRequest` folds the system prompt, the
tool catalog and the whole transcript together). Today it is sent and forgotten. The uncommitted
`VN_DUMP_REQUESTS` work already writes it to disk on request; this makes the last few always
available in memory, and gives them to the one reader who can act on them.

**Nothing read this way may reach the report.** § [The two tiers](#the-two-tiers) is how that is
held — and § [Why there is no leak detector](#why-there-is-no-leak-detector) is why the enforcement
is at the source rather than a scan at the end.

## What this builds on

The uncommitted work on `packages/providers/src/backends/capture.ts` is stage 0: it already has the
right seam (`captureRequest(label, body)` before the send, `capture.failed(err)` on throw) and the
right instincts (off by default, swallow every filesystem error, write before the call so a hang
still leaves evidence). It lands first, unchanged, and this plan grows it.

Five things already in the tree do most of the work, and none of them need inventing:

- **The author is already interrupted when a call fails.** `nextTurn` catches every backend failure
  and calls `onApiError` (`packages/authoring/src/loop.ts:686-742`); `session.ts:862` wires it to
  `recoverApi`, which puts an ask card with three choices — retry, switch model, stop — branching on
  `failure.transient` (`session.ts:876-892`, `packages/authoring/src/apierror.ts:41-58`). **This is
  the surface the feature belongs on**, not a second one.
- **`transient.ts` classifies where the status code is visible** — `isTransient()` plus
  `ProviderError` / `RetryableProviderError`.
- **`sourcetools.ts` has `Budget`**, whose doctrine ("a cap that silently returns less is worse than
  no cap") is exactly right for reading 400KB request bodies.
- **`redact.ts` has `leaks(text)`**, the scan over the finished report that refuses
  `report.openIssue` on any name that should not be in it.
- **The Anthropic SDK honours `ANTHROPIC_BASE_URL`** (`@anthropic-ai/sdk@0.32.1` `index.js:55`;
  `anthropic.ts:99` constructs `new Anthropic({ apiKey })` with no override), so the fake API in
  § [Testing](#testing) needs **no production code change** to point the real client at it.

## The two tiers

The existing report has one tier of evidence: the thread and the act log, redacted, shown to the
analyst, rendered into the report, posted to a public issue tracker. Every rule about it exists
because that content becomes public.

Captured request bodies are a second tier, and a strictly larger one — a body carries the system
prompt, the whole tool catalog, and the full unclamped text of every file the agent read.

| | Evidence (thread + acts) | Capture (request bodies) |
| --- | --- | --- |
| Shown to the analyst | yes | yes, when **detail** is on |
| Rendered into the report | yes | **never** |
| Leaves the machine | as a report the author reviews and posts | **only** to the author's own model provider |
| Redacted | yes, on the boundary | yes — for the report's sake, below |

The privacy area for the capture is exactly *the model provider the author already chose to talk
to* — the same provider that saw these bodies live, seconds earlier. It is not widened by one byte.

### Why the capture is still redacted

Not for the provider boundary: that model saw these bodies already. For the **report** boundary. An
analyst that reads a real character name in a request body has learnt a word the redactor would
have replaced, and can then type it into its own prose, where `leaks()` catches it as a refusal the
author must clear by hand. Redacting on the way out of the tool keeps the analyst's whole vocabulary
consistent with the evidence, so that never arises.

### Why there is no leak detector

The obvious enforcement — scan the finished report for text that came from a captured body — was
designed, and then abandoned. It does not survive contact with this codebase, for five reasons, and
recording them is cheaper than someone re-proposing it:

1. **It would have to scan capture-minus-evidence**, since a body *contains* the transcript and a
   naive scan would refuse every legitimate quotation of the conversation. That leaves the system
   prompt, the tool catalog and read file contents.
2. **Two thirds of that set is our own public source.** The system prompt and tool catalog live in
   `packages/authoring`, in a public repo, and a maintainer reading an agent bug report *wants* the
   tool description quoted.
3. **The auto-open path guarantees false positives.** It ticks `source` and `detail` together, and
   `WITH_SOURCE` (`analyze.ts:53-61`) tells the analyst to "point each recommendation at the file
   that would have to change" — files which *are* the system prompt's source. The scan would refuse
   on the very field the flow encourages.
4. **The scan cannot be afforded where it would live.** `previewIssue` is a `check`, and
   `commandform.ts` calls `recheck()` on every field change — `session.ts:1310` already caches for
   that reason. Shingling up to 64 MB of retained JSON per keystroke in the main process is not
   viable.
5. **The analyst's own prompts would poison it.** The analyst runs on Path A
   (`analyze.ts:181`), so with Path A captured its own `SYSTEM` text — *"set confidence to low"*,
   *"State each one as behaviour, not as sympathy"* — is in the ring, absent from the evidence, and
   is exactly the vocabulary the report is written in. Refusal would be the modal outcome.

**So the mechanism is at the source instead: make a long verbatim span impossible to obtain.**
`read_request` never returns raw body text — it returns a structural outline, or one decoded,
redacted string value under a hard per-read length cap (see § [The read tools](#the-read-tools)).
Plus the prompt rule, as the second layer, and `leaks()` unchanged as the third.

**The residual is stated rather than hidden:** an analyst that reads N capped excerpts could in
principle paraphrase private file contents into its prose, and nothing detects that. The cap bounds
how much, the redactor covers every name, and the author reads the report before anything is
posted. That is the same trust boundary the feature already had, not a new one.

## The ring

`capture.ts` grows an always-on in-memory ring alongside the opt-in disk dump.

- **Serialized once, on the way in.** The ring holds the JSON *string*, not the body object: size
  accounting is exact, the agent loop mutates the turn arrays it owns so a retained object would
  drift from what was sent, and it is the same bytes the disk dump writes.
- **Capped by bytes and by count**, oldest evicted first. Default **64 MB** and **64 entries**,
  overridable with `VN_CAPTURE_BYTES` / `VN_CAPTURE_COUNT`.
- **A single body may exceed the byte cap on its own** — `chatConversation` can carry base64 image
  blocks (`anthropic.ts:107-112`). Eviction must clamp such an entry (header kept, body dropped,
  marked as dropped) rather than loop evicting an empty ring.
- **Entries are `{ seq, label, at, bytes, json, error? }`.**
- **`seq` moves above the dump guard.** Today `capture.ts:49-51` returns `OFF` before `++seq`, so
  the counter only advances when the dump is on. With the ring always on, `captureRequest` always
  returns a real handle — **the `OFF` singleton goes away**, because `failed()` must now attribute
  to a specific entry. The filename's `padStart(3)` stops aligning past 999 and becomes cosmetic.
- **New exports**: `capturedRequests()` (headers only), `capturedRequest(seq)`, and
  `captureSnapshot()` — see below. Re-exported from `@vn/providers`.
- **Cleared on workspace teardown.** The ring is module-global and the session is per-workspace;
  a second workspace in the same process must not see the first one's bodies.

**Memory is the real cost**, stated plainly: 64 MB of retained strings in the Electron main process
for the life of the process. That is the number asked for; the env vars turn it down.

**Module instance is a non-issue.** `scripts/esbuild.desktop.mjs` bundles main into one CJS file, so
`capture.ts`'s state exists exactly once and `@vn/agentreport` shares it.

### The analyst must not pollute the ring it is reading

This is the sharpest hazard in the plan. `analyze.ts:181` constructs
`new StructuredAgentBackend(opts.backend)` — **the analyst runs on Path A**, up to 24 iterations
(`analyze.ts:187`). The moment Path A is captured (stage 1b), every analyst step pushes an entry
into the ring the analyst is querying: a 24-step analysis evicts a third of a 64-entry ring *while
the diagnosis is in progress*, and a `seq` read from `list_requests()` early can dangle by the time
`read_request` asks for it. The evidence would mutate under its reader.

Two defences, both taken:

- **`captureSnapshot()` freezes the ring**, and the read tools are bound to that snapshot, taken
  once before the analysis starts. A frozen snapshot is the right answer regardless — evidence that
  moves is not evidence.
- **The analyst's own backend opts out.** `captureRequest` takes an opt-out that `analystBackend`
  sets, so a diagnosis never records itself. Belt to the snapshot's brace, and it also keeps the
  analyst from reading its own prompts back as if they were the author's turns.

### Coverage

Only the Anthropic backend implements `chatConversation`, the one path with an assembled body, and
it is the only path captured today. **Stage 1b captures the vendor bodies of the other backends,
in `packages/providers/src/backends/gemini.ts`'s `message`/`messageWithUsage`** — *not* in
`packages/authoring`. `StructuredAgentBackend`'s "body" is `{ system, prompt }`, two strings
(`backend.ts:248-252`); the wire body is assembled inside the concrete backend, and only the wire
body is what a positional error indexes into.

## Classifying the fault

Beside `isTransient` in `transient.ts`, since only that layer sees a status code:

```ts
export type FaultKind = 'transient' | 'auth' | 'request' | 'unknown';
export function faultKind(err: unknown): FaultKind;
```

**It must unwrap `cause` transitively.** `providerError` (`transient.ts:97-105`) wraps the SDK error
as `new ProviderError(message, { cause: err })`, so by the time the desktop catches it the status
lives on `.cause`, and `isTransient`'s text fallback (`/\b(?:status|code)\b/`) does not match
Anthropic's `400 {"type":"error",…}` message. A `faultKind` written "the same way `isTransient` is"
would answer `unknown` for every real 400 and the feature would be dead on arrival.

So: `RetryableProviderError` answers `transient` by class, without needing a status at all; anything
else unwraps to the original SDK error and reads it there.

- **`transient`** — 429, 5xx, `ECONNRESET`, `fetch failed`, `overloaded`. The "cannot connect" case.
- **`auth`** — 401, 403, and `ConfigError`. The "invalid model key" case; the answer is the key
  dialog, not a bug report.
- **`request`** — a terminal 4xx that is neither: 400, 404 on a model id, 413, 422. **This is what
  offers the report.**
- **`unknown`** — anything unrecognized. Deliberately does *not* offer it: unrecognized is where a
  false positive lives, and an unprompted offer on every odd failure trains the author to dismiss
  it.

`ApiFailure` already carries `transient: boolean`; it gains `kind: FaultKind` as the refinement, so
there is one classification rather than two that drift.

## The flow, end to end

1. A turn fails. `nextTurn` calls `onApiError`; `recoverApi` builds the card it already builds.
2. **`apiRecoveryQuestion` gains a fourth choice, `report`, offered only when `kind === 'request'`.**
   This is where the feature lives. The author is already being interrupted for exactly this event,
   already being told "this does not look temporary", and already choosing what to do about it —
   a second unprompted dialog after that card would be a second interruption for one failure.
3. Taking it returns `{ do: 'stop' }` and pushes a `UiEffect` — the existing push channel
   (`src/shared/ipc.ts` `UiEffect`, `main/index.ts:466` `ctx.ui(effect, target?)` →
   `sendTo(target, 'command:ui', effect)`) — naming the thread. **No `agent.lastFault` command and
   no polling**: `session.while()` is a `Set`, not a mutex, so a session-scoped "last fault" could be
   overwritten between the failure and a query.
4. The renderer opens the report dialog seeded `{ thread, source: true, detail: true }`. This needs
   two small renderer changes: `openReportDialog` takes overrides (today it always seeds
   `threads[0]`), and `openCommandDialog` takes a `note` — `dialog.ts:57-59` shows only the catalog
   description, and a dialog that opens because something failed should say so. `dialog.ts:102`'s
   `if (open) return` is fine here: the card is closed by the time the author's answer is read.
5. `report.agent` gains the `detail` prop: `prop.boolean`, **default false**, with a `hint` saying
   what it hands over and that none of it enters the report.
6. `previewReport` / `reportAgent` thread `detail` into `AnalysisRequest`; the capture tools are
   spliced into the registry when it is on, bound to a snapshot taken before the run.

## `detail` without source is a real refactor of `analyze.ts`

Keeping the two checkboxes independent is right, but it is not a threading change. Today:

- `analyze.ts:220` branches on `opts.source` alone, and `SourceAccess` carries both a `registry`
  **and** a `ctx: ToolContext`, whose `workspace` and `git` are non-optional
  (`packages/authoring/src/tools.ts:129-131`).
- `agentreport.ts:100-113` is the only builder of that, and it **throws `NO_SOURCE`** when the build
  shipped no source — so a detail-only run on such a build could not construct a loop at all.
- `WITH_SOURCE` is one blob carrying both the reading permission *and* the "call `submit_report`
  exactly once" instruction. Omitting it for a detail-only run loses the protocol, and
  `analyze.ts:190` would take the `fellBack` path every time — every detail-only analysis silently
  degrading to the cheap single call.

So stage 3 includes: split `WITH_SOURCE` into `LOOP_PROTOCOL` and `SOURCE_ACCESS`; make the loop
switch `registry.size > 0` rather than `opts.source`; and make a bare `ToolContext` always
constructible so the loop does not depend on a source root.

## Stages

Each is green on `pnpm check`, `pnpm test`, `pnpm lint` on its own.

| # | What | Where | |
| --- | --- | --- | --- |
| 0 | Land the uncommitted `VN_DUMP_REQUESTS` work as-is | `providers` | done |
| 1 | The ring, its caps, `seq` above the guard, `OFF` removed, snapshot + opt-out | `providers` | done |
| 1b | Capture the vendor body in `gemini.ts`; make Path A **rethrow** a `ProviderError` | `providers`, `authoring` | done |
| 2 | `faultKind` (unwrapping `cause`), `ApiFailure.kind`, the `report` choice, the `UiEffect` | `providers`, `authoring`, desktop main | done |
| 3 | `analyze.ts` loop/source split, the read tools, the `detail` prop | `agentreport`, desktop main | done |
| 4 | Dialog overrides + `note`, the open-on-effect path | desktop renderer | done |
| 5 | The fake API and the walkthrough | `scripts/` | done |

Stage 1b grew past the plan's line: `anthropic.ts` captures all three of its call sites
(`claude`, `claude-tools`, `convo`), not only the assembled one, so a 400 against the text or
tool-call path is readable too. The headless half of the walkthrough asserts it end to end,
because the Anthropic SDK's lazy dynamic `import()` cannot be loaded by jest's CJS VM.

**Stage 1b carries a behaviour change worth its own review.** `StructuredAgentBackend.next` catches
every error in its 3-attempt loop and returns a normal turn — `{ final: lastRaw }`, or
"I couldn't produce a valid action" (`backend.ts:210-245`). So on a non-Anthropic binding a 400
never throws, `agent.run` returns `ok: true`, no card is shown, and the author pays for three
identical 400s. A request-shaped API failure is not a badly-formatted answer, and Path A must
rethrow a `ProviderError` rather than fold it into a `final`.

## The read tools

Added to the analyst's registry when **detail** is on, bound to the frozen snapshot, budget-charged
through the existing `Budget`, redacted on the way out.

**`list_requests()`** — headers only: seq, label, when, size, and whether it failed with the error's
first line. No content, so orienting is cheap.

**`read_request(seq, path?)`** — walks one body by JSON Pointer.

- With **no path**: a *structural outline* — the top-level fields, then per message its role and its
  blocks' types, ids and sizes. Not content. This is the default because it is the shape a
  positional error indexes into: `messages.1.content.0` is answerable from the outline alone.
- With a **path** (`/messages/1/content/0`): that node's string values, decoded, redacted, and
  **capped per read**. Never the raw JSON slab.
- **Image and other base64 blocks are refused by kind, not merely by budget** — the outline marks
  them by size and `read_request` will not hand back a megabyte of base64.
- Over-budget and over-cap refusals both say so in a sentence, per the existing rule that a silent
  truncation is worse than a refusal.

## Testing

### The fake API provider

`scripts/fake-anthropic.mjs` — a small local HTTP server speaking enough of `/v1/messages` to answer
from a scripted list and to fail on cue with a **real** positional 400
(`messages.1.content.0: unexpected 'tool_use_id' found in 'tool_search_tool_result' blocks`).

Pointed at with `ANTHROPIC_BASE_URL`, which the SDK reads on its own — nothing in
`packages/providers` learns a test exists.

A *server*, not a stub `ChatBackend`, on purpose: what is under test is the real SDK error object,
the real `captureRequest` call, and `faultKind` reading a real status through a real `cause` chain.
A stub class would be a test of our own mock.

Distinct from `--mock`, which makes no calls at all and which `previewReport` already refuses to
analyse under (`session.ts:1219`). The fake API is a *real* binding pointed elsewhere — and
`previewReport` still needs a resolvable key for the chosen vendor (`session.ts:1233-1236`), so the
walkthrough sets a dummy `ANTHROPIC_API_KEY`. Its header says so.

### The walkthrough

`scripts/verify-agent-report.mjs`. It follows `verify-prompt-cache.mjs`'s *conventions* — documented
usage header, not in `package.json` scripts, never run by `pnpm test`, keys through `resolveKeys`
and never printed — but not its *shape*: that script never launches Electron, and this one must.

It is **half harness, half instructions**, because the path it verifies cannot be fully driven from
outside. `report.ts:24-27` says it outright: the scripting bridge invokes main directly, so an
`agent.run` sent over CDP bypasses the renderer's `ask()` entirely — and the automatic open is
precisely a renderer behaviour. So:

**What the script does:** scaffolds a temp project, starts the fake API, launches the app with CDP
on and the fake base URL, then after the human's turn asserts over CDP that the ring holds the body,
that `faultKind` said `request`, that the drafted report exists, and that `leaks()` passes — and
prints the report for reading.

**What the script asks the author to do:** type the turn in the agent pane (so the renderer path is
the one exercised), confirm the recovery card offered **Report this to the maintainers**, take it,
confirm both boxes are ticked, run the analysis, and at the end press **Create** on the pre-filled
GitHub form — `report.openIssue` opens a form and posts nothing, so the last step is a human's by
construction.

Numbered, one instruction at a time, waiting between each. Invoked once by me at the end of stage 5
so the plan is not called finished on unrun code.

### Unit tests

- `capture.test.ts` grows: eviction by bytes, eviction by count, a single oversized body clamped,
  headers carry no body, a failure lands on the right entry, the ring fills with the dump off, `seq`
  advances with the dump off, a snapshot does not move when the ring does, the opt-out records
  nothing.
- `transient.test.ts` grows a `faultKind` table over real SDK error shapes **wrapped in
  `ProviderError`**, including the two kinds excluded by name.
- New `capturetools.test.ts`: the outline names positions without content, a path returns capped
  redacted strings, base64 is refused by kind, an over-budget read refuses with a sentence naming
  the budget.
- `analyze` tests for the new loop/source split, including that detail-only still gets
  `submit_report` and does not fall back.
- `apierror` tests: the `report` choice appears for `request` and for nothing else.

## Docs to update when this lands

- `docs/debugGuide.md` — the drafted `VN_DUMP_REQUESTS` section grows a sibling on the ring.
- `docs/plans/reporting-a-difficult-agent.md` — its privacy section now has two tiers.
- `CLAUDE.md` — one bullet under the desktop app, pointing here.
- `docs/index.md` — this page.

## What the pressure test changed

Recorded because each was a plausible design that the code refutes:

- **An unprompted dialog became a choice on the existing recovery card.** `recoverApi` already
  interrupts the author on exactly this event. Two interruptions for one failure is worse than one.
- **`agent.lastFault` + polling became a `UiEffect` push.** The push channel already exists, and
  `session.while()` is a `Set`, not a mutex, so a polled "last fault" is racy.
- **The quarantine scan was dropped** for the five reasons above, and replaced by limiting what the
  read tools can return at all.
- **Path A capture moved from `authoring` to `gemini.ts`**, and gained a rethrow — the original
  citation pointed at `NativeAgentBackend` (Path B, already captured), and Path A's "body" is two
  strings, not a wire body.
- **`faultKind` gained `cause` unwrapping**, without which it answers `unknown` for every real 400.
- **The analyst poisoning its own ring** was found, and is why the snapshot and the opt-out exist.
- **`detail`-without-source became a refactor of `analyze.ts`**, not a threading change.
- **The walkthrough became half-manual**, because CDP cannot exercise the renderer path it verifies.

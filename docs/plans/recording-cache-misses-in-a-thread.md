# Recording prompt-cache misses in a thread

_Status: stages 1–3 shipped (2026-08-22); stage 4 is deferred as written below. Implements the design in
[`../research/tracking-cache-misses-in-transcripts.md`](../research/tracking-cache-misses-in-transcripts.md),
which is the authority on why each decision was made. This file is the authority on what gets built and in
what order._

<!-- toc -->

- [What this builds](#what-this-builds)
- [Not in scope](#not-in-scope)
- [Where the verdict is computed, and why not in the loop](#where-the-verdict-is-computed-and-why-not-in-the-loop)
- [Stage 1 — declare the capability](#stage-1--declare-the-capability)
- [Stage 2 — compute the verdict and put it on the event](#stage-2--compute-the-verdict-and-put-it-on-the-event)
- [Stage 3 — write the line, read it back](#stage-3--write-the-line-read-it-back)
- [Stage 4 — show it, later](#stage-4--show-it-later)
- [What this is worth](#what-this-is-worth)
- [What it costs to undo](#what-it-costs-to-undo)
- [Review](#review)

<!-- tocstop -->

## What this builds

A conversation's saved transcript records, per API call, whether the prompt cache was read as it should have
been. A drop in the cache-read count inside the cache's TTL means the byte-identical prefix broke between two
calls, which costs several times the tokens and raises no error. Nothing reports this today. The receipt is
added to the running total on screen and is not used anywhere else.

There are four stages. Each stage passes `pnpm check`, `pnpm test` and `pnpm lint` on its own, and each is
useful if the next one never lands.

1. 1. Declare which backends report cache figures accurately.
2. 2. Compute the verdict where the call sequence is held, and put it on the `usage` event.
3. Write a `usage` line into the thread file and read it back.
4. 4. Show it. This stage is deferred until stages 1–3 have produced real data.

## Not in scope

- **The Anthropic `cache-diagnosis-2026-04-07` beta.** It reports why a prefix broke rather than whether it
  did. It is Anthropic-only, it is beta, and it needs the previous response id threaded through
  `ChatConvoReply`, which puts a vendor-specific concept in a seam that exists to be vendor-neutral. A
  computed verdict works on every honest backend, and the diagnosis refines a miss that has already been
  detected, so it belongs after a computed verdict rather than before one.
- **Raising the cache TTL to one hour.** Stage 2 names the TTL that the code already relies on implicitly.
  Changing the TTL is a separate decision that carries its own billing cost and would change what `expired`
  means.
- **Money.** A miss record holds a token count. The app reports call counts and never money, and no price
  table exists to convert one into the other.
- **Threads for `vnauthor`'s REPL.** Thread storage is desktop-only today. Stage 2 makes the verdict
  available to both hosts; storing it in the CLI depends on a move that `threads.ts` is already written for.

## Where the verdict is computed, and why not in the loop

The research recommended computing the verdict in `Agent.run`. After reading
packages/authoring/src/backend.ts, the computation was moved one layer down, to `NativeAgentBackend`, for
three reasons.

- **The structured path's receipts cannot be compared.** `StructuredAgentBackend` sums every attempt of a
  retried step into one receipt through `plus` (backend.ts:89-104, 230), so its `cacheRead` is a total across
  two or three calls and the consecutive-receipt relation does not hold on that receipt. That path is also
  not the cached path. A backend carrying only `chatWithTools` is single-shot and caches nothing
  (providers/src/backend.ts:129-135).
- **`NativeAgentBackend` already keeps per-conversation state.** `prevBreak` (`backend.ts:296`) records
  where the previous request placed its trailing breakpoint. The previous receipt and the previous call's
  timestamp fit in the same place, with the same lifetime.

  The lifetime belongs to the binding rather than the conversation. `setModel` and `setEffort`
  (session.ts:1102-1124) both build a fresh backend through `agent.setBackend`, while loop.ts:525-527 keeps
  the transcript, so switching model or effort mid-conversation makes the next call `cold`. That result is
  correct, because a model switch does invalidate the prefix, but it follows from where the state lives
  rather than from a property of the conversation.

- **`AgentBackend` takes one optional method.** The interface declared `next()` and nothing else, and
  `NativeAgentBackend` holds the `ChatBackend` already, so `NativeAgentBackend` reads `cacheReporting`
  without a capability surface on the agent-level interface. The backend cannot infer when to clear a
  conversation, so `reset?()` is added for that (see stage 2).

The loop still owns the event. `Agent.run` emits `usage` (loop.ts:692-695), and that call is the only place a
host can see a receipt.

## Stage 1 — declare the capability

Add to `ChatBackend` in `packages/providers/src/backend.ts`:

```ts
/**
 * Whether this backend's cache figures can be compared across calls. `billed` means every call
 * reports what it was billed, so a zero read is a real zero. `estimated` means the number is a
 * matched prefix rather than a bill and may be absent on a call that did hit. Absent means the
 * backend has no accounting, which is not the same as a cache that always misses.
 */
readonly cacheReporting?: 'billed' | 'estimated';

/**
 * How long this backend's cached prefix survives between calls, in milliseconds. Read only to
 * tell a prefix that broke from one that simply aged out, so a backend that does not say leaves
 * that question unanswered rather than defaulting to somebody else's number.
 */
readonly cacheTtlMs?: number;
```

It is optional rather than required, and has no `'none'` member. The dozen object-literal `ChatBackend`s in
tests (authoring/src/tests/backend.test.ts:46, 179, 190, 203 and on) stay valid unchanged, and a backend that
says nothing is treated as saying nothing rather than as claiming a third state.

Both backends are object literals returned by a factory rather than classes, so both fields are literal
members. The Anthropic literal declares `cacheReporting: 'billed'` and `cacheTtlMs: CACHE_TTL_MS`. The Gemini
literal declares `cacheReporting: 'estimated'` and no TTL, because the Gemini backend has no use for one.
Every other backend, including `RecordedChatBackend` and the mocks, declares neither field. Nothing between
the factory and the caller strips them: `chatBackendFor` returns the literal unwrapped, and `capture.ts`
wraps the methods rather than the object.

`cacheTtlMs` is a second capability rather than one constant in a shared place, because a shared constant
would carry Anthropic's value. The five minutes on `EPHEMERAL` holds for one vendor's marker only, and
`NativeAgentBackend` is vendor-neutral. A llama.cpp or vLLM backend that declares `'billed'` (the research
places it in that category) has its own eviction policy, so judging it against Anthropic's number would split
`expired` from `miss` wrongly on every such call.

This gate guards against the failure mode that produces wrong output rather than no output. Ollama, KoboldCpp
and LM Studio emit a hardcoded `cached_tokens: 0`, byte-identical to an honest total miss, so a rule keyed on
the receipt's shape would report a 100% miss rate against a working cache. A declared capability is weak
because it records a claim made by whoever wrote the backend, and nothing checks that claim at runtime. That
weakness is accepted because the alternative is unsound.

Nothing consumes the field in this stage. The test asserts that the two real backends declare what they
declare.

## Stage 2 — compute the verdict and put it on the event

**`packages/providers/src/backends/convo-request.ts`.** Add an explicit name for the TTL that the breakpoint
marker leaves unset, alongside `EPHEMERAL`:

```ts
/** How long an `EPHEMERAL` marker lasts, in milliseconds. The vendor's default for that marker. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
```

Export it from `@vn/providers`. The comment on `EPHEMERAL` already states the five minutes in prose;
exporting the value lets the Anthropic backend declare it as its `cacheTtlMs`, and gives one place to change
if the marker's TTL is ever set explicitly. Only that backend reads the constant, because the verdict reads
`cacheTtlMs` off whichever backend it is judging.

In `packages/authoring/src/backend.ts`, add the verdict to `AgentTurn`, beside `usage` rather than inside it:

```ts
/** Cache verdict for this call, when the backend's figures can be compared across calls. */
cacheVerdict?: 'cold' | 'hit' | 'expired' | 'miss';
```

`TokenUsage` records what the provider said. A verdict is derived from two receipts, so it belongs on neither
receipt. Leaving the verdict off `TokenUsage` also keeps `plus` correct without a change, because a summed
receipt has no verdict, and that is the right answer for a path whose sums cannot be compared.

In `NativeAgentBackend`, hold the previous call's receipt and the time it arrived alongside `prevBreak`, and
take an injectable clock so that the `expired` branch is testable:

```ts
constructor(
  private readonly chat: ChatBackend,
  private readonly now: () => number = Date.now,
) { … }
```

Compute the following after `if (reply.usage) turn.usage = reply.usage` runs:

| Verdict | Test |
| --- | --- |
| `cold` | No previous receipt in this conversation |
| `hit` | `cacheRead >= prev.cacheRead + prev.cacheWrite` |
| `expired` | The read dropped, and more than `cacheTtlMs` elapsed since the previous call |
| `miss` | The read dropped inside `cacheTtlMs` |
| absent | Any of the four figures the comparison needs was not reported, or the read dropped and the backend declared no TTL |

Sets a verdict only when `this.chat.cacheReporting === 'billed'`. Every other value leaves the verdict unset
and the field absent. An absent field means the question was not answerable, not that the cache hit.

The last row keeps stage 1's gate from being undone one stage later. `cacheRead` and `cacheWrite` are each
optional on `TokenUsage`, and an absent field means the vendor reported no figure rather than a figure of
zero — the Anthropic backend omits both when the response carries no figures. Coercing an absent count to
zero with `?? 0` would record a missing figure as a total miss, which is the same wrong answer the declared
capability exists to prevent. So a comparison runs only when both receipts carry both figures, and the
`expired`/`miss` split runs only when the backend also reports how long its cache lasts.

**Clearing a conversation.** `Agent.clear` empties the transcript and keeps the backend (loop.ts:501-510,
session.ts:1178-1184), so the held receipt would remain after the prefix it describes is gone, and the next
call would be recorded as a `miss` even though it is genuinely cold. `prevBreak`'s own guard
(`messages.length <= this.prevBreak`) cannot replace this check. The guard is a heuristic, it costs one cache
write when it is wrong, and it does not fire at all after a short conversation. So `AgentBackend` gains an
optional `reset?()`, called by `Agent.clear`, and `NativeAgentBackend` implements it by dropping the held
receipt and `prevBreak` together. A false `miss` is not acceptable here. It writes a wrong record rather than
leaving a record missing, and the file it is written to is committed. Stage 1 exists for that reason.

**`packages/authoring/src/loop.ts`.** Widen the `usage` event with `verdict?:` matching the four
values, and carry it at the emit site:

```ts
if (turn.usage) {
  spent += charge(turn.usage);
  emit({ type: 'usage', ...turn.usage, ...(turn.cacheVerdict ? { verdict: turn.cacheVerdict } : {}) });
}
```

A turn that reported no usage emits nothing, as now. The verdict is attached to the receipt rather than
emitted in its place.

`apps/desktop/src/shared/convo.ts` needs no change. An earlier draft asked for the verdict to be carried
through `received`'s `usage` case. The verdict has no place to go. `received` is a reducer returning a
`Convo`, `Convo` has no slot but `tokens`, and a verdict is not a number to be summed into one. Stage 3's
writer reads the event where it arrives, in `onEvent` (session.ts:922-926), rather than out of the reduced
conversation. The widened event type reaches this file through the `AgentEvent` import, so no edit is needed
here.

All tests run against a scripted backend and a fake clock, and none needs a key:

- Two calls with a rising read and `cacheReporting: 'billed'` produce `cold` then `hit`.
- A dropped read inside the TTL produces `miss`; the same drop with the clock advanced past
  `cacheTtlMs` produces `expired`.
- The same drop from a backend declaring `'billed'` and no `cacheTtlMs` produces no verdict.
- A receipt with no `cacheRead` from a `'billed'` backend produces no verdict, and the call that follows it
  is not compared against a zero.
- The same scripted sequence with `cacheReporting` absent (and again with `'estimated'`) produces no
  verdict on any call.
- A backend that reports a hardcoded zero on every call (declared `'estimated'`) produces no verdict. That
  case is the regression test for the failure this design exists to avoid.
- A dropped read after `reset()` produces `cold` rather than `miss`.

## Stage 3 — write the line, read it back

**`apps/desktop/src/main/threads.ts`.** Adds a fifth `ThreadLine` member:

```json
{"type":"usage","at":"2026-08-21T18:04:11.902Z","step":7,"input":41230,"output":612,
 "cacheRead":39100,"cacheWrite":1980,"verdict":"hit"}
```

and an `appendUsage` writer beside `appendItem`. `step` is the call's index within the thread, so a reader
can line a receipt up against the transcript without matching timestamps. The session numbers each call,
starting at 1 and resetting when a thread is opened, which is the same rule `Convo.seq` follows for feed
items. A reopened thread does not continue the count, because a reopened thread is read-only and takes no new
lines.

The existing readers need no defensive work, and reading them confirmed this rather than assuming it:

- `readThread` filters `line.type === 'item'` (`threads.ts:195`), so older code reading a newer file drops
  the line instead of throwing an error.
- `lines()` skips lines that fail to parse and `headerOf` tolerates missing records, so newer code reading
  an older file reports nothing. That is the same answer it gives when a backend returns nothing.
- `listThreads` filters lines by substring, keeping only those that contain `"thread"`, `"title"`,
  `"binding"` or `"archived"` (threads.ts:175-179). The header scan therefore skips a usage line without
  parsing it.
- No `.gitattributes` entry is needed. Thread files are not union-merged. A socket lock means one process
  owns a project, so unlike `notifications.jsonl` there is no per-line version to design.

Read the lines back onto `ThreadRecord` as a `usage?: ThreadUsage[]` array, declared in
apps/desktop/src/shared/convo.ts beside `FeedItem`. A thread with no usage lines has no field.

**`apps/desktop/src/main/session.ts`.** `record` reduces the conversation and appends whatever landed in
`convo.feed` (session.ts:846-865). A receipt adds no feed item, so `record` never writes one. Add a second,
narrower writer that appends a usage line when a `usage` event arrives, chained through the same
`this.writes` promise. `record` keeps its one job, and the shared chain orders the two writers against each
other. A separate chain would leave them unordered.

**`packages/agentreport/src/transcript.ts`.** Declares `ThreadRecord` rather than importing it, because a
package may not import an app. The new field is added in both places.

The analyst is shown `toMarkdown`'s output and nothing else (transcript.ts:215-218), so a field on
`ThreadRecord` that `toMarkdown` does not render adds nothing, and the claim under "What this is worth" would
be false. `toMarkdown` gains a cache section, which it writes only when some call produced a verdict. The
section gives the counts per verdict, and it names each call that missed by step along with what that call
re-sent.

`redactEvidence` (transcript.ts:76-94) spreads `...evidence.thread` and scrubs the fields it names, so a
usage array would pass through unscrubbed. That is correct for integers and a verdict string. An open spread
is still not the boundary the redaction contract describes. The sentence at transcript.ts:70-71 says a field
`toMarkdown` renders must be added here at the same time, and a spread makes that easy to forget. Name
`ThreadRecord`'s fields explicitly instead, so a future non-numeric field has to be considered rather than
leaking by default. Only the `evidence.thread` spread is replaced. `...evidence` carries `acts`, `thin` and
`context`, which are scrubbed or handled on their own lines already, and `...item` carries a `FeedItem` whose
every string field is named below it.

This stage can regress without breaking anything: dropping `model` or `commit` thins every report's fact
table and no other check fails. The test passes a thread record with every optional field set through
`redactEvidence` and asserts that all of them are still present.

The tests cover a round-trip through `appendUsage` and `readThread`; a thread file with a usage line that the
item path reads and ignores; a thread with no usage line, which reports no field; the redaction round-trip
above; and `toMarkdown`, which names a missed call and emits nothing when no call carried a verdict.

## Stage 4 — show it, later

This choice is deliberately deferred. Choosing between a sentence in `tokensDetail` and a durable
notification when a turn's misses cross a threshold depends on whether misses turn out to be rare or routine,
and nothing before stage 3's data answers that question. A notification per miss would be a nuisance if
misses are routine, and a log with nothing reading it is enough if they are rare.

## What this is worth

`report.agent` reads a thread to diagnose a bad conversation. It cannot currently see or guess a fact like
"This turn re-sent 40,000 tokens of prefix uncached, eleven times". `scripts/verify-prompt-cache.mjs` proves
the breakpoints were placed on a two-step probe when someone runs it against a live key, and a verdict on
every real call makes the same question answerable from a saved thread. `charge` already excludes cache reads
from the turn budget, so a miss is charged correctly today. Nothing today tells an expensive turn from a
wastefully expensive one after the fact.

Volume is not a problem. Each API call adds one line of roughly 150 bytes, whereas `item` lines are already
clamped to 400 characters of text plus up to 8,000 of evidence. A 40-step turn adds about 6 KB to a file that
turn was adding far more than that to.

## What it costs to undo

It is not uniform across the stages, so it is priced per stage.

Stages 1 and 2 are cheap. They add an optional interface field, private backend state, an optional method and
an optional field on an event. Deleting them leaves a tree that type-checks.

Stage 3's storage can be stopped cheaply but cannot be retracted. Thread files are append-only and are
committed with the project, so removing the writer stops new lines while every line already written stays in
history, ignored by readers that filter for `item`. The vocabulary cannot be corrected in place, because a
`"miss"` in a committed file means whatever the rule meant on the day it was written. That is why the three
false-`miss` paths — a cleared conversation, an absent figure read as zero, and a foreign TTL — are closed in
the plan above rather than accepted and documented.

Stage 3's `redactEvidence` change is the expensive one, because it edits a security boundary rather than
adding to it. Reverting it takes one commit, but if the rewrite drops a field by mistake, the report says
less than it should and the omission is not otherwise visible. The test named in that stage fails when that
happens.

## Review

Pressure-tested by a fresh-context agent on 2026-08-22, before stage 1. Eleven findings; four were
blocking. Each is answered above rather than listed here, and the four that changed the design are:

- **A false `miss` after `Agent.clear`.** The backend outlives the transcript, and `prevBreak`'s guard does
  not fire after a short conversation. An optional `AgentBackend.reset()` fixes this, so the plan's claim
  that "`AgentBackend` does not have to change" no longer holds.
- **An Anthropic TTL applied to a vendor-neutral layer.** The fix declares `cacheTtlMs` on the backend
  beside `cacheReporting` and leaves the `expired`/`miss` split unresolved when a backend does not declare
  one.
- **An absent `cacheRead` was coerced to zero.** A fifth row in the verdict table fixes this, so a
  comparison runs only where both receipts carry both figures.
- **The analyst would never see the field.** Stage 3 now renders the verdicts in `toMarkdown`, which is
  what "What this is worth" was already claiming.

Three smaller findings also landed. The `convo.ts` bullet was unimplementable and is now a statement that the
file needs no change. `step` was undefined and now has a stated rule. The claim that the held receipt "dies
with the conversation" was wrong: the receipt is discarded with the binding, and the section on where the
verdict is computed now says so.

The remaining findings were confirmations rather than defects. The compatibility argument for the new line
type holds field by field, no wrapper strips a backend's declared capability, and the two optional
constructor arguments break no existing call site.

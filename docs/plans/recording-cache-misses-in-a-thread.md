# Recording prompt-cache misses in a thread

_Status: **stages 1–3 shipped** (2026-08-22); stage 4 is deferred as written below. Implements the
design in
[`../research/tracking-cache-misses-in-transcripts.md`](../research/tracking-cache-misses-in-transcripts.md),
which is the authority on why each decision was made; this file is the authority on what gets built
and in what order._

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

A conversation's saved transcript records, per API call, whether the prompt cache was read as it
should have been. A drop in the cache-read count inside the cache's TTL means the byte-identical
prefix broke between two calls, which costs several times the tokens and fails silently. Today that
is invisible: the receipt reaches the screen's running total and stops there.

Four stages, each independently green under `pnpm check`, `pnpm test` and `pnpm lint`, and each
useful if the next one never lands.

1. Declare which backends report cache figures honestly.
2. Compute the verdict where the call sequence lives, and put it on the `usage` event.
3. Write a `usage` line into the thread file and read it back.
4. Show it — deferred until stages 1–3 have produced real data.

## Not in scope

- **The Anthropic `cache-diagnosis-2026-04-07` beta.** It reports why a prefix broke rather than
  whether it did. It is Anthropic-only, it is beta, and it needs the previous response id threaded
  through `ChatConvoReply` — a vendor-specific concept in a seam that exists to be vendor-neutral. A
  computed verdict works on every honest backend; the diagnosis refines a miss that has already been
  detected, so it is a follow-on and not a first move.
- **Raising the cache TTL to one hour.** Stage 2 names the TTL that the code already relies on
  implicitly. Changing it is a separate decision with its own billing cost, and it would change what
  `expired` means.
- **Money.** A miss record is a token count. The app names call counts and never money, and the price
  table that would turn one into the other does not exist.
- **Threads for `vnauthor`'s REPL.** Thread storage is desktop-only today. Stage 2 makes the verdict
  available to both hosts; storing it in the CLI waits on the move `threads.ts` already anticipates.

## Where the verdict is computed, and why not in the loop

The research recommended computing the verdict in `Agent.run`. Reading
`packages/authoring/src/backend.ts` moved it one layer down, to `NativeAgentBackend`, for three
reasons.

- **The structured path's receipts cannot be compared.** `StructuredAgentBackend` sums every attempt
  of a retried step into one receipt through `plus` (`backend.ts:89-104`, `230`), so its `cacheRead`
  is a total across two or three calls and the consecutive-receipt relation does not hold on it. That
  path is also not the cached path: a backend carrying only `chatWithTools` is single-shot and caches
  nothing (`providers/src/backend.ts:129-135`).
- **`NativeAgentBackend` already keeps per-conversation state.** `prevBreak` (`backend.ts:296`)
  tracks where the previous request put its trailing breakpoint. The previous receipt and the
  previous call's timestamp sit beside it naturally, with the same lifetime.

  That lifetime is the binding rather than the conversation. `setModel` and `setEffort`
  (`session.ts:1102-1124`) both build a fresh backend through `agent.setBackend`, while
  `loop.ts:525-527` keeps the transcript, so switching model or effort mid-conversation makes the
  next call `cold`. That is the right verdict — a model switch does invalidate the prefix — but it
  is a consequence of where the state lives rather than a property of the conversation.

- **`AgentBackend` grows one optional method.** It declared `next()` and nothing else, and
  `NativeAgentBackend` holds the `ChatBackend` already, so it reads `cacheReporting` without a
  capability surface on the agent-level interface. Clearing a conversation is the one thing the
  backend cannot infer, so `reset?()` is added for it — see stage 2.

The loop still owns the event. `Agent.run` emits `usage` (`loop.ts:692-695`) and that stays the only
place a receipt becomes something a host can see.

## Stage 1 — declare the capability

**`packages/providers/src/backend.ts`.** Add to `ChatBackend`:

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

Optional rather than required, and with no `'none'` member: the dozen object-literal `ChatBackend`s
in tests (`authoring/src/tests/backend.test.ts:46`, `179`, `190`, `203` and on) stay valid unchanged,
and a backend that says nothing is treated as saying nothing rather than as claiming a third state.

Both backends are object literals returned by a factory rather than classes, so both fields are
literal members. The Anthropic literal declares `cacheReporting: 'billed'` and
`cacheTtlMs: CACHE_TTL_MS`; the Gemini one declares `cacheReporting: 'estimated'` and no TTL, which
it has no use for. Every other backend, including `RecordedChatBackend` and the mocks, is left
without either field. Nothing between the factory and the caller strips them: `chatBackendFor`
returns the literal unwrapped, and `capture.ts` wraps the methods rather than the object.

`cacheTtlMs` is a second capability rather than one constant in a shared place because the constant
would be Anthropic's. `EPHEMERAL`'s five minutes is a fact about one vendor's marker, and
`NativeAgentBackend` is vendor-neutral: a llama.cpp or vLLM backend declaring `'billed'` — which the
research puts in that category — has its own eviction policy, and judging it against Anthropic's
number would split `expired` from `miss` wrongly on every such call.

This is the gate against the failure mode that produces wrong output rather than no output: Ollama,
KoboldCpp and LM Studio emit a hardcoded `cached_tokens: 0`, byte-identical to an honest total miss,
so a rule keyed on the receipt's shape would report a 100% miss rate against a working cache. The
weakness of a declared capability is that it is a claim by whoever wrote the backend rather than
something checkable at runtime. That is accepted: the alternative is unsound.

Nothing consumes the field in this stage. Test: assert the two real backends declare what they
declare.

## Stage 2 — compute the verdict and put it on the event

**`packages/providers/src/backends/convo-request.ts`.** Name the TTL the breakpoint marker already
carries by omission, beside `EPHEMERAL`:

```ts
/** How long an `EPHEMERAL` marker lasts, in milliseconds. The vendor's default for that marker. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
```

Export it from `@vn/providers`. The comment on `EPHEMERAL` already states the five minutes in prose;
this makes it a value the Anthropic backend can declare as its `cacheTtlMs`, and leaves one place to
change if the marker's TTL is ever set explicitly. Nothing outside that backend reads the constant:
the verdict reads `cacheTtlMs` off whichever backend it is judging.

**`packages/authoring/src/backend.ts`.** Add the verdict to `AgentTurn`, beside `usage` rather than
inside it:

```ts
/** Cache verdict for this call, when the backend's figures can be compared across calls. */
cacheVerdict?: 'cold' | 'hit' | 'expired' | 'miss';
```

`TokenUsage` stays a faithful record of what the provider said. A verdict is derived, and it is
derived from two receipts, so it does not belong on either one. Keeping it off `TokenUsage` also
keeps `plus` correct without a change: a summed receipt has no verdict, which is the right answer for
the path whose sums cannot be compared.

In `NativeAgentBackend`, hold the previous call's receipt and the time it arrived, alongside
`prevBreak`, and take an injectable clock so the `expired` branch is testable:

```ts
constructor(
  private readonly chat: ChatBackend,
  private readonly now: () => number = Date.now,
) { … }
```

After `if (reply.usage) turn.usage = reply.usage`, compute:

| Verdict | Test |
| --- | --- |
| `cold` | No previous receipt in this conversation |
| `hit` | `cacheRead >= prev.cacheRead + prev.cacheWrite` |
| `expired` | The read dropped, and more than `cacheTtlMs` elapsed since the previous call |
| `miss` | The read dropped inside `cacheTtlMs` |
| absent | Any of the four figures the comparison needs was not reported, or the read dropped and the backend declared no TTL |

Gated on `this.chat.cacheReporting === 'billed'`; on anything else no verdict is set at all, and the
field stays absent. Absent means the question was not answerable, never that the cache hit.

The last row is what keeps stage 1's gate from being undone one stage later. `cacheRead` and
`cacheWrite` are each optional on `TokenUsage`, and absent there means the vendor said nothing rather
than zero — the Anthropic backend omits both when the response carries no figures. Coercing an
absent count to zero with `?? 0` would read silence as a total miss, which is the same wrong answer
the declared capability exists to prevent. So a comparison is run only when both receipts carry both
figures, and the `expired`/`miss` split only when the backend also said how long its cache lasts.

**Clearing a conversation.** `Agent.clear` empties the transcript and keeps the backend
(`loop.ts:501-510`, `session.ts:1178-1184`), so the held receipt would outlive the prefix it
describes and the next call — genuinely cold — would be recorded as a `miss`. `prevBreak`'s own
guard (`messages.length <= this.prevBreak`) cannot stand in for this: it is a heuristic whose cost
when it guesses wrong is one cache write, and after a short conversation it does not fire at all.
So `AgentBackend` gains an optional `reset?()`, called by `Agent.clear`, and `NativeAgentBackend`
implements it by dropping the held receipt and `prevBreak` together. A false `miss` is not
acceptable here for the reason stage 1 exists: it is a wrong record rather than a missing one, and
it is written to a file that is committed.

**`packages/authoring/src/loop.ts`.** Widen the `usage` event with `verdict?:` matching the four
values, and carry it at the emit site:

```ts
if (turn.usage) {
  spent += charge(turn.usage);
  emit({ type: 'usage', ...turn.usage, ...(turn.cacheVerdict ? { verdict: turn.cacheVerdict } : {}) });
}
```

A turn that reported no usage emits nothing, as now — the verdict rides the receipt rather than
replacing it.

**`apps/desktop/src/shared/convo.ts` needs no change.** An earlier draft asked for the verdict to be
carried through `received`'s `usage` case. There is nowhere for it to go: `received` is a reducer
returning a `Convo`, `Convo` has no slot but `tokens`, and a verdict is not a number to be summed
into one. Stage 3's writer reads the event where it arrives, in `onEvent` (`session.ts:922-926`),
rather than out of the reduced conversation. The widened event type reaches this file for free
through the `AgentEvent` import.

Tests, all against a scripted backend and a fake clock, no key required:

- Two calls with a rising read and `cacheReporting: 'billed'` produce `cold` then `hit`.
- A dropped read inside the TTL produces `miss`; the same drop with the clock advanced past
  `cacheTtlMs` produces `expired`.
- The same drop from a backend declaring `'billed'` and no `cacheTtlMs` produces no verdict.
- A receipt with no `cacheRead` from a `'billed'` backend produces no verdict, and does not make the
  call after it compare against a zero.
- The same scripted sequence with `cacheReporting` absent, and again with `'estimated'`, produces no
  verdict on any call.
- A backend reporting a hardcoded zero on every call, declared `'estimated'`, produces no verdict.
  This is the regression test for the failure this design exists to avoid.
- A dropped read after `reset()` produces `cold` rather than `miss`.

## Stage 3 — write the line, read it back

**`apps/desktop/src/main/threads.ts`.** A fifth `ThreadLine` member:

```json
{"type":"usage","at":"2026-08-21T18:04:11.902Z","step":7,"input":41230,"output":612,
 "cacheRead":39100,"cacheWrite":1980,"verdict":"hit"}
```

and an `appendUsage` writer beside `appendItem`. `step` is the call's index within the thread, so a
reader can line a receipt up against the transcript without matching timestamps. The session counts
it, starting at 1 and reset when a thread is opened, which is the same rule `Convo.seq` follows for
feed items. A reopened thread does not continue the count because a reopened thread is read-only and
takes no new lines at all.

The existing readers need no defensive work, which was verified by reading them rather than assumed:

- `readThread` filters `line.type === 'item'` (`threads.ts:195`), so older code reading a newer file
  drops the line rather than throwing over it.
- `lines()` skips what will not parse and `headerOf` tolerates missing records, so newer code reading
  an older file reports nothing — the same answer it gives for a backend that said nothing.
- `listThreads`'s substring filter keeps only lines containing `"thread"`, `"title"`, `"binding"` or
  `"archived"` (`threads.ts:175-179`), so a usage line is skipped during the header scan without even
  a wasted parse.
- No `.gitattributes` entry is needed. Thread files are not union-merged: a socket lock means one
  process owns a project, so unlike `notifications.jsonl` there is no per-line version to design.

Read the lines back onto `ThreadRecord` as a `usage?: ThreadUsage[]` array, declared in
`apps/desktop/src/shared/convo.ts` beside `FeedItem`. A thread with no usage lines gets no field.

**`apps/desktop/src/main/session.ts`.** `record` reduces the conversation and appends whatever landed
in `convo.feed` (`session.ts:846-865`). A receipt adds no feed item, so it cannot ride that path. Add
a second, narrower writer that appends a usage line when a `usage` event arrives, chained through the
same `this.writes` promise. That keeps `record`'s one job intact and keeps the two writers ordered
against each other, which a second chain would not.

**`packages/agentreport/src/transcript.ts`.** `ThreadRecord` is declared there rather than imported,
because a package may not import an app, so the new field is added in both places.

The analyst is shown `toMarkdown`'s output and nothing else (`transcript.ts:215-218`), so a field on
`ThreadRecord` that `toMarkdown` does not render buys nothing and the claim under "What this is
worth" would be false. `toMarkdown` gains a cache section, written only where some call produced a
verdict: the counts per verdict, and the calls that missed named by step with what each re-sent.

`redactEvidence` (`transcript.ts:76-94`) spreads `...evidence.thread` and scrubs the fields it names,
so a usage array would pass through unscrubbed. That is correct for integers and a verdict string,
and it is the moment to notice that an open spread is not the boundary the redaction contract
describes — the sentence at `transcript.ts:70-71` says a field `toMarkdown` renders must be added
here at the same time, which a spread makes it possible to forget. Name `ThreadRecord`'s fields
explicitly instead, so a future non-numeric field has to be considered rather than leaking by
default. Only the `evidence.thread` spread is replaced: `...evidence` carries `acts`, `thin` and
`context`, which are scrubbed or handled on their own lines already, and `...item` carries a
`FeedItem` whose every string field is named below it.

Naming the fields is where this stage can silently regress: dropping `model` or `commit` would
quietly thin every report's fact table with nothing to fail. The test for it is that a thread record
with every optional field set survives `redactEvidence` with all of them still present.

Tests: a round-trip through `appendUsage` and `readThread`; a thread file with a usage line read by
the item path and ignored; a thread with none reporting no field; the redaction round-trip above;
`toMarkdown` naming a missed call, and saying nothing at all where no call carried a verdict.

## Stage 4 — show it, later

Deliberately deferred. The choice between a sentence in `tokensDetail` and a durable notification
when a turn's misses cross a threshold depends on whether misses turn out to be rare or routine, and
that is answerable from stage 3's data and not before. A notification per miss would be a nuisance if
misses are routine; a log with nothing reading it is enough if they are rare.

## What this is worth

`report.agent` reads a thread to diagnose a bad conversation. "This turn re-sent 40,000 tokens of
prefix uncached, eleven times" is a fact it currently cannot see and could not guess.
`scripts/verify-prompt-cache.mjs` proves the breakpoints were placed on a two-step probe when someone
runs it against a live key; a verdict on every real call makes the same question answerable from a
saved thread. And `charge` already excludes cache reads from the turn budget, so a miss is charged
correctly today — what is missing is any way to tell an expensive turn from a wastefully expensive
one after the fact.

Volume is not an objection. One line per API call at roughly 150 bytes, against `item` lines already
clamped to 400 characters of text plus up to 8,000 of evidence. A 40-step turn adds about 6 KB to a
file that turn was adding far more than that to.

## What it costs to undo

Not uniform across the stages, so it is priced per stage.

Stages 1 and 2 are cheap: an optional interface field, private backend state, an optional method and
an optional field on an event. Deleting them leaves a tree that type-checks.

Stage 3's storage is cheap to stop and impossible to retract. Thread files are append-only and are
committed with the project, so removing the writer stops new lines while every line already written
stays in history, ignored by readers that filter for `item`. What cannot be corrected in place is the
vocabulary: a `"miss"` in a committed file means whatever the rule meant on the day it was written.
That is why the three false-`miss` paths — a cleared conversation, an absent figure read as zero, and
a foreign TTL — are closed in the plan above rather than accepted and documented.

Stage 3's `redactEvidence` change is the expensive one, because it edits a security boundary rather
than adding to it. A revert is one commit, but a field dropped by a mistake in the rewrite is a
report that quietly says less than it should. The test named in that stage is what makes the mistake
fail loudly.

## Review

Pressure-tested by a fresh-context agent on 2026-08-22, before stage 1. Eleven findings; four were
blocking. Each is answered above rather than listed here, and the four that changed the design are:

- **A false `miss` after `Agent.clear`.** The backend outlives the transcript, and `prevBreak`'s
  guard does not fire after a short conversation. Fixed by an optional `AgentBackend.reset()`, which
  cost the plan its "`AgentBackend` does not have to change" claim.
- **An Anthropic TTL judging a vendor-neutral layer.** Fixed by declaring `cacheTtlMs` on the
  backend beside `cacheReporting`, and leaving the `expired`/`miss` split unanswered where a backend
  does not say.
- **An absent `cacheRead` coerced to zero.** Fixed by a fifth row in the verdict table: a comparison
  runs only where both receipts carry both figures.
- **A field the analyst would never see.** Stage 3 now renders the verdicts in `toMarkdown`, which
  is what "What this is worth" was already claiming.

Three smaller findings also landed: the `convo.ts` bullet was unimplementable and is now a statement
that the file needs no change; `step` was undefined and now has a stated rule; and the claim that the
held receipt "dies with the conversation" was wrong — it dies with the binding, which the section on
where the verdict is computed now says.

The rest were confirmations rather than defects. The compatibility argument for the new line type
holds field by field, no wrapper strips a backend's declared capability, and the two optional
constructor arguments break no existing call site.

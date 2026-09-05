# Tracking cache misses in transcripts

_Internal research. The plan written from it is
[`../plans/recording-cache-misses-in-a-thread.md`](../plans/recording-cache-misses-in-a-thread.md).
It answers one question: could a saved conversation record when the prompt cache missed,
for the vendors that report honestly enough to tell? It also prices the three places the
record could live._

_Status: **research.** Every claim about this repo is cited to a file and line and was
read on 21 August 2026. The vendor-behaviour claims come from the Anthropic API docs and
from [`local-and-self-hosted-models.md`](local-and-self-hosted-models.md), which surveyed
cached-token reporting across nine local runtimes._

<!-- toc -->

- [The short answer](#the-short-answer)
- [What exists today](#what-exists-today)
    - [The receipt](#the-receipt)
    - [The path from receipt to screen](#the-path-from-receipt-to-screen)
    - [Where it stops](#where-it-stops)
- [Which vendors can support it](#which-vendors-can-support-it)
- [What counts as a miss](#what-counts-as-a-miss)
- [Where the record could live](#where-the-record-could-live)
    - [Option A — a new `usage` line in the thread file (recommended)](#option-a--a-new-usage-line-in-the-thread-file-recommended)
    - [Option B — compute the verdict in the loop and widen the event](#option-b--compute-the-verdict-in-the-loop-and-widen-the-event)
    - [Option C — the vendor's own diagnosis, as a follow-on](#option-c--the-vendors-own-diagnosis-as-a-follow-on)
- [What it buys](#what-it-buys)
- [Risks and open questions](#risks-and-open-questions)
- [What I would do, in order](#what-i-would-do-in-order)

<!-- tocstop -->

## The short answer

A miss is observable today on Anthropic and nowhere else, it is computable rather than
reported, and it is not written down anywhere. Making it durable is a small change with
one genuinely hard part, and that hard part is not storage.

- Anthropic returns `cache_read_input_tokens` and `cache_creation_input_tokens` on every
  call as billing facts, so a zero read means no tokens were read from cache
  (`anthropic.ts:34-46`).
- Gemini's implicit cache reports a matched prefix rather than a bill, reports nothing on
  many calls that did hit, and has no cache-write counterpart, so a zero there carries no
  information (`gemini.ts:99-116`).
- No vendor reports a miss, and there is no field for one. A miss is an inference from two
  consecutive receipts plus the time between them, so whatever records a miss must hold
  the sequence.
- The thread file has no line type that could carry a receipt (`threads.ts:50-55`). The
  reducer writes only what lands in `convo.feed` (`session.ts:850-864`). A `usage` event
  adds to `convo.tokens` and adds no feed item, so nothing reaches disk.

The hard part is deciding what counts as a miss. The sharpest risk is a backend that
reports `0` because it has no accounting rather than because the cache missed.

## What exists today

### The receipt

`TokenUsage` (packages/providers/src/backend.ts:47-61) carries `input`, `output`, and an
optional `cacheRead` / `cacheWrite` split subtracted from `input` rather than added beside
it. A fourth field, `cacheEstimated`, marks the split as a matched-prefix count rather
than a billed figure.

The type already distinguishes three states, so no new field is needed:

| `cacheRead` | `cacheEstimated` | Means                                 | Who produces it                                    |
| ----------- | ---------------- | ------------------------------------- | -------------------------------------------------- |
| absent      | —                | The vendor said nothing about caching | Gemini's early calls, the text path, mock backends |
| present     | `true`           | A matched prefix, not a bill          | Gemini (`gemini.ts:114`)                           |
| present     | absent           | A billing fact                        | Anthropic (`anthropic.ts:37-44`)                   |

The doc comment on `TokenUsage` states the rule the rest of the system depends on: "Absent
means the vendor said nothing, which is not the same as zero."

### The path from receipt to screen

1.  1. `Agent.run` charges the receipt against the turn budget and emits it:
       `spent += charge(turn.usage); emit({type: 'usage', ...turn.usage})`
       (loop.ts:683-686). The receipt is emitted before the step it paid for is narrated,
       so the total never lags behind the transcript.
2.  2. `charge` (packages/types/src/budget.ts:59-61) is
       `input - (cacheRead ?? 0) + output`. Cache reads do not count against the budget;
       cache writes do.
3.  3. `applyEvent` folds the receipt into `convo.tokens` as a running sum
       (convo.ts:364-377). `cacheEstimated` stays set once a step sets it.
4.  4. `tokensDetail` (convo.ts:133-161) renders the tooltip on the token counter.

### Where it stops

`WorkspaceSession.record` (session.ts:850-864) reduces the conversation and appends to the
thread whatever that reduction added to `convo.feed`. A `usage` event produces no feed
item, so it is never appended. The thread's line vocabulary is `thread` | `item` | `title`
| `binding` | `archived` (threads.ts:50-55) and includes no line for a receipt.

The comment on `Convo.tokens` (convo.ts:258-266) already records the property as
deliberate: "Nothing writes it to a thread, so a reopened thread starts at zero and says
so."

Two consequences follow, and a durable record would fix both:

- **Per-call detail is destroyed even in memory.** `applyEvent` sums its inputs. A
  conversation that missed on every step and one that hit on every step both end up
  showing a percentage. The two percentages differ, but they are the same kind of number,
  and neither one exposes the individual calls.
- **Only one script currently asserts a cache miss, and it must be run by hand.**
  `scripts/verify-prompt-cache.mjs:145-148` runs two steps of a throwaway conversation and
  fails with "step 2 read nothing from the cache — the prefix changed between the two
  steps." That is exactly the assertion this report proposes, applied to real
  conversations instead of a probe.

## Which vendors can support it

The title asks about "models that support it", but support depends on the backend, and
[`local-and-self-hosted-models.md` §"Cached-token reporting"](local-and-self-hosted-models.md#cached-token-reporting-is-the-one-thing-that-must-be-checked-and-most-servers-fail-it)
already surveys the backends. Three categories matter here:

| Backend                          | Reporting                                      | Can a miss be inferred?                    |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Anthropic                        | Billed read + write                            | **Yes**                                    |
| Gemini                           | Matched prefix, read only, silent on many hits | No — silence and a miss are the same bytes |
| llama.cpp / `llama-server`, vLLM | Real `cached_tokens`                           | Yes, once a backend exists                 |
| Ollama, KoboldCpp, LM Studio     | **Hardcoded `0`**                              | **No, and worse than no**                  |

That last row is the finding that should shape the design. Ollama's `openai/responses.go`
emits `"input_tokens_details": {"cached_tokens": 0}` unconditionally. That stub value is
indistinguishable from an honest total miss, so any rule of the form
"`cacheRead === 0 && !cacheEstimated` therefore missed" would report a 100% miss rate
against a server whose cache is working perfectly.

**Recommendation: gate on a declared capability, not on the shape of the receipt.** The
backend identifies the runtime it calls, and the receipt does not. Add something like a
`cacheReporting: 'billed' | 'estimated' | 'none'` field to `ChatBackend` alongside
`modelId`, declared by whoever wrote the backend, with `'none'` as the default so that an
unaudited runtime reports nothing rather than an unfounded figure. The existing
`chatConversation?` probe (`backend.ts:135`) works the same way: the host asks the backend
what it can do rather than inferring it from a reply.

## What counts as a miss

No vendor has a miss field. A receipt on its own cannot identify a miss. A first call
legitimately reads nothing, and reporting that as a miss would mean every conversation
opens with one.

The usable signal is a relation between consecutive receipts in one conversation. On a
healthy run, call N's `cacheRead` should be at least call N−1's `cacheRead + cacheWrite`.
Everything that was readable last step, plus whatever was written last step, should be
readable this step. A drop means the prefix was invalidated between the two calls.

The result is four verdicts. Each verdict stays distinct because it has a different cause
and a different fix:

| Verdict   | Test                                                                | What it means                                         |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `cold`    | First call of the conversation                                      | Nothing to hit. Not a defect.                         |
| `hit`     | `cacheRead >= prev.cacheRead + prev.cacheWrite`                     | Working.                                              |
| `expired` | Read dropped, and more than the TTL elapsed since the previous call | The author went to lunch. Not a defect.               |
| `miss`    | Read dropped inside the TTL                                         | **The prefix broke.** This is the one worth a record. |

The TTL confounds the judgement, which is why a receipt needs a timestamp to be judged at
all. The breakpoint marker is `{type: 'ephemeral'}` with no explicit TTL
(convo-request.ts:13-14), and the comment there gives the reasoning: "Default TTL (5
minutes): an agent's steps are seconds apart." That reasoning holds inside one turn.
Across turns of a conversation an author thinks between, five minutes passes easily, so a
naive rule would mark a normal working rhythm as a defect several times an hour. Thread
lines are already stamped (`appendItem` writes `at`, threads.ts:256), so the timestamp
costs nothing extra.

A `miss` inside the TTL has a small set of causes. Every cause is ours rather than the
vendor's, so the record is actionable:

- A byte changed in `tools` or `system`. `refreshSystem` (`loop.ts:547-565`) exists to
  keep such a change from invalidating the prompt. It appends a `{role: 'system'}` message
  rather than editing the prompt in place, so a mid-conversation change costs one cache
  write and invalidates nothing. A miss means something bypassed `refreshSystem`.
- The tool catalog changed order. `toolSpecs` (loop.ts:573-578) derives from a static list
  plus the registry's own order so that "two turns of one conversation produce
  byte-identical catalogs."
- A breakpoint moved or was dropped. `markLast` (convo-request.ts:41-53) clones rather
  than mutates, because a marker left behind would change a byte in a prefix that must
  stay identical, and `messagesOf` keeps only the newest two marks to stay inside the cap
  of four.
- A thinking block was rebuilt instead of echoed. `UNMARKABLE` (convo-request.ts:26)
  guards the marker side of a rebuilt thinking block.

Each of those is a regression someone could introduce in a refactor and never notice,
because nothing fails. The conversation still works; it just costs several times more.
That is the argument for recording the cost.

## Where the record could live

### Option A — a new `usage` line in the thread file (recommended)

Add a fifth line type beside the four that exist:

```json
{
    "type"      : "usage",
    "at"        : "2026-08-21T18:04:11.902Z",
    "step"      : 7,
    "input"     : 41230,
    "output"    : 612,
    "cacheRead" : 39100,
    "cacheWrite": 1980,
    "verdict"   : "hit"
}
```

Compatibility is unusually good, and mostly by accident of how the existing readers are
written:

- **`readThread` already ignores unknown line types.** It filters `line.type === 'item'`
  (`threads.ts:195`), so an unknown line type is dropped rather than throwing. Old code
  can read a new file.
- **New code reading an old file is fine.** `lines()` skips what will not parse and
  `headerOf` tolerates missing records. A thread with no usage lines reports nothing,
  which is what the system already reports for a vendor that returned nothing.
- **`listThreads` needs no change.** Its cheap substring filter keeps only lines
  containing `"thread"`, `"title"`, `"binding"` or `"archived"` (threads.ts:175-179), so
  the header scan skips usage lines without a wasted parse.
- **No merge attribute is needed.** Thread files are not in
  `templates/basic/.gitattributes`, and they do not need to be. A socket lock means one
  process owns a project, so no union-merge applies to thread files (unlike
  `notifications.jsonl`) and no per-line version has to be designed around one.

The write site is awkward. `record` only writes feed items, so a receipt cannot be written
through the existing path. There are two sub-options. The first gives `WorkspaceSession` a
second, narrower writer that appends a usage line on a `usage` event. The second
generalises `record` to take "lines to append" rather than "reduce and diff the feed". The
first is smaller and keeps `record`'s one job intact; the second avoids a second
`this.writes` chain and the ordering question that comes with it. Take the first, because
the two write paths already serialize through the same `this.writes` promise and adding a
branch there is smaller than reshaping the reducer's contract.

Volume is a weak objection. Each API call adds one line of roughly 150 bytes, against
`item` lines already clamped to 400 characters of text plus up to 8,000 of `full`
(threads.ts:39-48). A 40-step turn adds about 6 KB to a file the same turn was already
growing by far more than that. Threads are committed and travel with the project, and the
added bytes are integers, so they carry no fiction, no prose, and nothing to redact.

### Option B — compute the verdict in the loop and widen the event

Storage location aside, `@vn/authoring` should compute the verdict rather than the desktop
app. The loop is the only place that has the per-call sequence, the previous receipt, and
the elapsed time, and it is the layer `vnauthor`'s REPL shares with the desktop. A verdict
computed there is available to both hosts. A verdict computed in `session.ts` is available
to neither the CLI nor the tests.

That means widening the `usage` event (loop.ts:142-149) with the verdict and leaving the
storage decision to the host. The loop also needs the backend's declared `cacheReporting`,
which it can read once at construction alongside `modelId`.

### Option C — the vendor's own diagnosis, as a follow-on

Anthropic ships a beta that reports why a prefix broke rather than only whether it broke:
`client.beta.messages.*` with beta flag `cache-diagnosis-2026-04-07`, passing
`diagnostics: {previous_message_id: <previous response id>}` and reading
`response.diagnostics`. The report names what broke the prefix, so the cause does not have
to be deduced from a drop in a number.

This approach is correct in the long term, but it is the wrong thing to do first. It is
Anthropic-only and beta, it needs the previous response id threaded through
`ChatConvoReply`, and it would put a vendor-specific concept into a seam that is
deliberately vendor-neutral (`backend.ts` exists so that "backends swap by changing model
ids in `project.yaml`"). The computed verdict works on every honest backend, including the
local ones. The diagnosis, if it lands, refines a `miss` that has already been detected.

## What it buys

**The analyst.** `report.agent` reads the thread to diagnose a bad conversation
(`agentreport/src/transcript.ts`). It cannot currently see a fact such as "This turn
re-sent 40,000 tokens of prefix uncached, eleven times", and it has no way to guess one.
The numbers are integers, so they cross the redaction boundary safely (see the risk
below).

`verify-prompt-cache.mjs` is a regression test. It proves on a two-step probe that the
breakpoints were placed, but only when someone runs it. A verdict on every real call makes
that proof part of normal use, and lets a reader answer whether a refactor broke the
prefix from a saved thread rather than by re-running a script against a live key.

`charge` treats an absent split as "no cache read", so a miss is already charged correctly
against the turn ceiling, and the budget is honest. Nothing distinguishes an expensive
turn from a wastefully expensive one after the fact.

## Risks and open questions

- **A stub that reports zero cached tokens.** This failure is restated here because it
  produces wrong output rather than no output: a hardcoded `cached_tokens: 0` is
  byte-identical to an honest miss. The declared-capability gate is the mitigation. Its
  weakness is that the declaration is a claim by whoever wrote the backend rather than
  something checkable at runtime.
- **The redactor passes unknown fields through.** `redactEvidence` spreads
  `...evidence.thread` (transcript.ts:77-83) and scrubs the fields it names. A usage array
  survives the spread unscrubbed, which is correct for integers and would be silently
  wrong for any future field that is not an integer. The redaction contract must be
  enforced at a boundary rather than requested in a prompt. An open spread does not
  enforce that boundary, and adding a field to the thread record is the moment to check
  it.
- **Two hosts share one loop and one storage.** Threads are desktop-only today, though
  threads.ts:10-12 says the module is written to move down to `@vn/authoring` once the
  REPL needs them. `vnauthor` can read a verdict computed in the loop immediately, but
  cannot store one until after that move.
- **The code assumes the TTL rather than reading it.** The `expired` verdict needs a
  number, and the code supplies one implicitly, because `EPHEMERAL` defaults to five
  minutes when no TTL is given. Naming that default as a constant beside the marker is a
  prerequisite. Raising it to `ttl: '1h'` is a separate decision with its own cost, and it
  would change what `expired` means.
- **The app does not report what a miss costs in money.** The app "can name call counts
  but never money" ([`a-less-technical-mode.md`](a-less-technical-mode.md)). A miss record
  holds a token count, and converting that count into a dollar figure needs the price
  table, which does not exist yet.

## What I would do, in order

1.  1. **Declare the capability.** Add `cacheReporting: 'billed' | 'estimated' | 'none'`
       to `ChatBackend`, set to `'billed'` for Anthropic, `'estimated'` for Gemini, and
       `'none'` by default. Nothing consumes it yet. The change only adds code, and it is
       testable without a key.
2.  2. **Compute the verdict in the loop** and widen the `usage` event with it, gated on
       `cacheReporting === 'billed'`. The loop already holds the previous receipt for
       `spent`. Name the TTL constant while doing it. The verdict is testable against a
       scripted backend the way loop.test.ts:185-190 already tests receipts.
3.  3. **Write the `usage` line**, and read it back on `ThreadRecord`. This takes two
       small changes in `threads.ts` and one branch in `session.ts`.
4.  4. **Show it** if it turns out to be worth showing. The display could be a sentence in
       `tokensDetail`, or a durable notification when a turn's misses cross a threshold.
       Defer this step until steps 1–3 have produced enough real data to show whether
       misses are rare or routine. A notification suits rare misses. If misses are
       routine, the threshold becomes a nuisance and the log alone is enough.

Steps 1 and 2 are worth doing whether or not step 3 follows. They make the miss visible
live and in tests, and that is most of the value. Step 3 keeps the miss visible for the
rest of the conversation.

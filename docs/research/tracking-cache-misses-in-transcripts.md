# Tracking cache misses in transcripts

_Research, internal. The plan written from it is
[`../plans/recording-cache-misses-in-a-thread.md`](../plans/recording-cache-misses-in-a-thread.md).
It answers one question — **could a saved conversation
record when the prompt cache missed, for the vendors that report honestly enough to tell** — and
prices the three places the record could live._

_Status: **research.** Every claim about this repo is cited to a file and line and was read on
21 August 2026. The vendor-behaviour claims come from the Anthropic API docs and from
[`local-and-self-hosted-models.md`](local-and-self-hosted-models.md), which surveyed cached-token
reporting across nine local runtimes._

<!-- toc -->

- [The short answer](#the-short-answer)
- [What exists today](#what-exists-today)
  * [The receipt](#the-receipt)
  * [The path from receipt to screen](#the-path-from-receipt-to-screen)
  * [Where it stops](#where-it-stops)
- [Which vendors can support it](#which-vendors-can-support-it)
- [What counts as a miss](#what-counts-as-a-miss)
- [Where the record could live](#where-the-record-could-live)
  * [Option A — a new `usage` line in the thread file (recommended)](#option-a--a-new-usage-line-in-the-thread-file-recommended)
  * [Option B — compute the verdict in the loop and widen the event](#option-b--compute-the-verdict-in-the-loop-and-widen-the-event)
  * [Option C — the vendor's own diagnosis, as a follow-on](#option-c--the-vendors-own-diagnosis-as-a-follow-on)
- [What it buys](#what-it-buys)
- [Risks and open questions](#risks-and-open-questions)
- [What I would do, in order](#what-i-would-do-in-order)

<!-- tocstop -->

## The short answer

A miss is **observable today on Anthropic and nowhere else**, it is **computable** rather than
reported, and it is **not written down anywhere**. Making it durable is a small change with one
genuinely hard part, and the hard part is not storage.

- Anthropic returns `cache_read_input_tokens` and `cache_creation_input_tokens` on every call as
  billing facts, so a zero read is a real zero (`anthropic.ts:34-46`).
- Gemini's implicit cache reports a matched prefix rather than a bill, says nothing at all on many
  calls that did hit, and has no cache-write counterpart, so a zero there means nothing
  (`gemini.ts:99-116`).
- No vendor reports a *miss*. There is no field for it. A miss is an inference from two consecutive
  receipts plus the time between them, which means whatever records it has to hold the sequence.
- The thread file has no line type that could carry a receipt (`threads.ts:50-55`), and the reducer
  that decides what gets written only writes what lands in `convo.feed` (`session.ts:850-864`) — a
  `usage` event adds to `convo.tokens` and adds no feed item, so nothing reaches disk.

The hard part is **deciding what counts as a miss**, and the sharpest risk is a backend that
reports `0` because it has no accounting rather than because the cache missed.

## What exists today

### The receipt

`TokenUsage` (`packages/providers/src/backend.ts:47-61`) carries `input`, `output`, and an optional
`cacheRead` / `cacheWrite` split carved back out of `input` rather than added beside it. A fourth
field, `cacheEstimated`, marks the split as a matched-prefix count rather than a line on a bill.

Three states are already distinguishable, and the type says so without needing a new field:

| `cacheRead` | `cacheEstimated` | Means | Who produces it |
| --- | --- | --- | --- |
| absent | — | The vendor said nothing about caching | Gemini's early calls, the text path, mock backends |
| present | `true` | A matched prefix, not a bill | Gemini (`gemini.ts:114`) |
| present | absent | A billing fact | Anthropic (`anthropic.ts:37-44`) |

The doc comment on `TokenUsage` states the rule the rest of the system depends on: "Absent means the
vendor said nothing, which is not the same as zero."

### The path from receipt to screen

1. `Agent.run` charges the receipt against the turn budget and emits it —
   `spent += charge(turn.usage); emit({type: 'usage', ...turn.usage})` (`loop.ts:683-686`). The
   receipt is emitted **before** the step it paid for is narrated, so a total never lags the
   transcript.
2. `charge` (`packages/types/src/budget.ts:59-61`) is `input - (cacheRead ?? 0) + output`. Cache
   reads do not count against the budget; cache writes do.
3. `applyEvent` folds the receipt into `convo.tokens` as a running sum (`convo.ts:364-377`), with
   `cacheEstimated` sticky once any step sets it.
4. `tokensDetail` (`convo.ts:133-161`) renders the tooltip on the token counter.

### Where it stops

`WorkspaceSession.record` (`session.ts:850-864`) reduces the conversation and appends **whatever
that added to `convo.feed`** to the thread. A `usage` event produces no feed item, so it is never
appended. The thread's line vocabulary is `thread` | `item` | `title` | `binding` | `archived`
(`threads.ts:50-55`) and has no slot for a receipt.

The comment on `Convo.tokens` (`convo.ts:258-266`) already states this as a deliberate property:
"Nothing writes it to a thread, so a reopened thread starts at zero and says so."

Two consequences worth naming, because they are what a durable record would fix:

- **Per-call detail is destroyed even in memory.** `applyEvent` sums. A conversation that missed on
  every step and one that hit on every step both end up showing a percentage — a different one, but
  the same *shape* of number, with nothing to point at.
- **The one place a miss is currently asserted is a script you have to remember to run.**
  `scripts/verify-prompt-cache.mjs:145-148` runs two steps of a throwaway conversation and fails
  with "step 2 read nothing from the cache — the prefix changed between the two steps." That is
  exactly the assertion this report wants, applied to real conversations instead of a probe.

## Which vendors can support it

The question in the title — "models that support it" — is really a question about backends, and
[`local-and-self-hosted-models.md` §"Cached-token reporting"](local-and-self-hosted-models.md#cached-token-reporting-is-the-one-thing-that-must-be-checked-and-most-servers-fail-it)
already surveyed it. Condensed to the three categories that matter here:

| Backend | Reporting | Can a miss be inferred? |
| --- | --- | --- |
| Anthropic | Billed read + write | **Yes** |
| Gemini | Matched prefix, read only, silent on many hits | No — silence and a miss are the same bytes |
| llama.cpp / `llama-server`, vLLM | Real `cached_tokens` | Yes, once a backend exists |
| Ollama, KoboldCpp, LM Studio | **Hardcoded `0`** | **No, and worse than no** |

That last row is the finding that should shape the design. Ollama's `openai/responses.go` emits
`"input_tokens_details": {"cached_tokens": 0}` unconditionally. A receipt shaped like a billing fact
that is actually a stub is **indistinguishable from an honest total miss**, so any rule of the form
"`cacheRead === 0 && !cacheEstimated` therefore missed" would report a 100% miss rate against a
server whose cache is working perfectly.

**Recommendation: gate on a declared capability, not on the shape of the receipt.** The backend
knows what it is talking to; the receipt does not. Something like a `cacheReporting: 'billed' |
'estimated' | 'none'` on `ChatBackend` alongside `modelId`, declared by whoever wrote the backend,
with `'none'` the default so an unaudited runtime is silent rather than slanderous. This is the same
shape as the existing `chatConversation?` probe (`backend.ts:135`), where a host asks the backend
what it can do rather than inferring it from a reply.

## What counts as a miss

No vendor has a miss field. A receipt on its own cannot tell you anything: a first call legitimately
reads nothing, and reporting that as a miss would mean every conversation opens with one.

The usable signal is a **relation between consecutive receipts in one conversation**. On a healthy
run, call *N*'s `cacheRead` should be at least call *N−1*'s `cacheRead + cacheWrite` — everything
that was readable last step, plus whatever was written last step, should be readable this step.
A drop means the prefix was invalidated between the two calls.

That gives four verdicts, and they need to stay distinct because they have different causes and
different fixes:

| Verdict | Test | What it means |
| --- | --- | --- |
| `cold` | First call of the conversation | Nothing to hit. Not a defect. |
| `hit` | `cacheRead >= prev.cacheRead + prev.cacheWrite` | Working. |
| `expired` | Read dropped, and more than the TTL elapsed since the previous call | The author went to lunch. Not a defect. |
| `miss` | Read dropped inside the TTL | **The prefix broke.** This is the one worth a record. |

The TTL is the confounder, and it is why a receipt needs a timestamp to be judged at all. The
breakpoint marker is `{type: 'ephemeral'}` with no explicit TTL (`convo-request.ts:13-14`), and the
comment there gives the reasoning: "Default TTL (5 minutes): an agent's steps are seconds apart."
Inside one turn that holds. Across turns of a conversation an author is thinking between, five
minutes is nothing — so a naive rule would mark a normal working rhythm as a defect several times an
hour. Thread lines are already stamped (`appendItem` writes `at`, `threads.ts:256`), so the
timestamp is free.

A `miss` inside the TTL has a small set of causes, all of them ours rather than the vendor's, which
is what makes the record actionable:

- A byte changed in `tools` or `system`. `refreshSystem` (`loop.ts:547-565`) exists specifically to
  avoid this — it appends a `{role: 'system'}` message rather than editing the prompt in place, so a
  mid-conversation change costs one cache write and invalidates nothing. A miss here means something
  bypassed it.
- The tool catalog changed order. `toolSpecs` (`loop.ts:573-578`) derives from a static list plus the
  registry's own order so that "two turns of one conversation produce byte-identical catalogs."
- A breakpoint moved or was dropped. `markLast` (`convo-request.ts:41-53`) clones rather than mutates
  precisely because "a marker left behind would be a changed byte in a prefix that is supposed to be
  identical", and `messagesOf` keeps only the newest two marks to stay inside the cap of four.
- A thinking block was rebuilt instead of echoed. `UNMARKABLE` (`convo-request.ts:26`) guards the
  marker side of this.

Each of those is a regression someone could introduce in a refactor and never notice, because
nothing fails — the conversation still works, it just costs several times more. That is the case for
recording it.

## Where the record could live

### Option A — a new `usage` line in the thread file (recommended)

Add a fifth line type beside the four that exist:

```json
{"type":"usage","at":"2026-08-21T18:04:11.902Z","step":7,"input":41230,"output":612,
 "cacheRead":39100,"cacheWrite":1980,"verdict":"hit"}
```

The compatibility story is unusually good, and mostly by accident of how the existing readers are
written:

- **`readThread` already ignores it.** It filters `line.type === 'item'` (`threads.ts:195`), so an
  unknown line type is dropped, not thrown over. Old code reading a new file is fine.
- **New code reading an old file is fine.** `lines()` skips what will not parse and `headerOf`
  tolerates missing records; a thread with no usage lines simply reports nothing, which is the same
  answer the system already gives for a vendor that said nothing.
- **`listThreads` does not need touching.** Its cheap substring filter keeps only lines containing
  `"thread"`, `"title"`, `"binding"` or `"archived"` (`threads.ts:175-179`), so usage lines are
  skipped during the header scan without a wasted parse.
- **No merge attribute is needed.** Thread files are not in `templates/basic/.gitattributes` and do
  not need to be — a socket lock means one process owns a project, so unlike
  `notifications.jsonl` there is no union-merge to design a per-line version around.

The write site is the awkward part. `record` only writes feed items, so a receipt cannot ride the
existing path. Two sub-options: give `WorkspaceSession` a second, narrower writer that appends a
usage line when it sees a `usage` event, or generalise `record` to take "lines to append" rather than
"reduce and diff the feed". The first is smaller and keeps `record`'s one job intact; the second
avoids a second `this.writes` chain and the ordering question that comes with it. **The first**, on
the grounds that the two write paths already serialize through the same `this.writes` promise and
adding a branch there is smaller than reshaping the reducer's contract.

Volume is not the objection it first appears to be. One line per API call, at roughly 150 bytes,
against `item` lines already clamped to 400 characters of text plus up to 8,000 of `full`
(`threads.ts:39-48`). A 40-step turn adds about 6 KB to a file that turn was already adding far more
than that to. Threads are committed and travel with the project, and the added bytes are integers —
no fiction, no prose, nothing to redact.

### Option B — compute the verdict in the loop and widen the event

Independent of where it is stored: **the verdict should be computed in `@vn/authoring`, not in the
desktop app.** The loop is the only place that has the per-call sequence, the previous receipt, and
the elapsed time, and it is the layer `vnauthor`'s REPL shares with the desktop — so a verdict
computed there is available to both hosts, while one computed in `session.ts` is available to
neither the CLI nor the tests.

That means widening the `usage` event (`loop.ts:142-149`) with the verdict and leaving the storage
decision to the host. It also means the loop needs the backend's declared `cacheReporting`, which it
can read once at construction alongside `modelId`.

### Option C — the vendor's own diagnosis, as a follow-on

Anthropic ships a beta that answers the *why* rather than the *whether*: `client.beta.messages.*`
with beta flag `cache-diagnosis-2026-04-07`, passing `diagnostics: {previous_message_id: <previous
response id>}` and reading `response.diagnostics`. That reports what actually broke the prefix
instead of leaving it to be deduced from a drop in a number.

This is the right long-term answer and the wrong first move. It is Anthropic-only and beta, it needs
the previous response id threaded through `ChatConvoReply`, and it would put a vendor-specific
concept into a seam that is deliberately vendor-neutral (`backend.ts` exists so "backends swap by
changing model ids in `project.yaml`"). The computed verdict works on every honest backend including
the local ones; the diagnosis, if it lands, refines a `miss` that has already been detected.

## What it buys

**The analyst.** `report.agent` reads the thread to diagnose a bad conversation
(`agentreport/src/transcript.ts`). "This turn re-sent 40,000 tokens of prefix uncached, eleven times"
is a fact it currently cannot see and would have no way to guess. The numbers are integers, so they
cross the redaction boundary safely — though see the risk below.

**A regression test with teeth.** `verify-prompt-cache.mjs` proves the breakpoints were placed, on a
two-step probe, when someone runs it. A verdict on every real call turns that into a property of
normal use, and makes "did that refactor break the prefix" answerable from a saved thread rather than
by re-running a script against a live key.

**An honest budget.** `charge` treats an absent split as "no cache read", so a miss is already
charged correctly against the turn ceiling. What is missing is any way to tell an expensive turn
apart from a *wastefully* expensive one after the fact.

## Risks and open questions

- **A stub that looks like a bill.** Restated because it is the one that produces wrong output rather
  than no output: a hardcoded `cached_tokens: 0` is byte-identical to an honest miss. The declared-
  capability gate is the mitigation, and its weakness is that it is a claim by whoever wrote the
  backend rather than something checkable at runtime.
- **The redactor passes unknown fields through.** `redactEvidence` spreads `...evidence.thread`
  (`transcript.ts:77-83`) and scrubs the fields it names. A usage array survives that unscrubbed,
  which is correct for integers and would be silently wrong for any future field that is not. The
  redaction contract is "enforced at a boundary, not requested in a prompt" — an open spread is not
  quite that boundary, and adding a field to the thread record is the moment to notice it.
- **Two hosts, one loop, one storage.** Threads are desktop-only today, though `threads.ts:10-12`
  says the module is written to move down to `@vn/authoring` when the REPL wants them. A verdict
  computed in the loop is available to `vnauthor` immediately and storable by it only after that
  move.
- **The TTL is assumed, not read.** The `expired` verdict needs a number, and the code has one
  implicitly — the default five minutes that `EPHEMERAL` carries by omission. Naming it as a constant
  beside the marker is a prerequisite; raising it to `ttl: '1h'` is a separate decision with its own
  cost, and it would change what `expired` means.
- **Nothing says what a miss costs in money.** The app "can name call counts but never money"
  ([`a-less-technical-mode.md`](a-less-technical-mode.md)). A miss record is a token count, and
  turning it into a dollar figure needs the price table that does not exist yet.

## What I would do, in order

1. **Declare the capability.** `cacheReporting: 'billed' | 'estimated' | 'none'` on `ChatBackend`,
   `'billed'` for Anthropic, `'estimated'` for Gemini, `'none'` by default. Nothing consumes it yet.
   Pure addition, testable without a key.
2. **Compute the verdict in the loop** and widen the `usage` event with it, gated on
   `cacheReporting === 'billed'`. The loop already holds the previous receipt for `spent`. Name the
   TTL constant while doing it. Testable against a scripted backend the way `loop.test.ts:185-190`
   already tests receipts.
3. **Write the `usage` line**, and read it back on `ThreadRecord`. Two small changes in
   `threads.ts`, one branch in `session.ts`.
4. **Show it**, if it turns out to be worth showing — a sentence in `tokensDetail`, or a durable
   notification when a turn's misses cross a threshold. This is the step to defer until steps 1–3
   have produced enough real data to know whether misses are rare (in which case a notification is
   right) or routine (in which case the threshold is a nuisance and the log is the product).

Steps 1 and 2 are worth doing whether or not step 3 follows: they make the miss visible live and in
tests, which is most of the value. Step 3 is what makes it survive the conversation.

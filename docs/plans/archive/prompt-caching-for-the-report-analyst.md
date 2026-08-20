# Prompt caching for the difficult-agent report analyst

## What this is

The difficult-agent report's analyst (`packages/agentreport/src/analyze.ts`) is the last
production consumer of the uncached agent path. Its looping branch hard-codes
`new StructuredAgentBackend(opts.backend)` (`analyze.ts:252`) — Path A, which re-renders the
entire transcript, tool catalog and protocol into one fresh prompt string every iteration and
sends it through the plain `message()` seam. Nothing in that request carries a `cache_control`
marker, and nothing could: the prompt body changes every turn, so there is no stable prefix.

Both other agent hosts already probe for the cached path and take it when the backend offers it:

- `apps/desktop/src/main/session.ts:872` —
  `chat.chatConversation ? new NativeAgentBackend(chat) : new StructuredAgentBackend(chat)`
- `apps/authoring/src/agent.ts:98-99` — the same probe, behind a `--no-native` escape hatch.

The archived caching plan
([`prompt-caching-and-deferred-tool-loading.md`](prompt-caching-and-deferred-tool-loading.md))
even flagged the analyst as the consumer it was leaving behind. This plan closes that gap: the
analyst's loop uses `NativeAgentBackend` whenever the resolved backend implements
`chatConversation`, and `StructuredAgentBackend` otherwise.

## Why it is worth doing

The analyst runs up to 24 iterations (`maxIterations` default, `analyze.ts:257`), and its first
user message is the whole redacted transcript of a conversation that went badly — typically the
largest single block of text the app ever puts in a prompt. On Path A, iteration *n* re-pays
full input price for the transcript plus every observation so far; the cost of a source-reading
analysis is quadratic in what it reads. On Path B the transcript is sent as turns with a rolling
pair of cache breakpoints (`NativeAgentBackend`, `packages/authoring/src/backend.ts:314-324`),
so each iteration pays cache-read price for everything before its own tail.

This runs on the author's own key — the analyst is exactly the place the app should not be
wasteful with someone else's money.

The archived caching plan judged leaving the analyst behind "acceptable: … a short analysis run
… the one caller caching would barely help"
([`prompt-caching-and-deferred-tool-loading.md`](prompt-caching-and-deferred-tool-loading.md):573-580).
That judgment predates the request tools: a detail-only run is now a loop too
(`analyze.ts:164-171`), `fetch_api_docs` and the request tools give a run more to read and more
iterations to spend, and the transcript that dominates every request has only grown. The
per-iteration re-send is quadratic in what the analyst reads; "short" was the premise, and it no
longer holds.

## What already works, verified in the code

The change is small because everything it needs was built for the desktop conversation loop:

- **The marker machinery is Path B's alone.** `cache_control` is written in exactly one place,
  `packages/providers/src/backends/convo-request.ts` — the system block (`:124`), the last
  loaded tool (`:99`), and the turns `NativeAgentBackend` marks (`:50`). The `message()` seam
  the structured path uses never attaches one, so no change to the fallback is needed or wanted.
- **`record: false` is honoured on the cached path.** The analyst's backend is built with
  `{ record: false }` so its own requests stay out of the request ring it may be reading
  (`analyze.ts:143`). `createAnthropicChat` threads that flag into every capture, including
  `chatConversation`'s (`packages/providers/src/backends/anthropic.ts:196`) — so switching paths
  does not put the analyst's prompts back in the ring.
- **The probe degrades correctly.** Only the Anthropic backend implements `chatConversation`
  (`packages/providers/src/backend.ts:137` is optional; `anthropic.ts:191` is the one
  implementation). An author who picks a Gemini analysis model gets the structured path exactly
  as today, from the same probe both hosts already use.
- **The loop above the seam is shared — with one path-dependent exception, tool deferral,
  handled below.** The analyst drives the same `Agent` class as the desktop conversation, which
  already answers every tool call in a parallel batch, records `raw` assistant blocks so
  thinking blocks are echoed back unmodified, and validates `submit_report`'s args against
  `analysisArgs` via the registry. What is *not* path-neutral: `Agent.toolSpecs()` flags every
  tool outside the static `ALWAYS_LOADED` six as `defer: true`
  (`packages/authoring/src/loop.ts:563-574`); Path A ignores the flag, Path B forwards it, and
  the API then hides those tools behind server-side tool search
  (`convo-request.ts:88-101`).
- **`NativeAgentBackend` is stateful per instance** (`prevBreak`), and the analyst builds one
  backend per run, so runs cannot leak breakpoints into each other.

## The change

Two files of production code.

**`packages/authoring/src/loop.ts` — an `Agent` that never defers.** The agent options grow
`deferTools?: boolean`, default `true`; when `false`, `toolSpecs()` skips the `defer` flag
entirely. Deferral exists for vnauthor's large catalog, where unloaded schemas buy real context
back; the analyst has six tools, so deferring them buys nothing and costs correctness — with the
default behaviour, everything but `read_file` (a lucky name collision with `ALWAYS_LOADED`)
would be hidden behind tool search, **including `submit_report`**, the one tool `LOOP_PROTOCOL`
orders the model to call. A model that never searches for it finishes without filing, and the
run silently degrades to `analyzeDirectly` with `fellBack` set — exactly the waste this plan
exists to remove, invisible except as a fallback note. `deferTools: false` also means
`buildConvoRequest` sees no deferred tool, so no BM25 search tool is prepended and the tools
breakpoint lands on the true last tool (`convo-request.ts:89-101`) rather than on a control
tool. Additive, default-preserving; the desktop and vnauthor are untouched.

Considered and rejected: an `alwaysLoad` flag per `Tool`, or widening `ALWAYS_LOADED` — both
put a per-tool policy on shared surface for a host whose real policy is "all six, always".

**`packages/agentreport/src/analyze.ts`:**

1. Import `NativeAgentBackend` alongside `StructuredAgentBackend` from `@vn/authoring`.
2. In `analyzeWithTools`, replace the hard-coded construction with the probe both hosts use,
   and pass the new option:

   ```ts
   const chat = opts.backend;
   const agent = new Agent({
     backend: chat.chatConversation
       ? new NativeAgentBackend(chat)
       : new StructuredAgentBackend(chat),
     deferTools: false,
     // ...unchanged: ctx, permission, system, registry, maxIterations
   });
   ```

3. Update the file-top comment: the loop is "the ordinary authoring loop" — now on the same
   backend selection as the ordinary hosts, which is the point.

No new option. The desktop and `vnauthor` do not expose a per-run "no native" switch either
(`--no-native` is a `vnauthor` CLI dev flag, not an author-facing choice), and the analyst
should not grow a knob its hosts don't have. If the native path misbehaves for the analyst it
misbehaves for the whole app, and the fix belongs in the shared code.

**Deliberately out of scope:**

- **The direct path (`analyzeDirectly`) stays uncached.** It is a single `message()` call; there
  is no second request to read a cache written by the first, so a marker would buy a 25% write
  premium and nothing back.
- **No shared `buildAgentBackend` helper.** Three call sites of a two-line ternary do not earn a
  cross-package export, and the `vnauthor` site has the extra `noNative` condition anyway. If a
  fourth condition ever appears, extract then.
- **The fallback chain is unchanged in shape, and two behaviour shifts are accepted.** A
  native-path failure that surfaces as the analyst finishing without filing still falls back to
  `analyzeDirectly` with `fellBack` recorded; a `ProviderError` still propagates, as it does
  today from the structured path's rethrow. Two things do change and are accepted deliberately:
  - **The budget stretches.** `charge()` excludes `cacheRead` (`packages/types/src/budget.ts`),
    so on Path B the re-read transcript stops counting against the loop's `DEFAULT_BUDGET` and
    budget-exhaustion fallbacks become rarer. That is the desired direction — the budget meters
    spend, and cached reads are the cheap kind — not an accident to paper over.
  - **New 400 classes, and the one request nobody can diagnose.** Convo assembly can fail in
    ways `message()` cannot (thinking-block echo, `tool_use`/`tool_result` pairing,
    `cache_control` placement), and such a `ProviderError` propagates out of `analyze()`
    uncaught, exactly as a structured-path refusal does today. Because the analyst runs
    `record: false`, its own failing body is deliberately absent from the request ring — the one
    fault class the request-diagnosis feature cannot see is the analyst's own. Accepted: the
    alternative is recording the analyst into the ring it reads, which the ring's design
    forbids for better reasons.

## Tests

`packages/agentreport/src/tests/analyze.test.ts`:

- **Existing tests keep passing untouched.** The test fakes implement `message()` only, so the
  probe leaves them on the structured path — which is itself the regression check that the
  fallback still works.
- **New: the native path is taken and marked.** A fake `ChatBackend` that implements
  `chatConversation` capturing `(req, tools)` and answering with a single `submit_report` tool
  call (then, on the follow-up turn, plain text). The fake must honour the real reply contract:
  `ChatConvoReply.raw` is a **required** field, and each tool call needs an `id` so the loop can
  pair the observation via `toolUseId`. Assert:
  - `chatConversation` was called and `message` was not — the probe selected Path B;
  - the last turn of each captured request has `cache: true` — the rolling breakpoint reached
    the analyst's transcript (the marker-to-`cache_control` translation is already covered by
    `convo-request.test.ts` and stays there);
  - **no captured tool carries `defer`, and `submit_report` is among them** — the jest-visible
    evidence for the `deferTools: false` half of the change;
  - the report was filed and scrubbed exactly as on the structured path.
- **New, in `packages/authoring`:** a `toolSpecs()`-level test that `deferTools: false` yields a
  catalog with no `defer` flags and the default still defers everything outside
  `ALWAYS_LOADED`.
- **New: detail-only runs probe too.** The same fake through the `detail`-without-`source`
  branch, since that run supplies `ctx` separately and is the easiest branch to regress.

## Verification beyond jest

`scripts/verify-prompt-cache.mjs` already drives `NativeAgentBackend` against the live API and
reads the cache fields off the usage receipt. A one-off live check of the analyst itself: run a
report with the source box ticked on an Anthropic analysis model and confirm the second and
later iterations report `cacheRead > 0`, that the run files a report rather than falling back
(`fellBack` absent), and that it does not stall in tool-search rounds — with `deferTools: false`
there should be none. (The analyst deliberately does not record to the request ring, so the
receipt is the only evidence — which is fine, it is the thing being claimed.)

## Docs to update when shipping

- [`../../reference/agent-report.md`](../../reference/agent-report.md) "The analyst" — the sentence
  that the loop runs the native cached path when the model's backend supports it (structured
  otherwise, tools never deferred) belongs where the *loop* is described, which is two places:
  the with-source bullet and the detail-only section further down, since a detail-only run is
  the same loop.
- [`../index.md`](../index.md) — row flips to shipped, file moves to `archive/`.
- `CLAUDE.md` needs no change: its agent-report bullet describes redaction boundaries, not the
  transport.

## Cost to undo

The analyze.ts half is a one-line ternary plus an option; reverting it changes nothing
persisted (threads, reports, notifications are format-identical on either path). The
`deferTools` option is the only shared surface, and it is additive with a preserving default,
so removing it later is a mechanical revert of one option and its tests. Nothing in this plan
writes a format anyone else reads.

## Pressure-test findings

A fresh-context review (2026-08-20) returned nine findings; each is now answered in the body
above. The disposition, for the record:

1. **Tool deferral is path-dependent (blocker).** Confirmed — on Path B the default `Agent`
   defers everything outside `ALWAYS_LOADED`, which would hide `submit_report` itself behind
   tool search and turn missed submissions into silent `fellBack` degradations. Fixed: the plan
   now adds `deferTools: false` (see "The change"), rather than accepting deferral or widening
   shared per-tool policy.
2. **Request shape (search tool prepended, breakpoint on a control tool).** Mooted by
   `deferTools: false` — no deferred tool means no BM25 search tool and the breakpoint on the
   true last tool; the live check now also watches for search-round stalls.
3. **Native-path test under-specified.** Fixed — the test section now requires the fake to
   return `raw` and tool-call `id`s, and to assert the un-deferred catalog.
4. **Reverses the archive's "barely help" judgment without answering it.** Fixed — the "Why"
   section now says why that judgment no longer holds (request tools, detail-only loops,
   transcript-dominated input).
5. **Path B stretches the token budget** (`charge()` skips `cacheRead`). Acknowledged in
   "out of scope" as a deliberate, desirable shift, not an accident.
6. **New no-fallback 400 classes, and the analyst's own request is un-diagnosable**
   (`record: false` keeps it out of the ring). Acknowledged as accepted risk, same section.
7. **Citation nit** (`backend.ts:313` → `:314-324`). Fixed.
8. **Docs update aimed only at the with-source bullet.** Fixed — both places the loop is
   described.
9. **Undo cost unstated.** Fixed — section above.

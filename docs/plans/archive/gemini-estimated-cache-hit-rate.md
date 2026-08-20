# A Gemini cache hit rate the tooltip can say is an estimate

The tokens counter in the convo bar already knows how to say what a cache did — `sayTokens`
writes _"Of the input, 900 read from cache (75%) and 300 written to it"_ whenever `Convo.tokens`
carries a split. Only Anthropic ever fills that split in, because `createAnthropicChat` reads
`cache_read_input_tokens` / `cache_creation_input_tokens` off the reply and `createGeminiChat`
reads nothing of the kind. On a Gemini-backed conversation the sentence never appears, which
reads as _this provider does not cache_ — and that is not true.

This plan makes Gemini fill the split in, and makes the tooltip say the number is an **estimate**
rather than a bill.

<!-- toc -->

<!-- tocstop -->

## What Gemini actually reports

Measured against `gemini-2.5-flash` on the author's own key, 2026-08-18, five calls carrying an
identical 3,452-token prefix (a fixed paragraph repeated 40 times, then a one-word question that
differed per call):

| call | `promptTokenCount` | `cachedContentTokenCount` |
| ---- | ------------------ | ------------------------- |
| 1    | 3452               | _absent_                  |
| 2    | 3452               | _absent_                  |
| 3    | 3452               | 3045                      |
| 4    | 3452               | 3045                      |
| 5    | 3452               | 3045                      |

Three facts fall out of that table, and they are the whole design:

- **There is a number, and it is a subset of `promptTokenCount`.** 3,045 of 3,452 prompt tokens
  were served from Gemini's implicit cache. That is exactly the shape `TokenUsage.cacheRead`
  already documents — _"of `input`, what was billed at the cache-read rate"_ — so it needs no
  new arithmetic and no change to what a total means.
- **There is no write counterpart.** Gemini's implicit cache bills no cache-creation line, so
  `cacheWrite` stays absent, which under the existing contract already reads as _"the vendor said
  nothing"_ rather than _"zero"_.
- **It is silent until it warms up.** Calls 1 and 2 reported nothing at all with a byte-identical
  prefix. An absent count therefore does not mean the cache missed — it means Gemini did not say.
  This is the reason the tooltip must not present the figure the way it presents Anthropic's.

A second probe put the shared bytes in `systemInstruction` instead of `contents` and got no
report across four calls; the run above put them in the first `contents` turn. Not enough calls to
call that a rule, and the change does not depend on it — but it is the reason the verification
script below repeats a call five times rather than twice.

## The change

**`TokenUsage` grows one optional flag.** `cacheEstimated?: boolean` — the cache split is the
provider's own best-effort match count rather than a billed line item. Anthropic never sets it;
Gemini sets it whenever it reports a count at all. Absent means the figures are billing facts,
which is what every existing caller already assumes.

**`usageOf` in `backends/gemini.ts` carves `cachedContentTokenCount` out as `cacheRead`** and sets
the flag beside it. `promptTokenCount` already includes the cached tokens, so `input` is untouched
and the split really is carved _out_ of it, exactly as Anthropic's is.

**The flag rides the wire the split already rides**: `plus()` in `@vn/authoring`'s backend (sticky
— if any retried attempt was an estimate, the sum is), the `usage` variant of `AgentEvent`,
`Convo.tokens`, and `received`.

**The tooltip sentence moves out of the editor.** `sayTokens` builds prose inline, which the
renderer's own rule says belongs in a `.ts` with a `tests/` sibling; `apps/desktop/src/shared/convo.ts`
already holds `threadLabel` / `threadDetail` doing precisely this job for the thread menu. A new
`tokensDetail(tokens)` joins them, and the editor keeps only the glanceable label. The estimated
branch reads:

> Of the input, roughly 900 (75%) was already cached — an estimate, because the provider reports
> what it matched rather than what it billed, and says nothing at all on many calls that did hit.

Provider-neutral on purpose: the flag says _this is a match count_, not _this is Gemini_.

## What this deliberately does not do

- **It does not make Gemini cache better.** There is no `chatConversation` on the Gemini backend,
  so a Gemini-backed agent is still on the single-shot `chatWithTools` path with no breakpoints to
  place. Whatever the implicit cache catches, it catches. Reporting it is the whole scope.
- **It does not touch the label.** `todos.md`'s _"The tokens counter label should keep track of
  uncached tokens only"_ is a separate item about the glanceable number, and stays open.
- **It does not reach `vnauthor`'s REPL**, which accumulates `input`/`output` only and shows no
  split for any provider.

## Files this touches

| File                                            | Why                                                          |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `packages/providers/src/backend.ts`             | `TokenUsage.cacheEstimated`                                   |
| `packages/providers/src/backends/gemini.ts`     | `usageOf` reads `cachedContentTokenCount`                     |
| `packages/authoring/src/backend.ts`             | `plus()` carries the flag across retries                      |
| `packages/authoring/src/loop.ts`                | the `usage` event variant                                     |
| `apps/desktop/src/shared/convo.ts`              | `Convo.tokens`, `received`, and the new `tokensDetail`        |
| `apps/desktop/renderer/pathux/editors/convo.ts` | `sayTokens` becomes label + `tokensDetail`                    |
| `scripts/verify-prompt-cache.mjs`               | a Gemini branch, and a SKIP message that is no longer a lie   |

## Tests

Unit, in the jest run:

- `packages/providers/src/tests/gemini-usage.test.ts` — through the injectable `GeminiClient`
  seam the retry tests already use: a reply with `cachedContentTokenCount` yields `cacheRead` +
  `cacheEstimated`, a reply without one yields neither (**not** `cacheRead: 0`), and `cacheWrite`
  is never invented.
- `apps/desktop/src/shared/tests/convo.test.ts` — the split accumulates, `cacheEstimated` is
  sticky across steps, and `tokensDetail` says "estimate" only when it is one.

Live, on a real key and a real bill — `node scripts/verify-prompt-cache.mjs [dir]`, which is not
in `package.json` and which `pnpm test` does not run. It dispatches on the configured
`models.text`: Claude takes the existing two-step breakpoint proof, Gemini takes a five-call
identical-prefix run asserting that at least one call came back with a cache read. Five because
of the warm-up in the table above — a two-call version of this test fails against a working
implementation.

## What shipped differently

**The warm-up is not a warm-up — it is intermittency, and it changed the live test.** A second
five-call run on the same day, same model, same fixed prefix reported a cache read on call 4 and on
_no other call_: not calls 1–3, and not call 5 after a hit. So the table above is one sample of a
behaviour with no monotone shape, and "silent until it warms up" understates it. Two consequences:

- The first version of `verifyGemini` asserted `cacheEstimated` on the **last** call's usage and
  failed a correct implementation, because the last call reported nothing. It now captures the
  usage of the first call that actually hit and asserts on that, with a comment saying why.
- It is the sharpest argument for the flag existing at all. A number that is present, then absent,
  then present for byte-identical requests is not a bill, and a running total that mixes it with
  one should not be presented as though it were.

Everything else shipped as planned. `pnpm check` (both passes), `pnpm test` and `pnpm lint` are
green; the live ritual passes against `gemini-2.5-flash`. The Claude branch of
`verify-prompt-cache.mjs` was only moved into a function and re-keyed through the new `keyFor`
helper — its assertions are untouched — and was **not** re-run, the live permission for this work
being scoped to the Gemini key.

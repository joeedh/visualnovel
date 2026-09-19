# OpenRouter prompt caching, live (2026-09-19)

_The one live check `docs/plans/openrouter-as-a-fallback-transport.md` owed: stage 7,
`scripts/verify-prompt-cache.mjs --via openrouter`, run once against Claude and once
against Gemini on the OpenRouter key alone. Everything below is copied from the script's
output on 2026-09-19; the requests were ordinary `createOpenRouterChat` calls with
`effort: 'low'`, and nothing printed a key._

<!-- toc -->

- [What was run](#what-was-run)
- [Claude Opus 4.8 as `anthropic/claude-opus-4.8`](#claude-opus-48-as-anthropicclaude-opus-48)
- [Gemini 2.5 Flash as `google/gemini-2.5-flash`](#gemini-25-flash-as-googlegemini-25-flash)
- [What the plan can now state](#what-the-plan-can-now-state)
- [What is still open](#what-is-still-open)

<!-- tocstop -->

## What was run

- `node scripts/verify-prompt-cache.mjs templates/basic --via openrouter` for Claude, and
  the same against a scratch copy of `templates/basic` whose `models.text` is
  `gemini-2.5-flash` for Gemini.
- `--via openrouter` narrows the route to `{ openrouter: true }` and every other vendor
  `false`, so the machine's native keys could not take the call, then runs the script's
  existing ritual (two turns of one conversation for Claude, five identical calls for
  Gemini) through `createOpenRouterChat`.
- The script's OpenRouter branch prints two notes after the ritual: the `prompt_tokens`
  arithmetic on the turn that wrote the cache, and whether the request ring holds a
  refused-and-resent effort request (`captureRequest('openrouter-chat')` records the 400
  that triggers the one-shot downgrade).

## Claude Opus 4.8 as `anthropic/claude-opus-4.8`

```
via OpenRouter as anthropic/claude-opus-4.8
model claude-opus-4-8 — two calls, both billed
step 1 · input 2227, output 4, cache read 0, cache written 2225
step 2 · input 2238, output 5, cache read 2225, cache written 11
note · prompt_tokens (2227) covers the cache write (2225), so PROMPT_INCLUDES_WRITE = true holds
note · the effort level was accepted as sent
PASS — step 2 read 99% of its input from the cache.
```

- The breakpoints registered: step 1 wrote 2225 tokens and step 2 read the same 2225 back,
  with an 11-token write for the new tail. That is the native Anthropic shape.
- `prompt_tokens` (2227) is the whole prompt including the 2225 written, so
  `PROMPT_INCLUDES_WRITE = true` in `openrouter-chat.ts` is the right setting and
  `usage.input` is derived as `prompt_tokens − cached − written`.
- `reasoning: { effort: 'low' }` was accepted outright: the ring holds one request per
  step and no 400. The plan's worry that OpenRouter would map effort to a `budget_tokens`
  the model refuses did not materialise on Opus 4.8.

## Gemini 2.5 Flash as `google/gemini-2.5-flash`

```
via OpenRouter as google/gemini-2.5-flash
model gemini-2.5-flash — 5 calls, all billed
call 1 · input 3455, output 1, cache read 0, cache written 0 (estimated)
call 2 · input 3455, output 2, cache read 0, cache written 0 (estimated)
call 3 · input 3455, output 2, cache read 0, cache written 0 (estimated)
call 4 · input 3455, output 2, cache read 3059, cache written 0 (estimated)
call 5 · input 3455, output 1, cache read 0, cache written 0 (estimated)
note · the effort level was accepted as sent
PASS — 1 of 5 calls reported a cache read, first on call 4, 89% of its input.
```

- Implicit caching behaves as it does direct: no write is ever reported, most hits are
  silent, and one call in five said it read 89% of its prefix. The `(estimated)` tag is
  `cacheReporting: 'estimated'`, which the backend sets for a Gemini native.
- `prompt_tokens` stayed at 3455 on the hit, i.e. it counts the cached tokens too, so the
  same `prompt_tokens − cached` arithmetic holds for Gemini.
- `effort: 'low'` was accepted on Gemini as well.

## What the plan can now state

| Claim in the plan's "Verified and unverified facts"                         | Now                      |
| --------------------------------------------------------------------------- | ------------------------ |
| `cache_control` registers and `cached_tokens` rises on turn two             | verified live, Claude    |
| `prompt_tokens` includes `cache_write_tokens`                               | verified live, Claude    |
| `reasoning.effort` is accepted on Opus 4.8                                  | verified live (`low`)    |
| OpenRouter maps effort to `budget_tokens` that current Claude models refuse | did not happen for `low` |
| Gemini's implicit cache reports through OpenRouter as it does direct        | verified live, Gemini    |

## What is still open

- Only `low` was sent. `max`/`xhigh` on Opus 4.8 and Opus 5 were not tried, so the
  one-shot downgrade path in `openrouter-chat.ts` remains exercised only by its fake-fetch
  test.
- The tools block is still not cache-marked through OpenRouter; this run says nothing
  about whether `cache_control` on a tool definition is accepted, because the script does
  not set one.
- One run each. Gemini's implicit cache is known to be silent on many calls that hit, so
  "1 of 5" is a lower bound on hits, not a rate.

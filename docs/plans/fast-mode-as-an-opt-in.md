# Fast mode as an opt-in: a second speed on the same model

Status: **planned**

## Context

Anthropic's **fast mode** runs Claude Opus at up to ~2.5× output tokens/sec. It is the same model
with the same weights — not a smaller one — and it is billed at **$10 / $50 per MTok** against
Opus 5's standard **$5 / $25**. It is a research preview, and it is reached through three things
that must all be present on one request:

1. the **beta** endpoint — `client.beta.messages.create`, not `client.messages.create`
2. `betas: ['fast-mode-2026-02-01']`
3. `speed: 'fast'` as a **top-level request parameter** — not a header, not `extra_body`

`response.usage.speed` reports which speed actually served the request.

Four constraints shape everything below:

- **It is model-gated to Claude Opus 5 and Opus 4.8.** Opus 4.7 *had* fast mode and it was
  **removed** — `speed: 'fast'` on 4.7 now errors, so this is not a "newer models also support it"
  predicate that can be written as a `>=`. Of this repo's `TEXT_MODELS`
  (`packages/types/src/textmodels.ts:33`) only `claude-opus-4-8` qualifies today; `claude-opus-5`
  is not in the curated list, and any id works, so both must be recognized.
- **It has its own rate limit,** separate from standard Opus, so a 429 under fast mode says nothing
  about standard capacity.
- **Switching speed invalidates the prompt cache.** Falling back to standard on a 429 therefore
  re-bills the entire prompt at full price — the "cheap" recovery is the expensive one.
- **It is unavailable on the Batch API, Priority Tier, Claude Platform on AWS, Bedrock, Vertex and
  Foundry.** (Priority Tier is moot here regardless: it does not cover Opus 5 at all.)

The repo already has the shape this needs. `effort` is a per-call reasoning knob that travels
`@vn/types` → `@vn/providers` → the session → a command → a menu, with a capability predicate
(`effortChoicesFor`), a step-down rule for a stored choice that outlives the model that offered it
(`resolveEffort`), and a greyed menu that says *why* rather than hiding. Fast mode is the same
journey with a boolean instead of a scale — **and one genuinely new thing: it changes the bill.**

## Decisions this plan settles

- **It is opt-in, off by default, and never inferred.** `DEFAULT_FAST = false`. Nothing about a
  model id, an effort level or a task's apparent urgency turns it on. Doubling a user's rate is
  their decision, and the only gesture that makes it is the author's own.
- **The capability predicate lives in `@vn/types`, beside `effortChoicesFor`, and it is an
  allow-list of two.** `supportsFastMode(modelId)` matches Opus 5 and Opus 4.8 **only** — written
  as an enumeration, not a version comparison, because 4.7 is a hole in the middle of the range.
  That file exists precisely because the `vnauthor` REPL and the desktop renderer both need this
  answer and only one of them may import a package that loads a vendor SDK; the same reason applies
  unchanged.
- **A bound `fast` survives a model switch, and is simply not sent.** This mirrors `setEffort`'s
  existing rule — *"a model that honours none keeps the setting anyway"* — so switching to Sonnet
  and back needs no second gesture. There is no `resolveFast` step-down: a boolean has nowhere to
  step down to, and `false` at the wire is exactly what "unsupported" means. The predicate is what
  a surface greys out on; the backend omits the field.
- **The backend always calls `beta.messages`, and passes `betas` only when fast is on.** The beta
  namespace serves ordinary requests unchanged, so branching the *call path* on a per-turn flag
  would give two request builders that drift — which is the thing
  `createAnthropicChat`'s existing note ("the text path is the usage path with the receipt
  dropped") already refuses to do once.
- **A 429 under fast mode is never silently retried at standard speed.** `isTransient` already
  classifies 429 as retryable, so `callWithRetry` keeps retrying **at fast speed** — correct, since
  the fast limit is its own bucket and backoff is the right answer to it. When the attempts are
  exhausted the error names fast mode, so the author can turn it off deliberately. An automatic
  downgrade would invalidate the cache, re-bill the whole prompt at full price, and change what the
  request cost without saying so.
- **Fast mode is an authoring-surface setting, not a pipeline one.** `createProviders` builds P1/P5
  text and P7 vision from `project.yaml` and does not thread `effort` either; a pipeline run is
  batch-shaped work where latency is not what the author is waiting on. `chatBackendFor` grows the
  parameter (as it did for `effort`) and the pipeline passes nothing.
- **The price is in the tooltip, in both states.** Per the tooltips convention, a disabled control's
  tooltip is its refusal — and here the *enabled* control's tooltip must carry the consequence,
  because "faster" is not the whole truth about a control that doubles the rate.

## What changes

### 1. `@vn/types` — the capability, and the default

`packages/types/src/textmodels.ts`:

```ts
/**
 * Whether a model runs fast mode. An enumeration rather than a version comparison: Opus 4.7 had
 * it and it was removed, so the supported set has a hole in the middle and cannot be a `>=`.
 */
export function supportsFastMode(modelId: string): boolean;

/** Where every surface starts. Fast mode is billed at roughly double, so it is never inferred. */
export const DEFAULT_FAST = false;
```

A one-line `fastLabel`-style helper is **not** wanted — there is no vocabulary to translate, and
`effortLabel` exists only because `none` is a state rather than a level.

Tests in `packages/types/src/tests/textmodels.test.ts`: Opus 5 and Opus 4.8 true; **Opus 4.7
false** (the regression that matters); Sonnet 5, Sonnet 4.6, Haiku, Fable, Gemini false; case
insensitivity, matching `effortChoicesFor`'s own `toLowerCase`.

### 2. `@vn/providers` — the request

`packages/providers/src/backends/anthropic.ts`:

- `createAnthropicChat(apiKey, modelId, opts)` takes `opts.fast?: boolean` alongside `effort`.
- The client accessor is unchanged; both call sites move from `anthropic.messages.create` to
  `anthropic.beta.messages.create`.
- `tuning()` grows the speed fields, gated on the predicate so a `fast` bound against an
  unsupported model is dropped at the wire rather than 400ing:

  ```ts
  const speed = (): Record<string, unknown> =>
    opts.fast && supportsFastMode(modelId)
      ? { speed: 'fast', betas: ['fast-mode-2026-02-01'] }
      : {};
  ```

- `usageOf` records what actually served the request. `TokenUsage` gains `speed?: 'fast' |
  'standard'`, read from `res.usage.speed` — `undefined` when the field is missing, following the
  existing rule that a backend which stopped reporting shows nothing rather than a plausible
  constant. This is the receipt: a turn that was billed at fast rates says so.
- The retry message names the mode when it was on, so an exhausted fast-limit 429 reads as
  *"Claude request failed (claude-opus-5, fast mode): …"* rather than as generic congestion.

`packages/providers/src/factory.ts` — `chatBackendFor(modelId, keys, effort, fast?)`. The doc
comment already explains why `effort` is per-call rather than per-project; `fast` is the same
argument, more so. `createProviders` passes nothing.

Tests in `packages/providers/src/tests/providers.test.ts`, against a stubbed SDK module: fast on a
supported model sends `speed` **and** the beta flag together; fast on Opus 4.7 sends neither; fast
off sends neither; `usage.speed` round-trips into `TokenUsage`; a 429 with fast on retries at fast
speed and never mutates the request.

### 3. The desktop session

`apps/desktop/src/main/session.ts`:

- `fast = DEFAULT_FAST` beside `effort`, with the same "a stated default, never the vendor's"
  framing.
- `buildBackend` passes it to `chatBackendFor`.
- `setFast(fast: boolean): Promise<boolean>` rebuilds the backend exactly as `setEffort` does,
  preserving conversation state; mock returns early.
- `setModel` leaves `fast` alone (see Decisions) — no `resolveFast` call, and a comment saying so,
  because the neighbouring line calls `resolveEffort` and the asymmetry will otherwise read as an
  omission.
- `analysisBinding` / `adviseRun`: a difficult-agent report borrows a model and an effort for one
  analysis. It does **not** borrow fast mode — an analysis is not something the author is watching
  a cursor for, and `ReportAsk` gains no field.

### 4. The command

`apps/desktop/src/main/commands/agent.ts`:

```ts
export const agentSetFast = define({
  id: 'agent.setFast',
  title: 'Set fast mode',
  description:
    'Run the same model at up to 2.5× output speed, billed at roughly double the standard rate.',
  mutating: false,
  props: { fast: prop.bool('whether to run fast mode') },
  ...
});
```

Every value is accepted regardless of the bound model — the same rule `agent.setEffort` states in
its own comment: the menu is what filters, and an unsupported setting is dropped at the wire, not
refused. The message says which model it applies to when it is on and inert
(*"Fast mode is on; claude-sonnet-5 does not run it."*), because a silently-kept-but-unused setting
that says nothing is indistinguishable from a bug.

Registered in `apps/desktop/src/main/commands/index.ts`; the catalog picks it up from there.

### 5. The renderer

- `apps/desktop/renderer/pathux/state.ts`: `fast = DEFAULT_FAST`, mirroring the session the way
  `effort` does.
- `apps/desktop/renderer/pathux/api.ts`: `ui.bool('fast', 'fast', 'Fast Mode')`.
- `apps/desktop/renderer/pathux/bridge.ts`: `setFast()` beside `setEffort`, writing `shell().ui.fast`
  on success. `setModel` does **not** touch it.
- `apps/desktop/renderer/pathux/editors/convo.ts`: the convo bar's `stateKey()` grows `|${ui.fast}`
  so the bar rebuilds, and a **check-style menu entry or toggle button** sits next to the effort
  menu:
  - enabled tooltip: *"Run the same model at up to 2.5× speed. Billed at roughly double the standard
    rate."*
  - disabled tooltip (the refusal, verbatim in the greyed state):
    *"claude-sonnet-5 does not run fast mode — only Claude Opus 5 and Opus 4.8 do."*
  - when on, the label says so plainly (`fast: on`), because a doubled rate should be legible from
    the bar without hovering.

### 6. `vnauthor`

- `apps/authoring/src/agent.ts`: `buildAgentBackend` opts grow `fast?: boolean`, threaded into
  `chatBackendFor`.
- `apps/authoring/src/repl.ts`: `/fast [on|off]` beside `/effort`, listed in the help text, going
  through the same `applySettings(model, effort, fast)` hot-swap. With no argument it reports the
  current state. Under `--mock` it prints the same yellow note `/effort` does. On a model that does
  not run it, the note names the two that do.

## Testing

- **`@vn/types`** — the predicate, with Opus 4.7 as the named regression.
- **`@vn/providers`** — the request shape against a stubbed SDK, per §2.
- **Desktop main** — `setFast` rebuilds the backend; `setModel` does not clear it; the command
  round-trips through the registry and its message names the inert case.
- **`vnauthor` REPL** — `apps/authoring/src/tests/repl.test.ts` covers `/fast` parsing, the no-arg
  report and the mock note, following the existing `/effort` cases.
- **Renderer** — the convo bar is a surface, so it is verified live over CDP per the desktop
  convention (`node scripts/vn-cdp.mjs`), not in the node-only jest project: the toggle greys on a
  Sonnet binding and its tooltip is the refusal.

## Risks

- **Research preview.** The beta flag `fast-mode-2026-02-01` may be superseded or withdrawn. It is
  a single string in one file; a withdrawal makes fast requests 400, which `isTransient` correctly
  classifies as terminal and reports by name rather than retrying three times.
- **Moving both call sites to `beta.messages`** is the one change that touches the non-fast path.
  It is deliberate (one request builder), and the provider tests cover the fast-off shape to prove
  nothing else moved.
- **The 429 decision will look wrong from inside a stall** — an author waiting on a retried fast
  request may want the standard fallback we are declining to make automatic. The answer is the
  toggle: turning fast off is one gesture, and it is the gesture that knows what it costs.

## Follow-ups deliberately not in scope

- **Fast mode for pipeline text/vision calls.** Batch-shaped work, and `createProviders` threads no
  per-call knobs today.
- **A `project.yaml` default.** Fast mode is a per-conversation choice about latency the author is
  personally waiting on; a committed file that doubles every collaborator's bill is the wrong home
  for it.
- **Spend surfacing.** `Convo.tokens` already sums usage; making the convo bar price a fast turn
  differently is a real improvement and a separate plan, and `TokenUsage.speed` is the field it
  would need.

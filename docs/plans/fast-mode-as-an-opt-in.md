# Fast mode as an opt-in: a second speed on the same model

Status: **planned**

## Context

Anthropic's fast mode runs Claude Opus at up to ~2.5× output tokens/sec. It runs the same
model with the same weights rather than a smaller one, and it is billed at $10 / $50 per
MTok against Opus 5's standard $5 / $25. It is a research preview, and a request reaches
it only when three things are all present on that request:

1.  1. The beta endpoint is `client.beta.messages.create`, not `client.messages.create`.
2.  `betas: ['fast-mode-2026-02-01']`
3.  3. Pass `speed: 'fast'` as a top-level request parameter, not as a header and not in
       `extra_body`.

`response.usage.speed` reports the speed the request was served at.

Four constraints shape everything below:

- **It is model-gated to Claude Opus 5 and Opus 4.8.** Opus 4.7 had fast mode and it was
  removed — `speed: 'fast'` on 4.7 now errors, so the gate cannot be written as a `>=`
  version comparison over "newer models also support it". Of this repo's `TEXT_MODELS`
  (packages/types/src/textmodels.ts:33) only `claude-opus-4-8` qualifies today;
  `claude-opus-5` is not in the curated list, and any id works, so both must be
  recognized.
- **Fast mode has its own rate limit,** separate from standard Opus, so a 429 under fast
  mode says nothing about standard capacity.
- **Switching speed invalidates the prompt cache.** Falling back to standard on a 429
  therefore re-bills the entire prompt at full price, so the recovery that looks cheapest
  costs the most.
- It is unavailable on the Batch API, Priority Tier, Claude Platform on AWS, Bedrock,
  Vertex and Foundry. (Priority Tier is moot here regardless, because it does not cover
  Opus 5 at all.)

The repo already has the pieces this needs. `effort` is a per-call reasoning knob that
passes through `@vn/types` → `@vn/providers` → the session → a command → a menu, with a
capability predicate (`effortChoicesFor`), a step-down rule (`resolveEffort`) for a stored
choice that outlives the model that offered it, and a greyed menu entry that gives the
reason instead of hiding the option. Fast mode takes the same path with a boolean instead
of a scale. It differs in one respect: it changes the bill.

## Decisions this plan settles

- **It is opt-in, off by default, and never inferred.** `DEFAULT_FAST = false`. Nothing
  about a model id, an effort level or a task's apparent urgency turns it on. Doubling a
  user's rate is their decision, and only the author makes it.
- **The capability predicate lives in `@vn/types`, beside `effortChoicesFor`.** It allows
  two models: `supportsFastMode(modelId)` matches Opus 5 and Opus 4.8. It is written as an
  enumeration rather than a version comparison, because 4.7 sits inside that range and is
  not matched. The file exists because the `vnauthor` REPL and the desktop renderer both
  need this answer, and only one of them may import a package that loads a vendor SDK.
  That reason still applies.
- **A bound `fast` survives a model switch and is not sent.** This mirrors `setEffort`'s
  existing rule — "a model that honours none keeps the setting anyway" — so switching to
  Sonnet and back needs no second gesture. There is no `resolveFast` step-down, because a
  boolean has nowhere to step down to and `false` at the wire is what "unsupported" means.
  A surface greys out on the predicate; the backend omits the field.
- **The backend always calls `beta.messages`, and passes `betas` only when fast is on.**
  The beta namespace serves ordinary requests unchanged. Branching the call path on a
  per-turn flag would give two request builders that drift apart, and
  `createAnthropicChat`'s existing note ("the text path is the usage path with the receipt
  dropped") already rejects that duplication.
- **A 429 under fast mode is retried at fast speed, not at standard speed.** `isTransient`
  already classifies 429 as retryable, so `callWithRetry` keeps retrying at fast speed.
  That is correct, because the fast limit is its own bucket and backoff is the right
  answer to it. When the attempts are exhausted the error names fast mode, so the author
  can turn it off deliberately. An automatic downgrade would invalidate the cache, re-bill
  the whole prompt at full price, and change the request's cost without reporting it.
- **Fast mode is an authoring-surface setting, not a pipeline one.** `createProviders`
  builds P1/P5 text and P7 vision from `project.yaml` and does not thread `effort` either;
  a pipeline run is batch work, and the author does not wait on its latency.
  `chatBackendFor` takes the parameter (as it did for `effort`) and the pipeline passes
  nothing.
- **The price is in the tooltip, in both states.** Per the tooltips convention, a disabled
  control's tooltip states why it refuses. The enabled control's tooltip must state the
  consequence, because "faster" is not the whole truth about a control that doubles the
  rate.

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

Do not add a one-line `fastLabel`-style helper. There is no vocabulary to translate, and
`effortLabel` exists only because `none` is a state rather than a level.

`packages/types/src/tests/textmodels.test.ts` checks that Opus 5 and Opus 4.8 are true and
that Opus 4.7 is false, which is the regression that matters. It checks that Sonnet 5,
Sonnet 4.6, Haiku, Fable and Gemini are false. It also checks case insensitivity, matching
`effortChoicesFor`'s own `toLowerCase`.

### 2. `@vn/providers` — the request

`packages/providers/src/backends/anthropic.ts`:

- `createAnthropicChat(apiKey, modelId, opts)` takes `opts.fast?: boolean` alongside
  `effort`.
- The client accessor is unchanged; both call sites move from `anthropic.messages.create`
  to `anthropic.beta.messages.create`.
- `tuning()` adds the speed fields. The predicate gates them, so a `fast` bound against a
  model that does not support it is dropped before the request is sent rather than
  returning a 400:

    ```ts
    const speed = (): Record<string, unknown> =>
        opts.fast && supportsFastMode(modelId)
            ? { speed: "fast", betas: ["fast-mode-2026-02-01"] }
            : {};
    ```

- `usageOf` records what actually served the request. `TokenUsage` gains
  `speed?: 'fast' | 'standard'`, read from `res.usage.speed`. The field is `undefined`
  when `res.usage.speed` is missing, following the existing rule that a backend which
  stopped reporting shows nothing rather than a plausible constant. A turn that was billed
  at fast rates reports `'fast'`.
- The retry message names the mode when fast mode was on, so an exhausted fast-limit 429
  reads as "Claude request failed (claude-opus-5, fast mode): …" rather than as generic
  congestion.

packages/providers/src/factory.ts defines `chatBackendFor(modelId, keys, effort, fast?)`.
The doc comment already explains why `effort` is per-call rather than per-project, and the
same reasoning covers `fast`. `createProviders` passes nothing.

`packages/providers/src/tests/providers.test.ts` covers this against a stubbed SDK module.
Fast on a supported model sends `speed` and the beta flag together. Fast on Opus 4.7 sends
neither. Fast off sends neither. `usage.speed` round-trips into `TokenUsage`. A 429 with
fast on retries at fast speed and never mutates the request.

### 3. The desktop session

`apps/desktop/src/main/session.ts`:

- `fast = DEFAULT_FAST` sits beside `effort`, and both follow the same rule. Each states
  its default here rather than taking the vendor's.
- `buildBackend` passes it to `chatBackendFor`.
- `setFast(fast: boolean): Promise<boolean>` rebuilds the backend exactly as `setEffort`
  does, preserving conversation state. The mock returns early.
- `setModel` does not change `fast` (see Decisions). It makes no `resolveFast` call and
  carries a comment saying so, because the neighbouring line calls `resolveEffort` and the
  asymmetry would otherwise read as an omission.
- `analysisBinding` / `adviseRun` give a difficult-agent report a model and an effort for
  one analysis. They do not give it fast mode, because no author watches a cursor during
  an analysis, and `ReportAsk` gains no field.

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

Every value is accepted regardless of the bound model. The comment on `agent.setEffort`
states the same rule. The menu does the filtering, and an unsupported setting is dropped
at the wire rather than refused. When a setting is on but inert, the message names the
model it applies to ("Fast mode is on; claude-sonnet-5 does not run it."), because a
setting that is kept silently, never used, and never mentioned is indistinguishable from a
bug.

The command is registered in `apps/desktop/src/main/commands/index.ts`, and the catalog
reads it from there.

### 5. The renderer

- `apps/desktop/renderer/pathux/state.ts`: sets `fast = DEFAULT_FAST`. `fast` mirrors the
  session, and `effort` mirrors it the same way.
- `apps/desktop/renderer/pathux/api.ts`: `ui.bool('fast', 'fast', 'Fast Mode')`.
- `apps/desktop/renderer/pathux/bridge.ts` defines `setFast()` beside `setEffort`, and
  `setFast()` writes `shell().ui.fast` on success. `setModel` does not touch
  `shell().ui.fast`.
- `apps/desktop/renderer/pathux/editors/convo.ts`: `stateKey()` appends `|${ui.fast}` so
  the convo bar rebuilds, and a check-style menu entry or toggle button sits next to the
  effort menu:
    - enabled tooltip: "Run the same model at up to 2.5× speed. Billed at roughly double
      the standard rate."
    - disabled tooltip (shown verbatim in the greyed state): "claude-sonnet-5 does not run
      fast mode — only Claude Opus 5 and Opus 4.8 do."
    - when on, the label reads `fast: on`, so that a doubled rate is legible from the bar
      without hovering.

### 6. `vnauthor`

- `apps/authoring/src/agent.ts`: adds a `fast?: boolean` option to `buildAgentBackend` and
  passes it to `chatBackendFor`.
- `apps/authoring/src/repl.ts`: adds `/fast [on|off]` alongside `/effort`, lists it in the
  help text, and routes it through the same `applySettings(model, effort, fast)` hot-swap.
  With no argument it reports the current state. Under `--mock` it prints the same yellow
  note that `/effort` prints. On a model that does not run fast mode, the note names the
  two models that do.

## Testing

- **`@vn/types`** — defines the predicate and names Opus 4.7 as the regression.
- **`@vn/providers`** — Defines the request shape against a stubbed SDK, per §2.
- **Desktop main** — `setFast` rebuilds the backend. `setModel` does not clear the
  backend. The command round-trips through the registry, and the command's message names
  the inert case.
- **`vnauthor` REPL** — `apps/authoring/src/tests/repl.test.ts` covers `/fast` parsing,
  the no-arg report and the mock note, following the existing `/effort` cases.
- **Renderer** — the convo bar is a surface, so it is verified live over CDP per the
  desktop convention (`node scripts/vn-cdp.mjs`) rather than in the node-only jest
  project. The toggle greys out on a Sonnet binding, and its tooltip states the refusal.

## Risks

- **Research preview.** The beta flag `fast-mode-2026-02-01` may be superseded or
  withdrawn. The flag is a single string in one file. A withdrawal makes fast requests
  fail with a 400, and `isTransient` correctly classifies a 400 as terminal, so the
  failure is reported by name rather than retried three times.
- **Moving both call sites to `beta.messages`** is the one change that touches the
  non-fast path. The move is deliberate and leaves a single request builder, and the
  provider tests cover the fast-off shape to confirm nothing else changed.
- **The 429 decision will look wrong from inside a stall** — an author waiting on a
  retried fast request may want the standard fallback we are declining to make automatic.
  The toggle covers this case: turning fast off takes one gesture, and an author who turns
  it off has accepted the cost.

## Follow-ups deliberately not in scope

- **Fast mode for pipeline text/vision calls.** The work is batch-shaped, and
  `createProviders` threads no per-call knobs today.
- **A `project.yaml` default.** An author picks fast mode per conversation, based on the
  latency they are personally waiting on. A committed default doubles every collaborator's
  bill, so `project.yaml` does not carry one.
- **Spend surfacing.** `Convo.tokens` already sums usage. Making the convo bar price a
  fast turn differently would be a real improvement, but it belongs in a separate plan,
  and `TokenUsage.speed` is the field that change would need.

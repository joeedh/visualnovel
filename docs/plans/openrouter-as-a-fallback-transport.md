# OpenRouter as a fallback transport

**Status: partial.** Written 2026-09-19; pressure-tested the same day, findings at the
end. Stages 1–6 shipped 2026-09-19; stage 7, the live check, is still owed. See
[As shipped](#as-shipped).

An author with only an OpenRouter key gets nothing today except image generation through a
`<vendor>/<model>` id: every chat call reads the Anthropic or Gemini key its model id
names, and refuses when that key is absent. This plan separates the model a call names
from the key that carries it. A model keeps its **native vendor** (`chatVendorFor`,
`imageVendorOf`), and gains a **transport**: the native vendor when its key resolves,
otherwise OpenRouter when that key resolves and OpenRouter serves the model, otherwise a
refusal that names both keys. Nothing above the provider seam changes what it asks for, no
task hash moves, and a manifest never learns which key drew a picture except through one
optional field.

<!-- toc -->

- [What an author sees](#what-an-author-sees)
- [Where the key is read today](#where-the-key-is-read-today)
- [Decision 1: a route, computed in one place](#decision-1-a-route-computed-in-one-place)
- [Decision 2: the OpenRouter id for a native id is a rule, not a table](#decision-2-the-openrouter-id-for-a-native-id-is-a-rule-not-a-table)
- [Decision 3: one OpenRouter chat backend over Chat Completions](#decision-3-one-openrouter-chat-backend-over-chat-completions)
- [Decision 4: caching, reasoning and usage through OpenRouter](#decision-4-caching-reasoning-and-usage-through-openrouter)
- [Decision 5: the image seam routes below the hash](#decision-5-the-image-seam-routes-below-the-hash)
- [Decision 6: a thread keeps its transport](#decision-6-a-thread-keeps-its-transport)
- [Decision 7: what the refusal, the Setup pane and the docs say](#decision-7-what-the-refusal-the-setup-pane-and-the-docs-say)
- [Decision 8: what this deliberately does not do](#decision-8-what-this-deliberately-does-not-do)
- [Relationship to the four-vendors plan](#relationship-to-the-four-vendors-plan)
- [Staging](#staging)
- [What cannot be tested without a key](#what-cannot-be-tested-without-a-key)
- [Verified and unverified facts](#verified-and-unverified-facts)
- [Review findings](#review-findings)
- [As shipped](#as-shipped)

<!-- tocstop -->

## What an author sees

- A project with the default `project.yaml` (`claude-opus-4-8` text, `gemini-2.5-flash` +
  `claude-opus-4-8` vision, `gemini-2.5-flash-image` image) runs end to end — the pipeline
  including `vngen decompose`, vnauthor, the desktop agent, the difficult-agent report,
  the gate triage — on an OpenRouter key alone. Plugin gen-graph nodes are the exception;
  see Decision 8.
- Adding an Anthropic key later moves every Claude call back onto Anthropic's own API
  without touching `project.yaml`. The Gemini calls stay on OpenRouter until a Gemini key
  appears. Preference is per call and per vendor, never per project. An open conversation
  is the one thing that does not move: it keeps the transport it started on (Decision 6).
- With no key for a model's vendor and no OpenRouter key, the refusal names both ways out:
  `missing anthropic API key for claude-opus-4-8: set $ANTHROPIC_API_KEY or place claude.txt in a keys/ dir, or set $OPENROUTER_API_KEY to route it through OpenRouter`.
- The Setup pane says, per vendor, which of its models would go through OpenRouter right
  now, and the startup "No API key for gemini or anthropic" notice is posted only when a
  configured model has no route at all.

## Where the key is read today

Each entry is a site the plan changes; the stages below are checked against this list.

- `chatBackendFor(modelId, keys, …)` in `packages/providers/src/factory.ts` — a two-branch
  ternary on `chatVendorFor`, reading `keys.anthropic` or `keys.gemini`. A private copy
  lives in `apps/authoring/src/agent.ts` (`chatBackendFor`, lines 66–73), and
  `scripts/audit-key-instructions.mjs:131,139` calls `chatVendorFor` / `chatBackendFor`
  directly after checking `keys[need]` by hand.
- `requiredVendors(config)` in the same file, passed as `resolveKeys`'s `require` from
  `apps/cli/src/project.ts` (`buildProviders`, whose `require` option is typed
  `(keyof ResolvedKeys)[]`), `apps/desktop/src/main/session/core.ts` (`buildProviders`),
  `apps/desktop/src/main/session/gengraph.ts`, and `packages/authoring/src/art.ts`. Its
  tests are `packages/providers/src/tests/factory.test.ts:127-146`.
- `require: [chatVendorFor(modelId)]` at six sites: `apps/authoring/src/agent.ts:95`,
  `apps/desktop/src/main/session/core.ts:1101` (`chooseBackend`), `session/gate.ts:244`
  (`TRIAGE_MODEL`), `session/report.ts:171`, `packages/authoring/src/art.ts:138` and
  `:212`.
- Hard-coded `require: ['anthropic']` at two sites that mean "the text model":
  `apps/cli/src/commands.ts:432` (`vngen decompose`) and
  `apps/desktop/src/main/session/gengraph.ts:508-511` (`decomposePreconditions`).
  `packages/testkit/src/record.ts:171` requires `imageVendorOf(config.models.image)`.
- `analystBackend` in `packages/agentreport/src/analyze.ts` and `report.ts` in the desktop
  session each test `keys[vendor]?.trim()` by hand before building a backend.
- `createImageBackend`'s `backendFor` reads `keys[imageVendorOf(modelId)]` and throws
  `missingKeyError` — the only site that already knows OpenRouter as a key.
  `ImageBackendBuilder` takes `(vendor, apiKey, modelId)`.
- Key presence read outside `require`: `session/project.ts:175-182` (`previewImageModel`
  refuses a Gemini image id when no Gemini key resolves),
  `apps/desktop/src/main/runtime/workspacelifecycle.ts:267-289` (`noticeMissingKeys` warns
  for every unresolved vendor), and the status-row tooltip in
  `apps/desktop/renderer/pathux/editors/onboarding.ts:187-189`.
- `recordMessage` in `session/core.ts` writes `vendor: chatVendorFor(this.model)` into a
  thread's native-log header; the header type is `ResumeHeader` in
  `apps/desktop/src/shared/convo.ts:145-162`; `resumeHeaderOf` in
  `apps/desktop/src/main/notify/threads.ts:470-482` whitelists the fields it reads back;
  `resumeRefusal` in `apps/desktop/src/shared/threads.ts` refuses a resume when
  `header.vendor !== chatVendorFor(bound.model)`.
- `scripts/verify-prompt-cache.mjs` branches on the id prefix straight to
  `createAnthropicChat` / `createGeminiChat`.

## Decision 1: a route, computed in one place

A route is what a call actually does with a model id:

```ts
// packages/types/src/textmodels.ts
export type Transport = "anthropic" | "gemini" | "openrouter";

export interface Route {
    /** The id as the author spelled it; what every table above the seam is keyed by. */
    modelId: string;
    /** The vendor the id names, or `undefined` for an OpenRouter id under a prefix this file does not know. */
    native: ChatVendor | ImageVendor | undefined;
    /** The key and endpoint that carry the call. */
    transport: Transport;
    /** The id sent on the wire: the native id, or its OpenRouter spelling. */
    wireId: string;
}

/** Which keys resolve. Booleans only, so the renderer can call this over `keyStatus`. */
export type KeysPresent = Readonly<Record<Transport, boolean>>;

export function chatRouteFor(modelId: string, present: KeysPresent): Route | undefined;
export function imageRouteFor(modelId: string, present: KeysPresent): Route | undefined;
```

- The rule lives in `@vn/types` beside `chatVendorFor`, for the reason that file already
  states: the renderer needs the same answer and cannot import a package that loads a
  vendor SDK. `Transport` stays there rather than in `@vn/config`, because
  `apps/desktop/src/shared/threads.ts` imports `@vn/types` at runtime for the renderer and
  `@vn/config` would pull `node:fs` into the bundle.
- **An id with a slash is an OpenRouter id, for chat as it already is for images.**
  `chatVendorFor` has no slash rule today (`anthropic/claude-opus-4.8` starts with
  `anthropic` and would be sent to Anthropic's API as is), so `chatRouteFor` adds one:
  slash ⇒ `transport: 'openrouter'`, `wireId: modelId`, and `native` from the prefix
  (`anthropic/` → `anthropic`, `google/` → `gemini`, anything else → `undefined`). The
  author chose the transport by spelling it; there is no "prefer native" for that id.
- Otherwise: `present[chatVendorFor(id)]` ⇒ native, `wireId: id`; else
  `present.openrouter` ⇒ `transport: 'openrouter'`, `wireId: openRouterIdFor(id)`; else
  `undefined`.
- **Every model-level table is keyed by the native spelling.** `effortChoicesFor`,
  `supportsSystemRole`, `resolveEffort` and `advice.ts` test `/opus-4-[7-9]/` and would
  miss `opus-4.8`. So `nativeIdFor(wireId)` (Decision 2) is the inverse of
  `openRouterIdFor`, and every such call in the app and in the backend goes through
  `nativeIdFor` first. For an id under a prefix the rule does not know, `nativeIdFor`
  returns the id unchanged and the tables answer as they do for any unknown id: no effort
  menu, no system role. That loss is accepted; the four-vendors plan's vendor table is
  where those ids get rows.
- `present` is booleans rather than `ResolvedKeys` so the function never sees a key value
  and the renderer can compute it from the `keyStatus` it already receives.
- `@vn/config` gains `keysPresent(keys: ResolvedKeys): KeysPresent` and
  `missingRouteError(config, modelId, native)`, which is `missingKeyError`'s sentence plus
  the OpenRouter clause when `openRouterIdFor` can spell the id. `missingKeyError` stays
  for the one caller that means a specific key (`testKey`, whose `require: [vendor]` is
  the one `require` that survives).
- `@vn/providers` gains `resolveRoutes(config, keys, modelIds): Map<string, Route>` —
  every id routed, or one `ConfigError` from `missingRouteError` naming the first that is
  not. `requiredVendors` is deleted with its tests; every caller listed above calls
  `resolveKeys` with no `require`, then `resolveRoutes` over the ids it is about to use.
  `buildProviders`'s `require` option in `apps/cli/src/project.ts` becomes
  `models?: string[]` (extra ids to route beyond the config's), so `vngen decompose` and
  `decomposePreconditions` route `config.models.text` instead of requiring `anthropic`.
- **`chatBackendFor` takes a `Route`.** Its signature becomes
  `chatBackendFor(route, keys, effort?, opts?)`: `anthropic` →
  `createAnthropicChat( keys.anthropic, route.wireId, …)`, `gemini` →
  `createGeminiChat(keys.gemini, route.wireId, …)`, `openrouter` →
  `createOpenRouterChat(keys.openrouter, route, {effort, record})`. A caller has a `Route`
  because it just called `resolveRoutes`; there is no path that builds a backend on an
  empty key any more, which is what `factory.ts:47-51` documents preventing. The eight
  callers (six `chatVendorFor` sites, `analystBackend`, the audit script) change in the
  same stage. The `label` stays the native vendor's (`claude` / `gemini`) because reviewer
  labels are compared in the manifest and a picture reviewed by Claude through OpenRouter
  was still reviewed by Claude. `ChatBackend.modelId` is the native id for the same
  reason; the wire id is the backend's private business. The private copy in
  `apps/authoring/src/agent.ts` is deleted.

## Decision 2: the OpenRouter id for a native id is a rule, not a table

Verified against `GET https://openrouter.ai/api/v1/models` on 2026-09-19:

| Native id                | OpenRouter id                   |
| ------------------------ | ------------------------------- |
| `claude-opus-4-8`        | `anthropic/claude-opus-4.8`     |
| `claude-sonnet-4-6`      | `anthropic/claude-sonnet-4.6`   |
| `claude-haiku-4-5`       | `anthropic/claude-haiku-4.5`    |
| `claude-fable-5`         | `anthropic/claude-fable-5`      |
| `claude-opus-5`          | `anthropic/claude-opus-5`       |
| `gemini-2.5-flash`       | `google/gemini-2.5-flash`       |
| `gemini-2.5-pro`         | `google/gemini-2.5-pro`         |
| `gemini-2.5-flash-image` | `google/gemini-2.5-flash-image` |

- `openRouterIdFor(modelId)`: an id with a slash is returned as is; `models/<id>` has the
  prefix stripped first; an Anthropic id becomes `anthropic/` + the id with its trailing
  `-<major>-<minor>` rewritten to `-<major>.<minor>`; a Gemini id becomes `google/` + the
  id. A dated Anthropic id (`claude-opus-4-8-20260101`) is not rewritten; OpenRouter's
  `canonical_slug` carries dates in a form this rule does not produce, and the refusal
  OpenRouter returns for an unknown id names the wire id, which is enough to act on.
- `nativeIdFor(wireId)` is the inverse: `anthropic/claude-opus-4.8` → `claude-opus-4-8`,
  `google/gemini-2.5-flash` → `gemini-2.5-flash`, anything else unchanged. A table test
  asserts the two are inverses over every `TEXT_MODELS` entry and the default
  `models.image`. The rule is the source of truth; the listing is what the test was
  checked against, not something the app reads at call time.
- The catalog `models.refresh` writes (`models.json`, from the image listing) is not
  widened to chat models. The image half already resolves through the catalog for `seed`
  and price; chat needs neither to route.

## Decision 3: one OpenRouter chat backend over Chat Completions

`packages/providers/src/backends/openrouter-chat.ts`,
`createOpenRouterChat(apiKey, route, { effort, record, fetchImpl })`, a `ChatBackend`
implementing all four methods (`message`, `messageWithUsage`, `chatWithTools`,
`chatConversation`). Plain `fetch` against
`https://openrouter.ai/api/v1/chat/completions`, as the image backend does; no new npm
dependency, so `EXTERNAL` in `scripts/aliases.mjs` and the desktop bundle are untouched.

- **Request shape.** OpenAI Chat Completions: `messages[]` with `role` in
  `system | user | assistant | tool`; a user turn's content is an array of `{type:'text'}`
  and `{type:'image_url', image_url:{url:'data:…'}}` parts; tools are
  `{type:'function', function:{name, description, parameters}}`; a reply's calls are
  `tool_calls[{id, function:{name, arguments}}]` with `arguments` a JSON **string**,
  parsed by the backend into `ToolCall.args` (a parse failure is a `ProviderError` naming
  the tool); a result goes back as `{role:'tool', tool_call_id, content}`.
- **Translating what `@vn/authoring` sends.** `turnOf` in
  `packages/authoring/src/backend.ts` builds a user turn whose content is Anthropic
  `tool_result` blocks, and replays an assistant turn as the `raw` blocks the previous
  reply returned; `loop.ts:792,824,964` also append assistant turns whose content is a
  plain string. The OpenRouter backend therefore reads three shapes: a string (user or
  assistant, sent as a text message), a user array holding
  `{type:'tool_result', tool_use_id, content}` blocks (each becomes one `{role:'tool'}`
  message), and an assistant array that is this backend's own `raw` (one Chat Completions
  assistant message, sent back verbatim). Any other block shape — an Anthropic `thinking`
  or `tool_use` block from a thread recorded natively — is a `ProviderError` naming the
  block type. Decision 6 pins a thread to its transport so this cannot fire on an author;
  a fault here means that pin was bypassed.
- **`raw` is the assistant message.** `ChatConvoReply.raw` is `[message]` — the whole
  `choices[0].message`, including `tool_calls` and `reasoning_details`. OpenRouter states
  that `reasoning_details` must be passed back unmodified in the assistant message for the
  model to continue reasoning across a tool call, so the backend echoes the message rather
  than rebuilding it from `text` + `toolCalls`, the same rule `raw`'s doc comment states
  for Anthropic.
- **System turns mid-array are re-rolled to `user` by the backend.** `supportsSystemRole`
  is a model predicate and stays one; `@vn/authoring` keeps emitting a `{role:'system'}`
  turn for Opus 4.8 / Opus 5 / Fable 5. The OpenRouter backend sends it with
  `role: 'user'` and the content unchanged — exactly what `messagesOf` in
  `convo-request.ts:79` does for a model without the role (it swaps the role; it adds no
  prefix — the `SYSTEM (out-of-band)` label belongs to the structured path's
  `renderTranscript`). Whether OpenRouter passes a mid-array system message to Anthropic
  as a system-role message or folds it into the top-level system prompt is UNVERIFIED, and
  folding would edit the cached prefix on every turn. This is the one place the transport
  changes what the model reads, and it is the already-tested rendering.
- **`ToolSchema.defer` is ignored.** OpenRouter has no `defer_loading` and no server-side
  tool search, so `SEARCH_TOOL` is not sent and the whole catalog goes in every request.
  The cost is the one the four-vendors plan names: a larger prefix and a harder selection
  problem at ~40 tools. It is cached (Decision 4), so it is paid at the cache-write rate
  once per conversation and at the read rate after that.
- **`chatConversation` is implemented**, so the host's `chatConversation` probe puts an
  OpenRouter-routed model on the native agent path. This is what makes caching apply.
- **Errors and retries.** `OpenRouterError`, `ERROR_CHARS`, `FetchImpl` and the data-URL
  `reference()` helper move out of `openrouter.ts` into a shared `openrouter-common.ts`
  used by both backends; the private `retryableStatus` there is replaced by the one
  `transient.ts:24` already exports. `callWithRetry` and `retryAfterMs` already live in
  `transient.ts` and are imported as today. Messages are prefixed
  `OpenRouter (<native>) request failed (<wireId>)` so an author with two keys can tell
  which transport failed. Every request sends `provider: { data_collection: 'deny' }`, as
  the image backend does.
- **`captureRequest('openrouter-chat', …)`** records the body without image bytes, so the
  difficult-agent analyst can read these requests as it reads Anthropic's.
- **Tests.** A fake `fetchImpl` asserts the exact request body for: a plain message, a
  message with an image, a `chatWithTools` turn, a three-turn `chatConversation` with a
  tool result and a string assistant turn, a mid-array system turn, and each effort
  choice. Response parsing is tested for text-only, tool calls, a non-JSON `arguments`,
  missing `usage`, and a 429 with `retry-after`.

## Decision 4: caching, reasoning and usage through OpenRouter

- **Cache breakpoints pass through.** OpenRouter forwards
  `cache_control: {type:'ephemeral'}` (optionally `ttl:'1h'`) placed on content parts to
  Anthropic, with the same four-breakpoint ceiling, and honours the last such breakpoint
  for Gemini 2.5+ (implicit caching still applies without one). The backend therefore maps
  `ChatTurn.cache` to `cache_control` on the last text part of that turn, marks the system
  message's text part, and marks the last tool's `function` object only if OpenRouter
  accepts `cache_control` on a tool definition — UNVERIFIED; if not, the tools block is
  cached only as part of the prefix Anthropic itself caches ahead of the first message
  breakpoint. The `buildConvoRequest` discipline (`MESSAGE_BREAKPOINTS = 2`, `markLast`,
  byte-stable prefix, append-only) is reused as logic, not as code: that builder emits
  Anthropic SDK shapes, so the OpenRouter backend has its own builder with the same tests
  transposed.
- **Usage.** `usage.prompt_tokens_details.cached_tokens` → `cacheRead`;
  `usage.prompt_tokens_details.cache_write_tokens` → `cacheWrite`. `prompt_tokens` is
  `input` as is, on the assumption that it already includes both the cached and the
  written tokens (the OpenAI convention for `cached_tokens`; UNVERIFIED for
  `cache_write_tokens`, and the live check compares `prompt_tokens` against the sum of the
  details on a turn that wrote). If it does not include the write, the backend adds it, so
  `TokenUsage`'s "carved out of `input`" contract holds either way. `completion_tokens` is
  `output`; reasoning tokens are already inside it. A missing `usage` returns `undefined`.
  `cacheReporting` is `'billed'` for an Anthropic native and `'estimated'` for Gemini, and
  `cacheTtlMs` is `CACHE_TTL_MS` for Anthropic and absent for Gemini, so the cache-miss
  recorder judges an OpenRouter-carried Claude against Claude's own window.
- **Reasoning.** `resolveEffort(nativeIdFor(wireId), choice)` decides what is sent, so the
  menu offers what the model honours and the stored word keeps its meaning. The backend
  sends `reasoning: { effort }` for a level and `reasoning: { enabled: false }` for
  `none`; OpenRouter's accepted set (`max | xhigh | high | medium | low | minimal | none`)
  is a superset of `EFFORT_CHOICES`, so no mapping is needed. What OpenRouter does with
  that effort on Anthropic is documented as a `budget_tokens` formula, and the Anthropic
  backend's own comment records that `budget_tokens` 400s on current Claude models in
  favour of `output_config.effort`. Whether OpenRouter has since moved to the adaptive
  form is UNVERIFIED and is the first thing the live check tries. If a request carrying an
  effort is refused with a 400 that names `reasoning`, the backend resends it once with
  `reasoning: { enabled: true }` and no effort, remembers that for the life of the backend
  instance so later turns do not pay the round trip, and records both requests through
  `captureRequest` so the analyst can see the downgrade; a 400 is not billed, so the retry
  costs nothing.
- **`max_tokens`.** OpenRouter requires `max_tokens` strictly above the reasoning budget
  it derives. `MAX_TOKENS_THINKING` (16,000) is sent whenever an effort is on,
  `MAX_TOKENS` otherwise, mirroring `anthropic.ts`.

## Decision 5: the image seam routes below the hash

- `createImageBackend`'s `backendFor(modelId)` calls
  `imageRouteFor(modelId, keysPresent(keys))` and builds from the route. The
  `ImageBackendBuilder` signature becomes `(route: Route, apiKey: string) => ImageBackend`
  (the tests' injected `build` changes with it). The map is keyed by `route.modelId`, so
  one model is built once whatever carries it.
- `ImageParams.modelId` is untouched: it still holds the id as the author spelled it,
  which is what `AssetCache.requestKey` hashes. A picture drawn through OpenRouter has the
  same identity as one drawn natively, so adding an Anthropic or Gemini key later does not
  redraw anything, and a `vngen/` tree produced on one machine replays on another.
- **`ImageResult.modelId` is the author's spelling too.** `createOpenRouterImage` returns
  the id it was built with, and `runners.ts:62-68` writes `result.modelId` into the
  committed manifest as `Asset.modelId` (so does the fixture index in `cache.ts:110` and
  `artgen/concept.ts`). The router rewrites `modelId` on every result to `route.modelId`
  before returning it, so a manifest never holds `google/gemini-2.5-flash-image` for a
  project that configured `gemini-2.5-flash-image`; two spellings of one model in a
  committed file would follow the project for ever. This is decided before the image stage
  ships, not after.
- The manifest's per-asset generation record gains an optional `transport: Transport`
  field, always written (`docs/reference/pipeline-contracts.md` lists what a record
  carries; this adds a field and changes no invariant). For an author-spelled OpenRouter
  id, `native` and `transport` are both `openrouter` and the field says nothing new; it is
  written anyway so a reader never has to know the rule to read the record. Failure
  records are not touched: a `TaskAttempt` holds a thrown error's message, and the
  backend's `OpenRouter (<native>) …` prefix already names the transport there.
- `seed` refusal: the catalog's `seed` flag is looked up by the wire id, since that is
  what `models.json` lists. A Gemini image model reached through OpenRouter that the
  catalog lacks is built as if it took a seed, as today.
- `previewImageModel` in `session/project.ts` refuses on
  `imageRouteFor(id, present) === undefined` rather than on the Gemini key alone, with
  `missingRouteError`'s sentence.

## Decision 6: a thread keeps its transport

- The native-log header (`ResumeHeader` in `shared/convo.ts`, written by `recordMessage`,
  read back by `resumeHeaderOf` in `main/notify/threads.ts`, which must whitelist the new
  field) gains `transport: Transport` beside `vendor`. `vendor` stays, because the ledger
  and the report read it as "which model family"; `transport` is what the message format
  belongs to. A header without `transport` (every existing thread) reads as
  `transport = vendor`. `NATIVE_VERSION` does not bump; the field is additive.
- **The session pins an open thread to its transport.** `chooseBackend` is reached not
  only on a resume but on `setModel` and `setEffort` (`session/agent.ts:184-211`), which
  rebuild the backend mid-conversation. An author who pastes an Anthropic key mid-thread
  and then changes effort would otherwise move a thread whose assistant turns are Chat
  Completions messages onto `createAnthropicChat`, and the next call would 400. So
  `chooseBackend` reads `this.native.transport` (set when the header was written, or from
  the header on a resume) and, when a thread is open, routes with `present` narrowed to
  `{ [pinned]: true }` — the pinned transport if its key still resolves, else a
  `ConfigError` with the sentence below. A new thread routes on the full `present` and
  pins whatever it gets. `setModel` across vendors already refuses through the vendor
  check; within a vendor it keeps the pin.
- `ResumeBinding` in `shared/threads.ts` gains `transport?: Transport`, filled by main,
  which is the side that has the keys, and `resumeRefusal` adds one check between the
  vendor check and the backend check, with a `TRANSPORTS: Record<Transport, string>` label
  table beside `VENDORS`: "was recorded through <OpenRouter | Anthropic's own API |
  Google's own API> and the agent would now continue it through <…>. The two do not share
  a message format, so continuing would send blocks the model cannot read. Provide a
  <vendor> key first, or open the conversation for reading." The doc comment on
  `ResumeBinding` ("the pane runs the first four checks and main runs all five") becomes
  four and six, and `shared/tests/threads.test.ts` gains the case.
- The pane does **not** run the transport check. `resumeAction` in
  `renderer/rules/convobar.ts` builds its binding from Convo state, which carries no key
  status, and threading `project.keyStatus` into the convobar situation would change
  `renderer/rules/situations/convobar.ts` and `ux-model.json` to grey a button that main
  refuses with the same sentence one click later. The check is main-only, like the backend
  check already is.

## Decision 7: what the refusal, the Setup pane and the docs say

- `missingRouteError` is the only new sentence a key-less run produces, and it ends with
  the OpenRouter clause only when the model is one `openRouterIdFor` can spell. Every
  existing test asserting `missingKeyError`'s text keeps passing, because that function is
  unchanged.
- The Setup pane's vendor rows (`ipc.ts` ~855, `KEY_VENDORS` order) each gain a one-line
  note computed in main from `keyStatus` + `chatRouteFor` / `imageRouteFor` over the
  project's configured models: "claude-opus-4-8 will run through OpenRouter until an
  Anthropic key is provided", or "no OpenRouter key either, so claude-opus-4-8 cannot
  run". The OpenRouter row's note lists what it is currently carrying. The status-row
  tooltip in `onboarding.ts:187-189` ("Nothing answers for anthropic yet") says the same.
  `onboarding.ts` is under `renderer/pathux/editors/**`, so the CDP anchor sweep is re-run
  and `anchors.json` recommitted, per CLAUDE.md.
- `noticeMissingKeys` in `workspacelifecycle.ts` warns only when a configured model has no
  route, and names the model rather than the vendor.
- Docs that state the old rule and change: `docs/guides/api-keys.md` — the intro
  (`:19-23`, "You need both the Gemini and the Anthropic keys … The OpenRouter key is
  optional") and the OpenRouter section (a **Fallback** paragraph with the preference
  rule; `billing` becomes the general models page; `pnpm check:keylinks` after);
  `docs/guides/cli.md`'s key section; `docs/reference/packages.md:68` ("Gemini + Claude
  backends"); `docs/reference/pipeline-contracts.md:224-225` ("the Gemini and Claude
  backends retry a transient failure in place") and its record-field list; the doc comment
  at `packages/config/src/keys.ts:9-10` ("`openrouter` is an image vendor only");
  CLAUDE.md's key-resolution bullet gains one sentence.

## Decision 8: what this deliberately does not do

- **No `transport:` override in `project.yaml`.** The rule is "native if you can,
  OpenRouter if you must"; an author who wants OpenRouter for a model they hold a native
  key for spells the OpenRouter id (`anthropic/claude-opus-4.8`) and gets it, as they can
  today for images. A knob would add a fourth place a call's key is decided.
- **Plugin gen-graph nodes are not routed.** `genservices.ts` hands a plugin `keys[name]`
  by vendor name; a plugin that asks for `gemini` under an OpenRouter-only key gets
  `undefined`, as today. A plugin knows its own endpoint and the routing rule cannot
  rewrite its request. `docs/reference/gen-graphs.md`'s plugin section says so.
- **No routing through OpenRouter's `models` or `route` fallbacks.** OpenRouter can fail a
  call over to another model; the app never asks it to, because the manifest and the
  ledger must name what actually answered. `provider.data_collection: 'deny'` is sent; no
  other `provider` preferences are.
- **No OpenRouter-specific model listing for chat**, no price table for chat (the
  credentials plan owns dollars), no `usage.cost` read even though OpenRouter reports one.
- **No streaming**, no `:online`, no `:nitro` variants, no `:batch` variants.
- **Tool search / `defer`** stays Anthropic-native only.
- **The four-vendors plan's `ChatBlock` vocabulary** is not adopted here; see the next
  section.

## Relationship to the four-vendors plan

[`four-chat-vendors-and-two-more-image-providers.md`](four-chat-vendors-and-two-more-image-providers.md)
is planned and unshipped. This plan is independent of it and lands first, because it is
smaller and an author with only an OpenRouter key is blocked today.

- Its Decision 1 (an ordered vendor table returning `undefined` for an unknown id)
  subsumes `chatVendorFor`. `chatRouteFor` is written over `chatVendorFor` plus the slash
  rule now and reads the table later; the signature does not change.
- Its Decision 3 (a neutral `ChatBlock` vocabulary) would delete the translation in this
  plan's Decision 3 — the OpenRouter backend would read `text` / `toolCall` / `toolResult`
  / `opaque` blocks instead of Anthropic `tool_result` blocks. That is the right end
  state. This plan does not wait for it because the translation is one function over three
  shapes, and it is the same function the four-vendors plan's OpenAI backend needs, so it
  moves rather than being thrown away.
- When that plan adds OpenAI and xAI natives, `openRouterIdFor` / `nativeIdFor` gain two
  rows (`openai/…`, `x-ai/…`) and the route rule needs no change: `present.openai` ⇒
  native, else OpenRouter.
- That plan carries the same `SYSTEM (out-of-band)` misattribution this plan's review
  caught (its lines 230–232); it should be corrected there when that plan is next edited.
- The `{do:'switch'; model}` recovery in `apierror.ts` already switches across vendors;
  Decision 6's pin covers a switch across transports within a vendor. The cross-vendor
  mid-conversation switch is that plan's open question and stays there.

## Staging

Every stage is green under `pnpm check`, `pnpm test` and `pnpm lint`, and each is one
commit. The invariant that a run is refused before it pays for a picture it cannot review
(`factory.ts:47-51`) holds at every stage: no stage routes a chat id through OpenRouter
before `chatBackendFor` can build the backend for it.

1. **The route.** `Transport`, `Route`, `KeysPresent`, `chatRouteFor`, `imageRouteFor`,
   `openRouterIdFor`, `nativeIdFor` in `@vn/types`; `keysPresent` and `missingRouteError`
   in `@vn/config`; `resolveRoutes` in `@vn/providers`. Table tests over `TEXT_MODELS` and
   the defaults. No caller changes; `requiredVendors` still exists.
2. **The OpenRouter chat backend** and `openrouter-common.ts`, with the fake-fetch tests.
   Nothing calls it yet.
3. **The image seam.** `createImageBackend` routes and rewrites `ImageResult.modelId`;
   `ImageBackendBuilder` takes a `Route`; the manifest record carries `transport`;
   `previewImageModel` routes; `packages/testkit/src/record.ts` routes the image id.
   `requiredVendors` stays for now but drops its image vendor, which `createImageBackend`
   now checks itself with a route; its test changes with it. A Gemini image id with only
   an OpenRouter key draws through OpenRouter, provable offline with the injected `build`.
   A test asserts the `AssetCache` request key is identical either way.
4. **Chat routing.** `chatBackendFor` takes a `Route`; the six `chatVendorFor` sites, the
   two hard-coded `['anthropic']` sites, the two hand-written `keys[vendor]` checks, the
   audit script, `buildProviders`'s `require` option and the private copy in
   `apps/authoring/src/agent.ts` all move to `resolveRoutes`; `requiredVendors` and
   `factory.test.ts:127-146` are deleted in the same commit. After this stage an
   OpenRouter-only author can run everything in "What an author sees".
5. **Threads.** `ResumeHeader.transport`, `resumeHeaderOf`, `this.native.transport`, the
   pin in `chooseBackend`, `ResumeBinding.transport`, `TRANSPORTS`, the new refusal, and
   the `threads.test.ts` case. `convobar.ts` is not touched, so no `gen:uxmodel`.
6. **Setup pane notes and docs.** The per-vendor note and its IPC field, the
   `onboarding.ts` tooltip (then the anchor sweep), `noticeMissingKeys`, and every doc in
   Decision 7; this page's row in `index.md`.
7. **The live check.** `scripts/verify-prompt-cache.mjs` gains an OpenRouter branch
   (`--via openrouter`), run once by hand against Claude and once against Gemini; the
   results — whether the breakpoints registered, what `cache_write_tokens` said and
   whether `prompt_tokens` included it, whether an effort level was accepted — go into the
   As-shipped section here and into `docs/research/`.

Stages 1–4 are the deliverable; 5 protects an author who adds a key mid-project; 6 and 7
are what make the work finished under `conventions.md`.

## What cannot be tested without a key

| Stage | Needs a real key for                                                  | Stands in                                                                                            |
| ----- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2–4   | that `cache_control` registers and `cached_tokens` rises on turn two  | fake-fetch tests asserting the marker's placement; stage 7                                           |
| 2–4   | whether `reasoning.effort` is accepted on Opus 4.8 / Opus 5           | the one-shot `enabled: true` retry; stage 7 records the answer                                       |
| 2–4   | whether `prompt_tokens` includes `cache_write_tokens`                 | stage 7 compares the two on a writing turn; the backend's arithmetic is a one-line switch either way |
| 2–4   | whether a mid-array `system` message reaches Anthropic as system-role | not needed: the backend re-rolls it to `user` regardless                                             |
| 3     | that `google/gemini-2.5-flash-image` accepts `input_references` edits | the shipped image backend already draws through it; one recorded fixture if the edit path differs    |

## Verified and unverified facts

Checked on 2026-09-19 against OpenRouter's live model listing and its documentation.

| Claim                                                                                                | State                        |
| ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| Anthropic ids are `anthropic/claude-<family>-<major>.<minor>`; Gemini ids are `google/<native id>`   | verified (listing)           |
| `cache_control` on content parts is forwarded to Anthropic; four-breakpoint limit; `ttl: '1h'`       | verified (docs)              |
| Gemini 2.5+ caches implicitly; OpenRouter honours the last `cache_control` breakpoint                | verified (docs)              |
| `usage.prompt_tokens_details.cached_tokens` and `.cache_write_tokens`, sent without opt-in           | verified (docs)              |
| `prompt_tokens` includes `cache_write_tokens`                                                        | UNVERIFIED; stage 7          |
| `reasoning.effort` accepts `max, xhigh, high, medium, low, minimal, none`; `enabled: false` disables | verified (docs)              |
| `reasoning_details` must be echoed back on the assistant message across a tool call                  | verified (docs)              |
| OpenRouter maps effort to `budget_tokens` on Anthropic, which current Claude models refuse           | docs say so; UNVERIFIED live |
| `cache_control` is accepted on a tool definition                                                     | UNVERIFIED                   |
| A mid-array `system` message is passed as system-role rather than folded into the system prompt      | UNVERIFIED; not relied on    |
| `google/gemini-2.5-flash-image` takes `input_references` for an edit                                 | UNVERIFIED for the edit path |

## Review findings

A fresh-context reviewer read the first draft against the code on 2026-09-19 and returned
thirty-six findings. Each is fixed above or answered here.

- **Assumed, now stated.** (1) `chatVendorFor` has no slash rule, so an author-spelled
  OpenRouter chat id would have gone to Anthropic's API — Decision 1 adds the rule. (2)
  Every model table is keyed by the native spelling — `nativeIdFor` added, Decision 1–2.
  (3) `chatBackendFor` had no way to refuse an unrouted id — it now takes a `Route`. (4)
  `setModel` / `setEffort` rebuild the backend mid-thread — Decision 6 pins the transport.
  (5) Whether `prompt_tokens` includes the cache write — now an unverified row with a
  stage-7 check and a switch either way. (6, 29) `ImageResult.modelId` would have put the
  wire id into committed manifests — the router rewrites it, Decision 5. (7)
  `ImageBackendBuilder`'s first argument — now a `Route`. (8) Plugin nodes bypass routing
  — out of scope, Decision 8.
- **Contradicted, now corrected.** (9) `testKey` is not a `chatVendorFor` site; six, not
  seven. (10, 36) `vngen decompose`, `decomposePreconditions`, testkit `record.ts` and
  `buildProviders`'s `require` type were missed — in stage 4 / 3. (11)
  `previewImageModel`, `noticeMissingKeys`, the audit script and the onboarding tooltip
  were missed — Decisions 5, 7. (12) The `SYSTEM (out-of-band)` prefix is the structured
  path's, not `messagesOf`'s — Decision 3 now says role swap only, and the four-vendors
  plan is flagged. (13) `callWithRetry` / `retryAfterMs` already live in `transient.ts` —
  the common file now lists what actually moves. (14, 15) `packages.md`,
  `pipeline-contracts.md`, `keys.ts`'s comment and `api-keys.md`'s intro all state the old
  rule — Decision 7 lists them. (16) `ResumeHeader` and `resumeHeaderOf` are in `convo.ts`
  / `notify/threads.ts` — named. (17) The pane has no key status — the check is main-only.
  (18) String assistant turns — accepted. (19) `TRANSPORTS` labels, the `ResumeBinding`
  doc comment and its test — named. (20) The anchor sweep is owed for `onboarding.ts` —
  stage 6. (21, 34) `factory.test.ts` — deleted in the same commit. (22) "Five members" —
  four methods.
- **Deferred, now decided.** (23) `resolveRoutes` returns `Map<string, Route>`. (24) The
  session keeps `this.native.transport`. (25) An author-spelled OpenRouter id records
  `transport: 'openrouter'` beside `native: 'openrouter'`, written anyway. (26) Failure
  records are not touched; the error prefix already names the transport. (27) The
  hard-coded `['anthropic']` sites route `models.text`. (28) The effort downgrade is a
  one-shot retry recorded through `captureRequest`, not a "working note" the seam does not
  carry.
- **Cost to undo.** (30) Header and manifest fields are additive optional fields with no
  version bump; hashes are unchanged — confirmed. (31) Deleting `requiredVendors` touches
  five callers — accepted; it is one stage.
- **Layering.** (32) Placement checks out; `Transport` stays in `@vn/types` for the
  renderer's sake — stated in Decision 1.
- **Staging.** (33) The first draft's stage 2 would have passed the pre-run check for a
  Claude id while `chatBackendFor` still built on an empty key — the image stage now
  routes image ids only, and chat `require`s survive until the stage that replaces
  `chatBackendFor`. (35) `convobar.ts` is no longer touched.

## As shipped

Stages 1–6 landed on 2026-09-19 as six commits on `openrouter-fallback`, each green under
`pnpm check`, `pnpm test` and `pnpm lint`. Deviations from the text above:

- **`resolveRoutes` takes a `RouteRequest`** (`{ chat?: string[]; image?: string[] }`)
  rather than a flat list of ids, because a chat id and an image id route through
  different rules and the caller is the one that knows which is which.
  `projectModels(config)` is the request for every configured model,
  `chatRoute(config, keys, id)` is the one-id form, and `buildProviders`'s option is
  `routes?: RouteRequest` rather than `models?: string[]`: `vngen decompose` and
  `decomposePreconditions` pass `{ chat: [config.models.text] }`, which is the intent
  Decision 1 states.
- **`createProviders` does not refuse.** A model no key carries gets a backend that
  rejects every call with `missingRouteError`'s sentence, so `vngen decompose` can build
  the bundle for a project whose reviewer has no key, as it could when `require` listed
  only `anthropic`. The refusal ahead of a run is `resolveRoutes` in each host's pre-run
  check, which is where Decision 1 put it.
- **`openRouterIdFor` returns `undefined`** for an id under no known vendor rather than
  guessing a prefix, so `missingRouteError` can add the OpenRouter clause only when the
  rule can spell the id, as Decision 7 asks.
- **`Route.native` for an author-spelled id** is what its prefix names (`anthropic/` →
  `anthropic`, `google/` → `gemini`, else `undefined`), per Decision 1; Decision 5's aside
  that `native` would read `openrouter` for such an id was loose and the manifest carries
  only `transport`, which does read `openrouter`.
- **`ResumeHeader.transport` is optional in the type**, because an existing header lacks
  it; `headerTransport` in `shared/threads.ts` is the one place the fallback to `vendor`
  is written. A resume also rebuilds the backend under the pin, because the backend built
  when the agent was created may have taken the free route.
- **The Setup pane's notes** come from `routingNotes` in
  `apps/desktop/src/main/session/routing.ts`, carried as `VendorKeyView.routing` and
  `KeyStatusView.unrouted`; the startup notice reads `unrouted`.
- **The tools block is not cache-marked** through OpenRouter, since whether
  `cache_control` is accepted on a tool definition is unverified; it is cached only as
  part of the prefix ahead of the system message's breakpoint.
- The anchor sweep for `onboarding.ts` and stage 7
  (`scripts/verify-prompt-cache.mjs --via openrouter`, run by hand against Claude and
  against Gemini, with the four unverified rows above answered from its output) are still
  owed.

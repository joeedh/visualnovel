# Four chat vendors and two more image providers

The provider seam is already the right shape. What is wrong is that three separate places
guess a vendor from a model id with a two-branch string test, and that the one package
which must stay vendor-neutral builds Anthropic wire blocks by hand. This plan adds OpenAI
and xAI (Grok) as chat backends beside Anthropic and Gemini, and OpenAI Images and BFL
FLUX.2 as image backends beside Gemini's. It changes `ChatBackend` in exactly one way, by
widening what a turn may contain, and it changes `ImageBackend` not at all. Every other
change replaces an `if` with a table, or adds a per-vendor translation in the file where
the SDK import already lives.

<!-- toc -->

- [Why now](#why-now)
- [Where the vendor leaks through today](#where-the-vendor-leaks-through-today)
- [Decision 1: the seam keeps its shape, and a turn stops being Anthropic-shaped](#decision-1-the-seam-keeps-its-shape-and-a-turn-stops-being-anthropic-shaped)
- [Decision 2: keys are a record, not a pair](#decision-2-keys-are-a-record-not-a-pair)
- [Decision 3: caching, vendor by vendor](#decision-3-caching-vendor-by-vendor)
- [Decision 4: tool calling, vendor by vendor](#decision-4-tool-calling-vendor-by-vendor)
- [Decision 5: the effort ladder is per vendor, and the stored word never changes meaning](#decision-5-the-effort-ladder-is-per-vendor-and-the-stored-word-never-changes-meaning)
- [Decision 6: four shapes of receipt, one rule about absence](#decision-6-four-shapes-of-receipt-one-rule-about-absence)
- [Decision 7: image providers — OpenAI, and FLUX.2 for the seed](#decision-7-image-providers--openai-and-flux2-for-the-seed)
- [Decision 8: what this deliberately does not do](#decision-8-what-this-deliberately-does-not-do)
- [Staging](#staging)
- [What cannot be tested without a key, and what stands in](#what-cannot-be-tested-without-a-key-and-what-stands-in)
- [Risks and open questions](#risks-and-open-questions)
- [Needs verification before implementation](#needs-verification-before-implementation)

<!-- tocstop -->

## Why now

Three separate plans have already run into the same limitation.
[`provider-credentials-and-the-ai-usage-ledger.md`](provider-credentials-and-the-ai-usage-ledger.md)
states in its step 9 that a third vendor "necessarily" needs a real routing table, because
`chatVendorFor`'s "anything not `claude` is Gemini" rule cannot survive one.
[`archive/INDEX.md#prompt-caching-and-deferred-tool-loading`](archive/INDEX.md#prompt-caching-and-deferred-tool-loading)
built a four-breakpoint request builder that is Anthropic-only by construction and left
Gemini on the single-shot path.
[`archive/INDEX.md#gemini-estimated-cache-hit-rate`](archive/INDEX.md#gemini-estimated-cache-hit-rate)
had to invent `cacheEstimated` because one vendor reports a matched prefix that it does
not bill for.

Each of those decisions was the right local call. Together they leave the repo with one
native conversation path, one vendor's block vocabulary embedded in a neutral package, and
a key resolver with two hand-written branches. Adding a vendor currently changes nine
files, most of which should not need to refer to a vendor at all.

## Where the vendor leaks through today

The entries are enumerated so the plan's stages can be checked against them. Each entry is
a place that compiles today only because there are exactly two vendors.

- **`chatVendorFor`** in `packages/providers/src/factory.ts` —
  `id.startsWith('claude') || id.startsWith('anthropic') ? 'anthropic' : 'gemini'`. The
  `else` branch causes the bug: an unrecognised id is routed to Google with Google's key,
  and no error is raised.
- **Two more copies of that rule** live in `apps/authoring/src/agent.ts`: a private
  `chatBackendFor`, and a third inline copy in `buildAgentBackend`
  (`modelId.toLowerCase().startsWith('claude') ? 'anthropic' : 'gemini'`).
- `ResolvedKeys` in `packages/config/src/keys.ts` is a fixed two-field interface, indexed
  as `keyof ResolvedKeys` in five files. `KEY_VENDORS`, `SECRET_FILES` and `secretFileFor`
  are declared in the same file, and `resolveKeys` resolves each vendor in a hand-written
  line with a hand-written `require` check.
- **`projectConfig.keys`** in `packages/types/src/schemas.ts` is a fixed two-key zod
  object.
- `createProviders` hardwires `createGeminiImage(keys.gemini, config.models.image)`, and
  `require: ['gemini']` is hardcoded at four call sites: `apps/cli/src/project.ts`,
  `apps/desktop/src/main/session.ts` (`buildProviders`), `packages/authoring/src/art.ts`
  (`imageOf`), `packages/testkit/src/record.ts` (`recordCorpus`).
- `effortChoicesFor` and `supportsSystemRole` in `packages/types/src/textmodels.ts` are
  Claude-family regexes that return `[]` / `false` for everything else. A new vendor
  therefore gets no reasoning knob and no system role, and nothing fails.
- **`apps/desktop/src/shared/advice.ts`** holds a second vendor inference, independent of
  the first, in the browser-bundled layer: `SMALL = /haiku|flash/`,
  `FICTION = /fable|mythos/`, `NO_KNOB = /gemini/`, plus `familyName`'s hand-listed family
  words. `gpt-5.6-luna` and `grok-4.6` match none of them.
- **`TRANSIENT_TEXT`** in `packages/providers/src/backends/transient.ts` is a shared regex
  listing Gemini's gRPC status names.
- **`turnOf`** in `packages/authoring/src/backend.ts` is the sharpest case: it builds
  Anthropic wire blocks inside a vendor-neutral package,
  `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`.
  `ChatTurn.role: 'system'` is likewise an Anthropic notion, and
  `ChatConvoReply.raw: unknown[]` is vendor-native by definition. The existing
  `{do:'switch'; model}` recovery in `packages/authoring/src/apierror.ts` becomes a live
  hazard the moment a second native backend exists.
- **`imagePart`'s placeholder refusal** is implemented in `backends/gemini.ts`. The rule
  that the real backend refuses placeholder art becomes a Gemini-only rule the instant a
  second image backend lands.
- **`ImageParams.aspect`** is hashed into the task identity and is never sent.
  `createGeminiImage` passes `seed` and nothing else.

## Decision 1: the seam keeps its shape, and a turn stops being Anthropic-shaped

`ChatBackend` keeps all five members. `message`, `messageWithUsage`, `chatWithTools`,
`chatConversation` and the `ChatRequest`/`ChatToolReply` types are already vendor-neutral.
Their only fault is what `ChatTurn.content` is allowed to hold and what
`ChatConvoReply.raw` is allowed to return.

Vendor routing becomes an ordered table in `@vn/types` rather than a string test in
`@vn/providers`. It has to live in `@vn/types` because `apps/desktop/src/shared/` is in
the browser bundle and cannot import a package that loads a vendor SDK — that is exactly
why `textmodels.ts` is already there, and why `advice.ts` re-derives the rule instead of
importing it. The new surface is:

```ts
export const VENDORS = ["anthropic", "gemini", "openai", "xai", "bfl"] as const;
export type Vendor = (typeof VENDORS)[number];

export function vendorOf(modelId: string): Vendor | undefined; // chat
export function imageVendorOf(modelId: string): Vendor | undefined; // image
```

There are two functions rather than one, because `gemini-2.5-flash-image` and
`gemini-2.5-flash` belong to the same vendor while `gpt-image-2` and `gpt-5.6-terra`
belong to the same vendor only by accident of naming. Both read one ordered
`[RegExp, Vendor]` table, so adding a family means adding a row.

Returns `undefined` for an unrecognised id, and callers refuse by name. Today's `else`
branch uses the wrong key without reporting it; with four vendors that produces a support
ticket reading "invalid API key" when the cause is a model id we do not know. A `vendor:`
prefix (`openai:gpt-5.6-terra`) is accepted as an escape hatch for a self-hosted or
renamed endpoint. Note that `ImageParams.modelId` is hashed into the asset request key, so
adding a prefix to an image model id already in use re-keys every image task. Recommend
the prefix only where inference genuinely fails.

`ChatTurn.content` and `ChatConvoReply.raw` get a neutral block vocabulary, declared in
`packages/providers/src/backend.ts`:

```ts
export type ChatBlock =
    | { kind: "text"; text: string }
    | { kind: "toolCall"; id: string; name: string; args: unknown }
    | { kind: "toolResult"; id: string; content: string }
    | { kind: "opaque"; vendor: Vendor; block: unknown };
```

`text`, `toolCall` and `toolResult` are the three block kinds every vendor has and the
three that `@vn/authoring` actually constructs. `opaque` is everything else — Anthropic
`thinking` and `redacted_thinking` blocks, OpenAI `reasoning` items with their
`encrypted_content`, anything a future vendor requires be echoed verbatim. It is tagged
with the vendor that emitted it. A backend drops an `opaque` block tagged with a different
vendor and records the drop in the turn's `working` note. This matters because
`apierror.ts` already offers `{do:'switch'; model}` as a recovery, and today a
Claude→Gemini switch hands Gemini a transcript full of Anthropic blocks. Dropping a
reasoning block is the only correct handling for it, and the loop must be able to see that
the drop happened.

This change deletes `turnOf`'s hand-built `tool_result` and moves the translation into
`backends/anthropic.ts`, which already imports the SDK. `convo-request.test.ts` should
assert the same request bytes before and after. Identical bytes prove the change is
behaviour-neutral for Anthropic.

## Decision 2: keys are a record, not a pair

`ResolvedKeys` becomes a mapped type over `VENDORS`:

```ts
export type ResolvedKeys = Record<Vendor, string>;
export const KEY_VENDORS = VENDORS;
```

Every existing `keyof ResolvedKeys` site keeps compiling (`session.ts`'s
`keyFile`/`previewKey`/`setKey`, `analystBackend` in
`packages/agentreport/src/analyze.ts`, and `projectSetKey`'s
`prop.oneOf(KEY_VENDORS, …)`). The desktop key dialog grows from two entries to five with
no code change, because it was already built from the constant.

`SECRET_FILES` gains `openai: ['openai.txt']`, `xai: ['xai.txt', 'grok.txt']` and
`bfl: ['bfl.txt', 'flux.txt']`. `projectConfig.keys` in `packages/types/src/schemas.ts`
holds five defaulted fields — `OPENAI_API_KEY`, `XAI_API_KEY` and `BFL_API_KEY` beside the
two that exist. Each field carries its own zod default, so every existing `project.yaml`
keeps parsing unchanged. Keeping that parse intact is why the schema is widened rather
than replaced with a free record.

`resolveKeys`'s two hand-written lines become a loop over `KEY_VENDORS`, and its `require`
check becomes an index instead of a ternary. The error-message rule is unchanged, and it
is the thing to be careful about. The message names `${envName}` and
`secretFileFor(vendor)`, never the value. The loop must keep constructing the message from
the vendor's own config entry, not from a shared template that could accidentally
interpolate the resolved string.

BFL authenticates with an `x-key` header rather than `Authorization: Bearer`. The key is a
string in either case, and the backend sets the header, so nothing here changes.

## Decision 3: caching, vendor by vendor

This part has no shared abstraction, and the plan holds that it should not have one. The
four vendors disagree about the one thing that matters, which is what a cached prefix is,
and a lowest-common-denominator adapter would cost exactly the caching the last plan was
written to obtain. The discipline is shared: build a byte-stable prefix, append rather
than edit, and never let turn-scoped truth reach into the system block.

**Anthropic — unchanged.** `buildConvoRequest`, `EPHEMERAL`, `MESSAGE_BREAKPOINTS = 2`,
`markLast`, `UNMARKABLE`, and the tools breakpoint on the last non-deferred tool all still
stand. As of 2026-08-18, `ephemeral` remains the only cache type, with optional
`ttl: "5m"` (default) or `"1h"`. Four explicit breakpoints is the ceiling and automatic
caching consumes one of them, so the API returns 400 if four are already set. Reads bill
0.1×; 5m writes 1.25×, 1h writes 2×. The minimum cacheable prefix depends on the model
(512 tokens on Opus 5 / Fable 5 / Mythos 5, up to 4,096 on Opus 4.6 and Haiku 4.5). A
prefix below the minimum is silently uncached, which is worth a note in the verify
script's output because it looks identical to a broken breakpoint.

**OpenAI ignores the markers and caches on the prefix alone.** Caching is automatic over a
prefix of at least 1,024 tokens, and any change to that prefix invalidates it. The OpenAI
backend therefore ignores `ChatTurn.cache`, which is already what the field's doc comment
permits ("the backend maps it to the vendor's marker, or ignores it"). The backend must
instead keep the request bytes stable: `instructions` (or the leading developer message)
and the `tools` array identical across every turn, and `input` growing only by appending.
The `NativeAgentBackend` loop already does that. The backend must also set
`prompt_cache_key` to a per-conversation id so requests route to the same cache, and set
`prompt_cache_retention` where the longer window is needed. This requires a conversation
identity to reach the backend, so `ChatConvoRequest` grows an optional
`conversationId?: string` that `NativeAgentBackend` mints once per instance. Anthropic
ignores it; Gemini ignores it; xAI maps it to a header.

The `{"role":"system"}` append trick takes three forms. It exists so that turn-scoped
truth (the current mode, a superseded `composeSystem` section) can be stated without
editing the cached prefix. Each vendor handles it as follows:

- Anthropic receives a `{role:'system'}` turn mid-`messages`, as today.
- For OpenAI, a `{role:'developer'}` message is appended to `input`. Developer messages
  are ordinary input items, so no predicate is needed. (Whether a developer message is
  accepted mid-array rather than only at the head is UNVERIFIED — see the verification
  table.)
- xAI exposes an OpenAI-compatible API, so the request takes the same shape. A
  `{role:'system'}` message mid-array is the documented Chat Completions behaviour. This
  is UNVERIFIED on the Responses surface.
- **Gemini has no such notion at all.** `systemInstruction` is a single field ahead of
  `contents`, so editing it invalidates everything downstream of it. `messagesOf` already
  down-renders for a Claude model without the role, turning the turn into a user turn
  prefixed `SYSTEM (out-of-band):`, and Gemini takes that same path. So
  `supportsSystemRole` stops being a Claude-model predicate and becomes
  `systemRoleFor(modelId): 'system' | 'developer' | 'none'`, and the down-render path
  stops being a legacy branch and becomes Gemini's normal operation.

**Gemini — implicit caching, and `chatConversation` finally implemented.** Implicit
caching is on by default for 2.5+ with a 2,048-token minimum (4,096 on 3.x). Gemini's poor
cache behaviour does not come from missing markers. Gemini has no `chatConversation`, so
every turn re-renders the whole transcript through `chatWithTools` and the host keeps it
on the Structured path. Implementing `chatConversation` for Gemini as an appended
`contents` array (with `cache` ignored and system turns down-rendered) moves Gemini onto
the native path, where the implicit cache applies. The gain is large for one afternoon's
work, so this is a stage rather than a footnote.

Explicit `cachedContents` is deliberately not done; see decision 8.

**xAI — automatic prefix caching, one header.** Cache hits are reported at
`…_tokens_details.cached_tokens`. There is no documented TTL and no documented cache-write
surcharge. The documented way to maximise hit rate is the `x-grok-conv-id` request header,
which carries `conversationId`.

## Decision 4: tool calling, vendor by vendor

The registry (`ToolSchema {name, description, parameters, defer?}`) needs no change. The
wire shape differs between backends, and each backend absorbs its own differences.

|           | declaration                                                     | call comes back as                                                              | result goes back as                                             | parallel                          |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| Anthropic | `tools[].input_schema`                                          | `tool_use` block, `input` an **object**                                         | `tool_result` block in a user turn                              | default on                        |
| OpenAI    | flat `{type:'function', name, description, parameters, strict}` | top-level item `{type:'function_call', call_id, name, arguments}`, a **string** | top-level item `{type:'function_call_output', call_id, output}` | `parallel_tool_calls`, default on |
| xAI       | as OpenAI                                                       | as OpenAI                                                                       | as OpenAI                                                       | as OpenAI                         |
| Gemini    | `functionDeclarations`                                          | `functionCall` part, **no id**                                                  | `functionResponse` part                                         | multiple parts                    |

Three consequences are worth naming.

`arguments` is a string on OpenAI and xAI and an object on Anthropic. The backend parses
it, and a parse failure produces a `ProviderError` naming the tool rather than crashing
the loop. The loop's `ToolCall.args` stays `unknown`.

Gemini's `functionCall` has no id. Pairing N parallel calls to N results without ids has
to be positional or by name, and both are fragile when a model calls the same tool twice.
The Gemini backend synthesises ids on the way out (`call_${i}`) and strips them on the way
in, so `AgentAction.id` and `turnOf`'s pairing contract hold everywhere and only the
backend knows the ids are synthetic.

**`defer` is Anthropic-only.** `defer_loading` and the server-side `tool_search_tool_bm25`
tool have no counterpart on the other three, so `SEARCH_TOOL` is not sent and the whole
catalog goes in the request. `ToolSchema.defer`'s doc comment already states that a
backend which ignores the flag receives the whole catalog. The cost is material: at ~40
tools the prefix is much larger and the selection problem much harder, and that is a
reason to keep Claude the default agent model.

**`LOOSE_PARAMS` blocks OpenAI's `strict` mode.** A schema of
`{type:'object', additionalProperties: true}` cannot be `strict: true`, which requires a
complete schema with `additionalProperties: false`. Send `strict: false` rather than
fabricate schemas. Deriving real JSON Schema from `Tool.args` is already flagged as a
workstream of its own in the caching plan; that work would unlock `strict` and improve
tool search at the same time, and it is out of scope here.

## Decision 5: the effort ladder is per vendor, and the stored word never changes meaning

The decision is that `EFFORT_CHOICES` — the ordered tuple `resolveEffort` and `stronger`
index into — does not change. OpenAI's ladder includes `minimal`, which sits between
`none` and `low`; adding it would shift every index and silently re-interpret every effort
choice already stored in a project. The tuple stays the surface's ladder instead, and the
backend's `tuning()` maps it to the wire word, so OpenAI's `minimal` is reachable only as
the mapping of `low` on models that offer it. The table records what a surface offers, and
the backend records what the wire calls it.

`effortChoicesFor` now dispatches on the vendor that `vendorOf` returns:

- **anthropic** — uses today's table, unchanged.
- **openai** — supports the full ladder except `minimal`. `reasoning.effort` accepts
  `none | minimal | low | medium | high | xhigh | max`, and the accepted values depend on
  the model: `gpt-5.6-terra` lists no `minimal`.
- **xai** — `low | medium | high | xhigh`. Reasoning cannot be disabled on Grok, so `none`
  is not accepted. `grok-4.5` treats `xhigh` as `high`, which `resolveEffort`'s step-down
  already models.
- **gemini** — stays `[]`. Gemini's thinking budget is a token count rather than a named
  rung, and its current surface is UNVERIFIED. This plan does not wire it.

`supportsEffort` keeps its signature and its meaning — whether a model honours a reasoning
setting at all — and its answer becomes `true` for OpenAI and Grok models. That meaning is
why `advice.ts` should call it: `NO_KNOB = /gemini/` must become
`!supportsEffort(modelId)`, which `adviseEffort` already does at its head while
`adviseModel` re-derives it. `SMALL` needs `mini` added, and `familyName` needs OpenAI and
Grok rows or it prints raw ids mid-sentence.

`TEXT_MODELS` grows from six entries to roughly ten, ordered by vendor. The menu stays
flat. Grouping it would require a path.ux submenu change in two renderers for a list that
is still short.

One incompatibility applies here: on Grok, `presencePenalty`, `frequencyPenalty` and
`stop` are incompatible with reasoning models. Nothing in this repo sets them today; the
backend must not start.

## Decision 6: four shapes of receipt, one rule about absence

`TokenUsage {input, output, cacheRead?, cacheWrite?, cacheEstimated?}` needs no new
fields, and `charge(u) = u.input - (u.cacheRead ?? 0) + u.output` in
`packages/types/src/budget.ts` is correct for all four vendors without modification. What
changes is `usageOf` in each backend, and each direction has one trap.

Anthropic's `input_tokens` excludes cached tokens, so `usageOf` adds
`cache_read_input_tokens` and `cache_creation_input_tokens` into `input` and reports them
beside it, which is the current behavior. Newer responses also carry
`cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, which is finer
detail than `cacheWrite` needs. Sum those two fields if `cache_creation_input_tokens` is
absent.

OpenAI's `input_tokens` already includes cached tokens.
`usage.input_tokens_details.cached_tokens` (Responses) or
`usage.prompt_tokens_details.cached_tokens` (Chat Completions) maps straight to
`cacheRead` and must not be added to `input`. Adding it inflates every charge by the size
of the cache hit, and the caching work exists to make cache hits large.

Reasoning tokens go the other way. Gemini's `candidatesTokenCount` excludes
`thoughtsTokenCount`, so the Gemini backend adds them, which is correct. OpenAI's
`output_tokens` includes `output_tokens_details.reasoning_tokens`, so the OpenAI backend
must not add them. One vendor's field is a subset and the other's is a sibling, and the
two look identical in a diff.

`cacheWrite` stays absent on OpenAI and xAI. Neither reports a cache-creation count. This
matters because GPT-5.6 and later charge 1.25× for cache writes where earlier OpenAI
models charged nothing, so there is a real cost with no reported quantity. The field is
absent rather than zero, because the contract is that a missing field means the vendor
reported nothing. A whole missing `usage` block returns `undefined` rather than
`{input: 0, output: 0}`. The ledger reports no total when the vendor sends no usage, never
`0`, and that rule holds for all four.

`cacheEstimated` stays a Gemini-only flag. It exists because Gemini reports a matched
prefix it does not bill for. OpenAI's and xAI's `cached_tokens` counts are billed, so they
are reported plainly and the flag is not set.

## Decision 7: image providers — OpenAI, and FLUX.2 for the seed

The pipeline generates a shot from a plate plus the character sheets `refsOfSlot` names,
so the whole model-sheet → plate → shot chain requires edit-with-references. A provider
that cannot take multiple reference images is not a candidate, whatever its pictures look
like. That single requirement decides the shortlist.

**OpenAI Images — `gpt-image-2`**, via `POST /v1/images/generations` and
`/v1/images/edits`. Multi-reference editing supports up to 4 references. Output is
`b64_json`; URL responses are not offered for the gpt-image family. Sizes are 1024×1024,
1536×1024, 1024×1536, plus 2K/4K up to 3840×2160 with both edges multiples of 16 and
aspect ≤ 3:1.

`gpt-image-2` has no `seed` parameter, and the backend must refuse a seeded request rather
than ignore it. This is the decision most likely to be argued with, so here is the
argument. `seedFor`'s narrowest-rung-wins chain exists so an author can keep the same
prompt and get a different picture, and zero is a real seed — every test in the repo is
`=== undefined` for exactly that reason. `ImageParams.seed` is hashed into the asset
request key. If the backend drops the seed silently, a re-render that changed nothing
looks like it changed something, the cache key implies a reproducibility the vendor cannot
deliver, and the author has no way to learn either fact. Refuse by name instead:
"gpt-image-2 has no seed parameter; clear the seed on `<rung>` or choose an image model
that has one." An author can act on that refusal, and cannot act on a dropped seed.

`ImageParams.aspect` is in the task hash today and is sent to no model —
`createGeminiImage` sends `seed` and nothing else. Add `sizeFor(aspect)` mapping `16:9` →
1536×1024, `1:1` → 1024×1024, `9:16` → 1024×1536, refusing an aspect with no mapping, and
send aspect on Gemini as well. This changes what Gemini draws, but it changes no hash,
because aspect was always in `params`. Existing frames keep their identity, and a
re-render produces the picture the config specified all along.

The 4-reference ceiling constrains shots. A shot carrying a plate plus three character
sheets is exactly at the cap. Over the cap the backend refuses by name rather than
truncating, because truncating drops a character out of frame and nothing downstream would
notice. Count what `refsOfSlot` produces on a real project before recommending OpenAI
images for shots.

The second provider is BFL FLUX.2 (`flux-2-pro`), chosen for its seed. It is the only
shortlisted vendor with both documented multi-reference editing — up to 8 references on
`flux-2-pro`, four on the klein variants — and a documented integer `seed`. This pipeline
is built on those two things, and OpenAI supplies only the first. The base URL is
`https://api.bfl.ai/v1`, auth uses an `x-key` header, and one per-variant endpoint does
both generate and edit, which maps cleanly onto `ImageBackend`'s two methods over one
call.

The backend handles four FLUX specifics, and none of them may appear in the layers above
it:

- **The API is asynchronous.** POST returns `{id, polling_url}`; poll roughly once a
  second until `status: "Ready"`. `callWithRetry` wraps the submit. The poll runs in its
  own bounded loop with its own deadline, and a poll that never reaches `Ready` raises a
  terminal `ProviderError` rather than retrying.
- The result URL is signed and valid for ten minutes. Download it inside `generate`/`edit`
  and return bytes, as every other backend does. Downloading inside `generate`/`edit` is
  the whole reason the asynchronous work must stay inside them.
- **References are flat numbered fields** (`input_image`, `input_image_2` …
  `input_image_8`) rather than an array. Each field takes a URL or base64 and must be ≤ 20
  MB and ≤ 20 MP.
- **`disable_pup: true`.** Prompt upsampling rewrites the prompt before generation, which
  would defeat both the seed and the content-addressed cache. Turn it off.

`flux-2-pro` takes `width`/`height` rather than an aspect ratio, so `sizeFor` applies to
it too. `ImageResult.seed` (declared but never populated anywhere today) is set here.

**`isPlaceholderImage` moves out of `backends/gemini.ts`.** The rule that the real backend
refuses a marked placeholder image is currently enforced in one backend's `imagePart`.
Extract a shared `refGuard(img)` into `packages/providers/src/image.ts`, call it from
every image backend, and grow the existing check in `providers.test.ts` into a loop over
the backends. Otherwise a testkit placeholder reaches a real vendor and gets billed for.

`createProviders` dispatches on `imageVendorOf(config.models.image)`, and the four
hardcoded `require: ['gemini']` sites become
`require: [imageVendorOf(config.models.image)]`. `AssetCache.requestKey` hashes `params`,
which carries `modelId`, so a recorded corpus never replays across vendors. The
record/replay fixtures need no versioning change.

## Decision 8: what this deliberately does not do

- **Gemini explicit `cachedContents`.** It needs create/reference/delete lifecycle
  management, has a 2,048–4,096 token floor, bills creation at standard input price plus a
  TTL-based storage charge, and the newer Interactions API is implicit-only. Implicit
  caching with a real `chatConversation` gets most of the benefit and requires no
  bookkeeping, and the agent loop has no place to manage a cache's lifetime.
- **Streaming.** Nothing in this repo streams. Writing four streaming implementations to
  make a `working` label more granular is not worth the cost.
- **OpenAI `previous_response_id` / server-side conversation state.** Server-side state
  moves the transcript to the vendor, and both the durable thread and `report.agent` read
  that transcript. xAI's own docs additionally warn against server-side history with
  images.
- **The Responses `image_generation` tool.** This tool generates images on the chat path.
  The pipeline's image seam does not run through a chat, and routing it through one would
  put image identity inside a transcript.
- **Ideogram, Stability, Recraft, Luma, Midjourney.** The credentials plan already ruled
  out Midjourney. Ideogram documents no reference-image parameters. The rest are
  UNVERIFIED on multi-reference editing, which is the deciding requirement.
- **A router / adapter layer (LiteLLM-shaped).** The four vendors genuinely disagree about
  one thing, namely what counts as a cached prefix. A lowest-common-denominator adapter
  would erase that disagreement.
- **Pricing, dollars, and the usage ledger.**
  [`provider-credentials-and-the-ai-usage-ledger.md`](provider-credentials-and-the-ai-usage-ledger.md)
  owns these. This plan reports tokens and must not add a price table.
- **Vertex / Bedrock / Azure routing.** Same plan.
- **Real JSON Schema from `Tool.args` (and therefore OpenAI `strict`).** This is a
  workstream of its own.

## Staging

Each stage passes `pnpm check`, `pnpm test` and `pnpm lint`. The repo rule that every
commit on `master` is buildable makes the ordering below a requirement rather than a
presentational choice.

1.  1. **The vendor table.** `@vn/types` holds `VENDORS`, `vendorOf`, `imageVendorOf`, and
       `systemRoleFor`. `chatVendorFor` becomes a thin delegate, both copies of the
       duplicate rule in `apps/authoring/src/agent.ts` are deleted, and `advice.ts` calls
       `supportsEffort` instead of `NO_KNOB`. This step adds no new vendor and is a pure
       refactor. The existing suite proves it, together with a table test that asserts
       every id in `TEXT_MODELS` resolves and that an unknown id resolves to `undefined`.
2.  2. **Keys widen.** `ResolvedKeys` widens to `Record<Vendor, string>`, `SECRET_FILES`
       widens with it, `projectConfig.keys` carries five defaulted fields, and
       `resolveKeys` becomes a loop. Nothing resolves a new key to anything yet. The
       config tests verify this, along with a CDP check that `project.setKey`'s dialog now
       lists five.
3.  3. **The neutral block vocabulary.** The vocabulary is `ChatBlock`,
       `ChatTurn.content`, and `ChatConvoReply.raw`. `turnOf` stops writing Anthropic wire
       shapes, the Anthropic backend translates both directions, and cross-vendor `opaque`
       blocks are dropped with a note. Behaviour is identical for Anthropic, which
       `convo-request.test.ts` proves by asserting the same request bytes.
4.  4. **OpenAI chat.** `backends/openai.ts` implements all four methods over the
       Responses API, with an injectable client mirroring `GeminiClient` so jest can
       supply a fake SDK. Adds usage mapping, the `effortChoicesFor` openai branch,
       `TEXT_MODELS` rows, and `openai` to `packages/providers/package.json` and to
       `EXTERNAL` in `scripts/aliases.mjs`.
5.  5. **xAI chat.** `backends/xai.ts` is a thin wrapper over the OpenAI backend with
       `baseURL: 'https://api.x.ai/v1'`. It differs in its effort ladder (no `none`), the
       `x-grok-conv-id` header, and exponential backoff without a hint, because no
       `retry-after` is documented.
6.  6. **Gemini `chatConversation`.** Appends `contents`, synthesises call ids,
       down-renders system turns, and ignores `cache`. Moves Gemini onto the native agent
       path through the existing probe.
7.  7. **The image seam.** `refGuard` is extracted and called from every backend.
       `createProviders` dispatches on `imageVendorOf`. The four `require: ['gemini']`
       sites are fixed. `sizeFor(aspect)` is added, and the aspect is sent to Gemini.
8.  8. **OpenAI images.** `backends/openai-image.ts` refuses a seed and caps references at
       four.
9.  9. **FLUX.2.** `backends/flux.ts` holds the poll loop, the ten-minute download,
       `disable_pup`, and the seed, and populates `ImageResult.seed`.
10. 10. **Docs.** The provider-seam line in CLAUDE.md, docs/vnauthor.md, docs/packages.md,
        the key names in docs/cli.md, and this page moved to As-shipped in
        docs/plans/index.md.

Stages 1–3 are worth landing even if the rest is deferred. They delete three copies of a
rule, close the silent-wrong-key hole, and fix the cross-vendor transcript bug that
already exists.

## What cannot be tested without a key, and what stands in

The jest suite runs offline by construction, so five stages have a component no automated
test can reach.

| Stage                 | Needs a real key for                                                  | Stands in                                                                                                    |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 4 OpenAI chat         | an actual cache read; the reasoning-item round trip; a real tool call | injected fake client asserting exact request shape; a new OpenAI branch in `scripts/verify-prompt-cache.mjs` |
| 5 xAI chat            | 429 behaviour with no `retry-after`; `x-grok-conv-id` hit rate        | fake-client shape tests; a Grok branch in the verify script                                                  |
| 6 Gemini conversation | that implicit caching actually engages on an appended `contents`      | the existing five-call Gemini ritual in the verify script, now over a growing conversation                   |
| 8 OpenAI images       | that a 4-reference edit returns a usable frame                        | one recorded `AssetCache` fixture, recorded once by a human who chose to spend it, replayed free thereafter  |
| 9 FLUX.2              | the async poll, the signed URL, seed reproducibility                  | same, plus a fake HTTP client exercising the poll loop's timeout as a terminal error                         |

The live half belongs in `scripts/verify-prompt-cache.mjs`. That script already runs
manually, bills for its calls, and stays deliberately out of CI. It already esbuilds a CJS
entry re-exporting `@vn/config`, `@vn/providers` and `@vn/authoring`, and it already
branches between the Claude two-step path and the Gemini five-call path. It gains two
branches and stays out of `package.json`'s scripts.

## Risks and open questions

- Every model id in this plan is dated 2026-08-18 and must be re-checked when the work
  starts. `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`, `grok-4.6` / `grok-4.5`,
  `gpt-image-2` and `flux-2-pro` are all current as of writing, and none of them are
  stable identifiers.
- **xAI publishes no official JS/TS SDK that could be found.** The documented route is the
  `openai` npm package with an overridden `baseURL`, which couples Grok support to
  OpenAI's SDK version and to OpenAI's request shape. If xAI diverges from that shape, the
  integration breaks with no obvious signal. This is the weakest structural assumption in
  the plan.
- **`store: false` on OpenAI, and whether it interacts with automatic prompt caching.** A
  vendor must not retain the author's fiction (the same rule `adviseModel` already states
  for Fable and Mythos), so `store: false` is the intended setting, and it makes reasoning
  items arrive as `encrypted_content` that must be echoed back. Whether prompt caching
  still engages with `store: false` is the most important open question in stage 4,
  because the answer decides whether OpenAI is viable as an agent model at all.
- A mid-turn model switch across vendors now drops reasoning state rather than corrupting
  the request. Dropping the state is strictly better than today's behavior, but it means
  `apierror.ts`'s `{do:'switch'}` should probably warn when the target is a different
  vendor, and it is worth deciding whether a cross-vendor switch should be offered at all.
- **The four-reference ceiling versus what `refsOfSlot` produces.** The gap is
  unquantified. If real shots routinely exceed four references, OpenAI images are a
  portrait-and-plate backend rather than a shot backend, and the docs should say so rather
  than let an author discover it.
- Adding two more vendors' vocabulary to the shared regex in `TRANSIENT_TEXT` lets one
  vendor's phrasing classify another vendor's terminal error as transient. Consider making
  the classifier per-backend rather than using one regex.
- **Bundle size** — `packages/providers/package.json` and `EXTERNAL` list `openai`
  alongside `@anthropic-ai/sdk` and `@google/genai`. It is imported lazily like the
  others, so the renderer does not change, but the external list in `esbuild.desktop.mjs`
  grows and the desktop package gets larger.
- **Error attribution.** `ProviderError` messages are prefixed per backend today
  (`Claude request failed`, `Gemini request failed`). Keep that and prefix the new
  backends with their vendor name, or an author with four keys configured cannot tell
  which one is broken.

## Needs verification before implementation

Everything below was researched on 2026-08-18 and could not be confirmed from primary
documentation. None of it blocks writing the plan, but all of it blocks writing the code.

| Claim                                                                                                            | Why it is uncertain                                                               |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A `{role:'developer'}` message is accepted mid-`input` on OpenAI, not only at the head                           | the guide shows it leading; mid-array placement is undocumented                   |
| `{role:'system'}` mid-array on xAI's Responses surface                                                           | documented for Chat Completions only                                              |
| Whether `store: false` disables automatic prompt caching on OpenAI                                               | the two features are documented independently                                     |
| Whether OpenAI reports any cache-_write_ count                                                                   | none found; the 1.25× surcharge on GPT-5.6+ is documented but the quantity is not |
| OpenAI images multi-reference field name — `image[]` (guide) vs `images: [{file_id, image_url}]` (API reference) | the two pages disagree                                                            |
| Whether `aspect_ratio` is accepted on FLUX.2 image endpoints, or only `width`/`height`                           | documented for some variants, not for `flux-2-pro`'s image endpoints              |
| BFL explicit pricing beyond `flux-2-pro` at $0.03/MP                                                             | other variants not confirmed                                                      |
| Gemini explicit-cache storage rates                                                                              | pricing page not confirmed                                                        |
| Whether Gemini's multi-turn `chats` helper participates in implicit caching                                      | not stated either way                                                             |
| Gemini's current thinking-budget surface, and whether it can be exposed as named rungs                           | not confirmed; the reason `effortChoicesFor` stays `[]` for Gemini                |
| xAI 429 response headers and error body                                                                          | none documented; the plan assumes `retry-after` is absent                         |
| Ideogram, Stability, Recraft and Luma multi-reference support                                                    | docs pages stale, 404'd, or unfetched                                             |

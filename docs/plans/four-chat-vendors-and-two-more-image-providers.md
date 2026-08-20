# Four chat vendors and two more image providers

**The provider seam is already the right shape; what is wrong is that three separate places
guess a vendor from a model id with a two-branch string test, and that the one package which
must stay vendor-neutral builds Anthropic wire blocks by hand.** This plan adds OpenAI and xAI
(Grok) as chat backends beside Anthropic and Gemini, and OpenAI Images and BFL FLUX.2 as image
backends beside Gemini's. It changes `ChatBackend` in exactly one way — what may travel inside a
turn — and it changes `ImageBackend` not at all. Everything else is a table replacing an `if`,
and a per-vendor translation living where the SDK import already lives.

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

Three separate plans have already tripped over the same wall.
[`provider-credentials-and-the-ai-usage-ledger.md`](provider-credentials-and-the-ai-usage-ledger.md)
names it outright in its step 9 — a third vendor "necessarily" needs a real routing table, because
`chatVendorFor`'s "anything not `claude` is Gemini" rule cannot survive one.
[`prompt-caching-and-deferred-tool-loading.md`](archive/prompt-caching-and-deferred-tool-loading.md) built
a four-breakpoint request builder that is Anthropic-only by construction and left Gemini on the
single-shot path.
[`gemini-estimated-cache-hit-rate.md`](archive/gemini-estimated-cache-hit-rate.md) had to invent
`cacheEstimated` because one vendor reports a matched prefix that it does not bill for.

Each of those was the right local call. Together they mean the repo now has one native
conversation path, one vendor's block vocabulary embedded in a neutral package, and a key
resolver with two hand-written branches. Adding a vendor is currently a diff across nine files,
most of which have no business knowing what a vendor is.

## Where the vendor leaks through today

Enumerated so the plan's stages can be checked against it. Each of these is a place that
compiles today only because there are exactly two vendors.

- **`chatVendorFor`** in `packages/providers/src/factory.ts` —
  `id.startsWith('claude') || id.startsWith('anthropic') ? 'anthropic' : 'gemini'`. The `else`
  branch is the bug: an unrecognised id silently routes to Google with Google's key.
- **Two more copies of that rule** in `apps/authoring/src/agent.ts`: a private `chatBackendFor`,
  and a third inline copy in `buildAgentBackend`
  (`modelId.toLowerCase().startsWith('claude') ? 'anthropic' : 'gemini'`).
- **`ResolvedKeys`** in `packages/config/src/keys.ts` is a fixed two-field interface, indexed as
  `keyof ResolvedKeys` in five files; `KEY_VENDORS`, `SECRET_FILES` and `secretFileFor` sit beside
  it, and `resolveKeys` resolves each vendor in a hand-written line with a hand-written `require`
  check.
- **`projectConfig.keys`** in `packages/types/src/schemas.ts` is a fixed two-key zod object.
- **`createProviders`** hardwires `createGeminiImage(keys.gemini, config.models.image)`, and
  **`require: ['gemini']`** is hardcoded at four call sites: `apps/cli/src/project.ts`,
  `apps/desktop/src/main/session.ts` (`buildProviders`), `packages/authoring/src/art.ts`
  (`imageOf`), `packages/testkit/src/record.ts` (`recordCorpus`).
- **`effortChoicesFor`** and **`supportsSystemRole`** in `packages/types/src/textmodels.ts` are
  Claude-family regexes that return `[]` / `false` for everything else — so a new vendor silently
  arrives with no reasoning knob and no system role, and nothing fails.
- **`apps/desktop/src/shared/advice.ts`** carries a _second, independent_ vendor inference in the
  browser-bundled layer: `SMALL = /haiku|flash/`, `FICTION = /fable|mythos/`, `NO_KNOB = /gemini/`,
  plus `familyName`'s hand-listed family words. `gpt-5.6-luna` and `grok-4.6` fall through all of
  them.
- **`TRANSIENT_TEXT`** in `packages/providers/src/backends/transient.ts` carries Gemini's gRPC
  status names in a shared regex.
- **`turnOf`** in `packages/authoring/src/backend.ts` — the sharpest one — builds Anthropic wire
  blocks inside a vendor-neutral package:
  `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`. `ChatTurn.role: 'system'`
  is likewise an Anthropic notion, and `ChatConvoReply.raw: unknown[]` is vendor-native by
  definition — which makes the existing `{do:'switch'; model}` recovery in
  `packages/authoring/src/apierror.ts` a live hazard the moment a second native backend exists.
- **`imagePart`'s placeholder refusal** lives inside `backends/gemini.ts`. "Mock art is marked art
  the real backend refuses" becomes a Gemini-only rule the instant a second image backend lands.
- **`ImageParams.aspect` is hashed into the task identity and never sent** — `createGeminiImage`
  passes `seed` and nothing else.

## Decision 1: the seam keeps its shape, and a turn stops being Anthropic-shaped

`ChatBackend` keeps all five members. `message`, `messageWithUsage`, `chatWithTools`,
`chatConversation` and the `ChatRequest`/`ChatToolReply` types are all vendor-neutral already;
the only thing wrong with them is what is allowed to travel inside `ChatTurn.content` and come
back in `ChatConvoReply.raw`.

**Vendor routing becomes an ordered table in `@vn/types`, not a string test in `@vn/providers`.**
It has to live in `@vn/types` because `apps/desktop/src/shared/` is in the browser bundle and
cannot import a package that loads a vendor SDK — that is exactly why `textmodels.ts` is already
there, and why `advice.ts` re-derives the rule instead of importing it. The new surface:

```ts
export const VENDORS = ['anthropic', 'gemini', 'openai', 'xai', 'bfl'] as const;
export type Vendor = (typeof VENDORS)[number];

export function vendorOf(modelId: string): Vendor | undefined; // chat
export function imageVendorOf(modelId: string): Vendor | undefined; // image
```

Two functions, not one, because `gemini-2.5-flash-image` and `gemini-2.5-flash` are the same
vendor but `gpt-image-2` and `gpt-5.6-terra` are only the same vendor by accident of naming.
Both read one ordered `[RegExp, Vendor]` table, so a new family is a row.

**`undefined` is the answer for an unrecognised id, and callers refuse by name.** Today's `else`
branch silently spends the wrong key; with four vendors that is a support ticket that reads
"invalid API key" and means "you typed a model id we do not know". A `vendor:` prefix
(`openai:gpt-5.6-terra`) is accepted as an escape hatch for a self-hosted or renamed endpoint —
but note that `ImageParams.modelId` is hashed into the asset request key, so adding a prefix to
an image model id already in use **re-keys every image task**. Recommend the prefix only where
inference genuinely fails.

**`ChatTurn.content` and `ChatConvoReply.raw` get a neutral block vocabulary**, declared in
`packages/providers/src/backend.ts`:

```ts
export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; id: string; name: string; args: unknown }
  | { kind: 'toolResult'; id: string; content: string }
  | { kind: 'opaque'; vendor: Vendor; block: unknown };
```

`text`, `toolCall` and `toolResult` are the three things every vendor has and the three things
`@vn/authoring` actually constructs. `opaque` is everything else — Anthropic `thinking` and
`redacted_thinking` blocks, OpenAI `reasoning` items with their `encrypted_content`, anything a
future vendor requires be echoed verbatim. It is tagged with the vendor that emitted it, and
**a backend drops an `opaque` block tagged with a different vendor and says so in the turn's
`working` note.** That is not a nicety: `apierror.ts` already offers `{do:'switch'; model}` as a
recovery, and today a Claude→Gemini switch hands Gemini a transcript full of Anthropic blocks.
Dropping a reasoning block is the only correct thing to do with one, and the loop must be able
to see that it happened.

This deletes `turnOf`'s hand-built `tool_result` and moves the translation into
`backends/anthropic.ts`, where the SDK import already is. `convo-request.test.ts` should assert
the same request bytes before and after, which is what makes the change provably
behaviour-neutral for Anthropic.

## Decision 2: keys are a record, not a pair

`ResolvedKeys` becomes a mapped type over `VENDORS`:

```ts
export type ResolvedKeys = Record<Vendor, string>;
export const KEY_VENDORS = VENDORS;
```

Every existing `keyof ResolvedKeys` site keeps compiling — `session.ts`'s
`keyFile`/`previewKey`/`setKey`, `analystBackend` in `packages/agentreport/src/analyze.ts`,
`projectSetKey`'s `prop.oneOf(KEY_VENDORS, …)` — and the desktop key dialog grows from two
entries to five with no code change, because it was already built from the constant.

`SECRET_FILES` grows `openai: ['openai.txt']`, `xai: ['xai.txt', 'grok.txt']`,
`bfl: ['bfl.txt', 'flux.txt']`. `projectConfig.keys` in `packages/types/src/schemas.ts` grows to
five defaulted fields — `OPENAI_API_KEY`, `XAI_API_KEY`, `BFL_API_KEY` beside the two that exist —
and because each field carries its own zod default, **every existing `project.yaml` keeps parsing
unchanged**. That is the whole reason to widen the schema rather than replace it with a free
record.

`resolveKeys`'s two hand-written lines become a loop over `KEY_VENDORS`, and its `require` check
becomes an index instead of a ternary. **The error-message rule is unchanged and is the thing to
be careful about**: it names `${envName}` and `secretFileFor(vendor)`, never the value. The loop
must keep constructing the message from the vendor's own config entry, not from a shared template
that could accidentally interpolate the resolved string.

BFL authenticates with an `x-key` header rather than `Authorization: Bearer`, which changes
nothing here — a key is a string either way, and the header is the backend's business.

## Decision 3: caching, vendor by vendor

This is the part with no shared abstraction, and the plan's position is that **there should not be
one**. The four vendors disagree about the one thing that matters — what a cached prefix _is_ —
and a lowest-common-denominator adapter would cost exactly the caching the last plan was written
to obtain. What is shared is the discipline: build a byte-stable prefix, append rather than edit,
and never let turn-scoped truth reach into the system block.

**Anthropic — unchanged.** `buildConvoRequest`, `EPHEMERAL`, `MESSAGE_BREAKPOINTS = 2`, `markLast`,
`UNMARKABLE`, the tools breakpoint on the last non-deferred tool. Verified still current as of
2026-08-18: `ephemeral` remains the only cache type, with optional `ttl: "5m"` (default) or `"1h"`;
**four explicit breakpoints is the ceiling and automatic caching consumes one of them**, returning
400 if four are already set. Reads bill 0.1×; 5m writes 1.25×, 1h writes 2×. The minimum cacheable
prefix is model-dependent — 512 tokens on Opus 5 / Fable 5 / Mythos 5, up to 4,096 on Opus 4.6 and
Haiku 4.5 — and **below the minimum a prefix is silently uncached**, which is worth a note in the
verify script's output because it looks identical to a broken breakpoint.

**OpenAI — the markers become no-ops, and the prefix does all the work.** Caching is automatic
over a prefix of at least 1,024 tokens and any change to that prefix invalidates it.
`ChatTurn.cache` is therefore _ignored_ by the OpenAI backend, which is already what the field's
doc comment permits ("the backend maps it to the vendor's marker, or ignores it"). What the
backend must guarantee instead is byte-stability: `instructions` (or the leading developer
message) and the `tools` array identical across every turn, and `input` growing only by appending.
The `NativeAgentBackend` loop already does that. Two additions: set **`prompt_cache_key`** to a
per-conversation id so requests route to the same cache, and set `prompt_cache_retention` where
the longer window is wanted. This requires a conversation identity to reach the backend, so
`ChatConvoRequest` grows an optional `conversationId?: string` that `NativeAgentBackend` mints
once per instance. Anthropic ignores it; Gemini ignores it; xAI maps it to a header.

**The `{"role":"system"}` append trick becomes three things.** It exists so that turn-scoped truth
— the current mode, a superseded `composeSystem` section — can be stated without editing the
cached prefix. Per vendor:

- Anthropic: a `{role:'system'}` turn mid-`messages`, as today.
- OpenAI: a `{role:'developer'}` message appended to `input`. Developer messages are ordinary
  input items, so no predicate is needed. _(Whether a developer message is accepted mid-array
  rather than only at the head is UNVERIFIED — see the verification table.)_
- xAI: OpenAI-compatible, so the same shape; `{role:'system'}` mid-array is the documented
  Chat Completions behaviour. _(UNVERIFIED on the Responses surface.)_
- **Gemini has no such notion at all**, and that is the interesting case. `systemInstruction` is a
  single field ahead of `contents`, so editing it invalidates everything downstream of it. The
  answer is the down-render that `messagesOf` already implements for a Claude model without the
  role: the turn becomes a user turn prefixed `SYSTEM (out-of-band):`. **So `supportsSystemRole`
  stops being a Claude-model predicate and becomes
  `systemRoleFor(modelId): 'system' | 'developer' | 'none'`**, and the down-render path stops being
  a legacy branch and becomes Gemini's normal operation.

**Gemini — implicit caching, and `chatConversation` finally implemented.** Implicit caching is on
by default for 2.5+ with a 2,048-token minimum (4,096 on 3.x). The reason Gemini currently gets
poor cache behaviour is not the absence of markers; it is that Gemini has no `chatConversation`,
so every turn re-renders the whole transcript through `chatWithTools` and the host keeps it on the
Structured path. Implementing `chatConversation` for Gemini as an appended `contents` array — with
`cache` ignored and system turns down-rendered — moves Gemini onto the native path and lets the
implicit cache do its job. That is a real win for one afternoon's work and it is why this is a
stage rather than a footnote.

Explicit `cachedContents` is deliberately **not** done; see decision 8.

**xAI — automatic prefix caching, one header.** Reported at `…_tokens_details.cached_tokens`; no
documented TTL and **no documented cache-write surcharge**. The documented way to maximise hit
rate is the `x-grok-conv-id` request header, which is where `conversationId` lands.

## Decision 4: tool calling, vendor by vendor

The registry (`ToolSchema {name, description, parameters, defer?}`) needs no change. What differs
is the wire shape, and every difference is absorbed inside a backend.

|           | declaration                                                       | call comes back as                                                              | result goes back as                                       | parallel                      |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| Anthropic | `tools[].input_schema`                                            | `tool_use` block, `input` an **object**                                         | `tool_result` block in a user turn                        | default on                    |
| OpenAI    | flat `{type:'function', name, description, parameters, strict}`   | top-level item `{type:'function_call', call_id, name, arguments}`, a **string**  | top-level item `{type:'function_call_output', call_id, output}` | `parallel_tool_calls`, default on |
| xAI       | as OpenAI                                                         | as OpenAI                                                                       | as OpenAI                                                 | as OpenAI                     |
| Gemini    | `functionDeclarations`                                            | `functionCall` part, **no id**                                                  | `functionResponse` part                                   | multiple parts                |

Three consequences worth naming.

**`arguments` is a string on OpenAI and xAI and an object on Anthropic.** The backend parses it and
a parse failure is a `ProviderError` naming the tool, not a crash in the loop. The loop's
`ToolCall.args` stays `unknown`.

**Gemini's `functionCall` has no id.** Pairing N parallel calls to N results without ids has to be
positional or by name, and both are fragile when a model calls the same tool twice. The Gemini
backend **synthesises ids on the way out (`call_${i}`) and strips them on the way in**, so
`AgentAction.id` and `turnOf`'s pairing contract hold everywhere and only the backend knows they
are synthetic.

**`defer` is Anthropic-only.** `defer_loading` and the server-side `tool_search_tool_bm25` tool
have no counterpart on the other three, so `SEARCH_TOOL` is not sent and the whole catalog goes in
the request — which is what `ToolSchema.defer`'s doc comment already says happens when a backend
ignores the flag. Be honest about the cost: at ~40 tools that is a materially larger prefix and a
materially harder selection problem, and it is a real reason to keep Claude the default agent
model.

**`LOOSE_PARAMS` blocks OpenAI's `strict` mode.** `{type:'object', additionalProperties: true}`
cannot be `strict: true`, which requires a complete schema with `additionalProperties: false`.
Send `strict: false` rather than fabricate schemas. Deriving real JSON Schema from `Tool.args` is
already flagged as a workstream of its own in the caching plan; it would unlock `strict` and
improve tool search at the same time, and it is out of scope here.

## Decision 5: the effort ladder is per vendor, and the stored word never changes meaning

`EFFORT_CHOICES` — the ordered tuple `resolveEffort` and `stronger` index into — **does not
change**. That is the decision. OpenAI's ladder includes `minimal`, which sits between `none` and
`low`; adding it would shift every index and silently re-interpret every effort choice already
stored in a project. Instead the tuple stays the _surface's_ ladder, and the backend's `tuning()`
maps it to the wire word — OpenAI's `minimal` is reachable only as the mapping of `low` on models
that offer it. A table says what a surface offers; a backend says what the wire calls it.

`effortChoicesFor` becomes vendor-dispatched via `vendorOf`:

- **anthropic** — today's table, unchanged.
- **openai** — the full ladder, minus `minimal` per the above. _(`reasoning.effort` accepts
  `none | minimal | low | medium | high | xhigh | max`, model-dependent; `gpt-5.6-terra` lists no
  `minimal`.)_
- **xai** — `low | medium | high | xhigh`, and **no `none`: reasoning cannot be disabled on Grok**.
  `grok-4.5` treats `xhigh` as `high`, which `resolveEffort`'s step-down already models.
- **gemini** — stays `[]`. Gemini's thinking budget is a token count rather than a named rung and
  its current surface is UNVERIFIED; wiring it is explicitly not in this plan.

**`supportsEffort` keeps its signature and its meaning** — "does this model honour a reasoning
setting at all" — and its answer becomes `true` for OpenAI and Grok models. That is what makes it
the right thing for `advice.ts` to call: `NO_KNOB = /gemini/` must become
`!supportsEffort(modelId)`, which `adviseEffort` already does at its head while `adviseModel`
re-derives it. `SMALL` needs `mini` added; `familyName` needs OpenAI and Grok rows or it prints
raw ids mid-sentence.

`TEXT_MODELS` grows from six entries to roughly ten, ordered by vendor. Keep the menu flat —
grouping it means a path.ux submenu change in two renderers for a list that is still short.

Note one incompatibility that will bite: **on Grok, `presencePenalty`, `frequencyPenalty` and
`stop` are incompatible with reasoning models.** Nothing in this repo sets them today; the backend
must not start.

## Decision 6: four shapes of receipt, one rule about absence

`TokenUsage {input, output, cacheRead?, cacheWrite?, cacheEstimated?}` needs no new fields, and
`charge(u) = u.input - (u.cacheRead ?? 0) + u.output` in `packages/types/src/budget.ts` is correct
for all four vendors without modification. What changes is `usageOf` in each backend, and there is
one trap in each direction.

**Anthropic's `input_tokens` excludes cached tokens**, so `usageOf` adds `cache_read_input_tokens`
and `cache_creation_input_tokens` into `input` and reports them beside it — as it does today.
Newer responses also carry `cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
which is finer detail than `cacheWrite` needs; sum it if `cache_creation_input_tokens` is absent.

**OpenAI's `input_tokens` already includes cached tokens.**
`usage.input_tokens_details.cached_tokens` (Responses) or `usage.prompt_tokens_details.cached_tokens`
(Chat Completions) maps straight to `cacheRead` and **must not be added to `input`**. Getting this
backwards inflates every charge by the size of the cache hit, which is precisely the number the
caching work exists to make large.

**Reasoning tokens go the other way, and this is the mirror trap.** Gemini's
`candidatesTokenCount` _excludes_ `thoughtsTokenCount`, so the Gemini backend adds them —
correctly. OpenAI's `output_tokens` _includes_ `output_tokens_details.reasoning_tokens`, so the
OpenAI backend must **not**. One vendor's field is a subset and the other's is a sibling, and the
two look identical in a diff.

**`cacheWrite` stays absent on OpenAI and xAI.** Neither reports a cache-creation count. This
matters because GPT-5.6 and later **do charge 1.25× for cache writes** where earlier OpenAI models
charged nothing — so there is a real cost with no reported quantity. Absent is the honest answer:
the contract is that a missing field means the vendor said nothing, never zero. A whole missing
`usage` block returns `undefined`, not `{input: 0, output: 0}` — "no receipt means no total, never
`0`" is a rule about the ledger's truthfulness and it holds for all four.

**`cacheEstimated` stays a Gemini-only flag.** It exists because Gemini reports a matched prefix it
does not bill for. OpenAI's and xAI's `cached_tokens` are billing lines, so they are reported
plainly and the flag is not set.

## Decision 7: image providers — OpenAI, and FLUX.2 for the seed

The pipeline's whole model-sheet → plate → shot chain rests on **edit-with-references**: a shot is
generated from a plate plus the character sheets `refsOfSlot` names. A provider that cannot take
multiple reference images is not a candidate at all, whatever its pictures look like. That single
requirement decides the shortlist.

**OpenAI Images — `gpt-image-2`**, via `POST /v1/images/generations` and `/v1/images/edits`.
Multi-reference editing is supported, **up to 4 references**. Output is `b64_json`; URL responses
are not offered for the gpt-image family. Sizes are 1024×1024, 1536×1024, 1024×1536, plus 2K/4K up
to 3840×2160 with both edges multiples of 16 and aspect ≤ 3:1.

**`gpt-image-2` has no `seed` parameter, and the backend must refuse a seeded request rather than
ignore it.** This is the decision most likely to be argued with, so here is the argument.
`seedFor`'s narrowest-rung-wins chain exists so an author can say "the same words, a different
picture", and zero is a real seed — every test in the repo is `=== undefined` for exactly that
reason. `ImageParams.seed` is hashed into the asset request key. If the backend silently drops it,
a re-render that changed nothing looks like it changed something, the cache key promises a
reproducibility the vendor cannot deliver, and the author has no way to learn any of that. Refuse
by name instead: _"gpt-image-2 has no seed parameter; clear the seed on `<rung>` or choose an image
model that has one."_ A refusal an author can act on beats a silent lie.

**Aspect finally gets sent.** `ImageParams.aspect` is in the task hash today and reaches no model —
`createGeminiImage` sends `seed` and nothing else. Add `sizeFor(aspect)` mapping `16:9` →
1536×1024, `1:1` → 1024×1024, `9:16` → 1024×1536, refusing an aspect with no mapping, and **also
start sending aspect on Gemini**. Note the consequence honestly: this changes what Gemini draws,
but it changes no hash, because aspect was always in `params`. So existing frames keep their
identity and a re-render produces the picture the config always asked for.

**The 4-reference ceiling is a real constraint on shots.** A shot carrying a plate plus three
character sheets is exactly at the cap. Over the cap the backend refuses by name rather than
truncating, because truncating drops a character out of frame and nothing downstream would notice.
Counting what `refsOfSlot` actually produces on a real project is a prerequisite before OpenAI
images can be recommended for shots at all.

**The second provider is BFL FLUX.2 (`flux-2-pro`), and the justification is the seed.** It is the
only shortlisted vendor with both documented multi-reference editing — **up to 8 references** on
`flux-2-pro`, four on the klein variants — and a documented integer **`seed`**. Those are the two
things this pipeline is built on, and OpenAI supplies only the first. Base is
`https://api.bfl.ai/v1`, auth is an **`x-key` header**, and one per-variant endpoint does both
generate and edit, which maps cleanly onto `ImageBackend`'s two methods over one call.

Four FLUX specifics that are the backend's problem and must not leak upward:

- **It is async.** POST returns `{id, polling_url}`; poll roughly once a second until
  `status: "Ready"`. `callWithRetry` wraps the submit; the poll gets its own bounded loop with its
  own deadline, and a poll that never becomes `Ready` is a **terminal** `ProviderError`, not a
  retry.
- **The result URL is signed and valid for ten minutes.** Download it inside `generate`/`edit` and
  return bytes, as every other backend does. This is the whole reason the async-ness must stay
  inside.
- **References are flat numbered fields** — `input_image`, `input_image_2` … `input_image_8` — not
  an array. URL or base64, ≤ 20 MB and ≤ 20 MP each.
- **`disable_pup: true`.** Prompt upsampling rewrites the prompt before generation, which would
  defeat both the seed and the content-addressed cache. Turn it off.

`flux-2-pro` takes `width`/`height` rather than an aspect ratio, so `sizeFor` serves it too.
`ImageResult.seed` — declared and never populated anywhere today — finally gets set here.

**`isPlaceholderImage` moves out of `backends/gemini.ts`.** The rule "mock art is marked art the
real backend refuses" is currently enforced in one backend's `imagePart`. Extract a shared
`refGuard(img)` into `packages/providers/src/image.ts` and call it from every image backend, and
grow the existing check in `providers.test.ts` into a loop over the backends. Otherwise a testkit
placeholder reaches a real vendor and gets billed for.

`createProviders` dispatches on `imageVendorOf(config.models.image)`, and the four hardcoded
`require: ['gemini']` sites become `require: [imageVendorOf(config.models.image)]`.
`AssetCache.requestKey` hashes `params`, which carries `modelId`, so **a recorded corpus can never
replay across vendors** — the record/replay fixtures need no versioning change.

## Decision 8: what this deliberately does not do

- **Gemini explicit `cachedContents`.** It needs create/reference/delete lifecycle management, has
  a 2,048–4,096 token floor, bills creation at standard input price _plus_ a TTL-based storage
  charge, and the newer Interactions API is implicit-only. Implicit caching plus a real
  `chatConversation` gets most of the benefit with none of the bookkeeping, and there is nowhere
  in the agent loop to hang a cache's lifetime.
- **Streaming.** Nothing in this repo streams. Four streaming implementations to make a `working`
  label more granular is not the trade.
- **OpenAI `previous_response_id` / server-side conversation state.** It moves the transcript to
  the vendor, and the transcript is the artifact the durable thread and `report.agent` read. xAI's
  own docs additionally warn against server-side history with images.
- **The Responses `image_generation` tool.** That is the chat path drawing pictures. The pipeline's
  image seam is not a chat, and routing it through one would put image identity inside a
  transcript.
- **Ideogram, Stability, Recraft, Luma, Midjourney.** Midjourney was already ruled out in the
  credentials plan. Ideogram documents no reference-image parameters. The rest are UNVERIFIED on
  multi-reference editing, which is the requirement that decides everything.
- **A router / adapter layer (LiteLLM-shaped).** The four vendors' one genuine disagreement is what
  a cached prefix is; a lowest-common-denominator adapter would erase exactly that.
- **Pricing, dollars, and the usage ledger.** Owned by
  [`provider-credentials-and-the-ai-usage-ledger.md`](provider-credentials-and-the-ai-usage-ledger.md).
  This plan reports tokens; it must not grow a price table.
- **Vertex / Bedrock / Azure routing.** Same plan.
- **Real JSON Schema from `Tool.args` (and therefore OpenAI `strict`).** A workstream of its own.

## Staging

Each stage lands green under `pnpm check`, `pnpm test` and `pnpm lint` — the repo rule that every
commit on `master` is buildable makes the ordering below load-bearing rather than cosmetic.

1. **The vendor table.** `VENDORS`, `vendorOf`, `imageVendorOf`, `systemRoleFor` in `@vn/types`;
   `chatVendorFor` becomes a thin delegate; the duplicate rule in `apps/authoring/src/agent.ts`
   (both copies) is deleted; `advice.ts` calls `supportsEffort` instead of `NO_KNOB`. No new vendor
   yet — a pure refactor, provable by the existing suite plus a table test that asserts every id in
   `TEXT_MODELS` resolves and an unknown id resolves to `undefined`.
2. **Keys widen.** `ResolvedKeys` → `Record<Vendor, string>`, `SECRET_FILES`, `projectConfig.keys`
   with five defaulted fields, `resolveKeys` as a loop. Nothing resolves a new key to anything yet.
   Verified by the config tests plus a CDP check that `project.setKey`'s dialog now lists five.
3. **The neutral block vocabulary.** `ChatBlock`, `ChatTurn.content`, `ChatConvoReply.raw`;
   `turnOf` stops writing Anthropic wire shapes; the Anthropic backend translates both directions;
   cross-vendor `opaque` blocks are dropped with a note. Behaviour-identical for Anthropic, proved
   by `convo-request.test.ts` asserting the same request bytes.
4. **OpenAI chat.** `backends/openai.ts` implementing all four methods over the Responses API, with
   an injectable client seam mirroring `GeminiClient` so jest can stand up a fake SDK. Usage
   mapping, the `effortChoicesFor` openai branch, `TEXT_MODELS` rows, `openai` added to
   `packages/providers/package.json` and to `EXTERNAL` in `scripts/aliases.mjs`.
5. **xAI chat.** `backends/xai.ts` as a thin construction over the OpenAI backend with
   `baseURL: 'https://api.x.ai/v1'`, differing in its effort ladder (no `none`), the
   `x-grok-conv-id` header, and blind exponential backoff because no `retry-after` is documented.
6. **Gemini `chatConversation`.** Appended `contents`, synthesised call ids, system turns
   down-rendered, `cache` ignored. Moves Gemini onto the native agent path via the existing probe.
7. **The image seam.** `refGuard` extracted and called from every backend; `createProviders`
   dispatching on `imageVendorOf`; the four `require: ['gemini']` sites fixed; `sizeFor(aspect)`
   added and aspect actually sent to Gemini.
8. **OpenAI images.** `backends/openai-image.ts` with the seed refusal and the four-reference cap.
9. **FLUX.2.** `backends/flux.ts` with the poll loop, the ten-minute download, `disable_pup`, the
   seed, and `ImageResult.seed` populated.
10. **Docs.** The `CLAUDE.md` provider-seam line, `docs/vnauthor.md`, `docs/packages.md`,
    `docs/cli.md`'s key names, and this page moved to As-shipped in `docs/plans/index.md`.

Stages 1–3 are worth landing even if the rest is deferred: they delete three copies of a rule,
close the silent-wrong-key hole, and fix the cross-vendor transcript bug that already exists.

## What cannot be tested without a key, and what stands in

The jest suite is offline by construction, so five stages have a component no automated test can
reach.

| Stage                 | Needs a real key for                                                        | Stands in                                                                                                             |
| --------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 4 OpenAI chat         | an actual cache read; the reasoning-item round trip; a real tool call        | injected fake client asserting exact request shape; a new OpenAI branch in `scripts/verify-prompt-cache.mjs`           |
| 5 xAI chat            | 429 behaviour with no `retry-after`; `x-grok-conv-id` hit rate               | fake-client shape tests; a Grok branch in the verify script                                                           |
| 6 Gemini conversation | that implicit caching actually engages on an appended `contents`             | the existing five-call Gemini ritual in the verify script, now over a growing conversation                            |
| 8 OpenAI images       | that a 4-reference edit returns a usable frame                              | one recorded `AssetCache` fixture, recorded once by a human who chose to spend it, replayed free thereafter           |
| 9 FLUX.2              | the async poll, the signed URL, seed reproducibility                        | same, plus a fake HTTP client exercising the poll loop's timeout as a terminal error                                  |

`scripts/verify-prompt-cache.mjs` is the right home for the live half — it is already the manual,
billed, deliberately-out-of-CI ritual, already esbuilds a CJS entry re-exporting `@vn/config`,
`@vn/providers` and `@vn/authoring`, and already branches Claude-two-step vs Gemini-five-call. It
gains two branches and stays out of `package.json`'s scripts.

## Risks and open questions

- **Every model id in this plan is dated 2026-08-18** and must be re-checked when the work starts.
  `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`, `grok-4.6` / `grok-4.5`, `gpt-image-2` and
  `flux-2-pro` are all current as of writing and none of them are stable identifiers.
- **xAI publishes no official JS/TS SDK that could be found.** The documented route is the `openai`
  npm package with an overridden `baseURL`, which couples Grok support to OpenAI's SDK version and
  to OpenAI's request shape. If xAI diverges, that seam breaks quietly. This is the weakest
  structural assumption in the plan.
- **`store: false` on OpenAI, and whether it interacts with automatic prompt caching.** The
  author's fiction must not be retained by a vendor — the same rule `adviseModel` already states
  for Fable and Mythos — so `store: false` is the intended setting, and it makes reasoning items
  arrive as `encrypted_content` that must be echoed back. Whether prompt caching still engages with
  `store: false` is the single most load-bearing unknown in stage 4, because the answer decides
  whether OpenAI is viable as an agent model at all.
- **A mid-turn model switch across vendors** now drops reasoning state rather than corrupting the
  request. That is strictly better than today, but it means `apierror.ts`'s `{do:'switch'}` should
  probably _warn_ when the target is a different vendor, and it is worth deciding whether a
  cross-vendor switch should be offered at all.
- **The four-reference ceiling versus what `refsOfSlot` produces.** Unquantified. If real shots
  routinely exceed four references, OpenAI images are a portrait-and-plate backend, not a shot
  backend, and the docs should say so rather than let an author discover it.
- **`TRANSIENT_TEXT`'s shared regex** grows two more vendors' vocabulary and becomes a place where
  one vendor's phrasing accidentally classifies another vendor's terminal error as transient.
  Consider making the classifier per-backend rather than one regex.
- **Bundle size** — `openai` joins `@anthropic-ai/sdk` and `@google/genai` in
  `packages/providers/package.json` and in `EXTERNAL`. It is lazily imported like the others, so
  the renderer is untouched, but `esbuild.desktop.mjs`'s external list grows and the desktop
  package gets larger.
- **Error attribution.** `ProviderError` messages are prefixed per backend today
  (`Claude request failed`, `Gemini request failed`). Keep that and make the new backends say their
  vendor, or an author with four keys configured cannot tell which one is broken.

## Needs verification before implementation

Everything below was researched on 2026-08-18 and could not be confirmed from primary
documentation. None of it blocks writing the plan; all of it blocks writing the code.

| Claim                                                                                              | Why it is uncertain                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A `{role:'developer'}` message is accepted mid-`input` on OpenAI, not only at the head             | the guide shows it leading; mid-array placement is undocumented                        |
| `{role:'system'}` mid-array on xAI's Responses surface                                             | documented for Chat Completions only                                                   |
| Whether `store: false` disables automatic prompt caching on OpenAI                                 | the two features are documented independently                                          |
| Whether OpenAI reports any cache-_write_ count                                                     | none found; the 1.25× surcharge on GPT-5.6+ is documented but the quantity is not       |
| OpenAI images multi-reference field name — `image[]` (guide) vs `images: [{file_id, image_url}]` (API reference) | the two pages disagree                                                    |
| Whether `aspect_ratio` is accepted on FLUX.2 image endpoints, or only `width`/`height`             | documented for some variants, not for `flux-2-pro`'s image endpoints                   |
| BFL explicit pricing beyond `flux-2-pro` at $0.03/MP                                               | other variants not confirmed                                                           |
| Gemini explicit-cache storage rates                                                                | pricing page not confirmed                                                             |
| Whether Gemini's multi-turn `chats` helper participates in implicit caching                        | not stated either way                                                                  |
| Gemini's current thinking-budget surface, and whether it can be exposed as named rungs             | not confirmed; the reason `effortChoicesFor` stays `[]` for Gemini                     |
| xAI 429 response headers and error body                                                            | none documented; the plan assumes `retry-after` is absent                              |
| Ideogram, Stability, Recraft and Luma multi-reference support                                      | docs pages stale, 404'd, or unfetched                                                  |

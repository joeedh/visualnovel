# Local and self-hosted models

_This page collects external and internal research. It is not a plan and no code depends
on it. It asks whether this app can run against models the author hosts themselves (on the
same machine or on a box on their home network) for both text and image models, and it
says what reaching that would cost._

_Status: research. The half drawn from the repo can be checked against it, and stays
accurate until the seams move. The half that surveys runtimes, open-weight models and
local image models is a snapshot taken on 18 August 2026 and will go out of date quickly;
every figure in it is marked either sourced or estimated, and the ones marked estimated
are not measurements._

<!-- toc -->

- [The honest answer](#the-honest-answer)
- [What the app actually asks a model for](#what-the-app-actually-asks-a-model-for)
    - [There is exactly one chat seam, and it is small](#there-is-exactly-one-chat-seam-and-it-is-small)
    - [The agent's request is shaped for one vendor's cache](#the-agents-request-is-shaped-for-one-vendors-cache)
    - [The vendor is chosen by a string prefix, and the fallback is Gemini](#the-vendor-is-chosen-by-a-string-prefix-and-the-fallback-is-gemini)
    - [The image seam is where the vendor is not even a variable](#the-image-seam-is-where-the-vendor-is-not-even-a-variable)
    - [Mock, local, real](#mock-local-real)
- [The runtimes, surveyed](#the-runtimes-surveyed)
    - [The prefix cache exists everywhere, and the breakpoints are a no-op everywhere](#the-prefix-cache-exists-everywhere-and-the-breakpoints-are-a-no-op-everywhere)
    - [Cached-token reporting is the one thing that must be checked, and most servers fail it](#cached-token-reporting-is-the-one-thing-that-must-be-checked-and-most-servers-fail-it)
    - [`llama-server` is the recommendation, and it is not close](#llama-server-is-the-recommendation-and-it-is-not-close)
    - [Platform narrows the field harder than capability does](#platform-narrows-the-field-harder-than-capability-does)
    - [What overload and failure look like, which is not what this repo expects](#what-overload-and-failure-look-like-which-is-not-what-this-repo-expects)
- [The models, surveyed](#the-models-surveyed)
    - [The candidates](#the-candidates)
    - [The KV table is the headline](#the-kv-table-is-the-headline)
    - [What fits, with vision, at full context](#what-fits-with-vision-at-full-context)
    - [The failure mode is the tool parser, not the weights](#the-failure-mode-is-the-tool-parser-not-the-weights)
    - [The two small jobs](#the-two-small-jobs)
- [Local image models, surveyed](#local-image-models-surveyed)
    - [The models](#the-models)
    - [Reference images, which is the part this app actually needs](#reference-images-which-is-the-part-this-app-actually-needs)
    - [Driving one from a program](#driving-one-from-a-program)
    - [Speed, and the seed problem](#speed-and-the-seed-problem)
    - [The part nobody puts in a table](#the-part-nobody-puts-in-a-table)
- [A box on the home network](#a-box-on-the-home-network)
- [Cost, quality, speed, and the parts that are not money](#cost-quality-speed-and-the-parts-that-are-not-money)
    - [Money](#money)
    - [Quality](#quality)
    - [Speed](#speed)
    - [Privacy, and why this repo should care more than most](#privacy-and-why-this-repo-should-care-more-than-most)
    - [Offline](#offline)
    - [Reproducibility of a seed](#reproducibility-of-a-seed)
    - [Maintenance](#maintenance)
- [What I would do, in order](#what-i-would-do-in-order)
- [Open questions](#open-questions)

<!-- tocstop -->

## The honest answer

Today, none of it is possible. In principle, most of it is possible, and less painfully
than expected. In practice, start with one small job rather than with the agent or the
art.

Nothing in this repo can currently talk to a local model. Three facts explain that.
`chatVendorFor` picks a vendor by a string prefix on the model id and falls back to Gemini
with no "unknown" branch, so `models.text: qwen3.6-27b` raises no error and the request
goes to Google. `ResolvedKeys` is a two-field interface mapping a vendor to a secret, so
it has no field for a URL and it requires a secret that a LAN server does not need.
`createProviders` builds the image backend as `createGeminiImage(...)` unconditionally, so
every non-mock run requires a Gemini key regardless of what the other model ids say.
`grep -rn "localhost\|127.0.0.1\|http://" packages/providers/src packages/config/src`
returns nothing.

By contrast, the seam itself is in good shape, and in one respect in better shape than
expected:

- `ChatBackend` requires only a plain text-in/text-out call, and every structured result
  in the app is enforced after the fact by `extractJson`, zod, and `withStructuredRetry`,
  never by a schema sent to the vendor. A local model that cannot be constrained still
  qualifies, and gets three tries.
- **`chatConversation` is Anthropic-shaped, and an Anthropic-shaped `/v1/messages` is now
  close to standard for local servers** — `llama-server`, vLLM, SGLang, Ollama, LM Studio,
  LocalAI and others all ship one. The ecosystem has already done the part of the port
  that looks hardest.
- **The four `cache_control` breakpoints become no-ops** — no local runtime honours them,
  and all of them accept and drop the field. A local positional prefix cache still hits,
  because of the discipline those breakpoints forced, so nothing needs restructuring.
- **`ImageBackend`'s two methods already match the call shape open models accept.** `edit`
  is implemented today as `run([base, ...refs], ...)`, an in-context multi-reference edit,
  and several open-weight models accept exactly that.

Three things are hard. First, the budget arithmetic overcharges a server that caches
correctly but reports no cache hits: `charge()` is `input - cacheRead + output`, so a
runtime that caches perfectly but reports `cached_tokens: 0` (Ollama and LM Studio both
do) burns roughly 7k tokens of a 200k budget per step on a prefix it never reprocessed.
Second, every open image stack still fails on two named characters in one frame, each in a
specified outfit, across hundreds of shots. That is the app's central case, not an edge
case, so budget a 10–15% reject rate. Third, a local seed does not reproduce a result the
way a content-addressed task hash implies unless the stack fingerprint (model file, torch
version, attention backend, dtype, batch size) joins the inputs being hashed. That third
case is the only place where going local imposes a design change rather than a new file.

The recommendation that follows is in
[What I would do, in order](#what-i-would-do-in-order). Its first step is deliberately
unambitious and points the approval triage model at a local server. That step is one
`backend.message()` call with a three-field schema, it already has an offline fallback to
compare against, and getting it wrong costs a confirmation card the author was going to
read anyway.

## What the app actually asks a model for

Everything below is read off the code rather than assumed. Three seams matter, and they
differ in how hard they are to serve.

### There is exactly one chat seam, and it is small

`ChatBackend` (`packages/providers/src/backend.ts`) has one required method and three
optional ones:

| Member             | Required? | Who needs it                                                               |
| ------------------ | --------- | -------------------------------------------------------------------------- |
| `modelId`          | yes       | provenance — it is written into every asset's `AssetMeta.modelId`          |
| `message`          | yes       | `ChatTextLLM`, `ChatVisionReviewer`, `triageApprovals`, `describeAsset`    |
| `messageWithUsage` | no        | the token meter; absence means **no total**, which the app renders as such |
| `chatWithTools`    | no        | nothing, in practice — it is the single-shot native path Gemini implements |
| `chatConversation` | no        | `NativeAgentBackend`, and **it is the probe** that selects the cached path |

The required half is a plain text-in/text-out call with optional images. That is a very
low bar, and most of the app's model use needs nothing more: location mining, shot
decomposition, prompt refinement (`ChatTextLLM`), the P7 vision reviewers
(`ChatVisionReviewer`), the approval triage (`triageApprovals`), and `describeAsset`. Each
of those enforces its own shape after the fact rather than asking the model for it:
`withStructuredRetry` calls the model, runs `extractJson` over the raw text (which
tolerates code fences and surrounding prose), validates against a zod schema, and retries
up to three times. No code in `packages/providers` sends a JSON schema, a grammar, or a
`response_format`. So a local model that cannot be constrained is not disqualified; it
only has to produce output that passes the schema within three tries.

The optional half is the part that takes real work to implement in a local server.
`chatConversation` is the whole authoring agent, and its request shape is deliberately
Anthropic-specific.

### The agent's request is shaped for one vendor's cache

`buildConvoRequest` (`packages/providers/src/backends/convo-request.ts`) is the most
vendor-coupled function in the repo, and the coupling is deliberate
([`../plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading`](../plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading)):

- **Four `cache_control: {type: 'ephemeral'}` breakpoints** — the end of the tool catalog,
  the end of the system prompt, and a rolling pair over the transcript that
  `NativeAgentBackend` advances each step (`prevBreak`). Four is the vendor's maximum.
- **`defer_loading` plus a server-side `tool_search_tool_bm25_20251119` tool.** Of the 42
  tools advertised (39 in the registry, 3 control tools the loop owns), `ALWAYS_LOADED`
  keeps six in context and defers the rest for the model to search for.
- **`{"role": "system"}` messages inside `messages[]`** are gated by
  `supportsSystemRole(modelId)`, a regex over the model id, and are down-rendered to a
  `user` turn where the model refuses them. Filing mode changes and budget warnings
  through these messages avoids recomposing a cached prefix.
- **`raw` blocks are echoed verbatim.** `ChatConvoReply.raw` holds the assistant's content
  blocks exactly as received, because a thinking block can be echoed but not rebuilt.
- **`output_config.effort` and `thinking: {type: 'adaptive'}`** — `resolveEffort` supplies
  both.

None of that has an equivalent on an OpenAI-compatible endpoint. Some of it degrades
gracefully: `ChatTurn.cache` is documented as something a backend "maps to the vendor's
marker, or ignores", and `ToolSchema.defer` says "a backend without tool search ignores
it". The rest does not have to be ported at all, because a local backend is free to
implement `chatConversation` in whatever wire format it likes. The contract above the
backend interface is `ChatConvoRequest` → `ChatConvoReply`, not Anthropic's schema.

The cost comes from the arithmetic rather than the format. `charge()`
(packages/types/src/budget.ts) is `input - cacheRead + output`, and its doc comment states
the governing rule: a provider that reports no split spends its whole input. The agent's
stable prefix today is the 9,485-character `SYSTEM_PROMPT`, the project's `AICONTEXT.md`,
and a tool catalog the caching plan measured at 13,317 characters — roughly 6–7k tokens
before the transcript, re-sent on every step. Against the default `200k` budget, a local
server that returns `usage` without a cached-token count would burn roughly 7k tokens of
budget per step for tokens it did not actually reprocess, and a forty-step turn would hit
the ceiling having done very little. A server that returns no `usage` at all fails
differently: `spent` never moves, so the only thing that stops a runaway is
`MAX_ITERATIONS = 200`.

### The vendor is chosen by a string prefix, and the fallback is Gemini

```ts
// packages/providers/src/factory.ts
export function chatVendorFor(modelId: string): keyof ResolvedKeys {
    const id = modelId.toLowerCase();
    return id.startsWith("claude") || id.startsWith("anthropic") ? "anthropic" : "gemini";
}
```

There is no "unknown vendor" branch. Putting `qwen3-coder-30b` in `project.yaml`'s
`models.text` makes the app build a Gemini client for it and call Google.
`apps/authoring/src/agent.ts` carries a second, hand-copied version of the same rule (its
comment says so: "mirrors @vn/providers' private picker"), so the rule exists in two
places. `chatBackendFor` has six non-test callers; `ResolvedKeys`, `KEY_VENDORS` and
`resolveKeys` are referenced from ten non-test files.

`ResolvedKeys` is a two-field interface of non-optional strings (`gemini`, `anthropic`),
and `project.yaml`'s `keys:` block names two env vars. Both map a vendor to a secret. A
local endpoint has a URL and usually no secret at all, so it fits neither form in two
ways: the config has nowhere to put the URL, and a local server does not need the secret
the config is built to carry. `project.setKey` is deliberately not undoable and records
`<secret>` in the provenance journal. Neither behavior is wrong for a local endpoint, but
neither applies to it.

### The image seam is where the vendor is not even a variable

```ts
// packages/providers/src/factory.ts, createProviders
const image = new BackendImageProvider(
    createGeminiImage(keys.gemini, config.models.image),
    loadRef,
);
```

`config.models.image` names a model; the backend is `createGeminiImage`, unconditionally.
The text and vision models at least go through `chatBackendFor`. The image one does not,
which is why `buildProviders` in the desktop session and `loadProject` in the CLI both
call `resolveKeys` with `require: ['gemini']` for any non-mock run. A Gemini key is
currently mandatory for any real run of this app, whatever the other model ids say.

The task asked of that backend is the real constraint, and that task is not text-to-image:

```ts
// packages/providers/src/backend.ts
export interface ImageBackend {
    readonly modelId: string;
    generate(
        prompt: string,
        refs: ImageInput[],
        params: ImageParams,
    ): Promise<ImageResult>;
    edit(
        base: ImageInput,
        prompt: string,
        refs: ImageInput[],
        params: ImageParams,
    ): Promise<ImageResult>;
}
```

Both methods take a list of reference images, and `edit` takes a base image in addition.
The Gemini implementation is four lines long because the vendor's model accepts exactly
that shape: `generate` sends the refs as inline image parts, and `edit` sends
`[base, ...refs]`. Nothing is masked, no control image is derived, no adapter is loaded,
and no character LoRA exists. Consistency comes entirely from the images passed to the
model in the request.

The following chain rests on it, drawn from `refsOfSlot`
(`packages/artgen/src/refcycle.ts`) and `runners.ts`:

- A **portrait** is drawn from nothing. A **plate** is also drawn from nothing, except
  that a non-default time-of-day variant is derived from the default variant.
- The runner generates a **model sheet** by calling
  `image.edit(approved portrait, prompt, rest)`, taking `refs[0]` as the base explicitly,
  with the comment "model sheets are reference-guided edits of the approved portrait".
  Each item in a character's wardrobe is produced by editing the one approved face.
- A **shot** is `image.generate(prompt, refs)`, where `refs` is the location plate, one
  portrait per subject, a front-angle model sheet for any subject out of their default
  outfit, and whatever the author attached at that rung. Two to five reference images per
  frame is the normal case. Every frame in a scene re-derives its consistency from the
  same upstream pictures rather than from a trained identity.
- P7 then runs generate → critique → refine inside the shot runner, up to
  `config.max_refine_attempts` (default 4). Each attempt re-generates with a
  deterministically refined prompt and the same refs.

A local image backend would inherit two smaller facts. `ImageParams.aspect` is part of the
cache key and the task hash but is never sent to Gemini — `createGeminiImage` forwards
only `responseModalities` and `seed`. A local backend that honours width/height would
therefore be more faithful to the config than the current one, and would produce different
bytes for the same hash. That difference is a provenance question rather than a bug. The
mock-art guard (`isPlaceholderImage`, the `vn-mock-placeholder` `tEXt` chunk) lives inside
`gemini.ts`'s `imagePart` rather than in `BackendImageProvider`, so a new backend that
forgot to re-implement it would silently condition paid work on coloured rectangles.

### Mock, local, real

`--mock` swaps the whole `Providers` bundle (`createMockProviders`) at three call sites,
and it marks its art deliberately so that the art cannot be passed off as output from a
real run. A local provider is neither of these two, and it does not sit between them: like
`--mock` it needs no key and no network, and like a real run it produces genuine bytes
that downstream tasks may legitimately reference. `AssetCache` / `CachedImageBackend`
(`packages/providers/src/cache.ts`) is the closest existing precedent for "real bytes from
somewhere other than the vendor", and its `requestKey` already keys on `params.modelId`,
so recordings made against a local model could never be replayed for a cloud one.

## The runtimes, surveyed

An Anthropic-shaped `POST /v1/messages` is now close to standard on a local server, and
that is the most useful thing to know here. It was not true a year ago, and it changes the
work, because `chatConversation` (the hardest part of the seam and the most vendor-coupled
function in the repo) already speaks that dialect. Source or official docs confirmed it
present on 18 August 2026 in `llama-server` (plus `/v1/messages/count_tokens`), Ollama, LM
Studio 0.4.1, vLLM, SGLang, LocalAI, text-generation-webui, KoboldCpp, Lemonade and
llamafile. Servers added it for a prosaic reason: people wanted to point Claude Code at a
local model. `llama-server`'s README is honest about the level: _"While no strong claims
of compatibility with the Anthropic API spec are made, in our experience it suffices to
support many apps."_ OpenAI's Responses API is a third surface, and it is spreading too.

### The prefix cache exists everywhere, and the breakpoints are a no-op everywhere

No local runtime honours `cache_control`. vLLM's own test suite makes the behaviour
explicit: `tests/entrypoints/anthropic/test_anthropic_messages_conversion.py` asserts that
`cache_control` blocks are accepted and silently dropped. LocalAI's
`AnthropicContentBlock` has no such field; text-generation-webui's 468-line `anthropic.py`
never mentions the string; a code search across `ggml-org/llama.cpp` returns only HTTP
`Cache-Control` headers. Every local prefix cache instead uses automatic positional
longest-prefix matching, which is on by default and free.

The news for this repo is better than it sounds. The four Anthropic breakpoints force a
byte-stable prefix, append-never-edit, and mode changes filed as trailing
`{"role":"system"}` messages rather than spliced into a cached region, and a positional
prefix cache hits under exactly those constraints. The `EPHEMERAL` markers
`buildConvoRequest` sends would have no effect, and the prefix would still be reused. So
do not restructure anything. The one new obligation is to audit what gets injected near
the front of the prompt on each request. SGLang's own documentation tells users to set
`CLAUDE_CODE_ATTRIBUTION_HEADER=0` because Claude Code injects a per-request hash that
changes the prefix on every call and destroys caching through gateways. Jan independently
ships the same defence, stripping `x-anthropic-billing-header` from incoming requests with
the source comment "are dynamic, so leaving them in the content busts Anthropic prompt
caching". Two unrelated projects have shipped code specifically to protect their prefix
cache from bytes Anthropic's own client injects, which makes this an observed problem
rather than a theoretical one. A single varying byte near the front costs the whole cache.

The measured payoff is large enough to decide the question. A 60k-token prompt on Apple
silicon took 84.2 s cold and about 1.0 s when the identical prefix hit the slot cache.
That is an ~80× speedup, measured on this workload.

### Cached-token reporting is the one thing that must be checked, and most servers fail it

[`charge()`](#the-agents-request-is-shaped-for-one-vendors-cache) is
`input - cacheRead + output`, so a server that caches the request but does not report a
cache read charges this app's budget for work it never did.

| Runtime       | Prefix cache                       | Reports cached tokens           |
| ------------- | ---------------------------------- | ------------------------------- |
| **llama.cpp** | default on, deepest knobs anywhere | ✅ real                         |
| **vLLM**      | default on, block-hash             | ✅ read **and** created         |
| SGLang        | RadixAttention + HiCache           | ✅ (shape unverified)           |
| llamafile     | = llama.cpp                        | ✅                              |
| LocalAI       | on since v4.3                      | ❌ on the Anthropic path        |
| KoboldCpp     | FastForwarding                     | ❌ **hardcoded 0**              |
| **Ollama**    | inherited; trie on the MLX path    | ❌ **hardcoded 0**              |
| **LM Studio** | undocumented — no toggle, no claim | ❌ `prompt_tokens_details=None` |
| Jan / TGW     | presumed (llama.cpp underneath)    | unverified — **test it live**   |

Ollama is the worst case and is worth spelling out, because it is the runtime most people
try first: `openai/openai.go`'s `Usage` struct has no `prompt_tokens_details` at all, and
`openai/responses.go` emits a hardcoded `"input_tokens_details": {"cached_tokens": 0}`, so
a client reads "no cache hits" regardless of reality. Against a 200k budget, this app
would spend ~7k tokens of headroom per step on a prefix the server did not reprocess.

### `llama-server` is the recommendation, and it is not close

One runtime gives all four of the things this repo needs for a tool-heavy TypeScript agent
on the author's own hardware, and every other runtime misses at least one:

- **Tool calls cannot be malformed.** `common/chat.cpp` arms a "lazy" (deferred) grammar —
  `grammar_lazy = has_tools && tool_choice == AUTO` — so the model emits free-form prose
  until it begins a tool call, and the tool schema is enforced at sampling from that point
  on. `--jinja` is now default on. The handlers were rewritten in 2026: the format enum in
  `common/chat.h` is down to `CONTENT_ONLY`, `PEG_SIMPLE`, `PEG_NATIVE`, `PEG_GEMMA4`,
  `PEG_MINIMAX_M3`, and `chat-auto-parser.h` derives a parser by rendering the model's own
  Jinja template and diffing the output. ⚠️ `docs/function-calling.md` is stale and still
  describes the retired per-model handlers — cite `common/chat.h` and
  `tools/server/README.md` instead.
- **Guaranteed schema-valid JSON**, via built-in JSON-Schema→GBNF conversion exposed as
  `response_format: {type: 'json_schema'}`. Schemas with external `$ref`s need
  pre-converting.
- **Real `cached_tokens`** keeps the budget arithmetic correct.
- **A clean 400 on context overflow.** `--context-shift` is now disabled by default, so an
  over-long conversation returns `exceed_context_size_error` instead of silently dropping
  the head of the transcript. That is strictly better for an agent, which gets a
  machine-readable signal rather than a transcript truncated without notice.

It also binds `127.0.0.1` by default, accepts multiple `--api-key` values, runs natively
on Windows, and (new in 2026) offers a router mode. Launch it with no model and it loads,
unloads and forwards per request (`--models-dir`, `--models-max` default 4 with LRU
eviction, `--sleep-idle-seconds` to unload after idle and reload on demand).
`--sleep-idle-seconds` is directly relevant to
[the box being asleep](#a-box-on-the-home-network). CORS is wide open by default
(`--cors-origins *` with credentials enabled), and is worth changing deliberately.

**llamafile** is not dormant, contrary to common assumption. It moved to
`mozilla-ai/llamafile`, ships 0.10.5 (3 August 2026), and consists of ABI/packaging-only
patches over an upstream llama.cpp submodule, with three upstream syncs in a fortnight. It
packages a current `llama-server`, about a month behind master, in a single portable file.

The remaining servers warrant shorter notes. vLLM suits one box serving several agents at
once: continuous batching roughly triples decode over llama.cpp on the same hardware,
prefix caching is on by default, and its Anthropic shim reports both cache-read and
cache-created tokens. Its trap is that `tool_choice: 'auto'` extracts tool calls from
unconstrained text through a per-model `--tool-call-parser` unless `strict: true` is set,
so a model whose format drifts returns prose. In practice it runs on Linux with NVIDIA
hardware. SGLang's RadixAttention is the most sophisticated cross-request prefix reuse in
the field, and it is the right choice for several concurrent conversations that share a
prefix. LocalAI is the most operations-complete server here and the only

Ollama is the one to avoid for this workload, which is worth saying plainly because it is
the default suggestion everywhere. Since v0.30.0 it no longer has its own inference engine
(it spawns upstream `llama-server` as a subprocess), but it exposes almost none of its
knobs and on at least one path passes `--no-jinja --chat-template chatml`, doing its own
templating and tool parsing in Go rather than inheriting the lazy-grammar work. Two things
disqualify it here specifically: `tool_choice` is not supported at all (its own
compatibility checklist says so), and `cached_tokens` is hardcoded to zero. It also ships
with no authentication of any kind, and that is by design.

### Platform narrows the field harder than capability does

Most of the above assumes Linux. On Windows, where this repo is developed and where a good
share of its users will be, the list shortens sharply. vLLM and SGLang are Linux+NVIDIA in
practice, so Windows support is WSL-only. LocalAI has no native Windows story at all.
llamafile 0.10.x has no GPU support on Windows; its own README_0.10.0.md says so, in the
same "what's missing" list that notes the `pledge()`/SECCOMP sandboxing it was famous for
is not back either. The portable single file is therefore CPU-only on Windows. That leaves
`llama-server` built or downloaded directly, LM Studio (which gives up cache observability
entirely), and KoboldCpp. KoboldCpp is genuinely Windows-native, with grammar-forced tool
calls and clean 503 backpressure, at the cost of that hardcoded `call_001`.

Two smaller notes concern licence and shape. text-generation-webui is AGPL-3.0, the only
copyleft licence in this survey and material to anyone hosting it. It has no
`response_format` field at all, taking a per-request `grammar_string` of hand-authored
GBNF instead. Its streaming tool calls are not incremental. Generation stops on detection
and everything arrives in one final chunk. LocalAI is MIT and compiles both `json_object`
and `json_schema` to GBNF, but only on its llama.cpp backend.

### What overload and failure look like, which is not what this repo expects

`isTransient` (packages/providers/src/backends/transient.ts) treats 429 and 5xx as
retryable and reads `Retry-After`. Locally, 429 barely exists: it was found only on
Ollama's cloud path. The local overload signal is 503. `llama-server` returns
`unavailable_error` while a model is loading and otherwise queues, and
`GET /slots?fail_on_no_slot=1` is the explicit probe for a free slot; KoboldCpp returns a
clean 503 when busy; LocalAI returns 503 with a real `Retry-After`. The existing
classifier catches all of these through `retryableStatus`, so nothing breaks. But
`retryAfterMs` almost always comes back `undefined`, and the app falls back to its own
backoff. Separately, `-to/--timeout` on `llama-server` defaults to 3600 seconds, so a
request that goes wrong locally does not fail fast; that is this repo's problem to solve,
since it sets no timeout of its own.

## The models, surveyed

The local-scale tier crossed a threshold this year for an architectural reason rather than
a bigger number. A year ago the KV cache, not the weights, filled the memory of one
consumer card during a long tool-heavy conversation. A conventional dense 32B at 128k
context needs 32 GiB of KV cache, more than its own quantised weights and more than a 4090
has in total. The 2026 models in this class put full attention on only one layer in four
or one in six, with linear, Mamba or sliding-window layers in between, so the cache
shrinks accordingly. A parameter count does not show that change, and this question is
answerable only because of it.

The less encouraging half of the picture is that the Western open-weight frontier has
largely stopped. Meta published nothing under the Llama name after Llama 4 Scout/Maverick
(last updated 22 May 2025), and OpenAI's `gpt-oss-120b`/`20b` are unchanged since
August 2025. The open frontier now comes from Chinese labs and has grown to 750B–2.8T
parameters — Kimi K3, Qwen3.8-Max, DeepSeek-V4-Pro, GLM-5.2 — none of which is a local
model at any tier a person owns. What is left in between is a genuinely good 25–35B band,
and the practical choices all fall in that band.

### The candidates

Figures are `[SOURCED]` from Hugging Face cards, `config.json` files or official
leaderboards on 18 August 2026 unless marked otherwise. Vendors self-report the benchmark
rows, so treat them as ordering hints rather than measurements.

| Model                       | Params            | License           | Context   | The number that matters here                          |
| --------------------------- | ----------------- | ----------------- | --------- | ----------------------------------------------------- |
| **Muse-Glimmer-30B** (Meta) | 30B dense         | Apache-2.0        | 131k      | MCP-Atlas **75.5** — best at local scale by 13 points |
| **Qwen3.6-27B**             | 27B dense-hybrid  | Apache-2.0        | 262k → 1M | Terminal-Bench 2.0 **59.3**; MMMU 82.9 for vision     |
| **Qwen3.8-27B**             | 27B dense-hybrid  | Apache-2.0        | 262k → 1M | Terminal-Bench 2.1 **73.0**, OSWorld-Verified 84.3    |
| **GLM-4.7-Flash**           | 30B / 3B active   | MIT               | 131k      | **τ²-bench 79.5** — the only direct multi-turn number |
| **Qwen3.6-35B-A3B**         | 35B / 3B active   | Apache-2.0        | 262k      | vision included, and 2.5 GiB of KV at 128k            |
| **Gemma-4-26B-A4B**         | 25B / 3.8B active | Apache-2.0        | 262k      | no tool-use benchmark published at all                |
| **Nemotron-3-Nano-30B-A3B** | 30B / 3.5B active | NVIDIA Open Model | 1M        | BFCL v4 53.8 — the weakest of the group               |
| **Qwen3.5-9B**              | 9B                | Apache-2.0        | 262k → 1M | IFEval 91.5, BFCL-V4 66.1 — the small-job model       |

Two notes on that table. Meta did not exit open weights; it renamed.
`meta-models/Muse-Glimmer-30B` shipped on 9 August 2026 under a plain Apache-2.0 licence,
with first-party GGUFs and 380k+ downloads in its first week. BFCL has also gone stale as
the field's tool-use benchmark: the Gorilla leaderboard's last update reads 2026-04-12,
and current cards have stopped reporting it. Two benchmarks are worth reading for this
app's shape. τ²-bench covers multi-turn tool use against a policy document, and MCP-Atlas
covers 1000 human-authored tasks over 36 real MCP servers with 220+ tool definitions and
deliberate distractors. MCP-Atlas is the closest published proxy for "42 tool schemas,
forty steps, don't derail".

### The KV table is the headline

The entries below are `[COMPUTED]` from sourced `config.json` files (fp16 KV):

| Model                      | Full-attention layers          | KV/token | 32k      | **128k**  |
| -------------------------- | ------------------------------ | -------- | -------- | --------- |
| Nemotron-3-Nano-30B-A3B    | 6 attention layers             | ~6 KiB   | 0.19 GiB | **0.75**  |
| Muse-Glimmer-30B           | 13 of 52 (2 kv, d128) + 39 SWA | 13 KiB   | 0.48 GiB | **1.70**  |
| Qwen3.6-35B-A3B            | 10 of 40 (2 kv, d256)          | 20 KiB   | 0.63 GiB | **2.50**  |
| Gemma-4-26B-A4B            | 5 of 30 (8 kv, d256) + 25 SWA  | 40 KiB   | 1.45 GiB | **5.20**  |
| GLM-4.7-Flash (MLA)        | 47 × 576 latent dims           | 53 KiB   | 1.65 GiB | **6.61**  |
| Qwen3.6-27B / Qwen3.8-27B  | 16 of 64 (4 kv, d256)          | 64 KiB   | 2.00 GiB | **8.00**  |
| _a conventional dense 32B_ | 64 of 64 (8 kv, d128)          | 256 KiB  | 8.00 GiB | **32.00** |

A sliding-window design does not make a model cheap. Gemma-4-31B costs 20.8 GiB at 128k
despite its sliding-window design, because its ten global layers carry sixteen KV heads at
head_dim 256 — four times what GLM-4.7-Flash pays.

### What fits, with vision, at full context

`[COMPUTED]` figures come from sourced GGUF file sizes plus the table above. "With vision"
means the `mmproj` projector is loaded too. A local `ChatVisionReviewer` would need that
projector.

| On one 24GB card, at 128k | Weights + projector | KV        | Total                          |
| ------------------------- | ------------------- | --------- | ------------------------------ |
| Muse-Glimmer-30B          | 18.16               | 1.70 fp16 | **19.9 ✓** (21.5 with drafter) |
| GLM-4.7-Flash (no vision) | 18.30               | 3.30 q8   | 21.6 ✓                         |
| Qwen3.6-27B               | 17.75               | 4.00 q8   | 21.8 ✓                         |
| Gemma-4-26B-A4B           | 18.09               | 5.20 fp16 | 23.3 ✓, tight                  |
| Qwen3.6-35B-A3B           | 23.03               | 2.50 fp16 | 25.5 ✗ — needs 32GB            |

32GB is the best size, and 48GB adds little. The next real step up (GLM-4.5-Air at ~73 GB,
`gpt-oss-120b` at ~63 GB) needs 96GB. What 48GB gives you is Q8 instead of Q4, or room for
a second resident model. For this app the second resident model is the better use of the
memory, because the agent and a vision reviewer would otherwise evict each other.

### The failure mode is the tool parser, not the weights

This finding changes what a first integration should look like more than any other. vLLM
published a post-mortem in which self-hosted Kimi K2 tool calling succeeded on fewer than
20% of calls (218 of 1200-odd) because of three bugs in the serving layer:
`add_generation_prompt` silently dropped, empty-content history turns mishandled, and an
over-strict tool-call-ID regex. After the fixes, tool calling succeeded on 99.9% of calls.
Nothing was wrong with the model.

Two specifics affect this repo directly. The named-support list in llama.cpp's
docs/function-calling.md is badly out of date, so anything newer than its examples falls
back to a generic handler that the docs themselves warn "may consume more tokens and be
less efficient than a model's native format". Parallel tool calls are also off by default.
`Muse-Glimmer-30B` does not emit JSON tool calls at all. It uses an XML protocol Meta
calls ATEM, which the serving stack must parse back into a `tool_calls` array. That
protocol is not only a cost here. An XML-delimited parameter is more robust than JSON for
the long prose arguments `insertLines` and `edit_file` carry, because one unescaped quote
cannot invalidate the whole call.

### The two small jobs

Approval triage (`TRIAGE_MODEL = 'claude-haiku-4-5'`, `packages/authoring/src/approve.ts`)
is a bounded reading-comprehension question with a three-field schema, and it is the
best-matched local job in the repo. Qwen3.5-9B at Q8 (9.53 GB) is the pick.
Grammar-constrained decoding would make the JSON mechanically valid, and four documented
caveats apply. The first caveat ruins the output silently: `llama.cpp` constrains output
tokens but does not inject the schema into the prompt, so a constrained model that was
never told the field names returns syntactically perfect, semantically garbage JSON.
Constraint also costs latency (one study measured 3.6×) and can subtly hurt value
accuracy, because a grammar walks characters while the model was trained on
multi-character tokens. Constrained decoding fixes the syntax and leaves the values
unaddressed. This repo would not strictly need the grammar at all: `withStructuredRetry`
already gets three attempts at `extractJson`, so constrained decoding is an optimisation
here rather than a prerequisite.

**Vision critique** uses `ChatVisionReviewer` with two reviewers by default, and one
finding matters more here than the choice of model. SalArt-VQA (arXiv 2606.12671) built a
950-image, 3,681-question diagnostic of exactly this shape and found the strongest model
reaching 99.37% detection recall while answering all four artifact sub-questions correctly
on only 53.26% of images. Open VLMs are excellent at "is there a defect" and much worse at
"where, and what kind". `REVIEW_SYSTEM` today asks for an open-ended defect list; against
a local VLM that list should be decomposed into category-specific questions. Qwen3.6-27B
has the best vision scores in this survey — MMMU 82.9, and RefSpatialBench 70.0 against
Gemma-4-31B's 4.7 on the same spatial-referring test — and if it is already loaded as the
agent, it is free.

## Local image models, surveyed

The seam already matches, the quality gap is smaller than folklore suggests, and the
economics do not justify doing it for the money. These three findings support different
conclusions, so it is worth separating them before going into the detail.

The interface matches almost exactly. `edit(base, prompt, refs, params)` is implemented in
`gemini.ts` as `run([base, ...refs], prompt, params)`, which prepends base to the
reference list. That input shape suits an in-context multi-reference edit model and is not
specific to Gemini. Several open-weight models take exactly that input today.

The quality gap has moved. The Artificial Analysis Image Editing Arena, fetched 18 August
2026, shows:

| Model                          | Elo      |                                   |
| ------------------------------ | -------- | --------------------------------- |
| Nano Banana 2 (Gemini)         | 1249     |                                   |
| Nano Banana Pro                | 1244     |                                   |
| HunyuanImage 3.0 Instruct      | 1224     | 80B MoE, needs 8×80GB — not local |
| **HiDream-O1-Image**           | **1193** | MIT, 8B, genuinely local          |
| Nano Banana (Gemini 2.5 Flash) | 1180     | **the default in `project.yaml`** |

Read the last two rows together. `models.image` defaults to `gemini-2.5-flash-image`, and
two open-weight models score above the model this app ships with. Those two models close
the gap to Nano Banana 2, not to the current backend.

The academic benchmarks are harsher, and they cover older models. MICON-Bench, on
multi-reference instruction consistency, puts GPT-Image at 91.51 and Nano-Banana at 89.25
against BAGEL 73.55, OmniGen2 67.83 and UNO 44.76. That is a gap of 17–24 points.
MICON-Bench tested only the now-superseded 2025 open tier, and no multi-reference academic
benchmark run that includes HiDream-O1 or FLUX.2 could be found. The arena figure is ~55
Elo and the paper figures are 20 points, and the two cover different model vintages. The
true gap falls somewhere in between, and nobody has published it.

### The models

| Model                    | Released   | Params  | License                     | Practical VRAM              |
| ------------------------ | ---------- | ------- | --------------------------- | --------------------------- |
| **HiDream-O1-Image**     | 2026-05-08 | 8B      | **MIT**                     | ~24GB class                 |
| **Qwen-Image-Edit-2511** | 2025-12-23 | 20B     | **Apache-2.0**              | 40GB+ bf16; Q4 GGUF in 24GB |
| **Qwen-Image-2512**      | 2025-12-31 | 20B     | **Apache-2.0**              | as above                    |
| **FLUX.2 klein 4B**      | 2026-01-15 | 4B      | **Apache-2.0**              | ~13GB (see below)           |
| FLUX.2 klein 9B          | 2026-01-15 | 9B      | Non-commercial              | 32–48GB                     |
| FLUX.2 [dev]             | 2025-11-25 | 32B     | Non-commercial weights      | 80GB+ bf16                  |
| **Z-Image-Turbo**        | 2025-12    | 6B      | **Apache-2.0**              | 16GB                        |
| Chroma1-HD               | 2025       | 8.9B    | Apache-2.0                  | 24GB                        |
| HunyuanImage 3.0         | 2025-09    | 80B MoE | Hunyuan (excludes EU/UK/KR) | ≥8×80GB — not local         |

FLUX's licence is worth reading closely, because it separates weights from outputs and
says outputs may be used commercially even where the weights are non-commercial. Read the
text before it matters. Non-commercial weights are therefore not automatically
disqualifying. Every Qwen image model, FLUX.2-klein-4B, HiDream, Z-Image and Chroma are
Apache-2.0 or MIT and raise no question at all. Two things that turn up high in search
results do not exist: there is no "Stable Diffusion 4" and no "NVIDIA
Cosmos3-Super-Text2Image". Both are content-farm inventions.

Anime is split awkwardly. The booru-tagged, artist-tag-aware finetune ecosystem —
Illustrious, NoobAI, WAI, Animagine — is built on SDXL, and none of the 2026 flagships
have displaced it for style. But SDXL derivatives have the worst multi-reference support
of anything here, and the models with excellent multi-reference support are
photographic-leaning generalists. A VN pipeline requires both halves, and no single model
provides them.

### Reference images, which is the part this app actually needs

`refsOfSlot` produces two to five references per shot: a plate, one portrait per subject,
and a front-angle model sheet for any subject out of their default outfit. The items below
are set against that number:

- **FLUX.2** takes up to 10 references natively. It has the most headroom.
- **HiDream-O1-Image** has a ComfyUI-native `HiDreamO1ReferenceImages` node and is the
  only model with published multi-subject scaling data — 7.95 / 7.47 / 7.65 on UniSubject
  at 2–3, 4–8 and 9–11 subjects. The score does not collapse as subject count rises. That
  steadiness is unusual and directly relevant.
- **Qwen-Image-Edit-2511** takes 1–3 trained references (`QwenImageEditPlusPipeline`
  accepts `image=[a, b]` as a list). Three references is below this app's worst case: a
  two-character shot with both in non-default outfits is five refs, and Qwen would need
  references dropped or merged.

The adapter ecosystem this question usually assumes is no longer maintained. IP-Adapter,
InstantID, PhotoMaker, PuLID and InfiniteYou have all been dormant since 2024, and all
exist only for SD1.5/SDXL plus FLUX.1-dev. There is nothing for FLUX.2, Qwen-Image, SD3.5
or HiDream. The adoption gap is large: `unsloth/Qwen-Image-Edit-2511-GGUF` has ~236,000
downloads against `ByteDance/InfiniteYou`'s 912. The field moved from bolt-on identity
adapters to models that take references natively, and the adapters stayed on the older
models. A second problem rules the FaceID family out for a VN: it is built on
ArcFace/InsightFace embeddings, which are photographic face recognisers that do not work
on anime faces at all.

ControlNet has better coverage — a union ControlNet (canny/softedge/depth/pose) exists for
Qwen at ~30k downloads, and Qwen-Image-Edit includes control natively — but no working
ControlNet exists for SD3.5 and none exists for Chroma. It would be genuinely useful to
this app for staging (pose and framing per shot) even though it does nothing for identity.
Per-character LoRA is the other classic answer: 15–30 images, 1500–2500 steps, about 1.5
hours on a 4090 for a rank-4 FLUX LoRA. The bootstrap problem is acute for this app: you
need 15–30 consistent images of a character before you can train the thing that makes
images consistent. The standard workaround (generate with refs, hand-cull, train) takes
roughly a day per character.

**The verdict is as plain as the evidence allows.** A local stack reaches usable quality
on one character, with controlled staging and a consistent outfit. It does not reach
usable quality on two named characters in one frame, each in a specified outfit, across
hundreds of shots, unless a person reviews the output. Every open stack still fails on
that second case, and the failures are expensive: identity bleeds between the two
characters, and outfit attributes migrate from one character to the other. Budget a 10–15%
reject rate, which is 40–60 hand-repaired frames on a 400-shot project. The P7 refine loop
absorbs some of those frames automatically, but a vision critic that reliably catches
"character B is wearing character A's jacket" is itself hard to build.
[The SalArt-VQA finding](#the-two-small-jobs) explains why.

### Driving one from a program

The answer improved most here. ComfyUI now specifies its API rather than offering only a
UI with a socket. The repo moved to `Comfy-Org/ComfyUI` and ships an `openapi.yaml`
(OpenAPI 3.0.3, ~60 paths) that spectral lints in CI with `--fail-severity=error`. There
is a job namespace (`GET /api/jobs`, `/api/jobs/{id}`, `POST /api/jobs/{id}/cancel`) with
a unified status vocabulary, and typed errors that the spec says to distinguish by
`error.type` rather than by parsing messages. `POST /prompt` also accepts a
client-supplied job id: a `prompt_id` you generate, stored and compared verbatim
downstream. That detail lines up unusually well here, because this app already has
content-addressed slot hashes it can supply. Assets are blake3-hashed and deduped on
upload, which is the same idea as `packages/store`'s own addressing.

There is now an official TypeScript client, `@comfyorg/sdk`, generated from that spec with
a `check:spec-drift` script, plus `comfy-api-proxy` (MIT) to point it at a local install
with no API key. Several caveats apply. The SDK is at version 0.1.7, first published 21
July 2026, has single-digit stars, and has already made one breaking constructor change.
Inputs are still addressed by node id, so the workflow JSON must be pinned in-repo with
exactly one file knowing that node "10" is the ref loader. The `openapi.yaml` is linted
for validity but never diffed against `server.py`, so spec drift would not fail CI.
ComfyUI "API nodes", now Partner Nodes, are the opposite of what this needs. They call out
from inside a workflow to hosted commercial models, on prepaid credits.

The rest of the field, briefly. A1111 is effectively over (last push 2026-03-02, no
release since v1.10.1) and Forge has been dormant a year; its `/sdapi/v1/txt2img` surface
was never specified, and reference images live in an `alwayson_scripts` bag whose contents
depend on which extensions the user installed. That would couple this repo's request body
to the author's plugin set, which disqualifies it on its own. InvokeAI has the
best-documented API of the lot, but the wrong shape: a batch is a node graph, which
carries the same construction burden as ComfyUI with a smaller ecosystem and no official
TS client. SwarmUI works, but it hides prompt, seed, dimensions and init image inside
`rawInput`, an untyped JObject, and returns paths rather than bytes; it does expose
`PromptImages` as a list, which admits multiple reference images. `sd-server` from
`stable-diffusion.cpp` is the only local server verified to speak both
`POST /v1/images/generations` and `POST /v1/images/edits`, with `init_image`,
`mask_image`, `control_image`, base64 refs, seeds and a structured LoRA array. It is
GGUF-quantised, so the quality ceiling and model freshness lag the PyTorch stacks. LocalAI
is ruled out by its own source: `core/http/routes/openai.go` registers
`/v1/images/generations`, `/inpainting` and `/upscale`, and no `/v1/images/edits`. It does
support references, just not through an OpenAI-compatible endpoint. Ollama has no image
generation at all. vLLM and SGLang are token servers: they take images as input and return
tokens.

The honest alternative is `diffusers` behind ~300 lines of FastAPI, the only path where
`edit(base, prompt, refs, seed)` is the actual function signature. For a pipeline that
needs exactly two operations, that is competitive with adopting ComfyUI's whole graph
model. The cost is owning model loading, VRAM management, queueing and OOM recovery.

### Speed, and the seed problem

Measured under TensorRT, FLUX.1-dev at 1024² / 30 steps takes 3.9 s on an RTX 5090 at FP4,
6.7 s at FP8, and 10.9 s at FP16; an RTX 4090 takes 10.6 s at FP16. FLUX dev fp8 under
ComfyUI at 20 steps takes 5.5–8.8 s on a 5090, 11.3 s on a 4090, and 26 s on a 3090. SDXL
at 1MP / 20 steps takes 2.2 s on a 5090. At roughly 6 s an image, a 1250-image project
costs about two hours of GPU time, plus the refine loop and the manual repairs. The
argument for local art is the freedom to re-roll a shot forty times without watching a
meter, not the cost. Apple silicon is unvalidated here. No trustworthy measured figure was
found, and ComfyUI #14837 is a live correctness bug that produces silent corruption on MPS
when an attention matrix exceeds ~2³¹ elements; silent corruption is the worst kind of
failure.

The seed finding would impose a real design change on this repo, and it contradicts the
optimism in [Reproducibility of a seed](#reproducibility-of-a-seed) above. Bit-identical
output is the normal case within one frozen stack, and no project guarantees it outside
that stack: PyTorch states as policy that it guarantees nothing across releases or
platforms, and ComfyUI's own `--deterministic` help text says it "might not make images
deterministic in all cases" (its issue #375 has been open since April 2023). Mundane
things break it: memory offload kicking in, LoRA plus fp8 plus dynamic allocation,
`torch.compile`, attention-backend or dtype changes, and batch size, which forms part of
an image's identity, so pin batch size to 1. ComfyUI generates initial noise on CPU by
default and A1111 defaults to GPU, so the two will never agree on a seed for the same
model and prompt, and this difference between the tools is permanent.

This has a direct consequence for `sha256(kind, inputs)`. For a task hash to keep meaning
"these bytes", a local image backend's params must include a "stack fingerprint" (model
file hash, torch version, CUDA version, attention backend, dtype, batch size, GPU
architecture). Otherwise a driver update either invalidates every cached asset with no
record of why, or leaves the cached assets in place while the outputs drift, and the drift
stays invisible. Switching to a local backend is not a drop-in replacement here.

### The part nobody puts in a table

Local has no content filter, and that is the strongest non-economic argument in this whole
document. Google's Imagen `personGeneration` defaults to `allow_adult` and `allow_all` is
banned in the EU, UK, Switzerland and MENA; all Gemini image output carries SynthID
watermarking; and Google began blocking Disney-related prompts on 9 February 2026
following a cease-and-desist. That last case shows cloud policy changing mid-project and
without notice, under a half-finished project. On the open side, Qwen's Apache-2.0 carries
no content clause at all, Chroma states plainly that it "has not been aligned with a
specific safety filter", and FLUX.1-dev forbids a short, specific list.
Counter-intuitively, Stability's AUP is the strictest of the open tier and forbids sexual
content outright, so for an adult VN the SD family is contractually the wrong choice even
though it is technically the most permissive. Generating an asset is also a separate
matter from distributing it: Civitai's 2025 payment-processor cascade is the clearest
recent proof that "you can generate it locally" does not mean "you can host, distribute or
monetise it".

## A box on the home network

Moving the model off the authoring machine changes surprisingly little about the protocol
and a great deal about the failure modes. Same-machine and same-LAN use the same
integration, and they differ in what happens when the other end is not there.

**Configuration.** The missing field is a URL, and it belongs in `project.yaml` next to
the model ids rather than in `keys/`. It could be an `endpoints:` block mapping a vendor
name to a base URL, so that `models.text: local/qwen3-...` resolves through it. Two
consequences are worth naming before anyone writes it. First, a project is committed, so a
base URL in `project.yaml` is a LAN address shared with anyone the repo is shared with
(mild, but the first host-specific fact the config would carry). Second, `chatVendorFor`'s
prefix rule would need an "unknown" branch, because today an unrecognised id silently
means Gemini.

Discovery is not worth building. Ollama, llama.cpp and LM Studio all default to a fixed
port on `127.0.0.1`, and on a LAN the author knows the box's name. The whole feature is a
hand-typed URL and a "test connection" button that calls `GET /v1/models`. mDNS/Bonjour
browsing would add a lot of machinery to save one line of typing, and it breaks on the
networks people have at home.

**API keys become optional for local endpoints, but they do not disappear.** A LAN server
usually has no auth, which is fine on a home network and is why most of them ship that
way. But `llama-server`, vLLM and LM Studio all accept a static bearer token, and anyone
exposing a box beyond their own LAN should set one. So the key concept survives as
optional, while the mapping from vendor to environment variable does not. A local endpoint
is identified by its URL.

Timeouts are the first real problem.
`grep -rn "timeout\|AbortSignal\|signal" packages/providers/src` returns nothing — this
repo sets no request timeout anywhere and passes no abort signal. The missing timeout is
invisible today, because the vendor SDKs carry their own defaults and cloud calls answer
in seconds. A local image generation takes tens of seconds to minutes, a long-context
prefill on a loaded box can take minutes, and a cold model load takes minutes more. A
local backend has to set its own generous timeout explicitly, and the repo currently
offers no way to cancel a request when the author closes the pane.

Concurrency is the second problem, and the more damaging of the two. The scheduler runs
ready tasks in parallel up to `config.concurrency`, which defaults to 4, and each shot
task then fans out to every configured vision reviewer in parallel. A cloud endpoint
absorbs four concurrent image generations plus eight concurrent vision calls without
trouble; a single GPU queues them, and that is the best case. How badly a server degrades
depends on the server. A continuous-batching server (vLLM, SGLang) degrades gracefully,
`llama-server` needs `--parallel` set and splits its KV cache between slots, and a
diffusion front-end typically serialises outright. Two consequences follow. The
concurrency cap is per-project and global, so it cannot express "4 against the cloud, 1
against the GPU". A single local GPU serving both the image model and a vision reviewer
will thrash, because the two models cannot both be resident.

Prefix caching interacts badly with concurrency, and this coupling is the non-obvious one.
A local server's prefix cache is a KV cache tied to a slot or a radix tree over recent
requests. Interleaving other work evicts the agent's prefix, so the agent's cache-hit rate
depends on what else is on the box. The cloud path has no such coupling, because an
Anthropic cache breakpoint sets a five-minute server-side TTL that nothing local can
evict.

When the machine is asleep or gone, the failure arrives as `ECONNREFUSED` or a socket
timeout, and `isTransient` in `packages/providers/src/backends/transient.ts` already
matches both (`ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`). That is right for a server
that is starting up and wrong for one that is switched off: `callWithRetry` spends three
attempts, and the agent loop's `onApiError` recovery keeps offering to retry up to
`MAX_API_ATTEMPTS = 50` with backoff capped at a minute. The call fails correctly and
takes a long time doing it. A local backend should use a short connect timeout and a
distinct message that says "nothing is listening at `http://vega:8080`" rather than the
generic transient path, because the fix is to turn the machine on and waiting does not
substitute for that.

A model that is still loading is the case nobody expects. Ollama and LM Studio load a
model on first request, which can take tens of seconds for a large one, and a request that
arrives during that window may hang or return a 503. That failure is genuinely transient
and the existing classifier handles it, provided the timeout is long enough to survive the
load — which returns to the first problem.

## Cost, quality, speed, and the parts that are not money

### Money

The numbers settle this argument, so start with them. A VN of the size this repo is built
for is roughly 1,250 images — sheets, portraits, plates, ~400 shots, plus refine attempts.
At `gemini-2.5-flash-image`'s $0.039 an image that is $25–50, and half that on the batch
tier; at Gemini 3 Pro Image's $0.134 it is ~$170. The cloud art bill for the whole project
costs less than a GPU. Local art is better on iteration volume, content policy and
reproducibility. It is not cheaper, and claiming otherwise obscures the arguments that do
hold.

The text side is less clear-cut, because the authoring agent's cost is per token and
recurs with every conversation rather than once per picture. But the crossover is still
not where the enthusiast forums put it, for two specific reasons this repo can name.

First, the app already spends only once on each piece of work. Task identity is
`sha256(kind, inputs)`, `state/tasks.jsonl` replays, and a resumed run skips `done` work.
Base art lives in its own root and is not regenerated. The refine loop stops early when a
critique repeats unchanged, so no further re-roll is paid for. These measures keep the
cloud bill below the naive estimate, which pushes the crossover out.

Second, the app cannot currently tell the author what anything costs. `TokenUsage` counts
tokens, not currency, and [`a-less-technical-mode.md`](a-less-technical-mode.md) already
records that the app can name call counts but never money. This codebase therefore cannot
demonstrate to its own user that local is cheaper, nor that it is more expensive.

### Quality

For small, well-bounded jobs (approval triage, an entity extraction, a one-line
description), a good small open-weight model is close enough to indistinguishable, and the
app's structure protects the rest: `withStructuredRetry` gives three attempts,
`narrowTriage` throws away anything not on the host's list, and the author confirms the
card. The authoring agent is a different matter. The gap there is wide, and it falls in
the dimension that is hardest to fix. The agent has to stay coherent over forty tool calls
without derailing, hallucinating a tool, or forgetting what it already read.

The gap for art is different in kind rather than degree, and is discussed under
[Local image models](#local-image-models-surveyed).

### Speed

The cloud path wins on parallelism and prefill. It runs four shot generations and eight
vision calls concurrently, and it re-sends a 7k-token cached prefix at no cost. A single
local GPU has neither parallelism nor free prefill: concurrent requests collapse into a
queue, and every step re-prefills whatever the server's prefix cache did not keep. The
local path wins on latency floor, because it has no network, no queue behind other
customers, and no rate limit. That floor matters most for the small frequent calls and
least for the big ones.

### Privacy, and why this repo should care more than most

The strongest argument for the local path here is that nothing leaves the machine, and it
is strongest because the repo has already taken a position on it. `keys/` is gitignored
and key values are never logged. The difficult-agent report
([`../plans/archive/INDEX.md#reporting-a-difficult-agent`](../plans/archive/INDEX.md#reporting-a-difficult-agent))
is explicitly "the author's own key, on the author's own machine", with a redactor that
replaces the fiction's names at the boundary rather than in a prompt, because a prompt
only requests the behaviour while the boundary enforces it. `@vn/bible` has no whole-file
API, and that absence enforces the boundary.

A project in progress contains unpublished work — every scene, every character, and every
draft that was thrown away. Today all of that goes to a vendor. Most authors will accept
the trade, and the trade is defensible, but it is still a trade, and only a local option
makes it a choice. The argument for a local option is also the one argument that does not
depend on any number in this document being right.

### Offline

The pipeline is the half that matters here. `vngen run` against a local stack runs
offline, and so does the agent. The parts that still need a network are git remotes and
the GitHub issue link at the end of a difficult-agent report; neither is a model call.

### Reproducibility of a seed

This is worth stating precisely, because the intuition runs backwards. `ImageParams.seed`
is hashed into task identity, and the app treats a seed as an authored field (zero is a
seed, so every test is `=== undefined`). A cloud image model's seed is a request parameter
that carries no guarantee: the same seed against a silently updated endpoint returns
different bytes, and the app would not know. A local model's weights are a file on disk
that nobody can change underneath the author, so the local path is the only one where a
seed means what the hash implies. The caveats are real but smaller. Sampler and scheduler
settings must be pinned alongside the seed, and attention-backend and GPU differences can
perturb the last bits. Verify this rather than assume it.

### Maintenance

The integration itself costs a few hundred lines, which is not the burden. The burden is
that the author now owns a version matrix (runtime, model file, quantisation, sampler, and
for images a graph of nodes and adapters), and that the repo takes on support where every
failure looks like an app bug. The cloud path has one failure mode ("the key is wrong" or
"the vendor is down") and the local path has thirty. Whoever answers the questions pays
that cost, and that is the strongest argument for keeping the first local integration
small and clearly labelled.

## What I would do, in order

There are six steps. Each step is useful on its own, and none commits to the next. The
ordering is by how much is learned per unit of risk, not by how much of the app is
converted.

**1. Give the config somewhere to put a URL, and make an unknown model id an error.** This
is the prerequisite for everything else and is worth doing even if nothing local ever
ships, because `chatVendorFor` silently falls back to Gemini today: a typo in
`models.text` bills a different vendor rather than failing. Add an `endpoints:` block in
`project.yaml` mapping a vendor name to a base URL, add a third arm in `chatVendorFor`,
and collapse the duplicate copy of that rule in `apps/authoring/src/agent.ts` into
`chatVendorFor`. Note that `project.yaml` is committed, so a LAN address in it is shared
with whoever the repo is shared with.

**2. Point the approval triage model at a local server.** `TRIAGE_MODEL` is a fixed
`claude-haiku-4-5` today, built by the host in `session.ts` and in
`ApprovalControl.triage()`. It is the best first target in the repo for structural
reasons: it is a single `message()` call with no tools; its schema has three fields;
`narrowTriage` discards anything the model adds; `offlineTriage` already exists as a
deliberately simple baseline to compare against; and the author confirms the card
afterwards regardless. Run Qwen3.5-9B at Q8 (9.53 GB) under `llama-server`, and describe
the schema in the prompt as well as constraining it, because leaving the description out
is where this normally goes wrong. The success criterion is that the local model agrees
with the Haiku answer on a corpus of the author's own real approval paragraphs. Failure
costs nothing.

**3. The vision reviewers come next, and the question gets decomposed at the same time.**
`ChatVisionReviewer` is the app's highest-volume model use (two reviewers per shot, up to
four refine attempts), and it is a `message()` call with images, so it needs nothing from
the optional half of `ChatBackend`. Two things make this the right second step. Local
inference saves the most money per unit of risk here, and the SalArt-VQA finding (99.37%
recall on "is there a defect", 53.26% on all four sub-questions) says `REVIEW_SYSTEM`'s
open-ended defect list should become category-specific questions whether or not the model
is local. A local pass would improve the cloud path too.

**4. Add the agent last, and measure the cache before believing anything.** Run
`chatConversation` against a local `/v1/messages` on `llama-server`, the only
Windows-native runtime that reports real `cached_tokens` and grammar-constrains tool calls
so they cannot come back malformed. Expect the first failure to come from the serving
stack's tool parser rather than the model: vLLM's own post-mortem had self-hosted tool
calls succeeding on fewer than 20% until three serving-layer bugs were fixed. Run a
bake-off rather than picking from a table, across Muse-Glimmer-30B (Apache-2.0, best
MCP-Atlas at local scale, cheapest KV, ATEM XML tool args that resist prose corruption),
Qwen3.6-27B (most mature llama.cpp support, best vision, so it doubles as step 3's model),
and GLM-4.7-Flash (the only published τ²-bench number, fastest decode). A day against the
author's own conversations will settle the choice better than the benchmark rows listed
earlier.

**5. Add the image backend last, behind the same seam, and never as a replacement.** This
adds one new file in `packages/providers/src/backends/` and one dispatch in `factory.ts`;
`runModelSheet` is the only caller of `edit` and needs no change. Two things must go in
before the first byte is generated. The mock-art guard (`isPlaceholderImage`) lives inside
`gemini.ts`'s `imagePart` rather than in `BackendImageProvider`, so a new backend that
omits it conditions work on coloured rectangles without any warning — that check belongs
in the shared layer. The stack fingerprint must also join `ImageParams` in the dedupe
hash, or a driver update either invalidates every cached asset or leaves every cached
asset in place, and the second outcome is worse. The transport is either ComfyUI through
`comfy-api-proxy` and `@comfyorg/sdk`, if the ecosystem is worth the graph model (its
client-supplied job ids and blake3 content addressing line up unusually well with this
repo's own hashing), or ~300 lines of FastAPI over `QwenImageEditPlusPipeline`, which is
the only path where `edit(base, prompt, refs, seed)` is literally the function signature.
The first model to try is HiDream-O1-Image, because it is MIT, 8B, ComfyUI-native, scores
above the Gemini model this app currently defaults to, and is the only candidate with
published multi-subject scaling data that does not collapse at this app's five-reference
worst case.

**6. Fix the operational gaps a local endpoint exposes, which are this repo's bugs either
way.** `packages/providers` has no request timeout and no `AbortSignal` anywhere.
`config.concurrency` is a single global number, which cannot express 4 concurrent requests
against the cloud and 1 against the GPU. `ECONNREFUSED` from a switched-off box is
classified as transient, so the app spends three attempts and then offers fifty more with
a minute of backoff, when the honest message is that nothing is listening at
`http://vega:8080`.

**What not to do.** Do not replace the cloud path; add the local path alongside it,
because the strongest argument for local here is that it makes privacy a choice, and a
choice needs both options. Do not build mDNS discovery; the whole feature is a typed URL
and a `GET /v1/models` "test connection" button. Do not require constrained decoding as a
prerequisite, because `withStructuredRetry` already gives three attempts and a grammar
only optimises what already works. Do not treat "local" as a variant of `--mock`: mock art
is deliberately marked so that it cannot pass as the output of a real run, while local art
is real art, and conflating the two would either break the guard or rule out the feature.

## Open questions

The repo half of this document is checkable, and it was read rather than assumed. The
survey half is a snapshot. The list below names the places in the survey half that should
not be trusted without a second look.

**Things nobody has measured.** The true 2026 multi-reference image quality gap is the
biggest hole here: the Artificial Analysis arena says ~55 Elo, MICON-Bench says 17–24
points, and the two figures measure different vintages. No multi-reference academic
benchmark run including HiDream-O1 or FLUX.2 could be found at all. No trustworthy
measured figure for Apple silicon image-generation speed exists either, and a live
silent-corruption bug on MPS (ComfyUI #14837) means that speed should be treated as
unvalidated rather than slow.

Every vendor reports its own numbers. Every benchmark row in
[The models, surveyed](#the-models-surveyed) is from the model's own card. Meta's
MCP-Atlas 75.5 for Muse-Glimmer-30B carries the most weight in the recommendation above,
and no third party has reproduced it. Qwen stopped publishing BFCL and τ²-bench after
Qwen3.5, so the tool-calling case for Qwen3.6/3.8 is inferred forward from coding-agent
proxies. Google publishes no tool-use benchmark for Gemma 4 at all, and Gemma 3 ranked far
below Qwen3 on BFCL. Test these models before trusting the numbers.

The following serving details were not confirmed and would change a decision. Whether vLLM
or SGLang ship an ATEM tool-call parser for Muse-Glimmer was not confirmed, and without
one that model's tool calls do not become `tool_calls` arrays. `llama.cpp`'s current
default for `parallel_tool_calls` under the new PEG parser architecture is unknown; the
only source saying it is off is the stale docs/function-calling.md. LM Studio's
prefix-cache behaviour is undocumented in either direction (no toggle, no claim, no
counter), so the only way to know is to time TTFT against a live instance. Two primary
sources conflict on whether headless Jan can serve at all. Whether vLLM or SGLang emit
`Retry-After` under overload was not confirmed; `Retry-After` was found only in LocalAI,
by targeted grep rather than exhaustive proof.

**Some numbers look wrong.** Nemotron-3-Nano-30B-A3B at 24.6 GB for Q4_K_M is high for a
30B model (expect 18–19), and GLM-4.5-Air at 73 GB is high for 106B (expect ~63). Both
figures were sourced, but verify them before basing a hardware purchase on them. BFL's own
sources contradict each other on FLUX.2-klein-4B's VRAM: GitHub gives ~8 GB, while the
model card and launch blog give ~13 GB.

**Read these licences directly rather than taking them on trust.** FLUX splits weights
from outputs, claiming that outputs may be used commercially even where weights are
non-commercial. That claim matters for anyone shipping a VN, so read it at the source.
Qwen3.8-Max's custom licence carries a revenue gate and possibly a geographic one,
depending on the source. Kimi K3's and MiniMax-M2.7's terms were not read.

This repo would have to find out several things for itself. It would have to test whether
the authoring agent's actual conversations (not a benchmark's) survive forty steps against
a 30B model without derailing. It would have to test whether the P7 vision critique can be
decomposed into category questions without losing what `mergeReports` and `stalledAfter`
depend on. It would have to measure what `config.concurrency = 4` plus two vision
reviewers per shot does to one GPU, and whether that GPU queues the work or thrashes. And
it would have to observe whether an author who is offered a local option takes it. No
amount of research answers that last question.

`llama.cpp/docs/function-calling.md` is stale by construction. It still describes a set of
per-model handlers that no longer exists in `common/chat.h`. Local-model work in this repo
should assume its own documentation goes stale the same way, and should cite source over
docs.

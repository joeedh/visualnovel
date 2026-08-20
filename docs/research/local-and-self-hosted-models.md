# Local and self-hosted models

_Research, external + internal. Nothing here is a plan and nothing here is load-bearing for the
code. It answers one question — **can this app run against models the author hosts themselves**,
on the same machine or on a box on their home network — for both text and image models, and says
what it would cost to get there._

_Status: **research.** The half that reads the repo is checkable and will stay true until the
seams move. The half that surveys runtimes, open-weight models and local image models is a
snapshot of **18 August 2026** and will rot fast; every figure in it is marked either sourced or
estimated, and the estimates are estimates._

<!-- toc -->

- [The honest answer](#the-honest-answer)
- [What the app actually asks a model for](#what-the-app-actually-asks-a-model-for)
  * [There is exactly one chat seam, and it is small](#there-is-exactly-one-chat-seam-and-it-is-small)
  * [The agent's request is shaped for one vendor's cache](#the-agents-request-is-shaped-for-one-vendors-cache)
  * [The vendor is chosen by a string prefix, and the fallback is Gemini](#the-vendor-is-chosen-by-a-string-prefix-and-the-fallback-is-gemini)
  * [The image seam is where the vendor is not even a variable](#the-image-seam-is-where-the-vendor-is-not-even-a-variable)
  * [Mock, local, real](#mock-local-real)
- [The runtimes, surveyed](#the-runtimes-surveyed)
  * [The prefix cache exists everywhere, and the breakpoints are a no-op everywhere](#the-prefix-cache-exists-everywhere-and-the-breakpoints-are-a-no-op-everywhere)
  * [Cached-token reporting is the one thing that must be checked, and most servers fail it](#cached-token-reporting-is-the-one-thing-that-must-be-checked-and-most-servers-fail-it)
  * [`llama-server` is the recommendation, and it is not close](#llama-server-is-the-recommendation-and-it-is-not-close)
  * [Platform narrows the field harder than capability does](#platform-narrows-the-field-harder-than-capability-does)
  * [What overload and failure look like, which is not what this repo expects](#what-overload-and-failure-look-like-which-is-not-what-this-repo-expects)
- [The models, surveyed](#the-models-surveyed)
  * [The candidates](#the-candidates)
  * [The KV table is the headline](#the-kv-table-is-the-headline)
  * [What fits, with vision, at full context](#what-fits-with-vision-at-full-context)
  * [The failure mode is the tool parser, not the weights](#the-failure-mode-is-the-tool-parser-not-the-weights)
  * [The two small jobs](#the-two-small-jobs)
- [Local image models, surveyed](#local-image-models-surveyed)
  * [The models](#the-models)
  * [Reference images, which is the part this app actually needs](#reference-images-which-is-the-part-this-app-actually-needs)
  * [Driving one from a program](#driving-one-from-a-program)
  * [Speed, and the seed problem](#speed-and-the-seed-problem)
  * [The part nobody puts in a table](#the-part-nobody-puts-in-a-table)
- [A box on the home network](#a-box-on-the-home-network)
- [Cost, quality, speed, and the parts that are not money](#cost-quality-speed-and-the-parts-that-are-not-money)
  * [Money](#money)
  * [Quality](#quality)
  * [Speed](#speed)
  * [Privacy, and why this repo should care more than most](#privacy-and-why-this-repo-should-care-more-than-most)
  * [Offline](#offline)
  * [Reproducibility of a seed](#reproducibility-of-a-seed)
  * [Maintenance](#maintenance)
- [What I would do, in order](#what-i-would-do-in-order)
- [Open questions](#open-questions)

<!-- tocstop -->

## The honest answer

**Today: no, not at all. In principle: most of it, and less painfully than expected. In practice:
start with one small job, not with the agent and not with the art.**

Nothing in this repo can currently talk to a local model. That is not a gap to be filled in
somewhere — it is three specific facts. `chatVendorFor` picks a vendor by a **string prefix** on the
model id and falls back to Gemini with no "unknown" branch, so `models.text: qwen3.6-27b` does not
fail, it silently calls Google. `ResolvedKeys` is a two-field interface of _vendor → secret_, which
has nowhere to put a URL and insists on the one thing a LAN server does not need. And
`createProviders` builds the image backend as `createGeminiImage(...)` **unconditionally**, which is
why every non-mock run demands a Gemini key regardless of what the other model ids say.
`grep -rn "localhost\|127.0.0.1\|http://" packages/providers/src packages/config/src` returns
nothing.

Against that, the seam itself is in good shape, and in one respect better shape than expected:

- **The required half of `ChatBackend` is a plain text-in/text-out call** and every structured
  result in the app is enforced _after_ the fact by `extractJson` + zod + `withStructuredRetry`,
  never by a schema sent to the vendor. A local model that cannot be constrained is not
  disqualified; it has three tries.
- **`chatConversation` is Anthropic-shaped, and an Anthropic-shaped `/v1/messages` is now close to
  table stakes locally** — `llama-server`, vLLM, SGLang, Ollama, LM Studio, LocalAI and others all
  ship one. The hardest-looking part of the port is the part the ecosystem already did.
- **The four `cache_control` breakpoints become no-ops** — no local runtime honours them, all of
  them accept and drop the field — but the discipline they forced is exactly what makes a local
  positional prefix cache hit, so nothing needs restructuring.
- **`ImageBackend`'s two methods already have the shape open models take.** `edit` is implemented
  today as `run([base, ...refs], ...)`, which is an in-context multi-reference edit, and several
  open-weight models consume precisely that.

Three things are genuinely hard, and it is worth being blunt about which. **The budget arithmetic
punishes an honest server for a dishonest one's sins**: `charge()` is `input - cacheRead + output`,
so a runtime that caches perfectly but reports `cached_tokens: 0` — Ollama and LM Studio both do —
burns roughly 7k tokens of a 200k budget per step on a prefix it never reprocessed. **Two named
characters in one frame, each in a specified outfit, across hundreds of shots is where every open
image stack still fails**, and that is the app's central case, not an edge one; budget a 10–15%
reject rate. And **a local seed does not mean what a content-addressed task hash implies it means**
unless the stack fingerprint — model file, torch version, attention backend, dtype, batch size —
joins the inputs being hashed. That last one is the only place going local imposes a design change
rather than a new file.

The recommendation that follows from all of it is in [What I would do, in order](#what-i-would-do-in-order),
and its first step is deliberately unambitious: point the **approval triage model** at a local
server. It is one `backend.message()` call with a three-field schema, it already has an offline
fallback to compare against, and getting it wrong costs a confirmation card the author was going to
read anyway.

## What the app actually asks a model for

Everything below is read off the code, not assumed. Three seams matter, and they are not equally
hard to serve.

### There is exactly one chat seam, and it is small

`ChatBackend` (`packages/providers/src/backend.ts`) has one required method and three optional
ones:

| Member                | Required? | Who needs it                                                             |
| --------------------- | --------- | ------------------------------------------------------------------------ |
| `modelId`             | yes       | provenance — it is written into every asset's `AssetMeta.modelId`         |
| `message`             | yes       | `ChatTextLLM`, `ChatVisionReviewer`, `triageApprovals`, `describeAsset`   |
| `messageWithUsage`    | no        | the token meter; absence means **no total**, which the app renders as such |
| `chatWithTools`       | no        | nothing, in practice — it is the single-shot native path Gemini implements |
| `chatConversation`    | no        | `NativeAgentBackend`, and **it is the probe** that selects the cached path |

The required half is a plain text-in/text-out call with optional images. That is a very low bar,
and it is the bar most of the app's model use sits at: location mining, shot decomposition, prompt
refinement (`ChatTextLLM`), the P7 vision reviewers (`ChatVisionReviewer`), the approval triage
(`triageApprovals`), and `describeAsset`. **Every one of those enforces its own shape after the
fact rather than asking the model for it**: `withStructuredRetry` calls the model, runs
`extractJson` over the raw text — which tolerates code fences and surrounding prose — validates
against a zod schema, and retries up to three times. Nothing anywhere in `packages/providers`
sends a JSON schema, a grammar, or a `response_format`. So a local model that cannot be
constrained is not disqualified; it just has to get there in three tries.

The optional half is where a local server has to work for a living. `chatConversation` is the
whole authoring agent, and its request shape is deliberately Anthropic-specific.

### The agent's request is shaped for one vendor's cache

`buildConvoRequest` (`packages/providers/src/backends/convo-request.ts`) is the most
vendor-coupled function in the repo, and every line of it is coupled on purpose
([`../plans/prompt-caching-and-deferred-tool-loading.md`](../plans/archive/prompt-caching-and-deferred-tool-loading.md)):

- **Four `cache_control: {type: 'ephemeral'}` breakpoints** — end of the tool catalog, end of the
  system prompt, and a rolling pair over the transcript that `NativeAgentBackend` advances each
  step (`prevBreak`). Four is the vendor's maximum.
- **`defer_loading` plus a server-side `tool_search_tool_bm25_20251119` tool.** Of the 42 tools
  advertised (39 in the registry, 3 control tools the loop owns), `ALWAYS_LOADED` keeps six in
  context and defers the rest for the model to search for.
- **`{"role": "system"}` messages inside `messages[]`**, gated by `supportsSystemRole(modelId)` —
  which is a regex over the model id — and down-rendered to a `user` turn where the model refuses
  them. This is how mode changes and budget warnings are filed without recomposing a cached prefix.
- **`raw` blocks echoed verbatim.** `ChatConvoReply.raw` is the assistant's content blocks exactly
  as received, because thinking blocks can only be echoed, never rebuilt.
- **`output_config.effort` and `thinking: {type: 'adaptive'}`**, from `resolveEffort`.

None of that has an equivalent on an OpenAI-compatible endpoint. Some of it degrades gracefully —
`ChatTurn.cache` is documented as something a backend "maps to the vendor's marker, or ignores",
and `ToolSchema.defer` says "a backend without tool search ignores it". The rest does not have to
be ported at all, because a local backend is free to implement `chatConversation` in whatever wire
format it likes; the contract above the seam is `ChatConvoRequest` → `ChatConvoReply`, not
Anthropic's schema.

**The expensive part is not the format, it is the arithmetic.** `charge()`
(`packages/types/src/budget.ts`) is `input - cacheRead + output`, and its doc comment states the
rule that bites: _a provider that reports no split spends its whole input_. The agent's stable
prefix today is the 9,485-character `SYSTEM_PROMPT`, the project's `AICONTEXT.md`, and a tool
catalog the caching plan measured at 13,317 characters — call it 6–7k tokens before the
transcript, re-sent on every step. Against the default `200k` budget, a local server that returns
`usage` without a cached-token count would burn roughly 7k tokens of budget per step for tokens it
did not actually reprocess, and a forty-step turn would hit the ceiling having done very little.
A server that returns **no** `usage` at all is worse in a different direction: `spent` never
moves, so the only thing that stops a runaway is `MAX_ITERATIONS = 200`.

### The vendor is chosen by a string prefix, and the fallback is Gemini

```ts
// packages/providers/src/factory.ts
export function chatVendorFor(modelId: string): keyof ResolvedKeys {
  const id = modelId.toLowerCase();
  return id.startsWith('claude') || id.startsWith('anthropic') ? 'anthropic' : 'gemini';
}
```

There is no "unknown vendor" branch. Put `qwen3-coder-30b` in `project.yaml`'s `models.text` and
the app builds a Gemini client for it and calls Google. `apps/authoring/src/agent.ts` carries a
**second, hand-copied version** of the same rule (its comment says so: "mirrors @vn/providers'
private picker"), so the rule exists in two places. `chatBackendFor` has six non-test callers;
`ResolvedKeys`, `KEY_VENDORS` and `resolveKeys` are referenced from ten non-test files.

`ResolvedKeys` is a two-field interface of non-optional strings (`gemini`, `anthropic`), and
`project.yaml`'s `keys:` block names two env vars. The vocabulary is *vendor → secret*. A local
endpoint has a URL and usually no secret at all, which is the wrong shape twice over: there is
nowhere to put the URL, and the one thing the config is built to carry is the one thing a local
server does not need. `project.setKey` is deliberately not undoable and records `<secret>` in the
provenance journal — none of which is wrong for a local endpoint, just irrelevant to it.

### The image seam is where the vendor is not even a variable

```ts
// packages/providers/src/factory.ts, createProviders
const image = new BackendImageProvider(createGeminiImage(keys.gemini, config.models.image), loadRef);
```

`config.models.image` names a **model**; the **backend** is `createGeminiImage`, unconditionally.
The text and vision models at least go through `chatBackendFor`. The image one does not, which is
why `buildProviders` in the desktop session and `loadProject` in the CLI both call `resolveKeys`
with `require: ['gemini']` for any non-mock run: **a Gemini key is currently mandatory for any
real run of this app, whatever the other model ids say.**

What that backend is asked to do is the real constraint, and it is not text-to-image:

```ts
// packages/providers/src/backend.ts
export interface ImageBackend {
  readonly modelId: string;
  generate(prompt: string, refs: ImageInput[], params: ImageParams): Promise<ImageResult>;
  edit(base: ImageInput, prompt: string, refs: ImageInput[], params: ImageParams): Promise<ImageResult>;
}
```

Both methods take a **list of reference images**, and `edit` takes a base on top of them. The
Gemini implementation is four lines long because the vendor's model consumes exactly that shape:
`generate` sends the refs as inline image parts, and `edit` sends `[base, ...refs]`. Nothing is
masked, no control image is derived, no adapter is loaded, no character LoRA exists. Consistency
is bought entirely by handing the model the pictures and asking.

The chain that rests on it, from `refsOfSlot` (`packages/artgen/src/refcycle.ts`) and
`runners.ts`:

- A **portrait** is drawn from nothing. So is a **plate** — except a non-default time-of-day
  variant, which is derived from the default variant.
- A **model sheet** is `image.edit(approved portrait, prompt, rest)` — the runner takes `refs[0]`
  as the base explicitly, with the comment "model sheets are reference-guided edits of the approved
  portrait". A character's whole wardrobe is edits of one approved face.
- A **shot** is `image.generate(prompt, refs)` where `refs` is the location plate, one portrait per
  subject, and a front-angle model sheet for any subject out of their default outfit — plus
  whatever the author attached at that rung. **Two to five reference images per frame is the
  normal case**, and every frame in a scene re-derives its consistency from the same upstream
  pictures rather than from a trained identity.
- P7 then runs generate → critique → refine inside the shot runner, up to
  `config.max_refine_attempts` (default 4), re-generating with a deterministically refined prompt
  and the **same** refs each time.

Two smaller facts a local image backend would inherit. `ImageParams.aspect` is part of the cache
key and the task hash but **is never sent to Gemini** — `createGeminiImage` forwards only
`responseModalities` and `seed`. A local backend that honours width/height would therefore be
*more* faithful to the config than the current one, and would produce different bytes for the same
hash, which is a provenance question rather than a bug. And the mock-art guard (`isPlaceholderImage`,
the `vn-mock-placeholder` `tEXt` chunk) lives inside `gemini.ts`'s `imagePart`, not in
`BackendImageProvider` — so a new backend that forgot to re-implement it would silently condition
paid work on coloured rectangles.

### Mock, local, real

`--mock` swaps the whole `Providers` bundle (`createMockProviders`) at three call sites, and its
art is deliberately *marked* so it can never be laundered into a real run. A local provider is a
third thing and not a middle one: like `--mock` it needs no key and no network, and like a real run
it produces genuine bytes that downstream tasks may legitimately reference. `AssetCache` /
`CachedImageBackend` (`packages/providers/src/cache.ts`) is the closest existing precedent for
"real bytes from somewhere other than the vendor", and its `requestKey` already keys on
`params.modelId`, so recordings made against a local model could never be replayed for a cloud one.

## The runtimes, surveyed

**The single most useful thing to know is that an Anthropic-shaped `POST /v1/messages` is now close
to table stakes on a local server.** That was not true a year ago and it changes the shape of the
work here, because `chatConversation` — the hardest part of the seam and the most vendor-coupled
function in the repo — already speaks that dialect. Confirmed present in source or official docs on
18 August 2026: `llama-server` (plus `/v1/messages/count_tokens`), Ollama, LM Studio 0.4.1, vLLM,
SGLang, LocalAI, text-generation-webui, KoboldCpp, Lemonade and llamafile. The reason is prosaic —
people wanted to point Claude Code at a local model — and `llama-server`'s README is honest about
the level: _"While no strong claims of compatibility with the Anthropic API spec are made, in our
experience it suffices to support many apps."_ A third surface, OpenAI's Responses API, is spreading
too.

### The prefix cache exists everywhere, and the breakpoints are a no-op everywhere

**No local runtime honours `cache_control`. Not one.** vLLM's own test suite makes the behaviour
explicit: `tests/entrypoints/anthropic/test_anthropic_messages_conversion.py` asserts that
`cache_control` blocks are **accepted and silently dropped**. LocalAI's `AnthropicContentBlock` has
no such field; text-generation-webui's 468-line `anthropic.py` never mentions the string; a code
search across `ggml-org/llama.cpp` returns only HTTP `Cache-Control` headers. Every local prefix
cache is instead **automatic positional longest-prefix matching**, on by default, and free.

That is better news for this repo than it sounds. The discipline the four Anthropic breakpoints
force — a byte-stable prefix, append-never-edit, mode changes filed as trailing `{"role":"system"}`
messages rather than spliced into a cached region — is **exactly** what makes a positional prefix
cache hit. `buildConvoRequest` would send its `EPHEMERAL` markers into the void and the prefix would
still be reused. **The right conclusion is: do not restructure anything.** The one new obligation is
to audit what gets injected per request near the front of the prompt. SGLang's own documentation
tells users to set `CLAUDE_CODE_ATTRIBUTION_HEADER=0` because Claude Code injects a per-request hash
that changes the prefix on every call and destroys caching through gateways. Jan independently ships
the same defence, stripping `x-anthropic-billing-header` from incoming requests with the source
comment _"are dynamic, so leaving them in the content busts Anthropic prompt caching"_. **Two
unrelated projects have shipped code specifically to protect their prefix cache from bytes
Anthropic's own client injects**, which makes this an observed problem rather than a theoretical
one. A single varying byte near the front costs the whole cache.

The measured payoff is large enough to be the deciding factor: a 60k-token prompt on Apple silicon
took **84.2 s** cold and **~1.0 s** when the identical prefix hit the slot cache — an ~80× speedup,
against exactly this workload's shape.

### Cached-token reporting is the one thing that must be checked, and most servers fail it

[`charge()`](#the-agents-request-is-shaped-for-one-vendors-cache) is `input - cacheRead + output`,
so a server that caches beautifully but does not _say_ so bills this app's budget for work it never
did.

| Runtime               | Prefix cache                       | Reports cached tokens          |
| --------------------- | ---------------------------------- | ------------------------------ |
| **llama.cpp**         | default on, deepest knobs anywhere | ✅ real                        |
| **vLLM**              | default on, block-hash             | ✅ read **and** created        |
| SGLang                | RadixAttention + HiCache           | ✅ (shape unverified)          |
| llamafile             | = llama.cpp                        | ✅                             |
| LocalAI               | on since v4.3                      | ❌ on the Anthropic path       |
| KoboldCpp             | FastForwarding                     | ❌ **hardcoded 0**             |
| **Ollama**            | inherited; trie on the MLX path    | ❌ **hardcoded 0**             |
| **LM Studio**         | undocumented — no toggle, no claim | ❌ `prompt_tokens_details=None` |
| Jan / TGW             | presumed (llama.cpp underneath)    | unverified — **test it live**  |

Ollama's is the worst case and it is worth spelling out, because it is the runtime most people try
first: `openai/openai.go`'s `Usage` struct has no `prompt_tokens_details` at all, and
`openai/responses.go` emits `"input_tokens_details": {"cached_tokens": 0}` **hardcoded**, so a client
reads "no cache hits" regardless of reality. Against a `200k` budget, this app would spend ~7k
tokens of headroom per step on a prefix the server did not reprocess.

### `llama-server` is the recommendation, and it is not close

For a tool-heavy TypeScript agent on the author's own hardware, one runtime gives all four of the
things this repo needs and the others each miss at least one:

- **Tool calls that cannot come back malformed.** `common/chat.cpp` arms a **lazy grammar** —
  `grammar_lazy = has_tools && tool_choice == AUTO` — so prose flows free until the model starts a
  tool call, at which point the tool schema is enforced at sampling. `--jinja` is now default on.
  The handler zoo was rewritten in 2026: the format enum in `common/chat.h` is down to
  `CONTENT_ONLY`, `PEG_SIMPLE`, `PEG_NATIVE`, `PEG_GEMMA4`, `PEG_MINIMAX_M3`, with
  `chat-auto-parser.h` _deriving_ a parser by rendering the model's own Jinja template and diffing
  the output. ⚠️ `docs/function-calling.md` is stale and still describes the retired per-model
  handlers — cite `common/chat.h` and `tools/server/README.md` instead.
- **Guaranteed schema-valid JSON**, via built-in JSON-Schema→GBNF conversion exposed as
  `response_format: {type: 'json_schema'}`. Schemas with external `$ref`s need pre-converting.
- **Real `cached_tokens`**, so the budget arithmetic stays honest.
- **A clean 400 on context overflow.** `--context-shift` is now **default disabled**, so an
  over-long conversation returns `exceed_context_size_error` instead of silently dropping the head
  of the transcript. For an agent that is strictly better: a machine-readable signal rather than
  mysterious amnesia.

It also binds `127.0.0.1` by default, accepts multiple `--api-key` values, runs natively on Windows,
and — new in 2026 — has a **router mode**: launch with no model and it loads, unloads and forwards
per request (`--models-dir`, `--models-max` default 4 with LRU eviction, `--sleep-idle-seconds` to
unload after idle and reload on demand). That last flag is directly relevant to
[the box being asleep](#a-box-on-the-home-network). One default to change deliberately: **CORS is
wide open** (`--cors-origins *` with credentials enabled).

**llamafile** deserves a correction to the common assumption that it is dormant: it moved to
`mozilla-ai/llamafile`, ships 0.10.5 (3 August 2026), and is structured as ABI/packaging-only
patches over an upstream llama.cpp submodule with three upstream syncs in a fortnight. It is
effectively current `llama-server` in a single portable file, about a month behind master.

The rest, briefly. **vLLM** is the answer when one box serves several agents at once — continuous
batching roughly triples decode over llama.cpp on the same hardware, prefix caching is on by
default, and its Anthropic shim reports both cache-read and cache-created tokens. Its trap is that
`tool_choice: 'auto'` is **unconstrained text extraction** through a per-model `--tool-call-parser`
unless `strict: true` is set; if the model's format drifts you get prose. Linux + NVIDIA in
practice. **SGLang**'s RadixAttention is the most sophisticated cross-request prefix reuse in the
field and is the right choice for several concurrent conversations sharing a prefix. **LocalAI** is
the most operations-complete and is **the only server in this survey that sends `Retry-After`** —
three documented 503 cases, including a model-load-failure cooldown that doubles per consecutive
failure. **LM Studio** has the best model-lifecycle ergonomics (JIT load, per-request `ttl`,
auto-evict) and four API surfaces, of which `/v1/chat/completions` or `/v1/responses` are the right
doors because `/api/v1/chat` cannot take caller-supplied tools. But a grep of its complete 563 KB
docs corpus returns **zero hits** for "prompt cache", "prefix cache" or "cached_tokens", and zero for
429, 503 or `Retry-After`; `/v1/chat/completions` returns `prompt_tokens_details=None` outright. Its
engine is llama.cpp so reuse is almost certainly happening, but there is no toggle, no claim and no
way to observe it except by timing TTFT — which makes the nicest developer surface here the worst
fit for the one thing this question turns on. (Its tool-call ids are also bare numeric strings like
`377278620`, so anything pattern-matching OpenAI's `call_` prefix breaks.) **KoboldCpp**
grammar-forces tool calls by default but
hardcodes the tool-call id to `call_001`, so parallel calls collide — fatal for any client keying
results by `tool_call_id`, which `NativeAgentBackend` does.

**Ollama is the one to avoid for this workload**, which is worth saying plainly because it is the
default suggestion everywhere. Since v0.30.0 it no longer has its own inference engine — it spawns
upstream `llama-server` as a subprocess — but it exposes almost none of its knobs and on at least
one path passes `--no-jinja --chat-template chatml`, doing its own templating and tool parsing in
Go rather than inheriting the lazy-grammar work. Two things disqualify it here specifically:
**`tool_choice` is not supported at all** (its own compatibility checklist says so), and
`cached_tokens` is hardcoded to zero. It also ships with **no authentication of any kind**, by
design.

### Platform narrows the field harder than capability does

Most of the above assumes Linux. On **Windows**, which is where this repo is developed and where a
good share of its users will be, the list shortens sharply: **vLLM and SGLang are Linux+NVIDIA in
practice** (Windows is WSL-only), **LocalAI has no native Windows story** at all, and **llamafile
0.10.x has no GPU support on Windows** — its own `README_0.10.0.md` says so, in the same "what's
missing" list that notes the `pledge()`/SECCOMP sandboxing it was famous for is not back either — so
on Windows the portable single file is CPU-only. What is left is `llama-server` built or downloaded
directly, LM Studio
(giving up cache observability entirely), and **KoboldCpp**, which is genuinely Windows-native with
grammar-forced tool calls and clean 503 backpressure — at the cost of that hardcoded `call_001`.

Two smaller licence and shape notes. **text-generation-webui is AGPL-3.0**, the only copyleft
licence in this survey and material to anyone hosting it; it also has **no `response_format` field
at all** (a per-request `grammar_string` instead, hand-authored GBNF) and its streaming tool calls
are **not incremental** — generation stops on detection and everything arrives in one final chunk.
**LocalAI is MIT** and does compile both `json_object` and `json_schema` to GBNF, but only on its
llama.cpp backend.

### What overload and failure look like, which is not what this repo expects

`isTransient` (`packages/providers/src/backends/transient.ts`) treats **429** and 5xx as retryable
and reads `Retry-After`. Locally, **429 barely exists**: it was found only on Ollama's cloud path.
The local overload signal is **503** — `llama-server` returns `unavailable_error` while a model is
loading and otherwise **queues** (with `GET /slots?fail_on_no_slot=1` as the explicit "don't make me
wait" probe); KoboldCpp returns a clean 503 when busy; LocalAI returns 503 with a real `Retry-After`.
The existing classifier catches all of these through `retryableStatus`, so nothing breaks — but
`retryAfterMs` will almost always come back `undefined`, and the app will fall back to its own
backoff. The other half is that `-to/--timeout` on `llama-server` defaults to **3600 seconds**, so a
request that goes wrong locally does not fail fast; that is this repo's problem to solve, since it
sets no timeout of its own.

## The models, surveyed

**The local-scale tier crossed a threshold this year, and the reason is architectural rather than a
bigger number.** A year ago the thing that killed a long tool-heavy conversation on one consumer
card was not the weights — it was the KV cache. A conventional dense 32B at 128k context needs
**32 GiB of KV cache**, more than its own quantised weights and more than a 4090 has in total. The
2026 models in this class put full attention on only one layer in four or one in six, with
linear, Mamba or sliding-window layers in between, and the cache collapses accordingly. That change
is invisible from a parameter count, and it is the single fact that makes this question answerable
at all.

The other half of the picture is less encouraging. **The Western open-weight frontier has largely
stopped.** Meta published nothing under the Llama name after Llama 4 Scout/Maverick (last updated
22 May 2025); OpenAI's `gpt-oss-120b`/`20b` are unchanged since August 2025. The open frontier is
Chinese and has gone to 750B–2.8T parameters — Kimi K3, Qwen3.8-Max, DeepSeek-V4-Pro, GLM-5.2 —
none of which is a local model at any tier a person owns. What is left in between is a genuinely
good 25–35B band, and that band is the whole of the practical answer.

### The candidates

Figures are `[SOURCED]` from Hugging Face cards, `config.json` files or official leaderboards on
18 August 2026 unless marked otherwise. Benchmark rows are **vendor self-reported**; treat them as
ordering hints, not measurements.

| Model                       | Params            | License            | Context   | The number that matters here                          |
| --------------------------- | ----------------- | ------------------ | --------- | ----------------------------------------------------- |
| **Muse-Glimmer-30B** (Meta) | 30B dense         | Apache-2.0         | 131k      | MCP-Atlas **75.5** — best at local scale by 13 points |
| **Qwen3.6-27B**             | 27B dense-hybrid  | Apache-2.0         | 262k → 1M | Terminal-Bench 2.0 **59.3**; MMMU 82.9 for vision     |
| **Qwen3.8-27B**             | 27B dense-hybrid  | Apache-2.0         | 262k → 1M | Terminal-Bench 2.1 **73.0**, OSWorld-Verified 84.3    |
| **GLM-4.7-Flash**           | 30B / 3B active   | MIT                | 131k      | **τ²-bench 79.5** — the only direct multi-turn number |
| **Qwen3.6-35B-A3B**         | 35B / 3B active   | Apache-2.0         | 262k      | vision included, and 2.5 GiB of KV at 128k            |
| **Gemma-4-26B-A4B**         | 25B / 3.8B active | Apache-2.0         | 262k      | no tool-use benchmark published at all                |
| **Nemotron-3-Nano-30B-A3B** | 30B / 3.5B active | NVIDIA Open Model  | 1M        | BFCL v4 53.8 — the weakest of the group               |
| **Qwen3.5-9B**              | 9B                | Apache-2.0         | 262k → 1M | IFEval 91.5, BFCL-V4 66.1 — the small-job model       |

Two notes on that table. **Meta did not exit open weights, it renamed** —
`meta-models/Muse-Glimmer-30B` shipped on 9 August 2026 under a plain Apache-2.0 licence, with
first-party GGUFs and 380k+ downloads in its first week. And **BFCL has gone stale** as the field's
tool-use benchmark: the Gorilla leaderboard's last update reads 2026-04-12 and current cards have
stopped reporting it. The two benchmarks worth reading for this app's shape are **τ²-bench**
(multi-turn tool use against a policy document) and **MCP-Atlas** (1000 human-authored tasks over 36
real MCP servers with 220+ tool definitions and deliberate distractors) — the second being the
closest published proxy for "42 tool schemas, forty steps, don't derail".

### The KV table is the headline

`[COMPUTED]` from sourced `config.json` files, fp16 KV:

| Model                      | Full-attention layers          | KV/token | 32k      | **128k**  |
| -------------------------- | ------------------------------ | -------- | -------- | --------- |
| Nemotron-3-Nano-30B-A3B    | 6 attention layers             | ~6 KiB   | 0.19 GiB | **0.75**  |
| Muse-Glimmer-30B           | 13 of 52 (2 kv, d128) + 39 SWA | 13 KiB   | 0.48 GiB | **1.70**  |
| Qwen3.6-35B-A3B            | 10 of 40 (2 kv, d256)          | 20 KiB   | 0.63 GiB | **2.50**  |
| Gemma-4-26B-A4B            | 5 of 30 (8 kv, d256) + 25 SWA  | 40 KiB   | 1.45 GiB | **5.20**  |
| GLM-4.7-Flash (MLA)        | 47 × 576 latent dims           | 53 KiB   | 1.65 GiB | **6.61**  |
| Qwen3.6-27B / Qwen3.8-27B  | 16 of 64 (4 kv, d256)          | 64 KiB   | 2.00 GiB | **8.00**  |
| _a conventional dense 32B_ | 64 of 64 (8 kv, d128)          | 256 KiB  | 8.00 GiB | **32.00** |

A trap worth naming: **"sliding window" does not imply "cheap".** Gemma-4-**31B** costs 20.8 GiB at
128k despite its sliding-window design, because its ten global layers carry sixteen KV heads at
head_dim 256 — four times what GLM-4.7-Flash pays.

### What fits, with vision, at full context

`[COMPUTED]` from sourced GGUF file sizes plus the table above. "With vision" means the `mmproj`
projector is loaded too, which is what a local `ChatVisionReviewer` would need.

| On one 24GB card, at 128k | Weights + projector | KV        | Total                          |
| ------------------------- | ------------------- | --------- | ------------------------------ |
| Muse-Glimmer-30B          | 18.16               | 1.70 fp16 | **19.9 ✓** (21.5 with drafter) |
| GLM-4.7-Flash (no vision) | 18.30               | 3.30 q8   | 21.6 ✓                         |
| Qwen3.6-27B               | 17.75               | 4.00 q8   | 21.8 ✓                         |
| Gemma-4-26B-A4B           | 18.09               | 5.20 fp16 | 23.3 ✓, tight                  |
| Qwen3.6-35B-A3B           | 23.03               | 2.50 fp16 | 25.5 ✗ — needs 32GB            |

**32GB is the sweet spot, and 48GB buys surprisingly little**: the next real step up
(GLM-4.5-Air at ~73 GB, `gpt-oss-120b` at ~63 GB) needs 96GB. What 48GB actually buys is Q8 instead
of Q4, or a second model resident — which for this app is the more useful purchase, because the
agent and a vision reviewer would otherwise evict each other.

### The failure mode is the tool parser, not the weights

This is the finding that most changes what a first integration should look like. vLLM published a
post-mortem in which self-hosted Kimi K2 tool calling succeeded on **fewer than 20% of calls** —
218 of 1200-odd — from three bugs in the serving layer: `add_generation_prompt` silently dropped,
empty-content history turns mishandled, and an over-strict tool-call-ID regex. After the fixes,
99.9%. Nothing was wrong with the model.

Two specifics would bite this repo directly. `llama.cpp`'s `docs/function-calling.md` named-support
list is badly out of date, so anything newer than its examples falls back to a **generic** handler
that the docs themselves warn "may consume more tokens and be less efficient than a model's native
format" — and parallel tool calls are off by default. And `Muse-Glimmer-30B` does not emit JSON tool
calls at all: it uses an XML protocol Meta calls **ATEM**, which the serving stack must parse back
into a `tool_calls` array. That one cuts both ways here — an XML-delimited parameter is _more_ robust
than JSON for the long prose arguments `insertLines` and `edit_file` carry, because one unescaped
quote cannot invalidate the whole call.

### The two small jobs

**Approval triage** (`TRIAGE_MODEL = 'claude-haiku-4-5'`, `packages/authoring/src/approve.ts`) is a
bounded reading-comprehension question with a three-field schema, and it is the best-matched local
job in the repo. **Qwen3.5-9B at Q8 (9.53 GB)** is the pick. Grammar-constrained decoding would make
the JSON mechanically valid, and four documented caveats apply — the first of which ruins it
silently: `llama.cpp` constrains output tokens but **does not inject the schema into the prompt**, so
a constrained model that was never told the field names returns syntactically perfect,
semantically garbage JSON. Constraint also costs latency (one study measured 3.6×) and can subtly
hurt value accuracy, because a grammar walks characters while the model was trained on
multi-character tokens. **Syntax is solved; values are not.** Worth noting that this repo would not
strictly need the grammar at all: `withStructuredRetry` already gets three attempts at
`extractJson`, so constrained decoding is an optimisation here rather than a prerequisite.

**Vision critique** (`ChatVisionReviewer`, two reviewers by default) comes with a finding that
matters more than the model choice. SalArt-VQA (arXiv 2606.12671) built a 950-image,
3,681-question diagnostic of exactly this shape and found the strongest model reaching **99.37%
detection recall** while answering all four artifact sub-questions correctly on only **53.26%** of
images. Open VLMs are excellent at _is there a defect_ and much worse at _where, and what kind_.
`REVIEW_SYSTEM` today asks for an open-ended defect list; against a local VLM that wants decomposing
into category-specific questions. Qwen3.6-27B has the best vision scores in this survey — MMMU 82.9,
and RefSpatialBench 70.0 against Gemma-4-31B's **4.7** on the same spatial-referring test — and if
it is already loaded as the agent, it is free.

## Local image models, surveyed

**The seam already matches, the quality gap is smaller than folklore, and the economics argue
against doing it for the money.** Those three findings pull in different directions and it is worth
separating them before any of the detail.

The seam matches almost exactly. `edit(base, prompt, refs, params)` is implemented in `gemini.ts` as
literally `run([base, ...refs], prompt, params)` — base prepended to the reference list — which is
the shape of an in-context multi-reference edit model rather than anything Gemini-specific. Several
open-weight models take exactly that input today.

The quality gap has moved. On the Artificial Analysis Image Editing Arena, fetched 18 August 2026:

| Model                            | Elo      |                                      |
| -------------------------------- | -------- | ------------------------------------ |
| Nano Banana 2 (Gemini)           | 1249     |                                      |
| Nano Banana Pro                  | 1244     |                                      |
| HunyuanImage 3.0 Instruct        | 1224     | 80B MoE, needs 8×80GB — not local    |
| **HiDream-O1-Image**             | **1193** | MIT, 8B, genuinely local             |
| Nano Banana (Gemini 2.5 Flash)   | 1180     | **the default in `project.yaml`**    |

Read the last two rows together. `models.image` defaults to `gemini-2.5-flash-image`, and **two
open-weight models score above the model this app ships with.** The gap being closed is to Nano
Banana 2, not to the current backend.

The academic picture is harsher and older. MICON-Bench, on multi-reference instruction consistency,
puts GPT-Image at 91.51 and Nano-Banana at 89.25 against BAGEL 73.55, OmniGen2 67.83 and UNO 44.76 —
a 17–24 point gap. But it tested only the now-superseded 2025 open tier; **no multi-reference
academic benchmark run that includes HiDream-O1 or FLUX.2 could be found.** The arena says ~55 Elo,
the papers say 20 points, and they are measuring different vintages. The true gap is somewhere in
between and nobody has published it.

### The models

| Model                    | Released   | Params  | License                       | Practical VRAM              |
| ------------------------ | ---------- | ------- | ----------------------------- | --------------------------- |
| **HiDream-O1-Image**     | 2026-05-08 | 8B      | **MIT**                       | ~24GB class                 |
| **Qwen-Image-Edit-2511** | 2025-12-23 | 20B     | **Apache-2.0**                | 40GB+ bf16; Q4 GGUF in 24GB |
| **Qwen-Image-2512**      | 2025-12-31 | 20B     | **Apache-2.0**                | as above                    |
| **FLUX.2 klein 4B**      | 2026-01-15 | 4B      | **Apache-2.0**                | ~13GB (see below)           |
| FLUX.2 klein 9B          | 2026-01-15 | 9B      | Non-commercial                | 32–48GB                     |
| FLUX.2 [dev]             | 2025-11-25 | 32B     | Non-commercial weights        | 80GB+ bf16                  |
| **Z-Image-Turbo**        | 2025-12    | 6B      | **Apache-2.0**                | 16GB                        |
| Chroma1-HD               | 2025       | 8.9B    | Apache-2.0                    | 24GB                        |
| HunyuanImage 3.0         | 2025-09    | 80B MoE | Hunyuan (excludes EU/UK/KR)   | ≥8×80GB — not local         |

The licence trap worth internalising: FLUX's licence separates **weights** from **outputs**, and
says outputs may be used commercially even where the weights are non-commercial. Read the text
before it matters, but it means "non-commercial weights" is not automatically disqualifying. Every
Qwen image model, FLUX.2-klein-4B, HiDream, Z-Image and Chroma are Apache-2.0 or MIT and raise no
question at all. Two things that turn up high in search results **do not exist**: there is no "Stable
Diffusion 4" and no "NVIDIA Cosmos3-Super-Text2Image". Both are content-farm inventions.

**For anime specifically there is an awkward split.** SDXL still owns the booru-tagged,
artist-tag-aware finetune ecosystem — Illustrious, NoobAI, WAI, Animagine — and none of the 2026
flagships have displaced it for _style_. But SDXL derivatives have the worst multi-reference support
of anything here, and the models with excellent multi-reference support are photographic-leaning
generalists. A VN pipeline wants both halves and no single model has them.

### Reference images, which is the part this app actually needs

`refsOfSlot` produces **two to five references per shot** — plate, one portrait per subject, plus a
front-angle model sheet for any subject out of their default outfit. Against that number:

- **FLUX.2** takes up to **10** references natively. Most headroom.
- **HiDream-O1-Image** has a ComfyUI-native `HiDreamO1ReferenceImages` node and is the only model
  with published multi-subject scaling data — 7.95 / 7.47 / 7.65 on UniSubject at 2–3, 4–8 and 9–11
  subjects. It does not collapse as subject count rises, which is unusual and directly relevant.
- **Qwen-Image-Edit-2511** takes **1–3** trained references (`QwenImageEditPlusPipeline` accepts
  `image=[a, b]` as a list). That is **below this app's worst case**: a two-character shot with both
  in non-default outfits is five refs, and Qwen would need references dropped or merged.

**The adapter ecosystem this question usually assumes is dead.** IP-Adapter, InstantID, PhotoMaker,
PuLID and InfiniteYou have all been dormant since 2024, and all exist only for SD1.5/SDXL plus
FLUX.1-dev. **There is nothing for FLUX.2, Qwen-Image, SD3.5 or HiDream.** The adoption gap is
stark — `unsloth/Qwen-Image-Edit-2511-GGUF` has ~236,000 downloads against `ByteDance/InfiniteYou`'s
**912**. The field moved from bolt-on identity adapters to models that take references natively, and
the adapters did not follow. Separately and fatally for a VN: the FaceID family is built on
ArcFace/InsightFace embeddings, which are **photographic face recognisers that do not work on anime
faces at all**.

ControlNet is healthier — a union ControlNet (canny/softedge/depth/pose) exists for Qwen at ~30k
downloads, and Qwen-Image-Edit folds control natively — but it is dead on SD3.5 and absent on
Chroma. It would be genuinely useful to this app for **staging** (pose and framing per shot) even
though it does nothing for identity. Per-character LoRA is the other classic answer: 15–30 images,
1500–2500 steps, about **1.5 hours on a 4090** for a rank-4 FLUX LoRA. It has a bootstrap problem
this app feels acutely — you need 15–30 consistent images of a character before you can train the
thing that makes images consistent — and the standard workaround (generate with refs, hand-cull,
train) is roughly a day per character.

**The verdict, stated as plainly as the evidence allows.** One character, controlled staging, a
consistent outfit: **yes**, a local stack reaches usable quality. Two named characters in one frame,
each in a specified outfit, across hundreds of shots: **no, not without human review.** That is
where every open stack still fails, and it fails in the expensive way — identity bleed between the
two, and outfit attributes migrating from one to the other. Budget a **10–15% reject rate**, so
40–60 hand-repaired frames on a 400-shot project. The P7 refine loop absorbs some of that
automatically, but a vision critic that reliably catches "character B is wearing character A's
jacket" is itself a hard ask — [the SalArt-VQA finding](#the-two-small-jobs) says why.

### Driving one from a program

This is where the answer improved most, and the surprise is that **ComfyUI is now a specified API
rather than a UI with a socket**. The repo moved to `Comfy-Org/ComfyUI` and ships an `openapi.yaml`
(OpenAPI 3.0.3, ~60 paths) that is **linted in CI** by spectral with `--fail-severity=error`. There
is a job namespace (`GET /api/jobs`, `/api/jobs/{id}`, `POST /api/jobs/{id}/cancel`) with a unified
status vocabulary, typed errors the spec says to distinguish by `error.type` rather than by parsing
messages, and — the detail that lines up unusually well here — **client-supplied job ids**:
`POST /prompt` accepts a `prompt_id` you generate, stored and compared verbatim downstream. This app
already has content-addressed slot hashes to hand it. Assets are blake3-hashed and deduped on
upload, which is the same idea as `packages/store`'s own addressing.

There is now an official TypeScript client, `@comfyorg/sdk`, generated from that spec with a
`check:spec-drift` script, plus `comfy-api-proxy` (MIT) to point it at a local install with no API
key. The caveats are real: the SDK is **0.1.7, first published 21 July 2026**, single-digit stars,
one breaking constructor change already; inputs are still **node-id addressed**, so the workflow
JSON must be pinned in-repo with exactly one file knowing that node "10" is the ref loader; and the
`openapi.yaml` is linted for validity but never diffed against `server.py`, so spec drift would not
fail CI. Note also that ComfyUI "API nodes", now **Partner Nodes**, are the opposite of what this
needs — they call _out_ to hosted commercial models from inside a workflow, on prepaid credits.

The rest of the field, briefly. **A1111 is effectively over** (last push 2026-03-02, no release
since v1.10.1) and **Forge has been dormant a year**; its `/sdapi/v1/txt2img` surface was never
specified, and reference images live in an `alwayson_scripts` bag whose contents depend on which
extensions the user installed — which would couple this repo's request body to the author's plugin
set, and is disqualifying on its own. **InvokeAI** has the best-documented API of the lot and the
wrong shape: a batch is a node graph, same construction burden as ComfyUI with a smaller ecosystem
and no official TS client. **SwarmUI** works but hides prompt, seed, dimensions and init image
inside `rawInput`, an untyped JObject, and returns paths rather than bytes; it does expose
`PromptImages` as a list, which is the multi-ref door. **`sd-server`** from `stable-diffusion.cpp`
is the only local server verified to speak both `POST /v1/images/generations` **and**
`POST /v1/images/edits`, with `init_image`, `mask_image`, `control_image`, base64 refs, seeds and a
structured LoRA array — GGUF-quantised, so the quality ceiling and model freshness lag the PyTorch
stacks. **LocalAI is a documented negative**: `core/http/routes/openai.go` registers
`/v1/images/generations`, `/inpainting` and `/upscale` and **no `/v1/images/edits`**; it does support
references, just not through an OpenAI-shaped door. **Ollama has no image generation at all**, and
vLLM and SGLang are token servers — vision means images in, tokens out.

And the honest alternative: **`diffusers` behind ~300 lines of FastAPI is the only path where
`edit(base, prompt, refs, seed)` is literally the function signature.** For a pipeline that needs
exactly two operations, that is competitive with adopting ComfyUI's whole graph model; the cost is
owning model loading, VRAM management, queueing and OOM recovery.

### Speed, and the seed problem

Measured, FLUX.1-dev at 1024² / 30 steps under TensorRT: RTX 5090 FP4 **3.9 s**, FP8 6.7 s,
FP16 10.9 s; RTX 4090 FP16 10.6 s. FLUX dev fp8 under ComfyUI at 20 steps: 5090 **5.5–8.8 s**,
4090 11.3 s, 3090 26 s. SDXL at 1MP / 20 steps on a 5090: **2.2 s**. At roughly 6 s an image, a
1250-image project is **about two hours of GPU time** — plus the refine loop and the manual repairs.
That is the real argument for local art: not cost, but the freedom to re-roll a shot forty times
without watching a meter. **Apple silicon is unvalidated here** — no trustworthy measured figure was
found, and there is a live correctness bug (ComfyUI #14837) producing silent corruption on MPS when
an attention matrix exceeds ~2³¹ elements, which is the worst kind.

The seed finding is the one that would impose a real design change on this repo, and it cuts against
the optimism in [Reproducibility of a seed](#reproducibility-of-a-seed) above. Bit-identical output
is the normal case within one frozen stack and is guaranteed by nobody across anything else: PyTorch
guarantees nothing across releases or platforms as stated policy, and ComfyUI's own `--deterministic`
help text says it "might not make images deterministic in all cases" (its issue #375 has been open
since April 2023). What breaks it is mundane — memory offload kicking in, LoRA plus fp8 plus dynamic
allocation, `torch.compile`, attention-backend or dtype changes, and **batch size, which is part of
image identity, so pin it to 1**. There is also a permanent cross-tool landmine: ComfyUI generates
initial noise on **CPU** by default and A1111 defaults to **GPU**, so the two will never agree on a
seed for the same model and prompt.

**The consequence for `sha256(kind, inputs)` is direct.** If a task hash is to keep meaning "these
bytes", a local image backend's params must include a **stack fingerprint** — model file hash, torch
version, CUDA version, attention backend, dtype, batch size, GPU architecture — because otherwise a
driver update either silently invalidates every cached asset or, worse, does not, and the drift is
invisible. This is the one place where going local is not a drop-in.

### The part nobody puts in a table

**Local has no content filter, and that is the strongest non-economic argument in this whole
document.** Google's Imagen `personGeneration` defaults to `allow_adult` and `allow_all` is banned
in the EU, UK, Switzerland and MENA; all Gemini image output carries SynthID watermarking; and
Google began blocking Disney-related prompts on 9 February 2026 following a cease-and-desist —
a concrete instance of cloud policy changing mid-project, without notice, under a half-finished
project. On the open side, Qwen's Apache-2.0 carries no content clause at all, Chroma states plainly
that it "has not been aligned with a specific safety filter", and FLUX.1-dev forbids a short,
specific list. The counter-intuitive one: **Stability's AUP is the strictest of the open tier** and
forbids sexual content outright, so for an adult VN the SD family is contractually the wrong choice
even though it is technically the most permissive. And generation is not distribution — Civitai's
2025 payment-processor cascade is the clearest recent proof that "you can generate it locally" does
not mean "you can host, distribute or monetise it".

## A box on the home network

Moving the model off the authoring machine changes surprisingly little about the protocol and a
great deal about the failure modes. Same-machine and same-LAN are the same integration; what
differs is what happens when the other end is not there.

**Configuration.** The missing field is a URL, and it belongs in `project.yaml` next to the model
ids rather than in `keys/`. Something like an `endpoints:` block mapping a vendor name to a base
URL, so `models.text: local/qwen3-...` resolves through it. Two consequences worth naming before
anyone writes it: a project is **committed**, so a base URL in `project.yaml` is a LAN address
shared with anyone the repo is shared with — mild, but it is the first host-specific fact the
config would carry — and `chatVendorFor`'s prefix rule would finally need an "unknown" branch,
because today an unrecognised id silently means Gemini.

**Discovery is not worth building.** Ollama, llama.cpp and LM Studio all default to a fixed port
on `127.0.0.1`; on a LAN the author knows the box's name. A hand-typed URL with a "test connection"
button that calls `GET /v1/models` is the whole feature. mDNS/Bonjour browsing would be a lot of
machinery to save one line of typing, and it is the sort of thing that breaks on exactly the
networks people have at home.

**Keys stop being the right vocabulary, and then partly come back.** A LAN server usually has no
auth, which is fine on a home network and is why most of them ship that way. But `llama-server`,
vLLM and LM Studio all accept a static bearer token, and anyone exposing a box beyond their own
LAN should set one. So the honest answer is that the *key* concept survives as optional, while the
*vendor → env var* mapping does not: what identifies a local endpoint is its URL.

**Timeouts are the first real problem.** `grep -rn "timeout\|AbortSignal\|signal" packages/providers/src`
returns nothing — this repo sets no request timeout anywhere and passes no abort signal. Today
that is invisible, because the vendor SDKs carry their own defaults and cloud calls answer in
seconds. A local image generation is tens of seconds to minutes, a long-context prefill on a
loaded box can be minutes, and a cold model load is minutes more. A local backend has to set its
own generous timeout explicitly, and there is currently nothing to cancel a request with when the
author closes the pane.

**Concurrency is the second, and it is worse.** The scheduler runs ready tasks in parallel up to
`config.concurrency`, default **4**, and each shot task then fans out to every configured vision
reviewer in parallel. Four concurrent image generations plus eight concurrent vision calls is
nothing to a cloud endpoint and is a queue on a single GPU — at best. Servers differ in how badly:
a continuous-batching server (vLLM, SGLang) degrades gracefully, `llama-server` needs `--parallel`
set and splits its KV cache between slots, and a diffusion front-end typically serialises outright.
Two things follow. The concurrency cap is per-project and global, so it cannot express "4 against
the cloud, 1 against the GPU"; and **a single local GPU serving both the image model and a vision
reviewer will thrash**, because the two models cannot both be resident.

**Prefix caching interacts badly with concurrency**, which is the non-obvious one. A local server's
prefix cache is a KV cache tied to a slot or a radix tree over recent requests. Interleaving other
work evicts the agent's prefix, so the agent's cache-hit rate is a function of what else is on the
box. The cloud path has no such coupling: an Anthropic cache breakpoint is a five-minute
server-side TTL that nothing local can evict.

**When the box is asleep or gone**, the failure arrives as `ECONNREFUSED` or a socket timeout, and
`isTransient` in `packages/providers/src/backends/transient.ts` already matches both
(`ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`). That is right for a server that is starting up and
wrong for one that is switched off: `callWithRetry` will spend three attempts, and the agent loop's
`onApiError` recovery will keep offering to retry up to `MAX_API_ATTEMPTS = 50` with backoff capped
at a minute. It will fail correctly and take a long time doing it. A local backend wants a short
connect timeout and a distinct, honest message — _nothing is listening at `http://vega:8080`_ —
rather than the generic transient path, because the fix is to go and turn the machine on and no
amount of waiting substitutes.

**A model still loading is the case nobody expects.** Ollama and LM Studio will load a model on
first request, which can take tens of seconds for a large one; a request that arrives during that
window may hang or may return a 503. That is genuinely transient and the existing classifier
handles it — provided the timeout is long enough to survive it, which brings it back to the first
problem.

## Cost, quality, speed, and the parts that are not money

### Money

**Put a number on it first, because the number ends the argument.** A VN of the size this repo is
built for is roughly 1,250 images — sheets, portraits, plates, ~400 shots, plus refine attempts. At
`gemini-2.5-flash-image`'s $0.039 an image that is **$25–50**, and half that on the batch tier; at
Gemini 3 Pro Image's $0.134 it is ~$170. **The entire cloud art bill for the entire project is less
than a GPU.** Local art wins on iteration volume, content policy and reproducibility. It does not
win on money, and pretending otherwise makes the real arguments harder to hear.

The text side is less clear-cut, because the authoring agent's cost is per token and recurs with
every conversation rather than once per picture. But the crossover is still not where the enthusiast
forums put it, for two reasons this repo can name specifically.

First, **the app already tries hard not to spend twice**. Task identity is
`sha256(kind, inputs)`, `state/tasks.jsonl` replays, and a resumed run skips `done` work. Base art
lives in its own root and is not regenerated. The refine loop stops early when a critique repeats
unchanged, precisely so that a re-roll is not bought on a lottery ticket. A pipeline that is
careful with money is a pipeline whose cloud bill is smaller than the naive estimate, which pushes
the crossover out.

Second, **the app cannot currently tell the author what anything costs.** `TokenUsage` counts
tokens, not currency, and [`a-less-technical-mode.md`](a-less-technical-mode.md) already records
the consequence — the app can name call counts but never money. So "local is cheaper" is not
something this codebase can demonstrate to its own user today, in either direction.

### Quality

For the small, well-bounded jobs — approval triage, an entity extraction, a one-line description —
a good small open-weight model is close enough to indistinguishable, and the app's structure
protects the rest: `withStructuredRetry` gives three attempts, `narrowTriage` throws away anything
not on the host's list, and the author confirms the card. For the **authoring agent**, the gap is
not close, and it is a gap in exactly the dimension that is hardest to fix — staying coherent over
forty tool calls without derailing, hallucinating a tool, or forgetting what it already read.

For **art**, the gap is different in kind rather than degree, and it is discussed under
[Local image models](#local-image-models-surveyed).

### Speed

The cloud path's wins are parallelism and prefill. Four concurrent shot generations plus eight
concurrent vision calls, and a 7k-token cached prefix that costs nothing to re-send. A single local
GPU has neither: the concurrency collapses to a queue, and every step re-prefills whatever the
server's prefix cache did not keep. The local path's win is latency floor — no network, no queue
behind other customers, no rate limit — which matters most for the small frequent calls and least
for the big ones.

### Privacy, and why this repo should care more than most

**Nothing leaves the machine** is the strongest argument for the local path here, and it is
strongest because the repo has already taken a position on it. `keys/` is gitignored and key values
are never logged. The difficult-agent report
([`../plans/reporting-a-difficult-agent.md`](../plans/archive/reporting-a-difficult-agent.md)) is explicitly
"the author's own key, on the author's own machine", with a redactor that replaces the fiction's
names **at the boundary rather than in a prompt**, because a prompt is a request and a boundary is
a guarantee. `@vn/bible` has no whole-file API and that absence is the guarantee.

A project in progress is an unpublished novel. Every scene, every character, every draft that was
thrown away goes to a vendor today. That is a defensible trade and most authors will take it, but
it is a trade, and a local option is the only thing that makes it a choice. It is also the one
argument that does not depend on any number in this document being right.

### Offline

The pipeline is the interesting half here. `vngen run` against a local stack works on a train; so
does the agent. The parts that would still need a network are none of them model calls — git
remotes, and the GitHub issue link at the end of a difficult-agent report.

### Reproducibility of a seed

Worth being precise, because the intuition is backwards. `ImageParams.seed` is hashed into task
identity and the app treats a seed as an authored field (zero is a seed, so every test is
`=== undefined`). But a cloud image model's seed is a *request parameter*, not a promise: the same
seed against a silently updated endpoint is different bytes, and the app would not know. A local
model's weights are a file on disk that nobody can change underneath the author — so **the local
path is the only one where a seed can mean what the hash implies it means.** The caveats are real
but smaller: sampler and scheduler settings must be pinned alongside the seed, and
attention-backend and GPU differences can perturb the last bits. Worth verifying rather than
assuming.

### Maintenance

The burden is not the integration, which is a few hundred lines. It is that a local stack is a
version matrix the author now owns — runtime, model file, quantisation, sampler, and for images a
graph of nodes and adapters — and that the repo would acquire a support surface where every failure
looks like an app bug. The cloud path has one failure mode ("the key is wrong" or "the vendor is
down") and the local path has thirty. That cost is paid by whoever answers the questions, and it is
the strongest argument for keeping the first local integration small and clearly labelled.

## What I would do, in order

Six steps, each of which is useful on its own and none of which commits to the next. The ordering is
by _how much is learned per unit of risk_, not by how much of the app is converted.

**1. Give the config somewhere to put a URL, and make an unknown model id an error.** This is the
prerequisite for everything else and is worth doing even if nothing local ever ships, because
`chatVendorFor`'s silent Gemini fallback is a live footgun today: a typo in `models.text` bills a
different vendor rather than failing. An `endpoints:` block in `project.yaml` mapping a vendor name
to a base URL, a third arm in `chatVendorFor`, and the duplicate copy of that rule in
`apps/authoring/src/agent.ts` collapsed into the real one. Note that `project.yaml` is **committed**,
so a LAN address in it is shared with whoever the repo is shared with.

**2. Point the approval triage model at a local server.** `TRIAGE_MODEL` is a fixed
`claude-haiku-4-5` today, built by the host in `session.ts` and in `ApprovalControl.triage()`. It is
the best first target in the repo and the reasons are structural, not sentimental: it is a single
`message()` call with no tools; its schema has three fields; `narrowTriage` throws away anything the
model invents; `offlineTriage` already exists as a deliberately dumb baseline to compare against;
and the author confirms the card afterwards regardless. **Qwen3.5-9B at Q8 (9.53 GB)** under
`llama-server`, with the schema described in the prompt as well as constrained — that last clause is
where this normally goes wrong. Success criterion: it agrees with the Haiku answer on a corpus of
the author's own real approval paragraphs. Failure costs nothing.

**3. Then the vision reviewers, and decompose the question while doing it.** `ChatVisionReviewer`
is the app's highest-volume model use — two reviewers per shot, up to four refine attempts — and it
is a `message()` call with images, so it needs nothing from the optional half of `ChatBackend`. Two
things make this the right second step. It is where local saves the most money per unit of risk, and
the SalArt-VQA finding (99.37% recall on _is there a defect_, 53.26% on all four sub-questions)
says `REVIEW_SYSTEM`'s open-ended defect list should become category-specific questions **whether or
not the model is local**. A local pass would improve the cloud path too.

**4. Only then the agent, and measure the cache before believing anything.** `chatConversation`
against a local `/v1/messages`, on `llama-server` because it is the only Windows-native runtime that
reports real `cached_tokens` and grammar-constrains tool calls so they cannot come back malformed.
Expect the first failure to be **the serving stack's tool parser, not the model** — vLLM's own
post-mortem had self-hosted tool calls succeeding on fewer than 20% until three serving-layer bugs
were fixed. Run a bake-off rather than picking from a table: **Muse-Glimmer-30B** (Apache-2.0, best
MCP-Atlas at local scale, cheapest KV, ATEM XML tool args that resist prose corruption),
**Qwen3.6-27B** (most mature llama.cpp support, best vision, so it doubles as step 3's model), and
**GLM-4.7-Flash** (the only published τ²-bench number, fastest decode). A day against the author's
own conversations will settle it better than any benchmark row above.

**5. The image backend last, behind the same seam, and never as a replacement.** One new file in
`packages/providers/src/backends/` and one dispatch in `factory.ts`; `runModelSheet` is the only
caller of `edit` and needs no change. Two things must go in before the first byte is generated. The
mock-art guard (`isPlaceholderImage`) lives inside `gemini.ts`'s `imagePart`, not in
`BackendImageProvider`, so a new backend that forgets it silently conditions work on coloured
rectangles — that check belongs in the shared layer. And the **stack fingerprint** must join
`ImageParams` in the dedupe hash, or a driver update either invalidates every cached asset or, worse,
does not. Transport: ComfyUI through `comfy-api-proxy` and `@comfyorg/sdk` if the ecosystem is worth
the graph model — its client-supplied job ids and blake3 content addressing line up unusually well
with this repo's own hashing — or ~300 lines of FastAPI over `QwenImageEditPlusPipeline`, which is
the only path where `edit(base, prompt, refs, seed)` is literally the function signature. Model:
**HiDream-O1-Image** first, because it is MIT, 8B, ComfyUI-native, scores above the Gemini model this
app currently defaults to, and is the only candidate with published multi-subject scaling data that
does not collapse at this app's five-reference worst case.

**6. Fix the operational gaps a local endpoint exposes, which are this repo's bugs either way.** No
request timeout and no `AbortSignal` anywhere in `packages/providers`; `config.concurrency` being a
single global number that cannot say "4 against the cloud, 1 against the GPU"; and `ECONNREFUSED`
from a switched-off box being classified as transient, so the app spends three attempts and then
offers fifty more with a minute of backoff, when the honest message is _nothing is listening at
`http://vega:8080`_.

**What not to do.** Do not replace the cloud path — add alongside it, because the strongest argument
for local here is that it makes privacy a **choice**, and a choice needs both options. Do not build
mDNS discovery; a typed URL and a `GET /v1/models` "test connection" button is the whole feature. Do
not reach for constrained decoding as a prerequisite — `withStructuredRetry` already gives three
attempts, so a grammar is an optimisation. And do not treat "local" as a variant of `--mock`: mock
art is deliberately **marked** so it can never be laundered into a real run, while local art is real
art, and conflating them would either poison the guard or forbid the feature.

## Open questions

The repo half of this document is checkable and was read rather than assumed. The survey half is a
snapshot, and the following are the places where it should not be trusted without a second look.

**Things nobody has measured.** The true 2026 multi-reference image quality gap is the biggest hole
here: the Artificial Analysis arena says ~55 Elo, MICON-Bench says 17–24 points, and they are
measuring different vintages — **no multi-reference academic benchmark run including HiDream-O1 or
FLUX.2 could be found at all**. Apple silicon image-generation speed likewise: no trustworthy
measured figure, and a live silent-corruption bug on MPS (ComfyUI #14837) means it should be
treated as unvalidated rather than slow.

**Vendor self-reporting.** Every benchmark row in [The models, surveyed](#the-models-surveyed) is
from the model's own card. Meta's MCP-Atlas 75.5 for Muse-Glimmer-30B carries the most weight in the
recommendation above and has **no third-party reproduction**. Qwen stopped publishing BFCL and
τ²-bench after Qwen3.5, so the tool-calling case for Qwen3.6/3.8 is inferred forward from
coding-agent proxies. Google publishes no tool-use benchmark for Gemma 4 at all, and Gemma 3 ranked
far below Qwen3 on BFCL — test before trusting.

**Serving details that would change a decision.** Whether vLLM or SGLang ship an **ATEM tool-call
parser** for Muse-Glimmer was not confirmed, and without one that model's tool calls do not become
`tool_calls` arrays. `llama.cpp`'s current default for `parallel_tool_calls` under the new PEG
parser architecture is unknown — the only source saying it is off is the stale
`docs/function-calling.md`. LM Studio's prefix-cache behaviour is undocumented in either direction
(no toggle, no claim, no counter), so the only way to know is to time TTFT against a live instance.
Two primary sources conflict on whether **headless Jan can serve at all**. And whether vLLM or
SGLang emit `Retry-After` under overload was not confirmed; `Retry-After` was found only in LocalAI,
by targeted grep rather than exhaustive proof.

**Numbers that look wrong.** Nemotron-3-Nano-30B-A3B at 24.6 GB for Q4_K_M is high for a 30B model
(expect 18–19), and GLM-4.5-Air at 73 GB is high for 106B (expect ~63). Both were sourced but should
be verified before a hardware purchase rests on them. BFL's own sources contradict each other on
FLUX.2-klein-4B's VRAM — ~8 GB on GitHub, ~13 GB on the model card and launch blog.

**Licences to read rather than take on trust.** FLUX's weights/outputs split — the claim that
outputs may be used commercially even where weights are non-commercial — is load-bearing for anyone
shipping a VN and should be read directly. Qwen3.8-Max's custom licence carries a revenue gate and
possibly a geographic one, depending on the source. Kimi K3's and MiniMax-M2.7's terms were not read.

**Things this repo would have to find out for itself.** Whether the authoring agent's actual
conversations — not a benchmark's — survive forty steps against a 30B model without derailing.
Whether the P7 vision critique can be decomposed into category questions without losing what
`mergeReports` and `stalledAfter` depend on. What `config.concurrency = 4` plus two vision reviewers
per shot actually does to one GPU, and whether the answer is "queue" or "thrash". And whether an
author who is offered a local option takes it, which is the only question here that no amount of
research answers.

**One thing that is stale by construction.** `llama.cpp/docs/function-calling.md` still describes a
per-model handler zoo that no longer exists in `common/chat.h`. Any local-model work in this repo
should assume its own documentation ages the same way, and cite source over docs.

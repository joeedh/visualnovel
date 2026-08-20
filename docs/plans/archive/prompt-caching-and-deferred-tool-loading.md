# Prompt caching and deferred tool loading

Status: **shipped**

The authoring agent bills roughly four times what it should on a small project. This plan
states why, and lands five workstreams that between them turn the agent's request into a shape
the Claude API can cache — and answers the question the plan exists to answer: **yes, this ends
with prompt caching actually working**, but only if the workstreams land in the order below,
because two of the obvious individual fixes silently cancel the caching out.

This plan has been pressure-tested; the findings are folded in below, and the record of what was
checked is
[`../../research/pressure-test-prompt-caching-plan.md`](../../research/pressure-test-prompt-caching-plan.md).

## What was measured, and what was reconstructed

Two conversations in `examples/test4` (`vngen/state/threads/*.jsonl`), on a project with eleven
characters and a handful of scenes:

| | thread 1 (22:42) | thread 2 (23:19) |
| --- | --- | --- |
| model calls | ≥ 53 | ≥ 28 |
| final transcript on disk | ≥ 16.6 KB | ≥ 18.7 KB |
| reconstructed input tokens billed | ~376k | ~205k |

**The last row is a reconstruction, not a reading, and nothing in the repo can currently produce
the real number.** That is why workstream A is first. Three separate reasons to hold it loosely:

- **Threads record no usage at all.** `ThreadLine` is a header, a `FeedItem` or a title
  (`apps/desktop/src/main/threads.ts:44-47`), and `Convo`'s own doc comment says so:
  "Nothing writes it to a thread, so a reopened one starts at zero"
  (`apps/desktop/src/shared/convo.ts:115-119`). The figure is derived from the thread's _shape_.
- **The live app's `tokens 333.2k`, read over CDP mid-conversation, is not a corroboration.**
  `sayTokens` labels `input + output` (`apps/desktop/renderer/pathux/editors/convo.ts:291`), so it
  includes exactly the quantity the estimate excludes.
- **Both inputs to the estimate lean the same way.** What is on disk is clamped (`TEXT_MAX = 400`,
  `FULL_MAX = 8000`, `ARGS_MAX = 600`, `OUTPUT_MAX = 2000`, `threads.ts:33-42`) while the loop
  pushes the whole observation into `Agent.messages` (`loop.ts:291`), so the transcript sizes are
  floors. And `≥ 53` is a genuine lower bound: `StructuredAgentBackend` retries a malformed parse
  up to three times and reports the summed usage as one step, so retries are invisible in the feed.

The arithmetic is at least self-consistent — a ~4,700-token prefix × 53 calls ≈ 249k, plus a
transcript averaging half its final size over 53 steps ≈ 110k, ≈ 359k against the reconstructed
~376k. Treat every figure in this plan's savings table as a **projection from an unmeasured
baseline**. Workstream A is what turns it into a measurement.

Five causes, in order of how much they cost:

1. **Nothing in the repo asks for prompt caching.** `grep -rn "cache_control|cacheControl|prompt_caching|ephemeral"`
   over `packages/`, `apps/` and `scripts/` returns nothing. The stable prefix — `SYSTEM_PROMPT`
   (3,384 chars) + the project's `AICONTEXT.md` (1,534) + the rendered tool catalog (**13,317** —
   see below) + `PROTOCOL` (~600) ≈ **4,700 tokens** — is billed at full price on every one of the
   81+ calls. That is ~380k tokens, the clear majority of all input.
2. **The request is shaped so it could not be cached even if it asked.** `StructuredAgentBackend.next`
   joins `MODE` + `TOOLS` + `PROTOCOL` + `TRANSCRIPT` into one string and sends it as a single
   user text block. `cache_control` is a _per content block_ marker; a block whose tail changes
   every step has no cacheable prefix.
3. **The desktop hardcodes the text path.** `session.ts` builds `new StructuredAgentBackend(...)`
   unconditionally, so the app pays for a hand-rendered catalog _and_ the JSON protocol block, and
   re-sends the whole prompt up to three times on a parse failure. `NativeAgentBackend` exists and
   is reachable only from `vnauthor --native`.
4. **Tool arguments never enter the transcript.** `loop.ts` records `thought` plus
   `(calling write_file)` and nothing else, so the model cannot see what it just wrote. The logs
   show the consequence directly: `write_file` → `read_file` of the same path (items 4→13, 15→21,
   26→32), and eleven `create_character` calls each immediately followed by an `edit_character`
   full rewrite. Roughly 35–45k tokens of pure re-derivation.
5. **All 40 tools are advertised every step.** About 8 KB of the 13.3 KB catalog is image and
   asset tooling that a wiki-editing turn will never call.

**The catalog is 13,317 characters, not the 12,678 an earlier draft quoted.** `renderTools` over
`ALL_TOOLS` alone is 12,678; `toolSpecs()` appends the three control tools before rendering
(`packages/authoring/src/loop.ts:242`, `CONTROL_TOOLS` at `:104-126`), and the list the model
actually receives is 40 tools and 13,317 characters. Every byte figure below is stated against
13,317, and a test asserting "the catalog is byte-identical across a session" has to render the
same list `toolSpecs()` does.

## The shape that caches

Caching is a **prefix match** over the rendered request, in the order `tools` → `system` →
`messages`. A single changed byte invalidates everything after it. So:

- Anything that varies per step must sit **after** everything that does not.
- The tool catalog and the system prompt must be **byte-identical** across a session.
- The transcript must **grow by appending**, never be re-rendered — an appended transcript is
  itself a growing cacheable prefix.
- A cache breakpoint (`cache_control: {type: 'ephemeral'}`) caches _everything up to and
  including_ the block it sits on. At most **four per request**, and **each breakpoint walks back
  at most 20 content blocks** looking for a hit — a per-breakpoint lookback, not a per-request one.
  The docs' own remedy for a long turn is an intermediate breakpoint roughly every 15 blocks, which
  is precisely what the rolling pair in workstream B is doing.

That last point is what forces workstream B: today there is no `messages` array to append to,
only one re-rendered string.

Two things that look like fixes but break this, and are therefore ruled out below:

- **Gating the tool catalog by mode or by topic.** It shrinks the prompt and destroys the cache:
  `tools` is at prefix position 0, so dropping an image tool when the turn looks textual
  invalidates the system prompt and the entire transcript behind it. The static `defer_loading`
  split in workstream E gets the same context saving without touching the prefix.
- **A hand-rolled `load_tool` that appends a schema to `tools[]`.** Same problem, same position.
  The API's own tool search is the version that works; see workstream E.

## Workstream A — say what a call cost, split by cache

Measurement first: without this, none of the workstreams below can be shown to have worked, and
the table above stays a reconstruction.

`TokenUsage` today is `{input, output}`, and `usageOf` in
`packages/providers/src/backends/anthropic.ts` folds cache reads and cache writes _into_ `input`.
That is right for a billing total and useless for verifying a cache hit.

The chain from the response to the tooltip has five links, and **all five widen** — the two in the
middle are easy to miss, and the split dies silently at either of them:

- `TokenUsage` grows optional `cacheRead` and `cacheWrite`. `input` keeps its current meaning —
  everything billed as input — so no existing caller changes. `usageOf` populates them from
  `cache_read_input_tokens` / `cache_creation_input_tokens`.
- `plus()` in `packages/authoring/src/backend.ts:56-59` adds the new fields.
- **`AgentEvent`'s usage variant** is `{type: 'usage'; input: number; output: number}`
  (`packages/authoring/src/loop.ts:78`). Whatever `plus()` accumulates is truncated here unless it
  widens too.
- **`Convo.tokens`** is `{input: number; output: number}` (`apps/desktop/src/shared/convo.ts:120`,
  accumulated at `:198-205`). Same truncation, one layer up.
- The convo bar (`apps/desktop/renderer/pathux/editors/convo.ts`, `sayTokens`) keeps its
  `tokens 333.2k` label and grows the split in its `.description` tooltip: in / out / cached, with
  the cache-hit percentage. A tooltip is where this belongs — it is a diagnostic, not a number the
  author acts on.

Both middle widenings are mechanical. They are called out because A's only visible output lives
behind them.

`scripts/verify-prompt-cache.mjs` — a two-step agent turn against a real key, asserting step 2
reports `cacheRead > 0` — is specified under [Tests](#tests), including why it can never run in CI.

**Expected saving: none.** This exists so the rest can be believed.

## Workstream B — a conversation-shaped request, with breakpoints

This is the mechanism everything else rests on, and it is **bigger than a seam**: the reply type,
the loop's transcript type and the action type all have to be able to hold provider-native blocks,
because C and E both require those blocks to be echoed back byte-for-byte.

### The seam

Add a third method to `ChatBackend` in `packages/providers/src/backend.ts`, beside
`message` / `messageWithUsage` / `chatWithTools`:

```ts
/** One block of a multi-turn conversation, in provider-neutral form. */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  /** Text, or the provider-native blocks a previous reply handed back. */
  content: string | unknown[];
  /** Cache this prefix. The backend maps it to the vendor's marker, or ignores it. */
  cache?: boolean;
}

/** What a conversation turn returned, with enough of it kept to send back. */
export interface ChatConvoReply extends ChatToolReply {
  /**
   * The assistant message's content blocks exactly as received — thinking, text, tool_use,
   * server_tool_use, tool_search_tool_result, in order. The caller echoes this verbatim;
   * rebuilding it from `text` + `toolCalls` is a 400.
   */
  raw: unknown[];
}

chatConversation?(
  req: { system: string; turns: ChatTurn[] },
  tools: ToolSchema[],
): Promise<ChatConvoReply>;
```

`ChatToolReply` is `{text?, toolCalls, usage?}` and **cannot carry what has to be sent back**. The
current Anthropic implementation destroys it on the way through: `chatWithTools` filters
`res.content` to `text` and `tool_use`, joins text blocks with `'\n'` (losing block boundaries) and
reduces each call to `{id, name, args}` (`anthropic.ts:138-146`). `raw` is what survives that.
`ChatTurn.content` being `string | unknown[]` lets a caller _send_ blocks; only `raw` lets it
_obtain_ them.

`chatConversation` is optional like `chatWithTools`, so a mock or recorded backend is still a
backend, and Gemini is unaffected until someone implements it there — see workstream D on why the
probe must not fall back to `chatWithTools`.

### What the loop has to grow to hold it

The loop owns the transcript, and its types are string-shaped:

- **`AgentMessage.content` is a plain `string`** (`packages/authoring/src/backend.ts:20-23`). It
  becomes `string | unknown[]`, so an assistant turn can be stored as the blocks it arrived as. The
  text path keeps storing strings and `renderTranscript` keeps rendering them.
- **`AgentAction` is `{tool, args}` with no id** (`:35-38`), and `NativeAgentBackend.next` throws
  the provider id away at `:212-213`. It grows `id?: string`, because every `tool_use` must be
  answered by a `tool_result` carrying its `tool_use_id`.
- **`NativeAgentBackend.next` keeps only `reply.toolCalls[0]`** (`:211`). Harmless while the
  request is single-shot and the discarded call is never referred to again; **fatal the moment B
  echoes the assistant turn back**, because the API rejects a turn with an unanswered `tool_use`.
  Either the loop executes and answers all N calls, or the backend asks for one at a time via
  `tool_choice` — this plan takes the first, since parallel tool use is the cheaper turn.

### Thinking blocks

**Adaptive thinking is on for every agent call the desktop makes today**, and no earlier draft of
this plan mentioned it. `tuning()` returns `thinking: {type: 'adaptive'}` for every effort except
`none` (`anthropic.ts:53-64`), and the default is `DEFAULT_EFFORT = 'low'`
(`packages/types/src/textmodels.ts:30`) — the absence of a knob is not the absence of thinking.

The rules are unforgiving, and they are exactly the rules B walks into:

- Thinking blocks come back **complete and unmodified** with the tool result they precede.
- Rebuilding the assistant message, or filtering out `redacted_thinking`, is a **400**.
- On `claude-opus-4-8` the `thinking` field is an empty string with only `signature` populated, so
  the block can only be echoed, never reconstructed.
- On Opus 4.5 and on 4.6 and higher, prior turns' thinking blocks stay in context and are **billed
  as input** — so they are part of the transcript this plan is caching, and they are why `raw`
  exists rather than a narrower `{text, toolCalls}` round trip.

None of this bites today only because `chatWithTools` sends one user message and never replays
history (`anthropic.ts:135`). Building that history is what B is for.

### The request builder

- `system` becomes a block array —
  `[{type: 'text', text: system, cache_control: {type: 'ephemeral'}}]` — so the breakpoint lands
  at the end of the system prompt.
- The last non-deferred entry of `tools` carries a `cache_control` marker, so the catalog is
  cached as its own prefix. (A tool with `defer_loading: true` **cannot** carry `cache_control`;
  the API returns 400. Workstream E depends on this breakpoint sitting on a non-deferred tool.)
- `turns` maps to `messages`, with every block preserved **verbatim** — thinking, `tool_use`,
  `tool_result`, `server_tool_use`, `tool_search_tool_result` — rather than re-rendered as prose.
  A re-rendered block is a changed byte, and for a thinking block it is also a 400.
- Two **rolling** breakpoints in `messages`: one on the newest block, one on the block that
  carried the previous turn's breakpoint. Keeping the older one means a turn always reads from a
  prefix written no more than one step back, well inside the 20-block per-breakpoint lookback even
  across a 24-step turn (`maxSteps` defaults to 24, and each step pushes two messages, so ~48
  blocks). Four breakpoints total, which is the maximum.
- Default TTL (5 minutes) is correct: an agent's steps are seconds apart, and the break-even on a
  5-minute write is two requests. A turn that is a single call and never revisited is the only
  case that loses, and it loses 25% of one call.

The two prefix breakpoints (`tools`, `system`) are not redundant with each other, even though the
`system` one alone would cover both under the prefix rule: the separate `tools` breakpoint is what
makes an `AICONTEXT.md` edit a partial hit rather than a total miss, which is the case the last
section of this plan is about. Spending 2 of 4 there is deliberate.

Deliberately **not** done here: keeping the one-big-string prompt and splitting it into two text
blocks with a breakpoint between them. That caches the fixed head — the majority of the bill — and
leaves the transcript, which is the rest and the half that grows.

**Expected saving on the reconstructed thread: ~220k of 376k**, plus most of the transcript once
workstream C stops re-rendering it.

## Workstream C — the transcript carries what happened, and MODE leaves the prefix

Two changes in `packages/authoring/src/loop.ts` and `backend.ts`.

**Tool arguments and results go into the transcript.** Today:

```ts
if (turn.action) narration.push(`(calling ${turn.action.tool})`);
```

That is the whole record. It becomes the tool call with its arguments, and the observation is
already recorded — so the model can see that it wrote `characters/aiko/character.md` with a
`description`, and does not read the file back to find out. On the native path these are real
`tool_use` / `tool_result` blocks kept as they arrived; on the text path they are the same JSON the
model emitted.

This makes the transcript _larger per step_ and the conversation _shorter in steps_, and the
larger transcript is cached while the extra steps were not. The measured re-derivation — three
read-after-write pairs and eleven `create`+`edit` pairs — is ~35–45k tokens that stops being
spent.

### `MODE` becomes a message, not a prompt prefix

It is turn-scoped truth, which is exactly what the existing `context` role is for. Add a
`'system'` role to `AgentMessage`, rendered by the Anthropic path as a `{"role": "system"}` message
inside `messages[]`. Plan → execute then **appends** instead of rewriting the head of every
subsequent request.

Three conditions an earlier draft skipped, each of which is a hard failure rather than a
degradation:

**1. The role is a per-model feature, and half the curated Claude menu rejects it.** It is
available on Opus 5, Opus 4.8, Fable 5 and Mythos 5; an unsupported model returns
`role 'system' is not supported on this model`. The menu is `claude-opus-4-8`, `claude-sonnet-4-6`,
`claude-haiku-4-5`, `claude-fable-5`, `gemini-2.5-pro`, `gemini-2.5-flash`
(`packages/types/src/textmodels.ts:33-40`), and all four Claude entries go through one
`createAnthropicChat` whose only model-conditional code is `tuning()` — so **`claude-sonnet-4-6`
and `claude-haiku-4-5` would hard-fail.** A backend-level fallback does not reach this; it needs a
**model-level predicate** beside `resolveEffort` — `supportsSystemRole(modelId)` — with the
fallback rendering the same content as an ordinary `user` turn, losing the cache on that one step
and nothing else.

**2. There is a positional rule.** A `system` message must follow a `user` message (or an
assistant message ending in server-tool use), must not be `messages[0]`, and must be either last
in `messages` or followed by an `assistant` turn. Filing it "at the point it happened" puts it at
the top of a turn, where the preceding entry is the previous turn's assistant final
(`loop.ts:270`, `:283`) — so the builder inserts it **after** the turn's new user input, not
before.

**3. A mid-session model switch is the sharp edge.** `setModel` rebuilds the backend without
clearing `Agent.messages` (`apps/desktop/src/main/session.ts:858-863`). Switch from Opus 4.8 to
Sonnet 4.6 halfway through and every subsequent request carries a message the new model refuses —
the conversation is permanently un-sendable, recoverable only by clearing it. So the builder must
**down-render existing system messages** when the resolved model lacks the feature, not merely
stop filing new ones. That is a request-time decision over `turns`, which is where it belongs
anyway.

### The mode a conversation starts in

The mode does not begin by changing: it is assigned at construction, `this.mode = opts.mode ?? 'plan'`
(`loop.ts:178`), and `setMode` (`:193-195`) is the only hook a "file it when it changes" rule could
attach to. With `MODE:` removed from the prompt prefix, a conversation that never leaves plan mode
would be told its mode **never**. `clear()` compounds it — it empties `messages` and resets the
mode to plan (`:202-206`) without routing through `setMode`.

So the rule is not "on change". It is: **the first user turn of a conversation carries the mode
message, and every `setMode` after that files another.** `clear()` resets the filed flag along with
the messages, so the next turn re-files. The filed record is what the model reads; the field is
what the loop reads.

### Backend selection

`NativeAgentBackend` is rewritten onto `chatConversation`, keeping its `AgentBackend` contract, so
the loop's callers are unchanged. `StructuredAgentBackend` stays — it is the fallback for backends
with no tool protocol, it is what `@vn/agentreport` uses (see
[Files this touches](#files-this-touches)), and its three-attempt retry gets _cheaper_ under
workstream B rather than needing removal: attempts 2 and 3 send the same prefix, so they are cache
reads.

## Workstream D — the desktop app uses the native path

`apps/desktop/src/main/session.ts`'s `buildBackend` returns `StructuredAgentBackend`
unconditionally. It becomes: `NativeAgentBackend` when the resolved backend implements
**`chatConversation`** — and only that — `StructuredAgentBackend` otherwise, `MockAgentBackend`
under `--mock` as today. `vnauthor`'s `--native` flag stops being the only way in and becomes a
`--no-native` escape hatch.

**The probe is `chatConversation` only, deliberately.** Gemini implements `chatWithTools`
(`packages/providers/src/backends/gemini.ts:136`) and two Gemini models are in the curated menu, so
an `or chatWithTools` probe would move a Gemini desktop onto a path that is still single-shot,
still re-renders the transcript, still caches nothing — and now also carries the larger tools block
below, with `PROTOCOL` removed. Strictly worse. Gemini stays on the text path until someone
implements `chatConversation` there.

`--mock` short-circuits `buildBackend` before any probe (`session.ts:723-724`), and
`RecordedChatBackend` implements only `message` (`packages/providers/src/mock.ts:14-27`), so every
test fake correctly stays on the text path.

### D is a cost, honestly priced

An earlier draft filed D as a saving. It is not. `NativeAgentBackend` builds each schema by
appending the argument signature to the description and sending `LOOSE_PARAMS`
(`{type: 'object', additionalProperties: true}`, `backend.ts:176`, `:198-202`) — so the same
descriptions and the same argument signatures go out, now as JSON with 40 copies of a placeholder
schema. Serialized, that is **16,603 characters against the text catalog's 13,317 — 25% larger.**

Net per call: −600 for `PROTOCOL`, +3,286 for the tools block. And under B the tools block is the
**first** thing in the cached prefix, so D enlarges the cache write and every read after it.

D is still worth doing, for what it actually buys: it removes the JSON-parse failure mode that
costs three full-prompt calls when it fires, and it puts the model on schemas it is trained on
rather than a hand-rendered protocol. It pays a few hundred cached tokens per call for that. The
claim that `LOOSE_PARAMS` "does not affect caching either way" was wrong — it is the reason the
tools block is bigger, and emitting real JSON Schema from `Tool.args` (a workstream-sized job of
its own, not in this plan) would shrink it _and_ give workstream E more to search.

## Workstream E — deferred tool loading, the way that keeps the cache

The ask was Claude Code's shape: four or five tools in full, one-liners for the rest, and a
`load_tool` to pull in a schema on demand. The Claude API ships exactly this as a server-side
feature, and the hand-rolled version is the one that cannot work.

- `tools[]` grows one entry:
  `{type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25'}`.
- Every other tool keeps its **full definition in the request** and gains `defer_loading: true`.
  `defer_loading` controls what enters the context window, not what is sent; the API needs the
  definitions server-side to run the search and expand the references.
- The API returns matches as `tool_reference` blocks and expands them into full definitions
  **inline in the conversation**. From the docs: _"Internally, the API excludes deferred tools from
  the system-prompt prefix… The prefix is untouched, so prompt caching is preserved."_ That
  sentence is the whole reason this workstream is the tool search tool and not a `load_tool` of our
  own.
- The client must pass the assistant's `server_tool_use` and `tool_search_tool_result` blocks back
  unchanged on the next request, and must **not** return a `tool_result` for the `srvtoolu_...` id.
  This is why workstream B's reply carries `raw`.

**BM25 rather than regex, because this registry is not namespaced.** The regex variant is
attractive when names are grouped by prefix, and `git_.*` does match a whole group of eight — but
`git_*` is the **only** namespaced group in the registry, and it is not the group E exists to
defer. The image and asset tooling is `generate_image`, `list_images`, `edit_image`, `list_assets`,
`art_notes`, `set_art_notes`, `view_image`, `regenerate_asset`: no prefix reaches those eight,
`image` misses three and `asset` misses five. The scene/character group is worse still
(`edit_scene`, `edit_branches`, `set_outfit`, `edit_character`, `create_character`). BM25 over
names and descriptions is the variant that copes with an unnamespaced registry; the regex tool can
be added alongside later if a namespace ever appears.

**What the search has to match on is thinner than it looks, and D is why.** Both variants search
tool names, descriptions, argument names and argument descriptions — and `LOOSE_PARAMS` contributes
literally nothing to the last two. The native path is saved by accident, because it folds the
argument signature into the description (`backend.ts:200`) where search does look — but
`describeToolParams` returns nothing for 14 of the 40 tools (`list_workspace`, `list_archive`,
`validate_inputs`, `parse_fountain`, `story_graph`, `extract_entities`, `list_images`,
`regenerate_context`, `discover_skills`, `git_status`, `git_init`, and the three control tools), so
for those the search has a name and one prose sentence. D's deferred `LOOSE_PARAMS` decision and
E's accuracy claim are coupled: real JSON Schema would improve both.

**The non-deferred set** — kept loaded because they are called constantly, or because the loop
cannot function without them:

| Tool | Why it stays loaded |
| --- | --- |
| `propose_plan` | Plan mode has no other exit. |
| `ask_user`, `ask_choice` | The only way to reach the author mid-turn. |
| `read_file`, `search`, `list_workspace` | The opening move of nearly every turn. |

That is **six repo-side definitions, 964 characters** of the 13,317-character catalog, plus the
server-side search tool, which has no definition of ours and is non-deferrable by construction.
The other 34 defer. The API's refusal if that set were ever emptied is
`At least one tool must have defer_loading=false. All tools cannot be deferred.` — worth quoting
exactly, since a test may assert on it. The cache breakpoint from workstream B sits on the last of
the six.

`ToolSpec` grows an optional `defer?: boolean`, set from a small allow-list of always-loaded names
in `loop.ts`. A backend that does not support tool search ignores the flag and sends the full
catalog, so Gemini and the mock backend keep working unchanged.

**Be honest about the size of this win.** Once workstream B lands, the catalog is a _cached_
prefix, and a cached token costs a tenth of a fresh one — so deferral saves roughly 290 tokens per
call, not 2,900. Its real value is the other thing the docs measure: tool-selection accuracy
degrades above 30–50 tools, and this registry advertises 40. Deferral is an accuracy fix that also
trims the cache write.

## Ordering, and what each step is worth

A ➜ B ➜ C ➜ D ➜ E, and the order is load-bearing rather than a preference.

- **A is measurement** and must be first, because the baseline above is a reconstruction.
- **B is the mechanism**, and it is the one to settle before anything else is scheduled. Its reply
  type, `AgentMessage.content`, `AgentAction.id` and the thinking-block round trip are all
  prerequisites of C and E. C and D are therefore not "independently shippable after B" — they are
  shippable once **B's return type is settled**, which is the part of B most likely to move.
- **E requires D as well as B and C.** `defer_loading` is a field on a `ToolSchema`, and the text
  path has no `tools` array at all.

Projections against the reconstructed thread 1 (53 calls, ~376k input tokens) — see
[What was measured](#what-was-measured-and-what-was-reconstructed) for why these are projections
rather than results:

| After | Billed input | Why |
| --- | --- | --- |
| today | ~376k | — |
| C alone (args in transcript) | ~330k | Re-derivation stops; nothing is cached yet. |
| + B (prefix cached) | ~110k | ~4,700-token prefix × 53 calls, read at 0.1×. |
| + B's rolling breakpoints (transcript cached) | ~50–60k | The transcript becomes an appended, cacheable prefix. |
| + D | ~55–65k | **A cost, not a saving**: −600 for `PROTOCOL`, +3,286 for a bigger tools block, all of it cached. Bought for the parse-failure mode it removes. |
| + E | ~55–65k | Small on cost; the win is tool-selection accuracy. |

Two footnotes on the arithmetic. The `+ B` row multiplies by the **pre-C** call count while C is
credited with making the conversation shorter in steps — conservative, so it overstates the
residual rather than the saving. And the whole column rests on a baseline the repo cannot currently
produce, which is workstream A's entire reason to exist.

Call it **roughly a 6× reduction, as a projection**, with the bulk of it in B, to be restated as a
measurement once A ships.

## Does this end with prompt caching working?

Yes — and the three conditions are worth stating plainly, because each one is a way to land all
five workstreams and still see a 0% hit rate:

1. **The tool catalog must be byte-identical across a session.** Static `defer_loading` is fine;
   gating tools in or out per turn is not. This is why workstream E replaces the original "gate the
   image/asset group" idea rather than sitting beside it.
2. **A changed `AICONTEXT.md` must be appended, not recomposed.** See
   [below](#what-happens-when-the-agent-edits-aicontextmd) — this is the one invalidation the
   agent can trigger on itself, and workstream C already carries the mechanism that fixes it.
3. **Switching model, effort or speed mid-session invalidates everything.** `setBackend` is called
   by `/model` and `/effort`, and [`../fast-mode-as-an-opt-in.md`](../fast-mode-as-an-opt-in.md) has
   already written down the third case: toggling fast mode re-bills the whole prompt, which is why
   that plan refuses to downgrade a 429 silently. That is correct behaviour and the cost is
   unavoidable; it is worth a line in the docs so nobody reports it as a bug. A model switch is
   also the case that must not leave an un-sendable conversation behind — see workstream C.

With those held, the steady state is: the first call of a turn writes the cache at 1.25×, and every
subsequent call in that turn — and every turn within five minutes — reads it at 0.1×. An agent turn
is almost never a single call, so the write pays for itself immediately.

## What happens when the agent edits `AICONTEXT.md`

The one invalidation the agent can inflict on itself, and the only one worth engineering around.

Both hosts recompose the system message **unconditionally at the top of every turn** —
`apps/desktop/src/main/session.ts:806` and `apps/authoring/src/repl.ts:386` both run
`setSystem(composeSystem(await loadContext(dir)))` before `agent.run`. Not on change; every turn.
That is deliberate: the project map inside the system prompt is a snapshot of a file the agent's
own `update_context` rewrites, and a session outlives every rewrite of it.

What that costs, step by step:

1. `update_context` appends `- <rule>` to `AICONTEXT.md` and returns an observation. It does **not**
   call `setSystem`. The rest of the turn is unaffected and keeps hitting the cache — and the agent
   cannot see the rule it just wrote anywhere but that observation until the next turn.
2. On an unchanged file, `composeSystem` is deterministic over the bytes it read, so the next turn
   re-assigns a **byte-identical** string and the cache is untouched. This is why the unconditional
   per-turn re-read is not itself a problem.
3. On a changed file, the system block differs. `tools` is ahead of it and still hits; **the system
   block and every message behind it — the whole conversation so far — is invalidated.** One
   appended line of guidance re-bills the entire transcript at 1.25×. On a 40k-token conversation
   that is ~50k tokens for one sentence.

`regenerate_context` is the same shape and worse: it rewrites the whole project map, so the diff is
the size of the map. Both are explicit acts — the tool, and the desktop's `workspace.*` command at
`apps/desktop/src/main/commands/workspace.ts:267`. Nothing regenerates the map on its own, which is
what keeps this bounded.

**The fix is the mechanism workstream C already introduces for `MODE`.** Don't recompose; append.

- Keep the composed system string the conversation started with — and hold **a hash per section,
  not one hash over the whole string.** `composeSystem` concatenates three sections:
  `SYSTEM_PROMPT`, the generated map, and the author's context
  (`packages/authoring/src/context.ts:191-206`). One hash cannot tell a ~40-byte `update_context`
  bullet (`context.ts:172-184`) from a wholesale `workspace.reindex` rewrite of
  `AICONTEXT.generated.md` (`apps/desktop/src/main/commands/workspace.ts:248-271`), and re-sending
  the unchanged 3,384-character `SYSTEM_PROMPT` for a one-sentence rule is exactly what makes the
  arithmetic below stop being true.
- At the top of each turn, recompose and compare per section. All identical — the common case — and
  nothing happens at all, which is what the code effectively does today, said out loud.
- Any section changed, and **only that section** is filed as a `{"role":"system"}` message at the
  point it happened, carrying the new text and saying plainly that it supersedes the section of the
  same name in the system prompt. The prefix is untouched, the transcript grows by one message, and
  every breakpoint still hits.
- **The supersede clause is doing real semantic work, not politeness.** `composeSystem`'s contract
  is positional and written down — "in that order and separately labelled, so the section that
  states policy is the one that reads last and says so" (`context.ts:186-190`), with the PROJECT MAP
  label itself asserting that `AICONTEXT.md` overrides it. An appended message restating a section
  after the transcript preserves that relative order **for additive changes**. A regenerated map
  that _deletes_ an entry cannot un-say the stale entry still sitting in the cached system prompt;
  only an explicit "this section replaces the one above in full" can. The message says that, in
  those terms.
- A new conversation composes from scratch, as it does now.

This satisfies the reason `setSystem` exists — the agent stops quoting the version it was built
with, because later content is what it reads last — without the demolition. The arithmetic is not
close: appending a regenerated 2k-token map costs 2k of cache write; recomposing invalidates a 40k
transcript. `Agent.setSystem` keeps its signature for the new-conversation path; the per-turn call
sites move to the appending one.

## Files this touches

- `packages/providers/src/backend.ts` — `TokenUsage` fields, `ChatTurn`, `ChatConvoReply`,
  `chatConversation`.
- `packages/providers/src/backends/anthropic.ts` — `usageOf`, the cached request builder, verbatim
  block preservation, `supportsSystemRole`, tool search + `defer_loading`.
- `packages/authoring/src/backend.ts` — `plus()`, `AgentMessage.content` widened and its `system`
  role, `AgentAction.id`, all tool calls instead of `toolCalls[0]`, `ToolSpec.defer`,
  `NativeAgentBackend` on `chatConversation`.
- `packages/authoring/src/loop.ts` — the `AgentEvent` usage split, args and results in the
  transcript, the mode message (including the one a conversation starts in, and `clear()`), the
  appended-context message and its per-section hashes, the always-loaded allow-list.
- `apps/desktop/src/shared/convo.ts` — `Convo.tokens` widened for the cache split.
- `apps/desktop/src/main/session.ts`, `apps/authoring/src/repl.ts` — the per-turn `setSystem` call
  sites move to appending.
- `apps/desktop/src/main/session.ts` — `buildBackend` picks the native path; `setModel` no longer
  leaves an un-sendable conversation behind.
- `apps/desktop/renderer/pathux/editors/convo.ts` — the cache split in the tokens tooltip.
- `apps/authoring/src/agent.ts` — `--native` becomes the default.
- `scripts/verify-prompt-cache.mjs` — new.
- `docs/vnauthor.md`, `docs/packages.md`, `CLAUDE.md` — the invariants above, once shipped.

**There is a third `Agent` host, and it stays on the text path.**
`packages/agentreport/src/analyze.ts:193-194` constructs
`new Agent({backend: new StructuredAgentBackend(opts.backend)})` — hardcoded, no probe, no
`--native`. Three consequences this plan states rather than fixes:

- `StructuredAgentBackend` acquires a second production consumer at exactly the moment workstream D
  describes it as the fallback. That is acceptable: the report analyst is a short analysis run, not
  a long agent turn, so it is the one caller caching would barely help.
- `renderTranscript` uppercases whatever role it is handed (`backend.ts:104`), so a `system`
  message would render as `SYSTEM: …` in the analyst's prompt with nothing marking it as a mode
  declaration rather than transcript content. The text path's renderer labels it explicitly —
  `SYSTEM (mode): …` — because the analyst's whole job is reading a transcript literally.
- `FeedItem.role` is `'user' | 'agent' | 'tool' | 'blocked'`
  (`packages/agentreport/src/transcript.ts:19-29`), with a doc comment saying an unknown role should
  fail at the call site. **Mode and context messages are model-facing and deliberately never reach
  the feed**, so that tripwire does not fire; if a later change surfaces them, adding the role there
  is part of that change and not this one.

## Tests

- `packages/providers/src/backends/tests/` — the request builder puts breakpoints where this plan
  says, marks the last non-deferred tool and never marks a deferred one, rolls the message
  breakpoints forward by one step, echoes an assistant turn's blocks back byte-identically
  (thinking included), and down-renders a `system` turn for a model without the role. The directory
  does not exist yet; `jest.config.cjs:65` matches `**/packages/<name>/**/tests/*.test.ts`, so it is
  picked up with no config change.
- `packages/authoring/src/tests/` — the transcript contains the arguments of a call it made; a
  conversation files a mode message on its first turn and after every `setMode`, and again after
  `clear()`; an `AICONTEXT.md` edit files one section and not three; the always-loaded set is never
  deferred; the rendered catalog is byte-identical across a session, rendered from `toolSpecs()`
  rather than `ALL_TOOLS`.
- **A cache _hit_ cannot be observed in jest, and this plan does not pretend otherwise.** Every test
  above asserts on the **request body** — where the breakpoints are, what is deferred, what was
  echoed — because no mock backend bills anything. `scripts/verify-prompt-cache.mjs` runs a two-step
  turn against a real key and asserts step 2 reports `cacheRead > 0`; it is a **manual, billed,
  out-of-CI ritual**, like its sibling `scripts/verify-prompt-chunks.mjs`, which needs a running app
  over CDP and is not in `package.json`'s scripts either. `pnpm test` is jest only and will not run
  it. It resolves its key through `resolveKeys` and never prints it — the standing rule in
  [`../../../CLAUDE.md`](../../../CLAUDE.md), restated here because a script that talks to a paid API is exactly
  where it gets forgotten.

## What shipped differently

Two places where the code says something narrower than the plan text above, both deliberate:

- **The out-of-band label is `SYSTEM (out-of-band): …`, not `SYSTEM (mode): …`.** By the time
  workstream C landed, a `system` message carries two unrelated things — the mode declaration and a
  superseded `composeSystem` section — so a label naming only the first would be wrong on most of
  them. `renderTranscript` labels the role, not the payload, and the payload says which it is.
- **A mode message is filed on a change, not on every `setMode`.** `Agent.filedMode` holds the mode
  the transcript last stated, and `setMode` files nothing when it is handed the mode already in
  force. The plan's "the first turn and after every `setMode`" was aiming at the observable
  behaviour — the transcript never lets a mode go unstated — and a no-op `setMode` restating it
  would only be a byte that invalidates the cached suffix for nothing.

One edge worth knowing, stated in `refreshSystem`'s own doc comment: the first `refreshSystem` on a
transcript that already has turns would supersede every section at once, because an `Agent`
constructed from a joined system string has no section map to diff against. Both hosts call it
before every `run()`, so the first call always lands on an empty transcript.

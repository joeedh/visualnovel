# Pressure test — `plans/prompt-caching-and-deferred-tool-loading.md`

An adversarial read of the prompt-caching plan against the code as it stands (August 2026), and
against the Claude API docs rather than the plan's paraphrase of them. The plan's diagnosis is right
and most of its mechanism is right. What follows is what breaks: one structural fault that stops
workstreams B, C and E from being implementable as written, two API rules the plan asserts without
the conditions attached, and a set of numbers that do not survive being recomputed. Ordered by how
much work the error moves.

<!-- toc -->

- [What checks out](#what-checks-out)
- [1. The headline ~376k is an estimate over a lossy record, and its corroboration measures something else](#1-the-headline-376k-is-an-estimate-over-a-lossy-record-and-its-corroboration-measures-something-else)
- [2. `chatConversation` returns `ChatToolReply`, which cannot carry the blocks B and E require](#2-chatconversation-returns-chattoolreply-which-cannot-carry-the-blocks-b-and-e-require)
- [3. Adaptive thinking is on by default, and no workstream mentions a thinking block](#3-adaptive-thinking-is-on-by-default-and-no-workstream-mentions-a-thinking-block)
- [4. The native path keeps only the first tool call, and `AgentAction` has no id](#4-the-native-path-keeps-only-the-first-tool-call-and-agentaction-has-no-id)
- [5. The mid-conversation system message 400s on half the curated model menu](#5-the-mid-conversation-system-message-400s-on-half-the-curated-model-menu)
- [6. The mode message is never filed for the mode a conversation starts in](#6-the-mode-message-is-never-filed-for-the-mode-a-conversation-starts-in)
- [7. The catalog the plan measured is not the catalog that is sent](#7-the-catalog-the-plan-measured-is-not-the-catalog-that-is-sent)
- [8. Workstream D makes the cached prefix bigger, not smaller](#8-workstream-d-makes-the-cached-prefix-bigger-not-smaller)
- [9. Tool search matches argument names, and the native path has none for 14 of the 40 tools](#9-tool-search-matches-argument-names-and-the-native-path-has-none-for-14-of-the-40-tools)
- [10. The regex example is the one group workstream E is not deferring](#10-the-regex-example-is-the-one-group-workstream-e-is-not-deferring)
- [11. The cache split stops two files short of the tooltip meant to show it](#11-the-cache-split-stops-two-files-short-of-the-tooltip-meant-to-show-it)
- [12. `@vn/agentreport` is a third `Agent` host, pinned to the text path and absent from the file list](#12-vnagentreport-is-a-third-agent-host-pinned-to-the-text-path-and-absent-from-the-file-list)
- [13. The `chatWithTools` half of D's probe routes Gemini onto a path B never fixed](#13-the-chatwithtools-half-of-ds-probe-routes-gemini-onto-a-path-b-never-fixed)
- [14. One hash over two files cannot tell a one-line rule from a regenerated map](#14-one-hash-over-two-files-cannot-tell-a-one-line-rule-from-a-regenerated-map)
- [15. The acceptance test cannot be run by CI, by `pnpm test`, or without a paid key](#15-the-acceptance-test-cannot-be-run-by-ci-by-pnpm-test-or-without-a-paid-key)
- [16. Smaller corrections](#16-smaller-corrections)
- [What survives](#what-survives)

<!-- tocstop -->

## What checks out

Most of the plan is true, and several of the things it is easiest to doubt are the things that hold
up best:

- **Nothing in the repo asks for caching.** `grep -rn "cache_control\|cacheControl\|prompt_caching\|ephemeral"`
  over `packages/`, `apps/*/src`, `apps/desktop/renderer` and `scripts/` returns zero hits. The
  premise is exactly as stated.
- **There really are only two `setSystem` call sites**, and they really do recompose unconditionally
  per turn: `apps/desktop/src/main/session.ts:806` and `apps/authoring/src/repl.ts:386`, both
  `setSystem(composeSystem(await loadContext(dir)))` immediately before `agent.run`. The plan's
  section on editing `AICONTEXT.md` is a correct reading of `packages/authoring/src/loop.ts:230`.
- **`update_context` does not call `setSystem`.** Nothing outside those two sites does. The
  step-by-step cost breakdown in that section is right.
- **The rolling-breakpoint scheme genuinely handles the 20-block window.** `maxSteps` defaults to 24
  (`loop.ts:179`) and each step pushes an assistant message and an observation (`loop.ts:281`,
  `loop.ts:291`), so a long turn is ~48 blocks — but a breakpoint on the newest block plus one on
  the previous step's block is never more than two blocks apart, which is inside 20 by a wide
  margin. This is the part of the plan I most expected to break and could not.
- **The two `tools` + `system` breakpoints are not redundant**, even though a single breakpoint at
  the end of `system` would cover both under the plan's own prefix-order rule. The separate tools
  breakpoint is what makes an `AICONTEXT.md` edit a partial hit rather than a total miss — which is
  the case the plan spends a section on. Spending 2 of 4 breakpoints there is deliberate and right.
- **`defer_loading` + `cache_control` really is a 400**, and the plan is right to place the
  breakpoint on "the last non-deferred entry". Verified against the tool-search docs, which say it
  in those words.
- **The non-deferred set really is ~1 KB.** Rendering `renderTools` over the six repo-side tools the
  plan keeps loaded gives **964 characters**. "~1 KB of the 12.6 KB catalog" is accurate.
- **`{"role":"system"}` mid-conversation is real, is GA on `claude-opus-4-8`, and needs no beta
  header.** The plan is right about the feature; see finding 5 for the conditions it omits.
- **The tests it proposes land where jest will find them.** `packages/providers/src/backends/tests/`
  does not exist yet, but `jest.config.cjs:65` matches `**/packages/<name>/**/tests/*.test.ts`, so
  the new directory is picked up without config changes.

## 1. The headline ~376k is an estimate over a lossy record, and its corroboration measures something else

**CONFIRMED.** The plan's table labels the row "estimated input tokens billed", which is honest —
and then line 22 says "The live desktop app, read over CDP mid-conversation, **agreed**:
`tokens 333.2k`", and line 246 says "Estimated against the **measured** thread 1 (53 calls, ~376k
input tokens)". Neither the agreement nor the measurement exists.

Thread files record no token data at all. `ThreadLine` is a union of a header, a `FeedItem` and a
title (`apps/desktop/src/main/threads.ts:44-47`), and `appendItem` (`:214-230`) writes nothing else.
The `Convo` doc comment says so out loud: "Nothing writes it to a thread, so a reopened one starts at
zero" (`apps/desktop/src/shared/convo.ts:115-119`). So `~376k` cannot have been read off disk; it can
only have been reconstructed from the thread's shape.

And `tokens 333.2k` is not an input figure. `sayTokens` computes `const total = input + output`
(`apps/desktop/renderer/pathux/editors/convo.ts:291`) and labels the sum. A number that includes
output tokens cannot corroborate a number that excludes them; the two differ by exactly the quantity
the plan is not measuring.

Two further reasons the reconstruction is soft in the direction the savings table depends on:

- **What is on disk is clamped, and what was sent was not.** `TEXT_MAX = 400`, `FULL_MAX = 8000`,
  `ARGS_MAX = 600`, `OUTPUT_MAX = 2000` (`threads.ts:33-42`), while the loop pushes the whole
  observation into `Agent.messages` (`loop.ts:291`). "Final transcript on disk | 16.6 KB" is a floor
  on the real transcript, not a measure of it. Since the `+ B` row is computed by subtracting a
  prefix estimate from a total and calling the residual the transcript, an understated transcript
  understates the post-B figure — `~110k` is the optimistic end of a range the measurement cannot
  bound.
- **"model calls | ≥ 53" is a lower bound the plan then uses as an exact multiplier.** The `≥` is
  correct: `StructuredAgentBackend` retries a malformed parse up to three times and reports the
  summed usage as one step (`packages/authoring/src/backend.ts:41-53`, the `usage` doc comment), so
  retries are invisible in the feed. The `+ B` row nonetheless reads "~4,600-token prefix × **53**
  calls".

The arithmetic is at least self-consistent — 4,600 × 53 ≈ 244k of prefix, plus a transcript averaging
half of ~4,150 tokens over 53 steps ≈ 110k, giving ~354k against the claimed ~376k. The finding is
not that the number is wrong; it is that the plan presents an estimate as a measurement and offers a
corroboration that measures a different quantity. Workstream A exists precisely because this cannot
be measured today — which means the "6–8× reduction" is a projection from an unmeasured baseline, and
the plan should say so in the places where it says "measured".

## 2. `chatConversation` returns `ChatToolReply`, which cannot carry the blocks B and E require

**CONFIRMED.** This is the structural fault, and it blocks three workstreams.

The proposed signature is `chatConversation?(req, tools): Promise<ChatToolReply>` (plan lines
109-112). `ChatToolReply` is `{ text?: string; toolCalls: ToolCall[]; usage?: TokenUsage }`
(`packages/providers/src/backend.ts:49-53`). The plan then requires, twice, that the caller send
provider-native blocks back:

> `turns` maps to `messages`, with `tool_use` / `tool_result` blocks preserved **verbatim** rather
> than re-rendered as prose — a re-rendered block is a changed byte. (line 126)

> The client must pass the assistant's `server_tool_use` and `tool_search_tool_result` blocks back
> **unchanged** on the next request… This is why workstream B preserves provider-native blocks
> verbatim. (lines 212-214)

Nothing in `ChatToolReply` can hold them. The Anthropic implementation already discards everything it
is being asked to preserve: `chatWithTools` filters `res.content` to `text` and `tool_use` only,
joins the text blocks with `'\n'` — destroying block boundaries — and reduces each `tool_use` to
`{id, name, args}` (`packages/providers/src/backends/anthropic.ts:138-146`). `server_tool_use` and
`tool_search_tool_result`, the two block types workstream E's round trip is built on, are dropped by
that same filter and have no representation in the type.

`ChatTurn.content` being `string | unknown[]` (plan line 104) lets the caller _send_ raw blocks. It
does not let the caller _obtain_ them. The loop is the only thing that holds the transcript, and
`AgentMessage.content` is a plain `string` (`packages/authoring/src/backend.ts:20-23`), as is
`AgentTurn`, which has only `message` / `action` / `final` / `usage` (`:41-60`). The plan's "Files
this touches" lists exactly one change to those types — "`AgentMessage`'s `system` role" (line 330).

So the seam as specified is not closed: workstream B cannot produce what workstream B requires as
input on the next call, and workstream E's stated prerequisite ("this is why workstream B preserves
provider-native blocks verbatim") is not satisfied by workstream B. Either `ChatToolReply` grows a
raw-content field and `AgentMessage` / `AgentTurn` grow somewhere to put it, or the loop stops owning
the transcript. Both are larger than the plan's framing of C as "two changes in `loop.ts` and
`backend.ts`".

## 3. Adaptive thinking is on by default, and no workstream mentions a thinking block

**CONFIRMED**, against the code and the Claude docs.

`tuning()` returns `{ max_tokens, output_config: { effort }, thinking: { type: 'adaptive' } }` for
every effort except `none` (`packages/providers/src/backends/anthropic.ts:53-64`), and the default is
`DEFAULT_EFFORT = 'low'` (`packages/types/src/textmodels.ts:30`), not the absence of a knob. Adaptive
thinking is on for every agent call the desktop makes today.

The docs' rules for thinking with tool use are unambiguous, and they are the rules for
`thinking: {type: "adaptive"}` on `claude-opus-4-8` specifically:

> **Pass thinking blocks back complete and unmodified**: when you return a tool result, the thinking
> blocks from the assistant message must come back with it.
>
> **Echo the assistant message exactly as received**: rebuilding the message or filtering out
> `redacted_thinking` blocks triggers a 400 error.

On 4.8 the block is not even readable — "the `thinking` field otherwise comes back as an empty string
with only the `signature` populated" — so it can only be echoed, never reconstructed. The same docs
note that on Opus 4.5 and models 4.6 and higher, prior turns' thinking blocks are kept in context and
**billed as input**, so they are also part of the transcript cost the plan's savings table is silent
about.

Today none of this bites, because `chatWithTools` sends a single user message and never replays
history (`anthropic.ts:135`) — there is no assistant turn to echo. Workstream B's whole purpose is to
build that history, and the moment it does, "rebuilding the message" is precisely what a
`ChatToolReply` round trip does. The plan mentions thinking nowhere: not in the seam, not in the
Anthropic implementation bullets, not in the files list, not in the tests.

## 4. The native path keeps only the first tool call, and `AgentAction` has no id

**CONFIRMED.** `NativeAgentBackend.next` does `const call = reply.toolCalls[0]`
(`packages/authoring/src/backend.ts:211`) and drops the rest. Parallel tool use is on by default, so
a model that emits two `tool_use` blocks has one executed and one silently discarded.

Harmless today, for the same reason as finding 3: the request is single-shot, so a discarded call is
never referred to again. Under workstream B the assistant turn is echoed back with N `tool_use`
blocks and the loop can only produce one `tool_result`, which the API rejects — every `tool_use` must
be answered.

The correlation machinery is missing too. `ToolCall` carries the provider id
(`packages/providers/src/backend.ts:26-27`), and `backend.ts:212-213` throws it away:
`{ tool: call.name, args: call.args }`. `AgentAction` is `{ tool: string; args: unknown }` with no id
field (`packages/authoring/src/backend.ts:35-38`), so the loop has nothing to put in `tool_use_id`.
The plan's file list names `plus()`, the `system` role, `ToolSpec.defer` and `NativeAgentBackend` for
that file (line 330) — not `AgentAction`, and not `toolCalls[0]`.

## 5. The mid-conversation system message 400s on half the curated model menu

**CONFIRMED.** The plan's entire justification is one clause: "supported on the app's current
`claude-opus-4-8` with no beta header" (line 166). That is true, and it is not the question.

The feature is available on Claude Opus 5, Opus 4.8, Fable 5 and Mythos 5 — and **not** on Sonnet 5.
An unsupported model returns a 400 (`role 'system' is not supported on this model`). The curated menu
is:

```
claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5, claude-fable-5,
gemini-2.5-pro, gemini-2.5-flash
```

(`packages/types/src/textmodels.ts:33-40`; the doc comment above it says "any id also works", so
`claude-sonnet-5` is reachable by typing it.) Of the four Claude entries, `claude-opus-4-8` and
`claude-fable-5` support the role; **`claude-sonnet-4-6` and `claude-haiku-4-5` do not**. All four go
through the same `createAnthropicChat`, whose only model-conditional code is `tuning()`
(`anthropic.ts:53-64`) — there is no per-model feature gate to hang this on.

The plan's mitigation does not reach this: "Backends without the feature render it as an ordinary
user turn and lose nothing but the cache on that one step" (line 168) is a **backend**-level
fallback, and this is a **model**-level gate _inside_ one backend. Two of the four curated Claude
models would hard-fail, not degrade.

It is worse than a startup check, because `setModel` rebuilds the backend mid-session
(`apps/desktop/src/main/session.ts:858-863`) without clearing `Agent.messages`. Switch from Opus 4.8
to Sonnet 4.6 halfway through a conversation and every subsequent request carries a
`{"role":"system"}` message the new model refuses — the conversation becomes permanently
un-sendable, recoverable only by clearing it.

There is also a positional rule the plan does not state: a `system` message must follow a `user`
message (or an assistant message ending in server-tool use), must not be `messages[0]`, and must be
either last in `messages` or followed by an `assistant` turn. The plan files the context message "at
the point it happened" (line 314) — which for the `setSystem` sites is the top of a turn, where the
preceding entry is the previous turn's `assistant` final (`loop.ts:270`, `:283`). **PLAUSIBLE** that
this is where it lands; a careful implementation can insert after the new user input instead, but the
plan as written does not say to.

## 6. The mode message is never filed for the mode a conversation starts in

**CONFIRMED.** "Add a `'system'` role to `AgentMessage`, filed once at the moment the mode changes"
(line 164). The mode does not begin by changing. It is assigned at construction —
`this.mode = opts.mode ?? 'plan'` (`packages/authoring/src/loop.ts:178`) — and `setMode` (`:193-195`)
is the only thing the plan's hook could attach to. A conversation that never leaves plan mode
therefore never files a mode message at all, and `MODE:` has been removed from the prompt prefix by
the same workstream (`backend.ts:203-204`). The model is told the mode only if it changes.

`clear()` compounds it: it empties `messages` and resets the mode to plan (`loop.ts:202-206`) without
routing through `setMode`, so a cleared conversation starts with neither a filed mode nor a prefix
that states one.

## 7. The catalog the plan measured is not the catalog that is sent

**CONFIRMED, by measurement.** The plan's `12,678` characters is exactly reproducible — it is
`renderTools` over the registry. But `toolSpecs()` appends the three control tools before the catalog
is rendered:

```ts
return [...fromRegistry, ...CONTROL_TOOLS];
```

(`packages/authoring/src/loop.ts:242`, with `CONTROL_TOOLS` at `:104-126`.) Rendering the list the
model actually receives gives **13,317** characters, not 12,678. The plan's tool count is right (40 =
37 in `ALL_TOOLS` + 3 control), so the count and the byte figure were taken from different lists.

Small on its own — ~160 tokens on the prefix estimate — but it is the number every other figure in
workstream E is stated against ("~1 KB of the 12.6 KB catalog", "8 KB of the 12.6 KB catalog"), and
it is the number a test asserting "the catalog is byte-identical across a session" would be written
from.

## 8. Workstream D makes the cached prefix bigger, not smaller

**CONFIRMED, by measurement.** The plan says D "drops the `PROTOCOL` block (~600 chars/call) and the
hand-rendered catalog in favour of schemas the model is trained on" (line 184), and prices it as a
saving in the ordering table ("`+ D` | ~45–55k | `PROTOCOL` and the hand-rendered catalog stop being
sent").

They do not stop being sent; they change shape and grow. `NativeAgentBackend` builds each schema by
appending the argument signature to the description and sending a permissive object
(`packages/authoring/src/backend.ts:198-202`, with
`LOOSE_PARAMS = { type: 'object', additionalProperties: true }` at `:176`). So the same descriptions
and the same argument signatures are sent, now as JSON with 40 copies of a placeholder schema.
Serialized, that is **16,603 characters** against the 13,317-character text catalog — **25% larger**.

Net per call: −600 for `PROTOCOL`, +3,286 for the tools block. Under workstream B the tools block is
the _first_ thing in the cached prefix, so D enlarges the cache write and every cache read
thereafter. The direction of the `+ D` row is wrong; the honest claim is that D removes a parse
failure mode (three full-prompt retries when it fires) and pays a few hundred cached tokens per call
for it. That may still be worth it — but it is not the saving the table says it is, and the plan's
own caveat about `LOOSE_PARAMS` ("It does not affect caching either way", line 192) is the one
sentence about it that is not true.

## 9. Tool search matches argument names, and the native path has none for 14 of the 40 tools

**PLAUSIBLE.** The docs say both variants "search tool names, descriptions, argument names, and
argument descriptions". With `LOOSE_PARAMS` the schema contributes literally nothing to two of those
four fields for every tool.

The plan is saved from this by accident: `backend.ts:200` folds the argument signature into the
description, where search does look. But `describeToolParams` returns nothing for 14 of the 40 tools
— `list_workspace`, `list_archive`, `validate_inputs`, `parse_fountain`, `story_graph`,
`extract_entities`, `list_images`, `regenerate_context`, `discover_skills`, `git_status`, `git_init`,
and the three control tools — so for those, search has only a name and a prose sentence to match on.

The consequence is narrow but real: workstream E's stated value is tool-selection accuracy, and D's
deferred `LOOSE_PARAMS` decision is what determines how much text E's search has to work with. The
plan treats them as independent on that axis, and they are not.

## 10. The regex example is the one group workstream E is not deferring

**CONFIRMED.** The plan justifies the regex variant over BM25 by example:

> tool names in this registry are already keyword-shaped (`edit_scene`, `git_commit`, `list_assets`)
> and a pattern like `git_.*` matches a whole group in one search.

`git_.*` does match a whole group — eight tools (`git_status`, `git_log`, `git_show`, `git_diff`,
`git_commit`, `git_revert`, `git_restore`, `git_init`). It is the only group in the registry that is
namespaced. The group workstream E exists to defer — "about 8 KB of the 12.6 KB catalog is image and
asset tooling" (line 44) — is named `generate_image`, `list_images`, `edit_image`, `list_assets`,
`art_notes`, `set_art_notes`, `view_image`, `regenerate_asset`. No prefix reaches those eight;
`image` misses three of them, `asset` misses five. The scene/character group is worse still
(`edit_scene`, `edit_branches`, `set_outfit`, `edit_character`, `create_character`).

The worked example is drawn from the one namespace where the argument holds. That is not an argument
against the regex variant — it may still be the right pick — but the plan's stated reason for it is
not evidence for it, and BM25 over descriptions is the variant that copes with an unnamespaced
registry.

## 11. The cache split stops two files short of the tooltip meant to show it

**CONFIRMED.** Workstream A's deliverable is the split reaching `sayTokens`'s `.description`. The
chain from `usageOf` to that tooltip has five links, and the plan's file list (lines 327-340) names
three of them.

- `usageOf` → `TokenUsage` → `AgentTurn.usage` — named.
- `plus()` at `packages/authoring/src/backend.ts:56-59` — named, and it does need the new fields.
- **`AgentEvent`'s usage variant is `{ type: 'usage'; input: number; output: number }`**
  (`packages/authoring/src/loop.ts:78`). The plan lists `loop.ts` for four other changes and not for
  this one. Whatever `plus()` accumulates is truncated to two numbers here.
- **`Convo.tokens` is `{ input: number; output: number }`** (`apps/desktop/src/shared/convo.ts:120`),
  accumulated at `:198-205`. `apps/desktop/src/shared/convo.ts` is not in the file list at all.
- `convo.ts`'s `sayTokens` — named.

Two type widenings in two unlisted files. Both are mechanical; the point is that the plan's
"measurement first, so the rest can be believed" workstream is under-scoped in exactly the place its
only visible output lives.

## 12. `@vn/agentreport` is a third `Agent` host, pinned to the text path and absent from the file list

**CONFIRMED.** The plan treats the desktop and `vnauthor` as the two hosts. There is a third:
`packages/agentreport/src/analyze.ts:193-194` constructs
`new Agent({ backend: new StructuredAgentBackend(opts.backend) })` — hardcoded, no probe, no
`--native`.

Two consequences the plan does not price:

- Workstream D's "the desktop app uses the native path" leaves the report analyst on the text path
  permanently, so `StructuredAgentBackend` acquires a second production consumer at exactly the
  moment the plan describes it as "the fallback for backends with no tool protocol" (line 172).
- Adding a `'system'` role to `AgentMessage` changes what `renderTranscript` emits for the text path.
  It uppercases whatever role it is handed (`packages/authoring/src/backend.ts:104`), so a system
  message renders as `SYSTEM: …` in the analyst's prompt with nothing telling it that is a mode
  declaration rather than transcript content. Harmless-looking, but the analyst's whole job is
  reading a transcript literally.

Separately, `FeedItem.role` is `'user' | 'agent' | 'tool' | 'blocked'`
(`packages/agentreport/src/transcript.ts:19-29`) with a doc comment saying "if the app ever adds a
role this package does not know, the call site is where that should fail". Nothing in the plan puts a
system message into the feed, so this does not fire — but it is the tripwire that fires if workstream
C's mode messages are ever surfaced, and the plan should say which side of that line it is on.

## 13. The `chatWithTools` half of D's probe routes Gemini onto a path B never fixed

**CONFIRMED.** Workstream D's rule is "`NativeAgentBackend` when the resolved backend implements
`chatConversation` **(or `chatWithTools`)**" (line 180). Gemini implements `chatWithTools`
(`packages/providers/src/backends/gemini.ts:136`), and two Gemini models are in the curated menu
(`textmodels.ts:38-39`).

So a Gemini-configured desktop moves from `StructuredAgentBackend` to `NativeAgentBackend` — a path
that, without `chatConversation`, is still the single-shot, re-rendered-transcript, no-caching request
it is today, now also carrying the 25% larger tools block from finding 8 and having lost the
`PROTOCOL` block. The plan says Gemini "is unaffected until someone implements it there" (line 116);
under D's `or`, it is affected, and in the wrong direction. Either the probe is `chatConversation`
only, or the plan should say what Gemini gains from the move.

## 14. One hash over two files cannot tell a one-line rule from a regenerated map

**CONFIRMED.** The fix is stated as: "Keep the composed system string the conversation started with,
and hold its hash… recompose and compare hashes" (lines 311-312), then file the difference as a
system message "carrying the new context".

`composeSystem` concatenates three sections into one string — `SYSTEM_PROMPT`, then the generated
map, then the author's context (`packages/authoring/src/context.ts:191-206`). A single hash over that
string cannot distinguish:

- `update_context` appending one `- <rule>` bullet to `AICONTEXT.md`
  (`packages/authoring/src/context.ts:172-184`) — a ~40-byte delta; from
- `workspace.reindex` rewriting `AICONTEXT.generated.md` wholesale
  (`apps/desktop/src/main/commands/workspace.ts:248-271`) — a delta the size of the map.

Both flip the hash identically, so "carrying the new context" means re-sending the whole composed
string — including the 3,384-character `SYSTEM_PROMPT` that never changed — for a one-sentence rule.
The plan's own arithmetic assumes otherwise: "appending a regenerated 2k-token map costs 2k of cache
write" (line 321) is the regenerate case priced as if it were the only case. A section-level
comparison, not a whole-string hash, is what makes that arithmetic true.

There is also a precedence question the plan waves at. `composeSystem`'s contract is positional and
written down: "in that order and separately labelled, so the section that states policy is the one
that reads last and says so" (`context.ts:186-190`), and the PROJECT MAP label itself asserts
"AICONTEXT.md overrides it". An appended message restating both sections after the transcript keeps
the relative order, so the contract survives — **but only for additive changes.** A regenerated map
that _deletes_ an entry cannot un-say the stale entry still sitting in the cached system prompt; it
can only be superseded by a message that says so explicitly. The plan does say the message will "say
plainly that it supersedes the section in the system prompt" (line 315), which is the right instinct
— the finding is that the clause is doing real semantic work and is currently one clause.

## 15. The acceptance test cannot be run by CI, by `pnpm test`, or without a paid key

**CONFIRMED.** `scripts/verify-prompt-cache.mjs` is named twice as the thing that proves the plan
worked: "the acceptance test for workstreams B–E" (line 90) and "the only place a cache _hit_ can be
observed, since no mock backend bills anything" (line 350).

Its declared sibling sets the precedent, and the precedent is not encouraging.
`scripts/verify-prompt-chunks.mjs:1-20` requires a **running desktop app** driven over CDP
(`pnpm build:desktop && pnpm vndesktop --mock`, then `node scripts/verify-prompt-chunks.mjs`), and
warns "point it at a scratch project, not at anything you want to keep". It is not in
`package.json`'s scripts (`:17-31`), and `pnpm test` is jest only. The new script adds a second gate:
a real, billed API key.

So the plan's only proof of its central claim is a manual, paid, out-of-CI ritual, and every
automatic test it proposes verifies **where the breakpoints were placed**, never that one was hit.
That is a legitimate position — a cache hit genuinely cannot be observed against a mock — but the
plan should say it, because "the acceptance test for workstreams B–E" reads like something that runs.
Two things would make it honest: assert on the _request body_ in jest (breakpoint count, position,
and that no deferred tool carries `cache_control`), and note that the live script must resolve its
key through `resolveKeys` and never print it — the repo's standing rule that the plan does not
mention.

## 16. Smaller corrections

- **"At most four per request, and only the last 20 blocks are searched for a hit"** (line 58)
  compresses two different rules. The lookback is per breakpoint — each walks back at most 20 content
  blocks — and the docs' remedy is an intermediate breakpoint every ~15 blocks in long turns, which
  is the rule the rolling scheme is actually satisfying. Worth stating correctly, since the rolling
  design is justified by it.
- **The plan paraphrases the all-deferred error as `All tools cannot be deferred`** (line 227). The
  actual message is `At least one tool must have defer_loading=false. All tools cannot be deferred.`
  Only matters if a test asserts on it.
- **"That is seven definitions"** (line 226) counts `tool_search_tool_regex`, which is a server tool
  with no definition of ours. Six repo-side tools, 964 characters — the KB figure is right, the count
  is off by the entry that has no bytes.
- **The savings table applies the pre-C call count to the post-C world.** The `+ B` row is
  "~4,600-token prefix × 53 calls", but C is credited with making "the conversation shorter in steps"
  (line 158). Conservative — it overstates the residual, so the 6–8× claim is not threatened — but
  the two rows are not on the same footing.
- **Workstream E's dependency is stated without D.** "E requires B's breakpoint placement and C's
  verbatim block handling" (line 244). It also requires D: `defer_loading` is a field on a
  `ToolSchema`, and there is no `tools` array on the text path at all. The A ➜ B ➜ C ➜ D ➜ E order
  already gets this right; the sentence does not.
- **`MockAgentBackend` and the test fakes are clear.** `--mock` short-circuits `buildBackend` before
  any probe (`apps/desktop/src/main/session.ts:723-724`, with the class at `:253`), and
  `RecordedChatBackend` implements only `message` (`packages/providers/src/mock.ts:14-27`), so D's
  probe correctly leaves every fake on the text path. Checked because the plan says "as today" and
  moves on; it is right.

## What survives

I tried hardest to break four things and could not:

1. **The diagnosis.** Nothing asks for caching, the request is shaped so it could not be cached if it
   did, the desktop is hardcoded to the text path, tool arguments never enter the transcript, and all
   40 tools go out every step. All five are true as stated, and the read-after-write and
   `create`+`edit` pairs are the right evidence for the fourth.
2. **The two ruled-out fixes.** Gating the catalog per turn and a hand-rolled `load_tool` both sit at
   prefix position 0 and both destroy the cache. The reasoning is correct, and it is the reason the
   plan reaches for the API's own tool search rather than the obvious thing.
3. **The rolling-breakpoint design.** Two message breakpoints, one on the newest block and one on the
   previous step's, keeps every read inside the 20-block window across a 24-step turn, and the
   four-breakpoint budget is spent deliberately rather than by accident. This is the best part of the
   plan.
4. **The `AICONTEXT.md` analysis.** Both hosts really do recompose unconditionally per turn, an
   unchanged file really does produce a byte-identical string, `update_context` really does not call
   `setSystem`, and append-don't-recompose really is the right shape. Only the hash granularity
   (finding 14) is wrong.

**Does the headline claim survive?** The _strategy_ does — prefix caching over an appended
conversation, with static `defer_loading` rather than dynamic gating, is the right design and will
work. The _plan_ does not, as written: workstream B's seam cannot return what workstreams B, C and E
consume (findings 2, 3, 4), so the mechanism everything else rests on is under-specified, and
workstream C's mode message hard-fails on two of the four curated Claude models (finding 5). Those
are correctable — a raw-content field on `ChatToolReply`, an id on `AgentAction`, a model predicate
beside `effortChoicesFor` — but they are design decisions the plan has not made rather than
implementation details, and the ordering section should not claim C and D are "independently
shippable after B" until B's return type is settled.

The 6–8× number should be restated as a projection from an unmeasured baseline, and the `+ D` row
should be restated as a cost. Everything else in the table is defensible.

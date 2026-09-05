# Pressure test — `plans/prompt-caching-and-deferred-tool-loading.md`

This document reads the prompt-caching plan adversarially against the code as it stands
(August 2026), and against the Claude API docs rather than the plan's paraphrase of them.
The plan's diagnosis is right and most of its mechanism is right. Three problems remain:
one structural fault that stops workstreams B, C and E from being implementable as
written, two API rules the plan asserts without the conditions attached, and a set of
numbers that do not survive being recomputed. The list is ordered by how much work each
error moves.

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

Most of the plan is true, and several of the claims that are easiest to doubt hold up
best:

- **No code in the repo requests caching.**
  `grep -rn "cache_control\|cacheControl\|prompt_caching\|ephemeral"` over `packages/`,
  `apps/*/src`, `apps/desktop/renderer` and `scripts/` returns zero hits. The premise
  holds exactly as stated.
- There are only two `setSystem` call sites, and both recompose unconditionally per turn:
  apps/desktop/src/main/session.ts:806 and apps/authoring/src/repl.ts:386, each calling
  `setSystem(composeSystem(await loadContext(dir)))` immediately before `agent.run`. The
  plan's section on editing `AICONTEXT.md` is a correct reading of
  packages/authoring/src/loop.ts:230.
- `update_context` does not call `setSystem`. No code outside those two sites calls
  `setSystem`. The step-by-step cost breakdown in that section is right.
- **The rolling-breakpoint scheme handles the 20-block window.** `maxSteps` defaults to 24
  (`loop.ts:179`) and each step pushes an assistant message and an observation
  (`loop.ts:281`, `loop.ts:291`), so a long turn is ~48 blocks. A breakpoint on the newest
  block and a breakpoint on the previous step's block are never more than two blocks
  apart, which stays inside 20 by a wide margin. I expected this part of the plan to
  break, and it did not.
- The two `tools` + `system` breakpoints are not redundant, even though a single
  breakpoint at the end of `system` would cover both under the plan's own prefix-order
  rule. The separate tools breakpoint makes an `AICONTEXT.md` edit a partial hit rather
  than a total miss, and the plan spends a section on that case. Spending 2 of 4
  breakpoints there is deliberate and right.
- **`defer_loading` with `cache_control` returns a 400.** The plan correctly places the
  breakpoint on "the last non-deferred entry". The tool-search docs state this in those
  words.
- **The non-deferred set measures ~1 KB.** Rendering `renderTools` over the six repo-side
  tools the plan keeps loaded gives 964 characters. "~1 KB of the 12.6 KB catalog" is
  accurate.
- **`{"role":"system"}` mid-conversation is real, is GA on `claude-opus-4-8`, and needs no
  beta header.** The plan is right about the feature. See finding 5 for the conditions the
  plan omits.
- **The proposed tests go where jest will find them.**
  `packages/providers/src/backends/tests/` does not exist yet, but jest.config.cjs:65
  matches `**/packages/<name>/**/tests/*.test.ts`, so jest picks up the new directory
  without config changes.

## 1. The headline ~376k is an estimate over a lossy record, and its corroboration measures something else

**CONFIRMED.** The plan's table labels the row "estimated input tokens billed", which is
honest. Line 22 then says "The live desktop app, read over CDP mid-conversation, agreed:
`tokens 333.2k`", and line 246 says "Estimated against the measured thread 1 (53 calls,
~376k input tokens)". No such agreement and no such measurement exist.

Thread files record no token data at all. `ThreadLine` is a union of a header, a
`FeedItem` and a title (apps/desktop/src/main/threads.ts:44-47), and `appendItem`
(:214-230) writes nothing else. The `Convo` doc comment states this: "Nothing writes it to
a thread, so a reopened one starts at zero" (apps/desktop/src/shared/convo.ts:115-119).
The ~376k figure therefore cannot have been read off disk; it can only have been
reconstructed from the thread's shape.

And `tokens 333.2k` is not an input figure. `sayTokens` computes
`const total = input + output` (apps/desktop/renderer/pathux/editors/convo.ts:291) and
labels the sum. A number that includes output tokens cannot corroborate a number that
excludes them. The two differ by the output tokens, which the plan does not measure.

The reconstruction is soft in the direction the savings table depends on, for two further
reasons:

- **The transcript on disk is clamped, and the text that was sent is not.**
  `TEXT_MAX = 400`, `FULL_MAX = 8000`, `ARGS_MAX = 600`, `OUTPUT_MAX = 2000`
  (threads.ts:33-42) clamp what is written, while the loop pushes the whole observation
  into `Agent.messages` (loop.ts:291). "Final transcript on disk | 16.6 KB" is therefore a
  floor on the real transcript rather than a measure of it. The `+ B` row is computed by
  subtracting a prefix estimate from a total and calling the residual the transcript, so
  an understated transcript understates the post-B figure. `~110k` is the optimistic end
  of a range that the measurement cannot bound.
- **"model calls | ≥ 53" is a lower bound the plan then uses as an exact multiplier.** The
  `≥` is correct: `StructuredAgentBackend` retries a malformed parse up to three times and
  reports the summed usage as one step (packages/authoring/src/backend.ts:41-53, the
  `usage` doc comment), so the feed does not show retries. The `+ B` row nonetheless reads
  "~4,600-token prefix × 53 calls".

The arithmetic is at least self-consistent: 4,600 × 53 ≈ 244k of prefix, plus a transcript
averaging half of ~4,150 tokens over 53 steps ≈ 110k, giving ~354k against the claimed
~376k. The finding concerns how the number is presented rather than the number itself. The
plan presents an estimate as a measurement and offers a corroboration that measures a
different quantity. Workstream A exists because these numbers cannot be measured today, so
the "6–8× reduction" is a projection from an unmeasured baseline, and the plan should say
so in the places where it says "measured".

## 2. `chatConversation` returns `ChatToolReply`, which cannot carry the blocks B and E require

**CONFIRMED.** This is the structural fault, and it blocks three workstreams.

The proposed signature is `chatConversation?(req, tools): Promise<ChatToolReply>` (plan
lines 109-112). `ChatToolReply` is
`{ text?: string; toolCalls: ToolCall[]; usage?: TokenUsage }`
(packages/providers/src/backend.ts:49-53). The plan then requires in two places that the
caller send provider-native blocks back:

`turns` maps to `messages`. The `tool_use` and `tool_result` blocks are preserved verbatim
rather than re-rendered as prose, because re-rendering a block changes its bytes.
(line 126)

The client must pass the assistant's `server_tool_use` and `tool_search_tool_result`
blocks back unchanged on the next request. Workstream B preserves provider-native blocks
verbatim so the client can return them unchanged. (lines 212-214)

Nothing in `ChatToolReply` can hold them. The Anthropic implementation already discards
everything it is asked to preserve: `chatWithTools` filters `res.content` to `text` and
`tool_use` only, joins the text blocks with `'\n'` (destroying block boundaries), and
reduces each `tool_use` to `{id, name, args}`
(packages/providers/src/backends/anthropic.ts:138-146). That same filter drops
`server_tool_use` and `tool_search_tool_result`, the two block types workstream E's round
trip is built on, and neither has a representation in the type.

`ChatTurn.content` being `string | unknown[]` (plan line 104) lets the caller send raw
blocks, but it does not let the caller obtain them. The loop is the only thing that holds
the transcript, and `AgentMessage.content` is a plain `string`
(packages/authoring/src/backend.ts:20-23), as is `AgentTurn`, which has only `message` /
`action` / `final` / `usage` (:41-60). The plan's "Files this touches" lists exactly one
change to those types — "`AgentMessage`'s `system` role" (line 330).

So the seam as specified is not closed. Workstream B cannot produce what workstream B
requires as input on the next call, and workstream B does not satisfy workstream E's
stated prerequisite ("this is why workstream B preserves provider-native blocks
verbatim"). Either `ChatToolReply` gains a raw-content field and `AgentMessage` /
`AgentTurn` gain somewhere to put it, or the loop stops owning the transcript. Both
options are larger than the plan's description of C as "two changes in `loop.ts` and
`backend.ts`".

## 3. Adaptive thinking is on by default, and no workstream mentions a thinking block

**CONFIRMED**, against the code and the Claude docs.

`tuning()` returns
`{ max_tokens, output_config: { effort }, thinking: { type: 'adaptive' } }` for every
effort except `none` (packages/providers/src/backends/anthropic.ts:53-64), and the default
is `DEFAULT_EFFORT = 'low'` (packages/types/src/textmodels.ts:30) rather than no setting
at all. Adaptive thinking is on for every agent call the desktop makes today.

The docs' rules for thinking with tool use are unambiguous, and they govern
`thinking: {type: "adaptive"}` on `claude-opus-4-8` specifically:

**Pass thinking blocks back complete and unmodified**: when you return a tool result, the
thinking blocks from the assistant message must come back with it. **Echo the assistant
message exactly as received**: rebuilding the message or filtering out `redacted_thinking`
blocks triggers a 400 error.

On 4.8 the block is not readable: "the `thinking` field otherwise comes back as an empty
string with only the `signature` populated". The block can therefore only be echoed, not
reconstructed. The same docs note that on Opus 4.5 and models 4.6 and higher, prior turns'
thinking blocks are kept in context and billed as input, so they are part of the
transcript cost that the plan's savings table omits.

None of this matters today, because `chatWithTools` sends a single user message and never
replays history (anthropic.ts:135), so there is no assistant turn to echo. Workstream B
exists to build that history, and once it does, a `ChatToolReply` round trip is what
rebuilds the message. The plan does not mention thinking anywhere: not in the seam, not in
the Anthropic implementation bullets, not in the files list, not in the tests.

## 4. The native path keeps only the first tool call, and `AgentAction` has no id

Confirmed. `NativeAgentBackend.next` does `const call = reply.toolCalls[0]`
(packages/authoring/src/backend.ts:211) and drops the rest. Parallel tool use is on by
default, so when a model emits two `tool_use` blocks the backend executes one and silently
discards the other.

This is harmless today for the same reason as finding 3. The request is single-shot, so a
discarded call is never referred to again. Under workstream B the assistant turn is echoed
back with N `tool_use` blocks while the loop can produce only one `tool_result`. The API
rejects that turn, because every `tool_use` must be answered.

The correlation machinery is missing too. `ToolCall` carries the provider id
(packages/providers/src/backend.ts:26-27), and backend.ts:212-213 discards it by
constructing `{ tool: call.name, args: call.args }`. `AgentAction` is
`{ tool: string; args: unknown }` with no id field
(packages/authoring/src/backend.ts:35-38), so the loop has nothing to put in
`tool_use_id`. The plan's file list names `plus()`, the `system` role, `ToolSpec.defer`
and `NativeAgentBackend` for that file (line 330); it does not name `AgentAction` or
`toolCalls[0]`.

## 5. The mid-conversation system message 400s on half the curated model menu

Confirmed. The plan's entire justification is one clause: "supported on the app's current
`claude-opus-4-8` with no beta header" (line 166). The clause is true, and the clause is
not the question.

The feature is available on Claude Opus 5, Opus 4.8, Fable 5 and Mythos 5. Sonnet 5 does
not support it. An unsupported model returns a 400
(`role 'system' is not supported on this model`). The curated menu is:

```
claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5, claude-fable-5,
gemini-2.5-pro, gemini-2.5-flash
```

(packages/types/src/textmodels.ts:33-40; the doc comment above it says "any id also
works", so `claude-sonnet-5` is reachable by typing it.) Of the four Claude entries,
`claude-opus-4-8` and `claude-fable-5` support the role, and `claude-sonnet-4-6` and
`claude-haiku-4-5` do not. All four go through the same `createAnthropicChat`, whose only
model-conditional code is `tuning()` (anthropic.ts:53-64). There is no per-model feature
gate to hang this on.

The plan's mitigation does not cover a model-level gate. Line 168 says "Backends without
the feature render it as an ordinary user turn and lose nothing but the cache on that one
step", which is a fallback at the backend level, while this gate sits inside one backend
and applies per model. Two of the four curated Claude models would hard-fail rather than
degrade.

It is worse than a startup check, because `setModel` rebuilds the backend mid-session
(apps/desktop/src/main/session.ts:858-863) without clearing `Agent.messages`. If a user
switches from Opus 4.8 to Sonnet 4.6 halfway through a conversation, every subsequent
request carries a `{"role":"system"}` message that the new model refuses. The conversation
is then permanently un-sendable, and clearing it is the only recovery.

There is also a positional rule the plan does not state: a `system` message must follow a
`user` message (or an assistant message ending in server-tool use), must not be
`messages[0]`, and must be either last in `messages` or followed by an `assistant` turn.
The plan files the context message "at the point it happened" (line 314). For the
`setSystem` sites that point is the top of a turn, where the preceding entry is the
previous turn's `assistant` final (loop.ts:270, :283). PLAUSIBLE: the context message
lands there; a careful implementation can insert after the new user input instead, but the
plan as written does not say to.

## 6. The mode message is never filed for the mode a conversation starts in

**CONFIRMED.** "Add a `'system'` role to `AgentMessage`, filed once at the moment the mode
changes" (line 164). The mode is assigned at construction —
`this.mode = opts.mode ?? 'plan'` (`packages/authoring/src/loop.ts:178`) — not by a
change, and `setMode` (`:193-195`) is the only place the plan's hook could attach to. A
conversation that never leaves plan mode therefore never files a mode message at all, and
the same workstream has removed `MODE:` from the prompt prefix (`backend.ts:203-204`). The
model is told the mode only when the mode changes.

`clear()` has the same flaw: it empties `messages` and resets the mode to plan
(loop.ts:202-206) without routing through `setMode`. A cleared conversation therefore
carries no filed mode and no prefix that states one.

## 7. The catalog the plan measured is not the catalog that is sent

Measurement confirms this. Running `renderTools` over the registry reproduces the plan's
`12,678` characters exactly. But `toolSpecs()` appends the three control tools before the
catalog is rendered:

```ts
return [...fromRegistry, ...CONTROL_TOOLS];
```

(packages/authoring/src/loop.ts:242, with `CONTROL_TOOLS` at :104-126.) Rendering the list
the model receives gives 13,317 characters, not 12,678. The plan's tool count is right (40
= 37 in `ALL_TOOLS` + 3 control), so the count and the byte figure were taken from
different lists.

The figure is small on its own (~160 tokens on the prefix estimate), but every other
figure in workstream E is stated against it ("~1 KB of the 12.6 KB catalog", "8 KB of the
12.6 KB catalog"), and a test asserting "the catalog is byte-identical across a session"
would be written from it.

## 8. Workstream D makes the cached prefix bigger, not smaller

Measurement confirms the claim. The plan says D "drops the `PROTOCOL` block (~600
chars/call) and the hand-rendered catalog in favour of schemas the model is trained on"
(line 184), and prices it as a saving in the ordering table ("`+ D` | ~45–55k | `PROTOCOL`
and the hand-rendered catalog stop being sent").

The schemas are still sent, and they are larger. `NativeAgentBackend` builds each schema
by appending the argument signature to the description and sending a permissive object
(`packages/authoring/src/backend.ts:198-202`, with
`LOOSE_PARAMS = { type: 'object', additionalProperties: true }` at `:176`). So the same
descriptions and the same argument signatures are sent, now as JSON with 40 copies of a
placeholder schema. The serialized form is 16,603 characters against the 13,317-character
text catalog, which is 25% larger.

Net per call: −600 for `PROTOCOL`, +3,286 for the tools block. Under workstream B the
tools block is the first thing in the cached prefix, so D enlarges the cache write and
every cache read thereafter. The direction of the `+ D` row is wrong. D removes a parse
failure mode (which costs three full-prompt retries when it fires) and pays a few hundred
cached tokens per call for it. That may still be worth it, but it is not the saving the
table reports. The plan's own caveat about `LOOSE_PARAMS` ("It does not affect caching
either way", line 192) is the one sentence about it that is not true.

## 9. Tool search matches argument names, and the native path has none for 14 of the 40 tools

**PLAUSIBLE.** The docs say both variants "search tool names, descriptions, argument
names, and argument descriptions". Under `LOOSE_PARAMS`, two of those four fields are
empty for every tool.

The plan works here only by accident: `backend.ts:200` folds the argument signature into
the description, and search does look at the description. But `describeToolParams` returns
nothing for 14 of the 40 tools — `list_workspace`, `list_archive`, `validate_inputs`,
`parse_fountain`, `story_graph`, `extract_entities`, `list_images`, `regenerate_context`,
`discover_skills`, `git_status`, `git_init`, and the three control tools — so for those 14
tools, search has only a name and a prose sentence to match on.

The consequence is narrow but real. Workstream E's stated value is tool-selection
accuracy, and D's deferred `LOOSE_PARAMS` decision determines how much text E's search has
to work with. The plan treats the two workstreams as independent on that axis, but they
are coupled.

## 10. The regex example is the one group workstream E is not deferring

CONFIRMED. The plan justifies the regex variant over BM25 by example:

tool names in this registry are already keyword-shaped (`edit_scene`, `git_commit`,
`list_assets`) and a pattern like `git_.*` matches a whole group in one search.

`git_.*` does match a whole group of eight tools (`git_status`, `git_log`, `git_show`,
`git_diff`, `git_commit`, `git_revert`, `git_restore`, `git_init`). It is the only group
in the registry that is namespaced. Workstream E exists to defer the group that line 44
describes as "about 8 KB of the 12.6 KB catalog is image and asset tooling", and that
group holds `generate_image`, `list_images`, `edit_image`, `list_assets`, `art_notes`,
`set_art_notes`, `view_image`, `regenerate_asset`. No prefix reaches those eight. `image`
misses three of them, and `asset` misses five. The scene/character group is worse still
(`edit_scene`, `edit_branches`, `set_outfit`, `edit_character`, `create_character`).

The worked example is drawn from the one namespace where the argument holds. That narrow
example does not rule out the regex variant (which may still be the right pick), but the
plan's stated reason for the regex variant is not evidence for it. BM25 over descriptions
is the variant that copes with an unnamespaced registry.

## 11. The cache split stops two files short of the tooltip meant to show it

Confirmed. Workstream A must deliver the split to `sayTokens`'s `.description`. The chain
from `usageOf` to that tooltip has five links, and the plan's file list (lines 327-340)
names three of them.

- `usageOf` produces a `TokenUsage`, which `AgentTurn.usage` holds. Each step in that
  chain is named.
- `plus()` at packages/authoring/src/backend.ts:56-59 is named and needs the new fields.
- **`AgentEvent`'s usage variant is `{ type: 'usage'; input: number; output: number }`**
  (packages/authoring/src/loop.ts:78). The plan lists loop.ts for four other changes and
  not for this one. This variant truncates what `plus()` accumulates to two numbers.
- **`Convo.tokens` is `{ input: number; output: number }`**
  (apps/desktop/src/shared/convo.ts:120). The counts accumulate at lines 198-205. The file
  apps/desktop/src/shared/convo.ts does not appear in the file list.
- `sayTokens` in `convo.ts` is named.

Two type widenings in two unlisted files. Both are mechanical. The plan's "measurement
first, so the rest can be believed" workstream is under-scoped in exactly the place its
only visible output lives.

## 12. `@vn/agentreport` is a third `Agent` host, pinned to the text path and absent from the file list

Confirmed. The plan treats the desktop and `vnauthor` as the two hosts. A third host is
packages/agentreport/src/analyze.ts:193-194, which constructs
`new Agent({ backend: new StructuredAgentBackend(opts.backend) })`. That backend is
hardcoded, with no probe and no `--native`.

The plan does not price two consequences:

- Workstream D's "the desktop app uses the native path" leaves the report analyst on the
  text path permanently, so `StructuredAgentBackend` gains a second production consumer,
  while the plan describes it as "the fallback for backends with no tool protocol" (line
  172).
- Adding a `'system'` role to `AgentMessage` changes what `renderTranscript` emits for the
  text path. It uppercases whatever role it is handed
  (packages/authoring/src/backend.ts:104), so a system message renders as `SYSTEM: …` in
  the analyst's prompt, and the prompt does not mark that line as a mode declaration
  rather than transcript content. The analyst reads the transcript literally.

Separately, `FeedItem.role` is `'user' | 'agent' | 'tool' | 'blocked'`
(packages/agentreport/src/transcript.ts:19-29) with a doc comment saying "if the app ever
adds a role this package does not know, the call site is where that should fail". Nothing
in the plan puts a system message into the feed, so this does not fire. It does fire if
workstream C's mode messages are ever surfaced, and the plan should say whether those
messages reach the feed.

## 13. The `chatWithTools` half of D's probe routes Gemini onto a path B never fixed

Confirmed. Workstream D's rule is "`NativeAgentBackend` when the resolved backend
implements `chatConversation` (or `chatWithTools`)" (line 180). Gemini implements
`chatWithTools` (packages/providers/src/backends/gemini.ts:136), and two Gemini models are
in the curated menu (textmodels.ts:38-39).

So a Gemini-configured desktop moves from `StructuredAgentBackend` to
`NativeAgentBackend`. Without `chatConversation`, that path still sends the single-shot,
re-rendered-transcript, no-caching request it sends today, and it now carries the 25%
larger tools block from finding 8 without the `PROTOCOL` block. The plan says Gemini "is
unaffected until someone implements it there" (line 116). Under D's `or`, Gemini is
affected, and the change makes it worse. Either the probe tests `chatConversation` only,
or the plan states what Gemini gains from the move.

## 14. One hash over two files cannot tell a one-line rule from a regenerated map

Confirmed. The fix is stated as: "Keep the composed system string the conversation started
with, and hold its hash… recompose and compare hashes" (lines 311-312). The difference is
then filed as a system message "carrying the new context".

`composeSystem` concatenates three sections into one string — `SYSTEM_PROMPT`, then the
generated map, then the author's context (packages/authoring/src/context.ts:191-206). A
single hash over that string cannot distinguish:

- `update_context` appending one `- <rule>` bullet to `AICONTEXT.md`
  (packages/authoring/src/context.ts:172-184), a delta of about 40 bytes; from
- `workspace.reindex` rewrites `AICONTEXT.generated.md` wholesale
  (apps/desktop/src/main/commands/workspace.ts:248-271), so the delta covers the whole
  file.

Both flip the hash identically, so "carrying the new context" means re-sending the whole
composed string — including the 3,384-character `SYSTEM_PROMPT` that never changed — for a
one-sentence rule. The plan's own arithmetic assumes otherwise: line 321 states that
"appending a regenerated 2k-token map costs 2k of cache write", which prices the
regenerate case as if it were the only case. That arithmetic holds only under a
section-level comparison, not a whole-string hash.

The plan also leaves a precedence question open. `composeSystem`'s contract is positional
and written down: "in that order and separately labelled, so the section that states
policy is the one that reads last and says so" (context.ts:186-190), and the PROJECT MAP
label itself asserts "AICONTEXT.md overrides it". An appended message that restates both
sections after the transcript keeps the relative order, so the contract holds for additive
changes. A regenerated map that deletes an entry does not remove the stale entry from the
cached system prompt; only a message that states the deletion explicitly supersedes it.
The plan does say the message will "say plainly that it supersedes the section in the
system prompt" (line 315), and that is the right approach. The finding is that this clause
carries real semantic weight and is currently a single clause.

## 15. The acceptance test cannot be run by CI, by `pnpm test`, or without a paid key

Confirmed. `scripts/verify-prompt-cache.mjs` is named twice as the proof that the plan
worked: "the acceptance test for workstreams B–E" (line 90) and "the only place a cache
_hit_ can be observed, since no mock backend bills anything" (line 350).

The declared sibling of this script is already awkward to run.
scripts/verify-prompt-chunks.mjs:1-20 requires a running desktop app driven over CDP
(`pnpm build:desktop && pnpm vndesktop --mock`, then
`node scripts/verify-prompt-chunks.mjs`), and warns "point it at a scratch project, not at
anything you want to keep". That script is not listed in package.json's scripts (:17-31),
and `pnpm test` runs jest only. The new script adds a second barrier, a real and billed
API key.

So the plan's only proof of its central claim is a manual, paid procedure that runs
outside CI, and every automatic test it proposes verifies where the breakpoints were
placed, never that one was hit. That position is defensible, since a cache hit cannot be
observed against a mock, but the plan should state it, because "the acceptance test for
workstreams B–E" reads like something that runs. Two changes would make the plan honest:
assert on the request body in jest (breakpoint count, position, and that no deferred tool
carries `cache_control`), and note that the live script must resolve its key through
`resolveKeys` and never print it. The repo has a standing rule for that key handling, and
the plan does not mention it.

## 16. Smaller corrections

- **"At most four per request, and only the last 20 blocks are searched for a hit"**
  (line 58) states two separate rules as one. The lookback is per breakpoint, and each
  breakpoint walks back at most 20 content blocks. The docs' remedy is an intermediate
  breakpoint every ~15 blocks in long turns, and that remedy is the rule the rolling
  scheme satisfies. State both rules correctly, since the ~15-block remedy justifies the
  rolling design.
- **The plan paraphrases the all-deferred error as `All tools cannot be deferred`** (line
  227). The actual message is
  `At least one tool must have defer_loading=false. All tools cannot be deferred.` The
  difference matters only if a test asserts on the message text.
- **"That is seven definitions"** (line 226) counts `tool_search_tool_regex`, which is a
  server tool that we do not define. The repo defines six tools totaling 964 characters,
  so the KB figure is right and the count is one too high, because the extra entry
  contributes no bytes.
- **The savings table applies the pre-C call count to the post-C world.** The `+ B` row
  reads "~4,600-token prefix × 53 calls", but line 158 credits C with making "the
  conversation shorter in steps". The mismatch is conservative, because it overstates the
  residual and so does not threaten the 6–8× claim. The two rows are still not measured on
  the same basis.
- **Workstream E's dependency is stated without D.** Line 244 says "E requires B's
  breakpoint placement and C's verbatim block handling". E also requires D:
  `defer_loading` is a field on a `ToolSchema`, and the text path has no `tools` array.
  The A ➜ B ➜ C ➜ D ➜ E order already places D before E; the sentence at line 244 omits D.
- **`MockAgentBackend` and the test fakes are clear.** `--mock` short-circuits
  `buildBackend` before any probe (apps/desktop/src/main/session.ts:723-724, with the
  class at :253), and `RecordedChatBackend` implements only `message`
  (packages/providers/src/mock.ts:14-27), so D's probe correctly leaves every fake on the
  text path. Checked because the plan says "as today" and moves on; that claim holds.

## What survives

I tried hardest to break these four things, and could not break them:

1.  1. **The diagnosis.** The diagnosis makes five claims: caching is never requested; the
       request is shaped so that it could not be cached even if caching were requested;
       the desktop is hardcoded to the text path; tool arguments never enter the
       transcript; and all 40 tools go out every step. All five hold as stated, and the
       read-after-write and `create`+`edit` pairs are the right evidence for the claim
       that tool arguments never enter the transcript.
2.  2. **The two ruled-out fixes.** Gating the catalog per turn and a hand-rolled
       `load_tool` both sit at prefix position 0, and both destroy the cache. The
       reasoning is correct, and it explains why the plan reaches for the API's own tool
       search rather than either of these two fixes.
3.  3. **The rolling-breakpoint design.** Two message breakpoints (one on the newest
       block, one on the previous step's block) keep every read inside the 20-block window
       across a 24-step turn, and they spend the four-breakpoint budget deliberately
       rather than by accident. This is the best part of the plan.
4.  4. **The `AICONTEXT.md` analysis.** Both hosts really do recompose unconditionally per
       turn, an unchanged file really does produce a byte-identical string,
       `update_context` really does not call `setSystem`, and appending rather than
       recomposing really is the correct approach. Only the hash granularity (finding 14)
       is wrong.

The headline claim survives only in part. The strategy holds: prefix caching over an
appended conversation, with static `defer_loading` rather than dynamic gating, is the
right design and will work. The plan as written does not hold. Workstream B's seam cannot
return what workstreams B, C and E consume (findings 2, 3, 4), so the mechanism everything
else rests on is under-specified, and workstream C's mode message hard-fails on two of the
four curated Claude models (finding 5). Those faults are correctable by a raw-content
field on `ChatToolReply`, an id on `AgentAction`, and a model predicate beside
`effortChoicesFor`. Each of those is a design decision the plan has not made rather than
an implementation detail, so the ordering section should not claim C and D are
"independently shippable after B" until B's return type is settled.

The 6–8× number should be restated as a projection from an unmeasured baseline, and the
`+ D` row should be restated as a cost. Everything else in the table is defensible.

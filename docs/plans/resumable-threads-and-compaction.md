# Resumable threads, compaction, and searching the uncompacted history

Status: **planned**

<!-- toc -->

<!-- tocstop -->

## Context

From [`../../todos.md`](../../todos.md):

> make agent threads resumable. the user should be given the option to compact the thread
> history; compaction will not modify the transcript but instead append the compacted history
> to it. create a tool for the agent to search the uncompacted history similar to how claude
> code does it.

Three coupled pieces. Reopening a saved conversation puts the model back in it. The author may
choose to compact a long conversation, and compaction appends rather than rewrites. The agent
gains a way to search the part of the conversation a compaction summarized away.

### What exists today

Every claim below was read out of the file named.

- A conversation is written to `vngen/state/threads/<id>.jsonl` as it happens, one line per
  feed item, by `appendItem` in `apps/desktop/src/main/threads.ts`. The union of line types is
  `thread` (line 0, the header), `item`, `title`, `binding` and `archived`.
- **That file is a display log, not an execution log.** `threads.ts` clamps at the write
  boundary: `TITLE_MAX = 60`, `TEXT_MAX = 400`, `FULL_MAX = 8000`, `ARGS_MAX = 600`,
  `OUTPUT_MAX = 2000`. `FeedItem.full` is present only when something was cut. Nothing in the
  file is guaranteed verbatim, so nothing in it can be replayed to a model.
- `readThread` keeps only `line.type === 'item'` and rebuilds each `FeedItem` field by field.
  `listThreads` pre-filters lines by substring, admitting only `"thread"`, `"title"`,
  `"binding"` and `"archived"`. `lines()` drops a line that will not parse. An unknown line
  type is therefore ignored by every existing reader, which
  [`recording-cache-misses-in-a-thread.md`](recording-cache-misses-in-a-thread.md) already
  verified independently when it claimed the line type name `usage`.
- **`listThreads` decides what a thread is from the filename**, at `threads.ts:170`:
  `files.filter((f) => f.endsWith('.jsonl'))`, with the id taken as everything before the
  extension. Every file in the directory whose name ends `.jsonl` is opened and read.
- `commitThread` (`apps/desktop/src/main/session.ts:1285`) commits exactly one path:
  it builds `const file = threadFile(paths, thread.id)` and passes `paths: [file]`.
- `header.archived` is a **list** of `{ commit, at }`, not a single commit
  (`threads.ts:141-144`), and the comment there says keeping every record rather than only the
  last is deliberate.
- `Agent` in `packages/authoring/src/loop.ts` holds `messages`, `editedPaths`, `seen`
  (the `ReadLedger`), `mode`, `filedMode`, `sections`, `pendingSystem` and `stopped`. It has
  `clear()`, `setBackend`, `setSystem`, `refreshSystem`, `setMode`, `setBudget` and `stop`.
  **There is no `restore`**; `messages` is `private readonly` at `loop.ts:430` with no
  accessor; and `refreshSystem` (`loop.ts:553`) returns `void`, mutating private state.
- `repairDanglingCalls` (`loop.ts:614-646`) works from the **trailing** assistant message and
  takes no index. There is no existing "last complete turn" predicate to lift.
- `AgentMessage` (`packages/authoring/src/backend.ts`) is
  `{ role: 'user' | 'assistant' | 'observation' | 'context' | 'system'; content: string | unknown[]; toolUseId?: string }`.
  On the native path an assistant turn's `content` is the provider's own blocks, because
  thinking blocks must be echoed complete and unmodified.
- `AgentBackend` (`backend.ts:113-115`) is one method, `next(system, messages, tools)`, and
  **carries no field saying which path it is**. `MockAgentBackend`
  (`session.ts:339`) implements it with a canned string and is neither `NativeAgentBackend` nor
  `StructuredAgentBackend`.
- `renderTranscript` (`backend.ts:156`) is module-private. `messageText` (`backend.ts:147`),
  which it renders content through, keeps only a block's `.text`.
- `openThreadForReading` in `apps/desktop/src/main/session.ts` reads the record, calls
  `clearAgent()`, and rebinds model and effort. The renderer answers with
  `replayed(state, record.items, REOPENED)` where `REOPENED` says the agent has not been shown
  the conversation. `agent.openThread`'s description in
  `apps/desktop/src/main/commands/agent.ts` promises the same thing, and so does the Threads
  button's tooltip in `apps/desktop/renderer/pathux/editors/convo.ts:218-220`.
- `openerFor` (`apps/desktop/renderer/pathux/agent.ts:176-179`) runs `agent.newThread` when
  `state.feed.length > 0`, and its comment justifies that with "a reopened thread is on screen
  without being live, so main's own copy of the conversation is empty exactly when the author
  is looking at a full one".
- `AgentOptions.registry?: Map<string, Tool>` exists and defaults to `createRegistry()`.
  `createRegistry(extra: Tool[] = [])` takes host-supplied tools. `session.ts` constructs
  `new Agent({…})` with no `registry` today.
- **`Tool` has no `defer` field** (`tools.ts:190-200`). `toolSpecs` (`loop.ts:600-604`) sets
  `defer` on every spec outside `ALWAYS_LOADED`, and only when `AgentOptions.deferTools` is on.
  A host-registered tool is therefore deferred with no declaration of its own.
- `ctx.said` is a live closure over `this.messages`, filtering
  `m.role === 'user' && typeof m.content === 'string'`. It is what the `approve_assets` triage
  model reads as the author's own words.
- `NativeAgentBackend` holds `private prevBreak = -1` and resets it when
  `messages.length <= this.prevBreak`.
- `systemSections` (`packages/authoring/src/context.ts:351-371`) emits at most three sections,
  named `BUILT-IN`, `` `PROJECT MAP (${GENERATED_CONTEXT_FILE})` `` and
  `PROJECT CONTEXT (AICONTEXT.md)`. `joinSections` composes them, and order matters: the
  author's context reads last because it states policy.
- `Convo.tokens` (`apps/desktop/src/shared/convo.ts:280`) is **cumulative billed spend** —
  input, output, cache reads and cache writes summed over every request of the conversation. It
  is not the size of the context, it reads zero on a reopened thread, and on a long live
  conversation it exceeds the context by however many times the prefix was re-sent.
- The model-id-to-vendor rule is written down **three times**: `chatVendorFor`
  (`packages/providers/src/factory.ts:11-14`), `chatBackendFor`
  (`apps/authoring/src/agent.ts:62-73`), and an inline expression at
  `apps/authoring/src/agent.ts:90` that omits the `anthropic` prefix the other two accept. All
  three fall back to `gemini` for a model id they do not recognise.
- `readDocFile` (`packages/store/src/docfile.ts:79-100`) refuses four things: a path outside
  the workspace (via `resolveInWorkspace`), a missing file, a directory, an oversized file and
  a non-text file. **It refuses nothing by name.** `read_file` (`tools.ts:322-343`) delegates
  to it unchanged.
- `keys` is gitignored at `.gitignore:2`, and a project's own key directory is
  `<projectDir>/keys` (`packages/config/src/keys.ts:161`) — inside the workspace root.
- The REPL keeps no transcript (`docs/reference/vnauthor.md`), so `threads.ts` still has
  exactly one host.

## Decisions this plan settles

### 0. No workspace read reaches `keys/`

`readDocFile` and `checkDocWrite` refuse a path whose first segment is `keys` with a sentence of
its own, so no document surface reads or writes the project's own key directory. The sentence is
`@vn/agentreport`'s, which already refuses the same directory for the debug agent's source
reader: *"keys/ holds API credentials and is never readable."*

This is a pre-existing hole rather than one this plan opens: `read_file({ path:
'keys/anthropic.txt' })` succeeds today, and the key becomes a tool observation. What makes it
this plan's business is §1. Today that observation is clamped to `OUTPUT_MAX = 2000` characters
in a display log nothing replays; a key fits well inside the clamp, but the log is not sent
anywhere. The native log records the same observation verbatim, unbounded, in a file that is
committed and that a resume replays to a provider. Adding that file on top of a readable
`keys/` would turn a bounded mistake into a durable one.

The refusal goes in `@vn/store` rather than in the native writer because `readDocFile` and
`checkDocWrite` are the two functions every document path passes through, so one pair of checks
closes `read_file`, `write_file`, `edit_file`, `doc.read` and `doc.write` together, and the
answer is a sentence the author sees rather than a silent hole in a log. Not in
`resolveInWorkspace`: it returns `string | null` and has nowhere to put a reason, so the refusal
would arrive worded as "outside the workspace". It is stage 1, and it lands before anything
writes a native log.

### 1. The backend-native messages live in a second file beside the display log

`vngen/state/threads/<id>.native.jsonl`, same directory, same id, committed like the rest of
`vngen/`.

Not extra line types in the existing file. The display log's clamps are the reason: `TEXT_MAX`
is 400 characters and `OUTPUT_MAX` is 2000, and a resumable transcript must be verbatim, so the
two files have opposite requirements at the same write boundary. Keeping them in one file would
also make every reader of the display log walk megabytes of verbatim tool output to find
kilobytes of feed, and there are three such readers: `readThread`, `listThreads`, and the
structurally duplicated `ThreadRecord` in `packages/agentreport/src/transcript.ts`.

**`listThreads` must be taught to skip it, or the saving is spent twice over.** Its filter is
`f.endsWith('.jsonl')`, which `<id>.native.jsonl` satisfies, so the Threads menu would open
every native log in the project and run the substring pre-filter over every line of it. The
filter becomes `f.endsWith('.jsonl') && !f.endsWith('.native.jsonl')`, and a test asserts a
directory holding both files lists one thread. Thread ids are timestamps, so none can end in
`.native` and be excluded by accident.

**`commitThread` commits both files.** It builds one path today. It gains the native file when
that file exists, in the same `git.commit` call, so a thread and the history that makes it
resumable are one commit. `lastCommitFor` still asks about the display log, which is the file
that always exists.

`.gitattributes` marks `vngen/state/threads/*.native.jsonl` as `-merge`, the same way a layout
template is marked. Both files are append-only, so an ordinary diff reads as exactly the lines
appended and needs no attribute for that. The merge case is different, and the archived
cache-miss plan's socket-lock argument does not cover it: the lock stops a second process on
one machine, not two clones or two branches. A three-way merge of two divergent native logs
writes conflict markers into the file, `lines()` drops the unparseable ones, and the thread then
resumes from a quietly truncated conversation. `-merge` makes git stop instead, and `readNative`
refuses a file carrying a line that starts `<<<<<<<` by name, so a conflict the author resolved
badly is also caught. The display log is left as it is: this plan does not change its merge
behaviour, and a garbled display log costs a reader accuracy rather than costing a model its
context.

What it costs. The native log is roughly the sum of every byte ever put in the model's context:
a conversation that read ten 20 KB documents and got ten model replies is a few hundred
kilobytes, and a long working session is single-digit megabytes. It is the only file under
`vngen/` that stores the author's own prose a second time, verbatim, because a `read_file`
observation contains whatever was read. A reader of `git log -p` on the project will therefore
see manuscript text inside a state file. That is the reason compaction exists and the reason
stage 7's size warning exists. It is not a privacy problem, because the bytes are already in the
same repository — and §0 is what keeps that sentence true, since a key is not already in the
repository.

### 2. A stored transcript is checked against the live backend before it is resumed, and refused by name

Five checks, in this order, each with a sentence the author reads:

1. **No native log.** Every thread written before this plan has none. Refusal: *"“<title>” was
   recorded before conversations could be continued, so only its transcript was kept. Open it
   for reading instead."*
2. **Format version.** The `resume` header carries `v`. Refusal: *"“<title>” was written by a
   newer version of VN Studio and cannot be continued here. Open it for reading instead."*
3. **Damaged log.** A line starting `<<<<<<<` means a merge was resolved into the file.
   Refusal: *"“<title>”'s history was merged from two copies and is no longer intact. Open it
   for reading instead."*
4. **Vendor.** `header.vendor !== chatVendorFor(bound.model)`. Refusal:
   *"“<title>” was recorded on <stored model> and the agent is bound to <bound model>. The two
   vendors do not share a message format, so continuing would send blocks the model cannot
   read. Bind a <stored vendor> model first, or open the conversation for reading."* This is a
   real hazard rather than a precaution:
   `packages/authoring/src/backend.ts`'s `turnOf` builds Anthropic `tool_result` shapes with
   `tool_use_id`, and a native assistant turn stores the provider's own blocks.
   [`four-chat-vendors-and-two-more-image-providers.md`](four-chat-vendors-and-two-more-image-providers.md)
   records the same hazard as unfixed today for a live model switch, and this plan does not
   depend on that one landing.
5. **Backend.** The stored `backend` must match `agent`'s current backend. Refusal:
   *"“<title>” was recorded through the native tool-calling path, which this model does not
   offer. Continuing would drop every tool call and result from the history. Open the
   conversation for reading instead."* The reason is specific: `renderTranscript` renders
   content through `messageText`, which keeps only a block's `.text`, so a native transcript
   sent down the structured path arrives with every `tool_use` and `tool_result` block silently
   missing.

**The vendor is read from the header, not recomputed.** Every one of the three copies of the
rule falls back to `gemini` for an id it does not recognise, so recomputing `chatVendorFor` over
a stored id that the current table no longer knows would answer `gemini` with no indication that
it was guessing, and check 4 would pass for two models that share nothing. The header records
the vendor that was actually in force when the thread was written, and check 4 compares that
against the vendor computed for the model bound now — one guess instead of two.

**The rule moves to one place.** `chatVendorFor` moves to `@vn/types`, and
`packages/providers/src/factory.ts`, `apps/authoring/src/agent.ts`'s two copies, and the check
all call it. It has to move rather than merely be imported: the check is a pure function shared
by main and the renderer, so it lives in `apps/desktop/src/shared/`, which is in the browser
bundle, and `@vn/providers`' index re-exports node-importing modules. Neither `tsgo` pass
catches that violation — only `vite build` does. `@vn/types` is already imported from
`src/shared/` and is node-free.

**A different model from the same vendor is allowed, and says so.** `agent.setModel`'s
description already promises that a hot model swap preserves conversation state, so resuming on
a sibling model is no worse than what the app permits mid-conversation today. The confirmation
message names both ids.

**`AgentBackend` gains `kind: 'native' | 'structured' | 'mock'`.** Check 5 needs a value to
compare, and the interface is one method with nothing to discriminate on. The three
implementations declare it, and a mock-recorded thread resumes only under a mock backend —
which is what a testkit session needs, and which stops a thread of canned strings from being
replayed to a real model.

Cost of being wrong: a resumed conversation that the provider rejects with a 400, or worse, one
it accepts having quietly lost the tool calls. Both are visible only after the author has spent
a request.

### 3. `restore` puts back `messages` and `sections`, and deliberately not the rest

`Agent.restore({ messages, sections })` sets those two and resets everything else the way
`clear()` does. There is no `system` parameter: the system prompt is recomposed with
`joinSections(sections)`, because the record stores the sections and the prompt is a pure
function of them. Storing both would be storing the same text twice and inviting them to
disagree.

- **`sections` are stored as an array, not a map.** `joinSections` concatenates in order, and
  the order is load-bearing: the author's context reads last because it states policy.
- **`restore` splices the message array in place** — `this.messages.length = 0` then
  `push(...)` — rather than assigning a new one. `messages` is `private readonly`, so the type
  already forbids the assignment, and `ctx.said` is a live closure over that exact array: a
  fresh array would leave the triage model reading an empty conversation.
- **`sections` and `system` must be restored together, or the first turn re-sends the whole
  system prompt.** `refreshSystem` on a non-empty transcript files a supersede message for
  every section whose text differs from `this.sections`. Restoring messages while leaving
  `sections` empty would file one for every section, appending the entire prompt to the
  conversation as messages. Restoring the stored sections instead means the first resumed turn
  files supersede messages only for what genuinely changed while the app was closed. It is also
  why the prompt is recomposed from the stored sections rather than rebuilt from the live
  workspace: the transcript's existing `{"role":"system"}` messages name sections relative to
  the prompt that was in force when they were written, and pairing a fresh prompt with a stale
  statement of it would leave the stale one last.
- **`mode` is always `plan`.** Execute mode is permission granted for the sitting in front of
  the author. `clear()` already resets to `'plan'`, and a resume matches it. `filedMode` is
  `undefined`, so the first turn restates the mode.
- **`seen` starts empty.** The ledger is the answer to "the files changed on disk since the
  thread was written": an empty ledger makes the agent read before it edits, which is what a
  stale entry's self-correction does anyway, without the window in which the agent believes it
  knows the contents. The refusals already read correctly for this case — `edit_file` answers
  *"<path> has not been read this conversation — read_file it first, so an edit is made against
  what is actually there"*, and `write_file` treats a missing entry as asserting no file exists,
  so an unread overwrite is refused with `already exists` rather than clobbering. Cost: one
  extra `read_file` per file the resumed agent edits.
- **`editedPaths` starts empty.** It is `git_commit`'s scope. A previous sitting's paths may
  since have been committed or reverted by the author outside the app, and sweeping them into
  the next commit would commit work nobody asked to commit.
- **`stopped` is false and `pendingSystem` is empty.**

Three consequences worth stating rather than discovering:

- `ctx.said` reads `this.messages` live, so a resume also restores what the `approve_assets`
  triage treats as the author's own words. That is correct — they are the same author's words
  in the same conversation — and it is the reason the resume note in §4 and the compaction
  summary are `context` messages rather than `user` messages. A `context` message is invisible
  to `said`, which filters on `role === 'user'`.
- `NativeAgentBackend.prevBreak` resets when `messages.length <= this.prevBreak`. A restore
  grows the array from zero, so the first request after a resume writes a fresh cache entry and
  bills the whole prefix once. There is no way around it: the provider's cache does not survive
  the app being closed.
- **A resumed conversation is live, so a surface's opener saves and closes it.** `openerFor`
  runs `agent.newThread` whenever the pane's feed is non-empty, and its comment currently
  explains that a reopened thread is safe to leave because main's copy is empty. After a resume
  that is no longer true, and the behaviour changes accordingly: clicking "ask the agent about
  this" on a surface while a resumed conversation is on screen files that conversation and
  starts a fresh one, exactly as it does for a conversation the author has been having all
  along. Nothing is lost — the thread is committed and stays resumable — but the comment is
  wrong the moment stage 4 lands, and stage 7 rewrites it along with the bullet in
  `docs/reference/desktop-app.md`.

### 4. Compaction is asked for, billed to the bound model, and appended

- **Who asks.** The author, through `agent.compact`. Nothing compacts on its own. The Convo
  pane offers it: a **Compact** button whose tooltip names how large the conversation's context
  has grown, drawn with attention styling once that figure passes `COMPACT_HINT_TOKENS`.
- **What the hint measures.** The prefix the last request actually carried, not what the
  conversation has cost. `Convo.tokens` is cumulative billed spend, so it reads zero on a
  reopened thread and, on a long one, counts the same prefix once per request. `Convo` gains
  `context?: number`, set from each `usage` event as `input + cacheRead + cacheWrite` — the
  size of what was sent, which is the quantity compaction reduces. Before the first turn of a
  resumed conversation nothing has been sent, so `context` is absent and the tooltip says how
  many messages are in the conversation and that its size is unknown until the next turn.
- **Who summarizes.** The conversation's own bound model and effort, on the author's own key,
  through the same `AgentBackend` the turns go through, as one call with no tools. Not a
  cheaper second model: the summary is what the conversation continues from, and a second model
  would need its own key resolution and its own refusal when that key is absent. The call's
  usage is emitted as the same `usage` event a turn emits, so the tokens tooltip and the
  planned `usage` thread line account for it with no new plumbing.
- **What is summarized.** The covered messages rendered through `renderTranscript`, the same
  renderer `StructuredAgentBackend` uses, so there is one transcript-as-text renderer rather
  than two. It is module-private today and stage 2 exports it.
- **Where compaction may cut.** Only where every tool call above the cut has its result above
  the cut as well, or the surviving tail would hold a result whose call is gone — or, worse,
  the summary would swallow a call and leave its answer dangling at the top of the tail.
  `lastCompleteTurn(messages)` is the largest index `to` such that every `tool_use` block in
  `messages[0…to]` has an `observation` carrying its `toolUseId` in `messages[0…to]`. This is a
  new function rather than a lift: `repairDanglingCalls` takes the trailing assistant message
  and computes nothing indexed, so there is no predicate to extract. Its test asserts both
  directions — every call above the cut is answered above it, and the first message of the tail
  is not an `observation`.
- **On disk.** A `compact` line is appended to the native log and a `compaction` line to the
  display log. Nothing already written is rewritten. Reconstruction reads the **last** `compact`
  line and builds `messages` as the summary followed by every `msg` line after `covers.to`; the
  covered lines stay in the file and are what §5's search tool reads.
- **Messages are numbered by a sequence that never restarts.** A `msg` line carries `n`, the
  count of messages ever appended to this thread, not the message's index in `Agent.messages`.
  The two are the same until the first compaction and diverge permanently after it, because
  `restore` rebuilds the live array from zero. Numbering by live index would make `n` ambiguous
  — two different messages would answer to `n = 3` — and `read_history` would return the wrong
  one. The writer recovers its counter on load as the number of `msg` lines already in the
  file, and `covers: { from, to }` is stated in the same numbering.
- **A second compaction covers everything up to its own `to`**, including a previous summary's
  range, and the summarizer is shown the previous summary plus the tail. Reconstruction is
  therefore always "the last `compact` line plus what follows it", with no chain to fold.
- **The live conversation is compacted too**, by calling `restore` with the compacted list.
  Otherwise compaction would save nothing until the app was reopened, which is the opposite of
  what the author asked for. `prevBreak` resets on the shrink, so the next request re-bills the
  now-shorter prefix once.
- **What the reader sees.** The Convo pane draws a rule in the feed under the item named by
  `afterId`, reading *"Compacted <n> messages — the agent sees a summary in place of everything
  above this line."* Clicking it opens the summary. The summary is stored in the display log
  under the existing `text` / `full` clamp pair, exactly as a `FeedItem` is, so the display copy
  is honest about being cut and the native copy is verbatim.
- **The debug agent does not read the summary, and does not need to.** A `compaction` line is a
  line type `packages/agentreport/src/transcript.ts` does not know, so its reader ignores it the
  way every existing reader ignores an unknown type. That is the right answer rather than a gap
  to fill: the display log still holds every covered item in full, above the mark, so the report
  reads the conversation the summary was made from rather than a paraphrase of it. Nothing about
  redaction changes, and `@vn/agentreport`'s `ThreadRecord` gains no field.

### 5. Two host-registered tools, `search_history` and `read_history`

- `search_history({ query, regex?, limit? })` searches every message of **this** conversation in
  the native log, including the ones a compaction summarized away. Not the display log, which is
  clamped. Not other threads: a cross-thread search is a different feature with a different
  privacy story, and this plan does not build it.
- It returns one line per hit — the message's sequence number, its role, its length, and about
  eighty characters either side of the match — capped at `HISTORY_HITS` hits and
  `HISTORY_CHARS` characters, with a sentence naming its own scope when there are none, in the
  same shape `searchTool`'s no-match sentence already uses.
- `read_history({ n })` returns one message verbatim, clamped, saying so when it clamped. A
  search hit is useless without it. The pair mirrors `list_requests` / `read_request` in
  `@vn/agentreport`.
- **Both are deferred, and neither says so.** `Tool` has no `defer` field; `toolSpecs` sets
  `defer` on every tool outside `ALWAYS_LOADED`, so a host-registered tool is deferred by
  default with no declaration. Two conditions have to hold for that to be true of these two:
  `AgentOptions.deferTools` must be on, and deferral only pays for itself on the native path
  where the prefix caches. Both hold in the desktop app, which is the only host registering
  them. The risk of deferral is that the agent never learns the tools exist, so the system
  message a compaction files names both tools by name — which is exactly when they become
  useful.
- **The host registers them; `threads.ts` does not move.** `@vn/authoring` gains
  `HistoryReader` (an interface) and `historyTools(reader): Tool[]`; the desktop app implements
  `HistoryReader` over its own `threads.ts` and passes
  `registry: createRegistry(historyTools(reader))`. The archived plan said `threads.ts` moves
  down to `@vn/authoring` when a second host wants threads. **This is not that moment**: the
  REPL still keeps no transcript, so the move would relocate a module with one caller. The
  reader interface lives in `@vn/authoring` so that the move, when it comes, is mechanical.

### 6. Read-only replay stays, and continuing is a separate act

`agent.openThread` is unchanged and keeps its promise. A new `agent.resumeThread` continues one.

Read-only is not optional: every thread written before this plan has no native log and can only
be read, so the read-only path is the permanent fallback rather than a legacy mode. Splitting
the two commands also lets each state one thing — `agent.resumeThread`'s `check` returns the §2
refusal, which a single command with a `resume` boolean prop could not do, because `check` must
answer for the props it was given.

The gesture: the Threads menu keeps running `agent.openThread`, which always works. The reopened
pane then shows a **Continue** button, enabled with the tooltip *"Continue this conversation —
the agent is shown everything above."*, or greyed with the §2 refusal sentence verbatim. That
puts the decision in front of what is being resumed, and it follows the rule that a greyed
control says why it refused.

## Record shapes

The display log, `vngen/state/threads/<id>.jsonl`, gains one line type. Everything else in it is
unchanged.

```jsonc
{
  "type": "compaction",
  "at": "2026-08-22T14:03:11.204Z",
  // The feed item the rule is drawn under.
  "afterId": 41,
  // How many native messages the summary replaced, for the rule's sentence.
  "covers": 38,
  "model": "claude-opus-4-8",
  // The same clamp pair a `FeedItem` uses: `text` at TEXT_MAX, `full` at FULL_MAX and present
  // only when something was cut.
  "text": "The author settled the second scene's staging and…",
  "full": "The author settled the second scene's staging and…"
}
```

The native log, `vngen/state/threads/<id>.native.jsonl`:

```jsonc
// Line 0, written when the thread's first message is appended.
{
  "v": 1,
  "type": "resume",
  "thread": "20260822-140028",
  "at": "2026-08-22T14:00:28.041Z",
  "backend": "native",       // 'native' | 'structured' | 'mock'
  "vendor": "anthropic",     // chatVendorFor(model), stored rather than recomputed on read
  "model": "claude-opus-4-8",
  "effort": "low",
  // The system prompt as named sections, in `joinSections` order, so a resume can diff live
  // against stored and file supersede messages only for what actually changed. The names are
  // `systemSections`'s own.
  "sections": [
    { "name": "BUILT-IN", "text": "You are…" },
    { "name": "PROJECT MAP (GENERATED_CONTEXT.md)", "text": "--- PROJECT MAP …" }
  ]
}

// One per message appended to `Agent.messages`, in order. `n` counts messages ever appended to
// this thread and never restarts, so it stays a stable name for a message after a compaction
// rebuilds the live array from zero.
{ "type": "msg", "n": 0, "at": "…", "role": "user", "content": "Draft the second scene." }
{
  "type": "msg", "n": 1, "at": "…", "role": "assistant",
  // Verbatim provider blocks on the native path; a plain string on the structured one.
  "content": [
    { "type": "thinking", "thinking": "…", "signature": "…" },
    { "type": "tool_use", "id": "toolu_01A…", "name": "read_file", "input": { "path": "scenes/two.md" } }
  ]
}
{ "type": "msg", "n": 2, "at": "…", "role": "observation", "toolUseId": "toolu_01A…", "content": "…" }

// Appended when `refreshSystem` reports a change, so the stored sections stay current without
// rewriting line 0. Only the delta; a reader folds these onto line 0's list in order, replacing
// a section of the same name in place and appending a new one at the end.
{ "type": "sections", "n": 12, "at": "…", "set": [{ "name": "PROJECT MAP (GENERATED_CONTEXT.md)", "text": "…" }], "unset": [] }

// Appended when the author compacts. Nothing above it is touched. `from`/`to` are `n` values.
{
  "type": "compact",
  "at": "2026-08-22T14:03:11.204Z",
  "covers": { "from": 0, "to": 37 },
  // The summary as an `AgentMessage`. `context` rather than `user`, so `ctx.said` does not
  // read it as something the author typed.
  "role": "context",
  "content": "The author settled the second scene's staging and…",
  "model": "claude-opus-4-8",
  "usage": { "input": 41208, "output": 1104 }
}
```

## Stages

Each stage is a commit that is green under `pnpm check`, `pnpm test` and `pnpm lint`.

### Stage 1 — `keys/` is not a readable document directory

`packages/store/src/docfile.ts`.

- `inSecretsDir(path)` and `SECRETS_REFUSAL` beside `guardedDir`, which is the analogous
  "who owns this path" predicate. `readDocFile` checks before its `stat`, so the refusal is the
  same whether or not a key file is there; `checkDocWrite` checks before `guardedDir`.
- The comparison is case-insensitive, because Windows resolves `Keys/` to the same directory and
  refusing a differently-cased directory on a case-sensitive filesystem costs nothing.
- Every caller inherits it: `read_file`, `write_file`, `edit_file`, `doc.read` and `doc.write`.
- `@vn/agentreport`'s `refuseByPolicy` drops its own copy of the rule and calls these, so the
  sentence is written once.
- `docs/guides/api-keys.md`'s "Keeping a key safe" list gains the fact, because it is the guide
  the Setup editor renders and a reader there is asking exactly this question.

Tests (`packages/store/src/tests/docfile.test.ts`): a file under `keys/` is refused by name
whether or not it exists; `keys` itself is refused; `Keys/` is refused; a path merely containing
the segment deeper down (`wiki/keys/notes.md`) is allowed, because the guard is about the
project's own key directory rather than the word; `checkDocWrite` refuses before it considers
what is being written.

### Stage 2 — `Agent.restore` and one place messages are appended

`packages/authoring/src/loop.ts` and `backend.ts`.

- Route every `this.messages.push(…)` through a private `append(m)` that also calls a new
  `AgentOptions.onMessage?: (m: AgentMessage) => void`. `repairDanglingCalls`'s pushes go
  through it too: a repair is part of the transcript the next turn reads.
- Add a read accessor `get transcript(): readonly AgentMessage[]`, because stages 3 and 5 need
  to read `messages` and it is `private` with nothing exposed.
- Add `restore(state: { messages: AgentMessage[]; sections: SystemSection[] })`, which resets
  exactly what `clear()` resets, splices the message array in place, installs the sections, and
  sets `system` to `joinSections(sections)`. It does not fire `onMessage` — the messages it
  installs came from the log it would write to.
- `refreshSystem` returns its delta, `{ set: SystemSection[]; unset: string[] } | undefined`,
  instead of `void`. Stage 3's call site needs to know what changed and cannot see private
  state. `undefined` covers both cases with nothing to record: the prompt was replaced outright
  on an empty transcript, or every section already read the way it was handed in.
- Add `lastCompleteTurn(messages): number` (exported): the largest index whose prefix leaves no
  tool call unanswered and whose next message is not an `observation`. Used by stage 5's
  compaction. The second clause is what carries the structured path, where calls are JSON in an
  assistant message and nothing ever reads as open.
- Add `restorable(messages)` (exported): `repairDanglingCalls` applied to a restored array, so a
  conversation interrupted mid-tool-call resumes rather than 400s.
- Export `renderTranscript` from `backend.ts`, and add `kind: 'native' | 'structured' | 'mock'`
  to `AgentBackend`, declared by `NativeAgentBackend`, `StructuredAgentBackend` and
  `MockAgentBackend`.

Tests (`packages/authoring/src/tests/loop.test.ts`): `restore` then `run` continues from the
restored messages; `restore` with a dangling `tool_use` appends the repair observation;
`restore` followed by `refreshSystem` with identical sections files no supersede message and
returns `undefined`, and with one changed section files exactly one and returns it; `ctx.said`
after a restore returns the restored user turns; `lastCompleteTurn` on a mid-tool-call array,
and on one whose next message is an `observation`.

### Stage 3 — the vendor rule has one home

`packages/types`, `packages/config/src/keys.ts`, `packages/providers/src/factory.ts`,
`apps/authoring/src/agent.ts`.

- `chatVendorFor` moves to `@vn/types`, into `textmodels.ts`, which already holds the model list
  for the same reason: the renderer asks these questions and cannot import a package that loads
  a vendor SDK. `@vn/providers` re-exports it so its callers are unchanged. `chatBackendFor` and
  the inline expression at `agent.ts:90` both call it, which also fixes the third copy's
  disagreement about the `anthropic` prefix.
- Its return type is a new `ChatVendor` in `@vn/types`, because `ResolvedKeys` lives in
  `@vn/config` and `@vn/config` already imports `@vn/types`. `ResolvedKeys` becomes
  `Record<ChatVendor, string>`, so the vendor list is written once rather than twice.
- It is a separate stage because it touches four packages and fixes an existing inconsistency,
  and because stage 4's check cannot import from `@vn/providers` at all.

Tests (`packages/types/src/tests/textmodels.test.ts`): `chatVendorFor` answers `anthropic` for
a bare `claude-` id, an `anthropic/`-prefixed one, and either cased differently, and `gemini`
for everything else. Both `agent.ts` call sites now call it, so agreement is structural.

### Stage 4 — the native log is written

`apps/desktop/src/main/threads.ts` and `apps/desktop/src/main/session.ts`.

- `nativeFile(paths, id)`, `appendNative(paths, id, line)`, `readNative(paths, id)`, and
  `nativeHeader(paths, id)` for the cheap check stage 5 needs. `readNative` folds `resume`,
  `msg`, `sections` and `compact` into `{ header, messages, sections, compaction? }`, skipping
  unparseable lines the way `lines()` already does, and refusing outright when a line starts
  `<<<<<<<`.
- `listThreads` skips `*.native.jsonl`.
- `commitThread` passes both paths when the native file exists.
- `.gitattributes` gains `vngen/state/threads/*.native.jsonl -merge`.
- `ensureAgent` passes `onMessage`, which appends through the same `this.writes` chain
  `record` uses, warning rather than throwing on a write failure, and keeps the `n` counter. The
  header line is written lazily on the first message, alongside `beginThread`.
- `runAgent` calls `refreshSystem` before `beginThread(input)`, so on a thread's first turn the
  header does not exist yet. The first turn's sections are therefore written into the header
  line itself rather than as a delta; from the second turn on, a non-`undefined` return from
  `refreshSystem` appends a `sections` line.

Nothing reads the file yet. The stage is green and starts accumulating history, which is what
makes stage 5 testable against real transcripts.

Five things landed differently from the sketch above.

- `ResumeHeader` lives in `apps/desktop/src/shared/convo.ts` rather than in `main/threads.ts`,
  because stage 5's `resumeRefusal` reads it from the renderer as well as from main. It reaches
  `BackendKind` and `SystemSection` by type-only import, which `ipc.ts` already does for the same
  package and the same reason.
- The conflict refusal is an opt-in `refuseConflicts` flag on the shared `lines()` helper,
  checked before the `keep` pre-filter so `nativeHeader`'s filtered read catches a damaged file
  too. It throws a `ConflictedLogError` carrying the path, which stage 5 catches by type.
- The header stores the vendor rather than leaving it to be recomputed on read. Every copy of the
  rule answers `gemini` for an id it does not know, so recomputing over a model the current table
  has forgotten would answer without saying it was guessing.
- `buildBackend` splits into a recording wrapper over a new `chooseBackend`, because `Agent` does
  not expose the backend it was handed and the log has to record which protocol its messages are
  in. Every rebuild — `ensureAgent`, `setModel`, `setEffort` — passes through the wrapper.
- `ensureGitAttributes` now holds a list of blocks and appends whichever it cannot find. The
  single-line `includes` check it had would have read a project created before this stage as
  already attributed, and never given it the new line.

Tests (`apps/desktop/src/main/tests/threads.test.ts`): a round trip through `appendNative` /
`readNative`; a garbage line is skipped and a conflict marker is refused; `readNative` on a
thread with no native file answers absent rather than throwing; `listThreads` on a directory
holding both files reports one thread; `readThread` on a thread that has both files is
byte-for-byte what it was before.

### Stage 5 — resuming

- `resumeRefusal(header, bound)` in `apps/desktop/src/shared/threads.ts`: pure, node-free,
  returning the sentence or `undefined`, so main and the renderer show the same words. It
  imports `chatVendorFor` from `@vn/types`.
- `session.resumeThread(id)`: read the native log, run the check,
  `agent.restore(restorable(…))`, rebind model and effort, set `this.thread` to the stored
  header, and set `this.convo` to the display record's items so main's copy matches the screen.
  File a `context` message naming the commit the thread was last archived at — the newest entry
  of `header.archived`, which is a list rather than a single commit — when it has one.
- `agent.resumeThread` in `apps/desktop/src/main/commands/agent.ts`, with `check` returning
  `resumeRefusal`'s sentence, plus the busy check `idle(host)` already provides. The block
  comment above the thread commands says "The four thread commands"; it becomes six across this
  stage and stage 6.
- The renderer: a `RESUMED` banner replacing `REOPENED` for this path, a **Continue** button in
  the Convo pane's button row, and `agent.resumeThread` handled in `pathux/agent.ts` beside
  `agent.openThread`. `openerFor`'s comment is rewritten: a resumed conversation is live, so the
  opener files it and starts a fresh one.

Tests: `resumeRefusal` for each of the five cases and for the allowed sibling-model case
(`apps/desktop/src/shared/tests/`); a session test that resumes a thread written by an earlier
session and asserts the agent's next turn sees the earlier messages.

Six things landed differently from the sketch above.

- `resumeRefusal` takes the thread's title, a `ResumeState` and a `ResumeBinding` rather than a
  header, because two of the five answers are about a log that yielded no header: one a merge
  damaged, and one that was never written. `ResumeBinding.backend` is optional, so the renderer
  runs the first four checks and main runs all five. The renderer cannot derive the bound protocol
  without repeating the fact that only Anthropic implements `chatConversation`, and the case the
  plan names as the acceptance criterion — an Anthropic thread against a Gemini binding — is the
  vendor check, which the renderer does run.
- The damaged check runs first rather than third. `readNative` throws on a conflict marker, so a
  damaged log has no header for the version, vendor or protocol checks to read.
- `NATIVE_VERSION` moved from `main/threads.ts` into `shared/threads.ts`, re-exported from where it
  was, so the writer of line 0 and the check against it share one number.
- Nothing is rebound. The refusal has already excluded every stored conversation the model bound
  now could not read, and `setModel` already promises a mid-conversation swap keeps the transcript,
  so continuing on a sibling model needs no rebinding. `resumeNote` names the swap for a surface
  that wants to show it.
- The gap note is filed on every resume rather than only when the thread has been archived. The
  commit is one clause of it; the sentence that has to be there either way is that the read ledger
  did not survive, since `restore` drops it and `edit_file` refuses a file this conversation has
  not read. It goes into `restore`'s message array rather than through a new public `append`, and
  is deliberately not written to the log: it is derived from the header, so the next resume derives
  it again.
- The Convo pane draws the Continue button only while a saved conversation is on screen for
  reading. `pathux/agent.ts` holds that thread in `reopenedThread()`, and the pane's `stateKey`
  keys on its id.

### Stage 6 — compaction

- `packages/authoring/src/compact.ts`: `compactionPrompt(messages)` and
  `compactRange(messages, to)` — pure, returning the new message list given a summary. The
  model call itself is one `backend` call the host makes.
- `session.compactThread()`: pick `to` with `lastCompleteTurn`, render, call, append the
  `compact` line to both logs, `agent.restore(compacted)`, and emit the usage event.
- `agent.compact` in `commands/agent.ts`, `mutating: true` (it writes a file) and not undoable,
  with refusals for a busy session, a conversation with no completed turn, and one already
  covered to its end.
- The Convo pane: the **Compact** button, `Convo.context`, `COMPACT_HINT_TOKENS`, the feed rule,
  and the popup that shows the summary. `readThread` gains `compactions: CompactionMark[]` on
  its own `ThreadRecord`.

Tests: `compactRange` never cuts between a call and its result and never leaves an `observation`
first in the tail; a second compaction covers the first; `readThread` returns the marks in
order; `contextDetail` says the size is unknown when no turn has run; a mock-backend session
test that compacts and then runs a turn, asserting the request carries the summary and not the
covered messages.

### Stage 7 — searching the uncompacted history

- `packages/authoring/src/history.ts`: `HistoryReader`, `historyTools(reader)`, `HISTORY_HITS`,
  `HISTORY_CHARS`, and the two tool definitions.
- The desktop implements `HistoryReader` over `readNative`, and `ensureAgent` passes
  `registry: createRegistry(historyTools(reader))`.
- The compaction system message names both tools.

Tests: a hit's window is centred on the match and clamped; the cap is respected; the no-match
sentence names the scope; `read_history` on an unknown `n` refuses by name; a compacted thread's
`read_history` still returns a covered message; `tool('search_history').args.safeParse` rejects
an empty query.

### Stage 8 — documentation

- `docs/reference/desktop-app.md`, the threads bullet: it currently says reopening is read-only
  "because restoring the model's own messages is separate work". That sentence goes; the bullet
  gains the two files, the Continue button and its refusals, compaction, and the fact that a
  resumed conversation is filed when a surface opener starts a new one.
- `docs/reference/desktopAppState.md`: a row for `vngen/state/threads/<id>.native.jsonl` beside
  the existing transcript row, its size warning, and the paragraph that ends "the model is not
  shown a word of it" rewritten.
- `docs/reference/vnauthor.md`: the paragraph saying the REPL keeps no transcript gains the fact
  that the native log is what a resume reads, and that the REPL still writes neither.
- `docs/reference/agent-report.md`: the report reads the display log and never the native one,
  and it ignores a `compaction` line because the covered items are still above the mark.
- The Threads button tooltip (`apps/desktop/renderer/pathux/editors/convo.ts:218-220`) and
  `agent.openThread`'s description both promise read-only replay. Both keep that promise and
  gain a mention of Continue.
- `docs/reference/command-system.md`: rows for `agent.resumeThread` and `agent.compact`.
- `CLAUDE.md`: the conversation-threads bullet gains "a thread is resumed rather than replayed
  when its native log is present and the bound model matches".
- `docs/plans/index.md`: flip this row to shipped and move the file to `archive/`.
- An As-shipped section here recording every deviation.

## Acceptance

- Closing the app mid-conversation, reopening it, and pressing Continue produces a turn that
  refers to what was said before the app closed.
- Reopening a conversation recorded on an Anthropic model, then binding a Gemini model in the
  model bar, greys Continue with the sentence from §2 — before a request is sent. The rebind is
  what makes this reachable: `openThreadForReading` restores the thread's own model, so the
  mismatch only exists once the author changes it.
- A thread written before this plan opens read-only, and its Continue button is greyed with the
  sentence saying only its transcript was kept.
- A native log carrying a conflict marker is refused by name rather than resumed short.
- `listThreads` on a project with fifty conversations opens fifty files, not a hundred.
- `read_file` on a path under `keys/` is refused, and no key can reach a native log.
- Compacting a conversation appends to both logs and rewrites no existing line: the byte range
  of both files before the compaction is unchanged afterwards, asserted in a test.
- After compacting, the next request carries the summary and not the covered messages, and the
  pane draws the rule in the right place.
- `search_history` finds a phrase that appears only in a message a compaction covered, and
  `read_history` returns that message by the `n` the search reported.
- A resumed conversation's first `edit_file` on a file the earlier sitting read is refused with
  the read-it-first sentence rather than editing against a stale hash.
- `pnpm check`, `pnpm test` and `pnpm lint` are green at every stage.

## Undoing this

Cheap to undo up to stage 5, and progressively less so after.

- **Stage 1** is not undone. It closes a hole that predates this plan.
- **Stages 2–4** leave no user-visible surface. Dropping them means deleting `restore`,
  `onMessage`, the `native.jsonl` writer, and the stray files already written — which are inert,
  because nothing reads a file whose reader is gone. The `listThreads` filter and the
  `.gitattributes` entry should stay regardless, since they cost nothing and the files remain.
- **Stage 5** removes two commands and a button. Threads written in the meantime keep their
  native logs; they simply stop being resumable.
- **Stages 6–7** are the ones with a cost. A `compact` line already in a native log makes that
  thread's reconstruction depend on code that would no longer exist, so removing compaction
  means either keeping the reconstruction rule or accepting that compacted threads resume to
  their full length again. The latter is correct but expensive, and it is silent, so a removal
  should keep the fold and drop only the command.
- **Nothing here is undoable through the app.** `vngen/state` sits outside the undo shadow
  snapshot, which is why `agent.compact` joins `agent.renameThread` as mutating but not
  undoable.
- The one irreversible decision is the on-disk format. A `resume` line carries `v`, and an
  unrecognised `v` is refused by name in §2 rather than misread, so a later format change costs
  old threads their resumability and nothing else.

## Review

A fresh-context agent pressure-tested this plan against the code before any of it was written.
Twenty-two findings came back. What each one changed is below.

### Changed a decision

- **A key could reach the native log.** `readDocFile` refuses a path outside the workspace, a
  missing file, a directory, an oversized file and a non-text file, and nothing else — so
  `read_file({ path: 'keys/anthropic.txt' })` succeeds today and the key becomes an observation.
  The display log clamps it to 2000 characters and replays it nowhere; the native log would
  store it verbatim in a committed file and send it back to a provider on every resumed turn.
  §0 and stage 1 close it at `resolveInWorkspace`.
- **The cut point orphaned the results it was meant to protect, and the predicate it said to
  lift does not exist.** `repairDanglingCalls` works from the trailing assistant message and
  computes no index. §4 now defines `lastCompleteTurn` outright, by the prefix-answered
  property rather than by "the last assistant message with no unanswered call", and its test
  asserts the tail does not open with an `observation`.
- **A message index is ambiguous after a compaction**, because `restore` rebuilds
  `Agent.messages` from zero. `read_history({ index })` would have returned the wrong message.
  Messages now carry `n`, a per-thread sequence that never restarts, and `covers` is stated in
  it.
- **`listThreads` would have opened every native log.** Its filter is `f.endsWith('.jsonl')`,
  which `<id>.native.jsonl` satisfies — so the file added to keep megabytes out of the Threads
  menu would have been read by it. §1 adds the exclusion and a test.
- **Nothing committed the native log.** `commitThread` builds one path. §1 and stage 4 extend it.
- **`Convo.tokens` is the wrong quantity for the Compact hint.** It is cumulative billed spend:
  zero on a reopened thread, and several times the context on a long one. §4 adds
  `Convo.context`, the size of the last request's prefix, and says what the tooltip shows before
  the first turn.
- **`resumeRefusal` could not have imported `chatVendorFor`.** It lives in
  `apps/desktop/src/shared/`, which is in the browser bundle, and `@vn/providers`' index
  re-exports node-importing modules — a violation neither `tsgo` pass catches. Stage 3 moves the
  rule to `@vn/types`.
- **The vendor check rested on a rule written three times, one of which disagreed**, all three
  falling back to `gemini` for an unrecognised id, so the check would have passed for two
  unrelated vendors. Stage 3 makes it one function, and §2 reads the vendor from the header
  rather than recomputing it, so an id the current table no longer knows is not silently
  guessed.
- **`restore` took a `system` the record does not store.** It is now recomposed with
  `joinSections`, and sections are stored as an ordered array rather than a map, because
  `joinSections` concatenates in order and the author's context must read last.
- **`Agent.messages` is `private readonly` with no accessor**, so stages 4 and 6 had nothing to
  read; and `ctx.said` closes over that exact array, so `restore` must splice in place. Both are
  now in stage 2.
- **`AgentBackend` has no discriminator**, so check 5 had nothing to compare and
  `MockAgentBackend` was covered by neither branch. §2 adds `kind`, and a mock-recorded thread
  resumes only under a mock backend.
- **The plan claimed a compaction summary is redacted when the report reads a thread.** It is
  not: `@vn/agentreport`'s `ThreadRecord` has no such field and `redactEvidence` scrubs a closed
  list. Rather than add the field, §4 now states the correct answer — the report ignores the
  line, and loses nothing, because every covered item is still in the display log above the mark.
- **The `.gitattributes` argument misused the socket lock**, which is per machine rather than
  across clones or branches. A merged native log would have carried conflict markers that
  `lines()` drops silently, resuming a quietly truncated conversation. §1 marks the file
  `-merge` and §2 adds a fifth check that refuses a damaged log by name.
- **Both agent openers would have filed a resumed conversation**, and `openerFor`'s comment
  explains the old behaviour in terms that stop being true. The behaviour is correct — a live
  conversation is saved and closed — so §3 states it and stage 5 rewrites the comment.

### Filled a gap

- **`refreshSystem` returns `void`**, so stage 4's call site could not have seen the delta it
  was asked to write. Stage 2 changes the return type, and stage 4 says where a first turn's
  sections land: in the header line, because `refreshSystem` runs before `beginThread`.
- **`renderTranscript` is module-private.** Stage 2 exports it.
- **`Tool` has no `defer` field.** `toolSpecs` sets `defer` from `ALWAYS_LOADED`, and only when
  `deferTools` is on, so the two history tools are deferred with no declaration of their own.
  §5 states the two conditions the cost argument depends on.
- **`header.archived` is a list**, not a commit. Stage 5 takes its newest entry.
- **Acceptance criterion 2 was unreachable through the gesture §6 describes**, because
  `openThreadForReading` rebinds the model from the record, so the vendor always matches
  straight after a reopen. The criterion now names the rebind that creates the mismatch.
- **The `sections` example did not match `systemSections`.** The real names are `BUILT-IN`,
  `` `PROJECT MAP (${GENERATED_CONTEXT_FILE})` `` and `PROJECT CONTEXT (AICONTEXT.md)`. The
  filename inside the second is a constant rather than per-project, so a name-keyed diff is
  stable; if that constant ever changed, the diff would read as a withdraw plus a supersede,
  which is verbose and still correct.
- **A stale block comment** at `apps/desktop/src/main/commands/agent.ts:132-136` counts four
  thread commands and becomes wrong; **the Threads button tooltip** at `convo.ts:218-220` was
  missing from the documentation stage. Both are now listed.

### Recorded, not changed

- The reviewer offered a subdirectory as an alternative to filtering `*.native.jsonl` out of
  `listThreads`. The filter is kept: the two files are one conversation, and a `.native.jsonl`
  beside its display log is what makes that obvious in `git status` and `git log`. A test pins
  the filter, which is what the alternative was buying.
- The reviewer's cut-point definition carried a second clause — that `messages[to+1]` must not
  be an `observation`. This section first recorded it as implied by the first clause; that was
  wrong, and stage 2 kept the clause. It is implied only on the native path, where a call is a
  `tool_use` block the prefix-answered test can see. On the structured path a call is JSON
  inside an assistant message, so nothing ever reads as open, every index satisfies the first
  clause, and the second clause is the only thing keeping a cut between a call and its answer.

### Citations

Line numbers in "What exists today" were re-read against the current tree and corrected where
they had drifted: `Agent.messages` is `loop.ts:430`, `repairDanglingCalls` is `loop.ts:614`,
`commitThread` is `session.ts:1285`. The reducers file is `apps/desktop/src/shared/convo.ts`.

### Sound as written

The reviewer confirmed, against the code: §1's two-file argument and the clamps behind it; §2's
backend check and the `messageText` behaviour that motivates it; §3's sections-and-system
pairing, and the empty-`seen` and empty-`editedPaths` reasoning; the `prevBreak` note; that an
unknown line type is ignored by every existing reader; the `restorable` design and its
mid-turn-crash case; §6's two-command split; and the "Undoing this" section.

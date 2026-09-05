# Provider Credentials and the AI Usage Ledger

Status: **planned**

## Context

What are our options for full OAuth support for Google Gemini, Claude, ChatGPT and Midjourney (those
sound like 4 good services to start with)? We will presumably need an "AI usage" editor showing
tokens used and costs. Service providers that use a credit system should show their remaining credits
in the main header (and in the AI usage editor).

Users should be able to log in to their preferred AI providers directly, so that we do not have to
act as the financial intermediary for token costs.

The second message is the requirement; the first is one guess at how to meet it. This plan keeps the
requirement: every author's generation is billed to that author's own account, and the project never
sits in the middle of a payment. The plan replaces the mechanism, because for three of the four
services the mechanism does not exist.

It also closes two entries already listed in `todos.md`:

```
[ ]: the add model key dialog should have a dropdown to select anthropic vs google gemini
[ ]: the agent should show a running total of tokens used to the user similar
     to how claude code shorts total tokens.
```

## What is actually available, per provider

"Log in with your provider account" is not something a desktop app can do for programmatic model
access, except in one case. That finding shapes everything below.

| Service | Third-party OAuth for API use? | What we can actually do |
| --- | --- | --- |
| **Anthropic / Claude** | **No.** The only OAuth is `ant auth login`, a *developer-machine CLI* flow that writes a profile under `%APPDATA%\Anthropic`. It is not a published third-party-app OAuth API — there is no client id to register and no consent screen we can drive. | Take an API key. Additionally *honour* a profile that is already there, since a zero-arg SDK client picks it up. |
| **Google Gemini** | **Yes, one path.** Vertex AI authenticates by GCP Application Default Credentials (`gcloud auth application-default login`) — real OAuth, and the tokens live in the user's gcloud config, never in ours. Usage bills to a GCP project with billing enabled, not to a personal Google account. The AI Studio / consumer Gemini API is API-key only. | Take an API key for AI Studio; offer a `vertex` vendor whose entire auth story is "run `gcloud auth application-default login`". |
| **OpenAI / ChatGPT** | **No.** API access is API key + org billing. There is no OAuth path that spends a ChatGPT Plus/Pro subscription — the subscription and the API are separate products with separate billing. | Take an API key, if and when an OpenAI backend is wanted at all. |
| **Midjourney** | **No API at all.** Access is the Discord bot; every "Midjourney API" is an unofficial wrapper that violates their terms. | **Out of scope.** Recorded here once so it is not re-proposed. |

Two consequences follow, and both change the shape of the UI:

- For Anthropic, OpenAI and Gemini/AI Studio, "log in to your provider" collapses to "paste your
  key". That still meets the requirement, because the key belongs to the author and the bill goes to
  the author, but it means the work is in handling keys well rather than in building an OAuth client.
- **No provider exposes a credit balance over the API.** Anthropic and OpenAI both retired or never
  shipped a balance endpoint for ordinary keys; Gemini has none. The header therefore cannot show
  remaining credits. It shows spend to date, computed from the requests sent. Spend to date is the
  number the author wanted the balance for. See [Balance, honestly](#balance-honestly).

## What exists today

### Keys

- `resolveKeys(config, {secretsDirs, require})` — packages/config/src/keys.ts:84. Returns a full
  `ResolvedKeys` (keys.ts:6) with exactly two fields, `gemini` and `anthropic`. An unresolved vendor
  comes back as `''` rather than `undefined`. `KEY_VENDORS` (keys.ts:12) is exported so that a UI can
  enumerate the vendors.
- Each vendor resolves in a fixed order (`resolveOne`, keys.ts:60).
  `process.env[config.keys[vendor]]` comes first, then each directory in `secretsDirs` paired with
  each name in `SECRET_FILES[vendor]` (keys.ts:15 — `gemini.txt`; `claude.txt` then `anthropic.txt`).
  `secretDirsFor` (keys.ts:50) is `[<project>/keys, <repoRoot>/keys]`.
- Errors name the source and never the value — `missing ${name} API key: set $${envName} or place
  ${file} in a keys/ dir` (`keys.ts:92`).
- `project.setKey` — apps/desktop/src/main/commands/project.ts:62. `mutating: true`, `undoable:
  false` (an undo point is a git snapshot, and snapshotting a credential is the one thing this
  command exists to avoid), props `provider: prop.oneOf(KEY_VENDORS)` and `key: prop.secret(...)`.
  `check` calls `session.previewKey` (session.ts:1622).
- `WorkspaceSession.setKey` (`session.ts:1636`) trims, calls `ensureIgnored(dir, ['keys'])` before
  it writes anything, then writes `keys/<secretFileFor(vendor)>` atomically. It deliberately reports
  `written: ['.gitignore']` or `[]`, and never lists the key file.
- `digestProps` (`packages/commands/src/digest.ts:38,51`) redacts `prop.secret`
  (`packages/commands/src/props.ts:78,116`) to `<secret>`. It is the only record-time projection, so
  the stored props, the formatted invocation and the commit trailer all carry the redacted value.

The todo about a dropdown is more subtle than it appears. The dropdown already exists, because
`provider` is a `prop.oneOf(KEY_VENDORS)` and the form draws an enum menu from it. The problems lie
in everything around it:

1. 1. `provider` has no default, so the form opens with an empty menu label (commandform.ts:132,
   `String(value ?? '')`) and looks broken.
2. 2. **`prop.secret` renders as a plain visible textbox.** `CommandForm.field`
   (commandform.ts:106-161) branches on `digest`, `boolean`, `enum`, then falls through to
   `row.textbox(...)` at line 147. There is no `secret` branch, so the field is neither masked nor
   cleared on blur. Redaction is implemented on the persistence side and absent on the presentation
   side.
3. 3. **The plaintext key crosses IPC on every keystroke.** The textbox callback calls `recheck()`
   (commandform.ts:80-86), which invokes `command:check` with the whole `values` object. Each call
   sends a partial credential to main, even though this command's `check` consumes only `provider`
   (project.ts:78).
4. 4. **No read-back.** There is no `project.clearKey` and no way to ask which keys are present.
   `projectView` (session.ts:1557) reports models and image params and explicitly disclaims key
   state. Key state surfaces only in `runPreconditions.keyError` (session.ts:2908).
5. 5. **A silent overwrite.** The code computes `had` (session.ts:1650) but uses it only for
   past-tense wording; there is no `confirm`.
6. 6. **A key written while the env var is set has no effect** — `keyFile` (session.ts:1608) appends
   an advisory sentence and the command still returns `ok: true`.
7. 7. **The pipeline requires the wrong vendor.** `buildProviders` (session.ts:492),
   `runPreconditions` (session.ts:2920) and the CLI (apps/cli/src/project.ts:67) all pass `require:
   ['gemini']`, while `models.text` defaults to `claude-opus-4-8`
   (packages/types/src/schemas.ts:286). A project with a Gemini key and no Anthropic key passes
   preconditions and then fails mid-run at the first text or reviewer call.

### Usage and cost: none, anywhere

A repo-wide search for `usage|input_tokens|output_tokens|totalTokens|costUsd` finds zero hits in
first-party source. Every response object carries the data, and the code discards it:

- `ChatBackend.message` returns `Promise<string>` (packages/providers/src/backend.ts:48-52). The
  Anthropic backend destructures text out of `res` and discards `res.usage`
  (backends/anthropic.ts:64-74, :91-110); the Gemini backend discards `res.usageMetadata`
  (backends/gemini.ts:106-112, :118-143, :164-172).
- `ImageResult` (packages/types/src/providers.ts:9-16) carries `bytes`/`ext`/`modelId`/`seed?` and
  nothing else. `ChatToolReply` (backend.ts:33) has no usage field. `TaskAttempt`
  (packages/types/src/tasks.ts:51-62) has no usage field.
- `costPreview` (packages/pipeline/src/pipeline.ts:48-74) is the only cost surface. It counts
  planned calls in advance and assumes the worst case, and it reports no tokens, no dollars, and no
  reconciliation against what happened. It reaches the UI at session.ts:2962.

The call count is invisible at every layer. `callWithRetry` (3×, `backends/transient.ts:64`) ×
`withStructuredRetry` (3×, `structured.ts:63`) × `ChatTextLLM.structured` (3×, `text.ts:18`) ×
`StructuredAgentBackend`'s parse loop (3×, `packages/authoring/src/backend.ts:126-137`) ×
`max_refine_attempts` (4) × `max_task_attempts` (2). None of these layers reports how many calls it
made, and a layer that retries on a parse failure retries calls that already succeeded and were
already billed.

### The ledger pattern to copy

`vngen/state/notifications.jsonl` is the working model, and it is a good one. The path is
`ProjectPaths.notificationsLog` (packages/store/src/paths.ts:142), each line carries a version
(packages/types/src/notifications.ts:51), and `adoptGitAttributes` sets `merge=union` on it
(apps/desktop/src/main/workspace.ts:236). Lines are appended with `appendJsonl`
(packages/util/src/fs.ts:27-30) rather than rewritten atomically as a whole file, and they are filed
from main's single `onRecord` hook (apps/desktop/src/main/index.ts:401-417). The log sits outside
undo, because `vngen/state` is excluded from `UNDO_PATHS` (index.ts:339). Reads go over a plain IPC
channel (`notify:list`), while every mutation is a command (main/commands/notify.ts). Changes reach
the renderer over `notify:changed`, land in a `ShellState` field, pass through `stateKey()`, and show
up on the bell badge.

A usage ledger requires all of that except the byte-offset flag patching. No part of a usage record
is ever edited in place, so the ledger needs none of `setNotificationFlags`' `Buffer` arithmetic and
can use ordinary readable keys.

## Design

### 1. Usage is a property of the response, so the seam widens

`ChatBackend.message` becomes:

```ts
export interface ModelUsage {
  inputTokens: number;      // the uncached remainder only, on vendors that split it out
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  images?: number;
  calls: number;            // billed HTTP calls this value accounts for
}

export interface ChatReply { text: string; usage?: ModelUsage }

message(req: ChatRequest): Promise<ChatReply>
```

`ChatToolReply` gains `usage?`, and `ImageResult` gains `usage?` (additive, non-breaking).
`ModelUsage` lives in packages/types/src/providers.ts, in `@vn/types` rather than `@vn/providers`,
because the renderer must name the shape without pulling a vendor SDK. `TEXT_MODELS` lives in
`@vn/types` for the same reason (packages/types/src/textmodels.ts:1-6).

The alternative considered and rejected was an injected usage sink. It is smaller today, because
`message(): Promise<string>` has five implementors (`ChatTextLLM`, `ChatVisionReviewer`,
`StructuredAgentBackend`, `NativeAgentBackend`, `RecordedChatBackend`). It is wrong permanently,
because usage describes one response, and a sink turns it into an ambient event that some other layer
has to correlate back. The caller adds the attribution (which task, which thread, which purpose),
because the caller is the layer that knows.

**Prompt size is the sum of three fields.** On Anthropic, `input_tokens` counts only the uncached
remainder, and the total prompt is `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens`. A ledger that records `input_tokens` alone under-reports badly on any
cached agent loop, and the priced total must weight the three fields differently (a cache write is
~1.25× an input token, a cache read ~0.1×).

### 2. Every billed call is recorded, including the ones whose output was thrown away

The reported usage numbers are correct only if this rule holds. `withStructuredRetry`,
`ChatTextLLM.structured` and `StructuredAgentBackend.next` all loop on a parse failure: the HTTP call
succeeded, the tokens were billed, and the text was discarded. Each of those loops must accumulate
`ModelUsage` across its attempts and return the sum rather than the usage of the last attempt.
`callWithRetry` (backends/transient.ts:64) retries 429s and 5xx, which are not billed, so it
contributes no usage, but it does bump `calls` on the attempt that eventually succeeds.

`RecordedChatBackend` (mock.ts:14) and `StubImageBackend` (mock.ts:34) return no usage, because
`--mock` must never manufacture spend. A `CachedImageBackend` cache hit (cache.ts:217-220) also
returns no usage, and only a `recorded` miss reports usage. `ServedRequest` (cache.ts:156) already
tracks `hit`/`recorded` and sets the precedent.

### 3. Pricing is authored data, keyed by vendor *and* model, and may be absent

Add a new `packages/types/src/pricing.ts` beside `textmodels.ts`. The file is node-free and
importable from the renderer:

```ts
export const PRICED_AT = '2026-06-24';
export interface ModelPrice { inPerM: number; outPerM: number; cacheWriteMult?: number; cacheReadMult?: number }
export const PRICES: Record<string, ModelPrice>;   // key: `${vendor}:${modelId}`
```

The key includes the vendor as well as the model because partner pricing differs. The same
`claude-opus-5` has one rate first-party and another on Vertex or Bedrock, so a model-only key would
bill a Vertex run at first-party rates.

An unpriced model records tokens and omits the dollar figure. The UI then says "unpriced" rather than
`$0.00`. `models.*` is `z.string()` with no validation against `TEXT_MODELS` (factory.ts:11 routes
anything not starting with `claude`/`anthropic` to Gemini), so unknown ids do occur.

Money is stored as an integer count of micro-dollars (millionths of a USD). Anthropic's own Managed
Agents API stores money as an integer string in minor units precisely so no float rounding is
applied, which is the right approach. Cents are too coarse here: a single Haiku call can cost
$0.0004, and rounding each one to a cent inflates a thousand-call run by two orders of magnitude.
Micro-dollars are exact for every published rate and fit an int well past any plausible project
total. One helper does the conversion for display; nothing else formats money.

### 4. The ledger

`vngen/state/usage.jsonl` is reached by `ProjectPaths.usageLog`, which sits beside `notificationsLog`
(packages/store/src/paths.ts:142).

```jsonc
{ "v": 1, "at": "2026-08-17T…", "vendor": "anthropic", "model": "claude-opus-4-8",
  "purpose": "review", "ref": "task:8f2c…", "in": 4210, "out": 380,
  "cacheWrite": 0, "cacheRead": 18400, "calls": 2, "usd": 41230, "priced": "2026-06-24" }
```

- **`v` per line**: each line carries its own `v`, because git union-merges the file and two
  branches will hold different versions. `migrateUsage` skips an unusable line rather than throwing,
  as `migrateNotification` (packages/types/src/notifications.ts:99) does.
- The existing `adoptGitAttributes` (workspace.ts:236) adds `vngen/state/usage.jsonl merge=union`
  to `.gitattributes`.
- **Outside undo**: `vngen/state` is already excluded from `UNDO_PATHS` (index.ts:339), so this
  costs no new work. Undoing the edit that caused a render must not delete the record of what the
  render cost.
- `purpose` is a small closed set — `image` | `review` | `text` | `agent` | `concept` — and `ref`
  is a task hash, a thread id, or absent. The file never contains prompt text, keys, or response
  text. `vngen/` is committed on purpose, so the ledger is committed too, and the ledger holds counts
  only for that reason.
- `logUsage(paths, record)` in `@vn/store` writes it (beside `logTask`) because two hosts append to
  it and one of them (the scheduler) cannot reach main. `readUsage(paths, opts)` reads it, and a
  `rollUp(records)` fold runs over the records. `truncateUsage` mirrors `truncateNotifications`
  (main/notifications.ts:211) for a project that has run for a year.

`TaskAttempt` (`packages/types/src/tasks.ts:51`) also gains `usage?`, so the attempt → asset → task
provenance chain carries what that attempt cost, and it inherits the existing crash-safe
`tasks.jsonl` append (`scheduler.ts:225`) without further work. The two fields are deliberately
redundant, and only the ledger is ever summed. The attempt field records provenance for display
beside the picture; the ledger records accounting, and it has to survive a task record being
orphaned.

`RunSummary` (scheduler.ts:36-62) gains an `actual` field beside its existing `preview`, so one
object holds both the estimate and the actual at session.ts:2958 and at the CLI
(apps/cli/src/commands.ts:330).

### 5. Reads are a channel, mutations are commands

This follows the notifications split exactly. `usage:list` is an `InvokeChannel`
(src/shared/ipc.ts:554-614), and `usage.list` and `usage.clear` live in
apps/desktop/src/main/commands/usage.ts. `usage.clear` sets `mutating: true` and `confirm: true` and
carries a `check`, modelled on `notify.deleteAll` (commands/notify.ts:97). No `usage` command is
undoable, for the same reason that no `notify.*` command is undoable.

Main pushes `usage:changed` on append; `installBridge` (bridge.ts:208-264) writes a `ShellState`
field and calls `touch()`. This repeats the `notify:changed` → `publishUnread` → bell path exactly.

### 6. The AI Usage editor — the thirteenth

Add an entry to `apps/desktop/src/shared/editors.ts` (`id: 'usage'`, `title: 'AI Usage'`) and a class
in `renderer/pathux/editors/usage.ts` registered with `registerEditor(UsageEditor,
'vn.UsageEditor')`. The string `'vn.UsageEditor'` is the hand-written struct name rather than
`cls.name`; passing `cls.name` makes every remembered pane rehydrate as the wrong editor
(renderer/pathux/editor.ts:132-141).

`claims` is absent, and the omission is deliberate, as with `tasklist` and `inspector`. No
document-tree node is a usage record, and a claim would show this pane to an author who clicked a
scene.

`TaskListEditor` (renderer/pathux/editors/tasks.ts) is the template. It uses a path.ux header row for
the controls and a raw DOM body via `appendSurface`, built from the shared helpers in
renderer/pathux/dom.ts. It follows the `drawn`/`stateKey()` redraw discipline (tasks.ts:85-96), so it
rebuilds only when something it draws changed. `load()` fetches the data over
`api.invoke('usage:list')`, and captures a failure and draws it as a note rather than throwing.

It shows totals by vendor, by model, and by purpose. A call count sits beside every token count, so
retry amplification is visible rather than inferred. It also shows the per-run estimate against the
actual, and an unpriced row where a model has no entry in `PRICES`. Every control carries a tooltip,
and a control disabled by a refusal shows that refusal's sentence verbatim.

### 7. The header, and the running total

The two numbers live in two places because they answer different questions.

**Project spend, in the menu bar.** `rebuild()` in `header.ts` (:184-220) draws a badge between the
model and live badges (:210) and the bell (:214). Everything in `this.bar` stays left of the note
frame, which is pinned hard right (header.ts:115-120). The wiring takes the established four steps:
add a field to `ShellState` (renderer/pathux/state.ts:44-60, already the "what the header shows"
block), list that field in `header.ts:stateKey()` (:132-144), add the `usage:changed` handler in
`bridge.ts`, and push from main. Clicking the badge opens the AI Usage editor.

**A running token total on the convo bar** — the todo asks for a total "similar to how claude code
sho[w]s total tokens". The total belongs beside the agent's mode and working indicator on the convo
pane's own bar rather than in the header, because the count is per-conversation. Threads already
persist to `vngen/state/threads/<id>.jsonl`, so a reopened thread can show what that thread cost. A
thread replayed read-only shows its historical total and marks that total as historical, just as the
replay already reports that the model was not shown it.

### Balance, honestly

No provider we can integrate exposes a balance over the API. The request was for remaining credits in
the header, so this plan ships spend-to-date instead, and the UI displays only numbers it computed
from calls it made.

There are two ways to do better. Both are deferred, and neither blocks:

- **Anthropic's Admin API** has organization usage and cost report endpoints, which require a
  separate admin key. Those endpoints report authoritative spend rather than balance, and would let
  the editor reconcile our ledger against Anthropic's own accounting. Check the exact endpoint shapes
  against live docs before writing anything — do not implement from memory.
- **A manually entered balance.** An author who tops up $50 could record it, and the ledger would
  count down from there. This is cheap and honest as long as the UI says the figure is an estimate
  the author typed in. It stays an open question rather than a settled design, because a stale manual
  number shown as authoritative is worse than no number.

### The one real OAuth: Vertex

The `vertex` vendor authenticates entirely out of band. `AnthropicVertex({projectId, region})` from
`@anthropic-ai/vertex-sdk` reads GCP Application Default Credentials, which the author establishes by
running `gcloud auth application-default login` themselves. Because we store no token, refresh
nothing, and keep no third credential file, this is the OAuth path worth having. `project.yaml` gains
`vertex: { projectId, region }`, and a missing ADC produces a precondition error naming the `gcloud`
command, in the same style as `resolveKeys`' "set $NAME or place file" sentence.

If the author is on Windows and the app must tell them to run something, the suggestion goes in the
error text. The app never shells out to `gcloud` on their behalf.

### An existing Anthropic login

If `ANTHROPIC_API_KEY` is unset and the author has previously run `ant auth login`, an SDK client
constructed with no arguments resolves that profile itself. The Anthropic backend should therefore
construct with `apiKey: key || undefined` and leave the resolution to the SDK, and a missing
Anthropic key should raise a precondition warning that names the profile rather than a hard throw.

Settle this caveat during implementation rather than now. The on-disk profile location
(`%APPDATA%\Anthropic` on Windows, `~/.config/anthropic` elsewhere) is known, this document does not
verify its file layout, and refresh tokens hard-expire rather than sliding with use. A stale profile
therefore fails at call time no matter what a pre-flight check reports. Treat a detected profile as a
hint that softens the error message, and do not treat it as a claim that authentication will succeed.

## Steps

Each step leaves `pnpm check` (both passes), `pnpm test` and `pnpm lint` green.

1. 1. **`ModelUsage` and the widened "seam" (the `backend.ts` interface).**
   `packages/types/src/providers.ts` gains `ModelUsage` and `ImageResult.usage?`;
   `packages/providers/src/backend.ts` gains `ChatReply` and widens `message`. Fix the five
   implementors and every call site. Capture `res.usage` (`backends/anthropic.ts`) and
   `res.usageMetadata` (`backends/gemini.ts`) in all five places that currently discard them. Mocks
   and cache hits return no usage.
2. 2. **Accumulate across the retry loops.** `withStructuredRetry`, `ChatTextLLM.structured`,
   `StructuredAgentBackend.next`, and the P7 refine loop sum usage rather than replacing it.
   `TaskAttempt` gains `usage?`, which runners.ts:132-140 fills. Tests in each package's `tests/`
   sibling check that a three-attempt parse loop reports three calls.
3. 3. **Pricing.** Covers `packages/types/src/pricing.ts`, micro-dollar arithmetic, one display
   formatter, and the unpriced-model rule under test.
4. 4. **The ledger.** This covers `ProjectPaths.usageLog`, the record schema with per-line `v` and
   `migrateUsage`, `logUsage`/`readUsage`/`rollUp`/`truncateUsage` in `@vn/store`, the `merge=union`
   attribute, and `RunSummary.actual`. Both hosts write to the ledger: the scheduler writes pipeline
   calls, and main writes agent turns.
5. 5. **The key surface.** Deduplicate `chatVendorFor` (four copies: `factory.ts:11`,
   `session.ts:242`, `session.ts:594`, `apps/authoring/src/agent.ts:46`); derive `require` from the
   models the project configures, fixing the `require: ['gemini']` asymmetry at all three call sites;
   add `keys: {vendor, source: 'env'|'file'|'none', shadowed}[]` to `projectView` — source only,
   never value — and draw it in the Project editor with a Set… button per row that opens the dialog
   prefilled; add `project.clearKey`; give `provider` a default; add a `secret` branch to
   `CommandForm.field` that masks; and omit `secret`-kind props from the `command:check` payload in
   `recheck()`. Omitting secrets from the `command:check` payload is a general rule worth writing
   into docs/command-system.md: `stack.check` never receives a secret.
6. 6. **The AI Usage editor.** Covers the `editors.ts` entry, `registerEditor`, the pane, the
   `usage:list` channel, the `usage.*` commands, and tooltips throughout. This surface was verified
   live over CDP because the jest desktop project is node-only and no unit test covers it.
7. 7. **The header badge and the convo running total.** Covers the `ShellState` field, `stateKey()`,
   `usage:changed` in `bridge.ts`, the badge, and the per-thread total on the convo bar. Ticks both
   `todos.md` entries.
8. 8. *(optional)* **Vertex.** This step covers `backends/vertex.ts`, the `vertex` vendor, the
   `project.yaml` block, and the ADC precondition error.
9. 9. *(optional)* **OpenAI.** Adds a third `KEY_VENDORS` entry, `backends/openai.ts`, and pricing
   rows. It also requires a real vendor-routing table, because `chatVendorFor` routes anything that
   is not `claude` to Gemini, and that rule breaks once a third vendor exists.
10. 10. *(optional)* **A spend cap.** `budget: { monthly_usd? }` in `project.yaml` caps monthly
    spend. A gate checks the cap before each request and pauses the run with a stated reason rather
    than terminating it mid-wave.
11. 11. **Finish.** Audit comments in everything touched and remove every `CLAUDENOTE:`; update
    docs/desktop-app.md (the thirteenth editor), docs/command-system.md (the secret rule),
    docs/cli.md if `vngen cost` grows an actual column, this plan's As-shipped section, the row in
    [`index.md`](index.md), and CLAUDE.md, which today says "the twelve editors".

## Decisions settled here

- **No OAuth client for Anthropic, OpenAI or Midjourney.** None exists to build against. Vertex is
  the one real OAuth path, and that path stores nothing.
- **Midjourney is out of scope.** It stays out until an official API exists.
- The header shows spend rather than balance, because no integrable provider exposes a balance.
- **Every billed call is recorded, including discarded calls.** A parse-retry loop that bills three
  calls reports three calls.
- **Money is stored as integer micro-dollars.** A float is never used, and cents are too coarse a
  unit.
- **An unpriced model shows tokens and no dollars.** An unpriced model never shows `$0.00`.
- **The ledger holds counts, never content.** It records no prompt, no response, and no key,
  because it is committed with `vngen/`.
- **Only the ledger is summed.** `TaskAttempt.usage` records provenance for display.
- **`--mock` records nothing**, and a cache hit records nothing.
- `stack.check` never receives a secret.

## Open questions

- Step 5 checks the widget code to settle whether path.ux's textbox can render masked, or whether
  the `secret` field needs a raw `<input type="password">` in an `appendSurface` root.
- Whether a manually entered credit balance is worth having at all, given that a stale balance
  displayed as authoritative is worse than showing no balance.
- Decide whether the Anthropic Admin API's cost report is worth wiring for reconciliation. Verify
  the endpoints against live documentation before deciding, rather than working from memory.
- Whether `vngen cost` should print actual-to-date beside its estimate, or whether actual-to-date
  belongs only in the editor.

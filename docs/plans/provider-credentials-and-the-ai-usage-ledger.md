# Provider Credentials and the AI Usage Ledger

Status: **planned**

## Context

> what are our options for full oauth support for google gemini, claude, chatgpt and midjourney
> (those sound like 4 good services to start with)? presumably we will need a "AI usage" editor
> showing tokens used and costs. service providers that use a credit system should have the
> remaining credits shown in the main header (and in the AI usage editor of course).

> it'd be nice if I could have users log into their preferred ai providers directly to avoid
> having to financially intermediate the token cost ourselves.

The second message is the requirement; the first is one guess at how to meet it. This plan keeps
the requirement — **every author's generation is billed to that author's own account, and the
project never sits in the middle of a payment** — and replaces the mechanism, because for three of
the four services the mechanism does not exist.

It also closes two entries already sitting in `todos.md`:

```
[ ]: the add model key dialog should have a dropdown to select anthropic vs google gemini
[ ]: the agent should show a running total of tokens used to the user similar
     to how claude code shorts total tokens.
```

## What is actually available, per provider

This is the finding that shapes everything below. "Log in with your provider account" is not a
thing a desktop app can do for programmatic model access, except in one case.

| Service | Third-party OAuth for API use? | What we can actually do |
| --- | --- | --- |
| **Anthropic / Claude** | **No.** The only OAuth is `ant auth login`, a *developer-machine CLI* flow that writes a profile under `%APPDATA%\Anthropic`. It is not a published third-party-app OAuth API — there is no client id to register and no consent screen we can drive. | Take an API key. Additionally *honour* a profile that is already there, since a zero-arg SDK client picks it up. |
| **Google Gemini** | **Yes, one path.** Vertex AI authenticates by GCP Application Default Credentials (`gcloud auth application-default login`) — real OAuth, and the tokens live in the user's gcloud config, never in ours. Usage bills to a GCP project with billing enabled, not to a personal Google account. The AI Studio / consumer Gemini API is API-key only. | Take an API key for AI Studio; offer a `vertex` vendor whose entire auth story is "run `gcloud auth application-default login`". |
| **OpenAI / ChatGPT** | **No.** API access is API key + org billing. There is no OAuth path that spends a ChatGPT Plus/Pro subscription — the subscription and the API are separate products with separate billing. | Take an API key, if and when an OpenAI backend is wanted at all. |
| **Midjourney** | **No API at all.** Access is the Discord bot; every "Midjourney API" is an unofficial wrapper that violates their terms. | **Out of scope.** Recorded here once so it is not re-proposed. |

Two consequences worth stating plainly, because they change the shape of the UI:

- **"Log in to your provider" collapses to "paste your key"** for Anthropic, OpenAI and Gemini/AI
  Studio. That still meets the requirement — the key belongs to the author, the bill goes to the
  author — but it means the work is in making key handling *good*, not in building an OAuth client.
- **No provider exposes a credit balance over the API.** Anthropic and OpenAI both retired or never
  shipped a balance endpoint for ordinary keys; Gemini has none. **So the header cannot show
  remaining credits, and this plan does not pretend to.** It shows *spend to date*, computed from
  what we actually sent — which is the number the author wanted the balance for. See
  [Balance, honestly](#balance-honestly).

## What exists today

### Keys

- `resolveKeys(config, {secretsDirs, require})` — `packages/config/src/keys.ts:84`. Returns a full
  `ResolvedKeys` (`keys.ts:6`) of exactly two fields, `gemini` and `anthropic`; unresolved vendors
  come back as `''`, never `undefined`. `KEY_VENDORS` (`keys.ts:12`) is exported precisely so a UI
  can enumerate vendors.
- Resolution order per vendor (`resolveOne`, `keys.ts:60`): `process.env[config.keys[vendor]]`
  first, then each dir in `secretsDirs` × each name in `SECRET_FILES[vendor]` (`keys.ts:15` —
  `gemini.txt`; `claude.txt` then `anthropic.txt`). `secretDirsFor` (`keys.ts:50`) is
  `[<project>/keys, <repoRoot>/keys]`.
- Errors name the **source** and never the value — `missing ${name} API key: set $${envName} or
  place ${file} in a keys/ dir` (`keys.ts:92`).
- `project.setKey` — `apps/desktop/src/main/commands/project.ts:62`. `mutating: true`,
  `undoable: false` (an undo point is a git snapshot, and snapshotting a credential is the one
  thing this command exists to avoid), props `provider: prop.oneOf(KEY_VENDORS)` and
  `key: prop.secret(...)`. `check` calls `session.previewKey` (`session.ts:1622`).
- `WorkspaceSession.setKey` (`session.ts:1636`) trims, calls `ensureIgnored(dir, ['keys'])`
  **before** writing, writes `keys/<secretFileFor(vendor)>` atomically, and deliberately reports
  `written: ['.gitignore']` or `[]` — never the key file.
- `prop.secret` (`packages/commands/src/props.ts:78,116`) is redacted to `<secret>` by
  `digestProps` (`packages/commands/src/digest.ts:38,51`), the one record-time projection, so the
  stored props, the formatted invocation and the commit trailer are all clean.

**The todo about a dropdown is subtler than it reads.** The dropdown already exists — `provider` is
a `prop.oneOf(KEY_VENDORS)`, so the form draws an enum menu. What is wrong is everything around it:

1. `provider` has **no default**, so the form opens with an empty menu label
   (`commandform.ts:132`, `String(value ?? '')`) and looks broken.
2. **`prop.secret` renders as a plain visible textbox.** `CommandForm.field`
   (`commandform.ts:106-161`) branches on `digest`, `boolean`, `enum`, then falls through to
   `row.textbox(...)` at `:147`. There is no `secret` branch — no masking, no clear-on-blur. The
   redaction story is complete on the persistence side and entirely absent on the presentation side.
3. **The plaintext key crosses IPC on every keystroke.** The textbox callback calls `recheck()`
   (`commandform.ts:80-86`), which invokes `command:check` with the whole `values` object —
   shipping a partial credential to main repeatedly, even though this command's `check` consumes
   only `provider` (`project.ts:78`).
4. **No read-back.** There is no `project.clearKey`, no "which keys are present" anywhere;
   `projectView` (`session.ts:1557`) reports models and image params and explicitly disclaims key
   state. The only place it surfaces is `runPreconditions.keyError` (`session.ts:2908`).
5. **A silent overwrite.** `had` is computed (`session.ts:1650`) but used only for past-tense
   wording; there is no `confirm`.
6. **A key written under a set env var is dead on arrival** — `keyFile` (`session.ts:1608`) appends
   an advisory sentence and the command still returns `ok: true`.
7. **The pipeline requires the wrong vendor.** `buildProviders` (`session.ts:492`),
   `runPreconditions` (`session.ts:2920`) and the CLI (`apps/cli/src/project.ts:67`) all pass
   `require: ['gemini']` — but `models.text` defaults to `claude-opus-4-8`
   (`packages/types/src/schemas.ts:286`). A project with a Gemini key and no Anthropic key passes
   preconditions and then fails mid-run at the first text or reviewer call.

### Usage and cost: none, anywhere

A repo-wide search for `usage|input_tokens|output_tokens|totalTokens|costUsd` finds **zero** hits in
first-party source. The data is present on every response object and is thrown away:

- `ChatBackend.message` returns `Promise<string>` (`packages/providers/src/backend.ts:48-52`).
  The Anthropic backend destructures text out of `res` and discards `res.usage`
  (`backends/anthropic.ts:64-74`, `:91-110`); the Gemini backend discards `res.usageMetadata`
  (`backends/gemini.ts:106-112`, `:118-143`, `:164-172`).
- `ImageResult` (`packages/types/src/providers.ts:9-16`) carries `bytes`/`ext`/`modelId`/`seed?`
  and nothing else. `ChatToolReply` (`backend.ts:33`) has no usage field. `TaskAttempt`
  (`packages/types/src/tasks.ts:51-62`) has no usage field.
- The only cost surface is `costPreview` (`packages/pipeline/src/pipeline.ts:48-74`) — a worst-case
  a-priori count of *planned calls*, with no tokens, no dollars, and no reconciliation against what
  happened. It reaches the UI at `session.ts:2962`.

**And the call count is invisible at every layer.** `callWithRetry` (3×,
`backends/transient.ts:64`) × `withStructuredRetry` (3×, `structured.ts:63`) ×
`ChatTextLLM.structured` (3×, `text.ts:18`) × `StructuredAgentBackend`'s parse loop (3×,
`packages/authoring/src/backend.ts:126-137`) × `max_refine_attempts` (4) × `max_task_attempts` (2).
None of these reports how many calls it actually made, and the ones that retry on a *parse* failure
are retrying calls that already succeeded and were already billed.

### The ledger pattern to copy

`vngen/state/notifications.jsonl` is the working model, and it is a good one:
`ProjectPaths.notificationsLog` (`packages/store/src/paths.ts:142`), per-line versioning
(`packages/types/src/notifications.ts:51`), `merge=union` via `adoptGitAttributes`
(`apps/desktop/src/main/workspace.ts:236`), appended with `appendJsonl`
(`packages/util/src/fs.ts:27-30`) rather than an atomic whole-file rewrite, filed from main's single
`onRecord` hook (`apps/desktop/src/main/index.ts:401-417`), **outside undo** because `vngen/state`
is excluded from `UNDO_PATHS` (`index.ts:339`), read over a plain IPC channel (`notify:list`) while
every mutation is a command (`main/commands/notify.ts`), and pushed to the renderer over
`notify:changed` → a `ShellState` field → `stateKey()` → the bell badge.

A usage ledger wants all of that except the byte-offset flag patching — nothing about a usage
record is ever edited in place, so it needs none of `setNotificationFlags`' `Buffer` arithmetic and
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
`ModelUsage` lives in `packages/types/src/providers.ts` — in `@vn/types` rather than `@vn/providers`
for the same reason `TEXT_MODELS` is (`packages/types/src/textmodels.ts:1-6`): the renderer must
name the shape without pulling a vendor SDK.

The alternative considered and rejected was an injected usage *sink* — smaller today, because
`message(): Promise<string>` has five implementors (`ChatTextLLM`, `ChatVisionReviewer`,
`StructuredAgentBackend`, `NativeAgentBackend`, `RecordedChatBackend`). It is wrong permanently:
usage is a fact about one response, and a sink turns it into an ambient event that some other layer
has to correlate back. Attribution — which task, which thread, which purpose — is added by the
*caller*, because the caller is the layer that knows.

**Prompt size is the sum of three fields.** On Anthropic, `input_tokens` is only the *uncached
remainder*; total prompt = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
A ledger that records `input_tokens` alone under-reports badly on any cached agent loop, and the
priced total must weight them differently (a cache write is ~1.25× an input token, a cache read
~0.1×).

### 2. Every billed call is recorded, including the ones whose output was thrown away

This is the rule that makes the numbers true. `withStructuredRetry`, `ChatTextLLM.structured` and
`StructuredAgentBackend.next` all loop on a *parse* failure — the HTTP call succeeded, the tokens
were billed, and the text was discarded. Each of those loops must **accumulate** `ModelUsage`
across its attempts and return the sum, not the last attempt's. `callWithRetry`
(`backends/transient.ts:64`) is the opposite case: it retries 429s and 5xx, which are not billed,
so it contributes nothing but does bump `calls` on the attempt that eventually succeeds.

`RecordedChatBackend` (`mock.ts:14`) and `StubImageBackend` (`mock.ts:34`) return **no usage** —
`--mock` must never manufacture spend. A `CachedImageBackend` cache hit (`cache.ts:217-220`)
likewise returns none; only a `recorded` miss does. `ServedRequest` (`cache.ts:156`) already tracks
`hit`/`recorded` and is the precedent.

### 3. Pricing is authored data, keyed by vendor *and* model, and may be absent

New `packages/types/src/pricing.ts` (node-free, renderer-importable, beside `textmodels.ts`):

```ts
export const PRICED_AT = '2026-06-24';
export interface ModelPrice { inPerM: number; outPerM: number; cacheWriteMult?: number; cacheReadMult?: number }
export const PRICES: Record<string, ModelPrice>;   // key: `${vendor}:${modelId}`
```

Keyed by vendor as well as model **because partner pricing differs** — the same `claude-opus-5` has
one rate first-party and another on Vertex or Bedrock, so a model-only key would quietly bill a
Vertex run at first-party rates.

**An unpriced model records tokens and omits the dollar figure.** The UI then says *unpriced*, not
`$0.00`. `models.*` is `z.string()` with no validation against `TEXT_MODELS`
(`factory.ts:11` routes anything not starting with `claude`/`anthropic` to Gemini), so unknown ids
are not a hypothetical.

**Money is stored as an integer count of micro-dollars** (millionths of a USD). Anthropic's own
Managed Agents API stores money as an integer string in minor units precisely so no float rounding
is applied, and that instinct is right — but cents are too coarse here, where a single Haiku call
can cost $0.0004 and rounding each one to a cent inflates a thousand-call run by two orders of
magnitude. Micro-dollars are exact for every published rate and fit an int well past any plausible
project total. One helper does the conversion for display; nothing else formats money.

### 4. The ledger

`vngen/state/usage.jsonl`, reached by `ProjectPaths.usageLog` beside `notificationsLog`
(`packages/store/src/paths.ts:142`).

```jsonc
{ "v": 1, "at": "2026-08-17T…", "vendor": "anthropic", "model": "claude-opus-4-8",
  "purpose": "review", "ref": "task:8f2c…", "in": 4210, "out": 380,
  "cacheWrite": 0, "cacheRead": 18400, "calls": 2, "usd": 41230, "priced": "2026-06-24" }
```

- **`v` per line**, because git union-merges the file and two branches will hold different versions.
  `migrateUsage` skips an unusable line rather than throwing, as `migrateNotification`
  (`packages/types/src/notifications.ts:99`) does.
- `.gitattributes` gets `vngen/state/usage.jsonl merge=union` through the existing
  `adoptGitAttributes` (`workspace.ts:236`).
- **Outside undo**, free of charge: `vngen/state` is already excluded from `UNDO_PATHS`
  (`index.ts:339`). Undoing the edit that caused a render must not delete the record of what the
  render cost.
- `purpose` is a small closed set — `image` | `review` | `text` | `agent` | `concept` — and `ref`
  is a task hash, a thread id, or absent. **No prompt text, no key, no response text ever enters
  this file.** `vngen/` is committed on purpose, so the ledger is committed too, and it is counts
  only for exactly that reason.
- Written by `logUsage(paths, record)` in `@vn/store`, beside `logTask` — because two hosts append
  to it and one of them (the scheduler) cannot reach main. Read by `readUsage(paths, opts)` plus a
  `rollUp(records)` fold; `truncateUsage` mirrors `truncateNotifications`
  (`main/notifications.ts:211`) for a project that has run for a year.

`TaskAttempt` (`packages/types/src/tasks.ts:51`) also gains `usage?`, so the attempt → asset →
task provenance chain carries what that attempt cost, and it inherits the existing crash-safe
`tasks.jsonl` append (`scheduler.ts:225`) for free. **The two are deliberately redundant and only
one of them is ever summed: the ledger.** The attempt field is provenance for display beside the
picture; the ledger is accounting, and it has to survive a task record being orphaned.

`RunSummary` (`scheduler.ts:36-62`) gains an `actual` beside its existing `preview`, so
estimate-versus-actual arrives in one object at `session.ts:2958` and at the CLI
(`apps/cli/src/commands.ts:330`).

### 5. Reads are a channel, mutations are commands

Following the notifications split exactly: `usage:list` as an `InvokeChannel`
(`src/shared/ipc.ts:554-614`), and `usage.list` / `usage.clear` in
`apps/desktop/src/main/commands/usage.ts`. `usage.clear` is `mutating: true`, `confirm: true`, with
a `check` — modelled on `notify.deleteAll` (`commands/notify.ts:97`). Nothing here is undoable, for
the same reason nothing in `notify.*` is.

Main pushes `usage:changed` on append; `installBridge` (`bridge.ts:208-264`) writes a `ShellState`
field and calls `touch()`. That is the `notify:changed` → `publishUnread` → bell path verbatim.

### 6. The AI Usage editor — the thirteenth

A new entry in `apps/desktop/src/shared/editors.ts` (`id: 'usage'`, `title: 'AI Usage'`), a class
in `renderer/pathux/editors/usage.ts` registered with `registerEditor(UsageEditor, 'vn.UsageEditor')`
— the hand-written struct name, never `cls.name`, or every remembered pane rehydrates as the wrong
editor (`renderer/pathux/editor.ts:132-141`).

`claims` is **absent**, deliberately, like `tasklist` and `inspector`: no document-tree node is a
usage record, and a claim would put this pane in front of an author who clicked a scene.

`TaskListEditor` (`renderer/pathux/editors/tasks.ts`) is the template — a path.ux header row for
the controls, a raw DOM body via `appendSurface` built from the shared helpers in
`renderer/pathux/dom.ts`, and the `drawn`/`stateKey()` redraw discipline (`tasks.ts:85-96`) so it
rebuilds only when something it draws changed. Data over `api.invoke('usage:list')` in `load()`,
failure captured and drawn as a note rather than thrown.

What it shows: totals by vendor, by model, and by purpose; a call count beside every token count so
retry amplification is visible rather than inferred; the per-run estimate-versus-actual; and an
unpriced row where a model has no entry in `PRICES`. Every control carries a tooltip, and a control
disabled by a refusal shows that refusal's sentence verbatim.

### 7. The header, and the running total

Two numbers, two places, because they answer different questions.

**Project spend, in the menu bar.** A badge in `header.ts`'s `rebuild()` (`:184-220`), between the
model/live badges (`:210`) and the bell (`:214`) — everything in `this.bar` stays left of the note
frame, which is pinned hard right (`header.ts:115-120`). Wiring is the established four steps: a
field on `ShellState` (`renderer/pathux/state.ts:44-60`, already the "what the header shows"
block), that field in `header.ts:stateKey()` (`:132-144`), the `usage:changed` handler in
`bridge.ts`, the push from main. Clicking it opens the AI Usage editor.

**A running token total on the convo bar** — this is the todo asking for "similar to how claude code
sho[w]s total tokens", and it belongs beside the agent's mode and working indicator on the convo
pane's own bar, not in the header, because it is per-conversation. Threads already persist to
`vngen/state/threads/<id>.jsonl`, so a reopened thread can show what it cost; a thread replayed
read-only shows its historical total and says so, exactly as it already says the model was not
shown it.

### Balance, honestly

The request was for remaining credits in the header. **No provider we can integrate exposes a
balance over the API**, so this plan ships spend-to-date instead and the UI never displays a number
it did not compute from a call it made.

Two ways to do better, both deferred and neither blocking:

- **Anthropic's Admin API** has organization usage and cost report endpoints, requiring a separate
  admin key. That gives authoritative *spend*, not balance, and would let the editor reconcile our
  ledger against Anthropic's own accounting. The exact endpoint shapes must be checked against live
  docs before anything is written — do not implement from memory.
- **A manually entered balance.** An author who tops up $50 could record it, and the ledger would
  count down from there. Cheap, and honest as long as the UI says it is an estimate from a figure
  the author typed. Left as an open question rather than designed, because a stale manual number
  shown as authoritative is worse than no number.

### The one real OAuth: Vertex

A `vertex` vendor whose entire auth story is out-of-band. `AnthropicVertex({projectId, region})`
from `@anthropic-ai/vertex-sdk` reads GCP Application Default Credentials, which the author
establishes by running `gcloud auth application-default login` themselves. **We store no token, we
refresh nothing, and there is no third credential file** — which is precisely why it is the OAuth
path worth having. `project.yaml` gains `vertex: { projectId, region }`; a missing ADC produces a
precondition error naming the `gcloud` command, in the same style as `resolveKeys`' "set $NAME or
place file" sentence.

If the author is on Windows and the app must tell them to run something, the suggestion goes in the
error text — the app never shells out to `gcloud` on their behalf.

### An existing Anthropic login

If `ANTHROPIC_API_KEY` is unset and the author has previously run `ant auth login`, a zero-arg SDK
client picks the profile up on its own. So the Anthropic backend should construct with
`apiKey: key || undefined` and let the SDK resolve, and a missing Anthropic key becomes a
*precondition warning that names the profile* rather than a hard throw.

Caveat to settle during implementation, not now: the on-disk profile location
(`%APPDATA%\Anthropic` on Windows, `~/.config/anthropic` elsewhere) is known, its file layout is
not verified here, and **refresh tokens hard-expire rather than sliding with use** — so a stale
profile fails at call time no matter what a pre-flight check says. Detect it as a *hint* that
softens the error message; never as a claim that authentication will succeed.

## Steps

Each step leaves `pnpm check` (both passes), `pnpm test` and `pnpm lint` green.

1. **`ModelUsage` and the widened seam.** `packages/types/src/providers.ts` gains `ModelUsage` and
   `ImageResult.usage?`; `packages/providers/src/backend.ts` gains `ChatReply` and widens
   `message`. Fix the five implementors and every call site. Capture `res.usage`
   (`backends/anthropic.ts`) and `res.usageMetadata` (`backends/gemini.ts`) in all five places that
   currently discard them. Mocks and cache hits return no usage.
2. **Accumulate across the retry loops.** `withStructuredRetry`, `ChatTextLLM.structured`,
   `StructuredAgentBackend.next`, and the P7 refine loop sum rather than replace. `TaskAttempt`
   gains `usage?`; `runners.ts:132-140` fills it. Tests in each package's `tests/` sibling pin that
   a three-attempt parse loop reports three calls.
3. **Pricing.** `packages/types/src/pricing.ts`, micro-dollar arithmetic, one display formatter,
   and the unpriced-model rule under test.
4. **The ledger.** `ProjectPaths.usageLog`, the record schema with per-line `v` and `migrateUsage`,
   `logUsage`/`readUsage`/`rollUp`/`truncateUsage` in `@vn/store`, the `merge=union` attribute,
   `RunSummary.actual`. Both hosts write: the scheduler for pipeline calls, main for agent turns.
5. **The key surface.** Deduplicate `chatVendorFor` (four copies: `factory.ts:11`,
   `session.ts:242`, `session.ts:594`, `apps/authoring/src/agent.ts:46`); derive `require` from the
   models the project actually configures, fixing the `require: ['gemini']` asymmetry at all three
   call sites; add `keys: {vendor, source: 'env'|'file'|'none', shadowed}[]` to `projectView` —
   source only, never value — and draw it in the Project editor with a Set… button per row that
   opens the dialog prefilled; add `project.clearKey`; give `provider` a default; add a `secret`
   branch to `CommandForm.field` that masks; and **omit `secret`-kind props from the `command:check`
   payload** in `recheck()`. That last one is a general rule worth writing into
   `docs/command-system.md`: **`stack.check` never receives a secret.**
6. **The AI Usage editor.** `editors.ts` entry, `registerEditor`, the pane, `usage:list` channel and
   `usage.*` commands, tooltips throughout. Verified live over CDP — the jest desktop project is
   node-only, so a surface is not covered by a unit test.
7. **The header badge and the convo running total.** `ShellState` field, `stateKey()`,
   `usage:changed` in `bridge.ts`, the badge, the per-thread total on the convo bar. Ticks both
   `todos.md` entries.
8. *(optional)* **Vertex.** `backends/vertex.ts`, the `vertex` vendor, `project.yaml` block, the
   ADC precondition error.
9. *(optional)* **OpenAI.** A third `KEY_VENDORS` entry, `backends/openai.ts`, pricing rows — and
   necessarily a real vendor-routing table, because `chatVendorFor`'s "anything not `claude` is
   Gemini" rule cannot survive a third vendor.
10. *(optional)* **A spend cap.** `budget: { monthly_usd? }` in `project.yaml`, enforced as a
    **pre-request gate** that pauses a run with a stated reason rather than terminating it
    mid-wave.
11. **Finish.** Audit comments in everything touched and remove every `CLAUDENOTE:`; update
    `docs/desktop-app.md` (the thirteenth editor), `docs/command-system.md` (the secret rule),
    `docs/cli.md` if `vngen cost` grows an actual column, this plan's As-shipped section, the row in
    [`index.md`](index.md), and `CLAUDE.md` — which today says *the twelve editors*.

## Decisions settled here

- **We do not build an OAuth client for Anthropic, OpenAI or Midjourney**, because none exists to
  build against. Vertex is the one real OAuth path and it works by storing nothing.
- **Midjourney is out of scope** and stays out until an official API exists.
- **The header shows spend, not balance**, because no integrable provider exposes a balance.
- **Every billed call is recorded, including discarded ones.** A parse-retry loop that bills three
  calls reports three.
- **Money is integer micro-dollars.** Never a float, and cents are too coarse.
- **An unpriced model shows tokens and no dollars.** Never `$0.00`.
- **The ledger holds counts, never content.** No prompt, no response, no key — it is committed with
  `vngen/`, and that is why.
- **The ledger is the only thing summed.** `TaskAttempt.usage` is provenance for display.
- **`--mock` records nothing**, and a cache hit records nothing.
- **`stack.check` never receives a secret.**

## Open questions

- Whether path.ux's textbox can render masked, or whether the `secret` field needs a raw
  `<input type="password">` in an `appendSurface` root. Settle in step 5 against the widget code.
- Whether a manually entered credit balance is worth having at all, given that a stale one shown as
  authoritative is worse than nothing.
- Whether the Anthropic Admin API's cost report is worth wiring for reconciliation. Verify the
  endpoints against live documentation before deciding — not from memory.
- Whether `vngen cost` should print actual-to-date beside its estimate, or whether that belongs
  only in the editor.

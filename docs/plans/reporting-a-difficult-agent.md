# Reporting a difficult agent

Status: **shipped**

<!-- toc -->

<!-- tocstop -->

## What this is

An author who has just had a bad conversation with the authoring agent picks
**Help ▸ Report a Difficult Agent…**, chooses the conversation, optionally says what they had
actually wanted, and submits. A dedicated **debug agent** — running on the author's own model key,
on the author's own machine — reads the thread, works out what went wrong, and writes a report
with recommendations for new agent behaviour. The author reviews the report, and one click opens
a pre-filled GitHub issue titled `AGENTREPORT: …`.

Three things make it more than a form:

- **It runs on the author's key, so the conversation never leaves their machine except as a report
  they read first.** That is the privacy pitch, and it is the reason the analysis is not a service.
- **Names from the fiction are replaced before the model sees them**, deterministically, by a
  redactor that sits on the boundary rather than in a prompt.
- **Optionally the debug agent may read the app's own source**, which ships with the install. That
  turns "the agent did something odd" into "the agent did something odd and here is the contract in
  `docs/` it violated".

## Why the transcript has to change first

A thread today is a *display* log, not an execution log, and an analyst fed one sees very little:

- `received()` (`apps/desktop/src/shared/convo.ts:111-123`) reduces a `tool` event to
  `push(convo, 'tool', event.tool)` — **the tool name and nothing else** — even though the loop
  emits `{ type: 'tool', tool, args, result }` (`packages/authoring/src/loop.ts:57-63`, emitted at
  `:282`). Args and `ToolResult` are dropped on the floor.
- `appendItem` clamps every text to 400 chars (`TEXT_MAX`, `apps/desktop/src/main/threads.ts:33`).
  The agent's own reasoning prose is where a failure is legible, and it is what gets cut.
- Reopening a thread never restores `Agent.messages` — deliberately deferred as Stage 5 of
  [`conversation-threads.md`](conversation-threads.md), and still out of scope here.

So a report built on today's format could say "it misread the request" or "it thrashed", and could
not say *which* file, whether a call succeeded, or what came back. Stage 1 fixes that going
forward; Stage 2 recovers what it can for threads already on disk.

The consequence is stated rather than hidden: **a report on a thread recorded before this ships
carries a line saying the transcript predates the detailed format**, so a maintainer reading the
issue knows why the evidence is thin.

## Layering

A new leaf package, **`@vn/agentreport`**, holding the pure logic that wants tests:

```
providers  authoring  model  config  store
     └──────┴────┬─────┴───────┴───────┘
              agentreport
                  │
            apps/desktop (main)
```

- It may import `@vn/types`, `@vn/util`, `@vn/store`, `@vn/model`, `@vn/config`, `@vn/parse`,
  `@vn/commands`, `@vn/providers` and `@vn/authoring`. It **must not** import `@vn/pipeline` or
  `@vn/scheduler` — analysing an agent is an input-side concern, and the boundaries rule says so.
  `@vn/commands` is on the list because the acting record a transcript lacks is `commands.jsonl`.
- Its only consumer is `apps/desktop/src/main/`. It is deliberately not one of the four shared
  leaves (`export`, `scriptedit`, `bible`, `artgen`): those exist because *two* hosts need them,
  and this has one. If `vnauthor` ever grows the same command, that is when it moves.
- Four of its five modules are pure and node-testable: `redact.ts`, `transcript.ts`, `issue.ts`,
  `render.ts`. Only `analyze.ts` talks to a model.
- One piece deliberately does **not** live here: the model/effort advisory (Stage 6) goes in
  `apps/desktop/src/shared/advice.ts`, because the renderer draws it and this package imports
  `@vn/store` and `@vn/authoring` — node all the way down. `src/shared/` is the browser bundle, and
  only `vite build` catches a violation of that.

## Stage 1 — the thread format carries what the agent did

**`FeedItem` gains two optional fields** (`apps/desktop/src/shared/convo.ts:20`):

```ts
export interface FeedItem {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'blocked';
  /** What the transcript shows. Clamped on the way to disk. */
  text: string;
  /** The untruncated text, present only when `text` was clamped. Nothing on screen reads it. */
  full?: string;
  /** For a `tool` item: what it was called with and whether it worked. */
  detail?: { args?: string; ok?: boolean; output?: string };
}
```

**`received()` fills `detail` from the event it already has.** The reducer stays pure and stays
the single one — the invariant `conversation-threads.md` rests on — and the renderer is untouched
because it renders `text`. `args` is JSON-stringified there, in a `try`, because a throw on that
path would lose the whole turn rather than one field of it.

**Sizing is not the reducer's job.** `received()` holds args and output in full, exactly as it
already holds `text` in full, and every cap is applied by `appendItem` on the way to disk — one
place that decides how big a log line may be, which is where `clamp` already lives.

**`appendItem` writes `detail` through and computes `full`** (`threads.ts:175`): `text` stays
clamped for display, `full` is written only when `clamp()` actually cut something. `readThread`
(`:136`) carries both back; the display path keeps mapping `{ id, role, text }`.

**No version bump.** Line 0 is `{ v: 1, … }` and the reader is field-tolerant: an old reader
ignores unknown keys, a new reader sees `undefined` on an old file. Both directions already work,
which is the point of having written the format this way.

One subtlety to leave alone rather than "fix": `listThreads`' cheap line filter is
`raw.includes('"thread"') || raw.includes('"title"')` (`threads.ts:128`). Tool args are now in the
file, so a line whose args happen to contain those substrings will be parsed needlessly — and then
discarded by `headerOf`, which filters on `line.type`. It is a wasted `JSON.parse`, not a bug.

Caps to add beside `TEXT_MAX`: `ARGS_MAX` (600), `OUTPUT_MAX` (2000), `FULL_MAX` (8000). A thread
is still a log, not an archive.

- [x] 1.1 — `FeedItem.full` / `FeedItem.detail`, and `received()` filling them
- [x] 1.2 — `appendItem` / `readThread` round-tripping both, with the new caps
- [x] 1.3 — tests in `apps/desktop/src/shared/tests/` and `apps/desktop/src/main/tests/`:
      a clamped item round-trips with `full`, a tool item carries args and `ok`, an old file with
      neither still reads

## Stage 2 — assembling the evidence

`packages/agentreport/src/transcript.ts`, pure, given already-read data:

```ts
export interface ReportContext {
  /** The app build the report is written from, so a maintainer knows which code to read. */
  appVersion?: string;
  /** The reasoning effort the conversation ran at. */
  effort?: string;
}
export interface Evidence {
  thread: ThreadRecord;
  /** Command records whose window overlaps the thread — what the agent actually did. */
  acts: CommandRecord[];
  /** True when the thread predates the detailed format, so the report can say so. */
  thin: boolean;
  context: ReportContext;
}
export function assemble(
  thread: ThreadRecord,
  records: CommandRecord[],
  context?: ReportContext,
): Evidence;
export function toMarkdown(evidence: Evidence): string;
```

`ReportContext` exists because the header wants two facts a thread file has never held — the app
build and the effort — and inventing them inside a pure function is not on.

**`ThreadRecord` and `FeedItem` are re-declared in the package, not imported.** Thread storage is
the desktop app's (`apps/desktop/src/main/threads.ts`) and a package may not import an app. The
shapes are structurally identical, so main passes its record straight in; if the app ever adds a
role this package does not know, the call site is where that should fail.

**`FeedItem` gains `at`, and `readThread` carries it back.** `appendItem` has always stamped every
line — `readThread` simply dropped it on the way out, so recovering it costs one destructured
field and works on threads already on disk. Without it there is no window to join against.

The join is by time. `ThreadHeader.startedAt` and every item's `at` are ISO stamps, and
`CommandRecord` (`packages/commands/src/command.ts:117`) carries `startedAt`, `finishedAt`, `id`,
`invocation`, `status`, `message`, `error` and `written`. The window runs from the thread's start
to its **last stamped line** — not to now: a thread stays open while the author keeps working, and
those later acts are not the agent's. A record overlapping that window is in, ordered by `seq`.
That deliberately includes acts the author performed by hand, because for reading a bad
conversation back, what happened in the project while it was open *is* the evidence.

`thin` is decided by the tool lines when there are any — the old format recorded a name alone, so
a tool line without `detail` dates the thread. With no tool lines at all nothing is decisive, and
it falls back to "no item carries `full` or `detail`", which flags a short new thread along with a
genuinely old one. That false positive costs one caveat sentence, which is the right way round.

`toMarkdown` renders one document: header (model, effort, commit, app version), the turns in
order, then the act log. Tool args and output are fenced with a run of backticks longer than any
in the text, because a report about an agent that mangled a markdown file must not end its own
code block mid-way. This is the *only* thing handed to the analyst, and it goes through the
redactor first.

Reading the log back is `apps/desktop/src/main/commandlog.ts` — `readCommandLog` beside the
`onRecord` that writes it, and `evidenceFor(paths, threadId, context)` as the one seam that
touches disk. Nothing in the app had read `commands.jsonl` in code before; provenance was written
to be read by a person with a text editor.

- [x] 2.1 — `assemble` + `toMarkdown` with tests over a fixture thread and a fixture
      `commands.jsonl`
- [x] 2.2 — reading `commands.jsonl` in main and passing it in (the package stays pure)

## Stage 3 — redaction is a boundary, not an instruction

`packages/agentreport/src/redact.ts`. **Nothing reaches the model unredacted** — not the
transcript, not the author's note, not a tool result. Asking a model to anonymise usually works
and occasionally does not, and "occasionally" here means a character name in a public issue.

```ts
export interface Redactor {
  /** Replace every known name. Stable across calls within one report. */
  apply(text: string): string;
  /** Names still present — the leak scan, run over the finished report. */
  leaks(text: string): string[];
}
export function buildRedactor(sources: RedactionSources): Redactor;
export function sourcesFrom(model: ProjectModel, machine?: MachineFacts): RedactionSources;
```

What it knows, all of it already derivable:

| Source | Replaced with |
| --- | --- |
| Every character and location the loaded model holds | `Character A`, `Location B`, … assigned in first-appearance order |
| Entity **ids** as well as display names (`titus` and `Titus Vale` both) | the same pseudonym |
| Scene ids | `Scene 3` |
| The project title from `project.yaml` | `<project>` |
| The absolute project root, and every path under it | `<project>/…` |
| `os.userInfo().username`, and the home directory prefix | `<author>` |

Rules that matter: longest match first (so `Titus Vale` is not half-replaced by `Titus`), word
boundaries with possessives (`Titus's` → `Character A's`), case-insensitive matching with the
pseudonym cased consistently, and **the map is held in memory only** — it is never written to
disk, never sent to the model, and never appears in the report. A report is not de-anonymisable by
whoever reads the issue.

Three details the implementation settled:

- **The sources come from `ProjectModel`, not from `EntityDoc`s.** The model already has every
  character, location and scene, keyed by id and carrying its display name, and the app has one
  loaded — re-running entity discovery to learn the same names would be work for nothing. Items
  stay in the `NamedEntity` vocabulary because the redactor costs nothing to widen; nothing
  supplies them yet. A scene contributes its id alone: it has no title, and its synopsis is prose
  whose names the entity pass replaces anyway.
- **A boundary guard is per name, not global.** `\b` is ASCII, so `\bCafé\b` never matches — and a
  script written without spaces has no boundary to require, so demanding one would silently refuse
  to redact every name in a Japanese project. Each alias is guarded with `(?<![\p{L}\p{N}_])` only
  on an edge whose own character is a letter in a spaced script. The same reasoning exempts a
  single ideograph from the two-character minimum: 蓮 is a whole name, not a letter.
- **A path is matched through either separator and through JSON escaping.** Tool args reach the
  report having been through `JSON.stringify`, so `C:\dev\x` arrives as `C:\\dev\\x`; one pattern
  sees both. The project root is replaced **before** the home directory, or a project inside the
  author's home comes out as `<author>/dev/proj` — naming the layout instead of hiding it.

`leaks()` is the same matcher used as a detector, and Stage 7 makes it a refusal.

The prompt instruction to write in general terms stays, as a second layer. It is not the
mechanism.

- [x] 3.1 — `buildRedactor` + tests: substring safety, possessives, case, path prefixes,
      idempotence (`apply(apply(x)) === apply(x)`), and `leaks` finding what `apply` would replace
- [x] 3.2 — `sourcesFrom(model, machine)`: every name the loaded project holds, with the `os`
      calls left to the caller so the derivation stays pure

## Stage 4 — the analyst

`packages/agentreport/src/analyze.ts`. Two paths, deliberately different in kind.

### Without source — one structured call, no loop

The cheap path does not spin up an agent at all. `chatBackendFor(modelId, keys)`
(`packages/providers/src/factory.ts:21`) plus `withStructuredRetry(schema, …)`
(`packages/providers/src/structured.ts:95`) — roughly ten lines, no new dependency, no `Providers`
bundle, the same shape `packages/providers/src/review.ts:46` already uses.

### With source — the restricted agent

The loop is already re-pointable: `AgentOptions.registry` is an injectable `Map<string, Tool>`
defaulting to `createRegistry()` (`packages/authoring/src/loop.ts:79`, `:142`). The debug agent is
that map with **four** tools and nothing else.

Two loop facts to handle rather than fight:

- `propose_plan` and `ask_user` are always advertised and always dispatched
  (`loop.ts:88`, `:234`). A one-shot analyst with no human present must supply a `Permission` that
  auto-approves plans and answers `ask_user` with a fixed "nobody is here; conclude from the
  evidence you have", or the run parks forever.
- `ToolContext` requires `workspace: Workspace` and `git: Git` even for tools that ignore them
  (`packages/authoring/src/tools.ts:93`). Both are lazy — `Workspace`'s constructor only builds
  `ProjectPaths` (`workspace.ts:128`) — so binding them to the source root costs nothing.

### The report schema

A zod schema in `@vn/types`-style, and the loop's exit condition:

```ts
{
  summary: string;              // one line; becomes the issue title after AGENTREPORT:
  whatHappened: string;         // the sequence, in general terms
  whatWentWrong: string[];
  rootCause: string;
  recommendations: { behaviour: string; where?: string; rationale: string }[];
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];           // quoted lines from the redacted transcript
}
```

With source, this arrives as the args of a **`submit_report` tool** — the fourth tool, and the one
that ends the run. Structure is forced by the same zod validation every other tool gets
(`loop.ts:229`), and there is no second round-trip to re-ask for JSON.

`render.ts` turns it into markdown. Pure, tested, and the same renderer for both paths.

Four things the implementation settled:

- **The source path falls back to the cheap one rather than failing.** An author who has just
  described a bad experience should not be told that the thing meant to report it also misbehaved.
  The fallback is recorded on the report (`Report.fellBack`) and rendered, because a recommendation
  naming a specific file is worth less from an analyst that never opened it — so `readSource` on
  the finished report means *it actually read it*, not *it was allowed to*.
- **Redaction is applied on both sides of the model, in `analyze`.** The transcript and the
  author's note go through the redactor before the prompt is built, and every prose field of the
  reply goes through it again on the way out — the analyst quotes the transcript back, and a
  quotation of a redacted line is redacted, but a name it recalled from source it read is not.
- **A confirmation is refused, not auto-approved.** A plan is approved because the loop parks
  forever otherwise and the registry holds nothing that could act on one; a tool that asks for
  confirmation is asking a person, and there is not one. `ask_user` is answered with a fixed
  sentence saying so.
- **The key check is at the point of use** (`analystBackend`). `resolveKeys` only throws for a
  vendor the caller declared required, and the caller cannot know which vendor until the author
  has picked a model in the dialog. It names the env var and the file, never the value.

- [x] 4.1 — the schema, `render.ts`, and tests
- [x] 4.2 — the no-source path
- [x] 4.3 — the with-source path: registry, `Permission`, `submit_report`
- [x] 4.4 — refusal when no key resolves for the analysis model, naming the source not the value

## Stage 5 — the source the debug agent may read

The install ships full source, so this is not a dev-only affordance. Three decisions follow.

**Ship it unpacked, as an `extraResource`, not inside `app.asar`.** Grep stays ordinary
`fs.readdir`, with no asar path edge cases, and for an open-source app there is nothing to hide.
Whatever packaging is eventually designed inherits this as a constraint.

**The readable set is a declared manifest, not "whatever is on disk"** —
`packages/agentreport/src/sourcemap.ts`:

```ts
export const READABLE = ['packages', 'apps', 'docs', 'scripts', 'CLAUDE.md', 'package.json'];
export const DENY = ['node_modules', 'dist', '.git', 'keys', 'vendor/path.ux/scripts/lib'];
```

Two payoffs. It keeps `node_modules`, build output and several megabytes of minified vendor blobs
out of grep's walk, which is most of the token saving. And should the app ever go closed-source
and ship only the core agent code, narrowing is an edit to one list: the tools keep working and
the agent's refusals stay honest — "the UI layer is not included in this build" rather than a
confusing "no such file".

**`docs/` and `CLAUDE.md` are the highest-value entries**, arguably above the TypeScript. They
state the invariants in prose, so a report can say "this violates the gate-as-barrier contract"
instead of paraphrasing code it half-read.

`sourceRoot()` resolves in order: `$VN_SOURCE_ROOT`, then `process.resourcesPath/source`, then
walking up from the module for a directory holding both `CLAUDE.md` and `packages/`. Returning
`undefined` means a broken install, and the checkbox says so rather than silently doing less.

### The three read tools

**`grep(pattern, glob?)`** — new. Today's `search` tool hardcodes `INPUT_GLOBS` to the authored
directories (`tools.ts:208`), so this is that shape with a different walker. Caps: 4000 files
scanned, 100 matches returned, 300 chars per match line — and **truncation is reported to the
model**, because a cap silently read as "no matches" produces a confidently wrong report.

**`read_file(path)`** — `resolveInWorkspace` + `readDocFile` (`packages/store/src/docfile.ts:25`,
`:79`) already refuse escapes, directories, non-UTF-8 and files over 1 MB. Two roots (source and
project) means two `Workspace` instances. Two additions:

- **`keys/**` is refused by name.** An agent that has just read a private manuscript must never be
  able to read a credential.
- **Symlinks are refused,** by `lstat` in both the walk and the read. `resolveInWorkspace` is pure
  path arithmetic with no `realpath`, so a symlink inside a readable root escapes it — and with
  pnpm, `node_modules` is a forest of exactly that. It is on `DENY` already; the `lstat` is the
  belt to that braces.

**`fetch_api_docs(provider, topic)`** — takes a provider and a topic, **never a URL**, resolved
against a fixed allow-list of documentation pages for the supported model providers. GET only, no
agent-supplied query string, 10s timeout, cached on disk by URL and day. This is not fussiness: an
agent that has just read someone's private conversation, given an arbitrary-URL fetch tool, is an
exfiltration channel. The allow-list is what closes it.

### Budget

`maxSteps: 24`, a total input-token ceiling, and a per-run byte budget across all reads
(`DEFAULT_READ_BUDGET`, 250 kB of text handed back). One `Budget` is built in
`createSourceTools` and shared by all three tools, so an analysis cannot spend its cap three
times. The checkbox tooltip states a rough cost so "uses more tokens" is a number rather than a
vibe.

Four things the implementation settled:

- **`DENY` is matched two ways, because one way is wrong.** A one-segment entry is denied wherever
  it appears, since `node_modules` nests; a multi-segment entry names one place and is matched as
  a prefix — matched segment-wise, `vendor/path.ux/scripts/lib` would deny every `scripts/` and
  every `src/lib/` in the repo.
- **A readable root may be a file, and the first walker lost them silently.** `CLAUDE.md` and
  `package.json` are files, and a walk that opens each root with `readdir` skips them without
  saying so — meaning grep could never find the one document most worth quoting, while `read_file`
  could read it. `collect` now `lstat`s each root entry and takes either kind.
- **The credential refusal answers before the general one.** `keys` is on `DENY` as well, so the
  generic sentence won the race and said "build output, dependencies, or credentials" about a
  secret. The project-side `keys/` check runs first, so the refusal a maintainer reads in a log is
  the specific one.
- **`where` is optional-with-a-fallback, not `.default('source')`.** zod 3's `.default()` splits a
  schema's input type from its output type, and `Tool<A>` is a single parameter — so the tools take
  `where?: Where` and fall back inside `run`. The same shape as `analysisArgs` in Stage 4, for the
  same reason.

- [x] 5.1 — `sourcemap.ts` + `sourceRoot()` with tests for the refusals
- [x] 5.2 — `grep` with caps and reported truncation
- [x] 5.3 — the two-root `read_file` with the `keys/` and symlink refusals
- [x] 5.4 — `fetch_api_docs` with the allow-list and cache
- [x] 5.5 — the budget and its accounting

## Stage 6 — the dialog

Three small additions to the command/form vocabulary, each useful beyond this feature.

**`Prop.multiline`** (`packages/commands/src/props.ts:29`) — a string that draws
`row.textarea()` (path.ux `core/ui.ts:2305`) instead of `row.textbox()`. `CommandForm.field()`
(`commandform.ts:147`) branches on it. `textarea()`'s signature has no callback parameter the way
`textbox()` does, so the change handler is wired on the returned widget; confirm the exact hook
against the vendored source at implementation time.

**`Prop.hint`** — optional longer text used as the *tooltip* wherever a prop draws, defaulting to
`description`. Needed because `field()` passes `prop.description` as the checkbox's **label**
(`commandform.ts:121`), leaving nowhere for a hover sentence — and the tooltip rule has no
exceptions. Fixing it on the spec rather than at the call site is what the convention asks for.

**`openCommandDialog(id, overrides?, choices?)`** — per-open option rows for a `string` prop:

```ts
type Row = { value: string; label: string; tooltip?: string };
type Choices = (values: Record<string, PropValue>) => Record<string, Row[]>;
```

**A function of the current values, not a fixed map**, because one of this dialog's lists depends on
another of its fields: the effort rows are `effortChoicesFor(values.model)`, and the model is picked
in the same form. `field()` already calls `this.render()` after a menu selection, so recomputing the
rows on each draw is the whole mechanism. The thread list ignores its argument.

`field()` draws a `row.menu` when `choices(values)[prop.name]` is non-empty, else the usual textbox
— non-empty rather than merely present, so a model with no effort knob falls back to nothing to
pick rather than an empty menu. Enum
options are static by construction — `prop.values` is baked at module load and the catalog is a
pure projection (`catalog.ts:12`) — and they should stay that way: a list of conversations is not
part of a command's vocabulary. Making it a renderer-side, per-open concern keeps the catalog,
`coerceProps` and every DSL/CDP/agent caller unchanged, and the prop stays `prop.string` exactly
as `agent.openThread` already declares it (`commands/agent.ts:109`).

### The model that does the analysis, and what the dialog says about it

**The default is the model the author already has bound** — `session.model` / `session.effort`,
mirrored in the renderer as `ui.model` / `ui.effort` (`state.ts:48`, `convo.ts:171-186`). There is
no separate "analysis model" setting to keep in sync, and it is the model whose key is already
resolvable.

**But the dialog offers both as fields, and changing them here changes nothing else.** Advice with
no way to act on it is a lecture: an author told haiku is a poor choice should not have to cancel,
walk to the convo pane, rebind their agent, and come back — and rebinding it would then be a change
they did not want, left behind after the report. So `model` and `effort` are per-run props, the
command stays `mutating: false`, and it never calls `session.setModel`/`setEffort`.

**The advisory is a note, not a refusal.** `agent.setEffort` already states the house position —
*"Every choice is accepted, not just the ones the current model offers"* (`commands/agent.ts:52`) —
and the verdict strip is binary by design, `undeclared` drawing nothing at all so a tick can never
invent an assurance (`commandform.ts:92-100`). So the advisory rides on the **accept note**, which
that strip already renders: `check` returns `{ ok: true, note }`, exactly the shape `wouldRename`
uses (`commands/agent.ts:128`), and `recheck()` redraws it on every menu change for free. The tick
means *this will run*; the sentence says what it will cost. No new widget, no new prop kind.

The matrix is a pure function, `apps/desktop/src/shared/advice.ts` — **shared, not in
`@vn/agentreport`**, because main's `check` and the renderer's menu rows both read it and
`@vn/agentreport` is node-bearing. Its only import is `@vn/types`, which `src/shared/` already
depends on:

```ts
export interface Advice {
  level: 'ok' | 'note' | 'warn';
  text: string;
}
export function adviseModel(modelId: string, withSource: boolean): Advice;
export function adviseEffort(modelId: string, effort: EffortChoice): Advice;
export function adviseRun(modelId: string, effort: EffortChoice, withSource: boolean): string;
```

It lives here rather than in `@vn/types` beside `effortChoicesFor` deliberately: `textmodels.ts`
answers *what a model will accept*, which is a fact about the API. This answers *what is a good
choice for reading a broken transcript*, which is an opinion about one task, and an opinion does
not belong in the table every surface reads.

**Models.** `TEXT_MODELS` is the list; an id outside it is still allowed (`agent.setModel` takes
`prop.string`, not an enum) and simply gets no advice.

| Bound model | Level | What the note says |
| --- | --- | --- |
| `claude-opus-*`, `claude-sonnet-*` | ok | nothing — this is the expected case |
| `claude-haiku-4-5` | warn | `Haiku is a fast model for short work. Sonnet or Opus will read this conversation far better.` It also has no reasoning knob at all and a 200K context, so the effort row is greyed and a long thread is likelier to be cut. |
| `gemini-2.5-flash` | warn | the same sentence, same reasons |
| `gemini-2.5-pro` | note | usable; it too has no effort knob, so the row greys |
| `claude-fable-5` | warn | `Fable is priced above Opus and is tuned for writing fiction, not for diagnosing a tool loop.` |

Fable earns a **third** clause that matters more than the price here, and it is the one to lead
with: Fable requires 30-day data retention and is unavailable under zero-data-retention terms.
This feature's entire pitch is *the conversation stays on your machine* — recommending against the
one model that would retain it is not an aside, it is the point. **Confirm this against the
provider's current terms at implementation time** and drop the clause if it has changed; the price
and fit arguments stand either way.

The haiku and flash warnings are **sharper when `source` is ticked**, which is why `adviseModel`
takes the flag: the with-source path is a 24-step tool loop over a large codebase, and a small
model with a 200K window is where that path fails rather than merely underperforms.

**Effort.** Only asked when `supportsEffort(modelId)`; otherwise the row is greyed with the reason
the convo pane already gives, and the model note above carries the advice.

| Choice | Level | Why |
| --- | --- | --- |
| `none` (`no thinking`) | warn | `Thinking off. The report will be a summary of the conversation rather than a diagnosis of it.` Naturally scoped: Fable/Mythos have no `none` to pick. |
| `low` | note | `A diagnosis wants some thinking — medium is the sweet spot for this.` |
| `medium`, `high` | ok | nothing |
| `xhigh`, `max` | note | `More thinking than this needs — the evidence is one transcript, and the answer is a diagnosis, not a search.` |

**On warning about `low`: the note is worded as advice, not a warning, and the dialog does not
start there.** `DEFAULT_EFFORT` is `'low'` and is deliberately a level rather than the absence of
one, so a `warn` on `low` would fire for nearly every author the first time they open this dialog —
a warning that always fires is one nobody reads. The fix is the default, not the volume: the
dialog's `effort` prop defaults to

```ts
resolveEffort(model, stronger(session.effort, 'medium'))
```

— the bound choice, stepped **up** to at least `medium` and then clamped to what the model takes.
So `low` is only ever seen here because someone chose it, and the note is then the right register.
`stronger()` is an `EFFORT_CHOICES` index comparison and belongs beside the matrix. The dialog says
`Raised to medium for this analysis; your conversation setting is unchanged.` as part of the same
accept note, so nothing is changed under the author silently.

This is also the answer to *"anything higher than `high` is unnecessary"*: it is true, but it is a
`note`, not a refusal — an author debugging something genuinely strange may well want `max`, and
that is theirs to spend.

`adviseRun` composes the two into the single sentence the strip shows, worst level first, and is
what the `check` returns as its `note`.

### The command

`apps/desktop/src/main/commands/report.ts`:

```ts
export const reportAgent = define({
  id: 'report.agent',
  title: 'Report a difficult agent',
  description:
    'Analyse a conversation that went wrong and draft a bug report. The analysis runs on your ' +
    'own machine with your own model key — the conversation is never sent to us. Names from ' +
    'your story are replaced before the model sees them, and you review the report before ' +
    'anything is posted.',
  mutating: false,
  props: {
    thread: prop.string('the conversation to analyse'),
    note: prop.string('what you had wanted the agent to do', { default: '', multiline: true }),
    source: prop.boolean('let the debug agent read the source code (uses more tokens)', {
      default: false,
      hint:
        'The debug agent reads this app’s own code and design docs, so it can point at the ' +
        'rule that was broken instead of guessing from the conversation. Slower, and it spends ' +
        'more of your tokens.',
    }),
    model: prop.string('the model that reads the conversation', { default: '' }),
    effort: prop.string('how hard it thinks about it', { default: '' }),
  },
  check: …,
  async run(props, ctx) { … },
});
```

The `description` is where the privacy explanation lives — `Dialog` already labels the title and
description above the form (`renderer/pathux/dialog.ts:57-72`), so no new surface is needed to say
it.

**`effort` is a `prop.string`, not `prop.oneOf`,** for the reason the vocabulary section gives: an
enum's `values` are baked at module load, and this menu's rows depend on the model chosen in the
same form. `coerceProps` stays the authority — `run` validates the string against
`effortChoicesFor(model)` and steps it down with `resolveEffort` rather than trusting the caller,
which is what a DSL or CDP invocation needs anyway. **Both default to `''`, meaning *whatever is
bound*,** resolved in `run` — so `report.agent(thread='t3')` from a script does the sensible thing
without naming a model, and the dialog seeds the fields explicitly when a human opens it.

`check` refuses, with the sentence a disabled control will show verbatim:

| Condition | Refusal |
| --- | --- |
| No conversations saved | `No conversations have been recorded in this project yet.` |
| Named thread unknown | `No conversation <id>.` |
| No key for the analysis model | `No <vendor> key is set — use Provide Model Key… first.` |
| `source` ticked and `sourceRoot()` is undefined | `This build did not ship its source, so there is nothing to read.` |

The key refusal is keyed to the **chosen** model, not the bound one — switching the dropdown from a
Claude id to a Gemini one changes which key has to be there, and the refusal names the vendor so
the sentence tells the author which one to go and set. It still names the *source*, never the
value, as `resolveKeys` does.

If nothing refuses, `check` returns `{ ok: true, note: adviseRun(model, effort, source) }` — the
advisory strip described above.

No `confirm: true`. The dialog is itself the consent, and Stage 7's preview is the second gate; a
confirm click between them would be ceremony.

### The menu entry

`header.ts:192` gains a third menu beside `VN STUDIO` and `View`:

```ts
this.bar.menu('Help', this.helpMenu());
```

The entry cannot be a bare `openCommandDialog`, because it needs the thread rows and the default:

```ts
['Report a Difficult Agent…', () => void openReportDialog(), undefined],
```

`openReportDialog()` runs `exec('agent.threads')`, maps `data.threads` into choice rows the same
way `ConvoEditor.showThreads()` does (`editors/convo.ts:217-249`), and opens the dialog seeded
with the default thread, `ui.model`, and the stepped-up effort. Its `choices` function is the whole
of the dynamic vocabulary:

```ts
(values) => ({
  thread: threadRows,
  model: TEXT_MODELS.map((id) => ({ value: id, label: id, tooltip: adviseModel(id, …).text })),
  effort: effortChoicesFor(String(values.model)).map((c) => ({ value: c, label: effortLabel(c) })),
})
```

The model rows carry their advice as the **row tooltip**, so it is readable before choosing rather
than only after — which is the tooltip rule doing real work, not decoration. An empty `effort`
array means the model has no knob, and `field()` falls through to no menu at all.

**The default is `threads[0].id` — the newest, not the active one.** `Session.thread` is set lazily
on the first turn and cleared by `agent.clear`, `agent.newThread`, uploads and *reopening a thread*
(`session.ts:743`, `:770`) — so `active` is `undefined` most of the time, including right after
someone reopens the bad conversation to look at it. Newest-first ordering makes `threads[0]` the
one they just had trouble with, so the `active ??` half was dropped as a fallback that would fire
about as often as it misfired.

### Running it

Submit closes the dialog and the run reports through the existing notification frame, like every
other long act — one to two minutes is far too long to hold a modal, and `openCommandDialog` is
one-at-a-time (`dialog.ts:88`), so holding it would block the palette too. Completion opens the
preview.

Five things the implementation settled:

- **A multiline prop is a plain `<textarea>`, not path.ux's `textarea()`.** That widget is a
  `contentEditable` rich-text editor with a bold/italic toolbar, and its value is `innerHTML` —
  more widget than a note wants, and it stores markup where a command expects a string. So
  `CommandForm.writingBox` appends a raw `<textarea>` to the row's shadow root, the way every other
  writing surface in this app draws one, carrying its tooltip as `.title` per the two-mechanism
  rule and stopping its own keydown because the screen keymap is a bubble-phase window listener.
- **There is a fifth refusal, and it is first: mock providers.** A workspace opened with `--mock`
  has no real backend, so the key check would refuse with the wrong sentence — or worse, a mock
  backend would answer and the author would get a fabricated diagnosis. `previewReport` answers
  `Not while this workspace is running with mock providers — a real model has to read the
  conversation.` before anything else is asked.
- **`chatBackendFor` moved into `@vn/providers` and took an optional effort.** The desktop session
  had a private copy of the vendor-picking rule; the analysis needed a third caller with a
  *different* effort from the bound one. Rather than a third copy, the factory's exported picker
  gained `effort?: EffortChoice` (Gemini has no such knob and ignores it) and the duplicate was
  deleted — one picker, one rule.
- **The report is a checked non-mutator, and the invariant was widened rather than bent.**
  `commands.test.ts` asserted a `check` exists only on mutators. Making `report.agent` mutating to
  satisfy it would be a lie that drags it onto the undo and commit path. A check is a precondition
  on an *act* — something with a cost running it would incur — and this one spends a minute of a
  real model's time on a real key, so "run it and find out" is the wrong answer. The test now says
  that, and lists the one checked non-mutator by name.
- **The verdict strip is the disabled state.** `CommandForm` does not grey the run button on a
  refusal; it prints the refusal verbatim in its own strip directly above it, which is the same
  sentence a disabled control's tooltip would have carried. Rather than add a second mechanism for
  one command, Stage 6 filled the actual gap it found — the `enum` menu was the one widget in
  `field()` drawing without a tooltip — and left the refusal where every other command shows it.

- [x] 6.1 — `Prop.multiline`, `Prop.hint`, `CommandForm` support, catalog passthrough for `hint`
- [x] 6.2 — `openCommandDialog` `choices` as a function of the current values
- [x] 6.3 — `src/shared/advice.ts`: `adviseModel`, `adviseEffort`, `adviseRun`, `stronger`, tested
- [x] 6.4 — the `report.agent` command, its refusals, and the accept note; `model`/`effort`
      defaulting to the bound pair and validated through `effortChoicesFor` + `resolveEffort`
- [x] 6.5 — the Help menu and `openReportDialog()`, including the two dependent menus
- [x] 6.6 — tooltips on every control, the checkbox's from `hint`, the model rows' from
      `adviseModel`, the disabled state from `check`

## Stage 7 — review, then the issue

### Where the report is written

**Outside the project**, in the app's `userData` directory as `reports/<stamp>.md` — not under
`vngen/state/`. A bug report is about the *app*, not the story: it has no business in the author's
committed project history (`vngen/` is committed on purpose), and a redacted transcript of their
own conversation is not something to commit on their behalf. That also keeps the command
`mutating: false`, so commit-on-save is not involved at all.

### The preview

Editable, and a bespoke surface rather than a `CommandForm`. The reason is a genuine conflict: the
report body must be **editable** (so not `digest`) and must **not** be logged verbatim into
`commands.jsonl` (so `digest`) — and `digest` replaces the editor with a size label whenever the
value is non-empty (`commandform.ts:113`). So the preview is a small dialog — a textarea, the leak
banner, `Open GitHub Issue…` and `Discard` — and the command it eventually calls declares its body
prop `digest: true` for recording purposes only.

**The leak scan is a refusal, re-checked as you type.** `report.openIssue`'s `check` runs
`redactor.leaks(body)` and refuses by name — `"Riva Kestrel" is still in the report` — and the
preview re-checks on keystroke exactly as `CommandForm` does (`commandform.ts:92`), so the button
stays refused until the report is clean. The author fixes it in place; nothing is silently
rewritten under them.

### Opening GitHub

```ts
export const ISSUE_REPO = 'joeedh/visualnovel';
export function issueUrl(input: { title: string; body: string; labels?: string[] }): URL;
export function fitBody(report: string, limit = 8000): { body: string; truncated: boolean };
```

- **The repo is a build-time constant, not the git remote.** A packaged app has no checkout to
  read one from, and a fork's remote points at the fork.
- **The URL will not hold the report.** GitHub rejects somewhere around 8 KB of URL and
  percent-encoding inflates newlines threefold, so the practical body budget is roughly 2.5–3 KB of
  markdown. `fitBody` carries the summary, root cause and recommendations, and when it has to trim
  it appends a line saying the full report is on the clipboard — which `report.openIssue` puts
  there with `clipboard.writeText` before opening the browser.
- **The URL is asserted before it is opened.** Built with `URLSearchParams`, then checked
  (`origin === 'https://github.com'` and the exact `/joeedh/visualnovel/issues/new` pathname)
  before reaching `shell.openExternal`. The body is agent-authored text; a composed string must
  never go straight to the shell.
- Title is `AGENTREPORT: ${summary}`, truncated; `labels=agent-report`.

`shell` and `clipboard` are new imports in `apps/desktop/src/main/index.ts:13` — neither is
currently pulled in.

### Five things the implementation settled

- **The evidence was going out unredacted, and the fix is a boundary rather than a habit.**
  `analyze` scrubbed the `Analysis` prose it got back from the model, but `renderReport(report,
  evidence)` embeds `toMarkdown(evidence)` verbatim — so the `<details>` transcript in the issue
  body would have carried real character names, real paths, the author's account name and every
  `record.invocation`. `redactEvidence` now runs **once**, in `analyseThread`, before the analyst
  sees it: the prompt, the rendered issue and the saved copy are all derived from an
  already-clean value, and nothing downstream has to remember. The scrub inside `userPrompt`
  stays as the belt to this brace — redaction is idempotent, so it costs nothing.
- **Two budgets, not one.** The plan said `fitBody(report, limit = 8000)`; the code splits it into
  `URL_LIMIT = 8000` (what GitHub will take) and `BODY_BUDGET = 6000` (what the body may spend of
  it), because the title and the label are also on that URL. Trimming sheds in order — the
  `<details>` transcript, then `From the transcript`, `What happened`, `What went wrong` — and
  falls back to a binary search on the *encoded* prefix, so the budget is a promise even when the
  limit is too small to hold the trimmed-note itself.
- **The redactor an analysis was written with is the redactor its report is scanned with.** A
  pseudonym table is per-redactor, so building a fresh one for the leak check would be scanning
  for different names. `WorkspaceSession` keeps the one `analyseThread` handed back, and builds
  one from the loaded project only for the scripted case — `report.openIssue(body='…')` with no
  analysis in this process — which is also what keeps the per-keystroke check off `loadProject`.
- **Electron reaches `openIssue` as two functions, not as an import.** `session.ts` is
  typechecked and tested with no app around it, so `shell.openExternal` and
  `clipboard.writeText` arrive as optional `SessionDeps` members. Absent means no browser, and
  the command says so rather than reporting a success it did not have.
- **The writing surface is now one function.** The preview needs the same `<textarea>` a
  `multiline` prop draws, so `writingBox` moved out of `CommandForm` into `pathux/writingbox.ts` —
  one place to decide that this app does not use path.ux's `contentEditable` rich-text editor.

- [x] 7.1 — `issue.ts` (`issueUrl`, `fitBody`, the origin assertion) with tests, including a body
      that must be trimmed and one that must not
- [x] 7.2 — writing the report to `userData/reports/`
- [x] 7.3 — the preview dialog and its live leak check
- [x] 7.4 — `report.openIssue`: clipboard, assertion, `shell.openExternal`

## Testing

Per the house rule, pure logic gets `tests/` siblings and surfaces are verified live over CDP.

- **Unit** (`packages/agentreport/src/tests/`): redactor (substring safety, possessives, case,
  path prefixes, idempotence, `leaks`), `assemble`/`toMarkdown` over fixtures, `render`,
  `issueUrl`/`fitBody`, `sourcemap` refusals, grep caps and their reported truncation.
- **Unit** (`apps/desktop/src/shared/tests/advice.test.ts`): every id in `TEXT_MODELS` gets a
  level; no model with an empty
  `effortChoicesFor` ever produces an effort note; `stronger(DEFAULT_EFFORT, 'medium')` is
  `medium` and the seeded default is `medium` on every model that has a knob; `'none'` is
  unreachable on Fable, so the `none` warning is never generated for it.
- **Unit** (`apps/desktop/src/{shared,main}/tests/`): the thread-format round-trip, both
  directions of compatibility.
- **CDP**: the Help menu entry opens the dialog; the dropdown lists threads with the right default;
  the refusals appear as the disabled tooltip; picking haiku redraws the strip with the warning and
  removes the effort menu; the preview's leak banner clears as a name is edited out.
- **No live model call in CI.** The analyst is exercised against a mock `ChatBackend`, the way the
  rest of the repo does it.

### What the live pass found

Run against a copy of `examples/test3` with the author's own key, every CDP item above passed, and
three defects in the surfaces turned up on the way:

- **Prose painted out of its popup.** A path.ux `Label` is a `<div>` sized to its text and never
  told a maximum width, so a command's description and a verdict sentence ran past the dialog and
  off the window. Everything the shell draws as a *sentence* now goes through `paragraph()`
  (`renderer/pathux/paragraph.ts`) — the dialog, the palette's detail column and the report preview.
- **An empty choice list degraded to a free-text field.** With a model that has no reasoning knob,
  `effortChoicesFor` answers `[]` and `CommandForm.field` fell through to a textbox, inviting an
  effort the model does not have. An offered-but-empty list now draws no row at all.
- **`onExec` never fires for `window.vn.exec`.** The scripting bridge lives in the preload and
  invokes main directly, so the preview cannot be watched into existence from CDP. The comment on
  `installReportPreview` said otherwise and was corrected; a scripted run reads the outcome and the
  copy under `userData/reports/`, which is what a script wanted.

Two things were seen and left alone, because both are the redactor's exact-token contract rather
than a surface bug: a possessive typo (`jame's`) is not the token `james`, so it survives
substitution *and* the preview's leak scan, which consults the same table; and an unknown model id
passed from a script accepts with no advisory, being unreachable from the dropdown.

## Deliberately out of scope

- **Restoring `Agent.messages` on reopen** — Stage 5 of `conversation-threads.md`, still deferred.
  The report works from the transcript and the act log.
- **Posting the issue.** The browser opens an unsubmitted form; the author presses Create.
- **Any upload path that is not the author's own browser.** No telemetry, no service, no key of
  ours.
- **Reporting from `vnauthor`.** One host for now; the package moves down if that changes.

## Finishing

1. Audit comments in everything touched; no `CLAUDENOTE:` survives.
2. Update `CLAUDE.md` — the layering graph gains `agentreport`, and the invariant lines gain the
   redactor-as-boundary rule, the source manifest, and the build-time issue repo.
3. Update [`docs/desktop-app.md`](../desktop-app.md) (the Help menu, the two dialogs, and the note
   that the analysis borrows the bound model without rebinding it),
   [`docs/command-system.md`](../command-system.md) (`multiline`, `hint`, `choices`), and the
   As-shipped section of [`conversation-threads.md`](conversation-threads.md) for the format
   enrichment.
4. Flip this plan's status and its row in [`index.md`](index.md).

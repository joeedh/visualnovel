# Reporting a difficult agent

<!-- toc -->

- [The privacy model](#the-privacy-model)
- [The package](#the-package)
- [Evidence](#evidence)
- [Redaction is a boundary](#redaction-is-a-boundary)
- [The analyst](#the-analyst)
  * [What source it may read](#what-source-it-may-read)
  * [The request-capture tools](#the-request-capture-tools)
- [The setup, and the conversation](#the-setup-and-the-conversation)
- [Review, then the issue](#review-then-the-issue)
- [Deliberately absent](#deliberately-absent)

<!-- tocstop -->

How **Help ▸ Report a Difficult Agent…** works as shipped: an author picks a conversation that
went badly, says what they had actually wanted, and a dedicated **debug agent** — running on the
author's own model key, on the author's own machine — reads the thread, works out what went wrong,
and drafts a report. It is a conversation rather than one answer: the author replies, grants it
more to read, stops a turn, and gets a revised report whenever it files one. The author reviews and
edits the draft, and one click opens a pre-filled GitHub issue titled `AGENTREPORT: …`. Nothing is
ever posted for them.

The pure logic lives in **`@vn/agentreport`**; the desktop app's main process is its only
consumer (`apps/desktop/src/main/commands/report.ts` defines the seven `report.*` commands). The
plans that built it, with the implementation history:
[`../plans/archive/INDEX.md#reporting-a-difficult-agent`](../plans/archive/INDEX.md#reporting-a-difficult-agent)
and, for the request-capture tools,
[`../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it`](../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it);
for the pane and the held conversation,
[`../plans/archive/INDEX.md#the-debug-agent-as-a-conversation`](../plans/archive/INDEX.md#the-debug-agent-as-a-conversation).

## The privacy model

Three commitments, in descending order of visibility:

- **The analysis is not a service.** It runs on the author's key, so the conversation never
  leaves their machine except as a report they read first — and the report goes only where the
  author's own browser takes it.
- **Names from the fiction are replaced before any model sees them**, deterministically, by a
  redactor that sits on the boundary rather than in a prompt (below). The pseudonym map is held
  in memory only — never written to disk, never sent to the model, never in the report — so a
  filed issue is not de-anonymisable.
- **The two optional reading doors are different promises.** The *thread* and the *app source*
  can end up quoted in the report; that is their point. The *captured requests* never do: the
  analyst sees structure and capped, redacted values through `list_requests` / `read_request`,
  and none of it is carried into `submit_report`. The privacy area of the detailed capture stays
  one party wide — the author's own model provider, who was already sent those bodies.

## The package

`packages/agentreport/` is a leaf beside the four shared ones (`export`, `scriptedit`, `bible`,
`artgen`), but with one host rather than two — it moves down only if `vnauthor` ever grows the
same command. It may import the input-side packages plus `@vn/commands` (the acting record a
transcript lacks is `commands.jsonl`) and `@vn/providers`; the boundaries rule forbids
`@vn/pipeline` and `@vn/scheduler`.

| Module            | What it holds                                                                |
| ----------------- | ---------------------------------------------------------------------------- |
| `transcript.ts`   | `assemble` / `toMarkdown` — evidence from a thread plus the command log      |
| `redact.ts`       | `buildRedactor` / `sourcesFrom` — the substitution boundary and `leaks()`    |
| `report.ts`       | `analysisSchema` — the report shape both analysis paths produce              |
| `analyze.ts`      | `createAnalyst`, the two analysis paths, and redaction on both sides of the model |
| `render.ts`       | the one markdown renderer both paths share                                   |
| `sourcemap.ts`    | `READABLE` / `DENY` — the declared manifest of what source may be read, and what the installer copies |
| `sourcetools.ts`  | `grep`, `read_file`, `fetch_api_docs`, and the shared `Budget`               |
| `requesttools.ts` | `list_requests` / `read_request` over a frozen capture snapshot              |
| `issue.ts`        | `ISSUE_REPO`, `issueUrl`, `PASTE_BODY` — the GitHub issue URL and its check  |

All but `analyze.ts` are pure and node-tested in `src/tests/`.

## Evidence

`assemble(thread, records, context)` joins the thread with `commands.jsonl` **by time**: the
window runs from the thread's start to its last stamped line — not to now, because a thread stays
open while the author keeps working and those later acts are not the agent's. Acts the author
performed by hand are deliberately included: what happened in the project while the conversation
was open *is* the evidence. Reading the log back is `apps/desktop/src/main/commandlog.ts`, with
`evidenceFor(paths, threadId, context)` as the one seam that touches disk.

A thread recorded before the detailed format (tool args, results, untruncated text — the Stage 1
enrichment in the plan) is flagged `thin`, and the report carries a line saying the transcript
predates the format, so a maintainer knows why the evidence is sparse.

The evidence is the display log and never `<id>.native.jsonl`. The native log is what a resume
and the agent's own history tools read; it holds the same conversation at full length, including
tool results that were never drawn, and none of it passes the redactor. A `compaction` line in the
display log is ignored for the same reason it is harmless: it summarizes turns that are still
above it, so a report that reads the items reads what the summary covered rather than the summary.

`toMarkdown` fences tool args and output with a backtick run longer than any in the text, because
a report about an agent that mangled a markdown file must not end its own code block midway.

A thread also carries the receipts its calls returned, and `toMarkdown` renders what the prompt
cache did with them: the counts per verdict, and every call the prefix broke on named by step with
what it cost to re-send. The section is left out entirely where no call carried a verdict, because
an empty one would read as a cache that never missed. Which backends produce a verdict at all is
[`docs/plans/recording-cache-misses-in-a-thread.md`](../plans/recording-cache-misses-in-a-thread.md).

`redactEvidence` names `ThreadRecord`'s fields explicitly rather than spreading it, so a field added
later has to be considered rather than reaching the model by default.

## Redaction is a boundary

Nothing reaches the model unredacted — not the transcript, not the author's note, not a tool
result — and every prose field of the reply is redacted again on the way out, because an analyst
that read source may recall a name the transcript never held. The sources come from the loaded
`ProjectModel` (every character, location and scene id, plus display names), the project title
and root, and the OS username / home prefix. Rules that carry weight:

- **Longest match first**, so `Titus Vale` is not half-replaced by `Titus`.
- **An apostrophe is punctuation, not a letter** — `James's`, `James'` and the slip `Jame's` are
  one person, found by a live leak during the shipping pass.
- **Boundary guards are per name and Unicode-aware** — `\b` is ASCII, so a guard is only demanded
  on an edge whose own character is a letter in a spaced script; a single ideograph is a whole
  name.
- **Paths match through either separator and through JSON escaping** (`C:\\dev\\x` as
  stringified tool args), project root before home directory.

`leaks(text)` is the same matcher used as a detector; it is what gates the issue button.

## The analyst

Two paths, different in kind, producing the same `analysisSchema` shape rendered by one
`render.ts`:

- **Without source** — one structured call through `chatBackendFor` + `withStructuredRetry`; no
  agent loop at all. This is the headless path only: the conversational one always builds a loop,
  if only over `submit_report`, because a single structured call is nothing to talk to.
- **With source** — the `@vn/authoring` loop with an injected registry of exactly four tools:
  `grep`, `read_file`, `fetch_api_docs`, and `submit_report`, whose validated args end the run.
  Plans are auto-approved (the registry holds nothing that could act on one) and a confirmation is
  refused rather than approved. `ask_user` is answered with a fixed "nobody is here" under
  `report.agent`; in the pane someone is there, and the question parks the turn instead.
  If this path fails, it **falls back to the cheap one** rather than erroring, and the report
  records `fellBack` — so `readSource` on a finished report means the analyst actually read
  source, not that it was allowed to. A run the author **stopped** returns a distinct stopped
  outcome and the fallback is not taken, because a stop must not spend another call.

`readSource` is set by watching the tools rather than by the offer: each source tool is wrapped so
that calling it records the fact, and a run that had the source and never opened it has its
`confidence` clamped to `low`. A run offered no source is not clamped, because there was nothing to
open and the analyst's judgement of the transcript is all the report ever had.

The analyst is also told what the agent under report could do, and reads the author's account as a
claim under test:

- **The reported agent's tools** are taken from the registry the reporting host actually built
  (`Agent.tools`, or the host's own default when no turn has run in this window), never from the
  `ALL_TOOLS` constant — `createRegistry` takes an `extra` argument, so the constant is not the tool
  list any given host runs with. A recommendation asking for something outside that list is asking
  for a tool that does not exist, and the prompt says so.
- **What the author said** is printed in the issue verbatim, under a heading naming it as the claim
  the analysis started from rather than one of its findings. The system prompt asks the analyst to
  check it and to write "the author reports X" wherever the evidence does not settle it.

The loop picks its backend with the same probe the desktop app and `vnauthor` use: the native
cached path when the model's backend implements `chatConversation`, the structured path otherwise.
That matters most here, because the first user message is the whole transcript and every iteration
re-reads it. Tools are **never deferred** in this loop (`deferTools: false`) — the catalog is six
tools, so deferral would buy no context back, and it would hide `submit_report` behind tool search,
which ends the run without a report.

The key check happens at the point of use and names the env var or file, never the value, exactly
as `resolveKeys` does everywhere else.

### What source it may read

The install ships full source unpacked, at `<resourcesPath>/source` (an `extraResource`, not inside
`app.asar`, because the read tools use plain `fs`), and the
readable set is a **declared manifest** in `sourcemap.ts` — `READABLE` names `packages`, `apps`,
`docs`, `scripts`, `CLAUDE.md` and `package.json`; `DENY` removes `node_modules`, build output,
`.git`, `keys` and the minified vendor blobs. That manifest is also what `scripts/package.desktop.mjs`
copies into the image: it bundles `sourcemap.ts` and walks `READABLE` through the same `denied` and
`textFile` predicates the tools use, rather than restating the list, because a packaging manifest
that disagreed would turn an honest refusal into "no such file". `pnpm smoke` asks the built binary
whether `sourceRoot()` answers, so a `to:` renamed on one side fails at package time rather than in
a report months later. `docs/` and `CLAUDE.md` are the highest-value
entries: they state the invariants in prose, so a report can cite the contract that was broken
rather than paraphrase code. Refusals that matter: `keys/**` by name and before the generic
sentence, symlinks by `lstat` in both the walk and the read, and `fetch_api_docs` takes a
provider and topic — **never a URL** — against a fixed allow-list, because an agent that has just
read a private manuscript must not hold an exfiltration channel.

One `Budget` (steps, input tokens, and a byte budget across all reads) is shared by every tool in
a run, and **truncation is reported to the model** — a cap silently read as "no matches" produces
a confidently wrong report.

### The request-capture tools

When the author also opens the request door, the analyst gets `list_requests` and `read_request`
over a **frozen** `captureSnapshot()` of `@vn/providers`' in-memory ring — frozen because a live
ring could evict the entry the analysis was opened to read. The default answer is a structural
outline, not content; a path read returns one node's values, decoded, redacted and capped at
2,000 characters; base64 blocks are refused by kind. The analyst runs with `{ record: false }` so
its own calls do not enter the ring it is reading.

A run with the request tools and no source is the same loop, so it makes the same backend probe and
defers no tool either. `record: false` is honoured on the cached path — `createAnthropicChat`
threads the flag into `chatConversation`'s capture — so taking it does not put the analyst's own
prompts back in the ring. The cost of that is deliberate: a failing request from the analyst itself
is the one fault class the request-diagnosis tools cannot see.

## The setup, and the conversation

Help ▸ Report a Difficult Agent… opens the Debug Agent pane, whose first card holds what the
command dialog used to collect: the thread, the model, the effort, and the two reading boxes. The
card seeds the newest thread (not the "active" one, which is usually empty), the bound model, and
the bound effort **stepped up to at least `medium`** for this run only — nothing rebinds the
conversation's own settings. Model and effort advice comes from
`apps/desktop/src/shared/advice.ts` (`adviseModel` / `adviseEffort` / `adviseRun`), and it is the
card's advice line: the Start button means *this will run*, the sentence says what it will cost.

`report.open` and `report.agent` are **checked non-mutators** — a check is a precondition on an act
with a cost, and this one spends a minute of a real model's time on a real key. Both refuse through
`previewReport`, so the Start button and the headless form show the same sentences: mock providers
first (a mock backend would fabricate a diagnosis), then no conversations recorded, an unknown
thread, no key for the **chosen** model (naming the vendor), and `source` ticked on a build that
did not ship its source.

Past the card it is a conversation rather than one call: the author answers, sends more, and gets a
revised report card whenever the analyst files one. Each turn is bounded by the same per-turn token
ceiling and step cap a headless analysis uses; the conversation is not bounded, because the author
is at the keyboard and the spend is on their own key. Stop ends the turn after the step it is on —
`Agent.stop()` is read at the top of each step and no backend streams — and a stopped run returns a
stopped outcome, so the single-call fallback is **not** taken: a stop must not spend another call.
The conversational path always runs a loop, if only over `submit_report`, because a single
structured call is nothing to talk to; the cheap unlooped path survives under `report.agent`.

Both reading doors can also be opened part way through, through `report.grant`. `run` builds its
tool catalog once per turn, so a grant lands on the next turn and its box says so, and granting is
one-way because tools already used cannot be un-remembered from the transcript. Everything the
analyst says is redacted before it reaches the pane, through the same `Redactor` the report is
scanned with — a chat saying "Yuki" beside a report saying "Character A" reads as a bug, and one
rule is easier to keep than two.

`LOOP_PROTOCOL`'s "call `submit_report` exactly once" is kept verbatim for `report.agent` and
replaced on the conversational path, which is told to file a report before finishing any turn it
has concluded in and to file a revised one whenever the author's next message changes the
conclusion. `unattended()`'s "nobody is here to answer" is likewise kept for the headless path only:
in the pane an `ask_user` parks the turn and puts the question in the transcript.

The conversation is written down at `<userConfigDir>/debug-transcripts/`, outside every repository,
one versioned JSON object per line. Ten are kept and a new conversation prunes the oldest as it
starts, so a crashed run cannot leave an eleventh. A line comes from the same reducer the pane draws
with, and **a tool's result is never written**: the request captures in particular are the author's
own traffic. The thread is named there by id and a filed report is written without its archive path,
because neither has been through the redactor. The pane itself is in
[`desktop-app.md`](desktop-app.md) under Debug Agent.

## Review, then the issue

The finished report is written **outside the project**, to the app's `userData/reports/<stamp>.md`
— a bug report is about the app, not the story, and a redacted transcript is not something to
commit on the author's behalf. The preview dialog is editable, and its Open GitHub Issue… button
is gated by `report.openIssue`'s `check`, which runs `redactor.leaks(body)` on every keystroke and
refuses by name (`"Riva Kestrel" is still in the report`) until the author has edited the name
out — the same redactor the analysis ran with, because a fresh one would scan for different
pseudonyms.

Opening the browser opens an **unsubmitted** form on `github.com/joeedh/visualnovel/issues/new`
(`ISSUE_REPO` is a build-time constant, not the git remote — a packaged app has no checkout and a
fork's remote points at the fork). The URL is asserted (`origin` and exact pathname) before
`shell.openExternal`, because the body is agent-authored text. The report itself never travels on
the URL: the whole of it goes on the clipboard, and the form is prefilled with `PASTE_BODY`, so a
long conversation and a short one ask the author for the same one action. The preview stays open
after the browser launches — nothing has been posted yet, and dismissing it would take away the
only copy at the moment the author is reading it over.

## Deliberately absent

- **Posting the issue.** The author presses Create, or nothing happens.
- **Any upload path that is not the author's own browser.** No telemetry, no service, no key of
  ours.
- **Restoring `Agent.messages` on reopen** — the report works from the transcript and the act
  log.
- **Reporting from `vnauthor`.** One host; the package moves down if that changes.

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

As shipped, **Help ▸ Report a Difficult Agent…** works as follows. An author picks a conversation that went badly and says what they had actually wanted. A dedicated
debug agent (running on the author's own model key, on the author's own machine) reads the thread, works out what went wrong, and drafts a report. The author carries on
a conversation rather than receiving one answer, replying to the agent, granting it more to read, stopping a turn, and getting a revised report whenever the agent files
one. The author reviews and edits the draft, and one click opens a pre-filled GitHub issue titled `AGENTREPORT: …`. The tool never posts anything on the author's behalf.

The "pure" logic lives in `@vn/agentreport`, and the desktop app's main process is its only consumer (`apps/desktop/src/main/commands/report.ts` defines the seven
`report.*` commands). The plans that built it, with the implementation history, are
[`../plans/archive/INDEX.md#reporting-a-difficult-agent`](../plans/archive/INDEX.md#reporting-a-difficult-agent). The request-capture tools are covered by
[`../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it`](../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it),
and the pane and the held conversation by [`../plans/archive/INDEX.md#the-debug-agent-as-a-conversation`](../plans/archive/INDEX.md#the-debug-agent-as-a-conversation).

## The privacy model

Three commitments follow, in descending order of visibility:

- **The analysis runs on the author's key rather than as a service.** The conversation stays on the author's machine. Only a report leaves it, the author reads that
  report first, and the report goes only where the author's own browser sends it.
- A redactor at the boundary rather than in a prompt (below) replaces names from the fiction deterministically, before any model sees them. The pseudonym map is held
  in memory only — never written to disk, never sent to the model, never in the report — so a filed issue cannot be de-anonymised.
- **The two optional forms of read access guarantee different things.** The thread and the app source may be quoted in the report, which is what they are for. The
  captured requests never are: the analyst sees structure and capped, redacted values through `list_requests` / `read_request`, and none of it is carried into
  `submit_report`. The detailed capture is exposed to a single party, the author's own model provider, which was already sent those bodies.

## The package

`packages/agentreport/` is a leaf beside the four shared ones (`export`, `scriptedit`, `bible`, `artgen`), but it has one host rather than two. It moves down only if
`vnauthor` gains the same command. It may import the input-side packages plus `@vn/commands` (`commands.jsonl` holds the acting record a transcript lacks) and
`@vn/providers`. The boundaries rule forbids `@vn/pipeline` and `@vn/scheduler`.

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

All but `analyze.ts` are pure functions and node-tested in `src/tests/`.

## Evidence

`assemble(thread, records, context)` joins the thread with `commands.jsonl` by time. The window runs from the thread's start to its last stamped line, not to now,
because a thread stays open while the author keeps working and those later acts are not the agent's. Acts the author performed by hand are deliberately included, because
what happened in the project while the conversation was open is the evidence. `apps/desktop/src/main/commandlog.ts` reads the log back, and `evidenceFor(paths, threadId,
context)` is the one seam that touches disk.

A thread recorded before the detailed format (tool args, results, untruncated text — the Stage 1 enrichment in the plan) is flagged `thin`. The report carries a line
saying the transcript predates the format, so a maintainer knows why the evidence is sparse.

Evidence comes from the display log and never from `<id>.native.jsonl`. A resume and the agent's own history tools read the native log, which holds the same conversation
at full length, including tool results that were never drawn, and none of it passes the redactor. A `compaction` line in the display log summarizes turns that are still
above it, so a report that reads the items reads what the summary covered rather than the summary. That is why the line is ignored, and why ignoring it is harmless.

`toMarkdown` fences tool args and output with a backtick run longer than any run in the text. Otherwise a report about an agent that mangled a markdown file would close
its own code block midway.

A thread also records the receipts its calls returned, and `toMarkdown` renders what the prompt cache did with them. It prints the counts per verdict, then names every
call the prefix broke on by step, together with what it cost to re-send. The section is left out entirely when no call carried a verdict, because a reader would take an
empty section to mean the cache never missed. [`docs/plans/recording-cache-misses-in-a-thread.md`](../plans/recording-cache-misses-in-a-thread.md) covers which backends
produce a verdict at all.

`redactEvidence` names `ThreadRecord`'s fields explicitly instead of spreading the record, so a field added later does not reach the model until someone adds it to that
list.

## Redaction is a boundary

The transcript, the author's note and tool results are all redacted before they reach the model, and every prose field of the reply is redacted again on the way out,
because an analyst that read source may recall a name the transcript never held. The sources come from the loaded `ProjectModel` (every character, location and scene id,
plus display names), the project title and root, and the OS username / home prefix. The following rules carry weight:

- **Longest match first.** `Titus Vale` is replaced whole rather than half-replaced by `Titus`.
- **An apostrophe is punctuation, not a letter** — `James's`, `James'` and the slip `Jame's` all name the same person. A live leak during the shipping pass found this
  case.
- **Boundary guards are per name and Unicode-aware.** `\b` is ASCII-only, so the guard applies to an edge only when that edge's own character is a letter in a spaced
  script. A single ideograph counts as a whole name.
- **Paths match through either separator and through JSON escaping** (`C:\\dev\\x` as stringified tool args). The project root is matched before the home directory.

`leaks(text)` is the same matcher used as a detector, and it gates the issue button.

## The analyst

Two paths differ in kind but produce the same `analysisSchema` shape, which one `render.ts` renders:

- **Without source** — makes one structured call through `chatBackendFor` + `withStructuredRetry` and runs no agent loop. Only the headless path does this. The
  conversational path always builds a loop, if only over `submit_report`, because a single structured call leaves nothing for the user to converse with.
- **With source** — runs the `@vn/authoring` loop with an injected registry of exactly four tools: `grep`, `read_file`, `fetch_api_docs`, and `submit_report`, whose
  validated args end the run. Plans are auto-approved (the registry holds nothing that could act on one) and a confirmation is refused rather than approved. Under
  `report.agent`, `ask_user` is answered with a fixed "nobody is here". In the pane a person is present, so the question parks the turn instead. If this path fails it
  falls back to the cheap path rather than erroring, and the report records `fellBack`, so `readSource` on a finished report means the analyst read source rather than
  that reading source was permitted. A run the author stopped returns a distinct stopped outcome and the fallback is not taken, because a stop must not spend another
  call.

`readSource` is set from the tool calls rather than from the offer. Each source tool is wrapped so that calling it records the fact, and a run that had the source and
never opened it has its `confidence` clamped to `low`. A run that was offered no source is not clamped, because there was nothing to open and the report rests on the
analyst's judgement of the transcript alone.

The analyst is also told what the agent under report could do, and tests the claims the author's account makes:

- **The reported agent's tools** come from the registry the reporting host built (`Agent.tools`, or the host's own default when no turn has run in this window), never
  from the `ALL_TOOLS` constant. `createRegistry` takes an `extra` argument, so the constant is not the tool list a host runs with. A recommendation that asks for
  something outside that list asks for a tool that does not exist, and the prompt states that.
- The author's statement is printed in the issue verbatim, under a heading that names it as the claim the analysis started from rather than one of its findings. The
  system prompt asks the analyst to check that statement and to write "the author reports X" wherever the evidence does not settle it.

The loop picks its backend with the same probe the desktop app and `vnauthor` use. It takes the native cached path if the model's backend implements `chatConversation`,
and the structured path otherwise. That choice matters most here, because the first user message is the whole transcript and every iteration re-reads it. This loop never
defers tools (`deferTools: false`). The catalog is six tools, so deferral would recover no context, and it would hide `submit_report` behind tool search, which ends the
run without a report.

The check runs at the point of use and names the env var or file, never the value, exactly as `resolveKeys` does everywhere else.

### What source it may read

The install ships full source unpacked, at `<resourcesPath>/source` (an `extraResource`, not inside `app.asar`, because the read tools use plain `fs`). `sourcemap.ts`
declares the readable set as a manifest: `READABLE` names `packages`, `apps`, `docs`, `scripts`, `CLAUDE.md` and `package.json`; `DENY` removes `node_modules`, build
output, `.git`, `keys` and the minified vendor blobs. `scripts/package.desktop.mjs` copies that same manifest into the image: it bundles `sourcemap.ts` and walks
`READABLE` through the same `denied` and `textFile` predicates the tools use, rather than restating the list, because a packaging manifest that disagreed would turn an
honest refusal into "no such file". `pnpm smoke` asks the built binary whether `sourceRoot()` answers, so a `to:` renamed on one side fails at package time rather than
in a report months later. `docs/` and `CLAUDE.md` are the highest-value entries: they state the invariants in prose, so a report can cite the contract that was broken
rather than paraphrase code. Three refusals matter. `keys/**` is refused by name and before the generic sentence. Symlinks are refused by `lstat` in both the walk and
the read. `fetch_api_docs` takes a provider and topic rather than a URL, checked against a fixed allow-list, because an agent that has just read a private manuscript
must not hold an exfiltration channel.

Every tool in a run shares one `Budget` (steps, input tokens, and a byte budget across all reads). Truncation is reported to the model, because a cap silently read as
"no matches" produces a confidently wrong report.

### The request-capture tools

When the author also enables access to requests, the analyst gets `list_requests` and `read_request` over a frozen `captureSnapshot()` of `@vn/providers`' in-memory
ring. The snapshot is frozen because a live ring could evict the entry the analysis was opened to read. The default answer is a structural outline rather than content. A
path read returns one node's values, decoded, redacted and capped at 2,000 characters, and base64 blocks are refused by kind. The analyst runs with `{ record: false }`,
so its own calls do not enter the ring it is reading.

A run with the request tools and no source runs the same loop, so it makes the same backend probe and defers no tool either. `record: false` is honoured on the cached
path (`createAnthropicChat` threads the flag into `chatConversation`'s capture), so taking that path does not put the analyst's own prompts back in the ring. That cost
is deliberate, because a failing request from the analyst itself is the one fault class the request-diagnosis tools cannot see.

## The setup, and the conversation

Help ▸ Report a Difficult Agent… opens the Debug Agent pane, whose first card holds the fields the command dialog used to collect: the thread, the model, the effort, and
the two reading boxes. The card seeds the newest thread (not the "active" one, which is usually empty), the bound model, and the bound effort stepped up to at least
`medium` for this run only — nothing rebinds the conversation's own settings. Model and effort advice comes from `apps/desktop/src/shared/advice.ts` (`adviseModel` /
`adviseEffort` / `adviseRun`), and the card shows that advice on its own line. Pressing Start runs the report, and the advice line states what the run will cost.

`report.open` and `report.agent` are checked non-mutators. A check guards an act that costs something, and this act spends a minute of a real model's time on a real key.
Both refuse through `previewReport`, so the Start button and the headless form show the same sentences. They report mock providers first (a mock backend would fabricate
a diagnosis), then no conversations recorded, an unknown thread, no key for the chosen model (naming the vendor), and `source` ticked on a build that did not ship its
source.

Past the card the work is a conversation rather than a single call. The author answers, sends more, and gets a revised report card whenever the analyst files one. Each
turn is bounded by the same per-turn token ceiling and step cap that a headless analysis uses. The conversation itself is unbounded, because the author is at the
keyboard and the spend is on their own key. Stop ends the turn after the step it is on, because `Agent.stop()` is read at the top of each step and no backend streams. A
stopped run returns a stopped outcome, so the single-call fallback is not taken, since a stop must not spend another call. The conversational path always runs a loop,
even when the loop covers only `submit_report`, because an author cannot converse with a single structured call. The cheap unlooped path remains available under
`report.agent`.

Both reading permissions can also be granted part way through, with `report.grant`. `run` builds its tool catalog once per turn, so a grant takes effect on the next turn
and its box says so. Granting is one-way, because tools already used stay in the transcript. Everything the analyst says is redacted before it reaches the pane, by the
same `Redactor` that scans the report: a chat that shows "Yuki" beside a report that shows "Character A" reads as a bug, and one rule is easier to keep than two.

`LOOP_PROTOCOL`'s "call `submit_report` exactly once" is kept verbatim for `report.agent`. On the conversational path it is replaced with an instruction to file a report
before finishing any turn it has concluded in, and to file a revised one whenever the author's next message changes the conclusion. `unattended()`'s "nobody is here to
answer" is likewise kept only for the headless path. In the pane, an `ask_user` parks the turn and puts the question in the transcript.

The conversation is written down at `<userConfigDir>/debug-transcripts/`, outside every repository, one versioned JSON object per line. Ten are kept, and a new
conversation prunes the oldest as it starts, so a crashed run cannot leave an eleventh. A line comes from the same reducer the pane draws with. A tool's result is never
written; the request captures in particular are the author's own traffic. The thread is named there by id and a filed report is written without its archive path, because
neither the thread's name nor the archive path has been through the redactor. The pane itself is in [`desktop-app.md`](desktop-app.md) under Debug Agent.

## Review, then the issue

The finished report is written outside the project, to the app's `userData/reports/<stamp>.md`. A bug report is about the app rather than the story, and a redacted
transcript is not something to commit on the author's behalf. The preview dialog is editable, and its Open GitHub Issue… button is gated by `report.openIssue`'s `check`,
which runs `redactor.leaks(body)` on every keystroke and refuses by name (`"Riva Kestrel" is still in the report`) until the author has edited the name out. The check
uses the same redactor the analysis ran with, because a fresh one would scan for different pseudonyms.

Opening the browser opens a form on `github.com/joeedh/visualnovel/issues/new` that has not been submitted. (`ISSUE_REPO` is a build-time constant rather than the git
remote, because a packaged app has no checkout and a fork's remote points at the fork.) The URL is asserted (`origin` and exact pathname) before `shell.openExternal`,
because the body is agent-authored text. The report is not carried on the URL: the whole of it goes on the clipboard, and the form is prefilled with `PASTE_BODY`, so a
long conversation and a short one both ask the author for the same single action. The preview stays open after the browser launches, because nothing has been posted yet
and closing the preview would remove the only copy of the report while the author is reading it over.

## Deliberately absent

- **Posting the issue.** The issue is posted when the author presses Create, and by no other action.
- **Any upload path outside the author's own browser.** There is no telemetry, no service, and no key of ours.
- **Restoring `Agent.messages` on reopen** — The report works from the transcript and the act log.
- **Reporting from `vnauthor`.** Reporting has one host. The package moves down if the number of hosts changes.

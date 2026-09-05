# `vnauthor` — the authoring agent

Helps an author write and refine the inputs the pipeline consumes, working plan-first and
backed by git. It does not run the generative pipeline; it stops at well-formed, validated
input files in a clean commit. The design is in
[`../history/authoring-agent-report.md`](../history/authoring-agent-report.md) and the
plan is in
[`../plans/archive/INDEX.md#authoring-agent-implementation`](../plans/archive/INDEX.md#authoring-agent-implementation).

<!-- toc -->

- [Running it](#running-it)
- [How it works](#how-it-works)
- [Tools](#tools)
    - [Generation graphs](#generation-graphs)
    - [Concept images](#concept-images)
    - [Revising planned art](#revising-planned-art)
    - [Approving art on the author's say-so](#approving-art-on-the-authors-say-so)
- [The archive](#the-archive)
- [Skills](#skills)

<!-- tocstop -->

## Running it

```
vnauthor [dir] [--mock] [--no-native]
```

- `--mock` runs offline with no model. It is a read-only smoke test that exercises
  workspace/skill loading and the REPL without API keys.
- `--no-native` forces structured ReAct (Path A). Provider-native function-calling (Path
  B) is the default when the configured backend offers `chatConversation`. A backend that
  does not offer `chatConversation` uses Path A.
- Model and keys resolve exactly as they do in `vngen`. The model comes from `models.text`
  in `project.yaml`, and the key comes from an env var or from a secret file under
  `<dir>/keys/` (falling back to a shared `keys/` at the enclosing repo root).

REPL commands: `/help`, `/mode` (plan vs. execute), `/model [id]` (switch the text model;
no arg → interactive menu), `/effort [level]` (set reasoning — `low`…`max` map to
Anthropic `output_config.effort` + adaptive thinking, `no thinking` sends
`thinking: disabled`, and the menu lists only the levels the model supports; the level
starts at `low` and is ignored on models that have no such setting; no arg → interactive
menu), `/clear` (reset the conversation context and return to plan mode), `/status` (show
the project index), `/skills` (list the available skills), `/makeimage <what to draw>`
(generate a concept image directly — see [Concept images](#concept-images)),
`/upload <file…>` (archive documents and ask what to do with them — see
[The archive](#the-archive)), `/exit` (or `/quit`). **Shift-Tab** cycles between plan and
execute mode. `/model` and `/effort` rebuild the backend and hot-swap it into the running
agent, preserving conversation state.

The REPL keeps no transcript. A conversation exists only while the process runs, and
`/clear` ends it without writing anything to disk. The desktop app writes two files per
conversation. It writes the turns as they are drawn to `vngen/state/threads/<id>.jsonl`,
and it writes the model's own messages to `<id>.native.jsonl`, which its Continue button
reads to resume a conversation (see [`desktop-app.md`](desktop-app.md)). The REPL could
write either file but writes neither yet, so a conversation here cannot be continued after
`/exit`, and the two `search_history` and `read_history` tools the desktop registers are
absent here.

Offline smoke test:

```sh
pnpm build
printf '/skills\n/status\n/exit\n' | node apps/authoring/dist/vnauthor.js templates/basic --mock
```

[`../../templates/basic/AICONTEXT.md`](../../templates/basic/AICONTEXT.md) shows the
project guidance that the agent follows.

## How it works

- **Two-mode state machine (`@vn/authoring` `loop.ts`).** The agent starts in plan mode,
  which is read-only: only non-mutating tools dispatch, and mutating tools are blocked
  until the user approves a proposed plan. Approving a plan switches to execute mode,
  where edits apply, `validate_inputs` runs, and `git_commit` is blocked while
  error-severity diagnostics remain (soft and style issues only warn). Each approved plan
  produces one commit.
- **A turn is bounded by the tokens it spends, not by the number of steps it takes.**
  `BUDGET_CHOICES` (50k…5m, `unlimited`; default 200k) is a per-turn ceiling on non-cached
  tokens, and is set beside `effort` in the convo bar and by `agent.setBudget`. The loop
  checks the meter between steps, as it does for `stop()`, because the API refuses to
  continue a transcript that never answers a `tool_use`. At 80% of the ceiling the loop
  appends a `{"role":"system"}` message telling the agent to stop starting work and land
  what it has. When the budget runs out, the loop emits a final message naming the spend,
  the ceiling and what was written since the last commit. `MAX_ITERATIONS` stays in place
  as a runaway backstop rather than a policy (a backend that reports no usage spends
  nothing against any budget), so `unlimited` means an unlimited budget, not an unbounded
  loop.
- **The author decides what happens after a failed call to the model, and is asked once
  per grant.** When `backend.next` throws, the loop asks its host (`onApiError`) what to
  do and offers three answers: retry automatically up to ten times, switch to another
  model and try again, or stop. Both hosts ask the same question through the same
  shortlist mechanism — the desktop shows an ask card and `vnauthor` shows a numbered list
  — because the wording lives in `@vn/authoring`'s `apierror.ts` rather than in either of
  them. The answer is a grant: "retry ten times" is one decision that allows ten attempts
  rather than ten cards, and the host is asked again only when the grant runs out. After a
  grant is spent, a second failure stops the loop rather than asking again, and the
  transcript is intact, so re-sending takes one keystroke.
    - **The loop contains no model-specific code.** `ApiRecovery` has no `switch` case; a
      host that switches to a different provider swaps the backend (`Agent.setBackend`, or
      `session.setModel`) and then answers `retry`, because every attempt re-reads the
      field.
    - **Waits as long as the provider asks whenever it names a wait.** `@vn/providers`
      reads `retry-after` (seconds or an HTTP-date) off the response and carries it on
      `RetryableProviderError`. If the provider names no wait, the wait doubles from a
      second and stops at a minute. The wait carries no jitter, because jitter
      de-synchronises a fleet and only one conversation runs here.
    - **Shows progress and reports its end.** The desktop header shows `⟳ retry n/of`
      while the retries run, and clears it as soon as the turn ends either way. A
      notification states whether the model responded or the retries were given up.
      `vnauthor` prints the same three lines inline.
- **Always-confirm.** `git_revert`/`git_restore` and the first run of a script-bearing
  skill route through the permission gate regardless of mode.
- **A shortlist question is a separate tool that reaches the same permission call.**
  `ask_choice` sits beside `ask_user` in `CONTROL_TOOLS` under a distinct name, because it
  corrects a model asking an open question when the sensible answers can be listed. Both
  reach one `Permission.ask(form)`. The shortlist changes how the question is presented,
  not what comes back: the answer is a string either way, the author may always type past
  the list, and the observation reads `User answered: …` regardless, so the model has to
  read the answer rather than pattern-match a click. A shortlist of fewer than two entries
  is refused, because it asks a leading question. In the terminal the list is numbered,
  and anything that is not a run of valid numbers is taken as the author's own words.
- **One shape covers a single question and a multi-question form.** `Permission.ask` takes
  an array of `AskQuestion` and returns one answer per question, positionally, so
  `ask_user`, a lone `ask_choice` and a `{questions: […]}` form all use that one shape,
  and a single question draws and reads exactly as it did before forms existed.
  `ask_choice` accepts at most `MAX_ASK_QUESTIONS` (4) questions at once, because more
  than that is an interview rather than a question. A question inside a form may omit its
  `choices`, and the author answers it in their own words; that same question on its own
  is `ask_user`. A form is one parked turn, so asking the listed questions here and the
  open one separately would spend a second turn without learning anything extra. The model
  reads the answers back numbered against the questions, because `ok, ok` says nothing on
  its own, and an unanswered question reads `(no answer)`.
- **A host that miscounts must not hang a parked turn.** `answersFor` pads a short reply
  and drops a long one, and neither case throws, because the model reads these as prose
  and takes a missing answer as "nothing". This padding and dropping is what lets the
  terminal present a form one question at a time (it has no Back button, so the numbering
  is all it can offer) while the desktop card pages through the same form, and neither
  host has to do the arithmetic.
- **Agent backend seam, and Path B is the default.** The loop targets an internal
  `AgentBackend`; `StructuredAgentBackend` (Path A) drives tools as zod-validated JSON
  over the text seam, `NativeAgentBackend` (Path B) drives them through the vendor tool
  protocol. The loop validates tool args, so Path B advertises permissive tool params and
  re-validates via the registry. The probe is `chatConversation`, deliberately not
  `chatWithTools`. Gemini implements `chatWithTools` for a request that is still one
  re-rendered string and therefore caches nothing, and Path B exists to fix requests that
  cannot be cached.
- **`buildConvoRequest` (`@vn/providers`) assembles the conversation into a request
  ordered for caching.** It lays out `tools` → `system` → `messages` and spends the API's
  four `cache_control` breakpoints on the last non-deferred tool, the system prompt, and
  the two newest message turns. That pair of message breakpoints rolls forward, so the
  cache written on one turn is read on the next. A breakpoint never lands on a `thinking`
  block, assistant blocks are echoed back verbatim (`AgentTurn.raw`), and the builder
  clones the caller's arrays rather than marking them in place.
- **Most tools are deferred, and the model searches for them.** `toolSpecs()` sends
  exactly six schemas up front — `propose_plan`, `ask_user`, `ask_choice`, `read_file`,
  `search`, `list_workspace` — and flags the rest `defer_loading`, alongside the
  server-side `tool_search_tool_bm25` tool. The rendered catalog is byte-identical for the
  life of a session, including across a mode change, because changing the tool list
  invalidates everything after it.
- **Changes made mid-conversation appear in the transcript and are never edited into the
  prefix.** The mode and any `AICONTEXT.md` section that has been superseded or withdrawn
  are appended as `{"role":"system"}` messages, filed only on change (`Agent.filedMode`),
  so restating a mode the conversation is already in costs nothing. On a model without the
  system role the builder down-renders those turns to user turns at request time, so a
  mid-session `/model` switch leaves a conversation that can still be sent.
- **Context precedence:** built-in input contract > `AICONTEXT.md` (+ nested per-dir files
  and `@import` lines; `AGENTS.md`/`CLAUDE.md` as fallbacks) > `AICONTEXT.generated.md`
  (the project map) > inferred defaults. `update_context` writes a chat instruction as a
  durable line in `AICONTEXT.md`; `regenerate_context` rebuilds the map. The map states
  facts and `AICONTEXT.md` states policy, so `AICONTEXT.md` takes precedence. The two are
  separately labelled sections of the system message, and a file at the generated path
  without the generator's banner is ignored rather than trusted. The desktop host keeps
  the map current without walking the project every turn. It marks the map stale at the
  start of a session (so the first turn covers opening a workspace that has never had one
  written) and marks it stale again whenever a finished turn wrote under `characters/`,
  `locations/`, `scenes/` or `wiki/`, the four directories the map is derived from.
  Rebuilding it is best-effort and never throws: a map that could not be regenerated
  degrades the prompt but does not fail the turn.
- **Every file the agent wrote is committed.** The loop unions `git_commit`'s `paths`
  argument with the paths the tools reported writing rather than letting the argument
  replace them. The tool record is complete and the model's recollection is not: an
  `AICONTEXT.md` that the agent updated and then forgot about went uncommitted. A path
  named in the argument is still honoured.
- **Round-trip safety.** Edits go through `@vn/model`'s `*ToDoc` / `applyCharacterEdit` /
  `applyLocationEdit` serializers (`fromDoc(toDoc(x)) ≡ x`), rewriting only changed
  front-matter so untouched prose and branch markers are preserved.
- \*\*The ag

## Tools

`packages/authoring/src/tools.ts` holds the registry of 49 tools. **M** marks
`mutating: true` (plan mode blocks it); **C** marks `confirm: true` (it always goes
through the permission gate, in every mode).

| Group               | Tools                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Read & search       | `read_file`, `list_workspace`, `search`, `search_bible`, `list_archive`                                                           |
| Domain & validation | `validate_inputs`, `parse_fountain`, `story_graph`, `extract_entities`                                                            |
| Entity editing      | `create_character` **M**, `create_location` **M**, `edit_character` **M**, `edit_location` **M**                                  |
| Scene prose         | `edit_scene` **M**                                                                                                                |
| Branch wiring       | `edit_branches` **M**                                                                                                             |
| Wardrobe            | `set_outfit` **M**, `set_variant` **M**                                                                                           |
| Storyboards         | `read_shots`, `set_coverage` **M**, `propose_storyboard` (costs a model call, writes nothing), `write_storyboard` **M**           |
| Art (concepts)      | `list_images`, `generate_image` **M C**, `edit_image` **M C**                                                                     |
| Art (planned)       | `list_assets`, `art_notes`, `view_image`, `set_art_notes` **M**, `regenerate_asset` **M C**                                       |
| Approval            | `approve_assets` **M**, `unapprove_assets` **M** (each confirms its own list)                                                     |
| Generation graphs   | `read_asset_graph`, `edit_asset_graph` **M**, `run_asset_graph` **M** (confirms a priced run)                                     |
| Raw write           | `write_file` **M**, `edit_file` **M** (neither for `scenes/` or `.aiagent/skills/`)                                               |
| Context             | `update_context` **M**, `regenerate_context` **M**                                                                                |
| Git (read)          | `git_status`, `git_log`, `git_show`, `git_diff`                                                                                   |
| Git (write)         | `git_commit` **M**, `git_init` **M**, `git_revert` **M C**, `git_restore` **M C**                                                 |
| Skills              | `discover_skills`, `create_skill` **M**, `edit_skill` **M**, `run_skill` **M** (**C** on the first run of a script-bearing skill) |

`edit_file` changes part of a long document rather than restating the whole file. It
replaces exact strings and writes through the same `writeDocFile` the Wiki pane saves
through, so both refuse bad front-matter the same way. It rests on a read ledger,
`ToolContext.seen`, which the loop owns and clears with the conversation. The ledger
records what each `read_file` showed and the hash it showed it at. An edit to a file this
conversation never read is refused, and so is an edit to a file that moved since. Every
hunk is applied in memory and the file is written once, so a refusal part-way through
leaves the bytes exactly as the model last read them. It partly overlaps the escape hatch
and is not a way around the typed tools: an edit to a `scenes/`, `characters/` or
`locations/` path is refused by name.

Editing an entity is typed rather than done with `edit_file`:
`edit_character`/`edit_location` route through `@vn/model`'s serializers, so the
round-trip guarantee holds by construction. Both edit tools patch the sheet the workspace
index actually loaded (a character tagged `type: character` under `wiki/` is edited where
it lives, not at the conventional path). The `create_*` tools do write to the conventional
directory, because that is where a sheet that does not exist yet goes. A create tool takes
the whole sheet: its arguments are the edit tool's arguments minus `id`, which is slugged
from the name, and they route through the same `applyCharacterEdit`/`applyLocationEdit`. A
created sheet is therefore validated by exactly what would have validated an edited one,
and a character does not have to be created and then immediately edited. Given no fields
at all, `create_character` still writes the template. It also reports which of the three
cases it wrote, because a sheet of placeholders and a sheet with an empty body are
different things to whoever draws from it next.

Three things stay out of the model's hands. The first is scene prose: `write_file` and
`edit_file` both refuse a `scenes/` path outright and name `edit_scene` instead, because a
chunk written whole carries no check on its contents, and nothing downstream would notice
duplicate line ids, a lost heading, a scene id that stopped matching its filename, or
stranded storyboards. The second is `.aiagent/skills/`, which `create_skill` and
`edit_skill` own for the same reason in reverse: those two write prose, and a raw write
that could reach the directory would put a `run.mjs` there (or rewrite the one already
sitting beside a skill) that `run_skill` then offers to execute behind a confirm card that
reads identically whether a human vetted the file last year or the agent wrote it ninety
seconds ago. Third, the model cannot change its own mode, because there is no
`enter_plan_mode`/`exit_plan_mode` tool. The REPL and the permission gate own the mode,
which makes plan mode a guarantee rather than a request.

`set_outfit` is one tool for both levels of the outfit chain, because the author phrases
the change the same way at either level: "put Aiko in her tracksuit for the club scene"
and "…for this one frame" differ by a word, and which file the change lands in follows
from that word rather than being a choice the author makes. The `shot` argument picks the
level. Without it, a `[[outfit:]]` marker is spliced into the scene chunk. With it, the
subject's override is written to `work/shots/<sceneId>.json`, which re-hashes that shot.
`outfit=""` clears the setting at either level, and the level below then applies. The
wardrobe itself is authored on the character sheet (`edit_character`'s `outfits` /
`defaultOutfit`), so `set_outfit` accepts only the outfits the sheet declares.

### Generation graphs

A generation graph is the node network used to draw a picture, stored at
`vngen/work/graphs/<slug>.json`. Three tools reach a generation graph. Those tools and the
`gengraph.*` commands make the same decisions because the tools import `@vn/gengraph`
rather than invoking the registry. `edit_scene` has the same arrangement with `story.*`.
The graphs themselves, the node types, the journal and the commands are described in
[`gen-graphs.md`](gen-graphs.md).

- **A graph is read and written whole, and diffed by node id.** `read_asset_graph` returns
  every node with its type and authored values plus every link, and omits where the nodes
  sit on the canvas, so writing a graph back never moves the nodes the author arranged.
  `edit_asset_graph` accepts that same description. A node kept under the id it had keeps
  its position and its journal record, and a node left out is removed. A group instance
  reads as `type: "GroupNode"` with `group: <ref>` naming its definition under
  `work/graphs/lib/`, and writes back the same way, so a rewrite keeps the instances a
  graph held. The definitions themselves are edited by hand in the Gen Graph pane, not
  through this tool.
- **A description that will not build is refused, and every problem is reported.** The
  file is left exactly as it was, and the report lists every problem rather than the first
  one, so the model can repair a description it wrote in one round trip. A graph that
  builds but is still incomplete is written and its remaining diagnostics are reported,
  because saving a half-built graph is normal.
- **Only the run needs a host.** Reading and editing go straight to the files through
  `@vn/gengraph/state`, so both work wherever the project is opened. `run_asset_graph`
  goes through `ToolContext.graphs`, which the host that owns the executor and the image
  backend wires up. If nothing wired it, the call refuses and names the desktop app.
- **A run is quoted before it is confirmed.** The estimate comes back in the sentence that
  `estimateSentence` builds, and the desktop's confirmation shows that same sentence, so
  an author reads the same figure in both places. The card goes through `ctx.confirm`
  rather than `confirm: true`, because the generic prompt shows a tool name and its
  arguments and has no place for a price.
- **A run does not fill a slot.** It writes journal records and blobs, and a picture is
  added to the asset store only when a planned task names the graph.

### Concept images

`generate_image` and `/makeimage` are two ways to reach the same operation. Each takes a
sentence, returns a picture, and adds no task to the graph. Both run `@vn/artgen`'s
`generateConcept`, which is also what the desktop's `art.generate` runs.

- **The agent core never constructs a provider.** `ToolContext.art` is an `ArtGen` "seam"
  (an injection point) exposing `generate`, `preview`, `redraw`, `list` and `describe`,
  and the host wires it, because the host knows whether this run is `--mock` and where the
  keys are. A bare context has no `art`, and the tool refuses rather than assuming an API
  key exists to spend. `confirm` works the same way: the core decides what to do, and the
  host decides whether it happens.
- **Costs money.** Sets `confirm: true`, because each generation bills one image. Every
  generation goes through the permission gate in every mode, exactly like `git_revert`.
- **`/makeimage` does not take a turn through the model.** A one-line request costs one
  generation and no tokens, so the REPL calls the seam directly. It still obeys plan mode,
  and in plan mode it prints the resolved subject and the composed prompt before anything
  is spent.
- **The subject is matched from the sentence, or named explicitly.** `location:<id>` and
  `character:<id>` override the match. A tie resolves to the location, since a place is
  what the request asks for and a character already has a portrait pipeline. Existing
  plates of that location (or the approved portrait) are fed back as references, so "an
  aerial shot of the high school" is a shot of that same high school.
- **A concept stays a sketch.** The pipeline never plans a concept, no scene renders a
  concept, and `vngen export` ignores it. `art.promote` turns a concept into a real
  location plate. It is a separate, human decision, and the agent deliberately does not
  have it as a tool.
- **A concept is the one asset the agent can edit, because it is the one whose prompt is
  authored.** Every other prompt is derived on each planning pass and folded into a task
  hash, so the agent changes those prompts through art notes (`set_art_notes`, below) and
  the pipeline re-renders. No builder generates a concept: `edit_image` redraws one from a
  rewritten prompt and files the result as a new sketch, leaving the original in place. It
  sets `confirm: true` for the same reason `generate_image` does, because it renders one
  billed image.
- **`list_images` prints the available concepts.** It is the only non-mutating art tool,
  and it prints every concept with its short hash, name, subject and prompt. A hash is
  hard to remember, so `edit_image` accepts a hash prefix, and it refuses an unknown or
  ambiguous prefix by name rather than guessing which picture the author meant.

### Revising planned art

The pipeline does not edit a picture it planned; it draws that picture again from a new
direction. The prompt is derived on every planning pass, so the durable thing an author
changes is the art note behind it. The five tools carry out that loop by showing what
exists, reading how it was directed, changing the direction, drawing it again, and showing
what came back:

```
list_assets(subject='location:cafe')          → the plates bound to that location, by short hash
art_notes(hash=…)                             → every rung above that picture, and what each says
  …propose, and have the plan approved…
set_art_notes(target='location:cafe' notes='…brutalist concrete…')
regenerate_asset(hash=… run=true)             (confirm)
view_image(hash=…)                            → what actually came back
  …propose the next note…
```

- **`set_art_notes` appends by default.** The agent is adding a correction to what the
  author already wrote, not replacing an authorial paragraph it never read.
  `mode='replace'` and `mode='clear'` are available, and their names state what they do.
  The tool calls `@vn/artgen`'s `setArtNotes`, so the agent gets the same five rungs and
  the same refusals as the desktop's `art.setNotes`. One of those refusals is that a note
  never invents the outfit, variant or shot it names. `set_art_notes` is **M** but not
  **C**: a note costs nothing, and the write is a plain undoable edit.
- **`regenerate_asset` is gated on a capability.** `@vn/authoring` may not import
  `@vn/pipeline` or `@vn/scheduler`, so re-rendering is injected as
  `ToolContext.pipeline`, which exposes `regenerate` and `run`, the only calls an agent
  needs. In `vnauthor`'s REPL the injection is absent, and the tool refuses and names the
  host that can regenerate the asset. In the desktop app the injected pipeline makes the
  same two calls `asset.regenerate` makes, so an agent-started run takes the busy flag a
  pipeline run takes.
- **The setting is `confirm: true`, and the card keeps queueing separate from paying.**
  `run=false` puts the task back to `pending` and draws nothing; `run=true` shows "one
  image generation" on the card, because clicking the card spends one image generation.
- **`view_image` reads the rendered image back, which makes the process a loop rather than
  a single attempt.** It sends the bytes to the vision backend with a question and prints
  the answer, so the agent proposes the next note against the picture that exists instead
  of against its own prompt. Like the concept tools, it needs `ToolContext.art` and
  refuses without it.
- Every one of them takes a hash prefix. The prefix resolves against the manifest before a
  capability is called, and an unknown or ambiguous prefix is refused by name, so a typo
  costs nothing.

`regenerate_context` writes the project map, `AICONTEXT.generated.md`: the cast with each
sheet's path and wardrobe, the locations and their variants, the story graph, and the
story bible's table of contents, which gives one line per note with its path, title and
headings. The file maps the project rather than reproducing it: no line of what any file
_says_ appears in it, which keeps it affordable and keeps the bible reached by query. The
table of contents turns a blind `search_bible` into an aimed one, because the agent can
see that wiki/history/the-war.md has a Casualties heading before it queries. The file is
budgeted (8000 characters, spent cast-first), and a section that could not print every row
says how many it dropped and which tool answers the rest. The desktop exposes the same
operation as `workspace.reindex`.

The map is a snapshot, and it is labeled as such. Both hosts recompose the system message
per turn (`Agent.setSystem`, beside `setBackend`), so an agent still running after the
file is rewritten (by its own `regenerate_context`, or by the desktop's
`workspace.reindex`) no longer reproduces the version it was built with. The header names
`list_workspace` as the source for the current state, because nothing re-reads the map
between turns, and a stale list that looks authoritative is worse than no list.

`list_workspace` names the file every row was found in, and for a location with no sheet
it reports that the location was mined from the screenplay. Locations are merged by the
slug `parseHeading` derives, so authoring a sheet for a place the script already mentions
converts a row instead of adding one. Without the path, the output before the change and
the output after it are the same two lines.

The host's focus is sent as a message rather than a system line.
`Agent.run(input, focus?)` files the host's `focus` as a `context` message ahead of the
user's message. `context` is a fourth `AgentMessage.role`, which `renderTranscript`
upper-cases to `CONTEXT:`, so both backends carry it unchanged. The focus is a message
because it was true at one turn and not at the others, and the system message is
recomposed per turn, so placing the focus there would let the last selection rewrite every
earlier one. `focusOnScene` builds the sentence from the live `WorkspaceIndex` and returns
`undefined` for an id that nothing matches, so a stale selection produces no context
message rather than naming a scene that is gone. The REPL passes no focus and reads
exactly as it did before.

`search` and `search_bible` are separate on purpose. The authored input files are a
bounded set, so `search` scans all of them and does not rank the results. `wiki/` is
unbounded, so `search_bible` ranks its results and caps them at a character budget; no
tool returns a bible file whole. `list_workspace` reports the bible only as a file count,
so the agent learns a bible exists without reading any of its files. See
[`story-bible.md`](story-bible.md).

### Approving art on the author's say-so

`approve_assets` takes its authority from the author's own words rather than from the
agent's argument for them, because everything downstream is drawn from approval and a run
continues once the gate clears. It is built so that one specific mistake cannot happen:
the agent cannot decide mid-turn, for reasons of its own, that the author would want all
of this approved. Three checks run in order, and each one can only narrow what the check
before it allowed:

- **The project defines the approvable list, not the model.** The host enumerates what is
  approvable right now through `ToolContext.approval`. The desktop app wires that field to
  the same walk the document tree's _Awaiting approval_ group projects, upstream first. An
  asset outside that list cannot be approved, whatever name it is given. As with
  `regenerate_asset`, `vnauthor`'s REPL provides no such host, so the tool refuses and
  names the host that does provide one.
- **A small model reads what the author actually typed.** The triage prompt carries the
  author's own recent turns (`SAID_WINDOW`, six) and the list, and nothing the assistant
  said, with the rule spelt out that being asked is not evidence. The model answers two
  questions at once, because they are a single question: whether the author asked, and
  which entry in the list they meant. Code narrows the answer again, because a
  hallucinated hash that happens to match an entry would be an approval nobody asked for.
  The model is fixed at `TRIAGE_MODEL` rather than following the model the conversation
  uses, because this is a check on the agent, and running it on the model being checked is
  not a check. A mocked session has no model, so `offlineTriage` stands in and reports in
  its own words that it matched text without one.
- **The author confirms the final list.** The list names every picture, states what
  approving it would do, and gives the triage model's sentence for why that picture is on
  the list at all. An author can consent only to a list that accounts for where its
  entries came from, not to ten bare hashes.

The tool takes no arguments, and that is deliberate rather than an oversight: an argument
is something the agent fills in, and here there is nothing for it to supply. Work blocked
upstream is shown to the triage model and held back after the model has seen it, listed
under its own heading with a sentence saying what it is waiting on. Filtering it out
beforehand would make “approve everything” mean “approve some of it”. What survives is
approved in the order the host listed it, which is upstream first, so one call can approve
a plate and the frame drawn from it.

`unapprove_assets` runs the same three checks in the other direction. The host lists what
is approved rather than what is approvable, the triage model gets its own rule sheet keyed
on the words that ask for approval to come back off, and the card names what each picture
stops being. Two details differ. The order is reversed, taking downstream assets first, so
a frame stops being accepted before the plate it was drawn from does, and nothing is left
approved over an un-approved reference partway through. The offline stand-in matches the
un-approve words by their own pattern first, because "un-approve it" contains the string a
naive approve matcher reads as consent. Neither direction touches the bytes, so the same
take can be approved again.

## The archive

An author's own documents (a worldbuilding dump, a cast list, an outline someone else
wrote) come in through `/upload <file…>` in the REPL, or through "Upload Files…" in the
desktop app. Both run `archiveUpload` in `packages/authoring/src/archive.ts`, so there is
one archive and one layout. The plan is
[`../plans/archive/INDEX.md#upload-and-archive`](../plans/archive/INDEX.md#upload-and-archive).

- **The originals are copied verbatim to
  `archive/<yyyymmdd-hhmmss>-<slug>/<original filename>`**, one directory per batch, at
  the project root. The archive directory is not under `wiki/` and not under `vngen/`.
  Files under `wiki/` are retrievable and files under `vngen/` are generated output, and
  an uploaded document is neither.
- **No sweep reaches the archive, and excluding it takes no code.** `search` walks an
  allow-list (`characters/ locations/ scenes/ screenplay/` plus `AICONTEXT.md` and
  `project.yaml`), entity discovery walks `characters/ locations/ wiki/**`, and the bible
  reads `wiki/`, so none of them reach a top-level `archive/`. Those allow-lists are the
  entire "not indexable or searchable" policy, and the policy holds as long as nothing
  adds `archive` to them.
- **An archived note is readable when the author names it.** `read_file` serves any
  workspace path, so an archived note is read on request and never by accident.
  `list_archive` prints the batches and their files, so the agent can see what arrived
  without walking the directory, which the agent is not allowed to do.
- **Uploads are refused before anything is copied.** An upload is refused if the file is
  already inside the workspace, if the path is not a regular file, if the file is over 25
  MB, or if a second file in the same batch has a name already taken. A batch in which
  every file was refused writes no directory at all.
- **A format with no converter is archived and reported as such.** `.docx`, `.odt`, `.zip`
  and the rest are copied unchanged and reported as "archived, not yet readable: no
  converter for …". Copying preserves the bytes, and the converter that writes a text
  sidecar beside the original is a later step that needs no change to this layout.
  `readable` means what `read_file` serves today: strict UTF-8, under its own size bound.
- **Uploading ends in plan mode with a question rather than an edit.** The REPL prints the
  batch and a short numbered list of ways to phrase the next prompt; the desktop opens a
  fresh conversation on the same sentence and shows the same openers as chips. The
  suggestions are built from the file list alone (count, extensions, whether names look
  like scenes) and never from the contents, because reading them to propose a sentence the
  author will rewrite costs a model call for nothing.

## Skills

Reusable authoring playbooks live under `<dir>/.aiagent/skills/<id>/SKILL.md`, whose front
matter carries `name`, `description`, and `when-to-use`. A pure-prose skill returns its
body as guidance. A skill with a `run.{mjs,js,cjs,sh}` script runs a vetted command
instead, and every run is permissioned (always-confirm) before it executes in the
workspace root with the workspace path as its first argument. Three skills ship with the
sample. [`new-character`](../../templates/basic/.aiagent/skills/new-character) is a
playbook for one act. [`branching`](../../templates/basic/.aiagent/skills/branching)
covers the three shapes a fork can take, how to split a shared scene into per-route
chunks, and the refusal to hand back when the author asks for something that would need a
conditional. [`full-production`](../../templates/basic/.aiagent/skills/full-production)
runs nine phases from premise to storyboard, each with its own plan and its own commit,
and ends at the choice of how a scene gets its shots (batch decomposition, a proposal the
agent drafts, or by hand), which stays the author's.

The agent can write a skill, and it writes only prose. `create_skill` scaffolds
`.aiagent/skills/<id>/SKILL.md` from a name, a description, an optional "when to use" and
a body; `edit_skill` changes one field of an existing skill, carrying forward front-matter
it does not model (most importantly a `script:` a person added) and losing YAML comments,
because the file is re-emitted in canonical key order rather than spliced. Neither has a
`script` argument, and their schemas are `.strict()`, so passing one is a parse error
before the tool is entered; `write_file` refuses every path under `.aiagent/skills/` and
names those two instead. A script-bearing skill stays fully supported, but a person has to
add it, because `run_skill`'s confirm card names only the script to be run, and that card
reads the same whether the file was vetted a year ago or written ninety seconds ago.
`git_restore` and `git_revert` are deliberately not gated. Both are `confirm: true` and
their cards name the file, so a person approves the change to that named file.

`discover_skills` also reports a degraded skill rather than passing over it. It appends
`(!)` and states what is wrong when a skill has no description, no body, or a `script:`
naming a file that is not there. A missing script file is the dangerous case, because
`findScript` then falls through to the `run.mjs` scan and a different script runs under
that skill's name.

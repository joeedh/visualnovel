# `vnauthor` — the authoring agent

A plan-first, git-backed conversational agent that helps an author write and refine the inputs
the pipeline consumes. It does **not** run the generative pipeline — it stops at well-formed,
validated input files in a clean commit. Design:
[`authoring-agent-report.md`](authoring-agent-report.md); plan:
[`plans/authoring-agent-implementation.md`](plans/authoring-agent-implementation.md).

<!-- toc -->

- [Running it](#running-it)
- [How it works](#how-it-works)
- [Tools](#tools)
  * [Concept images](#concept-images)
  * [Revising planned art](#revising-planned-art)
  * [Approving art on the author's say-so](#approving-art-on-the-authors-say-so)
- [The archive](#the-archive)
- [Skills](#skills)

<!-- tocstop -->

## Running it

```
vnauthor [dir] [--mock] [--no-native]
```

- `--mock` runs offline with no model (read-only smoke test — exercises workspace/skill loading
  and the REPL without API keys).
- `--no-native` forces structured ReAct (Path A). Provider-native function-calling (Path B) is
  the default wherever the configured backend offers `chatConversation`; a backend without it falls
  back to Path A on its own.
- Model + keys resolve exactly like `vngen`: `models.text` in `project.yaml`, key via env var or
  a secret file under `<dir>/keys/` (falling back to a shared `keys/` at the enclosing repo
  root).

REPL commands: `/help`, `/mode` (plan vs. execute), `/model [id]` (switch the text model; no arg
→ interactive menu), `/effort [level]` (set reasoning — `low`…`max` map to Anthropic
`output_config.effort` + adaptive thinking, `no thinking` sends `thinking: disabled`, and the menu
offers only what the model takes; it starts at `low` and is ignored on models with no such knob;
no arg → interactive menu), `/clear` (reset the conversation context, back to plan mode), `/status`
(project index), `/skills` (available skills), `/makeimage <what to draw>` (a concept image,
directly — see [Concept images](#concept-images)), `/upload <file…>` (archive documents and ask
what to do with them — see [The archive](#the-archive)), `/exit` (or `/quit`). **Shift-Tab** cycles
between plan and execute mode. `/model` and `/effort` rebuild the backend and hot-swap it into
the running agent, preserving conversation state.

**The REPL keeps no transcript.** A conversation here lives as long as the process does, and
`/clear` ends it with nothing written down. The desktop app saves the same turns to
`vngen/state/threads/<id>.jsonl` (see [`desktop-app.md`](desktop-app.md)); nothing stops the REPL
from writing to the same place, and it does not yet.

Offline smoke test:

```sh
pnpm build
printf '/skills\n/status\n/exit\n' | node apps/authoring/dist/vnauthor.js templates/basic --mock
```

[`templates/basic/AICONTEXT.md`](../templates/basic/AICONTEXT.md) shows project guidance the
agent honors.

## How it works

- **Two-mode state machine (`@vn/authoring` `loop.ts`).** The agent starts in **plan mode
  (read-only)**: only non-mutating tools dispatch; any mutating tool is blocked until the user
  approves a proposed plan. Approving a plan switches to **execute mode**, where edits apply,
  `validate_inputs` runs, and `git_commit` is **blocked while error-severity diagnostics remain**
  (soft/style issues only warn). One commit per approved plan.
- **A turn is bounded by what it spends, not by how many steps it took.** `BUDGET_CHOICES`
  (50k…5m, `unlimited`; default 200k) is a **per-turn** ceiling on non-cached tokens, set beside
  `effort` in the convo bar and by `agent.setBudget`. The meter is checked **between** steps, like
  `stop()`, because a `tool_use` the transcript never answers is a request the API refuses to
  continue; at 80% the loop appends a `{"role":"system"}` message telling the agent to stop
  starting work and land what it has; running out emits a final naming the spend, the ceiling and
  what was written since the last commit. `MAX_ITERATIONS` survives as a runaway backstop rather
  than a policy — a backend that reports no usage spends nothing against any budget — so
  `unlimited` means an unlimited budget, not an unbounded loop.
- **A call to the model that failed is the author's decision, and it is asked once per grant.**
  When `backend.next` throws, the loop asks its host (`onApiError`) what to do and offers three
  answers: retry automatically up to ten times, switch to another model and try again, or stop.
  Both hosts put the same question through the same shortlist door — the desktop as an ask card,
  `vnauthor` as a numbered list — because the wording lives in `@vn/authoring`'s `apierror.ts`
  rather than in either of them. The answer is a **grant**: "retry ten times" is one decision that
  buys ten attempts, not ten cards, and the host is only asked again when the grant runs out. A
  second failure after a spent grant stops instead of asking twice — the transcript is intact, so
  re-sending is one keystroke.
  - **The loop still knows nothing about models.** `ApiRecovery` has no `switch` case; a host that
    wants a different provider swaps the backend (`Agent.setBackend`, or `session.setModel`) and
    then answers `retry`, because every attempt re-reads the field.
  - **The wait is the provider's where it named one.** `retry-after` — seconds or an HTTP-date —
    is read off the response in `@vn/providers` and carried on `RetryableProviderError`; absent, the
    wait doubles from a second and stops at a minute. No jitter: jitter de-synchronises a fleet, and
    there is one conversation here.
  - **Progress is visible and its end is reported.** The desktop header shows `⟳ retry n/of` while
    attempts are being spent and clears it the moment the turn moves on either way, and a
    notification says whether the model came back or was given up on. `vnauthor` prints the same
    three lines inline.
- **Always-confirm.** `git_revert`/`git_restore` and the first run of a script-bearing skill
  route through the permission gate regardless of mode.
- **Asking with a shortlist is its own tool, over the same door.** `ask_choice` sits beside
  `ask_user` in `CONTROL_TOOLS` — a distinct name, because the failure being corrected is a model
  asking an open question when the sensible answers can be listed — but both reach one
  `Permission.ask(form)`. The shortlist is how the question is _put_, not what comes
  back: the answer is a string either way, the author may always type past the list, and the
  observation reads `User answered: …` regardless, so the model has to read it rather than
  pattern-match a click. A shortlist of fewer than two is refused, being a leading question. In the
  terminal the list is numbered and anything that is not a run of valid numbers is taken as the
  author's own words.
- **A question is a page of a form, and one question is a one-page form.** `Permission.ask` takes
  an array of `AskQuestion` and returns one answer per question, positionally — so `ask_user`, a
  lone `ask_choice` and a `{questions: […]}` form are one shape rather than three doors, and a
  single question draws and reads exactly as it did before forms existed. `ask_choice` accepts up
  to `MAX_ASK_QUESTIONS` (4) at once, because a model that wants more than that has stopped asking
  and started interviewing. **Inside a form a question may omit its `choices`** and be answered in
  the author's own words: on its own that question is `ask_user`, but a form is one parked turn,
  and making the model ask the listed questions here and the open one separately would spend a
  second turn to learn nothing extra. What the model reads back is numbered against the questions,
  because `ok, ok` says nothing on its own; an unanswered one reads `(no answer)`.
- **A host that miscounts must not hang a parked turn.** `answersFor` pads a short reply and drops
  a long one — neither throws, because the model reads these as prose and a missing answer says
  "nothing" perfectly well. That is what lets the terminal put a form one question at a time (it
  has no Back button, so the numbering is all it can offer) while the desktop card pages through
  it, without either host owing the loop any arithmetic.
- **Agent backend seam, and Path B is the default.** The loop targets an internal
  `AgentBackend`; `StructuredAgentBackend` (Path A) drives tools as zod-validated JSON over the text
  seam, `NativeAgentBackend` (Path B) drives them through the vendor tool protocol. The loop is the
  arg-validation authority, so Path B advertises permissive tool params and re-validates via the
  registry. **The probe is `chatConversation`, deliberately not `chatWithTools`** — Gemini
  implements the latter for a request that is still one re-rendered string and therefore caches
  nothing, and a request that cannot be cached is the fault Path B exists to fix.
- **The request is a conversation, and it is shaped to be cached.** `buildConvoRequest`
  (`@vn/providers`) lays out `tools` → `system` → `messages` and spends the API's four
  `cache_control` breakpoints on the last non-deferred tool, the system prompt, and the two newest
  message turns — a rolling pair, so each turn reads the previous one's write. A breakpoint never
  lands on a `thinking` block, assistant blocks are echoed back verbatim (`AgentTurn.raw`), and the
  builder clones rather than marking the caller's own arrays.
- **Most tools are deferred, and the model searches for them.** `toolSpecs()` sends exactly six
  schemas up front — `propose_plan`, `ask_user`, `ask_choice`, `read_file`, `search`,
  `list_workspace` — and flags the rest `defer_loading`, alongside the server-side
  `tool_search_tool_bm25` tool. The rendered catalog is byte-identical for the life of a session,
  including across a mode change, because a tool list that moves invalidates everything after it.
- **What changes mid-conversation is said in the transcript, never edited into the prefix.** The
  mode, and any `AICONTEXT.md` section that has been superseded or withdrawn, are appended as
  `{"role":"system"}` messages — filed on change only (`Agent.filedMode`), so restating the mode it
  is already in costs nothing. On a model without the system role the builder down-renders those
  turns to user turns at request time, which is what keeps a mid-session `/model` switch from
  leaving a conversation that can no longer be sent.
- **Context precedence:** built-in input contract > `AICONTEXT.md` (+ nested per-dir files and
  `@import` lines; `AGENTS.md`/`CLAUDE.md` as fallbacks) > `AICONTEXT.generated.md` (the project
  map) > inferred defaults. `update_context` turns a chat instruction into a durable line in
  `AICONTEXT.md`; `regenerate_context` rebuilds the map. The map states facts and the author states
  policy, so the author wins — the two are separately labelled sections of the system message, and
  a file at the generated path without the generator's banner is ignored rather than trusted.
  **The desktop host keeps the map current without walking the project every turn**: it starts a
  session stale (so the first turn covers opening a workspace that has never had one written) and
  goes stale again whenever a finished turn wrote under `characters/`, `locations/`, `scenes/` or
  `wiki/` — the four directories the map is derived from. Rebuilding it is best-effort and never
  throws: a map that could not be regenerated is a worse prompt, not a failed turn.
- **What the agent wrote is what gets committed.** The loop unions `git_commit`'s `paths` with the
  paths the tools actually reported writing rather than letting the argument replace them. The
  record is complete and the model's memory is not — which is how an `AICONTEXT.md` the agent
  updated and then forgot about went uncommitted — but a path named on purpose is still honoured.
- **Round-trip safety.** Edits go through `@vn/model`'s `*ToDoc` / `applyCharacterEdit` /
  `applyLocationEdit` serializers (`fromDoc(toDoc(x)) ≡ x`), rewriting only changed front-matter
  so untouched prose and branch markers are preserved.
- **Prose edits are the desktop's edits.** `edit_scene` names the same thirteen acts the `story.*`
  commands do — and `set_outfit` the two outfit commands — running the same `@vn/scriptedit`
  decisions, so a refusal an author sees mid-drag is the refusal the agent gets, and the storyboard
  consequence is accounted for once. **Drafting a run of prose is one call, and so is clearing
  one**: `insertLines` and `deleteLines` fold over `insertLine` and `deleteLine` inside
  `@vn/scriptedit`, so ids stay allocated by the one prose write path, a bad line anywhere in the
  run writes none of it and says which line it was, and the whole run is a single write rather than
  forty — which is what makes *rewriting* a scene two calls instead of forty-one. Twelve of the
  thirteen are prose; `setHeading` is the one that moves
  a scene somewhere else, and it says in its own result that the rendered art will be drawn again
  and that the prose it left behind is the agent's to rewrite. **Wiring is the second half and a
  second tool**: `edit_branches` runs `branchops`' four rewires, which is what makes `newScene`'s
  own _"nothing points at it yet"_ actionable rather than a dead end. See
  [`command-system.md`](command-system.md#from-the-agent).

## Tools

The registry is `packages/authoring/src/tools.ts` — 41 tools. **M** marks `mutating: true`
(blocked in plan mode); **C** marks `confirm: true` (always through the permission gate,
whatever the mode).

| Group | Tools |
| ----- | ----- |
| Read & search | `read_file`, `list_workspace`, `search`, `search_bible`, `list_archive` |
| Domain & validation | `validate_inputs`, `parse_fountain`, `story_graph`, `extract_entities` |
| Entity editing | `create_character` **M**, `create_location` **M**, `edit_character` **M**, `edit_location` **M** |
| Scene prose | `edit_scene` **M** |
| Branch wiring | `edit_branches` **M** |
| Wardrobe | `set_outfit` **M** |
| Art (concepts) | `list_images`, `generate_image` **M C**, `edit_image` **M C** |
| Art (planned) | `list_assets`, `art_notes`, `view_image`, `set_art_notes` **M**, `regenerate_asset` **M C** |
| Approval | `approve_assets` **M** (confirms its own list) |
| Raw write | `write_file` **M**, `edit_file` **M** (neither for `scenes/` or `.aiagent/skills/`) |
| Context | `update_context` **M**, `regenerate_context` **M** |
| Git (read) | `git_status`, `git_log`, `git_show`, `git_diff` |
| Git (write) | `git_commit` **M**, `git_init` **M**, `git_revert` **M C**, `git_restore` **M C** |
| Skills | `discover_skills`, `create_skill` **M**, `edit_skill` **M**, `run_skill` **M** (**C** on the first run of a script-bearing skill) |

**A long document is changed in part, not restated.** `edit_file` replaces exact strings and
writes through the same `writeDocFile` the Wiki pane saves through, so bad front-matter earns the
same refusal in both. It rests on a **read ledger** — `ToolContext.seen`, owned by the loop and
cleared with the conversation — recording what each `read_file` showed and the hash it showed it
at: an edit to a file this conversation never read is refused, and so is one to a file that moved
since. Every hunk lands in memory and the file is written once, so a refusal half-way through
leaves the bytes exactly as the model last read them. It is the escape hatch's partial twin, not a
way around the typed tools: a `scenes/`, `characters/` or `locations/` path is refused by name.

**Editing an entity is typed** rather than done with `edit_file`: `edit_character`/`edit_location`
route through `@vn/model`'s serializers, so the round-trip guarantee holds by construction. Both
edit tools patch the sheet the workspace index actually loaded — a character tagged
`type: character` under `wiki/` is edited where it lives, never at the conventional path — while
the `create_*` tools do write to the conventional directory, because that is where a sheet that
does not exist yet goes. **A create tool takes the whole sheet**: its arguments are the edit tool's
minus `id` (slugged from the name), routed through the same `applyCharacterEdit`/`applyLocationEdit`,
so a created sheet is validated by exactly what would have validated an edited one and a character
does not have to be created and then immediately edited. Given no fields at all, `create_character`
still writes the template — and says which of the three it did, because a sheet of placeholders and
a sheet with an empty body are different things to whoever draws from it next.

Three things stay out of the model's hands. **Scene prose**: `write_file` and `edit_file` both
refuse a `scenes/` path outright and name `edit_scene` instead, because a chunk written whole is a
chunk with no proof: duplicate line ids, a lost heading, a scene id that stopped matching its
filename, and stranded storyboards, none of which anything downstream would notice. **Nor
`.aiagent/skills/`**, which `create_skill` and `edit_skill` own for the same reason turned the
other way: those two write prose, and a raw write that could reach the directory would put a
`run.mjs` there — or rewrite the one already sitting beside a skill — that `run_skill` then offers
to execute behind a confirm card reading identically whether a human vetted the file last year or
the agent wrote it ninety seconds ago. And **nothing lets the model change its own mode** — there is no
`enter_plan_mode`/`exit_plan_mode` tool. Mode is owned by the REPL and the permission gate,
which is what makes plan mode a guarantee rather than a request.

`set_outfit` is **one tool for both levels** of the outfit chain, because they are one authorial
sentence: "put Aiko in her tracksuit for the club scene" and "…for this one frame" differ by a
word, and which file the change lands in is a consequence rather than a choice the author makes.
The `shot` argument picks the level — absent, a `[[outfit:]]` marker is spliced into the scene
chunk; present, the subject's override is written to `work/shots/<sceneId>.json`, which re-hashes
that shot. `outfit=""` clears either and lets the level below answer. The wardrobe itself is
authored on the character sheet (`edit_character`'s `outfits` / `defaultOutfit`), so the set
`set_outfit` will accept is the set the sheet declares.

### Concept images

`generate_image` and `/makeimage` are the same act reached two ways: a sentence in, a picture out,
without a task in the graph. Both run `@vn/artgen`'s `generateConcept`, which is also what the
desktop's `art.generate` runs.

- **The agent core never constructs a provider.** `ToolContext.art` is an `ArtGen` seam —
  `generate`, `preview`, `redraw`, `list` and `describe` — wired by the host, which is the half that
  knows whether this run is `--mock` and
  where the keys are. A bare context has no `art`, and the tool refuses rather than assume an API
  key exists to spend. This is the same shape as `confirm`: the core decides *what*, the host
  decides *whether*.
- **It is `confirm: true`, because it costs money.** Every generation is one image billed, so it
  goes through the permission gate whatever the mode, exactly like `git_revert`.
- **`/makeimage` is not a turn through the model.** A one-line request should cost one generation
  and no tokens, so the REPL calls the seam directly. It still obeys plan mode — and there it prints
  the resolved subject and the composed prompt anyway, which is the part worth reading before
  spending anything.
- **The subject is matched from the sentence, or named.** `location:<id>` / `character:<id>`
  overrides it; a tie goes to the location, since a place is what gets asked for and a character
  already has a portrait pipeline. Existing plates of that location (or the approved portrait) are
  fed back as references, so "an aerial shot of the high school" is a shot of *that* high school.
- **A concept stays a sketch.** The pipeline never plans one, no scene renders one, and
  `vngen export` ignores it. Turning one into a real location plate is `art.promote` — a separate,
  human decision, and deliberately not a tool the agent has.
- **A concept is the one asset the agent can edit, because it is the one whose prompt is
  authored.** Every other prompt is derived on each planning pass and folded into a task hash, so
  the agent moves those with art notes (`set_art_notes`, below) and the pipeline
  re-renders. A concept has no builder behind it: `edit_image` redraws one from a rewritten
  prompt and files the result as a **new** sketch, leaving the original where it is. It is
  `confirm: true` for the same reason `generate_image` is — one image, billed.
- **A hash is not memorable, so `list_images` exists.** It is the only non-mutating art tool: it
  prints every concept with its short hash, name, subject and prompt, and `edit_image` accepts a
  hash *prefix*, refusing an unknown or ambiguous one by name rather than guessing which picture
  the author meant.

### Revising planned art

A picture the pipeline planned is not edited, it is **re-directed**: the prompt is derived on every
planning pass, so the durable thing an author changes is the art note behind it. The five tools are
that loop — see what exists, read how it was directed, change the direction, draw it again, look at
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

- **`set_art_notes` appends by default.** The agent is adding a correction to what the author
  already wrote, not replacing an authorial paragraph it never read; `mode='replace'` and
  `mode='clear'` are available and say so. It goes through `@vn/artgen`'s `setArtNotes`, so the
  agent reaches the same five rungs through the same refusals the desktop's `art.setNotes` does —
  including the one that matters, that a note never invents the outfit, variant or shot it names.
  It is **M** but not **C**: a note costs nothing, and the write is a plain undoable edit.
- **`regenerate_asset` is the capability-gated one.** `@vn/authoring` may not import `@vn/pipeline`
  or `@vn/scheduler`, so re-rendering arrives as an injected `ToolContext.pipeline` — `regenerate`
  and `run`, which is all an agent has business asking for. In `vnauthor`'s REPL it is absent and
  the tool refuses by naming the host that can do it. In the desktop app it is the same two calls
  `asset.regenerate` makes, so an agent-started run takes the busy flag a pipeline run takes.
- **It is `confirm: true`, and the card separates queueing from paying.** `run=false` puts the task
  back to `pending` and nothing is drawn; `run=true` says *one image generation* on the card,
  because that is what clicking it spends.
- **`view_image` is the read-back, and it is the reason this is a loop rather than a shot in the
  dark.** It sends the bytes to the vision backend with a question and prints the answer, so the
  agent proposes the *next* note against the picture that exists instead of against its own prompt.
  Like the concept tools it needs `ToolContext.art` and refuses without it.
- **Every one of them takes a hash prefix**, resolved against the manifest and refused by name when
  it is unknown or ambiguous — before a capability is called, so a typo never costs anything.

`regenerate_context` writes the **project map**, `AICONTEXT.generated.md`: the cast with each
sheet's path and wardrobe, the locations and their variants, the story graph, and the story
bible's table of contents — one line per note, its path, title and headings. It is a map, not
content: no line of what any file *says* appears in it, which is what keeps it affordable and
keeps the bible reached by query. The table of contents is the point — it turns a blind
`search_bible` into an aimed one, because the agent can see that `wiki/history/the-war.md` has a
`Casualties` heading before it queries. The file is budgeted (8000 characters, spent cast-first),
and a section that could not print every row says how many it dropped and which tool answers the
rest. The same act is the desktop's `workspace.reindex`.

**The map is a snapshot, and it says so.** Both hosts recompose the system message per turn
(`Agent.setSystem`, beside `setBackend`), so an agent that outlives a rewrite of the file — its own
`regenerate_context`, or the desktop's `workspace.reindex` — stops quoting the version it was built
with. Its header names `list_workspace` as what is true now, because nothing re-reads the map
between turns of the same turn, and a stale list that looks authoritative is worse than no list.

**`list_workspace` names the file every row was found in**, and says of a location with no sheet
that it was mined from the screenplay. Locations are merged by the slug `parseHeading` derives, so
authoring a sheet for a place the script already mentions converts a row instead of adding one —
without the path, the before and the after are the same two lines.

**What the host had on screen is a message, not a system line.** `Agent.run(input, focus?)` files
the host's `focus` as a `context` message ahead of the user's — a fourth `AgentMessage.role` that
`renderTranscript` upper-cases to `CONTEXT:`, so both backends carry it unchanged. It is a message
because it was true at _that_ turn and not at the others, and the system message is recomposed per
turn, so putting it there would let the last selection rewrite every earlier one. `focusOnScene`
builds the sentence from the live `WorkspaceIndex` and returns `undefined` for an id nothing
answers to, so a stale selection says **nothing** rather than asserting a scene that is gone. The
REPL passes no focus and reads exactly as it did before.

`search` and `search_bible` are separate on purpose. `search` scans the authored input files —
a bounded set, so it can afford to be exhaustive and unranked. `search_bible` queries `wiki/`,
which is unbounded, so it is ranked and capped at a character budget; there is no tool that
returns a bible file whole. `list_workspace` reports the bible only as a file count, so the
agent learns one exists without paying for it. See [`story-bible.md`](story-bible.md).

### Approving art on the author's say-so

`approve_assets` is the one act where the *authority* is the author's own words rather than the
agent's argument for them, because approval is what everything downstream is drawn from and a
cleared gate is a run that keeps going. It is built so that one specific mistake cannot happen: the
agent deciding, mid-turn and for reasons of its own, that the author would surely want all of this
approved. Three checks, in order, each of which can only *narrow* what the one before it allowed:

- **The list is the project's, not the model's.** The host enumerates what is approvable right now
  — `ToolContext.approval`, wired in the desktop app to the same walk the document tree's
  *Awaiting approval* group is a projection of, upstream first — and nothing outside that list can
  be approved however it is named. As with `regenerate_asset`, `vnauthor`'s REPL has no such host
  and the tool refuses by naming the one that does.
- **A small model reads what the author actually typed.** Not what the agent says they meant: the
  triage prompt carries the author's own recent turns (`SAID_WINDOW`, six) and the list, and
  *nothing the assistant said*, with the rule spelt out that being asked is not evidence. It
  answers two questions at once because they are one question — did they ask, and which of these
  did they mean — and the answer is narrowed again in code, because a hallucinated hash that
  happens to match something is an approval nobody asked for. The model is fixed at
  `TRIAGE_MODEL` rather than following the conversation's: this is a check *on* the agent, and
  running it on the model being checked is not a check. A mocked session has no model, and
  `offlineTriage` stands in and says in its own words that it matched text without one.
- **The author confirms the final list.** Every picture by name, what approving it would do, and
  the triage model's sentence for why it is on the list at all — a list of ten hashes with no
  account of where it came from is not something anyone can consent to.

**The tool takes no arguments.** That is the point rather than an omission: an argument is
something the agent fills in, and there is nothing here for it to aim. What is blocked upstream is
shown to the triage model and held back *after* it, listed under its own heading with the sentence
saying what it is waiting on — filtering it out first would make “approve everything” quietly mean
“approve some of it”. What survives is approved in the order the host listed it, which is upstream
first, so one call can approve a plate and the frame drawn from it.

## The archive

An author's own documents — a worldbuilding dump, a cast list, an outline someone else wrote —
come in through **`/upload <file…>`** in the REPL, or **Upload Files…** in the desktop app. Both
run `archiveUpload` in `packages/authoring/src/archive.ts`, so there is one archive and one layout.
Plan: [`plans/upload-and-archive.md`](plans/upload-and-archive.md).

- **The originals are copied verbatim to `archive/<yyyymmdd-hhmmss>-<slug>/<original filename>`**,
  one directory per batch, at the project root. Not under `wiki/` and not under `vngen/`: the first
  is retrievable, the second is generated output, and an uploaded document is neither.
- **The archive is invisible to every sweep, and that costs no code.** `search` walks an allow-list
  (`characters/ locations/ scenes/ screenplay/` plus `AICONTEXT.md` and `project.yaml`), entity
  discovery walks `characters/ locations/ wiki/**`, and the bible reads `wiki/` — so a top-level
  `archive/` is reached by none of them. That is the whole "not indexable or searchable" policy, and
  it holds exactly as long as nothing adds `archive` to those lists.
- **It is readable when the author names it.** `read_file` serves any workspace path, so an archived
  note is read on request and never by accident. `list_archive` prints the batches and their files
  so the agent can see what arrived without a walk it is not allowed to do.
- **An upload refuses before it copies**: a file already inside the workspace, a path that is not a
  regular file, one over 25 MB, or a second file with a name already taken in the same batch. A
  batch where everything was refused writes no directory at all.
- **A format with no converter is archived anyway, and said so.** `.docx`, `.odt`, `.zip` and the
  rest are copied unchanged and reported as *"archived, not yet readable: no converter for …"* —
  the bytes are safe now, and the converter that writes a text sidecar beside the original is a
  later step that needs no change to this layout. `readable` means what `read_file` would actually
  serve today: strict UTF-8, under its own size bound.
- **Uploading ends in plan mode with a question, not an edit.** The REPL prints the batch and a
  short numbered list of ways to phrase the next prompt; the desktop opens a fresh conversation on
  the same sentence with the same openers as chips. The suggestions are built from the file list
  alone — count, extensions, whether names look like scenes — never from the contents, because
  reading them to propose a sentence the author will rewrite costs a model call for nothing.

## Skills

Reusable authoring playbooks live under `<dir>/.aiagent/skills/<id>/SKILL.md` (front-matter:
`name`, `description`, `when-to-use`). A pure-prose skill returns its body as guidance; a skill
with a `run.{mjs,js,cjs,sh}` script runs a vetted command — and **each run is permissioned**
(always-confirm), executing in the workspace root with the workspace path as its first argument.
Three ship with the sample: [`new-character`](../templates/basic/.aiagent/skills/new-character), a
playbook for one act; [`branching`](../templates/basic/.aiagent/skills/branching), the three shapes
a fork can take, how to split a shared scene into per-route chunks, and the refusal to hand back
when the author asks for something that would need a conditional; and
[`full-production`](../templates/basic/.aiagent/skills/full-production), a spine — nine
phases from premise to storyboard, each its own plan and its own commit, ending at the one
thing the agent cannot do (decomposition is `@vn/pipeline`'s, so shots are the author's act).

**The agent can write a skill, and what it writes is prose.** `create_skill` scaffolds
`.aiagent/skills/<id>/SKILL.md` from a name, a description, an optional _when to use_ and a body;
`edit_skill` changes one field of an existing skill, carrying forward front-matter it does not
model — a `script:` a person added, most of all — and losing YAML _comments_, because the file is
re-emitted in canonical key order rather than spliced. Neither has a `script` argument, and their
schemas are `.strict()`, so passing one is a parse error before the tool is entered; `write_file`
refuses every path under `.aiagent/skills/` and names those two instead. A script-bearing skill
stays fully supported — it just has to be added by a person, because `run_skill`'s confirm card
says only which script wants to run, which is a sentence that reads the same whether the file was
vetted a year ago or written ninety seconds ago. `git_restore` and `git_revert` are deliberately
not gated: they are `confirm: true` and their cards name the file, so a person approves that
specific resurrection.

A skill also stops degrading silently: `discover_skills` appends `(!)` and says what is wrong when
a skill has no description, no body, or a `script:` naming a file that is not there — the last of
which is the dangerous one, because `findScript` then falls through to the `run.mjs` scan and a
different script runs under the name nobody wrote down.

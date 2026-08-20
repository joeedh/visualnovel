# Custom actions: user-authored macros over the command palette

Status: **research**. Nothing here is planned work. The companion report —
[`agent-access-to-the-ux-command-system.md`](agent-access-to-the-ux-command-system.md) — settles
the question this one assumes: **the agent does not get the registry**, and composition is the
macro system's job rather than a widened tool list.

A **custom action** is a macro: a saved, named, re-runnable sequence built out of the commands the
palette already lists, plus nodes that call the agent. This report works through what that costs
and what it can rest on.

> **Revised after an adversarial read** —
> [`pressure-test-user-authored-macros.md`](pressure-test-user-authored-macros.md), which is worth
> reading alongside this. It found the first draft's foundation wrong in three places, and the
> sections below are rewritten rather than annotated: recording a macro is **not** filtering the
> journal, because `invocation` is a redacted projection by design; "spends money" is **not**
> derivable from the catalog, because nothing in it records cost; and preview-as-a-snapshot-bracket
> reaches further than per-command undo and cannot force the mock path. What survived is marked
> where it matters.

<!-- toc -->

- [The two decisions it rests on](#the-two-decisions-it-rests-on)
- [What a macro is made of](#what-a-macro-is-made-of)
- [Selection-first, and why outputs come second](#selection-first-and-why-outputs-come-second)
- [The file format](#the-file-format)
  * [Recording is not filtering the journal](#recording-is-not-filtering-the-journal)
  * [A step that consumes an output is not a legal invocation](#a-step-that-consumes-an-output-is-not-a-legal-invocation)
- [Where macros live, and how they move](#where-macros-live-and-how-they-move)
- [Trust: one confirm, and it is computed — once a field exists to compute it from](#trust-one-confirm-and-it-is-computed--once-a-field-exists-to-compute-it-from)
- [The agent node](#the-agent-node)
  * [Its prompt is inline by default](#its-prompt-is-inline-by-default)
  * [Mode is the author's, per node](#mode-is-the-authors-per-node)
  * [Questions go through the one door](#questions-go-through-the-one-door)
  * [The conversation, and what it costs](#the-conversation-and-what-it-costs)
- [Running one: the affordance, and who owns failure](#running-one-the-affordance-and-who-owns-failure)
- [The invocation dialog](#the-invocation-dialog)
- [Where a macro appears](#where-a-macro-appears)
  * [Placement metadata belongs in the macro, not in a menu document](#placement-metadata-belongs-in-the-macro-not-in-a-menu-document)
  * [Identity is a slug, so the project shadows the user](#identity-is-a-slug-so-the-project-shadows-the-user)
  * [Ordering is within a store, because a macro cannot reorder a file it does not own](#ordering-is-within-a-store-because-a-macro-cannot-reorder-a-file-it-does-not-own)
  * [Anchors have to be named before any of this can be written down](#anchors-have-to-be-named-before-any-of-this-can-be-written-down)
  * [The two universal rows](#the-two-universal-rows)
  * [Reordering by right-clicking a live menu is the risky part](#reordering-by-right-clicking-a-live-menu-is-the-risky-part)
- [Whether a macro row can run, and how it says so](#whether-a-macro-row-can-run-and-how-it-says-so)
  * [Greying is available, and the struck-through glyph can retire](#greying-is-available-and-the-struck-through-glyph-can-retire)
  * [The verdict is the root node's, and only the root's](#the-verdict-is-the-root-nodes-and-only-the-roots)
  * [Three refusals that cost no round trip](#three-refusals-that-cost-no-round-trip)
  * [What the tooltip says](#what-the-tooltip-says)
  * [What it costs to draw](#what-it-costs-to-draw)
- [Preview mode](#preview-mode)
  * [The bracket is wider than per-command undo, in the direction that hurts](#the-bracket-is-wider-than-per-command-undo-in-the-direction-that-hurts)
  * [Discarding a preview poisons the undo stack it shares](#discarding-a-preview-poisons-the-undo-stack-it-shares)
  * [Preview cannot force mock today](#preview-cannot-force-mock-today)
- [Authoring a macro with the agent](#authoring-a-macro-with-the-agent)
- [How guided UI tours fit](#how-guided-ui-tours-fit)
- [Staging](#staging)
- [What is still open](#what-is-still-open)

<!-- tocstop -->

---

## The two decisions it rests on

**Macros sit on the palette.** That is what people expect from a macro system — you build one out
of the searchable command list — and it is why lower-level machinery is a _scripting API_'s
problem, not this one's. The corollary from the companion report: the extracted implementation
layer is plain functions with no registry, so nothing about macros depends on it.

**The agent reaches macros, never commands.** One tool, `run_macro`, plus whatever authors one. The
tool list therefore does not grow with the catalog, and the cached prefix is untouched.

---

## What a macro is made of

Three node kinds, and only the first is needed for a useful v1.

| Node        | What it is                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| **Command** | One catalog entry with its props — the same `{id, props}` pair the DSL formats and every `CommandRecord` carries |
| **Agent**   | A prompt, a mode, and a conversation. See [The agent node](#the-agent-node)                                       |
| **Input**   | A value the author is asked for when the macro runs, or a constant hidden from the dialog                         |

The Macro Editor's own rule — _the DAG may have only one root tool node, a root being one whose
parents are all input nodes_ — is a statement about the graph shape, and it only bites once outputs
exist. Until then a macro is a **list**, not a graph.

## Selection-first, and why outputs come second

The open question was selection-first (_"select this, do that on selection"_) against full output
properties (_"pick this, do that on input"_). They are not alternatives at the same altitude:
selection-first is v1, outputs are the DAG editor.

**Selection-first needs no new plumbing.** Most commands already take their subject from `ui.*` —
enough that the tours plan names `wrong-subject` its most common anchor resolution, precisely
because so much of this app reads its subject off the selection rather than its arguments. A macro
recorded as a run of palette acts against the current selection is therefore already expressible,
today, with the catalog as it stands.

**Outputs are a second half of the catalog that does not exist.** `toCatalog` emits typed props and
a JSON Schema for _inputs_; `CommandOutcome` answers with a human sentence, an optional `data` and
`written`. Nothing anywhere declares a return shape. Wiring outputs to inputs means adding one
across 108 commands.

> **A bridge would have asked the command system for nothing; macros ask it for a second half.**

That asymmetry is worth keeping in view: the input schemas a model would have consumed are already
there, and the output vocabulary macros need is not. The command system's evolution budget should go
to the macro requirement.

The sequencing follows: **declare outputs per command, on demand, when a macro actually needs to
consume one** — starting with the obvious handful (`asset.info`, `prompt.info`, `gate.candidates`,
`story.coverage`, `workspace.chooseDirectory`). Declaring all 108 speculatively is work spent before
anyone knows which are worth wiring.

## The file format

**A macro's steps should be written in the command DSL, because the DSL is already the
copy-pasteable repro line.** `parseCommand(formatCommand(x)) ≡ x` is pinned by a round-trip test,
and parse errors carry a column so a bad macro can be pointed at rather than merely rejected. That
much holds, and it is the reason to reach for the DSL at all.

### Recording is not filtering the journal

The first draft went one step further and said: every `CommandRecord` carries `invocation`, so
**recording a macro is filtering the history** — no recorder to write, and what the file says is
what the journal said. That is false, and the code says so in as many words.

`CommandStack.exec` digests **before** it records (`packages/commands/src/stack.ts:100-105`):

```ts
// The record holds the digested props; `run` below still gets the real ones.
const recorded = await digestProps(command.props as PropSpecMap, props);
const base = { seq, id, props: recorded, invocation: formatCommand(id, recorded), … };
```

`digestProps` replaces a `secret` prop with `'<secret>'` and a `digest: true` prop with
`<sha256:…+len>`, and `digest.ts`'s own module doc states the consequence: _a digested invocation is
not re-executable_. `redo()` agrees from the other side — it restores the post-state and never
replays `invocation`. So a recorded step for `doc.write`, `prompt.*`, `report.*` or
`view.saveLayout` reads `text='<sha256:abc123…+2048>'`, and for `project.setKey` it reads
`key='<secret>'`.

> **The journal is a redacted projection of what ran, not a script of it.** That is a deliberate
> property — provenance should not be a place secrets and whole files accumulate — and a macro
> recorder must not be the thing that erodes it.

So a recorder is **a real feature**: a capture path in `exec` that keeps the pre-digest props for
the current recording session only, in memory, never on disk beside the log. Three further reasons
the filter was never going to work, each from the pressure test:

- **`CommandStack.seq` restarts at 0 every process** and is never seeded from the log, so
  `commands.jsonl` carries duplicate sequence numbers across sessions. There is no stable key to
  select a range of history by.
- **The journal is neither complete nor clean for this purpose.** Failures are appended with
  `status: 'error'`; refusals never reach it at all; and because `exec` coerces first, every record
  carries defaults filled in, so a filtered macro would pin choices the author never made.
- **Nothing in the app reads the log.** `readCommandLog` exists solely for `report.agent`, and its
  doc says as much: provenance was written to be read by a person with a text editor.

None of this touches the **format**. A macro file holds DSL lines because the DSL is a good
notation with a pinned round trip and a real parser — not because the lines can be scraped from
`commands.jsonl`.

### A step that consumes an output is not a legal invocation

The first draft's worked example ended with `prompt.repin(hash=$1 …)`, which does not parse:
`Parser.value()` (`dsl.ts:105-119`) accepts a quote, `[`, `-`, a digit, or `IDENT_START`, and `$`
is none of them.

That is not a typo, it is the tension the format has to choose about:

> The moment a step interpolates an earlier node's output, it stops being the same string the
> palette prints and CDP accepts — which was the whole argument for the DSL.

Two honest branches, and neither is free. **Grow the grammar** — one interpolation form in the one
parser three hosts share, which means CDP and the palette accept `$1` too and have to say something
sensible when there is no macro around it. Or **keep steps legal and put the wiring beside them** —
the DSL line carries a placeholder value, and the front matter (or the editor's own graph) records
which output feeds which prop, so a step still pastes into the palette and runs, just with the
placeholder.

The second is better and it is what the staging below assumes: it keeps `parseCommand` untouched,
it matches the Macro Editor's model where wiring is edges rather than text, and it means a v1 with
no outputs is a file of ordinary invocations. The cost is that a macro file is no longer readable
as _only_ its steps.

With the interpolation removed, a shape that carries both halves — structure in front matter, prose
where prose belongs:

````markdown
---
name: Repin every suspension
description: Point each suspended reference at what its slot holds now, oldest first.
inputs:
  regenerate: { kind: boolean, default: false, description: draw the pictures again }
---

```vn
asset.suspended()
```

```agent plan
Read the suspensions above and say which ones are safe to repin without redrawing.
Ask before repinning anything a shot already illustrates.
```

```vn
prompt.repin(hash='' chunk='' ref='' regenerate=false)
```
````

...with `wires:` in the front matter naming which output fills `hash`, `chunk` and `ref`, and
`regenerate` bound to the declared input. Every fenced `vn` line stays a string the palette would
accept.

Three properties this buys: it diffs as text, the prose stays prose (an agent node is paragraphs,
not an escaped JSON string), and the front matter is the same YAML-over-Markdown shape every other
authored document in this project already has.

**Two conventions worth taking from elsewhere in the repo.** A macro that a merge left conflicted is
**refused by name** rather than half-run — the rule layout templates already follow, though note it
would need retrofitting: `LAYOUT_ATTRIBUTES_BLOCK` is written once at project creation, and only the
notifications line has an idempotent `ensureGitAttributes`, so every existing project needs one. And
the front matter carries the tooltip: every interactive element in this app says what it does on
hover, and a macro that appears in a menu is an interactive element, so `description` is not
optional decoration.

**One gap the pinned round-trip test does not cover**, and a hand-written macro file is exactly
where it would surface: `NaN` and `Infinity` format as barewords and reparse as _strings_, and `-0`
formats as `0`. `coerceProps` rejects non-finite numbers, so today they cannot arrive — a macro file
is a new door they can arrive through.

## Where macros live, and how they move

Two stores, and the split is a trust boundary rather than a convenience.

- **The project repo** — proposed `.vnstudio/macros/<slug>.md`, beside the layout templates,
  committed with the project. A macro here **arrives with the project**, which is the whole point and
  also the whole risk.
- **The user folder** — the author's own, versioned in its own small git repo, as the todo proposes.
  That is the right call: the reason `.vnstudio/layouts` gets away with living in the project's
  history is that the project _has_ one, and a user-level store has no history unless it is given
  one.

Copy, export and import are ordinary commands (`macro.copy`, `macro.export`, `macro.import`), and
copying a user macro into the project for specialization is a copy, not a move — the same
relationship a project skill has to a global one.

**Import is the dangerous door, and it has a precedent.** `upload.files` copies the author's
documents into `archive/` _verbatim_, outside every directory the agent sweeps, read only by name. A
macro imported from outside should be treated the same way: it is bytes until a human has read it
and saved it, because — see below — the authority a macro runs on is the human who saved it.

## Trust: one confirm, and it is computed — once a field exists to compute it from

The rule the repo already has: `run_skill` confirms the first run of a script-bearing skill, and the
raw writers refuse `.aiagent/skills/` so that _the script it offers to run is always one a person
put there_. Macros want the same shape, with one refinement.

> **A macro carries one confirm, not one per node, and the card is derived rather than authored.**

The card should **list what this macro is about to do** — every mutating node, every one that spends
money, every one that writes outside the document class — computed at the moment of the click. An
authored "this macro is safe" line would be a claim; a derived list is a fact, and it cannot go
stale when the macro is edited. That is still the right shape. What the first draft got wrong is
believing the catalog could already answer it.

**`mutating` is there; "spends money" is not, and `confirm` is a bad proxy for it in both
directions.** `Command` and `CatalogEntry` carry `mutating`, `confirm`, `undoable`, `commitsItself`,
`check` and `run` — nothing records cost, spend, or the fact of an API call. And of the fourteen
`confirm: true` sites, only three are about money at all:

- `pipeline.run`, the largest spender in the app, is deliberately **not** `confirm`, with a comment
  at `commands/pipeline.ts:26-28` saying why: every door to it is already a deliberate click on the
  words "run pipeline".
- `asset.upload`, `asset.adopt`, `asset.replace`, `notify.*`, `view.deleteLayout` and `upload.*` are
  `confirm: true` and spend nothing.

So the derived card needs a **new `spends` field on `Command`** and a one-time audit of all 108. That
is a real and defensible piece of work — it is simply not the free derivation the first draft
claimed, and the alternative is the hand-kept list of money commands that the first draft itself
fell back to two sections later, which is precisely the rotting allow-list the companion report
argues against.

**And the prerequisite is bigger than named.** The first draft warned that `pipeline.run(mock=false)`
could end up in a macro that never asked — but `pipeline.run` has no `confirm` to inherit. The real
hole is one line in `apps/desktop/src/main/index.ts:519-521`:

```ts
// TODO(desktop): route through the renderer once a confirm dialog exists; until
// then a `confirm: true` command is reachable only from the UI's own affordances.
confirm: () => Promise.resolve(true),
```

Every caller that is not the palette's own dialog — CDP, the agent, and any macro runner built
today — **auto-approves every `confirm: true` command**, `art.generate` and `art.redraw` included.
The derived-confirm work therefore begins with a real confirm door in main. A card is the second
step, not the first.

**And `create_macro`/`edit_macro` own the directory**, for the reason `create_skill`/`edit_skill`
own theirs: a raw writer that could reach `.vnstudio/macros/` could write — or quietly rewrite — a
macro that `macro.run` then offers behind a confirm card reading identically whether a human wrote
it last year or the agent wrote it ninety seconds ago.

## The agent node

### Its prompt is inline by default

A macro node's prompt is prose the caller **has already chosen**; a skill is prose the agent has to
**find**. Discovery is the cost that makes registering a skill worth it, and it is pure overhead for
a one-off node. So: inline prompt by default, an existing skill nameable from a node when one fits,
and "save this prompt as a skill" offered when the author wants it in two macros — promotion on the
second use, never the first. Requiring a skill per node produces a store full of near-duplicate
fragments, which is the failure mode this ordering exists to avoid.

### Mode is the author's, per node

The author picks **plan** or **execute** for each agent node. In execute mode the node may not
create plans at all.

This preserves the invariant a full bridge would have broken. _Nothing lets the model change its own
mode_ — mode is owned by the host and the permission gate, which is what makes plan mode a guarantee
rather than a request. A macro setting the mode is still a human setting it, one step further back.
`setMode` is public and bypasses approval, so the mechanism a node needs is already there.

**One invariant it does break, and the first draft missed it.** `git_commit` scopes to
`this.editedPaths` and clears them on success — _one commit per approved plan_. An execute-mode node
that never proposes a plan commits against a set no plan described. Either an execute node does not
commit (the macro's own bracket owns that, which fits the one-undo-point-per-macro goal), or the
pairing is explicitly relaxed for macro-run agents and written down as such.

**Withholding `propose_plan` cannot be done by shrinking the catalog.** The rendered tool list is
byte-identical for the life of a session _including across a mode change_, because a list that moves
invalidates every cached token after it. So an execute node refuses `propose_plan` **at dispatch**,
exactly as plan mode refuses mutating tools, and says so in an appended `{"role":"system"}` message
— the same channel the mode itself is filed through. Nothing leaves the prefix.

### Questions go through the one door

`ask_user` and `ask_choice` both reach a single `Permission.ask(form)`; the shortlist is how a
question is _put_, not what comes back, and the answer is a string either way. The desktop draws an
ask card and `vnauthor` numbers a list, and `answersFor` pads a short reply and drops a long one
rather than throwing — which matters more inside a macro than anywhere else, since a parked turn
that hangs is the worst failure a macro can have. (`MAX_ASK_QUESTIONS` is four; the desktop draws
them in one card with a single _Submit answers_ button rather than paging, as the first draft
claimed.)

**But the door is a door in one room.** `permission:ask` is consumed by the Agent/Convo editor and
drawn by `editors/convo.ts`: if that pane is not open, a macro's question is **invisible**. So a
floating popup is a genuinely new host rendering, not a third rendering of something that already
exists — cheap, because the form shape and the answer contract are settled, but new.

Routing is worse than merely unowned. `turnWindow` is a module global set only inside
`handle('agent:run', …)`, and `askWindow` calls `target.focus()` — so a macro running in window B
parks a question that focuses whichever window last started an agent turn. A macro runner has to
carry the origin window the same way `ctx.origin` already tells commands which window asked.

**Informal asking is not untidy here, it is fatal.** In a conversation, a model that asks in prose is
merely annoying and the author answers anyway. In a macro there is nowhere for the question to go:
the turn ends, its output feeds the next node, and the question is consumed as data. So the
prohibition needs teeth past a line in the system prompt — a node whose turn ends in a
question-shaped answer with no `ask_*` call should be an **error**, not a result. (`ask_choice`
exists as a distinct name for a close cousin of this failure: a model asking openly when the sensible
answers could have been listed.)

### The conversation, and what it costs

Each agent node runs as its own turn, against the per-turn token ceiling that already governs one
(`BUDGET_CHOICES`, default 200k, measured on non-cached tokens and checked between steps). Giving a
macro run its own thread in `vngen/state/threads/` keeps the author's conversation clean and hands
`report.agent` something to read when a macro's agent node misbehaves — which is the debugging story
the companion report cares about.

**There is nowhere for that thread to live yet, and this is the agent node's real prerequisite.**
`WorkspaceSession.ensureAgent()` memoises a single `Agent`, and `convo`, `thread`, `model` and
`budget` are session singletons — `permission()` records asks into `this.convo`. So reusing the
agent puts the node's prompt into the author's conversation, which is the exact opposite of what the
paragraph above wants, and standing up a second one needs a second permission door, a second thread
pointer and a second budget that `WorkspaceSession` does not have. Nothing prevents a collision
either: `busy()` returns the first in-flight label and its own doc says it is _reported rather than
enforced: nothing here cancels._

The budget does not compose as the first draft assumed, for the same reason — it is per-`Agent`, with
`spent` local to one `run()`. Two concurrent nodes on one agent share one ceiling and interleave
their accounting. **A macro node needs its own `Agent`, and making `WorkspaceSession` able to hold
more than one is the work.**

A fresh conversation is **cheaper than it looks**: the cache keys on prefix bytes, and the tools and
system prompt are byte-identical across conversations, so a macro run that starts a new thread still
hits the cached prefix. The mode message is appended among the messages, after the system breakpoint,
so it does not disturb that.

## Running one: the affordance, and who owns failure

**A macro must not lock the app.** It cannot: an agent node may park on a question, and the popup
that asks it is non-modal by design.

The app already has the right surface. A pipeline run raises the task list over the mesh; a macro run
is the same kind of object — long, asynchronous, worth watching, and not worth blocking on. Reusing
it is better than inventing a macro-specific progress affordance, and it means a macro and a run look
alike because they _are_ alike.

Two consequences of not blocking:

**Provenance should say a machine did it.** `CommandSource` is `ui | menu | dsl | cdp | agent`; a
sixth value, `macro`, keeps `commands.jsonl` honest about which acts a person performed by hand. The
same argument the unattended-approval research makes for doing it at the command layer: the journal
should record that a _machine_ did the thing.

The type change is one line; the two sites that matter are not in the type, and both are silent
failures:

- `index.ts:548` maps anything that is not `agent` or `cdp` to `'ui'` when it files the
  notification. Every macro-run command would post a notification claiming **the author did it** —
  the exact dishonesty the new value exists to remove.
- `index.ts:537` bumps `undoRevision` on `record.mutating && record.source !== 'ui'`, so a new source
  changes when panes think the worktree moved.

And the notification vocabulary is not free to extend: `NOTIFICATION_SOURCES` is a zod enum and
`readNotifications` drops any line `migrateNotification` cannot parse. Because `notifications.jsonl`
is union-merged, **an older build reading a `macro`-sourced line silently deletes the author's
notification** — the per-line versioning exists for this, and a new source value has to go through
it rather than around it.

**Failure is the runner's, once, not the node's.** A non-modal popup means the author can move the
state a parked macro is halfway through, and a command that re-decides at run time may then refuse —
which is the correct behaviour, arriving at an inconvenient moment. So _something_ has to say stop /
ask / skip on a refusal, and the honest owner is the macro runner, declared once for the macro,
rather than a field on every node.

**One undo point per macro is the right target, and the stack cannot do it yet.** There is no batch
bracket: each undoable command becomes its own snapshot. Adding one is a prerequisite shared with the
companion report's position E, and until it lands a macro's undo is a slog through however many steps
it took.

## The invocation dialog

The open question — _is a dialog with unset tool inputs shown on invocation?_ — answers itself with
machinery that exists. `openCommandDialog(id, props)` already gives one command **alone**: its title,
what it does, its fields, its verdict, and a button labelled with the command. A macro's declared
inputs are drawn by the same `CommandForm`: `blankProps` seeds from each default, a `boolean` draws a
checkbox, a `multiline` gets the shared writing box, a `directory` gets Browse, and
`FormOptions.choices` supplies option lists computed when the form opens.

So the Macro Editor's _"hide these in the dialog in favour of defaults"_ is not a new widget — it is
an input node that declares a default and is not asked for. A macro with every input defaulted runs
straight from its row, exactly as a command with no props does.

Two things it is not reusable for **as-is**. `openCommandDialog` is a singleton that returns early
when one is already open (`dialog.ts:114`) — so a macro asking for its inputs while any dialog is up
does nothing at all: no error, no queue. And `CommandForm`'s constructor takes a `CatalogEntry`, so
drawing a macro's inputs means either synthesising a catalog entry for a thing that is not a command
or widening the form to take a prop map. Both are small; neither is nothing, and a macro run parked
behind a silently-dropped dialog is the kind of failure that reads as a hang.

## Where a macro appears

A macro that only lives in the palette is a macro nobody uses twice. Putting one in a right-click
menu is what makes it an author's own tool — and it is the part of this design with the most ways to
go wrong, because two stores must merge into one menu and every row has to say whether it can run.

### Placement metadata belongs in the macro, not in a menu document

A menu-layout document per level is a merge-conflict machine: two people appending to the same menu
conflict on the same line, every time. Layout templates get away with being an arrangement the
project owns because a conflicted one can be **refused by name** — a broken layout costs one missing
template. A conflicted **menu** cannot be refused, because a right-click has to open.

Carrying the placement inside each macro makes the merge a **union of two directories**, which git
does without being asked. That is the same reasoning that has `notifications.jsonl` versioned per
line so git can union-merge it, and it is why the project and user stores can both contribute to one
menu without a merge policy existing anywhere.

### Identity is a slug, so the project shadows the user

The obvious dedup rule — identical macros collapse, same-name-but-different get `(Project)` and
`(User)` appended — misfires on the workflow this report calls the expected one. Copying a user
macro into the project **to specialize it** is a copy rather than a move; the copy then differs, so
the author gets two rows for the thing they just customized. That is backwards. And _identical_
would have to be defined: byte equality splits one row into two over a line ending, on the platform
this app is developed on, or over a formatting pass.

> A macro carries a stable **id** — its slug — separate from its display name. Same id means the
> project's **shadows** the user's: one row, silently, with the tooltip saying it was overridden.
> The `(Project)`/`(User)` suffixes are for different ids that happen to share a display name.

That is the rule project skills and per-project instructions already follow, it removes the byte
comparison entirely, and it reserves the suffixes for the genuine accident of two people both
naming one "Fix portraits".

### Ordering is within a store, because a macro cannot reorder a file it does not own

Fractional sort keys are the right trick and at this scale they are unarguable: inserting between
two rows writes one macro rather than renumbering a menu. Note only that midpoints exhaust after
roughly fifty inserts between the same pair, so a renormalize pass is the escape hatch (or
LexoRank-style keys, which do not exhaust). Ties fall back to lexicographic on the name.

The structural problem is not precision, it is **cross-store ordering**. If order lives in the
macro, putting a user macro between two project macros means editing a file in a store the author
may not own, may not have checked out for writing, and will certainly be conflicting with somebody
over.

Answer it by not letting it arise: draw the menu **grouped by store** — built-ins, then project, then
user, separated. Ordering is then only ever within a group, which is only ever within a store the
author owns. If cross-store ordering is genuinely wanted later, a sparse per-project overrides file
keyed by macro id — carrying _only_ reorderings, never the menu — is a far smaller thing to conflict
over than a layout document.

Grouping pays twice. A project's macros arriving pre-placed in the author's right-click menus is a
larger surface than a project merely _containing_ macros: a project macro named "Delete" landing
where "Duplicate" used to be is a real trap. Keeping project rows in their own block means opening a
project cannot rearrange muscle memory.

### Anchors have to be named before any of this can be written down

A macro says where it goes by naming something, and that vocabulary is **most of the way there
already** — further than the first draft credited. All three `showContextMenu` call sites go through
a named, pure builder: `menuFor(row.node)` from the Documents tree, `menuFor(assetNode(this.shown))`
from the Asset pane, and `lineMenu(…)` from Script. `menuFor` lives in the **renderer**
(`apps/desktop/renderer/pathux/doctree.ts:228`), switches on `node.kind`, and its doc comment already
states the discipline this section wanted to introduce: _kinds with nothing to offer answer with an
empty list, and are named here rather than falling through silently._

So the anchor vocabulary is essentially `DocNodeKind` plus one script-line anchor, and the work is
**promoting it to a declared list** — one place, the way `EDITORS` names the thirteen editors —
rather than inventing it. It converges with two other things: it is the same vocabulary
`resolveAnchor` needs in the guided tours plan, and it answers "which surfaces does a macro appear
on".

**What naming an anchor does _not_ settle is which prop receives its subject.** `menuFor` uses a
different name per kind: `subject:` for `art.generate`, `target:` for `art.setNotes`, `hash:` for
the `asset.*` acts, `editor`/`where`/`subject` for `view.open`. So an anchor has to declare the
shape of what it offers — a hash, a document path, a character id — and a macro's root node has to
say which of its props takes it. It also means _"the anchor's subject did not resolve"_ is not one
refusal but one per anchor shape.

Once macros name anchors, retiring one silently breaks user macros. Treat a macro pointing at an
anchor that no longer exists as a **visible hole** — listed as wanting a menu this build does not
have — rather than dropped, which is the rule `menuFor` already states for a new node kind.

### The two universal rows

`…add macro` and `…create new macro` on every menu are worth having, and they must be **commands**
(`macro.attach(anchor=…)`, `macro.create(anchor=…)`) rather than callbacks — an entry here is an
invocation, and that is the whole thesis of `contextmenu.ts`. Which store the new macro lands in is a
prop with a default rather than a third row.

One consequence to decide rather than inherit: `menuFor` deliberately answers `[]` for kinds with
nothing to offer, and `showContextMenu` opens nothing at all for an empty list — "a node kind with
nothing to offer says so by offering nothing". A universal footer means **every** surface now pops a
menu. Probably an improvement, but it retires a stated decision.

### Reordering by right-clicking a live menu is the risky part

path.ux's menu comes up through `startMenu`/`createMenu`, and `menuWrangler` closes on mouse-up — a
second menu opened over a live one is fighting it. A `Customize this menu…` row that
opens a small ordered-list dialog for that anchor is the same instinct as the palette being the
guaranteed floor in the tours plan, it avoids the fight, and it gives enable/disable a home.

**Changing path.ux itself is on the table**, though — it is our own submodule, compiled from source
through a vite alias, and it has been extended for this app before. If in-menu reordering turns out
to be the affordance worth having, teaching the wrangler about a right-click that does not dismiss
is a legitimate fix rather than something to design around. The recommendation above is about
sequencing: the dialog is available now and costs nothing, so the wrangler change should be made
because in-menu reordering proved worth it, not to get the feature off the ground.

## Whether a macro row can run, and how it says so

### Greying is available, and the struck-through glyph can retire

`contextmenu.ts` says path.ux's menu has no per-item disabled state, so a refusal is drawn with a
combining enclosing no-symbol and clicking it reports the sentence. That is true of the **template**
and not of the widget: `MenuTemplateCustom` is a positional array with no disabled slot, but
`addItem` builds a real `li.menuitem`, pushes it onto `menu.items`, and already sets `li.title` for
the tooltip. And the menu is **DOM**, not canvas — the `<canvas>` in there is a text-measuring
scratchpad — so styling a row is ordinary CSS.

Two routes, and the first is better:

- **Upstream it.** `createMenu` has an object-based entry API —
  `{name, callback, hotkey?, icon?, tooltip?, id?}` — which is where a `disabled` field belongs.
  path.ux is our submodule; changing it is a normal move here, not a last resort.
- **Post-process**, if the vendor is to stay untouched for now: style the refused rows in
  `menu.items` after `createMenu` returns. Look them up **by id, not by index** — `seperator()`
  appends a bare `<div class="menuseparator">` to `this.dom` and never pushes onto `items`, so
  template index and item index diverge the moment a menu has a separator. The existing convention of
  giving every row an explicit id is what makes that lookup safe.

**It is a wider change than "add a field", though**, and the first draft undersold it. Nothing in the
widget consults a disabled flag today, so four paths would each still reach a greyed row: the
keyboard walk over `this.items`, `_onselect → cbs[id]()`, the focus/blur handlers, and
`autoSearchMode`, which engages past fifteen items — and a macro-bearing menu is exactly the one that
gets long. The `disabled` sub-block in path.ux's theme is on the **`button`** style class, not
`menu`, whose keys are only `MenuBG`/`MenuBorder`/`MenuHighlight`/`MenuSeparator`/`MenuSpacing`/
`MenuText`; greying needs a new theme key and a `gen:themes` run.

None of that changes the behaviour, only its cost. `take` already declines and says the sentence
rather than executing, so **a refusal is still shown rather than hidden** — it just stops being
spelled with a glyph.

### The verdict is the root node's, and only the root's

The reason is not cost.

> **Checking past the root is wrong.** `stack.check` answers about the state now; node 2 runs against
> the state node 1 produced.

A macro that creates a scene and then edits it would have node 2 refuse today — "no such scene" —
and that refusal is a lie about a perfectly correct macro. It fails _worse_ on well-written macros
than on broken ones. And once outputs are wired, a later node's props do not exist until an earlier
node runs, so there is literally nothing to check with.

So the Macro Editor's single-root-tool-node rule earns a second job: the root is the only node whose
props are fully determined at menu time, from the selection and the macro's inputs. It is the only
one that can be honestly checked, and it is the one that matters, because it is the one a click
would run first.

### Three refusals that cost no round trip

`MenuEntry.refused` already exists for exactly this shape — a precondition about _what the entry
would name_ rather than about the project — and it covers the imported-macro cases a check cannot:

- **A node names a command this build does not have.** Static, from the catalog:
  _Uses a command this version does not have: `art.promote`._ The visible-hole rule again, rather
  than a row that quietly disappears.
- **The anchor's subject did not resolve** — a macro attached to the asset menu, right-clicked where
  nothing names an asset.
- **The macro did not parse, or arrived conflicted** — refused by name.

### What the tooltip says

`li.title` is a DOM title, so it takes more than one line:

    Repin every suspension
    Can't run: art.setNotes — no character is selected.

The first line is the macro's `description`, already required and already its tooltip. The second
**names the step**, which matters more here than for a plain command row: a macro is opaque, so a
bare "no character is selected" leaves the author guessing at a sequence they cannot see. The step's
own sentence passes through verbatim, per the rule that a disabled control's tooltip is its refusal.

Two constraints on the wording:

- **An enabled row must not over-promise.** A macro whose root is accepted means its _first step_
  would be accepted now, not that the macro will succeed — step four can still refuse, and that
  failure belongs to the runner. So an enabled row's tooltip stays descriptive and never says "this
  will run".
- **Money is annotated, not refused.** If any node is a paid one, the tooltip says so, computed from
  the same catalog flags as the derived confirm card — a fact rather than a claim.

### What it costs to draw

The root check rides in the `Promise.all` that already fans `command:check` across a menu's entries,
as one more positional slot per macro; `needsCheck` extends to _a macro needs a check iff its root is
checkable_. No new round-trip shape.

Macro definitions want the treatment command descriptions already get — fetched once, kept for the
life of the window, invalidated on a `macro.*` write — so a right-click never touches the
filesystem. `startMenu` is synchronous and every check is awaited before anything is drawn, which is
the budget all of this has to fit inside.

## Preview mode

Two questions were open: whether to preview in the author's own repo and revert with git, or to clone
the project (and eventually the wiki repo); and what preview does about the pipeline.

**Revert-in-place, not a clone.** The shadow-snapshot mechanism already brackets a command with
detached commits under `refs/vn/undo/<seq>/{pre,post}` without moving HEAD or touching the index, and
it _refuses rather than guesses_ when the tree drifted. A preview is that bracket around a whole
macro. Cloning is the worse trade at every size: the asset store is content-addressed across two
roots, so a clone doubles the bytes that matter most, and a separate wiki repo would multiply it
again.

**But the snapshot pathspec excludes `vngen/build` and `vngen/state`**, which is precisely where a
pipeline run lands. That is not a gap to close — it is the honest boundary:

> **Preview can revert documents. It cannot un-spend money.**

The first draft stopped there and concluded that preview simply forces the mock path. Three things
make that conclusion premature, and together they say preview is a **later stage than it looked**.

### The bracket is wider than per-command undo, in the direction that hurts

`UNDO_PATHS` excludes `vngen/build` and `vngen/state` — so base art under `assets/` is **inside** the
snapshot. `art.generate` is explicitly `undoable: false` "because it writes new content-addressed
bytes, so there is no prior state to restore to". A macro-level bracket would revert them anyway:
not a preview of a document edit, but a deletion of exactly the bytes the per-command design
declined to touch.

So the pathspec has to **narrow** before a bracket is safe to wrap a macro in — a preview spec that
excludes both generated roots, distinct from the undo spec. That is a small change and a load-bearing
one.

### Discarding a preview poisons the undo stack it shares

Every per-command `pre`/`post` point taken during the macro describes a tree that no longer exists
once the preview is thrown away, so `UndoJournal.check` refuses each of them with its own sentence —
_the workspace has changed since that command ran_ — until enough unrelated work pushes them past
`prune()`'s keep-50. A long macro can also drive its own refs past that window mid-run.

Which points the same way as the batch bracket that step 4 below already needs: **a macro takes one
undo point, not one per node.** If the macro's commands do not take individual points, there is
nothing for the discard to invalidate.

### Preview cannot force mock today

`WorkspaceSession.mock` is `readonly`, fixed at construction from the launch flag, and it is the only
policy about whether art is real (`art: workspaceArtGen(workspace, { mock: this.mock })`). Of the
money commands only `pipeline.run` takes a `mock` prop — `art.generate`, `art.redraw` and
`asset.regenerate` have none.

So "preview forces the mock path" means adding a `mock` prop to every money command and threading a
session-level override, which is the per-command migration this report elsewhere argues against.
Until that exists the honest options are narrower: a preview **refuses** to contain a money command
at all, and says which node it refused. That is a worse feature and a truthful one, and it is
available now.

The todo's instinct — _"perhaps there could be a 'dry-run only' option for preview"_ — still holds,
and it should be the **only** option rather than a checkbox. It just cannot be implemented by
pinning a flag that mostly does not exist.

## Authoring a macro with the agent

**A subagent system is not needed for this, and should not be justified by it.** A macro-writing
agent writes a text file, and the specialised thing it needs is _context_: the catalog, what each
command refuses, and what a well-formed macro looks like. That is a skill plus the read-only bridge
the companion report already recommends — `command.check`, `interaction.targets` and catalog
introspection are exactly a macro author's questions, and they are non-mutating, so they cost nothing
to grant.

The convergence is worth naming: **position B is what a macro-writing agent needs.** It is the same
increment, arrived at from the other side.

Subagents — a fork, a specialised child, a hierarchy to navigate, and a prompt asking whether to
return to the prior conversation — are a real feature with independent motivation (long side quests
that should not pollute a thread). They should be designed against that motivation. Attaching them to
macro authoring would buy a lot of machinery for a job a loaded skill does.

## How guided UI tours fit

They are the same object with two runners.

A tour step is an invocation validated by `stack.check` before it is shown; a macro node is an
invocation validated by `stack.check` before it runs. The anchors plan's `Action` — `{id, props}`,
computed as data before it becomes a click — **is** a macro node, and its `Offer` is the verdict a
macro's confirm card wants. The palette is the guaranteed floor for both: an unanchored tour step
opens the command's form prefilled, and that is also what a macro does with an input it must ask for.

The single axis of difference is who acts:

> **A tour never performs the step; a macro always does.**

Which suggests one step representation and two runners rather than two vocabularies — and it opens a
pipeline that is nicer than either feature alone: the author's own history (`commands.jsonl`) records
into a macro, and a macro projects into a tour that teaches someone else to do it by hand.

## Staging

Revised after the pressure test, which mostly moved work **earlier**: two of these are prerequisites
the first draft treated as details.

0. **A real confirm door in main**, replacing `confirm: () => Promise.resolve(true)`. Not macro work
   at all — but every caller that is not the palette silently auto-approves today, so a macro runner
   built before it inherits a yes on `art.generate`. Nothing below is safe without it.
1. **Named anchors.** Promote the vocabulary `menuFor` and `lineMenu` already switch on to one
   declared list, and say what subject shape each anchor offers. Nothing user-facing, and everything
   below — plus `resolveAnchor` in the tours plan — needs it.
2. **The recorder.** A capture path in `exec` that keeps pre-digest props for an in-memory recording
   session. This is a feature, not a filter over `commands.jsonl`; see
   [the file format](#recording-is-not-filtering-the-journal).
3. **Linear macros, selection-first, no editor.** Run from the palette, `.vnstudio/macros/<slug>.md`,
   inputs through `CommandForm` (which needs its singleton and its `CatalogEntry` constructor
   loosened). No agent nodes, no outputs, no graph.
4. **The batch undo bracket** and `source: 'macro'` — the latter including the notification mapping
   and the zod enum migration, or the new value is a silent data loss on an older build.
5. **Menu placement** — placement metadata in the macro, root-only checks, greyed rows with the
   step's own sentence, `macro.attach`/`macro.create` on every anchor.
6. **A `spends` field on `Command`** and the one-time audit of 108, which is what makes the derived
   confirm card derived rather than hand-kept.
7. **Preview** — a narrowed pathspec first, then the bracket; refusing money commands until they take
   a `mock` prop.
8. **Agent nodes** — a second `Agent` in `WorkspaceSession` first, then inline prompts, per-node mode,
   `propose_plan` refused at dispatch, and the floating ask popup with an origin window.
9. **The user-folder store**, its little repo, copy/export/import, and the shadow-by-id and
   group-by-store rules that only bite once there are two stores.
10. **Declared outputs**, per command and on demand — and with them the wiring notation the file
    format defers.
11. **The Macro Editor** — the DAG, input nodes, hidden inputs, the single-root rule.

Steps 0–5 are worth having if nothing after them is ever built, which is the test a first stage
should pass — and step 0 is worth doing whether or not macros are ever built at all.

## What is still open

- **Whether a macro is undoable at all**, or merely bracketed for preview. A macro containing
  `pipeline.run` straddles both data classes, which is the case undo deliberately declines.
- **Whether the confirm card's derived list is enough** for a macro imported from elsewhere, or
  whether an imported macro should require a read-through before its first run.
- **The menu bar and keyboard shortcuts.** Right-click menus are answered above; whether a macro may
  also claim a menu-bar entry or a key is the same placement question against two surfaces with far
  less room and a much higher collision cost.
- **What an agent node returns to the next node** once outputs exist. Prose is not a typed output,
  and asking a model for JSON is the seam `extractJson` already exists to survive.
- **Whether the DSL grows an interpolation form or macros keep wiring beside the steps.** This report
  now assumes the second; the first is defensible if the palette and CDP are given a sensible answer
  for `$1` outside a macro.
- **Whether a macro-run agent node commits at all.** `git_commit` scopes to `editedPaths` and pairs
  with an approved plan; an execute-mode node has no plan, and the macro's own bracket may be the
  better owner of that boundary.

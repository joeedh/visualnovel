# Custom actions: user-authored macros over the command palette

Status: **research**. Nothing here is planned work. The companion report
([`agent-access-to-the-ux-command-system.md`](agent-access-to-the-ux-command-system.md)) settles the
question this one assumes. The agent does not get the registry, and the macro system handles
composition rather than a widened tool list.

A custom action is a macro, meaning a saved, named, re-runnable sequence built out of the commands the
palette already lists, plus nodes that call the agent. This report works through what a custom action
costs and what it can build on.

> An adversarial read prompted this revision, and >
[`pressure-test-user-authored-macros.md`](pressure-test-user-authored-macros.md) records it and is >
worth reading alongside this document. It found the first draft's foundation wrong in three > places,
and the sections below are rewritten rather than annotated: recording a macro does not > filter the
journal, because `invocation` is a redacted projection by design; the catalog does not > yield "spends
money", because nothing in it records cost; and preview-as-a-snapshot-bracket > reaches further than
per-command undo and cannot force the mock path. The passages that survived > are marked where it
matters.

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

Macros sit on the palette. People expect a macro system to build a macro out of the searchable command
list, so lower-level machinery is a scripting API's problem, not the macro system's. As a corollary
from the companion report, the extracted implementation layer is plain functions with no registry, so
nothing about macros depends on it.

The agent calls macros, never commands. It has one tool, `run_macro`, plus whatever tool authors a
macro. The tool list therefore does not grow with the catalog, and the cached prefix stays unchanged.

---

## What a macro is made of

There are three node kinds, and only the first is needed for a useful v1.

| Node        | What it is                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| **Command** | One catalog entry with its props — the same `{id, props}` pair the DSL formats and every `CommandRecord` carries |
| **Agent**   | A prompt, a mode, and a conversation. See [The agent node](#the-agent-node)                                       |
| **Input**   | A value the author is asked for when the macro runs, or a constant hidden from the dialog                         |

The Macro Editor's own rule (the DAG may have only one root tool node, where a root is a node whose
parents are all input nodes) constrains the graph shape, and it applies only once outputs exist. Until
then a macro is a list, not a graph.

## Selection-first, and why outputs come second

The open question was selection-first ("select this, do that on selection") against full output
properties ("pick this, do that on input"). The two are not competing options for the same stage:
selection-first belongs to v1, and full output properties belong to the DAG editor.

**Selection-first needs no new plumbing.** Most commands already take their subject from `ui.*`. The
tours plan names `wrong-subject` its most common anchor resolution, because so much of this app reads
its subject off the selection rather than its arguments. A macro recorded as a run of palette acts
against the current selection is therefore already expressible with the catalog as it stands.

The catalog describes inputs but not outputs. `toCatalog` emits typed props and a JSON Schema for
inputs; `CommandOutcome` carries a human sentence, an optional `data` and `written`. Nothing declares
a return shape. Wiring outputs to inputs means adding a return shape across 108 commands.

A bridge would have required nothing from the command system. Macros require a second half of it.

The input schemas a model would have consumed already exist, and the output vocabulary macros need
does not exist. That asymmetry is worth keeping in view, and it should direct the command system's
evolution budget to the macro requirement.

Declare outputs per command on demand, when a macro actually needs to consume one. Start with the
obvious handful (`asset.info`, `prompt.info`, `gate.candidates`, `story.coverage`,
`workspace.chooseDirectory`). Declaring all 108 speculatively is work spent before anyone knows which
are worth wiring.

## The file format

Write a macro's steps in the command DSL, because a DSL line can be copy-pasted to reproduce the
steps. A round-trip test pins `parseCommand(formatCommand(x)) ≡ x`, and parse errors carry a column,
so an error can point at the offending position in a bad macro rather than only reject it. Those two
properties are the reason to write macro steps in the DSL.

### Recording is not filtering the journal

The first draft went one step further. Every `CommandRecord` carries `invocation`, so recording a
macro would amount to filtering the history: no recorder to write, and the file would hold exactly
what the journal held. That claim is false, and the code says so explicitly.

`CommandStack.exec` digests before it records (packages/commands/src/stack.ts:100-105):

```ts
// The record holds the digested props; `run` below still gets the real ones.
const recorded = await digestProps(command.props as PropSpecMap, props);
const base = { seq, id, props: recorded, invocation: formatCommand(id, recorded), … };
```

`digestProps` replaces a `secret` prop with `'<secret>'` and a `digest: true` prop with
`<sha256:…+len>`, and the module doc in `digest.ts` states the consequence: a digested invocation is
not re-executable. `redo()` restores the post-state and never replays `invocation`. So a recorded step
for `doc.write`, `prompt.*`, `report.*` or `view.saveLayout` reads `text='<sha256:abc123…+2048>'`, and
for `project.setKey` it reads `key='<secret>'`.

The journal records a redacted projection of what ran, not a script of it. That property is
deliberate: provenance should not be a place where secrets and whole files accumulate. A macro
recorder must not erode that property.

So a recorder is a real feature. It is a capture path in `exec` that keeps the pre-digest props for
the current recording session only, in memory, never on disk beside the log. The pressure test gives
three further reasons the filter was never going to work:

- `CommandStack.seq` restarts at 0 in every process and is never seeded from the log, so
  `commands.jsonl` carries duplicate sequence numbers across sessions. No stable key exists for
  selecting a range of history.
- **The journal is neither complete nor clean for this purpose.** Failures are appended with
  `status: 'error'`, refusals never reach it, and `exec` coerces first, so every record carries
  filled-in defaults and a filtered macro would pin choices the author never made.
- **Nothing in the app reads the log.** `readCommandLog` exists solely for `report.agent`, and its
  doc records the same point. Provenance was written to be read by a person with a text editor.

None of this changes the format. A macro file holds DSL lines because the DSL is a good notation with
a pinned round trip and a real parser. It does not hold them because the lines can be scraped from
`commands.jsonl`.

### A step that consumes an output is not a legal invocation

The first draft's worked example ended with `prompt.repin(hash=$1 …)`, which does not parse.
`Parser.value()` (dsl.ts:105-119) accepts a quote, `[`, `-`, a digit, or `IDENT_START`, and `$` is
none of them.

That is not a typo. The format has to resolve this tension:

A step that interpolates an earlier node's output is no longer the same string the palette prints and
CDP accepts. That identity was the whole argument for the DSL.

There are two honest branches, and neither is free. The first grows the grammar by adding one
interpolation form to the one parser three hosts share, which means CDP and the palette accept `$1`
too and have to say something sensible when there is no macro around it. The second keeps steps legal
and puts the wiring beside them. The DSL line carries a placeholder value, and the front matter (or
the editor's own graph) records which output feeds which prop, so a step still pastes into the palette
and runs, just with the placeholder.

The second is better, and the staging below assumes it. It keeps `parseCommand` untouched, it matches
the Macro Editor's model where wiring is done with edges rather than text, and it makes a v1 with no
outputs a file of ordinary invocations. The cost is that a macro file is no longer readable as only
its steps.

Removing the interpolation leaves a shape that carries both halves. Structure lives in the front
matter, and prose lives where prose belongs:

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
Read the suspensions listed above and say which ones are safe to repin without redrawing. Ask before
repinning a suspension that a shot already illustrates.
```

```vn
prompt.repin(hash='' chunk='' ref='' regenerate=false)
```
````

...with `wires:` in the front matter naming which output fills `hash`, `chunk` and `ref`, and binding
`regenerate` to the declared input. Every fenced `vn` line stays a string that the palette would
accept.

This format has three properties: it diffs as text, the prose stays prose (an agent node is
paragraphs, not an escaped JSON string), and the front matter is the same YAML-over-Markdown shape
every other authored document in this project already has.

Two conventions are worth taking from elsewhere in the repo. First, a macro that a merge left
conflicted is refused by name rather than half-run, which is the rule the layout templates already
follow. That rule would need retrofitting here: `LAYOUT_ATTRIBUTES_BLOCK` is written once at project
creation, and only the notifications line has an idempotent `ensureGitAttributes`, so every existing
project needs one. Second, the front matter supplies the tooltip. Every interactive element in this
app says what it does on hover, and a macro that appears in a menu is an interactive element, so
`description` is not optional decoration.

The pinned round-trip test leaves one gap, and a hand-written macro file is exactly where that gap
would surface: `NaN` and `Infinity` format as barewords and reparse as strings, and `-0` formats as
`0`. `coerceProps` rejects non-finite numbers, so today such values cannot arrive. A macro file
introduces a new way for them to arrive.

## Where macros live, and how they move

There are two stores, and the split exists for trust rather than convenience.

- **The project repo** — the proposed path is `.vnstudio/macros/<slug>.md`, beside the layout
  templates, and it is committed with the project. A macro stored here arrives with the project. That
  is the point of this location and also its risk.
- **The user folder** holds the author's own files, versioned in its own small git repo, as the todo
  proposes. Versioning it separately is the right call: `.vnstudio/layouts` gets away with living in
  the project's history because the project has a history, and a user-level store has no history
  unless it is given one.

Copy, export and import are ordinary commands (`macro.copy`, `macro.export`, `macro.import`). Copying
a user macro into the project for specialization is a copy rather than a move. A project skill has the
same relationship to a global skill.

Import is the dangerous entry point, and it has a precedent. `upload.files` copies the author's
documents into `archive/` verbatim, outside every directory the agent sweeps, read only by name. A
macro imported from outside should be treated the same way: it is only bytes until a human has read it
and saved it, because a macro runs on the authority of the human who saved it (see below).

## Trust: one confirm, and it is computed — once a field exists to compute it from

The repo already has a rule for this. `run_skill` confirms the first run of a script-bearing skill,
and the raw writers refuse `.aiagent/skills/`, so the script it offers to run is always one a person
put there. Macros need the same shape, with one refinement.

A macro carries one confirm, not one per node, and the card is derived rather than authored.

The card should list what this macro is about to do — every mutating node, every node that spends
money, every node that writes outside the document class — computed at the moment of the click. An
authored "this macro is safe" line only asserts safety, while a list derived from the macro's nodes
cannot go stale when the macro is edited. Deriving the list is still the right design. The first draft
was wrong to assume the catalog could already produce that list.

**The model records `mutating` but not whether a command spends money, and `confirm` is a bad proxy
for spending in both directions.** `Command` and `CatalogEntry` carry `mutating`, `confirm`,
`undoable`, `commitsItself`, `check` and `run`. None of these fields records cost, spend, or the fact
of an API call. Only three of the fourteen `confirm: true` sites concern money:

- `pipeline.run` spends the most of any command in the app and is deliberately not `confirm`. A
  comment at commands/pipeline.ts:26-28 explains why: every entry point to it is already a deliberate
  click on the words "run pipeline".
- `asset.upload`, `asset.adopt`, `asset.replace`, `notify.*`, `view.deleteLayout` and `upload.*` are
  `confirm: true` and spend nothing.

So the derived card needs a new `spends` field on `Command` and a one-time audit of all 108. That work
is real and defensible. It is not the free derivation the first draft claimed. The alternative is the
hand-kept list of money commands that the first draft fell back to two sections later, and that list
is the rotting allow-list the companion report argues against.

The prerequisite is larger than the first draft named. That draft warned that
`pipeline.run(mock=false)` could end up in a macro that never asks for confirmation, but
`pipeline.run` has no `confirm` to inherit. The real gap is one line in
apps/desktop/src/main/index.ts:519-521:

```ts
// TODO(desktop): route through the renderer once a confirm dialog exists; until
// then a `confirm: true` command is reachable only from the UI's own affordances.
confirm: () => Promise.resolve(true),
```

Every caller that is not the palette's own dialog (CDP, the agent, and any macro runner built today)
auto-approves every `confirm: true` command, including `art.generate` and `art.redraw`. The
derived-confirm work therefore begins with a real confirm door in main. A card is the second step, not
the first.

`create_macro`/`edit_macro` own the directory, for the same reason `create_skill`/`edit_skill` own
their own directory: a raw writer that could reach `.vnstudio/macros/` could write (or quietly
rewrite) a macro that `macro.run` then offers behind a confirm card that looks the same whether a
human wrote it last year or the agent wrote it ninety seconds ago.

## The agent node

### Its prompt is inline by default

A macro node's prompt is prose the caller has already chosen, while a skill is prose the agent has to
find. Discovery is the cost that makes registering a skill worth it, and it is pure overhead for a
one-off node. A node therefore takes an inline prompt by default, names an existing skill when one
fits, and offers "save this prompt as a skill" when the author wants that prompt in two macros.
Promotion happens on the second use, never the first. Requiring a skill per node produces a store full
of near-duplicate fragments, which is the failure mode this ordering avoids.

### Mode is the author's, per node

The author picks "plan" or "execute" mode for each agent node. A node in execute mode cannot create
plans.

This preserves the invariant a full bridge would have broken. The model cannot change its own mode.
Mode is owned by the host and the permission gate, which is what makes plan mode a guarantee rather
than a request. A macro that sets the mode is a human setting it one step further back. `setMode` is
public and bypasses approval, so the mechanism a node needs is already there.

It does break one invariant, which the first draft missed. `git_commit` scopes to `this.editedPaths`
and clears them on success, so there is one commit per approved plan. An execute-mode node that never
proposes a plan commits against a set that no plan described. One option is that an execute node does
not commit, leaving the commit to the macro's own bracket, which fits the one-undo-point-per-macro
goal. The other is to relax the pairing explicitly for macro-run agents and write that down.

Withholding `propose_plan` cannot be done by shrinking the catalog. The rendered tool list is
byte-identical for the life of a session (including across a mode change), because a list that moves
invalidates every cached token after it. So an execute node refuses `propose_plan` at dispatch,
exactly as plan mode refuses mutating tools, and says so in an appended `{"role":"system"}` message.
That message uses the same channel the mode itself is filed through. Nothing is removed from the
prefix.

### Questions go through the one door

`ask_user` and `ask_choice` both reach a single `Permission.ask(form)`. The shortlist changes how a
question is presented, not what comes back, and the answer is a string either way. The desktop draws
an ask card and `vnauthor` numbers a list. `answersFor` pads a short reply and drops a long one rather
than throwing. Padding and dropping rather than throwing matters most inside a macro, where a parked
turn that hangs is the worst failure. (`MAX_ASK_QUESTIONS` is four; the desktop draws them in one card
with a single _Submit answers_ button rather than paging, as the first draft claimed.)

The question is visible in only one pane. `permission:ask` is consumed by the Agent/Convo editor and
drawn by `editors/convo.ts`, so a macro's question is invisible when that pane is not open. A floating
popup is therefore a new host rendering, not a third rendering of something that already exists. It is
cheap, because the form shape and the answer contract are settled, but it is still new.

Routing is broken rather than merely unowned. `turnWindow` is a module global set only inside
`handle('agent:run', …)`, and `askWindow` calls `target.focus()`. A question raised by a macro running
in window B therefore focuses whichever window last started an agent turn. A macro runner must carry
the origin window, in the way that `ctx.origin` already tells commands which window asked.

In a macro, informal asking is a failure rather than a stylistic lapse. In a conversation, a model
that asks in prose is merely annoying, and the author answers anyway. In a macro the question reaches
no one: the turn ends, its output feeds the next node, and the question is consumed as data. A line in
the system prompt is therefore not enough to enforce the prohibition, and a node whose turn ends in a
question-shaped answer with no `ask_*` call should be an error rather than a result. (`ask_choice`
exists as a distinct name for a related failure, in which a model asks openly when the sensible
answers could have been listed.)

### The conversation, and what it costs

Each agent node runs as its own turn, against the per-turn token ceiling that already governs one
(`BUDGET_CHOICES`, default 200k, measured on non-cached tokens and checked between steps). A macro run
gets its own thread in `vngen/state/threads/`, which keeps the author's conversation separate and
gives `report.agent` a record to read when a macro's agent node fails. That debugging path is what the
companion report covers.

That thread has nowhere to live yet, and supplying it a home is the agent node's real prerequisite.
`WorkspaceSession.ensureAgent()` memoises a single `Agent`, and `convo`, `thread`, `model` and
`budget` are session singletons — `permission()` records asks into `this.convo`. Reusing the agent
therefore puts the node's prompt into the author's conversation, the exact opposite of the behaviour
described above, and standing up a second one needs a second permission door, a second thread pointer
and a second budget that `WorkspaceSession` does not have. Nothing prevents a collision either:
`busy()` returns the first in-flight label, and its own doc says it is "reported rather than enforced:
nothing here cancels."

The budget does not compose as the first draft assumed, for the same reason. It is per-`Agent`, with
`spent` local to one `run()`. Two concurrent nodes on one agent share one ceiling and interleave their
accounting. A macro node needs its own `Agent`, so `WorkspaceSession` must be extended to hold more
than one.

A fresh conversation costs less than it appears. The cache key is the prefix bytes, and the tools and
system prompt are byte-identical across conversations, so a macro run that starts a new thread still
hits the cached prefix. The mode message is appended among the messages, after the system breakpoint,
so it leaves that prefix unchanged.

## Running one: the affordance, and who owns failure

A macro must not lock the app. An agent node may wait on a question, and the popup that asks the
question is non-modal by design.

The app already has the right surface. A pipeline run raises the task list over the mesh, and a macro
run is the same kind of object: it is long, asynchronous, worth watching, and not worth blocking on.
Reusing that surface is better than inventing a macro-specific progress affordance, and it makes a
macro and a run look alike because they are alike.

Not blocking has two consequences:

**The journal should record when a machine performed an act.** `CommandSource` is `ui | menu | dsl |
cdp | agent`. A sixth value, `macro`, records in `commands.jsonl` which acts a person performed by
hand. The unattended-approval research makes the same argument for placing provenance at the command
layer.

The type change is one line. The two sites that matter are not in the type, and both fail silently:

- `index.ts:548` maps anything that is not `agent` or `cdp` to `'ui'` when it files the
  notification. Every macro-run command would post a notification claiming the author did it. The new
  value exists to remove exactly that false claim.
- index.ts:537 bumps `undoRevision` when `record.mutating && record.source !== 'ui'`, so adding a
  new source changes when the panes treat the worktree as having moved.

The notification vocabulary cannot be extended freely: `NOTIFICATION_SOURCES` is a zod enum and
`readNotifications` drops every line `migrateNotification` cannot parse. Because `notifications.jsonl`
is union-merged, an older build reading a `macro`-sourced line silently deletes the author's
notification. The per-line versioning exists to prevent that deletion, and a new source value has to
be introduced through the versioning rather than around it.

**The macro runner owns the failure policy, declared once for the macro rather than on each node.** A
non-modal popup lets the author move the state a parked macro is halfway through, so a command that
re-decides at run time may then refuse. That refusal is the correct behaviour arriving at an
inconvenient moment. Something has to choose stop, ask, or skip when a command refuses, and the macro
runner is the honest owner of that choice, because the policy is declared once for the macro instead
of as a field on every node.

The target is one undo point per macro, and the undo stack does not support that yet. There is no
batch bracket, so each undoable command becomes its own snapshot. Adding one is a prerequisite shared
with the companion report's position E. Until it lands, undoing a macro takes one step for every step
the macro took.

## The invocation dialog

The open question is whether a dialog with unset tool inputs is shown on invocation. The machinery for
it already exists. `openCommandDialog(id, props)` already shows a single command on its own: its
title, what it does, its fields, its verdict, and a button labelled with the command. A macro's
declared inputs are drawn by the same `CommandForm`: `blankProps` seeds each field from its default, a
`boolean` input is drawn as a checkbox, a `multiline` input uses the shared writing box, a `directory`
input gets Browse, and `FormOptions.choices` supplies option lists computed when the form opens.

So the Macro Editor's "hide these in the dialog in favour of defaults" needs no new widget. It is an
input node that declares a default, so the dialog does not ask for it. A macro with every input
defaulted runs straight from its row, exactly as a command with no props does.

Two things make it not reusable as-is. `openCommandDialog` is a singleton that returns early when one
is already open (dialog.ts:114), so a macro that asks for its inputs while any dialog is up does
nothing at all: no error, no queue. And `CommandForm`'s constructor takes a `CatalogEntry`, so drawing
a macro's inputs requires either synthesising a catalog entry for something that is not a command or
widening the form to take a prop map. Both changes are small, but each takes work, and a macro run
parked behind a silently dropped dialog fails in a way that looks like a hang.

## Where a macro appears

Nobody uses a macro twice if it only lives in the palette. Putting one in a right-click menu makes it
an author's own tool. This is the part of the design with the most ways to go wrong, because two
stores must merge into one menu and every row has to report whether it can run.

### Placement metadata belongs in the macro, not in a menu document

A menu-layout document per level causes merge conflicts: two people appending to the same menu
conflict on the same line, every time. The project can own the arrangement for layout templates,
because a conflicted template is refused by name and a broken layout costs one missing template. A
conflicted menu cannot be refused, because a right-click has to open.

Carrying the placement inside each macro reduces the merge to a union of two directories, which git
performs automatically. The same reasoning keeps `notifications.jsonl` versioned per line so git can
union-merge it, and it lets the project and user stores both contribute to one menu without a merge
policy existing anywhere.

### Identity is a slug, so the project shadows the user

The obvious dedup rule collapses identical macros and appends `(Project)` and `(User)` to macros that
share a name but differ. That rule misfires on the workflow this report calls the expected one.
Copying a user macro into the project to specialize it is a copy rather than a move, so the copy then
differs and the author gets two rows for the macro they just customized. Two rows for one customized
macro is the wrong result. The rule also needs a definition of "identical": byte equality splits one
row into two over a line ending, on the platform this app is developed on, or over a formatting pass.

A macro carries a stable id (its slug) separate from its display name. If the project and the user
define macros with the same id, the project's macro shadows the user's. Only one row appears, with no
warning, and its tooltip says the macro was overridden. The `(Project)` and `(User)` suffixes apply to
different ids that happen to share a display name.

Project skills and per-project instructions already follow this rule. It removes the byte comparison
entirely, and it reserves the suffixes for the case where two people both name one "Fix portraits".

### Ordering is within a store, because a macro cannot reorder a file it does not own

Fractional sort keys are the right choice, and at this scale the case is clear: inserting between two
rows writes one macro rather than renumbering a menu. Note that midpoints exhaust after roughly fifty
inserts between the same pair, so a renormalize pass is needed at that point (or LexoRank-style keys,
which do not exhaust). Ties are broken lexicographically by name.

The structural problem is cross-store ordering, not precision. If order lives in the macro, putting a
user macro between two project macros means editing a file in a store the author may not own, may not
have checked out for writing, and will certainly be conflicting with somebody over.

Prevent the problem instead of solving it: draw the menu grouped by store, with built-ins first, then
project, then user, separated from each other. Ordering then happens only within a group, and each
group sits within a store the author owns. If cross-store ordering is needed later, a sparse
per-project overrides file keyed by macro id carries reorderings and never the menu itself, so it
produces far fewer conflicts than a layout document.

Grouping is worth doing for two reasons. A project whose macros arrive pre-placed in the author's
right-click menus exposes a larger surface than a project that merely contains macros: a project macro
named "Delete" landing where "Duplicate" used to be is a real trap. Keeping project rows in their own
block means that opening a project does not disturb the author's muscle memory.

### Anchors have to be named before any of this can be written down

A macro names where it applies, and that vocabulary already covers most of the need — further than the
first draft credited. All three `showContextMenu` call sites go through a named, pure builder:
`menuFor(row.node)` from the Documents tree, `menuFor(assetNode(this.shown))` from the Asset pane, and
`lineMenu(…)` from Script. `menuFor` lives in the renderer
(apps/desktop/renderer/pathux/doctree.ts:228), switches on `node.kind`, and its doc comment already
states the discipline this section wanted to introduce: "kinds with nothing to offer answer with an
empty list, and are named here rather than falling through silently."

So the anchor vocabulary is essentially `DocNodeKind` plus one script-line anchor, and the remaining
work promotes it to a declared list in one place, the way `EDITORS` names the thirteen editors, rather
than inventing a new vocabulary. Two other needs converge on that list: `resolveAnchor` in the guided
tours plan needs the same vocabulary, and the list answers which surfaces a macro appears on.

Naming an anchor does not settle which prop receives its subject. `menuFor` uses a different name per
kind: `subject:` for `art.generate`, `target:` for `art.setNotes`, `hash:` for the `asset.*` acts,
`editor`/`where`/`subject` for `view.open`. So an anchor has to declare the shape of what it offers (a
hash, a document path, a character id) and a macro's root node has to say which of its props takes it.
The refusal "the anchor's subject did not resolve" is therefore one refusal per anchor shape rather
than a single refusal.

Once macros name anchors, retiring one breaks user macros silently. A macro that points at an anchor
that no longer exists is treated as a visible hole: it is listed as requesting a menu this build does
not have, and it is not dropped. `menuFor` already states this rule for a new node kind.

### The two universal rows

`…add macro` and `…create new macro` are worth having on every menu, and both must be commands
(`macro.attach(anchor=…)`, `macro.create(anchor=…)`) rather than callbacks. Each entry invokes a
command, which is how every entry in `contextmenu.ts` works. A prop with a default selects which store
the new macro lands in, rather than a third row.

This consequence should be decided rather than inherited. `menuFor` deliberately returns `[]` for
kinds with nothing to offer, and `showContextMenu` opens nothing at all for an empty list. A universal
footer means every surface now opens a menu. That is probably an improvement, but it retires a stated
decision.

### Reordering by right-clicking a live menu is the risky part

path.ux opens its menus through `startMenu`/`createMenu`, and `menuWrangler` closes them on mouse-up,
so a second menu opened over a live one conflicts with it. A `Customize this menu…` row that opens a
small ordered-list dialog for that anchor applies the same approach as the palette serving as the
guaranteed floor in the tours plan. That row avoids the conflict and gives enable/disable a home.

Changing path.ux itself is possible, though — it is our own submodule, compiled from source through a
vite alias, and it has been extended for this app before. If in-menu reordering turns out to be the
affordance worth having, changing the wrangler to accept a right-click that does not dismiss the menu
is a legitimate fix rather than something to design around. The recommendation above is about
sequencing. The dialog is available now and costs nothing, so the wrangler change should be made
because in-menu reordering proved worth it, not to make the feature possible in the first place.

## Whether a macro row can run, and how it says so

### Greying is available, and the struck-through glyph can retire

`contextmenu.ts` says path.ux's menu has no per-item disabled state, so a refusal is drawn with a
combining enclosing no-symbol and clicking it reports the sentence. The claim holds for the template
and not for the widget. `MenuTemplateCustom` is a positional array with no disabled slot, but
`addItem` builds a real `li.menuitem`, pushes it onto `menu.items`, and already sets `li.title` for
the tooltip. The menu is DOM rather than canvas (the `<canvas>` in there is a text-measuring
scratchpad), so styling a row is ordinary CSS.

Two routes exist, and the first is better:

- **Upstream it.** The object-based entry API of `createMenu` (`{name, callback, hotkey?, icon?,
  tooltip?, id?}`) is where a `disabled` field belongs. path.ux is our submodule, so changing it is a
  normal move here rather than a last resort.
- **Post-process.** Choose this if the vendor is to stay untouched for now. Style the refused rows
  in `menu.items` after `createMenu` returns. Look them up by id rather than by index: `seperator()`
  appends a bare `<div class="menuseparator">` to `this.dom` and never pushes onto `items`, so
  template index and item index diverge the moment a menu has a separator. The existing convention of
  giving every row an explicit id makes that lookup safe.

The first draft described this as adding a field, but the change is wider. The widget does not consult
a disabled flag today, so four paths would each still reach a greyed row: the keyboard walk over
`this.items`, `_onselect → cbs[id]()`, the focus/blur handlers, and `autoSearchMode`, which engages
past fifteen items. Menus that carry macros are the long ones. The `disabled` sub-block in path.ux's
theme sits on the `button` style class rather than `menu`, whose keys are only
`MenuBG`/`MenuBorder`/`MenuHighlight`/`MenuSeparator`/`MenuSpacing`/`MenuText`. Greying needs a new
theme key and a `gen:themes` run.

None of that changes the behaviour; it changes only the cost. `take` already declines and says the
sentence rather than executing, so a refusal is still shown rather than hidden. The refusal is no
longer written with a glyph.

### The verdict is the root node's, and only the root's

The reason is not cost.

Checking past the root is wrong. `stack.check` answers about the current state, but node 2 runs
against the state that node 1 produced.

Today, node 2 of a macro that creates a scene and then edits it refuses with "no such scene", and the
macro it rejects is correct. The check fails worse on well-written macros than on broken ones. Once
outputs are wired, a later node's props do not exist until an earlier node runs, so there is nothing
to check against.

The Macro Editor's single-root-tool-node rule therefore serves a second purpose. The root is the only
node whose props are fully determined at menu time, from the selection and the macro's inputs, so the
root is the only node that can be checked there. The root is also the node that matters, because a
click runs the root first.

### Three refusals that cost no round trip

`MenuEntry.refused` already exists for exactly this shape (a precondition about what the entry would
name rather than about the project). It covers the imported-macro cases a check cannot:

- **A node names a command this build does not have.** The catalog supplies a static message: _Uses
  a command this version does not have: `art.promote`._ This follows the visible-hole rule: the row
  stays in place instead of being dropped.
- **The anchor's subject did not resolve** — the macro is attached to the asset menu, and the
  right-click landed where nothing names an asset.
- **The macro did not parse, or is conflicted** — the macro is refused by name.

### What the tooltip says

`li.title` is a DOM title, so it takes more than one line:

    Repin every suspension Cannot run `art.setNotes`: no character is selected.

The first line is the macro's `description`, already required and already its tooltip. The second line
names the step. Naming the step matters more for a macro than for a plain command row, because a macro
is opaque, so a bare "no character is selected" leaves the author guessing at a sequence they cannot
see. The step's own sentence passes through verbatim, following the rule that a disabled control's
tooltip gives the reason it refuses.

Two constraints apply to the wording:

- **An enabled row does not promise success.** An accepted root means the macro's first step would
  be accepted now, not that the macro will succeed. Step four can still refuse, and that failure
  belongs to the runner. So an enabled row's tooltip stays descriptive and never says "this will run".
- **Cost is annotated, not refused.** The tooltip states when any node is a paid one, computed from
  the same catalog flags as the derived confirm card.

### What it costs to draw

The root check runs in the `Promise.all` that already issues `command:check` for each of a menu's
entries, and it takes one more positional slot per macro. `needsCheck` extends so that a macro needs a
check if and only if its root is checkable. The round-trip shape does not change.

Macro definitions should get the same treatment as command descriptions. Fetch each definition once,
keep it for the life of the window, and invalidate it on a `macro.*` write, so a right-click never
touches the filesystem. `startMenu` is synchronous and every check is awaited before anything is
drawn, so this work has to fit in the time before that first draw.

## Preview mode

Two questions were open. The first question was whether to preview in the author's own repo and revert
with git, or to clone the project (and eventually the wiki repo). The second question was what preview
does about the pipeline.

**Revert-in-place, not a clone.** The shadow-snapshot mechanism already brackets a command with
detached commits under `refs/vn/undo/<seq>/{pre,post}` without moving HEAD or touching the index, and
it refuses rather than guesses when the tree drifted. A preview applies that same bracket around a
whole macro. Cloning costs more at every size: the asset store is content-addressed across two roots,
so a clone doubles the bytes that matter most, and a separate wiki repo would multiply those bytes
again.

But the snapshot pathspec excludes `vngen/build` and `vngen/state`, which is where a pipeline run
writes its output. That exclusion is the intended boundary, not a gap to close:

Preview can revert documents, but it cannot recover money that has already been spent.

The first draft stopped there and concluded that preview forces the mock path. Three findings make
that conclusion premature, and together they show that preview runs at a later stage than the first
draft assumed.

### The bracket is wider than per-command undo, in the direction that hurts

`UNDO_PATHS` excludes `vngen/build` and `vngen/state`, so base art under `assets/` is inside the
snapshot. `art.generate` is explicitly `undoable: false` "because it writes new content-addressed
bytes, so there is no prior state to restore to". A macro-level bracket would revert that art anyway.
It would not preview a document edit; it would delete exactly the bytes the per-command design
declined to touch.

The pathspec has to narrow before a bracket is safe to wrap a macro in. The preview spec excludes both
generated roots and is distinct from the undo spec. The change is small and load-bearing.

### Discarding a preview poisons the undo stack it shares

Every per-command `pre`/`post` point taken during the macro describes a tree that no longer exists
once the preview is thrown away. `UndoJournal.check` rejects each of them with the message "the
workspace has changed since that command ran", and they stay in the journal until enough unrelated
work pushes them past `prune()`'s keep-50. A long macro can also push its own refs past that window
before it finishes.

Step 4 below already needs a batch bracket, and it gives the same rule. A macro takes one undo point,
not one per node. If the macro's commands do not take individual points, there is nothing for the
discard to invalidate.

### Preview cannot force mock today

`WorkspaceSession.mock` is `readonly`, fixed at construction from the launch flag, and it alone
controls whether art is real (`art: workspaceArtGen(workspace, { mock: this.mock })`). Of the "money"
(cost-incurring) commands, only `pipeline.run` takes a `mock` prop; `art.generate`, `art.redraw` and
`asset.regenerate` have none.

So "preview forces the mock path" means adding a `mock` prop to every money command and threading a
session-level override, which is the per-command migration this report elsewhere argues against. Until
that exists, the only truthful option is narrower: a preview refuses to contain a money command at
all, and reports which node it refused. That refusal is a worse feature, but it is truthful and it is
available now.

The todo suggests that "perhaps there could be a 'dry-run only' option for preview". That suggestion
is right, and a dry run should be the only option rather than a checkbox. The suggestion cannot be
implemented by pinning a flag that mostly does not exist.

## Authoring a macro with the agent

A subagent system is not needed for this, and should not be justified by it. A macro-writing agent
writes a text file, and what it needs is context: the catalog, what each command refuses, and what a
well-formed macro looks like. That context comes from a skill plus the read-only bridge the companion
report already recommends. `command.check`, `interaction.targets` and catalog introspection answer
exactly the questions a macro author asks, and they are non-mutating, so they cost nothing to grant.

Position B is what a macro-writing agent needs. The two arguments converge on the same increment from
opposite sides.

Subagents (a fork, a specialised child, a hierarchy to navigate, and a prompt asking whether to return
to the prior conversation) are a real feature with independent motivation (long side quests that
should not pollute a thread). They should be designed against that motivation. Attaching them to macro
authoring would add a lot of machinery for a job a loaded skill does.

## How guided UI tours fit

They are the same object with two runners.

A tour step is an invocation validated by `stack.check` before it is shown, and a macro node is an
invocation validated by `stack.check` before it runs. The anchors plan's `Action` (`{id, props}`,
computed as data before the click) is a macro node, and its `Offer` supplies the verdict shown on a
macro's confirm card. The palette stays available to both: an unanchored tour step opens the command's
form prefilled, and a macro opens that same prefilled form for an input it must ask for.

The only difference is who acts:

A tour never performs the step. A macro always performs the step.

This suggests one step representation and two runners rather than two vocabularies. It also opens a
pipeline that is better than either feature alone: the author's own history (`commands.jsonl`) is
recorded into a macro, and the macro is projected into a tour that shows someone else how to perform
the steps by hand.

## Staging

Revised after the pressure test, which moved most of the work earlier. Two of these are prerequisites
that the first draft treated as details.

0. 0. **A real confirm handler in main**, replacing `confirm: () => Promise.resolve(true)`. This is
   not macro work, but every caller that is not the palette auto-approves today, so a macro runner
   built before it would approve `art.generate` without asking. Nothing below is safe without it.
1. 1. **Named anchors.** Promote the vocabulary `menuFor` and `lineMenu` already switch on to one
   declared list, and say what subject shape each anchor offers. This change is not user-facing.
   Everything below needs it, as does `resolveAnchor` in the tours plan.
2. 2. **The recorder.** Captures pre-digest props in `exec` for an in-memory recording session. The
   recorder is a feature, not a filter over `commands.jsonl`; see [the file
   format](#recording-is-not-filtering-the-journal).
3. 3. **Linear macros, selection-first, no editor.** Macros run from the palette and are stored at
   `.vnstudio/macros/<slug>.md`. Inputs go through `CommandForm`, which needs its singleton and its
   `CatalogEntry` constructor loosened. There are no agent nodes, no outputs, and no graph.
4. 4. The batch undo bracket and `source: 'macro'`. The `source: 'macro'` change includes the
   notification mapping and the zod enum migration; without them the new value is a silent data loss
   on an older build.
5. 5. **Menu placement** — the macro carries placement metadata, checks run on the root only, greyed
   rows show the step's own sentence, and `macro.attach`/`macro.create` appear on every anchor.
6. 6. **A `spends` field on `Command`.** The field and the one-time audit of 108 make the confirm card
   derived rather than hand-kept.
7. 7. **Preview** — Narrows the pathspec first, then the bracket. Refuses money commands until they
   take a `mock` prop.
8. 8. **Agent nodes** — adds a second `Agent` to `WorkspaceSession` first, then inline prompts,
   per-node mode, refusal of `propose_plan` at dispatch, and the floating ask popup with an origin
   window.
9. 9. **The user-folder store**, its repository, copy/export/import, and the shadow-by-id and
   group-by-store rules that apply only once there are two stores.
10. 10. **Declared outputs.** Outputs are declared per command and on demand, together with the wiring
    notation that the file format defers.
11. 11. **The Macro Editor** — covers the DAG, input nodes, hidden inputs, and the single-root rule.

Steps 0–5 are worth having even if nothing after them is ever built, and that is the test a first
stage should pass. Step 0 is worth doing whether or not macros are ever built at all.

## What is still open

- **Undoability.** Is a macro undoable at all, or merely bracketed for preview? A macro containing
  `pipeline.run` straddles both data classes, and undo deliberately does not cover that case.
- Whether the confirm card's derived list is enough for a macro imported from elsewhere, or whether
  an imported macro should require a read-through before its first run.
- **The menu bar and keyboard shortcuts.** The preceding sections cover right-click menus. Whether a
  macro may also claim a menu-bar entry or a key raises the same placement question, and these two
  surfaces have far less room and a much higher collision cost.
- **An agent node returns its outputs to the next node** once outputs exist. Prose is not a typed
  output, and `extractJson` already exists to survive asking a model for JSON.
- **Whether the DSL gains an interpolation form, or macros keep the wiring beside the steps.** This
  report assumes macros keep the wiring beside the steps. An interpolation form is defensible if the
  palette and CDP have a sensible answer for `$1` outside a macro.
- **Whether a macro-run agent node commits at all.** `git_commit` scopes to `editedPaths` and pairs
  with an approved plan. An execute-mode node has no plan, and the macro's own bracket may be the
  better place to draw that boundary.

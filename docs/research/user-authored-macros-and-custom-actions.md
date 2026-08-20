# Custom actions: user-authored macros over the command palette

Status: **research**. Nothing here is planned work. The companion report —
[`agent-access-to-the-ux-command-system.md`](agent-access-to-the-ux-command-system.md) — settles
the question this one assumes: **the agent does not get the registry**, and composition is the
macro system's job rather than a widened tool list.

A **custom action** is a macro: a saved, named, re-runnable sequence built out of the commands the
palette already lists, plus nodes that call the agent. This report works through what that costs
and what it can rest on.

<!-- toc -->

- [The two decisions it rests on](#the-two-decisions-it-rests-on)
- [What a macro is made of](#what-a-macro-is-made-of)
- [Selection-first, and why outputs come second](#selection-first-and-why-outputs-come-second)
- [The file format](#the-file-format)
- [Where macros live, and how they move](#where-macros-live-and-how-they-move)
- [Trust: one confirm, and it is computed](#trust-one-confirm-and-it-is-computed)
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
copy-pasteable repro line.** Every `CommandRecord` carries `invocation` for exactly that purpose,
`parseCommand(formatCommand(x)) ≡ x` is pinned by a round-trip test, and parse errors carry a column
so a bad macro can be pointed at rather than merely rejected.

The consequence is the good one: **recording a macro is filtering the history.** An author does the
thing once, and `commands.jsonl`'s `invocation` field is the macro. No recorder to write, no second
serialization of an invocation, and what the file says is what the journal said.

A shape that carries both halves — structure in front matter, prose where prose belongs:

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
prompt.repin(hash=$1 chunk=$2 ref=$3 regenerate=$regenerate)
```
````

Three properties this buys: it diffs as text, the prose stays prose (an agent node is paragraphs,
not an escaped JSON string), and the front matter is the same YAML-over-Markdown shape every other
authored document in this project already has.

**Two conventions worth taking from elsewhere in the repo.** A macro that a merge left conflicted is
**refused by name** rather than half-run — the rule layout templates already follow. And the front
matter carries the tooltip: every interactive element in this app says what it does on hover, and a
macro that appears in a menu is an interactive element, so `description` is not optional decoration.

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

## Trust: one confirm, and it is computed

The rule the repo already has: `run_skill` confirms the first run of a script-bearing skill, and the
raw writers refuse `.aiagent/skills/` so that _the script it offers to run is always one a person
put there_. Macros want the same shape, with one refinement.

> **A macro carries one confirm, not one per node, and the card is derived rather than authored.**

The catalog knows which entries are `mutating` and which are `confirm`, so the confirm card can
**list what this macro is about to do** — every mutating node, every one that spends money, every
one that writes outside the document class — computed from the catalog at the moment of the click.
An authored "this macro is safe" line would be a claim; a derived list is a fact, and it cannot go
stale when the macro is edited.

**One prerequisite, and it is the same one the companion report names.** `confirm: true` is still
auto-approved for every caller but the palette. A macro must not inherit that silently: either
follow-on 2 lands first, or the decision that a macro's own confirm subsumes its nodes' confirms is
made explicitly and written down. Defaulting into it is how `pipeline.run(mock=false)` ends up
inside a macro that never asked.

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

**Withholding `propose_plan` cannot be done by shrinking the catalog.** The rendered tool list is
byte-identical for the life of a session _including across a mode change_, because a list that moves
invalidates every cached token after it. So an execute node refuses `propose_plan` **at dispatch**,
exactly as plan mode refuses mutating tools, and says so in an appended `{"role":"system"}` message
— the same channel the mode itself is filed through. Nothing leaves the prefix.

### Questions go through the one door

`ask_user` and `ask_choice` both reach a single `Permission.ask(form)`; the shortlist is how a
question is _put_, not what comes back, and the answer is a string either way. The desktop draws an
ask card and `vnauthor` numbers a list, so **a floating conversation popup is a third host rendering
of a door that already exists**, not a new mechanism. `Permission.ask` already takes a form of up to
four questions and pages through it, and `answersFor` pads a short reply and drops a long one rather
than throwing — which matters more inside a macro than anywhere else, since a parked turn that hangs
is the worst failure a macro can have.

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

A macro says where it goes by naming something, and that vocabulary does not exist yet. Today it is
implicit: `menuFor` switches on `node.kind` — `location`, `character`, `wikidir`, `skill`, `asset`,
and the rest — while the asset and script editors build their own entries inline with no name at all.

**So the context menu builder's first job is to give those anchors declared, stable names in one
place**, the way `EDITORS` names the thirteen editors. It is cheap, and it converges with two other
things: it is the same vocabulary `resolveAnchor` needs in the guided tours plan, and it is what
answers "which surfaces does a macro appear on".

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

path.ux's menu is a canvas-drawn widget from `startMenu`/`createMenu`, and `menuWrangler` closes on
mouse-up — a second menu opened over a live one is fighting it. A `Customize this menu…` row that
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
the tooltip. path.ux's theme even carries a `disabled` sub-block to draw from.

Two routes, and the first is better:

- **Upstream it.** `createMenu` already has a newer object-based entry API —
  `{name, callback, hotkey, icon, tooltip, id}` — with an obvious slot for `disabled`. Moving the
  desktop off the array form onto that turns greying into a field instead of a glyph. path.ux is our
  submodule; changing it is a normal move here, not a last resort.
- **Post-process**, if the vendor is to stay untouched for now: style the refused rows in
  `menu.items` after `createMenu` returns. Look them up **by id, not by index** — `seperator()`
  appends a bare div and never pushes onto `items`, so template index and item index diverge the
  moment a menu has a separator. The existing convention of giving every row an explicit id is what
  makes that lookup safe.

Either way it is presentational only. `take` already declines and says the sentence rather than
executing, so **a refusal is still shown rather than hidden** — it just stops being spelled with a
glyph.

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

So preview forces the mock path for anything that costs: `pipeline.run` pinned to `mock: true`, and
the model-calling commands (`art.generate`, `art.redraw`, `story.decomposeAll`, `prompt.condense`)
and any agent node either refused or run against mock providers, with the card saying which. The
todo's own instinct — _"perhaps there could be a 'dry-run only' option for preview"_ — is the whole
answer, and it should be the **only** option rather than a checkbox, because the alternative is a
preview that quietly bills the author for a rehearsal.

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

1. **Named anchors.** One declared list of the places a menu can be extended, and `menuFor` plus the
   two editors that build entries inline moved onto it. Nothing user-facing, and everything below —
   plus `resolveAnchor` in the tours plan — needs it.
2. **Linear macros, selection-first, no editor.** Record from history, run from the palette,
   `.vnstudio/macros/<slug>.md`, dialog via `CommandForm`, one derived confirm card. No agent nodes,
   no outputs, no graph.
3. **Menu placement** — placement metadata in the macro, root-only checks, greyed rows with the
   step's own sentence, `macro.attach`/`macro.create` on every anchor.
4. **The batch undo bracket** and `source: 'macro'`. Makes a macro one act in the journal and one
   step in undo.
5. **Preview**, as a snapshot bracket with the mock path forced.
6. **Agent nodes** — inline prompts, per-node mode, `propose_plan` refused at dispatch in execute,
   questions through the floating popup, own thread.
7. **The user-folder store**, its little repo, copy/export/import, and the shadow-by-id and
   group-by-store rules that only bite once there are two stores.
8. **Declared outputs**, per command and on demand.
9. **The Macro Editor** — the DAG, input nodes, hidden inputs, the single-root rule.

Steps 1–5 are worth having if nothing after them is ever built, which is the test a first stage
should pass.

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

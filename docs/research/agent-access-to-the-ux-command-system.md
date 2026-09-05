# Giving the agent the UX command system

Status: research. Nothing here is planned work.

Should `vnauthor` reach the desktop's 108 registered commands directly, exposing every
command as a tool and routing each call through `stack.exec`? Or should `vnauthor` and the
desktop stay as they are, sharing decisions while keeping separate entry points?

This report argues against a full bridge and proposes two smaller changes that together
provide most of the value. The first is a read-only bridge for the reads a bridge is best
suited to: `check`, `targets`, the introspection reads, and `view.*`. The second applies
to anything that writes: move the implementation down into a package that both hosts wrap,
rather than exposing the registry to a model. Composition is left to the macro system,
which builds on the palette, rather than to a widened tool list. The macro work assumes
this conclusion, and the reasoning is recorded here so that the assumption rests on a
decision rather than on inertia.

<!-- toc -->

- [Where the seam is today](#where-the-seam-is-today)
- [What a full bridge would buy](#what-a-full-bridge-would-buy)
- [What it would cost](#what-it-would-cost)
- [Debuggability, and who pays for it](#debuggability-and-who-pays-for-it)
- [The four invariants a naive bridge breaks on day one](#the-four-invariants-a-naive-bridge-breaks-on-day-one)
- [Five positions, and what each is worth](#five-positions-and-what-each-is-worth)
- [What macros ask of the command system, and what the agent does not](#what-macros-ask-of-the-command-system-and-what-the-agent-does-not)
- [Recommendation](#recommendation)
- [If a mutating bridge is built later](#if-a-mutating-bridge-is-built-later)

<!-- tocstop -->

---

## Where the seam is today

`CommandSource` already includes `'agent'`. The plumbing is present and unused by design.
[`../reference/command-system.md`](../reference/command-system.md#from-the-agent) states
the shipped position: "the agent and the commands share the decisions rather than the
transport."

Concretely:

|            | Agent                                           | Desktop                                          |
| ---------- | ----------------------------------------------- | ------------------------------------------------ |
| Vocabulary | 41 tools (`packages/authoring/src/tools.ts`)    | 108 commands (`apps/desktop/src/main/commands/`) |
| Validation | zod `safeParse` in `Agent.dispatch`             | `coerceProps` in `CommandStack`                  |
| Gate       | plan/execute mode + `Permission.ask`            | `confirm: true` + the palette's second click     |
| Record     | thread JSONL + one git commit per approved plan | `commands.jsonl` + shadow-snapshot undo          |
| Refusals   | `@vn/scriptedit`, `@vn/model`, `@vn/artgen`     | **the same modules**                             |

The last row matters most. `edit_scene`'s twelve ops are named after the `story.*`
commands and run the same `lineops` decision; `set_outfit` maps to the two outfit
commands, and `edit_branches` maps to `branchops`. An author who reads a refusal mid-drag
sees the same sentence the agent gets back. The duplication covers transport only, and the
judgement stays in one place, so there is no second copy of a rule to fall out of sync.

The layering forces this in one direction: `@vn/authoring` may not import an app, so a
bridge can only be host-wired, with the desktop handing its stack to `ToolContext`.
Host-wiring is the first cost, and it is structural rather than incidental (see below).

---

## What a full bridge would buy

**1. One audit log.** Today three sources record an agent turn: the thread transcript, the
git commits, and `@vn/agentreport`, which stitches them together. A bridged agent writes
`commands.jsonl` rows with `source: 'agent'`, `gitHead`, `gitDirty` and a copy-pasteable
`invocation`. The "acting record" in `report.agent` would then be recorded rather than
reconstructed.

**2. One undo history.** Agent edits become undo points on the same shadow-snapshot stack,
so an author can step back through a mixed session without tracking whether the author or
the agent made each edit. Today undo covers the author's edits and git covers the agent's
edits, and those two histories do not interleave.

**3. Coverage without writing a tool per act.** The agent cannot currently promote a
concept, adopt bytes onto a slot, edit a prompt clause, attach a reference, repin a
suspension, save a layout, or open a pane. Those are 60-odd acts with no tool. Under a
bridge, every command registered later becomes agent-reachable the day it is registered.
The palette relies on that same property, drawing its entries from the catalog rather than
from a hand-kept list.

**4. `check` serves as a planning oracle.** `stack.check` answers
`accept | refuse | undeclared` with the sentence the command itself would give. It is
read-only, and asking is free. `stack.check` is a better planning primitive than anything
else the agent has, and `interaction.targets` does the same for gestures: it reports which
insertion points in this scene would reorder anything and what each one would run.
`script.moveLine` was explicitly designed and tested to answer that question before any
drag existed.

**5. The schemas are already emitted.** `toCatalog` produces a JSON Schema per command,
and follow-on 3 already specifies feeding those to `NativeAgentBackend` in place of
`LOOSE_PARAMS`. The pieces already fit together, so nothing needs inventing.

**6. The agent could open the pane instead of describing it.**
`view.open(editor='asset' subject=<hash>)` opens the sheet, rather than the agent saying
"her sheet is out of date". This is the single most author-visible win, and the
[guided tours](../plans/archive/guided-ui-tours.md) plan already assumes it as a
prerequisite — though that plan requires the agent to reach anchors through a `tour.*`
command rather than through the map directly.

---

## What it would cost

**1. The tool catalog is sent as a cached prefix, and deferring it triples the search
space.** `apps/desktop/dist/commands.json` is 131 KB for 108 commands, roughly 30–35k
tokens if sent whole, against the six schemas `toolSpecs()` currently sends up front.
Deferred loading plus BM25 search keeps that cost manageable: the prefix stays
byte-stable, so the cache holds. But the search space grows from 41 named acts to ~150,
most of them near-synonyms of each other (`story.insertLine` beside
`edit_scene(op=insertLine)`), and each search result spends context on every turn. The
cache invariant still holds, but retrieval quality degrades.

**2. Two names for one operation are worse than one missing name.** If both `edit_scene`
and the nine `story.*` prose commands are advertised, the model picks between them
arbitrarily, and the two paths are not equivalent. `edit_file` depends on the read ledger,
while `doc.write` refuses by `seenHash`. `insertLines` writes a run of prose in one call
with one refusal, while `story.insertLine` writes one line. The create tools take a whole
sheet, so a character is created in one call rather than created and then immediately
edited. Those are affordances shaped for the agent. A bridge that keeps them keeps the
ambiguity, and a bridge that deletes them loses the batching, the ledger, and the single
entry point for the round-trip guarantee.

**3. Granularity.** A command records one act by a person, sized deliberately to what a
person does by hand. A drag in the branch editor is one command and one record, not a
stream of them. An agent drafting a scene emits forty. Commit-on-save turns those forty
into forty commits, the journal turns them into forty undo points, and the loop turns them
into forty round-trips against a per-turn token ceiling. The stack has no batch or
transaction concept, and `agent.run` sets `commitsItself: true` because the agent commits
an approved plan rather than each act within it.

**4. Commands return prose.** `CommandOutcome.message` is written for a message line. Some
commands carry `data`; most do not. A model reading "Showing Coverage below." learns less
than it would from a tool return designed to be read. Giving commands a second,
machine-facing projection would state the same thing twice, which
[`../plans/archive/guided-ui-tours.md`](../plans/archive/guided-ui-tours.md) §8 rejects
for the anchor map.

**5. "Full" is not achievable, so a second list appears.** A dozen commands are
meaningless or hostile from an agent: `workspace.chooseDirectory`, `upload.pick`,
`workspace.pick` and `asset.replace` open native modals; `view.palette` opens the finder;
`window.quit` quits. A bridge therefore needs a per-command disposition, and a hand-kept
allow/deny list falls out of date, which is the anchors plan's whole thesis. The
disposition can be made structural as a field on the definition where absence means deny,
mirroring the rule that `undeclared` is not permission, but that is a migration across 108
definitions and a test that pins the set.

**6. Host divergence.** Since the bridge must be host-wired, the desktop agent gets 108
commands and the terminal `vnauthor` gets none. The single agent then carries two
capability sets, and a skill written against `asset.adopt` silently fails in the REPL.
Today the tool list is the same on every host, and that uniformity is worth something.

**7. Drift refusals under interleaving.** Undo refuses rather than guesses when the
worktree moved. An agent running a long turn of undoable commands while the author clicks
in another window produces exactly that interleaving, and the resulting refusals are
correct but read as flakiness.

**Every refusal string constrains what the model does next.** 64 checks written for a
person to read in a message line would instead be parsed by a model deciding what to do
next.

---

## Debuggability, and who pays for it

`report.agent` reads a saved transcript plus the act log, uses the bound model for one
call, and runs on the author's own key. If that read ever becomes automatic (funded by a
key the project provides to selected users), the project pays the bill, and that bill
grows with the length of the transcript.

A bridge lengthens transcripts in two ways. It enlarges the tool space searched per turn,
and it produces forty `story.insertLine` records where `insertLines` produces one call.
The coupling is real and it compounds: a bridge forces command-grained acts,
command-grained acts lengthen threads, and longer threads make the automated read more
expensive, at a cost paid per user.

Against that, a bridged agent's evidence is better per token, because a replayable
`invocation` with `gitHead` and `gitDirty` beats reconstructing intent from prose. A
bridge could therefore lower cost-per-act while raising acts-per-turn. The variable is
granularity, not transport, which is why position E addresses this and position D does
not.

The subtler cost is that the two systems stop having separate requirements. Under a bridge
the acting record and the transcript share one vocabulary, and every refusal sentence
(written for a message line under a greyed button) becomes a model-facing contract. The
debug agent then files reports asking for UI text to be reworded so a model stops
retrying, and there is no principled place to decline, because a single system now serves
both the reader and the model. If the two systems stay separate, that request is a
category error rather than a judgement call. The redaction problem grows too. A
`story.setLineText` invocation carries the author's prose in its props, so the leak scan
that `report.openIssue` runs would have more surface to be wrong about.

Sharing the record format is not the same as sharing the registry, and the format is the
half worth sharing. The loop could append its tool calls to their own log in
`CommandRecord`'s shape (id, digested props, git head, status, `written`), written by the
loop rather than the stack. Such a log gives `@vn/agentreport` structured evidence instead
of inferred evidence, which makes the automated read cheaper, and the arrangement costs
nothing architecturally because the two logs never have to be one log.

## The four invariants a naive bridge breaks on day one

None of these is a cost to weigh against a benefit; each one would be wrong.

**Mode.** _"Nothing lets the model change its own mode — there is no `enter_plan_mode`/
`exit_plan_mode` tool. Mode is owned by the REPL and the permission gate, which is what
makes plan mode a guarantee rather than a request."_ `agent.setMode` is a registered
command, so a full bridge exposes it and gives the model the one thing the design says it
must not have. The same holds for the whole `agent.*` namespace: `agent.clear`,
`agent.setModel`, `agent.newThread`, and `agent.run`, which is reflexive.

**Confirm.** Follow-on 2 is still open: _"the main process still auto-approves `confirm`
for every other caller, so `pipeline.run`'s `confirm: true` is not a gate for the agent or
CDP."_ Bridging before that fix gives the model `pipeline.run(mock=false)`,
`art.generate`, `story.decomposeAll` and `project.setArtStyle`, each of which spends real
money in a single call with nothing to gate it. This is the single most concrete risk in
the report, and fixing follow-on 2 is a prerequisite for bridging rather than a
mitigation.

**Secrets.** `project.setKey` takes a `secret` prop. `digestProps` keeps it out of the
record, but a bridged agent would have to carry the value in its context to pass it.
`project.setKey` is denied outright.

Confirmation happens in two places. Tools confirm through `Permission.ask`, and commands
confirm through the stack's gate. A single act must ask exactly once. A bridge between the
two must pick one of these paths and route the other through it.

---

## Five positions, and what each is worth

**A — status quo.** The transports stay separate and share decisions. This costs nothing,
and it keeps both the divergence in coverage (60 acts the agent cannot reach) and the
audit split.

**B — read-only bridge.** The agent gets `command.check`, `interaction.targets`, the
introspection reads (`asset.info`, `prompt.info`, `asset.suspended`, `workspace.doctree`,
`project.info`, `story.graph`, `story.coverage`) and the `view.*` navigation commands, as
one or two tools over the registry rather than one tool per command. There is no mutation,
no confirm problem, no undo interleaving, no secrets and no mode. This buys items 4 and 6
of the pros list (the planning oracle and "show me"), which are the two the agent cannot
approximate today. `view.*` is non-mutating and non-undoable by construction, so it adds
no record-keeping work.

**C — allow-listed mutating bridge.** C covers everything B covers, plus a named set of
commands that have no tool equivalent: `prompt.*`, `asset.adopt`, `art.promote`,
`asset.regenerate`, `asset.accept`. It does not cover the `story.*` or `doc.*` families,
because those already have better-shaped tools. C needs confirm routing and a disposition
field first.

**D — full bridge.** Covers everything above plus the deny list, the ambiguity, and the
migration.

**E — extract the acts into a package.** This option adds no transport bridge. The acts
the agent lacks move out of `WorkspaceSession` into a package, and both hosts wrap the
same functions: the desktop host wraps them in a command, and the agent host wraps them in
a tool. The same extraction already happened to `planMarkerEdit`/`applyMarkerPlan` and
then to `branchops`, which moved into `@vn/scriptedit` because the agent may not import an
app, and that reasoning is why five leaves already share the constrained allow-list. A
sixth leaf follows the existing pattern rather than setting a precedent.

E otherwise resembles C, but three properties make it stronger:

- **Extraction determines what the agent can reach.** No allow/deny list has to be kept
  accurate: the agent reaches exactly what got extracted, which is a fact about the
  dependency graph that the boundaries rule already enforces. `view.*`, `window.*`,
  `workspace.pick` and `agent.setMode` cannot be extracted, because they need the mesh,
  the window or the loop, so plan mode stays a guarantee for the reason it is one today
  rather than by convention.
- **The agent chooses the granularity.** A tool over an extracted function may batch the
  way `insertLines` does. A tool over the registry may not batch.
- It is incremental by construction, and costs one hand-written tool per act.

The extracted layer separates the implementation and does not add a second registry. It is
made of plain typed functions, with no props, no DSL, no catalog, and nothing that
enumerates it. Two reasons support leaving it that way, and the second reason is the
stronger of the two. A registry would be a second framework beside `@vn/commands` to keep
honest, and no caller needs one: macros read the command catalog, because a macro is built
out of the searchable palette, and the agent's tools are hand-written anyway. The layer
that would want to expose these functions is a scripting API, which is not being designed
yet. Giving that API a shape now, chosen to serve the agent, decides a question in advance
and in the wrong forum. Left as functions, the scripting layer picks its own vocabulary
when there is one to pick.

The corollary is worth stating so that it does not come as a surprise. With no registry
there is no coverage number for the extracted layer and no ratchet over it, and reading
the package is what shows which acts have moved. That trade is acceptable here in a way it
was not for anchors, because nothing resolves against this layer at runtime: a missing
extraction means a tool was never written, rather than a map that has gone stale.

The real cost is that `WorkspaceSession` holds the loaded model and the caches those ~60
acts run against, so it has to come apart before any of them can move.

The options differ in cost and scope. B is cheap and additive. E takes the longest and
must keep both systems working throughout. C is a plan. D rewrites how the agent is gated.

---

## What macros ask of the command system, and what the agent does not

Macros belong on the palette, because that is what people expect: a macro is built out of
the searchable command list, and a scripting API exposes the lower-level machinery later.
This settles one open question. The extracted layer of position E needs no introspection
at all, because the macro editor reads the existing catalog and the agent reaches macros
by name.

There is also an asymmetry worth stating, because it inverts the usual worry:

A bridge requires nothing from the command system, while macros require a second half of
it.

Input schemas already exist: `toCatalog` emits typed props and a JSON Schema per command,
which is precisely what an agent bridge would consume. Output schemas do not exist.
`CommandOutcome` carries a human-readable sentence, an optional `data` and `written`;
nothing in the catalog declares a return shape. A node-graph macro editor wiring outputs
to inputs needs declared return shapes across all 108 commands.

So macros are already a second requirement set on the command system. This report weighs
the objection to adding a model as a third. That ordering strengthens the objection: the
command system's evolution budget should go to the macro requirements, not to model-facing
ones.

The argument so far favors selection-first, at least to begin with. Most commands already
take their subject from `ui.*` — enough that the tours plan names `wrong-subject` its
common resolution. A macro recorded as a run of palette acts against the current selection
therefore needs no new plumbing, and that recording is the shape macros take in every
application that has them. Output declarations are the DAG editor's requirement, and the
DAG editor is explicitly not immediate. By the time the DAG editor exists, which commands
are worth declaring will be known rather than guessed at.

## Recommendation

Do not build the full bridge. Build B when a feature requires it. Guided tours is the
first consumer. Take E for anything mutating, one act at a time. Compose through macros.

The reason is worth stating as a rule:

A macro carries a name; a command is written by the author. The agent should use the
macro.

A macro system that reads the catalog gets all 108 commands for the author, wires their
inputs and outputs, and stores the result as a text file. The agent then needs exactly one
tool — `run_macro(name, …)` — plus its existing file writers to author macros. That
surface is:

- **stable** (the tool list does not grow with the catalog, so the cached prefix is
  untouched),
- **legible** (an author can read the macro before it runs, but cannot read in advance
  what a model will choose among 108 commands),
- **gated once** (a macro carries one confirm, not a confirm per node), and
- **recorded**: the macro's own commands still land in `commands.jsonl` with the
  invocation that produced them.

It also answers the todo's own question, "would we need to bridge the agent and the ux
here? a macro writing agent in principle only writes text files", with no. Writing a macro
means writing a file. Running one takes a single tool. Neither step needs the registry
advertised to a model.

`run_macro` needs one rule, and it already has a precedent. A macro built from the whole
palette means the agent transitively reaches everything, `pipeline.run(mock=false)`
included. That is acceptable for a stated reason rather than by omission: the human who
saved the macro holds the authority, in the same way that `run_skill` confirms the first
run of a script-bearing skill so that the script it offers to run is always one a person
put there. The macro is readable text, it carries one confirm rather than one per node,
and the user-folder/project-repo split becomes a real trust boundary. A macro committed to
the project arrives with the project.

Macros do not give the planning oracle. `check` and `targets` are questions rather than
acts, and a macro cannot ask them on the model's behalf. Position B fills that gap, and
that is why B is the increment worth having on its own.

---

## If a mutating bridge is built later

Complete these prerequisites in order:

1.  1. **Route `confirm` through the renderer for non-palette callers** (follow-on 2). No
       mutating call is allowed through until this is done.
2.  2. **A disposition field on `Command`** — Add `agent?: 'allow' | 'confirm' | 'deny'`
       to `Command`. A command that omits the field is denied. A test pins the allowed
       set, the same shape as the tests pinning the mutating and undoable sets.
3.  3. **A batch bracket on the stack** groups a run of agent commands into one undo point
       and one commit, as an approved plan already does.
4.  4. **One consent door.** The agent owns the permission gate. The stack's confirm
       should call into that gate rather than prompt alongside it.
5.  5. **A ban on advertising both names for one act.** If a tool exists for an act, the
       agent is denied the matching command. A test over the tool registry and the
       disposition field enforces this, rather than convention.

Position B requires none of that. B can therefore be built first, and is worth building
first.

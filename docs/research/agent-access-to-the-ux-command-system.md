# Giving the agent the UX command system

Status: **research**. Nothing here is planned work.

The question: should `vnauthor` reach the desktop's 108 registered commands directly — every
command a tool, `stack.exec` the transport — or should the two stay as they are, sharing
*decisions* while keeping separate doors?

This report argues **no full bridge**, and proposes two smaller things that between them buy most
of the value: a **read-only bridge** for the questions a bridge answers best (`check`, `targets`,
the introspection reads, and `view.*`), and, for anything that writes, **moving the implementation
down** into a package both hosts wrap rather than exposing the registry to a model. Composition is
left to the macro system, which sits on the palette, rather than to a widened tool list. The macro
work assumes this conclusion; the reasoning is here so the assumption is a decision rather than an
inertia.

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

`CommandSource` already includes `'agent'`. The plumbing is there and unused, and that is
deliberate: [`command-system.md`](../command-system.md#from-the-agent) states the shipped position
as *"the agent and the commands share the **decisions** rather than the transport."*

Concretely:

| | Agent | Desktop |
| --- | --- | --- |
| Vocabulary | 41 tools (`packages/authoring/src/tools.ts`) | 108 commands (`apps/desktop/src/main/commands/`) |
| Validation | zod `safeParse` in `Agent.dispatch` | `coerceProps` in `CommandStack` |
| Gate | plan/execute mode + `Permission.ask` | `confirm: true` + the palette's second click |
| Record | thread JSONL + one git commit per approved plan | `commands.jsonl` + shadow-snapshot undo |
| Refusals | `@vn/scriptedit`, `@vn/model`, `@vn/artgen` | **the same modules** |

The last row is the load-bearing one. `edit_scene`'s twelve ops are named after the `story.*`
commands and run the same `lineops` decision; `set_outfit` is the two outfit commands;
`edit_branches` is `branchops`. A refusal an author reads mid-drag is the sentence the agent gets
back. **The duplication is transport, not judgement** — which is exactly the duplication that does
not rot, because there is no second copy of a rule to fall out of sync.

The layering makes this non-negotiable in one direction: `@vn/authoring` may not import an app, so
a bridge can only ever be **host-wired** — the desktop handing its stack to `ToolContext`. That is
the first cost, and it is structural rather than incidental (see below).

---

## What a full bridge would buy

**1. One audit log.** Today an agent turn is legible three ways — the thread transcript, the git
commits, and `@vn/agentreport` stitching them together. A bridged agent writes
`commands.jsonl` rows with `source: 'agent'`, `gitHead`, `gitDirty` and a copy-pasteable
`invocation`. `report.agent`'s "acting record" would stop being a reconstruction.

**2. One undo history.** Agent edits become undo points on the same shadow-snapshot stack, so an
author can step back through a mixed session without knowing which hand made which edit. Today
undo covers the author's edits and git covers the agent's, and the two do not interleave.

**3. Coverage without writing a tool per act.** The agent cannot currently promote a concept,
adopt bytes onto a slot, edit a prompt clause, attach a reference, repin a suspension, save a
layout, or open a pane. Those are 60-odd acts with no tool. Under a bridge every *future* command
is agent-reachable the day it is registered, which is the same property that makes the palette a
view of the catalog rather than a hand-kept list.

**4. `check` as a planning oracle.** `stack.check` answers `accept | refuse | undeclared` with the
sentence the command itself would give, it is read-only, and asking is free. That is a better
planning primitive than anything the agent has, and `interaction.targets` is the same thing for
gestures — *"which insertion points in this scene would reorder anything, and what would each
run"* — which `script.moveLine` was explicitly designed and tested to answer before any drag
existed.

**5. The schemas are already emitted.** `toCatalog` produces a JSON Schema per command, and
follow-on 3 already wants to feed those to `NativeAgentBackend` in place of `LOOSE_PARAMS`. The
mechanical fit is real; nothing needs inventing.

**6. The agent could show rather than tell.** `view.open(editor='asset' subject=<hash>)` turns
"her sheet is out of date" into the pane being open. This is the single most author-visible win,
and it is also the prerequisite the [guided tours](../plans/guided-ui-tours.md) plan already
assumes — though note that plan's own leaning: the agent reaches anchors *through a `tour.*`
command*, one door, not through the map directly.

---

## What it would cost

**1. The tool catalog is a cached prefix, and this triples the haystack.**
`apps/desktop/dist/commands.json` is **131 KB for 108 commands** — call it 30–35k tokens if sent
whole, against the six schemas `toolSpecs()` currently sends up front. Deferred loading plus BM25
search is what makes that survivable, and it does: the prefix stays byte-stable, so the cache
holds. But the search space goes from 41 named acts to ~150, most of them near-synonyms of each
other (`story.insertLine` beside `edit_scene(op=insertLine)`), and every search result is context
spent per turn. The cache invariant is not violated; the retrieval quality is.

**2. Two names for one act is a worse failure than a missing name.** If both `edit_scene` and the
nine `story.*` prose commands are advertised, the model picks arbitrarily — and the two paths are
not equivalent. `edit_file` rests on the read ledger; `doc.write` refuses by `seenHash`.
`insertLines` folds a run of prose into one write with one refusal; `story.insertLine` is one line.
The create tools take a whole sheet so a character need not be created and then immediately
edited. Those are **agent-shaped affordances**, and a bridge that keeps them keeps the ambiguity,
while a bridge that deletes them loses the batching, the ledger, and the round-trip guarantee's
single entry point.

**3. Granularity.** A command is one *authorial* act — sized for a hand, and deliberately so: a
drag in the branch editor is one command and one record, never a stream. An agent drafting a scene
emits forty. Under commit-on-save that is forty commits; under the journal, forty undo points;
under the loop, forty round-trips against a per-turn token ceiling. The stack has no batch or
transaction concept, and `agent.run`'s `commitsItself: true` exists precisely because the agent's
unit is *the approved plan*, not the act.

**4. Results are sentences.** `CommandOutcome.message` is written for a message line. Some
commands carry `data`; most do not. A model reading "Showing Coverage below." learns less than a
tool return designed to be read. Giving commands a second, machine-facing projection is a second
truth about the same thing — the exact shape [`guided-ui-tours.md`](../plans/guided-ui-tours.md)
§8 rejects for the anchor map.

**5. "Full" is not achievable, so a second list appears.** A dozen commands are meaningless or
hostile from an agent: `workspace.chooseDirectory`, `upload.pick`, `workspace.pick` and
`asset.replace` open native modals; `view.palette` opens the finder; `window.quit` quits.
So a bridge needs a per-command disposition — and **a hand-kept allow/deny list is the
thing that rots**, which is the anchors plan's whole thesis. It can be made structural (a field on
the definition, absence meaning *deny*, mirroring `undeclared` is not permission), but that is a
migration across 108 definitions and a test that pins the set.

**6. Host divergence.** Since the bridge must be host-wired, the desktop agent gets 108 commands
and the terminal `vnauthor` gets none. One agent, two capability sets: a skill written against
`asset.adopt` silently fails in the REPL. Today the tool list is the same everywhere, and that is
worth something.

**7. Drift refusals under interleaving.** Undo *refuses rather than guesses* when the worktree
moved. An agent running a long turn of undoable commands while the author clicks in another window
is exactly the interleaving that produces those refusals — a correctness win that reads as
flakiness.

**8. Every refusal string becomes a model-facing contract.** 64 checks written to be read by a
person in a message line would start being parsed by a model deciding what to do next.

---

## Debuggability, and who pays for it

`report.agent` reads a saved transcript plus the act log, borrows the bound model for one call, and
runs on the author's own key. If that read ever becomes automatic — funded by a key the project
provides to selected users — its bill becomes the project's, and it scales with **transcript
length**.

A bridge lengthens transcripts twice over: a larger searched tool space per turn, and forty
`story.insertLine` records where `insertLines` is one call. So the coupling is real and it
compounds: bridge → command-grained acts → longer threads → a more expensive automated read, paid
per user.

The honest counterweight is that a bridged agent's evidence is *better per token* — a replayable
`invocation` with `gitHead` and `gitDirty` beats reconstructing intent from prose — so a bridge
could lower cost-per-act while raising acts-per-turn. **The variable is granularity, not
transport**, which is why position E addresses this and position D does not.

**The subtler cost is that the two systems stop having separate requirements.** Under a bridge the
acting record and the transcript collapse into one vocabulary, and every refusal sentence — written
for a message line under a greyed button — becomes a model-facing contract. The debug agent then
files reports asking for UI text to be reworded so a model stops retrying, and there is no
principled place to decline, because it is one system with two masters. Kept apart, that request is
a category error rather than a judgement call. Redaction widens too: a `story.setLineText`
invocation carries the author's prose in its props, so the leak scan `report.openIssue` runs would
have more surface to be wrong about.

**Sharing the record format is not the same as sharing the registry**, and it is the half worth
having. The loop could append its tool calls to their own log in `CommandRecord`'s shape — id,
digested props, git head, status, `written` — written by the loop rather than the stack. That gives
`@vn/agentreport` structured evidence instead of inferred evidence, which makes the automated read
*cheaper*, and it costs nothing architecturally because the two logs never have to be one log.

## The four invariants a naive bridge breaks on day one

These are not costs to weigh; they are things that would be **wrong**.

**Mode.** *"Nothing lets the model change its own mode — there is no `enter_plan_mode`/
`exit_plan_mode` tool. Mode is owned by the REPL and the permission gate, which is what makes plan
mode a guarantee rather than a request."* `agent.setMode` is a registered command. A full bridge
hands the model the one thing the design says it must not have. The whole `agent.*` namespace goes
the same way — `agent.clear`, `agent.setModel`, `agent.newThread`, and `agent.run` itself, which is
reflexive.

**Confirm.** Follow-on 2 is still open: *"the main process still auto-approves `confirm` for every
other caller, so `pipeline.run`'s `confirm: true` is not a gate for the agent or CDP."* Bridging
before that fix gives the model `pipeline.run(mock=false)`, `art.generate`, `story.decomposeAll`
and `project.setArtStyle` — real money, one call, no card. This is the single most concrete risk in
the report, and it is a prerequisite rather than a mitigation.

**Secrets.** `project.setKey` takes a `secret` prop. `digestProps` keeps it out of the record, but
a bridged agent would have to carry the value *in its context* to pass it. Deny outright.

**Two consent doors.** Tools confirm through `Permission.ask`; commands confirm through the
stack's gate. One act must not ask twice, and must not ask zero times. Any bridge has to pick one
door and route the other through it.

---

## Five positions, and what each is worth

**A — status quo.** Shared decisions, separate transports. Costs nothing, keeps the divergence in
coverage (60 acts the agent cannot reach) and the audit split.

**B — read-only bridge.** The agent gets `command.check`, `interaction.targets`, the introspection
reads (`asset.info`, `prompt.info`, `asset.suspended`, `workspace.doctree`, `project.info`,
`story.graph`, `story.coverage`) and the `view.*` navigation commands, as **one or two tools over
the registry** rather than one tool per command. No mutation, no confirm problem, no undo
interleaving, no secrets, no mode. Buys items 4 and 6 of the pros list — the planning oracle and
"show me" — which are the two the agent cannot approximate today. `view.*` is non-mutating and
non-undoable by construction, so it carries none of the record-keeping weight.

**C — allow-listed mutating bridge.** B plus a named set with **no tool equivalent**: `prompt.*`,
`asset.adopt`, `art.promote`, `asset.regenerate`, `asset.accept`. Explicitly not the `story.*` or
`doc.*` families, because those already have better-shaped tools. Needs confirm routing and a
disposition field first.

**D — full bridge.** Everything above plus the deny list, the ambiguity, and the migration.

**E — move the wall down.** No transport bridge at all. Instead, the acts the agent lacks are
**extracted out of `WorkspaceSession` into a package**, and both hosts wrap the same functions —
the desktop as a command, the agent as a tool. This is not a new architectural idea: it is what
already happened to `planMarkerEdit`/`applyMarkerPlan` and then to `branchops`, which moved into
`@vn/scriptedit` because *the agent may not import an app*, and it is why five leaves already
share the constrained allow-list. A sixth is the sixth instance, not a precedent.

Three properties make E stronger than C, which it otherwise resembles:

- **The extraction boundary is the permission boundary.** There is no allow/deny list to keep
  honest — what the agent can reach is what got extracted, a fact about the dependency graph that
  the boundaries rule already enforces. `view.*`, `window.*`, `workspace.pick` and `agent.setMode`
  *cannot* be extracted, because they need the mesh, the window or the loop, so plan mode stays a
  guarantee for the reason it is one today rather than by convention.
- **Granularity stays the agent's to choose.** A tool over an extracted function is free to batch
  the way `insertLines` does; a tool over the registry is not.
- **It is incremental by construction**, at the price of one hand-written tool per act.

**The extracted layer is separated implementation, not a second registry.** Plain typed functions:
no props, no DSL, no catalog, nothing to enumerate it. Two reasons, and the second is the stronger
one. It would be a second framework beside `@vn/commands` to keep honest, for no caller that needs
one — macros read the *command* catalog, because a macro is built out of the searchable palette,
and the agent's tools are hand-written anyway. And the layer that *would* want to expose it is a
**scripting API**, which is not being designed yet; giving it a shape now, chosen to serve the
agent, is deciding a question in advance and in the wrong forum. Left as functions, the scripting
layer picks its own vocabulary when there is one to pick.

The corollary is worth stating so it is not a surprise: with no registry there is no coverage
number for the extracted layer and no ratchet over it. Which acts have moved is answered by reading
the package. That is acceptable here in a way it was not for anchors, because nothing *resolves*
against this layer at runtime — a missing extraction is a tool that was never written, not a map
that has gone stale.

The cost is the real one: `WorkspaceSession` holds the loaded model and the caches those ~60 acts
run against, so it has to come apart before any of them can move.

The gradient is real: B is cheap and additive, E is the long road that keeps both systems whole, C
is a plan, and D is a rewrite of how the agent is gated.

---

## What macros ask of the command system, and what the agent does not

Macros sit **on the palette**, because that is what people expect: a macro is built out of the
searchable command list, and lower-level machinery is what a scripting API exposes later. That
settles one open question — the extracted layer of position E needs **no introspection at all**,
since the macro editor reads the existing catalog and the agent reaches macros by name.

It also surfaces an asymmetry worth stating, because it inverts the usual worry:

> **A bridge would ask the command system for nothing; macros ask it for a second half.**

Input schemas already exist — `toCatalog` emits typed props and a JSON Schema per command, which is
precisely what an agent bridge would consume. **Outputs do not.** `CommandOutcome` carries a human
sentence, an optional `data` and `written`; nothing in the catalog declares a return shape. A
node-graph macro editor wiring outputs to inputs needs that vocabulary across 108 commands.

So macros are already a second requirement set on the command system. Adding a model as a third is
the objection this report exists to weigh, and the ordering makes it sharper: the command system's
evolution budget should go to the macro requirements, not to model-facing ones.

**Which argues for selection-first, at least first.** Most commands already take their subject from
`ui.*` — enough that the tours plan names `wrong-subject` its common resolution. A macro recorded
as a run of palette acts against the current selection therefore needs **no new plumbing**, and it
is the shape macros take in every application that has them. Output declarations are the DAG
editor's requirement, and the DAG editor is explicitly not immediate; by the time it is, which
commands are worth declaring will be known rather than guessed at.

## Recommendation

**Do not build the full bridge.** Do B when something needs it — guided tours is the obvious
first customer — take E for anything mutating, one act at a time, and let **macros be the
composition door**.

The reason is worth stating as a rule:

> **A macro is a named act; a command is an authorial act. The agent should reach the first.**

A macro system that reads the catalog gets all 108 commands *for the author*, wires their inputs
and outputs, and stores the result as a text file. The agent then needs exactly one tool —
`run_macro(name, …)` — plus its existing file writers to *author* macros. That surface is:

- **stable** (the tool list does not grow with the catalog, so the cached prefix is untouched),
- **legible** (an author can read the macro before it runs, which is not true of a model choosing
  among 108 commands),
- **gated once** (a macro carries one confirm, not a confirm per node), and
- **recorded honestly** (the macro's own commands still land in `commands.jsonl` with the
  invocation that produced them).

It also answers the todo's own question — *"would we need to bridge the agent and the ux here? a
macro writing agent in principle only writes text files"* — with **no**. Writing a macro is
writing a file. Running one is one tool. Neither needs the registry advertised to a model.

**`run_macro` needs one rule, and it already has a precedent.** A macro built from the whole
palette means the agent transitively reaches everything, `pipeline.run(mock=false)` included. That
is acceptable for a stated reason rather than by omission: the authority is **the human who saved
the macro**, exactly as `run_skill` confirms the first run of a script-bearing skill so that the
script it offers to run is always one a person put there. The macro is readable text, it carries
one confirm rather than one per node, and the user-folder/project-repo split becomes a real trust
boundary — a macro committed to the project arrives with the project.

The one thing macros do **not** give is the planning oracle: `check` and `targets` are questions,
not acts, and a macro cannot ask them on the model's behalf. That is precisely position B, and it
is why B is the increment worth having on its own.

---

## If a mutating bridge is built later

Prerequisites, in order:

1. **Route `confirm` through the renderer for non-palette callers** (follow-on 2). Nothing
   mutating crosses until this is done.
2. **A disposition field on `Command`** — `agent?: 'allow' | 'confirm' | 'deny'` — with **absence
   meaning deny**, and a test pinning the allowed set, the same shape as the tests pinning the
   mutating and undoable sets. Absence of permission is not permission.
3. **A batch bracket on the stack**, so a run of agent commands is one undo point and one commit,
   the way an approved plan already is.
4. **One consent door.** The permission gate is the agent's; the stack's confirm should call into
   it rather than beside it.
5. **A ban on advertising both names for one act.** Where a tool exists, the command is denied to
   the agent — enforced by a test over the tool registry and the disposition field, not by
   convention.

None of that is required for position B, which is why B can be built first and is worth building
first.

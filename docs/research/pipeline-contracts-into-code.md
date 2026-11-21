# Moving the pipeline contracts into code

Status: done.
[`../plans/contracts-into-code-and-workflows.md`](../plans/contracts-into-code-and-workflows.md)
carried this out, and its stage 9 deleted the page this note set out to retire. The rules
are now the index in
[`../../packages/contracts/contracts.json`](../../packages/contracts/contracts.json).

The pipeline contracts page (`docs/reference/pipeline-contracts.md`) listed about
thirty-five invariants, each with the failure it prevents. This note looks at how to move
all of them into code so the document can be deleted. It also looks at splitting the
pipeline into a generation graph (merged with `@vn/gengraph`) and a separate contract
solver. It follows on from
[`workflows-and-narrative-engines.md`](workflows-and-narrative-engines.md), and the two
proposals depend on each other.

<!-- toc -->

- [The document holds five different kinds of rule](#the-document-holds-five-different-kinds-of-rule)
- [Many contracts exist only because two code paths must agree](#many-contracts-exist-only-because-two-code-paths-must-agree)
- [Three pieces, not two](#three-pieces-not-two)
- [The solver](#the-solver)
- [Merging the generation graph with gengraph](#merging-the-generation-graph-with-gengraph)
- [Bound-graph edits: drift or identity](#bound-graph-edits-drift-or-identity)
    - [How it works today](#how-it-works-today)
    - [A gap: a graph bound after the slot was drawn never redraws it](#a-gap-a-graph-bound-after-the-slot-was-drawn-never-redraws-it)
    - [The identity rule](#the-identity-rule)
    - [A fix that does not need the refactor](#a-fix-that-does-not-need-the-refactor)
- [What "in code" means for each contract](#what-in-code-means-for-each-contract)
- [Keeping the overview once the document is gone](#keeping-the-overview-once-the-document-is-gone)
- [Retargeting what links to the document](#retargeting-what-links-to-the-document)
- [Suggested sequence](#suggested-sequence)
- [Decisions needed](#decisions-needed)

<!-- tocstop -->

## The document holds five different kinds of rule

Only some of the contracts are about the pipeline. Sorted by what they constrain:

- **Derived state.** Questions answered from the project as it stands: is this character
  approved, which take does this slot hold, is this asset suspended, has this frame
  drifted, is this row still used, may this failed task be retried. These are the
  contracts a solver would own.
- **Graph structure and identity.** Which slots exist, what each is drawn from, and what
  enters a task's hash: the content-addressed identity, the model id left out of it, the
  slot vocabulary, the staging-sheet key, node keys inside groups, the requirement that a
  socket rename ship with its migration, and byte-identical prompts when nothing is
  authored.
- **Execution.** How the scheduler runs ready work: log replay, tombstones, `closureOf`
  narrowing, the retry budget, stop and abort, the request journals, the per-task
  diagnostic logs, and provider retries.
- **Write paths.** Who may write what, and in what order: the two asset roots and the
  single-writer manifest queue, the three callers allowed to write `done` outside the
  scheduler, the collector's apply order, storyboards persisted and a fallback never
  persisted, one file per scene, a multi-file patch computed before anything is written,
  byte-exact front-matter, shot reordering, heading edits, line-id allocation, and
  refusing a reference cycle at write time.
- **Script and seam rules.** Entity discovery by tag, outfit inheritance, the scene
  round-trip, line ids reaching P5, the reviewer's `shotSpec`, deterministic fallbacks,
  and the provider seam.

The last two groups are not pipeline contracts. Under the layering in the workflows note
they belong to the script layer and to the store, and they move with those packages.

## Many contracts exist only because two code paths must agree

Several contracts do not describe behaviour at all. They exist because the same answer is
computed in two or three places, and a test or a sentence keeps those places in step:

- `buildSlotGraph` (`packages/artgen/src/slotgraph.ts`) and `planTasks`
  (`packages/pipeline/src/planner.ts`) both enumerate the project's pictures.
  `slotagreement.test.ts` runs the planner to exhaustion to check that the two agree, and
  it has to live in `@vn/pipeline` because `@vn/artgen` may not import the planner.
- `gateStatus` (`packages/artgen/src/gate.ts:73`) walks reachable scenes on its own rather
  than reading the slot graph. The contract says so in its own words: "`gateStatus` keeps
  its own reachable-scene walk".
- `usedOutfits` must equal the range of `outfitFor` over the model. Today that holds
  because one function's comment says so.
- `sheetSeeds` must give the planner, the scheduled runner and `gengraph.run` the same
  answer. The staging-sheet contract states this rather than enforcing it.
- The collector's list of live slots must match the slot graph's.
- Graph drift (`graphDrift`, `requeueDrifted`) is a second invalidation mechanism. It
  exists because a bound graph's edits do not enter the task hash, so content addressing
  cannot see them.

If one component computes all of this from one set of facts, these contracts become
impossible to break, so they need no code, test or document at all. That is the strongest
argument for the solver, and it shrinks the amount of material that has to be moved.

## Three pieces, not two

The proposal names two pieces: a generation graph and a contract solver. The execution
contracts suggest a third, kept separate from both:

- **Solver.** A pure function from the project's facts to its derived state. It does no
  I/O, spends no money and has no path.ux dependency.
- **Generation graph.** The slots, the edges between them, and for each slot the subgraph
  that draws it. This is where `@vn/gengraph` merges in.
- **Executor.** Runs whatever the solver says is ready, through the slot's subgraph, and
  records what happened. Today this is `@vn/scheduler` plus the runners.

The three-way split matters because derived state and execution change for different
reasons. Retry policy, stop semantics and request journals change with the providers.
Approval and suspension change with the authoring model.

## The solver

**Inputs** are a snapshot of facts:

- The model: script, narrative structure and production data.
- Both manifests.
- The latest record per task hash from `tasks.jsonl`.
- Graph documents and their journals.
- The config.

**Outputs** are the derived state, one record per slot plus a few project-level answers:

- Per slot:
    - its identity, or the sentence saying why it has none;
    - the take it holds (`pick`);
    - `approved` and `blessed`;
    - `suspended`;
    - prose drift and graph drift;
    - `live`, for the collector;
    - `retryable`.
- Per project:
    - a refusal such as an `unavailable` base root or a reference cycle;
    - the gate;
    - the approval order.

**Readers.** The planner keeps only the slots that have an identity and are ready. The
gate, the collector, export's unapproved check, `validateProject`, the document tree and
the agent all read the same state instead of deriving it again.

**Where the code comes from.** About 2,300 lines of `@vn/artgen` are already this
derivation:

- `slotgraph.ts`, `gate.ts`, `takes.ts`, `overheld.ts`, `prereq.ts`, `suspend.ts`;
- `refcycle.ts`, `refs.ts`, `drift.ts`, `base.ts`;
- the planning half of `collect.ts`, and `validate.ts`.

On the pipeline side the same kind of code is `planner.ts`, `drift.ts`, and the decision
half of the scheduler's `requeueFailed`, `requeueAbandoned` and `requeueDrifted`. Moving
this code out leaves `@vn/artgen` as what its name says: prompt composition, art
direction, and on-demand generation.

**Identity needs prompts.** A slot's identity is `taskHash(kind, inputs)`, and the inputs
include the composed prompt. So the solver depends on prompt composition. In the workflows
note's terms, it calls the workflow module's identity function rather than importing
prompt builders directly.

**Implementation.** Write the rules in plain TypeScript, one named rule per derived field,
over an immutable snapshot. Two of the rules are transitive closures: suspension walks
downstream, and the collector's keep rule walks `refs`. That is Datalog's ground, but the
rule count is small and a Datalog engine would be a new runtime dependency on a path that
decides spending. Revisit if the rule set grows past what a reader can hold in their head.
This solver is unrelated to the storylet model checker in
[`storylet-solver.md`](storylet-solver.md). It derives values and does not search.

**Cost per wave.** The planner runs once per scheduler wave, because a shot's identity
needs its plate's output hash. The solver runs at the same rate. For a large project it
should memoise per slot on a hash of the facts that slot reads. The first version can
measure this before optimising it.

## Merging the generation graph with gengraph

The project has three graphs today:

- the **slot graph**, which every picture the project implies;
- the **task DAG**, which holds content-addressed identities that appear one wave at a
  time;
- the **gen graphs**, which say how one slot, or one staging-sheet group, is drawn.

Proposed shape:

- **The top level is derived, never authored.** The workflow module enumerates the slots
  and their reference edges. This is today's slot graph. It is not stored as a document,
  and it does not need to be a path.ux `Graph`: a project's thousands of slots do not need
  socket objects.
- **Every slot runs through a subgraph.** A slot nothing is bound to runs its kind's
  default subgraph, which is `defaultSlotGraph` grown to reproduce the built-in runner,
  including the P7 refine loop. `GenRefinePrompt` and `refinesThroughNode` already express
  that loop. A bound slot runs its authored graph, as it does today.
- **A task is one run of a slot's subgraph.** `@vn/taskgraph` stays as the
  content-addressed record and log of those runs. It is small and generic, and it must
  stay importable without path.ux. The packages do not need to merge for the model to
  merge.
- **A task kind becomes a default subgraph.** This changes the workflows note's
  `TaskKindSpec`: its `run` field is replaced by a default subgraph, and a new medium
  (video, audio) arrives as node types, through built-ins or gengraph plugins, rather than
  as hand-written runners.

Preconditions and risks:

- **The legacy runner path must retire first.**
  [`gen-graphs.md`](../reference/gen-graphs.md) lists retiring it under "Deliberately not
  built". Until every slot runs through a graph, there are two execution paths and the
  merge has nothing to merge into.
- **Existing hashes must not move.** For a slot running its default subgraph, the identity
  stays `taskHash(kind, inputs)`, so `prompthash.test.ts` passes unchanged.
- **Graph drift could become identity.** See the next section.
- **Staging sheets** already span slots: one graph, several outputs. Under this shape they
  are a subgraph shared by several slots, and the rule that runs of one graph are
  serialised stays an executor rule.

## Bound-graph edits: drift or identity

### How it works today

- A bound slot's task identity is `taskHash(kind, inputs)`, the same as an unbound slot's.
  The graph is treated as the slot's runner, not as part of what the slot is, so editing
  the graph never moves the hash.
- To notice an edit, `graphDrift` compares each active output's `authoredHashes` value
  against the authored hash on that node's last `done` journal record. `requeueDrifted`
  puts every planned `done` or `needs_human` task whose graph drifted back to `pending`,
  once per run, before the wave loop.
- The redraw is cheap where it can be. The executor resumes any node whose run key (the
  bytes that fed it) has a cached answer, so only the edited node and whatever it feeds
  are paid for.
- Undo before a run restores the authored hash, so the drift disappears and nothing is
  drawn. Undo after a run is drift in the other direction: the next run requeues the task,
  the executor resumes the old answer from the cache, and the old picture comes back with
  no paid call.

### A gap: a graph bound after the slot was drawn never redraws it

- `graphDrift` treats an output with no `done` record as "not drift, because there is
  nothing for it to have drifted from" (`packages/gengraph/src/drift.ts`). Only the
  executor writes authored hashes, and `gengraph.createForSlot` requeues nothing.
- So when the built-in runner has already drawn a slot, binding a graph to it, or binding
  one and editing it, leaves the task `done` under an unchanged hash. No run ever draws it
  through the graph. The author has to find `regenerate` or `gengraph.run` on their own.
- A probe on 2026-11-17 confirmed this through the real scheduler, using the testkit's
  `SCRIPTS.linear`. A run with no graphs drew `portrait:aiko`. Then a graph appending ",
  in ink wash" to the derived prompt was bound to that slot. Two further runs drew
  nothing, and no portrait with that prompt was written. `graphdrift.test.ts` does not
  cover this case, because every one of its tests binds the graph before the first run.
- This breaks the stated contract ("Editing a generation graph invalidates the slots it
  draws"), and it is the case an author hits first: draw the project, dislike one picture,
  make a graph for it.

### The identity rule

- A slot running its kind's default subgraph keeps `taskHash(kind, inputs)`. "Default" is
  tested by comparing the active output's authored hash with that of
  `defaultSlotGraph(slot)`. An authored hash covers only the output's ancestors, so moving
  a node or adding an unconnected one does not count as an edit.
- A slot running any other subgraph takes `hash(taskHash(kind, inputs), authoredHash)`.
- The repo already has a precedent: a staging-sheet member carries `params.extra.sheet`, a
  key derived from the graph that draws it, inside its identity.

What this gains:

- **The gap closes by construction.** Binding a non-default graph changes the identity, so
  the next run plans the slot. Binding an unedited default graph does not, so making a
  graph for a slot costs nothing until the author changes it.
- **One identity has one output again.** Today a bound slot's task record changes its
  output every time the graph is edited and redrawn, under the same hash. Content
  addressing assumes that cannot happen, and every reader of the log (`repairCurrent`, the
  collector, adoption) inherits the assumption.
- **Undo after a run is free and needs no run.** The old identity is still `done` in the
  log, so the slot's take returns to the old picture at the next repair pass
  (`repairCurrent`), with nothing requeued.
- **Alternatives keep their pictures.** Two outputs bound to one slot have different
  authored hashes and so different identities. After each has run once, switching the
  active flag between them changes the take without drawing.
- **Code deleted.** `graphDrift`, `driftedTasks`, `requeueDrifted`, `RunSummary.redrawn`
  and the graph-drift contract all go. The authored hash stays, now as an identity input.
- **The planner and the cost preview can see the edit.** A drifted slot is now a pending
  task, so it appears in the plan and the preview before the run, rather than only when
  the run starts.

What it costs or changes:

- **A one-time re-key of every slot bound to a non-default graph.** The first run after
  the change plans each one under its new identity. A graph that has run since its last
  edit should resume entirely from the journal's cached answers, so this should cost no
  calls. That has not been measured, and a test should pin it before the change ships.
  Until that run, the identity has no `done` record, and the slot's take comes from the
  manifest row (the `pick` rule for a re-keyed identity), so pictures and approvals do not
  change in between.
- **Graphs that never ran will draw.** A slot hit by the gap has a graph whose edit was
  never drawn, and the change draws it. That is the fix, but it is spending the author did
  not ask for in this session. The change should list those slots and their estimate
  before the first run.
- **Unbinding becomes a real change.** Deleting a graph or clearing its active flag
  returns the identity to `taskHash(kind, inputs)`. The slot then shows the built-in
  runner's picture if that identity ever ran, and otherwise draws one. Today unbinding
  keeps the graph's picture, because the identity never moved.
- **Group definitions and node versions have the same blast radius as now.** Editing
  `lib/<ref>.json`, or bumping a node type's `typeVersion`, re-keys every slot it reaches.
  Today the same edit drifts the same slots.
- **Downstream behaves as now.** A re-keyed slot that resumes to the same bytes moves no
  downstream hash, because downstream identities include the reference's asset hash, not
  its task hash. New bytes re-key downstream, as any redraw does today.
- **Cost estimates are unchanged.** `estimateGraph` prices a whole graph as a worst case
  and does not read the journal, so both today's drift redraw and a re-keyed slot are
  quoted at the full graph. A journal-aware estimate would help both and is a separate
  change.

### A fix that does not need the refactor

The gap can be closed now, within the drift design: `driftedTasks` also requeues a `done`
task whose bound graph has no `done` record and is not the default graph. That needs the
same default-graph comparison the identity rule needs, so it is not wasted work. It leaves
the other problems in place: an identity whose output changes, and undo after a run
needing another run.

## What "in code" means for each contract

There are four forms, and each contract takes the strongest one that fits:

- **Unrepresentable.** A type or a closed schema that rejects the bad state, such as the
  closed scene front-matter schema.
- **Refused at the write.** A precondition on the one function allowed to make the write,
  such as `refCycle` in `prompt.addRef`, or adoption's three refusals.
- **Derived, never stored.** A solver rule. Suspension and drift already work this way.
- **Pinned by a test.** A golden or property test where the property cannot be enforced at
  runtime, such as `prompthash.test.ts` and the scene round-trip.

Some write-path contracts also need an **import rule**. "Only these three callers write
`done` outside the scheduler" can only be enforced as "only `adoptslot.ts` may import the
log writer". The repo's import checker can express that:

- Since `ed9833bb` (2026-11-17), two lintrix rules in `scripts/lintrix/` enforce the
  package layering. `vn/element-types` checks each import against the allow-list in
  `lintrix.config.json`, and `vn/no-cycle` refuses runtime import cycles. Between the
  switch to lintrix on 2026-09-12 and that commit, nothing enforced the layering. A script
  run against `master` at the start of that commit found no violations in
  `packages/*/src`.
- An element in `vn/element-types` is a folder, and a file belongs to the element with the
  longest matching folder. So an element can be a subfolder of a package: a subpath entry
  such as `@vn/types/script`, or the one module allowed to write a log.
- An element may always import itself, and individual files cannot be listed. To restrict
  who may write `done`, the writer and each permitted caller need folders of their own,
  registered as elements.
- `vn/no-cycle` is a warning, not an error, in the desktop app's session, runtime and
  pathux code, which had 71 cycles when the rule first ran. That code is outside every
  refactor here.

Each contract also needs somewhere to keep the failure it prevents. That sentence is the
one part a reader cannot derive from the code, so the repo's comment rules allow it in the
doc comment on the rule, the guard or the test that enforces the contract. The links to
archived plans go; git history keeps them.

## Keeping the overview once the document is gone

Deleting the document loses one thing: the list. Today someone changing the gate can read
the whole document and see that the collector and export depend on approval. Options:

- **A contract marker in code.** Each contract is declared once beside its enforcement,
  for example `contract('gate.readsRow', { prevents: '…' })`. A jest test collects every
  declaration and fails when an id is named by no test. The repo already has generated,
  test-compared artifacts (`ux-model.json`, `anchors.json`), so a generated list is an
  option too, but nothing needs to be generated.
- **Doc comments only.** Simpler, but nothing stops a contract from losing its test, and
  nothing lists them.

The leaning is the marker, kept to contracts that cross a package boundary. A rule local
to one function needs only its doc comment and its test.

## Retargeting what links to the document

- About thirty docs linked to the page, including `CLAUDE.md` (two links and the "read the
  linked doc in full" instruction), `packages.md`, `gen-graphs.md`, `asset-stores.md` and
  `.commentlintrc.json`. Ten of these links use a section anchor.
- `pnpm check:doclinks` fails on every dead link, so it finds them all. Each one is
  retargeted to the solver module, the package that now enforces the rule, or the contract
  id.
- `CLAUDE.md`'s "Core ideas" paragraph becomes a pointer to the solver package and the
  contract marker.

## Suggested sequence

This interleaves with the workflows note's sequence. Each step lands green, and
`prompthash.test.ts` passes unchanged throughout.

0. **Add the write-path import rule** (see above). Move the `done` writer and its three
   callers into folders of their own and register them as `vn/element-types` elements, so
   that no other code may write `done` outside the scheduler.
1. **Move the non-pipeline contracts first.** The script, write-path and seam rules go to
   doc comments and tests in `@vn/store`, `@vn/scriptedit`, `@vn/model` and
   `@vn/providers`, and their sections are deleted from the document. This step has no
   design risk, removes about half the document, and does not depend on anything else.
2. **Extract the solver.** Move the derivation files out of `@vn/artgen` into a new pure
   package, then make the planner, gate, collector, validator and export read one derived
   state. Delete the agreement test and the agreement sentences once they have only one
   code path to describe.
3. **Retire the legacy runners.** Make every slot run through a default subgraph, with
   identity unchanged.
4. **Decide graph drift.** Either fold bound-graph edits into identity or keep
   `requeueDrifted`, measured against a real project's journals.
5. **Delete the document** once the remaining sections, which by then cover only
   execution, sit as doc comments and markers in the executor, and every link is
   retargeted.

## Decisions needed

| #   | Decision                                                     | Leaning                                                           |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | Two pieces or three (solver, generation graph, executor)     | Decided 2026-11-17: three                                         |
| 2   | Merge `@vn/taskgraph` into `@vn/gengraph`, or only the model | Only the model; taskgraph stays free of path.ux                   |
| 3   | Solver as plain TS rules or a Datalog-style engine           | Plain TS; revisit if the rule set outgrows a reader               |
| 4   | Bound-graph edits: drift, or part of identity                | Identity, if the journal makes the re-key free; measure first     |
| 4a  | Fix the late-binding gap now, ahead of the refactor          | Yes; it is a live bug and the default-graph test is reused        |
| 4b  | Should unbinding a graph restore the built-in picture        | Yes, under identity; the unbind command's `check` states the cost |
| 5   | Contract marker in code, or doc comments alone               | Marker for cross-package contracts; comments for local ones       |
| 6   | Where the solver sits in the layering                        | Below `pipeline` and `authoring`, beside `artgen`; no path.ux     |
| 7   | Import check: a script over `ALLOWED`, or rules in lintrix   | Decided 2026-11-17: lintrix (`vn/element-types`, `vn/no-cycle`)   |

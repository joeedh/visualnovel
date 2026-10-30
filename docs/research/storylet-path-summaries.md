# Summarising Paths Through a Storylet Graph

<!-- toc -->

- [The goal](#the-goal)
- [Decisions](#decisions)
- [The four papers](#the-four-papers)
    - [PLOTTER: planning on an event graph](#plotter-planning-on-an-event-graph)
    - [Pan et al.: an editable knowledge graph beside an LLM](#pan-et-al-an-editable-knowledge-graph-beside-an-llm)
    - [NSPIN: inducing a planning domain from prose](#nspin-inducing-a-planning-domain-from-prose)
    - [IVIE: generating worlds with validation gates](#ivie-generating-worlds-with-validation-gates)
- [What the papers do not cover](#what-the-papers-do-not-cover)
- [Design](#design)
    - [Enumerate](#enumerate)
    - [Compress](#compress)
    - [Render](#render)
    - [Check](#check)
    - [Write back](#write-back)
- [Open questions](#open-questions)
- [Relation to this repository](#relation-to-this-repository)
- [References](#references)

<!-- tocstop -->

This is the third research note on the storylet model.
[`storylet-system.md`](storylet-system.md) is the architecture pitch and
[`storylet-solver.md`](storylet-solver.md) is the design of the verification solver. This
note covers one feature the system doc sketches in its §4 and the solver doc only touches:
turning a path through the storylet graph into prose a writer can read, so that a human or
an LLM can write the next storylet knowing what came before. It reads four papers against
that feature and records what each one contributes and what none of them cover. Nothing
here is built.

## The goal

A writer opening storylet S asks "what narratives, up to depth X, led here?" Answering
that splits into four pieces, and the papers land on different ones.

1. **Enumerate** the paths into S, to depth X.
2. **Compress** them, because the set is exponential in X and no one can read it as a
   list.
3. **Render** a path, or a class of paths, as prose in story order without inventing
   anything.
4. **Write back.** A human or LLM writes the next storylet from that prose, and its guards
   and effects have to be consistent with the graph it was written from.

## Decisions

These were set by the owner on 2026-10-30.

- **The LLM reads the storylets' own dialogue and actions**, not a list of flags. The task
  is summarisation of text that exists, not generation from a graph.
- **Emotional state is modelled only where gameplay needs it.** Where a quality such as
  trust exists, it exists because a mechanic reads it. Otherwise the writer infers tone
  from the summary, or asks for more detail on a specific path.
- **Drill-down is part of the feature.** The summary is for orientation. A writer who
  wants the subtext opens the path and reads the lines.

## The four papers

| Paper                                                                 | Venue             | What it does                                                                                           | Which piece       |
| --------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| Gu et al., PLOTTER ([2604.21253](https://arxiv.org/abs/2604.21253))   | ACL 2026 Findings | Plans a script on an event graph and a character graph, repairs the graph, then serialises it to prose | Render, check     |
| Pan et al. ([2505.24803](https://arxiv.org/abs/2505.24803))           | IJHCI 2025        | Generates a story scene by scene against a knowledge graph the user can edit; 15-person study          | Render (limits)   |
| Singh et al., NSPIN ([2608.21186](https://arxiv.org/abs/2608.21186))  | arXiv, Aug 2026   | Induces a probabilistic PDDL domain from 2,660 surgical notes                                          | Write back, check |
| Vaucher et al., IVIE ([2606.13348](https://arxiv.org/abs/2606.13348)) | arXiv, Jun 2026   | Generates playable interactive-fiction worlds in four stages, each with a validation gate              | Write back        |

### PLOTTER: planning on an event graph

The closest analogue to the render step.

- The event graph has nodes with an id, a description, a narrative stage and a time, and
  edges typed `CAUSAL`, `FORESHADOWING` and `SUSPENSE`. A character graph carries typed
  relations (conflict, cooperative, emotional, hidden).
- Three critic agents (theme, character, plot) emit structured issues. The taxonomy is
  Theme-Direct, Theme-Vague, Arc-Abrupt, Motive-Weak, One-Dimensional, Discontinuity,
  No-Suspense, No-Foreshadow, No-Turning-Point and Relation-Inconsistent. An editor
  applies atomic operations: Add-Plot-Bridge, Add-Suspense, Add-Foreshadow, Insert-Twist,
  Revise-Event.
- Every edit is checked deterministically, with no LLM involved, and rejected if it fails
  either constraint: the causal subgraph stays a DAG, and every node is reachable from the
  beginning and has a path to the ending.
- **Serialisation comes before prose.** The graph is linearised by a depth-first walk over
  causal and suspense edges, and only then handed to the LLM. The stated reason is that
  raw graph definitions obscure temporal dependencies. Foreshadowing edges are not walked;
  they are attached to the serialised text as cross-references.
- Each scene is written against a rolling memory of what earlier scenes established.
- Results: 50 premises, three backbones, GPT-4.1 as pairwise judge with a human check
  (Cohen's κ 0.834). Large wins on narrative, theme, character and engagement. $1.68 and
  13.6 minutes per script at the default of three refinement rounds.

What transfers:

- Linearise the path in story time before the LLM reads it, and attach "pays off later in
  Y" as annotations rather than as events.
- The critic taxonomy is a set of checks over an **event sequence**, and a path through
  the storylet graph is an event sequence. Discontinuity and Motive-Weak over a path point
  at the place a bridging storylet is missing. Add-Plot-Bridge on a path means "write the
  storylet that makes this transition earned".
- The reachability constraint is the solver doc's orphan and trap checks for the
  degenerate case of one linear story with no state.

What does not: PLOTTER's graph is one DAG, one story. It has nothing on many alternative
histories converging on one node.

### Pan et al.: an editable knowledge graph beside an LLM

Relevant for what the prose can and cannot carry.

- Before each scene the pipeline retrieves the subgraph relevant to that scene, generates
  the scene, then updates the graph from it. In edit mode the user changes the graph
  directly and regenerates.
- Over all stories the knowledge graph made no significant difference. A post-hoc split
  did: for **kinetic** stories (heists, quests, combat) it helped significantly (p =
  0.039); for **introspective** stories it hurt, nearly significantly (p = 0.07), with
  participants calling the results literal and rigid.
- Edits that named concrete, observable changes landed reliably. Edits about ambiguity,
  latent resentment or unreliable memory came out as explicit statements or did not
  propagate. The authors' suggestion is to express introspective intent as observable
  proxies: environmental cues, timing mismatches, decision points.
- Editing was popular: 13 of 14 would use it again.

What transfers, given the decisions above:

- The flattening result is about generating prose **from** a graph of facts. With the
  storylets' own dialogue as input, the graph only selects which text to read and the tone
  lives in the dialogue. The concern shrinks to ordinary summarisation risk, which the
  paper cites but does not test: LLMs summarising short fiction miss subtext (Subbiah et
  al. 2024) and drop or misattribute details over long inputs (Kim et al. 2024). The
  drill-down decision answers that.
- The flattening result still applies to the one part of a summary that **is** generated
  from flags: the preamble covering history from before the depth window (see
  [Compress](#compress)). That part is meant to be a list of facts, so it is acceptable
  there.
- Where a quality such as trust is modelled, the summary should show its change at the
  storylet where it happened, beside the dialogue that caused it. The number carries the
  mechanics; the dialogue carries the tone.
- The retrieval step is the content-side view of the solver doc's variant-count
  projection: build the summary from the variables and lines S actually reads.

### NSPIN: inducing a planning domain from prose

The reverse direction: prose to structure. Relevant to the write-back step and to one risk
in rendering.

- An LLM writes a schema of typed objects, observation predicates and action predicates. A
  second model extracts a grounded predicate sequence from each note **K times**, and the
  samples are merged by majority filtering, consensus voting on arguments and Kemeny rank
  aggregation for order, implemented in Clingo (answer set programming).
- The LLM imputes steps the writer omitted as obvious, again K times with the same
  aggregation. A domain expert judged the imputed steps correct.
- A data-driven inducer builds preconditions and maximum-likelihood effect probabilities.
  The LLM then proposes looser preconditions, **accepted only if validation does not get
  worse**. That halves the rate at which preconditions wrongly forbid the real next action
  (0.36 to 0.16). LLM-only baselines sit at 0.68 to 0.74.
- The paper also runs this note's task in miniature: action sequences sampled from the
  induced model, written out as synthetic notes by an LLM, reviewed by the expert. The
  structure was right and rare details were wrong.

What transfers:

- A PDDL action is a storylet: a guard plus a declared set of outcomes. The solver doc's
  declared gameplay writes are these effects without the probabilities.
- The K-sample consensus is a robust way to read guards and effects out of a storylet an
  LLM or human just wrote in prose, before the solver checks them. The same technique
  applies to rendering: sample several summaries and keep the claims most of them make.
- Imputation is the rendering risk. With dialogue present there is far less gap to fill
  than NSPIN had, but a summariser will still smooth over something the path did not do.
  NSPIN's acceptance rule has a direct analogue: keep a summary claim only if the path
  supports it (see [Check](#check)).
- Answer set programming is an engine the solver doc's list (Z3, BDDs, IC3, TLC/nuXmv)
  does not mention, and there is a precedent for it in this domain (Wang and Kreminski
  2024).

### IVIE: generating worlds with validation gates

The write-back step, with two cautionary failures observed in a shipped system.

- Four stages (adventure core, world structure, world materialisation, challenges), each
  ending in a validation gate: schema checks, depth-first search for spatial connectivity,
  bidirectional connections, and objective completability per objective type. Fixable
  problems are corrected in place; structural failures regenerate the stage with the error
  spelled out, up to three times.
- Every entity carries a `relevance_to_objective` field, which suppressed decorative
  content.
- The authors tried to have the LLM produce strictly sequenced puzzle chains. It kept
  producing circular references, and they dropped the hard sequence.
- Two of sixteen worlds passed every validation stage with an item that existed but had no
  location. The completability check did not model that precondition.
- In three of sixteen worlds players typed "I solve the puzzle" with no answer and the
  reasoning model accepted it. The symbolic layer applied an LLM-proposed state change
  without checking its prerequisites.
- Coherence across turns needed a retrieval memory (top-3 by embedding), which sometimes
  mixed contexts.

What transfers:

- The two failures are the ones the solver doc's rules exist to prevent: every state write
  is declared, and the solver and the runtime share one semantics. A storylet written from
  a summary goes through the solver's gates before it joins the graph, or the result is
  IVIE's second failure.
- The puzzle-chain failure argues for the same division PLOTTER uses: the LLM proposes, a
  checker enforces acyclicity and reachability.
- In the storylet model the set-once `fired` flags **are** the episodic memory. The path
  is the memory, exact rather than retrieved, so no embedding store is needed for
  coherence.

## What the papers do not cover

All four render **one** path. "Narratives up to depth X" is a set that grows exponentially
with X. The solver doc already contains the answer, and this is where the two documents
meet:

- The explicit-state engine keeps the explored state graph, and the trap check already
  searches backwards from the endings. The same backward search from S gives its exact
  depth-X predecessor set within S's slice. This replaces the system doc's "bounded
  reverse random walk": exhaustive within the slice rather than sampled.
- The variant-count projection groups entry states by the variables S's content reads.
  Those groups are the equivalence classes a summary is written per, not per path.
- Breadth-first order gives the shortest representative path for each class, which is the
  most readable one to serialise.

None of the papers address the state-space problem the solver doc is about, so they do not
change the solver design. They supply the per-path rendering technique, and the solver
supplies the compression.

## Design

### Enumerate

- Backward reachability from S within S's slice, bounded at depth X, using the solver's
  explicit-state engine. Not a random walk.
- Group the resulting entry states into equivalence classes by the resolved content of the
  path (see [Compress](#compress)).
- Pick the shortest path per class as its representative. Keep the class size and the
  carried facts that distinguish it from its neighbours.

### Compress

- **Tokens are the constraint.** A path of thirty storylets with full dialogue is tens of
  thousands of tokens, and there are many paths. PLOTTER's rolling memory and Pan's
  running summary are the same answer: no single call sees everything.
- **Two-tier cache.** A per-storylet summary keyed by a hash of the storylet's text,
  computed once and reused on every path through it. A path summary composed from storylet
  summaries, keyed by the sequence of hashes. The shape matches the content-addressed task
  graph.
- **Resolved dialogue.** The text a path actually shows is conditional: beat-group
  alternatives, lines gated on flags, the version with whichever companion survived.
  Walking the path evaluates those conditions and hands the LLM the resolved text. The
  equivalence classes from [Enumerate](#enumerate) are the distinct resolved texts, and
  the variables that condition lines are exactly S's read-set.
- **Beyond depth X.** Set-once flags carry history from before the window. The summary is
  a terse factual preamble from flags ("Vel died on Omega; Oren was spared") followed by
  the narrative window from dialogue.
- **Drill-down goes to the raw dialogue**, never to the summaries, so the compression
  never hides anything permanently.

### Render

- Serialise the representative path in story time before the LLM reads it. Attach
  foreshadowing and later payoffs as annotations, not as events.
- Restrict the input to S's read-set: the storylets, lines and variables that condition
  S's content.
- Where a quality changes on the path, show the change at the storylet where it happened,
  beside the dialogue that caused it.
- Write per class, in two tiers: facts true in **every** path of the class, and facts that
  vary **across** classes stated as conditionals. The system doc's "upstream invariants"
  become verified rather than asserted.
- The summary is factual and non-prescriptive, as the system doc's §4.2 already requires.

### Check

- **Citations.** Every summary claim cites its source as `sceneId:lineId`. Line ids
  already exist as a pipeline contract. The faithfulness check becomes mechanical (does
  the cited line support the claim?), the writer's drill-down has a target, and the
  incremental re-check has a reason to invalidate a summary when a cited line changes.
- **Consensus.** Sample K summaries and keep the claims a majority make, after NSPIN.
- **Scope.** A fact that holds on some paths in a class must not be written as holding on
  all. This is the solver doc's timeline-consistency check applied to the summary itself.
- **Critics over the path.** PLOTTER's Discontinuity, Motive-Weak and Arc-Abrupt run over
  the resolved dialogue of the representative path. A hit is a place where a bridging
  storylet is missing, reported to the writer as such.

### Write back

- A storylet written from a summary, by a human or an LLM, goes through extraction of its
  guards and effects (NSPIN's K-sample consensus when the source is prose) and then
  through the solver's gates before it joins the graph.
- The two IVIE failures are the acceptance criteria: no state write the solver cannot see,
  and no transition the checker did not model.
- The system doc's §4 describes the dossier as read-only. The write-back step is where
  that ends, and it is the same path a hand-written storylet takes.

## Open questions

- **Depth X in storylets or in story time.** A path of X storylets can span one evening or
  two games. Whether the window is counted in storylets, in story-time units from the
  [Time](storylet-solver.md#time) ladder, or in both is open.
- **Class granularity.** Grouping by every variable in S's read-set can produce dozens of
  classes that differ in one line. Whether to merge classes whose resolved texts differ
  below some threshold, and who decides the threshold, is open.
- **Where the per-storylet summary is stored.** In the project repository beside the
  storylet, so a collaborator gets it, or in a local cache, so a storylet edit does not
  produce a summary commit. The content-addressed key works either way.
- **Cost.** PLOTTER spends $1.68 per script with three refinement rounds. A project with
  thousands of storylets and a summary per class per storylet is a different budget, and
  the two-tier cache is what makes it tractable. The first prototype should measure cache
  hit rates on a real outline.
- **Critic reliability on dialogue.** PLOTTER's critics judged node descriptions. Whether
  they are as reliable on resolved dialogue, where the author's intent is less explicit,
  is untested.

## Relation to this repository

- **Line ids**
  ([`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md)) are the
  citation target for summary claims. Nothing new is needed for the mechanism; the
  storylet model inherits it.
- **The content-addressed task graph** is the shape of the two-tier summary cache: a
  result keyed by a hash of its inputs, reused while they are unchanged.
- **Prose drift reporting** is the existing precedent for a derived text that is checked
  against its source and flagged when the source moves.
- **`vnauthor`** is the host for the critic layer and the write-back loop. Its plan-first,
  approval-gated shape already matches "the LLM proposes, a checker rejects". The current
  story model has no runtime state, so none of this applies to it until the storylet model
  exists.

## References

- Gu, H., Guo, C., Wang, J., Xie, W., Lv, Y. (2026). _Planning Beyond Text: Graph-based
  Reasoning for Complex Narrative Generation_ (PLOTTER). Findings of ACL 2026.
  arXiv:2604.21253.
- Pan, Z., Andronis, A., Hayek, E., Wilkinson, O. A. P., Lasy, I., Parry, A., Gadney, G.,
  Smith, T. J., Grierson, M. (2025). _Guiding Generative Storytelling with Knowledge
  Graphs_. International Journal of Human-Computer Interaction. arXiv:2505.24803.
- Singh, R., Mathur, S., Skinner, M., Tadepalli, P., Kersting, K., Natarajan, S. (2026).
  _A Neurosymbolic Approach for Constructing Planning Domain Models from Clinical
  Narratives_ (NSPIN). arXiv:2608.21186.
- Vaucher, M., Silveira, S., Góngora, S., Chiruzzo, L. (2026). _IVIE: A Neuro-symbolic
  Approach to Incremental and Validated Generation of Interactive Fiction Worlds_.
  arXiv:2606.13348.
- Cited by the above and not read for this note: Kim et al. (2024), _FABLES: Evaluating
  faithfulness and content selection in book-length summarization_, arXiv:2404.01261;
  Subbiah et al. (2024), _Reading Subtext_, TACL 12; Wang and Kreminski (2024), _Guiding
  and diversifying LLM-based story generation via answer set programming_,
  arXiv:2406.00554; Kelly et al. (2023), _There and Back Again: Extracting Formal Domains
  for Controllable Neurosymbolic Story Authoring_, AIIDE 19.

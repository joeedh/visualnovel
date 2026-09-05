# Comparable systems

_This is an external survey. Nothing here is a plan and nothing here is load-bearing for
the code. It records what else existed in this space as of August 2026, so that a decision
about export targets, camera continuity, or scope can be made against the field rather
than against nothing._

Status: **reference.** Nothing below is an interoperability constraint, unlike
[`../history/visualNovelFormats.md`](../history/visualNovelFormats.md), which surveys
formats this project has to interoperate with. This page gives competitive and prior-art
context, and it will rot faster than any other document in `docs/`.\_

<!-- toc -->

- [Why this document exists](#why-this-document-exists)
- [A caveat about sources](#a-caveat-about-sources)
- [The four camps](#the-four-camps)
    - [1. Prompt-to-VN products](#1-prompt-to-vn-products)
    - [2. The open-source agent layer](#2-the-open-source-agent-layer)
    - [3. Multi-agent story-to-play research](#3-multi-agent-story-to-play-research)
    - [4. Generative previsualisation](#4-generative-previsualisation)
- [What this project has that none of them do](#what-this-project-has-that-none-of-them-do)
- [Where this project is exposed](#where-this-project-is-exposed)
- [The previz overlap, stated precisely](#the-previz-overlap-stated-precisely)
- [What would change this assessment](#what-would-change-this-assessment)
- [Open questions](#open-questions)

<!-- tocstop -->

## Why this document exists

Three decisions in the backlog are hard to make in isolation and easy to make against a
field:

- **Whether to ship an engine export target besides `story.play.json`**
  ([`../reference/playable-format.md`](../reference/playable-format.md)). Lock-in is a
  risk only relative to the alternatives an author has.
- It is undecided whether camera and staging continuity across a scene is a gap worth a
  plan or a limitation of the medium.
- **How much of this system is visual-novel-specific.** The requirements already note the
  manga and storyboard applications
  ([`../history/designRequirementsEtc.md`](../history/designRequirementsEtc.md)). The
  survey below suggests the transferable part is not the part a reader would expect.

## A caveat about sources

The phrase "AI visual novel generator" is a heavily optimised search term. A large
fraction of what a search returns is content marketing published by tools that do not
generate visual novels — pages titled _Best AI Visual Novel Generator 2026_ that exist to
rank rather than to inform. Several of the products named below are known only through
their own marketing, and their claims have not been verified against a running build. This
document relies on the research citations and does not rely on the product claims.

A product described as "single-shot" shows no evidence of provenance, approval state,
resumability, or any notion of a generated artifact becoming stale. Absence of evidence in
marketing material is weak evidence, but it carries some weight for these particular
properties, because a product that had them would advertise them.

## The four camps

### 1. Prompt-to-VN products

This is the commercial layer. A user describes a story and receives a scaffold.

**[Summer Engine](https://www.summerengine.com/ai-visual-novel-maker)** is the closest
comparable and the most substantial. It is an AI-native desktop engine with a dedicated
visual-novel mode: branching dialogue, character sprites with named expressions,
backgrounds, save/load, route-select screens, affection counters. It is agentic in the
coding sense: it runs the project, reads the errors, fixes them, edits scenes. The notable
part is its distribution: standard Godot 4 projects, an open-source core, no royalties, no
lock-in. See [Where this project is exposed](#where-this-project-is-exposed).

**[Astrocade 2.0](https://www.astrocade.com/blog/astrocade-2-worlds-first-agentic-ai-game-creation-platform)**
is advertised as the first agentic AI game-creation platform. It generates general-purpose
games rather than specialising in VNs.

A cluster of prompt-to-VN web tools sits below those: LlamaGen, Chatforce, Seeles, Jenova,
and Figma's VN prototyping page. These tools appear to be single-shot generators with a
content-marketing operation attached.

None of them appear to have a task graph, an asset manifest, an approval gate, a review
loop, or a way to answer "which of these frames is out of date". They fall into the
category of generation rather than production.

### 2. The open-source agent layer

**[renpy-mcp](https://github.com/fracturedring/renpy-mcp)** is the most architecturally
interesting project in this camp. It pairs a browser-based Ren'Py editor with a ~74-tool
MCP server, is AGPL, and is explicitly built to be driven by an external coding agent. Its
tools are tiered into reads, writes, high-level authoring intents and escape hatches. The
project is also very early, with single-digit stars and a few dozen commits.

**[RenPy-AutoScriptPlugin](https://github.com/Wendy-Nam/RenPy-AutoScriptPlugin)** also
automates LLM dialogue and narration inside Ren'Py, and one documented case reports an
agent generating a working Ren'Py VN end-to-end in about ten minutes
([Hermes Agent](https://fyve.co.jp/ai-agents/hermes-agent/articles/case-exileai-visual-novel)).

This camp gives an agent the ability to act, but no information about production
economics. A tool surface defines how to place a sprite. It carries no information about
whether that sprite has been approved, whether it has already been generated, what it
cost, or whether the line it illustrates still exists. Every property in
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) is absent by
construction, because a tool server is stateless with respect to production.

This camp's shape is closest to a piece of this project — `vnauthor`'s tool registry is
the same idea ([`../reference/vnauthor.md`](../reference/vnauthor.md)) — and it has the
least depth.

### 3. Multi-agent story-to-play research

**[RPGAgent](https://dl.acm.org/doi/10.1145/3772318.3790326)** (CHI 2026) is the most
directly on-point academic work: an LLM-based multi-agent system for coherent
story-to-play generation. Adjacent work includes
[GameGPT](https://arxiv.org/abs/2310.08067) (multi-agent collaborative game development),
[GameUIAgent](https://arxiv.org/abs/2603.14724), and
[Dramaturge](https://arxiv.org/html/2510.05188v3) (iterative narrative script refinement
by collaborating agents). Dramaturge is the nearest published analogue to the P7 generate
→ critique → refine loop.

This camp demonstrates feasibility, not durability. The papers establish that multi-agent
decomposition of a story into playable scenes works. None of them ship the parts that
consumed most of this repo (a paper does not need to): resumability across a crash,
content-addressed dedupe so identical work is not bought twice, bounded retry with a
persisted reason, a report derived from the live plan rather than from what one process
happened to touch, or any notion of an artifact drifting out of date. Those are the
contracts in [`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md),
and each was written after the corresponding failure.

The reading worth taking from this camp is that the generative decomposition is the solved
part and the infrastructure around it is the unsolved part. Attention runs the other way
around.

### 4. Generative previsualisation

This camp solves the project's central problem (character, location and shot consistency
across a sequence) from the opposite direction. It has real budget behind it, because film
pre-production has real budget.

The representative published work is
[PrevizWhiz](https://dl.acm.org/doi/10.1145/3772318.3790534) (CHI 2026), which uses rough
3D scenes as a control signal to guide generative video previsualisation. Commercial
exhibitors at SIGGRAPH 2026 are working in the same area, as the
[exhibition report](https://3dvf.com/en/siggraph-2026-the-exhibition-opens-balancing-continuity-and-new-industry-trends/)
records.

[The previz overlap, stated precisely](#the-previz-overlap-stated-precisely) states the
distinction.

## What this project has that none of them do

There are four, and each is already a stated contract rather than an aspiration.

1.  1. **Content-addressed task identity is the cost-control primitive.** The task id is
       `sha256(kind, inputs)` over the normalised prompt, ordered reference asset hashes,
       model id and params. Every status transition is appended to `state/tasks.jsonl`,
       and the graph is rebuilt by replay. Dedupe, resumability and staleness all follow
       from that one decision. None of the systems in the camps described above treats
       avoiding paying for the same frame twice as an architectural invariant rather than
       a caching afterthought.

2.  2. **Drift: art checked against the words it illustrates.** `Shot.proseHash` is
       stamped only beside new bytes, and `driftOf` re-derives
       `unrendered | current | drifted | unknown` on every read. The stamped value is
       deliberately not the task hash, and the drift state is deliberately not stored. As
       far as this survey found, no other project does this. See
       [the previz overlap](#the-previz-overlap-stated-precisely) for why the uniqueness
       claim is larger than it sounds.

3.  3. **An approved base library is never regenerated.** A base root present without a
       manifest is `unavailable`, and the planner plans nothing rather than re-buying an
       approved library at cost. A rule like this one gets written only after the cost has
       been paid once, and it is the clearest single marker that this is a production
       system rather than a generator.

4.  4. **Git holds the state.** The tool discovers a map of the repos, and every act
       commits to each repo it touched. Undo keeps shadow snapshots under
       `refs/vn/undo/<seq>` and restores them as a new commit rather than as a reset,
       composed across several repos. Nobody else in this survey treats the version
       control system as the substrate rather than as somewhere the output eventually gets
       copied.

Every one of these concerns an artifact's history and validity, not generation quality.
This project is differentiated on that axis, and deliberate attention to it is worth the
effort, because no one else is competing on history and validity.

## Where this project is exposed

- **Camera and staging continuity.** This is the weakest axis, and the next section covers
  it. Reference images and model sheets hold a character's appearance across shots. Those
  images do not hold eyeline, screen direction, or the fact that the door is on the left
  in every shot of this room. A 2D prompt with reference attachments has no representation
  in which those facts exist.

- **Export lock-in.** `story.play.json` is in-house. Summer Engine offers a standard Godot
  4 project with no royalties, and that offer is a real adoption argument. Mitigating the
  lock-in costs little for what it gives: Fountain already round-trips
  ([`../plans/archive/INDEX.md#fountain-import-export`](../plans/archive/INDEX.md#fountain-import-export)),
  the playable projection is already manifest-driven
  ([`../reference/playable-format.md`](../reference/playable-format.md)), and a Ren'Py or
  Godot target would be another projection rather than a new architecture.

- **Retrieval.** Retrieval is grep-shaped and has known defects — see
  [`retrieval-beyond-grep.md`](retrieval-beyond-grep.md). It sits behind a seam, so
  replacing it is a swap rather than a rewrite, but it is currently below the standard of
  the rest of the system.

- **Single-author scale.** The product has no collaboration model, no multi-user story,
  and no review workflow for more than one person. That choice is probably correct for
  now. A funded competitor would build collaboration first, because collaboration is what
  turns a tool into a purchase order.

- **Still output.** Every camp above except §2 targets video. This project produces
  stills, which suits a visual novel and sets a hard boundary for the manga and storyboard
  applications named in the requirements.

## The previz overlap, stated precisely

Both this project and the previz camp solve consistency across a sequence. They solve it
with different primitives, and each difference takes one line to state:

- **Previz achieves consistency through geometry.** A rough 3D scene constrains
  generation. The scene represents camera position, spatial relationships and screen
  direction, so each one can be checked and generation is consistent by construction.
- **This project achieves consistency through provenance and critique.** Model sheets and
  ordered reference images pin appearance by reference. The P7 loop pins correctness by
  review, and `shotSpec` tells the reviewer what the shot ordered rather than what the
  scene contains.

Geometry produces better staging than reference images do, and reference-image discipline
cannot close that gap, because the facts geometry checks are not present in the
representation at all.

The trade runs both ways, and the other direction is under-appreciated. Film
pre-production revises scripts constantly, and this survey found no solution in that camp
to the question "page 34 changed — which previz shots are now stale?". `driftOf` answers
that question. It is built, it is medium-agnostic, and it does not depend on anything
visual-novel specific. The same applies to the content-addressed task graph: a previz
pipeline regenerating identical frames across revisions burns a budget much larger than
this project's.

Two consequences are worth recording:

1.  1. **A crude 3D blocking stage adds a task kind rather than requiring a rewrite.** The
       stage would sit between P5 decomposition and shot rendering, and it would produce a
       layout artifact that the shot prompt references. That artifact reaches the planner
       a wave later than the decomposition, just as a shot already waits on its location
       plate and a non-default outfit already waits on its sheet
       ([`../plans/archive/INDEX.md#outfits-at-scene-and-shot-level`](../plans/archive/INDEX.md#outfits-at-scene-and-shot-level)).
       The graph handles it. This is the cheapest available answer to the
       camera-continuity gap, and it costs none of the four properties listed above.

2.  2. **The infrastructure is more transferable than the renderer.** The task graph, the
       manifest, the gate, the refine loop and drift are all medium-agnostic. Fountain,
       branch markers and the playable projection form the comparatively thin layer that
       makes this a visual novel system. Retargeting the project at another market would
       mean replacing that layer and keeping the rest. The market with budget is at
       SIGGRAPH rather than on itch.io.

## What would change this assessment

- **A prompt-to-VN product ships provenance or approval state.** Such a product competes
  on the production-vs-generation distinction rather than ignoring it, and the four
  properties above stop being differentiators.
- **A previz product shipping script-to-shot staleness.** `driftOf` is the most defensible
  part of it. Neither a patent nor the difficulty of building it protects `driftOf`; it is
  defensible only because nobody has thought it worth building yet.
- **renpy-mcp or a successor gaining state.** Adding a persistent task graph would make
  the tool-surface camp a different kind of competitor, and that camp starts with
  distribution this project does not have (an existing engine, an existing community).
- **Video becoming cheap enough that stills look dated.** Cheap video would leave the
  infrastructure unchanged and would change everything else.

## Open questions

- **Should an engine export target be planned now, or would a plan answer a demand that
  has not appeared?** The argument for planning now is that an export target is cheapest
  to add while the playable projection is young. The argument for waiting is that no
  author has asked.
- Does the 3D blocking stage belong in this repo at all? The overlap with previz argues
  that the layout artifact could be an input contract (something an author can supply from
  a real 3D tool) rather than something this system generates. Treating the layout
  artifact as an input contract is much cheaper and probably strictly better for anyone
  who already has a DCC in their pipeline.
- **Should `driftOf` be documented as a general result** rather than as a contract of this
  repo? `driftOf` is the most novel thing in this repo, and is currently written down only
  as an implementation detail of a shot.

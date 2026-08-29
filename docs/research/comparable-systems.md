# Comparable systems

_Survey, external. Nothing here is a plan and nothing here is load-bearing for the code. It
records what else existed in this space as of **August 2026**, so that a decision about export
targets, camera continuity, or scope can be made against the field rather than against nothing._

_Status: **reference.** Unlike [`../history/visualNovelFormats.md`](../history/visualNovelFormats.md), which
surveys formats this project has to interoperate with, nothing below is an interoperability
constraint. It is competitive and prior-art context, and it will rot faster than any other
document in `docs/`._

<!-- toc -->

- [Why this document exists](#why-this-document-exists)
- [A caveat about sources](#a-caveat-about-sources)
- [The four camps](#the-four-camps)
  * [1. Prompt-to-VN products](#1-prompt-to-vn-products)
  * [2. The open-source agent layer](#2-the-open-source-agent-layer)
  * [3. Multi-agent story-to-play research](#3-multi-agent-story-to-play-research)
  * [4. Generative previsualisation](#4-generative-previsualisation)
- [What this project has that none of them do](#what-this-project-has-that-none-of-them-do)
- [Where this project is exposed](#where-this-project-is-exposed)
- [The previz overlap, stated precisely](#the-previz-overlap-stated-precisely)
- [What would change this assessment](#what-would-change-this-assessment)
- [Open questions](#open-questions)

<!-- tocstop -->

## Why this document exists

Three decisions in the backlog are hard to make in isolation and easy to make against a field:

- **Whether to ship an engine export target** besides `story.play.json`
  ([`../reference/playable-format.md`](../reference/playable-format.md)). Lock-in is only a risk relative to what an
  author's alternative is.
- **Whether camera and staging continuity across a scene** is a gap worth a plan, or a
  limitation of the medium.
- **How much of this system is visual-novel-specific** at all. The requirements already note the
  manga and storyboard applications ([`../history/designRequirementsEtc.md`](../history/designRequirementsEtc.md));
  the survey below suggests the transferable part is not the part one would guess.

## A caveat about sources

The phrase "AI visual novel generator" is a heavily optimised search term. A large fraction of
what a search returns is content marketing published by tools that do not do the thing — pages
titled *Best AI Visual Novel Generator 2026* that exist to rank rather than to inform. Several of
the products named below are known only through their own marketing, and their claims have not
been verified against a running build. The research citations are load-bearing; the product
claims are not.

Where a product is described as "single-shot", that means: no evidence of provenance, approval
state, resumability, or any notion of a generated artifact becoming stale. Absence of evidence
in marketing material is weak evidence, but for these particular properties it is not nothing —
they are the sort of thing a product that had them would advertise.

## The four camps

### 1. Prompt-to-VN products

The commercial layer. Describe a story, receive a scaffold.

**[Summer Engine](https://www.summerengine.com/ai-visual-novel-maker)** is the closest comparable
and the most substantial. An AI-native desktop engine with a dedicated visual-novel mode:
branching dialogue, character sprites with named expressions, backgrounds, save/load, route-select
screens, affection counters. It is agentic in the coding sense — it runs the project, reads the
errors, fixes them, edits scenes. Its distribution story is the notable part: **standard Godot 4
projects, open-source core, no royalties, no lock-in.** See
[Where this project is exposed](#where-this-project-is-exposed).

**[Astrocade 2.0](https://www.astrocade.com/blog/astrocade-2-worlds-first-agentic-ai-game-creation-platform)**
bills itself as the first agentic AI game-creation platform. General-purpose game generation, not
VN-specialised.

Below those, a cluster of prompt-to-VN web tools — LlamaGen, Chatforce, Seeles, Jenova, and
Figma's VN prototyping page. These appear to be single-shot generators with a content-marketing
operation attached.

**What none of them appear to have:** a task graph, an asset manifest, an approval gate, a
review loop, or a way to answer "which of these frames is out of date". The category is
*generation*, not *production*.

### 2. The open-source agent layer

**[renpy-mcp](https://github.com/fracturedring/renpy-mcp)** is the most architecturally
interesting thing in this camp: a browser-based Ren'Py editor plus a ~74-tool MCP server,
explicitly built to be driven by an external coding agent, AGPL, tools tiered into reads, writes,
high-level authoring intents and escape hatches. It is also very early — single-digit stars, a
few dozen commits.

Alongside it,
**[RenPy-AutoScriptPlugin](https://github.com/Wendy-Nam/RenPy-AutoScriptPlugin)** (LLM dialogue
and narration automation inside Ren'Py) and one documented case of an agent generating a working
Ren'Py VN end-to-end in about ten minutes
([Hermes Agent](https://fyve.co.jp/ai-agents/hermes-agent/articles/case-exileai-visual-novel)).

**What this camp gives an agent is hands, not economics.** A tool surface says *how* to place a
sprite; it says nothing about whether that sprite has been approved, whether it has already been
generated, what it cost, or whether the line it illustrates still exists. Every property in
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) is absent by construction, because a tool
server is stateless with respect to production.

This is the camp whose *shape* is closest to a piece of this project — `vnauthor`'s tool registry
is the same idea ([`../reference/vnauthor.md`](../reference/vnauthor.md)) — and whose depth is least.

### 3. Multi-agent story-to-play research

**[RPGAgent](https://dl.acm.org/doi/10.1145/3772318.3790326)** (CHI 2026) is the most directly
on-point academic work: an LLM-based multi-agent system for coherent story-to-play generation.
Adjacent: [GameGPT](https://arxiv.org/abs/2310.08067) (multi-agent collaborative game
development), [GameUIAgent](https://arxiv.org/abs/2603.14724), and
[Dramaturge](https://arxiv.org/html/2510.05188v3) (iterative narrative script refinement by
collaborating agents — the nearest published analogue to the P7 generate → critique → refine
loop).

**What this camp demonstrates is feasibility, not durability.** The papers establish that
multi-agent decomposition of a story into playable scenes works. None of them ship — because a
paper does not need to — the parts that consumed most of this repo: resumability across a crash,
content-addressed dedupe so identical work is not bought twice, bounded retry with a persisted
reason, a report derived from the live plan rather than from what one process happened to touch,
or any notion of an artifact drifting out of date. Those are precisely the contracts in
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md), and each of them was written after the
corresponding failure.

The reading worth taking from this camp is that **the generative decomposition is the solved
part**, and the infrastructure around it is the unsolved part. That is an inversion of where the
attention is.

### 4. Generative previsualisation

The camp solving this project's central problem — character, location and shot consistency across
a sequence — from the opposite direction, with real budget behind it, because film
pre-production has real budget.

The representative published work is
**[PrevizWhiz](https://dl.acm.org/doi/10.1145/3772318.3790534)** (CHI 2026): rough 3D scenes used
as a control signal to guide generative video previsualisation. The commercial exhibitors at
SIGGRAPH 2026 are working the same seam
([exhibition report](https://3dvf.com/en/siggraph-2026-the-exhibition-opens-balancing-continuity-and-new-industry-trends/)).

The distinction that matters is in
[The previz overlap, stated precisely](#the-previz-overlap-stated-precisely).

## What this project has that none of them do

Four, each already a stated contract rather than an aspiration.

1. **Content-addressed task identity as the cost-control primitive.**
   `sha256(kind, inputs)` over the normalised prompt, ordered reference asset hashes, model id and
   params, with every status transition appended to `state/tasks.jsonl` and the graph rebuilt by
   replay. Dedupe, resumability and staleness fall out of one decision. No system in any camp
   above treats *not buying the same frame twice* as an architectural invariant rather than a
   caching afterthought.

2. **Drift: art made answerable for the words it illustrates.** `Shot.proseHash`, stamped only
   beside new bytes, with `driftOf` re-deriving `unrendered | current | drifted | unknown` on
   every read — deliberately not the task hash, deliberately not stored. This is, as far as this
   survey found, **unique**. See [the previz overlap](#the-previz-overlap-stated-precisely) for
   why that is a larger claim than it sounds.

3. **An approved base library that refuses to be regenerated.** A base root present without a
   manifest is `unavailable`, and the planner plans *nothing* rather than re-buying an approved
   library at cost. This is the shape of rule that only gets written after it costs someone
   money, and it is the clearest single marker that this is a production system rather than a
   generator.

4. **Git as the database.** A discovered repo map, every act committing to each repo it touched,
   undo as shadow snapshots under `refs/vn/undo/<seq>` restoring as a *new* commit rather than a
   reset, composed across several repos. Nobody else in this survey treats the version control
   system as the substrate rather than as somewhere the output eventually gets copied.

The common thread: every one of these is about **an artifact's history and validity**, not about
generation quality. That is the axis this project is differentiated on, and it is worth being
deliberate about it, because it is not the axis anyone is competing on.

## Where this project is exposed

- **Camera and staging continuity.** The weakest axis, and the subject of the next section.
  Reference images and model sheets hold a character's *appearance* across shots. They do not hold
  eyeline, screen direction, or the fact that the door is on the left in every shot of this room.
  A 2D prompt with reference attachments has no representation in which those facts exist.

- **Export lock-in.** `story.play.json` is in-house. Summer Engine's pitch is a standard Godot 4
  project with no royalties, and that is a real adoption argument. The mitigation is cheap
  relative to what it buys: Fountain already round-trips
  ([`../plans/archive/INDEX.md#fountain-import-export`](../plans/archive/INDEX.md#fountain-import-export)), the playable
  projection is already a manifest-driven projection
  ([`../reference/playable-format.md`](../reference/playable-format.md)), and a Ren'Py or Godot target is another
  projection rather than a new architecture.

- **Retrieval.** Grep-shaped, with known defects — see
  [`retrieval-beyond-grep.md`](retrieval-beyond-grep.md). Behind a seam, so this is a swap rather
  than a rewrite, but it is currently below the standard of the rest of the system.

- **Single-author scale.** No collaboration model, no multi-user story, no review workflow for
  more than one person. Probably correct for now. It is also the first thing a funded competitor
  would build, because it is what turns a tool into a purchase order.

- **Nothing moves.** Every camp above except §2 is heading toward video. This project produces
  stills, which is right for a visual novel and is a hard boundary for the manga and storyboard
  applications the requirements already gesture at.

## The previz overlap, stated precisely

Both this project and the previz camp are solving *consistency across a sequence*. They solve it
with different primitives, and the difference is clean enough to state in one line each:

- **Previz achieves consistency by geometry.** A rough 3D scene constrains generation. Camera
  position, spatial relationships and screen direction are *representable*, therefore checkable,
  therefore consistent by construction.
- **This project achieves consistency by provenance and critique.** Model sheets, ordered
  reference images, and the P7 loop with `shotSpec` telling the reviewer what the *shot* ordered
  rather than what the scene contains. Appearance is pinned by reference; correctness is pinned
  by review.

Geometry wins on staging, and no amount of reference-image discipline closes that gap, because
the facts geometry checks are not present in the representation at all.

**But the trade runs both ways, and the other direction is under-appreciated.** Film
pre-production revises scripts constantly, and the question *"page 34 changed — which previz shots
are now stale?"* is, as far as this survey found, unsolved in that camp. That question is
`driftOf`. It is built, it is medium-agnostic, and it does not depend on anything visual-novel
specific. The same applies to the content-addressed task graph: a previz pipeline regenerating
identical frames across revisions is burning a budget that is much larger than this project's.

Two consequences worth recording:

1. **A crude 3D blocking stage is a task kind, not a rewrite.** Inserted between P5 decomposition
   and shot rendering, it would produce a layout artifact the shot prompt references — arriving at
   the planner a wave later than the decomposition, exactly as a shot already waits on its
   location plate, and exactly as a non-default outfit already waits on its sheet
   ([`../plans/archive/INDEX.md#outfits-at-scene-and-shot-level`](../plans/archive/INDEX.md#outfits-at-scene-and-shot-level)).
   The graph absorbs it. This is the cheapest available answer to the camera-continuity gap and it
   costs none of the four properties above.

2. **The infrastructure is more transferable than the renderer.** The task graph, the manifest,
   the gate, the refine loop and drift are all medium-agnostic. The thing that makes this a
   *visual novel* system is a comparatively thin layer: Fountain, branch markers, the playable
   projection. If this project is ever pointed at another market, that is the seam it would be
   pointed along — and the market with budget is the one at SIGGRAPH, not the one on itch.io.

## What would change this assessment

- **Any prompt-to-VN product shipping provenance or approval state.** That would mean the
  production-vs-generation distinction is being competed on rather than ignored, and the four
  properties above stop being differentiators.
- **A previz product shipping script-to-shot staleness.** The single most defensible thing here
  is `driftOf`, and it is not defensible by patent or by difficulty — only by nobody having
  thought it worth building yet.
- **renpy-mcp or a successor gaining state.** The tool-surface camp is one persistent task graph
  away from being a different kind of competitor, and it starts with distribution this project
  does not have (an existing engine, an existing community).
- **Video becoming cheap enough that stills read as dated.** This would not affect the
  infrastructure and would affect everything else.

## Open questions

- **Is an engine export target worth a plan now, or is it a response to a demand that has not
  appeared?** The argument for now is that it is cheapest while the playable projection is young.
  The argument for later is that no author has asked.
- **Does the 3D blocking stage belong in this repo at all**, or does the previz overlap argue for
  the layout artifact being an *input contract* — something an author can supply from a real 3D
  tool — rather than something this system generates? The second is much cheaper and probably
  strictly better for anyone who already has a DCC in their pipeline.
- **Should `driftOf` be documented as a general result** rather than as a contract of this repo?
  It is the most novel thing here and it is currently written down only as an implementation
  detail of a shot.

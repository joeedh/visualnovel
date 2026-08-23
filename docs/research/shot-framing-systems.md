# Generative shot framing systems

_Research, external. Nothing here is a plan and nothing here is load-bearing for the code. It
surveys how published and shipped systems get a generative image model to produce a **specifically
framed shot** — this many characters, arranged this way, seen from this angle, at this shot scale —
and recommends architectures for building one. The last two sections are the only ones that touch
this repository._

_Status: **research.** A snapshot of **21 August 2026**. Every claim carries a citation, and claims
that could not be verified against a fetched source are marked. The field moves fast enough that the
model-specific material will rot within months; the structural findings should outlast it._

<!-- toc -->

- [How to read this](#how-to-read-this)
  * [A note on sourcing](#a-note-on-sourcing)
- [The stages, and what actually varies between systems](#the-stages-and-what-actually-varies-between-systems)
- [Generating a scene layout](#generating-a-scene-layout)
  * [The three families](#the-three-families)
  * [The geometric primitive determines the quality ceiling](#the-geometric-primitive-determines-the-quality-ceiling)
  * [Learned scene synthesis is a separate lineage and mostly not what you want](#learned-scene-synthesis-is-a-separate-lineage-and-mostly-not-what-you-want)
  * [Solvers, if a solver is wanted](#solvers-if-a-solver-is-wanted)
- [Choosing the camera and the framing](#choosing-the-camera-and-the-framing)
  * [The classical foundations still hold](#the-classical-foundations-still-hold)
  * [The evidence says use a small discrete vocabulary](#the-evidence-says-use-a-small-discrete-vocabulary)
  * [Shot scale and camera angle can be measured automatically](#shot-scale-and-camera-angle-can-be-measured-automatically)
  * [The domain gap is real, and it is uneven](#the-domain-gap-is-real-and-it-is-uneven)
  * [Learned camera control is mostly aimed at video](#learned-camera-control-is-mostly-aimed-at-video)
  * [The LLM film agents are weakly evidenced](#the-llm-film-agents-are-weakly-evidenced)
- [Conditioning the image model](#conditioning-the-image-model)
  * [ControlNet, and why it does not transfer to modern models](#controlnet-and-why-it-does-not-transfer-to-modern-models)
  * [What replaced ControlNet on DiT models](#what-replaced-controlnet-on-dit-models)
  * [Control strength has three orthogonal axes](#control-strength-has-three-orthogonal-axes)
  * [The 3D proxy versus 2D layout question, and why it is not settled](#the-3d-proxy-versus-2d-layout-question-and-why-it-is-not-settled)
  * [Known failure modes of proxy conditioning](#known-failure-modes-of-proxy-conditioning)
  * [Rendering the control signal](#rendering-the-control-signal)
- [Validating the result](#validating-the-result)
  * [Four things "self-checking" can mean](#four-things-self-checking-can-mean)
  * [What the closed-loop systems actually verify](#what-the-closed-loop-systems-actually-verify)
  * [The three nearest misses](#the-three-nearest-misses)
  * [Vision-language models are weak at cinematography, which is the reason](#vision-language-models-are-weak-at-cinematography-which-is-the-reason)
  * [The synthesis that nobody has published](#the-synthesis-that-nobody-has-published)
  * [Judge infrastructure, if a VLM judge is used anyway](#judge-infrastructure-if-a-vlm-judge-is-used-anyway)
- [Keeping the same character across shots](#keeping-the-same-character-across-shots)
  * [Two families, and the split that matters](#two-families-and-the-split-that-matters)
  * [There is no validated automated metric for whole-character consistency](#there-is-no-validated-automated-metric-for-whole-character-consistency)
  * [What the practitioner community actually does](#what-the-practitioner-community-actually-does)
- [Inserting a character into an existing plate](#inserting-a-character-into-an-existing-plate)
  * [Four method families, and the conditioning generations behind them](#four-method-families-and-the-conditioning-generations-behind-them)
  * [One benchmark measures it, and the numbers are discouraging](#one-benchmark-measures-it-and-the-numbers-are-discouraging)
  * [What is actually hard, and which parts are measured](#what-is-actually-hard-and-which-parts-are-measured)
  * [The domain gap again, in methods and data this time](#the-domain-gap-again-in-methods-and-data-this-time)
  * [Evaluation: five metrics carry a human-correlation number, and none covers scale](#evaluation-five-metrics-carry-a-human-correlation-number-and-none-covers-scale)
  * [Cost and control against re-rendering the whole frame](#cost-and-control-against-re-rendering-the-whole-frame)
  * [Which hosted APIs can insert into a plate today](#which-hosted-apis-can-insert-into-a-plate-today)
- [Where the inference runs](#where-the-inference-runs)
  * [One question partitions the market](#one-question-partitions-the-market)
  * [Which image APIs expose structural control](#which-image-apis-expose-structural-control)
  * [The FLUX licence constraint](#the-flux-licence-constraint)
  * [Hosted ComfyUI runners](#hosted-comfyui-runners)
    + [Cold start is the largest unmodelled term, and one published figure is a trap](#cold-start-is-the-largest-unmodelled-term-and-one-published-figure-is-a-trap)
  * [OpenRouter's actual boundary](#openrouters-actual-boundary)
  * [Self-hosting, in the numbers that are actually published](#self-hosting-in-the-numbers-that-are-actually-published)
  * [What a project actually costs](#what-a-project-actually-costs)
  * [Recommendation, and the strongest case against it](#recommendation-and-the-strongest-case-against-it)
  * [What could not be verified here](#what-could-not-be-verified-here)
- [Three architectures](#three-architectures)
  * [Architecture A — enum plus text, with a geometric check](#architecture-a--enum-plus-text-with-a-geometric-check)
  * [Architecture B — 2D instance layout with masks](#architecture-b--2d-instance-layout-with-masks)
  * [Architecture C — 3D proxy, depth conditioning, solved camera](#architecture-c--3d-proxy-depth-conditioning-solved-camera)
  * [Choosing between them](#choosing-between-them)
- [What this means for this repository](#what-this-means-for-this-repository)
  * [The loop already exists](#the-loop-already-exists)
  * [The `framing` enum should stay, and there is a repo-specific reason](#the-framing-enum-should-stay-and-there-is-a-repo-specific-reason)
  * [Four changes, in order of value](#four-changes-in-order-of-value)
  * [Inserting the cast into a rendered plate: not yet, and the seam is already there](#inserting-the-cast-into-a-rendered-plate-not-yet-and-the-seam-is-already-there)
- [What remains unverified](#what-remains-unverified)

<!-- tocstop -->

## How to read this

The survey is organised as a pipeline, because every system reviewed decomposes the same way even
when its authors do not say so:

```
prompt → scene layout → camera/framing → conditioning signal → image model → validation → accept
```

Sections 2 through 6 take one stage each and report what exists. Section 7 covers where the
inference runs. Section 8 gives three concrete architectures at different cost and effort levels.
Section 9 is specific to this repository.

**One finding dominates everything else and is stated here so it is not buried.** The validation
stage is essentially unbuilt. Every published closed-loop image system verifies object presence,
object count, attribute binding, or pairwise spatial relations. **None of them verifies shot scale,
crop, headroom, subject-to-frame ratio, or camera height** — the properties that make a shot a shot.
Section 6 gives the evidence. Section 8's recommended architecture is built around filling that gap,
and Section 9 argues this repository is unusually close to being able to.

A second, smaller finding worth flagging early: **the intuitive case for 3D proxy geometry is almost
entirely unmeasured**, and the one head-to-head benchmark that exists shows a 3D-box method scoring
roughly half of a 2D-layout baseline. Section 5 gives the numbers. This does not mean 3D is wrong; it
means nobody has demonstrated it is right, and a survey that presents it as settled would be lying.

### A note on sourcing

Research for this document ran into an exhausted web-search budget and two API quota outages, so
discovery was weaker than verification. A deliberate consequence: **agents were instructed to fetch
rather than recall**, after a probe found that two of four guessed arXiv identifiers pointed at
entirely different papers. Several widely-repeated attributions turned out to be wrong and are
corrected inline. Where a fact could not be verified it is marked **⚠️ unverified** rather than
smoothed over, and the closing section lists what remains open.

---

## The stages, and what actually varies between systems

The example architecture that prompted this survey — prompt, then a rough 3D layout populated with
maquettes, then camera angles, then constrained generation and validation — is one point in a space.
Mapping the space first makes the alternatives legible.

| Stage | What varies between systems | Cheapest option | Most capable option |
| --- | --- | --- | --- |
| Layout | Whether an LLM emits coordinates, emits relations for a solver, or writes code | LLM emits 2D boxes directly | LLM emits relations, a MILP or physics solver places them |
| Geometry | Bounding boxes, convex hulls, or signed distance fields | Boxes | SDFs |
| Camera | Free text, a small enum, or a solved 6-DOF pose | An enum of shot scales | Toric-space closed-form solve |
| Conditioning | Text only, 2D layout injection, or a rendered control map | Text | Depth or pose ControlNet on a rendered proxy |
| Identity | Prompt repetition, reference image, or a trained adapter | Reference image | Per-character LoRA |
| Validation | None, VLM opinion, or geometric measurement | None | Detector measures, LLM reasons, loop until fixpoint |

**The single most useful structural observation in the whole survey**, because it recurs at three
different stages: the systems that work well separate *measurement* from *judgement*. A detector
measures geometry; a language model reasons about whether the measurement satisfies the intent. The
systems that collapse the two — asking a vision-language model both to perceive and to decide —
inherit the VLM's perceptual weaknesses as decision errors. Section 6 develops this.

---

## Generating a scene layout

### The three families

Layout generation from a text prompt splits cleanly by **what the language model is asked to emit**.

**The model emits absolute coordinates.** Simplest, and the most common in practice. The LLM is asked
for a JSON list of objects with positions and sizes. It works acceptably for a handful of objects and
degrades as count and constraint density rise, because nothing checks the arithmetic.

**The model emits relations, and an external solver places them.** The LLM produces constraints — *on
top of*, *facing*, *against the north wall*, *not intersecting* — and a solver finds coordinates
satisfying them. This is the architecture of **Holodeck**
([arXiv:2312.09067](https://arxiv.org/abs/2312.09067)), which uses depth-first search with a mixed
integer linear program, solved with GUROBI, over spatial relational constraints an LLM produced.
Related work under the **Architect** ([arXiv:2411.09823](https://arxiv.org/abs/2411.09823)) and
**Open-Universe** (Aguina-Kang et al.) names occupies the same family.

**The model writes code.** The LLM emits a program — typically a Blender script — that constructs the
scene. **SceneCraft** ([arXiv:2403.01248](https://arxiv.org/abs/2403.01248)) is the canonical example.
Debuggable and inspectable, but failure modes are program failures rather than layout failures.

> **Three name corrections**, each of which would have produced a wrong citation.
> "ArchitectLLM" does not exist; the real system is **Architect** (2411.09823). **Open-Universe** is
> Aguina-Kang et al., not Sun et al. And **"SceneCraft" names three distinct papers** — check which
> one a citation means. Two guessed identifiers that seemed right were wrong outright: 2312.01663 is
> CustomNeRF, not SceneCraft, and 2401.06345 is "Seek for Incantations", not Holodeck.

### The geometric primitive determines the quality ceiling

Across systems the representation of an object's extent predicts how good the layouts get, roughly
independently of the solver:

- **Axis-aligned bounding boxes** — trivial to reason about, and objects visibly float or interpenetrate
  because a box is a poor model of a chair.
- **Planar convex hulls** — much better contact behaviour for the cost of a harder overlap test.
- **Signed distance fields** — support physics-style optimisation and genuine contact, at real
  computational cost.

**For a shot-framing system specifically, boxes are probably sufficient**, and this is worth stating
because it is a place to not spend effort. The layout is not the deliverable; it is a control signal
handed to an image model that will reinterpret it anyway. Precise contact geometry buys little when
the downstream conditioning is a depth map at 1024 pixels.

### Learned scene synthesis is a separate lineage and mostly not what you want

**ATISS**, **SceneFormer**, **DiffuScene**, **LEGO-Net** and **InstructScene** learn furniture-layout
distributions from datasets of annotated interiors. They produce plausible rooms and are the right
tool for populating an environment. They are the wrong tool for staging *characters for a shot*,
because their training distributions are furniture arrangements, they have no notion of a camera, and
their notion of "plausible" is statistical rather than dramatic. **The relevant lesson from this
lineage is negative:** a system trained on how rooms are usually arranged will fight an author trying
to stage an unusual moment.

### Solvers, if a solver is wanted

Ordered by implementation cost: backtracking search over a topological sort of the constraint graph;
gradient descent on a differentiable penalty; simulated annealing; MILP; SDF-based physics
optimisation. **Backtracking over a topological sort is the recommendation** for a first build — it is
a few hundred lines, it explains its own failures (which constraint could not be satisfied), and it
degrades into a partial layout rather than a solver error. A MILP dependency like GUROBI is a
licensing and deployment problem disproportionate to the benefit at this scale.

---

## Choosing the camera and the framing

This is the stage the survey's prompting example treats as "generate camera angles from prompts", and
it is where the classical literature is strongest and most underused.

### The classical foundations still hold

**The Virtual Cinematographer** (He, Cohen, Salesin; SIGGRAPH 1996,
[doi:10.1145/237170.237259](https://doi.org/10.1145/237170.237259)) encodes film idioms as
hierarchical finite state machines. A scene type — a two-person conversation, an arrival — selects an
idiom, and the idiom emits a short ordered sequence of predefined camera setups. **It is a lookup
table, not an optimiser, and thirty years later the systems that work still look like this.**

**Toric space** (Lino and Christie; SCA 2012,
[doi:10.2312/SCA/SCA12/065-070](https://doi.org/10.2312/SCA/SCA12/065-070), and ACM TOG 34(4), 2015,
[doi:10.1145/2766965](https://doi.org/10.1145/2766965)) is the single most reusable classical result.
It solves the **exact on-screen positioning of two or three subjects**, expressing the solution space
for each pair as a **2D manifold surface**, which "recasts the complex **6D** optimization problem
tackled by most contributions in the field in a simple **2D** optimization on the manifold surface."
A 2020 follow-on ([doi:10.1111/cgf.13949](https://doi.org/10.1111/cgf.13949)) adds GPU occlusion
anticipation. **If a system ever needs to place a camera such that two named characters land at two
named screen positions, this is the closed-form answer.**

**The parameterisation is three angles, (α, θ, φ).** α is the angle the two targets subtend at the
camera, and it is *computed from* the desired screen positions rather than searched over — choosing α
chooses which surface you are on. θ is the horizontal angle around the target pair (0 and ±1 give the
over-the-shoulder views from behind each target) and φ the vertical (0 at target height, +1 above, −1
below). The construction is the inscribed-angle theorem revolved: the locus of points in a plane
seeing a segment at constant angle is a circular arc, and sweeping that arc about the axis through
both targets gives a **spindle torus** on which every point reproduces the same two-subject framing.

**The two-subject case is genuinely algebraic, and that is what makes it worth implementing.** Four
independent citing papers describe it as an "algebraic computation", "fast algebraic techniques", an
"algebraic implementation", and analytic interpolation. The precise claim, stated carefully: the
screen-position constraint is **satisfied by construction** — every point on the correct torus frames
both subjects exactly, so there is no residual to minimise for framing — and what remains is a search
over the two free parameters for everything *else* (vantage angle, subject size, visibility), which
the 2015 paper does with "an efficient interval-based search technique". Not a numerical search for
the framing, and not a single closed-form pose either.

**Three subjects is where it stops being cheap.** The authors describe the three-target case as exact,
but three screen positions is the P3P problem and is generically **over-constrained**; a later paper
by Jiang et al. notes that practitioners "trivially address" it by framing the leftmost and rightmost
characters and letting the middle fall where it may. **Treat the two-subject case as the one to
build.**

What the 2015 TOG paper adds over the 2012 SCA paper: interval-based search over the surface,
**screen-space manipulators** for real-time direct control, and **viewpoint interpolation** that keeps
visual properties continuous along a path (the long-take capability). Camera roll is left free in 2012
and constrained in 2015. The 2020 follow-on is Burg, Lino and Christie, "Real-time Anticipation of
Occlusions for Automated Camera Control in Toric Space" (*Computer Graphics Forum*), which projects
occluder information into Toric space to build an **anticipation map** predicting occlusions over a
user-defined time window, then moves the camera to minimise them.

⚠️ **Two things remain unread.** Every route to the primary PDFs failed — HAL serves an Anubis
challenge, the ACM and Eurographics libraries return 403, and the authors' pages no longer host them —
so the actual equations, the interval-search algorithm and all runtime figures are unverified, and the
account above is reconstructed from verbatim quotation in fetchable papers by the same authors and
their implementers. And citing papers **disagree on the dimensionality reduction**: some say 6-DOF to
a 2D search, others say 7-DOF to 4-DOF. Both readings follow from the same construction depending on
what you count, so **do not quote a single DOF figure without the paper in hand.** Do not attribute
visual servoing to this line of work either; nothing fetched supports it.

**The Prose Storyboard Language** (Ronfard, Gandhi, Boiron, Murukutla;
[arXiv:1508.07593](https://arxiv.org/abs/1508.07593), and WICED 2022) is a formal language "for
describing movies shot by shot, where each shot is described with a unique sentence," using "a simple
syntax and **limited vocabulary** borrowed from working practices in traditional movie-making,"
readable by machines and humans, and "designed to serve as a high-level user interface for intelligent
cinematography and editing systems." That is a specification for the authoring surface a shot-framing
system should expose. Cite the four-author v5; v1 had three authors.

> **Two corrections, the second of which an earlier draft of this survey got wrong itself.**
>
> DCCL is "Declarative Camera Control for Automatic Cinematography", **Christianson, Anderson, He,
> Salesin, Weld and Cohen — six authors — AAAI 1996**
> ([AAAI library](http://www.aaai.org/Library/AAAI/1996/aaai96-022.php)), encoding 16 idioms from a
> film textbook. It is not Bares and Lester.
>
> **But "Bares and Lester, ACM Multimedia 2000" does not exist**, and an earlier draft cited it. The
> ACM MM 2000 paper "Virtual 3D camera composition from frame constraints" is **Bares, McDermott,
> Boudreaux and Thainimit** — **Lester is not an author** (dblp `conf/mm/BaresMBT00`). Bares and
> Lester do have a joint corpus of nine records, none of them at ACM Multimedia and none in 2000. For
> constraint-based camera control the intended citation is almost certainly **Bares, Grégoire and
> Lester, "Realtime Constraint-Based Cinematography for Complex Interactive 3D Worlds", IAAI 1998**.
> Cite one or the other; the fused version is a phantom.

### The evidence says use a small discrete vocabulary

This is the clearest one-sided finding in the survey. Nearly every camp independently converges on a
small closed set of shot descriptors rather than continuous camera parameters (MovieAgent is the one
exception, and Section 3's account of it explains why that does not weaken the pattern):

- **FilmAgent** ([arXiv:2501.12909](https://arxiv.org/abs/2501.12909)) gives its LLM **9 shot types**
  — three static (close-up, medium, long) and six dynamic — over **165 static and 107 dynamic
  pre-placed camera setups** across 15 locations, plus **32 standing and 33 sitting** enumerated actor
  positions. The language model never authors a camera numerically; it selects from a menu.
- **The Prose Storyboard Language** is explicitly a limited vocabulary.
- **CCD** ([arXiv:2402.16143](https://arxiv.org/abs/2402.16143)) conditions on text naming shot size,
  angle and framing.
- **CamChoreo/CamDistill** ([arXiv:2608.10932](https://arxiv.org/abs/2608.10932)), a 2026 camera
  *understanding* benchmark, settles on **20 discrete direction-aware labels**.

And decisively for anyone who wants to check their output: **classifiers exist for the discrete
vocabulary and do not exist for continuous camera parameters.** See the next subsection.

### Shot scale and camera angle can be measured automatically

This is the most immediately actionable material in the survey, because it turns "the framing looks
wrong" into a number.

| Property | Classes | Live-action | **Animation** | Source |
| --- | --- | --- | --- | --- |
| Shot scale | **3** — close, medium, long | **~94% accuracy** | **F1 ≈ 0.80** | ICIP 2018, [doi:10.1109/ICIP.2018.8451474](https://doi.org/10.1109/ICIP.2018.8451474) / ICIAP-W 2022, [doi:10.1007/978-3-031-13321-3_17](https://doi.org/10.1007/978-3-031-13321-3_17) |
| Camera angle | **5** — overhead, high, neutral, low, dutch | **>95% weighted P/R** | **F1 = 0.61** | IMX-W 2023, [doi:10.1145/3604321.3604334](https://doi.org/10.1145/3604321.3604334) / ICIAP-W 2022 |
| Camera level | **6** — aerial, eye, shoulder, hip, knee, ground | **>95% weighted P/R** | **F1 = 0.68** | as above |

The live-action shot-scale model was trained and tested on the full filmographies of six directors —
Scorsese, Godard, Tarr, Fellini, Antonioni, Bergman — **120 films analysed second by second**. The
angle and level models used **over 24,000 images** and work "even when frames do not prominently
feature the human figure." Models, annotation tooling and frame data are offered through the group's
project page at [cinescale.github.io](https://cinescale.github.io/).

### The domain gap is real, and it is uneven

The animation column above is the answer to the question this survey most needed answered, and it does
not transfer the way one would hope. **Gualandris, Savardi, Signoroni and Benini**, "Automatic Indexing
of Virtual Camera Features from Japanese Anime" (ICIAP 2022 Workshops, FAPER; LNCS 13373, 186–197),
applied the same three taxonomies to a corpus of **over 17,000 annotated frames** from Japanese
animated films of **1982–2021** — Miyazaki, Anno, Oshii — split **12 films for training, 3 for test**.
Their own framing of the problem:

> "Since animation techniques exploit drawings or computer graphics objects for making films instead of
> camera shooting, the automatic understanding of such 'virtual camera' features appears harder if
> compared to live-action movies."

And their result: **shot scale reaches "about 80%", which they call "comparable with state-of-the-art
methods applied on live-action movies", while camera angle and camera level reach F1 of 61% and 68%.**

**Read that as two different verdicts, because it is.** Shot scale mostly survives the jump to
stylised 2D. **Camera angle and camera level collapse — a drop of roughly 27 to 34 points** — and the
authors attribute it directly to the absence of a physical camera. For a system that wants to verify
framing on generated illustration, **shot scale is measurable and camera geometry is not.**

Three qualifications, none of which rescue the angle and level numbers:

- **This is not a transfer result.** The method **fine-tunes ImageNet-pretrained CNNs on anime**; it
  does not take the live-action model and run it on animation. ⚠️ No zero-shot cross-domain number
  appears in the abstract or on the project page, and the full text is paywalled (Unpaywall reports
  `oa_status: closed`, no OA locations), so a cross-domain table could exist inside it unseen.
- **The comparison is generous.** "About 80%" F1 against "around 94%" accuracy is not an
  apples-to-apples metric, and the animation test set is three films.
- **Even the good number is a flag, not a gate.** 94% on three classes means roughly one verdict in
  seventeen is wrong; 0.80 F1 means closer to one in five. A classifier belongs in a pipeline as a
  trigger for human review, never as an automatic reject.

> **Attribution correction:** the anime paper's author set is **Gualandris**, Savardi, Signoroni,
> Benini. **Kovács is not an author of it** — he is on the IMX-W 2023 angle-and-level paper. An earlier
> draft of this survey assumed the same author set across all three.

⚠️ A methodological warning worth carrying beyond this section. Two separate fetches of the same
project page returned **contradictory F1 figures**, and neither matched the paper's own abstract; the
numbers above come from the University of Brescia repository's raw OAI-PMH record, which serves the
abstract as machine-readable XML rather than through a summarisation layer. **Numeric tables read off
rendered HTML through any summarising intermediary should be re-checked against a primary record
before being relied on.**

**MovieNet** ([movienet.github.io](https://movienet.github.io/), ECCV 2020) annotates shot scale in
**five** classes — extreme close-up, close-up, medium, **full**, long — and shot movement in four. Note
it is *full shot*, not "extreme long", and **MovieNet does not annotate camera angle at all.**

> **Name corrections in this area.** **CineScale is a project and dataset, not a paper** — cite the
> underlying ICIP 2018 and IMX 2023 papers. **"AVE" could not be located** as any cinematography
> dataset and may be a misremembering; nothing was substituted for it. **DirectorLLM**
> ([arXiv:2412.14484](https://arxiv.org/abs/2412.14484)) orchestrates **human poses**, not cameras,
> and does not belong in a shot-listing citation list.

The gap described here is a gap in *measurement* — the classifiers work on stylised 2D or they do not,
and it can be checked either way. For compositing a character into an existing background the same gap
appears in the methods and the training data instead, and there it is total rather than uneven:
[The domain gap again, in methods and data this time](#the-domain-gap-again-in-methods-and-data-this-time).

### Learned camera control is mostly aimed at video

**CameraCtrl** ([2404.02101](https://arxiv.org/abs/2404.02101)), **MotionCtrl**
([2312.03641](https://arxiv.org/abs/2312.03641), SIGGRAPH 2024), **CameraCtrl II**
([2503.10592](https://arxiv.org/abs/2503.10592)) and **CameraAnything**
([2607.24591](https://arxiv.org/abs/2607.24591)) all condition **video** diffusion on camera pose
sequences. For a still-image pipeline they are the wrong tool — their machinery buys temporal
consistency, which a still does not need and would pay for anyway.

Two exceptions are worth knowing. **Director3D**
([2406.17601](https://arxiv.org/abs/2406.17601)) generates **still cameras in a 3D scene** from text
alone, and its three-role split — Cinematographer, then Decorator, then Detailer — is the right
pipeline shape: choose the viewpoint first, render second. **CineMaster**
([2502.08639](https://arxiv.org/abs/2502.08639)) has users place **3D bounding boxes**, renders **depth
maps plus object class labels**, and conditions on those. Its output is video, but **its authoring
model is exactly the one a shot-framing system wants** and transfers directly to stills.

One transferable idea from the video camp: MotionCtrl keeps **camera** a separate, appearance-free
axis from **subject description**. Any prompt schema should do the same.

**The camera representations, read from the bodies.** An earlier draft of this survey warned against
attributing Plücker embeddings to CameraCtrl on the strength of its abstract. That warning was wrong,
and reading §3.2 reverses it: _"We thus choose Plücker embeddings (Sitzmann et al. 2021) as the
camera pose representation."_ The pattern that matters for a still-image system is that **the field is
split**, and the split is not subtle.

| System         | Camera representation                                     |
| -------------- | --------------------------------------------------------- |
| CameraCtrl     | Plücker embeddings, per-pixel ray                          |
| CameraCtrl II  | Plücker, injected at the initial patchify layer only       |
| CameraAnything | Plücker plus 3D RoPE                                       |
| MotionCtrl     | Raw extrinsics, ℝ^{L×12}                                   |
| CineMaster     | Raw extrinsics, ℝ^{F×12}                                   |
| Director3D     | Interpretable `{r, t, f, p}` — position, target, focal, up |
| CCD            | 5-DoF character-centric vector, ℝ⁵                         |

Plücker is the choice for models that condition **densely and per-pixel**, because a ray map is
already image-shaped. Raw extrinsics are the choice for models that condition **per-frame**. Neither
is what a still-image framing system wants, and the two bottom rows are why: Director3D's
`{r, t, f, p}` is the tuple a human would type, and CCD's five character-centric degrees of freedom
are Toric-flavoured — **though the CCD paper does not use the word Toric**, so do not cite it as an
implementation of Lino and Christie.

> ⚠️ **Almost none of these abstracts name an evaluation metric** — CCD, CameraCtrl, CameraCtrl II,
> MotionCtrl, Director3D, CineMaster and CameraAnything all say "extensive experiments" without
> naming one. Any FID, FVD or pose-error figure attributed to them should be treated as unsourced
> until someone reads the body.

### The LLM film agents are weakly evidenced

**FilmAgent**'s entire evaluation is **15 ideas, 4 aspects, human raters, mean 3.98 out of 5**, and its
architectural claims rest on that. Its cinematographer agents apply "shot usage guidelines" through a
debate-and-judge stage with **no geometric validation of any kind** — no collision check, no
visibility check, no camera-to-actor geometry. **MovieAgent**
([2503.07314](https://arxiv.org/abs/2503.07314)) claims state of the art on script faithfulness,
character consistency and narrative coherence without defining a metric in its abstract. ⚠️ **3.98 is
not a plain mean of four five-point scores** — one of the four columns (Action, 0.88) is
accuracy-style, so the headline number mixes scales and should not be quoted as "3.98/5 across four
aspects."

**MovieAgent's camera settings are neither discrete nor continuous: they are free-form natural
language** in the agent prompts. That places the two film agents at opposite ends of one axis —
FilmAgent selects from an enumerated menu of nine shot types over pre-placed setups, MovieAgent writes
whatever sentence it likes. It is the one published exception to the convergence described above, and
it is not evidence against it, because MovieAgent measures nothing about the cameras it describes.

The honest summary: **these systems demonstrate that a multi-agent LLM can select shots from a menu
and produce watchable output. They do not demonstrate that the multi-agent structure is what made it
work**, and they measure nothing geometric.

---

## Conditioning the image model

Once a layout and a camera exist, something must make the image model obey them.

### ControlNet, and why it does not transfer to modern models

**ControlNet** copies the diffusion UNet's encoder and connects it back through zero-initialised
convolutions, so an untrained adapter starts as a no-op and learns a structural signal without
destabilising the base model. For SD1.5 and SDXL this is mature, well-tooled, and the default answer.

**It transfers badly to diffusion transformers and flow models**, for four reasons that are worth
understanding before budgeting a port:

1. **No encoder/decoder split and no skip connections.** ControlNet's design copies "the encoder" and
   injects into "the decoder". A DiT is a uniform stack; neither half exists.
2. **No resolution hierarchy.** Every block runs full-sequence attention at one token grid, so a copied
   block costs its full share of compute. In a UNet, the copied encoder blocks are the cheap
   high-resolution ones. **The discount that made ControlNet affordable does not exist.**
3. **Residual-count mismatch.** The number of control residuals produced does not naturally match the
   number of injection points, which is why diffusers carries a `controlnet_blocks_repeat` flag and why
   [diffusers issue #9635](https://github.com/huggingface/diffusers/issues/9635) exists.
4. **Guidance distillation removes the unconditional branch.** Several current models have no
   classifier-free-guidance negative pass for a control signal to differentially affect.

**PixArt-δ's ControlNet-Transformer** is the origin of every DiT ControlNet: stipulate the first N
blocks as "the encoder" by fiat, and use zero-**linear** layers instead of zero-**convolutions**.
Everything since inherits that trick.

Verified block counts, for anyone sizing a port: FLUX has **19 double-stream and 38 single-stream**
blocks; the SD3.5 ControlNet covers **19 of 38**; Shakker's Union-Pro-2.0 uses **6 double and 0
single**; InstantX's Qwen union uses **5**.

### What replaced ControlNet on DiT models

Four distinct mechanisms, and conflating them causes real integration bugs:

| Mechanism | How it works | Example | Note |
| --- | --- | --- | --- |
| **Channel-wise concatenation** | Control image is VAE-encoded and concatenated to the latent's channels | **FLUX.1 Depth/Canny [dev]** | **These are not ControlNets.** Verified in diffusers: there is no `ControlNetModel` in the path. Treating them as ControlNets is a common and wasteful mistake |
| **Sequence concatenation with a RoPE position offset** | Reference tokens appended to the sequence, offset in position space so they do not collide | **FLUX.1 Kontext**, OminiControl, Qwen-Image-Edit-2509 | The dominant modern approach |
| **Attention masking** | Regions controlled by masking attention, **zero new parameters** | **EliGen** | Cheapest possible |
| **LoRA on existing blocks** | No new modules at all | **OminiControl**, at **0.1%** added parameters | Ablation: F1 **0.38 vs 0.23** |

The second row is also the mechanism behind handing a model a finished background and a character
reference and asking it to combine them. That is a different task from control, it is measured
separately and much worse, and it has its own section:
[Inserting a character into an existing plate](#inserting-a-character-into-an-existing-plate).

### Control strength has three orthogonal axes

Systems routinely tune one and blame the model. The three are:

- **Magnitude** — `controlnet_conditioning_scale`.
- **Network depth** — how deep the control signal is injected. The familiar `0.825**(12-i)` decay
  schedule is **in lllyasviel's reference implementation and A1111, not in diffusers.**
- **Denoising time** — `control_guidance_start` and `control_guidance_end`. **This is the axis that
  matters most for framing**: applying structural control only over the early denoising steps fixes
  composition while leaving the model free to render detail, which is exactly the trade a shot-framing
  system wants.

> ControlNet++'s often-quoted "+11.1% mIoU" is an **absolute** point difference, not a relative one.

### The 3D proxy versus 2D layout question, and why it is not settled

This is the decision the survey's prompting example takes for granted, and the evidence is thinner
than expected.

**Systems that condition on 3D proxy geometry:**

| System | 3D input | Mechanism | Camera control | Still/video |
| --- | --- | --- | --- | --- |
| **Generative Rendering** ([2312.01409](https://arxiv.org/abs/2312.01409)) | Animated low-fidelity **rendered mesh** → UV + depth | Depth ControlNet, UV-space noise init, shared attention | **Yes, continuous** | Video |
| **Build-A-Scene** ([2408.14819](https://arxiv.org/abs/2408.14819)) | **3D boxes rasterised to depth** | Depth-conditioned T2I + Dynamic Self-Attention | No | Still |
| **LooseControl** ([2312.03079](https://arxiv.org/abs/2312.03079)) | **3D boxes + scene boundary** | **LoRA on ControlNet-depth**, rank 8, 200 steps, batch 12, base UNet frozen | No | Still |
| **Neural Assets** ([2406.09292](https://arxiv.org/abs/2406.09292)) | 3D boxes + appearance features | Per-object tokens **replacing text tokens** in cross-attention | No | Still |
| **Diffusion Handles** ([2312.02190](https://arxiv.org/abs/2312.02190)) | Monocular-depth proxy surface | Activations lifted to 3D, transformed, reprojected. **No fine-tuning** | No | Still |

**Now the benchmark that complicates the picture.** Build-A-Scene's own table is the one directly
measured 3D-versus-2D comparison found. Object accuracy is YOLOv8 detection of the specified objects;
mIoU is placement accuracy:

| Method | Layout control | Object accuracy | mIoU | CLIP_T2I |
| --- | --- | --- | --- | --- |
| Build-A-Scene | 3D boxes, interactive | **55.3%** | **0.772** | 0.321 |
| Layout-Guidance | **2D layout** | 48.2% | 0.425 | **0.323** |
| LooseControl | 3D boxes, non-interactive | **24.3%** | 0.633 | 0.302 |

Read carefully, this does not say what the framing predicts:

1. **3D box conditioning on its own is markedly worse than 2D layout control** — 24.3% against 48.2%,
   roughly half. Going 3D is not free accuracy.
2. **The 3D win is modest and conditional** — about seven points, and only with Build-A-Scene's extra
   interactive machinery on top. **The dimensionality of the layout is not what bought the accuracy;
   the machinery around it was.**
3. **Whatever the 3D proxy bought, it was not prompt adherence.** Build-A-Scene's CLIP_T2I (0.321) is
   fractionally _below_ 2D Layout-Guidance's (0.323). The gain is in placement, and only in placement.
4. **The two baselines do not rank consistently across the two placement metrics.** Layout-Guidance
   beats LooseControl on object accuracy (48.2% against 24.3%) and loses to it on mIoU (0.425 against
   0.633). A table whose baselines swap places depending on the metric is not measuring one underlying
   quantity called "placement accuracy."
4. Build-A-Scene positions its own contribution as **editability**, not placement accuracy.

⚠️ These are the authors' own numbers against baselines they chose, and the shared-authorship problem
is worse than one name: **Peter Wonka co-authors Build-A-Scene, the LooseControl baseline that scores
24.3%, _and_ ZoeDepth**, the monocular-depth foundation the whole line rests on; **Niloy Mitra
co-authors LooseControl and Diffusion Handles.** Treat the margin as weaker than it looks.

The 2D baseline is **"Training-Free Layout Control with Cross-Attention Guidance"** (Chen, Laina,
Vedaldi, [2304.03373](https://arxiv.org/abs/2304.03373), WACV 2024) — a training-free method, which
makes the comparison less favourable to the 3D route than the table's framing implies.

**An independent comparison does exist, and it points the same way.** **SeeThrough3D**
([2602.23359](https://arxiv.org/abs/2602.23359), CVPR 2026, IISc Bengaluru / IIIT Hyderabad — **no
author overlap with Wonka, Mitra, Eldesokey or Bhat**) benchmarks both 3D-proxy methods against
image-space occlusion-control methods on one protocol:

| Baseline | Depth ordering ↑ | Object score ↑ | Angular error ↓ | Text alignment ↑ | KID ×10⁻³ ↓ |
| --- | --- | --- | --- | --- | --- |
| VODiff (image-space) | 0.68 | 19.7 | 92.73 | 29.51 | 15.40 |
| **LooseControl** (3D) | 0.82 | 20.02 | 89.88 | 28.43 | 14.32 |
| **Build-A-Scene** (3D) | 0.89 | 21.0 | 91.62 | 28.05 | 20.12 |
| LaRender (image-space) | **1.02** | 21.83 | 89.63 | **30.20** | **13.46** |
| SeeThrough3D | 1.46 | 22.86 | 47.92 | 31.87 | 5.43 |

**LaRender — a training-free, image-space latent-rendering method (Zhan & Liu, ICCV 2025) — beats both
3D-proxy systems on depth ordering, text alignment and KID.** Depth ordering is the metric a 3D proxy
is supposed to own outright. Only the paper's own method wins, and SeeThrough3D is itself
3D-proxy-conditioned, so it is independent of the parties it benchmarks without being disinterested
about the conclusion.

**Two independent tables now say the same thing: the dimensionality of the proxy is not what buys
accuracy.**

**The 2D layout alternative, for comparison:**

| System | Conditions on | Training | Measured accuracy |
| --- | --- | --- | --- |
| **InstanceDiffusion** ([2402.03290](https://arxiv.org/abs/2402.03290)) | **Points, scribbles, boxes, or masks** + per-instance text | Trained | **+20.4% AP₅₀ on boxes, +25.4% IoU on masks** |
| **ReCo** ([2211.15518](https://arxiv.org/abs/2211.15518)) | Position tokens + regional text | Fine-tune | FID 8.82→7.36, SceneFID 15.54→6.51, **+20.40%** region classification |
| **GLIGEN** ([2301.07093](https://arxiv.org/abs/2301.07093)) | Boxes + phrases | **Base weights frozen**, new gated layers | Zero-shot beats supervised baselines |
| **BoxDiff** ([2307.10816](https://arxiv.org/abs/2307.10816)) | Boxes, via denoising-step constraints | **Training-free** | — |
| **MultiDiffusion** ([2302.08113](https://arxiv.org/abs/2302.08113)) | Masks, boxes, aspect ratio | **Training-free** | — |
| **MIGC** ([2402.05408](https://arxiv.org/abs/2402.05408)) | Coordinates + per-instance text | Trained | Introduces COCO-MIG |

**InstanceDiffusion is the best-evidenced of the six** and has the widest authoring surface. Note that
**none of the 2D methods provides occlusion ordering** — that is the one structural thing a 3D proxy
genuinely buys, and InstanceDiffusion's masks let an author draw the occlusion silhouette by hand
instead.

### Known failure modes of proxy conditioning

**Proxy geometry leaks into the output, and it costs prompt adherence.** LooseControl's own text is
the best evidence, and it is close to a literal statement of the concern:

> "providing approximate depth using target bounding boxes for furniture does not yield the desired
> result, because **only boxy objects are generated**."

> "ControlNet with ordinary control produces **'boxy' generations** which are not only unrealistic but
> also result in **lesser prompt adherence**."

The second sentence is the more actionable one. **Proxy leakage is not only an aesthetic problem; it
degrades the model's willingness to follow the text.** The whole paper exists to retrain ControlNet
around this. No published work puts a number on "how CG does the output look."

**Depth-map tonality imposing a lighting scheme has no published support at all.** This was
specifically searched for and **nothing was found** — not a measurement, not a discussion.
**DiLightNet** ([2402.11929](https://arxiv.org/abs/2402.11929), SIGGRAPH 2024) observes that diffusion
models "tend to correlate image content and lighting" and injects radiance hints to break that, but
that is content-to-lighting entanglement generally, **not depth-condition-to-lighting entanglement**,
and it should not be cited as though it measured this. Treat the concern as an untested hypothesis —
it is cheap to ablate directly.

Two later probes confirm the negative rather than closing it. The polarity convention is common
knowledge in the tooling — Blender's near-black convention is the inverse of ControlNet's, and
`sd-webui-controlnet` ships an `invert` preprocessor for exactly that reason — with no discussion
anywhere of a lighting consequence. And the nearest measurement points the other way: **PPS-Ctrl**
([2504.17067](https://arxiv.org/abs/2504.17067)) replaces depth with a per-pixel shading map because
"PPS captures surface lighting effects, providing a stronger structural constraint than depth maps",
and its ablation (RMSE 3.740 against depth's 4.099) is evidence that depth conditioning **fails to
supply** shading, not that it **imposes** a scheme. **The ablation is still unrun**: invert the depth
map, hold prompt and seed, measure output luminance and estimated light direction.

**Structure and appearance are entangled by default.** Three papers in a line each treat their
separation as something requiring deliberate machinery — **Plug-and-Play Diffusion Features**
([2211.12572](https://arxiv.org/abs/2211.12572)), **FreeControl**
([2312.07536](https://arxiv.org/abs/2312.07536)), and **Ctrl-X**
([2406.07540](https://arxiv.org/abs/2406.07540)) — which is itself the evidence. Ctrl-X advertises
"arbitrary condition images of **any modality**", which is precisely the property a coarse proxy
needs, and it is training-free.

**Normalised depth loses absolute scale.** **ZoeDepth**
([2302.12288](https://arxiv.org/abs/2302.12288)) states the field's split directly: work either
"focuses on generalization performance **disregarding metric scale**" or targets metric depth on
specific datasets — relative estimation "deals with the large depth scale variation … by factoring out
the scale", so "the predicted depth has no metric meaning, limiting the applications."

The optical half of the concern is stated plainly inside a generative-conditioning paper. **ZeroNVS**
([2310.17994](https://arxiv.org/abs/2310.17994)): _"To a monocular camera, a small object close to the
camera and a large object at a distance appear identical, despite representing different scenes."_

⚠️ **Nobody joins the two halves.** The downstream consequence — that a close-up of a large object and
a wide shot of a small one produce identical normalised conditioning — **is not measured anywhere
found.** LooseControl and Build-A-Scene both treat depth normalisation as an implementation detail and
discuss neither metric depth nor scale ambiguity. What corroborates the concern is a silence with a
shape: **papers that need absolute scale switch to metric depth or a 3D layout proxy without saying
why they had to.** For a shot-framing system this is exactly the wrong thing to be unmeasured, since
shot scale is the deliverable. **This is the survey's most testable open claim**; anyone building on
depth conditioning should settle it early.

> **Name correction:** **"Sketch2Scene" does not exist as a proxy-to-image conditioning system.** The
> name resolves to a 2024 paper that *generates* 3D from sketches
> ([2408.04567](https://arxiv.org/abs/2408.04567)) and a 2013 ACM TOG model-retrieval paper. Also,
> **"Neural Assets" is ambiguous** — [2212.06125](https://arxiv.org/abs/2212.06125) is a different
> 2022 paper. Cite 2406.09292 for object control in image generation.

### Rendering the control signal

Whatever the proxy, something must render it to a depth or pose map.

**Blender headless** (`blender -b`) gives real render passes. The **Z pass** is raw distance and the
**Mist pass** is a normalised 0–1 falloff, which is usually what a depth ControlNet wants without
further processing. ⚠️ **IndexOB and Material Index passes are Cycles-only** — a common trip-up when
prototyping in EEVEE. Blender is GPL, which is a real licensing consideration for a bundled desktop
application and is discussed in the source material rather than hand-waved.

**three.js headless** via `WebGLRenderTarget` with a `DepthTexture`, or `MeshDepthMaterial`, is far
lighter and has no GPL entanglement. The cost is that **depth arrives non-linear** and must be
linearised — the standard two-step conversion from the packing shader, first to view-space depth then
to a normalised range.

**For a TypeScript application the three.js path is the recommendation**, because the proxy is boxes
and simple maquettes, the licensing is clean, and the whole renderer is already a dependency shape the
project understands. Blender earns its weight only when the proxy geometry becomes rich enough to need
real material and object index passes.

**A community trick worth knowing:** rather than rendering geometry and running a pose preprocessor,
the anime community renders a model *shaped like an OpenPose skeleton* and uses the render directly as
the control map. Two such models exist on Civitai ([28916](https://civitai.com/models/28916),
[108114](https://civitai.com/models/108114)); the later one still **omits hands and feet from the
rig**. The general principle — *render the control signal directly rather than rendering an image and
inferring the control signal* — is sound and applies to any proxy pipeline.

---

## Validating the result

**This is the stage where the survey's expectations and the literature diverge most sharply, and it is
the most important section.**

### Four things "self-checking" can mean

The term covers four genuinely different architectures, and systems are routinely compared across the
boundary:

1. **Prompt-space refinement** — a model rewrites the prompt and regenerates. No perception of the
   output's geometry.
2. **Detector-grounded layout correction** — an object detector measures the image, a language model
   reasons about the measurements, and a correction is applied.
3. **Tool-orchestration agents** — an agent selects among generation and editing tools.
4. **Selection and routing** — generate several, pick the best.

**The second is the only one that closes a loop on measured geometry**, and its exemplar is
**Self-correcting LLM-controlled Diffusion** ([2311.16090](https://arxiv.org/abs/2311.16090)). Its
architecture is the reusable idea in this whole section: **the detector measures, and the LLM reasons
about the measurement.** Neither does the other's job. A separate finding worth carrying is the
stopping rule — **iterate to a fixpoint** (stop when a round changes nothing) rather than running a
fixed number of rounds, which both terminates earlier and avoids the pathology of a system that keeps
"correcting" a correct image.

### What the closed-loop systems actually verify

Every published self-correcting image system was checked against one question: **does it verify
anything about framing?**

| System | What its loop verifies |
| --- | --- |
| Self-correcting LLM-controlled Diffusion ([2311.16090](https://arxiv.org/abs/2311.16090)) | numeracy, attribute binding, spatial relationships |
| Discriminative Probing and Tuning ([2403.04321](https://arxiv.org/abs/2403.04321)) | text-image alignment, relation confusion |
| RAVEL ([2412.09614](https://arxiv.org/abs/2412.09614)) | attribute accuracy, narrative coherence, semantic fidelity |
| Iterative Refinement for Compositional Generation ([2601.15286](https://arxiv.org/abs/2601.15286)) | objects, relations, attributes |
| Self-Corrected Image Generation with Explainable Latent Rewards ([2603.24965](https://arxiv.org/abs/2603.24965)) | semantic alignment, spatial relations |
| FoR-SALE ([2509.23452](https://arxiv.org/abs/2509.23452)) | spatial configuration, camera *perspective* coherence |
| Agentic Retoucher ([2601.02046](https://arxiv.org/abs/2601.02046)) | text-image consistency, limb/face/text distortion |

**Presence, count, binding, relations. Never shot scale, never subject-to-frame ratio, never headroom,
never thirds adherence.** The gap is complete and was actively searched for rather than assumed.

### The three nearest misses

**VERTIGO** ([2604.02467](https://arxiv.org/abs/2604.02467)) comes closest, and states the problem in
almost the same words this survey does: existing generative camera systems "lack this 'director in the
loop' and have no explicit supervision of whether a shot is visually desirable. This results in
in-distribution camera motion but **poor framing, off-screen characters**, and undesirable visual
aesthetics." It renders 2D previews in Unity, scores them with a cinematically fine-tuned VLM, and
post-trains the generator with DPO. It reports a genuinely geometric number: **character off-screen
rate, 38% down to nearly zero.**

**But it is not the system, on two counts.** The framing judgement is a **VLM preference score, not a
geometric measurement** — the off-screen rate is a reported evaluation metric, not the training
signal. And the correction is **offline weight optimisation**, not per-shot closed-loop correction:
nothing measures a specific generated frame and re-places that camera.

**Anchor-Conditioned Compositional Control for Landscape Image Generation**
([2606.07638](https://arxiv.org/abs/2606.07638), ICCC 2026) *does* measure composition geometry on
generated images — **horizon detection rate 0.850, rule-of-thirds alignment 0.817** — via a
four-dimensional compositional anchor vector. But it is **training-time conditioning with no
correction loop**, the measurements are evaluation metrics rather than feedback, and it is landscapes,
so there is no subject to frame.

**AutoPhoto** ([2109.09923](https://arxiv.org/abs/2109.09923)) is a real perception-to-camera-motion
loop, but its reward is a learned **aesthetics** score rather than a framing measurement, and it
captures from existing 3D scenes rather than generating.

### Vision-language models are weak at cinematography, which is the reason

**ShotBench** measures this directly: the best of **24 VLMs (GPT-4o) averages 59.3%** on cinematic
understanding, with **composition at 55.2%**. That is close enough to chance on several axes to
explain why nobody has shipped a VLM-judged framing loop that works — **the judge cannot see what it
is being asked to judge.**

**This is precisely why the detector-measures/LLM-reasons split matters.** A person detector's
bounding box divided by the frame height is a direct, reliable proxy for shot scale, computed without
any learned judgement at all. Handing that number to a language model, rather than asking a VLM
whether the framing "looks like a medium shot", replaces the unreliable step with an arithmetic one.

### The synthesis that nobody has published

Stated plainly, because it is the survey's main recommendation and it was not found in the literature:

> **Take SLD's architecture — detector measures, language model reasons, iterate to a fixpoint — and
> point it at Auteur-style geometric framing predicates instead of object-presence predicates.**

**Auteur** supplies the deterministic geometric framing metrics — rule-of-thirds adherence, shot-scale
conformity, and an out-of-frame rate of **5.45% against 36–41%** for baselines — but is **explicitly
open-loop**: it measures and reports, and never corrects. SLD supplies the loop but measures the wrong
things. **Nobody has connected them**, and the connection is not research-hard; it is a measurement
function and a few plumbing decisions.

### Judge infrastructure, if a VLM judge is used anyway

For the parts of validation that genuinely need semantic judgement rather than geometry: **TIFA**,
**Davidsonian Scene Graph**, **VIEScore**, **GenEval**, **T2I-CompBench**, and **DreamBench++**. The
Davidsonian Scene Graph is the most useful design idea — it decomposes a prompt into a dependency
graph of atomic questions so that a failed parent question invalidates its children, which stops a
judge from awarding credit for details of an object that is not present.

---

## Keeping the same character across shots

A shot-framing system for narrative work has a second problem the framing literature ignores
completely: **the character in shot 12 must be the same character as in shot 3.** This section is
included because it is the constraint most likely to sink a build that solved framing perfectly.

**None of the framing or layout systems surveyed addresses it.** Every one controls *where things
are*, not *who they are*.

### Two families, and the split that matters

| Family | Methods | Carries |
| --- | --- | --- |
| **Face-embedding** | IP-Adapter FaceID, InstantID, PuLID, InfiniteYou | **The face only** |
| **Whole-character** | Per-character LoRA/DreamBooth, FLUX Kontext, Qwen-Image-Edit, DreamO, UNO, OmniGen2 | Face, hair, outfit, accessories |

**The face-embedding methods structurally cannot hold an outfit.** They encode an identity vector from
a face crop; there is no channel through which a costume could travel. For photographic portraiture
that is the right trade. **For a visual novel, where a character's identity is substantially their hair
ornaments and their costume, it is the wrong family**, and this is the most consequential
classification in the section.

Stated limitations worth knowing: IP-Adapter "works best for square images"; IP-Adapter FaceID models
"do not achieve perfect photorealism and ID consistency" and have "limited generalization", and are
**research-licensed**; InstantID uses "only the largest face", trades text controllability against
identity strength, and is **non-commercial**. FLUX.1 Kontext is **non-commercial**. Qwen-Image-Edit is
**Apache-2.0** — the only permissive option among the strong whole-character editors, which may
dominate the technical comparison for anything shipped.

### There is no validated automated metric for whole-character consistency

This is a genuine negative result and it is well evidenced.

- **DINO** — the most-cited consistency metric — **rewards silhouette and ignores appearance detail.**
  DreamBench++ found it "tends to yield high scores to images that preserve overall shape but do not
  put much weight on color, texture, and facial features, leading to frequent contradiction with human
  preference", at **50.72% human agreement** — coin-flip.
- **ViStoryBench's CIDS** states in its own documentation that it "does not address clothing,
  costumes, or full-body consistency" and is "**inherently face-centric**".
- **ArcFace cosine similarity** is a face metric by construction.

**So a system cannot currently close a loop on character consistency the way it can on framing
geometry**, because the measurement does not exist. Framing is measurable and unmeasured; identity is
unmeasured because it is not yet measurable. Plan for human review on identity.

### What the practitioner community actually does

Worth recording because it is the only body of evidence about what holds up over hundreds of images.
The consensus stack is: **train a per-character LoRA** (30–100 curated images, roughly 1000–3500 steps,
network dim 32–64 with alpha equal to dim or half of it, an adaptive optimiser like Prodigy or
DAdapt), prompt with Danbooru vocabulary, constrain pose with ControlNet, repair faces and hands with
detector-driven inpainting, upscale, repair again. **Everything newer is added to that loop rather
than replacing it.** One guide's hard ceiling: "do not exceed 3500 total steps for a LoRA otherwise it
will overbake."

Concrete manual steps that no tool removes, each from a practitioner source: curating and rejecting
generations (one guide's rule is "can you identify your character within 5 seconds without reading the
prompt? If not, **discard the image**"); inpainting as a standing stage rather than an exception;
hand-editing auto-generated captions (the WD14 tagger's **macro-F1 is 0.4402**, which is why); and
accessory drift — "missing signature elements (absent earrings)" — as a named, recurring failure.
Where reroll rates are quantified at all, one workflow generates ~80 images and keeps 30–40, and a
video-orbit turnaround method reports "approximately **75%+**" success.

**The number to carry into a cost model is that rate.** A pipeline that assumes one generation per
shot is wrong by a factor of two to four.

**Identity across many *backgrounds* is a separate and even less measured case.** See
[Inserting a character into an existing plate](#inserting-a-character-into-an-existing-plate) below:
no method paper in the insertion literature reports how identity degrades as the number of plates
grows.

---

## Inserting a character into an existing plate

Everything above assumes a frame is generated whole. There is a second workflow, and this survey
originally omitted it: **render a location once, then insert the cast into that same picture for each
shot**, so the background is reused rather than re-derived per frame. This is the cel model — the
reason cels exist at all is that one painted background can sit under many character layers — and it
maps directly onto slots this repository already has.

**The short version: the workflow is old, the tooling is new, and the published evidence for the
generative-edit version of it is thin, almost entirely photographic, and mostly discouraging.**

### Four method families, and the conditioning generations behind them

| Family | What you hand it | Representative systems | Licence of the strongest members |
| --- | --- | --- | --- |
| **Mask-driven exemplar inpainting** | plate + mask + one reference image | AnyDoor ([2307.09481](https://arxiv.org/abs/2307.09481)), MimicBrush ([2406.07547](https://arxiv.org/abs/2406.07547)), IMPRINT ([2403.10701](https://arxiv.org/abs/2403.10701)), Insert Anything ([2504.15009](https://arxiv.org/abs/2504.15009)), IC-Custom ([2507.01926](https://arxiv.org/abs/2507.01926)), OmniPaint ([2503.08677](https://arxiv.org/abs/2503.08677)) | **Split.** AnyDoor MIT, MimicBrush Apache-2.0, MADD BSD-3; the 2025–26 leaders are all FLUX.1 [dev]-lineage and **non-commercial** |
| **Sequence concatenation** | plate and reference as two context images, no mask | FLUX.1 Kontext ([2506.15742](https://arxiv.org/abs/2506.15742)), Qwen-Image-Edit-2509/2511, OmniGen2 ([2506.18871](https://arxiv.org/abs/2506.18871)), UNO ([2504.02160](https://arxiv.org/abs/2504.02160)), DreamO ([2504.16915](https://arxiv.org/abs/2504.16915)) | Qwen-Image-Edit and OmniGen2 **Apache-2.0**; Kontext non-commercial; UNO's **weights are CC BY-NC 4.0** despite Apache-2.0 code |
| **Layered / RGBA conditioning** | a foreground layer and a background layer, composited without re-inference | LayerDiffuse ([2402.17113](https://arxiv.org/abs/2402.17113)), LASAGNA ([2601.15507](https://arxiv.org/abs/2601.15507)), LayerCraft ([2504.00010](https://arxiv.org/abs/2504.00010)) | LayerDiffuse **Apache-2.0**; LASAGNA and LayerCraft unreleased |
| **Harmonization as a later stage** | an already-composited image, corrected in passes | libcom / BCMI stack; survey [2106.14490](https://arxiv.org/abs/2106.14490) | libcom is a toolbox, per-model licences vary |

**The first family's history is three conditioning generations, and the difference between them is
measured.** Paint-by-Example ([2211.13227](https://arxiv.org/abs/2211.13227)) compresses the exemplar
to a single CLIP class token, so identity is weak by construction. AnyDoor and IMPRINT add a second
path carrying high-frequency detail alongside a DINOv2 identity embedding. The 2025–26 systems
concatenate reference tokens into a DiT's sequence and train a LoRA on a frozen backbone — IC-Custom's
is 49.26M parameters, "just 0.4% of the original FLUX model's 12B parameters". **MimicBrush's own
ablation prices the progression** on part composition (DINO-I): CLIP encoder 45.03 → DINOv2 encoder
48.34 → **full attention over reference tokens 56.48**.

**The libcom taxonomy is the one to quote for the fourth family**, because it names the stages a
composite is corrected in: **placement → blending → harmonization → shadow → reflection → quality
assessment**. Note what is *absent* from it. **Scale correction, perspective correction and identity
preservation are not stages in that taxonomy at all.**

> **The layered family does not do what its name suggests.** LayerDiffuse's background-conditioned
> mode *generates* a new foreground from text; you cannot hand it your character. The only layered
> system that genuinely takes a given foreground and a given background is **LASAGNA**, and its
> dataset and benchmark are "will be publicly released" rather than released. ART
> ([2502.18364](https://arxiv.org/abs/2502.18364), CVPR 2025) is worse than unavailable: **Microsoft
> withdrew the weights**, stating the model "was trained using data that may have come from illegal
> sources".

### One benchmark measures it, and the numbers are discouraging

The sequence-concatenation row in
[What replaced ControlNet on DiT models](#what-replaced-controlnet-on-dit-models) is the mechanism
every modern edit model uses, and the obvious way to attempt this workflow is to hand such a model a
plate and a character sheet. **That capability is measured in exactly one mainstream benchmark, and it
is measured badly.**

**OmniContext**, the benchmark shipped with OmniGen2 ([2506.18871](https://arxiv.org/abs/2506.18871)),
has eight splits grouped SINGLE / MULTIPLE / SCENE. The SCENE group is precisely "put this given
subject into this given background image", and it includes a `scene_character` split. It is scored by
a GPT-4.1 judge on prompt following and subject consistency. From its Table 4:

| Model | `single_character` | `scene_character` |
| --- | --- | --- |
| **Qwen-Image-Edit-2509** | **8.35** | **5.16** |
| OmniGen2 | — | 7.75 |
| GPT-4o | 8.90 | 8.80 |
| UNO | — | 2.06 |
| BAGEL | — | 4.07 |
| **FLUX.1 Kontext max** | scored | **not evaluated — blank on every SCENE column** |

**Read the first row.** The same model that handles a character alone nearly perfectly loses roughly
3.2 points the moment the character has to go into a supplied plate. And Kontext is blank for a stated
reason — its own paper says: "While our formulation naturally covers multiple input images, we focus
on single context images for conditioning at this time."

**The capability is asserted where it is not measured.** Qwen-Image-Edit-2509's model card advertises
"person + scene" composition and publishes no numbers for it; OmniContext's 5.16 is the only
independent measurement of that claim, and it is a third party's.

**No other headline edit benchmark contains the task.** KontextBench's five categories are local
editing, global editing, character reference, style reference and text editing — and "character
reference" means a character re-rendered into a *text-described* environment, not a supplied plate.
GEdit-Bench's "subject-add" is text-driven from a single image. ImgEdit-Bench and CompBench are
instruction-driven throughout. GEditBench v2 excludes the task in as many words: "we exclude
multi-image input editing tasks from our benchmark".

### What is actually hard, and which parts are measured

| Failure | Measured? | Best evidence |
| --- | --- | --- |
| **The plate comes back damaged** | **Yes, and well** | Latent-mask compositing "produces large artifacts at mask seams and global degradation and color shifts" ([2512.05198](https://arxiv.org/abs/2512.05198)), whose fix cuts edge error by up to 53%. REED-VAE ([2504.18989](https://arxiv.org/abs/2504.18989)) shows encode/decode **with no edit at all** falling from PSNR 26.09 at 5 iterations to **14.84 at 25** |
| **The "untouched" background is not untouched** | **Yes** | PIE-Bench computes background preservation strictly outside the annotated mask; the best method reaches **PSNR 27.22** there |
| **Output does not register with input** | **Practitioner only** | "Pixel drift" on Qwen-Image-Edit — a slight zoom or few-pixel shift so outputs "don't align when layered in editing software" (QwenLM/Qwen-Image issue #229; HF Qwen-Image-Edit discussion #16). ⚠️ Unquantified, and both threads are open with no maintainer reply |
| **Colour and lighting mismatch** | **Measured on the wrong data** | iHarmony4 (73,146 pairs) is real photographs whose foreground was **recoloured**. Only Hday2night — 444 pairs, **0.6%** — has a genuinely foreign foreground |
| **Scale and ground-plane placement** | **Barely** | TopNet ([2304.03372](https://arxiv.org/abs/2304.03372)) isolates scale with location held fixed: **IoU>0.95 in 27.04% of cases**. GraPLUS ([2503.15761](https://arxiv.org/abs/2503.15761)) reports **16.5%** of placements within a 0.8 scale ratio |
| **Contact shadow** | **Measured, uninformatively** | On DESOBA, global SSIM is 0.93–0.99 for *every* method including the worst, and local SSIM is 0.24–0.38 for everyone including the winner. Only local RMSE discriminates |
| **Perspective mismatch** | **Yes, and validated against humans** | APFD ([2212.03239](https://arxiv.org/abs/2212.03239)) — see the evaluation subsection below |
| **Identity drift across many plates** | **No** | No method paper in this literature reports it |

**Three of these deserve the detail.**

**Placement quality is measured by one lumped binary, and it is not measuring geometry.** SimOPA, from
the OPA dataset ([2107.01889](https://arxiv.org/abs/2107.01889)), is a classifier over
composite-plus-mask trained on 62,074 human-labelled placements, reaching F1 0.780 / balanced accuracy
0.842. **OPA's own annotation guidelines fold scale, occlusion and perspective into that single
binary** — one guideline reads "The perspective of foreground object should look reasonable", and
there is no per-factor label. The consequence is visible in one paper's own tables: **GraPLUS reports
92.1% SimOPA "accuracy" alongside a mean IoU of 0.203 and a 16.5% scale-within-0.8 rate.** A number
that high next to numbers that low is not measuring geometric correctness. GOPI
([2608.06836](https://arxiv.org/abs/2608.06836)) states the underlying reason: "the physical scale of
the inserted furniture relative to the scene cannot be uniquely determined, making physically grounded
furniture placement underdetermined from image evidence alone."

**Ground contact is unmeasured even by the paper named after it.** "Floating No More"
([2407.18914](https://arxiv.org/abs/2407.18914)) reports AbsRel, δ₁, Chamfer distance and pixel-height
field errors. **It has no metric for floating, tilt or ground contact.** The problem is stated in prose
and demonstrated in figures.

**Shadow generation admits its own metrics do not work.** DMASNet
([2306.17358](https://arxiv.org/abs/2306.17358)) scores *worse* than the previous state of the art on
RMSE, S-RMSE and PSNR, argues it is nonetheless better, and says so directly: "The mismatch between
quantitative evaluation and qualitative evaluation motivates us to include more metrics." SGDiffusion
([2403.15234](https://arxiv.org/abs/2403.15234)) generates five results per test image and "select[s]
the one closest to the ground-truth" — an oracle selection against the answer. ⚠️ **Across the whole
DESOBA line, no paper reports a correlation between its metrics and human judgement**, including the
four that ran user studies.

> **The occlusion limitation is architectural, not incidental.** ObjectStitch states it plainly:
> "masking the output image… prohibits our model from generating global effects, i.e. shadow can only
> be synthesized within the mask." A mask-driven insert cannot cast a shadow onto the plate outside
> its own mask. "Thinking Outside the BBox" ([2409.04559](https://arxiv.org/abs/2409.04559)) exists
> specifically to fix this, and **has no code or weights.**

### The domain gap again, in methods and data this time

[The domain gap is real, and it is uneven](#the-domain-gap-is-real-and-it-is-uneven) found the gap in
*measurement*: shot-scale classifiers survive the jump to stylised 2D and camera-geometry classifiers
do not. **Here the gap is in the methods and the training data, and it is not uneven — it is total.**

**There is no published method, dataset or benchmark whose task is inserting an illustrated foreground
into an illustrated background.** That negative comes from roughly fifteen query formulations plus an
entry-by-entry pass over the field's own curated lists (BCMI's Awesome-Image-Harmonization,
Awesome-Generative-Image-Composition and Awesome-Object-Insertion), and it is stated here as a
confident negative rather than a certainty.

**What exists instead is the inverse problem.** Cross-domain composition puts a *photographic or
synthetic* foreground into a *stylized* background: Insert In Style
([2511.15197](https://arxiv.org/abs/2511.15197)), Chameleon
([2606.01079](https://arxiv.org/abs/2606.01079)), AIComposer
([2507.20721](https://arxiv.org/abs/2507.20721)), Magic Insert
([2407.02489](https://arxiv.org/abs/2407.02489)), TF-ICON
([2307.12493](https://arxiv.org/abs/2307.12493)). libcom's `PainterlyHarmonizationModel` is defined the
same way — "artistic background and photorealistic foreground". **The word "anime" appears in none of
their style lists.** Chameleon enumerates 1,171 styles including "cartoon, comics, kids' drawing";
Insert In Style names cartoon, Ghibli, pixel art, vector illustration, pencil sketch and Chinese ink.
**AIComposer's 367-example extended benchmark is the largest concentration of illustrated content
found in any composition benchmark anywhere, and it is 367 examples.**

**Their measured margins over off-the-shelf editors are small and mixed.** Insert In Style against
FLUX.1 Kontext on its own benchmark: CLIP-I 0.761 vs 0.665, but style consistency (CSD) **0.466 vs
0.470 — Kontext wins the style metric.** The real gap is identity, not style, which is the opposite of
what the framing "stylized composition" suggests.

**Four further facts, each independently sourced:**

- **iHarmony4 is 100% photographic**, so the entire harmonization literature's pixel metrics are
  calibrated on photographs.
- **Anime degrades measurably worse than photographs under the same models.** Qwen-Image-Edit-2511 at
  square resolutions produces washed-out output that "lose[s] the subject's likeness significantly" on
  an anime-style example, reproduced across three independent configurations including full BF16 with
  no LoRA, which rules out quantization (QwenLM/Qwen-Image issue #243, open). Step-distilled variants
  hurt 2D art specifically (ModelTC/LightX2V issue #904). ⚠️ **Both are practitioner bug reports, not
  papers.**
- **The identity machinery underneath the tooling is photographic.** InstantID and PuLID take
  embeddings from InsightFace; FLUX.1 Kontext measures its own multi-turn character consistency with
  **AuraFace, a human face recogniser**, so its headline consistency claim is not validated on drawn
  faces at all.
- **The standard identity metric is anti-correlated with human judgement on illustration.** CHARIS
  ([2511.08087](https://arxiv.org/abs/2511.08087)) is the only identity study that breaks correlation
  out by visual style, and its DINOv2 row reads **Pearson r = −0.071 on vector art** (CLIP 0.168,
  CHARIS 0.372; human–human baseline 0.651–0.829).

**Two things cut the other way, and they are the reason not to dismiss the workflow outright.** A
SIGGRAPH 2026 anime layer-decomposition paper, See-through
([2602.03749](https://arxiv.org/abs/2602.03749)), omits background reconstruction and says why:
"production pipelines typically replace it with a new scene." And the VN engine is already a
compositor — Ren'Py's `scene` and `show` put a background and character sprites on the same `master`
layer as separate displayables. **Plate-plus-sprite is the native data model of the medium.** The
question this section answers is narrower: whether a *generative edit* is the right way to produce
that composite. On the published evidence, it is not yet.

### Evaluation: five metrics carry a human-correlation number, and none covers scale

| Metric | Correlation with human judgement | Scope |
| --- | --- | --- |
| **APFD** ([2212.03239](https://arxiv.org/abs/2212.03239)) | **Pearson 0.87** (median), from 2AFC on *composited* images | Camera perspective of an inserted object only |
| **HarmonyIQA** ([2501.01116](https://arxiv.org/abs/2501.01116)) | SRCC 0.7848 | Colour and light harmonization only |
| **Self-CIDS** ([2505.24862](https://arxiv.org/abs/2505.24862)) | Pearson 0.7956 | Character drift across a story, **aggregated over styles** |
| **CANVAS's VLM judge** ([2604.13452](https://arxiv.org/abs/2604.13452)) | Pearson 0.74, Fleiss κ 0.74 | Multi-frame character consistency |
| **SimOPA** ([2107.01889](https://arxiv.org/abs/2107.01889)) | bAcc 0.842 against binary labels | Lumped placement rationality; never correlated against a preference ranking |

**Every other metric in routine use has no published human correlation**: MSE, fMSE and PSNR on
iHarmony4; the six-metric DESOBA set; and every score in libcom's own Composite-Image-Evaluation list
(harmony, OPA, FOS, CLIP, DINO, FID, QS), whose README makes no correlation claim.

**Two of the five are worth reading carefully.** APFD is the strongest result in this whole area — it
was validated on exactly this task, ranking composites of a 3D object rendered under perturbed camera
parameters, and raw camera-parameter deltas do *worse* than the dense field (FoV deviation scores
**−0.08**). But it covers perspective and nothing else. HarmonyIQA is built from ccHarmony
composite/reference pairs, **so only colour and light vary across its 1,350 images** — placement,
scale, perspective and shadow are correct by construction in all of them. **HarmonyIQA cannot tell you
whether a character is the wrong size or floating.**

**Nothing measures scale plausibility without a ground-truth box**, which is the metric a VN would
most want, and it is the same gap this survey already identified for whole-frame generation in
[What remains unverified](#what-remains-unverified).

**On identity metrics specifically, the guidance is to avoid CLIP-I.** ObjectMate
([2412.08645](https://arxiv.org/abs/2412.08645)) measured agreement with human judgement on object
insertion at **CLIP-I 60.4%, DINO 71.8%, instance-retrieval features 79.5%**. And the field says
outright that the pixel metrics do not transfer to this question: ZeroComp
([2410.08168](https://arxiv.org/abs/2410.08168)) states that "recent evidence has shown they do not
correlate with human perception when evaluating the realism of composited images", and reports its
metrics alongside that disclaimer.

**No method paper permutes identity against many backgrounds.** AnyDoor came closest — 30 subjects ×
80 COCO backgrounds, 2,400 images — and used it only for ablations, never for a baseline comparison.
The infrastructure to do it properly exists (MureCom's 20 backgrounds × 3 identities × 5 reference
views per category; ORIDa's 200 objects across ~50 scenes each) and is used almost exclusively by the
one lab that built it.

### Cost and control against re-rendering the whole frame

**Insertion does not save plate renders, and it is worth being clear about that before costing it.** A
location plate is rendered once per variant and reused as a *reference* either way; whole-frame
generation already pays for the plate exactly once. **What insertion buys is background stability** —
a plate that is byte-identical across a scene's shots rather than re-derived, with the drift that
implies. **What it costs** is a mask (or a model that picks placement, which measures worse), a
possible harmonization pass, the plate-damage risk above, and a per-call price that is generally
higher than a plain generate.

**Letting the model choose placement is measurably worse than supplying a mask.** MADD
([2412.14462](https://arxiv.org/abs/2412.14462)) prices it in its own ablation: mask 13.53 FID / 0.8727
CLIP → bbox 13.60 / 0.8658 → point 13.66 / 0.8567 → **null 13.96 / 0.8034**. The only system that both
picks placement and accepts your character image ("Thinking Outside the BBox") has no released code.

**Multi-character shots are where the hosted route breaks first.** The one API that does the literal
task in a single call accepts **one** character reference. A two-character shot is two masked passes,
which is two opportunities to damage the plate and two chances for the second pass to disturb the
first insert.

**Practitioners who succeed at this avoid a full-image generative edit entirely**, and the tooling
they build says why. `ComfyUI-Inpaint-CropAndStitch` (1.1k stars, officially forked by ComfyUI) sells
itself on one sentence: it "does not modify the unmasked part of the image, **not even passing it
through VAE encode and decode**". A separate community node exists purely to undo accumulated VAE
colour drift. The one first-person anime account found doing frame-level work on a reused plate
inpaints at 0.5 denoise and then **composites the result back onto the untouched plate in an image
editor**, calling the process "boring, tedious and time consuming". ⚠️ **This is practitioner
evidence — a CivitAI article and GitHub repositories, not papers** — and the largest practitioner
forums (all of Reddit, Lemma Soft) were unreachable to the research for this section, so its absences
prove less than its presences.

**The control comparison is genuinely favourable to insertion in one respect and unfavourable in
another.** A mask states where the character goes, which whole-frame generation cannot. But the three
axes in [Control strength has three orthogonal axes](#control-strength-has-three-orthogonal-axes) do
not apply: inpainting exposes a denoise strength, not a conditioning scale with a start and end
fraction, so the "structure early, detail late" trade that section recommends is unavailable on this
path.

### Which hosted APIs can insert into a plate today

Read from live OpenAPI specs on 2026-08-22, in the same format as
[Which image APIs expose structural control](#which-image-apis-expose-structural-control).
**"Yes" here means plate + mask + character reference in one call.**

| API | Plate + mask + character ref | Parameters | Seed | Price |
| --- | --- | --- | --- | --- |
| **Ideogram `/v1/ideogram-v3/inpaint`** | **Yes — the only first-party endpoint that does the literal task** | `image`, `mask`, `character_reference_images` (**1 max**), `character_reference_images_mask`, `style_reference_images`, `seed`. **No strength parameter** | ✅ | ⚠️ **not directly readable** (Cloudflare-challenged pricing page); the same model on fal/Replicate is **$0.10 / $0.15 / $0.20** by rendering speed, plus an unpublished character-reference surcharge |
| **fal `ideogram/character/edit`** | **Yes** — same model | `image_url`, `mask_url`, `reference_image_urls` (1), `reference_mask_urls`, `seed`, `rendering_speed` | ✅ **and echoed in the output** | $0.10 / $0.15 / $0.20 |
| **Adobe Firefly `/v3/images/{precise,adaptive}-composite`** | **Yes**, and purpose-built for it | `background.fillAreaMask`, `object.image`, `object.mask`, `preserveBackground`, **`harmonization`**, **`shadowIntensity`**, `seeds[]` | ✅ | ⚠️ **not fetched** (enterprise quote; every Firefly legal and pricing page timed out) |
| **fal `flux-general/inpainting`** | **Yes**, with the most knobs and the most wiring | `mask_url` + `strength`, `reference_image_url` + `reference_strength`, N `ip_adapters[]`, `loras[]`, `controlnets[]` — 36 parameters | ✅ | **$0.075/MP** |
| **BFL `/v1/flux-pro-1.0-fill-finetuned`** | **Partly** — identity comes from a trained finetune, not an image | `image`, `mask`, `finetune_id`, `finetune_strength` | ✅ | $0.05 |
| **OpenAI `/v1/images/edits`** | **No** — masks and up to 16 references, but see the seed column | `image` (≤16), `mask` (**applies to the first image only**), `input_fidelity` | ❌ **no seed on any image endpoint, any model** | token-metered; `gpt-image-2` output $30/M |
| **Google Gemini** | **No** — "semantic masking" is conversational; there is no mask parameter | up to 14 reference images | ⚠️ **documented only on the legacy `generateContent` config**, absent from the current image path | 2.5 Flash $0.039 |
| **Stability** | **No** — masks everywhere, **no subject-reference input anywhere** | `inpaint`, `erase`, `search-and-replace`; `background_reference` is documented as transferring **style**, not a subject | ✅ | $0.05/image |
| **Recraft / Runway / Luma** | **No** | Recraft inpaints without a reference; Runway and Luma take references without a mask | Recraft ❌, Luma ❌ | — |

**Four specifics worth knowing before committing.**

**Mask polarity is inverted between the two leading candidates, and it is a real integration trap.**
BFL Fill: "Black areas (0%) indicate no modification, while white areas (100%) specify areas for
inpainting." Ideogram inpaint: "Black regions in the mask should match up with the regions of the
image that you would like to edit." OpenAI is a third convention again — **alpha = 0** marks the
editable region. A shared mask-generation path has to invert per backend.

**The one API that ever exposed this as a first-class operation has been withdrawn.** Vertex AI's
`imagen-3.0-capability-001` carried `REFERENCE_TYPE_SUBJECT` alongside `REFERENCE_TYPE_MASK` and
`EDIT_MODE_INPAINT_INSERTION`. Google's migration notice states that "All Imagen models are deprecated
and will shut down as early as August 17, 2026" — five days before this was checked.

**OpenAI's absent seed is disqualifying for a content-addressed pipeline**, exactly as it is in the
structural-control table above, and for the same reason. It is otherwise the strongest option on
rights: an explicit assignment of output ownership, and training on customer content only by opt-in.

**Prefer fal over Replicate for the Google and ByteDance families.** The same models expose `seed` on
one host and not the other, and fal both guarantees reproducibility in writing and returns the
resolved seed in its output, so a run left unseeded is still recordable. Replicate does neither.
Against that, fal's terms contain **no output-ownership clause at all** — only disclaimers — where
Replicate assigns output rights explicitly.

**The licence picture is the reverse of the intuition, and it extends
[The FLUX licence constraint](#the-flux-licence-constraint).** Every FLUX editing model with a mask is
non-commercial to self-host: `FLUX.1-Fill-dev`, `FLUX.1-Kontext-dev` and `FLUX.2-dev` all carry a
FLUX non-commercial licence on Hugging Face, and BFL's own pricing document describes FLUX.2 [dev] as
"Open weights, non-commercial (no hosted API)". The two most-cited subject-insertion adapters are
permissive **code on non-commercial base weights** — DreamO is tagged `apache-2.0` but is FLUX-based,
and UNO declares `base_model: black-forest-labs/FLUX.1-dev` in its own card metadata while releasing
its weights under CC BY-NC 4.0. **Qwen-Image-Edit-2509/2511 and OmniGen2 are the only genuinely
Apache-2.0 multi-reference editors, and neither takes a mask.** As before, the constraint binds on
running the weights, not on the pictures: outputs are unrestricted.

**So the honest self-hosting shortlist, weights released and licence shippable, is MimicBrush
(Apache-2.0), AnyDoor (MIT) and MADD (BSD-3)** — all mask-driven, all 2024-era quality, and all
trained on photographs.

---

## Where the inference runs

Every price and parameter name below was read from a page fetched on 21 August 2026, with the source
linked. Anything that could not be fetched is listed under "what could not be verified" rather than
estimated.

### One question partitions the market

A shot-framing system conditions on a **layout**, which makes a single question decisive — and it
divides the market far more sharply than price does:

> Does this accept a **control map** (depth, canny, pose, scribble) with a **conditioning scale**, or
> only a **reference image** whose influence is semantic?

**Almost every headline image API of 2026 is the second thing.** Black Forest Labs says so in its own
documentation: "Instead of dedicated ControlNet inputs, FLUX.2 uses its multi-reference editing system
to achieve structural control," with references interpreted "conceptually rather than pixel-perfectly"
([docs.bfl.ml](https://docs.bfl.ml/guides/usecases_editing_controlnets.md)). For a pipeline that has
already computed a layout, "conceptually rather than pixel-perfectly" is the failure mode, not the
feature.

### Which image APIs expose structural control

| API | Structural control | Control parameters | Price |
| --- | --- | --- | --- |
| **fal.ai** | **Yes — the richest surface verified anywhere** | `controlnets[].{control_image_url, conditioning_scale, start_percentage, end_percentage}`; `controlnet_unions[].controls[].control_mode` ∈ canny/tile/depth/blur/pose/gray; `control_loras[]`; `ip_adapters[]` | `flux-general` **$0.075/MP**; control-LoRA canny/depth **$0.04/MP** |
| **Replicate** | **Yes** | `control_image`, `guidance` — **no conditioning-scale knob** | canny-pro / depth-pro **$0.05/image** |
| **Stability AI** | **Yes** — `/v2beta/stable-image/control/{structure,sketch}`. **No pose endpoint exists** | **`control_strength`, 0–1, default 0.7** | structure/sketch **$0.05/image**; style-transfer $0.08 |
| **BFL direct** | **No** — no canny/depth path in the live OpenAPI | `input_image`…`input_image_8` | FLUX.2 [pro] from $0.03 |
| **OpenAI** | **No** | `image`, `mask`, `input_fidelity`. **No seed** | token-metered, $30/M out |
| **Google Gemini** | **No** | aspect ratio, up to 14 references | 2.5 Flash **$0.039**; 3 Pro **$0.134** |
| **Recraft** | **No** — `controls` holds colour and style only | `controls.{colors, artistic_level}` | V4.1 $0.035 |
| **Ideogram / Luma** | **No** | style and character references, weights | Ideogram V3 $0.03/$0.06/$0.09 (third-party hosts); Luma Uni-1 $0.0404 |

> **Stability, read from its own OpenAPI spec.** The docs site is a Cloudflare-fronted SPA and the
> spec it advertises 404s, but a working one is served at
> `https://api.stability.ai/v2alpha/openapi`. `control_strength` is the real parameter name, 0–1,
> default 0.7, on both `/control/structure` and `/control/sketch`. `/control/style` and
> `/control/style-transfer` use **different** names (`fidelity`, `style_strength`,
> `composition_fidelity`), so the four endpoints do not share one dial. Across all 31 paths the only
> word containing "pose" in the entire 471 KB spec is `overexposed` — **there is no pose control on
> the Stability API**, and `/control/pose` and `/control/openpose` both 404 where the four real
> endpoints 401. Terms of service assign output rights to the customer and forbid using outputs to
> train competing models.

**Four specifics worth knowing before committing.**

**fal's one-controlnet limit is endpoint-specific, not a platform rule.** `flux-general` says "**Only
one controlnet is supported at the moment**" on both its array fields, so the array shape is
misleading and depth-plus-pose is unavailable there. But `fal-ai/sdxl-controlnet-union` exposes **six
independent control-image fields** — `openpose_`, `canny_`, `depth_`, `normal_`, `segmentation_`,
`teed_image_url` — with no such language and a `controlnet_conditioning_scale` of its own, and fal
labels it a multi-controlnet model. ⚠️ **That six-field schema is not proof that setting two of them
runs two conditioning passes**; no worked example confirms it and no live call was made. **If stacking
depth with pose is a requirement, that endpoint is the only verified candidate on fal and it must be
tested before being designed around.** Every FLUX-family endpoint on fal is single-control, and
`z-image/turbo/controlnet` takes one `image_url` with a single-valued `preprocess` enum, so it too
permits one at a time despite offering three modes.

fal's billing **rounds up to the nearest megapixel**, so a 1920×1080 render bills as 3 MP and triples
the unit cost. Replicate's FLUX control models expose only `guidance`, so **control strength is not
directly dialable**, which matters for a validation loop that wants to retry a shot with more
structural adherence. OpenAI documents **no seed parameter at all**, which is disqualifying on its own
for a content-addressed resumable pipeline.

**Two licences are tier-dependent, which is easy to miss.** Recraft assigns copyright to paid users
but **owns free-tier assets outright and forbids their commercial use**; Luma assigns output to the
customer but permits commercial use only for output produced under an active paid subscription. Both
forbid using output to train models. ⚠️ **Ideogram's terms could not be read at all** — `/terms`,
`/legal`, `/tos`, `/content-policy` and six other paths all returned 403 or 404 — so no claim about
Ideogram's output ownership belongs in a build decision.

### The FLUX licence constraint

Read directly from BFL's licence files, because it reverses the intuitive build-versus-buy answer.

The **FLUX.1 [dev] Non-Commercial License v1.1.1**
([text](https://raw.githubusercontent.com/black-forest-labs/flux/main/model_licenses/LICENSE-FLUX1-dev))
restricts the weights to "non-commercial and non-production use", and its definitions explicitly sweep
in **Depth [dev], Canny [dev], the Canny/Depth LoRAs, Fill, Redux and Kontext [dev]** — that is, every
FLUX control model anyone would self-host. Third-party FLUX ControlNets inherit it: InstantX's and
Shakker-Labs' depth and canny models are both `license:other`.

**Outputs are unrestricted.** Clause 2(d): "You may use Output for any purpose (including for
commercial purposes)." The constraint binds on running the weights in a commercial product, not on the
pictures.

**So calling a host is the licensed route to FLUX [dev]-class control, and downloading the same weights
into your own runner is not** — the host holds the commercial licence. The permissive escape routes are
**FLUX.1 [schnell]** (Apache-2.0) and **Qwen-Image** (Apache-2.0); **SD 3.5 Large** is free commercially
only below $1M annual revenue.

### Hosted ComfyUI runners

The axis that discriminates is **who owns the graph**. A pipeline that emits a structurally different
workflow per shot — a different control stack, a variable LoRA count — needs the graph in the request
body rather than pinned to a deployment.

| Service | Arbitrary workflow JSON per request | Custom nodes | Cost for 1,000 generations at 20 s |
| --- | --- | --- | --- |
| **RunPod Serverless** (`worker-comfyui`) | **Yes** — `POST /run`, body carries the workflow | Yes, **but only via a custom Dockerfile** | **$9.72** (L40S) |
| **ComfyICU** | **Yes** | **No — shared executor, no custom nodes at all** | $64.00 (L40S) |
| **Replicate** (`any-comfyui-workflow`) | **Yes** | **Curated list only** | $19.50 (L40S) |
| **RunComfy** | **No** — an `overrides` map of node-id → input | Yes | hourly, $0.99–$9.59/h |
| **Comfy Org Cloud** | **Yes** — `POST /api/prompt` with `{"prompt": workflow}` in export-API format | Preinstalled set only; **no model upload** | $16/mo annual, $20/mo monthly, to $80–$100; concurrency 1–5 |
| **ComfyDeploy** | **No** — `POST /run/deployment/queue` takes `deployment_id` plus an `inputs` map | Yes | ⚠️ pricing moved behind the app login |
| **Modal / fal / Baseten** | Not natively — you own the container and HTTP surface | Yours | $10.84–$21.94 (Modal L40S–H100) |
| **Salad** | Via their own MIT `comfyui-api` wrapper, self-deployed | Yours | RTX 4090 **$0.30/h** (prices ~11 months stale) |

**RunPod Serverless and Comfy Org Cloud are the two verified options taking an arbitrary graph per
request**, and they differ on everything else: RunPod takes arbitrary node packs through a custom
Dockerfile, Comfy Cloud takes none and accepts no uploaded model files. ComfyICU has the cleanest API
and forbids custom nodes entirely, which is an easy thing to discover too late.

**ComfyDeploy is deployment-scoped, and its own spec settles it.** A `WorkflowRunRequest` schema
carrying `workflow_api_json` exists in `components.schemas` but is **referenced by no path** — an
internal dashboard type, not a public route, and even it requires a registered `workflow_id` alongside
the graph. The public surface is three endpoints. A pipeline emitting a structurally different
workflow per shot cannot use it.

Two corrections to an earlier draft. **Comfy Cloud's two pages do not disagree**: $16/mo is the annual
rate and $20/mo the monthly one, and the earlier draft compared one to the other. **Salad is not
opaque** — its website 403s every route, but its GitHub org is open and authoritative, publishing both
a price file and an MIT ComfyUI wrapper with two constraints a build must plan around: a **100-second
Container Gateway timeout** (long jobs need webhooks) and a 35 GB compressed image ceiling.

#### Cold start is the largest unmodelled term, and one published figure is a trap

⚠️ **No third-party measured cold-start figure for a 10–25 GB image model exists on any of these
platforms.** Everything available is vendor-claimed or anecdotal. The vendors do agree on where the
time goes: Baseten states "loading model weights can dominate cold-start time", and Modal separates a
roughly one-second container boot from a weight load it describes as "minutes" without snapshotting.
The closest figure to the right size band is Modal's own **~1 minute for SD3.5 Large Turbo**.

⚠️ **Do not put RunPod's sub-200 ms FlashBoot number in a cost model.** FlashBoot's own documentation
describes **retaining worker state after spin-down**, so that figure measures reviving a warm worker,
not a fresh container plus a multi-gigabyte weight load — using it as a cold-start term understates
the real number by two to three orders of magnitude. RunPod's own model-caching docs concede "large
models requiring several minutes to load" when no cached host is available.

**Weight size is the driver, and the LoRA-versus-checkpoint gap is 19×.** Exact bytes from the
HuggingFace API:

| Artifact | Size |
| --- | --- |
| `flux1-depth-dev.safetensors` (full 12B checkpoint) | **22.17 GiB** |
| `flux1-canny-dev.safetensors` | 22.17 GiB |
| InstantX FLUX.1-dev-Controlnet-Canny | 3.34 GiB |
| Shakker-Labs FLUX.1-dev-ControlNet-Depth | 2.97 GiB |
| **`flux1-depth-dev-lora.safetensors`** | **1.16 GiB** |

**The full merged checkpoint is a complete copy of the transformer; the LoRA delivering the same
capability is 19.1× smaller.** That compounds directly with the cold-start problem: full checkpoints
put a self-hosted runner in the worst band, LoRAs largely avoid it, and third-party ControlNets sit
between.

### OpenRouter's actual boundary

**It does route image generation** — this is not the text-only answer one might expect. `POST /api/v1/images`
([docs](https://openrouter.ai/docs/features/multimodal/image-generation)) takes `model`, `prompt`,
`resolution`, `seed`, `input_references` and returns base64 with a `usage.cost`, over a catalogue of
40+ image models.

**But it does not route structural control.** Its only image-conditioning primitive is
`input_references` — "Pass reference images to guide generation". Masks, control images, depth, canny,
pose, ControlNet and inpainting are absent. This follows necessarily from the table above: OpenRouter
aggregates the closed hosted APIs, and none of those expose control maps, so **it cannot route a
capability its upstreams do not have.**

**Where it is unambiguously right is the other half of the pipeline** — the layout reasoning, prompt
derivation, and VLM validation calls. It takes no markup on inference ("we pass through the pricing of
the underlying providers without any markup"), supports `response_format: json_schema`, and its
`provider` object with `require_parameters` plus a `models` fallback array gives real routing control.

⚠️ One caveat that bears on a validation loop specifically: for providers without an OpenAI-compatible
interface, OpenRouter "transform[s] the tools into a YAML template" rather than using native tool
calling, and structured-output enforcement varies — "some guarantee schema-conforming output, while
others treat it as a strong hint." Both degrade quietly.

### Self-hosting, in the numbers that are actually published

**An honest negative first: neither HuggingFace model cards nor ComfyUI's own documentation publish
numeric VRAM requirements for any model family checked.** ComfyUI's FLUX tutorial says only that the
full version needs "larger VRAM resources", with no figures. **Every specific VRAM number in
circulation is community folklore rather than a vendor claim.** What follows is verified file sizes,
which are a hard floor on weight residency.

| Model | Weights | Licence |
| --- | --- | --- |
| **FLUX.1 [dev]** | transformer **23.80 GB**, T5 encoder **9.52 GB**, CLIP 246 MB, VAE 335 MB | **Non-commercial** |
| **FLUX.1 [dev] GGUF** | Q8_0 **12.71 GB**, Q4_K_S **6.81 GB**, Q2_K 4.03 GB | inherits dev |
| **Qwen-Image** | ~20.43 GB BF16 params, 57.95 GB repo | **Apache-2.0** |
| **SD 3.5 Large** | 8B | Stability Community (<$1M revenue) |

**A 24 GB consumer card cannot hold FLUX.1 [dev] at bf16 with its text encoder resident** — 23.80 plus
9.52 GB of weights exceeds it before activations. The fp8 or Q4 quantisations are what make that card
viable. Worth noting structurally: BFL ships FLUX control as both a full 12B model **and** a LoRA
adapter, and the adapter form is what keeps a control stack affordable, since a full canny model is a
second 12B checkpoint rather than an add-on.

**ComfyUI's own API is well suited to a TypeScript caller** — `POST /prompt` with the whole workflow
including widget values, `/upload/image` and `/upload/mask`, `/history/{prompt_id}`, `/view`, and a
`/ws` socket emitting `progress`, `executing` and `executed`. The submission model is asymmetric:
client-to-server over HTTP, server-to-client over the socket.

⚠️ **The ComfyUI server documents no authentication mechanism of any kind** — no keys, no credentials,
no access control. Because custom nodes execute Python, `--listen` exposes an unauthenticated
arbitrary-code-execution surface to whatever network it binds. It has to sit behind a separate auth
proxy and must never be on a public interface. It also does not accept the UI-saved workflow JSON; the
API format is a different export.

### What a project actually costs

Taking 500 shots at two to four attempts under a closed validation loop — **1,000 to 2,000
generations** — at 1280×720 and 20 s of GPU each:

| Route | 1,000 generations | 2,000 generations |
| --- | --- | --- |
| fal control-LoRA canny/depth | **$40** | **$80** |
| Replicate flux-canny-pro | $50 | $100 |
| fal `flux-general` (full ControlNet) | $75 | $150 |
| RunPod Serverless L40S (self-run ComfyUI) | **$9.72** | **$19.44** |
| Modal H100 | $21.94 | $43.88 |
| ComfyICU L40S | $64 | $128 |
| RunPod A6000 pod, torn down after 40 h | $13.20 | — |
| RunPod A6000 pod, left running a month | **$237.60** | — |

**Every route lands between roughly $10 and $270 for an entire visual novel.** The conclusion that
matters: **compute cost is not the deciding variable.** Capability and licence are, and the cost table's
real message is to optimise for those and treat the bill as noise. Two second-order effects are larger
than the differences between vendors — fal's megapixel rounding triples the unit cost at 1080p, and
forgetting to tear down an hourly pod costs about 18× the compute it performs.

### Recommendation, and the strongest case against it

**Render through fal's `flux-control-lora-canny` and `flux-control-lora-depth`; run every LLM and VLM
call through OpenRouter; keep a local ComfyUI as the development rig rather than the production
renderer.**

The reasoning in order of weight: structural conditioning is the requirement and only fal, Replicate
and Stability have it; of those, **fal and Stability both expose a conditioning scale** (fal's
`conditioning_scale`, Stability's `control_strength` at 0–1 default 0.7) and Replicate does not, and a
validation loop needs that dial in order to retry with more structural adherence. fal wins over
Stability on breadth rather than on the dial: Stability offers structure and sketch and **no pose
endpoint at all**, which forecloses character-posed framing. The licence puts self-hosting FLUX [dev]
control weights out of reach for a shipped product while calling a host does not. And a roughly $50
delta across an entire project does not justify owning a Docker build, a weight cache, a queue and an
unmeasured cold-start problem.

**Stability is the fallback worth naming**, because it is the second vendor with a real strength dial
at $0.05 per image flat, and its terms assign output rights cleanly. Losing pose control is the price.

**The strongest argument against it deserves stating in full, because it is not weak.** fal is a single
vendor that has already deprecated `flux-pro/v1/canny` — a control endpoint, killed — and its
FLUX-family endpoints cannot stack depth with pose. (`fal-ai/sdxl-controlnet-union` may be able to, but
that means dropping to SDXL, and the capability is inferred from a six-field schema rather than
demonstrated.) The industry direction is visibly *away* from control maps: BFL removed structural
endpoints from its own API in favour of multi-reference editing, and Google, OpenAI, Recraft, Ideogram
and Luma never had them. There is no portability story, because `controlnets[].conditioning_scale` is
fal's schema rather than a standard, so migrating means rewriting the rendering layer. **The honest
alternative is RunPod Serverless with `worker-comfyui`** — arbitrary graphs, arbitrary nodes, and
cheaper — which trades those risks for a Docker and CI story, an unmeasured cold start, and a licence
problem with no clean answer: running FLUX [dev] control weights in your own container for a commercial
product is precisely what the non-commercial licence forbids, and escaping to Apache-2.0 [schnell] or
Qwen-Image means giving up the control ecosystem that motivated the stack.

### What could not be verified here

**Cold-start latency is the one that matters and the one still open.** No third-party measurement
exists for a 10–25 GB image model on any platform here, and the section above explains why the
vendor-published numbers cannot substitute. It remains the largest unmodelled term in every cost
figure in this survey.

Still unobtainable: **ComfyDeploy's pricing**, which moved behind the app login rather than
disappearing; **Ideogram's official per-image price and its terms of service**, both 403-walled, so
the Ideogram figures above come from two independent third-party hosts and no claim about Ideogram's
output ownership can be made at all; and **numeric VRAM requirements**, unpublished everywhere. Salad's
published prices are from a file last committed roughly eleven months before this survey, so they are
indicative rather than current. Local hardware and electricity costs were deliberately not estimated.

**Closed since the first draft:** Stability's parameters, pricing, licence and the absence of a pose
endpoint (read from its own OpenAPI spec); whether ComfyDeploy and Comfy Cloud accept an arbitrary
graph (no and yes respectively); Comfy Cloud's apparent price contradiction (annual versus monthly);
Salad's product, GPU prices and ComfyUI support (via its GitHub org, the website still being 403);
FLUX ControlNet file sizes; and the Recraft and Luma licences, both of which turn out to be
tier-dependent.

Three name collisions worth recording: **ComfyUI "API nodes" are not a hosted runner** — they are
outbound partner nodes calling third-party APIs on prepaid credits, the opposite direction of travel.
**fal's "Workflow Endpoints" are not ComfyUI graphs** but fal's own model-chaining primitive, and
fal's actual ComfyUI deployment doc is marked "Under construction". **"FLUX.1 Tools Canny/Depth" no
longer exist on BFL's API** — the current Tools family is outpainting, erase, deblur and VTO; canny and
depth survive only on resellers.

---

## Three architectures

Presented cheapest first. All three assume the validation loop from Section 6, because that is where
the leverage is; they differ in how the framing is specified and conditioned.

### Architecture A — enum plus text, with a geometric check

**No 3D, no proxy, no renderer.** Shots carry a small discrete framing vocabulary. The prompt is
derived from the enum plus authored art direction. Generation goes to a hosted image API. **The
validation loop is the entire sophistication:** run a person detector on the result, compute
bounding-box height over frame height, project the authored enum onto the three-class close/medium/long
axis, and compare. On mismatch, adjust the prompt deterministically and regenerate, to a fixpoint or a
retry cap.

**Why it is first:** it is the only architecture here that could be built in days rather than months,
and it delivers **the thing the literature does not have** — a geometric framing check in a closed
loop. It skips every unmeasured claim in Section 5 entirely.

**What it cannot do:** control which character stands where, guarantee occlusion order, or hold a
consistent spatial layout of a location across many shots.

**The one number it rests on:** shot-scale classification on stylised art is about **0.80 F1**
(Section 3), so roughly one verdict in five is wrong. That is enough to drive a retry and to flag a
shot for review; it is not enough to reject a frame outright. Build the loop so a disagreement raises
the shot rather than discarding it.

### Architecture B — 2D instance layout with masks

Add an authored 2D layout — boxes or masks per character — and condition with **InstanceDiffusion**
(**+20.4% AP₅₀ on boxes, +25.4% IoU on masks**) or, if training-free is required, **BoxDiff** or
**MultiDiffusion**. Occlusion is handled by drawing the masks in a fixed painter's order, which is a
manual encoding of depth rather than a model inference, and is entirely adequate for two or three
characters.

**Why it beats jumping to 3D:** it is better-evidenced on the only measured axis (placement accuracy),
it needs no renderer, and two of the three options require no training at all. The 24.3%-versus-48.2%
result in Section 5 is the direct argument.

**What it cannot do:** keep a location's geometry consistent between shots, or derive framing from a
camera rather than from an authored 2D arrangement.

### Architecture C — 3D proxy, depth conditioning, solved camera

The architecture the survey's prompting example describes. Author coarse 3D boxes for characters and
set dressing; place a camera; rasterise depth with three.js headless; condition a depth ControlNet or,
on a DiT model, a depth-concatenation variant; apply structural control only over early denoising
steps so composition is fixed and detail is free; validate geometrically as in A.

**What it uniquely buys**, and this is the honest short list: genuine occlusion ordering, a location
whose geometry is identical across every shot in a scene, and framing derived from an actual camera —
which makes **Toric space** available for the "put these two characters at these screen positions"
problem, solved in closed form.

**What it costs, stated plainly:** proxy leakage is real and documented, and it degrades prompt
adherence as well as realism, so a Ctrl-X-style appearance pass or careful control scheduling becomes
necessary rather than optional. **And the central claim — that 3D beats 2D — is unmeasured** except in
one self-reported table with a shared author across the compared methods.

### Choosing between them

| If the priority is… | Build |
| --- | --- |
| Shipping something that measurably improves framing | **A** |
| Precise control over who is where in frame | **B** |
| A location that stays geometrically consistent across a scene | **C** |
| Minimum unvalidated risk | **A**, then B |

**One constraint from Section 7 cuts across all three.** B and C both need a control map with a
conditioning scale, and that capability exists at exactly one hosted vendor with a dial (fal), is
absent from every frontier API, and is licence-blocked for self-hosting in the FLUX [dev] family.
A is the only one of the three that runs on any image API at all, which is a portability argument for
it independent of its other merits.

**The recommendation is to build A first regardless of the eventual target**, because its validation
loop is a prerequisite for evaluating B or C at all. Without a geometric framing measurement there is
no way to tell whether adding 3D helped — which is, not coincidentally, exactly the position the
published literature is in.

---

## What this means for this repository

The repository is closer to the unbuilt system than the literature review suggests, and the gap is
smaller and more specific than expected.

### The loop already exists

`packages/pipeline/src/runners.ts:102` implements the P7 generate-critique-refine loop: generate the
image, have **every** vision reviewer critique it against a shot spec, merge the verdicts, accept if
nothing blocks, otherwise refine the prompt deterministically and try again up to
`config.max_refine_attempts`, then flag `needs_human` rather than shipping a flawed frame.

`shotSpec` (`packages/artgen/src/prompts.ts:508`) already carries `framing` into that spec
(`prompts.ts:527`), and `shotDescription` already states it to the reviewer:
`` `A single ${shot.framing} shot set in ${shot.location}.` `` (`prompts.ts:491`).

**So this repository is at VERTIGO's position: a framing loop judged by VLM opinion rather than by
measurement.** The missing piece is not an architecture. It is a function that takes a rendered frame
and the shot's cast and returns a measured shot scale.

### The `framing` enum should stay, and there is a repo-specific reason

`framing: 'wide' | 'medium' | 'close' | 'establishing'`
(`packages/types/src/entities.ts`) is well supported by everything in Section 3 — every camp converges
on a small closed vocabulary, and classifiers exist for discrete labels and not for continuous camera
parameters.

There is a second argument specific to this codebase. The framing value becomes prompt text directly
(`prompts.ts:403`), and **that prompt string feeds the content-addressed task key**. A continuous
camera parameterisation would make every task hash a function of floating-point numbers, so two
visually identical shots at 0.4999 and 0.5001 would render twice. **The enum is load-bearing for the
dedup and cost model, not only for authoring** — which is a stronger reason to keep it than the
literature alone provides.

### Four changes, in order of value

1. **Add a geometric framing check to the P7 loop.** A person detector, bounding-box height over frame
   height, and a projection from the four-value enum onto the three-class close/medium/long axis
   (`close`→close, `medium`→medium, `wide` and `establishing`→long). This makes the framing verdict
   arithmetic rather than opinion, and it is the unclaimed ground identified in Section 6. **Shot scale
   is the one property that survives the stylised-art domain gap** (Section 3), which is why this
   change is worth making and the camera-geometry equivalent is not.
2. **Promote camera angle and level from free text to enums — but do not expect to verify them.**
   `shot.camera` currently absorbs both unvalidated (`prompts.ts:495`), and the five-class angle and
   six-class level vocabularies are the right ones to adopt. **The verification argument for doing so
   does not survive the domain gap**, though: those classifiers reach >95% on live-action and **0.61
   and 0.68 F1 on animation**, which is too weak to gate on. Adopt the enums for authoring
   consistency, prompt derivation and dedup — not because a checker can police them.
3. **Consider the `wide`/`establishing` conflation.** `establishing` is a narrative role, not a shot
   scale — it means "a long shot used to open a scene". Keeping the enum as authored while defining the
   projection above for verification purposes resolves this without a migration.
4. **Keep camera separate from subject in the prompt schema.** The existing chunking already does
   this, which matches MotionCtrl's appearance-free camera axis. Worth preserving deliberately rather
   than by accident.

Toric space and a 3D blocking stage — the Architecture C material — connect to the proposal already
sketched in [`comparable-systems.md`](comparable-systems.md), and should follow the measurement work
rather than precede it.

### Inserting the cast into a rendered plate: not yet, and the seam is already there

The workflow in
[Inserting a character into an existing plate](#inserting-a-character-into-an-existing-plate) maps onto
slots this repository already has. A `plate:` is base art for a location and a `shot:` is a frame, so
"render the plate once, insert the cast per shot" is a change to what a `shot_image` task *does* rather
than a change to the slot graph. **Three facts about the current code make the change smaller than it
looks, and one makes it larger.**

**The plate already leads every shot's references.** `shotInputs` in `packages/artgen/src/prompts.ts`
resolves the plate the shot is set in plus each subject's portrait or sheet, and the plate comes first
in the reference list. The planner passes `[locAsset, ...subjectRefs]`. So the model is already being
shown the plate; the difference is only whether it is asked to *preserve* those pixels or to take them
as guidance.

**The provider seam for it exists and is nominal.** `ImageProvider` in
`packages/types/src/providers.ts` declares both `generate(prompt, refs, params)` and
`edit(base, prompt, refs, params)`, and `runModelSheet` already uses the edit shape while
`makeShotRunner` calls `generate`. But the Gemini backend implements `edit` as
`run([base, ...refs], prompt, params)` — the base image is just prepended to the references, so the two
entry points are the same call. **Switching a shot to "edit" today would change nothing about what the
model receives.**

**What is missing is the mask.** `ImageParams` carries `modelId`, `aspect`, `seed` and `extra`, and
there is no mask field anywhere. That is not an oversight to correct casually: the default image model
is `gemini-2.5-flash-image`, and **the Gemini image API has no binary mask parameter at all** — its
documented inpainting is conversational. Getting a real mask means a second backend, which means the
API table above becomes a procurement decision rather than a config change.

**The argument against doing it now is the evidence, not the plumbing.** The one benchmark that
measures this task scores a strong Apache-2.0 editor at 5.16 where it scores 8.35 on the same character
without a plate. Latent-mask compositing is measured to damage the region it was told not to touch, and
the pipeline's own asset store would then hold plates that quietly differ shot to shot — which is worse
for provenance than re-deriving each frame, because the drift is invisible rather than expected. **No
published method, dataset or benchmark targets illustrated-foreground-into-illustrated-background**, and
the identity metric a pipeline would naturally reach for is anti-correlated with human judgement on
vector art. The practitioners who make this work end with a paint-program composite onto an untouched
plate, which is not something a generative pipeline can do for them.

**One cheap experiment is worth running before any of this.** The current path already hands the model
the plate as reference zero. Measuring how much the background actually drifts across a scene's shots
under that arrangement — same plate, same seed, varying subjects — costs one small run and tells you
whether background instability is a real problem here or a hypothetical one. **The published evidence
does not support adopting insertion; it does support measuring the thing insertion would fix.**

---

## What remains unverified

Listed so that nothing here is mistaken for a settled fact.

**Resolved since first draft.** The anime domain-gap question — previously the highest-value unread
item here — is answered in Section 3 from the University of Brescia repository's raw OAI-PMH record:
shot scale holds at about 0.80 F1 on animation while camera angle and level fall to 0.61 and 0.68.
**What is still open about that paper** is its full text, which is paywalled with no open-access
location, so ⚠️ **whether it reports any zero-shot cross-domain baseline is unknown** — the fine-tuned
numbers above are all that the abstract and project page give. The authors' anime dataset and model
are offered through OSF, and ⚠️ **what those repositories actually contain could not be enumerated**
(the OSF API returned 401/404 to an unauthenticated fetcher).

**Unverified specifics:**

- **Toric space's primary PDFs are still unread** — HAL's Anubis gateway and the ACM and Eurographics
  libraries all refused. The parameterisation and spindle-torus construction in Section 3 come from
  citing papers rather than the originals, and those citing papers **disagree about the degrees of
  freedom** (6D→2D against 7DOF→4DOF), so do not quote a single DOF figure without the paper in hand.
- **MovieAgent's per-dimension sub-scores**, **CineMaster's Table 2 column labels**, and
  **Director3D's `{r, t, f, p}` dimensionality**.
- **Evaluation metrics** are unnamed in the abstracts of CCD, CameraCtrl, CameraCtrl II, MotionCtrl,
  Director3D, CineMaster and CameraAnything.
- **MovieNet shot-scale classifier accuracy**, and **CineTechBench** per-dimension class counts.
- **LSMDC** was not verified at all.
- **Depth-condition-to-lighting leakage** has no published support in either direction, and the
  inverted-depth ablation that would settle it appears never to have been run.
- **The scale-ambiguity consequence** — that a close-up of a large object and a wide shot of a small
  one condition identically — is unmeasured, and it is the assumption most worth testing early.
- **The 2D-versus-3D classification of LaRender and VODiff** in the SeeThrough3D table rests on their
  titles and method descriptions rather than a verbatim sentence.
- **The anime classifier paper's full text** is paywalled, so whether it reports a zero-shot
  cross-domain baseline is unknown.

**Resolved since the last pass:** every venue in the proxy-conditioning section is now confirmed from
DBLP — Neural Assets NeurIPS 2024, Build-A-Scene ICLR 2025 (OpenReview `gg6dPtdC1C`), Diffusion
Handles CVPR 2024, **Generative Rendering CVPR 2024**, **LooseControl SIGGRAPH 2024** (article 102).
Camera representations are read from the bodies rather than the abstracts (Section 3). MovieAgent's
camera settings are free-form natural language, neither discrete nor continuous.

**The four intuitive arguments for a 3D proxy, checked one at a time.** An earlier draft said none of
them was quantified anywhere. That was too broad, and three of the four do not survive it:

| Argument for a 3D proxy | Status |
| --- | --- |
| Occlusion ordering | **Measured, repeatedly.** SeeThrough3D scores pairwise depth ordering against ground truth on 3D-box proxies specifically; OcclusionFormer ([2605.21343](https://arxiv.org/abs/2605.21343)) reports occlusion-order F1 0.78 and depth-order WHDR 0.16; LayerBind ([2603.05769](https://arxiv.org/abs/2603.05769)) reports UniDet-Depth and an occlusion-relation VQA score |
| Perspective consistency | **Split.** Vanishing points are measured — ControlVP ([2512.07504](https://arxiv.org/abs/2512.07504)) reports angular accuracy AA@3°/5°/10° of 0.731/0.826/0.910. **The horizon line specifically is not measured anywhere found** |
| **Character scale across shots** | **The gap is real.** This one survives |
| Scene reuse across shots | **Measured by proxy, never geometrically.** MEt3R ([2501.06336](https://arxiv.org/abs/2501.06336)) measures multi-view consistency by dense reconstruction and warping, but for novel views of one scene rather than a re-authored camera; CANVAS uses an LLM judge over architectural elements (4.88/5) rather than geometry |

**Character scale consistency across shots is the clean gap, and the story-visualisation benchmarks
show exactly how it went missing.** ViStoryBench's CIDS pipeline crops character regions with
Grounding DINO, embeds the crops, and compares them by cosine similarity — **the bounding boxes are
computed and then discarded, with no area or scale term.** CANVAS scores facial identity, clothing and
hair; CharaConsist (ICCV 2025) scores masked CLIP similarity. Every one of them measures _who_ and
none measures _how big_. The closest thing to an acknowledgement is prose: **Setting the Stage**
([2512.12598](https://arxiv.org/abs/2512.12598)) observes that "the person is rendered at
approximately the same height as the adjacent chair, which is clearly implausible" — and does not
quantify it. Its judge rubric goes further in the wrong direction, explicitly instructing the model
not to penalise "zoom/rotation, and moderate viewpoint changes."

**For this repository that is the load-bearing finding**, because a VN's characters recur across shots
at authored scales, and nothing in the literature will tell you whether a given route holds them
steady.

> **A correction to an earlier draft's flag.** LVLM-Composer
> ([2507.04152](https://arxiv.org/abs/2507.04152)) was flagged here as carrying no institutional
> affiliation. **That is false** — the rendered HTML title block reads "Affiliation: Northern Caribbean
> University". The error came from reading the arXiv `/abs` page, which shows affiliations for no paper
> at all. The citation remains unused in this survey, but not on that ground.

**On inserting a character into an existing plate.** The section added for that workflow rests on
several things that could not be confirmed:

- **Ideogram's own API pricing table** could not be read — the pricing page returns a Cloudflare
  challenge to a non-browser fetcher. The per-render figures quoted are the resellers' (fal and
  Replicate), and **the surcharge for a character reference is not published anywhere found**.
- **Every Adobe Firefly pricing and legal page timed out** behind a WAF. Firefly's composite endpoints
  are the only hosted API with explicit `harmonization` and `shadowIntensity` controls, so its cost and
  its output-rights terms are the largest unpriced item in that table.
- **OpenAI's per-image price rows** for `gpt-image-1.5` and `gpt-image-1.5-mini` were not read; only
  the token rates for `gpt-image-2` were.
- **The illustrated fraction of every benchmark used here is unknown.** KontextBench, PIE-Bench,
  MuLAn-LAION and OmniContext do not report a style breakdown, so "these numbers are photographic" is
  an inference from their sources rather than a published statistic.
- **LASAGNA's dataset and benchmark are announced, not released**, so the one layered system that takes
  a given foreground into a given background cannot be checked.
- **The absence claims about illustrated composition are bounded by an access hole.** All of Reddit was
  hard-blocked to the research (r/comfyui, r/StableDiffusion and r/RenPy went unsampled), Lemma Soft
  Forums returned 403, two anime-compositing write-ups returned 403, and **no Japanese-language search
  was run at all** — which is the language the relevant practitioner community most likely writes in.
- **No "one in N generations is usable" figure exists** for character insertion into a plate, in either
  the literature or the practitioner sources reached. The two-to-four-times figure in
  [What the practitioner community actually does](#what-the-practitioner-community-actually-does) is
  for whole-frame generation and **should not be assumed to transfer**.
- **Reported human-correlation numbers for HarmonyIQA and DreamBench++ vary between secondary sources.**
  The figures quoted here are the ones that appeared in the papers' own abstracts or tables; ⚠️ where a
  survey restated them differently, the discrepancy was not resolved.
- **Pixel drift on Qwen-Image-Edit is unquantified.** Both GitHub threads describing it are open with no
  maintainer reply, and no measurement of the shift in pixels was found.

**On method.** Web-search budget was exhausted early, so discovery relied on direct fetches and
structured APIs (arXiv, DBLP, Semantic Scholar, GitHub, HuggingFace, Civitai). **Absence of evidence
in this document is therefore weaker than a complete literature sweep would justify** — most of all
for the depth-to-lighting question and for anything published after mid-2024 in the 2D-layout family.

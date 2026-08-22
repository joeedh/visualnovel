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
- [Where the inference runs](#where-the-inference-runs)
  * [One question partitions the market](#one-question-partitions-the-market)
  * [Which image APIs expose structural control](#which-image-apis-expose-structural-control)
  * [The FLUX licence constraint](#the-flux-licence-constraint)
  * [Hosted ComfyUI runners](#hosted-comfyui-runners)
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

⚠️ The Toric coordinate parameterisation and the spindle-torus construction are **not verified here** —
the HAL repository blocked every fetch route. The claims above come from abstracts. Anyone
implementing this should read the paper rather than trusting a secondhand description of its
mathematics.

**The Prose Storyboard Language** (Ronfard, Gandhi, Boiron, Murukutla;
[arXiv:1508.07593](https://arxiv.org/abs/1508.07593), and WICED 2022) is a formal language "for
describing movies shot by shot, where each shot is described with a unique sentence," using "a simple
syntax and **limited vocabulary** borrowed from working practices in traditional movie-making,"
readable by machines and humans, and "designed to serve as a high-level user interface for intelligent
cinematography and editing systems." That is a specification for the authoring surface a shot-framing
system should expose. Cite the four-author v5; v1 had three authors.

> **A correction worth carrying:** DCCL is **Christianson et al., AAAI 1996**
> ([AAAI library](http://www.aaai.org/Library/AAAI/1996/aaai96-022.php)), not Bares and Lester. Both
> lines exist and are different. Bares and Lester's constraint-based work is real and separate — see
> "Virtual 3D camera composition from frame constraints", ACM Multimedia 2000.

### The evidence says use a small discrete vocabulary

This is the clearest one-sided finding in the survey. Every camp independently converges on a small
closed set of shot descriptors rather than continuous camera parameters:

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

| Property | Classes | Accuracy | Source |
| --- | --- | --- | --- |
| Shot scale | **3** — close, medium, long | **~94% overall** | Savardi, Signoroni, Migliorati, Benini, ICIP 2018, [doi:10.1109/ICIP.2018.8451474](https://doi.org/10.1109/ICIP.2018.8451474) |
| Camera angle | **5** — overhead, high, neutral, low, dutch | **>95% weighted P/R** | Savardi, Kovács, Signoroni, Benini, IMX Workshops 2023, [doi:10.1145/3604321.3604334](https://doi.org/10.1145/3604321.3604334) |
| Camera level | **6** — aerial, eye, shoulder, hip, knee, ground | **>95% weighted P/R** | as above |

The shot-scale model was trained and tested on the full filmographies of six directors — Scorsese,
Godard, Tarr, Fellini, Antonioni, Bergman — **120 films analysed second by second**. The angle and
level models used **over 24,000 images** and work "even when frames do not prominently feature the
human figure." Models, annotation tooling and frame data are offered through the group's project page
at [cinescale.github.io](https://cinescale.github.io/).

Two caveats that matter for a stylised pipeline. **These numbers are on live-action film frames**, and
an illustration-domain gap is likely. The same group published "Automatic Indexing of Virtual Camera
Features from Japanese Anime" (ICIAP Workshops 2022,
[doi:10.1007/978-3-031-13321-3_17](https://doi.org/10.1007/978-3-031-13321-3_17)) — which is exactly
the paper that would settle it — and ⚠️ **its abstract is elided by the publisher and could not be
read.** That is the highest-value unread item in this survey. Second, **94% on three classes means
roughly one verdict in seventeen is wrong**, so a classifier belongs in a system as a flag for human
review, not as an automatic reject gate.

**MovieNet** ([movienet.github.io](https://movienet.github.io/), ECCV 2020) annotates shot scale in
**five** classes — extreme close-up, close-up, medium, **full**, long — and shot movement in four. Note
it is *full shot*, not "extreme long", and **MovieNet does not annotate camera angle at all.**

> **Name corrections in this area.** **CineScale is a project and dataset, not a paper** — cite the
> underlying ICIP 2018 and IMX 2023 papers. **"AVE" could not be located** as any cinematography
> dataset and may be a misremembering; nothing was substituted for it. **DirectorLLM**
> ([arXiv:2412.14484](https://arxiv.org/abs/2412.14484)) orchestrates **human poses**, not cameras,
> and does not belong in a shot-listing citation list.

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

> ⚠️ **Do not attribute Plücker embeddings to CameraCtrl.** Its abstract says only "camera trajectory
> parameterization". Of the papers checked, only CameraAnything verifiably uses Plücker rays. More
> broadly, **almost none of these abstracts name an evaluation metric** — CCD, CameraCtrl, CameraCtrl
> II, MotionCtrl, Director3D, CineMaster and CameraAnything all say "extensive experiments" without
> naming one. Any FID, FVD or pose-error figure attributed to them should be treated as unsourced
> until someone reads the body.

### The LLM film agents are weakly evidenced

**FilmAgent**'s entire evaluation is **15 ideas, 4 aspects, human raters, mean 3.98 out of 5**, and its
architectural claims rest on that. Its cinematographer agents apply "shot usage guidelines" through a
debate-and-judge stage with **no geometric validation of any kind** — no collision check, no
visibility check, no camera-to-actor geometry. **MovieAgent**
([2503.07314](https://arxiv.org/abs/2503.07314)) claims state of the art on script faithfulness,
character consistency and narrative coherence without defining a metric in its abstract; ⚠️ whether
its camera settings are discrete or continuous **could not be resolved** and is the most useful open
question in this area.

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

| Method | Layout control | Object accuracy | mIoU |
| --- | --- | --- | --- |
| Build-A-Scene | 3D boxes, interactive | **55.3%** | **0.772** |
| Layout-Guidance | **2D layout** | 48.2% | — |
| LooseControl | 3D boxes, non-interactive | **24.3%** | 0.633 |

Read carefully, this does not say what the framing predicts:

1. **3D box conditioning on its own is markedly worse than 2D layout control** — 24.3% against 48.2%,
   roughly half. Going 3D is not free accuracy.
2. **The 3D win is modest and conditional** — about seven points, and only with Build-A-Scene's extra
   interactive machinery on top. **The dimensionality of the layout is not what bought the accuracy;
   the machinery around it was.**
3. Build-A-Scene positions its own contribution as **editability**, not placement accuracy.

⚠️ These are the authors' own numbers against baselines they chose, and **the same author (Wonka)
co-authors both Build-A-Scene and the LooseControl baseline that scores 24.3%.** Layout-Guidance was
not independently verified — it appears only as a row in that table. Treat the margin as weaker than
it looks.

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
specific datasets. ⚠️ The downstream consequence one would expect — that a close-up of a large object
and a wide shot of a small one produce identical conditioning — **is not measured anywhere found.**
For a shot-framing system this is exactly the wrong thing to be unmeasured, since shot scale is the
deliverable. Anyone building on depth conditioning should test it early.

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
| **Stability AI** | Endpoints exist (`/v2beta/stable-image/control/{structure,sketch,style}`) | ⚠️ **unverified** — docs are behind a Cloudflare-fronted SPA | ⚠️ unverified |
| **BFL direct** | **No** — no canny/depth path in the live OpenAPI | `input_image`…`input_image_8` | FLUX.2 [pro] from $0.03 |
| **OpenAI** | **No** | `image`, `mask`, `input_fidelity`. **No seed** | token-metered, $30/M out |
| **Google Gemini** | **No** | aspect ratio, up to 14 references | 2.5 Flash **$0.039**; 3 Pro **$0.134** |
| **Recraft** | **No** — `controls` holds colour and style only | `controls.{colors, artistic_level}` | V4.1 $0.035 |
| **Ideogram / Luma** | **No** | style and character references, weights | ⚠️ Ideogram unverified; Luma Uni-1 $0.0404 |

Three specifics worth knowing before committing. fal's `flux-general` says "**Only one controlnet is
supported at the moment**", so depth and pose together is not available — and its billing **rounds up
to the nearest megapixel**, so a 1920×1080 render bills as 3 MP and triples the unit cost. Replicate's
FLUX control models expose only `guidance`, so **control strength is not directly dialable**, which
matters for a validation loop that wants to retry a shot with more structural adherence. OpenAI
documents **no seed parameter at all**, which is disqualifying on its own for a content-addressed
resumable pipeline.

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
| **Comfy Org Cloud** | ⚠️ API reference not locatable | Preinstalled set only; **no model upload** | $16–$80/mo, concurrency capped at 1–5 |
| **Modal / fal / Baseten** | Not natively — you own the container and HTTP surface | Yours | $10.84–$21.94 (Modal L40S–H100) |

**RunPod Serverless is the only verified option combining per-request arbitrary graphs with arbitrary
node packs.** ComfyICU has the cleanest API and forbids custom nodes entirely, which is an easy thing
to discover too late. Comfy Org does ship hosted products, which many readers will not expect, but its
cloud accepts no uploaded model files and caps concurrency by tier, so a batch of shots serialises.

⚠️ **Not one service in this survey publishes a cold-start figure.** RunPod names FlashBoot,
ComfyDeploy claims "Optimized Cold-Start", Baseten documents `min_replica` — all qualitative. Cold
start is the largest unmodelled term in the cost figures above, and it has to be measured rather than
read.

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
and probably Stability have it; of those only fal exposes a conditioning **scale**, which a validation
loop needs in order to retry with more structural adherence. The licence puts self-hosting FLUX [dev]
control weights out of reach for a shipped product while calling a host does not. And a roughly $50
delta across an entire project does not justify owning a Docker build, a weight cache, a queue and an
unmeasured cold-start problem.

**The strongest argument against it deserves stating in full, because it is not weak.** fal is a single
vendor that has already deprecated `flux-pro/v1/canny` — a control endpoint, killed — and cannot stack
depth with pose. The industry direction is visibly *away* from control maps: BFL removed structural
endpoints from its own API in favour of multi-reference editing, and Google, OpenAI, Recraft, Ideogram
and Luma never had them. There is no portability story, because `controlnets[].conditioning_scale` is
fal's schema rather than a standard, so migrating means rewriting the rendering layer. **The honest
alternative is RunPod Serverless with `worker-comfyui`** — arbitrary graphs, arbitrary nodes, and
cheaper — which trades those risks for a Docker and CI story, an unmeasured cold start, and a licence
problem with no clean answer: running FLUX [dev] control weights in your own container for a commercial
product is precisely what the non-commercial licence forbids, and escaping to Apache-2.0 [schnell] or
Qwen-Image means giving up the control ecosystem that motivated the stack.

### What could not be verified here

**Salad** returned HTTP 403 on every page, so nothing about it is known. **Stability's** control
parameters and pricing are unverified — the endpoints were confirmed to exist by a 401-versus-404
probe, but the widely-repeated `control_strength` parameter name is **not confirmed**.
**ComfyDeploy's** pricing pages 404. **Comfy Cloud's** API reference could not be located, and its own
two pages disagree on the entry price ($16 versus $20). **Cold-start latency** is unpublished
everywhere. **Numeric VRAM requirements** are unpublished everywhere. **ControlNet checkpoint file
sizes**, **Ideogram's per-image price**, and the licence terms for Recraft, Ideogram and Luma were not
obtainable. Local hardware and electricity costs were deliberately not estimated.

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
   arithmetic rather than opinion, and it is the unclaimed ground identified in Section 6.
2. **Promote camera angle and level from free text to enums.** `shot.camera` currently absorbs this
   unvalidated (`prompts.ts:495`). The verified five-class angle and six-class level vocabularies both
   have **>95%** classifiers behind them, so this converts an uncheckable string into two checkable
   fields.
3. **Consider the `wide`/`establishing` conflation.** `establishing` is a narrative role, not a shot
   scale — it means "a long shot used to open a scene". Keeping the enum as authored while defining the
   projection above for verification purposes resolves this without a migration.
4. **Keep camera separate from subject in the prompt schema.** The existing chunking already does
   this, which matches MotionCtrl's appearance-free camera axis. Worth preserving deliberately rather
   than by accident.

Toric space and a 3D blocking stage — the Architecture C material — connect to the proposal already
sketched in [`comparable-systems.md`](comparable-systems.md), and should follow the measurement work
rather than precede it.

---

## What remains unverified

Listed so that nothing here is mistaken for a settled fact.

**The highest-value unread source** is "Automatic Indexing of Virtual Camera Features from Japanese
Anime" (ICIAP Workshops 2022, [doi:10.1007/978-3-031-13321-3_17](https://doi.org/10.1007/978-3-031-13321-3_17)),
whose abstract the publisher elides. It is the paper that would say whether the ~94% shot-scale
classifier survives the jump from live-action film to stylised illustration — the single assumption
Architecture A's validation loop rests on.

**Unverified specifics:**

- **Toric space's coordinate parameterisation and spindle-torus construction.** HAL blocked every
  fetch route. Only the abstract-level claims are sourced.
- **Whether MovieAgent's camera settings are discrete or continuous.**
- **Camera representation** is unstated in the abstracts of CCD, E.T., CameraCtrl, CameraCtrl II and
  Director3D; **evaluation metrics** are unnamed in the abstracts of CCD, CameraCtrl, CameraCtrl II,
  MotionCtrl, Director3D, CineMaster and CameraAnything.
- **Venues** for Generative Rendering and LooseControl; the two research passes disagreed about
  whether Neural Assets (NeurIPS 2024), Build-A-Scene (ICLR 2025) and Diffusion Handles (CVPR 2024)
  were confirmed, and the disagreement is unresolved.
- **MovieNet shot-scale classifier accuracy**, and **CineTechBench** per-dimension class counts.
- **LSMDC** was not verified at all.
- **Depth-condition-to-lighting leakage** has no published support in either direction.
- **The scale-ambiguity consequence** — that a close-up of a large object and a wide shot of a small
  one condition identically — is unmeasured, and it is the assumption most worth testing early.

**Unmeasured comparisons that a survey could easily imply are settled:** occlusion ordering,
perspective and horizon consistency, character scale consistency across shots, and scene reuse across
frames. These are the intuitive arguments for a 3D proxy and **not one of them is quantified in any
source found.**

**One citation to avoid.** LVLM-Composer ([2507.04152](https://arxiv.org/abs/2507.04152)) surfaced
claiming composition-fidelity validation, but its author list carries no institutional affiliation and
the paper has paper-mill characteristics. It should not be cited without independent scrutiny.

**On method.** Web-search budget was exhausted early, so discovery relied on direct fetches and
structured APIs (arXiv, DBLP, Semantic Scholar, GitHub, HuggingFace, Civitai). **Absence of evidence
in this document is therefore weaker than a complete literature sweep would justify** — most of all
for the depth-to-lighting question and for anything published after mid-2024 in the 2D-layout family.

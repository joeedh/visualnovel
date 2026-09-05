# Visual Novel Generator — System Design Report

<!-- toc -->

- [Where this report differs from what shipped](#where-this-report-differs-from-what-shipped)
- [1. Goals and guiding principles](#1-goals-and-guiding-principles)
- [2. The big picture: pipeline phases](#2-the-big-picture-pipeline-phases)
- [3. Core data model](#3-core-data-model)
- [4. Phase detail](#4-phase-detail)
    - [P0 — Ingestion & parsing](#p0--ingestion--parsing)
    - [P1 — Location extraction & breakdown](#p1--location-extraction--breakdown)
    - [P2 — Location reference shots](#p2--location-reference-shots)
    - [P3 — Character design + human approval gate](#p3--character-design--human-approval-gate)
    - [P4 — Model sheets (turnarounds) = the default outfit](#p4--model-sheets-turnarounds--the-default-outfit)
    - [P5 — Scene & shot decomposition](#p5--scene--shot-decomposition)
    - [P6 — Shot prompt synthesis](#p6--shot-prompt-synthesis)
    - [P7 — Generate → critique → refine loop (≤ 4 iterations)](#p7--generate-%E2%86%92-critique-%E2%86%92-refine-loop-%E2%89%A4-4-iterations)
- [5. Consistency strategy (the hard part), summarized](#5-consistency-strategy-the-hard-part-summarized)
- [6. Modeling the branching screenplay](#6-modeling-the-branching-screenplay)
- [7. Task graph & deduplication](#7-task-graph--deduplication)
- [8. Gemini integration & the asset store](#8-gemini-integration--the-asset-store)
- [9. Proposed directory layouts](#9-proposed-directory-layouts)
    - [9.1 Input (authored by the user)](#91-input-authored-by-the-user)
    - [9.2 Generated (produced by the system)](#92-generated-produced-by-the-system)
- [10. Execution model, state & resumability](#10-execution-model-state--resumability)
- [11. Key risks & open questions](#11-key-risks--open-questions)
- [12. Suggested implementation stack (non-binding)](#12-suggested-implementation-stack-non-binding)
- [13. End-to-end summary](#13-end-to-end-summary)

<!-- tocstop -->

Scope: this report covers a pipeline that turns written character descriptions, an
optional set of reference images, a branching screenplay, and optional location
descriptions into a complete set of generated visual-novel art assets (backgrounds,
character sprites/portraits, and per-shot composited images), plus the structured markdown
"source of truth" (the canonical description the assets are generated from) that drives
them. **Out of scope (per request):** this report does not cover the final export into a
specific VN engine (Ren'Py, Naninovel, TyranoBuilder, etc.). It stops at a clean,
well-organized library of generated images and metadata that an export step could later
consume.

---

## Where this report differs from what shipped

This is the original design report, kept as written. The architecture it proposes is the
one that got built, but nine specifics came out differently once implemented. For the
invariants as they actually hold today, read
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md); the list below
records only the differences.

| Report says                                                                                                | Shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4 P4 — outfit sheets generated on demand for non-default clothing                                         | Not built. `outfit_sheet` is a declared `TaskKind` whose runner is `unsupported(...)`.                                                                                                                                                                                                                                                                                                                                                                                |
| §7 — `vision_review` and `prompt_refine` as separate task nodes                                            | Folded into the `shot_image` runner, so one task node makes several API calls. `TaskAttempt[]` still records each iteration.                                                                                                                                                                                                                                                                                                                                          |
| §5.4, §4 P6 — a shared "style anchor" image threaded through every generation                              | Not built. Style consistency rests on `config.art_style` in the prompt preamble (`stylePreamble`) alone.                                                                                                                                                                                                                                                                                                                                                              |
| §4 P2, §5.3 — generate one location plate, then _edit_ it for each variant                                 | Each variant is generated fresh, from the prompt, with `refs: []` (`planner.ts:150-158`).                                                                                                                                                                                                                                                                                                                                                                             |
| §3, §4 P5 — Shot blocks live inside the scene's markdown file                                              | Shots are persisted separately as `work/shots/<sceneId>.json`, authored fields at top level and run output under `shotData`.                                                                                                                                                                                                                                                                                                                                          |
| §9.2 — `character.resolved.md`, `build/shots/`, `state/cache.sqlite`                                       | None exist. Shots live under `work/`, not `build/`; there is no sqlite cache — `state/tasks.jsonl` replayed _is_ the cache.                                                                                                                                                                                                                                                                                                                                           |
| §4 P7 — a hard cap of 4 refine iterations                                                                  | Configurable: `config.max_refine_attempts`, which defaults to 4.                                                                                                                                                                                                                                                                                                                                                                                                      |
| §9.1 — the screenplay is one authored `screenplay/screenplay.fountain`                                     | Authored input is **one file per scene**: `scenes/<id>.md`, `scene: <id>` front-matter over a one-scene Fountain body, entry named by `start:` in `project.yaml`. The single-file form is no longer read: `vngen import` converts one, `vngen screenplay` projects the chunks back out, and a project still holding one is told to import it. See [`../reference/fountain.md`](../reference/fountain.md#one-fountain-file-in-and-out-project-specific).               |
| §3, §4 — a character's `reference_images:` front-matter, and §4 P7's per-phase `reference_images` argument | The front-matter key was storage for a feature nothing ever read and is **retired**: a file still setting it gets a `retired_reference_images` diagnostic naming the paths, and the serializers drop the key. Reference images are now attached to a prompt **clause** instead — `prompt.addRef`, with `asset.upload` bringing outside bytes in as a `reference` asset. See [`../plans/archive/INDEX.md#chunked-prompts`](../plans/archive/INDEX.md#chunked-prompts). |
| §3, §4 P5, §9.2 — `scenes/<id>.md` is a _generated_ file under `work/`                                     | Inverted: `scenes/<id>.md` is now the **author's** file at the project root, and there is no `vngen/work/scenes/` at all. What P5 produces is `work/shots/<sceneId>.json` (previous row).                                                                                                                                                                                                                                                                             |

One thing the report holds out of scope has since been partly built, in a narrower form
than it warns against. There is no external-engine export, but there is a small in-house
playable (`story.play.json`) and a desktop runner — see
[`../reference/playable-format.md`](../reference/playable-format.md).

---

## 1. Goals and guiding principles

1. **Determinism where possible, AI where necessary.** Parsing, deduplication, directory
   layout, and task scheduling are deterministic code. Only the genuinely generative steps
   (prose → prompt refinement, image synthesis, image critique) call out to LLMs/image
   models.
2.  2. **Every artifact is written to disk.** Every intermediate artifact — location
       breakdowns, scene files, shot descriptions, prompts, and a manifest of every
       generated image — is stored on disk as human-readable markdown/JSON. The user can
       inspect these files, hand-edit them, and re-run. Storing artifacts this way makes
       the system debuggable and gives the user control.
3.  3. **Human approval gates.** A human approves the character "look" before the
       expensive downstream work (model sheets, then thousands of shots) is committed.
       Approval is tracked as an explicit state.
4.  4. **Consistency is the central engineering problem.** A visual novel succeeds only if
       the same character looks like the same character across hundreds of shots. Almost
       every design decision below serves consistency.
5. **Never do the same generative work twice.** A global, content-addressed task graph
   dedupes identical requests and makes the whole pipeline resumable and incremental.

---

## 2. The big picture: pipeline phases

```
            ┌────────────────────────────────────────────────────────────┐
   INPUT    │  characters/*.md   screenplay.(md|fountain)   locations/*.md │
            │  reference images (optional)                                 │
            └───────────────────────────┬────────────────────────────────┘
                                         │
   P0  Ingest & parse ──────────────────┤  build in-memory project model
                                         │
   P1  Location extraction ─────────────┤  user locations + mined from script
        & breakdown (markdown)          │  → locations/<loc>/breakdown.md
                                         │
   P2  Location reference shots ────────┤  generative AI → establishing images
                                         │
   P3  Character design ────────────────┤  generative AI → candidate portraits
        + HUMAN APPROVAL GATE  ◀────────┤  user refines / approves "the look"
                                         │
   P4  Model sheets (turnarounds) ──────┤  approved look → multi-angle sheets
        = the "default outfit"          │  (extra outfits generated on demand)
                                         │
   P5  Scene & shot decomposition ──────┤  branching script → scenes → shots
                                         │  scenes/<id>.md, each shot described
                                         │
   P6  Shot prompt synthesis ───────────┤  shot desc → Gemini prompt + ref images
                                         │
   P7  Generate → critique → refine ────┤  Gemini image; re-read w/ Gemini+Claude;
        (loop ≤ 4×)                      │  fix prompt; regenerate
                                         │
            ┌───────────────────────────┴────────────────────────────────┐
   OUTPUT   │  build/ : every approved image + manifest.json + provenance  │
            │  (ready for a future, out-of-scope engine export)            │
            └──────────────────────────────────────────────────────────────┘
```

The following subsystems cut across all phases:

- **Task graph & dedupe** (§7) — the graph holds one node per generative call, and
  identical nodes are merged into one.
- **Asset store & manifest** (§8) — stores images by content address and records their
  metadata.
- **Project state machine** (§9) — tracks what is pending, generated, approved or stale.

---

## 3. Core data model

Holds a small number of entities, each backed by a markdown or JSON file on disk.

| Entity        | Key fields                                                                                                          | Backed by                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Character** | id, name, canonical description, traits, palette, reference image paths, **approval state**, default outfit id      | `characters/<id>/character.md` + front-matter |
| **Outfit**    | id, owner character id, description, model-sheet image set                                                          | `characters/<id>/outfits/<outfit>.md`         |
| **Location**  | id, name, description, mood/lighting, time-of-day variants, reference image set                                     | `locations/<id>/breakdown.md`                 |
| **Scene**     | id, location ref, characters present, narrative beat, **graph edges** (choices → next scenes)                       | `scenes/<id>.md`                              |
| **Shot**      | id, parent scene, framing, subject(s), pose/expression, camera, dialogue line(s), prompt, chosen image              | a `## Shot` block inside the scene file       |
| **Asset**     | content hash, kind (location-ref / portrait / model-sheet / shot), source task, parent prompt, refs used, accepted? | `manifest.json` entry + file in asset store   |
| **Task**      | content hash (the dedupe key), kind, inputs, status, output asset hash, attempts                                    | `tasks.jsonl` / task DB                       |

**Front-matter convention.** Every markdown file begins with a YAML front-matter header
that holds the stable `id`, status fields, and references to other entities by id. Humans
read the prose body, and it is fed to the LLM; the machine reads the front-matter. Example
character file:

```markdown
---
id: aiko
name: Aiko Tanaka
status: approved # draft | candidates | approved | locked
default_outfit: school_uniform
palette: ["#1b2a4a", "#d98c8c", "#f2e9dc"]
reference_images: # user-supplied, optional
    - input/characters/aiko/ref-face.png
approved_portrait: a3f9c1 # asset hash chosen by the user
---

# Aiko Tanaka

17, third-year student, quietly determined. Shoulder-length black hair with a single
braided strand... [the canonical, authoritative description]

## Wardrobe

- **school_uniform** (default): navy blazer, ...
- **summer_casual**: ...
```

---

## 4. Phase detail

### P0 — Ingestion & parsing

- Load all input files. Accept the screenplay as Fountain (the de-facto plain-text
  screenplay format) or as structured markdown. Fountain suits this step because scene
  headings (`INT./EXT. LOCATION - TIME`), character cues, dialogue, and parentheticals are
  already machine-parseable, which makes location mining and scene splitting much more
  reliable than they are on free prose.
- Standard Fountain is linear, so branching uses an explicit, lightweight convention
  layered on top (see §6), such as labeled `[[choice: ... -> scene_id]]` markers.
- Produce an in-memory project model and validate it (every referenced character exists,
  every choice targets a real scene, etc.). Validation errors are reported before any
  money is spent on generation.

### P1 — Location extraction & breakdown

1. **Collect** explicit locations from `locations/` (user-provided).
2.  2. **Mine** additional locations: an LLM pass over the screenplay scene headings and
       over character descriptions extracts every distinct setting, normalizes aliases
       ("the classroom" == "Class 3-B" == "homeroom"), and proposes a canonical id/name
       for each. The LLM proposes how to deduplicate near-synonyms, and a deterministic
       merge step the user can review follows.
3.  3. For each location, generate a detailed breakdown markdown file containing:
       architecture/geography, key props, color palette, lighting, mood, the time-of-day
       and weather variants that the script actually needs, and camera-friendly notes
       (what a wide establishing shot vs. an interior two-shot would frame). Later
       background generation takes its prompts from this file.
4. The user can edit any breakdown before art is generated.

### P2 — Location reference shots

- For each location (and each needed variant: day/night/rain/etc.), enqueue a generative
  task to produce one or more establishing/reference images.
- These serve two purposes: (a) the user approves the look of the world, and (b) they
  become reference images fed back into Gemini when generating shots set there, which
  anchors background consistency.
- Variants are derived from a single "master" reference via image-editing
  (re-light/re-time the same room) rather than generated from scratch. Editing one
  reference keeps the geometry consistent across times of day.

### P3 — Character design + human approval gate

This is the most important gate in the system.

1.  1. For each character, synthesize a portrait prompt from the canonical description
    - palette (+ any user reference images supplied as Gemini image inputs).
2.  2. Generate N candidate portraits (e.g. 3–4) at a neutral pose/expression on a plain
       background.
3.  3. **Refinement loop with the user:** The user can (a) pick a candidate, (b) request
       tweaks in natural language ("older, warmer eyes, less anime"), which edits the
       prompt and regenerates, or (c) supply or replace a reference image. A person drives
       this loop; it does not iterate automatically.
4.  4. When satisfied, the user approves one portrait. That asset hash is recorded as
       `approved_portrait` and the character's status is set to `approved`. No downstream
       work (model sheets, shots) runs for a character until it is approved, which
       prevents generating a thousand shots of a face the user will reject.

### P4 — Model sheets (turnarounds) = the default outfit

- From the approved portrait, generate a model sheet or turnaround. It shows the same
  character from multiple vantage points (front, 3/4, side, back) and a small set of
  canonical expressions, on a neutral background.
- Feed the approved portrait to Gemini as a reference image and prompt for each angle, so
  that all angles derive from the one approved look. You can assemble a contact-sheet grid
  for the user, but store each angle or expression as its own clean image, because those
  individual images are what get fed as references later.
- This model-sheet set defines the character's default outfit ("school_uniform" in the
  example).
- **On-demand outfits:** when a later scene needs different clothing, the system detects
  it during shot decomposition (§P5) and enqueues a new mini-model-sheet for that
  `(character, outfit)` pair. That mini-model-sheet is generated by editing the default
  model sheet to swap the clothing while preserving the face and body. Outfits are
  first-class, reusable, and cached.

### P5 — Scene & shot decomposition

1.  1. **Split the branching screenplay into scenes.** A scene is a continuous unit at one
       location with a stable cast. Each scene becomes `scenes/<id>.md` with front-matter
       that records the location id, the characters present, and the graph edges to next
       scenes.
2.  2. **Split each scene into shots.** An LLM pass proposes shots. Each shot renders to a
       single image, and its description gives the framing (wide/medium/close), which
       character(s) are visible, pose, expression, what they are wearing (→ outfit id),
       camera angle, time of day, and the dialogue line(s) the shot covers.
3.  Each shot is written as a structured block in the scene file:

```markdown
## Shot s12_03

- framing: medium
- location: classroom_afternoon
- subjects: [aiko (school_uniform, pose: turning, expr: surprised)]
- camera: eye-level, slight left
- covers_lines: [s12.l07, s12.l08]
- prompt: null # filled in P6
- image: null # filled in P7 (asset hash)
- status: pending
```

4.  4. The system also computes the outfit demand and the reference-image needs per shot
       at this stage, which feed the task graph.

### P6 — Shot prompt synthesis

- For each shot, an LLM refines the terse shot description into a full Gemini image prompt
  ("nano banana" is Gemini 2.5 Flash Image), in the model's preferred style: concrete,
  scene-described-as-a-photograph/illustration, explicit about subject placement,
  expression, lighting, and the established art style.
- The prompt is paired with the reference image bundle for that shot:
    - the relevant **character model-sheet angle(s)** for the needed outfit,
    - the **location reference** (correct time-of-day variant),
    - a style anchor image (a previously approved shot or a style key) to hold the
      rendering style steady.
- Gemini 2.5 Flash Image accepts multiple input images and is designed for
  character/subject consistency and targeted edits. The pipeline needs that property.
  Storing the prompt in the scene file keeps the prompt inspectable and hand-tunable.

### P7 — Generate → critique → refine loop (≤ 4 iterations)

This is the automated quality-control loop.

```
for attempt in 1..4:
    image = gemini.generate(prompt, reference_images)
    review_gemini = gemini.vision_check(image, shot_spec, reference_images)
    review_claude = claude.vision_check(image, shot_spec, reference_images)
    issues = merge(review_gemini, review_claude)      # structured defect list
    if issues.none_blocking:
        accept(image); break
    prompt = refine(prompt, issues)                   # targeted prompt edits
# after 4 attempts: mark needs_human, keep best-scoring image
```

- **Two reviewers.** Gemini reviews its own output, which is good for checking whether it
  rendered what the prompt said, and Claude provides an independent check, which is good
  for catching consistency drift against the character description and continuity errors.
  Disagreements are surfaced. The critique is requested as structured output (a JSON list
  of defects with severity and a suggested fix) rather than prose, so the refine step can
  act on it programmatically.
- **What's checked:** The right characters are present and recognizable. The outfit is
  correct. The expression and pose are correct. The location and time of day are correct.
  No limbs or people are duplicated or added. Text is present or absent as intended. The
  framing matches.
- A hard cap of 4 prevents runaway spend. On failure, the shot is flagged `needs_human`
  and the best candidate is retained, so the user can intervene instead of blocking the
  batch.
- Every attempt (prompt, refs, image, both reviews) is logged for provenance and
  debugging.

---

## 5. Consistency strategy (the hard part), summarized

The techniques are consolidated here because they decide whether the result succeeds:

1.  1. **Single approved source per character.** All angles and outfits derive from one
       approved portrait via reference-image editing, and are never re-rolled from text
       alone.
2.  2. **Reference-image bundles on every shot.** Every shot is fed a character
       model-sheet angle, a location reference, and a style anchor. This relies on
       Gemini's multi-image consistency.
3.  3. **Locations: edit a master plate for variants rather than re-generating.**
       Time-of-day and weather variants come from editing a master plate, so the geometry
       stays fixed.
4.  **Style anchor.** A small set of canonical "style key" images keeps the rendering
    style uniform across the whole novel.
5.  **Palette in front-matter.** Explicit per-character/per-location palettes are injected
    into prompts.
6.  6. **The critique loop** (P7) catches drift before an image is accepted.
7.  7. **Seeds where supported.** The manifest records the seed for reproducibility.

---

## 6. Modeling the branching screenplay

A branching screenplay is a directed graph of scenes, not a linear list. A path can return
to a hub, so cycles are possible and the structure is a general digraph, usually a DAG
with occasional back-edges.

- **Representation:** each scene file declares its outgoing edges in front-matter:

```markdown
---
id: s12_rooftop
location: rooftop_sunset
characters: [aiko, ren]
choices:
    - label: "Tell her the truth"
      goto: s13_truth
    - label: "Stay silent"
      goto: s13_silent
# a scene with no choices just declares `next: s13` (linear continuation)
---
```

- **Why a graph matters for generation:**
    - **Enumeration:** The set of "scenes" (graph nodes) is finite, and we generate every
      reachable node once rather than every root-to-leaf path, which can explode
      combinatorially. This is a key cost control, since one shot is generated per node
      and branches share nodes and assets through the dedupe graph.
    - **Reachability check:** Detects dead or unreachable scenes and dangling `goto`s
      during P0 validation.
    - **Shared assets across branches:** Two branches that both visit the classroom at
      dusk with Aiko in her uniform request identical generative work. The task graph (§7)
      collapses them automatically.
- **Visualization:** the system can emit a `story.graph` (e.g. Graphviz/Mermaid) so the
  user can see the branch structure.

---

## 7. Task graph & deduplication

Guarantees that the same generative work is never done twice.

- **Every generative request is a Task node** with a `kind` (`location_ref`, `portrait`,
  `model_sheet`, `outfit_sheet`, `shot_image`, `vision_review`, `prompt_refine`) and a
  fully-specified input set.
- **Content-addressed dedupe key.** Each task is identified by a hash of everything that
  determines its output:

    ```
    task_hash = sha256(
        kind,
        normalized_prompt,
        [ordered reference asset hashes],
        model_id, model_params (seed, aspect, etc.)
    )
    ```

    Two shots in different branches that resolve to the same prompt, the same refs and the
    same params produce the same hash, so there is one task and one image, reused
    everywhere it is referenced.

- **Build order comes from a topological sort.** Tasks depend on upstream assets (a shot
  task depends on the model-sheet task and location-ref task, which depend on the approved
  portrait, which depends on the user gate). The scheduler runs tasks in dependency order,
  runs independent tasks in parallel, and treats each approval gate as a barrier.
- **Status & resumability.** Each task is
  `pending → running → done | failed | needs_human`. Re-running the pipeline skips `done`
  tasks (their output asset already exists in the store). Skipping makes the whole system
  incremental, so editing one location breakdown re-runs only the tasks whose hash
  changed.
- **Staleness / invalidation.** When an upstream artifact changes (the user edits a
  character description, or re-approves a different portrait), every downstream task whose
  hash now differs is automatically marked stale and re-queued. Untouched branches are not
  re-queued.
- **Cost preview.** The full task set is known before execution, so the system can show
  the user "this run will make N new image calls and M vision reviews" and wait for
  confirmation before spending.
- **Storage:** Tasks live in `tasks.jsonl` (an append-only log) or in a small SQLite DB.
  The asset store is content-addressed (`assets/<hash>.png`), so identical outputs are
  physically stored once.

---

## 8. Gemini integration & the asset store

- **Image model:** Gemini 2.5 Flash Image ("nano banana") handles generation and
  reference-guided editing. It accepts multiple reference images and is built for subject
  consistency and localized edits, which are the core capabilities this pipeline depends
  on.
- **Vision review:** the P7 critique is requested from Gemini (its own multimodal
  read-back) and Claude (independent read-back), both with structured JSON output.
- **Text/refinement:** An LLM handles location mining, scene/shot decomposition, and
  prompt refinement. Claude suits the structured-reasoning steps.
- **Key handling:** the user supplies their own Google Gemini API key (and a key for the
  critique LLM). Keys come from env/secret config and are never committed. The manifest
  records which model id produced each asset but not the key.
- **Asset store + manifest:** every accepted image is written to
  `build/assets/<hash>.<ext>` and registered in `build/manifest.json`. Each record carries
  full provenance: source task hash, prompt, reference asset hashes, model id/params,
  review verdicts, and which scene/shot/character/outfit the image satisfies. The manifest
  is the single index a future engine-export step would read.

---

## 9. Proposed directory layouts

### 9.1 Input (authored by the user)

```
my-novel/
├─ project.yaml                 # title, art-style notes, model config, key refs (env names)
├─ characters/
│  ├─ aiko/
│  │  ├─ character.md           # canonical description + front-matter
│  │  └─ refs/                  # OPTIONAL user-supplied reference images
│  │     ├─ face.png
│  │     └─ fullbody.png
│  └─ ren/
│     └─ character.md
├─ locations/                   # OPTIONAL — anything not provided is mined from script
│  ├─ classroom.md
│  └─ rooftop.md
└─ screenplay/
   ├─ screenplay.fountain       # (or .md) the branching script
   └─ choices.md                # optional: branch map if not inline in the script
```

Notes:

- `locations/` is optional, and a missing location is derived (§P1).
- Each character's `refs/` directory is optional. If it is present, P3 passes its images
  to Gemini as image inputs.
- Everything is plain text/markdown + images, so git versions all of it.

### 9.2 Generated (produced by the system)

The project keeps two trees. The **working tree** holds human-readable markdown and
breakdowns, and is the editable "source of truth". The **build tree** holds
content-addressed assets and a manifest, and is the machine output.

```
my-novel/
└─ vngen/                           # all generated data, committed (reproducible run output)
   │
   ├─ work/                         # human-readable, editable intermediate artifacts
   │  ├─ characters/
   │  │  └─ aiko/
   │  │     ├─ character.resolved.md     # merged canonical record + status
   │  │     ├─ candidates/              # P3 portrait candidates for review
   │  │     │  ├─ cand-1.png ...
   │  │     ├─ approved.png             # the user's pick (symlink/copy of asset)
   │  │     └─ outfits/
   │  │        ├─ school_uniform/
   │  │        │  ├─ outfit.md
   │  │        │  └─ sheet/             # turnaround angles + expressions
   │  │        │     ├─ front.png  three_quarter.png  side.png  back.png
   │  │        │     └─ expr-*.png
   │  │        └─ summer_casual/ ...
   │  │
   │  ├─ locations/
   │  │  └─ classroom/
   │  │     ├─ breakdown.md             # P1 detailed breakdown
   │  │     └─ refs/                    # P2 establishing shots, per variant
   │  │        ├─ day.png  afternoon.png  night.png
   │  │
   │  ├─ scenes/                        # P5 — one file per scene (graph node)
   │  │  ├─ s12_rooftop.md              # front-matter (location, cast, choices) + shots
   │  │  └─ s13_truth.md
   │  │
   │  └─ story.graph.mmd                # Mermaid/Graphviz of the branch structure
   │
   ├─ build/                        # machine output — the deliverable
   │  ├─ assets/                    # content-addressed; deduped; one file per unique image
   │  │  ├─ a3f9c1.png
   │  │  └─ 7b21de.png
   │  ├─ manifest.json              # every asset + full provenance + what it satisfies
   │  └─ shots/                     # optional: per-scene index mapping shot id → asset hash
   │     └─ s12_rooftop.json
   │
   └─ state/                        # pipeline bookkeeping
      ├─ tasks.jsonl               # task graph: hashes, status, deps, attempts
      ├─ reviews/                  # P7 critique logs (gemini + claude verdicts per attempt)
      │  └─ <task_hash>/attempt-1.json ...
      └─ cache.sqlite              # optional: fast index over tasks/assets
```

Design choices:

- **`work/` holds hand-edited files and `build/` holds generated ones.** Users edit the
  Markdown under `work/`; `build/assets/` is regenerable and content-addressed.
- **Approval artifacts are explicit** (`candidates/`, `approved.png`), so the approval
  step is visible on disk.
- Outfits nest under the character, and each outfit has its own model sheet. This matches
  the "default outfit + on-demand outfits" model.
- Scenes mirror the screenplay graph, with one file per node. Branches reference shared
  scene ids rather than duplicating the scenes.
- **`state/` makes runs resumable and auditable** — it stores task statuses and the full
  critique history.

---

## 10. Execution model, state & resumability

- **A single `run` command** parses the input, validates it, builds the task graph, shows
  a cost preview, executes up to the next approval gate, and stops. The user approves
  characters and re-runs, and the pipeline continues past the gate.
- **Gates block the topological sort:** a character's model sheets and shots run only once
  that character is `approved`.
- **Incremental by construction:** Task identity is a content hash, so re-running does
  only new or changed work. Editing one shot's description re-runs only that shot's
  prompt, image and review tasks.
- **Idempotent & crash-safe:** the append-only task log and the content-addressed store
  let an interrupted run resume cleanly.

---

## 11. Key risks & open questions

| Risk                                                              | Mitigation / note                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Character drift across shots**                                  | The whole §5 strategy; the P7 critique loop is the backstop. Still the #1 quality risk.     |
| **Style drift** across a long novel                               | Style-anchor reference images + a fixed style spec in `project.yaml`.                       |
| **Cost / token & image spend**                                    | Dedupe graph + cost preview + the hard 4-iteration cap + generate-per-node (not per-path).  |
| **Branch explosion**                                              | Generate per scene node, never per path. Shared nodes dedupe.                               |
| **Location alias confusion**                                      | LLM proposes merges, human confirms in P1.                                                  |
| **Critique false-confidence** (model says it's fine but it isn't) | Two independent reviewers + `needs_human` fallback after 4 tries; keep best candidate.      |
| **Outfit/continuity logic** (who wears what when)                 | Computed during P5 from the script; outfit demand is explicit per shot.                     |
| **Nano-banana text/typography** in images                         | Prefer text-free art; overlay UI text at engine/export time (out of scope here).            |
| **API/model changes**                                             | Model ids and params live in `project.yaml` + manifest; swapping models is a config change. |

---

## 12. Suggested implementation stack (non-binding)

- **Language:** TypeScript or Python. Both have solid Gemini and Anthropic SDKs.
- **Screenplay parsing:** a Fountain parser parses the screenplay, and a thin custom layer
  parses the branch markers.
- **Task graph/state:** SQLite (via a tiny ORM) or append-only JSONL + in-memory DAG.
- **Asset store:** holds content-addressed files on disk. The manifest is JSON.
- **Orchestration:** The scheduler orders work by dependency, caps concurrency at a
  configurable limit, and offers a dry-run/cost-preview mode.
- **Prompts/critique:** Every machine-consumed LLM result comes from a structured-output
  (JSON-schema-constrained) call.

---

## 13. End-to-end summary

1.  1. The author provides characters (with optional refs), a branching screenplay, and
       optional locations.
2.  2. The system parses and validates, mines and writes location breakdowns, and
       generates location reference shots.
3.  3. The system generates character candidates. The user refines and approves the look.
4.  4. Approved looks become model-sheet turnarounds, which cover the default outfit.
       Extra outfits are generated on demand.
5.  5. The branching script is split into scenes (graph nodes), and each scene is split
       into shots. Each shot gets a refined Gemini prompt and a reference bundle.
6.  6. Each shot is generated, double-checked by Gemini and Claude, and prompt-refined up
       to 4×.
7.  7. A content-addressed task graph dedupes all generative work, so the whole pipeline
       is incremental and resumable.
8.  8. Produces a clean `build/` holding the approved images and a provenance manifest. A
       future engine export, which is out of scope here, can consume it.

```

```

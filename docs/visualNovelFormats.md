# A Survey of Visual Novel Formats & Scripting Languages

This document surveys the landscape of **visual novel (VN) scripting languages, authoring
formats, and runtime engines**. Its purpose is to orient this project: we generate
*inputs* (characters, a branching Fountain screenplay, art assets, a provenance manifest)
and deliberately stop short of engine export (see [`vn-generator-report.md`](vn-generator-report.md)).
Understanding the target formats a manifest might eventually be exported *into* — and how
those formats model story, branching, dialogue, and presentation — informs both the shape
of our intermediate representation and any future export work.

A visual novel is, at its core, a **branching script that drives presentation**: it
sequences dialogue and narration over a backdrop of character sprites, background art,
music, and sound, and it offers the reader choices that route through the branch graph.
Every format below is some answer to the same question — *how do you notate that script?*
The answers fall on a spectrum from **prose-first markup** (write mostly text, sprinkle in
directives) to **full programming languages** (the script is a program that happens to
show a story).

---

## How to read this survey

Each format is assessed on a few recurring axes:

- **Paradigm** — plain-text markup, embedded DSL, full scripting language, or visual/node
  editor.
- **Branching model** — how choices and non-linear flow are expressed (labels + jumps,
  gather/weave, node graph, state machine).
- **Presentation coupling** — how tightly the script binds to concrete assets and layout
  (sprite positions, transitions, channels) vs. staying presentation-agnostic.
- **Runtime** — the engine(s) that execute it, and target platforms.
- **Ecosystem** — maturity, tooling, community, licensing.
- **Relevance to this project** — what, if anything, it suggests for our IR or export.

---

## The three broad families

1. **Prose-first screenplay markup.** You write mostly natural text; a small set of
   conventions and inline markers encode structure and branching. Diff-friendly,
   tool-agnostic, LLM-friendly. *Fountain* (as this project extends it), *Markdown-based
   formats*, and *Ink* lean this way.

2. **Dedicated VN scripting languages.** Purpose-built DSLs (often embedded in a host
   language) with first-class notions of *say a line*, *show a sprite*, *play music*,
   *offer a menu*. *Ren'Py*, *KiriKiri/KAG*, *NScripter*, *TyranoScript*, *Monogatari*
   live here. Presentation is deeply baked in.

3. **Engine/editor-driven formats.** The "script" is data authored through a GUI or node
   graph and serialized to project files. *Naninovel* (Unity), *Twine* (partly),
   *articy:draft*, and various RPG-Maker-style tools fit here.

These families blur — Ren'Py is a scripting language *and* a runtime; Ink is a narrative
DSL *and* an embeddable runtime; Twine is an editor *and* a family of story formats.

---

## Prose-first & narrative-DSL formats

### Fountain (screenplay markup)

- **Paradigm:** plain-text screenplay markup (see [`fountain.md`](fountain.md)).
- **Branching:** none natively — Fountain is a *linear* screenplay format. This project
  layers branch markers on top (`[[choice: … -> id]]`, `[[scene: id]]`, `[[next: id]]`)
  to turn it into a branch graph.
- **Presentation coupling:** none. Fountain describes *who says what, where* — locations,
  scene headings, dialogue, action — and stays entirely presentation-agnostic. No sprites,
  no transitions, no channels.
- **Runtime:** none; it's an interchange format. Renderers exist for PDF/screenplay
  layout, not for VN playback.
- **Ecosystem:** mature in the screenwriting world; many parsers; UTF-8 text so it is
  diff- and VCS-friendly.
- **Relevance:** this is our chosen input format precisely *because* it is
  presentation-agnostic and machine-parseable. The gap between Fountain and every VN
  runtime below is exactly the "engine export" we hold out of scope: a Fountain+markers
  story graph is upstream of, and could be compiled into, Ren'Py/Ink/etc.

### Ink (inkle)

- **Paradigm:** a narrative scripting language — a flow-oriented DSL for branching text.
- **Branching:** its signature strength. **Knots** (`=== knot ===`) and **stitches** are
  named containers; **diverts** (`-> target`) jump between them; **choices** (`*` /
  `+`) present options; **gathers** (`-`) re-converge branches; **weave** syntax nests
  choices and gathers into readable, indentation-light branching. First-class **variables**,
  conditionals, and simple logic let state gate content. Tunnels and threads support
  reusable sub-flows and parallel content.
- **Presentation coupling:** deliberately low. Ink emits *lines of text plus tags*; it
  says nothing about sprites or layout. Presentation is the host game's job — **tags**
  (`# tag`) are the escape hatch to signal "show sprite X", "play music Y" to the runtime.
- **Runtime:** the open-source **inkle** runtime compiles `.ink` to a JSON story file
  executed by **ink-runtime** libraries; **Inky** is the reference editor. First-class
  **Unity** integration; C#, JS (inkjs), and other bindings exist.
- **Ecosystem:** mature, widely used in commercial narrative games (*80 Days*, *Heaven's
  Vault*, *Sorcery!*). MIT-licensed. Strong tooling.
- **Relevance:** Ink is the closest mainstream analogue to our "presentation-agnostic
  branch graph." Its knot/divert/choice model maps cleanly onto our `[[scene]]`/`[[next]]`/
  `[[choice]]` markers, and its tag mechanism is the same idea as attaching presentation
  hints to otherwise-clean prose. A plausible export target.

### Yarn Spinner

- **Paradigm:** node-based dialogue DSL (syntax reminiscent of Twine).
- **Branching:** **nodes** connected by `<<jump>>` commands; `->` options present choices;
  `<<if>>`/`<<set>>` handle variables and conditionals. Designed around dialogue trees for
  games rather than long-form prose.
- **Presentation coupling:** low; `<<command>>` directives hand off to the host engine.
- **Runtime:** **Yarn Spinner** for Unity (primary), plus Godot and other ports;
  MIT-licensed.
- **Ecosystem:** popular in indie games (*Night in the Woods*). Good Unity tooling.
- **Relevance:** another clean separation of narrative logic from presentation; its command
  hooks mirror Ink tags and our marker approach.

### Twine (Harlowe / SugarCube / Snowman / Chapbook)

- **Paradigm:** a **visual editor** over hypertext **passages**, plus a choice of **story
  formats** (compile targets) that each define their own macro/scripting dialect.
- **Branching:** passages linked by `[[link|target]]`; the story *is* the link graph.
  Logic depends on the story format — **Harlowe** (beginner-friendly macros), **SugarCube**
  (powerful macros + JS), **Snowman** (thin, JS-first), **Chapbook** (config-driven).
- **Presentation coupling:** produces **self-contained HTML**; presentation is CSS/JS you
  bring yourself. Not VN-specific — no built-in sprite/BG/music model — though people build
  VN-like experiences with SugarCube + custom CSS.
- **Runtime:** the compiled HTML runs in any browser; the Twine app (desktop/web) is the
  editor.
- **Ecosystem:** huge hobbyist/IF community; very low barrier to entry; open source.
- **Relevance:** demonstrates the "passage graph + pluggable presentation" pattern and the
  value of a visual branch view — relevant to how we might *visualize* our story graph
  (we already emit `story.graph.mmd`).

### Monogatari

- **Paradigm:** a **JavaScript/web** VN engine with a compact, declarative script format.
- **Branching:** `jump`, `choice` objects, and labels; state via a simple storage model.
- **Presentation coupling:** high and VN-native — `show character`, `show scene`, `play
  music`, transitions — but expressed as plain data (arrays/objects) rather than a custom
  language.
- **Runtime:** runs in the browser (HTML/CSS/JS); packageable with Electron/Cordova.
- **Ecosystem:** open source (MIT); smaller but active; web-first.
- **Relevance:** shows a VN script encoded as ordinary structured data — close in spirit to
  a JSON manifest an export step could emit.

---

## Dedicated VN scripting languages & engines

### Ren'Py

- **Paradigm:** the dominant open-source VN engine; a **Python-based DSL**. Simple scripts
  read almost like screenplay; anything complex drops into full Python.
- **Branching:** `label` blocks + `jump`/`call`; `menu:` presents choices; arbitrary Python
  `if`/variables for state and routes. `call`/`return` gives subroutine-like reuse.
- **Presentation coupling:** deep and first-class. `show eileen happy at left`,
  `scene bg room with dissolve`, `play music "…"`, ATL (Animation & Transformation
  Language) for sprite motion/transitions, `define`/`image` statements bind logical names
  to assets, `Character()` objects style speakers. The language *is* the presentation model.
- **Runtime:** cross-platform (Windows/macOS/Linux/Android/iOS/web) via a bundled Python +
  SDL/Pygame runtime; one-click distribution builds.
- **Ecosystem:** the de-facto standard for indie/commercial VNs (*Doki Doki Literature
  Club*, countless itch.io titles). Permissive license, deep docs, large community, mature
  tooling.
- **Relevance:** the single most important **export target** to reason about. Our manifest
  models exactly the raw materials a Ren'Py script needs — characters, sprites, backgrounds,
  scene order, choices. A future exporter would map our story graph → `label`/`menu`/`jump`
  and our asset store → `image`/`Character` definitions. Ren'Py's tight
  script↔presentation coupling is the mirror image of our deliberately decoupled input side.

### KiriKiri (KAG3 / TJS2)

- **Paradigm:** a two-layer Japanese engine — **KAG** (Kirikiri Adventure Game system), a
  tag-based markup layer, over **TJS2**, a full JavaScript-like scripting language.
- **Branching:** `[link]`/`[jump]` tags and `*labels`; TJS2 for real logic.
- **Presentation coupling:** high; KAG tags control layers, transitions, voice, positions.
- **Runtime:** KiriKiri Z / kirikiroid2 and forks; historically Windows-centric.
- **Ecosystem:** heavily used in Japanese commercial VNs; the classic professional pipeline.
  Documentation is largely Japanese; steeper for Western authors.
- **Relevance:** the archetypal "markup layer over a scripting language" split — the same
  two-tier idea appears in KAG/TJS, Ren'Py DSL/Python, and Ink text/host-code.

### NScripter / ONScripter

- **Paradigm:** a classic, terse command-per-line VN scripting language.
- **Branching:** `goto`/`gosub`/labels; numbered/aliased variables.
- **Presentation coupling:** high but low-level — explicit sprite/number cells, manual
  layering.
- **Runtime:** NScripter (Windows) and the open-source **ONScripter** reimplementation,
  which ports many classic VNs to Linux/PSP/Android/etc.
- **Ecosystem:** foundational and historically huge (*Umineko*, *Higurashi* originally);
  now largely legacy for new work.
- **Relevance:** mostly historical context — shows how spartan early VN DSLs were before
  Ren'Py/KiriKiri raised the abstraction level.

### TyranoScript / TyranoBuilder

- **Paradigm:** an **HTML5/JS** engine with a tag-based script (`[tag]` markup), plus
  **TyranoBuilder**, a commercial drag-and-drop GUI over it.
- **Branching:** `[jump]`/`[button]`/labels; `[if]` and variables.
- **Presentation coupling:** high, VN-native tags for characters, backgrounds, audio,
  transitions.
- **Runtime:** browser/HTML5; exports to desktop/mobile/web.
- **Ecosystem:** popular especially in Japan; TyranoBuilder lowers the barrier for
  non-programmers; active.
- **Relevance:** another tag-markup-over-web-runtime point, notable for pairing a text
  format with a visual builder.

### Naninovel (Unity)

- **Paradigm:** a commercial **Unity** VN framework driven by **NaniScript**, a concise
  line-based script, authored in Unity with strong editor tooling.
- **Branching:** `@goto`/labels, `@choice`, variables/state; integrates with Unity C#.
- **Presentation coupling:** high; `@char`, `@back`, `@bgm`, transitions — but backed by
  Unity's full rendering, so 2D/3D/Live2D/Spine all available.
- **Runtime:** anywhere Unity deploys (desktop/mobile/console/web).
- **Ecosystem:** paid asset; well-documented; used for polished commercial titles that want
  Unity's power.
- **Relevance:** represents "VN script as a layer inside a general game engine," where
  presentation power is effectively unbounded — the far end of the coupling spectrum from
  our presentation-free input.

### Others worth knowing

- **Godot-based VN toolkits** (e.g. *Dialogic*, *GDevelop* templates) — bring VN dialogue
  systems to open-source engines; node/resource-driven.
- **VNMaker (VN Maker / Visual Novel Maker)** — a commercial RPG-Maker-style GUI tool
  (RPG Maker lineage) targeting non-programmers.
- **articy:draft** — a professional narrative-design tool (node graphs, flow, entities)
  used to author branching content that exports to engines; upstream of runtime, like us.
- **VNDS** — a lightweight interpreter format popular for playing VNs on handhelds; simple
  script + resource archive.
- **Novelty, Belle, others** — assorted GUI-first VN makers of varying maturity.

---

## Cross-cutting design dimensions

### Branching notation

| Pattern | Formats | Notes |
| --- | --- | --- |
| Labels + `goto`/`jump` | Ren'Py, KiriKiri, NScripter, Tyrano, Nani | Familiar, explicit, can sprawl |
| Knots + diverts + weave | Ink | Most ergonomic for dense branching prose |
| Passage/link graph | Twine, Yarn | Graph *is* the story; visual-editor friendly |
| Inline markers over prose | This project (Fountain + `[[…]]`) | Keeps text clean; graph derived by parser |

### Presentation binding

The key differentiator is **where asset/layout knowledge lives**:

- **In the script** (Ren'Py, KiriKiri, Tyrano, Nani, Monogatari): the story text is
  inseparable from `show`/`scene`/`play` directives and concrete asset names.
- **Out of the script, via tags/commands** (Ink, Yarn): narrative text stays clean; a thin
  tag/command channel signals the runtime.
- **Absent by design** (Fountain, articy, our manifest): the format models *story
  structure and content*, and a separate layer or export step maps it to presentation.

Our architecture sits firmly in the third camp: **deterministic plumbing (parse, validate,
dedupe, layout, schedule) is kept separate from generative/presentation steps**, and the
pipeline stops at a populated `build/` + `manifest.json`. Every VN runtime above is a
potential *downstream* of that manifest, not a competitor to it.

### Authoring ergonomics & LLM-friendliness

For a project that *generates and edits inputs with an LLM agent* (`vnauthor`),
plain-text, presentation-light formats are strongly preferable:

- **Diff- and VCS-friendly** (Fountain, Ink, Yarn, Twee) vs. **binary/GUI project files**
  (TyranoBuilder, VNMaker, articy).
- **Low presentation noise** (Fountain, Ink) makes it far easier for a model to reason
  about *story* without also having to manage sprite coordinates and transition timings.
- **Structured, parseable branching** lets us validate reachability and dead scenes
  deterministically (as `@vn/model` already does) rather than trusting free-form goto soup.

This is the core reason the project authors in Fountain + branch markers and reserves
presentation for the generative pipeline, rather than authoring directly in a VN scripting
language.

---

## Implications for this project

1. **Our IR is upstream of all of these.** A Fountain+markers story graph plus a
   content-addressed asset manifest is a *presentation-agnostic superset* of the
   information any of the runtimes above needs. Nothing here contradicts our design; the
   formats simply clarify what a future export step would consume.

2. **The most natural export targets are Ren'Py and Ink.** Ren'Py because it is the
   dominant runtime and its `label`/`menu`/`jump` + `image`/`Character` model maps directly
   onto our story graph and asset store. Ink because its knot/divert/choice + tags model is
   almost a one-to-one match for our marker-based branch graph and our separation of prose
   from presentation.

3. **Tags/commands are the universal seam.** Ink tags, Yarn commands, and our `[[…]]`
   markers all solve the same problem: attach presentation intent to clean prose. If we
   ever formalize presentation hints in the input, this is the established idiom to follow.

4. **Engine export remains genuinely out of scope — and that's a clean boundary.** Because
   every runtime bakes in its own presentation model, an exporter is a real, format-specific
   project (asset naming, transition mapping, dialogue styling). Holding the pipeline at
   `manifest.json` keeps the generative core reusable across *all* of these targets rather
   than coupling it to one.

---

## Quick reference

| Format | Family | Branching | Presentation in script? | Runtime | License |
| --- | --- | --- | --- | --- | --- |
| Fountain (+ our markers) | Prose markup | Inline markers | No | none (interchange) | open |
| Ink | Narrative DSL | Knots/diverts/weave | No (tags) | inkle/ink-runtime, Unity | MIT |
| Yarn Spinner | Dialogue DSL | Nodes + jumps | No (commands) | Unity/Godot | MIT |
| Twine | Editor + story formats | Passage links | Via CSS/JS | Browser HTML | open |
| Monogatari | Web VN engine | jump/choice | Yes (data) | Browser/Electron | MIT |
| Ren'Py | VN DSL + engine | label/menu/jump + Python | Yes (deep) | Cross-platform | permissive |
| KiriKiri (KAG/TJS2) | Markup + scripting | tags/labels + TJS | Yes | KiriKiri Z | open-ish |
| NScripter/ONScripter | VN DSL | goto/gosub | Yes (low-level) | NScripter/ONScripter | mixed |
| TyranoScript | Web VN tags | jump/button | Yes | HTML5 | open |
| Naninovel | Unity framework | goto/choice | Yes | Unity | commercial |

---

## Further reading

- [`fountain.md`](fountain.md) — the input screenplay format this project extends.
- [`vn-generator-report.md`](vn-generator-report.md) — the pipeline design and the explicit
  "stops at `manifest.json`, engine export out of scope" boundary.
- Ren'Py documentation — the reference for the dominant open VN runtime.
- inkle's *Ink* — writing manual and runtime, the closest analogue to our decoupled model.

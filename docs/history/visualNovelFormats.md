# A Survey of Visual Novel Formats & Scripting Languages

<!-- toc -->

- [How to read this survey](#how-to-read-this-survey)
- [The three broad families](#the-three-broad-families)
- [Prose-first & narrative-DSL formats](#prose-first--narrative-dsl-formats)
  * [Fountain (screenplay markup)](#fountain-screenplay-markup)
  * [Ink (inkle)](#ink-inkle)
  * [Yarn Spinner](#yarn-spinner)
  * [Twine (Harlowe / SugarCube / Snowman / Chapbook)](#twine-harlowe--sugarcube--snowman--chapbook)
  * [Monogatari](#monogatari)
- [Dedicated VN scripting languages & engines](#dedicated-vn-scripting-languages--engines)
  * [Ren'Py](#renpy)
  * [KiriKiri (KAG3 / TJS2)](#kirikiri-kag3--tjs2)
  * [NScripter / ONScripter](#nscripter--onscripter)
  * [TyranoScript / TyranoBuilder](#tyranoscript--tyranobuilder)
  * [Naninovel (Unity)](#naninovel-unity)
  * [Others worth knowing](#others-worth-knowing)
- [Cross-cutting design dimensions](#cross-cutting-design-dimensions)
  * [Branching notation](#branching-notation)
  * [Presentation binding](#presentation-binding)
  * [Authoring ergonomics & LLM-friendliness](#authoring-ergonomics--llm-friendliness)
- [Implications for this project](#implications-for-this-project)
- [Quick reference](#quick-reference)
- [Further reading](#further-reading)

<!-- tocstop -->

This document surveys visual novel (VN) scripting languages, authoring formats, and runtime engines. It orients this
project, which generates inputs (characters, a branching Fountain screenplay, art assets, a provenance manifest) and
deliberately stops short of engine export (see [`vn-generator-report.md`](vn-generator-report.md)). Understanding the
target formats a manifest might eventually be exported into (and how those formats model story, branching, dialogue,
and presentation) informs both the shape of our intermediate representation and any future export work.

Since this survey was written, one narrow thing on that axis did get built, though it is not an export in the sense
meant here. `@vn/export` projects the model + manifest into `story.play.json`, a flattened ordered view over our own
types for our own desktop runner ([`../reference/playable-format.md`](../reference/playable-format.md)). It has no
scripting language, no macro system, and no engine on the far side. Everything below remains a target we do not emit.

A visual novel runs from a branching script that drives presentation. The script sequences dialogue and narration over
a backdrop of character sprites, background art, music, and sound, and it offers the reader choices that route through
the branch graph. Every format below is one way to notate that script. The formats fall on a spectrum from prose-first
markup (mostly text with directives sprinkled in) to full programming languages, where the script is a program that
happens to show a story.

---

## How to read this survey

Each format is assessed on a few recurring criteria:

- **Paradigm** — choose between plain-text markup, an embedded DSL, a full scripting language, or a visual/node
  editor.
- **Branching model** — expresses choices and non-linear flow through labels and jumps, gather/weave, a node graph,
  or a state machine.
- **Presentation coupling** — measures how tightly the script binds to concrete assets and layout (sprite positions,
  transitions, channels) rather than staying presentation-agnostic.
- **Runtime** — Lists the engines that execute it and the platforms it targets.
- **Ecosystem** — maturity, tooling, community, licensing.
- **Relevance to this project** — states what the work suggests for our IR or export, if anything.

---

## The three broad families

1. 1. **Prose-first screenplay markup.** You write mostly natural text, and a small set of conventions and inline
   markers encode structure and branching. The format is diff-friendly, tool-agnostic, and LLM-friendly. Fountain (as
   this project extends it), Markdown-based formats, and Ink take this approach.

2. 2. **Dedicated VN scripting languages.** Purpose-built DSLs (often embedded in a host language) with first-class
   notions of saying a line, showing a sprite, playing music and offering a menu. *Ren'Py*, *KiriKiri/KAG*,
   *NScripter*, *TyranoScript* and *Monogatari* are examples. These languages build presentation into the language
   itself.

3. **Engine/editor-driven formats.** The "script" is data authored through a GUI or node
   graph and serialized to project files. *Naninovel* (Unity), *Twine* (partly),
   *articy:draft*, and various RPG-Maker-style tools fit here.

These categories overlap. Ren'Py is both a scripting language and a runtime; Ink is both a narrative DSL and an
embeddable runtime; Twine is both an editor and a family of story formats.

---

## Prose-first & narrative-DSL formats

### Fountain (screenplay markup)

- **Paradigm:** plain-text screenplay markup (see [`../reference/fountain.md`](../reference/fountain.md)).
- **Branching:** Fountain has none natively, because it is a linear screenplay format. This project layers branch
  markers on top (`[[choice: … -> id]]`, `[[scene: id]]`, `[[next: id]]`) to turn it into a branch graph.
- **Presentation coupling:** none. Fountain describes who says what and where — locations, scene headings, dialogue,
  action — and stays entirely presentation-agnostic. It has no sprites, no transitions, and no channels.
- **Runtime:** none, because it is an interchange format. Renderers exist for PDF/screenplay layout, not for VN
  playback.
- **Ecosystem:** The format is mature in the screenwriting world and has many parsers. It is UTF-8 text, so it works
  well with diffs and version control.
- **Relevance:** we chose this input format because it is presentation-agnostic and machine-parseable. Bridging
  Fountain to every VN runtime below would require the "engine export" that we hold out of scope. A Fountain+markers
  story graph sits upstream of Ren'Py, Ink and similar runtimes, and could be compiled into them.

### Ink (inkle)

- **Paradigm:** The language is a narrative scripting language, a flow-oriented DSL for branching text.
- **Branching:** Branching is the language's signature strength. "Knots" (`=== knot ===`) and "stitches" are named
  containers; "diverts" (`-> target`) jump between them; "choices" (`*` / `+`) present options; "gathers" (`-`)
  re-converge branches; "weave" syntax nests choices and gathers into branching that reads clearly and needs little
  indentation. First-class variables, conditionals, and simple logic let state gate content. Tunnels and threads
  support reusable sub-flows and parallel content.
- **Presentation coupling:** Ink couples to presentation deliberately little. Ink emits lines of text plus tags and
  says nothing about sprites or layout. The host game handles presentation, and tags (`# tag`) carry instructions such
  as "show sprite X" or "play music Y" to the runtime.
- **Runtime:** the open-source inkle runtime compiles `.ink` to a JSON story file executed by ink-runtime libraries,
  and Inky is the reference editor. Unity integration is first-class, and C#, JS (inkjs), and other bindings exist.
- **Ecosystem:** The ecosystem is mature and sees wide use in commercial narrative games (*80 Days*, *Heaven's
  Vault*, *Sorcery!*). The license is MIT, and the tooling is strong.
- **Relevance:** Ink is the closest mainstream analogue to our "presentation-agnostic branch graph." Its
  knot/divert/choice model maps cleanly onto our `[[scene]]`/`[[next]]`/ `[[choice]]` markers, and its tags attach
  presentation hints to otherwise-clean prose in the same way. Ink is a plausible export target.

### Yarn Spinner

- **Paradigm:** node-based dialogue DSL (syntax reminiscent of Twine).
- **Branching:** Nodes connect through `<<jump>>` commands, `->` options present choices, and `<<if>>`/`<<set>>`
  handle variables and conditionals. The design targets dialogue trees for games rather than long-form prose.
- **Presentation coupling:** Low. The `<<command>>` directives hand off to the host engine.
- **Runtime:** Yarn Spinner for Unity (primary), plus Godot and other ports; MIT-licensed.
- **Ecosystem:** Is popular in indie games (*Night in the Woods*) and has good Unity tooling.
- **Relevance:** It is another system that cleanly separates narrative logic from presentation, and its command
  hooks mirror Ink tags and our marker approach.

### Twine (Harlowe / SugarCube / Snowman / Chapbook)

- **Paradigm:** a visual editor over hypertext passages, plus a choice of story formats (compile targets) that each
  define their own macro/scripting dialect.
- **Branching:** Passages link to each other with `[[link|target]]`, and those links form the story's graph. Logic
  depends on the story format: Harlowe provides beginner-friendly macros, SugarCube provides powerful macros plus JS,
  Snowman is thin and JS-first, and Chapbook is config-driven.
- **Presentation coupling:** Produces self-contained HTML, and the presentation is CSS and JS you bring yourself.
  SugarCube is not VN-specific and has no built-in sprite, background or music model, though people build VN-like
  experiences with SugarCube + custom CSS.
- **Runtime:** the compiled HTML runs in any browser; the Twine app (desktop/web) is the
  editor.
- **Ecosystem:** huge hobbyist/IF community; very low barrier to entry; open source.
- **Relevance:** demonstrates the "passage graph + pluggable presentation" pattern and the value of a visual branch
  view. This is relevant to how we might visualize our story graph (we already emit `story.graph.mmd`).

### Monogatari

- **Paradigm:** a **JavaScript/web** VN engine with a compact, declarative script format.
- **Branching:** `jump`, `choice` objects, and labels, with state held in a simple storage model.
- **Presentation coupling:** High and VN-native: `show character`, `show scene`, `play music`, transitions. These
  are expressed as plain data (arrays/objects) rather than a custom language.
- **Runtime:** Runs in the browser (HTML/CSS/JS) and can be packaged with Electron or Cordova.
- **Ecosystem:** open source (MIT); smaller but active; web-first.
- **Relevance:** shows a VN script encoded as ordinary structured data, which resembles a JSON manifest an export
  step could emit.

---

## Dedicated VN scripting languages & engines

### Ren'Py

- **Paradigm:** The engine dominates open-source VN development, and its scripts are written in a Python-based DSL.
  Simple scripts read almost like a screenplay, and anything complex drops into full Python.
- **Branching:** Branching uses `label` blocks with `jump` and `call`. A `menu:` block presents choices. Arbitrary
  Python `if` statements and variables hold state and select routes. `call` and `return` allow subroutine-like reuse.
- **Presentation coupling:** Presentation is deep and first-class. The language provides `show eileen happy at
  left`, `scene bg room with dissolve`, `play music "…"`, and ATL (Animation & Transformation Language) for sprite
  motion and transitions; `define`/`image` statements bind logical names to assets, and `Character()` objects style
  speakers. The presentation model is expressed in the language itself.
- **Runtime:** Runs on Windows, macOS, Linux, Android, iOS and web through a bundled Python + SDL/Pygame runtime,
  and produces distribution builds in one click.
- **Ecosystem:** Serves as the de-facto standard for indie/commercial VNs (*Doki Doki Literature Club*, countless
  itch.io titles). The license is permissive, the documentation is deep, the community is large, and the tooling is
  mature.
- **Relevance:** Ren'Py is the most important export target to reason about. Our manifest models exactly the raw
  materials a Ren'Py script needs — characters, sprites, backgrounds, scene order, choices. A future exporter would
  map our story graph onto `label`/`menu`/`jump` and our asset store onto `image`/`Character` definitions. Ren'Py
  couples script and presentation tightly, while our input side is deliberately decoupled.

### KiriKiri (KAG3 / TJS2)

- **Paradigm:** A two-layer Japanese engine. KAG (Kirikiri Adventure Game system) is a tag-based markup layer that
  runs over TJS2, a full JavaScript-like scripting language.
- **Branching:** Branches are written with `[link]`/`[jump]` tags and `*labels`. Real logic is written in TJS2.
- **Presentation coupling:** High. KAG tags control layers, transitions, voice, and positions.
- **Runtime:** KiriKiri Z / kirikiroid2 and forks; historically Windows-centric.
- **Ecosystem:** Japanese commercial VNs use it heavily, and it is the classic professional pipeline. Its
  documentation is largely Japanese, so the learning curve is steeper for Western authors.
- **Relevance:** This is the archetypal "markup layer over a scripting language" split. The same two-tier idea
  appears in KAG/TJS, Ren'Py DSL/Python, and Ink text/host-code.

### NScripter / ONScripter

- **Paradigm:** The language is a classic, terse, command-per-line VN scripting language.
- **Branching:** supports `goto`, `gosub` and labels, and numbered or aliased variables.
- **Presentation coupling:** The coupling is high but low-level. Cells name sprites and numbers explicitly, and
  layering is manual.
- **Runtime:** NScripter (Windows) and the open-source **ONScripter** reimplementation, which ports many classic VNs
  to Linux, PSP, Android, and other platforms.
- **Ecosystem:** The ecosystem is foundational and was historically huge (*Umineko*, *Higurashi* originally). It is
  now largely legacy for new work.
- **Relevance:** This is mostly historical context. It shows how spartan early VN DSLs were before Ren'Py/KiriKiri
  raised the abstraction level.

### TyranoScript / TyranoBuilder

- **Paradigm:** The engine runs on HTML5/JS and takes a tag-based script (`[tag]` markup). TyranoBuilder is a
  commercial drag-and-drop GUI over it.
- **Branching:** `[jump]`/`[button]`/labels; `[if]` and variables.
- **Presentation coupling:** High. The tags for characters, backgrounds, audio, and transitions are VN-native.
- **Runtime:** browser/HTML5; exports to desktop/mobile/web.
- **Ecosystem:** Adoption is strongest in Japan. TyranoBuilder lowers the barrier for non-programmers. The ecosystem
  is active.
- **Relevance:** This is another tag-markup-over-web-runtime point, notable because it pairs a text format with a
  visual builder.

### Naninovel (Unity)

- **Paradigm:** This is a commercial Unity VN framework driven by NaniScript, a concise line-based script. Authors
  write in Unity, which supplies strong editor tooling.
- **Branching:** `@goto`/labels, `@choice`, variables/state; integrates with Unity C#.
- **Presentation coupling:** high. The engine provides `@char`, `@back`, `@bgm` and transitions, and Unity's full
  rendering backs them, so 2D, 3D, Live2D and Spine are all available.
- **Runtime:** runs anywhere Unity deploys (desktop, mobile, console, web).
- **Ecosystem:** paid asset; well-documented; used for polished commercial titles that need Unity's power.
- **Relevance:** It represents "VN script as a layer inside a general game engine," where presentation power is
  effectively unbounded. That places it at the far end of the coupling spectrum from our presentation-free input.

### Others worth knowing

- **Godot-based VN toolkits** (e.g. *Dialogic*, *GDevelop* templates) — these toolkits bring VN dialogue systems to
  open-source engines, and they are driven by nodes and resources.
- **VNMaker (VN Maker / Visual Novel Maker)** is a commercial RPG-Maker-style GUI tool (RPG Maker lineage) aimed at
  non-programmers.
- **articy:draft** — A professional narrative-design tool built around node graphs, flow, and entities. Authors use
  it to write branching content that exports to engines, so it sits upstream of the runtime, as this project does.
- **VNDS** — a lightweight interpreter format popular for playing VNs on handhelds. It pairs a simple script with a
  resource archive.
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

The key difference is where asset/layout knowledge lives:

- **In the script** (Ren'Py, KiriKiri, Tyrano, Nani, Monogatari), the story text is inseparable from
  `show`/`scene`/`play` directives and concrete asset names.
- **Out of the script, via tags/commands** (Ink, Yarn): The narrative text stays clean, and a separate tag or
  command channel signals the runtime.
- **Absent by design** (Fountain, articy, our manifest): The format models story structure and content, and a
  separate layer or export step maps it to presentation.

Our architecture belongs to the third camp: deterministic plumbing (parse, validate, dedupe, layout, schedule) is kept
separate from generative and presentation steps, and the pipeline stops at a populated `build/` plus `manifest.json`.
Every VN runtime above can consume that manifest downstream rather than replace it.

### Authoring ergonomics & LLM-friendliness

For a project that generates and edits inputs with an LLM agent (`vnauthor`), plain-text, presentation-light formats
are strongly preferable:

- Fountain, Ink, Yarn and Twee are diff- and VCS-friendly; TyranoBuilder, VNMaker and articy store projects as
  binary or GUI files.
- **Low presentation noise** (Fountain, Ink) makes it far easier for a model to reason about story structure without
  also having to manage sprite coordinates and transition timings.
- **Structured, parseable branching** allows deterministic validation of reachability and dead scenes (as
  `@vn/model` already does) rather than relying on free-form gotos.

This is the core reason for authoring in Fountain + branch markers and reserving presentation for the generative
pipeline, rather than authoring directly in a VN scripting language.

---

## Implications for this project

1. 1. **Our IR is upstream of all of these.** A Fountain+markers story graph plus a content-addressed asset manifest
   is a presentation-agnostic superset of the information the runtimes listed above need. Nothing here contradicts our
   design; the formats show what a future export step would consume.

2. 2. **The most natural export targets are Ren'Py and Ink.** Ren'Py fits because it is the dominant runtime and its
   `label`/`menu`/`jump` + `image`/`Character` model maps directly onto our story graph and asset store. Ink fits
   because its knot/divert/choice + tags model is almost a one-to-one match for our marker-based branch graph and our
   separation of prose from presentation.

3. 3. **Tags and commands are the shared idiom.** Ink tags, Yarn commands, and our `[[…]]` markers all attach
   presentation intent to clean prose. If we ever formalize presentation hints in the input, we should follow this
   established idiom.

4. 4. **Engine export remains out of scope, and the boundary is a clean one.** Every runtime bakes in its own
   presentation model, so an exporter is a real, format-specific project (asset naming, transition mapping, dialogue
   styling). Holding the pipeline at `manifest.json` keeps the generative core reusable across all of these targets
   rather than coupling it to one.

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

- [`../reference/fountain.md`](../reference/fountain.md) — describes the input screenplay format this project
  extends.
- [`vn-generator-report.md`](vn-generator-report.md) — describes the pipeline design and states the boundary
  explicitly: "stops at `manifest.json`, engine export out of scope".
- Ren'Py documentation. This is the reference for the dominant open VN runtime.
- inkle's *Ink* provides a writing manual and a runtime, and is the closest analogue to our decoupled model.

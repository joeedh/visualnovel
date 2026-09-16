# Manga pages: the design brief and the design plan

Companion to [`manga-style.md`](manga-style.md), which asks for three new surfaces (the
panel editor, panel stepping in Play, the bubble editor) to be built under the
`frontend-design` skill: a brief, a design plan reviewed against the brief before any
code, and a screenshot critique before the stage lands. This file holds all three. The
brief and the plan were written on 2026-09-16, before Stage 3's first widget; the critique
section is filled when the stage's first build runs.

## The brief

### What is being designed

- A **Page editor**: where an author shapes one page shot. The panel outlines, which line
  each panel letters, each panel's cast and camera, and the layout template. It is the one
  surface where the author sees whether the drawn page matches what was asked for, because
  it draws the reviewer's measured boxes over the author's intended outlines.
- **Panel stepping in Play**: when a page shot is on screen and the current line belongs
  to a panel, that panel reads as the current one.
- A **bubble editor** (Stage 5): the Page editor with one more layer, a speech-bubble
  anchor per line inside its panel and a tail dragged to the speaker.

### Who it is for, and what it has to do

- The author of a visual novel that draws some scenes as colour manga. They already work
  in the desktop app's sixteen editors, know Shot Coverage, and think in shots and lines,
  not in polygons.
- The primary job is to make a page's intent legible and correctable at a glance: which
  panel is which, what each panel says, and whether the render honoured the layout. The
  secondary job is to make the cost of a change visible before it is made, since every
  edit to a lettered page re-renders it.

### Fixed points (the skill follows these exactly)

- **The page is the canvas.** The rendered page, or the empty page at its aspect ratio
  before a render, is the largest thing on the surface, and every panel-level control is
  either drawn on it or follows the panel selected on it. Nothing is edited through a
  table of numbers.
- **Two layers over the page, and they must read as two different kinds of thing.** The
  intended polygons are what the author asked for. The reviewer's observed boxes are what
  the model drew, measured. A mismatch is visible without a label.
- **Vertices are dragged directly.** A line is assigned to a panel by dragging it onto the
  panel. A template is picked from a row of small page glyphs, not a dropdown of names.
- **Palette and type come from the app's tokens**
  (`apps/desktop/renderer/styles/tokens.css`) and path.ux's theme, because the editor sits
  beside sixteen others that share them. No new hue, no new typeface.
- **The memorable element is the page-as-canvas interaction.** Everything around it stays
  quiet.
- **Words name what the author does**, not what the system does: "Assign this line to
  panel 3", "Re-renders this page", not "Update coverage partition".
- **Every control goes through `act()`, carries a tooltip, and the two commands behind it
  (`story.setPanels`, `story.setCoverage`) price the re-render in their `check`**, which
  the surface shows verbatim on the control. A control that would be refused says why.
- **Play's treatment is one move.** The page stays put; the current panel is lit and the
  rest dims; a crossfade between panels, a cut under reduced motion, and no other motion.

### Content the design is built with

- A four-panel page from `templates/basic`'s rooftop scene, `three-tier` with the last
  tier split, 3:4, four covered lines (one caption, three spoken), cast of two, drawn.
- The same page before any render (outline only).
- A single-frame shot with no panels, which the editor can turn into a page.
- A page whose render was measured and whose panel 3 came out short (the box ends at 0.74
  of the height), so the two layers disagree in one place.
- A page with one covered line in no panel (`line_in_no_panel`).

## Where it lives: a decision the plan left open

The plan says "add the panel editor to the desktop asset pane". The brief's first fixed
point makes that the wrong home:

- The Asset editor's subject is `ui.assetHash`, one set of bytes. A page before its first
  render has no bytes, and the brief requires the empty page to be editable.
- The author edits the shot, not the render. A render is replaced by the next run; the
  panels persist across renders.
- Shot Coverage already claims a `shot` node as primary and shows a page as `page · N`, so
  the tree has a place a page shot's click lands.

So the panel editor is a new editor, `page`, title **Page**, subject `ui.shotId`:

- `EDITORS` gains
  `{ id: 'page', title: 'Page', what: 'one page shot: its panels, their lines and what the render made of them', claims, pins: 'shotId' }`.
  `PinField` gains `shotId`, `PIN_NOUN.shotId = 'shot'`.
- Its claim: `primary` for a `shot` node whose shot has panels, `secondary` for any other
  shot. `ClaimNode` gains `panels?: true`, stamped by main where `boundGraph` is, because
  a claim cannot read the project. Listed before Shot Coverage so the primary tie on a
  page shot breaks its way; a frame shot still opens Shot Coverage.
- It follows `ui.shotId` (published by Shot Coverage, the tree, the task graph and Play)
  and publishes `ui.shotId` itself only when the author picks a different shot through it,
  which it has no control for; so in practice it only follows.
- The image it draws is the shot's current asset through `vnasset://`, read the way the
  timeline strip reads a thumbnail; its outlines and boxes come from the shot record
  (`panels`, `panelBoxes`) through a `story.page` read command that also returns the
  shot's covered lines with their text and speaker, the scene's cast, and
  `letteredPagesNote`'s price for a hypothetical change.

This is recorded in the plan's Stage 3 As-shipped when the stage lands.

## The design plan

### Colour

From `tokens.css`, by role. No new values.

| Token                 | Value     | Role on this surface                                                            |
| --------------------- | --------- | ------------------------------------------------------------------------------- |
| `--ink`               | `#0e1116` | The surface behind the page; the dim over a page in Play                        |
| `--paper`             | `#e8e6df` | The empty page before a render, at 6% over ink (a sheet, not a white rectangle) |
| `--sodium`            | `#f4a24c` | The author's side: intended outlines, panel numbers, the selected panel's fill  |
| `--signal`            | `#45c8d6` | The machine's side: the reviewer's observed boxes                               |
| `--vermilion`         | `#e5534b` | One use: the dot on a line that no panel letters                                |
| `--mist`/`--mist-dim` | —         | Line text, hints, the unselected panel's number                                 |

- The sodium/signal split is the app's existing meaning (warm is authored, cool is
  pipeline) and is what makes the two layers read as two kinds of thing with no legend.
- Intended outlines: 1.5px solid sodium at 85%. The selected panel adds a sodium fill at
  10% and shows its vertices; unselected panels show no vertices.
- Observed boxes: 1px dashed signal at 70%, no fill, never selectable, drawn under the
  outlines. A box that matched its panel and a box that did not are drawn the same; the
  mismatch is the geometry, and the header sentence names the panel.
- Nothing else on the surface is coloured. Buttons, the line list and the side column are
  paper on ink like every other editor.

### Type

- `--sans` (Archivo) for every control and the side column, at the app's 14px/13px.
- `--prose` (Newsreader) for the line text in the line list, 15px, because it is the
  screenplay's words and Script and Play already set them in this face.
- `--disp` (Archivo Expanded), 800, for the panel number drawn on the page: one glyph,
  12px, in a small sodium square at the panel's first vertex, the way the Convo nameplate
  is set. It is the only display type on the surface.
- No monospace. Panel numbers are display type on the page, not data labels in a column.
- No uppercase labels. Section heads in the side column are sentence case at 13px mist.

### Layout

One row, two columns. The page takes what the pane gives it and the column is fixed at
300px; under 640px wide the column drops below the page.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Page · rooftop__s3    three-tier · 3:4 · 4 panels          Panel 3 came out  │
│ [▤][▥][◩][▦][▤▤]  templates                                short: re-check   │
├─────────────────────────────────────────────────┬────────────────────────────┤
│                                                 │ Lines                      │
│     ┌─────────────────────────────────┐         │  1  The wind picks up.  ·1 │
│     │ 1                               │         │  2  MIRA  You came.     ·2 │
│     │                                 │         │  3  KAI   I said I'd…   ·3 │
│     ├─────────────────────────────────┤         │  4  MIRA  Then stay.    ●  │
│     │ 2 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │         │     no panel letters this  │
│     │ ░░░░░░ selected ░░░░░░░░░░░░░░░ │         │                            │
│     ├────────────────┬────────────────┤         │ Panel 2                    │
│     │ 3              │ 4              │         │  Framing   medium          │
│     │  ╌╌╌╌╌╌╌╌╌╌╌╌  │                │         │  Camera    low angle, …    │
│     │  (box short)   │                │         │  Cast      Mira · Kai      │
│     └────────────────┴────────────────┘         │    Mira   pose  …  expr …  │
│                                                 │    Kai    pose  …  expr …  │
│                                                 │  Art notes                 │
│                                                 │  ┌──────────────────────┐  │
│                                                 │  └──────────────────────┘  │
└─────────────────────────────────────────────────┴────────────────────────────┘
```

- **Header** (one line, left-aligned): the shot's name; the layout summary in mist; the
  template glyph row; and, right-aligned, the one sentence that matters about the render:
  the layout verdict when the page was measured ("Panel 3 came out short of its outline"),
  "Not drawn yet" before a render, or nothing when the page matched.
- **Template glyphs**: each is an inline SVG of that template's polygons at the page
  aspect, 22px tall, sodium outlines on ink, derived from `LAYOUT_TEMPLATES` and
  `evenLayout(n)` at the page's current count, so a template added in `layout.ts` appears
  here with no drawing. The current template, if any matches, is filled. Tooltip: "Lay
  this page out as three tiers. Keeps panels 1–3's lines and cast. Re-renders this page."
  (the second and third sentences from the command's `check`).
- **The page**: letterboxed in the left column at the shot's effective aspect (from
  `aspectFor`), the render as an `<img>` beneath an `<svg>` overlay carrying the boxes,
  the outlines, the numbers and the selected panel's vertices. The empty page is the same
  `<svg>` over a paper-at-6% rectangle.
- **Side column, top: Lines.** Every line the shot covers, in screenplay order, as rows:
  index, speaker (sodium, small) or nothing for a caption, the text in prose type, and at
  the right the panel number it belongs to as a small sodium glyph, or a vermilion dot and
  the sentence "no panel letters this line" beneath. Rows are draggable onto a panel on
  the page; while a row is dragged, the panel under the pointer takes the selected fill.
  Enter on a focused row assigns it to the selected panel, so the keyboard has the same
  path. Tooltip on a row: "Drag onto a panel to letter this line there. Re-renders this
  page."
- **Side column, bottom: the selected panel.** Its number as a heading ("Panel 2"), then
  framing (the `oneOf` list `story.newShot`'s dialog draws), camera (one text field), cast
  (the shot's cast as a row of toggles, each with pose and expression fields when on), and
  art notes (one box). Each commits through `story.setPanels` on blur or Ctrl+S, the way
  the Asset editor's note boxes commit. With no panel selected the section reads "Select a
  panel on the page to edit its framing, camera and cast."
- **Alignment**: everything left-aligned; the header's verdict is the one right-aligned
  element, so the eye finds it without a colour.

### Interaction on the page

- Click a panel to select it. Tab cycles panels in reading order; Escape deselects.
- Drag a vertex to move it; arrow keys nudge the focused vertex by 0.5% of the page, Shift
  for 2%. Double-click an edge to add a vertex; Delete removes the focused one, refused at
  three with the tooltip saying so. Every drag commits once on release through
  `story.setPanels`, so an undo is one step.
- Drag a line row onto a panel to letter it there; `story.setCoverage` with the moved
  panel assignment.
- Pick a template glyph to reshape; panels beyond the new count are dropped and their
  lines fall to the last panel, which the tooltip says before the click.
- Nothing snaps and nothing animates. A vertex lands where it is dropped.

### Play

- A frame whose line belongs to a panel gets `Frame.panel` (the polygon). The stage draws
  the page as now, then an `<svg>` the size of the image with one `<path>` of the page
  minus the panel (even-odd fill) in ink at 55%. The panel is not outlined: the dim around
  it is the whole treatment.
- The path's `d` changes between panels under a 180ms opacity crossfade of the overlay;
  under `prefers-reduced-motion` the overlay is replaced, not faded. The dialogue box and
  the click-to-advance hint are unchanged.
- A frame whose line no panel letters shows the whole page with no overlay.

### The bubble editor (Stage 5)

- One more layer on the Page editor, drawn only under `lettering: runner`: a bubble anchor
  per line inside its panel, a circle in sodium with the line index, and a tail handle.
  Dropping the anchor sets `PagePanel.bubbles[].anchor`; dragging the tail sets `tail`.
  The line list's panel glyph becomes the anchor's glyph, so a line with no bubble yet is
  visible in the list.
- Play draws the current line's bubble in the panel: paper at 92%, ink text in prose type,
  a tail to the anchor's tail point; the dialogue box is hidden for that frame. The
  standalone web player keeps its text overlay.

### Principles

- One accent per side. Sodium is the author's, signal is the machine's, and nothing else
  on the surface takes a colour, so the page's own colours are the loudest thing on
  screen.
- The page is edited on the page. A number appears in the side column only as the heading
  that says which panel the column is about.
- The cost is on the control. Every tooltip that would re-render ends with the command's
  own sentence, and a refused control says why in the same place.
- Nothing decorates the empty state. An undrawn page is a pale sheet with its outlines; a
  frame shot is that sheet with no outlines and the glyph row lit.

## Review of the plan against the brief

Done before any code, by asking what the generic version of this surface would be (a
property inspector beside an image) and where the plan above still matched it.

- **A numbered panel list in the side column** was the first draft: a row per panel with
  its framing and cast, the page beside it. That is the inspector default and it moves the
  author's eye off the page. Cut. The column now shows lines (the whole shot) and one
  panel (the selected one); panel numbers live on the page.
- **Colour per panel** (four hues for four panels, matched between page and list) is the
  reflex for making correspondence visible. It spends four colours where the app spends
  two, and the brief fixes the palette. Replaced by one selected fill and the number glyph
  on the page and in the list.
- **Observed boxes in vermilion** because they signal a problem: wrong, because a measured
  box is a measurement, and most of them match. Signal, dashed, always drawn the same; the
  verdict is a sentence in the header, in the words the pipeline used to file the defect.
- **A hover preview of each template ghosted over the page** is the kind of motion the
  skill warns about and the brief forbids. Cut; the glyph itself is the preview, and the
  tooltip says what the pick keeps.
- **A "Save" button.** Every other editor commits on blur or on release; a save button
  would make this the one surface with unsaved state. Cut.
- **Mono type for panel numbers and line indices** is the small-data-label default. The
  numbers on the page are display type; the indices in the line list are sans in mist.
- **What stayed generic on purpose:** the two-column shape, because a canvas with a column
  is what the fixed points describe, and the framing dropdown, because it is the same
  `oneOf` list `story.newShot`'s dialog already draws for the same field.

## Screenshot critique

To be written when Stage 3's first build runs, against the five pieces of content in the
brief, before the stage lands. What to look at:

- Does the page dominate at the pane's default size, and at the narrowest width the mesh
  gives a pane?
- Can the two layers be told apart at a glance on the short-panel page, with no legend?
- Does the vermilion dot on the unlettered line read as the one thing to fix?
- Is the empty page a page, or a grey rectangle?
- Does anything move that the brief did not ask to move?
- Hover every control: does each tooltip say what the author does and what it costs?

# Manga pages: the design brief and the design plan

Companion to [`manga-style.md`](manga-style.md), which asks for three new surfaces (the
panel editor, panel stepping in Play, the bubble editor) to be built under the
`frontend-design` skill: a brief, a design plan reviewed against the brief before any
code, and a screenshot critique before the stage lands. This file holds all three. The
brief and the plan were written on 2026-09-16, before Stage 3's first widget, and
pressure-tested the same day by a fresh-context reviewer; the Review section records each
finding and what it changed. The critique section is filled when the stage's first build
runs.

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
  in the desktop app's other editors, know Shot Coverage, and think in shots and lines,
  not in polygons.
- The primary job is to make a page's intent legible and correctable at a glance: which
  panel is which, what each panel says, and whether the render honoured the layout. The
  secondary job is to make the cost of a change visible before it is made, since every
  edit to a page re-renders it.

### Fixed points (the skill follows these exactly)

- **The rendered page, or the empty page at its aspect ratio before a render, is the
  largest thing on the surface**, and every panel-level control is either drawn on it or
  follows the panel selected on it. Nothing is edited through a table of numbers.
- **Two layers over the page, and they must read as two different kinds of thing.** The
  intended polygons are what the author asked for. The reviewer's observed boxes are what
  the model drew, measured. A mismatch is visible without a label.
- **Vertices are dragged directly.** A line is assigned to a panel by dragging it onto the
  panel. A template is picked from a row of small page glyphs, not a dropdown of names.
- **Palette and type come from the app's tokens**
  (`apps/desktop/renderer/styles/tokens.css`) and path.ux's theme, because the editor sits
  beside the other editors that share them. No new hue, no new typeface.
- **The memorable element is the page-as-canvas interaction.** Everything around it stays
  quiet.
- **Words name what the author does**, not what the system does: "Assign this line to
  panel 3", "Re-renders this page", not "Update coverage partition".
- **Every control goes through `act()`, `record()` or `pick()`, carries a tooltip, and the
  one command behind the page, `story.setPanels`, prices the re-render in its `check`**,
  which the surface shows verbatim on the control. A control that would be refused says
  why. The line drop is a registered interaction, `page.letter`, whose targets are judged
  by the same rule the command runs.
- **Play's treatment is one move.** The page stays put; the current panel is lit and the
  rest dims; a crossfade between panels, a cut under reduced motion, and no other motion.

### Content the design is built with

- A four-panel page from `templates/basic`'s rooftop scene, the `two-tier` template (two
  rows of two), 3:4, four covered lines (one caption, three spoken), cast of two, drawn.
- The same page before any render (outline only).
- A single-frame shot with no panels, which the editor can turn into a page.
- A page whose render was measured and whose panel 3 came out short (the box ends at 0.74
  of the height), so the two layers disagree in one place.
- A page with one covered line in no panel (`line_in_no_panel`).

## The editor's home

The plan says "add the panel editor to the desktop asset pane". The brief's first fixed
point rules that out:

- The Asset editor's subject is `ui.assetHash`, one set of bytes. A page before its first
  render has no bytes, and the brief requires the empty page to be editable.
- The author edits the shot, not the render. A render is replaced by the next run; the
  panels persist across renders.

So the panel editor is a new editor, `page`, title **Page**, subject `ui.shotId`:

- `EDITORS` gains
  `{ id: 'page', title: 'Page', what: 'one page shot: its panels, their lines and what the render made of them', claims, pins: 'shotId' }`.
  `PinField` gains `shotId`, `PIN_NOUN.shotId = 'shot'`. The pin machinery
  (`rules/pin.ts`, `editor.ts`'s struct fields) needs nothing else.
- Its claim is `primary` for a `shot` node whose shot has panels, and nothing for any
  other node, so a frame shot never lands in Page. `DocNode` and `ClaimNode` gain
  `panels?: true`, stamped in `storyBranch` (`apps/desktop/src/main/doctree/doctree.ts`),
  which holds the full `Shot`; the tree's shot badge reads `page · N` for a page, as the
  timeline strip's head does. `docs/reference/document-tree.md` gains the field.
- The route ranks visibility before tier before list order (`rules/route.ts`, `better()`),
  so a page shot clicked while Shot Coverage is open and Page is closed opens Shot
  Coverage, which is where its `page · N` head is; Page wins when both or neither are
  open, because it is listed before Shot Coverage. That is the rule every editor lives
  under and it is accepted here. The list order also puts Page before Shot Coverage in
  View ▸ Editors and the pane switcher.
- It follows `ui.shotId` and reads its scene off the shot id's `<sceneId>__<raw>`
  convention (`rules/selection.ts`), never off `ui.sceneId`, so a pinned shot keeps
  working when the live scene moves. A pinned shot whose storyboard is gone draws the
  empty pane with a sentence.
- It reads through `story.coverage`, which already returns the scene's lines with text and
  speaker, each shot's `panels`, `aspect`, `image`, `subjects`, the cast and the lettering
  mode. Stage 3 widens `CoverageShot.panels` from `{ coversLines }` to the full
  `PagePanel`, and adds `panelBoxes?` and `layout?: string`, the verdict sentence main
  computes with `matchPanels` (the rule the runner filed the defect with), so there is no
  second read.

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
  header sentence names the panel that came out wrong.
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
│ Page · rooftop__s3    two-tier · 3:4 · 4 panels            Panel 3 came out  │
│ [▤][▥][◩][▦] [▥▥][▤▤▤]  layouts                            short: re-check   │
├─────────────────────────────────────────────────┬────────────────────────────┤
│                                                 │ Lines                      │
│     ┌────────────────┬────────────────┐         │  1  The wind picks up.  ·1 │
│     │ 1              │ 2 ░░░░░░░░░░░░ │         │  2  MIRA  You came.     ·2 │
│     │                │ ░░ selected ░░ │         │  3  KAI   I said I'd…   ·3 │
│     │                │ ░░░░░░░░░░░░░░ │         │  4  MIRA  Then stay.    ●  │
│     ├────────────────┼────────────────┤         │     no panel letters this  │
│     │ 3              │ 4              │         │                            │
│     │  ╌╌╌╌╌╌╌╌╌╌╌╌  │                │         │ Panel 2                    │
│     │  (box short)   │                │         │  Framing   medium          │
│     │                │                │         │  Camera    low angle, …    │
│     └────────────────┴────────────────┘         │  Cast      Mira · Kai      │
│                                                 │    Mira   pose  …  expr …  │
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
- **Template glyphs**: one per named template in `LAYOUT_TEMPLATES` (`two-tier` at four
  panels, `three-tier` at six, `diagonal-split` at two, `splash-over-two` at three) and
  one per even layout from two to six panels (`evenLayout(n)`), each an inline SVG of the
  template's polygons at the page aspect, 22px tall, sodium outlines on ink. They are
  derived from the module rather than drawn, so a template added in `layout.ts` appears
  here with no design work. A template's panel count is fixed, so picking one sets the
  page's count: panels beyond the new count are dropped and their lines fall to the last
  panel; a new panel starts as `medium`, uncast, with no lines. The glyph whose shapes
  equal the page's current shapes is drawn filled; a page that matches none has no filled
  glyph. Tooltip: "Lay this page out as two tiers of two. Panels 5 and 6 are dropped and
  their lines fall to panel 4. Re-renders this page." (the second and third sentences from
  the command's `check`). On a frame shot the glyph row is the way to make it a page, and
  the tooltip says so.
- **The page**: letterboxed in the left column at the shot's effective aspect (from
  `aspectFor`), the render as an `<img>` beneath an `<svg>` overlay that paints the boxes,
  the outlines and the numbers and takes no pointer events. The empty page is the same
  `<svg>` over a paper-at-6% rectangle. The controls on the page are DOM nodes positioned
  over the `<svg>`: one `<div>` per panel with `clip-path: polygon(…)` as its hit area,
  and one small `<div>` per vertex of the selected panel. A DOM node carries a `title`,
  which `applyOffer` writes; an SVG child does not, which is why the picture is
  paint-only.
- **Side column, top: Lines.** Every line the shot covers, in screenplay order, as rows:
  index, speaker (sodium, small) or nothing for a caption, the text in prose type, and at
  the right the panel number it belongs to as a small sodium glyph, or a vermilion dot and
  the sentence "no panel letters this line" beneath. Rows are draggable onto a panel on
  the page through the `page.letter` interaction; while a row is dragged, the panel under
  the pointer takes the selected fill when the drop is accepted. Enter on a focused row
  assigns it to the selected panel, so the keyboard has the same path. Tooltip on a row:
  "Drag onto a panel to letter this line there. Re-renders this page."
- **Side column, bottom: the selected panel.** Its number as a heading ("Panel 2"), then
  framing (the same list `story.newShot`'s dialog draws, lifted to one shared constant),
  camera (one text field), cast (the shot's cast as a row of toggles, each with pose and
  expression fields when on), and art notes (one box). Each commits through
  `story.setPanels` on blur or Ctrl+S, the way the Asset editor's note boxes commit. A
  panel's art notes travel with the panel rather than through an `art.setNotes` rung
  because a panel is not an entity: it has no identity outside its page's list, and the
  agent edits it through `set_panels`. With no panel selected the section reads "Select a
  panel on the page to edit its framing, camera and cast."
- **Alignment**: everything left-aligned; the header's verdict is the one right-aligned
  element, so the eye finds it without a colour.

### The command, and what each control records

- `story.setPanels(scene, shot, panels)` replaces the page's whole panel list. `panels` is
  a JSON string with `digest: true`, the way `gengraph.apply` carries a graph, so
  `commands.jsonl` records a size and the palette form shows a size label. An empty list
  makes the shot a single frame again; a list on a frame makes it a page. The rule is
  `setPanels` in `@vn/scriptedit`; its message, and so the command's `check`, ends "The
  page is drawn again on the next run." unconditionally, since geometry, framing, camera,
  cast and art notes are in the prompt under both lettering modes. It refuses a corner off
  the page, a panel casting someone the shot does not frame, a line the shot does not
  cover, and a line in two panels, each by name. The editor clamps a dragged vertex to the
  page so the refusal is never reached by a drag.
- A vertex drag is not an interaction, for the reason a text edit is not one: it has no
  enumerable targets to judge. Each vertex handle is recorded as a `story.setPanels` offer
  with `supplies: ['panels']`, and the drag commits once on release.
- A line drop is an interaction, `page.letter`, because each panel is a target with its
  own verdict: its `targets` are the page's panels, each judged by `setPanels` with the
  line moved there (the panel already holding the line is refused as a no-op), and the
  drop commits `story.setPanels` with the resulting list.
- A template glyph and each field in the side column record a `story.setPanels` offer with
  the list the pick or the edit would produce.
- Page-scope shortcuts, listed in `SHORTCUTS`: arrows nudge the focused vertex by 0.5% of
  the page and Shift-arrows by 2%; Delete removes the focused vertex, refused at three
  with the tooltip saying so; Escape deselects. Tab is left to the browser's focus order,
  which walks the panel hit areas in reading order.

### Interaction on the page

- Click a panel to select it.
- Drag a vertex to move it. Double-click an edge to add a vertex. Every drag commits once
  on release, so an undo is one step.
- Drag a line row onto a panel to letter it there.
- Pick a template glyph to reshape, at that template's panel count.
- Nothing snaps and nothing animates. A vertex lands where it is dropped, clamped to the
  page.

### Play

- A frame whose line belongs to a panel gets `Frame.panel` (the polygon). The stage draws
  the page as now, then an `<svg>` fitted to the picture's own box with one `<path>` of
  the page minus the panel (even-odd fill) in ink at 55%. The panel is not outlined.
- The overlay crossfades over 180ms when the playthrough moves between two panels of one
  page; under `prefers-reduced-motion` the new dim is drawn without a fade. The
  click-to-advance hint is unchanged.
- On a page frame the dialogue box sits below the picture rather than over it, because a
  3:4 page fills a landscape pane's height and the box would cover the bottom tier, which
  is the lit panel for the page's last lines. A single frame keeps the box over the
  picture, which is the visual-novel convention.
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

- One accent per side: sodium is the author's, signal is the machine's, and nothing else
  on the surface takes a colour, so the page's own colours are the loudest thing on
  screen.
- The page is edited on the page. A number appears in the side column only as the heading
  that says which panel the column is about.
- Every tooltip that would re-render ends with the command's own sentence, and a refused
  control says why in the same place.
- The empty states carry no decoration. An undrawn page is a pale sheet with its outlines;
  a frame shot is that sheet with no outlines and the glyph row lit.

### Cost to undo

- Removing the `page` editor resets every stored layout that named it (`buildable()`
  discards a layout naming an area the build lacks) and its pins with them; a saved
  `LayoutFile` naming it fails with "could not be built in this window".
- To delete: the `PinField`/`PIN_NOUN` members, `DocNode.panels`/`ClaimNode.panels` and
  the main stamp, the `page.letter` interaction, `story.setPanels` and `set_panels`, the
  `page` rules module, its situations, its `SHORTCUTS` rows, the `@vn/artgen/layout`
  subpath; then `pnpm gen:uxmodel`, the anchor sweep and `pnpm gen:command-table`.
- `commands.jsonl` keeps its `story.setPanels` rows harmlessly. `Shot.panels` and
  `panelBoxes` are Stage 2's data and stay either way.

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
  skill warns about and the brief forbids. Cut; the glyph shows the layout, and the
  tooltip says what the pick keeps.
- **A "Save" button.** Every other editor commits on blur or on release; a save button
  would make this the one surface with unsaved state. Cut.
- **Mono type for panel numbers and line indices** is the small-data-label default. The
  numbers on the page are display type; the indices in the line list are sans in mist.
- **What stayed generic on purpose:** the two-column shape, because a canvas with a column
  is what the fixed points describe, and the framing dropdown, because it is the same list
  `story.newShot`'s dialog already draws for the same field.

## Review by a fresh context

Pressure-tested on 2026-09-16. Each finding and what it changed:

1. A line move between two panels of one shot is not expressible through
   `story.setCoverage` (the shot's line set does not change, so the op refuses as a
   no-op), and a drop with a per-target verdict is a gesture the shell requires to be an
   interaction. **Fixed**: `story.setPanels` carries the whole partition, `setPanels` in
   `@vn/scriptedit` is the rule, and the drop is the `page.letter` interaction judged by
   it. `story.setCoverage` is no longer named by this design.
2. The claim tie-break was wrong: the route ranks visibility first, so an open Shot
   Coverage takes a page shot whatever the list order; and a `secondary` claim on frame
   shots would send a frame to Page whenever Page was open and Shot Coverage was not.
   **Fixed**: Page claims page shots only, the visibility rule is stated and accepted, and
   the menu-order side effect is recorded.
3. `story.page` duplicated `story.coverage`, which already carries almost everything; a
   read is also not where a price belongs. **Fixed**: the read is `story.coverage` with
   `CoverageShot.panels` widened to the full `PagePanel` plus `panelBoxes?` and a
   main-computed `layout?` verdict; the price is the command's `check`.
4. `letteredPagesNote` is empty under `lettering: runner`, but every panel edit re-renders
   under both modes; the prop shape and the vertex clamp were undecided. **Fixed**: the
   command's own sentence is unconditional; `panels` is a digested JSON prop; the editor
   clamps.
5. SVG children take no `title`, so on-page controls drawn in the `<svg>` would have no
   tooltip. **Fixed**: the `<svg>` is paint-only and the hit areas and handles are DOM
   nodes over it.
6. A vertex drag has no shape in the anchor vocabulary, and the page's keys were not in
   `SHORTCUTS`. **Fixed**: handles record a `supplies` offer, the reason a vertex drag is
   not an interaction is stated, and the shortcuts are listed; Tab is dropped in favour of
   the browser's focus order.
7. `@vn/artgen`'s barrel reaches `@vn/store` and `@vn/providers` and cannot be bundled
   into the renderer. **Fixed**: `layout.ts` is exposed as `@vn/artgen/layout`, on the
   `./slotaddr` precedent, and the verdict is computed in main.
8. Templates have fixed panel counts, so "three-tier with the last tier split" and "the
   page's current count" were impossible, and growing was undefined. **Fixed**: the sample
   is `two-tier`; picking a template sets the count; the grow case and the match rule are
   defined; even layouts from two to six are in the row.
9. The dialogue box covers a page's bottom tier. **Fixed**: on a page frame the box sits
   below the picture. The crossfade state the plan assumed is what the Stage 3 code keeps
   (`this.lit`), so that part needed no change.
10. The anchor sweep clicks the first shot of `examples/mySampleRepo`, which has no page,
    and the UX model needs a `page` rules module. **Fixed** in the deliverables: the sweep
    selects a shot with panels for the Page editor when the project has one, a page shot
    is added to the sample repo, and the rules module and situations are listed.
11. A pin freezes `shotId` alone while `ui.sceneId` stays live. **Fixed**: the editor
    reads its scene off the shot id.
12. `ClaimNode.panels` is read off `DocNode`, and the tree's badge is the framing, not
    `page · N`. **Fixed**: both fields, the badge, and `document-tree.md`.
13. Several headings and principles were fragments or metaphors under
    `docs/reference/proseStyle.md`. **Fixed** in this revision.
14. No cost to undo was stated. **Fixed**: the section above.

Minor findings, also taken: the editor count is no longer stated as a number; a panel's
art notes are explained as travelling with the panel rather than as a rung; the framing
list is lifted to one constant.

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

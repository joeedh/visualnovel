# Pipeline contracts

Lists the invariants of the generative pipeline that cost money or silently corrupt
provenance when they are broken. Each invariant is stated with the failure it prevents,
because most of them were written down after that failure happened.

These implement the system design in
[`../history/vn-generator-report.md`](../history/vn-generator-report.md).

The invariants are moving into code, each as a `contract({...})` declaration beside the
code that enforces it, and are deleted from this page as they move
([`../plans/contracts-into-code-and-workflows.md`](../plans/contracts-into-code-and-workflows.md)).
`pnpm contracts <query>` lists the ones already moved. `packages/contracts/contracts.json`
holds every one's summary (id, rule, subjects) and the subject map, and
`packages/contracts/contracts/<area>.json` holds the full records of one area, so a reader
opens the summary file and then the one shard it needs.
[`../../CLAUDE.md`](../../CLAUDE.md) describes the package layering, and
[`packages.md`](packages.md) describes it package by package.

<!-- toc -->

- [Scenes, shots, and lines](#scenes-shots-and-lines)

<!-- tocstop -->

## Scenes, shots, and lines

- **A storyboard is single frames or manga pages, and a page's panels carry their own cast
  and lines.** That a storyboard is decomposed once and kept is `storage.storyboardKept`
  (`pnpm contracts storage.storyboardKept`).
    - `shot_form` (`frames`, the default, or `pages`) decides whether a new storyboard is
      single frames or manga pages of panels. Under `pages` the system prompt tells the
      model to make every shot a page and gains the page vocabulary (the template names
      with their panel counts, the camera vocabulary, the bound); under `frames` it never
      contains the word "panel", whatever the art style or the notes say, so the notes
      cannot turn frames into pages on their own. The notes bring the staging-sheet
      paragraph, and either brings the wider answer format. The agent's
      `propose_storyboard` reads the same field and takes a `form` argument that overrides
      it for one scene, which the agent passes only when the author explicitly asks for
      the other form. The desktop app writes the field through `project.setShotForm`, a
      dropdown on the Project pane.
    - A shot with `panels` is a page: one image of several panels, each with an outline in
      page fractions, its own framing, camera and cast, and the lines it letters. A
      panel's subjects must be in the shot's `subjects`, or `readShots` refuses the file
      with `panel_subject_not_in_cast`; a covered line no panel letters is reported as
      `line_in_no_panel` and the page still renders. A page's prompt is built by
      `buildPageChunks`, and under `lettering: model` its lettered lines are in the prompt
      verbatim, so the text and its panel assignment are in the task hash: a coverage take
      on a page, or a line edit inside one, re-keys the page. Every host's coverage take
      says so through `letteredPagesNote`. `lettering` defaults to `runner`, since the
      Stage 2 live check found the default image model unfit for lettering and only the
      expensive ones fit; a project that wants the model to letter says so.
    - A panel's `bubbles` (`PanelBubble`: the line, an anchor, an optional tail, in page
      fractions) are authored and outside the prompt: no builder reads them, so
      `story.setBubbles` and the agent's `set_bubbles` (one rule, `setBubbles` in
      `@vn/scriptedit`) re-key nothing. A bubble's line must be one its panel letters;
      `readShots` drops a bubble whose line left the panel, and `setPanels` drops one
      whose line it moved to another panel, since the anchor was placed against the old
      one. The exporter copies them into the playable only under `lettering: runner`.
    - `shotData.panelBoxes` holds the panel boxes the reviewer measured on the accepted
      image, from `DefectReport.observed`, which the reviewer fills only for a page. It is
      derived, like `proseHash`, and a rerun that reports the same image leaves it alone.
      The runner matches every reviewer's boxes against the intended outlines
      (`matchPanels`, IoU at or above `LAYOUT_IOU`) and files a `layout` defect of its own
      only when none of them match, because a reviewer's measurement can be off while none
      invents a match for a wrong page; a page no reviewer measured gets no layout
      verdict. The boxes stamped are the matching reviewer's.

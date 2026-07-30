# Line editing in FLOOR

Status: **in progress** — step 1 is shipped; 2–7 are not. Move five of
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md),
and the first surface that can change prose. It consumes
[`scene-editing-commands.md`](scene-editing-commands.md) and adds no write path of its own. Its
sibling is [`script-composition-in-studio.md`](script-composition-in-studio.md); the division is
one sentence — **FLOOR edits a line, STUDIO edits the script.**

<!-- toc -->

<!-- tocstop -->

## Why here

The coverage timeline already puts a scene's prose down the page with the shots illustrating it
bracketed beside it. It is the one place in the app where you can see a line **and** what the
pipeline made of it, which makes it the right place to fix a line and the wrong place to write one.
An author reading the strip and spotting a typo, a wrong name, a line that reads badly under the
frame it produced should be able to correct it without changing rooms.

So the scope is correction, not composition: **edit the text of a line that exists, and nothing
that restructures.** No insert, no delete, no reorder, no new scene. Every one of those changes
which rows exist, which re-lanes the brackets — and this surface's whole design rests on layout
changing at commit and never during a gesture.

## What it costs, said plainly

A coverage edit is free — and so is a prose edit, which is the problem. `buildShotPrompt` never
reads a line's text (only the P7 reviewer spec does, and that never enters a task's `inputs`), so
retyping a covered line changes no task hash and re-renders nothing: **the frame keeps illustrating
words the scene no longer contains, and nothing notices.** This surface is where that becomes
visible, because it is the only one that draws the connection.

Two obligations follow, and they are the substance of this plan rather than decoration:

- **Say it before.** The commit affordance reports how many *rendered* shots cover the line, from
  `story.setLineText`'s `check` — not a count the renderer computes, or the UI and the command
  could disagree. `session.previewSceneEdit` already returns that sentence.
- **Show it after.** A shot whose covered prose has changed since it was generated is **drifted**,
  and it is marked. This is the surface drift marking has been waiting for, which is why it lands
  here rather than in the commands plan.

## Drift is a comparison, not a flag

A drifted shot is one whose art was generated from prose that no longer reads the same. The
temptation is to set a `drifted: true` when an edit happens, and it is wrong for the reason
`shotData` is rewritten wholesale each pass: a flag is a claim that can be stale, restored from an
old commit, or missed by an edit that took another path.

Derive it instead — but **not** from the task hash, which is exactly the hash that does not move: it
is blind to line text by design. Derive it from the prose itself. Record, beside the generated
image, a hash of the covered lines' text at generation time; hash the covered lines now. **Drift is
those two disagreeing** — computable, self-healing, and correct even for edits made through the
CLI, the agent, or by hand in the chunk file. It costs one hash per shot on load. Where the recorded
hash lives is this plan's first design question, since `shotData` is the only per-shot place a run
already writes, and a shot that predates the field has to read as *unknown* rather than as drifted.

It renders as a state on the bracket, not a new colour: the tokens already say
`--sodium` is authored and `--signal` is machine, and drift is precisely the machine side falling
behind the authored side. `--vermilion` is spent on gaps and refusals. A dashed or dimmed bracket
with `DRIFTED` in the existing `--mono` label is enough, and it must be distinguishable from
`COVERS NOTHING`, which is a different problem with a different fix.

## The empty state has to change

`Timeline.tsx:156` refuses to draw anything when a scene has no decomposition:

> `{data.sceneId}` has no decomposition yet — run the pipeline past the gate.

That is right for a coverage editor and wrong the moment the surface can edit prose. **Editing a
line is exactly what you want to do before spending money on art**, and today the app's answer is
"generate first". So an undecomposed scene must render its script column with no bracket columns —
editable, with a note explaining that shots appear after a run rather than a refusal to show
anything. This is a small change and it is the one that decides whether the feature is useful
before a run or only after.

## The gesture

Click a line's text to edit it in place; Enter or blur commits, Escape reverts. One
`story.setLineText` per commit — a keystroke is continuous, its commit is not, the same rule the
drag gestures follow.

- **Not an interaction.** Like inline label editing in the branch editor: no carried token, no
  enumerable targets, nothing an agent could usefully ask "what would this drop do" about. It stays
  a plain affordance, and the reason is worth a comment since four gestures nearby are declared.
- **It must not fight the drag.** `.tl-grid.dragging` drops pointer events on the script column so
  the hit bands can be reached (`Timeline.tsx:163`, `timeline.css:80`). Editing must be impossible
  while a coverage drag is live, and a coverage drag must be impossible while an editor is open —
  two modes over one grid, and the cheapest correct answer is that entering one closes the other.
- **Rows are grid rows, so the row grows as you type** and the brackets beside it follow, because
  they are positioned by row rather than by measured pixels. That falls out of the existing layout;
  it is worth a test that a multi-line edit does not re-lane anything.
- **The speaker is not editable here.** Changing who says a line changes its `kind`, which changes
  the row's shape and the exporter's beat type. `story.setSpeaker` exists; it belongs in STUDIO.

## Steps

1. ✔ **`editing.ts`, pure, beside `coverage.ts`.** Which row is editable, what the commit's props
   are, and the two-modes rule (an open editor suppresses grabs, a live drag suppresses editing).
   Node tests, as with every other pure half in this room.

   As shipped: `canEdit`/`canGrab` over a `StripMode`, `lineOf` (folds a pasted newline — a line
   with a newline in it is not one line), `commitOf` (the `story.setLineText` invocation, or `null`
   when the draft says what the line already says), and `noticeForCheck`. Three corrections to the
   text above. **Every row is editable**, whatever its kind, so "which row" turned out to be no
   function at all — the restriction that matters is the speaker, and that is an absence in the
   `.tsx`. **"Entering one closes the other" is wrong**: closing an editor commits it, so grabbing a
   handle would silently write a half-typed line and reload the strip under the gesture — the grab
   is refused instead. And the **no-op** is decided locally while an *empty* line is not: one is
   whether an act happened (an undo point that undoes nothing is worse than none), the other is
   legality, which is `@vn/scriptedit`'s and would be a second copy of the rule here.
2. ✔ **Undecomposed scenes render.** Script column only, no bracket columns, an explanatory note
   rather than a refusal. Ahead of the editor itself, since it is independently useful.

   As shipped: the `!data.decomposed` branch is gone, the grid emits no bracket columns when
   `cov.lanes` is 0, and a `.tl-note` says where the shots are. Two things the step did not
   anticipate, both the same mistake in different clothes — **an undecomposed scene is a pre-run
   state, not a defect.** Every line would otherwise draw the vermilion `gap` gutter ("this line
   renders with no image"), and the bar would read `0 shot(s) · 6 uncovered`. Both are literally
   true and both say the scene is broken, so the gutter waits for a decomposition and the bar says
   `no shots yet`.
3. **In-place editing in `Timeline.tsx`.** Click to edit, Enter/blur to commit, Escape to revert,
   commit through `story.setLineText`. The affected-shot count from the command's `check`, shown
   before the commit.
4. **Drift derivation.** Record a hash of the covered lines' text when a shot's image is written,
   and compare it with the lines' hash now — a pure function in `@vn/pipeline` beside the prompt
   builder, not in the renderer, since the FLOOR task list and inspector will want the same answer.
   Surfaced through `sceneCoverage`. **Not** the task hash: prose is not in a task's `inputs`, so
   comparing task hashes compares a value to itself.
5. **Drift rendering.** The bracket state and its `--mono` label, distinct from `COVERS NOTHING`.
6. **Verify on `examples/mySampleRepo`.** Edit a covered line, confirm the shot marks drifted, then
   `vngen run` and confirm it **stays** drifted — nothing rehashed, so nothing re-rendered, and that
   is the whole reason the mark exists. Edit an uncovered line and confirm nothing marks. Undo the
   edit and confirm the mark clears, because the derivation is a comparison rather than a flag.
7. **Docs.** This file's As-shipped section; [`../desktop-app.md`](../desktop-app.md)'s
   coverage-timeline section (which says "every edit here is free: nothing rehashes and no art is
   invalidated" — true, and from here on the incomplete half of the story, because the surface will
   also edit prose and that is free in exactly the way drift is the price of);
   [`../command-system.md`](../command-system.md) if the command set moves.

## Not in this plan

- **Anything structural.** No insert, delete, reorder, split, merge or new scene. Those exist as
  commands after `scene-editing-commands.md` and they are reachable from the palette; the *gesture*
  for them is STUDIO's.
- **Editing the speaker or the kind.** Same reason.
- **Editing from the FLOOR task list or the inspector.** They are about a task, not a scene.
- **Acting on drift.** Marked, not re-run and not queued. Deciding what to regenerate is
  `pipeline.run`'s job and the author's.
- **Rich text.** A line is a string.

## Alternatives considered

- **A separate editor panel beside the strip.** Puts the line being edited somewhere other than
  where the author is looking, and gives up the one property that makes this surface right — the
  prose and the art it produced are on the same row.
- **Batch edits committed together.** One `CommandRecord` covering six edits makes undo coarser
  than the act being undone, and an author expects a typo fix to undo as a typo fix.
- **Warn and block edits to covered lines.** Refusing the author's own correction to protect
  generated art inverts which one is the product.
- **Store drift as a field on the shot.** The flag-versus-derivation argument above; it is the same
  reasoning that keeps `tasks.jsonl` and `manifest.json` authoritative over a restored shots file.

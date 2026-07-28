# Line editing in FLOOR

Status: **planned**. Move five of
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

A coverage edit is free; a prose edit is not. `buildShotPrompt` is built from the covered lines'
text, so retyping a covered line changes that shot's task hash and invalidates its art. This
surface is where that becomes visible, because it is the only one that draws the connection.

Two obligations follow, and they are the substance of this plan rather than decoration:

- **Say it before.** The commit affordance reports how many *accepted* shots cover the line, from
  `story.setLineText`'s `check` — not a count the renderer computes, or the UI and the command
  could disagree.
- **Show it after.** A shot whose covered prose has changed since it was generated is **drifted**,
  and it is marked. This is the surface drift marking has been waiting for, which is why it lands
  here rather than in the commands plan.

## Drift is a comparison, not a flag

A drifted shot is one whose art was generated from prose that no longer reads the same. The
temptation is to set a `drifted: true` when an edit happens, and it is wrong for the reason
`shotData` is rewritten wholesale each pass: a flag is a claim that can be stale, restored from an
old commit, or missed by an edit that took another path.

Derive it instead. The task graph records the hash a shot's art was produced under; the current
lines produce a hash now. **Drift is those two disagreeing** — computable, self-healing, and
correct even for edits made through the CLI, the agent, or by hand in the chunk file. It costs one
prompt rebuild per shot on load, which is deterministic and cheap.

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

1. **`editing.ts`, pure, beside `coverage.ts`.** Which row is editable, what the commit's props
   are, and the two-modes rule (an open editor suppresses grabs, a live drag suppresses editing).
   Node tests, as with every other pure half in this room.
2. **Undecomposed scenes render.** Script column only, no bracket columns, an explanatory note
   rather than a refusal. Ahead of the editor itself, since it is independently useful.
3. **In-place editing in `Timeline.tsx`.** Click to edit, Enter/blur to commit, Escape to revert,
   commit through `story.setLineText`. The affected-shot count from the command's `check`, shown
   before the commit.
4. **Drift derivation.** The pure comparison of recorded-vs-current prompt hash, in `@vn/pipeline`
   beside the prompt builder that already owns the hash — not in the renderer, since the FLOOR task
   list and inspector will want the same answer. Surfaced through `sceneCoverage`.
5. **Drift rendering.** The bracket state and its `--mono` label, distinct from `COVERS NOTHING`.
6. **Verify on `examples/mySampleRepo`.** Edit a covered line, confirm the shot marks drifted,
   re-run, confirm it clears; edit an uncovered line, confirm nothing rehashes; undo an edit, and
   confirm the drift mark clears because the derivation is a comparison rather than a flag.
7. **Docs.** This file's As-shipped section; `CLAUDE.md`'s coverage-timeline section (which
   currently says "This is the only surface that edits `Shot.coversLines`, which `buildShotPrompt`
   ignores, so every edit here is free" — the second half stops being true); `docs/command-system.md`
   if the command set moves.

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

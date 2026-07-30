# Script composition in STUDIO

Status: **partial** — steps 1–4 are shipped and carry their own as-shipped notes below, so the
column already writes and reorders prose; steps 5–9 are not built. Move six of
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md),
and the last of them. It consumes [`scene-editing-commands.md`](scene-editing-commands.md) and adds
no write path of its own. Its sibling is [`line-editing-in-floor.md`](line-editing-in-floor.md);
the division is one sentence — **FLOOR edits a line, STUDIO edits the script.**

<!-- toc -->

<!-- tocstop -->

## Why here

STUDIO is the authored side: the rail, the agent conversation, and the branch editor share one
column so that wiring two scenes and asking the agent to write what goes between them is one
continuous gesture. Writing that scene yourself is the missing third thing, and it belongs in the
same column for the same reason — composition, the agent, and the shape of the story are one
activity.

FLOOR's timeline can already correct a line. What it deliberately cannot do is change **which lines
exist**, because every such change re-lanes the brackets it is built around. Everything on that
list lands here: write a scene from nothing, insert, delete, reorder, change a speaker, split a
scene, merge two.

## A third mode, sharing a selection

`view.mode(room=studio mode=script)`. `STUDIO_MODES` gains `script: 'the script editor'`
(`apps/desktop/src/main/commands/view.ts:25`), `StudioMode` gains the member, and the `UiEffect`
pairing keeps working unchanged — this is exactly the extension point the split-per-room `mode`
member exists for.

**The scene selection is shared between `branches` and `script`**, the way FLOOR's `list` and
`graph` share one selection and one inspector. Clicking a card and switching to the script is how
you get from structure to prose; without a shared selection it is two lookups and the modes stop
being two views of one thing.

Not a panel inside the branch editor. The cards are deliberately small, the canvas under them is
the domain-free shared layer (`renderer/graph/`), and prose in a viewport that pans and zooms is a
worse text editor than a column.

## The rule that keeps this from becoming a document editor

A text editor's model is a buffer, and a buffer's edits are keystrokes. This surface's model is a
list of lines, and its edits are **commands** — one authorial act, one `CommandRecord`, one undo
point. That boundary is the whole reason the app can say what it did.

So the mapping from typing to commands is fixed, and it is the first thing to get right:

- Typing inside a line changes nothing until commit; committing is `story.setLineText`, on blur or
  Enter, exactly as in FLOOR.
- **Enter at the end of a line opens a composer row**, and committing that row is
  `story.insertLine`. It is an authorial act on its own — the author asked for a line — so it is
  its own undo point, and undoing it removes the line they typed.

  This was planned the other way round ("Enter **is** `story.insertLine`, committed immediately,
  because the new line must exist before it can be typed into") and step 2 found it impossible:
  `insertLine` refuses a line with no text, and it has to, because an empty line has no lossless
  Fountain form. A row that is not a line yet removes the need — nothing has to exist before it
  can be typed into if the thing being typed into is the draft.
- Backspace at the start of an empty line is `story.deleteLine`. Backspace at the start of a
  non-empty one does **nothing** — merging two lines is a delete plus a text change, and silently
  spending two commands on a keystroke that usually means "I mis-hit" is worse than doing nothing.
  "Empty" is the *draft's*: clearing a line and pressing Backspace deletes it, which is the act
  `setLineText`'s own refusal ("A line cannot be empty — delete it instead") names.
- Dragging a line's handle is `story.moveLine`, through the `script.moveLine` interaction the
  commands plan declares. This surface is its first consumer, and it should be the first thing
  built that proves an interaction can be authored before its UI.

An author typing a paragraph therefore produces one `insertLine` and one `setLineText` per line,
which is what "undo the last thing I did" should mean in a screenplay.

## Split, merge and the cost they carry

`story.splitScene` and `story.mergeScene` are this surface's two structural gestures — a split at a
line boundary, a merge with the scene a `next` edge leads to. Both **detach coverage** across the
boundary, because line ids are scene-scoped and a line that changes scenes cannot keep its id. The
commands plan makes that explicit; this plan is where the author sees it.

The affordance shows the command's `check` note before committing — how many shots detach, named —
and the branch editor is where the result is legible afterwards, which is the other argument for
sharing the column. A split that detaches six shots is usually a split in the wrong place, and the
count is how the author finds that out before paying rather than after.

## Creating and deleting scenes

`story.newScene` has no natural home in a graph of wired cards and no home at all in a column of
one scene's prose — so it gets both entries, and they mean different things:

- **In `branches`**: a new scene on empty canvas, unwired, which the author then connects with the
  existing gestures. This is the structural act.
- **In `script`**: "new scene after this one", which creates it *and* sets `next`, because a scene
  written while reading another one is almost always its continuation.

`story.deleteScene` lives in `branches` only. Deleting a scene is a graph act with graph
consequences — it refuses while anything points at it — and offering it from inside the prose of
the scene being deleted is an invitation to lose work.

## Where diagnostics land

The STUDIO rail gains a `DIAGNOSTICS` group in [`allocated-line-ids.md`](allocated-line-ids.md)
step 6, deliberately display-only. This is the surface that makes them clickable: a diagnostic
carries `where` (a scene id), so selecting one selects that scene and switches to `script`. It is
a few lines once the shared selection exists, and it turns the rail from a report into a way in.

## Steps

1. ✔ **The `script` STUDIO mode.** `STUDIO_MODES`, `StudioMode`, `view.mode`, and the shared scene
   selection lifted so `branches` and `script` read the same one. No editing yet — the mode renders
   the selected scene's lines read-only. Independently verifiable, and it proves the plumbing
   before any gesture exists.

   As shipped, and verified against a copy of `examples/mySampleRepo` over CDP: `script` is the
   third `StudioMode`, `Studio.tsx` owns `scene: string | null`, and
   `renderer/rooms/studio/script/` holds `ScriptEditor.tsx` over a pure `script.ts` with a `tests/`
   sibling. Four things the step did not say:

   - **The selection is filled in by whichever editor mounts first**, from `graph.start` (never
     `scenes[0]` alone — a directory has no document order). It has to be written *up* into the
     room rather than kept as a local default, or the two modes disagree about what "the scene" is
     the first time you switch.
   - **No new IPC channel.** `story:coverage` already answers with a scene's lines, so the script
     column reads it rather than adding a second line-level read that could give a different
     answer about what a scene contains. It carries shots too, which this step ignores.
   - **Clicking a card now selects as well as seeding** the composer with `Revise scene <id> — `.
     Both are reads, so one click can do both; and `.scene-card.sel` is one class for "selected",
     with the connect-drag highlight it already had.
   - **The rail's SCENES head carries two mode buttons**, not one cycling three. `branches` and
     `script` each toggle back to `convo`, because one button cycling three modes puts the branch
     editor two clicks away half the time. The selection survives the trip through `convo` — it is
     the room's, not the surface's.
2. ✔ **`script.ts`, pure, beside the room.** The keystroke-to-command mapping above, line-handle hit
   resolution, and the split/merge boundary rules. Node tests; the `.tsx` stays thin, as everywhere
   else in this renderer.

   As shipped: `keyAct(scene, editing, draft, key)` answers `type` | `discard` |
   `run(steps, then)` — an ordered list of invocations plus where the editor goes next, so the
   `.tsx` runs commands and moves focus without deciding anything. Four things the step did not
   say:

   - **The Enter rule was wrong and is corrected above.** An `Editing` row is either an existing
     line or a **composer** (`{row: 'new', after}`) that is not a line yet; `insertOf` is what it
     commits. `COMPOSED` stands in for the id the insert will mint, and `insertedAfter` resolves it
     from the reload by position — no command message is ever parsed.
   - **A new line inherits attribution from the line above** (`attributionAfter`): a dialogue block
     continues under the same cue, a parenthetical is followed by the spoken line, and everything
     else starts narration, because `insertLine` refuses a speaker on a kind nobody speaks.
   - **The shared half moved now rather than "if the two drift".** `lineOf`, `commitOf`, `Notice`
     and `noticeForCheck` are `src/shared/lineedit.ts`; `timeline/editing.ts` keeps only the
     strip's two-gesture rules. STUDIO reaching into `rooms/floor/` is how a second copy starts,
     and step 3 says reuse.
   - **The move gesture is judged against a synthetic one-scene `ScriptState`** (`moveStateOf`),
     because `script.moveLine.targets` wants a `ScriptState` and the column has a `SceneCoverage`.
     A move reads one scene's line order and nothing else, so the line-id allocator is left absent
     rather than invented — a test drives the real interaction through it to prove the state is
     enough.
3. ✔ **In-place editing and Enter/Backspace.** `setLineText`, `insertLine`, `deleteLine`. The FLOOR
   editor's affordance, reused rather than reimplemented — if the two drift, the pure half moves to
   `src/shared/`.

   As shipped: `nextEditing` and `scriptRows` finish the pure side — where the editor goes after an
   act, and where a composer row sits among the lines — and `ScriptEditor.tsx` gained one `act`
   function that runs a `keyAct` result's steps in order, re-reads the scene, and opens whatever the
   act said comes next. Four things the step did not say:

   - **A command's round trip is a frame the column has to survive.** `act` closes the editor,
     awaits `command:exec` (~800 ms against a real project), re-reads `story:coverage`, and only
     then reopens — so `nextEditing` is given the *reloaded* lines rather than the ones the keystroke
     saw, which is the only way a composed line's freshly-minted id can be found at all.
   - **A refusal reopens the row it came from** with the draft intact and the command's own sentence
     beside it. That makes `setLineText`'s "a line cannot be empty" reachable rather than
     theoretical — and Backspace on an emptied line is the gesture that means it, so the refusal is
     never what an author gets for clearing a line.
   - **Only `preview` notices are cleared as you type.** An `ok` or `refused` sentence describes
     something that happened and stays until the next act; a preview describes a draft, and a draft
     that no longer says anything has nothing to preview.
   - **Enter needs a line to be pressed at the end of, so an empty scene needs a way in.** Two
     buttons the step did not mention: `.sc-start` ("_arrival_ has no lines yet — write the first
     one") when the scene is empty, and a `+ line` after the last line. Both open a composer;
     neither is a second write path.

   Verified live over CDP against a scratch copy of `examples/mySampleRepo`: retyped a line, Enter at
   its end opened a composer, composing inserted `arrival:L4` (dialogue, cue inherited from the AIKO
   block above) between L2 and L3, Escape discarded the trailing composer, and Backspace on an
   emptied L4 deleted it and reopened L2. The file came back to three lines with `nextline: 5` — the
   consumed id is not recycled.
4. ✔ **`story.moveLine` by drag**, through `script.moveLine`, with the same accept/refuse overlay the
   branch editor and the timeline draw from their interactions.

   As shipped: the gutter is the handle — it is already the row's name, and a line's name is what a
   move is about. The grab judges every insertion point once (`scriptMoveLine.targets` over
   `moveStateOf`), each pointer move reads that answer off by row (`dropTarget` over measured
   `RowBox`es, the drag's only DOM read), and the drop runs `verdict.invoke` verbatim through the
   same `act` a keystroke uses. The carried row dims and stays put; only the insertion rule moves,
   and the order changes on release. Three things the step did not say:

   - **The verdict→`Notice` rule moved to `src/shared/lineedit.ts`** (`noticeForVerdict`) rather than
     being written a second time, and FLOOR's timeline now reads it from there. That module already
     held `Notice` and the `check` half; a `Verdict` is the same question asked mid-gesture.
   - **`nextEditing` takes `from: Editing | null`.** A drop commits a command with no editor open, so
     there is no row for a refusal to hand a draft back to — which is what `act`'s `from` is for.
   - **The refuse tone is drawn but currently unreachable from this surface.** `moveLine`'s only
     refusals are a line that does not exist and "after itself", and `targets` omits the latter, so
     every insertion point the column offers accepts or is left out. The rule is still "draw the
     verdict, whatever it says" — the same as the timeline — so a refusal `moveLine` grows later
     needs no work here.

   Verified live over CDP: carried `arrival:L3` up, watched the sentence change per insertion point
   (`Moved arrival:L3 to the top in arrival.` / `… after arrival:L1 …`), saw the rule and the
   sentence both vanish over its own row, dropped at the top and got the reorder in
   `scenes/arrival.md`, then carried it back to the end. The gesture never opened an editor.
5. **`story.setSpeaker`.** The one edit that changes a line's `kind`, and therefore the exporter's
   beat type — it belongs here rather than in FLOOR for exactly that reason.
6. **Split, merge, new scene, delete scene.** With the detachment counts from each command's
   `check` shown before commit, and `newScene`'s two homes.
7. **Clickable diagnostics.** The rail group selects a scene and switches mode.
8. **Verify on `examples/mySampleRepo`.** Write a scene from nothing, wire it, run the pipeline
   past the gate, confirm it renders in PLAY. That end-to-end pass — authored in the app, generated,
   watched — is the thing this whole direction was for, and it is the acceptance test.
9. **Docs.** This file's As-shipped section; `CLAUDE.md`'s STUDIO and renderer-layout sections and
   the `view.mode` mode list; `docs/command-system.md`'s mode table; `docs/desktopAppState.md` if
   the selection persists.

## Not in this plan

- **A second write path.** Every gesture here terminates in a command from
  `scene-editing-commands.md`. If a gesture needs something no command offers, the command is
  missing and that is where it gets added.
- **Rich text, formatting, or a Fountain-syntax editor.** The author edits lines with kinds, not
  Fountain source. Someone who wants the source has `vngen screenplay`.
- **Reordering scenes.** Scene order is the branch graph, not a list. There is nothing to reorder.
- **Multi-line selection and bulk operations.** One act, one command; a bulk operation whose undo
  is a single step is a bulk operation that undoes more than the author remembers doing.
- **Collaborative or concurrent editing.** `editScene` re-reads inside the operation and that is
  the whole story. Chunks removed the contention; they do not add a merge policy.

## Alternatives considered

- **Edit prose inside the scene cards in `branches`.** The cards are sized for structure, the
  canvas pans and zooms under them, and a wrapped paragraph in a graph node makes both jobs worse.
- **A fourth room.** Composition, the branch graph and the agent are one activity in the app's own
  argument for STUDIO's single column. A room boundary between writing and wiring is the boundary
  the research doc set out to remove.
- **Reuse FLOOR's timeline with an "advanced" toggle.** One surface with two rule sets, where the
  restructuring half breaks the layout invariant the other half depends on. The two-surface split
  exists precisely so neither has to hedge.
- **A buffer-based editor that diffs to commands on save.** Recovers the familiar typing feel and
  loses the correspondence between what the author did and what the record says — the diff has to
  guess whether a line was edited or replaced, and undo becomes a mystery.

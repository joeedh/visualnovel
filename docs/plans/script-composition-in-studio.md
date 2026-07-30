# Script composition in STUDIO

Status: **partial** — steps 1–8 are shipped and carry their own as-shipped notes below, so the
column already writes, reorders and attributes prose, both surfaces change which scenes exist, the
rail's diagnostics are a way into one, and the end-to-end pass — a scene written in the app,
generated, watched in PLAY — has been done against `examples/mySampleRepo`; only step 9's doc
sweep is left. Move six of
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
5. ✔ **`story.setSpeaker`.** The one edit that changes a line's `kind`, and therefore the exporter's
   beat type — it belongs here rather than in FLOOR for exactly that reason.

   As shipped: the cue on a row **is** the control that changes it — a button that looks like a cue,
   which opens a `<select>` over the project's cast plus "no one (narration)". Choosing writes
   `story.setSpeaker` through the same `act` a keystroke and a drop use. Four things the step did not
   say:

   - **The value sent is a Fountain cue, never a character id.** A prose edit is decided against the
     scene as its *file* parses (`SceneSource.scene`), where speakers are still the cues the author
     typed — so sending the resolved id `aiko` would rewrite `AIKO` as `@aiko` on the way out.
     `cueFor` is the cast member's name uppercased, which is what an author types and what
     `buildModel` resolves back to that id; verified by attributing a line and finding `HARUKI` in
     the chunk with the neighbouring `AIKO` untouched.
   - **The cast is a closed list, and an unresolved cue is offered verbatim.** The column will not
     mint a cue nothing in `characters/` answers to — naming a character who does not exist is a
     `characters/` edit, and this control writes prose. But a hand-written `KENJI` is shown on the
     row and is the picker's current option (labelled `— not in characters/`), so opening the picker
     and closing it cannot silently discard one.
   - **`isSpeakable` moved into `@vn/scriptedit`** and `setSpeaker` now asks it, because the surface
     has to decide *which rows get the affordance* synchronously and an affordance that can only be
     refused is worse than none. A transition line renders no cue slot at all; a narration line
     renders a `who?` that is invisible until the row is hovered.
   - **No `check` preview, because the run's own message already carries the cost.** `previewEdit`
     and `edit` return the same sentence, and a native `<select>` has nothing to preview on — the
     drift warning arrives with the `ok` notice ("`arrival:L1` is spoken by HARUKI. 1 rendered
     shot(s) still illustrate the old prose…"). Re-picking the cue a line already carries is not an
     authorial act: no record, no undo point — and it is the only way to leave a narration line
     alone, which `setSpeaker` would otherwise refuse ("has no speaker to clear").

   Verified live over CDP against a scratch copy of `examples/mySampleRepo`: attributed the narration
   `arrival:L1` to Haruki (row became `dialogue`, file gained a plain `HARUKI` cue), re-picked
   `arrival:L2`'s own `AIKO` and got no record, cleared it and watched the row become narration —
   three picks, two `story.setSpeaker` records.
6. ✔ **Split, merge, new scene, delete scene.** With the detachment counts from each command's
   `check` shown before commit, and `newScene`'s two homes.

   As shipped: the four acts that change *which scenes exist* are the only ones in this column that
   are **confirmed rather than run**. Each detaches shots from the lines they cover and only the
   command can count them, so the first gesture opens a strip carrying that command's own `check`
   sentence and the second gesture is the act. Split, merge and continue live in the script column
   (`script.ts`: `splitBoundaries`, `mergeTarget`, `canContinue`, `continueFrom`, `stepsOf`,
   `checkOf`); new-scene-from-nothing and delete live on the branch canvas (`branch/compose.ts`).
   Five things the step did not say:

   - **A prefilled id has to already be its own slug.** `slug` collapses every non-alphanumeric run
     to `_`, and `newScene`/`splitScene` refuse `id !== slug(id)`, so the first draft's
     `rooftop-2` was an affordance that *could only be refused* — the live `check` said so
     verbatim (`Scene ids are slugs — "rooftop-2" would be "rooftop_2".`). `proposeSceneId` and
     `freeSceneId` are underscored for that reason, and an already-suffixed scene counts up
     (`arrival_2` → `arrival_3`) instead of nesting. The unit tests happily asserted the wrong
     separator; only driving the real command found it.
   - **Deleting the selected scene has to move the room's selection.** STUDIO shares one selection
     between the canvas and the column, so without `selectionAfterDelete` the bar went on offering
     `delete ending_2` and the column would have opened a scene that no longer exists. It lands on
     the entry scene, or whatever is left, or `null` — at which point both surfaces show their
     empty invite. It is given the graph as it was *before* the delete, which is what says what
     survives it.
   - **A new scene is two commands, deliberately** — `story.newScene` then `story.setNext` — so
     undoing the wire does not delete the prose (confirmed as two records with separate
     `undo.pre/post` pairs). `checkOf` therefore shows only the *first* step's sentence, which for a
     new scene reads "…nothing points at it yet." while the strip's own label says the wire follows.
     Honest about that command, slightly odd to read; the alternative is a preview that claims work
     the first command doesn't do.
   - **`newScene` has two homes and `deleteScene` has one.** On the canvas it makes an *unwired*
     scene (wiring it is a separate authorial fact, and it is also the empty-project invite); in the
     column it means "a scene after this one" and wires it. Delete is canvas-only — offering it from
     inside the prose of the scene being deleted is an invitation to lose work.
   - **Delete asks its `check` on hover**, via `onPointerEnter` *and* `onFocus`, so a refusal is on
     screen before the pointer goes down. Because `check` and `run` share one edit function, the
     accepting sentence is past-tense (`Deleted scene_1 and its 0 line(s).`) — the wording belongs
     to `@vn/scriptedit` and is right for the record it also becomes. A new scene's `ok` notice, by
     contrast, is *lost*: moving the selection clears it, and the empty page's own invitation is the
     confirmation. Refusals are never lost, because a refusal never moves the selection.

   Verified live over CDP against a scratch copy of `examples/mySampleRepo`: split `rooftop` at a
   line and read the real detachment count (`1 shot(s) follow their lines into rooftop_2; 1 shot(s)
   lose 3 line(s) of coverage, 1 already rendered.`), merged it back, wrote `ending_2` from the
   column and watched it wire, then on the canvas wrote `scene_1`, deleted it and watched the
   selection land on `arrival` — and hovered delete over `arrival` itself for the refusal
   (`arrival is the entry scene — point start: in project.yaml elsewhere first.`), which the click
   then honoured.
7. ✔ **Clickable diagnostics.** The rail group selects a scene and switches mode.

   As shipped: a diagnostic whose `where` names a scene the workspace lists renders as a button
   (`.diag.at`) that calls one `openScene` in `Studio` — the selection and `script` mode together,
   because a diagnostic points at prose and `convo` has no prose in it. Three things the step did
   not say:

   - **`where` is an entity id, not a scene id**, and a scene diagnostic can name a scene that does
     not exist — `start:` pointing at nothing is exactly that. So which rows are a way in is a
     decision, small as it is, and it lives in `rooms/studio/diagnostics.ts` with a test rather
     than inline: a character sheet's diagnostic and a `missing_start` stay plain rows.
   - **Named `diagnostics.ts` because `rail.ts` cannot exist.** `Rail.tsx` shares the directory and
     on a case-insensitive filesystem `./Rail` resolves to `rail.ts`, which fails the renderer
     typecheck with "differs from file name … only in casing".
   - **The rail had to start refreshing.** `index.diagnostics` was read once at mount and on the
     palette's `onRan`, so following a diagnostic and fixing it left the row on screen — a report
     you can click has to be current in a way a report you can only read does not. `App` grew a
     `refreshIndex` that re-reads `workspace:index` *without* bumping `revision`, since a remount
     would throw away the column's own state mid-gesture; `Studio` passes it to both editors as
     `onEdit`, and `useBranch` takes it as an optional `afterWrite`.

   Verified live over CDP: with a hand-written orphan `[[line: L1]]` in `ending`, the rail's
   `dangling_line_id` row was a button titled `Open ending in the script column`; clicking it from
   `convo` switched to `script` on that scene, and committing one line edit — which rewrites the
   chunk from `Scene.lines` and so drops the orphan marker — emptied the group without a reload.
8. ✔ **Verify on `examples/mySampleRepo`.** Write a scene from nothing, wire it, run the pipeline
   past the gate, confirm it renders in PLAY. That end-to-end pass — authored in the app, generated,
   watched — is the thing this whole direction was for, and it is the acceptance test.

   It passes. `epilogue` was written on the branch canvas, given two lines in the script column,
   wired from the palette (`✓ending continues to epilogue.`), decomposed by Claude into two shots,
   rendered by `gemini-2.5-flash-image`, and watched in PLAY: `arrival > greet > rooftop > ending >
   epilogue`, each of the two new lines over the frame ordered for it. Five things the step was
   silent about, in the order they bit:

   - **The step cost money and could not have been done otherwise.** `pipeline.run` wires one
     `mock` prop to both "use mock providers" and `dryRun`, and `App.runPipeline` hardcodes
     `{ mock: !isLive || true }` — so the app has no offline generate at all, and the acceptance
     test necessarily spends real API budget. The run was authorized before it happened.
   - **A seeded workspace cannot see the repo's shared `keys/`.** `findRepoRoot` stops at
     `.git`, and `seedWorkspace` gives `examples/mySampleRepo` its own repo, so `secretDirsFor`
     never walks up to the monorepo's `keys/`. A live run from the app needs `$GEMINI_API_KEY` in
     the environment or a `keys/` inside the workspace.
   - **The wire had to come from the palette.** A `<select>`-free canvas drag is impractical to
     drive over CDP. The palette filters by command *name*, so a whole DSL invocation matches
     nothing — type `setNext`, pick the row, fill the props.
   - **A failed task does not record why, and nothing replans it.** The first `shot_image` for
     `epilogue__S1` threw inside `image.generate` (transient; the identical task succeeded on the
     next run). `Task` has no `error` field, and `scheduler` passes only `{ output }` to
     `setStatus`, so `tasks.jsonl` kept `status: "failed"` with `attempts: []` and no reason —
     the message survives only on the logger, which the app's stdout had swallowed. Worse, the
     `failed` node is terminal: the next run planned nothing and the CLI still printed "Gate
     cleared — all reachable shots generated." Not fixed here; both belong to the scheduler.
   - **An invented character id made a shot permanently unrenderable** — fixed, in `da45b5d`.
     `epilogue`'s second line is narration, so nobody is cast by dialogue and the P5 prompt said
     "Characters present: none"; Claude read the prose and returned `characterId: "Aiko"` against
     a sheet that is `aiko`. `coversLines` and `location` were validated against the scene but
     `characterId` was not, and the planner skips a shot whose subject it cannot resolve — so the
     shot sat unrendered behind a cleared gate and a clean `status`. `decomposeScene` now resolves
     the id case-insensitively (ids are lowercase slugs) and drops one that still does not exist.

   `examples/mySampleRepo` is gitignored, so none of this run is in the repo — the step reads as
   though the verified project were committed, and it is not.
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

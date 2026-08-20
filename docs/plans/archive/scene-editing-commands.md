# Scene editing commands

Status: **shipped** — the nine commands are registered and runnable, they carry the storyboard with
them, the gesture is declared, `vnauthor`'s `edit_scene` runs the same decisions, and the whole set is
verified from the palette and CDP against a real project. See [As shipped](#as-shipped). The ticks in
[Steps](#steps) are the detail. Move four of
[`../research/scene-chunks-as-the-authored-unit.md`](../../research/scene-chunks-as-the-authored-unit.md),
and the first one that lets anything change prose. It depends on
[`scene-chunk-files.md`](scene-chunk-files.md) for the file layout and
[`allocated-line-ids.md`](allocated-line-ids.md) for ids that survive the edit. Both UI plans —
[`line-editing-in-floor.md`](line-editing-in-floor.md) and
[`script-composition-in-studio.md`](script-composition-in-studio.md) — consume this one and add no
write path of their own.

<!-- toc -->

<!-- tocstop -->

## Why

The app can rewire a branch and reassign coverage, and it cannot let you write a word. Everything
before this plan makes writing *safe*; this is the plan that makes it *possible*, and it does so
entirely in the main process — no UI, testable in node, shippable and verifiable through the
palette and CDP before either editor exists.

Keeping it separate from the surfaces is deliberate. Two rooms will edit scenes, and the one thing
that must not differ between them is what an edit *does*. One command set, two thin surfaces, is
the arrangement `src/shared/coverage.ts` already proved.

## The shape

**A pure decision module, one session method, nine commands.** Exactly the arrangement
`branchops.ts` + `session.editBranches` + the `story.*` rewires already have, one layer down:

```
lineops.ts            pure: (scene, args) -> LineOp { ok, message, doc } | { ok: false, error }
shotfallout.ts        pure: (op, shots) -> which storyboards move, lose coverage, or drift
planSceneEdit()       load -> decide -> validate -> prove the round-trip -> fallout (no writes)
  previewSceneEdit()  the plan's message and note, thrown away — what `check` answers
  editScene()         the plan, written: chunks, then storyboards, then reload
story.* commands      check = the same decision, discarded; run = apply
```

The four upper rows shipped in `apps/desktop/src/shared/` and `session.ts`, and
[`scene-edit-package.md`](scene-edit-package.md) has since moved them into `@vn/scriptedit` so the
agent tool in step 6 can reach them. Nothing about the arrangement changed — a surface still runs
the same function to preview a gesture, so the refusal shown mid-drag is the refusal that would
happen; the functions are just no longer app-local.

| Command | What it does |
| --- | --- |
| `story.setLineText` | replace one line's text |
| `story.insertLine` | add a line after a given id (or at the top) |
| `story.deleteLine` | remove a line |
| `story.moveLine` | reorder within a scene |
| `story.setSpeaker` | change or clear a line's speaker; also what changes its `kind` |
| `story.newScene` | create a chunk from nothing |
| `story.deleteScene` | remove one, refusing while anything points at it |
| `story.splitScene` | one scene becomes two at a line boundary |
| `story.mergeScene` | two become one — only across a linear continuation, and only when nothing else points at the scene being absorbed |

All nine are `mutating`, all nine are `undoable` (a scene chunk is a document, the same class as
the screenplay the rewires already snapshot), and all nine declare a `check`. Not
`story.moveLineToScene`: see below — it is `splitScene` and `mergeScene` that make it unnecessary,
and its coverage semantics that make it undesirable.

## The thing that governs the whole plan: ids are scene-scoped

`SceneLine.id` is `${scene.id}:L<n>` and `Shot.coversLines` binds to it. Within a scene,
`allocated-line-ids.md` makes every edit safe — insert allocates, delete retires, reorder keeps.
**Across scenes, no edit is safe**, because the id itself contains the scene name. A line that
moves from `arrival` to `rooftop` cannot keep `arrival:L4`, so it gets a new id, so every shot
covering it silently stops covering it.

That is not a bug to fix; it is the honest consequence of scene-scoped ids, and the alternative
(globally unique line ids) is a much larger change that buys one operation. So the plan handles it
by **making the detachment explicit wherever it happens**:

- **`splitScene` and `mergeScene` report what they detach**, in the command's `message` and in its
  `check` note, counting shots by name before the author commits. `readShots(knownLineIds)` already
  drops ids a scene no longer has, so the state after is consistent — it is the *surprise* that is
  the failure, not the data.
- **`splitScene` carries the shots it can.** Shots covering only lines that went to the new scene
  move to the new `work/shots/<newId>.json` with rewritten ids; shots straddling the split point
  stay with the original and lose the lines that left. A straddling shot is exactly the sign the
  split is in the wrong place, and the check says so.
- **So does `mergeScene`, which is a correction to the paragraph above.** The absorbed lines are
  renumbered into the survivor's allocator rather than keeping their local part, so at first this
  looked like pure detachment — but a renumbering is a *known mapping*, and dropping coverage the
  code can follow would discard paid-for art for no reason. Both ops therefore report `moved`, and
  coverage walks it. Genuine detachment is what is left: a straddle, and a deleted scene.
- **There is no `moveLineToScene`.** A single line moving between scenes detaches its coverage with
  nothing to show for it, and "move this beat into the next scene" is better expressed as a split
  and a merge, where the coverage consequence is visible in both halves.

## The second thing: no edit is a rehash — which is why drift has to be reported

This section said the opposite while step 4 was being built, and the code disagreed. Reading
`buildShotPrompt` settles it: it composes the style preamble, framing, location, subjects and
camera, and **never reads a line's text**. Prose reaches only `shotDescription`, which feeds the P7
*reviewer* spec and never enters a task's `inputs`. So a retyped line changes no task hash. Prose
edits are as free as coverage edits, and that is what makes free editing affordable at all — the
research doc
([`../research/scene-chunks-as-the-authored-unit.md`](../../research/scene-chunks-as-the-authored-unit.md#what-editing-a-chunk-does-to-everything-downstream))
had it right.

The consequence is worse than a rehash, not better: **a rendered frame goes on illustrating prose
the author replaced, and nothing will notice.** Auto-rehashing would spend money the author did not
authorize; saying nothing ships a frame depicting deleted dialogue. So the plan reports it —
`retyped` line ids become a count of *rendered* shots in the `check` note and the `run` message,
phrased so the "will not re-render on their own" part is explicit. Deriving and drawing the marker
is [`line-editing-in-floor.md`](line-editing-in-floor.md)'s job; that plan's premise needs the same
correction, since a drift derived from comparing prompt hashes would compare two identical hashes.

## Failure modes

| Failure | Guard |
| --- | --- |
| Delete the last line of a scene | allowed; an empty scene is a legitimate stub. The chunk stays, `lines` is empty |
| Delete a line every shot covers | allowed; the shot lands in the timeline's existing `COVERS NOTHING` list, which is that surface's job to reveal |
| `deleteScene` while a choice or `next` points at it | refuse, naming every referrer — the same class as `dangling_goto` |
| `deleteScene` on the entry scene | refuse, naming `start` in `project.yaml` |
| `newScene` with an id that exists | refuse; ids are the binding surface for shots and branches |
| `insertLine` after an id in another scene | refuse against `UNRESOLVED`, not silently append |
| An edit that changes nothing | succeed, write nothing, say so — the `editBranches` precedent, and what keeps a no-op from becoming an undo point |
| Two writers on one chunk | `editScene` re-reads inside the operation, as `editBranches` does |

## Steps

1. ✔ **`src/shared/lineops.ts`.** The nine pure decisions over a `Scene`, returning the same
   `{ ok, message } | { ok: false, error }` shape `branchops.ts` uses. Node tests, no I/O. This is
   the bulk of the plan and it is all pure. Landed as written, with three shapes the plan sketch
   did not name. **The nine decisions all take one `ScriptState`** (`scenes` keyed by id, plus the
   `entry` a delete has to refuse) rather than a single `Scene`, because four of them are about the
   scene *set* — and they return the scenes to **write whole** plus the chunks to **remove**, not a
   patch. **A line id names its own scene**, so `setLineText`/`deleteLine`/`moveLine`/`setSpeaker`
   take no scene prop and cannot be addressed inconsistently. And the coverage consequence is
   three separate lists rather than one count: `retired` (ids that stop existing), `moved`
   (`[old, new]` — coverage *can* follow, which is what makes `splitScene`'s shot carrying
   possible) and `retyped` (ids whose prompt contribution changed, so the art is stale). The
   decisions are pure over scenes, so the shot counts they feed are step 4's to read.
2. ✔ **`session.editScene(sceneId, decide)`.** Load → decide → serialize through `sceneToFountain` →
   re-parse and compare → write one chunk atomically → reload. The re-parse is the same safety net
   `applySceneBranchEdit` has, and it is cheaper here: one scene, and the serializer's round-trip
   property test already covers the general case. Landed as `editScene(decide)` with **no `sceneId`
   argument** — a line id names its own scene and four of the nine ops span several, so the scene
   set is the unit, not one scene. Three things it does that the sketch did not say:
   - **The state is parsed from the chunk files, not taken from the model.** `buildModel` rewrites
     `line.speaker` from the cue an author typed (`AIKO`) to the character id it resolves to
     (`aiko`), so re-serializing a model scene would rewrite every cue in the file. `LoadedProject`
     now carries the pre-model `Scene` beside each source's bytes, and `session.scriptState()`
     exposes exactly what the decisions (and step 3's checks) see.
   - **The safety net compares the bytes, not the scenes.** `write → read → write` has to be a
     fixpoint, which is the same claim as `parse(write(scene)) ≡ scene` without needing a deep
     equality over `Scene`. Every scene in the op is proved before any file is touched.
   - **Front-matter is spliced, not re-serialized** (the `editBranches` rule), so a chunk's YAML
     comments survive a prose edit — but the *body* is written whole, so **the first prose edit to a
     hand-authored chunk canonicalizes it**, `[[line:]]` marks included. For a chunk `vngen import`
     wrote, that is a no-op, and a genuine no-op is reported as writing nothing.

   `deleteSceneChunk` is new in `@vn/store` (a scene that stopped existing), and it deliberately
   leaves `work/shots/<id>.json` behind — cleaning that up is step 4's, with the rest of the
   coverage consequences.
3. ✔ **The nine commands.** Thin, in `apps/desktop/src/main/commands/story.ts`, each `check` running
   the same `lineops` decision against a freshly read scene and discarding it. Landed as written —
   an `edit`/`previewEdit` pair beside the rewires' `apply`/`preview`, and nine definitions that do
   nothing but shape props into a `lineops` call. The registry is 37 commands. Two details:
   - **A removed chunk is reported in `written`.** `CommandOutput.written` is "paths this command
     changed", which is what provenance and undo both want from it, so `editScene`'s `removed` list
     is appended rather than dropped or given a field of its own on the record.
   - **`insertLine`'s `kind` is the enum** (`prop.oneOf(LINE_KINDS, …)`, defaulting to `dialogue`),
     so the DSL and the catalog schema both list what a line may be, and `lineops` still owns the
     rule that only dialogue and parentheticals may carry a speaker.

   The detachment counts the plan promises in these messages are not here: `lineops` reports
   `retired`/`moved`/`retyped` as line ids, and turning those into shot counts means reading
   `work/shots/*.json` — step 4.
4. ✔ **Coverage consequences.** `splitScene`'s shot carrying, and the detachment counts in every
   affected `check` and `message`. The one part that touches `work/shots/*.json`, and it goes
   through the same writer `story.setCoverage` uses rather than a second one. Landed as
   `src/shared/shotfallout.ts` — pure, beside `lineops.ts`, taking an op's `moved`/`retired`/
   `retyped` ids plus the shot files as they sit on disk and answering what it costs. Five things
   the plan sketch did not say:
   - **A merge carries too**, per the correction above: `mergeScene` reports `moved` rather than
     `retired`, and `lineops`' merge test pins the mapping.
   - **A carried shot keeps its id.** `shot.id` is in the `shot_image` task's `inputs`, so renaming
     one would re-render art that is still correct. Only its file, `sceneId` and `coversLines` move.
   - **A surviving scene left with no shots loses its file**, via the new `deleteShots` in
     `@vn/store`. An absent file is the only signal meaning "decompose this scene", so writing an
     empty list would be a permanent blank storyboard. A deleted scene's file goes the same way.
   - **`editScene` is now `planSceneEdit` + `previewSceneEdit` + `editScene`**, the `planLineIds`
     shape one room over. The check reports the fallout note the run reports, because both come from
     the same plan; `story.ts`'s `previewEdit` calls `previewSceneEdit` instead of re-deciding.
   - **Removed shot files join `removed`**, so `CommandOutput.written` (which is "paths this command
     changed") covers the storyboard as well as the chunk.
5. ✔ **The `script.moveLine` interaction.** Declared in `src/shared/interactions.ts` beside the other
   four: carries a line id, `targets` judges every insertion point in the scene. It commits
   `story.moveLine`. Declaring it here rather than in a UI plan is the point of the interaction
   layer — an agent can ask what a drag would do before any drag exists. Landed as written, with
   three decisions the sketch left open:
   - **The targets are insertion points, not lines**, so there is one more of them than there are
     lines: an exported `TOP` sentinel (`story.moveLine`'s empty `after`, which is not addressable),
     then "after each line".
   - **A drop that would reorder nothing is not a target.** `timeline.cover`'s rule, and it is
     enforced by *running* `moveLine` and comparing the resulting id order with the current one
     rather than by index arithmetic — so the omission cannot disagree with the op.
   - **`script.*` takes no `scene` prop.** A line id names its own scene, so `stateFor` hands the
     gesture `session.scriptState()` whole; passing a scene would be a second answer to the same
     question. That is also what stops `scriptState()` being test-only.
6. ✔ **Agent tools.** `edit_scene` in `@vn/authoring`'s registry, routed through the same `lineops`
   decisions, so `vnauthor` is not the one writer that goes around them. And **`write_file` must
   refuse `scenes/`** (`packages/authoring/src/tools.ts:408`) — it is a whole-file overwrite with
   no validation, which is exactly the path that would write a chunk with duplicate line ids.

   **Was blocked on [`scene-edit-package.md`](scene-edit-package.md), and the reason is worth
   recording: "the same `lineops` decisions" was not reachable as written.** `lineops.ts` and
   `shotfallout.ts` were in `apps/desktop/src/shared/`, and a package may not import an app — so
   routing the agent through them meant moving them into one first. That is a move with no behaviour
   change, which is why it was its own plan rather than a bullet here. It has shipped: the decisions,
   the source list and the plan/apply pair are `@vn/scriptedit`, which `@vn/authoring` may import.
   The split the step anticipated ("if this reaches into the plan-diff rendering and the permission
   gate") is still possible on top; that was a different, earlier obstacle.

   Landed as **one tool with an `op` enum, not nine tools.** Nine would have been nine descriptions
   for a model to choose between, all of them "edit a scene"; one tool with `op` puts the choice in a
   place the schema can enumerate. The op names are the `story.*` command ids verbatim
   (`setLineText` … `mergeScene`), so an agent transcript and a command history read as the same
   vocabulary. Three seam decisions:
   - **The tool refuses only an absent argument.** `SCENE_OP_ARGS` says which props each op cannot be
     attempted without, and nothing else is checked here — whether a line may be empty, whether a
     dialogue line needs a speaker, whether a scene may be deleted are judgments `@vn/scriptedit`
     already makes, and making them twice is how two answers start to disagree. The agent gets the
     palette's sentence.
   - **`Workspace.sceneEditInput()` is the one-load contract.** Sources and entry come off a single
     `load()`, because a writer must patch the files the model it decided against was built from.
   - **`write_file`'s refusal is a path-owner lookup** (`guardedBy`), not a special case: first path
     segment `scenes` → "written by `edit_scene`". A second validated tree would add a line, not a
     branch.
7. ✔ **Verify from the palette and CDP.** Every command run against `examples/mySampleRepo` with no
   editor: insert, retype, move, split, merge, undo each one, and confirm `vngen status` task
   counts move exactly where the plan says they should and nowhere else.

   Done, and the pass earned its place — it started by finding that `mySampleRepo` was still in the
   retired one-file form, so `workspace.import` was the first command verified (5 chunks, task counts
   unchanged), and it ended with a defect. What it established:
   - **`check` and `exec` agree, every time.** Each command was `check`ed and then run; the verdict
     sentence and the record's message were identical in all nine cases, including the fallout
     clauses. `story.deleteScene(rooftop)` refused with `greet (next), observe (next) still point(s)
     at rooftop`; a non-adjacent `mergeScene` refused with `a merge only removes a boundary`.
   - **Prose editing costs no art.** `vngen status` sat at 24 done / 3 needs_human across insert,
     retype, move, delete, setSpeaker, split, merge, newScene and spliceScene — and **`vngen status`
     is the wrong instrument to prove that with**, which the step's wording missed: it counts the
     status *log*, so unplanned work cannot show up in it. `vngen cost` is the one that plans. It
     read 0 pending at baseline and 0 after every prose edit; the single time it moved was
     `newScene(heading='INT. HALLWAY - AFTERNOON')`, which introduced a *location* and so wanted one
     `location_ref`. A new entity costs; moving prose around does not.
   - **The storyboard arithmetic is exact.** Splitting `rooftop` at L4: `rooftop__establishing`
     (covering L7) followed its line into `rooftop_late` keeping its id, and `rooftop__beat2` (L3–L6)
     reported `lose 3 line(s) of coverage, 1 already rendered`. Merging `ending` into `rooftop`
     carried `ending__S1` and removed `ending.md` *and* `ending.json`, both in `written`. Deleting a
     line left a shot at `coversLines: []` rather than deleting paid-for art.
   - **Undo is exact and refuses when it can't be.** Every command undone; `git status` came back to
     nothing but `vngen/state/commands.jsonl` each time (excluded from the snapshot by design), files
     the command created were removed and files it deleted came back. Redo restores. A hand edit
     between run and undo makes undo refuse by name and exit non-zero.
   - **`interaction.targets('script.moveLine', 'arrival:L3')` answered 2, not 4** — the two drops
     that would reorder nothing are absent, as step 5 says.
   - **The palette is a sufficient UI on its own**, which is what "with no editor" was asking. Filter
     → row → props form with `kind` pre-set to `dialogue`, the verdict live as the fields fill
     (`✕ No scene ""` → `✓ Inserted greet:L3 (narration) after greet:L2.`), `run` reporting that same
     sentence with `source: 'ui'`, and the shell's `⟲` undoing it.

   **The defect: the live catalog had no interactions.** `command:catalog` called `toCatalog(registry,
   '@vn/desktop')` while the build-time generator called `toCatalog(..., desktopInteractions)`, so
   `window.vn.catalog()` reported five commands' worth of gestures as zero — and the test that
   "asserts the two match" compared `commands.json` against the *generator's* projection, never the
   channel's. Fixed by leaving one projection, `catalogOf(registry)`, used by both, with a test on it.
   Two call sites building the same thing is the shape of this bug; there is now one.
8. ✔ **Docs.** This file's As-shipped section; `CLAUDE.md`'s command-system section (the command
   count moves by nine and the "the only writer of `work/shots/…`" sentence gains a second writer);
   `docs/command-system.md`'s table, counts and markers. Also `docs/vnauthor.md` for `edit_scene`,
   and the undoable count in three places — it was "the six `story.*` document mutators" and is now
   fifteen.

## As shipped

The plan's shape survived; the surprises were all about where the decisions had to *live*. Nine
`story.*` commands and one `edit_scene` tool, all over one pure rule module, and every step's
correction is recorded in place above. What a reader coming to this cold should know:

- **The rules are `@vn/scriptedit`, not the desktop app.** They started in
  `apps/desktop/src/shared/`, which made step 6 impossible — a package may not import an app — and
  moving them out became its own plan, [`scene-edit-package.md`](scene-edit-package.md). The package
  has **two entries** because the renderer previews a drag by running `moveLine`: the barrel is pure
  and browser-safe, and the half that touches the filesystem is `@vn/scriptedit/write`.
- **Every writer is the same writer.** The palette, a CDP client, an in-app gesture and `vnauthor`
  all reach one `planSceneEdit`/`applyScenePlan` pair, so there is one answer to "may I", one
  storyboard accounting, and one set of sentences. `write_file` refuses `scenes/` rather than being
  a tenth path.
- **Ids are allocated, and a split does not renumber.** The lines that moved into a new scene keep
  the numbers they had (`rooftop:L7` becomes `rooftop_late:L7`), because renumbering is what detaches
  art from prose. Scene-scoped ids mean a cross-scene move is a detachment, which is *reported* —
  never silently repaired.
- **No prose edit costs an image.** Verified with `vngen cost`, not `vngen status`: the status log
  cannot show unplanned work, so it looks reassuring whatever happens. Prose edits plan nothing; the
  only thing that moved the preview was a new scene heading introducing a location.
- **Coverage is carried, and never quietly discarded.** A shot follows its lines across a split or a
  merge keeping its id; a shot left covering nothing is kept, because it is real art someone paid
  for; and a *scene* left with no shots loses its file, because an absent file is the only way to say
  "decompose this again".

Still open: the two editor plans ([`line-editing-in-floor.md`](line-editing-in-floor.md),
[`script-composition-in-studio.md`](script-composition-in-studio.md)) build the surfaces, and
`script.moveLine` has no gesture to attach to until the first of them lands.

## Not in this plan

- **Any UI.** Not one component. The two editor plans consume these commands.
- **Global line ids.** Scene-scoped ids stay, with the detachment made visible instead. Revisit
  only if cross-scene movement turns out to be a common authorial act rather than a rare one.
- **Drift marking.** Knowing a shot's covered prose changed since it was generated needs a surface
  to show it on — it lands with the FLOOR editor.
- **Rich text of any kind.** A line is a string. Emphasis, dual dialogue and centered text are
  format questions the serializer plan already scoped out.
- **Batch or transactional edits.** One command, one authorial act, one `CommandRecord`. A
  multi-line rewrite is several commands and several undo points, which is what an author expects
  from an editor.

## Alternatives considered

- **One `story.editScene` command taking a JSON patch.** Fewer commands, and it destroys the thing
  the command system is for: a `CommandRecord` would say "the scene changed" rather than "line L4
  moved after L7", the DSL becomes unwritable by hand, and `check` has nothing specific to refuse.
- **Edit prose through `write_file` and re-parse.** Already possible, and it is precisely the
  unvalidated path step 6 closes. It cannot allocate ids, cannot refuse, and cannot report what it
  detached.
- **Make prose edits rehash, by putting the covered line text into `buildShotPrompt`.** Considered
  after discovering that today's prompt excludes it. It would make a typo fix re-render every frame
  over the line, which is money the author did not authorize, and the reason the prose was left out
  in the first place stands: what a shot orders is framing, cast and camera, and a reviewer handed
  the prose flags frames for things no shot was responsible for.
- **Rename a carried shot into its new scene** (`arrival__beat1` → `climb__beat1`), so the id and
  the file agree. `shot.id` is part of the `shot_image` task's `inputs`, so a rename rehashes and
  re-renders art that was already correct. The id is a minting record, not an address.

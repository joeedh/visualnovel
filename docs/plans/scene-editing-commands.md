# Scene editing commands

Status: **partial** — the pure decisions and the write path have landed; nothing is reachable as a
command yet. The ticks in [Steps](#steps) are the detail. Move four of
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md),
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
src/shared/lineops.ts     pure: (scene, args) -> LineOp { ok, message, doc } | { ok: false, error }
session.editScene()       load -> decide -> validate -> write one chunk -> reload
story.* commands          check = the same decision, discarded; run = apply
```

`lineops.ts` is in `src/shared/` rather than `src/main/` for the reason the other two are: the
renderer runs the same function to preview a gesture, so the refusal shown mid-drag is the refusal
that would happen.

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
- **There is no `moveLineToScene`.** A single line moving between scenes detaches its coverage with
  nothing to show for it, and "move this beat into the next scene" is better expressed as a split
  and a merge, where the coverage consequence is visible in both halves.

## The second thing: an edit is not a rehash, except when it is

Coverage edits are free — `buildShotPrompt` ignores `coversLines`. **Prose edits are not.** A
shot's prompt is built from the lines it covers, so retyping a covered line changes that shot's
task hash and invalidates generated art.

This plan does **not** hide that and does not act on it. The commands write the document; the
planner decides what is stale, as it already does for every other input change. What the plan owes
is that the author is not surprised, so `story.setLineText`'s `check` reports how many *accepted*
shots cover the line it is about to change, and its `run` message says the same. Marking the drift
visually is [`line-editing-in-floor.md`](line-editing-in-floor.md)'s job, where there is somewhere
to draw it.

One consequence worth stating plainly: an author correcting a typo in a covered line spends money.
That is inherent — the frame illustrates prose that changed — and the right response is to report
it, not to add a "don't rehash" flag that would let the manifest lie about what the art depicts.

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
3. **The nine commands.** Thin, in `apps/desktop/src/main/commands/story.ts`, each `check` running
   the same `lineops` decision against a freshly read scene and discarding it.
4. **Coverage consequences.** `splitScene`'s shot carrying, and the detachment counts in every
   affected `check` and `message`. The one part that touches `work/shots/*.json`, and it goes
   through the same writer `story.setCoverage` uses rather than a second one.
5. **The `script.moveLine` interaction.** Declared in `src/shared/interactions.ts` beside the other
   four: carries a line id, `targets` judges every insertion point in the scene. It commits
   `story.moveLine`. Declaring it here rather than in a UI plan is the point of the interaction
   layer — an agent can ask what a drag would do before any drag exists.
6. **Agent tools.** `edit_scene` in `@vn/authoring`'s registry, routed through the same `lineops`
   decisions, so `vnauthor` is not the one writer that goes around them. And **`write_file` must
   refuse `scenes/`** (`packages/authoring/src/tools.ts:408`) — it is a whole-file overwrite with
   no validation, which is exactly the path that would write a chunk with duplicate line ids. If
   this turns out to reach into the plan-diff rendering and the permission gate more than expected,
   it splits into its own plan; start it here.
7. **Verify from the palette and CDP.** Every command run against `examples/mySampleRepo` with no
   editor: insert, retype, move, split, merge, undo each one, and confirm `vngen status` task
   counts move exactly where the plan says they should and nowhere else.
8. **Docs.** This file's As-shipped section; `CLAUDE.md`'s command-system section (the command
   count moves by nine and the "the only writer of `work/shots/…`" sentence gains a second writer);
   `docs/command-system.md`'s table, counts and markers.

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
- **Make prose edits non-rehashing by excluding line text from the shot prompt.** Cheap edits, and
  the manifest would then claim art depicts prose it never saw. The provenance is the product.

# Scene chunks as the authored unit

_This document is an investigation rather than a plan. It commits to no steps and no waves. It argues for a shape and
states what that shape costs._

Moves one and two have shipped. Allocated line ids landed as
[`../plans/archive/INDEX.md#allocated-line-ids`](../plans/archive/INDEX.md#allocated-line-ids) and lossless scene
serialization as
[`../plans/archive/INDEX.md#lossless-scene-serialization`](../plans/archive/INDEX.md#lossless-scene-serialization), so
blockers 1 and 2 below are fixed. Blocker 3 stands as written. [`../plans/index.md`](../plans/index.md) tracks the
seven plans this document produced and records which of them are built._

<!-- toc -->

- [The question](#the-question)
- [What is actually in the way](#what-is-actually-in-the-way)
  * [1. Line ids are positional, and their doc comment already lies](#1-line-ids-are-positional-and-their-doc-comment-already-lies)
  * [2. Scene serialization is lossy, so edits cannot round-trip through the model](#2-scene-serialization-is-lossy-so-edits-cannot-round-trip-through-the-model)
  * [3. One file, many writers](#3-one-file-many-writers)
- [The shape](#the-shape)
  * [What Fountain becomes](#what-fountain-becomes)
- [What editing a chunk does to everything downstream](#what-editing-a-chunk-does-to-everything-downstream)
- [The command and gesture surface](#the-command-and-gesture-surface)
- [Where the editing happens: both rooms, different jobs](#where-the-editing-happens-both-rooms-different-jobs)
- [What this unlocks that is not just "editing"](#what-this-unlocks-that-is-not-just-editing)
- [Alternatives considered](#alternatives-considered)
- [If this were to proceed](#if-this-were-to-proceed)

<!-- tocstop -->

## The question

Today the screenplay is a preexisting artifact that the pipeline processes: one or more `screenplay/*.fountain` files,
authored elsewhere and parsed on every load. The app can rewire branches and reassign coverage, but it cannot let you
write. The proposal inverts that: the unit of authorship becomes a scene chunk the user freely edits, and the app
becomes the editor.

This is less of a rewrite than it looks, because most of the shape is already here. It still has a cost, and that cost
falls on one place nobody has had to care about yet.

## What is actually in the way

The three things below are ordered by how much they hurt, worst first.

### 1. Line ids are positional, and their doc comment already lies

`SceneLine.id` is documented as "Stable, scene-scoped id" (packages/types/src/entities.ts:93). The id is not stable.
`splitScenes` assigns it last (packages/model/src/scenes.ts:129):

```ts
scene.lines.forEach((line, i) => {
  line.id = `${scene.id}:L${i + 1}`;
});
```

Inserting one line at the top of a scene shifts every id below it by one. `Shot.coversLines` binds to those ids, so
the shot that covered the first exchange now covers the line above it. Nothing reports this, because
`readShots(knownLineIds)` only drops ids the scene no longer has. After an insertion `L1..Ln` all still exist, but
they refer to different prose.

Positional ids are the real blocker, and fixing them is independent of everything else here. They are wrong today, and
are merely unreachable because nothing can edit prose. Any move in this direction starts by making them allocated
rather than derived.

**Fixed.** `splitScenes` now allocates ids and writes them down as `[[line: L4]]` / `[[nextline: 12]]` notes. Reading
does not write them. `story.assignLineIds` is the opt-in, undoable command that persists them. See
[`../plans/archive/INDEX.md#allocated-line-ids`](../plans/archive/INDEX.md#allocated-line-ids).

### 2. Scene serialization is lossy, so edits cannot round-trip through the model

`branchpatch.ts` begins with this:

`sceneToFountain` is deliberately lossy. `Scene.body` holds flattened prose, so re-serializing a scene discards cues,
parentheticals and formatting.

Rewiring a branch therefore rewrites only the `[[choice:]]` / `[[next:]]` note lines and re-parses the whole file
afterwards to prove it changed nothing else. That re-parse check is sound here, but it does not generalize: you cannot
write a byte-exact surgical patcher for "the author retyped this paragraph".

But `body` is where information is lost, not the model. `Scene.lines` already carries what Fountain needs to be
regenerated. Each line records a `kind`, a `speaker`, and `text`, and each `kind` is exactly a cue, a parenthetical, a
dialogue block, or an action paragraph. A serializer written against `lines` instead of `body` is lossless for
everything `lines` retains.

**Fixed.** `sceneToFountain` writes from `lines` under the contract `parse(write(scene)) ≡ scene`, and a property test
checks that contract. The heading keeps its prefix and variant, transitions, lyrics and centered text are now line
kinds, and `Scene.body` has been removed. The surgical patcher stays for files the author wrote. See
[`../plans/archive/INDEX.md#lossless-scene-serialization`](../plans/archive/INDEX.md#lossless-scene-serialization).

### 3. One file, many writers

`screenplay/*.fountain` is a single contended document. The agent editing scene 4 and the human editing scene 9
collide on it, and the branch editor's patcher exists partly to make that collision survivable. Per-scene chunks
eliminate the contention by construction, the same way `work/shots/<id>.json` already did for decompositions.

## The shape

A scene chunk is one file per scene. It holds YAML front-matter for the scene's structured fields, a Fountain body for
its prose, and an explicitly allocated id on every line. The front-matter half matches `character.md` and
`locations/*.md`. It uses the same loader (`@vn/parse`'s `frontmatter.ts`), gives the same `*ToDoc` / `fromDoc`
round-trip guarantee, and takes the same `applySceneEdit` shape that `applyCharacterEdit` already has. The ownership
split matches `work/shots/<sceneId>.json`, and exactly one module in `@vn/store` maps the on-disk form to the
in-memory form (`store/src/scenes.ts`, sibling to `shots.ts`).

```markdown
---
scene: arrival
location: school_gate
synopsis: Aiko is waiting at the gate, and has been for a while.
next: rooftop
nextLineId: 12
---

INT. SCHOOL GATE - AFTERNOON

[[line: L1]]
Rain ticks off the gate.

AIKO
[[line: L4]]
Um… hello.

[[line: L7]]
She bows, a little too deeply.

[[choice: "Introduce yourself" -> greet]]
```

The ids use the channel the project already has. `[[…]]` is a Fountain note — ignored by every Fountain renderer — and
this repo already uses it as its machine channel for `[[scene:]]` / `[[choice:]]` / `[[next:]]`. Adding a `line` kind
takes four lines in `parseBranchMarker` and a `case` in `splitScenes`, and no other part of the parser changes. The
body stays valid Fountain, so any Fountain tool can still read it and it still diffs as prose.

The four properties below matter most:

- **Ids are allocated, not derived.** Insertion takes `nextLineId` and bumps it. Deletion retires an id permanently.
  Reordering moves the block and keeps the id. `L4` is the fourth line ever written to this scene rather than the
  fourth line in it, so `coversLines` survives every edit that does not delete the line it names.
- **Editing prose changes one line.** The id sits on its own marker line above the text, so retyping a line touches
  exactly the line that changed. An insertion adds `+3` lines (marker, prose, blank) in one contiguous hunk, and a
  reorder moves a block rather than renumbering the file. JSON lacks that property, and that is the reason for this
  format.
- **A parse step defines the boundary.** Unlike a JSON chunk, this format is parsed, which is the repo's normal
  arrangement rather than an exception: front-matter through `frontmatter.ts`, body through `parseFountain`, and the
  result validated by a zod schema in `@vn/types` before it reaches the deterministic core. The round-trip test
  (`fromDoc(toDoc(x)) ≡ x`) verifies the serializer, and characters and locations already have such a test to copy.
- **The file is a chunk, so the writers do not contend.** Each file holds one scene, and a lock covers only that one
  file.

Two details should be decided early rather than discovered:

- **Where the marker goes.** A marker above the element (as shown) reads cleanly and keeps prose edits to one diff
  line, at the cost of roughly doubling the body's line count. An inline trailing marker (`AIKO [[L4]]`, `She bows, a
  little too deeply. [[L7]]`) is quieter on the page but puts a machine token on the prose line, so a re-wrap moves it
  and a careless edit can delete it. The leading form is the safer default; both parse identically because notes are
  position-free.
- **An unmarked line is valid input.** A human writing prose straight into the body will not type markers, and a
  paste from elsewhere will not carry them. The load path should allocate ids for unmarked elements on read and write
  them back, the same stance `work/shots/*.json` takes (the file is human-editable and the load path meets it where it
  is). The load path must never renumber a marked element.

### What Fountain becomes

Import runs once, export can run at any time, and the body stays Fountain throughout. Migration is a one-shot pass
from `screenplay/*.fountain` to chunks: `splitScenes` as it stands, plus id allocation, plus a split into per-scene
files. Export concatenates the chunk bodies in graph order and re-emits the front-matter as the `[[scene:]]` marker it
came from. `screenplay.fountain` is therefore a generated artifact: readable, diffable, importable into anything that
reads Fountain, and never the source of truth again.

Storing the body in Fountain rather than a structured list makes both directions cheap. Export copies the body with
few changes instead of running a serializer with its own bugs, and an author can still write a scene in their own
editor. The app is the primary surface, not the only one.

It also shrinks a cost the structured-file version would have had. `SceneLine.kind` retains four kinds (`dialogue` /
`action` / `parenthetical` / `narration`) where the parser emits twelve, so `transition`, `section`, `lyric`,
`centered`, `page_break` and dual-dialogue's `dual` flag fall through `splitScenes`'s `default: break` today and
nothing downstream reads them. If the chunk had been a list of `SceneLine`s, they would have been absent from disk as
well. With a Fountain body they stay in the file and are ignored by the model, exactly as they are now. Widening
`SceneLine.kind` becomes an ordinary later improvement rather than a migration deadline. That is the second real
argument for this format over the structured one.

An element the model does not retain cannot be covered by a shot, because it has no `SceneLine` and therefore no id to
name. A transition is not something you would frame, so this behavior is probably correct. The documentation should
state the behavior rather than leaving a reader to discover it, and the editor should show such lines as
present-but-uncoverable rather than not showing them.

## What editing a chunk does to everything downstream

The expensive half is already insulated.

- **Prose edits do not invalidate art.** Task identity is `sha256(kind, inputs)`. `buildShotPrompt` does not read
  line text; only `shotSpec` reads it, and `shotSpec`'s output never enters a task's `inputs`. Retyping a line
  therefore rehashes nothing, exactly as coverage edits rehash nothing. Task identity already ignores line text, and
  that is what makes free editing affordable.
- **Drift is surfaced, not enforced.** A shot generated against prose that has since been rewritten is not stale in
  the task graph's sense. It is stale in the author's sense, and only the author can decide. A `drifted` marker on the
  shot records the covered lines' text hash at generation time against the current hash. The timeline and the FLOOR
  inspector show the marker and offer re-decomposition rather than performing it. Auto-rehashing on a typo fix would
  spend money the author did not authorize; saying nothing would ship a frame that illustrates deleted dialogue.
- **Insertion lands in a gap, and that is correct.** A new line is covered by no shot, so the coverage timeline
  draws it in the vermilion gutter. The gutter exists to reveal uncovered prose, so it marks the new line without any
  new code.
- **Deletion may empty a shot, and that must be allowed.** The coverage rule refuses a drag that would leave a
  neighbour covering nothing, because releasing the drag does not return those lines. Deleting the last line a shot
  covers is a different act with a different intent, and `COVERS NOTHING` is already a state the timeline lists. The
  coverage rule constrains the drag gesture, not the stored data.
- **Moving a line between scenes drops its coverage.** Ids are scene-scoped, so a line that moves to another scene
  arrives there with a new id, and the shot in the old scene could not have covered that id anyway. The drop is
  correct, but the move should be reported with the same "dropped N line ids" reporting that `readShots` already
  emits.

## The command and gesture surface

Chunk editing is a document mutation, so it inherits the existing machinery rather than needing new machinery:
`story.*`, `mutating: true`, `undoable: true` (chunks are the document data class, which the shadow-snapshot undo
already covers), a `check` that re-runs the same pure decision, and a `CommandRecord` per edit.

The mutators are roughly `story.setLine`, `story.insertLine`, `story.deleteLine`, `story.moveLine`, `story.newScene`,
`story.splitScene`, `story.mergeScenes`. The branch mutators keep their names but get simpler: `applySceneBranchEdit`
and its re-parse safety net collapse into a field write on a chunk, because there is no longer a screenplay to
corrupt.

Consider the gestures. Typing prose is not an interaction, by the same test that excluded inline label editing: it
carries no token and has no enumerable targets. Dragging a line to another shot's bracket and dragging the scene split
point are interactions, and would be the fifth and sixth. Adding them crosses the threshold the interaction plan named
for reconsidering a gesture index: three direct-manipulation surfaces rather than two.

Prose editing is continuous and every other command is discrete, which is the one genuinely new problem. A command per
keystroke would make `commands.jsonl` and the undo journal useless. Both editors already solve this for drags, where
the drag is continuous and its commit is discrete. A line edit commits on blur or on a debounce, emitting one
`story.setLine` per settled line, and the undo point is the line rather than the character.

## Where the editing happens: both rooms, different jobs

Editing does not happen in one editor. It belongs in FLOOR's timeline and in STUDIO, and the split between them is
correcting versus composing.

- **FLOOR — edit in place, one line at a time.** The timeline already puts the scene's script down the page with its
  coverage bracketed beside it. Making a row's text editable there costs almost nothing structurally and helps
  immediately: a typo, a reworded line, a wrong speaker are all fixed where the consequence is visible, and an
  inserted line opens a vermilion gap in the same frame you typed it. FLOOR should not offer anything that
  restructures — no splitting a scene, no moving a line to another scene, no reordering — because those change the
  thing the coverage is drawn against while you are looking at the coverage.
- **STUDIO — compose.** Write a scene from nothing, reorder, split and merge scenes, move a line from one scene to
  another, edit alongside the agent's proposals and the branch graph. STUDIO takes the `--sodium` accent, holds the
  authored side, and is where the destructive-shaped operations belong.

The division takes one sentence: FLOOR edits a line, and STUDIO edits the script. It follows from what each room
already does rather than being imposed on them. FLOOR is the machine side, and its timeline shows what the pipeline
will do with your prose. STUDIO is where the prose comes from.

The obvious risk is that the two editors drift into two behaviours. The repo already uses the same arrangement twice:
one pure core with two thin surfaces over it. `src/shared/coverage.ts` is run by the command in main and by the strip
mid-drag; `src/shared/interactions.ts` is run by the renderer and by `interaction.targets`. A shared editing core
handles block splitting, id allocation on insert, and what a settled edit commits to, with `Timeline.tsx` and the
STUDIO editor as impure shells over it. That arrangement keeps the two editors from disagreeing about what an edit
means. Both commit through the same `story.*` commands, so provenance and undo cannot differ either.

## What this unlocks that is not just "editing"

- **`vnauthor` can write prose.** Today it cannot: there is no `applySceneEdit` to match `applyCharacterEdit` /
  `applyLocationEdit`, because scene serialization is lossy. Chunks give scenes the same round-trip guarantee
  (`fromDoc(toDoc(x)) ≡ x`) that characters and locations already have, and the plan-mode diff renderer works
  unchanged.
- **Generate a scene, then edit it.** Once the authored unit is a chunk rather than a file the human wrote, nothing
  distinguishes a chunk the agent drafted from one the author typed. Generating a scene and then editing it is the
  destination the question implies.
- **Per-scene provenance.** `commands.jsonl` already stamps `gitHead`/`gitDirty` and the written paths. With one
  file per scene, a query over that log reports who last changed a scene and whether it was a person, so no one has to
  reconstruct that from diffs.

## Alternatives considered

**Keep Fountain as the source of truth and patch it surgically** (generalize `branchpatch`). Rejected: the patcher's
check works because branch markers are a closed, machine-owned syntax on their own lines. Free prose editing has no
such invariant to check against, and ids would still be positional, so the blocker remains.

**Content-hash line ids** (`arrival:<sha8(text)>`). This scheme is rejected. The ids stay stable across reordering,
but every typo fix destroys them, so the cheapest edit becomes the most destructive one.

One alternative stores chunks as JSON, with `lines` holding `SceneLine[]` verbatim. It is tempting because the on-disk
shape would equal the in-memory shape and no parser would be needed at all. It is rejected because prose in JSON does
not diff, and diffing matters most for an authoring format. Escaped strings and one object per line turn every review
of what the writer changed into an exercise in reading around punctuation, in a repo where the generated `vngen/` tree
is committed and the git history is the provenance record. The parser it saves is small (a note kind and a `case`),
and the round-trip test it saves is one the repo already writes for two other file types. Consistency with
`character.md` costs nothing here and gives a format an author can read.

**Line ids in front-matter as an ordered list**, keeping the body pure Fountain. This version looks like it provides
both properties, and it does not: binding ids to elements by their order in a list is still positional binding, and it
fails on the same edit that motivated this document. The id has to be adjacent to the prose in the file.

## If this were to proceed

Allocated line ids come before the editor. They are the `[[line:]]` marker kind, which `splitScenes` reads in
preference to the positional stamp, and unmarked elements have an id allocated and written back. Allocated line ids
are a correctness fix that stands on its own: they close a silent-corruption path that exists today, they work on the
existing single-file screenplay before any chunking, they are testable without a line of UI, and everything else here
depends on them. This change shipped essentially as described. The one change of substance is that allocation happens
in memory and persisting is a separate command, so loading a project never writes to the project.

The chunk split, the export path, and the editing commands are the second, third, and fourth steps, and each is useful
before the next one is delivered. The order matters in one specific way: the ids have to be real before free editing
begins, or the first edit re-points a shot at the wrong prose and the bug ships inside the feature that caused it.

# Scene chunks as the authored unit

_Investigation. Not a plan — no steps, no waves committed to. It argues a shape and names what
it costs._

_Status: **moves one and two have shipped.** Allocated line ids landed as
[`../plans/allocated-line-ids.md`](../plans/archive/allocated-line-ids.md) and lossless scene
serialization as
[`../plans/lossless-scene-serialization.md`](../plans/archive/lossless-scene-serialization.md), so
blockers 1 and 2 below are fixed; 3 stands as written. The seven plans this document produced,
and which of them are built, are tracked in [`../plans/index.md`](../plans/index.md)._

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

Today the screenplay is a **preexisting artifact the pipeline processes**: one or more
`screenplay/*.fountain` files, authored elsewhere, parsed on every load. The app can rewire
branches and reassign coverage, but it cannot let you write. The proposal is to invert that —
make the unit of authorship a **scene chunk the user freely edits**, with the app as the editor.

This is less of a rewrite than it looks, because most of the shape is already here. It is also
not free, and the cost is concentrated in one place nobody has had to care about yet.

## What is actually in the way

Three things, in descending order of how much they hurt.

### 1. Line ids are positional, and their doc comment already lies

`SceneLine.id` is documented as "Stable, scene-scoped id" (`packages/types/src/entities.ts:93`).
It is not stable. `splitScenes` stamps it last (`packages/model/src/scenes.ts:129`):

```ts
scene.lines.forEach((line, i) => {
  line.id = `${scene.id}:L${i + 1}`;
});
```

Insert one line at the top of a scene and every id below it shifts by one. `Shot.coversLines`
binds to those ids, so the shot that covered the first exchange now covers the line above it —
and **nothing reports this**, because `readShots(knownLineIds)` only drops ids the scene no
longer has. After an insertion `L1..Ln` all still exist. They just mean different prose.

This is the real blocker. It is also independent of everything else here: positional ids are
wrong today, they are merely unreachable because nothing can edit prose. Any move in this
direction starts by making them allocated rather than derived.

**Fixed.** Ids are now allocated by `splitScenes` and written down as `[[line: L4]]` /
`[[nextline: 12]]` notes; reading never writes, and `story.assignLineIds` is the opt-in,
undoable command that persists them. See
[`../plans/allocated-line-ids.md`](../plans/archive/allocated-line-ids.md).

### 2. Scene serialization is lossy, so edits cannot round-trip through the model

`branchpatch.ts` opens by saying so:

> `sceneToFountain` is lossy by design — `Scene.body` is flattened prose, so re-serializing a
> scene destroys cues, parentheticals and formatting.

Which is why rewiring a branch rewrites **only** the `[[choice:]]` / `[[next:]]` note lines and
re-parses the whole file afterwards to prove it changed nothing else. That safety net is good
engineering and it does not generalize: you cannot write a byte-exact surgical patcher for
"the author retyped this paragraph".

But the lossiness is in `body`, not in the model. **`Scene.lines` already carries what Fountain
needs to be regenerated** — `kind`, `speaker`, `text` per line, which is exactly a cue, a
parenthetical, a dialogue block, or an action paragraph. A serializer written against `lines`
instead of `body` is lossless for everything `lines` retains.

**Fixed.** `sceneToFountain` writes from `lines` under the contract `parse(write(scene)) ≡ scene`,
pinned by a property test; the heading's prefix and variant are retained, transitions/lyrics/
centered text became line kinds, and `Scene.body` is gone. The surgical patcher stays for files
the author wrote. See
[`../plans/lossless-scene-serialization.md`](../plans/archive/lossless-scene-serialization.md).

### 3. One file, many writers

`screenplay/*.fountain` is a single contended document. The agent editing scene 4 and the human
editing scene 9 collide on it; the branch editor's patcher exists partly to make that survivable.
Per-scene chunks make the contention disappear by construction, the same way `work/shots/<id>.json`
already did for decompositions.

## The shape

**A scene chunk is one file per scene: YAML front-matter for the scene's structured fields, a
Fountain body for its prose, and an explicitly allocated id on every line.** The front-matter half
matches `character.md` and `locations/*.md` — same loader (`@vn/parse`'s `frontmatter.ts`), same
`*ToDoc` / `fromDoc` round-trip guarantee, same `applySceneEdit` shape `applyCharacterEdit`
already has. The ownership split matches `work/shots/<sceneId>.json`, and exactly one module in
`@vn/store` maps on-disk to in-memory (`store/src/scenes.ts`, sibling to `shots.ts`).

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

**The ids ride the channel the project already has.** `[[…]]` is a Fountain note — ignored by
every Fountain renderer — and this repo already uses it as its machine channel for
`[[scene:]]` / `[[choice:]]` / `[[next:]]`. A `line` kind is a four-line addition to
`parseBranchMarker` and a `case` in `splitScenes`, and nothing else in the parser moves. The
body stays valid Fountain, so it is still readable by any Fountain tool and still diffs as
prose.

Four properties follow, and they are the whole point:

- **Ids are allocated, not derived.** Insertion takes `nextLineId` and bumps it; deletion retires
  an id permanently; reordering moves the block and keeps the id. `L4` is the fourth line ever
  written to this scene, not the fourth line in it — so `coversLines` survives every edit that
  does not delete the line it names.
- **A prose edit is a one-line diff.** The id sits on its own marker line above the text, so
  retyping a line touches exactly the line that changed. An insertion is `+3` lines (marker,
  prose, blank) in one contiguous hunk, and a reorder moves a block rather than renumbering the
  file. That is the property JSON cannot give you and it is why this format wins.
- **The parse is real, so the boundary is real.** Unlike a JSON chunk there is a parse step —
  which is the repo's normal arrangement, not an exception: front-matter through
  `frontmatter.ts`, body through `parseFountain`, the result validated by a zod schema in
  `@vn/types` before it reaches the deterministic core. The round-trip test
  (`fromDoc(toDoc(x)) ≡ x`) is the thing that keeps the serializer honest, and characters and
  locations already have one to copy.
- **The file is a chunk, so the writers do not contend.** One scene, one file, one lock's worth
  of blast radius.

Two details worth deciding early rather than discovering:

- **Where the marker goes.** Above the element (as shown) reads cleanly and keeps prose edits to
  one diff line, at the cost of roughly doubling the body's line count. Inline and trailing —
  `AIKO [[L4]]`, `She bows, a little too deeply. [[L7]]` — is quieter on the page but puts a
  machine token on the prose line, so a re-wrap moves it and a careless edit can eat it. The
  leading form is the safer default; both parse identically since notes are position-free.
- **An unmarked line is not an error.** A human writing prose straight into the body will not
  type markers, and neither will a paste from elsewhere. The load path should **allocate ids for
  unmarked elements on read and write them back** — the same "the file is human-editable and we
  meet it where it is" stance `work/shots/*.json` takes. What it must never do is *renumber* a
  marked one.

### What Fountain becomes

**Import once, export always — and the body never stops being Fountain.** Migration is a one-shot
`screenplay/*.fountain` → chunks pass: `splitScenes` as it stands, plus id allocation, plus a
split into per-scene files. Going the other way, export is a concatenation of the chunk bodies in
graph order with the front-matter re-emitted as the `[[scene:]]` marker it came from, so
`screenplay.fountain` is a generated artifact — readable, diffable, importable into anything that
reads Fountain, and never the source of truth again.

Keeping the body in Fountain rather than a structured list is what makes both directions cheap.
Export is close to a copy instead of a serializer with its own bugs, and the author who wants to
write a scene in their own editor still can — the app is the primary surface, not the only one.

It also shrinks a cost the structured-file version would have had. `SceneLine.kind` retains four
kinds (`dialogue` / `action` / `parenthetical` / `narration`) where the parser emits twelve, so
`transition`, `section`, `lyric`, `centered`, `page_break` and dual-dialogue's `dual` flag fall
through `splitScenes`'s `default: break` **today** and nothing downstream reads them. Had the
chunk been a list of `SceneLine`s they would have stopped existing on disk as well. With a
Fountain body they keep surviving exactly as well as they do now: present in the file, ignored by
the model. Widening `SceneLine.kind` becomes an ordinary later improvement rather than a
migration deadline — which is the second real argument for this format over the structured one.

The residue is that an element the model does not retain **cannot be covered by a shot**, because
it has no `SceneLine` and therefore no id to name. A transition is not something you would frame,
so that is probably correct; it should be *stated* rather than discovered, and the editor should
show such lines as present-but-uncoverable rather than not showing them.

## What editing a chunk does to everything downstream

The good news is that the expensive half is already insulated.

- **Prose edits do not invalidate art.** Task identity is `sha256(kind, inputs)`, and
  `buildShotPrompt` does not read line text — only `shotSpec` does, whose output never enters a
  task's `inputs`. So retyping a line rehashes nothing, exactly as coverage edits rehash nothing.
  This is already true and it is what makes free editing affordable at all.
- **…which means drift must be surfaced, not enforced.** A shot generated against prose that has
  since been rewritten is not stale in the task graph's sense — it is stale in the author's sense,
  and only they can decide. The move is a **`drifted` marker** on the shot (the covered lines'
  text hash at generation time vs. now), shown in the timeline and the FLOOR inspector, offering
  re-decomposition rather than performing it. Auto-rehashing on a typo fix would spend money the
  author did not authorize; saying nothing would ship a frame that illustrates deleted dialogue.
- **Insertion lands in a gap, and that is correct.** A new line is covered by no shot, so the
  coverage timeline draws it in the vermilion gutter — the surface whose entire job is revealing
  uncovered prose does that for free, with no new code.
- **Deletion may empty a shot, and that must be allowed.** The coverage rule refuses a *drag* that
  would leave a neighbour covering nothing, because releasing does not give lines back. Deleting
  the last line a shot covers is a different act with a different intent, and `COVERS NOTHING` is
  already a state the timeline lists. The refusal belongs to the gesture, not to the data.
- **Moving a line between scenes drops its coverage.** Ids are scene-scoped, so a line that leaves
  is a new line where it lands; the shot in the old scene could not have covered it anyway. Fine,
  but it should say so — the same "dropped N line ids" reporting `readShots` already does.

## The command and gesture surface

Chunk editing is a document mutation, so it inherits the existing machinery rather than needing
new machinery: `story.*`, `mutating: true`, `undoable: true` (chunks are the document data class,
which is what the shadow-snapshot undo already covers), a `check` that re-runs the same pure
decision, and a `CommandRecord` per edit.

Roughly: `story.setLine`, `story.insertLine`, `story.deleteLine`, `story.moveLine`,
`story.newScene`, `story.splitScene`, `story.mergeScenes`. The branch mutators stay as they are
in name but get *simpler* — `applySceneBranchEdit` and its re-parse safety net collapse into a
field write on a chunk, because there is no longer a screenplay to corrupt.

On gestures: typing prose is **not** an interaction, by the same test that excluded inline label
editing — no carried token, no enumerable targets. Dragging a line to another shot's bracket, or
dragging the scene split point, are interactions and would be the fifth and sixth. That also
crosses the threshold the interaction plan named for reconsidering a gesture index: three
direct-manipulation surfaces rather than two.

One thing genuinely new: **prose editing is continuous and every other command is discrete.** A
command per keystroke would make `commands.jsonl` and the undo journal useless. The existing
answer is right there in both editors — a drag is continuous, its commit is discrete — so a line
edit commits on blur or on a debounce, one `story.setLine` per settled line, and the undo point is
the line, not the character.

## Where the editing happens: both rooms, different jobs

Not one editor. **Editing belongs in FLOOR's timeline and in STUDIO, and the split is between
correcting and composing.**

- **FLOOR — edit in place, one line at a time.** The timeline already puts the scene's script
  down the page with its coverage bracketed beside it. Making a row's text editable there costs
  almost nothing structurally and pays immediately: a typo, a reworded line, a wrong speaker are
  all fixed where the consequence is visible, and an inserted line opens a vermilion gap in the
  same frame you typed it. What FLOOR should *not* offer is anything that restructures — no
  splitting a scene, no moving a line to another scene, no reordering — because those change the
  thing the coverage is drawn against while you are looking at the coverage.
- **STUDIO — compose.** Write a scene from nothing, reorder, split and merge scenes, move a line
  from one scene to another, edit alongside the agent's proposals and the branch graph. This is
  the room whose accent is `--sodium`, the authored side, and it is where the destructive-shaped
  operations belong.

The division is defensible in one sentence: **FLOOR edits a line, STUDIO edits the script.** It
also falls out of what each room already is, rather than being imposed — FLOOR is the machine
side and the timeline is there to reveal what the pipeline will do with your prose; STUDIO is
where prose comes from.

The obvious risk is two editors drifting into two behaviours. The repo already has the answer and
uses it twice: **one pure core, two thin surfaces.** `src/shared/coverage.ts` is run by the
command in main and by the strip mid-drag; `src/shared/interactions.ts` is run by the renderer and
by `interaction.targets`. A shared editing core — block splitting, id allocation on insert, what a
settled edit commits to — with `Timeline.tsx` and the STUDIO editor as impure shells over it is
the same arrangement, and it is what keeps the two rooms from disagreeing about what an edit
means. Both commit through the same `story.*` commands, so provenance and undo cannot differ
either.

## What this unlocks that is not just "editing"

- **`vnauthor` can write prose.** It currently cannot: there is no `applySceneEdit` to match
  `applyCharacterEdit` / `applyLocationEdit`, precisely because scene serialization is lossy. With
  chunks it gets the same round-trip guarantee (`fromDoc(toDoc(x)) ≡ x`) that characters and
  locations already have, and the plan-mode diff renderer works unchanged.
- **Generate a scene, then edit it.** Once the authored unit is a chunk rather than a file the
  human wrote, nothing distinguishes a chunk the agent drafted from one the author typed. That is
  the actual destination implied by the question.
- **Per-scene provenance.** `commands.jsonl` already stamps `gitHead`/`gitDirty` and the written
  paths; with one file per scene, "who last changed this scene, and was it a person" becomes a
  query rather than a diff-archaeology exercise.

## Alternatives considered

**Keep Fountain as the source of truth and patch it surgically** (generalize `branchpatch`).
Rejected: the patcher's safety net works because branch markers are a closed, machine-owned
syntax on their own lines. Free prose editing has no such invariant to check against, and ids
would still be positional — the blocker is untouched.

**Content-hash line ids** (`arrival:<sha8(text)>`). Rejected: stable across reordering, destroyed
by every typo fix. It makes the cheapest edit the most destructive one.

**Chunks as JSON**, with `lines` being `SceneLine[]` verbatim. Tempting because the on-disk shape
would equal the in-memory shape and no parser would be needed at all. Rejected on the property
that matters most for an authoring format: **prose in JSON does not diff.** Escaped strings, one
object per line, and every review of "what did the writer change" becomes an exercise in reading
around punctuation — in a repo where the generated `vngen/` tree is committed and the git history
is the provenance record. The parser it saves is small (a note kind and a `case`) and the
round-trip test it saves is one the repo already writes for two other file types. Consistency
with `character.md` costs nothing here and buys a format an author can read.

**Line ids in front-matter as an ordered list**, keeping the body pure Fountain. This is the
version that looks like it gets both properties, and it does not: binding ids to elements by
their order in a list is positional binding wearing a different hat, and it fails on exactly the
edit that motivated the whole document. The id has to be adjacent to the prose in the file.

## If this were to proceed

The first move is not the editor. It is **allocated line ids** — the `[[line:]]` marker kind, read
by `splitScenes` in preference to the positional stamp, allocated for unmarked elements and
written back. That is a correctness fix that stands on its own: it closes a silent-corruption path
that exists today, it works on the existing single-file screenplay before any chunking, it is
testable without a line of UI, and everything else here depends on it. **This is the move that
shipped**, essentially as described — the one change of substance is that allocation happens in
memory and persisting is a separate command, so loading a project never writes to it.

The chunk split, the export path, and the editing commands are the second, third and fourth moves,
and each is useful before the next one lands. The order matters in one specific way: the ids have
to be real before anything can freely edit, or the first edit quietly re-points a shot at the
wrong prose and the bug ships inside the feature that caused it.

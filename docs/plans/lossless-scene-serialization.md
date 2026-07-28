# Lossless scene serialization

Status: **planned**. The prerequisite the research doc treats as a detail. It follows
[`allocated-line-ids.md`](allocated-line-ids.md) and precedes
[`scene-chunk-files.md`](scene-chunk-files.md) — every later move in
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md)
writes prose through the function this plan makes trustworthy.

<!-- toc -->

<!-- tocstop -->

## Why

Nothing in this repo can write a scene back to Fountain without destroying it. `branchpatch.ts`
opens by saying so:

> `sceneToFountain` is lossy by design — `Scene.body` is flattened prose, so re-serializing a
> scene destroys cues, parentheticals and formatting. Rewiring a branch must therefore not go
> through it.

So a branch rewire patches **only** the `[[choice:]]` / `[[next:]]` note lines and re-parses the
whole file afterwards to prove it changed nothing else. That is good engineering, and it does not
generalize. There is no surgical patch for "the author retyped this paragraph", and there is no
surgical patch at all for a scene that does not exist yet.

The good news is that the loss is in `body`, not in the model. `Scene.lines` already carries
`kind`, `speaker` and `text` per line — which is exactly a cue, a parenthetical, a dialogue block
or an action paragraph. **A serializer written against `lines` is lossless for everything `lines`
retains.** The work is therefore in two halves: write that serializer, and close the gap between
what `lines` retains and what Fountain can say.

`scene.body` turns out to be nearly vestigial already. Its only remaining production readers are
`splitScenes` (which writes it) and `branchpatch.ts` (which copies it into a comparison). P5 was
moved off it deliberately — `packages/pipeline/src/p5.ts:85` says why: "The identified lines, not
`scene.body`". This plan finishes that migration rather than starting one.

## What `lines` currently drops

Ten Fountain element types exist (`packages/parse/src/fountain.ts:17-27`). `splitScenes` has cases
for four of them plus notes, headings and synopses; the rest fall through `default: break`
(`packages/model/src/scenes.ts:118`).

| Dropped | Where it goes today | Consequence for an editor |
| --- | --- | --- |
| `transition` (`CUT TO:`) | discarded | retyped on every save; uncoverable by a shot |
| `lyric` (`~`) | discarded | same |
| `centered` (`> … <`) | discarded | same |
| `section` (`#`) | discarded | author's own outline headers vanish |
| `page_break` | discarded | harmless, but must be a deliberate decision |
| `character.dual` | `cueNames.add(name)` only | dual dialogue flattens to two sequential blocks |
| heading text | mined to `{id, variant}`, variant not kept on `Scene` | see below |
| `sceneNumber` | consumed as the scene id, then unreachable | a re-serialize invents a new one |

The heading is the sharpest one. `headingFor` (`packages/model/src/serialize.ts:60`) reconstructs
`INT. <LOCATION> - DAY` from the location slug alone, so **`EXT. ROOFTOP - NIGHT` round-trips to
`INT. ROOFTOP - DAY`** — wrong interior/exterior, wrong time of day, and the time of day is the
variant the location plate is generated from. `parseHeading` extracts the variant correctly
(`packages/model/src/scenes.ts:17`) and then it is thrown away because `Scene` has nowhere to put
it. That is a one-field fix and it should not wait for an editor.

## The shape

**`sceneToFountain` is rewritten against `lines`, and `Scene` grows the two fields the heading
needs.** Everything else follows from those two moves.

```
lines: [
  { kind: 'narration',     text: 'Rain ticks off the gate.' },
  { kind: 'dialogue',      speaker: 'AIKO', text: 'Um… hello.' },
  { kind: 'parenthetical', speaker: 'AIKO', text: 'quietly' },
]

INT. SCHOOL GATE - AFTERNOON        ← from heading fields, not reconstructed from the slug

Rain ticks off the gate.

AIKO
(quietly)
Um… hello.
```

The serializer's whole job is emitting a `CHARACTER` cue when the speaker changes and a blank line
when it does not continue, which is why it is short and why it is worth a property test rather
than a handful of examples.

### The contract is `parse(write(scene)) ≡ scene`

Not `write(parse(text)) ≡ text`. Byte-exactness is neither achievable nor wanted — the author's
spacing, comment style and marker placement are theirs, and the surgical patcher exists precisely
so ordinary edits never rewrite the file. What must hold is that **a scene survives a trip through
text unchanged in every field the model carries**, so a write is never a lossy operation on the
data the pipeline actually keys on.

This is the same contract `fromDoc(toDoc(x)) ≡ x` already gives characters and locations
(`packages/model/src/serialize.ts:5`), which is why the test can be modelled on the existing
property tests rather than invented.

## The one hard constraint: blank lines are structural

`isBlank` in `parseFountain` tests the **raw** line, not the note-stripped one
(`packages/parse/src/fountain.ts:83`), and a `CHARACTER` cue is only recognized with a blank line
above it and a non-blank line below (`:163`). A serializer that emits a cue without the blank
above it produces an action paragraph, silently, and the round-trip test is the only thing that
would catch it. Three rules follow, and they belong in the code as comments:

- **A cue always gets a blank line above.** Including the first element of a scene, and including
  the case where the previous line was a `[[…]]` marker — the marker line is not blank.
- **Nothing may be emitted between a cue and its first dialogue line except a note.** The dialogue
  loop tolerates notes (`:169-174`); it tolerates nothing else.
- **An all-caps action paragraph is a cue.** If a narration line happens to be uppercase, writing
  it plainly re-parses as a speaker. Force it with a leading `!` (`:189`).

## Speaker attribution is asymmetric, and this plan fixes it

`currentSpeaker` is set by a cue and cleared only at the next scene
(`packages/model/src/scenes.ts:45`), so **every action paragraph after the first cue in a scene is
attributed as that speaker's stage direction** — including narration three exchanges later that
has nothing to do with them. A serializer that writes `kind: 'action', speaker: 'AIKO'` back out
as a plain action paragraph will re-parse to the same thing only by accident, and only while the
misattribution stays uniform.

The branch it feeds is dead in principle, which is the tell. `parseFountain` consumes a dialogue
block until a blank line, and inside that block every non-parenthetical line becomes `dialogue`
(`packages/parse/src/fountain.ts:167-181`) — so **an `action` element can never be inside a
dialogue block**, and the "action after a cue is a stage direction for that speaker" comment at
`scenes.ts:110` describes a case the parser cannot produce. Every action line is narration; the
ones carrying a speaker are mislabelled, not stage directions.

The fix is to clear `currentSpeaker` on any element that is not `dialogue`, `parenthetical` or
`note` — notes are interleaved into blocks and must not break attribution. `Scene.characters` is
unaffected (cues populate that), and the only observable change is `speaker` disappearing from
`kind: 'action'` lines, which `buildShotPrompt` does not read. It is in this plan rather than its
own because the round-trip test cannot pass while `speaker` says something the serializer has no
way to write.

## Steps

1. **`@vn/types`: heading fields on `Scene`.** `locationVariant?: string` and
   `headingPrefix?: 'INT.' | 'EXT.' | 'INT./EXT.' | 'EST.' | 'I/E'`, both optional so every
   existing consumer compiles untouched. Update the `Scene.body` doc comment to say plainly that
   it is derived from `lines` and retained for back-compat.

2. **`@vn/types`: widen `SceneLine.kind`.** Add `'transition' | 'lyric' | 'centered'`. Every
   `switch` on `kind` in the repo must be found and audited — the coverage timeline, the exporter,
   the P5 prompt builder, and `AttemptLoop` are the candidates. Two questions each surface has to
   answer explicitly rather than by default: is this line **coverable** by a shot, and does it
   produce a **beat** in `story.play.json`? A transition is coverable and produces no beat; a lyric
   is both.

3. **`splitScenes` retains them.** Cases for `transition`, `lyric` and `centered` alongside the
   existing four; `section` and `page_break` stay dropped and the `default` gets a comment saying
   which are deliberate. Fill the two new `Scene` fields from `parseHeading`, which already
   computes the variant and discards it.

4. **Clear `currentSpeaker` outside dialogue blocks.** As argued above: cleared by every element
   that is not `dialogue`, `parenthetical` or `note`. The only behaviour change in the parse
   direction — one line, plus the test that pins it and the removal of the `action`-with-speaker
   branch it makes unreachable.

5. **Rewrite `sceneToFountain` against `lines`.** Heading from the new fields; the branch markers
   as today (`[[scene:]]`, `[[choice:]]`, `[[next:]]`) plus the `[[line:]]` markers that
   `allocated-line-ids.md` introduces; synopsis; then the body emitted from `lines` under the three
   blank-line rules. `headingFor` is deleted, not kept as a fallback — a fallback here is how
   `INT. … - DAY` got written into art prompts in the first place.

6. **The round-trip property test.** `sceneToFountain` → `parseFountain` → `splitScenes` →
   compare, over the fixture scripts in `@vn/testkit`'s `SCRIPTS` and over hand-built scenes
   covering each `kind`, each heading prefix, adjacent same-speaker blocks, a scene opening on a
   cue, an uppercase narration line, and a scene with no lines at all. Compare **structurally** —
   every field except `shots` (not serialized) and `body` (derived).

7. **Retire `body` as a stored field.** Once (6) passes, `sceneToFountain` is the authority on
   what a scene looks like as text and `body` has one reader left. Make it derived at the single
   point that still needs it (`branchpatch.ts:175` compares it) and delete the `bodyLines`
   accumulator from `splitScenes`. If this turns out to reach further than expected, it drops to
   its own change — it is cleanup, not a dependency of anything above.

8. **Docs.** This file's As-shipped section; the `branchpatch.ts` header comment, whose first
   paragraph becomes false the moment step 5 lands and which is the most likely thing to be read
   and believed; `CLAUDE.md`'s `@vn/model` row; `docs/fountain.md` for the retained-element list.

## Not in this plan

- **Any writer that uses it.** No editing commands, no chunk files, no UI. This plan makes writing
  safe; it does not make anything write.
- **Retiring the surgical patcher.** `applySceneBranchEdit` stays exactly as it is. A rewire still
  must not rewrite the file, because the author's formatting is still theirs — the serializer is
  for scenes the app authored, not scenes it inherited.
- **`section` and `page_break`.** Retained as dropped, deliberately. They have no meaning to the
  pipeline and adding a `SceneLine.kind` nothing can cover is worse than losing them.
- **Dual dialogue.** `character.dual` stays unretained; simultaneous dialogue has no
  representation downstream and inventing one is a story-model question, not a serializer one.

## Alternatives considered

- **Keep `body` and write a smarter flattener.** The information is not in `body` to recover —
  `${name}:` and a dialogue line are indistinguishable from an action paragraph containing a colon.
  Any such parser is a second, worse Fountain parser.
- **Store the raw source range per scene and splice.** Byte-exact and it defers the problem: it
  cannot serialize a scene that was never in a file, which is the first thing a "write from
  nothing" editor asks for.
- **Serialize to Fountain only at export, keep an internal format for editing.** Two formats, two
  parsers, and the diffable-prose property — the reason the chunk format was chosen at all — is
  lost for everything except the export.

# Plan: shot timeline editor

**Status:** **Done.** Wave 1 (shot persistence) and Wave 2 (the coverage strip) shipped, and
the acceptance pass on a real non-mock run is complete — see
[Acceptance on a real run](#acceptance-on-a-real-run).
**Depends on:** [desktop renderer restructure](desktop-renderer-restructure.md), plus shot
persistence (Wave 1 here).
**Size:** large. [`../research/graphThingsReport.md`](../research/graphThingsReport.md) §7.

## Why

`Shot.coversLines` is the only structural relationship in the project with no UI at all, and
it decides where `show` beats land in the playable — `@vn/export` walks `scene.lines` and
emits a `show` whenever the covering shot changes. Adjusting which lines a shot covers is a
boundary-dragging problem: a timeline, not a graph, and not something you want to describe to
an agent in a sentence.

## Blocker: shots are not persisted — **resolved, Wave 1 shipped**

_(The description below is the pre-Wave-1 state; see [Wave 1 as shipped](#wave-1--as-shipped).)_

**Nothing writes shots to disk.** `planTasks` decomposes a scene lazily the first time it
clears the gate (`packages/pipeline/src/planner.ts:116`), mutating `scene.shots` in memory.
The process exits and the decomposition is gone. `@vn/export` compensates by reconstructing
the deterministic grouping when shots are not in memory.

So a shot editor currently has nowhere to save an edit. That has to be fixed first, in the
pipeline, not in the app.

### Wave 1 — persist shots

Add a shots file to the generated tree, alongside the other run state:

```
vngen/work/shots/<sceneId>.json      # one file per scene
```

- Zod schema in `@vn/types`, validated on read like every other machine-consumed file.
- `planTasks` prefers a persisted decomposition over calling `decomposeScene`; it only
  decomposes when no file exists. Write the result immediately after decomposing.
- Because it lives under `work/`, it is human-editable and committed — consistent with how
  `work/` is already described in `CLAUDE.md`.
- `@vn/export`'s reconstruction fallback stays, for projects that predate this.

#### Schema shape (decided)

`Shot` mixes two kinds of field: what a human authored (`framing`, `location`, `subjects`,
`camera`, `coversLines`) and what a run produced (`prompt`, `image`, `status`). Both are
persisted — a shots file that omitted the run state would not be a readable record of the
scene — but the produced half is **nested under `shotData` and marked as derived**, so the
distinction is visible in the file itself rather than only in a doc:

```jsonc
{
  "version": 1,
  "scene": "arrival",
  "shots": [
    {
      "id": "arrival__establishing",
      "sceneId": "arrival",
      "framing": "establishing",
      "location": "evening",
      "subjects": [],
      "coversLines": ["arrival:L1", "arrival:L2"],

      // Derived — rewritten wholesale on every run from the task graph and manifest.
      // Present for reading (what this shot became); never an input. Editing it does
      // nothing, and the next run overwrites it.
      "shotData": {
        "prompt": "…", // P6, rebuilt by buildShotPrompt from the authored fields
        "image": "<sha256>", // P7 output; the manifest is the authority
        "status": "accepted",
      },
    },
  ],
}
```

Rules that follow, and each is a test:

- **`shotData` is optional on read.** Absent means "not run yet", which is also the state of
  every shot the moment it is decomposed.
- **Nothing reads it as authority.** Task status comes from `tasks.jsonl` and asset bytes from
  `manifest.json`; a shots file restored from an old commit must not be able to convince the
  pipeline that work is done. The loader may populate the in-memory `Shot` from it, but the
  planner's decisions are unchanged by whether it was there.
- **Only the authored half is compared** when deciding whether a persisted decomposition is
  usable, so a run that produced nothing and a run that produced everything load identically.
- **The in-memory `Shot` keeps its flat fields.** The planner mutates `shot.prompt` and the
  runner reads `scene.shots`; restructuring the working type would ripple through
  `planner.ts`, `runners.ts` and `playable.ts` for no gain. The store's reader/writer is the
  single place that maps flat ↔ nested — which is also what forces `shotData` to be
  *constructed* at write time from the run's results rather than carried along.

**The staleness question needs an explicit answer:** if the screenplay changes, persisted
shots may reference line ids that no longer exist. Recommended rule — drop unknown line ids
on load, emit a diagnostic, and keep the shot. Never silently re-decompose over a human's
edits; that is the one behavior that would make the editor untrustworthy.

This wave is worth doing on its own merits: today, two runs of the same project can produce
different shot decompositions (the LLM path is non-deterministic), which quietly breaks the
"deduped, resumable" promise for everything downstream of P5.

### Wave 1 — as shipped

Landed as its own commit, separate from any UI work, exactly as the risks section asked.

- **`packages/types/src/schemas.ts`** — `shotsFileSchema` + `shotDataSchema`. The framing enum
  and subject object were extracted into shared consts, so the persisted shape and
  `shotDecompositionSchema` (what the LLM returns) cannot drift from each other.
- **`packages/store/src/shots.ts`** (new) — `readShots` / `writeShots`, plus
  `paths.shotsFile(sceneId)`. This is the only flat↔nested mapping point, which is what forces
  `shotData` to be *constructed* at write time rather than carried around.
  - `readShots` returns `null` **only** when the file is absent — that null is the sole signal
    a caller may use to decide "decompose this scene". Malformed JSON _and_ a schema mismatch
    both throw `ValidationError`; silently re-decomposing over a hand edit would make the file
    untrustworthy to edit, which is the whole point of putting it under `work/`.
  - `writeShots` skips a byte-identical rewrite and returns whether it wrote. `work/` is
    committed, so an unchanged rerun has to leave `git status` clean.
  - `shotData` is **omitted entirely** until a run produced something, so a freshly decomposed
    file is purely authored material and reads as one.
- **`packages/pipeline/src/planner.ts`** — `planTasks` gained optional `paths`, `logger`, and
  `readOnlyShots`. Two write points, both owned by the planner rather than the scheduler:
  immediately after decomposing, and once per scene per pass after the shot tasks are hashed.
  `runPipeline` already guarantees a final `planTasks` pass after the last wave, so the second
  write is what gets a completed run's outputs into the file — and it needed no new dependency
  from `@vn/scheduler` on `@vn/store`.
  - `refreshShotData` copies status/image **from the task graph**, overwriting whatever the
    file loaded. That is what makes "nothing reads `shotData` as authority" true rather than
    merely documented.
  - `shot.image` was a documented-but-never-filled field before this; the image hash lived only
    on the task's `output`. It is now populated at plan time.
- **`readOnlyShots` on dry runs.** A dry run plans with mock providers, and a mock
  decomposition persisted to `work/` would be reused by the next real run — the same class of
  mistake as mixing mock image bytes into a real run's reference assets. Dry runs therefore
  read the file (so a cost preview reflects the real decomposition) but never write it.

- **`@vn/export` reads the file too** _(follow-up; see [The `coversLines` bug](#the-coverslines-bug))_.
  Wave 1 kept the reconstruction fallback "for projects that predate this" but left it as the
  exporter's _only_ source, so a persisted decomposition never reached the playable at all.
  `loadSceneShots(paths, model)` now reads every scene's file and `buildPlayable` takes the
  result; the reconstruction is the last resort it was meant to be.

Tests: `packages/store/src/tests/shots.test.ts` (round-trip, `shotData` omission, idempotent
write, stale-line drop, both malformed cases) and `packages/pipeline/src/tests/shots.test.ts`,
which drives real `makeProject` runs to prove a second run is byte-identical and re-hashes
nothing, that a hand-written decomposition is honored while its `shotData: accepted` is
ignored, that a stale line id is dropped without rehashing, and that a dry run writes nothing.

## The `coversLines` bug

Found while looking at the seeded workspace: the two scenes the LLM decomposed (`observe`,
`ending`) had **six accepted, paid-for shot images and displayed none of them.** Two
independent faults, either of which alone produces a blank scene.

**1. The model was asked a question it could not answer.** `DECOMP_SYSTEM` showed a response
template literally containing `"coversLines":[]` — an empty answer, modelled for it — and the
user prompt handed over `scene.body`, which is flattened prose with no line ids in it. There
was no way to name a line id from what it was shown, so it copied the empty array, and
`realLineIds` filtering kept `[]`.

Fixed in `packages/pipeline/src/p5.ts`: the prompt now enumerates the scene as
`[<lineId>] <kind>/<speaker>: <text>`, the system prompt says `coversLines` holds those ids
copied verbatim and that **every** line must be assigned to exactly one shot, and the template
shows a populated array. `withCoverage` is the safety net — a decomposition that binds no real
line falls back to `deterministicShots` (it is unplayable, not merely different), and an
uncovered first line is given to the first shot so a scene cannot open on a blank frame.

**2. The persisted decomposition never reached the exporter.** A model rebuilt from disk
carries no shots, so `coveringShots` reconstructed the deterministic baseline for _every_
scene — naming ids like `observe__establishing` that an LLM-decomposed run never produced.
Every lookup missed and every `show` beat came out image-less. Fixed by `loadSceneShots`
above, wired into `cmdExport` and both `WorkspaceSession` playable paths.

**Repairing an affected project costs nothing.** `buildShotPrompt` ignores `coversLines`, so
coverage can be hand-edited into an existing `work/shots/<sceneId>.json` with the shot ids
left alone: task hashes are unchanged and the already-generated images resolve. Deleting the
files instead would re-decompose, re-hash, and re-buy the art. `examples/mySampleRepo` was
repaired in place this way.

## The rehash boundary (scope this carefully)

`buildShotPrompt` (`packages/pipeline/src/prompts.ts:81`) reads `framing`, `location`,
`subjects`, and `camera` — **but not `coversLines`.**

That splits shot editing cleanly into two tiers:

| Edit | Effect on the prompt | Effect on generated art |
| --- | --- | --- |
| `coversLines` boundaries, shot order | none | **none** — free |
| `framing`, `location`, `subjects`, `camera` | changes the prompt | rehashes the task, invalidates the image |

**v1 edits coverage only.** It is the actual gap, it is free, and it keeps the first version
of a new editing surface incapable of destroying hours of generation. Framing/subject editing
is a second pass that needs the invalidation-cost readout described in
[`../research/graphThingsReport.md`](../research/graphThingsReport.md) §3.

## Design

The subject is film editing, and the app's vernacular is already theatrical. But the usual
horizontal timeline is wrong here for a reason specific to this subject: **screenplays are
vertical.** Lines run down the page; that is how every author has ever read this material.

**Signature: the coverage strip runs vertically.** The script column sits at the left —
`--prose` (Newsreader), real dialogue with speaker cues, formatted as a script rather than a
data table — and shots are brackets spanning line ranges to its right, each with its
generated frame as a thumbnail. Dragging a bracket's endpoint changes coverage.

```
  aiko          │ ┌─ establishing ──┐
  Um… hello.    │ │  [ frame ]      │
                │ └─────────────────┘
  She bows, a   │ ┌─ medium · aiko ─┐
  little too    │ │  [ frame ]      │   ← drag this edge
  deeply.       │ └─────────────────┘
```

This inherits the split the app already uses: script text is authored (`--prose`, sodium
side), frames and shot ids are machine (`--mono`, signal side). A line covered by no shot is
the one alarming state — it will render with no image in the playable — so it gets a
`--vermilion` hairline in the gutter. Uncovered lines are the thing this editor exists to
reveal.

No numbered markers on shots: they have ids (`arrival__beat1`), and inventing a parallel
numbering would create two ways to refer to the same thing.

## Files

```
renderer/rooms/floor/timeline/
  Timeline.tsx        the strip
  ShotBracket.tsx     one shot's span + thumbnail
  coverage.ts         pure: lines × shots → spans, gaps, overlaps, drag resolution
  tests/coverage.test.ts
```

`coverage.ts` carries the real logic, and it is all pure:

- `spansFor(lines, shots)` → ordered spans plus **gaps** (uncovered lines) and **overlaps**
  (two shots covering one line). `coversLines` is a set, not a range — nothing in the types
  prevents a non-contiguous or overlapping shot, and the deterministic decomposer produces
  exactly that (the establishing shot takes all narration/action lines while medium shots
  take dialogue, interleaved). **The UI must handle non-contiguous coverage rather than
  assuming ranges.** This is the single most likely source of bugs here.
- `resolveDrag(spans, shotId, edge, targetLine)` → the new `coversLines` sets for every
  affected shot, with the invariant that no line ends up in two shots.

## Where it lives

FLOOR, as a mode on a selected scene. It edits authored structure but is meaningless without
generated frames, and FLOOR is where you will be when you notice a boundary is wrong.

Mutations go through `@vn/commands` as one command per completed drag —
`story.setCoverage(shot, lines)` — not per frame. A drag is continuous but its *commit* is
discrete, so there is no coalescing problem as long as the command fires on drop.

## Wave 2 — as shipped

FLOOR gained a third mode, `timeline`, beside `list` and `graph` — the same segmented control,
a new surface. It takes the full width (`.floor-body.wide`) and the task inspector goes with
it: the strip is about different material, and a per-task panel beside it would be answering a
question nobody asked.

- **The rule is split exactly like `branchops`.** `src/shared/coverage.ts` holds `setCoverage`,
  the pure mutation, and it is run by **both** the `story.setCoverage` command in main and the
  timeline's mid-drag preview. So the sentence shown while an edge is carried is produced by
  the function that will decide the drop — including its refusals.
- **Claiming takes; releasing does not give.** Assigning a line to a shot removes it from
  whatever held it, because the exporter shows the _first_ shot covering a line and a
  doubly-covered line silently hides the second shot's frame. Lines a shot gives up become
  gaps rather than being handed to a neighbour the author never named — the gap is the state
  this editor exists to reveal, so inventing an owner for it would defeat the purpose.
- **Never a range.** `renderer/rooms/floor/timeline/coverage.ts` turns a shot into contiguous
  *segments* and assigns **lanes** by extent, so two interleaved shots get separate columns and
  a bracket never draws inside another's span. A shot with a hole draws two brackets and one
  head; only the outermost two carry drag handles, since an interior hole belongs to whatever
  interleaves with it. A shot covering *nothing* is not drawn as a bracket at all — it is
  listed under `COVERS NOTHING`, which is the other half of a gap and just as much a defect.
- **`resolveDrag` extends by sweeping and retracts by releasing**, and leaves interior holes
  alone in both directions. Retracting past the far edge keeps one line rather than emptying
  the shot.
- **Rows are laid out by CSS grid, not by measurement.** Each line is a grid row and a bracket
  is `grid-row: from / to+1` in its lane's column, so prose that wraps to three lines sizes its
  own row and the bracket follows. What the DOM *is* asked is which row the pointer is over:
  a full-width `.tl-band` sits behind each row, and `.tl-grid.dragging` drops pointer events on
  the script and the brackets so `elementFromPoint` reaches it — a drag lives in the bracket
  columns, where there is otherwise nothing row-shaped under the cursor.
- **Commands:** `story.coverage(scene)` (read) and `story.setCoverage(scene, shot, lines)`
  (mutating), the latter taking comma-separated ids because prop specs have no array kind. Both
  answer with the rebuilt `SceneCoverage`, so the strip never re-reads what it just wrote.

Verified live over CDP against `examples/mySampleRepo`: `arrival`'s establishing shot covers
L1 and L3, and rendered as two brackets in lane 0 with `beat1` in lane 1; a synthetic drag of
`beat1`'s end handle onto L3 previewed `arrival__beat1 covers 2 line(s), taking 1 from 1 other
shot(s).` and committed exactly one `story.setCoverage` record writing
`vngen/work/shots/arrival.json`. `story.play()` before and after showed the `show` beat move —
6 beats to 5 as L3 joined an accepted shot, and back to 6 on the reverse edit.

## Verification

- `pnpm test` — `spansFor` against non-contiguous and overlapping fixtures taken from
  `deterministicShots` output, and `resolveDrag`'s no-double-coverage invariant.
- Round-trip: edit coverage → `vngen export` → assert `show` beats moved to the expected
  positions in `story.play.json`, and that the PLAY room reflects it.
- Live: mock runs now emit real, seed-derived placeholder PNGs (`vn-mock-placeholder`, see
  `packages/providers/src/placeholder.ts`), so brackets, thumbnails and drag geometry _are_
  reviewable in mock mode — distinct shots are visibly distinct. What a placeholder still
  cannot tell you is whether coverage boundaries land where the **art** implies, so a real
  non-mock run of `examples/sample` remains the acceptance check, not the development loop.

## Acceptance on a real run

Run against `examples/mySampleRepo` (the seeded scratch workspace, which already held a real
51-asset run), with real Gemini art and a real Claude text model for P5.

**Setup.** Two scenes there still carried decompositions made by the *old* P5 prompt —
`observe` (4 shots) and `ending` (2 shots). Both are **one-line scenes**, and only the first
shot of each covered anything: `observe__observe-2/-3/-4` and `ending__ending-2` covered
nothing at all, so four paid frames existed that the exporter could never show. Deleting just
those two `work/shots/*.json` re-decomposed them under the fixed prompt; the three
deterministic-baseline scenes were left alone, so portraits, plates and model sheets were all
reused and only the affected shot art regenerated (2 tasks, both `done`).

**What the fixed prompt produced.** `observe__S1` covering `observe:L1`, `ending__S1` covering
`ending:L1` — one shot each, every line assigned, no gaps and no dead frames. That is the
`coversLines` fix working end to end against a real text model, not a mock.

**Do boundaries land where the art implies?** Yes, and this is the thing placeholders could
not answer. `rooftop` alternates two speakers: `rooftop__beat1` covers L2 and L5 (both Aiko)
and `rooftop__beat2` covers L3 and L6 (both Haruki), and the two frames are unmistakably
different pictures — Aiko on the rooftop at sunset, Haruki alone in the same place. Reading
down the timeline, each speaker's lines sit under their own frame. The non-contiguous,
interleaved coverage the decomposer emits is exactly what the laned bracket layout was built
for, and on real art it reads correctly rather than as an artifact of the layout.

**Two things the surface correctly reveals but does not cause**, both P5/P7 concerns:

- **Full coverage is not full fidelity.** `observe__S1` covers "Aiko slips into the seat by the
  window…" with `characters: []`, so the frame is an empty classroom. The shot is honest to its
  spec and P7 passed it — `shotSpec` says an empty cast means a missing character is not a
  defect — but the line describes a character acting. The timeline shows the line covered,
  which it is; it cannot show that the cast was ordered wrong.
- **Covered is not the same as rendered.** Three establishing shots (`arrival`, `greet`,
  `rooftop`) sit at `needs_human` after exhausting the refine cap, so their `show` beats export
  with no image. In the playable that is `arrival` at 3 `show` beats with 1 image. Covered-but
  -artless is a distinct state from uncovered, and the two must not be conflated.

## Risks

- **Building this against mock data used to produce a strip of broken thumbnails** — that is
  why this plan is ordered last. Mitigated after Wave 1: placeholders are real PNGs, so layout
  is honest. The residual risk is narrower and still real — placeholder art carries no
  composition, so it cannot expose a coverage boundary that is off by a line.
- **Non-contiguous coverage** is the default output of the deterministic decomposer, not an
  edge case. A range-based UI will look correct on a one-character scene and fall apart on a
  two-character one.
- **Wave 1 changes pipeline behavior** (shots stop being re-decomposed each run). That is a
  correctness improvement, but it is a behavior change in the generative core and deserves
  its own commit and its own test, separate from any UI work.

## Out of scope

Framing/subject/camera editing (tier 2 above), shot creation and deletion, reordering scenes,
per-line art overrides, audio, and transitions.

## Done

- [x] Shots persist under `vngen/work/`, schema-validated, preferred over re-decomposition
- [x] `shotData` round-trips, is optional, and never overrides `tasks.jsonl` / `manifest.json`
- [x] Stale line ids drop with a diagnostic; human edits are never silently overwritten
- [x] Coverage strip renders a real scene with real frames
- [x] Gaps and overlaps are visible; uncovered lines are unmistakable
- [x] Drag commits one `story.setCoverage` command on drop
- [x] `coversLines` edits provably do not rehash any task
- [x] `CLAUDE.md` updated: `work/shots/` in the project layout, and P5's persistence rule
- [x] Acceptance pass on a real non-mock run — boundaries land where the art implies

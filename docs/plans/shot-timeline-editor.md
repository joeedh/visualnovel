# Plan: shot timeline editor

**Status:** not started, and **not ready to start** — see the blocker below.
**Depends on:** [desktop renderer restructure](desktop-renderer-restructure.md), plus shot
persistence (Wave 1 here), plus a project that has been through a real non-mock run.
**Size:** large. [`../research/graphThingsReport.md`](../research/graphThingsReport.md) §7.

## Why

`Shot.coversLines` is the only structural relationship in the project with no UI at all, and
it decides where `show` beats land in the playable — `@vn/export` walks `scene.lines` and
emits a `show` whenever the covering shot changes. Adjusting which lines a shot covers is a
boundary-dragging problem: a timeline, not a graph, and not something you want to describe to
an agent in a sentence.

## Blocker: shots are not persisted

**Nothing writes shots to disk.** `planTasks` decomposes a scene lazily the first time it
clears the gate (`packages/pipeline/src/planner.ts:116`), mutating `scene.shots` in memory.
The process exits and the decomposition is gone. `@vn/export` compensates by reconstructing
the deterministic grouping when shots are not in memory.

So a shot editor currently has nowhere to save an edit. That has to be fixed first, in the
pipeline, not in the app.

### Wave 1 — persist shots

Add a shots file to the generated tree, alongside the other run state:

```
vngen/work/shots/<sceneId>.json      # or one shots.json; pick one and pin it in a schema
```

- Zod schema in `@vn/types`, validated on read like every other machine-consumed file.
- `planTasks` prefers a persisted decomposition over calling `decomposeScene`; it only
  decomposes when no file exists. Write the result immediately after decomposing.
- Because it lives under `work/`, it is human-editable and committed — consistent with how
  `work/` is already described in `CLAUDE.md`.
- `@vn/export`'s reconstruction fallback stays, for projects that predate this.

**The staleness question needs an explicit answer:** if the screenplay changes, persisted
shots may reference line ids that no longer exist. Recommended rule — drop unknown line ids
on load, emit a diagnostic, and keep the shot. Never silently re-decompose over a human's
edits; that is the one behavior that would make the editor untrustworthy.

This wave is worth doing on its own merits: today, two runs of the same project can produce
different shot decompositions (the LLM path is non-deterministic), which quietly breaks the
"deduped, resumable" promise for everything downstream of P5.

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

## Verification

- `pnpm test` — `spansFor` against non-contiguous and overlapping fixtures taken from
  `deterministicShots` output, and `resolveDrag`'s no-double-coverage invariant.
- Round-trip: edit coverage → `vngen export` → assert `show` beats moved to the expected
  positions in `story.play.json`, and that the PLAY room reflects it.
- Live: requires a real non-mock run of `examples/sample`. In mock mode every bracket is
  empty and the editor is not meaningfully testable — plan for that rather than discovering
  it.

## Risks

- **Building this against mock data produces a strip of gray boxes** and a false sense that
  it works. Get one real run first; this is the reason this plan is ordered last.
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

- [ ] Shots persist under `vngen/work/`, schema-validated, preferred over re-decomposition
- [ ] Stale line ids drop with a diagnostic; human edits are never silently overwritten
- [ ] Coverage strip renders a real scene with real frames
- [ ] Gaps and overlaps are visible; uncovered lines are unmistakable
- [ ] Drag commits one `story.setCoverage` command on drop
- [ ] `coversLines` edits provably do not rehash any task
- [ ] `CLAUDE.md` updated: `work/shots/` in the project layout, and P5's persistence rule

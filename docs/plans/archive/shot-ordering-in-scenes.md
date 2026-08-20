# Shot ordering inside a scene

Status: **shipped**. Item 7 of [`refactorTaskList.md`](../refactorTaskList.md), from §6 of the
[migration report](../../research/codebase-migration-for-new-requirements.md). Ordered **before**
item 6 (outfits): both touch `work/shots/<sceneId>.json`, but this one adds no authored field to
it and re-renders nothing, while outfits add a field and deliberately re-hash shots. Settling what
a shot's *position* is first means the outfit override arrives into a file whose ops are decided.

<!-- toc -->

<!-- tocstop -->

## What the requirement asks for

From [`../designRequirementsEtc.md`](../../designRequirementsEtc.md): "Shots can be reordered inside
of scenes", against a script model of scenes → shots → lines in which "lines … are collected into
shots" — shots as the containers, explicitly aimed at the manga/storyboarding ambition.

## Where the code already is

**A shot has no stored position.** `Shot` (`packages/types/src/entities.ts:133`) carries
`coversLines` and no order field, and the `Shot[]` in `work/shots/<sceneId>.json` is a file order
nothing reads as authority: `spansFor` sorts by first covered row, and the exporter's only use of
array order is the tie-break for a doubly-covered line — a state coverage already forbids.

**Order is derived, and it is derived from the prose.** `sceneBeats`
(`packages/export/src/playable.ts:121`) walks `scene.lines` in order and emits a `show` beat
whenever the covering shot changes. So a shot's position *is* where its covered lines sit, and a
shot whose coverage is interleaved is on screen **more than once** — it is not one position at
all.

**Coverage is a set, and interleaving is the normal case.** `coverage.ts` says so out loud: the
deterministic decomposer gives the establishing shot every narration line and each medium shot one
character's dialogue, so shots routinely alternate down the page. That is why the timeline draws
*segments* and assigns *lanes* rather than a single bracket per shot.

**Reordering within a scene renames nothing.** Line ids are allocated, not positional, so
`moveLine` already reorders without touching an id — coverage survives a move for free.

**Nothing about order reaches a task hash.** `buildShotPrompt` ignores `coversLines`, and
`proseHash` hashes covered line *texts in scene order*.

## The decision the report left open

§6 gives two readings. **Take the first — a shot reorder moves the shot's covered lines** — for
the reason the report gives: in a visual novel the prose order *is* the presentation order, the
runner replays lines, and a second independent ordering would have no runtime meaning. The known
trigger for revisiting is a manga/storyboard mode where panels genuinely order independently of
script order; until then, two orderings of one scene would have to be reconciled in the playable
projection, the timeline, drift and coverage gaps, and only one of them could win.

What the report does not say, and what this plan has to: **with set-shaped coverage, "the shot's
block of lines" only exists when the shot is contiguous.** That gap is where the design lives.

## Decisions

**A shot is reorderable exactly when it is contiguous.** One segment, in `spansFor`'s sense. A
shot with holes has no single position to move it from — it is on screen in two or more places —
so `moveShot` refuses it, by name, with the sentence saying which lines interleave and that giving
those lines to the shot (or moving lines individually) is the fix. Refusing is not a limitation
worked around later: it is the only honest answer, because every alternative silently invents an
authorial decision about the interleaving shot's prose.

**The destination is a shot, not a row.** `moveShot(shot, after)` splices the block immediately
after `after`'s last covered line; an empty `after` moves it to the top of the scene. The target
needs no contiguity — only a last row — and naming a shot rather than a row is what keeps the
invocation replayable as text after either shot's coverage has since changed.

**Only the shot's own lines move.** Uncovered lines stay where they are; they belong to no shot
and a reorder is not a statement about them. A shot that was *already* interleaved may come out
with a larger hole when a block lands inside its extent — its coverage is untouched, its lines keep
their relative order, and the timeline draws the wider bracket. That is a display consequence, not
a coverage one.

**A reorder is free, and that is the sentence that distinguishes it from `story.moveLine`.** No id
changes, so no coverage changes (`retired` and `moved` are empty). Every shot's covered lines keep
their relative order, so every `proseHash` is unchanged — `retyped` is empty, nothing drifts, and
nothing re-renders. The only thing that changes is the order of `show` beats in the playable, which
is exactly the act the author asked for. Contrast `moveLine`, which moves one line *between* blocks
and therefore reports drift.

**The op is storyboard-aware, so it does not live in `lineops.ts`.** That module states in its own
doc comment that it is pure over the scene set and knows nothing about the storyboard, and the
split is load-bearing — `shotfallout.ts` is the half that reads shots. `moveShot` goes in a new
`shotorder.ts` beside it, curried over the shots so the decision it hands back still has the
`(state: ScriptState) => LineOp` shape `planSceneEdit` takes:

```ts
export function moveShot(shots: readonly Shot[], args: { shot: string; after: string }):
  (state: ScriptState) => LineOp;
```

Returning the same `LineOp` means `session.editScene`, `planSceneEdit`, `applyScenePlan`, the
serialize-and-prove pass and undo all apply unchanged — no second write path for prose, which is
the whole reason `@vn/scriptedit` exists.

**Widening `planSceneEdit`'s callback was considered and declined.** Letting `decide` receive the
shots would mean reading shot files *before* deciding, but `scenesTouchedBy(op)` derives which
files to read *from* the op — so the callback could only be handed every scene's shots, adding a
per-scene read to the nine existing ops that do not want one. Instead the caller reads the one
scene's shots in the same load as the script state and closes over them; `planSceneEdit` still
re-reads shots for fallout, and since this op changes no coverage the fallout is empty either way.

## What shipped, against the plan

All five steps landed as written, with one shape the plan did not anticipate.

**The rule split in two.** The timeline holds `SceneCoverage` — `CoverageShot`s and lines, no
`Scene` and no `sceneId` on a shot — while `moveShot` needs a `ScriptState`. Rather than fabricate
a `Scene` in the renderer, `shotorder.ts` exposes `planShotMove(scene, shots, args)` over line ids
and `PositionedShot` (`{ id, coversLines }`, which both `Shot` and `CoverageShot` satisfy), and
`moveShot` is a thin adapter over it. So the strip judges a drag with the command's own rule against
the coverage it already has — the same shape `setCoverage` already had for `timeline.cover`.

**A no-op refusal is marked, not string-matched.** `planShotMove` refuses a move that would change
nothing — a command must not write nothing and mint an undo entry — but the codebase convention is
that a *gesture* drops such a target from its list rather than offering a pointless accept. The
refusal therefore carries `noop: true`, which is what `timeline.reorder` filters on.

**`top` is a target.** N shots have N positions but only N−1 are named by another shot, so the
interaction offers `TOP` (shared with `script.moveLine`) and the overlay aims at it with the script
column's midpoint rule (`shotDropTarget`), the boundary between two brackets being a hairline.

**`sceneDecider` in `vnauthor` became async.** `moveShot`'s rule needs the scene's storyboard, read
off disk; the other nine ops are pure and resolve immediately. The read itself is
`Workspace.shotOrder`, deliberately the same shape as the desktop's `session.shotOrder`.

## Steps

Each step independently green (`pnpm check`, `pnpm test`, `pnpm lint`).

### 1. `moveShot` in `@vn/scriptedit`

New `packages/scriptedit/src/shotorder.ts`, exported from the (browser-safe) barrel — the timeline
previews the gesture, so it must not pull in the filesystem half. Refusals, each with its own
sentence: no such shot; the shot covers nothing; the shot is not contiguous (naming the shots that
interleave with it); no such target; the target is the shot itself; the drop changes nothing. The
accepted op returns one `writes` entry — the scene with its lines resequenced — and empty
`retired`/`moved`/`retyped`.

Tests beside it (`tests/shotorder.test.ts`): a three-shot scene reordered every way; the
interleaved refusal; a move to the top; the no-op refusal; a move that lands inside an interleaved
shot's extent leaving its coverage identical; and the property that matters — for every accepted
move, each shot's covered line ids in scene order are unchanged, i.e. `proseHash` cannot move.

### 2. `story.moveShot`

A command in `apps/desktop/src/main/commands/story.ts`, `mutating` and `undoable` like its
siblings, props `scene` / `shot` / `after` (default `''`). `check` runs the same decision through
`session.previewSceneEdit`; `run` goes through `session.editScene`. A small session helper reads
the scene's shots in the same load as the script state and hands back the closure.

### 3. The timeline gesture

FLOOR's coverage timeline already drags bracket *edges* (`timeline.cover`). Dragging a bracket's
*body* reorders: a new `timeline.reorder` interaction in
`apps/desktop/src/shared/interactions.ts` carrying the shot id, whose `targets` marks each other
shot accept (with the `story.moveShot` invocation a drop would run) or refuse (with the sentence
the command itself would give — the interleaved case is the one users will meet). The overlay runs
`moveShot` itself, so the mid-drag verdict is the verdict, and layout changes on commit.

### 4. `vnauthor`

The agent's scene-editing tool gains the op, so an author can say "put the reaction shot before
the establishing one" in conversation and get the same refusal the app would give.

### 5. Docs

- `docs/desktop-app.md` — the timeline's second gesture.
- `CLAUDE.md` — the shot-decomposition core idea gains the one line that shot order is derived
  from line order and a reorder is a prose edit that drifts nothing.
- `refactorTaskList.md` / `plans/index.md` — status.

## Out of scope

- **Shots as independently ordered containers.** The second reading in §6. Revisit with a
  manga/storyboard mode, where panels genuinely order independently of script order.
- **Making an interleaved shot contiguous.** The refusal names the fix; performing it is
  `story.setCoverage`, which already exists and is the author's decision.
- **Reordering the `Shot[]` array in the JSON.** File order is not authority and this plan does
  not make it one.
- **Moving a shot to another scene.** That is `splitScene`/`mergeScene` fallout, which
  `shotfallout.ts` already carries.
- **Re-rendering.** A reorder changes no prompt and no prose hash, so nothing regenerates —
  by construction, not by policy.

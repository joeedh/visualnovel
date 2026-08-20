# Drawing a character before a scene casts them

Status: **shipped**

`todos.md`: _"the pipeline should render character portraits even if the characters aren't used in
a scene yet. it should also do the same with locations."_

## The problem

A cast sheet exists to be looked at. An author writes one, saves it, runs the pipeline — and gets
nothing, because `planTasks` enumerates over `usedCharacters` and `usedLocationVariants`, both of
which walk `reachableScenes` and take only what a scene names. The character is invisible until a
scene casts them, which is exactly backwards from how an author works: you draw the cast, then you
write scenes for the cast you have.

The same holds for a location sheet with no scene set there yet.

## What "used" meant, and who still needs it

`usedCharacters` has a second reader that must **not** change: `gateStatus` in
`packages/artgen/src/gate.ts` builds the same set inline to decide who blocks a run. Its meaning is
"an unused character never blocks the run", and widening it would halt a project on an approval
nobody is waiting for.

So this is not a widening of `usedCharacters`. It is two new enumerators, and a repointing of the
two callers that are asking a different question.

## The change

### 1. `packages/model/src/used.ts` — two new answers

```ts
/** Every character the project authored, cast or not — a sheet exists to be looked at. */
export function allCharacters(model: ProjectModel): Character[];

/** Every declared variant of every authored location, whether or not a scene sits in one. */
export function allLocationVariants(model: ProjectModel): Map<string, Set<string>>;
```

`allLocationVariants` keeps `usedLocationVariants`'s own fallback verbatim — a location that
declares no variants gets `day`, so a plate is planned for it rather than nothing.

Both `usedCharacters` and `usedLocationVariants` lose their last non-test callers and are
**deleted**; their bodies become the new ones' minus the reachability filter. `gateStatus` keeps its
own inline walk rather than being refactored onto `usedCharacters` — the two differ, and the
difference matters: a cast id the model has no character for is dropped by `usedCharacters` and
listed as `pending` by `gateStatus`, which is the honest answer, since `sceneUnblocked` blocks on
exactly that case.

The module's own doc comment says "what a run actually needs". That sentence is now wrong by one
word and gets rewritten: what a run needs includes every picture the project's _sheets_ imply, not
only the ones its _scenes_ do.

### 2. `packages/pipeline/src/planner.ts` — repoint P2 and P3

`usedLocationVariants` → `allLocationVariants`, `usedCharacters` → `allCharacters`.

**The one trap.** P4 currently reads:

```ts
for (const outfit of wardrobe.get(character.id) ?? [character.defaultOutfit]) {
```

That `??` is unreachable today: `usedOutfits` returns an entry for every _used_ character, and only
used characters got this far. Once P3 enumerates every authored character it becomes live, and it
would plan three model-sheet angles for every uncast approved character — the exact opposite of
`usedOutfits`'s stated contract that "authoring a wardrobe costs nothing until something puts a
character in it". It becomes `?? []`.

So: **a portrait is drawn for everyone; sheets stay tied to use.** A portrait is one image call and
it is what the author wants to see. A sheet is three per outfit and exists to be referenced by a
shot that does not exist yet.

### 3. `packages/artgen/src/slotgraph.ts` — repoint the same two

`buildSlotGraph`'s `plate:` and `portrait:` loops move to the new functions. Its `sheet:` loop
already goes through `usedOutfits` and is untouched, so it agrees with P4 by construction.

`packages/pipeline/src/tests/slotagreement.test.ts` plans a project to exhaustion and compares the
two hash sets outright, so it fails immediately if these two enumerations drift. It is the check on
this step, not an extra test to write.

### 4. The gate is unchanged, deliberately

`sceneUnblocked` and `gateStatus` still ask only about the cast of reachable scenes, so an uncast
character's unapproved portrait halts nothing. The tree's **Unapproved assets ▸ Awaiting approval** branch walks
the slot graph, so the new portrait shows up there to be approved — which is the workflow this item
is asking for.

## Tests

`packages/model/src/tests/used.test.ts` — the two deleted functions' cases move onto the new ones
with the reachability expectations inverted: an uncast character and an unvisited location are now
in the answer, and the `day` fallback and the missing-character case are unchanged.

New, in `packages/pipeline/src/tests/pipeline.test.ts`:

- A character no scene casts gets a `portrait` task.
- A location no scene sits in gets a `location_ref` task.
- An uncast character plans **no** model sheets, approved or not.

Already there, and now load-bearing: `gateStatus`'s "only counts characters used by reachable
scenes" case is what pins the gate to the old meaning.

## As shipped

Built as planned. Three notes:

- `usedCharacters` was deleted too, not kept — see above. `gateStatus` is byte-identical to what it
  was, which `pipeline.test.ts`'s existing "only counts characters used by reachable scenes" case
  pins.
- `slotagreement.test.ts` passed unmodified, which is the whole point of it: the planner and
  `buildSlotGraph` were repointed in the same commit and the test would have failed had only one
  been.
- `used.ts`'s module doc now states the split — two of the four answers are scoped to the story and
  two to the sheets — because that asymmetry is the thing a reader will otherwise take for a bug.

## Docs

- `CLAUDE.md` — the gate-as-barrier and slot-graph bullets, wherever they say "used".
- `docs/pipeline-contracts.md` — the P2/P3 enumeration.
- This plan's As-shipped section.
- `todos.md` line 20 `[ ]:` → `[x]:`.

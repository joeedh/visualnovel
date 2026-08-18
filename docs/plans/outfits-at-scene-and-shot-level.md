# Outfits at scene and shot level

Status: **shipped** — all eight steps (an authorable wardrobe; `outfitFor` and the prompts; the
`[[outfit:]]` marker; the two commands; the timeline's wardrobe strip; the agent's `set_outfit`;
the narrowed sheet fan-out; the docs). Item 6 of [`refactorTaskList.md`](refactorTaskList.md), from §5 of the
[migration report](../research/codebase-migration-for-new-requirements.md). Ordered **after**
item 7 ([`shot-ordering-in-scenes.md`](shot-ordering-in-scenes.md)): both touch
`work/shots/<sceneId>.json`, and shot ordering settled what a shot's *position* is without adding
a field to that file or re-rendering anything. This plan adds a field and deliberately re-renders.

<!-- toc -->

<!-- tocstop -->

## What the requirement asks for

From [`../designRequirementsEtc.md`](../designRequirementsEtc.md): outfits optionally specified at
the scene or shot level. "Optionally" is the load-bearing word — an unspecified outfit is not an
empty one, it is *inherited*, and the whole design follows from taking that literally.

## Where the code already is

**`Outfit` is a first-class type that cannot be authored.** `Outfit`
(`packages/types/src/entities.ts:30`) has an id, a description and a sheet, and `Character.outfits`
is an array of them — but `characterFromDoc` (`packages/model/src/entities.ts:37`) synthesizes
exactly one, `{ id: fm.default_outfit, description: 'default outfit' }`, and
`characterFrontMatter` has `default_outfit` and no `outfits`. **There is no way to write down a
second outfit today**, so a scene- or shot-level override would name something that does not exist.
That is the prerequisite, and it is not optional.

**`ShotSubject.outfit` is already per-shot, and already persisted as authored.**
`work/shots/<sceneId>.json` puts authored fields at the top level and run output under `shotData`,
and `subjects` is top level. So a shot-level outfit is *already stored in the right place* — what
is missing is a way to set it, and the guarantee that it means "override" rather than "whatever P5
guessed". Today P5 bakes `character.defaultOutfit` into every subject it emits
(`packages/pipeline/src/p5.ts:35,52`), which is not a guess a human made and which silently
shadows every later change to the default.

**Outfit reaches the image only as words, and it reaches the hash correctly.**
`buildShotPrompt` emits `wearing ${s.outfit}` (`packages/pipeline/src/prompts.ts:91`), so the
outfit is part of the normalized prompt and therefore part of the task key: changing it re-hashes
the shot and re-renders it. That is the right cost model, and the opposite of `coversLines`, which
`buildShotPrompt` deliberately ignores. But the *reference images* a shot task takes are
`[locationPlate, ...approvedPortraits]` — never the model sheets — so the model is told the outfit's
**id** and shown a picture of the character in their default clothes.

**Model sheets already fan out per outfit, and nothing consumes them.** P4
(`packages/pipeline/src/planner.ts:209`) loops `character.outfits` × `MODEL_SHEET_ANGLES`
(`front`/`side`/`back`), so today every approved character costs exactly three sheet tasks — because
there is exactly one outfit. The moment outfits are authorable that number is `3 × |wardrobe|`, paid
whether or not any scene uses the clothes. And `buildModelSheetPrompt` also says `wearing ${outfit}`
with the **id**, never `Outfit.description` — which is why the description field has never mattered.

**Scene chunk front-matter is `scene: <id>` and nothing else.** Everything semantic lives as
Fountain elements and `[[…]]` markers in the body, `sceneToFountain` writes those markers in a block
under the heading (`packages/model/src/serialize.ts:144`), and `branchpatch.ts` patches marker lines
surgically without reformatting the file. [`index.md`](index.md#decisions-that-span-the-batch)
already marks "front-matter is identity only" for revisit, noting nothing had wanted a field there
yet.

## The decision the report left open

§5 gives two honest options for the scene level: a body marker `[[outfit: aiko=uniform]]`, or an
`outfits:` map in scene front-matter. **Take the marker**, for the report's reason: `vngen
screenplay` and `vngen import` round-trip `[[…]]` markers for free and would silently drop a
front-matter field, so front-matter means extending that pair as well, for the same meaning.

**Front-matter is therefore considered and declined again, deliberately.** The revisit
[`index.md`](index.md#decisions-that-span-the-batch) called for has happened here and came out the
same way. What would change the answer: a second field that has no reading as a marker (something
positionless *and* structured, e.g. a per-scene render budget), or the Fountain projection being
retired. Neither is true today. Note that this rule is about **scene chunks**; character and
location sheets have always had semantic front-matter (`traits`, `palette`, `status`), so
authoring outfits there opens nothing.

## Decisions

**A character's wardrobe is an `outfits:` map on the sheet, id → description.**

```yaml
default_outfit: uniform
outfits:
  uniform: navy winter blazer and pleated skirt, enamel pins on the satchel
  track: faded club tracksuit, sleeves pushed up
```

`characterFromDoc` builds `Outfit[]` in key order and **synthesizes the default if the map omits
it**, so every sheet that exists today keeps working unchanged and a sheet with a map need not
repeat itself. `characterToDoc` writes the map back only when there is something to say — an outfit
with no description and no siblings is the synthesized default, and emitting it would grow a key in
every character file on the first edit. `applyCharacterEdit` gains the field, and the round-trip
property `fromDoc(toDoc(x)) ≡ x` is what pins the pair.

**A prompt says the description when there is one, and the id when there is not.** `wearing
${description || id}` in both `buildShotPrompt` and `buildModelSheetPrompt`. This changes no
existing prompt — today every outfit's description is the synthesized `'default outfit'`, which the
new code writes as `''` — so **nothing re-renders on this plan's account until an author writes a
description**. When they do, the re-render is the correct answer: they changed what the frame is of.

**A scene-level outfit is `[[outfit: aiko=uniform]]`, one pair per marker, repeatable.** Same shape
as `[[choice:]]`, which already repeats, rather than a comma-separated list that would need its own
escaping story. It parses to `Scene.outfits?: Record<string, string>` (character id → outfit id),
`sceneToFountain` writes it in the marker block under the heading, and `branchpatch` learns it as a
third `MarkerKind` so an edit patches the one line and leaves every other byte as authored. An
unknown character or an outfit the character does not have is a **diagnostic, not a throw** — the
same treatment `entityFile`'s failures get.

**The marker is scene-scoped, not positional, wherever it sits in the body.** A mid-scene change of
clothes is out of scope, and the fix is named: override the shots after the change, or split the
scene. The reason is not squeamishness — a positional marker would make outfit a property of *a
place in the line list*, so every scene edit (`moveLine`, `splitScene`, `mergeScene`, `moveShot`)
would have to carry it the way coverage is carried in `shotfallout.ts`, and nine ops would grow a
fallout case for an authorial act that is already expressible two other ways.

**Inheritance, not baking: `ShotSubject.outfit` becomes optional and means the shot's own
override.** The effective outfit is

```
shot subject override  →  scene marker for that character  →  character.defaultOutfit
```

resolved by one function, `outfitFor(model, scene, shot, subject)` in `@vn/model`, called by
`buildShotPrompt`, the planner and the desktop. P5 stops writing the default into the subjects it
emits — including dropping `outfit` from the decomposer's structured-output contract, because
**the decomposer does not choose clothes**; it is a storyboard artist, and the wardrobe is the
author's. A subject with no outfit resolves to the same string P5 used to bake, so no hash moves.

Shots decomposed *before* this plan keep their explicit outfit and therefore keep reading as
overrides. That is honest — the file asserts it — but it means a scene marker will not reach them.
`story.setOutfit` with an empty outfit clears an override, which is the one-line fix, and the
timeline says so rather than leaving the author to wonder why the marker did nothing.

**A shot renders a non-default outfit against that outfit's model sheet.** Without this the feature
is words-only: the model is told "wearing faded club tracksuit" and shown a reference image of the
school uniform. So when a subject's effective outfit is not the character's default, the shot task
takes that outfit's front model sheet as an additional ref and depends on it. When it *is* the
default, the refs are exactly what they are today — so no existing shot re-hashes, and the change
costs nothing to a project that never authors a second outfit. The rationale is stateable in one
line: the approved portrait already carries the default look; any other look has to be shown.

**Only outfits a scene actually asks for get sheets.** P4's fan-out narrows from `character.outfits`
to the default plus every outfit named by a marker or an override **in a reachable scene** — the
planner already computes reachable characters the same way. A wardrobe is cheap to write and
expensive to render, and there is no reason to pay for clothes no shot wears. An outfit that stops
being used stops being planned; its sheets stay in the manifest, like every other asset a run has
already paid for.

**Two commands, and the shots file gains a third writer.** `story.setOutfit(scene, shot, character,
outfit)` writes `work/shots/<sceneId>.json`; `story.setSceneOutfit(scene, character, outfit)`
patches the marker. Both `mutating` and `undoable`, both with a `stack.check`. CLAUDE.md's
"exactly two writers" line becomes three — that sentence exists to keep the count deliberate, not
to hold it at two.

## Steps

Each step independently green (`pnpm check` — both passes — `pnpm test`, `pnpm lint`).

### 1. An authorable wardrobe

`characterFrontMatter` gains `outfits: z.record(z.string()).default({})`; `characterFromDoc` builds
the array (default synthesized if absent, description `''`); `characterToDoc` and
`applyCharacterEdit` write it back; `CharacterEdit` gains the field. Tests in
`packages/model/src/tests/serialize.test.ts`: a sheet with no map still yields one outfit; a map
without the default still yields it, first; round-trip over a two-outfit character; a `default_outfit`
naming an outfit the map does not define is a diagnostic naming both.

`templates/basic`'s Aiko gains a second outfit, because a feature no fixture exercises is a feature
the recorded corpus cannot cover.

### 2. Resolution, and prompts that say what the author wrote

`ShotSubject.outfit` → optional (`shotSubject` in `packages/types/src/schemas.ts` loses its
`.default('default')`); `outfitFor` in `@vn/model`; `buildShotPrompt` and `buildModelSheetPrompt`
resolve through it and emit `description || id`; P5 stops baking (both the deterministic baseline
and the LLM path, whose system prompt and schema lose `outfit`).

The test that matters: a project decomposed under the old code and one decomposed under the new one
produce **the same shot prompts**, so the same task hashes — pinned against `@vn/testkit`'s
`synthProject`, whose settled task count (`L + 4C + 2N`) must not move.

### 3. The scene marker

`parseBranchMarker` learns `outfit`; `splitScenes` collects it into `Scene.outfits`;
`sceneToFountain` writes it; `branchpatch` gains it as a third `MarkerKind` (and the module's doc
comment stops saying "branch" — the rename of `SceneBranchEdit`/`applySceneBranchEdit` to
`SceneMarkerEdit`/`applySceneMarkerEdit` is mechanical and goes in this step). Validation in
`@vn/model`'s build: an unknown character, or an outfit the character has not authored, is a
warning naming both and the marker is ignored.

Round-trip tests beside the existing ones in `packages/model/src/tests/roundtrip.test.ts`: a scene
with two outfit markers survives `parse(write(scene)) ≡ scene`, and `vngen screenplay` →
`vngen import` carries them.

### 4. The two commands

In `apps/desktop/src/main/commands/story.ts`, beside `story.setCoverage` and the branch mutators.
Refusals, each with its own sentence: no such scene / shot / subject; the character has no outfit by
that name (listing the ones they do have); setting what is already effective (the `noop: true`
marker item 7 introduced, so a UI drops the control rather than offering a pointless accept).
`story.setOutfit` with an empty outfit clears the override and says which value the shot falls back
to. `apps/desktop/dist/commands.json` moves to 41 commands; what actually pins the pair is
`commands.test.ts`'s three id lists (mutating, undoable, checkable), which all three appear in.

The pure rules go in `apps/desktop/src/shared/outfits.ts` beside `branchops.ts` and `coverage.ts`,
because step 5's detail strip has to show the refusal the command would give rather than a second
opinion about it. `apply` in `story.ts` widens to take the scenes whole: the rewires need only
`SceneMap` and still say so, but the marker set is not in that projection.

### 5. The surface

The coverage timeline is already per-scene and already selects a shot, so both controls live in one
new detail strip below the grid: a scene row per character in the scene, and a subject row per
subject of the selected shot. Each is a select over the character's wardrobe plus an explicit
"inherit" entry; each runs its command and shows the refusal verbatim. A shot whose subject carries
an override that predates this plan is marked as such, with the sentence that clearing it lets the
scene marker through.

Pure logic (which rows exist, what each one's effective value and origin is) goes in a `.ts` with a
`tests/` sibling; the `.tsx` stays thin.

The wardrobe travels on `SceneCoverage` rather than through a second channel: a select built from
anything but what the command would accept offers refusals. So `CoverageShot` gains `outfits`
(overrides only — a subject that inherits carries nothing, and pre-filling the inherited answer
would erase the distinction the strip exists to show) and `SceneCoverage` gains `cast`, each entry
a character's wardrobe plus the scene's marker for them. A character with no sheet gets no row:
there is no wardrobe to offer.

`wardrobe.ts` builds the rows and calls `outfitFor` twice per shot row — once for what is in force,
once for what a clear would reveal — so the strip cannot disagree with the prompt about either.
`shadowedMarker` is the marking the plan asks for, and it is honest about its limit: it says only
that an override hides a marker, never that the override was baked rather than meant. Telling those
apart is the "re-deriving old baked overrides" bullet below, and it stays out of scope.

### 6. `vnauthor`

`edit_character` gains outfits; a new `set_outfit` tool covers both levels (a `shot` argument
distinguishes them), so "put Aiko in her tracksuit for the club scene" is one turn and gets the same
refusal the app would give.

Getting the *same* refusal cost a move. The rules were in `apps/desktop/src/shared/outfits.ts`, and a
package may not import an app — the founding argument for `@vn/scriptedit`, made again — so they are
now `packages/scriptedit/src/outfits.ts`, exported from the pure barrel. The marker **write** path
had the same problem: it was inlined in `session.editBranches`, so the agent would have needed a
second implementation of the fan-out over sources and the all-or-nothing. It is now
`markers.ts` (`planMarkerEdit` / `applyMarkerPlan`) behind `@vn/scriptedit/write`, and
`editBranches` is one of its two callers rather than its owner.

`Workspace` gains `sceneOutfit` and `shotOutfit`, shaped like the desktop's `sceneOutfitRule` /
`shotOutfitRule` — deliberately, since one authorial act should have one answer. The tool is thin
over them: `shot` present writes the storyboard and nothing else, `shot` absent plans a marker patch
across the sources of the load the rule was decided against.

### 7. Sheets: narrowed fan-out, and shots that reference them

The planner computes the used-outfit set from markers and overrides over reachable scenes and fans
out sheets for that set only; a shot whose effective outfit is not the character's default takes
that outfit's front sheet as a ref and depends on its task. The gate is unaffected — sheets already
come after approval, and this only changes which ones exist.

The test: a scene marker moving a character into a second outfit adds three sheet tasks and
re-hashes exactly the shots in that scene; a project with no authored wardrobe plans byte-identically
to today.

**Shipped.** `usedOutfits(model)` is `{defaultOutfit} ∪ {scene markers} ∪ {shot subject overrides}`
over reachable scenes — exactly the range of `outfitFor` over the model, which is the property that
matters: a shot can only ever ask for an outfit this set contains, so it can never depend on a sheet
nothing planned. The default goes in unconditionally, and that is what keeps a wardrobe-less project
byte-identical — a character with no `outfits:` synthesizes `[default]`, which is precisely what the
old `for (const outfit of character.outfits)` fanned out. Deliberately **not** filtered to outfits
the sheet describes: `outfitText` falls back to the id for the sheet prompt just as it does for the
shot's, so an undescribed id is a sheet with a thin prompt, not a missing dependency.

A subject out of its default references the **front** sheet only (`SHEET_FRONT`) and takes that
task's hash as a dep — a frame needs the clothes, not a turnaround, and three refs per subject would
crowd the portrait out of the reference budget. The shot follows the location-plate pattern exactly:
build the task, `doneOutput` it, `continue` if it is not done yet. So a marker reaches the planner on
one wave and the shot that references its sheet on a later one, which is what incremental planning
is for. `modelSheetTask` exists because that identity is now built in two places, and the two must
not drift or the shot would wait on a hash P4 never planned.

### 8. Docs

- `CLAUDE.md` — a core-idea bullet for outfit inheritance; the shots-file writer count; the
  `@vn/model` row gains `outfitFor`, and the `@vn/scriptedit` row the outfit rules and the marker
  write path.
- [`../fountain.md`](../fountain.md) — the `[[outfit:]]` marker beside the others.
- [`../desktop-app.md`](../desktop-app.md) — the timeline's detail strip.
- [`../vnauthor.md`](../vnauthor.md) — `set_outfit`.
- `refactorTaskList.md` / `index.md` — status, and the front-matter revisit recorded as taken.

Done, plus three things the sweep turned up that earlier steps had left behind:
[`../pipeline-contracts.md`](../pipeline-contracts.md#scenes-shots-and-lines) gets the contract in
full (the chain, the deliberate re-render, and the fan-out that follows from `outfitFor`'s range),
since CLAUDE.md's bullet promises it is stated there; and
[`../command-system.md`](../command-system.md) had drifted — its table was missing `story.moveShot`
along with the two outfit commands, and its counts still said thirty-eight commands and fifteen
undoable where the registry now holds forty-one and eighteen.

## Out of scope

- **Mid-scene costume changes.** The marker is scene-scoped; the fix is a shot override or a scene
  split. Revisit if authors reach for it, which a positional marker plus fallout in nine scene ops
  would then have to pay for.
- **Outfit sheets as a gate.** Sheets are generated, not approved — only the P3 portrait gate
  exists, and adding a second barrier is its own decision.
- **Per-shot pose and expression.** `ShotSubject` carries both and neither is authored either. Same
  shape of problem, deliberately not bundled: outfits are the one the requirements name, and the
  resolution chain this plan builds is what a later plan would reuse.
- **Outfits on locations** (time-of-day variants already cover the analogous need).
- **Re-deriving old baked overrides.** A shot decomposed before this plan keeps its explicit outfit.
  Guessing which of those were assertions and which were P5's default would be inventing an
  authorial decision — the command clears one when the author says so.

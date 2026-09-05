# Refine corrections in the stale check, tool schemas, shot variants, and commit subjects

Status: **planned**

This plan collects five findings from a review of `vnauthor` transcript `20260821-094940` in examples/test4, and of the debug
agent's report on that same thread (GitHub issue #3). One conversation surfaced all five, but they are independent and can
land as five commits. Findings 2 and 3 touch the same file, and their order is given under [Sequencing](#sequencing).

This section explains where the `examples/test4` numbers come from. Every count below was produced by reading
`examples/test4/vngen/build/manifest.json` and `examples/test4/vngen/state/tasks.jsonl` directly, and the commit shas by `git
log` in that project. The project is a fixture in this repository, but its `vngen/` tree is generated output that changes
whenever someone runs the pipeline in it, so a reader checking these numbers later may find different ones. Treat the counts
as evidence for the shape of each defect rather than as invariants to assert in a test.

## Finding 1 — a refined frame can never be regenerated

### What happens

`asset.regenerate` is always refused on a frame that went through a P7 refine attempt, and the refusal message tells the
author to take an action that has no effect.

A string comparison determines staleness:

- apps/desktop/src/main/session.ts:1662 — `stale: derived !== undefined && asset.prompt !== undefined && derived !==
  asset.prompt`
- `derived` comes from `derivePrompt` (`apps/desktop/src/main/assetprompt.ts:79`), which rebuilds
  the prompt from authored inputs and the author's override.
- `asset.prompt` in the manifest holds the prompt as sent. `makeShotRunner` records the prompt of the attempt that produced
  the bytes (packages/pipeline/src/runners.ts:117-124), and every attempt after the first carries a corrections clause
  appended by packages/pipeline/src/p6.ts:16 — `` return `${base} Corrections: ${corrections.join('; ')}.` ``. The stripping
  regex `/\s*Corrections:.*$/s` already exists at p6.ts:15.

No derivation reproduces that clause, so the asset remains stale indefinitely. Meanwhile the planner derives the same base
prompt it derived before, hashes it to the same task, finds that task `done`, and plans nothing. The refusal at
session.ts:1787 reads:

`${info.label} was rendered from a prompt the project has since changed, so its task is > orphaned. A fresh task is already
planned for it; run the pipeline.`

The second sentence is false in this case. The author runs the pipeline and gets `0 task(s) ran`.

### Evidence

In `examples/test4`, 50 of the 306 assets in `vngen/build/manifest.json` carry a corrections clause, spread across 18 scenes.
All 306 are `shot_image`; the base store `assets/manifest.json` holds a further 216, and none of those are affected. The 50
tasks are 38 `done` and 12 `needs_human`, and an author is most likely to reach for regenerate on the `needs_human` frames.

For all 50, `asset.prompt` with `/\s*Corrections:.*$/s` removed and trimmed equals `task.inputs.prompt` exactly. The recorded
prompt and the derivable prompt therefore differ by the corrections clause and by nothing else. The trailing commits in that
project record the symptom: `71db31f` re-renders the art notes and runs 5 tasks, and `fbac53e`, `fb97719` and `b28d170` each
report `0 task(s) ran`.

### Decisions this plan settles

- **Normalize before comparing; do not add a field to the manifest.** The base prompt is already recoverable exactly as
  `task.inputs.prompt`, and `refinePrompt` already treats the clause as a strippable suffix. A `basePrompt` field beside
  `prompt` would duplicate data that is already on disk, would need a back-compat path for every manifest already written
  (including all 50 of these assets), and would place a second authority on what a prompt is beside the builders, which
  assetprompt.ts:1-9 says is deliberately avoided.
- **Do not compare against `task.inputs.prompt` directly.** `assetInfo` computes `stale` for assets whose `sourceTask` is
  not in the graph, and the regeneration refusal for a task-less asset is stated separately (`session.ts:1781`). Reading the
  base off the recorded prompt allows staleness to be computed without a task.
- **Only the recorded side is normalized.** Stripping the derived side too would mean that art notes containing the literal
  text `Corrections:` silently truncate the derivation. An asset rendered before such an edit would then compare equal, be
  reported as not stale, and let `regenerate` requeue a genuinely orphaned task. The refusal exists to prevent exactly that
  spend. With only the recorded side stripped, such an asset is reported as stale and is refused, which is the conservative
  answer.
- **The refusal text is unchanged and gains no second case.** Once corrections-only assets stop being stale, every
  remaining `stale` asset is one the planner requires a different hash for, so the existing sentence is true whenever it is
  shown. An asset that is both refined and genuinely edited stays refused, which is the correct outcome. Adding a "this
  prompt includes refine corrections" branch would describe a state that no longer refuses anything.
- **`stale` also drives the asset editor's drift mark, and that mark changes too.** The change is deliberate: a P7
  correction is not an author's edit, so a frame carrying one should not read as drifted from its own inputs. The refine loop
  is already inspectable per attempt through `apps/desktop/renderer/rules/attempts.ts`, and that file is where the clause
  belongs on screen.

### What changes

**`packages/pipeline/src/p6.ts`** — export the normalization the file already performs inline:

```ts
/** Matches the `Corrections:` clause `refinePrompt` appends. No derivation reproduces one. */
const CORRECTIONS = /\s*Corrections:.*$/s;

/**
 * `prompt` without the corrections clause a refine attempt appended, which is the prompt the
 * planner derived and hashed. A prompt that never went through a refine comes back unchanged.
 */
export function basePromptOf(prompt: string): string {
  return prompt.replace(CORRECTIONS, '').trim();
}
```

`refinePrompt` calls `basePromptOf` in place of its inline `replace`. packages/pipeline/src/index.ts:9 already star-exports
`./p6.js`, so nothing is needed there.

**`apps/desktop/src/main/session.ts`** — `session.ts` already imports from `@vn/pipeline` (the import block ends at line 82),
so this change adds one import and one line in `assetInfo`:

```ts
// The prompt as sent carries any `Corrections:` clause P7 appended; the planner hashed the base.
const recorded = asset.prompt === undefined ? undefined : basePromptOf(asset.prompt);
```

Here is the block: The runtime's job is to keep the pane honest: what you see is what the store holds, no more.

```ts
stale: derived !== undefined && recorded !== undefined && derived !== recorded,
```

`asset.prompt` continues to be reported verbatim in the `prompt` field. The editor shows what was sent, and only the
comparison is normalized.

**`apps/desktop/src/shared/ipc.ts`** — two doc comments state the old rule and must be corrected in
the same commit, or the type will describe behaviour the code no longer has:

- `:502-506`, on `stale` — "The bytes were rendered from words the project has since changed" must
  say that a corrections clause appended by a refine attempt does not count as a change.
- `:537-541`, on `promptView` — "this field is what would be sent now, and the two disagreeing is what `stale` reports" is
  no longer true, because the two may differ by a corrections clause while `stale` is false.

This duplication is deliberate, and is recorded here so a reviewer does not re-raise it. `correctionDelta` in
`apps/desktop/renderer/rules/attempts.ts:59` keeps its own regex. That regex extracts the clause rather than removing it, so
`correctionDelta` is not the same function. `renderer/**` is also a browser bundle, which is why
`renderer/rules/timeline/drift.ts:2-4` keeps only the wording of drift while main derives that wording through `driftOf` from
`@vn/pipeline`. Nothing lints this. `eslint.config.mjs:218` types the whole desktop app as one `desktop` element, so no
boundaries rule stops a renderer file from importing `@vn/pipeline`, and the rule stated in `CLAUDE.md` is about
`src/shared/` being node-free rather than about `renderer/`. The duplication is a judgment call, not an enforced one.

### Tests

The new case goes in apps/desktop/src/main/tests/session.test.ts, beside the existing case at line 1237 ("writes art notes on
one variant, and the plate that predates them goes stale"):

1. A rendered shot whose manifest prompt is its derived prompt plus
   `" Corrections: fix the lighting."` reports `stale: false`, and `previewRegenerate` returns
   `ok: true`.
2. 2. After an `artNotes` edit on the shot, the same asset reports `stale: true` and `previewRegenerate` returns the orphan
   refusal. The guard still holds.

Add a `basePromptOf` case to `packages/pipeline/src/tests/pipeline.test.ts` (`describe('refinePrompt')` at line 212) covering
an un-refined prompt, a once-refined prompt and a twice-refined one.

## Finding 2 — `write_storyboard`'s schema never reaches the model

### What happens

The model is given a tool's argument names as a flat one-line string, and nested shapes do not appear in it. `zodTypeName`
(packages/authoring/src/tools.ts:219-229) returns the literal `'object'` for any `z.ZodObject` and `'any'` for `z.ZodRecord`
and `z.ZodUnion`; `describeToolParams` (:236-246) walks one level of the top object and stops. `write_storyboard` therefore
declares exactly:

```
scene: string (the scene the storyboard is for), shots: object[] (the full shot list, restated from the proposal the author approved)
```

The real schema is discarded at the API boundary. packages/authoring/src/backend.ts:261 defines `LOOSE_PARAMS = { type:
'object', additionalProperties: true }`, and line 307 sends that for every tool, with the signature string appended to the
description at lines 302-304. The prompt path does the same through `renderTools` (lines 132-139). Both paths take
`t.parameters` from `describeToolParams(t.args)` at packages/authoring/src/loop.ts:577.

`propose_storyboard` leaves the model without the fields it asks the model to restate. Its output tells the model to "restate
these shots to `write_storyboard`" (tools.ts:1223) but prints only the human listing from `formatStoryboard` (:1105-1121),
which renders `id [framing @location] cast` and the covered line ids. `pose`, `expression` and `camera` never appear. The
structured shots are on `ToolResult.data`, documented at tools.ts:115-116 as "consumed by the app, ignored by the ReAct
loop".

### Evidence

One conversation contains four rejected `write_storyboard` calls, each guessing the shape. The calls are not consecutive —
`#12` proposes and `#15` succeeds in between:

| Item | What it sent | Refusal |
| --- | --- | --- |
| #11 | `variant`, `cast: []`, `lineIds` | `shots.0.location: Required; shots.0.subjects: Required; shots.0.coversLines: Required` (× 7 shots) |
| #13 | `subjects: ["ember_kellan"]` | `shots.1.subjects.0: Expected object, received string` |
| #14 | `subjects: [{ character: "ember_kellan" }]` | `shots.1.subjects.0.characterId: Required` |
| #24 | `location: { id, variant }` | `shots.0.location: Expected string, received object` |

Three of those four are keys with obvious aliases that the schema does not accept, and one is a scalar where an object is
required.

### Decisions this plan settles

- **All three fixes land, cheapest first.** The three fixes are complementary. The JSON output removes the need to guess
  for the storyboard path specifically, the recursive signature removes that need for every tool, and the real schema lets
  the API refuse a malformed call before it costs a turn.
- **`LOOSE_PARAMS` is replaced on the native path only, by a converter written here rather than a dependency.** zod is
  pinned at `^3.24.1` across the workspace, which has no `z.toJSONSchema`, and adding `zod-to-json-schema` to `@vn/authoring`
  for one call site is not worth a dependency. The converter covers the subset the registry uses (object, string, number,
  boolean, enum, array, optional, default, nullable, record, union of those) and mirrors `zodTypeName`'s existing switch. The
  two sit next to each other, so they are updated together.
- **The generated schema never emits `additionalProperties`, including for a `.strict()` shape.** A stray key must be
  refused locally rather than by the vendor, because a vendor-side rejection arrives as a request error rather than as an
  observation the model can act on. The converter therefore ignores `_def.unknownKeys` outright. This is the one place the
  converter deliberately loses information from the zod shape, and it keeps Finding 3's `.strict()` from turning into a 400.
  Unknown keys still come back from zod at packages/authoring/src/loop.ts:867-875, with the wording Finding 3 gives them.
- **On the native path the schema replaces the `Args:` append rather than joining it.** backend.ts:302-304 appends `Args:
  ${t.parameters}` to every description. Once `parameters` carries a real JSON Schema the same information is in the request
  twice, and the recursion in Finding 2 makes the description copy the longer of the two. A tool that has a schema drops the
  append, and a tool that falls back to `LOOSE_PARAMS` keeps it. Both forms sit in the cached prefix, so the choice affects
  size rather than correctness.
- **The prompt path keeps the compact signature string.** `renderTools` has no deferred-loading mechanism, so a JSON Schema
  per tool would be pasted into every prompt of every turn. The native path costs almost nothing by comparison:
  `ToolSchema.defer` keeps a definition out of the context window until the model searches for it
  (packages/providers/src/backend.ts:22-26), and the storyboard tools are absent from `ALWAYS_LOADED` (loop.ts:250-257), so
  they are deferrable.
- **The catalog stays byte-stable.** `AgentLoop.toolSpecs` builds the catalog from a static list and the registry's order,
  so two turns produce identical catalogs (loop.ts:566-585). A generated schema must be deterministic in key order for the
  same reason. The converter emits properties in the zod shape's own order and does not sort.

### What changes

**1. `propose_storyboard` emits the shots as JSON** (`packages/authoring/src/tools.ts:1221-1226`). The human listing stays,
because the author reads it in the conversation. The JSON follows it, under a line that names the JSON as the thing to
restate:

```
Nothing is written. If the author approves, restate these shots to write_storyboard —
this is exactly the `shots` array it takes:
[ … JSON.stringify(shots, null, 2) … ]
```

`realizeDecomposition` has already realized the shots, so the JSON is valid against `storyboardShotShape` by construction,
except for the fields `write_storyboard` does not take. Strip `sceneId` and `status` before serializing so the printed JSON
can be copied and pasted without editing.

**`describeToolParams` recurses**, bounded to depth 2. `zodTypeName` gains a `depth` parameter: a `ZodObject` below the limit
renders as `{ a: string, b?: number }`, a `ZodRecord` renders as `record<string, T>`, a `ZodUnion` renders as `A | B`, and
anything past the limit falls back to the current `object` / `any`. Depth 2 covers every nested shape in the registry
(`write_storyboard`'s `shots[].subjects[]` is the deepest) and keeps the bound explicit, so a future tool cannot grow the
cached prefix without a deliberate change to that bound.

This is not storyboard-specific. Four other tools leave the model guessing today: `edit_character.outfits` (tools.ts:505) is
a `z.record` and renders as `any`; `edit_location.variants` (:556) is an array of a union, and since `zodTypeName` tests
`ZodArray` first (:222) it renders as `any[]`; `edit_scene.lines` (:755) and `edit_file.edits` (:1423) both render as
`object[]`.

**3. `ToolSpec` gains a `schema` field, and `NativeAgentBackend` sends it.** loop.ts:572-584 adds `schema:
jsonSchemaOf(t.args)` beside `parameters`; backend.ts:307 sends `parameters: t.schema ?? LOOSE_PARAMS`, and
backend.ts:302-304 appends `Args:` only when `t.schema` is absent. `LOOSE_PARAMS` stays as the fallback for the three control
tools (`propose_plan`, `ask_user`, `ask_choice`), which have no zod shape in the registry.

### Tests

- In `packages/authoring/src/tests/tools.test.ts`, extend the case at line 1712 ("describes tool arg names and intent so
  the model need not guess them") to assert that `describeToolParams(tool('write_storyboard').args)` names `characterId`,
  `pose` and `expression` inside `subjects`, and that `edit_character`'s `outfits` no longer renders as `any`.
- A new case in the same file asserts that `propose_storyboard`'s output parses as JSON and round-trips through
  `writeStoryboardShape` without an error, which confirms that restating the shots is possible.
- `packages/authoring/src/tests/backend.test.ts` checks that a tool with a nested shape produces a `parameters` object with
  the nested properties present and `additionalProperties` absent even when the shape is `.strict()`, that its description
  carries no `Args:` line, and that the catalog is byte-identical across two calls.

## Finding 3 — a shot's variant is dropped silently and cannot be changed afterwards

### What happens

`Shot.location` holds the variant id — `packages/types/src/entities.ts:188-189` says "Location variant id this shot is set
in", and the planner passes it as the variant argument to `locationTask` (`packages/pipeline/src/planner.ts:237-242`) while
taking the location itself from `scene.location`. The description of `read_shots` calls it "location variant"
(`packages/authoring/src/tools.ts:1126`), which invites a `variant` key that does not exist.

`storyboardShotShape` (tools.ts:1229-1244) is a plain `z.object`, so zod strips an unknown `variant` key and raises no issue
at packages/authoring/src/loop.ts:867. The input schemas follow the opposite rule: packages/types/src/schemas.ts:211 uses
`.strict()`, with the comment at :202 — "`.strict()` because a misspelled key here would silently drop art direction from a
prompt" — and :53 does the same for a plate binding.

Downstream, `realizeDecomposition` coerces rather than refuses. At packages/artgen/src/storyboard.ts:186 it assigns
`location: variants.includes(s.location) ? s.location : (variants[0] ?? 'day')`. A shot whose `location` names something that
is not a variant of the scene's location is replaced by the first variant, and no error is reported.

Nothing changes a shot's variant afterwards. `apps/desktop/src/main/commands/` holds no `story.setVariant` command, and no
tool sets one.

### Evidence

At item #11 the agent sent `variant: "night"` on all seven shots. The field was stripped. At #15 the write succeeded with
`location: "enemy_organization_core"` (the `location` id, not a variant), and `realizeDecomposition` coerced all seven to
`day`. At #16 the agent noticed:

Cast landed, but the variant came out `@day` despite the NIGHT heading. My `variant` field was ignored.

It then deleted all seven shots (#17–#23), tried `location: { id, variant }` (#24, refused),
rewrote them (#25), got `day` again, and concluded at #26 that `day` "is actually the pre-existing
state … that's how this location resolves." It had no way to tell a coercion from a setting.

`vngen/work/shots/em_final_boss.json` contains seven shots under a NIGHT heading, and every one of them is at `@day`.
`vngen/work/shots/se_final_boss.json` shows the same failure from an earlier run, where `se_final_boss__establishing@day`
appears beside `se_final_boss__shot1@night`, `__shot2@night` and `__shot3@night`.

### Decisions this plan settles

- **`Shot.location` is not renamed to `Shot.variant` in this plan.** The rename is right and it is a separate change:
  `.location` appears 68 times across `packages/` and `apps/`, and `Scene.location` (a location id) and `Shot.location` (a
  variant id) are spelled identically at most of those sites, so a mechanical rename is unsafe and a careful one needs its
  own review. The rename also touches every `vngen/work/shots/<sceneId>.json` on disk, so it needs a read-side alias and a
  migration. Doing it inside this plan would bury three small fixes under a wide diff. This plan files the rename as a
  follow-on change, and everything below is compatible with it.
- **The field description carries the disambiguation instead.** The `.describe()` text on `storyboardShotShape.location`
  now states that the field holds the variant id and not the location id, with an example drawn from the failure: `'the
  location variant id, e.g. "night" — not the location id; the scene already fixes the location'`.
- `.strict()` applies to exactly two shapes, `storyboardShotShape` (tools.ts:1229) and `writeStoryboardShape` (:1246). The
  other 43 tools' arg schemas here deliberately do not use it. Applying it to them would turn the current silent strip into a
  refusal across the whole registry in one commit, a behaviour change wide enough to require its own evidence. The storyboard
  shapes are the two this conversation produced evidence for. Bare `.strict()` produces `Unrecognized key(s) in object:
  'variant'`, which reaches the model through loop.ts:869-874 as `shots.0: Unrecognized key(s) in object: 'variant'`.
- **Coercion in `realizeDecomposition` stays, and only the location coercion is surfaced.** The coercion is a backstop over
  non-deterministic model output, and removing it would turn a bad proposal into a hard failure. `realizeDecomposition` also
  silently drops unresolvable subjects (storyboard.ts:189-192) and filters `coversLines` down to real line ids (:195); both
  are left silent here because neither cost this conversation anything and each would need its own wording. The location
  coercion produced seven wrong frames, so `write_storyboard`'s success message names every shot whose `location` was not a
  variant of the scene's location and says what it became.
- **`set_variant` is a mutating tool and its counterpart command, and it re-renders.** A shot's variant is a ref in its
  task hash (planner.ts:237-242), so changing it re-renders that frame and nothing else. Changing a variant is the same class
  of act as `story.setOutfit`, and the message states this.

### What changes

**1. `packages/scriptedit/src/variants.ts`**, built to the same shape as `outfits.ts`. It takes the scene as well as the
location, because the rule must check that the location is the one the scene is set in, and because the refusal sentence
names the scene the way `setShotOutfit` does (`outfits.ts:124` — `` `No shot "${args.shot}" in ${scene.id}.` ``):

```ts
export function setShotVariant(
  shots: readonly Shot[],
  scene: Pick<Scene, 'id' | 'location'>,
  location: Location,
  args: { shot: string; variant: string },
): ShotOutfitOp;
```

The return type is `ShotOutfitOp` (outfits.ts:45-47), which is reused rather than duplicated. It is already `{ ok: true;
shots; message } | { ok: false; error; noop? }`, which is exactly what this rule returns. If the reused name is unclear at
the call sites, rename it to a neutral `ShotOp` in the same commit rather than declaring a byte-identical second type.

Refuses if no such shot exists, if `location.id !== scene.location`, or if the variant is not one of `location.variants`. The
refusal for an unknown variant lists the ids that are. A request that is already set is marked `noop`. The rule lives here
for the reason outfits.ts:4-9 gives. The desktop command, the tool and any future timeline control must give the same answer.

**2. `WorkspaceSession.setShotVariant`** is built the way `setShotOutfit` is (session.ts:3893): it calls the rule, writes
`vngen/work/shots/<sceneId>.json`, and returns the rule's result widened with `coverage` and `written`. It returns that shape
because `story.setOutfit` returns `{ message, data: result.coverage, written: result.written }`
(apps/desktop/src/main/commands/story.ts:630-633), and the new command must return the same shape so the Coverage editor can
refresh from it.

**Shot fallout does not apply.** `packages/scriptedit/src/shotfallout.ts` exists for prose edits
that move or delete the lines a shot covers. A variant change touches neither `coversLines` nor
`proseHash`, so no fallout is computed and none is reported.

**3. `apps/desktop/src/main/commands/story.ts` gains `story.setVariant`**, wrapping that session method the way
`storySetOutfit` does (story.ts:611-634), with a `check` that returns the rule's verdict, so a greyed control and the command
refuse for the same reason.

**4. `packages/authoring/src/tools.ts` gains `set_variant`**, and `packages/authoring/src/workspace.ts` gains the
`shotVariant` method beside `shotOutfit` (workspace.ts:343-360). The tool's description states the cost directly. Changing a
variant changes the plate the frame is drawn against, and the frame is drawn again.

**5. `read_shots`'s description** no longer uses the bare phrase "location variant". It states that the variant is what
`@night` in the listing shows, and that `set_variant` changes it.

### Tests

- `packages/scriptedit/src/tests/variants.test.ts`: the rule accepts a real variant, refuses an unknown one by name,
  refuses a location that does not belong to the scene, and reports a no-op.
- `packages/authoring/src/tests/tools.test.ts`: `write_storyboard` refuses a shot carrying `variant: 'night'`, and the
  refusal names the key. A shot whose `location` is the location id succeeds, and the success message names the coercion.
  `set_variant` writes `vngen/work/shots/<scene>.json` with the new variant, and a second call reports the no-op.

## Finding 4 — an agent's chat reply becomes a commit subject

### What happens

`agent.run` returns the agent's whole reply as the command's message at apps/desktop/src/main/commands/agent.ts:36: `return {
message: result.final, data: result };`. `CommandOutput.message` is contractually "Human-readable one-liner for the history
and the feed" (packages/commands/src/command.ts:44-45), and `Committer.commit` passes that message straight to `subject` at
packages/commands/src/commit.ts:62: `this.run(subject(record.message, record.invocation), …)`.

`subject` (:34-38) trims, drops a trailing period, and truncates at `SUBJECT_MAX = 72`. `subject` does not search for a
newline, so a multi-paragraph reply is cut mid-second-paragraph, and git splits what remains into a subject and a body at the
first blank line.

### Evidence

In `examples/test4`:

- `fb86fc1` — subject `` Fixed and committed (`3c188a14`). ``, body `**The cause:** a shot's description…`, trailers
  `Vn-Command: agent.run`, `Vn-Seq: 39`. Its contents are `vngen/state/commands.jsonl`, `vngen/state/notifications.jsonl`,
  `vngen/state/threads/20260821-094940.jsonl`.
- `c7a72d0` — subject `` Done. `em_final_boss` is rewritten and committed (`09dd635c`). ``, body `**What…`, `Vn-Seq: 9`.
  The commit contains `commands.jsonl` and the thread.
- `ba1e3e2` has the subject `## What this story is about` and came from `agent.run(input='what is this story about' …)`.
  The question changed nothing, but the turn still produced a commit, because `agent.run` is unconditionally `mutating: true`
  and the turn wrote its journals.

Both of the first two land immediately after the agent's own `git_commit` (`3c188a1` and `09dd635`), so the subject quotes a
sha that is already in the log.

### Decisions this plan settles

- **Reword, do not suppress.** These commits carry `commands.jsonl` (the durable thread) and `notifications.jsonl`. The
  app's clean-worktree invariant requires that this provenance be committed (commit.ts:8-11). Skipping these commits would
  leave the worktree dirty at the end of an act.
- **Add an optional `subject` rather than shortening `message`.** `apps/desktop/renderer/pathux/agent.ts:75` renders
  `outcome.record.message` as the agent's reply in the conversation, so shortening `message` would empty the pane.
  `CommandOutput` gains an optional `subject` instead, carried onto `CommandRecord`, and `Committer.commit` prefers it. One
  command sets it today, and one is the right number, because `agent.run` is the only command whose result is prose rather
  than a one-liner.
- **`subject()` is fixed regardless.** Cutting at the first newline is correct for every input, and the current behaviour
  (splicing a body out of a truncated first paragraph) is a bug independent of which string is passed in. `subject()` does
  not strip markdown: a first-line-only cut leaves `ba1e3e2`'s `## What this story is about` as a heading in the subject
  line. Markdown in the subject line is moot for `agent.run` once `agent.run` sets `subject`, and no other command's
  `message` starts with markup today, so no stripping is added here.
- **Widening a committed on-disk format is acceptable here.** `CommandRecord` is the line shape of
  `vngen/state/commands.jsonl`, which is append-only and git union-merged. `CommandRecord` is a plain TypeScript interface
  with no zod gate (command.ts:129-160), and an added optional field is ignored by every existing reader, so no migration is
  needed and old lines stay valid.

### What changes

**`packages/commands/src/command.ts`** — `CommandOutput` and `CommandRecord` each gain:

```ts
/** One line for the commit subject, when `message` is prose rather than a summary. */
subject?: string;
```

**`packages/commands/src/commit.ts`** — `subject` takes the first line only, and `commit` prefers the record's own subject:

```ts
function subject(text: string, fallback: string): string {
  const line = text.trim().split('\n')[0]!.trim().replace(/\.$/, '');
  …
}
```

```ts
return this.run(subject(record.subject ?? record.message, record.invocation), trailersOf(record));
```

**`apps/desktop/src/main/commands/agent.ts:36`**:

```ts
return { message: result.final, subject: `Agent turn: ${input}`, data: result };
```

`subject()` truncates the input to 72 characters, so a long prompt becomes `Agent turn: rewrite em_final_boss to be separate
lines and shots, each…`. The truncated subject names the act, matches `Vn-Invocation` in the trailers, and does not claim a
commit that is already in the log.

packages/commands/src/stack.ts:126-127 assembles the record from the output; `subject` is copied through beside `message` and
`written`.

### Tests

`packages/commands/src/tests/commit.test.ts` (which already asserts trailers at `:65-66`):

1. 1. If a record's `message` is two paragraphs, the commit has a one-line subject and takes no body from the second
   paragraph.
2. 2. If a record carries `subject`, that string is committed rather than `message`.
3. A record with neither still falls back to `invocation`.

## Finding 5 — the analyst states an unverified symptom as fact

### What happens

The debug agent (`report.agent`, implemented in `@vn/agentreport`) filed GitHub issue #3 on this same thread. The issue's
title, its "What went wrong" section and its root cause all depend on one assertion:

The author ran it and got zero tasks, which contradicts the assurance.

That is false. Five `shot_image` tas

The last line of "From the transcript" refutes the report:

No pipeline run is recorded after the art_notes commit, so the transcript does not show why zero tasks ran. Confidence in
this finding is medium.

It recorded that it had no evidence the run produced zero tasks, and still wrote "directly
contradicting" in the body and "which is exactly what the author found broken" in the title. It
took the author's reported symptom as established and derived a root cause from it.

Two consequences follow, and acting on either would waste the reader's time:

- **The root cause names the wrong system.** "It reported success on assumption rather than verification" attributes an app
  defect (Finding 1) to the authoring agent's judgment. Acting on that root cause would change prompts and leave the defect
  in place.
- **Its first recommendation asks for a capability that does not exist.** The recommendation is to "run the pipeline (or a
  status/dry-run) and report the tasks that were actually queued". None of the 45 tools in `ALL_TOOLS`
  (packages/authoring/src/tools.ts:2244-2289) does this, and no tool can do it directly, because `@vn/authoring` must never
  import `@vn/pipeline` or `@vn/scheduler` (the boundaries rule; CLAUDE.md, "Package layering"). The report's title faults
  the agent for not using a tool that the package layering rule puts out of reach. A pipeline run also spends real
  image-model calls, so "run it to confirm" is not a free verification step in any case.

Its third and fourth recommendations also contradict each other. Recommendation #3 says the `@day`-under-NIGHT mismatch
should have been escalated rather than worked around, and recommendation #4 says the attempt to fix it was needless churn
that should have been targeted edits. Together the two recommendations ask for a targeted edit that Finding 3 shows does not
exist.

The report depends on `Read the source: no`. The chain that refutes the report is short and entirely in this repository:
`set_art_notes` → `work/shots/<scene>.json` → `buildShotChunks` folds the note into the prompt
(packages/artgen/src/prompts.ts:420) → `prompt` is a hashed input of `shot_image` (packages/artgen/src/prompts.ts:458-473).

### What the report got right, and which this plan keeps

The `@day`-under-NIGHT mismatch is real and appears as Finding 3 here. Items #17–#25 achieved nothing. The `deleteShot`
warning about paid-for art was worth flagging. None of these three points is disputed.

### Decisions this plan settles

- **Only decidable claims are enforced, and this section names which claims those are.** "Has this claim been corroborated
  against the transcript" cannot be checked at a seam: `Analysis` (`packages/agentreport/src/report.ts:13-41`) holds six
  free-prose fields with no per-claim provenance, and no scan over prose can distinguish a claim the analyst verified from
  one it inherited. Redaction does not model this case. `redact` scans for a known list of names, which is decidable, and
  corroboration is not. Two of the three changes below are structural and unconditional; the third is a prompt change, and is
  labelled as one.
- **The analyst has no pipeline of its own and is not asked to reproduce anything.** Its inputs are a transcript, the
  project as it stands, and the request ring. The fix changes what the analyst is given and how the report is framed; it does
  not give the analyst more to run.
- **`@vn/agentreport` may import `@vn/authoring`** — the package is a leaf with a wide allow-list
  (packages/agentreport/package.json:10, eslint.config.mjs:47-57), so change 3 is legal. The `@vn/authoring` → `@vn/pipeline`
  prohibition quoted above constrains the reported agent, not the analyst.
- This overlaps [`archive/INDEX.md#the-debug-agent-as-a-conversation`](archive/INDEX.md#the-debug-agent-as-a-conversation),
  which rebuilt `analyzeWithTools` into a held conversation. Nothing here contradicts it. Changes 1 and 3 cover what goes
  into the request and what the renderer prints, and change 2 requires only a record of which tools ran. That plan has
  landed, so change 2 keys off the held analyst's tool log rather than off a single `analyzeWithTools` call.
- **The scope covers the failure modes above and nothing wider.** The report makes four behavioural recommendations for
  `vnauthor`, and none is adopted. Three are wrong or impossible for the reasons given. The fourth holds that art notes
  belonged in the first pass. That recommendation is defensible, but the author approved the plan at item #6 without art
  notes, and approving a plan before the work starts is how a plan-first agent is meant to work.

### What changes

**1. The author's own words are always printed as a claim under test.** The host already has the author's statement, which is
passed into the report request and appears in the transcript excerpt as `Author statement: '…'`. The renderer gains a
standing section that prints that statement verbatim whenever it is non-empty. The section's heading says the statement is
what the author reported and was the analyst's starting point rather than a finding. This is enforceable because the host
owns both the string and the decision to print it, so it depends on nothing the model wrote. The section does not stop the
analyst asserting the symptom in `rootCause`, but it does stop a reader from taking the report's framing as the only account.
The system prompt in `packages/agentreport/src/analyze.ts` is updated in the same commit to say that the author's statement
is a claim to test, and that a symptom the transcript does not corroborate is written as "the author reports X". That prompt
change carries no claim of enforcement.

**2. `readSource` starts meaning what its doc comment already says, and gates confidence.** analyze.ts:280 says a report "is
worth less from an analyst that never opened it", but the field is set to `Boolean(opts.source)` at :291 — true whenever a
source root was offered and the tool path produced a report, whether or not any file was read. `analyzeWithTools` has the
record of which tools ran, so `readSource` becomes "the analyst actually called a source-reading tool", which is what the
sentence claims. `confidence` is then clamped to `low` when a source root was offered and no source tool was called. A report
from an author who declined source access is not capped, because there was nothing to open. Capping it would lower confidence
for the author's privacy choice rather than for anything the analyst did, and analyze.ts:52 already instructs the analyst to
lower its own confidence when the transcript is thin.

**3. The analyst is given the reported agent's tool list, so it stops recommending capabilities that do not exist.** The
registry can already be constructed here (`createRegistry`, packages/authoring/src/tools.ts:2292). The report context carries
the tool names with their one-line descriptions, declared the same way the source manifest is. The tool list would have
prevented "run the pipeline (or a status/dry-run)", and it prevents such text at the point the recommendation is written
rather than by a check afterwards. A post-hoc name check was considered and rejected: the offending text was in
`recommendations[].behaviour` (report.ts:27), which is free prose, while `where` (:28) is documented as "the file or tool it
belongs in" and in this report held a phase description. A check over `where` would have been inert on exactly this case, and
there is no way to tell a tool name from a file path in `where`.

`createRegistry` takes an `extra` argument, so `ALL_TOOLS` does not fix the tool list a given host runs with. The context
must be built from the registry the reported host actually used, not from `ALL_TOOLS`.

### Tests

See `packages/agentreport/src/tests/report.test.ts` for 1, and `analyze.test.ts` for 2 and 3:

1. 1. A report request that carries an author statement renders the standing section with that statement verbatim. A request
   that carries no author statement renders no section and no empty heading.
2. 2. A run whose analyst called no source tool on a source root it was given comes back with `readSource: false` and
   `confidence: 'low'`, whatever the analyst proposed. A run whose analyst did call a source tool keeps the analyst's own
   confidence. A run that was offered no source root is not capped.
3. The context handed to the analyst names every tool in the supplied registry, including one passed
   through `extra`.

## Sequencing

Finding 1 is highest severity and touches three files; land it first. Finding 2 lands before Finding 3, for two reasons:
Finding 2's converter guarantees that `.strict()` does not reach the vendor as `additionalProperties: false`, and its
recursive signature and JSON output make Finding 3's refusals rare rather than routine. Findings 4 and 5 are independent of
the other three.

## Out of scope

- **Renaming `Shot.location` to `Shot.variant`.** Finding 3 gives the reasons. This plan recommends the rename as a
  follow-on and does not carry it out.
- **`.strict()` on the other 43 tool arg schemas.** Finding 3 gives the reasons.
- **Replacing `LOOSE_PARAMS` on the prompt path.** Reasons under Finding 2.
- **Surfacing `realizeDecomposition`'s subject and `coversLines` coercions.** Finding 3 gives the reasons.
- **Making `agent.run` non-mutating for a read-only turn.** `ba1e3e2` shows a question producing a commit, but the turn
  genuinely wrote journals, and deciding mutation after the fact would change how the command stack works rather than fix a
  commit message.
- **Stripping markdown from a commit subject.** The reasons are given under Finding 4.
- **The debug agent makes four behavioural recommendations for `vnauthor`.** Finding 5 gives the reasons.

## Review

A fresh-context agent pressure-tested this plan on 2026-08-21, per
[`../reference/conventions.md`](../reference/conventions.md#plans). Each finding below is paired with what it produced:

Fixed. All three severe findings are against Finding 5, and all three are correct.

- The recommendation-registry check would have been inert on the case that motivated it. The offending text was in
  `recommendations[].behaviour`, which is free prose. `where` is documented as "the file or tool it belongs in"
  (report.ts:28) but held a phase description here, and nothing in that field distinguishes a tool name from a file path. The
  post-hoc check is dropped. Change 3 now gives the analyst the tool list up front instead, and the section records the
  rejected alternative.
- "Mark a symptom as reported, not established" had no mechanism, and the redaction analogy did not hold. Redaction scans a
  known name list and is decidable; corroboration is not decidable, and `Analysis` has no per-claim provenance field. The
  rewrite makes the change an unconditional host-rendered section that prints the author's own statement, which depends on
  nothing the model wrote, plus a prompt change labelled as a prompt change. The section says outright which of its three
  changes are enforced and which are asked for.
- The confidence cap was keyed off a field that does not mean what the plan said. `readSource` is `Boolean(opts.source)`
  (`analyze.ts:291`). It is true when a source root was offered and false when the author declined, so the cap would have
  applied to authors who declined source sharing while leaving an analyst that opened nothing at `high`. Change 2 now
  redefines `readSource` to mean a source tool was actually called (which is what `analyze.ts:280` already claims) and caps
  only when a root was offered and unused.

**Fixed — six points that were under-specified or undecided.**

- The list of shapes that get `.strict()` was plural and unbounded. Exactly two get it now, `storyboardShotShape` and
  `writeStoryboardShape`, and the other 43 shapes moved to Out of scope.
- `setShotVariant`'s signature took a bare `Location`, so the rule had no scene id to report when it refused and no way to
  check that the location belongs to the scene. The signature now takes the scene as well, matching `setShotOutfit`
  (outfits.ts:117-124), and reuses `ShotOutfitOp` rather than declaring a byte-identical second type.
- The command was documented as returning what `story.setOutfit` returns, and the session-level wrapper was left
  unspecified. The wrapper is now specified, along with `coverage` and `written`, and a statement that `shotfallout.ts` does
  not apply to a variant change.
- The `Args:` description append would have duplicated the schema in the cached prefix, so the append drops for any tool
  that carries a schema.
- The converter did not state its contract with `.strict()`, and a naive implementation would have emitted
  `additionalProperties: false`, which produces the vendor refusal that Finding 2 forbids. The converter now ignores
  `_def.unknownKeys` explicitly, and Sequencing states the resulting order.
- Two doc comments in `apps/desktop/src/shared/ipc.ts` (`:502-506`, `:537-541`) state the rule that Finding 1 falsifies.
  Added to that finding's change list.

**Fixed — citation errors.** renderer/rules/timeline/drift.ts:2-4 explains where drift is derived rather than prohibiting an
import, and nothing lints `renderer/**` for it (eslint.config.mjs:218). The paragraph now says the duplication is a judgment
call. `ALL_TOOLS` holds 45 tools, not 44, and `createRegistry` takes an `extra`, which change 3 must account for.
`edit_location.variants` renders as `any[]`, not `any`, because `ZodArray` is tested first. `storyboardShotShape` is at
:1229-1244. Off-by-one corrections applied to entities.ts:188-189, tools.ts:115-116, tools.ts:1423, story.ts:611-634,
session.ts:1787 and :1781, backend.ts:261/:302-304/:307, loop.ts:572-584, and planner.ts:237-242. The instruction to export
`basePromptOf` from packages/pipeline/src/index.ts was a no-op, since index.ts:9 already star-exports `./p6.js`. The text now
says so.

**Fixed — unstated assumptions.** The top of the document now states how the `examples/test4` numbers were produced and that
they move when someone runs the pipeline there. Finding 5 now states that `@vn/agentreport` may import `@vn/authoring`.
Finding 3 now states that `realizeDecomposition` silently drops subjects and filters `coversLines` too, and explains why only
the location coercion is surfaced. Finding 4 now states that `CommandRecord` is a committed on-disk line shape, and explains
why widening it needs no migration.

**Fixed — test placement.** The three test locations that named a directory but no file now name
`packages/scriptedit/src/tests/variants.test.ts`, `packages/agentreport/src/tests/report.test.ts` and `analyze.test.ts`.
Finding 3's `set_variant` test moved into the `@vn/authoring` group it belongs to. The reviewer verified that every other
cited test anchor is exact.

**Recorded, not fixed.**

- `.strict()` cannot be reversed for a conversation already in flight. That irreversibility is accepted, because the
  improvement is that the model can read the refusal, and no data is at risk.
- The change to `subject()` affects every future commit subject, not just `agent.run`. That is intended, because cutting at
  the first newline is correct for every input. Written history is untouched.
- The `ba1e3e2` markdown heading survives a first-line cut. Finding 4 states this and gives the reason no stripping is
  added.

The review confirmed the following as sound and verified every citation. Finding 1's diagnosis and fix hold (`stale` has
exactly one producer, so the one-line change is sufficient, and the asymmetric normalization argument is correct). Finding
2's diagnosis holds in full, including that zod is pinned `^3.24.1` in all five package manifests and that the storyboard
tools are deferrable. Finding 3's diagnosis holds in full, including the `.strict()` precedent and the absence of any
`story.setVariant`. Finding 4 holds end to end, and the review called it the cleanest of the five.

# Creating shots by hand and by agent

**Status: planned.** Nothing here is built.

## The incoherence this plan removes

The repo treats a shot as an **authored object from the moment it exists** — the shots file is
documented as human-editable, authored fields sit at its top level, and coverage, order, wardrobe
and art notes are all authorial acts with commands and (partly) agent tools. But **creation and
assignment have no authorial channel at all.** The only way a shot comes into being is
`decomposeScene` (P5): a one-shot structured-output call whose answer is persisted un-reviewed and
is then permanent, because `work/shots/<sceneId>.json` wins forever. That inverts the project's own
philosophy: everywhere else the agent works plan → refusal → approval, and precisely at the
highest-stakes act in the scene→art chain — the one that is non-deterministic and mints task
identities — there is no review loop and no hand on the wheel.

Two smaller facts confirm the gap is historical rather than designed:

- `setCoverage` — the rule for assigning lines to shots — lives in
  `apps/desktop/src/shared/coverage.ts`, where the agent cannot reach it. The repo's stated
  principle is that a rule two hosts need lives in a package *because* "the agent may not import an
  app"; that is exactly why the marker write path and `branchops` moved into `@vn/scriptedit`.
  Coverage assignment is the same story, one step before the move happened.
- The agent can `moveShot`, set a shot's outfit and its art notes — every act *downstream* of a
  storyboard — and cannot create a shot, delete one, or cover a line.

What this plan does **not** do is unseat `decomposeScene`. Its constraints are real and would bind
any creator, agent included: shot ids feed task identity, so re-decomposition re-renders paid art;
an absent file being the only "decompose me" signal is what makes runs resumable; the deterministic
fallback is what lets `--mock` and keyless runs work. `decomposeScene` stays as the batch/headless
path. What changes is that it stops being the *only* creation path.

## Part A — the rules move into `@vn/scriptedit`

The pure decisions, so both hosts run the same sentence. `@vn/scriptedit`'s allow-list does not
change; everything below is deterministic and input-side.

1. **`setCoverage`, `spansFor`, `resolveDrag` and `runsOf` move from
   `apps/desktop/src/shared/coverage.ts` into `@vn/scriptedit`** (a `coverage.ts` module in the
   pure barrel), with their tests. `previewOf` stays in the renderer — it is ghost geometry, and
   it already lives in `renderer/rules/timeline/coverage.ts`, not the shared module. **The types
   come apart before the code moves:** `spansFor`'s signature is built on `CoverageLine` /
   `CoverageShot` from the desktop's `ipc.ts` — an app path a package cannot import, and fat IPC
   projections besides (`image`, `drift`, `outfits`). The package declares the *minimal
   structural* shapes its rules actually read (id, text/kind for a line; id, `coversLines` for a
   shot); `ipc.ts`'s projections satisfy them structurally and stay where they are, serving the
   ~15 renderer importers unchanged. The desktop's `shared/coverage.ts` becomes a re-export during
   the move and is deleted once the renderer imports the package directly. Behaviour is unchanged —
   the one invariant (no line covered by two shots; a claim that would empty a *neighbour* is
   refused) is already stated there and travels with the code.
2. **`newShot` — a new rule.** Creates a shot in an existing storyboard: allocates an id, claims an
   initial set of lines through the same `setCoverage` decision (so the neighbour-emptying refusal
   applies from birth), and defaults the rest — framing `medium`, the scene's primary location
   variant, subjects derived from the speakers of the claimed lines, no outfit (absent means
   inherit). Refusals:
   - a shot must claim at least one line at creation — an orphan cannot be made, only become;
   - ids are `<sceneId>__shot<n>` (the same namespacing `shotId` already applies), allocated from
     a **`nextShot` high-water mark persisted in the shots file** — the `[[nextline:]]` posture,
     and for the same reason: a scan of ids-in-use is not enough, because a shot's id is in its
     task hash (`shotInputs`), so a re-minted id whose framing and subjects happen to match a
     deleted shot's hashes to a task that is already `done` — the "new" shot silently inherits the
     deleted shot's frame, which is precisely the frame the author deleted. A high-water mark
     makes reuse impossible rather than unlikely.
3. **`newShot` on an undecomposed scene creates the storyboard — and says what that costs.**
   Writing the first hand-made shot writes `work/shots/<sceneId>.json`, which — by the existing
   contract — means the scene is now storyboarded: `decomposeAll` will keep it, the planner will
   not auto-decompose it mid-run, and `decomposeAllPreview` counts it as done. So the trap is a
   scene with one hand-made shot covering three lines, whose next `vngen run` renders that frame
   and leaves every other line a gap forever — and `withCoverage`'s first-line repair never runs
   for a hand-made storyboard, so the scene may open blank. The command's `check` therefore says
   it plainly on the first shot of an undecomposed scene: *this ends decomposition for this scene;
   every uncovered line stays uncovered until you cover it.* The gaps themselves are the Coverage
   editor's whole subject, so the state is visible — but visible after is not the same as priced
   before. This is deliberate and is the heart of the plan: a scene may now be storyboarded
   entirely by hand, one shot at a time, and the absent-file signal keeps exactly its current
   meaning.
4. **`deleteShot` — the symmetric rule, and deleting the last shot restores the signal.** Removes
   a shot; its covered lines become gaps (released, never handed to a neighbour — same posture as
   `setCoverage`). Deleting the **last** shot deletes the file, because the codebase already
   decided that question: `deleteShots` (`@vn/store`) exists precisely so "a scene whose last shot
   went away has to lose the file to get a fresh storyboard instead of staying blank forever", and
   `shotFallout` routes an emptied scene there today. An empty list is never written (the store's
   "absent, not empty" contract), and the author gets a way back to "decompose this" through a
   command instead of hand-deleting a file. The `check` prices both cases: the frames the shot had
   rendered are named, because deleting a shot orphans paid art, and the last-shot case adds the
   `shotFallout` sentence — this scene will be decomposed again.

**Hazard to price, not hide:** a new shot id is a new task subject — the planner will owe it a
frame, and its subjects need approved portraits. `story.newShot`'s `check` must say what the shot
will cost before the author agrees, the same way `story.setHeading`'s check prices a re-render.
Coverage edits themselves stay free (`buildShotPrompt` reads neither `coversLines` nor line text),
and that contract is not touched.

## Part B — commands and the Coverage editor

### Commands

- **`story.newShot`** and **`story.deleteShot`**, thin wrappers over the Part A rules, both
  undoable, both declaring their refusals in `check`. `story.setCoverage` is retargeted onto the
  package rule and does not change shape.

### Creating a shot in the editor

- **The gap gutter is the door, and the gesture is declared.** The vermilion uncovered-lines
  gutter is where a missing shot is already visible, so it is where one is made: dragging across
  gap rows offers **New shot from these lines**, which runs `story.newShot` claiming exactly those
  rows. The drag is a third declared `Interaction` — `timeline.create`, beside `cover` and
  `reorder` — so its targets are enumerable and its mid-gesture verdict is the verdict that would
  happen. Disambiguation is by surface, not by modifier: the drag starts on the **gutter cell**,
  which is its own element — the prose cell keeps click-to-edit, and a bracket handle keeps
  `timeline.cover` — so no two gestures ever claim the same `pointerdown`. A `+ shot` control in
  the strip header covers the no-gaps case, opening `openCommandDialog('story.newShot', …)`
  prefilled with the scene — the same two-host `CommandForm` every other command uses, so the cost
  sentence from `check` is on screen as the author fills it in. Every new affordance carries a
  tooltip: the gutter says what dragging it does, per the no-exceptions rule.
- **An undecomposed scene stops being a dead end.** Today it draws the script column and a note
  saying where shots come from. The note gains the same door: decompose (the existing command), or
  start placing shots by hand. Both are invocations, checked before they are drawn.
- **Deleting is on the bracket.** A shot's context menu offers `story.deleteShot`; the refusal for
  the last shot is shown, not hidden, like every other declined invocation.

### The delay on a drop is shown, not endured

Today `run()` awaits `command:exec` and then re-reads the whole strip, and during that window the
editor is silent — a reorder (`story.moveShot` rewrites the scene file and may commit to git) can
take long enough that the drop reads as having not worked, which invites a second, destructive
drag.

- **A pending command puts the strip in a visible busy state.** The notice row becomes an
  indeterminate progress bar carrying the command's own title ("Moving shot…", "Updating
  coverage…"), shown only after ~150 ms so a fast commit never flashes. Design-token colours only;
  no new accent hue.
- **The gesture surface locks while a write is in flight.** Handles and brackets refuse a new grab
  with a sentence ("Waiting for the last edit to land."), the same posture as the open-text-row
  rule: a refusal with a reason, never a dead surface — and the sentence doubles as the locked
  surface's tooltip, because a disabled control's tooltip is its refusal. Line editing and
  wardrobe selects lock the same way, because they share the same re-read. Today nothing guards
  this: `run()` awaits with no in-flight state, and a second grab can start mid-write. The busy
  state machine is pure logic in `renderer/rules/` with a `tests/` sibling; the surface itself is
  verified live over CDP, per the editor conventions.
- **The bar resolves into the command's outcome sentence** — the existing ok/refused notice — so
  the progress state and the result are one row changing tone, not two competing surfaces.

## Part C — the agent

1. **Decomposition's prompt-and-parse moves to `@vn/artgen`.** `decomposeScene`,
   `deterministicShots` and `withCoverage` are generative *policy* with no pipeline dependency —
   exactly the shape `artgen` exists for (the pipeline, the desktop app and `authoring` all need
   it, and `authoring` cannot import the pipeline). `@vn/pipeline` re-exports them; `decomposeAll`
   and its persistence rules stay in the pipeline untouched. Two details the move owns:
   `withCoverage` is unexported today and gets its public name here, and the comment in
   `@vn/export`'s `playable.ts` that names "`@vn/pipeline`'s `deterministicShots`" moves with the
   symbol.
2. **`edit_scene` grows two ops: `newShot` and `deleteShot`**, named exactly as the commands are,
   calling the same rules — an agent transcript and a command history keep reading as one
   vocabulary. `set_coverage` joins as its own tool (it is a set, not a line-op, and its argument
   shape is different), wrapping the moved `setCoverage`.
3. **`propose_storyboard` — decomposition as a proposal — and `write_storyboard`, the half that
   persists it.** `propose_storyboard` calls `decomposeScene` and returns the decomposition *into
   the conversation* — shots, coverage, and the source (`model` or `baseline`, with its reason) —
   without writing anything. Persisting is a **separate mutating tool, `write_storyboard`, that
   takes the full shot list as its arguments**: the agent restates the proposal the author
   approved, and the tool validates it through the same schema, subject resolution and coverage
   backstop the pipeline applies. Explicit arguments rather than "persist the last proposal"
   because `decomposeScene` is non-deterministic — re-calling it at persist time would write a
   storyboard the author never read, which is the exact un-reviewed permanence this plan exists to
   remove. The corollary is stated, not hidden: **approval and persistence happen inside one
   conversation.** Threads reopen read-only, so a proposal from a closed conversation is dead; the
   recovery is to propose again, and a re-proposal is a new roll of the dice. `write_storyboard`
   refuses when a storyboard already exists (no `force`, same as `decomposeAll`). The
   deterministic-fallback contract is unchanged; what is new is that a baseline *proposal* is
   something an author reads and declines rather than something a batch declines to write on their
   behalf.
4. **The tool context grows a text seam.** `ctx.art` exposes only the image backend today, and
   nothing in `tools.ts` holds a `Providers` — so `propose_storyboard` needs the structured-text
   provider wired into the tool context (key resolution, the model id from `project.yaml`, and the
   mock behaviour), injected the way `workspaceArtGen` already injects the image half. Real
   wiring, budgeted as its own step rather than assumed.

The boundaries lint needs no exception for any of this: nothing in `authoring` imports
`@vn/pipeline`, and the one generative call the agent gains lives behind the same `providers` seam
its other tools already use.

### The agent's context, so the new powers don't confuse it

New tools with no supporting context produce a model that misuses them. Knowledge is routed to
the three places
[`archive/what-the-agent-knows-about-the-story-format.md`](archive/what-the-agent-knows-about-the-story-format.md)
established — the system prompt for what is always true, refusals for what is case-specific, a
skill for workflow — and every surface that currently teaches the *old* rule is corrected in the
same stage that changes it:

- **`SYSTEM_PROMPT` gains a SHOTS AND COVERAGE paragraph** (`packages/authoring/src/context.ts`),
  sized like the existing BRANCHING one: a shot covers a *set* of line ids; no line is covered by
  two shots, and claiming takes; a released line is a gap the runner shows as the previous image
  held too long; coverage edits are free but a **new shot id is a new frame the pipeline will owe**
  — the one cost sentence the model must weigh before creating rather than re-covering. The
  paragraph joins the shot knowledge the prompt already carries — the shot art-notes rung and the
  shot-level outfit override — rather than being the first mention, so it is written to sit
  beside those, not to introduce the noun.
- **The `full-production` skill stops saying "You cannot make shots."**
  (`templates/basic/.aiagent/skills/full-production/SKILL.md`, "The hand-off — shots" section.)
  That sentence — and "Framing is the decomposer's choice, not yours", and its copy of the
  absent-file contract — is exactly the context that would make a correctly-built agent refuse
  work it can now do. The section becomes "shots, by decomposition or by hand": decompose for a
  whole project, `propose_storyboard` for a scene in conversation, `newShot` for surgical
  additions, with the cost framing kept.
- **Mode gating is decided per tool, not inherited.** `newShot`, `deleteShot`, `set_coverage` and
  `write_storyboard` are `mutating: true` — plan mode refuses them, like every write.
  `propose_storyboard` writes nothing but **spends** (one structured text call), and plan-mode
  gating is purely on `mutating` — so shipping it non-mutating creates a genuinely new category, a
  plan-mode tool that costs money. There is no precedent to inherit: the nearest neighbour,
  `generate_image`, is `mutating: true, confirm: true` because it writes an asset *and* costs an
  image. The plan decides it deliberately: `mutating: false`, no `confirm`, and the description
  carries the cost — one text call to price a whole storyboard during planning is the cheap half
  of exactly what plan mode is for. If that posture proves wrong, the fallback is `confirm: true`,
  not `mutating`.
- **Reading has to precede writing.** `set_coverage` is unusable unless the model can see what
  covers what; today the storyboard is read only implicitly (`shotsFor`, inside other tools).
  Whichever door is chosen — a small coverage report in an existing read tool's answer, or the
  shots file made legible directly — the tool descriptions must name it, so the model is never
  told to edit state it has no way to look at.
- **The caching contract is respected, not renegotiated.** The system prompt and the tools block
  are part of the byte-stable cached prefix
  ([`archive/prompt-caching-and-deferred-tool-loading.md`](archive/prompt-caching-and-deferred-tool-loading.md)):
  new prompt text and new tools land between conversations, never edited into a live one — a
  mid-conversation change, if one is ever needed, rides the existing appended
  `{"role":"system"}` channel. The desktop's System Prompt editor needs no change; it renders
  whatever is sent.

## Part D — the sentences that stop being true

This plan changes what several load-bearing sentences mean, and every place that states one is
corrected **in the same stage that falsifies it** — a doc or comment describing the old world is
this plan's version of a failing test. The known sites, found by searching for the claims rather
than the filenames (the sweep at the end re-runs the search, because this list will be stale by
then):

**The "only signal" contract.** "An absent `work/shots/<sceneId>.json` is the only signal meaning
'decompose this'" keeps its meaning for the batch, but the sentence must now say a hand-made first
shot also ends it. It is stated in:

- `CLAUDE.md` — the "Decomposing every scene is an explicit act" bullet;
- [`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) — the decomposition contract, the P5
  section, **and** the second statement inside the scene-heading contract;
- [`../guides/cli.md`](../guides/cli.md) — states the whole contract ("an absent one is the only signal … the
  file wins forever"), a surface class the first draft of this list missed entirely;
- `apps/cli/src/commands.ts` — `vngen decompose`'s own printed sentences, and the test that
  asserts them (`apps/cli/src/tests/commands.test.ts`);
- `packages/pipeline/src/decompose.ts` — `decomposeAll`'s doc comment ("An absent file is the only
  signal…") and `DecomposeAllResult`'s, plus `decomposeall.test.ts`'s framing comments;
- `packages/pipeline/src/p5.ts` — `Decomposition`'s doc comment, and the module's framing of
  itself as where storyboards come from;
- `packages/store/src/shots.ts` — `readShots`'s and `deleteShots`'s doc comments (the latter is
  the sentence Part A.4 now *builds on* rather than contradicts, and it stays true);
- `packages/scriptedit/src/shotfallout.ts` — the emptied-scene comment, which becomes one of two
  callers of the same posture;
- `apps/desktop/src/main/commands/story.ts` — `story.decomposeAll`'s `description`, which an
  author reads in the palette;
- `templates/basic/.aiagent/skills/full-production/SKILL.md` — the skill's copy of the contract,
  beside the "You cannot make shots" section Part C rewrites;
- `packages/export/src/playable.ts` — the comment naming "`@vn/pipeline`'s `deterministicShots`",
  stale after the Part C move (also noted there).

**What the model is told it can do.** `edit_scene`'s description
(`packages/authoring/src/tools.ts`) enumerates its ops — it grows the two new ones, with their
cost stated the way `moveShot`'s already is ("costs it nothing") — and the tools that today
refuse an undecomposed scene by pointing at the storyboard must, where the refusal survives,
point at *both* doors. A tool description is read by the exact audience a stale one misleads, so
these are corrected in the stage that adds the ops, not in a docs pass after.

**The moved comments.** `apps/desktop/src/shared/coverage.ts`'s header explains why it lives in
`shared/` — that reasoning is superseded by the move, and the package home gets a header saying
why it lives *there* (two hosts, one rule), in the voice of `@vn/scriptedit`'s existing modules.
The re-export left behind during the move carries a comment naming its replacement so it cannot
outlive the migration silently.

**The docs that describe the surfaces.** [`../reference/desktop-app.md`](../reference/desktop-app.md#shot-coverage) — the
Shot Coverage section's "decomposed on purpose" bullet gains the creation door, and the busy state
joins the gesture rules; [`../reference/vnauthor.md`](../reference/vnauthor.md#tools) — the tool table;
[`../reference/command-system.md`](../reference/command-system.md) — anywhere a command count is named. Shipped plans
([`archive/shot-timeline-editor.md`](archive/shot-timeline-editor.md) and kin) are history and are **not**
rewritten; a plan is the authority on its own scope, and this one records the change.

## Out of scope

- Routing the agent's tool loop through the command registry — still the follow-on
  [`archive/command-system.md`](archive/command-system.md) records, and this plan neither needs it nor advances it.
- Merging or splitting shots, and any change to `timeline.reorder`'s refusal for interleaved
  shots.
- Any change to task identity, `buildShotPrompt`, or what invalidates art.

## Finishing checklist

Beyond [`../reference/conventions.md`](../reference/conventions.md#finishing-a-plan): re-run Part D's search — grep
the repo for "only signal", "decompose this", "the only way to", and the moved symbol names — and
fix what the list above missed, because the list was written before the work and the claims move
with the code.

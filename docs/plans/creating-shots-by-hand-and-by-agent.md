# Creating shots by hand and by agent

**Status: planned.** Nothing here is built.

## The incoherence this plan removes

The repo treats a shot as an authored object from the moment it exists. The shots file is documented as human-editable, authored fields sit at its
top level, and coverage, order, wardrobe and art notes are all authorial acts with commands and (partly) agent tools. Creation and assignment,
however, have no authorial channel at all. A shot comes into being only through `decomposeScene` (P5), a one-shot structured-output call whose answer
is persisted un-reviewed and is then permanent, because `work/shots/<sceneId>.json` always takes precedence. That inverts the project's own
philosophy. Everywhere else the agent works plan → refusal → approval, and at the highest-stakes act in the scene→art chain (the one that is
non-deterministic and that creates task identities) there is no review loop and no authorial control.

Two smaller facts confirm the gap is historical rather than designed:

- `setCoverage` (the rule for assigning lines to shots) lives in `apps/desktop/src/shared/coverage.ts`, where the agent cannot reach it. The repo's
  stated principle is that a rule two hosts need lives in a package, because "the agent may not import an app". That principle is why the marker
  write path and `branchops` moved into `@vn/scriptedit`. Coverage assignment needs the same move, and the move has not happened yet.
- The agent can `moveShot`, set a shot's outfit and set its art notes, which are the acts downstream of a storyboard. The agent cannot create a
  shot, delete one, or cover a line.

This plan does not unseat `decomposeScene`. The constraints on `decomposeScene` are real and would bind any creator, including an agent: shot ids
feed task identity, so re-decomposition re-renders paid art; runs stay resumable because an absent file is the only signal to decompose; the
deterministic fallback lets `--mock` and keyless runs work. `decomposeScene` stays as the batch/headless path, and it is no longer the only creation
path.

## Part A — the rules move into `@vn/scriptedit`

Holds the "pure" (side-effect-free) decisions, so both hosts decide identically. `@vn/scriptedit`'s allow-list does not change; everything below is
deterministic and input-side.

1. 1. **`setCoverage`, `spansFor`, `resolveDrag` and `runsOf` move from `apps/desktop/src/shared/coverage.ts` into `@vn/scriptedit`** (a
   `coverage.ts` module in the pure barrel), with their tests. `previewOf` stays in the renderer, because it computes ghost geometry and already
   lives in `renderer/rules/timeline/coverage.ts` rather than the shared module. The types come apart before the code moves. `spansFor`'s signature
   is built on `CoverageLine` / `CoverageShot` from the desktop's `ipc.ts`, which is an app path a package cannot import, and those projections are
   fat besides (`image`, `drift`, `outfits`). The package declares the minimal structural shapes its rules actually read (id, text/kind for a line;
   id, `coversLines` for a shot). The projections in `ipc.ts` satisfy those shapes structurally and stay where they are, serving the ~15 renderer
   importers unchanged. The desktop's `shared/coverage.ts` becomes a re-export during the move and is deleted once the renderer imports the package
   directly. Behaviour is unchanged. The one invariant (no line covered by two shots; a claim that would empty a neighbour is refused) is already
   stated there and travels with the code.
2. 2. **`newShot` — a new rule.** Creates a shot in an existing storyboard: allocates an id, claims an initial set of lines through the same
   `setCoverage` decision (so the neighbour-emptying refusal applies to a newly created shot as well), and defaults the rest — framing `medium`, the
   scene's primary location variant, subjects derived from the speakers of the claimed lines, no outfit (absent means inherit). Refusals:
   - a shot must claim at least one line at creation, so a shot can only become an orphan later and cannot be created as one;
   - ids are `<sceneId>__shot<n>` (the same namespacing `shotId` already applies), allocated from a `nextShot` high-water mark persisted in the
     shots file. This follows `[[nextline:]]`, for the same reason: scanning the ids in use is not enough, because a shot's id is part of its task
     hash (`shotInputs`), so a re-minted id whose framing and subjects happen to match a deleted shot's hashes to a task that is already `done`, and
     the "new" shot silently inherits the deleted shot's frame, which is the frame the author deleted. A high-water mark makes reuse impossible
     rather than unlikely.
3. 3. **`newShot` on an undecomposed scene creates the storyboard and states what that costs.** Writing the first hand-made shot writes
   `work/shots/<sceneId>.json`, and under the existing contract that file means the scene is storyboarded: `decomposeAll` keeps it, the planner does
   not auto-decompose it mid-run, and `decomposeAllPreview` counts it as done. The trap is a scene with one hand-made shot covering three lines: the
   next `vngen run` renders that frame and leaves every other line a gap forever, and `withCoverage`'s first-line repair never runs for a hand-made
   storyboard, so the scene may open blank. The command's `check` therefore states this on the first shot of an undecomposed scene: this ends
   decomposition for the scene, and every uncovered line stays uncovered until you cover it. The gaps are the Coverage editor's subject, so the state
   is visible, but the editor shows it only after the write while the check states the cost before it. This is deliberate and is the core of the
   plan: a scene may now be storyboarded entirely by hand, one shot at a time, and the absent-file signal keeps exactly its current meaning.
4. 4. **`deleteShot` applies the symmetric rule, and deleting the last shot restores the signal.** Removes a shot; its covered lines become gaps
   (released rather than reassigned to a neighbour, matching `setCoverage`). Deleting the last shot deletes the file, because that question is
   already settled in the codebase: `deleteShots` (`@vn/store`) exists precisely so "a scene whose last shot went away has to lose the file to get a
   fresh storyboard instead of staying blank forever", and `shotFallout` routes an emptied scene there today. An empty list is never written (the
   store's "absent, not empty" contract), and the author gets a way back to "decompose this" through a command instead of hand-deleting a file. The
   `check` prices both cases: it names the frames the shot had rendered, because deleting a shot orphans paid art, and for the last shot it adds the
   `shotFallout` sentence stating that this scene will be decomposed again.

Report the cost of a new shot rather than hiding it. A new shot id adds a task subject: the planner must produce a frame for it, and its subjects
need approved portraits. `story.newShot`'s `check` must state what the shot will cost before the author agrees, the same way `story.setHeading`'s
check states the cost of a re-render. Coverage edits stay free, because `buildShotPrompt` reads neither `coversLines` nor line text, and that
contract is unchanged.

## Part B — commands and the Coverage editor

### Commands

- **`story.newShot`** and **`story.deleteShot`** are thin wrappers over the Part A rules. Both are undoable and both declare their refusals in
  `check`. `story.setCoverage` is retargeted onto the package rule and does not change shape.

### Creating a shot in the editor

- **New shots start in the gap gutter, and the drag is a declared interaction.** The vermilion uncovered-lines gutter already shows where a shot is
  missing, so that is where a shot is made: dragging across gap rows offers "New shot from these lines", which runs `story.newShot` claiming exactly
  those rows. The drag is a third declared `Interaction` (`timeline.create`, beside `cover` and `reorder`), so its targets are enumerable and its
  mid-gesture verdict is the verdict that would happen. The surface disambiguates the gesture, not a modifier key: the drag starts on the gutter cell
  (its own element), the prose cell keeps click-to-edit, and a bracket handle keeps `timeline.cover`, so no two gestures claim the same
  `pointerdown`. A `+ shot` control in the strip header covers the no-gaps case, opening `openCommandDialog('story.newShot', …)` prefilled with the
  scene. That control uses the same two-host `CommandForm` every other command uses, so the cost sentence from `check` is on screen as the author
  fills it in. Every new affordance carries a tooltip, and the gutter says what dragging it does, per the no-exceptions rule.
- **An undecomposed scene becomes actionable.** Today it draws the script column and a note saying where shots come from. The note carries the same
  two options: decompose (the existing command), or start placing shots by hand. Both are invocations, and the renderer checks each one before
  drawing it.
- **The bracket is where a shot is deleted.** A shot's context menu offers `story.deleteShot`, and a refusal to delete the last shot is shown
  rather than hidden, like every other declined invocation.

### The delay on a drop is shown, not endured

Today `run()` awaits `command:exec` and then re-reads the whole strip. The editor shows no change during that window. A reorder (`story.moveShot`
rewrites the scene file and may commit to git) can take long enough that the drop appears to have failed, which invites a second, destructive drag.

- **A pending command puts the strip in a visible busy state.** The notice row becomes an indeterminate progress bar showing the command's own
  title ("Moving shot…", "Updating coverage…"). The bar appears only after ~150 ms, so a fast commit never flashes it. The bar uses design-token
  colours and adds no new accent hue.
- **The gesture surface locks while a write is in flight.** Handles and brackets refuse a new grab with a sentence ("Waiting for the last edit to
  land."). This follows the open-text-row rule: a refusal states its reason and the surface never goes dead. The same sentence serves as the locked
  surface's tooltip, because a disabled control's tooltip states its refusal. Line editing and wardrobe selects lock the same way, because they share
  the same re-read. Nothing guards this today. `run()` awaits with no in-flight state, so a second grab can start mid-write. The busy state machine
  is "pure" (side-effect-free) logic in `renderer/rules/` with a `tests/` sibling. The surface itself is verified live over CDP, per the editor
  conventions.
- **The bar becomes the command's outcome sentence** (the existing ok/refused notice), so the progress state and the result appear in one row that
  changes tone rather than in two separate surfaces.

## Part C — the agent

1. 1. **Decomposition's prompt-and-parse moves to `@vn/artgen`.** `decomposeScene`, `deterministicShots` and `withCoverage` are generative policy
   with no pipeline dependency, and `artgen` exists for exactly this kind of code (the pipeline, the desktop app and `authoring` all need it, and
   `authoring` cannot import the pipeline). `@vn/pipeline` re-exports them; `decomposeAll` and its persistence rules stay in the pipeline untouched.
   The move covers two further details. `withCoverage` is unexported today and gets its public name here, and the comment in `@vn/export`'s
   `playable.ts` that names "`@vn/pipeline`'s `deterministicShots`" moves with the symbol.
2. 2. **`edit_scene` grows two ops: `newShot` and `deleteShot`**, named exactly as the commands are and calling the same rules, so an agent
   transcript and a command history use one vocabulary. `set_coverage` is a separate tool (it is a set, not a line-op, and its argument shape is
   different) that wraps the moved `setCoverage`.
3. 3. **`propose_storyboard` proposes a decomposition and `write_storyboard` persists it.** `propose_storyboard` calls `decomposeScene` and returns
   the decomposition into the conversation without writing anything: the shots, the coverage, and the source (`model` or `baseline`, with its
   reason). Persistence is a separate mutating tool, `write_storyboard`, that takes the full shot list as its arguments. The agent restates the
   proposal the author approved, and the tool validates it through the same schema, subject resolution and coverage backstop the pipeline applies.
   The arguments are explicit rather than "persist the last proposal" because `decomposeScene` is non-deterministic: re-calling it at persist time
   would write a storyboard the author never read, which is the un-reviewed permanence this plan exists to remove. Approval and persistence therefore
   happen inside one conversation. Threads reopen read-only, so a proposal from a closed conversation can no longer be persisted; the recovery is to
   propose again, and proposing again calls `decomposeScene` again and can return different shots. `write_storyboard` refuses when a storyboard
   already exists (no `force`, same as `decomposeAll`). The deterministic-fallback contract is unchanged. What is new is that an author reads a
   baseline proposal and can decline it, rather than a batch declining to write it on the author's behalf.
4. 4. **The tool context needs a text provider.** `ctx.art` exposes only the image backend today, and nothing in `tools.ts` holds a `Providers`. So
   `propose_storyboard` needs the structured-text provider wired into the tool context (key resolution, the model id from `project.yaml`, and the
   mock behaviour), injected the way `workspaceArtGen` already injects the image backend. This is real wiring, so budget it as its own step rather
   than assuming it.

This needs no exception to the boundaries lint: nothing in `authoring` imports `@vn/pipeline`, and the one generative call the agent gains goes
through the same `providers` seam its other tools already use.

### The agent's context, so the new powers don't confuse it

New tools with no supporting context produce a model that misuses them. Knowledge is routed to the three places
[`archive/INDEX.md#what-the-agent-knows-about-the-story-format`](archive/INDEX.md#what-the-agent-knows-about-the-story-format) established — the
system prompt for what is always true, refusals for what is case-specific, a skill for workflow — and every surface that currently teaches the old
rule is corrected in the same stage that changes it:

- **`SYSTEM_PROMPT` gains a SHOTS AND COVERAGE paragraph** (`packages/authoring/src/context.ts`), sized like the existing BRANCHING paragraph. It
  states that a shot covers a set of line ids, that no line is covered by two shots, and that claiming takes. Releasing a line leaves a gap, which
  the runner shows by holding the previous image too long. Coverage edits are free, but creating a new shot id makes the pipeline owe a new frame.
  That is the paragraph's one cost sentence, and the model must weigh it before creating rather than re-covering. The prompt already carries shot
  knowledge in the shot art-notes rung and the shot-level outfit override, so the paragraph sits beside those rather than introducing the noun.
- **The `full-production` skill stops saying "You cannot make shots."** (`templates/basic/.aiagent/skills/full-production/SKILL.md`, "The hand-off
  — shots" section.) That sentence, the line "Framing is the decomposer's choice, not yours", and the section's copy of the absent-file contract
  would make a correctly-built agent refuse work it can now do. The section becomes "shots, by decomposition or by hand" and covers three paths:
  decompose for a whole project, `propose_storyboard` for a scene in conversation, and `newShot` for surgical additions. The cost framing stays.
- **Mode gating is decided per tool, not inherited.** `newShot`, `deleteShot`, `set_coverage` and `write_storyboard` are `mutating: true`, so plan
  mode refuses them, like every write. `propose_storyboard` writes nothing but spends one structured text call, and plan-mode gating looks only at
  `mutating`, so shipping it non-mutating creates a genuinely new category, a plan-mode tool that costs money. No precedent covers this. The nearest
  neighbour, `generate_image`, is `mutating: true, confirm: true` because it writes an asset and also costs an image. This plan sets the flags
  deliberately: `mutating: false`, no `confirm`, and the description states the cost. Pricing a whole storyboard during planning takes one text call,
  which is the kind of cheap step plan mode exists for. If that choice proves wrong, fall back to `confirm: true` rather than `mutating`.
- **Reading has to precede writing.** `set_coverage` is unusable unless the model can see what covers what, and today the storyboard is read only
  implicitly (`shotsFor`, inside other tools). The tool descriptions must name whichever route is chosen — either a small coverage report in an
  existing read tool's answer or a directly legible shots file — so the model is never told to edit state it has no way to look at.
- **Caching contract.** The system prompt and the tools block are part of the byte-stable cached prefix
  ([`archive/INDEX.md#prompt-caching-and-deferred-tool-loading`](archive/INDEX.md#prompt-caching-and-deferred-tool-loading)): new prompt text and new
  tools land between conversations and are never edited into a live one. A mid-conversation change, if one is ever needed, is sent on the existing
  appended `{"role":"system"}` channel. The desktop's System Prompt editor needs no change; it renders whatever is sent.

## Part D — the sentences that stop being true

This plan changes what several load-bearing sentences mean, and every place that states one is corrected in the same stage that falsifies it. This
plan treats a doc or comment that describes the old world the way it treats a failing test. The known sites appear below, found by searching for the
claims rather than the filenames (the sweep at the end re-runs the search, because this list will be stale by then):

**The "only signal" contract.** The sentence "An absent `work/shots/<sceneId>.json` is the only signal meaning 'decompose this'" keeps its meaning
for the batch, but it must now also say that a hand-made first shot ends that signal. The sentence appears in:

- CLAUDE.md carries the "Decomposing every scene is an explicit act" bullet;
- [`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) — the decomposition contract, the P5 section, and the second statement
  inside the scene-heading contract;
- [`../guides/cli.md`](../guides/cli.md) states the whole contract ("an absent one is the only signal … the file wins forever"), and the first
  draft of this list missed that class of surface entirely;
- `apps/cli/src/commands.ts` — holds the sentences `vngen decompose` prints, and `apps/cli/src/tests/commands.test.ts` asserts them;
- packages/pipeline/src/decompose.ts — the doc comment on `decomposeAll` ("An absent file is the only signal…"), the doc comment on
  `DecomposeAllResult`, and the framing comments in decomposeall.test.ts;
- `packages/pipeline/src/p5.ts` — the doc comment on `Decomposition`, and the module-level comment that presents the module as the source of
  storyboards;
- `packages/store/src/shots.ts` — the doc comments on `readShots` and `deleteShots`. Part A.4 builds on the `deleteShots` sentence rather than
  contradicting it, and that sentence stays true;
- `packages/scriptedit/src/shotfallout.ts` — the emptied-scene comment becomes one of two callers that take the same approach;
- `apps/desktop/src/main/commands/story.ts` — `story.decomposeAll`'s `description`, which an
  author reads in the palette;
- `templates/basic/.aiagent/skills/full-production/SKILL.md` — holds the skill's copy of the contract, beside the "You cannot make shots" section
  that Part C rewrites;
- `packages/export/src/playable.ts` — the comment naming "`@vn/pipeline`'s `deterministicShots`" is stale after the Part C move (also noted there).

**The tool descriptions state what the model can do.** `edit_scene`'s description (`packages/authoring/src/tools.ts`) enumerates its ops, and it
grows the two new ones, with their cost stated the way `moveShot`'s already is ("costs it nothing"). The tools that today refuse an undecomposed
scene by pointing at the storyboard must point at both, wherever the refusal survives. Correct these in the stage that adds the ops rather than in a
later docs pass, because a stale tool description misleads exactly the audience that reads it.

**The moved comments.** The header in `apps/desktop/src/shared/coverage.ts` explains why that file lives in `shared/`. The move supersedes that
reasoning, and the package home gets a header saying why the file lives in the package instead, because two hosts share one rule, written in the
voice of `@vn/scriptedit`'s existing modules. The re-export left behind during the move carries a comment naming its replacement, so the re-export
cannot outlive the migration without being noticed.

These docs describe the surfaces. In [`../reference/desktop-app-editors-story.md`](../reference/desktop-app-editors-story.md#shot-coverage), the
creation door is added to the Shot Coverage section's "decomposed on purpose" bullet, and the busy state is added to the gesture rules. In
[`../reference/vnauthor.md`](../reference/vnauthor.md#tools), the tool table changes. In
[`../reference/command-system.md`](../reference/command-system.md), every place that names a command count changes. Shipped plans
([`archive/INDEX.md#shot-timeline-editor`](archive/INDEX.md#shot-timeline-editor) and similar plans) are history and are not rewritten, because a
plan is the authority on its own scope and this plan records the change.

## Out of scope

- Routing the agent's tool loop through the command registry is still recorded as the follow-on in
  [`archive/INDEX.md#command-system`](archive/INDEX.md#command-system), and this plan neither needs it nor advances it.
- Merging or splitting shots, and any change to `timeline.reorder`'s refusal for interleaved
  shots.
- Any change to task identity, `buildShotPrompt`, or what invalidates art.

## Finishing checklist

In addition to [`../reference/conventions.md`](../reference/conventions.md#finishing-a-plan), re-run Part D's search: grep the repo for "only
signal", "decompose this", "the only way to", and the moved symbol names, then fix what the list above missed. The list was written before the work,
and the claims change as the code changes.

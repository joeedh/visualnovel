# A less technical mode

<!-- toc -->

- [What the technical surface actually is](#what-the-technical-surface-actually-is)
  * [One barrier, and it is not the one the word "approval" suggests](#one-barrier-and-it-is-not-the-one-the-word-approval-suggests)
  * [What the runner already decides on its own](#what-the-runner-already-decides-on-its-own)
  * [Where `accepted` does bite](#where-accepted-does-bite)
  * [The surface an author meets](#the-surface-an-author-meets)
- [What "automatically approve assets" would actually mean](#what-automatically-approve-assets-would-actually-mean)
  * [It is one act, performed at most twice](#it-is-one-act-performed-at-most-twice)
  * [Where it has to sit so it cannot forge provenance](#where-it-has-to-sit-so-it-cannot-forge-provenance)
  * [What a run loses when nobody looks](#what-a-run-loses-when-nobody-looks)
- [The other simplifications](#the-other-simplifications)
  * [The editors: this is a layout, not a mode](#the-editors-this-is-a-layout-not-a-mode)
  * [The tree](#the-tree)
  * [The agent](#the-agent)
  * [The defaults](#the-defaults)
  * [Errors, for someone who cannot read a slot key](#errors-for-someone-who-cannot-read-a-slot-key)
- [What must not be simplified away](#what-must-not-be-simplified-away)
- [A recommended shape](#a-recommended-shape)
  * [The smallest honest first version](#the-smallest-honest-first-version)
- [Open questions](#open-questions)

<!-- tocstop -->

_This is internal research. Nothing here is shipped and nothing here is a plan. It answers the question "what
would a mode for someone who just wants to play with this actually have to change", worked against the code as
it stands in August 2026. Every claim below is a claim about a file in this repository, and the negative
claims turned out to be the interesting ones: most of what such a mode would exist to remove is either not
there or already automatic._

The question arrived as one sentence asking for a less technical mode in the desktop app that would
automatically approve assets, plus whatever other simplifications that implies, for people to play around
with. Taking it literally produces a small answer, because only one approval in this system stops anything,
and the code already contains the button that clears it. Taking it seriously produces a larger one, because
the gate is not what stalls a newcomer. The app asks them to have opinions about slots, task hashes, refine
caps and API keys before it will show them a picture.

The recommendation splits in two. The approval half needs a project setting and one new command. The surface
half needs no mode at all, because layout templates already provide that mechanism and nobody has written the
template.

## What the technical surface actually is

### One barrier, and it is not the one the word "approval" suggests

The P3 character-approval gate is a planner predicate rather than a task dependency. `isApproved`
(packages/artgen/src/gate.ts:4) is true when a character's front-matter says `status: approved` or `locked`
and carries an `approved_portrait` hash; `sceneUnblocked` (gate.ts:12) requires `isApproved` of every
character in a scene; and the planner implements the whole barrier as a single `continue`:

```ts
// packages/pipeline/src/planner.ts:229-230
for (const scene of reachableScenes(model)) {
  if (!sceneUnblocked(model, scene.id)) continue;
```

P4 model sheets are gated the same way (planner.ts:216). So a run halts by planning no work rather than by
raising an error, and the summary reports that absence as `blockedOnGate: !gate.cleared`
(packages/scheduler/src/scheduler.ts:300). Clearing it writes three things
(apps/desktop/src/main/commands/gate.ts:60-64, packages/store/src/worktree.ts:113): `status:` and
`approved_portrait:` into `characters/<id>/character.md`, the bytes to
`vngen/work/characters/<id>/approved.png`, and `accepted: true` into the manifest.

Everything else the app calls approval is a judgement recorded on an asset, and it gates no planning at all.
`assetApproved` (`packages/artgen/src/prereq.ts:53`) deliberately covers two cases under one name. It gates a
`portrait`, and it reports `Asset.accepted` for everything else. Neither the planner nor the scheduler reads
the `Asset.accepted` case. A grep for `accepted` across `packages/pipeline/src` and `packages/scheduler/src`
finds four hits, three of them comments and the fourth setting `Shot.status`. The planner resolves a shot's
plate by task hash (`doneOutput(graph, locTaskHash)`, `planner.ts:241-243`), never by whether a human approved
the bytes.

### What the runner already decides on its own

`shot_image` accepts its own output. When the merged critique carries no blocking defect, the runner calls
`await deps.store.accept(ref.hash)` (packages/pipeline/src/runners.ts:143) and marks the shot `accepted`. The
portrait runner does not accept its output, and the comment at runners.ts:71 gives the reason. Plates and
sheets are left unaccepted, because no downstream stage requires acceptance.

An unattended run today already auto-approves the overwhelming majority of the pictures it makes. In
`templates/basic`, the human is asked about exactly one thing per character and nothing else. The one place
the runner declines is the P7 give-up path (`runners.ts:161-168`), which returns `needs_human` with one of two
persisted sentences and leaves the last frame unaccepted. `packages/export/src/playable.ts:103` only ever puts
an `accepted` shot image into `story.play.json`. So for a shot the reviewers would not pass, the picture
exists on disk and the playable shows nothing there. That behaviour is correct for a production tool and wrong
for someone playing around.

### Where `accepted` does bite

There are three places. They are worth naming because an auto-approve suppresses some of them, and a reader
needs to know which.

- **Slot resolution.** `pick` (`packages/artgen/src/refs.ts:64`) returns an accepted candidate outright, and
  otherwise returns a candidate only when exactly one exists. A second unaccepted candidate that ties makes
  the slot resolve to `undefined`, and every caller treats `undefined` as making no claim. This is the one
  functional deadlock that acceptance prevents, and it appears only after a regenerate.
- **The playable** works as above for shot frames and for a portrait with no approved hash
  (`playable.ts:103`, `:115`).
- **The document tree and the Approve button.** `unapprovedBranch`
  (`apps/desktop/src/main/doctree.ts:269-324`) projects the slot graph into "Unapproved assets", in two
  disjoint groups. "Awaiting approval (N)" holds every candidate that `assetApproved` rejects, and "Not yet
  rendered (N)" holds every slot with no candidates at all. `prereqRefusal` (`prereq.ts:134`) greys out
  Approve with the sentence "Approve what &lt;label&gt; was drawn from first: &lt;label&gt; is not approved
  yet, and N more." The pane is designed so that upstream assets are approved first.

### The surface an author meets

The desktop app has twelve editors, each named once in apps/desktop/src/shared/editors.ts:17-76 with a `what`
sentence and a `claims` predicate; 107 registered commands (apps/desktop/src/main/commands/index.ts); a
document tree with six branches; a command palette; a menu bar; and an agent with 38 tools
(packages/authoring/src/tools.ts). Of the twelve editors, four instrument the pipeline (Tasks, Task Graph,
Inspector, Coverage), one shows `project.yaml` as the run reads it, and two more (Documents, Wiki) exist for a
project large enough to lose things in.

Two defaults are already as cautious as a play mode requires. The `mock` prop of `pipeline.run` defaults to
`true` (apps/desktop/src/main/commands/pipeline.ts:29), so a run reached through the generated form is a dry
run unless the author says otherwise, and its `check` prints the upper bound in calls before anything is
spent. The agent's `generate_image` and `edit_image` tools are `confirm` tools, answered by a card in Convo. A
scaffold that once auto-allowed them is recorded as a bug at apps/desktop/src/main/session.ts:729: "an
auto-allowed `confirmAction` spends an image call the author never agreed to."

## What "automatically approve assets" would actually mean

### It is one act, performed at most twice

The feature requires two concrete jobs on top of the mechanisms above:

1. 1. **Stand in for the human at P3.** For each character in `gateStatus(model).pending`, run `gate.approve`
   with a candidate hash. Note that `config.candidates` (packages/types/src/schemas.ts:316, default 3) is
   declared and never read (a repo-wide grep for `config.candidates` finds nothing), and the planner emits
   exactly one portrait task per character (planner.ts:210-211). So in practice there is one candidate and no
   choice to make. Auto-approval here approves the only option rather than selecting among several.
2. 2. **Accept what the runner declined to accept.** Two cases need this. A `needs_human` frame is accepted so
   that Play shows it instead of a hole, and a slot holding two tied unaccepted candidates is accepted so that
   the slot resolves again. Both go through `asset.accept`, which already refuses a portrait, a concept and an
   upload by name (session.ts:1425, :1431, :1437).

A run halts at the gate, so clearing a project takes three steps: run, approve everything pending, run again.
Two invocations of `pipeline.run` clear a project with a single gate, because the wave loop inside one run
handles the sheet→shot ordering on its own.

### Where it has to sit so it cannot forge provenance

This belongs in neither the scheduler nor the store. Provenance in this system comes from two sources: the
command journal at `vngen/state/commands.jsonl`, and the per-repo commit made after every mutating command.
Both are properties of the command layer. A scheduler that wrote `status: approved` into `character.md`
mid-wave would have the pipeline modify authored input with no record of who decided, and it would have to
import the worktree writers that `@vn/store` owns and that the scheduler deliberately leaves out.

The precedent for the alternative is `adoptSlot` (packages/artgen/src/adoptslot.ts:239), the only `done`
record written outside the scheduler. It derives the task identity in the same call from the project as it
stands, so it can only mark done the node whose output the bytes now are. Its doc comment ends: "Nothing is
accepted here. Adoption says 'this is that task's output', not 'a human approved it'." It refuses a
`portrait:` slot outright (adoptslot.ts:138-144, `GATED_SLOT`), because only the gate approves a look.

So the auto-approve must invoke the commands that already exist, from main, with the same `check` run first
and the same journal line written after. Auto-approve then gets three properties for free: it is undoable
where the underlying command is, it is committed like any other edit, and `commands.jsonl` records that this
project's characters were approved by a machine rather than by a person. That last property is intentional
rather than incidental. A generated project is committed (docs/cli.md:76), and someone reading it a month
later has to be able to tell that nobody looked.

### What a run loses when nobody looks

Most of the report's value comes from stating this honestly, because each item records a contract that exists
because the failure happened.

- **The portrait is reused downstream.** A character's approved portrait is the identity reference fed to
  every model sheet and every shot they appear in (planner.ts:255-277). Approving the first draft fixes what
  that character looks like for the entire run. The gate exists chiefly for that decision, and auto-approval
  removes it.
- **`needs_human` stops meaning anything.** The scheduler never auto-retries the status (`scheduler.ts:110`,
  and the comment at `:101` calls it "a request for a human, not a fault"). If the mode accepts those frames,
  policy overrules the reviewers' verdict, and the run's exit code (which already excludes `needs_human`) no
  longer distinguishes a clean project from one where every shot failed review four times.
- **The refine cap multiplies the spend.** `costPreview` (packages/pipeline/src/pipeline.ts:48-74) counts a
  shot as `max_refine_attempts` image calls and `max_refine_attempts × models.vision.length` review calls,
  because that is the P7 worst case. At the shipped defaults (4 and two reviewers) a twenty-shot scene's upper
  bound is 80 image calls and 160 review calls. In a mode where nobody reads the critique, the pipeline still
  pays for four critiques per shot and then discards them.
- **Nothing acts on drift automatically.** A prose edit does not invalidate art, so `driftOf`
  (`packages/pipeline/src/drift.ts`) re-derives `unrendered | current | drifted | unknown` on every read and
  Coverage marks the result. Drift is reported for a human to act on, and if no human reads the report,
  nothing reads the field.
- **`vngen cost` still undercounts.** Planning is incremental, so the preview is a snapshot of
  currently-plannable work. In a project where the gate is answered automatically, the second wave unlocks far
  more work than the first preview showed. That is the case where the author most needs the number to be
  right.

## The other simplifications

### The editors: this is a layout, not a mode

Four of the twelve serve a play surface: Convo (ask for things), Play (watch the result), Script or Branches
(see the story), and Asset (look at one picture and change the art note). Tasks, Task Graph and Inspector are
instrumentation for a run you are supervising. Coverage shows drift and shot coverage. Project shows
`project.yaml`. Documents and Wiki matter once a project is big enough to lose things in.

That arrangement does not need a mode, because it is a layout template. A template is a named screen
arrangement the project owns at `.vnstudio/layouts/<slug>.json` and applies from View ▸ Layout, and two ship
today as declarative recipes that main can write with no renderer in the loop, Writing and Art
(docs/desktop-app.md, plans/layout-templates-and-the-view-menu.md). A third, Play, is a recipe file and a line
in `ensureLayouts`. It costs nothing, one menu click reverses it, and it hides editors without making them
unreachable, so the surface is simplified rather than crippled. A mode that removed editors would have to
answer what happens when a refusal names a pane the author cannot open.

### The tree

There are two changes, both projections rather than new state. The Unapproved assets branch is empty by
construction in this mode, and `unapprovedBranch` already returns `undefined` when both groups are empty
(doctree.ts:309) and is omitted from `roots`, so it disappears on its own with no flag. The Assets branch
stays, and it needs work. A todo already asks for it to be organised by slot with per-slot history, and that
is the right shape here too, because a slot is the only address a casual user can be expected to hold ("Ada's
portrait", not `c1f4b2…`).

### The agent

In this mode the agent is the primary surface rather than one surface among twelve. Two of its existing
properties stay unchanged and one changes.

Two things survive. Plan mode is read-only, and a plan is approved before it runs. The `confirm` step in front
of `generate_image` and `edit_image` (packages/authoring/src/loop.ts:563-570) also survives. Nothing else
stands between a conversational request and a billed image call, and main builds the sentence on the card in
toolconfirm.ts rather than showing the raw arguments. Removing that step because "a beginner shouldn't be
asked" reproduces the bug recorded at session.ts:729.

Change: the tool list is the wrong length for this audience. Thirty-eight tools includes seven git verbs,
`regenerate_context`, `parse_fountain`, `extract_entities` and the file-editing pair with its read ledger. A
play profile would offer the create/edit tools for characters, locations and scenes, `generate_image`,
`view_image`, `search_bible` and the three read tools. The rest would load later through deferred loading,
whose mechanism the prompt-caching work already built.

### The defaults

- `max_refine_attempts` should be lowered to `2` rather than raised to `4`. Nobody reads the critique, so
  the extra attempts cost full runtime and produce a verdict nobody reads. Lowering it changes no hash,
  because it is a runner cap rather than a task input.
- `image_params.seed` should stay absent. Zero counts as a seed value, and `seedFor`
  (packages/artgen/src/prompts.ts:51-54) resolves the narrowest authored rung, so a default seed written into
  a template project would pin every image in that project with no warning.
- `models` should stay as they are. Model ids are the "seam" (boundary) at which a provider is swapped, so
  changing a model id is how a backend changes. A mode that downgraded the image model would leave a user
  unable to find out why their results look worse than the screenshots.
- `portrait_overlay` stays `false`. A shot prompt names its own subjects, and turning the flag on places a
  P3 portrait (an opaque plate rather than a keyed cutout) over the frame.

### Errors, for someone who cannot read a slot key

The refusals in this system are already written as sentences rather than codes, and that choice accounts for
most of the work. `slotLabel` (packages/artgen/src/refcycle.ts:38-51) yields `ada portrait`, `cafe — night
plate`, `arrival/s2 frame`. `SlotNode.blocked` holds the sentence saying why a slot cannot state a task
identity yet, and the tree shows that sentence on the row as a tooltip. `prereqRefusal`, the five refusals in
`previewAccept` and the three refusals in `gate.approve` are all written in English.

Three gaps remain, and this audience hits them first:

- **The missing key.** `resolveKeys` throws `missing gemini API key: set $GEMINI_API_KEY or place gemini.txt
  in a keys/ dir` (`packages/config/src/keys.ts:92-100`), which `pipeline.run`'s check surfaces as `keyError`.
  The message names the fix, but the fix spans two concepts (an env var and a gitignored directory), and the
  app has a command that does it (`project.setKey`). The refusal should name that command rather than the
  file.
- **The upper bound is in calls, not money.** `costPreview` counts `imageCalls` and `reviewCalls`, and this
  repository has no price table, no `costUsd`, and no per-model rate map. The only dollar figures in the tree
  are prose in docs/testkit.md and an unimplemented plan. An author who knows what a Gemini image call costs
  reads "80 image calls" as a budget. For the audience this mode is for, the same number carries no units.
  That missing conversion is the sharpest unfunded dependency the mode has.
- **`needs_human` has no lay reading.** The persisted sentence is "shot still has blocking defects after 4
  attempts". A beginner needs to read "this picture came out wrong four times; here it is anyway. Try changing
  the art note", with the art-note field one click away.

## What must not be simplified away

- **Money.** Every image costs money. The system reports cost in three places: the confirm card in front of
  the agent's image tools, the `check` note that prints the upper bound before a run, and `mock` defaulting to
  `true` on the generated form. That reporting matters most in a mode aimed at people experimenting.
- **Secrets.** `keys/` is gitignored, `project.yaml` records only env-var names, `resolveKeys` names the
  source and never the value, `prop.secret` is redacted at `digestProps`, and `project.setKey` is deliberately
  not undoable. A newcomer is the person who will paste a key into the first box they see, and the app commits
  the worktree after every mutating command, so the gitignore line has to be in place within a second of that
  paste.
- **Provenance.** Provenance comes from `commands.jsonl`, the git stamp, and committing `vngen/` rather than
  ignoring it. A play project is still a project someone might later want to finish, and recording what was
  approved by policy rather than by a person makes finishing it possible.
- **The refusals themselves.** The repo rule is that the tooltip on a disabled control states the refusal
  verbatim. Hiding what cannot be done has the same defect as greying out a control that will not say why, and
  hiding is worse for a beginner, who has no model of the system to explain why the control is missing.
- **The base-store rule.** A base root present without a manifest is `unavailable`, and the planner plans
  nothing instead of re-buying an approved library. No mode may relax this rule.

## A recommended shape

**Call the mode what it does, not who it is for.** "Beginner mode" describes the user. "Unattended" describes
the run, and it describes it accurately: the surface does not get simpler because approvals stop being asked
for, and one word should not cover both changes. So:

- **`unattended: true` in `project.yaml`** — This is a project setting, not an app setting, for three
  reasons, each decisive. It changes what gets written into the repository (`character.md` front-matter,
  manifest flags), so it must travel with the repository and be visible in its diff. App settings live in
  `.vndesktop/session.json`, which is per install and is explicitly about window facts. And `project.yaml` is
  where a run already reads its configuration, so the CLI gets the same behaviour without a second mechanism.
  That matters because a project someone played with and then wants to finish should behave identically in
  both hosts.
- **A `Play` layout template**, shipped as a recipe alongside Writing and Art. Applying this template enters
  the simpler surface, and applying another leaves it. There is no mode flag, no hidden command, and every
  editor stays reachable.

An author enters `unattended` through a checkbox in the New Project dialog and a field in the Project editor.
The Project editor today has exactly one editable field, for a reason worth keeping, so this field becomes the
second and should be argued for on the same grounds: it is a setting an author reaches for as a decision about
the whole project, and it should confirm and say what it will do. An author leaves the mode by clearing the
field. Clearing the field undoes nothing, because approvals already granted stay granted and the journal
already records how they were granted. The mode is not reversible in the sense of un-approving what was
already approved, and the setting's confirmation text should say so.

### The smallest honest first version

One command and one field, in that order. The command is worth shipping on its own, even if the field never
ships.

`gate.approveAll` is `mutating` and `undoable`, and sets `confirm: true`. Its `check` lists every pending
character with the candidate that would be approved for it, refuses when a character has no candidate or more
than one, and states that the command approves a look no one has reviewed. Its `run` invokes `gate.approve`
per character through the registry, so each character gets its own `check`, its own journal line and its own
commit. The feature is no larger than that: it forges nothing, it introduces no new write path, and it repeats
exactly the loop a person performs by hand today.

Then comes `unattended: true`. Its only behaviour is that the desktop app runs `gate.approveAll` when a run
reports `blockedOnGate` and then runs again. `asset.regenerate` already does the same chaining when
`autoRunReason` says its task is the only one pending (apps/desktop/src/main/commands/asset.ts:221-229).

The first version deliberately omits auto-accepting `needs_human` frames and lowering `max_refine_attempts`.
Both are judgements about picture quality rather than about who presses a button, both change what reaches the
playable, and both should wait until the first version shows whether the gate ever blocked anyone.

## Open questions

- **Should an unattended project be marked in the manifest, or only in the journal?** The journal records
  what happened, but nobody opens the file. An `approvedBy: 'policy'` field on the asset would let the Asset
  pane display the mark next to the picture — at the cost of a manifest field that every reader has to learn,
  for information that does not describe the bytes.
- Does the playable need to show a `needs_human` frame at all, or is a hole the right answer even here?
  Showing it means the reviewers' verdict has no consequence; hiding it means a beginner's story has gaps they
  cannot explain. A third option (show it with a mark on the frame in Play) has never been costed.
- **Is the price table a prerequisite or a separate plan?** The mode risks spending money, the app cannot
  currently name a figure, and the pricing work is already written up and unimplemented in
  plans/provider-credentials-and-the-ai-usage-ledger.md. Unattended approval should not ship before the app
  can report what a run costs.

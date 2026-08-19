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

_Research, internal. Nothing here is shipped and nothing here is a plan; it is the answer to
"what would a mode for someone who just wants to play with this actually have to change", worked
against the code as it stands in August 2026. Every claim below is a claim about a file in this
repository, and the interesting ones turned out to be the negative ones — most of what such a mode
would exist to remove is either not there or already automatic._

The question came in as one sentence: a less technical mode in the desktop app that would
automatically approve assets, plus whatever other simplifications that implies, for people to play
around with. Taking it literally produces a small answer, because **only one approval in this
system stops anything**, and the code already contains the button that clears it. Taking it
seriously produces a larger one, because the reason a newcomer stalls is not the gate — it is that
the app asks them to have opinions about slots, task hashes, refine caps and API keys before it
will show them a picture.

So the recommendation splits in two, and the split is the point: **the approval half needs a
project setting and one new command; the surface half needs no mode at all**, because layout
templates already are that mechanism and nobody has written the template.

## What the technical surface actually is

### One barrier, and it is not the one the word "approval" suggests

The P3 character-approval gate is a **planner predicate**, not a task dependency. `isApproved`
(`packages/artgen/src/gate.ts:4`) is true when a character's front-matter says `status: approved`
or `locked` _and_ carries an `approved_portrait` hash; `sceneUnblocked` (`gate.ts:12`) requires it
of every character in a scene; and the whole barrier is one `continue` in the planner:

```ts
// packages/pipeline/src/planner.ts:229-230
for (const scene of reachableScenes(model)) {
  if (!sceneUnblocked(model, scene.id)) continue;
```

P4 model sheets are gated the same way (`planner.ts:216`). So a run halts not by erroring but by
planning nothing — `blockedOnGate: !gate.cleared` in the summary (`packages/scheduler/src/scheduler.ts:300`)
is a report about an absence. Clearing it writes three things (`apps/desktop/src/main/commands/gate.ts:60-64`,
`packages/store/src/worktree.ts:113`): `status:` and `approved_portrait:` into
`characters/<id>/character.md`, the bytes to `vngen/work/characters/<id>/approved.png`, and
`accepted: true` into the manifest.

**Everything else the app calls approval is a judgement recorded on an asset, and it gates no
planning at all.** `assetApproved` (`packages/artgen/src/prereq.ts:53`) is deliberately two things
in one word — the gate for a `portrait`, `Asset.accepted` for everything else — and the second half
is never read by the planner or the scheduler. A grep for `accepted` across
`packages/pipeline/src` and `packages/scheduler/src` finds four hits, three of them comments and
the fourth setting `Shot.status`. The planner resolves a shot's plate by **task hash**
(`doneOutput(graph, locTaskHash)`, `planner.ts:241-243`), never by asking whether a human blessed
the bytes.

### What the runner already decides on its own

`shot_image` accepts its own output. When the merged critique carries no blocking defect, the
runner calls `await deps.store.accept(ref.hash)` (`packages/pipeline/src/runners.ts:143`) and marks
the shot `accepted`. The portrait runner pointedly does not — the comment at `runners.ts:71` says
why — and plates and sheets are simply left unaccepted, because nothing downstream asks.

The consequence is that **an unattended run today already auto-approves the overwhelming majority
of the pictures it makes.** In `templates/basic`'s shape, the human is asked about exactly one
thing per character and nothing else. The one place the runner declines is the P7 give-up path
(`runners.ts:161-168`), which returns `needs_human` with one of two persisted sentences and leaves
the last frame **unaccepted** — and `packages/export/src/playable.ts:103` only ever puts an
`accepted` shot image into `story.play.json`. So the current behaviour for a shot the reviewers
would not pass is that the picture exists on disk and the playable shows nothing there. That is
correct for a production tool and exactly wrong for someone playing around.

### Where `accepted` does bite

Three places, and they are worth naming because an auto-approve has to be honest about which ones
it is silencing.

- **Slot resolution.** `pick` (`packages/artgen/src/refs.ts:64`) returns an accepted candidate
  outright, and otherwise answers only when there is exactly one. A second, tying, unaccepted
  candidate makes the slot resolve to `undefined` — "cannot say", which every caller treats as
  "make no claim". This is the one functional deadlock acceptance prevents, and it only appears
  after a regenerate.
- **The playable**, as above, for shot frames and for a portrait with no approved hash
  (`playable.ts:103`, `:115`).
- **The document tree and the Approve button.** `unapprovedBranch`
  (`apps/desktop/src/main/doctree.ts:269-324`) projects the slot graph into **Unapproved assets**,
  in two disjoint groups — _Awaiting approval (N)_, every candidate `assetApproved` says no to, and
  _Not yet rendered (N)_, every slot with no candidates at all. `prereqRefusal`
  (`prereq.ts:134`) is the sentence that greys Approve: _"Approve what &lt;label&gt; was drawn from
  first: &lt;label&gt; is not approved yet, and N more."_ Approving upstream first is the whole
  design of that pane.

### The surface an author meets

Twelve editors, named once in `apps/desktop/src/shared/editors.ts:17-76` with a `what` sentence and
a `claims` predicate each; 107 registered commands
(`apps/desktop/src/main/commands/index.ts`); a document tree with six branches; a command palette;
a menu bar; and an agent with 38 tools (`packages/authoring/src/tools.ts`). Of the twelve editors,
four are pipeline instrumentation (Tasks, Task Graph, Inspector, Coverage), one is `project.yaml`
as the run reads it, and two more (Documents, Wiki) are about a project large enough to lose things
in.

Two defaults are already cautious in exactly the way a play mode wants. `pipeline.run`'s `mock`
prop **defaults to `true`** (`apps/desktop/src/main/commands/pipeline.ts:29`), so a run reached
through the generated form is a dry run unless the author says otherwise, and its `check` prints
the upper bound in calls before anything is spent. And the agent's `generate_image` / `edit_image`
tools are `confirm` tools, answered by a card in Convo — a scaffold that once auto-allowed them is
recorded as a bug at `apps/desktop/src/main/session.ts:729`: _"an auto-allowed `confirmAction`
spends an image call the author never agreed to."_

## What "automatically approve assets" would actually mean

### It is one act, performed at most twice

Against the mechanisms above, the feature reduces to two concrete jobs:

1. **Stand in for the human at P3.** For each character in `gateStatus(model).pending`, run
   `gate.approve` with a candidate hash. Note that `config.candidates` (`packages/types/src/schemas.ts:316`,
   default 3) is **declared and never read** — a repo-wide grep for `config.candidates` finds
   nothing — and the planner emits exactly one portrait task per character (`planner.ts:210-211`).
   So in practice there is one candidate and no choice to make. Auto-approval here is not picking a
   winner; it is answering yes to the only option.
2. **Accept what the runner declined to accept.** Concretely: a `needs_human` frame, so Play shows
   it instead of a hole; and a slot holding two tied unaccepted candidates, so the slot resolves
   again. Both go through `asset.accept`, which already refuses a portrait, a concept and an upload
   by name (`session.ts:1425`, `:1431`, `:1437`).

A run halts at the gate, so the loop is literally: run, approve everything pending, run again. Two
invocations of `pipeline.run` clear a project with a single gate, because the wave loop inside one
run handles the sheet→shot ordering on its own.

### Where it has to sit so it cannot forge provenance

**Not in the scheduler, and not in the store.** Provenance in this system is two things — the
command journal at `vngen/state/commands.jsonl` and the per-repo commit after every mutating
command — and both are properties of the command layer. A scheduler that wrote `status: approved`
into `character.md` mid-wave would be the pipeline reaching into authored input with no record of
who decided, and it would have to import the worktree writers that `@vn/store` owns and the
scheduler deliberately does not.

The precedent for the alternative is `adoptSlot` (`packages/artgen/src/adoptslot.ts:239`), which is
the **one** `done` record written outside the scheduler. What keeps it honest is that it derives
the task identity in the same call from the project as it stands, so it can only mark done the node
whose output the bytes now are — and its doc ends: _"Nothing is accepted here. Adoption says 'this
is that task's output', not 'a human approved it'."_ It refuses a `portrait:` slot outright
(`adoptslot.ts:138-144`, `GATED_SLOT`) precisely because approving a look is the gate's act.

So the auto-approve must be **an invocation of the commands that already exist**, from main, with
the same `check` run first and the same journal line written after. That gives it three properties
for free: it is undoable where the underlying command is, it is committed like any other edit, and
`commands.jsonl` records that this project's characters were approved by a machine rather than by a
person. That last one is not a side effect — it is the feature. A generated project is committed
(`docs/cli.md:76`), and someone reading it a month later has to be able to tell that nobody looked.

### What a run loses when nobody looks

Being honest about this is most of the report's value, because each item is a contract that exists
because the failure happened.

- **The portrait compounds.** A character's approved portrait is the identity reference fed to
  every model sheet and every shot they appear in (`planner.ts:255-277`). Approving the first draft
  is not one decision about one picture; it is the decision that fixes what that character looks
  like for the entire run. This is the single largest thing the gate is for, and it is the single
  thing auto-approval removes.
- **`needs_human` stops meaning anything.** The status is never auto-retried (`scheduler.ts:110`,
  and the comment at `:101`: _"a request for a human, not a fault"_). If the mode accepts those
  frames, the reviewers' verdict has been overruled by policy, and the run's exit code — which
  already excludes `needs_human` — stops distinguishing a clean project from one where every shot
  failed review four times.
- **The refine cap becomes a spend multiplier.** `costPreview`
  (`packages/pipeline/src/pipeline.ts:48-74`) counts a shot as `max_refine_attempts` image calls
  and `max_refine_attempts × models.vision.length` review calls, because that is the P7 worst case.
  At the shipped defaults (4 and two reviewers) a twenty-shot scene's upper bound is 80 image calls
  and 160 review calls. A mode where nobody reads the critique is a mode that pays for the critique
  four times and then ignores it.
- **Drift is never noticed.** No prose edit invalidates art, which is why `driftOf`
  (`packages/pipeline/src/drift.ts`) re-derives `unrendered | current | drifted | unknown` on every
  read and Coverage marks it. Drift is a report to a human; with no human, it is a field nobody
  fetches.
- **`vngen cost` still undercounts.** Planning is incremental, so the preview is a snapshot of
  currently-plannable work. In a project where the gate is answered automatically, the second wave
  unlocks far more than the first preview showed — which is exactly the case where the author most
  needs the number to be right.

## The other simplifications

### The editors: this is a layout, not a mode

Of the twelve, a play surface wants four: **Convo** (ask for things), **Play** (watch the result),
**Script** or **Branches** (see the story), and **Asset** (look at one picture and change the art
note). Tasks, Task Graph and Inspector are instrumentation for a run you are supervising; Coverage
is drift and shot coverage; Project is `project.yaml`; Documents and Wiki matter once a project is
big enough to lose things in.

**That arrangement does not need a mode, because it is a layout template.** A template is a named
screen arrangement the project owns at `.vnstudio/layouts/<slug>.json`, applied from View ▸ Layout,
and two ship today as declarative recipes main can write with no renderer in the loop — **Writing**
and **Art** (`docs/desktop-app.md`, `plans/layout-templates-and-the-view-menu.md`). A third,
**Play**, is a recipe file and a line in `ensureLayouts`. It costs nothing, it is reversible by one
menu click, and — crucially — it hides editors without making them unreachable, which is the
difference between a simplified surface and a crippled one. A mode that *removed* editors would
have to answer what happens when the author is handed a refusal naming a pane they cannot open.

### The tree

Two changes, both projections rather than new state. **Unapproved assets** is empty by construction
in this mode, and `unapprovedBranch` already returns `undefined` when both groups are empty
(`doctree.ts:309`) and is omitted from `roots` — so it disappears on its own with no flag. The
**Assets** branch is the one that stays and the one that needs work; there is already a todo asking
for it to be organised by slot with per-slot history, and that is the right shape here too, because
a slot is the only address a casual user can be expected to hold ("Ada's portrait", not
`c1f4b2…`).

### The agent

In this mode the agent is not one surface among twelve; it is the primary one. Two of its existing
properties should survive untouched and one should change.

Survive: **plan mode is read-only and a plan is approved before it runs**, and the `confirm` door
in front of `generate_image` / `edit_image` (`packages/authoring/src/loop.ts:563-570`). That door
is the only thing between a conversational request and a billed image call, and the sentence on the
card is built in main by `toolconfirm.ts` rather than being the raw arguments. Removing it because
"a beginner shouldn't be asked" is precisely the bug `session.ts:729` records.

Change: **the tool list is the wrong length for this audience.** Thirty-eight tools includes seven
git verbs, `regenerate_context`, `parse_fountain`, `extract_entities` and the file-editing pair
with its read ledger. A play profile would offer the create/edit tools for characters, locations
and scenes, `generate_image`, `view_image`, `search_bible` and the three read tools — and let the
rest arrive by deferred loading, which the prompt-caching work already built the mechanism for.

### The defaults

- `max_refine_attempts` should come **down**, not up — `2` rather than `4`. Nobody is reading the
  critique, so the marginal attempts buy an unread verdict at full price. Note that lowering it
  changes no hash: it is a runner cap, not a task input.
- `image_params.seed` should stay absent. Zero is a seed and `seedFor`
  (`packages/artgen/src/prompts.ts:51-54`) resolves the narrowest authored rung, so writing a
  default seed into a template project would silently pin every image in it.
- `models` should stay as they are. Model ids are the provider seam, and swapping them is how a
  backend changes; a mode that quietly downgraded the image model would make "why does mine look
  worse than the screenshots" unanswerable.
- `portrait_overlay` stays `false`. It is off because a shot prompt names its own subjects, and
  turning it on stages a P3 portrait — an opaque plate, not a keyed cutout — over the frame.

### Errors, for someone who cannot read a slot key

The refusals in this system are already written as sentences rather than codes, which is most of
the work. `slotLabel` (`packages/artgen/src/refcycle.ts:38-51`) yields `ada portrait`,
`cafe — night plate`, `arrival/s2 frame`; `SlotNode.blocked` carries the sentence saying why a slot
cannot state a task identity yet, and the tree puts it on the row as a tooltip. `prereqRefusal`,
`previewAccept`'s five refusals and `gate.approve`'s three are all English.

Three gaps remain, and they are the ones this audience hits first:

- **The missing key.** `resolveKeys` throws `missing gemini API key: set $GEMINI_API_KEY or place
  gemini.txt in a keys/ dir` (`packages/config/src/keys.ts:92-100`), surfaced as `keyError` in
  `pipeline.run`'s check. It names the fix, but the fix is two concepts (an env var, a gitignored
  directory) and the app has a command that does it — `project.setKey`. The refusal should name the
  command, not the file.
- **The upper bound is in calls, not money.** `costPreview` counts `imageCalls` and `reviewCalls`,
  and **there is no price table anywhere in this repository** — no `costUsd`, no per-model rate map;
  the only dollar figures in the tree are prose in `docs/testkit.md` and an unimplemented plan. For
  an author who knows what a Gemini image call costs, "80 image calls" is a budget. For the audience
  this mode is for, it is a number with no units. This is the sharpest unfunded dependency the mode
  has.
- **`needs_human` has no lay reading.** The persisted sentence is _"shot still has blocking defects
  after 4 attempts"_. What a beginner needs is "this picture came out wrong four times; here it is
  anyway — try changing the art note", with the art-note field one click away.

## What must not be simplified away

- **Money.** Every image is a purchase. The confirm card in front of the agent's image tools, the
  `check` note that prints the upper bound before a run, and `mock` defaulting to `true` on the
  generated form are the three places this system currently tells the truth about spending, and a
  mode aimed at people experimenting is the mode where that matters most, not least.
- **Secrets.** `keys/` is gitignored, `project.yaml` records env-var _names_ only, `resolveKeys`
  names the source and never the value, `prop.secret` is redacted at `digestProps`, and
  `project.setKey` is deliberately not undoable. A newcomer is exactly the person who will paste a
  key into the first box they see, and the app commits the worktree after every mutating command —
  so the gitignore line is load-bearing within the second.
- **Provenance.** `commands.jsonl`, the git stamp, and the fact that `vngen/` is committed rather
  than ignored. A play project is still a project someone might later want to finish, and the
  record of what was approved by policy rather than by a person is what makes that possible.
- **The refusals themselves.** The repo rule is that a disabled control's tooltip is its refusal,
  verbatim. Simplifying by _hiding_ what cannot be done is the same bug as a greyed control that
  will not say why — and it is worse for a beginner, who has no model of the system to fill the
  silence with.
- **The base-store rule.** A base root present without a manifest is `unavailable` and the planner
  plans nothing rather than re-buying an approved library. No mode may relax that.

## A recommended shape

**Call the mode what it does, not who it is for.** "Beginner mode" is a claim about the user;
**Unattended** is a claim about the run, and it is the true one — the surface does not get simpler
because approvals stop being asked for, and the two changes should not hide behind one word. So:

- **`unattended: true` in `project.yaml`** — a **project** setting, not an app setting. Three
  reasons, each decisive. It changes what gets written into the repository (`character.md`
  front-matter, manifest flags), so it must travel with the repository and be visible in its diff.
  App settings live in `.vndesktop/session.json`, which is per _install_ and is explicitly about
  window facts. And `project.yaml` is where a run already reads its configuration, so the CLI gets
  the same behaviour without a second mechanism — which matters, because a project someone played
  with and then wants to finish should behave identically in both hosts.
- **A `Play` layout template**, shipped as a recipe alongside Writing and Art. Entering the simpler
  surface is applying it; leaving is applying another. No mode flag, no hidden commands, no editor
  that cannot be reached.

Entering `unattended` is a checkbox in the New Project dialog and a field in the Project editor —
which today has exactly one editable field for a reason worth keeping, so this becomes the second
and should be argued for on the same grounds: it is a setting an author reaches for as a decision
about the whole project, and it should confirm and say what it will do. Leaving it is clearing the
field; nothing is undone, because approvals already granted stay granted and the journal already
says how. **The mode is not reversible in the sense of un-approving things, and the setting's
confirmation text should say so.**

### The smallest honest first version

One command and one field, in that order — and the command is worth shipping on its own even if
the field never does.

**`gate.approveAll`**, `mutating`, `undoable`, `confirm: true`. Its `check` lists every pending
character and the candidate that would be approved for each, refuses when any character has no
candidate or more than one, and states plainly that this approves a look without anyone looking at
it. Its `run` invokes `gate.approve` per character through the registry, so each gets its own
`check`, its own journal line and its own commit. That is the whole feature: it forges nothing, it
introduces no new write path, and it is exactly the loop a person performs by hand today.

**Then `unattended: true`**, whose only behaviour is that the desktop app runs `gate.approveAll`
when a run reports `blockedOnGate` and then runs again — the same chaining `asset.regenerate`
already does when `autoRunReason` says its task is the only one pending
(`apps/desktop/src/main/commands/asset.ts:221-229`).

Deliberately **not** in the first version: auto-accepting `needs_human` frames, and lowering
`max_refine_attempts`. Both are judgements about picture quality rather than about who presses a
button, both change what reaches the playable, and both should wait until the first version has
shown whether the gate was ever the thing standing in anyone's way.

## Open questions

- **Should an unattended project be marked in the manifest, or only in the journal?** The journal
  is the honest record, but it is a file nobody opens. An `approvedBy: 'policy'` on the asset would
  let the Asset pane say so on the picture — at the cost of a manifest field that every reader has
  to learn, for information that is not about the bytes.
- **Does the playable need to show a `needs_human` frame at all**, or is a hole the right answer
  even here? Showing it means the reviewers' verdict has no consequence; hiding it means a
  beginner's story has gaps they cannot explain. A third option — show it with a mark on the frame
  in Play — has never been costed.
- **Is the price table a prerequisite or a separate plan?** The mode's whole risk is spending, the
  app cannot currently name a figure, and the pricing work is already written up and unimplemented
  in `plans/provider-credentials-and-the-ai-usage-ledger.md`. Shipping unattended approval before
  the app can say what a run costs is shipping the accelerator before the fuel gauge.

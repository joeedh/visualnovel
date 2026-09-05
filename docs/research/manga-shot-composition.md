# Manga and anime shot composition

_Internal research. Nothing here is a plan. It asks what this repository would have to
change to produce a manga or anime shot composition style (every frame fully staging its
cast, with storyboard-style cuts) rather than the light-novel look of a portrait over a
background. It reaches a recommendation. The companion survey of how generative systems
produce a specifically framed shot at all is
[`shot-framing-systems.md`](shot-framing-systems.md). This report cites its mechanisms
rather than restating them._

_Status: research. This document was written 23 August 2026 against the worktree as it
stood at that date. Every symbol, file and contract named here was read; claims that could
not be checked against code are collected in the last section._

<!-- toc -->

- [The premise is already the default](#the-premise-is-already-the-default)
- [What the current path does](#what-the-current-path-does)
- [Where a light-novel assumption still lives](#where-a-light-novel-assumption-still-lives)
- [What the style would actually need](#what-the-style-would-actually-need)
    - [Shot size is four words, and one of them names a job](#shot-size-is-four-words-and-one-of-them-names-a-job)
    - [Nothing records where a character stands in the frame](#nothing-records-where-a-character-stands-in-the-frame)
    - [Aspect belongs to the project rather than to the shot](#aspect-belongs-to-the-project-rather-than-to-the-shot)
    - [A full-body frame is drawn from a head-and-shoulders reference](#a-full-body-frame-is-drawn-from-a-head-and-shoulders-reference)
- [What it costs](#what-it-costs)
    - [Shot count, worked against a real scene](#shot-count-worked-against-a-real-scene)
    - [Attempts per shot, and why a framing check raises them](#attempts-per-shot-and-why-a-framing-check-raises-them)
    - [The multiplier](#the-multiplier)
    - [What `vngen cost` can and cannot answer](#what-vngen-cost-can-and-cannot-answer)
- [Which contracts survive and which are strained](#which-contracts-survive-and-which-are-strained)
- [Consistency](#consistency)
- [One mode, not two](#one-mode-not-two)
- [A staged path](#a-staged-path)
- [What it costs to undo](#what-it-costs-to-undo)
- [What could not be verified](#what-could-not-be-verified)

<!-- tocstop -->

## The premise is already the default

The todo this report answers proposes replacing pop-up portraits with frames that fully
stage their cast. That replacement has already shipped. `portrait_overlay` in project.yaml
defaults to `false` (packages/types/src/schemas.ts:334), `buildShotChunks` names the
shot's subjects in the prompt it derives, and the desktop Play editor composites a
portrait over the frame only when the flag is on. The reasoning and the alternatives
considered are in
[`../plans/archive/INDEX.md#portrait-overlay-opt-in`](../plans/archive/INDEX.md#portrait-overlay-opt-in),
and the contract is stated in
[`../reference/playable-format.md`](../reference/playable-format.md): a frame with a cast
already shows that cast, so staging a portrait over it draws the same character twice.

The choice between the two looks is not what matters here. Control over the frame is what
separates a frame that happens to contain its cast from a frame composed the way a
storyboard artist would compose it. That control is missing in four specific places, none
of which is the presentation layer.

## What the current path does

A shot is authored or decomposed into `work/shots/<sceneId>.json`, whose on-disk shape
splits authored fields at the top level from run output nested under `shotData`
(packages/store/src/shots.ts). The in-memory `Shot` (packages/types/src/entities.ts:184)
carries `framing`, `location`, `subjects`, an optional free-text `camera`, plus the
authored art-direction fields `artNotes`, `seed` and `promptOverride`.

`buildShotChunks` (packages/artgen/src/prompts.ts:382) turns that into six prompt chunks:
the art style preamble, a framing clause reading
`${shot.framing} shot in ${location.name} (${shot.location})`, a subject clause listing
each character with the outfit `outfitFor` resolved plus any pose and expression, a camera
clause reading `Camera: ${shot.camera}.` when the shot authored one, the shot's own
`artNotes` through `artClause`, and the scaffolding sentence
`Render as a single illustrated frame, no UI text.` `renderPrompt` joins the non-empty
chunks with single spaces, so an empty chunk contributes no bytes.

The planner assembles the references in a fixed order
(packages/pipeline/src/planner.ts:249). The location plate comes first, then each
subject's approved portrait, then that subject's front model sheet if and only if
`outfitFor` resolved to something other than the character's `defaultOutfit`. Authored
references from `shotRefs` are appended last. `shotInputs` packs
`{shotId, prompt, refs, params}` and `makeTask` hashes the whole object, and
`canonicalJson` treats arrays positionally, so a different reference order produces a
different hash.

`makeShotRunner` (packages/pipeline/src/runners.ts:102) generates, writes the bytes, and
has every configured vision model review the result against `shotSpec`. It accepts the
result if the report is clean. Otherwise it appends deterministic corrections through
`refinePrompt` and tries again, up to `config.max_refine_attempts`. The loop stops early
if a refinement produces a byte-identical prompt, and flags `needs_human` when it reaches
the cap.

`buildPlayable` walks each scene's lines, emits a `show` beat whenever the covering shot
changes, and writes `{type, shot?, image?}`, which is the whole of `showBeatSchema`
(packages/types/src/playable.ts). The desktop runner folds each `show` into the frame that
follows (`framesOf` in apps/desktop/renderer/pathux/play/playback.ts) and draws the image
at `objectFit: 'contain'`.

## Where a light-novel assumption still lives

The four residues are listed in descending order of how much they would cost to change.

The playable's `show` beat carries an asset reference and a shot id and nothing else.
There is no field for framing, for panel geometry, or for where anything sits in the
frame. A published project ships with a renderer that reads the same file a second time:
`site-cli.ts` validates by hand rather than through `playableSchema`, and it is committed
into the author's repository as `.vnstudio/pages/vn-site.mjs`
([`../guides/github-pages.md`](../guides/github-pages.md)). Adding a beat field therefore
means updating two consumers, and one of them is in somebody else's git history.

`renderSite` (packages/export/src/site.ts) renders the playable as a light-novel site with
the cast listed as portraits in their own section, and its comment says a light novel has
no place to overlay a portrait on a frame. That comment is correct for a light novel and
wrong for a comic, where a page contains panels.

`Frame` in apps/desktop/renderer/pathux/play/playback.ts still names the full shot image
`bg`. The name says "background", but the field holds the whole picture. Renaming it is
cheap and changes no behaviour, and a reader of that module learns the format from the
name.

The P3 portrait is prompted for a plain neutral background and head-and-shoulders framing,
so it is an opaque plate rather than a keyed cutout. Nothing in the repository produces an
asset with an alpha channel. The missing alpha channel blocks only the light-novel path,
which is why that path stayed unbuilt.

## What the style would actually need

### Shot size is four words, and one of them names a job

`framing` is declared twice and both declarations must agree. The TypeScript union at
packages/types/src/entities.ts:188 and the zod enum `shotFraming` at
packages/types/src/schemas.ts:366 are both `'wide' | 'medium' | 'close' | 'establishing'`.

Three of those four are sizes. `establishing` is a purpose. A shot can be an establishing
shot at any size, and a wide shot that establishes nothing is a common enough beat that
the decomposer's own system prompt has to pick one word for both.
[`shot-framing-systems.md`](shot-framing-systems.md#the-evidence-says-use-a-small-discrete-vocabulary)
already raises the conflation and argues, on evidence from several independent systems,
for keeping the vocabulary small and discrete rather than opening it up to free text. This
report agrees with the argument and adds a further reason. The framing word is literal
prompt text, so it sits inside the task hash, and the enum therefore bounds deduplication
as well as authoring. Splitting `establishing` out into its own field re-renders every
establishing shot in every project rather than only changing the code.

Camera angle and level exist today only as `Shot.camera`, an unvalidated string. It
reaches the prompt as one clause and it also reaches the reviewer, because
`shotDescription` (packages/artgen/src/prompts.ts:495) appends `Camera: ${shot.camera}.`
to the spec every reviewer is handed. The second path is the more consequential one, and
it is why this report disagrees with the survey's second recommendation. The survey
proposes promoting angle and level to enums without expecting to verify them. Promoting
them is right. Leaving them in `shotSpec` is not, because the same survey measures
shot-scale classification at about 0.80 F1 on animation against 0.61 and 0.68 for angle
and level
([`shot-framing-systems.md`](shot-framing-systems.md#the-domain-gap-is-real-and-it-is-uneven)),
and reports the best of twenty-four vision-language models scoring 55.2% on composition
([`shot-framing-systems.md`](shot-framing-systems.md#vision-language-models-are-weak-at-cinematography-which-is-the-reason)).
Placing a property the reviewer cannot judge into the spec the reviewer judges against
produces blocking defects that the refine loop cannot resolve. The two code paths are
already separate functions reading the same `Shot`, so routing a field into
`buildShotChunks` and out of `shotSpec` costs one line.

### Nothing records where a character stands in the frame

`ShotSubject` (packages/types/src/entities.ts:216) carries `characterId`, `outfit`, `pose`
and `expression`. `buildShotChunks` joins the subjects into one sentence:
`Subjects: Aiko, wearing school uniform, pose: leaning, expression: wary; Haruki, wearing uniform.`
That sentence lists the subjects and states no geometry.

Anime dialogue coverage depends mostly on geometry. An over-the-shoulder pairs a near
figure at one edge with a far figure at the other. An eyeline match requires the two
singles that flank a cut to look in opposite directions. A two-shot that holds while one
character turns away depends on which side of frame each of them started on. None of this
geometry is expressible today, and a reader notices geometry that is wrong, because a cut
that breaks the line of action reads as a mistake rather than as a stylistic choice.

The survey's Toric-space material and its Architecture B
([`shot-framing-systems.md`](shot-framing-systems.md#architecture-b--2d-instance-layout-with-masks))
are the published answers to screen placement, and both assume a conditioning path that
accepts a layout signal. This repository has no such path. `ImageParams`
(packages/types/src/entities.ts:36) carries `modelId`, `aspect`, `seed` and `extra`, with
no mask and no control map, and the Gemini image backend maps every reference to an image
part with no strength parameter. So this repository can only state screen placement in the
words of a prompt, at least until the provider seam accepts a control input. Stating it is
still worth doing, because a detector can check a placement clause even when generation
cannot enforce it. This report does not claim that prompt wording will reliably produce
the layout it describes.

### Aspect belongs to the project rather than to the shot

`imageParams(config)` (packages/artgen/src/prompts.ts:31) reads
`config.image_params.aspect`, which defaults to `'16:9'`
(packages/types/src/schemas.ts:307), and hands the same value to every image kind. One
image kind therefore cannot be tall while another is wide.

Mixed panel shapes are close to the definition of a manga page, so this is the gap most
specific to the style and the cheapest to close. `aspect` already sits inside `params`,
which is already inside the task hash. `seedFor` (packages/artgen/src/prompts.ts:50) is
the exact precedent for adding a narrower rung without disturbing existing hashes. A rung
with nothing authored returns the params object untouched, so a project that authors no
per-shot aspect keeps every hash it had.

### A full-body frame is drawn from a head-and-shoulders reference

This finding is the one most likely to be worth acting on immediately, and it is
independent of everything else in this report.

The planner generates three model sheets (front, side and back, from `MODEL_SHEET_ANGLES`)
for every outfit `usedOutfits` reports, and `usedOutfits` (packages/model/src/used.ts:48)
seeds every character with their `defaultOutfit` first. So a run produces three full-body
turnaround sheets of every approved character in their default clothes.

The shot planner then attaches none of them.
`if (outfit.id === character.defaultOutfit) continue;` at
packages/pipeline/src/planner.ts:262 skips the sheet for exactly the case that covers most
shots in most projects, on the stated reasoning that the portrait already shows the
default outfit. The portrait does show the outfit, but only from the chest up, on a plain
neutral background, because that is what `buildPortraitChunks` asks for. A wide shot of a
character standing in a location is therefore generated from a head-and-shoulders
reference and a background plate, and the model fills in the entire body below the
collarbone.

For a light-novel look this barely matters, because the portrait overlay shows the
character and the shot supplies only the scenery behind them. For a style where every
frame stages the whole figure, character scale across shots becomes the dominant
consistency risk, and the survey finds it to be the one genuinely unquantified property
([`shot-framing-systems.md`](shot-framing-systems.md#there-is-no-validated-automated-metric-for-whole-character-consistency)),
so no downstream check catches it. The fix attaches an asset that already exists and has
already been paid for. Generation is not the cost. Adding a reference changes `refs`,
which changes the task hash, which re-renders every shot in every project. That cost is
real, and the staged path below prices it in.

The angle-matched version of the same fix (attaching the side or back sheet when the
shot's camera calls for one) needs an angle field to select on, which the earlier enum
promotion provides. The two changes compose.

## What it costs

This argument settles the question, so the text works through it instead of asserting it.

### Shot count, worked against a real scene

The deterministic baseline produces one establishing shot covering the whole cast plus one
medium shot per character in the scene (`deterministicShots`,
packages/artgen/src/storyboard.ts:48). The model path produces a similar count by
construction, because `DECOMP_SYSTEM` instructs the model to cover the scene with as few
shots as it takes to tell the scene clearly.

templates/basic/scenes/rooftop.md is a two-hander with seven lines: three lines of action
and narration, and four lines of dialogue alternating between Aiko and Haruki. The
baseline decomposes it into three shots: an establishing shot over L1, L4 and L7, a medium
shot of Aiko over L2 and L5, and a medium shot of Haruki over L3 and L6.

An anime episode covering the same page would storyboard roughly as an exterior
establishing shot, a wide two-shot at the fence, a single for each of the four dialogue
lines, a cut-in on Haruki's glance at L4, and a closing two-shot on the smile at L7. The
storyboard runs seven to nine shots against a baseline of three. The number of exchanges
drives the multiplier rather than the number of characters, so the multiplier does not
shrink on longer scenes. A three-hander raises the baseline by one and raises the
storyboard by however many more times the conversation turns.

The storyboard-level figure is 2.5× to 3×. The baseline is generous to the style, since a
scene with one speaker and six lines of narration is two shots today and could reasonably
be six.

### Attempts per shot, and why a framing check raises them

`costPreview` (packages/pipeline/src/pipeline.ts:48) counts `maxAttempts` image calls per
pending `shot_image` task and `maxAttempts × reviewers` review calls.
`max_refine_attempts` defaults to 4 and `models.vision` defaults to two entries, so the
current upper bound for one shot is four image calls and eight review calls. The doc
comment says the actual run usually costs less because most shots pass on the first
attempt.

A tighter framing specification moves that mean upward, for a mechanical reason. Each
field added to `shotSpec` gives a reviewer another way to file a blocking defect.
`refinePrompt` (packages/pipeline/src/p6.ts) rewrites strings deterministically with no
model call, and the loop gives up early only when the refined prompt comes back
byte-identical to the previous one, which requires the merged defect list to be
byte-identical across two attempts. Free-form geometric critiques from a vision model are
unlikely to repeat verbatim, so the early stop rarely triggers and the shot uses the full
attempt cap before it ends in `needs_human`.

On the survey's evidence, the extra attempts buy less than they cost. No published
closed-loop image system verifies shot scale, crop, headroom or camera height
([`shot-framing-systems.md`](shot-framing-systems.md#what-the-closed-loop-systems-actually-verify)),
and the practitioner reroll rate the survey reports is two to four generations per usable
image
([`shot-framing-systems.md`](shot-framing-systems.md#what-the-practitioner-community-actually-does)).
The survey's first recommendation follows from these two findings, and this report
endorses it: put a geometric measurement in the loop rather than more prose in the spec,
because a detector's answer is stable across attempts and a language model's answer
varies.

### The multiplier

The two terms multiply out. The shots rise 2.5× to 3×, and the mean attempt count rises
from something like 1.3 toward 2.5 or 3 if framing critique enters the loop without a
stable measurement under it. Together they give roughly 5× to 7× the image calls of
today's default path, and the same multiple again on review calls scaled by the number of
configured vision models. A framing check built from a detector rather than a prompt keeps
the second term near its current value and brings the whole change back to about 3×.

The difference between 3× and 6× is the practical argument for building the measurement
before building the vocabulary that would depend on it.

One further multiplier is defined but unused. `candidates` is declared in the config
schema with a default of 3 (packages/types/src/schemas.ts:319) and is read nowhere in the
pipeline. Any future generate-several-and-choose behaviour would multiply every figure
above by that number, so note that the option already exists in the schema and is not yet
connected to anything.

### What `vngen cost` can and cannot answer

`vngen cost` runs the real planner with mock providers and prints an upper bound in calls.
Two limitations matter for a decision of this size.

The count covers the graph as it stands, and the planner runs once per wave, so a project
whose P3 character gate has not opened reports zero shot tasks. The contract in
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) means the
number an author sees before approving differs from the number they will pay.

There is no price per image anywhere in the repository. `costPreview` returns call counts,
the desktop equivalent in apps/desktop/src/main/commands/pipeline.ts prints the same
counts, and the only money-adjacent constants in the tree are the authoring agent's token
budget ladder in packages/types/src/budget.ts. The author therefore cannot convert a 3× or
a 6× into currency inside the app. [`a-less-technical-mode.md`](a-less-technical-mode.md)
reached the same conclusion from a different direction and called it "the accelerator
before the fuel gauge". A change that multiplies image calls is the strongest argument yet
for a price table.

## Which contracts survive and which are strained

Task identity stays `sha256(kind, inputs)`. The two content-addressed asset roots
([`../reference/asset-stores.md`](../reference/asset-stores.md)) stay as they are, since a
shot frame routes to the project root however it was framed. The P3 approval gate stays a
planner predicate. Explicit decomposition stays, as does the rule that a missing
`work/shots/<sceneId>.json` is the only signal meaning "decompose this scene". Outfit
inheritance through `outfitFor`, line-id allocation, and the round-trip guarantee on scene
prose all stay unchanged. Nothing in this report touches the parser or the writers.

The slot graph's shape is fixed, and only the number of nodes grows. `refsOfSlot`
(packages/artgen/src/refcycle.ts:190) derives a shot's edges from its plate and its
subjects, so more shots add more `shot:` nodes rather than a new slot kind. `shotUpstream`
in packages/artgen/src/slotgraph.ts and the planner's own reference assembly must keep
enumerating the same set; packages/pipeline/src/tests/slotagreement.test.ts catches a
divergence.

Finer coverage improves drift reporting rather than straining it. `proseHash` covers the
lines a shot claims, so a single edited line invalidates one shot instead of a third of a
scene.

Two things are strained.

Framing properties become part of the task identity. Every framing property added to the
prompt widens the hash, which is correct behaviour for an authored art-direction field and
is exactly how `artNotes` and `seed` already work. There is no cross-shot dedupe to lose,
because `shot_image` inputs carry `shotId`, so every shot has its own hash regardless of
how similar two shots are. A wide and a cut-in of the same moment share no work today and
will share none after this change, even though a cut-in is geometrically a crop of the
wide.

The preceding observation is about a task kind the repository does not have.
`ImageProvider` declares both `generate` and `edit`, and `runModelSheet` already uses
`edit` with a prior task's output as the base, so the "seam" (the interface for deriving
one image from another) exists and is in use. The shot runner uses `generate` only. A
re-frame task that crops or re-stages from an accepted frame would be the first shot-side
use of that seam, and the survey reports the closest published equivalent at 5.16 against
8.35 on OmniContext
([`shot-framing-systems.md`](shot-framing-systems.md#inserting-the-cast-into-a-rendered-plate-not-yet-and-the-seam-is-already-there)).
That gap is wide enough that this report does not recommend the task yet.

Coverage refusals get more frequent. Only the first shot covering a line counts as
covering it, and the desktop coverage timeline refuses double coverage rather than hiding
the second frame ([`../reference/desktop-app.md`](../reference/desktop-app.md)). Denser
storyboards mean more shots competing for the same lines, so an author will meet that
refusal more often. The refusal is correct and should stay. The surface for resolving a
refusal will need attention.

## Consistency

Four mechanisms already carry identity across frames, and they handle this style unevenly.

A location plate stays fixed across shots. `shotInputs` puts the location plate first in
every shot's reference list, so five cuts inside one room all reference the same rendered
background. Cutting more densely uses this directly and requires nothing new.

Portraits hold faces and lose bodies because they are prompted head-and-shoulders on a
neutral ground. Model sheets hold bodies, and are usually not attached. So neither input
covers both.

The refine loop checks presence rather than geometry. `shotSpec` states who must be in
frame and `REVIEW_SYSTEM` makes `characters` the authority on presence, and that check
works. Nothing measures how large a character is drawn, and the survey is explicit that no
validated automated metric for whole-character consistency exists, that DINO agrees with
human preference 50.72% of the time, and that the story-visualization benchmarks crop
characters to compare identity and then discard the bounding boxes, so they record which
character appears and never how large it is drawn. Manga coverage cuts between sizes of
the same character constantly, so this style stresses scale hardest, and no metric covers
scale. This report agrees with the survey's diagnosis and adds that the consequence is
more severe here than in the survey's own framing, because the survey treats scale as a
per-shot authoring concern while a cut makes it a concern between shots.

A scale measurement across a scene's shots, rather than within one, would be genuinely
new. Such a measurement detects the character, takes the bounding-box height as a fraction
of frame height, and checks that height against what the shot's declared size implies.
Shot-scale classification survives the animation domain gap at about 0.80 F1 where camera
angle and level do not, so scale is the one framing property that justifies building a
detector
([`shot-framing-systems.md`](shot-framing-systems.md#shot-scale-and-camera-angle-can-be-measured-automatically)).

## One mode, not two

A project-level mode is unsuitable, for three reasons.

There is nothing to switch between. The full-frame path is the default and
`portrait_overlay` is already the opt-in for the other look, so a manga mode would be a
third setting layered over a binary that already covers the question in the todo.

Adding a mode doubles every contract involved. The decomposer's system prompt, the
reviewer spec, the playable schema, the desktop runner and the committed site renderer
would each need a branch, and the site renderer is committed into an author's repository,
so its branch would ship to machines this project does not control.

The differences that matter are per-shot properties. Size, angle, aspect and staging vary
within a page, and the style comes from mixing them. A mode would apply one setting to
every frame in the project, which forbids the mixing rather than enabling it. Putting the
properties on `Shot`, where `artNotes` and `seed` already live, lets an author mix them
and lets the agent reach them through the same rung machinery `rungsFor` already exposes.

We therefore recommend adding no mode, no new presentation path, and no second decomposer.
Spend the effort on making one frame controllable and on measuring what comes back, and
leave shot density to the author and to the decomposer's prompt, which is one string in
packages/artgen/src/storyboard.ts.

## A staged path

Each stage is "green" (passing) on its own, and no stage depends on a later stage.

Stage 1 attaches the front model sheet to every subject rather than only to subjects in a
non-default outfit. The sheets already exist and were already paid for. The change adds
one condition in the planner and the mirrored condition in `shotUpstream`, and
packages/pipeline/src/tests/slotagreement.test.ts enforces that both move together. Every
existing shot re-renders, because `refs` is in the hash. That cost falls in the same class
the repository already accepts for an outfit change, but it should be announced rather
than discovered.

Stage 2 promotes camera angle and level out of `Shot.camera` into optional enum fields.
The fields are emitted as their own prompt chunks and are deliberately kept out of
`shotSpec`. An optional field that emits no chunk when absent leaves every existing hash
untouched, and `artClause` and `seedFor` were both built to have that property.
`Shot.camera` stays for anything the enums do not cover.

Stage 3 adds an optional per-shot `aspect`, resolved through a helper with the same shape
as `seedFor` and defaulting to `config.image_params.aspect`. Shots that do not set one
keep their hashes. This change is the smallest and has the most style-specific payoff, and
panels are not possible without it.

Stage 4 adds the geometric shot-scale check to the P7 loop: detect the subject, compare
the bounding-box height fraction against what the declared framing implies, and file a
defect from the measurement rather than from a language model's output. The check is the
survey's Architecture A
([`shot-framing-systems.md`](shot-framing-systems.md#architecture-a--enum-plus-text-with-a-geometric-check))
and its first recommendation
([`shot-framing-systems.md`](shot-framing-systems.md#four-changes-in-order-of-value)).
Stage 4 keeps the cost multiplier near 3× instead of near 6×, so it should land before
anything that adds axes to the spec.

Stage 5 adds screen placement to `ShotSubject` and carries it through `showBeatSchema` to
the runner. It applies only if the first four stages are complete and the project still
needs panels. Stage 5 costs the most and should be deferred, because it touches a schema
pinned at `version: z.literal(1)`, the desktop `Frame` type, the Play editor's layout, and
the site renderer committed into author repositories.

Splitting `establishing` out of `framing` is deliberately not staged. The split would
re-render every establishing shot in every project for a naming improvement, and stage 2's
angle field covers most of the cases an author would have used the split for.

## What it costs to undo

Stages 2 and 3 can be undone cleanly. Both add optional fields that contribute no prompt
chunk and no params change when absent, so deleting the field restores byte-identical
prompts and the original task hashes. `shotsFileSchema` is a plain `z.object` with no
`.strict()`, so an abandoned key in an existing `work/shots/<sceneId>.json` is dropped on
the next read rather than refused. Nothing has to be regenerated.

Stage 1 undoes by reverting the condition, which costs a second full re-render. The render
cost is paid once to apply the change and once to revert it. Be most certain of Stage 1
before starting it.

Deleting the check undoes stage 4. The cost is not the difficulty of reverting but the
runs made while the check was wrong. A miscalibrated scale threshold files blocking
defects that the refine loop cannot clear, and every affected shot burns its full attempt
cap before landing `needs_human`. Calibrate the check against existing accepted frames
before it gates anything.

Stage 5 is expensive to undo. An older reader ignores a field added to `showBeatSchema`
without a bumped `version`, which is benign. The site renderer is a copy committed into
the author's repository, so undoing means every project that ran `project.installPages`
carries a stale bundle until someone re-installs it. Stage 5 is deferred rather than
sequenced earlier because the stale bundle is the costlier of the two outcomes.

## What could not be verified

There is no `examples/` directory in this worktree, so every shots-per-scene figure here
is derived from `deterministicShots` and from templates/basic rather than measured against
a real run. Other research in this repository cites `examples/test4`, so the measurement
is available elsewhere and would be worth taking. An honest cost argument needs a
histogram of shots per scene and attempts per shot over a project that actually ran.

The mean attempt count today is an assumption. `costPreview` reports only the upper bound,
and nothing in the repository aggregates `task.attempts` into a distribution. The 1.3 used
above is a guess, consistent with the doc comment's claim that most shots pass on the
first attempt. The argument holds whatever the exact figure is, but the size of the effect
it estimates depends on that figure.

The tree contains no price per image, so nothing here can be converted to a cost in money.

This report does not test whether a vision reviewer would file useful geometric defects,
and the survey's evidence suggests it would not. Because that question is untested, stage
4 specifies a detector rather than a prompt, and the report does not recommend adding
framing properties to `shotSpec`.

No test exercises whether the Gemini image backend honours a per-shot aspect that differs
from the project default. The parameter is passed through `ImageParams` and the schema
accepts any string, so a refused value should surface as a provider error rather than a
silently wrong-shaped image. No live call has confirmed that behaviour.

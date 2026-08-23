# Manga and anime shot composition

_Research, internal. Nothing here is a plan. It asks what this repository would have to change to
produce a manga or anime shot composition style — every frame fully staging its cast, cut the way a
storyboard cuts — rather than the light-novel look of a portrait over a background. It reaches a
recommendation. The companion survey of how generative systems produce a specifically framed shot at
all is [`shot-framing-systems.md`](shot-framing-systems.md); this report cites its mechanisms rather
than restating them._

_Status: **research.** Written 23 August 2026 against the worktree at that date. Every symbol, file
and contract named here was read; claims that could not be checked against code are collected in the
last section._

<!-- toc -->

- [The premise is already the default](#the-premise-is-already-the-default)
- [What the current path does](#what-the-current-path-does)
- [Where a light-novel assumption still lives](#where-a-light-novel-assumption-still-lives)
- [What the style would actually need](#what-the-style-would-actually-need)
  * [Shot size is four words, and one of them names a job](#shot-size-is-four-words-and-one-of-them-names-a-job)
  * [Nothing records where a character stands in the frame](#nothing-records-where-a-character-stands-in-the-frame)
  * [Aspect belongs to the project rather than to the shot](#aspect-belongs-to-the-project-rather-than-to-the-shot)
  * [A full-body frame is drawn from a head-and-shoulders reference](#a-full-body-frame-is-drawn-from-a-head-and-shoulders-reference)
- [What it costs](#what-it-costs)
  * [Shot count, worked against a real scene](#shot-count-worked-against-a-real-scene)
  * [Attempts per shot, and why a framing check raises them](#attempts-per-shot-and-why-a-framing-check-raises-them)
  * [The multiplier](#the-multiplier)
  * [What `vngen cost` can and cannot answer](#what-vngen-cost-can-and-cannot-answer)
- [Which contracts survive and which are strained](#which-contracts-survive-and-which-are-strained)
- [Consistency](#consistency)
- [One mode, not two](#one-mode-not-two)
- [A staged path](#a-staged-path)
- [What it costs to undo](#what-it-costs-to-undo)
- [What could not be verified](#what-could-not-be-verified)

<!-- tocstop -->

## The premise is already the default

The todo this report answers proposes replacing pop-up portraits with frames that fully stage their
cast. That replacement has already shipped. `portrait_overlay` in project.yaml defaults to `false`
(packages/types/src/schemas.ts:334), `buildShotChunks` names the shot's subjects in the prompt it
derives, and the desktop Play editor composites a portrait over the frame only when the project
turned the flag on. The reasoning and the alternatives considered are in
[`../plans/archive/portrait-overlay-opt-in.md`](../plans/archive/portrait-overlay-opt-in.md), and the
contract is stated in [`../reference/playable-format.md`](../reference/playable-format.md): a frame
with a cast already is a picture of that cast, so staging a portrait over it draws the same character
twice.

The question worth asking is therefore not which of the two looks to adopt. It is what stands between
a frame that happens to contain its cast and a frame composed the way a storyboard artist would
compose it. The answer is control over the frame, and it is missing in four specific places. None of
them is the presentation layer.

## What the current path does

A shot is authored or decomposed into `work/shots/<sceneId>.json`, whose on-disk shape splits
authored fields at the top level from run output nested under `shotData`
(packages/store/src/shots.ts). The in-memory `Shot` (packages/types/src/entities.ts:184) carries
`framing`, `location`, `subjects`, an optional free-text `camera`, plus the authored art-direction
rungs `artNotes`, `seed` and `promptOverride`.

`buildShotChunks` (packages/artgen/src/prompts.ts:382) turns that into six prompt chunks: the art
style preamble, a framing clause reading `${shot.framing} shot in ${location.name} (${shot.location})`,
a subject clause listing each character with the outfit `outfitFor` resolved plus any pose and
expression, a camera clause reading `Camera: ${shot.camera}.` when one was authored, the shot's own
`artNotes` through `artClause`, and the scaffolding sentence `Render as a single illustrated frame, no
UI text.` `renderPrompt` joins the non-empty chunks with single spaces, so a chunk that has nothing to
say contributes no bytes.

The planner assembles the references in a fixed order (packages/pipeline/src/planner.ts:249): the
location plate first, then each subject's approved portrait, then that subject's front model sheet if
and only if `outfitFor` resolved to something other than the character's `defaultOutfit`. Authored
references from `shotRefs` are appended last. `shotInputs` packs `{shotId, prompt, refs, params}` and
`makeTask` hashes the whole object, so ordering is load-bearing: `canonicalJson` treats arrays
positionally.

`makeShotRunner` (packages/pipeline/src/runners.ts:102) generates, writes the bytes, has every
configured vision model review the result against `shotSpec`, and either accepts on a clean report or
appends deterministic corrections through `refinePrompt` and tries again, up to
`config.max_refine_attempts`. The loop breaks early when a refinement produces a byte-identical
prompt, and flags `needs_human` at the cap.

`buildPlayable` walks each scene's lines, emits a `show` beat whenever the covering shot changes, and
writes `{type, shot?, image?}` — the whole of `showBeatSchema` (packages/types/src/playable.ts). The
desktop runner folds each `show` into the frame that follows (`framesOf` in
apps/desktop/renderer/pathux/play/playback.ts) and draws the image at `objectFit: 'contain'`.

## Where a light-novel assumption still lives

Four residues, in descending order of how much they would cost to change.

The playable's `show` beat carries an asset reference and a shot id and nothing else. There is no
field for framing, for panel geometry, or for where anything sits in the frame. The renderer that
travels with a published project is a second reader of the same file: `site-cli.ts` validates by hand
rather than through `playableSchema` and is committed into the author's repository as
`.vnstudio/pages/vn-site.mjs` ([`../guides/github-pages.md`](../guides/github-pages.md)), so a new
beat field has two consumers to update and one of them lives in somebody else's git history.

`renderSite` (packages/export/src/site.ts) renders the playable as a light-novel site with the cast
listed as portraits in their own section, and its comment says a light novel has no place to overlay a
portrait on a frame. That is correct for a light novel and wrong for a comic, where a page is panels.

`Frame` in apps/desktop/renderer/pathux/play/playback.ts still names the full shot image `bg`. The
field is background vocabulary describing something that is the whole picture. Renaming it is cheap
and changes no behaviour, but the name is what a reader of that module learns the format from.

The P3 portrait is prompted for a plain neutral background and head-and-shoulders framing, so it is an
opaque plate rather than a keyed cutout. Nothing in the repository produces an asset with an alpha
channel. That is only a problem for the light-novel path, which is why it stayed unbuilt.

## What the style would actually need

### Shot size is four words, and one of them names a job

`framing` is declared twice and both declarations must agree: the TypeScript union at
packages/types/src/entities.ts:188 and the zod enum `shotFraming` at packages/types/src/schemas.ts:366,
both `'wide' | 'medium' | 'close' | 'establishing'`.

Three of those four are sizes. `establishing` is a purpose. A shot can be an establishing shot at any
size, and a wide shot that is not establishing anything is a common enough beat that the decomposer's
own system prompt has to pick one word for both. [`shot-framing-systems.md`](shot-framing-systems.md#the-evidence-says-use-a-small-discrete-vocabulary)
already raises the conflation and argues, on evidence from several independent systems, for keeping
the vocabulary small and discrete rather than opening it up to free text. This report agrees with the
argument and extends the reason: because the framing word is literal prompt text, it is inside the
task hash, so the enum is a dedupe boundary as well as an authoring one. Splitting `establishing` out
into its own field is therefore a re-render of every establishing shot in every project, not a
refactor.

Camera angle and level exist today only as `Shot.camera`, an unvalidated string. It reaches the prompt
as one clause and it also reaches the reviewer, because `shotDescription`
(packages/artgen/src/prompts.ts:495) appends `Camera: ${shot.camera}.` to the spec every reviewer is
handed. That second path matters more than it looks, and it is where this report parts company with
the survey's second recommendation. The survey proposes promoting angle and level to enums without
expecting to verify them. Promoting them is right. Leaving them in `shotSpec` is not, because the
same survey measures shot-scale classification at about 0.80 F1 on animation against 0.61 and 0.68 for
angle and level ([`shot-framing-systems.md`](shot-framing-systems.md#the-domain-gap-is-real-and-it-is-uneven)),
and reports the best of twenty-four vision-language models scoring 55.2% on composition
([`shot-framing-systems.md`](shot-framing-systems.md#vision-language-models-are-weak-at-cinematography-which-is-the-reason)).
A property the reviewer cannot judge, placed in the spec the reviewer judges against, buys blocking
defects that the refine loop cannot resolve. The two code paths are already separate functions reading
the same `Shot`, so routing a field into `buildShotChunks` and out of `shotSpec` costs one line.

### Nothing records where a character stands in the frame

`ShotSubject` (packages/types/src/entities.ts:216) carries `characterId`, `outfit`, `pose` and
`expression`. `buildShotChunks` joins the subjects into one sentence: `Subjects: Aiko, wearing school
uniform, pose: leaning, expression: wary; Haruki, wearing uniform.` The sentence is a list with no
geometry in it.

Anime dialogue coverage is mostly geometry. An over-the-shoulder pairs a near figure at one edge with
a far figure at the other. An eyeline match requires the two singles that flank a cut to look in
opposite directions. A two-shot that holds while one character turns away depends on which side of
frame each of them started on. None of that is expressible today, and it is the part of the style that
a reader notices when it is wrong, because a cut that breaks the line of action reads as a mistake
rather than as a stylistic choice.

The survey's Toric-space material and its Architecture B
([`shot-framing-systems.md`](shot-framing-systems.md#architecture-b--2d-instance-layout-with-masks))
are the published answers to exactly this, and both assume a conditioning path that accepts a layout
signal. This repository has no such path. `ImageParams` (packages/types/src/entities.ts:36) carries
`modelId`, `aspect`, `seed` and `extra`, with no mask and no control map, and the Gemini image backend
maps every reference to an image part with no strength dial. So screen placement here can only be
words in a prompt, at least until the provider seam grows a control input. Words are worth having
anyway — a placement clause is checkable by a detector even when it is unenforceable at generation
time — but this report does not claim they will reliably produce the layout they ask for.

### Aspect belongs to the project rather than to the shot

`imageParams(config)` (packages/artgen/src/prompts.ts:31) reads `config.image_params.aspect`, which
defaults to `'16:9'` (packages/types/src/schemas.ts:307), and hands the same value to every image kind.
A shot cannot ask for a tall panel next to a wide one.

Mixed panel shapes are close to the definition of a manga page, so this is the gap most specific to
the style and the cheapest to close. `aspect` already sits inside `params`, which is already inside the
task hash, and `seedFor` (packages/artgen/src/prompts.ts:50) is the exact precedent for how to add a
narrower rung without disturbing existing hashes: a rung that authored nothing returns the params
object untouched, so a project that authors no per-shot aspect keeps every hash it had.

### A full-body frame is drawn from a head-and-shoulders reference

This is the finding most likely to be worth acting on immediately, and it is independent of everything
else in this report.

The planner generates three model sheets — front, side and back, from `MODEL_SHEET_ANGLES` — for every
outfit `usedOutfits` reports, and `usedOutfits` (packages/model/src/used.ts:48) seeds every character
with their `defaultOutfit` first. So a run pays for three full-body turnaround sheets of every approved
character in their default clothes.

The shot planner then attaches none of them. `if (outfit.id === character.defaultOutfit) continue;` at
packages/pipeline/src/planner.ts:262 skips the sheet for exactly the case that covers most shots in
most projects, on the stated reasoning that the portrait already shows the default outfit. The portrait
does show the outfit. It shows it from the chest up, on a plain neutral background, because that is
what `buildPortraitChunks` asks for. A wide shot of a character standing in a location is therefore
generated from a head-and-shoulders reference and a background plate, with the entire body below the
collarbone left to the model.

For a light-novel look this barely matters, because the portrait overlay is the character and the shot
is scenery behind them. For a style where every frame stages the whole figure it is the dominant
consistency risk, and the survey's finding that character scale across shots is the one genuinely
unquantified property ([`shot-framing-systems.md`](shot-framing-systems.md#there-is-no-validated-automated-metric-for-whole-character-consistency))
says nothing downstream will catch it. The fix attaches an asset that already exists and has already
been paid for. Its cost is not generation; it is that adding a reference changes `refs`, which changes
the task hash, which re-renders every shot in every project. That cost is real and is priced in the
staged path below.

The angle-matched version of the same fix — attaching the side or back sheet when the shot's camera
calls for one — needs an angle field to select on, which is the enum promotion above. The two changes
compose.

## What it costs

This is the argument that decides the question, so it is worked rather than asserted.

### Shot count, worked against a real scene

The deterministic baseline is one establishing shot carrying the whole cast plus one medium shot per
character in the scene (`deterministicShots`, packages/artgen/src/storyboard.ts:48). The model path
lands near the same number by construction, because `DECOMP_SYSTEM` instructs the model to cover the
scene with as few shots as tell it clearly.

templates/basic/scenes/rooftop.md is a two-hander with seven lines: three of action and narration, and
four of dialogue alternating between Aiko and Haruki. The baseline decomposes it into three shots —
one establishing over L1, L4 and L7, one medium of Aiko over L2 and L5, one medium of Haruki over L3
and L6.

Storyboarded the way an anime episode would cover the same page, it is roughly: an exterior
establishing, a wide two-shot at the fence, a single for each of the four dialogue lines, a cut-in on
Haruki's glance at L4, and a closing two-shot on the smile at L7. That is seven to nine shots against
a baseline of three. The multiplier is driven by the number of exchanges rather than by the number of
characters, which is why it does not shrink on longer scenes: a three-hander raises the baseline by one
and raises the storyboard by however many more times the conversation turns.

Call it 2.5× to 3× at the storyboard level, and note that the baseline is generous to the style — a
scene with one speaker and six lines of narration is two shots today and could reasonably be six.

### Attempts per shot, and why a framing check raises them

`costPreview` (packages/pipeline/src/pipeline.ts:48) counts `maxAttempts` image calls per pending
`shot_image` task and `maxAttempts × reviewers` review calls, with `max_refine_attempts` defaulting to
4 and `models.vision` defaulting to two entries. So one shot's upper bound today is four image calls
and eight review calls, and the doc comment says the actual run usually costs less because most shots
pass on the first attempt.

A tighter framing specification moves that mean upward, for a mechanical reason. Every field added to
`shotSpec` is another axis on which a reviewer can file a blocking defect. `refinePrompt`
(packages/pipeline/src/p6.ts) is deterministic string surgery with no model call, and the loop's early
give-up fires only when the refined prompt comes back byte-identical to the previous one, which
requires the merged defect list to be byte-identical across two attempts. Free-form geometric critiques
from a vision model are unlikely to repeat verbatim, so the early stop is unlikely to fire and the shot
burns the full cap before landing `needs_human`.

The survey's evidence says the extra attempts buy less than they cost. No published closed-loop image
system verifies shot scale, crop, headroom or camera height
([`shot-framing-systems.md`](shot-framing-systems.md#what-the-closed-loop-systems-actually-verify)),
and the practitioner reroll rate it reports is two to four generations per usable image
([`shot-framing-systems.md`](shot-framing-systems.md#what-the-practitioner-community-actually-does)).
The survey's own first recommendation follows from this and this report endorses it: put a geometric
measurement in the loop rather than more prose in the spec, because a detector's answer is stable
across attempts and a language model's is not.

### The multiplier

Multiplying the two terms: 2.5× to 3× the shots, times a mean attempt count rising from something
like 1.3 toward 2.5 or 3 if framing critique enters the loop without a stable measurement under it,
gives roughly 5× to 7× the image calls of today's default path, and the same multiple again on review
calls scaled by the number of configured vision models. A framing check that is a detector rather than
a prompt keeps the second term near where it is, which brings the whole change back to about 3×.

That difference — 3× against 6× — is the practical argument for building the measurement before
building the vocabulary that would depend on it.

One further multiplier is latent rather than active. `candidates` is declared in the config schema with
a default of 3 (packages/types/src/schemas.ts:319) and is read nowhere in the pipeline. Any future
generate-several-and-choose behaviour would multiply everything above by that number, so it is worth
knowing the knob is sitting there unwired before someone wires it.

### What `vngen cost` can and cannot answer

`vngen cost` runs the real planner with mock providers and prints an upper bound in calls. Two
limitations matter for a decision of this size.

It counts the graph as it stands, and the planner runs once per wave, so a project whose P3 character
gate has not opened reports zero shot tasks. The contract is stated in
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) and it means the number an
author sees before approving anything is not the number they will pay.

There is no price per image anywhere in the repository. `costPreview` returns call counts, the desktop
equivalent in apps/desktop/src/main/commands/pipeline.ts prints the same counts, and the only
money-adjacent constants in the tree are the authoring agent's token budget ladder in
packages/types/src/budget.ts. So the author cannot convert a 3× or a 6× into currency inside the app.
[`a-less-technical-mode.md`](a-less-technical-mode.md) reached the same conclusion from a different
direction and named it the accelerator before the fuel gauge; a change that multiplies image calls is
the strongest argument yet for a price table.

## Which contracts survive and which are strained

Survive untouched: task identity as `sha256(kind, inputs)`, the two content-addressed asset roots
([`../reference/asset-stores.md`](../reference/asset-stores.md)) since a shot frame routes to the
project root however it was framed, the P3 approval gate as a planner predicate, explicit decomposition
and the rule that a missing `work/shots/<sceneId>.json` is the only signal meaning decompose this scene,
outfit inheritance through `outfitFor`, line-id allocation, and the round-trip guarantee on scene prose.
Nothing in this report touches the parser or the writers.

The slot graph survives as a shape and grows as a population. `refsOfSlot`
(packages/artgen/src/refcycle.ts:190) derives a shot's edges from its plate and its subjects, so more
shots means more `shot:` nodes rather than a new slot kind. The constraint that survives and must keep
being honoured is that `shotUpstream` in packages/artgen/src/slotgraph.ts and the planner's own
reference assembly enumerate the same set; packages/pipeline/src/tests/slotagreement.test.ts is what
catches a divergence.

Drift reporting improves rather than strains. `proseHash` covers the lines a shot claims, so finer
coverage means a single edited line invalidates one shot instead of a third of a scene.

Two things are strained.

Task identity gains inputs. Every framing property added to the prompt widens the hash, which is
correct behaviour for an authored art-direction field and is exactly how `artNotes` and `seed` already
work. The consequence to state plainly is that there is no cross-shot dedupe to lose, because
`shot_image` inputs carry `shotId` and every shot is therefore its own hash regardless of how similar
two shots are. A wide and a cut-in of the same moment share no work today and will share none after
this change, even though a cut-in is geometrically a crop of the wide.

That last observation points at a task kind the repository does not have. `ImageProvider` declares both
`generate` and `edit`, and `runModelSheet` already uses `edit` with a prior task's output as the base,
so the seam for deriving one image from another exists and is in use. The shot runner uses `generate`
only. A re-frame task that crops or re-stages from an accepted frame would be the first shot-side use
of that seam, and the survey prices the closest published equivalent at 5.16 against 8.35 on
OmniContext ([`shot-framing-systems.md`](shot-framing-systems.md#inserting-the-cast-into-a-rendered-plate-not-yet-and-the-seam-is-already-there)),
which is discouraging enough that this report does not recommend it yet.

Coverage refusals get more frequent. The first shot covering a line wins, and the desktop coverage
timeline refuses double coverage rather than hiding the second frame
([`../reference/desktop-app.md`](../reference/desktop-app.md)). Denser storyboards mean more shots
competing for the same lines, so an author will meet that refusal more often. The refusal is correct
and should stay; the surface for resolving it is what will need attention.

## Consistency

Four mechanisms already carry identity across frames, and they carry it unevenly for this style.

Plates hold. `shotInputs` puts the location plate first in every shot's reference list, so five cuts
inside one room all reference the same rendered background. Denser cutting benefits from this directly
and needs nothing new.

Portraits hold faces and lose bodies, for the reason given above: they are prompted head-and-shoulders
on a neutral ground. Model sheets hold bodies and are not attached in the common case. That is the
gap.

The refine loop holds presence and not geometry. `shotSpec` states who must be in frame and
`REVIEW_SYSTEM` makes `characters` the authority on it, which is a real check that works. Nothing
measures how large a character is drawn, and the survey is explicit that no validated automated metric
for whole-character consistency exists, that DINO agrees with human preference 50.72% of the time, and
that the story-visualization benchmarks crop characters to compare identity and then discard the
bounding boxes — measuring who and never how big. Manga coverage cuts between sizes of the same
character constantly, so the property nobody measures is the property this style stresses hardest.
This report agrees with the survey's diagnosis and adds that the consequence is more severe here than
in its own framing, because the survey treats scale as a per-shot authoring concern while a cut makes
it an inter-shot one.

What would be genuinely new is a scale measurement across a scene's shots rather than within one:
detect the character, take the bounding-box height as a fraction of frame height, and check it against
what the shot's declared size implies. Shot-scale classification survives the animation domain gap at
about 0.80 F1 where camera angle and level do not, so scale is the one framing property where a
detector is worth building
([`shot-framing-systems.md`](shot-framing-systems.md#shot-scale-and-camera-angle-can-be-measured-automatically)).

## One mode, not two

A project-level mode is the wrong shape, for three reasons.

There is nothing to switch between. The full-frame path is the default and `portrait_overlay` is
already the opt-in for the other look, so a manga mode would be a third setting layered over a binary
that already covers the question the todo asks.

A mode doubles every contract it touches. The decomposer's system prompt, the reviewer spec, the
playable schema, the desktop runner and the committed site renderer would each need a branch, and the
site renderer is committed into an author's repository, so its branch would ship to machines nobody
here controls.

The differences that matter are per-shot properties. Size, angle, aspect and staging vary within a
page, and mixing them is what the style is. A mode would apply one setting to every frame in the
project, which forbids the mixing rather than enabling it. Putting the properties on `Shot`, where
`artNotes` and `seed` already live, lets an author mix them and lets the agent reach them through the
same rung machinery `rungsFor` already exposes.

The recommendation is therefore: no mode, no new presentation path, and no second decomposer. Spend
the effort on making one frame controllable and on measuring what comes back, and leave shot density
to the author and to the decomposer's prompt, which is one string in
packages/artgen/src/storyboard.ts.

## A staged path

Each stage is green on its own and none depends on a later one.

Stage 1 attaches the front model sheet to every subject rather than only to subjects in a non-default
outfit. The sheets already exist and were already paid for. The change is one condition in the planner
plus the mirrored condition in `shotUpstream`, and packages/pipeline/src/tests/slotagreement.test.ts
enforces that both move together. The cost is a re-render of every existing shot, because `refs` is in
the hash; that is the same class of cost the repository already accepts for an outfit change, but it
should be announced rather than discovered.

Stage 2 promotes camera angle and level out of `Shot.camera` into optional enum fields, emitted as
their own prompt chunks and deliberately kept out of `shotSpec`. Optional fields that emit no chunk
when absent leave every existing hash untouched, which is the property `artClause` and `seedFor` were
both built to have. `Shot.camera` stays for anything the enums do not cover.

Stage 3 adds an optional per-shot `aspect`, resolved through a helper shaped exactly like `seedFor`
and defaulting to `config.image_params.aspect`. Shots that author none keep their hashes. This is the
smallest change with the most style-specific payoff, and it is the one that makes panels possible at
all.

Stage 4 adds the geometric shot-scale check to the P7 loop: detect the subject, compare the
bounding-box height fraction against what the declared framing implies, and file a defect from the
measurement rather than from a language model's opinion. This is the survey's Architecture A
([`shot-framing-systems.md`](shot-framing-systems.md#architecture-a--enum-plus-text-with-a-geometric-check))
and its first recommendation
([`shot-framing-systems.md`](shot-framing-systems.md#four-changes-in-order-of-value)). It is the stage
that keeps the cost multiplier near 3× instead of near 6×, so it should land before anything that adds
axes to the spec.

Stage 5, only if the first four land and panels are still wanted, adds screen placement to
`ShotSubject` and carries it through `showBeatSchema` to the runner. This is the expensive stage and
the one to defer: it touches a schema pinned at `version: z.literal(1)`, the desktop `Frame` type, the
Play editor's layout, and the site renderer committed into author repositories.

Splitting `establishing` out of `framing` is deliberately not staged. It re-renders every establishing
shot in every project for a naming improvement, and stage 2's angle field covers most of what an
author would have reached for.

## What it costs to undo

Stages 2 and 3 undo cleanly. Both add optional fields that contribute no prompt chunk and no params
change when absent, so deleting the field restores byte-identical prompts and the original task hashes.
`shotsFileSchema` is a plain `z.object` with no `.strict()`, so an abandoned key in an existing
`work/shots/<sceneId>.json` is dropped on the next read rather than refused. Nothing has to be
regenerated.

Stage 1 undoes by reverting the condition, and costs a second full re-render — the money is spent
twice, once going and once coming back. It is the stage to be most sure about before starting.

Stage 4 undoes by deleting the check. Its risk is not reversibility but the runs made while it was
wrong: a miscalibrated scale threshold files blocking defects the refine loop cannot clear, and every
affected shot burns its full attempt cap before landing `needs_human`. Calibrate against existing
accepted frames before it gates anything.

Stage 5 is the expensive undo. A field added to `showBeatSchema` without bumping `version` is ignored
by an older reader, which is benign, but the site renderer is a copy committed into the author's
repository, so undoing means every project that ran `project.installPages` carries a stale bundle until
someone re-installs it. That asymmetry is the reason to defer the stage rather than to sequence it
earlier.

## What could not be verified

There is no `examples/` directory in this worktree, so every shots-per-scene figure here is derived
from `deterministicShots` and from templates/basic rather than measured against a real run. Other
research in this repository cites `examples/test4`, so the measurement is available elsewhere and would
be worth taking: the honest version of the cost argument is a histogram of shots per scene and attempts
per shot over a project that actually ran.

The mean attempt count today is an assumption. `costPreview` reports only the upper bound, and nothing
in the repository aggregates `task.attempts` into a distribution. The 1.3 used above is a guess
consistent with the doc comment's claim that most shots pass on the first attempt; the argument's shape
does not depend on the exact figure, but its size does.

No price per image exists in the tree, so nothing here converts to money.

Whether a vision reviewer would file useful geometric defects at all is untested here, and the survey's
evidence points against it. That is the reason stage 4 specifies a detector rather than a prompt, and
the reason the report does not recommend adding framing properties to `shotSpec`.

Whether the Gemini image backend honours a per-shot aspect that differs from the project default was
not exercised. The parameter is passed through `ImageParams` and the schema accepts any string, so the
failure mode if a value is refused would be a provider error rather than a silent wrong-shaped image,
but that has not been confirmed against a live call.

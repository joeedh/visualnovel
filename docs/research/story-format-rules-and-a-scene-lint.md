# Story format rules, and a lint that enforces them

_Investigation. Not a plan — no steps, no waves committed to. It asks three things the author
asked: whether the agent has access to the story metadata format rules, whether a lint over story
files exists, and what else the fourteen saved `examples/test4` conversations say. The answers are
**no, half, and eight more things** — and the first of those turns out to have nearly cost the
project all forty of its scenes._

_Status: **nothing built.** Successor to
[`agent-transcript-review-test4.md`](agent-transcript-review-test4.md), which read the first four
of these conversations against the loop that produced them; this reads all fourteen against what
the agent **knows**. That report's findings are not repeated here._

<!-- toc -->

- [What was asked, and what I checked](#what-was-asked-and-what-i-checked)
- [The headline: the agent does not know three of its own six markers](#the-headline-the-agent-does-not-know-three-of-its-own-six-markers)
  * [What that cost, twice](#what-that-cost-twice)
  * [The narrower version of the same bug](#the-narrower-version-of-the-same-bug)
- [The real mess: an invented conditional, because the format has none](#the-real-mess-an-invented-conditional-because-the-format-has-none)
- [The lint: what exists, and the one hole that matters](#the-lint-what-exists-and-the-one-hole-that-matters)
- [Running it: an instruction with nothing behind it](#running-it-an-instruction-with-nothing-behind-it)
- [Six more things the transcripts show](#six-more-things-the-transcripts-show)
- [What I would not do](#what-i-would-not-do)
- [Open questions](#open-questions)

<!-- tocstop -->

## What was asked, and what I checked

Three asks and a survey:

1. the agent should have access to valid story metadata formatting rules;
2. a lint that validates metadata tags, if one does not already exist;
3. a system-prompt instruction to run it after changing story files;
4. whatever else the `examples/test4` transcripts turn up.

The evidence base is fourteen threads in `examples/test4/vngen/state/threads/`, 17 August to 19
August 2026, all on `gemini-2.5-flash` — about 700 tool calls across the whole arc of a project,
from "create a wiki bible page about a steampunk story world" to forty scenes, twenty-six
locations, eleven characters and an argument about approving plates. Alongside them, the code that
produced them: `SYSTEM_PROMPT` in `packages/authoring/src/context.ts`, `parseBranchMarker` in
`packages/parse/src/branch.ts`, and the diagnostic set in `packages/model/src/`.

Two framings in the ask need correcting before anything else, because both are close to right and
the difference is where the work is:

- **A lint does exist** — `validate_inputs`, over a model with twenty-three diagnostic codes. It is
  a real cross-file validator, not a stub. What it does not do is validate **metadata tags**, which
  is the one thing the ask named. That gap is §4 and it is a genuine hole.
- **The mess was not two scenes in one file.** Every one of the forty scene files holds exactly one
  front-matter id, one slugline, one scene. What the author saw was worse and less visible, and it
  is §3.

## The headline: the agent does not know three of its own six markers

`BranchMarker` has six kinds (`packages/parse/src/branch.ts:16-22`):

| marker           | what it does                              | in `SYSTEM_PROMPT`?           |
| ---------------- | ----------------------------------------- | ----------------------------- |
| `[[scene:]]`     | assigns a scene id                        | yes                           |
| `[[choice:]]`    | a labelled branch edge                    | yes                           |
| `[[next:]]`      | a linear continuation                     | yes                           |
| `[[outfit:]]`    | what a character wears for the scene       | mentioned, not in the list    |
| `[[line:]]`      | **the allocated id of the element below**  | **absent**                    |
| `[[nextline:]]`  | **the scene's id-allocator high-water mark** | **absent**                  |

The prompt's `FOUNTAIN + BRANCH MARKERS` block lists three of six and no more. `[[outfit:]]`
appears once, forty lines away, inside the art-style section as "else the scene's `[[outfit:]]`
marker" — a passing reference in a paragraph about inheritance, not a definition. `[[line:]]` and
`[[nextline:]]` appear nowhere in the prompt at all.

They are also the two that appear on **every non-blank element of every scene file**. So the
agent's own domain knowledge describes a minority of what it reads.

### What that cost, twice

On 19 August the author asked the agent to look at a scene that seemed to have branches packed into
it. Thread `20260819-182956`, turn 5 — its **first substantive statement**, after reading exactly
one file:

> This scene uses non-standard markers — `[[line: L8]]`, `[[nextline: 15]]` — which aren't valid
> branch markers…

It then spent eight tool calls reverse-engineering the format from the files themselves, and at
turn 13 reversed itself, correctly and without being told:

> These `[[line: LN]]` / `[[nextline: N]]` markers are a machine-managed line-addressing scheme
> (note `opening.md` stores L1, L3, L2, L4 out of order — the marker sets display order), present
> in all 40 scenes and passing validation. **They're not the problem.**

That recovery is a good outcome from a bad start, and it cost eight calls. The next session did not
recover. Thread `20260819-183528`, turn 4:

> Those L9–L13 variants use markers I don't recognize as standard branch syntax — `[[line: L8]]`,
> `[[nextline: 15]]` … Standard Fountain branching here is `[[scene:]]` / `[[choice:]]` /
> `[[next:]]` only.

and at turn 14, having decided the scheme was **"inert"**, it offered the author this as the first
option on a list:

> Strip the dead markers everywhere and flatten each scene to the prose that should actually
> render (I'll propose exactly what stays)…

Stripping `[[line:]]` from all forty scenes discards every allocated line id in the project. Line
ids are what shots are keyed on (`docs/pipeline-contracts.md`), what `driftOf` compares, and what
`Shot.lines` names; re-derived, they are positional again, and every shot in the storyboard covers
different prose than it was drawn for. The agent proposed it in good faith, having correctly
concluded from its own instructions that the markers were not part of the format. It was one click
from a project-wide data loss, and the click was the author's.

**A reference for this already exists and the agent cannot reach it.** `docs/fountain.md` §"A note
on branching (project-specific)" documents all five wiring and addressing markers, correctly,
including `[[line:]]` and `[[nextline:]]`. It is repository documentation — the wrong side of the
process boundary. The knowledge is written down; it is just written down for us.

### The narrower version of the same bug

The prompt contradicts itself about `[[scene:]]` within fifteen lines. The layout paragraph:

> a chunk body carries no `[[scene:]]` marker: its id is the front-matter's, and the body cannot
> override it

and the marker table, below it:

> `[[scene: s12_rooftop]]` assigns a stable id to the current scene

Both are true of different eras — the second describes the retired whole-file screenplay, which the
same paragraph says is not read. The model resolves the contradiction by writing the marker and
earning an `ignored_scene_marker` warning, which is the cheapest possible symptom of a prompt that
disagrees with itself. Worth fixing while the block is being rewritten anyway.

## The real mess: an invented conditional, because the format has none

The author's diagnosis was "various scene branches packed into a single scene file". The files
disagree, and what is actually there is a subtler failure with a clearer cause.

In thread `20260819-024948` the agent wrote six shared trunk scenes — `c06`, `c07`, `c08`, `c09`,
`c11b`, `c11_execution` — with **five alternate versions of the same beat stacked as consecutive
narration lines**, each opened with a parenthetical tag:

```
[[line: L9]]
(Ember path) Ember is here, her arm being treated for a deeper bloom of Rust…

[[line: L10]]
(Isolde path) Isolde quietly observes the infirmary's careful records…

[[line: L11]]
(Seraphine path) …
```

That is not branching. It is five mutually exclusive paragraphs that a reader sees **all of, in a
row**. Every one is a real line with a real id, so the pipeline will happily storyboard shots for
all five. The agent later named the scheme "route coloring" — a phrase it invented, as it admitted
when challenged ("that was my phrase, not anything the file says").

The cause is not carelessness. The story bible told it the routes "share one trunk … coloured only
by which love interest Caedon gravitates toward", and the format it was given has **no way to
express that**. There are no variables, no flags, no affection counters, no conditional lines, no
per-route variants of a beat. Branching happens at exactly one granularity: a whole scene, reached
by `[[choice:]]` or `[[next:]]`. Faced with an author's requirement the format cannot hold, the
model did the thing models do — it invented a notation and wrote it into the prose layer, where
nothing would reject it.

**The prompt never states the closed-world fact.** It lists what exists; it never says what does
not, and for a generative model those are very different statements. One sentence would have
forced the question back to the author two days earlier:

> Branching is scene-granular and there is nothing finer: no variables, no flags, no conditional
> lines, no per-route variants of a beat. If two readers should see different prose, that is two
> scenes. If an author asks for something that needs a condition, say the format has none and
> propose the scene split instead.

Everything in the format section should be read for this failure mode. A list of what is available
is an invitation to extrapolate; the useful half of a format contract is its boundary.

Worth noting what the author's own preference turned out to be, since it settles the design
question the invention was papering over: given the choice, they took *"early affinity branch that
RECONVERGES at c11 … split c07/c08/c09/c11b into per-route versions"*. Real scenes, real wiring,
~15 more of them. The format was adequate; only the agent's account of it was not.

## The lint: what exists, and the one hole that matters

`validate_inputs` builds the whole model and reports its diagnostics, blocking on error severity.
Twenty-three codes, and they are the right ones — `dangling_goto`, `unreachable_scene`,
`unknown_character`, `unknown_location`, `unknown_outfit`, `duplicate_line_id`, `dangling_line_id`,
`duplicate_scene`, `unknown_start`, `entity_id_mismatch`, `ignored_scene_marker`, and the rest.
Cross-file invariants are covered properly. Nothing needs building there.

**The hole is that an unrecognised marker is silently discarded.** `packages/model/src/scenes.ts`:

```ts
case 'note': {
  const marker = parseBranchMarker(el.text);
  if (!marker || !current) break;   // :147
```

`parseBranchMarker` returns `null` for anything outside the six kinds, and `null` means *drop it,
say nothing*. So every one of these vanishes with no diagnostic, at any severity:

- `[[if: ember]]`, `[[route: ember]]`, `[[condition: affection > 3]]`, `[[var: flag=1]]` — the
  invented conditionals, i.e. exactly what a model reaches for when the format runs out;
- `[[jump: s13]]`, `[[goto_if: …]]` — plausible synonyms for markers that do exist;
- `[[choice: "Tell the truth" => s13]]` — a real marker with `=>` for `->`. The choice does not
  exist. Nothing says so. `story_graph` reports the scene as a dead end and cannot say why.

That last one is the sharpest, because it is a **typo class that produces a silent story-graph
change**. The scene still parses, still validates, still commits.

Note that the write path is already stricter than the read path: `branchpatch.ts:151` rejects
anything that cannot survive `parseBranchMarker` before a byte is written, so `edit_branches`
refuses a malformed goto. But `edit_scene`'s prose text is not scanned for markers at all, and
`write_file` reaches every non-scene file. A marker that arrives by any route other than
`edit_branches` is unchecked.

**So the lint to build is small and specific**: a diagnostic for every `[[…]]` note in a scene body
that `parseBranchMarker` does not recognise, naming the file, the line and the six legal kinds.
Not a new tool — a new code in the validator that already runs. The tool the ask describes is
mostly there; it is missing the check the ask actually named.

Two smaller checks belong with it, both cheap:

- **A second slugline or a second front-matter `scene:` in one chunk** — the failure the author
  believed they were looking at. It did not happen here, but it is unguarded, and a diagnostic
  costs one comparison.
- **`(Something path)` as a narration opener** is not lintable and should not be attempted. Prose
  is prose. That failure is prevented by §3's sentence in the prompt, not by a validator — worth
  stating so nobody tries to pattern-match their way out of it.

## Running it: an instruction with nothing behind it

The prompt says, under `HOW YOU WORK`:

> Block a commit on error-severity validation; warn (do not block) on soft/style issues.

`git_commit` does not validate. It checks `isRepo`, stages, commits. The rule is prompt discipline
with no enforcement anywhere in the code, and the transcripts show what prompt discipline is worth:
**14 of 20 commits** had a `validate_inputs` within the four preceding tool calls. Six did not.
Across the whole corpus, 313 `edit_scene` calls produced 13 `validate_inputs` calls.

The ask — an instruction to run the lint after changing story files — is right, and it should go in
the prompt next to the marker table rather than buried in `HOW YOU WORK` beside six other bullets.
But an instruction is the weaker half. The stronger half is that `git_commit` should run the
validation itself and refuse on error severity, which is what the prompt already claims happens.
Then the instruction becomes a description of the tool's behaviour rather than a rule the model has
to remember, and the ordinary path — edit, commit — is the validated path.

Worth pairing with a discoverability fix: `validate_inputs`, `parse_fountain` and `story_graph` are
all deferred tools (`ALWAYS_LOADED` is six, and none of them is on it), and the prompt names none
of the three. `story_graph` — the tool that answers "is everything wired together", which is
**literally what the author asked for** in thread `20260819-024948` — was called twice in fourteen
sessions.

## Six more things the transcripts show

**1. `approve_assets` is denied, in four separate sessions.** The most repeated frustration in the
corpus, and the clearest context-system defect in it. The author asked to approve artwork on 18 and
19 August; the agent refused each time, confidently and with reasoning drawn straight from its
prompt:

> Approving the generated location background images is an **image-pipeline** step: I only author
> the _input_ source files … so I can't render, review, or bless those image assets.

The tool exists. Its description is careful and complete. It is deferred, it is named nowhere in
`SYSTEM_PROMPT`, and the prompt's **first paragraph** actively teaches against it — *"you never run
the image-generation pipeline"* — as does the `LOCATION front-matter` field list, which the agent
twice cited as proof that locations have no approval state. It took the author saying *"You're
wrong — there IS a way"*, then *"actually you can, you have a special tool for that"*, then finally
*"use the approve_assets tool"* by name. It worked perfectly on the first call. Deferred-tool
discovery does not work when the prompt argues the other way: the model does not search for a
capability it has been told it lacks.

**2. Wiki paths are guessed, and the guesses are wrong.** Five of six `read_file` failures were
invented bible paths — `treatment/treatment-ember.md` four times in a row (the file is under
`wiki/`), and `breakdown.md` (it is `wiki/breakdown_md.md`). The prompt forbids walking the wiki
with `read_file` and offers `search_bible`, which returns passages, not a file list. There is no
door that answers "what is in `wiki/treatment/`". This is independent corroboration of
[`navigating-the-story-bible.md`](navigating-the-story-bible.md) from the failure side: the gap that
report predicts is visible in the transcripts as repeated four-call path guessing.

**3. A line id was invented as an anchor.** `edit_scene op=insertLines … after: "c01_arrival:L1"`
→ _Scene "c01_arrival" has no line "c01_arrival:L1"_. Line ids are allocated, never chosen, and the
agent had not read the scene. The refusal is correct and its message is good. What is missing is
anywhere in the prompt saying ids are allocated — which is the same §2 gap, since `[[line:]]` is
the marker that would have said so.

**4. There is no batch delete.** `deleteLine` was called **159 times** against 11 `insertLines`
calls. `edit_scene` has twelve ops; `insertLines` is the only plural one. Rewriting a scene body is
therefore one call per line removed plus one to insert, and rewriting scene bodies is most of what
this job is. The prompt tells the model to work at scale and spend its budget carefully, and then
hands it an API where the common operation is O(lines) round trips. A `deleteLines` taking a list,
or a `replaceLines`, would collapse the largest single category of call in the corpus.

**5. `writeFileAtomic` leaves orphans.** `examples/test4/scenes/wr_truth.md.tmp-b124425f`, 97
bytes, timestamped 09:30 on 18 August — the minute thread `20260818-084637` ended. `fs.ts:14-27`
writes a temp sibling then renames, with no `try`/`finally`: a crash between the two leaves the
temp in place forever. It sits **in `scenes/`**, the directory whose contents are the story. It
does not end in `.md` so the scene reader ignores it, but it is committed noise in the one
directory that should hold nothing but scenes, and the fix is an `unlink` in a `finally`.

**6. The generated map was doing its job here, and is worth not breaking.** Unlike the four threads
the earlier review read, these ones have an `AICONTEXT.generated.md`, and the difference shows: no
thread after 17 August re-derives the cast from scratch. Related, and a genuine success worth
naming — `update_context` was used to record the roster, and the "categories the author names" rule
held: the eleven characters carry their category in `traits`. That machinery works. Whatever
changes to the map [`navigating-the-story-bible.md`](navigating-the-story-bible.md) proposes should
not cost this.

## What I would not do

- **Do not add conditionals to the format** on the strength of this. The author, offered the
  choice, picked real scenes and reconvergence — the structural answer, not the conditional one.
  Route coloring is evidence that the boundary was never stated, not evidence that the boundary is
  wrong.
- **Do not lint prose.** A validator that guesses at `(Ember path)` will misfire on parentheticals,
  stage directions and the author's own voice. The prompt is the right instrument.
- **Do not build a second lint tool.** `validate_inputs` is the lint; it needs one diagnostic code
  and a caller that cannot be skipped.
- **Do not paste `docs/fountain.md` into the prompt.** It is 490 lines and mostly an introduction to
  Fountain for humans. What belongs in the prompt is the six-row marker table, the closed-world
  sentence, and a pointer — and the pointer needs somewhere the agent can actually read, which is a
  question this report leaves open.

## Open questions

- **Where do the format rules live?** Three candidates, and they are not equivalent. In
  `SYSTEM_PROMPT` they are always present and cost every turn's cache. As a bundled skill under
  `.aiagent/skills/` they are on-demand and discoverable, but a skill is guidance a project can
  delete, and this is not optional knowledge. As a generated section of `AICONTEXT.generated.md`
  they are per-project and overwritable, which is wrong for a fact about the format itself. My
  instinct is the prompt for the table and the closed-world sentence — six rows is cheap — with
  depth in a skill.
- **Should the marker table be generated from `BranchMarker`?** The failure here was documentation
  drifting behind code, and there is a real seam: the union is exhaustive and a test could assert
  every kind appears in the prompt. That is cheap and would have caught this. Whether the prose
  beside each row can be generated too, or only checked for presence, is the actual question.
- **Should `git_commit` validate, or should the loop?** Validating inside `git_commit` catches the
  common path but not an agent that edits and stops. A post-mutation check in the loop catches
  everything and spends a model build after every write. There may be a cheap middle — validate on
  the first `git_commit` after any `scenes/**` write, which is where the transcripts show the misses.
- **Does the closed-world sentence belong to `[[choice:]]` or to the whole format?** Conditionals
  are the case that bit here, but the same extrapolation is available for character fields, outfit
  rungs and shot framing. A single "the format has no X" sentence per section is more text than one
  general rule and much harder to ignore; which is worth it is a judgement about how much of this
  prompt a model reads closely.
- **How many of these are Gemini-specific?** Every thread is `gemini-2.5-flash`. The invented
  notation, the confident denial of a tool it holds, and the four-times-repeated wrong path all
  have the flavour of a fast model under-reading its context — but the prompt defects behind them
  are real for any model, and a stronger one would only fail later and less visibly. Worth one
  thread of the same work on a larger model before concluding anything about which is which.

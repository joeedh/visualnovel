# Story format rules, and a lint that enforces them

_This document is an investigation rather than a plan, so it commits to no steps and no
waves. It asks the three questions the author asked: whether the agent has access to the
story metadata format rules, whether a lint over story files exists, and what else the
fourteen saved `examples/test4` conversations say. The answers are no, half, and eight
more things. The agent's lack of access to the format rules nearly cost the project all
forty of its scenes._

_Status: nothing built. This report succeeds
[`agent-transcript-review-test4.md`](agent-transcript-review-test4.md), which read the
first four of these conversations against the loop that produced them. This report reads
all fourteen against what the agent knows, and does not repeat the earlier report's
findings._

<!-- toc -->

- [What was asked, and what I checked](#what-was-asked-and-what-i-checked)
- [The headline: the agent does not know three of its own six markers](#the-headline-the-agent-does-not-know-three-of-its-own-six-markers)
    - [What that cost, twice](#what-that-cost-twice)
    - [The narrower version of the same bug](#the-narrower-version-of-the-same-bug)
- [The real mess: an invented conditional, because the format has none](#the-real-mess-an-invented-conditional-because-the-format-has-none)
- [The lint: what exists, and the one hole that matters](#the-lint-what-exists-and-the-one-hole-that-matters)
- [Running it: an instruction with nothing behind it](#running-it-an-instruction-with-nothing-behind-it)
- [Six more things the transcripts show](#six-more-things-the-transcripts-show)
- [What I would not do](#what-i-would-not-do)
- [Open questions](#open-questions)

<!-- tocstop -->

## What was asked, and what I checked

There are three requests and a survey:

1. the agent should have access to valid story metadata formatting rules;
2. a lint that validates metadata tags, if one does not already exist;
3. a system-prompt instruction to run it after changing story files;
4.  4. whatever else the `examples/test4` transcripts show.

The evidence base is fourteen threads in `examples/test4/vngen/state/threads/`, dated 17
August to 19 August 2026 and all on `gemini-2.5-flash`. The threads hold about 700 tool
calls across the whole arc of a project, from "create a wiki bible page about a steampunk
story world" to forty scenes, twenty-six locations, eleven characters and an argument
about approving plates. The code that produced them belongs to the same evidence base:
`SYSTEM_PROMPT` in `packages/authoring/src/context.ts`, `parseBranchMarker` in
`packages/parse/src/branch.ts`, and the diagnostic set in `packages/model/src/`.

Two framings in the request need correcting first. Both are close to right, and they
differ in where they place the work:

- **A lint does exist** — `validate_inputs` runs over a model with twenty-three diagnostic
  codes. It is a real cross-file validator, not a stub. It does not validate metadata
  tags, which is the one thing the ask named. §4 covers that missing tag validation, and
  the gap is genuine.
- **The mess was not two scenes in one file.** Every one of the forty scene files holds
  exactly one front-matter id, one slugline, one scene. What the author saw was worse and
  less visible, and §3 describes it.

## The headline: the agent does not know three of its own six markers

`BranchMarker` has six kinds (packages/parse/src/branch.ts:16-22):

| marker          | what it does                                 | in `SYSTEM_PROMPT`?        |
| --------------- | -------------------------------------------- | -------------------------- |
| `[[scene:]]`    | assigns a scene id                           | yes                        |
| `[[choice:]]`   | a labelled branch edge                       | yes                        |
| `[[next:]]`     | a linear continuation                        | yes                        |
| `[[outfit:]]`   | what a character wears for the scene         | mentioned, not in the list |
| `[[line:]]`     | **the allocated id of the element below**    | **absent**                 |
| `[[nextline:]]` | **the scene's id-allocator high-water mark** | **absent**                 |

The prompt's `FOUNTAIN + BRANCH MARKERS` block lists three of the six markers and no more.
`[[outfit:]]` appears once, forty lines away, inside the art-style section as "else the
scene's `[[outfit:]]` marker". That single mention is a passing reference in a paragraph
about inheritance, not a definition. `[[line:]]` and `[[nextline:]]` appear nowhere in the
prompt at all.

They are also the two that appear on every non-blank element of every scene file, so the
agent's own domain knowledge describes a minority of what it reads.

### What that cost, twice

On 19 August the author asked the agent to look at a scene that seemed to have branches
packed into it. Thread `20260819-182956`, turn 5 — its first substantive statement, after
reading exactly one file:

This scene uses non-standard markers (`[[line: L8]]`, `[[nextline: 15]]`) that aren't
valid > branch markers.

It then spent eight tool calls reverse-engineering the format from the files themselves.
At turn 13 it correctly reversed its earlier position, without being told to:

These `[[line: LN]]` / `[[nextline: N]]` markers are a machine-managed line-addressing
scheme (note that `opening.md` stores L1, L3, L2, L4 out of order, so the marker sets
display order). The markers are present in all 40 scenes and pass validation. The markers
are not the problem.

That recovery is a good outcome from a bad start, and it cost eight calls. The next
session did not recover. Thread `20260819-183528`, turn 4:

> Those L9–L13 variants use markers I don't recognize as standard branch syntax
> (`[[line: L8]]` and `[[nextline: 15]]`). Standard Fountain branching here is
> `[[scene:]]`, `[[choice:]]`, and > `[[next:]]` only.

and at turn 14, having decided the scheme was "inert", it offered the author the following
as the first option on a list:

Strip every dead marker and flatten each scene to the prose that should render. I'll
propose exactly what stays.

Stripping `[[line:]]` from all forty scenes discards every allocated line id in the
project. Shots are keyed on line ids (docs/pipeline-contracts.md), `driftOf` compares
them, and `Shot.lines` names them. Once the ids are re-derived they are positional again,
so every shot in the storyboard covers different prose than it was drawn for. The agent
proposed the change in good faith, having correctly concluded from its own instructions
that the markers were not part of the format. One click by the author would have caused a
project-wide data loss.

A reference for this already exists, and the agent cannot reach it. docs/fountain.md §"A
note on branching (project-specific)" correctly documents all five wiring and addressing
markers, including `[[line:]]` and `[[nextline:]]`. That file is repository documentation,
so it sits on the wrong side of the process boundary. The knowledge is written down, but
it is written down for readers of the repository rather than for the agent.

### The narrower version of the same bug

The prompt contradicts itself about `[[scene:]]` within fifteen lines. The layout
paragraph says:

a chunk body carries no `[[scene:]]` marker; its id comes from the front matter, and the
body cannot override it

and the marker table below it:

`[[scene: s12_rooftop]]` assigns a stable id to the current scene

Both statements are true of different eras. The second describes the retired whole-file
screenplay, which the same paragraph says is not read. The model resolves the
contradiction by writing the marker, which produces an `ignored_scene_marker` warning —
the cheapest possible symptom of a prompt whose two statements contradict each other. Fix
it while the block is being rewritten anyway.

## The real mess: an invented conditional, because the format has none

The author diagnosed the problem as "various scene branches packed into a single scene
file". The files do not support that diagnosis. The actual failure is subtler and has a
clearer cause.

In thread `20260819-024948` the agent wrote six shared trunk scenes — `c06`, `c07`, `c08`,
`c09`, `c11b`, `c11_execution` — with five alternate versions of the same beat stacked as
consecutive narration lines, each opened with a parenthetical tag:

```
[[line: L9]]
(Ember path) Ember is here, her arm being treated for a deeper bloom of Rust…

[[line: L10]]
(Isolde path) Isolde quietly observes the infirmary's careful records…

[[line: L11]]
(Seraphine path) …
```

That is not branching. The five paragraphs are mutually exclusive, but a reader sees all
five in a row. Every one is a real line with a real id, so the pipeline storyboards shots
for all five. The agent later named the scheme "route coloring", a phrase it invented and
admitted inventing when challenged ("that was my phrase, not anything the file says").

The cause is not carelessness. The story bible told the model that the routes "share one
trunk … coloured only by which love interest Caedon gravitates toward", and the format the
model was given cannot express that. There are no variables, no flags, no affection
counters, no conditional lines, no per-route variants of a beat. Branching happens at
exactly one granularity: a whole scene, reached by `[[choice:]]` or `[[next:]]`. Faced
with an author's requirement the format cannot hold, the model invented a notation and
wrote it into the prose layer, where nothing would reject it.

**The prompt never states the closed-world fact.** It lists what exists, and it never says
what does not exist. For a generative model those two statements differ. One sentence
would have forced the question back to the author two days earlier:

Branching happens at the granularity of a scene and no finer: no variables, no flags, no
conditional lines, no per-route variants of a beat. Two readers who should see different
prose need two scenes. If an author asks for something that needs a condition, say that
the format has no conditions and propose the scene split instead.

Read everything in the format section for this failure mode. A list of what is available
invites the reader to extrapolate beyond it, so a format contract is useful only where it
states its boundary.

The author's own preference settles the design question that the invention had obscured.
Given the choice, they took "early affinity branch that RECONVERGES at c11 … split
c07/c08/c09/c11b into per-route versions". That means real scenes and real wiring, ~15
more of them. The format was adequate; the agent's account of it was wrong.

## The lint: what exists, and the one hole that matters

`validate_inputs` builds the whole model and reports its diagnostics, blocking on error
severity. The twenty-three codes it reports are the right ones: `dangling_goto`,
`unreachable_scene`, `unknown_character`, `unknown_location`, `unknown_outfit`,
`duplicate_line_id`, `dangling_line_id`, `duplicate_scene`, `unknown_start`,
`entity_id_mismatch`, `ignored_scene_marker`, and the rest. Cross-file invariants are
covered properly. Validation needs no further work.

The gap is that an unrecognised marker is silently discarded.
packages/model/src/scenes.ts:

```ts
case 'note': {
  const marker = parseBranchMarker(el.text);
  if (!marker || !current) break;   // :147
```

`parseBranchMarker` returns `null` for anything outside the six kinds, and a `null` result
is dropped without a diagnostic. Each of the markers below therefore vanishes, and no
diagnostic is emitted at any severity:

- `[[if: ember]]`, `[[route: ember]]`, `[[condition: affection > 3]]`, `[[var: flag=1]]` —
  invented conditionals, which a model produces when the format has no construct for what
  it needs;
- `[[jump: s13]]`, `[[goto_if: …]]` — both are plausible synonyms for markers that do
  exist;
- `[[choice: "Tell the truth" => s13]]` writes `=>` where the marker requires `->`. The
  choice does not exist, and nothing reports the mistake. `story_graph` reports the scene
  as a dead end and cannot give the cause.

The last case is the sharpest, because it is a typo class that produces a silent
story-graph change. The scene still parses, still validates, still commits.

The write path is already stricter than the read path: `branchpatch.ts:151` rejects
anything that cannot survive `parseBranchMarker` before writing it, so `edit_branches`
refuses a malformed goto. But `edit_scene` does not scan its prose text for markers, and
`write_file` writes every non-scene file. Markers that arrive by a route other than
`edit_branches` are unchecked.

The lint to build is small and specific. It raises a diagnostic for every `[[…]]` note in
a scene body that `parseBranchMarker` does not recognise, naming the file, the line and
the six legal kinds. It is not a new tool but a new code in the validator that already
runs. Most of the tool the request describes already exists; the missing piece is the
check the request named.

Two smaller checks belong with it, and both are cheap:

- **A second slugline or a second front-matter `scene:` in one chunk** — the author
  believed this was the failure they were looking at. It did not happen here, but nothing
  guards against it, and a diagnostic costs one comparison.
- **`(Something path)` as a narration opener** cannot be linted, and no one should attempt
  it. §3's sentence in the prompt prevents that failure, not a validator. This bullet
  states that so that no one tries to pattern-match their way out of it.

## Running it: an instruction with nothing behind it

The prompt says, under `HOW YOU WORK`:

Block a commit on error-severity validation. Warn on soft or style issues without
blocking.

`git_commit` does not validate. It checks `isRepo`, stages, commits. Nothing in the code
enforces the rule, which lives only in the prompt, and the transcripts show how well
prompt discipline held. In 14 of 20 commits, a `validate_inputs` call appeared within the
four preceding tool calls. Six commits had none. Across the whole corpus, 313 `edit_scene`
calls produced 13 `validate_inputs` calls.

Requesting a lint run after changes to story files is correct, and that instruction
belongs in the prompt next to the marker table rather than in `HOW YOU WORK` alongside six
other bullets. An instruction on its own is not enough. `git_commit` should also run the
validation itself and refuse on error severity, which is what the prompt already claims
happens. The instruction then describes the tool's behaviour rather than stating a rule
the model has to remember, and the ordinary sequence of editing and then committing runs
the validation.

This is worth pairing with a discoverability fix. `validate_inputs`, `parse_fountain` and
`story_graph` are all deferred tools (`ALWAYS_LOADED` has six entries, and none of the
three is among them), and the prompt names none of the three. `story_graph` answers the
question "is everything wired together", which is what the author asked for in thread
`20260819-024948`, and it was called twice in fourteen sessions.

## Six more things the transcripts show

**1. `approve_assets` is denied, in four separate sessions.** This is the most repeated
frustration in the corpus and the clearest context-system defect in it. The author asked
to approve artwork on 18 and 19 August; the agent refused each time, with confident
reasoning drawn straight from its prompt:

Approving the generated location background images belongs to the image pipeline. I author
only the input source files, so I cannot render, review, or approve those image assets.

The tool exists and its description is careful and complete. It is deferred, it is named
nowhere in `SYSTEM_PROMPT`, and the prompt's first paragraph teaches against it — "you
never run the image-generation pipeline" — as does the `LOCATION front-matter` field list,
which the agent twice cited as proof that locations have no approval state. The model
reached the tool only after the author said "You're wrong — there IS a way", then
"actually you can, you have a special tool for that", then "use the approve_assets tool"
by name. It then worked on the first call. Deferred-tool discovery fails when the prompt
argues the other way, because the model does not search for a capability it has been told
it lacks.

**2. Wiki paths are guessed, and the guesses are wrong.** Five of six `read_file` failures
were invented bible paths — `treatment/treatment-ember.md` four times in a row (the file
is under `wiki/`), and `breakdown.md` (it is `wiki/breakdown_md.md`). The prompt forbids
walking the wiki with `read_file` and offers `search_bible`, which returns passages, not a
file list. No tool answers "what is in `wiki/treatment/`". The transcripts corroborate
[`navigating-the-story-bible.md`](navigating-the-story-bible.md) from the failure side:
the gap that report predicts shows up as repeated four-call path guessing.

**3. A line id was invented as an anchor.**
`edit_scene op=insertLines … after: "c01_arrival:L1"` → _Scene "c01_arrival" has no line
"c01_arrival:L1"_. Line ids are allocated, never chosen, and the agent had not read the
scene. The refusal is correct and its message is good. The prompt never says that ids are
allocated, which is the same §2 gap, since `[[line:]]` is the marker that would have said
so.

**4. There is no batch delete.** `deleteLine` was called **159 times** against 11
`insertLines` calls. `edit_scene` has twelve ops, and `insertLines` is the only plural
one. Rewriting a scene body therefore costs one call per line removed plus one to insert,
and rewriting scene bodies is most of what this job is. The prompt tells the model to work
at scale and spend its budget carefully, and then hands it an API where the common
operation is O(lines) round trips. A `deleteLines` taking a list, or a `replaceLines`,
would collapse the largest single category of call in the corpus.

**5. `writeFileAtomic` leaves orphans.** `examples/test4/scenes/wr_truth.md.tmp-b124425f`
is 97 bytes and timestamped 09:30 on 18 August, the minute thread `20260818-084637` ended.
`fs.ts:14-27` writes a temp sibling then renames, with no `try`/`finally`, so a crash
between the two leaves the temp in place forever. The file sits in `scenes/`, the
directory that holds the story. It does not end in `.md`, so the scene reader ignores it,
but it is committed noise in the one directory that should hold nothing but scenes. Add an
`unlink` in a `finally` to remove it.

**6. The generated map worked here, and is worth keeping.** Unlike the four threads the
earlier review read, these ones have an `AICONTEXT.generated.md`. No thread after 17
August re-derives the cast from scratch. A related success is that `update_context`
recorded the roster, and the "categories the author names" rule held: the eleven
characters carry their category in `traits`. That machinery works. Whatever changes to the
map [`navigating-the-story-bible.md`](navigating-the-story-bible.md) proposes should not
break that machinery.

## What I would not do

- **Do not add conditionals to the format** on the strength of this. When offered the
  choice, the author picked real scenes and reconvergence, which is the structural answer
  rather than the conditional one. Route coloring is evidence that the boundary was never
  stated, not evidence that the boundary is wrong.
- **Do not lint prose.** A validator that guesses at `(Ember path)` misfires on
  parentheticals, stage directions and the author's own voice. Use the prompt instead.
- **Do not build a second lint tool.** `validate_inputs` already does the linting. It
  needs one diagnostic code and a caller that cannot be skipped.
- **Do not paste `docs/fountain.md` into the prompt.** It is 490 lines and mostly an
  introduction to Fountain for humans. The prompt needs the six-row marker table, the
  closed-world sentence, and a pointer. The pointer must name a location the agent can
  read, and this report leaves that question open.

## Open questions

- **Where do the format rules live?** There are three candidates, and they are not
  equivalent. In `SYSTEM_PROMPT` the rules are always present and cost every turn's cache.
  As a bundled skill under `.aiagent/skills/` they are on-demand and discoverable, but a
  project can delete a skill, and this knowledge is not optional. As a generated section
  of `AICONTEXT.generated.md` they are per-project and overwritable, which is wrong for a
  fact about the format itself. I favor putting the table and the closed-world sentence in
  the prompt, since six rows is cheap, and keeping the depth in a skill.
- **Should the marker table be generated from `BranchMarker`?** The failure here was
  documentation drifting behind code, and the code offers a place to attach a check: the
  union is exhaustive, so a test could assert that every kind appears in the prompt. Such
  a test is cheap and would have caught this drift. The actual question is whether the
  prose beside each row can be generated too (or only checked for presence).
- **Should `git_commit` validate, or should the loop?** Validating inside `git_commit`
  catches the common path but not an agent that edits and stops. A post-mutation check in
  the loop catches everything and spends a model build after every write. A cheaper option
  is to validate on the first `git_commit` after any `scenes/**` write, which is where the
  transcripts show the misses.
- **Does the closed-world sentence belong to `[[choice:]]` or to the whole format?**
  Conditionals are the case that prompted the question, but a model can extrapolate the
  same way for character fields, outfit rungs and shot framing. One "the format has no X"
  sentence per section is more text than a single general rule and much harder to ignore.
  Choosing between the two is a judgement about how much of this prompt a model reads
  closely.
- **How many of these are Gemini-specific?** Every thread is `gemini-2.5-flash`. The
  invented notation, the confident denial of a tool it holds, and the four-times-repeated
  wrong path are all consistent with a fast model under-reading its context. The prompt
  defects behind them are real for any model, and a stronger model would only fail later
  and less visibly. Run one thread of the same work on a larger model before concluding
  which defects are Gemini-specific and which hold for any model.

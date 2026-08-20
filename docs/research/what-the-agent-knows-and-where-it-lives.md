# What the agent knows, and where it lives

_Investigation, and the umbrella over two others. Not a plan — no waves committed to, though the
prompt section is written to be implementable as it stands. It settles one question the other two
reports left open: given three places knowledge about this project can live — the built-in system
prompt, a skill, or the code itself — which findings go where, and what a 25,000-character prompt
budget actually buys._

_The two reports it consolidates:_

- _[`story-format-rules-and-a-scene-lint.md`](story-format-rules-and-a-scene-lint.md) — what the
  agent does not know about the story format, read from all fourteen `examples/test4` conversations._
- _[`navigating-the-story-bible.md`](navigating-the-story-bible.md) — what it would take for the
  agent to **list** the wiki rather than only search its prose._

_Prior work it builds on rather than repeats:
[`agent-transcript-review-test4.md`](agent-transcript-review-test4.md) and the plan it produced,
[`plans/improving-the-authoring-agent.md`](../plans/archive/improving-the-authoring-agent.md) (shipped);
and [`retrieval-beyond-grep.md`](retrieval-beyond-grep.md) for the ranking half of `@vn/bible`._

<!-- toc -->

- [The three homes, and the rule for choosing](#the-three-homes-and-the-rule-for-choosing)
- [The prompt budget: 25,000 characters, and the constraint is not bytes](#the-prompt-budget-25000-characters-and-the-constraint-is-not-bytes)
  * [What goes in, and what it costs](#what-goes-in-and-what-it-costs)
  * [Keeping the table honest](#keeping-the-table-honest)
- [The skills: one new one](#the-skills-one-new-one)
- [What is neither: five code changes](#what-is-neither-five-code-changes)
- [How this sequences](#how-this-sequences)
- [Open questions](#open-questions)

<!-- tocstop -->

## The three homes, and the rule for choosing

Everything the agent knows arrives through one of three doors, and they are not interchangeable.
The distinction that matters is **reachability**, not size:

| home                                            | reaches the agent                                              | can a project lose it? |
| ----------------------------------------------- | -------------------------------------------------------------- | ---------------------- |
| `SYSTEM_PROMPT` (`packages/authoring/src/context.ts`) | every turn, unconditionally, before anything else              | no                     |
| a skill (`.aiagent/skills/<id>/SKILL.md`)        | only if the agent calls `discover_skills`, then `run_skill`     | **yes**                |
| the code — a tool, a refusal, a diagnostic       | when the agent does the thing                                  | no                     |

Two facts about the middle row decide most of what follows.

**Skills are project-local, and most projects do not have any.** `PROJECT_SKILLS_DIR` is
`.aiagent/skills` under the workspace root (`skills.ts:27`); the two that exist ship in
`templates/basic/`, so they are scaffolded into projects created after that, and nowhere else.
`examples/test4` — forty scenes, twenty-six locations, fourteen conversations — has no `.aiagent/`
directory at all. Every failure in the companion report happened in a project that could not have
read a skill if one existed.

**Skills are not injected.** Nothing puts the skill list in the system message or the project map.
`discover_skills` is a deferred tool: the agent must search the catalog for it, call it, read the
list, and then call `run_skill`. That is three deliberate acts before a single word of the skill is
in context.

So the rule is:

> **The prompt carries what must never be got wrong. A skill carries a procedure the agent will go
> looking for once it knows which job it is doing. The code carries anything that can be checked.**

A corollary the companion report's headline failure makes concrete: **a fact the agent needs in
order to not destroy something cannot be a skill.** The agent that offered to strip `[[line:]]`
from all forty scenes did not know it was doing the "story format" job — it thought it was cleaning
up junk. It would never have gone looking for the skill that would have stopped it.

## The prompt budget: 25,000 characters, and the constraint is not bytes

`SYSTEM_PROMPT` today is **9,754 characters** across 138 lines — about 2,600 tokens. Against a
25,000-character budget that is 39% used, with **15,246 characters of headroom**.

A note on units, since the budget was given as "25k" without one: characters is the reading that
matches everything else in this codebase — the generated map is budgeted at 8,000 characters, a
bible query at 4,000 — and it lands the prompt at roughly 6,800 tokens, which is a sane always-on
cost against a byte-stable cached prefix. Twenty-five thousand *tokens* would be ~92,000 characters,
nine times the current prompt, and nothing identified in either report comes close to needing it.
The number is also worth asserting in a test, because a budget nobody measures is a budget.

**Everything both reports identified fits in about 3,000 characters.** The itemisation is below;
it lands the prompt near 12,800 — half the budget, with 12,000 to spare. That is the useful finding here,
and it inverts the framing of the question: the prompt is not short of room and never was. It is
9,754 characters because nobody has added to it recently, not because anything was cut for space.

Which means the binding constraint at 25k is **attention, not bytes** — and the transcripts show
the model's attention is strongly positional. Evidence, from the companion report:

- The agent quoted the prompt's **first paragraph** back as its reason for refusing four times
  across four sessions: _"I only author the input source files … I never run the
  image-generation pipeline."_ The top of the prompt is read closely and treated as binding.
- `[[outfit:]]` is mentioned once, forty lines below the marker table, inside a paragraph about art
  inheritance. It was never used as a marker in fourteen sessions. Present, and invisible.

So the design rule for spending the headroom is not "what else could we say" but **where each
sentence sits, and whether anything above it argues the other way.** A contradiction costs more
than an omission: the `[[scene:]]` block disagrees with the layout paragraph fifteen lines above it,
and the `approve_assets` capability is not merely absent from the prompt — the opening paragraph
actively teaches against it. Adding text near the bottom while leaving the contradiction at the top
buys nothing.

### What goes in, and what it costs

Seven items, in the order they should sit in the file. Costs are approximate and net of what they
replace.

| #   | item                                                                                                                                                                                                                                                                        | ~chars |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **Correct the scope overreach in the preamble.** "You never run the image-generation pipeline" is true of _rendering_ and false of _approving_. Split the two, and name `approve_assets` where the sentence that denied it was.                                                | +350   |
| 2   | **The complete marker table** — all six `BranchMarker` kinds, replacing the three-row block. `[[line:]]` and `[[nextline:]]` described as machine-managed and **never to be written or removed by hand**.                                                                       | +900   |
| 3   | **The closed-world sentence.** Branching is scene-granular and there is nothing finer: no variables, flags, counters, conditional lines, or per-route variants of a beat. If two readers should see different prose, that is two scenes — and if the author asks for something needing a condition, say so and propose the split. | +600   |
| 4   | **Line ids are allocated, never chosen.** Read the scene before anchoring an edit to one.                                                                                                                                                                                     | +350   |
| 5   | **Resolve the `[[scene:]]` contradiction** — drop the marker-table row that describes the retired whole-file screenplay, keep the layout paragraph's rule.                                                                                                                    | −150   |
| 6   | **A validation paragraph** naming `validate_inputs`, `story_graph` and `parse_fountain`, and stating: after any change under `scenes/`, validate and check the graph before committing.                                                                                        | +700   |
| 7   | **A skills pointer that says _when_.** The prompt already says skills exist; it never says to look. One sentence: before a multi-scene structural job, call `discover_skills`.                                                                                                 | +250   |
|     | **total**                                                                                                                                                                                                                                                                    | +3,000 |

Items 1, 3 and 5 are worth more than their length suggests, because each removes something that is
currently pointing the wrong way. Item 2 is the one whose absence nearly cost the project its line
ids.

Two things deliberately **not** added:

- **A wiki-navigation sentence.** It belongs with `list_bible`, and writing it before that door
  exists would describe a tool the agent cannot call. Reserved, ~200 characters, when
  [`navigating-the-story-bible.md`](navigating-the-story-bible.md) is acted on.
- **`docs/fountain.md` itself.** 490 lines, mostly a general introduction to Fountain for humans.
  The six-row table and the closed-world sentence are the load-bearing 3%.

### Keeping the table honest

The failure in the companion report was documentation drifting behind code: `BranchMarker` gained
`outfit`, `line` and `nextline`, and the prompt did not. Since the union is exhaustive, a test can
assert that every kind's marker name appears in `SYSTEM_PROMPT` — cheap, and it would have caught
this. It checks presence, not correctness, which is the honest limit of what a test can do here and
worth writing down beside it so nobody trusts it further than that.

Pair it with a second assertion on total length against the 25,000 budget, so both numbers this
section commits to are enforced rather than remembered.

## The skills: one new one

The rule above disqualifies most of what a skill might have carried. Format rules cannot be a skill
(project-local, deletable, and needed by an agent that does not know it needs them). Validation
cannot be a skill (it must happen on the ordinary path). What is left is genuinely procedural: work
that is long, optional, and recognisable in advance.

Two exist and should stay: **`full-production`** (the nine-phase spine) and **`new-character`**.

**One should be added: `branching`.** It is the playbook the 19 August conversations needed and did
not have — and unlike the format rules, the agent would have known to look for it, because both
sessions opened with the author naming the job.

What it covers, none of which fits the prompt:

- The three shapes a branching VN takes — one trunk with a late fork, an early fork that
  reconverges, fully separate routes — and what each costs in scenes. The author chose the middle
  one, from a list the agent had to construct on the spot after two sessions of confusion.
- How to split a shared scene into per-route chunks: `newScene` per route, move the prose, wire
  with `[[choice:]]` from the fork and `[[next:]]` back to the reconvergence point, then
  `story_graph` to prove every route reaches an ending and nothing is orphaned. `newScene` leaves a
  scene unreachable until it is wired, which is the step that gets skipped.
- The naming convention that emerged here and worked — `<route>_<beat>` (`em_landing`,
  `wr_truth`) — and the reason a scene id cannot be changed later.
- The refusal to hand back: if the author wants prose that varies without a scene boundary, the
  format has no mechanism, and the answer is a scene split or nothing.

That is ~60 lines of prose that earns its keep only during a restructure. Exactly a skill.

**Deliberately not skills**, each of which was considered:

- _`format-rules`_ — the disqualification above. Its content goes in the prompt.
- _`revise-scenes`_ — bulk revision at scale. Real, and recurring in the transcripts, but what it
  would say is mostly "batch your calls", which is a missing `deleteLines` op rather than a
  procedure (§4).
- _`approve-artwork`_ — four sessions of friction, and none of it a procedure problem. The tool
  works perfectly once reached. That is item 1 of the prompt table, not a skill.

## What is neither: five code changes

Some findings cannot be fixed by telling the agent anything, because the failure is that nothing
checks. These are the ones where a sentence in the prompt would be a promise rather than a fix —
and note that one of them, item 3, is a promise the prompt is **already** making.

1. **A diagnostic for an unrecognised `[[…]]` note.** `scenes.ts:147` drops anything
   `parseBranchMarker` does not recognise, in silence and at no severity. So `[[if: ember]]`,
   `[[route: em]]`, and `[[choice: "x" => s13]]` (`=>` for `->`) all change or fail to change the
   story graph with nothing said. One new code in the validator that already runs, naming the file,
   the line, and the six legal kinds. **This is the single highest-value change in either report**,
   because it is the only one that catches an invented notation the day it is written rather than
   two days later when a human reads the file.
2. **`git_commit` validates and refuses on error severity.** The prompt already says it does —
   _"Block a commit on error-severity validation"_ — and nothing in the code does. The transcripts
   show that discipline holding on 14 commits in 20. Making it true converts a rule the model must
   remember into a property of the ordinary path, and makes item 6 of the prompt table a description
   rather than an instruction.
3. **A second slugline or second front-matter `scene:` in one chunk** is a diagnostic. It did not
   happen in `examples/test4`, but it is what the author believed they were looking at, it is
   unguarded, and it costs one comparison.
4. **A batch delete for `edit_scene`.** `insertLines` shipped from
   [`plans/improving-the-authoring-agent.md`](../plans/archive/improving-the-authoring-agent.md) §3.2 and
   the symmetric half did not: 159 `deleteLine` calls against 11 `insertLines` across the corpus.
   That plan's own argument — "a 40-line scene goes from 41 calls to two" — applies unchanged to
   _rewriting_ one, which still costs 40 deletes plus an insert, and rewriting scenes is most of
   this job.
5. **`writeFileAtomic` cleans up its temp.** `fs.ts:14-27` writes a temp sibling then renames with
   no `try`/`finally`; `examples/test4/scenes/wr_truth.md.tmp-b124425f` has sat in the scenes
   directory since 18 August. An `unlink` in a `finally`.

Plus, from the other report and not repeated here: `list_bible`, and the three second-order effects
it unlocks.

## How this sequences

Not a commitment to waves, but the dependencies are real and worth stating:

- **1, 2 and 5 in the prompt** (scope overreach, marker table, `[[scene:]]` contradiction) are
  independent of everything else and are where the damage was. They are also the cheapest.
- **Code change 1** (the unknown-marker diagnostic) should land with or before prompt item 3, so
  the closed-world sentence has an enforcement behind it rather than being advice.
- **Code change 2** (`git_commit` validates) should land before prompt item 6, or item 6 will be
  the second thing in the prompt that promises validation nothing performs.
- **The `branching` skill** wants prompt item 7 to be reachable at all, and wants the closed-world
  sentence to exist so it is elaborating a rule rather than introducing one.
- **`list_bible`** is independent of all of it.

## Open questions

- **Should skills have a built-in root?** `skillDirs` already takes `extraDirs` (`skills.ts:62`),
  so a bundled root that every project sees is reachable without new architecture. That would make
  a skill a legitimate home for knowledge that must always be present, and would change the answer
  in §1 — a shipped-with-the-app skill is not deletable by a project the way a scaffolded one is.
  Worth deciding before the `branching` skill is written, because the answer decides whether it
  ships in `templates/basic/` or beside the code.
- **Does anything tell the agent a skill is relevant?** Even with §2's pointer, `discover_skills`
  is a call the model must choose to make on a turn where it does not yet know it needs help. A
  one-line skill index in the generated project map would cost ~40 characters per skill and change
  it from a search into a glance — but that is the map's budget, which
  [`navigating-the-story-bible.md`](navigating-the-story-bible.md) is separately arguing to shrink.
- **Is the marker-name test enough?** It proves each kind is mentioned, not that the sentence beside
  it is true — and this failure was a missing row, which it catches. A prose-correctness check is
  not available, so the residual risk is a row that goes stale rather than absent. Probably
  acceptable, and worth saying so explicitly rather than leaving it implied.
- **What does the prompt budget do when it is hit?** Nothing in either report gets near 25,000, so
  the question is hypothetical today — but a budget with no stated overflow policy is one that will
  be quietly exceeded. Refusing to build is the honest answer for a byte-stable cached prefix;
  truncating it is not.
- **How much of this is Gemini-specific?** All fourteen threads are `gemini-2.5-flash`. The prompt
  defects are real for any model, but the _positional_ attention argument in §2 — top read closely,
  line 109 not read at all — is the thing most likely to be a property of this model rather than of
  prompts. One thread of the same work on a larger model would settle whether the placement rule is
  a general principle or a fast-model accommodation.

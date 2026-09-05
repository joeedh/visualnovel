# What the agent knows, and where it lives

_This report is an investigation, and it covers two other reports. It is not a plan and
commits to no waves, though the prompt section is written to be implementable as it
stands. It settles one question the other two reports left open. Knowledge about this
project can live in three places: the built-in system prompt, a skill, or the code itself.
The report says which findings belong in each place, and what a 25,000-character prompt
budget actually buys._

_The consolidator reads two reports:_

- _[`story-format-rules-and-a-scene-lint.md`](story-format-rules-and-a-scene-lint.md) —
  what the agent does not know about the story format, read from all fourteen
  `examples/test4` conversations._
- [`navigating-the-story-bible.md`](navigating-the-story-bible.md) — describes what it
  would take for the agent to list the wiki rather than only search its prose.

It builds on (rather than repeats)
[`agent-transcript-review-test4.md`](agent-transcript-review-test4.md) and the plan it
produced,
[`../plans/archive/INDEX.md#improving-the-authoring-agent`](../plans/archive/INDEX.md#improving-the-authoring-agent)
(shipped). It also builds on [`retrieval-beyond-grep.md`](retrieval-beyond-grep.md) for
the ranking half of `@vn/bible`.\_

<!-- toc -->

- [The three homes, and the rule for choosing](#the-three-homes-and-the-rule-for-choosing)
- [The prompt budget: 25,000 characters, and the constraint is not bytes](#the-prompt-budget-25000-characters-and-the-constraint-is-not-bytes)
    - [What goes in, and what it costs](#what-goes-in-and-what-it-costs)
    - [Keeping the table honest](#keeping-the-table-honest)
- [The skills: one new one](#the-skills-one-new-one)
- [What is neither: five code changes](#what-is-neither-five-code-changes)
- [How this sequences](#how-this-sequences)
- [Open questions](#open-questions)

<!-- tocstop -->

## The three homes, and the rule for choosing

The agent's knowledge comes from three channels, and no channel substitutes for another.
Reachability, not size, is the distinction that matters:

| home                                                  | reaches the agent                                           | can a project lose it? |
| ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------- |
| `SYSTEM_PROMPT` (`packages/authoring/src/context.ts`) | every turn, unconditionally, before anything else           | no                     |
| a skill (`.aiagent/skills/<id>/SKILL.md`)             | only if the agent calls `discover_skills`, then `run_skill` | **yes**                |
| the code — a tool, a refusal, a diagnostic            | when the agent does the thing                               | no                     |

Two facts about the middle row determine most of what follows.

Skills are project-local, and most projects do not have any. `PROJECT_SKILLS_DIR` is
`.aiagent/skills` under the workspace root (skills.ts:27). The two skills that exist ship
in `templates/basic/`, so projects created after that template shipped have them and no
other project does. `examples/test4` (forty scenes, twenty-six locations, fourteen
conversations) has no `.aiagent/` directory at all. Every failure in the companion report
happened in a project that could not have read a skill if one existed.

Skills are not injected. Nothing puts the skill list in the system message or the project
map. `discover_skills` is a deferred tool: the agent must search the catalog for it, call
it, read the list, and then call `run_skill`. The agent takes three deliberate steps
before any of the skill's text is in context.

The rule is:

The prompt states what must never be got wrong. A skill holds a procedure the agent looks
up once it knows which job it is doing. The code holds anything that can be checked.

The companion report's headline failure makes a corollary concrete: a fact that keeps the
agent from destroying something cannot be a skill. The agent that offered to strip
`[[line:]]` from all forty scenes did not know it was doing the "story format" job, and
took the markers for junk. It would never have gone looking for the skill that would have
stopped it.

## The prompt budget: 25,000 characters, and the constraint is not bytes

`SYSTEM_PROMPT` today is 9,754 characters across 138 lines, or about 2,600 tokens. That
uses 39% of a 25,000-character budget and leaves 15,246 characters of headroom.

The budget was given as "25k" without a unit. Characters is the reading that matches
everything else in this codebase: the generated map is budgeted at 8,000 characters and a
bible query at 4,000. Characters also land the prompt at roughly 6,800 tokens, a sane
always-on cost against a byte-stable cached prefix. Twenty-five thousand tokens, by
contrast, would be ~92,000 characters, nine times the current prompt, and nothing
identified in either report comes close to needing it. The number is also worth asserting
in a test, because an unmeasured budget constrains nothing.

Everything both reports identified fits in about 3,000 characters. The itemisation is
below, and adding all of it lands the prompt near 12,800 characters (half the budget),
leaving 12,000 to spare. The useful finding is that the prompt is not short of room and
never was. It is 9,754 characters because nobody has added to it recently, not because
anything was cut for space.

So the binding constraint at 25k is attention rather than bytes, and the transcripts show
that the model's attention is strongly positional. The companion report gives the
evidence:

- The agent quoted the prompt's first paragraph back as its reason for refusing four times
  across four sessions: "I only author the input source files … I never run the
  image-generation pipeline." The agent reads the top of the prompt closely and treats it
  as binding.
- `[[outfit:]]` is mentioned once, forty lines below the marker table, inside a paragraph
  about art inheritance. It was never used as a marker in fourteen sessions. It is present
  in the document but not visible.

So spend the headroom by asking where each sentence sits and whether anything above it
argues the other way, not by asking what else could be said. A contradiction costs more
than an omission. The `[[scene:]]` block disagrees with the layout paragraph fifteen lines
above it, and the `approve_assets` capability is not merely absent from the prompt; the
opening paragraph actively teaches against it. Adding text near the bottom while leaving
the contradiction at the top buys nothing.

### What goes in, and what it costs

These seven items appear in the order they should sit in the file. Costs are approximate
and net of what they replace.

| #   | item                                                                                                                                                                                                                                                                                                                              | ~chars |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **Correct the scope overreach in the preamble.** "You never run the image-generation pipeline" is true of _rendering_ and false of _approving_. Split the two, and name `approve_assets` where the sentence that denied it was.                                                                                                   | +350   |
| 2   | **The complete marker table** — all six `BranchMarker` kinds, replacing the three-row block. `[[line:]]` and `[[nextline:]]` described as machine-managed and **never to be written or removed by hand**.                                                                                                                         | +900   |
| 3   | **The closed-world sentence.** Branching is scene-granular and there is nothing finer: no variables, flags, counters, conditional lines, or per-route variants of a beat. If two readers should see different prose, that is two scenes — and if the author asks for something needing a condition, say so and propose the split. | +600   |
| 4   | **Line ids are allocated, never chosen.** Read the scene before anchoring an edit to one.                                                                                                                                                                                                                                         | +350   |
| 5   | **Resolve the `[[scene:]]` contradiction** — drop the marker-table row that describes the retired whole-file screenplay, keep the layout paragraph's rule.                                                                                                                                                                        | −150   |
| 6   | **A validation paragraph** naming `validate_inputs`, `story_graph` and `parse_fountain`, and stating: after any change under `scenes/`, validate and check the graph before committing.                                                                                                                                           | +700   |
| 7   | **A skills pointer that says _when_.** The prompt already says skills exist; it never says to look. One sentence: before a multi-scene structural job, call `discover_skills`.                                                                                                                                                    | +250   |
|     | **total**                                                                                                                                                                                                                                                                                                                         | +3,000 |

Items 1, 3 and 5 matter more than their length suggests, because each removes a part that
currently points the wrong way. Item 2 is short too, and leaving it out nearly lost the
line ids.

Two things were deliberately not added:

- **A wiki-navigation sentence.** This sentence belongs with `list_bible`, and writing it
  before `list_bible` exists would describe a tool the agent cannot call. It is reserved,
  runs to about 200 characters, and is written when
  [`navigating-the-story-bible.md`](navigating-the-story-bible.md) is acted on.
- **`docs/fountain.md` itself.** The file is 490 lines, mostly a general introduction to
  Fountain for humans. The six-row table and the closed-world sentence do the work, and
  they are about 3% of the file.

### Keeping the table honest

The failure in the companion report was that documentation drifted behind code:
`BranchMarker` gained `outfit`, `line` and `nextline`, and the prompt did not. The union
is exhaustive, so a test can assert that every kind's marker name appears in
`SYSTEM_PROMPT`. Such a test is cheap and would have caught this drift. It checks presence
rather than correctness, which is the limit of what a test can check here, and that limit
belongs in a note beside the test so that no reader relies on it for more.

Pair it with a second assertion on total length against the 25,000 budget, so that
assertions cover both numbers this section commits to.

## The skills: one new one

This rule disqualifies most of what a skill might have carried. Format rules cannot be a
skill, because they are project-local, deletable, and needed by an agent that does not
know it needs them. Validation cannot be a skill, because it must happen on the ordinary
path. What remains is genuinely procedural work that is long, optional, and recognisable
in advance.

Two exist and should stay: `full-production` (the nine-phase sequence) and
`new-character`.

A `branching` document should be added. That document is the playbook the 19 August
conversations needed and did not have. The agent would have known to look for a
`branching` document, unlike the format rules, because both sessions opened with the
author naming the job.

It covers the following, none of which fits the prompt:

- Describes the three shapes a branching VN takes (one trunk with a late fork, an early
  fork that reconverges, fully separate routes) and what each costs in scenes. The author
  chose the middle shape from a list the agent had to construct on the spot after two
  sessions of confusion.
- Split a shared scene into per-route chunks by calling `newScene` for each route, moving
  the prose, wiring the routes with `[[choice:]]` from the fork and `[[next:]]` back to
  the reconvergence point, then running `story_graph` to prove every route reaches an
  ending and nothing is orphaned. `newScene` leaves a scene unreachable until it is wired,
  and that wiring step is the one that gets skipped.
- Covers the naming convention `<route>_<beat>` (`em_landing`, `wr_truth`), which emerged
  here and worked, and the reason a scene id cannot be changed later.
- The format has no mechanism for prose that varies without a scene boundary, so an author
  who wants it must split the scene or go without.

That is ~60 lines of prose that is useful only during a restructure. That makes it a
skill.

**Deliberately not skills.** Each of the following was considered:

- _`format-rules`_ — holds the disqualification described above. Its content goes in the
  prompt.
- _`revise-scenes`_ — covers bulk revision at scale. The case is real and recurs in the
  transcripts, but the write-up would say little more than "batch your calls", which
  points to a missing `deleteLines` op rather than a procedure (§4).
- _`approve-artwork`_ — Four sessions hit friction, and the procedure was not the cause.
  The tool works perfectly once it is reached. The friction belongs to item 1 of the
  prompt table rather than to a skill.

## What is neither: five code changes

Some findings cannot be fixed by telling the agent anything, because the failure is that
nothing checks. Adding a sentence to the prompt would promise the behavior rather than fix
it. For item 3, the prompt already makes that promise.

1.  1. **A diagnostic for an unrecognised `[[…]]` note.** `scenes.ts:147` silently drops
       anything `parseBranchMarker` does not recognise, at no severity. So
       `[[if: ember]]`, `[[route: em]]`, and `[[choice: "x" => s13]]` (`=>` for `->`) all
       change or fail to change the story graph without any diagnostic. Add one new code
       to the validator that already runs, naming the file, the line, and the six legal
       kinds. This is the single highest-value change in either report, because it is the
       only one that catches an invented notation the day it is written rather than two
       days later when a human reads the file.
2.  2. **`git_commit` validates and refuses on error severity.** The prompt already says
       it does ("Block a commit on error-severity validation"), but nothing in the code
       does. The transcripts show the rule held on 14 commits in 20. Implementing it turns
       a rule the model must remember into a behavior of the ordinary path, and makes item
       6 of the prompt table a description rather than an instruction.
3.  3. **A second slugline or second front-matter `scene:` in one chunk** is a diagnostic.
       No chunk in `examples/test4` contains one, but the author believed they were
       looking at this case, the case is unguarded, and guarding it costs one comparison.
4.  4. **A batch delete for `edit_scene`.** `insertLines` shipped from
       [`../plans/archive/INDEX.md#improving-the-authoring-agent`](../plans/archive/INDEX.md#improving-the-authoring-agent)
       §3.2 and the symmetric half never shipped. The corpus holds 159 `deleteLine` calls
       against 11 `insertLines`. That plan's own argument ("a 40-line scene goes from 41
       calls to two") applies unchanged to rewriting one, which still costs 40 deletes
       plus an insert, and rewriting scenes is most of this job.
5.  5. **`writeFileAtomic` cleans up its temp.** fs.ts:14-27 writes a temp sibling then
       renames with no `try`/`finally`; examples/test4/scenes/wr_truth.md.tmp-b124425f has
       sat in the scenes directory since 18 August. Add an `unlink` in a `finally`.

The other report also covers `list_bible` and the three second-order effects it unlocks,
which are not repeated here.

## How this sequences

This does not commit the project to waves, but the dependencies are real and worth
stating:

- **Items 1, 2 and 5 in the prompt** (scope overreach, marker table, `[[scene:]]`
  contradiction) are independent of everything else and caused the damage. They are also
  the cheapest to fix.
- **Code change 1** (the unknown-marker diagnostic) should land with or before prompt item
  3, so that the diagnostic enforces the closed-world sentence rather than leaving it as
  advice.
- **Code change 2** (`git_commit` validates) should land before prompt item 6. Otherwise
  item 6 becomes the second place in the prompt that describes a validation no code
  performs.
- **The `branching` skill** requires prompt item 7 to be reachable, and requires the
  closed-world sentence to exist, so that the skill elaborates a rule rather than
  introduces one.
- **`list_bible`** is independent of all of it.

## Open questions

- **Should skills have a built-in root?** `skillDirs` already takes `extraDirs`
  (skills.ts:62), so a bundled root that every project sees is reachable without new
  architecture. A bundled root would make a skill a legitimate home for knowledge that
  must always be present, and would change the answer in §1, because a
  shipped-with-the-app skill is not deletable by a project the way a scaffolded one is.
  Decide this before the `branching` skill is written, because whether it ships in
  `templates/basic/` or beside the code depends on the answer.
- **Does anything tell the agent a skill is relevant?** Even with §2's pointer, the model
  must choose to call `discover_skills` on a turn where it does not yet know it needs
  help. A one-line skill index in the generated project map would cost ~40 characters per
  skill, and the model would read it directly instead of searching. That space comes out
  of the map's budget, which
  [`navigating-the-story-bible.md`](navigating-the-story-bible.md) is separately arguing
  to shrink.
- **Is the marker-name test enough?** The test proves that each kind is mentioned, not
  that the sentence beside it is true, and this failure was a missing row, which the test
  does catch. A prose-correctness check is not available, so the residual risk is a row
  that goes stale rather than a row that is absent. That risk is probably acceptable, and
  it is worth stating explicitly rather than leaving it implied.
- **What does the prompt budget do when it is hit?** Neither report gets near 25,000, so
  the question is hypothetical today. A budget with no stated overflow policy will be
  exceeded without notice. The build should refuse rather than truncate, because the
  cached prefix must be byte-stable.
- **How much of this is Gemini-specific?** All fourteen threads are `gemini-2.5-flash`.
  The prompt defects are real for any model, but the positional attention argument in §2
  (the top is read closely, line 109 is not read at all) is the claim most likely to be a
  property of this model rather than of prompts. Running one thread of the same work on a
  larger model would settle whether the placement rule is a general principle or a
  fast-model accommodation.

# What the agent knows about the story format

Status: **not started.**

What to change so the authoring agent stops inventing notation the format does not have, stops
mistaking the project's own line ids for junk, and cannot commit a scene that fails validation.
Derived from [`../research/what-the-agent-knows-and-where-it-lives.md`](../research/what-the-agent-knows-and-where-it-lives.md)
and the report it consolidates,
[`../research/story-format-rules-and-a-scene-lint.md`](../research/story-format-rules-and-a-scene-lint.md).
The reports say what is wrong and where each fix belongs; this plan says what to write.

The rule it implements, in one line: **the prompt carries what must never be got wrong, a skill
carries a procedure the agent will go looking for once it knows the job, and the code carries
anything that can be checked.**

<!-- toc -->

- [Scope](#scope)
- [1. The prompt](#1-the-prompt)
  * [1.1 The preamble denies a capability the agent has](#11-the-preamble-denies-a-capability-the-agent-has)
  * [1.2 The marker table, all six kinds](#12-the-marker-table-all-six-kinds)
  * [1.3 Branching is scene-granular, and there is nothing finer](#13-branching-is-scene-granular-and-there-is-nothing-finer)
  * [1.4 Line ids are allocated, never chosen](#14-line-ids-are-allocated-never-chosen)
  * [1.5 Validate what you changed](#15-validate-what-you-changed)
  * [1.6 A skills pointer that says when](#16-a-skills-pointer-that-says-when)
  * [1.7 Two tests, so both numbers are enforced rather than remembered](#17-two-tests-so-both-numbers-are-enforced-rather-than-remembered)
  * [1.8 What changing the prompt costs](#18-what-changing-the-prompt-costs)
- [2. The lint hole: a note that looks like a marker and is not](#2-the-lint-hole-a-note-that-looks-like-a-marker-and-is-not)
  * [2.1 Two codes, not one](#21-two-codes-not-one)
  * [2.2 Where it goes](#22-where-it-goes)
  * [2.3 Corrected from the report: a chunk with two scenes is already caught](#23-corrected-from-the-report-a-chunk-with-two-scenes-is-already-caught)
- [3. `git_commit` validates](#3-git_commit-validates)
- [4. The `branching` skill](#4-the-branching-skill)
- [5. Two ergonomics fixes](#5-two-ergonomics-fixes)
- [6. Waves](#6-waves)
- [Deliberately out of scope](#deliberately-out-of-scope)
- [Open questions this plan decides](#open-questions-this-plan-decides)

<!-- tocstop -->

## Scope

Five things ship: a rewritten section of `SYSTEM_PROMPT`, two new validator diagnostics, a
validating `git_commit`, one new skill, and two small ergonomics fixes. Everything is inside
`packages/authoring`, `packages/model`, `packages/parse`, `packages/util` and `templates/basic`.
Nothing in the desktop app changes.

## 1. The prompt

`SYSTEM_PROMPT` (`packages/authoring/src/context.ts:18`) is **9,754 characters** across 138 lines.
The budget is **25,000 characters** — see §1.7 for the units decision — so everything below lands it
near 12,800 with 12,000 to spare. Room is not the constraint and never was; placement is. Two
observations from the transcripts drive the ordering:

- The model quoted the prompt's **first paragraph** back as its reason for refusing, in four
  separate sessions.
- `[[outfit:]]` is mentioned once, at line 109, inside a paragraph about art inheritance. It was
  never used as a marker in fourteen sessions.

So a contradiction near the top costs more than an omission near the bottom, and §1.1 — which is
almost entirely a deletion — is the highest-value edit in this section.

### 1.1 The preamble denies a capability the agent has

Line 20 today:

```
You work ONLY on these source files; you never run the image-generation pipeline.
```

That is true of rendering and false of approving, and the agent read it the broad way: four
sessions refused `approve_assets` by quoting this sentence, in a project where approval was the
thing the author had asked for. Replace it:

```
You work ONLY on these source files. You do not render art: nothing you can call starts a run or
draws a picture. Approving art IS yours — when the author says a portrait or a plate is good, call
approve_assets, which takes no arguments because the authority is the author's own words rather
than yours.
```

### 1.2 The marker table, all six kinds

Lines 50–54 list three of `BranchMarker`'s six kinds (`packages/parse/src/branch.ts:14-20`).
`[[outfit:]]` is forty lines away in another paragraph; `[[line:]]` and `[[nextline:]]` appear
nowhere, though they sit on every element of every scene in a migrated project. That omission is
what led one session to call the ids "non-standard" and another to conclude the scheme was inert
and offer to strip it from all forty scenes. Replace the block with:

```
FOUNTAIN + BRANCH MARKERS: standard Fountain, plus markers inside notes ([[ ... ]]). These are all
of them — a note the list does not cover is inert, read by nothing:
  [[choice: "Tell the truth" -> s13]] a labelled branch edge; one marker per option
  [[next: s13]]                       a linear continuation ([[goto: s13]] is the same marker)
  [[outfit: aiko=uniform]]            what one character wears for this whole scene, wherever the
                                      marker sits; ids both sides of the =, no spaces, one per
                                      character
  [[line: L4]]                        the allocated id of the element below it — MACHINE-MANAGED
  [[nextline: 12]]                    the scene's id allocator's high-water mark — MACHINE-MANAGED
Never write, renumber, move or delete a [[line:]] or [[nextline:]] marker, and never offer to tidy
them away. They are allocated by the project, and every shot in the storyboard is keyed on them:
stripping them from a scene re-points or destroys the pictures already drawn for it. A scene that
carries them is not non-standard; a scene without them has simply not been through line-id
assignment yet.
[[scene: s12_rooftop]] is the sixth kind and belongs only to the retired whole-file screenplay
form. Do not write one in scenes/ — a chunk's id is its filename, and a body marker that disagrees
is reported and ignored.
Scene headings (INT./EXT.) mine locations and time-of-day variants.
```

The last paragraph settles the contradiction between the old marker row and the layout paragraph at
line 37, which already says a chunk body carries no `[[scene:]]` marker. Both survive today, fifteen
lines apart, disagreeing.

### 1.3 Branching is scene-granular, and there is nothing finer

The mess in `examples/test4` was not two scenes in one file. It was an invented conditional — five
mutually exclusive `(Ember path) …` paragraphs stacked as consecutive narration in six trunk
scenes — reached for because the prompt lists what the format has and never states the boundary.
New paragraph, immediately after the marker table:

```
BRANCHING IS SCENE-GRANULAR AND THERE IS NOTHING FINER. The format has no variables, flags,
counters, conditionals, or per-route variants of a line. Two readers on two routes read the same
scene file byte for byte, or they read different scenes. If they should read different prose, that
is two scenes: [[choice:]] to fork, [[next:]] to rejoin. Do not invent a notation for it, and do
not label prose with the route it belongs to — "(Ember path) she hesitates" is read aloud to every
reader on every route. When the author asks for something that would need a condition, say the
format has none and propose the scene split instead.
```

### 1.4 Line ids are allocated, never chosen

One paragraph, after §1.3:

```
LINE IDS ARE ALLOCATED, NEVER CHOSEN. edit_scene addresses a line by an id the project gave it, so
read the scene before anchoring an edit to one. Do not compose an id from a line's position, and do
not carry an id across a rewrite: rewritten prose is a new line, and the shot that pointed at the
old one is meant to notice.
```

### 1.5 Validate what you changed

`HOW YOU WORK`'s first bullet says _"Block a commit on error-severity validation"_ — a rule the
model must remember, phrased as if something enforced it. §3 makes it true; this paragraph then
describes the world rather than instructing the agent about it. It lands after §1.4:

```
VALIDATE WHAT YOU CHANGED. After any edit under scenes/, run validate_inputs: it reports schema and
cross-file diagnostics and fails on error severity. Run story_graph after wiring or rewiring a
branch and read it for unreachable scenes and dead ends — the graph is the only thing that shows a
scene you created and never linked. parse_fountain is the cheaper read when you need ids, choices
and next and nothing else. git_commit runs validate_inputs itself and refuses on an error, so a
broken change cannot reach a commit; looking before you get there is still yours.
```

### 1.6 A skills pointer that says when

The existing skills bullet says skills exist and never says to look. Extend it:

```
- Skills are reusable playbooks under .aiagent/skills/; discover_skills lists them (search does not
  reach them), and create_skill writes one when the author asks for a repeatable procedure. A skill
  you write is prose — only a person can add one that runs a script. Call discover_skills before a
  job that spans many scenes or changes the story's shape: a playbook may already exist for it.
```

### 1.7 Two tests, so both numbers are enforced rather than remembered

The failure in §1.2 is documentation drifting behind code: `BranchMarker` gained three kinds and the
prompt did not. The union is exhaustive, so a test can catch it — but only if the kinds exist at
runtime. Add to `packages/parse/src/branch.ts`, beside the union:

```ts
/** Every marker kind, at runtime. Kept in step with {@link BranchMarker} by the check below. */
export const BRANCH_MARKER_KINDS = [
  'scene',
  'choice',
  'next',
  'outfit',
  'line',
  'nextline',
] as const satisfies readonly BranchMarker['kind'][];

// Fails to compile if a kind is added to the union and not to the array.
type _AllKindsListed = BranchMarker['kind'] extends (typeof BRANCH_MARKER_KINDS)[number]
  ? true
  : never;
```

Then two assertions in `packages/authoring/src/tests/context.test.ts`:

- every kind in `BRANCH_MARKER_KINDS` appears in `SYSTEM_PROMPT` as `[[<kind>:`, except `goto`
  which is a synonym rather than a kind;
- `SYSTEM_PROMPT.length` is at most `25_000`.

State the limit of the first one in a comment beside it: it proves each kind is **mentioned**, not
that the sentence beside it is true. The failure it is written for was a missing row, which it
catches; a row that goes stale rather than absent is residual risk a test cannot reach.

### 1.8 What changing the prompt costs

`SYSTEM_PROMPT` is the first segment of the byte-stable cached prefix
([`prompt-caching-and-deferred-tool-loading.md`](prompt-caching-and-deferred-tool-loading.md)), so
editing it invalidates the cached prefix of every conversation in flight — one full-price re-read
each, once. That is the right price and worth paying in one wave rather than three, which is why
§1.1–§1.6 land together.

## 2. The lint hole: a note that looks like a marker and is not

`packages/model/src/scenes.ts:146-147`:

```ts
const marker = parseBranchMarker(el.text);
if (!marker || !current) break;
```

Anything `parseBranchMarker` declines is dropped in silence, at no severity. So `[[if: ember]]`,
`[[route: em]]`, `[[outfit: aiko = uniform]]` (spaces around the `=`) and
`[[choice: "Tell the truth" => s13]]` (`=>` for `->`) all pass validation with nothing said — and
the last one silently changes the story graph, because the edge it meant to draw is simply absent.

The write path is already strict: `branchpatch.ts:151` rejects anything that cannot survive
`parseBranchMarker` before a byte is written. But `edit_branches` is not how an invented marker
arrives — it arrives as the *text of a prose line* through `edit_scene`, which has no reason to
inspect it. The read path is the only place this can be caught.

### 2.1 Two codes, not one

`[[ … ]]` is ordinary Fountain note syntax and authors write ordinary notes in it. `[[TODO: fix the
ending]]` must not become an error. So the check splits by how confident it can be:

| what                                                                | code                      | severity    |
| ------------------------------------------------------------------- | ------------------------- | ----------- |
| a key `parseBranchMarker` recognises, whose value it could not parse | `unparsed_branch_marker`  | **error**   |
| any other `key: value`-shaped note                                   | `unknown_marker`          | **warning** |
| a note with no colon at all                                         | —                         | none        |

The recognised keys are the eight `parseBranchMarker` tests for: `scene`, `id`, `next`, `goto`,
`outfit`, `line`, `nextline`, `choice`. A note using one of those and failing to parse is
unambiguously a mistake, which is what earns it error severity and, after §3, a blocked commit.
Anything else is a guess, so it warns and names the six kinds in its message.

`unknown_marker` will fire on legitimate prose notes. That is accepted rather than regretted: a
warning that says _"`[[route: em]]` is not one of the six branch markers and is read by nothing"_
costs an author one glance and would have caught the invented conditional the day it was written.
If it proves noisy in practice, the narrowing move is to require a single lowercase word before the
colon, not to drop the check.

### 2.2 Where it goes

In the `case 'note':` arm, before the existing early return, so a note is classified once:

```ts
case 'note': {
  const marker = parseBranchMarker(el.text);
  if (!marker) {
    noteDiagnostic(el.text);   // pushes one of the two codes above, or nothing
    break;
  }
  if (!current) break;
  …
```

Two details:

- **`where` is the scene id**, per `Diagnostic` (`packages/types/src/model.ts:19-25`), which has no
  line field. The message carries the note's text verbatim, trimmed to ~60 characters, which is what
  makes it findable — the note is unique text in the file.
- **A note before the first slugline still reports.** `current` being undefined is why the existing
  code returns early; the diagnostic must not inherit that, because a marker stranded above the
  heading is exactly the kind of thing worth saying. Use `opts.sceneId ?? current?.id` for `where`.

Tests in `packages/model/src/tests/`: one per row of the table, plus the `=>` case specifically —
it is the one that changes the graph — plus a plain colon-less note proving silence.

### 2.3 Corrected from the report: a chunk with two scenes is already caught

[`what-the-agent-knows-and-where-it-lives.md`](../research/what-the-agent-knows-and-where-it-lives.md)
lists "a second slugline or second front-matter `scene:` in one chunk" as an unguarded fourth code
change. It is guarded, and has been: `entities.ts:129-141` reports `scene_body` at error severity
when `splitScenes` yields anything other than exactly one scene, and `scene_id` when the
front-matter's `scene:` disagrees with the filename. A body `[[scene:]]` marker that disagrees is
`ignored_scene_marker`, a warning, at `scenes.ts:200-206`.

So the author's original diagnosis — branches embedded in single scene files — could not have
produced a silent failure. Nothing to build. Worth recording here because the belief is reasonable
and will recur.

## 3. `git_commit` validates

`tools.ts:1318-1324` checks `isRepo` and commits. The prompt has promised otherwise since it was
written, and the transcripts show that discipline holding on 14 commits out of 20.

```ts
async run(a, ctx) {
  if (!(await ctx.git.isRepo())) return fail('Not a git repository (offer git_init).');
  const { model } = await ctx.workspace.load();
  const errors = model.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) return fail(`Refusing to commit: ${formatDiagnostics(errors)}`);
  …
```

Three decisions inside that:

- **Errors only.** Warnings do not block, matching `validate_inputs`'s own `ok` and the prompt's
  "warn, do not block on soft issues".
- **The refusal names every error**, not a count. The agent's next act is to fix them, and a count
  costs it a second call to learn what it already could have been told.
- **No override argument.** A `force` flag is a flag the model will learn to pass. If an author
  genuinely needs to commit a broken tree, they have git.

This makes §1.5 a description of the system rather than a rule the model must remember, which is
the whole point of routing it to code.

## 4. The `branching` skill

One new skill, `templates/basic/.aiagent/skills/branching/SKILL.md`, ~60 lines. It is the playbook
the 19 August conversations needed; unlike the format rules it can be a skill, because the agent
would have known to look — both sessions opened with the author naming the job.

What it covers:

- **The three shapes and what each costs in scenes** — one trunk with a late fork, an early fork
  that reconverges, fully separate routes. The author picked the middle one from a list the agent
  had to construct on the spot after two sessions of confusion.
- **How to split a shared scene into per-route chunks**: `newScene` per route, move the prose,
  `[[choice:]]` from the fork, `[[next:]]` back to the reconvergence point, then `story_graph` to
  prove every route reaches an ending and nothing is orphaned. `newScene` leaves a scene unreachable
  until it is wired, and that is the step that gets skipped.
- **`<route>_<beat>` naming** (`em_landing`, `wr_truth`) — the convention that emerged here and
  worked — and that a scene id cannot be changed afterwards, because a rename is not a thing scenes
  have.
- **The refusal to hand back**, elaborating §1.3 rather than introducing it: prose that varies
  without a scene boundary has no mechanism, so the answer is a split or nothing.

It ships in `templates/basic/` beside `full-production` and `new-character`, which means projects
scaffolded before it do not get it. Accepted: a project without this skill loses a playbook, not a
guarantee — that asymmetry is exactly why the format rules are in the prompt instead. See the open
question on a bundled skill root below.

## 5. Two ergonomics fixes

**A batch delete for `edit_scene`.** `insertLines` shipped from
[`improving-the-authoring-agent.md`](improving-the-authoring-agent.md) §3.2 and the symmetric half
did not: the corpus has 159 `deleteLine` calls against 11 `insertLines`. Add `deleteLines` taking
`lines: string[]`, one entry in `SCENE_OP_ARGS` (`tools.ts:764-777`) and one `sceneDecider` case,
deleting in a single `ScriptState` transition so a partial failure leaves nothing half-removed. That
plan's own argument — "a 40-line scene goes from 41 calls to two" — applies unchanged to rewriting
one, which still costs 40 deletes plus an insert.

**`writeFileAtomic` cleans up its temp.** `packages/util/src/fs.ts:14-24` writes a temp sibling and
renames with no `try`/`finally`; `examples/test4/scenes/wr_truth.md.tmp-b124425f` has sat in a
scenes directory since 18 August, where it is neither a scene nor invisible. Wrap the write and
rename, `unlink` the temp in a `finally`, swallow the unlink's own error — a failed cleanup must not
mask the failure that caused it.

## 6. Waves

Each wave is one commit, and each is green (`pnpm check`, `pnpm test`, `pnpm lint`) on its own.

1. **The prompt, all of §1.** §1.1–§1.6 as one edit plus the two tests and `BRANCH_MARKER_KINDS`.
   Independent of everything else, cheapest, and where the damage was. One cache invalidation for
   all of it (§1.8).
2. **The two diagnostics (§2).** Lands with or after §1.3 so the closed-world sentence has
   enforcement behind it rather than being advice.
3. **`git_commit` validates (§3).** Must land no later than wave 1 in the author's reading order —
   if wave 1 shipped alone for long, the prompt would carry a second promise nothing keeps. In
   practice: land it in the same session as wave 1, and if only one of the two can ship, ship this
   one first.
4. **The `branching` skill (§4).** Wants §1.6 reachable and §1.3 to exist, so it elaborates a rule
   rather than introducing one.
5. **The ergonomics fixes (§5).** Independent of all of it; last because nothing else waits on them.

Finishing the plan means the checklist in [`../conventions.md`](../conventions.md#finishing-a-plan):
audit comments, no `CLAUDENOTE:` left, and update `docs/vnauthor.md` (the tool table gains
`deleteLines`) and this file's status line.

## Deliberately out of scope

- **`list_bible` and the wiki-navigation prompt sentence.**
  [`navigating-the-story-bible.md`](../research/navigating-the-story-bible.md) is independent of
  every wave here and has open questions this plan cannot settle for it — what a truncated listing
  does, and whether `match` ranks or filters. It gets its own plan. The ~200 characters of prompt it
  needs are reserved, not spent, because describing a tool the agent cannot call is worse than
  saying nothing.
- **A `format-rules` skill.** Disqualified by the rule at the top: skills are project-local and
  deletable (`examples/test4` has no `.aiagent/` at all) and are never injected, so a fact the agent
  needs in order not to destroy something cannot live in one. The agent that offered to strip
  `[[line:]]` from forty scenes thought it was tidying up; it would never have gone looking.
- **A `revise-scenes` skill.** What it would say is "batch your calls", which is §5's missing op.
- **An `approve-artwork` skill.** Four sessions of friction and none of it procedural. The tool
  works once reached, so this is §1.1.
- **Anything in the desktop app.** No command, editor or menu changes.

## Open questions this plan decides

- **The budget's units are characters.** "25k" was given without one. Characters matches everything
  else here — the generated map is budgeted at 8,000, a bible query at 4,000 — and lands the prompt
  around 6,800 tokens, a sane always-on cost against a cached prefix. Twenty-five thousand *tokens*
  would be ~92,000 characters, nine times the current prompt, and nothing identified needs it.
- **Overflow refuses rather than truncates.** §1.7's length assertion fails the build. A byte-stable
  cached prefix cannot be quietly trimmed at the end, and a budget nobody measures is not a budget.
- **The `branching` skill ships in `templates/basic/`, not a bundled root.** `skillRoots` already
  takes `extraDirs` (`skills.ts:61-62`) and nothing passes one, so a root every project sees is
  reachable without new architecture — but it changes what a skill *is* (undeletable, versioned with
  the app, not the project's) and that decision should be made for its own reasons rather than as a
  side effect of shipping one playbook. Revisit when a second skill wants to be undeletable.
- **`unknown_marker` warns rather than errors.** Argued in §2.1: `[[ … ]]` is ordinary note syntax
  and this check cannot tell an invented marker from a note, so it says what it sees and lets the
  author judge. Only a *recognised* key that fails to parse is an error.

Not decided here, and left where the report put it: how much of the positional-attention argument in
§1 is a property of `gemini-2.5-flash` rather than of prompts. All fourteen threads are that model.
The prompt defects are real for any model; the claim that the top is read closely and line 109 is
not would be settled by one thread of the same work on a larger one.

# What the agent knows about the story format

Status: **shipped**, in five commits, one per wave (4 and 5 landed in the other order, so the
skill could name `deleteLines` after it existed). Two deliberate deviations, both pinned by a
test: §2.2 compares only the notes the model does *not* keep rather than raw note text, because
the serializer re-emits `[[goto:]]` canonically and a raw diff would refuse edits to any scene
carrying one; and §2.4's `droppedWarnings` row was dropped, because `sceneChunksFromScript`
already merges `splitScenes`' diagnostics, so the `vngen import` door is covered and the row
would have double-reported.

What to change so the authoring agent stops inventing notation the format does not have, stops
mistaking the project's own line ids for junk, and so a note nothing understands is reported rather
than deleted behind the author's back. Derived from
[`../research/what-the-agent-knows-and-where-it-lives.md`](../../research/what-the-agent-knows-and-where-it-lives.md)
and the report it consolidates,
[`../research/story-format-rules-and-a-scene-lint.md`](../../research/story-format-rules-and-a-scene-lint.md),
then rewritten against
[`../research/pressure-test-what-the-agent-knows-about-the-story-format.md`](../../research/pressure-test-what-the-agent-knows-about-the-story-format.md),
which killed one whole section of an earlier draft and turned another inside out.

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
- [2. The note nobody reads and nobody keeps](#2-the-note-nobody-reads-and-nobody-keeps)
  * [2.1 How one actually gets in — not through the agent](#21-how-one-actually-gets-in--not-through-the-agent)
  * [2.2 The larger half: the next write erases it](#22-the-larger-half-the-next-write-erases-it)
  * [2.3 Severity follows consequence, not confidence](#23-severity-follows-consequence-not-confidence)
  * [2.4 Where the code goes](#24-where-the-code-goes)
- [3. The `branching` skill](#3-the-branching-skill)
- [4. Two ergonomics fixes](#4-two-ergonomics-fixes)
- [5. Waves](#5-waves)
- [Already true, and believed otherwise](#already-true-and-believed-otherwise)
- [Deliberately out of scope](#deliberately-out-of-scope)
- [Open questions this plan decides](#open-questions-this-plan-decides)

<!-- tocstop -->

## Scope

Four things ship: a rewritten section of `SYSTEM_PROMPT`, two new validator diagnostics plus a
refusal on the scene write path, one new skill, and two small ergonomics fixes. Everything is inside
`packages/authoring`, `packages/model`, `packages/parse`, `packages/scriptedit`, `packages/util` and
`templates/basic`. Nothing in the desktop app changes.

An earlier draft had a fifth item — making `git_commit` validate. It already does; see
[Already true, and believed otherwise](#already-true-and-believed-otherwise).

## 1. The prompt

`SYSTEM_PROMPT` (`packages/authoring/src/context.ts:18`) is **9,754 characters** across 138 lines.
The budget is **25,000 characters** — see §1.7 for the units decision — so everything below lands it
near 12,800 with 12,000 to spare. Room is not the constraint and never was; placement is. Two
observations from the transcripts drive the ordering:

- The model quoted the prompt's **first paragraph** back as its reason for refusing, in four
  separate sessions.
- `[[outfit:]]` is mentioned once, at `context.ts:126` — line 109 of the prompt's own text — inside a
  paragraph about art inheritance. It was never used as a marker in fourteen sessions.

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

`context.ts:50-54` lists three of `BranchMarker`'s six kinds
(`packages/parse/src/branch.ts:14-20`). `[[outfit:]]` is seventy lines away in another paragraph;
`[[line:]]` and `[[nextline:]]` appear nowhere, though they sit on every element of every scene in a
migrated project. That omission is what led one session to call the ids "non-standard" and another
to conclude the scheme was inert and offer to strip it from all forty scenes. Replace the block
with:

```
FOUNTAIN + BRANCH MARKERS: standard Fountain, plus markers inside notes ([[ ... ]]). Five you may
write, and a sixth that belongs only to the retired whole-file form. Nothing else is a marker: a
note outside this list is read by nothing and is dropped from the scene the next time it is
written.
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
The sixth, [[scene: s12_rooftop]], belongs to the retired whole-file screenplay. Do not write one
in scenes/ — a chunk's id is its filename, and a body marker that disagrees is reported and
ignored.
Scene headings (INT./EXT.) mine locations and time-of-day variants.
```

The last paragraph settles the contradiction between the old marker row and the layout paragraph at
line 37, which already says a chunk body carries no `[[scene:]]` marker. Both survive today, fifteen
lines apart, disagreeing.

The third sentence — a note outside the list is dropped on the next write — is true today and
undocumented anywhere the agent can see it (§2.2). It stays true after §2 ships; what changes is
that the drop stops being silent.

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

Note what this paragraph is and is not doing. An invented *marker* is already impossible for the
agent to write (§2.1); an invented *prose convention* is what actually happened, and no code can
catch it, because "(Ember path) she hesitates" is a well-formed action line. This paragraph is the
whole defence against the failure that prompted the work.

### 1.4 Line ids are allocated, never chosen

One paragraph, after §1.3:

```
LINE IDS ARE ALLOCATED, NEVER CHOSEN. edit_scene addresses a line by an id the project gave it, so
read the scene before anchoring an edit to one. Do not compose an id from a line's position, and do
not carry an id across a rewrite: rewritten prose is a new line, and the shot that pointed at the
old one is meant to notice.
```

### 1.5 Validate what you changed

`HOW YOU WORK`'s first bullet says _"Block a commit on error-severity validation"_, phrased as a rule
the model must remember. It is in fact a property of the system — `loop.ts:813` blocks the commit —
so this paragraph describes the world rather than instructing the agent about it, and needs no code
behind it. It lands after §1.4:

```
VALIDATE WHAT YOU CHANGED. After any edit under scenes/, run validate_inputs: it reports schema and
cross-file diagnostics and fails on error severity. git_commit refuses while any error stands, so a
broken change cannot reach a commit — but a warning will not stop you, and an unreachable scene is
only a warning. Run story_graph after wiring or rewiring a branch and read it for unreachable
scenes and dead ends; the graph is the only thing that shows a scene you created and never linked.
parse_fountain is the cheaper read when you need ids, choices and next and nothing else.
```

The `unreachable_scene`-is-a-warning clause matters: it is `build.ts:356`, and without the clause the
paragraph implies the commit gate catches the exact failure the `branching` skill exists to prevent.

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

// `satisfies` catches an entry that is not a kind; this catches a kind that is not an entry. The
// assignment is what makes it fail — a type alias that resolves to an error object still compiles.
type AllKindsListed = BranchMarker['kind'] extends (typeof BRANCH_MARKER_KINDS)[number]
  ? true
  : { error: 'a BranchMarker kind is missing from BRANCH_MARKER_KINDS' };
const _allKindsListed: AllKindsListed = true;
```

The conditional does not distribute — `BranchMarker['kind']` is a concrete union, not a naked type
parameter — which is what makes the subset test mean what it should.

Then two assertions in `packages/authoring/src/tests/context.test.ts`:

- every kind in `BRANCH_MARKER_KINDS` appears in `SYSTEM_PROMPT` as `[[<kind>:`;
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

## 2. The note nobody reads and nobody keeps

`packages/model/src/scenes.ts:146-147`:

```ts
const marker = parseBranchMarker(el.text);
if (!marker || !current) break;
```

Anything `parseBranchMarker` declines is dropped in silence, at no severity. Running the case rather
than reading it — `splitScenes` then `sceneToDoc`, on a body holding `[[if: ember]]` and
`[[choice: "Tell the truth" => s13]]` (`=>` for `->`):

```
diagnostics: []
choices:     []
reserialized body: "INT. ROOF - NIGHT\n\n[[nextline: 2]]\n\n[[line: L1]]\nShe hesitates.\n"
```

Three findings in one probe. No diagnostic. No choice edge — the typo really does change the story
graph with nothing said. And **both notes are gone from the re-serialized body**, which is the half
neither report saw.

### 2.1 How one actually gets in — not through the agent

The earlier draft said an invented marker arrives as the text of a prose line through `edit_scene`.
It cannot. `Scene` has no field that holds a note, so a `[[ … ]]` line the agent writes is absent
from the scene when `planSceneEdit` serializes it, `sceneToDoc(read.value.scene).body !== doc.body`,
and the edit is refused: _"Writing s1 would not read back as the scene it was written from."_
(`packages/scriptedit/src/apply.ts:66-80`). The lossless round-trip contract — `parse(write(scene)) ≡
scene` — already forbids it, `edit_branches` validates before writing (`branchpatch.ts:151`), and
`write_file` refuses `scenes/`.

So the three doors that remain are all outside the agent, which changes who this work is for:

- **A person editing a scene file.** The likeliest source and the one nothing else covers.
- **`vngen import`** of a legacy screenplay, carrying whatever notes the file had.
- **`git_restore`**, which writes bytes with no model in the path.

That is worth stating plainly: §2 is not a guard against the agent. It is a guard against everyone
else, on files the agent will later be blamed for.

### 2.2 The larger half: the next write erases it

Because the note is not in the model, the first `edit_scene` that writes that scene for **any**
reason writes it back without the note. An author's `[[TODO: fix the ending]]` is deleted by an
unrelated edit to line 4. `apply.ts:76` cannot catch it: it compares `sceneToDoc(read.value.scene)`
against `doc`, both derived from the model, so the note is already absent from both sides.

This outranks the reporting gap, and it is the same edit. `planSceneEdit` already holds the source
text (`input.sources`, `sources.ts`), so it can compare against what it was handed rather than only
against itself:

```ts
// A note the model cannot hold would vanish on write, and apply.ts's own round-trip cannot see it:
// both sides of that comparison come from the model. Compare against the source instead.
const before = noteTexts(parseFountain(source.script));
const after = noteTexts(parseFountain(doc.body));
const lost = before.filter((n) => !after.includes(n));
if (lost.length) {
  return { ok: false, message: `Writing ${scene.id} would drop ${lost.length} note(s) the model does not keep: ${lost.join(', ')}. Remove or fix them in the file first.` };
}
```

A refusal rather than a warning, because the alternative is losing an author's text to a write they
did not ask for and cannot see. `scriptedit` may import `@vn/parse` (`eslint.config.mjs:28`), so
this needs no new dependency edge. Two consequences to accept deliberately:

- **A scene holding a stray note becomes uneditable by the agent until a person fixes the file.**
  That is the honest state of affairs — the alternative is silent deletion — and the refusal names
  the note, so the agent can tell the author exactly what to remove.
- **This is why §2.3's severity table matters more than it looks.** With the refusal in place, an
  error-severity diagnostic on the same note would block commits *and* edits, on files the agent has
  no tool to repair.

### 2.3 Severity follows consequence, not confidence

An earlier draft split severity by how confident the checker could be: a recognised key that fails to
parse is "unambiguously a mistake", so error. `branch.ts` says otherwise, in comments, twice — a
malformed `[[outfit:]]` (`:37-38`) and a non-numeric `[[nextline:]]` (`:50-52`) are each documented as
**a plain note rather than a broken marker**, with a defined recovery. Erroring on them would overrule
a decision this plan never set out to touch.

The existing codes split by consequence (`dangling_goto` errors because an edge is broken;
`unknown_character` warns because a cue is only probably wrong), so this one does too:

| note                                                | what is lost                                | code                     | severity |
| --------------------------------------------------- | ------------------------------------------- | ------------------------ | -------- |
| `choice`, `next`/`goto` that fails to parse          | a story-graph edge, silently                | `unparsed_branch_marker` | error    |
| `line` that fails to parse                           | a shot's anchor; a fresh id is allocated    | `unparsed_branch_marker` | error    |
| `outfit`, `nextline`, `scene`/`id` that fails        | nothing — documented fallback to plain note | `unknown_marker`         | warning  |
| any other `key: value`-shaped note                   | nothing the model wanted                    | `unknown_marker`         | warning  |
| a note with no colon                                 | nothing                                     | —                        | none     |

`[[ … ]]` is ordinary Fountain note syntax and people write ordinary notes in it, so `unknown_marker`
will fire on legitimate prose. Accepted rather than regretted, and the census is reassuring as far as
it goes: across all forty scenes of `examples/test4` the only note keys that appear are `line` (214),
`nextline` (53), `next` (46) and `choice` (10) — not one stray note. That corpus is machine-written,
though, and §2.1 establishes that a human is the likeliest author of a stray note, so treat it as
weak evidence. If it proves noisy, narrow it to a single lowercase word before the colon rather than
dropping the check.

### 2.4 Where the code goes

**The diagnostic**, in the `case 'note':` arm of `splitScenes`, before the existing early return, so
a note is classified once:

```ts
case 'note': {
  const marker = parseBranchMarker(el.text);
  if (!marker) {
    strayNotes.push(el.text);   // classified below, where the scene's final id is known
    break;
  }
  if (!current) break;
  …
```

Stamped in the loop at `scenes.ts:194-208` rather than inline, for one reason worth writing down:
`Diagnostic.where` is an entity id (`packages/types/src/model.ts:19-25`) and that loop is where
`[[scene:]]` overrides are applied, so a diagnostic stamped earlier can carry an id the scene no
longer has. A note above the first slugline still reports — `current` being undefined is why the
existing code returns early, and the diagnostic must not inherit that, because a marker stranded
above the heading is exactly the kind of thing worth saying.

**The message follows `dropped_element`'s voice**, not a scolding one: _"`[[route: em]]` (scene
s12_rooftop) is not a branch marker; it will be absent from the scene the next time it is written."_
The note text is the only handle anyone has, since notes never become `SceneLine`s and no line id
addresses one.

**`droppedWarnings` gains the fourth row.** `packages/model/src/screenplay.ts:58-82` exists for
exactly this shape of problem — its comment promises to _"warn about everything the model does not
keep"_ — and its `DROPPED` list has three entries, none of them an unparsed note. Adding it there
covers the `vngen import` door from §2.1 with the code already written for it.

**Tests** in `packages/model/src/tests/`: one per row of §2.3's table, the `=>` case specifically
because it is the one that changes the graph, a colon-less note proving silence, and — in
`packages/scriptedit/src/tests/` — the §2.2 refusal, asserting the note survives on disk.

## 3. The `branching` skill

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
  until it is wired, that is the step that gets skipped, and `unreachable_scene` is a warning that
  will not block the commit (§1.5).
- **`<route>_<beat>` naming** (`em_landing`, `wr_truth`) — the convention that emerged here and
  worked — and that a scene id cannot be changed afterwards, because a rename is not a thing scenes
  have.
- **The refusal to hand back**, elaborating §1.3 rather than introducing it: prose that varies
  without a scene boundary has no mechanism, so the answer is a split or nothing.

It ships in `templates/basic/` beside `full-production` and `new-character`, which means projects
scaffolded before it do not get it. Accepted: a project without this skill loses a playbook, not a
guarantee — that asymmetry is exactly why the format rules are in the prompt instead. See the open
question on a bundled skill root below.

## 4. Two ergonomics fixes

**A batch delete for `edit_scene`.** `insertLines` shipped from
[`improving-the-authoring-agent.md`](improving-the-authoring-agent.md) §3.2 and the symmetric half
did not: the corpus has 159 `deleteLine` calls against 11 `insertLines`. Add `deleteLines` taking
`lines: string[]`, one entry in `SCENE_OP_ARGS` (`tools.ts:764-777`) and one `sceneDecider` case.
`lineops.ts:220-250` is the pattern to copy verbatim — a fold over the singular op threading `scenes`
through, refusing with `line N of M: … Nothing was deleted.` so a partial failure leaves nothing
half-removed. That plan's own argument — "a 40-line scene goes from 41 calls to two" — applies
unchanged to rewriting one, which still costs 40 deletes plus an insert.

**`writeFileAtomic` gets a random temp name and cleans it up.** `packages/util/src/fs.ts:14-24`
writes a temp sibling and renames with no `try`/`finally`; `examples/test4/scenes/wr_truth.md.tmp-b124425f`
has sat in a scenes directory since 18 August, where it is neither a scene nor invisible. Two things,
one edit: the suffix is `sha1(path + data.length)`, so two concurrent writers of the same path with
same-length data share a temp file and race — make it random. Then wrap the write and rename, and
`unlink` the temp in a `finally`, swallowing the unlink's own error so a failed cleanup cannot mask
the failure that caused it.

## 5. Waves

Each wave is one commit, and each is green (`pnpm check`, `pnpm test`, `pnpm lint`) on its own.

1. **The prompt, all of §1.** §1.1–§1.6 as one edit plus the two tests and `BRANCH_MARKER_KINDS`.
   Independent of everything else, cheapest, and where the damage was. One cache invalidation for
   all of it (§1.8). Nothing waits on it and it waits on nothing — the earlier draft's ordering
   constraint came from a commit gate that turned out to exist already.
2. **The write-path refusal (§2.2).** First of the two, deliberately: it stops an author's text being
   deleted, which is the only part of §2 that is losing something today.
3. **The diagnostics (§2.3, §2.4)**, including the `droppedWarnings` row. After wave 2, so the
   refusal is in place before a note starts being reported as an error anywhere.
4. **The `branching` skill (§3).** Wants §1.6 reachable and §1.3 to exist, so it elaborates a rule
   rather than introducing one.
5. **The ergonomics fixes (§4).** Independent of all of it; last because nothing else waits on them.

Finishing the plan means the checklist in [`../conventions.md`](../../conventions.md#finishing-a-plan):
audit comments, no `CLAUDENOTE:` left, and update `docs/vnauthor.md` (the tool table gains
`deleteLines`) and this file's status line.

## Already true, and believed otherwise

Two things an earlier draft planned to build, and one the parent reports got wrong. Recorded rather
than deleted, because each belief is reasonable and will recur.

- **`git_commit` already validates.** `loop.ts:813-819` intercepts the tool by name, calls
  `workspaceErrors()` (`loop.ts:894-899`, doc comment: _"the commit gate"_) and refuses while any
  error-severity diagnostic stands. `git log -S` puts it in `883d4a25`, the commit that implemented
  the agent. So the companion report's _"`git_commit` never validates, so the prompt's promise is
  discipline"_ is false — what the transcripts showed was `validate_inputs` run before 14 commits of
  20, which is a claim about the agent's habits and stands on its own. Building a second copy inside
  `gitCommitTool` would put one rule in two places, which `tools.ts:759-762` already names as how two
  answers start to disagree. The gate is keyed on the tool name **in the agent loop**, so a caller
  outside the loop is ungated; the agent is the only caller today, and that is deliberate rather than
  missed.
- **A chunk holding two scenes is caught.** `entities.ts:129-141` reports `scene_body` at error
  severity when `splitScenes` yields anything other than exactly one scene, and `scene_id` when the
  front-matter's `scene:` disagrees with the filename; a body `[[scene:]]` that disagrees is
  `ignored_scene_marker`, a warning, at `scenes.ts:200-206`. The author's original diagnosis —
  branches embedded in single scene files — could not have produced a silent failure.
- **`vngen run` refuses on an error** (`assertValid`, `apps/cli/src/commands.ts:364`), while `export`
  and `screenplay` report and proceed on the stated grounds that a projection may describe a broken
  story (`commands.ts:161,194`). Worth knowing before choosing a severity: an error stops a build,
  not just a commit.

## Deliberately out of scope

- **`list_bible` and the wiki-navigation prompt sentence.**
  [`navigating-the-story-bible.md`](../../research/navigating-the-story-bible.md) is independent of
  every wave here and has open questions this plan cannot settle for it — what a truncated listing
  does, and whether `match` ranks or filters. It gets its own plan. The ~200 characters of prompt it
  needs are reserved, not spent, because describing a tool the agent cannot call is worse than
  saying nothing.
- **A `format-rules` skill.** Disqualified by the rule at the top: skills are project-local and
  deletable (`examples/test4` has no `.aiagent/` at all) and are never injected, so a fact the agent
  needs in order not to destroy something cannot live in one. The agent that offered to strip
  `[[line:]]` from forty scenes thought it was tidying up; it would never have gone looking.
- **A `revise-scenes` skill.** What it would say is "batch your calls", which is §4's missing op.
- **An `approve-artwork` skill.** Four sessions of friction and none of it procedural. The tool
  works once reached, so this is §1.1.
- **Teaching the model to hold notes.** Giving `Scene` a field for arbitrary notes would make §2.2's
  refusal unnecessary and is a much larger change: it touches the serializer, the round-trip
  contract, and every consumer that assumes a scene is lines plus wiring. If stray notes turn out to
  be common, that is the real fix, and it deserves its own plan rather than being smuggled in here.
- **Anything in the desktop app.** No command, editor or menu changes.

## Open questions this plan decides

- **The budget's units are characters.** "25k" was given without one. Characters matches everything
  else here — the generated map is budgeted at 8,000, a bible query at 4,000 — and lands the prompt
  around 6,800 tokens, a sane always-on cost against a cached prefix. Twenty-five thousand *tokens*
  would be ~92,000 characters, nine times the current prompt, and nothing identified needs it. What
  the test does **not** measure is the assembled prefix — prompt plus map plus `AICONTEXT.md` — which
  is the question "is the always-on cost sane" actually turns on.
- **Overflow refuses rather than truncates.** §1.7's length assertion fails the build. A byte-stable
  cached prefix cannot be quietly trimmed at the end, and a budget nobody measures is not a budget.
- **A dropped note is a refusal, not a warning** (§2.2). The alternative is deleting an author's text
  during a write they did not ask for, which is worse than an edit that will not proceed until a
  person looks at the file.
- **Severity follows consequence** (§2.3), which keeps two documented plain-note fallbacks in
  `branch.ts` working as their comments say they do.
- **The `branching` skill ships in `templates/basic/`, not a bundled root.** `skillRoots` already
  takes `extraDirs` (`skills.ts:61-62`) and nothing passes one, so a root every project sees is
  reachable without new architecture — but it changes what a skill *is* (undeletable, versioned with
  the app, not the project's) and that decision should be made for its own reasons rather than as a
  side effect of shipping one playbook. Revisit when a second skill wants to be undeletable.

Not decided here, and left where the report put it: how much of the positional-attention argument in
§1 is a property of `gemini-2.5-flash` rather than of prompts. All fourteen threads are that model.
The prompt defects are real for any model; the claim that the top is read closely and line 109 is
not would be settled by one thread of the same work on a larger one.

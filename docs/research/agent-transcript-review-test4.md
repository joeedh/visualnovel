# Agent transcript review — `examples/test4`

Reads the four saved conversations in `examples/test4/vngen/state/threads/` (2026-08-17 22:42 → 2026-08-18 08:46, model
`claude-opus-4-8`, 134 tool calls over 273 feed items) adversarially against the code that produced them in
`packages/authoring/src/{loop,backend,context,tools}.ts` and `apps/desktop/src/main/session.ts`.

The four threads are one continuous authoring session: build a steampunk world bible → add nations → create 11 characters →
write five route outlines → write five treatments → write a scene breakdown → create 24 location sheets → begin writing 39
scenes. That session is the most realistic exercise of `vnauthor` on record, and every finding below actually happened
during it rather than being a failure the session could have produced.

The plan in
[`../plans/archive/INDEX.md#improving-the-authoring-agent`](../plans/archive/INDEX.md#improving-the-authoring-agent) builds
out the recommendations below. It specifies the two designs this review argues for but does not specify: a per-turn token
budget replacing `maxSteps`, and a partial file update tool.

<!-- toc -->

- [Summary, worst first](#summary-worst-first)
- [1. A long final message is discarded](#1-a-long-final-message-is-discarded)
- [2. The step budget cannot reach the job](#2-the-step-budget-cannot-reach-the-job)
- [3. The project map is never written](#3-the-project-map-is-never-written)
- [4. `search` excludes the story bible, and does not say so](#4-search-excludes-the-story-bible-and-does-not-say-so)
- [5. `search_bible` hands back paths `read_file` rejects](#5-search_bible-hands-back-paths-read_file-rejects)
- [6. `write_file` guards `scenes/` but not the entity directories](#6-write_file-guards-scenes-but-not-the-entity-directories)
- [7. The create tools cannot carry what the sheet needs](#7-the-create-tools-cannot-carry-what-the-sheet-needs)
- [8. A scaffold's observation does not say whether it scaffolded](#8-a-scaffolds-observation-does-not-say-whether-it-scaffolded)
- [9. Plan-mode narration is fiction](#9-plan-mode-narration-is-fiction)
- [10. The thread on disk loses the decisive turns](#10-the-thread-on-disk-loses-the-decisive-turns)
- [11. `update_context` appends blindly; `AICONTEXT.md` is never committed](#11-update_context-appends-blindly-aicontextmd-is-never-committed)
- [Smaller things](#smaller-things)
- [What went well, and is worth not breaking](#what-went-well-and-is-worth-not-breaking)
- [Proposed system-prompt changes](#proposed-system-prompt-changes)
- [Suggested order of work](#suggested-order-of-work)

<!-- tocstop -->

## Summary, worst first

| #   | Finding                                                       | Where                                    | Cost when it fires                                    |
| --- | ------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| 1   | A long final message is discarded and replaced with a parse error | `backend.ts` `StructuredAgentBackend.next` | The author's answer is lost; once it ended the thread |
| 2   | The step budget cannot reach the job just requested           | `loop.ts` `maxSteps`, `tools.ts` `edit_scene` | 39 scenes ≈ 1600 calls against a 24-step turn        |
| 3   | The project map is never written                              | `session.ts` agent construction          | 3–8 orientation calls per thread, four fruitless      |
| 4   | `search` silently excludes `wiki/` and `archive/`             | `tools.ts` `INPUT_GLOBS`                 | Twice sent the agent hunting a file it had written    |
| 5   | `search_bible` returns paths `read_file` rejects              | `packages/bible/src/indexer.ts:63`       | Four consecutive failed reads in one turn             |
| 6   | `write_file` guards `scenes/` but not the entity directories  | `tools.ts` `writeFileTool`               | 24 location sheets bypassed the validated write path  |
| 7   | `create_character` / `create_location` cannot carry front-matter | `tools.ts` create tools               | 22 calls for 11 characters; 24 raw writes for 24 locations |
| 8   | A scaffold's observation does not say whether it scaffolded   | `tools.ts` `createCharacterTool`         | The agent told the author all 11 sheets were empty; 8 were not |
| 9   | Plan-mode narration is fiction in execute mode                | `SYSTEM_PROMPT`, `loop.ts` mode message  | Three announced plans, none proposed; one self-approved |
| 10  | The thread on disk loses questions, plans and rejected arguments | `apps/desktop/src/shared/convo.ts:192` | A replayed thread — and `report.agent` — cannot see the decisive turns |
| 11  | `update_context` appends blindly; `AICONTEXT.md` is never committed | `context.ts` `updateContext`         | Four overlapping rules in one turn, none committed    |

## 1. A long final message is discarded

At thread 1 item 22 and thread 2 item 78, the agent's answer to the author was replaced by:

I couldn't produce a valid action. The model output contained no JSON: Done — I fleshed out the channeler Orders and their
factions, and it's committed (`c01b58a4`)…

Both times the work was done, validated and committed; only the report was lost. Thread 2 ends there, and the author never
saw the summary of five treatments. The sentence went into git as a commit subject (`55c8877`).

**Root cause.** `StructuredAgentBackend` (the text path, taken whenever the backend has no `chatConversation`) requires the
whole reply wrapped in `{"thought": …, "final": …}`. Every run before `65a05a97` took this path, and `@vn/agentreport`
still does. Long markdown answers with lists and bold text break out of that envelope. Three causes compound:

- The retry re-sends a byte-identical prompt (`backend.ts` attempt loop). The loop makes three attempts and adds no
  corrective hint, so all three fail identically.
- The recovery path discards the raw reply, which the error quotes, truncated to 200 characters.
- The wording presents the failure as the agent's own confession rather than a harness fault, so the author reads it as
  the agent giving up.

**Fix.** When every attempt fails and the raw text contains no tool call, return it as `{ final: raw }`. A model that
answered in prose has finished its turn, and the envelope is our bookkeeping convention rather than a signal from the
model. Then make the retry corrective (append `Your previous reply was not a single JSON object. Reply with the JSON object
only.` on attempts 2+), and keep the current message only for output holding a malformed tool call.

## 2. The step budget cannot reach the job

In thread 4, the agent is asked to write 39 scenes from the breakdown. The agent gets as far as enumerating the scenes and
asking how much dialogue to write, and the author answers "Full draft: substantial dialogue throughout". The agent cannot
do that:

- `edit_scene` exposes eleven single-line ops. Building a scene takes one `newScene` call plus one `insertLine` call per
  line, so a 40-line scene takes 41 calls.
- The loop runs one tool per step on the text path. `maxSteps` defaults to 24, and the desktop does not override it.
- One turn writes roughly half a scene, and the turn that runs out says only "Reached the step limit before finishing;
  stopping to avoid looping". It lists neither what landed nor what did not.

This gap separates what the agent is for from what it can do. Every other issue here matters less.

**Fix in order of value.**

1. 1. **A bulk line op.** `edit_scene` gains `insertLines: [{kind, speaker, text}]`. Each entry goes through the same
   `planSceneEdit` decisions one at a time, `@vn/scriptedit` still allocates the ids, and the "one prose write path"
   invariant holds. A whole scene then takes two calls.
2. 2. **Tell the model its budget.** Put the remaining step count in each observation, or file a system message at
   `maxSteps - 4` reading "four steps left this turn — finish or checkpoint". An agent that has the remaining step count
   can commit what it has and report where it stopped.
3. 3. **Raise the default** for the desktop, where a turn takes minutes of human attention rather than running in a test
   fixture. The value 24 came from the test harness.
4. 4. **Report the partial.** The step-limit final should name what was written since the last commit. `editedPaths`
   already holds those paths.

## 3. The project map is never written

`AICONTEXT.generated.md` does not exist in `examples/test4` and has never existed there. Only `regenerate_context` and
`workspace.reindex` write it, and someone must invoke either one. The desktop builds the agent from `composeSystem(await
loadContext(dir))`, which contains no map.

The cost shows in every thread. Thread 2 spends four `search_bible` calls on near-identical queries ("love interest
characters names academy female cast", "who are the four girls") that keep returning the same `outline.md` fragments, then
calls `list_workspace`, which answers immediately. Threads 3 and 4 each begin with three to five orientation calls before
doing any work.

**Fix.** Regenerate the map when a workspace opens and after any turn that wrote to `characters/`, `locations/`, `scenes/`
or `wiki/`. `Agent.refreshSystem` exists for this regeneration and files the change as a supersede message rather than
invalidating the cached prefix. The map is cheap because it holds names and paths, never content.

## 4. `search` excludes the story bible, and does not say so

`INPUT_GLOBS` is `['characters', 'locations', 'scenes', 'screenplay']` plus `AICONTEXT.md` and
`project.yaml`. `wiki/` and `archive/` are not searched. The description says only "Search input
files for a string or regex".

Thread 3 opens with `search("treatment")`, which returns "No matches for "treatment"", although five files named
`treatment-*.md` exist under `wiki/treatment/`. Thread 4 repeats this with `search("breakdown")` while
`wiki/breakdown_md.md` exists. In both threads the agent concluded the file was missing and searched the archive.

**Fix.** The fix takes two lines and adds no new machinery:

- Description: `Search the authored input files (characters/, locations/, scenes/) for a string or regex. This does not
  search the story bible (wiki/) or archive/. Use search_bible to search the story bible.`
- The output for a search with no matches lists the directories it searched: `No matches for "treatment" in characters/,
  locations/, scenes/. The story bible (wiki/) and archive/ are not searched — try search_bible or list_archive.` Because
  the result states what was searched, the caller can move on to another tool instead of stopping at a dead end.

## 5. `search_bible` hands back paths `read_file` rejects

`Excerpt.file` is relative to the bible root (indexer.ts:63, `relative(root, abs)` where root is `wiki/`), and
`formatExcerpts` prints it verbatim. `read_file` resolves against the workspace root. So a `search_bible` hit names
`treatment/treatment-ember.md`, and passing that path to `read_file` fails.

Thread 3, items 12–15 record four consecutive `read_file` failures, one per treatment, before the agent guessed the `wiki/`
prefix. These failures are the only place in the transcripts where a tool result is actively misleading rather than merely
thin.

**Fix.** Prefix the bible root when formatting for the agent, so that an excerpt path is workspace-relative and pasteable
into `read_file`. The prefixing is a display concern of the tool, so `@vn/bible`'s own `Excerpt.file` contract can stay as
it is.

## 6. `write_file` guards `scenes/` but not the entity directories

`writeFileTool` refuses a path under `guardedDir` (`scenes/`) and writes any other path. In thread 3 items 49–72, the agent
authored 24 location sheets with raw `write_file`, hand-writing YAML front-matter, because it needed `mood`, `lighting`,
`palette` and `variants`, and `create_location` takes none of them (finding 7).

Those 24 sheets never went through `applyLocationEdit`. `validate_inputs` reported clean, and the agent passed "validated
clean" on to the author. That report claims more than the check establishes. Nothing yet references these ids, so the
cross-file check that would exercise them never runs.

**Fix.** Extend the guard to `characters/` and `locations/`. The refusal names the commands that write the file, in the
same shape as the scenes refusal: `locations/x.md is written by create_location and edit_location, not write_file.` This
enforces the CLAUDE.md invariant — "a _named field_ inside a sheet may still be set by a command that round-trips through
`@vn/model`'s `apply*Edit`" — where the agent can reach it.

## 7. The create tools cannot carry what the sheet needs

`create_character` and `create_location` take `{name, description?}` and nothing else. Every other field (`traits`,
`palette`, `outfits`, `default_outfit`, `mood`, `lighting`, `variants`, `art_notes`) is reachable only through `edit_*`.

Thread 1 therefore runs a two-pass loop: 11 `create_character` calls, then 11 `edit_character` calls, 22 calls to write 11
files. In thread 3 the agent met the same constraint for locations and skipped the tool entirely (finding 6).

**Fix.** Give the create tools the same field set as their `edit_*` siblings. The shapes already exist: creation takes that
shape, drops `id`, and adds a name. One call then produces one validated sheet, which removes the need for a raw write.

## 8. A scaffold's observation does not say whether it scaffolded

`create_character` returns `Created character caedon_vale.` whether it wrote the description it was given or the empty
placeholder template. The tool branches between those two cases, and the output does not record which branch ran.

Thread 1 items 63–64: the agent had passed descriptions for 8 of 11 characters and omitted them for 3 (`gideon_marsh`,
`pip_calloway`, `professor_mirabel_quist`). Reading back a uniform set of observations, it told the author that all eleven
were placeholder templates with "nothing written yet", and offered to draft them. The author said "draft all 11", and 8
already-written sheets were rewritten from scratch. The self-correction sounded honest but was wrong, and correcting it
cost a whole turn.

**Fix.** Take two observations instead of one:

- `Created character caedon_vale from the description you gave.`
- `Created character gideon_marsh as an empty template because no description was given. Fill in the description with
  edit_character.`

A tool that reports which of its two behaviours it took catches an agent that misreports its own work, and no check costs
less.

## 9. Plan-mode narration is fiction

The session ran in execute mode, and the agent repeatedly narrated the opposite:

- Thread 1 item 2: _"Creating a wiki bible page is a write_file operation, which is blocked in plan
  mode. I'll propose a plan describing the page I'll write."_ → the next call is `write_file`, and it
  succeeds. No plan was proposed.
- Thread 1 item 36, thread 2 item 23 and thread 3 item 31 all have the same shape. Each says "I'll propose a plan first",
  and no `propose_plan` call follows.
- Thread 3 item 34 is the worst case: "Plan approved. Let me find the editing, validation, and commit tools." Nobody
  approved anything. The agent presented a plan one item earlier, then continued without waiting for approval.

The cause is in the prompt, not the loop. `SYSTEM_PROMPT`'s `HOW YOU WORK` states the plan workflow as unconditional fact
("Plan before acting. In plan mode you only read… The user approves a plan, then you execute"). The actual mode arrives
later, as an out-of-band message that the model weighs less than the system prompt. So the model narrates the prompt and
acts on the mode.

The cosmetic problem is not the only one. The jobs that most deserve a plan happen in execute mode, and nothing asks for
one there. Writing 24 location sheets and 39 scenes are exactly the acts an author would want costed first.

**Fix.** See the prompt edits below. Describe the two modes as states the model is told about rather than a script it
narrates, make the MODE message explicitly authoritative, and detach `propose_plan` from plan mode, since it is how any
large job gets agreed in either mode.

## 10. The thread on disk loses the decisive turns

`received()` (shared/convo.ts:192) files `tool`, `blocked`, `usage`, `message` and `final`. It never files three things:

- **Questions.** `ask_user` / `ask_choice` go through `proposed()`/`queried()`, which set `convo.question` and push
  nothing. Thread 4 records the author answering "Full draft: substantial dialogue throughout — much slower, more of my
  invention beyond the breakdown", with no record of the question, the options offered, or the two other decisions the
  agent said it needed. The saved thread cannot be replayed, because the question that prompted the answer is missing.
- **Plans and plan decisions.** Take the same path and are silent in the same way.
- **Rejected arguments.** An arg-schema failure in `dispatch` returns an error string and emits no event. Thread 1 item
  88→89 shows the agent recovering ("Retry validation with an empty args object") from a failure that appears nowhere in
  the log.

Untidiness is not the only cost. `report.agent` diagnoses a difficult conversation from these files, and it cannot see the
question that was misphrased, the plan that was wrong, or the argument the schema refused.

**Fix.** File all three items. The `question` and `plan` items carry their text and options. The `blocked`-style item for a
refused argument carries the diagnostic verbatim.

## 11. `update_context` appends blindly; `AICONTEXT.md` is never committed

In thread 2 items 41–52, the agent was asked to record non-obvious information and made four `update_context` calls whose
first two bullets restate the same cast list. It then read the file back and noticed the redundancy — item 51 records
"there's some redundancy between the first two bullets. It's acceptable". It shipped the file anyway. That file is now in
the system prompt of every later session, and thread 3 quotes it.

This issue is separate. `updateContext` returns the path and the loop adds it to `editedPaths`, but the model passes
explicit `paths` to `git_commit` every time, so the default scope never applies and `AICONTEXT.md` was left uncommitted.
The agent reported this correctly at item 52, and nobody acted on it.

**Fix.** Have the description say one rule per call, and tell the agent to read `AICONTEXT.md` before adding to it. Better
still, have `update_context` return the resulting file so the model sees what it wrote. Stop the agent passing `paths` to
`git_commit` at all: the loop's `editedPaths` tracks what was edited more accurately than the model reports it, which is
why `git_commit` defaults to `editedPaths`.

## Smaller things

- **Read-after-write.** In Thread 1 items 20–21 and 31–32, the agent re-reads a file it just wrote "to report its actual
  contents accurately". The agent wrote the content, so the re-read costs a full file of context and adds nothing.
- **Commit subjects from agent prose.** Commit-on-save takes the turn's final text as the subject, so `examples/test4`
  contains the commit `55c8877 I couldn't produce a valid action (no JSON found in model output — got:…`. A state-only
  commit should be titled after the act it records.
- **`validate_inputs` claims more than it checks.** "No diagnostics. Inputs are valid." became "validated clean" in three
  author-facing reports, and one of those reports covered 24 sheets that nothing referenced yet. Listing what was checked
  (`Checked 11 characters, 24 locations, 1 scene: no diagnostics.`) would make the summaries accurate without changing a
  single check.

## What went well, and is worth not breaking

- **Every turn ends with validation and a commit.** All four threads run edit → `validate_inputs` → `git_commit` without
  being asked. The history in `examples/test4` is bisectable.
- **The agent reports what it did not do.** Thread 3's closing note reads: "these IDs aren't referenced by any scene yet…
  the cross-file check only bites once the `scenes/` chunks exist". The prompt's last line asks for exactly this reporting,
  and the note gives it unprompted and correct.
- **Stops and asks when the request is ambiguous.** Thread 3 item 31 halts on the mismatch between `wiki/breakdown_md.md`
  and the `breakdown.md` the author named rather than guessing; thread 4 stops to ask how much dialogue to write. Both
  halts are the right call.
- **Reads before editing.** Every expansion of an existing page begins with a `read_file` of that page.

## Proposed system-prompt changes

The notes below are written against `SYSTEM_PROMPT` in `packages/authoring/src/context.ts`. The prompt states the input
contract well and states how to work incompletely; almost every note below concerns how to work.

**a. Replace the `HOW YOU WORK` mode paragraph.** The current text describes a workflow the agent is often not in.

```
MODE. You are always in one of two modes, and a MODE message in the transcript states which.
That message is authoritative and supersedes anything here.
- plan (read-only): mutating tools are refused. Read, search, and propose.
- execute (read-write): mutating tools run. Apply edits, validate, and commit.
Never announce which mode you are in or what it forbids — act, and let a refusal speak for
itself if one comes. Never claim a plan was approved; approval arrives as an observation.
```

**b. Plan mode and planning are separate features.**

```
PROPOSE A PLAN whenever the work is large enough that the author would want it costed first —
more than a handful of files, anything that re-renders art, anything you would have to guess
at. propose_plan works in either mode. In execute mode it is not a gate you must pass; it is
how you and the author agree on scope before you spend an hour of their compute.
```

**c. Name the write paths, so that a raw `write_file` call remains an exception.** The prompt describes the layout but
never says which tool writes which part of it, and the agent guessed wrong twice.

```
WHAT WRITES WHAT:
- scenes/**            — edit_scene and edit_branches only. write_file refuses them.
- characters/**        — create_character, edit_character, set_outfit.
- locations/**         — create_location, edit_location.
- wiki/**, everything else — write_file.
Entity sheets go through their own tools even when you are writing every field at once: those
tools validate the front-matter, and a hand-written sheet that parses is not the same as one
that is correct.
```

**d. State the search seams.** Three of the four threads lost calls because they did not know the search seams.

```
FINDING THINGS: list_workspace is the index of what exists — reach for it before searching for
a character or a location by name. search covers the authored inputs only (characters/,
locations/, scenes/); the story bible is search_bible and nothing else reaches it; uploads are
list_archive. A "no matches" from one of them is not evidence the thing is absent — it is
evidence about that one door.
```

**e. Add a paragraph on cost**, which the prompt does not mention today.

```
WORKING AT SCALE: a turn has a step budget and each tool call spends one. Do not re-read a file
you just wrote — you know what is in it. Do not re-run a search with a reworded query; ask a
different tool instead. When a job is larger than one turn, do it in committed batches and say
where you stopped, rather than starting everything and finishing none of it.
```

**f. Sharpen the honesty line.** The honesty line currently says to report validation failures honestly. Thread 1 failed in
the opposite way, by inventing a shortcoming that was not there.

```
Report honestly: if validation fails or a commit is skipped, say so with the real output. Be
equally precise about what you did do — describe the arguments you actually passed, not what a
tool's summary of them implies. Do not volunteer a defect you have not verified.
```

## Suggested order of work

1. 1. Finding 1 (the parse-failure fallback) takes a dozen lines and stops the author's answers from being lost outright.
2. 2. Finding 2 (bulk line op + step budget) — this blocks the agent from doing the job thread 4 was asked to do.
3. 3. Findings 4, 5 and 8 concern tool descriptions and observation strings. None of the three contains a design decision,
   and together they account for most of the wasted calls in the transcripts.
4. 4. Apply the prompt edits described above (a–f).
5. 5. Findings 6 and 7 cover create, edit, and guard, and are best done as one change.
6. 6. Findings 3, 10, 11 cover the host-side plumbing: the map, the feed items, and the commit scope.

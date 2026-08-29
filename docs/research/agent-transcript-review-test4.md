# Agent transcript review — `examples/test4`

An adversarial read of the four saved conversations in `examples/test4/vngen/state/threads/`
(2026-08-17 22:42 → 2026-08-18 08:46, model `claude-opus-4-8`, 134 tool calls over 273 feed
items) against the code that produced them: `packages/authoring/src/{loop,backend,context,tools}.ts`
and `apps/desktop/src/main/session.ts`.

The four threads are one continuous authoring session: build a steampunk world bible → add
nations → create 11 characters → write five route outlines → write five treatments → write a
scene breakdown → create 24 location sheets → begin writing 39 scenes. It is the most realistic
exercise of `vnauthor` on record, and every finding below is something that actually happened in
it, not something that could.

The recommendations below are built out as a plan in
[`../plans/archive/INDEX.md#improving-the-authoring-agent`](../plans/archive/INDEX.md#improving-the-authoring-agent), which
specifies the two designs this review only argues for: a per-turn token budget replacing
`maxSteps`, and a partial file update tool.

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

Twice — thread 1 item 22, thread 2 item 78 — the agent's answer to the author was replaced by:

> I couldn't produce a valid action (no JSON found in model output — got: Done — I fleshed out
> the channeler Orders and their factions, and it's committed (`c01b58a4`)…).

Both times the work was done, validated and committed; only the report was lost. Thread 2 **ends**
there — the author never saw the summary of five treatments — and the sentence went into git as a
commit subject (`55c8877`).

**Root cause.** `StructuredAgentBackend` (the text path, taken whenever the backend has no
`chatConversation` — which is every run before `65a05a97`, and `@vn/agentreport` still) requires
the whole reply wrapped in `{"thought": …, "final": …}`. Long markdown answers with lists and bold
drift out of the envelope. Three things compound:

- The retry re-sends a **byte-identical prompt** (`backend.ts` attempt loop). Three attempts, no
  corrective hint, so all three fail identically.
- The recovery path throws away text it is holding — the raw reply is right there, and is even
  quoted, truncated to 200 characters, inside the error.
- The failure is worded as the agent's own confession rather than a harness fault, so the author
  reads it as the agent giving up.

**Fix.** When every attempt fails and the raw text contains no tool call, return it as
`{ final: raw }` — a model that answered in prose *did* finish its turn; the envelope is our
bookkeeping, not its intent. Then make the retry corrective (append `Your previous reply was not a
single JSON object. Reply with the JSON object only.` on attempts 2+), and keep the current message
only for output holding a malformed tool call.

## 2. The step budget cannot reach the job

Thread 4 is the agent being asked to write 39 scenes from the breakdown. It gets as far as
enumerating them and asking how much dialogue to write; the author answers "Full draft:
substantial dialogue throughout". It cannot do that:

- `edit_scene` exposes eleven single-line ops. A scene is `newScene` plus **one `insertLine` per
  line**. A 40-line scene is 41 calls.
- The loop runs one tool per step on the text path, and `maxSteps` defaults to **24**; the desktop
  passes no override.
- So one turn writes roughly *half a scene*, and the turn that runs out says only "Reached the step
  limit before finishing; stopping to avoid looping" — with no list of what landed and what didn't.

This is the gap between what the agent is for and what it can do. Everything else here is polish
next to it.

**Fix, in order of value.**

1. **A bulk line op.** `edit_scene` gains `insertLines: [{kind, speaker, text}]`, folded over the
   same `planSceneEdit` decisions one at a time — ids still allocated by `@vn/scriptedit`, the "one
   prose write path" invariant intact. A scene becomes two calls.
2. **Tell the model its budget.** Put the remaining step count in each observation, or file a system
   message at `maxSteps - 4`: "four steps left this turn — finish or checkpoint". An agent that
   knows it is running out can commit what it has and say where it stopped.
3. **Raise the default** for the desktop, where a turn is minutes of human attention rather than a
   test fixture. 24 was a test-harness number.
4. **Report the partial.** The step-limit final should name what was written since the last commit;
   `editedPaths` already holds exactly that.

## 3. The project map is never written

`AICONTEXT.generated.md` does not exist in `examples/test4` and never did. It is written only by
`regenerate_context` or `workspace.reindex`, both of which someone must invoke; the desktop builds
the agent from `composeSystem(await loadContext(dir))` with no map in it.

The cost shows in every thread. Thread 2 spends **four `search_bible` calls** on near-identical
queries ("love interest characters names academy female cast", "who are the four girls") that keep
returning the same `outline.md` fragments, before reaching for `list_workspace` — which answers
immediately. Threads 3 and 4 each open with three to five orientation calls before touching work.

**Fix.** Regenerate the map when a workspace opens and after any turn that wrote to `characters/`,
`locations/`, `scenes/` or `wiki/`. `Agent.refreshSystem` exists for exactly this and files the
change as a supersede message rather than invalidating the cached prefix. The map is cheap: names
and paths, never content.

## 4. `search` excludes the story bible, and does not say so

`INPUT_GLOBS` is `['characters', 'locations', 'scenes', 'screenplay']` plus `AICONTEXT.md` and
`project.yaml`. `wiki/` and `archive/` are not searched. The description says only "Search input
files for a string or regex".

Thread 3 opens with `search("treatment")` → "No matches for "treatment"" — while five files named
`treatment-*.md` sit under `wiki/treatment/`. Thread 4 repeats it with `search("breakdown")` while
`wiki/breakdown_md.md` exists. Both times the agent concluded the file was missing and went digging
in the archive.

**Fix.** Two lines, no new machinery:

- Description: `Search the authored input files (characters/, locations/, scenes/) for a string or
  regex. It does NOT cover the story bible (wiki/) — that is search_bible — or archive/.`
- The no-match output names its own scope: `No matches for "treatment" in characters/, locations/,
  scenes/. The story bible (wiki/) and archive/ are not searched — try search_bible or
  list_archive.` A negative result that states what it looked at is the difference between a dead
  end and a redirect.

## 5. `search_bible` hands back paths `read_file` rejects

`Excerpt.file` is relative to the **bible root** (`indexer.ts:63`, `relative(root, abs)` where root
is `wiki/`), and `formatExcerpts` prints it verbatim. `read_file` resolves against the **workspace**
root. So a `search_bible` hit reads `treatment/treatment-ember.md`, and reading it back fails.

Thread 3, items 12–15: four consecutive `read_file` failures, one per treatment, before the agent
guessed the `wiki/` prefix. It is the only place in the transcripts where a tool result is actively
misleading rather than merely thin.

**Fix.** Prefix the bible root when formatting for the agent, so an excerpt path is
workspace-relative and pasteable into `read_file`. `@vn/bible`'s own `Excerpt.file` contract can
stay as it is — this is a display concern of the tool.

## 6. `write_file` guards `scenes/` but not the entity directories

`writeFileTool` refuses a path under `guardedDir` — which is `scenes/` — and writes anything else.
Thread 3 items 49–72: the agent authored **24 location sheets** with raw `write_file`, hand-writing
YAML front-matter, because it wanted `mood`, `lighting`, `palette` and `variants` and
`create_location` takes none of them (finding 7).

Those 24 sheets never went through `applyLocationEdit`. `validate_inputs` reported clean and the
agent reported "validated clean" to the author, which reads as more of a guarantee than it is:
nothing yet references these ids, so the cross-file check that would exercise them never fires.

**Fix.** Extend the guard to `characters/` and `locations/`, with the refusal naming the way in, the
same shape as the scenes refusal: `locations/x.md is written by create_location and edit_location,
not write_file.` This is the CLAUDE.md invariant — "a _named field_ inside a sheet may still be set
by a command that round-trips through `@vn/model`'s `apply*Edit`" — enforced where the agent can
reach it.

## 7. The create tools cannot carry what the sheet needs

`create_character` and `create_location` take `{name, description?}` and nothing else. Every other
field — `traits`, `palette`, `outfits`, `default_outfit`, `mood`, `lighting`, `variants`,
`art_notes` — is reachable only through `edit_*`.

Thread 1 pays for that with a two-pass loop: 11 `create_character` calls, then 11 `edit_character`
calls, 22 calls to write 11 files. In thread 3, faced with the same wall for locations, the agent
skipped the tool entirely (finding 6).

**Fix.** Give the create tools the same field set as their `edit_*` siblings — the shapes already
exist; creation is that shape minus `id`, plus a name. One call, one validated sheet, and the
raw-write temptation goes with it.

## 8. A scaffold's observation does not say whether it scaffolded

`create_character` returns `Created character caedon_vale.` whether it wrote the description it was
given or the empty placeholder template. The branch is right there in the tool and is invisible in
the output.

Thread 1 items 63–64: the agent had passed descriptions for 8 of 11 characters and omitted them for
3 (`gideon_marsh`, `pip_calloway`, `professor_mirabel_quist`). Reading back a uniform set of
observations, it told the author **all eleven** were placeholder templates with "nothing written
yet", and offered to draft them. The author said "draft all 11", and 8 already-written sheets were
rewritten from scratch. An honest-sounding self-correction was itself the error, and it cost a whole
turn.

**Fix.** Two observations, not one:

- `Created character caedon_vale from the description you gave.`
- `Created character gideon_marsh as an empty template — no description was given. Fill it in with
  edit_character.`

A tool that reports which of its two behaviours it took is the cheapest possible defence against an
agent misreporting its own work.

## 9. Plan-mode narration is fiction

The session ran in execute mode. The agent narrated otherwise, repeatedly:

- Thread 1 item 2: _"Creating a wiki bible page is a write_file operation, which is blocked in plan
  mode. I'll propose a plan describing the page I'll write."_ → the next call is `write_file`, and it
  succeeds. No plan was proposed.
- Thread 1 item 36, thread 2 item 23, thread 3 item 31: same shape — "I'll propose a plan first",
  then no `propose_plan`.
- Thread 3 item 34 is the worst: _"Plan approved. Let me find the editing, validation, and commit
  tools."_ Nobody approved anything; the agent presented a plan one item earlier and walked straight
  through its own gate.

**The cause is in the prompt, not the loop.** `SYSTEM_PROMPT`'s `HOW YOU WORK` states the plan
workflow as unconditional fact ("Plan before acting. In plan mode you only read… The user approves a
plan, then you execute"), while the actual mode arrives later as an out-of-band message the model
weighs less than the system prompt sitting behind it. So the model narrates the prompt and acts on
the mode.

A real problem hides under the cosmetic one: **the jobs that most deserve a plan happen in execute
mode**, and nothing asks for one there. Writing 24 location sheets and 39 scenes are precisely the
acts an author would want costed first.

**Fix.** See the prompt edits below — describe the two modes as states you are told about rather
than a script you narrate, make the MODE message explicitly authoritative, and detach `propose_plan`
from plan mode: it is how any large job gets agreed, in either mode.

## 10. The thread on disk loses the decisive turns

`received()` (`shared/convo.ts:192`) files `tool`, `blocked`, `usage`, `message` and `final`. Three
things are never filed:

- **Questions.** `ask_user` / `ask_choice` go through `proposed()`/`queried()`, which set
  `convo.question` and push nothing. Thread 4 records the author answering _"Full draft: substantial
  dialogue throughout — much slower, more of my invention beyond the breakdown"_ with no record of
  the question, the options offered, or the two other decisions the agent said it needed. The saved
  thread is unreplayable at exactly the point it matters.
- **Plans and plan decisions.** Same path, same silence.
- **Rejected arguments.** An arg-schema failure in `dispatch` returns an error string and emits no
  event at all. Thread 1 item 88→89 shows the agent visibly recovering ("Retry validation with an
  empty args object") from a failure that appears nowhere in the log.

This matters beyond tidiness: `report.agent` diagnoses a difficult conversation from these files, and
it cannot see the question that was misphrased, the plan that was wrong, or the argument the schema
refused.

**Fix.** File all three — `question`/`plan` items carrying their text and options, and a
`blocked`-style item for a refused argument carrying the diagnostic verbatim.

## 11. `update_context` appends blindly; `AICONTEXT.md` is never committed

Thread 2 items 41–52: asked to record non-obvious information, the agent made four `update_context`
calls whose first two bullets restate the same cast list. It then read the file back, **noticed** the
redundancy (item 51: "there's some redundancy between the first two bullets. It's acceptable"), and
shipped it anyway. That file is now in the system prompt of every later session, and thread 3 quotes
it.

Separately: `updateContext` returns the path and the loop adds it to `editedPaths`, but the model
passes explicit `paths` to `git_commit` every time, so the default scope never applies and
`AICONTEXT.md` was left uncommitted. The agent reported this correctly at item 52; nobody acted.

**Fix.** Have the description say one rule per call, and read `AICONTEXT.md` before adding to it —
better, have `update_context` return the resulting file so the model sees what it built. And stop the
agent passing `paths` to `git_commit` at all: the loop's `editedPaths` is more accurate than the
model's memory of what it touched, which is the reason that default exists.

## Smaller things

- **Read-after-write.** Thread 1 items 20–21 and 31–32: the agent re-reads a file it just wrote "to
  report its actual contents accurately". It wrote the content; the re-read costs a full file of
  context and proves nothing.
- **Commit subjects from agent prose.** Commit-on-save takes the turn's final text as the subject, so
  `examples/test4` carries `55c8877 I couldn't produce a valid action (no JSON found in model
  output — got:…`. A state-only commit should be titled by the act.
- **`validate_inputs` over-promises.** "No diagnostics. Inputs are valid." became "validated clean" in
  three author-facing reports, including for 24 sheets nothing referenced yet. Saying what was checked
  (`Checked 11 characters, 24 locations, 1 scene: no diagnostics.`) would keep the summaries honest
  without changing a single check.

## What went well, and is worth not breaking

- **Every turn ends validated and committed.** All four threads run edit → `validate_inputs` →
  `git_commit` without being asked. The history in `examples/test4` is genuinely bisectable.
- **The agent volunteers what it did not do.** Thread 3's closing note — "these IDs aren't referenced
  by any scene yet… the cross-file check only bites once the `scenes/` chunks exist" — is exactly the
  reporting the prompt's last line asks for, unprompted and correct.
- **It stops and asks when the request is ambiguous.** Thread 3 item 31 halts on
  `wiki/breakdown_md.md` vs the `breakdown.md` the author named rather than guessing; thread 4 stops
  to ask how much dialogue to write. Both are the right call.
- **It reads before it edits.** Every expansion of an existing page opens with a `read_file` of it.

## Proposed system-prompt changes

Against `SYSTEM_PROMPT` in `packages/authoring/src/context.ts`. The prompt is a good statement of the
_input contract_ and an incomplete statement of _how to work_; almost everything below lands in the
second half.

**a. Replace the `HOW YOU WORK` mode paragraph.** The current text narrates a workflow the agent is
often not in.

```
MODE. You are always in one of two modes, and a MODE message in the transcript states which.
That message is authoritative and supersedes anything here.
- plan (read-only): mutating tools are refused. Read, search, and propose.
- execute (read-write): mutating tools run. Apply edits, validate, and commit.
Never announce which mode you are in or what it forbids — act, and let a refusal speak for
itself if one comes. Never claim a plan was approved; approval arrives as an observation.
```

**b. Detach planning from plan mode.**

```
PROPOSE A PLAN whenever the work is large enough that the author would want it costed first —
more than a handful of files, anything that re-renders art, anything you would have to guess
at. propose_plan works in either mode. In execute mode it is not a gate you must pass; it is
how you and the author agree on scope before you spend an hour of their compute.
```

**c. Name the write paths, so a raw `write_file` is the exception it is meant to be.** The prompt
describes the layout but never says which tool owns which part of it — and the agent guessed wrong,
twice.

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

**d. State the search seams.** Three of the four threads lost calls to not knowing these.

```
FINDING THINGS: list_workspace is the index of what exists — reach for it before searching for
a character or a location by name. search covers the authored inputs only (characters/,
locations/, scenes/); the story bible is search_bible and nothing else reaches it; uploads are
list_archive. A "no matches" from one of them is not evidence the thing is absent — it is
evidence about that one door.
```

**e. Add a paragraph on cost**, which the prompt says nothing about today.

```
WORKING AT SCALE: a turn has a step budget and each tool call spends one. Do not re-read a file
you just wrote — you know what is in it. Do not re-run a search with a reworded query; ask a
different tool instead. When a job is larger than one turn, do it in committed batches and say
where you stopped, rather than starting everything and finishing none of it.
```

**f. Sharpen the honesty line.** It currently says to report validation failures honestly. The
failure in thread 1 was the opposite — inventing a shortcoming that was not there.

```
Report honestly: if validation fails or a commit is skipped, say so with the real output. Be
equally precise about what you did do — describe the arguments you actually passed, not what a
tool's summary of them implies. Do not volunteer a defect you have not verified.
```

## Suggested order of work

1. Finding 1 (the parse-failure fallback) — a dozen lines, and it stops losing the author's answers
   outright.
2. Finding 2 (bulk line op + step budget) — the thing standing between this agent and the job thread
   4 was asked to do.
3. Findings 4, 5, 8 — tool descriptions and observation strings, no design decisions in any of them,
   and together they account for most of the wasted calls in the transcripts.
4. The prompt edits above (a–f).
5. Findings 6, 7 — the create/edit/guard triangle, best done as one change.
6. Findings 3, 10, 11 — host-side plumbing: the map, the feed items, the commit scope.

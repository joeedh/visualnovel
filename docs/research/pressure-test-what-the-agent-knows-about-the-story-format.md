# Pressure test — `plans/what-the-agent-knows-about-the-story-format.md`

This document is an adversarial read of the plan against the code as it stands (August 2026). Every
file the plan cites was re-read, the note census it reasons about was run over the corpus, and the
central claim of §2 — that an invented marker reaches a scene file through `edit_scene` — was checked
by running it rather than by reading.

The prompt half (§1) survives almost intact, because it holds without depending on any code. The two
halves that touch code do not survive. §3 is already built and has been since the agent's first
commit, and §2's error-severity rule is contradicted by two explicit comments in the module it is
checking, by the precedent one file over, and by what the parser actually does. What follows is
ordered by how much work the error moves.

<!-- toc -->

- [What checks out](#what-checks-out)
- [1. `git_commit` already validates, in the loop, since the first commit](#1-git_commit-already-validates-in-the-loop-since-the-first-commit)
- [2. The error/warning split is argued from confidence; the code argues from consequence](#2-the-errorwarning-split-is-argued-from-confidence-the-code-argues-from-consequence)
- [3. The threat model is wrong: `edit_scene` cannot write a note at all](#3-the-threat-model-is-wrong-edit_scene-cannot-write-a-note-at-all)
- [4. The real defect §2 walked past: a stray note is silently destroyed on the next write](#4-the-real-defect-%C2%A72-walked-past-a-stray-note-is-silently-destroyed-on-the-next-write)
- [5. An error-severity code makes the offending scene harder to repair, not easier](#5-an-error-severity-code-makes-the-offending-scene-harder-to-repair-not-easier)
- [6. `droppedWarnings` is the missing precedent, and it is warning-severity by design](#6-droppedwarnings-is-the-missing-precedent-and-it-is-warning-severity-by-design)
- [7. The exhaustiveness check does not fail the build](#7-the-exhaustiveness-check-does-not-fail-the-build)
- [8. Wave 3 is ordered before wave 1](#8-wave-3-is-ordered-before-wave-1)
- [9. Smaller corrections](#9-smaller-corrections)
- [What survives](#what-survives)

<!-- tocstop -->

## What checks out

I tried hardest to break these parts and could not:

- **The marker table lists three of the six kinds.** `BranchMarker` has six kinds
  (packages/parse/src/branch.ts:14-20); the marker block at context.ts:50-54 lists three.
  `[[outfit:]]` is at context.ts:126, in the art-inheritance paragraph; `[[line:]]` and
  `[[nextline:]]` do not appear. (The parent report's "line 109" counts from the prompt's own first
  line, which is context.ts:18; both name the same place.) The central prompt finding holds.
- **The prompt contradicts itself about `[[scene:]]`.** Line 38 says a chunk body carries no
  `[[scene:]]` marker and cannot override its id. Line 51 lists `[[scene:]]` as a marker that "assigns
  a stable id to the current scene". Both lines are in the prompt today.
- **The preamble denies `approve_assets` in the plain reading.** Line 20 is one clause, and
  "you never run the image-generation pipeline" sits in the paragraph a model reads most closely.
- **The corpus census supports the closed-world claim.** Across all forty scenes in
  `examples/test4`, `[[ … ]]` notes are only ever `line` (214), `nextline` (53), `next` (46) and
  `choice` (10). No stray note and no invented marker key appear. Two consequences follow. The
  invented conditional was prose rather than notation, and the false-positive rate that §2.1 raised as
  a concern is zero on real material. That material is machine-written, which makes it the weaker half
  of the claim.
- **`deleteLines` copies `insertLines`.** lineops.ts:220-250 folds `insertLine` over a list,
  threading `scenes` through and refusing with `line N of M: … Nothing was inserted.` The symmetric op
  needs no new machinery, and that fold already achieves the "single `ScriptState` transition" that §5
  requires. This change carries the least risk in the plan.
- A chunk with two scenes is caught, as §2.3 says. The finding sits at entities.ts:129-141 and
  carries error severity. The correction to the parent report holds.

## 1. `git_commit` already validates, in the loop, since the first commit

packages/authoring/src/loop.ts:813-819:

```ts
if (name === 'git_commit') {
  const errors = await this.workspaceErrors();
  if (errors.length) {
    emit({ type: 'blocked', tool: name, reason: 'validation errors block commit' });
    return `Commit blocked: fix ${errors.length} validation error(s) first:\n` + errors.join('\n');
  }
```

`workspaceErrors` (loop.ts:894-899) loads the model and filters `severity === 'error'`. Its doc
comment reads: _"Error-severity diagnostics currently in the project (the commit gate)."_ A `git log
-S` search finds it in `883d4a25`, the commit that implemented the agent.

So §3 of the plan builds a gate that exists, and the parent report's claim that "`git_commit` never
validates, so the prompt's promise is discipline" is false. The transcripts showed that
validate_inputs ran before 14 commits of 20. That is a different claim about the agent's habits, and
it stands, but it does not imply what it was taken to imply.

Three things follow:

- **§3 should be deleted, not narrowed.** Adding the same filter inside `gitCommitTool` puts one
  rule in two places, which the codebase's own comment at tools.ts:759-762 calls out as "how two
  answers start to disagree".
- **§1.5's prompt text is still correct and needs no new code.** The sentence "git_commit runs
  validate_inputs itself and refuses on an error" describes the shipped system, so the text can go in
  with wave 1 with no code behind it.
- **The one real gap is host coverage.** The gate is keyed on the tool name in the agent loop, so
  anything that calls `gitCommitTool` outside the loop is ungated. The plan should record in one
  sentence that this is deliberate rather than missed, since the agent is the only caller today.

The plan's §6 wave-ordering constraint ("`git_commit` must land no later than wave 1") is dropped with
it.

## 2. The error/warning split is argued from confidence; the code argues from consequence

§2.1 assigns severity by how confident the checker can be: a recognised key that fails to parse is
"unambiguously a mistake", so the checker reports an error. Two comments in
packages/parse/src/branch.ts contradict this:

- On `outfit` (:37-38): _"One pair per marker. A value with whitespace or a missing half is a plain
  note rather than a half-read marker."_
- On `nextline` (:50-52): _"A non-numeric value counts as a plain note rather than a broken
  allocator. `splitScenes` then derives the mark from the ids it saw, which is the same path an
  unmigrated file takes."_

Both say the decline is a designed fallback with a defined recovery, not a mistake. §2.1 would make
`[[outfit: aiko = uniform]]` and `[[nextline: soon]]` errors, and so uncommittable under the commit
gate in §1, against a documented intent to treat them as prose. The disagreement is not about
severity: the plan overrules an earlier decision without recording that it does so.

The split that works in the code is by consequence, which is what the existing codes already use
(`dangling_goto` errors because an edge is broken; `unknown_character` warns because a cue is only
probably wrong):

| note                                             | what is lost                         | severity                       |
| ------------------------------------------------ | ------------------------------------ | ------------------------------ |
| `choice`, `next`/`goto` that fails to parse       | a story-graph edge, silently         | **error**                      |
| `line` that fails to parse                       | the shot's anchor; a fresh id is allocated | **error**                 |
| `outfit`, `nextline`, `scene`/`id` that fails    | nothing — documented fallback path   | **warning**                    |
| any other `key: value` note                      | nothing the model wanted             | **warning** (`unknown_marker`) |

That keeps the one case §2 was written for (`=>` for `->`) at error, and stops the plan from erroring
on two paths the parser deliberately supports.

## 3. The threat model is wrong: `edit_scene` cannot write a note at all

§2 says the invented marker "arrives as the *text of a prose line* through `edit_scene`, which has no
reason to inspect it". The marker cannot arrive that way. A `[[ … ]]` line re-parses as a `note`
element, and `Scene` has no field that holds one, so:

1. `insertLine` writes the line into the model as prose;
2. 2. `planSceneEdit` serializes the scene and reads it back (apply.ts:66-68);
3. the note is not in the model, so it is not in the re-serialized text;
4. 4. `sceneToDoc(read.value.scene).body !== doc.body` and the edit is refused with "Writing s1 would
   not read back as the scene it was written from." (apply.ts:76-80).

The lossless round-trip contract (`parse(write(scene)) ≡ scene`, in CLAUDE.md) already forbids this.
The agent therefore cannot invent a marker through its own scene tools. `edit_branches` validates
before writing (branchpatch.ts:151), and `write_file` refuses `scenes/`.

The remaining gaps are real but different, and the plan should say so, because they change who the
diagnostic is for:

- **A human editing a scene file.** This is the likeliest source, and nothing else covers it.
- **`vngen import`** imports a legacy screenplay and carries over whatever notes the file had.
- **`git_restore`** writes bytes with no model in the path.

§2 is still worth building. The agent inventing notation does not justify it. What justifies it is
that a person or an import writes notation and nothing tells anybody. That justification also weakens
the plan's claim that §2 gives §1.3 "enforcement behind it": the round-trip already enforces the
closed-world sentence, and what §2 adds is reporting on files the agent did not write.

## 4. The real defect §2 walked past: a stray note is silently destroyed on the next write

The case is run rather than read (`splitScenes` + `sceneToDoc`, a scene body containing `[[if:
ember]]` and `[[choice: "Tell the truth" => s13]]`):

```
diagnostics: []
choices:     []
reserialized body: "INT. ROOF - NIGHT\n\n[[nextline: 2]]\n\n[[line: L1]]\nShe hesitates.\n"
```

Three things happen at once, and the third is not in the plan:

- Produces no diagnostic, as §2 states.
- The `=>` typo produces no choice edge and silently changes the story graph.
- **Both notes are gone from the re-serialized body.** The first `edit_scene` to touch that scene
  writes the file back without them, no matter what that edit was for. An unrelated edit to line 4
  deletes the author's `[[TODO: fix the ending]]`, and no check reports the deletion. The round-trip
  check in apply.ts:76 compares model→text against model→text, so the note was already absent from
  both sides of the comparison.

That is data loss on the write path, and it outranks the reporting gap §2 was written for. It also
argues for a fourth site: `planSceneEdit` should compare against the source text it was handed
(`input.sources`), not only against its own serialization, and refuse or warn when a note is about to
be dropped. Until then, the system warns about a dropped note at read time and deletes it silently at
write time.

## 5. An error-severity code makes the offending scene harder to repair, not easier

Trace §2.1's error severity through the call graph, using the behaviour described in §4:

- `validate_inputs` and the commit gate read the file, so the error stands and every commit is
  blocked. The gate is project-wide, so it also blocks a commit of unrelated work in `wiki/`.
- The only writers to `scenes/` are `edit_scene` and `edit_branches`. Neither command can target a
  note: notes never become `SceneLine`s, so no `line` id addresses a note, and `deleteLine` cannot
  name a note.
- The error clears only when the scene is edited for some other reason, at which point the silent
  drop described in §4 removes it.

So an author escapes a blocked commit by making an edit that repairs the problem invisibly and without
documentation, which is the bug in §4. `vngen run` refuses on error as well (`assertValid` at
apps/cli/src/commands.ts:364 throws), so an imported project with one `=>` typo stops building until
someone opens the file by hand. (`export` and `screenplay` report and proceed anyway at
commands.ts:161,194, on the stated grounds that a projection may describe a broken story.)

None of that argues against reporting it. It argues for the consequence-based table in §2, with one
error code for the case that actually breaks the graph. If the error is kept, the diagnostic message
should also name the file to open, since no tool the agent has can reach the note.

## 6. `droppedWarnings` is the missing precedent, and it is warning-severity by design

packages/model/src/screenplay.ts:58-82 already exists for exactly this shape of problem, and its doc
comment reads as if it were written for §2:

Warn about everything the model does not keep. Dropping these fields is a deliberate, documented
choice (see `splitScenes`), but a migration that drops them without warning leaves the author to
discover the loss months later from the export.

Its `DROPPED` list has three entries (section headings, page breaks, and dual-dialogue cues) and does
not include an unparsed note, though an unparsed note is dropped just as thoroughly. §2 therefore does
not add a new diagnostic; it adds a fourth row to a list whose comment already promises completeness.
That list uses the `warning` severity.

The plan has two concrete consequences. First, `unknown_marker` should say "will be absent" in the
`dropped_element` voice rather than "is not one of the six". Second, `droppedWarnings` should gain the
row so the import path reports it too. §3 above identifies that second change as one of the three
doors.

## 7. The exhaustiveness check does not fail the build

This snippet comes from §1.7:

```ts
type _AllKindsListed = BranchMarker['kind'] extends (typeof BRANCH_MARKER_KINDS)[number]
  ? true
  : never;
```

A type alias that resolves to `never` is a perfectly legal type alias. Nothing consumes
`_AllKindsListed`, so adding a seventh kind to the union resolves the alias to `never` and the file
compiles clean. The alias does not perform the check its comment claims. The check needs a value
position:

```ts
type _AllKindsListed = BranchMarker['kind'] extends (typeof BRANCH_MARKER_KINDS)[number]
  ? true
  : { error: 'a BranchMarker kind is missing from BRANCH_MARKER_KINDS' };
const _allKindsListed: _AllKindsListed = true;
```

The `satisfies` half is correct and catches the other direction (an entry that is not a kind). The
conditional also does not distribute, because `BranchMarker['kind']` is a concrete union rather than a
naked type parameter, and that non-distribution gives the subset test its intended meaning.

The `goto` clause in the same section (_"except `goto`, which is a synonym rather than a kind"_)
excludes nothing: `goto` is not in `BRANCH_MARKER_KINDS`, because it is not a kind. Delete the clause.

## 8. Wave 3 is ordered before wave 1

§6 numbers `git_commit` as wave 3 and then instructs: _"Must land no later than wave 1 … if only one
of the two can ship, ship this one first."_ A wave that must precede wave 1 would be numbered wave 0,
so the numbering contradicts the instruction. §1 above removes the constraint entirely, so the fix is
to delete the wave rather than renumber it. The plan should not ship with an ordering that contradicts
its own numbering.

## 9. Smaller corrections

- **§1.2's opening sentence undercounts itself.** "These are all of them" introduces five rows, and
  the sixth is described three sentences later. Say "five you may write, and a sixth that belongs to
  the retired whole-file form" up front.
- **§1.5 promises `story_graph` shows unreachable scenes.** It does, but `unreachable_scene` is a
  warning (`build.ts:356`), so the agent can commit with one outstanding. Worth one clause, since the
  paragraph otherwise implies the gate catches it.
- **§2.2's `where: opts.sceneId ?? current?.id` is correct on the chunk path but not on the legacy
  one.** In the chunk path `opts.sceneId` is always set (entities.ts:128), so the fallback fires only
  on the legacy whole-file path. There `current?.id` is the pre-override id and can differ from the
  final one, because scenes.ts:194-208 applies `[[scene:]]` overrides after the walk. Collect the note
  diagnostics and stamp `where` in that later loop, or accept a stale id and say so.
- **`writeFileAtomic`'s temp name is deterministic** — fs.ts:16-21 computes it as `sha1(path +
  data.length)`, so two concurrent writers of the same path with same-length data share a temp file.
  The `finally` block in §5 fixes the litter but not the shared temp file. A random suffix fixes both
  and is the same edit.
- **The 25,000-character budget is untested against the real ceiling.** Nothing measures the
  assembled prefix (`SYSTEM_PROMPT` plus the map plus `AICONTEXT.md`), and the map's own budget is
  8,000. The prompt assertion is worth keeping, but it does not measure the always-on cost, which is
  the question §1 opens with.

## What survives

All of §1 stands except the exhaustiveness snippet and two sentences. The prompt findings were
re-derived line by line, and every one holds. Nothing above touches the ordering argument. §1.8's
cache-invalidation point is right, and it is now the only reason to keep §1 as one wave.

§4 (the `branching` skill) is unchanged. Nothing in the code contradicts it, and the parent report
rests on its reasoning about where skills can and cannot live.

§5 survives with one addition: the deterministic temp name.

§2 survives. Its threat model is rewritten, its severity table is rebuilt around consequence, and its
`unknown_marker` becomes the fourth `DROPPED` row. §4 above covers the silent destruction of a note on
the next write, and it is promoted into §2, because that is the larger defect and the two are one edit
apart.

§3 goes entirely.

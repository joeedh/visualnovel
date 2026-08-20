# Pressure test — `plans/what-the-agent-knows-about-the-story-format.md`

An adversarial read of the plan against the code as it stands (August 2026). Every file it cites was
re-read, the note census it reasons about was run over the corpus, and the central claim of §2 — that
an invented marker reaches a scene file through `edit_scene` — was checked by running it rather than
by reading.

The prompt half (§1) survives almost intact; it is the half that needs no code to be true. The two
halves that touch code do not. **§3 is already built and has been since the agent's first commit**,
and §2's error-severity rule is contradicted by two explicit comments in the module it is checking,
by the precedent one file over, and by what the parser actually does. What follows is ordered by how
much work the error moves.

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

The parts I tried hardest to break and could not:

- **The marker table really is three of six.** `BranchMarker` has six kinds
  (`packages/parse/src/branch.ts:14-20`); the marker block at `context.ts:50-54` lists three.
  `[[outfit:]]` is at `context.ts:126`, in the art-inheritance paragraph; `[[line:]]` and
  `[[nextline:]]` appear nowhere. (The parent report's "line 109" counts from the prompt's own first
  line, which is `context.ts:18`; both are the same place.) The central prompt finding holds.
- **The `[[scene:]]` contradiction is real and fifteen lines wide.** Line 38 says a chunk body
  carries no `[[scene:]]` marker and cannot override its id; line 51 lists `[[scene:]]` as a marker
  that "assigns a stable id to the current scene". Both are in the prompt today.
- **The preamble denies `approve_assets` in the plain reading.** Line 20 is one clause, and
  "you never run the image-generation pipeline" sits in the paragraph a model reads most closely.
- **The corpus census supports the closed-world claim.** Across all forty scenes in
  `examples/test4`, `[[ … ]]` notes are only ever `line` (214), `nextline` (53), `next` (46) and
  `choice` (10). Not one stray note, not one invented marker key. Two consequences: the invented
  conditional really was prose rather than notation, and §2.1's feared false-positive rate on real
  material is zero — on machine-written material, which is the weaker half of the claim.
- **`deleteLines` is a paste of `insertLines`.** `lineops.ts:220-250` folds `insertLine` over a
  list, threading `scenes` through and refusing with `line N of M: … Nothing was inserted.` The
  symmetric op needs no new machinery, and §5's "single `ScriptState` transition" is what that
  pattern already achieves. This is the least risky thing in the plan.
- **A chunk with two scenes is caught, as §2.3 says.** `entities.ts:129-141`, error severity. The
  correction to the parent report holds.

## 1. `git_commit` already validates, in the loop, since the first commit

`packages/authoring/src/loop.ts:813-819`:

```ts
if (name === 'git_commit') {
  const errors = await this.workspaceErrors();
  if (errors.length) {
    emit({ type: 'blocked', tool: name, reason: 'validation errors block commit' });
    return `Commit blocked: fix ${errors.length} validation error(s) first:\n` + errors.join('\n');
  }
```

`workspaceErrors` (`loop.ts:894-899`) loads the model and filters `severity === 'error'`. Its doc
comment names itself: _"Error-severity diagnostics currently in the project (the commit gate)."_
`git log -S` puts it in `883d4a25`, the commit that implemented the agent.

So §3 of the plan builds a gate that exists, and the parent report's "`git_commit` never validates,
so the prompt's promise is discipline" is **false**. What the transcripts showed — validate_inputs
run before 14 commits of 20 — is a different claim about the agent's habits, and it stands; it just
does not imply what it was taken to imply.

Three things follow:

- **§3 should be deleted, not narrowed.** Adding the same filter inside `gitCommitTool` puts one
  rule in two places, which the codebase's own comment at `tools.ts:759-762` calls out as "how two
  answers start to disagree".
- **§1.5's prompt text is still right, and is now free.** "git_commit runs validate_inputs itself and
  refuses on an error" describes the shipped system. It can go in with wave 1 with no code behind it.
- **The one real gap is host coverage.** The gate is keyed on the tool *name* in the agent loop, so
  anything that calls `gitCommitTool` outside the loop is ungated. Worth one sentence in the plan
  recording that this is deliberate rather than missed — the agent is the only caller today.

The plan's §6 wave-ordering constraint ("`git_commit` must land no later than wave 1") dissolves with
it.

## 2. The error/warning split is argued from confidence; the code argues from consequence

§2.1 assigns severity by how confident the checker can be: a recognised key that fails to parse is
"unambiguously a mistake", so error. `packages/parse/src/branch.ts` says otherwise, in comments,
twice:

- On `outfit` (`:37-38`): _"One pair per marker… a value with whitespace or a missing half is a
  **plain note** rather than a half-read marker."_
- On `nextline` (`:50-52`): _"A non-numeric value is a **plain note, not a broken allocator**:
  splitScenes then derives the mark from the ids it saw, which is the same path an unmigrated file
  takes."_

Both say the decline is a designed fallback with a defined recovery, not a mistake. §2.1 would make
`[[outfit: aiko = uniform]]` and `[[nextline: soon]]` **errors** — and, after the commit gate in §1,
uncommittable — against a documented intent to treat them as prose. That is not a severity
disagreement, it is the plan overruling a decision it never noticed it was overruling.

The split that survives contact with the code is by **consequence**, which is what the existing
codes already use (`dangling_goto` errors because an edge is broken; `unknown_character` warns
because a cue is only probably wrong):

| note                                             | what is lost                         | severity                       |
| ------------------------------------------------ | ------------------------------------ | ------------------------------ |
| `choice`, `next`/`goto` that fails to parse       | a story-graph edge, silently         | **error**                      |
| `line` that fails to parse                       | the shot's anchor; a fresh id is allocated | **error**                 |
| `outfit`, `nextline`, `scene`/`id` that fails    | nothing — documented fallback path   | **warning**                    |
| any other `key: value` note                      | nothing the model wanted             | **warning** (`unknown_marker`) |

That keeps the one case §2 was written for — `=>` for `->` — at error, and stops the plan from
erroring on two paths the parser deliberately supports.

## 3. The threat model is wrong: `edit_scene` cannot write a note at all

§2 says the invented marker "arrives as the *text of a prose line* through `edit_scene`, which has no
reason to inspect it". It cannot arrive that way. A `[[ … ]]` line re-parses as a `note` element, and
`Scene` has no field that holds one, so:

1. `insertLine` writes the line into the model as prose;
2. `planSceneEdit` serializes the scene and reads it back (`apply.ts:66-68`);
3. the note is not in the model, so it is not in the re-serialized text;
4. `sceneToDoc(read.value.scene).body !== doc.body` and the edit is refused with _"Writing s1 would
   not read back as the scene it was written from."_ (`apply.ts:76-80`).

The lossless round-trip contract — `parse(write(scene)) ≡ scene`, in `CLAUDE.md` — already forbids
this. So the agent cannot invent a marker through its own scene tools, and `edit_branches` validates
before writing (`branchpatch.ts:151`), and `write_file` refuses `scenes/`.

The remaining doors are real but different, and the plan should say so, because they change who the
diagnostic is for:

- **A human editing a scene file.** The likeliest source, and the one nothing else covers.
- **`vngen import`** of a legacy screenplay, which carries whatever notes the file had.
- **`git_restore`**, which writes bytes with no model in the path.

§2 is still worth building. Its justification is not "the agent invents notation" — it is "a person
or an import writes one, and nothing tells anybody". That also weakens the plan's claim that §2 gives
§1.3 "enforcement behind it": the closed-world sentence is enforced already, by the round-trip, and
what §2 adds is *reporting* on files the agent did not write.

## 4. The real defect §2 walked past: a stray note is silently destroyed on the next write

Running the case rather than reading it (`splitScenes` + `sceneToDoc`, a scene body containing
`[[if: ember]]` and `[[choice: "Tell the truth" => s13]]`):

```
diagnostics: []
choices:     []
reserialized body: "INT. ROOF - NIGHT\n\n[[nextline: 2]]\n\n[[line: L1]]\nShe hesitates.\n"
```

Three things at once, and the third is not in the plan:

- No diagnostic, as §2 says.
- No choice edge — the `=>` typo really does change the story graph in silence.
- **Both notes are gone from the re-serialized body.** So the first `edit_scene` that touches that
  scene for any reason writes the file back without them. The author's `[[TODO: fix the ending]]` is
  deleted by an unrelated edit to line 4, and nothing reports it — the round-trip check in
  `apply.ts:76` compares model→text against model→text, so the note was already absent from both
  sides of the comparison.

That is data loss on the write path, and it outranks the reporting gap §2 was written for. It also
argues for a fourth site: `planSceneEdit` should compare against the **source** text it was handed
(`input.sources`), not only against its own serialization, and refuse or warn when a note is about to
be dropped. Until then, "warn about it at read time" and "silently delete it at write time" are the
same system disagreeing with itself.

## 5. An error-severity code makes the offending scene harder to repair, not easier

Following §2.1's error severity through the call graph, with §4's behaviour in hand:

- `validate_inputs` and the commit gate read the **file**, so the error stands and every commit is
  blocked — including a commit of unrelated work in `wiki/`, since the gate is project-wide.
- The only writers to `scenes/` are `edit_scene` and `edit_branches`. Neither can *target* a note:
  notes never become `SceneLine`s, so no `line` id addresses one, and `deleteLine` cannot name it.
- The only way to clear the error is to edit the scene for some other reason and let §4's silent drop
  remove it.

So the escape from a blocked commit is an edit whose repairing effect is invisible, undocumented, and
happens to be the bug in §4. `vngen run` refuses on error as well — `assertValid` at
`apps/cli/src/commands.ts:364` throws — so an imported project with one `=>` typo stops building
until someone opens the file by hand. (`export` and `screenplay` report and proceed anyway,
`commands.ts:161,194`, on the stated grounds that a projection may describe a broken story.)

None of that is an argument against reporting it. It is an argument for the consequence-based table
in §2 — one error code, for the case that actually breaks the graph — plus, if the error is kept, a
sentence in the diagnostic message saying which file to open, since no tool the agent has can reach
the note.

## 6. `droppedWarnings` is the missing precedent, and it is warning-severity by design

`packages/model/src/screenplay.ts:58-82` already exists for exactly this shape of problem, with a doc
comment that reads as if it were written for §2:

> Warn about everything the model does not keep. Dropping these is a deliberate, documented choice
> (see `splitScenes`), but dropping them _quietly_ during a migration is how an author discovers it
> months later from the export.

Its `DROPPED` list has three entries — section headings, page breaks, dual-dialogue cues — and does
**not** include an unparsed note, though that is dropped just as thoroughly. So §2 is not a new
diagnostic so much as the fourth row of a list whose comment already promises completeness, and the
severity that list uses is `warning`.

Two concrete consequences for the plan: `unknown_marker` should say _will be absent_ in the
`dropped_element` voice rather than _is not one of the six_, and `droppedWarnings` should gain the
row so the import path reports it too — which is one of the three doors §3 above identifies.

## 7. The exhaustiveness check does not fail the build

§1.7's snippet:

```ts
type _AllKindsListed = BranchMarker['kind'] extends (typeof BRANCH_MARKER_KINDS)[number]
  ? true
  : never;
```

A type alias that resolves to `never` is a perfectly legal type alias. Nothing consumes
`_AllKindsListed`, so adding a seventh kind to the union resolves it to `never` and compiles clean —
the check the comment claims is the one thing it does not do. It needs a value position:

```ts
type _AllKindsListed = BranchMarker['kind'] extends (typeof BRANCH_MARKER_KINDS)[number]
  ? true
  : { error: 'a BranchMarker kind is missing from BRANCH_MARKER_KINDS' };
const _allKindsListed: _AllKindsListed = true;
```

The `satisfies` half is fine and catches the other direction (an entry that is not a kind). Note also
that the conditional does not distribute — `BranchMarker['kind']` is a concrete union, not a naked
type parameter — which is what makes the subset test mean what it should.

The `goto` clause in the same section (_"except `goto`, which is a synonym rather than a kind"_) has
nothing to except: `goto` is not in `BRANCH_MARKER_KINDS`, because it is not a kind. Delete the
clause.

## 8. Wave 3 is ordered before wave 1

§6 numbers `git_commit` as wave 3 and then instructs: _"Must land no later than wave 1 … if only one
of the two can ship, ship this one first."_ A wave that must precede wave 1 is wave 0. With §1 above
the whole constraint disappears, so the fix is to delete the wave rather than renumber it — but the
plan should not ship with an ordering that contradicts its own numbering.

## 9. Smaller corrections

- **§1.2's opening sentence undercounts itself.** "These are all of them" introduces five rows, and
  the sixth is described three sentences later. Say "five you may write, and a sixth that belongs to
  the retired whole-file form" up front.
- **§1.5 promises `story_graph` shows unreachable scenes.** It does, but `unreachable_scene` is a
  **warning** (`build.ts:356`), so the agent can commit with one outstanding. Worth one clause, since
  the paragraph otherwise implies the gate catches it.
- **§2.2's `where: opts.sceneId ?? current?.id` is right for the wrong reason.** In the chunk path
  `opts.sceneId` is always set (`entities.ts:128`), so the fallback only fires on the legacy
  whole-file path, where `current?.id` is the pre-override id and can differ from the final one
  (`scenes.ts:194-208` applies `[[scene:]]` overrides after the walk). Collect the note diagnostics
  and stamp `where` in that later loop, or accept a stale id and say so.
- **`writeFileAtomic`'s temp name is deterministic** — `sha1(path + data.length)`, `fs.ts:16-21` — so
  two concurrent writers of the same path with same-length data share a temp file. §5's `finally`
  fixes the litter and not this; a random suffix fixes both, and is the same edit.
- **The 25,000-character budget is untested against the real ceiling.** Nothing measures the assembled
  prefix — `SYSTEM_PROMPT` plus the map plus `AICONTEXT.md` — and the map's own budget is 8,000. The
  prompt assertion is worth having; it just does not answer "is the always-on cost sane", which is the
  question §1 opens with.

## What survives

All of §1 except the exhaustiveness snippet and two sentences: the prompt findings were re-derived
line by line and every one holds, the ordering argument is untouched by anything above, and §1.8's
cache-invalidation point is right and is now the only reason to keep §1 as one wave.

§4 (the `branching` skill) is untouched — nothing in the code contradicts it, and the reasoning about
where skills can and cannot live is the load-bearing idea of the parent report.

§5 survives with one addition (the deterministic temp name).

§2 survives with its threat model rewritten, its severity table rebuilt around consequence, its
`unknown_marker` reframed as the fourth `DROPPED` row, and §4 above — the silent destruction of a
note on the next write — promoted into it, because it is the larger defect and the two are one edit
apart.

§3 goes entirely.

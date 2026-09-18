# Scene prose guidance, and making AICONTEXT.md rules reach the model

Status: **planned**

Origin: GitHub issue #4
(`AGENTREPORT: Agent wrote an incomplete and badly formatted scene`), generated from
`examples/dadsStory`. The analysis behind this plan read the reported thread's native log
(`vngen/state/threads/20260917-164320.native.jsonl`), the six threads before it, the scene
on disk, and the code under `packages/authoring`.

## What happened

- The author scaffolded 24 scenes from a treatment, then asked the agent to write one
  (`abduction`). The agent wrote 13 `narration` lines and no `dialogue` lines.
  Camera-style description ("From the shadows on a fire escape above, a single, sharp
  hiss.") sits in narration, which the runner reads to the player in the dialogue box.
- `AICONTEXT.md` in that project already said "Dialog must not be embedded in narrator
  lines" and "Descriptive prose belongs in shot prompts and not in narration lines". It
  had no visible effect.
- The issue's headline finding — that the scene covered only one of two captures — is
  false. The scene on disk covers both. The analyst concluded otherwise because the
  transcript it was given clips every tool call's arguments at `ARGS_MAX = 600`
  (`apps/desktop/src/main/notify/threads.ts:54`) with a bare `…`, and nothing told the
  analyst that the cut existed. It read `"T…` as the end of the scene.
- A second defect the issue did not notice: `edit_scene op=newScene` silently discards a
  `lines` argument. The agent passed a one-line narration summary on every one of its 24
  `newScene` calls; `@vn/scriptedit`'s `newScene` builds `lines: []`
  (`packages/scriptedit/src/lineops.ts:398`); `SCENE_OP_ARGS` in
  `packages/authoring/src/tools/scenes.ts` checks only for _missing_ arguments; the
  observation ("Created abduction (denver_streets/night); nothing points at it yet.") says
  nothing about the dropped text. The scaffold commit `1a1ace4` has 24 empty scenes and a
  commit message claiming each holds a summary.

## Why the rule in AICONTEXT.md did not work

The system prompt the model received, in order:

| Section                          | Chars  | Guidance on writing scene prose |
| -------------------------------- | ------ | ------------------------------- |
| BUILT-IN                         | 15,178 | none                            |
| PROJECT MAP (generated)          | 3,236  | none (facts)                    |
| PROJECT CONTEXT (`AICONTEXT.md`) | 221    | the two rules                   |

- **The built-in prompt never says what a scene is for.** `SYSTEM_PROMPT` in
  `packages/authoring/src/context.ts` covers markers, line ids, coverage, art-style rungs,
  GitHub Pages and token budgets, and never states that a visual novel is dialogue over a
  picture, what a `narration` line is read as, where visual description belongs, or what a
  well-formed body looks like. The `edit_scene` schema adds only
  `kind: 'defaults to dialogue'` and `speaker: 'the character cue; omit for narration'`.
  With nothing else to go on, the model wrote prose fiction.
- **The built-in prompt contradicts the author's rule.** BUILT-IN says "You never write an
  image prompt." `AICONTEXT.md` says "Descriptive prose belongs in shot prompts." There is
  no tool or concept called a shot prompt. The real paths are: `camera` on a shot or a
  panel and `artNotes` on a panel, in `write_storyboard` and `set_panels`; and
  `set_art_notes target=shot:<sceneId>/<shotId>` for a shot that already exists, drawn or
  not. A rule the model cannot map to a tool is the easiest rule to drop.
- **Precedence is documented as built-in over AICONTEXT.** `context.ts:1-9` and
  `docs/reference/vnauthor.md` ("Context precedence") both say built-in > `AICONTEXT.md`.
  The generated map's label says `AICONTEXT.md` overrides _it_; nothing says the author's
  rules override any built-in default, and by the documented design they do not.
- **The AICONTEXT section is framed as a file dump.** Its header is
  `--- PROJECT CONTEXT (AICONTEXT.md) ---`. The map, by contrast, gets a sentence
  explaining what it is and how much to trust it.
- **Two confounds, stated so they are not over-read.** Of the project's seven threads, the
  one that correctly extracted dialogue and moved description onto shots
  (`20260917-004548`) ran at effort `medium`, on the **native** backend, with the rules
  stated in the author's own message. The failing thread (`20260917-164320`) ran at `low`,
  on the **structured** backend, with the rules only in `AICONTEXT.md`. Only that one
  thread had the rules in place and ignored them (`20260917-001705` also wrote
  all-narration prose at `low`, but before the rules existed). Effort, backend and where
  the rule sat all changed together; the verification below separates them.
- **Open question: why was a Claude model on the structured backend?** Every thread in the
  project whose header records `backend: "structured"` also records
  `model: claude-opus-4-8`. `chooseBackend`
  (`apps/desktop/src/main/session/core.ts:1096-1104`) routes any chat backend with
  `chatConversation` to the native path, and the Anthropic backend always has one
  (`packages/providers/src/backends/anthropic.ts:188`). The structured path re-renders the
  tool catalog and the whole transcript into one text prompt per step and caches nothing.
  The messages in the log confirm the protocol (string content with an embedded JSON
  action, not content blocks). This is either a startup ordering bug in how the renderer's
  saved model binding reaches `buildBackend`, or something the log records wrongly. It is
  not in this plan's scope; it is written here so the verification run checks the header
  and so someone looks.

## Changes

Eight, ordered by how much of the failure each one removes on its own. 1–3 are small,
independent, and the minimum; 4–8 each stand alone.

### 1. A `WRITING SCENES` section in `SYSTEM_PROMPT`

- Where: `packages/authoring/src/context.ts`, immediately after the
  `FOUNTAIN + BRANCH MARKERS` block, before `SHOTS AND COVERAGE`. A test asserts the order
  (see below).
- Says, in about twenty lines:
    - A scene plays as lines in a dialogue box over one picture at a time. The player
      hears every line.
    - `dialogue` is what a character says, with a `speaker`. Most of a scene is dialogue.
    - `narration` is the narrator's voice: a beat the player must know that no one says
      aloud. It is not stage direction and not a camera. The player hears it too.
    - What the frame _looks like_ — who stands where, light, weather, the fire escape, the
      hiss from the shadows — is not something the player should hear. Where it goes
      depends on what exists:
        - A scene with a storyboard: `camera` on the shot or panel, `artNotes` on the
          panel (`set_panels`), or `set_art_notes target=shot:<sceneId>/<shotId>`.
        - A scene without one: the scene's synopsis (`edit_scene op=setSynopsis`, change
          8), which the decomposer reads when it plans the shots and the runner never
          reads aloud. Do not write it into narration and do not stop to storyboard the
          scene unless the author asks.
    - The lines a shot covers already reach its picture as mood context
      (`packages/artgen/src/prompts.ts:661-670`), so the prose need not describe the scene
      for the picture's sake — only for the player's.
    - One example in `insertLines` argument form (the shape the agent actually emits): six
      line objects, one `narration`, five `dialogue` across two speakers. Not Fountain —
      the agent never writes Fountain.
    - When expanding a scene from a summary or synopsis, every event and character it
      names must appear in the prose; read it back after writing and say what is missing.
- Reword "You never write an image prompt." in `HOW ART STYLE REACHES A PICTURE` to say
  what it means: the _prompt string_ is derived and not yours to write; art notes, camera,
  and the sheet bodies are yours, and they are how description reaches a picture. As
  written it cancels the path an author's rule points at.
- Tests: `packages/authoring/src/tests/context.test.ts` gains `indexOf` assertions that
  `WRITING SCENES` sits after `FOUNTAIN + BRANCH MARKERS` and before `SHOTS AND COVERAGE`
  in `SYSTEM_PROMPT`. The 25,000-character ceiling at `context.test.ts:172` leaves room.
  No test asserts prose content beyond that — the prompt is reviewed by reading.
- Undo cost: none for a new thread, which re-caches. A **resumed** thread pays one
  supersede message carrying the whole ~15k-character BUILT-IN section on its next turn
  (`refreshSystem`, `packages/authoring/src/loop.ts:687-709`; resume at
  `apps/desktop/src/main/session/agent.ts:415-418`). That is the price of any prompt edit
  and is paid once per resumed thread.

### 2. `edit_scene` refuses an argument its op does not take

- Where: `packages/authoring/src/tools/scenes.ts`, in `run` before `sceneDecider`.
- A second table beside `SCENE_OP_ARGS` lists what each op _accepts_, derived from
  `sceneDecider`:

    | op          | accepts                             |
    | ----------- | ----------------------------------- |
    | setLineText | line, text                          |
    | insertLine  | scene, text, after, kind, speaker   |
    | insertLines | scene, lines, after                 |
    | deleteLine  | line                                |
    | deleteLines | lineIds                             |
    | moveLine    | line, after                         |
    | moveShot    | scene, shot, after                  |
    | newShot     | scene, lineIds, framing, subjects   |
    | deleteShot  | scene, shot                         |
    | setSpeaker  | line, speaker                       |
    | newScene    | scene, heading, synopsis (change 8) |
    | setHeading  | scene, heading                      |
    | deleteScene | scene                               |
    | splitScene  | scene, at, into                     |
    | mergeScene  | scene, into                         |
    | setSynopsis | scene, text (change 8)              |

    A surplus known key is refused by name:
    `newScene does not take lines; create the scene, then edit_scene op=insertLines to write its body, or pass synopsis for a one-line summary.`
    The message is specific for `newScene` + `lines` because that is the case that
    happened; every other surplus gets `<op> does not take <key>`.

- `scene` is accepted on every line op as well
  (`setLineText scene=arrival line=arrival:L1`), because it is redundant rather than
  wrong, and refusing it would cost a round trip for nothing.
- `sceneEditShape` becomes `.strict()`, as the storyboard shapes already are
  (`storyboard.ts`), so a key the schema has never heard of (`summary`) is refused rather
  than stripped by the loop's `safeParse` (`loop.ts:998`). Without this, the table only
  catches known keys on the wrong op.
- The `lines` field description and the tool description (`scenes.ts:92-100, 235-249`) say
  `newScene takes no lines`, so the refusal is read before it is earned.
- `edit_branches` has the same absence-only check (`BRANCH_OP_ARGS`, `scenes.ts:325-331`)
  and gets the same treatment, with its own accepted-arguments table.
- Tests: `packages/authoring/src/tests/tools/scenes.test.ts` gains one case per refused
  shape: `newScene` + `lines`, an unknown key, a surplus `after` on `deleteLine`, and the
  redundant `scene` on `setLineText` accepted. No existing case passes a surplus argument.
- Undo cost: none.

### 3. The AICONTEXT section is framed as the author's standing rules

- Where: `systemSections` in `packages/authoring/src/context.ts`.
- New header text:
  `--- PROJECT CONTEXT (AICONTEXT.md — the author's standing rules for this project. Where one conflicts with a default above, the author's rule wins. It cannot override the input contract or the safety rules: the file layout, the markers, what each tool writes, MODE, the confirmation rule for reverts and deletions, and never reading, logging or committing keys.) ---`.
  The words `PROJECT CONTEXT` stay in the header, so `context.test.ts:92`'s
  `indexOf('PROJECT CONTEXT')` over the composed text still finds it.
- The section `name` stays `PROJECT CONTEXT (AICONTEXT.md)`. `refreshSystem` compares by
  name _and_ text, so the text change files a supersede message on a resumed thread either
  way; the name is kept because the System Prompt editor styles the authored card on
  `name.startsWith('PROJECT CONTEXT')`
  (`apps/desktop/renderer/pathux/editors/systemprompt.ts:144`), seven tests hard-code it
  (`loop.test.ts`, `threads.test.ts`, `systemprompt.test.ts`), and
  `docs/reference/desktop-app-editors-misc.md:256` documents it.
- Inside `SYSTEM_PROMPT`, the blocks that are contract rather than default are marked as
  such where they sit, in one clause each: `PROJECT LAYOUT (the input contract)` already
  is; `FOUNTAIN + BRANCH MARKERS`, `WHAT WRITES WHAT`, `MODE`, and the two safety lines
  under `HOW YOU WORK` get the same. The model then does not have to guess the boundary
  the header names.
- Update the precedence comment at the top of `context.ts` and the "Context precedence"
  bullet in `docs/reference/vnauthor.md`: contract and safety rules > `AICONTEXT.md` >
  built-in defaults (style, what goes where in a scene, tone) > generated map > inferred
  defaults. The prompt is still one string; the split is in prose and in the block labels.
- `templates/basic/AICONTEXT.md` opens with "The built-in input contract always wins; this
  file refines it for _this_ project." That stays true and is left alone.
- Tests: `context.test.ts:92` holds; add one that the composed prompt contains
  `the author's rule wins`.
- Undo cost: none for new threads; one supersede message per resumed thread, as in 1.

### 4. The agent's starting effort becomes `medium`; the provider fallback stays `low`

- `DEFAULT_EFFORT` is not only the agent surfaces' default. `createAnthropicChat` falls
  back to it for every call built without an explicit effort
  (`packages/providers/src/backends/anthropic.ts:76`), and that is the whole pipeline text
  LLM (`factory.ts:159,163` — decomposition, reviews, refine critiques), art direction and
  `propose_storyboard` (`packages/authoring/src/art.ts:140,214`), the desktop project
  session (`session/project.ts:499`) and the approval-gate triage (`session/gate.ts:246`).
  Raising it would raise the cost of every text call in a `vngen run`.
- So: a second constant, `DEFAULT_AGENT_EFFORT: EffortChoice = 'medium'`, in
  `packages/types/src/textmodels.ts` beside `DEFAULT_EFFORT`, with a comment saying which
  is which. The agent hosts read the new one: `apps/desktop/src/main/session/core.ts:741`,
  `apps/desktop/renderer/pathux/app/state.ts:126`, `apps/authoring/src/repl.ts:277`,
  `apps/authoring/src/agent.ts`. `DEFAULT_EFFORT` and its readers are untouched.
- The comment on `DEFAULT_EFFORT` says why it is a level rather than an absence; the new
  constant's comment says why `medium`: at `low`, a rule placed after a 15,000-character
  prompt was not applied in the one thread that had it, and the author can still bind
  `low` per conversation.
- Stale afterwards, and updated: `apps/desktop/src/shared/advice.ts:34` ("`DEFAULT_EFFORT`
  is `low`, so without the raise…") and `docs/reference/vnauthor.md:43` ("starts at
  `low`").
- Tests: `packages/types/src/tests/textmodels.test.ts:90-92` and
  `packages/providers/src/tests/providers.test.ts:185` assert `DEFAULT_EFFORT` is `low`
  and keep passing. Add one asserting `DEFAULT_AGENT_EFFORT` is `medium` and resolves to
  `medium` on the curated models. `ux-model.json` and `anchors.json` are unaffected: the
  convo-bar situations bind `effort: 'medium'` explicitly
  (`rules/situations/convobar.ts:40`).
- Cost: more thinking tokens per agent turn. Undo cost: one constant.

### 5. The transcript marks what it cut

- Where: `clampDetail` in `apps/desktop/src/main/notify/threads.ts` — the args and output
  fields only. `clamp` itself is also what caps the pane's `text` line (`TEXT_MAX`),
  `full` and compaction text (`threads.ts:89-91, 298-304, 334-340`), and those are read by
  the author in the convo pane; a `[cut …]` marker there is noise, and
  `threads.test.ts:183, :203` assert a bare `…` on them. So `clampDetail` gets its own
  clip: `… [cut at 600 of 1743 chars]`, plain digits, no locale formatting.
- Where: `packages/agentreport/src/analyze.ts`. The analyst's `SYSTEM` text gains a
  paragraph: a tool call's arguments and output in the transcript are cut at a fixed
  length and say so where they are; a cut value is not evidence of what came after it, and
  a finding that depends on the missing part must say so and set confidence accordingly.
  It names transcript args/output specifically; `sourcetools.ts:234` and `render.ts:19`
  also cut with a bare `…` and are a different mechanism.
- Not done: giving the analyst the native log. The native log holds the author's fiction
  verbatim and the report is posted publicly; `requesttools.ts` exists precisely to keep
  long verbatim spans out of the analyst's reach. Marking the cut is enough to stop the
  false inference.
- Tests: `threads.test.ts` gains an assertion on the marker's shape for a clipped `args`.
- Undo cost: the marker lands in committed `vngen/state/threads/*.jsonl`; reverting later
  leaves old logs carrying it. Harmless to every reader.

### 6. The analyst is told when it cannot read the source

- The report for issue #4 cited `packages/agent/src/skills/writing/writeScene.ts`, which
  does not exist, because the analyst ran without source access (`Read the source: no`)
  and guessed a path.
- `analyze.ts` has two paths. The loop path builds `sections()` (lines 436-441) and adds
  `SOURCE_ACCESS` only when source is granted; the direct path (`analyzeDirectly`, lines
  262-272) sends `SYSTEM` alone. So:
    - A `NO_SOURCE` paragraph — you cannot read the source; do not cite a path you have
      not read; name the behaviour to change rather than a file — is added to `sections()`
      under the **same name** `'source access'` as `SOURCE_ACCESS`, so a mid-conversation
      `grant({kind:'source'})` (lines 480-484) supersedes it rather than leaving both in
      force.
    - The direct path appends `NO_SOURCE` to `SYSTEM`.
- `report.ts:28` describes `where` as "the file or tool it belongs in, if you know one",
  which invites a path. It becomes "the tool, or the file if you have read it".
- Tests: `analyze.test.ts` (or wherever `sections()` is covered) asserts the no-source
  paragraph is present without a grant and absent with one.
- Undo cost: none.

### 7. Phase 8 of the `full-production` skill

- Where: `templates/basic/.aiagent/skills/full-production/SKILL.md`, "Phase 8 — the
  scripts". Today it says how to call `insertLines` and nothing about what to put in it.
- Add the four points from change 1 (dialogue-first, narration is the narrator, the player
  hears every line, the summary is a checklist), two or three sentences each, and where
  description goes during phase 8 specifically: the synopsis (change 8), because no scene
  has a storyboard until the hand-off and the skill's own rule is not to storyboard for
  the author. Phase 7 (`SKILL.md:81`) says `newScene` takes a `synopsis` and no `lines`.
- `examples/dadsStory` has no `.aiagent/skills`, so this change is not exercised by the
  verification below; it is reviewed by reading.
- `docs/plans/builtin-skills.md` moves these skills into a builtin catalog; the edit is
  made to the file where it lives at the time and carries across the move.
- Undo cost: none.

### 8. `setSynopsis`, and `newScene` takes a `synopsis`

- Scenes already have a synopsis: the Fountain `= …` line, parsed at
  `packages/model/src/scenes.ts:148`, serialized at `serialize.ts:262`, carried through
  every `@vn/scriptedit` op (`withLines`, `lineops.ts:107`), handed to the decomposer as
  `Synopsis: …` (`packages/artgen/src/storyboard.ts:225`), shown by `parse_fountain`
  (`tools/validate.ts:32`), and deliberately kept out of the picture prompt
  (`prompts.ts:636`). Nothing the agent can call sets it. It is exactly what the 24
  `newScene` calls were reaching for, and it is the parking place change 1 needs for
  description written before a storyboard exists.
- `@vn/scriptedit` gains `setSynopsis(state, { scene, text })`: refuses a newline (the
  serializer writes one `= ` line) and an unknown scene; writes `{ ...scene, synopsis }`
  with an empty text clearing it. `newScene` gains an optional `synopsis` and writes it
  the same way.
- `edit_scene` gains `op: setSynopsis` (`scene`, `text`) and `newScene` accepts
  `synopsis`. Like `insertLines` and `deleteLines`, `setSynopsis` has no `story.*` command
  behind it — the header comment on `SCENE_OPS` already records that exception for ops a
  person has no button for, and this one is extended to name it. No command means no
  `paletteonly.ts` entry, no `gen:uxmodel`, no anchor sweep.
- The observation for `newScene` with a synopsis says so:
  `Created abduction (denver_streets/night) with a synopsis; nothing points at it yet.`
- Tests: `packages/scriptedit/src/tests/lineops.test.ts` for the op and for `newScene`
  carrying it; `scenes.test.ts` for the tool op and the round trip through
  `parse_fountain`.
- Undo cost: the op and the argument; a synopsis already written stays a valid Fountain
  line the parser already read.

## Not doing

- **A rules reminder appended to the `edit_scene` observation** (the Claude Code
  system-reminder trick). Deferred until 1–4 have been measured on the same project: if
  the built-in section and `medium` effort fix the failing thread, a per-call reminder is
  cache-hostile noise. If they do not, it is the next thing to try, and it is a one-line
  change to the `insertLines` observation.
- **Parsing generated prose into typed lines before `edit_scene`** (the issue's second
  recommendation). The agent already emits typed line objects; the failure is that it
  chose the wrong type for all thirteen, not that it emitted a blob. There is nothing to
  parse.
- **Making `newScene` accept `lines`.** It accepts `synopsis` instead (change 8), which is
  what a one-line summary is, and prose stays one op (`insertLines`) with one cost report.
- **Fixing the structured-backend routing.** Recorded above as an open question; it is a
  separate defect with its own investigation.

## Verification

- Re-run the failing request on `examples/dadsStory` three ways, each in a fresh thread
  with `scenes/abduction.md` reset to its empty scaffold and the request "write the
  abduction scene". Check the thread header records `backend: "native"`; if it records
  `structured`, stop and chase the open question first, because the run is not testing the
  prompt path the plan assumes.
    1. New default (`medium`, native).
    2. Bound to `low`, native — isolates the prompt change from the effort change.
    3. The failing condition itself: resume thread `20260917-164320` and ask again. The
       bad scene was written after ~100 transcript items with the rules 18,000 characters
       back; a fresh thread tests a different position in context, and this run tests the
       real one.
    - Pass, in each: dialogue lines with speakers; narration limited to beats no one
      speaks; no camera direction in any line; the agent puts visual description in the
      synopsis or on shots and says which.
- Through the `vnauthor` REPL: `newScene` + `lines` is refused with change 2's message;
  `newScene` + `synopsis` writes a `= …` line `parse_fountain` reads back; `setSynopsis`
  with a newline is refused.
- File an agent report on any thread with a long `insertLines` call and read the "Called
  with" block: the cut marker is present and states both lengths.
- `pnpm check && pnpm test && pnpm lint` green.

## Files

- `packages/authoring/src/context.ts` — changes 1, 3
- `packages/authoring/src/tests/context.test.ts` — changes 1, 3
- `packages/authoring/src/tools/scenes.ts` — changes 2, 8
- `packages/authoring/src/tests/tools/scenes.test.ts` — changes 2, 8
- `packages/scriptedit/src/lineops.ts` and `tests/lineops.test.ts` — change 8
- `packages/types/src/textmodels.ts` and `tests/textmodels.test.ts` — change 4
- `apps/desktop/src/main/session/core.ts`, `apps/desktop/renderer/pathux/app/state.ts`,
  `apps/authoring/src/repl.ts`, `apps/authoring/src/agent.ts`,
  `apps/desktop/src/shared/advice.ts` — change 4
- `apps/desktop/src/main/notify/threads.ts` and
  `apps/desktop/src/main/tests/threads.test.ts` — change 5
- `packages/agentreport/src/analyze.ts`, `report.ts`, and their tests — changes 5, 6
- `templates/basic/.aiagent/skills/full-production/SKILL.md` — change 7
- `docs/reference/vnauthor.md` — change 3 (precedence bullet), change 4 (line 43), change
  1 (a sentence under "How it works" that the prompt carries writing guidance), change 8
  (the tools list)
- `docs/plans/index.md` — this plan's row (already added)

## Pressure-test findings

A fresh-context reviewer read the first draft against the tree. Twenty findings; what each
changed:

1. `DEFAULT_EFFORT` is also the provider fallback for every pipeline text call. **Fixed:**
   change 4 now adds `DEFAULT_AGENT_EFFORT` and leaves `DEFAULT_EFFORT` alone.
2. Two tests assert `DEFAULT_EFFORT` is `low`; two comments and a doc line go stale.
   **Fixed:** listed in change 4; the tests keep passing under the two-constant design.
3. Renaming the header to `PROJECT RULES` breaks `context.test.ts:92`. **Fixed:** the
   header keeps the words `PROJECT CONTEXT`.
4. Change 1 named a shot-level `artNotes` that `write_storyboard` does not have, and
   described `set_art_notes` as reaching a rendered asset when it takes a rung. **Fixed**
   in "Why the rule did not work" and change 1.
5. `clamp` also caps the pane's text; a marker there is noise and breaks two tests.
   **Fixed:** the marker is applied in `clampDetail` only.
6. The reason given for keeping the section name was wrong (`refreshSystem` compares text
   too); the real reasons are the editor's styling, seven tests, and a doc line. Resumed
   threads pay a supersede for any prompt edit. **Fixed:** change 3 and the undo-cost
   lines of 1 and 3 say so.
7. The effort evidence was overstated — one low thread with the rules in place, not three
   — and confounded with the backend (structured vs native). **Fixed:** the confounds are
   stated, the backend anomaly is an open question, and verification controls for both.
8. The verification did not reproduce the failing position in context. **Fixed:** run 3
   resumes the thread.
9. Change 1 left undecided where description goes before a storyboard exists, and its
   "offer `propose_storyboard`" conflicted with the skill's rule not to storyboard for the
   author. **Fixed:** the synopsis (change 8) is the parking place; the offer is gone.
10. Covered lines already reach the picture as mood context, and scenes have a `synopsis`
    no tool can set. **Fixed:** both are in change 1; the synopsis became change 8.
11. The accepted-arguments table was left to the implementer; the schema is not strict; a
    redundant `scene` would be refused. **Fixed:** the table is in change 2, `.strict()`
    is added, `scene` is accepted everywhere.
12. The refusal does not prevent the call; the descriptions and the skill should say
    `newScene` takes no lines; `edit_branches` has the same gap. **Fixed:** all three in
    changes 2 and 7.
13. Change 6 ignored the direct path and the grant-supersede-by-name mechanism, and
    `report.ts`'s `where` invites a path. **Fixed:** all three in change 6.
14. The contract/default split left the safety rules on the overridable side. **Fixed:**
    the header lists them, and the contract blocks are labelled in the prompt.
15. A Fountain-form example would teach the wrong output shape. **Fixed:** the example is
    in `insertLines` form.
16. Two cited paths and one line number were wrong. **Fixed.**
17. `context.test.ts` asserts no order inside `SYSTEM_PROMPT`. **Fixed:** change 1 adds
    the assertions.
18. Locale-dependent number formatting; undo cost unstated for 5–7; other truncations
    exist. **Fixed:** plain digits, undo costs stated, the analyst paragraph scoped.
19. Change 7 cannot be exercised on `examples/dadsStory`. **Recorded** in change 7;
    reviewed by reading.
20. The index row was already added. **Fixed** in Files.

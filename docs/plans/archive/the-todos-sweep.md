# The todos sweep

<!-- toc -->

- [Scope](#scope)
  - [Out of scope, and why](#out-of-scope-and-why)
- [Work order](#work-order)
- [A. The header and the pipeline it starts](#a-the-header-and-the-pipeline-it-starts)
  - [A1. Busy is pushed, not polled](#a1-busy-is-pushed-not-polled)
  - [A2. Run Pipeline is one click, and Run Pipeline (adv) is the dialog](#a2-run-pipeline-is-one-click-and-run-pipeline-adv-is-the-dialog)
  - [A3. The stop button](#a3-the-stop-button)
  - [A4. Badges: the project name, the model, the title bar](#a4-badges-the-project-name-the-model-the-title-bar)
  - [A5. Recent projects](#a5-recent-projects)
- [B. Dialogs](#b-dialogs)
  - [B1. A border and a width cap](#b1-a-border-and-a-width-cap)
  - [B2. The model-key provider dropdown](#b2-the-model-key-provider-dropdown)
- [C. The document tree](#c-the-document-tree)
- [D. The script editor](#d-the-script-editor)
- [E. Assets](#e-assets)
- [F. The agent](#f-the-agent)
- [G. Tooltips everywhere, and the Close Pane picker](#g-tooltips-everywhere-and-the-close-pane-picker)
- [Verification](#verification)

<!-- tocstop -->

## Scope

`todos.md` at the repo root is the author's running list. This plan takes every unchecked
`[ ]:` entry on it as of the sweep, minus three the author ruled out (below). Each item is
finished the repo's way: the code, the docs it makes stale, and the entry's checkbox flipped
to `[x]:` **without** touching its wording, ordering or whitespace.

Line numbers below are `todos.md`'s, so an entry can be found by number while the list is
still in flight.

### Out of scope, and why

| Lines   | Entry                                                            | Why not                                                                                      |
| ------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 29      | "character model sheets should reference"                        | The sentence is truncated — there is no requirement to build. The author said skip it.        |
| 20–21   | portraits/locations rendered before any scene uses them          | Deferred: `packages/model/src/used.ts` and the P3 gate are being rewritten in `full-slot-graph`. |
| 57–58   | asset subtree keyed by slot instead of hash                      | Deferred: same worktree owns the slot graph and the doc tree's `branch:unapproved` subtree.    |

The `full-slot-graph` worktree also owns `packages/artgen/src/{gate,slotgraph,upstream,prereq}.ts`,
`AssetInfo.prereqs`/`unapproved`, `assetview.ts`'s `approveAction`, and
`packages/pipeline/src/decompose.ts`. This sweep touches none of them; where an item would have
(line 56, "a stale asset should not read as accepted"), it is done in the doc tree's own labelling
rather than in `AssetInfo`.

## Work order

Clusters, ordered so shared plumbing lands before the things that need it:

1. **A — header and pipeline** (lines 5, 14–18, 27–28, 32–36, 49, 53–55). Builds the busy
   push everything else keys off.
2. **B — dialogs** (lines 6–8).
3. **C — document tree** (lines 19, 37–39, 43, 50–51).
4. **D — script editor** (lines 24–26, 59).
5. **E — assets** (lines 1, 30–31, 56).
6. **F — agent** (lines 9–13, 41–42, 44–48, 52, 60).
7. **G — tooltips, and the Close Pane picker** (lines 2–4, 40).

Landed: **A**, **B**, **C**, **D**, **E**, **F** and **G**, in full. Nothing in scope is open.

## A. The header and the pipeline it starts

Nine entries land on `apps/desktop/renderer/pathux/editors/header.ts` and the pipeline commands
behind it. They share one missing seam, so that comes first.

### A1. Busy is pushed, not polled

`WorkspaceSession` already knows: `session.busy()` returns the first entry of `inFlight`, which
`session.while(what, run)` maintains — `'a pipeline run'`, `'an agent turn'`. Nothing tells the
renderer. `bridge.ts` subscribes to `command:ui`, `agent:event` and `notify:changed`, and none
of them carries it.

Add a `command:ui` effect `{ type: 'busy' }` carrying `{ what, pending }` — what is in flight (or
`undefined` when nothing is) and how many tasks remain. Main pushes it on entry to and exit from
`session.while`, and again as the scheduler drains a wave, so the count moves rather than sitting
at its opening value. `ShellState` grows `busyWhat: string | undefined` and `busyPending: number`;
the header's `stateKey()` includes both, so a change redraws exactly once.

This is what lines 14–18 (disabled run button, rotating icon, "how many tasks are left"), 36 (the
stop icon), 52 (the convo editor's stop button) and 54–55 (say why it cannot run) all read.

### A2. Run Pipeline is one click, and Run Pipeline (adv) is the dialog

Lines 32–35 and 14–18 together:

- `pipeline.run` loses `confirm: true` (line 34–35, the double confirmation: the app menu opens
  `openCommandDialog('pipeline.run')`, and the dialog's own OK then hits a second confirm).
  Its refusal is unchanged — `check` still reports the key error and the gate.
- The app menu gains **Run Pipeline** above it, which `exec`s straight away and reports; the
  existing entry is renamed **Run Pipeline (adv)…** and keeps the dialog.
- The header gains a run button beside the badges (line 32's "header button" in line 54's
  wording), same one-click path.
- The advanced dialog gets the count `check` already computes, shown as a note rather than left
  in a tooltip, and its OK disables while a run is in flight.

Line 54–55: both entry points go through one `runPipelineNow()` helper that `check`s first and
`say`s the refusal when it is not `ok` — the agent-is-running case is exactly `session.busy()`.

### A3. The stop button

Line 36. A red stop glyph appears in the header only while `busyWhat` is set, and `exec`s a new
`pipeline.stop`. The session grows a cancel token the scheduler polls between tasks: a run stops
at a task boundary, never mid-task, so nothing half-written is recorded. Line 52's convo-editor
stop is the same command family — `agent.stop` — shown on the same condition.

### A4. Badges: the project name, the model, the title bar

- Line 53: the project badge gets a rounded outline. `badge()` grows a variant rather than every
  caller styling itself.
- Lines 27–28: the model badge gets the tooltip the author wrote, verbatim.
- Line 49: `Menu.setApplicationMenu(null)` means there is no stock menu, so "the app's title bar"
  is the `BrowserWindow` title. `switchWorkspace` sets it to the project title; it is the one
  place the root changes.

### A5. Recent projects

Line 5, "The recent projects menu is empty, fix it." **The literal symptom does not reproduce on
this build.** Driven over CDP against a seeded store, `workspace.recent` returns its data, the
header's `recents`/`current` are populated, `recentMenu()` builds two entries, and opening it
renders both — plausibly already fixed by the path.ux submodule commit "menu: object-form template
entries, and a tooltip for a submenu row". Three real defects behind the report are fixed instead:

1. **Dead paths are still offered.** The author's own store holds ten entries, several of them
   deleted temp directories. `workspace.recent` runs in main and can stat, so it drops what is no
   longer there.
2. **The refetch guard is keyed on the title.** `refreshRecents` compares `ui.projectTitle`, so two
   projects sharing a title never refetch. Key it on the root.
3. **The current project is dropped entirely**, so a one-project install renders `(none)` — which
   reads exactly as "empty". Keep it, marked as the open one.

## B. Dialogs

### B1. A border and a width cap

Line 6–7. The command dialog is a raw DOM surface; it gets a distinct border off `tokens.css`
(no new hue — `--sodium` is the authored accent) and a `max-width` so a long description cannot
stretch it to the screen. Long text wraps; a long single token scrolls inside its own box.

### B2. The model-key provider dropdown

Line 8. `project.setKey`'s `provider` **is** already `prop.oneOf(KEY_VENDORS)`, and `CommandForm`
already draws an enum as a `row.menu`. What is missing is that it reads as one: a path.ux menu
button is drawn as a plain button, so the field looked like a label stating the value. It gets a
`▾`, a tick beside the chosen option, a tooltip of its own and one per option. The key itself
stays `prop.secret`, so it is still redacted at `digestProps` and still deliberately not undoable.

## C. The document tree

- **Line 19** — the disclosure arrows are 3× larger. `font-size: 27px` in a box still clamped to
  the row height, so the glyph overflows its own line box rather than making every row taller.
- **Lines 37–39** — double-clicking a location opens it in a wiki editor, creating the sheet when
  no `type: location` doc exists for it. Creation is a command, like every other write.
  A **mined** location is the case that needed anything: it has no `path`, so no editor claims it
  and `renameOf` declines it — the double-click gesture was free. `doc.create(kind:'location',
  name: node.label)` lands on exactly the mined id, because `parseHeading` and `newLocationDoc`
  both compute `slug(name)`.
- **Line 43** — the `New Scene` context entry does not work. **The entry, the command and the
  dialog were all fine**; what failed was every dialog *after the first Escape*. `Screen._popup`
  hands Escape, the click-outside watcher and `_ondestroy` a closure over its own `end`, so
  overriding the `end` property is never called and the module-level `let open` stays set — the
  same defect closed the palette to `/` for the rest of the session. Both now hook `remove`, the
  one path all of them finish at, through `onPopupClosed` in `pathux/popup.ts`.
- **Lines 50–51** — the tree does not refresh after the branches editor connects two scenes, nor
  after the agent creates one. Two different holes:
  - The branch editor invoked `command:exec` **directly** rather than going through the bridge's
    `exec`, so nothing fired `wrote`/`invalidate`. It now calls `exec`, like every other surface.
  - An agent tool call is not a command, and `agent:event` fed only `wrote`. It now invalidates
    too when the tool wrote anything, which is the feed the tree watches.
- **Line 56** — an asset whose `driftOf` is `drifted` must not be labelled `accepted`. Drift is
  re-derived on read, so this is a labelling fix in the tree, not a stored flag: `doctree.ts`
  collects the drifted shot images and badges those `stale`.

## D. The script editor

- **Lines 24–26** — a new line defaults to the narrator and renders invisibly against the
  background, so the author cannot tell there is a line, let alone how to set a speaker. Three
  separate mechanisms, all fixed in `rules/script.ts` + `styles/script.css`:
  - `.who.none` was `opacity: 0` until hover, so the speaker control was **literally invisible**.
    An unattributed line now names the **narrator** (`cueSlotText`), quietly (`--mist-dim`) and in
    `--sodium` on hover. The word is never a cue — no cast member is spelled that way.
  - The composer row drew an empty textarea with no cue and no placeholder, so a line being
    written looked like nothing at all. It gets both, and `composedCueText` states who the insert
    **will** attribute — it cannot offer to change it, `setSpeaker` needing a line that exists.
  - Narration text was `--mist` where every other line is `--paper`; the italic is what says
    narration. `timeline.css` matches, so the same line looks the same in both rooms.
- **Line 59** — right-clicking a line offers **Open shot asset**, resolving the shot that covers
  the line (`shotCovering`) and, through it, the asset. Where there is none, the entry is shown
  with its refusal rather than hidden — and the **two** ways of having no picture are different
  answers with different next moves, so both are said: "no shot covers it" and "its shot has not
  been drawn". Neither is a question a command can be asked, there being no hash to name, which is
  what the new `MenuEntry.refused` is for: a refusal the surface itself knows, drawn exactly like a
  checked one and never run. Deliberately not a licence to pre-judge `check` — a command that can
  answer is asked.

  The pane also grows the dismiss latch `documents.ts` already carries: path.ux closes a menu on
  mouse-up, so the click that dismisses it would otherwise open the line editor under the pointer.
  And `grab()` ignores a non-primary button, so a right-click on the gutter cannot start a drag
  that never sees a matching `pointerup`.

## E. Assets

- **Line 1** — the asset editor grows a seed field. A seed is part of what produced an image, so
  it belongs to the asset's authored fields beside `artNotes` and changes the prompt hash the same
  way — it deliberately re-renders.

  As built, the seed **rides the five rungs art notes already ride** rather than getting a
  mechanism of its own: `ArtRung` grows `seed`, `art.setSeed` writes it through the same
  `locateRung` refusals `art.setNotes` gives, and the box sits in each rung's heading beside that
  rung's notes. The chain is resolved in exactly one place — `seedFor` in `@vn/artgen`'s
  `prompts.ts`, called **inside** the four `*Inputs` builders, so the planner, `adoptSlot` and
  `promoteConcept` cannot disagree about a task hash without one of them having been rewritten.

  Two things it is not, both because the seed is a number and notes are a string:

  - **Zero is a seed.** Every "did the author write one?" test is `=== undefined`, never
    falsiness — `setOrClear` could not be reused, hence `setSeed` in the serializer. `null` is how
    an edit clears one, `-1` is the command prop's sentinel (there is no nullable-number prop), and
    an **empty box** is the whole vocabulary for "inherit" in the UI. The placeholder is the
    project-wide seed (`AssetInfo.configSeed`), so "inherits" says what it inherits.
  - **A seed is not art direction.** Notes say how a picture should look; a seed asks for a
    different one of the same words. That is why the box is narrow and in the heading rather than
    under the textarea, and why the tooltips say different things.

- **Lines 30–31** — `asset.regenerate` runs the pipeline itself when the asset it invalidated is
  the only plannable task, since one queued task is not worth a trip to the run dialog.

## F. The agent

- **Lines 9–10** — a running token total in the conversation editor, from usage the provider
  already returns.

  The number had nowhere to travel: the desktop app runs `StructuredAgentBackend`, whose only seam
  is `ChatBackend.message(req): Promise<string>` — a string with no room for a receipt. Widening it
  would have broken every fake in the repo, and a `lastUsage()` accessor or an `onUsage` side
  channel would have been plumbing that bypasses the event stream. Instead `ChatBackend` grows an
  **optional `messageWithUsage`**, and each real backend derives `message` from it — one request
  builder and one retry policy per backend, every existing call site untouched, and a backend that
  cannot say what it was billed is still a backend.

  From there the count rides the road everything else does: `AgentTurn.usage` → a new
  `AgentEvent` `{ type: 'usage' }` → the `Convo` reducer's `tokens` → a label in the composer's bar.
  Three things it is deliberate about:

  - **Retries are billed.** `StructuredAgentBackend` accumulates across its attempt loop and the
    total rides out on whichever turn is returned, including the one that gave up.
  - **A receipt is not a transcript line.** `received` adds no `FeedItem`, so `session.record`
    writes nothing to `vngen/state/threads/<id>.jsonl` and a reopened thread reads as it always did
    — and starts again at zero, which is honest: the number is about money being spent now.
  - **Nothing reported reads as `—`, never `0`.** A mock backend and a backend that stopped
    reporting are both zero, and a zero that never moves looks like a bug.

  The label is retitled in place from `rebuild()` rather than keyed into `stateKey()`: `rebuildBar`
  destroys the model and effort menus, so a step finishing would otherwise close a menu open over it.
  `vnauthor` gets the same total under each reply (`renderTokens`), the REPL accumulating it from the
  same event.
- **Lines 11–13** — the new-character template ships a full sheet with example values, and a note
  saying what a palette is and to ask the agent for one, instead of an empty palette block.

  The scaffold was `newCharacterDoc(name)` — `id` and `name` and nothing else — so every field the
  schema knows was learned by reading a doc page or by copying `templates/basic`. It now ships
  `status`, `default_outfit`, an `outfits` map, and `traits`, each filled with a placeholder shaped
  like the real thing rather than a plausible value: `everyday: what they wear in most scenes —
  silhouette, colour, one detail that is theirs`. A placeholder that reaches a prompt unedited draws
  something visibly wrong, which is the point — an invented look would be silently wrong instead.
  The body is the same, because the body **is** `character.description` and goes to the image model,
  so it says what to write there and that backstory belongs in a wiki note.

  `palette` is the field that cannot carry an example, because a colour *name* is a hard parse error
  (`hexColor`) — which is exactly why the todo asks for a note. A note means a YAML comment, and a
  comment cannot survive `newCharacterDoc`: `stringifyFrontMatter` re-serializes a plain object.
  So `newCharacterTemplate(name)` returns **text**, and `session.newDoc` and `create_character`
  write it directly. The comment dies at the first `applyCharacterEdit`, as read-once scaffolding
  should; by then the author has read it. The name is emitted through `JSON.stringify`, so
  `Kite: no. 3` survives being front-matter rather than splitting on its own colon.

  `create_character` keeps `newCharacterDoc` when it was **given** a description: a model that
  already knows the character should not be handed placeholders to argue with. Both create tools
  also gained the empty-slug refusal the desktop path already had — a name of pure punctuation was
  writing `locations/.md` with `id: ''`, reported as success and then invisible.
- **Lines 41–42** — done. `ask_choice` is a **control tool of its own**, not a `choices` argument
  bolted onto `ask_user`. The bug it fixes is that the model asks open questions when the sensible
  answers are enumerable, and a distinctly named tool — described as _"prefer this over `ask_user`
  whenever the sensible answers can be listed"_ — is a far stronger correction than an optional
  parameter the model never reaches for.

  But there is only **one door**. `Permission.ask(question, choices?)` gained a parameter rather
  than a sibling, because the answer is a string either way: the shortlist is how the question is
  _put_, not what comes back. So there is still one `AskRequest`, one card, one IPC channel, and a
  host that ignores `choices` degrades to a plain text box — worse, never broken.

  The floor is **two** (`z.array(z.string().min(1)).min(2)`). A shortlist of one is a leading
  question, and the author would have to reach for the text box to disagree with it.

  The card draws the todo's three affordances: the list (`drawChoices` — full-width rows, because
  an answer is read before it is clicked; multi-pick ticks into `askPicked`, which survives a
  redraw the same way `askDraft` does), the existing text field (placeholder now _"Or type an
  answer of your own…"_), and **Chat about this**, which _answers_ with a sentence saying so rather
  than dismissing — main is parked on `ask:answer`, and a card that closed without one would hang
  the turn. The observation is worded identically in every case (`User answered: …`), so the model
  has to actually read what the author said instead of pattern-matching a click.

  In the terminal all three collapse into one prompt. `pickedOr` turns `2` — or `1,3` for a
  multi-pick — into the options those numbers name, and anything that is not a run of valid indices
  is the author's own words, passed through untouched. That is what makes "type your own" and
  "let's talk about it" need no affordance of their own over a readline channel.
- **Lines 44–45** — **done.** A scene's location becomes editable, with the consequence stated
  before the edit runs and the agent named as the thing that can mitigate it.

  The location is not a field an editor can bind to. A `Scene` has **no `heading`** — the slugline
  is `location` + `locationVariant` + `headingPrefix`, reassembled by `headingOf` and read back by
  `parseHeading` — and the heading is not a `SceneLine`, so no existing `LineOp` could reach it.
  Hence `setHeading`, the fifth scene edit: it takes the slugline the author would type, parses it,
  and writes the three fields. No line id moves and no coverage changes, so it is the cheapest kind
  of scene edit to _describe_ — and the most expensive one to _run_.

  That inversion is the whole warning. Every other prose edit is affordable precisely because no
  line's text reaches a shot's task inputs, which is why `drifted` exists: art goes on illustrating
  replaced prose until somebody asks for more. A **location is in those inputs twice** — its name is
  baked into the prompt by `buildShotPrompt`, and its plate's hash leads the shot's `refs` — so
  moving a scene does not leave art to drift, it **re-renders** it, at cost. `ShotFallout` prices
  that as its own count, `restaged`, rather than folding it into `drifted`, because the two say
  opposite things about what happens next.

  The op also has to defuse a silent failure. `Shot.location` is a **variant** id, persisted in
  `work/shots/<sceneId>.json`, which wins forever once written — and the planner's
  `locationTask(model.locations.get(scene.location)!, shot.location, …)` simply `continue`s when the
  new location declares no such variant, so the shot is skipped **without a word, permanently**. So
  `LineOp` grows a `relocated: [sceneId, variant][]` channel and `shotFallout` restages every shot
  in a moved scene onto the new heading's variant, through the `writes` seam that already existed.
  Restaging is keyed by the scene a shot **lands in**, so a shot carried into a moved scene by the
  same edit is staged where it ends up.

  What it cannot do is rewrite the prose, which still describes the old place. Nothing here can, so
  the message says so and names the agent: _"The prose still describes the old place; ask the agent
  to rewrite the scene for CLASSROOM."_

  `story.setHeading` is deliberately **not** `confirm: true`. A confirm command is never checked,
  and the check **is** the warning: `CommandForm.recheck()` re-asks on every keystroke, so the
  sentence — and the shot count from the fallout note — is on screen as the author types the new
  heading, not after they commit to it. The affordance is the slugline itself, rendered as a button
  at the top of the script page, which is why `SceneCoverage` gained a `heading` field: the pane had
  only the raw `location` slug, and a control offering to edit the heading has to show the heading.

  The agent reaches the same act through the same op — `setHeading` joins `SCENE_OPS` in
  `edit_scene`, making eleven — so the desktop's `story.*` vocabulary and the agent transcript stay
  the one vocabulary that file's doc comment promises they are.
- **Line 46** — `list_workspace` appears not to see a location sheet created in the same turn.

  **Nothing caches.** `list_workspace` → `Workspace.index()` → `load()` → `loadInputs()` →
  `discoverEntities()` is a fresh `readdir`/`readFile` every call, `writeFileAtomic` has renamed
  before the tool returns, and the only memo in `Workspace` is the bible handle. The report the tool
  *renders* was the problem. Locations are mined from scene headings, and `mergeMinedLocations` keys
  on the same slug `parseHeading` derives — so authoring `locations/rooftop.md` for a place the
  screenplay already mentions **converts** a row rather than adding one. `formatIndex` printed
  `- rooftop "ROOFTOP" (mined)` before and `- rooftop "Rooftop"` after: same count, same id, one
  parenthetical gone. To a model re-reading its own transcript that is a tool that did nothing.

  So every row now names its file — `- rooftop "Rooftop" — locations/rooftop.md` — and a location
  with no sheet says `(mined from the screenplay — no sheet yet)` outright. Characters and scenes
  get the path too, because "which file is this in" was already in the JSON `data` and never in the
  text the model reads.

  The secondary contributor was the **project map frozen in the system prompt**. `ensureAgent()`
  composed it once and `clearAgent()` kept the Agent, so a stale, authoritative-looking location
  list sat above every tool result for the life of the session — and the agent's own
  `write_generated_context` could not dislodge it. `Agent.setSystem` (beside the existing
  `setBackend`) makes it swappable, and both hosts recompose per turn; the map's own header now says
  it is a snapshot and that `list_workspace` wins.

  Both create tools also gained the empty-slug refusal, which is how `locations/.md` with `id: ''`
  came to be written, reported as success, and then dropped by the schema — genuinely invisible.
- **Lines 47–48** — **done.** The agent creates a scene and does not link it into the graph.

  It was not confusion. **The agent had no tool that could wire anything.** `edit_scene`'s
  `newScene` ends with the sentence _"Created rooftop (rooftop/dusk); nothing points at it yet"_ —
  and that was a dead end: `write_file` refuses `scenes/`, `set_outfit` writes the one marker it
  owns, and nothing else in the 36-tool registry touched `[[next:]]` or `[[choice:]]`. The
  reproduction is two calls and now sits in `tools.test.ts`: create a scene, ask `story_graph`, read
  `Unreachable: rooftop`.

  The cause is a migration that only went halfway. `docs/plans/scene-edit-package.md` moved the
  scene rules out of `apps/desktop/src/shared/` into `@vn/scriptedit` precisely because a package
  may not import an app and the agent needed the same answers — but it moved `lineops.ts` and left
  `branchops.ts` behind. So the agent got the ten prose acts and none of the four wires. The fix is
  to finish the move: `branchops.ts` and its suite are now in `@vn/scriptedit`, exported from the
  pure entry (they already had to be browser-safe — the branch editor runs them mid-drag), and the
  desktop imports them from the package like everything else.

  On top of that sits **`edit_branches`**, the four rewires as one tool, over a new
  `Workspace.branchEdit(decide)` that mirrors `session.editBranches`: the decision and the patch see
  **one** load, because a rule that answers about a graph the writer is no longer editing is worse
  than no rule. A refusal arrives verbatim — splicing a forking scene into an edge is refused in
  `branchops`' own sentence about an edge that would never be taken — and a rewire that changes
  nothing writes nothing and says so.

  Linking is deliberately still a **second act** rather than a `goto` argument on `newScene`. Where
  a new scene belongs is a separate authorial decision, and `spliceScene` — put it _between_ two
  scenes — is the right answer often enough that folding one of the four in would make the other
  three look optional. What the tools do instead is say so: `edit_scene`'s description now ends
  _"newScene leaves the scene unreachable on purpose: follow it with edit_branches to link it in"_,
  and `edit_branches`' own description names the case it exists for.
- **Line 52** — the stop button, from A3.
- **Line 60** — **done.** The agent was told what the *project* holds and never what the author was
  _looking at_, so "rewrite this line" had no _this_ and the model guessed or asked.

  It rides as a **message, not a system line**. What was on screen was true at that turn and not at
  the others; folding it into the system prompt would retroactively rewrite the earlier ones, and
  the agent already recomposes its system message per turn (line 46), so the last selection would
  overwrite every previous one. Hence a fourth `AgentMessage.role`, `context`, filed ahead of the
  user's message — `renderTranscript` upper-cases the role, so it renders as `CONTEXT:` in both
  backends with no renderer change, and `Agent.run(input, focus?)` takes it as an argument rather
  than as state.

  It is **resolved in main, not trusted**. `focusOnScene(index, sceneId)` looks the id up in the
  live `WorkspaceIndex` and returns `undefined` when nothing answers to it, so a selection pointing
  at a scene deleted since contributes nothing rather than a confident sentence about a scene that
  is gone — a host with no selection and a host with a stale one look identical, which is the honest
  answer in both cases. The sentence it builds names the scene, its location, its cast and its file,
  and then says what to do with them: read it before answering anything about "this scene", "here"
  or "the current scene".

  It travels as a **command prop**, `agent.run(scene=…)`, defaulted to `''` so the palette and CDP
  — which have no selection — are unaffected. That puts what the author was looking at in the
  provenance record beside what they asked, which is the point: it is part of what they meant. The
  composer fills it from `shell().ui.sceneId`, the renderer's single selection. It emits no
  `FeedItem`, so nothing about it reaches the thread on disk — a transcript records what was said,
  and this is context for saying it.

## G. Tooltips everywhere, and the Close Pane picker

- **Line 40** — **done.** Every menu entry, including context menus — and, because CLAUDE.md's rule
  covers both mechanisms with one sentence, every other control the renderer draws. A path.ux widget
  takes `.description`; a raw DOM node in an `appendSurface` root takes `.title`.

  Three things the sweep turned up that are worth keeping:

  - **A row with a tooltip must also carry an id.** `createMenu` reads `item[5]` as the id for any
    array-form row longer than four slots, so `['Label', cb, hotkey, undefined, 'tip']` files its
    callback under `undefined` and the entry does nothing when clicked. The array form is
    `[label, cb, hotkey, ?, tooltip, id]`; the object form (`{ name, callback, tooltip, id }`) has
    no such trap, so new entries use it.
  - **A right-click row with no refusal to state falls back to the registry's own sentence.**
    `entriesWithVerdicts` takes an optional `says` map, fetched once from `command:catalog` and
    memoized in `showmenu.ts`, so an `undeclared` verdict and an unchecked `form: true` entry both
    say what the command does instead of nothing. A refusal still wins: it is the news.
  - **A shared button helper takes the sentence per call site**, not one generic line —
    `choiceButton`, `decideBtn`, `allowBtn` and `linkRow` all grew a `tip` parameter. The tooltip
    says what happens if you click *this* one, which is knowable only where it is built. The same
    reading retired every tooltip that restated its own label (`sendBtn.title = 'Send'`,
    `lid.title = line.id`, `row.title = text`).

  Verified live over CDP against `templates/basic`: a walk of all 87 shadow roots finds 35
  interactive elements, every one of which answers with a tooltip, and the app menu, the View menu,
  their four submenus and a tree right-click all render a sentence per row.

  **The pane tabs were the one gap, and they are now closed too** — asked for after the sweep, and
  larger than the line first reported. `AreaDocker.ts` did drop the third argument `tab()` accepts,
  but passing it would have changed nothing on screen: `addTab` writes `TabItem.tooltip` and
  **nothing in path.ux ever read it**, because the bar is painted on a canvas and a tab is not a
  DOM node with a `.title` to hover. So the fix has three parts, two of them in the submodule:

  - **A terminus.** `TabBar._doelement` now tracks which tab the pointer is actually over and hands
    it to `_updateTabToolTip`, which puts that tab's sentence on the bar itself — `description`
    (path.ux's own accessor, which sets `title` and feeds the non-native tooltip) and `canvas.title`,
    the canvas being what the pointer is really over inside the bar's shadow root. Off the tabs it
    clears. The bar carries one tooltip and swaps it, which is what a canvas-drawn tab strip can do.
  - **A field to carry the sentence.** `IAreaDef.description` — the tab's tooltip, whole. Absent, the
    docker falls back to `Show <uiname> in this pane`, which is at least not the label read back;
    the `+` tab's own "Add Editor" became "Add another editor to this pane" for the same reason, and
    it too had been invisible all along.
  - **The sentences, from the list that already had them.** `registerEditor` splices
    `description: editorTooltip(areaname)` into the class's `define()`, the same way it splices the
    struct name, rather than twelve hand-typed strings: `editorTooltip` is built from `EDITORS.what`,
    which the View ▸ Editors entry now also reads instead of formatting its own copy. Switching to an
    editor by tab and by menu is one act and had no business being described twice.

  Verified live over CDP after a rebuild: every tab in the running mesh answers with its editor's
  sentence, the tooltip follows the pointer from tab to tab and clears past the last one, and a
  synthetic click still switches the pane.
- **Lines 2–4** — **done.** Close Pane… is now a gesture: the pane under the cursor is outlined and
  crossed out, a click collapses it, Escape or any button but the left one cancels.
  `renderer/pathux/closepane.ts`, reached from the View menu the same way Split Area reaches
  path.ux's `splitTool` — a shell act, not a command, because a modal pick cannot be driven by an id
  and a props object.

  **path.ux does have a close tool, and it is deliberately not the one used.**
  `screen.removeAreaTool()` (`FrameManager_ops.ts`'s `RemoveAreaTool`) collapses whatever
  `findScreenArea` answers, which in this app includes the header and the last remaining pane. Those
  two rules already exist as `paneToClose`, so the pick had to be made against them; what the picker
  needed was the *per-pane* half of the same question, which is the new pure `paneClosable(panes,
  index)` in `panes.ts`. Writing the picker in the app also keeps its look in the app's tokens, which
  a submodule change could not have.

  Three things fell out that are worth keeping:

  - **A refused pane is still outlined.** Mist rather than vermilion, no X, and the rule written
    across it — _The menu bar is not a pane_, _The last pane is kept_. A picker that simply ignores
    the pointer over the header is indistinguishable from a broken one, and this is the same reading
    as CLAUDE.md's "a disabled control's tooltip is its refusal": a modal has nothing to hover, so
    the refusal is drawn where the tooltip would have been.
  - **The verdict shown is the verdict taken.** `finish` collapses the index the last `pointermove`
    approved rather than re-deciding on the click — the mid-gesture rule again, from the other side.
  - **`view.close` is untouched.** It still collapses the *active* pane, which is the only pane the
    palette, the agent and CDP can mean. The menu and the command deliberately differ, exactly as
    Split Area (a gesture) and `view.open`'s `left`/`right` (a command) already do.

  Verified live over CDP against `templates/basic`: hovering the script and documents panes gives a
  `rgb(229, 83, 75)` outline, a red wash, _Click to close this pane_ and a visible X; hovering the
  header gives `rgb(90, 98, 113)`, no X and _The menu bar is not a pane_; a click closes the pointed
  -at pane (`documents, convo, script, header` → `documents, script, header`); with one real pane
  left it reads _The last pane is kept_ and a click on it changes nothing; Escape removes the
  overlay. `view.close()` over CDP still closes the active pane.

## Verification

`pnpm check` (both passes), `pnpm test` and `pnpm lint` green before and after. The jest desktop
project is node-only, so pure logic moves into `.ts` with a `tests/` sibling and every surface is
driven live over CDP with `node scripts/vn-cdp.mjs`. Screenshots are not available in this session
— the window reports `document.visibilityState === 'hidden'` and `Page.captureScreenshot` never
returns a frame — so surfaces are checked by reading back computed styles and rendered text.

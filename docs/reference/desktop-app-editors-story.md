# The desktop app: story editors

<!-- toc -->

- [Branches](#branches)
- [Script](#script)
- [Convo](#convo)
- [Shot Coverage](#shot-coverage)

<!-- tocstop -->

This is part of [`desktop-app.md`](desktop-app.md). It describes the editors an author
writes the story through: Branches (the story graph), Script (one scene's lines), Convo
(the vnauthor conversation), and Shot Coverage (a scene's storyboard).

## Branches

`editors/branch.ts` renders the story graph as index cards on the canvas above
([`desktop-app-shell.md#the-shared-graph-canvas`](desktop-app-shell.md#the-shared-graph-canvas)).
It imports `rooms/studio/branch/{graph,grab,compose,tween}.ts` unchanged. The gesture
state machine that lived inside `BranchEditor.tsx` and was never tested now sits in
`pathux/branch.ts`, with sixteen tests over the three drags.

- **No manual node positions, so every drag is "semantic" (it edits the story, not the
  layout).** `Scene` has no `x`/`y` and layout is automatic: dragging a card's handle to
  another card wires it (`story.setChoice`/`setNext`), dropping a card on a wire splices
  it in (`story.spliceScene`), pulling a wire's arrowhead off its target unwires it. Each
  drag commits one command on release.
- **Each gesture is judged once, at the grab.** `grabCard`/`grabHandle`/`grabArrow`
  capture every candidate's verdict from the same
  `branchConnect`/`branchSplice`/`branchUnwire` an agent would call
  (`src/shared/interactions.ts` over `branchops.ts`), and `aim` is the only entry a
  pointer move needs, including the promotion from press to splice past `SLOP`, which
  re-aims in the same move so a big jump lands on the wire it ended over. The refusal
  shown mid-drag is the refusal that would occur.
- **`grab.ts` resolves the handle and the arrowhead before `pick` does.** Both discs
  straddle a card boundary, where `pick` returns either "background" or "that card".
  Testing the discs first gives each disc a hit area the size it is drawn.
- **Relayout is animated (`tween.ts`)** because a splice re-ranks the graph. The card does
  not stay where it was dropped, and without the transition the jump looks like breakage.
- **The edge label opens on `pointerdown`, not `click`.** Raw DOM has no reconciliation,
  so a redraw between mousedown and mouseup destroys the button and the click never lands.
  The open `<input>` is held across redraws and re-`focus()`ed after each draw, because
  the relayout tween runs `setContent` per frame. The `blur` that re-parenting raises is
  ignored, since acting on it would commit the field on the next frame.
- **Scene creation and deletion** (`compose.ts`): this module creates a scene from nothing
  and removes a scene. A new scene is deliberately created unwired, and you wire it here.
  Creation has a second home in the script editor ("a scene after this one"), which wires
  the new scene as well. Deletion has only this one home, because offering it from inside
  the prose of the scene being deleted risks losing work. Both are checked against
  `stack.check` on hover, so the refusal
  (`arrival is the entry scene — point start: in project.yaml elsewhere first.`) appears
  before the click.
- **The shell owns the selected scene.** Clicking a card here sets `ui.sceneId`, so the
  script and coverage panes follow, and it seeds the conversation composer with
  `Revise scene <id> — ` even when the selection did not move. Clicking the card that is
  already open asks about that scene again.
- **Right-clicking a card offers its script** (`cardMenu` in `pathux/branch.ts`). The
  document tree has no need of this entry, because a click there already opens the scene
  while a click here only selects the card. The scene is selected before the menu opens:
  `view.open` carries one subject string and Script has no entry in `SUBJECT_OF`, so it
  opens on the shared selection. `where` is `elsewhere`, which focuses an open Script pane
  rather than opening a second one, and the Script pane never covers the canvas. A stub (a
  `[[goto:]]` with no scene behind it) offers `story.newScene` prefilled with its id as a
  form instead, since a menu row cannot supply a heading. The listener is on the canvas
  rather than on a card, because the node layer takes no pointer events, and `onPick`
  swallows a pointer-down taken while a menu is open; otherwise the click that dismisses
  the menu would grab the card underneath it.

## Script

`editors/script.ts` draws one scene's lines down the pane as typed rows: the heading, the
lines with their numbers and cues, and the composer at the end.
`rooms/studio/script/script.ts` (`scriptRows`, `keyAct`, `stepsOf`, `checkOf`,
`splitBoundaries`, `mergeTarget`, `dropTarget`, `nextEditing`) is imported unchanged, and
the drag machine from `ScriptEditor.tsx` now lives in `pathux/script.ts` with six tests.
Plan:
[`../plans/archive/INDEX.md#script-composition-in-studio`](../plans/archive/INDEX.md#script-composition-in-studio).

- **The model is a list of lines, not a buffer.** Nothing diffs a document on save. A
  keystroke either belongs to the open row's textarea or names one command, and
  `script.ts` is the pure function that decides between the two. Enter commits the row,
  and from the end of a line it also opens a composer below, so a paragraph becomes one
  `setLineText` plus one `insertLine` per line, each of them its own undo point. Backspace
  at the start of an emptied line maps to `story.deleteLine`. Escape discards.
- **The gutter shows the row number and the tooltip shows the line id.** `scriptRows`
  carries an `at` (the row's 1-based place among the scene's lines, counting past an open
  composer without renumbering around it). The gutter draws that number, so it is readable
  at rest rather than only on hover. A line id is allocated once and persisted, so `L12`
  stops matching the count as soon as a line is inserted above it. A refusal names the id,
  which is why the gutter's tooltip still gives it.
- **A composer row is not a line yet.** `story.insertLine` refuses empty text (an empty
  line has no lossless Fountain form), so Enter cannot create a line and let the author
  type into it. Committing the composer performs the insert, and the new id is found by
  position in the reloaded scene (`insertedAfter`) rather than read back out of a message.
- **Attribution names a cue rather than an id.** The cue picker writes `AIKO`, because a
  prose edit is decided against the scene as its file parses, and speakers are still cues
  at that point; writing the resolved id back would rewrite `AIKO` as `@aiko`. The picker
  offers the project's cast, because attributing a line adds a character to the scene. It
  offers an unresolved cue verbatim, so that picking cannot silently discard a cue typed
  by hand.
- **Split, merge and new-scene are confirmed, not committed on click.** Each one moves
  lines across a scene boundary or creates a file, and only the command states the cost.
  So the strip holds the invocation, shows the sentence from `stack.check`, and commits on
  a second gesture. That sentence gives the detachment count a split would cause, or the
  refusal a merge would give. The editable fields in the strip are the invocation's props.
  Creating a new scene runs two commands (`newScene` then `setNext`), because undoing the
  wire should not also delete the prose.
- **The slugline heading opens the heading dialog.** The heading at the top of the page is
  a button that opens `openCommandDialog('story.setHeading', …)`, prefilled with the
  heading the file holds. `SceneCoverage` carries a `heading` because the pane had only
  the raw `location` slug, and a control offering to edit a heading has to show one. The
  command opens a dialog rather than the strip's confirm because the cost depends on what
  is typed. `CommandForm` rechecks on every keystroke, so the sentence naming the shots
  that will be re-rendered stays on screen as the author types, along with the reminder
  that the prose still describes the old place and that the agent rewrites it. Those shots
  are re-rendered rather than drifted, because a location is in a shot's task inputs.
- **Each affordance comes from the rule it enforces, not from an approximation of that
  rule.** A split is offered at every line but the first, since `splitScene` refuses a
  split that would empty the head. Merge is offered only where the scene's single `next`
  is the boundary at the bottom of the pane. "Continue to a new scene" is offered only
  from a leaf, because the branch editor's splice is what puts a scene between two others.
  A line drag is judged once at the grab against `scriptMoveLine.targets`, keyed by
  insertion point (`TOP` or the line to land after). An insertion point that `targets`
  never judged is a drop that would reorder nothing, so it draws no rule, gives no
  sentence, and commits nothing.
- The redraw key deliberately excludes the draft and the pending act's props. path.ux
  calls `update()` every frame, so keying the redraw on the text being typed would rebuild
  the field once per frame and lose the caret. The open textarea and the split/merge
  strip's inputs are persistent nodes that mutate in place and only re-run `stack.check`.
- **Opening a row does not clear the notice.** The continuation an act opens carries on
  from that act, so what the command said about that act is still the last thing that
  happened. A row the author opens is a new act, and opening that row clears the notice.
- **The shell owns the scene, not the editor.** A change to `ui.sceneId` from any source
  reloads the scene rather than redrawing it. A write that touched the scene's file
  reloads it too, wherever that write came from (`bridge.onWrote` plus `touchesScene`).
  Neither reload runs while a row is open, a structural act is pending, or a line is held,
  because re-reading would discard the draft. `⟳` in the bar triggers the deliberate
  reload instead.
- **Frames below the page.** The frames drawn from the scene render below it through the
  same `renderAssetStrip` that Wiki and Documents use, over `backlinks['scene:<id>']`,
  grouped by the shot each frame illustrates rather than by kind, so an author writing a
  line can see what the block it sits in already looks like. They sit below the page
  rather than inside it, because art that scrolled away with the prose would be gone at
  the point where a long scene makes it most useful. The strip follows `onInvalidate`, as
  the frames' own signal in Wiki does, since rendering a shot is not a write to the scene
  file. The strip reports when a scene has no art, which is the ordinary state of a scene
  being written.

## Convo

`editors/convo.ts` is the vnauthor pane, made up of the transcript, the three permission
cards, the dialogue box and the composer. The conversation itself is a value in
`src/shared/convo.ts`, reduced from the same `AgentEvent` stream that `useAgent` reduced
untestably inside a `useEffect`, with tests over what each event does to it. That value
sits in `shared/` rather than the renderer because main reduces the same events to write
the transcript — see the threads bullet below.

- The live conversation lives in a module subscribed at boot (`pathux/agent.ts`, installed
  by `shell.start()`) rather than in editor state. The agent streams whether or not a
  convo pane is open, and a pane opened afterwards has to show what was already said
  (including a second convo pane onto the same transcript).
- **Every turn runs as a command.** `ask` runs `agent.run` through the bridge rather than
  a bespoke channel, so a turn the author types and a turn the palette runs are the same
  act with the same record. `plan:decision` stays a channel deliberately, because it
  replies to a request main is already blocked on rather than starting an act of its own.
- **The selection is recorded with the question.** The composer fills `agent.run`'s
  `scene` prop from `shell().ui.sceneId`, so the selected scene lands in the provenance
  record beside the question. Main resolves that prop against the live index rather than
  trusting it (`focusOnScene`), so a selection pointing at a scene that has since been
  deleted contributes nothing instead of a sentence about a scene that is gone. The prop
  defaults to `''` because the palette and CDP have no selection. The selection reaches
  the agent as a `context` message rather than as part of the system prompt, and emits no
  `FeedItem`, because a thread records what was said and not the context for saying it.
- **A line that starts with `/` names a skill.** The composer opens a menu of the
  project's playbooks as soon as the first character is a slash, and filters it as the
  name is typed: ↑/↓ move, Enter or Tab completes, Escape closes it until the token is
  left, and a click completes while the box keeps focus. The menu opens only at the start
  of the line, because a `/` elsewhere is punctuation and a menu that opened over "and/or"
  would interrupt the author on every second sentence. On send the token is expanded
  rather than passed through (`renderer/rules/slash.ts`, "pure" (no side effects) and
  unit-tested): `/continuity-pass scene 3` reaches the agent and the transcript as
  `Follow the “Continuity pass” skill (.aiagent/skills/continuity-pass/SKILL.md). scene 3`.
  A token that names no skill is sent as typed. The list comes from `workspace:skills`,
  which is its own channel because a completion runs on a keystroke while
  `workspace:doctree` reads every storyboard and the manifest to answer. The list is
  re-read on `onInvalidate`, since `create_skill` is a turn in this pane. The debug
  agent's composer supplies no list and so has no menu, because it talks to an agent with
  no project.
- **The agent's permission gate has three kinds of request, and the pane renders all
  three.** Beside the plan card sit a question card and a confirm card. The question card
  serves `ask_user`: it shows the question and a one-line box that takes focus on arrival,
  and Enter submits the answer. An empty answer is allowed, because "nothing to add" is a
  real answer. The confirm card covers the always-confirm tools (`generate_image`,
  `edit_image`, `git_revert`, `git_restore`, and a script-bearing skill's first run), and
  lists `Deny` first and unaccented. Both cards use the plan card's request/reply shape —
  `permission:ask` / `ask:answer`, `permission:confirm` / `confirm:decision` — over a
  promise main is parked on. Two scaffolds used to answer on the author's behalf: `ask`
  resolved to `''`, so the model was told `User answered:` and proceeded on a guess, and
  `confirmAction` resolved to `true`, so every billed image call was auto-allowed. The
  confirm card shows an English sentence built in main by `toolconfirm.ts`, never the raw
  arguments. When the window
- **The agent may approve art, and a separate model decides what it may approve by reading
  the author's own turns.** `approve_assets` is wired through `ToolContext.approval`, an
  extension point this app owns. That extension point covers `session.approvable()`, the
  same upstream-first walk that the tree's "Awaiting approval" group projects;
  `session.approveOne()`, which routes a portrait to `gate.approve` and everything else to
  `asset.accept`; and a second, small model (`TRIAGE_MODEL`, resolved by
  `session.triageBackend()` on the project's own key, `null` under `--mock`). That model
  is shown the author's own recent turns and the list (never a word the agent wrote), and
  it answers which pictures the request covered; code then narrows that answer to hashes
  the list actually held. The author sees the resulting list on an ord
- **A shortlist changes how a question is drawn, not which path it takes.** `ask_choice`
  reaches the same `permission:ask` / `ask:answer` pair and passes `choices` (and `multi`)
  alongside the question, so the card gains a column of full-width answer rows above the
  text field it already had, and the reader reads an answer before clicking it. The reply
  is a string in every case, so a host that ignores `choices` asks the question as plain
  text, which is degraded but still works. The card offers three ways out: the answer
  list, the text box ("Or type an answer of your own…"), and Chat about this. Chat about
  this sends an answer that is a sentence saying so rather than dismissing the card,
  because main is parked on `ask:answer` and a card that closed without an answer would
  hang the turn.
- **The card is a form the author pages through, and one question is a one-page form.**
  `AskRequest` carries `questions[]` and `ask:answer` carries `answers[]`, so a form is
  one parked turn and one line of the transcript each way — the questions together, then
  the answers numbered under them. Everything the author has filled in lives in an
  `AskForm` (`renderer/rules/askform.ts`, pure and unit-tested): the page they are on,
  what is ticked per page, what is typed per page. **The form belongs to the question, not
  to a pane.** It is module state in `renderer/pathux/agent/agent.ts` (`askFormFor`,
  `askFormNow`, `setAskForm`), started when the request arrives and cleared when the
  answers go back, so two convo panes fill in one form and a pane re-created by a layout
  change keeps what was answered before it. A pane holding its own copy sends the picks
  that pane happened to see, and the other pane's picks are lost. **Every handler must
  read the live form, not the one it was drawn with**: typing deliberately does not redraw
  (that would take the caret away mid-word), so a Back/Next closed over the drawn form
  silently discards the words just typed. Found exactly that way, driving the card over
  CDP.
- **‹ Back / Next › sit on the left, away from the one button that ends the form.** A
  mis-aimed click near Submit must not submit half a form. For the same reason, a pick on
  the last page records the answer without sending, and **Submit answers** is the only
  control that ends a form. A pick on an earlier page turns the page, and a lone
  single-pick question answers outright, because there is nothing else to say. An empty
  answer is deliberate, so it never greys the button out. The Submit tooltip names the
  questions that will go back empty and what the agent will read them as, and it is
  recomputed on every keystroke, because a stale count misreports what the author just
  typed. **Chat about this** fills in only the questions still blank, since an author can
  mean to leave some questions of a form blank and answer the rest.
- **Ticking a choice does not rebuild the card.** Ticking a choice on a multi-pick updates
  the rows and the Submit tooltip in place. Rebuilding the card would remove the row under
  the pointer between one click and the next and scroll the list, because `rebuild`
  empties the transcript and scrolls it to the bottom, and a click whose row is gone is
  never delivered. A dropped click is one of the ways a picked answer reached the agent as
  `(no answer)`. An outright pick sends the choice together with whatever was typed beside
  the list, because a choice qualified in the box is one answer and sending the choice
  alone drops the typed half.
- **Clearing is driven by the command, not by the button.** The store subscribes to the
  registry through `bridge.onExec`, so `agent.newThread` empties the transcript
  identically whether the pane's **New** button ran it or the palette did. `agent.clear`
  behaves the same way and has no button, so it is reached from the palette, and
  `agent.openThread` behaves the same way as well. One path is not covered.
  `window.vn`/CDP goes straight to main, and neither `window.vn` nor CDP emits an event,
  so a clear run that way leaves an open pane's transcript standing.
- **Each conversation is stored as a thread, and is written down twice as it happens.**
  Main appends one JSONL line per feed item to `vngen/state/threads/<id>.jsonl`, and
  writes the file lazily, so an app opened and closed without a word writes no file. The
  title comes from the first thing the author said. A second file, `<id>.native.jsonl`,
  holds the model's own messages in the shape the backend sent them; a resume reads that
  file, and nothing on screen does. The bar's **Threads** button opens path.ux's
  searchable menu (`startMenu(…, true)`) over `agent.threads`, listing threads newest
  first with a bullet on the open one, then a separator, then **New conversation**.
  Reopening a thread is read-only: the pane replays the stored feed, and the dialogue box
  says the agent has not been shown it. Undo cannot take a transcript back, because its
  snapshots exclude `vngen/state`, which is why transcripts are stored there.
- **A reopened conversation is continued from its own history.** Continue
  (`agent.resumeThread`) is drawn beside Threads only while a saved conversation is on
  screen. It hands the agent the native log's messages and binds the session to that
  thread, and the next turn appends to the same two files. Continuing uses the model bound
  now rather than the one the conversation was recorded with, because the check has
  already refused a binding the stored messages could not survive. A thread written before
  this shipped kept only its transcript. A log merged from two clones is no longer intact.
  A log from a newer version of the app is not read. A vendor or protocol the bound model
  does not speak would send blocks it cannot read. Each refusal greys the button and gives
  its own sentence, ending with "Open it for reading instead." Where Continue is refused,
  the next thing typed starts a fresh thread. The two surface openers below likewise start
  a fresh thread when a conversation is already on screen.
- **A long conversation is compacted rather than truncated.** The compact command
  (`agent.compact`) summarizes everything said so far on the model the conversation is
  bound to and hands the agent the summary in place of the messages. The summary is added
  as one more line in each log rather than rewriting anything, so the transcript on screen
  is untouched and the pane draws a labelled rule where the summary begins. The button's
  title reports the size once a turn has reported one, and says that a large conversation
  is worth compacting. The button is greyed with a sentence while a turn is running, while
  a conversation is open for reading, and when nothing has been said since the last
  compaction. The summary's preface tells the agent that nothing it read still counts as
  read, and names the two tools that reach what the summary left out. `search_history`
  finds a phrase in the turns the summary replaced, and `read_history` returns one of them
  in full.
- **Every turn a decision depends on is recorded.** Main records both sides of every
  permission door at its own `permission()` seam: the plan with its steps and files, the
  verdict as the author's turn with whatever feedback came with it, and a question with
  the shortlist it offered. The loop files arguments the schema refused as a `blocked`
  event carrying what was passed. Main records all of these through the shared `convo.ts`
  reducers, so the file and the screen cannot drift apart — the renderer's own
  `permission:plan`/`permission:ask` handlers put the same items in the pane. A bare
  `decided(convo)` clears the card and writes nothing, because the renderer clears it
  knowing only `approved` while main knows the real decision. `report.agent` depends on
  this: the diagnostic reads the thread, and a conversation that went wrong went wrong at
  exactly these turns.
- **The composer is built once and never rebuilt.** The author types into it and a seed
  lands in it, so it survives every redraw of the transcript above it. It stops its own
  keydown events.
- **An upload opens this pane with a question.** **Upload Files…** in the app menu runs
  `upload.pick`; once the bytes are written it puts the session in plan mode, closes the
  open thread and opens this pane with the command's own sentence in the dialogue box —
  _"Archived 3 files to `archive/…`. What should I do with them?"_ — and the openers
  beneath it as chips. A chip fills the composer and does not send. Filling rather than
  sending teaches the shape of a useful prompt and leaves the author the moment they need
  to edit it into what they meant. Nothing here is a feed item, so no thread file is
  written until the author says something, and `asked` drops the chips as soon as they do.
  A cancelled dialog leaves the conversation in progress alone, and so does a batch where
  every file was refused, because the renderer keys on the `seed` that the command emits
  only when something was written. See
  [`../plans/archive/INDEX.md#upload-and-archive`](../plans/archive/INDEX.md#upload-and-archive)
  and [`vnauthor.md`](vnauthor.md#the-archive).
- **Two surfaces open a conversation about what is on screen.** Right-clicking a script
  line offers **Edit with agent** (`agent.editLine`), and the failure band in the Asset
  editor carries **Fix with agent** (`agent.fixAsset`). Each opens this pane `elsewhere`,
  flashed, and returns its opener as `data.seed`, so running one from the palette does
  what the click does. The opener lands in the composer rather than the dialogue box,
  because it is the author's sentence rather than the agent's. A line's opener names the
  scene, the line's number in it, its id and its words. A failure's opener names the
  picture, reports what the pipeline said, and asks what in the prompt or the art notes
  caused it. `src/shared/agentseed.ts` builds both sentences, and that module is pure and
  tested. A conversation already on screen is closed through `agent.newThread` first, so
  its transcript is filed exactly as it is when a thread is started from the menu. An
  empty conversation is reused instead, since closing it would file a conversation nobody
  had. The renderer makes that decision: `openThreadForReading` clears main's own copy, so
  main's conversation is empty precisely when the author is looking at a full one. Neither
  command sends a turn, writes anything, or redraws a picture. Both declare a `check`, so
  a turn already running, a line the scene no longer holds, and a picture that never
  failed each grey the control and say why.
- **A pane the author did not click flashes once.** `UiEffect`'s `view` carries `flash`,
  and `applyView` outlines the pane it landed in for 600ms after the mesh has settled. The
  flash is an overlay positioned over the pane's rectangle rather than a class on the
  `ScreenArea`, because pane children paint over their own element's border and the sheet
  that would style it lives in a shadow root this code does not own. A pane that was
  already open and already focused still flashes. The flag exists for that case, because
  nothing else about the pane would move.
- **The pane is not nested.** In the room shell the branch and script editors were
  rendered inside `Convo`, which is why only one of them could be open. Here the
  conversation is a pane like any other, and the author decides whether it shares the
  window with the page it is about.
- **`busy` is shell-wide, not agent-only**: a pipeline run disables the composer too.
  While it is set the dialogue box says `working`. The stage builds that one word once and
  pulses it through `@keyframes`. There is no verb list and no timer, so a turn that says
  nothing for thirty seconds is otherwise indistinguishable from one that never started.
- **The bar carries the three session facts the turn depends on.** The header has the same
  PLAN ⇄ EXECUTE toggle, but a turn is typed into this pane, so this pane has to say
  whether typing edits files. Beside the toggle are the model menu (`agent.setModel`) and
  the effort menu (`agent.setEffort`), both from the one table in `@vn/types`
  (`TEXT_MODELS`, `effortChoicesFor`, `resolveEffort` and `supportsEffort`), which the
  `vnauthor` REPL's `/model` and `/effort` read too. The effort menu offers only the
  levels the model accepts, and it has no `default` item. It lists that model's own ladder
  plus `no thinking` where an explicit `thinking: disabled` is accepted, and it starts at
  `low`; see
  [`../plans/archive/INDEX.md#deliberate-reasoning-effort-defaults`](../plans/archive/INDEX.md#deliberate-reasoning-effort-defaults)
  for why the absent knob was the wrong default. If a model has no reasoning knob at all,
  the menu is greyed out and gives the reason. The setting is kept rather than cleared, so
  switching back to a model that honours it needs no second gesture. A level the new model
  does not offer is stepped down by the same "pure" (side-effect-free) `resolveEffort`, in
  main and in the mirrored shell state alike.
- **The bar also shows what the conversation has cost.** It reports the tokens the
  provider billed as `842` / `12.3k` / `1.4M` at a glance, with the exact figures in the
  tooltip. It counts calls rather than turns, so a step the backend had to retry is paid
  for on every attempt. It reads `—` rather than `0` until a provider reports something,
  because a mock backend and a backend that reports no usage are indistinguishable at
  zero. The receipt is delivered as an `AgentEvent` (`{ type: 'usage' }`), like everything
  else the agent does. It comes from an optional `ChatBackend.messageWithUsage`, which
  each real backend derives its `message` from; a backend that keeps no receipt shows no
  total. It adds no `FeedItem`, so nothing about it reaches the thread on disk and a
  reopened conversation starts at zero. The label is retitled in place rather than keyed
  into `stateKey()`, because rebuilding the bar would close the model or effort menu
  mid-turn.
- The composer shows its stop button only while a turn is in flight. The button is
  `--vermilion` and takes the shape of the Send button beside it, and it `exec`s
  `agent.stop` through the registry, so interrupting from the composer and interrupting
  from the palette are the same act and leave one record. An idle composer has nothing to
  interrupt, so the button is hidden rather than left as a permanently greyed square that
  a reader would take to mean a turn is in flight.
- **The dialogue box is bounded and the transcript grows.** `.convo` is
  `grid-template-rows: 1fr auto`, so an unbounded line fills the pane and the transcript
  takes whatever space is left. A long narration turn once cut the transcript to a couple
  of hundred pixels and put the plan card off screen. `.dbox .line` is capped in `em` (so
  it tracks the prose size) and scrolls itself.

## Shot Coverage

`editors/timeline.ts` draws a scene's screenplay down the pane, brackets the shots
covering that screenplay beside it, and places the wardrobe below. The timeline runs
vertically because screenplays are written vertically. The pure (side-effect-free) rules
live in `renderer/rules/timeline/` (`drift`, `editing`, `wardrobe`, `cast`, `busy`) and in
`@vn/scriptedit`, where `coverage.ts` and `shotcreate.ts` handle geometry and shot
creation and are shared with the agent's tools. The state machine that the React component
kept in its own `.tsx` now lives in `pathux/timeline.ts`, with its tests beside it. Plans:
[`../plans/archive/INDEX.md#shot-timeline-editor`](../plans/archive/INDEX.md#shot-timeline-editor)
and
[`../plans/archive/INDEX.md#line-editing-in-floor`](../plans/archive/INDEX.md#line-editing-in-floor).

This is the only surface that edits `Shot.coversLines` directly (the `story.*` scene
editors also move it, as fallout of a split or merge rather than as the point), and
`buildShotPrompt` ignores it, so every edit here is free: nothing rehashes and no art is
invalidated. Edits to the prose on this surface are free in the same way, and for prose
that is a problem rather than a feature, which is why the drift marking below exists.

- **One rule, previewed and committed.** `@vn/scriptedit`'s `coverage.ts` holds the whole
  gesture's logic: `setCoverage` (the rule), `spansFor` (the geometry) and `resolveDrag`
  (which lines a drop targets). The `story.setCoverage` command runs it in main, and the
  strip runs it mid-drag, so a refusal shown while a handle is dragged matches the refusal
  the command would give. It lives in the package rather than in `src/shared/` because two
  hosts (this app and the authoring agent) enumerate targets and settle drags with the
  same geometry. Only `previewOf` stays in the renderer: it computes the "ghost" (preview)
  geometry for drawing, and main has no use for it. Each drop issues one command.
- **The gesture is declared, not just implemented.** `timeline.cover` (in
  `src/shared/interactions.ts`) carries `<shotId>#start` / `<shotId>#end` and returns a
  verdict for every row of the scene, so an agent can ask what a drag would do without
  performing one. The editor evaluates `targets` once per grab (state and carried are both
  fixed for the gesture) and indexes the verdicts by line id for its notice and its
  commit; it still calls `resolveDrag` per pointer move for the ghost's geometry, which a
  verdict does not carry. A row the drop would not change is left out of the list rather
  than reported, because releasing over such a row already does nothing.
- **A drag draws a preview and does not re-lane.** Lanes are greedy first-fit over shot
  extents, so re-deriving coverage on each pointer move moves brackets the author never
  touched into other columns and changes the grid's column count under the cursor. The
  strip therefore draws committed coverage for the whole gesture, and `previewOf` draws
  the proposal over it. The proposal is ghost brackets in the dragged shot's existing
  lane, plus a tint on the rows it would claim and release. The branch editor's animated
  relayout follows the same rule, changing layout on commit rather than during the
  gesture. Drawing committed coverage also keeps the grabbed handle under the pointer.
  `update()` returns early while a gesture is live, because the row under the pointer is
  read from the DOM and rebuilding would replace the nodes the drag is aimed at; a
  selection the grab published lands on release.
- **Claiming a line takes it from whatever held it.** The exporter shows the first shot
  covering a line, so double coverage silently hides the second shot's frame. A released
  line becomes a gap and renders as a vermilion gutter rather than being handed to a
  neighbour. An uncovered line renders with no image, and the surface exists to reveal
  that. A claim that would leave another shot covering nothing is refused, because
  releasing does not give lines back. A drag that swept across a neighbour and returned
  would destroy it, and the return trip could not undo the destruction. The dragged shot
  may still empty itself through the command DSL; only the side effect is refused.
- **Coverage is a set of segments, not a range.** `spansFor` splits a shot into contiguous
  segments and lanes shots by extent, so the decomposer's interleaving (plate takes the
  narration, each medium one speaker) draws as separate columns instead of nested
  brackets. Only a shot's outermost handles can be dragged, and a shot covering nothing is
  listed under `COVERS NOTHING` instead of being drawn.
- **A bracket's edges resize it; its body moves it.** Dragging a bracket's body runs
  `timeline.reorder` → `story.moveShot`. A shot's position is where its covered lines sit,
  so reordering it moves those lines. The rule is `planShotMove` in `@vn/scriptedit`,
  which operates over line ids and anything with a `coversLines`. The strip can therefore
  run the command's own rule against the `CoverageShot`s it already holds, without
  fabricating a `Scene`. Targets are the other shots plus `top`, aimed by the same
  midpoint rule the script editor's `dropTarget` uses, since N shots have N positions but
  only N−1 of them are named by another shot. A shot that other shots draw inside appears
  on screen in more than one place and has no single position, so it is refused by name.
  The drop is drawn as a rule at a row's edge rather than as a ghost bracket, because
  previewing the new position would mean moving the prose, and layout changes on commit.
- **A reorder is the only free scene edit, and it reports no drift.** No line id changes,
  so coverage does not change, and every shot's covered lines keep their relative order,
  so no `proseHash` moves. Nothing drifts and nothing re-renders. The reorder changes only
  the order of `show` beats in the playable, which is what the author asked for. By
  contrast, `story.moveLine` moves a line between shots and reports drift.
- **Double-clicking a bracket opens the frame drawn for that shot**, in the Asset editor,
  with the hash taken from `CoverageShot.image` (the storyboard's own `Shot.image`
  projected for the strip). A slot can hold several takes, so the editor reads the field
  rather than picking among them, which opens the picture the runner would show. A shot
  with no frame yet is refused with a sentence in the notice row. The document tree
  handles the same gesture the same way, over `DocNode.hash`
  ([`document-tree.md`](document-tree.md#opening-a-shots-frame)). It shares the tree's
  `countCl
- **Rows are grid rows, so the grid sizes each row to its wrapped prose.** The code
  measures only which row the pointer is over. A full-width `.tl-band` sits behind each
  row, and `elementFromPoint` reaches it once `.tl-grid.dragging` drops pointer events on
  the script and the brackets.
- **Clicking a line's text retypes it, one `story.setLineText` per commit.** The editor is
  a textarea in the row it replaces. It auto-grows via a one-cell grid whose invisible
  `::after` sizer carries the same string, so nothing is measured and no frame exists
  where the layout disagrees with the caret, and the brackets follow because grid rows
  place them. Enter commits and Escape discards, and both act rather than calling
  `blur()`, which does nothing on an element that is not the active element. A draft that
  matches the line produces no record. Typing over a covered line reports what it will
  cost before the commit, debounced from the command's own `check`, and a refused commit
  reopens the editor with the draft beside the reason. Editing and coverage dragging are
  two modes on one grid: a handle's `pointerdown` is prevented and so cannot blur an open
  editor, which means the grab is refused with a sentence rather than the half-typed line
  being committed under the gesture. `timeline/editing.ts` is the "pure"
  (side-effect-free) half of the two-mode rule; retyping itself is
  `src/shared/lineedit.ts`, shared with the script editor so the two surfaces cannot
  disagree about how a line is retyped.
- **Shots are made and unmade here too, under the same rules the agent runs.** A third
  gesture over the same grid maps `timeline.create` → `story.newShot`. Dragging along a
  row's gutter cell sweeps lines into a new shot; that gutter cell is its own element at
  the row's left edge, so no two gestures share a pointerdown. The drag is judged once at
  the grab, as the other two gestures are, and the verdict names the id the write would
  actually
- **A write in flight locks the strip, and a notice appears after 150 ms.** Every command
  re-reads the whole strip when it lands, so a grab, a retype or a wardrobe pick started
  mid-write would be judged against rows the landing is about to replace.
  `rules/timeline/busy.ts` holds the "pure" (side-effect-free) state. The lock takes
  effect immediately. The notice row becomes an indeterminate progress bar carrying the
  command's own title ("Making shot…") only once the write outlives `BUSY_DELAY_MS`, and
  the bar then resolves into the outcome notice, so one row changes tone rather than a
  second surface appearing. A locked control carries one sentence — "Waiting for the last
  edit to land." — and the same sentence is shown as the refusal when a gesture is
  blocked.
- **A write from somewhere else re-reads the strip.** The agent rewrites a storyboard
  through its own tools, and the palette runs the same `story.*` commands without this
  pane, so the strip subscribes to `onInvalidate` and re-reads when it fires. The graph is
  re-read too, because a scene may have been written in that time. The pane also re-reads
  when it comes back on screen, for the same reason: it cannot determine from here what
  changed while it was away. `canReread` in `rules/timeline/editing.ts` blocks the re-read
  while an editor is open, a handle is held, or a write of this pane's own is in flight,
  the same three states the gestures check. The reason an open editor blocks the re-read
  differs from the reason a click on a second line does not block it: nothing here blurs
  the editor first, so the draft would be dropped rather than committed. This pane's own
  commands run with `source: 'ui'` and so do not bump the undo revision, so a write made
  here does not re-read twice.
- **An undecomposed scene renders its script.** Correcting a line is exactly what an
  author wants to do before paying for art, so a scene with no `work/shots/<id>.json`
  draws the script column with no bracket columns and a note rather than a refusal. The
  note carries the two ways out of that state, `story.decomposeAll` and `story.newShot`,
  and checks each invocation before drawing it: an invocation that would be refused is
  drawn disabled, with the refusal as its tooltip. Placing the first shot by hand creates
  the storyboard, which ends decomposition for that scene, and the command's `check`
  reports this before the write. Both the vermilion gap gutter and the uncovered count
  appear only once a storyboard exists.
- **A frame that illustrates old prose is marked, not re-run.** Main derives drift
  (`driftOf`, surfaced as `CoverageShot.drift` — see
  [`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines)), and the
  bracket renders it as a state: dashed sodium with `OLD PROSE` in the mono head. That
  state is distinct from the vermilion `COVERS NOTHING`, which reports a different problem
  with a different fix. The color is sodium because the authored side is what moved. The
  mark sits on the head rather than over the image because the runner will still show that
  frame. A shot rendered before the hash existed reads a dim `PROSE?`. It is dim because
  the author cannot act on it and it clears at the next render. Acting on drift is the job
  of `pipeline.run` and of the author; this surface only reports the drift.
- **The wardrobe strip shows both levels at once, and every row names the level that
  answered.** Below the grid sits a `WEARING` section with one row per cast member (the
  scene's `[[outfit:]]` marker). Once a shot is selected, an `IN THIS SHOT` section adds
  one row per subject. An author asking "why is she in the uniform" is asking about both
  at once, so no row ever says merely "inherited" — it says `"uniform" (character sheet)`,
  and the inherit option names what clearing would reveal. The choice comes from a fixed
  set — the wardrobe the command would accept — so each row offers a select rather than a
  drag. `timeline/wardrobe.ts` decides which rows exist and what each holds, and it calls
  `outfitFor` for both the value in force and the value a clear would reveal, so the chain
  is never re-decided here and the strip and the prompt cannot disagree. A shot decomposed
  before outfits were authorable carries an explicit outfit, so a marker cannot reach it;
  that is the one case the strip calls out
  (`hides the scene's "track" — clear it to let the marker through`).
- **`IN THIS SHOT` edits the shot itself, not only what its cast wears.** The section
  carries four more controls, and each one sends the command that holds its rule, so a
  refusal comes back from that command. A `set in` select moves the shot to another
  variant of the scene's location (`story.setVariant`); a variant the location has since
  dropped is added to the select by name, so the editor never silently shows a value the
  author never chose. A `×` on each subject row takes that character out, and an `add`
  select puts another one in — both are `story.setSubjects`, which replaces the whole
  list, so the editor sends the full list rather than a delta. A character that stays
  keeps its outfit override, and removing a character drops that character's override with
  it. A `must appear in the frame` checkbox is `story.requireCast`: when it is cleared,
  the shot's cast still reaches the generator as reference sheets, but `shotSpec` hands
  the reviewer an empty `characters`, so an absence is no longer a blocking defect and the
  refine loop stops spending attempts on a frame it cannot satisfy. The checkbox is
  disabled on a shot that frames nobody, and states that reason. All four controls read
  the `shotCast` shape in `timeline/cast.ts`; the two writes are `setShotSubjects` and
  `requireShotCast` in `@vn/scriptedit`'s `cast.ts`, placed beside the outfit and variant
  rules for the same reason those rules are there.

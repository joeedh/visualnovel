# The desktop app: story editors

<!-- toc -->

- [Branches](#branches)
- [Script](#script)
- [Convo](#convo)
- [Shot Coverage](#shot-coverage)

<!-- tocstop -->

Part of [`desktop-app.md`](desktop-app.md) — the editors an author writes the story through:
Branches (the story graph), Script (one scene's lines), Convo (the vnauthor conversation), and
Shot Coverage (a scene's storyboard).

## Branches

`editors/branch.ts` — the story graph as index cards, on the canvas above
([`desktop-app-shell.md#the-shared-graph-canvas`](desktop-app-shell.md#the-shared-graph-canvas)).
`rooms/studio/branch/{graph,grab,compose,tween}.ts` are imported unchanged; the gesture state
machine that lived inside `BranchEditor.tsx` and was never tested is now `pathux/branch.ts` with
sixteen tests over the three drags.

- **No manual node positions, so every drag is semantic.** `Scene` has no `x`/`y` and layout is
  automatic: dragging a card's handle to another card wires it (`story.setChoice`/`setNext`),
  dropping a card on a wire splices it in (`story.spliceScene`), pulling a wire's arrowhead off
  its target unwires it. Each commits **one** command on release — a drag is continuous, its
  commit is discrete.
- **The gesture is judged once, at the grab.** `grabCard`/`grabHandle`/`grabArrow` capture every
  candidate's verdict from the same `branchConnect`/`branchSplice`/`branchUnwire` an agent would
  ask (`src/shared/interactions.ts` over `branchops.ts`), and `aim` is the one entry a pointer move
  needs — including the promotion from press to splice past `SLOP`, which re-aims in the same move
  so a big jump lands on the wire it ended over. The refusal shown mid-drag is the refusal that
  would happen.
- **`grab.ts` resolves the handle and the arrowhead before `pick` does.** Both discs straddle a
  card boundary, where `pick` answers "background" or "that card" — testing them first is what
  makes them the size they look.
- **Relayout is animated (`tween.ts`)** because a splice re-ranks the graph: the card does not
  stay where it was dropped, and without the transition that reads as breakage.
- **The edge label opens on `pointerdown`, not `click`.** Raw DOM has no reconciliation: a redraw
  between mousedown and mouseup destroys the button and the click never lands. The open `<input>`
  is held across redraws and re-`focus()`ed after each draw — the relayout tween runs `setContent`
  per frame — and the `blur` that re-parenting raises is ignored, or the field would commit itself
  away on the next frame.
- **Which scenes exist is decided here** (`compose.ts`): a scene made from nothing, and a scene
  removed. A new scene lands deliberately *unwired* — this is where you then wire it — and it has a
  second home in the script editor ("a scene after this one", which wires it too). Delete has only
  this one home: offering it from inside the prose of the scene being deleted is an invitation to
  lose work. Both are confirmed against `stack.check` on hover, so the refusal (`arrival is the
  entry scene — point start: in project.yaml elsewhere first.`) arrives before the click.
- **The selected scene is the shell's.** A card clicked here sets `ui.sceneId`, so the script and
  coverage panes follow, and it seeds the conversation composer with `Revise scene <id> — ` even
  when the selection did not move: clicking the card that is already open is how you ask about it
  again.
- **Right-clicking a card offers its script** (`cardMenu` in `pathux/branch.ts`) — the entry the
  document tree has no need of, because a click there already opens the scene while a click here
  only selects it. The scene is selected before the menu opens: `view.open` carries one subject
  string and Script has no entry in `SUBJECT_OF`, so it opens on the shared selection. `where` is
  `elsewhere`, which focuses an open Script pane rather than opening a second one and never covers
  the canvas with it. A **stub** — a `[[goto:]]` with no scene behind it — offers `story.newScene`
  prefilled with its id instead, as a form, since a heading is not something a menu row supplies.
  The listener is on the canvas rather than on a card, because the node layer takes no pointer
  events, and `onPick` swallows a pointer-down taken while a menu is open, or the click that
  dismisses the menu would grab the card underneath it.

## Script

`editors/script.ts` — one scene's lines down the pane, typed: the heading, the lines with their
numbers and cues, the composer at the end. `rooms/studio/script/script.ts` (`scriptRows`, `keyAct`,
`stepsOf`, `checkOf`, `splitBoundaries`, `mergeTarget`, `dropTarget`, `nextEditing`) is imported
unchanged; the drag machine from `ScriptEditor.tsx` is now `pathux/script.ts` with six tests. Plan:
[`../plans/archive/INDEX.md#script-composition-in-studio`](../plans/archive/INDEX.md#script-composition-in-studio).

- **The model is a list of lines, not a buffer.** There is no document being diffed on save: a
  keystroke either belongs to the open row's textarea or names one command, and `script.ts` is the
  pure function that decides which. Enter commits the row (and, from the end of a line, opens a
  composer below — a paragraph is one `setLineText` plus one `insertLine` per line, each its own
  undo point); Backspace at the start of an *emptied* line is `story.deleteLine`; Escape discards.
- **The gutter counts the page; the id is in the tooltip.** `scriptRows` carries an `at` — the
  row's 1-based place among the scene's lines, counting past an open composer without renumbering
  around it — and that is the number on screen, readable at rest rather than only on hover. A line
  id is allocated once and persisted, so `L12` stops matching the count as soon as a line is
  inserted above it; it is what a refusal names, which is why the gutter's tooltip still gives it.
- **A composer row is not a line yet.** `story.insertLine` refuses empty text — an empty line has
  no lossless Fountain form — so Enter cannot create a line and let the author type into it.
  Committing the composer *is* the insert, and the id it minted is found by position in the
  reloaded scene (`insertedAfter`), never read back out of a message.
- **Attribution is a cue, not an id.** The cue picker writes `AIKO`, because a prose edit is decided
  against the scene as its file parses, where speakers are still cues — writing the resolved id back
  would rewrite `AIKO` as `@aiko`. The cast offered is the *project's*, since attributing a line is
  how a character enters a scene; an unresolved cue is offered verbatim so picking cannot silently
  discard one typed by hand.
- **Split, merge and new-scene are confirmed, not committed on click.** Each moves lines across a
  scene boundary or creates a file, and only the command can state the cost — so the strip holds the
  invocation, shows `stack.check`'s sentence (the detachment count a split would cause, the refusal a
  merge would give), and commits on a second gesture. The editable fields in the strip are the
  invocation's props. A new scene is **two** commands (`newScene` then `setNext`), because undoing
  the wire should not also delete the prose.
- **The slugline is the control that moves the scene.** The heading at the top of the page is a
  button that opens `openCommandDialog('story.setHeading', …)`, prefilled with the heading the file
  holds — which is why `SceneCoverage` carries a `heading` at all: the pane had only the raw
  `location` slug, and a control offering to edit a heading has to show one. It is a dialog rather
  than the strip's confirm because the cost depends on what is typed: `CommandForm` rechecks on
  every keystroke, so the sentence naming the shots that will be **re-rendered** (not drifted — a
  location is in a shot's task inputs) is on screen as the author types, along with the reminder
  that the prose still describes the old place and the agent is what rewrites it.
- **Affordances are the rules, not guesses at them.** A split is offered at every line but the
  first, since `splitScene` refuses a split that would empty the head; merge is offered only where
  the scene's single `next` is the boundary at the bottom of the pane; "continue to a new scene"
  only from a leaf, because putting a scene *between* two others is the branch editor's splice.
  A line drag is judged once at the grab against `scriptMoveLine.targets`, keyed by insertion point
  (`TOP` or the line to land after) — an insertion point `targets` never judged is a drop that would
  reorder nothing: no rule drawn, no sentence, no commit.
- **The redraw key excludes the draft and the pending act's props**, on purpose — path.ux calls
  `update()` every frame, so keying on what is being typed would rebuild the field under the caret
  once per frame and lose it. The open textarea and the split/merge strip's inputs are persistent
  nodes that mutate in place and only re-run `stack.check`.
- **Opening a row does not clear the notice.** The continuation an act opens carries on from that
  act, so what the command said about it is still the last thing that happened; only a row the
  *author* opens is a new act and clears it.
- **The scene is the shell's, not the editor's.** `ui.sceneId` changing from anywhere is a
  *reload*, not a redraw. So is a write that touched the scene's file, wherever it came from
  (`bridge.onWrote` + `touchesScene`) — but never with a row open, a structural act pending or a
  line held: re-reading would take the draft with it, and `⟳` in the bar is the deliberate version.
- **Under the page: the frames drawn from the scene**, the same `renderAssetStrip` Wiki and
  Documents draw, over `backlinks['scene:<id>']` and gathered by the **shot** each frame illustrates
  rather than by kind — so an author writing a line can see what the block it sits in already looks
  like. It sits below the page rather than inside it: art that scrolled away with the prose would be
  gone exactly when a long scene needs it most. Like the frames' own signal in Wiki it follows
  `onInvalidate`, since rendering a shot is not a write to the scene file, and a scene with no art
  says so — that is the ordinary state of a scene being written.

## Convo

`editors/convo.ts` — the vnauthor pane: the transcript, the three permission cards, the dialogue
box and the composer. The conversation itself is a **value**, `src/shared/convo.ts`, reduced from
the same `AgentEvent` stream `useAgent` reduced untestably inside a `useEffect`, with tests over
what each event does to it. It sits in `shared/` rather than the renderer because **main reduces
the same events** to write the transcript — see the threads bullet below.

- **The live conversation is a module subscribed at boot** (`pathux/agent.ts`, installed by
  `shell.start()`), not editor state, because the agent streams whether or not a convo pane is open
  and a pane opened afterwards has to show what was already said — including a second convo pane
  onto the same transcript.
- **A turn is a command.** `ask` runs `agent.run` through the bridge rather than a bespoke channel,
  so a turn the author types and a turn the palette runs are one act with one record.
  `plan:decision` stays a channel on purpose: it is the reply to a request main is already blocked
  on, not an act of its own.
- **What the author was looking at travels with what they asked.** The composer fills `agent.run`'s
  `scene` prop from `shell().ui.sceneId`, so the selection lands in the provenance record beside the
  question — it is part of what they meant. Main **resolves** it against the live index rather than
  trusting it (`focusOnScene`), so a selection pointing at a scene deleted since contributes nothing
  instead of a sentence about a scene that is gone; the prop defaults to `''` because the palette
  and CDP have no selection. It reaches the agent as a `context` message, not as part of the system
  prompt, and emits no `FeedItem` — a thread records what was said, not the context for saying it.
- **A line that starts with `/` names a skill.** The composer opens a menu of the project's
  playbooks as soon as the first character is a slash, filtered as the name is typed: ↑/↓ move,
  Enter or Tab completes, Escape closes it until the token is left, and a click completes without
  the box ever losing focus. Only at the start of the line, because a `/` anywhere else is
  punctuation and a menu that opened over "and/or" would fight the author on every second
  sentence. On send the token is **expanded** rather than passed through
  (`renderer/rules/slash.ts`, pure and unit-tested): `/continuity-pass scene 3` reaches the agent
  and the transcript as `Follow the “Continuity pass” skill (.aiagent/skills/continuity-pass/SKILL.md). scene 3`.
  A token naming no skill goes as typed. The list comes from `workspace:skills`, its own channel
  because a completion runs on a keystroke and `workspace:doctree` reads every storyboard and the
  manifest to answer; it is re-read on `onInvalidate`, since `create_skill` is a turn in this very
  pane. The debug agent's composer supplies no list and so has no menu — it talks to an agent with
  no project.
- **The agent's permission gate has three doors, and the pane answers all three.** Beside the plan
  card are a **question card** (`ask_user`: the question, a one-line box focused on arrival, Enter
  answers — an empty answer is allowed, because "nothing to add" is a real answer) and a **confirm
  card** for an always-confirm tool (`generate_image`, `edit_image`, `git_revert`, `git_restore`,
  a script-bearing skill's first run), with `Deny` first and unaccented. Both are the plan card's
  request/reply shape — `permission:ask` / `ask:answer`, `permission:confirm` /
  `confirm:decision` — over a promise main is parked on. Two scaffolds used to answer *for* the
  author: `ask` resolved to `''` (so the model was told `User answered:` and proceeded on a guess)
  and `confirmAction` to `true` (so every billed image call was auto-allowed). What the confirm
  card reads is an English sentence built in main by `toolconfirm.ts`, never the raw arguments.
  Teardown — the window closing, or `workspace.open` replacing the session mid-turn — resolves
  every parked door with its safe default rather than leaving the turn hung: no plan, no answer,
  no.
- **The agent may approve art, and what it may approve is decided by re-reading the author.**
  `approve_assets` is wired to a `ToolContext.approval` seam this app owns — `session.approvable()`,
  the same upstream-first walk the tree's *Awaiting approval* group is a projection of;
  `session.approveOne()`, which routes a portrait to `gate.approve` and everything else to
  `asset.accept`; and a **second, small model** (`TRIAGE_MODEL`, resolved by
  `session.triageBackend()` on the project's own key, `null` under `--mock`). That model is shown
  the author's own recent turns and the list — never a word the agent wrote — and answers which
  pictures the request covered, which is then narrowed again in code to hashes the list actually
  held. The author sees the resulting list on an ordinary confirm card before anything is written.
  Why a *second* model: this is a check on the agent, and running it on the model being checked is
  not a check. Full write-up: [`vnauthor.md`](vnauthor.md#approving-art-on-the-authors-say-so).
- **A shortlist is how a question is drawn, not a second door.** `ask_choice` reaches the same
  `permission:ask` / `ask:answer` pair with `choices` (and `multi`) alongside the question, so the
  card grows a column of full-width answer rows — an answer is read before it is clicked — above
  the text field it already had. What goes back is a string in every case, so a host that ignores
  `choices` asks the question as plain text: degraded, never broken. The card's three ways out are
  the list, the box (*"Or type an answer of your own…"*), and **Chat about this** — which *answers*
  with a sentence saying so rather than dismissing, because main is parked on `ask:answer` and a
  card that closed without one would hang the turn.
- **The card is a form the author pages through, and one question is a one-page form.**
  `AskRequest` carries `questions[]` and `ask:answer` carries `answers[]`, so a form is one parked
  turn and one line of the transcript each way — the questions together, then the answers numbered
  under them. Everything the author has filled in lives in an `AskForm` (`renderer/rules/askform.ts`,
  pure and unit-tested): the page they are on, what is ticked per page, what is typed per page.
  **The form belongs to the question, not to a pane.** It is module state in
  `renderer/pathux/agent/agent.ts` (`askFormFor`, `askFormNow`, `setAskForm`), started when the request
  arrives and cleared when the answers go back, so two convo panes fill in one form and a pane
  re-created by a layout change keeps what was answered before it. A pane holding its own copy
  sends the picks that pane happened to see, and the other pane's picks are lost. **Every handler
  must read the live form, not the one it was drawn with**: typing deliberately does not redraw
  (that would take the caret away mid-word), so a Back/Next closed over the drawn form silently
  discards the words just typed. Found exactly that way, driving the card over CDP.
- **‹ Back / Next › sit on the left, away from the one button that ends the form.** A mis-aimed
  click near Submit must not submit half a form. For the same reason a pick on the last page does
  not send — it stands, and **Submit answers** is the only thing that ends a form — while a pick on
  any earlier page turns the page, and a lone single-pick question still answers outright, because
  there is nothing else to say. **Blank is a real answer**, so it never greys the button out: the
  Submit tooltip names the questions that will go back empty and what the agent will read them as,
  and it is recomputed on every keystroke, because a stale count is a lie about the thing the
  author just typed. **Chat about this** fills in only the questions still blank — declining to
  pick is a thing you can mean about some of a form and not the rest.
- **A tick redraws nothing.** Ticking a choice on a multi-pick updates the rows and the Submit
  tooltip in place. Rebuilding the card would take the row out from under the pointer between one
  click and the next and scroll the list as it went, because `rebuild` empties the transcript and
  scrolls it to the bottom, and a click whose row is gone is never delivered. That is one of the
  ways a picked answer reached the agent as `(no answer)`. An outright pick sends what was typed
  beside the list along with the choice, since a choice qualified in the box is one answer and
  sending the choice alone drops half of it.
- **Clearing follows the command, not the button.** The store watches the registry through
  `bridge.onExec`, so `agent.newThread` empties the transcript identically whether the pane's
  **New** button ran it or the palette did — as do `agent.clear`, which has no button and is
  reached from the palette, and `agent.openThread`. Named gap: `window.vn`/CDP goes straight to
  main and none of them emits an event, so a clear run that way leaves an open pane's transcript
  standing.
- **A conversation is a thread, and it is written down twice as it happens.** Main appends one
  JSONL line per feed item to `vngen/state/threads/<id>.jsonl` — lazily, so an app opened and
  closed without a word writes no file — titled from the first thing the author said. Beside it
  sits `<id>.native.jsonl`, the model's own messages in the shape the backend sent them, which is
  what a resume needs and what nothing on screen reads. The bar's **Threads** button opens
  path.ux's searchable menu (`startMenu(…, true)`) over `agent.threads`, newest first, the open one
  bulleted; a separator; **New conversation**. **Reopening one is read-only**: the pane replays the
  stored feed and the dialogue box says the agent has not been shown it. Undo cannot take a
  transcript back — its snapshots exclude `vngen/state`, which is the point of putting them
  there.
- **A reopened conversation is continued from its own history.** **Continue**
  (`agent.resumeThread`) is drawn beside Threads only while a saved conversation is on screen. It
  hands the agent the native log's messages, binds the session to that thread, and the next turn
  appends to the same two files. Continuing happens on the model bound now rather than the one the
  conversation was recorded with, because the check has already refused a binding the stored
  messages could not survive: a thread written before this shipped kept only its transcript, a log
  merged from two clones is no longer intact, a log from a newer version of the app is not read,
  and a vendor or protocol the bound model does not speak would send blocks it cannot read. Each
  refusal greys the button with its own sentence and ends with *"Open it for reading instead."*
  Where Continue is refused, the next thing typed starts a fresh thread, which is also what the two
  surface openers below do to a conversation already on screen.
- **A long conversation is compacted rather than truncated.** **Compact** (`agent.compact`)
  summarizes everything said so far on the model the conversation is bound to and hands the agent
  the summary in place of the messages. Nothing is rewritten: the summary is one more line in each
  log, so the transcript on screen is untouched and the pane draws a labelled rule where the
  summary begins. The button's title says what it would do — the size once a turn has reported one,
  and that a large conversation is worth compacting — and it is greyed with a sentence while a turn
  is running, while a conversation is open for reading, and when nothing has been said since the
  last compaction. The summary's preface tells the agent that nothing it read still counts as read,
  and names the two tools that reach what the summary left out: `search_history` finds a phrase in
  the turns the summary replaced, and `read_history` returns one of them in full.
- **The turns a decision hangs on are in it.** Main records both sides of every permission door at
  its own `permission()` seam — the plan with its steps and files, the verdict as the author's turn
  with whatever feedback came with it, a question with the shortlist it offered — and the loop files
  arguments the schema refused as a `blocked` event carrying what was passed. It records them
  **through the shared `convo.ts` reducers**, so the file and the screen still cannot drift: the
  renderer's own `permission:plan`/`permission:ask` handlers put the same items in the pane. A bare
  `decided(convo)` clears the card and writes nothing, because the renderer clears it knowing only
  `approved` while main knows the real decision. What this buys is `report.agent`: the diagnostic
  reads the thread, and a conversation that went wrong went wrong at exactly these turns.
- **The composer is built once and never rebuilt.** It is what the author is typing into and where a
  seed lands, so it outlives every redraw of the transcript above it — and it stops its own keydown.
- **An upload opens a conversation, and it opens on a question.** **Upload Files…** in the app menu
  runs `upload.pick`; once bytes have landed it puts the session in plan mode, closes the open
  thread and opens this pane with the command's own sentence in the dialogue box — *"Archived 3
  files to `archive/…`. What should I do with them?"* — and the openers under it as **chips**.
  A chip **fills** the composer and does not send: the point is to teach the shape of a useful
  prompt, and sending it removes the moment where the author edits it into what they meant. Nothing
  here is a feed item, so no thread file is written until the author actually says something, and
  `asked` drops the chips the instant one is. A cancelled dialog and a batch where every file was
  refused both leave the conversation in progress alone — the renderer keys on the `seed` the
  command emits only when something was written. See
  [`../plans/archive/INDEX.md#upload-and-archive`](../plans/archive/INDEX.md#upload-and-archive) and
  [`vnauthor.md`](vnauthor.md#the-archive).
- **Two surfaces open a conversation about what is on screen.** Right-clicking a script line offers
  **Edit with agent** (`agent.editLine`); the failure band in the Asset editor carries **Fix with
  agent** (`agent.fixAsset`). Each opens this pane `elsewhere`, flashed, and returns its opener as
  `data.seed` — so running one from the palette does what the click does. The opener lands in the
  **composer**, not in the dialogue box, because it is the author's sentence rather than the
  agent's: a line's opener names the scene, the line's number in it, its id and its words; a
  failure's names the picture, what the pipeline said, and asks what in the prompt or the art notes
  caused it. Both sentences are built by `src/shared/agentseed.ts`, which is pure and tested. A
  conversation already on screen is closed through `agent.newThread` first, so its transcript is
  filed exactly as it is when a thread is started from the menu; an empty one is reused, since
  closing it would file a conversation nobody had. **That decision is the renderer's**:
  `openThreadForReading` clears main's own copy, so main's conversation is empty precisely when the
  author is looking at a full one. Neither command sends a turn, writes anything, or redraws a
  picture. Both declare a `check`, so a turn already running, a line the scene no longer holds, and
  a picture that never failed each grey the control and say why.
- **A pane the author did not click is flashed, once.** `UiEffect`'s `view` carries `flash`, and
  `applyView` outlines the pane it landed in for 600ms after the mesh has settled. It is an overlay
  positioned over the pane's rectangle rather than a class on the `ScreenArea`: pane children paint
  over their own element's border, and the sheet that would style it lives in a shadow root this
  code does not own. A pane that was already open and already focused still flashes — that is the
  case the flag exists for, since nothing else about the pane would move.
- **This pane unnests.** In the room shell the branch and script editors were rendered *inside*
  `Convo`, which is why only one of them could be open. Here the conversation is a pane like any
  other and the author decides whether it shares the window with the page it is about.
- **`busy` is shell-wide, not agent-only**: a pipeline run disables the composer too. While it is
  set the dialogue box says `working` — one word, pulsing through `@keyframes`, built once with the
  stage. No verb list and no timer: a turn that says nothing for thirty seconds is otherwise
  indistinguishable from one that never started.
- **The bar carries the three session facts the turn depends on.** The header has the same
  PLAN ⇄ EXECUTE toggle, but this is the pane a turn is typed into, so this is the pane that has to
  say whether typing edits files. Beside it are the model menu (`agent.setModel`) and the effort
  menu (`agent.setEffort`), both from the one table in `@vn/types` — `TEXT_MODELS`,
  `effortChoicesFor`, `resolveEffort` and `supportsEffort`, which the `vnauthor` REPL's `/model`
  and `/effort` read too. **The effort menu offers what the model takes, and there is no
  `default` item**: it lists that model's own ladder plus `no thinking` where an explicit
  `thinking: disabled` is accepted, and it starts at `low` — see
  [`../plans/archive/INDEX.md#deliberate-reasoning-effort-defaults`](../plans/archive/INDEX.md#deliberate-reasoning-effort-defaults)
  for why the absent knob was the wrong default. A model with no reasoning knob at all greys the
  menu and says why; the setting is **kept** rather than cleared, so switching back to a model
  that honours it needs no second gesture — but a level the new model does not offer is stepped
  down, in main and in the mirrored shell state alike, by the same pure `resolveEffort`.
- **The bar also says what the conversation has cost**, in tokens the provider billed, `842` /
  `12.3k` / `1.4M` at a glance with the exact figures in the tooltip. It counts **calls, not
  turns** — a step the backend had to retry was paid for every attempt — and it reads `—` rather
  than `0` until a provider reports something, a mock backend and a backend that does not say
  being indistinguishable at zero. The receipt travels as an `AgentEvent` (`{ type: 'usage' }`)
  like everything else the agent does, from an **optional** `ChatBackend.messageWithUsage` each
  real backend derives its `message` from; a backend that keeps no receipt shows no total. It adds
  no `FeedItem`, so nothing about it reaches the thread on disk and a reopened conversation starts
  at zero. The label is retitled in place rather than keyed into `stateKey()`: rebuilding the bar
  would close the model or effort menu mid-turn.
- **The composer's stop button is shown only while a turn is in flight**, in `--vermilion`, taking
  Send's shape beside it, and `exec`s `agent.stop` through the registry — so interrupting from here
  and from the palette are one act with one record. An idle composer has nothing to interrupt, and
  a permanently greyed square would say otherwise.
- **The dialogue box is bounded and the transcript is what grows.** `.convo` is
  `grid-template-rows: 1fr auto`, so an unbounded line takes the pane and the transcript gets what
  is left — a long narration turn once cut it to a couple of hundred pixels and put the plan card
  off screen. `.dbox .line` is capped in `em` (so it tracks the prose size) and scrolls itself.

## Shot Coverage

`editors/timeline.ts` — a scene's screenplay down the pane with the shots covering it bracketed
beside it, and the wardrobe under it. It runs **vertically** because screenplays do.
The pure rules live in `renderer/rules/timeline/` (`drift`, `editing`, `wardrobe`, `cast`, `busy`) and in
`@vn/scriptedit` (`coverage.ts`, `shotcreate.ts` — geometry and shot creation, shared with the
agent's tools); the state machine the React component kept in its own `.tsx` is now
`pathux/timeline.ts`, with its tests beside it.
Plans: [`../plans/archive/INDEX.md#shot-timeline-editor`](../plans/archive/INDEX.md#shot-timeline-editor) and
[`../plans/archive/INDEX.md#line-editing-in-floor`](../plans/archive/INDEX.md#line-editing-in-floor).

This is the only surface that edits `Shot.coversLines` directly — the `story.*` scene editors also
move it, as fallout of a split or merge rather than as the point — and `buildShotPrompt` ignores it,
so every edit here is free: nothing rehashes and no art is invalidated. That is also true of the
**prose** it edits, and there it is the problem rather than the feature — hence the drift marking
below.

- **One rule, previewed and committed.** `@vn/scriptedit`'s `coverage.ts` holds the whole
  gesture's logic — `setCoverage` (the rule), `spansFor` (the geometry) and `resolveDrag` (which
  lines a drop asks for) — run by the `story.setCoverage` command in main _and_ by the strip
  mid-drag, so a refusal shown while a handle is carried is the refusal that would happen. It
  lives in the package rather than in `src/shared/` because two hosts — this app and the
  authoring agent — enumerate targets and settle drags with the same geometry. Only `previewOf`
  stays in the renderer: it is ghost geometry for drawing, and main has no use for it. One
  command per drop.
- **The gesture is declared, not just implemented.** `timeline.cover` (in
  `src/shared/interactions.ts`) carries `<shotId>#start` / `<shotId>#end` and judges **every** row
  of the scene, so an agent can ask what a drag would do without performing one. The editor
  evaluates `targets` **once per grab** — state and carried are both fixed for the gesture — and
  indexes the verdicts by line id for its notice and its commit; it still calls `resolveDrag` per
  pointer move for the ghost's _geometry_, which a verdict does not carry. A row the drop would not
  change is dropped from the list rather than reported: "nothing happens" is what release already
  does silently.
- **A drag previews; it never re-lanes.** Lanes are greedy first-fit over shot _extents_, so
  re-deriving coverage per pointer move moves brackets the author never touched into other
  columns and changes the grid's column count under the cursor. The strip therefore draws
  committed coverage for the whole gesture and `previewOf` draws the proposal over it — ghost
  brackets in the dragged shot's **existing** lane, plus a tint on the rows it would claim and
  release. Same rule as the branch editor's animated relayout: layout changes on commit, not
  during the gesture. It also keeps the grabbed handle under the pointer. `update()` returns early
  while a gesture is live, because the row under the pointer is read from the DOM and rebuilding
  would replace the nodes the drag is aimed at; a selection the grab published lands on release.
- **Claiming a line takes it from whatever held it.** The exporter shows the _first_ shot
  covering a line, so double coverage silently hides the second shot's frame. Released lines
  become **gaps** — a vermilion gutter — rather than being handed to a neighbour: an uncovered
  line renders with no image, and revealing that is the point of the surface. But a claim that
  would leave another shot covering **nothing** is refused, because releasing does not give
  lines back: a drag that swept across a neighbour and returned would destroy it, and the return
  trip could not undo it. The dragged shot may still empty itself via the command DSL — only
  the side effect is refused.
- **Coverage is a set, never a range.** `spansFor` splits a shot into contiguous
  _segments_ and lanes shots by extent, so the decomposer's interleaving (plate takes the
  narration, each medium one speaker) draws as separate columns instead of nested brackets.
  Only a shot's outermost handles drag; a shot covering nothing is listed under
  `COVERS NOTHING` instead of being drawn.
- **A bracket's edges resize it; its body moves it.** The second gesture over the same brackets is
  `timeline.reorder` → `story.moveShot`: a shot's position _is_ where its covered lines sit, so
  reordering it moves those lines. The rule is `planShotMove` in `@vn/scriptedit`, over line ids and
  anything with a `coversLines` — which is why the strip can run the command's own rule against the
  `CoverageShot`s it already holds, with no `Scene` to fabricate. Targets are the _other shots_ plus
  `top`, aimed by the same midpoint rule the script editor's `dropTarget` uses, since N shots have N
  positions but only N−1 of them are named by another shot. A shot other shots draw inside is on
  screen in more than one place and has no single position, so it is refused by name. The drop is
  drawn as a rule at a row's edge rather than a ghost bracket: previewing the new position would
  mean moving the prose, and layout changes on commit.
- **A reorder is the one free scene edit, and says so.** No line id changes, so no coverage changes;
  every shot's covered lines keep their relative order, so no `proseHash` moves. Nothing drifts and
  nothing re-renders — only the order of `show` beats in the playable, which is the act the author
  asked for. Contrast `story.moveLine`, which moves a line _between_ shots and reports drift.
- **Double-clicking a bracket opens the frame that shot was drawn as**, in the Asset editor, with
  the hash taken from `CoverageShot.image` — the storyboard's own `Shot.image` projected for the
  strip. A slot can hold several takes, so reading the field rather than picking among them opens
  the picture the runner would show. A shot with no frame yet is refused with a sentence in the
  notice row. The document tree answers the same gesture the same way, over `DocNode.hash`
  ([`document-tree.md`](document-tree.md#opening-a-shots-frame)). It shares the tree's `countClick`,
  but for its own reason: a bracket never receives a `click` at all, because its pointerdown starts
  a reorder and `.tl-grid.dragging` drops pointer events on every `.tl-shot`, so the release
  hit-tests to the band behind it and the pair's common ancestor is the grid. **Presses** are what
  is counted, and the second one opens on release, and only if the reorder never aimed away from
  the shot — otherwise dragging a bracket twice quickly would open it instead of moving it.
  A right-click offers the same thing as **Open shot asset**, from `shotAssetEntry` in
  `pathux/script.ts` — the rule the script column's own line menu uses, so the two surfaces word
  their offer and their refusal the same way. It is a plain `view.open` entry rather than a call
  into `openFrame`, because a right-click entry is a command
  ([`command-system.md`](command-system.md)), and `view.open` publishes the hash to `ui.assetHash`
  itself on the way through.
- **Rows are grid rows, so wrapped prose sizes itself.** The one thing measured is which row
  the pointer is over: a full-width `.tl-band` behind each row, reached by `elementFromPoint`
  once `.tl-grid.dragging` drops pointer events on the script and the brackets.
- **Clicking a line's text retypes it, one `story.setLineText` per commit.** The editor is a
  textarea in the row it replaces, auto-growing via a one-cell grid whose invisible `::after` sizer
  carries the same string — nothing is measured, so no frame exists where the layout disagrees with
  the caret, and the brackets follow because they are placed by grid row. Enter commits and Escape
  discards, and both **act** rather than calling `blur()`, which does nothing on an element that is
  not the active element. A draft that matches the line is not an authorial act and produces no
  record. Typing over a covered line reports what it will cost *before* the commit, debounced from
  the command's own `check`, and a refused commit reopens the editor with the draft beside the
  reason. Editing and coverage dragging are two modes over one grid: a handle's `pointerdown` is
  prevented and so cannot blur an open editor, which means the **grab is refused with a sentence**
  rather than the half-typed line being committed under the gesture. `timeline/editing.ts` is the
  pure half of the two-mode rule; retyping itself is `src/shared/lineedit.ts`, shared with the
  script editor so the two surfaces cannot disagree about either.
- **Shots are made and unmade here too, by the same rules the agent runs.** A third gesture over
  the same grid, `timeline.create` → `story.newShot`: dragging along a row's **gutter cell** — its
  own element at the row's left edge, so no two gestures share a pointerdown — sweeps lines into a
  new shot, judged once at the grab like the other two, with the verdict naming the id the write
  would actually mint (the persisted `nextShot` mark rides `SceneCoverage` for exactly this).
  Claimed lines are taken the way a coverage drag takes them, and the accepted sweep tints the
  rows it would claim. A `+ shot` control in the bar covers the no-gaps case, opening
  `openCommandDialog('story.newShot', …)` prefilled with the scene — and it is the only way in
  here to name the shot's cast, since a drag has no field for one and a sweep along a gutter says
  nothing about who is on screen. Left empty, the cast is the speakers of the claimed lines. Deleting is on the bracket: a
  right-click offers `story.deleteShot`, checked before it is drawn, and the refusal for the last
  shot is shown rather than hidden. The rules — `newShot`, `deleteShot`, the `nextShot` high-water
  mark — are `@vn/scriptedit`'s `shotcreate.ts`, so a shot made by drag and one made by an agent
  op are priced and refused by the same sentences.
- **A write in flight locks the strip, and says so after 150 ms.** Every command re-reads the
  whole strip when it lands, so a grab, a retype or a wardrobe pick started mid-write would be
  judged against rows the landing is about to replace. `rules/timeline/busy.ts` is the pure state:
  the lock is immediate, the notice row becomes an indeterminate progress bar carrying the
  command's own title ("Making shot…") only once the write outlives `BUSY_DELAY_MS`, and the bar
  resolves into the outcome notice — one row changing tone, not a second surface. The one sentence
  a locked control has — "Waiting for the last edit to land." — is both the refusal a blocked
  gesture is told and the tooltip every locked control carries meanwhile.
- **A write from somewhere else re-reads the strip.** The agent rewrites a storyboard through its
  own tools, and the palette runs the same `story.*` commands without this pane, so the strip watches
  `onInvalidate` and re-reads on it. The graph is re-read too, since a scene may have been written
  since. Coming back on screen re-reads for the same reason: what changed while the pane was away
  cannot be known from here. `canReread` in `rules/timeline/editing.ts` holds it off while an editor
  is open, a handle is held, or a write of this pane's own is in flight — the same three states the
  gestures check, and the reason an open editor blocks it differs from the reason a click on a second
  line does not: nothing here blurs the editor first, so the draft would be dropped rather than
  committed. This pane's own commands run with `source: 'ui'` and so do not bump the undo revision,
  which is what keeps a write made here from re-reading twice.
- **An undecomposed scene renders its script.** Correcting a line is exactly what an author wants to
  do *before* paying for art, so a scene with no `work/shots/<id>.json` draws the script column with
  no bracket columns and a note — not a refusal. The note carries the two doors out of it,
  `story.decomposeAll` and `story.newShot`, each an invocation checked before it is drawn: a door
  that would be refused is disabled with the refusal as its tooltip. Placing the first shot by hand
  creates the storyboard, which **ends decomposition for that scene** — the command's `check` says
  so before the write. Both the vermilion gap gutter and the uncovered count wait for a storyboard.
- **A frame that illustrates old prose is marked, not re-run.** Drift is derived in main
  (`driftOf`, surfaced as `CoverageShot.drift` — see
  [`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines)) and rendered as a state on
  the bracket: dashed sodium with `OLD PROSE` in the mono head, distinct from the vermilion
  `COVERS NOTHING`, which is a different problem with a different fix. Sodium because the authored
  side is what moved; on the head rather than over the image because that frame is still what the
  runner will show. A shot rendered before the hash existed reads a dim `PROSE?` — quiet, because the
  author cannot act on it and it clears itself at the next render. Acting on drift is
  `pipeline.run`'s job and the author's; this surface only tells the truth about it.
- **The wardrobe strip shows both levels at once, and every row names the level that answered.**
  Below the grid: a `WEARING` section with one row per cast member (the scene's `[[outfit:]]`
  marker) and, once a shot is selected, an `IN THIS SHOT` section with one row per subject. An
  author asking "why is she in the uniform" is asking about both at once, so no row ever says merely
  "inherited" — it says `"uniform" (character sheet)`, and the inherit option names what clearing
  would reveal. A select, not a drag: the choice is from a fixed set, and the set is the wardrobe the
  command would accept. Which rows exist and what each holds is `timeline/wardrobe.ts`, which calls
  `outfitFor` for both the value in force and the value a clear would reveal — the chain is never
  re-decided here, so the strip and the prompt cannot disagree. A shot decomposed before outfits
  were authorable carries an explicit outfit, so a marker cannot reach it; that is the one case the
  strip calls out (`hides the scene's "track" — clear it to let the marker through`).
- **`IN THIS SHOT` is where the shot itself is edited, not only what its cast wears.** The section
  carries four more controls, each sending the command that owns its rule so a refusal is that
  command's own sentence. A `set in` select moves the shot to another variant of the scene's
  location (`story.setVariant`); a variant the location has since dropped is added to the select
  by name, because the alternative is silently showing a value the author never chose. A `×` on
  each subject row takes that character out, and an `add` select puts another one in — both are
  `story.setSubjects`, which replaces the whole list, so the editor sends the list it wants rather
  than a delta. A character that stays keeps its outfit override; one that leaves takes its own
  with it. A `must appear in the frame` checkbox is `story.requireCast`: cleared, the shot's cast
  still reaches the generator as reference sheets, but `shotSpec` hands the reviewer an empty
  `characters`, so an absence stops being a blocking defect and the refine loop stops spending
  attempts on a frame it cannot satisfy. It is disabled on a shot that frames nobody, and says so.
  The shape all four read is `shotCast` in `timeline/cast.ts`; the two writes are `setShotSubjects`
  and `requireShotCast` in `@vn/scriptedit`'s `cast.ts`, beside the outfit and variant rules for
  the same reason those are there.

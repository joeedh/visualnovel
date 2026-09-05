# The desktop app: pipeline editors

<!-- toc -->

- [Tasks, Task Graph and Inspector](#tasks-task-graph-and-inspector)
- [Gen Graph](#gen-graph)
- [Play](#play)
- [Asset](#asset)

<!-- tocstop -->

Part of [`desktop-app.md`](desktop-app.md). This page covers the editors over the generative pipeline's state: Tasks/Task
Graph/Inspector, Gen Graph, Play, and Asset.

## Tasks, Task Graph and Inspector

Three editors read the pipeline's state and are linked by `ui.taskHash`. `editors/tasks.ts` shows the flat list, `editors/graph.ts`
shows the DAG on the shared canvas, and `editors/inspector.ts` shows one task in detail. The list is better for scanning and the graph
is better for structure. All three are read-only, and the only mutations from any of them are `pipeline.run` and `gate.approve`.
`rooms/floor/taskGraph.ts` owns the derivation and `rooms/floor/attempts.ts` owns the review merge. Both are unchanged, and so are
their tests. The plan is in [`../plans/archive/INDEX.md#task-dag-view`](../plans/archive/INDEX.md#task-dag-view).

- **A task surface publishes `ui.taskHash`, and the inspector watches that hash.** The three authored ids identify a position in the
  story rather than a node. A task that names neither scene nor character is still worth inspecting. Each surface reads that hash and
  neither one references the other, so a pick in the list and a pick in the graph drive the inspector identically. Clicking a task also
  publishes whichever authored ids it names. A task that names none leaves the selection unchanged, so clicking an export keeps the
  author's place.
- **Two marks.** In the list, the ring marks the task the inspector is open on, and the tint marks every other card included in the
  authored selection. The React board had a single highlight, so it could not show both.
- **A stopped task shows its error on the card.** `Task.error` holds the runner's own sentence for a `failed` or `needs_human` node.
  The list is built for scanning, so that sentence is drawn on the card rather than one click away in the inspector. The inspector's
  attempt stack records what each attempt said, which is a different question, and an author looking for the failure does not start
  there.
- **Explain an empty list by naming the control that emptied it.** Four controls hide tasks, and their effects overlap: `only done`
  keeps what succeeded, `only running` keeps what is running, `only failed` keeps what stopped, and Clear finished removes what
  finished, so Clear's set is a superset of `only done`'s. The explanation therefore has to check Clear first. Otherwise a list emptied
  by Clear reports that nothing has finished when ten things have. `renderer/rules/tasklist.ts` holds the explanation and `showing`,
  because both are inferences and both were wrong; the pane keeps only the four control values. While Clear is greyed, its tooltip
  states why it refuses, as the tooltip rule requires.
- **Each status tick is independent, not a state of one control.** The statuses are pairwise disjoint, so an author watching a wave
  in flight can turn on the running status without switching away from the setting they left on. Ticking two selects tasks that are
  finished and still moving, and no task is both, so the list shows nothing and `emptyBecause` names every tick that is on rather than
  only the first tick tested. The bar uses two stacked rows: the top row shows what the list is showing, and the row beneath it holds
  the controls that act on that list, because a half-width pane cuts off the last control when six controls and a sentence of counts
  share a single row.
- **A floating task list opens with `only running` on.** A popup is raised over the mesh to watch running work, so it starts narrowed
  to the tasks that are running. A list in a pane starts showing every task, which suits a list read for structure.
  `VnEditor.openedFloating()` sets this opening state, and `view.ts` calls it after `popupArea` because path.ux sets
  `AreaFlags.FLOATING` after the editor's `init()` has already run. The call sets the opening state and nothing more, and the author's
  next click on the tick overrides it.
- **`only failed` keeps `needs_human` too, which is the reason the filter exists.** An author opens the list when a run did not
  produce what they expected, and a single failure is hard to spot among hundreds of `done` cards. A shot that exhausted its refinement
  attempts is the likeliest explanation of what went wrong, so a filter named for failure that hid `needs_human` would hide what the
  author opened the list to find.
- **Clicking a task opens what it drew, accepted or not.** A task with an `output` has drawn a picture, and an author watches
  pictures arrive in the list, so the click that selects a task also runs `view.open(editor='asset', where='elsewhere',
  subject=<hash>)`. The click goes through the command rather than setting `ui.assetHash` in the pane, because the command finds or
  raises a pane and records the act, and `elsewhere` keeps the command from replacing the pane that shows the list. This is not limited
  to `done` tasks. Bytes from a task that stopped are unusable downstream, which differs from bytes nobody may look at, and an author
  who clicks a failed card is asking to see the rejected frame. A `needs_human` shot carries its last rejected frame as `output`; a
  `failed` task that rendered something carries it on the attempt that rendered it, so `drewAsset` falls back to the last attempt with
  bytes. The card's tooltip says whether the click will open a picture or select the task. A task that drew nothing selects as before,
  and the inspector follows the selection.

- **A hash missing from the cached status indicates a re-plan rather than a cache miss.** The inspector re-fetches once when the hash
  is missing rather than polling, and reports the absence on screen if the task is still missing.

The graph view exists because a literal rendering of `Task.deps` would misrepresent the data in three ways. Each fix is a "pure"
(side-effect-free) function tested in node:

- **The gate is a planner predicate, not an edge.** P3 approval is the planner predicate `sceneUnblocked`, so a halted run has no
  ready tasks and no edge that records the cause. `barrierFor` synthesizes a barrier node, and `taskGraphOf` positions it with
  ranking-only edges. Those edges are passed to `layoutGraph` but not to `routeEdges`, so they set the rank and are never drawn. The
  barrier node renders as a dashed rule across the layout bounds, with one approve button per pending character.
- **`deps` understates coupling.** A `shot_image`'s deps hold only its location plate; the subject portraits come from `inputs.refs`.
  `buildRefEdges` matches an `AssetRef.hash` back to the task whose `output` equals it. Deps are drawn solid and ref edges are drawn
  dashed. A ref that no task produced (an author-supplied image) draws no edge.
- **A slot and the task that fills it are drawn as a single node.** Planning is incremental, so a shot task does not exist until its
  plate is `done`. The slot exists before then, and `PipelineStatus.slots` carries every one of them in `SlotGraph.order` (upstream
  first, so the wire keeps the topology without shipping a `Map`). `slotNodeIds` keys a slot by its task hash where the planner emitted
  that task, and by a `slot:<key>` id otherwise, so no slot is drawn twice (once as a slot and once as a task). A computable `taskHash`
  that does not appear in the graph is still unplanned. `buildSlotEdges` adds only the couplings that `deps` and `refs` do not express,
  deduped by endpoints so a pair renders once as the firmer of the two. An unplanned slot draws hatched and dashed, and it is
  addressable. Clicking it moves the selection to its subject, and to its asset hash when something already fills the slot. Nothing
  estimates a count any more.

- **The overview is clustered, and the layered layout is kept for the cases that are small by construction.** Every shot that uses a
  shared portrait `refs` it, and `rankNodes` assigns ranks by longest path, so every one of those shots lands in the same rank. A
  character in thirty scenes produces a thirty-wide rank before crossing-reduction runs. `clusteredGraphOf` groups the tasks and slots
  by scene, character and location first, so `layoutGraph` receives a graph bounded by the scene plus character plus location count
  rather than by the task count. A cluster carries a per-`TaskStatus` count and an unplanned count instead of per-member detail.
  Cluster edges are `model.edges` projected through `clusterKeyOf` on both ends, then deduped and reduced to the strongest kind present
  (`dep` > `ref` > `slot`), with self-loops dropped. The barrier remains a node in the graph. A cluster ranks below the barrier if any
  member is below it, and a gate-pending character's own cluster is exempted from ranking entirely, because it mixes the gated portrait
  with the sheets downstream of it.
- **Clicking a cluster or a slot opens a task-level view on the same layered layout.** Clicking a cluster runs `clusterMembers`,
  which keeps that cluster's own nodes and only the edges internal to it. The search box above the canvas filters
  `PipelineStatus.slots` by label, and picking a result runs `subgraphFor`, which walks `model.edges` backward from that slot to its
  ancestor closure (the barrier's ranking-only edges are not walked). The barrier is drawn in a slot's subgraph only when the slot is
  below the gate or is a pending seed. Clicking a `scene:` or `char:` cluster also moves the shared selection. Clicking a `loc:`
  cluster leaves the selection unchanged, because `Selection` addresses a location through `docPath`. Clicking `← Overview` clears the
  scope, and the pane falls back to the overview when a scope names an id the next plan no longer carries. The scope is part of the
  pane's `stateKey` and is deliberately not persisted the way `tidy` is. The plan is
  [`../plans/archive/INDEX.md#clustering-the-global-task-graph`](../plans/archive/INDEX.md#clustering-the-global-task-graph).
- **Tidy changes the layout, not the graph.** The graph view's `Tidy` tick re-runs `layoutGraph` with `tidy: true`, which runs more
  ordering sweeps and then straightens each rank with weighted isotonic regression (PAVA). Writing a node's left edge as `u + prefix`
  turns the two constraints (hold the order the sweeps chose, hold the nodes apart) into the single constraint that `u` must not
  decrease, so the pass that pulls every node toward the mean of its neighbours has an exact optimum rather than an iterative guess.
  Edges then run more directly and long chains are drawn as columns. The graph itself does not change (same nodes, same edges, same
  ranks, same order); only the coordinates they are drawn at differ. The layout is deterministic, so the same graph yields the same
  coordinates. Each pane stores its own tidy setting (`'tidy : bool'` on the editor's struct), and that setting is part of the pane's
  `stateKey`, so ticking it repaints without a re-fetch.
- **The gate has a single control, shared by the list and the graph.** A pending character appears as a bar in the list and as a
  button on the graph's barrier rule, and each opens `gate.approve`'s own dialog with `characterId` prefilled. `stack.check`'s refusal
  is therefore printed before the author commits to anything. The author chooses which portrait, so the first refusal concerns the
  empty `hash`. That refusal names the unanswered field and how many are on file, rather than reporting a lookup for a hash that has
  not been requested. The room shell had four partial gate surfaces; `view.room` no longer exists.
- The inspector renders the P7 refine loop, since `shot_image` folds generate → critique → refine into one runner and a task list
  would otherwise show one node that made four image calls for no visible reason. The inspector stacks the attempts and prints the
  `Corrections:` clause that caused each next attempt in the gap between them; `attempts.ts` holds the "pure" (side-effect-free) half.
  The inspector has two contracts. First, `blocking` is computed exactly as `mergeReports` (`@vn/providers`) computes it, so the UI
  shows the same verdict the runner acted on. Second, every attempt's bytes are in the store (`store.write` runs per attempt and
  `store.accept` runs only on the clean one), so rejected frames are viewable over `vnasset://`. The plan is at
  [`../plans/archive/INDEX.md#refine-loop-inspector`](../plans/archive/INDEX.md#refine-loop-inspector).

## Gen Graph

`editors/nodes.ts` — edits the node graph that a slot is generated from. Task Graph shows whether a slot has been drawn; this pane
shows how that slot will be drawn. The pane claims a slot row only when the slot is bound to a graph. Task Graph treats a bound slot
row as a secondary claim, so the pane and Task Graph never claim the same click. The pane pins to `graphSlug`.

[`gen-graphs.md`](gen-graphs.md#the-gen-graph-pane) documents the pane, the graphs it edits, the `gengraph.*` commands the pane issues
for each gesture, groups, and the per-document sync that keeps two panes consistent, so that one page describes the feature end to end.
This page keeps two points about the pane's place among the pipeline editors:

- **Claims resolve by tier rather than by `EDITORS` order.** Gen Graph returns `primary` for a `graph` node and for a `slot` row
  whose `ClaimNode.boundGraph` is set, and Task Graph returns `secondary` for those while keeping its unconditional `primary` on
  unbound slots. The pane claims the `slot` row and not the `asset` row a slot draws. `routeFor` ranks a visible claimant above a
  hidden one, so resolving by tier keeps an open Gen Graph pane from taking clicks on pictures away from the Asset editor
  ([`document-tree.md`](document-tree.md)).
- **Editing the graph redraws its bound slot.** A gesture that changes the authored graph does no work at the time it is made. The
  next `pipeline.run` sets the bound slot's task back to `pending` and draws it again, and the run's notification reports how many
  tasks were redrawn for an edited graph. The task's hash does not change, because the graph runs the slot rather than forming part of
  the slot's definition.

## Play

`editors/play.ts` is the runner. `pathux/play/playback.ts` is the "pure" (side-effect-free) half and covers frames, navigation and the
save blob, with sixteen tests beside it. The stage is deliberately raw DOM inside the column frame, and path.ux widgets appear only in
the chrome above it. A VN frame is a background, a portrait and a text box, and none of those is a control.

- **Playing a story needs no file.** The renderer calls the `story:play` IPC channel, and the main process builds the playable
  in-process from the loaded model and store (`session.playable()`).
- **Image delivery — `vnasset://`.** A privileged custom protocol (registered in `src/main/index.ts`) resolves
  `vnasset://<hash>.<ext>` against both asset roots, in the order `AssetStore` reads them: base art (`assets/objects/`) first, then
  shot frames (`vngen/build/assets/`). See [`asset-stores.md`](asset-stores.md). An `<img src="vnasset://…">` tag therefore loads
  content-addressed bytes from either root, so Documents draws a portrait and Play draws a frame through one path. This is the app's
  only image path.
- **Each frame records its shot, so playback updates the other panes.** `show` beats gained an optional `shot` field (`@vn/types`,
  `@vn/export`), `framesOf` propagates it to the frames between shot changes, and the editor publishes `ui.sceneId`/`ui.shotId` as the
  playthrough moves, so every other pane updates with it. The React runner never published the played position. Publishing it is the
  one behavioural gain of the port and the reason the schema changed. The editor pushes only when the playthrough itself moved, which
  keeps a redraw from overwriting a scene the author has just selected somewhere else.
- **The same two fields also work in reverse.** Selecting a scene or a shot in the document tree, in Shot Coverage or in the task
  graph jumps the playthrough to that scene or shot. `jumpTo` finds the first frame drawn by the named shot, and finds the scene's
  first frame when no shot is named. The jump is pushed onto the navigation stack rather than replacing it, so Back retraces the jump
  the way it retraces a choice. If the playable has no matching scene, the bar reports the missing scene instead of jumping. The
  playable is built from the model as it stands, so a scene with no beats yet is an ordinary pre-run state. Opening the pane starts on
  the shared selection, again because the playable is built from the model as it stands, and falls back to the story's own start.
- **The pane re-reads the playable after a new or re-rendered shot.** The pane subscribes to `onInvalidate` and re-reads the playable
  when the pane returns to the screen, because the playable is built rather than read from a file, so no other signal reports that a
  shot has been made. The position holds across the re-read. A `show` beat folds into the line after it, so a shot change changes which
  image a frame shows rather than how many frames a scene has. A scene that has been removed since the last read is the one case that
  restarts the story.
- **A portrait is drawn over a shot only when the project enables it.** A shot prompt names its own subjects, so the frame already
  shows the cast. The speaker's portrait is drawn over the shot only when `story.play.json` sets `portraitOverlay`, which comes from
  `portrait_overlay` in `project.yaml`. See [`playable-format.md`](playable-format.md#contracts).
- **Playthrough.** The state is a navigation stack (`{ sceneId, frameIndex }[]`, where the last entry is the current one). A click,
  Space, Enter or → advances a beat; at the end of a scene the runner shows choice buttons or auto-follows `next`, and a leaf scene
  shows "The End". ← and Backspace rewind. Save, Load and Reset persist the stack to `localStorage`, keyed by workspace title. The
  area's keymap handles these keys, running ahead of the screen's keymap and after path.ux's own textbox guard, so the React runner
  does not need to inspect element tags.
- **The stage shows a sentence when a playable is missing, instead of crashing.** Having no project open (or a project with no
  generated art) is an ordinary state that an author reads and acts on.

## Asset

`editors/asset.ts` shows the bytes of one generated asset, the prompt that made them, and the art notes that would make them
differently. The editor's subject is `ui.assetHash`, which the documents tree publishes when an asset leaf is clicked. The rules over
it are "pure" (side-effect-free) and live in `renderer/rules/assetview.ts` with tests beside them. They decide which approve command
applies, the badges, the failure and drift notes, and which prompt to show. The plans are
[`../plans/archive/INDEX.md#asset-names-and-the-asset-editor`](../plans/archive/INDEX.md#asset-names-and-the-asset-editor) and
[`../plans/archive/INDEX.md#on-demand-concept-images`](../plans/archive/INDEX.md#on-demand-concept-images).

`art.generate(sentence=…)` is the other entry point. It draws a concept and opens the drawing here unless the caller opts out, so a
caller that requests a picture sees the result. `art.redraw` opens the sketch it produces in the same way.

- **Each clause of the prompt is drawn as its own card.** Each `PromptChunk` the builders derived is one card. The cards appear in
  the order they are sent, and each is tagged with its category and marked with its source. A card carries `--sodium` when an author
  wrote the sentence, and `--signal` when the builder supplies it as scaffolding. A card can be muted, replaced, appended to, or
  dragged to another position, and a card that came from a document offers a `⇱` to that document. The art notes sit beside the cards
  and are still append-only. Both the cards and the art notes are authored input. Setting either re-keys the task, so regenerating runs
  the pipeline that already exists rather than reaching the image model by a second path. See
  [`../plans/archive/INDEX.md#chunked-prompts`](../plans/archive/INDEX.md#chunked-prompts).
- **A reference image is shown on the card of the clause it is evidence for.** Under each card is a strip of thumbnails
  (`vnasset://<hash>.<ext>`). Clicking a thumbnail opens that picture in the pane that shows what the reference is for, and `×` runs
  `prompt.dropRef`. A chip on a muted clause is drawn muted as well, because muting the clause stops sending its references too. A chip
  whose slot has moved is marked `drift`. `asset.upload` brings an outside image in, and `prompt.addRef` takes either its hash or a
  slot address (`plate:cafe/night`).
- **A suspended asset is not re-rendered; it reports what moved.** The `suspended` badge and `driftNote`'s sentence come before the
  ordinary staleness sentence, because they make the stronger claim that the words may still be correct and that the picture the asset
  was drawn against changed. `prompt.repin` clears the suspension, and `regenerate=false` keeps the bytes.
- **A picture whose run failed reports the reason in the pane that shows the picture.** `AssetInfo.failure` reads the slot's identity
  from the project as it stands today, and reads `asset.sourceTask` only when that identity is not terminal. The two sources diverge
  after an art-notes edit: the slot re-keys, a run fails on the new task, and the last good render is still on screen. The band then
  reports that a re-render failed and names the frame the author is looking at. `driftNote` is suppressed, because the failure already
  reports that the project has changed. `failed` compares the retry budget (`config.max_task_attempts`) against the attempt records
  that carry an error; `needs_human` makes no such comparison, since a P7 refine pass records an attempt without an error. **Show
  task** opens the task that failed, which is not always the task that produced the bytes on screen.
- **Regenerating a failed re-render requests that render rather than the one on screen.** An authored change re-keys the slot, so the
  pipeline re-renders it as a matter of course. A failed or flagged picture is normally recovered by planning a fresh node with a retry
  budget of its own (packages/pipeline/src/tests/rerender.test.ts). One kind of edit is given no fresh budget. If an edit lands the
  slot back on an identity that already spent its budget, that identity is terminal, because `requeueFailed` counts a task's
  error-carrying attempts for the life of the project. `asset.regenerate` requests the render again. `asset.regenerate` refuses a
  `stale` asset (whose own task is an orphan) unless the slot's current identity is `failed` or `needs_human`. For those two
  identities, `asset.regenerate` queues that task, and the picture on screen stays until the new render lands.
- **Regenerate starts the run instead of reporting the refusal.** `asset.regenerate` refuses a stale asset because the asset's own
  task is an orphan. The re-key already produced a fresh task that plans the picture the author asked for, and a pipeline run reaches
  that task. In that case the button opens `pipeline.run`'s own dialog with the dry-run box unticked, and a note states why the dialog
  opened and why the box is set that way. The author then confirms the work and its cost rather than reading a message that tells them
  to go and find the command. `regenerateAction` in `renderer/rules/assetview.ts` picks between the two actions and writes the button's
  tooltip, since one label now covers both. It tests for a failed re-render first, matching the order of `regeneration` in
  `main/session.ts`. The command handles the refusals that need the graph (an asset recording no task, base assets unavailable),
  because only the command can see the graph.
- **The mode strip shows which text is sent.** That text is the clauses, a prompt the author wrote by hand, or a prompt the agent
  condensed. A button beside the strip condenses. A condensation whose clauses have since moved is "held", and the banner over the
  cards reports this; the pane does not re-render the cards. The answer from `prompt.check` appears beside the strip and marks a clause
  that a custom or condensed prompt no longer appears to say. A mark tells the author to check that clause rather than stating a
  verdict.
- **Reorder targets are computed at the grab.** `promptReorder.targets` runs once when a card's rail is grabbed, and each pointer
  move only looks up the result, so the insertion rule and the sentence in the footer show what the drop would do. Nothing moves until
  pointerup. `Alt+↑`/`Alt+↓` performs the identical lookup without the pointer.
- **A concept has no builder, so it gets a box rather than cards.** Nothing derives a concept, nothing rewrites it, and no task hash
  contains it, so it is a root asset. The pane shows a Redraw box holding the whole recorded prompt (an edit leaves the style preamble
  and the framing sentence in place by default), and `art.redraw` draws the concept again as a new sketch beside the original. The
  header bar shows Redraw in place of Approve and Regenerate rather than greying them out, because nothing approves a concept and
  nothing plans one, so neither button could act on one, and two greyed-out buttons beside a working one look broken. `promptEditable`
  in `renderer/rules/assetview.ts` is the one rule both halves read; it refuses a derived kind, whose prompt moves through the clause
  cards instead.
- **One box per rung that applies.** The rungs are ordered widest first: the character or location, then the outfit or variant, then
  the shot. Each box commits on Ctrl+S or when you leave it, calling `art.setNotes` with the tree's own `kind:key` target vocabulary.
  The same edit is therefore reachable from the palette, from CDP and (for the entity rungs) from `vnauthor`.
- **`asset.info` shows what is derived today, not only what was recorded.** It re-derives the prompt for the same binding and
  compares it with the one stored in the bytes. If the two differ, `asset.info` shows the `stale` badge and a banner. An art-notes edit
  leaves the asset marked `stale` until the next run.
- **Approve says which command it would run.** A portrait goes to `gate.approve`, the command that also writes `character.md` and
  `approved.png`. Everything else goes to the generic `asset.accept` across both roots. A portrait whose character the project has lost
  is a concept, and is refused by name rather than accepted through `asset.accept`, because nothing downstream consumes a concept and
  accepting one would settle nothing. An upload is the opposite case. A concept has no downstream, and an upload has no upstream. The
  bar reads `uploaded` where the command pair would be, because nothing generated the upload, so there is no work to approve and no
  task to requeue.
- **Approve prerequisites before the asset, and draw the frontier under the picture it belongs to.** A "DRAWN FROM" strip lists
  `AssetInfo.prereqs`, which holds everything these bytes rest on in the order the task fed them to the model, and each row states
  whether that prerequisite stands. While a prerequisite is pending, Approve is greyed and its tooltip repeats the refusal word for
  word. The strip states the same sentence, so nobody has to hover a disabled button to learn which row is holding it up. That sentence
  comes from main, where `previewAccept` refuses `asset.accept` with the identical one, because a greyed button that the command itself
  would honour misstates the rule, and the palette, the agent and CDP all reach the command directly. This strip is deliberately not
  the reference strip. The reference strip lists the bytes pinned to one prompt clause (one set of evidence per clause, each
  detachable), and it opens elsewhere because it is a second thing to look at. The "DRAWN FROM" strip lists what the whole picture
  rests on. Nothing detaches, and a click retargets this pane, because the job is to walk up the chain approving as you go, and a new
  pane per hop clutters the mesh. One `← back` chip makes that walk reversible, and the chip clears when the subject changes in any
  other way. A prerequisite whose bytes the manifest has lost appears as a disabled row whose tooltip gives its own refusal.
- **Accepting an older take restores it rather than only flagging it.** `asset.accept` writes one bit of the manifest, and the slot's
  task still names the later render, so accepting a take that something replaced would appear to do nothing while the runner and the
  exporter continued to use the newer picture. `approveAction` routes a take that has a `newerTake` to `asset.restore` instead, which
  runs `asset.adopt(replace)` followed by `asset.accept` as one confirmed act. The take that held the slot becomes the older one, both
  in the store and in the `newerTake` link, which now runs in the opposite direction. `asset.restore` keeps the prompt these bytes were
  drawn from rather than restamping the slot's current prompt (`AdoptSlotRequest.keepPrompt`), because a picture drawn before today's
  words has drifted from them, and restamping would hide that drift. Portraits are excluded by name, because an earlier look is
  restored through `gate.approve`. `asset.restore` refuses on suspension and on missing upstream approval on the same terms as
  accepting would.
- **Download writes the bytes out of the store.** `asset.export` asks the host for a path through `saveFile`, then copies the picture
  there. It reads the project and writes nothing back, so it is not `mutating` and takes no confirmation. The offered name comes from
  `downloadName` in apps/desktop/src/shared/assetfile.ts, which strips the characters a filesystem disallows, trims a trailing dot or
  space, and caps the length. `downloadName` falls back to the short hash when those steps leave nothing of the label, or when the
  result is a name Windows reserves. The button sits beside Task in the asset editor's header, and the same command is on the document
  tree's asset menu, below the separator with the other entries that do not change the project.
- **A concept gets a Promote strip instead. No other asset kind gets one.** The strip names the location the sketch is bound to,
  takes a variant id, and runs `art.promote`. The variant joins that location's sheet if it is new, the bytes become the plate, and the
  next run uses those bytes. `promoteAction` determines whether the strip is drawn at all, so a character concept never gets a control
  that bypasses the approval gate. Half-typed input in the strip is kept through a background refetch of the same asset and is dropped
  when the pane moves to another asset.
- **A picture the project planned gets a Replace strip, and the author never types the slot.** An author who paid someone to clean a
  frame up has bytes better than any run will produce, so `asset.replace(hash=…)` opens an image chooser and makes what comes back that
  slot's output. It performs `asset.upload` and `asset.adopt` in one step, reading the slot off the asset on screen rather than making
  the author spell it out. The strip is drawn from `AssetInfo.slot`, which names the slot these bytes fill at present. It is absent on
  a concept and on an upload, because nothing plans those, and absent again once a later render has taken the slot over, so a
  superseded picture never gets a strip that would supersede the picture that replaced it. `replaceAction` declines a `portrait:` slot
  by name, because replacing a look approves that look and `gate.approve` is the command for approving a look; the strip applies in
  layout the same rule that `adoptionForSlot` enforces as `GAT
- **Show task does not duplicate the inspector.** `ui.taskHash` is published and the inspector is opened elsewhere. The inspector
  shows attempts, the refine loop and the reviewer's verdict, and this pane does not re-render them.
- **A write triggers a re-read unless a box is dirty.** `onInvalidate` covers this pane's own edit, the agent's edit, and an undo of
  either. A refetch under a half-typed note would discard that note, so the re-read is suppressed while a rung is in progress and runs
  once that rung commits.
- **The pane follows its slot forward.** `AssetInfo.newerTake` names the asset filling this asset's slot when that asset is not this
  one, and `watchSlot` moves the pane onto it, so a run that lands a new render while the author is watching shows the new picture
  rather than the frame it replaced. Only the take that held the slot follows, so a pane showing an earlier take the author walked back
  to stays on that take. The pane decides which take holds the slot when it arrives on an asset and then keeps that decision, because
  an authored edit re-keys the slot and empties it until something renders, and every take reports no newer take inside that window. A
  pinned pane never follows.
- **The header marks an asset that cannot be finished.** `blockedNote` reports a reason when the task failed, when something upstream
  is unapproved, or when a reference the bytes were drawn against has moved. When `blockedNote` reports a reason, a red `?` follows
  Task in the header, and the tooltip on that `?` gives the reason plus where to read the rest. The marker sits in the header rather
  than the body because the band carrying the same text is below the picture, and a tall asset pushes that band off screen. Every
  sentence the tooltip shows comes from the pipeline, `asset.accept`'s refusal, or the suspension check, so the marker cannot disagree
  with the band beneath it.

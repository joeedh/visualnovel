# The desktop app: pipeline editors

<!-- toc -->

- [Tasks, Task Graph and Inspector](#tasks-task-graph-and-inspector)
- [Gen Graph](#gen-graph)
- [Play](#play)
- [Asset](#asset)

<!-- tocstop -->

Part of [`desktop-app.md`](desktop-app.md) — the editors over the generative pipeline's state:
Tasks/Task Graph/Inspector, Gen Graph, Play, and Asset.

## Tasks, Task Graph and Inspector

Three editors over the pipeline's state, linked by `ui.taskHash`: `editors/tasks.ts` (the flat
list), `editors/graph.ts` (the DAG, on the shared canvas) and `editors/inspector.ts` (one task in
detail). The list is better for scanning, the graph for structure; both are read-only, and the only
mutations from any of the three are `pipeline.run` and `gate.approve`. `rooms/floor/taskGraph.ts`
owns the derivation and `rooms/floor/attempts.ts` the review merge, both unchanged with their tests.
Plan: [`../plans/archive/INDEX.md#task-dag-view`](../plans/archive/INDEX.md#task-dag-view).

- **A task surface publishes `ui.taskHash`, and that is what the inspector watches.** The three
  authored ids answer "where in the story", which is not the same question as "which node" — a task
  naming neither scene nor character is still worth inspecting. The surfaces are linked by that
  hash rather than by either knowing the other exists, so a pick in the list and a pick in the graph
  drive the inspector identically. Clicking a task also publishes whichever authored ids it names,
  and a task naming none returns the selection **identical**: a click on an export cannot cost the
  author their place.
- **Two questions, two marks.** In the list, the ring is the task the inspector is open on; the
  tint is every other card the authored selection is about. The React board had one highlight and
  therefore could not say both.
- **A task that stopped says why on the card.** `Task.error` is the runner's own sentence for a
  `failed` or `needs_human` node, and the list is the surface built for scanning — so it is drawn
  there rather than one click away in the inspector, whose attempt stack answers a different
  question (what each *attempt* said) and is not where an author looking for the failure starts.
- **An empty list blames the control that emptied it.** There are four ways to hide a task and
  they overlap: `only done` keeps what succeeded, `only running` keeps what is moving, `only
  failed` keeps what stopped, Clear finished takes what finished out, and Clear's set is a
  superset of `only done`'s. So the sentence
  has to ask about Clear *first* — otherwise a list emptied by Clear says nothing has finished at
  the moment ten things have. `renderer/rules/tasklist.ts` holds both that and `showing`, because
  both are inferences and both were wrong; the pane keeps only the four control values. Clear's
  own tooltip while greyed is its refusal, per the tooltip rule.
- **Each status tick is its own, not a state of one control.** The statuses are pairwise disjoint,
  so what an author wants while a wave is in flight is the *running* half rather than a
  mode switch away from the setting they left on. Ticking two is a request for a task that is
  finished and still moving, which no task ever is — so the list shows nothing and `emptyBecause`
  names every tick that is on rather than blaming whichever one happens to be tested first. The bar
  is a **column of two rows** — what the list *is* on top, what to do about it underneath — because
  six controls and a sentence of counts in one row lose their last control in a half-width pane.
- **A floating task list opens with `only running` on.** A popup is raised over the mesh to watch a
  wave go by, so it starts narrowed to what is moving; in a pane the list starts on everything,
  which is what a list read for structure wants. `VnEditor.openedFloating()` is the hook that says
  so, called from `view.ts` after `popupArea` because path.ux sets `AreaFlags.FLOATING` after the
  editor's `init()` has already run. What it sets is an opening state and nothing more: the
  author's next click on the tick owns it.
- **`only failed` keeps `needs_human` too, and that is the point of it.** The list is where an
  author goes when a run did not produce what they expected, and a failure is a needle in a column
  of hundreds of `done` cards. A shot that exhausted its refinement attempts is the likeliest
  answer to “what went wrong”, so a tick named for failure that hid `needs_human` would hide the
  very thing it was ticked to find.
- **Clicking a task opens what it drew, accepted or not.** A task with an `output` *is* its
  picture, and the list is where an author watches one arrive — so the click that picks it also
  runs `view.open(editor='asset', where='elsewhere', subject=<hash>)`. Through the command rather
  than by setting `ui.assetHash` in the pane: the command is what finds or raises a pane and what
  records the act, and `elsewhere` keeps the list being scanned from being the pane that gets
  replaced. **Not only `done`**: bytes from a task that stopped are bytes nothing downstream may
  *use*, which is a different thing from bytes nobody may *look at* — and a rejected frame is
  exactly what an author clicking a failed card is asking to see. A `needs_human` shot carries its
  last rejected frame as `output`; a `failed` task that rendered something carries it on the
  attempt that rendered it, so `drewAsset` falls back to the last attempt with bytes. The card's
  tooltip says which of the two the click will do; a task that drew nothing selects as before, and
  the inspector follows.

- **A hash the cached status has never heard of is a re-plan, not a miss.** The inspector re-fetches
  once on that condition rather than polling, and says so on screen when the task is still absent.

The graph view exists because a literal rendering of `Task.deps` would be dishonest in three ways,
and each fix is a pure function tested in node:

- **The gate is not an edge.** P3 approval is a planner predicate (`sceneUnblocked`), so a
  halted run has nothing ready and no edge saying why. `barrierFor` synthesizes a barrier node
  and `taskGraphOf` positions it with **ranking-only edges** — handed to `layoutGraph` but not
  to `routeEdges`, so the rank is real and the wires are never drawn. It renders as a dashed
  rule across the layout bounds, carrying one approve button per pending character.
- **`deps` understates coupling.** A `shot_image`'s deps hold only its location plate; the
  subject portraits arrive through `inputs.refs`. `buildRefEdges` matches an `AssetRef.hash`
  back to the task whose `output` equals it — **deps solid, ref edges dashed**. A ref no task
  produced (an author-supplied image) is not an edge.
- **A slot and the task that fills it are one picture.** Planning is incremental, so shot tasks
  don't exist until their plate is `done` — but the *pictures* do, and `PipelineStatus.slots`
  carries every one of them in `SlotGraph.order` (upstream first, so the wire keeps the topology
  without shipping a `Map`). `slotNodeIds` keys a slot by its task hash where the planner actually
  emitted that task and by a `slot:<key>` id otherwise, so the future is never drawn twice — once
  as a promise and once as work. A computable `taskHash` the graph has never seen is still
  unplanned. `buildSlotEdges` adds only the couplings `deps`/`refs` cannot know, deduped by
  endpoints so a pair renders once, as the firmer of the two. An unplanned slot draws hatched and
  dashed and **is** addressable — clicking it moves the selection to its subject and, when
  something already fills it, its asset hash. Nothing estimates a count any more.

- **The overview is clustered; the layered layout is kept for what is small by construction.** A
  shared portrait is `refs`'d by every shot that uses it, and `rankNodes` is longest-path, so every
  one of those shots lands in the same rank — a character in thirty scenes produces a thirty-wide
  rank before crossing-reduction runs. `clusteredGraphOf` groups the tasks and slots by scene,
  character and location first, so `layoutGraph` is handed a graph bounded by the scene plus
  character plus location count rather than by the task count. A cluster carries a per-`TaskStatus`
  count and an unplanned count instead of any per-member detail. Cluster edges are `model.edges`
  projected through `clusterKeyOf` on both ends, deduped and kept as the firmest kind present
  (`dep` > `ref` > `slot`), with self-loops dropped. The barrier stays a real node: a cluster ranks
  below it if any member is below, and a gate-pending character's own cluster is exempted from
  ranking entirely, because it mixes the gated portrait with the sheets downstream of it.
- **A cluster or a slot opens a task-level view, still on the layered layout.** Clicking a cluster
  runs `clusterMembers`, which keeps that cluster's own nodes and only the edges internal to it;
  the search box above the canvas filters `PipelineStatus.slots` by label and picking a result runs
  `subgraphFor`, the ancestor closure of one slot walked backward over `model.edges` (the barrier's
  ranking-only edges are not walked). The barrier is drawn in a slot's subgraph only when the slot
  is below the gate or is a pending seed. A `scene:`/`char:` cluster click also moves the shared
  selection; a `loc:` cluster moves none, because `Selection` addresses a location through
  `docPath`. `← Overview` clears the scope, and a scope naming an id the next plan no longer
  carries falls back to the overview. The scope is part of the pane's `stateKey` and is
  deliberately not persisted the way `tidy` is. Plan:
  [`../plans/archive/INDEX.md#clustering-the-global-task-graph`](../plans/archive/INDEX.md#clustering-the-global-task-graph).
- **Tidy is a second layout, not a second graph.** The graph view's `Tidy` tick re-runs
  `layoutGraph` with `tidy: true`, which spends more ordering sweeps and then straightens each rank
  with weighted isotonic regression (PAVA): writing a node's left edge as `u + prefix` turns "keep
  the order the sweeps chose, keep the nodes apart" into "`u` must not decrease", so the pass that
  pulls every node toward the mean of its neighbours has an exact optimum rather than an iterative
  guess. Edges come out running more directly and long chains come out as columns. Nothing about the
  graph changes — same nodes, same edges, same ranks, same order — only where they are drawn, and it
  is deterministic, so the same graph in is the same coordinates out. It is remembered per pane
  (`'tidy : bool'` on the editor's struct) and is part of the pane's `stateKey`, so ticking it
  repaints without a re-fetch.
- **The gate has one affordance, and it is the same one in both places.** A pending character is a
  bar in the list and a button on the graph's barrier rule, and each opens `gate.approve`'s own
  dialog with `characterId` prefilled — so `stack.check`'s refusal is printed before the author
  commits to anything. Which portrait is left to the author, so that first refusal is always about
  the empty `hash`: it names the unanswered field and how many are on file, rather than reporting a
  lookup for a hash nobody has been asked for yet. The room shell had four partial gate surfaces;
  there is no `view.room` to jump through any more.
- **The inspector renders the P7 refine loop**, since `shot_image` folds generate → critique →
  refine into one runner and a task list would otherwise show one node that made four image calls
  for no visible reason. It stacks the attempts with the `Corrections:` clause that caused each next
  one in the gap between them; `attempts.ts` is the pure half. Two contracts: `blocking` is computed
  exactly as `mergeReports` (`@vn/providers`) computes it, so the UI can't disagree with the verdict
  the runner acted on; and every attempt's bytes are in the store (`store.write` runs per attempt,
  `store.accept` only on the clean one), so rejected frames are viewable over `vnasset://`. Plan:
  [`../plans/archive/INDEX.md#refine-loop-inspector`](../plans/archive/INDEX.md#refine-loop-inspector).

## Gen Graph

`editors/nodes.ts` — the node graph one slot is generated by. Task Graph says whether a slot has
been drawn; this pane says how it will be. It claims a slot row only when the slot is bound to a
graph, and Task Graph takes such a row as a secondary claim, so the two never fight over one click.
The pane pins to `graphSlug`.

The pane hosts path.ux's `NodeGraphView` inside `appendSurface`, with `styles/gengraph.css`
adopted into the pane's own shadow root. The graph is read over the `gengraph:doc` channel as the
file's nstructjs JSON and parsed back into a real `Graph` by `readGraphFile`, because the DSL
carries topology and authored values and no layout, and a frame has to be drawn where the author
left it. Diagnostics from the read and from the file itself are shown in a strip above the canvas.

- **Every mutating gesture becomes a `gengraph.*` command.** `renderer/rules/gengraph.ts` is the
  pure half: it reads one of path.ux's gesture kinds as a `GenEdit` and names the command that
  writes it, and it refuses by name the six kinds this application has no command for. The
  delegate's `check` runs `decideGenEdit` locally rather than `stack.check` over IPC, because
  path.ux's check is synchronous and runs once per frame per pointer move while `command:check` is
  an async round trip. Both sides run the same decision function, so the mid-gesture verdict
  matches the verdict on commit. A refused gesture says its refusal, except a refused drag, which
  path.ux already shows by fading the frame it would not move.
  - A drag is applied to the graph on screen as well as sent, because the view resyncs its frames
    from `node.pos` the moment `perform` returns. Every other gesture waits for the reload `exec`
    triggers, so the pane always draws what the file holds. A property write is the exception,
    described below.
- **Delete and duplicate open a checkpoint**
  (`command-system.md#checkpoints-group-several-commands-into-one-undo-point`), so a multi-node
  selection lands as one undo point instead of one per node: the delegate's
  `undoStepBegin`/`undoStepEnd` — widened in `vendor/path.ux` to a real `Promise<void>`, taking the
  gesture's label and message — open and close it, and `send` tags its `exec` calls onto the open
  handle. A refused open dispatches nothing, since path.ux's `AsyncGateOp` skips the gesture's
  callback when the bracketing hook throws; a refused close can follow edits already applied
  optimistically to the graph on screen, so it forces a reload the same way a refused write does.
- **Node properties are bound through a data API scoped to this pane.** `defineGraphApi` builds a
  `DataAPI` rooted on one member — the graph on screen — and the editor installs it through
  `ctx.override({api})` at `init`, one per instance, because two panes may be open on different
  slugs and one member cannot answer for both. The app-wide API in `renderer/pathux/api.ts` is
  unchanged and still defines nothing for graphs. With the view pointed at `graph`, path.ux's
  `NodeFrame` builds the prop rows itself, and an unconnected input's editor sits on the socket's
  own row; connecting the socket removes it.
  - Every bound write is heard through a `change` listener per property, judged by
    `decideGenEdit`, and sent as the command that writes it. A refused write is put back through
    the same API rather than prevented, because `change` is a notification and cannot veto.
  - `active` on an output binds as a checkbox: ticking sends `gengraph.setActiveOutput`, which
    stands the rivals claiming its slot down, and unticking sends a plain
    `gengraph.setProp active=false`. A graph whose outputs are all inactive is a legal state, and
    the strip above the canvas says the slot falls back to the built-in runner.
  - Every bound property is declared `PropFlags.NO_UNDO`, so path.ux's own datapath undo never
    sees a write the app's undo stack already holds, and it carries a `uiname` and a `description`
    so each row is labelled and tooltipped from the declaration. `readGraphFile` restamps all
    three after a read: nstructjs serializes a property whole, so a file written before those
    fields existed loads carrying empty ones.
- **A pane does not reload on its own property write.** A successful mutating command invalidates
  every listener, which would rebuild the graph under the widget being typed into. The pane arms a
  one-shot skip from an `onExec` watcher, which runs immediately before the invalidation the same
  `exec` raises, and matches the outcome to what it sent by the four props a `gengraph.setProp`
  carries — so a second pane open on the same graph still reloads. Only `setProp` is skipped,
  because it is the only edit whose local and written results come from the same `decideGenEdit`.
- **An edit here redraws what the graph draws.** A gesture that changes the authored graph spends
  nothing when it is made, and the next `pipeline.run` puts the bound slot's task back to `pending`
  and draws it again — so a picture can change without the author naming it, and the run's
  notification says how many were redrawn for an edited graph. The task's hash does not move,
  because the graph is the slot's runner rather than part of what the slot is. Undoing the edit
  before the next run leaves nothing to redraw, since the journal the comparison reads sits under
  `state/`, which undo excludes.

## Play

`editors/play.ts` — the runner. `pathux/play/playback.ts` is the pure half (frames, navigation, the
save blob) with sixteen tests beside it. The stage is deliberately raw DOM inside the column frame,
with path.ux widgets only for the chrome above it: a VN frame is a background, a portrait and a text
box, none of which is a control.

- **Live, no file needed.** The renderer calls the `story:play` IPC channel; the main process
  builds the playable in-process from the loaded model + store (`session.playable()`).
- **Image delivery — `vnasset://`.** A privileged custom protocol (registered in
  `src/main/index.ts`) resolves `vnasset://<hash>.<ext>` against **both** asset roots, in the order
  `AssetStore` reads them: base art (`assets/objects/`) first, then shot frames
  (`vngen/build/assets/`) — [`asset-stores.md`](asset-stores.md). So `<img src="vnasset://…">`
  loads content-addressed bytes wherever they live, which is what lets Documents draw a portrait
  and Play draw a frame through one path. This is the app's only image path.
- **The frame carries its shot, so Play stops being a dead end.** `show` beats gained an optional
  `shot` field (`@vn/types`, `@vn/export`), `framesOf` carries it down the frames between shot
  changes, and the editor publishes `ui.sceneId`/`ui.shotId` as the playthrough moves — so every
  other pane follows along. The React runner never did this; it is the one behavioural gain of the
  port, and it is why the schema changed. The push happens only when the playthrough itself moved,
  which is what keeps a redraw from writing the played position over a scene the author has just
  selected somewhere else.
- **The same two fields are followed the other way.** A scene or a shot picked in the document tree,
  in Shot Coverage or in the task graph jumps the playthrough to it: `jumpTo` finds the first frame
  the named shot drew, or the scene's first frame when no shot is named. The jump is pushed onto the
  navigation stack rather than replacing it, so Back retraces it the way it retraces a choice. A
  scene the playable does not have is said in the bar rather than followed — the playable is built
  from the model as it stands, so a scene with no beats yet is an ordinary pre-run state. Opening the
  pane starts on the shared selection for the same reason, falling back to the story's own start.
- **A new or re-rendered shot re-reads the playable.** The pane watches `onInvalidate` and comes
  back on screen re-reading, because the playable is built rather than read from a file and nothing
  else would tell it a shot had been made. The position holds across the re-read: a `show` beat folds
  into the line after it, so shot changes change which image a frame carries rather than how many
  frames a scene has. A scene that has gone since is the one case that starts the story over.
- **No portrait over the shot unless the project asked.** A shot prompt names its own subjects,
  so the frame already shows the cast; the speaker's portrait is staged over it only when
  `story.play.json` says `portraitOverlay`, from `project.yaml`'s `portrait_overlay` —
  [`playable-format.md`](playable-format.md#contracts).
- **Playthrough.** State is a navigation stack (`{ sceneId, frameIndex }[]`, last = current):
  click / Space / Enter / → advances a beat; at scene end it shows choice buttons or auto-follows
  `next`; a leaf scene shows "The End". ← / Backspace rewinds. **Save / Load / Reset** persist the
  stack to `localStorage`, keyed by workspace title. The keys are the area's keymap, which runs
  ahead of the screen's and after path.ux's own textbox guard — so the React runner's tag-sniffing
  has nothing left to do.
- **A missing playable is a sentence on the stage, not a crash.** No project open, or one with no
  generated art, is an ordinary state for an author to read and act on.

## Asset

`editors/asset.ts` — one generated asset: the bytes, the prompt that made them, and the art notes
that would make them differently. Its subject is `ui.assetHash`, which the documents tree publishes
when an asset leaf is clicked; the rules on top of it (which approve command applies, the badges,
the failure and drift notes, which prompt to show) are pure in `renderer/rules/assetview.ts` with tests beside
them. Plans: [`../plans/archive/INDEX.md#asset-names-and-the-asset-editor`](../plans/archive/INDEX.md#asset-names-and-the-asset-editor)
and [`../plans/archive/INDEX.md#on-demand-concept-images`](../plans/archive/INDEX.md#on-demand-concept-images).

`art.generate(sentence=…)` is the other way in: it draws a concept and, unless told not to, opens
it here — so asking for a picture ends looking at it. `art.redraw` does the same with the sketch
it produces.

- **The prompt is drawn as the clauses it is made of.** Each `PromptChunk` the builders derived is
  one card, in the order it is sent, tagged with its category and voiced by where it came from —
  `--sodium` for a sentence an author wrote somewhere, `--signal` for scaffolding the builder
  supplies. A card can be muted, replaced, appended to, or dragged to another position, and one that
  came from a document offers a `⇱` to it. The art notes are still the append-only half beside it,
  and both are authored input: setting either re-keys the task, so "regenerate" is the pipeline that
  already exists rather than a second path to the image model. See
  [`../plans/archive/INDEX.md#chunked-prompts`](../plans/archive/INDEX.md#chunked-prompts).
- **A reference image lives on the card of the clause it is evidence for.** Under each card is a
  strip of thumbnails (`vnasset://<hash>.<ext>`); a click opens that picture `elsewhere` — this pane
  is showing what the reference is *for* — and `×` runs `prompt.dropRef`. A chip on a muted clause is
  drawn muted with it, because muting the clause stops sending its references too, and one whose
  slot has moved is marked `drift`. `asset.upload` brings an outside image in; `prompt.addRef` takes
  either its hash or a slot address (`plate:cafe/night`).
- **A suspended asset says what moved rather than re-rendering.** The `suspended` badge and
  `driftNote`'s sentence come before the ordinary staleness one, because it is the stronger claim:
  the words may still be right and a picture this was drawn *against* is what changed.
  `prompt.repin` clears it, and `regenerate=false` keeps the bytes.
- **A picture the pipeline gave up on says why, in the pane showing it.** `AssetInfo.failure` is
  read off the slot's identity as the project states it today, and off `asset.sourceTask` only when
  that identity is not terminal. The two part company after an art-notes edit: the slot re-keys, a
  run fails on the new task, and the last good render is still what is on screen — so the band says
  a re-render failed and names the frame the author is looking at, and `driftNote` stands down,
  because the failure already reports that the project has moved on. `failed` quotes the
  retry budget (`config.max_task_attempts`) against the attempt records that carry an error;
  `needs_human` does not, since a P7 refine pass records an attempt without one. **Show task**
  opens the task that gave up, which is not always the one these bytes came from.
- **Regenerating a failed re-render asks for that render rather than the one on screen.** An
  authored change re-keys the slot, so the pipeline re-renders it as a matter of course: a fresh
  node is planned with a retry budget of its own, and that is how a failed or flagged picture is
  normally recovered (packages/pipeline/src/tests/rerender.test.ts). One edit does not get that.
  An edit that lands the slot back on an identity which already spent its budget finds it terminal,
  because `requeueFailed` counts a task's error-carrying attempts for the life of the project.
  `asset.regenerate` is what asks again. It refuses a `stale` asset, whose own task is an orphan,
  except when the slot's current identity is `failed` or `needs_human` — then it queues that task,
  and the picture on screen stays until the new render lands.
- **Regenerate offers the run rather than reporting the refusal.** A stale asset's own task is an
  orphan, so `asset.regenerate` refuses it — but the picture the author asked for is already
  planned, as the fresh task the re-key produced, and a pipeline run is what reaches it. The button
  opens `pipeline.run`'s own dialog on that case, with the dry-run box unticked and a note saying
  why it opened and why the box is filled in that way. What the author confirms is therefore the
  work and its cost rather than a sentence telling them to go and find the command. `regenerateAction`
  in `renderer/rules/assetview.ts` picks between the two acts and writes the button's tooltip, since
  one label now covers both; its order mirrors `regeneration` in `main/session.ts`, failed re-render
  first. The refusals that need the graph — an asset recording no task, base assets unavailable —
  are left to the command, which is the only side that can see one.
- **The mode strip says which text is actually being sent** — the clauses, a prompt the author wrote
  by hand, or one the agent condensed. Condensing is a button beside it; a condensation whose
  clauses have since moved is **held**, and the banner over the cards says so rather than the pane
  quietly re-rendering the picture. `prompt.check`'s answer rides along: a clause a custom or
  condensed prompt no longer appears to say is marked, as a prompt to look rather than a verdict.
- **A reorder is judged on the grab.** `promptReorder.targets` runs once when a card's rail is
  grabbed and every pointer move is a lookup, so the insertion rule and the sentence in the footer
  are the verdict the drop would actually get; nothing moves until pointerup. `Alt+↑`/`Alt+↓` runs
  the identical lookup without the pointer.
- **A concept has no builder under it, so it gets a box rather than cards.** Nothing derives it, nothing rewrites
  it, and no task hash contains it — it is a root asset, so the pane gives it a Redraw box holding
  the recorded prompt whole (the style preamble and the framing sentence survive an edit by
  default) and `art.redraw` draws it again as a **new** sketch beside the original. The header bar
  carries **Redraw** in place of Approve and Regenerate rather than greying them out: a concept is
  approved by nothing and planned by nothing, so neither could ever act on one, and a dead pair
  beside a working button reads as breakage.
  `promptEditable` in `renderer/rules/assetview.ts` is the one rule both halves read, and its
  refusal for a derived kind points at the clause cards as the way to move that prompt instead.
- **One box per rung that actually applies**, widest first: the character or location, then the
  outfit or variant, then the shot. Each commits on Ctrl+S or on leaving the box, through
  `art.setNotes` with the tree's own `kind:key` target vocabulary — so the same edit is reachable
  from the palette, from CDP and (for the entity rungs) from `vnauthor`.
- **It shows what is derived today, not only what was recorded.** `asset.info` re-derives the prompt
  for the same binding and compares it with the one the bytes carry; a difference is the `stale`
  badge and a banner, which is exactly the state an art-notes edit leaves behind until the next run.
- **Approve says which command it would run.** A portrait goes to `gate.approve`, because that is
  the command that also writes `character.md` and `approved.png`; everything else is the generic
  `asset.accept` across both roots. A portrait whose character the project has lost is **refused by
  name** rather than accepted through the generic door, and so is a concept: nothing downstream
  consumes one, so there is no question for accepting it to answer. An **upload** is the mirror of
  that case — a concept has no downstream, an upload has no upstream — so the bar reads `uploaded`
  where the pair would be: nothing generated it, so there is no work to bless and no task to requeue.
- **Approval flows upstream first, and the frontier is drawn under the picture it belongs to.** A
  **DRAWN FROM** strip lists `AssetInfo.prereqs` — everything these bytes rest on, in the order the
  task fed them to the model — each row saying whether it stands. While any is pending, Approve is
  greyed and its tooltip is the refusal *verbatim*; the strip repeats the same sentence out loud, so
  nobody has to hover a disabled button to learn which row is holding it up. The sentence is main's:
  `previewAccept` refuses `asset.accept` with the identical one, because a greyed button the command
  itself would honour is a lie about the rule, and the palette, the agent and CDP all reach the
  command directly. **This is deliberately not the reference strip**: that lists the bytes pinned to
  one prompt clause — evidence, per clause, detachable, opened *elsewhere* because it is a second
  thing to look at. This lists what the whole picture rests on; nothing detaches, and a click
  retargets **this** pane, because the job is to walk up the chain approving as you go and a new pane
  per hop litters the mesh. One `← back` chip makes that walk reversible, and it clears itself when
  the subject changes any other way. A prerequisite whose bytes the manifest has lost is a disabled
  row whose tooltip is its own refusal.
- **Accept on an older take puts it back, not just a flag on it.** `asset.accept` writes one bit of
  the manifest, and the slot's task goes on naming the later render — so on a take something
  replaced, the click would appear to do nothing while the runner and the exporter carried on with
  the newer picture. `approveAction` routes a take with a `newerTake` to `asset.restore` instead,
  which is `asset.adopt(replace)` followed by `asset.accept` as one confirmed act. The take that had
  the slot becomes the older one, in the store and named by `newerTake` from the other side. The
  prompt these bytes were drawn from is **kept** rather than restamped with the slot's current one
  (`AdoptSlotRequest.keepPrompt`), because a picture drawn before today's words has drift and
  claiming otherwise would hide it. A portrait is left out by name — an earlier look goes back
  through `gate.approve` — and the suspension and upstream-approval refusals are the ones accepting
  would have given.
- **Download writes the bytes out of the store.** `asset.export` asks the host for a path through
  `saveFile`, then copies the picture there; it reads the project and writes nothing back, so it is
  not `mutating` and takes no confirmation. The offered name comes from `downloadName` in
  `apps/desktop/src/shared/assetfile.ts`, which strips the characters a filesystem refuses, trims a
  trailing dot or space, caps the length, and falls back to the short hash when the label survives
  none of that or is a name Windows reserves. The button sits beside Task in the asset editor's
  header, and the same act is on the document tree's asset menu, below the separator with the other
  entries that leave the project alone.
- **A concept gets a Promote strip instead, and only a concept does.** It names the location the
  sketch is bound to, takes a variant id, and runs `art.promote` — the variant joins that location's
  sheet if it is new, the bytes become the plate, and the next run adopts them. `promoteAction`
  decides whether the strip is drawn at all, so a character concept never offers a control that
  would walk around the approval gate. What is half-typed there survives a background refetch of the
  same asset and is dropped when the pane moves to another one.
- **A picture the project planned gets a Replace strip, and the slot is never typed.** An author who
  paid someone to clean a frame up has bytes better than any run will produce, so
  `asset.replace(hash=…)` opens an image chooser and makes what comes back that slot's output —
  `asset.upload` and `asset.adopt` as one act, with the slot read off the asset on screen rather than
  spelled by hand. `AssetInfo.slot` is what the strip is drawn from, and it means "the slot these
  bytes fill **now**": absent on a concept and an upload (nothing plans those), and absent again once
  a later render has taken the slot over, so a superseded picture never offers to supersede the one
  that replaced it. `replaceAction` declines a `portrait:` slot by name — replacing a look is
  approving one, and that is `gate.approve`'s — which is `adoptionForSlot`'s `GATED_SLOT` said as
  layout. The hint says what it costs: the render it stands in for keeps its bytes in the store, and
  the next run adopts the author's picture instead of drawing one. Nothing is auto-accepted, and the
  pane moves to the new hash afterwards, because the bytes it was showing are no longer the slot's.
  See [`../plans/archive/INDEX.md#adopting-an-uploaded-asset`](../plans/archive/INDEX.md#adopting-an-uploaded-asset).
- **Show task hands off rather than duplicating.** `ui.taskHash` is published and the inspector is
  opened `elsewhere` — attempts, the refine loop and the reviewer's verdict are its subject, and
  this pane does not re-render them.
- **A write anywhere re-reads, unless a box is dirty.** `onInvalidate` covers this pane's own edit,
  the agent's, and an undo of either; a refetch under a half-typed note would eat it, so an
  in-progress rung suppresses it until it commits.
- **The pane follows its slot forward.** `AssetInfo.newerTake` names the asset filling this one's
  slot when it is not this one, and `watchSlot` moves the pane onto it, so a run that lands a new
  render while the author is watching shows the new picture rather than the frame it replaced. Only
  the take that held the slot follows: an author who walked back to an earlier one asked for that
  one. Which take that is is decided when the pane arrives on an asset and then kept, because an
  authored edit re-keys the slot and empties it until something renders, and inside that window
  every take alike reports no newer one. A pinned pane never follows, which is what the pin is for.

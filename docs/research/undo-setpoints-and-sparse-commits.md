# Gesture-scoped undo and git-commit cadence in the desktop app

<!-- toc -->

- [Recommendation](#recommendation)
- [1. Which surfaces emit more than one command per gesture](#1-which-surfaces-emit-more-than-one-command-per-gesture)
  * [The Gen Graph pane, measured in both directions](#the-gen-graph-pane-measured-in-both-directions)
  * [Shot Coverage, measured](#shot-coverage-measured)
  * [The raw-DOM editors](#the-raw-dom-editors)
  * [The agent is the one host that does send runs of commands](#the-agent-is-the-one-host-that-does-send-runs-of-commands)
- [2. The `realtime` story](#2-the-realtime-story)
  * [Where it is resolved today](#where-it-is-resolved-today)
  * [Whether it should be the app-wide default](#whether-it-should-be-the-app-wide-default)
  * [What suppressing the datapath write costs](#what-suppressing-the-datapath-write-costs)
  * [The assignment-order hazard](#the-assignment-order-hazard)
- [3. Setpoints, and why none is warranted](#3-setpoints-and-why-none-is-warranted)
- [4. Git-commit cadence](#4-git-commit-cadence)
  * [What ships](#what-ships)
  * [The case for a coarser policy](#the-case-for-a-coarser-policy)
  * [What a minutes-long commit does to the trailers and to `commands.jsonl`](#what-a-minutes-long-commit-does-to-the-trailers-and-to-commandsjsonl)
  * [Recommendation on cadence](#recommendation-on-cadence)
- [4a. The reload is the term nothing batches](#4a-the-reload-is-the-term-nothing-batches)
- [5. The Undo button's freshness](#5-the-undo-buttons-freshness)
- [6. Whether the snapshot backend still needs to be git](#6-whether-the-snapshot-backend-still-needs-to-be-git)
- [7. Sizing](#7-sizing)
- [8. What this does not propose](#8-what-this-does-not-propose)
- [9. How this was measured](#9-how-this-was-measured)
  * [Scaffolding worth keeping](#scaffolding-worth-keeping)
- [10. Unverified](#10-unverified)

<!-- tocstop -->

## Recommendation

**Do not build gesture-scoped undo. There is no gesture left that needs it.** The premise this
investigation was given — that several editors send a mutating command per pointer frame and so
leave a run of undo points against one batched commit — is false as of the commits measured on
2026-08-27. Every surface in the app now sends exactly one mutating command per authorial act,
and it is one command because two independent mechanisms already put it there: path.ux's
`NO_REALTIME` packflag for the one editor built from bound widgets, and a hand-written
commit-on-release discipline everywhere else.

That is measured rather than inferred. A five-keystroke edit in the Gen Graph pane sends one
`gengraph.setProp`; the same edit with `realtime` forced back on sends five, each its own undo
point and each costing about 900 ms. A twenty-move Shot Coverage gutter drag sends nothing until
release and then one `story.newShot`.

The second axis is genuinely open, and the recommendation there is **no** as well, for a
different reason. A coarser commit policy is buildable and would reduce commit count, but the
cost it would remove is already a small term in an edit, the current 1500 ms idle batch already
collapses a typing run into one commit, and every coarsening widens the window in which a crash
loses work. The measured wins in this area are elsewhere and are already written up in
[`git-library-vs-git-process.md`](git-library-vs-git-process.md).

The term that is neither small nor batched is the Gen Graph pane's reload
([§4a](#4a-the-reload-is-the-term-nothing-batches)). Every mutating command invalidates, and the
pane answers by re-reading its whole file and rebuilding every widget — 152 ms on a two-node
graph, 434 ms on a twenty-three-node one, once per command and skipped only for a `setProp` the
pane itself sent. It is the one cost in an edit with a growth curve, no commit policy affects it,
and on a twenty-three-node graph it is comparable to the undo journal's two `capture` calls, which
are the largest term that is paid on every edit.

What is worth doing is small and is listed in [§7](#7-sizing): a scripted check that fails when a
datapath-bound widget resolves `realtime` true, so the one-command-per-gesture property stops
being a fact somebody has to rediscover.

## 1. Which surfaces emit more than one command per gesture

None.

The survey below covers every place the renderer calls `exec`
(`apps/desktop/renderer/pathux/bridge.ts:179`), which is the single path every mutating surface
takes. Non-mutating commands are excluded throughout: they neither snapshot nor commit
(`packages/commands/src/stack.ts:194`, `:214`), and they do not join or flush a batch.

### The Gen Graph pane, measured in both directions

The Gen Graph pane is the only editor in the app that binds widgets to a datapath. Its widgets
are built by path.ux from a scoped `DataAPI` over the live graph, and the pane sets
`this.view.inherit_packflag |= PackFlags.NO_REALTIME` at
`apps/desktop/renderer/pathux/editors/nodes.ts:145`.

Read out of the running app, every bound widget in the pane is a `textbox-x` and every one of
them resolves `realtime` false with `packflag` 262144, which is `1 << 18`:

```
[{"t":"textbox-x","p":"graph.nodes[0].props['prompt'].value","rt":false,"pf":262144},
 {"t":"textbox-x","p":"graph.nodes[0].props['refine'].value","rt":false,"pf":262144},
 {"t":"textbox-x","p":"graph.nodes[0].props['model'].value","rt":false,"pf":262144},
 {"t":"textbox-x","p":"graph.nodes[0].props['aspect'].value","rt":false,"pf":262144},
 {"t":"textbox-x","p":"graph.nodes[0].props['seed'].value","rt":false,"pf":262144}]
```

There is no `numslider-x` anywhere in the pane, because no node type in `@vn/gengraph` declares a
numeric property — every bound prop on a `GenImage` node is a string. The slider half of the
`realtime` mechanism therefore governs nothing in this app today, and the textbox half governs
these five widgets.

Driving a real edit through CDP — click into the prompt field, type three characters, press
Enter — and counting lines in `vngen/state/commands.jsonl` before, during and after:

```
{"before":15,"afterClick":15,"afterTyping":15,"afterEnter":18}
```

Three lines, of which exactly one is mutating:

```
16 gengraph.setProp {"slug":"probe","node":"0","key":"prompt","value":"XYZ"} ok DEFERRED undo:true
18 view.layouts {} ok  no-undo
17 project.pagesStatus {"branch":"gh-pages"} ok  no-undo
```

`view.layouts` and `project.pagesStatus` are background reads the header issues off the
invalidation. Neither snapshots and neither commits.

The counterfactual pins what `NO_REALTIME` is worth. Setting the `realtime` attribute back to
`true` on the same widget (an explicit attribute wins over the packflag,
`vendor/path.ux/scripts/core/ui_base.ts:285-310`) and typing five characters:

```
forced realtime=true on 1 widget(s)
resolves realtime = true
{"before":18,"afterTyping5":19,"afterEnter":24}
```

Five `gengraph.setProp` commands for five keystrokes, each with its own undo point, each about
900 ms of `exec`:

```
16 "XYZ"       856ms undo=true     <- the NO_REALTIME run above, for comparison
19 "XYZA"      853ms undo=true
21 "XYZAB"     935ms undo=true
24 "XYZABC"    928ms undo=true
28 "XYZABCD"   929ms undo=true
29 "XYZABCDE"  962ms undo=true
```

So the shipped state costs one snapshot pair and one undo point where the alternative costs
five of each, and the mechanism that gets it there is one line in `nodes.ts`.

Two details of the path.ux side are worth writing down, because both look like bugs on a first
read of the source and neither is one.

`NumSlider.on_pointermove` calls `setValue(startvalue + dvalue, false, realtime, true)`
(`vendor/path.ux/scripts/widgets/ui_numsliders.ts:636`). The signature is
`setValue(value, fire_onchange = true, setDataPath = true, checkConstraints = true)` at `:508`,
so a non-realtime drag suppresses both the datapath write and the change event, and there is
nothing for the command stack to batch because nothing is sent.

On release the slider fires twice. `on_pointerup` calls `cancel(false)`, which for a
non-realtime widget runs `setValue(this.value, true, true, true)` at `:694` — a write plus a
fire — and then calls `fire()` again at `:659`. That does not produce two commands, because the
Gen Graph pane's write seam is a `change` listener on the `ToolProperty` itself
(`nodes.ts:411`) and `onPropWrite` returns early when the value equals the one it last sent
(`nodes.ts:437`). The guard is what absorbs the double fire. Anything that adopted the
`realtime` mechanism without an equivalent guard would send two commands per release.

### Shot Coverage, measured

`apps/desktop/renderer/pathux/editors/timeline.ts` is the raw-DOM `appendSurface` editor that
holds `drag`, `reorder` and `create` gesture states, and it was the case this investigation was
told to expect trouble from. It is already one command per gesture.

The gesture is judged in full at the moment the handle is picked up. `grabEdge`, `grabShot` and
`grabGutter` each call `targets(...)` once and cache a verdict per insertion point
(`apps/desktop/renderer/pathux/timeline.ts:76`, `:92`, `:107`) — the doc comment on `grabEdge`
says so outright: "one call rather than one per pointer move". `aimDrag`, `aimReorder` and
`aimCreate` (`:121`, `:145`, `:134`) do nothing but look up the cached verdict for the row under
the pointer. The pointermove handler at `timeline.ts:794-802` re-aims, recomputes a notice, and
repaints an overlay. It sends nothing. The one dispatch is `this.run(pending.verdict.invoke, …)`
in `onUp` at `:830`.

Driving a gutter sweep — one press and twenty moves across the strip, counting after every
single move:

```
gutter cells: [{"x":28.1,"y":366.45},{"x":28.1,"y":448.95},{"x":28.1,"y":499.95}]
{"before":34,"afterDown":34,"afterMoves":34,
 "duringMoves":[34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34],
 "afterUp":35}
```

Twenty-one pointer events, zero commands, then one on release:

```
35 story.newShot {"scene":"arrival","lines":"arrival:L1","framing":"medium","subjects":""} ok MUT commit 800ms
```

The preview during the gesture is drawn over the committed strip and never applied to it
(`timeline.ts:848-851`), so there is no intermediate state that has to persist and nothing to
survive an interruption: an interrupted gesture loses a ghost overlay and nothing else.

### The raw-DOM editors

Every other editor is raw DOM in an `appendSurface` root, and they reach `exec` from discrete
acts — a button, a menu entry, a drop, an explicit save. The pattern used for text fields is
consistent and is the hand-written equivalent of `NO_REALTIME`: the `input` event marks the field
dirty and nothing else, and `blur`, `Enter` or `Ctrl+S` sends the command.

- The Asset pane's prompt boxes: `input` sets a draft and adds a dirty key
  (`apps/desktop/renderer/pathux/editors/asset.ts:1022`), `blur` commits (`:1034`), `Ctrl+S`
  commits (`:1027`).
- The same pane's seed field: `input` marks dirty (`asset.ts:1316`), `Enter` and `blur` commit
  (`:1319`, `:1327`).
- Document editors go through `DocBuffer`, whose header states the rule — "Saving is an explicit
  act, so an unsaved buffer is a real one" (`apps/desktop/renderer/pathux/docbuffer.ts:9`) — and
  whose only mutating call is `doc.write` from `save()` (`:51`, `:191`).
- The command palette's form calls `check` per edit, never `exec`; `exec` waits for the Run
  button (`apps/desktop/renderer/pathux/commandform.ts:198`, `:238`).

### The agent is the one host that does send runs of commands

`archive/deferring-commit-on-save.md` §Stage 0 identifies the agent's tool loop as the one host
that issues mutating commands back to back. That is a run of separate authorial acts rather than
one gesture, each of which the author should be able to undo on its own, so it is not what a
gesture setpoint would be for.

## 2. The `realtime` story

### Where it is resolved today

`UIBase.realtime` (`vendor/path.ux/scripts/core/ui_base.ts:285`) resolves in four steps: an
explicit `realtime` HTML attribute wins; otherwise `packflag & PackFlags.NO_REALTIME` (`1 << 18`)
makes it false; otherwise `PropFlags.NO_REALTIME` on the datapath property makes it false;
otherwise it is true. Containers propagate the packflag through `inherit_packflag`.

Across the whole renderer, `NO_REALTIME` is written in exactly one place —
`editors/nodes.ts:145` — and it is the only place it needs to be written, because the Gen Graph
pane holds every datapath-bound widget in the app. Grepping the renderer for `datapath`,
`.prop(` or `setPathValue` outside `nodes.ts` and the test folders returns one hit, and that hit
is a comment. The shell's own `DataAPI` describes `ShellState` and nothing else, deliberately
(`apps/desktop/renderer/pathux/api.ts:7-11`), and no widget binds to it.

Widgets elsewhere in the app do resolve `realtime` true — the header's `iconcheck-x` and
`dropbox-x` widgets, the palette's search box, the command form's fields, the task list's
filters. All of them are built with an `undefined` datapath and a plain callback, so `realtime`
governs nothing about them: there is no path to write to and no gesture that would write
repeatedly.

### Whether it should be the app-wide default

It should stay opted into, but the opt-in should stop being unenforced.

Making it the default would mean finding a container that every future bound widget descends
from and setting `inherit_packflag` on it. This app has no such container. Its editors are raw
DOM surfaces hosting occasional path.ux bars, and the Gen Graph pane's `NodeGraphView` is
parented to a bare `div` inside one of them (`nodes.ts:143-151`). A root-level default would
have to be threaded through each editor's own construction, which is the same number of lines as
the current per-host assignment and adds a place for it to silently not apply.

`PropFlags.NO_REALTIME` on the property is the other candidate and is the wrong lever here. The
gen graph is the only place the app uses datapath properties, its properties are built by
`@vn/gengraph`'s node definitions rather than by the pane, and the pane already handles
non-realtime mode. Setting the flag per property would move one line into every node type.

What is missing is a test. The property "no datapath-bound widget in this app resolves `realtime`
true" is currently maintained by one line that nothing checks, in a file where a refactor that
reorders two statements would break it without any visible symptom. [§7](#7-sizing) proposes the
check.

### What suppressing the datapath write costs

Suppressing the write suppresses everything downstream of it, not only the command. During a
non-realtime gesture the model value does not move, `change` does not fire, and any node
evaluation or derived display driven off that write stays on the previous value until release.

In the Gen Graph pane that costs nothing today, and it is worth saying why rather than assuming
it. The pane's only reaction to a bound write is `onPropWrite` (`nodes.ts:432`), which sends the
command; the only other thing a write can change on screen is the strip above the canvas, which
`paintState` (`:280`) redraws from which output is active and which slot it claims — neither of
which a textbox edit touches. There is no live cost estimate, no live preview, and no price that
follows a value as it changes.

A surface that did want live feedback would have to get it from the widget rather than from the
datapath: `NumSlider` still redraws itself every pointermove (`ui_numsliders.ts:648-649`) and
still holds the in-flight value in `this.value`. What it loses is anything that reads the model.
A future editor wanting a number that updates a derived figure as it is dragged should read the
widget's value in its own handler, not re-enable `realtime`, because re-enabling it restores the
five-commands-per-five-keystrokes behaviour measured above.

Escape is worth noting as part of the same mechanism: `cancel(true)` restores the start value
(`ui_numsliders.ts:692`), and a non-realtime gesture has written nothing to restore from, so an
abandoned gesture leaves no record at all. That is the behaviour a setpoint would otherwise have
had to implement.

### The assignment-order hazard

`inherit_packflag` has no flush semantics. A widget reads it when its own `_init()` runs, so an
assignment made after that point silently does nothing and the failure looks like the feature
not working rather than like a mistake. `nodes.ts` gets this right — `:145` assigns, `:156`
calls `this.view._init()` — and the eleven lines between them are the reason a check is worth
having rather than a comment.

## 3. Setpoints, and why none is warranted

A setpoint is an explicit begin/end that crosses from the renderer to main and brackets a run of
commands into one undo point. It is worth building only for a gesture that must persist
intermediate state, either because a live preview is computed in main or because the gesture has
to survive an interruption.

Neither condition holds anywhere in this app.

- Shot Coverage computes its preview entirely in the renderer from a verdict map cached at grab
  time, and paints it as an overlay that is never applied to the strip
  (`timeline.ts:794-802`, `:848-851`). Main is not consulted during the gesture; the measurement
  in [§1](#shot-coverage-measured) counts zero IPC round trips across twenty moves.
- The Gen Graph pane's gestures already commit once. A node drag is a modal `NodeMoveModalOp`
  carrying `UndoFlags.NO_UNDO` that dispatches one undoable op through the view's delegate on
  release (`vendor/path.ux/scripts/editors/nodeeditor/gesture_ops.ts`, and the modal-drag rule in
  `vendor/path.ux/CLAUDE.md`). A bound-widget edit commits once by `NO_REALTIME`.
- No gesture anywhere writes to disk before it ends, so there is nothing on disk for a crash, a
  workspace switch or an `undo()` to find half-finished. The three questions a setpoint design
  would have had to answer — what a crash leaves behind, what a workspace switch does to an open
  setpoint, what `undo()` pressed mid-setpoint means — have no subject.

Building the mechanism anyway would mean adding a stateful protocol between renderer and main
whose failure modes are all in the interrupted cases, in service of no caller. It would also have
to be reconciled with the fact that `runCommand` captures snapshots unconditionally
(`stack.ts:194`, `:199`) and the `defers` flag gates only the commit (`:209`), so a setpoint would
need its own suppression of the capture pair and its own decision about what the point's `pre`
is when the first command in the bracket fails.

**What would change this.** A live preview that has to be computed by main — a real
re-render, a model call, a cost that only the pipeline can price — driven per pointer frame. If
such a surface is ever built, the setpoint question reopens, and this section is the record of
why it was closed.

## 4. Git-commit cadence

This axis is independent of the one above and would still stand if the answer there had gone the
other way.

### What ships

One flush is one commit per repo. `defersCommit: true` puts a command's commit into a pending
batch instead (`packages/commands/src/command.ts:89`, gated at `stack.ts:144-150`), and exactly
two commands declare it: `gengraph.setProp` (`apps/desktop/src/main/commands/gengraph.ts:416`)
and `gengraph.moveNodes` (`:469`).

Five things flush a batch, and reading `stack.ts` confirms the list in
[`../reference/repos-and-commits.md`](../reference/repos-and-commits.md):

- a mutating command that does not defer, flushed before it runs rather than before it commits,
  so the flush commit holds the deferred edits and nothing else (`stack.ts:173`);
- `undo()` and `redo()`, through `move()` (`stack.ts:372-375`);
- a workspace switch and quit, both through `dispose()` (`stack.ts:476-480`), with quit holding
  the app open for up to `QUIT_FLUSH_MS = 2000` (`apps/desktop/src/main/index.ts:1121`, `:1138`);
- `BATCH_IDLE_MS = 1500` of idleness, rearmed on every deferring act so the batch is bounded by
  the last one rather than the first (`stack.ts:30`, `:483-492`).

The batch produced by the five-keystroke realtime run above landed as one commit with the
documented trailers:

```
Sets 'prompt' on the Generate image node to "XYZABCD… (and 4 more edits)

Vn-Batch: 5 seqs 19,21,24,28-29
Vn-Seq: 29
Vn-Command: gengraph.setProp
Vn-Source: ui
```

The earlier single edit committed on its own, because more than 1500 ms elapsed before the next
one. So the mechanism already collapses a typing run and already leaves a pause alone.

### The case for a coarser policy

The proposal on the table is a policy measured in minutes rather than in a second and a half: an
interval, an explicit "commit now", and hard ceilings at undo, redo, workspace switch and quit.
It is buildable — the ceilings already exist, and widening the interval is a constant — and it
would reduce commit count in a session of continuous editing.

Four things argue against it.

**The per-edit commit cost is already gone, so the remainder is what a longer interval competes
for.** Stage 0 of `archive/deferring-commit-on-save.md` measured `Committer.commit` at 229 ms of a
968 ms `exec`, which is the 23% figure usually quoted for it — but that was measured before
deferral shipped. Stage 5 re-ran the same harness afterwards and recorded `Committer.commit` as
*never called*: a deferring edit pays no commit, and one commit is charged to the whole run. Over
30 edits that removed 211.7 ms per edit and 4.8 of the commit's 5 git subprocesses, the missing
0.2 being the single flush amortized across the run. So a coarser interval is not competing for
23% of an edit. It is competing for one 229 ms commit per flush, which at 30 edits to a flush is
already about 8 ms per edit, and merging flushes together takes a fraction of that.

**Widening the interval moves only the flushes the timer causes, and those are not the ones that
fire during editing.** Of the five flush triggers, one is a timer and four are ceilings. The
ceiling that fires most is the first: any mutating command that does not defer flushes the batch
before it runs (`stack.ts:173`). In the gen graph that is `addNode`, `removeNode`, `link`,
`unlink`, `setActiveOutput` and `delete` — every structural edit, since `defersCommit` is declared
only by `setProp` and `moveNodes`. An author who alternates between typing in a field and changing
the graph's shape therefore flushes on every structural edit whatever the interval says, and a
five-minute window would change nothing about that session. The sessions a longer interval does
change are runs of property edits with no structural edit between them, which is the case the
existing 1500 ms already collapses.

**Making it general is a different change, not a tuning knob.** Extending the benefit past the two
gen-graph commands means marking many more commands `defersCommit`, and each one so marked is a
command whose write sits uncommitted on disk for the length of the window. That has to be decided
per command against what reads the file in the meantime, which is the reasoning that kept the
graph file's own write out of scope in
[`../plans/gengraph-editing-cost-tasklist.md`](../plans/gengraph-editing-cost-tasklist.md).

**Every widening widens the loss window.** A batch that has not flushed is edits on disk and not
in history. A kill, a power loss or an Electron crash during the window loses the attribution,
not the edits: the files are written, so the next flush or the next non-deferring command sweeps
them into a commit with the wrong subject. At 1500 ms that is a nuisance. At five minutes it is a
commit named after one edit that contains an afternoon of them.

### What a minutes-long commit does to the trailers and to `commands.jsonl`

The provenance format degrades gracefully but not silently, and the degradation is the argument's
sharpest edge.

`commands.jsonl` is unaffected: it is written per record from `onRecord`
(`stack.ts:585-592`), a deferred record carries `commitDeferred: true` and no `commits`
(`stack.ts:210-212`), and every act is on its own line whatever the commit cadence. Nothing about
attribution is lost there.

The commit message is where it shows. `commitBatch` takes the last act's subject and appends the
count (`packages/commands/src/commit.ts:120-134`), so a five-minute batch produces a commit named
after whichever edit happened to be last, with "(and 137 more edits)" after it. `Vn-Batch`
carries the count and the hyphenated seq ranges, which stays correct but stops being readable at
that length. `Vn-Command` lists the distinct ids, so a long batch spanning several editors names
all of them and the commit's subject names one. `Vn-Seq` stays a single integer by design, "so a
reader that parses it as a number must not get a range".

None of that is broken. It is a `git log` whose subjects stop describing their diffs, which is
the thing per-command commit-on-save exists to provide.

### Recommendation on cadence

Leave `BATCH_IDLE_MS` at 1500. It is already tuned against the measurement — a serialized edit
costs about 770 ms once the commit is deferred, so 1500 ms is roughly two edits' worth, long
enough that a gesture cannot cross it and short enough that a pause commits. Nothing measured
here argues for moving it.

If commit volume ever becomes the complaint, the cheaper answer is an explicit "commit now" plus
a longer idle interval for the two deferring commands only, which changes cadence without
enlarging the set of writes that can sit uncommitted. An interval-based policy over a broadened
`defersCommit` set is the expensive version and should wait for a complaint that names it.

If *slowness while editing* is the complaint rather than commit volume, this whole section is the
wrong place to spend the effort. The commit has already been taken out of the per-edit path, and
what is left costs about 8 ms an edit against a 434 ms reload the next section measures.

## 4a. The reload is the term nothing batches

An earlier draft of this report left this out, and leaving it out made the cadence argument above
read as more settled than it is. The largest per-act cost in the Gen Graph pane is neither the
commit nor the snapshot pair. It is the pane re-reading its file and rebuilding every widget, it
happens once per mutating command rather than once per flush, it grows with the size of the
graph, and no amount of commit batching touches it.

`bridge.exec` invalidates after every successful mutating command
(`apps/desktop/renderer/pathux/bridge.ts:187`). The pane's `onInvalidate` handler
(`apps/desktop/renderer/pathux/editors/nodes.ts:197-208`) answers that by calling `load()`, which
re-reads the whole graph over the `gengraph:doc` IPC, parses it with `readGraphFile`, and calls
`paint()` to rebuild the view (`:231-253`).

There is one exemption and it is narrower than it looks. `onExec` arms a one-shot `skipReload`
for a `gengraph.setProp` **this pane sent and that came back ok** (`nodes.ts:184-191`), matched by
`setPropKey` on the record's props. Everything else reloads:

- `gengraph.moveNodes` — the other `defersCommit` command, and the one a node drag sends — is not
  in the skip list at all, so every node drag pays a full reload;
- a `setProp` from the palette, from CDP, from the agent, from another window, or from an undo is
  not in `this.sent`, so it pays one too.

Measured against the running app with a counter in `load()`. Eight `gengraph.moveNodes`
invocations produced eight reloads and zero skips. Three `gengraph.setProp` invocations typed into
the pane's own field produced zero reloads and one skip; three of the identical command sent over
CDP produced three reloads and no skips.

The cost grows with the graph, which is what separates it from every other term in an edit:

| node frames | bound widgets | one reload, median |
| --- | --- | --- |
| 2 | 10 | 152 ms |
| 12 | 55 | 308 ms |
| 23 | 115 | 434 ms |

That is roughly a 100 ms intercept — the IPC leg, which includes `readGraph`'s git conflict check
— plus about 13 ms per node for the widget rebuild. `archive/deferring-commit-on-save.md` §Stage 0
established that neither `gitState`, nor the captures, nor the commit grows with project size, and
[§6](#6-whether-the-snapshot-backend-still-needs-to-be-git) confirms a capture is flat. The reload
is the one term with a growth curve.

Against the terms that are actually paid on a deferring edit, that puts it second and closing. The
after column of `archive/deferring-commit-on-save.md` §Stage 5 gives 550 ms for the journal's two
`capture` calls, 110 ms for `gitState()`, 87 ms for the read and the write, and no commit at all.
The reload adds 152 ms to that on a two-node graph and 434 ms on a twenty-three-node one, so it
passes `gitState` immediately and approaches the capture pair by the time a graph is worth
drawing. Comparing it to the commit, as an earlier draft of this report did, compares it against a
term a deferring edit does not pay.

**The commit is not what triggers it, which is worth stating precisely because the correlation is
easy to misread.** A batch flush writes no record and broadcasts nothing: `flush()`
(`packages/commands/src/stack.ts:508-533`) calls `commitBatch` and returns, and the idle-timer
path reaches it through `flushCommits()` without touching `record()`. Driving six deferred edits
and then waiting past `BATCH_IDLE_MS` left the reload counter unmoved while the commit count
advanced. What an author sees as "the commit went through and the editor reloaded" is the next
non-deferring mutating command, which does both — it flushes the pending batch before it runs
(`stack.ts:173`) and then invalidates, which reloads the pane. Measured: the counter went from one
reload to two across a single `gengraph.addNode` that also took the commit count from 7 to 8.

Two consequences for the rest of this report.

**It does not change the setpoint answer.** A node drag already sends one command and so already
pays one reload; a setpoint would collapse a run of commands that does not exist. If anything it
argues the other way — the reload is per command, so the thing that keeps it to one per gesture is
the same `NO_REALTIME` and commit-on-release discipline [§1](#1-which-surfaces-emit-more-than-one-command-per-gesture)
measured, and a surface that regressed to per-frame commands would pay a 434 ms reload per frame
on top of the 900 ms `exec`.

**It does not change the cadence answer either, but it changes what to work on if editing the gen
graph is the complaint.** Widening the commit interval leaves the reload where it is. Two things
would actually move it, both out of scope here and neither costed:

- extending `skipReload` to `gengraph.moveNodes`, which is the same one-shot keyed on the move
  list rather than on `setPropKey` — the pane already applies the move locally before sending
  (`nodes.ts:364-367`), so the reload is echoing back a change the view has already made;
- making the reload incremental rather than whole-file, which is a larger change and is the sort
  of thing `archive/gengraph-node-editor-data-api.md` was already narrowing.

Neither is recommended from this report, because neither was pressure-tested here and the first
one has a hazard the `setProp` path does not: a move applied locally and then refused or altered
by main leaves the view showing a position the file does not have, and `setPropKey`'s equivalent
guard (`onPropWrite` comparing against `watch.last`) has no counterpart for positions.

## 5. The Undo button's freshness

Verified, and it behaves as suspected.

`ui.canUndo` is written in exactly one place in the renderer:
`apps/desktop/renderer/pathux/bridge.ts:296`, from a `command:ui` effect of type `undo`. Main
broadcasts that effect from the stack's `onRecord` hook
(`apps/desktop/src/main/index.ts:740-744`), sampling `getStack().undoState()` at that moment. The
header reads `ui.canUndo` to enable the button (`editors/header.ts:282`). Nothing polls.

So the button learns the state changed if and only if a record was written. Any transition that
changes what `undoState()` would return without producing a record leaves the button stale until
the next command of any kind — including a non-mutating one, since `onRecord` fires for every
record.

Today no such transition exists: `undoState()` is derived from `records` and `undone`
(`stack.ts:307-317`), both of which only move inside `runCommand` or `move`, and both write a
record. Any design that changed the undo stack outside a command — collapsing a run of points
into one after the fact, expiring a point on flush, closing a setpoint — would have to push the
effect explicitly. That is one line at the site that makes the change, but it is a line that is
easy to omit and whose absence shows up as a button that is wrong rather than as an error.

## 6. Whether the snapshot backend still needs to be git

Yes, and the question is already settled in
[`git-library-vs-git-process.md`](git-library-vs-git-process.md). That report inventories every
git call the repo makes, measures the three costs that get conflated (process startup, worktree
scan, object hashing), and recommends against an in-process library — partly because the two
libraries that load in Electron 33 unrebuilt expose no `read-tree`, which is what `Git.applyTree`
is built from.

It also found the thing that actually costs money here, and my own measurement reproduces it
independently. `Git.writeTree` runs `git add -A` against a scratch index file that does not exist
(`packages/git/src/git.ts:95-103`, `:278-283`), so there is no stat cache and every file in the
pathspec is re-hashed on every snapshot, twice per command. Replaying `capture()`'s git sequence
by hand against a project-shaped repo:

| Fixture | one capture, five spawns |
| --- | --- |
| authored tree only, `UNDO_PATHS` | 150.8 ms (add 38.0, write-tree 34.6, rev-parse 24.3, commit-tree 25.0, update-ref 28.9) |
| 2000 × 32 KB assets present, excluded | 150.5 ms (add 40.0, write-tree 34.5, …) |
| the same 2000 assets, included (`['.']`) | 1254.6 ms (add 1066.7, write-tree 111.4, …) |

Two readings. First, the `:(exclude)vngen/build` term in `UNDO_PATHS`
(`apps/desktop/src/main/workspace.ts:48`) is what keeps a capture flat in project size, and it is
load-bearing rather than tidy: dropping it takes a capture from 150 ms to 1255 ms on a project
with 2000 assets, almost all of it in `add -A`. Second, at 150 ms across five spawns of 25–38 ms
each, what is left after the exclusion is process startup. Narrowing the pathspec further buys
nothing, which also means a stat-based fast path in place of the byte-exact `write-tree`
comparison in `UndoJournal.check` (`packages/commands/src/undo.ts:140-165`) would be buying
against the wrong term.

**This report proposes no such fast path.** For the record of what one would cost: `check`
re-runs `writeTree` and compares the result against `treeOf(commit)`, so it answers "is the
working copy byte-for-byte where that command left it" for every file in the pathspec. A stat
comparison answers "does anything look untouched by size and mtime", which gives a wrong answer
for a same-size same-mtime edit — a `git checkout` of another branch, an editor that preserves
mtime, a script that rewrites a file in place within the timestamp's resolution. The consequence
of a wrong "unchanged" here is that `restore` overwrites an edit nobody asked it to discard,
which is exactly the §7 failure the byte-exact check exists to prevent. Not worth it for a term
that measures 35 ms.

The cheap fixes that do pay — seeding the scratch index from the real one, memoizing the
repo-invariant probes, passing the already-fetched `head` into both captures — belong to
`git-library-vs-git-process.md` §5 and are not restated here. The one caveat that report names is
worth repeating because it interacts with `UNDO_PATHS` directly: a copied index carries entries
for `vngen/build` and `vngen/state` that the pathspec excludes, so the seeded index needs those
entries removed before the tree hash matches, and that has to be proved by comparing hashes on a
project with both directories populated.

## 7. Sizing

Two items. The first is the only thing this report recommends building.

**A scripted check that no bound widget resolves `realtime` true.** Half a day. A script in the
shape of `scripts/verify-prompt-chunks.mjs` — one CDP socket, a walk that recurses into shadow
roots, a PASS/FAIL line — that opens the Gen Graph pane, collects every element carrying a
`datapath` attribute, and fails if any reports `realtime` true or a `packflag` without
`1 << 18`. The check exists because the property is real, is measured, is worth about 4 seconds
and four undo points per typed word, and is currently held up by one assignment eleven lines
above the `_init()` that reads it. The walk and the projection are already written, in
[§9](#9-how-this-was-measured).

The same script should assert the count of mutating records a scripted gesture produces, since
that is the claim the check is really about and it is one read of `commands.jsonl` away.

**Everything else: nothing.** No setpoint mechanism, no change to `BATCH_IDLE_MS`, no in-memory
snapshot store, no stat-based drift check, no app-wide `realtime` default.

## 8. What this does not propose

- **Gesture setpoints.** No caller. [§3](#3-setpoints-and-why-none-is-warranted) states what
  would reopen it.
- **Batching undo captures onto the commit window.** This was one half of the deleted work. It
  couples the undo boundary to the commit boundary, which is a coupling with no independent
  justification — the two answer different questions, and the measurement that motivated it
  (that snapshotting is expensive) is answered better by the scratch-index fix, which makes
  snapshots cheap instead of making them rare.
- **An in-memory snapshot store with sparse commits.** The other half. It decouples the same two
  things the first half couples, which is why the two could not be staged in series and why this
  report is one document. Neither is needed once a capture costs 150 ms and can be made to cost
  less without changing what undo can restore.
- **Making `NO_REALTIME` the app-wide default.** No container to hang it on, and one host to
  cover. [§2](#whether-it-should-be-the-app-wide-default).
- **A stat-based fast path for `UndoJournal.check`.** Named guarantee, named failure case,
  measured as competing for 35 ms. [§6](#6-whether-the-snapshot-backend-still-needs-to-be-git).
- **Widening the commit interval.** [§4](#recommendation-on-cadence).
- **Extending `skipReload` to `gengraph.moveNodes`, or making the pane's reload incremental.**
  Both would remove a real cost that no commit policy touches, and both are named in
  [§4a](#4a-the-reload-is-the-term-nothing-batches) rather than recommended: neither was
  pressure-tested here, and the first carries a hazard the `setProp` path does not.
- **Deferring the graph file write.** Already a stated non-goal in
  [`../plans/gengraph-editing-cost-tasklist.md`](../plans/gengraph-editing-cost-tasklist.md), for
  a reason that has not changed: node props feed `nodeHash`, so a pipeline run against a stale
  file returns a dedupe hit and the author sees an instant "done" and the unchanged picture.

## 9. How this was measured

Windows 11, git 2.51, Electron app built from `53aada86`, path.ux at `318dff30`. The app was the
built one (`node scripts/vndesktop.mjs --mock --project <dir>`), driven over CDP on 9222.

The project was a copy of `templates/basic` in the scratchpad, `git init`ed with repo-local
`user.email`/`user.name` and `core.autocrlf false`. Deliberately not `templates/basic` itself:
its committed `vngen/` tree is authored output and fabricated provenance there is worse than no
fixture (`../guides/debugGuide.md`). `git status` in the repo is clean of it.

A graph to edit was made with two commands rather than by hand:

```sh
node scripts/vn-cdp.mjs "gengraph.create(name='probe')"
node scripts/vn-cdp.mjs "gengraph.addNode(slug='probe' type='GenImage')"
node scripts/vn-cdp.mjs "view.open(editor=gengraph)"
```

The pane binds to `ui.graphSlug`, which no command sets, so it was set directly:

```sh
node scripts/vn-cdp.mjs --raw "(function(){var s=window._findScreen();s.ctx.ui.graphSlug='probe';return String(s.ctx.ui.graphSlug)})()"
```

Ground truth for command counts was `wc -l` on `vngen/state/commands.jsonl` sampled before, after
each event, and after a settle — the cheapest available answer to "how many commands did that
gesture send" and the one both prior attempts skipped. Input was `Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent` over one held socket rather than synthetic `PointerEvent`s from
`--raw`, because CDP input carries a valid `pointerId` and so `setPointerCapture` works
(`../guides/debugGuide.md`).

Five throwaway probes did the driving, all under the scratchpad and none committed:
`probe-gesture.mjs` (one textbox edit, `NO_REALTIME` as shipped), `probe-realtime.mjs` (the same
edit with the attribute forced true), `probe-coverage.mjs` (a gutter sweep, sampling after every
move), `probe-reload.mjs` (reloads, commands and commits across a run of edits and a batch flush)
and `probe-skip.mjs` (the pane's own `setProp` against the same command from outside). A sixth,
`probe-writetree.mjs`, replayed `UndoJournal.capture()`'s git sequence against the same repo with
and without a seeded `vngen/build/assets/`.

The reload counts in [§4a](#4a-the-reload-is-the-term-nothing-batches) needed instrumentation
rather than a projection, because `load()` leaves no observable trace once its paint has settled.
Three `CLAUDENOTE:` lines in `nodes.ts` pushed a timestamp into `window.__ggLoads` on entry to
`load()`, a duration into `window.__ggMs` at each of its two exits, and a timestamp into
`window.__ggSkips` on the `skipReload` branch. They were reverted with `git checkout` before this
report was finished; `apps/desktop/renderer/pathux/editors/nodes.ts` carries no `CLAUDENOTE:`.

**One measurement round was thrown away, and the reason is worth recording.** Killing the first
app's `vndesktop.mjs` process tree left its Electron alive holding CDP 9222, so the rebuilt,
instrumented app took 9223 and every probe kept answering from the stale one — which reported
`window.__ggLoads` as `undefined` and no commands at all. This is the trap
[`../guides/debugGuide.md`](../guides/debugGuide.md) names under "Is the running app your app?",
and the tell was exactly the one it gives: a change that alters behaviour not at all, with no
error. `Get-NetTCPConnection -LocalPort 9222 -State Listen` against `Win32_Process`'s
`CreationDate` settled it in one call — the listener predated the build. Confirm the port's owner
was started after the build before believing a counter that reads zero.

The widget projection the check in [§7](#7-sizing) should keep:

```js
(function () {
  var out = [];
  var walk = function (r) {
    for (const e of r.querySelectorAll('*')) {
      if (e.getAttribute && e.getAttribute('datapath'))
        out.push({ t: e.tagName.toLowerCase(), p: e.getAttribute('datapath'), rt: e.realtime, pf: e.packflag });
      if (e.shadowRoot) walk(e.shadowRoot);
    }
  };
  walk(document);
  return JSON.stringify(out);
})();
```

`document.querySelectorAll` does not cross a shadow root even when the root is open, so the
recursion is the whole trick; a selector that silently matches nothing reads exactly like a
feature that did not happen.

### Scaffolding worth keeping

The four probes are throwaway and were deleted. What is worth keeping is the check in
[§7](#7-sizing), which is the projection above plus a `commands.jsonl` count around one scripted
gesture. It pins both numbers this report turns on, so the next reader does not have to take
either on faith.

## 10. Unverified

- **The 56% / 23% split between the undo captures and the commit** is quoted from
  `archive/deferring-commit-on-save.md` §Stage 0 and was not re-derived here. What I measured
  independently is the `exec` total (853–962 ms for `gengraph.setProp` in the live app, against
  Stage 0's 1004 ms) and the git-side cost of a capture in isolation (150.8 ms over five spawns,
  against the seven spawns the real `capture` makes). The two are consistent; the internal split
  is inherited.
- **The gesture counts were taken on one machine, one project, one window.** The Shot Coverage
  measurement used the gutter `create` gesture against an undecomposed scene, because the fixture
  had no shots and so no brackets to drag. `drag` and `reorder` were read from source
  (`timeline.ts:794-838`) and share `startGesture`'s one dispatch on release with `create`, but
  they were not driven.
- **The reload timings are for one graph shape.** Node frames were added with
  `gengraph.addNode`, so the 23-node graph is 23 `GenImage` and `Output` nodes with no links and
  the default prop set. A graph of the same node count with more connected sockets draws more
  rows and would cost more; the per-node slope is not claimed to hold across node types.
- **`skipReload` was measured, not audited.** Three `setProp` invocations typed into the pane
  produced one command rather than three (the focus and Enter interplay in the synthetic input),
  so the skip is confirmed on one edit rather than on a run of them. The CDP side of the same
  comparison did run three times and reloaded three times.
- **Multi-window behaviour** was not exercised. Undo is broadcast deliberately
  (`apps/desktop/src/main/index.ts:737-744`) and one stack serves every window, so a batch and a
  gesture in two windows share one pending array; nothing here tested what that looks like.
- **No claim is made about vnauthor.** It runs the same command rules and gets the same refusals,
  but it has no gestures, so question 1 does not apply to it and question 2 was not measured
  against it.

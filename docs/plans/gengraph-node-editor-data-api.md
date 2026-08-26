# A scoped DataAPI for the node editor

Status: **planned**. Part of
[`gengraph-editing-cost-tasklist.md`](gengraph-editing-cost-tasklist.md), independent of the
other plan there.

The Gen Graph pane draws its node rows by hand because the application has no data API to bind
them to. This plan gives that one editor a DataAPI of its own, scoped to the graph on screen,
and hands the rows back to path.ux.

## The problem

`apps/desktop/renderer/pathux/editors/nodes.ts:34` documents the workaround it is built on:
path.ux's view binds its widgets through the data API, the app describes only `ShellState`, so
the view is pointed at an empty graph path and the rows are built from the node instead.

`GenGraphView.syncGraph` (`nodes.ts:48`) enforces that by clearing `frame.nodePath = ''` on
every frame, every sync. `NodeFrame` reads the empty path in three places and does nothing:
`_inlineKeys()` returns an empty set (`nodeframe.ts:286`), `_propSignature()` returns `''`
(`:339`), and `_rebuildPropRows` returns before building anything (`:362`). So path.ux draws
the socket terminals and nothing else, and 120 lines of `nodes.ts` (`:291`–`:423`) supply the
replacement.

Four things are wrong with the replacement, in rising order of consequence.

**The rows are not on the sockets.** `valueRow` (`nodes.ts:329`) appends a flat row to the
frame body. path.ux draws an unconnected input's editor in the socket's own row
(`nodeframe.ts:328`), so the widget and the terminal it belongs to line up. Nothing in the
hand-rolled version relates a row to a socket.

**The connected-input rule is written twice.** `nodes.ts:313` skips an input carrying a link;
`_inlineKeys()` (`nodeframe.ts:284`) applies the same rule plus the shadowing test. Two copies
of one rule stay correct only while both are maintained. path.ux additionally encodes the
result in `_rowSignature` (`:275`), so connecting a socket rebuilds the row and drops the
editor; the hand-rolled rows notice nothing until the whole file reloads.

**Every value edit costs a full reload.** `nodes.ts:349` says so: "On change rather than on
input: each commit is a command and a reload of the whole file." The reload comes from
`bridge.ts:187`, which invalidates on every mutating command, and `load()` (`nodes.ts:164`)
re-reads the document over IPC and rebuilds the view. `paint()` (`:200`) then re-adds the
selection by hand, because a selection dropped there "would be a selection that lasted one
gesture". path.ux's own update path is push-based: a widget subscribes with `addPathWatch` and
reactions coalesce onto one `requestAnimationFrame` flush.

**Twelve node classes are monkey-patched at module load.** `nodes.ts:417`–`:423` assigns
`createUI` onto every registered gen node prototype, because `createUI` is read off the
prototype during the frame's build. Any node type a plugin registers after that loop runs gets
no rows at all.

## What path.ux already provides

The read side needs no new declarations.

- `defineGraphAPI(api)` (`vendor/path.ux/scripts/graph/graph_api.ts:13`) declares the `nodes`
  list keyed by node id, and is idempotent.
- `nodeStructFor` (`:45`) builds a per-node-class struct on first use from the class's own
  `defineAPI`.
- `Node.defineAPI` (`node.ts:236`) declares `name`, `description` and `icon` read-only through
  `customGet`, plus the `props` list. Its setter (`:264`) resolves `nodePropTarget(node, key)`
  and calls `target.setValue(val)`.
- `NodeGraphView` addresses a node at
  `` `${this.currentGraphPath}.nodes[${JSON.stringify(node.id)}]` `` (`nodegraphview.ts:348`),
  and `NodeFrame` binds each row at `` `${this.nodePath}.props['${key}'].value` ``
  (`nodeframe.ts:367`).

The write side needs no path.ux change either. `ToolProperty.on('change', cb)`
(`toolprop.ts:517`) fires from the base `setValue` (`:564`), so a listener sees a write from
any widget rather than from one known call site.

## Non-goals

- **Deferring the graph file write.** Out of scope for both plans in this batch, for the
  reasons recorded in the tasklist.
- **Deferring the commit.** That is
  [`archive/deferring-commit-on-save.md`](archive/deferring-commit-on-save.md), which shipped
  and shares no code with this plan.
- **A data API for the project model.** `apps/desktop/renderer/pathux/api.ts:5` states the
  app-wide stance, and it stays. This plan describes the graph a pane is showing, which
  path.ux already describes, and nothing else.
- **path.ux's own datapath undo.** Turning it on inside this pane would give the app a second
  undo stack competing with `stack.check` and the shadow snapshots. Switching it off is a step
  of stage 3 rather than a non-goal, because it is on by default — see below.

## What this plan got wrong before the pressure test

The pressure test is at
[`../research/pressure-test-gengraph-node-editor-data-api.md`](../research/pressure-test-gengraph-node-editor-data-api.md).
Three of the plan's premises were false, and the stages below are written against the
corrections rather than the originals. They are recorded because each one would have been
discovered mid-implementation, and two of them silently.

**`useDataPathUndo` is on by default.** `getUseDataPathUndo` (`ui_base_props.ts:14-25`) walks up
the parent chain and returns `true` when nothing on the way sets it, and `_useDataPathUndo`
starts undefined. So a bound widget's write routes through `setPathValueUndo`
(`ui_base_datapath.ts:192`) onto the app's real `ToolStack`, which the renderer's context does
carry (`renderer/pathux/context.ts:50`). Worse than a second undo stack: that path's coalescing
calls `toolstack.undo` and `toolstack.redo` (`ui_base_datapath.ts:40-43`), each of which
re-fires the pane's `change` listener and sends another command. Stage 3 sets
`useDataPathUndo = false` on the view, which every child inherits, and the acceptance criteria
test it rather than assuming it.

**Binding `node.props` alone hears nothing from a socket row.** The row this plan exists to get
back binds an input's `defaultProp`, and `_inlineKeys` admits a key only when it is *not* in
`node.props` (`nodeframe.ts:292`). Subscribing to `node.props` would therefore leave exactly
those edits silent — no command, no file write, and no error. The write seam iterates
`nodePropKeys(node)`, which covers both, and `decideSetProp` (`packages/gengraph/src/edit.ts:226`)
already accepts an editable input's default.

**There is no refusal for unchecking `active`.** `decideSetActive`
(`packages/gengraph/src/edit.ts:270-296`) refuses an unknown node and a node that fills no slot,
takes no value at all, and its `apply` sets `active` to `true` unconditionally while standing
rivals down. So the earlier claim that unchecking is "refused by name" named a sentence that
does not exist. The fix is in the section below and needs no new refusal.

## Stage 1 — normalize `setValue` in path.ux

`ToolProperty` subclasses disagree about whether they store before firing `change`, which
makes a listener's reading of the new value depend on which subclass it is attached to.

- `StringPropertyBase.setValue` (`toolprop.ts:858`) calls `super.setValue(val)` — which fires —
  and assigns `this.data` afterwards.
- `NumberProperty` (`:1152`) and `BoolProperty` (`:1302`) store first, then fire.
- `FloatArrayProperty` (`:761`) and `ArrayBufferProperty` (`:899`) call `super.setValue()` with
  no argument, so a listener receives `undefined` as the new value.

Every prop a gen node declares today is a string or a bool, so a listener reading the callback
argument works now and breaks silently the first time a node declares a vector or a color.

Those five are the ones this app can reach. The audit is wider: `toolprop.ts` carries roughly
seventeen `setValue` overrides, and the stage covers all of them rather than the five, because a
normalization that skips twelve subclasses is not a normalization. Three cases need a decision
rather than a mechanical edit.

- `_NumberPropertyBase.setValue` returns early on a null or undefined value (`:1153`) without
  firing at all. Normalizing the ordering must not turn that into a fired `change` carrying a
  rejected value.
- `copyTo` shares the callback arrays between the source and the copy (`:587-589`), so a copied
  property fires the original's listeners. That is a defect this stage may not fix, and if it is
  left alone the stage says so, because a shared listener list interacts with anything built on
  `on('change')`.
- `ui_lasttool.ts:180` reads a string property during a `change`, so the reordering does change
  behaviour there. The claim "no behaviour change" is true of this application and false of
  path.ux, and it is the reason this lands as its own reviewable commit.

Make every subclass store the value before firing, and pass the value to `_fire`. A listener may
then read `prop.getValue()`, which stays correct even where a subclass forgets to pass the
argument.

This lands as a commit in `vendor/path.ux` plus the parent's gitlink bump, together, per that
repository's submodule rule.

Tests: a case per property type in path.ux asserting that a `change` listener reading
`getValue()` sees the value that was just set, plus one asserting a rejected null still fires
nothing.

## Stage 2 — the graph DataAPI and the derived context

Add `defineGraphApi(getGraph)` beside `defineShellApi` in
`apps/desktop/renderer/pathux/api.ts`. It builds a second `DataAPI` whose root carries one
member, `graph`, resolved through a `customGet` that calls `getGraph()` and typed by
`defineGraphAPI`'s struct. The `customGet` is what lets the pane replace the graph object on
reload without rebuilding the API.

`GenGraphEditor` builds one per instance and hands it to the view through a derived context.
`Context.override` (`vendor/path.ux/scripts/path-controller/controller/context.ts:448`) copies
the context and pushes an overlay, so `this.ctx.override({ api: graphApi })` yields a context
identical to the shell's except for `api`. `nodes.ts:129` already assigns `this.view.ctx`; it
assigns the derived one instead.

Per-instance rather than one shared API, because two Gen Graph panes may be open on different
slugs, and a single `graph` member cannot answer for both. A child's own `ctx` survives its
parent's reassignment — `FrameManager.ts:264` reassigns only where
`n.ctx === oldCtx || n.ctx === undefined`.

Two caveats on the derivation. `ScreenArea.copy` assigns `ctx` unconditionally
(`FrameManager.ts:1107`, `:1118`, `:1129`, `:1132`), so a copied area does not inherit the
override; the derived context is established in the editor's `init()`, which every copy runs.
And `Context.override` pushes an overlay onto a context that already carries a `VnOverlay`
(`context.ts:460` over the renderer's own `context.ts:78`), so the resulting stack holds two.
Every member still resolves, and nothing in the app keys off overlay identity today, but a
duplicate overlay is worth knowing about before something does.

The view stays pointed at `''` through this stage, so nothing on screen changes. Acceptance is
over CDP: `ctx.api.getValue(ctx, 'graph')` inside the pane resolves to the live `Graph`, and
`'graph.nodes["<id>"].props[\'prompt\'].value'` resolves to that node's value.

## Stage 3 — hand the rows to path.ux

One commit, because the two halves are a regression apart. Pointing the view at a real path
without the write seam would draw rows that edit the graph in memory and persist nothing.

**Point the view at the graph.** `paint()` (`nodes.ts:202`) calls
`this.view.setGraph(this.graph, 'graph')`.

**Drop the `syncGraph` override.** Its whole body is the `nodePath` clearing, and
`NodeGraphView` already assigns `frame.nodePath` when it creates the frame
(`nodegraphview.ts:358`), which is now the wanted behaviour. With the active-output route
deleted as well, `GenGraphView` has nothing left to override, so the subclass goes and the pane
uses `NodeGraphView` directly.

**Switch off path.ux's datapath undo.** `view.useDataPathUndo = false`, which every child
inherits through `getUseDataPathUndo`'s parent walk. Without it a bound write goes onto path.ux's
own toolstack and its coalescing re-enters the `change` listener, sending a second command per
edit.

**Delete the hand-rolled rows.** `buildNodeUI` (`nodes.ts:306`), `valueRow` (`:329`),
`stopOwnEvents` (`:396`), `raise` (`:402`), the four style constants (`:291`–`:299`) and the
`createUI` prototype patch (`:417`–`:423`) all go. `registerGenNodes()` stays — it fills the
renderer's own registry. `GenGraphView.onGenEdit` and `GenGraphEditor.propose` (`:261`) go with
them, since nothing raises an edit from a row any more.

**Install the write seam.** After each sync, subscribe once per key of `nodePropKeys(node)` for
each node in the graph, resolving the target through `nodePropTarget(node, key)`:

```
target.on('change', () => this.onPropWrite(node, key, target))
```

Iterating `nodePropKeys` rather than `node.props` is what makes the socket rows work. path.ux
binds an unconnected input's `defaultProp`, and `_inlineKeys` admits a key only when it is *not*
in `node.props` (`nodeframe.ts:292`), so subscribing to `node.props` alone would hear nothing
from precisely the rows this plan is for. `decideSetProp` already accepts an editable input's
default (`packages/gengraph/src/edit.ts:226`), as does the DSL.

`onPropWrite` builds the `GenEdit`, runs `decideGenEdit` against the live graph (the same rule
`weigh` already uses at `:254`, documented pure and safe to call twice), and either sends the
command or reverts.

Subscriptions are torn off in `load()` before the graph is replaced, and re-established in
`paint()`. A leak here is a listener holding a discarded `Graph` and firing a command for a node
that is no longer on screen. The tear-off removes only what the pane added: `_adoptProp` already
registers a `change` listener of its own per node (`vendor/path.ux/scripts/graph/node.ts:196`),
and clearing the list wholesale would break the node's own bookkeeping.

**Revert on refusal.** `change` is a notification rather than a veto: `_fire`
(`toolprop.ts:459`) discards each callback's return value, so the prop already holds the new
value when the listener runs. A refused edit writes the previous value back through the pane's
own API — `api.setValue(ctx, path, previous)` — under a reentrancy guard, and shows
`decision.reason` through `say`. Writing through `target.setValue` directly would skip
`notifyPathChange` (`controller_abstract.ts:235`, `:310`), leaving the widget to catch up only
through the `dataPathPolling` compatibility net, which is a frame of the refused value still on
screen and a dependence on a fallback that is meant to be removable.

Only one of `decideSetProp`'s four refusals (`packages/gengraph/src/edit.ts:222`) can be
reached from a bound widget. Missing node, unknown prop and wrong value type are all impossible
where the widget was built from that prop. The reachable one is `slotRefusal` (`:238`), on a
malformed slot address typed into a slot-valued field. So the revert is one text field
flickering back on typed garbage.

**The active output becomes a bound checkbox.** `active` is a declared prop, so
`_rebuildPropRows` renders it as a checkbox with no special handling. `onPropWrite` maps a
`change` on `active`, on a node whose spec declares a `slotProp`, by direction:

- Ticking sends `gengraph.setActiveOutput`, whose `apply` sets `active` to `true` and stands the
  rivals claiming the same slot down (`packages/gengraph/src/edit.ts:291-295`).
- Unticking sends `gengraph.setProp` with `active` false, which `decideSetProp` accepts as an
  ordinary bool prop.

Splitting by direction rather than refusing the untick is what the existing rules already
support. `decideSetActive` takes no value and always sets `true`, so there is no "turn this off"
edit to route an untick into, and manufacturing a refusal for it would invent a rule in
`@vn/gengraph` to serve one widget. The plain `setProp` writes exactly what the author asked
for.

What an unticked slot then means is the open question below. `activeRow` (`:372`),
`outputSettled` (`:364`) and the `buildExtraUI` route are all deleted; the contested-slot warning
already reaches the author through `this.notes` (`:186`–`:190`).

The alternative was keeping `activeRow` and installing it through `frame.buildExtraUI`
(`nodeframe.ts:97`). It loses on a timing problem: `buildExtraUI` is read during
`frame._init()` (`nodegraphview.ts:364`), which runs inside `super.syncGraph()`, and
`syncContents()` (`nodeframe.ts:249`) rebuilds only the header and the socket and prop rows, so
an assignment made after `super` never runs. Taking that route would need a frame-creation hook
added to `NodeGraphView`. Binding `active` needs no path.ux addition and removes four functions
instead of keeping one.

**Event containment comes back from path.ux.** `stopOwnEvents` (`:396`) is deleted rather than
re-homed because path.ux covers both cases it was written for. A press inside a prop row is
stopped by the frame's own handling plus the `nodeeditor-prop-row` class the row carries
(`nodeframe.ts:490-518`, `groupui.ts:143`), and a keydown while a text field is in edit mode is
stopped by the widget (`ui_textbox.ts:165-196`, `ui_widgets.ts:206-219`). This is the house rule
that an editor with an open text row stops its own keydown events being satisfied by the widget
instead of by the pane, and the acceptance criteria check it live rather than by reading.

**Tooltips are a prerequisite, not a polish pass.** Every row path.ux builds takes its text from
the property's `uiname` and `description`, and no property in
`packages/gengraph/src/nodes/types.ts` declares either today. The fallback the author currently
sees is generated inside `valueRow` (`nodes.ts:341`), which this stage deletes, so shipping the
binding without the declarations would ship twelve node types of untooltipped controls and
break the repo's no-exceptions tooltip rule. The declarations land in this stage, ahead of the
deletion.

## Stage 4 — stop the echo

`bridge.ts:187` invalidates on every successful mutating command, so a prop edit the pane just
made returns as a whole-file reload that rebuilds the graph under the widget being used.

Skip the reload in the pane that issued the command, for `gengraph.setProp` only.

The mechanism is not `ctx.origin`. That field lives in main (`main/index.ts:744-757`) and never
reaches the renderer, and `onInvalidate` listeners are called with no arguments at all
(`bridge.ts:126-133`), so a listener cannot tell what caused the invalidation it is being told
about. The pane arms a one-shot skip instead: an `onExec` watcher fires at `bridge.ts:185`,
immediately before `invalidate()` at `:187`, and the pane arms the skip there when the outcome
is its own `gengraph.setProp`. The next invalidation consumes it.

The earlier rationale for narrowing by window was also backwards. A `setProp` issued from
another window does not reload this pane today — `onRecord` leaves `ui`-sourced commands out
because `exec` already invalidated locally (`main/index.ts:706`) — so the case this was said to
protect does not exist. The one-shot skip is correct for the case that does: this pane's own
edit, arriving back as a whole-file reload under the widget being typed into.

Narrowed to `setProp` because that is the only edit where the renderer's local state and main's
write are guaranteed identical — the same `decideGenEdit` produced both. `addNode`, `removeNode`,
`link` and `moveNodes` keep the reload: they are not in the hot path, and main's apply assigns
identity and position the renderer would otherwise have to mirror.

`dispatch()` (`nodes.ts:240`) already applies `moveNodes` locally as well as sending it, for a
different reason recorded at `:243`. This stage does not change it.

`useDataPathUndo` is switched off in stage 3 rather than asserted here, because it defaults on.

## Stage 5 — documentation

`docs/reference/desktop-app.md`'s Gen Graph section, and the paragraph in `CLAUDE.md` naming
the sixteen editors, both describe the pane as building its own rows. Update both. Record in
`docs/reference/desktop-app.md` that one editor holds a scoped DataAPI and why the app-wide
stance in `api.ts` is unchanged.

Tick the row in [`gengraph-editing-cost-tasklist.md`](gengraph-editing-cost-tasklist.md) and
add this plan to `docs/plans/index.md`.

## Decisions

| Decision | Alternative it beat | Why |
| --- | --- | --- |
| A per-editor `DataAPI` behind `ctx.override` | One `graph` member on the shell API | Two panes may show different slugs, and one member cannot answer for both. Also keeps the app-wide stance in `api.ts` intact |
| `prop.on('change')` as the write seam | A `setProp` kind added to path.ux's `GraphEdit` union, routed through the delegate | Catches a write from any widget rather than one known call site, and needs no path.ux change |
| Listeners read `prop.getValue()` | Listeners read the callback argument | Correct only once stage 1 lands, and then correct even where a subclass passes no argument |
| Normalize store-then-fire in path.ux | Work around the inconsistency in the renderer | The workaround is right for string and bool and silently wrong for the first vector prop anyone adds |
| Revert after a refusal | Refuse before the write | `_fire` discards return values, so `change` cannot veto. The reachable refusal is one malformed slot address |
| Revert through `api.setValue` | `target.setValue` directly | A direct write skips `notifyPathChange`, so the widget repaints only through the `dataPathPolling` fallback |
| Subscribe over `nodePropKeys` | Subscribe over `node.props` | `_inlineKeys` admits only keys absent from `node.props`, so the socket rows this plan exists for would be silent |
| Untick sends `setProp active=false` | Refuse the untick; keep `activeRow` | `decideSetActive` takes no value and always sets `true`, so there is no off edit to route into and no refusal to quote. `setProp` on a bool prop is already accepted |
| Switch `useDataPathUndo` off explicitly | Rely on it being off | It defaults to `true` (`ui_base_props.ts:24`), and its coalescing re-enters the `change` listener |
| A one-shot skip armed from `onExec` | Key the skip off `ctx.origin` | `ctx.origin` is main-only and `onInvalidate` passes no arguments, so the renderer cannot attribute an invalidation |
| `active` bound as a checkbox mapped to `setActiveOutput` | `activeRow` installed through `buildExtraUI` | `buildExtraUI` is read inside `super.syncGraph()` and `syncContents` does not re-run it, so that route needs a new path.ux hook. Binding removes four functions instead of keeping one |
| Echo suppression for `setProp` only | Suppression for every `gengraph.*` command | `setProp` is the only edit whose local and written results are provably identical |

## Acceptance

- A gen node's unconnected input shows its editor on the socket's own row, aligned with the
  terminal.
- Connecting that socket removes the editor without a file reload; disconnecting restores it.
- Typing a value writes it through `gengraph.setProp` and does not reload the pane, and the
  selection survives.
- A malformed slot address is refused with `decideSetProp`'s own sentence and the field returns
  to its previous value.
- Editing an unconnected input's default on its socket row sends a command and writes the file,
  which is the case a `node.props` subscription would have missed.
- Ticking `active` on an inactive output stands its rivals down; unticking leaves it inactive.
- An edit pushes exactly one command and exactly one entry onto the app's undo stack, and
  path.ux's own toolstack receives nothing.
- Over CDP: a press inside a prop row does not start a frame drag, and typing in a bound text
  field does not trigger the pane's delete-node hotkey.
- Every control the pane draws has a tooltip, and it comes from the property declaration.
- Two Gen Graph panes open on different slugs each edit their own graph.
- A node type registered after module load draws its rows, which the deleted prototype patch
  could not do.
- `pnpm check && pnpm test && pnpm lint` green at each stage, in both the app and
  `vendor/path.ux`.

## Open questions

- **Where the per-prop subscriptions are torn down when the pane closes rather than reloads.**
  `VnEditor` teardown needs auditing for the hook, and the listener set must not outlive the
  editor.
- **Is a slot with no active output a legal state?** Unticking `active` on the only output
  claiming a slot leaves nothing to draw it. `contestedSlots` warns about a slot claimed twice
  and says nothing about one claimed zero times, so either the untick needs a matching warning in
  `this.notes` or the state needs a rule. This is the one question the active-output binding
  opens, and it should be answered before stage 3 rather than during it.
- **What a bound row shows while its command is in flight.** The reload stage 4 removes is what
  currently hides the gap between a keystroke and the file being written. A refusal arriving two
  hundred milliseconds after the author moved on is a field that changes under them, and nothing
  in this plan decides whether the row is disabled, marked, or left alone.
- **Whether `copyTo`'s shared callback arrays are stage 1's problem.** A copied property firing
  the original's listeners is a live defect that anything built on `on('change')` sits next to.
  Fixing it widens a submodule commit; leaving it means writing down that the seam has a known
  sharp edge.
- **Whether the notes strip should also carry the refusal**, since `say` is transient and a
  reverted field gives the author no lasting record of why.

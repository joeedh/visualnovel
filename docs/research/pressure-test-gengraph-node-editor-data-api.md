# Pressure test: a scoped DataAPI for the node editor

<!-- toc -->

- [Where the plan is right](#where-the-plan-is-right)
- [Findings](#findings)
  * [1. `useDataPathUndo` is on by default, so the non-goal is false as written — blocking](#1-usedatapathundo-is-on-by-default-so-the-non-goal-is-false-as-written--blocking)
  * [2. The write seam must iterate `nodePropKeys`, not `node.props` — blocking](#2-the-write-seam-must-iterate-nodepropkeys-not-nodeprops--blocking)
  * [3. "Unchecking is refused by name" names a refusal that does not exist — blocking](#3-unchecking-is-refused-by-name-names-a-refusal-that-does-not-exist--blocking)
  * [4. Stage 4's mechanism does not exist in the renderer, and its cross-window rationale is backwards — blocking](#4-stage-4s-mechanism-does-not-exist-in-the-renderer-and-its-cross-window-rationale-is-backwards--blocking)
  * [5. The revert repaints nothing — should-fix](#5-the-revert-repaints-nothing--should-fix)
  * [6. Stage 1 understates its own scope — should-fix](#6-stage-1-understates-its-own-scope--should-fix)
  * [7. Deleting `stopOwnEvents` is defensible, and the plan does not say why — should-fix](#7-deleting-stopownevents-is-defensible-and-the-plan-does-not-say-why--should-fix)
  * [8. The tooltip audit is a prerequisite, not a step inside stage 3 — should-fix](#8-the-tooltip-audit-is-a-prerequisite-not-a-step-inside-stage-3--should-fix)
  * [9. The `syncGraph` override is left with no job — note](#9-the-syncgraph-override-is-left-with-no-job--note)
  * [10. `ctx.override` yields a doubled overlay stack — note](#10-ctxoverride-yields-a-doubled-overlay-stack--note)
  * [11. The `FrameManager` protection holds; area copying does not — note](#11-the-framemanager-protection-holds-area-copying-does-not--note)
  * [12. The undo, provenance and pipeline claim holds, conditionally — note](#12-the-undo-provenance-and-pipeline-claim-holds-conditionally--note)
  * [13. Every widget write flags a renderer-side node dirty — note](#13-every-widget-write-flags-a-renderer-side-node-dirty--note)
- [What the plan leaves undecided beyond its own open questions](#what-the-plan-leaves-undecided-beyond-its-own-open-questions)
- [Cost to undo](#cost-to-undo)

<!-- tocstop -->

A fresh-context review of docs/plans/gengraph-node-editor-data-api.md, written without seeing
the conversation that produced the plan. Every citation below was checked against the code on
the `gengraph` branch. Findings are numbered and carry a severity: blocking means the stage
cannot ship as written, should-fix means the stage ships but the plan is wrong or silent about
something a reader needs, and note means a fact worth recording.

## Where the plan is right

The problem statement is accurate line by line. `nodes.ts:34` does document the workaround,
`GenGraphView.syncGraph` (`nodes.ts:48`) does clear `frame.nodePath`, and the three places
`NodeFrame` reads the empty path and gives up are exactly `_inlineKeys` (`nodeframe.ts:292`),
`_propSignature` (`:339`) and `_rebuildPropRows` (`:362`). path.ux does draw an unconnected
input's editor in the socket's own row (`nodeframe.ts:328`, `:450`), which the hand-rolled rows
cannot do.

The read side really does need no new declarations. `defineGraphAPI` is idempotent through the
`"nodes" in st.pathmap` test (`graph_api.ts:13`), `nodeStructFor` memoizes on `api.hasStruct`
(`:45`), `Node.defineAPI` declares the `props` list whose setter resolves
`nodePropTarget(node, key)` and calls `setValue` (`node.ts:264`), and the paths the view and
the frame build (`nodegraphview.ts:348`, `nodeframe.ts:367`) match what a root `graph` member
would expose.

The write path the plan chose is the right one, and I traced it end to end.
`api.setValue` takes the `USE_CUSTOM_GETSET` branch (`controller_abstract.ts:204`) and calls
the bound copy's `setValue` (`:234`), whose method was replaced by `customGetSet`
(`controller_base.ts:283`), which calls `nodePropTarget(node, key)!.setValue(val)`
(`node.ts:425`) on the node's real property. A `change` listener on that property therefore
sees every widget write, exactly as the plan claims.

Three further arguments hold up. `buildExtraUI` is read once in `_buildUI` (`nodeframe.ts:408`)
during `_init()` (`nodegraphview.ts:364`), and `syncContents` (`nodeframe.ts:249`) rebuilds only
the header and the socket and prop rows, so the alternative the plan rejected really would need
a new path.ux hook. `_fire` (`toolprop.ts:459`) discards each callback's return value, so
`change` genuinely cannot veto and a revert is the only option. `decideGenEdit` is documented
pure and calling it twice is safe (`edit.ts:70`). The reachable-refusal analysis for
`decideSetProp` is correct: missing node, unknown prop and wrong value type (`edit.ts:224`,
`:227`, `:234`) are all unreachable from a widget built from that property, and `slotRefusal`
(`:238`) is the one that survives.

The per-instance API argument is sound, and `Context.override` does copy the context and push
an overlay (`context.ts:448`).

## Findings

### 1. `useDataPathUndo` is on by default, so the non-goal is false as written — blocking

The plan states that path.ux's datapath undo "stays off, and stage 4 asserts that it is"
(plan lines 79 to 82). It is on. `getUseDataPathUndo` walks the `parentWidget` chain and, when
nothing on it has an opinion, returns `true` (`ui_base_props.ts:14`, with the default at `:24`).
Every widget's `_useDataPathUndo` starts `undefined` (`ui_base_init.ts:37`).

`setPathValue` branches on that flag before anything else and routes the write through
`setPathValueUndo` (`ui_base_datapath.ts:192`), which resolves `elem.ctx.toolstack`
(`:30`) and pushes a `DataPathSetOp`. The desktop app supplies a real `ToolStack` on that member
(`apps/desktop/renderer/pathux/context.ts:50`), so the ops would land somewhere live.

The consequence is worse than a second undo stack. To coalesce a repeated edit on the same path,
`setPathValueUndo` calls `toolstack.undo(ctx)`, mutates the head op, and calls
`toolstack.redo(ctx)` (`ui_base_datapath.ts:40` to `:43`). Each of those re-runs the write, so
the pane's `change` listener fires again and sends another `gengraph.setProp` for a value the
author typed once.

Fix: stage 3, not stage 4, sets `_useDataPathUndo = false` on the view (or on the editor root),
and the stage says which widget it is set on. Because the flag inherits through `parentWidget`,
the plan should also name the chain it relies on: `_rebuildPropRows` sets
`row.parentWidget = this._body` (`nodeframe.ts:368`) and `_inlineEditor` sets
`row.parentWidget = this` (`:453`), so the frame's own `parentWidget` must reach the view for
the setting to cover both. Add a CDP acceptance line that reads `useDataPathUndo` on a bound row
and expects `false`.

### 2. The write seam must iterate `nodePropKeys`, not `node.props` — blocking

Plan line 151 subscribes "once per prop of each node". The plan's headline improvement is the
inline editor path.ux draws for an unconnected input's default, and that editor binds a property
which is deliberately not in `node.props`: `_inlineKeys` admits a key only when
`sock.defaultProp !== undefined && sock.edges.length === 0 && !(key in this.node.props)`
(`nodeframe.ts:292`). A write to one of those fires `change` on
`node.inputs[key].defaultProp`, which a subscription built from `node.props` never hears.

The failure is silent and is the exact fault the plan set out to remove: the value changes in
the renderer's graph, no command runs, no file is written, and the row keeps showing the new
value until the next reload throws it away.

Everything below the seam already handles input defaults. `decideSetProp` resolves through
`nodePropTarget`, which falls back to `node.inputs[key]?.defaultProp` (`edit.ts:226`,
`node.ts:434`), and the serializer writes a changed input default alongside a changed prop
(`dsl.ts:168` to `:179`).

Fix: subscribe over `nodePropKeys(node)` (`node.ts:439`). This also settles the plan's second
open question — `nodePropKeys` keeps a caller, and it is this one.

### 3. "Unchecking is refused by name" names a refusal that does not exist — blocking

Plan line 179 maps a `change` on `active` to `gengraph.setActiveOutput` and says unchecking "is
refused by name". `decideSetActive` refuses two things and neither is this one: an unknown node
(`edit.ts:272`) and a node that fills no slot (`:277`). It has no case for a node that is already
active, it never reads the value the author asked for, and its `apply` sets `active` back to
`true` and stands the rivals down (`:292`, `:293`).

So an uncheck would return `ok` with the note "Makes this the output run for …", write the file,
reload the pane, and leave the checkbox ticked with no sentence shown. The rivals would be stood
down as a side effect of an author trying to turn something off.

Inventing the sentence in the renderer is not open to the plan: a mutating command declares its
own refusal, and `@vn/gengraph` is a leaf precisely so two hosts read the same one.

Fix: add the refusal to `decideSetActive` in `@vn/gengraph` (a request that would leave the slot
with no active output, worded once and reused), have the pane send `setActiveOutput` only for
`value === true`, and route `value === false` to the same refusal through `decideGenEdit` so the
revert machinery shows the package's sentence. If that refusal is judged not worth adding, the
`activeRow` button survives and the decision table's row flips.

### 4. Stage 4's mechanism does not exist in the renderer, and its cross-window rationale is backwards — blocking

Plan line 202 says "`ctx.origin` already records which window issued a command". It does not, in
the renderer. `origin` is derived in main from the IPC sender (`apps/desktop/src/main/index.ts:744`
to `:757`) and is a `WindowId` main holds; nothing carries it back. The renderer's invalidation
feed carries nothing at all: `onInvalidate` takes a zero-argument listener
(`bridge.ts:126`) and `invalidate()` calls each one with no arguments (`:131`).

The rationale is also inverted. The reload the plan wants to skip is entirely local — `exec`
calls `invalidate()` in the same renderer that ran the command (`bridge.ts:187`). A `setProp`
from another window does not reload this pane today: main withholds the `undoRevision` bump for
a mutating command whose source is `ui` (`apps/desktop/src/main/index.ts:706`), and the
renderer's only cross-window invalidation is the revision test on the `command:ui` undo effect
(`bridge.ts:295` to `:308`). So the sentence "a `setProp` from another window still reloads this
one" describes behaviour the app does not have.

Fix: drop `ctx.origin` and use the exec feed, which does carry what is needed. `exec` notifies
its watchers at `bridge.ts:185`, synchronously and immediately before `invalidate()` at `:187`,
so the pane can arm a one-shot skip in an `onExec` watcher when `id === 'gengraph.setProp'` and
the outcome is ok, and consume it in its `onInvalidate` listener. Ordering is deterministic
within the one call, so no correlation token is needed. Separately, correct plan line 204: state
that cross-window freshness for a `ui`-sourced `setProp` is a pre-existing gap this plan neither
creates nor closes.

### 5. The revert repaints nothing — should-fix

Plan line 167 reverts with `prop.setValue(previous)`. That writes the node's property directly
and never passes through the API, so `notifyPathChange` (`controller_abstract.ts:235` and
`:310`) does not run and no path watch fires. The bound widget keeps showing the refused value
until `UIBase.dataPathPolling` happens to catch it, which is the safety net rather than the
update path.

Fix: revert through the pane's own API — `graphApi.setValue(ctx, path, previous)` under the same
re-entrancy guard — or call `notifyPathChange` for the path after the direct write. Say which,
because the two differ in whether the revert re-enters the change listener.

### 6. Stage 1 understates its own scope — should-fix

The plan names five `setValue` overrides. `toolprop.ts` carries roughly seventeen: `:761`,
`:858`, `:899`, `:1152`, `:1214`, `:1302`, `:1366`, `:1757`, `:1838`, `:1978`, `:2028`, `:2065`,
`:2127`, `:2184`, `:2370`, `:2492` and `:2554`. Normalizing an ordering across a vendored
dependency means auditing all of them, and the stage should say so rather than listing the five
that motivated it.

Two facts belong in the stage because they survive the reordering. `_NumberPropertyBase.setValue`
returns without storing and without firing for `null` or `undefined` (`toolprop.ts:1153`), so a
listener that expects one `change` per write does not always get one. `copyTo` assigns the
callback arrays by reference (`:587` to `:589`), so a listener registered on a property is also
reachable from every copy of it — harmless here only because `customGetSet` replaces the copy's
`setValue` outright (`controller_base.ts:283`).

Plan line 103 says the stage "changes no behaviour in this app on its own". True for this app,
and worth keeping. It is not true of path.ux: `ui_lasttool` re-executes a tool from a `change`
listener (`ui_lasttool.ts:180`), so for a string property it currently re-executes with the
pre-write value and afterwards will not. That is a fix rather than a regression, but it is a
behaviour change in the shared submodule and the commit message should name it.

### 7. Deleting `stopOwnEvents` is defensible, and the plan does not say why — should-fix

`stopOwnEvents` (`nodes.ts:396`) is listed for deletion with no replacement named. path.ux does
cover both cases it guards, and the plan should record that rather than leave a reader to check.
A press is guarded by `_wirePress` and `_onNodeWidget`, which match `this._body` or any element
carrying `nodeeditor-prop-row` on the composed path (`nodeframe.ts:490` to `:518`); `propEditRow`
puts that class on both the body rows and the socket-row inline editors (`groupui.ts:143`, used
from `nodeframe.ts:452`). A keydown is stopped by the TextBox's own modal while it is being
edited (`ui_textbox.ts:165` to `:196`), and the Check widget stops Enter, Space and Escape
(`ui_widgets.ts:206` to `:219`).

What no code covers is a keydown on a control that is focused but not in edit mode. Add two CDP
acceptance lines: typing `/` into a bound field does not open the palette, and a drag begun on a
bound field does not move the node.

### 8. The tooltip audit is a prerequisite, not a step inside stage 3 — should-fix

Plan lines 192 to 195 are right that a bound row takes its text from the property, and right to
schedule an audit. The audit is larger than it sounds: not one property in
packages/gengraph/src/nodes/types.ts declares a `uiname` or a `description`. The descriptions
that exist there are on the node types (`types.ts:27`, `:41`, `:55`, `:75`, `:90`, `:112`,
`:138`, `:164`, `:183`, `:197`, `:211`, `:229`), while every property is a bare
`new StringProperty('')` or `new BoolProperty(...)`.

Today's hand-rolled row hides that with a fallback: `field.title = prop.description || \`Set
this node's ${key}\`` (`nodes.ts:341`). Deleting it removes the tooltip from every row at once,
and the house rule makes an untooltipped control an unfinished one. Land the descriptions before
or with the deletion, and state it as a condition on the stage rather than an audit inside it.

### 9. The `syncGraph` override is left with no job — note

Plan lines 140 to 143 keep the override and say its remaining job is described under the
active-output row, and plan line 180 then deletes that route. Between them, `GenGraphView`'s
override has nothing left to do, and `onGenEdit` goes at plan line 148 along with the `raise`
walk that targets the class (`nodes.ts:402`). Say whether `GenGraphView` survives as a class at
all, so the stage's diff is predictable.

### 10. `ctx.override` yields a doubled overlay stack — note

`Context.copy` constructs `new (this.constructor)(this.state)` and then pushes copies of the
existing overlays (`context.ts:460`), and `ShellContext`'s constructor already pushes a
`VnOverlay` (`apps/desktop/renderer/pathux/context.ts:78`). The derived context therefore carries
two `VnOverlay`s plus the override's own. Member resolution walks the stack, so `toolstack`,
`ui`, `screen` and `last_tool` still answer, but anything keyed by overlay identity —
`getOwningOverlay` throws "context corruption" on a missing `Symbol.ContextID` (`context.ts:482`)
— sees a duplicate. Add a line to stage 2's CDP acceptance that those four members still resolve
inside the pane.

### 11. The `FrameManager` protection holds; area copying does not — note

Plan line 125 is correct: the ctx setter reassigns only where `n.ctx === oldCtx || n.ctx ===
undefined` (`FrameManager.ts:264`), so a derived context survives a parent's reassignment.
`ScreenArea` is mostly guarded the same way (`:1038`, `:1052`, `:1391`), but its `copy` assigns
`ctx` unconditionally (`ScreenArea.ts:1107`, `:1118`, `:1129`, `:1132`). A copied area gets a
fresh editor whose `init()` runs again, and `nodes.ts:129` derives the context there, so the
outcome is fine — provided the derivation stays in `init()` rather than moving to a
constructor or a module-level cache. Worth one sentence in stage 2.

### 12. The undo, provenance and pipeline claim holds, conditionally — note

Every write still arrives as a `gengraph.setProp` through `exec`, so `commands.jsonl`, the
shadow-snapshot undo and `stack.check` are untouched, and nothing in `@vn/gengraph`'s execute
path changes. That claim depends entirely on finding 1: with `useDataPathUndo` left at its
default, the app acquires a second undo stack and the claim is false.

### 13. Every widget write flags a renderer-side node dirty — note

`_adoptProp` registers `prop.on("change", () => this.flagDirty())` per node instance and clones
the callback arrays first (`node.ts:193` to `:196`). So a bound write marks the node dirty in the
renderer's copy of the graph. The renderer never executes a graph and drift is measured on
`authoredHashes` rather than dirty flags, so nothing follows from it — but the pane's own
listener now shares a callback array with path.ux's, and the plan's tear-down step must remove
only what it added.

## What the plan leaves undecided beyond its own open questions

The three open questions the plan names are real, and the second is answered by finding 2. Two
more were not named.

**Which path the revert writes through** (finding 5) determines whether the revert re-enters the
listener, which decides what the re-entrancy guard has to do.

**What happens to a bound row while a command is in flight.** The plan sends on `change` and
reverts on refusal, but a command is asynchronous and `exec` awaits IPC. Nothing in the plan says
whether the row is disabled meanwhile, whether a second edit during the flight is queued or
dropped, or which value wins when a reload arrives between the write and the outcome. The
current design cannot show the problem, because every edit reloads the pane; stage 4 removes
exactly that.

## Cost to undo

Stages 2 through 4 are contained in one editor and one new file beside api.ts, and reverting
them restores `buildNodeUI` from git. That is cheap.

Stage 1 is not, and the plan is right to flag the submodule commit. It lands in
`vendor/path.ux`, where the parent repository pins it by gitlink, and it changes an ordering that
every path.ux consumer sees. Reverting it after any other path.ux work has landed on top means a
revert commit in the submodule plus a second gitlink bump. The mitigation is to keep stage 1 a
single, isolated submodule commit with the vitest cases the plan already calls for, and to name
the `ui_lasttool` behaviour change (finding 6) in its message so a future bisect lands on an
explanation rather than a surprise.

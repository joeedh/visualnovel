# Desktop app rewrite on path.ux

Status: **shipped** — the submodule and build wiring, the shell, ports 1–7, the flag flip, the
room vocabulary's retirement, the docs, and the deletion: the React shell, the `--react` flag and
`react`/`react-dom` are gone, and the pure rule modules moved from `renderer/rooms/` to
`renderer/rules/` with their tests (see [The deletion, as it went](#the-deletion-as-it-went)).
Item 1 of
[`../refactorTaskList.md`](../refactorTaskList.md). Replaces the
three-room React renderer with path.ux's subdividing screen — the §UX requirement of
[`../../history/designRequirementsEtc.md`](../../history/designRequirementsEtc.md) — while keeping the main
process, the IPC shapes, `WorkspaceSession` and the `@vn/commands` registry as they are.
The evaluation that led here is recorded in
[`../refactorTaskList.md`](../refactorTaskList.md#decisions-taken-so-far): path.ux's
`FrameManager.ts` hard-imports its widget modules and `Area`/`ScreenArea` are `UIBase`
custom elements, so the frame manager comes with the widget library or not at all; React is
displaced from the renderer.

<!-- toc -->

<!-- tocstop -->

## Why

The room model is over budget: three rooms, modes-within-rooms, three independent scene
selections, two mode-switch mechanisms, seven surfaces for one gate — the incoherence
diagnosis is in the conversation record and its structural half is what a pane model fixes.
The requirements then settle the direction: *"a 2d subdividing dockable UX that subdivides
into 'editors'"*, each with optional header, footer and sidebar panels — which is a
description of path.ux's `Area` + `PanelManager`, already built (screen mesh, split/join,
`AreaDocker` tabs, tear-out floating windows, layout serialization) rather than to be built.

## What carries over, what dies

**Carries over unchanged:** everything in `apps/desktop/src/main/` — `WorkspaceSession`, the
37 commands, `stack.check`, undo, the IPC channels, `vnasset://`, the catalog build step.
The pure renderer cores with `tests/` siblings (`script.ts`, `coverage.ts`, `taskGraph.ts`,
`layout.ts`, `hit.ts`, `attempts.ts` and kin) — they are framework-free by the repo's own
rule and become the editors' logic layer. `@vn/scriptedit`'s pure barrel for mid-gesture
verdicts. The `--mock`/`--project` flags.

**Dies:** every `.tsx` file (~6,300 LOC), `react`/`react-dom` from `apps/desktop`'s
dependencies, the `Room`/`StudioMode`/`FloorMode` vocabulary end to end, the single
window-level keydown handler, and the by-room organization of `styles/` and
[`../../reference/desktop-app.md`](../../reference/desktop-app.md).

**Changes shape:** `view.*` commands (rooms → editors), `.vndesktop/session.json` (panel
widths → serialized screen layout), `tokens.css` (design contract re-expressed as a path.ux
theme — `--sodium`/`--signal` survive as the two accent hues; the rule "no new accents"
survives with them).

## Ground rules

- **path.ux is a git submodule** at `vendor/path.ux`, cloned from
  `https://github.com/joeedh/path.ux`. It carries its own nested submodule
  (`scripts/path-controller`), so setup is `git submodule update --init --recursive`. It is
  *not* a pnpm workspace member — vite compiles its TypeScript source directly through an
  alias, so there is one build pipeline and no prebuilt `dist/pathux.js` to keep in sync.
  path.ux's own internals stay checked by its own repo; **we check against declarations we
  regenerate from that same source**, so there is no committed artifact to drift (see
  [step 1](#1-submodule-and-build-wiring--shipped) for why, and what it cost).
- **`@vn/commands` remains the only write path.** path-controller ships inside the
  submodule, and path.ux's `Context` contract requires `api` (a DataAPI/ModelInterface),
  `screen` and `toolstack` — so we *provide* them, minimally: the DataAPI is registered over
  a small renderer-local UI-state store (selection, theme, per-editor view state) so widgets
  can bind, and the `toolstack` hosts only path.ux's own screen operations (splits, docks).
  Document state never enters either: a widget that would mutate the project dispatches a
  command via the existing `exec`, and document undo stays `command:undo` on shadow refs.
  This is the "not adopted as app↔UX glue" decision made precise: path-controller runs, but
  only under the UI.
- **One selection.** The scene/shot/character selection becomes shell state in that UI-state
  store, observed by every editor — retiring the three independent `useState` selections.
  Selection and layout both persist across relaunch.
- **The mid-gesture verdict contract survives verbatim.** Overlays call the same pure rules
  the command runs. Two new rulings for the pane world, decided now: a semantic drag never
  crosses an Area boundary, and screen-mesh splitters are inert while a semantic gesture is
  in flight.
- **Keyboard routing is per-area.** path.ux keymaps on the focused Area replace the window
  keydown; the palette (`/`), undo accelerators and Escape become app-level keymap entries.
- **Every editor registers through `registerEditor(cls, 'vn.Name')`,** never by calling
  `Area.register` + `STRUCT.inherit` by hand. nstructjs defaults a struct's name to
  `cls.name`, which esbuild minifies; a layout saved by one build then names a struct the
  next build does not have, and `ScreenArea.loadSTRUCT` answers that by silently falling
  back to the *first registered* area class. See [step 2](#2-the-shell--shipped). It answers
  an unknown **area name** the same silent way, so `registerEditor` records the names too and
  `restoreLayout` discards a layout naming an editor this build has not got — otherwise
  deleting an editor renames every remembered pane rather than failing.

## The editors

Seven exist and port; the rest arrive later with their backend items. Port order is
cheapest-first so the shell hardens before the hard ones land:

| # | Editor | From | Notes |
| --- | --- | --- | --- |
| 1 | Play runner | `rooms/play/` | Simplest DOM; also gets the missing frame→shot/scene jump, closing the "PLAY is a dead end" item |
| 2 | Story graph / task DAG | `renderer/graph/` | The shared canvas is already imperative + `ResizeObserver`; closest to framework-free today |
| 3 | Task list + inspector | `rooms/floor/` | Lists and detail panes; first real use of sidebar panels |
| 4 | Coverage timeline | `rooms/floor/timeline/` | First semantic-drag editor; proves the gesture rulings |
| 5 | Branch editor | `rooms/studio/branch/` | Second gesture surface |
| 6 | Script column | `rooms/studio/script/` | The hardest: list-of-lines editing, open-row keystroke ownership, confirmed cross-scene acts — all its rules are already in pure modules |
| 7 | Convo (agent) | `rooms/studio/Convo.tsx` + `useAgent` | Ports last; also *unnests* — the editors stop being children of the conversation |

The gate gets **one** surface: a status element in the shell (header or footer), plus the
approval flow — replacing the four partial ones. Future editors (wiki/bible, document tree
sidebar, backlink panel, project picker) are named here so they have a declared home, but
they belong to their backend items (3, 9, 10 in the task list) and are out of scope.

**As shipped, only the project picker landed** (`Open Project…` in the app menu). Deferring the
other three here while items 3 and 9 deferred the panes back to this plan left them owned by
nobody: the backends are built and tested and nothing draws them. They are now item 12,
[`wiki-and-document-tree-editors.md`](wiki-and-document-tree-editors.md).

## Steps

### 1. Submodule and build wiring — **shipped**

Add the submodule, the vite alias, the tsconfig entry for `check:renderer`, and a smoke
Area rendering inside the Electron window behind a `--pathux` flag. CI/`pnpm build` must
fail loudly when submodules are uninitialized (a doctor check naming the
`--init --recursive` command), not with a resolver error.

**The doctor.** `scripts/check-submodules.mjs`, wired as `pnpm check:setup` at the root and as
the first step of `@vn/desktop`'s `build`. It reads `.gitmodules` recursively rather than
hard-coding a path, so path.ux's own nested `path-controller` is covered by the same walk,
and a repo with no `.gitmodules` at all passes — which is why it could land before the
submodule did.

**The typecheck seam, and why it is not what this plan first implied.** Pointing
`paths.pathux` at path.ux's source produced 2017 errors, none of them ours: our
`tsconfig.base.json` sets `noImplicitOverride` (763), `noUncheckedIndexedAccess` (~1100)
and `verbatimModuleSyntax` (96), and path.ux's own tsconfig sets none of the three. The
choices were to relax those flags over the subtree that is about to become the *entire*
renderer — a permanent quality regression on the ~6000 lines we are about to write — or to
stop checking path.ux's internals from here. The committed `vendor/path.ux/dist/*.d.ts` is
not a third option: it is esbuild-degraded (`declare var Vector2: any`, and `DataAPI`,
`DataStruct`, `ScreenArea` and `PanelManager` missing outright), so it passes by having no
types at all.

So `apps/desktop/pathux-types.tsconfig.json` emits real declarations from the `pathux.ts`
entry under path.ux's own looser options, into `apps/desktop/dist/pathux-types` (gitignored;
path.ux's `types/` is *not*, and writing there would show the submodule dirty). It runs as
`build:pathux-types`, first step of `@vn/desktop`'s `check`, in ~1.6s for 115 files —
regenerated on every check, so nothing can drift. The asymmetry is the design: **vite
compiles path.ux source, `tsgo` checks us against declarations built from that same
source.** A negative probe confirmed the declarations carry real generics rather than
silently passing on `any`.

**Two build details found by doing it.** path.ux uses auto-accessor fields
(`accessor x = 1`), which rollup's parser cannot read — naming an esbuild target below
`esnext` is what makes esbuild lower them first, so `vite.config.ts` pins `es2022`
(Electron 33 is Chrome 130; it costs nothing). And `vendor/**` joins `.prettierignore` and
eslint's ignores: a repo-wide `pnpm format` reformatted the submodule's own source under
*our* prettier config, which both fights its style and shows its gitlink as dirty.

**What the smoke shell is.** `apps/desktop/renderer/pathux/`: `ShellState` (the one
selection), `defineShellApi()` (a DataAPI over it, plus path.ux's `last_tool`), a
`ContextOverlay`-composed `ShellContext`, `VnScreen`, a `VnEditor` base, and one
`SmokeEditor`. `--pathux` reaches the renderer as a query flag on the loaded document —
the only channel available before any IPC handler is up — and `main.tsx` branches to a
lazy `import('./pathux/shell')`, so neither shell pays for the other while the ports land.
Verified over CDP in the running window: the screen mesh boots, the area renders with its
header, and setting `ui.sceneId` through the DataAPI reaches both `ShellState` and the
bound widget. Icons need installing by hand (`simple.loadDefaultIconSheet()` +
`setIconManager`/`setIconMap`) — an area header builds a help button, and a shell without
an icon manager throws there.

### 2. The shell — **shipped**

Screen boot, the minimal `Context` (UI-state DataAPI, screen, screen-ops toolstack), the
theme port of `tokens.css`, layout + selection persistence into `.vndesktop/session.json`
(nstructjs-serialized screen under a new key; the flat panel-width keys retire), the app
menu/header, and the palette as an app-level overlay. **Fix `App.tsx:100`'s
`mock: !isLive || true` in the new shell's run action from day one** (and independently on
the old shell — task-list item 11 — since the old shell survives through step 4).

**What shipped.** ~1270 lines under `apps/desktop/renderer/pathux/`: `shell.ts` (boot
order — selection, then layout or a default screen, then the header, then keymap, bridge,
persistence), `theme.ts` (`tokens.css` as a path.ux theme), `persist.ts`, `keymap.ts`,
`bridge.ts` (the one seam to main: every fact the header shows is pushed in, every act
leaves as a command), `palette.ts`, `editor.ts`, and `editors/header.ts`. The header is a
screen **area**, not a DOM bar above the screen — the same choice path.ux's own
`MenuBarEditor` makes — so the mesh owns its geometry and it survives the layout
round-trip like everything else. The run action seeds `mock` from `isLive` and nothing
else, so the bug named above cannot be reintroduced by copying the menu item.

**The palette is a screen popup, and its pure half is shared verbatim.** `app/catalog.ts`
— matching, blank-value rules, field coercion — is imported unchanged by both palettes,
because two palettes disagreeing about which command a query names would be a bug in
both. Only the widget building differs. Verified end to end over CDP against the live
window: the palette opens from the app keymap, lists 47 commands from the **live**
registry (not `commands.json`), filters, arms `stack.check`, runs, and leaves a real
`CommandRecord` in `window.vn.history(1)`; a refusal keeps it open.

**The trap that cost the most: minified struct names.** Both remembered areas came back
as the header editor. nstructjs's `STRUCT.inherit(cls, parent)` defaults the struct's name
to `cls.name`, esbuild minifies that to a letter or two that changes with the build, and
`ScreenArea.loadSTRUCT` does not fail loudly when the name is unknown — it falls back to
`editors[0]`, then to the *first registered* area class. So every remembered pane silently
becomes the same editor. The fix is `registerEditor(cls, structName)` in `editor.ts`,
which does both halves of registration and makes the written-down name unforgettable; it
is a ground rule above because ports 1–7 would each have hit it.

**A path.ux bug, found by looking at a bound widget.** `Container.textbox`'s last line was
`ret.text = "" + text`, run *after* `ret.update()` had already subscribed the datapath and
delivered its first value — so every path-bound textbox was stamped with the string
`"undefined"` at birth and only corrected itself on the next *change*. Fixed in the
submodule (`scripts/core/ui.ts`: only an explicit literal overrides the binding) with a
regression test in `vendor/path.ux/tests/ui_textbox_datapath.test.ts`. **The submodule
commit is the user's to make.**

**Persistence is one file, two keys.** `pathux.layout` (nstructjs, JSON, magic `VNSC`) and
`pathux.selection`, debounced 400 ms and flushed on `beforeunload`, in the existing
`.vndesktop/session.json` beside the React shell's keys. Both round-trip across a restart;
a corrupt or absent file reads back as `{}` rather than throwing, which is also how a
hand-edited file with a UTF-8 BOM behaves — quietly, so do not debug through one.

**Left for step 4, deliberately.** The flat `panel.<id>.width` keys are still written —
by `renderer/ui/Resizable.tsx`, which is React and is frozen. They retire when it does.
The React `Topbar`'s room nav is likewise not ported: step 5 replaces that vocabulary, and
porting it would only have to be undone.

### 3. Ports 1–3 (runner, graphs, list/inspector) — **shipped**

Read-only or list-shaped editors. Exit criterion, met: the new shell is livable for *watching*
a project — run, inspect, play — with the old shell still the default.

**Port 1, the runner — shipped.** `play/playback.ts` is the pure half (frames, navigation,
the save blob) with 11 tests beside it, and `editors/play.ts` is the editor: a raw-DOM stage
inside the `ColumnFrame`, path.ux widgets for the chrome above it. The stage is deliberately
*not* widgets — a VN frame is a background, a portrait and a text box, none of which is a
control, and `Container` guards its children with `instanceof UIBase` anyway.

- **The frame carries its shot, so PLAY stops being a dead end.** `show` beats gained an
  optional `shot` field (`@vn/types`, `@vn/export`), `framesOf` carries it down the frames
  between shot changes, and the editor publishes `ui.sceneId`/`ui.shotId` as the playthrough
  moves — so every other editor follows along. The React runner never did this; it is the
  one behavioural gain of the port, and it is why the schema changed.
- **Keyboard is the area keymap** (`Space`/`Enter`/`→` advance, `←`/`Backspace` back), which
  runs ahead of the screen keymap and after path.ux's own textbox guard — so the React
  runner's tag-sniffing has nothing left to do.
- **A missing playable is a sentence on the stage, not a crash.** No project open, or one
  with no generated art, is an ordinary state for an author to read and act on.
- **Second silent-fallback trap, same root as the struct-name one.** Deleting the smoke
  editor made every remembered pane come back as the header editor, because `loadSTRUCT`
  answers an unknown *area name* the same way it answers an unknown struct name. path.ux
  does not export `areaclasses`, so `registerEditor` now also records the name and
  `restoreLayout` discards a whole layout naming an editor this build has not got
  (`knownAreaNames()` + `buildable()`). It is the sibling of the ground rule above.
- Verified live over CDP against `examples/mySampleRepo`: frames advance by click and by
  key, the selection follows, a choice navigates the branch, and Save/Load/Reset/Back
  round-trip through `localStorage`.

**Port 2, the task graph — shipped.** `pathux/graph/canvas.ts` is the shared surface (two
co-transformed layers, pan/zoom, pick routing) and `editors/graph.ts` is the editor. The
derivation is untouched: `rooms/floor/taskGraph.ts` still owns the barrier, the ref edges and
the ghosts, and `renderer/graph/{layout,edges,hit,viewport}.ts` still own the geometry — all
with their existing tests, so only the markup and the gesture glue were rewritten.

- **The graph is a place to navigate from, not a picture.** `pathux/selection.ts` is the new
  pure half: clicking a task publishes the shared `ui.sceneId`/`ui.shotId`/
  `ui.characterId`, and a task naming neither returns the selection **identical**, so a click
  on an export cannot cost the author their place. The React FLOOR kept a `selected` hash of
  its own that no other surface could see.
- **The gate is still a rule, not a node with an edge.** The barrier draws as a dashed rule
  across the layout bounds with an overhang, and its one affordance is a per-character button
  that opens the palette on `gate.approve` — the shell has no `view.room` vocabulary to jump
  through, and step 5 retires the one it had.
- **A raw DOM surface goes in the container's *shadow*, and this is the third silent trap.**
  `Container.appendChild` routes a `UIBase` into the shadow root but hands anything else to
  `super.appendChild`, which lands it in the light DOM — where a path.ux widget has no
  `<slot>`. The node is then present, findable and clickable from script, and never laid out
  or drawn: `getBoundingClientRect()` reads 0×0 and a percentage height never resolves. Port
  1's stage had the same bug and passed its DOM-query verification anyway. `VnEditor.
  appendSurface` is now the one way to mount a surface, and both editors use it.
- Verified live over CDP against `examples/mySampleRepo`: 30 tasks lay out and fit the area,
  wires and arrowheads draw, wheel-zoom anchors at the cursor, background drag pans, clicking
  a shot task moves the shared selection and exactly one card takes the selected border, and
  a doctored gate status draws the rule plus a working `aiko →` approve button.

**Port 3, the task list and the inspector — shipped.** `editors/tasks.ts` is the React
`TaskBoard` plus the gate bars that sat above it; `editors/inspector.ts` is `Inspector` +
`AttemptLoop`. Both are markup only: `rooms/floor/attempts.ts` still owns the review merge, the
`Corrections:` delta, the outcome and the triage, with its tests unchanged.

- **A task surface publishes `ui.taskHash`, and that is what the inspector watches.** The three
  authored ids answer "where in the story", which is not the same question as "which node" — a
  task naming neither scene nor character is still worth inspecting. So `taskHash` is a fourth
  piece of shared state, and the two surfaces are linked by it rather than by either knowing the
  other exists. It is deliberately **not persisted**: a content hash re-keys whenever a prompt
  changes, so one remembered across a re-plan names nothing.
- **Two questions, two marks.** In the list, the ring is the task the inspector is open on; the
  tint is every other card the authored selection is about. The React board had one highlight
  and therefore could not say both.
- **A hash the cached status has never heard of is a re-plan, not a miss.** The inspector
  re-fetches once on that condition rather than polling, and says so on screen when the task is
  still absent afterwards.
- **`pathux/dom.ts` is the shared raw-DOM vocabulary** — card, mono, stamp, row, subject, dot,
  the status colour — extracted rather than triplicated across three editors. It is what
  `styles/*.css` said in class names, restated in TypeScript because a surface has no theme
  sheet behind it. `selection.ts` moved up beside it for the same reason: the list asks
  `taskIsSelected` of a bare task, the graph asks `isSelected` of a node view.
- Verified live over CDP against `examples/mySampleRepo`: both surfaces have real layout boxes,
  30 cards draw, clicking one moves `ui.taskHash` and the derived scene/shot and the inspector
  redraws with that task's identity, deps, attempt spine and image; a pick in the graph editor
  drives the inspector identically; exactly one card rings while the character tasks tint; and
  the gate bar's `RESOLVE →` opens the palette on `gate.approve` with `characterId` prefilled
  and `stack.check`'s refusal already printed.

### 4. Ports 4–7 (timeline, branches, script, convo) — **shipped**

The gesture editors, then the conversation. Each drag/keystroke behavior is checked against
its pure rule's tests, which do not change. Exit criterion: full parity; flip the default
shell; the `--pathux` flag inverts to `--react` for one release of caution, then both flag
and old code delete.

**The flag is flipped.** The desktop app boots the path.ux shell; `--react` boots the room
shell, which is now the one that has to ask. `renderer/main.tsx` is the switch and nothing
else: both shells are imported lazily — the React boot moved to `renderer/react-shell.tsx`, so
`vite build` splits it into its own chunk and the default shell does not pay for React —
while `styles/index.css` stays at document level for both, because custom properties are the
one thing that crosses a shadow boundary and `tokens.css` is what the editors' `var(--…)`
reads resolve against. Verified live: with no flag the document holds one `vn-screen-x` and no
`#root`; with `--react` it holds the STUDIO/FLOOR/PLAY tabs and no screen.

**Port 4, the coverage timeline — shipped.** `editors/timeline.ts` is FLOOR's strip: the
script down one column, brackets beside it, the wardrobe under it. `coverage.ts`, `drift.ts`,
`editing.ts` and `wardrobe.ts` are imported unchanged, and the state machine the React
component kept in its own `.tsx` is now `pathux/timeline.ts` with a `tests/` sibling — twelve
tests over what a grab captures, what aiming it at a row makes of it, and what the author is
told.

- **The gesture is judged once, at the grab.** `grabEdge`/`grabShot` call the same
  `interaction.targets` an agent would, keyed by row; every pointer move is a map lookup.
  So the sentence shown mid-drag, the drop that is allowed, and the answer
  `interaction.targets` gives are one verdict, and the commit is `verdict.invoke` verbatim.
- **Mid-gesture the strip holds still.** Only the band tints, the ghost, the drop rule and the
  notice repaint; `update()` returns early while a gesture is live, because the row under the
  pointer is read from the DOM and rebuilding would replace the nodes the drag is aimed at.
  A selection the grab published lands on release.
- **The surface carries its own stylesheet** (`VnEditor.adoptStyle`, new). Document CSS does
  not cross a shadow boundary — only custom properties inherit — and the strip's auto-growing
  editor is a `::after`, its handles are `:hover`, its open row is `:has()`. None has an inline
  form. `styles/timeline.css` is imported `?inline` rather than copied, so the two shells share
  one sheet for as long as both exist; the editor adds only the box-sizing reset and the notice
  strip, which was a member of FLOOR's bar and cannot be a path.ux label because a label has no
  tone colour.
- **An open row stops its own keydown.** path.ux's screen keymap is a bubble-phase window
  listener and its textbox guard only recognizes its own widgets, so without this `/` opens the
  palette in the middle of a sentence.
- **The scene is the shell's, not the editor's.** `ui.sceneId` changing from anywhere is a
  *reload*, not a redraw — drawing the old scene's coverage under the new scene's name is the
  bug that shape prevents.
- Verified live over CDP against `examples/mySampleRepo`. An accepted edge drag tints the
  claimed row, draws the ghost, previews `arrival__establishing covers 2 line(s).` and on
  release commits and closes the gap; a refused one draws a vermilion ghost with the command's
  own sentence and commits nothing; a drop that changes nothing leaves no sentence behind. A
  reorder rules the drop line at the right edge and commits, reordering the prose while every
  shot's coverage stays put. The line editor opens, grows as you type, prints `stack.check`'s
  drift warning while typing, commits on Enter and discards on Escape — and `/` never reaches
  the palette. Both wardrobe sections render their inheritance chain, and setting the scene
  marker turns the shot row into the "hides the scene's …" warning.

**Port 5, the branch editor — shipped.** `editors/branch.ts` is STUDIO's canvas of index cards
on the same `GraphCanvas` port 2 built. `graph.ts`, `grab.ts`, `compose.ts` and `tween.ts` are
imported unchanged; the gesture state machine that lived inside `BranchEditor.tsx` — and was
never tested — is now `pathux/branch.ts` with a `tests/` sibling, sixteen tests over the three
drags.

- **Position is not semantic, so a drag means something instead of moving something.** There is
  no `x`/`y` on a `Scene`; the layout is automatic. `grabCard`/`grabHandle`/`grabArrow` capture
  every candidate's verdict once, from the same `branchConnect`/`branchSplice`/`branchUnwire`
  an agent would ask, and `aim` is the one entry a pointer move needs — including the promotion
  from press to splice past `SLOP`, which re-aims in the same move so a big jump lands on the
  wire it ended over.
- **A claimed gesture calls `preventDefault()`.** That is `GraphCanvas`'s protocol for "this
  pointer is spoken for"; without it the canvas pans underneath an unwire drag, which is the one
  gesture that starts over empty background. The React version had no such problem because its
  overlay ate the event.
- **One persistent overlay host**, handed to `setOverlay` once and mutated in place: the
  per-wire verdict paths, the ghost wire, the selected edge's endpoint disc and the carried card.
  `draw()` re-appends it, so a pointer move repaints the overlay without rebuilding the content.
- **The edge label opens on `pointerdown`, not `click`.** Raw DOM has no reconciliation: a
  redraw between mousedown and mouseup destroys the button and the click never lands. The open
  `<input>` is held across redraws and re-`focus()`ed after each draw — the relayout tween runs
  `setContent` per frame — and the `blur` that re-parenting raises is ignored, or the field would
  commit itself away on the next frame.
- **The namer is raw DOM inside the surface**, not path.ux widgets in the bar: Enter, Escape and
  autofocus parity are exact, and it stops its own keydown for the same reason the strip's editor
  does. `delete <scene>` asks `stack.check` on hover and shows the answer in both the notice line
  and the button's tooltip.
- **The selected scene is the shell's.** A card clicked here sets `ui.sceneId`, so the coverage
  strip follows — the room used to keep that selection to itself.
- Verified live over CDP against `examples/mySampleRepo`. Wiring a handle onto a card previews
  `greet → ending ("New choice").` with the ghost wire and commits `story.setChoice`; carrying a
  card over the wires paints a verdict path per wire, tints the one under the pointer and reads
  `Spliced epilogue into arrival → greet.`; an arrowhead pulled 6px says nothing and pulled 60px
  reads `Removed arrival → observe ("Hurry to an empty seat").`; Escape cancels all three. `+
  scene` writes and selects it, hovering `delete rooftop` prints `greet (next), observe (next)
  still point(s) at rooftop.`, and a wire that appends a choice opens that choice's label focused,
  which commits on Enter.
- **Parity gap, deliberate:** the React click also called `seed('Revise scene <id> — ')` into the
  agent composer. Convo arrives in port 7; the seed comes back with it.

**Port 6, the script pane — shipped.** `editors/script.ts` is STUDIO's page of lines: the heading,
the lines under it with their ids and cues, the composer at the end. `rooms/studio/script/script.ts`
— `scriptRows`, `keyAct`, `stepsOf`, `checkOf`, `splitBoundaries`, `mergeTarget`, `dropTarget`,
`nextEditing` and the rest — is imported unchanged, and the drag machine that lived inside
`ScriptEditor.tsx` and was never tested is now `pathux/script.ts` with a `tests/` sibling: six tests
over what a grab captures, what aiming it at an insertion point makes of it, and what the author is
told.

- **The gesture is judged once, at the grab**, like the other two. `grabLine` asks the same
  `scriptMoveLine.targets` an agent would, keyed by insertion point (`TOP` or the line to land
  after), and every pointer move is a map lookup. An insertion point `targets` never judged is a
  drop that would reorder nothing: no rule drawn, no sentence, no commit.
- **`stateKey()` excludes the draft and the pending act's props**, on purpose — path.ux calls
  `update()` every frame, so keying on what is being typed would rebuild the field under the caret
  once per frame and lose it. The open textarea and the split/merge strip's inputs are persistent
  nodes that mutate their state in place and only re-run `stack.check`.
- **An open row stops its own keydown**, for the reason port 4 wrote down: the screen keymap is a
  bubble-phase window listener, so without it `/` opens the palette in the middle of a line.
- **Opening a row does not clear the notice.** The continuation an act opens carries on from that
  act, so what the command said about it is still the last thing that happened; only a row the
  *author* opens (`openLine`, `compose`) is a new act and clears it. That was the one parity bug the
  live pass caught — the `ok` sentence blanked as the composer reopened after an insert.
- **The scene is the shell's**, as in port 4: `ui.sceneId` changing is a reload, not a redraw.
- Verified live over CDP against `examples/mySampleRepo`. A line dragged by its gutter draws the
  drop rule at each insertion point with the command's own sentence and commits `story.moveLine` on
  release; the split and merge strips print `stack.check`'s sentence before running and cancel
  clean; the cue picker lists the workspace's cast and closes on Escape; the line editor grows as
  you type, previews `stack.check` while typing, discards on Escape, and `/` never reaches the
  palette; the composer inserts, reopens itself for the next line, and closes on an empty Enter.
  Selecting a card in the branch pane moved this pane to that scene. Every scratch edit was reversed
  through the same commands.

**Port 7, the conversation — shipped.** `editors/convo.ts` is the vnauthor pane: the transcript, the
plan card, the dialogue box and the composer, styled by `styles/studio.css` imported `?inline` as the
other ports import theirs. The conversation itself is now a **value** — `pathux/convo.ts`, reduced
from the same `AgentEvent` stream `useAgent` reduced untestably inside a `useEffect`, with nine tests
over what each event does to it.

- **This port unnests.** In the React shell the branch and script editors were passed to `Convo` as a
  `surface` prop and rendered **inside** it, which is why only one of them could be open and why the
  composer had to survive their swap. Here they are areas of the screen mesh, so the conversation is
  a pane like any other and the author decides whether it shares the window with the page it is
  about — or opens two of it.
- **The live conversation is a module subscribed at boot** (`pathux/agent.ts`, installed by
  `shell.start()`), not editor state, because the agent streams whether or not a convo pane is open
  and a pane opened afterwards has to show what was already said. Verified by opening a second convo
  pane onto the same transcript.
- **A turn is a command.** `ask` runs `agent.run` through the bridge rather than the `agent:run`
  channel the React shell used, so a turn the author types and a turn the palette runs are one act
  with one record. `plan:decision` stays a channel on purpose: it is the reply to a request main is
  already blocked on, not an act of its own.
- **Clearing follows the command, not the button.** `bridge.onExec` (new) lets the store watch the
  registry, so `agent.clear` from the pane and from the palette empty the transcript identically.
  Named gap: `window.vn`/CDP goes straight to main and `agent.clear` emits no event, so a clear run
  that way leaves the pane's transcript standing.
- **The composer is built once and never rebuilt.** It is what the author is typing into and where a
  seed lands, so it outlives every redraw of the transcript above it — and it stops its own keydown,
  for the reason ports 4 and 6 wrote down.
- **Port 5's declared parity gap is closed.** A card click calls `seed('Revise scene <id> — ')`; the
  pane takes the seed once, focuses the field and puts the caret at the end. Seeding happens even
  when the selection did not move — clicking the card that is already open is how you ask about it
  again.
- Verified live over CDP against `examples/mySampleRepo`. A turn shows the author's bubble, disables
  the composer, and lands the agent's final in the dialogue box with an `agent.run(input=…)` record
  stamped `source: 'ui'`; `/` typed in the composer does not open the palette; the plan card renders
  its numbered steps over `Reject` / `Approve →`; `Clear` empties the transcript, returns the badge
  to plan mode and records `agent.clear()`; clicking a branch card seeded and focused the composer.

### 5. Retire the room vocabulary — **shipped**

`Room`/`StudioMode`/`FloorMode` leave `src/shared/ipc.ts`; `view.room`/`view.mode`/
`view.panelSize` are replaced by editor-addressed commands (working names: `view.open`,
`view.focus`, `view.layout`) — designed with the agent in mind, since "the AI agent should
be able to help the user drive the app, showing the UX to edit or view any part of the
story project" is a requirement and the command catalog is how it does that. `catalogOf`
output, `commands.json`, the command tests and the palette follow.

**The vocabulary is one list, and both processes read it.** `apps/desktop/src/shared/editors.ts`
is `EDITORS` — id, title, and a line of what the editor shows — and nothing else. Main builds
`view.open`/`view.focus`'s props from `EDITOR_IDS` and its sentences from `editorTitle`; the
renderer registers its editors under the same ids and the header's View menu is a `map` over the
same array. Main cannot see the editor registry, so `checkEditorNames()` runs once at boot and
warns about anything the commands offer that this build has not registered — the failure it
replaces is a palette entry that does nothing until someone picks it.

**Five commands, and none of them names a room.** `view.open(editor, where)` where `where` is
`here` | `right` | `below`; `view.focus(editor)`; `view.close()`; `view.layout()`; and
`view.palette(open)` unchanged. `view.mode`'s two-prop pairing — the thing `prop.oneOf` could not
express, so `run` had to check the pair and throw — is simply gone: a pane holds any editor, so
there is no illegal combination left to refuse.

**Main is optimistic, and the mesh corrects it.** A `view.*` command returns its sentence
without waiting, because only the renderer knows how many panes there are and what is in them.
`applyView` returns a sentence **instead of** the command's when the mesh disagrees — `No pane is
showing Inspector.`, `This is the only pane — closing it would leave nothing.` — and the bridge
says that one as an error. It returns the string rather than calling `say` itself, which is what
keeps `view.ts` out of an import cycle with `bridge.ts`; for the same reason `view.layout` calls
`app.rebuild()`, a `ShellApp` member, rather than importing the boot path.

**The pane rules are pure.** `pathux/panes.ts` reduces the mesh to a `Pane[]` (editor, chrome,
active, size) and answers three questions over it — which pane is showing an editor, which pane a
new one goes in (the active non-chrome one, else the biggest), and which to close (`NO_PANE` when
fewer than two non-chrome panes remain, so the header never counts as the last pane). Eight tests
in `pathux/tests/panes.test.ts`; `view.ts` is the impure half that maps `sareas` onto it,
`AreaFlags.HIDDEN` being what marks chrome.

**Opening what is already open is a focus.** `view.open(editor)` with the default `where: 'here'`
focuses the pane already showing it instead of replacing the pane the author is in with a second
copy — an author who says "show me the script" while looking at it means "put me back in it".
`right`/`below` always split.

**The default layout is now something to work from**, because `view.layout` restores it: branches
on the left, the conversation on the right. `rebuild()` unlistens and destroys the old screen
before dropping it — two live screens both answering the pointer is the shape of a haunted
layout — and re-arms `watchLayout`, which had to come out of `installPersistence` since
`onLayoutChange` is not part of `STRUCT` and a replacement screen starts with none.

**The retired shell keeps its own vocabulary.** `Room`/`StudioMode`/`FloorMode` moved to
`renderer/rooms/rooms.ts`, imported by the five components that still speak it, and `App.tsx` no
longer handles `room`/`mode` effects at all: a room shell has no panes to open an editor in, so
it ignores `view` effects and drives itself from its own tab nav. The types die with `--react`.

Verified live over CDP against `examples/mySampleRepo`: `view.open(editor=timeline where=below)`
split a fourth pane and made it active; `view.focus(editor=convo)` moved `sareas.active` without
moving anything else; `view.focus` on an editor no pane held put `No pane is showing Inspector.`
into all four note frames while the record still read `ok`; `view.open(editor=script)` replaced
the active pane in place; `view.close()` collapsed it; `view.layout()` left exactly one
`vn-screen-x` holding `branches,convo,header`; and the header's View menu built its eleven items
(eight editors, a separator, Close Pane, Reset Layout). Under `--react` the room shell still
mounts, still shows STUDIO/FLOOR/PLAY, and ignores a `view.open` without error.

### 6. Docs — **shipped**

[`../../reference/desktop-app.md`](../../reference/desktop-app.md) is rewritten organized by editor — its by-room structure
was part of the diagnosis, so leaving it would have described an app that no longer exists. The
shape is: the shell (panes and `view.*`, the header as a screen area, the bridge as the one seam,
`ShellState` as the one selection, per-area keymaps, and the two shadow-root rules
`appendSurface`/`adoptStyle`), then the shared graph canvas, then one section per editor —
Branches, Script, Convo, Coverage, Tasks/Task Graph/Inspector, Play — carrying every still-true
contract forward from the room sections it replaces, then the session store, which project is
open, the seeded workspace, and a closing section on the retired `--react` shell.

- **The one structural fact the rewrite had to say out loud:** the pure rule modules still live
  under `renderer/rooms/` and the new editors import them (`script.ts`, `taskGraph.ts`,
  `attempts.ts`, `coverage.ts`, `drift.ts`, `editing.ts`, `wardrobe.ts`, `graph.ts`, `grab.ts`,
  `compose.ts`, `tween.ts`, `diagnostics.ts`). Deleting the React shell means **moving** them, not
  deleting them — a reader who took "rooms/ is the old shell" literally would delete the logic
  layer along with the markup. The renderer file tree in the doc labels them as such.
- [`../../reference/desktopAppState.md`](../../reference/desktopAppState.md): category 2 is now the layout and the selection
  (`pathux.layout` / `pathux.selection`, what writes them, and why `taskHash` is excluded);
  category 3 is `ShellState` plus the conversation store instead of a table of React hooks; the
  data-flow walkthroughs name editors and commands rather than rooms and IPC channels; and the
  "switching workspaces" edge case, which still said restart-to-switch, is now the in-place switch
  item 10 shipped.
- `CLAUDE.md`'s renderer rules are restated for path.ux: the mesh and the submodule up front, the
  editor list as one shared vocabulary, `registerEditor`, `appendSurface`/`adoptStyle`, and the
  contract rules (pure core with a `tests/` sibling, `src/shared/` browser-safety, the mid-gesture
  verdict, the script editor's list-of-lines, an open row stopping its own keydown) kept verbatim
  in substance. Its pointer to `desktop-app.md` now names the editors, and so do the two rows in
  [`../index.md`](../index.md).

## Risks and accepted costs

- **Custom elements vs HMR:** `customElements.define` cannot re-define, so dev iteration on
  widget classes is full-reload, not hot. Accepted; the dev loop stays `vite` +
  full-page reload for the shell.
- **`@vn/debug2d`** keeps working for DOM-rendered editor content, but path.ux widgets that
  draw to canvas are outside its DOM adapter's sight. Accepted as a regression for now; the
  canvas adapter was always the research doc's phase 2, and this creates the first real
  demand for it.
- **Component-level tests remain absent** (jest stays node-only). Same posture as today; the
  pure-core rule is what makes it tolerable, so it is enforced for new editor code too.
- **Two shells during steps 3–4** cost double maintenance on anything touching the renderer.
  Mitigation: the old shell was frozen — bug fixes only (item 11 being the one known).
- **Sizing model friction:** path.ux drives Area geometry imperatively (`setCSS()` writing
  pixel sizes); editor content must be honest `height:100%`/`min-height:0` flex/grid inside
  its Area. The existing stylesheets already are (only 11 room-scoped selectors, one `100vh`
  in `shell.css`), which is what makes the port tractable.

## Acceptance

Every workflow the current app supports, demonstrated in the new shell: author a scene,
wire a branch, run to the gate **for real** (the run-button bug dead), approve, render,
watch in PLAY, undo a story edit with the refusal sentence intact — plus the pane-model
wins: split any two editors side by side, persist and restore the arrangement, and drive
`view.open` from the palette, the agent and CDP. `pnpm check`, `pnpm test`, `pnpm lint`,
`pnpm build` green with React absent from `apps/desktop`'s dependency tree.

## The deletion, as it went

Four things the deletion decided that the plan above did not:

1. **The rule modules moved to `renderer/rules/`, not to `renderer/pathux/`.** They are pure and
   shell-agnostic — that is why they survived the port untouched — so filing them under the shell
   that currently imports them would have re-made the mistake the port just undid. Twenty-six
   files moved with their `tests/` siblings; not one line of rule code changed, only the depth of
   its imports.
2. **`styles/index.css` is now one `@import`.** Only `tokens.css` belongs at document level:
   an editor's surface lives in a shadow root, and custom properties are the one thing that
   crosses it. `branch.css`, `studio.css`, `script.css` and `timeline.css` are already adopted
   `?inline` by the editors that own them, so `shell.css`, `floor.css`, `play.css`, `graph.css`
   and `taskgraph.css` went with the markup they styled — the emitted stylesheet fell from
   ~30 kB to 1.0 kB.
3. **The clickable diagnostics list did not survive the port**, and the deletion is what
   surfaced it. `Rail.tsx` listed each diagnostic and selected the scene it named; the path.ux
   header only *counts* them (`pathux/bridge.ts`). The rule it used — `diagnosticScene`, tested —
   was kept and moved to `rules/diagnostics.ts`, so what is missing is a surface, not a rule.
   Recorded here rather than quietly dropped.
4. **`renderer/session.ts` (`useSessionValue`) went entirely**, with no successor: the path.ux
   shell persists through `pathux/persist.ts`, and the flat `panel.*.width` keys it wrote have
   no reader left. A session file still holding them is ignored, not migrated.

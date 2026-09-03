# Guided tours and the anchor layer

A guided tour walks the author through a task in the desktop app. Each step highlights the control
to use and shows a one-line instruction; the tour waits until the author has used that control,
then moves to the next step. The tour never performs a step itself.

To highlight a control, the app needs a mapping from commands to the DOM elements that run them.
That mapping is the anchor layer: every control an editor draws registers an anchor recording
which command, with which props, a click on it runs. Part I covers the anchor layer, Part II the
tour built on it.

<!-- toc -->

- [Design rule](#design-rule)
- [Part I — the anchor layer](#part-i--the-anchor-layer)
  * [Offers](#offers)
  * [Recording anchors](#recording-anchors)
  * [Keys](#keys)
  * [`dom` and `pick` anchors](#dom-and-pick-anchors)
  * [The registry](#the-registry)
  * [The anchor map](#the-anchor-map)
  * [Resolution](#resolution)
  * [Cross-checks](#cross-checks)
  * [Enforcement](#enforcement)
- [Part II — the tour](#part-ii--the-tour)
  * [Steps](#steps)
  * [What a step displays](#what-a-step-displays)
  * [The overlay](#the-overlay)
  * [Advancing](#advancing)
  * [Palette fallback](#palette-fallback)
  * [Sources of tours](#sources-of-tours)
  * [Commands](#commands)
- [Files](#files)
- [See also](#see-also)

<!-- tocstop -->

## Design rule

An anchor is registered from the same object that installs the control's click handler. `act()`
in `renderer/pathux/anchors.ts` takes one `Offer` (the command id and props the control runs),
sets `node.onclick` from it, and records the anchor from it. A separate annotation, such as a
`data-command` attribute, would be a description of the handler and could drift from it when the
control was rewired. Sharing one object makes drift impossible.

The same principle covers refusals. When a command cannot run, the tour displays the reason string
the command's own rule module returned. Tour code never composes a reason of its own.

## Part I — the anchor layer

### Offers

A rule module describes each control as an `Offer`: either the invocation the control runs, or the
reason it is disabled.

```ts
type Offer = (Action & { ok: true; label?: string }) | { ok: false; reason: string; id?: string };
```

A disabled control is still registered as an anchor when its `Offer` carries a command id (`id` on
the refusal, or `about` in `ActOptions`). This lets a tour highlight the disabled control and show
its reason, instead of reporting that the command has no control.

### Recording anchors

- `redrawing(editor, part)` starts a recording pass and returns an `AnchorPass`. Its `act`,
  `record`, `item`, `pick` and `pickItem` methods add anchors to the pass.
- Each pass replaces the previous pass for the same `editor/part` in full and increments a global
  generation counter. This is required because `rebuildBody()` clears the editor surface with
  `surface.textContent = ''` on every redraw, so a DOM reference from an earlier pass is stale. For
  the same reason, no code outside the registry may keep an `Anchor` object: the tour stores the
  anchor's key and looks it up again each frame.
- `part` lets an editor that redraws separate regions from separate places (the asset editor
  redraws its toolbar and its body independently) replace one region's anchors without discarding
  the other's.
- `act(node, offer, run, opts)` sets `node.onclick` rather than calling
  `addEventListener('click')`. path.ux's `Button` invokes `onclick` directly on touch input, where
  no DOM click event is dispatched.

`ActOptions` supplies facts the `Offer` does not carry:

| Option      | Meaning                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `supplies`  | Prop names whose values are read from the widget when the command runs (a textarea's text, a typed id).              |
| `form`      | A click opens the command's form in the palette instead of running it; every prop is entered there.                  |
| `on`        | A discriminator appended to the key when one pane has several controls for the same command (a chunk key, a task hash). |
| `about`     | The command id a disabled control belongs to, when the refusal `Offer` does not carry one.                           |
| `key`       | An `item:` key, for a control that selects a subject rather than running a command.                                  |
| `publishes` | The `ui.*` fields a selection control sets.                                                                          |

### Keys

- Command anchors: `cmd:<id>`, or `cmd:<id>#<on>` when `on` is given.
- Item anchors: `item:<kind>/<key>`, for a control that selects something (a scene row, an asset
  thumbnail). `<key>` must be a domain id, never an index, a position or a label. An index changes
  on re-sort, and tree labels are only made unique when two of them collide.
- Every document-tree row also has a `data-anchor="<kind>/<key>"` attribute. The sweep script
  (below) uses it to click a row and select a subject without depending on the tree's DOM
  structure.

### `dom` and `pick` anchors

An anchor's `via` field records how a click reaches it, which determines how the anchor is
verified.

|               | `dom`                           | `pick`                                             |
| ------------- | ------------------------------- | -------------------------------------------------- |
| Click target  | the node itself                 | the canvas beneath the node                        |
| Registered by | `act()` / `record()`            | `pick()` / `pickItem()`                            |
| Verified by   | a hit test at the node's centre | calling the canvas's `pick()` at the node's centre |

The graph editors draw node boxes in a layer with `pointer-events: none`, so clicks pass through
to the canvas, which resolves them with its own `pick()`. The box element is still stored on the
anchor so its rect can be read each frame: the box moves on pan and zoom, so a rect copied at draw
time would be stale by the next frame.

### The registry

- `window.__vnAnchors` exposes `generation()`, `dump()`, `tree()` and `strays()`. It is present
  in production builds, unlike `window.__vnDebug`, because the tour uses it at runtime.
- `anchorSnapshot(open)` produces the `LiveAnchors` object the resolver reads. The caller passes
  the list of open panes, since only the pane mesh knows that. The registry computes which anchors
  are offscreen itself, from their rects.
- Anchors for a pane that is not open stay in the registry but are excluded from the snapshot.
  path.ux detaches an area on a tab switch and does not redraw it when the tab returns, so the
  records cannot be dropped when the pane closes.

### The anchor map

The tour needs to know which editors draw a control for a command before any pane is open (which
pane has the `prompt.condense` button?). That is the anchor map, `ANCHOR_MAP`, and it has two
sources:

- Derived: the document tree's right-click menu is built from `menuFor`, which is plain data, so
  `window.__vnAnchors.tree()` enumerates those entries without opening a pane.
- Measured: `scripts/sweep-anchors.mjs` connects to a running app over CDP, opens each editor in
  turn, dumps the anchors, and writes `apps/desktop/anchors.json`. The file is committed, at the
  app root rather than under the gitignored `dist/`, so a change in coverage appears in review as
  a diff.

`anchors.json` records the project title and the selected scene and shot it was measured with,
because many controls are only drawn when a subject is selected. A command absent from the file
resolves as `unanchored`, and the tour falls back to the command palette. The fallback is the same
whether the file is stale, the project was never swept, or the command has no control.

Re-run the sweep after changing anything under `apps/desktop/renderer/pathux/editors/**`:

```bash
pnpm build:desktop
pnpm vndesktop --mock --project <dir>   # keeps running; prints the port it opened
node scripts/sweep-anchors.mjs          # second shell, VN_CDP_PORT set to that port
```

`pnpm vndesktop` takes the first free port from 9222 upward and prints it. `scripts/cdp.mjs`
defaults to 9222, so set `VN_CDP_PORT` in the second shell if the launcher printed a different
port.

The sweep formats what it writes, since `pnpm lint` checks `anchors.json` like any other file. A
run that changes nothing but the `sweptAt` and `gitSha` lines is worth reverting rather than
committing: the coverage is what the file is for.

### Resolution

`resolveAnchor(map, live, action)` finds the anchor for a wanted invocation in a snapshot. It is a
pure function in `renderer/rules/anchors.ts` with node unit tests. It returns one of:

| Result          | Meaning                                                                                     | Tour response                                    |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ready`         | An enabled anchor matches.                                                                  | Highlight it.                                    |
| `input`         | An anchor matches, and the step's remaining props are ones the widget `supplies`.           | Highlight it and say what to type.               |
| `disabled`      | The matching anchor is disabled.                                                            | Highlight it and show the recorded reason.       |
| `offscreen`     | The matching anchor is scrolled out of the window.                                          | Scroll it into view and resolve again.           |
| `wrong-subject` | Anchors exist for the command id, but their props conflict with the step's.                 | Ring the row that selects the right subject.     |
| `pane-closed`   | The map lists editors for this command, and none of them is open.                          | Say which pane to open.                          |
| `absent`        | An editor the map lists is open, but it is not drawing the control now.                     | Fall back to the palette.                        |
| `unanchored`    | The map lists no editor for this command.                                                   | Fall back to the palette.                        |

Only an anchor carrying a command id is a candidate. An `item:` anchor has none, so a step whose
own id is missing — a malformed one, read from JSON that was not an object — matches nothing rather
than matching every row on screen.

`absent` and `unanchored` are kept distinct for the same reason `Interaction.targets`
distinguishes an empty target list from `UNRESOLVED`: `absent` describes the current screen,
`unanchored` describes the map, and a caller diagnosing a stale map needs to know which.

Prop matching uses subsumption rather than equality (`subsumes`). An anchor records only the props
known at draw time, and the prop the author is about to type cannot be recorded, so:

- every prop the anchor records must equal the step's value;
- a prop the step names and the anchor does not must be one the anchor `supplies` (the result is
  then `input`), or the anchor must be a `form` anchor, which accepts any prop because the form
  takes them all;
- any other difference is `wrong-subject`.

The `form` case is what makes the palette a valid resolution for any step rather than a last
resort.

A `wrong-subject` result also carries `holds`: which of the conflicting props the anchor itself
records a different value for. The rest are props the anchor neither records nor supplies — free
text, a flag, a step naming a prop this control does not take — and they name nothing the author
could select. Keeping the two apart is what makes the search below sound.

`resolveSubject` is that search. It looks at the held props' string values, and finds an anchor
that selects one of them two ways: an item anchor whose click `publishes` that value (an asset
hash, a `sceneId`), or one whose item key is that value read as a kind and a key
(`character:aiko` → `item:character/aiko`). The pane that gave the mismatch is preferred, so the
one the author is already looking at is the one that retargets. Empty values are skipped, since a
click that clears a field publishes `''`.

Two cases do not resolve, and both are answered rather than papered over:

- A rung below the entity — `character:aiko/gala`, `shot:greet/s2` — has no document-tree node and
  no `publishes` record, so the step is `blocked` naming the subject. That is the right outcome:
  the alternative is the author's art note written onto whichever rung the pane was showing.
- Where the held props name nothing, the answer is the control's own: the ring as before, or the
  control's refusal where it is greyed. A refused offer is recorded with no props at all, so a
  greyed control with an empty record lands here.

### Cross-checks

Both halves of the layer are checked against an independent source:

- Enabled state against `stack.check`. The sweep calls `stack.check` for every anchor it records
  and reports, without fixing, each case where the control's enabled state disagrees with the
  stack's verdict. This caught the branch editor drawing `delete <scene>` enabled for the entry
  scene, which main refuses to delete; the editor was calling `stack.check` only on hover, and now
  calls it when the button is drawn.

  Anchors with `supplies` or `form` are exempt, because their props are deliberately incomplete and
  the verdict would be about the blank rather than about the project. That exemption hides a real
  case: the task graph's gate buttons were drawn live on a project with nothing rendered, so a tour
  rang a button whose form could not be completed. The editor now asks as it draws, passing the
  blank hash explicitly, and greys the button only when `gate:candidates` is empty — with candidates
  on file the form is where the portrait is named, so the button stays live and the sentence goes to
  its tooltip.
- Recorded rect against a hit test. `landsOn` checks whether a click at the anchor's centre would
  reach it: for a `pick` anchor by calling the canvas's `pick()`, for everything else through
  `hittest.ts`, which descends into shadow roots because `document.elementsFromPoint` stops at a
  shadow host and every editor surface is inside one. Disabled controls are skipped, since they
  usually have `pointer-events: none`. Points outside the window are skipped too; that case is
  already reported as `offscreen`.

`getBoundingClientRect()` does not report the hit area. A gen-graph socket is an 8×8 element with
a `::before` of `inset: -5px`; the browser hit-tests the pseudo-element as part of the socket, so
the socket accepts clicks over 18×18 while its rect reports 8×8, and `getClientRects()` excludes
pseudo-elements as well. The ring is drawn `RING_PAD` px outside the rect, and is enlarged to
include the hit element's rect when the hit test lands on a descendant that extends outside it.

### Enforcement

CI has no app, no CDP port and no workspace, so the checks are split:

- Blocking: `apps/desktop/src/main/tests/anchorcoverage.test.ts` reads the committed
  `anchors.json` and fails if a record names a command that no longer exists, if the file's
  command list differs from the live registry's, or if the number of anchored commands has dropped
  below `FLOOR`.
- Advisory: the sweep itself, run by hand. It is the only place disagreements and strays are
  reported.

## Part II — the tour

### Steps

A `Tour` (`src/shared/tours.ts`) is an id, a title, a one-sentence `what`, and a list of steps.
Each step has a `say` instruction and one of four kinds:

| Kind      | The author is asked to                       | Fields                                            |
| --------- | -------------------------------------------- | ------------------------------------------------- |
| `command` | click a control that runs a command          | `id`, optional `props`                            |
| `input`   | type into a field and commit it              | `id`, `supplies` (the prop typed), optional `props` |
| `select`  | select a subject by clicking an `item:` anchor | `itemKind`, `key`                               |
| `gesture` | drag something                               | `id` (an interaction id), `carried`, optional `target` |

A `gesture` step is evaluated with the same `Interaction.targets` a real drop calls, without arming
anything or moving the pointer. The tour highlights the element to pick up and outlines each target
that would accept it. `Interaction.targets` needs the surface's current state, so each editor
registers a state reader in `renderer/pathux/gestures.ts` under its interaction namespace, with
`gestureState(namespace, editor, read)`. The editor is part of the registration because two panes
can show the same scene (the document tree and the branch editor), and the drag has to start on
the one that runs the gesture.

A registration outlives its pane, for the same reason an anchor does, so `verdictsFor` takes the
open set and answers nothing for a namespace whose editor is not in it. The step then reads as
having nothing on screen that runs the gesture, which is what a closed pane is. Without the check
its verdicts are read first and its refusal reported as the step's own answer.

### What a step displays

`guide(map, live, state, judge, refused)` in `renderer/rules/tour.ts` computes what the overlay
shows for the current step:

- `ring`: highlight an anchor, with the instruction as a caption.
- `pick`: highlight the row that selects the step's subject, because the control the step names is
  on a different one. The caption carries the instruction and a second line saying to click this
  first. Not called `select`, which is already a step kind and resolves to `ring`.
- `route`: no control is drawn for this command; open the palette instead.
- `open`: a pane must be opened first; names it.
- `blocked`: the step cannot run now. Carries the reason, from the command's rule or from
  `Interaction.targets`, and, when the disabled control is on screen, its anchor, so the control is
  highlighted with the reason in its caption.
- `done`: no steps remain.

A control that opens the command's form is drawn enabled, because opening a form is not what the
command refused. The refusal belongs to the command behind it, so `guide` takes a `refused` lookup
alongside the snapshot and turns a `ring` into a `blocked` when the stack has answered no. The
lookup is a plain function of a cache the caller owns: `stack.check` is asynchronous and lives in
main, while `guide` stays pure over what is drawn.

`renderer/pathux/tour.ts` fills that cache. For the anchor a step points at it calls
`checkFor(anchor, props)` (`renderer/rules/precheck.ts`) to build the invocation to ask about, then
`command:check`, and stores the refusal under the anchor key. The answer lands a beat later and the
overlay's next re-resolve reads it. An entry is re-asked whenever an anchor's recorded props change.

A refusal describes the project rather than the screen, so it is cleared by anything that could have
changed the project under it. Three things do: `onWrote`; any command that ran successfully, since
`onWrote` does not fire for one that reports no written path, such as `project.setKey` writing a key
file outside the repository; and starting a tour, so refusals from the previous one do not stand.

`checkFor` exists because `stack.check` coerces props before it reaches a command's precondition.
Asking with a prop the widget has not supplied yet answers about the blank —
`missing required property "hash"` — where the useful sentence is `aiko has no portrait yet`.
Passing the blank explicitly as an empty value reaches the precondition, which is written for that
case. Nothing is invented: a required prop with no empty value, such as a number or an enum, leaves
the anchor unaskable, and a secret is never filled in even with a blank.

### The overlay

The highlight (the ring) is drawn in a fixed-position `<div>` with `pointer-events: none`,
appended to `document.body` with a z-index above every path.ux layer, including the docker's own
popups. Two timers drive it:

- a `requestAnimationFrame` loop re-reads the anchor's rect every frame, so the ring follows a
  scroll without lag;
- a `setInterval` every `RESOLVE_MS` re-runs `guide()`, since the step's target may have changed
  after a click, and repaints as well, because Chromium stops delivering frame callbacks to an
  occluded window.

If the hit test says a click at the ring's centre would not reach the anchor, the overlay first
calls `scrollIntoView` once, because a control clipped by a scrolling container still has a rect
inside the window. If the hit test still fails after that, it logs one `console.warn` per anchor
and leaves the ring where it is; it cannot distinguish an element covered by another from an
element that moved between frames.

The same layer draws a banner at the bottom of the window for as long as a tour is running: the
tour's title, which step of how many, and a button that runs `tour.cancel`. A step with a control
to point at says what to do in the ring's caption, so the banner shows only the title and the
count; a step with nothing to point at has no caption, and the banner carries the instruction and
where to find it.

The banner is what makes a tour visible at all when the first step routes to the palette. Before
it, starting a tour from the palette retargeted that palette to the step's command, and the only
other sign was a notification that cleared after a few seconds — so the author was left looking at
a form for a command they had not asked for, with nothing saying a tour had started. `retarget`
now also sets the search box to the command it moved to, so the list agrees with the form.

### Advancing

The tour subscribes to `onExec` in `bridge.ts` and advances when a successful command matches the
current step, whichever control ran it: a button, the palette, or a hotkey. Matching uses
subsumption (`satisfies`), so an `input` step matches regardless of the value the author typed for
its `supplies` prop, provided there is one: an `input` step exists to have the author supply a
value, and `art.setNotes` accepts an empty note as a legitimate value (it removes the note), so
committing the field blank would otherwise advance the step over a no-op.

What `satisfies` compares against is the recorded props rather than the real ones, so a bulk prop
arrives digested. A digest carries the value's byte length, so a bulk prop with nothing in it is
recognisable: `EMPTY_DIGEST` in `@vn/commands` is what one records as, and the rule reads it as a
blank field. A `prop.secret` records as `<secret>` whatever it held, so an empty one is past
telling — a limitation of the rule rather than a case it decides, and one nothing reaches today,
since `project.setKey` refuses an empty key before a record is written.

A gesture step has no fixed invocation, because which command a drop runs depends on the
target, so it waits for the `invoke` from the verdict it was displayed with.

Any other command is ignored. The author may do things in another order, and the step is simply
re-resolved against the new screen state.

`window.vn.exec`, the CDP scripting bridge, calls main directly and does not pass through
`bridge.exec`, so a command run from CDP does not advance a tour. The palette's run button does go
through the bridge.

### Palette fallback

For a `route` step, `openPalette(id, props)` opens the command palette on the command with the
step's props pre-filled. `CommandForm` shows the current `stack.check` verdict above its run
button, so the author sees the same refusal a dedicated control would show, and clicks run
themselves. If the palette is already open it is retargeted rather than closed and reopened, so
consecutive palette steps do not move focus.

The tour closes a palette it opened as soon as the step resolves to something else. Opening the
pane that draws a routed step is what usually causes that, and a palette left up would sit over the
control the ring points at. It closes it when the tour ends too, whether that is `tour.cancel`, the
last step, or another tour starting: a form the author did not ask for, with no tour behind it, is
the same fault a beat later.

### Sources of tours

- Curated tours are hard-coded in `apps/desktop/src/shared/tours.ts` (three at present).
  `main/tests/tours.test.ts` checks each step against the live registry. None uses `gesture`,
  since a gesture step needs a scene or shot id from a specific project.
- Agent-written tours come from the `show_me` tool (`src/main/showme.ts`), which the agent uses
  for anything the curated tours do not cover.

`show_me` exists only in the desktop app. It needs a window to display in, and `vnauthor` has
none, so the window push is a session dependency and the tool returns an error when it is absent.
Before a tour is displayed, `checkTour` in `shared/tourcheck.ts` rejects a step that names a
command that does not exist, a prop the command does not declare, a `supplies` prop that is not
one of the command's props, or an undeclared interaction id. Prop values are validated with
`coerceProps`, the same function that validates CDP input.

A tour written for the moment reaches the app two ways, and both are checked in main, which is
where the catalog is. `show_me` is the agent's; `tour.start`'s `custom` field is CDP's and the
palette's. The check is what stands between a hallucinated command id and a palette filtered to
nothing, with no form and nothing saying why.

`checkTour` deliberately does not call `stack.check`. `stack.check` says whether a command can run
now, and the later steps of a tour are usually refused until the earlier ones complete (approve
the portrait, then run), so gating on it would reject every correct multi-step tour. The verdict is
shown when the step is reached instead.

### Commands

`tour.start`, `tour.next`, `tour.cancel` and `tour.explain` are registered commands, all
non-mutating and none undoable. Like every other command they run in main and push a `command:ui`
effect; the renderer applies the effect and owns the tour's state, since only the renderer knows
what is drawn.

`tour.explain` re-displays the current step. For a `route` step it also states when `anchors.json`
was swept and at which commit, since the decision to use the palette came from that file rather
than from the screen.

The agent uses `show_me`, not these commands: a command without a tool wrapper is unreachable from
the agent in either host.

## Files

| Path                          | Contents                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `renderer/rules/anchors.ts`   | Anchor and resolution types; `subsumes`, `resolveAnchor`, `resolveItem`, `resolveSubject`, `resolveNamed`, `mapOf` |
| `renderer/rules/ring.ts`      | Ring geometry: `ringRect`, `union`, `outset`, `RING_PAD`                                        |
| `renderer/rules/tour.ts`      | `TourState`, `guide`, `satisfies`; pure, no DOM                                                 |
| `renderer/rules/anchormap.ts` | `ANCHOR_MAP`, loaded from `anchors.json`                                                        |
| `renderer/rules/precheck.ts`  | `checkFor`, `askedAs`: which invocation a ringed anchor is checked with                        |
| `renderer/pathux/anchors.ts`  | The registry: `redrawing`, `act`, `landsOn`, `strayAnchors`                                     |
| `renderer/pathux/hittest.ts`  | `elementsAt`, `reaches`, `hitFor`: hit testing through shadow roots                             |
| `renderer/pathux/overlay.ts`  | The ring layer and its two timers                                                               |
| `renderer/pathux/tour.ts`     | The running tour; `window.__vnTour`                                                             |
| `renderer/pathux/gestures.ts` | Per-editor gesture state readers                                                                |
| `src/shared/tours.ts`         | `Step`, `Tour`, and the curated tours                                                           |
| `src/shared/tourcheck.ts`     | `readTour`, `checkTour`                                                                         |
| `src/main/commands/tour.ts`   | The `tour.*` commands                                                                           |
| `src/main/showme.ts`          | The `show_me` agent tool                                                                        |
| `apps/desktop/anchors.json`   | The measured anchor map                                                                         |
| `scripts/sweep-anchors.mjs`   | The sweep that writes it                                                                        |

## See also

- [`command-system.md`](command-system.md) — commands, props, `stack.check`, and the interaction
  layer that evaluates gesture steps.
- [`desktop-app.md`](desktop-app.md) — the editors anchors are recorded in, and the pane rules
  behind a `pane-closed` result.
- [`../guides/debugGuide.md`](../guides/debugGuide.md) — `@vn/debug2d`, whose hit oracle shares
  the overlay's shadow-root descent.

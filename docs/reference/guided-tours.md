# Guided tours and the anchor layer

A guided tour walks the author through a task in the desktop app. Each step highlights the control
to use and shows a one-line instruction; the tour waits until the author has used that control,
then moves to the next step. The tour never performs a step itself.

To highlight a control, the app needs a mapping from commands to the DOM elements that run them. The anchor
layer holds that mapping. Every control an editor draws registers an anchor recording which command a click
on it runs and with which props. Part I covers the anchor layer, and Part II covers the tour built on it.

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

An anchor is registered from the same object that installs the control's click handler. `act()` in
`renderer/pathux/tour/anchors.ts` takes one `Offer` (the command id and props the control runs), sets
`node.onclick` from it, and records the anchor from it. A separate annotation (a `data-command` attribute,
for example) would be a description of the handler and could drift from it when the control is rewired.
Sharing one object makes drift impossible.

The same principle covers refusals. When a command cannot run, the tour displays the reason string
the command's own rule module returned. Tour code never composes a reason of its own.

## Part I — the anchor layer

### Offers

A rule module describes each control as an `Offer`. An `Offer` holds either the invocation the control runs
or the reason the control is disabled.

```ts
type Offer = (Action & { ok: true; label?: string }) | { ok: false; reason: string; id?: string };
```

A disabled control is still registered as an anchor when its `Offer` carries a command id (`id` on the
refusal, or `about` in `ActOptions`). The registration lets a tour highlight the disabled control and show
the control's reason, instead of reporting that the command has no control.

### Recording anchors

- `redrawing(editor, part)` starts a recording pass and returns an `AnchorPass`. Its `act`,
  `record`, `item`, `pick` and `pickItem` methods add anchors to the pass.
- Each pass replaces the previous pass for the same `editor/part` in full and increments a global
  generation counter. This is required because `rebuildBody()` clears the editor surface with
  `surface.textContent = ''` on every redraw, so a DOM reference from an earlier pass is stale. For the same
  reason, no code outside the registry may keep an `Anchor` object. The tour stores the anchor's key and
  looks it up again each frame.
- An editor may redraw separate regions from separate places, as the asset editor redraws its toolbar and
  its body independently. `part` lets such an editor replace one region's anchors without discarding the
  other's.
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

- Command anchors take the form `cmd:<id>`, or `cmd:<id>#<on>` when `on` is given.
- An item anchor is written `item:<kind>/<key>` and marks a control that selects something (a scene row,
  an asset thumbnail). `<key>` must be a domain id, never an index, a position or a label. An index changes
  on re-sort, and tree labels are only made unique when two of them collide.
- Every document-tree row also has a `data-anchor="<kind>/<key>"` attribute. The sweep script
  (below) uses it to click a row and select a subject without depending on the tree's DOM
  structure.

### `dom` and `pick` anchors

An anchor's `via` field records the route a click takes to reach that anchor. The recorded route determines
how the anchor is verified.

|               | `dom`                           | `pick`                                             |
| ------------- | ------------------------------- | -------------------------------------------------- |
| Click target  | the node itself                 | the canvas beneath the node                        |
| Registered by | `act()` / `record()`            | `pick()` / `pickItem()`                            |
| Verified by   | a hit test at the node's centre | calling the canvas's `pick()` at the node's centre |

The graph editors draw node boxes in a layer with `pointer-events: none`, so clicks pass through to the
canvas, which resolves them with its own `pick()`. The box element is still stored on the anchor so its rect
can be read each frame. The box moves on pan and zoom, so a rect copied at draw time would be stale by the
next frame.

### The registry

- `window.__vnAnchors` exposes `generation()`, `dump()`, `tree()` and `strays()`. It is present
  in production builds, unlike `window.__vnDebug`, because the tour uses it at runtime.
- `anchorSnapshot(open)` produces the `LiveAnchors` object the resolver reads. The caller passes the list
  of open panes, because only the pane mesh holds that list. The registry itself computes which anchors are
  offscreen from their rects.
- Anchors for a pane that is not open stay in the registry but are excluded from the snapshot. path.ux
  detaches an area on a tab switch and does not redraw it when the tab returns, so the anchor records cannot
  be dropped when the pane closes.

### The anchor map

Before any pane is open, the tour must determine which editors draw a control for a command (which pane has
the `prompt.condense` button?). The anchor map (`ANCHOR_MAP`) lists the editors that draw a control for each
command, and it comes from two sources:

- The document tree's right-click menu is derived from `menuFor`, which is plain data, so
  `window.__vnAnchors.tree()` enumerates those entries without opening a pane.
- `scripts/sweep-anchors.mjs` takes the measurement. It connects to a running app over CDP, opens each
  editor in turn, dumps the anchors, and writes `apps/desktop/anchors.json`. The file is committed at the
  app root (rather than under the gitignored `dist/`) so that a change in coverage appears in review as a
  diff.

`anchors.json` records the project title along with the scene and shot that were selected when the anchors
were measured, because many controls are only drawn when a subject is selected. A command absent from the
file resolves as `unanchored`, and the tour falls back to the command palette. The fallback is the same
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

The sweep formats what it writes, since `pnpm lint` checks `anchors.json` like any other file. Revert a run
that changes nothing but the `sweptAt` and `gitSha` lines rather than committing it, because the file exists
to record coverage.

### Resolution

`resolveAnchor(map, live, action)` finds the anchor for a requested invocation in a snapshot. The function
is pure, lives in `renderer/rules/anchors.ts`, and has node unit tests. It returns one of:

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

An anchor is a candidate only if it carries a command id. An `item:` anchor carries none. A step whose own
id is missing (a malformed step read from JSON that was not an object) therefore matches nothing rather than
every row on screen.

`absent` and `unanchored` are kept distinct, for the same reason that `Interaction.targets` distinguishes an
empty target list from `UNRESOLVED`. `absent` describes the current screen and `unanchored` describes the
map, and a caller diagnosing a stale map needs to know which of the two it has.

Prop matching uses subsumption rather than equality (`subsumes`). An anchor records only the props
known at draw time, and the prop the author is about to type cannot be recorded, so:

- every prop the anchor records must equal the step's value;
- if the step names a prop that the anchor does not, the anchor must either `supplies` that prop (the
  result is then `input`) or be a `form` anchor, which accepts any prop because the form takes them all;
- any other difference is `wrong-subject`.

The `form` case makes the palette a valid resolution for any step rather than a last resort.

A `wrong-subject` result also carries `holds`, naming which of the conflicting props the anchor itself
records a different value for. The rest are props the anchor neither records nor supplies (free text, a
flag, a step naming a prop this control does not take). They name nothing the author could select. Keeping
the two apart makes the search below sound.

`resolveSubject` runs that search. It looks at the held props' string values and finds an anchor that
selects one of them two ways: an item anchor whose click `publishes` that value (an asset hash, a
`sceneId`), or one whose item key is that value read as a kind and a key (`character:aiko` →
`item:character/aiko`). The pane that gave the mismatch is preferred, so the pane the author is already
looking at retargets. Empty values are skipped, since a click that clears a field publishes `''`.

Two cases do not resolve. Both are handled explicitly rather than ignored:

- A rung below the entity (`character:aiko/gala`, `shot:greet/s2`) has no document-tree node and no
  `publishes` record, so the step is `blocked` and names the subject. Blocking is the right outcome, because
  otherwise the author's art note would be written onto whichever rung the pane was showing.
- If the held props name nothing, the control supplies the answer itself. The answer is the ring as
  before, unless the control is greyed, in which case the answer is the control's refusal. A refused offer
  is recorded with no props at all, so a greyed control with an empty record falls into this case.

### Cross-checks

Both halves of the layer are checked against an independent source:

- Checks enabled state against `stack.check`. The sweep calls `stack.check` for every anchor it records
  and reports (without fixing) each case where the control's enabled state disagrees with the stack's
  verdict. This caught the branch editor drawing `delete <scene>` enabled for the entry scene, which main
  refuses to delete. The editor was calling `stack.check` only on hover, and now calls it when the button is
  drawn.

  Anchors with `supplies` or `form` are exempt, because their props are deliberately incomplete and the
  verdict would be about the blank rather than about the project. That exemption also applied to a real
  case: the task graph's gate buttons were drawn live on a project with nothing rendered, so a tour invoked
  a button whose form could not be completed. The editor now asks as it draws, passing the blank hash
  explicitly, and greys the button only when `gate:candidates` is empty. When candidates are on file, the
  form is where the portrait is named, so the button stays live and the sentence goes to its tooltip.
- Compares the recorded rect against a hit test. `landsOn` checks whether a click at the anchor's centre
  would reach it. For a `pick` anchor it calls the canvas's `pick()`. For everything else it goes through
  `hittest.ts`, which descends into shadow roots because `document.elementsFromPoint` stops at a shadow host
  and every editor surface is inside one. Disabled controls are skipped, since they usually have
  `pointer-events: none`. Points outside the window are skipped too; that case is already reported as
  `offscreen`.

`getBoundingClientRect()` does not report the hit area. A gen-graph socket is an 8×8 element with a
`::before` of `inset: -5px`; the browser hit-tests the pseudo-element as part of the socket, so the socket
accepts clicks over 18×18 while its rect reports 8×8, and `getClientRects()` excludes pseudo-elements as
well. The ring is drawn `RING_PAD` px outside the rect. When the hit test lands on a descendant that extends
outside that rect, the ring is enlarged to include the hit element's rect.

### Enforcement

CI has no app, no CDP port and no workspace, so the checks are split:

- Blocking: `apps/desktop/src/main/tests/anchorcoverage.test.ts` reads the committed `anchors.json` and
  fails if a record names a command that no longer exists, if the file's command list differs from the live
  registry's command list, or if the number of anchored commands has dropped below `FLOOR`.
- The sweep is advisory, is run by hand, and is the only place that reports disagreements and strays.

## Part II — the tour

### Steps

A `Tour` (`src/shared/tours.ts`) has an id, a title, a one-sentence `what`, and a list of steps. Each step
has a `say` instruction and one of four kinds:

| Kind      | The author is asked to                       | Fields                                            |
| --------- | -------------------------------------------- | ------------------------------------------------- |
| `command` | click a control that runs a command          | `id`, optional `props`                            |
| `input`   | type into a field and commit it              | `id`, `supplies` (the prop typed), optional `props` |
| `select`  | select a subject by clicking an `item:` anchor | `itemKind`, `key`                               |
| `gesture` | drag something                               | `id` (an interaction id), `carried`, optional `target` |

A `gesture` step is evaluated by calling `Interaction.targets` exactly as a real drop calls it, without
arming anything or moving the pointer. The tour highlights the element to pick up and outlines each target
that would accept it. `Interaction.targets` requires the surface's current state, so each editor registers a
state reader in renderer/pathux/interactions/gestures.ts under its interaction namespace, with
`gestureState(namespace, editor, read)`. The editor is part of the registration because two panes can show
the same scene (the document tree and the branch editor), and the drag has to start on the pane that runs
the gesture.

A registration outlives its pane (for the same reason an anchor does), so `verdictsFor` takes the open set
and returns nothing for a namespace whose editor is not in it. The step then finds nothing on screen that
runs the gesture, which is the state of a closed pane. Without the check, the closed pane's verdicts are
read first and its refusal is reported as the step's own answer.

### What a step displays

`guide(map, live, state, judge, refused)` in renderer/rules/tour.ts computes what the overlay shows for the
current step:

- `ring`: highlights an anchor and captions it with the instruction.
- `pick`: highlights the row that selects the step's subject, because the control the step names sits on a
  different row. The caption carries the instruction and a second line saying to click this row first. This
  kind is not called `select`, because `select` is already a step kind and resolves to `ring`.
- `route`: no control is drawn for this command; open the palette instead.
- `open`: Opens a pane and names it. A pane must be opened first.
- `blocked`: the step cannot run now. Carries the reason (from the command's rule or from
  `Interaction.targets`). Also carries the anchor of the disabled control when that control is on screen,
  and the control is then highlighted with the reason in its caption.
- `done`: no steps remain.

A control that opens the command's form is drawn enabled, because the refusal applies to the command behind
the control rather than to opening its form. `guide` therefore takes a `refused` lookup alongside the
snapshot and turns a `ring` into a `blocked` when the stack has refused the command. The lookup reads a
cache the caller owns: `stack.check` is asynchronous and runs in main, while `guide` remains a pure function
of what is drawn.

`renderer/pathux/tour/tour.ts` fills that cache. For each anchor a step points at, it calls
`checkFor(anchor, props)` (`renderer/rules/precheck.ts`) to build the invocation to check, then issues
`command:check`, and stores the refusal under the anchor key. The answer arrives asynchronously, and the
overlay reads it on the next re-resolve. An entry is checked again whenever an anchor's recorded props
change.

A refusal describes the project rather than the screen, so anything that could have changed the project
under it clears the refusal. Three things do. The first is `onWrote`. The second is a command that ran
successfully, because `onWrote` does not fire for a command that reports no written path, such as
`project.setKey` writing a key file outside the repository. The third is starting a tour, which drops the
refusals from the previous tour.

`checkFor` exists because `stack.check` coerces props before they reach a command's precondition. A check
that omits a prop the widget has not supplied yet reports `missing required property "hash"`, but the useful
answer is `aiko has no portrait yet`. Passing the missing prop explicitly as an empty value reaches the
precondition, which is written for that case. `checkFor` adds no information of its own: a required prop
with no empty value, such as a number or an enum, cannot be checked at that anchor, and a secret is never
filled in even with a blank.

### The overlay

The highlight (the ring) is drawn in a fixed-position `<div>` with `pointer-events: none`, appended to
`document.body` with a z-index above every path.ux layer, including the docker's own popups. Two timers
drive the ring:

- a `requestAnimationFrame` loop re-reads the anchor's rect every frame, so the ring stays on the anchor
  during a scroll without lag;
- a `setInterval` re-runs `guide()` every `RESOLVE_MS` and repaints. The re-run is needed because the
  step's target may have changed after a click. The repaint is needed because Chromium stops delivering
  frame callbacks to an occluded window.

If the hit test at the ring's centre does not reach the anchor, the overlay first calls `scrollIntoView`
once, because a control clipped by a scrolling container still has a rect inside the window. If the hit test
still fails after that, the overlay logs one `console.warn` per anchor and leaves the ring where it is; the
overlay cannot distinguish an element covered by another from an element that moved between frames.

The same layer draws a banner at the bottom of the window for as long as a tour is running. The banner shows
the tour's title, which step of how many, and a button that runs `tour.cancel`. A step with a control to
point at states what to do in the ring's caption, so the banner shows only the title and the count. A step
with nothing to point at has no caption, so the banner carries the instruction and where to find it.

The banner shows that a tour is running when the first step routes to the palette, and nothing else does.
Before the banner, starting a tour from the palette retargeted that palette to the step's command, and the
only other sign was a notification that cleared after a few seconds. The author was left looking at a form
for a command they had not asked for, with nothing saying a tour had started. `retarget` now also sets the
search box to the command it moved to, so the list agrees with the form.

### Advancing

The tour subscribes to `onExec` in `bridge.ts` and advances when a successful command matches the current
step, no matter which control ran it (a button, the palette, or a hotkey). Matching uses subsumption
(`satisfies`), so an `input` step matches regardless of the value the author typed for its `supplies` prop,
provided the author typed one. An `input` step exists so that the author supplies a value, and
`art.setNotes` accepts an empty note as a legitimate value (it removes the note), so committing the field
blank would otherwise advance the step over a no-op.

`satisfies` compares against the recorded props rather than the real ones, so a bulk prop arrives digested.
A digest carries the value's byte length, so an empty bulk prop is recognisable: it records as
`EMPTY_DIGEST` in `@vn/commands`, and the rule reads that as a blank field. A `prop.secret` records as
`<secret>` whatever it held, so the rule cannot tell an empty secret from a non-empty one. That is a
limitation of the rule rather than a case it decides, and nothing reaches it today, because `project.setKey`
refuses an empty key before a record is written.

A gesture step has no fixed invocation, because which command a drop runs depends on the target. The step
takes its `invoke` from the verdict it was displayed with.

Any other command is ignored. If the author does things in another order, the step is re-resolved against
the new screen state.

`window.vn.exec` (the CDP scripting bridge) calls main directly and does not pass through `bridge.exec`, so
a command run from CDP does not advance a tour. The palette's run button goes through the bridge.

### Palette fallback

For a `route` step, `openPalette(id, props)` opens the command palette on the command with the step's props
pre-filled. `CommandForm` shows the current `stack.check` verdict above its run button, so the author sees
the same refusal a dedicated control would show, and clicks run themselves. If the palette is already open,
it is retargeted rather than closed and reopened, so consecutive palette steps do not move focus.

The tour closes a palette it opened as soon as the step resolves to something else. Opening the pane that
draws a routed step usually triggers this close, and a palette left up would sit over the control the ring
points at. The tour also closes the palette when it ends, whether through `tour.cancel`, the last step, or
another tour starting. Otherwise a form the author did not ask for would stay open with no tour behind it,
which is the same fault, only later.

### Sources of tours

- Curated tours are hard-coded in `apps/desktop/src/shared/tours.ts` (three at present).
  `main/tests/tours.test.ts` checks each step against the live registry. No step uses `gesture`, because a
  gesture step needs a scene or shot id from a specific project.
- Agent-written tours come from the `show_me` tool (`src/main/showme.ts`), which the agent uses
  for anything the curated tours do not cover.

`show_me` exists only in the desktop app. It needs a window to display in, and `vnauthor` has none, so the
window push is a session dependency, and the tool returns an error when the session does not supply that
push. Before a tour is displayed, `checkTour` in `shared/tourcheck.ts` rejects a step that names a command
that does not exist, a prop the command does not declare, a `supplies` prop that is not one of the command's
props, or an undeclared interaction id. Prop values are validated with `coerceProps`, the same function that
validates CDP input.

A tour written for the moment reaches the app two ways, and main checks both, because main holds the
catalog. The agent uses `show_me`. CDP and the palette use the `custom` field of `tour.start`. Without the
check, a hallucinated command id filters the palette to nothing, leaving no form and no explanation of why.

`checkTour` deliberately does not call `stack.check`. `stack.check` reports whether a command can run now,
and the later steps of a tour are usually refused until the earlier ones complete (approve the portrait,
then run), so gating on it would reject every correct multi-step tour. The verdict is shown when the step is
reached instead.

### Commands

`tour.start`, `tour.next`, `tour.cancel` and `tour.explain` are registered commands, all non-mutating and
none undoable. Like every other command, they run in main and push a `command:ui` effect; the renderer
applies the effect and owns the tour's state, since only the renderer holds the drawn state.

`tour.explain` re-displays the current step. For a `route` step it also states when `anchors.json` was swept
and at which commit, because the palette was chosen from that file rather than from the screen.

The agent uses `show_me` rather than these commands. A command without a tool wrapper is unreachable from
the agent in either host.

## Files

| Path                          | Contents                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `renderer/rules/anchors.ts`   | Anchor and resolution types; `subsumes`, `resolveAnchor`, `resolveItem`, `resolveSubject`, `resolveNamed`, `mapOf` |
| `renderer/rules/ring.ts`      | Ring geometry: `ringRect`, `union`, `outset`, `RING_PAD`                                        |
| `renderer/rules/tour.ts`      | `TourState`, `guide`, `satisfies`; pure, no DOM                                                 |
| `renderer/rules/anchormap.ts` | `ANCHOR_MAP`, loaded from `anchors.json`                                                        |
| `renderer/rules/precheck.ts`  | `checkFor`, `askedAs`: which invocation a ringed anchor is checked with                        |
| `renderer/pathux/tour/anchors.ts`  | The registry: `redrawing`, `act`, `landsOn`, `strayAnchors`                                     |
| `renderer/pathux/interactions/hittest.ts`  | `elementsAt`, `reaches`, `hitFor`: hit testing through shadow roots                             |
| `renderer/pathux/tour/overlay.ts`  | The ring layer and its two timers                                                               |
| `renderer/pathux/tour/tour.ts`     | The running tour; `window.__vnTour`                                                             |
| `renderer/pathux/interactions/gestures.ts` | Per-editor gesture state readers                                                                |
| `src/shared/tours.ts`         | `Step`, `Tour`, and the curated tours                                                           |
| `src/shared/tourcheck.ts`     | `readTour`, `checkTour`                                                                         |
| `src/main/commands/tour.ts`   | The `tour.*` commands                                                                           |
| `src/main/showme.ts`          | The `show_me` agent tool                                                                        |
| `apps/desktop/anchors.json`   | The measured anchor map                                                                         |
| `scripts/sweep-anchors.mjs`   | The sweep that writes it                                                                        |

## See also

- [`command-system.md`](command-system.md) — covers commands, props, `stack.check`, and the interaction
  layer that evaluates gesture steps.
- [`desktop-app.md`](desktop-app.md) — describes the editors that anchors are recorded in, and the pane
  rules for a `pane-closed` result.
- [`../guides/debugGuide.md`](../guides/debugGuide.md) — documents `@vn/debug2d`, whose hit oracle
  descends the shadow root the same way the overlay does.

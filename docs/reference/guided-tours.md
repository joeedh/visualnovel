# Guided tours, and the anchor layer under them

How the desktop app points at its own controls: what an anchor is, how a wanted invocation
resolves against what is drawn, and how a tour walks an author through pressing things
themselves.

<!-- toc -->

- [The rule everything rests on](#the-rule-everything-rests-on)
- [Part I — the anchor layer](#part-i--the-anchor-layer)
  * [What a surface offers](#what-a-surface-offers)
  * [Recording](#recording)
  * [Keys](#keys)
  * [Two flavours](#two-flavours)
  * [The registry](#the-registry)
  * [The map](#the-map)
  * [Resolution](#resolution)
  * [Two oracles, twice](#two-oracles-twice)
  * [Enforcement](#enforcement)
- [Part II — the tour](#part-ii--the-tour)
  * [One rule worth repeating](#one-rule-worth-repeating)
  * [Steps](#steps)
  * [What the app answers](#what-the-app-answers)
  * [The overlay](#the-overlay)
  * [Advancing](#advancing)
  * [Where no control is drawn](#where-no-control-is-drawn)
  * [Who writes one](#who-writes-one)
  * [Commands](#commands)
- [Files](#files)
- [See also](#see-also)

<!-- tocstop -->

## The rule everything rests on

**An anchor runs the same invocation it points at, rather than a description of that invocation.**
A widget tagged with the command it happens to call is a comment, and comments go stale silently.
`act()` takes one `Offer` and uses that offer for both halves — the click it installs and the
record it keeps — so rewiring a control cannot leave a stale anchor behind.

The tour inherits from this. Where the app refuses, the author is shown the app's own sentence.
Nothing in the tour layer writes a refusal of its own.

## Part I — the anchor layer

### What a surface offers

A rule module answers with an `Offer`: the invocation a control is offering, or the surface's own
sentence for why it is not.

```ts
type Offer = (Action & { ok: true; label?: string }) | { ok: false; reason: string; id?: string };
```

A refusal may still name the command it is about. A greyed control is recorded as an anchor rather
than as an absence, so a tour asked for that command can ring the control and repeat the refusal
instead of inventing one.

### Recording

`redrawing(editor, part)` opens a pass; `act`, `record`, `item`, `pick` and `pickItem` fill it. A
pass is dropped whole and laid down again on every redraw, under a rising generation counter,
because `rebuildBody()` does `surface.textContent = ''` and a reference held across a frame is a
dangling pointer. **Nothing outside may hold an `Anchor`.** The tour keeps the key and asks again.

`act(node, offer, run, opts)` assigns `node.onclick` rather than adding a listener: a path.ux
`Button` calls its own `onclick` on a touch pointer, where the browser dispatches no click event
for a listener to hear.

`ActOptions` carries the facts an offer cannot:

| Option     | What it says                                                                   |
| ---------- | ------------------------------------------------------------------------------ |
| `supplies` | Prop names the click reads from the widget at commit time — a textarea, an id   |
| `form`     | The click opens the command's own form, so every prop is typed there            |
| `on`       | What tells this control apart from another running the same command on the pane |
| `about`    | The command a refusal is about, where the rule's refusal names none             |
| `key`      | An `item:` key, for a click that publishes a selection rather than running       |
| `publishes`| The `ui.*` fields that click sets, recorded beside the `item:` key it sets them from |

### Keys

- `cmd:<id>`, plus `#<on>` where one pane draws two of them.
- `item:<kind>/<key>` for a thing rather than an act. The key must be domain identity, never an
  index, a position or a label: indices break on any re-sort, and a tree's labels carry a
  disambiguating suffix only on collision.

Every document-tree row also carries `data-anchor="<kind>/<key>"`, which is how the CDP sweep
selects a subject without knowing the tree's internals.

### Two flavours

| | `dom` | `pick` |
| --- | --- | --- |
| Where the click lands | on the node | on the canvas underneath it |
| Wired by | `act()`, one object for both halves | the canvas's own `pick()` dispatch |
| Verified by | a shadow-piercing hit test | calling `pick()` at the ring's centre |

The graph editors draw node boxes into a layer with `pointerEvents: 'none'`, so a click on a box
lands on the canvas by design. The box is kept anyway, for its rect: it moves with every pan and
zoom, so a rect copied at draw time would be wrong by the next frame.

### The registry

`window.__vnAnchors` ships in production, unlike `window.__vnDebug`, because the tour reads it at
runtime. It answers `generation()`, `dump()`, `tree()` and `strays()`.

`anchorSnapshot(open)` is what the resolver reads. `open` comes from the caller because only the
mesh knows how many panes there are; the offscreen half is measured in the registry, since it is a
rect question. An editor no pane shows keeps its records — path.ux detaches an area on a tab
switch and does not redraw it on the way back — so they are dropped on the way in rather than on
the way out.

### The map

Which editors are known to anchor a command, in two halves:

- **Derived.** `menuFor` in the document tree is already pure data, so the right-click entries
  enumerate themselves through `window.__vnAnchors.tree()`.
- **Measured.** `scripts/sweep-anchors.mjs` drives a running app over CDP, opens each editor in
  turn, and writes `apps/desktop/anchors.json`. Committed, at the app root rather than under the
  gitignored `dist/`, so drift is a reviewable diff.

The file records what it was measured against — the project's title and which scene and shot were
selected — because whether a control is drawn at all depends on what the pane was showing. A
command the file does not name resolves `unanchored`, which is a true statement about a project
that was never swept as well as about a command no pane draws; either way the palette is the floor.

Run it after touching `apps/desktop/renderer/pathux/editors/**`:

```bash
pnpm build:desktop
pnpm vndesktop --mock --project <dir>   # keeps running; prints the port it opened
node scripts/sweep-anchors.mjs          # second shell, VN_CDP_PORT set to that port
```

The launcher takes the first free port from 9222 upward and announces it, and `scripts/cdp.mjs`
assumes 9222, so the second shell needs `VN_CDP_PORT` set wherever another app already holds it.

### Resolution

`resolveAnchor(map, live, action)` reads a snapshot and returns one of eight answers. The function
is pure, so it is unit-testable in node even though the surface it describes is a browser.

| Answer          | What the caller does                                          |
| --------------- | ------------------------------------------------------------- |
| `ready`         | ring it                                                        |
| `input`         | ring it and say what to type                                   |
| `disabled`      | ring it and repeat the app's refusal                           |
| `offscreen`     | scroll it in, then ask again                                   |
| `wrong-subject` | the id matches and the props conflict; pick the subject first  |
| `pane-closed`   | name the pane to open                                          |
| `absent`        | declared for an open editor, not drawn                         |
| `unanchored`    | no UI route — the palette                                      |

`absent` and `unanchored` are different answers for the reason `Interaction.targets` distinguishes
an empty target list from `UNRESOLVED`: one is a statement about the screen, the other about the
map.

**Subsumption, not equality.** An anchor's props are partial by design, so "id matches, props do
not" would answer `wrong-subject` against any input surface every time. Every key the anchor
records must equal the step's; every key only the step names must be one the widget `supplies`,
and the step is then an input rather than a click. A `form` anchor supplies whatever is asked of
it, because its form holds every prop — which is what makes a palette-routed door a real answer.

### Two oracles, twice

Each half of the layer is cross-checked by something that was not consulted when it was built.

- **The pane against the stack.** The sweep asks `stack.check` about every anchor it recorded and
  reports a disagreement rather than reconciling it. This found the branch editor drawing
  `delete <scene>` enabled and only asking on hover, so the entry scene offered a delete main
  refuses; the fix was to ask as the button is drawn.
- **The rect against the hit test.** `landsOn` asks what a click in the middle of an anchor would
  actually reach: `pick()` for a graph card, and a shadow-piercing descent for everything else,
  since `document.elementsFromPoint` stops at a shadow host and every editor surface is mounted
  inside one. A greyed control answers `ok` because it takes no pointer events; a point outside the
  window answers `ok` because the overlay scrolls that anchor in rather than warning about it.

`getBoundingClientRect()` is not the hit area. A gen-graph socket is an 8×8 dot carrying a
`::before` of `inset: -5px`, so the browser hit-tests 18×18 while the box reports 8×8, and
`getClientRects()` does not report pseudo-elements either. The ring is drawn with `RING_PAD` of
slack and widens to the hit wherever the hit reaches the anchor from outside the anchor's own box.

### Enforcement

Split, because CI has no app, no CDP port and no workspace:

- **Blocking.** `apps/desktop/src/main/tests/anchorcoverage.test.ts` reads the committed
  `anchors.json`: every record points at a live command, the file's command list equals the live
  registry's, and the anchored count does not fall below the floor.
- **Advisory.** The sweep, run by hand. Disagreements and strays are reported only there.

## Part II — the tour

### One rule worth repeating

**A tour never performs the step.** The author presses every control themselves. A tour that
pressed them would do the author's work rather than teach it.

### Steps

| Kind      | What it asks for                                                              |
| --------- | ----------------------------------------------------------------------------- |
| `command` | a button to press                                                             |
| `input`   | a box to type in; `supplies` names the prop the author types                   |
| `select`  | a subject to publish first, by clicking an `item:` anchor                     |
| `gesture` | a drag, named by an interaction id and what it carries                        |

A `gesture` step is judged by the same `targets` the drop itself would call. Nothing is armed and
no pointer goes down: the verdicts are read, the thing to pick up is ringed, and whatever would
take it is outlined beside it. Each surface leaves the state its gestures are judged against in
`renderer/pathux/gestures.ts`, keyed by namespace and naming its editor — the document tree draws
a card for a scene too, and a drag has to start on the surface that runs the gesture.

### What the app answers

`guide(map, live, state, judge)` returns one of `ring`, `route`, `open`, `blocked` or `done`.
`route` says the app draws no control and the palette is standing in; `blocked` carries the app's
own refusal along with the control that gave it, so a greyed button says why in the same breath.

### The overlay

A `pointer-events: none` layer at document level, above every path.ux stacking context. It runs on
two clocks: a frame callback keeps the ring with a scroll, and Chromium suspends frame callbacks
altogether for an occluded window, so an interval drives the same update every 150 ms. Which anchor
a step means is re-asked on the slow beat; where that anchor is, every frame.

A ring over something a click would not reach scrolls once — a control clipped by a scroll
container keeps a rect inside the window — and what is left is reported to the console rather than
resolved, because the overlay cannot tell a stacking fault from a control that has just moved.

### Advancing

On `onExec` seeing the step's own invocation, whatever ran it — a button, the palette, a hotkey.
Comparison is by subsumption, so an `input` step ignores the prop the author has only now typed. A
gesture names no invocation of its own, so the verdict's `invoke` is what it waits for.

Anything else means the author went their own way. That is neither an error nor something to
block: the step is shown again, resolved against wherever they have got to.

CDP's `window.vn.exec` goes straight to `command:exec` and bypasses `bridge.exec`, so a command run
that way does not advance a tour. That is by design; the palette's own run button does.

### Where no control is drawn

`openPalette(id, props)` fills the form in and `CommandForm` shows the live `stack.check` verdict
above the run button, so the author sees the same refusal a control would have shown and presses
the button themselves. An already-open palette re-targets rather than closing and reopening, so a
palette-routed tour does not drop the author's focus between every two steps.

### Who writes one

- **Curated**, in `apps/desktop/src/shared/tours.ts`, checked against the live registry by
  `main/tests/tours.test.ts`. None of them is a `gesture`, which needs the id of a scene or a shot
  in the project at hand.
- **Agent-written**, through the `show_me` tool, for everything else.

`show_me` is desktop-only: a tour points at controls and `vnauthor` has none, so the push is a
session dependency and the tool refuses where there is no window. Every tour it is handed goes
through `shared/tourcheck.ts` first — a command the app does not have, a prop it does not take, a
typed prop that is not one of its props, or a gesture that is not declared, all refused through
`coerceProps`, the same authority a loose CDP value goes through.

`stack.check` is deliberately *not* part of that gate. It answers whether a step is accepted now,
and a tour's later steps are routinely refused until its earlier ones are done — approve the
portrait, then run — so refusing a tour on that would refuse every correct multi-step tour. The
live verdict is shown at the step instead.

### Commands

`tour.start`, `tour.next`, `tour.cancel`, `tour.explain`. All non-mutating, none undoable. They run
in main like every other command and push a `command:ui` effect; where the tour has got to lives in
the renderer, because only the renderer knows what is drawn.

`tour.explain` says the current step again. For a step the palette is standing in for, it also
names when the anchor map was swept and against which commit, since that answer came from the
measured file rather than from the screen.

The agent reaches tours through `show_me` and not through these: a command with no tool wrapper is
unreachable to the agent in either host.

## Files

| Path | What it holds |
| ---- | ------------- |
| `renderer/rules/anchors.ts` | The shapes, `subsumes`, `resolveAnchor`, `resolveItem`, `resolveNamed`, `mapOf` |
| `renderer/rules/ring.ts` | Ring geometry: `ringRect`, `union`, `outset`, `RING_PAD` |
| `renderer/rules/tour.ts` | `TourState`, `guide`, `satisfies` — the pure walk |
| `renderer/rules/anchormap.ts` | `ANCHOR_MAP`, read from the swept file |
| `renderer/pathux/anchors.ts` | The registry: `redrawing`, `act`, `landsOn`, `strayAnchors` |
| `renderer/pathux/hittest.ts` | `elementsAt`, `reaches`, `hitFor` — the shadow-piercing descent |
| `renderer/pathux/overlay.ts` | The ring layer and its two clocks |
| `renderer/pathux/tour.ts` | The running tour, and `window.__vnTour` |
| `renderer/pathux/gestures.ts` | Where each surface leaves its gesture state |
| `src/shared/tours.ts` | `Step`, `Tour`, and the curated three |
| `src/shared/tourcheck.ts` | `readTour`, `checkTour` |
| `src/main/commands/tour.ts` | The `tour.*` namespace |
| `src/main/showme.ts` | The agent's tool |
| `apps/desktop/anchors.json` | The measured map |
| `scripts/sweep-anchors.mjs` | What measures it |

## See also

- [`command-system.md`](command-system.md) — commands, props, `stack.check`, and the interaction
  layer a gesture step is judged by.
- [`desktop-app.md`](desktop-app.md) — the editors an anchor is recorded in, and the pane rules a
  `pane-closed` answer sends the author to.
- [`../guides/debugGuide.md`](../guides/debugGuide.md) — `@vn/debug2d`, whose hit oracle shares the
  overlay's shadow-piercing descent.

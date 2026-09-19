# Guided tours and the anchor layer

A guided tour walks the author through a task in the desktop app. Each step highlights the
control to use and shows a one-line instruction; the tour waits until the author has used
that control, then moves to the next step. The tour never performs a step itself.

To highlight a control, the app needs a mapping from commands to the DOM elements that run
them. The anchor layer holds that mapping. Every control an editor draws registers an
anchor recording which command or effect a click on it runs, with which props, and what
follows. Part I covers the anchor layer, Part II covers the tour built on it, and Part III
covers the derived model: the same offers, run over hand-written situations with no app,
written to a committed file.

<!-- toc -->

- [Design rule](#design-rule)
- [Part I — the anchor layer](#part-i--the-anchor-layer)
    - [Offers](#offers)
    - [Recording anchors](#recording-anchors)
    - [Keys](#keys)
    - [`dom` and `pick` anchors](#dom-and-pick-anchors)
    - [The meta tag](#the-meta-tag)
    - [The registry](#the-registry)
    - [The anchor map](#the-anchor-map)
    - [Resolution](#resolution)
    - [Cross-checks](#cross-checks)
    - [Enforcement](#enforcement)
- [Part II — the tour](#part-ii--the-tour)
    - [Steps](#steps)
    - [What a step displays](#what-a-step-displays)
    - [The overlay](#the-overlay)
    - [Advancing](#advancing)
    - [Palette fallback](#palette-fallback)
    - [Sources of tours](#sources-of-tours)
    - [Commands](#commands)
- [Part III — the derived model](#part-iii--the-derived-model)
    - [The file](#the-file)
    - [Situations](#situations)
    - [The driver](#the-driver)
    - [The record](#the-record)
    - [The rules over the file](#the-rules-over-the-file)
    - [Regenerating](#regenerating)
- [Files](#files)
- [See also](#see-also)

<!-- tocstop -->

## Design rule

An anchor is registered from the same object that installs the control's click handler.
`act()` in `renderer/pathux/tour/anchors.ts` takes one `Offer` (the command or effect the
control runs and its props, its label, its tooltip and its refusal), sets `node.onclick`
from it, greys the node and writes its tooltip from it, writes the node's meta tag from
it, and records the anchor from it. A separate annotation (a `data-command` attribute, for
example) would be a description of the handler and could drift from it when the control is
rewired. Sharing one object makes drift impossible, and it makes a hand-written tooltip
beside the call a second copy that `applyOffer` overwrites.

The same principle covers refusals. When a command cannot run, the tour displays the
reason string the command's own rule module returned. Tour code never composes a reason of
its own.

## Part I — the anchor layer

### Offers

A rule module describes each control as an `Offer`. An `Offer` holds either the invocation
the control runs or the refusal that greys it, and on both branches everything the anchor
records and the node shows (`renderer/rules/anchors.ts`):

```ts
interface Action {
    id: string; // a command id, or an effect id
    props: Record<string, PropValue>;
}

interface Control {
    id: string; // a command id, or an effect id
    label: string; // a button's text, a field's placeholder
    tooltip: string; // the control's own sentence
    on?: string; // tells twins apart: a chunk key, a task hash
    supplies?: readonly string[]; // prop names read from the widget at commit time
    form?: boolean; // the click opens the command's form instead of running it
}

type Offer =
    | (Control & { ok: true; props: Record<string, PropValue>; then?: readonly Action[] })
    | (Control & { ok: false; refusal: Refusal });
```

`Refusal` is path.ux's own type (`{ reason, description? }`), so an op, a widget and a
rule module hold one shape. A refused literal is written
`{ ...refuse(why), id, label, tooltip }`. `id` is required on both branches, so a disabled
control is always registered as an anchor: a tour asked for that command highlights the
greyed control and shows the refusal the rule wrote, instead of reporting that the command
has no control.

An offer's `id` names a command, which main runs, or an effect: a name for what a control
does to its own surface without a command. The twelve effects are declared in
`src/shared/effects.ts` and registered in `@vn/commands`' `EffectRegistry` beside the
commands. `verify` refuses an id both registries hold and a `drag.start` value no
interaction declares, and `commands.json` carries them under `effects`. An effect has no
`run`, no `check` and no provenance. Its handler is the closure `act()` is given, and the
palette and CDP cannot run one. `rules/effects.ts` exports one typed helper per effect
(`publish`, `expand`, `openMenu`, `openPopup`, `closePopup`, `view`, `scrollTo`, `pin`,
`arrange`, `startDrag`, `move`, `answer`), each returning an `Action`, so a misspelt value
is a compile error there and a parse error in the driver's test.

| Effect           | Props                                         | What it names                                                                                   |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ui.publish`     | the `ui.*` fields it sets                     | A click that selects a subject: a tree row, a card, a thumbnail.                                |
| `tree.expand`    | `node`, or `*` for all                        | Opening or closing a tree node, or every node at once.                                          |
| `menu.open`      | `menu`, from `MENUS`                          | Dropping a menu, each entry of which is a command or an effect of its own.                      |
| `popup.open`     | `popup`, from `POPUPS`                        | Opening the palette, the picker, a toolbar popup, the report preview, or an inline box (`box`). |
| `popup.close`    | `popup`                                       | A Cancel or Close on a popup or an inline box.                                                  |
| `pane.view`      | `what`, from `VIEWS`                          | Changing what a pane shows: reload, fit, tidy, filter, scope, mode, page, step, mark.           |
| `pane.scroll`    | `to`                                          | Bringing something already on the pane into view.                                               |
| `pane.pin`       | `pinned`                                      | The pin toggle in a pinnable pane's header.                                                     |
| `screen.arrange` | `what: 'split' \| 'close'`                    | The View menu's Split Area and Close Pane… gestures.                                            |
| `drag.start`     | `interaction`, an id the interactions declare | Arming a gesture: a rail, a handle, a bracket, a line's grip.                                   |
| `history.move`   | `to: 'undo' \| 'redo'`                        | The header's arrows, the Edit menu's rows and the shell's keys.                                 |
| `agent.answer`   | `to`, `answer`                                | Approving or rejecting a plan, allowing or denying a confirm, replying to a question.           |

`then` is what the click does after the first action, in order. A document-tree row is
`{ id: 'ui.publish', props: { sceneId }, then: [{ id: 'view.open', props: route }] }`: it
selects, then opens the editor `routeFor` picked. The anchor and the model record the list
unchanged.

Every anchor home has a rule module, and the module is where its offers are built. Each
module exports `controls(state)`, the list of every offer it can produce for a state, over
plain data the editor assembles at draw time: a shared view type, plus whatever the editor
holds that the offer needs, converted to data. A `command:check` verdict is state the
editor fetched and stored, keyed by everything it asked about; a widget's value is state;
a gesture's weighing is state. The module never reads a promise or a widget. Each module's
test asserts that the list's keys are the union of the module's functions' keys over two
or three states and that `duplicateKeys` finds none. The table below is the one the
derived model's driver iterates (`renderer/rules/model.ts`, Part III).

| Home                | Module                       | State                                             |
| ------------------- | ---------------------------- | ------------------------------------------------- |
| `header`            | `rules/headerbar.ts`         | `HeaderState`                                     |
| `notifications`     | `rules/notifications.ts`     | `NotificationsState`                              |
| `approvals`         | `rules/approvals.ts`         | `ApprovalsState`                                  |
| `diagnostics`       | `rules/diagnostics.ts`       | `DiagnosticsState`                                |
| `asset`             | `rules/assetview.ts`         | `AssetInfo \| undefined`, and the chip to go back |
|                     | `rules/promptview.ts`        | `PromptView`, and which clauses have a box open   |
| `branches`          | `rules/branch/controls.ts`   | `BranchState`                                     |
| `convo`             | `rules/convobar.ts`          | `ConvoBarState`                                   |
| `documents`         | `rules/documents.ts`         | `DocumentsState`                                  |
| `gengraph`          | `rules/gengraph.ts`          | `GroupState`                                      |
| `inspector`         | `rules/inspector.ts`         | `InspectorState`                                  |
| `onboarding`        | `rules/onboarding.ts`        | `OnboardingState`                                 |
| `play`              | `rules/play.ts`              | `PlayState`                                       |
| `project`           | `rules/projectbar.ts`        | `ProjectBarState`                                 |
| `report`            | `rules/reportconvo.ts`       | `ReportControls`                                  |
| `script`            | `rules/script.ts`            | `ScriptPageState`                                 |
| `skills`            | `rules/skills.ts`            | `SkillsState`                                     |
| `systemprompt`      | `rules/systemprompt.ts`      | `SystemPromptState`                               |
| `taskgraph`         | `rules/taskGraph.ts`         | `GateState`                                       |
| `tasklist`          | `rules/tasklist.ts`          | `TaskListState`                                   |
| `timeline`          | `rules/timeline/controls.ts` | `TimelineState`                                   |
| `wiki`              | `rules/wiki.ts`              | `WikiState`                                       |
| every pinnable pane | `rules/pin.ts`               | `PinState`, over the pane's `PinField`            |

The three toolbar popups are homes like the header: present whenever the app is, drawn
under a pass that is replaced on render, and swept by pressing the toolbar control that
opens each. The asset home has two modules, one for the bytes and one for the prompt, and
a driver concatenates them. The pin toggle is one module drawn by the base editor in each
of the six panes that declare `pins`. The wiki and skills panes share
`rules/docbuffer.ts`, whose `saveOffer` is what `DocBuffer.saveOffer` delegates to. A
module runs under the node-only desktop jest project, which maps no `pathux` module, so it
imports from `pathux` type-only.

### Recording anchors

- `redrawing(editor, part)` starts a recording pass and returns an `AnchorPass`. Its
  `act`, `record` and `pick` methods add anchors to the pass.
- Each pass replaces the previous pass for the same `editor/part` in full and increments a
  global generation counter. This is required because `rebuildBody()` clears the editor
  surface with `surface.textContent = ''` on every redraw, so a DOM reference from an
  earlier pass is stale. For the same reason, no code outside the registry may keep an
  `Anchor` object. The tour stores the anchor's key and looks it up again each frame.
- An editor may redraw separate regions from separate places, as the asset editor redraws
  its toolbar and its body independently. `part` lets such an editor replace one region's
  anchors without discarding the other's.
- `act(node, offer, run)` sets `node.onclick` rather than calling
  `addEventListener('click')`. path.ux's `Button` invokes `onclick` directly on touch
  input, where no DOM click event is dispatched. A refused offer wires no click.
- `act()` and `record()` both present the offer on the node through `applyOffer`
  (`renderer/rules/anchors.ts`). The node is greyed when the offer is refused. A path.ux
  widget (told apart by `'refusalReason' in node`) is given `description` and
  `refusalReason` separately and composes its tooltip on read; a raw DOM node gets a
  `title` composed by path.ux's `composeTooltip`, the refusal above the tooltip.
  Presenting also writes the meta tag below.
- An editor whose control changes offer between redraws re-records it through a pass of
  its own (`redrawing(editor, '<control>')` for that one control), rather than calling
  `applyOffer` beside the change. A hand-presented control keeps the tag its last pass
  wrote, so the two stores would disagree; the conversation bar's budget menu and Compact
  button are the two that do this.
- One node may carry several offers, as the View button's menu rows run different
  commands, only while they present the same way. A second offer on a node whose `ok` or
  `tooltip` differs from the first makes `record()` throw, so it cannot silently overwrite
  the first.

The fields every offer carries beyond `id` and `props`:

| Field      | Meaning                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `label`    | What the control says on screen. The editor reads it rather than writing its own.                                       |
| `tooltip`  | The control's own sentence, shown when enabled and beneath the refusal when not.                                        |
| `supplies` | Prop names whose values are read from the widget when the command runs (a textarea's text, a typed id).                 |
| `form`     | A click opens the command's form in the palette instead of running it; every prop is entered there.                     |
| `on`       | A discriminator appended to the key when one pane has several controls for the same command (a chunk key, a task hash). |
| `then`     | What the click does after the first action, in order: a row that selects and then opens an editor.                      |

A control that selects a subject is a `ui.publish` offer from its module, with the `ui.*`
fields it publishes as props and `on` set to `<kind>/<key>`. It is recorded rather than
acted, because none of those sites installs its click through the anchor: `record()` for a
DOM row, `pick()` for a graph card. A control whose click path.ux owns (a checkbox's
`on_change`, a handle's `pointerdown`, a box committed on blur) is recorded the same way.
So is the Wiki pane's rich text editor: the whole `rich-text-x` element, toolbar, prose
and any front-matter form mounted inside it, is one control recorded with the
`doc.write#text` offer a textarea carries, because it is the box Save reads. The Raw
view's textarea takes the same offer while it is up, so a tour that names the text box
lands on whichever the pane is showing.

### Keys

- `keyOf(offer)` gives one of three prefixes. A command anchor is `cmd:<id>`, or
  `cmd:<id>#<on>` when `on` is given.
- A `ui.publish` offer is `item:<on>`, where `on` is `<kind>/<key>` and is required, so a
  row that selects something (a scene row, an asset thumbnail) keeps the key a tour's
  `select` step names. `<key>` must be a domain id, never an index, a position or a label.
  An index changes on re-sort, and tree labels are only made unique when two of them
  collide.
- Any other effect is `fx:<id>`, or `fx:<id>#<on>`: `fx:pane.view#reload`,
  `fx:popup.open#notifications`. `openerKey(popup)` is the key of the toolbar control that
  opens a popup, which a `popup-closed` resolution rings.
- Every document-tree row also has a `data-anchor="<kind>/<key>"` attribute. The sweep
  script (below) uses it to click a row and select a subject without depending on the
  tree's DOM structure.

### `dom` and `pick` anchors

An anchor's `via` field records the route a click takes to reach that anchor. The recorded
route determines how the anchor is verified.

|               | `dom`                           | `pick`                                             |
| ------------- | ------------------------------- | -------------------------------------------------- |
| Click target  | the node itself                 | the canvas beneath the node                        |
| Registered by | `act()` / `record()`            | `pick()`                                           |
| Verified by   | a hit test at the node's centre | calling the canvas's `pick()` at the node's centre |

The graph editors draw node boxes in a layer with `pointer-events: none`, so clicks pass
through to the canvas, which resolves them with its own `pick()`. The box element is still
stored on the anchor so its rect can be read each frame. The box moves on pan and zoom, so
a rect copied at draw time would be stale by the next frame.

### The meta tag

Presenting an offer also writes it onto the node as a path.ux meta tag, so the sweep reads
the offer back as the type both tiers write rather than through a hand-kept dump
interface.

- `writeTag` (`renderer/rules/anchors.ts`) is the only writer, and `present()` calls it
  for every `act`, `record` and `pick`. The tag is `StdUXMeta`
  (`vendor/path.ux/scripts/core/base/ui_meta_tags.ts`, reached through the `pathux-meta`
  alias): `description` from the offer's tooltip, `enabled` from `ok`, `refusal`,
  `widgetPath`, and one entry in `tools` per offer the node presents.
- A tool is a `VnToolMeta` (`renderer/rules/toolmeta.ts`), path.ux's `UXToolMeta` plus the
  fields an offer adds: `toolPath` is the command or effect id, and `on`, `supplies` and
  `form` sit beside it. `props` and `then` are JSON strings, because nstructjs has no
  variant type and both are arbitrary shapes.
- `widgetPath` is `<home>/<stem>~<hash>`, from `widgetSegment(tag)` over every tool's
  `identity()`. It is a name for the control that both tiers can compute: the derived tier
  calls `tagOf(offer, home)`, the same writer against a bare object with no widget under
  it.
- A pass replaces the tools an earlier pass left on a node, and a second offer within one
  pass appends. Appending unconditionally, which is what path.ux's own builders do, would
  grow `tools` on every redraw of a control a later pass re-anchors — the pin toggle, the
  task graph's gate buttons — and since the hash covers every tool, the control's name
  would move each frame and `anchors.json` would stop being reproducible.
- The app writes the tag and never reads it back. The tour resolves against the registry's
  `Anchor` objects, which hold live handles; the tag is for the sweep and for anything
  reading the DOM from outside.

### The registry

- `window.__vnAnchors` exposes `generation()`, `dump()`, `walk()`, `menus()`, `strays()`,
  `shortcuts()` and `press(key)`. `menus()` lists every menu entry from the menu table,
  `shortcuts()` compares each live keymap with the shortcut table, and `press` clicks the
  control an anchor names, which is how the sweep opens each toolbar popup. It is present
  in production builds, unlike `window.__vnDebug`, because the tour uses it at runtime.
- `dump()` returns one `SweptAnchor` per live anchor: its key, its home, `via`, its rect,
  and the node's tag through `nstructjs.writeJSON`, narrowed to the one tool this anchor's
  own offer put there. `tag` is `null` where the node carries no tag at all, which the
  sweep reports rather than records.
- `walk()` walks the whole document with path.ux's `walkWidgets` and returns every
  `widgetPath` it finds, sorted. It is a second opinion on the tag layer's reach, taken
  without asking the passes. Only this app's writer fills `widgetPath`, so a tag path.ux's
  own builders left on a widget is skipped rather than reported as an anchor nothing
  claims.
- `anchorSnapshot(open)` produces the `LiveAnchors` object the resolver reads. The caller
  passes the list of open panes, because only the pane mesh holds that list. The header is
  always in the snapshot, and so is each toolbar popup (`notifications`, `approvals`,
  `diagnostics`) while it is open; `popupOpened` and `popupClosed` tell the registry
  which. The registry itself computes which anchors are offscreen from their rects,
  counting one whose middle a scrolling ancestor clips.
- Anchors for a pane that is not open stay in the registry but are excluded from the
  snapshot. path.ux detaches an area on a tab switch and does not redraw it when the tab
  returns, so the anchor records cannot be dropped when the pane closes.

### The anchor map

Before any pane is open, the tour must determine which editors draw a control for a
command (which pane has the `prompt.condense` button?). The anchor map (`ANCHOR_MAP`)
lists the editors that draw a control for each command, and it comes from two sources:

- Every menu is data (`rules/menus.ts`), so `window.__vnAnchors.menus()` lists the tree's,
  the shot, line and card menus', the Threads menu's and the header's entries without
  opening one.
- `scripts/sweep-anchors.mjs` takes the measurement. It connects to a running app over
  CDP, opens each editor in turn, dumps the anchors, presses the opener of each toolbar
  popup and dumps that too, reads each live keymap against the shortcut table, and writes
  `apps/desktop/anchors.json`. It asks `stack.check` about command anchors only, since the
  stack knows no effect. The file is committed at the app root (rather than under the
  gitignored `dist/`) so that a change in coverage appears in review as a diff.

Each record is flattened out of the anchor's tag rather than out of a payload the registry
shapes for the sweep: `read()` takes `toolPath`, `props`, `supplies`, `form`, `on` and
`then` from the anchor's one tool, and `enabled`, the refusal sentence and `widgetPath`
from the tag itself. A control record therefore carries `widgetPath`, which is the name
the derived tier gives the same control.

`anchors.json` records the project title along with the scene and shot that were selected
when the anchors were measured, because many controls are only drawn when a subject is
selected. A command absent from the file resolves as `unanchored`, and the tour falls back
to the command palette. The fallback is the same whether the file is stale, the project
was never swept, or the command has no control.

Re-run the sweep after changing anything under `apps/desktop/renderer/pathux/editors/**`:

```bash
pnpm build:desktop
pnpm vndesktop --mock --project <dir>   # keeps running; prints the port it opened
node scripts/sweep-anchors.mjs          # second shell, VN_CDP_PORT set to that port
```

`pnpm vndesktop` takes the first free port from 9222 upward and prints it.
`scripts/cdp.mjs` defaults to 9222, so set `VN_CDP_PORT` in the second shell if the
launcher printed a different port.

The sweep's summary line says how many commands have an anchor and how many of the twelve
effects are drawn, and it lists per editor the derived commands the swept project never
showed. The sweep formats what it writes, since `pnpm lint` checks `anchors.json` like any
other file. Revert a run that changes nothing but the `sweptAt` and `gitSha` lines rather
than committing it, because the file exists to record coverage.

### Resolution

`resolveAnchor(map, live, action)` finds the anchor for a requested invocation in a
snapshot. The function is pure, lives in `renderer/rules/anchors.ts`, and has node unit
tests. It returns one of:

| Result          | Meaning                                                                           | Tour response                                |
| --------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| `ready`         | An enabled anchor matches.                                                        | Highlight it.                                |
| `input`         | An anchor matches, and the step's remaining props are ones the widget `supplies`. | Highlight it and say what to type.           |
| `disabled`      | The matching anchor is disabled.                                                  | Highlight it and show the recorded reason.   |
| `offscreen`     | The matching anchor is scrolled out of the window.                                | Scroll it into view and resolve again.       |
| `wrong-subject` | Anchors exist for the command id, but their props conflict with the step's.       | Ring the row that selects the right subject. |
| `pane-closed`   | The map lists editors for this command, and none of them is open.                 | Say which pane to open.                      |
| `popup-closed`  | The map lists only a toolbar popup for this command, and it is shut.              | Ring the toolbar control that opens it.      |
| `absent`        | An editor the map lists is open, but it is not drawing the control now.           | Fall back to the palette.                    |
| `unanchored`    | The map lists no editor for this command.                                         | Fall back to the palette.                    |

A candidate is an anchor whose `id` equals the step's. A row that selects a subject has
the id `ui.publish`, so a step naming a command never lands on a row, and a step whose own
id is missing (a malformed step read from JSON that was not an object) matches nothing
rather than every anchor on screen.

`absent` and `unanchored` are kept distinct, for the same reason that
`Interaction.targets` distinguishes an empty target list from `UNRESOLVED`. `absent`
describes the current screen and `unanchored` describes the map, and a caller diagnosing a
stale map needs to know which of the two it has.

Prop matching uses subsumption rather than equality (`subsumes`). An anchor records only
the props known at draw time, and the prop the author is about to type cannot be recorded,
so:

- every prop the anchor records must equal the step's value;
- if the step names a prop that the anchor does not, the anchor must either `supplies`
  that prop (the result is then `input`) or be a `form` anchor, which accepts any prop
  because the form takes them all;
- any other difference is `wrong-subject`.

The `form` case makes the palette a valid resolution for any step rather than a last
resort.

A `wrong-subject` result also carries `holds`, naming which of the conflicting props the
anchor itself records a different value for. The rest are props the anchor neither records
nor supplies (free text, a flag, a step naming a prop this control does not take). They
name nothing the author could select. Keeping the two apart makes the search below sound.

`resolveSubject` runs that search. It looks at the held props' string values and finds an
anchor that selects one of them two ways: a `ui.publish` anchor whose props carry that
value (an asset hash, a `sceneId`), or one whose item key is that value read as a kind and
a key (`character:aiko` → `item:character/aiko`). The pane that gave the mismatch is
preferred, so the pane the author is already looking at retargets. Empty values are
skipped, since a click that clears a field publishes `''`.

Two cases do not resolve. Both are handled explicitly rather than ignored:

- A rung below the entity (`character:aiko/gala`, `shot:greet/s2`) has no document-tree
  node and no `ui.publish` anchor, so the step is `blocked` and names the subject.
  Blocking is the right outcome, because otherwise the author's art note would be written
  onto whichever rung the pane was showing.
- If the held props name nothing, the control supplies the answer itself. The answer is
  the ring as before, unless the control is greyed, in which case the answer is the
  control's refusal. A refused offer is recorded with no props at all, so a greyed control
  with an empty record falls into this case.

### Cross-checks

Both halves of the layer are checked against an independent source:

- Checks enabled state against `stack.check`. The sweep calls `stack.check` for every
  command anchor it records (an effect is not the stack's to judge) and reports (without
  fixing) each case where the control's enabled state disagrees with the stack's verdict.
  This caught the branch editor drawing `delete <scene>` enabled for the entry scene,
  which main refuses to delete. The editor was calling `stack.check` only on hover, and
  now calls it when the button is drawn.

    Anchors with `supplies` or `form` are exempt, because their props are deliberately
    incomplete and the verdict would be about the blank rather than about the project.
    That exemption also applied to a real case: the task graph's gate buttons were drawn
    live on a project with nothing rendered, so a tour invoked a button whose form could
    not be completed. The editor now asks as it draws, passing the blank hash explicitly,
    and greys the button only when `gate:candidates` is empty. When candidates are on
    file, the form is where the portrait is named, so the button stays live and the
    sentence goes to its tooltip.

- Compares the recorded rect against a hit test. `landsOn` checks whether a click at the
  anchor's centre would reach it. For a `pick` anchor it calls the canvas's `pick()`. For
  everything else it goes through `hittest.ts`, which descends into shadow roots because
  `document.elementsFromPoint` stops at a shadow host and every editor surface is inside
  one. Disabled controls are skipped, since they usually have `pointer-events: none`.
  Points outside the window are skipped too; that case is already reported as `offscreen`.

- Checks the tag against the anchor. An anchor whose node carries no tag, or whose tag
  names no tool, would leave a record with no id at all, so the sweep lists it as
  `untagged` and drops it from the file.
- Checks the passes against the widget walk. Every anchor's `widgetPath` must be one
  `window.__vnAnchors.walk()` found, or it lands in `unwalked`: `walkWidgets` descends a
  `UIBase`'s shadow and no other kind of shadow root, so a control mounted under one of
  those is anchored and unreachable to anything walking the document. Both lists are
  written into `anchors.json`, empty being the healthy answer for each.

    The walk's other direction is information rather than a finding. A control that is in
    the document without being drawn keeps the tag its last pass wrote, so the sweep
    prints the named controls in a home that no live anchor claims — the composer's Stop
    button and the agent report's, both hidden between turns.

`getBoundingClientRect()` does not report the hit area. A gen-graph socket is an 8×8
element with a `::before` of `inset: -5px`; the browser hit-tests the pseudo-element as
part of the socket, so the socket accepts clicks over 18×18 while its rect reports 8×8,
and `getClientRects()` excludes pseudo-elements as well. The ring is drawn `RING_PAD` px
outside the rect. When the hit test lands on a descendant that extends outside that rect,
the ring is enlarged to include the hit element's rect.

### Enforcement

CI has no app, no CDP port and no workspace, so the checks are split:

- Blocking: `apps/desktop/src/main/tests/anchorcoverage.test.ts` reads the committed
  `anchors.json` and fails if a record names a command or an effect that no longer exists
  (each checked against its own registry), if the file's command list differs from the
  live registry's command list, or if the file's `anchored` and `effects` lists disagree
  with its own records.
- Blocking: `apps/desktop/src/main/tests/uxmodel.test.ts` reads the committed
  `ux-model.json` beside the two registries and `anchors.json`. Every command is the id of
  some derived record or matches the palette-only list, no entry matches a command a
  control runs, no entry matches nothing, every action names a command or an effect with
  props the effect accepts, every shortcut binds one of the two, every control the sweep
  drew has a derived record with the same editor, id, `form`, `supplies` and `then` by
  shape, the two tiers agree wherever both name a control the same `widgetPath`, the menu
  records agree entry for entry, every `view.open` leaves the pane to the router, and a
  mutating command a menu runs on the click is undoable, confirms or is exempt with a
  reason. Part III has the rules in full.
- Blocking: `apps/desktop/renderer/rules/tests/model.test.ts` fails when `ux-model.json`
  differs from a fresh derivation, when two records in one situation share a key or a
  `widgetPath`, when a fixture's refusing verdict does not surface verbatim, when an
  action names an effect the app does not declare or gives it a value its spec refuses,
  when a declared effect is offered nowhere, or when the shortcut section differs from the
  table.
- The sweep is advisory, is run by hand, and is the only place that reports disagreements
  and strays. A `wording` disagreement is a refused control whose derived record says the
  sentence came from the stack, drawn with a sentence the stack did not say.

## Part II — the tour

### Steps

A `Tour` (`src/shared/tours.ts`) has an id, a title, a one-sentence `what`, and a list of
steps. Each step has a `say` instruction and one of four kinds:

| Kind      | The author is asked to                         | Fields                                                 |
| --------- | ---------------------------------------------- | ------------------------------------------------------ |
| `command` | click a control that runs a command            | `id`, optional `props`                                 |
| `input`   | type into a field and commit it                | `id`, `supplies` (the prop typed), optional `props`    |
| `select`  | select a subject by clicking an `item:` anchor | `itemKind`, `key`                                      |
| `gesture` | drag something                                 | `id` (an interaction id), `carried`, optional `target` |

A `gesture` step is evaluated by calling `Interaction.targets` exactly as a real drop
calls it, without arming anything or moving the pointer. The tour highlights the element
to pick up and outlines each target that would accept it. `Interaction.targets` requires
the surface's current state, so each editor registers a state reader in
renderer/pathux/interactions/gestures.ts under its interaction namespace, with
`gestureState(namespace, editor, read)`. The editor is part of the registration because
two panes can show the same scene (the document tree and the branch editor), and the drag
has to start on the pane that runs the gesture.

A registration outlives its pane (for the same reason an anchor does), so `verdictsFor`
takes the open set and returns nothing for a namespace whose editor is not in it. The step
then finds nothing on screen that runs the gesture, which is the state of a closed pane.
Without the check, the closed pane's verdicts are read first and its refusal is reported
as the step's own answer.

### What a step displays

`guide(map, live, state, judge, refused)` in renderer/rules/tour.ts computes what the
overlay shows for the current step:

- `ring`: highlights an anchor and captions it with the instruction.
- `pick`: highlights the row that selects the step's subject, because the control the step
  names sits on a different row. The caption carries the instruction and a second line
  saying to click this row first. This kind is not called `select`, because `select` is
  already a step kind and resolves to `ring`.
- `route`: no control is drawn for this command; open the palette instead.
- `open`: Opens a pane and names it. A pane must be opened first.
- `blocked`: the step cannot run now. Carries the reason (from the command's rule or from
  `Interaction.targets`). Also carries the anchor of the disabled control when that
  control is on screen, and the control is then highlighted with the reason in its
  caption.
- `done`: no steps remain.

A control that opens the command's form is drawn enabled, because the refusal applies to
the command behind the control rather than to opening its form. `guide` therefore takes a
`refused` lookup alongside the snapshot and turns a `ring` into a `blocked` when the stack
has refused the command. The lookup reads a cache the caller owns: `stack.check` is
asynchronous and runs in main, while `guide` remains a pure function of what is drawn.

`renderer/pathux/tour/tour.ts` fills that cache. For each anchor a step points at, it
calls `checkFor(anchor, props)` (`renderer/rules/precheck.ts`) to build the invocation to
check, then issues `command:check`, and stores the refusal under the anchor key. The
answer arrives asynchronously, and the overlay reads it on the next re-resolve. An entry
is checked again whenever an anchor's recorded props change.

A refusal describes the project rather than the screen, so anything that could have
changed the project under it clears the refusal. Three things do. The first is `onWrote`.
The second is a command that ran successfully, because `onWrote` does not fire for a
command that reports no written path, such as `project.setKey` writing a key file outside
the repository. The third is starting a tour, which drops the refusals from the previous
tour.

`checkFor` exists because `stack.check` coerces props before they reach a command's
precondition. A check that omits a prop the widget has not supplied yet reports
`missing required property "hash"`, but the useful answer is `aiko has no portrait yet`.
Passing the missing prop explicitly as an empty value reaches the precondition, which is
written for that case. `checkFor` adds no information of its own: a required prop with no
empty value, such as a number or an enum, cannot be checked at that anchor, and a secret
is never filled in even with a blank.

### The overlay

The highlight (the ring) is drawn in a fixed-position `<div>` with `pointer-events: none`,
appended to `document.body` with a z-index above every path.ux layer, including the
docker's own popups. Two timers drive the ring:

- a `requestAnimationFrame` loop re-reads the anchor's rect every frame, so the ring stays
  on the anchor during a scroll without lag;
- a `setInterval` re-runs `guide()` every `RESOLVE_MS` and repaints. The re-run is needed
  because the step's target may have changed after a click. The repaint is needed because
  Chromium stops delivering frame callbacks to an occluded window.

If the hit test at the ring's centre does not reach the anchor, the overlay first calls
`scrollIntoView` once, because a control clipped by a scrolling container still has a rect
inside the window. If the hit test still fails after that, the overlay logs one
`console.warn` per anchor and leaves the ring where it is; the overlay cannot distinguish
an element covered by another from an element that moved between frames.

The same layer draws a banner at the bottom of the window for as long as a tour is
running. The banner shows the tour's title, which step of how many, and a button that runs
`tour.cancel`. A step with a control to point at states what to do in the ring's caption,
so the banner shows only the title and the count. A step with nothing to point at has no
caption, so the banner carries the instruction and where to find it.

The banner shows that a tour is running when the first step routes to the palette, and
nothing else does. Before the banner, starting a tour from the palette retargeted that
palette to the step's command, and the only other sign was a notification that cleared
after a few seconds. The author was left looking at a form for a command they had not
asked for, with nothing saying a tour had started. `retarget` now also sets the search box
to the command it moved to, so the list agrees with the form.

### Advancing

The tour subscribes to `onExec` in `bridge.ts` and advances when a successful command
matches the current step, no matter which control ran it (a button, the palette, or a
hotkey). Matching uses subsumption (`satisfies`), so an `input` step matches regardless of
the value the author typed for its `supplies` prop, provided the author typed one. An
`input` step exists so that the author supplies a value, and `art.setNotes` accepts an
empty note as a legitimate value (it removes the note), so committing the field blank
would otherwise advance the step over a no-op.

`satisfies` compares against the recorded props rather than the real ones, so a bulk prop
arrives digested. A digest carries the value's byte length, so an empty bulk prop is
recognisable: it records as `EMPTY_DIGEST` in `@vn/commands`, and the rule reads that as a
blank field. A `prop.secret` records as `<secret>` whatever it held, so the rule cannot
tell an empty secret from a non-empty one. That is a limitation of the rule rather than a
case it decides, and nothing reaches it today, because `project.setKey` refuses an empty
key before a record is written.

A gesture step has no fixed invocation, because which command a drop runs depends on the
target. The step takes its `invoke` from the verdict it was displayed with.

Any other command is ignored. If the author does things in another order, the step is
re-resolved against the new screen state.

`window.vn.exec` (the CDP scripting bridge) calls main directly and does not pass through
`bridge.exec`, so a command run from CDP does not advance a tour. The palette's run button
goes through the bridge.

### Palette fallback

For a `route` step, `openPalette(id, props)` opens the command palette on the command with
the step's props pre-filled. `CommandForm` shows the current `stack.check` verdict above
its run button, so the author sees the same refusal a dedicated control would show, and
clicks run themselves. If the palette is already open, it is retargeted rather than closed
and reopened, so consecutive palette steps do not move focus.

The tour closes a palette it opened as soon as the step resolves to something else.
Opening the pane that draws a routed step usually triggers this close, and a palette left
up would sit over the control the ring points at. The tour also closes the palette when it
ends, whether through `tour.cancel`, the last step, or another tour starting. Otherwise a
form the author did not ask for would stay open with no tour behind it, which is the same
fault, only later.

### Sources of tours

- Curated tours are hard-coded in `apps/desktop/src/shared/tours.ts` (three at present).
  `main/tests/tours.test.ts` checks each step against the live registry. No step uses
  `gesture`, because a gesture step needs a scene or shot id from a specific project.
- Agent-written tours come from the `show_me` tool (`src/main/agent/showme.ts`), which the
  agent uses for anything the curated tours do not cover.

`show_me` exists only in the desktop app. It needs a window to display in, and `vnauthor`
has none, so the window push is a session dependency, and the tool returns an error when
the session does not supply that push. Before a tour is displayed, `checkTour` in
`shared/tourcheck.ts` rejects a step that names a command that does not exist, a prop the
command does not declare, a `supplies` prop that is not one of the command's props, or an
undeclared interaction id. Prop values are validated with `coerceProps`, the same function
that validates CDP input.

A tour written for the moment reaches the app two ways, and main checks both, because main
holds the catalog. The agent uses `show_me`. CDP and the palette use the `custom` field of
`tour.start`. Without the check, a hallucinated command id filters the palette to nothing,
leaving no form and no explanation of why.

`checkTour` deliberately does not call `stack.check`. `stack.check` reports whether a
command can run now, and the later steps of a tour are usually refused until the earlier
ones complete (approve the portrait, then run), so gating on it would reject every correct
multi-step tour. The verdict is shown when the step is reached instead.

### Commands

`tour.start`, `tour.next`, `tour.cancel` and `tour.explain` are registered commands, all
non-mutating and none undoable. Like every other command, they run in main and push a
`command:ui` effect; the renderer applies the effect and owns the tour's state, since only
the renderer holds the drawn state.

`tour.explain` re-displays the current step. For a `route` step it also states when
`anchors.json` was swept and at which commit, because the palette was chosen from that
file rather than from the screen.

The agent uses `show_me` rather than these commands. A command without a tool wrapper is
unreachable from the agent in either host.

## Part III — the derived model

`anchors.json` is a measurement: what one running app drew for one project in one state.
`apps/desktop/ux-model.json` is the other half, derived with no app: every rule module's
`controls(state)` run over a hand-written list of states, so the file describes every
control a module can produce and the sentence each carries, whether or not the sample
project reaches it. The two are compared where they overlap. The file is what an agent or
a person reads to answer "which control runs this command, and when is it refused"; the
tour does not read it, because a situation is a fixture rather than a recipe for reaching
that state in a project.

### The file

`ux-model.json` is `{ situations, records, paletteOnly, shortcuts, menuExempt }`, and its
schema is the zod in `src/shared/uxmodel.ts` (`UX_MODEL`), every object `.strict()` so a
field the schema does not name is a parse error. The file carries no timestamp, sha or
path. It is a pure function of the sources, so the committed copy either equals a
regeneration or is stale, and a jest test tells the two apart. That is how the staleness
rule for a committed generated file is answered: by construction rather than by comparing
commit shas, which would fail on a DOM-only edit that cannot change the derivation and
pass on a hand edit made after regenerating.

### Situations

A situation is a named fixture of one module's state type, `{ name, why, state }`
(`renderer/rules/situations/situation.ts`). The lists live in
`renderer/rules/situations/<module>.ts`, one file per rule module, each exporting
`SITUATIONS`; the `situations(...)` helper rejects a duplicate name at construction. The
list is the one hand-written input to the model.

A situation exists where a module lists a control it lists nowhere else, refuses one it
accepts elsewhere, refuses it with a different sentence, or offers it with different
props. Two states that differ only in a label are one situation. A verdict a module would
drop (an answer for a scene the selection has left, a door verdict on a decomposed scene)
is not a situation, because the wording rule below would report the drop as a lost
sentence. `why` is one sentence saying what the situation gates. Every `convobar` fixture
keeps `context` and `spent` below 1000, because two of its tooltips go through
`toLocaleString`, and a fixture above that would make the file differ by machine.

### The driver

`renderer/rules/model.ts` holds a table (`ROWS`) with one row per rule module: its name,
its anchor home, its source path, its situations and its `controls`. The asset home's two
modules are two rows, and the pin toggle is one module, `rules/pin.ts`, with a row per
pinnable pane. A second table, `MENU_ROWS` in `rules/menus.ts`, holds the menus: the
document tree's right-click over the exported `MENU_NODES`
(`renderer/pathux/doctree/doctree.ts`, one node of each kind, under the situation
`every-kind`), the shot, line and card menus over a fixture each, the conversation bar's
Threads menu, and the header's four menus from `rules/headermenus.ts`. `model()` emits
situations in table order and records in table order, then situation order, then
`controls()` order, then the menu records, so a diff of the file reads in the order the
app draws.

`rules/` importing `doctree.ts` is the one place `rules/` reaches under `pathux/`; the
file is pure, node-tested, and touches no DOM at load, which the driver's own test proves
by loading it under jest.

### The record

A control record is
`{ via: 'control', editor, module, situation, key, widgetPath, offer, effects, reasonFrom?, shortcut? }`.
`key` is `keyOf(offer)`. `widgetPath` is `tagOf(offer, editor).widgetPath`, the same meta
tag the live pane writes, built here with no widget under it. It is what a swept record is
keyed against, since it is the one name both tiers compute the same way; the key is not,
because a live pane cannot say which situation it is in. `offer` is the module's `Offer`
projected to its declared fields by `pickOffer` (`ok`, `id`, `props`, `label`, `tooltip`,
`on?`, `supplies?`, `form?`, `refusal?`): the asset editor's offers carry riders the
editor reads back (`act`, `note`, `variants`), and those are neither what the control does
nor stable across fixtures. `reasonFrom: 'stack'` is stamped on a refused record whose
reason equals a refusing `command:check` verdict found anywhere in the situation's state;
the driver finds verdicts by shape, because a verdict names no command. `effects` is what
the click does, in order: `[{ id, props }, ...then]` for an accepted offer and `[{ id }]`
for a refused one. `shortcut` is stamped where a binding in the editor's scope or the
shell's matches the first effect by id, `on` and the props the entry names.

A menu record is
`{ via: 'menu', editor, module, situation, when, id, label, tooltip?, props?, on?, supplies?, form?, then?, refused?, shortcut? }`.
`when` is what the menu was drawn for: the node id for the tree, `shot:<scene>/<id>`,
`line:<id>` or `card:<id>` for a right-click, `threads` for the conversation bar, and
`header/<menu>` for the header's, with a submenu's rows under `header/<menu>/<submenu>`.
`refused` is the entry's own sentence where it is drawn greyed, and a submenu entry is
recorded as the `menu.open` effect it is.

A row that selects a subject is in the model as a `ui.publish` record, keyed
`item:<kind>/<key>`, whose `then` carries the `view.open` the route opens with. The two
answers `routeFor` can give (`here` with the claimant visible, `elsewhere` without) are
two situations each of `documents`, `script` and `wiki`.

`paletteOnly` is `renderer/rules/paletteonly.ts`: the commands no drawn control runs, each
with a sentence saying where it is reached instead. `match` is a command id, a namespace
(`workspace.*`) or a name (`*.list`), with one `*` at either end and nothing else, so a
glob can only cover what its sentence covers. A namespace is a glob only where every
command in it is palette-only for one reason; the script editor's structural `story.*`
commands are listed by id, so a new one is reported.

`shortcuts` is `renderer/rules/shortcuts.ts` written out: every key binding as
`{ scope, key, mods, label, runs, on?, shadows?, from? }`, where `scope` is `global`, an
editor id or `main`, `runs` is the action the key performs, `on` narrows the binding to
one control's target (or, ending in `/`, to every target under that family — the Page
editor's `corner/` rows), `shadows` marks an editor binding that takes a combination the
shell also binds, and `from: 'pathux'` marks the Gen Graph pane's five, copied from
path.ux's node editor. The shell keymap and the Play pane build their `HotKey`s from the
table through `bindings()`, and the header's menu rows, the Gen Graph tooltips and the
palette button read `shortcutOf` for their labels, so a binding is spelled once. A
shortcut is a property of the control it duplicates rather than an effect.

`menuExempt` is `renderer/rules/menuexempt.ts`: the mutating commands a menu runs on the
click that neither undo nor confirm, each with the reason it is allowed to.

### The rules over the file

Blocking, in jest under `@vn/desktop`:

| Rule                                                                                                                                                 | Where                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The file parses under `UX_MODEL`                                                                                                                     | `renderer/rules/tests/model.test.ts`                                          |
| The file equals a fresh `model()`; a failure names the first record that differs and says to run `pnpm gen:uxmodel`                                  | `renderer/rules/tests/model.test.ts`                                          |
| No two records in one situation share a key, or a `widgetPath`                                                                                       | `renderer/rules/tests/model.test.ts`                                          |
| Every refusing verdict in a situation's state surfaces verbatim, as a refused record's reason or an accepted one's tooltip                           | `renderer/rules/tests/model.test.ts`                                          |
| No key is produced by two modules of one home, over every situation                                                                                  | `renderer/rules/tests/model.test.ts`                                          |
| The menu records equal `menuRecords()` entry for entry, and the `shortcuts` section equals the table                                                 | `renderer/rules/tests/model.test.ts`                                          |
| Every action names a command or an effect the app declares, with props the effect accepts; every declared effect is offered                          | `renderer/rules/tests/model.test.ts` and `src/main/tests/uxmodel.test.ts`     |
| A control whose first effect a binding in its editor's scope or the shell's matches carries that `shortcut`                                          | `renderer/rules/tests/model.test.ts`                                          |
| Every registry command is the id of some record or matches `paletteOnly`                                                                             | `src/main/tests/uxmodel.test.ts`                                              |
| No `paletteOnly` entry matches a command a control runs, and none matches nothing                                                                    | `src/main/tests/uxmodel.test.ts`                                              |
| Every control `anchors.json` drew has a derived record with the same editor, id, `form`, `supplies` and `then` by shape                              | `src/main/tests/uxmodel.test.ts`                                              |
| Where both tiers name a control the same `(editor, widgetPath)`, they agree on its key, `form`, `supplies` and `then` by shape                       | `src/main/tests/uxmodel.test.ts`                                              |
| The menu records in `anchors.json` equal the derived ones as a set of `(when, id)`                                                                   | `src/main/tests/uxmodel.test.ts`                                              |
| Every `view.open` leaves the pane to the router: no `where` or `elsewhere`; `here` only on a routed row; `popup` only for the report; nothing splits | `src/main/tests/uxmodel.test.ts`                                              |
| A mutating command a menu runs on the click is undoable, confirms, or is in `menuExempt` with a reason; no exemption is dead                         | `src/main/tests/uxmodel.test.ts`                                              |
| A shortcut binds a command or an effect; in one scope a combination is bound once, and an editor takes a shell combination only with `shadows`       | `src/main/tests/uxmodel.test.ts` and `renderer/rules/tests/shortcuts.test.ts` |

The comparison against `anchors.json` runs one way. A derived control the sweep never drew
is expected while the sweep visits one project state and the model many, so the sweep
prints those per editor as information (`asset: 9 derived command(s) not drawn: …`), and
`not swept` for the header, which is not an editor `view.open` can open.

Three fields are deliberately outside it. `enabled`, the tooltip and the refusal sentence
are not compared and must not be added: the derived tier is situation-indexed and the
measured tier is not, so 981 derived control records collapse to 302
`(editor, widgetPath)` pairs, 46 of which hold records that disagree with each other on
`offer.ok`. A measured record observes one screen and keys onto several derived records
carrying contradictory values for exactly those fields, so the comparison would be a coin
toss. They have a better oracle in any case: the sweep asks `stack.check` per command
anchor, and the stack is what the rules echo. Prop values are out for a second reason —
the derived tier's subjects are fixtures and the sweep's are the swept project's, so a
scene id, an asset hash and `view.open`'s `where` differ by construction, which is why
`then` is compared by shape (each action's id and its prop names) rather than by value.

`widgetPath` names the same control on both sides only where the offer's `on` is fixed or
absent, since `widgetSegment` hashes `identity()` and `on` is often a subject. Of the 339
controls the sweep drew, 116 have a path the derived tier also produces, and those are the
population the second row above checks.

Advisory, in the sweep: the `wording` disagreement. The sweep reads `ux-model.json` for
the `(editor, id)` pairs some record marks `reasonFrom: 'stack'`, and for a refused anchor
in that set compares its reason to the stack's verdict. A refused offer carries no props,
so an anchor whose command requires one is skipped: the stack, asked about the blank,
answers with a coercion failure rather than the sentence the pane echoed.
`refusal.description` is never compared, on either half. Two more advisory reports come
from the sweep: each live keymap against the shortcut table, by scope, and a toolbar popup
the header drew no opener for.

### Regenerating

```bash
pnpm gen:uxmodel
```

`scripts/gen-ux-model.mjs` bundles `renderer/rules/model-entry.ts` for node through
`scripts/lib/load-entry.mjs`, the way the command catalog is produced, writes the file and
formats it. Run it after touching anything under `renderer/rules/**` or a situation;
`model.test.ts` fails until the committed file equals the regeneration. Running it twice
produces identical bytes.

## Files

| Path                                       | Contents                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/commands/src/effect.ts`          | `Effect`, `defineEffect`, `EffectRegistry` and its `verify`                                                                                                                                                                                      |
| `apps/desktop/src/shared/effects.ts`       | The twelve effects and their value lists (`MENUS`, `POPUPS`, `VIEWS`, …); `isEffectId`, `createDesktopEffects`                                                                                                                                   |
| `renderer/rules/effects.ts`                | One typed helper per effect, each returning an `Action`                                                                                                                                                                                          |
| `renderer/rules/anchors.ts`                | `Action`, `Offer`, `refuse`, `keyOf`, `effectKey`, `openerKey`, `duplicateKeys`, `applyOffer`, `toolOf`, `writeTag`, `tagOf`; anchor and resolution types; `subsumes`, `resolveAnchor`, `resolveItem`, `resolveSubject`, `resolveNamed`, `mapOf` |
| `renderer/rules/toolmeta.ts`               | `VnToolMeta`: path.ux's `UXToolMeta` plus the offer's `on`, `supplies`, `form`, `props` and `then`                                                                                                                                               |
| `renderer/rules/ring.ts`                   | Ring geometry: `ringRect`, `union`, `outset`, `RING_PAD`                                                                                                                                                                                         |
| `renderer/rules/tour.ts`                   | `TourState`, `guide`, `satisfies`; pure, no DOM                                                                                                                                                                                                  |
| `renderer/rules/anchormap.ts`              | `ANCHOR_MAP`, loaded from `anchors.json`                                                                                                                                                                                                         |
| `renderer/rules/precheck.ts`               | `checkFor`, `askedAs`: which invocation a ringed anchor is checked with                                                                                                                                                                          |
| `renderer/pathux/tour/anchors.ts`          | The registry: `redrawing`, `AnchorPass` (`act`, `record`, `pick`), `anchorSnapshot`, `dumpAnchors`, `walkedAnchors`, `landsOn`, `strayAnchors`, `press`, `menuAnchors`, `shortcutReport`, `popupOpened`, `popupClosed`                           |
| `renderer/pathux/chrome/showmenu.ts`       | `menuTemplate` and `showContextMenu`: the one menu builder the header and the right-click menus share                                                                                                                                            |
| `renderer/pathux/interactions/hittest.ts`  | `elementsAt`, `reaches`, `hitFor`: hit testing through shadow roots                                                                                                                                                                              |
| `renderer/pathux/tour/overlay.ts`          | The ring layer and its two timers                                                                                                                                                                                                                |
| `renderer/pathux/tour/tour.ts`             | The running tour; `window.__vnTour`                                                                                                                                                                                                              |
| `renderer/pathux/interactions/gestures.ts` | Per-editor gesture state readers                                                                                                                                                                                                                 |
| `src/shared/tours.ts`                      | `Step`, `Tour`, and the curated tours                                                                                                                                                                                                            |
| `src/shared/tourcheck.ts`                  | `readTour`, `checkTour`                                                                                                                                                                                                                          |
| `src/main/commands/tour.ts`                | The `tour.*` commands                                                                                                                                                                                                                            |
| `src/main/agent/showme.ts`                 | The `show_me` agent tool                                                                                                                                                                                                                         |
| `apps/desktop/anchors.json`                | The measured anchor map                                                                                                                                                                                                                          |
| `scripts/sweep-anchors.mjs`                | The sweep that writes it                                                                                                                                                                                                                         |
| `renderer/rules/model.ts`                  | The derived model's driver: `ROWS`, `pickOffer`, `refusingVerdicts`, `effectsOf`, `situationRecords`, `model()`                                                                                                                                  |
| `renderer/rules/menus.ts`                  | `MENU_ROWS` and `menuRecords`: every menu as data                                                                                                                                                                                                |
| `renderer/rules/headermenus.ts`            | The header's four menus over `HeaderMenuState`                                                                                                                                                                                                   |
| `renderer/rules/shortcuts.ts`              | `SHORTCUTS`, `comboOf`, `shortcutOf`, `findShortcut`, `bindings`, `shortcutRecords`                                                                                                                                                              |
| `renderer/rules/menuexempt.ts`             | `MENU_EXEMPT`: the mutating menu entries allowed to neither undo nor confirm, with reasons                                                                                                                                                       |
| `renderer/rules/route.ts`                  | `routeFor` and `openOf`: which pane a click opens, and the `view.open` a row records                                                                                                                                                             |
| `renderer/rules/selection.ts`              | `selectionForNode`, `publishedBy`, `taskPublishes`: what a row publishes                                                                                                                                                                         |
| `renderer/rules/pin.ts`                    | `PINNABLE`, `pinAction`: the pin toggle's offer for every pinnable pane                                                                                                                                                                          |
| `renderer/rules/situations/`               | `situation.ts` (`Situation`, `situations`), one `SITUATIONS` list per rule module, and `pin.ts`'s `pinSituations(field)`                                                                                                                         |
| `renderer/rules/paletteonly.ts`            | `PALETTE_ONLY`: the commands no control runs, with reasons                                                                                                                                                                                       |
| `src/shared/uxmodel.ts`                    | `UX_MODEL` and the record schemas; `actionsOf`, `actionProblems`, `paletteMatches`                                                                                                                                                               |
| `apps/desktop/ux-model.json`               | The derived model                                                                                                                                                                                                                                |
| `scripts/gen-ux-model.mjs`                 | `pnpm gen:uxmodel`, which writes it                                                                                                                                                                                                              |

## See also

- [`command-system.md`](command-system.md) — covers commands, props, `stack.check`, and
  the interaction layer that evaluates gesture steps.
- [`desktop-app.md`](desktop-app.md) — describes the editors that anchors are recorded in,
  and the pane rules for a `pane-closed` result.
- [`../guides/debugGuide.md`](../guides/debugGuide.md) — documents `@vn/debug2d`, whose
  hit oracle descends the shadow root the same way the overlay does.

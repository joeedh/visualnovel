# Pseudo-commands, and a control's list of effects

Status: **in progress**, stages 1 to 4 of 8 committed on branch `effects`; see
[Progress](#progress). Plan 4 of
[`ux-behaviour-model-tasklist.md`](ux-behaviour-model-tasklist.md), after
[`archive/situations-and-the-derived-model.md`](archive/situations-and-the-derived-model.md).
The derived model names every control that runs a command. This plan names the rest: a
click that publishes a selection, expands a tree node, opens a menu or a popup, scrolls a
pane, arms a drag, undoes, or answers the agent. Each becomes an entry in a closed
vocabulary registered beside the commands, recorded from the same object that installs its
handler, so the model reads it the way it reads a command. Four lint rules the tasklist
routes here become checkable once it does: a surface opens an editor only through the
sparing rule, a mutating command reached from a menu is undoable or confirms, a keyboard
shortcut is bound once, and two controls in one pane share a key only with a
discriminator.

This is the largest plan of the batch, as the research report said it would be
([`../research/ux-behaviour-model.md#pseudo-commands`](../research/ux-behaviour-model.md#pseudo-commands)).
It is staged so that each rule lands with the stage that makes it checkable, and so that
the first three stages are worth taking on their own.

## Progress

Branch `effects`, off `master` at `a41360a3`. Stages 1 to 4 are committed and were green
under `pnpm check`, `pnpm test` and `pnpm lint` when made; the sweep after stage 4 gave 0
strays and 0 disagreements. Stage 5 was begun and not committed, and its edit was lost
when the branch was used for other work, so stage 5 starts from the stage-4 commit. The
branch head (`b3e455c2`) passes `pnpm check` and `pnpm test`, verified 2026-09-08.

| Stage | Commit     | As shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `7cb1d368` | As planned.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2     | `e40b7e08` | As planned, and `Anchor.id` became required. `documents.rowAction` gives `tree.expand` for a row naming nothing; `assetview.prereqAction` refuses with the manifest's note where the bytes are missing.                                                                                                                                                                                                                                                       |
| 3     | `555741e0` | `POPUP_HOMES` beside `ANCHOR_HOMES`; the header's three openers are `popup.open` offers from `rules/headerbar.ts`, keyed by the popup, and the sweep presses them through `window.__vnAnchors.press`. `rules/approvals.ts` and `rules/diagnostics.ts` exist as modules. `notify.markRead` stays palette-only with a reason. A `fixup!` (`be3a4be3`) is still to be squashed into this commit before landing.                                                  |
| 4     | `76a7b12d` | The builder is `buildMenu` in `chrome/showmenu.ts`; the header builds a `DropBox` per press instead of `bar.menu`. `rules/menus.ts` is a menu table the model files as menu records and the sweep reads through `window.__vnAnchors.menus()` instead of opening each menu. Handlers are keyed by `entryKey`. `hidden()` treats an anchor clipped by a scrolling ancestor as offscreen. Sweep: 71 of 170 commands, 8 of 12 effects, 333 records, 88 menu rows. |
| 5–8   |            | Not started.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Six commits from another piece of work sit on the branch above stage 4
(`f47e1d02`..`b3e455c2`): `apps/desktop/src/main` was split into `bootstrap/`, `runtime/`,
`workspace/`, `doctree/`, `assets/`, `agent/`, `notify/`, `distribution/` and `session/`,
and `editors/asset.ts` into `editors/asset/`
([`split-largest-source-files.md`](split-largest-source-files.md)). They land with the
branch. Paths this plan cites that moved:

- `src/main/index.ts:1111` (F12 and Ctrl+I) is `src/main/runtime/windowmanager.ts:171`;
  `:1160` (no Electron menu) is `src/main/bootstrap/bootstrap.ts:53`.
- `showme.ts` is `src/main/agent/showme.ts`; `src/main/commands/**` and
  `src/main/tests/uxmodel.test.ts` did not move.
- `editors/asset.ts` is `editors/asset/index.ts` and its delegates; the prerequisite row
  is recorded at `editors/asset/framing.ts:98`.

Stages 5 to 8 pick up the plan as written, with the stage-4 shapes above (`buildMenu`,
`rules/menus.ts`, `headerbar.ts`) in place of the names the plan used.

## Context

Measured on `master` at `9ba8a806`, after plan 3, before the moves listed under Progress.
The counts come from reading every handler in `apps/desktop/renderer/pathux/**`; the
classification is the research report's vocabulary plus what did not fit it.

- **About 200 handlers run without an anchor.** Grouped by what they do: 51 hold a draft,
  open or close an inline box, or swallow an event; 33 change what a pane shows without
  touching the project or the selection (Refresh, Fit, Tidy, a filter, a scope,
  `← Overview`, `Clear finished`, the Play pane's stepping); about 25 run a command
  through `exec` with no offer; 22 publish a `ui.*` selection; 19 are key bindings; 18
  open a popup; 14 open a menu; 7 arm a drag; 5 expand or collapse a tree node; 4 are
  window-level drop handlers; 1 scrolls. Nothing focuses a pane, so the research's
  `pane.focus` has no site.
- **Commands run with no offer in five places.** The notification popup's five `notify.*`
  controls go through a local `act` wrapper over `exec` (`chrome/notifications.ts:96`; the
  calls at `:213`, `:244`, `:277`, `:294`, `:300`); the Threads menu's rows
  (`editors/convo.ts:388`, `:409`); the Gen Graph bar's Delete and Duplicate
  (`editors/nodes.ts:183`, `:187`), which reach the delegate (`:634`) and `send` (`:724`),
  where the edit resolves to whichever `gengraph.*` command applies; the header's menu
  entries (`editors/header.ts:533`, `:539`, `:547`, `:598`, `:640`, `:652`, `:808`,
  `:823`, plus six dialog rows at `:517`, `:525`, `:556`, `:563`, `:714`, `:846`); and the
  approvals popup's rows (`chrome/approvals.ts:120`). The composer's Stop, the report's
  Stop and grant boxes, and the onboarding Save and Test are `record()`ed with a click
  that runs the offer's own id (`convo.ts:149`, `report.ts:137`, `:414`,
  `onboarding.ts:270`, `:311`), which is the pattern plan 2 settled and this plan leaves
  alone. Seven interaction-built widgets run a command on change with no record: the
  timeline's variant, cast, require-cast, outfit and remove controls
  (`editors/timeline.ts:750`, `:772`, `:793`, `:831`, `:857`), the script's cue picker
  (`editors/script.ts:616`) and the branch editor's edge label (`editors/branch.ts:748`),
  all listed by plan 2 as follow-ups.
- **Six sites record item anchors**, through `item()` or `pickItem()`
  (`renderer/pathux/tour/anchors.ts:127`, `:143`): every document-tree row
  (`editors/documents.ts:406`), a prerequisite row (`editors/asset.ts:1195`), a task card
  (`editors/tasks.ts:366`), a task node (`editors/graph.ts:372`), a scene card
  (`editors/branch.ts:313`) and a Gen Graph node frame (`editors/nodes.ts:324`, through
  `item()`, publishing nothing). An item anchor carries a `publishes` map and no `id`
  (`rules/anchors.ts:122`); `publishes` is read only by `resolveSubject` (`:353`) and is
  not in `AnchorDump`, so it never reaches `anchors.json`. None of the six installs its
  click through the anchor: the tree's clicks come from `renderTree` (`documents.ts:390`),
  the bracket is a `pointerdown` (`timeline.ts:635`), the card press arms a drag
  (`branch.ts:606`), the task card and the prerequisite row have their own listeners
  (`tasks.ts:367`, `asset.ts:1196`). Seven more sites publish a selection with no anchor
  at all: the skills tree (`editors/skills.ts:259`), the task graph's slot and cluster
  picks (`editors/graph.ts:472`, `:489`), the shot bracket, the branch card's press, the
  backlink rows (`editors/documents.ts:440`, `:457`, `:468`), a diagnostic row
  (`chrome/diagnostics.ts:116`, which publishes and closes) and the Play pane on every
  rebuild (`editors/play.ts:217`).
- **A click that publishes usually opens too.** The tree row publishes six fields and then
  routes through `openNode` (`documents.ts:400` → `panes/open.ts:19`), whose `where` is
  `here` when the claimant pane is visible and `elsewhere` otherwise (`panes/route.ts:79`,
  `routeFor`); the wiki and script asset strips and the tree's second click take the same
  route (`wiki.ts:169`, `script.ts:515`, `documents.ts:640`); the task card and the origin
  chip publish and then `exec('view.open', … where: 'elsewhere')` (`tasks.ts:405`,
  `asset.ts:424`); the approvals row closes the popup and opens with a `subject`,
  publishing nothing (`approvals.ts:120`). The research's point that a control records a
  list of effects, not one, is these sites.
- **The helpers those sites need are pure and sit under `pathux/`.** `selectionForNode`
  and `publishedBy` are in `doctree/doctree.ts:132` and `:188`, `taskPublishes` and
  `Selection` in `doctree/selection.ts:35` and `:13`, `rowTitle` in `doctree.ts:624`, and
  `routeFor` in `panes/route.ts`, which imports `shared/editors`, `doctree.ts` and one
  type from `panes.ts`. All run under node today. `guided-tours.md` names `doctree.ts` as
  the one file under `pathux/` the rules import.
- **Every `view.open` a surface issues today passes `elsewhere`, `here` or nothing.** No
  surface passes `left`, `right`, `above` or `below`, the values
  [`../guides/showEditorPaneGuide.md`](../guides/showEditorPaneGuide.md) forbids because
  they always split and never spare a conversation pane. `here` is the command's default
  (`src/main/commands/view.ts:71`), and the guide reserves `popup` for something the app
  decided to show. The header's Editors submenu omits `where` (`header.ts:808`); `popup`
  is used by main (`src/main/commands/pipeline.ts:70`, `report.ts:90`) and by `seedReport`
  (`renderer/pathux/agent/reportconvo.ts:112`). `view.focus` is never issued by a surface.
  So the sparing rule holds today and nothing checks it.
- **Context menus are data run through one path; the header's menus are path.ux
  object-form templates.** The document tree's menu is `menuFor`
  (`doctree/doctree.ts:341`), run through `showContextMenu` (`chrome/showmenu.ts:56`),
  which asks `command:check` for each entry that is not `form` or already `refused`
  (`chrome/contextmenu.ts:60`, `needsCheck`), prefixes a refusal with `⃠ ` (`:57`), and
  executes an entry with `exec`, `openCommandDialog` for `form`, or `say` for a refusal
  (`showmenu.ts:99`). Every row carries a tooltip: the refusal sentence, or the command's
  registry description (`contextmenu.ts:77`, `entriesWithVerdicts`), passed in the tooltip
  slot of a positional `MenuTemplateCustom` row (`showmenu.ts:79`), which `createMenu`
  normalises into the object form (`vendor/path.ux/scripts/menu/menu_ops.ts:130`). What
  the path does not do: it passes no hotkey label, it builds no submenu, and it marks a
  refused row with the `⃠ ` prefix and leaves it clickable rather than greying it through
  `setItemDisabled`, which path.ux's object form reaches through `disabled` and `validate`
  ([`menu-item-disabling.md`](../../vendor/path.ux/documentation/plans/menu-item-disabling.md),
  complete; the comment at `contextmenu.ts:69` saying the template has no per-item
  disabled state predates it). The shot menu (`editors/timeline.ts:649`), the line menu
  (`renderer/pathux/interactions/script.ts:98`) and the card menu
  (`interactions/branch.ts:207`) are `MenuEntry[]` on the same path and are not in the
  model. The header's four menus (`header.ts:478`, `:616`, `:668`, `:773`) and its Recent,
  Editors and Layout submenus (`:592`, `:802`, `:820`, nested through `submenu()`) are
  object-form `MenuTemplateEntry` rows (`{ name, callback, hotkey, tooltip, id }`,
  `vendor/path.ux/scripts/menu/menu_types.ts:26`), the form that carries `disabled`,
  `validate`, a tooltip and a right-aligned hotkey, drawn by `bar.menu(title, template)`
  (`header.ts:293`). Their callbacks are closures: `openPalette()`, `move('undo')`,
  `quit()`, `closeWindow()`, `ctx.screen.splitTool()`, `pickPaneToClose`, `seedReport()`,
  `withGenGraph(pane => pane.groupSelected())`, beside rows that `exec` or open a dialog,
  and the open project's Recent row is a no-op callback (`:598`). The model badge's menu
  (`header.ts:415`) is positional and its button is already recorded, the convo bar's
  pattern.
- **A mutating command that neither undoes nor confirms is reachable from a menu.** Of 94
  mutating commands, 17 declare no `confirm` and no `undoable: true` (13 declare neither
  flag; `project.setKey` and the three `plugin.*` declare `undoable: false`). On the
  tree's menu, `asset.accept` (`doctree.ts:314`) and `story.screenplay` (`:328`) run on
  the click; `agent.run`, `gate.approve` and `pipeline.run` (`:438`) open the command's
  form. On the app menu, Run Pipeline runs `pipeline.run` after a `check` (`header.ts:496`
  region), `workspace.pick` and `workspace.reindex` run on the click, `workspace.open`
  runs from Recent, and `workspace.create` opens a dialog. The rule the tasklist routes
  here fails on the click-run ones today, so it needs a list of exceptions with reasons,
  the palette-only pattern.
- **Shortcuts are bound in four scopes and labelled in three hand-kept ways.** The shell
  keymap (`renderer/pathux/app/keymap.ts:17`) builds eight `HotKey`s from a key and a
  modifier list (`HotKey(key, mods, action, uiname)`,
  `vendor/path.ux/scripts/path-controller/util/simple_events.ts:907`; there is no combo
  string parser, and `buildString()` renders one): palette, undo, redo twice (Ctrl+Shift+Z
  and Ctrl+Y at `:20`, `:21`), mode toggle, quit, `window.new`, close window. The Gen
  Graph pane installs path.ux's own table (`editors/nodes.ts:259` →
  `NodeGraphView.hotkeys()`,
  `vendor/path.ux/scripts/editors/nodeeditor/nodegraphview.ts:1133`: Delete, Shift+D,
  Ctrl+G, Ctrl+Alt+G, Tab). The Play pane binds five `HotKey`s (`editors/play.ts:84`).
  Main binds F12 and Ctrl+I to DevTools before the renderer sees them
  (`src/main/index.ts:1111`); there is no Electron menu (`:1160`). Another nineteen
  `keydown` handlers are widget-scoped: Ctrl+S in five text boxes, Enter and Escape in
  every inline editor, Alt+arrows on a chunk card. The labels: twelve `hotkey` strings on
  header menu rows (`header.ts:483` onward), rendered by path.ux beside the row and
  binding nothing; two parenthesised combos inside `GROUP_WHAT` and `UNGROUP_WHAT`
  (`rules/gengraph.ts:414`, `:417`), which `ux-model.json` pins; and prose in eleven field
  tooltips. Ctrl+Y is bound and labelled nowhere.
- **Two combos are bound twice, and neither is a conflict a keymap can see.** Ctrl+G,
  Ctrl+Alt+G and Tab are bound by the pane and named by the Edit menu, whose entries act
  on the active Gen Graph pane through `paneToUse` rather than the focused one. Ctrl+I is
  DevTools in main and italic in every text box, a widget-scoped collision a scope table
  cannot see. Enter and Backspace are bound by the Play pane and by every inline editor,
  which path.ux keeps apart by routing to the focused area and declining keys in a text
  box.
- **Keys are checked per module and per situation, and nowhere else.** `duplicateKeys`
  (`rules/anchors.ts:189`) runs in each module's test and in `model.test.ts:39` over one
  `controls()` result. The asset home's two modules are never checked against each other,
  passes of one home are never checked across parts, and `item:` keys are checked nowhere,
  since the function takes `Pick<Control, 'id' | 'on'>`; `situations.test.ts:90` pins that
  every key is a `cmd:` key.
- **The catalog carries two vocabularies and can carry a third.** `CommandCatalog` is
  `{ version, source, commands, interactions? }` (`packages/commands/src/catalog.ts:102`),
  with `interactions` projected from a separate `InteractionRegistry` whose `verify`
  refuses an interaction naming a command that does not exist
  (`packages/commands/src/interaction.ts:108`). `INTERACTION_ID` is the command-id regex
  (`:27`), so every id the research proposes already matches it, and nothing refuses an
  interaction id that equals a command id. An enum prop is `prop.oneOf`
  (`packages/commands/src/props.ts:93`), validated by `coerceProps` (`:171`); the package
  has no zod. `catalogOf` (`src/main/commands/catalog-entry.ts:18`) is the one projection,
  bundled for node by `scripts/lib/load-entry.mjs`. `checkTour`
  (`src/shared/tourcheck.ts:55`) validates a `gesture` step against the interactions and
  every other step against the commands, through `Known` (`:19`). The eight gestures are
  `createDesktopInteractions()` (`src/shared/interactions.ts:610`), exported as
  `desktopInteractions` from `src/main/commands/interaction.ts:20`.
- **Where an effect id would land today.** `precheck.ts:32`'s `checkFor` skips only
  `id === undefined`, so a `ui.publish` anchor would be asked of `command:check`
  (`tour.ts:172` asks about every ringed anchor). `anchorcoverage.test.ts:33` requires
  every record id to be a command and `:46` that `anchored` equal the distinct record ids.
  The sweep asks `stack.check` about every anchor with an id
  (`scripts/sweep-anchors.mjs:153`). `CommandStack.check` on an unknown id answers a
  refusal (`packages/commands/src/stack.ts:563`), which `entriesWithVerdicts` would draw
  as `⃠ `.
- **The model has room for effects and none for a shortcut named `key`.** A control record
  is `{ via, editor, module, situation, key, offer, reasonFrom? }`
  (`src/shared/uxmodel.ts:55`), strict; `key` is the anchor key. `Offer` is
  `Control & ({ ok: true; props } | { ok: false; refusal })` (`rules/anchors.ts:49`),
  `Control` is `{ id, label, tooltip, on?, supplies?, form? }`, `Offer.props` is
  `Record<string, PropValue>`, and `keyOf` gives `cmd:<id>` or `cmd:<id>#<on>`;
  `itemKey(kind, key)` gives `item:<kind>/<key>`. `pickOffer` (`rules/model.ts:121`) picks
  `Offer`'s declared keys. `anchorSnapshot(open)` keeps only anchors whose home is an open
  pane or `HEADER` (`tour/anchors.ts:196`), `Resolution`'s `pane-closed` carries an
  `EditorId` (`rules/anchors.ts:152`), and the sweep opens homes through `view.open`'s
  `editor` values (`sweep-anchors.mjs:63`). The notification, approvals and diagnostics
  popups are `Screen.popup`s (`notifications.ts:116`, `approvals.ts:63`,
  `diagnostics.ts:43`), never panes. Fixtures in `rules/tests/anchors.test.ts` (`:187`,
  `:310` onward) and `rules/tests/tour.test.ts` (`:132`, `:196`) build anchors with
  `publishes` literals; there is no `tour/tests/` directory.
- **Vocabulary the research did not anticipate.** Move Pane to New Window is `window.new`
  then `view.close` (`header.ts:751`), a menu row with two effects. Split Area is
  `ctx.screen.splitTool()` (`:631`) and Close Pane… is `pickPaneToClose` (`:619`), path.ux
  and app gestures in no interaction registry. The convo's plan and confirm cards answer
  the agent (`convo.ts:519`, `:558`). The pin toggle is `app/editor.ts:109`. The Gen Graph
  frame's click selects a node in path.ux and publishes nothing.

## Decisions this plan settles

- **The vocabulary is closed, registered beside the commands, and has no dead entry.**
  `@vn/commands` gains `Effect` and `EffectRegistry`, the interaction pattern: an id
  matching `COMMAND_ID`, a title, a description and a `PropSpecMap` with `prop.oneOf` for
  the closed values, projected by `toEffectCatalog` into `CommandCatalog.effects?`.
  `EffectRegistry.verify(commands, interactions)` refuses an effect id that is also a
  command id and an `interaction` value that names no gesture. The desktop declares
  `desktopEffects` in `src/shared/effects.ts` (no DOM, so `load-entry.mjs` bundles it),
  and `catalogOf` verifies and projects it. An effect has no `run`, no `check` and no
  provenance: it names what a renderer-local handler does, and the handler stays a closure
  beside the record. The list:

    | Effect           | Props                      | What it names                                                                          |
    | ---------------- | -------------------------- | -------------------------------------------------------------------------------------- |
    | `ui.publish`     | the `ui.*` fields it sets  | A click that selects a subject. Item anchors become this.                              |
    | `tree.expand`    | `node`                     | Expanding or collapsing a tree node, or every node at once.                            |
    | `menu.open`      | `menu`                     | Opening a menu, from a closed list of menu names.                                      |
    | `popup.open`     | `popup`                    | Opening the palette, the picker, a chrome popup, the report preview, or an inline box. |
    | `popup.close`    | `popup`                    | A Cancel or Close button on a popup or an inline box.                                  |
    | `pane.view`      | `what`                     | Changing what a pane shows: reload, fit, tidy, filter, scope, mode, page, step, mark.  |
    | `pane.scroll`    | `to`                       | Bringing something on the pane into view.                                              |
    | `pane.pin`       | `pinned`                   | The pin toggle in a pane's bar.                                                        |
    | `screen.arrange` | `what: 'split' \| 'close'` | The View menu's Split Area and Close Pane… gestures.                                   |
    | `drag.start`     | `interaction`              | Arming a gesture, by its id in the interaction registry.                               |
    | `history.move`   | `to: 'undo' \| 'redo'`     | The header's arrows, the Edit menu's rows and the shell's keys.                        |
    | `agent.answer`   | `to`, `answer`             | Approving or rejecting a plan, allowing or denying a confirm, replying to a question.  |

    `pane.focus` and `drag.accept` are not in it. Nothing focuses a pane, and a drop
    target is not a control: the interaction's `targets` already describes what a carried
    subject may land on, in the catalog. `key.bind` is not an effect either; see below. A
    dialog is not `popup.open` with a command: a row that opens a command's form is that
    command with `form: true`, the tree's pattern (`doctree.ts:438`), so the menu rule and
    the coverage test see the command. A value nothing uses is removed with the same test
    that keeps the palette-only list honest.

- **Effects are built through typed helpers.** `Offer.props` is an untyped record, so a
  closed value is enforced by construction: `rules/effects.ts` exports one function per
  effect (`publish(fields)`, `expand(node)`, `openMenu(menu: MenuName)`,
  `openPopup(popup: PopupName)`, `paneView(what: ViewWhat)`, `dragStart(interaction)`, and
  so on) returning an `Action`, with the value types exported from
  `src/shared/effects.ts`. A typo is a compile error there and a parse error in the
  driver's test.
- **An effect is an `Offer`, and a control's effects are a list.** `Action.id` may be a
  command id or an effect id; the `ok` branch of `Offer` gains `then?: readonly Action[]`
  for what follows the first. A tree row is
  `{ id: 'ui.publish', props: { sceneId }, then: [{ id: 'view.open', props: route }] }`.
  `act(node, offer, run)` and `record(node, offer)` record it unchanged, `applyOffer`
  presents it unchanged, and the click stays the closure. The record's `effects` is
  `[{ id, props }, ...then]` for an accepted offer and `[{ id }]` for a refused one,
  written by the driver. The design rule is met as far as it can be for a closure: the
  declaration and the handler are one object at one site, which is what `act()` enforced
  for commands; whether the closure does what it declares is the executed tier's question
  (plan 8). CLAUDE.md's "every desktop action is a registered command" gains a sentence:
  an effect is a registered name for what a surface does locally, and the palette and CDP
  cannot run one; the follow-up that makes undo, redo, quit and close-window commands is
  where that tension is settled.
- **Keys tell the three kinds apart.** `keyOf` gives `cmd:<id>[#<on>]` for a command,
  `item:<on>` for `ui.publish`, whose `on` is `<kind>/<key>` and is required, and
  `fx:<id>[#<on>]` for any other effect. Every existing `item:` key, tour step,
  `resolveItem` and `resolveSubject` is unchanged; `resolveSubject` reads `props` from
  anchors whose id is `ui.publish` and nothing else, so a command whose props carry a
  `subject` is not mistaken for a row that selects one. `checkFor` and the sweep skip
  `command:check` for an effect id. `duplicateKeys` sees all three prefixes.
- **An item anchor is a `ui.publish` offer from a module, recorded, not acted.** `item()`
  and `pickItem()` are deleted; `pick(nodeId, box, offer)` is added for canvas anchors and
  `record()` serves the DOM ones, since none of the six sites installs its click through
  the anchor. The offers come from the modules, whose state gains the rows:
  `documents.rowAction(node, selection, visible)` (publish, then the route from
  `routeFor`), `tasklist.cardAction(task, selection)`,
  `taskGraph.nodeAction(task, selection)`, `branch.cardAction(node, held)`,
  `assetview.prereqAction(p)`. The Gen Graph frame's anchor is deleted: it published
  nothing and selected a node inside path.ux, which is not a subject. The tree row's
  tooltip is `rowTitle`'s sentence, so `rowTitle` moves into `rules/documents.ts` and the
  offer carries it; `applyOffer` then writes what `look.title` wrote. The seven unanchored
  publishers get the same treatment in their stages. The Play pane's rebuild-time publish
  is not a control and is left as it is.
- **The selection and route helpers move into `rules/`.** `selectionForNode`,
  `publishedBy`, `Selection`, `taskPublishes` go to `rules/selection.ts` and `routeFor` to
  `rules/route.ts`, with `doctree.ts` and `panes/route.ts` importing them back. The
  modules then import nothing new from under `pathux/`, and `guided-tours.md`'s sentence
  about `doctree.ts` being the one crossing stays true. The route needs a
  `visible: EditorId[]` in the state of `documents`, `wiki` and `script`, and two
  situations each (claimant visible, claimant absent), so both of `routeFor`'s answers are
  in the model.
- **A command run without an offer gets one; the header's menus become data drawn as they
  are drawn today.** The Threads rows, Delete and Duplicate (offers from
  `rules/gengraph.ts` over `weighed.delete` and `weighed.duplicate`, the Group button's
  pattern, so the id is the one the edit resolves to), the approvals rows, and the seven
  interaction-built widgets (recorded into a pass of their own on every change, the rename
  box's pattern, from `timeline.variantAction`, `castAction`, `requireCastAction`,
  `outfitAction`, `removeCastAction`, `script.speakerAction`, `branch.labelAction`).
  `rules/headermenus.ts` exports one function per menu over a `HeaderMenuState` returning
  `MenuEntry[]`, where `MenuEntry` gains `tooltip?`, `shortcut?`, `then?` (Move Pane to
  New Window) and `submenu?: MenuEntry[]` (Recent, Editors, Layout); a row that runs a
  closure carries an effect id (`popup.open` for the palette, `history.move`,
  `pane.view: mode`, `screen.arrange`, `view.open` with `where: 'popup'` for Report a
  Difficult Agent…), the open project's Recent row is `refused`, and a row that runs a
  command carries its id, with `form: true` where it opened a dialog. One builder serves
  both: `showmenu.ts` splits into `menuTemplate(entries, verdicts, says, handlers)`,
  returning object-form rows with `tooltip`, `hotkey` from the shortcut table, `disabled`
  with the refusal on a refused row, and a nested `Menu` per submenu, and a
  `showContextMenu` that starts it at a point; the header passes the same template to
  `bar.menu` and supplies the handler table keyed by effect id, deleting its templates.
  `needsCheck` skips an effect id and `entriesWithVerdicts` reads an effect's tooltip from
  the effect catalog. A refused context-menu row is then greyed with its sentence composed
  above the tooltip, and the `⃠ ` prefix goes. The shot, line and card menus join the
  driver's menu row with a situation each, and the header's under `when: header/<menu>`
  with a submenu row under `header/<menu>/<submenu>`.
- **The three chrome popups are homes, present like the header.** `notifications`,
  `approvals` and `diagnostics` join `ANCHOR_HOMES`. Each gets a rule module with
  `controls(state)` (`rules/notifications.ts` over a `NotificationsState`, and a row
  function each for the other two) and draws through `act()` under a pass that is replaced
  on render and cleared on close. `anchorSnapshot` keeps a popup home's anchors as it
  keeps the header's, since a closed popup has no live pass; `Resolution` gains
  `popup-closed`, naming the header control that opens it, and the tour rings that control
  (the bell, the badge, the errors button) instead of saying "open the pane". The sweep
  opens each popup through its header anchor's node, dumps, and closes it, so the three
  enter `anchors.json`.
- **A shortcut is a property, not an effect, and the table is data.** `rules/shortcuts.ts`
  exports `SHORTCUTS: readonly { scope; key; mods; runs; shadows? }[]`, where `scope` is
  `global`, an editor id, or `main`, and `runs` is an `Action`. The shell keymap and the
  Play pane build their `HotKey`s from the table through a handler map, and a test asserts
  every table entry has a handler and every handler an entry. The Gen Graph pane's five
  come from path.ux and are listed with `from: 'pathux'`; the sweep compares that scope
  against the live `view.hotkeys()` (advisory), since the vendor table is not loadable
  under node. Main's two DevTools keys are listed under `main` so the table is complete.
  Widget-scoped keys are not shortcuts and are not listed: they are the box's own
  behaviour, and plan 2's rule already puts `Enter writes it` in the tooltip. The model
  gains a `shortcuts` section written from the table, and a control record gains
  `shortcut` when its first effect's id (and `on`, when the entry names one) equals an
  entry's `runs`. `shortcutOf(runs)` formats an entry the way the header's strings read
  today, and the twelve `hotkey` strings, the two combos in `GROUP_WHAT` and
  `UNGROUP_WHAT`, and the palette's tooltip read it. `key.bind` was the research's name
  for this; the tasklist asked whether it is an effect or a property, and it is a
  property.
- **`pane.view` names what a pane shows, not what the project holds.** Refresh, Fit, Tidy,
  the three task filters, `Clear finished`, `← Overview`, the Files/Documents toggle, the
  report's setup toggles, the Play pane's advance, back, save, load and reset, and
  `Show N more` change the pane and nothing else. They are one effect with a closed
  `what`, because a reader asking "what can I do here" needs them named and a linter needs
  nothing more. Nine values cover the thirty-three sites; a tenth is added with the site
  that needs it.
- **The `other` handlers that are not controls stay closures.** A draft-holding `input`
  handler, a `stopPropagation` swallow, a dismiss latch, a `blur` that commits: none is a
  control the author aims at, none gets a record. The Cancel buttons and the inline-box
  openers are controls, and they are `popup.close` and `popup.open` with `popup: 'box'`.
- **Four rules land, each with the stage that makes it checkable.**
    - _A surface opens an editor only through the sparing rule_ (stage 7). Over every
      `view.open` in the model, whether a command offer, a menu entry or an entry in a
      `then` list: `where` is `elsewhere`; or `here` where the record is a `headermenus`
      Editors row, or where the value came from `routeFor` (the route situations); or
      `popup` where the record is the header's Report a Difficult Agent… row; and never a
      split direction. It passes today and is a tripwire against the next surface that
      picks a pane of its own, which is what CLAUDE.md forbids.
    - _A mutating command reachable from a menu is undoable or confirms_ (stage 4). Over
      every `menu` record without `form`: the command is not mutating, or is undoable, or
      confirms, or is matched by `rules/menuexempt.ts` with a reason. The list's first
      contents: `asset.accept` (reversed by `asset.unapprove`, which confirms),
      `story.screenplay` (writes the file the author asked for by name), `pipeline.run`
      from the app menu (asks `command:check` first and opens the task list),
      `workspace.open`, `workspace.pick` and `workspace.reindex` (workspace-level; nothing
      in the project changes). A dead exemption fails the test.
    - _A keyboard shortcut is bound once_ (stage 6). In one scope no `(key, mods)` appears
      twice; the same combo in `global` and in an editor scope is allowed only with
      `shadows: true` on the editor's entry, since the pane wins while focused and the
      shell otherwise. Two combos for one `runs` (Ctrl+Y and Ctrl+Shift+Z) are allowed.
    - _Two controls in one pane share a key only with a discriminator_ (stage 2). Across
      the modules of one home, over every situation, no key is produced by two modules;
      within a situation `duplicateKeys` covers `item:` and `fx:` keys. The rule as the
      research states it is what `keyOf` already does for one module; this is the check
      across the seams the model can see.
- **Effect ids are not commands, and the tests say so.** `anchorcoverage.test.ts` compares
  command ids against the command registry and effect ids against the effect registry;
  `anchored` stays the distinct command ids and a new `effects` list holds the distinct
  effect ids; `uxmodel.test.ts` does the same for the derived file, and an id in neither
  registry fails. `checkTour` is unchanged: a tour step names a command or a gesture, and
  a `select` step already covers `ui.publish` by item key.
- **The palette-only list is edited by every stage that anchors something.** A glob whose
  namespace stops being wholly palette-only is exploded into ids with reasons: `notify.*`
  and `window.*` at stage 3, `workspace.*` and the `view.*`, `app.*`, `agent.*`,
  `upload.pick`, `pipeline.approveAndRun` and `project.installPages` rows at stage 4,
  `gengraph.removeNode`, `gengraph.duplicateNode`, `story.setSpeaker` and the five
  timeline `story.*` at stage 5. The test that fails on an entry matching an anchored
  command is what forces each edit.
- **What stays out.** Making undo, redo, quit and close-window commands. `drag.accept` as
  a control. The Gen Graph designer's socket rows, which are path.ux widgets. The executed
  check that a closure does what its effects say (plan 8).

## What changes

Eight stages, one green commit each, on a branch `effects`. Every stage leaves
`pnpm check`, `pnpm test` and `pnpm lint` green, and every stage that touches
`renderer/rules/**` regenerates `ux-model.json` and edits the palette-only list as the
test demands.

### Stage 1 — the vocabulary, the offer, and the schema (done)

- `packages/commands/src/effect.ts`: `Effect`, `EffectRegistry` (`define`, `get`, `list`,
  `verify`), `toEffectCatalog`; `CommandCatalog.effects?`; `toCatalog` gains a fourth
  argument. Tests beside the interaction tests; `commands.test.ts` in
  `src/main/commands/tests/` pins the effect ids the way it pins the gestures.
- `apps/desktop/src/shared/effects.ts`: `desktopEffects`, twelve entries, with the
  `MENUS`, `POPUPS` and `VIEWS` value lists exported; `renderer/rules/effects.ts`, the
  typed helpers.
- `renderer/rules/anchors.ts`: `Action.id` documented as a command or effect id; `then?`
  on the `ok` branch; `keyOf` with the three prefixes; `duplicateKeys` over all three.
  `pickOffer` picks `then`. `precheck.ts`'s `checkFor` skips effect ids, and
  `precheck.test.ts` follows.
- `src/shared/uxmodel.ts`: `effects` on a control record, `then` on an accepted offer,
  `shortcut?` on a control record, a `shortcuts` section and a `menuExempt` section, both
  allowed empty until stages 4 and 6 fill them; `tooltip?`, `shortcut?`, `then?` and a
  submenu path in `when` on a menu record. `model.ts` writes `effects`. Regenerate; the
  file changes by one field per record.
- `model.test.ts` and `uxmodel.test.ts`: every effect id in the file exists in
  `desktopEffects`, its props coerce under the effect's `PropSpecMap`, and an id in
  neither registry fails.

### Stage 2 — item anchors become `ui.publish` (done)

- `rules/selection.ts` and `rules/route.ts`, moved from `doctree/` and `panes/`, with
  their tests; `rowTitle` into `rules/documents.ts`.
- `tour/anchors.ts`: `item()` and `pickItem()` deleted; `pick(nodeId, box, offer)` added;
  `resolveSubject` reads `props` from `ui.publish` anchors. The fixtures in
  `rules/tests/anchors.test.ts` and `rules/tests/tour.test.ts` become offers.
  `situations.test.ts` accepts the three prefixes.
- Module functions and situations: `documents.rowAction` with the two route situations,
  `tasklist.cardAction`, `taskGraph.nodeAction`, `branch.cardAction`,
  `assetview.prereqAction`; the Gen Graph frame's anchor deleted.
- `anchorcoverage.test.ts` and the sweep learn the `effects` list. The cross-module key
  test in `model.test.ts`.

### Stage 3 — the three popup homes (done)

- `ANCHOR_HOMES` gains the three; `anchorSnapshot`, `Resolution`, the tour's overlay and
  `resolveAnchor` learn `popup-closed`; the sweep opens each popup through its header
  anchor.
- `rules/notifications.ts` with `controls(state)` for the five `notify.*` controls, the
  page row and the filter opener; `chrome/notifications.ts` draws through `act()`; the
  approvals row (close, then `view.open` with a subject) and the diagnostic row (publish,
  then close) get a module row each.
- The palette-only list loses `notify.*`.

### Stage 4 — menus as data, and the menu rule (done)

- `MenuEntry` gains its four fields; `rules/headermenus.ts`; `showmenu.ts` splits into
  `menuTemplate` and `showContextMenu`, building object-form rows; `header.ts` supplies
  the handler table and deletes its templates; `needsCheck` and the tooltip lookup learn
  effect ids; the `⃠ ` prefix and the stale comment in `contextmenu.ts` go.
- The shot, line and card menus join the driver's menu row with a situation each; the
  header's menus join it under `header/<menu>` and `header/<menu>/<submenu>`.
- `rules/menuexempt.ts` and the rule test in `uxmodel.test.ts`; the palette-only edits the
  header's rows force.
- A CDP check that every header menu, submenu and hotkey label draws as before, and that a
  refused Recent row and a refused tree row are greyed with the sentence on hover.

### Stage 5 — the widgets, the Threads rows, Delete and Duplicate

- The seven interaction-built widgets recorded in passes of their own; the Threads rows as
  a menu the convo module returns; Delete and Duplicate from `rules/gengraph.ts` over the
  weighed edits. The palette-only edits they force.

### Stage 6 — shortcuts

- `rules/shortcuts.ts`; `app/keymap.ts` and `editors/play.ts` build from it; `shortcutOf`;
  the header's `hotkey` strings, the two `GROUP_WHAT` combos and the palette's tooltip
  read it. The `shortcuts` section and `shortcut` on records.
- The rule test; the sweep's `gengraph` scope comparison.

### Stage 7 — the effect closures, one editor per commit

Every remaining handler in the `menu.open`, `popup.open`, `popup.close`, `tree.expand`,
`pane.view`, `pane.scroll`, `pane.pin`, `screen.arrange`, `drag.start` and `agent.answer`
classes becomes `act(node, offer, run)` with the offer from its module, one editor or
chrome file per commit, each commit also extending that module's situations and
regenerating the model: `documents`, `tasks`, `graph`, `nodes`, `asset`, `script`,
`timeline`, `branch`, `convo`, `report`, `wiki` and `skills` (a reload and a strip each,
plus the route situations for the strips), `project`, `play`, `systemprompt` (Copy becomes
`app.copy`), `inspector`, `header` (the four menu buttons, the arrows, the three popup
buttons), `app/editor.ts` (the pin). The sparing rule test lands with the last of the
route situations.

### Stage 8 — the sweep, and the docs

- `scripts/sweep-anchors.mjs`: the popup homes, the `effects` list, the shortcut scope
  comparison; `anchors.json` re-swept.
- `docs/reference/guided-tours.md`: Part I's Offers section covers effects, `then` and the
  three key prefixes; the item-anchor paragraphs are rewritten; the popup homes and
  `popup-closed`; Part III gains the four rules, the `shortcuts` and `menuExempt`
  sections; the Files table gains the new modules. `docs/reference/command-system.md`
  gains a short section on effects beside the one on interactions. `CLAUDE.md`'s Tooltips
  section says "every control", the command-system bullet gains the sentence on effects,
  and the desktop paragraph names them. The tasklist: row 4 ticked and its "three rules"
  corrected to four, the four rules ticked, "What the numbers are today" restated (five
  `notify.*` controls, not four), `key.bind` answered. The research report's `pane.focus`
  and `drag.accept` rows get a note pointing here.
- `docs/plans/index.md` flips the row and the file moves to `archive/`.

## Testing

- **Stage 1**: `effect.test.ts` in `@vn/commands`, including the refusal of an id that is
  a command; the catalog test pins twelve ids; `model.test.ts` fails on a made-up effect
  id and on a `menu` value outside the list; `precheck.test.ts` on an effect id.
- **Stage 2**: each module's test covers its new function; `resolveSubject` ignores a
  command whose props carry `subject`; the cross-module key test passes on the committed
  file and fails when a test doubles a key.
- **Stage 3**: `notifications.test.ts`; a tour step on `notify.clear` resolves
  `popup-closed` naming the bell with the popup shut and rings the row with it open, over
  CDP.
- **Stage 4**: `headermenus.test.ts`; the exemption test fails on a dead entry and on a
  mutating click-entry with no exemption; the CDP check above.
- **Stage 5**: the module tests for the seven widgets; a CDP check that changing a
  variant, a cast row and the cue picker still runs the command and the pass re-records.
- **Stage 6**: the shortcut test; a CDP check that Ctrl+Shift+P, Ctrl+Z, Ctrl+Y, Shift+Tab
  and the Play pane's keys still fire; the Edit menu shows `Ctrl+G` beside Create Group;
  `GROUP_WHAT` still ends in `(Ctrl+G)`.
- **Stage 7**: the sparing test; each editor's situations cover its new offers; a CDP pass
  over each editor that a Refresh, a Fit, a twisty, a filter and a drag still work (the
  sweep's hit test covers the rest).
- **Stage 8**: sweep re-run: 0 strays, 0 disagreements, the three popups swept, the
  `effects` list, and the shortcut scope agreeing with the live pane.
- **Throughout**: `pnpm check`, `pnpm test`, `pnpm lint`, `pnpm gen:uxmodel`,
  `pnpm exec commentlint` on every touched file.

## Risks

- **The size.** About 130 handlers change hands across seventeen files. Stage 7 is the
  bulk and is one editor per commit, so a partial stage 7 is still green and still
  reviewable. Stages 1 to 3 alone give the vocabulary, the item anchors in the model and
  the notification popup.
- **A closure's record can lie.** An effect offer says `pane.view: reload` and the closure
  could do anything. The layer cannot check it; the sweep's hit test proves the control is
  there and the executed tier (plan 8) is where behaviour is checked. The co-location is
  the guarantee, as it was for commands before the sweep existed.
- **Two menus for one thing.** The header's Edit menu group entries and the Gen Graph
  bar's Group button both exist. The model lists both, and the shortcut table names the
  pane's binding once; the menu entry's `shortcut` displays that binding.
- **The header's handler table.** The closures that were in the templates move one file
  and are keyed by effect id. A missing handler is a runtime `say`, and the test that
  pairs entries with handlers catches it first.
- **The route has two values in the model.** `routeFor` returns `here` or `elsewhere`
  depending on which panes are visible; two situations record both, and the rule accepts
  both. The model therefore shows that a tree click can replace the pane it is in.
- **The popups' anchors are live only while the popup is up.** A tour step on a popup
  control rings the opener until the popup is open, then the control. The sweep has to
  open each popup, which is three more clicks in the script and nothing else.
- **Undoing the plan** deletes the effect registry, the three popup modules,
  `headermenus.ts`, `menuTemplate`, `shortcuts.ts`, `menuexempt.ts`, `effects.ts` twice
  and the schema fields; restores `item()`, `pickItem()`, the templates, the hand-kept
  labels and the moved helpers. Nothing outside the desktop app and `@vn/commands`
  changes.

## Follow-ups deliberately not in scope

- **Undo, redo, quit and close-window as commands**, which would delete `history.move` and
  give the palette four entries, and would settle the sentence CLAUDE.md gains here.
- **Moving path.ux's node-editor hotkey table to a pure module**, so the `gengraph` scope
  is derived rather than copied.
- **`drag.accept` and the drop targets in the model**, once plan 7's recipes can drive a
  gesture.
- **The executed check** that a control's effects match what its closure does (plan 8).
- **The Play pane's rebuild-time publish**, which is state rather than a control.

## Findings

From the fresh-context review, before any work started. Each is fixed in the text above or
answered here.

1.  **Rewriting the header's menus through `showContextMenu` as it stands would have lost
    hotkey labels, submenus and greying**, since the context-menu path passes no hotkey,
    nests nothing and marks a refusal with a prefix. The first draft of this fix also
    claimed the path lost tooltips; it does not, since every row's tooltip is the refusal
    sentence or the registry description, and the positional row is normalised into the
    object form inside `createMenu`. Fixed: one template builder serves the header and the
    context menus, with object-form rows, `hotkey`, `disabled` and nested menus;
    `MenuEntry` gains `tooltip`, `shortcut`, `then` and `submenu`; the Context bullet
    states what each path does.
2.  **`popup.open` for a dialog would have hidden six commands from the menu rule and the
    coverage test.** Fixed: a dialog row is the command with `form: true`; the `command?`
    prop is gone.
3.  **Three popup homes would have been dropped by `anchorSnapshot`, refused by
    `view.open`, and never swept.** Fixed: popups are present like the header, with a
    `popup-closed` resolution naming the opener, and the sweep opens each through its
    header anchor.
4.  **The palette-only list goes red at three stages and the plan never edited it.**
    Fixed: a decision names which globs explode at which stage.
5.  **`command:check` on an effect id would draw a menu row refused.** Fixed: `needsCheck`
    and the tooltip lookup learn effect ids.
6.  **`resolveSubject` reading `props` from every anchor, and `checkFor` asking about
    `ui.publish`.** Fixed: both guard on the id; `precheck.test.ts` follows.
7.  **`act()` was the wrong call for the item sites, whose clicks come from elsewhere; the
    row tooltip's source was undecided.** Fixed: `record()` and `pick()`; `rowTitle` moves
    into the module.
8.  **The wiki and script strips route through `routeFor` like the tree, and the selection
    helpers are under `pathux/`.** Fixed: the helpers move into `rules/`; the strips get
    the two route situations.
9.  **Vocabulary gaps**: Move Pane to New Window has two effects, Split Area and Close
    Pane… are gestures in no registry, Report a Difficult Agent… ends in a `popup` open,
    the model badge's menu is positional, the Recent no-op row, Delete and Duplicate
    resolve their id at edit time, the Gen Graph frame publishes nothing. Fixed:
    `MenuEntry.then`, `screen.arrange`, a `view.open` row with `where: 'popup'` that the
    sparing rule names, the badge left as the convo bar's pattern, a `refused` Recent row,
    weighed edits for Delete and Duplicate, the frame's anchor deleted.
10. **The "thirty commands with no offer" list was wrong in several rows and line
    numbers.** Fixed: the `record()`-plus-click sites are named as plan 2's pattern and
    left alone; the lines are corrected; the approvals and diagnostics rows are described
    as they are.
11. **`pipeline.run` on the tree is `form`, and the 17 includes four `undoable: false`.**
    Fixed in Context and in the exemption list.
12. **`@vn/commands` has no zod, and `Offer.props` is untyped, so "a type error" was
    false.** Fixed: `prop.oneOf` for the values and typed helpers in `rules/effects.ts`;
    `src/shared/effects.ts` is required to bundle for node.
13. **Effect ids share the command namespace and `keyOf` would prefix them `cmd:`.**
    Fixed: `verify` refuses a collision; `fx:` and `item:` prefixes; `on` required on
    `ui.publish`.
14. **Combos are structured, Ctrl+Y is bound, and the Ctrl+I collision is widget-scoped.**
    Fixed: the table holds `key` and `mods`; the claims are corrected; the rule's blind
    spot is stated.
15. **Tests the plan missed**: `situations.test.ts`'s `cmd:` pin,
    `anchorcoverage.test.ts`'s two checks, the `publishes` fixtures in two rules tests,
    and a `tour/tests/` directory that does not exist. Fixed in stages 1 and 2.
16. **The sparing check as written could not fail.** Fixed: the rule now says which
    records may carry `here` and `popup`, and calls itself a tripwire.
17. **Undecided record shapes**: effects on a refused offer, `shortcut` matched by deep
    equality, a `runs` field duplicating `form`. Fixed: `[{ id }]`, match by id and `on`,
    `form` alone.
18. **Doc contradictions**: four `notify.*` controls in the tasklist (five), "three rules"
    in row 4 (four), CLAUDE.md's "every action is a command", `GROUP_WHAT` pinned by the
    model rather than by tests. Fixed in stage 8 and in the decisions.
19. **Stage 3 was the oversized commit.** Fixed: it is now stages 3, 4 and 5.

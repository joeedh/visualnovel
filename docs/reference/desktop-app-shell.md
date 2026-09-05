# The desktop app shell

<!-- toc -->

- [path.ux renderer rules](#pathux-renderer-rules)
- [Running it](#running-it)
- [Renderer layout](#renderer-layout)
- [The shell](#the-shell)
    - [Surfaces, shadow roots and stylesheets](#surfaces-shadow-roots-and-stylesheets)
- [Layout templates](#layout-templates)
- [The shared graph canvas](#the-shared-graph-canvas)

<!-- tocstop -->

This page is part of [`desktop-app.md`](desktop-app.md). It covers the renderer's own
rules, how to run and build the app, the renderer's file layout, the path.ux shell
(window, header, menus, selection, keyboard, the palette), layout templates, and the graph
canvas the two graph editors share.

## path.ux renderer rules

The renderer is a path.ux screen mesh. Panes subdivide the window, and each pane shows one
editor. There is no React and no room vocabulary. path.ux is a git submodule at
`vendor/path.ux`, so a fresh clone needs `git submodule update --init --recursive`
(`pnpm check:setup` reports this by name). Seven rules cause the most mistakes:

- The sixteen editors are named in one place (`apps/desktop/src/shared/editors.ts`), and
  `registerEditor(cls, 'vn.Name')` is the only way to register one, because a hand-written
  name string breaks under minification. That list also holds each editor's `claims`
  predicate (ranked in `renderer/pathux/panes/route.ts`) and a `pins` field for the one
  selection an editor can be pinned to. `pins` is declared once, and `registerEditor`
  splices in the struct fields that persist it.
- `offered: false` makes an editor registered but not listed. `view.open`, the palette,
  and saved layouts can still reach it, but it is absent from the two menus an author uses
  to browse editors. `OFFERED_EDITOR_IDS` narrows View ▸ Editors. path.ux's
  `setAreaMenuFilter`, installed once by the shell, keeps unoffered editors out of the
  pane header's own dropdown, which path.ux builds from its own registry rather than from
  this application's. This flag is deliberately not `AreaFlags.HIDDEN`: "hidden" describes
  the editor itself, while "not listed" describes this application's menus. Three editors
  carry the flag. Setup will stop being a pane once a preferences window exists to hold
  it, System Prompt exists for inspecting a misbehaving turn rather than for day-to-day
  work, and Debug Agent is somewhere Help sends the author rather than somewhere they
  arrange a window to keep.
- `src/shared/` is in the browser bundle, so everything it imports must be node-free. Only
  `vite build` catches a violation; neither `tsgo` pass does.
- Raw DOM surfaces go in the shadow root via `VnEditor.appendSurface`, each with its own
  sheet via `adoptStyle`. The import order in `styles/index.css` determines the cascade
  order, and `tokens.css` defines the design tokens (no new accent hues).
- "Pure" (side-effect-free) logic goes in `.ts` files with a `tests/` sibling, and the
  editor holds only rendering code. The jest desktop project is node-only, so surfaces are
  verified live over CDP.
- A mid-gesture verdict must match the verdict that would apply on commit. Layout changes
  on commit. An editor with an open text row stops its own keydown events.
- `renderer/pathux/app/api.ts` is rooted on `ShellState` and defines nothing for
  documents. One editor overrides it. Gen Graph roots a second `DataAPI` on the graph it
  has open, calling `ctx.override({api})` per instance, so path.ux builds the node rows. A
  bound write is still judged and sent as a command, so `@vn/commands` remains the write
  path.

## Running it

```sh
pnpm build:desktop && pnpm vndesktop --mock     # runs for real by default; --mock skips model calls
pnpm --filter @vn/desktop dev -- --mock         # live dev loop
```

`--project <dir>` overrides the workspace (`VN_PROJECT=<dir>` is an equivalent env
fallback).

- **Packaging is a separate command.** `pnpm package` builds an installer and `pnpm smoke`
  runs the packaged binary to prove the two lazily-imported SDKs, the plugin bundler's own
  binary and the debug agent's source snapshot all reached the app image. The release
  workflow runs `pnpm smoke` before uploading anything.
  [`../guides/toolchain.md`](../guides/toolchain.md#packaging-the-desktop-app) and
  [`../plans/archive/INDEX.md#packaging-the-desktop-app`](../plans/archive/INDEX.md#packaging-the-desktop-app)
  explain why packaging is built this way.
- **`pnpm vndesktop` opens CDP on 9222**, as the dev loop does. `scripts/vndesktop.mjs`
  sets `VN_CDP_PORT` before launching Electron, because the switch can only be appended
  before `app.whenReady()`, and this is the entry point to use when driving the app from
  `scripts/vn-cdp.mjs`. It announces the port on stdout; `VN_CDP_PORT=<n>` picks another
  port and `VN_CDP_PORT=` (empty) opts out. `pnpm --filter @vn/desktop start` still starts
  the same built app with no port, as does a packaged build — see
  [`command-system.md`](command-system.md#from-devtools-or-cdp).
- **There is no stock menu.** `Menu.setApplicationMenu(null)` runs at `app.whenReady()`,
  because the File/Edit/View scaffolding names features this app does not have and the
  shell draws its own bar. Removing the menu also removed its accelerators, and two of
  those are restored. F12 opens DevTools, which main catches on `before-input-event`
  because the renderer cannot open DevTools itself. Ctrl+Q quits, and it appears in the
  shell keymap and in the VN STUDIO menu. Quitting runs `window.close()`, so the wiki
  pane's unsaved-draft guard still runs. Main answers that guard's `will-prevent-unload`
  with a modal, and `before-quit` holds the app open for the session store's last
  debounced write, bounded at two seconds so a flush that never settles cannot block the
  quit.
- **Live dev loop:** `pnpm --filter @vn/desktop dev` (`scripts/dev.desktop.mjs`) runs
  three processes together: esbuild `--watch` (main + preload), the Vite renderer server
  with HMR, and Electron launched against that server once it is up
  (`VITE_DEV_SERVER_URL`, which `src/main/index.ts` loads instead of the built file).
  Quitting the window (or Ctrl-C) shuts the whole process tree down. `VN_DEV_PORT`
  overrides the renderer port (default 5176); args after the script's own (for example
  `--mock`, `--project <dir>`) are forwarded to Electron, and `VN_MOCK`/`VN_PROJECT` still
  pass through as env fallbacks. Main-process edits need a restart; the renderer
  hot-reloads without one. The dev loop defaults `VN_CDP_PORT=9222` for the same reason
  `pnpm vndesktop` does — see
  [`command-system.md`](command-system.md#from-devtools-or-cdp).
- **path.ux is a git submodule** at `vendor/path.ux` and carries a nested submodule of its
  own, so a fresh clone needs `git submodule update --init --recursive`. The clone then
  needs `pnpm --dir vendor/path.ux install`, because path.ux keeps its own lockfile and is
  not a pnpm workspace member, so the root install does not reach it. `pnpm check:setup`
  (scripts/check-submodules.mjs, also the first step of `@vn/desktop`'s `build`) fails and
  names whichever of the two steps is missing, instead of leaving the failure to the
  resolver.
    - **nstructjs is a git submodule too.** It lives at `vendor/nstructjs` and is consumed
      from the build output it commits, so it needs no install of its own. `@vn/desktop`
      depends on it as `link:../../vendor/nstructjs`. The vite alias and the `nstructjs`
      entries in `renderer/tsconfig.json` and `pathux-types.tsconfig.json` point there as
      well. path.ux imports nstructjs, and the path.ux install puts the published package
      in `vendor/path.ux/node_modules`, so those three redirect that import to the
      submodule.
    - Vite compiles path.ux's TypeScript source through an alias (there is no prebuilt
      bundle to keep in sync), while `tsgo` checks our code against declarations
      regenerated from that same source on every `check` (`build:pathux-types` →
      `apps/desktop/dist/pathux-types`, gitignored).
    - `vendor/**` is excluded from prettier and eslint, because formatting the submodule
      under our config shows its gitlink dirty.

## Renderer layout

`renderer/pathux/` is the shell and its editors; `renderer/graph/` is the shared canvas
geometry; `renderer/rules/` is the "pure" (side-effect-free) rule modules the editors
import. That last directory holds what remains from the React shell. The ports rewrote
markup and gesture glue only, so `script.ts`, `coverage.ts`, `taskGraph.ts`,
`attempts.ts`, `grab.ts` and their kin are unchanged. They were moved out of `rooms/`
rather than rewritten, and their tests moved with them.

```
renderer/
  main.ts               entry; imports styles/index.css, installs @vn/debug2d in DEV, boots the shell
  api.ts                typed access to main; falls back to mock data outside Electron
  global.d.ts           ambient declarations for what the preload injects
  debug/install.ts      dev-only @vn/debug2d glue; vite build drops it entirely
  pathux/               shell.ts (boot) · screen.ts · context.ts · state.ts · api.ts (DataAPI)
                        theme.ts · tokens.ts · keymap.ts · bridge.ts · persist.ts
                        commandform.ts (one command as a form) · palette.ts (find one)
                        dialog.ts (fill one in, when it was already found)
                        editor.ts (VnEditor + registerEditor) · view.ts · panes.ts (pure)
                        route.ts (which editor a clicked node opens; pure)
                        open.ts (the one line of glue that runs that route)
                        assetstrip.ts (the cross-reference strip; owns its own sheet)
                        dom.ts (raw-DOM vocabulary) · selection.ts · agent.ts
                        branch.ts · script.ts · timeline.ts · convo.ts (pure gesture/state cores)
                        graph/canvas.ts · play/playback.ts
       …/editors/       header · branch · script · convo · timeline · tasks · graph · inspector
                        play · wiki · documents · asset
  graph/                layout · edges · hit · viewport · types (pure)
  rules/                the pure cores the editors import, each with a `tests/` sibling:
                        catalog.ts · script.ts · diagnostics.ts · taskGraph.ts · attempts.ts
                        assetview.ts
       …/branch/        graph · grab · compose · tween
       …/timeline/      coverage · drift · editing · wardrobe
  styles/               index.css @imports tokens (document level; the palette crosses shadow
                        roots). branch · studio · timeline · script · wiki · documents · asset
                        are adopted `?inline` by the editor that owns each, and assetstrip
                        is adopted *beside* whichever of them hosts the strip
```

- **Pure logic goes in `.ts` with a `tests/` sibling; the editor only renders.** Jest's
  desktop project is `**/apps/desktop/**/tests/*.test.ts` — `.ts` only, node environment,
  no jsdom. Layout math, hit-testing, gesture state machines and derivation belong under
  test, and jsdom cannot help with any of them; the editors themselves are not tested, and
  are verified live over CDP instead. This repeats the impure-shell/pure-core split of
  `@vn/debug2d`, for the same reason. Each port that found untested logic inside a `.tsx`
  extracted it: `pathux/branch.ts`, `pathux/script.ts`, `pathux/timeline.ts`,
  `src/shared/convo.ts`, `pathux/panes.ts` and `play/playback.ts` are all new pure modules
  with tests the React versions never had.
- **`tokens.css` defines the design tokens**: `--sodium` `#f4a24c` is the warm accent for
  the authored/human side, `--signal` `#45c8d6` is the cool accent for the
  machine/pipeline side, `--ink*` is the surface ramp, and `--disp`/`--prose`/`--mono` are
  the display, prose, and machine-data type. That split already says who made a thing, so
  do not add new accent hues; use these two. `pathux/tokens.ts` restates the same values
  for code that has no stylesheet behind it, and `theme.ts` feeds them to path.ux's own
  theme so that widgets and surfaces agree.
- **`styles/index.css` imports its sheets in cascade order.** It reproduces the
  top-to-bottom order of the single sheet this was split from, so a narrowing `@media`
  block still overrides the base rule. Add a new sheet at the end, not the middle. Both
  shells load the file at document level. Custom properties are the one thing that crosses
  a shadow boundary, so an editor's `var(--…)` reads resolve against these sheets. Rules
  that must apply inside a pane are adopted by the editor (see
  [`adoptStyle`](#surfaces-shadow-roots-and-stylesheets)).
- `prototype.html` (at `apps/desktop/prototype.html`) is the original design reference and
  shares class names with the stylesheet. It is neither built nor imported, so leave it
  alone. `tokens.css` is the source of truth for tokens, not `prototype.html`.

## The shell

`pathux/shell.ts` boots it in this order: theme, icons, `nstructjs.validateStructs()`, the
editor-name check, then `Shell.start()`. `Shell.start()` restores the selection, restores
the layout (or builds the default screen), puts the header back, solves and paints, then
installs the keymap, the bridge, the agent subscription, persistence, the layout watch and
the report preview. The layout watch and the report preview come after the bridge on
purpose, because the layout watch subscribes to the invalidate feed and the report preview
subscribes to `onExec`, and the bridge owns both.

- **A window is a renderer, not an app instance.** One process runs one
  `WorkspaceSession`, one `CommandStack` and one undo history. A window is a
  `BrowserWindow` with a mesh of panes in it, and one process
- **A pane shows an editor, and the list of editors is written down once.**
  `apps/desktop/src/shared/editors.ts` holds all seventeen (`branches`, `script`, `convo`,
  `timeline`, `tasklist`, `taskgraph`, `gengraph`, `inspector`, `play`, `skills`, `wiki`,
  `documents`, `asset`, `project`, `systemprompt`, `onboarding`, `report`) with their
  titles. The list lives in `src/shared/` because `view.*` runs in main like every other
  command and builds its props from that list, while the renderer registers each editor
  class under the matching area name. `checkEditorNames()` warns at boot if the two
  disagree. Each entry also declares what it will show for a clicked document-tree node
  (see [Documents](desktop-app-editors-misc.md#documents)). An eighteenth editor that
  omits that declaration shows up as an incomplete entry in the same file that names it,
  instead of being silently unreachable from the tree. The list deliberately omits the
  header bar, which is "chrome" (surrounding UI) rather than a place the author navigates
  to.
- **An editor can be named without being listed** — `offered: false` on its entry, which
  today Setup, System Prompt and Debug Agent carry. `view.open(editor='onboarding')` still
  works, the palette still finds it, and a saved layout that holds it still restores; what
  the flag removes is the two places an author _browses_ editors. `OFFERED_EDITOR_IDS`
  narrows View ▸ Editors, and the shell installs `isOfferedEditor` as path.ux's
  `setAreaMenuFilter`, which is what keeps it out of the pane header's own change-editor
  dropdown — a menu path.ux builds from its registry rather than from ours, so nothing on
  our side could have filtered it. This is deliberately **not** `AreaFlags.HIDDEN`: hidden
  is a property of the editor, and being uninteresting to browse is a property of _this_
  application. `EDITOR_IDS` still covers all seventeen, so `view.*`'s props are
  unaffected. Once a Setup that is really a preferences window has somewhere to be, it
  stops being a pane at all and the flag goes with it; System Prompt keeps the flag for
  the opposite reason — it is a place to look when a turn misbehaves, and it will never be
  a place to work. Debug Agent keeps it for the same reason as System Prompt, and is
  reached from Help ▸ Report a Difficult Agent… and from the card an API fault raises.
- **Navigation is `view.*`, and the mesh corrects it.** `view.open(editor, where)` shows
  an editor in the active pane or in a new pane split off it (`here` | `left` | `right` |
  `above` | `below` | `elsewhere` | `window`); asking for one already open `here` is a
  focus, not a second copy. `window` is the one value that is not a pane at all: it opens
  a second window showing the editor, and so never reaches the mesh. `elsewhere` is the
  one that means _not on top of what I am looking at_ — a pane already showing that editor
  is focused, otherwise the biggest non-chrome pane that is **not** the asking pane takes
  it, and only a mesh with nowhere else to put it splits the asking pane right. It is what
  a click in the documents tree asks for, so opening an asset never replaces the tree that
  named it (`paneElsewhere` in `panes.ts`, pure and tested). **An automatic open steps
  around a conversation**: whichever pane it would have covered, if that pane is showing
  Convo and any other pane is free, the other one takes it — `paneToShowIn` for `here`,
  and the same preference inside `paneElsewhere`. A transcript is the only pane whose
  contents the author _wrote_; everything else redraws from the project, so covering it
  costs a scroll position, while covering a conversation mid-turn hides the answer they
  are waiting for. It is a preference, never a rule — a mesh with nowhere else still opens
  over it — and it is deliberately **not** in `paneToUse`, which answers "where is the
  author": closing a pane, or splitting one, still means the pane the pointer is in,
  conversation or not. Both `view.open` and `view.focus` take an optional `subject`,
  published into the selection field **that editor's** subject is — `ui.docPath` for
  `wiki`/`documents`, `ui.assetHash` for `asset` — so "open the wiki editor on
  `wiki/history.md`" is one invocation rather than two racing acts; it is published only
  if the mesh could show the editor at all. Routing it per editor is not tidiness:
  pointing `docPath` at a `.png` would make the wiki pane `doc.read` a binary.
  `view.close` (collapse into a neighbour; the last pane is kept) and `view.layout` (throw
  the arrangement away and rebuild the one the app ships with, ignoring the project's
  templates) complete the set; the four layout-template verbs are below. Main answers
  optimistically because only the renderer knows how many panes there are, so
  `pathux/view.ts` returns a **correction** sentence the bridge says instead — "No pane is
  showing Script." The pure half of that decision is `panes.ts` (which pane to use, which
  to close, which is showing what), tested in node.
- **The header is a screen area, not a bar above the screen** — path.ux's own
  `MenuBarEditor` makes the same choice, so the mesh owns its geometry and the header
  survives the layout round-trip like everything else. It is 34px, locked at both ends,
  and `ensureHeader` puts it back on every boot (a stored layout may predate it),
  squeezing what was there into the space below in proportion. It holds the app menu, the
  View menu, the Edit menu, the Help menu, the project badge, undo/redo with the labels
  `command:undo` pushes, an error-or-warning count, the model, `live`/`preview`, and the
  PLAN ⇄ EXECUTE toggle. It rebuilds only when the string of everything it draws changes.
- **A retried model call is counted in the header, and the counter reflects only the
  current state.** When the author grants a retry after a failed call, the header shows
  `⟳ retry n/of` beside the model, and clears it once the turn moves on, whether the model
  came back, the grant ran out, or the author stopped. Only the `retrying` phase counts;
  `failed`, `recovered` and `gaveup` all zero it, because a badge still reading "3 of 10"
  would tell the author a retry is still in progress. The choice itself is an ask card in
  the convo pane, and it produces a durable notification when it ends, either way.
  [`vnauthor.md`](vnauthor.md#how-it-works) covers the question, the ten, and everything
  below the host.
- **The problem count opens the problems.** The badge is a button, and the popup it opens
  lists what validation reported, errors before warnings, with each row showing its code
  and the entity it named on hover. The badge shows a single number, since errors displace
  warnings, while the list shows both, so the count points at what to fix next and the
  popup gives the full picture. Rows are refetched from `workspace:index` on open rather
  than read off `ShellState`, which carries only the two counts. The popup never writes:
  each diagnostic is re-derived from the model on every index, so there is no dismiss and
  no acknowledge, and fixing what the diagnostic reports is what clears it. A row whose
  `where` names a scene the workspace lists navigates to that scene, routed like any other
  node (`diagnosticScene` in `renderer/rules/`, because `where` is an entity id in some
  diagnostics and can name a scene that does not exist in others — `start:` pointing at
  nothing is such a case). The ordering and the two sentences a row needs live in
  `src/shared/diagnostics.ts`, so the node-only jest project tests them and the popup
  stays widgets.
- **The art waiting on approval is counted beside the bell, newest first.** The 🎨 badge
  counts what `session.approvable()` returns, and the popup it opens lists one row per
  picture: a blocked row shows what it is waiting on, a row whose slot already has an
  approved take shows what approving it replaces, and clicking a row opens the Asset
  editor on that hash. Nothing is approved from the popup — approving is done through
  `asset.accept` or `gate.approve` like any other mutation. Rows missing from the stored
  order go on top, and the order is written to the project's own session file
  (`APPROVAL_ORDER_KEY`), so a batch that arrived while the author was away is still at
  the top after a restart. The recount is scheduled and debounced off
  `CommandStack.onRecord` rather than awaited, because it reloads the project and that
  hook sits on the critical path of every command.
- **The View menu is two submenus and two acts.** **Editors** is every editor by name,
  each entry a `view.open`; **Layout** is the project's
  [layout templates](#layout-templates) plus Save Current Layout As… and Reset View
  Layout…; then Close Pane… and Split Area, the latter moved down from the app menu
  because it is a view act. **Both of those two are gestures rather than commands**,
  because which pane, and where the line falls, are answers only a pointer can give: Split
  Area is path.ux's own `splitTool`, and Close Pane… is `closepane.ts`'s picker — the pane
  under the cursor is outlined in vermilion and crossed out, a click collapses it, Escape
  cancels. It is written in the app rather than reached for in path.ux (which has a
  `removeAreaTool`) because this app has two rules about which pane may go — the header is
  not a pane, and the last pane is kept — and they live in `panes.ts` as `paneClosable`. A
  pane that may not go is still outlined, in mist and with the reason written across it,
  since a picker that ignores the pointer is indistinguishable from a broken one.
  `view.close` is unchanged and still collapses the _active_ pane, for the palette, the
  agent and CDP, where there is no pointer and the active pane is the only one that can be
  meant. A submenu is a `Menu` instance in the parent template, and it needs `.title` set
  explicitly — `createMenu` files the title under `name` while the row a parent draws
  reads `.title`, so without it the entry is a blank full-width strip. Entries use
  path.ux's object form (`{name, callback, tooltip, id}`) rather than the positional
  tuple, because every one of them must carry a tooltip and counting commas to reach the
  fifth slot is how `recentMenu` put a project path in it by accident. The tuple has a
  worse trap than a misplaced string: `createMenu` reads `item[5]` as the id for **any**
  row longer than four slots, so a tooltip in slot 4 with no id in slot 5 files the
  callback under `undefined` and the entry silently does nothing when clicked.
- **`bridge.ts` is the only connection to main.** Every fact the shell shows is pushed in
  from `workspace:index`, the agent event stream and `command:ui`; every action leaves as
  `command:exec`, so provenance, undo and history are identical whether the header, the
  palette, an editor or the agent ran it. `say()` puts a sentence in the screen's note
  frame; every editor has one, because `VnEditor` builds its header with a note area.
  `onExec` lets a surface follow the command rather than the button on it (which is how
  `agent.newThread` starts a fresh transcript whether it was run from the pane or from the
  palette). `onWrote(paths)` is the third feed and the only one that reports which files
  were written. It carries `written` from every successful command and from the agent's
  tool results, whose writes are not commands and would otherwise go unreported. The
  document editors subscribe to it, so a file the agent rewrites under an open pane is
  re-read. `src/shared/writes.ts` (`touches` / `touchesScene`) decides which paths concern
  which pane, and is tested in node. The script pane has no path of its own, only a scene
  id.
- **One selection, in `ShellState`.** `ui.sceneId`, `ui.shotId`, `ui.characterId` and
  `ui.docPath` hold the shared authored selection that every editor observes and any
  editor may publish, and they replace the three independent `useState` selections of the
  room shell. `ui.docPath` names a file rather than an id, because `DocNode.path` and
  `EntityLinks.sheet` are paths and a free-form note under `wiki/` has no id at all. It is
  still a selection rather than a buffer: the tree publishes it and the Wiki editor reads
  it. `ui.taskHash` and `ui.assetHash` are the fifth and sixth fields, and they carry
  machine identity rather than authored selection, which is why neither is persisted. A
  content hash re-keys whenever a prompt changes, so a hash remembered across a re-plan
  names nothing. They are two fields rather than one because an art-notes edit re-keys the
  task while the asset it produced keeps its hash, and a pane showing one must keep its
  subject when the other re-keys. `ShellState` is the root of the app-wide path.ux DataAPI
  and the only thing a widget bound through `ctx.api` may reach. Document state never
  lands here, because writes go through
- **Keyboard routing is per-area first.** path.ux routes a keystroke to the focused area's
  keymaps and falls through to the screen's, so the shell claims only Ctrl+Shift+P
  (palette), Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Shift+Tab and Ctrl+Q (quit — it came with the
  stock menu, which main deletes). The shell claims no Escape binding, and a popup
  installs its own while it is up. An editor can claim a key for itself, which the room
  shell's single window-level `keydown` could not allow. An editor with an open text row
  stops its own keydown, because otherwise Ctrl+Z would undo a command instead of a word
  mid-sentence.
- **The palette is a screen popup over the live registry.** `app/catalog.ts` (matching,
  blank values, field coercion) is imported unchanged by both shells, because two palettes
  that disagreed about which command a query names would be a bug in both.
- **One form serves both finding a command and filling it in.** `commandform.ts` holds
  that form: it renders declared props as widgets, shows the live verdict above the
  button, requires a second click for `confirm`, and gives a `directory` prop a Browse…
  button. Two hosts embed it. The palette is the finder, with a search box, a list, and
  the chosen entry's form underneath. `openCommandDialog(id, props)` is the second host. A
  caller that already knows which command to run (a menu entry, a gate bar,
  `pipeline.run`) opens a dialog titled with the command, with Cancel beside the button
  and no search box or list, because the author already picked the command off a menu.
  Both are screen popups, so both are inside the mesh; neither is an OS window.
- **The Edit menu is Undo, Redo, the group entries, and the one act that is a whole art
  pass.** It sits between View and Help and holds Undo (`Ctrl+Z`) and Redo
  (`Ctrl+Shift+Z`) — the two acts an author looks for under a menu with that name, and the
  same pair the header's arrows run — then **Create Group** (`Ctrl+G`), **Ungroup**
  (`Ctrl+Alt+G`), **Edit Group** (`Tab`) and **Exit Group**, which act on the Gen Graph
  pane that is the active one in `paneToUse`'s sense (the pane the pointer last entered,
  else the biggest) and say so when that pane is not a Gen Graph; the keys themselves
  belong to the pane's keymap, and the menu only names them
  ([`gen-graphs.md#the-gen-graph-pane`](gen-graphs.md#the-gen-graph-pane)) — plus
  **Approve & Generate All…**, which opens `pipeline.approveAndRun`'s dialog. That command
  approves every picture waiting, runs the pipeline, and repeats until neither half moves:
  each round unlocks the next rung of the slot graph, so an approved portrait clears the
  gate and an approved sheet lets its plates plan. It is a menu entry rather than a button
  because it spends real model calls and approves art on the author's behalf; the
  confirmation card counts what is waiting and what is planned before anything is spent —
  and says so plainly when the answer to both is none, because a pass with nothing to do
  still takes one round and an author who was not told reads that round as a run that did
  nothing. Stop pipeline ends it after the task in progress, and ends the pass rather than
  only the round it interrupted: the session is held for the whole pass under its own name
  (`BUSY_PASS`), so the header keeps drawing the spinner and the Stop button through the
  gaps between rounds, and one `AbortController` covers all of them. Approving is not a
  run, so a stop asked for while a round is approving previously had nothing to abort and
  was forgotten by the time the next round started. Its loop, its round cap and the
  one-candidate-per-unsettled-slot rule it approves by are in
  [`command-system.md`](command-system.md#the-registered-commands).
- **Only the Help menu starts an update check.** Check for Updates…
  (`app.checkForUpdates`) queries GitHub for the latest release, compares it against
  `apps/desktop/package.json`'s version, and reports the result on screen — nothing is
  scheduled, so the app makes no request until an author asks for one. A check that finds
  an update also raises a durable notification, because that is the one verdict worth
  surviving the frame, while "you are up to date" is shown on screen and not filed. The
  check runs through `act` rather than a form, because it takes no arguments the author
  would fill in, and `report` delivers the answer. Full write-up:
  [`../plans/archive/INDEX.md#in-app-update-checks`](../plans/archive/INDEX.md#in-app-update-checks).
- **The Help menu's other entry opens two dialogs in turn.** Report a Difficult Agent…
  (`pathux/report.ts`) is not a bare `openCommandDialog`: three of `report.agent`'s five
  fields have a vocabulary the command cannot carry — the conversations in _this_ project,
  the models a key might be set for, and the efforts the chosen model offers — so the
  function fetches the threads first and passes `choices` as a **function of the current
  values**, the effort rows being a function of the model row. It seeds the newest thread
  rather than the active one (`Session.thread` is usually empty, including right after
  someone reopened the bad conversation to look at it), and it seeds the **bound** model
  and the bound effort stepped up to where a diagnosis starts — seeds a form, not a
  rebinding: picking opus here does not change what the authoring agent runs on. The
  second dialog is `pathux/reportpreview.ts`, opened from `installReportPreview()` — an
  `onExec` watch on `report.agent` rather than a callback on the first dialog's button,
  because the palette and CDP run the same id and a minute of a real model's time
  answering into nothing is a minute paid for twice. It is bespoke rather than a
  `CommandForm` for one reason: the report body must be **editable** here and must **not**
  be written verbatim into `commands.jsonl`, and `digest: true` — which is what keeps it
  out of the log — replaces the editor with a size label. The Open GitHub Issue… button is
  gated by `report.openIssue`'s own `check`, re-asked on every keystroke, so a name the
  redactor still recognises in the body is a refusal in the command's own words rather
  than a silent rewrite. Full write-up: [`agent-report.md`](agent-report.md).
- **A verdict shown mid-gesture must match the verdict the command produces on commit.**
  Wherever a drag decides something, the grab captures every candidate's verdict up front,
  from the same "pure" (side-effect-free) rule the command itself runs, through the
  interaction layer's `targets` query
  ([`command-system.md`](command-system.md#interactions-the-gesture-surface)). Every
  pointer move reads that captured verdict rather than deciding again. A drop that the
  command would refuse must show as refused while the pointer is still over it. Layout
  therefore changes on commit and never during a gesture, so nothing moves out from under
  the cursor mid-drag. Branches
  ([`desktop-app-editors-story.md`](desktop-app-editors-story.md#branches)) and Script
  state their own version of this rule, which applies to any surface that supports a grab.
- **Every editor registers through `registerEditor(cls, 'vn.Name')`.** nstructjs defaults
  a struct's name to `cls.name`, which esbuild minifies. `ScreenArea.loadSTRUCT` silently
  falls back to the first registered area class when the struct name (or the area name) is
  unknown, so every remembered pane comes back as the same editor. `registerEditor`
  performs both halves of registration under an explicit name, and `restoreLayout`
  discards a layout that names an editor this build does not have rather than
  mis-restoring it. `registerEditor` also sets the pane tab's tooltip, taking `EDITORS`'s
  own `what` through `editorTooltip(id)`. That is the same sentence the View ▸ Editors
  entry shows, because a tab and a menu entry switch to the same editor and the wording
  should not be written twice. A tab is painted on the docker's canvas rather than being a
  DOM node, so path.ux's `TabBar` holds one tooltip and swaps it as the pointer crosses
  tabs; `addTab` used to write `TabItem.tooltip`, and nothing read it.

- **An editor that follows a selection can be pinned off it.** The feature and its icon
  come from Blender. A pinned pane holds one scene while the author reads another, so two
  parts of a story can be compared. An editor becomes pinnable by declaring a single field
  in `EDITORS` — `pins: 'sceneId'` for Script and Shot Coverage, `'docPath'` for Wiki,
  `'assetHash'` for Asset, `'taskHash'` for Inspector — and everything else follows from
  that declaration: `VnEditor.pinToggle` draws the toggle with a sentence built from the
  field's noun, and `registerEditor` splices `pinned : bool; pinnedTo : string` into the
  struct, so a pin survives a restart in all five panes or in none rather than in four.
  The declaration pins one field rather than the whole selection: a pinned Shot Coverage
  holds its scene and still follows the selected shot, so a pinned pane stays a second
  live view of the project rather than a frozen copy of it.
    - **The pin overlays `ui` rather than copying it.** `VnEditor.get ui()` returns a
      `pinnedView` proxy (`pathux/pin.ts`) that answers the pinned field from the pin and
      every other field from the live state, so editors need no second way to read the
      current state and no `this.ui.<field>` read changed. A write through a pinned pane
      moves both: the scene picker in a pinned Script still works, and the whole app
      shares one selection.
    - Toggling it reports through `VnScreen.onLayoutChange`, because the mesh's shape has
      not changed and the pin would otherwise never be recorded. It is drawn in its own
      row so it can be drawn again once the icon sheet settles (`whenIconsSettled`). The
      wiki's header is built in `init()`, before the first `decode()` resolves, and would
      otherwise keep the text fallback for the life of the app.

### Surfaces, shadow roots and stylesheets

`VnEditor` is a `ColumnFrame` inside the area's shadow root with path.ux's header above
it. Raw DOM inside a pane is reached only through two protected methods, and both exist
because of bugs that no DOM query detects:

- **`appendSurface(el)` is the only way to mount a surface.** `Container.appendChild`
  routes a `UIBase` into the shadow root but hands anything else to `super.appendChild`,
  which lands it in the light DOM. A path.ux widget has no `<slot>`, so the node is
  present and can be found and clicked from script, but it is never laid out or drawn:
  `getBoundingClientRect()` reads 0×0.
- `adoptStyle(css)` gives a surface its own sheet inside that shadow root. Document rules
  do not cross the boundary (only custom properties inherit), and `:hover`, `::after` and
  `:has()` have no inline form at all. The coverage strip's auto-growing editor is a
  pseudo-element and its handles are hover states. The room stylesheets are imported
  `?inline` rather than copied, so both shells share one sheet for as long as both exist.

## Layout templates

A layout template is a named screen arrangement the project owns, stored at
`.vnstudio/layouts/<slug>.json`. View ▸ Layout applies one, Save Current Layout As… adds
one, and Reset View Layout… restores one. Two templates ship: Writing (the documents tree,
the script with the branch cards behind it, the agent) and Art (the documents tree, one
asset with its art notes, the pipeline queue). The full write-up is at
[`../plans/archive/INDEX.md#layout-templates-and-the-view-menu`](../plans/archive/INDEX.md#layout-templates-and-the-view-menu).

- **A template is saved with the project; the live mesh is not.** A template is committed
  with the project. What is on screen right now goes in the project's gitignored
  `.vnstudio/session.json` under `pathux.window.<n>.layout`, because it is a window fact,
  for the reason [`desktopAppState.md`](desktopAppState.md) gives.
  `pathux.window.<n>.template` sits beside it and holds the slug last applied, which links
  the two. So `view.applyLayout` neither mutates the project nor can be undone, while
  `view.saveLayout` and `view.resetLayout` both mutate the project and can be undone.
- **A template holds a recipe or a saved mesh, and the choice follows from what writes
  it.** The shipped layouts are declarative recipes (`{split, at, first, second}` down to
  `{pane: [editor, …]}`) because main writes them with no renderer in the loop when it
  scaffolds a project, ensures an old one, or resets. `Save Current Layout As…` writes
  path.ux's own `simple.saveFile` blob instead, because an author drags borders into
  shapes no split grammar describes and per-pane state (the Documents editor's mode) has
  no recipe representation. A file that holds both is refused.
- `DEFAULT_RECIPE` is the Writing recipe, so `buildDefaultScreen` and the Writing template
  cannot drift. A pane that names several editors opens on the first editor, because
  building the pane switches editors in turn and would otherwise leave the last editor
  showing.
- A shipped layout with no file still works, because the layout comes from its recipe, so
  the feature works on day one in a project that predates it. `ensureLayouts` then writes
  any missing file and never overwrites one. Putting an edited `writing.json` back is
  `view.resetLayout`'s job, not something opening a project does.
- **A layout is never merged.** `.gitattributes` marks `.vnstudio/layouts/*.json`
  `-merge`, so git conflicts the path and leaves "ours" (the local side) in the worktree
  unmangled, because applying half a mesh would be worse than either side. The app used to
  read `git status` and refuse a mid-merge template by name, but the undo refactor removed
  that check, so the app now opens the side git left there. See
  [`repos-and-commits.md`](repos-and-commits.md).
- **Undo restores the screen, not just the file.** Undo restores the template files, and
  no `view.*` command ran, so nothing pushes an effect. `renderer/pathux/panes/layouts.ts`
  detects the change by fingerprint: it records what was applied and re-applies when main
  reports different bytes under the same slug. The module seeds without applying at boot,
  so a border dragged last session survives.

## The shared graph canvas

Two editors draw a graph, and they share both the geometry and the surface.
`renderer/graph/` holds the domain-free math: `layout.ts` (layered DAG layout), `edges.ts`
(routes plus the polyline every hit test uses), `hit.ts` (`pick`), and `viewport.ts`
(pan/zoom). Every one of those modules is pure and has tests. `pathux/graph/canvas.ts`
provides the imperative surface over it. The plan is in
[`../plans/archive/INDEX.md#story-branch-editor`](../plans/archive/INDEX.md#story-branch-editor).

- **One geometry, drawn and hit-tested.** `routeEdges` emits the SVG path and its sampled
  polyline together, so an edge is clickable exactly where it is drawn. Slop is authored
  in screen pixels and divided by the scale before it is applied to world geometry. `pick`
  performs that conversion itself, so callers never scale the slop themselves.
- **Two co-transformed layers**: the SVG layer holds the wires and the HTML layer holds
  the cards and labels, because cards and labels are typeset material and SVG text has no
  wrapping. Both layers carry the same viewport, through `transformOf` for SVG and
  `cssTransformOf` for HTML. The two syntaxes are not interchangeable, and CSS silently
  drops a transform it cannot parse. The node layer is `pointer-events: none`, and an
  element that needs a real DOM target (an inline label editor) opts back in.
- **A claimed gesture calls `preventDefault()`** — that call marks the pointer as claimed
  for the canvas. Without it, the canvas pans underneath an unwire drag, the one gesture
  that starts over empty background. The React overlay consumed the event without
  signaling that it had.
- **One persistent overlay host** is handed to `setOverlay` once and mutated in place, so
  a pointer move repaints the verdict paths, the ghost wire and the carried card without
  rebuilding content.

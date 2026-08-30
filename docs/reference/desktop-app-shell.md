# The desktop app shell

<!-- toc -->

- [path.ux renderer rules](#pathux-renderer-rules)
- [Running it](#running-it)
- [Renderer layout](#renderer-layout)
- [The shell](#the-shell)
  * [Surfaces, shadow roots and stylesheets](#surfaces-shadow-roots-and-stylesheets)
- [Layout templates](#layout-templates)
- [The shared graph canvas](#the-shared-graph-canvas)

<!-- tocstop -->

Part of [`desktop-app.md`](desktop-app.md) — the renderer's own rules, how to run and build the
app, the renderer's file layout, the path.ux shell (window, header, menus, selection, keyboard,
the palette), layout templates, and the graph canvas the two graph editors share.

## path.ux renderer rules

The renderer is a path.ux screen mesh: panes subdivide the window, each showing one editor.
There is no React and no room vocabulary. path.ux is a git submodule at `vendor/path.ux`,
so a fresh clone needs `git submodule update --init --recursive` (`pnpm check:setup` reports
this by name). Seven rules cause the most mistakes:

- The sixteen editors are named in one place (`apps/desktop/src/shared/editors.ts`), and
  `registerEditor(cls, 'vn.Name')` is the only way to register one, because a hand-written
  name string breaks under minification. That list also carries each editor's `claims`
  predicate, ranked in `renderer/pathux/route.ts`, and a `pins` field for the one selection
  an editor can be pinned to. `pins` is declared once, and `registerEditor` splices in the
  struct fields that persist it.
- `offered: false` makes an editor registered but not listed: reachable by `view.open`, the
  palette, and saved layouts, but absent from the two menus an author browses editors in.
  `OFFERED_EDITOR_IDS` narrows View ▸ Editors. path.ux's `setAreaMenuFilter`, installed
  once by the shell, keeps unoffered editors out of the pane header's own dropdown, which
  path.ux builds from its registry rather than from ours. This is deliberately not
  `AreaFlags.HIDDEN`: hidden describes the editor itself, while not-listed describes this
  application's menus. Three editors carry the flag. Setup will stop being a pane once a
  preferences window exists to hold it, System Prompt exists for inspecting a
  misbehaving turn rather than for day-to-day work, and Debug Agent is somewhere Help sends
  the author rather than somewhere they arrange a window to keep.
- `src/shared/` is in the browser bundle, so everything it imports must be node-free.
  Neither `tsgo` pass catches a violation; only `vite build` does.
- Raw DOM surfaces go in the shadow root via `VnEditor.appendSurface`, each with its own
  sheet via `adoptStyle`. The import order in `styles/index.css` determines the cascade
  order, and `tokens.css` defines the design tokens (no new accent hues).
- Pure logic goes in `.ts` files with a `tests/` sibling, and the editor stays thin
  rendering. The jest desktop project is node-only, so surfaces are verified live over CDP.
- A mid-gesture verdict must match the verdict that would apply on commit, layout changes
  on commit, and an editor with an open text row stops its own keydown events.
- `renderer/pathux/api.ts` is rooted on `ShellState` and defines nothing for documents. One
  editor overrides it: Gen Graph roots a second `DataAPI` on the graph it has open, through
  `ctx.override({api})` per instance, so path.ux builds the node rows. A bound write is still
  judged and sent as a command, so `@vn/commands` remains the write path.

## Running it

```sh
pnpm build:desktop && pnpm vndesktop --mock     # runs for real by default; --mock skips model calls
pnpm --filter @vn/desktop dev -- --mock         # live dev loop
```

`--project <dir>` overrides the workspace (`VN_PROJECT=<dir>` is an equivalent env fallback).

- **Shipping it is a different command.** `pnpm package` builds an installer and `pnpm smoke`
  runs the packaged binary to prove the two lazily-imported SDKs, the plugin bundler's own binary
  and the debug agent's source snapshot all reached the app image. The release workflow runs it
  before uploading anything.
  Why it is built the way it is: [`../guides/toolchain.md`](../guides/toolchain.md#packaging-the-desktop-app) and
  [`../plans/archive/INDEX.md#packaging-the-desktop-app`](../plans/archive/INDEX.md#packaging-the-desktop-app).
- **`pnpm vndesktop` opens CDP on 9222**, like the dev loop — `scripts/vndesktop.mjs` sets
  `VN_CDP_PORT` before launching Electron, because the switch can only be appended before
  `app.whenReady()` and this is the entry point you reach for when you mean to drive the app from
  `scripts/vn-cdp.mjs`. It announces the port on stdout; `VN_CDP_PORT=<n>` picks another and
  `VN_CDP_PORT=` (empty) opts out. `pnpm --filter @vn/desktop start` still starts the same built
  app with **no** port, as does a packaged build — see
  [`command-system.md`](command-system.md#from-devtools-or-cdp).
- **There is no stock menu.** `Menu.setApplicationMenu(null)` runs at `app.whenReady()` — the
  File/Edit/View scaffolding named things this app has not got, and the shell has its own bar. Two
  of the accelerators it took away are worth keeping, so both come back: **F12** opens DevTools,
  caught in main on `before-input-event` because the renderer cannot open its own, and **Ctrl+Q**
  quits, in the shell keymap and in the VN STUDIO menu. Quitting runs `window.close()`, so the wiki
  pane's unsaved-draft guard still gets its say — main answers that guard's `will-prevent-unload`
  with a modal, and `before-quit` holds the app open for the session store's last debounced write,
  bounded at two seconds so a flush that never settles cannot wedge the quit.
- **Live dev loop:** `pnpm --filter @vn/desktop dev` (`scripts/dev.desktop.mjs`) runs the three
  moving parts together — esbuild `--watch` (main + preload), the Vite renderer server with HMR,
  and Electron launched against it once it's up (`VITE_DEV_SERVER_URL`, which
  `src/main/index.ts` loads instead of the built file). Quitting the window (or Ctrl-C) tears the
  whole tree down. `VN_DEV_PORT` overrides the renderer port (default 5176); any args after the
  script's own (e.g. `--mock`, `--project <dir>`) are forwarded to Electron, and `VN_MOCK`/
  `VN_PROJECT` still pass through as env fallbacks. Main-process edits need a restart (the
  renderer hot-reloads on its own). The dev loop defaults `VN_CDP_PORT=9222` for the same reason
  `pnpm vndesktop` does — see [`command-system.md`](command-system.md#from-devtools-or-cdp).
- **path.ux is a git submodule** at `vendor/path.ux` and carries a nested one of its own, so a
  fresh clone needs `git submodule update --init --recursive` — and then
  `pnpm --dir vendor/path.ux install`, because path.ux keeps its own lockfile and is not a pnpm
  workspace member, so the root install does not reach it. `pnpm check:setup`
  (`scripts/check-submodules.mjs`, also the first step of `@vn/desktop`'s `build`) fails by name on
  either one rather than letting the resolver complain.
  - **nstructjs is a git submodule too**, at `vendor/nstructjs`, and is consumed from the build
    output it commits, so it needs no install of its own. `@vn/desktop` depends on it as
    `link:../../vendor/nstructjs`, and the vite alias plus the `nstructjs` entry in
    `renderer/tsconfig.json` and `pathux-types.tsconfig.json` point there as well — path.ux imports
    nstructjs, and its own install puts the published package in `vendor/path.ux/node_modules`,
    which those three redirect.
  - Vite compiles path.ux's TypeScript source through an alias — there is no prebuilt bundle to
    keep in sync — while `tsgo` checks us against declarations regenerated from that same source on
    every `check` (`build:pathux-types` → `apps/desktop/dist/pathux-types`, gitignored).
  - `vendor/**` is excluded from prettier and eslint: formatting the submodule under our config
    shows its gitlink dirty.

## Renderer layout

`renderer/pathux/` is the shell and its editors; `renderer/graph/` is the shared canvas geometry;
`renderer/rules/` is the pure rule modules the editors import. That last directory is what the
React shell left behind: the ports rewrote markup and gesture glue only, so `script.ts`,
`coverage.ts`, `taskGraph.ts`, `attempts.ts`, `grab.ts` and their kin are unchanged — they were
**moved** out of `rooms/`, not rewritten, and their tests moved with them.

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

- **Pure logic goes in `.ts` with a `tests/` sibling; the editor stays thin rendering.** Jest's
  desktop project is `**/apps/desktop/**/tests/*.test.ts` — `.ts` only, node environment, no
  jsdom. Layout math, hit-testing, gesture state machines and derivation are exactly what you
  want under test and exactly what jsdom can't help with; the editors themselves are not tested,
  they are verified live over CDP. Same impure-shell/pure-core split as `@vn/debug2d`, for the
  same reason. Each port that found untested logic inside a `.tsx` extracted it: `pathux/branch.ts`,
  `pathux/script.ts`, `pathux/timeline.ts`, `src/shared/convo.ts`, `pathux/panes.ts` and
  `play/playback.ts` are all new pure modules with tests the React versions never had.
- **`tokens.css` is the design contract**: `--sodium` `#f4a24c` is warm — the authored/human
  side; `--signal` `#45c8d6` is cool — the machine/pipeline side; `--ink*` is the surface ramp;
  `--disp`/`--prose`/`--mono` are display/prose/machine-data type. That split already encodes
  "who made this", so **don't add new accent hues** — spend these two. `pathux/tokens.ts` restates
  the same values for code that has no stylesheet behind it, and `theme.ts` feeds them to path.ux's
  own theme so widgets and surfaces agree.
- **`styles/index.css` import order IS cascade order.** It reproduces the top-to-bottom order
  of the single sheet this was split from, so a narrowing `@media` block still overrides the base
  rule. Add a new sheet at the **end**, not the middle. It is loaded at document level for both
  shells: custom properties are the one thing that crosses a shadow boundary, so it is what an
  editor's `var(--…)` reads resolve against. Rules that must apply *inside* a pane are adopted by
  the editor (see [`adoptStyle`](#surfaces-shadow-roots-and-stylesheets)).
- **`prototype.html`** (at `apps/desktop/prototype.html`) is the original design reference and
  shares class names with the stylesheet. It is neither built nor imported — leave it alone,
  and don't treat it as the source of truth for tokens; `tokens.css` is.

## The shell

`pathux/shell.ts` boots it, in this order: theme, icons, `nstructjs.validateStructs()`, the
editor-name check, then `Shell.start()` — restore the selection, restore the layout (or build the
default screen), put the header back, solve and paint, then install the keymap, the bridge, the
agent subscription, persistence, the layout watch and the report preview. The last two come after
the bridge on purpose — one subscribes to the invalidate feed and the other to `onExec`, and both
are the bridge's.

- **A window is a renderer, not an app instance.** One process runs one `WorkspaceSession`, one
  `CommandStack` and one undo history; a window is a `BrowserWindow` with a mesh of panes in it,
  and there can be several. `window.new` opens another, `window.close` closes the asking one, and
  `window.quit` closes them all — the distinction Ctrl+W and Ctrl+Q used to blur. Each window is
  handed an **index** at the lowest free slot, and everything it remembers — its mesh, its
  selection, its layout template, its bounds — is keyed by that index and by the workspace
  ([`desktopAppState.md`](desktopAppState.md)). The renderer learns which one it is from its own
  url (`?window=<n>&ws=<scope>`) rather than over IPC, because restore happens before the first
  paint. `window.new(editor=…)` rides the same url and is acted on once, after the remembered
  arrangement is up, as an ordinary `view.open(where=elsewhere)` — so a window opened onto an
  editor keeps the arrangement it had rather than replacing a pane with it. That same query string
  is what makes a CDP page target selectable
  (`node scripts/vn-cdp.mjs --window 1 …`). A command carries `ctx.origin` so main knows which
  window asked, and each effect is broadcast or targeted by **type**: a workspace invalidation
  reaches every window, a `command:ui` effect only the one that asked. Two processes on one
  project are refused outright — see the lock in
  [`desktopAppState.md`](desktopAppState.md#multiple-windows-of-the-same-workspace).
  Full design: [`../plans/multiple-windows.md`](../plans/multiple-windows.md).
- **A pane shows an editor, and the list of editors is written down once.**
  `apps/desktop/src/shared/editors.ts` holds all seventeen (`branches`, `script`, `convo`,
  `timeline`, `tasklist`, `taskgraph`, `gengraph`, `inspector`, `play`, `skills`, `wiki`,
  `documents`, `asset`, `project`, `systemprompt`, `onboarding`, `report`) with their titles. It is
  in `src/shared/` because
  `view.*` runs in **main** like every other command and builds its props from that list, while the
  renderer registers each editor class under the matching area name; `checkEditorNames()` warns at
  boot if the two ever disagree. Each entry also declares what it will show for a clicked
  document-tree node (see [Documents](desktop-app-editors-misc.md#documents)), so an eighteenth
  editor that forgets to is visibly claim-less in the same file that names it rather than silently
  unreachable from the tree.
  The header bar is deliberately absent from the list — it is chrome,
  not somewhere the author navigates to.
- **An editor can be named without being listed** — `offered: false` on its entry, which today
  Setup, System Prompt and Debug Agent carry. `view.open(editor='onboarding')` still works, the palette still finds it,
  and a saved layout that holds it still restores; what the flag removes is the two places an
  author *browses* editors. `OFFERED_EDITOR_IDS` narrows View ▸ Editors, and the shell installs
  `isOfferedEditor` as path.ux's `setAreaMenuFilter`, which is what keeps it out of the pane
  header's own change-editor dropdown — a menu path.ux builds from its registry rather than from
  ours, so nothing on our side could have filtered it. This is deliberately **not**
  `AreaFlags.HIDDEN`: hidden is a property of the editor, and being uninteresting to browse is a
  property of *this* application. `EDITOR_IDS` still covers all seventeen, so `view.*`'s props are
  unaffected. Once a Setup that is really a preferences window has somewhere to be, it stops
  being a pane at all and the flag goes with it; System Prompt keeps the flag for the opposite
  reason — it is a place to look when a turn misbehaves, and it will never be a place to work.
  Debug Agent keeps it for the same reason as System Prompt, and is reached from Help ▸ Report a
  Difficult Agent… and from the card an API fault raises.
- **Navigation is `view.*`, and the mesh corrects it.** `view.open(editor, where)` shows an editor
  in the active pane or in a new pane split off it (`here` | `left` | `right` | `above` | `below` |
  `elsewhere` | `window`); asking for one already open `here` is a focus, not a second copy.
  `window` is the one value that is not a pane at all: it opens a second window showing the editor,
  and so never reaches the mesh. `elsewhere` is the
  one that means *not on top of what I am looking at* — a pane already showing that editor is
  focused, otherwise the biggest non-chrome pane that is **not** the asking pane takes it, and only
  a mesh with nowhere else to put it splits the asking pane right. It is what a click in the
  documents tree asks for, so opening an asset never replaces the tree that named it
  (`paneElsewhere` in `panes.ts`, pure and tested). **An automatic open steps around a
  conversation**: whichever pane it would have covered, if that pane is showing Convo and any other
  pane is free, the other one takes it — `paneToShowIn` for `here`, and the same preference inside
  `paneElsewhere`. A transcript is the only pane whose contents the author *wrote*; everything else
  redraws from the project, so covering it costs a scroll position, while covering a conversation
  mid-turn hides the answer they are waiting for. It is a preference, never a rule — a mesh with
  nowhere else still opens over it — and it is deliberately **not** in `paneToUse`, which answers
  "where is the author": closing a pane, or splitting one, still means the pane the pointer is in,
  conversation or not. Both `view.open` and
  `view.focus` take an optional `subject`, published into the selection field **that editor's**
  subject is — `ui.docPath` for `wiki`/`documents`, `ui.assetHash` for `asset` — so "open the wiki
  editor on `wiki/history.md`" is one invocation rather than two racing acts; it is
  published only if the mesh could show the editor at all. Routing it per editor is not tidiness:
  pointing `docPath` at a `.png` would make the wiki pane `doc.read` a binary. `view.close` (collapse into a
  neighbour; the last pane is kept) and `view.layout` (throw the arrangement away and rebuild the
  one the app ships with, ignoring the project's templates) complete the set; the four layout-template
  verbs are below.
  Main answers optimistically because only the renderer knows how many panes there are, so
  `pathux/view.ts` returns a **correction** sentence the bridge says instead — "No pane is showing
  Script." The pure half of that decision is `panes.ts` (which pane to use, which to close, which is
  showing what), tested in node.
- **The header is a screen area, not a bar above the screen** — the same choice path.ux's own
  `MenuBarEditor` makes, so the mesh owns its geometry and the header survives the layout
  round-trip like everything else. It is 34px, locked at both ends, and `ensureHeader` puts it back
  on **every** boot (a stored layout may predate it), squeezing what was there into the space below
  in proportion. It holds the app menu, the View menu, the Edit menu, the Help menu, the project
  badge, undo/redo
  with the labels `command:undo` pushes, an error-or-warning count, the model, `live`/`preview`, and
  the PLAN ⇄ EXECUTE toggle. It rebuilds when — and only when — the string of everything it draws
  changes.
- **A model call being tried again is counted in the header, and the counter is a claim about
  now.** When the author grants a retry after a failed call, the header shows `⟳ retry n/of`
  beside the model and clears it the instant the turn moves on — whether the model came back,
  the grant ran out, or the author stopped. Only the `retrying` phase counts; `failed`, `recovered`
  and `gaveup` all zero it, because a badge left standing on "3 of 10" says something is still
  happening. The choice itself is an ask card in the convo pane, and the end of it is a durable
  notification either way; the question, the ten, and everything below the host is
  [`vnauthor.md`](vnauthor.md#how-it-works).
- **The problem count opens the problems.** The badge is a button: it lists what validation said,
  errors before warnings, each row hovering its code and the entity it named. The badge still shows
  **one** number — errors displace warnings, the worse one wins it — while the list shows both, so
  the count stays the thing to fix next and the popup is the whole picture. Rows are refetched from
  `workspace:index` on open rather than read off `ShellState`, which carries only the two counts,
  and **nothing in the popup writes**: a diagnostic is a reading of the model, re-derived on every
  index, so there is no dismiss and no acknowledge — fixing what it is about is what clears it. A
  row whose `where` names a scene the workspace lists is a **way in**, routed like any other node
  (`diagnosticScene` in `renderer/rules/`, because `where` is an entity id in some diagnostics and
  can name a scene that does not exist in others — `start:` pointing at nothing is exactly that).
  The ordering and the two sentences a row needs are `src/shared/diagnostics.ts`, so the node-only
  jest project tests them and the popup stays widgets.
- **The art waiting on approval is counted beside the bell, newest first.** The 🎨 badge counts
  what `session.approvable()` returns, and the popup it opens lists one row per picture: a
  blocked row says what it is waiting on, a row whose slot already has an approved take says
  what approving it replaces, and clicking a row opens the Asset editor on that hash. Nothing is
  approved from the popup — the decision leaves as `asset.accept` or `gate.approve` like any
  other mutation. Whatever the stored order has not seen goes on top, and the order is written
  to the project's own session file (`APPROVAL_ORDER_KEY`), so a batch that arrived while the
  author was away is still at the top after a restart. The recount is scheduled rather than
  awaited off `CommandStack.onRecord`, debounced, because it reloads the project and that hook
  sits on the critical path of every command.
- **The View menu is two submenus and two acts.** **Editors** is every editor by name, each entry a
  `view.open`; **Layout** is the project's [layout templates](#layout-templates) plus Save Current
  Layout As… and Reset View Layout…; then Close Pane… and Split Area, the latter moved down from the
  app menu because it is a view act. **Both of those two are gestures rather than commands**, because
  which pane, and where the line falls, are answers only a pointer can give: Split Area is path.ux's
  own `splitTool`, and Close Pane… is `closepane.ts`'s picker — the pane under the cursor is outlined
  in vermilion and crossed out, a click collapses it, Escape cancels. It is written in the app rather
  than reached for in path.ux (which has a `removeAreaTool`) because this app has two rules about
  which pane may go — the header is not a pane, and the last pane is kept — and they live in
  `panes.ts` as `paneClosable`. A pane that may not go is still outlined, in mist and with the reason
  written across it, since a picker that ignores the pointer is indistinguishable from a broken one.
  `view.close` is unchanged and still collapses the *active* pane, for the palette, the agent and
  CDP, where there is no pointer and the active pane is the only one that can be meant.
  A submenu is a `Menu` instance in the parent template, and it
  needs `.title` set explicitly — `createMenu` files the title under `name` while the row a parent
  draws reads `.title`, so without it the entry is a blank full-width strip. Entries use path.ux's
  object form (`{name, callback, tooltip, id}`) rather than the positional tuple, because every one
  of them must carry a tooltip and counting commas to reach the fifth slot is how `recentMenu` put
  a project path in it by accident. The tuple has a worse trap than a misplaced string: `createMenu`
  reads `item[5]` as the id for **any** row longer than four slots, so a tooltip in slot 4 with no id
  in slot 5 files the callback under `undefined` and the entry silently does nothing when clicked.
- **`bridge.ts` is the one seam to main.** Every fact the shell shows is pushed in from
  `workspace:index`, the agent event stream and `command:ui`; every act leaves as
  `command:exec`, so provenance, undo and history are identical whether the header, the palette, an
  editor or the agent ran it. `say()` puts a sentence in the screen's note frame — every editor gets
  one, because `VnEditor` builds its header with a note area. `onExec` lets a surface follow the
  *command* rather than the button on it (which is how `agent.newThread` starts a fresh transcript
  whether it was run from the pane or from the palette). `onWrote(paths)` is the third feed and the only one that answers **which files
  moved**: it carries `written` from every successful command *and* from the agent's tool results,
  whose writes are not commands and would otherwise be invisible. The document editors subscribe to
  it, so a file the agent rewrites under an open pane is re-read. Which paths concern which pane is
  `src/shared/writes.ts` (`touches` / `touchesScene`), tested in node — the script pane has no path
  of its own, only a scene id.
- **One selection, in `ShellState`.** `ui.sceneId` / `ui.shotId` / `ui.characterId` / `ui.docPath`
  are the shared authored selection every editor observes and any editor may publish — the three
  independent `useState` selections of the room shell are gone. `ui.docPath` is the one that names a
  **file** rather than an id, because `DocNode.path` and `EntityLinks.sheet` are paths and a
  free-form note under `wiki/` has no id at all; it is still a selection — the tree publishes it, the
  Wiki editor reads it — not a buffer. `ui.taskHash` and `ui.assetHash` are the fifth and sixth,
  machine identity rather than authored, which is why neither is persisted: a content hash re-keys
  whenever a prompt changes, so one remembered across a re-plan names nothing. They are two fields
  rather than one because an art-notes edit re-keys the **task** while the asset it produced keeps
  its hash — a pane on one must not be dragged off its subject by the other. `ShellState` is the root of the
  app-wide path.ux DataAPI, and the only thing a widget bound through `ctx.api` may reach —
  document state never lands here, because `@vn/commands` is the write path. One editor overrides
  that API for itself. Gen Graph builds a second `DataAPI` rooted on the graph it has open and
  installs it through `ctx.override({api})`, per instance, so path.ux's node view can bind the
  rows it draws. `api.ts` is untouched by this: the override lives and dies with the pane, and a
  write through it is still judged and sent as a command.
- **Keyboard is per-area first.** path.ux routes a keystroke to the focused area's keymaps and
  falls through to the screen's, so the shell claims only Ctrl+Shift+P (palette), Ctrl+Z /
  Ctrl+Shift+Z /
  Ctrl+Y, Shift+Tab and Ctrl+Q (quit — it came with the stock menu, which main deletes). Escape is nobody's: a popup installs its own while it is up. An editor that
  wants a key for itself simply takes it, which the room shell's single window-level `keydown`
  could not allow — and an editor with an **open text row stops its own keydown**, or Ctrl+Z
  undoes a command instead of a word mid-sentence.
- **The palette is a screen popup over the live registry.** `app/catalog.ts` — matching, blank
  values, field coercion — is imported unchanged by both shells, because two palettes disagreeing
  about which command a query names would be a bug in both.
- **Finding a command and filling it in are two surfaces over one form.** `commandform.ts` is the
  form — declared props as widgets, the live verdict above the button, `confirm`'s second click,
  a `directory`'s Browse… — and it is hosted twice. The **palette** is the finder: a search box, a
  list, and the chosen entry's form underneath. `openCommandDialog(id, props)` is the other host: a
  caller that already knows which command it wants (a menu entry, a gate bar, `pipeline.run`) opens
  a dialog titled with the command, with Cancel beside the button, and **no search box and no
  list** — the author picked it off a menu, so offering to find it again is noise. Both are screen
  popups, so both are inside the mesh; neither is an OS window.
- **The Edit menu is Undo, Redo, and the one act that is a whole art pass.** It sits between View
  and Help and holds Undo (`Ctrl+Z`) and Redo (`Ctrl+Shift+Z`) — the two acts an author looks for
  under a menu with that name, and the same pair the header's arrows run — plus **Approve &
  Generate All…**, which opens `pipeline.approveAndRun`'s dialog. That command approves every
  picture waiting, runs the pipeline, and repeats until neither half moves: each round unlocks the
  next rung of the slot graph, so an approved portrait clears the gate and an approved sheet lets
  its plates plan. It is a menu entry rather than a button because it spends real model calls and
  approves art on the author's behalf; the confirmation card counts what is waiting and what is
  planned before anything is spent — and says so plainly when the answer to both is none, because
  a pass with nothing to do still takes one round and an author who was not told reads that round
  as a run that did nothing. Stop pipeline ends it after the task in progress, and ends the pass
  rather than only the round it interrupted: the session is held for the whole pass under its own
  name (`BUSY_PASS`), so the header keeps drawing the spinner and the Stop button through the gaps
  between rounds, and one `AbortController` covers all of them. Approving is not a run, so a stop
  asked for while a round is approving previously had nothing to abort and was forgotten by the
  time the next round started. Its loop, its round cap and the one-candidate-per-unsettled-slot
  rule it approves by are in [`command-system.md`](command-system.md#the-registered-commands).
- **The Help menu is the only thing that ever starts an update check.** Check for Updates…
  (`app.checkForUpdates`) asks GitHub whether a newer release exists, compares it against
  `apps/desktop/package.json`'s version, and says so on screen — nothing is scheduled, so the app
  makes no request until an author asks for one. An update that *is* found also earns a durable
  notification, because that is the one verdict worth surviving the frame; "you are up to date" is
  said and not filed. The check is fired through `act` rather than a form: it takes no arguments
  the author would fill in, and `report` is what voices the answer. Full write-up:
  [`../plans/archive/INDEX.md#in-app-update-checks`](../plans/archive/INDEX.md#in-app-update-checks).
- **The Help menu's other entry opens two dialogs in turn.** Report a Difficult Agent…
  (`pathux/report.ts`) is not a bare `openCommandDialog`: three of `report.agent`'s five fields have
  a vocabulary the command cannot carry — the conversations in *this* project, the models a key
  might be set for, and the efforts the chosen model offers — so the function fetches the threads
  first and passes `choices` as a **function of the current values**, the effort rows being a
  function of the model row. It seeds the newest thread rather than the active one (`Session.thread`
  is usually empty, including right after someone reopened the bad conversation to look at it), and
  it seeds the **bound** model and the bound effort stepped up to where a diagnosis starts — seeds a
  form, not a rebinding: picking opus here does not change what the authoring agent runs on.
  The second dialog is `pathux/reportpreview.ts`, opened from `installReportPreview()` — an `onExec`
  watch on `report.agent` rather than a callback on the first dialog's button, because the palette
  and CDP run the same id and a minute of a real model's time answering into nothing is a minute
  paid for twice. It is bespoke rather than a `CommandForm` for one reason: the report body must be
  **editable** here and must **not** be written verbatim into `commands.jsonl`, and `digest: true`
  — which is what keeps it out of the log — replaces the editor with a size label. The Open GitHub
  Issue… button is gated by `report.openIssue`'s own `check`, re-asked on every keystroke, so a name
  the redactor still recognises in the body is a refusal in the command's own words rather than a
  silent rewrite. Full write-up: [`agent-report.md`](agent-report.md).
- **A mid-gesture verdict must be the verdict that would happen.** Wherever a drag decides
  something, the grab captures every candidate's verdict up front — from the same pure rule the
  command itself runs, through the interaction layer's `targets` query
  ([`command-system.md`](command-system.md#interactions-the-gesture-surface)) — and every pointer
  move is a lookup, never a fresh decision. A drop that the command would refuse must read as
  refused while the pointer is still over it. The corollary: **layout changes on commit, never
  during a gesture**, so nothing moves out from under the cursor mid-drag. Branches
  ([`desktop-app-editors-story.md`](desktop-app-editors-story.md#branches)) and Script state their
  own version of this rule; it applies to any surface that grabs.
- **Every editor registers through `registerEditor(cls, 'vn.Name')`.** nstructjs defaults a
  struct's name to `cls.name`, which esbuild minifies, and `ScreenArea.loadSTRUCT` answers an
  unknown struct name — or an unknown **area** name — by silently falling back to the first
  registered area class, so every remembered pane comes back as the same editor. `registerEditor`
  does both halves of registration under a written-down name, and `restoreLayout` discards a
  layout naming an editor this build has not got rather than mis-restoring it. It also **splices
  the pane tab's tooltip in**, from `EDITORS`'s own `what` through `editorTooltip(id)` — the same
  sentence the View ▸ Editors entry offers, because switching to an editor by tab and by menu are
  one act and must not be described twice. A tab is painted on the docker's canvas rather than
  being a DOM node, so path.ux's `TabBar` carries one tooltip and swaps it as the pointer crosses
  tabs; `TabItem.tooltip` used to be written by `addTab` and read by nobody.

- **An editor that follows a selection can be pinned off it.** Blender's idea, and the same icon:
  a pane holding one scene while the author reads another is how two parts of a story get compared
  at all. An editor becomes pinnable by declaring **one** field in `EDITORS` — `pins: 'sceneId'`
  for Script and Shot Coverage, `'docPath'` for Wiki, `'assetHash'` for Asset, `'taskHash'` for
  Inspector — and everything else follows from that declaration: `VnEditor.pinToggle` draws the
  toggle with a sentence built from the field's noun, and `registerEditor` splices
  `pinned : bool; pinnedTo : string` into the struct, so a pin survives a restart in five panes or
  in none rather than in four. **One field, not the whole selection**: a pinned Shot Coverage holds its
  scene and still follows the selected shot, which is what makes a pinned pane a second view of the
  project rather than a photograph of one.
  - **The pin is a lens over `ui`, not a copy of it.** `VnEditor.get ui()` returns a `pinnedView`
    proxy (`pathux/pin.ts`) answering the pinned field from the pin and everything else from the
    live state, so no editor learns a second way to ask what it is looking at and none of the
    `this.ui.<field>` reads changed. **A write through a pinned pane moves both** — the scene
    picker in a pinned Script still works, and a selection is one thing the whole app shares.
  - Toggling it reports through `VnScreen.onLayoutChange`, because nothing about the mesh's shape
    moved and the pin would otherwise never be written down. It is drawn in its own row so it can
    be **drawn again** once the icon sheet settles (`whenIconsSettled`): the wiki's header is built
    in `init()`, before the first `decode()` resolves, and would otherwise keep the text fallback
    for the life of the app.

### Surfaces, shadow roots and stylesheets

`VnEditor` is a `ColumnFrame` inside the area's shadow root with path.ux's header above it. Two
protected methods are the whole contract for raw DOM inside a pane, and both exist because of bugs
that pass every DOM query:

- **`appendSurface(el)` is the only way to mount a surface.** `Container.appendChild` routes a
  `UIBase` into the shadow root but hands anything else to `super.appendChild`, which lands it in
  the **light** DOM — where a path.ux widget has no `<slot>`. The node is then present, findable and
  clickable from script, and never laid out or drawn: `getBoundingClientRect()` reads 0×0.
- **`adoptStyle(css)` gives a surface its own sheet** inside that shadow root. Document rules do not
  cross the boundary (only custom properties inherit), and `:hover`, `::after` and `:has()` have no
  inline form at all — the coverage strip's auto-growing editor is a pseudo-element and its handles
  are hover states. The room stylesheets are imported `?inline` rather than copied, so both shells
  share one sheet for as long as both exist.

## Layout templates

A **layout template** is a named screen arrangement the *project* owns:
`.vnstudio/layouts/<slug>.json`, applied from View ▸ Layout, grown by Save Current Layout As…, and
put back by Reset View Layout…. Two ship — **Writing** (the documents tree, the script with the
branch cards behind it, the agent) and **Art** (the documents tree, one asset with its art notes,
the pipeline queue). Full write-up:
[`../plans/archive/INDEX.md#layout-templates-and-the-view-menu`](../plans/archive/INDEX.md#layout-templates-and-the-view-menu).

- **The template is the saved arrangement; the live mesh is not.** A template is committed with the
  project. What is on screen right now goes in the project's gitignored
  `.vnstudio/session.json` under `pathux.window.<n>.layout`, for the reason
  [`desktopAppState.md`](desktopAppState.md) gives — it is a window fact.
  `pathux.window.<n>.template`, beside it, is the slug last applied: the pointer between the two.
  So `view.applyLayout` is neither mutating nor undoable, while `view.saveLayout` and
  `view.resetLayout` are both.
- **A template holds a recipe or a saved mesh, and which one says where it came from.** The shipped
  layouts are declarative recipes (`{split, at, first, second}` down to `{pane: [editor, …]}`)
  because **main writes those with no renderer in the loop** — scaffolding a project, ensuring an
  old one, resetting. `Save Current Layout As…` writes path.ux's own `simple.saveFile` blob instead,
  because an author drags borders into shapes no split grammar describes and per-pane state (the
  Documents editor's mode) has no recipe representation. A file holding both is refused.
- **`DEFAULT_RECIPE` is the Writing recipe**, so `buildDefaultScreen` and the Writing template
  cannot drift. A pane naming several editors comes up on the **first**: building one switches
  editors in turn, which would otherwise leave the last one showing.
- **A shipped layout with no file still works**, answered for by its recipe — so the feature works
  on day one in a project that predates it. `ensureLayouts` then writes any missing file and never
  overwrites one; putting an edited `writing.json` back is `view.resetLayout`'s job, not something
  opening a project does.
- **A layout is never merged.** `.gitattributes` marks `.vnstudio/layouts/*.json` `-merge`, so git
  conflicts the path and leaves *ours* in the worktree, unmangled — applying half a mesh would be
  worse than either side. The app used to read `git status` and refuse a mid-merge template by
  name; that went with the undo refactor, so it now opens the side git left there. See
  [`repos-and-commits.md`](repos-and-commits.md).
- **Undo comes back to the screen, not just the file.** Undo restores the template files, and no
  `view.*` command ran, so nothing pushes an effect. `renderer/pathux/layouts.ts` notices by
  **fingerprint**: it records what was applied and re-applies when main reports different bytes
  under the same slug. It seeds without applying at boot, so a border dragged last session survives.

## The shared graph canvas

Two editors draw a graph, and they share both the geometry and the surface. `renderer/graph/` is
the domain-free math — `layout.ts` (layered DAG layout), `edges.ts` (routes plus the polyline every
hit test uses), `hit.ts` (`pick`), `viewport.ts` (pan/zoom) — all pure, all tested.
`pathux/graph/canvas.ts` is the imperative surface over it. Plan:
[`../plans/archive/INDEX.md#story-branch-editor`](../plans/archive/INDEX.md#story-branch-editor).

- **One geometry, drawn and hit-tested.** `routeEdges` emits the SVG path and its sampled
  polyline together, so an edge can't be clickable where it isn't drawn. Slop is authored in
  **screen** pixels and divided by the scale before it meets world geometry — `pick` does that
  conversion itself so callers can't do it backwards.
- **Two co-transformed layers**: an SVG one for wires, an HTML one for cards and labels (typeset
  material, and SVG text has no wrapping). They carry the same viewport, via `transformOf` for
  SVG and **`cssTransformOf` for HTML** — the two syntaxes are not interchangeable, and CSS
  drops a transform it can't parse _silently_. The node layer is `pointer-events: none`; an
  element that needs a real DOM target (an inline label editor) opts itself back in.
- **A claimed gesture calls `preventDefault()`** — the canvas's protocol for "this pointer is
  spoken for". Without it the canvas pans underneath an unwire drag, the one gesture that starts
  over empty background. The React overlay ate the event and never had to say so.
- **One persistent overlay host**, handed to `setOverlay` once and mutated in place, so a pointer
  move repaints the verdict paths, the ghost wire and the carried card without rebuilding content.

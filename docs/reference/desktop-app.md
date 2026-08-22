# The desktop app

`apps/desktop` is an Electron app whose renderer is a **path.ux screen mesh**: a window
subdivides into panes, and each pane shows one **editor** over one `WorkspaceSession`. There are
no rooms and no modes-within-rooms — the author splits the window and puts the editors they want
side by side. Every action the app can take is a registered command
([`command-system.md`](command-system.md)); what it persists and where is
[`desktopAppState.md`](desktopAppState.md); what it plays is
[`playable-format.md`](playable-format.md). The rewrite that got here, step by step and with its
traps written down, is [`../plans/archive/pathux-desktop-rewrite.md`](../plans/archive/pathux-desktop-rewrite.md).

<!-- toc -->

- [Running it](#running-it)
- [Renderer layout](#renderer-layout)
- [The shell](#the-shell)
  * [Surfaces, shadow roots and stylesheets](#surfaces-shadow-roots-and-stylesheets)
- [Layout templates](#layout-templates)
- [The shared graph canvas](#the-shared-graph-canvas)
- [Branches](#branches)
- [Script](#script)
- [Convo](#convo)
- [Shot Coverage](#shot-coverage)
- [Tasks, Task Graph and Inspector](#tasks-task-graph-and-inspector)
- [Play](#play)
- [Wiki](#wiki)
- [Skills](#skills)
- [Documents](#documents)
- [Asset](#asset)
- [Project](#project)
- [System Prompt](#system-prompt)
- [Setup](#setup)
- [Remembered UI state (`desktop/session.json`)](#remembered-ui-state-desktopsessionjson)
- [Which project is open](#which-project-is-open)
- [Seeded workspace (`examples/mySampleRepo`)](#seeded-workspace-examplesmysamplerepo)

<!-- tocstop -->

## Running it

```sh
pnpm build:desktop && pnpm vndesktop --mock     # runs for real by default; --mock skips model calls
pnpm --filter @vn/desktop dev -- --mock         # live dev loop
```

`--project <dir>` overrides the workspace (`VN_PROJECT=<dir>` is an equivalent env fallback).

**Shipping it is a different command**: `pnpm package` builds an installer and `pnpm smoke`
runs the packaged binary to prove the two lazily-imported SDKs actually reached the app image.
Why it is built the way it is: [`../guides/toolchain.md`](../guides/toolchain.md#packaging-the-desktop-app) and
[`../plans/archive/packaging-the-desktop-app.md`](../plans/archive/packaging-the-desktop-app.md).

**`pnpm vndesktop` opens CDP on 9222**, like the dev loop — `scripts/vndesktop.mjs` sets
`VN_CDP_PORT` before launching Electron, because the switch can only be appended before
`app.whenReady()` and this is the entry point you reach for when you mean to drive the app from
`scripts/vn-cdp.mjs`. It announces the port on stdout; `VN_CDP_PORT=<n>` picks another and
`VN_CDP_PORT=` (empty) opts out. `pnpm --filter @vn/desktop start` still starts the same built
app with **no** port, as does a packaged build — see
[`command-system.md`](command-system.md#from-devtools-or-cdp).

**There is no stock menu.** `Menu.setApplicationMenu(null)` runs at `app.whenReady()` — the
File/Edit/View scaffolding named things this app has not got, and the shell has its own bar. Two of
the accelerators it took away are worth keeping, so both come back: **F12** opens DevTools, caught
in main on `before-input-event` because the renderer cannot open its own, and **Ctrl+Q** quits, in
the shell keymap and in the VN STUDIO menu. Quitting runs `window.close()`, so the wiki pane's
unsaved-draft guard still gets its say — main answers that guard's `will-prevent-unload` with a
modal, and `before-quit` holds the app open for the session store's last debounced write, bounded
at two seconds so a flush that never settles cannot wedge the quit.

**Live dev loop:** `pnpm --filter @vn/desktop dev` (`scripts/dev.desktop.mjs`) runs the three
moving parts together — esbuild `--watch` (main + preload), the Vite renderer server with HMR,
and Electron launched against it once it's up (`VITE_DEV_SERVER_URL`, which
`src/main/index.ts` loads instead of the built file). Quitting the window (or Ctrl-C) tears the
whole tree down. `VN_DEV_PORT` overrides the renderer port (default 5176); any args after the
script's own (e.g. `--mock`, `--project <dir>`) are forwarded to Electron, and `VN_MOCK`/
`VN_PROJECT` still pass through as env fallbacks. Main-process edits need a restart (the
renderer hot-reloads on its own). The dev loop defaults `VN_CDP_PORT=9222` for the same reason
`pnpm vndesktop` does — see [`command-system.md`](command-system.md#from-devtools-or-cdp).

**path.ux is a git submodule** at `vendor/path.ux` and carries a nested one of its own, so a
fresh clone needs `git submodule update --init --recursive` — and then
`pnpm --dir vendor/path.ux install`, because path.ux keeps its own lockfile and is not a pnpm
workspace member, so the root install does not reach it. `pnpm check:setup`
(`scripts/check-submodules.mjs`, also the first step of `@vn/desktop`'s `build`) fails by name on
either one rather than letting the resolver complain. Vite compiles path.ux's TypeScript source through an
alias — there is no prebuilt bundle to keep in sync — while `tsgo` checks us against
declarations regenerated from that same source on every `check` (`build:pathux-types` →
`apps/desktop/dist/pathux-types`, gitignored). `vendor/**` is excluded from prettier and eslint:
formatting the submodule under our config shows its gitlink dirty.

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
  `apps/desktop/src/shared/editors.ts` holds all fifteen (`branches`, `script`, `convo`,
  `timeline`, `tasklist`, `taskgraph`, `inspector`, `play`, `skills`, `wiki`, `documents`, `asset`,
  `project`, `systemprompt`, `onboarding`) with their titles. It is in
  `src/shared/` because
  `view.*` runs in **main** like every other command and builds its props from that list, while the
  renderer registers each editor class under the matching area name; `checkEditorNames()` warns at
  boot if the two ever disagree. Each entry also declares what it will show for a clicked
  document-tree node (see [Documents](#documents)), so a sixteenth editor that forgets to is
  visibly claim-less in the same file that names it rather than silently unreachable from the tree.
  The header bar is deliberately absent from the list — it is chrome,
  not somewhere the author navigates to.
- **An editor can be named without being listed** — `offered: false` on its entry, which today
  Setup and System Prompt carry. `view.open(editor='onboarding')` still works, the palette still finds it,
  and a saved layout that holds it still restores; what the flag removes is the two places an
  author *browses* editors. `OFFERED_EDITOR_IDS` narrows View ▸ Editors, and the shell installs
  `isOfferedEditor` as path.ux's `setAreaMenuFilter`, which is what keeps it out of the pane
  header's own change-editor dropdown — a menu path.ux builds from its registry rather than from
  ours, so nothing on our side could have filtered it. This is deliberately **not**
  `AreaFlags.HIDDEN`: hidden is a property of the editor, and being uninteresting to browse is a
  property of *this* application. `EDITOR_IDS` still covers all fifteen, so `view.*`'s props are
  unaffected. Once a Setup that is really a preferences window has somewhere to be, it stops
  being a pane at all and the flag goes with it; System Prompt keeps the flag for the opposite
  reason — it is a place to look when a turn misbehaves, and it will never be a place to work.
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
  path.ux DataAPI and the only thing a widget may bind to directly — document state never lands
  here, because `@vn/commands` is the write path.
- **Keyboard is per-area first.** path.ux routes a keystroke to the focused area's keymaps and
  falls through to the screen's, so the shell claims only `/` (palette), Ctrl+Z / Ctrl+Shift+Z /
  Ctrl+Y, Shift+Tab and Ctrl+Q (quit — it came with the stock menu, which main deletes). Escape is nobody's: a popup installs its own while it is up. An editor that
  wants a key for itself simply takes it, which the room shell's single window-level `keydown`
  could not allow — and an editor with an **open text row stops its own keydown**, or `/` opens the
  palette in the middle of a sentence.
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
  as a run that did nothing. Stop pipeline ends it after the task in progress. Its
  loop, its round cap and the one-candidate-per-unsettled-slot rule it approves by are in
  [`command-system.md`](command-system.md#the-registered-commands).
- **The Help menu is the only thing that ever starts an update check.** Check for Updates…
  (`app.checkForUpdates`) asks GitHub whether a newer release exists, compares it against
  `apps/desktop/package.json`'s version, and says so on screen — nothing is scheduled, so the app
  makes no request until an author asks for one. An update that *is* found also earns a durable
  notification, because that is the one verdict worth surviving the frame; "you are up to date" is
  said and not filed. The check is fired through `act` rather than a form: it takes no arguments
  the author would fill in, and `report` is what voices the answer. Full write-up:
  [`../plans/archive/in-app-update-checks.md`](../plans/archive/in-app-update-checks.md).
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
  during a gesture**, so nothing moves out from under the cursor mid-drag. Branches (below) and
  Script state their own version of this rule; it applies to any surface that grabs.
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
[`../plans/archive/layout-templates-and-the-view-menu.md`](../plans/archive/layout-templates-and-the-view-menu.md).

- **The template is the saved arrangement; the live mesh is not.** What is on screen right now
  stays per install in `desktop/session.json` under `pathux.layout`, for the reason
  [`desktopAppState.md`](desktopAppState.md) gives — it is a window fact. `pathux.template`, beside
  it, is the slug last applied: the pointer between the two. So `view.applyLayout` is neither
  mutating nor undoable, while `view.saveLayout` and `view.resetLayout` are both.
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
  conflicts the path and leaves *ours* in the worktree; the app then reads `git status` porcelain
  codes, lists the template with the reason, and **refuses to apply it by name**, quoting
  `git checkout --ours`/`--theirs`. Applying half a mesh would be worse than saying so. See
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
[`../plans/archive/story-branch-editor.md`](../plans/archive/story-branch-editor.md).

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

## Branches

`editors/branch.ts` — the story graph as index cards, on the canvas above.
`rooms/studio/branch/{graph,grab,compose,tween}.ts` are imported unchanged; the gesture state
machine that lived inside `BranchEditor.tsx` and was never tested is now `pathux/branch.ts` with
sixteen tests over the three drags.

- **No manual node positions, so every drag is semantic.** `Scene` has no `x`/`y` and layout is
  automatic: dragging a card's handle to another card wires it (`story.setChoice`/`setNext`),
  dropping a card on a wire splices it in (`story.spliceScene`), pulling a wire's arrowhead off
  its target unwires it. Each commits **one** command on release — a drag is continuous, its
  commit is discrete.
- **The gesture is judged once, at the grab.** `grabCard`/`grabHandle`/`grabArrow` capture every
  candidate's verdict from the same `branchConnect`/`branchSplice`/`branchUnwire` an agent would
  ask (`src/shared/interactions.ts` over `branchops.ts`), and `aim` is the one entry a pointer move
  needs — including the promotion from press to splice past `SLOP`, which re-aims in the same move
  so a big jump lands on the wire it ended over. The refusal shown mid-drag is the refusal that
  would happen.
- **`grab.ts` resolves the handle and the arrowhead before `pick` does.** Both discs straddle a
  card boundary, where `pick` answers "background" or "that card" — testing them first is what
  makes them the size they look.
- **Relayout is animated (`tween.ts`)** because a splice re-ranks the graph: the card does not
  stay where it was dropped, and without the transition that reads as breakage.
- **The edge label opens on `pointerdown`, not `click`.** Raw DOM has no reconciliation: a redraw
  between mousedown and mouseup destroys the button and the click never lands. The open `<input>`
  is held across redraws and re-`focus()`ed after each draw — the relayout tween runs `setContent`
  per frame — and the `blur` that re-parenting raises is ignored, or the field would commit itself
  away on the next frame.
- **Which scenes exist is decided here** (`compose.ts`): a scene made from nothing, and a scene
  removed. A new scene lands deliberately *unwired* — this is where you then wire it — and it has a
  second home in the script editor ("a scene after this one", which wires it too). Delete has only
  this one home: offering it from inside the prose of the scene being deleted is an invitation to
  lose work. Both are confirmed against `stack.check` on hover, so the refusal (`arrival is the
  entry scene — point start: in project.yaml elsewhere first.`) arrives before the click.
- **The selected scene is the shell's.** A card clicked here sets `ui.sceneId`, so the script and
  coverage panes follow, and it seeds the conversation composer with `Revise scene <id> — ` even
  when the selection did not move: clicking the card that is already open is how you ask about it
  again.

## Script

`editors/script.ts` — one scene's lines down the pane, typed: the heading, the lines with their
numbers and cues, the composer at the end. `rooms/studio/script/script.ts` (`scriptRows`, `keyAct`,
`stepsOf`, `checkOf`, `splitBoundaries`, `mergeTarget`, `dropTarget`, `nextEditing`) is imported
unchanged; the drag machine from `ScriptEditor.tsx` is now `pathux/script.ts` with six tests. Plan:
[`../plans/archive/script-composition-in-studio.md`](../plans/archive/script-composition-in-studio.md).

- **The model is a list of lines, not a buffer.** There is no document being diffed on save: a
  keystroke either belongs to the open row's textarea or names one command, and `script.ts` is the
  pure function that decides which. Enter commits the row (and, from the end of a line, opens a
  composer below — a paragraph is one `setLineText` plus one `insertLine` per line, each its own
  undo point); Backspace at the start of an *emptied* line is `story.deleteLine`; Escape discards.
- **The gutter counts the page; the id is in the tooltip.** `scriptRows` carries an `at` — the
  row's 1-based place among the scene's lines, counting past an open composer without renumbering
  around it — and that is the number on screen, readable at rest rather than only on hover. A line
  id is allocated once and persisted, so `L12` stops matching the count as soon as a line is
  inserted above it; it is what a refusal names, which is why the gutter's tooltip still gives it.
- **A composer row is not a line yet.** `story.insertLine` refuses empty text — an empty line has
  no lossless Fountain form — so Enter cannot create a line and let the author type into it.
  Committing the composer *is* the insert, and the id it minted is found by position in the
  reloaded scene (`insertedAfter`), never read back out of a message.
- **Attribution is a cue, not an id.** The cue picker writes `AIKO`, because a prose edit is decided
  against the scene as its file parses, where speakers are still cues — writing the resolved id back
  would rewrite `AIKO` as `@aiko`. The cast offered is the *project's*, since attributing a line is
  how a character enters a scene; an unresolved cue is offered verbatim so picking cannot silently
  discard one typed by hand.
- **Split, merge and new-scene are confirmed, not committed on click.** Each moves lines across a
  scene boundary or creates a file, and only the command can state the cost — so the strip holds the
  invocation, shows `stack.check`'s sentence (the detachment count a split would cause, the refusal a
  merge would give), and commits on a second gesture. The editable fields in the strip are the
  invocation's props. A new scene is **two** commands (`newScene` then `setNext`), because undoing
  the wire should not also delete the prose.
- **The slugline is the control that moves the scene.** The heading at the top of the page is a
  button that opens `openCommandDialog('story.setHeading', …)`, prefilled with the heading the file
  holds — which is why `SceneCoverage` carries a `heading` at all: the pane had only the raw
  `location` slug, and a control offering to edit a heading has to show one. It is a dialog rather
  than the strip's confirm because the cost depends on what is typed: `CommandForm` rechecks on
  every keystroke, so the sentence naming the shots that will be **re-rendered** (not drifted — a
  location is in a shot's task inputs) is on screen as the author types, along with the reminder
  that the prose still describes the old place and the agent is what rewrites it.
- **Affordances are the rules, not guesses at them.** A split is offered at every line but the
  first, since `splitScene` refuses a split that would empty the head; merge is offered only where
  the scene's single `next` is the boundary at the bottom of the pane; "continue to a new scene"
  only from a leaf, because putting a scene *between* two others is the branch editor's splice.
  A line drag is judged once at the grab against `scriptMoveLine.targets`, keyed by insertion point
  (`TOP` or the line to land after) — an insertion point `targets` never judged is a drop that would
  reorder nothing: no rule drawn, no sentence, no commit.
- **The redraw key excludes the draft and the pending act's props**, on purpose — path.ux calls
  `update()` every frame, so keying on what is being typed would rebuild the field under the caret
  once per frame and lose it. The open textarea and the split/merge strip's inputs are persistent
  nodes that mutate in place and only re-run `stack.check`.
- **Opening a row does not clear the notice.** The continuation an act opens carries on from that
  act, so what the command said about it is still the last thing that happened; only a row the
  *author* opens is a new act and clears it.
- **The scene is the shell's, not the editor's.** `ui.sceneId` changing from anywhere is a
  *reload*, not a redraw. So is a write that touched the scene's file, wherever it came from
  (`bridge.onWrote` + `touchesScene`) — but never with a row open, a structural act pending or a
  line held: re-reading would take the draft with it, and `⟳` in the bar is the deliberate version.
- **Under the page: the frames drawn from the scene**, the same `renderAssetStrip` Wiki and
  Documents draw, over `backlinks['scene:<id>']` and gathered by the **shot** each frame illustrates
  rather than by kind — so an author writing a line can see what the block it sits in already looks
  like. It sits below the page rather than inside it: art that scrolled away with the prose would be
  gone exactly when a long scene needs it most. Like the frames' own signal in Wiki it follows
  `onInvalidate`, since rendering a shot is not a write to the scene file, and a scene with no art
  says so — that is the ordinary state of a scene being written.

## Convo

`editors/convo.ts` — the vnauthor pane: the transcript, the three permission cards, the dialogue
box and the composer. The conversation itself is a **value**, `src/shared/convo.ts`, reduced from
the same `AgentEvent` stream `useAgent` reduced untestably inside a `useEffect`, with tests over
what each event does to it. It sits in `shared/` rather than the renderer because **main reduces
the same events** to write the transcript — see the threads bullet below.

- **The live conversation is a module subscribed at boot** (`pathux/agent.ts`, installed by
  `shell.start()`), not editor state, because the agent streams whether or not a convo pane is open
  and a pane opened afterwards has to show what was already said — including a second convo pane
  onto the same transcript.
- **A turn is a command.** `ask` runs `agent.run` through the bridge rather than a bespoke channel,
  so a turn the author types and a turn the palette runs are one act with one record.
  `plan:decision` stays a channel on purpose: it is the reply to a request main is already blocked
  on, not an act of its own.
- **What the author was looking at travels with what they asked.** The composer fills `agent.run`'s
  `scene` prop from `shell().ui.sceneId`, so the selection lands in the provenance record beside the
  question — it is part of what they meant. Main **resolves** it against the live index rather than
  trusting it (`focusOnScene`), so a selection pointing at a scene deleted since contributes nothing
  instead of a sentence about a scene that is gone; the prop defaults to `''` because the palette
  and CDP have no selection. It reaches the agent as a `context` message, not as part of the system
  prompt, and emits no `FeedItem` — a thread records what was said, not the context for saying it.
- **The agent's permission gate has three doors, and the pane answers all three.** Beside the plan
  card are a **question card** (`ask_user`: the question, a one-line box focused on arrival, Enter
  answers — an empty answer is allowed, because "nothing to add" is a real answer) and a **confirm
  card** for an always-confirm tool (`generate_image`, `edit_image`, `git_revert`, `git_restore`,
  a script-bearing skill's first run), with `Deny` first and unaccented. Both are the plan card's
  request/reply shape — `permission:ask` / `ask:answer`, `permission:confirm` /
  `confirm:decision` — over a promise main is parked on. Two scaffolds used to answer *for* the
  author: `ask` resolved to `''` (so the model was told `User answered:` and proceeded on a guess)
  and `confirmAction` to `true` (so every billed image call was auto-allowed). What the confirm
  card reads is an English sentence built in main by `toolconfirm.ts`, never the raw arguments.
  Teardown — the window closing, or `workspace.open` replacing the session mid-turn — resolves
  every parked door with its safe default rather than leaving the turn hung: no plan, no answer,
  no.
- **The agent may approve art, and what it may approve is decided by re-reading the author.**
  `approve_assets` is wired to a `ToolContext.approval` seam this app owns — `session.approvable()`,
  the same upstream-first walk the tree's *Awaiting approval* group is a projection of;
  `session.approveOne()`, which routes a portrait to `gate.approve` and everything else to
  `asset.accept`; and a **second, small model** (`TRIAGE_MODEL`, resolved by
  `session.triageBackend()` on the project's own key, `null` under `--mock`). That model is shown
  the author's own recent turns and the list — never a word the agent wrote — and answers which
  pictures the request covered, which is then narrowed again in code to hashes the list actually
  held. The author sees the resulting list on an ordinary confirm card before anything is written.
  Why a *second* model: this is a check on the agent, and running it on the model being checked is
  not a check. Full write-up: [`vnauthor.md`](vnauthor.md#approving-art-on-the-authors-say-so).
- **A shortlist is how a question is drawn, not a second door.** `ask_choice` reaches the same
  `permission:ask` / `ask:answer` pair with `choices` (and `multi`) alongside the question, so the
  card grows a column of full-width answer rows — an answer is read before it is clicked — above
  the text field it already had. What goes back is a string in every case, so a host that ignores
  `choices` asks the question as plain text: degraded, never broken. The card's three ways out are
  the list, the box (*"Or type an answer of your own…"*), and **Chat about this** — which *answers*
  with a sentence saying so rather than dismissing, because main is parked on `ask:answer` and a
  card that closed without one would hang the turn.
- **The card is a form the author pages through, and one question is a one-page form.**
  `AskRequest` carries `questions[]` and `ask:answer` carries `answers[]`, so a form is one parked
  turn and one line of the transcript each way — the questions together, then the answers numbered
  under them. Everything the author has filled in lives in an `AskForm` (`renderer/rules/askform.ts`,
  pure and unit-tested): the page they are on, what is ticked per page, what is typed per page. It
  is state on the editor rather than in the card, because a redraw must not clear what the author
  has chosen so far — and **every handler must read the live form, not the one it was drawn with**:
  typing deliberately does not redraw (that would take the caret away mid-word), so a Back/Next
  closed over the drawn form silently discards the words just typed. Found exactly that way,
  driving the card over CDP.
- **‹ Back / Next › sit on the left, away from the one button that ends the form.** A mis-aimed
  click near Submit must not submit half a form. For the same reason a pick on the last page does
  not send — it stands, and **Submit answers** is the only thing that ends a form — while a pick on
  any earlier page turns the page, and a lone single-pick question still answers outright, because
  there is nothing else to say. **Blank is a real answer**, so it never greys the button out: the
  Submit tooltip names the questions that will go back empty and what the agent will read them as,
  and it is recomputed on every keystroke, because a stale count is a lie about the thing the
  author just typed. **Chat about this** fills in only the questions still blank — declining to
  pick is a thing you can mean about some of a form and not the rest.
- **Clearing follows the command, not the button.** The store watches the registry through
  `bridge.onExec`, so `agent.newThread` empties the transcript identically whether the pane's
  **New** button ran it or the palette did — as do `agent.clear`, which has no button and is
  reached from the palette, and `agent.openThread`. Named gap: `window.vn`/CDP goes straight to
  main and none of them emits an event, so a clear run that way leaves an open pane's transcript
  standing.
- **A conversation is a thread, and it is written down as it happens.** Main appends one JSONL
  line per feed item to `vngen/state/threads/<id>.jsonl` — lazily, so an app opened and closed
  without a word writes no file — titled from the first thing the author said. The bar's
  **Threads** button opens path.ux's searchable menu (`startMenu(…, true)`) over `agent.threads`,
  newest first, the open one bulleted; a separator; **New conversation**. **Reopening one is
  read-only**: the pane replays the stored feed and the dialogue box says the agent has not been
  shown it, because restoring the model's own messages is separate work. The next thing typed
  therefore starts a new thread rather than continuing what was read. Undo cannot take a
  transcript back — its shadow snapshots exclude `vngen/state`, which is the point of putting
  them there.
- **The turns a decision hangs on are in it.** Main records both sides of every permission door at
  its own `permission()` seam — the plan with its steps and files, the verdict as the author's turn
  with whatever feedback came with it, a question with the shortlist it offered — and the loop files
  arguments the schema refused as a `blocked` event carrying what was passed. It records them
  **through the shared `convo.ts` reducers**, so the file and the screen still cannot drift: the
  renderer's own `permission:plan`/`permission:ask` handlers put the same items in the pane. A bare
  `decided(convo)` clears the card and writes nothing, because the renderer clears it knowing only
  `approved` while main knows the real decision. What this buys is `report.agent`: the diagnostic
  reads the thread, and a conversation that went wrong went wrong at exactly these turns.
- **The composer is built once and never rebuilt.** It is what the author is typing into and where a
  seed lands, so it outlives every redraw of the transcript above it — and it stops its own keydown.
- **An upload opens a conversation, and it opens on a question.** **Upload Files…** in the app menu
  runs `upload.pick`; once bytes have landed it puts the session in plan mode, closes the open
  thread and opens this pane with the command's own sentence in the dialogue box — *"Archived 3
  files to `archive/…`. What should I do with them?"* — and the openers under it as **chips**.
  A chip **fills** the composer and does not send: the point is to teach the shape of a useful
  prompt, and sending it removes the moment where the author edits it into what they meant. Nothing
  here is a feed item, so no thread file is written until the author actually says something, and
  `asked` drops the chips the instant one is. A cancelled dialog and a batch where every file was
  refused both leave the conversation in progress alone — the renderer keys on the `seed` the
  command emits only when something was written. See
  [`../plans/archive/upload-and-archive.md`](../plans/archive/upload-and-archive.md) and
  [`vnauthor.md`](vnauthor.md#the-archive).
- **A pane the author did not click is flashed, once.** `UiEffect`'s `view` carries `flash`, and
  `applyView` outlines the pane it landed in for 600ms after the mesh has settled. It is an overlay
  positioned over the pane's rectangle rather than a class on the `ScreenArea`: pane children paint
  over their own element's border, and the sheet that would style it lives in a shadow root this
  code does not own. A pane that was already open and already focused still flashes — that is the
  case the flag exists for, since nothing else about the pane would move.
- **This pane unnests.** In the room shell the branch and script editors were rendered *inside*
  `Convo`, which is why only one of them could be open. Here the conversation is a pane like any
  other and the author decides whether it shares the window with the page it is about.
- **`busy` is shell-wide, not agent-only**: a pipeline run disables the composer too. While it is
  set the dialogue box says `working` — one word, pulsing through `@keyframes`, built once with the
  stage. No verb list and no timer: a turn that says nothing for thirty seconds is otherwise
  indistinguishable from one that never started.
- **The bar carries the three session facts the turn depends on.** The header has the same
  PLAN ⇄ EXECUTE toggle, but this is the pane a turn is typed into, so this is the pane that has to
  say whether typing edits files. Beside it are the model menu (`agent.setModel`) and the effort
  menu (`agent.setEffort`), both from the one table in `@vn/types` — `TEXT_MODELS`,
  `effortChoicesFor`, `resolveEffort` and `supportsEffort`, which the `vnauthor` REPL's `/model`
  and `/effort` read too. **The effort menu offers what the model takes, and there is no
  `default` item**: it lists that model's own ladder plus `no thinking` where an explicit
  `thinking: disabled` is accepted, and it starts at `low` — see
  [`../plans/archive/deliberate-reasoning-effort-defaults.md`](../plans/archive/deliberate-reasoning-effort-defaults.md)
  for why the absent knob was the wrong default. A model with no reasoning knob at all greys the
  menu and says why; the setting is **kept** rather than cleared, so switching back to a model
  that honours it needs no second gesture — but a level the new model does not offer is stepped
  down, in main and in the mirrored shell state alike, by the same pure `resolveEffort`.
- **The bar also says what the conversation has cost**, in tokens the provider billed, `842` /
  `12.3k` / `1.4M` at a glance with the exact figures in the tooltip. It counts **calls, not
  turns** — a step the backend had to retry was paid for every attempt — and it reads `—` rather
  than `0` until a provider reports something, a mock backend and a backend that does not say
  being indistinguishable at zero. The receipt travels as an `AgentEvent` (`{ type: 'usage' }`)
  like everything else the agent does, from an **optional** `ChatBackend.messageWithUsage` each
  real backend derives its `message` from; a backend that keeps no receipt shows no total. It adds
  no `FeedItem`, so nothing about it reaches the thread on disk and a reopened conversation starts
  at zero. The label is retitled in place rather than keyed into `stateKey()`: rebuilding the bar
  would close the model or effort menu mid-turn.
- **The composer's stop button is shown only while a turn is in flight**, in `--vermilion`, taking
  Send's shape beside it, and `exec`s `agent.stop` through the registry — so interrupting from here
  and from the palette are one act with one record. An idle composer has nothing to interrupt, and
  a permanently greyed square would say otherwise.
- **The dialogue box is bounded and the transcript is what grows.** `.convo` is
  `grid-template-rows: 1fr auto`, so an unbounded line takes the pane and the transcript gets what
  is left — a long narration turn once cut it to a couple of hundred pixels and put the plan card
  off screen. `.dbox .line` is capped in `em` (so it tracks the prose size) and scrolls itself.

## Shot Coverage

`editors/timeline.ts` — a scene's screenplay down the pane with the shots covering it bracketed
beside it, and the wardrobe under it. It runs **vertically** because screenplays do.
The pure rules live in `renderer/rules/timeline/` (`drift`, `editing`, `wardrobe`, `busy`) and in
`@vn/scriptedit` (`coverage.ts`, `shotcreate.ts` — geometry and shot creation, shared with the
agent's tools); the state machine the React component kept in its own `.tsx` is now
`pathux/timeline.ts`, with its tests beside it.
Plans: [`../plans/archive/shot-timeline-editor.md`](../plans/archive/shot-timeline-editor.md) and
[`../plans/archive/line-editing-in-floor.md`](../plans/archive/line-editing-in-floor.md).

This is the only surface that edits `Shot.coversLines` directly — the `story.*` scene editors also
move it, as fallout of a split or merge rather than as the point — and `buildShotPrompt` ignores it,
so every edit here is free: nothing rehashes and no art is invalidated. That is also true of the
**prose** it edits, and there it is the problem rather than the feature — hence the drift marking
below.

- **One rule, previewed and committed.** `@vn/scriptedit`'s `coverage.ts` holds the whole
  gesture's logic — `setCoverage` (the rule), `spansFor` (the geometry) and `resolveDrag` (which
  lines a drop asks for) — run by the `story.setCoverage` command in main _and_ by the strip
  mid-drag, so a refusal shown while a handle is carried is the refusal that would happen. It
  lives in the package rather than in `src/shared/` because two hosts — this app and the
  authoring agent — enumerate targets and settle drags with the same geometry. Only `previewOf`
  stays in the renderer: it is ghost geometry for drawing, and main has no use for it. One
  command per drop.
- **The gesture is declared, not just implemented.** `timeline.cover` (in
  `src/shared/interactions.ts`) carries `<shotId>#start` / `<shotId>#end` and judges **every** row
  of the scene, so an agent can ask what a drag would do without performing one. The editor
  evaluates `targets` **once per grab** — state and carried are both fixed for the gesture — and
  indexes the verdicts by line id for its notice and its commit; it still calls `resolveDrag` per
  pointer move for the ghost's _geometry_, which a verdict does not carry. A row the drop would not
  change is dropped from the list rather than reported: "nothing happens" is what release already
  does silently.
- **A drag previews; it never re-lanes.** Lanes are greedy first-fit over shot _extents_, so
  re-deriving coverage per pointer move moves brackets the author never touched into other
  columns and changes the grid's column count under the cursor. The strip therefore draws
  committed coverage for the whole gesture and `previewOf` draws the proposal over it — ghost
  brackets in the dragged shot's **existing** lane, plus a tint on the rows it would claim and
  release. Same rule as the branch editor's animated relayout: layout changes on commit, not
  during the gesture. It also keeps the grabbed handle under the pointer. `update()` returns early
  while a gesture is live, because the row under the pointer is read from the DOM and rebuilding
  would replace the nodes the drag is aimed at; a selection the grab published lands on release.
- **Claiming a line takes it from whatever held it.** The exporter shows the _first_ shot
  covering a line, so double coverage silently hides the second shot's frame. Released lines
  become **gaps** — a vermilion gutter — rather than being handed to a neighbour: an uncovered
  line renders with no image, and revealing that is the point of the surface. But a claim that
  would leave another shot covering **nothing** is refused, because releasing does not give
  lines back: a drag that swept across a neighbour and returned would destroy it, and the return
  trip could not undo it. The dragged shot may still empty itself via the command DSL — only
  the side effect is refused.
- **Coverage is a set, never a range.** `spansFor` splits a shot into contiguous
  _segments_ and lanes shots by extent, so the decomposer's interleaving (plate takes the
  narration, each medium one speaker) draws as separate columns instead of nested brackets.
  Only a shot's outermost handles drag; a shot covering nothing is listed under
  `COVERS NOTHING` instead of being drawn.
- **A bracket's edges resize it; its body moves it.** The second gesture over the same brackets is
  `timeline.reorder` → `story.moveShot`: a shot's position _is_ where its covered lines sit, so
  reordering it moves those lines. The rule is `planShotMove` in `@vn/scriptedit`, over line ids and
  anything with a `coversLines` — which is why the strip can run the command's own rule against the
  `CoverageShot`s it already holds, with no `Scene` to fabricate. Targets are the _other shots_ plus
  `top`, aimed by the same midpoint rule the script editor's `dropTarget` uses, since N shots have N
  positions but only N−1 of them are named by another shot. A shot other shots draw inside is on
  screen in more than one place and has no single position, so it is refused by name. The drop is
  drawn as a rule at a row's edge rather than a ghost bracket: previewing the new position would
  mean moving the prose, and layout changes on commit.
- **A reorder is the one free scene edit, and says so.** No line id changes, so no coverage changes;
  every shot's covered lines keep their relative order, so no `proseHash` moves. Nothing drifts and
  nothing re-renders — only the order of `show` beats in the playable, which is the act the author
  asked for. Contrast `story.moveLine`, which moves a line _between_ shots and reports drift.
- **Rows are grid rows, so wrapped prose sizes itself.** The one thing measured is which row
  the pointer is over: a full-width `.tl-band` behind each row, reached by `elementFromPoint`
  once `.tl-grid.dragging` drops pointer events on the script and the brackets.
- **Clicking a line's text retypes it, one `story.setLineText` per commit.** The editor is a
  textarea in the row it replaces, auto-growing via a one-cell grid whose invisible `::after` sizer
  carries the same string — nothing is measured, so no frame exists where the layout disagrees with
  the caret, and the brackets follow because they are placed by grid row. Enter commits and Escape
  discards, and both **act** rather than calling `blur()`, which does nothing on an element that is
  not the active element. A draft that matches the line is not an authorial act and produces no
  record. Typing over a covered line reports what it will cost *before* the commit, debounced from
  the command's own `check`, and a refused commit reopens the editor with the draft beside the
  reason. Editing and coverage dragging are two modes over one grid: a handle's `pointerdown` is
  prevented and so cannot blur an open editor, which means the **grab is refused with a sentence**
  rather than the half-typed line being committed under the gesture. `timeline/editing.ts` is the
  pure half of the two-mode rule; retyping itself is `src/shared/lineedit.ts`, shared with the
  script editor so the two surfaces cannot disagree about either.
- **Shots are made and unmade here too, by the same rules the agent runs.** A third gesture over
  the same grid, `timeline.create` → `story.newShot`: dragging along a row's **gutter cell** — its
  own element at the row's left edge, so no two gestures share a pointerdown — sweeps lines into a
  new shot, judged once at the grab like the other two, with the verdict naming the id the write
  would actually mint (the persisted `nextShot` mark rides `SceneCoverage` for exactly this).
  Claimed lines are taken the way a coverage drag takes them, and the accepted sweep tints the
  rows it would claim. A `+ shot` control in the bar covers the no-gaps case, opening
  `openCommandDialog('story.newShot', …)` prefilled with the scene. Deleting is on the bracket: a
  right-click offers `story.deleteShot`, checked before it is drawn, and the refusal for the last
  shot is shown rather than hidden. The rules — `newShot`, `deleteShot`, the `nextShot` high-water
  mark — are `@vn/scriptedit`'s `shotcreate.ts`, so a shot made by drag and one made by an agent
  op are priced and refused by the same sentences.
- **A write in flight locks the strip, and says so after 150 ms.** Every command re-reads the
  whole strip when it lands, so a grab, a retype or a wardrobe pick started mid-write would be
  judged against rows the landing is about to replace. `rules/timeline/busy.ts` is the pure state:
  the lock is immediate, the notice row becomes an indeterminate progress bar carrying the
  command's own title ("Making shot…") only once the write outlives `BUSY_DELAY_MS`, and the bar
  resolves into the outcome notice — one row changing tone, not a second surface. The one sentence
  a locked control has — "Waiting for the last edit to land." — is both the refusal a blocked
  gesture is told and the tooltip every locked control carries meanwhile.
- **An undecomposed scene renders its script.** Correcting a line is exactly what an author wants to
  do *before* paying for art, so a scene with no `work/shots/<id>.json` draws the script column with
  no bracket columns and a note — not a refusal. The note carries the two doors out of it,
  `story.decomposeAll` and `story.newShot`, each an invocation checked before it is drawn: a door
  that would be refused is disabled with the refusal as its tooltip. Placing the first shot by hand
  creates the storyboard, which **ends decomposition for that scene** — the command's `check` says
  so before the write. Both the vermilion gap gutter and the uncovered count wait for a storyboard.
- **A frame that illustrates old prose is marked, not re-run.** Drift is derived in main
  (`driftOf`, surfaced as `CoverageShot.drift` — see
  [`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines)) and rendered as a state on
  the bracket: dashed sodium with `OLD PROSE` in the mono head, distinct from the vermilion
  `COVERS NOTHING`, which is a different problem with a different fix. Sodium because the authored
  side is what moved; on the head rather than over the image because that frame is still what the
  runner will show. A shot rendered before the hash existed reads a dim `PROSE?` — quiet, because the
  author cannot act on it and it clears itself at the next render. Acting on drift is
  `pipeline.run`'s job and the author's; this surface only tells the truth about it.
- **The wardrobe strip shows both levels at once, and every row names the level that answered.**
  Below the grid: a `WEARING` section with one row per cast member (the scene's `[[outfit:]]`
  marker) and, once a shot is selected, an `IN THIS SHOT` section with one row per subject. An
  author asking "why is she in the uniform" is asking about both at once, so no row ever says merely
  "inherited" — it says `"uniform" (character sheet)`, and the inherit option names what clearing
  would reveal. A select, not a drag: the choice is from a fixed set, and the set is the wardrobe the
  command would accept. Which rows exist and what each holds is `timeline/wardrobe.ts`, which calls
  `outfitFor` for both the value in force and the value a clear would reveal — the chain is never
  re-decided here, so the strip and the prompt cannot disagree. A shot decomposed before outfits
  were authorable carries an explicit outfit, so a marker cannot reach it; that is the one case the
  strip calls out (`hides the scene's "track" — clear it to let the marker through`).

## Tasks, Task Graph and Inspector

Three editors over the pipeline's state, linked by `ui.taskHash`: `editors/tasks.ts` (the flat
list), `editors/graph.ts` (the DAG, on the shared canvas) and `editors/inspector.ts` (one task in
detail). The list is better for scanning, the graph for structure; both are read-only, and the only
mutations from any of the three are `pipeline.run` and `gate.approve`. `rooms/floor/taskGraph.ts`
owns the derivation and `rooms/floor/attempts.ts` the review merge, both unchanged with their tests.
Plan: [`../plans/archive/task-dag-view.md`](../plans/archive/task-dag-view.md).

- **A task surface publishes `ui.taskHash`, and that is what the inspector watches.** The three
  authored ids answer "where in the story", which is not the same question as "which node" — a task
  naming neither scene nor character is still worth inspecting. The surfaces are linked by that
  hash rather than by either knowing the other exists, so a pick in the list and a pick in the graph
  drive the inspector identically. Clicking a task also publishes whichever authored ids it names,
  and a task naming none returns the selection **identical**: a click on an export cannot cost the
  author their place.
- **Two questions, two marks.** In the list, the ring is the task the inspector is open on; the
  tint is every other card the authored selection is about. The React board had one highlight and
  therefore could not say both.
- **A task that stopped says why on the card.** `Task.error` is the runner's own sentence for a
  `failed` or `needs_human` node, and the list is the surface built for scanning — so it is drawn
  there rather than one click away in the inspector, whose attempt stack answers a different
  question (what each *attempt* said) and is not where an author looking for the failure starts.
- **An empty list blames the control that emptied it.** There are four ways to hide a task and
  they overlap: `only done` keeps what succeeded, `only running` keeps what is moving, `only
  failed` keeps what stopped, Clear finished takes what finished out, and Clear's set is a
  superset of `only done`'s. So the sentence
  has to ask about Clear *first* — otherwise a list emptied by Clear says nothing has finished at
  the moment ten things have. `renderer/rules/tasklist.ts` holds both that and `showing`, because
  both are inferences and both were wrong; the pane keeps only the four control values. Clear's
  own tooltip while greyed is its refusal, per the tooltip rule.
- **Each status tick is its own, not a state of one control.** The statuses are pairwise disjoint,
  so what an author wants while a wave is in flight is the *running* half rather than a
  mode switch away from the setting they left on. Ticking two is a request for a task that is
  finished and still moving, which no task ever is — so the list shows nothing and `emptyBecause`
  names every tick that is on rather than blaming whichever one happens to be tested first. The bar
  is a **column of two rows** — what the list *is* on top, what to do about it underneath — because
  six controls and a sentence of counts in one row lose their last control in a half-width pane.
- **A floating task list opens with `only running` on.** A popup is raised over the mesh to watch a
  wave go by, so it starts narrowed to what is moving; in a pane the list starts on everything,
  which is what a list read for structure wants. `VnEditor.openedFloating()` is the hook that says
  so, called from `view.ts` after `popupArea` because path.ux sets `AreaFlags.FLOATING` after the
  editor's `init()` has already run. What it sets is an opening state and nothing more: the
  author's next click on the tick owns it.
- **`only failed` keeps `needs_human` too, and that is the point of it.** The list is where an
  author goes when a run did not produce what they expected, and a failure is a needle in a column
  of hundreds of `done` cards. A shot that exhausted its refinement attempts is the likeliest
  answer to “what went wrong”, so a tick named for failure that hid `needs_human` would hide the
  very thing it was ticked to find.
- **Clicking a task opens what it drew, accepted or not.** A task with an `output` *is* its
  picture, and the list is where an author watches one arrive — so the click that picks it also
  runs `view.open(editor='asset', where='elsewhere', subject=<hash>)`. Through the command rather
  than by setting `ui.assetHash` in the pane: the command is what finds or raises a pane and what
  records the act, and `elsewhere` keeps the list being scanned from being the pane that gets
  replaced. **Not only `done`**: bytes from a task that stopped are bytes nothing downstream may
  *use*, which is a different thing from bytes nobody may *look at* — and a rejected frame is
  exactly what an author clicking a failed card is asking to see. A `needs_human` shot carries its
  last rejected frame as `output`; a `failed` task that rendered something carries it on the
  attempt that rendered it, so `drewAsset` falls back to the last attempt with bytes. The card's
  tooltip says which of the two the click will do; a task that drew nothing selects as before, and
  the inspector follows.

- **A hash the cached status has never heard of is a re-plan, not a miss.** The inspector re-fetches
  once on that condition rather than polling, and says so on screen when the task is still absent.

The graph view exists because a literal rendering of `Task.deps` would be dishonest in three ways,
and each fix is a pure function tested in node:

- **The gate is not an edge.** P3 approval is a planner predicate (`sceneUnblocked`), so a
  halted run has nothing ready and no edge saying why. `barrierFor` synthesizes a barrier node
  and `taskGraphOf` positions it with **ranking-only edges** — handed to `layoutGraph` but not
  to `routeEdges`, so the rank is real and the wires are never drawn. It renders as a dashed
  rule across the layout bounds, carrying one approve button per pending character.
- **`deps` understates coupling.** A `shot_image`'s deps hold only its location plate; the
  subject portraits arrive through `inputs.refs`. `buildRefEdges` matches an `AssetRef.hash`
  back to the task whose `output` equals it — **deps solid, ref edges dashed**. A ref no task
  produced (an author-supplied image) is not an edge.
- **A slot and the task that fills it are one picture.** Planning is incremental, so shot tasks
  don't exist until their plate is `done` — but the *pictures* do, and `PipelineStatus.slots`
  carries every one of them in `SlotGraph.order` (upstream first, so the wire keeps the topology
  without shipping a `Map`). `slotNodeIds` keys a slot by its task hash where the planner actually
  emitted that task and by a `slot:<key>` id otherwise, so the future is never drawn twice — once
  as a promise and once as work. A computable `taskHash` the graph has never seen is still
  unplanned. `buildSlotEdges` adds only the couplings `deps`/`refs` cannot know, deduped by
  endpoints so a pair renders once, as the firmer of the two. An unplanned slot draws hatched and
  dashed and **is** addressable — clicking it moves the selection to its subject and, when
  something already fills it, its asset hash. Nothing estimates a count any more.

**Tidy is a second layout, not a second graph.** The graph view's `Tidy` tick re-runs
`layoutGraph` with `tidy: true`, which spends more ordering sweeps and then straightens each rank
with weighted isotonic regression (PAVA): writing a node's left edge as `u + prefix` turns "keep
the order the sweeps chose, keep the nodes apart" into "`u` must not decrease", so the pass that
pulls every node toward the mean of its neighbours has an exact optimum rather than an iterative
guess. Edges come out running more directly and long chains come out as columns. Nothing about the
graph changes — same nodes, same edges, same ranks, same order — only where they are drawn, and it
is deterministic, so the same graph in is the same coordinates out. It is remembered per pane
(`'tidy : bool'` on the editor's struct) and is part of the pane's `stateKey`, so ticking it
repaints without a re-fetch.

**The gate has one affordance, and it is the same one in both places.** A pending character is a
bar in the list and a button on the graph's barrier rule, and each opens `gate.approve`'s own dialog
with `characterId` prefilled — so `stack.check`'s refusal is printed before the author commits to
anything. Which portrait is left to the author, so that first refusal is always about the empty
`hash`: it names the unanswered field and how many are on file, rather than reporting a lookup for
a hash nobody has been asked for yet. The room shell had four partial gate surfaces; there is no
`view.room` to jump through any more.

**The inspector renders the P7 refine loop**, since `shot_image` folds generate → critique → refine
into one runner and a task list would otherwise show one node that made four image calls for no
visible reason. It stacks the attempts with the `Corrections:` clause that caused each next one in
the gap between them; `attempts.ts` is the pure half. Two contracts: `blocking` is computed exactly
as `mergeReports` (`@vn/providers`) computes it, so the UI can't disagree with the verdict the
runner acted on; and every attempt's bytes are in the store (`store.write` runs per attempt,
`store.accept` only on the clean one), so rejected frames are viewable over `vnasset://`. Plan:
[`../plans/archive/refine-loop-inspector.md`](../plans/archive/refine-loop-inspector.md).

## Play

`editors/play.ts` — the runner. `pathux/play/playback.ts` is the pure half (frames, navigation, the
save blob) with eleven tests beside it. The stage is deliberately raw DOM inside the column frame,
with path.ux widgets only for the chrome above it: a VN frame is a background, a portrait and a text
box, none of which is a control.

- **Live, no file needed.** The renderer calls the `story:play` IPC channel; the main process
  builds the playable in-process from the loaded model + store (`session.playable()`).
- **Image delivery — `vnasset://`.** A privileged custom protocol (registered in
  `src/main/index.ts`) resolves `vnasset://<hash>.<ext>` against **both** asset roots, in the order
  `AssetStore` reads them: base art (`assets/objects/`) first, then shot frames
  (`vngen/build/assets/`) — [`asset-stores.md`](asset-stores.md). So `<img src="vnasset://…">`
  loads content-addressed bytes wherever they live, which is what lets Documents draw a portrait
  and Play draw a frame through one path. This is the app's only image path.
- **The frame carries its shot, so Play stops being a dead end.** `show` beats gained an optional
  `shot` field (`@vn/types`, `@vn/export`), `framesOf` carries it down the frames between shot
  changes, and the editor publishes `ui.sceneId`/`ui.shotId` as the playthrough moves — so every
  other pane follows along. The React runner never did this; it is the one behavioural gain of the
  port, and it is why the schema changed.
- **No portrait over the shot unless the project asked.** A shot prompt names its own subjects,
  so the frame already shows the cast; the speaker's portrait is staged over it only when
  `story.play.json` says `portraitOverlay`, from `project.yaml`'s `portrait_overlay` —
  [`playable-format.md`](playable-format.md#contracts).
- **Playthrough.** State is a navigation stack (`{ sceneId, frameIndex }[]`, last = current):
  click / Space / Enter / → advances a beat; at scene end it shows choice buttons or auto-follows
  `next`; a leaf scene shows "The End". ← / Backspace rewinds. **Save / Load / Reset** persist the
  stack to `localStorage`, keyed by workspace title. The keys are the area's keymap, which runs
  ahead of the screen's and after path.ux's own textbox guard — so the React runner's tag-sniffing
  has nothing left to do.
- **A missing playable is a sentence on the stage, not a crash.** No project open, or one with no
  generated art, is an ordinary state for an author to read and act on.

## Wiki

`editors/wiki.ts` — one markdown document as text: a story-bible note, a character sheet, a
location sheet, whatever `ui.docPath` names. Read through `doc.read`, saved through `doc.write`,
which is what makes "the author saves it, and saving commits to git" true with no machinery of its
own ([`command-system.md`](command-system.md#the-doc-namespace)).

- **It is not a form over `Character`.** The requirement is that the author edits the markdown, so
  the front-matter sits in the box with the prose and the model's opinion of it arrives afterwards
  on the footer line. A sheet whose fields are half-typed **saves** and says so; only a save that
  would destroy identity — unparseable front-matter, or a dropped `type:` tag — is refused. All
  three rules live in the command, and the editor re-decides none of them.
- **Ctrl+S, never a timer.** Every `doc.write` is undoable, so it snapshots pre and post trees in
  every owned repo and the `Committer` then commits; save-on-blur would spend that on a focus
  change. A dirty badge shows the unsaved state, and the editor stops its own keydown — the screen
  keymap is a bubble-phase window listener, so otherwise `/` opens the palette mid-sentence.
- **The buffer is not authoritative.** `doc.read` returns the content hash it read at; `doc.write`
  carries it back as `seenHash` and a file something else rewrote underneath — `gate.approve`, the
  agent, an undo — is refused by **content** with a sentence, never overwritten. A file rewritten
  *identically* is not a conflict, which is why this is not an mtime check.
- **Unsaved text outlives the pane.** Drafts are held per path in a module-level map, so a pane
  that switched editors and came back keeps the edit; `on_remove` cannot veto its own removal, so
  the one remaining way to lose one — quitting — is caught by a `beforeunload` prompt. That guard
  needs main's `will-prevent-unload` listener to be worth anything: a `webContents` with none
  **cancels** the close silently, which is why the window once could not be closed at all.
- **A file rewritten underneath follows, unless it is being typed into.** `bridge.onWrote` reports
  every path a command or an agent tool wrote; a clean buffer re-reads, a dirty one does not, and
  its next save earns the changed-underneath refusal above. `⟳` in the bar is the manual half — it
  re-reads whatever the state, **discarding** an unsaved draft and saying so in the footer, because
  refusing would leave the author with no way back to what is on disk.
- **It does not read through `@vn/bible`.** That interface has no whole-file call and the absence
  *is* the guarantee ([`story-bible.md`](story-bible.md)); a human reading their own note on screen
  is not the agent's context window.
- **Under the text: what was drawn *from* this document.** The same `renderAssetStrip` the Documents
  panel uses, over `backlinks[pathIndex[docPath]]` — so the pane needs no convention of its own for
  turning the one thing it knows into a key. It follows `bridge.onInvalidate` rather than `onWrote`,
  because generating a portrait while a character sheet is open should make the portrait appear and
  generating is not a write to *this* file. It is bounded and never flexible: the document is what
  the pane is for. A page that is nothing's subject — a lore note, a `README.md` — gets the sentence
  saying so, which is the feature; **which** notes merely *mention* the subject is `bible.search`,
  ranked and budgeted, and is deliberately a different question.

## Skills

`editors/skills.ts` — the playbooks under `.aiagent/skills`, as the files inside them beside the one
being edited. It is the pane that shows what is **in** a skill: the document tree carries identity,
one row per skill ([`document-tree.md`](document-tree.md)), and the content is here.

- **The text half is `DocBuffer`, the same module Wiki's is** (`pathux/docbuffer.ts`). Every rule in
  the Wiki bullets above — the `seenHash` refusal, the draft that outlives the pane, the
  `beforeunload` guard, `⟳` discarding and saying so, a clean buffer following a write it did not
  make — is that module's and holds here unchanged. What this pane owns is the tree beside it, its
  expansion, and the hint. A skill file is tracked (`.aiagent` is not in `DEFAULT_IGNORES`), so
  Ctrl+S commits like any other document.
- **The hint is the feature, not decoration.** A skill is the one thing in the app the **agent** can
  author, and nothing else on screen says so. The sentence and its button therefore sit above the
  tree and are drawn whether or not any skill exists — an empty pane is exactly when they are
  needed, and every project created in the app starts with no `.aiagent/` at all.
- **The button opens the agent *form*, not a turn.** `openCommandDialog('agent.run', { input })`
  with a first sentence that ends mid-clause (`… It should: `), so the author finishes it before
  anything runs. `agent.run` is mutating and plan-first, so what comes back first is a proposed
  plan they still approve — which is why the tooltip promises the form rather than a file.
- **Its own channel, not a filter over the file tree.** `workspace:skilltree` walks
  `.aiagent/skills` alone: the file tree is capped across the whole project, so on a large one the
  skills could be truncated away and this pane would draw nothing with no way to say why. No skills
  directory at all is `[]`, and the tree says "No skills yet." over the hint that fixes it.
- **Two watchers, both disposed on remove.** `onWrote` for the file in the box — `create_skill` and
  `edit_skill` from Convo, `doc.create kind='skill'` from the tree, an undo — and `onInvalidate` for
  the tree beside it, because a *new* skill changes the tree without touching the open file at all.
  The agent's writes are not commands, so `onInvalidate` is what covers them; it is why `edit_skill`
  returns its written paths.
- **It follows `ui.docPath` only under `.aiagent/skills/`.** One selection serves every pane, so a
  wiki note picked elsewhere must not blank this one. Its own tree clicks publish `ui.docPath` like
  any other pane, which is also how a skill clicked in the document tree lands here.
- **No asset strip, deliberately.** Every binding in the manifest names a character, a location, a
  scene or a shot — nothing binds to a skill file and nothing ever will — so `renderAssetStrip` here
  would be permanently empty, which is worse than absent.
- **It remembers no fields.** Its subject is the shared selection and its expansion is a view of a
  tree the next workspace may not have, so `registerEditor(SkillsEditor, 'vn.SkillsEditor')` takes
  no field list.

## Documents

`editors/documents.ts` — the sidebar, as a pane rather than as fixed chrome, so it can be torn out,
put on either side, or opened twice. The shape it draws is built in main
([`document-tree.md`](document-tree.md)); the rules on top of it — flatten to rows, toggle, which
selection field a node names, which entity the panel is about — are pure in `pathux/doctree.ts`
with tests beside them.

- **Two trees, one flattener.** Document mode draws `workspace:doctree` — Story → scenes → shots,
  Characters, Locations, Wiki, Assets by kind; file mode draws `workspace:filetree`, every file on
  disk. A file tree is a different **source**, not a different kind of tree, so the header toggle
  buys a second fetch and no second renderer. The mode is a per-pane field declared through
  `registerEditor(cls, name, fields)`, so two sidebars can differ and each remembers its own.
- **It owns no selection.** A click publishes `ui.sceneId` / `ui.shotId` / `ui.characterId` /
  `ui.docPath` / `ui.assetHash`, which every other editor already observes — so the tree steers the app without
  knowing what is open, and a scene picked in Branches lights here without either editor knowing
  the other exists. A node that names nothing (a grouping, a truncated `more`) returns the very
  same selection, so opening a branch never costs the author their place.
- **Backlinks under the tree**, from `DocTree.backlinks[nodeId]`: the sheet (said as "in the story
  bible" when it lives under `wiki/`), the art as a `renderAssetStrip` grouped by kind with the
  gate's accepted mark, and the scenes and shots the entity is in. Every row navigates — a scene row
  publishes the selection, the sheet row opens Wiki on it, a thumbnail routes to Asset through the
  same rule a tree click uses. It is here rather than in the Inspector because the Inspector's
  subject is `ui.taskHash`, machine identity on a different axis.
- **Clicking a node shows the editor that answers for it**, and which one is a table lookup rather
  than a score. Each entry in `src/shared/editors.ts` declares a `claims` predicate over the node —
  `primary` or `secondary` or nothing — and `pathux/route.ts` ranks the claimants by **visibility
  first, tier second**, breaking a tie on `EDITORS` order. The consequence is deliberate: a visible
  *secondary* beats a hidden *primary*, so clicking a scene with Shot Coverage open and Script
  closed lands in Shot Coverage, which is where the author is already looking.

  | node | primary | secondary |
  | --- | --- | --- |
  | `scene` | Script | Branches, Shot Coverage |
  | `shot` | Shot Coverage | — |
  | `character`, `location` | Wiki — *only if the entity has a sheet* | — |
  | `wiki` | Wiki | — |
  | `skill` | Skills | — |
  | `file` | Skills under `.aiagent/skills/`, else Wiki when the path reads as text | — |
  | `asset` | Asset | — |
  | `branch`, `assetkind`, `wikidir`, `dir`, `more` | — | — |

  The `file` row is the one place two editors claim the same node as `primary`: a `SKILL.md` is
  text, so Wiki claims it too. The tie breaks on `EDITORS` order, and the `skills` entry is listed
  **before** `wiki` for it — a skill opened in a plain text box would let an author edit the
  front-matter the Skills pane answers for. Visibility still outranks that, and correctly so: with
  Wiki up and Skills closed the click lands in Wiki, where the author is looking.

  A claim is a predicate over the **node**, not a map from its kind, for two reasons the table
  shows: an entity with no sheet has nothing for Wiki to open, and in file mode a `.png` is a
  `file` like any other — pointing Wiki at one would have it `doc.read` a binary. The Inspector
  claims nothing on purpose: its subject is `ui.taskHash`, and no tree node names a task.
  A winner already up is asked for `here` (a focus); one that is not gets `elsewhere`, which is
  what keeps the sidebar from replacing itself with the thing it named. Selection is published
  **before** the open, always — a shot needs two fields to name it and `view.open` carries one
  string, so an editor whose subject cannot travel opens on the selection it already sees.
  A node that claims nothing keeps today's behaviour: the click selects, and a grouping expands.
- **New… scaffolds a document and opens it.** Kind plus a name — character, location, page or
  skill — straight into `doc.create`, which shares `newCharacterTemplate`/`newLocationDoc`/
  `newSkillTemplate` with the agent's create tools — one authorial act, one answer. A character's is a **full sheet of placeholders**, because the shape is best learned by
  editing it; its `palette` is empty under a YAML comment saying what a palette is and to ask the
  agent for one, since a colour name will not parse and so cannot be exampled. That comment is why
  the template is text rather than a `FrontMatterDoc`, and why it does not survive the first edit.
  The tree refetches on any successful mutating command (`onExec`) and on undo, so the new
  file is there without a remount. That refetch is deliberately coarse: a tree is one cached
  `loadProject` away, and a stale tree is worse than a redundant fetch.

## Asset

`editors/asset.ts` — one generated asset: the bytes, the prompt that made them, and the art notes
that would make them differently. Its subject is `ui.assetHash`, which the documents tree publishes
when an asset leaf is clicked; the rules on top of it (which approve command applies, the badges,
the failure and drift notes, which prompt to show) are pure in `renderer/rules/assetview.ts` with tests beside
them. Plans: [`../plans/archive/asset-names-and-the-asset-editor.md`](../plans/archive/asset-names-and-the-asset-editor.md)
and [`../plans/archive/on-demand-concept-images.md`](../plans/archive/on-demand-concept-images.md).

`art.generate(sentence=…)` is the other way in: it draws a concept and, unless told not to, opens
it here — so asking for a picture ends looking at it. `art.redraw` does the same with the sketch
it produces.

- **The prompt is drawn as the clauses it is made of.** Each `PromptChunk` the builders derived is
  one card, in the order it is sent, tagged with its category and voiced by where it came from —
  `--sodium` for a sentence an author wrote somewhere, `--signal` for scaffolding the builder
  supplies. A card can be muted, replaced, appended to, or dragged to another position, and one that
  came from a document offers a `⇱` to it. The art notes are still the append-only half beside it,
  and both are authored input: setting either re-keys the task, so "regenerate" is the pipeline that
  already exists rather than a second path to the image model. See
  [`../plans/archive/chunked-prompts.md`](../plans/archive/chunked-prompts.md).
- **A reference image lives on the card of the clause it is evidence for.** Under each card is a
  strip of thumbnails (`vnasset://<hash>.<ext>`); a click opens that picture `elsewhere` — this pane
  is showing what the reference is *for* — and `×` runs `prompt.dropRef`. A chip on a muted clause is
  drawn muted with it, because muting the clause stops sending its references too, and one whose
  slot has moved is marked `drift`. `asset.upload` brings an outside image in; `prompt.addRef` takes
  either its hash or a slot address (`plate:cafe/night`).
- **A suspended asset says what moved rather than re-rendering.** The `suspended` badge and
  `driftNote`'s sentence come before the ordinary staleness one, because it is the stronger claim:
  the words may still be right and a picture this was drawn *against* is what changed.
  `prompt.repin` clears it, and `regenerate=false` keeps the bytes.
- **A picture the pipeline gave up on says why, in the pane showing it.** `AssetInfo.failure` is
  read off the slot's identity as the project states it today, and off `asset.sourceTask` only when
  that identity is not terminal. The two part company after an art-notes edit: the slot re-keys, a
  run fails on the new task, and the last good render is still what is on screen — so the band says
  a re-render failed and names the frame the author is looking at, and `driftNote` stands down,
  because the failure already reports that the project has moved on. `failed` quotes the
  retry budget (`config.max_task_attempts`) against the attempt records that carry an error;
  `needs_human` does not, since a P7 refine pass records an attempt without one. **Show task**
  opens the task that gave up, which is not always the one these bytes came from.
- **Regenerating a failed re-render asks for that render rather than the one on screen.** An
  authored change re-keys the slot, so the pipeline re-renders it as a matter of course: a fresh
  node is planned with a retry budget of its own, and that is how a failed or flagged picture is
  normally recovered (packages/pipeline/src/tests/rerender.test.ts). One edit does not get that.
  An edit that lands the slot back on an identity which already spent its budget finds it terminal,
  because `requeueFailed` counts a task's error-carrying attempts for the life of the project.
  `asset.regenerate` is what asks again. It refuses a `stale` asset, whose own task is an orphan,
  except when the slot's current identity is `failed` or `needs_human` — then it queues that task,
  and the picture on screen stays until the new render lands.
- **The mode strip says which text is actually being sent** — the clauses, a prompt the author wrote
  by hand, or one the agent condensed. Condensing is a button beside it; a condensation whose
  clauses have since moved is **held**, and the banner over the cards says so rather than the pane
  quietly re-rendering the picture. `prompt.check`'s answer rides along: a clause a custom or
  condensed prompt no longer appears to say is marked, as a prompt to look rather than a verdict.
- **A reorder is judged on the grab.** `promptReorder.targets` runs once when a card's rail is
  grabbed and every pointer move is a lookup, so the insertion rule and the sentence in the footer
  are the verdict the drop would actually get; nothing moves until pointerup. `Alt+↑`/`Alt+↓` runs
  the identical lookup without the pointer.
- **A concept has no builder under it, so it gets a box rather than cards.** Nothing derives it, nothing rewrites
  it, and no task hash contains it — it is a root asset, so the pane gives it a Redraw box holding
  the recorded prompt whole (the style preamble and the framing sentence survive an edit by
  default) and `art.redraw` draws it again as a **new** sketch beside the original. The header bar
  carries **Redraw** in place of Approve and Regenerate rather than greying them out: a concept is
  approved by nothing and planned by nothing, so neither could ever act on one, and a dead pair
  beside a working button reads as breakage.
  `promptEditable` in `renderer/rules/assetview.ts` is the one rule both halves read, and its
  refusal for a derived kind points at the clause cards as the way to move that prompt instead.
- **One box per rung that actually applies**, widest first: the character or location, then the
  outfit or variant, then the shot. Each commits on Ctrl+S or on leaving the box, through
  `art.setNotes` with the tree's own `kind:key` target vocabulary — so the same edit is reachable
  from the palette, from CDP and (for the entity rungs) from `vnauthor`.
- **It shows what is derived today, not only what was recorded.** `asset.info` re-derives the prompt
  for the same binding and compares it with the one the bytes carry; a difference is the `stale`
  badge and a banner, which is exactly the state an art-notes edit leaves behind until the next run.
- **Approve says which command it would run.** A portrait goes to `gate.approve`, because that is
  the command that also writes `character.md` and `approved.png`; everything else is the generic
  `asset.accept` across both roots. A portrait whose character the project has lost is **refused by
  name** rather than accepted through the generic door, and so is a concept: nothing downstream
  consumes one, so there is no question for accepting it to answer. An **upload** is the mirror of
  that case — a concept has no downstream, an upload has no upstream — so the bar reads `uploaded`
  where the pair would be: nothing generated it, so there is no work to bless and no task to requeue.
- **Approval flows upstream first, and the frontier is drawn under the picture it belongs to.** A
  **DRAWN FROM** strip lists `AssetInfo.prereqs` — everything these bytes rest on, in the order the
  task fed them to the model — each row saying whether it stands. While any is pending, Approve is
  greyed and its tooltip is the refusal *verbatim*; the strip repeats the same sentence out loud, so
  nobody has to hover a disabled button to learn which row is holding it up. The sentence is main's:
  `previewAccept` refuses `asset.accept` with the identical one, because a greyed button the command
  itself would honour is a lie about the rule, and the palette, the agent and CDP all reach the
  command directly. **This is deliberately not the reference strip**: that lists the bytes pinned to
  one prompt clause — evidence, per clause, detachable, opened *elsewhere* because it is a second
  thing to look at. This lists what the whole picture rests on; nothing detaches, and a click
  retargets **this** pane, because the job is to walk up the chain approving as you go and a new pane
  per hop litters the mesh. One `← back` chip makes that walk reversible, and it clears itself when
  the subject changes any other way. A prerequisite whose bytes the manifest has lost is a disabled
  row whose tooltip is its own refusal.
- **A concept gets a Promote strip instead, and only a concept does.** It names the location the
  sketch is bound to, takes a variant id, and runs `art.promote` — the variant joins that location's
  sheet if it is new, the bytes become the plate, and the next run adopts them. `promoteAction`
  decides whether the strip is drawn at all, so a character concept never offers a control that
  would walk around the approval gate. What is half-typed there survives a background refetch of the
  same asset and is dropped when the pane moves to another one.
- **A picture the project planned gets a Replace strip, and the slot is never typed.** An author who
  paid someone to clean a frame up has bytes better than any run will produce, so
  `asset.replace(hash=…)` opens an image chooser and makes what comes back that slot's output —
  `asset.upload` and `asset.adopt` as one act, with the slot read off the asset on screen rather than
  spelled by hand. `AssetInfo.slot` is what the strip is drawn from, and it means "the slot these
  bytes fill **now**": absent on a concept and an upload (nothing plans those), and absent again once
  a later render has taken the slot over, so a superseded picture never offers to supersede the one
  that replaced it. `replaceAction` declines a `portrait:` slot by name — replacing a look is
  approving one, and that is `gate.approve`'s — which is `adoptionForSlot`'s `GATED_SLOT` said as
  layout. The hint says what it costs: the render it stands in for keeps its bytes in the store, and
  the next run adopts the author's picture instead of drawing one. Nothing is auto-accepted, and the
  pane moves to the new hash afterwards, because the bytes it was showing are no longer the slot's.
  See [`../plans/archive/adopting-an-uploaded-asset.md`](../plans/archive/adopting-an-uploaded-asset.md).
- **Show task hands off rather than duplicating.** `ui.taskHash` is published and the inspector is
  opened `elsewhere` — attempts, the refine loop and the reviewer's verdict are its subject, and
  this pane does not re-render them.
- **A write anywhere re-reads, unless a box is dirty.** `onInvalidate` covers this pane's own edit,
  the agent's, and an undo of either; a refetch under a half-typed note would eat it, so an
  in-progress rung suppresses it until it commits.

## Project

`editors/project.ts` — `project.yaml` as the run reads it, and the twelfth editor. It is a
**singleton pane**: a workspace has one config, so it has no subject, is absent from `SUBJECT_OF`,
and `view.open(editor=project)` carries nothing. It is where an asset's style clause leads: the
`⇱` on that chunk in the Asset pane opens this editor `elsewhere` and scrolls to the field.

- **One field is editable and the rest are shown.** The art style is the sentence every image prompt
  opens with, so it is the setting an author reaches for repeatedly; the model ids and the image
  params are read-only here because changing one is a deliberate, file-level act and a pane that
  made it a two-click affair would invite it.
- **Applying is `project.setArtStyle`**, which confirms — it re-keys **every** image task — and says
  how many before it writes. `withArtStyle` splices the line into `project.yaml` rather than
  re-serializing it, and it is not quite `withStartScene`: prose may already be a block scalar, so
  the entry it replaces is the header line plus the indented lines under it, and a trailing blank
  line belongs to the entry only when indented text follows it. Comments, key order and the author's
  own quoting survive, and undo restores the file byte-for-byte.
- **It reads through `project.info`, not a bespoke channel.** Every other editor reads through a
  non-mutating command; a twelfth IPC channel for the twelfth editor would have been the first
  surface in the app reaching around the registry. `project.info` deliberately omits the `keys`
  block: those are env-var *names* and safe to print, but a settings pane listing them is one
  screenshot away from looking like it lists their values.

## System Prompt

`editors/systemprompt.ts` — the system message the agent's next turn will carry, in its sections.
The pane an author opens when a turn misbehaves and the question is "what did it actually read?".

- **Named but not listed** (`offered: false`, above). It is somewhere to look, not somewhere to
  work, so it is reached by name: `view.open(editor='systemprompt')` from the command palette. A
  saved layout that holds it still restores it.
- **It asks main for the prompt rather than reassembling it.** `agent:system` answers with
  `systemSections(await loadContext(dir))`, the section list, the context files that fed it and the
  bound model id. That is the whole point of the pane: `runAgent` calls
  `refreshSystem(systemSections(await loadContext(...)))` before every turn, so what is on screen
  is the assembly that ships. A second implementation in the renderer could disagree with the one
  that runs, and would be wrong in exactly the case being investigated. It answers before an agent
  exists, too — the prompt is a property of the workspace, not of a conversation.
- **The sections are the sections.** Built-in, then the generated `PROJECT MAP`, then the author's
  `PROJECT CONTEXT (AICONTEXT.md)` — drawn one card each, in order, with the authored one warm,
  because it is the one part a reader can go and change. `Copy` puts the **join** on the clipboard,
  not the card under the cursor: what the model receives is one string.
- **The separator is written twice, and a test keeps the two equal.** `renderer/rules/
  systemprompt.ts` is in the browser bundle and `@vn/authoring` is node-side, so `joined` restates
  `joinSections`'s `

`; its test asserts the two against each other. The scale line
  (`N sections · N lines · N chars · ~N tokens · model`) counts the join rather than the sum of the
  parts, which would be short by one separator per section, and the token figure says `~` because
  it is characters over four.
- **It follows invalidation like every other pane.** Two of the three sections are files in the
  workspace and `update_context` rewrites one of them mid-conversation, so the pane re-reads rather
  than showing whatever was true when it was opened; `⟳` is there for a file that moved underneath.
  A slow read that lands after a newer one is dropped by a rising token.

## Setup

`editors/onboarding.ts` — the answer to "I installed this, now what".
It is the one pane an author is expected to visit once: how to get a key from each provider, which
of theirs are set, and a box to paste one into. It is a **singleton** like Project, and it is
`offered: false` (above), so it is named but not browsable and it claims no document-tree node —
no node names an API key, and a click that opened this pane would have landed on a subject it
knows nothing about.

- **The walkthrough is [`../guides/api-keys.md`](../guides/api-keys.md), rendered — not retyped.**
  `app.keyGuide` reads that one file through `main/resources.ts`, which tries `$VN_RESOURCES`,
  then Electron's `process.resourcesPath` (where `extraResources` puts it in a packaged build),
  then the repo root — so
  the same command answers from a checkout and from an installed app, and the pane cannot drift
  from the doc because there is nothing to drift from. `shared/markdown.ts` parses the subset the
  file uses (headings, paragraphs, lists, tables, fenced code, and inline `code`/**strong**/links)
  and `shared/apikeys.ts` projects it into a `KeyGuide`: an intro, one section per vendor keyed by
  its heading slug, and the remaining sections as notes. `keyGuideProblems` names what a section is
  missing rather than throwing, so a doc edited badly degrades to a pane that says so.
- **A vendor's metadata is a yaml fence in its own section** — the env var name, whether there is a
  free tier, and the console/docs/billing URLs. That is what makes the file both readable prose and
  the pane's data source; there is no second table to keep in step with it.
- **The renderer never hands the OS a URL.** `app.openKeyLink(provider, link)` names a *field* —
  `GUIDE_URL_FIELDS` is `console | docs | billing`, the entire set of pages this app will ever
  open — and main looks the address up in the guide it shipped with. So the pane cannot be talked
  into opening an address it was handed, and inline prose links render as a non-navigating
  `span.ob-link` with the address in the tooltip, because there is no navigation inside a shadow
  root either way. A field the guide leaves empty greys its button with that as the reason.
- **Status is `project.keyStatus`, which never says the key.** Per vendor: whether one resolved and
  **which of the four rungs answered**, by name — an environment variable, this project's `keys/`,
  the enclosing repo's, or the user-level one. A set environment variable shadowing a file that was
  just written gets its own warning line, because "I pasted it and nothing changed" is otherwise
  unanswerable.
- **The paste box is `project.setKey` with a scope**, defaulting to **every project** — the answer
  that is right the second time. The input is `type="password"`, stops its own keydown so `/` does
  not open the palette, and is cleared whatever the answer; the value reaches one file and nowhere
  else, and the command history records `<secret>`. A line under the box names the file it will be
  written to before it is written.
- **Test key is `project.testKey`**, one small real call, because a key can resolve and still be
  revoked, mistyped, or on an account with no credit — and without it the first news of that is a
  run failing much later. It is a non-mutator that declares a `check` anyway, so the greyed button
  shows its own refusal verbatim: mock mode makes no calls, or no key resolves yet.
- **Every control carries a tooltip and every disabled one carries its command's refusal.** Both
  buttons and the Save button read `check(...)` rather than deciding for themselves, so the pane
  cannot invent a sentence the command would not have said.
- **It is reached from File ▸ Set Up API Keys…**, which opens the pane `elsewhere` rather than
  `project.setKey`'s bare form: a box asking for a credential is no use to someone who does not
  have one yet, and the pane is that box with the steps above it. The form is still in the palette
  for anyone who only wants it. On a **first run** with a key missing, `noticeMissingKeys` posts one
  durable notification linking here — skipped under `--mock`, which calls no provider, and posted
  at most once per project, guarded by scanning the log for an existing notification pointing at
  this editor, since the notification log dedupes by id rather than by message.

## Remembered UI state (`desktop/session.json`)

The layout, the selection (and anything else the shell should remember) live in a flat key/value
file the main process owns — `apps/desktop/src/main/sessionstore.ts`, **global per install** rather
than per workspace. It sits at `<userConfigDir()>/desktop/session.json` — the same home
`@vn/config` gives API keys (`%LOCALAPPDATA%\vnauthor` on Windows), so user-level state has one
address rather than two. `VN_DESKTOP_HOME` relocates it, which is how a test gets its own; a
development run deliberately shares the installed app's, because a second home is how a recents
list quietly forks in two. It is emphatically **not** a path under the bundle: a packaged app's
`__dirname` is inside `app.asar`, which is a *file*, so a store derived from it fails `ENOTDIR`
before the first window and the app hangs with nothing on screen. Full write-up:
[`desktopAppState.md`](desktopAppState.md).

- **Two keys, debounced.** `pathux.layout` is the nstructjs-serialized screen (JSON, magic `VNSC`,
  written through path.ux's own `simple.saveFile`, which stamps the struct schema into the blob so a
  layout written before path.ux changed a `STRUCT` still reads back). `pathux.selection` is the
  three authored ids. Both flush 400 ms after the last change and again on `beforeunload`, since a
  quit does not run the debounce.
- **Nothing here may block boot.** A layout that will not load — corrupt, or naming an editor this
  build has not got — is discarded with a warning and the default screen takes its place. A missing
  or unreadable file reads back as `{}`, which is also how a hand-edited file with a UTF-8 BOM
  behaves; quietly, so do not debug through one.
- **Synchronous first read.** The preload does one `sendSync('session:snapshot:sync')`, so the
  remembered layout is the first thing painted rather than a jump away from the default.
- **Multi-instance by construction.** Nothing stops two app instances sharing the file, so a
  flush takes a `mkdir` lock (stale ones, >5s, are broken), re-reads the file _inside_ the lock,
  and applies **only its dirty keys** over what it finds. Different keys from different
  instances both survive; the same key is last-flush-wins.

## Which project is open

One workspace at a time, resolved in `app.whenReady()` before the asset protocol or any session
exists — but no longer resolved *forever*. Plan:
[`../plans/archive/project-bootstrap-and-workspace-picker.md`](../plans/archive/project-bootstrap-and-workspace-picker.md).

**Precedence at launch**, first hit wins:

1. `--project <dir>` / `VN_PROJECT`.
2. The most recent remembered project that still exists.
3. **The directory picker** — the requirement's own "the app requests the user to pick a
   directory", shown on a genuine first run only. `VN_NO_PICKER=1` skips it.
4. The seeded sample below, which is also what cancelling the picker gets you.

Whatever is opened is remembered, the sample included, so the picker asks once per install and
not once per launch. The list lives at `workspace.recent` in the global session store — it has to
be readable before any project is open, which is why it is per install rather than per project.

**Opening another project** is `workspace.pick` (the dialog) or `workspace.open(path='…')` (the
scriptable one). A directory that is not a project yet *becomes* one: `openWorkspace` writes a
one-line `project.yaml` — `title` is the only key without a default, and an empty project is
empty, not a copy of the sample — then `ensureRepo` initializes a repo and commits whatever was
already there. A `project.yaml` that will not parse is refused rather than opened.

`workspace.open`'s check says which of the two is about to happen ("Opens *The Transfer
Student*" vs "Creates a new project at …"), and refuses the root that is already open, a path
that is not a directory, and a switch while a pipeline run or agent turn is in flight
(`WorkspaceSession.busy()`).

**Creating one is `workspace.create(path='…' title='…' newFolder=false)`, and it scaffolds where
opening does not.** The two are deliberately different promises: opening a directory the author already has
must not litter it, whereas "create a new project here" is an explicit request for a project, and
one whose model will not build is a worse answer than three files. So `createWorkspace` writes a
skeleton — `project.yaml` (`title` + `start: opening`), `scenes/opening.md` (a Fountain slug line
and two lines to write over), `wiki/index.md` (an empty story-bible page) — then `ensureRepo`
commits it as `New project`, and only then opens it through the same `host.openWorkspace` every
other path takes. The skeleton is not a copy of `templates/basic`: that is somebody else's story,
and the author would spend their first ten minutes deleting a cast. It is sized by one assertion —
the created project builds a model with **no error diagnostics**, so the header's first count is
zero rather than red.

**`newFolder` is what makes an OS chooser enough.** Off — the default, and what
`workspace.create(path='/x/y')` has always meant — the project goes at `path`. On, it goes in
`slug(title)` **inside** `path`, so "choose a parent and type a name" becomes a folder the chooser
can answer and a textbox the author can, instead of a save-dialog. The rule is `createRoot(path,
title, newFolder)` and every sentence `wouldCreate` produces names the root it resolved, so the
author reads where the project lands rather than applying the rule themselves. On with a title that
slugs to nothing is a refusal: there is no root yet to take a `basename` from.

The refusals are `inspectCreate`'s: a path that is a file, and a directory with anything in it
(*"… already contains files — open it with workspace.open instead"*) — never a merge, never an
overwrite. Sitting inside a larger git repo is a **fact appended to the accept**, not a refusal and
no longer a warning: creating a project initializes a repository **at** its own root whatever
encloses it (`initRepoAt`, the deliberate opposite of `ensureRepo`), so the accept says the new
project will be a repository nested inside the one that already owns the path
([`repos-and-commits.md`](repos-and-commits.md)). Like every mutator, `run` re-runs the check rather
than trusting the one the form showed.

**The app menu is where all three live**: New Project… opens `workspace.create`'s **own dialog**
with `newFolder` checked — a `path` field with a **Browse…** button beside it, a title, the checkbox
that turns the two into a directory no chooser could have named, and Cancel beside the button;
**Open Project…** runs `workspace.pick` outright, since the chooser it raises is the form. (A dialog
is for a command with something to collect or something to confirm — an entry with neither, like
this one and **Reindex Project**, would draw an empty form the author dismisses with the same click
that opened it.) **Recent Projects** is a submenu built from
`workspace.recent` — one entry per remembered root, labelled by its last path segment with the full
path as the tooltip, each invoking `workspace.open(path=…)`. The renderer keeps no list of its own;
it refetches once per project it finds itself in, and leaves the open project out rather than
checking it, because `workspace.open` refuses that root by name. Browsing is
`workspace.chooseDirectory` — non-mutating, no props, the chosen absolute path in `data` and
`Cancelled.` when there is none — so the Browse button is an invocation like every other button in
the app rather than a renderer-only capability, and CDP can reach the same act.

**Set Up API Keys…** is in the same menu, and it is the one entry that opens a **pane** rather than
a dialog: `view.open(editor='onboarding', where='elsewhere')`. It used to raise `project.setKey`'s
bare form — a provider dropdown and the key itself — and that form is still in the palette, but a
box asking for a credential is no use to someone who does not have one yet, and [Setup](#setup) is
the same box with the steps for getting there above it. It is also where the key field is finally
**masked**: the pane owns a shadow root, so a `type="password"` input is an ordinary element there
rather than the one raw widget smuggled into a path.ux form.

Wherever it is invoked from, `project.setKey` writes `keys/<gemini.txt|claude.txt>` — the first
filename `resolveKeys` looks for, so what is written is what is read. At `scope=project` that is
inside the project, and `keys` is added to `.gitignore` **before** the write, because commit-on-save
runs `git commit -A` and a key git can see is committed within the second; at `scope=user` it is the
user-level directory, which no repository contains and which therefore has no snapshot to worry
about. The key is a `secret` prop, so the history records `<secret>`, and the command is
deliberately **not undoable** — an undo point is a git snapshot, and snapshotting a credential is
the one thing it exists to avoid. When the provider's environment variable is set, the check and
the result both say so — the variable wins, so the file would go unused.

**A switch is a teardown, not a refresh.** The session (with its agent conversation), the command
stack, its undo journal, the repo map and the undo revision are all rebuilt against the new root:
undo never crosses a workspace boundary, and the `command:ui` effect the renderer receives
(`{ type: 'workspace' }`) is a remount. Nothing may cache the root across it — the `vnasset://`
handler resolves `ProjectPaths` per request for exactly that reason.

## Seeded workspace (`examples/mySampleRepo`)

With nothing remembered and no `VN_PROJECT`, the app seeds **`examples/mySampleRepo`** from
`templates/basic` (`apps/desktop/src/main/workspace.ts`).

- **Why**: a real run writes ~100 MB into `vngen/`, and doing that in the source tree buries
  `git status` and erases the line between the sample we ship and the copy you've been messing
  with. The whole of `examples/` is **gitignored**, so a seeded workspace's own git repo is
  invisible to the parent — no submodule, no `gitlink`, no `--recursive` clone. The committed
  template lives in `templates/`, which is a different tree on purpose.
- **Seeding copies inputs only** — everything in the template except `vngen/` (a fresh
  workspace has not been run) and `keys/` (secrets) — then `git init`s and commits them as
  `Sample project inputs`. A local `user.*` is set only when git can't already answer who the
  committer is; `core.autocrlf false` is always set, since the branch editor patches scene
  prose byte-exactly.
- **An existing directory is opened untouched.** Never re-copied, never overwritten: it is the
  user's working copy. Resetting it is `rm -rf examples/mySampleRepo`, which needs no code and
  cannot misfire. A copy seeded before the template became one file per scene therefore still
  holds the `screenplay/` form, which no longer loads: run `workspace.import` on it, or delete
  the directory to get the current template.
- **The template is what says this is a source checkout.** `examples/` is ignored and a fresh
  clone has none, so `seedSample` probes for `templates/basic` instead; a packaged build, having
  neither, falls back to `app.getPath('userData')/mySampleRepo` and then fails by name.

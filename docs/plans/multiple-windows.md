# Multiple Windows

Status: **planned**

## Context

> what are our options to supporting having multiple windows open at once in the desktop app, so
> the user can spread editors across multiple monitors.

The shell is already a mesh of panes an author arranges, and `view.open` already puts an editor
`left` / `right` / `above` / `below` / `elsewhere`. What it cannot do is put one on the *other
monitor*, because there is exactly one `BrowserWindow` and the whole main process addresses it by
name.

### What is single-window today

`win` is a module singleton in `apps/desktop/src/main/index.ts:88`, and it is the address for
every push main makes:

| What | Where |
| --- | --- |
| agent events, plan / ask / confirm requests | `index.ts:266-283` (`deps`) |
| `command:ui` effects — `view.*`, undo, palette | `index.ts:331` (`host.ui`) |
| the workspace-switch effect | `index.ts:226` |
| `session:changed` | `index.ts:301` |
| log lines | `index.ts:352` |
| native dialogs (directory chooser, unsaved-changes) | `index.ts:333-341`, `index.ts:488` |

Two more facts matter as much as the singleton:

- **`handle()` throws away the event** (`index.ts:381`), so main has no idea *which* renderer asked
  for anything. Every `view.*` effect today is broadcast-by-accident: there is one listener, so
  "the window that asked" and "the window there is" are the same window.
- **`Pending<T>.abandon` is global** (`index.ts:120`, called from `win.on('closed')` at
  `index.ts:472`). With one window that is exactly right — nobody is left to ask. With four it
  would end every parked agent turn because one window closed.

Persistence is single-window in the same way: `persist.ts:14` writes one `pathux.layout` key and
one `pathux.selection` key, both global per install (`docs/desktopAppState.md`).

### What the renderer already gives us

Nothing in the mesh assumes it is the only mesh. `VnScreen`'s own doc comment already says
*"One per window"* (`renderer/pathux/screen.ts:3`), and every renderer-side singleton — `bridge.ts`'s
`host`, `persist.ts`'s `watchers` and `timer`, `ShellState`, the palette — is module-scoped, so a
second renderer process gets its own set for free. `Shell.start()` reads its layout, installs its
keymap, its bridge and its persistence against `this`, never against a global.

The mesh helpers in `panes.ts` (`paneToUse`, `paneElsewhere`, `paneShowing`, `paneToClose`) are pure
over one `VnScreen`. A second window is a second screen to run them against, not a change to them.

### What happens today if you just launch it twice

This is the option that costs nothing, and it is the one that is actually broken. There is no
`app.requestSingleInstanceLock()`, so a second launch is a second **main process**:

- two `WorkspaceSession`s over one project, each with its own agent conversation;
- two `CommandStack`s, each with `private seq` starting at zero (`packages/commands/src/stack.ts:91`)
  — and the undo journal parks snapshots at `refs/vn/undo/<seq>/pre|post`
  (`packages/commands/src/undo.ts:94`). Two instances therefore write **the same refs**. Instance B's
  first command overwrites the snapshot instance A's first command depends on, and an undo in A
  restores B's bytes without either of them being able to notice;
- two `Committer`s committing `-A` in one repo, so each one's checkpoint sweeps in the other's
  in-flight work;
- two `SessionStore`s over one `session.json`. That one is *handled* — writes merge per key under a
  `mkdir` lock — but `pathux.layout` is the same key in both, so it is last-flush-wins and the
  two windows fight over one remembered arrangement.

`docs/desktopAppState.md` documents the session-store race under "Multiple windows/tabs of the same
workspace" and says *"Separate app instance per window (Electron), so one WorkspaceSession per
window"* as though that were the design. It is not a design, it is what happens; the undo and
commit collisions are undocumented. **Fixing this is worth doing on its own, whatever else here
ships.**

## Options considered

### 1. Several `BrowserWindow`s in one main process, each a full path.ux screen

The Blender model, and the one that answers the question. Main grows a window registry; effects
are split into broadcast and targeted; each window remembers its own layout and its own selection.
Costed in [Work](#work) below.

The renderer changes barely at all — that is the whole argument for it. What changes is main's
habit of knowing the answer to "which window".

### 2. Torn-off single-editor windows

A small window hosting one editor, no header, no mesh, closing back into the pane it came from.
This reads as a *different* feature but it is the same plumbing: a window registry, routed effects,
per-window persistence. It is an affordance on top of option 1, not an alternative to it, so it is
staged last and cut first.

### 3. Same-process popups via `window.open`, sharing one JS heap

Tempting, because `ShellState`, the toolstack and the bridge would be genuinely shared and
cross-window selection sync would be free rather than designed.

**Rejected.** path.ux binds to the ambient `window` / `document` at module scope: it defines its
custom elements against the opening document's registry (`vendor/path.ux/scripts/core/ui_base.ts:1758`),
registers window-level listeners, and reads `window.innerWidth` / `devicePixelRatio` directly
(`ui_base.ts:2735`, `ui_base.ts:1689`). A popup gets **its own** `CustomElementRegistry`, so path.ux
elements moved into it never upgrade. Making this work means teaching path.ux per-document
registration — real work in the vendored submodule, for the smaller prize. Option 1 gets separate
heaps and pays for it with explicit state routing, which is a cost we can see.

### 4. One window stretched across monitors

Costs nothing, changes nothing, and does not do what was asked: mixed-DPI displays on Windows make
a spanning window look wrong on at least one of them, and the OS cannot maximize or snap it per
screen. Recorded so the question is not asked again.

## Decisions this plan settles

- **A window is a renderer, not a document.** One main process, one `WorkspaceSession`, one
  `CommandStack`, one project. Windows are views onto it. Everything that was one stays one; only
  the *address of the UI* becomes plural.
- **Undo stays global, deliberately.** Ctrl+Z in window B undoes the edit made in window A. Undo
  here is a shadow snapshot of the whole worktree (`docs/command-system.md`), not a per-pane edit
  buffer, so a per-window stack would be a lie about what it restores. The `undo` effect already
  carries `revision`, which is what lets each window tell an undo apart from an ordinary command
  (`bridge.ts:183-196`) — it just has to reach all of them.
- **An effect is answered by the window that asked.** `view.*` is the case that matters: "show me
  the coverage strip" means *here*, in the window whose palette or menu ran it. So `handle()` starts
  passing `event.sender`, the command context carries an originating window, and `ctx.host.ui`
  takes a target. A command with no sender — CDP, the agent, a menu accelerator routed through
  main — targets the **focused** window, and falls back to the most recently focused one when
  nothing has focus.
- **Selection is per-window, and that is the feature.** `ShellState.sceneId` / `shotId` /
  `characterId` / `docPath` stay renderer-local. Script on one monitor and the asset it produced on
  another is the entire point of the request; syncing them would collapse the two windows into one
  wider window. `pathux.selection` therefore becomes per-window like the layout.
- **A window is remembered by index, not by identity.** `pathux.window.<n>.layout`,
  `pathux.window.<n>.selection`, and a `pathux.windows` list holding each one's bounds. On launch,
  restore every remembered window at its remembered bounds; a window whose bounds land entirely
  off the current display set is clamped onto the nearest display rather than restored invisible.
- **Closing the last window quits (non-macOS), closing any other does not.** The existing
  `window-all-closed` handler (`index.ts:521`) already says this; what changes is that a close now
  abandons **only that window's** pending requests.
- **`view.open where='window'` opens a new window, and it is one more value in an existing enum.**
  Not a new command shape. `OPEN_WHERE` (`shared/editors.ts:125`) grows a seventh member, and the
  sentence `view.open` says grows a seventh clause in `WHERE` (`commands/view.ts:17`).

## Work

Staged so each step is shippable and the first one is worth having alone.

### Step 0 — single instance

`app.requestSingleInstanceLock()` at the top of the ready path; on `second-instance`, open a new
window in the running process (once step 1 exists) or focus the existing one (until then). Without
the lock, every later step is defeated by launching the app twice.

Also: state the undo-ref and committer collisions in `docs/desktopAppState.md`, replacing the
paragraph that presents "one app instance per window" as the design.

**Files:** `src/main/index.ts`, `docs/desktopAppState.md`.

### Step 1 — a window registry and routed effects

The mechanical core. No user-visible change; after it, a second window would work if anything
created one.

- Replace `let win` with a `Windows` class in a new `src/main/windows.ts`: `create()`, `all()`,
  `focused()`, `byWebContents(sender)`, `close(id)`, and an `id` stable for the window's lifetime.
  `createWindow` moves there mostly unchanged.
- Split the pushes. `broadcast(channel, payload)` for `agent:event`, `session:changed`, `log`, and
  the `undo` / `workspace` effects; `send(target, …)` for `view.*`, `palette`, and the three
  `permission:*` requests.
- `handle()` gains the sender: `ipcMain.handle(channel, (event, ...args) => fn(event, ...args))`,
  and `command:exec` resolves an originating window from it. `CommandHost.ui` becomes
  `(effect: UiEffect, target?: WindowId)`.
- `Pending<T>` records the window each request went to; `abandon()` grows a `by(windowId)` form so
  a close ends only its own turns. `requestPlan` / `requestAnswer` / `requestConfirm` ask the window
  that started the agent turn, and re-ask the focused window if that one is gone mid-turn.
- `pickDirectory` and the `will-prevent-unload` dialog parent to their own window.
- `switchWorkspace` broadcasts, and every window remounts — the workspace is process-wide, so
  opening another project tears down all of them.

**Files:** `src/main/index.ts`, new `src/main/windows.ts`, `src/main/commands/host.ts`,
`src/shared/ipc.ts` (only if a window id needs to cross the wire — see [Open questions](#open-questions)).

### Step 2 — per-window persistence

- The preload learns its window's index (a `additionalArguments` entry on `webPreferences`, read in
  the preload and exposed as `api.windowIndex`), so the renderer can key its own storage without a
  round trip before first paint — `session.initial()` is `sendSync` for exactly that reason
  (`src/preload/index.ts:14`).
- `persist.ts` keys become `pathux.window.<n>.layout` / `.selection`. A legacy flat `pathux.layout`
  is read once as window 0's layout and then left alone, so an existing install does not open to a
  default screen.
- Main writes `pathux.windows` — the bounds and display of each open window — on close and on
  `moved`/`resized` (debounced, same as the session store's own flush), and restores from it at
  launch. Bounds are clamped against `screen.getAllDisplays()` before use.

**Files:** `renderer/pathux/persist.ts`, `src/preload/index.ts`, `src/main/windows.ts`,
`src/main/index.ts`.

### Step 3 — the vocabulary

- `window.new` (opens a window, optionally with `editor` and `subject` so "open this on the other
  screen" is one act) and `window.close`. Registered in `src/main/commands/` like everything else,
  so the palette, the menu bar, CDP and the agent all reach them —
  `docs/command-system.md`'s one-registry rule.
- `OPEN_WHERE` grows `'window'`; `view.open` routes it to `window.new` rather than to the mesh.
- Header: a `Window` menu, or two entries in the app menu beside `Split Area`
  (`editors/header.ts:184`) — New Window, Close Window. `Ctrl+Shift+N` in the keymap.
- The pane context menu gets **Move to New Window**: `window.new(editor=…, subject=…)` followed by
  `view.close` in the source window. Two commands, both already refusable, rather than a bespoke
  move.

**Files:** new `src/main/commands/window.ts`, `src/main/commands/index.ts`,
`src/shared/editors.ts`, `src/main/commands/view.ts`, `renderer/pathux/editors/header.ts`,
`renderer/pathux/keymap.ts`.

### Step 4 — torn-off editor windows (optional)

A window created with a `bare` flag: no header editor, one pane, `ensureHeader` skipped
(`shell.ts:110`). Closing it is `window.close`. Everything else is step 1's plumbing. Cut this
first if the plan runs long — it is polish over a working feature, not part of one.

## What each step does not change

- The pipeline, the scheduler, the store, and every `@vn/*` package. This plan is entirely
  `apps/desktop`.
- The command registry's shape. `window.*` is another namespace; `view.*` gains one enum value.
- The write path. Windows are views; commands remain the only way anything is written.

## Open questions

- **Does a window id need to cross the wire?** Only if the renderer must name a *different* window
  (e.g. "open this in window 2"). If every cross-window act is expressed as `where='window'` (a new
  one) or as focus-follows-the-sender, main can keep window identity entirely to itself and
  `shared/ipc.ts` never learns the concept. Prefer that until something needs otherwise.
- **What does CDP target?** `scripts/vn-cdp.mjs` assumes one page. With N windows it needs a rule —
  the first target, or a `--window <n>` flag — and `docs/debugGuide.md` needs to say which. Every
  CDP-driven test in the repo assumes one page today, so this is a real dependency and not a
  footnote.
- **The Play editor's saves are per-origin.** `localStorage` key `vn.runner.save.<title>`
  (`docs/desktopAppState.md`) is shared across windows, so two Play editors clobber each other's
  playthrough. Same failure as two instances have today. Either accept it (a second Play editor is
  an odd thing to want) or key it per window.
- **Mixed-DPI monitors.** path.ux's `_calcSizeKey` includes `devicePixelRatio`
  (`vendor/path.ux/scripts/screen/FrameManager.ts:984`), so dragging a window between displays of
  different scaling *should* re-key and rescale on the update loop. Verify live over CDP before
  claiming it; if it does not, the fix is a `setCSS` + `completeUpdate` on the window's
  `display-changed`.

## Testing

- **Node tests** (`src/main/tests/`) for `Windows`: registry lifecycle, `byWebContents` resolution,
  `Pending.by(windowId)` abandoning one window's requests and no others, bounds clamping against a
  synthetic display set. These are the parts worth testing and they are all pure over injected
  data — the jest desktop project is node-only, so nothing here may touch a real `BrowserWindow`.
- **Renderer tests** for the persistence keying: which key a given window index reads and writes,
  and the legacy-`pathux.layout` migration.
- **Live over CDP** for everything else, per `docs/desktop-app.md`'s rule that surfaces are verified
  live: two windows open, a `view.open` in one landing in that one, an undo in one refreshing both,
  an agent plan prompt appearing in the window that started the turn, and a layout surviving a
  restart on two monitors.

## Docs to update when this ships

- `docs/desktop-app.md` — the shell section: a window is a renderer, what is one per process and
  what is one per window.
- `docs/desktopAppState.md` — the per-window keys, `pathux.windows`, and the corrected "multiple
  windows" edge case.
- `docs/command-system.md` — the `window.*` namespace and `view.*`'s new `where`.
- `docs/debugGuide.md` — which window CDP attaches to.
- `CLAUDE.md` — one line under the desktop-app bullets, pointing here.

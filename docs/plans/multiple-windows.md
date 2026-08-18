# Multiple Windows

Status: **planned**

## Context

> what are our options to supporting having multiple windows open at once in the desktop app, so
> the user can spread editors across multiple monitors.

The shell is already a mesh of panes an author arranges, and `view.open` already puts an editor
`left` / `right` / `above` / `below` / `elsewhere`. What it cannot do is put one on the _other
monitor_, because there is exactly one `BrowserWindow` and the whole main process addresses it by
name.

### What is single-window today

`win` is a module singleton in `apps/desktop/src/main/index.ts:103`, and it is the address for
every push main makes:

| What                                       | Where                                    | Who asked                    |
| ------------------------------------------ | ---------------------------------------- | ---------------------------- |
| agent events                               | `index.ts:313` (`deps.emitEvent`)        | nobody — a session fact      |
| plan / ask / confirm requests              | `index.ts:314-333` (`deps`)              | whoever started the turn     |
| `command:ui` `view.*`, `palette`           | `index.ts:388` (`host.ui`)               | whoever ran the command      |
| `command:ui` `undo`                        | `index.ts:454` (`onRecord`)              | nobody — a worktree fact     |
| `command:ui` `workspace`                   | `index.ts:253`                           | nobody — the process moved   |
| `command:ui` `busy`                        | `index.ts:339` (`deps.pushBusy`)         | nobody — a session fact      |
| `notify:changed`                           | `index.ts:310` (`installNotifications`)  | nobody — a durable record    |
| `session:changed`                          | `index.ts:359`                           | nobody — a store fact        |
| log lines                                  | `index.ts:421`                           | nobody                       |
| the window title                           | `index.ts:236` (`nameWindow`)            | nobody                       |
| native dialogs (`pickDirectory`/`pickFiles`) | `index.ts:390-408`                     | whoever ran the command      |
| the unsaved-changes dialog                 | `index.ts:578` (`will-prevent-unload`)   | that window                  |
| devtools on F12                            | `index.ts:571-572` (`before-input-event`) | that window                 |

The third column is the whole design: it is already the broadcast/targeted split, it is just not
written down anywhere, because with one window the two are the same window.

Two of those rows are **already** subtly wrong rather than merely single-window. The `F12` handler
and the `will-prevent-unload` dialog are registered per window inside `createWindow` but both reach
for the module global `win` rather than the window they were registered on, so the moment a second
window exists they act on the wrong one.

Three more facts matter as much as the singleton:

- **`handle()` throws away the event** (`index.ts:468`), so main has no idea _which_ renderer asked
  for anything. Every `view.*` effect today is broadcast-by-accident: there is one listener, so
  "the window that asked" and "the window there is" are the same window.
- **`Pending<T>.abandon` is global** (`index.ts:135`, called from `win.on('closed')` at
  `index.ts:562`). With one window that is exactly right — nobody is left to ask. With four it
  would end every parked agent turn because one window closed.
- **`CommandStack` has one context and no serialization.** `opts.context` is a single object built
  once (`packages/commands/src/stack.ts:22`), `exec(id, props, source)` takes no per-call overlay
  (`stack.ts:64`), and nothing in the stack queues or locks — commands genuinely overlap. That is
  what makes "which window asked" a plumbing problem rather than a variable
  (see [Step 1](#step-1--a-window-registry-and-routed-effects)).

Persistence is single-window in the same way: `persist.ts:18-19` writes one `pathux.layout` key and
one `pathux.selection` key, and `commands/view.ts:25` writes one `pathux.template` key — all three
global per install (`docs/desktopAppState.md`), and all three describing **a window**.

### What the renderer already gives us

Nothing in the mesh assumes it is the only mesh. `VnScreen`'s own doc comment already says
_"One per window"_ (`renderer/pathux/screen.ts:3`), and every renderer-side singleton — `bridge.ts`'s
`host` (`:28`), `persist.ts`'s `watchers` and `timer` (`:48-51`), `ShellState`, the palette — is
module-scoped. A second window is a second document with its own JS context, so it gets its own set
for free. `Shell.start()` reads its layout, installs its keymap, its bridge and its persistence
against `this`, never against a global.

The mesh helpers in `panes.ts` (`paneToUse`, `paneElsewhere`, `paneShowing`, `paneToClose`) are pure
over one `VnScreen`. A second window is a second screen to run them against, not a change to them.

### What happens today if you just launch it twice

This is the option that costs nothing, and it is the one that is actually broken. There is no
`app.requestSingleInstanceLock()`, so a second launch is a second **main process**:

- two `WorkspaceSession`s over one project, each with its own agent conversation;
- two `CommandStack`s, each with `private seq` starting at zero (`packages/commands/src/stack.ts:49`)
  — and the undo journal parks snapshots at `refs/vn/undo/<seq>/pre|post`
  (`packages/commands/src/undo.ts:94`). Two instances therefore write **the same refs**. Instance B's
  first command overwrites the snapshot instance A's first command depends on, and an undo in A
  restores B's bytes without either of them being able to notice. `UndoJournal`'s own prune
  (`undo.ts:208-212`) will also delete refs the other instance is still holding;
- two `Committer`s committing `-A` in one repo, so each one's checkpoint sweeps in the other's
  in-flight work;
- two `SessionStore`s over one `session.json`. That one is _handled_ — writes merge per key under a
  `mkdir` lock — but `pathux.layout` is the same key in both, so it is last-flush-wins and the
  two windows fight over one remembered arrangement.

**`seq` is in-memory only** — nothing restores it from `commands.jsonl` — so a single instance
already rewrites `refs/vn/undo/1/…` on every launch. That much is harmless, because the records
those refs belonged to died with the process that made them. The two-instance case is the dangerous
one precisely because both stacks are _live_: each is holding record ids the other is overwriting.
Step 0's doc edit should say both, so the ref namespace reads as deliberately per-process.

`docs/desktopAppState.md` documents the session-store race under "Multiple windows/tabs of the same
workspace" and says _"Separate app instance per window (Electron), so one WorkspaceSession per
window"_ as though that were the design. It is not a design, it is what happens; the undo and
commit collisions are undocumented. **Fixing this is worth doing on its own, whatever else here
ships.**

**Every one of those collisions is scoped to a project, not to the app.** The undo refs, the
committer, the notification log and the agent conversation are all per workspace; two instances on
_different_ repos share none of them. That is what makes `app.requestSingleInstanceLock()` the
wrong instrument — it is a global lock, so it buys the safety by forbidding something that was
never dangerous. See [instances are per workspace](#decisions-this-plan-settles) below.

One thing genuinely _is_ install-global and does collide across repos: `resolveSessionDir()` is
`__dirname/../../.vndesktop` (`sessionstore.ts:36-38`), so **one `session.json` serves every
instance**. Per-window keys therefore have to be scoped by workspace as well as by window, or two
instances on two repos both write `pathux.window.0.layout` and load each other's arrangement at
launch. `VN_DESKTOP_HOME` overrides the directory, which is what lets a test isolate it.

## Options considered

### 1. Several `BrowserWindow`s in one main process, each a full path.ux screen

The Blender model, and the one that answers the question. Main grows a window registry; effects
are split into broadcast and targeted; each window remembers its own layout and its own selection.
Costed in [Work](#work) below.

The renderer changes barely at all — that is the whole argument for it. What changes is main's
habit of knowing the answer to "which window".

### 2. Torn-off single-editor windows

A small window hosting one editor, no header, no mesh, closing back into the pane it came from.
This reads as a _different_ feature but it is the same plumbing: a window registry, routed effects,
per-window persistence. It is an affordance on top of option 1, not an alternative to it, so it is
staged last and cut first.

### 3. Same-process popups via `window.open`, sharing one JS heap

Tempting, because `ShellState`, the toolstack and the bridge would be genuinely shared and
cross-window selection sync would be free rather than designed.

**Rejected.** path.ux binds to the ambient `window` / `document` at module scope: it defines its
custom elements against the opening document's registry (`vendor/path.ux/scripts/core/ui_base.ts:1757`),
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
  the _address of the UI_ becomes plural.
- **An instance is per workspace, and opening a repo someone already has open hands off to them.**
  Two repos, two app instances, each with as many windows as the author wants; one repo, one
  instance, always. This is VS Code's rule and it is the one the collisions above actually
  describe — so the lock is on the **project**, not on the app, and
  `app.requestSingleInstanceLock()` is deliberately **not** used. A launch that resolves to a
  workspace another live instance owns tells that instance to focus itself and exits without ever
  showing a window; `workspace.open` does the same and **refuses the switch**, staying where it is,
  rather than opening a project twice. Nothing about the default changes: launching twice with no
  arguments still resolves both to the same most-recent project (`index.ts:216`), so it still
  gives you the one window you already had.
- **Undo stays global, deliberately.** Ctrl+Z in window B undoes the edit made in window A. Undo
  here is a shadow snapshot of the whole worktree (`docs/command-system.md`), not a per-pane edit
  buffer, so a per-window stack would be a lie about what it restores. The `undo` effect already
  carries `revision`, which is what lets each window tell an undo apart from an ordinary command
  (`bridge.ts:236-244`) — it just has to reach all of them.
- **An effect is answered by the window that asked, and "who asked" is carried per execution.**
  `view.*` is the case that matters: "show me the coverage strip" means _here_, in the window whose
  palette or menu ran it. There is no seam for this today, and the shared `CommandHost` cannot hold
  it — commands overlap, so a mutable field would be clobbered by the next palette command while a
  `pipeline.run` was still going. So `@vn/commands` grows the thinnest possible notion of an
  origin (below), `handle()` starts passing `event.sender`, and `ctx.host.ui` takes a target.
  A command with no origin — the agent, or main itself — targets the **focused** window, and falls
  back to the most recently focused one when nothing has focus.
- **`@vn/commands` learns that executions have an origin; it never learns what a window is.**
  `CommandStack.exec(id, props, source, origin?)` and `CommandContext.origin?: number`, built as a
  per-exec shallow overlay on `opts.context`. The framework only carries the number. The desktop is
  the half that says it is a window id, and `CommandRecord` does **not** gain it — a window index
  means nothing to a reader of `commands.jsonl` a week later. This is a real, deliberate amendment
  to "this plan touches no `@vn/*` package"; the alternatives were a mutable field that races or a
  second execution path, and both are worse.
- **Broadcast vs targeted is decided per effect _type_, not per channel.** `command:ui` carries nine
  of them and they do not agree: `view.*` and `palette` are answers to a question a window asked,
  while `undo`, `workspace` and `busy` are facts about the process. The third column of the table
  in [What is single-window today](#what-is-single-window-today) is the rule.
- **`notify:changed` broadcasts, in full.** The note frame is a per-window surface — each window
  has its own menu bar — so an author looking at the other monitor should still see what happened,
  and the bell in every window has a count to keep honest. CLAUDE.md's "exactly one note frame
  survives" is a statement about one window's chrome, not about the install.
- **Selection is per-window, and that is the feature.** `ShellState.sceneId` / `shotId` /
  `characterId` / `docPath` stay renderer-local. Script on one monitor and the asset it produced on
  another is the entire point of the request; syncing them would collapse the two windows into one
  wider window. `pathux.selection` therefore becomes per-window like the layout.
- **All three window-shaped session keys go per-window** — the flat `pathux.layout`,
  `pathux.selection` and `pathux.template` of today. The third is the easy one to miss and it fails
  loudly: `view.applyLayout` in
  window A writes it, and `view.resetLayout` in window B then re-applies **A's** template to B
  (`commands/view.ts:230-235`). `vn.notifications.filter` and the recents list stay global, being
  install preferences rather than window facts.
- **A window is remembered by index, under the workspace it belongs to.**
  `pathux.<workspace>.window.<n>.layout`, `.selection`, `.template`, and a
  `pathux.<workspace>.windows` list holding each one's bounds, where `<workspace>` is a short
  digest of the root. The workspace segment is not decoration: `session.json` is install-global
  (`sessionstore.ts:36-38`), so without it two instances on two repos write the same
  `pathux.window.0.layout` and open into each other's arrangement — and even within one instance,
  a `switchWorkspace` would carry a selection made of the previous project's scene ids into a
  project that has none of them. A new window takes the **lowest free index** within its
  workspace, so a closed-and-reopened window
  comes back into its own arrangement rather than a default screen. On launch, restore every
  remembered window at its remembered bounds; a window whose bounds land entirely off the current
  display set is clamped onto the nearest display rather than restored invisible.
- **The window list is rewritten from the live set, and frozen at `before-quit`.** Closing a window
  deliberately means it does not come back, so `pathux.<workspace>.windows` is rewritten on
  `moved` / `resized` / `closed`. A quit closes every window in a cascade, which would otherwise
  rewrite the list down to nothing and lose the whole arrangement — so `before-quit` snapshots the
  open set first and marks the list frozen for the rest of the process. It is frozen per workspace,
  not per process: an instance only ever owns one. The per-window
  `pathux.<workspace>.window.<n>.*` keys are left alone either way; they are cheap, and they are what makes index reuse worth having.
- **A window knows its own index from its URL.** `?window=<n>`, via `loadFile(…, { query })` /
  `loadURL`. The preload can read `location.search` before first paint — which is why
  `session.initial()` is `sendSync` at all (`src/preload/index.ts:14`) — and, for free, the index
  lands in the CDP target list, which is what makes `--window` possible at all.
- **Closing the last window quits (non-macOS), closing any other does not.** The existing
  `window-all-closed` handler (`index.ts:617`) already says this; what changes is that a close now
  abandons **only that window's** pending requests — and that a quit must actually leave no process
  behind, which is what the shutdown tests below exist to hold.
- **Ctrl+Q must stop being `window.close()`.** `bridge.quit()` is literally `window.close()`
  (`bridge.ts:184`) and only quits because `window-all-closed` fires with one window open. The
  moment a second window exists, the gesture the keymap labels `'Quit'` (`keymap.ts:25`) silently
  becomes Close Window — a control whose tooltip lies, which is the one thing CLAUDE.md's tooltip
  rule forbids. So the `window.*` namespace owns both: `window.close` on Ctrl+W, `window.quit` on
  Ctrl+Q. Main closing each window still fires that window's `will-prevent-unload`, so an unsaved
  draft is still asked about, once per window.
- **`view.open where='window'` opens a new window, and it is one more value in an existing enum.**
  Not a new command shape. Both halves of the enum grow — the `OpenWhere` union
  (`shared/editors.ts:140`) and the `OPEN_WHERE` array (`:142`) are written separately — and the
  two exhaustive `Record`s over it are the compile errors that find every place that cares:
  `WHERE` in `commands/view.ts:28`, and `SPLIT` in `renderer/pathux/view.ts:90` where `SPLIT[where]`
  is indexed at `:124`.
- **Every window carries the same project name, so the title says which window it is.**
  `nameWindow` exists because "three windows all called `vnstudio` is not a list" — with N windows
  on one project that problem comes straight back, so the title gains ` (n)` whenever more than one
  window is open, and loses it again when only one is left.

## Work

Staged so each step is shippable and the first one is worth having alone.

### Step 0 — one instance per workspace

Without this, every later step is defeated by launching the app twice on the same repo. With
Electron's own global lock it would instead be defeated by launching it on two repos, which is a
thing we want. So the lock is ours and it is keyed by the resolved workspace root.

- **The lock is a listening socket, not a file.** `net.createServer().listen(p)` at
  `\\.\pipe\vnstudio-<hash>` on Windows and `<tmpdir>/vnstudio-<hash>.sock` on posix, where
  `<hash>` is a digest of the canonical, case-normalized root. Binding **is** acquiring: it
  succeeds for exactly one process, and on Windows the pipe dies with the process, so there is no
  stale-pid bookkeeping and no lock that outlives a crash. On posix a stale socket file survives,
  so `EADDRINUSE` is followed by a connect attempt — a refused connect means the owner is gone,
  and the file is unlinked and the listen retried once.
- **Handing off is a message on that socket.** The arriving instance connects, sends `focus`, and
  exits **before creating any window**, so the user sees the existing instance come forward rather
  than a window that flashes and disappears. The owner focuses its most recently focused window.
- **It is acquired after `resolveWorkspace()`, not at the top of the ready path** — which is the
  one ordering constraint worth writing down. The root is not known until then, and that function
  can put up an interactive picker (`index.ts:210-223`), so an author may pick a repo that turns
  out to be taken. Handing off from _after_ the picker is correct and is what VS Code does too.
- **Releasing.** `switchWorkspace` releases the old root's socket after it has acquired the new
  one, so a switch never drops a lock it might fail to reclaim. Quitting closes the server with
  the process.
- **`workspace.open` gains a refusal**, per the command system's declare-before-you-run rule:
  _"that project is already open in another window"_, and running it anyway focuses that instance
  instead of switching. `check` can race `run` here — another instance may take the root in
  between — so `run` re-acquires for real and refuses again rather than trusting the check.

- **The developer launcher's CDP port collides, and it should say so.**
  `scripts/vndesktop.mjs:22` defaults the port to `9222` and passes it to the app, so two
  instances on two repos fight over one port: the second opens no debugger, and every
  `vn-cdp.mjs` call afterwards drives the _first_ repo while reading as though it drove the
  second. Nothing about the lock fixes this — both instances are legitimate — so the **launcher**
  should take the first free port from `9222` upward and print the one it got (it already prints
  the port, `vndesktop.mjs:24`). The client half needs no change: `CDP_PORT` is already
  `VN_CDP_PORT ?? '9222'` (`cdp.mjs:9`), so `VN_CDP_PORT=9223 node scripts/vn-cdp.mjs …` reaches
  the second instance. `pageTarget`'s _"the app has exactly one window"_ (`cdp.mjs:25-38`) is
  step 1's problem, not this one — `--window` selects within an instance, the port selects the
  instance.

Also: state the undo-ref and committer collisions in `docs/desktopAppState.md`, replacing the
paragraph that presents "one app instance per window" as the design — including that
`refs/vn/undo/<seq>` is a per-process namespace, which is exactly why the lock is per workspace:
two processes may share an install, never a project.

**Files:** `src/main/index.ts`, new `src/main/instancelock.ts`, `src/main/commands/workspace.ts`,
`scripts/vndesktop.mjs`, `docs/desktopAppState.md`.

### Step 1 — a window registry and routed effects

The mechanical core. No user-visible change; after it, a second window would work if anything
created one.

- **New `src/main/windows.ts`, and it does not import `electron`.** `src/main/index.ts` is the
  only module under `src/main/` that does, and every other one has an electron-free test beside it
  in `src/main/tests/` — the jest desktop project is node-only and there is no `electron` mapper in
  `jest.config.cjs`. So `Windows<W>` is generic over an opaque handle: `create()`, `all()`,
  `focused()`, `byHandle(sender)`, `close(id)`, lowest-free-index allocation, and `clampBounds`
  against an injected display list. `index.ts` instantiates `Windows<BrowserWindow>` and keeps the
  `BrowserWindow` construction — including the `before-input-event` and `will-prevent-unload`
  handlers, which are also fixed here to act on **their own** window rather than the module global.
- Split the pushes per the table above. `broadcast(channel, payload)` for `agent:event`,
  `notify:changed`, `session:changed`, `log`, and the `undo` / `workspace` / `busy` effects;
  `send(target, …)` for `view.*`, `palette`, and the three `permission:*` requests.
- **Thread the origin.** `@vn/commands`: `CommandContext.origin?: number`, and
  `CommandStack.exec(id, props, source, origin?)` building `{ ...this.opts.context, origin }` per
  execution rather than reusing the shared object. Desktop: `handle()` gains the sender
  (`ipcMain.handle(channel, (event, ...args) => fn(event, ...args))`), `command:exec` resolves an
  originating window from it, `CommandHost.ui` becomes `(effect: UiEffect, target?: WindowId)`, and
  the **13 `host.ui(` call sites** across `commands/{art,asset,notify,upload,view}.ts` and
  `index.ts` pass `ctx.origin`.
- `Pending<T>` records the window each request went to; `abandon()` grows a `by(windowId)` form so
  a close ends only its own turns. `requestPlan` / `requestAnswer` / `requestConfirm` ask the window
  that started the agent turn — main remembers it from `agent:run`'s sender, and there is one
  conversation so there is one in-flight turn — and re-ask the focused window if that one is gone
  mid-turn. **A request also focuses its window**: `agent:event` broadcasts, so every window shows
  the agent thinking, and a prompt that lands in an unfocused window would otherwise read as a
  hung turn on whichever monitor the author is actually looking at.
- `pickDirectory` and `pickFiles` parent to their originating window, and their "there is no window
  to show a chooser in" throw becomes "that window is gone".
- `nameWindow` titles every window, appending ` (n)` while more than one is open.
- `switchWorkspace` broadcasts, and every window remounts — the workspace is process-wide, so
  opening another project tears down all of them.
- **CDP gets its rule here, not later.** `?window=<n>` on the loaded URL puts the index in the CDP
  target's `url`, so `pageTarget(n)` in `scripts/cdp.mjs` can select deterministically instead of
  `targets.find(t => t.type === 'page')`; `vn-cdp.mjs` grows `--window <n>`, defaulting to 0. This
  cannot wait for step 3: `window.new` is reachable _from CDP_, so the tool used to verify the
  feature goes nondeterministic exactly when the feature lands. `docs/debugGuide.md`'s two-call
  `window.__x` pattern (`:223-224`, `:242-243`) is the sharp edge — the stash and the read are
  separate invocations and would silently land in different renderers.

**Files:** `packages/commands/src/{command,stack}.ts`, `src/main/index.ts`, new
`src/main/windows.ts`, `src/main/commands/host.ts`,
`src/main/commands/{art,asset,notify,upload,view}.ts`, `scripts/cdp.mjs`, `scripts/vn-cdp.mjs`,
`docs/debugGuide.md`.

### Step 2 — per-window persistence

- The renderer reads its index from `location.search`, which the preload already has before first
  paint. (`additionalArguments` on `webPreferences` is the fallback if the query string turns out
  to be unreliable, but it buys nothing the URL does not, and the URL is also what CDP reads.)
- `persist.ts` keys become `pathux.<workspace>.window.<n>.layout` / `.selection`, and
  `commands/view.ts`'s `TEMPLATE_KEY` (`view.ts:26`, today the module constant `pathux.template`)
  becomes `pathux.<workspace>.window.<n>.template` — which means it stops being a module constant
  and starts being derived from `ctx.origin`, like any other targeted act. Both halves of the key
  are needed: `<n>` because two windows of one project must not share a mesh, `<workspace>` because
  `session.json` is install-global (`sessionstore.ts:36-38`) and two instances on two repos would
  otherwise write over each other's window 0.
- A legacy flat `pathux.layout` / `pathux.selection` / `pathux.template` is read once as window 0's
  **of whichever workspace opens first** and then left alone, so an existing install does not open
  to a default screen.
- Main writes `pathux.<workspace>.windows` — the bounds and display of each open window — on `moved` /
  `resized` / `closed` (debounced, same as the session store's own flush), frozen at `before-quit`
  per the decision above, and restores from it at launch. Bounds are clamped against
  `screen.getAllDisplays()` before use.

**Files:** `renderer/pathux/persist.ts`, `src/main/commands/view.ts`, `src/main/windows.ts`,
`src/main/index.ts`.

### Step 3 — the vocabulary

- `window.new` (opens a window, optionally with `editor` and `subject` so "open this on the other
  screen" is one act), `window.close`, and `window.quit`. Registered in `src/main/commands/` like
  everything else, so the palette, the menu bar, CDP and the agent all reach them —
  `docs/command-system.md`'s one-registry rule.
- `OpenWhere` and `OPEN_WHERE` grow `'window'`; `view.open` routes it to `window.new` rather than
  to the mesh, and `WHERE` / `SPLIT` grow their clauses.
- Header: a `Window` menu, or entries in the app menu beside `Split Area`
  (`editors/header.ts:475`) — New Window, Close Window. `Ctrl+Shift+N` in the keymap (free today),
  `Ctrl+W` for `window.close`, and `Ctrl+Q` repointed from `bridge.quit()`'s bare `window.close()`
  to `window.quit`.
- The pane context menu gets **Move to New Window**: `window.new(editor=… subject=…)` followed by
  `view.close` in the source window. Two commands, both already refusable, rather than a bespoke
  move.

**Files:** new `src/main/commands/window.ts`, `src/main/commands/index.ts`,
`src/shared/editors.ts`, `src/main/commands/view.ts`, `renderer/pathux/view.ts`,
`renderer/pathux/bridge.ts`, `renderer/pathux/editors/header.ts`, `renderer/pathux/keymap.ts`.

### Step 4 — torn-off editor windows (optional)

A window created with a `bare` flag: no header editor, one pane, `ensureHeader` skipped
(`shell.ts:157`). Closing it is `window.close`. Everything else is step 1's plumbing. Cut this
first if the plan runs long — it is polish over a working feature, not part of one.

## What each step does not change

- The pipeline, the scheduler, the store, and every `@vn/*` package **except `@vn/commands`**,
  which gains an optional per-execution `origin` and nothing else. See the decision above for why
  that amendment is load-bearing rather than incidental.
- The command registry's shape. `window.*` is another namespace; `view.*` gains one enum value.
- The write path. Windows are views; commands remain the only way anything is written.

## Open questions

- **Does a window id need to cross the wire?** Only if the renderer must name a _different_ window
  (e.g. "open this in window 2"). If every cross-window act is expressed as `where='window'` (a new
  one) or as origin-follows-the-sender, main can keep window identity entirely to itself and
  `shared/ipc.ts` never learns the concept. Prefer that until something needs otherwise. (The
  renderer does learn its **own** index, but from its URL rather than over an IPC channel.)
- **What happens to unsaved drafts when the workspace switches?** `switchWorkspace` broadcasts a
  remount, and a remount is not an unload — so no window's `will-prevent-unload` guard runs, and
  every window's unsaved wiki draft is dropped. That is already true of the one window today; with
  N windows it is N times as easy to hit and the author only authorized it in one of them. Either
  accept it, or have `workspace.open` refuse while any window reports a draft.
- **The Play editor's saves are per-origin.** `localStorage` key `vn.runner.save.<title>`
  (`play/playback.ts:105`) is shared across windows, so two Play editors clobber each other's
  playthrough. Same failure as two instances have today. Either accept it (a second Play editor is
  an odd thing to want) or key it per window.
- **Mixed-DPI monitors.** path.ux's `_calcSizeKey` includes `devicePixelRatio`
  (`vendor/path.ux/scripts/screen/FrameManager.ts:984`), so dragging a window between displays of
  different scaling _should_ re-key and rescale on the update loop. Verify live over CDP before
  claiming it; if it does not, the fix is a `setCSS` + `completeUpdate` on the window's
  `display-changed`.

## Testing

### Unit — node, no Electron

- **`src/main/tests/windows.test.ts`** for `Windows<W>`: registry lifecycle, `byHandle` resolution,
  lowest-free-index allocation across a close and a reopen, `Pending.by(windowId)` abandoning one
  window's requests and no others, bounds clamping against a synthetic display set, and the
  window-list freeze at quit. All of it is pure over injected handles — which is _why_
  `windows.ts` may not import `electron`, rather than a happy accident.
- **`@vn/commands`** for the per-exec origin: two overlapping `exec` calls each see their own
  `ctx.origin`, and an `exec` with none leaves it `undefined` (the existing single-context
  behaviour, unchanged).
- **Renderer** for the persistence keying: which key a given window index reads and writes, and the
  legacy flat-key migration for all three of layout, selection and template.

### Integration — shutdown leaves no process behind

**A window that closes must take its process tree with it.** This is the failure a window registry
makes possible and a single-window app cannot have: main now holds a handle per window, `Pending`
holds parked promises per window, and `before-quit` already `preventDefault()`s to flush the
session store (`index.ts:625-631`). Any one of those can keep the main process alive after the last
window is gone — a headless Electron process with no window is invisible, survives the next launch,
and **holds step 0's workspace socket**, so the repo it was showing can never be reopened: the next
launch connects to the ghost, sends it a `focus` no window will answer, and exits. That is what
makes this worth a real integration test rather than a manual check, and it is why case 1 below
tests the single-window app that already works.

A new `apps/desktop/tests/shutdown.test.ts` (its own jest project, or a plain node script under
`scripts/` run in CI — it cannot live in the node-only `@vn/desktop` jest project, since it spawns
a real Electron). It spawns the built app the way `scripts/vndesktop.mjs` does but **without
`shell: true`**, because on Windows a shell wrapper hands back the shell's pid and the test needs
Electron's own; drives it over CDP; and after each shutdown asserts the whole tree is gone —
Electron is main + renderer + GPU + utility processes, and it is the helpers that get orphaned, so
asserting on the main pid alone would pass while leaking.

Three cases, and the multi-window ones are the point:

1. **One window, closed.** Launch, wait for the CDP page target, close the only window, assert the
   process exits within a bounded wait and no child of the spawned pid survives it. This is the
   baseline that must not regress — it is the behaviour that works today, and every later step
   changes the code that produces it.
2. **Three windows, closed one at a time, last one last.** Launch, `window.new` twice over CDP,
   then close each window in turn. After each of the first two closes assert the process is
   **still running** and that exactly one renderer process went away — a close that takes the app
   down with it is the opposite bug and just as wrong. After the third, assert the tree is gone.
3. **Three windows, quit outright.** Same setup, then `window.quit` (and, separately, the platform
   close of the last remaining window). Asserts the `before-quit` flush completes rather than
   parking: the handler is bounded by `QUIT_FLUSH_MS` (2s), so the test's own timeout must be
   comfortably larger, and a failure here means the deadline race is not actually racing.

Each case runs against a scratch workspace (`--project` into a temp dir, `--mock`) so a stray
`SessionStore` lock or a half-written `session.json` is diagnosable rather than shared. Two
variants are worth adding once the plumbing exists, because both are ways a window keeps a
handle alive: closing a window **with a parked agent turn** (the `Pending.by` path — the turn must
end, not hold the process), and closing a window **with an unsaved draft**, answering the
`will-prevent-unload` dialog both ways.

### Live over CDP

Per `docs/desktop-app.md`'s rule that surfaces are verified live: two windows open, a `view.open`
in one landing in that one, an undo in one refreshing both, a notification appearing in both, an
agent plan prompt appearing in — and focusing — the window that started the turn, Ctrl+Q quitting
rather than closing, and a layout surviving a restart on two monitors. Drive it with `--window`,
which is why that flag is step 1's problem.

Two instances on two repos are worth one live pass of their own — each one's windows, layouts and
notifications staying in its own repo, and a launch on a root already open focusing the owner
instead of opening anything. It needs step 0's port change to be drivable at all, since both
instances otherwise answer to `9222`.

## Docs to update when this ships

- `docs/desktop-app.md` — the shell section: a window is a renderer, what is one per process and
  what is one per window.
- `docs/desktopAppState.md` — the workspace-scoped per-window keys, the window list, the undo-ref
  and committer collisions, and the corrected "multiple windows" edge case.
- `docs/command-system.md` — the `window.*` namespace, `view.*`'s new `where`, and the per-execution
  origin (including that it is deliberately absent from `CommandRecord`).
- `docs/debugGuide.md` — `--window`, why the two-call `window.__x` pattern needs it, and the CDP
  port the launcher actually took.
- `CLAUDE.md` — one line under the desktop-app bullets, pointing here.

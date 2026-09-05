# Multiple Windows

Status: **implemented** (Steps 0–3). Step 4 — torn-off editor windows — was cut.

## Context

What are our options for supporting multiple open windows in the desktop app, so the user
can spread editors across multiple monitors?

The shell already holds a mesh of panes that an author arranges, and `view.open` already
puts an editor `left` / `right` / `above` / `below` / `elsewhere`. It cannot put an editor
on another monitor, because there is exactly one `BrowserWindow` and the whole main
process addresses it by name.

### What is single-window today

`win` is a module singleton in apps/desktop/src/main/index.ts:103, and main sends every
push to it:

| What                                         | Where                                     | Who asked                  |
| -------------------------------------------- | ----------------------------------------- | -------------------------- |
| agent events                                 | `index.ts:313` (`deps.emitEvent`)         | nobody — a session fact    |
| plan / ask / confirm requests                | `index.ts:314-333` (`deps`)               | whoever started the turn   |
| `command:ui` `view.*`, `palette`             | `index.ts:388` (`host.ui`)                | whoever ran the command    |
| `command:ui` `undo`                          | `index.ts:454` (`onRecord`)               | nobody — a worktree fact   |
| `command:ui` `workspace`                     | `index.ts:253`                            | nobody — the process moved |
| `command:ui` `busy`                          | `index.ts:339` (`deps.pushBusy`)          | nobody — a session fact    |
| `notify:changed`                             | `index.ts:310` (`installNotifications`)   | nobody — a durable record  |
| `session:changed`                            | `index.ts:359`                            | nobody — a store fact      |
| log lines                                    | `index.ts:421`                            | nobody                     |
| the window title                             | `index.ts:236` (`nameWindow`)             | nobody                     |
| native dialogs (`pickDirectory`/`pickFiles`) | `index.ts:390-408`                        | whoever ran the command    |
| the unsaved-changes dialog                   | `index.ts:578` (`will-prevent-unload`)    | that window                |
| devtools on F12                              | `index.ts:571-572` (`before-input-event`) | that window                |

The third column already carries the broadcast/targeted split. Nothing records that split
anywhere, because with one window the broadcast destination and the targeted destination
are the same window.

Two of those rows are subtly wrong rather than merely single-window. The `F12` handler and
the `will-prevent-unload` dialog are registered per window inside `createWindow`, but both
use the module global `win` rather than the window they were registered on, so once a
second window exists they act on the wrong one.

Three more facts matter as much as the singleton:

- **`handle()` throws away the event** (`index.ts:468`), so main cannot tell which
  renderer sent the request. Every `view.*` effect today is broadcast by accident: there
  is one listener, so the window that sent the request and the only window that exists are
  the same window.
- **`Pending<T>.abandon` is global** (`index.ts:135`, called from `win.on('closed')` at
  `index.ts:562`). With one window that behavior is correct, because closing the only
  window leaves nobody to answer. With four windows, closing one would end every parked
  agent turn.
- **`CommandStack` has one context and no serialization.** `opts.context` is a single
  object built once (packages/commands/src/stack.ts:22), `exec(id, props, source)` takes
  no per-call overlay (stack.ts:64), and nothing in the stack queues or locks, so commands
  overlap. Tracking which window asked is therefore a plumbing problem rather than a
  variable (see [Step 1](#step-1--a-window-registry-and-routed-effects)).

Persistence is also single-window: `persist.ts:18-19` writes one `pathux.layout` key and
one `pathux.selection` key, and `commands/view.ts:25` writes one `pathux.template` key.
All three keys are global per install (docs/desktopAppState.md), and all three describe
one window.

### What the renderer already gives us

Nothing in the mesh assumes it is the only mesh. `VnScreen`'s own doc comment already says
"One per window" (`renderer/pathux/screen.ts:3`), and every renderer-side singleton —
`bridge.ts`'s `host` (`:28`), `persist.ts`'s `watchers` and `timer` (`:48-51`),
`ShellState`, the palette — is module-scoped. A second window opens a second document with
its own JS context, so it gets its own set. `Shell.start()` reads its layout and installs
its keymap, its bridge and its persistence against `this`, never against a global.

The mesh helpers in `panes.ts` (`paneToUse`, `paneElsewhere`, `paneShowing`,
`paneToClose`) are "pure" (side-effect-free) over one `VnScreen`. A second window adds a
second screen to run them against, and the helpers themselves do not change.

### What happens today if you just launch it twice

This option costs nothing, and it is broken. There is no call to
`app.requestSingleInstanceLock()`, so a second launch starts a second main process:

- two `WorkspaceSession`s over one project, each with its own agent conversation;
- two `CommandStack`s, each with `private seq` starting at zero
  (packages/commands/src/stack.ts:49) — and the undo journal writes snapshots to
  `refs/vn/undo/<seq>/pre|post` (packages/commands/src/undo.ts:94). Two instances
  therefore write the same refs. Instance B's first command overwrites the snapshot
  instance A's first command depends on, an undo in A restores B's bytes, and neither
  instance can detect the substitution. `UndoJournal`'s own prune (undo.ts:208-212) will
  also delete refs the other instance is still holding;
- two `Committer`s committing `-A` in one repo, so each one's checkpoint includes the
  other's in-flight work;
- two `SessionStore`s over one `session.json`. Writes merge per key under a `mkdir` lock,
  so that case is covered, but `pathux.layout` is the same key in both stores, so the last
  flush wins and each window overwrites the arrangement the other remembered.

`seq` is in-memory only (nothing restores it from `commands.jsonl`), so a single instance
already rewrites `refs/vn/undo/1/…` on every launch. That overwrite is harmless, because
the records those refs belonged to died with the process that made them. Two instances
running at once is the dangerous case, because both stacks are live: each holds record ids
the other is overwriting. Step 0's doc edit should state both facts, so the ref namespace
reads as deliberately per-process.

docs/desktopAppState.md documents the session-store race under "Multiple windows/tabs of
the same workspace" and says _"Separate app instance per window (Electron), so one
WorkspaceSession per window"_. That sentence records what currently happens rather than a
design decision, and the undo and commit collisions are undocumented. Fixing this is worth
doing on its own, whatever else here ships.

Every one of those collisions is scoped to a project, not to the app. The undo refs, the
committer, the notification log and the agent conversation are all per workspace; two
instances on different repos share none of them. `app.requestSingleInstanceLock()` is a
global lock, so it also blocks a second instance on a different repo, which was never
dangerous. See [instances are per workspace](#decisions-this-plan-settles) below.

One thing is install-global and does collide across repos: `resolveSessionDir()` is
`__dirname/../../.vndesktop` (sessionstore.ts:36-38), so a single `session.json` serves
every instance. Per-window keys therefore have to be scoped by workspace as well as by
window, or two instances on two repos both write `pathux.window.0.layout` and load each
other's arrangement at launch. `VN_DESKTOP_HOME` overrides the directory, which lets a
test isolate the session directory.

## Options considered

### 1. Several `BrowserWindow`s in one main process, each a full path.ux screen

This is the Blender model, and it answers the question. Main holds a window registry.
Effects are split into broadcast and targeted. Each window keeps its own layout and its
own selection. The cost is given in [Work](#work) below.

The renderer changes barely at all, which is the argument for this approach. What changes
is how main determines which window.

### 2. Torn-off single-editor windows

A small window hosts one editor, with no header and no mesh, and closes back into the pane
it came from. This reads as a different feature but needs the same plumbing: a window
registry, routed effects, per-window persistence. Such a window builds on option 1 rather
than replacing it, so it is staged last and cut first.

### 3. Same-process popups via `window.open`, sharing one JS heap

This is tempting, because `ShellState`, the toolstack and the bridge would be genuinely
shared, and cross-window selection sync would come at no cost instead of requiring design
work.

Rejected. path.ux binds to the ambient `window` and `document` at module scope: it defines
its custom elements against the opening document's registry
(vendor/path.ux/scripts/core/ui_base.ts:1757), registers window-level listeners, and reads
`window.innerWidth` and `devicePixelRatio` directly (ui_base.ts:2735, ui_base.ts:1689). A
popup gets a separate `CustomElementRegistry`, so path.ux elements moved into it never
upgrade. Supporting this requires teaching path.ux per-document registration, which is
substantial work in the vendored submodule for the smaller benefit. Option 1 gets separate
heaps and pays for them with explicit state routing, and that cost is visible.

### 4. One window stretched across monitors

A spanning window costs nothing and changes nothing, but it does not do what was asked. On
Windows, mixed-DPI displays make a spanning window look wrong on at least one display, and
the OS cannot maximize or snap it per screen. This is recorded so the question is not
asked again.

## Decisions this plan settles

- **Each window renders the project and does not hold its own document.** There is one
  main process, one `WorkspaceSession`, one `CommandStack`, and one project. Windows are
  views onto that project. The process, session, command stack and project each stay
  single, and only the address of the UI becomes plural.
- **An instance is per workspace, and opening a repo someone already has open hands off to
  them.** Two repos get two app instances, each with as many windows as the author wants;
  one repo always gets one instance. VS Code follows the same rule, and it covers the
  collisions described above, so the lock is on the project rather than on the app, and
  `app.requestSingleInstanceLock()` is deliberately not used. A launch that resolves to a
  workspace another live instance owns signals that instance to focus itself, then exits
  without showing a window. `workspace.open` behaves the same way and refuses the switch
  rather than opening a project twice. Nothing about the default changes: launching twice
  with no arguments still resolves both launches to the same most-recent project
  (index.ts:216), so the second launch leaves you with the one window you already had.
- **Undo is global by design.** Ctrl+Z in window B undoes the edit made in window A. Undo
  restores a shadow snapshot of the whole worktree (docs/command-system.md) rather than a
  per-pane edit buffer, so a per-window stack would misdescribe what it restores. The
  `undo` effect already carries `revision`, which lets each window distinguish an undo
  from an ordinary command (bridge.ts:236-244). That effect has to reach every window.
- **The window that ran a command answers its effects, and that origin is carried per
  execution.** `view.*` is the case that matters: "show me the coverage strip" shows the
  strip in the window whose palette or menu ran the command. Nothing carries the origin
  today, and the shared `CommandHost` cannot hold it — commands overlap, so a mutable
  field would be clobbered by the next palette command while a `pipeline.run` was still
  going. So `@vn/commands` gains the smallest workable notion of an origin (below),
  `handle()` starts passing `event.sender`, and `ctx.host.ui` takes a target. A command
  with no origin (from the agent, or from main itself) targets the focused window, or the
  most recently focused window if none is focused.
- **`@vn/commands` carries an origin on each execution and defines no window type.**
  `CommandStack.exec` takes `(id, props, source, origin?)` and `CommandContext` gains
  `origin?: number`, built as a per-exec shallow overlay on `opts.context`. The framework
  carries only the number. The desktop side interprets that number as a window id, and
  `CommandRecord` does not gain it, because a window index means nothing to a reader of
  `commands.jsonl` a week later. This is a real, deliberate amendment to "this plan
  touches no `@vn/*` package"; the alternatives were a mutable field that races or a
  second execution path, and both are worse.
- **Broadcast versus targeted is decided per effect type, not per channel.** `command:ui`
  carries nine effect types, and they differ: `view.*` and `palette` answer a question a
  window asked, while `undo`, `workspace` and `busy` report facts about the process. The
  third column of the table in [What is single-window today](#what-is-single-window-today)
  gives the rule.
- **`notify:changed` broadcasts, in full.** The note frame is a per-window surface (each
  window has its own menu bar), so an author looking at the other monitor still sees what
  happened, and the bell in every window shows a count that must stay correct. CLAUDE.md's
  "exactly one note frame survives" describes one window's chrome, not the install.
- **Selection is per-window.** `ShellState.sceneId` / `shotId` / `characterId` / `docPath`
  stay renderer-local. The request asks for a script on one monitor and the asset it
  produced on another; syncing the selections would collapse the two windows into one
  wider window. `pathux.selection` therefore becomes per-window like the layout.
- **All three window-shaped session keys go per-window** — `pathux.layout`,
  `pathux.selection` and `pathux.template` are flat today. `pathux.template` is the easy
  one to miss and it fails loudly: `view.applyLayout` in window A writes it, and
  `view.resetLayout` in window B then re-applies A's template to B
  (`commands/view.ts:230-235`). `vn.notifications.filter` and the recents list stay
  global, because they are install preferences rather than window facts.
- **Each window is stored by index, under the workspace it belongs to.** The keys are
  `pathux.<workspace>.window.<n>.layout`, `.selection`, and `.template`, plus a
  `pathux.<workspace>.windows` list holding each one's bounds, where `<workspace>` is a
  short digest of the root. The workspace segment is load-bearing, because `session.json`
  is install-global (sessionstore.ts:36-38). Without it, two instances on two repos write
  the same `pathux.window.0.layout` and open into each other's arrangement. Even within
  one instance, a `switchWorkspace` would carry a selection made of the previous project's
  scene ids into a project that has none of them. A new window takes the lowest free index
  within its workspace, so a closed-and-reopened window comes back into its own
  arrangement rather than a default screen. On launch, restore every stored window at its
  stored bounds; a window whose bounds land entirely off the current display set is
  clamped onto the nearest display rather than restored invisible.
- **The window list is rewritten from the live set, and frozen at `before-quit`.** A
  window closed deliberately stays closed, so `pathux.<workspace>.windows` is rewritten on
  `moved` / `resized` / `closed`. A quit closes every window in a cascade, which would
  rewrite the list down to nothing and lose the whole arrangement. To prevent that,
  `before-quit` snapshots the open set first and marks the list frozen for the rest of the
  process. The freeze applies per workspace rather than per process, because an instance
  only ever owns one workspace. The per-window `pathux.<workspace>.window.<n>.*` keys are
  left alone either way, because they are cheap and they make index reuse worth having.
- **A window knows its own index from its URL.** The index is passed as `?window=<n>`
  through `loadFile(…, { query })` or `loadURL`. The preload reads `location.search`
  before first paint, which is why `session.initial()` is `sendSync`
  (`src/preload/index.ts:14`). The index also lands in the CDP target list, which is what
  makes `--window` possible.
- **Closing the last window quits (non-macOS), closing any other does not.** The existing
  `window-all-closed` handler (`index.ts:617`) already states this. What changes is that a
  close now abandons the pending requests of that window alone, and that a quit must leave
  no process behind. The shutdown tests below check that no process survives a quit.
- **Ctrl+Q must stop being `window.close()`.** `bridge.quit()` calls `window.close()`
  (bridge.ts:184) and only quits because `window-all-closed` fires with one window open.
  Once a second window exists, the gesture the keymap labels `'Quit'` (keymap.ts:25)
  closes a window instead, so the label misstates what the control does. CLAUDE.md's
  tooltip rule forbids a control whose tooltip misstates it. Therefore the `window.*`
  namespace holds both commands: `window.close` on Ctrl+W and `window.quit` on Ctrl+Q.
  Main closing each window still fires that window's `will-prevent-unload`, so an unsaved
  draft still raises a prompt once per window.
- **`view.open where='window'` opens a new window.** It adds one more value to an existing
  enum rather than introducing a new command shape. Both halves of the enum grow — the
  `OpenWhere` union (`shared/editors.ts:140`) and the `OPEN_WHERE` array (`:142`) are
  written separately — and the two exhaustive `Record`s over it produce compile errors at
  every place that must handle the new value: `WHERE` in `commands/view.ts:28`, and
  `SPLIT` in `renderer/pathux/view.ts:90`, where `SPLIT[where]` is indexed at `:124`.
- **Every window carries the same project name, so the title has to distinguish the
  windows.** `nameWindow` exists because three windows all called `vnstudio` are
  indistinguishable in a list, and N windows on one project bring that problem straight
  back. The title therefore includes ` (n)` whenever more than one window is open, and
  drops it when only one window is left.

## Work

Staged so that each step is shippable and the first step is worth having on its own.

### Step 0 — one instance per workspace

Without this, launching the app twice on the same repo defeats every later step.
Electron's own global lock would instead be defeated by launching the app on two repos,
which we want to allow. So we use our own lock, keyed by the resolved workspace root.

- **Locking binds a listening socket rather than creating a file.** The process calls
  `net.createServer().listen(p)` at `\\.\pipe\vnstudio-<hash>` on Windows and
  `<tmpdir>/vnstudio-<hash>.sock` on posix, where `<hash>` is a digest of the canonical,
  case-normalized root. Binding the socket acquires the lock, and it succeeds for exactly
  one process. On Windows the pipe dies with the process, so there is no stale-pid
  bookkeeping and no lock that outlives a crash. On posix a stale socket file survives, so
  `EADDRINUSE` is followed by a connect attempt. A refused connect means the owner is
  gone, so the file is unlinked and the listen retried once.
- **Hands off by sending a message on that socket.** The arriving instance connects, sends
  `focus`, and exits before creating any window, so the user sees the existing instance
  come forward rather than a window that flashes and disappears. The owner focuses its
  most recently focused window.
- **It is acquired after `resolveWorkspace()`, not at the top of the ready path** — this
  is the one ordering constraint worth writing down. The root is not known until then, and
  that function can put up an interactive picker (index.ts:210-223), so an author may pick
  a repo that turns out to be taken. Handing off after the picker is correct, and VS Code
  does the same.
- **Releasing.** `switchWorkspace` acquires the new root's socket before it releases the
  old one, so a switch gives up a lock only once it holds the replacement. The server
  closes when the process quits.
- `workspace.open` gains a refusal, per the command system's declare-before-you-run rule:
  _"that project is already open in another window"_. Running it anyway focuses that
  instance instead of switching. `check` can race `run` here, because another instance may
  take the root in between, so `run` re-acquires for real and refuses again instead of
  relying on the earlier check.

- **The developer launcher's CDP port collides, and the launcher should report the port it
  uses.** `scripts/vndesktop.mjs:22` defaults the port to `9222` and passes it to the app,
  so two instances started from two repos request the same port: the second instance gets
  no debugger, and every later `vn-cdp.mjs` call drives the first repo while the output
  reads as though it drove the second. Nothing about the lock fixes this, because both
  instances are legitimate, so the launcher should take the first free port from `9222`
  upward and print the one it got (it already prints the port, `vndesktop.mjs:24`). The
  client half needs no change: `CDP_PORT` is already `VN_CDP_PORT ?? '9222'`
  (`cdp.mjs:9`), so `VN_CDP_PORT=9223 node scripts/vn-cdp.mjs …` reaches the second
  instance. `pageTarget`'s "the app has exactly one window" (`cdp.mjs:25-38`) belongs to
  step 1, not to this step — `--window` selects a window within an instance, and the port
  selects the instance.

State the undo-ref and committer collisions in `docs/desktopAppState.md`, replacing the
paragraph that presents "one app instance per window" as the design. Include that
`refs/vn/undo/<seq>` is a per-process namespace, which is why the lock is per workspace.
Two processes may share an install, but they never share a project.

**Files:** `src/main/index.ts`, new `src/main/instancelock.ts`,
`src/main/commands/workspace.ts`, `scripts/vndesktop.mjs`, `docs/desktopAppState.md`.

### Step 1 — a window registry and routed effects

This step builds the mechanical core. Nothing changes that the user can see; once it
lands, a second window would work if anything created one.

- **`src/main/windows.ts` is new, and it does not import `electron`.** `src/main/index.ts`
  is the only module under `src/main/` that does, and every other one has an electron-free
  test beside it in `src/main/tests/` — the jest desktop project is node-only and there is
  no `electron` mapper in `jest.config.cjs`. So `Windows<W>` is generic over an opaque
  handle: `create()`, `all()`, `focused()`, `byHandle(sender)`, `close(id)`,
  lowest-free-index allocation, and `clampBounds` against an injected display list.
  `index.ts` instantiates `Windows<BrowserWindow>` and keeps the `BrowserWindow`
  construction, including the `before-input-event` and `will-prevent-unload` handlers,
  which are also fixed here to act on their own window rather than the module global.
- Split the pushes as shown in the table above. Use `broadcast(channel, payload)` for
  `agent:event`, `notify:changed`, `session:changed`, `log`, and the `undo` / `workspace`
  / `busy` effects. Use `send(target, …)` for `view.*`, `palette`, and the three
  `permission:*` requests.
- **Thread the origin.** `@vn/commands` gains `CommandContext.origin?: number`, and
  `CommandStack.exec(id, props, source, origin?)` builds
  `{ ...this.opts.context, origin }` per execution rather than reusing the shared object.
  On the desktop side, `handle()` gains the sender
  (`ipcMain.handle(channel, (event, ...args) => fn(event, ...args))`), `command:exec`
  resolves an originating window from it, `CommandHost.ui` becomes
  `(effect: UiEffect, target?: WindowId)`, and the 13 `host.ui(` call sites across
  `commands/{art,asset,notify,upload,view}.ts` and `index.ts` pass `ctx.origin`.
- `Pending<T>` records the window each request went to; `abandon()` gains a `by(windowId)`
  form so a close ends only its own turns. `requestPlan` / `requestAnswer` /
  `requestConfirm` ask the window that started the agent turn, and re-ask the focused
  window if that one is gone mid-turn. Main remembers the starting window from
  `agent:run`'s sender, and there is one conversation, so there is one in-flight turn. A
  request also focuses its window. `agent:event` broadcasts, so every window shows the
  agent thinking, and a prompt that lands in an unfocused window would otherwise read as a
  hung turn on whichever monitor the author is looking at.
- `pickDirectory` and `pickFiles` parent to their originating window, and their throw
  changes from "there is no window to show a chooser in" to "that window is gone".
- `nameWindow` titles every window and appends ` (n)` when more than one window is open.
- `switchWorkspace` broadcasts and every window remounts. The workspace is process-wide,
  so opening another project tears down all of them.
- **CDP gets its rule here, not later.** `?window=<n>` on the loaded URL puts the index in
  the CDP target's `url`, so `pageTarget(n)` in `scripts/cdp.mjs` can select
  deterministically instead of `targets.find(t => t.type === 'page')`; `vn-cdp.mjs` grows
  `--window <n>`, defaulting to 0. This cannot wait for step 3, because `window.new` is
  reachable from CDP, so the tool used to verify the feature goes nondeterministic exactly
  when the feature lands. The two-call `window.__x` pattern in docs/debugGuide.md
  (:223-224, :242-243) shows the cost most sharply: the stash and the read are separate
  invocations and would silently land in different renderers.

**Files:** `packages/commands/src/{command,stack}.ts`, `src/main/index.ts`, new
`src/main/windows.ts`, `src/main/commands/host.ts`,
`src/main/commands/{art,asset,notify,upload,view}.ts`, `scripts/cdp.mjs`,
`scripts/vn-cdp.mjs`, `docs/debugGuide.md`.

### Step 2 — per-window persistence

- The renderer reads its index from `location.search`, which the preload already has
  before first paint. `additionalArguments` on `webPreferences` is the fallback if the
  query string turns out to be unreliable, but the URL already carries the same value, and
  CDP reads the URL too.
- `persist.ts` keys become `pathux.<workspace>.window.<n>.layout` / `.selection`, and
  `commands/view.ts`'s `TEMPLATE_KEY` (view.ts:26, today the module constant
  `pathux.template`) becomes `pathux.<workspace>.window.<n>.template`. `TEMPLATE_KEY` then
  stops being a module constant and is derived from `ctx.origin`, like any other targeted
  operation. Both halves of the key are needed. `<n>` keeps two windows of one project
  from sharing a mesh. `<workspace>` is needed because `session.json` is install-global
  (sessionstore.ts:36-38), and two instances on two repos would otherwise write over each
  other's window 0.
- A legacy flat `pathux.layout` / `pathux.selection` / `pathux.template` is read once as
  the layout, selection and template of window 0 in whichever workspace opens first, then
  left alone, so an existing install does not open to a default screen.
- Main writes `pathux.<workspace>.windows` (the bounds and display of each open window) on
  `moved`, `resized` and `closed`, debounced the same way as the session store's own
  flush. The write is frozen at `before-quit`, per the decision above, and main restores
  the windows from that key at launch. Bounds are clamped against
  `screen.getAllDisplays()` before use.

**Files:** `renderer/pathux/persist.ts`, `src/main/commands/view.ts`,
`src/main/windows.ts`, `src/main/index.ts`.

### Step 3 — the vocabulary

- `window.new` (opens a window, optionally with `editor` and `subject`, so that opening a
  subject on another screen takes one command), `window.close`, and `window.quit`.
  Registered in `src/main/commands/` like everything else, so the palette, the menu bar,
  CDP and the agent all reach them, which is the one-registry rule in
  docs/command-system.md.
- `OpenWhere` and `OPEN_WHERE` gain `'window'`; `view.open` routes `'window'` to
  `window.new` rather than to the mesh, and `WHERE` and `SPLIT` gain clauses for it.
- The header gains a `Window` menu holding New Window and Close Window, or the same
  entries in the app menu beside `Split Area` (editors/header.ts:475). The keymap adds
  `Ctrl+Shift+N`, which is free today, binds `Ctrl+W` to `window.close`, and repoints
  `Ctrl+Q` from `bridge.quit()`'s bare `window.close()` to `window.quit`.
- The pane context menu gains a "Move to New Window" item, which runs
  `window.new(editor=… subject=…)` followed by `view.close` in the source window. This
  uses two commands (both already refusable) rather than a bespoke move.

**Files:** new `src/main/commands/window.ts`, `src/main/commands/index.ts`,
`src/shared/editors.ts`, `src/main/commands/view.ts`, `renderer/pathux/view.ts`,
`renderer/pathux/bridge.ts`, `renderer/pathux/editors/header.ts`,
`renderer/pathux/keymap.ts`.

### Step 4 — torn-off editor windows (optional)

The `bare` flag creates a window with no header editor and a single pane, and skips
`ensureHeader` (shell.ts:157). `window.close` closes it. The rest reuses step 1's
plumbing. Cut this first if the plan runs long, because it polishes a working feature
rather than completing one.

## What each step does not change

- The pipeline, the scheduler, the store, and every `@vn/*` package except `@vn/commands`,
  which gains an optional per-execution `origin` and nothing else. See the decision above
  for why that amendment is load-bearing rather than incidental.
- The command registry adds `window.*` as another namespace, and `view.*` takes one more
  enum value.
- Windows only display state. Every write is made by a command.

## Open questions

- **Does a window id need to cross the wire?** Only if the renderer must name a window
  other than its own (e.g. "open this in window 2"). If every cross-window act is
  expressed as `where='window'` (a new one) or as origin-follows-the-sender, window
  identity stays in main and `shared/ipc.ts` carries no window id. Prefer that until
  something requires a window id on the wire. (The renderer does receive its own index,
  but from its URL rather than over an IPC channel.)
- **What happens to unsaved drafts when the workspace switches?** `switchWorkspace`
  broadcasts a remount rather than an unload, so no window's `will-prevent-unload` guard
  runs and every window's unsaved wiki draft is dropped. That is already true of the one
  window today. With N windows it is N times as easy to hit, and the author only
  authorized the switch in one of them. Either accept that, or have `workspace.open`
  refuse while any window reports a draft.
- **The Play editor's saves are per-origin.** The `localStorage` key
  `vn.runner.save.<title>` (`play/playback.ts:105`) is shared across windows, so two Play
  editors clobber each other's playthrough. Two instances have the same failure today.
  Either accept it (a second Play editor is an odd thing to want) or key the save per
  window.
- **Mixed-DPI monitors.** path.ux's `_calcSizeKey` includes `devicePixelRatio`
  (vendor/path.ux/scripts/screen/FrameManager.ts:984), so dragging a window between
  displays of different scaling ought to re-key and rescale on the update loop. Verify
  this live over CDP before claiming it. If it does not rescale, add a `setCSS` and a
  `completeUpdate` on the window's `display-changed`.

## Testing

### Unit — node, no Electron

- **`src/main/tests/windows.test.ts`** for `Windows<W>`: registry lifecycle, `byHandle`
  resolution, lowest-free-index allocation across a close and a reopen,
  `Pending.by(windowId)` abandoning one window's requests and no others, bounds clamping
  against a synthetic display set, and the window-list freeze at quit. Every one of these
  tests runs over injected handles alone, which is why `windows.ts` may not import
  `electron`. That restriction is deliberate, not accidental.
- **`@vn/commands`** supplies the per-exec origin. Two overlapping `exec` calls each see
  their own `ctx.origin`, and an `exec` with no origin leaves `ctx.origin` set to
  `undefined` (the existing single-context behaviour, unchanged).
- **Renderer** owns the persistence keying. It determines which key a given window index
  reads and writes, and it migrates the legacy flat keys for all three of layout,
  selection and template.

### Integration — shutdown leaves no process behind

Closing a window must terminate its process tree. A window registry makes this failure
possible and a single-window app cannot have it: main now holds a handle per window,
`Pending` holds parked promises per window, and `before-quit` already `preventDefault()`s
to flush the session store (index.ts:625-631). Any one of those can keep the main process
alive after the last window is gone. A headless Electron process with no window is
invisible, survives the next launch, and holds step 0's workspace socket, so the repo it
was showing can never be reopened: the next launch connects to that headless process,
sends it a `focus` that no window will answer, and exits. This failure mode is worth a
real integration test rather than a manual check, and it is why case 1 below tests the
single-window app that already works.

Add a new `apps/desktop/tests/shutdown.test.ts`. It runs as its own jest project (or as a
plain node script under `scripts/` invoked in CI), because it spawns a real Electron and
so cannot live in the node-only `@vn/desktop` jest project. The test spawns the built app
the way `scripts/vndesktop.mjs` does, but without `shell: true`, because on Windows a
shell wrapper hands back the shell's pid and the test needs Electron's own. It drives the
app over CDP, and after each shutdown it asserts the whole process tree is gone. An
Electron app is a main process plus renderer, GPU and utility processes, and the helpers
get orphaned, so asserting on the main pid alone would pass while leaking.

There are three cases, and the multi-window cases are the important ones:

1.  1. **One window, closed.** Launch, wait for the CDP page target, close the only
       window, assert the process exits within a bounded wait and no child of the spawned
       pid survives it. This baseline must not regress. The behaviour works today, and
       every later step changes the code that produces it.
2.  2. **Three windows, closed one at a time, last one last.** Launch, call `window.new`
       twice over CDP, then close each window in turn. After each of the first two closes,
       assert the process is still running and that exactly one renderer process went
       away; a close that takes the whole app down is a bug of the opposite kind and just
       as wrong. After the third close, assert the tree is gone.
3.  3. **Three windows, quit outright.** Uses the same setup, then calls `window.quit`
       (and, separately, closes the last remaining window through the platform). Asserts
       that the `before-quit` flush completes rather than parking. The handler is bounded
       by `QUIT_FLUSH_MS` (2s), so the test's own timeout must be comfortably larger, and
       a failure here means the deadline race is not exercised.

Each case runs against a scratch workspace (`--project` into a temp dir, `--mock`) so a
stray `SessionStore` lock or a half-written `session.json` is diagnosable rather than
shared. Two variants are worth adding once the plumbing exists, because each is a case
where a window keeps a handle alive: closing a window with a parked agent turn (the
`Pending.by` path, where the turn must end rather than hold the process), and closing a
window with an unsaved draft (answering the `will-prevent-unload` dialog both ways).

### Live over CDP

docs/desktop-app.md requires that surfaces be verified live. Open two windows and confirm
that a `view.open` in one lands in that window, that an undo in one refreshes both, that a
notification appears in both, that an agent plan prompt appears in and focuses the window
that started the turn, that Ctrl+Q quits rather than closes, and that a layout survives a
restart on two monitors. Use `--window` to drive the check, so that flag is step 1's
problem.

Two instances on two repos are worth one live pass of their own. Each instance keeps its
windows, layouts and notifications in its own repo, and launching on a root that is
already open focuses the owner instead of opening anything. The pass needs the port change
from step 0 before it is drivable at all, since both instances otherwise answer to `9222`.

## Docs to update when this ships

- `docs/desktop-app.md` — the shell section, which explains that a window is a renderer
  and names what exists once per process and what exists once per window.
- `docs/desktopAppState.md` covers the workspace-scoped per-window keys, the window list,
  the undo-ref and committer collisions, and the corrected "multiple windows" edge case.
- docs/command-system.md — Document the `window.*` namespace, `view.*`'s new `where`, and
  the per-execution origin. The origin is deliberately absent from `CommandRecord`.
- docs/debugGuide.md documents `--window`, explains why the two-call `window.__x` pattern
  needs it, and records the CDP port the launcher actually took.
- `CLAUDE.md` — holds one line under the desktop-app bullets that points here.

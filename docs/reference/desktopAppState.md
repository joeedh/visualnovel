# Desktop App State Model

<!-- toc -->

- [State Categories](#state-categories)
  * [1. Playthrough State (Persistent via localStorage)](#1-playthrough-state-persistent-via-localstorage)
  * [2. Remembered UI State (Persistent via the desktop session store)](#2-remembered-ui-state-persistent-via-the-desktop-session-store)
  * [3. UI State (Ephemeral, in the shell)](#3-ui-state-ephemeral-in-the-shell)
  * [4. Backend State (Main Process, Ephemeral)](#4-backend-state-main-process-ephemeral)
  * [5. Project Files (Persistent on Disk)](#5-project-files-persistent-on-disk)
- [Data Flow](#data-flow)
  * [1. Initial App Load](#1-initial-app-load)
  * [2. User Types in the Convo Editor](#2-user-types-in-the-convo-editor)
  * [3. Plan Approval Gate](#3-plan-approval-gate)
  * [4. Playthrough (Play editor)](#4-playthrough-play-editor)
  * [5. Pipeline Execution](#5-pipeline-execution)
- [Persistence Summary](#persistence-summary)
- [Rebuilding After Restart](#rebuilding-after-restart)
- [IPC Contract](#ipc-contract)
- [Design Rationale](#design-rationale)
  * [Why so little persistent UI state?](#why-so-little-persistent-ui-state)
  * [Why a main-process file, not localStorage, for the layout?](#why-a-main-process-file-not-localstorage-for-the-layout)
  * [Why the arrangement lives in the project rather than the install?](#why-the-arrangement-lives-in-the-project-rather-than-the-install)
  * [Why re-read project files on each call?](#why-re-read-project-files-on-each-call)
  * [Why localStorage for playthrough?](#why-localstorage-for-playthrough)
  * [Why build the playable on-demand?](#why-build-the-playable-on-demand)
- [Edge Cases](#edge-cases)
  * [App restarts mid-run](#app-restarts-mid-run)
  * [User edits a file while app is running](#user-edits-a-file-while-app-is-running)
  * [Multiple windows of the same workspace](#multiple-windows-of-the-same-workspace)
  * [Switching workspaces](#switching-workspaces)

<!-- tocstop -->

The desktop app (`apps/desktop`) uses a **minimal, file-based state model** where persistent state lives in project files and browser storage, while in-memory state is ephemeral and rebuilt on demand.

## State Categories

### 1. Playthrough State (Persistent via localStorage)

**What:** The player's current position and save files in the Play editor.

**Storage:** `localStorage` with key `vn.runner.save.${playable.title}`

**Shape:**
```typescript
interface Pos {
  sceneId: string;
  frameIndex: number;
}

// Stored as JSON array
Pos[]  // e.g. [{ sceneId: "arrival", frameIndex: 0 }, { sceneId: "greet", frameIndex: 2 }]
```

**Lifecycle:**
- On first load of a playable: Initialize from `story.play.json`'s `start` scene at frame 0
- On each advance/back: Update history array in memory
- **Save button:** Serializes history to `localStorage`
- **Load button:** Deserializes from `localStorage` back to memory
- **Reset button:** Clears history, returns to start scene
- **Survives:** Page reload, app restart
- **Lost when:** Browser storage is cleared, user uses incognito/private browsing

**Code:** `renderer/pathux/play/playback.ts` (`saveKey`, the save blob — the pure half, tested) and
`renderer/pathux/editors/play.ts` (the `localStorage` calls themselves)

---

### 2. Remembered UI State (Persistent via the desktop session store)

**What:** The arrangement of panes the user built, and the selection they left in it.

**Storage:** two files, both `SessionStore` (`src/main/sessionstore.ts`), which is a flat
key/value store over one directory:

| File | Holds | Notes |
|------|-------|-------|
| `<root>/.vnstudio/session.json` | every `pathux.` key: the mesh, the selection, the applied template, the window list | the project's own, beside its layout templates. **Gitignored** |
| `<userConfigDir()>/desktop/session.json` | `agent.budget`, `vn.notifications.filter`, the recents list | the install's, `%LOCALAPPDATA%\vnauthor\desktop` on Windows (override with `VN_DESKTOP_HOME`) |

The install file is the same home `@vn/config` gives API keys: outside the repo, and outside the
bundle on purpose, because a packaged app's `__dirname` is inside `app.asar`, which is a file.

The arrangement is the project's because that is the unit an author moves. It used to live in the
install file under a key carrying a digest of the project path, so renaming the directory lost the
arrangement, a second install opened the project to a default screen, and clearing one project's
state cleared every project's. It is gitignored rather than committed because it changes on every
border drag: a tracked file would churn `git status`, conflict on every pull, and make
`UndoJournal.check` refuse every undo, since `Git.writeTree` runs `git add -A` in a scratch index
and would see the file move. The shareable half of an arrangement is a
[layout template](desktop-app.md#layout-templates), which _is_ committed. The ignore entry is the
glob `.vnstudio/session.json*`, because `writeFileAtomic` leaves a `.tmp-<hex>` sibling during a
write.

The ignore entry is also the only thing keeping the file out of an undo snapshot. `UNDO_PATHS`
deliberately does not list it: `git add -A` fails outright when a pathspec names an ignored file,
and `:(exclude)<file>` counts as naming one, so a fourth entry there made every snapshot throw and
left every command with no undo point at all. `writeScaffolding` rewrites the ignore line on every
open, so a hand-edited `.gitignore` is repaired rather than guarded against.

**Shape:** a flat `Record<string, SessionValue>` with dotted keys. The three that describe a
window are scoped **by window index**, built in `src/shared/sessionkeys.ts`:
`pathux.window.<n>.{layout,selection,template}`, plus one list, `pathux.windows`. `<n>` is the
index main handed the window.

```jsonc
{
  "pathux.window.0.layout": { /* nstructjs-serialized screen, magic "VNSC" */ },
  "pathux.window.0.template": "writing",
  "pathux.window.0.selection": {
    "sceneId": "arrival",
    "shotId": "",
    "characterId": "aiko",
    "docPath": "characters/aiko/character.md",
    "assetHash": "9f2c…",
    "taskHash": "",
  },
  "pathux.window.1.layout": { /* the second window's own mesh */ },
  "pathux.windows": [{ "id": 0, "bounds": { "x": 0, "y": 0, "width": 1360, "height": 860 } }],
}
```

The window index is load-bearing, and the template is where a flat key failed loudly:
`view.applyLayout` in window A wrote `pathux.template`, and `view.resetLayout` in window B then
re-applied **A's** template to B.

**Which file a key lands in is decided by the key alone.** `isProjectKey` is the single authority
and answers by prefix: a `pathux.` key that is not one of the flat legacy names belongs to the
project. `SessionState` (`src/main/sessionstate.ts`) holds both stores and routes every read and
write, and `CommandHost.state` is that router rather than a store — otherwise `view.*` would keep
writing the template to the install file, and `view.resetLayout` in project B would re-apply
project A's template. The renderer sees one merged snapshot, so nothing in it has to know there
are two files.

A renderer learns which window it is from its own url (`?window=<n>&ws=<scope>`), not over IPC:
the layout and the selection are restored before the first paint, and `workspace.index()` has not
come back yet. `ws` is the workspace digest, and every project-key write carries it, so main can
drop a write made by a window that has not finished reloading after a workspace switch. The flat
`pathux.{layout,selection,template}` an older install left behind are read **once**, as window 0,
and never written again; a project opened for the first time seeds its file from the install's
keys for that workspace, leaving the install's copies in place.

A project whose `.vnstudio` cannot be opened keeps no arrangement, after one logged warning:
reads answer the default and project-key writes are dropped. The install file is unaffected,
because a preference is not the project's to lose.

**Lifecycle:**
- Main opens the store during `app.whenReady()`, before any window exists
- The preload reads the whole snapshot **synchronously** (`session:snapshot:sync`) so the
  renderer's first paint is already the remembered layout — an async fetch would render the
  default and then jump
- `pathux/persist.ts` writes both keys, debounced 400 ms, and again on `beforeunload` — a quit
  does not run the debounce. The layout reports through `VnScreen.onLayoutChange` (every split,
  join, border drag and window resize); the selection through `DataPathWatcher`s on `ui.sceneId`
  / `ui.shotId` / `ui.characterId` / `ui.docPath` / `ui.assetHash` / `ui.taskHash`, which is the
  same push the widgets get. Every persisted field needs a watcher of its own, because clicking an
  asset moves no other field and nothing else would schedule the save
- **A selection field announces its own write** (`ShellState.onSelect`, wired to `api.notifyChange`
  in `renderer/pathux/shell.ts`). Editors assign `ui.sceneId` and its five siblings as plain
  properties, and path.ux wakes a `DataPathWatcher` only from its own `setValue`, so without the
  hook the watchers above never fire and nothing is saved. The six fields are accessors over one
  private record for that reason; an unchanged value reports nothing
- **Those watchers are `immediate` rather than the default `raf`.** A hidden or minimized window
  runs no animation frames, so a raf-coalesced watcher stays dirty until the window is shown again
  and a quit in between loses the selection. `schedule` has a 400 ms debounce of its own
- **A `view.*` effect schedules the save itself** (`applyView` in `renderer/pathux/view.ts`, on any
  effect the mesh did not correct). A pane that swaps editors leaves the mesh the same shape, so
  `onLayoutChange` does not fire, and without this the window comes back showing whatever it showed
  before the swap
- **A restored id is checked against the project, once, after the first paint** (`settleSelection`
  in `renderer/pathux/shell.ts`, deciding through `renderer/rules/uistate.ts`). One `asset.info`
  repairs `assetHash`: it fails for a hash the manifest no longer holds, which clears the
  selection, and carries `newerTake` for a take a later render replaced, which the selection
  follows. `sceneId` and `characterId` are cleared when the workspace index does not list them,
  and `shotId` goes with its scene. `docPath` is **not** pruned, because the doc tree caps a
  branch and has a second file-tree mode, so absence from a fetched tree is not evidence the file
  is gone. Every write back is guarded on the field still holding what restore put there, since
  the author may have clicked something in between
- `ui.taskHash` is persisted with no repair rule: a task hash is `sha256(kind, inputs)` and is
  stable while the inputs are, and the inspector already answers one the current status does not
  carry by fetching once and drawing nothing
- **A workspace switch reloads every window** rather than re-applying in place, so each one
  re-runs the boot path against the newly opened project's file
- **A field a pane remembers rides in the layout blob**, not beside it: `registerEditor` takes an
  optional `fields` list and nstructjs writes those properties into the pane's own struct, so the
  documents editor's tree/file mode survives a restart *and* survives being torn into a new pane.
  Nothing about the screen's shape moves when one changes, so the editor calls `layoutChanged()`
  itself — `onLayoutChange` cannot see inside a pane
- The layout is nstructjs through path.ux's own `simple.saveFile`/`loadFile`, which stamp the
  struct schema into the blob, so a layout written before path.ux changed a `STRUCT` still reads
  back. Nothing here may block boot: a layout that will not load — corrupt, or naming an editor
  this build has not got — is discarded and the default screen takes its place
- the template key is the odd one out: it is written by **main**, in `view.applyLayout` /
  `view.saveLayout` / `view.resetLayout`, and it is a *pointer into the project* — the slug of the
  layout template the window is showing. Main derives *which* window's key from `ctx.origin`; a
  command with no origin — the agent, CDP — uses the focused window, because that is where its
  effect lands. The arrangement itself still lives in `pathux.window.<n>.layout`,
  because which panes are open is a window fact even when a project named the arrangement. See
  [Layout templates](desktop-app.md#layout-templates)
- Writes are merged **per key** under a `mkdir` lock, so two running instances don't clobber
  each other's keys (same key is last-flush-wins)
- **Survives:** app restart, and renaming or copying the project directory. **Lost when:** the
  file is deleted, or the project is cloned somewhere else, since git does not carry it

**Code:** `src/main/sessionstate.ts`, `src/main/sessionstore.ts`, `src/shared/sessionkeys.ts`,
`renderer/pathux/persist.ts`, `renderer/rules/uistate.ts`

---

### 3. UI State (Ephemeral, in the shell)

**What:** Everything the author sees and interacts with that is not a project file — the
selection, the conversation, the pipeline status, what the header says.

**Storage:** renderer memory, in two modules and whatever an editor keeps for its own gesture.

**`ShellState` (`renderer/pathux/state.ts`)** is the root of the path.ux DataAPI and the only
thing a widget may bind to. Document state never lands here: `@vn/commands` is the write path, so
a widget that would change the project dispatches a command instead.

| Field | Type | Notes |
|-------|------|-------|
| `sceneId` / `shotId` / `characterId` | `string` (`''` = nothing) | The one authored selection every editor observes, and any editor may publish. **Persisted** (category 2) |
| `docPath` | `string` (`''` = nothing) | Which document the wiki editor is on — the fourth selection field, and the one that names a **path** rather than an id, because a free-form note under `wiki/` has no id. `view.open`/`view.focus` publish it from their `subject` prop. **Persisted** (category 2) |
| `taskHash` | `string` | Which task the inspector is open on. **Persisted** (category 2), with no repair rule: the hash is stable while its inputs are, and the inspector draws nothing for one it cannot find |
| `assetHash` | `string` | Which asset the asset editor is open on. **Persisted** (category 2), and repaired at boot through one `asset.info` |
| `projectTitle` | `string` | Pushed from `workspace:index` |
| `model` | `string` | Text model id, for the header badge |
| `agentMode` | `'plan' \| 'execute'` | Mirrored from `agent.setMode`'s outcome and from `agent:event` |
| `errors` / `warnings` | `number` | Diagnostics counted apart; errors displace warnings in the badge |
| `unread` | `number` | What the bell shows: unread, unarchived notifications matching the active filter. Written by `pathux/notifications.ts`, never counted in the header, so the badge and the list cannot disagree |
| `canUndo` / `canRedo` / `undoLabel` / `redoLabel` | `boolean` / `string` | Pushed on the `command:ui` `undo` effect |

**The conversation (`renderer/pathux/agent.ts` + `src/shared/convo.ts`)** is a second module, subscribed at
boot whether or not a convo pane is open — the agent streams regardless, and a pane opened later
has to show what was already said. The value is `{ feed, line, plan, busy, seq }` and every
`agent:event` folds into it through the pure `received`/`asked`/`answered`/`proposed`/`decided`
functions; a pane notices by comparing a revision counter, since `update()` runs every frame.
`busy` is raised by a pipeline run too, not only by a turn.

The reducer itself lives in `src/shared/convo.ts` because **main runs it as well** — every feed
item it folds in is the line main appends to the open thread, so the transcript on disk is the
transcript on screen rather than a second rendering of the same events.

- **Nothing here decides which editor is on screen.** The `view.*` commands run in **main** and
  push a `command:ui` effect; the mesh applies it and answers with a correction only when it
  disagrees — see [`command-system.md`](command-system.md). The screen itself *is* the state, and
  it is persisted as one blob rather than as fields.
- **Per-editor state stays in the editor**, and is what a redraw key excludes on purpose: a draft
  being typed, a live gesture, a scroll position. path.ux calls `update()` every frame, so keying a
  rebuild on what is being typed would replace the field under the caret.
- **The workspace index is re-read, never remounted.** An edit an editor made itself re-reads
  `workspace:index` so diagnostics and the cast are current; there is no revision counter
  remounting a pane mid-gesture.
- **Lost on:** page reload, app restart (no persistence) — except the selection, which is category 2.

---

### 4. Backend State (Main Process, Ephemeral)

**What:** The server-side context that runs the agent, holds loaded models, and mediates file I/O.

**Storage:** In-memory `WorkspaceSession` instance (one per workspace)

**Shape:**
```typescript
class WorkspaceSession {
  dir: string                // Workspace root
  mock: boolean              // Offline mode?
  agent?: Agent              // Lazy-initialized
  model: string              // Text model id
  
  // Accessed via methods that rebuild on-demand:
  // - ensureAgent()    → loads/reuses Agent
  // - buildBackend()   → creates ChatBackend for configured model
  // - loadProject()    → reads config, model, store, graph from files
}
```

**What gets built on-demand:**
| Resource | Built by | Cached? | What it holds |
|----------|----------|---------|---------------|
| `Agent` | `ensureAgent()` | Yes (lazily) | Conversation history, current mode, backend |
| `ProjectConfig` | `loadProject()` | No (re-read each call) | project.yaml parsed + validated |
| `ProjectModel` | `loadProject()` | No (re-read each call) | Characters, locations, scenes, validated story graph |
| `AssetStore` | `loadProject()` | No (re-read each call) | `build/assets/` index + `manifest.json` |
| `TaskGraph` | `loadProject()` | No (re-read each call) | `state/tasks.jsonl` parsed into task nodes |
| `ChatBackend` | `buildBackend()` | Yes (per Agent) | Anthropic or Gemini client |

**Lifecycle:**
- Created when the app loads a workspace
- `Agent` initialized on first user input (`agent:run` IPC call)
- Project data (config, model, store, graph) rebuilt on each IPC method call that needs it
  - This is intentional: ensures the latest disk state is always read
  - No caching of project state between calls
- **Lost on:** App restart (everything is rebuilt from files)

**Hot-swapping:**
- Model can be switched mid-conversation via `agent:setModel(newModelId)` → rebuilds `ChatBackend`, preserves Agent conversation state
- Mode toggled via `agent:setMode()` without losing context

**Code:** `WorkspaceSession` in `src/main/session.ts`

---

### 5. Project Files (Persistent on Disk)

**What:** The authored inputs and generated outputs—the source of truth for everything else.

**Locations:**
```
<workspace>/
├── project.yaml              # Config: title, models, API key env vars, `start:` (entry scene)
├── characters/
│   ├── <id>/character.md     # Character front-matter + prose
│   └── …
├── locations/
│   ├── <id>.md               # Location description
│   └── …
├── scenes/
│   ├── <id>.md               # One scene: `scene: <id>` front-matter + one-scene Fountain body
│   └── …
├── screenplay/               # RETIRED, never read: the whole branching script in one file
│   ├── *.fountain            # (reported on every load — run `vngen import` / `workspace.import`)
│   └── …
├── vngen/
│   ├── build/
│   │   ├── assets/
│   │   │   └── <sha256>.<ext>  # Content-addressed image bytes
│   │   ├── manifest.json       # Provenance index (which task produced what asset)
│   │   └── story.play.json     # The playable, written by `vngen export`
│   ├── state/
│   │   ├── tasks.jsonl         # Append-only task status log (crash recovery + resume)
│   │   ├── commands.jsonl      # Append-only CommandRecord log (provenance + undo)
│   │   ├── notifications.jsonl # Append-only notification log; `r`/`h` patched in place
│   │   └── reviews/<taskHash>  # Vision-review reports per task
│   └── work/
│       ├── story.graph.mmd     # Mermaid diagram of story branches
│       ├── characters/<id>/
│       │   ├── approved.png    # The approved portrait for that character
│       │   ├── candidates/     # Portraits awaiting approval
│       │   └── outfits/<outfit>/sheet/
│       ├── locations/<id>/
│       │   ├── breakdown.md    # P1 location breakdown
│       │   └── refs/           # Reference plates
│       └── shots/<sceneId>.json  # Persisted shot decomposition (preferred once it exists)
└── keys/                     # API keys (gitignored)
    └── …
```

Paths are not spelled out anywhere but `packages/store/src/paths.ts`; that module is the
single authority and this tree is a reading of it. Which scene files a project actually has is
decided in one place too — `loadInputs` (`packages/store/src/worktree.ts`), which reads `scenes/`
and only *reports* a leftover `screenplay/`.

**What's committed:**
- `project.yaml`, characters, locations, scenes
- `vngen/` generated outputs (graph, manifest, assets)
- Not committed: `keys/`, `.env` files

**Read by main process via:**
- `@vn/config` — parses `project.yaml`
- `@vn/parse` — parses Fountain (a `scenes/<id>.md` body or a whole `.fountain`) and front-matter
- `@vn/store` — reads characters/locations, indexes `build/assets/`
- `@vn/model` — validates and builds the story graph
- `@vn/taskgraph` — reads `state/tasks.jsonl`
- `@vn/git` — wraps git CLI for diff/commit/log

---

## Data Flow

### 1. Initial App Load
```
Renderer                         Main                     Files
────────────────────────────────────────────────────────────
  preload
       ├─ sendSync('session:snapshot:sync')
       │    └─────────────────────→ SessionState.snapshot()
       │                             ├─ desktop/session.json  (this install)
       │                             └─ .vnstudio/session.json (this project)
       │    ←──────────────────── the two, as one map
       │
  shell.start(), before the first paint
       ├─ restoreLayout / restoreSelection, off that map
       │
  installBridge (shell boot)
       │
       ├─ invoke('workspace:index')
       │    └─────────────────────→ ensureAgent()
       │                            loadProject()
       │                             ├─ readConfig()  ──→ project.yaml
       │                             ├─ buildModel()  ──→ characters/, scenes/
       │                             ├─ openStore()   ──→ manifest.json
       │                             └─ loadGraph()   ──→ tasks.jsonl
       │    ←──────────────────── return WorkspaceIndex
       │
       └─ ui.projectTitle / ui.errors / ui.warnings → notifyChange()

  shell.start() tail, after the first paint
       └─ settleSelection(restored)
            ├─ asset.info      → repair or clear ui.assetHash
            └─ workspace:index → clear a scene or character it does not list
```

### 2. User Types in the Convo Editor
```
User types message
  ↓
ask() runs the `agent.run` command through the bridge
  ├─ asked(convo, text)   → transcript shows it, busy = true
  └─ exec('agent.run', { input })
       ↓
       Main: runAgent(text)
         ├─ ensureAgent() [cached if already running]
         ├─ agent.run(input)
         │   ├─ Model (LLM) call
         │   ├─ Tool execution (read/edit files)
         │   └─ Emit AgentEvent for each step
         │
       ←─ agent.ts receives AgentEvents via 'agent:event' IPC
         └─ received(convo, event) → feed / line, revision++
       ↓
       answered(convo, outcome.record.message) → busy = false
  ↓
Every open convo pane redraws; the turn is one CommandRecord
```

### 3. Plan Approval Gate
```
agent.run() encounters a mutating tool
  ├─ Emits permission request
  │
  └─ deps.requestPlan() (main) 
       ↓
       Sends IPC: 'permission:plan'
       ↓
       Renderer receives plan
         ├─ proposed(convo, request)
         └─ Convo pane draws the plan card with Approve/Reject
       ↓
       User clicks Approve
         ├─ invoke('plan:decision', { id, decision: { approved: true } })
         │    └─→ deps.requestPlan() resolves
         │
       └─ agent.run() continues → executes tool → edits file

       If Rejected: agent.run() cancels that tool
```

### 4. Playthrough (Play editor)
```
A pane switches to the Play editor
  ↓
PlayEditor.init()
  ├─ invoke('story:play')
  │    └─→ loadProject()
  │        ├─ Read project.yaml, characters, scenes
  │        ├─ Build model
  │        ├─ Read manifest.json + assets/
  │        └─ buildPlayable(model, store) → Playable JSON
  │
  └─ history = [{ sceneId: start, frameIndex: 0 }]
       └─ framesOf(scene) (pure, playback.ts)

User clicks to advance
  ├─ frameIndex++
  ├─ Derived beat folding in framesOf() (in-memory, no I/O)
  └─ ui.sceneId / ui.shotId published → every other pane follows

User clicks Save
  └─ localStorage.setItem('vn.runner.save.' + title, JSON.stringify(history))

User clicks Load
  └─ history = JSON.parse(localStorage.getItem(...))
```

### 5. Pipeline Execution
```
"Run Pipeline…" (header menu or palette) → pipeline.run, confirmed
  ↓
invoke('pipeline:run', { mock })
  ├─ loadProject()
  ├─ buildProviders() [LLM/image clients]
  ├─ runPipeline() [phase loop]
  │   ├─ Plan tasks from model
  │   ├─ Execute + write to store
  │   ├─ Update tasks.jsonl
  │   └─ Check gate; stop if blocked
  │
  └─ return PipelineRunResult
       ├─ the Tasks / Task Graph / Inspector editors re-read `pipeline:status`
       └─ the command's message lands in the screen's note frame
```

---

## Persistence Summary

| Data | Where | Persists? | Who Reads | Who Writes |
|------|-------|-----------|-----------|-----------|
| Playthrough position | `localStorage` | ✓ Survives restart | Runner component | Save button |
| Pane layout | `.vnstudio/session.json` (`pathux.window.<n>.layout`) | ✓ Survives restart | `restoreLayout` | Every split/join/drag, debounced |
| Selected scene/shot/character/document/asset/task | `.vnstudio/session.json` (`pathux.window.<n>.selection`) | ✓ Survives restart | `restoreSelection`, then `settleSelection` | The `ui.*` datapath watchers |
| A field a pane remembers (the documents editor's mode) | `.vnstudio/session.json` (inside the window's `…layout`) | ✓ Survives restart | nstructjs, with the pane | The editor, via `layoutChanged()` |
| Whether a pane is pinned, and to what | `.vnstudio/session.json` (inside the window's `…layout`) | ✓ Survives restart | nstructjs, with the pane | The pin toggle, via `VnScreen.onLayoutChange` |
| Which layout template the window shows | `.vnstudio/session.json` (`pathux.window.<n>.template`) | ✓ Survives restart | `view.layouts`, the layout watch | `view.applyLayout` / `saveLayout` / `resetLayout`, in main |
| The layout templates themselves | `.vnstudio/layouts/*.json` (the **project** repo) | ✓ On disk, committed | `view.layouts` / `view.applyLayout` | `view.saveLayout`, `view.resetLayout`, `ensureLayouts` |
| The conversation on screen | Renderer memory (`pathux/agent.ts`) | ✗ Lost on restart | Every convo pane | Agent events + `agent.run` |
| The conversation as a transcript | `vngen/state/threads/<id>.jsonl` | ✓ Survives restart | `agent.threads` / `agent.openThread` | Main, one line per feed item plus one per API call's receipt, as the turn runs |
| Header facts and per-editor drafts | Renderer memory | ✗ Lost on restart | The header and each editor | Bridge pushes + user gestures |
| Agent context | Main process memory | ✗ Lost on restart | Agent instance | agent:run IPC |
| Project config | Files | ✓ On disk | Main (lazy load) | Author / editor |
| Story model | Files | ✓ On disk | Main (lazy load) | Pipeline + authoring agent |
| Assets | `build/assets/` | ✓ On disk | AssetStore | Pipeline image tasks |
| Manifest | `vngen/build/manifest.json` | ✓ On disk | AssetStore | Pipeline tasks |
| Task graph | `vngen/state/tasks.jsonl` | ✓ On disk | TaskGraph loader | Pipeline runner |
| Command history | `vngen/state/commands.jsonl` | ✓ On disk | `CommandStack` (`command:history`) | Every command execution, via `onRecord` |
| Notifications | `vngen/state/notifications.jsonl` | ✓ On disk | `notify:list` / the bell | Every filed command outcome, every pipeline task, every shell notice |
| Which categories the list shows | `desktop/session.json` (`vn.notifications.filter`) | ✓ Survives restart | `pathux/notifications.ts` | The filter popup and the "show deleted" box |
| Which projects were opened recently, and the agent's token budget | `desktop/session.json` (`workspace.recent`, `agent.budget`) | ✓ Survives restart, on this machine | `recentWorkspaces`, the agent runner | `rememberWorkspace`, `agent.setBudget` |
| Undo snapshots | `refs/vn/undo/<seq>/{pre,post}` (git) | ✓ In the object database | `UndoJournal` | Every undoable command — the eighteen `story.*` ones, the document writers, and the two that write layout templates |

---

## Rebuilding After Restart

When the app restarts:

1. **Renderer memory → all cleared.** The transcript, the header facts and every draft are gone.
2. **localStorage → playthrough saved.** If the author was in the Play editor, click Load to
   restore position.
3. **`.vnstudio/session.json` → the pane layout and the selection are restored**, synchronously,
   before the first paint, from the project that is opening. A layout that will not load falls back
   to the Writing arrangement — the documents tree, the script with the branch cards behind it, and
   the agent — rather than failing. The window's template key comes back too, and the layout watch
   seeds from it **without re-applying**, so a border dragged last session is not thrown away by a
   template that also describes this window. What the selection names may be gone by now, so
   `settleSelection` checks it once the first paint is up: the asset hash is repaired through one
   `asset.info` call, and a scene or character the workspace index does not list is cleared.
4. **Project files → unchanged.** Workspace loads with latest committed state.
5. **Main process → rebuilds on first use.**
   - First IPC call (e.g., `workspace:index`) → lazy-loads project, creates Agent
   - Subsequent calls → may rebuild project (no cache) but reuse Agent

The **conversation on screen is not recovered**: the renderer opens on an empty pane and main starts a fresh `Agent`, though the Agent loads `AICONTEXT.md` to restore plan-mode context (via `@vn/authoring`'s persistent system prompt). What _is_ recovered is the **transcript** — every turn was written to `vngen/state/threads/<id>.jsonl` as it ran, and the convo pane's **Threads** menu reopens one. Reopening replays the stored feed and says so in the dialogue box: the model is not shown a word of it, because restoring the agent's own messages is a separate piece of work.

---

## IPC Contract

**Renderer calls these, main responds:**

| Channel | Args | Response | Persisted? |
|---------|------|----------|-----------|
| `workspace:index` | none | WorkspaceIndex | No (rebuilt each call) |
| `agent:run` | `userInput: string` | RunResult | No (state in Agent) |
| `agent:setMode` | `mode: AgentMode` | AgentMode | No (Agent in memory) |
| `agent:setModel` | `modelId: string` | string | No (backend rebuilt) |
| `agent:clear` | none | void | No (Agent reset) |
| `agent:system` | none | AgentSystem | No (assembled per call, from files) |
| `plan:decision` | `{ id, decision }` | void | No (resolves permission) |
| `pipeline:status` | none | PipelineStatus | No (rebuilt from files) |
| `pipeline:run` | `{ mock: boolean }` | PipelineRunResult | No (executes fresh) |
| `gate:candidates` | `characterId: string` | GateCandidate[] | No (read from manifest) |
| `gate:approve` | `{ characterId, hash }` | ApproveResult | No (edits file + store) |
| `story:play` | none | Playable | No (built on-demand) |
| `story:graph` | none | StoryGraph | No (read; mutations go through `story.*` commands) |
| `story:coverage` | `sceneId: string` | SceneCoverage | No (read; the edit is `story.setCoverage`) |
| `command:catalog` | none | CommandCatalog | No (the **live** registry, never the generated file) |
| `command:exec` | CommandExecRequest | CommandOutcome | **Yes** — appends to `vngen/state/commands.jsonl` |
| `command:history` | `limit?: number` | CommandRecord[] | No (read back from the log) |
| `notify:list` | none | Notification[] | No (read back from the log, deduped and sorted) |
| `notify:post` | NotificationInput | Notification | **Yes** — appends to `vngen/state/notifications.jsonl` |
| `command:check` | `{ id, props? }` | CommandCheck | No (a read, never a gate — `exec` re-decides) |
| `command:undo` | none | CommandOutcome | **Yes** (restores a snapshot; refuses on drift) |
| `command:redo` | none | CommandOutcome | **Yes** |
| `session:set` | `{ key, value, scope? }` | void | **Yes** — a `pathux.` key to `.vnstudio/session.json`, everything else to `desktop/session.json` |

The `story:*` reads and the `command:*` family are the two halves of one rule: **commands are
the only write path.** There is no mutating IPC channel for the branch editor or the timeline —
a read channel feeds the view, and every edit is a `story.*` command with a `CommandRecord`.
See [`command-system.md`](command-system.md).

`session:snapshot:sync` is the odd one out: a **synchronous** `ipcMain.on` channel the preload
calls once, before first paint, so the renderer never renders a default layout and then jumps. It
answers with the two session files as one map, so the renderer reads a flat key/value store and
never learns which file a key came from. The two key sets are disjoint, so the merge decides
nothing.

`pipeline:status` returns tasks **narrowed at the boundary** (`src/main/reviews.ts`), not raw
pipeline tasks. `TaskAttempt.reviews` is `unknown[]` in `@vn/types` because it is read back from
`tasks.jsonl` as JSON; main parses each entry with `defectReportSchema` and drops the ones that
fail, so the renderer's `Task` can promise `reviews: DefectReport[]`. Main also stamps
`outputExt` by looking the attempt's output hash up in the manifest — an attempt records only
the hash, and the Inspector editor needs both halves to build a `vnasset://<hash>.<ext>` url.

**Main pushes these to renderer:**

| Channel | Payload | When |
|---------|---------|------|
| `agent:event` | AgentEvent | During agent:run (each step) |
| `permission:plan` | PlanRequest | Agent needs approval |
| `command:ui` | UiEffect | A `view.*` command named an editor or a pane, the palette opened, undo state moved, or a workspace opened |
| `notify:changed` | `{ note? }` | A notification was filed, or one's read/hidden flag moved. Carries the note when there is a new one; the renderer's answer to either is a refetch, and the note is what the one surviving note frame shows |
| `session:changed` | `{ key, value }` | Any session write, whoever made it |
| `log` | `{ level, message }` | Diagnostic logging |

---

## Design Rationale

### Why so little persistent UI state?
- The desktop app is a **client for a workspace**, not a REPL session with long-lived conversation.
- Restarting should feel like opening a fresh terminal in the project directory.
- The authoring workflow is **step-and-approve** (user proposes → agent plans → user approves → agent executes), so losing mid-turn state is acceptable.
- What does persist is only what the user *arranged by hand* and would be annoyed to redo — the
  pane layout, and the selection it was left on. Derived or transient state stays ephemeral.

### Why a main-process file, not localStorage, for the layout?
- The preload can read a main-process file **synchronously** before first paint, so a saved
  arrangement never appears as a jump away from the default. Two Electron instances would also
  clobber each other in `localStorage`; per-key merge under a lock does not.
- Main is also where the split by ownership can be made at all. `localStorage` is keyed by origin,
  which is one bucket for every project the install ever opens.

### Why the arrangement lives in the project rather than the install?
- An arrangement describes the project it was made for. Its panes are pinned to that project's
  scenes and characters, and its selection names ids only that project has, so it belongs beside
  the project rather than in a file about this machine.
- The install file needed a key per project instead, which grows without bound and cannot be
  cleaned up: nothing tells the app that a project it opened last year was deleted. Moving or
  renaming a project also lost its arrangement, because the key was a digest of the path.
- The file is still gitignored, so an arrangement stays in the clone it was made in. Committing it
  would put a `git status` entry under every pane drag, conflict on every pull, and make
  `UndoJournal.check` refuse — `Git.writeTree` stages with `git add -A`, so a debounced write
  landing mid-command reads as worktree drift.

### Why re-read project files on each call?
- Ensures the main process always sees the latest disk state (e.g., if user hand-edits a file).
- Avoids cache-coherency issues: a file edit by the agent is immediately visible to the next pipeline run.
- Cheap: files are small and parsed only when needed.

### Why localStorage for playthrough?
- Simple, browser-native persistence.
- Per-title key ensures multiple projects don't collide.
- Survives page reload without backend round-trip.
- Player saves don't require a database or server.

### Why build the playable on-demand?
- The playable is derived entirely from model + assets; no new data is stored.
- Exporting `story.play.json` is just a file write of the same structure.
- Allows the player to start even if export hasn't been run yet.

---

## Edge Cases

### App restarts mid-run
- **Agent state:** Lost. User starts a fresh conversation on next app load — but the turns that
  did complete are in `vngen/state/threads/`, and the Threads menu reads them back.
- **Project state:** Safe. Files are unchanged; last task status is in `tasks.jsonl`.
- **Playthrough:** Safe. Saved position is in `localStorage`.

### User edits a file while app is running
- **Next IPC call:** Main re-reads the file (no cache), sees the edit.
- **Agent:** If the file was read into context, the context is stale until the agent re-queries.

### Multiple windows of the same workspace
- **A window is a renderer, not an app instance.** One process, one `WorkspaceSession`, one
  `CommandStack`, one undo history, N windows onto it. The earlier note here — "separate app
  instance per window" — described a thing the app never did and must not do; see the lock below.
- **Session store:** two `SessionStore`s for the process, the install's and the open project's,
  behind one `SessionState`. The per-key `mkdir`-locked merge still matters, but between
  *instances on different projects*, not between windows: a window's own keys are scoped by
  index, so two windows arranging their panes differently no longer race. A lock left behind by a
  killed instance is broken after 5s.
- **localStorage:** shared by origin, so playthrough saves still clobber each other (last window
  wins). Unchanged by any of this — it is the renderer's own store, keyed by nothing.
- **One instance per workspace, enforced.** Two processes on one project collide in
  `refs/vn/undo/<seq>` — a **per-process** ref namespace whose `seq` restarts at zero, so
  instance B's first command overwrites the shadow snapshot instance A's first command is
  holding — and again in the committer's `-A` sweep, which stages the other instance's
  half-written files. Both failures are silent. So `src/main/instancelock.ts` holds a listening
  socket keyed by a digest of the resolved root: binding *is* acquiring, the endpoint dies with
  the process, and a launch on a root somebody already owns hands off — it tells the owner to
  come forward and exits before opening a window. `workspace.open` refuses the same case by name
  rather than tearing down first.
  It is deliberately **not** `app.requestSingleInstanceLock()`: two instances on two different
  repos share nothing that can collide, and a global lock would forbid them for no reason.

### Switching workspaces
- One workspace at a time, but no longer for the life of the process: `workspace.pick` (the
  dialog) and `workspace.open(path='…')` switch in place, and the launch precedence is
  `--project`/`VN_PROJECT` → the most recent remembered project → the picker → the seeded sample.
- **A switch is a teardown.** The session, the command stack, the undo journal, the repo map and
  the undo revision are all rebuilt against the new root, so undo never crosses a project
  boundary, and nothing may cache the root — `vnasset://` resolves `ProjectPaths` per request.
  Every window is then reloaded, which re-runs the boot path against the new project's own session
  file. The `{ type: 'workspace' }` effect is still pushed, for whichever windows have not
  reloaded yet.
- The layout and the selection live in the project and are keyed **per window**, so a switch opens
  the arrangement that workspace last had rather than carrying the previous project's selection
  into a project with none of those ids. A window that has not reloaded yet cannot write into the
  project just opened: it stamps every write with the scope it was loaded for, and main drops a
  stamp naming another project.
- A switch acquires the new workspace's lock before it tears anything down, and releases the old
  one after. Switching to a project another instance owns is refused, and that instance is
  brought forward instead.
- Full write-up: [`desktop-app.md`](desktop-app.md#which-project-is-open).

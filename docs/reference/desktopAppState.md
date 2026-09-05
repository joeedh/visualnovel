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

**Player position and save files in the Play editor.**

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
- First load of a playable: Initializes from `story.play.json`'s `start` scene at frame 0
- Each advance/back: Updates history array in memory
- **Save button:** Serializes history to `localStorage`
- **Load button:** Deserializes from `localStorage` back to memory
- **Reset button:** Clears history, returns to start scene
- **Survives:** Page reload, app restart
- **Lost when:** Browser storage is cleared, or user uses incognito/private browsing

**Code:** `renderer/pathux/play/playback.ts` (the pure `saveKey` / save blob, tested) and
`renderer/pathux/editors/play.ts` (the `localStorage` calls)

---

### 2. Remembered UI State (Persistent via the desktop session store)

**Pane arrangement and selection the user left in the project.**

**Storage:** Two `SessionStore` files (flat key/value stores in `src/main/sessionstore.ts`):

| File | Holds | Scope |
|------|-------|-------|
| `<root>/.vnstudio/session.json` | `pathux.` keys: mesh, selection, applied template, window list | Project's own; beside layout templates; **gitignored** |
| `<userConfigDir()>/desktop/session.json` | `agent.budget`, `vn.notifications.filter`, recents list | Install's home; `%LOCALAPPDATA%\vnauthor\desktop` on Windows; override with `VN_DESKTOP_HOME` |

**Storage decisions:**
- Install file is the same home as API keys: outside repo, outside the bundle (packaged app's `__dirname` is inside `app.asar`)
- Arrangement lives in project (not install) because a project is the unit an author moves
  - History: used to live in install under a digested path key → renaming lost arrangement, second install lost it, clearing one project's state cleared all
  - Gitignored (not committed) because it changes on every border drag; a tracked file churns `git status` and conflicts on pulls
  - Shareable half is a [layout template](desktop-app-shell.md#layout-templates), which _is_ committed
- Ignore entry is the glob `.vnstudio/session.json*` (accounts for `writeFileAtomic`'s `.tmp-<hex>` sibling)
- Undo excludes it (`UNDO_EXCLUDES` in snapshot store), skipping `.tmp-<hex>` siblings; without this, a pane drag between an edit and undo would read as drift and refuse
- `writeScaffolding` rewrites the ignore line on every open (hand-edited `.gitignore` is repaired)

**Shape:** Flat `Record<string, SessionValue>` with dotted keys, scoped by window index (built in `src/shared/sessionkeys.ts`):

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

**Key routing and restoration:**
- Window index is load-bearing; flat keys failed because `view.applyLayout` in window A wrote `pathux.template`, then `view.resetLayout` in window B re-applied **A's** template to B
- `isProjectKey` decides which file a key lands in, by prefix; `SessionState` routes every read/write, not individual stores
- `CommandHost.state` is that router (not a store), so `view.*` writes go to the right file
- Renderer learns its window id from URL (`?window=<n>&ws=<scope>`), not IPC — layout and selection restore before first paint
- `ws` is the workspace digest; every project-key write carries it, so main drops writes from windows reloading after a workspace switch
- Legacy flat keys (`pathux.{layout,selection,template}`) are read once as window 0, never written again; first open seeds project file from install's keys
- Project with unopenable `.vnstudio` keeps no arrangement (one logged warning); reads answer default, writes are dropped; install file is unaffected

**Lifecycle:**
- Main opens the store during `app.whenReady()`, before any window
- Preload reads the snapshot **synchronously** (`session:snapshot:sync`) so first paint is already the remembered layout (async fetch would render default then jump)
- `pathux/persist.ts` writes both keys, debounced 400 ms, and again on `beforeunload` (quit does not run debounce)
  - Layout reports through `VnScreen.onLayoutChange` (split, join, border drag, window resize)
  - Selection reports through `DataPathWatcher`s on `ui.{sceneId, shotId, characterId, docPath, assetHash, taskHash}` (same push the widgets get)
  - Every persisted field needs its own watcher (e.g., clicking an asset moves only that field)
- Selection fields announce their own write (`ShellState.onSelect` → `api.notifyChange` in `renderer/pathux/app/shell.ts`); without this hook, path.ux watchers don't fire from editor assignments
  - The six selection fields are accessors over one private record, so unchanged values report nothing
- Watchers are `immediate` (not default `raf`) — hidden/minimized windows run no animation frames, so raf-coalesced watchers stay dirty until shown; `schedule` has a 400 ms debounce
- `view.*` effects schedule saves themselves (`applyView` in `renderer/pathux/panes/view.ts`); pane editor swaps don't fire `onLayoutChange`, so without this the old pane comes back on restart
- Restored ids are checked once after first paint (`settleSelection` in `renderer/pathux/app/shell.ts`):
  - `assetHash` repaired through one `asset.info`: fails if manifest no longer holds it, cleared; carries `newerTake` for replaced take, selection follows
  - `sceneId` and `characterId` cleared if workspace index does not list them; `shotId` goes with its scene
  - `docPath` **not** pruned (doc tree caps a branch and has file-tree mode; absence is not evidence it's gone)
  - Every write back is guarded on the field still holding what restore put there (author may have clicked something)
- `ui.taskHash` persisted with no repair rule: hash is `sha256(kind, inputs)` and is stable while inputs are; inspector fetches once, draws nothing if not found
- Workspace switch reloads every window (not in-place re-apply), so each re-runs boot against new project's file
- Pane-remembered fields ride in the layout blob (not beside it): `registerEditor` optional `fields` list, nstructjs writes to pane's struct, survives restart *and* pane moves
  - Editor calls `layoutChanged()` itself; `onLayoutChange` cannot see inside panes
- Layout is nstructjs via path.ux's `simple.saveFile`/`loadFile` (schema stamped in blob, reads back even after STRUCT changes)
  - Nothing may block boot: corrupt or unsupported layouts are discarded, default screen takes place
- Template key is the odd one out: written by **main** in `view.applyLayout`/`view.saveLayout`/`view.resetLayout`, is a *pointer into the project* (layout template slug)
  - Main derives window key from `ctx.origin`; no-origin commands (agent, CDP) use focused window
  - Arrangement lives in `pathux.window.<n>.layout` (panes are a window fact even if a project named the arrangement); see [Layout templates](desktop-app-shell.md#layout-templates)
- Writes are merged **per key** under `mkdir` lock (two running instances don't clobber; same key is last-flush-wins)
- **Survives:** app restart, renaming or copying the project directory
- **Lost when:** file deleted, or project cloned elsewhere (git does not carry it)

**Code:** `src/main/sessionstate.ts`, `src/main/sessionstore.ts`, `src/shared/sessionkeys.ts`,
`renderer/pathux/app/persist.ts`, `renderer/rules/uistate.ts`

---

### 3. UI State (Ephemeral, in the shell)

**Everything the author sees and interacts with that is not a project file — selection, conversation, pipeline status, header.**

**Storage:** Renderer memory in two modules, plus per-editor state.

**`ShellState` (`renderer/pathux/app/state.ts`)** — root of the path.ux DataAPI, the only widget-bindable source. Document state never lands here; `@vn/commands` is the write path, so widgets dispatch commands instead.

| Field | Type | Notes |
|-------|------|-------|
| `sceneId` / `shotId` / `characterId` | `string` (`''` = nothing) | One authored selection every editor observes, any editor may publish. **Persisted** (category 2) |
| `docPath` | `string` (`''` = nothing) | Which document wiki editor is on; the one selection field that names a **path** not id (free-form note under `wiki/` has no id). `view.open`/`view.focus` publish from `subject` prop. **Persisted** (category 2) |
| `taskHash` | `string` | Which task the inspector is open on. **Persisted** (category 2), no repair rule; hash is stable while inputs are, inspector draws nothing if not found |
| `assetHash` | `string` | Which asset the asset editor is on. **Persisted** (category 2), repaired at boot via one `asset.info` |
| `projectTitle` | `string` | Pushed from `workspace:index` |
| `model` | `string` | Text model id for header badge |
| `agentMode` | `'plan' \| 'execute'` | Mirrored from `agent.setMode` outcome and `agent:event` |
| `errors` / `warnings` | `number` | Counted separately; errors displace warnings in badge |
| `unread` | `number` | Bell shows unread, unarchived notifications matching active filter. Written by `pathux/notifications.ts`, never counted in header (badge and list cannot disagree) |
| `canUndo` / `canRedo` / `undoLabel` / `redoLabel` | `boolean` / `string` | Pushed on `command:ui` `undo` effect |

**The conversation (`renderer/pathux/agent/agent.ts` + `src/shared/convo.ts`):**
- Subscribed at boot whether or not convo pane is open; agent streams regardless, pane opened later shows what was already said
- Structure: `{ feed, line, plan, busy, seq }`, every `agent:event` folds through pure `received`/`asked`/`answered`/`proposed`/`decided` functions
- Pane notices changes by comparing revision counter; `update()` runs every frame
- `busy` raised by pipeline run, not only by turn
- Reducer lives in `src/shared/convo.ts` because **main runs it too** — every feed item it folds in is the line main appends to the open thread; transcript on disk = transcript on screen, not a second rendering

**General principles:**
- **Which editor is on screen is decided elsewhere.** `view.*` commands run in **main**, push `command:ui` effect; mesh applies it, answers with correction only if it disagrees; see [`command-system.md`](command-system.md). Screen itself *is* the state, persisted as one blob
- **Per-editor state stays in editor** (draft being typed, live gesture, scroll position) — this is what a redraw key excludes on purpose. path.ux calls `update()` every frame, so keying rebuild on what's being typed would replace the field under the caret
- **Workspace index is re-read, never remounted.** Editor-made edits re-read `workspace:index` so diagnostics and cast are current; no revision counter remounts pane mid-gesture
- **Lost on:** page reload, app restart (no persistence) — except selection (category 2)

---

### 4. Backend State (Main Process, Ephemeral)

**Server-side context that runs the agent, holds loaded models, and mediates file I/O.**

**Storage:** In-memory `WorkspaceSession` instance (one per workspace)

**Structure:**
```typescript
class WorkspaceSession {
  dir: string                // Workspace root
  mock: boolean              // Offline mode?
  agent?: Agent              // Lazy-initialized
  model: string              // Text model id
  
  // Methods that rebuild on-demand:
  // - ensureAgent()    → loads/reuses Agent
  // - buildBackend()   → creates ChatBackend for configured model
  // - loadProject()    → reads config, model, store, graph from files
}
```

**On-demand resources:**
| Resource | Built by | Cached | Holds |
|----------|----------|--------|-------|
| `Agent` | `ensureAgent()` | Yes (lazy) | Conversation history, mode, backend |
| `ProjectConfig` | `loadProject()` | No (re-read each call) | `project.yaml` parsed + validated |
| `ProjectModel` | `loadProject()` | No (re-read each call) | Characters, locations, scenes, validated story graph |
| `AssetStore` | `loadProject()` | No (re-read each call) | `build/assets/` index + `manifest.json` |
| `TaskGraph` | `loadProject()` | No (re-read each call) | `state/tasks.jsonl` parsed into task nodes |
| `ChatBackend` | `buildBackend()` | Yes (per Agent) | Anthropic or Gemini client |

**Lifecycle:**
- Created when app loads a workspace
- `Agent` initialized on first user input (`agent:run` IPC call)
- Project data (config, model, store, graph) rebuilt on each IPC call that needs it (intentional — ensures latest disk state)
- Lost on app restart (rebuilt from files)

**Hot-swapping:**
- Model can switch mid-conversation via `agent:setModel(newModelId)` → rebuilds `ChatBackend`, preserves Agent state
- Mode toggled via `agent:setMode()` without losing context

**Code:** `WorkspaceSession` in `src/main/session.ts`

---

### 5. Project Files (Persistent on Disk)

**Authored inputs and generated outputs—the source of truth for everything else.**

**Directory structure:**
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
│   ├── <id>.md               # `scene: <id>` front-matter + one-scene Fountain body
│   └── …
├── screenplay/               # RETIRED, never read (reported on load — run `vngen import` or `workspace.import`)
│   ├── *.fountain
│   └── …
├── vngen/
│   ├── build/
│   │   ├── assets/
│   │   │   └── <sha256>.<ext>  # Content-addressed image bytes
│   │   ├── manifest.json       # Provenance index (task → asset)
│   │   └── story.play.json     # The playable (`vngen export`)
│   ├── state/
│   │   ├── tasks.jsonl         # Append-only task log (crash recovery + resume)
│   │   ├── commands.jsonl      # Append-only CommandRecord log (provenance + undo)
│   │   ├── notifications.jsonl # Append-only notification log (`r`/`h` patched in place)
│   │   ├── reviews/<taskHash>  # Vision-review reports per task
│   │   └── graphs/<slug>.jsonl # A generation graph's run journal, keyed by node key (`<instance>/<id>` inside a group)
│   └── work/
│       ├── story.graph.mmd     # Mermaid diagram of story branches
│       ├── graphs/
│       │   ├── <slug>.json     # A generation graph (nstructjs JSON), written only by `gengraph.*` commands
│       │   └── lib/<ref>.json  # A group definition; every graph instancing `<ref>` follows this file
│       ├── characters/<id>/
│       │   ├── approved.png    # Approved portrait for character
│       │   ├── candidates/     # Awaiting approval
│       │   └── outfits/<outfit>/sheet/
│       ├── locations/<id>/
│       │   ├── breakdown.md    # P1 location breakdown
│       │   └── refs/           # Reference plates
│       └── shots/<sceneId>.json  # Persisted shot decomposition
└── keys/                     # API keys (gitignored)
    └── …
```

**Path authority:** `packages/store/src/paths.ts` is the single authority; this tree reads it. The
graph documents, definitions, journals and blobs under `graphs/` are described in
[`gen-graphs.md`](gen-graphs.md#where-things-live-on-disk). Scene file discovery is `loadInputs` (`packages/store/src/worktree.ts`), which reads `scenes/` and only *reports* leftover `screenplay/`.

**Committed:**
- `project.yaml`, characters, locations, scenes
- `vngen/` generated outputs (graph, manifest, assets)

**Not committed:** `keys/`, `.env` files

**Read by main process via:**
- `@vn/config` — parses `project.yaml`
- `@vn/parse` — parses Fountain and front-matter
- `@vn/store` — reads characters/locations, indexes `build/assets/`
- `@vn/model` — validates and builds story graph
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
ask() runs `agent.run` command through the bridge
  ├─ asked(convo, text) → transcript shows it, busy = true
  └─ exec('agent.run', { input })
       ↓
       Main: runAgent(text)
         ├─ ensureAgent() [cached if already running]
         ├─ agent.run(input)
         │   ├─ Model (LLM) call
         │   ├─ Tool execution (read/edit files)
         │   └─ Emit AgentEvent for each step
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
| The conversation as the model saw it | `vngen/state/threads/<id>.native.jsonl` | ✓ Survives restart | `agent.resumeThread` / `agent.compact` and the agent's own `search_history` | Main, one line per model message, as the turn runs |
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
| Undo snapshots | `ContentStore`, in the main process | ✗ Dropped when the app closes or the workspace switches | `UndoJournal` | Every undoable command — the eighteen `story.*` ones, the document writers, and the two that write layout templates |

---

## Rebuilding After Restart

**Immediate state on app restart:**

1. **Renderer memory → all cleared.** Transcript, header facts, every draft are gone.
2. **localStorage → playthrough saved.** If author was in Play editor, click Load to restore position.
3. **`.vnstudio/session.json` → restored synchronously, before first paint.**
   - Pane layout and selection restored from the opening project
   - Layout that won't load falls back to Writing arrangement (documents tree, script with branch cards, agent)
   - Window's template key comes back, layout watch seeds from it **without re-applying** (border drag isn't thrown away)
   - Selection repair after first paint: asset hash repaired via one `asset.info` call; scene or character not in workspace index is cleared
4. **Project files → unchanged.** Workspace loads with latest committed state.
5. **Main process → rebuilds on first use.**
   - First IPC call (e.g., `workspace:index`) → lazy-loads project, creates Agent
   - Subsequent calls → may rebuild project (no cache) but reuse Agent

**Conversation recovery:**

**On-screen conversation is not recovered:** renderer opens empty, main starts fresh `Agent` (loads `AICONTEXT.md` to restore plan-mode context via `@vn/authoring`'s persistent system prompt).

**Transcript is recovered** — every turn written to `vngen/state/threads/<id>.jsonl` as it ran; convo pane's **Threads** menu reopens one. Reopening replays stored feed, says so in dialog; model sees nothing. **Continue** shows it to model and reads `<id>.native.jsonl` (same conversation as backend messages sent); agent picks up where it left off.

**File comparison:**
- Transcript: each line clamped to a few hundred characters
- Native log: every tool call and result at full length (larger by a wide margin; dozen-file read leaves megabytes)
- Written from same events but not projections of each other; only transcript is drawn

**Persistence and merge:**
- Both append-only, committed with `vngen/state/`, so project history carries them
- `.gitattributes` marks `vngen/state/threads/*.native.jsonl` as `-merge` (merged line-by-line logs are useless; Continue refuses conflict markers)
- **Compact** bounds live conversation: appends summary line, agent sees summary instead of messages, but every covered line stays on disk for `search_history`

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
- App is a **client for a workspace**, not a REPL with long-lived conversation
- Restarting should feel like opening a fresh terminal in the project directory
- Authoring workflow is **step-and-approve** (user proposes → agent plans → user approves → agent executes); mid-turn loss is acceptable
- Persist only what user *arranged by hand* and would be annoyed to redo: pane layout and selection; derived/transient state stays ephemeral

### Why a main-process file, not localStorage, for the layout?
- Preload reads main-process file **synchronously** before first paint; saved arrangement never jumps in
- Two Electron instances clobber each other in `localStorage`; per-key merge under lock does not
- `localStorage` keyed by origin (one bucket per install); main process can split by ownership

### Why the arrangement lives in the project rather than the install?
- Arrangement describes the project it was made for; panes pinned to that project's scenes and characters
- Install file approach required per-project keys (unbounded growth, no cleanup signal when project deleted)
- Moving or renaming project lost arrangement (key was path digest)
- Gitignored (not committed) keeps arrangement in its clone; committed would churn `git status` and conflict on pulls
- `UNDO_EXCLUDES` names it separately so debounced writes don't read as drift

### Why re-read project files on each call?
- Ensures main always sees latest disk state (user hand-edits a file)
- Avoids cache-coherency issues: agent file edits are immediately visible to next pipeline run
- Cheap: files are small, parsed only when needed

### Why localStorage for playthrough?
- Simple, browser-native persistence
- Per-title key prevents collisions across projects
- Survives page reload without backend round-trip
- No database or server required

### Why build the playable on-demand?
- Playable derived entirely from model + assets; no new data stored
- Exporting `story.play.json` is just a file write of the same structure
- Player can start even if export hasn't been run yet

---

## Edge Cases

### App restarts mid-run
- **Agent state:** Lost; user starts fresh conversation on next load, but completed turns are in `vngen/state/threads/` (Threads menu reads them back)
- **Project state:** Safe; files unchanged, last task status in `tasks.jsonl`
- **Playthrough:** Safe; saved position in `localStorage`

### User edits a file while app is running
- **Next IPC call:** Main re-reads file (no cache), sees edit
- **Agent:** If file was read into context, context is stale until agent re-queries

### Multiple windows of the same workspace
- **Architecture:** One process, one `WorkspaceSession`, one `CommandStack`, one undo history, N windows onto it; a window is a renderer, not an app instance
  - (Note: "separate instance per window" was never true and must not become true; see lock below)
- **Session store:** Two `SessionStore`s (install's and project's) behind one `SessionState`; per-key `mkdir`-locked merge matters between *instances on different projects*, not between windows
  - Window keys scoped by index, so two windows arranging panes differently don't race
  - Lock left behind by killed instance broken after 5s
- **localStorage:** Shared by origin, playthrough saves still clobber (last window wins); unchanged by this—it's the renderer's own store
- **One instance per workspace, enforced via `src/main/instancelock.ts`:** Listening socket keyed by resolved root digest
  - Binding is acquiring; endpoint dies with process
  - Launch on owned root hands off—tells owner to come forward, exits before opening window
  - `workspace.open` refuses same case by name
  - **Not** `app.requestSingleInstanceLock()` (would forbid two instances on different repos, which share nothing that can collide)
  - (Two-process issue: each holds own undo history over same worktree → restore in one is drift other refuses; both collide in committer's `-A` sweep, failures silent)

### Switching workspaces
- One workspace at a time, no longer for process lifetime; `workspace.pick` and `workspace.open(path='…')` switch in place
- Launch precedence: `--project`/`VN_PROJECT` → most recent → picker → seeded sample
- **Switch is a teardown:** session, command stack, undo journal, repo map, undo revision rebuilt against new root
  - Undo never crosses project boundary
  - Nothing may cache root; `vnasset://` resolves `ProjectPaths` per request
  - Every window reloaded, re-runs boot against new project's session file
  - `{ type: 'workspace' }` effect pushed for unreloaded windows
- Layout and selection live in project, keyed per window → switch opens last arrangement rather than carrying old project's selection
  - Unreloaded window can't write to just-opened project; stamps writes with load scope, main drops mismatched stamps
- Switch acquires new workspace's lock before teardown, releases old one after; switching to owned project refused, that instance brought forward
- Full write-up: [`desktop-app-state.md`](desktop-app-state.md#which-project-is-open)

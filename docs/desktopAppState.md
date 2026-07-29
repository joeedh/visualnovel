# Desktop App State Model

<!-- toc -->

- [State Categories](#state-categories)
  * [1. Playthrough State (Persistent via localStorage)](#1-playthrough-state-persistent-via-localstorage)
  * [2. Remembered UI State (Persistent via the desktop session store)](#2-remembered-ui-state-persistent-via-the-desktop-session-store)
  * [3. UI State (Ephemeral, React)](#3-ui-state-ephemeral-react)
  * [4. Backend State (Main Process, Ephemeral)](#4-backend-state-main-process-ephemeral)
  * [5. Project Files (Persistent on Disk)](#5-project-files-persistent-on-disk)
- [Data Flow](#data-flow)
  * [1. Initial App Load](#1-initial-app-load)
  * [2. User Types in Studio](#2-user-types-in-studio)
  * [3. Plan Approval Gate](#3-plan-approval-gate)
  * [4. Playthrough (Play Room)](#4-playthrough-play-room)
  * [5. Pipeline Execution (Floor Room)](#5-pipeline-execution-floor-room)
- [Persistence Summary](#persistence-summary)
- [Rebuilding After Restart](#rebuilding-after-restart)
- [IPC Contract](#ipc-contract)
- [Design Rationale](#design-rationale)
  * [Why so little persistent UI state?](#why-so-little-persistent-ui-state)
  * [Why a main-process file, not localStorage, for panel widths?](#why-a-main-process-file-not-localstorage-for-panel-widths)
  * [Why re-read project files on each call?](#why-re-read-project-files-on-each-call)
  * [Why localStorage for playthrough?](#why-localstorage-for-playthrough)
  * [Why build the playable on-demand?](#why-build-the-playable-on-demand)
- [Edge Cases](#edge-cases)
  * [App restarts mid-run](#app-restarts-mid-run)
  * [User edits a file while app is running](#user-edits-a-file-while-app-is-running)
  * [Multiple windows/tabs of the same workspace](#multiple-windowstabs-of-the-same-workspace)
  * [Switching workspaces](#switching-workspaces)

<!-- tocstop -->

The desktop app (`apps/desktop`) uses a **minimal, file-based state model** where persistent state lives in project files and browser storage, while in-memory state is ephemeral and rebuilt on demand.

## State Categories

### 1. Playthrough State (Persistent via localStorage)

**What:** The player's current position and save files in the PLAY room.

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

**Code:** `renderer/rooms/play/Runner.tsx` (`saveKey`, `save()`, `load()`)

---

### 2. Remembered UI State (Persistent via the desktop session store)

**What:** Shell layout the user has adjusted and expects back — currently the two panel widths.

**Storage:** `.vndesktop/session.json` next to `apps/desktop/` (override with `VN_DESKTOP_HOME`;
one line from `~/.vndesktop` once the app ships installed). Gitignored. **Global per install,
not per workspace** — a rail width is about the window, not the project.

**Shape:** a flat `Record<string, SessionValue>` with dotted keys.

```jsonc
{
  "panel.studio.rail.width": 260,
  "panel.floor.inspector.width": 380,
}
```

**Lifecycle:**
- Main opens the store during `app.whenReady()`, before any window exists
- The preload reads the whole snapshot **synchronously** (`session:snapshot:sync`) so the
  renderer's first paint already uses the saved widths — an async fetch would render the
  default and then jump
- `useSessionValue(key, fallback)` seeds `useState` from that snapshot, writes via
  `session:set`, and re-reads on the `session:changed` broadcast
- A drag keeps the width in local state and persists **once** on pointer-up; `set()` also
  debounces ~200 ms, and `before-quit` flushes
- Writes are merged **per key** under a `mkdir` lock, so two running instances don't clobber
  each other's keys (same key is last-flush-wins)
- **Survives:** app restart. **Lost when:** the file is deleted

**Code:** `src/main/sessionstore.ts`, `renderer/session.ts`, `renderer/ui/Resizable.tsx`

---

### 3. UI State (Ephemeral, React)

**What:** Everything the user sees and interacts with in the STUDIO and FLOOR views—conversation, mode, pipeline status, open dialogs.

**Storage:** React component state (memory only)

**Key pieces** (split across `renderer/app/App.tsx` — the shell — and `renderer/app/useAgent.ts`
— the conversation):
| State | Type | Lifetime |
|-------|------|----------|
| `room` | `'studio' \| 'floor' \| 'play'` | Session only |
| `studioMode` | `'convo' \| 'branches'` — the editor within STUDIO | Session only |
| `floorMode` | `'list' \| 'graph' \| 'timeline'` — the editor within FLOOR | Session only |
| `mode` | `'plan' \| 'execute'` | Session only |
| `feed` | `FeedItem[]` (conversation history) | Session only |
| `dboxLine` | Current agent message | Session only |
| `status` | Pipeline task list + gate pending | Session only (reloaded via `pipeline:status` IPC) |
| `index` | Workspace index (characters, scenes, locations) | Session only (loaded once via `workspace:index` IPC) |
| `undo` | `UndoState` — `canUndo`/`canRedo` plus the two tooltip labels | Session only (pushed on the `command:ui` `undo` effect) |
| `revision` | Counter bumped by an undo/redo or a palette-run mutating command; used as each room's React `key` so it remounts | Session only |
| `notice` | Transient banner — a command's result message or its refusal; self-clears after 4s | Session only |
| `planReq` | Pending plan approval request | Session only |
| `model` | Text model id for display | Session only |
| `busy` | Async operation in flight | Session only |
| `paletteOpen` | Palette menu visibility | Session only |

`room`, `studioMode` and `floorMode` are not set directly by the components: the `view.*`
commands run in **main** and push a `command:ui` effect, so there is no second renderer-side
registry — see [`command-system.md`](command-system.md).

Panel widths are the one exception to the ephemerality: they live in `usePanelWidth` rather
than in either file, and are persisted (category 2 above).

**Lifecycle:**
- Loaded once on mount (useEffect): `workspace:index` → `setIndex`, `pipeline:status` → `setStatus`
- Agent events pushed from main via IPC (`'agent:event'`) → `pushFeed`, `setDboxLine`, etc.
- Plan approval requests pushed via IPC (`'permission:plan'`) → `setPlanReq`
- **Lost on:** Page reload, app restart (no persistence)

**Code:** `renderer/app/App.tsx` (room, `studioMode`, `floorMode`, palette, index, status,
undo, revision, notice, and the `command:ui` handler) and `renderer/app/useAgent.ts` (mode,
feed, `dboxLine`, `planReq`, model, busy)

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
├── screenplay/               # LEGACY, still loads: the whole branching script in one file
│   ├── *.fountain            # (a project holding both `scenes/` and this is an error)
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
decided in one place too — `loadInputs` (`packages/store/src/worktree.ts`), which prefers
`scenes/` and falls back to `screenplay/`.

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
  useEffect (mount)
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
       └─ setIndex(result)
```

### 2. User Types in Studio
```
User types message
  ↓
send() calls invoke('agent:run', text)
  ├─ pushFeed('user', text)
  └─ setBusy(true)
       ↓
       Main: runAgent(text)
         ├─ ensureAgent() [cached if already running]
         ├─ agent.run(input)
         │   ├─ Model (LLM) call
         │   ├─ Tool execution (read/edit files)
         │   └─ Emit AgentEvent for each step
         │
       ←─ Renderer receives AgentEvents via 'agent:event' IPC
         ├─ pushFeed('tool', eventText)
         ├─ pushFeed('agent', eventText)
         └─ setDboxLine(eventText)
       ↓
       setBusy(false)
  ↓
Feed updated in real-time; user sees agent reasoning
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
         ├─ setPlanReq(plan)
         └─ Show PlanCard with Approve/Reject buttons
       ↓
       User clicks Approve
         ├─ invoke('plan:decision', { id, decision: { approved: true } })
         │    └─→ deps.requestPlan() resolves
         │
       └─ agent.run() continues → executes tool → edits file

       If Rejected: agent.run() cancels that tool
```

### 4. Playthrough (Play Room)
```
User navigates to PLAY room
  ↓
Runner useEffect mounts
  ├─ invoke('story:play')
  │    └─→ loadProject()
  │        ├─ Read project.yaml, characters, scenes
  │        ├─ Build model
  │        ├─ Read manifest.json + assets/
  │        └─ buildPlayable(model, store) → Playable JSON
  │
  └─ setPlay(result)
       ├─ setHistory([{ sceneId: start, frameIndex: 0 }])
       └─ useMemo(() => framesOf(scene), [scene])

User clicks to advance
  ├─ frameIndex++
  └─ Derived beat folding in framesOf() (in-memory, no I/O)

User clicks Save
  ├─ localStorage.setItem('vn.runner.save.' + title, JSON.stringify(history))
  └─ setNotice('Saved.')

User clicks Load
  ├─ JSON.parse(localStorage.getItem(...))
  ├─ setHistory(parsed)
  └─ setNotice('Loaded.')
```

### 5. Pipeline Execution (Floor Room)
```
User clicks "Run Pipeline"
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
       ├─ setStatus(result) ← updates task list UI
       └─ setNotice(summary)
```

---

## Persistence Summary

| Data | Where | Persists? | Who Reads | Who Writes |
|------|-------|-----------|-----------|-----------|
| Playthrough position | `localStorage` | ✓ Survives restart | Runner component | Save button |
| Panel widths | `.vndesktop/session.json` | ✓ Survives restart | `usePanelWidth` | Drag release, `view.panelSize` |
| Conversation history | React state | ✗ Lost on restart | Studio component | Agent events |
| UI state (room, mode, etc.) | React state | ✗ Lost on restart | Components | User clicks + IPC events |
| Agent context | Main process memory | ✗ Lost on restart | Agent instance | agent:run IPC |
| Project config | Files | ✓ On disk | Main (lazy load) | Author / editor |
| Story model | Files | ✓ On disk | Main (lazy load) | Pipeline + authoring agent |
| Assets | `build/assets/` | ✓ On disk | AssetStore | Pipeline image tasks |
| Manifest | `vngen/build/manifest.json` | ✓ On disk | AssetStore | Pipeline tasks |
| Task graph | `vngen/state/tasks.jsonl` | ✓ On disk | TaskGraph loader | Pipeline runner |
| Command history | `vngen/state/commands.jsonl` | ✓ On disk | `CommandStack` (`command:history`) | Every command execution, via `onRecord` |
| Undo snapshots | `refs/vn/undo/<seq>/{pre,post}` (git) | ✓ In the object database | `UndoJournal` | The six undoable `story.*` commands |

---

## Rebuilding After Restart

When the app restarts:

1. **React state → all cleared.** UI returns to empty Studio view.
2. **localStorage → playthrough saved.** If user was in Play room, click Load to restore position.
3. **`.vndesktop/session.json` → panel widths restored**, synchronously, before the first paint.
4. **Project files → unchanged.** Workspace loads with latest committed state.
5. **Main process → rebuilds on first use.**
   - First IPC call (e.g., `workspace:index`) → lazy-loads project, creates Agent
   - Subsequent calls → may rebuild project (no cache) but reuse Agent

The **conversation history is not recovered** because it's React state only. Each session starts a fresh Agent conversation, though the Agent loads `AICONTEXT.md` to restore plan-mode context (via `@vn/authoring`'s persistent system prompt).

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
| `command:check` | `{ id, props? }` | CommandCheck | No (a read, never a gate — `exec` re-decides) |
| `command:undo` | none | CommandOutcome | **Yes** (restores a snapshot; refuses on drift) |
| `command:redo` | none | CommandOutcome | **Yes** |
| `session:set` | `{ key, value }` | void | **Yes** (`.vndesktop/session.json`) |

The `story:*` reads and the `command:*` family are the two halves of one rule: **commands are
the only write path.** There is no mutating IPC channel for the branch editor or the timeline —
a read channel feeds the view, and every edit is a `story.*` command with a `CommandRecord`.
See [`command-system.md`](command-system.md).

`session:snapshot:sync` is the odd one out: a **synchronous** `ipcMain.on` channel the preload
calls once, before first paint, so the renderer never renders a default width and then jumps.

`pipeline:status` returns tasks **narrowed at the boundary** (`src/main/reviews.ts`), not raw
pipeline tasks. `TaskAttempt.reviews` is `unknown[]` in `@vn/types` because it is read back from
`tasks.jsonl` as JSON; main parses each entry with `defectReportSchema` and drops the ones that
fail, so the renderer's `Task` can promise `reviews: DefectReport[]`. Main also stamps
`outputExt` by looking the attempt's output hash up in the manifest — an attempt records only
the hash, and the FLOOR inspector needs both halves to build a `vnasset://<hash>.<ext>` url.

**Main pushes these to renderer:**

| Channel | Payload | When |
|---------|---------|------|
| `agent:event` | AgentEvent | During agent:run (each step) |
| `permission:plan` | PlanRequest | Agent needs approval |
| `command:ui` | UiEffect | A `view.*` command changed room/mode, or undo state moved |
| `session:changed` | `{ key, value }` | Any session write, whoever made it |
| `log` | `{ level, message }` | Diagnostic logging |

---

## Design Rationale

### Why so little persistent UI state?
- The desktop app is a **client for a workspace**, not a REPL session with long-lived conversation.
- Restarting should feel like opening a fresh terminal in the project directory.
- The authoring workflow is **step-and-approve** (user proposes → agent plans → user approves → agent executes), so losing mid-turn state is acceptable.
- What does persist is only what the user *adjusted by hand* and would be annoyed to redo — a
  dragged panel width. Derived or transient state stays ephemeral.

### Why a main-process file, not localStorage, for panel widths?
- The widths are about the **install**, not a workspace or an origin; a command
  (`view.panelSize`) and a future preferences pane both need to write them from main.
- The preload can read a main-process file **synchronously** before first paint. Two Electron
  instances would also clobber each other in `localStorage`; per-key merge under a lock does not.

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
- **Agent state:** Lost. User starts a fresh conversation on next app load.
- **Project state:** Safe. Files are unchanged; last task status is in `tasks.jsonl`.
- **Playthrough:** Safe. Saved position is in `localStorage`.

### User edits a file while app is running
- **Next IPC call:** Main re-reads the file (no cache), sees the edit.
- **Agent:** If the file was read into context, the context is stale until the agent re-queries.

### Multiple windows/tabs of the same workspace
- **localStorage:** Shared by origin, so playthrough saves will clobber each other (last window wins).
- **Main process:** Separate app instance per window (Electron), so one WorkspaceSession per window.
- **Session store:** Each instance has its own `SessionStore` over the same file. Writes merge
  per key under a `mkdir` lock, so two instances editing *different* panels both survive; the
  same panel is last-flush-wins. A lock left behind by a killed instance is broken after 5s.

### Switching workspaces
- App only supports one workspace at a time, resolved once at startup: `VN_PROJECT` if set,
  otherwise `examples/mySampleRepo`, seeded from `examples/sample` on first launch
  (`src/main/workspace.ts`).
- Restart the app with a different `VN_PROJECT` to switch.


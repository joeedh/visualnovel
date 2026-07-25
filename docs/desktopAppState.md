# Desktop App State Model

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

**Code:** `renderer/Runner.tsx` lines 73–117 (`saveKey`, `save()`, `load()`)

---

### 2. UI State (Ephemeral, React)

**What:** Everything the user sees and interacts with in the STUDIO and FLOOR views—conversation, mode, pipline status, open dialogs.

**Storage:** React component state (memory only)

**Key pieces** (from `renderer/App.tsx`):
| State | Type | Lifetime |
|-------|------|----------|
| `room` | `'studio' \| 'floor' \| 'play'` | Session only |
| `mode` | `'plan' \| 'execute'` | Session only |
| `feed` | `FeedItem[]` (conversation history) | Session only |
| `dboxLine` | Current agent message | Session only |
| `status` | Pipeline task list + gate pending | Session only (reloaded via `pipeline:status` IPC) |
| `index` | Workspace index (characters, scenes, locations) | Session only (loaded once via `workspace:index` IPC) |
| `planReq` | Pending plan approval request | Session only |
| `model` | Text model id for display | Session only |
| `busy` | Async operation in flight | Session only |
| `paletteOpen` | Palette menu visibility | Session only |

**Lifecycle:**
- Loaded once on mount (useEffect): `workspace:index` → `setIndex`, `pipeline:status` → `setStatus`
- Agent events pushed from main via IPC (`'agent:event'`) → `pushFeed`, `setDboxLine`, etc.
- Plan approval requests pushed via IPC (`'permission:plan'`) → `setPlanReq`
- **Lost on:** Page reload, app restart (no persistence)

**Code:** `renderer/App.tsx` lines 25–114

---

### 3. Backend State (Main Process, Ephemeral)

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

**Code:** `src/main/session.ts` lines 127–266

---

### 4. Project Files (Persistent on Disk)

**What:** The authored inputs and generated outputs—the source of truth for everything else.

**Locations:**
```
<workspace>/
├── project.yaml              # Config: title, models, API key env vars
├── characters/
│   ├── <id>/character.md     # Character front-matter + prose
│   └── …
├── locations/
│   ├── <id>.md               # Location description
│   └── …
├── screenplay/
│   ├── *.fountain            # Branching script (Fountain format)
│   └── …
├── vngen/
│   ├── build/
│   │   ├── assets/
│   │   │   └── <sha256>.<ext>  # Content-addressed image bytes
│   │   └── manifest.json       # Provenance index (which task produced what asset)
│   ├── state/
│   │   └── tasks.jsonl         # Append-only task status log (crash recovery + resume)
│   └── work/
│       ├── story.graph.mmd     # Mermaid diagram of story branches
│       ├── approved.png        # Last approved portrait
│       └── …
└── keys/                     # API keys (gitignored)
    └── …
```

**What's committed:**
- `project.yaml`, characters, locations, screenplay
- `vngen/` generated outputs (graph, manifest, assets)
- Not committed: `keys/`, `.env` files

**Read by main process via:**
- `@vn/config` — parses `project.yaml`
- `@vn/parse` — reads `.fountain` files
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
       │                             ├─ buildModel()  ──→ characters/, screenplay/
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
  │        ├─ Read project.yaml, characters, screenplay
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
| Conversation history | React state | ✗ Lost on restart | Studio component | Agent events |
| UI state (room, mode, etc.) | React state | ✗ Lost on restart | Components | User clicks + IPC events |
| Agent context | Main process memory | ✗ Lost on restart | Agent instance | agent:run IPC |
| Project config | Files | ✓ On disk | Main (lazy load) | Author / editor |
| Story model | Files | ✓ On disk | Main (lazy load) | Pipeline + authoring agent |
| Assets | `build/assets/` | ✓ On disk | AssetStore | Pipeline image tasks |
| Manifest | `vngen/build/manifest.json` | ✓ On disk | AssetStore | Pipeline tasks |
| Task graph | `vngen/state/tasks.jsonl` | ✓ On disk | TaskGraph loader | Pipeline runner |

---

## Rebuilding After Restart

When the app restarts:

1. **React state → all cleared.** UI returns to empty Studio view.
2. **localStorage → playthrough saved.** If user was in Play room, click Load to restore position.
3. **Project files → unchanged.** Workspace loads with latest committed state.
4. **Main process → rebuilds on first use.**
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

**Main pushes these to renderer:**

| Channel | Payload | When |
|---------|---------|------|
| `agent:event` | AgentEvent | During agent:run (each step) |
| `permission:plan` | PlanRequest | Agent needs approval |
| `log` | `{ level, message }` | Diagnostic logging |

---

## Design Rationale

### Why no persistent UI state?
- The desktop app is a **client for a workspace**, not a REPL session with long-lived conversation.
- Restarting should feel like opening a fresh terminal in the project directory.
- The authoring workflow is **step-and-approve** (user proposes → agent plans → user approves → agent executes), so losing mid-turn state is acceptable.

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

### Switching workspaces
- App only supports one workspace at a time (loaded at startup via `VN_PROJECT` env var).
- Restart the app with a different `VN_PROJECT` to switch.


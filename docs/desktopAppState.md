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

**Storage:** `.vndesktop/session.json` next to `apps/desktop/` (override with `VN_DESKTOP_HOME`;
one line from `~/.vndesktop` once the app ships installed). Gitignored. **Global per install,
not per workspace** — a layout is about the window, not the project.

**Shape:** a flat `Record<string, SessionValue>` with dotted keys. Two of them matter:

```jsonc
{
  "pathux.layout": { /* nstructjs-serialized screen, magic "VNSC" */ },
  "pathux.selection": { "sceneId": "arrival", "shotId": "", "characterId": "aiko" },
  // written only by the retired --react shell, and retiring with it:
  "panel.studio.rail.width": 260,
}
```

**Lifecycle:**
- Main opens the store during `app.whenReady()`, before any window exists
- The preload reads the whole snapshot **synchronously** (`session:snapshot:sync`) so the
  renderer's first paint is already the remembered layout — an async fetch would render the
  default and then jump
- `pathux/persist.ts` writes both keys, debounced 400 ms, and again on `beforeunload` — a quit
  does not run the debounce. The layout reports through `VnScreen.onLayoutChange` (every split,
  join, border drag and window resize); the selection through `DataPathWatcher`s on `ui.sceneId`
  / `ui.shotId` / `ui.characterId`, which is the same push the widgets get
- `ui.taskHash` is deliberately **not** written: it is a content hash that re-keys whenever a
  prompt changes, so one remembered across a re-plan names nothing
- The layout is nstructjs through path.ux's own `simple.saveFile`/`loadFile`, which stamp the
  struct schema into the blob, so a layout written before path.ux changed a `STRUCT` still reads
  back. Nothing here may block boot: a layout that will not load — corrupt, or naming an editor
  this build has not got — is discarded and the default screen takes its place
- Writes are merged **per key** under a `mkdir` lock, so two running instances don't clobber
  each other's keys (same key is last-flush-wins)
- **Survives:** app restart. **Lost when:** the file is deleted

**Code:** `src/main/sessionstore.ts`, `renderer/pathux/persist.ts` (and `renderer/session.ts` +
`renderer/ui/Resizable.tsx`, which serve the `--react` shell only)

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
| `taskHash` | `string` | Which task the inspector is open on. Machine identity, so deliberately not persisted |
| `projectTitle` | `string` | Pushed from `workspace:index` |
| `model` | `string` | Text model id, for the header badge |
| `agentMode` | `'plan' \| 'execute'` | Mirrored from `agent.setMode`'s outcome and from `agent:event` |
| `errors` / `warnings` | `number` | Diagnostics counted apart; errors displace warnings in the badge |
| `canUndo` / `canRedo` / `undoLabel` / `redoLabel` | `boolean` / `string` | Pushed on the `command:ui` `undo` effect |

**The conversation (`renderer/pathux/agent.ts` + `convo.ts`)** is a second module, subscribed at
boot whether or not a convo pane is open — the agent streams regardless, and a pane opened later
has to show what was already said. The value is `{ feed, line, plan, busy, seq }` and every
`agent:event` folds into it through the pure `received`/`asked`/`answered`/`proposed`/`decided`
functions; a pane notices by comparing a revision counter, since `update()` runs every frame.
`busy` is raised by a pipeline run too, not only by a turn.

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

The retired `--react` shell keeps the same material in `renderer/app/App.tsx` hooks plus
`useAgent.ts`, with its own `room`/`studioMode`/`floorMode`/`revision` and its per-room scene
selections. That vocabulary is local to it (`renderer/rooms/rooms.ts`) and goes when it does.

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
| Pane layout | `.vndesktop/session.json` (`pathux.layout`) | ✓ Survives restart | `restoreLayout` | Every split/join/drag, debounced |
| Selected scene/shot/character | `.vndesktop/session.json` (`pathux.selection`) | ✓ Survives restart | `restoreSelection` | The `ui.*` datapath watchers |
| Panel widths (`--react` shell only) | `.vndesktop/session.json` | ✓ Survives restart | `usePanelWidth` | Drag release |
| Conversation history | Renderer memory (`pathux/agent.ts`) | ✗ Lost on restart | Every convo pane | Agent events + `agent.run` |
| Header facts, `taskHash`, per-editor drafts | Renderer memory | ✗ Lost on restart | The header and each editor | Bridge pushes + user gestures |
| Agent context | Main process memory | ✗ Lost on restart | Agent instance | agent:run IPC |
| Project config | Files | ✓ On disk | Main (lazy load) | Author / editor |
| Story model | Files | ✓ On disk | Main (lazy load) | Pipeline + authoring agent |
| Assets | `build/assets/` | ✓ On disk | AssetStore | Pipeline image tasks |
| Manifest | `vngen/build/manifest.json` | ✓ On disk | AssetStore | Pipeline tasks |
| Task graph | `vngen/state/tasks.jsonl` | ✓ On disk | TaskGraph loader | Pipeline runner |
| Command history | `vngen/state/commands.jsonl` | ✓ On disk | `CommandStack` (`command:history`) | Every command execution, via `onRecord` |
| Undo snapshots | `refs/vn/undo/<seq>/{pre,post}` (git) | ✓ In the object database | `UndoJournal` | The eighteen undoable `story.*` commands |

---

## Rebuilding After Restart

When the app restarts:

1. **Renderer memory → all cleared.** The transcript, the header facts and every draft are gone.
2. **localStorage → playthrough saved.** If the author was in the Play editor, click Load to
   restore position.
3. **`.vndesktop/session.json` → the pane layout and the selection are restored**, synchronously,
   before the first paint. A layout that will not load falls back to the default arrangement
   (Branches beside Convo) rather than failing.
4. **Project files → unchanged.** Workspace loads with latest committed state.
5. **Main process → rebuilds on first use.**
   - First IPC call (e.g., `workspace:index`) → lazy-loads project, creates Agent
   - Subsequent calls → may rebuild project (no cache) but reuse Agent

The **conversation history is not recovered** because it lives only in the renderer. Each session starts a fresh Agent conversation, though the Agent loads `AICONTEXT.md` to restore plan-mode context (via `@vn/authoring`'s persistent system prompt).

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
calls once, before first paint, so the renderer never renders a default layout and then jumps.

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
- It is about the **install**, not a workspace or an origin; a future preferences pane needs to
  write it from main.
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
  per key under a `mkdir` lock, so two instances writing *different* keys both survive; the same
  key is last-flush-wins — two windows arranging their panes differently means the last one to
  flush owns `pathux.layout`. A lock left behind by a killed instance is broken after 5s.

### Switching workspaces
- One workspace at a time, but no longer for the life of the process: `workspace.pick` (the
  dialog) and `workspace.open(path='…')` switch in place, and the launch precedence is
  `--project`/`VN_PROJECT` → the most recent remembered project → the picker → the seeded sample.
- **A switch is a teardown.** The session, the command stack, the undo journal, the repo map and
  the undo revision are all rebuilt against the new root, so undo never crosses a project
  boundary, and nothing may cache the root — `vnasset://` resolves `ProjectPaths` per request.
  The renderer gets a `{ type: 'workspace' }` effect and treats it as a remount.
- The layout and the selection are **per install**, not per workspace, so they survive the switch —
  a remembered `sceneId` that the new project does not have simply selects nothing.
- Full write-up: [`desktop-app.md`](desktop-app.md#which-project-is-open).


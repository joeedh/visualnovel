# Desktop App State Model

<!-- toc -->

- [State Categories](#state-categories)
    - [1. Playthrough State (Persistent via localStorage)](#1-playthrough-state-persistent-via-localstorage)
    - [2. Remembered UI State (Persistent via the desktop session store)](#2-remembered-ui-state-persistent-via-the-desktop-session-store)
    - [3. UI State (Ephemeral, in the shell)](#3-ui-state-ephemeral-in-the-shell)
    - [4. Backend State (Main Process, Ephemeral)](#4-backend-state-main-process-ephemeral)
    - [5. Project Files (Persistent on Disk)](#5-project-files-persistent-on-disk)
- [Data Flow](#data-flow)
    - [1. Initial App Load](#1-initial-app-load)
    - [2. User Types in the Convo Editor](#2-user-types-in-the-convo-editor)
    - [3. Plan Approval Gate](#3-plan-approval-gate)
    - [4. Playthrough (Play editor)](#4-playthrough-play-editor)
    - [5. Pipeline Execution](#5-pipeline-execution)
- [Persistence Summary](#persistence-summary)
- [Rebuilding After Restart](#rebuilding-after-restart)
- [IPC Contract](#ipc-contract)
- [Design Rationale](#design-rationale)
    - [Why so little persistent UI state?](#why-so-little-persistent-ui-state)
    - [Why a main-process file, not localStorage, for the layout?](#why-a-main-process-file-not-localstorage-for-the-layout)
    - [Why the arrangement lives in the project rather than the install?](#why-the-arrangement-lives-in-the-project-rather-than-the-install)
    - [Why re-read project files on each call?](#why-re-read-project-files-on-each-call)
    - [Why localStorage for playthrough?](#why-localstorage-for-playthrough)
    - [Why build the playable on-demand?](#why-build-the-playable-on-demand)
- [Edge Cases](#edge-cases)
    - [App restarts mid-run](#app-restarts-mid-run)
    - [User edits a file while app is running](#user-edits-a-file-while-app-is-running)
    - [Multiple windows of the same workspace](#multiple-windows-of-the-same-workspace)
    - [Switching workspaces](#switching-workspaces)

<!-- tocstop -->

The desktop app (`apps/desktop`) uses a minimal, file-based state model. Persistent state
lives in project files and browser storage, while in-memory state is ephemeral and rebuilt
on demand.

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

- The first load of a playable initializes from the `start` scene in `story.play.json` at
  frame 0
- Each advance/back updates the history array in memory
- **Save button:** Serializes history to `localStorage`
- **Load button:** Deserializes from `localStorage` back to memory
- **Reset button:** Clears history and returns to the start scene
- **Survives:** Page reload, app restart
- **Lost when:** Browser storage is cleared, or the user browses in incognito/private mode

**Code:** `renderer/pathux/play/playback.ts` holds the "pure" (no `localStorage`)
`saveKey` and save blob, and is tested. `renderer/pathux/editors/play.ts` holds the
`localStorage` calls.

---

### 2. Remembered UI State (Persistent via the desktop session store)

**Holds the pane arrangement and selection the user left in the project.**

Storage uses two `SessionStore` files (flat key/value stores in
`src/main/sessionstore.ts`):

| File                                     | Holds                                                          | Scope                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `<root>/.vnstudio/session.json`          | `pathux.` keys: mesh, selection, applied template, window list | Project's own; beside layout templates; **gitignored**                                        |
| `<userConfigDir()>/desktop/session.json` | `agent.budget`, `vn.notifications.filter`, recents list        | Install's home; `%LOCALAPPDATA%\vnauthor\desktop` on Windows; override with `VN_DESKTOP_HOME` |

**Storage decisions:**

- The install file is stored in the same location as API keys, outside the repo and
  outside the bundle (a packaged app's `__dirname` is inside `app.asar`)
- The project stores the arrangement (not the install) because an author moves a project
  as a unit
    - History used to live in install under a digested path key. Renaming lost the
      arrangement, a second install lost the history, and clearing one project's state
      cleared the state of every project.
    - The file is gitignored (not committed) because it changes on every border drag. A
      tracked file churns `git status` and conflicts on pulls.
    - The shareable half is a [layout template](desktop-app-shell.md#layout-templates),
      which is committed.
- The ignore entry is the glob `.vnstudio/session.json*` (the trailing `*` matches the
  `.tmp-<hex>` sibling that `writeFileAtomic` writes)
- Undo excludes it (`UNDO_EXCLUDES` in the snapshot store) and skips `.tmp-<hex>`
  siblings. Without this, a pane drag between an edit and an undo would count as drift and
  the undo would be refused
- `writeScaffolding` rewrites the ignore line on every open, so it repairs a hand-edited
  `.gitignore`

**Shape:** Flat `Record<string, SessionValue>` with dotted keys, scoped by window index
(built in src/shared/sessionkeys.ts):

```jsonc
{
    "pathux.window.0.layout"   : {/* nstructjs-serialized screen, magic "VNSC" */},
    "pathux.window.0.template" : "writing",
    "pathux.window.0.selection": {
        "sceneId"    : "arrival",
        "shotId"     : "",
        "characterId": "aiko",
        "docPath"    : "characters/aiko/character.md",
        "assetHash"  : "9f2c…",
        "taskHash"   : "",
    },
    "pathux.window.1.layout"   : {/* the second window's own mesh */},
    "pathux.windows": [
        { "id": 0, "bounds": { "x": 0, "y": 0, "width": 1360, "height": 860 } },
    ],
}
```

**Key routing and restoration:**

- The window index is load-bearing. Flat keys failed because `view.applyLayout` in window
  A wrote `pathux.template`, and then `view.resetLayout` in window B re-applied A's
  template to B
- `isProjectKey` decides which file a key lands in by matching its prefix. `SessionState`
  routes every read and write, rather than individual stores doing so.
- `CommandHost.state` routes rather than stores, so `view.*` writes go to the right file
- The renderer reads its window id from the URL (`?window=<n>&ws=<scope>`) rather than
  over IPC, so layout and selection restore before the first paint
- `ws` is the workspace digest. Every project-key write carries it, so main drops writes
  from windows that are reloading after a workspace switch.
- Reads the legacy flat keys (`pathux.{layout,selection,template}`) once as window 0 and
  never writes them again. The first open seeds the project file from the install's keys.
- A project whose `.vnstudio` file cannot be opened keeps no arrangement and logs one
  warning. Reads return the default and writes are dropped. The install file is
  unaffected.

**Lifecycle:**

- Main opens the store during `app.whenReady()`, before any window exists
- Preload reads the snapshot synchronously (`session:snapshot:sync`), so the first paint
  draws the stored layout. An async fetch would render the default layout first and then
  jump to the stored one.
- `pathux/persist.ts` writes both keys on a 400 ms debounce, and again on `beforeunload`
  (quitting does not run the debounce)
    - `VnScreen.onLayoutChange` reports the layout after a split, join, border drag, or
      window resize
    - `DataPathWatcher`s on
      `ui.{sceneId, shotId, characterId, docPath, assetHash, taskHash}` report selection
      (the widgets receive the same push)
    - Every persisted field needs its own watcher, because clicking an asset moves only
      that field
- Selection fields notify on write: `ShellState.onSelect` calls `api.notifyChange` in
  `renderer/pathux/app/shell.ts`. Without this hook, path.ux watchers do not fire from
  editor assignments.
    - The six selection fields are accessors over one private record, so a field whose
      value has not changed reports nothing
- Watchers use `immediate` rather than the default `raf`, because hidden or minimized
  windows run no animation frames, so raf-coalesced watchers stay dirty until the window
  is shown. `schedule` has a 400 ms debounce.
- `view.*` effects schedule saves themselves (`applyView` in
  `renderer/pathux/panes/view.ts`). Pane editor swaps do not fire `onLayoutChange`, so the
  old pane comes back on restart without an explicit save here.
- Restored ids are checked once after first paint (`settleSelection` in
  `renderer/pathux/app/shell.ts`):
    - Repairs `assetHash` through one `asset.info`. Fails if the manifest no longer holds
      it, and clears `assetHash` in that case. Carries `newerTake` for a replaced take,
      and the selection follows.
    - Clears `sceneId` and `characterId` if the workspace index does not list them. Clears
      `shotId` when its scene is cleared.
    - `docPath` is not pruned (the doc tree caps a branch and has a file-tree mode, so a
      path missing from the tree may still exist)
    - Every write back checks that the field still holds the value restore wrote, because
      the author may have clicked something
- `ui.taskHash` is persisted and has no repair rule. The hash is `sha256(kind, inputs)`
  and stays the same while the inputs stay the same. The inspector fetches the hash once
  and draws nothing if the hash is not found.
- Switching workspaces reloads every window rather than re-applying in place, so each
  window re-runs boot against the new project's file
- Pane-remembered fields are stored in the layout blob rather than beside it:
  `registerEditor` takes an optional `fields` list, nstructjs writes them to the pane's
  struct, and they survive both a restart and a pane move.
    - Editor calls `layoutChanged()` itself; `onLayoutChange` does not report changes
      inside panes
- Layout is saved and loaded with nstructjs through path.ux's
  `simple.saveFile`/`loadFile`. The schema is stamped into the blob, so a file reads back
  even after STRUCT changes.
    - Boot never blocks. Corrupt or unsupported layouts are discarded, and the default
      screen takes their place.
- The template key differs from the others. Main writes it in
  `view.applyLayout`/`view.saveLayout`/`view.resetLayout`, and it points into the project
  as a layout template slug.
    - Main derives the window key from `ctx.origin`. Commands with no origin (agent, CDP)
      use the focused window.
    - The arrangement is stored in `pathux.window.<n>.layout` (panes belong to the window
      even if a project named the arrangement); see
      [Layout templates](desktop-app-shell.md#layout-templates)
- Writes are merged per key under a `mkdir` lock, so two running instances do not clobber
  each other. The last flush of a given key wins.
- **Survives:** app restart, renaming or copying the project directory
- **Lost when:** the file is deleted, or the project is cloned elsewhere (git does not
  carry it)

**Code:** `src/main/sessionstate.ts`, `src/main/sessionstore.ts`,
`src/shared/sessionkeys.ts`, `renderer/pathux/app/persist.ts`, `renderer/rules/uistate.ts`

---

### 3. UI State (Ephemeral, in the shell)

The workspace state: everything the author sees and interacts with that is not a project
file, including selection, conversation, pipeline status, and the header.

**Storage:** Two modules hold renderer memory, plus per-editor state.

**`ShellState` (`renderer/pathux/app/state.ts`)** — Holds the root of the path.ux DataAPI
and is the only source widgets can bind to. Document state is not stored here. Widgets
write by dispatching commands through `@vn/commands`.

| Field                                             | Type                      | Notes                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sceneId` / `shotId` / `characterId`              | `string` (`''` = nothing) | One authored selection every editor observes, any editor may publish. **Persisted** (category 2)                                                                                                                  |
| `docPath`                                         | `string` (`''` = nothing) | Which document wiki editor is on; the one selection field that names a **path** not id (free-form note under `wiki/` has no id). `view.open`/`view.focus` publish from `subject` prop. **Persisted** (category 2) |
| `taskHash`                                        | `string`                  | Which task the inspector is open on. **Persisted** (category 2), no repair rule; hash is stable while inputs are, inspector draws nothing if not found                                                            |
| `assetHash`                                       | `string`                  | Which asset the asset editor is on. **Persisted** (category 2), repaired at boot via one `asset.info`                                                                                                             |
| `projectTitle`                                    | `string`                  | Pushed from `workspace:index`                                                                                                                                                                                     |
| `model`                                           | `string`                  | Text model id for header badge                                                                                                                                                                                    |
| `agentMode`                                       | `'plan' \| 'execute'`     | Mirrored from `agent.setMode` outcome and `agent:event`                                                                                                                                                           |
| `errors` / `warnings`                             | `number`                  | Counted separately; errors displace warnings in badge                                                                                                                                                             |
| `unread`                                          | `number`                  | Bell shows unread, unarchived notifications matching active filter. Written by `pathux/notifications.ts`, never counted in header (badge and list cannot disagree)                                                |
| `canUndo` / `canRedo` / `undoLabel` / `redoLabel` | `boolean` / `string`      | Pushed on `command:ui` `undo` effect                                                                                                                                                                              |

**The conversation (`renderer/pathux/agent/agent.ts` + `src/shared/convo.ts`):**

- The subscription is created at boot whether or not the convo pane is open. The agent
  streams either way, and a pane opened later shows what was already said.
- Holds `{ feed, line, plan, busy, seq }` and folds every `agent:event` through the "pure"
  (side-effect-free) `received`/`asked`/`answered`/`proposed`/`decided` functions
- The pane detects changes by comparing the revision counter; `update()` runs every frame
- `busy` is raised by the pipeline run, not only by the turn.
- The reducer lives in `src/shared/convo.ts` because main runs it too. Main appends every
  feed item the reducer folds in to the open thread, so the transcript on disk matches the
  transcript on screen instead of being a second rendering.

**General principles:**

- **Which editor is on screen is decided elsewhere.** `view.*` commands run in main and
  push a `command:ui` effect. The mesh applies that effect, and answers with a correction
  only if it disagrees; see [`command-system.md`](command-system.md). The screen is the
  state, persisted as one blob.
- **Per-editor state stays in editor** (draft being typed, live gesture, scroll position).
  A redraw key excludes that state on purpose. path.ux calls `update()` every frame, so
  keying rebuild on the draft text would replace the field under the caret
- **Workspace index is re-read, never remounted.** Edits made in the editor re-read
  `workspace:index`, so diagnostics and cast stay current. No revision counter remounts
  the pane mid-gesture.
- **Lost on:** page reload and app restart, since nothing is persisted. Selection
  (category 2) is the exception.

---

### 4. Backend State (Main Process, Ephemeral)

Runs the agent server-side, holds loaded models, and mediates file I/O.

**Storage:** Each workspace has one in-memory `WorkspaceSession` instance.

**Structure:**

```typescript
class WorkspaceSession {
    dir: string; // Workspace root
    mock: boolean; // Offline mode?
    agent?: Agent; // Lazy-initialized
    model: string; // Text model id

    // Methods that rebuild on-demand:
    // - ensureAgent()    → loads/reuses Agent
    // - buildBackend()   → creates ChatBackend for configured model
    // - loadProject()    → reads config, model, store, graph from files
}
```

**On-demand resources:** | Resource | Built by | Cached | Holds |
|----------|----------|--------|-------| | `Agent` | `ensureAgent()` | Yes (lazy) |
Conversation history, mode, backend | | `ProjectConfig` | `loadProject()` | No (re-read
each call) | `project.yaml` parsed + validated | | `ProjectModel` | `loadProject()` | No
(re-read each call) | Characters, locations, scenes, validated story graph | |
`AssetStore` | `loadProject()` | No (re-read each call) | `build/assets/` index +
`manifest.json` | | `TaskGraph` | `loadProject()` | No (re-read each call) |
`state/tasks.jsonl` parsed into task nodes | | `ChatBackend` | `buildBackend()` | Yes (per
Agent) | Anthropic or Gemini client |

**Lifecycle:**

- Created when the app loads a workspace
- The `agent:run` IPC call initializes `Agent` on the first user input
- Project data (config, model, store, graph) is rebuilt on each IPC call that needs it.
  The rebuild is intentional and ensures the latest disk state is used.
- Lost on app restart, then rebuilt from files

**Hot-swapping:**

- The model can be switched mid-conversation with `agent:setModel(newModelId)`, which
  rebuilds the `ChatBackend` and preserves the Agent state.
- `agent:setMode()` toggles the mode without losing context

**Code:** `WorkspaceSession` in `src/main/session.ts`

---

### 5. Project Files (Persistent on Disk)

Authored inputs and generated outputs are the source of truth for everything else.

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

**Path authority:** `packages/store/src/paths.ts` is the single authority for paths, and
the documents in this tree read it. The graph documents, definitions, journals and blobs
under `graphs/` are described in
[`gen-graphs.md`](gen-graphs.md#where-things-live-on-disk). `loadInputs`
(`packages/store/src/worktree.ts`) discovers scene files: it reads `scenes/` and only
reports leftover `screenplay/`.

**Committed:**

- `project.yaml`, characters, locations, scenes
- `vngen/` generated outputs (graph, manifest, assets)

**Not committed:** `keys/`, `.env` files

**Read by main process via:**

- `@vn/config` — parses `project.yaml`
- `@vn/parse` — parses Fountain and front-matter
- `@vn/store` — reads characters/locations and indexes `build/assets/`
- `@vn/model` — validates and builds the story graph
- `@vn/taskgraph` — reads `state/tasks.jsonl`
- `@vn/git` — wraps the git CLI for diff, commit, and log

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

| Data                                                              | Where                                                       | Persists?                                               | Who Reads                                                                   | Who Writes                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Playthrough position                                              | `localStorage`                                              | ✓ Survives restart                                      | Runner component                                                            | Save button                                                                                                         |
| Pane layout                                                       | `.vnstudio/session.json` (`pathux.window.<n>.layout`)       | ✓ Survives restart                                      | `restoreLayout`                                                             | Every split/join/drag, debounced                                                                                    |
| Selected scene/shot/character/document/asset/task                 | `.vnstudio/session.json` (`pathux.window.<n>.selection`)    | ✓ Survives restart                                      | `restoreSelection`, then `settleSelection`                                  | The `ui.*` datapath watchers                                                                                        |
| A field a pane remembers (the documents editor's mode)            | `.vnstudio/session.json` (inside the window's `…layout`)    | ✓ Survives restart                                      | nstructjs, with the pane                                                    | The editor, via `layoutChanged()`                                                                                   |
| Whether a pane is pinned, and to what                             | `.vnstudio/session.json` (inside the window's `…layout`)    | ✓ Survives restart                                      | nstructjs, with the pane                                                    | The pin toggle, via `VnScreen.onLayoutChange`                                                                       |
| Which layout template the window shows                            | `.vnstudio/session.json` (`pathux.window.<n>.template`)     | ✓ Survives restart                                      | `view.layouts`, the layout watch                                            | `view.applyLayout` / `saveLayout` / `resetLayout`, in main                                                          |
| The layout templates themselves                                   | `.vnstudio/layouts/*.json` (the **project** repo)           | ✓ On disk, committed                                    | `view.layouts` / `view.applyLayout`                                         | `view.saveLayout`, `view.resetLayout`, `ensureLayouts`                                                              |
| The conversation on screen                                        | Renderer memory (`pathux/agent.ts`)                         | ✗ Lost on restart                                       | Every convo pane                                                            | Agent events + `agent.run`                                                                                          |
| The conversation as a transcript                                  | `vngen/state/threads/<id>.jsonl`                            | ✓ Survives restart                                      | `agent.threads` / `agent.openThread`                                        | Main, one line per feed item plus one per API call's receipt, as the turn runs                                      |
| The conversation as the model saw it                              | `vngen/state/threads/<id>.native.jsonl`                     | ✓ Survives restart                                      | `agent.resumeThread` / `agent.compact` and the agent's own `search_history` | Main, one line per model message, as the turn runs                                                                  |
| Header facts and per-editor drafts                                | Renderer memory                                             | ✗ Lost on restart                                       | The header and each editor                                                  | Bridge pushes + user gestures                                                                                       |
| Agent context                                                     | Main process memory                                         | ✗ Lost on restart                                       | Agent instance                                                              | agent:run IPC                                                                                                       |
| Project config                                                    | Files                                                       | ✓ On disk                                               | Main (lazy load)                                                            | Author / editor                                                                                                     |
| Story model                                                       | Files                                                       | ✓ On disk                                               | Main (lazy load)                                                            | Pipeline + authoring agent                                                                                          |
| Assets                                                            | `build/assets/`                                             | ✓ On disk                                               | AssetStore                                                                  | Pipeline image tasks                                                                                                |
| Manifest                                                          | `vngen/build/manifest.json`                                 | ✓ On disk                                               | AssetStore                                                                  | Pipeline tasks                                                                                                      |
| Task graph                                                        | `vngen/state/tasks.jsonl`                                   | ✓ On disk                                               | TaskGraph loader                                                            | Pipeline runner                                                                                                     |
| Command history                                                   | `vngen/state/commands.jsonl`                                | ✓ On disk                                               | `CommandStack` (`command:history`)                                          | Every command execution, via `onRecord`                                                                             |
| Notifications                                                     | `vngen/state/notifications.jsonl`                           | ✓ On disk                                               | `notify:list` / the bell                                                    | Every filed command outcome, every pipeline task, every shell notice                                                |
| Which categories the list shows                                   | `desktop/session.json` (`vn.notifications.filter`)          | ✓ Survives restart                                      | `pathux/notifications.ts`                                                   | The filter popup and the "show deleted" box                                                                         |
| Which projects were opened recently, and the agent's token budget | `desktop/session.json` (`workspace.recent`, `agent.budget`) | ✓ Survives restart, on this machine                     | `recentWorkspaces`, the agent runner                                        | `rememberWorkspace`, `agent.setBudget`                                                                              |
| Undo snapshots                                                    | `ContentStore`, in the main process                         | ✗ Dropped when the app closes or the workspace switches | `UndoJournal`                                                               | Every undoable command — the eighteen `story.*` ones, the document writers, and the two that write layout templates |

---

## Rebuilding After Restart

**Immediate state on app restart:**

1.  1. **Renderer memory is cleared.** The transcript, the header facts, and every draft
       are gone.
2.  2. **Playthrough saved to localStorage.** If the author was in the Play editor, click
       Load to restore the position.
3.  3. **`.vnstudio/session.json` is restored synchronously, before first paint.**
    - Restores pane layout and selection from the project being opened
    - A layout that fails to load falls back to the Writing arrangement (documents tree,
      script with branch cards, agent)
    - The window's template key comes back, the layout watch seeds from it without
      re-applying, and a border drag is not discarded
    - Repairs the selection after first paint. One `asset.info` call repairs the asset
      hash, and the repair clears a scene or character that is missing from the workspace
      index.
4.  4. **Project files are unchanged.** The workspace loads with the latest committed
       state.
5.  5. **The main process rebuilds on first use.**
    - The first IPC call (e.g., `workspace:index`) lazy-loads the project and creates the
      Agent.
    - Subsequent calls may rebuild the project (there is no cache) but reuse the Agent.

**Conversation recovery:**

On-screen conversation is not recovered. The renderer opens empty, and main starts a fresh
`Agent` that loads `AICONTEXT.md` to restore plan-mode context through `@vn/authoring`'s
persistent system prompt.

The transcript is recovered. Every turn is written to `vngen/state/threads/<id>.jsonl` as
it runs, and the convo pane's **Threads** menu reopens one. Reopening replays the stored
feed and says so in the dialog, and the model sees nothing of it. **Continue** shows the
feed to the model and reads `<id>.native.jsonl` (the same conversation as the backend
messages sent), so the agent picks up where it left off.

**File comparison:**

- Transcript: each line is clamped to a few hundred characters
- The native log holds every tool call and result at full length. It is larger by a wide
  margin: a dozen-file read leaves megabytes.
- Both are written from the same events, but neither is a projection of the other. Only
  the transcript is drawn.

**Persistence and merge:**

- Both are append-only and are committed with `vngen/state/`, so project history carries
  them
- `.gitattributes` marks `vngen/state/threads/*.native.jsonl` as `-merge`, because a log
  merged line by line is useless and Continue refuses conflict markers
- **Compact** bounds the live conversation. It appends a summary line, and the agent sees
  that summary instead of the messages. Every covered line stays on disk for
  `search_history`.

---

## IPC Contract

**Renderer calls these, main responds:**

| Channel           | Args                     | Response          | Persisted?                                                                                       |
| ----------------- | ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------ |
| `workspace:index` | none                     | WorkspaceIndex    | No (rebuilt each call)                                                                           |
| `agent:run`       | `userInput: string`      | RunResult         | No (state in Agent)                                                                              |
| `agent:setMode`   | `mode: AgentMode`        | AgentMode         | No (Agent in memory)                                                                             |
| `agent:setModel`  | `modelId: string`        | string            | No (backend rebuilt)                                                                             |
| `agent:clear`     | none                     | void              | No (Agent reset)                                                                                 |
| `agent:system`    | none                     | AgentSystem       | No (assembled per call, from files)                                                              |
| `plan:decision`   | `{ id, decision }`       | void              | No (resolves permission)                                                                         |
| `pipeline:status` | none                     | PipelineStatus    | No (rebuilt from files)                                                                          |
| `pipeline:run`    | `{ mock: boolean }`      | PipelineRunResult | No (executes fresh)                                                                              |
| `gate:candidates` | `characterId: string`    | GateCandidate[]   | No (read from manifest)                                                                          |
| `gate:approve`    | `{ characterId, hash }`  | ApproveResult     | No (edits file + store)                                                                          |
| `story:play`      | none                     | Playable          | No (built on-demand)                                                                             |
| `story:graph`     | none                     | StoryGraph        | No (read; mutations go through `story.*` commands)                                               |
| `story:coverage`  | `sceneId: string`        | SceneCoverage     | No (read; the edit is `story.setCoverage`)                                                       |
| `command:catalog` | none                     | CommandCatalog    | No (the **live** registry, never the generated file)                                             |
| `command:exec`    | CommandExecRequest       | CommandOutcome    | **Yes** — appends to `vngen/state/commands.jsonl`                                                |
| `command:history` | `limit?: number`         | CommandRecord[]   | No (read back from the log)                                                                      |
| `notify:list`     | none                     | Notification[]    | No (read back from the log, deduped and sorted)                                                  |
| `notify:post`     | NotificationInput        | Notification      | **Yes** — appends to `vngen/state/notifications.jsonl`                                           |
| `command:check`   | `{ id, props? }`         | CommandCheck      | No (a read, never a gate — `exec` re-decides)                                                    |
| `command:undo`    | none                     | CommandOutcome    | **Yes** (restores a snapshot; refuses on drift)                                                  |
| `command:redo`    | none                     | CommandOutcome    | **Yes**                                                                                          |
| `session:set`     | `{ key, value, scope? }` | void              | **Yes** — a `pathux.` key to `.vnstudio/session.json`, everything else to `desktop/session.json` |

Commands are the only write path, and the `story:*` reads and the `command:*` family
together enforce that. The branch editor and the timeline have no mutating IPC channel. A
read channel feeds the view, and every edit is a `story.*` command with a `CommandRecord`.
See [`command-system.md`](command-system.md).

`session:snapshot:sync` differs from the other channels in that it is a synchronous
`ipcMain.on` channel. The preload calls it once, before first paint, so the renderer never
renders a default layout and then jumps. The channel returns the two session files as one
map, so the renderer reads a flat key/value store and never learns which file a key came
from. The two key sets are disjoint, so the merge has nothing to resolve.

`pipeline:status` returns tasks that main narrows at the boundary (`src/main/reviews.ts`),
not raw pipeline tasks. `TaskAttempt.reviews` is `unknown[]` in `@vn/types` because it is
read back from `tasks.jsonl` as JSON; main parses each entry with `defectReportSchema` and
drops the ones that fail, so the renderer's `Task` can promise `reviews: DefectReport[]`.
Main also stamps `outputExt` by looking the attempt's output hash up in the manifest. An
attempt records only the hash, and the Inspector editor needs both the hash and the
extension to build a `vnasset://<hash>.<ext>` url.

**Main pushes these to renderer:**

| Channel           | Payload              | When                                                                                                                                                                                                       |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent:event`     | AgentEvent           | During agent:run (each step)                                                                                                                                                                               |
| `permission:plan` | PlanRequest          | Agent needs approval                                                                                                                                                                                       |
| `command:ui`      | UiEffect             | A `view.*` command named an editor or a pane, the palette opened, undo state moved, or a workspace opened                                                                                                  |
| `notify:changed`  | `{ note? }`          | A notification was filed, or one's read/hidden flag moved. Carries the note when there is a new one; the renderer's answer to either is a refetch, and the note is what the one surviving note frame shows |
| `session:changed` | `{ key, value }`     | Any session write, whoever made it                                                                                                                                                                         |
| `log`             | `{ level, message }` | Diagnostic logging                                                                                                                                                                                         |

---

## Design Rationale

### Why so little persistent UI state?

- The app is a client for a workspace, not a REPL with a long-lived conversation
- Restarting should leave the session in the same state as a newly opened terminal in the
  project directory
- The authoring workflow is "step-and-approve": the user proposes, the agent plans, the
  user approves, and the agent executes. Mid-turn loss is acceptable.
- Persist the pane layout and selection, since the user arranged them by hand and would be
  annoyed to redo them. Derived and transient state stays ephemeral.

### Why a main-process file, not localStorage, for the layout?

- Preload reads the main-process file synchronously before first paint, so the saved
  arrangement does not jump into place.
- Two Electron instances clobber each other in `localStorage`; per-key merge under lock
  does not
- `localStorage` is keyed by origin, so an install gets one bucket. The main process can
  split storage by ownership.

### Why the arrangement lives in the project rather than the install?

- Arrangement describes the project it was made for, and its panes are pinned to that
  project's scenes and characters
- The install file approach required a key per project, so the number of keys grew without
  bound and nothing signalled that a key could be cleaned up when a project was deleted
- Moving or renaming a project lost the arrangement, because the key was a digest of the
  path
- The file is gitignored, so the arrangement stays local to the clone. Committing it would
  churn `git status` and conflict on pulls.
- `UNDO_EXCLUDES` names it separately so that debounced writes are not counted as drift

### Why re-read project files on each call?

- Ensures main always sees the latest disk state (for example, after the user hand-edits a
  file)
- Avoids cache-coherency issues, because an agent's file edits are immediately visible to
  the next pipeline run
- Cheap: files are small and are parsed only when needed

### Why localStorage for playthrough?

- Simple, browser-native persistence
- Per-title key prevents collisions across projects
- Survives page reload without a backend round-trip
- No database or server required

### Why build the playable on-demand?

- The playable is derived entirely from the model and assets, and stores no new data
- Exporting `story.play.json` writes the same structure to a file
- Player can start even if export hasn't been run yet

---

## Edge Cases

### App restarts mid-run

- **Agent state:** Lost, so the user starts a fresh conversation on the next load.
  Completed turns remain in `vngen/state/threads/`, and the Threads menu reads them back.
- **Project state:** Safe; files unchanged, last task status in `tasks.jsonl`
- **Playthrough:** Safe. The position is saved in `localStorage`.

### User edits a file while app is running

- **Next IPC call:** Main re-reads the file (there is no cache) and sees the edit.
- **Agent:** After the agent reads a file into context, that context is stale until the
  agent re-queries.

### Multiple windows of the same workspace

- **Architecture:** One process holds one `WorkspaceSession`, one `CommandStack`, and one
  undo history. N windows render that session, and each window is a renderer rather than a
  separate app instance
    - (Note: "separate instance per window" was never true and must not become true; see
      lock below)
- **Session store:** One `SessionState` wraps two `SessionStore`s (the install's and the
  project's). The per-key `mkdir`-locked merge matters between instances on different
  projects, not between windows.
    - Scopes window keys by index, so that two windows that arrange panes differently do
      not race
    - A lock left behind by a killed instance is broken after 5s
- **localStorage:** Shared by origin, so playthrough saves still clobber one another and
  the last window to write wins. That behavior is unchanged, because localStorage is the
  renderer's own store.
- **One instance per workspace, enforced via `src/main/instancelock.ts`:** Opens a
  listening socket keyed by the resolved root digest.
    - Binding performs the acquisition, and the endpoint is released when the process
      exits.
    - Launching on an owned root hands off, telling the owner to come forward and exiting
      before opening a window
    - `workspace.open` refuses the same case by name
    - **Not** `app.requestSingleInstanceLock()` (it would forbid two instances on
      different repos, which share nothing that can collide)
    - (The two processes each hold their own undo history over the same worktree. A
      restore in one process is drift that the other refuses, and both collide in the
      committer's `-A` sweep. The failures are silent.)

### Switching workspaces

- The process holds one workspace at a time, and that workspace is no longer fixed for the
  process lifetime. `workspace.pick` and `workspace.open(path='…')` switch it in place.
- The launcher tries `--project`/`VN_PROJECT` first, then the most recent project, then
  the picker, then the seeded sample.
- **Switching tears everything down:** the session, command stack, undo journal, repo map,
  and undo revision are rebuilt against the new root
    - Undo never crosses a project boundary
    - Nothing may cache the root; `vnasset://` resolves `ProjectPaths` on each request
    - Every window reloads and re-runs boot against the new project's session file
    - Pushes a `{ type: 'workspace' }` effect for windows that were not reloaded
- The project stores layout and selection keyed per window. Switching opens the last
  arrangement rather than carrying over the old project's selection.
    - A window that has not reloaded cannot write to a just-opened project. The window
      stamps its writes with its load scope, and main drops mismatched stamps.
- Switch acquires the new workspace's lock before teardown and releases the old lock
  afterward. Switching to an already-owned project is refused, and the owning instance is
  brought forward.
- Full write-up: [`desktop-app-state.md`](desktop-app-state.md#which-project-is-open)

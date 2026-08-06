# Desktop app rewrite on path.ux

Status: **planned.** Item 1 of [`refactorTaskList.md`](refactorTaskList.md). Replaces the
three-room React renderer with path.ux's subdividing screen — the §UX requirement of
[`../designRequirementsEtc.md`](../designRequirementsEtc.md) — while keeping the main
process, the IPC shapes, `WorkspaceSession` and the `@vn/commands` registry as they are.
The evaluation that led here is recorded in
[`refactorTaskList.md`](refactorTaskList.md#decisions-taken-so-far): path.ux's
`FrameManager.ts` hard-imports its widget modules and `Area`/`ScreenArea` are `UIBase`
custom elements, so the frame manager comes with the widget library or not at all; React is
displaced from the renderer.

<!-- toc -->

<!-- tocstop -->

## Why

The room model is over budget: three rooms, modes-within-rooms, three independent scene
selections, two mode-switch mechanisms, seven surfaces for one gate — the incoherence
diagnosis is in the conversation record and its structural half is what a pane model fixes.
The requirements then settle the direction: *"a 2d subdividing dockable UX that subdivides
into 'editors'"*, each with optional header, footer and sidebar panels — which is a
description of path.ux's `Area` + `PanelManager`, already built (screen mesh, split/join,
`AreaDocker` tabs, tear-out floating windows, layout serialization) rather than to be built.

## What carries over, what dies

**Carries over unchanged:** everything in `apps/desktop/src/main/` — `WorkspaceSession`, the
37 commands, `stack.check`, undo, the IPC channels, `vnasset://`, the catalog build step.
The pure renderer cores with `tests/` siblings (`script.ts`, `coverage.ts`, `taskGraph.ts`,
`layout.ts`, `hit.ts`, `attempts.ts` and kin) — they are framework-free by the repo's own
rule and become the editors' logic layer. `@vn/scriptedit`'s pure barrel for mid-gesture
verdicts. The `--mock`/`--project` flags.

**Dies:** every `.tsx` file (~6,300 LOC), `react`/`react-dom` from `apps/desktop`'s
dependencies, the `Room`/`StudioMode`/`FloorMode` vocabulary end to end, the single
window-level keydown handler, and the by-room organization of `styles/` and
[`../desktop-app.md`](../desktop-app.md).

**Changes shape:** `view.*` commands (rooms → editors), `.vndesktop/session.json` (panel
widths → serialized screen layout), `tokens.css` (design contract re-expressed as a path.ux
theme — `--sodium`/`--signal` survive as the two accent hues; the rule "no new accents"
survives with them).

## Ground rules

- **path.ux is a git submodule** at `vendor/path.ux`, cloned from
  `https://github.com/joeedh/path.ux`. It carries its own nested submodule
  (`scripts/path-controller`), so setup is `git submodule update --init --recursive`. It is
  *not* a pnpm workspace member — vite compiles its TypeScript source directly through an
  alias, so there is one build pipeline and no prebuilt `dist/pathux.js` to keep in sync.
  `pnpm check:renderer` grows to cover the imports the renderer actually makes;
  path.ux's own internals stay checked by its own repo.
- **`@vn/commands` remains the only write path.** path-controller ships inside the
  submodule, and path.ux's `Context` contract requires `api` (a DataAPI/ModelInterface),
  `screen` and `toolstack` — so we *provide* them, minimally: the DataAPI is registered over
  a small renderer-local UI-state store (selection, theme, per-editor view state) so widgets
  can bind, and the `toolstack` hosts only path.ux's own screen operations (splits, docks).
  Document state never enters either: a widget that would mutate the project dispatches a
  command via the existing `exec`, and document undo stays `command:undo` on shadow refs.
  This is the "not adopted as app↔UX glue" decision made precise: path-controller runs, but
  only under the UI.
- **One selection.** The scene/shot/character selection becomes shell state in that UI-state
  store, observed by every editor — retiring the three independent `useState` selections.
  Selection and layout both persist across relaunch.
- **The mid-gesture verdict contract survives verbatim.** Overlays call the same pure rules
  the command runs. Two new rulings for the pane world, decided now: a semantic drag never
  crosses an Area boundary, and screen-mesh splitters are inert while a semantic gesture is
  in flight.
- **Keyboard routing is per-area.** path.ux keymaps on the focused Area replace the window
  keydown; the palette (`/`), undo accelerators and Escape become app-level keymap entries.

## The editors

Seven exist and port; the rest arrive later with their backend items. Port order is
cheapest-first so the shell hardens before the hard ones land:

| # | Editor | From | Notes |
| --- | --- | --- | --- |
| 1 | Play runner | `rooms/play/` | Simplest DOM; also gets the missing frame→shot/scene jump, closing the "PLAY is a dead end" item |
| 2 | Story graph / task DAG | `renderer/graph/` | The shared canvas is already imperative + `ResizeObserver`; closest to framework-free today |
| 3 | Task list + inspector | `rooms/floor/` | Lists and detail panes; first real use of sidebar panels |
| 4 | Coverage timeline | `rooms/floor/timeline/` | First semantic-drag editor; proves the gesture rulings |
| 5 | Branch editor | `rooms/studio/branch/` | Second gesture surface |
| 6 | Script column | `rooms/studio/script/` | The hardest: list-of-lines editing, open-row keystroke ownership, confirmed cross-scene acts — all its rules are already in pure modules |
| 7 | Convo (agent) | `rooms/studio/Convo.tsx` + `useAgent` | Ports last; also *unnests* — the editors stop being children of the conversation |

The gate gets **one** surface: a status element in the shell (header or footer), plus the
approval flow — replacing the four partial ones. Future editors (wiki/bible, document tree
sidebar, backlink panel, project picker) are named here so they have a declared home, but
they belong to their backend items (3, 9, 10 in the task list) and are out of scope.

## Steps

### 1. Submodule and build wiring

Add the submodule, the vite alias, the tsconfig entry for `check:renderer`, and a smoke
Area rendering inside the Electron window behind a `--pathux` flag. CI/`pnpm build` must
fail loudly when submodules are uninitialized (a doctor check naming the
`--init --recursive` command), not with a resolver error.

### 2. The shell

Screen boot, the minimal `Context` (UI-state DataAPI, screen, screen-ops toolstack), the
theme port of `tokens.css`, layout + selection persistence into `.vndesktop/session.json`
(nstructjs-serialized screen under a new key; the flat panel-width keys retire), the app
menu/header, and the palette as an app-level overlay. **Fix `App.tsx:100`'s
`mock: !isLive || true` in the new shell's run action from day one** (and independently on
the old shell — task-list item 11 — since the old shell survives through step 4).

### 3. Ports 1–3 (runner, graphs, list/inspector)

Read-only or list-shaped editors. Exit criterion: the new shell is livable for *watching* a
project — run, inspect, play — with the old shell still the default.

### 4. Ports 4–7 (timeline, branches, script, convo)

The gesture editors, then the conversation. Each drag/keystroke behavior is checked against
its pure rule's tests, which do not change. Exit criterion: full parity; flip the default
shell; the `--pathux` flag inverts to `--react` for one release of caution, then both flag
and old code delete.

### 5. Retire the room vocabulary

`Room`/`StudioMode`/`FloorMode` leave `src/shared/ipc.ts`; `view.room`/`view.mode`/
`view.panelSize` are replaced by editor-addressed commands (working names: `view.open`,
`view.focus`, `view.layout`) — designed with the agent in mind, since "the AI agent should
be able to help the user drive the app, showing the UX to edit or view any part of the
story project" is a requirement and the command catalog is how it does that. `catalogOf`
output, `commands.json`, the command tests and the palette follow.

### 6. Docs

[`../desktop-app.md`](../desktop-app.md) is rewritten organized by editor (its by-room
structure is part of the diagnosis); [`../desktopAppState.md`](../desktopAppState.md) for
the new session shape; `CLAUDE.md`'s renderer rules (the React-specific ones die, the
contract ones — mid-gesture verdicts, `src/shared/` browser-safety, one write path — are
restated for path.ux); the rows here, in [`index.md`](index.md) and in
[`refactorTaskList.md`](refactorTaskList.md).

## Risks and accepted costs

- **Custom elements vs HMR:** `customElements.define` cannot re-define, so dev iteration on
  widget classes is full-reload, not hot. Accepted; the dev loop stays `vite` +
  full-page reload for the shell.
- **`@vn/debug2d`** keeps working for DOM-rendered editor content, but path.ux widgets that
  draw to canvas are outside its DOM adapter's sight. Accepted as a regression for now; the
  canvas adapter was always the research doc's phase 2, and this creates the first real
  demand for it.
- **Component-level tests remain absent** (jest stays node-only). Same posture as today; the
  pure-core rule is what makes it tolerable, so it is enforced for new editor code too.
- **Two shells during steps 3–4** cost double maintenance on anything touching the renderer.
  Mitigation: the old shell is frozen — bug fixes only (item 11 being the one known).
- **Sizing model friction:** path.ux drives Area geometry imperatively (`setCSS()` writing
  pixel sizes); editor content must be honest `height:100%`/`min-height:0` flex/grid inside
  its Area. The existing stylesheets already are (only 11 room-scoped selectors, one `100vh`
  in `shell.css`), which is what makes the port tractable.

## Acceptance

Every workflow the current app supports, demonstrated in the new shell: author a scene,
wire a branch, run to the gate **for real** (the run-button bug dead), approve, render,
watch in PLAY, undo a story edit with the refusal sentence intact — plus the pane-model
wins: split any two editors side by side, persist and restore the arrangement, and drive
`view.open` from the palette, the agent and CDP. `pnpm check`, `pnpm test`, `pnpm lint`,
`pnpm build` green with React absent from `apps/desktop`'s dependency tree.

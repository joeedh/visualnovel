# The desktop app

`apps/desktop` is an Electron app with three rooms — **STUDIO · FLOOR · PLAY** — over one
`WorkspaceSession`. Every action it can take is a registered command
([`command-system.md`](command-system.md)); what it persists and where is
[`desktopAppState.md`](desktopAppState.md); what it plays is
[`playable-format.md`](playable-format.md).

<!-- toc -->

- [Running it](#running-it)
- [Renderer layout](#renderer-layout)
- [Graph canvas and the branch editor (STUDIO)](#graph-canvas-and-the-branch-editor-studio)
- [Script column (STUDIO)](#script-column-studio)
- [Task DAG view (FLOOR)](#task-dag-view-floor)
- [Coverage timeline (FLOOR)](#coverage-timeline-floor)
- [The runner (PLAY)](#the-runner-play)
- [Remembered UI state (`.vndesktop/session.json`)](#remembered-ui-state-vndesktopsessionjson)
- [Seeded workspace (`examples/mySampleRepo`)](#seeded-workspace-examplesmysamplerepo)

<!-- tocstop -->

## Running it

```sh
pnpm --filter @vn/desktop build && pnpm --filter @vn/desktop start -- --mock   # runs for real by default; --mock skips model calls
pnpm --filter @vn/desktop dev -- --mock                                       # live dev loop
```

`--project <dir>` overrides the workspace (`VN_PROJECT=<dir>` is an equivalent env fallback).

**Live dev loop:** `pnpm --filter @vn/desktop dev` (`scripts/dev.desktop.mjs`) runs the three
moving parts together — esbuild `--watch` (main + preload), the Vite renderer server with HMR,
and Electron launched against it once it's up (`VITE_DEV_SERVER_URL`, which
`src/main/index.ts` loads instead of the built file). Quitting the window (or Ctrl-C) tears the
whole tree down. `VN_DEV_PORT` overrides the renderer port (default 5176); any args after the
script's own (e.g. `--mock`, `--project <dir>`) are forwarded to Electron, and `VN_MOCK`/
`VN_PROJECT` still pass through as env fallbacks. Main-process edits need a restart (the
renderer hot-reloads on its own). The dev loop also defaults `VN_CDP_PORT=9222` — see
[`command-system.md`](command-system.md).

## Renderer layout

One directory per room, a thin shell, and a stylesheet split along the same seams. `main.tsx`
is the only `.tsx` at the root.

```
renderer/
  main.tsx              entry; installs @vn/debug2d behind import.meta.env.DEV
  api.ts                typed access to main; falls back to mock data outside Electron
  session.ts            `useSessionValue` — UI state durable in `.vndesktop/session.json`
  global.d.ts           ambient declarations for what the preload injects
  debug/install.ts      dev-only @vn/debug2d glue; vite build drops it entirely
  app/                  App.tsx (shell only), Topbar.tsx, Palette.tsx, useAgent.ts
                        catalog.ts (pure) — the palette's filtering and field coercion
  graph/                Canvas.tsx + pure layout · edges · hit · viewport (see below)
  rooms/studio/         Studio.tsx  Rail.tsx  Convo.tsx  PlanCard.tsx
                        diagnostics.ts (pure) — which diagnostics are a way into a scene
       …/branch/        BranchEditor.tsx  SceneCard.tsx  useBranch.ts
                        graph.ts · grab.ts · tween.ts · compose.ts (pure)
       …/script/        ScriptEditor.tsx · script.ts (pure)
  rooms/floor/          Floor.tsx   TaskBoard.tsx  Inspector.tsx  AttemptLoop.tsx
                        TaskGraphView.tsx · attempts.ts · taskGraph.ts (pure) · GateOverlay.tsx
       …/timeline/      Timeline.tsx  ShotBracket.tsx · coverage.ts (pure)
  rooms/play/           Runner.tsx
  ui/                   Resizable.tsx — shared by two rooms, so it belongs to neither
  styles/               index.css @imports tokens · shell · studio · floor · play · graph ·
                        branch · taskgraph · timeline · script
```

- **`App.tsx` owns only the shell**: `room`, `paletteOpen`, the workspace index/status, and the
  `command:ui` subscription (`view.*` commands target the shell). The agent conversation —
  feed, `dboxLine`, plan requests, `send`/`toggleMode`/`clear` — lives in `useAgent.ts` and is
  passed to STUDIO as one object. `busy` is deliberately shell-wide, not agent-only: a pipeline
  run from FLOOR disables the composer too.
- **`styles/index.css` import order IS cascade order.** It reproduces the top-to-bottom order
  of the single sheet this was split from, so a room's `@media` block still overrides the base
  rule it narrows. Add a new sheet at the **end**, not the middle. Vite inlines the `@import`s
  at build time, so one stylesheet still ships.
- **`tokens.css` is the design contract**: `--sodium` `#f4a24c` is warm — the authored/human
  side; `--signal` `#45c8d6` is cool — the machine/pipeline side; `--ink*` is the surface ramp;
  `--disp`/`--prose`/`--mono` are display/prose/machine-data type. That split already encodes
  "who made this", so **don't add new accent hues** — spend these two.
- **Pure logic goes in `.ts` with a `tests/` sibling; `.tsx` stays thin rendering.** Jest's
  desktop project is `**/apps/desktop/**/tests/*.test.ts` — `.ts` only, node environment, no
  jsdom. Layout math, hit-testing, and derivation are exactly what you want under test and
  exactly what jsdom can't help with; components are not tested. Same impure-shell/pure-core
  split as `@vn/debug2d`, for the same reason. No jsdom, no React Testing Library.
- **The FLOOR inspector renders the P7 refine loop**, since `shot_image` folds
  generate → critique → refine into one runner and the task board would otherwise show one node
  that made four image calls for no visible reason. `AttemptLoop.tsx` stacks the attempts with
  the `Corrections:` clause that caused each next one in the gap between them; `attempts.ts` is
  the pure half. Two contracts: `blocking` is computed exactly as `mergeReports`
  (`@vn/providers`) computes it, so the UI can't disagree with the verdict the runner acted on;
  and every attempt's bytes are in the store (`store.write` runs per attempt, `store.accept`
  only on the clean one), so rejected frames are viewable over `vnasset://`. Plan and its
  as-shipped notes: [`plans/refine-loop-inspector.md`](plans/refine-loop-inspector.md).
- **`prototype.html`** (at `apps/desktop/prototype.html`) is the original design reference and
  shares class names with the stylesheet. It is neither built nor imported — leave it alone,
  and don't treat it as the source of truth for tokens; `tokens.css` is.

## Graph canvas and the branch editor (STUDIO)

`renderer/graph/` is the shared, domain-free canvas: `layout.ts` (layered DAG layout),
`edges.ts` (routes + the polyline every hit test uses), `hit.ts` (`pick`), `viewport.ts`
(pan/zoom), and `Canvas.tsx`, the only impure file. The branch editor is its first consumer;
the [task DAG view](#task-dag-view-floor) is the second, and it reuses the layer unchanged.
Plan: [`plans/story-branch-editor.md`](plans/story-branch-editor.md).

- **One geometry, drawn and hit-tested.** `routeEdges` emits the SVG path and its sampled
  polyline together, so an edge can't be clickable where it isn't drawn. Slop is authored in
  **screen** pixels and divided by the scale before it meets world geometry — `pick` does that
  conversion itself so callers can't do it backwards.
- **Two co-transformed layers**: an SVG one for wires, an HTML one for cards and labels (typeset
  material, and SVG text has no wrapping). They carry the same viewport, via `transformOf` for
  SVG and **`cssTransformOf` for HTML** — the two syntaxes are not interchangeable, and CSS
  drops a transform it can't parse _silently_. The node layer is `pointer-events: none`; an
  element that needs a real DOM target (an inline label editor) opts itself back in.
- **No manual node positions, so every drag is semantic.** `Scene` has no `x`/`y` and layout is
  automatic: dragging a card's handle to another card wires it (`story.setChoice`/`setNext`),
  dropping a card on a wire splices it in (`story.spliceScene`), pulling a wire's arrowhead off
  its target unwires it. Each commits **one** command on release — a drag is continuous, its
  commit is discrete.
- **The refusal shown mid-drag is the refusal that would happen.** `src/shared/interactions.ts`
  asks the same `branchops.ts` the command runs, so while a card is carried every wire is marked
  accept/refuse with the reason the command would have given — and `interaction.targets` answers
  an agent with that same verdict list.
- **`grab.ts` resolves the handle and the arrowhead before `pick` does.** Both discs straddle a
  card boundary, where `pick` answers "background" or "that card" — testing them first is what
  makes them the size they look.
- **Relayout is animated (`tween.ts`)** because a splice re-ranks the graph: the card does not
  stay where it was dropped, and without the transition that reads as breakage.
- **Which scenes exist is decided here** (`compose.ts`): a scene made from nothing, and a scene
  removed. A new scene lands deliberately *unwired* — the canvas is where you then wire it — and it
  has a second home in the script column ("a scene after this one", which wires it too). Delete has
  only this one home: offering it from inside the prose of the scene being deleted is an invitation
  to lose work. Both are confirmed against `stack.check` on hover, so the refusal (`arrival is the
  entry scene — point start: in project.yaml elsewhere first.`) arrives before the click.

## Script column (STUDIO)

STUDIO's third mode, `script` (`view.mode(room=studio mode=script)`): one scene's lines down the
column, typed. It shares the scene selection with `branches` — the two are views of one scene, so
picking a card and switching mode lands on it, and `Studio.tsx` owns the selection for that reason.
Plan and as-shipped notes:
[`plans/script-composition-in-studio.md`](plans/script-composition-in-studio.md).

- **The model is a list of lines, not a buffer.** There is no document being diffed on save: a
  keystroke either belongs to the open row's textarea or names one command, and `script.ts` is the
  pure function that decides which. Enter commits the row (and, from the end of a line, opens a
  composer below — a paragraph is one `setLineText` plus one `insertLine` per line, each its own
  undo point); Backspace at the start of an *emptied* line is `story.deleteLine`; Escape discards.
- **A composer row is not a line yet.** `story.insertLine` refuses empty text — an empty line has
  no lossless Fountain form — so Enter cannot create a line and let the author type into it.
  Committing the composer *is* the insert, and the id it minted is found by position in the
  reloaded scene (`insertedAfter`), never read back out of a message.
- **Attribution is a cue, not an id.** The cue picker writes `AIKO`, because a prose edit is decided
  against the scene as its file parses, where speakers are still cues — writing the resolved id back
  would rewrite `AIKO` as `@aiko`. The cast offered is the *project's*, since attributing a line is
  how a character enters a scene; an unresolved cue is offered verbatim so picking cannot silently
  discard one typed by hand.
- **Split, merge and new-scene are confirmed, not committed on click.** Each moves lines across a
  scene boundary or creates a file, and only the command can state the cost — so the strip holds the
  invocation, shows `stack.check`'s sentence (the detachment count a split would cause, the refusal a
  merge would give), and commits on a second gesture. The editable fields in the strip are the
  invocation's props. A new scene is **two** commands (`newScene` then `setNext`), because undoing
  the wire should not also delete the prose.
- **Affordances are the rules, not guesses at them.** A split is offered at every line but the
  first, since `splitScene` refuses a split that would empty the head; merge is offered only where
  the scene's single `next` is the boundary at the bottom of the column; "continue to a new scene"
  only from a leaf, because putting a scene *between* two others is the branch editor's splice.
  A line drag is judged per frame against `script.moveLine.targets` over a one-scene `ScriptState`
  built from the coverage — the same rule the command runs, so the mid-drag verdict is the verdict.
- **The rail's diagnostics are a way in.** A diagnostic whose `where` names a scene the workspace
  lists renders as a button that opens that scene in this column; `diagnostics.ts` decides which
  ones qualify, because `where` is an *entity* id and can name a scene that does not exist. Both
  editors call the shell's `onEdit` after a write so the group is current — deliberately an index
  re-read rather than a `revision` bump, which would remount the room mid-gesture.

## Task DAG view (FLOOR)

FLOOR's first two modes are `list` | `graph` (a segmented control in the floorbar,
`view.mode(room=floor mode=graph)`), sharing one selection and one `Inspector` — the flat list
is better for scanning, the graph for structure. Both are read-only: the only mutations from
these two are `pipeline.run` and `gate.approve`. `taskGraph.ts` is the pure derivation,
`TaskGraphView.tsx` the thin surface over `renderer/graph/`. Plan and as-shipped notes:
[`plans/task-dag-view.md`](plans/task-dag-view.md).

The view exists because a literal rendering of `Task.deps` would be dishonest in three ways,
and each fix is a pure function tested in node:

- **The gate is not an edge.** P3 approval is a planner predicate (`sceneUnblocked`), so a
  halted run has nothing ready and no edge saying why. `barrierFor` synthesizes a barrier node
  and `taskGraphOf` positions it with **ranking-only edges** — handed to `layoutGraph` but not
  to `routeEdges`, so the rank is real and the wires are never drawn. It renders as a dashed
  rule marked `derived`, carrying one `RESOLVE →` per pending character.
- **`deps` understates coupling.** A `shot_image`'s deps hold only its location plate; the
  subject portraits arrive through `inputs.refs`. `buildRefEdges` matches an `AssetRef.hash`
  back to the task whose `output` equals it — **deps solid, ref edges dashed**. A ref no task
  produced (an author-supplied image) is not an edge.
- **The graph is deliberately partial.** Planning is incremental, so shot tasks don't exist
  until their plate is `done`; an empty region means "not yet plannable", not "nothing to do".
  `ghostsFor` reads the story graph (not the task list — those two states look identical from
  the tasks alone) and ghosts each scene's expected work at `decomposeScene`'s deterministic
  baseline. Ghosts are **clusters, never addressable**: `onPick` acts on real tasks only, so
  the UI can't offer an estimate as a fact.

## Coverage timeline (FLOOR)

FLOOR's third mode, `timeline` (`view.mode(room=floor mode=timeline)`): a scene's screenplay
down the page with the shots covering it bracketed beside it. It runs **vertically** because
screenplays do, and it takes the full width — the task inspector is about other material, so
`.floor-body.wide` drops it. This is the only surface that edits `Shot.coversLines` directly — the
`story.*` scene editors also move it, as fallout of a split or merge rather than as the point — and
`buildShotPrompt` ignores it, so every edit here is free: nothing rehashes and no art is
invalidated. That is also true of the **prose** it edits, and there it is the problem rather than the
feature — hence the drift marking below. Plans and as-shipped notes:
[`plans/shot-timeline-editor.md`](plans/shot-timeline-editor.md) and
[`plans/line-editing-in-floor.md`](plans/line-editing-in-floor.md).

- **One rule, previewed and committed.** `src/shared/coverage.ts` holds the whole gesture's
  logic — `setCoverage` (the rule), `spansFor` (the geometry) and `resolveDrag` (which lines a
  drop asks for) — run by the `story.setCoverage` command in main _and_ by the strip mid-drag,
  so a refusal shown while a handle is carried is the refusal that would happen. Only `previewOf`
  stays in the renderer: it is ghost geometry for drawing, and main has no use for it. One
  command per drop; a drag is continuous, its commit is not.
- **The gesture is declared, not just implemented.** `timeline.cover` (in
  `src/shared/interactions.ts`) is the second interaction: it carries `<shotId>#start` /
  `<shotId>#end` and judges **every** row of the scene, so an agent can ask what a drag would do
  without performing one. `Timeline.tsx` evaluates `targets` **once per grab** — state and
  carried are both fixed for the gesture — and indexes the verdicts by line id for its notice
  and its commit; it still calls `resolveDrag` per pointer move for the ghost's _geometry_,
  which a verdict does not carry. A row the drop would not change is dropped from the list
  rather than reported: "nothing happens" is what release already does silently.
- **A drag previews; it never re-lanes.** Lanes are greedy first-fit over shot _extents_, so
  re-deriving coverage per pointer move moves brackets the author never touched into other
  columns and changes the grid's column count under the cursor. The strip therefore draws
  committed coverage for the whole gesture and `previewOf` draws the proposal over it — ghost
  brackets in the dragged shot's **existing** lane, plus a tint on the rows it would claim and
  release. Same rule as the branch editor's animated relayout: layout changes on commit, not
  during the gesture. It also keeps the grabbed handle under the pointer.
- **Claiming a line takes it from whatever held it.** The exporter shows the _first_ shot
  covering a line, so double coverage silently hides the second shot's frame. Released lines
  become **gaps** — a vermilion gutter — rather than being handed to a neighbour: an uncovered
  line renders with no image, and revealing that is the point of the surface. But a claim that
  would leave another shot covering **nothing** is refused, because releasing does not give
  lines back: a drag that swept across a neighbour and returned would destroy it, and the return
  trip could not undo it. Revealing a shot that covers nothing is this surface's job;
  manufacturing one is not. The dragged shot may still empty itself via the command DSL — only
  the side effect is refused.
- **Coverage is a set, never a range.** `timeline/coverage.ts` splits a shot into contiguous
  _segments_ and lanes shots by extent, so the decomposer's interleaving (plate takes the
  narration, each medium one speaker) draws as separate columns instead of nested brackets.
  Only a shot's outermost handles drag; a shot covering nothing is listed under
  `COVERS NOTHING` instead of being drawn.
- **Rows are grid rows, so wrapped prose sizes itself.** The one thing measured is which row
  the pointer is over: a full-width `.tl-band` behind each row, reached by `elementFromPoint`
  once `.tl-grid.dragging` drops pointer events on the script and the brackets.
- **Clicking a line's text retypes it, one `story.setLineText` per commit.** The editor is a
  textarea in the row it replaces, auto-growing via a one-cell grid whose invisible `::after` sizer
  carries the same string — nothing is measured, so no frame exists where the layout disagrees with
  the caret, and the brackets follow because they are placed by grid row. Enter commits and Escape
  discards, and both **act** rather than calling `blur()`, which does nothing on an element that is
  not the active element; blur is the click-away path only. A draft that matches the line is not an
  authorial act and produces no record. Typing over a covered line reports what it will cost
  *before* the commit, debounced from the command's own `check` (`story.setLineText` reports
  `retyped: []` for an unchanged text, so there is nothing to say until there is a change to price),
  and a refused commit reopens the editor with the draft beside the reason. Editing and coverage
  dragging are two modes over one grid: a handle's `pointerdown` is prevented and so cannot blur an
  open editor, which means the **grab is refused with a sentence** rather than the half-typed line
  being committed under the gesture. `timeline/editing.ts` is the pure half of the two-mode rule;
  retyping itself is `src/shared/lineedit.ts` — the draft-to-`Invocation` rule and the `Notice` a
  command speaks through, both a `check` asked while typing and a `Verdict` judged mid-drag — shared
  with STUDIO's script column so the two surfaces cannot disagree about either.
- **An undecomposed scene renders its script.** Correcting a line is exactly what an author wants to
  do *before* paying for art, so a scene with no `work/shots/<id>.json` draws the script column with
  no bracket columns and a note saying where the shots come from — not a refusal. Both the vermilion
  gap gutter and the uncovered count wait for a decomposition: before one exists every line is
  uncovered, which is a pre-run state and not a defect.
- **A frame that illustrates old prose is marked, not re-run.** Drift is derived in main
  (`driftOf`, surfaced as `CoverageShot.drift` — see
  [`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines)) and rendered as a state on
  the bracket: dashed sodium with `OLD PROSE` in the mono head, distinct from the vermilion
  `COVERS NOTHING`, which is a different problem with a different fix. Sodium because the authored
  side is what moved; on the head rather than over the image because that frame is still what the
  runner will show. A shot rendered before the hash existed reads a dim `PROSE?` — quiet, because the
  author cannot act on it and it clears itself at the next render, which is also why the bar counts
  only the drifted ones (`… · 1 on old prose`). Acting on drift is `pipeline.run`'s job and the
  author's; this surface only tells the truth about it.

## The runner (PLAY)

The third room is the runner, in `renderer/rooms/play/Runner.tsx`:

- **Live, no file needed.** The renderer calls the `story:play` IPC channel; the main process
  builds the playable in-process from the loaded model + store (`session.playable()`).
- **Image delivery — `vnasset://`.** A privileged custom protocol (registered in
  `src/main/index.ts`) streams `build/assets/<hash>.<ext>` for `vnasset://<hash>.<ext>`, so
  `<img src="vnasset://…">` loads content-addressed bytes. This is the app's only image path.
- **Playthrough.** State is a navigation stack (`{ sceneId, frameIndex }[]`, last = current):
  click / Space / → advances a beat; at scene end it shows choice buttons or auto-follows
  `next`; a leaf scene shows "The End". **Back** (← / Backspace) rewinds. **Save / Load /
  Reset** persist the stack to `localStorage`, keyed by workspace title.

## Remembered UI state (`.vndesktop/session.json`)

Panel widths (and anything else the shell should remember) live in a flat key/value file the
main process owns — `apps/desktop/src/main/sessionstore.ts`, gitignored, **global per install**
rather than per workspace. `VN_DESKTOP_HOME` relocates it; the default is one line away from
`~/.vndesktop` once the app is installed rather than run from the repo.

- **Multi-instance by construction.** Nothing stops two app instances sharing the file, so a
  flush takes a `mkdir` lock (stale ones, >5s, are broken), re-reads the file _inside_ the lock,
  and applies **only its dirty keys** over what it finds. Different keys from different
  instances both survive; the same key is last-flush-wins.
- **Synchronous first read.** The preload does one `sendSync('session:snapshot:sync')` and
  `useSessionValue` seeds `useState` from it, so a saved width is the first thing painted rather
  than a jump away from the default.
- **One hook, both orientations.** `usePanelWidth(saveId, { defaultWidth, min, max, edge })`
  (`renderer/ui/Resizable.tsx`) stores under `panel.<saveId>.width`, hands back a `--panel-w`
  `trackStyle` for the grid container and a `<ResizeHandle>`'s props. The STUDIO rail
  (`edge: 'left'`) and the FLOOR inspector (`edge: 'right'`) use it unchanged. A drag keeps the
  width local and persists once on release; `view.panelSize` is the scriptable path.

## Seeded workspace (`examples/mySampleRepo`)

With no `VN_PROJECT`, the app opens **`examples/mySampleRepo`** and seeds it from
`examples/sample` on first launch (`apps/desktop/src/main/workspace.ts`). It is resolved once
in `app.whenReady()`, before the asset protocol or any session exists.

- **Why**: a real run writes ~100 MB into `vngen/`, and doing that in the source tree buries
  `git status` and erases the line between the sample we ship and the copy you've been messing
  with. `examples/mySampleRepo` is **gitignored**, so its own git repo is invisible to the
  parent — no submodule, no `gitlink`, no `--recursive` clone.
- **Seeding copies inputs only** — everything in the template except `vngen/` (a fresh
  workspace has not been run) and `keys/` (secrets) — then `git init`s and commits them as
  `Sample project inputs`. A local `user.*` is set only when git can't already answer who the
  committer is; `core.autocrlf false` is always set, since the branch editor patches scene
  prose byte-exactly.
- **An existing directory is opened untouched.** Never re-copied, never overwritten: it is the
  user's working copy. Resetting it is `rm -rf examples/mySampleRepo`, which needs no code and
  cannot misfire. A copy seeded before the template became one file per scene therefore still
  holds the `screenplay/` form, which no longer loads: run `workspace.import` on it, or delete
  the directory to get the current template.
- Packaged builds have no repo-relative `examples/`, so the scratch workspace falls back to
  `app.getPath('userData')/mySampleRepo`; a missing template then fails by name.

# The desktop app

`apps/desktop` is an Electron app whose renderer is a **path.ux screen mesh**: a window
subdivides into panes, and each pane shows one **editor** over one `WorkspaceSession`. There are
no rooms and no modes-within-rooms — the author splits the window and puts the editors they want
side by side. Every action the app can take is a registered command
([`command-system.md`](command-system.md)); what it persists and where is
[`desktopAppState.md`](desktopAppState.md); what it plays is
[`playable-format.md`](playable-format.md). The rewrite that got here, step by step and with its
traps written down, is [`plans/pathux-desktop-rewrite.md`](plans/pathux-desktop-rewrite.md).

<!-- toc -->

- [Running it](#running-it)
- [Renderer layout](#renderer-layout)
- [The shell](#the-shell)
  * [Surfaces, shadow roots and stylesheets](#surfaces-shadow-roots-and-stylesheets)
- [The shared graph canvas](#the-shared-graph-canvas)
- [Branches](#branches)
- [Script](#script)
- [Convo](#convo)
- [Coverage](#coverage)
- [Tasks, Task Graph and Inspector](#tasks-task-graph-and-inspector)
- [Play](#play)
- [Remembered UI state (`.vndesktop/session.json`)](#remembered-ui-state-vndesktopsessionjson)
- [Which project is open](#which-project-is-open)
- [Seeded workspace (`examples/mySampleRepo`)](#seeded-workspace-examplesmysamplerepo)
- [The retired React shell (`--react`)](#the-retired-react-shell---react)

<!-- tocstop -->

## Running it

```sh
pnpm --filter @vn/desktop build && pnpm --filter @vn/desktop start -- --mock   # runs for real by default; --mock skips model calls
pnpm --filter @vn/desktop dev -- --mock                                       # live dev loop
```

`--project <dir>` overrides the workspace (`VN_PROJECT=<dir>` is an equivalent env fallback).
`--react` boots the retired React room shell instead (see [the retired shell](#the-retired-react-shell---react)).

**Live dev loop:** `pnpm --filter @vn/desktop dev` (`scripts/dev.desktop.mjs`) runs the three
moving parts together — esbuild `--watch` (main + preload), the Vite renderer server with HMR,
and Electron launched against it once it's up (`VITE_DEV_SERVER_URL`, which
`src/main/index.ts` loads instead of the built file). Quitting the window (or Ctrl-C) tears the
whole tree down. `VN_DEV_PORT` overrides the renderer port (default 5176); any args after the
script's own (e.g. `--mock`, `--project <dir>`) are forwarded to Electron, and `VN_MOCK`/
`VN_PROJECT` still pass through as env fallbacks. Main-process edits need a restart (the
renderer hot-reloads on its own). The dev loop also defaults `VN_CDP_PORT=9222` — see
[`command-system.md`](command-system.md).

**path.ux is a git submodule** at `vendor/path.ux` and carries a nested one of its own, so a
fresh clone needs `git submodule update --init --recursive`. `pnpm doctor`
(`scripts/check-submodules.mjs`, also the first step of `@vn/desktop`'s `build`) fails by name
rather than letting the resolver complain. Vite compiles path.ux's TypeScript source through an
alias — there is no prebuilt bundle to keep in sync — while `tsgo` checks us against
declarations regenerated from that same source on every `check` (`build:pathux-types` →
`apps/desktop/dist/pathux-types`, gitignored). `vendor/**` is excluded from prettier and eslint:
formatting the submodule under our config shows its gitlink dirty.

## Renderer layout

`renderer/pathux/` is the shell and its editors; `renderer/graph/` is the shared canvas geometry;
`renderer/rooms/` is the retired React shell **and** the pure rule modules the new editors still
import. That last point is the one to hold on to: the ports rewrote markup and gesture glue only,
so `script.ts`, `coverage.ts`, `taskGraph.ts`, `attempts.ts`, `grab.ts` and their kin are
unchanged under `rooms/` with their tests beside them. Deleting the React shell means **moving**
those modules, not deleting them.

```
renderer/
  main.tsx              entry; picks a shell (`?react`), imports styles/index.css, installs @vn/debug2d in DEV
  api.ts                typed access to main; falls back to mock data outside Electron
  session.ts            `useSessionValue` — React-only; retires with the room shell
  global.d.ts           ambient declarations for what the preload injects
  debug/install.ts      dev-only @vn/debug2d glue; vite build drops it entirely
  pathux/               shell.ts (boot) · screen.ts · context.ts · state.ts · api.ts (DataAPI)
                        theme.ts · tokens.ts · keymap.ts · palette.ts · bridge.ts · persist.ts
                        editor.ts (VnEditor + registerEditor) · view.ts · panes.ts (pure)
                        dom.ts (raw-DOM vocabulary) · selection.ts · agent.ts
                        branch.ts · script.ts · timeline.ts · convo.ts (pure gesture/state cores)
                        graph/canvas.ts · play/playback.ts
       …/editors/       header · branch · script · convo · timeline · tasks · graph · inspector · play
  graph/                layout · edges · hit · viewport · types (pure) + Canvas.tsx (React-only)
  rooms/                the retired React shell — and the pure cores the editors above import:
       …/studio/        branch/{graph,grab,compose,tween}.ts · script/script.ts · diagnostics.ts
       …/floor/         taskGraph.ts · attempts.ts · timeline/{coverage,drift,editing,wardrobe}.ts
       …/rooms.ts       Room/StudioMode/FloorMode — local to the retired shell, and go with it
  ui/                   Resizable.tsx — React-only; the flat `panel.*.width` keys retire with it
  styles/               index.css @imports tokens · shell · studio · floor · play · graph ·
                        branch · taskgraph · timeline · script
```

- **Pure logic goes in `.ts` with a `tests/` sibling; the editor stays thin rendering.** Jest's
  desktop project is `**/apps/desktop/**/tests/*.test.ts` — `.ts` only, node environment, no
  jsdom. Layout math, hit-testing, gesture state machines and derivation are exactly what you
  want under test and exactly what jsdom can't help with; the editors themselves are not tested,
  they are verified live over CDP. Same impure-shell/pure-core split as `@vn/debug2d`, for the
  same reason. Each port that found untested logic inside a `.tsx` extracted it: `pathux/branch.ts`,
  `pathux/script.ts`, `pathux/timeline.ts`, `pathux/convo.ts`, `pathux/panes.ts` and
  `play/playback.ts` are all new pure modules with tests the React versions never had.
- **`tokens.css` is the design contract**: `--sodium` `#f4a24c` is warm — the authored/human
  side; `--signal` `#45c8d6` is cool — the machine/pipeline side; `--ink*` is the surface ramp;
  `--disp`/`--prose`/`--mono` are display/prose/machine-data type. That split already encodes
  "who made this", so **don't add new accent hues** — spend these two. `pathux/tokens.ts` restates
  the same values for code that has no stylesheet behind it, and `theme.ts` feeds them to path.ux's
  own theme so widgets and surfaces agree.
- **`styles/index.css` import order IS cascade order.** It reproduces the top-to-bottom order
  of the single sheet this was split from, so a narrowing `@media` block still overrides the base
  rule. Add a new sheet at the **end**, not the middle. It is loaded at document level for both
  shells: custom properties are the one thing that crosses a shadow boundary, so it is what an
  editor's `var(--…)` reads resolve against. Rules that must apply *inside* a pane are adopted by
  the editor (see [`adoptStyle`](#surfaces-shadow-roots-and-stylesheets)).
- **`prototype.html`** (at `apps/desktop/prototype.html`) is the original design reference and
  shares class names with the stylesheet. It is neither built nor imported — leave it alone,
  and don't treat it as the source of truth for tokens; `tokens.css` is.

## The shell

`pathux/shell.ts` boots it, in this order: theme, icons, `nstructjs.validateStructs()`, the
editor-name check, then `Shell.start()` — restore the selection, restore the layout (or build the
default screen), put the header back, solve and paint, then install the keymap, the bridge, the
agent subscription and persistence.

- **A pane shows an editor, and the list of editors is written down once.**
  `apps/desktop/src/shared/editors.ts` holds all eight (`branches`, `script`, `convo`, `timeline`,
  `tasklist`, `taskgraph`, `inspector`, `play`) with their titles. It is in `src/shared/` because
  `view.*` runs in **main** like every other command and builds its props from that list, while the
  renderer registers each editor class under the matching area name; `checkEditorNames()` warns at
  boot if the two ever disagree. The header bar is deliberately absent from the list — it is chrome,
  not somewhere the author navigates to.
- **Navigation is `view.*`, and the mesh corrects it.** `view.open(editor, where)` shows an editor
  in the active pane or in a new pane split off it (`here` | `right` | `below`); asking for one
  already open `here` is a focus, not a second copy. `view.focus`, `view.close` (collapse into a
  neighbour; the last pane is kept) and `view.layout` (throw the arrangement away) complete the set.
  Main answers optimistically because only the renderer knows how many panes there are, so
  `pathux/view.ts` returns a **correction** sentence the bridge says instead — "No pane is showing
  Script." The pure half of that decision is `panes.ts` (which pane to use, which to close, which is
  showing what), tested in node.
- **The header is a screen area, not a bar above the screen** — the same choice path.ux's own
  `MenuBarEditor` makes, so the mesh owns its geometry and the header survives the layout
  round-trip like everything else. It is 34px, locked at both ends, and `ensureHeader` puts it back
  on **every** boot (a stored layout may predate it), squeezing what was there into the space below
  in proportion. It holds the app menu, the View menu (every editor by name, each entry a
  `view.open`, plus Close Pane and Reset Layout), the project badge, undo/redo with the labels
  `command:undo` pushes, an error-or-warning count, the model, `live`/`preview`, and the
  PLAN ⇄ EXECUTE toggle. It rebuilds when — and only when — the string of everything it draws
  changes.
- **`bridge.ts` is the one seam to main.** Every fact the shell shows is pushed in from
  `workspace:index`, the agent event stream and `command:ui`; every act leaves as
  `command:exec`, so provenance, undo and history are identical whether the header, the palette, an
  editor or the agent ran it. `say()` puts a sentence in the screen's note frame — every editor gets
  one, because `VnEditor` builds its header with a note area. `onExec` lets a surface follow the
  *command* rather than the button on it (which is how `agent.clear` empties the transcript from
  either place).
- **One selection, in `ShellState`.** `ui.sceneId` / `ui.shotId` / `ui.characterId` are the shared
  authored selection every editor observes and any editor may publish — the three independent
  `useState` selections of the room shell are gone. `ui.taskHash` is a fourth, machine identity
  rather than authored, which is why it is **not** persisted: a content hash re-keys whenever a
  prompt changes, so one remembered across a re-plan names nothing. `ShellState` is the root of the
  path.ux DataAPI and the only thing a widget may bind to directly — document state never lands
  here, because `@vn/commands` is the write path.
- **Keyboard is per-area first.** path.ux routes a keystroke to the focused area's keymaps and
  falls through to the screen's, so the shell claims only `/` (palette), Ctrl+Z / Ctrl+Shift+Z /
  Ctrl+Y and Shift+Tab. Escape is nobody's: a popup installs its own while it is up. An editor that
  wants a key for itself simply takes it, which the room shell's single window-level `keydown`
  could not allow — and an editor with an **open text row stops its own keydown**, or `/` opens the
  palette in the middle of a sentence.
- **The palette is a screen popup over the live registry.** `app/catalog.ts` — matching, blank
  values, field coercion — is imported unchanged by both shells, because two palettes disagreeing
  about which command a query names would be a bug in both. `openPalette(id, props)` is also how
  surfaces hand off a command that needs confirmation (`pipeline.run`, `gate.approve`).
- **Every editor registers through `registerEditor(cls, 'vn.Name')`.** nstructjs defaults a
  struct's name to `cls.name`, which esbuild minifies, and `ScreenArea.loadSTRUCT` answers an
  unknown struct name — or an unknown **area** name — by silently falling back to the first
  registered area class, so every remembered pane comes back as the same editor. `registerEditor`
  does both halves of registration under a written-down name, and `restoreLayout` discards a
  layout naming an editor this build has not got rather than mis-restoring it.

### Surfaces, shadow roots and stylesheets

`VnEditor` is a `ColumnFrame` inside the area's shadow root with path.ux's header above it. Two
protected methods are the whole contract for raw DOM inside a pane, and both exist because of bugs
that pass every DOM query:

- **`appendSurface(el)` is the only way to mount a surface.** `Container.appendChild` routes a
  `UIBase` into the shadow root but hands anything else to `super.appendChild`, which lands it in
  the **light** DOM — where a path.ux widget has no `<slot>`. The node is then present, findable and
  clickable from script, and never laid out or drawn: `getBoundingClientRect()` reads 0×0.
- **`adoptStyle(css)` gives a surface its own sheet** inside that shadow root. Document rules do not
  cross the boundary (only custom properties inherit), and `:hover`, `::after` and `:has()` have no
  inline form at all — the coverage strip's auto-growing editor is a pseudo-element and its handles
  are hover states. The room stylesheets are imported `?inline` rather than copied, so both shells
  share one sheet for as long as both exist.

## The shared graph canvas

Two editors draw a graph, and they share both the geometry and the surface. `renderer/graph/` is
the domain-free math — `layout.ts` (layered DAG layout), `edges.ts` (routes plus the polyline every
hit test uses), `hit.ts` (`pick`), `viewport.ts` (pan/zoom) — all pure, all tested.
`pathux/graph/canvas.ts` is the imperative surface over it. Plan:
[`plans/story-branch-editor.md`](plans/story-branch-editor.md).

- **One geometry, drawn and hit-tested.** `routeEdges` emits the SVG path and its sampled
  polyline together, so an edge can't be clickable where it isn't drawn. Slop is authored in
  **screen** pixels and divided by the scale before it meets world geometry — `pick` does that
  conversion itself so callers can't do it backwards.
- **Two co-transformed layers**: an SVG one for wires, an HTML one for cards and labels (typeset
  material, and SVG text has no wrapping). They carry the same viewport, via `transformOf` for
  SVG and **`cssTransformOf` for HTML** — the two syntaxes are not interchangeable, and CSS
  drops a transform it can't parse _silently_. The node layer is `pointer-events: none`; an
  element that needs a real DOM target (an inline label editor) opts itself back in.
- **A claimed gesture calls `preventDefault()`** — the canvas's protocol for "this pointer is
  spoken for". Without it the canvas pans underneath an unwire drag, the one gesture that starts
  over empty background. The React overlay ate the event and never had to say so.
- **One persistent overlay host**, handed to `setOverlay` once and mutated in place, so a pointer
  move repaints the verdict paths, the ghost wire and the carried card without rebuilding content.

## Branches

`editors/branch.ts` — the story graph as index cards, on the canvas above.
`rooms/studio/branch/{graph,grab,compose,tween}.ts` are imported unchanged; the gesture state
machine that lived inside `BranchEditor.tsx` and was never tested is now `pathux/branch.ts` with
sixteen tests over the three drags.

- **No manual node positions, so every drag is semantic.** `Scene` has no `x`/`y` and layout is
  automatic: dragging a card's handle to another card wires it (`story.setChoice`/`setNext`),
  dropping a card on a wire splices it in (`story.spliceScene`), pulling a wire's arrowhead off
  its target unwires it. Each commits **one** command on release — a drag is continuous, its
  commit is discrete.
- **The gesture is judged once, at the grab.** `grabCard`/`grabHandle`/`grabArrow` capture every
  candidate's verdict from the same `branchConnect`/`branchSplice`/`branchUnwire` an agent would
  ask (`src/shared/interactions.ts` over `branchops.ts`), and `aim` is the one entry a pointer move
  needs — including the promotion from press to splice past `SLOP`, which re-aims in the same move
  so a big jump lands on the wire it ended over. The refusal shown mid-drag is the refusal that
  would happen.
- **`grab.ts` resolves the handle and the arrowhead before `pick` does.** Both discs straddle a
  card boundary, where `pick` answers "background" or "that card" — testing them first is what
  makes them the size they look.
- **Relayout is animated (`tween.ts`)** because a splice re-ranks the graph: the card does not
  stay where it was dropped, and without the transition that reads as breakage.
- **The edge label opens on `pointerdown`, not `click`.** Raw DOM has no reconciliation: a redraw
  between mousedown and mouseup destroys the button and the click never lands. The open `<input>`
  is held across redraws and re-`focus()`ed after each draw — the relayout tween runs `setContent`
  per frame — and the `blur` that re-parenting raises is ignored, or the field would commit itself
  away on the next frame.
- **Which scenes exist is decided here** (`compose.ts`): a scene made from nothing, and a scene
  removed. A new scene lands deliberately *unwired* — this is where you then wire it — and it has a
  second home in the script editor ("a scene after this one", which wires it too). Delete has only
  this one home: offering it from inside the prose of the scene being deleted is an invitation to
  lose work. Both are confirmed against `stack.check` on hover, so the refusal (`arrival is the
  entry scene — point start: in project.yaml elsewhere first.`) arrives before the click.
- **The selected scene is the shell's.** A card clicked here sets `ui.sceneId`, so the script and
  coverage panes follow, and it seeds the conversation composer with `Revise scene <id> — ` even
  when the selection did not move: clicking the card that is already open is how you ask about it
  again.

## Script

`editors/script.ts` — one scene's lines down the pane, typed: the heading, the lines with their ids
and cues, the composer at the end. `rooms/studio/script/script.ts` (`scriptRows`, `keyAct`,
`stepsOf`, `checkOf`, `splitBoundaries`, `mergeTarget`, `dropTarget`, `nextEditing`) is imported
unchanged; the drag machine from `ScriptEditor.tsx` is now `pathux/script.ts` with six tests. Plan:
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
  the scene's single `next` is the boundary at the bottom of the pane; "continue to a new scene"
  only from a leaf, because putting a scene *between* two others is the branch editor's splice.
  A line drag is judged once at the grab against `scriptMoveLine.targets`, keyed by insertion point
  (`TOP` or the line to land after) — an insertion point `targets` never judged is a drop that would
  reorder nothing: no rule drawn, no sentence, no commit.
- **The redraw key excludes the draft and the pending act's props**, on purpose — path.ux calls
  `update()` every frame, so keying on what is being typed would rebuild the field under the caret
  once per frame and lose it. The open textarea and the split/merge strip's inputs are persistent
  nodes that mutate in place and only re-run `stack.check`.
- **Opening a row does not clear the notice.** The continuation an act opens carries on from that
  act, so what the command said about it is still the last thing that happened; only a row the
  *author* opens is a new act and clears it.
- **The scene is the shell's, not the editor's.** `ui.sceneId` changing from anywhere is a
  *reload*, not a redraw.

## Convo

`editors/convo.ts` — the vnauthor pane: the transcript, the plan card, the dialogue box and the
composer. The conversation itself is a **value**, `pathux/convo.ts`, reduced from the same
`AgentEvent` stream `useAgent` reduced untestably inside a `useEffect`, with nine tests over what
each event does to it.

- **The live conversation is a module subscribed at boot** (`pathux/agent.ts`, installed by
  `shell.start()`), not editor state, because the agent streams whether or not a convo pane is open
  and a pane opened afterwards has to show what was already said — including a second convo pane
  onto the same transcript.
- **A turn is a command.** `ask` runs `agent.run` through the bridge rather than a bespoke channel,
  so a turn the author types and a turn the palette runs are one act with one record.
  `plan:decision` stays a channel on purpose: it is the reply to a request main is already blocked
  on, not an act of its own.
- **Clearing follows the command, not the button.** The store watches the registry through
  `bridge.onExec`, so `agent.clear` from the pane and from the palette empty the transcript
  identically. Named gap: `window.vn`/CDP goes straight to main and `agent.clear` emits no event, so
  a clear run that way leaves an open pane's transcript standing.
- **The composer is built once and never rebuilt.** It is what the author is typing into and where a
  seed lands, so it outlives every redraw of the transcript above it — and it stops its own keydown.
- **This pane unnests.** In the room shell the branch and script editors were rendered *inside*
  `Convo`, which is why only one of them could be open. Here the conversation is a pane like any
  other and the author decides whether it shares the window with the page it is about.
- **`busy` is shell-wide, not agent-only**: a pipeline run disables the composer too.

## Coverage

`editors/timeline.ts` — a scene's screenplay down the pane with the shots covering it bracketed
beside it, and the wardrobe under it. It runs **vertically** because screenplays do.
`rooms/floor/timeline/{coverage,drift,editing,wardrobe}.ts` are imported unchanged; the state
machine the React component kept in its own `.tsx` is now `pathux/timeline.ts` with twelve tests.
Plans: [`plans/shot-timeline-editor.md`](plans/shot-timeline-editor.md) and
[`plans/line-editing-in-floor.md`](plans/line-editing-in-floor.md).

This is the only surface that edits `Shot.coversLines` directly — the `story.*` scene editors also
move it, as fallout of a split or merge rather than as the point — and `buildShotPrompt` ignores it,
so every edit here is free: nothing rehashes and no art is invalidated. That is also true of the
**prose** it edits, and there it is the problem rather than the feature — hence the drift marking
below.

- **One rule, previewed and committed.** `src/shared/coverage.ts` holds the whole gesture's
  logic — `setCoverage` (the rule), `spansFor` (the geometry) and `resolveDrag` (which lines a
  drop asks for) — run by the `story.setCoverage` command in main _and_ by the strip mid-drag,
  so a refusal shown while a handle is carried is the refusal that would happen. Only `previewOf`
  stays in the renderer: it is ghost geometry for drawing, and main has no use for it. One
  command per drop.
- **The gesture is declared, not just implemented.** `timeline.cover` (in
  `src/shared/interactions.ts`) carries `<shotId>#start` / `<shotId>#end` and judges **every** row
  of the scene, so an agent can ask what a drag would do without performing one. The editor
  evaluates `targets` **once per grab** — state and carried are both fixed for the gesture — and
  indexes the verdicts by line id for its notice and its commit; it still calls `resolveDrag` per
  pointer move for the ghost's _geometry_, which a verdict does not carry. A row the drop would not
  change is dropped from the list rather than reported: "nothing happens" is what release already
  does silently.
- **A drag previews; it never re-lanes.** Lanes are greedy first-fit over shot _extents_, so
  re-deriving coverage per pointer move moves brackets the author never touched into other
  columns and changes the grid's column count under the cursor. The strip therefore draws
  committed coverage for the whole gesture and `previewOf` draws the proposal over it — ghost
  brackets in the dragged shot's **existing** lane, plus a tint on the rows it would claim and
  release. Same rule as the branch editor's animated relayout: layout changes on commit, not
  during the gesture. It also keeps the grabbed handle under the pointer. `update()` returns early
  while a gesture is live, because the row under the pointer is read from the DOM and rebuilding
  would replace the nodes the drag is aimed at; a selection the grab published lands on release.
- **Claiming a line takes it from whatever held it.** The exporter shows the _first_ shot
  covering a line, so double coverage silently hides the second shot's frame. Released lines
  become **gaps** — a vermilion gutter — rather than being handed to a neighbour: an uncovered
  line renders with no image, and revealing that is the point of the surface. But a claim that
  would leave another shot covering **nothing** is refused, because releasing does not give
  lines back: a drag that swept across a neighbour and returned would destroy it, and the return
  trip could not undo it. The dragged shot may still empty itself via the command DSL — only
  the side effect is refused.
- **Coverage is a set, never a range.** `timeline/coverage.ts` splits a shot into contiguous
  _segments_ and lanes shots by extent, so the decomposer's interleaving (plate takes the
  narration, each medium one speaker) draws as separate columns instead of nested brackets.
  Only a shot's outermost handles drag; a shot covering nothing is listed under
  `COVERS NOTHING` instead of being drawn.
- **A bracket's edges resize it; its body moves it.** The second gesture over the same brackets is
  `timeline.reorder` → `story.moveShot`: a shot's position _is_ where its covered lines sit, so
  reordering it moves those lines. The rule is `planShotMove` in `@vn/scriptedit`, over line ids and
  anything with a `coversLines` — which is why the strip can run the command's own rule against the
  `CoverageShot`s it already holds, with no `Scene` to fabricate. Targets are the _other shots_ plus
  `top`, aimed by the same midpoint rule the script editor's `dropTarget` uses, since N shots have N
  positions but only N−1 of them are named by another shot. A shot other shots draw inside is on
  screen in more than one place and has no single position, so it is refused by name. The drop is
  drawn as a rule at a row's edge rather than a ghost bracket: previewing the new position would
  mean moving the prose, and layout changes on commit.
- **A reorder is the one free scene edit, and says so.** No line id changes, so no coverage changes;
  every shot's covered lines keep their relative order, so no `proseHash` moves. Nothing drifts and
  nothing re-renders — only the order of `show` beats in the playable, which is the act the author
  asked for. Contrast `story.moveLine`, which moves a line _between_ shots and reports drift.
- **Rows are grid rows, so wrapped prose sizes itself.** The one thing measured is which row
  the pointer is over: a full-width `.tl-band` behind each row, reached by `elementFromPoint`
  once `.tl-grid.dragging` drops pointer events on the script and the brackets.
- **Clicking a line's text retypes it, one `story.setLineText` per commit.** The editor is a
  textarea in the row it replaces, auto-growing via a one-cell grid whose invisible `::after` sizer
  carries the same string — nothing is measured, so no frame exists where the layout disagrees with
  the caret, and the brackets follow because they are placed by grid row. Enter commits and Escape
  discards, and both **act** rather than calling `blur()`, which does nothing on an element that is
  not the active element. A draft that matches the line is not an authorial act and produces no
  record. Typing over a covered line reports what it will cost *before* the commit, debounced from
  the command's own `check`, and a refused commit reopens the editor with the draft beside the
  reason. Editing and coverage dragging are two modes over one grid: a handle's `pointerdown` is
  prevented and so cannot blur an open editor, which means the **grab is refused with a sentence**
  rather than the half-typed line being committed under the gesture. `timeline/editing.ts` is the
  pure half of the two-mode rule; retyping itself is `src/shared/lineedit.ts`, shared with the
  script editor so the two surfaces cannot disagree about either.
- **An undecomposed scene renders its script.** Correcting a line is exactly what an author wants to
  do *before* paying for art, so a scene with no `work/shots/<id>.json` draws the script column with
  no bracket columns and a note saying where the shots come from — not a refusal. Both the vermilion
  gap gutter and the uncovered count wait for a decomposition.
- **A frame that illustrates old prose is marked, not re-run.** Drift is derived in main
  (`driftOf`, surfaced as `CoverageShot.drift` — see
  [`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines)) and rendered as a state on
  the bracket: dashed sodium with `OLD PROSE` in the mono head, distinct from the vermilion
  `COVERS NOTHING`, which is a different problem with a different fix. Sodium because the authored
  side is what moved; on the head rather than over the image because that frame is still what the
  runner will show. A shot rendered before the hash existed reads a dim `PROSE?` — quiet, because the
  author cannot act on it and it clears itself at the next render. Acting on drift is
  `pipeline.run`'s job and the author's; this surface only tells the truth about it.
- **The wardrobe strip shows both levels at once, and every row names the level that answered.**
  Below the grid: a `WEARING` section with one row per cast member (the scene's `[[outfit:]]`
  marker) and, once a shot is selected, an `IN THIS SHOT` section with one row per subject. An
  author asking "why is she in the uniform" is asking about both at once, so no row ever says merely
  "inherited" — it says `"uniform" (character sheet)`, and the inherit option names what clearing
  would reveal. A select, not a drag: the choice is from a fixed set, and the set is the wardrobe the
  command would accept. Which rows exist and what each holds is `timeline/wardrobe.ts`, which calls
  `outfitFor` for both the value in force and the value a clear would reveal — the chain is never
  re-decided here, so the strip and the prompt cannot disagree. A shot decomposed before outfits
  were authorable carries an explicit outfit, so a marker cannot reach it; that is the one case the
  strip calls out (`hides the scene's "track" — clear it to let the marker through`).

## Tasks, Task Graph and Inspector

Three editors over the pipeline's state, linked by `ui.taskHash`: `editors/tasks.ts` (the flat
list), `editors/graph.ts` (the DAG, on the shared canvas) and `editors/inspector.ts` (one task in
detail). The list is better for scanning, the graph for structure; both are read-only, and the only
mutations from any of the three are `pipeline.run` and `gate.approve`. `rooms/floor/taskGraph.ts`
owns the derivation and `rooms/floor/attempts.ts` the review merge, both unchanged with their tests.
Plan: [`plans/task-dag-view.md`](plans/task-dag-view.md).

- **A task surface publishes `ui.taskHash`, and that is what the inspector watches.** The three
  authored ids answer "where in the story", which is not the same question as "which node" — a task
  naming neither scene nor character is still worth inspecting. The surfaces are linked by that
  hash rather than by either knowing the other exists, so a pick in the list and a pick in the graph
  drive the inspector identically. Clicking a task also publishes whichever authored ids it names,
  and a task naming none returns the selection **identical**: a click on an export cannot cost the
  author their place.
- **Two questions, two marks.** In the list, the ring is the task the inspector is open on; the
  tint is every other card the authored selection is about. The React board had one highlight and
  therefore could not say both.
- **A hash the cached status has never heard of is a re-plan, not a miss.** The inspector re-fetches
  once on that condition rather than polling, and says so on screen when the task is still absent.

The graph view exists because a literal rendering of `Task.deps` would be dishonest in three ways,
and each fix is a pure function tested in node:

- **The gate is not an edge.** P3 approval is a planner predicate (`sceneUnblocked`), so a
  halted run has nothing ready and no edge saying why. `barrierFor` synthesizes a barrier node
  and `taskGraphOf` positions it with **ranking-only edges** — handed to `layoutGraph` but not
  to `routeEdges`, so the rank is real and the wires are never drawn. It renders as a dashed
  rule across the layout bounds, carrying one approve button per pending character.
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

**The gate has one affordance, and it is the same one in both places.** A pending character is a
bar in the list and a button on the graph's barrier rule, and each opens the palette on
`gate.approve` with `characterId` prefilled — so `stack.check`'s refusal is printed before the
author commits to anything. The room shell had four partial gate surfaces; there is no
`view.room` to jump through any more.

**The inspector renders the P7 refine loop**, since `shot_image` folds generate → critique → refine
into one runner and a task list would otherwise show one node that made four image calls for no
visible reason. It stacks the attempts with the `Corrections:` clause that caused each next one in
the gap between them; `attempts.ts` is the pure half. Two contracts: `blocking` is computed exactly
as `mergeReports` (`@vn/providers`) computes it, so the UI can't disagree with the verdict the
runner acted on; and every attempt's bytes are in the store (`store.write` runs per attempt,
`store.accept` only on the clean one), so rejected frames are viewable over `vnasset://`. Plan:
[`plans/refine-loop-inspector.md`](plans/refine-loop-inspector.md).

## Play

`editors/play.ts` — the runner. `pathux/play/playback.ts` is the pure half (frames, navigation, the
save blob) with eleven tests beside it. The stage is deliberately raw DOM inside the column frame,
with path.ux widgets only for the chrome above it: a VN frame is a background, a portrait and a text
box, none of which is a control.

- **Live, no file needed.** The renderer calls the `story:play` IPC channel; the main process
  builds the playable in-process from the loaded model + store (`session.playable()`).
- **Image delivery — `vnasset://`.** A privileged custom protocol (registered in
  `src/main/index.ts`) streams `build/assets/<hash>.<ext>` for `vnasset://<hash>.<ext>`, so
  `<img src="vnasset://…">` loads content-addressed bytes. This is the app's only image path.
- **The frame carries its shot, so Play stops being a dead end.** `show` beats gained an optional
  `shot` field (`@vn/types`, `@vn/export`), `framesOf` carries it down the frames between shot
  changes, and the editor publishes `ui.sceneId`/`ui.shotId` as the playthrough moves — so every
  other pane follows along. The React runner never did this; it is the one behavioural gain of the
  port, and it is why the schema changed.
- **No portrait over the shot unless the project asked.** A shot prompt names its own subjects,
  so the frame already shows the cast; the speaker's portrait is staged over it only when
  `story.play.json` says `portraitOverlay`, from `project.yaml`'s `portrait_overlay` —
  [`playable-format.md`](playable-format.md#contracts).
- **Playthrough.** State is a navigation stack (`{ sceneId, frameIndex }[]`, last = current):
  click / Space / Enter / → advances a beat; at scene end it shows choice buttons or auto-follows
  `next`; a leaf scene shows "The End". ← / Backspace rewinds. **Save / Load / Reset** persist the
  stack to `localStorage`, keyed by workspace title. The keys are the area's keymap, which runs
  ahead of the screen's and after path.ux's own textbox guard — so the React runner's tag-sniffing
  has nothing left to do.
- **A missing playable is a sentence on the stage, not a crash.** No project open, or one with no
  generated art, is an ordinary state for an author to read and act on.

## Remembered UI state (`.vndesktop/session.json`)

The layout, the selection (and anything else the shell should remember) live in a flat key/value
file the main process owns — `apps/desktop/src/main/sessionstore.ts`, gitignored, **global per
install** rather than per workspace. `VN_DESKTOP_HOME` relocates it; the default is one line away
from `~/.vndesktop` once the app is installed rather than run from the repo. Full write-up:
[`desktopAppState.md`](desktopAppState.md).

- **Two keys, debounced.** `pathux.layout` is the nstructjs-serialized screen (JSON, magic `VNSC`,
  written through path.ux's own `simple.saveFile`, which stamps the struct schema into the blob so a
  layout written before path.ux changed a `STRUCT` still reads back). `pathux.selection` is the
  three authored ids. Both flush 400 ms after the last change and again on `beforeunload`, since a
  quit does not run the debounce.
- **Nothing here may block boot.** A layout that will not load — corrupt, or naming an editor this
  build has not got — is discarded with a warning and the default screen takes its place. A missing
  or unreadable file reads back as `{}`, which is also how a hand-edited file with a UTF-8 BOM
  behaves; quietly, so do not debug through one.
- **Synchronous first read.** The preload does one `sendSync('session:snapshot:sync')`, so the
  remembered layout is the first thing painted rather than a jump away from the default.
- **Multi-instance by construction.** Nothing stops two app instances sharing the file, so a
  flush takes a `mkdir` lock (stale ones, >5s, are broken), re-reads the file _inside_ the lock,
  and applies **only its dirty keys** over what it finds. Different keys from different
  instances both survive; the same key is last-flush-wins.
- The flat `panel.<id>.width` keys are still written by `renderer/ui/Resizable.tsx`, which is React
  and frozen. They retire when it does.

## Which project is open

One workspace at a time, resolved in `app.whenReady()` before the asset protocol or any session
exists — but no longer resolved *forever*. Plan:
[`plans/project-bootstrap-and-workspace-picker.md`](plans/project-bootstrap-and-workspace-picker.md).

**Precedence at launch**, first hit wins:

1. `--project <dir>` / `VN_PROJECT`.
2. The most recent remembered project that still exists.
3. **The directory picker** — the requirement's own "the app requests the user to pick a
   directory", shown on a genuine first run only. `VN_NO_PICKER=1` skips it.
4. The seeded sample below, which is also what cancelling the picker gets you.

Whatever is opened is remembered, the sample included, so the picker asks once per install and
not once per launch. The list lives at `workspace.recent` in the global session store — it has to
be readable before any project is open, which is why it is per install rather than per project.

**Opening another project** is `workspace.pick` (the dialog) or `workspace.open(path='…')` (the
scriptable one). A directory that is not a project yet *becomes* one: `openWorkspace` writes a
one-line `project.yaml` — `title` is the only key without a default, and an empty project is
empty, not a copy of the sample — then `ensureRepo` initializes a repo and commits whatever was
already there. A `project.yaml` that will not parse is refused rather than opened.

`workspace.open`'s check says which of the two is about to happen ("Opens *The Transfer
Student*" vs "Creates a new project at …"), and refuses the root that is already open, a path
that is not a directory, and a switch while a pipeline run or agent turn is in flight
(`WorkspaceSession.busy()`).

**A switch is a teardown, not a refresh.** The session (with its agent conversation), the command
stack, its undo journal, the repo map and the undo revision are all rebuilt against the new root:
undo never crosses a workspace boundary, and the `command:ui` effect the renderer receives
(`{ type: 'workspace' }`) is a remount. Nothing may cache the root across it — the `vnasset://`
handler resolves `ProjectPaths` per request for exactly that reason.

## Seeded workspace (`examples/mySampleRepo`)

With nothing remembered and no `VN_PROJECT`, the app seeds **`examples/mySampleRepo`** from
`examples/sample` (`apps/desktop/src/main/workspace.ts`).

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

## The retired React shell (`--react`)

`--react` still boots the three-room renderer — STUDIO · FLOOR · PLAY, `renderer/react-shell.tsx`
into `#root` — for one release of caution. It is frozen: no port lands there, and the two shells are
imported lazily so the default one does not pay for React's bundle.

- It **ignores `view` effects**. Those name an editor and a pane, which is the mesh's vocabulary;
  a room shell can only shrug. Palette, undo and workspace effects still work.
- The `Room` / `StudioMode` / `FloorMode` unions are local to it (`renderer/rooms/rooms.ts`) and go
  when it does. Nothing in the main process names a room.
- When it deletes, so do `react`/`react-dom`, every `.tsx` under `renderer/`, `session.ts`,
  `ui/Resizable.tsx` and the flat `panel.*.width` keys — and the pure modules still under
  `rooms/` **move** rather than going with them, because the path.ux editors import them.

# Plan: story branch editor

**Status:** not started. **Depends on:** [desktop renderer restructure](desktop-renderer-restructure.md).
**Blocks:** [task DAG view](task-dag-view.md) (which reuses the `renderer/graph/` primitives
this plan creates).
**Size:** large — the only genuinely new *editor* in
[`../research/graphThingsReport.md`](../research/graphThingsReport.md) §1.

## Why

Branch structure is the one thing about a VN that is invisible in its source. Today the app
shows scenes as a flat list in the STUDIO rail with a `◆`/`◇` reachability pip
(`App.tsx:352`); seeing that `arrival` forks to `greet` and `rooftop`, or that a scene is
orphaned, means running `vngen graph` and opening a `.mmd` file outside the app.

Rewiring a branch is pure topology — the answer is a position, not a sentence — which is
exactly where direct manipulation beats asking the agent. "Make scene 4 also reachable from
scene 2" is a sentence nobody wants to write.

## The write-back problem (read this first)

**There is no round-trip-safe screenplay writer, and building one is not the answer.**

`sceneToFountain` (`packages/model/src/serialize.ts:71`) exists but is explicitly lossy: its
own doc says body/cast reconstruction is best-effort because `Scene.body` is flattened
prose. Rewriting a scene through it would destroy character cues, parentheticals, and
formatting. It is for new-scene scaffolds and diff previews.

`Scene` also carries **no source provenance** — no file, no line, no offset (`splitScenes` in
`packages/model/src/scenes.ts:26` consumes an already-parsed `FountainScript`).

One thing makes this tractable: **there is exactly one screenplay file.**
`packages/store/src/worktree.ts:43` is `const scriptPath = fountain[0] ?? markdown[0]` — the
pipeline reads the first `.fountain` only, despite the `screenplay/*.fountain` plural in the
docs. So the editor has one file to patch, not a set.

### Wave 1 — a surgical marker patcher

New pure function, in `@vn/model` (it is a project-model concern, and `@vn/parse` is
supposed to stay policy-free):

```ts
type SceneBranchEdit = { sceneId: string; choices?: Choice[]; next?: string | null };

applySceneBranchEdit(
  text: string,                              // the whole .fountain source
  edits: SceneBranchEdit[],                  // applied as one atomic patch
): { text: string; diagnostics: Diagnostic[] }
```

**It takes a list, not one scene.** A splice (see below) rewires two scenes in a single
authorial act; sequencing two single-scene patches would leave a window where the screenplay
is half-rewired and the re-parse assertion would have to pass over an intentionally
inconsistent intermediate. One pass, one assertion, all-or-nothing.

Contract:

- **Rewrites only `[[choice: …]]` and `[[next: …]]` note lines** inside each target scene's
  block. Every other byte of the file is preserved exactly — including comments, boneyard,
  unusual whitespace, and note lines the parser does not recognize.
- Edits are applied against a single scan of the source, so two edits to the same scene are a
  caller error (reject with a diagnostic) rather than a last-writer-wins race.
- Locates the scene by scanning for scene headings and `[[scene: id]]` markers at the text
  level. Do **not** add source offsets to the Fountain parser for this; that parser is on the
  hot path for every consumer and this is one caller's need.
- Marker syntax must match what `parseBranchMarker` accepts
  (`packages/parse/src/branch.ts:17`), including the quoted-label form
  `[[choice: "Tell the truth" -> s13]]`. Labels containing `->` or quotes need an escaping
  decision — pick one and pin it with a test.
- Inserts new markers immediately after the `[[scene: id]]` marker, matching the order
  `sceneToFountain` emits (scene, choices, next) so hand-authored and tool-authored files
  converge rather than diverging.

**The safety net is total and cheap: after patching, re-parse the whole file and assert the
resulting scene graph equals the intended graph.** If it does not, discard the patch and
return a diagnostic. A branch edit that silently corrupts a screenplay is the worst failure
this app could have, and this check makes it structurally impossible.

Tests (`packages/model/src/tests/`): patch preserves untouched bytes; add/remove/relabel a
choice; set and clear `next`; a scene with no existing markers; a label needing escaping; a
scene id that does not exist; a file where two scenes share a heading; a two-scene edit
applied in one pass; and a two-scene edit where the second scene is missing, which must leave
the file byte-identical.

## Wave 2 — shared graph primitives

`renderer/graph/`, created here and reused by the DAG view. Pure `.ts` with `tests/`
siblings, per the restructure plan's convention — no jsdom, no React in these files.

```
renderer/graph/
  viewport.ts     pan/zoom transform, screen↔world, fit-to-content
  layout.ts       layered DAG layout (rank by longest path, order to reduce crossings)
  hit.ts          point→node, point→edge with screen-space slop
  edges.ts        edge routing (orthogonal or curved) + label anchor points
  Canvas.tsx      the thin React/SVG shell that renders a laid-out graph
  tests/
```

Two constraints worth stating up front, both from `@vn/debug2d`'s design notes:

- **Hit slop scales in screen space; geometry scales in world space.** Getting this backwards
  makes small targets unclickable when zoomed out and sloppy when zoomed in.
- **Layout must be deterministic.** Same graph in, same positions out — no randomized
  force-directed step. Otherwise the view reshuffles on every re-render and tests can't pin
  anything.

**Decision: v1 has no manual node positioning.** `Scene` has no `x`/`y`, and adding a
position store means inventing a UI-state file, deciding whether it is committed, and
solving command-record coalescing for continuous drags. Auto-layout only. Revisit only if
auto-layout proves unusable on a real script.

That gives the editor a single coherent rule: **position is not semantic, so every drag is.**
Dragging a card does not move a box — there is no "here" to move it to. It rewires the story.
Two gestures follow from that, both discrete and both committing on drop: dragging from a
card's edge handle *connects*, and dragging a card onto an existing edge *splices*.

## Wave 3 — commands and IPC

Mutations route through `@vn/commands`, not new IPC channels. Add to
`apps/desktop/src/main/commands/story.ts`:

| Command | Props | Mutating |
| --- | --- | --- |
| `story.graph` | — | no — returns scenes + edges + reachability for the view |
| `story.setChoice` | `scene`, `goto`, `label`, `index?` | yes |
| `story.removeChoice` | `scene`, `index` | yes |
| `story.setNext` | `scene`, `goto?` (omit to clear) | yes |
| `story.spliceScene` | `scene`, `from`, `edge` (choice index, or omitted for the `next` edge) | yes |

Each mutating command: load the screenplay text, call `applySceneBranchEdit`, write
atomically via `@vn/util`, reload the model, and report `written: ['screenplay/<file>']` so
the `CommandRecord` provenance is accurate. Rebuild the model after every edit — reachability
changes, and a stale `model.reachable` would mislabel dead scenes.

`story.spliceScene` is the one command that emits a two-scene edit: splicing `C` into
`A→B` becomes `[{ sceneId: A, choices: … }, { sceneId: C, next: B }]` in a single patch.
It is deliberately its own command rather than a caller-side pair of `setChoice` + `setNext`,
so one authorial act is one `CommandRecord` with one replayable `invocation`.

### Splice semantics — four rules to pin with tests

1. **Refuse when `C` already has choices.** `Scene.next` is *"[l]inear continuation when there
   are no explicit choices"* (`packages/types/src/entities.ts:146`) — the runner shows choice
   buttons at scene end and only auto-follows `next` when there are none
   (`apps/desktop/renderer/rooms/play/Runner.tsx`). So writing `C.next = B` on a scene that
   forks would produce an edge the runner silently ignores — the story would never reach `B`.
   Reject with a visible reason. A silently-dead edge is exactly the failure this editor
   exists to catch.
2. **It is a rewire, not a move.** Scenes can be the target of many edges, and splicing does
   not touch `C`'s existing inbound edges. `C` stays reachable from wherever it already was.
   A true "move" would mean rewiring every inbound edge to `C`, which is far more destructive
   and must not hide behind the same gesture.
3. **Cycles are legal.** `computeReachable` (`packages/model/src/graph.ts:11`) uses a visited
   set, and looping back to a hub scene is a normal VN structure. Do not validate against
   cycles. Do reject the degenerate drops — `C` being either endpoint of the target edge.
4. **The label stays with the decision.** If `A→B` is labeled *"Tell the truth"*, after the
   splice it is `A→C` with the same label. The decision has not changed, only where it leads
   first.

Because these are registry commands, they are reachable from the palette and CDP for free:

```sh
node scripts/vn-cdp.mjs "story.setNext(scene='arrival' goto='rooftop')"
```

## Wave 4 — the editor surface

**Where it lives:** a STUDIO mode, replacing the SCENES rail group as the room's main
surface when active. It is an authoring act and it belongs next to the agent — drag a node,
then ask vnauthor to write the scene you just created a slot for.

`Room` (`src/shared/ipc.ts:36`) stays a three-value union; it is part of the command catalog
contract. Add a separate `view.mode(room, mode)` command and a `{ type: 'mode' }` `UiEffect`
rather than growing `Room` into a mixed list of rooms and modes.

### Design

This extends the existing identity; it does not invent one. Scenes are authored material,
so the editor lives on the **warm** side — `--sodium` structure on `--ink-sunken`, with
`--signal` reserved for the one machine-side element (a generated thumbnail), which lets a
node say who made each part of it without a legend.

The vernacular is already in the app — STUDIO, FLOOR, CAST, SETS, the `⟂ GATE` glyph — and
the subject's own artifact is the writers' room **index card**. So: nodes are cards, not
rounded rectangles. `--r-chrome` (4px), a hairline `--ink-line` border, the scene id in
`--mono` as a small header, the synopsis in `--prose`.

**Signature: the choice label is typeset on the wire, in Newsreader italic, not hidden in a
tooltip.** The graph then reads as prose — *"Introduce yourself"* running along the edge
from `arrival` to `greet` — which is what a branching script actually is. It is the one
place to spend boldness; everything else stays quiet.

Supporting decisions, all inherited rather than invented:

- **Unreachable scenes** get a dashed hairline and desaturated ink — matching the existing
  `classDef dead stroke-dasharray: 5 5` convention in `toMermaid`, so the app and the
  `.mmd` export agree.
- **`next` edges are hairlines; `choice` edges carry weight.** The distinction is real: one
  is a fallthrough, the other is a decision.
- **No numbered markers on nodes.** Scenes are a graph, not a sequence; numbering them would
  encode something false.
- Empty state is an invitation, not an apology: a single card for the entry scene and a hint
  that dragging from its edge creates the next one.

### Interactions

| Gesture | Effect |
| --- | --- |
| Drag from a card's edge handle to another card | `story.setChoice` (or `setNext` if the source has none) |
| **Drag a card body onto an edge** | `story.spliceScene` — `A→B` becomes `A→C→B` |
| Drag a card body anywhere else | nothing; it snaps back |
| Drop a card onto another card | nothing — ambiguous between connect, replace, and merge |
| Click an edge label | inline edit the choice label → `story.setChoice` |
| Drag an edge endpoint away | `story.removeChoice` |
| Click a card | seed the composer, as the rail does today (`App.tsx:283`) |
| Scroll / drag background | zoom / pan |

While a card is being dragged, edges that would accept it highlight, and edges that would be
refused by rule 1 above are marked as refused rather than simply inert — the reason has to be
visible during the gesture, not after it fails.

**Swap (exchange two scenes in a chain) is not a gesture.** It is two splices, it is rare,
and node-onto-node drop is too ambiguous to carry it.

**Relayout after a splice must be animated.** Auto-layout re-ranks the graph, so the card will
not land where it was dropped — it moves to wherever its new rank puts it. Without a
transition that reads as broken. This is not polish; it is what makes the gesture legible.

Every mutation is one command → one `CommandRecord`. No continuous-drag coalescing problem,
because no continuous drag mutates anything — a drag is continuous but its *commit* is
discrete.

## Verification

- `pnpm test` — the patcher (Wave 1) and layout/hit/viewport (Wave 2). These are the parts
  where a bug is expensive and a test is cheap. Splice gets its own cases: the four rules
  above, plus a splice whose two-scene patch fails partway and leaves the file untouched.
- The patcher's re-parse assertion is itself the integration test; run it over
  `examples/sample`'s screenplay with a generated sweep of edits.
- Live: rewire `examples/sample`, then confirm `vngen graph examples/sample` agrees with
  what the editor showed, and `git diff` shows only marker lines changed.

```sh
node scripts/vn-cdp.mjs --raw "window.__vnDebug.explainPick(400, 300)"
```

## Risks

- **Silent screenplay corruption** — mitigated by the re-parse assertion. Do not skip it,
  and do not downgrade it to a warning.
- **Auto-layout on a real script may be unusable.** `examples/sample` is small; a 60-scene
  script with heavy convergence is the real test. Build the layout against a synthetic large
  graph before trusting it.
- **The one-screenplay-file assumption** is true today (`worktree.ts:43`) but is an
  implementation detail, not a documented contract. If multi-file support ever lands, the
  patcher needs a file argument. Note the coupling in a comment at the call site.
- **Scope creep toward a scene editor.** Deleting, renaming, and writing scene content are
  out of scope. This edits edges.
- **Splice reads as "move" and is not one.** A user who splices a scene that was already
  wired elsewhere gets a second inbound edge, not a relocation. If that misreads in practice,
  the fix is to *show* the existing inbound edges during the drag — not to quietly make the
  gesture destructive.

## Scene creation — the one piece of scope worth reconsidering

Splicing an *existing* scene into an edge is the mechanic; splicing a **new** one is the
writer's actual move ("I need a beat between these two"). The gesture is most of the way
there: a `+` affordance that drags onto an edge, dropping an empty scene into the gap for
vnauthor to fill.

It is listed out of scope below because it needs a scene *scaffold* writer, not just a marker
patcher — and `sceneToFountain` is the lossy serializer this plan opens by warning about.
Appending a new heading plus its `[[scene:]]` marker at the end of the file is a much smaller
job than rewriting an existing scene, though, since there is nothing to preserve. Treat it as
the first candidate for a follow-up pass, and do not design the splice gesture in a way that
would exclude it.

## Out of scope

Scene deletion, scene creation (above), body or dialogue editing, manual node positions, minimap,
multi-select, undo (the stack refuses by design — see
[`../gitUndoOptions.md`](../gitUndoOptions.md)), and thumbnails beyond a single accepted shot
image per scene.

## Done

- [ ] `applySceneBranchEdit` lands with the re-parse assertion and full test coverage,
      applying a multi-scene edit atomically
- [ ] `renderer/graph/` primitives exist, deterministic, tested in node
- [ ] Five `story.*` commands registered, in the catalog, driveable from CDP
- [ ] Drag-to-splice works, refuses a target with choices for a visible reason, and animates
      the relayout
- [ ] Branch editor renders `examples/sample` correctly, dead scenes dashed
- [ ] An edge rewire changes only marker lines in `git diff`
- [ ] `vngen graph` and the editor agree on the same project
- [ ] `CLAUDE.md` + [`../command-system.md`](../command-system.md) updated with the new
      commands and the `view.mode` effect

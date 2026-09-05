# A source-agnostic 2D graphics debugging API

<!-- toc -->

- [1. The IR](#1-the-ir)
  * [Fragment](#fragment)
  * [Paint is not pick](#paint-is-not-pick)
  * [Frame](#frame)
  * [Spaces](#spaces)
- [2. The capture seam](#2-the-capture-seam)
  * [Capabilities, not lowest-common-denominator](#capabilities-not-lowest-common-denominator)
- [3. Adapters](#3-adapters)
  * [Canvas / scene graph](#canvas--scene-graph)
  * [DOM](#dom)
  * [SVG](#svg)
- [4. Composite frames](#4-composite-frames)
- [5. Query vocabulary](#5-query-vocabulary)
  * [Spatial](#spatial)
  * [Structural / semantic](#structural--semantic)
  * [Diagnostic](#diagnostic)
- [6. Explaining — the causal layer](#6-explaining--the-causal-layer)
  * [`explainPick(x, y)` — an ordered rejection log](#explainpickx-y--an-ordered-rejection-log)
  * [The rest of the family](#the-rest-of-the-family)
- [7. Time](#7-time)
- [8. Invariants](#8-invariants)
- [9. Views](#9-views)
- [10. Node-editor domain layer](#10-node-editor-domain-layer)
- [11. Access paths](#11-access-paths)
- [12. Pragmatics](#12-pragmatics)
- [13. Testing](#13-testing)
- [14. Suggested first slice](#14-suggested-first-slice)
- [15. Where it lives](#15-where-it-lives)
- [Open questions](#open-questions)

<!-- tocstop -->

Status: exploratory design, partly shipped. The first slice of §14 — the fragment/frame IR, the DOM adapter, the space
registry, the query engine and `explainPick` — is implemented as `@vn/debug2d`
([`../plans/archive/INDEX.md#2d-graphics-debug-api`](../plans/archive/INDEX.md#2d-graphics-debug-api)); see
[`../guides/debugGuide.md`](../guides/debugGuide.md) for how to use it. The canvas/SVG adapters, composite frames, time
travel, `explainTransform`/`whyInvalidated`, and the node-editor domain layer (§10) remain design only._

This is a debugging layer for complex 2D UIs. It covers the desktop app's rooms today and a node-based story editor
later. The premise is that the hard part of UI debugging is not drawing overlays. The hard part is answering questions
about what was drawn, by whom, in what order, and when it changed. So the layer is built as a query engine over a
recorded frame log, and visual overlays are one of several views onto a query result.

The second premise is that the UI mixes DOM/React chrome with our own canvas rendering, and the worst bugs occur at that
boundary. The system must therefore treat both sources alike, without depending on which one drew a given element. A
neutral intermediate representation sits between capture and query:

```
CanvasRecorder ┐
DomSampler     ├─→  Frame { fragments[], spaces, caps }  ─→  query engine ─→ views
SvgSampler     │                                                              (overlay / table / text)
SceneGraph     ┘
```

Queries, time travel, `explain()` and invariants all sit above the IR. Each is written once, and none of them depends on
which source the data came from.

The third premise shapes more of the design than it first appears. The question you arrive with is almost never "what is
at this point." It is "why did my click miss," "why is this on top," "why did this move," "why did this re-render."
Spatial queries underlie the causal `explain()` family in §6, and that family is what the design delivers.

## 1. The IR

### Fragment

The unit of the IR is a visual fragment, which is one contiguous mark on screen with attribution. A canvas `fillRect` is
one fragment. A DOM element's background box is one fragment. Each line box of a wrapped inline `<span>` is one fragment.

```ts
type FragId = string; // unique within a frame, e.g. 'canvas:218', 'dom:t9'

type Fragment = {
  id: FragId;
  z: number;                  // resolved paint order within the frame (source-computed)
  kind: 'fill' | 'stroke' | 'text' | 'image' | 'box' | 'clip' | 'group';
  bounds: Rect;               // axis-aligned, in `space`
  space: SpaceId;
  shape?: Shape;              // optional higher-fidelity geometry
  clip?: ClipRef[];           // resolved ancestor clips, in `space`, each attributed
  style: StyleSnapshot;
  pick: PickSnapshot;         // hit-testability — see below
  owner: OwnerRef;
  tags: string[];
  source: SourceId;
  stack?: string;             // capture site, when the source and tier support it
  raw?: unknown;              // escape hatch: the Element, the recorded op, the fiber
};

type Shape =
  | { type: 'rect'; rect: Rect }
  | { type: 'rrect'; rect: Rect; radii: [number, number, number, number] }
  | { type: 'rects'; rects: Rect[] }        // inline fragmentation, multi-box elements
  | { type: 'poly'; points: Vec2[] }
  | { type: 'path'; path: PathData };       // canvas / SVG only

type StyleSnapshot = {
  fill?: Color;
  stroke?: Color;
  lineWidth?: number;
  alpha: number;
  composite?: string;
  filter?: string;
  font?: { family: string; size: number; weight: number };
  text?: string;              // for kind: 'text', truncated — see §12
};

type OwnerRef = {
  id: string;                 // 'node:b1/port-in', 'Tooltip/frame'
  label: string;              // human-facing
  kind: string;               // 'widget' | 'component' | 'element' | …
  parent?: string;
};

type ClipRef = { rect: Rect; by: FragId };  // *which* ancestor clipped, not just the rect
```

`raw` is deliberate. The IR should be sufficient for querying, not lossless. When you need the actual `HTMLElement` or
the original draw op, take the typed escape hatch instead of growing the IR.

`ClipRef` carries `by` because "this is clipped away" is a much weaker answer than "this is clipped away by `.rail`". The
IR should attribute every field it can.

### Paint is not pick

A fragment models a mark on screen, but the most common bug concerns interaction, and paint order and hit-test order are
not the same relation. `pointer-events`, hit slop, `opacity: 0` (invisible but still clickable, a genuine and frequent
bug), and SVG's `pointer-events` variants all pull the two apart. Hit-testability is therefore a first-class part of the
IR rather than an inference from `style`:

```ts
type PickSnapshot = {
  mode: 'auto' | 'none' | 'bounds' | 'painted';
  slop?: number;              // extra hit radius, in `space` — wires and handles need it
  shape?: Shape;              // when the hit geometry differs from the drawn geometry
};
```

When `pick.shape` is present it is the authority for `dbg.at()`, and `shape` remains the authority for what is drawn.
Keeping both lets `mismatch()` (§5) diff them, which catches the highest-value invariant in a node editor: the shape that
receives the click differs from the shape that is drawn.

### Frame

```ts
type Frame = {
  index: number;
  t: number;                     // ms, monotonic
  fragments: Fragment[];         // globally z-ordered across all sources
  spaces: SpaceRegistry;
  caps: Record<SourceId, SourceCaps>;
  fidelity: 'recorded' | 'sampled' | 'mixed';
  events?: InputEvent[];         // pointer/key events attributed to this frame
  invalidRects?: Rect[];         // where the source believes it repainted
  commits?: CommitRecord[];      // React commits since the previous frame (§3)
};
```

`fidelity` marks which of two kinds of frame a consumer holds. A canvas frame is recorded: its fragments are exactly what
was drawn. A DOM frame is sampled: it is a snapshot of retained state at one moment, so a change that was made and undone
between two samples is not captured. A consumer must check `fidelity` before reading a frame.

### Spaces

Every rect records the space it is expressed in, and conversion is explicit and automatic rather than implicit. Without
that, coordinate-space confusion goes unnoticed and costs days.

```ts
type SpaceId = 'device' | 'css' | `world:${string}`;

interface SpaceRegistry {
  transform(from: SpaceId, to: SpaceId): Mat3 | null;
  convert(r: Rect, from: SpaceId, to: SpaceId): Rect;
  chain(from: SpaceId, to: SpaceId): TransformStep[];   // labeled, for explainTransform
}

type TransformStep = { label: string; matrix: Mat3; by?: FragId };
```

`device` is the common root; every source registers its transform chain into it. The node editor registers `world:graph`
from its pan/zoom matrix, so you can call `dbg.inAABB(r, {space:'world:graph'})` with `r` in graph coordinates.

`chain()` exists so the registry can describe a conversion as well as perform it (see `explainTransform` in §6). The
classic double-applied DPI scale is invisible in a composed matrix and obvious in a labeled chain.

## 2. The capture seam

```ts
interface FrameSource {
  readonly id: SourceId;
  readonly caps: SourceCaps;
  capture(opts?: CaptureOpts): Frame | Promise<Frame>;  // pull
  subscribe?(cb: (f: Frame) => void): Unsub;            // push, if immediate-mode
  spaceTransform(from: SpaceId, to: SpaceId): Mat3 | null;
}
```

Push and pull capture is the first real asymmetry between backends. Canvas capture is push-based: drawing emits fragments
every frame at no extra cost. DOM capture is pull-based: nothing is emitted, so the capture walks the tree and reads
boxes. Each source implements its own capture strategy, and the recorder requests only the frame at time t.

### Capabilities, not lowest-common-denominator

Each source declares what it can do, and the IR is not degraded to what the weakest backend supports.

```ts
type SourceCaps = {
  exactZ: boolean;          // canvas: yes (emission order). DOM: computed, approximate.
  paths: boolean;           // canvas/SVG: yes. DOM: rects + border-radius only.
  perFragmentStyle: boolean;
  overdraw: boolean;        // meaningless for retained DOM
  stacks: boolean;          // capture site; DOM only via instrumented React
  continuous: boolean;      // every frame, vs. sample-on-demand
  hitOracle: boolean;       // source can independently verify its own pick order (§3)
};
```

If the source cannot answer a query, it returns `{ unsupported: [SourceId] }` rather than zeros. Debug tooling that
reports wrong numbers without saying so is worse than debug tooling that reports nothing.

## 3. Adapters

### Canvas / scene graph

This approach has the highest fidelity and the lowest cost. Proxy the 2D context so that every real draw call is recorded
with attribution. The emission index supplies `z`. Attribution comes from an explicit scope wrapper around widget draw
code:

```ts
dbg.scope('node:b1/port-in', ['port'], () => { ctx.fillRect(…); });
```

It wraps the real drawing, so there is no parallel debug-draw system to keep in sync. Keeping such a system in sync is
the single most common failure mode of hand-rolled debug layers.

The same rule should hold on the pick side, where we control the hit tester (unlike the DOM). The canvas adapter's pick
fragments must come from the editor's real spatial index, not from a second traversal written for the debugger. Otherwise
`mismatch()` reports constant adapter drift instead of real bugs, and gets ignored. The index emits
`pick.shape`/`pick.slop` as it is populated, the same way `dbg.scope` emits draw geometry.

### DOM

This is the hard adapter, and it earns the most.

- **Geometry** — Comes from `getBoundingClientRect()`, plus `getClientRects()` for inline elements that fragment across
  line boxes. One element becomes several fragments, which is why `Shape` includes `rects[]`.
- **Z** — paint order is not `z-index`. Walk stacking contexts (established by `z-index` on positioned elements,
  `opacity < 1`, `transform`, `filter`, `will-change`, `isolation`, `contain`, `backdrop-filter`), then apply CSS 2.1
  painting order within each: backgrounds → negative z → block-level → floats → inline → `z:0`/`auto` → positive z.
  Implement it once and set `exactZ: false`. This takes roughly 150 lines and is the most valuable thing this adapter
  does, because a reader cannot determine what paints on top by inspecting the source.

  The walk must record the ancestor. When it finds an element whose `z-index` was scoped by an ancestor that established
  a context, record that ancestor. §6 prints that ancestor, and recording it during the walk costs nothing, while a later
  pass cannot recover it.
- **Pick + oracle** — `pick.mode` comes from the computed `pointer-events`. The computed stack is then cross-checked
  against `document.elementsFromPoint()`, which reports the browser's real hit order and is obtained at no cost. Set
  `hitOracle: true`. A disagreement between the two is always worth investigating: it indicates either a bug in our 150
  lines of stacking-order code or a genuine UI bug, and `explainPick` reports that it cannot tell the two apart rather
  than choosing one silently.
- **Attribution** — resolvers form a pluggable chain: the `data-dbg-id` attribute, then the React fiber (`_debugOwner`
  / `elementType` name, plus `_debugSource` for `file:line` when the JSX source transform is on, as it is in Vite dev),
  then the tag + class path. The fiber walk is a dev-only fallback that is fragile across React versions, and it is never
  the primary path. Apps should be able to override the chain outright, and attribution must degrade to `unknown` rather
  than throw.
- **Commits** — subscribe to React commits via `<Profiler onRender>` wrapping each room, and attach a `CommitRecord[]`
  to the frame. The commit records make `whyInvalidated` (§6) possible, and they let `diff` report which prop change
  moved 400 nodes rather than only that the nodes moved:

  ```ts
  type CommitRecord = {
    owner: string;            // Profiler id / component name
    phase: 'mount' | 'update' | 'nested-update';
    actualDuration: number;
    changed?: string[];       // dev-only prop/state keys that differed, incl. identity-only
  };
  ```

  `changed` should distinguish the case where identity changed but the value is equal. A re-render caused by a new array
  with the same contents is the most common React performance bug, and a value diff does not detect it.
- **Cost** — batch all geometry reads in a single pass and never interleave them with writes (each interleave forces
  layout). Do not sample every frame. Coalesce a `MutationObserver` into a rAF, and prefer aligning samples to React
  commits over bare rAF where both are available. Store DOM frames as diffs against the previous one, or the ring buffer
  becomes enormous.
- **Self-exclusion** — the adapter must skip its own overlay subtree (`[data-dbg-overlay]`) and any element it
  injected. Capturing its own highlight rectangles would make the results depend on whether the debugger is running.

### SVG

This adapter falls between the two. It reports real paths (`caps.paths: true`), takes z-order the way the DOM does
(document order plus `paint-order`), and carries a moderate cost. It is mostly a variant of the DOM adapter, except that
SVG `pointer-events` has its own vocabulary (`visiblePainted`, `boundingBox`, …), which maps onto `PickSnapshot.mode`
rather than onto CSS's two values.

## 4. Composite frames

A multiplexing recorder makes the DOM/canvas boundary debuggable:

```ts
const dbg = createDebugger({
  sources: [
    domSource(document),
    canvasSource(graphCtx, { mountedIn: '#graph-canvas' }),
  ],
  spaces: { 'world:graph': () => graphView.transform },   // world → css
  tier: 'bounds',
  historyFrames: 120,
});
```

Two mechanisms are involved:

1. 1. **Splicing.** The canvas element is one DOM fragment at some z. Its canvas-source fragments splice into the global
   order at that slot, so a single `dbg.at(x, y)` call reports the DOM tooltip, the canvas contents beneath it, and the
   page background beneath those, as one z-ordered stack.
2. **Space registry.** All sources register transforms into `device`, so a query in any space
   resolves against fragments from every source.

Splicing also answers the highest-value cross-boundary question. Is a click being intercepted by a transparent DOM
overlay, or is the canvas hit-test wrong? No single-source tool can represent that question.

## 5. Query vocabulary

The design constraint is that it must be pleasant to type into a console at 2am, so it is chainable and lazy in the style
of jQuery.

### Spatial

```ts
dbg.at(x, y, { space, using })          // z-ordered stack under a point
dbg.inAABB(rect, { mode })              // 'intersect' | 'contain' | 'center'
dbg.inCircle(c, r)
dbg.inPoly(points)
dbg.crossing(segment, { width })        // stroked-line intersection
dbg.nearest(pt, { k, maxDist, filter }) // the snapping / magnetism debugger
dbg.overlapping(other?, { minArea })    // within a set, or between two sets
```

`using: 'paint' | 'pick'` (default `'pick'` for `at`, `'paint'` elsewhere) selects which geometry the query tests
against. Because `at` defaults to pick geometry, the console answer matches what a click would do.

### Structural / semantic

```ts
dbg.byOwner('node:b1').descendants()
dbg.byTag('port')
dbg.bySource('dom')
dbg.op('text')
dbg.where(pred)
dbg.owners()                            // collapse fragments → owning nodes
```

### Diagnostic

```ts
dbg.offscreen()      // drawn entirely outside the viewport — wasted work
dbg.clipped()        // drawn but fully clipped away
dbg.zeroArea()       // degenerate geometry; a classic silent bug
dbg.occluded()       // fully covered by a later opaque fragment
dbg.invisibleButClickable()   // alpha 0 / clipped, yet pick.mode !== 'none'
dbg.overdraw(rect)   // per-pixel coverage heatmap + top offenders (canvas only)
dbg.mismatch(a, b, { tolerance })   // set-vs-set geometry diff
```

`mismatch` runs the visual geometry and the hit-test geometry as two tagged fragment streams over the same engine and
diffs them. In every node editor, the most common bug class is that the region you click is not the region you see, and
that bug stays invisible until both geometries are drawn.

Result ordering is part of the contract. Every query returns a deterministically sorted set (z descending, then
`FragId`), because these results go into golden tests (§8), and a golden test cannot assert on results that reorder
between runs.

## 6. Explaining — the causal layer

The sections above answer what the system does. This section answers why, and these reasons motivate building the rest.
Each item below is derivable from data the adapters already compute, so the only design work is keeping that data rather
than discarding it.

### `explainPick(x, y)` — an ordered rejection log

This is a ranked account of why each candidate lost, not an inventory of what is under the point.

```
explainPick(412, 308) css → winner + 6 rejections
  ✓ canvas #218  wire:a3→b1        stroke, d=2.1px ≤ slop 4      Graph.tsx:· scope
  ✗ dom    #t4   div.tooltip       alpha 0 — but pick='auto' (clickable while invisible)
  ✗ dom    #p1   div.panel         clipped away by div.rail (overflow: hidden)
  ✗ dom    #m9   div.modal         z-index 999 ignored — div.stage established a
                                   stacking context via `transform: scale()`  Floor.tsx:41
  ✗ dom    #s2   div.scrim         pick='none' (pointer-events)
  ✗ canvas #101  node:b1/port-in   below winner (z 101 < 218)
  ✗ canvas #c7   node:c2           culled: outside viewport
  ⚠ oracle disagreement: elementsFromPoint ranks #m9 above #t4 — computed stacking order
    may be wrong here, or the DOM adapter is stale relative to this frame.
```

The stacking-context line is the primary output. It follows mechanically from the walk in §3, it is where CSS debugging
loses the most time, and no existing tool prints it.

The `⚠` line matters as much. Where the computed order and the browser oracle disagree, report the disagreement rather
than choosing between them. A reported disagreement is actionable; a confident wrong answer is not.

### The rest of the family

```ts
dbg.explainZ(a, b)          // why a paints over b: shared context, then rule that decided it
dbg.explainTransform(id)    // labeled matrix chain, step by step, with cumulative result
dbg.explainLayout(id)       // DOM: offsetParent chain + which resolved rule set this box
dbg.whyInvalidated(id)      // which commit, which changed keys, identity-vs-value
dbg.whyMoved(id, a, b)      // bounds delta across two frames, attributed to transform vs. layout
```

`explainTransform` output is deliberately arithmetic rather than prose, because the bug is
almost always visible as a repeated factor:

```
explainTransform(node:b1)  world:graph → device
  world:graph → css     pan/zoom          scale 1.5   translate 120,40    GraphView.ts:88
  css → css             .stage transform  scale 2.0                       Floor.tsx:41   ← ?
  css → device          devicePixelRatio  scale 2.0
  ────────────────────────────────────────────────────────────────────────
  cumulative                              scale 6.0   translate 480,160
```

`whyInvalidated` is the one I would want most in a node editor, and that need is why `CommitRecord` sits in the IR rather
than in the open-questions list:

```
whyInvalidated(node:b1)  frame 812
  commit  GraphCanvas  update  4.2ms
    changed: nodes  (identity changed, value equal — new array, same contents)
    changed: selection
  → 400 owners re-rendered; 398 had unchanged bounds and style
```

The last line reports how much of the commit was wasted. That figure comes from an existing query rather than a new
mechanism. It is `diff(prev, cur)` filtered by the commit's owner subtree.

## 7. Time

```ts
dbg.frame(-3)                  // relative to now
dbg.frames(-60, 0)
dbg.diff(a, b)                 // added / removed / moved / restyled, keyed by (owner, tag, kind)
dbg.history(ownerId)           // one node's bounds + style across the window
dbg.when(pred)                 // first frame where a predicate became true
dbg.pin()                      // freeze the ring buffer
```

`dbg.when(f => f.byTag('wire').overlapping().length > 0)` finds the frame where the wires started crossing. It is the
highest-value query here and the one no existing tool offers. Pair it with auto-pin, a ring buffer that freezes itself
the moment a registered invariant trips, so the frames leading up to the symptom are still available afterwards. A ring
buffer is only worth its cost with retroactive capture; without it, you must reproduce the bug again to reach the frame
you needed.

Over sampled (DOM) history, `when` has sampling gaps by construction. A consumer checks `frame.fidelity` to learn whether
the history is sampled.

## 8. Invariants

Once queries exist, assertions cost little to add, and they convert one-off debugging into permanent regression tests.
The query layer is pure over a plain `Frame`, so the same predicate runs live in dev and headless in tests against a
synthetic frame.

```ts
dbg.invariant('ports-inside-node', f =>
  f.byTag('port').every(p => f.byOwner(p.owner.parent).bounds.contains(p.bounds)));

dbg.invariant('no-wire-through-node', f =>
  f.byTag('wire').flatMap(w => f.crossing(w.shape).byTag('node-body')).isEmpty());

// cross-source — the thing that is not expressible with any existing tool
dbg.invariant('tooltip-never-covers-selection', f =>
  f.bySource('dom').byTag('tooltip')
   .overlapping(f.bySource('canvas').byTag('selected-node'))
   .isEmpty());

dbg.invariant('port-hitboxes-match-visual', f =>
  f.mismatch(f.byTag('port'), f.byTag('port-hit'), { tolerance: 1 }).isEmpty());

dbg.invariant('nothing-invisible-is-clickable', f => f.invisibleButClickable().isEmpty());
```

On a failure, pin the buffer, log the `explain()` output, and optionally throw or take a screenshot.

## 9. Views

Three consumers render one result set in three different ways.

- **Overlay** — `dbg.show(result)` highlights the set live, and `dbg.isolate(result)` dims everything else. Hovering
  shows a fragment card. Overdraw draws as a heatmap, and invalid rects draw as flashing outlines. The overlay renders
  into a `[data-dbg-overlay]` portal with `pointer-events: none`, and capture excludes it per §3.
- **Table** — `result.table()` lists owner, source, bounds, tags, and z.
- **Text** — `result.explain()` prints a compact ASCII stack. Text output is a primary interface, and it makes the
  debugger usable over a text channel, whether by a human reading logs or by an agent debugging the editor without
  screenshots. Floats are canonicalized to fixed precision and ordering is deterministic, so `explain()` output is
  diffable and can itself serve as a golden.

```
at(412, 88) css → 5 fragments, top-first
  dom     #t9   box     Tooltip/frame        404,72 180x40   z=[ctx:overlay,+10]  α0.98
  canvas  #218  stroke  wire:a3→b1           380,84 44x9     z=218                #6aa 1.5px
  canvas  #101  fill    node:b1/port-in      404,80 16x16    z=101                #333
  dom     #c1   box     canvas#graph-canvas  0,64 1920x1016  z=[ctx:root,0]       ← canvas splice
  dom     #r0   box     div.app              0,0 1920x1080   z=[ctx:root,auto]
```

## 10. Node-editor domain layer

Generic geometry is not specific to graphs, so a thin domain layer sits on top:

```ts
dbg.graph.wiresCrossing()        // pairwise wire intersections — routing + aesthetic bugs
dbg.graph.portsWithoutWire()
dbg.graph.hitTargets(pt)         // logical pick vs. drawn pick
dbg.graph.layoutOverlaps()
dbg.graph.wireLength(edgeId)     // pathological routing
dbg.graph.viewport()             // pan/zoom transform + which nodes are culled
dbg.graph.snapCandidates(pt)     // ranked ports with distances — why it snapped to the wrong one
dbg.graph.hairline()             // assert 1px strokes land on 1 device pixel at this zoom
```

The last two are zoom-specific and easy to get wrong in both directions. Hit slop must scale in screen space, while
geometry scales in world space. A hairline that is correct at 100% renders as a smear at 150%.

## 11. Access paths

The text view is only useful if something can reach it. Three surfaces reach it, ordered cheapest first:

1. 1. **`window.__vnDebug`** — Serves both the console and agents. It is exposed through `contextBridge` in
   `apps/desktop/src/preload/` so it survives context isolation, and it exists only in development builds.
2. 2. **chrome-devtools-mcp `evaluate_script`** — reaches surface 1 in a running renderer with zero additional plumbing,
   so it validates the design against the real app before any IPC work.
3. 3. **A `debug:query` IPC channel** — the channel is declared alongside `story:play` in
   `apps/desktop/src/shared/ipc.ts`, so the main process (and therefore the CLI, and therefore an agent or a test
   harness) can query the live renderer and get JSON back. Queries arrive as a serializable descriptor rather than a
   function, so the channel carries only data.

Surface 3 is the surface that changes debugging. An agent that inspects `explainPick` output reasons from ground truth
rather than from a screenshot.

## 12. Pragmatics

- **Tiers.** The tier is one of `off | bounds | full | full+stacks` and can be switched at runtime. Recording bounds
  and style is cheap. Retaining paths and capturing stacks is expensive. Gate `full` behind a dev flag.
- **Ring buffer.** Holds ~120 frames. Stores DOM frames as diffs.
- **Lazy indexing.** The spatial index for a frame is not built eagerly each frame. It is built on the first spatial
  query against that frame and then cached. Most frames are never queried.
- **Text truncation.** `StyleSnapshot.text` is capped (~120 chars) and the buffer holds rendered UI strings, which in
  this app means authored screenplay content. That content is not a secret, but know it is there before pasting
  `explain()` output elsewhere.
- **Replay.** `dbg.replay(frame)` re-executes recorded ops into a fresh context (canvas sources only). Golden-image
  tests use replay, and replaying a prefix bisects a bad frame.
- **Limits.** `overdraw`, exact z, stacks, and replay work only for canvas sources. DOM frames are sampled, and their z
  is computed rather than observed. These limits follow from source-agnosticism and are not a defect, provided `caps` and
  `fidelity` report them on every frame.

## 13. Testing

This split makes the code testable under the repo's existing jest setup:

- **Query core, `explain()` formatting, geometry, space math** — these are pure functions over a plain `Frame`. They
  are fully unit-testable against synthetic frames and need no browser. These functions are most of the code and all of
  the logic worth asserting on.
- **Canvas adapter** — can be tested headlessly against a stub 2D context, because the stub only needs to record ops.
- **DOM adapter** — jsdom has no layout engine, so every rect comes back zero and the adapter is not testable there.
  Testing it needs real Electron or Playwright. Keep the adapter deliberately thin for that reason, and push every
  non-trivial decision (stacking order, pick resolution) into pure functions that take computed-style records as data.

That last point is the strongest argument for making the stacking-order walk a pure function over a plain tree of style
snapshots rather than an `Element`-crawling method. The walk is the part most likely to be subtly wrong, and only tests
can verify that it is correct.

## 14. Suggested first slice

Roughly in dependency order:

1. `Fragment`, `Frame`, `SpaceRegistry`, `FrameSource`, `SourceCaps`, `PickSnapshot`.
2. 2. **DOM adapter, minimal**: bounds, stacking-order z (retaining culprits), `pick.mode`, attribution, and an
   `elementsFromPoint` oracle. v1 has no shapes, stacks, commits, or continuous capture.
3. Query engine: `at`, `inAABB`, `byOwner`, `byTag`, `bySource`, `where`, `owners`.
4. 4. `explainPick()`, `explain()`, and `table()` deliver the payoff, and they are why step 2 retained culprits.
5. 5. Expose `window.__vnDebug` via preload, then validate against the running app with chrome-devtools-mcp.
6. 6. The canvas adapter provides a context proxy, `dbg.scope`, emission-order z, and real-index-backed pick.
7. Ring buffer + `pin()`.

Ordering DOM before canvas inverts the obvious order deliberately, for two reasons. The canvas editor does not exist yet,
while `Runner.tsx` and `Floor.tsx` do, so DOM-first is the only path to using the IR on real content in the near term.
DOM is also the harsher constraint (sampled, approximate z, fragmenting geometry, no stacks), so designing the IR against
it first prevents a canvas-shaped IR that the DOM adapter then has to be bent into. Canvas will fit into an IR built for
DOM, but an IR built for canvas will not fit the DOM.

Time travel (`diff`, `when`, `history`), commits with `whyInvalidated`, invariants with auto-pin, the diagnostic queries,
and the graph domain layer are all added afterwards without changing the IR.

## 15. Where it lives

It should almost certainly be its own package (`@vn/debug2d` or similar), with the query core dependency-free and each
adapter an optional entry point. It sits outside the pipeline layering graph entirely. Nothing in `packages/` should
import it, and it should import nothing from `packages/`. An explicit `eslint-plugin-boundaries` element type should
state both constraints, so that the isolation is enforced rather than merely intended. A debug layer that accretes
production dependencies is no longer safe to strip from a build.

## Open questions

- **Event attribution.** Tying an input event to the fragment that handled it (not merely the one under the cursor)
  needs cooperation from the app's dispatch layer. `explainPick` reports what should have been hit; only the dispatcher
  can report what actually ran, and whether a listener stopped propagation. A `dbg.dispatched(evt, ownerId)` hook the app
  calls is the likely shape, but the contract is unclear, and event attribution is the one place the design cannot stay
  app-agnostic.
- **Animation.** A fragment mid-CSS-transition has a sampled bound that holds for one instant only. One open question
  is whether the IR should carry `animating: boolean` alongside a target bound. Without it, `when()` and `diff()` over
  animated content produce noise that looks like bugs.
- **Retained-mode canvas.** The context-proxy design assumes immediate-mode drawing. If the node editor ends up
  retained (a scene graph that damages and redraws regions), the emission index `z` stops being meaningful for unredrawn
  regions, and the adapter needs to merge a recorded partial frame into a retained model. Decide this before building the
  canvas adapter.
- **Multi-window.** The desktop app has one window today. If it gains a second window, `device` no longer names a
  single root space.

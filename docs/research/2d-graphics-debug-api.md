# A source-agnostic 2D graphics debugging API

_Status: exploratory design. Nothing here is implemented._

A debugging layer for complex 2D UIs — the desktop app's rooms today, a node-based story
editor later. The premise is that the hard part of UI debugging is not drawing overlays; it
is **answering questions about what was drawn, by whom, in what order, and when it changed**.
So this is designed as a query engine over a recorded frame log, with visual overlays as one
of several views onto a query result.

The second premise: the UI is a mix of DOM/React chrome and our own canvas rendering, and the
worst bugs live exactly at that boundary. So the system must be **agnostic to who drew a
thing**. A neutral intermediate representation sits between capture and query:

```
CanvasRecorder ┐
DomSampler     ├─→  Frame { fragments[], spaces, caps }  ─→  query engine ─→ views
SvgSampler     │                                                              (overlay / table / text)
SceneGraph     ┘
```

Everything above the IR — queries, time travel, `explain()`, invariants — is written once and
never learns which source it is looking at.

The third premise, which shapes more of the design than it first appears: **the question you
arrive with is almost never "what is at this point."** It is "why did my click miss," "why is
this on top," "why did this move," "why did this re-render." Spatial queries are the substrate;
the causal `explain()` family in §6 is the product.

## 1. The IR

### Fragment

The unit of the IR is a **visual fragment**: one contiguous mark on screen with attribution.
A canvas `fillRect` is one fragment; so is a DOM element's background box; so is each line box
of a wrapped inline `<span>`.

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

`raw` is deliberate. The IR should be *sufficient* for querying, not lossless; when you need
the actual `HTMLElement` or the original draw op, take the typed escape hatch rather than
growing the IR.

`ClipRef` carries `by` because "this is clipped away" is a much weaker answer than "this is
clipped away **by `.rail`**". Every field the IR can attribute, it should.

### Paint is not pick

A fragment models a mark on screen, but the most common bug is about *interaction*, and paint
order and hit-test order are not the same relation. `pointer-events`, hit slop, `opacity: 0`
(invisible but still clickable — a genuine and frequent bug), and SVG's `pointer-events`
variants all pull the two apart. So hit-testability is a first-class part of the IR, not an
inference from `style`:

```ts
type PickSnapshot = {
  mode: 'auto' | 'none' | 'bounds' | 'painted';
  slop?: number;              // extra hit radius, in `space` — wires and handles need it
  shape?: Shape;              // when the hit geometry differs from the drawn geometry
};
```

When `pick.shape` is present it is the authority for `dbg.at()`; `shape` remains the authority
for what you see. Keeping both lets `mismatch()` (§5) diff them, which is the single highest-
value invariant in a node editor: *the thing you click is not the thing you see.*

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

`fidelity` is load-bearing. A canvas frame is *recorded* — the fragments are exactly what was
drawn. A DOM frame is *sampled* — it is a snapshot of retained state at a moment, and anything
that changed and changed back between samples is invisible. Never let a consumer forget which
one they are holding.

### Spaces

Every rect carries the space it is expressed in, and conversion is explicit and automatic —
never implicit. Silent coordinate-space confusion otherwise eats days.

```ts
type SpaceId = 'device' | 'css' | `world:${string}`;

interface SpaceRegistry {
  transform(from: SpaceId, to: SpaceId): Mat3 | null;
  convert(r: Rect, from: SpaceId, to: SpaceId): Rect;
  chain(from: SpaceId, to: SpaceId): TransformStep[];   // labeled, for explainTransform
}

type TransformStep = { label: string; matrix: Mat3; by?: FragId };
```

`device` is the common root; every source registers its transform chain into it. The node
editor registers `world:graph` from its pan/zoom matrix, so `dbg.inAABB(r, {space:'world:graph'})`
is expressible directly in graph coordinates.

`chain()` exists so the registry can *narrate* a conversion, not merely perform it — see
`explainTransform` in §6. The classic double-applied DPI scale is invisible in a composed
matrix and obvious in a labeled chain.

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

Push vs. pull is the first real asymmetry between backends. Canvas is push: fragments fall out
of drawing for free, every frame. DOM is pull: nothing is emitted, you walk the tree and read
boxes. The source owns its capture strategy; the recorder only asks for "the frame at time t."

### Capabilities, not lowest-common-denominator

The abstraction stays honest by declaring what each source can actually do, rather than
degrading the IR to what the weakest backend supports.

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

A query the source cannot answer returns `{ unsupported: [SourceId] }` — it does not return
zeros. Silently-wrong debug tooling is worse than none.

## 3. Adapters

### Canvas / scene graph

Highest fidelity, cheapest. Proxy the 2D context so every real draw call is recorded with
attribution; `z` is the emission index. Attribution comes from an explicit scope wrapper
around widget draw code:

```ts
dbg.scope('node:b1/port-in', ['port'], () => { ctx.fillRect(…); });
```

Because it wraps *real* drawing, there is no parallel debug-draw system to keep in sync — the
single most common failure mode of hand-rolled debug layers.

The same rule should hold on the pick side, where — unlike the DOM — we control the hit tester:
**the canvas adapter's pick fragments must come from the editor's real spatial index**, not
from a second traversal written for the debugger. Otherwise `mismatch()` reports a permanent
background hum of adapter drift instead of real bugs, and gets ignored. Concretely: the index
emits `pick.shape`/`pick.slop` as it is populated, the same way `dbg.scope` emits draw geometry.

### DOM

The hard adapter, and the one that earns the most.

- **Geometry** — `getBoundingClientRect()`, plus `getClientRects()` for inline elements that
  fragment across line boxes. One element legitimately becomes several fragments, which is why
  `Shape` includes `rects[]`.
- **Z** — paint order is **not** `z-index`. Walk stacking contexts (established by `z-index` on
  positioned elements, `opacity < 1`, `transform`, `filter`, `will-change`, `isolation`,
  `contain`, `backdrop-filter`), then apply CSS 2.1 painting order within each: backgrounds →
  negative z → block-level → floats → inline → `z:0`/`auto` → positive z. Implement it once,
  honestly, and set `exactZ: false`. Roughly 150 lines, and the single most valuable thing this
  adapter does — nobody can answer "what paints on top here" by inspection.

  Crucially, **retain the culprit**: when the walk finds an element whose `z-index` was scoped
  by an ancestor that established a context, record that ancestor. That fact is what §6 prints,
  and it is free here and unrecoverable later.
- **Pick + oracle** — `pick.mode` from computed `pointer-events`. Then cross-check the computed
  stack against `document.elementsFromPoint()`, which is the browser's *actual* hit order,
  obtained for free. Set `hitOracle: true`. A disagreement between the two is always
  interesting: it is either a bug in our 150 lines of stacking-order code or a genuine UI bug,
  and `explainPick` should say which it cannot distinguish rather than pick a side silently.
- **Attribution** — a pluggable resolver chain: `data-dbg-id` attribute → React fiber
  (`_debugOwner` / `elementType` name, and `_debugSource` for `file:line` when the JSX source
  transform is on, as it is in Vite dev) → tag + class path. The fiber walk is a dev-only,
  React-version-fragile *fallback*, never the primary path; apps should be able to override the
  chain outright, and it must degrade to `unknown` rather than throw.
- **Commits** — subscribe to React commits via `<Profiler onRender>` wrapping each room, and
  attach a `CommitRecord[]` to the frame. This is what makes `whyInvalidated` (§6) possible, and
  it is the difference between `diff` telling you *that* 400 nodes moved and telling you *which
  prop change* moved them:

  ```ts
  type CommitRecord = {
    owner: string;            // Profiler id / component name
    phase: 'mount' | 'update' | 'nested-update';
    actualDuration: number;
    changed?: string[];       // dev-only prop/state keys that differed, incl. identity-only
  };
  ```

  `changed` should distinguish *identity changed, value equal* — the new-array-same-contents
  re-render is the most common React performance bug and is invisible to a value diff.
- **Cost** — batch all geometry reads in a single pass and never interleave them with writes
  (each interleave forces layout). Do not sample every frame: coalesce a `MutationObserver` into
  a rAF, and prefer aligning samples to React commits over bare rAF where both are available.
  Store DOM frames as diffs against the previous one, or the ring buffer becomes enormous.
- **Self-exclusion** — the adapter must skip its own overlay subtree (`[data-dbg-overlay]`) and
  any element it injected. A debugger that captures its own highlight rectangles produces
  results that change when you look at them.

### SVG

Sits between the two: real paths (`caps.paths: true`), DOM-ish z (document order plus
`paint-order`), moderate cost. Mostly a variant of the DOM adapter, with the extra wrinkle that
SVG `pointer-events` has its own vocabulary (`visiblePainted`, `boundingBox`, …) that maps onto
`PickSnapshot.mode` rather than onto CSS's two values.

## 4. Composite frames

A multiplexing recorder is what makes the DOM/canvas boundary debuggable:

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

Two mechanisms make it work:

1. **Splicing.** The canvas element is one DOM fragment at some z. Its canvas-source fragments
   splice into the global order at that slot — so one `dbg.at(x, y)` walks from the DOM tooltip,
   down through canvas contents, out to the page background, as a single z-ordered stack.
2. **Space registry.** All sources register transforms into `device`, so a query in any space
   resolves against fragments from every source.

Splicing is also where the highest-value cross-boundary answer comes from: *"is my click being
eaten by a transparent DOM overlay, or is my canvas hit-test wrong?"* — a question that no
single-source tool can even represent.

## 5. Query vocabulary

Chainable and lazy, jQuery-style — the design constraint is that it must be pleasant to type
into a console at 2am.

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

`using: 'paint' | 'pick'` (default `'pick'` for `at`, `'paint'` elsewhere) selects which
geometry the query tests against. Defaulting `at` to pick geometry means the console answer
matches what a click would do, which is what you meant.

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

`mismatch` deserves special mention: run the visual geometry and the hit-test geometry as two
tagged fragment streams over the same engine, and diff them. In every node editor, the top bug
class is "the thing you click is not the thing you see," and it is invisible until both are
drawn.

**Result ordering is part of the contract.** Every query returns a deterministically sorted set
(z descending, then `FragId`), because these results are going into golden tests (§8) and a set
that reorders between runs is a set nobody will assert on.

## 6. Explaining — the causal layer

Everything above answers *what*. This answers *why*, and it is the reason to build the rest.
Each of these is derivable from data the adapters already compute; the only design work is
refusing to throw it away.

### `explainPick(x, y)` — an ordered rejection log

Not an inventory of what is under the point: a ranked account of why each candidate **lost**.

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

The stacking-context line is the flagship output. It is mechanically derivable from the walk in
§3, it is the single most-lost hour in CSS debugging, and no existing tool prints it.

The `⚠` line matters as much: where the computed order and the browser oracle disagree, say so
rather than choosing. An honest "I don't know which of us is wrong" is actionable; a confident
wrong answer is not.

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

`whyInvalidated` is the one I would want most in a node editor, and it is why `CommitRecord`
is in the IR rather than in the open-questions list:

```
whyInvalidated(node:b1)  frame 812
  commit  GraphCanvas  update  4.2ms
    changed: nodes  (identity changed, value equal — new array, same contents)
    changed: selection
  → 400 owners re-rendered; 398 had unchanged bounds and style
```

That last line — *how much of the commit was wasted* — is a query result, not a new mechanism:
it is `diff(prev, cur)` filtered by the commit's owner subtree.

## 7. Time

```ts
dbg.frame(-3)                  // relative to now
dbg.frames(-60, 0)
dbg.diff(a, b)                 // added / removed / moved / restyled, keyed by (owner, tag, kind)
dbg.history(ownerId)           // one node's bounds + style across the window
dbg.when(pred)                 // first frame where a predicate became true
dbg.pin()                      // freeze the ring buffer
```

`dbg.when(f => f.byTag('wire').overlapping().length > 0)` — "find the frame the wires started
crossing" — is the highest-value query here and the one no existing tool offers. Pair it with
**auto-pin**: a ring buffer that freezes itself the moment a registered invariant trips, so the
evidence survives past the symptom. Retroactive capture is what makes a ring buffer worth
paying for; without it you are always one repro away from the frame you needed.

Caveat: over sampled (DOM) history, `when` has sampling gaps by construction. `frame.fidelity`
is how a consumer knows.

## 8. Invariants

Once queries exist, assertions are nearly free — and they convert one-off debugging into
permanent regression tests. Because the query layer is pure over a plain `Frame`, the *same*
predicate runs live in dev and headless in tests against a synthetic frame.

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

On failure: pin the buffer, log the `explain()`, optionally throw or screenshot.

## 9. Views

Three consumers, three renderings of one result set.

- **Overlay** — `dbg.show(result)` highlights the set live; `dbg.isolate(result)` dims
  everything else; hover for a fragment card. Overdraw as a heatmap, invalid rects as flashing
  outlines. Rendered into a `[data-dbg-overlay]` portal with `pointer-events: none`, excluded
  from capture per §3.
- **Table** — `result.table()`: owner, source, bounds, tags, z.
- **Text** — `result.explain()`, a compact ASCII stack. First-class, not an afterthought: it is
  what makes the debugger usable over a text channel, by a human reading logs or by an agent
  debugging the editor without screenshots. Floats are canonicalized (fixed precision) and
  ordering is deterministic, so `explain()` output is diffable and can itself be a golden.

```
at(412, 88) css → 5 fragments, top-first
  dom     #t9   box     Tooltip/frame        404,72 180x40   z=[ctx:overlay,+10]  α0.98
  canvas  #218  stroke  wire:a3→b1           380,84 44x9     z=218                #6aa 1.5px
  canvas  #101  fill    node:b1/port-in      404,80 16x16    z=101                #333
  dom     #c1   box     canvas#graph-canvas  0,64 1920x1016  z=[ctx:root,0]       ← canvas splice
  dom     #r0   box     div.app              0,0 1920x1080   z=[ctx:root,auto]
```

## 10. Node-editor domain layer

Generic geometry does not know what a graph is, so a thin domain layer sits on top:

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

The last two are zoom-specific and easy to get wrong in both directions: hit slop must scale in
*screen* space while geometry scales in *world* space, and a hairline that is correct at 100%
is a smear at 150%.

## 11. Access paths

The text view only pays off if something can reach it. Three surfaces, cheapest first:

1. **`window.__vnDebug`** — the console surface, and also the agent surface. Exposed through
   `contextBridge` in `apps/desktop/src/preload/` so it survives context isolation. Dev-only.
2. **chrome-devtools-mcp `evaluate_script`** — reaches surface 1 in a running renderer with
   zero additional plumbing. This is how the design gets validated against the real app before
   any IPC work.
3. **A `debug:query` IPC channel** — declared alongside `story:play` in
   `apps/desktop/src/shared/ipc.ts`, so the main process (and therefore the CLI, and therefore
   an agent or a test harness) can query the live renderer and get JSON back. Queries arrive as
   a serializable descriptor, not a function, so the channel stays a data boundary.

Surface 3 is the one that changes how debugging feels: an agent inspecting `explainPick` output
is reasoning from ground truth instead of from a screenshot.

## 12. Pragmatics

- **Tiers.** `off | bounds | full | full+stacks`, switchable at runtime. Recording bounds and
  style is cheap; retaining paths and capturing stacks is not. Gate `full` behind a dev flag.
- **Ring buffer.** ~120 frames. DOM frames stored as diffs.
- **Lazy indexing.** Do not build a spatial index per frame eagerly — build on the first spatial
  query against that frame and cache it. Most frames are never queried.
- **Text truncation.** `StyleSnapshot.text` is capped (~120 chars) and the buffer holds
  rendered UI strings, which in this app means authored screenplay content. Not a secret, but
  worth knowing before `explain()` output is pasted anywhere.
- **Replay.** `dbg.replay(frame)` re-executes recorded ops into a fresh context (canvas sources
  only). Enables golden-image tests and bisecting a bad frame by replaying a prefix.
- **Honest limits.** `overdraw`, exact z, stacks, and replay are canvas-only; DOM frames are
  sampled and their z is computed, not observed. This is inherent to source-agnosticism, not a
  defect — provided `caps` and `fidelity` say so on every frame.

## 13. Testing

The split that makes this testable under the repo's existing jest setup:

- **Query core, `explain()` formatting, geometry, space math** — pure functions over a plain
  `Frame`. Fully unit-testable against synthetic frames, no browser. This is most of the code
  and all of the logic worth asserting on.
- **Canvas adapter** — testable headlessly against a stub 2D context, since it only needs to
  record ops.
- **DOM adapter** — **not** testable under jsdom, which has no layout engine: every rect comes
  back zero. Needs real Electron or Playwright. Keep the adapter deliberately thin for that
  reason, and push every non-trivial decision (stacking order, pick resolution) into pure
  functions that take computed-style records as data.

That last point is the strongest argument for the stacking-order walk being a pure function
over a plain tree of style snapshots rather than an `Element`-crawling method: it is the part
most likely to be subtly wrong, and it is the part that only tests can keep honest.

## 14. Suggested first slice

Roughly in dependency order:

1. `Fragment`, `Frame`, `SpaceRegistry`, `FrameSource`, `SourceCaps`, `PickSnapshot`.
2. **DOM adapter, minimal**: bounds + stacking-order z (retaining culprits) + `pick.mode` +
   attribution + `elementsFromPoint` oracle. **No** shapes, stacks, commits, or continuous
   capture at v1.
3. Query engine: `at`, `inAABB`, `byOwner`, `byTag`, `bySource`, `where`, `owners`.
4. `explainPick()`, `explain()`, `table()` — the payoff, and the reason step 2 retained culprits.
5. `window.__vnDebug` via preload; validate against the running app with chrome-devtools-mcp.
6. Canvas adapter: context proxy, `dbg.scope`, emission-order z, real-index-backed pick.
7. Ring buffer + `pin()`.

**DOM before canvas** is a deliberate inversion of the obvious order. Two reasons. The canvas
editor does not exist yet, while `Runner.tsx` and `Floor.tsx` do — DOM-first is the only path to
using this on real content in the near term. And DOM is the harsher constraint (sampled,
approximate z, fragmenting geometry, no stacks), so designing the IR against it first prevents
a canvas-shaped IR that the DOM adapter then has to be bent into. Canvas will fit into an IR
built for DOM; the reverse is not true.

Time travel (`diff`, `when`, `history`), commits + `whyInvalidated`, invariants with auto-pin,
the diagnostic queries, and the graph domain layer all stack on afterwards without revisiting
the IR.

## 15. Where it lives

Almost certainly its own package (`@vn/debug2d` or similar), with the query core dependency-free
and each adapter an optional entry point. It sits outside the pipeline layering graph entirely —
nothing in `packages/` should import it, and it should import nothing from `packages/`. Worth an
explicit `eslint-plugin-boundaries` element type saying exactly that, so the isolation is
enforced rather than merely intended: a debug layer that accretes production dependencies stops
being safe to strip from a build.

## Open questions

- **Event attribution.** Tying an input event to the fragment that *handled* it (not merely the
  one under the cursor) needs cooperation from the app's dispatch layer. `explainPick` answers
  "what should have been hit"; only the dispatcher knows what actually ran, and whether a
  listener stopped propagation. Probably a `dbg.dispatched(evt, ownerId)` hook the app calls,
  but the contract is unclear and it is the one place the design cannot stay app-agnostic.
- **Animation.** A fragment mid-CSS-transition has a sampled bound true for one instant. Does
  the IR want `animating: boolean` plus a target bound? Without it, `when()` and `diff()` over
  animated content produce noise that looks like bugs.
- **Retained-mode canvas.** The context-proxy design assumes immediate-mode drawing. If the node
  editor ends up retained (a scene graph that damages and redraws regions), `z` as emission
  index stops being meaningful for unredrawn regions, and the adapter needs to merge a recorded
  partial frame into a retained model. Worth deciding before the canvas adapter is built.
- **Multi-window.** The desktop app is single-window today. If it stops being, `device` is no
  longer a single root space.

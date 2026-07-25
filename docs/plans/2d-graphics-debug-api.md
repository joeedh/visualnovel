# 2D graphics debug API — first slice (`@vn/debug2d`)

## Context

[`docs/research/2d-graphics-debug-api.md`](../research/2d-graphics-debug-api.md) designs a
source-agnostic 2D debugging layer for the desktop app: a neutral **fragment IR** captured
from DOM (later canvas/SVG) sources, a **query engine** over recorded frames, and a causal
**`explain()` family** as the actual product — "why did my click miss", "why is this on
top", answered from ground truth instead of screenshots. Status there is "exploratory
design, nothing implemented". This plan implements its §14 **first slice**, in its order,
and sketches everything after it.

Scope of this plan:

- **M0–M5 in detail**: package scaffolding → IR + spaces → minimal DOM adapter → query
  engine → explain layer → `window.__vnDebug` validated against the live app over CDP.
- **M6+ sketched**: canvas adapter, ring buffer, time travel, commits, invariants, overlay,
  IPC surface, graph domain layer. Each stacks on the first slice without revisiting the IR
  (the point of building DOM-first — see research §14's inversion argument).

The renderer today is entirely DOM/React (Vite, `StrictMode`, no canvas, no `Profiler`,
no rAF), so DOM-first is not just the design's preference — it is the only order that
produces a usable tool in the near term. `Runner.tsx` and `Floor.tsx` are the content it
debugs on day one.

**One deviation from the research doc, decided up front.** §11 says `window.__vnDebug` is
"exposed through `contextBridge` in `apps/desktop/src/preload/`". That cannot work here:
the window runs with `contextIsolation: true`, and `contextBridge` deep-clones everything
it exposes — functions lose identity, DOM nodes and React fibers do not survive at all. A
debug layer whose job is holding live references to the renderer's DOM (`Fragment.raw`,
fiber attribution) must be installed by **renderer code onto the renderer's own `window`**.
Nothing is lost: CDP `Runtime.evaluate` and the DevTools console both execute in the page's
main world, so they reach a renderer-installed global exactly as well as a preload one. The
only property given up is "exists before the app mounts", which matters for `window.vn`
(command scripting) and not for a tool that inspects mounted UI.

---

## Deliverables

0. `docs/plans/2d-graphics-debug-api.md` — this plan, kept current as work proceeds.
1. `packages/debug2d` (`@vn/debug2d`) — IR, space registry, DOM adapter, query engine,
   explain layer. **Zero dependencies**, boundaries-isolated (see §1). Unit tested.
2. `apps/desktop/renderer/debug/install.ts` — dev-only renderer glue installing
   `window.__vnDebug`.
3. `scripts/vn-cdp.mjs --raw <expr>` — evaluate an arbitrary expression in the renderer,
   so the debug surface is drivable from a terminal (and by an agent) without DevTools.

---

## 1. `packages/debug2d` — placement and isolation (M0)

New package at `packages/debug2d`, source-only like every other internal package, modelled
on `packages/commands` (the newest): `package.json` + `src/`, no per-package tsconfig, no
dist.

```json
{
  "name": "@vn/debug2d",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Note the empty dependency list. Research §15 wants this package **outside the layering
graph entirely** — it imports nothing from `packages/`, and nothing in `packages/` imports
it. That is stricter than any existing package, and it is the point: a debug layer that
accretes production dependencies stops being safe to strip from a build. Concretely:

- `eslint.config.mjs` `ALLOWED`: add `debug2d: []` — same shape as `types`, which is also
  a no-imports leaf, so there is precedent. Comment it the way the existing entries are:
  sits outside the layering graph; imported only by the desktop renderer; must stay
  strippable.
- `eslint.config.mjs` `boundaries/elements`: add
  `{ type: 'debug2d', pattern: 'packages/debug2d', mode: 'folder' }`.
- Append `'debug2d'` to the `desktop` allow list — the **only** element that may import
  it. The default-disallow rule enforces the reverse direction (nothing else may) with no
  further work.

Consequence worth stating so nobody "fixes" it later: `debug2d: []` means the package may
not import `@vn/util` or `@vn/types`. It defines its own ~50 lines of `Rect`/`Vec2`/`Mat3`
helpers in `src/geom.ts`. That duplication is deliberate — it buys a package that can be
lifted out of this repo (or stripped from a build) without dragging anything along.

One caveat from how the lint is scoped: the boundaries block applies to `packages/**/*.ts`
and `apps/**/*.ts` — not `.tsx`. The renderer glue is therefore a `.ts` file (it is anyway,
see §5), and room components never import `@vn/debug2d` directly; `debug/install.ts` is the
single importer.

### Scaffolding checklist

1. `packages/debug2d/package.json` (above), `src/index.ts`, one smoke test.
2. Root `tsconfig.json` `paths`: `"@vn/debug2d": ["./packages/debug2d/src/index.ts"]`
   (the root `include` glob already covers `packages/*/src/**/*.ts`).
3. `jest.config.cjs`: add `'debug2d'` to `PACKAGES` (the `moduleNameMapper` regex is
   generic; only the array needs the name).
4. `eslint.config.mjs`: the three edits above.
5. `scripts/aliases.mjs` `PACKAGES`: add `'debug2d'`. Not strictly needed until main-process
   code imports it (Vite resolves the workspace link itself), but the file exists so the
   lists can't drift, and the future `debug:query` IPC milestone (§4) will need it.
6. `apps/desktop/package.json` dependencies: `"@vn/debug2d": "workspace:*"` — this is what
   lets Vite resolve the bare specifier from renderer code.
7. `apps/desktop/renderer/tsconfig.json` `paths`:
   `"@vn/debug2d": ["../../../packages/debug2d/src/index.ts"]` (the renderer typechecks
   against its own tsconfig; root `tsgo` never sees it).
8. `pnpm install` to materialize the link.

Acceptance: `pnpm check`, `pnpm test`, `pnpm lint` green with the trivial package in place.

### Package layout (stable across all milestones)

```
packages/debug2d/src/
  index.ts             # public surface
  types.ts             # Fragment, Frame, Shape, StyleSnapshot, PickSnapshot, OwnerRef,
                       #   ClipRef, SourceCaps, FrameSource, SpaceId, TransformStep
  geom.ts              # Rect/Vec2/Mat3 — local, dependency-free
  spaces.ts            # SpaceRegistry: transform / convert / chain
  frame.ts             # frame assembly + makeTestFrame() builder
  query/engine.ts      # createDebugger(), per-frame lazy spatial index
  query/resultset.ts   # chainable ResultSet
  explain/format.ts    # canonical text: fixed precision, deterministic order, table()
  explain/explainPick.ts
  dom/snapshot.ts      # ALL browser reads → plain snapshot tree (thin, not unit-tested)
  dom/stacking.ts      # PURE stacking-context walk → z + culprit retention
  dom/pick.ts          # PURE pointer-events → PickSnapshot
  dom/attribution.ts   # resolver chain: data-dbg-id → fiber → tag/class path
  dom/source.ts        # domSource(): FrameSource + elementsFromPoint oracle + self-exclusion
```

Single `"."` export for now, matching every other package. Research §15's per-adapter
entry points are deferred until the canvas adapter exists and bundle pressure is real —
recorded here as a deliberate deferral, not an oversight.

---

## 2. Milestones M1–M4 — the pure core

### M1 — IR + spaces (research §14.1, §1)

`types.ts` takes the type definitions from research §1 essentially verbatim: `Fragment`
(with `pick: PickSnapshot` first-class — paint is not pick), `Shape`, `StyleSnapshot`,
`OwnerRef`, `ClipRef` (carrying `by:` — *which* ancestor clipped), `Frame` (with
`fidelity: 'recorded' | 'sampled' | 'mixed'` — load-bearing, never let a consumer forget
which they hold), `SourceCaps`, `FrameSource`, `SpaceId`, `TransformStep`.

`spaces.ts` implements the registry:

- `transform(from, to)` composes through the `device` root; returns `null` for an unknown
  space — never a silent identity, which is exactly the coordinate-space confusion this
  exists to kill.
- `chain(from, to)` returns the **labeled step list**, not the composed matrix. This is
  what `explainTransform` prints later; composing it away here would throw out the answer
  ("the classic double-applied DPI scale is invisible in a composed matrix and obvious in
  a labeled chain").

`frame.ts` provides assembly helpers plus `makeTestFrame()` — a synthetic-frame builder
that is deliberately part of the public-ish surface: it is what this package's own tests
use, what M10 invariants will run over headlessly, and what any downstream test would
reach for.

Testable: fully, no browser. Registry composition, `convert` round-trips, chain label
preservation, unknown-space `null`.

### M2 — Minimal DOM adapter (research §14.2, §3-DOM)

The load-bearing design decision, dictated by the testing reality (research §13): **jsdom
has no layout engine** — every rect it returns is zero — and the repo's jest runs in node
anyway. So the adapter splits into a thin impure shell and a pure core:

- `dom/snapshot.ts` does **all** browser API access, in one batched read pass (never
  interleaved with writes): `getBoundingClientRect`, the handful of computed-style fields
  stacking and pick need (`position`, `z-index`, `opacity`, `transform`, `filter`,
  `will-change`, `isolation`, `contain`, `backdrop-filter`, `pointer-events`, `overflow`),
  plus an `elementsFromPoint` capture for the oracle. Output is a plain, serializable
  snapshot tree. This file is intentionally as close to logic-free as possible, because it
  is the part CI cannot test.
- `dom/stacking.ts`, `dom/pick.ts`, and the non-fiber resolvers in `dom/attribution.ts`
  are **pure functions over that snapshot tree**, and that is where all the logic — and
  all the tests — live.

In scope, exactly research §14.2:

- **Bounds** via `getBoundingClientRect` only. No `getClientRects` line boxes, no shapes.
- **Stacking-order z with culprit retention.** The ~150-line honest implementation:
  identify stacking contexts (positioned `z-index`, `opacity < 1`, `transform`, `filter`,
  `will-change`, `isolation`, `contain`, `backdrop-filter`), apply CSS 2.1 paint order
  within each. `exactZ: false`, always. Crucially, when an element's `z-index` is scoped
  by an ancestor that established a context, **record that ancestor on the fragment** —
  it is the fact `explainPick` prints in M4, it is free during the walk, and it is
  unrecoverable afterwards.
- **`pick.mode`** from computed `pointer-events`.
- **Attribution** resolver chain: `data-dbg-id` attribute → React fiber
  (`_debugOwner`/`elementType`; dev-only, version-fragile, must degrade to `unknown`
  rather than throw) → tag + class path.
- **Oracle**: store the `elementsFromPoint` result on the frame; `hitOracle: true`. A
  disagreement between our computed order and the browser's actual hit order is always
  interesting and is *surfaced*, never resolved silently (M4).
- **Self-exclusion**: skip `[data-dbg-overlay]` subtrees. No overlay exists yet (M11), but
  the filter is baked in now so the invariant "the debugger never captures itself" is
  never retrofitted.

Out of scope at v1 (per §14.2): shapes, capture stacks, React commits, continuous capture,
`MutationObserver`, diff storage. Capture is pull-only, on demand. Frames are
`fidelity: 'sampled'`, `caps: { exactZ: false, paths: false, hitOracle: true,
continuous: false, … }`.

Acceptance: unit tests over synthetic snapshot trees prove — among the ordinary cases —
the flagship one: an element with `z-index: 999` inside an ancestor with `transform` ranks
*below* a low-z sibling of that ancestor, **and** the fragment carries the culprit
ancestor. Plus: negative z, opacity-established contexts, `pointer-events: none`
propagation, attribution degradation to `unknown`.

### M3 — Query engine (research §14.3, §5 subset)

`createDebugger({ sources, spaces })` plus the chainable `ResultSet`. First-slice
vocabulary only:

```ts
dbg.at(x, y, { space?, using? })   // using: 'paint' | 'pick', default 'pick' for at
dbg.inAABB(rect, { mode? })        // 'intersect' | 'contain' | 'center'
dbg.byOwner(id) (+ .descendants())
dbg.byTag(tag)
dbg.bySource(id)
dbg.where(pred)
dbg.owners()
```

Contract points, stated here because tests pin them:

- **Deterministic ordering**: z descending, then `FragId`. Golden tests (M4) and future
  invariants depend on a set that never reorders between runs.
- `at` defaults to **pick geometry**, so the console answer matches what a click would do.
- A query a source cannot answer returns `{ unsupported: [SourceId] }` — never zeros.
- **Lazy indexing** (research §12): no spatial index is built until the first spatial query
  against a frame, then cached. At first-slice fragment counts a sorted scan is fine — the
  laziness seam matters more than the index structure behind it.

Testable: fully pure over `makeTestFrame()` frames. This milestone is most of the suite:
chainability, ordering determinism asserted explicitly, pick-vs-paint divergence (an
`alpha: 0, pick: 'auto'` fragment tops `at()` but is flagged invisible-but-clickable).

### M4 — Explain layer (research §14.4, §6, §9-text)

The payoff, and the reason M2 retained culprits.

- **`explainPick(x, y)`** — an ordered rejection log, not an inventory: the winner, then
  why each candidate **lost**. Rejection vocabulary at v1: below winner /
  `pick: 'none'` / clipped away by `<culprit>` / alpha 0 but still clickable (⚠) / culled
  — and the flagship line, mechanically derived from M2's retained culprit:
  *"z-index 999 ignored — `<ancestor>` established a stacking context via `transform`"*.
  When the computed stack and the `elementsFromPoint` oracle disagree, a `⚠` line says so
  and explicitly refuses to pick a side — an honest "one of us is wrong" is actionable; a
  confident wrong answer is not.
- **`result.explain()`** — the compact ASCII stack of research §9. First-class, not an
  afterthought: it is what makes the debugger usable over a text channel, by a human or an
  agent.
- **`result.table()`** — owner, source, bounds, tags, z as plain data.

`explain/format.ts` canonicalizes floats to fixed precision and inherits M3's
deterministic ordering, so **explain output is diffable and is itself a golden**. The M4
tests are golden strings: a synthetic frame reproducing the research §6 scenario, with the
full `explainPick` text asserted verbatim. Format changes require golden edits — that
friction is intended; the format is the product.

---

## 3. M5 — Console surface + live validation (research §14.5, §11 surfaces 1–2)

All in the app, not the package:

- **`apps/desktop/renderer/debug/install.ts`** — `installDebug(): () => void`. Constructs
  `createDebugger({ sources: [domSource(document)], spaces: {} })`, assigns
  `window.__vnDebug`, returns a teardown. Idempotent — re-install tears down the previous
  instance first — as cheap insurance against Vite HMR re-executing the module.
  (`StrictMode` is not a hazard here: it double-invokes effects, and this runs at module
  scope from `main.tsx`, not inside a component.)
- **`apps/desktop/renderer/main.tsx`** — dev gating:

  ```ts
  if (import.meta.env.DEV) {
    void import('./debug/install').then((m) => m.installDebug());
  }
  ```

  A dynamic import behind `import.meta.env.DEV` is statically false in `vite build`, so
  the entire package is dropped from the production bundle — no env-var plumbing, and the
  strippability promise from §1 is enforced by the bundler rather than by discipline.
- **`apps/desktop/renderer/global.d.ts`** — add `__vnDebug?: VnDebug` to the existing
  `Window` augmentation, alongside `api?`/`vn?`.
- **`scripts/vn-cdp.mjs`** — add a `--raw <expr>` flag that evaluates the expression
  directly instead of wrapping it in `window.vn.exec(...)` (a small branch in the existing
  expression table). Then
  `node scripts/vn-cdp.mjs --raw "window.__vnDebug.at(400,300).explain()"` works from any
  terminal against the dev loop, which already always opens CDP on 9222.

**CDP serialization boundary**, worth one paragraph because every remote caller hits it:
`Runtime.evaluate` runs with `returnByValue: true`, so only JSON crosses the wire. The
`raw` escape hatches (live `Element`s, fibers) and `ResultSet` objects do not — a remote
expression must end in `.explain()` / `.table()` / some other plain-data projection. In
DevTools proper, the live objects are available as usual.

### Live validation script

With `pnpm --filter @vn/desktop dev` running and a room open (FLOOR has the densest UI),
via chrome-devtools-mcp `evaluate_script` or `vn-cdp --raw`:

1. **Capture sanity** — a capture returns a frame with a plausible fragment count,
   `fidelity: 'sampled'`, and no `[data-dbg-overlay]` or debug-injected fragments.
2. **`at()` attribution** — a point over a known element (the topbar, a task card) returns
   it top-of-stack with sensible attribution (component name or tag/class path).
3. **`explainPick` under an overlay** — open the gate dialog (`GateOverlay`), query a point
   under the scrim: the log ranks the scrim above the occluded content and each rejection
   line carries a reason.
4. **Oracle agreement** — on the same points, the computed order and `elementsFromPoint`
   agree; any disagreement prints the `⚠` line rather than being hidden.

Acceptance additionally includes: `pnpm build:desktop`, then confirm the production
renderer bundle in `apps/desktop/dist/renderer` contains no `debug2d` code.

---

## 4. Future phases (M6+) — sketched

Each stacks on the first slice without IR changes. Listed for orientation, not committed
to in this plan.

- **M6 — Canvas adapter** (§3-canvas, §4): 2D-context proxy, `dbg.scope()` attribution,
  emission-order z (`exactZ: true`), pick fragments emitted by the editor's **real**
  spatial index (never a parallel traversal — otherwise `mismatch()` reports permanent
  adapter drift and gets ignored), and splicing canvas fragments into the DOM frame at the
  canvas element's z slot. Blocked on the node editor existing. Carries the
  **retained-mode canvas** open question — decide before building, since z-as-emission-index
  breaks under damage-rect redraw.
- **M7 — Ring buffer + `pin()`** (§7, §12): ~120 frames, DOM frames stored as diffs,
  auto-pin when an invariant trips so evidence survives past the symptom.
- **M8 — Time travel** (§7): `frame(-n)`, `diff(a, b)`, `history(owner)`, `when(pred)` —
  with the sampled-history caveat surfaced through `fidelity`, not hidden.
- **M9 — Commits + `whyInvalidated`** (§3-commits, §6): `<Profiler onRender>` wrapping
  each room; `CommitRecord.changed` distinguishing *identity changed, value equal*. This
  is where **`StrictMode` double-rendering becomes a real problem** (phantom dev commits)
  — carried as an open question: filter, annotate, or accept the noise.
- **M10 — Invariants + auto-pin** (§8): the same predicates run live in dev and headless
  in jest over `makeTestFrame()` frames.
- **M11 — Overlay view** (§9): `[data-dbg-overlay]` portal, `pointer-events: none`,
  already self-excluded by the M2 filter. A toggle keybinding must dodge the existing
  handlers: `App.tsx` owns Shift-Tab / `/` / Escape; `Runner.tsx` owns Space/Enter/arrows.
- **M12 — `debug:query` IPC** (§11 surface 3): channel declared in
  `apps/desktop/src/shared/ipc.ts`. Note the app currently has renderer→main invoke and
  main→renderer push only — a main-initiated query needs new request/response plumbing
  (likely `webContents.send` with a correlation id answered over an invoke channel).
  Queries travel as serializable descriptors, never functions.
- **M13 — Graph domain layer** (§10): `wiresCrossing`, `snapCandidates`, `hairline`, …
  stacks on the canvas adapter.

Open questions carried from the research doc, unchanged: event attribution
(`dbg.dispatched` needs the app's dispatch layer to cooperate), animation (sampled bounds
mid-transition read as noise to `when()`/`diff()`), multi-window (breaks `device` as a
single root).

---

## 5. Testing strategy

- **Pure jest, node env** — `geom`, `spaces`, `frame`, `query/*`, `explain/*`,
  `dom/stacking`, `dom/pick`, `dom/attribution` (non-fiber resolvers). Per research §13
  this is most of the code and all of the logic worth asserting on. Colocated
  `src/**/*.test.ts`, inline fakes, no fixtures — house style.
- **Golden-output tests** for `explainPick` / `explain()` / `table()` strings (M4). Viable
  only because of the M3 ordering contract and fixed-precision floats — that is why both
  are stated as contracts, not implementation details.
- **`dom/snapshot.ts` and `dom/source.ts` are intentionally untested in CI.** jsdom has no
  layout engine, so there is nothing honest to assert. The mitigation is structural: keep
  those files thin enough that the untestable surface is trivial, and cover them with the
  M5 live validation script. A Playwright/Electron harness is explicitly **out of scope**
  for the first slice — revisit only if live validation keeps finding snapshot bugs.

---

## Files touched

**New**

- `packages/debug2d/` — `package.json`, `src/` per the layout in §1, `*.test.ts` throughout
- `apps/desktop/renderer/debug/install.ts`
- `docs/plans/2d-graphics-debug-api.md` — this plan

**Modified**

- `eslint.config.mjs` — `debug2d: []` in `ALLOWED`, `debug2d` element, `desktop` allow list
- `jest.config.cjs` — `'debug2d'` in `PACKAGES`
- `tsconfig.json` — `@vn/debug2d` paths entry
- `scripts/aliases.mjs` — `'debug2d'` in `PACKAGES`
- `apps/desktop/package.json` — `@vn/debug2d` workspace dep
- `apps/desktop/renderer/tsconfig.json` — `@vn/debug2d` paths entry
- `apps/desktop/renderer/main.tsx` — dev-gated dynamic import
- `apps/desktop/renderer/global.d.ts` — `__vnDebug` on `Window`
- `scripts/vn-cdp.mjs` — `--raw` flag
- `CLAUDE.md` — new package in the layering notes + a short debug-layer section (at M5)

**Deliberately unchanged:** everything under `packages/` other than the new package
(isolation is the design), `src/preload/index.ts` (see the contextBridge deviation in
Context), `turbo.json` (its `packages/*/src/**` glob already covers the new package).

---

## Verification

1. Per milestone: `pnpm check`, `pnpm exec jest --selectProjects @vn/debug2d`, `pnpm lint`.
2. **Prove the isolation rule actually fires** (once, at M0): temporarily add
   `import '@vn/util'` to `packages/debug2d/src/index.ts`, expect a boundaries error from
   `pnpm lint`, remove it. The command-system plan's history shows why this check is not
   paranoia — the boundaries rule was once silently inert repo-wide.
3. Renderer typecheck after M5's edits: `tsgo --noEmit -p apps/desktop/renderer/tsconfig.json`
   (root `pnpm check` does not cover renderer files).
4. M4 goldens: the stacking-context rejection line and the oracle-disagreement `⚠` line
   each appear verbatim in at least one golden.
5. M5 live validation script (§3) passes all four checks against the real app.
6. Production strippability: `pnpm build:desktop`; no `debug2d` code in the renderer bundle.
7. Per CLAUDE.md § Finishing a plan: comment audit (no `CLAUDENOTE:` left), update
   `CLAUDE.md` and this plan to match what shipped.

---

## Risks / decisions

- **contextBridge deviation** — decided and documented in Context; the research doc's §11
  surface list is otherwise unchanged (console → CDP → IPC, cheapest first).
- **`StrictMode`** — no first-slice impact (module-scope install, pull-based capture).
  Real exposure arrives with M9 commit tracking; carried there.
- **Sampled DOM** — every DOM frame is `fidelity: 'sampled'`; anything that changes and
  reverts between captures is invisible. v1 promises no continuous capture; the fidelity
  field on every frame is the mitigation.
- **Stacking-walk correctness** — the ~150 lines most likely to be subtly wrong.
  Mitigations, all structural: pure function over snapshot data, heavy unit tests, and the
  `elementsFromPoint` oracle with disagreements surfaced (`⚠`) instead of resolved.
- **Isolation cost** — local `geom.ts` duplicates a sliver of `@vn/util`. Accepted price
  for `debug2d: []`; do not "deduplicate" it.
- **CDP serialization** — remote expressions must end in a plain-data projection
  (`.explain()`, `.table()`); live objects never cross `returnByValue`.
- **jsdom coverage gap** — the thin-adapter bet (§5). Revisit with a real-browser harness
  only if live validation keeps finding snapshot bugs.

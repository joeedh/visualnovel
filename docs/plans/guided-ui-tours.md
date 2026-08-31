# Guided UI tours, and the anchor layer under them

Status: **planned**

## What is wanted

An author asks the agent to show them how to change the café's night lighting. Instead of a
paragraph, the app shows a ring over the thing to click, one step at a time, until the act is done.
The agent finds the path; the human clicks.

The path-finding half is nearly free here. The catalog names every command with typed props,
`stack.check` answers whether one would be refused before it runs, and the interaction registry
answers what a gesture would do with the same function the drop calls. What does not exist is the
inverse map — which pixels `asset.regenerate` lives at — and that map is the whole difficulty,
because it is the only part that can be confidently wrong.

So this plan is mostly about anchors. The tour on top is comparatively thin, and is specified more
lightly on purpose: the anchor layer is useful on its own (it is a testable claim about the app's
reachability), and it is the part that must not go stale.

## The rule

> An anchor runs the same invocation it points at. It is never built from a description of that
> invocation.

This is the same rule `@vn/commands` already states for gestures — "the load-bearing rule is that
`targets` is the same function the drop calls, not a description of it" (`interaction.ts`) — and it
is the only version of anchoring that cannot drift. A widget tagged with a command it happens to call
will one day call something else. A widget whose click is wired from the anchor record cannot.

Every section below follows from that rule.

---

# Part I — the anchor layer

## 1. `Action` is already the currency

The renderer's pure rule modules already compute invocations as data before they become clicks:

| Rule | Returns |
| --- | --- |
| `approveAction(info)` (`rules/assetview.ts`) | `{ok: true, id, props, label}` \| `{ok: false, reason}` |
| `promoteAction(info)` | same shape |
| `condenseAction(view)` (`rules/promptview.ts`) | same shape, plus `note` |
| `modeStrip(view)` | segments, each carrying `.action` of that shape |
| `originAction(chunk.origin)` | a navigation action |

Those objects are the anchor payloads. The gap is only that nothing records which node each one was
rendered into.

Not everything goes through a rule yet. `AssetEditor.regenerate()` hardcodes `'asset.regenerate'`;
`showTask()` hardcodes a `view.open`; `chunkActs` builds four `prompt.setChunk` invocations inline.
Growing rules for those is a prerequisite, and has independent value — a rule is unit-testable in
node, which is the desktop package's stated pattern (no jsdom).

Step 1 of the work is therefore an audit: every `exec(...)` call site in
`renderer/pathux/editors/**` either flows from an `Action`, or is classified as programmatic (a read
like `asset.info`, or a `view.open` issued after publishing a selection) and exempted by name.

## 2. The helper

```ts
/** What a surface can be asked to do, as data, before it is a click. */
export interface Action {
  id: string;
  props: Record<string, PropValue>;
}

export type Offer = (Action & { ok: true; label?: string }) | { ok: false; reason: string };

/**
 * Record the anchor and wire the click from one object, so the two cannot disagree.
 * Returns the node so it still reads as a builder call.
 */
export function act<N extends HTMLElement>(node: N, offer: Offer, run: (a: Action) => void): N;
```

`UIBase extends HTMLElement` (`vendor/path.ux/scripts/core/ui_base.ts:1003`), so path.ux widgets and
raw `<button>` elements take the same helper with no adapter — `getBoundingClientRect()` works on
both. That is worth stating because it is the fact the whole overlay rests on.

`AssetEditor.rebuildBar` becomes roughly:

```ts
act(this.bar.button('Approve', () => {}), approveAction(info), (a) => void this.approve(a));
```

with `disabled` and `description` derived from the same `Offer` the anchor recorded — which is what
those lines already do by hand.

## 3. Anchor records

```ts
export interface Anchor {
  /** `cmd:asset.regenerate` or `item:asset/<hash>` — see §4. */
  key: string;
  id: string;                       // the command it runs
  props: Record<string, PropValue>; // with the subject it would run against
  enabled: boolean;
  /** Why it is greyed. The sentence the rule already wrote — never invented here. */
  reason?: string;
  editor: EditorId;
  node: HTMLElement;
}
```

`enabled: false` with a `reason` is recorded as an anchor, not as an absence, and that is strictly
better than "not found": the tour can point at the greyed button and say the app's own refusal
sentence — for example, "this refuses because the asset is suspended" — instead of inventing one.

## 4. Item anchors generalize a convention that exists

`AssetEditor` already ships a miniature of this feature. `openOrigin` follows a `⇱` to
`[data-anchor="request"]` or `[data-rung="<target>"]` and scrolls it into view; cards carry
`data-chunk="<key>"`; rung boxes carry `data-rung="<target>"`. Do not invent a parallel scheme —
generalize this one into a single `data-anchor="<kind>/<key>"` attribute, and keep `data-chunk` /
`data-rung` as the domain-specific readers they already are.

The key must be domain identity — asset hash, scene id, line id, chunk key, rung target — and never
an index, a position, or a label. Indices break on any re-sort, and the doctree's asset labels carry
a `(hash8)` suffix only on collision, so labels are not stable either.

## 5. The registry is generation-scoped

`rebuildBody()` does `this.surface.textContent = ''`; `this.bar.clear()` discards every widget. An
element reference held across a frame is a dangling pointer.

- The registry is cleared and repopulated as part of the same rebuild that draws the widgets, under
  a monotonic generation counter.
- Nothing outside may hold an `Anchor`. The tour re-resolves by key, every frame — `update()` already
  runs every frame, so there is nothing to subscribe to.
- Exposed as `window.__vnAnchors` for CDP and DevTools, alongside `window.vn` and `window.__vnDebug`.
  Unlike `__vnDebug` this one ships in production, because the tour needs it at runtime.

## 6. Resolution is a pure function with seven answers

```ts
export type Resolution =
  | { state: 'ready'; anchor: Anchor }
  | { state: 'disabled'; anchor: Anchor; reason: string }
  | { state: 'offscreen'; anchor: Anchor }        // scroll it in, then re-resolve
  | { state: 'wrong-subject'; anchor: Anchor; needs: Action }  // id matches, props do not
  | { state: 'pane-closed'; editor: EditorId }    // emit a view.open step first
  | { state: 'absent' }                           // declared for this editor, not drawn
  | { state: 'unanchored' };                      // no UI route — fall back to the palette
```

`resolveAnchor(map, live, step) → Resolution` is pure over a snapshot, so it is unit-testable in
node despite the surface being a browser. It lives at `renderer/rules/anchors.ts` with a `tests/`
sibling.

Two of the seven resolutions need more explanation than the table gives.

- `wrong-subject` is the common case. The Regenerate button acts on `ui.assetHash`; the Approve
  button on whatever the pane is showing. If a step wants a different asset, `id` matches and `props`
  do not, and ringing that button would be actively wrong. This resolves into a preceding step
  ("select this in the documents tree"), not into a ring. Given how much of this app takes its
  subject from `ui.*` selection, this is where naive anchoring would break most often.
- `absent` and `unanchored` are different answers, for exactly the reason `Interaction.targets`
  distinguishes an empty target list from `UNRESOLVED`: one is a statement about the screen, the
  other about the map, and the caller needs to know which.

## 7. The pick oracle

A ring drawn at the right rect over the wrong thing is the failure that is hardest to notice, because
it renders exactly like a correct one. Before drawing confidently, check that the point at the ring's
centre actually lands inside the anchored node:

- `elementFromPoint` returns the shadow host, not the inner node, so this needs shadow-piercing.
  `packages/debug2d/src/dom/source.ts` already solved it; the logic can be copied (debug2d itself is
  dev-only and stripped by `vite build`, so it cannot be a dependency).
- On disagreement, report it rather than resolving it silently — the same contract `explainPick`
  uses when the computed stacking order and the browser's `elementsFromPoint` disagree, and it prints
  a `⚠`.

## 8. The map is measured, not declared

Planning happens before any pane is open, so the tour needs to know statically that
`prompt.condense` lives in the `asset` editor. A hand-written table beside `EDITORS` would work and
would be checkable like `editorNameProblems` — but it would need to be kept in sync with the anchor
records by hand, which is exactly the kind of duplication this plan is trying to remove.

Measure it instead. `scripts/sweep-anchors.mjs`, a sibling of `verify-prompt-chunks.mjs`, opens each
of the twelve editors against the seeded sample workspace, dumps `window.__vnAnchors`, and writes
`apps/desktop/dist/anchors.json`. The desktop jest project is node-only and surfaces are verified
live over CDP, so the sweep script does that, and `verify-prompt-chunks.mjs` is the working precedent
for driving the shadow-rooted panes.

Two caveats to build into the sweep:

- The map is conditional. Promote renders only for a `concept`; a `reference` asset shows neither
  Approve nor Regenerate; the chunk acts appear only when `!view.frozen`. A sweep needs fixtures
  covering each branch, and each record should carry the condition it appeared under, so the map
  states its own coverage instead of appearing total.
- Coverage is a number, and it goes in the output — for example, "58 of 73 commands have a UI
  anchor; the rest are palette-only." Keep it as a ratchet so it cannot silently fall.

## 9. Two oracles for one refusal

Once anchors record `enabled`/`reason`, the app has two independent derivations of the same
refusal — the renderer-side rule (`approveAction`) and main's `stack.check(id, props)`. They should
agree. A disagreement is a real bug and should be surfaced, not reconciled. Cheap to check during
the sweep, and it is the kind of drift that otherwise goes unnoticed for months.

## 10. Failure modes and what catches each

| Failure | Caught by |
| --- | --- |
| Anchor names a command the build no longer has | Boot check against the live catalog, like `editorNameProblems` |
| Button rewired, anchor stale | Structurally impossible — one `Action` object feeds both |
| New button added with no anchor | Coverage ratchet on the sweep |
| Right button, wrong subject | `wrong-subject` → emits a selection step |
| Target scrolled out or in a collapsed section | `offscreen` → scroll-into-view, then re-resolve |
| Element recycled mid-tour | Generation-scoped registry; re-resolve by key each frame |
| Ring over the right rect, wrong thing on top | Shadow-aware pick oracle (§7) |
| Renderer rule and `stack.check` disagree | Sweep-time comparison (§9) |

## 11. Enforcement

The ratchet test is the practical guard. A lint rule banning bare `exec(` in
`renderer/pathux/editors/**` outside `act()` would be stronger — the same shape as the
"nothing may import `@vn/testkit`" rule — but it needs an allowlist for genuinely programmatic
calls, so it is deferred until coverage is observed to drift.

## 12. Files

| Path | What |
| --- | --- |
| `apps/desktop/renderer/rules/anchors.ts` | `Action`, `Offer`, `Anchor`, `resolveAnchor`, key helpers. Pure |
| `apps/desktop/renderer/rules/tests/anchors.test.ts` | The seven resolutions, props subsumption, key stability |
| `apps/desktop/renderer/pathux/anchors.ts` | `act()`, the generation-scoped registry, `window.__vnAnchors` |
| `apps/desktop/renderer/pathux/editors/*.ts` | Call sites converted; rules grown where an invocation is inline |
| `apps/desktop/renderer/rules/assetview.ts`, `promptview.ts` | New `Offer`-shaped rules for the inline cases |
| `scripts/sweep-anchors.mjs` | The CDP sweep → `apps/desktop/dist/anchors.json` + coverage |

---

# Part II — the tour (sketch)

This part is deliberately lighter, because the anchor layer is the load-bearing half and the tour
depends on it rather than the other way around.

## Shape

A tour is an ordered list of steps. A step is one of:

- **`command`** — an invocation to be run by hand. Resolved through §6; rings the anchor, or falls
  back to the palette.
- **`select`** — publish a `ui.*` subject by clicking something (`item:` anchor). This is what a
  `wrong-subject` resolution generates.
- **`gesture`** — an interaction id plus a carried token. The interaction registry answers
  `targets(state, carried)` synchronously and purely, so the overlay can ring both the grab handle
  and every accepting target, each with the sentence it would produce. The branch and prompt editors
  already paint exactly this mid-drag; the tour arms it without a pointer down.

## The palette is the guaranteed floor

`openPalette(preselect, overrides)` already accepts prop overrides. So an `unanchored` step still
works: the form comes up prefilled, with the `stack.check` verdict rendered above it, and the ring
goes on the run button. That means the feature works across all 73 commands on day one, and improves
as anchors are added.

## Commands

A `tour` namespace in `apps/desktop/src/main/commands/`, so the agent reaches it through the one
door everything else uses: `tour.start(steps=…)`, `tour.next`, `tour.cancel`, `tour.explain`.
Non-mutating, not undoable, never `commitsItself`.

## Overlay

A `pointer-events: none` layer above the mesh, re-reading rects each frame while a tour is live.
Positions are never precomputed: `view.open` answers optimistically and only the mesh knows how many
panes there are, so `applyView` returns a correction — anchors must be re-resolved after every
navigation step.

## Advancing, and going off-script

Advance on `onExec` seeing the expected id with matching props. Anything else means the user
diverged from the tour, and the response is to re-plan rather than to block them. It is the same
planning that produced the tour, so it is cheap.

## Who authors a tour

- **Curated**, checked into the repo, for the dozen things people actually ask. Deterministic and
  testable.
- **Agent-generated** for the tail, from the catalog + workspace index, with every step validated by
  `stack.check` before it is shown, so a hallucinated invocation is rejected at the boundary — the
  same way `coerceProps` rejects a loose CDP value.

## One rule worth writing down

A tour never performs the step. "Do it for me" is an explicit escape that runs the invocation
through the same command, but the default is that the human clicks. Without that default, the
feature would not be a tutorial; it would perform the action for the user instead of teaching them
to.

---

## Staging

1. **Audit + rules.** Every editor `exec(` site classified; inline invocations grown into `Offer`
   rules. No behaviour change; new unit tests.
2. **`act()` + registry + `resolveAnchor`.** Convert the `asset` editor first — it is the worst case
   (≈20 clickable things, path.ux widgets and raw DOM, most already rule-backed).
3. **Sweep + coverage ratchet.** `sweep-anchors.mjs`, `anchors.json`, the two-oracle comparison. At
   this point the anchor layer stands alone and is worth having on its own.
4. **Remaining eleven editors** converted, coverage ratcheted up.
5. **Tour: three curated tours, palette-route only.** Proves the loop end to end.
6. **Overlay rings on real anchors**, pick oracle, scroll-into-view.
7. **Gesture steps** over the interaction registry.
8. **Agent-generated tours.**

## Decisions still open

- **Where the overlay mounts.** Document-level `<div>` versus a `screen.popup` like the palette.
  Document level is simpler and does not intercept clicks, but must be proven to sit above every
  path.ux stacking context — a `@vn/debug2d` question, answered in dev.
- **Whether `anchors.json` is committed.** Committed makes drift a reviewable diff; generated-only
  keeps it out of the tree. Leaning committed, for the same reason `commands.json` is generated at
  build time and consumed by external tooling.
- **Whether the agent may read `anchors.json` directly**, or only reach it through a `tour.*`
  command. Leaning the latter — one door.

## What this deliberately does not do

- No screenshots and no vision. The app describes itself; reading pixels back would be a second,
  less reliable source of truth.
- No new IPC channel. Everything is a command, as it is for every other desktop action.
- No anchoring of chrome. The header bar is an editor by construction and named in no list, and a
  tour has no reason to point at it.

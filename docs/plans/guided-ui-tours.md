# Guided UI tours, and the anchor layer under them

Status: **planned**

Pressure-tested against the code by
[`../research/pressure-test-guided-ui-tours.md`](../research/pressure-test-guided-ui-tours.md).
Every finding is answered in the section it lands in; [Review](#review) is the index, and
[Staging](#staging) carries the three that moved work earlier.

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

Most sections below follow from that rule. The exception is [§4](#4-two-anchor-flavours-dom-and-pick),
where the rule has to be restated for a surface that has no click to wire, and that exception is the
single largest correction the review produced.

## Review

Where each pressure-test finding landed. A finding is either answered by a change below or recorded
with the reason it does not apply.

| Finding | Answer |
| --- | --- |
| 1. Three editors bypass `bridge.exec`; the tour advances on it | Accepted. `branch.ts` has since been fixed; `script.ts` and `timeline.ts` remain. Now a named prerequisite in [§1](#1-the-audit-and-its-three-seams) and stage 1 |
| 2. Graph editors have no click to wire and no node to hit-test | Accepted, and larger than the review said — the gen graph editor is a third canvas surface. [§4](#4-two-anchor-flavours-dom-and-pick) is new |
| 3. Props are not known when the anchor is recorded | Accepted. `Anchor.supplies` in [§5](#5-anchor-records), the subsumption rule in [§8](#8-resolution-is-a-pure-function-with-seven-answers), and the `input` step kind in [Part II](#shape) |
| 4. Three of the five rules cited are not `Action`-shaped | Accepted. [§1](#1-the-audit-and-its-three-seams)'s table is corrected and says which two have to be re-shaped |
| 5. Menus are transient; `menuFor` is a map the plan missed | Both accepted. [§3](#3-the-doctree-half-of-the-map-is-already-pure) is new; menus become a stated coverage ceiling rather than a scoping aside |
| 6. `@vn/debug2d` has not solved shadow piercing | Overtaken. `ba53aac0` (2026-08-27) gave the snapshot walk shadow descent, so the half the review measured is fixed. The *oracle* still does not pierce, and that distinction — not the original finding — is what [§9](#9-the-pick-oracle) is now built on |
| 7. `anchors.json` cannot be both committed and under `dist/` | Accepted and decided: committed, at the package root. `commands.json` is cited as the contrast it is |
| 8. Smaller corrections | All accepted; counts are now measured rather than written down, and `update()` is slower than the plan assumed by an order of magnitude |

Two of the review's own numbers have since gone stale, and are not repeated here: it counted twelve
editors and ~96 commands. The counts below were measured on 2026-08-31, and [§10](#10-the-map-is-measured-not-declared)
says why the ratchet must not hold one at all.

One finding is not the review's. Reading the plan back against what CI actually runs showed that the
coverage ratchet, as first written, measured itself: the sweep needs an app and is run by hand, so
nothing regenerates the file the check reads. [§13](#13-enforcement) splits it into the half CI can
gate and the half it cannot, and names what still gets through.

---

# Part I — the anchor layer

## 1. The audit, and its three seams

The renderer's pure rule modules already compute some invocations as data before they become clicks.
Three of the five are `Action`-shaped as they stand; two are not, and saying so here is cheaper than
discovering it during the conversion.

| Rule | Returns | Usable as an anchor payload |
| --- | --- | --- |
| `approveAction(info)` (`rules/assetview.ts`) | `{ok: true, id, props, label}` \| `{ok: false, reason}` | yes |
| `condenseAction(view)` (`rules/promptview.ts`) | the same, plus `note` | yes |
| `modeStrip(view)` | segments, each carrying `.action` of `{ok, id, props}` | yes |
| `promoteAction(info)` | `{ok: true, locationId}` | no — `art.promote`'s id and props are assembled at the call site |
| `originAction(chunk.origin)` | `{ok, kind: 'open', editor, subject, publish, label}` \| `{ok, kind: 'scroll', to, label}` | no |

`promoteAction` needs re-shaping and that is routine. `originAction` cannot be re-shaped into one
anchor at all, and it is worth understanding before stage 2 rather than during it. Its `open` variant
is two acts in a load-bearing order: publish the `ui.*` fields, then `view.open`, because the new
pane reads the selection on its first `update()`. That is a `select` step followed by a `command`
step. Its `scroll` variant runs no command. `replaceAction` and `promptEditable` are the same story
— display rules that gate a strip, not invocations.

Not everything goes through a rule yet. `AssetEditor.regenerate()` hardcodes `'asset.regenerate'`;
`showTask()` hardcodes a `view.open`; `chunkActs` builds two `prompt.setChunk` invocations inline
(`mute` and `clear`) plus two buttons that open an editing box and run nothing until it is committed.
Growing rules for those is a prerequisite, and has independent value — a rule is unit-testable in
node, which is the desktop package's stated pattern (no jsdom).

### The audit is scoped to three seams, not one

An editor reaches a command by three routes, and an audit that greps only for `exec(` reports the
two editors that most need attention as clean:

- **`bridge.exec`** — the seam `onExec`, `onInvalidate` and `onWrote` all hang off. Most editors.
- **`api.invoke('command:exec', …)`** — the bypass. `script.ts` and `timeline.ts` still do this,
  three sites between them, and `onExec` never fires for them. `branch.ts` did too and has since
  been routed through the bridge; its comment there is the reason to copy.
- **`openCommandDialog`** — the task graph editor's only route. This one is safe: the dialog hosts
  the same `CommandForm` the palette does, and the form runs through `bridge.exec`.

Routing the remaining three sites through `bridge.exec` is small, and it is a **prerequisite this
plan owns rather than inherits**. Until it is done, Part II's advance mechanism is blind to
`story.setLineText`, `story.moveLine`, `story.setCoverage`, `story.moveShot` and `story.setOutfit` —
most of the story-editing vocabulary, and precisely what a curated tour would teach. It is also a
live defect independent of tours: a `story.*` edit made in the script editor never tells the asset
pane its derived prompt moved.

Step 1 of the work is therefore an audit over all three seams: every call site in
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

`UIBase extends HTMLElement` (`vendor/path.ux/scripts/core/ui_base.ts`), so path.ux widgets and raw
`<button>` elements take the same helper with no adapter — `getBoundingClientRect()` works on both.
That is worth stating because it is the fact the whole DOM-flavoured overlay rests on. It is also
exactly the fact [§4](#4-two-anchor-flavours-dom-and-pick) does not have.

`AssetEditor.rebuildBar` becomes roughly:

```ts
act(this.bar.button('Approve', () => {}), approveAction(info), (a) => void this.approve(a));
```

with `disabled` and `description` derived from the same `Offer` the anchor recorded — which is what
those lines already do by hand.

## 3. The doctree half of the map is already pure

`menuFor(node)` (`renderer/pathux/doctree.ts`) returns `{label, id, props?, form?}` entries per node
kind. It is a pure function, statically enumerable, `Offer`-shaped in all but name, and it covers a
large slice of the catalog with no browser in the loop. It is unit-testable in node today.

So the map has two halves with different economics, and the plan should not treat them alike:

- **The doctree half is derived.** Convert `MenuEntry` to `Offer`, enumerate `menuFor` over every
  `DocNodeKind`, and the coverage falls out of a jest test. No CDP, no fixtures, no sweep.
- **The drawn half is measured.** Everything painted into a pane needs [§10](#10-the-map-is-measured-not-declared)'s
  sweep, because whether a button exists depends on the asset it was drawn for.

Doing the derived half first is the cheapest coverage in the app, and it exercises the `Offer` shape
against real entries before any call site is touched. Note that `props` is already optional on a
`MenuEntry`, and an entry needing an argument a menu cannot supply sets `form: true` and opens the
palette — which is [§5](#5-anchor-records)'s `supplies` under another name, and is evidence the
shape below is the right one.

## 4. Two anchor flavours: DOM and pick

The `act(node, offer, run)` helper wires a click onto a node. Three editors have no such click.

`GraphCanvas` sets `pointerEvents: 'none'` on the whole node layer and routes every interaction
through one `pick()` against world-space geometry; only `.edge-label` and `.edge-input` opt back in.
A scene card in the branch editor, a task in the task graph and a node in the gen graph are drawn
HTML with a `getBoundingClientRect()`, but they are not clickable and carry no listener. (The gen
graph editor postdates both this plan and its review, and is the third surface of this shape.)

For those, `act()` would have to record a *description* of a gesture it did not wire — the exact
failure the plan opens by ruling out. So the anchor gets a second flavour whose wiring is the pick:

| | `dom` | `pick` |
| --- | --- | --- |
| Wired by | `act(node, offer, run)` — one listener, one record | the canvas's existing `pick()` dispatch |
| Keyed by | the node the listener is on | the graph node id |
| Rect from | `getBoundingClientRect()` | the layout, through the viewport transform |
| Verified by | shadow-piercing containment ([§9](#9-the-pick-oracle)) | calling `pick()` at the ring's centre and comparing the id it returns |

The rule survives in the second flavour, but differently: a `pick` anchor is honest because the
oracle calls the same `pick()` the pointer does, not because one object feeds both sides. That is a
weaker guarantee than the DOM flavour's, and [§12](#12-failure-modes-and-what-catches-each) records
it as such rather than claiming the strong one everywhere.

This matters more than its share of the surface suggests. "Show me how to branch this scene" is the
tour request the branch editor exists for.

## 5. Anchor records

```ts
export interface Anchor {
  /** `cmd:asset.regenerate` or `item:asset/<hash>` — see §6. */
  key: string;
  id: string;                       // the command it runs
  props: Record<string, PropValue>; // the props known when the anchor was recorded
  /** Prop names the click reads from the widget at commit time — see below. */
  supplies?: string[];
  enabled: boolean;
  /** Why it is greyed. The sentence the rule already wrote — never invented here. */
  reason?: string;
  editor: EditorId;
  /** How the ring is placed and checked — see §4. */
  via: { kind: 'dom'; node: HTMLElement } | { kind: 'pick'; nodeId: string };
}
```

`enabled: false` with a `reason` is recorded as an anchor, not as an absence, and that is strictly
better than "not found": the tour can point at the greyed button and say the app's own refusal
sentence — for example, "this refuses because the asset is suspended" — instead of inventing one.

`supplies` is the review's third finding made structural. For a large part of the mutating surface
there is nothing to record for some props, because they are what the human is about to type:

| Surface | Command | Supplied at click time |
| --- | --- | --- |
| `rungBox` | `art.setNotes` | `notes` — the textarea |
| `promoteStrip` | `art.promote` | `variant` — a typed id |
| `promptStrip` | `art.redraw` | `prompt`, `title` |
| `customBox` | `prompt.setCustom` | `text` |
| `chunkBox` | `prompt.setChunk` | `text`, and `op` from which button opened it |
| script and timeline row edits | `story.setLineText` | the line |

An anchor that names those in `supplies` is complete; one that silently omits them is a bug the
resolver cannot tell from a wrong subject. This is not an edge case — the plan's own opening example
resolves to `art.setNotes(target='location:cafe/night')`, which is a rung box, not a button.

## 6. Item anchors generalize a convention that exists

`AssetEditor` already ships a miniature of this feature. `openOrigin` follows a `⇱` to
`[data-anchor="request"]` or `[data-rung="<target>"]` and scrolls it into view; cards carry
`data-chunk="<key>"`; rung boxes carry `data-rung="<target>"`. Do not invent a parallel scheme —
generalize this one into a single `data-anchor="<kind>/<key>"` attribute, and keep `data-chunk` /
`data-rung` as the domain-specific readers they already are.

The key must be domain identity — asset hash, scene id, line id, chunk key, rung target, graph node
id — and never an index, a position, or a label. Indices break on any re-sort, and the doctree's
asset labels carry a `(hash8)` suffix only on collision, so labels are not stable either.

There is one existing counterexample to convert rather than discover: the timeline editor writes
`dataset['lineIndex']` on a band.

## 7. The registry is generation-scoped

`rebuildBody()` does `this.surface.textContent = ''`; `this.bar.clear()` discards every widget. An
element reference held across a frame is a dangling pointer.

- The registry is cleared and repopulated as part of the same rebuild that draws the widgets, under
  a monotonic generation counter.
- Nothing outside may hold an `Anchor`. The tour re-resolves by key on its own clock — see below.
- Exposed as `window.__vnAnchors` for CDP and DevTools, alongside `window.__vnDebug`. Unlike
  `__vnDebug` this one ships in production, because the tour needs it at runtime. It needs an entry
  in `renderer/global.d.ts`, which declares only `api` and `__vnDebug` today. It is a different
  exposure from `window.vn`, which the preload bridge installs.

**The overlay owns its own loop.** An earlier draft of this plan said `update()` runs every frame
and there is nothing to subscribe to. The first half is wrong: path.ux drives the screen off
`setInterval(…, 150)` in `screen/FrameManager.ts`. That is fine for re-resolving *which* anchor a
step means, and far too slow for the ring's rect — at 150 ms a ring visibly lags a scroll. So the
overlay runs its own `requestAnimationFrame` loop over rects while a tour is live, and re-resolves
keys on the slower beat. The second half of the claim stands: there is still nothing to subscribe to.

## 8. Resolution is a pure function with seven answers

```ts
export type Resolution =
  | { state: 'ready'; anchor: Anchor }
  | { state: 'input'; anchor: Anchor; supplies: string[] } // ring it, say what to type
  | { state: 'disabled'; anchor: Anchor; reason: string }
  | { state: 'offscreen'; anchor: Anchor }        // scroll it in, then re-resolve
  | { state: 'wrong-subject'; anchor: Anchor; needs: Action }  // id matches, props conflict
  | { state: 'pane-closed'; editor: EditorId }    // emit a view.open step first
  | { state: 'absent' }                           // declared for this editor, not drawn
  | { state: 'unanchored' };                      // no UI route — fall back to the palette
```

`resolveAnchor(map, live, step) → Resolution` is pure over a snapshot, so it is unit-testable in
node despite the surface being a browser. It lives at `renderer/rules/anchors.ts` with a `tests/`
sibling.

### Subsumption is the comparison, not equality

An anchor's props are partial by design ([§5](#5-anchor-records)), so "id matches, props do not" is
the wrong test — against any input surface it returns `wrong-subject` every time. The rule is:

- Every key the **anchor** records must equal the step's value for that key. A conflict is
  `wrong-subject`.
- Every key the **step** names that the anchor does not record must appear in `anchor.supplies`. If
  it does, the step resolves `input` and the overlay rings the box and says what to put in it. If it
  does not, the anchor is incomplete and that is `wrong-subject` too — a bug worth reporting, not
  hiding.
- An anchor with `supplies` and a step naming none of them still resolves `ready`; the human is
  being shown where to start.

### Why `wrong-subject` matters

It is the common case. The Regenerate button acts on `ui.assetHash`; the Approve button on whatever
the pane is showing. If a step wants a different asset, `id` matches and `props` conflict, and
ringing that button would be actively wrong. This resolves into a preceding step ("select this in
the documents tree"), not into a ring. Given how much of this app takes its subject from `ui.*`
selection, this is where naive anchoring would break most often.

`absent` and `unanchored` are different answers, for exactly the reason `Interaction.targets`
distinguishes an empty target list from `UNRESOLVED`: one is a statement about the screen, the other
about the map, and the caller needs to know which.

## 9. The pick oracle

A ring drawn at the right rect over the wrong thing is the failure that is hardest to notice, because
it renders exactly like a correct one. Before drawing confidently, check that the point at the ring's
centre actually lands inside the anchored node.

**`@vn/debug2d` descends shadow roots; its hit oracle does not.** `snapshotDom` merges an open
`shadowRoot`'s children into the node's own, and `fragmentsFromSnapshot` clips a `position: fixed`
descendant along its real containing-block chain (`ba53aac0`, 2026-08-27), so the computed stacking
walk sees editor content that used to be invisible to it. The oracle beside it does not follow:
`dom/source.ts` calls `doc.elementsFromPoint` unmodified, which answers with the shadow **host**.

The overlay is not blocked by that, because it never calls debug2d: the package is dev-only and
`vite build` drops it, while the overlay ships. But the gap is worth closing on its own account, and
it is one line. `domSource` takes the document through a structural seam with an optional
`elementsFromPoint`, and `renderer/debug/install.ts` is where the real document is handed over — so
passing path.ux's `pickElements` there gives the oracle the same nodes the walk sees, with no change
to debug2d and no cost to its zero dependencies. Until then the computed walk descends further than
its own cross-check can follow, and `explainPick`'s `⚠` compares by strict id, so the disagreement it
prints over widget content is the tooling's rather than the app's.

**path.ux has already written the hit test, and this plan should call it rather than repeat it.**
`core/base/ui_base_pick.ts` ships both shapes: `pickElement(x, y, args)` descends
`document.elementFromPoint` into `elem.shadow.elementFromPoint` while the hit is a `UIBase`, keeping
the chain it walked and offering a `clip` rect filter; `pickElements(elem, x, y, args)` is the
`elementsFromPoint`-shaped plural, recursing nested shadow roots. `VnEditor extends Area` and
`appendSurface` mounts into `container.shadow`, which is a `UIBase` shadow, so the descent reaches
raw surface content as well as widgets.

The one adaptation: `nodeclass` defaults to `UIBase`, so the answer is the innermost *widget*, while
a raw-DOM anchor — the asset editor's `<button>`s, the chunk cards — needs the raw node the walk
passed through. Read `pickElement`'s chain rather than its filtered answer.

**Containment is one property name, all the way up.** A `UIBase` has always carried `parentWidget`;
`initUIBase` now sets `shadow.parentWidget` to the widget owning the root, and types `shadow` as
`ShadowRoot & { parentWidget }`. So a raw `<button>` inside an editor surface reaches its owning
widget by the same name a widget reaches its parent by, and the whole ascent is one loop with no
cast — `ShadowRoot.host` answers the same question but is typed `Element`, which is the difference
that matters here:

```ts
let n: Node | null = hit;
while (n && n !== anchor) n = n.parentNode ?? shadowOwner(n);
```

`findArea` in `ui_base_dom.ts` is the same walk stopping at a different target. This is why
`verify-prompt-chunks.mjs`'s hand-rolled `node.shadowRoot` recursion is a precedent for the *CDP
script's* constraints and not a model for the overlay: the overlay runs inside the app and can call
the real thing.

`shadow.parentWidget` is newer than the path.ux commit this repo pins, so stage 8 depends on that
landing in the submodule and the pointer moving with it.

Three further constraints:

- **Test containment, not identity.** A path.ux `Button` paints into an inner `<canvas class="canvas1">`,
  which is what the pierced hit test returns. The oracle passes when the hit is the anchored node or
  reaches it by `parentWidget`.
- **A `pick` anchor is checked by `pick()`, never by the DOM.** The point at a graph card's centre
  lands on the canvas element by design, so a DOM oracle would fire a warning on every one of those
  anchors, correctly and uselessly, and would be muted within a week.
- **`getBoundingClientRect()` is not the hit area**, and a ring drawn from it can be smaller than
  the thing it points at. This is the next section.

On disagreement, report it rather than resolving it silently — the same contract `explainPick` uses
when the computed stacking order and the browser's `elementsFromPoint` disagree, and it prints a `⚠`.

### The rect a ring cannot read

A gen-graph socket is an 8×8 dot carrying a `::before` of `position: absolute; inset: -5px`, so its
real target is 18×18 — a small mark with a comfortable click pad around it. The browser hit-tests a
pseudo-element as part of the element that originates it. `getBoundingClientRect()` does not include
it. So the socket's recorded box and its clickable area differ by five pixels on every side, and
nothing in the DOM API closes that gap: `getClientRects()` does not report pseudo-elements either.

That is this section's whole argument in one case. A ring drawn from the recorded box would sit
*inside* the region the author is told to click, look exactly like a correct ring, and be wrong. No
other check in this plan would notice: the anchor names the right command, resolves to the right
node, and the rect is a real rect. Only asking the browser what is actually at the ring's centre
catches it, and only if the oracle is believed when it disagrees.

The overlay cannot recover the true rect, so it does one of two things when the oracle reports a hit
that reaches the anchor by `parentWidget` but lies outside the recorded box: widen the ring to the
hit it was given, or let a `pick` anchor supply its own rect — which the graph editors need anyway,
since theirs come from the layout rather than from the DOM.

Measured 2026-08-31 over the running app: with the oracle piercing shadow roots, 2 of 80 sampled
points disagree, and this is one of them. The other is `containsPoint` in `@vn/debug2d` including its
far edge (`p.x <= r.x + r.w`) where the browser's hit test excludes it, so the two differ on exactly
the boundary pixel. Neither is a stacking-order fault, which is what the `⚠` text guesses at; both
are the recorded bounds disagreeing with the real ones.

## 10. The map is measured, not declared

Planning happens before any pane is open, so the tour needs to know statically that
`prompt.condense` lives in the `asset` editor. A hand-written table beside `EDITORS` would work and
would be checkable like `editorNameProblems` — but it would need to be kept in sync with the anchor
records by hand, which is exactly the kind of duplication this plan is trying to remove.

Measure the drawn half. `scripts/sweep-anchors.mjs`, a sibling of `verify-prompt-chunks.mjs`, opens
each editor in `EDITORS` against the seeded sample workspace, dumps `window.__vnAnchors`, and writes
the map. The desktop jest project is node-only and surfaces are verified live over CDP, so the sweep
script does that, and `verify-prompt-chunks.mjs` is the working precedent for driving the
shadow-rooted panes. The doctree half comes from [§3](#3-the-doctree-half-of-the-map-is-already-pure)
and needs no sweep.

Three caveats to build into the sweep:

- **The map is conditional.** Promote renders only for a `concept`; a `reference` asset shows neither
  Approve nor Regenerate; the chunk acts appear only when `!view.frozen`. A sweep needs fixtures
  covering each branch, and each record should carry the condition it appeared under, so the map
  states its own coverage instead of appearing total.
- **Every count is read, never written.** `EDITORS` holds seventeen entries today, three of them
  `offered: false` but still openable by `view.open`; the registry holds 155 commands. Both numbers
  have already doubled once during this plan's life, so the sweep reads the editor list from
  `EDITORS` and the denominator from the built `commands.json`. No count belongs in this file except
  as a dated observation, and the two above were measured on 2026-08-31.
- **Coverage is a ratchet, and only half of it is a gate.** The output carries the number — "N of M
  commands have a UI anchor; the rest are palette-only" — and also a stamp: the git sha it was swept
  at, and a digest of the command ids in the catalog at that moment. [§13](#13-enforcement) says
  which half of that CI can check and which half it cannot.

## 11. Two oracles for one refusal

Once anchors record `enabled`/`reason`, the app has two independent derivations of the same
refusal — the renderer-side rule (`approveAction`) and main's `stack.check(id, props)`. They should
agree. A disagreement is a real bug and should be surfaced, not reconciled. Cheap to check during
the sweep — `command:check` is already reachable from the renderer, with several existing callers —
and it is the kind of drift that otherwise goes unnoticed for months.

## 12. Failure modes and what catches each

| Failure | Caught by |
| --- | --- |
| Anchor names a command the build no longer has | Boot check against the live catalog, like `editorNameProblems` |
| Button rewired, anchor stale (`dom` flavour) | Structurally impossible — one `Action` object feeds both |
| Graph node's gesture rewired, anchor stale (`pick` flavour) | Not structural. The oracle calls the same `pick()` the pointer does, so a moved node is caught and a re-bound gesture is not |
| A command reached without passing `bridge.exec` | The three-seam audit (§1); nothing downstream can see it |
| New command added with no anchor | The catalog digest in CI (§13) — a red build |
| Existing button deleted, its command still in the catalog | Only the sweep, which is advisory. Accepted residual risk (§13) |
| Right button, wrong subject | `wrong-subject` → emits a selection step |
| Anchor omits a prop the widget supplies | `wrong-subject` rather than a silent mismatch, because `supplies` has to name it (§8) |
| Target scrolled out or in a collapsed section | `offscreen` → scroll-into-view, then re-resolve |
| Element recycled mid-tour | Generation-scoped registry; re-resolve by key |
| Ring over the right rect, wrong thing on top | Shadow-aware pick oracle (§9) |
| Ring smaller than the target, because a `::before` pads the hit area | The same oracle, and only it — the gap is invisible to `getBoundingClientRect()` (§9) |
| Renderer rule and `stack.check` disagree | Sweep-time comparison (§11) |

## 13. Enforcement

A lint rule banning direct `api.invoke('command:exec', …)` in `renderer/pathux/editors/**` is worth
having on its own merits and independent of tours, because that bypass is what finding 1 is about;
it needs no allowlist, since the bridge is the only legitimate route. The broader rule — banning
bare `exec(` outside `act()` — would be stronger but needs an allowlist for genuinely programmatic
calls, so it is deferred until coverage is observed to drift.

The coverage ratchet is the other guard, and it needs splitting, because an earlier draft called it
"the practical guard" and that claim does not survive contact with what CI runs.

### Why the sweep cannot be the gate

CI runs `pnpm check`, `pnpm test` and `pnpm lint`, plus `check:keylinks`, and packaging with `smoke`
on release. The CDP verification scripts are not in it — `verify-prompt-chunks.mjs` and
`verify-agent-report.mjs` are not even in `package.json`'s scripts, and are run by hand. The sweep
needs a built app, a CDP port and a seeded workspace, so it inherits exactly that.

Left there, the ratchet is circular: a test comparing the committed `anchors.json` against a
committed baseline passes in CI, but nothing in CI regenerates `anchors.json`, so a stale file
passes forever and the check measures itself.

### The split

- **In CI, pure node.** A jest test reads the committed `anchors.json` and the built
  `commands.json` and asserts three things: every command id an anchor names still exists; the
  coverage count has not fallen; and the catalog digest the sweep stamped still matches the catalog
  as built. The third is what makes the first two mean something — adding a command without
  re-sweeping moves the digest and fails the build, so the common way a map goes stale is a red
  build rather than silence. No browser, no app, no fixtures.
- **By hand, advisory.** The sweep itself, and everything that needs a running app with it: whether
  an anchor still *draws*, which condition each record appeared under, and
  [§11](#11-two-oracles-for-one-refusal)'s comparison against `stack.check`. Run it when the work
  touches `renderer/pathux/editors/**`, and on the schedule `audit:keydocs` already establishes for
  a check that needs more than a checkout.

### What still gets through

A button deleted while its command survives. The digest does not move, the count is read from a file
nobody regenerated, and only the sweep would notice. The mitigations are that `anchors.json` is
committed so the absence is a reviewable diff when someone does re-sweep, and that a missing anchor
degrades to the palette route rather than to a wrong ring — the tour still works, less well. That is
the residual risk this plan accepts rather than one it has covered.

## 14. Files

| Path | What |
| --- | --- |
| `apps/desktop/renderer/rules/anchors.ts` | `Action`, `Offer`, `Anchor`, `resolveAnchor`, subsumption, key helpers. Pure |
| `apps/desktop/renderer/rules/tests/anchors.test.ts` | The seven resolutions, props subsumption, key stability |
| `apps/desktop/renderer/pathux/anchors.ts` | `act()`, the generation-scoped registry, `window.__vnAnchors` |
| `apps/desktop/renderer/debug/install.ts` | Pass `pickElements` into `domSource`'s `elementsFromPoint` seam, so debug2d's oracle answers with the nodes its shadow-descending walk sees |
| `apps/desktop/renderer/pathux/editors/*.ts` | Call sites converted; the three `command:exec` bypasses routed through `bridge.exec` |
| `apps/desktop/renderer/pathux/doctree.ts` | `MenuEntry` reshaped to `Offer`; `menuFor` enumerated in a test |
| `apps/desktop/renderer/rules/assetview.ts`, `promptview.ts` | `promoteAction` re-shaped; new `Offer`-shaped rules for the inline cases |
| `apps/desktop/renderer/global.d.ts` | `__vnAnchors` |
| `scripts/sweep-anchors.mjs` | The CDP sweep → `apps/desktop/anchors.json` + coverage + the catalog stamp. Advisory, run by hand |
| `apps/desktop/renderer/rules/tests/coverage.test.ts` | The CI half of the ratchet: ids still exist, count has not fallen, catalog digest still matches |

---

# Part II — the tour (sketch)

This part is lighter, because the anchor layer is the load-bearing half and the tour depends on it
rather than the other way around. It is not, on the review's reading, thin: [§4](#4-two-anchor-flavours-dom-and-pick)
and [§9](#9-the-pick-oracle) both land in the overlay, and both are larger than the first draft
assumed.

## Shape

A tour is an ordered list of steps. A step is one of:

- **`command`** — an invocation to be run by hand. Resolved through [§8](#8-resolution-is-a-pure-function-with-seven-answers);
  rings the anchor, or falls back to the palette.
- **`input`** — ring a box, say what to put in it, advance on the commit. This is what a `supplies`
  key resolves to, and it is the step kind the plan's own headline example needs: "change the café's
  night lighting" is `art.setNotes(target='location:cafe/night')` typed into a rung box, not a
  button pressed. Teaching "say this clause in your own words" is three steps — click Replace…,
  type, Ctrl+S — of which only the first is a `command`.
- **`select`** — publish a `ui.*` subject by clicking something (`item:` anchor). This is what a
  `wrong-subject` resolution generates, and it is also the first half of every `originAction` open.
- **`gesture`** — an interaction id plus a carried token. The interaction registry answers
  `targets(state, carried)` synchronously and purely, so the overlay can ring both the grab handle
  and every accepting target, each with the sentence it would produce. The branch and prompt editors
  already paint exactly this mid-drag; the tour arms it without a pointer down.

## The palette is the guaranteed floor

`openPalette(preselect, overrides)` already accepts prop overrides, and `CommandForm` renders the
live `command:check` verdict above the run button. So an `unanchored` step still works: the form
comes up prefilled, with the verdict shown, and the ring goes on the run button. That means the
feature works across the whole catalog on day one, and improves as anchors are added.

One change is needed first: `openPalette` returns early if the palette is already open, so a
multi-step palette-route tour cannot retarget it. Either it learns to re-target, or the tour closes
and reopens between steps. `openCommandDialog` has the same early return and the same question.

## Commands

A `tour` namespace in `apps/desktop/src/main/commands/`, so the agent reaches it through the one
door everything else uses: `tour.start(steps=…)`, `tour.next`, `tour.cancel`, `tour.explain`.
Non-mutating, not undoable, never `commitsItself`.

## Overlay

A `pointer-events: none` layer above the mesh, re-reading rects on its own `requestAnimationFrame`
loop while a tour is live ([§7](#7-the-registry-is-generation-scoped)). Positions are never
precomputed: `view.open` answers optimistically and only the mesh knows how many panes there are, so
`applyView` returns a correction — anchors must be re-resolved after every navigation step.

## Advancing, and going off-script

Advance on `onExec` seeing the expected id with matching props. This is sound **only once the three
`command:exec` bypasses are routed through `bridge.exec`** ([§1](#1-the-audit-and-its-three-seams));
until then it is blind to most of the story-editing vocabulary. Anything other than the expected
invocation means the user diverged from the tour, and the response is to re-plan rather than to
block them. It is the same planning that produced the tour, so it is cheap.

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

1. **Prerequisites and audit.** Route `script.ts` and `timeline.ts` through `bridge.exec`, so every
   command the shell runs passes one seam. Audit all three seams. Grow rules for the inline
   invocations and re-shape `promoteAction`. Settle the `input` step kind and the subsumption rule,
   since both change `resolveAnchor`'s signature. No behaviour change; new unit tests.
2. **The doctree half of the map.** `MenuEntry` → `Offer`, `menuFor` enumerated over every
   `DocNodeKind` in a jest test. Pure, no sweep, and it validates the `Offer` shape against real
   entries before any wiring is touched.
3. **`act()` + registry + `resolveAnchor`.** Convert the `asset` editor first — it is the worst DOM
   case (roughly twenty clickable things, path.ux widgets and raw DOM, several input surfaces, most
   already rule-backed).
4. **Sweep + coverage ratchet.** `sweep-anchors.mjs`, `anchors.json` and the two-oracle comparison,
   plus the jest half that runs in CI ([§13](#13-enforcement)). Ship both together: the sweep alone
   is a number nobody checks. At this point the anchor layer stands alone and is worth having on its
   own.
5. **Remaining editors** converted, coverage ratcheted up.
6. **The `pick` flavour** for the branch, task graph and gen graph editors ([§4](#4-two-anchor-flavours-dom-and-pick)).
   Separate from stage 5 because it is a different mechanism, not more of the same one.
7. **Tour: three curated tours, palette-route only.** Proves the loop end to end.
8. **Overlay rings on real anchors**, the pick oracle over path.ux's `pickElement` and
   `parentWidget`, and scroll-into-view. No hit test to write. The ring widens to the oracle's hit
   rather than trusting its own rect, because a padded target is wider than its box
   ([§9](#the-rect-a-ring-cannot-read)).
9. **Gesture steps** over the interaction registry.
10. **Agent-generated tours.**

Stages 1–5 are unaffected by the two findings that could still enlarge the overlay, which is this
plan's own argument for why the anchor layer should stand alone, and it holds.

## Decisions still open

- **Whether `openPalette` learns to re-target** an already-open palette, or the tour closes and
  reopens it between steps.

## Decisions since made

- **The overlay mounts at document level**, a `pointer-events: none` `<div>` rather than a
  `screen.popup` like the palette. It is simpler and intercepts nothing, and it must sit above every
  path.ux stacking context — which `@vn/debug2d` can now check in dev, since `ba53aac0` gave its
  stacking walk the shadow descent that question needed.
- **`anchors.json` is committed, at `apps/desktop/anchors.json`.** Not under `dist/`: `dist` is
  gitignored, and `commands.json` — generated there at build time and never committed — is the
  precedent for the opposite choice, not for this one. Committing it makes drift a reviewable diff,
  and the coverage ratchet needs a baseline in the tree either way.
- **The agent reaches the map only through a `tour.*` command**, never by reading the file. One
  door, as everywhere else.

## What this deliberately does not do

- No screenshots and no vision. The app describes itself; reading pixels back would be a second,
  less reliable source of truth.
- No new IPC channel. Everything is a command, as it is for every other desktop action.
- **No anchoring of menus, and that is a coverage ceiling rather than only a scoping choice.** The
  app menu is a `MenuTemplate` of callbacks built on demand, and context menus likewise, so there is
  nothing to anchor until the author has already opened the menu — which is when the tour needed to
  point at it. A class of commands lives only there: `workspace.create`, `workspace.pick`,
  `project.setKey`, `upload.pick`, `view.saveLayout`, `view.resetLayout`, `notify.deleteAll`. The
  honest floor for all of them is the palette, and the ratchet should count them as palette-only
  rather than as a gap to close. `menuFor`'s right-click entries are the exception and are covered
  by [§3](#3-the-doctree-half-of-the-map-is-already-pure), because they are data rather than a live
  menu.
- No anchoring of the header bar. It is an editor by construction, named in no list, and a tour has
  no reason to point at it.

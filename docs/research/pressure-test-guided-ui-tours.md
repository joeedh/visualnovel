# Pressure test — `plans/guided-ui-tours.md`

An adversarial read of the guided-tours plan against the code as it stands (August 2026). The
plan's central rule — *an anchor is the wiring, not a description of it* — survives. Most of what
it claims about the app is true. What follows is what it gets wrong, ordered by how much work the
error moves.

<!-- toc -->

- [What checks out](#what-checks-out)
- [1. Three editors bypass `bridge.exec`, and the tour advances on it](#1-three-editors-bypass-bridgeexec-and-the-tour-advances-on-it)
- [2. The two graph editors have no click to wire, and no node to hit-test](#2-the-two-graph-editors-have-no-click-to-wire-and-no-node-to-hit-test)
- [3. The props are not known when the anchor is recorded](#3-the-props-are-not-known-when-the-anchor-is-recorded)
- [4. Three of the five rules in §1's table are not `Action`-shaped](#4-three-of-the-five-rules-in-1s-table-are-not-action-shaped)
- [5. Menus are transient — and `menuFor` is the map the plan went looking for](#5-menus-are-transient--and-menufor-is-the-map-the-plan-went-looking-for)
- [6. `@vn/debug2d` has not solved shadow piercing](#6-vndebug2d-has-not-solved-shadow-piercing)
- [7. `anchors.json` cannot be both committed and under `dist/`](#7-anchorsjson-cannot-be-both-committed-and-under-dist)
- [8. Smaller corrections](#8-smaller-corrections)
- [What this implies for the staging](#what-this-implies-for-the-staging)

<!-- tocstop -->

## What checks out

Worth stating, because it is most of the plan:

- `UIBase extends HTMLElement` (`vendor/path.ux/scripts/core/ui_base.ts:1000`), so a path.ux widget
  and a raw `<button>` do take one helper. The fact the overlay rests on is real.
- `onExec` exists and is the right seam in principle (`renderer/pathux/bridge.ts:99`).
- `openPalette(preselect, overrides)` really does take overrides (`palette.ts:129`), and
  `CommandForm` renders the live `command:check` verdict above the run button (`commandform.ts:82`),
  so the "prefilled palette as the guaranteed floor" is genuinely available today.
- `command:check` is reachable from the renderer (`api.ts:354`, five existing callers), so §9's
  two-oracle comparison costs nothing to run.
- `interaction.targets` answers purely from the same `targets` a drop calls, and `Verdict.invoke` is
  exactly `{id, props}` — an `Action` (`src/main/commands/interaction.ts:36`,
  `src/shared/interactions.ts:50`).
- §4's premise about label stability is exactly right: `labelAssets` appends `(hash8)` only when two
  assets land on the same words (`src/main/assetlabel.ts:98`).
- §12's file paths work. The `@vn/desktop` jest project matches `**/apps/desktop/**/tests/*.test.ts`
  (`jest.config.cjs`), so `renderer/rules/tests/anchors.test.ts` runs.
- `EDITORS` is twelve (`src/shared/editors.ts:17`), the header genuinely absent by construction.

## 1. Three editors bypass `bridge.exec`, and the tour advances on it

The largest error, because it invalidates a step in Part I *and* the advance mechanism in Part II.

`branch.ts:698`, `script.ts:832`, `timeline.ts:692` and `timeline.ts:716` call
`api.invoke('command:exec', {...invocation, source: 'ui'})` directly, not `bridge.exec`. They do it
for a good reason — each owns its own refusal display, and `bridge.exec`'s `say()` would double up
with the pane's own notice strip — but the consequences are not local:

- **`onExec` never fires for them.** Part II's *"advance on `onExec` seeing the expected id with
  matching props"* is silently blind to `story.setNext`, `story.setChoice`, `story.moveLine`,
  `story.setLineText`, `story.setCoverage`, `story.moveShot`, `story.setOutfit` — most of the
  story-editing vocabulary, and precisely the commands a curated tour would teach.
- **§1's audit is scoped to the wrong string.** `grep exec\( renderer/pathux/editors/**` finds 24
  sites, of which roughly half are reads (`asset.info`, `project.info`, `doc.read`,
  `workspace.recent`, `agent.threads`). Five editors — branch, graph, script, tasks, timeline —
  return **zero** hits. An audit that reports them clean is worse than no audit.
- **§11's proposed lint rule would pass green** on the three editors that most need it.
- Independently of tours: `onInvalidate` and `onWrote` also only fire inside `bridge.exec`, so a
  `story.*` edit made in the script editor never tells the asset pane its derived prompt moved.
  That is a live defect this work would surface, not one it creates.

Routing the four sites through `bridge.exec` is small — it already returns the outcome and only
speaks when there is no record — but it is a **prerequisite the plan does not list**, and it belongs
in stage 1, before the audit rather than after it.

## 2. The two graph editors have no click to wire, and no node to hit-test

`GraphCanvas` sets `pointerEvents: 'none'` on the entire node layer (`pathux/graph/canvas.ts:143`)
and routes every interaction through one `pick()` against world-space geometry
(`canvas.ts:287-290`). Only `.edge-label` and `.edge-input` opt back in (`styles/branch.css:255,273`).
A scene card in the branch editor and a node in the task graph are drawn HTML with a
`getBoundingClientRect()` — but they are not clickable, and they carry no listener.

Two things follow:

- **The load-bearing rule does not reach them.** `act(node, offer, run)` cannot wire a click that
  does not exist on the node. For branch and taskgraph the anchor would be a *description* after
  all — the exact failure mode the plan opens by ruling out. §10's row *"Button rewired, anchor
  stale → structurally impossible"* is true for the asset editor and false for the story graph.
  These need a second anchor flavour whose wiring is `pick`: keyed by node id, rect derived from
  `layout` through the viewport transform, and verified against `pick()` rather than against
  `elementsFromPoint`.
- **§7's oracle would fire ⚠ on every one of their anchors, correctly and uselessly.** The point at
  a card's centre lands on the canvas element by design. An oracle that flags the app's intended
  arrangement as a disagreement will be muted within a week. It needs to know that a
  hit-test-transparent node is anchored through `pick`, not through the DOM.

This matters more than its share of the surface suggests: "show me how to branch this scene" is the
tour request the branch editor exists for.

## 3. The props are not known when the anchor is recorded

`Anchor` declares `props: Record<string, PropValue>` — *"with the subject it would run against"*
(§3). For a large fraction of the app's mutating surfaces there is nothing to record, because the
props are what the human is about to type:

| Surface | Command | Prop supplied at click time |
| --- | --- | --- |
| `rungBox` (`asset.ts:1108`) | `art.setNotes` | `notes` — the textarea |
| `promoteStrip` (`asset.ts:1003`) | `art.promote` | `variant` — a typed id |
| `promptStrip` (`asset.ts:1061`) | `art.redraw` | `prompt`, `title` |
| `customBox` (`asset.ts:938`) | `prompt.setCustom` | `text` |
| `chunkBox` (`asset.ts:900`) | `prompt.setChunk` | `text`, and `op` from which button opened it |
| script/timeline row edits | `story.setLineText` | the line |

Three consequences:

- **Part II is missing a step kind.** It lists `command`, `select`, `gesture`. It needs `input`:
  ring a box, say what to put in it, and advance on the commit. Note that the plan's *own opening
  example* — *"show me how to change the café's night lighting"* — resolves to
  `art.setNotes(target='location:cafe/night')`, which is a rung box, not a button. The feature's
  headline scenario is not expressible in the step vocabulary as written.
- **Two of the four `chunkActs` buttons run no command at all.** §1 says `chunkActs` *"builds four
  `prompt.setChunk` invocations inline"*; `asset.ts:863` builds two (`mute`, `clear`) plus two that
  open an editing box (`asset.ts:878`). Teaching "say this clause in your own words" is three steps
  — click Replace…, type, Ctrl+S — of which only the first has an anchor with complete props.
- **§6's `wrong-subject` needs its comparison defined, not just tested.** As written it is *"id
  matches, props do not"*, which against a partially-populated anchor returns `wrong-subject` for
  every input step. §12 lists "props subsumption" as a test name; it needs to be a stated rule in
  §6 — an anchor's props must *subsume* the step's, and the unrecorded keys are the ones the human
  supplies.

## 4. Three of the five rules in §1's table are not `Action`-shaped

§1 asserts *"those objects **are** the anchor payloads"*. Checked against `rules/assetview.ts` and
`rules/promptview.ts`:

| Rule | Actually returns | Action-shaped? |
| --- | --- | --- |
| `approveAction` | `{ok, id, props, label}` | yes |
| `condenseAction` | `{ok, id, props, label, note}` | yes |
| `modeStrip[].action` | `{ok, id, props}` | yes |
| `promoteAction` | `{ok: true, locationId}` | **no** — `art.promote`'s id and props are assembled at `asset.ts:243` |
| `originAction` | `{ok, kind:'open', editor, subject, publish, label}` \| `{kind:'scroll', to, label}` | **no** |

`originAction` is the awkward one and deserves saying in the plan rather than being discovered
during stage 2. Its `open` variant is *two acts in a load-bearing order* — publish `ui.*` fields,
**then** `view.open`, because the new pane reads the selection on its first `update()`
(`promptview.ts:96-103`, `asset.ts:376-383`). That is a `select`-then-`command` pair, not one
anchor. Its `scroll` variant is not a command at all. Not fatal — but "grow rules for the inline
cases" understates the work when two named rules have to be *re-shaped*, and one of them cannot be.

`replaceAction` (`{ok, slot}`) and `promptEditable` (`{ok, prompt, title}`) are the same story: they
are display rules that gate a strip, not invocations.

## 5. Menus are transient — and `menuFor` is the map the plan went looking for

The app menu is a `MenuTemplate` of callbacks built on demand (`editors/header.ts:227`), and
context menus likewise (`showmenu.ts:44`). Nothing exists to anchor until the author has already
opened the menu — which is exactly when the tour needed to point at it. A whole class of commands
lives only there: `workspace.create`, `workspace.pick`, `project.setKey`, `upload.pick`,
`view.saveLayout`, `view.resetLayout`, `notify.deleteAll`. §'s closing *"no anchoring of chrome"*
reads as a scoping choice; it is also a hard coverage ceiling, and the honest floor for those is the
palette. Worth saying so under "what this deliberately does not do".

But the same reading turns up something the plan misses entirely. `menuFor(node)`
(`renderer/pathux/doctree.ts:214`) is already a **pure function returning `{label, id, props, form}`
entries per node kind** — an `Offer`-shaped, statically enumerable map from the document tree to the
commands it offers, with no browser in the loop. It covers a large slice of the catalog, it is unit
testable in node today, and it needs no CDP sweep at all. §8's *"measure it instead"* is right for
drawn surfaces and unnecessary here: the doctree half of the map is a pure derivation. It should be
stage 1, before `sweep-anchors.mjs` — it is the cheapest coverage in the app and it validates the
`Offer` shape against real data before any wiring is touched.

## 6. `@vn/debug2d` has not solved shadow piercing

§7: *"`packages/debug2d/src/dom/source.ts` already solved it; the logic can be copied."*

There are **zero** occurrences of `shadow` anywhere in `packages/debug2d/src`. `snapshotDom` walks
`el.children` only (`dom/snapshot.ts:147`), and the oracle calls `doc.elementsFromPoint` unmodified
(`dom/source.ts:52`). debug2d does not pierce shadow roots — which also means it currently cannot
see *any* editor content, since every surface is mounted in a shadow root by
`VnEditor.appendSurface`. There is nothing to copy.

The working precedent is elsewhere and less convenient: `verify-prompt-chunks.mjs` injects a probe
that recurses `node.shadowRoot` manually (`scripts/verify-prompt-chunks.mjs`, the `PROBE` constant).
That is the shape to generalize, and it should be written as a real module rather than a
CDP-injected string.

Two knock-ons: the open decision *"must be proven to sit above every path.ux stacking context — a
`@vn/debug2d` question, answered in dev"* cannot be answered by debug2d as it stands; and the oracle
must test **containment**, not identity, because a path.ux `Button` paints into an inner
`<canvas class="canvas1">` (`vendor/path.ux/scripts/widgets/ui_button.ts:378`) which is what
`elementsFromPoint` will return.

## 7. `anchors.json` cannot be both committed and under `dist/`

§8 writes to `apps/desktop/dist/anchors.json`; the open decision leans committed *"for the same
reason `commands.json` is generated at build time and consumed by external tooling."*

`dist` is gitignored (`.gitignore`), and `git ls-files` finds no `commands.json`. The cited
precedent is an argument for **not** committing. If drift should be a reviewable diff — and the
coverage ratchet needs a baseline in the tree either way — the file has to live somewhere else.
Either way the decision needs restating, because as written it cites evidence against itself.

## 8. Smaller corrections

- **"all 73 commands" is stale.** `apps/desktop/src/main/commands/*.ts` declares ~96 ids. The
  ratchet's denominator should be read from the live catalog, not written into the plan.
- **`update()` is not per frame.** path.ux drives updates off `setInterval(cb, 20)`
  (`ui_base.ts:3101`). Close enough for re-resolution, but the overlay is not an editor and will
  need its own `requestAnimationFrame` loop rather than inheriting one.
- **`openPalette` is idempotent by early return** (`palette.ts:130`): if the palette is already
  open, a second call with a different `preselect`/`overrides` is ignored. A multi-step
  palette-route tour cannot retarget an open palette without a change there.
- **`timeline.ts` already stores an index in a data attribute** (`dataset['lineIndex']`), which §4
  bans by name. One conversion, but it is the rule's first counterexample and should be called out
  rather than found.
- **`window.__vnAnchors` needs a `global.d.ts` entry** (`renderer/global.d.ts` declares only `api`
  and `__vnDebug`), and it is a different exposure mechanism from `window.vn`, which comes from the
  preload bridge (`src/preload/index.ts:55`), not the renderer.

## What this implies for the staging

The plan's stage order is sound; three things move into or ahead of stage 1:

1. Route `branch.ts`, `script.ts` and `timeline.ts` through `bridge.exec` (finding 1). Nothing else
   in either half is trustworthy until every command the shell runs passes one seam.
2. Derive the doctree half of the map from `menuFor` (finding 5) — pure, node-testable, no sweep,
   and it exercises the `Offer` shape against real entries before any call site is converted.
3. Settle the `input` step kind and the props-subsumption rule (finding 3) before `resolveAnchor` is
   written, since both change its signature.

Findings 2 and 6 are the ones that could still sink the *overlay*: if graph-editor anchors need a
`pick`-based flavour and shadow piercing has to be written from scratch, stage 6 is materially
larger than the plan's "comparatively thin" framing of Part II suggests. Stages 1-5 are unaffected —
which is the plan's own argument for why the anchor layer should stand alone, and it holds.

# Pressure test — `plans/archive/guided-ui-tours.md`

This document is an adversarial read of the guided-tours plan against the code as it
stands (August 2026). The plan's central rule survives: an anchor supplies the wiring
rather than describing it. Most of what the plan claims about the app is true. The rest
lists what the plan gets wrong, ordered by how much work each error moves.

<!-- toc -->

- [What checks out](#what-checks-out)
- [1. Three editors bypass `bridge.exec`, and the tour advances on it](#1-three-editors-bypass-bridgeexec-and-the-tour-advances-on-it)
- [2. The two graph editors have no click to wire, and no node to hit-test](#2-the-two-graph-editors-have-no-click-to-wire-and-no-node-to-hit-test)
- [3. The props are not known when the anchor is recorded](#3-the-props-are-not-known-when-the-anchor-is-recorded)
- [4. Three of the five rules in §1's table are not `Action`-shaped](#4-three-of-the-five-rules-in-%C2%A71s-table-are-not-action-shaped)
- [5. Menus are transient — and `menuFor` is the map the plan went looking for](#5-menus-are-transient--and-menufor-is-the-map-the-plan-went-looking-for)
- [6. `@vn/debug2d` has not solved shadow piercing](#6-vndebug2d-has-not-solved-shadow-piercing)
- [7. `anchors.json` cannot be both committed and under `dist/`](#7-anchorsjson-cannot-be-both-committed-and-under-dist)
- [8. Smaller corrections](#8-smaller-corrections)
- [What this implies for the staging](#what-this-implies-for-the-staging)

<!-- tocstop -->

## What checks out

The following is worth stating, because it is most of the plan:

- `UIBase extends HTMLElement` (vendor/path.ux/scripts/core/ui_base.ts:1000), so one
  helper handles both a path.ux widget and a raw `<button>`. The overlay depends on this,
  and it holds.
- `onExec` exists and is the right "seam" (extension point) in principle
  (renderer/pathux/bridge.ts:99).
- `openPalette(preselect, overrides)` takes overrides (palette.ts:129), and `CommandForm`
  renders the live `command:check` verdict above the run button (commandform.ts:82). A
  prefilled palette is therefore available today as the guaranteed minimum.
- `command:check` is reachable from the renderer (api.ts:354, five existing callers), so
  the two-oracle comparison in §9 costs nothing to run.
- `interaction.targets` resolves only from the same `targets` a drop calls, and
  `Verdict.invoke` holds `{id, props}`, which is an `Action`
  (src/main/commands/interaction.ts:36, src/shared/interactions.ts:50).
- §4's premise about label stability is exactly right. `labelAssets` appends `(hash8)`
  only when two assets resolve to the same words (src/main/assetlabel.ts:98).
- The file paths in §12 are correct. The `@vn/desktop` jest project matches
  `**/apps/desktop/**/tests/*.test.ts` (jest.config.cjs), so
  `renderer/rules/tests/anchors.test.ts` runs.
- `EDITORS` is twelve (`src/shared/editors.ts:17`). The header is absent by construction.

## 1. Three editors bypass `bridge.exec`, and the tour advances on it

This is the largest error, because it invalidates a step in Part I and the advance
mechanism in Part II.

`branch.ts:698`, `script.ts:832`, `timeline.ts:692` and `timeline.ts:716` call
`api.invoke('command:exec', {...invocation, source: 'ui'})` directly rather than
`bridge.exec`. Each of these panes owns its own refusal display, and `bridge.exec`'s
`say()` would double up with the pane's notice strip, so the direct call is deliberate.
The consequences reach beyond these call sites:

- **`onExec` never fires for them.** Part II advances a step on "`onExec` seeing the
  expected id with matching props", and that rule does not cover `story.setNext`,
  `story.setChoice`, `story.moveLine`, `story.setLineText`, `story.setCoverage`,
  `story.moveShot`, or `story.setOutfit`. Those commands are most of the story-editing
  vocabulary, and they are the commands a curated tour would teach.
- **§1's audit is scoped to the wrong string.** `grep exec\( renderer/pathux/editors/**`
  finds 24 sites, of which roughly half are reads (`asset.info`, `project.info`,
  `doc.read`, `workspace.recent`, `agent.threads`). Five editors (branch, graph, script,
  tasks, timeline) return zero hits. Reporting those five editors as clean is worse than
  running no audit at all.
- The lint rule proposed in §11 would pass on the three editors that most need it.
- Tours aside, `onInvalidate` and `onWrote` also only fire inside `bridge.exec`, so the
  asset pane receives no notification when a `story.*` edit in the script editor moves its
  derived prompt. That defect is already live, and this work would surface it rather than
  create it.

Routing the four sites through `bridge.exec` is a small change (it already returns the
outcome and reports only when there is no record), but it is a prerequisite the plan does
not list. This routing belongs in stage 1, before the audit rather than after it.

## 2. The two graph editors have no click to wire, and no node to hit-test

`GraphCanvas` sets `pointerEvents: 'none'` on the entire node layer
(pathux/graph/canvas.ts:143) and routes every interaction through one `pick()` against
world-space geometry (canvas.ts:287-290). Only `.edge-label` and `.edge-input` re-enable
pointer events (styles/branch.css:255,273). A scene card in the branch editor and a node
in the task graph are drawn HTML with a `getBoundingClientRect()`. They are not clickable,
and they carry no listener.

Two things follow:

- **The load-bearing rule does not reach branch and taskgraph.** `act(node, offer, run)`
  cannot wire a click that does not exist on the node. For branch and taskgraph the anchor
  would be a description after all, which is the failure mode the plan rules out in its
  opening. §10's row "Button rewired, anchor stale → structurally impossible" is true for
  the asset editor and false for the story graph. Branch and taskgraph need a second
  anchor flavour that wires through `pick`: keyed by node id, with the rect derived from
  `layout` through the viewport transform, and verified against `pick()` rather than
  against `elementsFromPoint`.
- The oracle in §7 would fire ⚠ on every one of their anchors, and every warning would be
  correct and useless. The point at a card's centre lands on the canvas element by design.
  An oracle that flags the app's intended arrangement as a disagreement will be muted
  within a week. The oracle must treat a hit-test-transparent node as anchored through
  `pick` rather than through the DOM.

The branch editor exists to answer the tour request "show me how to branch this scene", so
it matters more than its share of the surface suggests.

## 3. The props are not known when the anchor is recorded

`Anchor` declares `props: Record<string, PropValue>`, the field §3 calls "the subject it
would run against". For a large fraction of the app's mutating surfaces there is nothing
to record, because the human is about to type the props:

| Surface                          | Command             | Prop supplied at click time                  |
| -------------------------------- | ------------------- | -------------------------------------------- |
| `rungBox` (`asset.ts:1108`)      | `art.setNotes`      | `notes` — the textarea                       |
| `promoteStrip` (`asset.ts:1003`) | `art.promote`       | `variant` — a typed id                       |
| `promptStrip` (`asset.ts:1061`)  | `art.redraw`        | `prompt`, `title`                            |
| `customBox` (`asset.ts:938`)     | `prompt.setCustom`  | `text`                                       |
| `chunkBox` (`asset.ts:900`)      | `prompt.setChunk`   | `text`, and `op` from which button opened it |
| script/timeline row edits        | `story.setLineText` | the line                                     |

This has three consequences:

- **Part II is missing a step kind.** It lists `command`, `select`, `gesture`. It needs
  `input`, a step that marks a box, states what to put in it, and advances when the value
  is committed. The plan opens with its own example "show me how to change the café's
  night lighting", which resolves to `art.setNotes(target='location:cafe/night')` — a box
  to fill in rather than a button. The step vocabulary as written cannot express the
  feature's headline scenario.
- **Two of the four `chunkActs` buttons run no command at all.** §1 says `chunkActs`
  "builds four `prompt.setChunk` invocations inline"; asset.ts:863 builds two (`mute`,
  `clear`) plus two that open an editing box (asset.ts:878). Teaching "say this clause in
  your own words" takes three steps: click Replace…, type, Ctrl+S. Only the first has an
  anchor with complete props.
- **§6's `wrong-subject` needs its comparison defined, not just tested.** The comparison
  currently reads "id matches, props do not", which returns `wrong-subject` for every
  input step against a partially-populated anchor. §12 lists "props subsumption" as a test
  name, and §6 must state that subsumption as a rule: an anchor's props must subsume the
  step's, and the human supplies the unrecorded keys.

## 4. Three of the five rules in §1's table are not `Action`-shaped

§1 asserts "those objects are the anchor payloads". This claim was checked against
`rules/assetview.ts` and `rules/promptview.ts`:

| Rule                 | Actually returns                                                                     | Action-shaped?                                                        |
| -------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `approveAction`      | `{ok, id, props, label}`                                                             | yes                                                                   |
| `condenseAction`     | `{ok, id, props, label, note}`                                                       | yes                                                                   |
| `modeStrip[].action` | `{ok, id, props}`                                                                    | yes                                                                   |
| `promoteAction`      | `{ok: true, locationId}`                                                             | **no** — `art.promote`'s id and props are assembled at `asset.ts:243` |
| `originAction`       | `{ok, kind:'open', editor, subject, publish, label}` \| `{kind:'scroll', to, label}` | **no**                                                                |

`originAction` is the awkward case, and the plan should state it rather than leave it to
be found during stage 2. Its `open` variant is two acts in a load-bearing order: publish
the `ui.*` fields, then `view.open`, because the new pane reads the selection on its first
`update()` (promptview.ts:96-103, asset.ts:376-383). That is a `select`-then-`command`
pair rather than one anchor. Its `scroll` variant is not a command at all. Neither problem
is fatal, but "grow rules for the inline cases" understates the work when two named rules
have to be re-shaped, and one of them cannot be.

`replaceAction` (`{ok, slot}`) and `promptEditable` (`{ok, prompt, title}`) work the same
way. Both are display rules that gate a strip, and neither is an invocation.

## 5. Menus are transient — and `menuFor` is the map the plan went looking for

The app menu is a `MenuTemplate` of callbacks built on demand (editors/header.ts:227), and
context menus are built the same way (showmenu.ts:44). No element exists to anchor to
until the author has opened the menu, which is the moment the tour needed to point at it.
A whole class of commands is reachable only there: `workspace.create`, `workspace.pick`,
`project.setKey`, `upload.pick`, `view.saveLayout`, `view.resetLayout`,
`notify.deleteAll`. The closing "no anchoring of chrome" in § reads as a scoping choice,
but it also caps how much the tour can cover, and the palette is where those commands
remain reachable. Say so under "what this deliberately does not do".

But the same reading turns up something the plan misses entirely. `menuFor(node)`
(`renderer/pathux/doctree.ts:214`) is already a pure function returning
`{label, id, props, form}` entries per node kind. It is a statically enumerable map, in
the shape of an `Offer`, from the document tree to the commands available for each node
kind, and it does not use a browser. It covers a large slice of the catalog, it is unit
testable in node today, and it needs no CDP sweep at all. §8's "measure it instead" is
right for drawn surfaces but unnecessary here, because the doctree half of the map is a
pure derivation. It should be stage 1, before `sweep-anchors.mjs`. It is the cheapest
coverage in the app, and it validates the `Offer` shape against real data before any
wiring changes.

## 6. `@vn/debug2d` has not solved shadow piercing

§7: _"`packages/debug2d/src/dom/source.ts` already solved it; the logic can be copied."_

The string `shadow` does not occur anywhere in packages/debug2d/src. `snapshotDom` walks
`el.children` only (dom/snapshot.ts:147), and the oracle calls `doc.elementsFromPoint`
unmodified (dom/source.ts:52). debug2d does not pierce shadow roots. It therefore cannot
see any editor content, because `VnEditor.appendSurface` mounts every surface in a shadow
root. There is nothing to copy.

A working precedent exists elsewhere and is less convenient: `verify-prompt-chunks.mjs`
injects a probe that recurses `node.shadowRoot` manually
(scripts/verify-prompt-chunks.mjs, the `PROBE` constant). Generalize that probe, and write
it as a real module rather than a CDP-injected string.

There are two knock-on effects. The open decision "must be proven to sit above every
path.ux stacking context — a `@vn/debug2d` question, answered in dev" cannot be answered
by debug2d as it stands. The oracle must also test containment rather than identity,
because a path.ux `Button` paints into an inner `<canvas class="canvas1">`
(vendor/path.ux/scripts/widgets/ui_button.ts:378) which is what `elementsFromPoint` will
return.

## 7. `anchors.json` cannot be both committed and under `dist/`

§8 specifies a write to `apps/desktop/dist/anchors.json`. The open decision leans toward
committing that file, "for the same reason `commands.json` is generated at build time and
consumed by external tooling."

`dist` is gitignored (`.gitignore`), and `git ls-files` finds no `commands.json`. The
cited precedent is an argument against committing the file. If drift should be a
reviewable diff (and the coverage ratchet needs a baseline in the tree either way), the
file has to live somewhere else. Either way the decision needs restating, because the
evidence it cites argues against the decision as written.

## 8. Smaller corrections

- **"all 73 commands" is stale.** `apps/desktop/src/main/commands/*.ts` declares ~96 ids.
  The ratchet's denominator should be read from the live catalog, not written into the
  plan.
- **`update()` is not per frame.** path.ux drives updates off `setInterval(cb, 20)`
  (ui_base.ts:3101). That interval is close enough for re-resolution, but the overlay is
  not an editor and will need its own `requestAnimationFrame` loop rather than an
  inherited one.
- **`openPalette` is idempotent by early return** (`palette.ts:130`): if the palette is
  already open, a second call with a different `preselect`/`overrides` is ignored. A
  multi-step palette-route tour cannot retarget an open palette without a change to
  `openPalette`.
- **`timeline.ts` already stores an index in a data attribute** (`dataset['lineIndex']`),
  which §4 bans by name. It is one conversion, but it is the rule's first counterexample,
  so the text should call it out rather than leave a reader to find it.
- **`window.__vnAnchors` needs a global.d.ts entry** — renderer/global.d.ts declares only
  `api` and `__vnDebug`. `window.__vnAnchors` also uses a different exposure mechanism
  from `window.vn`, which the preload bridge supplies (src/preload/index.ts:55) rather
  than the renderer.

## What this implies for the staging

The plan's stage order is sound; three things move into or ahead of stage 1:

1.  1. Route `branch.ts`, `script.ts` and `timeline.ts` through `bridge.exec` (finding 1).
       Every command the shell runs must pass through one seam before the rest of either
       half can be trusted.
2.  2. Derive the doctree half of the map from `menuFor` (finding 5). The derivation is
       "pure" (free of side effects) and node-testable, needs no sweep, and exercises the
       `Offer` shape against real entries before any call site is converted.
3.  Settle the `input` step kind and the props-subsumption rule (finding 3) before
    `resolveAnchor` is written, since both change its signature.

Findings 2 and 6 are the ones that could still block the overlay. If graph-editor anchors
need a `pick`-based flavour and shadow piercing has to be written from scratch, stage 6 is
materially larger than the plan's "comparatively thin" framing of Part II suggests. Stages
1-5 are unaffected. The plan uses that fact to argue the anchor layer should stand alone,
and the argument holds.

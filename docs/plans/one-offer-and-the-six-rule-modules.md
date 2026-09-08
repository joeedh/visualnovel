# One `Offer`, and the six rule modules unified

Status: **planned**. Plan 1 of
[`ux-behaviour-model-tasklist.md`](ux-behaviour-model-tasklist.md); depends on nothing,
and plans 2, 3 and 4 depend on it. Pressure-tested on 2026-09-07; the findings and what
was done with each are in [Findings](#findings).

## Context

The anchor layer's design rule is that one object wires a control's click and records what
the click runs, so the two cannot drift
([`../reference/guided-tours.md#design-rule`](../reference/guided-tours.md#design-rule)).
That object is an `Offer`, and today it is smaller than what a control needs, so the rest
is supplied beside it and can drift after all. Measured from the tree on 2026-09-07:

- **`Offer` is two branches with almost nothing on them.** `renderer/rules/anchors.ts:36`
  declares
  `(Action & { ok: true; label?: string }) | { ok: false; reason: string; id?: string }`.
  No tooltip, no `supplies`, no `on`, no `form`.
- **The rest travels in `ActOptions` at the call site.** 61 `act()` and `record()` calls
  across 15 editor files pass it: 38 `act`, 23 `record`. 25 pass `supplies`, 19 pass `on`,
  5 pass `form`, 24 pass nothing. `about`, `key` and `publishes` are passed by no call at
  all; `publishes` reaches the registry only through `item()` and `pickItem()`,
  positionally. `AnchorPass.pick()` has no callers.
- **The tooltip is a third copy, written by hand.** 20 of the 61 sites copy the refusal
  into `.description` or `.title` themselves, one of them (`header.ts:397`) by retyping
  `runAction`'s sentence verbatim rather than reading it. Three sites draw a control that
  can be refused there and never show the reason: `asset.ts:594` (Regenerate with no
  asset), `asset.ts:829` (Show task with no task) and `timeline.ts:328` (`+ shot` with no
  scene). One recorded field, the chunk box at `asset.ts:1110`, has no tooltip. CLAUDE.md
  requires a tooltip on every interactive element and nothing enforces it.
- **The offer type is restated seven times.** `ApproveAction`, `PromoteAction`,
  `ReplaceAction`, `RedrawAction`, `TaskAction` (`rules/assetview.ts`), `CondenseAction`
  and `ModeButton['action']` (`rules/promptview.ts`) are each structurally an `Offer` with
  a narrower props type. `RegenerateAction` is an offer with no refused branch. A change
  to `Offer` reaches none of them.
- **Nothing enumerates a module's controls.** The six modules that return offers
  (`headerbar`, `convobar`, `assetview`, `projectbar`, `promptview`, `reportconvo`) export
  one function per control, each with its own signature. A headless reader has no function
  to call that returns every control the module describes.
- **path.ux has the refusal type and the composer, and the app reaches one of them.**
  path-controller commit `18cf57c` gave `ToolOp.canRun` a `Refusal`
  (`{ reason: string; description?: string }`) and `UIBase` a `refusalReason` that a
  tooltip composes above the widget's own description, on read
  (`vendor/path.ux/scripts/core/base/ui_base_props.ts:64-96`). `Refusal` reaches the
  `pathux` barrel through `path-controller/controller.ts`, so
  `import type { Refusal } from 'pathux'` type-checks in the renderer today.
  `composeTooltip`, the function that orders reason, long description and the widget's own
  text, does not reach the barrel: `ui_base.ts` imports it as a namespace and re-exports
  nothing, although
  [`menu-item-disabling.md`](../../vendor/path.ux/documentation/plans/menu-item-disabling.md)
  says at one point that it joins the barrel deliberately and at another that it reaches
  no barrel.

The companion report
([`../research/formalizing-the-rules-modules.md`](../research/formalizing-the-rules-modules.md))
proposes the shape this plan builds. The tasklist's
[What refusals look like once path.ux carries them](ux-behaviour-model-tasklist.md#what-refusals-look-like-once-pathux-carries-them)
changes one thing in that proposal: the refused branch carries path.ux's `Refusal` rather
than a bare `reason`.

## Decisions this plan settles

- **`Offer` carries everything the anchor records, and both branches share a base.** The
  base is `id`, `label`, `tooltip`, and the optional `on`, `supplies` and `form`. The
  accepted branch adds `props`; the refused branch adds `refusal: Refusal`. `on` sits on
  the base because a refused control keeps the key of its enabled twin (a mode segment
  refused while the prompt is frozen has the same `on` as when it is not). `supplies` and
  `form` sit on the base because the module computes them once for the control, whichever
  branch it ends up on, and the sweep's `stack.check` exemption reads them off a refused
  anchor too.
- **`tooltip` and `label` are required on both branches.** The tooltip rule in CLAUDE.md
  becomes a type error. On the refused branch `tooltip` is still the control's own
  sentence, the one it shows when enabled, and the refusal is composed above it for
  display; the two are never merged in the data. That answers the reports' open question
  of whether a refusal's tooltip is a field or always the reason: it is a field, and the
  reason is another field. A control whose enabled sentence and refusal are today one
  string (`GrantBox.tooltip` in `reportconvo.ts`) is split into two.
- **The refused branch carries `Refusal`, imported from path.ux.** `refusal.reason` is the
  normative sentence, the one `stack.check` is compared against; `refusal.description` is
  presentation and is never compared. The type is imported rather than restated so that
  one shape spans the op, the widget, the rule module and the record. No path.ux change is
  needed for the import.
- **`act()` and `record()` apply the offer to the node: click, enabled state and
  tooltip.** Today they wire the click and record the anchor, and the caller sets
  `disabled` and the tooltip by hand. After this plan `applyOffer(node, offer, compose)`
  sets `disabled = !offer.ok` where the node has a `disabled` property, and writes the
  tooltip: a path.ux widget takes `description = tooltip` and `refusalReason = refusal`,
  and path.ux composes them on read; a raw DOM node takes
  `title = compose(refusal, tooltip)`. `compose` is path.ux's own `composeTooltip`, passed
  in by the registry so that `rules/anchors.ts` stays free of a runtime `pathux` import
  and the ordering has one author. The drift the design rule forbids for the click is
  thereby forbidden for the tooltip too. A site needing a refused control to stay
  clickable does not exist in the inventory, and one that appears later is a wrong offer
  rather than a reason for an escape hatch.
- **`applyOffer` is also the way to re-present a control between passes.** The Compact
  button is retitled in place on every step of a turn (`convo.ts:394`, `sayCompact`),
  because rebuilding the bar would close a menu open over it. Such a site calls
  `applyOffer(node, offer, compose)` with a fresh offer; the anchor record refreshes on
  the next pass, exactly as the hand-set `disabled` did. `applyOffer` is exported for that
  reason, not only for its test.
- **A node may carry several offers only if they present the same way.** The header's View
  button records `view.open` and `view.applyLayout` on one node (`header.ts:302-311`),
  because the menu it opens holds both. `record()` keeps a per-pass map from node to the
  first offer applied; a later `record()` on the same node whose `ok` or `tooltip` differs
  throws, so the collision is a test failure rather than a silent overwrite.
- **`ActOptions` is deleted, not shrunk.** `act(node, offer, run)` and
  `record(node, offer)` take nothing else. `about` goes because `id` is required on the
  refused branch. `key` and `publishes` go because no `act` or `record` call passes them;
  `item()` and `pickItem()` keep their positional `publishes`. The `anon:` key for an
  offer with no id goes with `about`. `AnchorPass.pick()` goes with `ActOptions`, since
  nothing calls it; `pickItem()` stays, so `via: 'pick'` anchors still exist.
- **The key is derived from the offer, and the discriminators do not move.**
  `keyOf(offer)` in `rules/anchors.ts` replaces the registry's private `keyFor(id, on)`:
  `cmd:<id>`, or `cmd:<id>#<on>`. Every module writes the `on` its editor writes today:
  `chunkActs` writes `${chunk.key}/${act.key}`, `dropRefAction` writes
  `${chunk.key}/${pin}`, the mode strip writes the segment id, and so on. No key in
  `anchors.json` changes.
- **`controls(state)` returns a list, and the per-control functions stay.** Each of the
  six modules exports `controls(state): readonly Offer[]`, in the order the editor draws,
  with keys unique within the list. A list rather than a map because draw order is
  information a map loses and lookup by key is one `find`. The existing functions
  (`approveAction`, `modeStrip`, `chunkActs` and the rest) stay exported and remain the
  editors' call path; `controls` composes them. A test per module asserts that the key set
  of `controls(fixture)` equals the union of the keys the individual functions produce,
  which is what catches a control `controls` forgot. Rewriting the five editors to draw by
  key lookup is not done here: plan 2 rewrites every editor's offer path mechanically, and
  doing it twice is waste.
- **`controls()` is complete for the module, not yet for the editor.** The five editors
  these modules serve also build offers inline, with no module function behind them: the
  header's `view.open`, `view.applyLayout` and `agent.setModel`; the convo bar's
  `agent.setModel` and `agent.openThread`; the asset editor's Download, `agent.fixAsset`,
  the reference thumbnails, the `⇱` origin open, and the per-rung `art.setNotes` and
  `art.setSeed` boxes; the report pane's Start and `report.stop`. This plan gives each of
  them a label and a tooltip where it stands and leaves it there. Moving them into a
  module is plan 2's extraction, which is the same work for these five editors as for the
  ten that have no module at all. The completeness test above therefore cannot catch a
  control that has no function; plan 3's comparison against the sweep is what catches
  that.
- **The `*_SUPPLIES` exports move onto the offers.** `supplies` is a fact about a control,
  so the module writes it on the offer and the editor reads `offer.supplies` where it
  needs the names at commit time. A constant whose consumer is a module function
  (`PROMOTE_SUPPLIES`, `REDRAW_SUPPLIES`, `CHUNK_SUPPLIES`, `REF_SUPPLIES`,
  `STYLE_SUPPLIES`, `WRITE_SUPPLIES`) is folded into that function in stage 3 or 4. A
  constant whose only consumer is an inline offer (`MODEL_SUPPLIES`, `EDITOR_SUPPLIES`,
  `LAYOUT_SUPPLIES`, `THREAD_SUPPLIES`, `NOTES_SUPPLIES`, `SEED_SUPPLIES`, `KEY_SUPPLIES`,
  `CREATE_SUPPLIES`, `RENAME_SUPPLIES`) is written into that literal and deleted.
- **The types stay in `renderer/rules/anchors.ts`.** The root `tsconfig.json` maps no
  `pathux` path, so `src/shared/` cannot import `Refusal` today; only the renderer's
  tsconfig can. Moving `Offer` to `src/shared/` is plan 2's decision, and it would need
  that mapping first.
- **`Anchor`, `AnchorDump` and `anchors.json` keep their shape.** `Anchor.reason` is read
  from `refusal.reason` and stays a string, because the tour's resolver and `guide` read
  it and plan 7 replaces the dump wholesale. No new field reaches `anchors.json`. The
  tooltip is not in the dump, so the sweep cannot see the tooltip changes this plan makes;
  the sweep's disagreement check compares `offer.ok` against `stack.check` and never reads
  the DOM's `disabled` either.
- **Extension fields are intersections, never restatements.** A module that needs more
  than the base (`RegenerateAction`'s `act` and `note`, `TaskAction`'s `publish`,
  `PromoteAction`'s `locationId` and `variants`) returns `Offer & { … }`. A narrower props
  type is `Extract<Offer, { ok: true }> & { props: … }`. The seven local unions are
  deleted. `regenerate()` in the asset editor keeps branching on `act`.
- **`OriginAction` is left alone.** Its `scroll` branch runs no command, so it is not an
  offer; it belongs to plan 4's pseudo-command vocabulary. The `view.open` offer
  `asset.ts:994` builds from it gains a label and a tooltip like every other inline offer.

## What changes

### Stage 1 — path.ux exports `composeTooltip`

In `vendor/path.ux/scripts/pathux.ts`:

```ts
export { composeTooltip } from "./core/base/ui_base_props";
```

- A runtime export, so the built bundle's `Object.keys` grows by exactly that one name;
  the diff against a pre-change baseline is recorded in the commit message, per path.ux's
  CLAUDE.md. `menu-item-disabling.md` is corrected in the same commit so that its two
  statements about `composeTooltip` agree with the tree.
- The parent records `75130afa` for `vendor/path.ux` and the checkout sits at `5a44583a`,
  five commits ahead, on the author's own work. Bumping the gitlink for this stage carries
  those commits with it, deliberately. Per path.ux's CLAUDE.md the submodule's default
  branch is not advanced without asking, so the submodule commit and the bump are the one
  step of this plan that waits on a word from the author. Every later stage can be built
  and tested against the checkout before that word, since the renderer resolves `pathux`
  to the checkout's own sources.
- `pnpm --dir apps/desktop build:pathux-types` (the first half of `pnpm check`)
  regenerates `apps/desktop/dist/pathux-types/pathux.d.ts`, which is what
  `renderer/tsconfig.json` resolves `pathux` to.
- No jest test imports `renderer/pathux/tour/anchors.ts`, so the registry may import
  `composeTooltip` at runtime. `rules/anchors.ts` may not: the node-only `@vn/desktop`
  jest project maps no `pathux` module name, which is why `applyOffer` takes the composer
  as an argument.

### Stage 2 — the type, widened additively

`renderer/rules/anchors.ts`:

```ts
import type { Refusal } from "pathux";

/** What every control carries, on either branch. */
export interface Control {
    id: string;
    /** What the control says on screen: a button's text, a field's placeholder. */
    label: string;
    /** The control's own sentence, shown when enabled and beneath the refusal when not. */
    tooltip: string;
    /** Tells this control apart from another running the same command in the same pane. */
    on?: string;
    /** Prop names the click reads from the widget at commit time. */
    supplies?: readonly string[];
    /** The click opens the command's own form, so every prop is typed there. */
    form?: boolean;
}

export type Offer =
    | (Control & { ok: true; props: Record<string, PropValue> })
    | (Control & { ok: false; refusal: Refusal });

export const keyOf = (offer: Control): string =>
    offer.on === undefined ? commandKey(offer.id) : `${commandKey(offer.id)}#${offer.on}`;

/** The keys that appear more than once, which is what a `controls()` test asserts is empty. */
export function duplicateKeys(offers: readonly Control[]): string[];

/** How a refusal and a description become one tooltip string; path.ux's `composeTooltip`. */
export type Compose = (refusal: Refusal | undefined, description: string) => string;

/** What `act()` writes on the node from the offer. Structural, so a fake node can test it. */
export function applyOffer(node: OfferNode, offer: Offer, compose: Compose): void;
```

- `OfferNode` is
  `{ disabled?: boolean; description?: string; refusalReason?: unknown; title?: string }`.
  A path.ux widget is told apart from a raw DOM node by `'refusalReason' in node`, which
  is true for a `UIBase` instance because the accessor lives on the class, and false for
  an `HTMLButtonElement`.
- During this stage only, `label` and `tooltip` are optional and the refused branch
  carries `reason` as it does today with `refusal` optional beside it. `id` is required on
  both branches from here, which every refused literal in the tree already satisfies, so
  `ActOptions.about` is dead in this stage rather than in stage 5. `Anchor.reason` reads
  `refusal?.reason ?? reason`, so the current guarantee that a refused anchor carries a
  sentence survives the transition. `act()` and `record()` call `applyOffer` only for an
  offer carrying `tooltip`. The transitional shape is removed in stage 5 and must not
  outlive the branch.
- `act()` and `record()` accept both the old `ActOptions` argument and the fields on the
  offer, offer first. `record()` gains the per-pass node map described in Decisions.

### Stage 3 — the six modules, and the five editors they serve

For each module: delete its local unions, put the tooltip on every offer, put `supplies`,
`on` and `form` where the editor passed them, add `controls(state)`, and update its test.
Then update the editor so each `act`/`record` call passes the offer alone and the line
after it that set `disabled`, `description` or `title` from the offer is deleted. The
editor's inline offers (listed under Decisions) get `label` and `tooltip` in this stage
too, since the file is open.

| Module           | `controls` state                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headerbar.ts`   | `{ busyWhat: string; live: boolean; agentMode: string }`                                | `runAction`'s tooltip is the live/preview sentence `header.ts:399` writes today; the retyped refusal goes. `modeAction`'s tooltip is the header's plan/execute sentence (`header.ts:355`); the convo bar draws the same offer with a different sentence (`convo.ts:224`), and the header's is kept. `stopAction`'s tooltip is `controls.stops` from `busy.ts`.                                                                                      |
| `convobar.ts`    | `{ convo: Convo; opened: OpenedThread \| undefined; model: string; agentMode: string }` | `compactAction`'s enabled tooltip is `contextDetail(state)` from `convo.ts`, which moves into the module. `controls` includes `modeAction` from `headerbar.ts`, because the pane draws it; which editor's list owns a control two panes draw is plan 2's question.                                                                                                                                                                                  |
| `assetview.ts`   | `AssetInfo \| undefined`                                                                | `nothingShown` (`asset.ts:1573`) moves here: `controls(undefined)` returns the bar's three refusals, and the per-control functions keep taking `AssetInfo`. `RegenerateAction` becomes `Offer & { act: 'requeue' \| 'pipeline'; note?: string }` and keeps `hint` as its tooltip. `PROMOTE_SUPPLIES` and `REDRAW_SUPPLIES` fold into their functions; `NOTES_SUPPLIES` and `SEED_SUPPLIES` are written into the editor's two inline records.        |
| `promptview.ts`  | `PromptView`                                                                            | `ModeButton.action` becomes `offer`; `ChunkAct.title` is deleted and its text becomes `offer.tooltip`; `chunkActs` writes `on: \`${chunk.key}/${act.key}\``and the two supplies lists itself;`dropRefAction`writes`on: \`${chunk.key}/${pin}\``. `controls` flattens the strip, the condense and check buttons, the custom box and save, and every chunk's five acts and reference drops. The chunk boxes and the reference thumbnails stay inline. |
| `projectbar.ts`  | `{ opened: boolean; dirty: boolean }`                                                   | Gains `tests/projectbar.test.ts`, which it does not have today.                                                                                                                                                                                                                                                                                                                                                                                     |
| `reportconvo.ts` | `{ boxes: Record<'source' \| 'detail', GrantBox> }`                                     | `GrantBox` splits `tooltip` into the box's own sentence and an optional `refusal`, since today `tooltip` holds the refusal when refused (`reportconvo.ts:86`); `grantBox`'s test changes with it. `grantAction` writes `on: kind`. Start and `report.stop` stay inline.                                                                                                                                                                             |

The `controls` test in each module's test file: for two or three fixtures, the key set of
`controls(fixture)` equals the union of `keyOf` over the individual functions, and
`duplicateKeys` is empty. Existing tests that used `toEqual` on an offer gain the new
fields; tests that used `toMatchObject` are unchanged.

The Compact button's `sayCompact` becomes a call to `applyOffer` with a fresh
`compactAction`, and is the one sanctioned tooltip write outside a pass in these five
editors.

### Stage 4 — the remaining call sites

The ten editors that build offers inline, and the two editor-local builders. Each inline
literal gains `label` and `tooltip`, moves its `ActOptions` onto the offer, and builds its
refused branch as `{ ok: false, refusal: { reason } }`. The caller's own `disabled`,
`description` and `title` lines for that node are deleted.

- `onboarding.ts:206`, `:275`, `:327` — today the tooltip is written first and the refusal
  copies it (`reason: button.title`). Inverted: the offer is built first and `act` writes
  the tooltip. `KEY_SUPPLIES` is written into the offer at `:275` and deleted from
  `rules/keysetup.ts`.
- `documents.ts:235`, `:558` — `CREATE_SUPPLIES` and `RENAME_SUPPLIES` are written into
  these two offers and deleted from `rules/doctreebar.ts`.
- `branch.ts:333`, `:618`, `:706`. At `:618` the cost notice `noticeForCheck` writes onto
  the button after `act()` (`branch.ts:625`) becomes the offer's tooltip, since the offer
  is already built from the same check.
- `graph.ts:584`; `script.ts:441`, `:561`, `:795`; `tasks.ts:199`; `timeline.ts:328`,
  `:461`.
- `nodes.ts:404` `groupOffer` and `ungroupOffer` — gain the `GROUP_WHAT` / `UNGROUP_WHAT`
  tooltips the editor sets beside them today.
- `docbuffer.ts:116` `saveOffer` — gains label and the tooltip `skills.ts:226` and
  `wiki.ts:193` each set by hand today, and `WRITE_SUPPLIES` moves onto it.

Behaviour changes this stage and stage 3 make, each deliberate:

- Six `record()` sites carry an offer that can be refused: `asset.ts:1150` (the custom
  prompt box), `report.ts:312`, `report.ts:435`, `onboarding.ts:275`, `:327` and
  `graph.ts:584`. Five of them already set `disabled` by hand from the same condition, so
  `applyOffer` changes nothing there. The custom box does not: a frozen prompt's box can
  be typed into today and refuses on commit. After this plan it is disabled with the
  refusal as its title, because a box whose commit is refused should not accept the words.
- Two `act()` sites draw a refused control without disabling it: `timeline.ts:328`
  (`+ shot` when no scene is on screen) and `asset.ts:829` (Show task when the failure
  names no task). Both become greyed with their reason as the tooltip. The sweep cannot
  see this, since it never reads the DOM's `disabled`; it is checked by eye over CDP in
  stage 6.
- `applyOffer` writes `disabled = false` for an accepted offer, which cannot un-grey a
  widget whose container is disabled (`UIBase.disabled` includes the parent's state), and
  such a widget would then show no refusal. No anchored widget sits in a disabled
  container today; the assumption is stated so that the first one is recognised.

Not touched, and recorded here so nobody looks for them: `pathux/chrome/notifications.ts`
has a module-local `act` helper that runs `exec` directly, and its four `notify.*`
controls are not anchors. The tasklist's line saying the notification popup calls the
anchor layer's `act()` is wrong and is corrected in stage 6. Those four controls are plan
2's, with the rest of the unextracted offers.

### Stage 5 — narrow the type

- `label`, `tooltip` and `refusal` become required; `reason`, `key`, `publishes`,
  `ActOptions` and `AnchorPass.pick()` are deleted; `act(node, offer, run)` and
  `record(node, offer)` are the whole signature; the `anon:` key path goes.
- `guided-tours.md`'s `Offer` type is the one in the file, so `pnpm check` on the tree and
  a grep for `ActOptions`, `about:`, `.reason` and `_SUPPLIES` across `apps/desktop` and
  `docs/` are the completion test for this stage. A second grep, for `description =` and
  `title =` on the lines after each `act`/`record` call, catches a hand-written tooltip
  that would silently overwrite `applyOffer`'s.

### Stage 6 — the sweep, and the docs

- `node scripts/sweep-anchors.mjs` is re-run, because the plan touched
  `renderer/pathux/editors/**`, and `anchors.json` is committed. `sweptAt` and `gitSha`
  move on every run. Nothing else should: the tooltip is not in the dump, no key's
  discriminator changed, and no refusal's wording changed. A diff in `key`, `enabled` or
  `refused` is a finding, and the disagreement count must stay at zero.
- Over CDP, the two newly greyed controls and the frozen custom box are looked at, since
  the sweep cannot.
- [`../reference/guided-tours.md`](../reference/guided-tours.md): the `Offers` section
  shows the new type; the `ActOptions` table is replaced by the base fields;
  `Recording anchors` says what `act()` now applies to the node and the
  one-node-several-offers rule; the `dom`/`pick` table drops `pick()`; the `Files` table
  gains `applyOffer` and `keyOf`.
- CLAUDE.md's tooltips convention gains one sentence: a control drawn through `act()` or
  `record()` gets its tooltip from the offer, and the two mechanisms named there are what
  `applyOffer` writes through.
- [`ux-behaviour-model-tasklist.md`](ux-behaviour-model-tasklist.md): row 1's checkbox,
  and the `act()` file count in "What the numbers are today" (thirteen editors, not
  fourteen files).
- [`index.md`](index.md): this plan's row flips to shipped and the file moves to
  `archive/`.
- The two research reports are left as written; each states that it describes the tree at
  its own date.

## Testing

- **`rules/tests/anchors.test.ts`** — `keyOf` with and without `on`; `duplicateKeys`;
  `applyOffer` against two fake nodes, one with a `refusalReason` accessor and one with
  only `title`, on an accepted and a refused offer, with a fake `compose`, asserting
  `disabled`, the description and refusal on the first, and that the second's `title` is
  what `compose` returned.
- **Each of the six module tests** — the `controls` block described in stage 3, plus the
  new `projectbar.test.ts` and the changed `grantBox` test.
- **`pnpm check`, `pnpm test`, `pnpm lint`** green at every stage, which is the point of
  stage 2's transitional shape.
- **Live, over CDP** — the sweep in stage 6, and the three behaviour changes looked at by
  eye.

## Risks

- **`applyOffer` overwrites a `disabled` a site set for another reason.** The inventory
  found none: every `disabled` beside an anchored node tracks the offer, and the two
  refused controls that were never disabled are listed above as deliberate changes.
- **A tooltip line left after an `act()` call silently wins.** Stage 5's second grep is
  what catches it. The sweep cannot, because the tooltip is not in the dump.
- **`'refusalReason' in node` misclassifies a node.** A raw DOM node never has the
  property and a `UIBase` always does, so the only way to get it wrong is a third kind of
  node, which the layer does not have.
- **`label` required on a recorded field forces text nobody reads.** A box's label is its
  placeholder or its heading, which the editor already has; the field costs one string per
  site and gives the model the control's name.
- **The tasklist's tooltip rule depends on `disabled` being the authority.** A refusal on
  an enabled path.ux widget is not shown. `applyOffer` sets both from the same branch, so
  the inert case cannot be produced through `act()`.
- **The gitlink bump carries five commits that are not this plan's.** Stated in stage 1
  and confirmed with the author before the bump.

## Follow-ups deliberately not in scope

- **The ten inline editors' rule modules** (plan 2), the inline offers left in the five
  module-served editors, and the notification popup's four unanchored controls.
- **The `controls()` driver, fixtures and the derived model** (plan 3). This plan gives it
  six functions to call and the test that each is complete for its module.
- **Pseudo-commands** (plan 4): `OriginAction`'s scroll branch, `ChunkAct.opens` and
  `picks`, the View button's menu, and every closure that is not a command.
- **Widening `CheckResult` to carry a long description.** A command-backed refusal fills
  `reason` and leaves `refusal.description` undefined, as the tasklist argues.

## Findings

From the fresh-context review on 2026-09-07. Each is fixed in the text above or answered
here.

1. **`Refusal` already reaches the `pathux` barrel** through
   `path-controller/controller.ts`, so the original stage 1 (exporting it) had no effect
   and asked the author for a submodule commit for nothing. **Fixed.** Stage 1 now exports
   `composeTooltip`, which is genuinely absent from the barrel and is the one path.ux edit
   that earns the touch, and corrects the contradiction in `menu-item-disabling.md`.
2. **The `anchors.json` expectation was wrong three ways**: `refused` is written from
   `reason`, which the plan does not change; `sweptAt` and `gitSha` move every run; and
   `on: chunk.key` would have collided four acts onto one key where the editor writes
   `${chunk.key}/${act.key}`. **Fixed.** The modules write the discriminators the editors
   write today, and stage 6 expects only the two stamps to move.
3. **The sweep cannot verify enabled state on the DOM**, and two refused controls that
   were never disabled become greyed. **Fixed.** Both are listed as deliberate changes,
   checked by eye; the container-disabled assumption is stated.
4. **The inventory counts were inflated**: six of the ten "reason never reaches the
   tooltip" sites cannot be refused at that call site, `header.ts:397` copies the sentence
   verbatim rather than restating it, and the two stop buttons get a title from
   `stopTitle`. **Fixed.** Context now says 20 hand copies, three refusable sites with no
   reason shown, one field with no tooltip.
5. **The custom box paragraph named a site that cannot be refused** (`asset.ts:1110`) and
   missed five refusable `record()` sites. **Fixed.** All six are listed; only the custom
   box changes behaviour.
6. **Two offers on one node** (the View button) had no rule. **Fixed.** Same presentation
   or `record()` throws.
7. **`GrantBox.tooltip` is the refusal when refused**, so `reportconvo` would compose the
   reason twice. **Fixed.** `GrantBox` splits into `tooltip` and `refusal`.
8. **Tooltips are written after `act()` for reasons the offer could not carry at draw
   time**: `sayCompact` retitles in place, `branch.ts:625` adds a cost notice, and the
   mode button has two sentences. **Fixed.** `applyOffer` is the sanctioned re-present
   call; the cost notice becomes the offer's tooltip; the header's sentence is kept.
9. **The `controls` state types did not cover what the editors draw.** **Answered, and the
   scope made explicit.** `controls()` is complete for the module's own functions, not for
   the editor; the inline offers are enumerated and left for plan 2. `convobar`'s state
   gains `agentMode`; `regenerateAction` keeps `act`; `controls(undefined)` is how
   `nothingShown` enters the module.
10. **Stage 4 missed the inline offers inside the five module-served editors and
    `pick()`.** **Fixed.** Those literals are stage 3 work; `pick()` is deleted in
    stage 5.
11. **The submodule pointer is already five commits behind the checkout.** **Fixed.**
    Stage 1 says the bump carries them, deliberately, and waits on the author.
12. **`composeTooltip`'s absence from the barrel contradicts path.ux's own plan.**
    **Fixed** by finding 1.
13. **The transitional type lost a guarantee** (a refused offer with neither `reason` nor
    `refusal`), and `about` dies in stage 2, not 5. **Fixed.** `reason` stays required
    until stage 5 and `refusal` is optional beside it; `about`'s stage is corrected.
14. **Confirmed by the review**: the `'refusalReason' in node` test, on-read composition
    while disabled, the type-only import's erasure under `verbatimModuleSyntax`, the zero
    `key`/`publishes` call sites, the fifteen `*_SUPPLIES` constants, and both corrections
    to the tasklist. The `index.md` row already existed, so stage 6 updates it rather than
    adding it.

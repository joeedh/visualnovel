# Formalizing the renderer's rule modules

Status: **research**. Nothing here is planned work. This is the companion to
[`ux-behaviour-model.md`](ux-behaviour-model.md), which needs every control the desktop app draws
to be readable from a pure function before a UX model can be derived headlessly. This report
describes what `apps/desktop/renderer/rules/` looks like today, what stops it being read that way,
and the smallest change that would let it be.

<!-- toc -->

- [What the rule modules are](#what-the-rule-modules-are)
- [What they look like today](#what-they-look-like-today)
- [What a headless reader needs](#what-a-headless-reader-needs)
- [The proposed change](#the-proposed-change)
  * [One entry point per editor](#one-entry-point-per-editor)
  * [One `Offer` carrying what the anchor records](#one-offer-carrying-what-the-anchor-records)
  * [Presentation stays, beside the offers](#presentation-stays-beside-the-offers)
  * [The ten inline editors get a module](#the-ten-inline-editors-get-a-module)
  * [A test that ties the tiers together](#a-test-that-ties-the-tiers-together)
- [What this is not](#what-this-is-not)
- [Costs](#costs)
- [Decisions a plan would settle](#decisions-a-plan-would-settle)
- [See also](#see-also)

<!-- tocstop -->

## What the rule modules are

`renderer/rules/` holds the "pure" (validation) half of the renderer:
logic with a `tests/` sibling that runs in the desktop jest project (which is node-only).
A pane can only be checked live over CDP, so anything that can be tested without a DOM is 
meant to live here. The directory holds 27 modules and about 4,200 lines.

Two kinds of module share the directory.

- **Pure algorithms with one job.** `anchors.ts` (resolution of a wanted invocation against the
  drawn anchors), `tour.ts` (what the overlay shows for a step), `catalog.ts` (palette filtering
  and coercion), `gengraph.ts`, `taskGraph.ts`, `script.ts`, `timeline/`, `branch/`. These have a
  clear input and output and are not the subject of this report.
- **Per-editor offer modules.** `headerbar.ts`, `convobar.ts`, `assetview.ts`, `projectbar.ts`,
  `promptview.ts` and `reportconvo.ts` compute what an editor's controls do from the editor's
  state. These are the ones a UX model reads, and the ones this report is about. `doctreebar.ts`
  is the edge case: it exports only the supplies constants for the document tree's two writes,
  because neither is ever refused by the pane, so the tree's offers are inline.

The contract the offer modules serve is the anchor layer's: a control's click handler and the
record naming it come from one `Offer`, so the two cannot drift
([`../reference/guided-tours.md#design-rule`](../reference/guided-tours.md#design-rule)). The
offer modules are where that `Offer` is computed.

## What they look like today

Counts at the time of writing:

| Editors registering anchors through `act()` | Editors with an offer module | Modules returning `Offer` |
| ------------------------------------------- | ---------------------------- | ------------------------- |
| 15                                          | 5                            | 6                         |

The six modules follow a convention rather than a contract.

- **Each is a bag of functions with its own signatures.** `runAction(busy, live)`,
  `stopAction(controls)`, `approveAction(info)`, `modeStrip(view)` returning a list of buttons each
  with a nested action, `chunkActs(view, chunk)` returning a different list shape. Nothing can
  iterate "every control the asset editor draws" because no function says so.
- **`Offer` is re-spelled locally.** `ApproveAction`, `PromoteAction`, `ReplaceAction`,
  `RedrawAction`, `RegenerateAction` and `TaskAction` in `assetview.ts`, and the `action` field of
  `ModeButton` in `promptview.ts`, are each a structural copy of `Offer` with a narrower props type.
  They are assignable to `Offer` by accident, and a change to `Offer` would not reach them.
- **Half of what an anchor records lives at the call site.** `act(node, offer, run, opts)` takes
  `ActOptions` with `supplies`, `form`, `on`, `about`, `key` and `publishes`. The rule says "this
  runs `art.promote`" and the editor separately says "and the variant is typed", through
  `PROMOTE_SUPPLIES` exported as a loose constant beside the function. A reader of the rule sees
  only the first half.
- **Presentation is mixed with behaviour.** `chunkVoice`, `chunkTexture`, `badgesOf`,
  `failureNote`, `driftNote` and `promptShown` sit beside the offers. Harmless for the app, noise
  for a model.
- **Ten editors keep their offer logic inline.** `branch`, `documents`, `graph`, `nodes`,
  `onboarding`, `script`, `skills`, `tasks`, `timeline` and `wiki` register anchors but compute the
  offers in the editor file, beside the DOM code. Several import a rule module for other logic (`gengraph.ts`,
  `taskGraph.ts`, `script.ts`, `tasklist.ts`), and none of those modules returns an `Offer`. The
  inline offers are correct, and they cannot be read without a DOM.

Two things are already right and should be kept.

- **The inputs are formal.** Each module reads a shared IPC view type: `PromptView`, `AssetInfo`,
  `Convo`, `OpenedThread`, `ReportStateView`, `BusyControls`. Those types are what main sends and
  what a mock project produces, so a synthetic state is a fixture of an existing type.
- **Refusals carry the command they are about.** A greyed control is recorded as an anchor with a
  `reason` and an `id`, so a tour can ring it and show the app's own sentence. Several reasons are
  imported from the shared modules main uses (`resumeRefusal`, `condenseNeedsForce`), so the
  button and the command say the same words.

## What a headless reader needs

A derivation runs a rule module over a fixture and gets back the controls the editor would draw.
For that to work, four things have to hold that do not hold today.

1. **Enumerability.** One function per editor that returns every control for a given state, keyed
   the way anchors are keyed.
2. **A complete offer.** Everything the anchor records must be on the offer, so the call site adds
   nothing.
3. **One `Offer` type.** So the derivation, the anchor layer and the tour read the same shape.
4. **A uniform driver.** The derivation calls the same function for every editor, passing a
   fixture of that editor's state type.

## The proposed change

### One entry point per editor

```ts
export function controls(state: AssetView): Control[];
```

- A `Control` is a keyed `Offer`: the anchor key (`cmd:<id>`, `cmd:<id>#<on>`, `item:<kind>/<key>`)
  plus the offer.
- The editor draws from this list. Where it drew a button per call to `approveAction`, it now
  finds the control by key in the list and passes it to `act()`. The list the app draws is the
  list the model reads, so there is nothing to drift. This is the same invariant `act()` enforces
  at the DOM level, moved up one layer.
- `modeStrip` and `chunkActs` are already this shape for their own strips. The change is to give
  every editor one function that returns all of them.
- A function returning a list does not force the editor to draw in list order. The editor keeps
  its layout and looks controls up by key.

### One `Offer` carrying what the anchor records

```ts
export type Offer =
  | {
      ok: true;
      id: string;
      props: Record<string, PropValue>;
      label: string;
      tooltip: string;
      supplies?: readonly string[];
      form?: boolean;
      on?: string;
      publishes?: readonly string[];
    }
  | { ok: false; id: string; reason: string; label: string };
```

- `supplies`, `form`, `on` and `publishes` move from `ActOptions` onto the offer. `act(node, offer)`
  takes nothing else. `about` disappears, because a refusal always names its id.
- `tooltip` becomes required. CLAUDE.md already requires every interactive control to carry one,
  and nothing enforces it. On the offer it is a type error to leave out. A refusal's tooltip is its
  reason, so the refused branch carries `reason` and the anchor layer uses it for both.
- The local clones in `assetview.ts` and `promptview.ts` are deleted. Where a module wants a
  narrower props type for its own tests, it narrows `Offer` rather than restating it.
- `id` is a command id today. When pseudo-commands exist, it is a command id or a pseudo-command
  id from the same closed vocabulary, and the type does not change.

### Presentation stays, beside the offers

`badgesOf`, `chunkVoice` and the rest are pure and tested and have no reason to move. A module may
export both `controls(state)` and its presentation helpers. The derivation reads only `controls`.

### The ten inline editors get a module

Each editor that computes offers inline gets a `rules/<editor>.ts` with `controls(state)`, by
extraction. The editors' state is already a shared view type in every case, because it arrived
over IPC. This is the same mechanical work the six existing modules already went through, and
it is the bulk of the cost.

### A test that ties the tiers together

For each editor, one jest test asserts that the keys `controls(fixture)` returns equal the keys the
sweep measured for that editor under the matching situation in `anchors.json`. The derived tier and
the measured tier then check each other:

- a control the editor draws without going through `controls` shows up as a measured key with no
  derived key;
- a control `controls` returns that the editor does not draw shows up as a derived key with no
  measured key.

## What this is not

- **Not a framework.** No base classes, no decorators, no registration DSL. A function per editor
  with one return type is the whole contract.
- **Not a change to the app's behaviour.** Every offer the app computes today is computed the same
  way afterwards, from the same inputs, by the same code, moved.
- **Not a change to the anchor layer's design rule.** `act()` still takes the object it wires the
  handler from. It takes fewer arguments.

## Costs

- **Six modules to unify**, serving five editors. Replacing local offer types with `Offer`,
  moving supplies constants onto the offers, and adding `controls`. Small per module.
- **Ten editors to extract.** The offer logic in each is a few dozen lines, interleaved with DOM
  code, and the extraction has to preserve the order in which refusals are tested, since the first
  matching refusal is the one shown.
- **Every `act()` call site to simplify**, across the fifteen editors. Each drops its
  `ActOptions` argument.
- **Fixtures.** One state fixture per editor per situation, shared with the sweep's situation list.

## Decisions a plan would settle

- Whether `controls` returns a list or a map keyed by anchor key. A list preserves an order the
  palette fallback could use; a map makes lookup by key free.
- Whether `tooltip` on a refusal is a separate field or is always the reason.
- Where the `Control` and `Offer` types live once `@vn/types` needs the schema for the model:
  `renderer/rules/anchors.ts` today, `src/shared/` if main needs them too.
- Whether the first stage lands the type change alone (which already enforces tooltips) before any
  editor is extracted, so the app is green at each step.

## See also

- [`ux-behaviour-model.md`](ux-behaviour-model.md), what the modules are being formalized for.
- [`../reference/guided-tours.md#part-i--the-anchor-layer`](../reference/guided-tours.md#part-i--the-anchor-layer),
  the anchor layer these modules feed.
- [`../reference/desktop-app-shell.md`](../reference/desktop-app-shell.md), where the renderer's
  pure and DOM halves are described.

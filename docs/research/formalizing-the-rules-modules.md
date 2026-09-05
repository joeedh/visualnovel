# Formalizing the renderer's rule modules

Status: research. Nothing here is planned work. This document is the companion to
[`ux-behaviour-model.md`](ux-behaviour-model.md). Deriving a UX model headlessly requires
every control the desktop app draws to be readable from a pure function. This report
describes `apps/desktop/renderer/rules/` as it stands today, what prevents those controls
from being read from a pure function, and the smallest change that would make them
readable.

<!-- toc -->

- [What the rule modules are](#what-the-rule-modules-are)
- [What they look like today](#what-they-look-like-today)
- [What a headless reader needs](#what-a-headless-reader-needs)
- [The proposed change](#the-proposed-change)
    - [One entry point per editor](#one-entry-point-per-editor)
    - [One `Offer` carrying what the anchor records](#one-offer-carrying-what-the-anchor-records)
    - [Presentation stays, beside the offers](#presentation-stays-beside-the-offers)
    - [The ten inline editors get a module](#the-ten-inline-editors-get-a-module)
    - [A test that ties the tiers together](#a-test-that-ties-the-tiers-together)
- [What this is not](#what-this-is-not)
- [Costs](#costs)
- [Decisions a plan would settle](#decisions-a-plan-would-settle)
- [See also](#see-also)

<!-- tocstop -->

## What the rule modules are

`renderer/rules/` holds the "pure" (validation) half of the renderer. The logic there has
a `tests/` sibling that runs in the desktop jest project (which is node-only). A pane can
only be checked live over CDP, so anything that can be tested without a DOM belongs here.
The directory holds 27 modules and about 4,200 lines.

The directory holds two kinds of module.

- **"Pure" (side-effect-free) algorithms with one job.** `anchors.ts` (resolution of a
  requested invocation against the drawn anchors), `tour.ts` (what the overlay shows for a
  step), `catalog.ts` (palette filtering and coercion), `gengraph.ts`, `taskGraph.ts`,
  `script.ts`, `timeline/`, `branch/`. These have a clear input and output and are not the
  subject of this report.
- **Per-editor offer modules.** `headerbar.ts`, `convobar.ts`, `assetview.ts`,
  `projectbar.ts`, `promptview.ts` and `reportconvo.ts` compute what an editor's controls
  do from the editor's state. A UX model reads these six modules, and this report covers
  them. `doctreebar.ts` differs from the rest. The pane never refuses either of the
  document tree's two writes, so the tree's offers are inline and `doctreebar.ts` exports
  only the constants for those two writes.

The offer modules implement a contract set by the anchor layer. A control's click handler
and the record naming it come from one `Offer`, so the handler and the record cannot drift
([`../reference/guided-tours.md#design-rule`](../reference/guided-tours.md#design-rule)).
The offer modules compute that `Offer`.

## What they look like today

These counts were taken at the time of writing:

| Editors registering anchors through `act()` | Editors with an offer module | Modules returning `Offer` |
| ------------------------------------------- | ---------------------------- | ------------------------- |
| 15                                          | 5                            | 6                         |

The six modules follow a convention rather than a contract.

- **Each exports a set of functions with its own signatures.** The signatures are
  `runAction(busy, live)`, `stopAction(controls)`, `approveAction(info)`,
  `modeStrip(view)`, which returns a list of buttons (each with a nested action), and
  `chunkActs(view, chunk)`, which returns a different list shape. No function declares the
  set of controls the asset editor draws, so no code can iterate over them.
- **`Offer` is duplicated locally.** `ApproveAction`, `PromoteAction`, `ReplaceAction`,
  `RedrawAction`, `RegenerateAction` and `TaskAction` in `assetview.ts`, and the `action`
  field of `ModeButton` in `promptview.ts`, are each a structural copy of `Offer` with a
  narrower props type. Each one happens to be assignable to `Offer`, and a change to
  `Offer` would not propagate to them.
- **An anchor records half of its information at the call site.**
  `act(node, offer, run, opts)` takes `ActOptions` with `supplies`, `form`, `on`, `about`,
  `key` and `publishes`. The rule declares that this runs `art.promote`. The typing of the
  variant is declared separately in the editor, through `PROMOTE_SUPPLIES` exported as a
  loose constant beside the function. A reader of the rule sees only the call site, not
  the typing of the variant.
- **Presentation is mixed with behaviour.** `chunkVoice`, `chunkTexture`, `badgesOf`,
  `failureNote`, `driftNote` and `promptShown` appear alongside the offers. This is
  harmless for the app, but it adds noise to what a model reads.
- **Ten editors keep their offer logic inline.** `branch`, `documents`, `graph`, `nodes`,
  `onboarding`, `script`, `skills`, `tasks`, `timeline` and `wiki` register anchors but
  compute the offers in the editor file, beside the DOM code. Several of these editors
  import a rule module for other logic (`gengraph.ts`, `taskGraph.ts`, `script.ts`,
  `tasklist.ts`), and none of those modules returns an `Offer`. The inline offers are
  correct, but reading them means reading the surrounding DOM code.

Keep the two things that are already right.

- **The inputs are formal.** Each module reads a shared IPC view type: `PromptView`,
  `AssetInfo`, `Convo`, `OpenedThread`, `ReportStateView`, `BusyControls`. Main sends
  those types and a mock project produces them, so building a synthetic state means
  building a fixture of an existing type.
- **A refusal records the command it refers to.** A greyed control is recorded as an
  anchor with a `reason` and an `id`, so a tour can ring it and show the wording the app
  itself uses. Several reasons are imported from the shared modules main uses
  (`resumeRefusal`, `condenseNeedsForce`), so the button and the command show the same
  wording.

## What a headless reader needs

A derivation runs a rule module over a fixture and returns the controls the editor would
draw. Four conditions must hold before a derivation can run, and none of them hold today.

1.  1. **Enumerability.** Each editor has one function that returns every control for a
       given state, keyed the way anchors are keyed.
2.  2. **A complete offer.** The offer must carry everything the anchor records, so the
       call site adds nothing.
3.  3.  3. **One `Offer` type.** The derivation, the anchor layer and the tour all use the
           same type.
4.  **A uniform driver.** The derivation calls the same function for every editor, passing
    a fixture of that editor's state type.

## The proposed change

### One entry point per editor

```ts
export function controls(state: AssetView): Control[];
```

- A `Control` pairs an anchor key (`cmd:<id>`, `cmd:<id>#<on>`, `item:<kind>/<key>`) with
  an `Offer`.
- The editor draws from this list. It previously drew a button per call to
  `approveAction`; it now looks up the control by key in the list and passes it to
  `act()`. The app draws the same list the model reads, so the app and the model cannot
  diverge. `act()` enforces that invariant at the DOM level, and the list enforces it one
  layer up.
- `modeStrip` and `chunkActs` already have this shape for their own strips. The change
  gives every editor one function that returns all of them.
- A function returning a list does not force the editor to draw in list order. The editor
  keeps its layout and looks controls up by key.

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

- `supplies`, `form`, `on` and `publishes` move from `ActOptions` onto the offer.
  `act(node, offer)` takes nothing else. `about` is removed, because a refusal always
  names its id.
- `tooltip` becomes required. CLAUDE.md already requires every interactive control to
  carry one, but that requirement is not enforced. Omitting it from the offer raises a
  type error. The anchor layer displays a refusal's reason as the tooltip, so the refused
  branch carries `reason`, which the anchor layer uses for both.
- The local clones in `assetview.ts` and `promptview.ts` are deleted. A module that needs
  a narrower props type for its own tests narrows `Offer` rather than restating it.
- `id` is a command id today. When pseudo-commands exist, `id` is a command id or a
  pseudo-command id from the same closed vocabulary, and the type does not change.

### Presentation stays, beside the offers

`badgesOf`, `chunkVoice` and the rest are "pure" (side-effect-free) and tested, and there
is no reason to move them. A module may export both `controls(state)` and its presentation
helpers. The derivation reads only `controls`.

### The ten inline editors get a module

Extract a `rules/<editor>.ts` with `controls(state)` from each editor that computes offers
inline. Every such editor's state is already a shared view type, because it arrived over
IPC. The same mechanical work produced the six existing modules, and it accounts for most
of the cost.

### A test that ties the tiers together

For each editor, one jest test asserts that the keys returned by `controls(fixture)` match
the keys the sweep measured for that editor under the matching situation in
`anchors.json`. The test then compares the derived tier with the measured tier:

- a control the editor draws without going through `controls` appears as a measured key
  with no derived key;
- a control that `controls` returns but the editor does not draw shows up as a derived key
  with no measured key.

## What this is not

- **Not a framework.** There are no base classes, no decorators, and no registration DSL.
  Each editor is one function with one return type, and nothing else is required.
- **The app's behaviour does not change.** After the move, the same code computes every
  offer from the same inputs and in the same way.
- **The anchor layer's design rule is unchanged.** `act()` still takes the object it wires
  the handler from, and it now takes fewer arguments.

## Costs

- **Six modules to unify.** Six modules serve five editors. Each module replaces its local
  offer types with `Offer`, moves its supplies constants onto the offers, and adds
  `controls`. The change is small in each module.
- **Ten editors are left to extract.** The offer logic in each editor runs a few dozen
  lines and is interleaved with DOM code. The extraction has to preserve the order in
  which refusals are tested, because the first matching refusal is the one shown.
- **Every `act()` call site across the fifteen editors is simplified.** Each call site
  drops its `ActOptions` argument.
- **Fixtures.** Each editor gets one state fixture per situation, and the situation list
  is shared with the sweep.

## Decisions a plan would settle

- `controls` could return either a list or a map keyed by anchor key. A list preserves an
  order that the palette fallback could use. A map supports direct lookup by key.
- Whether `tooltip` on a refusal is a separate field or always holds the refusal reason.
- Decides where the `Control` and `Offer` types live once `@vn/types` needs the schema for
  the model. Both types sit in `renderer/rules/anchors.ts` today. The pair moves to
  `src/shared/` if main needs them too.
- Whether the first stage lands the type change alone (which already enforces tooltips)
  before any editor is extracted, so the app stays "green" (passing) at each step.

## See also

- [`ux-behaviour-model.md`](ux-behaviour-model.md) explains why the modules are being
  formalized.
-   - [`../reference/guided-tours.md#part-i--the-anchor-layer`](../reference/guided-tours.md#part-i--the-anchor-layer)
      covers the anchor layer that these modules feed.
- [`../reference/desktop-app-shell.md`](../reference/desktop-app-shell.md) describes the
  renderer's "pure" and DOM halves.

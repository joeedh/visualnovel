# A UX behaviour model — tasklist

Status: **proposed**. Nothing here is scheduled. Plan 1 is written
([`archive/one-offer-and-the-six-rule-modules.md`](archive/one-offer-and-the-six-rule-modules.md));
the other seven are not. This file is not a plan; it proposes how the work in
[`../research/ux-behaviour-model.md`](../research/ux-behaviour-model.md) and its companion
[`../research/formalizing-the-rules-modules.md`](../research/formalizing-the-rules-modules.md)
divides into plans, what order they can be taken in, and which of the two reports' open
decisions each plan settles.

The goal the two reports set: describe every UX behaviour of the desktop app in one
machine-readable model, derived rather than hand-written, traced to the code that
implements it, queryable by an LLM and checkable by a linter.

The file also records what reading `vendor/path.ux` against the reports turned up. Two of
the things the reports list as owed are already built, one is a bug rather than a plan,
and one — refusals carrying a sentence — has grown a path.ux half that neither report knew
about. Those are in
[What refusals look like once path.ux carries them](#what-refusals-look-like-once-pathux-carries-them),
[What is actually owed in the submodule](#what-is-actually-owed-in-the-submodule) and
[Two path.ux bugs, independent of the batch](#two-pathux-bugs-independent-of-the-batch).

## The proposed plans

| #   | Plan                                                                                           | Where            | Depends on | Covers                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------- | ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | [One `Offer`, and the six rule modules unified](archive/one-offer-and-the-six-rule-modules.md) | app              | —          | `Offer` absorbs `ActOptions`, `tooltip` becomes required, the refused branch carries a `Refusal`, the six modules gain `controls()`                    |
| 2   | [The ten inline editors get a rule module](the-ten-inline-editors-get-a-rule-module.md)        | app              | 1          | `rules/<editor>.ts` extracted from each editor that computes offers beside its DOM code                                                                |
| 3   | Situations, and the derived model                                                              | app              | 1, 2       | The fixture list, the headless driver, the zod schema, `ux-model.json`, and the three lint rules the derived tier answers                              |
| 4   | Pseudo-commands, and a control's list of effects                                               | app              | 1          | The closed effect vocabulary in the catalog, closures rewritten as recorded effects, and the three rules effects unlock                                |
| 5   | Disabling menu items, and refusals that carry a reason                                         | `vendor/path.ux` | —          | **Already written and complete**, and the authority on its own scope: `menu-item-disabling.md`, stages 1-5 done, stage 6 (the native menu bar) dropped |
| 6   | Finishing the meta-tag system                                                                  | `vendor/path.ux` | 5          | A `widgetPath` scheme, a `refusal` accessor on `StdUXMeta`, a validating deserialize, and the `toolPath` builders                                      |
| 7   | The measured tier reads tags                                                                   | app              | 3, 6       | `act()` writes a `StdUXMeta`, the sweep walks widgets instead of `window.__vnAnchors`, derived compared against measured                               |
| 8   | `affects` on every command, and the executed tier                                              | app              | —          | Each command declaring the subtrees and `ui.*` fields it may touch, verified by diffing the undo snapshot                                              |

Plans 1, 2, 3 and 7 are the model itself. Plan 4 widens its vocabulary past commands.
Plans 5 and 6 are submodule work committed separately, and 5 is already planned there.
Plan 8 is independent of every other row and is worth taking on its own merits.

## Why this split

The seams are the four costs the report names, plus the two it does not treat as one piece
of work.

- **1 and 2 split on risk, not on subject.** Plan 1 is a type change plus six small module
  edits, and it enforces the tooltip rule in CLAUDE.md at the type level the day it lands.
  Plan 2 is mechanical extraction across ten editors with one hazard — refusal order,
  where the first matching refusal is the one shown. Landing the type alone keeps the tree
  green at a point where the extraction has not started
  ([`../research/formalizing-the-rules-modules.md#decisions-a-plan-would-settle`](../research/formalizing-the-rules-modules.md#decisions-a-plan-would-settle)
  raises this as its own open question).
- **3 is the smallest thing that produces a model.** Once every editor answers
  `controls(state)`, a driver over a fixture list produces the derived file with no DOM,
  no main process and no meta tags. It needs none of 4, 5 or 6.
- **4 is separable because commands already have names.** A model that covers only
  command-backed controls is useful; adding `tree.expand` and `drag.accept` widens it. The
  report calls recording renderer-local handlers the largest single change, and it touches
  every editor, so it should not gate the first model.
- **5 is a sibling rather than a prerequisite.** The model can be built without it: the
  app sets a refused control's tooltip itself today. What 5 adds is the path.ux half — a
  menu item that can be disabled with a sentence — which is what closes the context-menu
  gap the report lists as one of the four things missing.
- **6 is in the submodule and smaller than the report thought.** `valuePath` is already
  written; see [What is actually owed](#what-is-actually-owed-in-the-submodule).
- **7 is a replacement, not an addition.** `AnchorDump` and `StdUXMeta` describe the same
  thing, and the report is explicit that the tag replaces the dump rather than sitting
  beside it. Doing that after the derived tier exists means the comparison it enables can
  land in the same plan.
- **8 shares no code with the rest.** It is a change to command definitions in
  `apps/desktop/src/main/commands/` and a test in `@vn/testkit`, and its value — a
  mutating command that writes outside what it declared fails a test — does not depend on
  any renderer work.

## What refusals look like once path.ux carries them

Neither report anticipated this, and it changes plan 1's type and plan 6's tag. It landed
in path.ux while this file was being written, so the shape below is the one in the tree at
`a3d5d85a` rather than a proposal.

- **One type, from the op to the tooltip.** `Refusal` is
  `{ reason: string; description?: string }`
  (`vendor/path.ux/scripts/path-controller/toolsys/toolop.ts:195`) — one sentence shown on
  the control, and a longer explanation behind the tooltip's expander. `CanRunResult` is
  `boolean | Refusal`, and `UIBase._refusalReason` holds the same shape, so an op's answer
  reaches a tooltip with no adapter in between.
- **`reason` is normative; `description` is presentation.** The lint rule compares
  `refusal.reason` against `stack.check`'s message verbatim. `refusal.description` is
  recorded and never compared, which is what lets a surface elaborate without breaking the
  verbatim requirement in CLAUDE.md.
- **The short line leads.** `tooltipText` (`ui_base_props.ts:72`) composes the reason
  first, then the long description, then the widget's own `_description_final`. So the
  rule checks the sentence the author actually reads. The expander it is written for does
  not exist yet, and the long text is appended in the meantime — a TODO in that function
  says so.
- **`disabled` is the authority, and the refusal only explains it.** `resolveRefusal`
  (`ui_base_props.ts:64`) returns nothing unless the control is disabled, so setting a
  refusal does not disable anything. That makes "a disabled control states why" exactly
  `disabled && resolveRefusal() === undefined`, and it gives the model a second thing to
  catch: a rule module that computes a refusal for a control the editor draws enabled,
  which is silently inert on screen.
- **The tag needs one accessor, not two.** `StdUXMeta.description` proxies to
  `owner.description`, which returns the raw `_description` (`ui_base.ts:411`) rather than
  the composed tooltip. That is the right value for the record's `tooltip` field, and the
  refusal wants a single `refusal` accessor beside `description` and `valuePath`, carrying
  the object whole.
- **Keep the refusal nested in the record.** `Refusal.description` and the widget's own
  `description` are different sentences, and `tooltipText` reads both. A record that
  flattens them into one namespace loses the distinction; `tooltip` plus
  `refusal.description` keeps it.
- **`Offer`'s refused branch carries a `Refusal`.** Anything the measured tier can read
  off a widget needs a derived-tier source, or the comparison in plan 7 reports drift that
  is not drift. Reusing the type rather than restating it also means one shape spans the
  op, the widget, the rule module and the record. Settled in plan 1, where the type is
  settled.
- **The app needs no adapter either.** `CheckResult`'s refused branch is
  `{ ok: false; reason: string }` (`packages/commands/src/command.ts:114`), which is
  structurally a `Refusal` with no `description`. So a command-backed control fills
  `reason` and leaves `description` undefined. Widening `CheckResult` to supply the long
  form is a surface change across 94 mutating commands for a slot nothing needs yet, and
  is not proposed.
- **The callback form splits cleanly across the tiers.** `_refusalReason` may be a thunk
  returning a `Refusal`, which cannot be evaluated with no owner and no ctx — and should
  not be. The derived tier takes the refusal from the rule module, the measured tier
  invokes the thunk on the live widget, and the sweep compares them. That widens the
  existing cross-check, which compares enabled state only, to the wording as well.
- **Resolved on read, so it cannot go stale.** Both `resolveRefusal` and `tooltipText`
  compose at display time rather than at assignment, which is what lets `disabled` flip
  with no notification. It is also structurally immune to the failure the app hit with its
  own `stack.check` refusal cache, where `askedAs` short-circuited the re-ask and a
  standing refusal never expired
  ([`archive/guided-tour-resolution-fixes.md`](archive/guided-tour-resolution-fixes.md)).

## The `widgetPath` scheme

There is no scheme today — `walkWidgets` and `widgetPathOf` appear only in the commented
example at `ui_meta_tags.ts:31`. Plan 6 settles it, and the two candidates are not equal.

- **What the field's doc comment points at is positional.** `saveUIData`
  (`vendor/path.ux/scripts/core/base/ui_savedata.ts:12`) addresses a widget by two numbers
  per hop — the child index, and 1/0 for whether the hop crossed into a shadow root
  (`PTOT = 2`) — walking `childNodes` and then `shadow.childNodes`. That is correct for
  its own job, where a stale path costs a lost scroll position, and wrong for a committed
  model, where inserting one widget earlier in a container rewrites every record below it.
- **Hashing the meta tags is the better input.** It keys on what a widget does rather than
  where it sits, so it survives layout edits, and it generalizes what the anchor keys
  (`cmd:<id>#<on>`, `item:<kind>/<key>`) already do by hand.
- **`_id` is not a candidate.** It is `tagname_N` off a global counter
  (`ui_base_init.ts:90`), so it is unique within one session and meaningless across two.

Four constraints the hash has to satisfy, none of them fatal:

- **Collisions are normal.** A list of rows bound to one path, or two identical buttons in
  different panes, hash the same. The anchor layer met this and answered with `on` as a
  discriminator plus domain item keys. The honest form is the hash plus a per-parent
  occurrence index used only where the hash repeats, so identity stays stable for the
  common case and degrades to positional only where it must.
- **Unmeta'd widgets have nothing to hash.** Containers, labels and spacers carry no tag,
  which argues for chaining only the meta-bearing ancestors rather than every DOM hop —
  shorter and more stable than `saveUIData`'s walk.
- **`widgetPath` is excluded from its own input.** It is a field on the tag being hashed.
- **The derived tier has to compute the same value.** Inputs are limited to what an
  ownerless tag holds (`description`, `valuePath`, `tools`), and exclude anything
  DOM-derived (tagname, packflag, a computed label). `StdUXMeta`'s buffering setters make
  this possible; the constraint is on which fields the hash reads.

One recommendation: a readable stem with a short hash suffix rather than a bare digest, so
a diff of the committed model can be reviewed by a person and by the agent.

## Where the eleven lint rules land

The report argues the lint use case should drive the schema, so each plan lands the rules
its own tier makes checkable rather than deferring them to a plan of their own.

| Rule                                                             | Plan | Note                                                                          |
| ---------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| Every control carries a tooltip                                  | 1    | Enforced by the type, so no linter is needed                                  |
| A disabled control states why, in the stack's own words          | 3    | Compares `refusal.reason`, never `refusal.description`; see the section above |
| A command has at least one control, or is listed as palette-only | 3    | Replaces `FLOOR`, which is a count rather than a list                         |
| The committed model was derived after the last `editors/**` edit | 3    | The staleness rule for a committed generated file                             |
| A surface opens an editor only through the sparing rule          | 4    | Needs `effects` carrying a pane field                                         |
| A mutating command reachable from a menu is undoable or confirms | 4    | Needs `effects` plus the catalog                                              |
| A keyboard shortcut is bound once                                | 4    | Needs `key.bind` as a recorded effect                                         |
| Two controls in one pane share a key only with a discriminator   | 4    | Needs `key` and `on` on the record                                            |
| Enabled state agrees with `stack.check`                          | —    | Already checked by the sweep; plan 7 carries it across and adds wording       |
| The ring lands on the control                                    | —    | Already checked by the sweep; plan 7 carries it across                        |
| A bound path resolves on the api its own pane carries            | 7    | Reads `DataAPI.lastResolveError`; see the note below on taking it early       |

The `valuePath` rule is separable from the rest of plan 7. It needs the sweep to walk the
screen and read `lastResolveError`, and it needs neither the derived model nor the meta
tags. The app already runs one `DataAPI` per Gen Graph pane
(`apps/desktop/renderer/pathux/editors/nodes.ts`) beside the shell's, which is the
condition that makes an unresolved path possible, so this check can be taken first if a
result is wanted before the model exists.

## What each plan settles

Routing the two reports' open decisions, so no plan starts by rediscovering them.

- **Plan 1** — whether `controls` returns a list or a map keyed by anchor key; whether the
  type change lands before any editor is extracted. The reports ask whether a refusal's
  `tooltip` is a separate field or always the reason; `Refusal` answers it — separate
  fields, composed only for display.
- **Plan 2** — where `Control` and `Offer` live once main needs them (they sit in
  `renderer/rules/anchors.ts` today, and `src/shared/` is the destination if main needs
  them too).
- **Plan 3** — whether the model is committed or generated in CI and compared, and where
  it lives; the situation list itself; which rules block CI and which are advisory.
- **Plan 4** — the exact pseudo-command vocabulary, and whether `key.bind` is an effect or
  a property of a control.
- **Plan 5** — the tooltip expander the long form is written for, which `tooltipText`
  appends in the meantime. Whether a refusal disables a control is already answered: it
  does not, and a refusal on an enabled control is not shown at all.
- **Plan 6** — the `widgetPath` scheme; whether the receiving side calls `validateJSON` or
  a STRUCT-to-zod converter.
- **Plan 7** — whether `AnchorDump` is replaced outright or kept as a projection for the
  tour's resolver; whether `anchors.json` is absorbed into the model's measured fields or
  kept as the tour's smaller input; how a record names the api a path resolves against.
- **Plan 8** — whether `affects` is a list of document-tree path prefixes, a list of
  `ui.*` field names, or both, and how the snapshot diff is matched against it.

## What the numbers are today

Measured from the committed `apps/desktop/anchors.json` (swept 2026-09-08) and the source.

- 170 commands in the registry, 49 with a control on file, 136 records, 1 stray, 0
  enabled-state disagreements.
- 13 editor homes appear in the sweep. Fifteen files under `renderer/pathux/editors/` call
  the anchor layer's `act()` or `record()`. The notification popup in `chrome/` does not:
  its `act` is a local wrapper over `exec`, and its four `notify.*` controls are not
  anchors.
- `renderer/rules/` holds 27 modules and about 4,200 lines. Six of them return an `Offer`,
  serving five editors; the other ten editors compute offers inline.
- 94 of the command definitions declare `mutating: true`, which is the population plan 8's
  executed-tier test runs against.
- 16 builder sites write the `datapath` attribute. The desktop registers no path.ux
  `ToolOp` and calls `container.tool()` zero times.

## Prerequisites already met

The reports were written before three of the things they wait on landed, so these are not
work items.

- **The path.ux tool and struct tables are per-api.**
  [`tool-registry.md`](../../vendor/path.ux/documentation/plans/tool-registry.md),
  [`per-api-struct-tables.md`](../../vendor/path.ux/documentation/plans/per-api-struct-tables.md)
  and
  [`per-api-tool-tables.md`](../../vendor/path.ux/documentation/plans/per-api-tool-tables.md)
  are all done, which is what makes a bare `toolPath` string usable as identity within one
  api.
- **The meta tags are wired into `UIBase`.** `getMeta`, `setMeta` and `ensureMeta` are
  methods on the widget base class (`vendor/path.ux/scripts/core/ui_base.ts:1254`).
- **`MetaTagSet.STRUCT` names a registered struct.** It declares
  `array(abstract(pathux.UXMetaTag))` over a base class with its own STRUCT, which is the
  fix the report records as owed.

## What is actually owed in the submodule

The report says no builder writes `toolPath` or `valuePath`. Half of that is no longer
true, and the other half has no consumer in this app.

- **`valuePath` is already written, because a data path has only one home.** path.ux
  stores it in the `datapath` DOM attribute, and `StdUXMeta.valuePath` proxies to
  `getAttribute("datapath")` (`ui_meta_tags.ts:284`). Sixteen builder sites set it, so the
  tag reads a live value today for anything built through `prop`, `slider`, `textbox`,
  `check`, `listbox` and the rest. A sweep can read a bound path off any widget with no
  new writer anywhere, which is why the `valuePath` lint rule needs no path.ux change at
  all.
- **`toolPath` is written by nobody, and this app would not read it.** `toolImpl`
  (`container_menu.ts:120`) resolves the path, builds the exec callback around it and sets
  the tooltip from the tooldef, then discards the string. Filling it in the builder is
  correct for path.ux, but the desktop's controls run `@vn/commands` ids through `act()`,
  so the command id reaches a record through the app's own `UXToolMeta` subclass instead.
  Plan 6's `toolPath` half is submodule hygiene with no desktop consumer.
- **`HotKey` has the same split as plan 4's closures.** Its `action` is either a toolpath
  string, which is recordable as it stands, or an opaque callback
  (`vendor/path.ux/scripts/path-controller/util/simple_events.ts:917`), which has to
  become a named effect before "a keyboard shortcut is bound once" can be checked.
- **`widgetPath` has no scheme.** Covered above.

## Two path.ux bugs, independent of the batch

Found while checking the report's claims. Both belong to the submodule, neither is plan
work, and the second one matters to the tooltip rule.

- **Three builders ignore `dataPrefix`.** `textareaImpl`
  (`vendor/path.ux/scripts/core/utils/container_widgets.ts:365`), `viewerImpl` (`:395`)
  and `iconcheckImpl` (`container_enum.ts:27`) store the raw argument, where every other
  site stores `self._joinPrefix(inpath)` — `textbox`, `pathlabel`, `colorbutton`,
  `curve1d`, `vecpopup`, `colorPicker`, `check`, `listenum`, `prop`, `slider` and
  `listbox` all join. Under a container with a prefix those three record a relative path
  that does not resolve standalone, which is what the `valuePath` rule would report.
- **`iconcheck` never gets its tooltip.** `container_enum.ts:24` reads
  `ret.description = name ?? ""`, and no `name` is in that function's scope — the
  parameter is `description`, and the `name` bindings further down the file belong to
  `checkImpl`. It resolves to the global `name`, so the description argument is dropped
  and the tooltip is the empty string.

## The list

- [x] 1 — one `Offer`, and the six rule modules unified (shipped 2026-09-07:
      [`archive/one-offer-and-the-six-rule-modules.md`](archive/one-offer-and-the-six-rule-modules.md))
- [ ] 2 — the ten inline editors get a rule module (written:
      [`the-ten-inline-editors-get-a-rule-module.md`](the-ten-inline-editors-get-a-rule-module.md))
- [ ] 3 — situations, and the derived model
- [ ] 4 — pseudo-commands, and a control's list of effects
- [ ] 5 — disabling menu items, and refusals that carry a reason (path.ux, already
      planned)
- [ ] 6 — finishing the meta-tag system (path.ux)
- [ ] 7 — the measured tier reads tags
- [ ] 8 — `affects` on every command, and the executed tier

## Stopping points

The batch is worth taking in part, and three points are complete on their own.

- **After 1 and 2** the renderer's offer logic is uniform and testable, and the tooltip
  rule is enforced. Nothing is generated, and no linter is added.
- **After 3** a derived model exists and answers the LLM's question for every
  command-backed control. `show_me` and the debug agent can read it.
- **After 7** the derived and measured tiers agree or fail, which is the point at which
  the model can be trusted without opening the app.

Plan 4 and plan 8 are additions to a working model rather than steps toward one, and
either can be dropped without invalidating the rest.

## Non-goals for the batch

- **An enumerated state machine.** The report rejects it: the walk grows combinatorially
  and executing transitions writes to the project. A reachability question, if one is ever
  asked, is a symbolic walk over guards.
- **A hand-written model.** No file in this batch is edited by hand except the situation
  list and the `affects` declarations, both of which sit beside the code they describe.
- **Widening `CheckResult` to two strings.** Covered above: a surface change across 94
  commands for a display slot nothing fills.
- **The composition layer.** Tours exist; macros were researched and not built
  ([`../research/user-authored-macros-and-custom-actions.md`](../research/user-authored-macros-and-custom-actions.md)).
  Workflows compose over this vocabulary and stay separate, so the generated file never
  carries anything hand-written.
- **Binding editors to documents by data path.**
  [`../research/zod-backed-model-interface.md`](../research/zod-backed-model-interface.md)
  proposes a proxy toolstack that would change what the model reads. It is a different
  decision and is not a prerequisite for any row here.
- **Giving the agent the command registry.**
  [`../research/agent-access-to-the-ux-command-system.md`](../research/agent-access-to-the-ux-command-system.md)
  explains why the agent gets a model to read rather than the registry, and this batch
  does not revisit that.

## See also

- [`../research/ux-behaviour-model.md`](../research/ux-behaviour-model.md) — the report
  this batch comes from: the three tiers, the record, meta tags as the carrier, the
  pseudo-command vocabulary and the lint rules.
- [`../research/formalizing-the-rules-modules.md`](../research/formalizing-the-rules-modules.md)
  — the companion report, and the authority on plans 1 and 2.
- [`menu-item-disabling.md`](../../vendor/path.ux/documentation/plans/menu-item-disabling.md)
  — plan 5, in the submodule, and the authority on its own scope.
- [`../reference/guided-tours.md`](../reference/guided-tours.md) — the anchor layer and
  the sweep as they ship.
- [`../reference/command-system.md`](../reference/command-system.md) — the registry and
  the catalog that plan 8 changes.

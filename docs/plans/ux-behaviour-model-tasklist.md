# A UX behaviour model — tasklist

Status: **in progress**. Plans 1 to 4 are shipped
([`archive/one-offer-and-the-six-rule-modules.md`](archive/one-offer-and-the-six-rule-modules.md),
[`archive/the-ten-inline-editors-get-a-rule-module.md`](archive/the-ten-inline-editors-get-a-rule-module.md),
[`archive/situations-and-the-derived-model.md`](archive/situations-and-the-derived-model.md),
[`archive/pseudo-commands-and-a-controls-effects.md`](archive/pseudo-commands-and-a-controls-effects.md)).
Plans 5 and 6 are complete in the submodule; 5 was already done before the batch began,
and 6 shipped 2026-09-09
([`meta-tag-system.md`](../../vendor/path.ux/documentation/plans/meta-tag-system.md)).
Plan 7 shipped 2026-09-09
([`archive/the-measured-tier-reads-tags.md`](archive/the-measured-tier-reads-tags.md)),
and plan 8 is written and pressure-tested
([`every-command-declares-what-it-touches.md`](every-command-declares-what-it-touches.md));
nothing else is scheduled. This file is not a plan; it proposes how the work in
[`../research/ux-behaviour-model.md`](../research/ux-behaviour-model.md) and its companion
[`../research/formalizing-the-rules-modules.md`](../research/formalizing-the-rules-modules.md)
divides into plans, what order they can be taken in, and which of the two reports' open
decisions each plan settles.

The goal the two reports set: describe every UX behaviour of the desktop app in one
machine-readable model, derived rather than hand-written, traced to the code that
implements it, queryable by an LLM and checkable by a linter.

The file also records what reading `vendor/path.ux` against the reports turned up. Two of
the things the reports list as owed are already built, two were bugs rather than plans and
have since been fixed, and one — refusals carrying a sentence — has grown a path.ux half
that neither report knew about. Those are in
[What refusals look like once path.ux carries them](#what-refusals-look-like-once-pathux-carries-them),
[What is actually owed in the submodule](#what-is-actually-owed-in-the-submodule) and
[Two path.ux bugs, independent of the batch — both fixed](#two-pathux-bugs-independent-of-the-batch--both-fixed).

## The proposed plans

| #   | Plan                                                                                                  | Where                                | Depends on | Covers                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [One `Offer`, and the six rule modules unified](archive/one-offer-and-the-six-rule-modules.md)        | app                                  | —          | `Offer` absorbs `ActOptions`, `tooltip` becomes required, the refused branch carries a `Refusal`, the six modules gain `controls()`                                                                  |
| 2   | [The ten inline editors get a rule module](archive/the-ten-inline-editors-get-a-rule-module.md)       | app                                  | 1          | `rules/<editor>.ts` extracted from each editor that computes offers beside its DOM code                                                                                                              |
| 3   | [Situations, and the derived model](archive/situations-and-the-derived-model.md)                      | app                                  | 1, 2       | The fixture list, the headless driver, the zod schema, `ux-model.json`, and the three lint rules the derived tier answers                                                                            |
| 4   | [Pseudo-commands, and a control's list of effects](archive/pseudo-commands-and-a-controls-effects.md) | app                                  | 1          | The closed effect vocabulary in the catalog, closures rewritten as recorded effects, and the four rules effects unlock                                                                               |
| 5   | Disabling menu items, and refusals that carry a reason                                                | `vendor/path.ux`                     | —          | **Already written and complete**, and the authority on its own scope: `menu-item-disabling.md`, stages 1-5 done, stage 6 (the native menu bar) dropped                                               |
| 6   | [Finishing the meta-tag system](../../vendor/path.ux/documentation/plans/meta-tag-system.md)          | `vendor/path.ux` + `path-controller` | 5          | **Shipped 2026-09-09.** The barrel exports, an owner type covering a raw DOM node, a scope-plus-segment `widgetPath`, `enabled` and `refusal`, a validating deserialize, and the `toolPath` builders |
| 7   | [The measured tier reads tags](archive/the-measured-tier-reads-tags.md)                               | app                                  | 3, 6       | **Shipped 2026-09-09.** `act()` writes a `StdUXMeta`, the sweep reads it and walks widgets as a second oracle, derived compared against measured                                                     |
| 8   | [`affects` on every command, and the executed tier](every-command-declares-what-it-touches.md)        | app                                  | —          | **Written 2026-09-09.** Each mutating command declaring the subtrees it may write, two rules tying that to `undoable`, and an executed tier that diffs a snapshot around each run                    |

Plans 1, 2, 3 and 7 are the model itself. Plan 4 widens its vocabulary past commands.
Plans 5 and 6 are submodule work committed separately; 5 was already complete there before
the batch began, and 6 reached `path-controller` as well, where `Refusal` became a
registered struct. Plan 8 is independent of every other row and is worth taking on its own
merits.

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

Plan 6 shipped it. `widgetSegment` and `widgetPathOf` are functions on the barrel, and
[`meta_tags.md`](../../vendor/path.ux/documentation/meta_tags.md) documents what they do.
A path is a caller-supplied scope plus one segment; the segment is a readable stem and
eight hex digits of FNV-1a over an allow-list — the tag's flattened `valuePath`, then each
tool's `identity()`.

**Superseded in part by the plan.** Rejecting `saveUIData`'s positional walk and `_id`
still holds, and so does hashing what a widget does. The rest does not: a hash chained
over meta-bearing ancestors assumed a tree that nothing builds, since only controls carry
tags and a rule module answers with a flat `Offer[]`. The plan's answer is a
caller-supplied scope plus one segment, an explicit `identity()` in place of a hash over
the serialized tag, and a repeated segment reported rather than disambiguated by an
occurrence index — which the two tiers cannot count alike. Read
[`meta-tag-system.md`](../../vendor/path.ux/documentation/plans/meta-tag-system.md) for
the scheme; what follows is the reasoning it started from.

- **What the field's doc comment used to point at is positional.** `saveUIData`
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
  discriminator plus domain item keys. The occurrence index proposed here was rejected in
  the plan: the measured tier counts in DOM order and the derived tier counts within one
  module's `controls()` list, and two modules already draw into the `asset` home. A
  repeated segment within one scope is reported by whoever assembles that scope's records,
  the way a duplicate anchor key already is.
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

| Rule                                                             | Plan | Note                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every control carries a tooltip                                  | 1    | Enforced by the type, so no linter is needed                                                                                                                                                                                                                          |
| A disabled control states why, in the stack's own words          | 3 ✔  | Compares `refusal.reason`, never `refusal.description`; see the section above                                                                                                                                                                                         |
| A command has at least one control, or is listed as palette-only | 3 ✔  | Replaces `FLOOR`, which is a count rather than a list                                                                                                                                                                                                                 |
| The committed model was derived after the last `editors/**` edit | 3 ✔  | Answered by construction: `ux-model.json` carries no sha, and a jest test fails until it equals a regeneration ([`archive/situations-and-the-derived-model.md#decisions-this-plan-settles`](archive/situations-and-the-derived-model.md#decisions-this-plan-settles)) |
| A surface opens an editor only through the sparing rule          | 4 ✔  | Over every `view.open` in the model: no `where` or `elsewhere`; `here` only on a row `routeFor` placed; `popup` only for the agent report; nothing splits (`src/main/tests/uxmodel.test.ts`)                                                                          |
| A mutating command reachable from a menu is undoable or confirms | 4 ✔  | Over every menu record run on the click, against the registry's `mutating`, `undoable` and `confirm`; `rules/menuexempt.ts` lists the six allowed exceptions with reasons, and a dead exemption fails                                                                 |
| A keyboard shortcut is bound once                                | 4 ✔  | `key.bind` is a property, not an effect: `rules/shortcuts.ts` is the one table, a combination appears once per scope, and an editor takes a shell combination only with `shadows: true`                                                                               |
| Two controls in one pane share a key only with a discriminator   | 4 ✔  | `keyOf` gives `cmd:`, `item:` and `fx:` keys with `#<on>`; `duplicateKeys` per situation, and no key from two modules of one home                                                                                                                                     |
| Enabled state agrees with `stack.check`                          | —    | Already checked by the sweep; plan 7 carries it across and adds wording                                                                                                                                                                                               |
| The ring lands on the control                                    | —    | Already checked by the sweep; plan 7 carries it across                                                                                                                                                                                                                |
| A bound path resolves on the api its own pane carries            | —    | Deferred by plan 7: no renderer widget sets a `datapath`, so the check has an empty population and passes by construction. Worth taking the day one does                                                                                                              |

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
- **Plan 4** (answered) — twelve effects, listed in
  [`archive/pseudo-commands-and-a-controls-effects.md#decisions-this-plan-settles`](archive/pseudo-commands-and-a-controls-effects.md#decisions-this-plan-settles);
  `key.bind` is a property of the control it duplicates, held in `rules/shortcuts.ts` and
  stamped on the record as `shortcut`.
- **Plan 5** — the tooltip expander the long form is written for, which `tooltipText`
  appends in the meantime. Whether a refusal disables a control is already answered: it
  does not, and a refusal on an enabled control is not shown at all.
- **Plan 6** (answered) — the `widgetPath` scheme is a caller-supplied scope plus one
  segment hashed from an explicit `identity()`, and the receiving side calls
  `validateJSON` rather than converting the STRUCT to zod, because a converter is a second
  schema to keep in step and the boundary is between two halves of one program. A consumer
  is still free to validate its own assembled dump with zod, as the desktop app does for
  `anchors.json`. See
  [`meta-tag-system.md`](../../vendor/path.ux/documentation/plans/meta-tag-system.md).
- **Plan 7** (answered) — `AnchorDump` is replaced and `Anchor` is kept, because `via`
  holds live node handles no tag can carry; `anchors.json` keeps its shape and gains a
  `widgetPath`, because the tour's resolver reads it before any pane is open and CI reads
  it where there is no app; and a record names its api through the scope, since the api is
  a function of the home. The plan also establishes that `enabled`, `tooltip` and the
  refusal sentence cannot be compared across the tiers at all — the derived tier is
  situation-indexed and a `widgetPath` is situation-blind by construction. See
  [`the-measured-tier-reads-tags.md`](archive/the-measured-tier-reads-tags.md).
- **Plan 8** (answered) — `affects` is a list of path prefixes and not `ui.*` field names:
  a command reaches only three of the seven `ShellState` selection fields, and only
  through a `view.*` effect's `subject`, so the executed tier — which has no renderer —
  could never measure such a claim. The diff is matched with `checkWrittenScope`'s own
  rule (`p === s || p.startsWith(s + '/')`), against a closed vocabulary that includes a
  `<user>` sentinel for the four commands writing outside the workspace. See
  [`every-command-declares-what-it-touches.md`](every-command-declares-what-it-touches.md).

## What the numbers are today

Measured from the committed `apps/desktop/ux-model.json` and `apps/desktop/anchors.json`
(both after plan 4, 2026-09-08) and the source.

- Derived: 135 situations over 29 modules (23 rule modules, the pin toggle counted once,
  and six menu sources), 1244 records (981 from `controls`, 263 from the menus), 95
  commands with a control, 12 of the twelve effects offered, 64 palette-only entries
  covering the other 75 of the registry's 170, 20 shortcuts and 6 menu exemptions. 139
  control records are refused, 5 of them worded by the stack, and 41 carry a `shortcut`. A
  record's `situation` is a `module` plus a name (`assetview` / `portrait-unapproved`)
  rather than the research's `portrait:unapproved`.
- Measured: 170 commands in the registry, 78 with a control on file and 10 of the twelve
  effects drawn, 429 records (339 controls, 90 menu entries), 0 strays, 0 enabled-state
  disagreements, 0 `wording` disagreements, and every live keymap agreeing with the
  shortcut table.
- 20 homes appear in the sweep: the editors, the onboarding pane and the three toolbar
  popups, opened by pressing their header controls. The header's own anchors are live in
  every dump. Every file under `renderer/pathux/editors/` and the three popups in
  `chrome/` draw through `act()`, `record()` or `pick()`; the notification popup's five
  `notify.*` controls are anchors like any other.
- `renderer/rules/` holds the rule modules, the menu table, the shortcut table and the
  effect helpers. Every anchor home has a module that returns its offers through
  `controls(state)`; no editor computes an offer inline, and no editor runs a closure with
  no record.
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

Nothing, as of 2026-09-09: plan 6 closed the last of it. The report says no builder writes
`toolPath` or `valuePath`; half of that was already untrue when this was written, and the
other half has no consumer in this app.

- **`valuePath` is already written, because a data path has only one home.** path.ux
  stores it in the `datapath` DOM attribute, and `StdUXMeta.valuePath` proxies to
  `getAttribute("datapath")` (`ui_meta_tags.ts:284`). Sixteen builder sites set it, so the
  tag reads a live value today for anything built through `prop`, `slider`, `textbox`,
  `check`, `listbox` and the rest. A sweep can read a bound path off any widget with no
  new writer anywhere, which is why the `valuePath` lint rule needs no path.ux change at
  all.
- **`toolPath` is written now, and this app still would not read it.** Plan 6 added
  `PathToolMeta` and had `toolImpl` and the tool-path menu rows write it, both through
  `ensureMeta`. That was submodule hygiene: the desktop's controls run `@vn/commands` ids
  through `act()`, so a command id reaches a record through the app's own `UXToolMeta`
  subclass instead.
- **`HotKey` has the same split as plan 4's closures.** Its `action` is either a toolpath
  string, which is recordable as it stands, or an opaque callback
  (`vendor/path.ux/scripts/path-controller/util/simple_events.ts:917`), which has to
  become a named effect before "a keyboard shortcut is bound once" can be checked.
- **`widgetPath` has a scheme.** Covered above.

## Two path.ux bugs, independent of the batch — both fixed

Found while checking the report's claims. Both were fixed in the submodule before plan 6
was written, and re-checking them is what establishes that the tag's two proxying
accessors read trustworthy values. Neither is work. The report's original wording is
quoted under each, so the claim stays traceable.

- **Three builders ignored `dataPrefix`.** All three join now (`container_widgets.ts:356`,
  `:386`, `container_enum.ts:27`), and every other site that writes the `datapath`
  attribute joins it earlier in the same function. As reported: "`textareaImpl`,
  `viewerImpl` and `iconcheckImpl` store the raw argument, where every other site stores
  `self._joinPrefix(inpath)` — `textbox`, `pathlabel`, `colorbutton`, `curve1d`,
  `vecpopup`, `colorPicker`, `check`, `listenum`, `prop`, `slider` and `listbox` all join.
  Under a container with a prefix those three record a relative path that does not resolve
  standalone, which is what the `valuePath` rule would report."
- **`iconcheck` never got its tooltip.** `container_enum.ts:24` reads `description ?? ""`
  now. As reported: "it reads `ret.description = name ?? ""`, and no `name` is in that
  function's scope — the parameter is `description`, and the `name` bindings further down
  the file belong to `checkImpl`. It resolves to the global `name`, so the description
  argument is dropped and the tooltip is the empty string."

## The list

- [x] 1 — one `Offer`, and the six rule modules unified (shipped 2026-09-07:
      [`archive/one-offer-and-the-six-rule-modules.md`](archive/one-offer-and-the-six-rule-modules.md))
- [x] 2 — the ten inline editors get a rule module (shipped 2026-09-08:
      [`archive/the-ten-inline-editors-get-a-rule-module.md`](archive/the-ten-inline-editors-get-a-rule-module.md))
- [x] 3 — situations, and the derived model (shipped 2026-09-08:
      [`archive/situations-and-the-derived-model.md`](archive/situations-and-the-derived-model.md))
- [x] 4 — pseudo-commands, and a control's list of effects (shipped 2026-09-08:
      [`archive/pseudo-commands-and-a-controls-effects.md`](archive/pseudo-commands-and-a-controls-effects.md))
- [x] 5 — disabling menu items, and refusals that carry a reason (path.ux; complete before
      the batch began, stage 6 dropped:
      [`menu-item-disabling.md`](../../vendor/path.ux/documentation/plans/menu-item-disabling.md))
- [x] 6 — finishing the meta-tag system (path.ux + `path-controller`; shipped 2026-09-09:
      [`meta-tag-system.md`](../../vendor/path.ux/documentation/plans/meta-tag-system.md),
      [`meta_tags.md`](../../vendor/path.ux/documentation/meta_tags.md))
- [x] 7 — the measured tier reads tags (shipped 2026-09-09:
      [`the-measured-tier-reads-tags.md`](archive/the-measured-tier-reads-tags.md))
- [ ] 8 — `affects` on every command, and the executed tier (written 2026-09-09:
      [`every-command-declares-what-it-touches.md`](every-command-declares-what-it-touches.md))

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
- [`meta-tag-system.md`](../../vendor/path.ux/documentation/plans/meta-tag-system.md) —
  plan 6, in the submodule, and the authority on the `widgetPath` scheme and the tag's
  public surface.
- [`../reference/guided-tours.md`](../reference/guided-tours.md) — the anchor layer and
  the sweep as they ship.
- [`../reference/command-system.md`](../reference/command-system.md) — the registry and
  the catalog that plan 8 changes.

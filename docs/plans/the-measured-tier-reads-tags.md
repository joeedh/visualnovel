# The measured tier reads tags

Replaces the anchor layer's hand-written `AnchorDump` with a path.ux meta tag, so the
offer a control draws and the offer a rule module derives are one serialized type. Fixes
the two controls whose recorded offer already goes stale, and widens the
derived-against-measured comparison as far as it can honestly go.

Status: **planned**. Plan 7 of the eight in
[`ux-behaviour-model-tasklist.md`](ux-behaviour-model-tasklist.md); depends on plans 3 and
6, both shipped.

Revised once, after a fresh-context pressure test that removed two stages, inverted one
design decision and cut the plan's central claim in half. See [Findings](#findings) for
the disposition of each of the sixteen results.

<!-- toc -->

- [Context](#context)
    - [What exists](#what-exists)
    - [What plan 6 shipped, and what it costs to use](#what-plan-6-shipped-and-what-it-costs-to-use)
    - [The comparison that exists](#the-comparison-that-exists)
- [The situation mismatch](#the-situation-mismatch)
- [Decisions this plan settles](#decisions-this-plan-settles)
    - [`Anchor` stays; `AnchorDump` goes](#anchor-stays-anchordump-goes)
    - [`anchors.json` keeps its shape and gains one field](#anchorsjson-keeps-its-shape-and-gains-one-field)
    - [A pass owns its node's tools](#a-pass-owns-its-nodes-tools)
    - [The scope is the home, with no pane id](#the-scope-is-the-home-with-no-pane-id)
    - [`toolPath` carries the command id](#toolpath-carries-the-command-id)
    - [`props` and `then` serialize as JSON strings](#props-and-then-serialize-as-json-strings)
    - [One converter, two callers](#one-converter-two-callers)
    - [The tag is written, not read back](#the-tag-is-written-not-read-back)
    - [Menus stay on the table](#menus-stay-on-the-table)
- [What changes](#what-changes)
    - [Stage 1 — the two re-presented controls record through a pass](#stage-1--the-two-re-presented-controls-record-through-a-pass)
    - [Stage 2 — the alias, and `VnToolMeta`](#stage-2--the-alias-and-vntoolmeta)
    - [Stage 3 — `tagOf`, and the derived tier writes `widgetPath`](#stage-3--tagof-and-the-derived-tier-writes-widgetpath)
    - [Stage 4 — the pass writes the tag, and the sweep reads it](#stage-4--the-pass-writes-the-tag-and-the-sweep-reads-it)
    - [Stage 5 — the sweep walks widgets](#stage-5--the-sweep-walks-widgets)
    - [Stage 6 — the widened comparison](#stage-6--the-widened-comparison)
    - [Stage 7 — the sweep, and the docs](#stage-7--the-sweep-and-the-docs)
- [Testing](#testing)
- [Risks](#risks)
- [Follow-ups deliberately not in scope](#follow-ups-deliberately-not-in-scope)
- [Findings](#findings)
    - [Accepted](#accepted)
    - [Rejected](#rejected)

<!-- tocstop -->

## Context

Measured on `master` at `f006d7ef`, after plans 4 and 6.

### What exists

- **`renderer/rules/anchors.ts`** (441 lines) holds the pure shapes and the resolution:
  `Offer`, `Control`, `Action`, `Anchor`, `Resolution`, `keyOf`, `applyOffer`,
  `resolveAnchor`. Node-only jest runs it.
- **`renderer/pathux/tour/anchors.ts`** (444 lines) is the live registry. `AnchorPass.act`
  wires the click, presents the offer and pushes an `Anchor`, from one object; `record`
  and `pick` are the variants. `dumpAnchors()` projects to `AnchorDump[]`;
  `installAnchors()` exposes `dump`, `menus`, `strays`, `shortcuts`, `press`,
  `generation`.
- **`scripts/sweep-anchors.mjs`** (352 lines) drives the built app over CDP, opens each
  editor, reads `window.__vnAnchors.dump()`, calls `stack.check` per command anchor,
  writes `apps/desktop/anchors.json`.
- **`apps/desktop/anchors.json`** — 429 records: 339 control records (`{id, editor, key}`
  plus `supplies`, `form`, `refused`) over **20** homes, and 90 menu records
  (`{id, editor, when}`) over 21. `header` has **zero** control records, because the sweep
  iterates `view.open`'s editor list and filters the dump by editor, and the header is not
  an editor.
- **`apps/desktop/ux-model.json`** — 1244 records over 135 situations; 981 control, 263
  menu.

`AnchorDump` is **not** a committed artifact. It is the wire format between the page and
the sweep script, which reduces it to the three- or four-field records that reach
`anchors.json`.

### What plan 6 shipped, and what it costs to use

`StdUXMeta` carries `widgetPath`, `description`, `valuePath`, `enabled`, `refusal` and
`tools`; `walkWidgets(root)` yields tag-bearing owners through shadow roots;
`widgetPathOf(owner, scope)` gives `<scope>/<segment>`; `widgetSegment(tag)` hashes the
flattened `valuePath` and each tool's `identity()`. `ui_meta_tags.ts` imports nothing at
runtime but nstructjs, so node can build a tag.

Two costs before any of it is usable here:

- **A fourth path.ux alias.** jest maps `pathux-graph`, `pathux-toolprop` and
  `pathux-base-types`, and deliberately not the widget barrel, because `pathux.ts` reaches
  `config/const.ts`, which assigns `window.DEBUG` at module scope (`const.ts:288`).
  `renderer/rules/**` is node-only jest, so it needs `pathux-meta` pointing at
  `ui_meta_tags.ts`: `jest.config.cjs` and `apps/desktop/vite.config.ts` to source, root
  `tsconfig.json` to the declaration `build:pathux-types` already emits.
- **A concrete `UXToolMeta` subclass.** `PathToolMeta` carries only `toolPath`. The app's
  controls run `@vn/commands` ids with props, `on`, `supplies`, `form` and `then`.

### The comparison that exists

`src/main/tests/uxmodel.test.ts:91-105` asserts, one direction only, that every swept
control has _some_ derived record in that editor with the same `id`, and the same `form`
and `supplies` where the swept record carries them. It matches with `.some()` and compares
`form` and `supplies` conditionally, so it is looser than "four fields" suggests. Nothing
compares `tooltip`, `props`, `on`, `then`, `enabled` or the refusal sentence.

## The situation mismatch

The reason the existing test is loose, and the constraint that bounds this plan. It was
not understood when the plan was first written, and it is the most useful thing here.

**The derived tier is situation-indexed; the measured tier is not.** A rule module answers
`controls(state)` once per situation, so the 981 derived control records collapse to
**300** distinct `(editor, key)` pairs. Of those, **47** carry records that disagree with
each other on `offer.ok`, and **31** disagree on `offer.tooltip` — `header`'s
`cmd:pipeline.run` is both accepted and refused, depending on the situation. That is
correct: it is what a situation list is for.

`widgetSegment` hashes what a control _does_ — the flattened `valuePath` and each tool's
`identity()` (`ui_meta_tags.ts:417-422`). It contains no situation, and cannot: a path
that changed when a control became refused was rejected in plan 6 for exactly this reason.

So a measured record, which observes one screen state, keys onto several derived records
holding contradictory values for precisely the state-dependent fields. **`enabled`,
`tooltip` and the refusal sentence cannot be compared across the two tiers by any key the
tag can carry.**

Two consequences:

- **The comparison widens on the situation-invariant fields only** — `id`, `on`, `form`,
  `supplies`, `then`, and existence in both directions. Those are worth having and are not
  compared today.
- **The state-dependent fields already have a better oracle.** The sweep calls
  `stack.check` per command anchor and reports a disagreement, and separately reports a
  `wording` disagreement when a refused control's sentence is not the stack's.
  `stack.check` is the authority the rules are supposed to be echoing; the derived tier is
  a second echo. Comparing the two echoes to each other would be weaker than comparing
  either to the source.

Recording the swept situation, so the state-dependent fields could be compared, would mean
every rule module gaining a `situationOf(state)` that maps a live app state back to a
named situation. That is a plan of its own, and it is in
[follow-ups](#follow-ups-deliberately-not-in-scope).

## Decisions this plan settles

### `Anchor` stays; `AnchorDump` goes

The report says the tag replaces the dump. It does, and must not be read as replacing
`Anchor`: `Anchor.via` is `{kind:'dom', node}` or `{kind:'pick', nodeId, node?, rect?}`,
the live handles `resolveAnchor`, `landsOn`, `rectOf` and `hidden` need at interaction
time. A tag is a serialization carrier with nowhere to put a node.

`AnchorDump` is exactly the serializable half. It is deleted, along with its use in
`renderer/global.d.ts:3,18`, and `dumpAnchors()` returns `{ tag, via, nodeId?, rect? }`.

### `anchors.json` keeps its shape and gains one field

Not absorbed into the model. The tour's resolver and `mapOf` read it at planning time
before any pane is open and want the small projection; `anchorcoverage.test.ts` and
`uxmodel.test.ts` read it in CI, where there is no app. It gains `widgetPath` per control
record, which stage 6 keys on.

### A pass owns its node's tools

Plan 6 has path.ux's own builders use `ensureMeta` and append to `tools`, so a
`container.tool` button and the app's `act()` do not clobber each other. **Appending is
wrong for the app**, and this is the one place plan 6's rule is inverted.

Two production sites re-anchor the same element from a later pass:

- `app/editor.ts:100-115` — the pin toggle is re-recorded through a fresh
  `redrawing(areaname, 'pin')` on every flip, on the same widget, deliberately.
- `editors/graph.ts:532` and `:587` — the gate buttons are anchored, then the same `cta`
  elements are anchored again from a second pass when the async `command:check` answers.

Appending there would grow `tools` without bound, and because `widgetSegment` hashes every
tool's `identity()`, **the node's `widgetPath` would change on every redraw**. The sweep
waits `SETTLE_MS = 700` after opening a pane, so it would read post-accumulation tags and
`anchors.json` would not be reproducible.

The rule: **the first time a pass presents a node, it replaces that node's `tools`; later
presentations within the same pass append.** `AnchorPass.presented` already tracks exactly
that distinction, and is already the thing that raises the error when two offers would
present one node differently.

### The scope is the home, with no pane id

The first draft had the scope carry a pane id — `nodes#<paneId>` — so a second Gen Graph
pane would be distinguishable. That is unbuildable and unnecessary:

- `Row.editor` is a bare `AnchorHome` (`rules/model.ts:70-75`), so the derived tier cannot
  produce a pane id, and stage 6 keys on `(editor, widgetPath)`. The two tiers would
  disagree on exactly the homes the pane id existed for.
- The home is `gengraph`, not `nodes`.
- `redrawing` already keys passes globally as `${editor}/${part}`, so a per-pane scope
  would need a per-pane pass key too.

Two Gen Graph panes drawing the same control produce the same `widgetPath`, which is
correct: they offer the same thing.

### `toolPath` carries the command id

`stemOf` reads `tag.tools[0]?.toolPath || valuePath` and falls back to the literal `w`. No
renderer widget sets a `datapath` — the only occurrence in `apps/desktop/renderer` is a
comment at `app/persist.ts:242` — so `valuePath` is empty everywhere. If `VnToolMeta` left
`toolPath` at its `""` default, every one of the 1320 control records would read
`<scope>/w~<hash>`, defeating the stem's whole purpose: that a diff of the committed model
can be read by a person.

So `VnToolMeta.toolPath` is the `@vn/commands` id. It is not a path.ux tool path, and the
doc comment says so; the field's contract is "what this control runs", and the command id
is the app's answer.

### `props` and `then` serialize as JSON strings

nstructjs has `ITERKEYS` for a homogeneous key/value map and nothing for a heterogeneous
union or a nested record. `PropValue` is `string | number | boolean | string[]`
(`shared/uxmodel.ts:19`), and each `Action` in `then` nests its own props record.

So `VnToolMeta` declares `props: string` and `then: string`, each `JSON.stringify`d, with
typed accessors either side. They are round-tripped, never queried inside the tag, and
neither enters `identity()`.

### One converter, two callers

`tagOf(offer, scope): StdUXMeta` lives in `renderer/rules/anchors.ts` beside `keyOf` and
`applyOffer`, is pure, and is called from `AnchorPass` with a node and from the model
driver with no owner. Plan 6's headless rule is what allows the second. If each tier built
its own tag, the comparison would compare two spellings of one idea.

### The tag is written, not read back

`AnchorPass` keeps pushing an `Anchor`; the tag is not what `liveAnchors()` reads. Making
the registry a view over the DOM costs a tree walk per resolution on a path the tour hits
every frame, and loses the pass ordering and the `presented` de-duplication.

### Menus stay on the table

Menu rows keep being recorded through `rules/menus.ts` and read by `__vnAnchors.menus()`.
The menu comparison already runs entry for entry in both directions and passes; the app's
menus are built from object-form rows with callbacks, so path.ux's `menu_ops.ts` tag
writer does not reach them; and a menu row lives for one popup, so reading its tag means
opening every menu, which plan 4 deliberately stopped doing.

## What changes

Seven stages, one commit each, green under `pnpm check`, `pnpm test` and `pnpm lint`.
Stage 1 is an independent bug fix and can land alone. Stages 2 and 3 are additive and
leave the app unchanged. Stage 4 is the replacement, and it carries the sweep script with
it.

### Stage 1 — the two re-presented controls record through a pass

**Done.** A live defect the tag would otherwise triple.

`editors/convo.ts:329` and `:361` call `applyOffer` directly on `budgetMenu` and
`compactBtn`, both of which were anchored earlier through `anchors.record` / `anchors.act`
(`:268`, `:293`). The comment at `:354-358` explains why the bar is not rebuilt — a menu
open over it would close — but the consequence is that the recorded `Anchor.enabled` and
`reason` go stale against what the button shows, on the two controls whose offer changes
most often.

Both sites re-record through a fresh pass, the way `app/editor.ts` does for the pin
toggle. Test: after a budget change, the anchor's `enabled` and `reason` match the
presented offer.

As shipped:

- Each control anchors **only** through its own pass — `convo/budget` and `convo/compact`
  — and the bar's pass records neither. Leaving the bar's record in place would have
  shadowed the fresh one: `liveAnchors()` flattens passes in insertion order and
  `anchorFor` takes the first match, and the bar's pass is created first.
- The test is a source scan rather than the behavioural one described.
  `pathux/tour/anchors.ts` imports the widget barrel, which assigns `window.DEBUG` at
  module scope, so node-only jest can construct neither the editor nor a pass.
  `rules/tests/anchors.test.ts` asserts instead that `tour/anchors.ts` is the only file
  under `renderer/pathux/**` that calls `applyOffer` — the invariant the two fixes
  restore, and the one a later editor would break.

### Stage 2 — the alias, and `VnToolMeta`

**Done.** `pathux-meta` in the three config files. `renderer/rules/toolmeta.ts`:
`VnToolMeta extends UXToolMeta<'vn'>`, registered as `vn.VnToolMeta`, carrying `toolPath`
(the command id), `on`, `supplies`, `form`, and `props` / `then` as JSON strings.
`identity()` returns `toolPath`, `on`, `form` and the sorted `supplies` — not `props`,
which a widget supplies at commit time, and not the tooltip, which is presentation. A jest
test constructs one headlessly, proving the alias.

As shipped:

- **Four config files, and not the ones named.** The alias goes in `jest.config.cjs` and
  `apps/desktop/vite.config.ts` to source, in `apps/desktop/renderer/tsconfig.json` to the
  declaration, and in `scripts/aliases.mjs` — which is what `loadEntry` hands esbuild, so
  without it `pnpm gen:uxmodel` cannot bundle stage 3's driver. The **root**
  `tsconfig.json` needs no entry: it includes `packages/*/src`, `apps/*/src` and
  `scripts`, and nothing under those imports the tags. The renderer typechecks against its
  own config.
- `static override STRUCT`, because the renderer's tsconfig sets `noImplicitOverride` and
  `UXToolMeta` declares `STRUCT` too.
- `props` and `then` are plain string fields with `propValues` / `thenActions` accessors
  either side, and the constructor takes an optional `ToolFacts` so nstructjs can still
  build one with no arguments.
- The test also round-trips a `StdUXMeta` holding one through `writeJSON` and
  `readMetaJSON`, which is what proves the struct registration rather than only the alias.

### Stage 3 — `tagOf`, and the derived tier writes `widgetPath`

**Done.** `tagOf` in `rules/anchors.ts`; the model driver calls it per control record;
`ux-model.json` gains `widgetPath` on control records, with the schema in
`src/shared/uxmodel.ts`; `pnpm gen:uxmodel`.

A rule: no two control records in one situation share a `widgetPath`. `model.test.ts:45`
already asserts `duplicateKeys` over `keyOf` (id plus `on`), and `identity()` is a strict
superset of those inputs, so this can only fire on an FNV-1a collision. That is what it is
for: the digest is 8 hex digits over roughly 300 segments per scope, and a collision would
silently merge two controls in stage 6.

As shipped:

- `tagOf(offer, scope)` fills `widgetPath` itself, since it is given the scope;
  `widgetPathOf` from `ui_meta_walk.ts` is not used, because it needs an owner and the
  driver has none. A sibling `toolOf(offer)` builds the tool alone, which is what stage 4
  appends on a second presentation of one node.
- `widgetPath` is required in `UX_RECORD`'s control branch and sits directly after `key`.
  The two hand-written fixtures in `src/shared/tests/uxmodel.test.ts` gain one.
- **981 control records collapse to 302 `(editor, widgetPath)` pairs, against 300
  `(editor, key)` pairs.** `supplies` and `form` enter `identity()` and not `keyOf`, so a
  control offered with and without a supplied prop is two names and one key. Stage 6 keys
  on the finer of the two.

### Stage 4 — the pass writes the tag, and the sweep reads it

**Done.** One commit, because splitting it leaves `anchors.json` unregenerable and no gate
would say so — the sweep is a hand-run `.mjs` that `pnpm check`, `pnpm test` and
`pnpm lint` never execute.

- `AnchorPass.present` calls `tagOf` and attaches the tag, replacing `tools` on the pass's
  first sight of the node and appending on later ones.
- `AnchorDump` deleted, here and in `renderer/global.d.ts`; `dumpAnchors()` returns
  `{ tag, via, nodeId?, rect? }`.
- `sweep-anchors.mjs` reads the new payload — `:167-230` currently reads `a.editor`,
  `a.id`, `a.key`, `a.props`, `a.supplies`, `a.form`, `a.enabled` and `a.reason` off the
  dump.
- Re-run the sweep and commit `anchors.json`, with `widgetPath` on control records. Expect
  the same 429 records, 0 strays, 0 disagreements.

As shipped:

- **The tag is attached by `writeTag` in `rules/anchors.ts`, not by `present` itself.** It
  takes the owner, the offer, the scope and whether this is the pass's first sight, and
  `tagOf` is now `writeTag({}, offer, scope, true)` — one body, so the two tiers cannot
  drift. Putting it in the rules module is also what makes the replace-then-append rule
  testable: `pathux/tour/anchors.ts` imports the widget barrel and node-only jest cannot
  load it.
- **`dumpAnchors()` returns `{ key, editor, tag, via, nodeId?, rect? }`.** The two extra
  fields are the `Anchor`'s own rather than the offer's, and the tag has nowhere to put
  either: `key` is the resolver's `cmd:` / `item:` / `fx:` namespacing, which the sweep
  would otherwise have to re-derive from `keyOf`'s rules in a second language, and
  `editor` is the scope half of `widgetPath`, which is cheaper to name than to parse back
  out of a hashed path.
- **The tag is read off the node, not kept on the anchor**, with `tools` narrowed to the
  tool that anchor's own offer put there. The node's tag is the one stage 5's walk will
  find, so taking the dump from anywhere else would give the walk something to disagree
  with.
- The sweep flattens the payload through one `read()` helper, so the rest of the script is
  unchanged, and reports an `untagged` list — anchors whose control carries no tag at all.
  It is empty.
- **Measured:** 429 records (339 control over 20 homes, 90 menu), 0 strays, 0
  disagreements, 0 untagged, and every control record carries a `widgetPath`.
- **Reproducibility, checked as the plan asks:** a second sweep after flipping the Script
  pane's pin three times and opening the task graph is byte-identical to the first apart
  from `sweptAt`. The pin's `widgetPath` (`script/pane-pin~3ef17e3e`) does not move across
  a flip.
- `toolsys.Refusal` is registered by `toolop.ts`, which only the widget barrel pulls in —
  so `nstructjs.writeJSON` of a refused tag works in the app and throws in a node-only
  test. No test serializes a refusal.

### Stage 5 — the sweep walks widgets

**Done, as a second oracle rather than as the replacement described.**

`dumpAnchors()` walks the **screen root** with `walkWidgets` rather than each open pane's
root: the three popup homes mount on the screen with `screen.popup(...)`
(`chrome/notifications.ts:134`, `approvals.ts:68`, `diagnostics.ts:51`), and the header is
not a pane either.

**Establish before writing it** that `walkWidgets` reaches every population.
`ui_meta_walk.ts:21` descends `root instanceof UIBase ? root.shadow : undefined`, so a
shadow root on a non-`UIBase` element is invisible to it — and `sweep-anchors.mjs:126-128`
walks `node.shadowRoot` for every element, which suggests the author expected such roots.
If any exist over an anchored control, `walkWidgets` needs widening in path.ux first, and
that is a submodule change with its own gate.

The check that the replacement is safe is an in-page assertion that the walk and the pass
produce the same key set. If it cannot be made to agree, stop: stages 1 to 4 stand on
their own, and the tag is already the dump format.

As shipped:

- **Reachability, established first, in the running app.** A probe walked the document
  twice — once descending only a `UIBase`'s `shadow`, the way `walkWidgets` does, and once
  descending every element's `shadowRoot` — over seven homes. The two walks found the same
  set every time, 58 to 121 tagged nodes per home, with nothing the wide walk reached that
  the narrow one did not. **No path.ux change is needed**, and no `walk-widen` branch was
  made.
- **The walk does not replace the dump.** Three things stop it, all found by building it:
    - `Anchor.key` — the resolver's `cmd:` / `item:` / `fx:` namespacing — is not in the
      tag, and a walk-built dump would have to re-derive it from `keyOf`'s rules in a
      second language.
    - `Anchor.via` says whether a click reaches the node or the canvas underneath it. The
      DOM does not say that; only the pass that recorded it does.
    - The walk and the pass disagree by design on **drawnness**. `liveAnchors()` drops an
      anchor whose node has no size, and the walk keeps its tag: the composer's Stop
      button and the agent report's are in the document and hidden between turns, so the
      walk finds two named controls the passes do not offer. That is the two tiers being
      right about different questions, not a fault to reconcile.
- **So the walk ships as `window.__vnAnchors.walk()`**, the sorted `widgetPath` of every
  named control the document holds. Per home the sweep asserts every anchored path is one
  the walk reached, and writes what it could not under a new `unwalked` key in
  `anchors.json`. It prints the other direction — walked but unclaimed — as information.
- **Measured:** 429 records, 0 strays, 0 disagreements, 0 untagged, **0 unwalked**; and
  two informational lines, `convo/agent-stop~aa84330a` and `report/report-stop~45bc2b95`.
- Only this app's writer fills `widgetPath`, so a tag path.ux's own builders leave on a
  button is walked past rather than reported.
- **A pre-existing non-determinism, unrelated to this work:** the onboarding pane's two
  `project.setKey` rows swap order between app restarts, so `anchors.json` moves two
  records. It is stable within one session — the stage 4 reproducibility check was
  byte-identical.

### Stage 6 — the widened comparison

`uxmodel.test.ts` compares derived and measured on the situation-invariant fields only —
`id`, `on`, `form`, `supplies`, `then` — keyed on `(editor, widgetPath)`, and in both
directions for existence within a home the sweep actually visited. `enabled`, `tooltip`
and the refusal sentence are excluded, with the reason from
[the situation mismatch](#the-situation-mismatch) written into the test's doc comment so
nobody adds them later.

`header` is excluded explicitly: it has zero measured control records, for the structural
reason above.

### Stage 7 — the sweep, and the docs

Re-run the sweep, and update
[`../reference/guided-tours.md`](../reference/guided-tours.md) — Part I's registry and
dump sections, Part III's record, and the enforcement list — plus an As-shipped section
here, the tasklist row and `index.md`.

## Testing

- `pnpm check`, `pnpm test`, `pnpm lint` at every stage.
- New jest: the convo re-record; `VnToolMeta` headless construction and `identity()`;
  `tagOf` over an accepted and a refused offer; `widgetPath` uniqueness per situation; a
  pass replacing then appending `tools`; the widened comparison.
- The CDP sweep by hand at stages 4, 5 and 7 — `pnpm build:desktop`, then
  `node scripts/vndesktop.mjs --mock --project examples/mySampleRepo`, then
  `VN_CDP_PORT=9222 node scripts/sweep-anchors.mjs`. Expect 429 records, 0 strays, 0
  disagreements throughout.
- A second sweep at stage 4 after flipping a pin and opening the task graph's gate,
  asserting `anchors.json` is byte-identical. That is the reproducibility the
  tools-replacement rule exists for.

## Risks

- **Highest: `walkWidgets` misses a population.** Stage 5's whole content. Contained by
  establishing reachability before writing it, and by the walk-versus-pass assertion.
- **High: the tag is a third store of a fact that already has two.** Stage 1 removes the
  stale pair; after it, the tag and the anchor are written from one object inside
  `present`, which no editor calls directly. But it is still duplication, and a later
  editor could re-present a control the way convo.ts did.
- **Medium: `anchors.json` churn.** `widgetPath` on 339 records, plus whatever the walk
  reorders in stage 5. Reviewable only because the stem carries the command id.
- **Medium: the model file grows** by roughly 40 characters on 981 records.
- **Low: the fourth alias**, three config files, one of them to a generated declaration.

## Follow-ups deliberately not in scope

- **`situationOf(state)` per rule module**, so the sweep can name the situation it
  observed and the state-dependent fields become comparable. The prerequisite for ever
  closing the gap in [the situation mismatch](#the-situation-mismatch).
- **The `valuePath` lint rule** — "a bound path resolves on the api its own pane carries".
  The population is empty: no renderer widget sets a `datapath`, so the check would
  resolve zero paths and pass by construction. Worth taking the day a renderer widget
  binds a path, and the per-pane `DataAPI` (`editors/nodes.ts:236`) that makes an
  unresolved path possible is already there.
- **Measuring the header.** The sweep iterates `view.open`'s editor list, and the header
  is not an editor, so it has no measured control records at all. Widening the comparison
  does not help a home with nothing on the other side.
- **Making the registry a view over the tags.** Argued above; revisit on evidence.
- **Menu rows as tags**, and with them opening every menu during the sweep.
- **The tour reading tags.** Its resolver wants live handles, not serialized ones.

## Findings

From a fresh-context pressure test of the first draft. Sixteen results.

### Accepted

1. **The `(editor, widgetPath)` key is ambiguous on the derived side** — 981 control
   records collapse to 300 keys, 47 disagreeing on `ok` and 31 on `tooltip`. The largest
   finding, and it produced [the situation mismatch](#the-situation-mismatch) and cut
   stage 6 to the invariant fields.
2. **The stated stopping points were unreachable**, since the old stage 5 keyed on a
   measured `widgetPath` that only the tag stage produces. Restaged: the fix is a linear
   order with stage 1 as the independent piece.
3. **The containment argument was false.** `convo.ts:329` and `:361` call `applyOffer`
   outside any pass, so two controls already carry a stale recorded offer. Promoted to
   stage 1.
4. **`ensureMeta` plus append is a correctness bug, not a medium risk** — `widgetSegment`
   hashes every tool's `identity()`, and two sites re-anchor the same node from a later
   pass. Fixed: [a pass owns its node's tools](#a-pass-owns-its-nodes-tools).
5. **`valuePath` is the hash's first input and `Offer` has no source for it.** Resolved by
   finding 6: it is empty everywhere, so both tiers hash the same empty string. Stated
   rather than left implicit.
6. **Stage 6's population was empty.** No renderer widget sets a `datapath`. The rule
   moved to follow-ups with the evidence.
7. **`VnToolMeta` set no `toolPath`, so every stem would read `w`.** Fixed:
   [`toolPath` carries the command id](#toolpath-carries-the-command-id).
8. **The scope decision contradicted itself** — `Row.editor` cannot produce a pane id, the
   home is `gengraph`, and passes are keyed globally. Fixed: no pane id.
9. **The walk root missed four homes.** Fixed: the screen root, not each pane's.
10. **The stated highest risk was the wrong one.** A `pick` anchor always has an element,
    and `appendSurface` roots mount inside a `UIBase` shadow. The real gap is a shadow
    root on a non-`UIBase` element, which stage 5 now establishes first.
11. **Stage 3 would have left `anchors.json` unregenerable** with no gate to say so.
    Fixed: the sweep script is rewritten in the same commit.
12. **Serializing `props` and `then` was left to the implementer.** Fixed:
    [JSON strings](#props-and-then-serialize-as-json-strings).
13. **The uniqueness rule is nearly a duplicate of `model.test.ts:45`.** Kept, with what
    it actually guards now stated: an FNV-1a collision over 8 hex digits.
14. **`AnchorDump` has a third reference** in `renderer/global.d.ts`. Added.
15. **The header is never measured.** Stated in Context, excluded in stage 6, recorded as
    a follow-up.
16. **"Four fields wide" overstated the existing test**, which matches with `.some()` and
    compares two of them conditionally. Reworded.

### Rejected

None. Every finding changed the plan.

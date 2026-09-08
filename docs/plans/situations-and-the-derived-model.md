# Situations, and the derived model

Status: **planned**. Plan 3 of
[`ux-behaviour-model-tasklist.md`](ux-behaviour-model-tasklist.md), after
[`archive/one-offer-and-the-six-rule-modules.md`](archive/one-offer-and-the-six-rule-modules.md)
and
[`archive/the-ten-inline-editors-get-a-rule-module.md`](archive/the-ten-inline-editors-get-a-rule-module.md).
Every anchor home now answers `controls(state)` over plain data, so a driver over a list
of states produces the model the two research reports ask for
([`../research/ux-behaviour-model.md`](../research/ux-behaviour-model.md),
[`../research/formalizing-the-rules-modules.md`](../research/formalizing-the-rules-modules.md))
with no DOM, no main process and no meta tags. This plan writes the list of states, the
driver, the schema, the committed file, and the checks the derived tier can answer on its
own: that a refusal carries the stack's sentence, that every command has a control or is
listed as having none, that the file cannot be stale, and that nothing the sweep measures
is missing from what the modules derive.

## Context

Measured on `master` at `21c2886f`, after plan 2.

- **Seventeen modules answer `controls`.** Sixteen are the rule modules in the table in
  [`../reference/guided-tours.md#offers`](../reference/guided-tours.md#offers), one per
  anchor home, with the asset home served by two (`rules/assetview.ts:476`,
  `rules/promptview.ts:527`). The seventeenth is the document tree's menu: `menuFor(node)`
  (`renderer/pathux/doctree/doctree.ts:341`) is data, `MENU_NODES` (`:529`) is one node of
  every kind, and `menuAnchors()` (`:571`) enumerates the two into the 52 `documents`
  records the sweep already writes without opening a pane. `doctree.ts` is the pure half
  of the tree (its header says so, and `doctree/tests/doctree.test.ts` calls `menuFor`
  under node); its imports (`:10`–`:14`) are `rules/anchors`, `rules/skills`,
  `shared/ipc`, `chrome/contextmenu.ts`, itself pure with no `pathux` import, and a type
  from `./selection`.
- **The state types are heterogeneous, and small.** `HeaderState` has four fields;
  `ConvoBarState` seven, one of them a `Convo`; `AssetInfo | undefined`; `PromptView` plus
  an `editing` record; `BranchState`, `DocumentsState`, `GroupState`, `OnboardingState`,
  `ProjectBarState`, `ReportControls`, `ScriptPageState`, `SkillsState`, `GateState`,
  `TaskListState`, `TimelineState`, `WikiState`. Every module's test already builds two or
  three of them from a helper (`info()`, `portrait()`, `state()`), so a fixture per
  situation is a literal of a type that exists, not a new shape.
- **A verdict is state, and its message is copied.** A `CommandCheck` is
  `{ state: 'accept' | 'refuse' | 'undeclared'; message: string }`
  (`src/shared/ipc.ts:217`), carries no command id, and reaches a module inside its state
  (`BranchState.deleteVerdict`, `TimelineState.verdicts`, `OnboardingState.verdicts`,
  `GateState.gates`, `ReportControls.check`). A refusing verdict becomes a refused offer
  whose `refusal.reason` is the message verbatim, except at the task graph's gate, where a
  refusal with candidates on file keeps the button live and puts the sentence in the
  tooltip (`rules/taskGraph.ts:530`, and
  [`../reference/guided-tours.md#cross-checks`](../reference/guided-tours.md#cross-checks)).
  A module surfaces a verdict only under its own key: the branch editor drops the delete
  verdict when the scene is not `known` (`rules/branch/controls.ts:78`), the timeline
  drops every door verdict once the scene is decomposed (`rules/timeline/controls.ts:81`),
  and the onboarding page reads a `setKey` verdict under the vendor's chosen scope
  (`rules/onboarding.ts:108`). The report's grant boxes carry a `Refusal`
  (`GrantBox.refusal`, `rules/reportconvo.ts:79`), not a `CommandCheck`.
- **Some refusals are the rule's own sentence**, for a state the stack is not asked about
  or answers differently: a blank key box (`Paste a key first`), nothing open
  (`No document is open.`, `Nothing to save`), `No changes` on the art-style box, nothing
  selected in the Gen Graph pane (`Select the nodes to group first.`), a thread open for
  reading (`agent.compact`), and the mock refusal a module imports from the shared module
  main uses. CLAUDE.md's tooltip rule asks for the stack's words only where the stack
  declined, and for these the stack either declines about a blank (see the next bullet) or
  says something else (`agent.compact`'s sentences in main are `session.ts:1817`). No
  headless check can tell a paraphrase of a stack sentence from a sentence the stack never
  said unless the verdict is in the fixture.
- **The sweep writes keys and refusals, not wording, and it asks about blanks.** A swept
  record is `{ id, editor, key, supplies?, form?, refused? }`
  (`scripts/sweep-anchors.mjs:140`), with `refused` holding the reason; a menu record is
  `{ id, editor: 'documents', when, form? }` with no key. `AnchorDump`
  (`renderer/pathux/tour/anchors.ts:225`) carries no `label` and no `tooltip` either,
  because the live `Anchor` (`rules/anchors.ts:128`) does not keep them. The sweep's
  cross-check asks `stack.check` with `anchor.props` (`sweep-anchors.mjs:153`) and
  compares `anchor.enabled` against `verdict.state` and nothing else (`:159`). A refused
  offer carries no `props` (`rules/anchors.ts:60`), so for a command with a required prop
  the stack's answer is a coercion failure, `invalid props for "<id>": …`
  (`packages/commands/src/stack.ts:566`), which agrees on enabled state and on nothing
  else. That is what the stack said for the two Gen Graph buttons and would say for any
  refused control whose command takes a prop. Twenty of the file's records are refused.
- **The sweep visits one situation.** `apps/desktop/anchors.json` was measured against
  `examples/mySampleRepo` with `scene/arrival` selected and no shot: 170 commands, 51
  anchored, 139 records (52 of them the tree's menu), 0 strays, 0 disagreements. Its keys
  carry that project's data: `cmd:art.setSeed#location:rooftop`,
  `cmd:story.setLineText#arrival:L2`, `cmd:prompt.setChunk#style/mute`.
- **The header and the task graph are never swept.** The sweep iterates `view.open`'s
  `editor` values and keeps the dump's records for that editor (`sweep-anchors.mjs:45`,
  `:130`); `header` is not an `EditorId`, and the task graph's gate buttons need a run
  waiting at a gate. `anchors.json` therefore has no `header` and no `taskgraph` record,
  and the 51 anchored commands exclude `pipeline.stop`, `view.applyLayout` and the
  header's copies of the run and mode controls. The tasklist's "13 editor homes appear in
  the sweep" is this fact.
- **119 commands have no control on file**, and the number is guarded by a count:
  `anchorcoverage.test.ts:17` fails when `anchored.length` drops below `FLOOR = 40`. Its
  other three checks compare the file's command list to the live registry and the records
  to it.
- **A committed generated file has two precedents.** `docs/reference/command-table.md` is
  written by `scripts/gen-command-table.mjs` and `pnpm lint` fails through
  `scripts/check-command-table.mjs` when a regeneration differs. `anchors.json` is
  committed because regenerating it needs an app, and it is stamped with `sweptAt` and
  `gitSha` so a reader can tell how old it is. `apps/desktop/dist/commands.json` is the
  third shape, generated at build and never committed.
- **A script can load a `.ts` entry with no app.** `scripts/lib/load-entry.mjs` bundles an
  entrypoint with esbuild for node under `scripts/aliases.mjs`'s alias map, requires it,
  and returns one named export; the catalog and the command tables are both produced that
  way from `src/main/commands/*-entry.ts`. The alias map covers seventeen `@vn/*`
  packages, `pathux-graph`, `pathux-toolprop`, `pathux-base-types` and `nstructjs`; the
  three it omits (`artgen`, `bible`, `agentreport`) resolve through pnpm's workspace link
  and each package's `exports`, which is how `@vn/gengraph`'s import of `@vn/artgen`
  bundles today. It does not map `pathux`, which the rule modules import type-only, and no
  rule module imports a `?inline` stylesheet.
- **No zod schema describes the catalog or the sweep.** `packages/types/src/schemas.ts`
  holds the file shapes and the LLM-result shapes; `@vn/commands` uses no zod at all
  (`packages/commands/src/props.ts:2` says so), and zod appears in main only in
  `keyaudit.ts`, `showme.ts` and `updates.ts`. `zod` is a dependency of `apps/desktop`,
  and `src/shared/*` already imports runtime code. `PropValue` is
  `string | number | boolean | string[]` (`packages/commands/src/props.ts:20`),
  re-exported by `shared/ipc.ts`. The research report's "like the command catalog"
  describes a file with one schema, not a zod object that exists.
- **`HEADER` lives in the renderer.** `AnchorHome` is `EditorId | typeof HEADER` with
  `HEADER = 'header'` at `renderer/rules/anchors.ts:18`; `EDITOR_IDS` is in
  `src/shared/editors.ts:229`.
- **Two tooltips are locale-formatted.** `budgetAction` writes `spent.toLocaleString()`
  (`rules/convobar.ts:86`) and `compactAction`'s tooltip is `contextDetail`, which formats
  `convo.context` the same way (`src/shared/convo.ts:272`). Node's default locale is the
  machine's.
- **The asset editor's offers carry riders.** `regenerateAction` returns `act` and `note`,
  `taskAction` `publish`, `promoteAction` `locationId` and `variants`, `replaceAction`
  `slot`, `promptEditable` `prompt` and `title` (`rules/assetview.ts:173`, `:224`, `:269`,
  `:309`, `:360`): the narrowed shapes plan 2 kept so the editor reads them back.
  `controls()` returns the objects whole, riders included.
- **Nothing in the tree is called a situation**, so the word carries no prior meaning.
- **`anchors.json` has one reader in the app.** `renderer/rules/anchormap.ts` imports it
  for the tour's planning map (`mapOf`) and `SWEPT` for `tour.explain`; `show_me` plans
  against the registry and that map. Neither reads a derived file, and nothing in this
  plan changes what the tour trusts.
- **The desktop jest project is one project.** `@vn/desktop` matches
  `apps/desktop/**/tests/*.test.ts`, so a test under `src/main/tests/` and one under
  `renderer/rules/tests/` run in the same node-only environment. One renderer test imports
  a pure main module (`rules/branch/tests/graph.test.ts:1` reads
  `src/main/storygraph.js`); no main test imports renderer code, and this plan adds no
  cross import in either direction, since each side reads the committed JSON rather than
  the other's code.
- **`MENU_NODES` is module-private** (`doctree.ts:529`), and `menuAnchors()` records `id`,
  `editor`, `when` and `form` only; `menuFor(node)` is where the entry's `label` and
  `props` are. Three `doc.create` entries share `wikidir:sample`, so the menu records are
  a multiset.
- **`promptview.controls` takes two arguments**, `(view, editing)`
  (`rules/promptview.ts:527`); every other `controls` takes one.

## Decisions this plan settles

- **The model is committed, and it is a pure function of the sources.**
  `apps/desktop/ux-model.json` sits beside `anchors.json`. It carries no timestamp and no
  git sha, because a file that changes on every commit cannot be compared against a
  regeneration, and the comparison is the check: a jest test derives the model afresh and
  fails when the committed file differs, naming the first record that does. That answers
  the research's staleness rule ("the committed model was derived after the last change to
  `editors/**`") by construction rather than by a sha heuristic, and it answers it more
  precisely: a sha rule would fail on a DOM-only edit that cannot change the derivation,
  and pass on a rule edit made in the same commit as a regeneration that was then hand
  edited. The sha rule stays where it belongs, on `anchors.json`, which cannot be
  regenerated in CI; making it visible is plan 7's, with the rest of the measured tier.
- **A situation is a named fixture of one module's state type.** `Situation<S>` is
  `{ name: string; why: string; state: S }`. The list lives in
  `renderer/rules/situations/<module>.ts`, one file per module, each exporting
  `SITUATIONS: readonly Situation<State>[]`. Situations are per module rather than per
  home, because the asset home's two modules read two different types; a record carries
  both `module` and `editor`. The situations are hand-written, and they are the one
  hand-written input to the model, as the research says. The module tests keep their own
  fixtures; a test may import a situation where that reads better, and none is made to. A
  module whose `controls` takes two arguments (`promptview`) has a state type of its own
  for the situation, `{ view, editing }`, and its table row spreads it; the table's row
  type is
  `{ module, editor, file, controls: (state: S) => readonly Offer[], situations }`, so
  every row is called one way.
- **The situation list covers what gates a control, not every value a field can take.** A
  situation exists where a module lists a control it does not list elsewhere, refuses one
  it accepts elsewhere, refuses it with a different sentence, or offers it with different
  props. Two situations that differ only in a label are one situation, because a label is
  what the offer says and not what it does. A verdict a module would drop (an answer for a
  scene the selection has left, a door verdict on a decomposed scene, a `setKey` answer
  under the wrong scope) is not a situation: every module test already pins that such an
  answer is dropped, and a fixture carrying one would make the wording rule below report
  the drop as a lost sentence, which is the test saying the fixture is malformed. A typed
  draft is a situation exactly once, as the state in which the draft's control exists (the
  branch editor's naming row, the script strip's open line); what the draft holds is data,
  and the anchor's props going stale as the author types is the redraw question plan 2
  left open and this plan leaves open.
- **The driver is a table, in `renderer/rules/model.ts`.** `model()` returns the whole
  file. Its table maps each module to its home, its `controls`, its situations and its
  source path, in a fixed order; records are emitted in table order, then situation order,
  then `controls()` order, so the output is stable and a diff of the file reads in the
  order the app draws. The asset home's two modules are two rows. The document tree's menu
  is the seventeenth row: the driver imports `menuFor` and `MENU_NODES` (exported for it)
  from `renderer/pathux/doctree/doctree.ts`, which is pure and node-tested, and turns each
  entry into a `menu` record under the one situation `every-kind`, with the same multiset
  of `(when, id)` that `menuAnchors()` writes. `rules/` importing a file under `pathux/`
  is new: `desktop-app-shell.md` describes `rules/` as what the editors import, and no
  eslint boundary separates the two (all of `apps/desktop` is one element at
  `eslint.config.mjs:281`). It is allowed here because the file has no DOM in it and its
  transitive imports (`chrome/contextmenu.ts`, `rules/skills.ts`, `docbuffer.ts`,
  `shared/editors.ts`) touch none at load; `doctree.ts` already imports `rules/skills.ts`
  and `rules/anchors.ts`, so the path `model.ts → doctree.ts → rules/skills.ts` crosses
  and comes back without a cycle. The driver's own test proves it loads under node.
- **The record is the offer's declared fields, plus where it came from.** A control record
  is `{ via: 'control', editor, module, situation, key, offer, reasonFrom? }` with `offer`
  the `Offer` the module returned, projected to the fields `Offer` declares (`ok`, `id`,
  `props`, `label`, `tooltip`, `on?`, `supplies?`, `form?`, `refusal?`) by a `pickOffer`
  in the driver, and `key` from `keyOf`. The projection is what lets the schema stay
  `.strict()`: the asset editor's riders (`act`, `note`, `publish`, `variants`, `prompt`,
  `title`) are what the editor reads back, not what the control does, and `note` and
  `prompt` would otherwise put fixture prose into the file. `pickOffer` is typed over
  `Offer`'s keys, so a field added to `Control` is picked or fails to compile.
  `reasonFrom` is `'stack'` on a refused record whose reason is the message of a refusing
  verdict in the situation's state, and absent otherwise; the driver's verdict walk stamps
  it, and the measured half below reads it. A menu record is
  `{ via: 'menu', editor: 'documents', module: 'doctree', situation: 'every-kind', when, id, label, props?, form? }`,
  with `when` the node id as `menuAnchors` writes it. A menu entry carries no tooltip
  today, and the schema says so rather than inventing one: giving a menu item a sentence
  is plan 5's path.ux half and plan 4's vocabulary. `from` is
  `{ file: 'apps/desktop/renderer/rules/<module>.ts' }` per module, written once in the
  table; the function that produced an offer is not recorded, because `controls()` does
  not know it and every module is one file where the command id finds the function by
  search. The research's `api`, `effects` and `measured` fields are plans 7, 4 and 7, and
  the schema is written so they can be added without renaming anything here.
- **Item anchors are not in the model.** `item()` and `pickItem()` record where a subject
  is chosen and run no command; the model's vocabulary is command ids until plan 4 gives
  `ui.publish` a name. The measured comparison filters them out the way the sweep does
  (`anchor.id !== undefined`).
- **The schema lives in `src/shared/uxmodel.ts`, and `Offer` stays where it is.** The file
  is read by main's tests, by the renderer's tests and by tooling with no app, which is
  what `src/shared/` is for (`tourcheck.ts` is the precedent). It does not go to
  `@vn/types`: that package is the bottom of the layering graph and holds the pipeline's
  file shapes, and a schema for a desktop artefact that names `AnchorHome` and `PropValue`
  belongs with the desktop. `Offer` and `Control` stay in `renderer/rules/anchors.ts`,
  because the schema restates their shape in zod for the file and the driver's return type
  is what ties the two: `model()` builds each record's `offer` through `pickOffer` and is
  typed as the schema's inferred type, so a field added to `Offer` fails to compile until
  the schema names it. No `pathux` path mapping is needed for `Refusal`; the schema spells
  it out as `{ reason: string; description?: string }`, and `PropValue` as the union
  `@vn/commands` declares. `HEADER` and `AnchorHome` move to `src/shared/editors.ts`
  beside `EDITOR_IDS`, and `renderer/rules/anchors.ts` re-exports them, so the schema's
  `editor` enum is built from the one list and no string is restated.
- **Palette-only is a list with reasons, and it replaces `FLOOR`.** `rules/paletteonly.ts`
  exports `PALETTE_ONLY: readonly { match: string; why: string }[]`, where `match` is a
  command id, a namespace glob (`workspace.*`) or a name glob (`*.list`); one `*` at
  either end of the id, nothing else. The model file carries the list under `paletteOnly`,
  so a reader sees why a command has no control. The rule: every command in the live
  registry is either the `id` of some record or matched by the list, and every list entry
  matches at least one command no record names. A count cannot say which command arrived
  without a control, and it cannot notice a control that was lost while another was
  gained; the list does both, so `FLOOR` and its `has not lost ground` test are deleted
  from `anchorcoverage.test.ts` and its other three checks stay.
- **The wording rule has a headless half and a measured half, and this plan lands both.**
  Headless, in the driver's test: every refused record's `refusal.reason` is non-empty
  (the schema's `min(1)`), and every refusing verdict inside a situation's state appears
  verbatim as the `refusal.reason` of a refused record in that situation, or as the
  `tooltip` of an accepted one, which is the gate's case. The walk finds verdicts by shape
  (`{ state: 'refuse', message }`) anywhere in the fixture, because a `CommandCheck` names
  no command and each module keys its verdicts its own way; a `Refusal` (`{ reason }`, the
  grant boxes) is not a verdict and is not walked. Measured, in the sweep: the pane's
  sentence must equal the stack's only where the derived file says the pane copied it,
  that is, for an `(editor, id)` pair some record marks `reasonFrom: 'stack'`. Without
  that scoping the sweep would report every refused control whose command takes a prop,
  because the stack is asked about a blank and answers with a coercion failure, and it
  would report `agent.compact`, whose pane refusal precedes main's. A mismatch is reported
  beside the enabled-state disagreements as `wording`, advisory like them.
  `refusal.description` is never compared, on either half.
- **The derived-against-measured comparison is one-directional in this plan.** Blocking,
  in main's tests over the two committed files: every `cmd:` record in `anchors.json` has
  a derived record for the same editor and command id, with the same `form` and the same
  `supplies`. That is the drift the comparison exists to catch, a control drawn from a
  literal with no module function, and the plan-2 grep was its only check until now. The
  other direction, a derived control the sweep never drew, is expected as long as the
  sweep visits one situation and the model many, so it is reported by the sweep as a count
  per editor and not failed on, with `header` and `taskgraph` printed as `not swept`
  rather than as counts. Comparing by key would need the fixtures to reproduce the sample
  project's chunk keys and line ids, and a fixture that mirrors one project is the
  measured tier's job under plan 7, not a derived situation.
- **Which checks block.** Blocking, all in jest under `@vn/desktop`: the file parses under
  the schema; the file equals a fresh derivation; keys are unique within a situation;
  every refusing verdict surfaces verbatim; every command has a record or a reason; the
  measured file's commands are all derived. Advisory, in the sweep: `wording`
  disagreements and the derived-without-measured count. The split is the existing one:
  what needs no app blocks, what needs one is run by hand.
- **The model has no reader in the app yet.** The tour keeps planning against
  `anchors.json`, which is a measurement; a situation in the derived file is a fixture,
  not a recipe for reaching that state in a project, and giving `show_me` a situation to
  route by needs the recipe plan 7 pairs with the name. The file's readers in this plan
  are the tests, a person, and an agent with a file to read; the generated markdown
  projection the research suggests is a follow-up.

## What changes

Six stages, one green commit each, on a branch `derived-model`. Every stage leaves
`pnpm check`, `pnpm test` and `pnpm lint` green.

### Stage 1 — the schema, and the situation type

- `apps/desktop/src/shared/uxmodel.ts`: zod for the file. `UX_MODEL` is
  `{ situations: Situation[]; records: Record[]; paletteOnly: PaletteOnly[] }`, with
  `Situation = { module, editor, name, why }`, `Record` a discriminated union on `via`
  (`control` with `key` and `offer`; `menu` with `when`, `id`, `label`, `props?`,
  `form?`), `offer` a discriminated union on `ok` with `refusal.reason` at `min(1)`, and
  every object `.strict()` so a field the schema does not name is a parse error rather
  than silent cargo. Exported types `UxModel`, `UxRecord`, `UxOffer`. `PropValue` is
  spelled out as the union `@vn/commands` declares, and `editor` as an enum over
  `EDITOR_IDS` plus `HEADER`, which this stage moves to `src/shared/editors.ts`.
- `apps/desktop/renderer/rules/situations/situation.ts`: `Situation<S>` and a
  `situations<S>(...list)` helper that rejects a duplicate name at construction, so a
  copy-pasted fixture fails the first test rather than shadowing a record.
- A test in `src/shared/tests/uxmodel.test.ts` that a hand-written record on each branch
  parses and that a record with an empty reason, or an unknown field, does not.

### Stage 2 — the situations

One file per module under `renderer/rules/situations/`, each a list of literals of the
module's state type. The names below are the plan; the implementing stage writes the
fixtures from each module's state type and its test's helpers, and adds or drops a
situation where the module's `controls` turns out to gate on something this list does not.
A situation is dropped only when it differs from another in labels alone, and the reason
is recorded in the As-shipped section.

| Module        | Situations                                                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headerbar`   | `idle`, `preview` (not live: `mock: true`), `running` (`BUSY_RUN`), `reporting` (`BUSY_REPORT`), `agent-turn` (`BUSY_AGENT`: run and stop both refused)                                                                                                                     |
| `convobar`    | `empty`, `after-a-turn` (feed, context, spend), `mid-turn` (busy), `reading` (a thread open, resumable), `reading-unresumable` (one of `resumeRefusal`'s four), `no-effort-knob`                                                                                            |
| `assetview`   | `nothing`, `plate` (a base, accepted: `asset.unapprove`), `plate-unaccepted`, `portrait-unapproved`, `concept` (promotable, redrawable), `failed`, `superseded` (`newerTake`: `asset.restore`), `stale` (Regenerate becomes `pipeline.run`), `upload` (`kind: 'reference'`) |
| `promptview`  | `chunks`, `custom`, `frozen`, `editing-a-clause` (`editing` names one chunk), `with-refs`                                                                                                                                                                                   |
| `branch`      | `no-scene`, `scene` (delete accepted), `entry-scene` (delete refused), `naming`                                                                                                                                                                                             |
| `documents`   | `idle`, `renaming`                                                                                                                                                                                                                                                          |
| `gengraph`    | `nothing-selected`, `nodes-selected`, `group-selected`, `no-level` (nodes selected, no `target`: `NO_LEVEL`)                                                                                                                                                                |
| `onboarding`  | `blank`, `typed` (setKey accepted), `mock` (testKey refused), `no-links` (a vendor with an empty url)                                                                                                                                                                       |
| `projectbar`  | `clean`, `dirty`                                                                                                                                                                                                                                                            |
| `reportconvo` | `setup`, `mock` (open refused), `open`                                                                                                                                                                                                                                      |
| `script`      | `no-scene`, `scene`, `editing-a-line`, `pending-merge`, `pending-split`, `pending-scene`                                                                                                                                                                                    |
| `skills`      | `none-open`, `open`, `open-dirty`                                                                                                                                                                                                                                           |
| `taskGraph`   | `no-gate`, `gate-unasked`, `gate-with-candidates` (refused check, candidates on file), `gate-without-candidates`                                                                                                                                                            |
| `tasklist`    | `idle`, `gate-pending`                                                                                                                                                                                                                                                      |
| `timeline`    | `no-scene`, `decomposed`, `undecomposed-unasked`, `undecomposed-asked`                                                                                                                                                                                                      |
| `wiki`        | `none-open`, `open`, `open-dirty`                                                                                                                                                                                                                                           |
| `doctree`     | `every-kind` (the driver's own, over `MENU_NODES`; no file)                                                                                                                                                                                                                 |

Each `why` is one sentence saying what the situation gates:
`The entry scene cannot be deleted, so the delete button is refused with the stack's sentence.`
The `no-effort-knob` situation names a model `effortChoicesFor` in `@vn/types` answers
with an empty list for (`packages/types/src/textmodels.ts:67`: Haiku, Sonnet 4.5, Gemini),
so `effortAction` refuses; a model with no `none` keeps the knob live and is not a
situation. The `mock` situations carry the mock refusal the shared module main uses. The
rows dropped from the first draft, each differing from a listed row in labels alone:
`headerbar/no-model`, `branch/unknown-scene` (the module drops the verdict, so it is
`no-scene` with a scene id), `projectbar/closed`, `reportconvo/changing`. Every `convobar`
fixture keeps `context` and `spent` below 1000, so no tooltip goes through
`toLocaleString`'s grouping and the file is the same on every machine. Each situation file
gets one test: every situation's state is accepted by `controls` without throwing, and the
file's names are distinct (the helper already guarantees the second; the test is what runs
the first).

### Stage 3 — the driver

- `renderer/rules/paletteonly.ts`: the list. Its first contents are computed from the
  first derivation, grouped by namespace where the reason is one sentence for the group:
  the shell and the launcher (`workspace.*`, `window.*`, `app.*` beyond the key links),
  the palette's own (`view.*` beyond `view.open` and `view.applyLayout`, `tour.*`), reads
  (`*.list`, `*.info`, `*.status`, `*.state`, `command.check`, `interaction.*`,
  `asset.suspended`, `bible.search`), the popup and the pane closures plan 4 names
  (`notify.*`, the `gengraph.*` node operations, the script editor's structural `story.*`
  by id), the dialogs (`upload.*`), and the agent's (`agent.editLine`, `agent.threads`,
  `agent.renameThread`, `agent.clear`, `report.*` beyond `open`, `stop` and `grant`).
  `asset.replace` is not listed: `replaceAction` offers it on any non-portrait slot.
  `story.mergeScene`, `story.splitScene` and `story.newScene` are not listed either, since
  `pendingAction` offers each. An id that fits no group gets its own line; the first
  derivation is expected to need one for `plugin.*`, `gate.candidates`,
  `pipeline.approveAndRun`, `doc.read`, `prompt.moveChunk`, `prompt.repin` and the branch
  editor's drag-driven `story.setChoice`, `story.removeChoice`, `story.spliceScene`,
  `story.moveShot` and `story.deleteShot`.
- `renderer/rules/model.ts`: the table, `pickOffer`, the verdict walk that stamps
  `reasonFrom`, and `model(): UxModel`. `keyOf` gives control keys; the doctree row runs
  `menuFor` over the exported `MENU_NODES` into `menu` records. The return value is built
  as the schema's inferred type, so the compiler ties `Offer` to the schema.
- `renderer/rules/tests/model.test.ts`: `model()` parses under `UX_MODEL`; no two records
  in one situation share a key (`duplicateKeys`); every refusing verdict in a situation's
  state surfaces verbatim, as a reason or as the gate's tooltip; every module in the table
  appears in the output; the doctree row's `(when, id)` multiset equals `menuAnchors()`'s.

### Stage 4 — the file, and the two rules over it

- `scripts/gen-ux-model.mjs`:
  `loadEntry('apps/desktop/renderer/rules/model-entry.ts', 'model')`, written to
  `apps/desktop/ux-model.json` and run through prettier the way the sweep runs it.
  `model-entry.ts` is a one-line re-export kept separate so the bundle names nothing but
  the driver. Root `package.json` gains `gen:uxmodel`.
- `apps/desktop/ux-model.json`, committed.
- `renderer/rules/tests/model.test.ts` gains the comparison: the committed file, parsed,
  equals `model()`, with a failure message naming the first record that differs and saying
  to run `pnpm gen:uxmodel`.
- `src/main/tests/uxmodel.test.ts`: reads the JSON and the live registry. Every registry
  command is the `id` of some record or matches `paletteOnly`; every `paletteOnly` entry
  matches at least one command no record names; a command both anchored and listed fails
  naming it. `FLOOR` and its test leave `anchorcoverage.test.ts`; its header comment is
  rewritten for what remains.

### Stage 5 — the measured half

- `src/main/tests/uxmodel.test.ts` gains the one-directional comparison: every record in
  `anchors.json` with an `id` and a `key` has a derived control record with the same
  `editor` and `id`, and the same `form` and `supplies` where present. The menu records
  (no key) are compared to the derived `menu` records as a multiset of `(when, id)`, which
  must be equal since both come from `menuFor` over the same nodes.
- `scripts/sweep-anchors.mjs`: the `wording` disagreement. The script reads
  `ux-model.json` and collects the `(editor, id)` pairs some record marks
  `reasonFrom: 'stack'`. For an anchor in that set where `verdict.state` is `refuse` and
  the anchor is disabled, `anchor.reason` must equal `verdict.message`; otherwise push
  `{ editor, key, pane: 'refuses it — <reason>', stack: 'refuses it — <message>', wording: true }`.
  And the derived-without-measured count: for each swept editor the script prints how many
  derived command ids the sweep did not draw, as information under the existing per-editor
  lines, and `not swept` for `header` and `taskgraph`.
- The sweep is re-run, because the script changed, and the file is committed with what
  moved recorded in the As-shipped section. The expectation is no `wording` disagreement
  and no change to any record. Of the twenty refused records, the entry scene's delete is
  the one whose reason came from a verdict and whose command the sweep can ask about with
  its props, so it is the one the new check compares; the Save key boxes are
  verdict-worded too but the stack, asked with no key, answers about the blank. The rest
  (the mock refusals, the blank boxes, the nothing-open pair, `No changes`, the two Gen
  Graph selections, `agent.compact`, the clause resets and the chunks-mode `prompt.clear`)
  are the rule's own sentences and are not compared.

### Stage 6 — the docs

- `docs/reference/guided-tours.md`: a Part III, "The derived model", after the tour: the
  file and where it lives, the schema, what a situation is and where the list lives, the
  driver's table, the record, the two rules and the comparison, and the regenerate step.
  The Enforcement section under Part I lists the new blocking tests and the `wording`
  line. The Files table gains `rules/model.ts`, `rules/situations/`,
  `rules/paletteonly.ts`, `shared/uxmodel.ts`, `ux-model.json`, `gen-ux-model.mjs`.
- `CLAUDE.md`: the Commands table gains `pnpm gen:uxmodel`; the desktop paragraph that
  names `anchors.json` and the sweep names `ux-model.json` and says that touching
  `renderer/rules/**` or a situation means regenerating it, which the test enforces.
- `docs/reference/desktop-app-shell.md`, where it lists `rules/`: one line for
  `situations/` and `model.ts`.
- The tasklist: row 3 ticked with the date and the link; "What the numbers are today"
  restated from the derived file (situations, records, anchored ids, palette-only
  entries); the row for the staleness rule in "Where the eleven lint rules land" says the
  file is compared against a regeneration and carries no sha, with a pointer here; and the
  opening paragraph, which still says only plan 1 is written, is brought up to date. The
  research record's `situation` value (`portrait:unapproved`) becomes `module` plus
  `situation` here, which the Part III section says.
- `docs/plans/index.md` flips the row to shipped and the file moves to `archive/`.

## Testing

- **Stage 1**: `uxmodel.test.ts` under `src/shared/tests/`.
- **Stage 2**: one test per situation file, and every existing module test still green.
- **Stage 3**: `model.test.ts`'s five assertions. The verdict walk is exercised on purpose
  by `branch/entry-scene`, `timeline/undecomposed-asked`, `onboarding/blank` (whose
  refusal is the rule's own, and must not be demanded of a verdict),
  `taskGraph/gate-with-candidates` (tooltip, not reason), `reportconvo/mock`, and
  `timeline/decomposed`, whose fixture carries no verdict because the module would drop
  one.
- **Stage 4**: `pnpm gen:uxmodel` twice produces identical bytes; editing one situation's
  `why` and not regenerating fails `model.test.ts` naming the record; adding a command to
  the registry with no control and no list entry fails `uxmodel.test.ts` naming it;
  listing an anchored command fails naming it.
- **Stage 5**: the comparison passes on the committed pair; deleting one derived record by
  hand from the JSON (a temporary edit, reverted) fails naming the swept key. The sweep
  re-run over CDP against `examples/mySampleRepo` reports 0 `wording` disagreements and
  prints the per-editor derived-without-measured counts.
- **Throughout**: `pnpm check` (both passes), `pnpm test`, `pnpm lint`, and
  `pnpm exec commentlint` on every touched file. `pnpm check:doclinks` after stage 6.

## Risks

- **Bundling `rules/model.ts` for node pulls in something with a DOM in it.** The driver's
  imports are the rule modules, `doctree.ts` and its two pure imports, and `shared/*`;
  `rules/gengraph.ts` reaches `@vn/gengraph` and through it `pathux-graph`, which
  `aliases.mjs` maps to vendor source and the catalog generator already bundles through
  main. If a module's transitive import touches `document` at load, the fix is the one
  plan 2 used for `compact` and `NO_LEVEL`: move the pure piece into `rules/`, and record
  it. `model.test.ts` under jest catches it before the script does.
- **`model()` under jest and under esbuild disagree.** Both transpile the same sources,
  and the output has no timestamp, sha, path or `Map` iteration in it, so the bytes are a
  function of the table. The one machine-dependent input found is the locale behind
  `toLocaleString` in two convo tooltips, which the fixtures avoid by staying below 1000;
  a later fixture that crosses it shows up as a file that regenerates differently on CI,
  and the fix is the same constraint. Any other disagreement is a bug in the driver (an
  unsorted set, an `Object.keys` over a fixture the two runtimes built differently) and
  the equality test is what finds it.
- **The palette-only list rots in the permissive direction.** A glob such as `story.*`
  would hide a new `story.*` command that should have a control. The list uses a glob only
  where every command in the namespace is palette-only for one reason, and the script
  editor's structural `story.*` commands are listed by id, not by glob, so a new one is
  reported.
- **A situation that lists a control the app never draws.** The plan does not block on the
  derived-without-measured direction. The sweep's per-editor count shows the gap, and plan
  7 closes the gap.
- **Two `Offer`s in one situation share a key.** The module tests already assert
  `duplicateKeys` finds none over their own fixtures; a richer situation can find one they
  did not (plan 2 recorded that a reference pin on two clauses collides on
  `cmd:view.open#<pin>`). The driver's test fails naming the key, and the fix is a
  discriminator in the module, which is a one-line change plan 2's rule already covers.
- **Undoing the plan** deletes the situation files and their tests, `uxmodel.ts`,
  `situation.ts`, `paletteonly.ts`, `model.ts`, `model-entry.ts`, `gen-ux-model.mjs`, the
  two new tests and the JSON, restores `FLOOR`, moves `HEADER` back, reverts the sweep's
  two additions and the `package.json` line, and reverts four doc edits. Nothing in the
  app's runtime imports the model, so the app is unchanged either way.

## Follow-ups deliberately not in scope

- **A recipe per situation for the measured tier** (project, selection, what to open), so
  the sweep can visit the situation list and the comparison can run in both directions
  (plan 7).
- **`show_me` reading the derived file** to say which situation a step needs, which waits
  on the recipe.
- **A generated markdown projection** of the model, on the `command-table.md` pattern,
  with a `check:` in `pnpm lint`.
- **Function-level provenance** on a record (the research's `from.rule`), which needs
  either every module function to name itself or the sweep build's stack capture.
- **Turning a hide into a refusal, or a stale draft snapshot into a re-record** (carried
  from plan 2).
- **The sha staleness rule for `anchors.json`** against the last `editors/**` commit (plan
  7).
- **A tooltip on a menu entry** (plans 4 and 5).

## Findings

From the fresh-context review, before any work started. Each is fixed in the text above or
answered here.

1.  **`.strict()` on `offer` rejected the asset editor's riders** (`act`, `note`,
    `publish`, `variants`, `prompt`, `title`), and "verbatim" would have put fixture prose
    into the file. Fixed: the driver projects each offer to `Offer`'s declared fields
    through `pickOffer`, and the schema stays strict.
2.  **`asset.restore` is swept and no planned situation offered it**, so the stage 5
    comparison would have failed on the committed pair. Fixed: `superseded`, `stale`,
    `plate-unaccepted` and `upload` join the `assetview` list.
3.  **The `wording` check would have reported disagreements on a sweep the plan called
    clean**, because a refused offer carries no props and the stack answers about the
    blank with a coercion failure, and because `agent.compact`'s pane refusal is not
    main's. Fixed: the derived file stamps `reasonFrom: 'stack'` where a reason came from
    a verdict, and the sweep compares wording only for those `(editor, id)` pairs.
4.  **Twenty refused records, not sixteen.** Fixed, and the four (`agent.compact`, the two
    Gen Graph buttons, `project.setArtStyle`) are named as rule-worded.
5.  **`asset.replace` and the script's `story.splitScene` were listed palette-only while a
    module offers them.** Fixed: both are struck from the list, and `pending-split` and
    `pending-scene` are situations.
6.  **The collapse rule contradicted six rows of the table and missed two states.** Fixed:
    the rule is now key set, `ok` column, reason or props, with labels alone not counting;
    `no-model`, `unknown-scene`, `closed` and `changing` are dropped; `no-level` is
    defined as nodes selected with no target; `agent-turn` and `reading-unresumable` are
    added.
7.  **`no-effort-knob` was misdescribed.** Fixed: `effortChoicesFor` returning an empty
    list, not a model without `none`.
8.  **"No test imports across `src/main` and `renderer/`" was false.** Fixed: one renderer
    test reads a pure main module, and the claim is now that this plan adds no cross
    import.
9.  **The header and the task graph are never swept**, and the count would have read as
    total drift. Fixed: stated in Context, and the sweep prints `not swept` for both.
10. **`MENU_NODES` is not exported, and `menuAnchors` carries no label or props.** Fixed:
    exported for the driver, which runs `menuFor` over it.
11. **Two tooltips are locale-formatted.** Fixed: `convobar` fixtures stay below 1000, and
    the risk is recorded with its symptom.
12. **`@vn/commands` uses no zod, and `PropValue` is not a zod union.** Fixed in Context
    and stage 1.
13. **`HEADER` lives in the renderer, where `src/shared/uxmodel.ts` cannot reach it.**
    Fixed: `HEADER` and `AnchorHome` move to `src/shared/editors.ts`, re-exported from
    `rules/anchors.ts`.
14. **Verdict-walk edge cases**: the grant boxes hold a `Refusal`, not a `CommandCheck`;
    the branch and timeline modules drop verdicts on `known` and on decomposition rather
    than on a key. Fixed: the walk covers `CommandCheck` shapes only, the situation rule
    names the dropped forms, and `timeline/decomposed` carries no verdict.
15. **`promptview.controls` takes two arguments.** Fixed: its situation state is
    `{ view, editing }` and the row spreads it.
16. **The layering crossing was asserted, not argued.** Fixed: the doc's direction, the
    absence of a boundary rule, and the non-cyclic path are stated.
17. **The alias-map claim was imprecise.** Fixed: three packages resolve through the
    workspace link, not the map.
18. **Smaller**: `FLOOR` is at `:17`; the undo cost is restated in full; the glob grammar
    is defined and the ids needing their own line are listed; the menu comparison is a
    multiset; the tasklist's opening paragraph is on stage 6's list; the deviation from
    the research record's `situation` value is noted.

# The ten inline editors get a rule module

Status: **shipped** 2026-09-08; see [As shipped](#as-shipped). Plan 2 of
[`ux-behaviour-model-tasklist.md`](../ux-behaviour-model-tasklist.md); depends on plan 1
([`archive/one-offer-and-the-six-rule-modules.md`](one-offer-and-the-six-rule-modules.md),
shipped 2026-09-07), and plan 3 depends on it. Pressure-tested on 2026-09-07; the findings
and what was done with each are in [Findings](#findings).

## Context

Plan 1 made `Offer` carry everything an anchor records and gave the six rule modules a
`controls(state)` list. What it left in place is where most offers are still built: inside
the editors, beside the DOM code, from inputs that are not state. A headless reader has no
function to call for those editors, and plan 3's derived model cannot start until every
anchor home answers `controls(state)`. Measured from the tree on 2026-09-07, after plan 1:

- **Ten editors build every offer inline.** `onboarding.ts` (three sites, each once per
  vendor), `documents.ts` (two), `branch.ts` (three), `graph.ts` (one, once per pending
  character), `nodes.ts` (two, through a shared `offerOf`), `skills.ts` and `wiki.ts` (one
  each, both `DocBuffer.saveOffer`), `script.ts` (three, one of them once per line),
  `tasks.ts` (one) and `timeline.ts` (two, one of them a door drawn twice). Nineteen
  sites.
- **The five module-served editors still build thirteen offers inline**, and six more
  sites take a module offer and add `on`, `label` or `tooltip` to it before recording,
  which means the module's `controls()` does not list what the editor draws: the header's
  View button (two offers on one node) and model menu; the convo bar's model and threads
  menus; the report pane's Start and Stop; the asset editor's Download, Fix with agent,
  reference thumbnails, origin-open buttons, the per-rung notes and seed boxes, and the
  six augmented sites (`asset.ts:803`, `:1085`, `:1131`, `:1276`, `:1387`, `:1417`).
- **The inputs are not state.** Seven offers read a widget (`box.value`, `scope.value`,
  three `placeholder`s used as labels, `cta.textContent`); six are built inside a
  `command:check` callback whose verdict lives nowhere but the closure (`onboarding.ts`
  twice, `branch.ts`, `graph.ts`, `timeline.ts` twice); `nodes.ts` weighs a gesture
  against the live `Graph` and `NodeGraphView`; `branch.ts` and `script.ts` snapshot props
  from a draft object the strip's inputs then mutate in place. None of these can be handed
  to a fixture.
- **One of them was a regression.** `onboarding.ts`'s `describe()` re-records the Save key
  box into the page pass on every keystroke, and since plan 1 a second offer on a
  presented node with a different `ok` is refused by `present()` rather than applied, so
  typing a key never enabled the button. Fixed on `master` ahead of this plan by giving
  the box a pass of its own; plan 1's As-shipped section records it. The rule it exposes
  is written under Decisions.
- **Four command-backed controls are not anchors at all.** The task list's gate
  `RESOLVE →` (`tasks.ts:303`, opens `gate.approve`), the skills hint's
  `Ask the agent for a skill…` (`skills.ts:133`, opens `agent.run`), and the convo bar's
  effort and budget menus (`convo.ts:256`, `:277`, `agent.setEffort` / `agent.setBudget`)
  run registered commands through their own listeners, with hand-written tooltips and, for
  the effort menu, a hand-written refusal. The budget menu's tooltip is rewritten on every
  spend tick by `sayBudget` (`convo.ts:339`).
- **Three refusals are written outside the `Offer` shape.** `tasks.ts:254` (Clear
  finished), `nodes.ts:558` (Asset) and `asset.ts:632` (the `⋯` menu) grey a control by
  hand. None runs a command, so they are plan 4's, and they are listed here so nobody
  looks for them.
- **One key collides.** The timeline records `cmd:story.newShot` twice: from the bar with
  `{ scene }` and from the undecomposed-scene door with `{ scene, lines }`, in separate
  passes. `duplicateKeys` over one `controls()` list would report it.
- **`Offer` is renderer-only.** Nothing under `src/main/` or `src/shared/` imports
  `renderer/rules/anchors.ts` or names the type. The tasklist's question of whether the
  pair moves to `src/shared/` has its answer: nothing needs it there.

The research report
([`../research/formalizing-the-rules-modules.md#the-ten-inline-editors-get-a-module`](../../research/formalizing-the-rules-modules.md#the-ten-inline-editors-get-a-module))
describes the shape as "the same mechanical work that produced the six existing modules".
The inventory says otherwise for about a third of the sites, which is why this plan spends
its decisions on what the state of an editor is.

## Decisions this plan settles

- **Every anchor home has a rule module, and the module is where its offers are built.**
  For an editor whose rules already have a module the offers join it: `rules/script.ts`,
  `rules/skills.ts`, `rules/tasklist.ts`, `rules/gengraph.ts` (the Gen Graph pane,
  `nodes.ts`) and `rules/taskGraph.ts` (the task graph, `graph.ts`). For the two editors
  whose rules are a directory the offers are one more file in it:
  `rules/branch/controls.ts` and `rules/timeline/controls.ts`. The three with no module
  get one: `rules/onboarding.ts`, `rules/documents.ts`, `rules/wiki.ts`.
  `DocBuffer.saveOffer` moves to `rules/docbuffer.ts`, which `wiki` and `skills` both
  call. No barrel and no registry: plan 3's driver is a table from `AnchorHome` to the
  module's `controls`, and it is plan 3's to write, because the state types are
  heterogeneous and only the driver needs the table. A rules module runs under the
  node-only desktop jest project, which maps no `pathux` module, so it imports from
  `pathux` type-only, as `rules/anchors.ts` does.
- **A module's state is plain data the editor assembles at draw time.** The state type is
  declared in the module, built from shared view types (`src/shared/*.ts`) plus whatever
  the editor holds that the offer needs, converted to data: a `Map` becomes a record, a
  `Set` a list, a widget's current value a string. Three kinds of input get a rule each:
    - **A `command:check` verdict is state.** The editor fetches it, stores it on a field
      keyed by everything it asked about, and passes it in. The module never calls `check`
      and never reads a promise. What a missing verdict means is today's behaviour at each
      site, and the signature says which: the door, the delete button, the Save key box
      and the Test key button are anchored only once answered, so their functions take the
      verdict as a required argument and `controls` lists them only when it is in; the
      report's Start and the task graph's gate are recorded `ok` before any answer, so
      their functions take `check?: CommandCheck` and `controls` lists them regardless. A
      verdict field is keyed as finely as the question: `project.setKey` is asked per
      vendor and scope, so its key is `${vendor}/${scope}`; a door is asked per scene, so
      its key carries the scene id. An answer whose key no longer matches the state on
      screen is dropped, the way `report.ts`'s `checkedKey` already does it, and the field
      is cleared at the top of the rebuild that re-asks. A rebuild may draw a control from
      a stored verdict and re-record it when the fresh one lands; passes replace, so that
      is safe.
    - **A widget's value is state, and a widget's text comes from the offer.** `box.value`
      and `scope.value` reach `onboarding`'s module as `typed` and `scope`. The three
      placeholders the asset editor uses as labels, and the gate button's `textContent`,
      are inverted: the module writes `label`, and the editor sets the placeholder or the
      text from it. Nothing on screen changes.
    - **A gesture's verdict is state.** `nodes.ts` keeps `weigh(edit)` and `target()`,
      which read the live graph, and passes their answers in: the module takes a
      `GenEditFor` and an `EditTarget | undefined` and does the ordering and `commandFor`.
      The pure half is the refusal order and the command; the impure half is the two calls
      that need the graph.
- **A control re-presented between passes gets `applyOffer` or a pass of its own.**
  `present()` accepts a second offer on a node only when it presents the same way, and
  never re-applies it. So a control whose offer changes without a rebuild is one of two
  things: re-presented in place through `applyOffer` with the module's offer, as
  `sayCompact` does and `sayBudget` will; or recorded into a pass named for it, replaced
  whole each time, as `branches/delete`, the timeline's `door:` passes and now the
  onboarding's `save:<vendor>` pass are. A `record()` beside a hand-written `description`
  is neither, and is the copy CLAUDE.md's tooltip rule says gets overwritten.
- **The editors keep calling the module functions; `controls()` is the enumeration.** The
  research proposed that an editor draw by looking each control up by key in the list.
  That is not done, for three reasons: the narrowed shapes (`PromoteAction.variants`,
  `RegenerateAction.act`, `TaskAction.publish`, `ChunkAct.opens`) are lost through a key
  lookup and the editor needs them; a lookup miss is a runtime throw on a code path only
  CDP reaches; and the guarantee it buys, that the app draws what the list says, is the
  one plan 3 gets by measurement, comparing `controls(fixture)` against the sweep. The per
  module test from plan 1 stays the tie: the key set of `controls(state)` equals the union
  of what the functions produce. What that test cannot catch is a literal left behind in
  an editor with no function at all; until plan 3's comparison, the grep at the end of
  each stage is the only check for that.
- **Hidden stays hidden and greyed stays greyed.** An editor that does not draw a control
  in some state (`+ scene` while the naming row is open, `delete <scene>` for an unknown
  scene, Resume with no reopened thread, the origin-open button on a chunk whose origin
  scrolls) leaves it out of the list in that state, and a control it greys is refused. No
  hide becomes a refusal and no refusal a hide: the sweep's `enabled` and `refused`
  columns must not move, and turning a hide into a refusal is a design change for another
  plan. Being absent from the list is a fact about the anchor, not the screen: the
  timeline's doors are drawn greyed with their own sentence before the verdict, and
  anchored only after it, and that stays.
- **Item anchors stay in the editors.** `item()` and `pickItem()` record where a subject
  is chosen and carry no offer, so they are not this plan's. Plan 3 decides whether the
  derived model lists them.
- **One command, one sentence.** `agent.setModel` is offered by the header and the convo
  bar with different tooltips; `headerbar.modelAction` becomes the one function, with the
  header's sentence (`header.ts:441`), and `convobar` imports it, the way `modeAction` is
  already shared. The same rule applies to any pair found on the way.
- **The four command-backed buttons and menus become anchors; the closures and the
  interaction-built controls do not.** `RESOLVE →`, the skills hint, and the effort and
  budget menus get offers in their modules, with the tooltips they have today. Refresh,
  Fit, Tidy, Clear finished, the mode toggle, collapse, `← Overview`, the Gen Graph pane's
  Delete/Duplicate/Add…/Asset, the asset editor's `⋯` menu and the script editor's
  structural buttons run closures or renderer-local navigation, and they are plan 4's
  pseudo-commands. Controls that exist only inside an interaction and run a command on
  change or Enter (the script editor's cue picker, `story.setSpeaker`; the timeline's
  wardrobe rows and `story.deleteShot` entry; the branch editor's edge-label input; the
  asset editor's redraw title input) are left as they are: anchoring each is the
  `record()`-in-its-own-pass pattern the documents rename box already uses, and it is
  listed under follow-ups rather than done here, so this plan moves what exists and adds
  only the four plain buttons and menus. The notification popup is out too: it has no
  `AnchorHome`, its list re-renders itself outside any editor pass, and giving it a home
  is a decision plan 4 takes with the rest of the popup's controls.
- **The timeline's door gets `on: 'undecomposed'`.** Two records of `cmd:story.newShot` in
  one home is a key collision the anchor layer only tolerates because the two live in
  different passes. The door is the one that names lines, so it is the one that carries
  the discriminator. This is the one existing key this plan changes. `mapOf` folds by id,
  so no tour notices.
- **Two modules may serve one home.** The asset editor keeps `assetview` (the bytes) and
  `promptview` (the prompt), each with its own `controls`, and plan 3's driver
  concatenates per home. `promptview.controls` gains a second argument for what the editor
  holds and `PromptView` does not: which chunks have a box open and how.
- **A draft object's props are snapshotted, as today.** The branch naming row and the
  script strip record props from a draft the inputs then mutate, so the anchor's props go
  stale as the author types. The module makes this visible (the draft is an input) and
  does not fix it; re-recording on input is a redraw question and is left for plan 3's
  situation list to decide whether a typed draft is a situation at all.
- **`Offer` stays in `renderer/rules/anchors.ts`.** Nothing in main or shared needs it. If
  plan 3 wants the schema in `@vn/types`, that is the move that would justify a path
  mapping for `Refusal`, and it is plan 3's to make.

## What changes

Each stage is one commit, green under `pnpm check`, `pnpm test` and `pnpm lint`. Within a
stage each editor follows the same steps: the module gains its functions and `controls`;
the module test gains one `describe` per function and the `controls` block; the editor
builds the state, calls the functions, and loses the literal. The stage ends with a grep
of the editor for `refuse(` and for `props:` beside an `id:`, which finds nothing; the one
`{ ok: true }` that is not an offer, `judge()` in `nodes.ts:670`, is an `EditVerdict` and
is the known exception.

Between stage 1 and stage 6 `anchors.json` is stale against the tree. That is fine:
`anchorcoverage.test.ts` compares the file's command list to the registry and nothing
else, so the tree stays green, and the sweep is run once, at the end.

### Stage 1 — the five small ones

- **`rules/docbuffer.ts`** — `saveOffer(path: string, dirty: boolean): Offer`, refusing in
  order: `path === ''` → `No document is open.`; `!dirty` → `Nothing to save`.
  `DocBuffer.saveOffer` becomes a one-line getter over it, and `DocBuffer.save()` reads
  the offer instead of re-testing the two conditions itself, so the sentence exists once:
  its `no changes` note becomes the offer's `Nothing to save`, and `docbuffer.test.ts:174`
  changes with it.
- **`rules/wiki.ts`** (new) — `WikiState { path: string; dirty: boolean }`;
  `controls(state)` is `[saveOffer(path, dirty)]`.
- **`rules/skills.ts`** — `SkillsState { path; dirty }`; `askSkillAction(): Offer`, the
  hint's `agent.run` door: `form: true`, `props: { input: NEW_SKILL_PROMPT }` (already a
  constant in this module), label and tooltip as the hint has them today.
  `controls(state)` is `[saveOffer, askSkillAction()]`. The hint is built once at
  construction and never redrawn, so it gets a `skills/hint` pass created where it is
  built, and the button is drawn through `act()` with `openCommandDialog` as its run.
- **`rules/documents.ts`** (new) — `createAction(): Offer` (`doc.create`,
  `supplies: ['kind', 'name']`); `renameAction(target: { path; name }): Offer`
  (`doc.rename`, `props: { path }`, `supplies: ['name']`, label `target.name`).
  `DocumentsState { renaming?: { path; name } }`; the editor holds the node id and turns
  it into the target through `renameOf` before building the state. The rename box keeps
  its own pass, since it is drawn from an interaction rather than a rebuild; only the
  literal moves.
- **`rules/tasklist.ts`** — `runAction(): Offer` (`pipeline.run`, `form: true`);
  `gateAction(character: string): Offer` (`gate.approve`, `form: true`,
  `props: { characterId }`, `on: character`, label `RESOLVE →`, tooltip the sentence at
  `tasks.ts:305`). `TaskListState { gatePending: string[] }`; `controls` is the run button
  plus one gate action per pending character. The gate bar's button is drawn through
  `act()`; its run closure still sets `ui.characterId` and calls `announce()` before
  `openCommandDialog`, and its `title` line goes.

### Stage 2 — the two with doors

- **`rules/timeline/controls.ts`** (new) — `addShotAction(sceneId: string): Offer`
  (`story.newShot`, `form: true`; refused `No scene is on screen.` when empty);
  `doorAction(door: Door, check: CommandCheck): Offer` where `Door extends Control` with
  `props`, and the two doors are built from the scene: `decomposeDoor(sceneId)`
  (`story.decomposeAll`, `{}`) and `byHandDoor(sceneId, firstLine)` (`story.newShot`,
  `{ scene, lines }`, `on: 'undecomposed'`). Refused when `check.state === 'refuse'`, with
  `check.message`.
  `TimelineState { sceneId: string; undecomposed?: { sceneId; firstLine }; verdicts: Record<string, CommandCheck> }`,
  keyed `${sceneId}/${keyOf(door)}`. `controls` is the add button, then each door whose
  verdict is in. The editor stores the verdicts on a field, clears it at the top of
  `rebuildSurface`, which is where the doors are re-asked, and keeps the two `door:`
  passes; a door is still drawn greyed with its sentence before its answer, and
  `lockSurface` still swaps every title during a write.
- **`rules/branch/controls.ts`** (new) — `newSceneAction(): Offer` (`story.newScene`,
  `supplies: ['scene', 'heading']`); `deleteSceneAction(scene, check): Offer`, refused
  with `check.message` and the tooltip `removes(scene)`; accepted with the tooltip
  `noticeForCheck(check)?.text || removes(scene)` (`removes` moves here);
  `writeSceneAction(naming: NewScene): Offer` (the `Write it` record, spreading
  `asInvocation(newSceneIntent(naming))`).
  `BranchState { sceneId; known: boolean; naming: NewScene | null; deleteVerdict?: { scene: string; check: CommandCheck } }`.
  `controls`: the add button when `naming` is null; the delete action when `known` and the
  verdict is in for this scene; the write action when naming. The delete verdict is stored
  on the editor, dropped when its scene is not the one on screen, and the
  `branches/delete` pass stays.

### Stage 3 — the two whose verdicts are the state

- **`rules/onboarding.ts`** (new) —
  `linkAction(vendor: KeyGuideVendor, field: GuideUrlField): Offer` (`app.openKeyLink`,
  `on: \`${vendor}/${field}\``; refused when the guide names no page, with the field's sentence as the tooltip; accepted with `\`${sentence} — ${url}\``); `saveKeyAction(vendor,
  typed: string, scope: KeyScope, check: CommandCheck): Offer` (`project.setKey`, `on:
  vendor`, `supplies: ['key']`, props without the key), refusing in order: `check.state
  === 'refuse'`→`check.message`; `typed.trim() === ''`→`Paste a key
  first`; tooltip `check.message`when accepted, else`Write this
  key`; `testKeyAction(vendor, check: CommandCheck)` (`project.testKey`, `on:
  vendor`). `OnboardingState { vendors: KeyGuideVendor[]; typed: Record<vendor, string>;
  scopes: Record<vendor, KeyScope>; verdicts: { setKey: Record<string, CommandCheck>;
  testKey: Record<vendor, CommandCheck> }
  }`, `setKey`keyed`${vendor}/${scope}`. `controls`is, per vendor, the three links, then the save box and the test button when their verdicts are in. The editor keeps`describe()`running on input; it builds the state from`box.value`and`scope.value`, stores each verdict as it lands under the key it asked with, and records the box into its `save:<vendor>`
  pass.
- **`rules/taskGraph.ts`** —
  `gateApproveAction(character, check: CommandCheck | undefined, candidates: number | undefined): Offer`
  (`gate.approve`, `on: character`, `supplies: ['hash']`, `form: true`, label
  `\`${character}
  →\``), with today's predicate kept exactly: refused only when the check refuses and there are no candidates (an undefined count is none); an undefined check is accepted; a refusing check with candidates on file stays `ok`and its sentence becomes the tooltip, because the form is where the portrait is named.`GateState
  { pending: string[]; gates: Record<character, { check?: CommandCheck; candidates?:
  number }>
  }`, the editor passing the candidate list's length; `controls`lists a gate action for every pending character. The run closure keeps setting`ui.characterId`and calling`announce()`. The `taskgraph/body`
  pass, which is created and never recorded into, is deleted.

### Stage 4 — the two big ones

- **`rules/script.ts`** — `headingAction(shown: { sceneId; heading }): Offer`
  (`story.setHeading`, `form: true`, label the heading);
  `lineTextAction(line: { id; text }): Offer` (`story.setLineText`, `on: line.id`,
  `supplies: ['text']`, label the text);
  `pendingAction(pending: Pending, sceneId): Offer`, wrapping `checkOf` with the label and
  tooltip ternaries from `script.ts:785`.
  `ScriptState { shown?: { sceneId; heading; lines: { id; text }[] }; editingLine: string | null; pending: Pending | null; sceneId }`;
  `controls` is the heading, one line action per line other than `editingLine`, and the
  pending action when there is one and a scene. The second step of a `scene` act
  (`story.setNext`) is still not anchored; the strip runs both and records the first, as
  today.
- **`rules/gengraph.ts`** —
  `groupAction(selected: GraphId[], weighed: GenEditFor | undefined, target: EditTarget | undefined): Offer`
  refusing in order: no selection → `Select the nodes to group first.`; `weighed` not ok →
  its reason; no target → `NO_LEVEL`; else
  `{ ok: true, ...commandFor(target, weighed.edit), ...control }`.
  `ungroupAction(groups: string[], weighed, target)` the same way with
  `Select a group instance to ungroup.`.
  `GroupState { selected; groups; weighed: { group?; ungroup? }; target? }`; `controls` is
  the two. `nodes.ts` keeps `weigh` and `target` and builds the state; `offerOf`,
  `groupOffer` and `ungroupOffer` go. `GROUP_WHAT` and `UNGROUP_WHAT` move to the module.
  The signature cache that skips `paintGroupButtons` stays. `gengraph.ts` exports a
  `keyOf` of its own, so its test imports the anchor one under an alias.

### Stage 5 — the five module-served editors

- **`rules/headerbar.ts`** — `viewActions(): [Offer, Offer]` (`view.open` with
  `supplies: ['editor']`, `view.applyLayout` with `['name']`, one label and tooltip for
  both, since they present on one node); `modelAction(model: string): Offer`
  (`agent.setModel`, `supplies: ['modelId']`, label `model || 'model…'`). `HeaderState`
  gains `model`; `controls` gains the three.
- **`rules/convobar.ts`** — imports `modelAction`; `threadsAction(): Offer`
  (`agent.openThread`, `supplies: ['id']`);
  `effortAction(model: string, effort: EffortChoice): Offer` (`agent.setEffort`,
  `supplies: ['effort']`, label `\`effort: ${effortLabel(effort)}\``, refused `\`${model
  || 'this model'} has no reasoning-effort
  setting.\``when`effortChoicesFor(model)`is empty, which the module derives itself from`@vn/types`); `budgetAction(budget:
  BudgetChoice, spent: number): Offer` (`agent.setBudget`, `supplies:
  ['budget']`, the label and the three-part tooltip `sayBudget`composes today).`ConvoBarState`gains`effort`, `budget`and`spent`; `controls`gains the four. The two menus are recorded with`record()`, the way the model menu is. `sayBudget`sets the menu's`name`from`offer.label`and re-presents through`applyOffer(menu,
  budgetAction(...), composeTooltip)`, as `sayCompact` does; the pass's own record of the
  menu stays as it was at paint, which is accepted, since the key and the enabled state do
  not move with the spend.
- **`rules/reportconvo.ts`** — `stopAction(): Offer` (`report.stop`; `STOP_TIP` moves
  here); `startAction(state: ReportConvo, changing: boolean, check?: CommandCheck): Offer`
  (`report.open`, label `Read This One →` when changing else `Start →`), refusing in
  order: `check?.state === 'refuse'` → `check.message`; `state.convo.busy` →
  `The debug agent is still on the last turn.`; tooltip the accepted verdict's message or
  the sentence at `report.ts:306`; accepted with no verdict, as today. `controls` takes
  `{ state, changing, check?, boxes }`, and its existing test changes shape with it.
- **`rules/assetview.ts`** — `exportAction(info?): Offer` (`asset.export`, refused
  `No picture on screen to save`); `fixAction(info): Offer` (`agent.fixAsset`);
  `failureTaskAction(info, failure): Offer` (the `view.open` on the failed task,
  `on: failure.task`, label `Show task`, the two-way tooltip);
  `notesAction(rung: ArtRungInfo): Offer` and `seedAction(rung, configSeed?): Offer`
  (`art.setNotes` / `art.setSeed`, `on: rung.target`, `supplies`, label the placeholder
  text the editor computes today); `promoteBox(info)` (`art.promote`, `on: 'variant'`,
  label the placeholder) beside `promoteAction`; `redrawBox(info)` (`art.redraw`,
  `on: 'prompt'`) and `redrawGo(info)` (`on: 'go'`) beside `promptEditable`.
  `controls(info)` gains them all, the per-rung ones once per rung.
- **`rules/promptview.ts`** —
  `chunkBoxAction(view, chunk, how: 'replace' | 'append'): Offer` (the `prompt.setChunk`
  box, `on: \`${chunk.key}/box\``); `customBoxAction(view): Offer` (`on:
  'box'`); `refOpenAction(chip: RefChip): Offer` (`view.open`on the thumbnail,`on:
  chip.pin`); `originOpenAction(chunk): Offer |
  undefined` (`view.open`when`originAction(chunk.origin).kind === 'open'`, `on:
  chunk.key`). `controls(view, editing: Readonly<Record<string, 'replace' | 'append'>> =
  {})`gains them; the editor passes its`editing`map as a record. The six augmenting sites in`asset.ts`
  pass the module offer through unchanged.

### Stage 6 — the sweep, and the docs

- `node scripts/sweep-anchors.mjs` is re-run against the same fixture as the last sweep
  and `anchors.json` committed. Expected to move: `sweptAt` and `gitSha`; two new `convo`
  records, `cmd:agent.setEffort` and `cmd:agent.setBudget`, which also enter `anchored`
  (the coverage count rises by two); one new `skills` record, `cmd:agent.run` with
  `form: true` and the skill prompt as its `input` prop, a long string that lands in the
  file as written. `agent.run` and `gate.approve` are already in `anchored` through the
  document tree's menu records, so they do not change the count. Not expected to show,
  because the fixture does not reach them: the door's `#undecomposed` key, since the swept
  scene is decomposed; the task list's `gate.approve#<character>`, since nothing is
  pending at the gate; the asset editor's rung, promote and redraw twins beyond what the
  swept asset already draws. Those keys are pinned by the `controls` tests instead. Any
  other change in a key, `enabled` or `refused` is a finding, and the disagreement count
  stays at zero.
- [`../reference/guided-tours.md`](../../reference/guided-tours.md): the Offers section's
  list of modules becomes every home's module, in a table from `AnchorHome` to module and
  state type, which is also the table plan 3's driver is written from.
- [`ux-behaviour-model-tasklist.md`](../ux-behaviour-model-tasklist.md): row 2's checkbox;
  the line in "What the numbers are today" saying ten editors compute offers inline.
- [`index.md`](../index.md): the row flips to shipped and the file moves to `archive/`.
- An "As shipped" section in this file records every deviation.

## Testing

- **One test file per new module** (`rules/tests/docbuffer.test.ts`, `wiki.test.ts`,
  `documents.test.ts`, `onboarding.test.ts`, `rules/branch/tests/controls.test.ts`,
  `rules/timeline/tests/controls.test.ts`) and new `describe`s in the existing `skills`,
  `tasklist`, `script`, `gengraph`, `taskGraph`, `headerbar`, `convobar`, `reportconvo`,
  `assetview` and `promptview` tests, in plan 1's conventions: an ok offer with `toEqual`
  naming `id`, `props`, `label`, `tooltip` and `supplies`; a refused one with
  `toMatchObject({ ok: false, id, refusal: { reason } })`.
- **Refusal order is pinned.** Every function with two or more refusals gets one test
  whose state satisfies all of them and asserts the first: `saveOffer('', false)`,
  `saveKeyAction` with a refusing check and nothing typed, `startAction` with a refusing
  check and a busy convo, `groupAction` with a selection, a refused weighing and no
  target.
- **The gate predicate is pinned** with the state that is easy to get wrong: a refusing
  check and one candidate is `ok`, with the refusal's sentence as the tooltip.
- **The `controls` block** per module: the key set equals the union of the functions' keys
  over two or three states, and `duplicateKeys` is empty. For `timeline` the two-door
  state is one of them, which is what pins the `#undecomposed` key. The five existing
  `controls` tests whose state type grows (`headerbar`, `convobar`, `reportconvo`,
  `assetview`, `promptview`) change with it.
- **A `controls` state with nothing in it** (no scene, no verdicts, no vendors, nothing
  shown) returns the list the editor draws then, which for most modules is short or empty.
- **`pnpm check`, `pnpm test`, `pnpm lint`** green at every stage.
- **Live, over CDP** — the sweep in stage 6, and by eye: the four newly anchored controls
  show their old tooltips and, for the effort menu on a model with no knob, the old
  refusal; the placeholders and the gate button's text are unchanged; typing into a Save
  key box enables the button and clearing it greys it again; the budget menu's tooltip
  still moves with the spend.

## Risks

- **A refusal reordered on the way through.** The order is written into each function's
  spec above and each multi-refusal function has an order test. The sweep's `refused`
  column is the second check, since a swapped order changes the sentence on file.
- **A verdict stored on the editor outlives what it was about.** Today a verdict is
  consumed and gone; a field can go stale when the scene, the scope or the vendor changes
  under it. The Decisions rule keys each field by everything the question named, drops an
  answer whose key no longer matches, and clears the field where the question is re-asked.
- **A refusal composed twice.** A refused offer whose tooltip is the refusal's own
  sentence shows it twice through `composeTooltip`, which is plan 1's finding 7 again.
  Every refused branch above names a tooltip that is the control's own sentence, never the
  message.
- **A literal left behind.** The key-union test cannot see an editor literal that has no
  module function. The end-of-stage grep is the check until plan 3 compares the derived
  keys with the sweep's.
- **The four newly anchored controls and the door's key change `anchors.json`.** Expected
  and listed in stage 6; a change anywhere else is a finding. Nothing holds
  `cmd:story.newShot` for the door by hand: a grep across `apps/desktop` and `docs/` finds
  the editor and the sweep's output only.
- **Undo.** Every stage is an additive extraction that reverts on its own, and nothing
  outside the renderer changes until stage 6's sweep and docs, so there is no point of no
  return.

## Follow-ups deliberately not in scope

- **The closures** listed under Decisions, the notification popup, and the Gen Graph
  pane's Asset button (plan 4).
- **The interaction-built controls that run a command**: the script editor's cue picker
  (`script.ts:615`), the timeline's wardrobe rows and `story.deleteShot` entry
  (`timeline.ts:667`, `:754`), the branch editor's edge-label input (`branch.ts:781`) and
  the asset editor's redraw title input (`asset.ts:1402`). Each is the rename box's
  pattern; a plan that anchors them anchors all four together.
- **The driver, the fixtures per situation, and the table from home to module** (plan 3).
  This plan writes the table into `guided-tours.md` as prose; plan 3 writes it as code.
- **Turning a hide into a refusal**, or a stale draft snapshot into a re-record.
- **Item anchors in the derived model** (plan 3).
- **Moving `Offer` to `src/shared/`** or the schema to `@vn/types` (plan 3, if at all).

## Findings

From the fresh-context review on 2026-09-07. Each is fixed in the text above or answered
here.

1. **The onboarding Save key box re-records into the page pass on every keystroke, and
   `present()` refuses the second offer**, so since plan 1 the button never enabled.
   **Fixed, in the tree first.** The box has its own `save:<vendor>` pass on `master`
   ahead of this plan, plan 1's As-shipped section records the regression, and the rule
   ("`applyOffer` or a pass of its own") is now a Decision with a live check in Testing.
2. **"Absent until answered" was stated as one rule but the sites differ**: Start and the
   gate are recorded `ok` with no verdict, the door, delete, save and test are not
   recorded at all. **Fixed.** The Decision spells out both, and every signature says
   whether the verdict is required.
3. **Verdict keys were too coarse** (`setKey` depends on the scope; the doors are re-asked
   per rebuild, not per load), and `keyOf(door)` did not type-check against a `Door` with
   `does`. **Fixed.** Keys carry the scope and the scene, an answer for another key is
   dropped, the field is cleared where the question is re-asked, and
   `Door extends Control`.
4. **The delete tooltip formula composed the refusal twice**, and the link action's two
   tooltips were not spelled. **Fixed.** Both branches are written for both, and the
   double composition is a named risk.
5. **The effort and budget menus could not be built from the signatures**: no `effort` for
   the label, no `spent` for the tooltip, and `sayBudget` rewrites the description after
   the record. **Fixed.** `effortAction(model, effort)` derives `offered` itself,
   `budgetAction(budget, spent)` carries today's text, and `sayBudget` re-presents through
   `applyOffer`.
6. **The stage 6 diff was wrong three ways**: `agent.run` and `gate.approve` are already
   in `anchored` through the menu records; the door is absent because the swept scene is
   decomposed, not because of `SETTLE_MS`; the task list has no gate pending. **Fixed.**
   Stage 6 names exactly what the fixture will and will not show.
7. **`NEW_SKILL_PROMPT` already lives in `rules/skills.ts`, and the hint is built once at
   construction, not in a page pass.** **Fixed.** A `skills/hint` pass where the hint is
   built.
8. **Nineteen sites, not eighteen**, and five command-backed controls the plan neither
   moved nor excluded (the cue picker, the wardrobe rows and delete-shot entry, the
   edge-label input, the redraw title input). **Fixed.** The count is corrected and the
   five are a Decision and a follow-up.
9. **`DocBuffer.save()` says `no changes` where `saveOffer` says `Nothing to save`, and a
   test asserts the former.** **Fixed.** The offer's sentence survives and the test
   changes.
10. **Five `controls` tests change shape, not one**, and `gengraph.ts` exports its own
    `keyOf`. **Fixed.** Testing lists the five; stage 4 names the alias.
11. **The two gate runs have side effects before the dialog opens.** **Fixed.** Both run
    closures keep them.
12. **The timeline's doors are greyed before the verdict, not hidden, and `lockSurface`
    rewrites their titles.** **Fixed.** Stated under Decisions and stage 2.
13. **The completion grep had a false positive** at `nodes.ts:670`. **Fixed.** The grep is
    for `refuse(` and `props:` beside `id:`, and the exception is named.
14. **Four state fields did not match the tree** (`renaming` is a node id, `candidates` is
    an array, `editing` is a two-variant object, the `⋯` menu is a third hand-greyed
    control) and the shared `setModel` sentence was not chosen. **Fixed.**
15. **Assumptions verified by the review**: every named type and helper exists with the
    shape used; the import directions are legal under the boundaries and cycle rules; a
    rules module must import `pathux` type-only under jest. **Answered.** The type-only
    rule is now stated under Decisions.
16. **Reversing the key lookup is sound**, with one gap: a literal with no function
    escapes the key-union test until plan 3. **Answered.** Named under Decisions and
    Risks.
17. **No point of no return, and `anchors.json` is stale between stages.** **Answered.**
    Both are stated at the top of "What changes" and under Risks.

## As shipped

Shipped 2026-09-08 on `rule-modules`, one commit per stage. `pnpm check`, `pnpm test` and
`pnpm lint` are green at every commit. The end-of-stage grep of each editor for `refuse(`
and for `props:` beside an `id:` finds only invocations (`command:check` calls, `exec`
calls and menu entries) and `judge()`'s `EditVerdict`.

### Deviations

- **`decomposeDoor()` takes no scene.** `story.decomposeAll` has no scene prop, so the
  door is the same for every scene; the scene enters only through
  `doorKey(sceneId, door)`, which is exported so the editor and `controls` key the verdict
  the same way.
- **`ungroupAction` takes `GraphId[]`**, not `string[]`: a node's id is a `GraphId`, and
  that is what `selectedGroups()` yields.
- **The script page's state is `ScriptPageState`.** `rules/script.ts` already imports
  `ScriptState` from `@vn/scriptedit` for `moveStateOf`.
- **`NO_LEVEL` moved to `rules/gengraph.ts`** with `GROUP_WHAT` and `UNGROUP_WHAT`, since
  the module's refusal needs the sentence; `nodes.ts` imports it back for `weigh`. An
  unweighed edit (`weighed` undefined with something selected) is refused with `NO_LEVEL`,
  which is what `weigh` answers when the level no longer resolves.
- **`compact` moved from `chatsurface.ts` to `rules/convobar.ts`**, since the budget label
  is built from it and a rules module cannot import a DOM module.
- **`saveKeyAction` and `testKeyAction` take the vendor id**, not the `KeyGuideVendor`;
  `setKeyKey(vendor, scope)` is exported for the verdict key. `linkAction` takes the whole
  vendor, since it reads the url.
- **Two stale answers are now dropped** where the plan's rule said they should be and
  today's code let them through: the onboarding `describe()` drops a `project.setKey`
  answer once the scope box has moved on, and the branch editor's `askDelete` drops an
  answer for a scene the selection has left, rather than replacing the live button's pass
  with a detached node.
- **The task graph's gate buttons are anchored twice**: once at draw, from the unanswered
  offer (`gateApproveAction(character, undefined, undefined)`), in a `taskgraph/gate` pass
  created with the buttons, and again from the answers in a fresh pass that replaces it.
  The click is live before the round trip, as it was when it went through
  `addEventListener`, and `act()` is what wires it. The `stopPropagation` listener stays,
  because the canvas would otherwise read the click as a pick.
- **`DocBuffer.save()` stays silent with no file open**, as before; it speaks the offer's
  refusal (`Nothing to save`) only over an open file.
- **`failureTaskAction` returns an `Offer`** with `taskAction`'s `publish` riding along
  untyped; the editor passes `failure.task` to `showTask` directly rather than reading it
  back out of the offer.
- **`promoteStrip` and `promptStrip` take `info` as a first parameter**, so the field
  offers are built from the same `AssetInfo` as the strip's.
- **`reportconvo.controls` takes a `ReportControls`**
  (`{ state, changing, check?, boxes }`) and lists Stop as well as Start and the two
  boxes.
- **The wiki and skills editors keep reading `DocBuffer.saveOffer`**, which is now a
  getter over `rules/docbuffer.ts`'s `saveOffer`, rather than calling `controls()` and
  indexing the list; `noUncheckedIndexedAccess` would make the index a possible
  `undefined`.
- **A reference pin attached to two clauses would collide** on `cmd:view.open#<pin>`, as
  it did before `refOpenAction` existed. The sample project has no such prompt; plan 3's
  comparison is where it would show.

### Looked at over CDP

Against `examples/mySampleRepo` in mock mode, after the sweep:

- The four newly anchored controls carry their old sentences: the skills hint's button
  (`Open the agent form with a request for a new skill…`), the effort and budget menus
  (`How hard the model thinks…`; the three-part budget sentence, label `budget 200k`), and
  the task list's gate bar, which the fixture does not draw and whose sentence is pinned
  by `gateAction`'s test.
- Typing into a Save key box enables the button and its title drops to the accepted
  sentence; clearing it greys the button again with `Paste a key first` above it. The
  three links carry the guide's urls; Test key is greyed with the mock refusal.
- The branch editor's `delete arrival` is greyed with `deleteScene`'s own refusal (the
  entry scene) above its own sentence; `+ scene`, the script heading, `+ shot`, Group and
  Ungroup (greyed with their selection refusals), the report's Start (greyed with the mock
  refusal) and the asset editor's seed boxes (`seed` placeholder) are unchanged.
- **Not reproduced live**: the effort menu's refusal on a model with no thinking knob,
  because `agent.setModel` under mock left the model as it was; and the budget tooltip
  moving with the spend, because a mock turn spends nothing. Both are pinned by
  `convobar.test.ts`, and `sayBudget`'s `applyOffer` path is the one `sayCompact` uses.

### The sweep

Re-run against `examples/mySampleRepo` (The Transfer Student) at `e56cab3f`. Zero
disagreements, as before. What moved beyond `sweptAt` and `gitSha`, exactly as stage 6
expected:

- Two new `convo` records, `cmd:agent.setEffort` (`supplies: ['effort']`) and
  `cmd:agent.setBudget` (`supplies: ['budget']`); both enter `anchored`, 49 to 51.
- One new `skills` record, `cmd:agent.run` with `form: true`; `agent.run` was already in
  `anchored` through the document tree's menu.
- No key, `enabled` or `refused` column of any existing record changed. The door's
  `#undecomposed` key, the task list's `gate.approve#<character>` and the asset editor's
  strip fields beyond the swept asset's rungs do not appear, since the fixture does not
  reach them; their keys are pinned by the `controls` tests.
- The one stray on file since the last sweep, a task row in the task list, is no longer
  reported. As plan 1 recorded for its own sweep, a stray is a hit test in the window the
  sweep ran in, and nothing here moved that row.

# Pipeline contracts, families and the narrative seam

Describes how the pipeline's invariants are declared in code (`contract({...})`), how the
generated index is built and queried, and the seams the derivation code was extracted
along: the constraint solver, the stills family, the narrative structure and the executor
registry. The rules themselves are not restated here. Each one is a contract in
[`../../packages/contracts/contracts.json`](../../packages/contracts/contracts.json),
which `pnpm contracts <query>` reads.

The work that built all of this is summarised in
[`../plans/archive/INDEX.md#contracts-into-code-and-workflows`](../plans/archive/INDEX.md#contracts-into-code-and-workflows),
and the research behind it is in
[`../research/pipeline-contracts-into-code.md`](../research/pipeline-contracts-into-code.md)
and
[`../research/workflows-and-narrative-engines.md`](../research/workflows-and-narrative-engines.md).
Package responsibilities and import rules are in [`packages.md`](packages.md).

<!-- toc -->

- [Declaring a contract](#declaring-a-contract)
- [Ids and the lint rules behind them](#ids-and-the-lint-rules-behind-them)
- [The index](#the-index)
- [Querying contracts](#querying-contracts)
- [Workflows, families and styles](#workflows-families-and-styles)
- [The constraint solver](#the-constraint-solver)
- [The stills family](#the-stills-family)
- [The narrative seam](#the-narrative-seam)
- [Where facts are built](#where-facts-are-built)
- [The executor registry and task kinds](#the-executor-registry-and-task-kinds)
- [Guards that must not be loosened](#guards-that-must-not-be-loosened)
- [Decisions that still bind](#decisions-that-still-bind)
- [Known gaps](#known-gaps)

<!-- tocstop -->

## Declaring a contract

A contract is an exported `const` beside the code that enforces it, so that a model (or a
person) can ask which contracts apply to the file, command or tool in front of them.

- `id` is `<area>.<name>`, for example `gate.perUnit`.
- `rule` says what holds and `prevents` says what breaks without it. Each is a plain
  string literal of at most 280 characters, so a contract is one checkable statement.
  Anything longer goes in the optional `detail`, which a query returns only when asked.
- `subjects` names what the contract is attached to. The prefixes are a closed set:
    - `slot:` (a slot address prefix: `plate`, `portrait`, `sheet`, `shot`) and `task:` (a
      task kind);
    - `command:` (a command id) and `tool:` (an agent tool name, kept apart because agent
      tools are not commands);
    - `package:`, `module:` (a repo-relative path) and `function:` (a repo-relative path
      and an export, `packages/stills/src/gate.ts#gates`);
    - `file:` (a project-relative path such as `state/tasks.jsonl`). Repo files and
      project files are different trees, so they keep different prefixes.
- `see` lists the pages and archived plans that carry the history. A plan reference uses
  `docs/plans/archive/INDEX.md#<slug>` once the plan is archived.
- A command definition and a `SlotKind` may also carry a `contracts` array. The generator
  adds `command:<id>` or `slot:<prefix>` to each of those contracts' subjects.
- The enforcing code's doc comment says what the code does and does not restate the
  contract. The declaration names that code in a `module:` or `function:` subject, so a
  query can find the contract from the code.
- A contract about family vocabulary (plates, sheets, shots, scenes) is declared in the
  family, never in the solver. The solver's own declarations name none of those words,
  even in their text, and name the solver code with `function:` subjects from the family's
  declaration.
- A tool that an agent's registry does not list cannot be a `tool:` subject, because the
  generator checks `tool:` subjects against the registries. Name its function instead and
  say so in the `detail` (as `prompts.pagePanels` does for `set_bubbles`'s tool).

Where declarations live: each package's and app's `src/contracts.ts` exports one array,
`CONTRACTS`, and no barrel re-exports it. The desktop's session code declares in
`apps/desktop/src/main/contracts.ts`.

## Ids and the lint rules behind them

- `ContractArea` is a closed union in `@vn/contracts`: `identity`, `storage`, `log`,
  `gate`, `takes`, `collect`, `planning`, `graphs`, `script`, `prompts`, `execution`,
  `providers`. An area is a topic rather than a package, so an id survives its code
  moving. `contract()` types its id as `` `${ContractArea}.${string}` ``, so an unknown
  area does not compile.
- `vn/contract-decl` (lintrix) requires the id to be a string literal, the declaration to
  be an exported `const`, and the const's name to be the id with the dot removed and the
  next letter capitalised (`gate.perUnit` is `gatePerUnit`). It also refuses a `contract(`
  call outside `packages/*/src/` and `apps/*/src/`, and in a test file, and enforces the
  length caps.
- `vn/contract-pins` requires `pins(gatePerUnit)` to take an imported identifier with no
  alias. A test pins a contract by wrapping its block in `describe(pins(gatePerUnit), …)`,
  which titles it `contract gate.perUnit`. `tsgo` refuses a pin of a contract that does
  not exist, and an editor rename updates every pin.
- Ids are unique per repo, not per package. The generator refuses a duplicate.

## The index

- `pnpm gen:contracts` (`scripts/gen-contracts.mjs`) imports every `contracts.ts` by path
  through `scripts/contracts/entry.ts`, plus the desktop's command catalog, both agents'
  tool registries and the stills family's slot kinds.
- It checks every subject: the module or export exists, the command is registered, the
  tool exists, the slot prefix is declared by a slot kind and the task kind is declared.
  The desktop-only agent tools (`show_me`, `ux_*`, history) and `submit_report` are not
  checked.
- It writes `packages/contracts/contracts.json` (summaries and a `bySubject` map, about 50
  KB) and one `packages/contracts/contracts/<area>.json` shard per area (the full
  records). The files are committed and are generated, so edit the declaration and
  regenerate. The generator warns when the summary file passes 100 KB.
- `bySubject` matches exactly or by prefix, so `module:packages/stills/` lists everything
  attached to that package.
- Each record carries `declared`, the file whose const declares it. A `module:` query also
  matches the `function:` subjects in that file.
- Tests in `scripts/contracts/tests/` fail when a committed file differs from a
  regeneration, when the joined shards differ from the unsplit index, when a `contract(`
  call is missing from its `contracts.ts`, and when a declared contract has no `pins(...)`
  test.
- Every host reads the committed JSON, never the declarations, so `vnauthor` (which may
  not import the pipeline) sees the same index as the desktop.
- `@vn/contracts` imports nothing. Its main entry carries `contract`, `pins` and the types
  and no JSON, so the renderer can declare a contract without bundling the index. The
  index and its query functions are the `@vn/contracts/query` subpath. That subpath loads
  every shard, because text search reads `prevents` and `detail`.

## Querying contracts

- `pnpm contracts <query>` prints one summary line per match, and `--full` prints the
  whole record. A query is `module:<path>`, `command:<id>`, `tool:<name>`, a contract id
  or free text.
- A query returns summaries by default (id, `rule`, subjects, about 300 bytes each). The
  agent tools return at most 20 contracts per call and say how many they left out.
- The debug agent and the authoring agent each have a read-only `query_contracts` tool.
  The debug agent offers it whenever the analyst runs a tool loop; the single no-tools
  call it makes when no source or request access is granted stays as it was. The authoring
  agent's copy is deferred (not in `ALWAYS_LOADED`) so the cached tool catalog does not
  change, and it lets the agent look up the rule behind a refusal by `tool:<name>`.
- Nothing in a refusal message cites a contract id yet; adding an optional `contract`
  field to a refusal is possible later. There is no `contracts.query` palette or CDP
  command.

## Workflows, families and styles

- A family is a body of shared production code: slot kinds, prompt composition, the
  decomposer, sheet planning. The stills family is everything that produces still images
  bound to lines, and lives in `@vn/stills`.
- A workflow is what a project selects through `workflow:` in `project.yaml`. It names a
  family and adds its own exporters and publishing. `WORKFLOWS` in `@vn/types` is `['vn']`
  today, and an unknown name is refused by `loadConfig` with the key and the known names.
  `familyOf(workflow)` in `@vn/pipeline` maps each workflow to its family and is typed
  over every `Workflow`, so a workflow with no family does not compile. A later `manga`
  workflow is expected to share the stills family.
- Styles overlap across workflows. A VN can use colour manga pages, so a manga workflow
  does not own the manga style and the VN workflow does not exclude it. The style
  selectors are unchanged: `shot_form` (a project setting, overridable per scene when it
  is decomposed) and the free-text `art_style`.
- Not built, and not owned by these seams: retiring the legacy non-graph runners, a manga
  workflow with chapter publishing, a storyboard workflow, a storylet adapter and a
  time-based family (which would open `AssetKind` for clips).

## The constraint solver

`@vn/constraint-solver` runs the derivation rules once, over whatever slot kinds a family
declares, and knows nothing about visual novels. It imports only `types`, `util`,
`taskgraph` and `contracts`.

- A family supplies `SlotKind`s and a `Family`. A kind says how its slot is addressed
  (`prefix`, `key`, `parse`, `label`), what it refs, what it resolves to (`resolve`
  answers the task inputs or the sentence saying why there are none), `approved`,
  `clears`, `candidates`, `deps`, `drift`, `fromInputs`, and the `retired` task kinds that
  may still fill it. A family supplies `enumerate`, `owed`, `gates`, `kept`, `slotOf` and
  `drawnFrom`.
- `solve(family, facts)` answers a `Solution`: every `SlotState` (identity, `blocked`
  reason, status, take (`pick`), `candidates`, `approved`, `ready`, `suspended`, `drift`,
  `deps`), the dependents index, an upstream-first order, the unit gates (`units`) and any
  project-level refusal.
- `ready` means the slot has an identity and its unit's gate is open. Having an identity
  already implies its upstream slots are done. Identity is not readiness: a slot behind a
  closed gate still has a hash the planner does not plan.
- The gate is per unit, not an edge between slots. A unit (a scene, for stills) is not
  decomposed, and none of its slots is ready, until every slot the family lists as gating
  it has cleared. Stills lists the portrait of every member of `scene.characters`,
  including characters no shot shows. A gating address the family does not enumerate holds
  the unit, which is how a cast member with no sheet holds a scene.
- `clears` is a second approval test beside `approved`. The two differ deliberately for a
  portrait in four cases (an accepted row that is not current, no manifest, a character
  lock, two current rows); merging them would change what the document tree and the gate
  pane show. `gate.perUnit`'s `detail` lists them.
- Take, suspension, the keep set, the base-root refusal and graph drift are solver rules:
  `pick`, `overHeld`, `suspensions`, `keepSet`, `baseRefusal` / `projectRefusal` and
  `boundDrift`.
    - Suspension and over-held repair walk manifest rows, not slot refs, because a row's
      history is the take it was drawn from, which its upstream slot may no longer hold,
      and the repair has to reach slots no enumeration lists.
    - `keepSet` is not a field of `Solution`. It resolves slots `enumerate` does not list,
      which the planner would pay for every wave and never read.
- The solver never sees path.ux. It receives an optional `BoundGraphFact` per slot, which
  `graphFacts` in `@vn/pipeline` builds (not `@vn/gengraph`, which has no allow-list entry
  for the solver).
- Retry eligibility is not a solver rule. `requeueAbandoned` releases every `running`
  record, including superseded ones that belong to no slot, so retry stays in the
  executor.
- The kinds memoise each slot's plan on the facts object. Facts are therefore a snapshot,
  and a builder that changes the model or the task log between solves must build new
  facts.
- No manifest is not an empty manifest. `SolverFacts.assets` and `StillsFacts.assets` are
  optional: without one, approval reads each sheet's mirror, and no slot holds a row.
  Passing `[]` makes every portrait unapproved.
- The toy family in `packages/constraint-solver/src/tests/solve.test.ts` is the proof that
  the solver names nothing a family defines. It borrows `portrait` and `location_ref` as
  task kinds, because kind augmentation applies to the whole program.

## The stills family

`@vn/stills` holds the family: slot addresses, the four slot kinds (`stillsFamily`),
identity (`planSlot`, `resolveSlot`), reference binding, prompt composition, layout,
sheets, the storyboard decomposer, the gate (`gateStatus`) and drift (`driftOf`,
`proseHash`).

- `@vn/artgen` keeps the halves that touch the project: adoption, concept art, uploads,
  art notes, `repairCurrent`, asset collection and the asset half of `validateProject`. It
  does not re-export `@vn/stills`.
- The CLI and the scheduler may import neither the solver nor `@vn/stills`.
  `@vn/pipeline`'s barrel re-exports `baseRefusal`, `suspensions`, `Suspension`,
  `unapprovedTakes` and `UnapprovedTake` by name, and they reach the family through
  `familyOf(config.workflow)`.
- `@vn/export` imports neither. Its host computes the unapproved list with
  `unapprovedTakes` and passes it to `unapprovedSentence`.
- The renderer reaches the family through `@vn/stills/slotaddr` and `@vn/stills/layout`,
  because the barrel reaches `node:fs` through `@vn/taskgraph`. A subpath is one file
  (`packages/stills/src/<name>.ts`), which is why `vn/element-types` accepts a single file
  as an element.
- A staging-sheet member's identity includes the sheet key. `resolveSlot` and the planner
  both get it from `sheetKeys`, and `sheetSeeds` takes its arguments from its host's one
  facts builder. A reader that omits the key reports the wrong identity for every member,
  which corrupts `repairCurrent`, the collector's orphan pass and adoption.
- A reader that wants prose drift for every scene (the document tree's Stale branch,
  `driftedFrames`, Shot Coverage) calls `driftOf` directly. `SlotState.drift` covers live
  scenes only and reports `drifted` alone.
- `graphDrift` stays behind `vngen status`'s `drifted` list. It reports the edited arm
  only, over every output node, while `boundDrift` also reports a slot drawn before its
  graph existed. Moving `vngen status` or `vngen cost` onto `boundDrift` changes what they
  print and needs its own decision.
- `unapprovedTakes` keeps its own walk, because the playable carries every scene and the
  solver enumerates live ones.

## The narrative seam

`NarrativeStructure` is in `packages/types/src/script/narrative.ts`, so the solver's
callers can reach it without `@vn/model`. `ProjectModel.narrative` is required, and the
builder fills `model.reachable` and `model.entry` from it.

- Members: `engine` (`branching` or `linear`, a closed union like `TaskKind`), `entry`,
  `scenes()` (every scene, the live ones first in reading order), `live(id)`, `exits(id)`
  (the adjacency the playable, `toMermaid` and the screenplay export read) and
  `diagnostics()`.
- Engines are `branchingNarrative` (`packages/model/src/branching.ts`) and
  `linearNarrative` (`linear.ts`). `narrative:` in `project.yaml` selects one and defaults
  to `branching`. `linear` plays an explicit `scenes:` list and never file order. Its
  diagnostics are listed in
  [`../guides/cli.md`](../guides/cli.md#how-the-scenes-make-a-story).
- Stills reads `narrative.live`, not `model.reachable`. `liveScenes(model)` in `used.ts`
  returns live scenes in model order; a reader that wants reading order calls
  `narrative.scenes()`.
- `readProduction` still fills an entry for every scene that has a file, live or not. So
  enumeration filters by `live` and the collector does not.
- The structure closes over the scenes map it was built from, so a copy of a model that
  replaces `scenes` keeps the old answer. A hand-built test model takes
  `liveOnly(live, rest)` from `@vn/testkit`.
- Under `linear` the Branches editor still draws and edits markers (which `linear` reports
  as errors), deleting or renaming a scene does not edit `scenes:` (the stale name is
  reported as `unknown_listed_scene`), and the desktop has no control for either key.
- `@vn/types` keeps script apart from production: `src/script/` may never import
  `src/production/`. `ProjectModel` holds the storyboards apart from the scenes in its
  `production` map. See [`packages.md`](packages.md).

## Where facts are built

One facts builder per host, so two readers in one host cannot assemble different facts.

- `@vn/pipeline`: `waveFacts` (the planner, every wave, from the in-memory `TaskGraph`;
  the scheduled runner; the CLI through `@vn/pipeline` only). It takes optional `base` and
  `angleOf`.
- The desktop's main process: `sessionFacts` (document tree, gate pane, Task Graph pane,
  takes, `gengraph.run`, sheet scaffold, collector, agent tools). It carries `angleOf` and
  no `graphs`.
- `@vn/artgen`: `storeFacts`, for callers that hold a store but no graphs
  (`repairCurrent`, `migrateCurrent`, adoption). `repairCurrent` resolves identities over
  the manifest as it stood before its own holds, through a copy of the facts.
- `familyOf` answers `Family<HostFacts>`; see [`packages.md`](packages.md) for
  `withFacts`.

## The executor registry and task kinds

- `EXECUTORS` in `packages/pipeline/src/executors.ts` is keyed by task kind and holds each
  kind's `runner(config)` and `cost(config)`. `createRunners` and `costPreview` read it
  and name no kind. It is in the host and not on `SlotKind`, because a runner reaches
  providers and generation graphs.
- `TaskKind` is `keyof TaskInputs`. A family in another package widens it by augmenting
  `TaskInputs` (`declare module '@vn/types'`), and `EXECUTORS`' mapped type then fails to
  compile until the new kinds have executors. A runtime string registry would have made
  `Task<K>`, `taskHash`, `TaskGraph.add` and `SlotKind` untyped. Augmentation applies to
  the whole program, so the solver's tests cannot declare private kinds.
- The stills kinds stay declared in `@vn/types`, because `@vn/taskgraph`, `@vn/artgen`,
  the desktop and the solver's tests name them and none can import `@vn/stills`.
- `outfit_sheet`, `vision_review` and `prompt_refine` are `RetiredTaskKind`. An older
  `tasks.jsonl` may hold records of them, and `loadGraph` does not validate by kind. Such
  a record keeps its old answers until the legacy runners are retired: running one fails
  with `no runner for task kind "<kind>" (<hash>)`, `costPreview` prices a pending
  `outfit_sheet` at one image call (`RETIRED_COST`), `slotOfTask` files it under its sheet
  slot, the desktop's `IMAGE_KINDS` counts it, `validateProject` skips the other two, and
  the Task Graph pane's `subjectOf` reads a `vision_review` record's `target`. `AssetKind`
  still has `outfit_sheet`.
- `vngen cost` prices a dry run from the run's own requeues (`boundSlotsToDraw` solves
  once over the graph the dry run planned), so `RunSummary.redrawn` and "slots to draw"
  agree. Calling `driftedTasks` after the dry run does not work, because the dry run has
  already put those tasks back to `pending`.

## Guards that must not be loosened

- `packages/pipeline/src/tests/prompthash.test.ts` pins task hashes. Its baseline is never
  regenerated, and a change that moves a hash does not land.
- `plannerpins.test.ts` pins every task any wave plans for its fixtures, and
  `plannerwaves.test.ts` holds the planner to the waves recorded in
  `packages/pipeline/src/tests/__fixtures__/waves/`. The recording came from the planner
  as it ran before the solver took over, made twice with identical output. Re-recording
  the files is never the fix for a failing wave.
- Adding pinned cases is not regenerating the baseline.
- `identity.taskHash` is pinned by `taskgraph.test.ts`; `prompthash.test.ts` is the hash
  guard rather than that contract's pin.

## Decisions that still bind

- A contract is a `contract({...})` value with string fields, not a comment, so models can
  query it. Ids are topic areas in a closed union.
- Hosts read `contracts.json`, never the declarations.
- Retry eligibility stays in the executor.
- The solver reads `SolverFacts` only; a family's own facts pass through it unread
  (`Family<F>`), and units are opaque strings to it.
- Gates are rules over units, each gated by a family-listed set of slots, not edges.
- A bound graph's edits remain drift and are not part of identity. Deciding otherwise is a
  separate plan; the solver already reports drift through `SlotState.drift`.
- `linear` scene order is an explicit `scenes:` list, never file order.
- The legacy (non-graph) runners are kept; retiring them is a separate plan.
- The planner is a thin reader of `solve`: it decomposes the units the family says are
  owed once their gate is open, then adds the task of every `ready` slot, and still stamps
  `prompt`, `image`, `proseHash` and panel boxes on the model's own shots, by id.
- A slot's task `deps` come from `planSlot`, not from refs: a shot's refs include slots of
  author-attached references, which `Task.deps` has never held.

## Known gaps

- The desktop solves once per read (tree, `approvable`, `approvedAssets`, Task Graph pane,
  `suspensionsOf`), each over fresh `sessionFacts`. Nothing has measured whether sharing a
  solve per session snapshot is worth it. The solver-based planner measured 1.0x to 1.3x
  the time of the planner it replaced per wave, on testkit projects and the sample
  repository.
- Every host loads every contract shard. If the index grows, `search` could read shards
  lazily.
- `sessionFacts` carries no `graphs`, so no desktop surface shows graph drift from
  `SlotState.drift`.
- `vngen cost` prices from `boundSlotsToDraw`, which can miss slots the second arm of
  `boundDrift` adds, so its total can be lower than what a run redraws.
- Tombstones the collector wrote on failed or flagged staging-sheet members before the
  sheet key was fixed do not come back on their own. A restore script modelled on
  `restoreDone` was described and not written; it matters only for a project where the
  collector ran over such members.

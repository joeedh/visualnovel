# Pipeline contracts into code, shaped for more than one workflow

This plan moves every rule in `docs/reference/pipeline-contracts.md` into code and then
deletes that document; stage 9 deleted it, and the rules are now the index in
[`../../../packages/contracts/contracts.json`](../../../packages/contracts/contracts.json).
It does the move along the seams that
[`../../research/workflows-and-narrative-engines.md`](../../research/workflows-and-narrative-engines.md)
proposes, so the derivation code is extracted once, in a form a second workflow and a
second narrative engine can use, rather than extracted in its current VN shape and
reshaped later. The research behind it is
[`../../research/pipeline-contracts-into-code.md`](../../research/pipeline-contracts-into-code.md).

## Goal and scope

- **Done means:**
    - `docs/reference/pipeline-contracts.md` is deleted, and every reference to it is
      retargeted.
    - Each contract is enforced in the strongest form that fits: unrepresentable, refused
      at the write, derived by the solver, or pinned by a test.
    - Each contract is also declared as data: a `contract({...})` value beside the code
      that enforces it, with a typed id, its rule and the failure it prevents as plain
      strings, and the things it is attached to. A generated, committed index makes every
      contract queryable by the debug agent, the authoring agent and a Claude Code
      session, and a test fails if a declared contract has no test pinning it.
    - The derivation code (which slots exist, their identities, takes, approval, the gate,
      suspension, liveness, what the collector keeps, drift) runs in one place,
      `@vn/constraint-solver`, and every reader uses its answer.
    - The solver knows nothing about visual novels. The stills family, in the new
      `@vn/stills` package, is its first client, and the branching engine is the first
      implementation of the narrative seam.
- **Behaviour is preserved.** No stage changes what a run draws, what it costs, or what
  the app shows, with two stated exceptions: stage 0 fixes a slot-graph identity bug, and
  stage 5 adds the `linear` engine, which is new behaviour for projects that opt in.
- **`prompthash.test.ts` passes unchanged at every commit.** Its baseline is never
  regenerated. Stage 1 adds new pinned cases alongside it, computed from the current
  planner before anything moves; adding cases is not regenerating the baseline.
- **Left to separate plans.** None of these blocks deleting the document:
    - Retiring the legacy non-graph runners, so that every slot runs through a default
      subgraph.
    - Deciding whether a bound graph's edits stay drift or become part of identity
      (decision 4 in the research note).
    - The manga workflow and its chapter publishing, the storyboard workflow, the storylet
      adapter, and the time-based family. Opening `AssetKind` for clips belongs to the
      time-based family's plan.

## Workflows, families and styles

- **A family** is a body of shared production code: slot kinds, prompt composition, the
  decomposer, sheet planning. The stills family covers everything that produces still
  images bound to lines, and lives in `@vn/stills`.
- **A workflow** is what a project selects. It names its family and adds what is its own,
  such as its exporters and its publishing. Today there is one, `vn`. A `manga` workflow
  will follow, in the stills family too, with its own system for publishing chapters.
- **Styles overlap across workflows.** A VN can use colour manga pages, because colour
  manga is a valid VN style, and because an image model draws more consistent shots when
  asked for several panels at once. So a manga workflow does not own the manga style, and
  the VN workflow does not exclude it. This is the manga research note's "one mode, not
  two" argument, applied within the family rather than across it.
- **Today's style selectors stay as they are.** `shot_form` is a project setting
  (`packages/types/src/schemas.ts:376`), overridden per scene when it is decomposed
  (`packages/authoring/src/tools/storyboard.ts:192`), so each shot comes out as a frame or
  a page. Colour is the free-text `art_style`. This plan changes none of them.
- `project.yaml` gains `workflow:` (default `vn`) and `narrative:` (default `branching`).

## What "compatible with multiple workflows" requires

These are the constraints the workflows note puts on the extraction. Each one changes a
choice the extraction would otherwise make differently.

- **The solver cannot enumerate slots itself.** `buildSlotGraph`
  (`packages/artgen/src/slotgraph.ts:330`) lists plates, portraits, sheets and shots
  directly. Under several workflows, enumeration is the family's job, and the solver runs
  generic rules over whatever slots the family declares.
- **A family contributes slot kinds, not planner phases.** The workflows note proposed
  splitting `planTasks` into phases. With a solver, the planner becomes "the slots that
  have an identity and are ready", so there are no phases left to split. What a family
  supplies instead is one spec per slot kind. This also replaces the note's
  `TaskKindSpec`, because `slotaddr.ts`, `resolveSlot`, `slotTaskHash` and `createRunners`
  each switch over the same four kinds today.
- **The solver sees only what every family has.** A slot set, task records, manifest rows,
  bound-graph summaries and a liveness answer. `ProjectModel`, `ProjectConfig` and
  production data are the stills family's own facts, which the solver passes through to
  the family's functions without reading them (`Family<F>` below).
- **Production units are opaque to the solver.** A family groups slots into units: a scene
  for stills, possibly a clip or a storylet variant later. The solver handles unit ids as
  strings, for the gate and for decomposition.
- **Production data must be separate from script data before the solver reads it.**
  Otherwise the stills facts are `Scene.shots`, and a second family has to put its units
  on `Scene` too. The slot graph already reads persisted shots separately (`ctx.shots`),
  while the planner reads `scene.shots`; stage 4 removes that split.
- **Liveness comes from the narrative seam.** The stills family asks
  `narrative.live(sceneId)` rather than calling `reachableScenes` or reading
  `model.reachable`.
- **The gate is a generic rule over units.** Today the P3 gate is per scene: a scene's
  shots are planned, and the scene is decomposed, only once every character in
  `scene.characters` is approved (`packages/artgen/src/gate.ts:46`,
  `packages/pipeline/src/planner.ts:315`). That set includes characters who are subjects
  of no shot, and it blocks decomposition, an LLM call, before any shot exists. So the
  gate cannot be edges between slots. In the solver it is "a unit is not decomposed and
  none of its slots is ready until every slot the family lists as gating that unit is
  approved". Stills lists the portraits of `scene.characters`.
- **Decomposition is a family step, not a slot.** `planTasks` decomposes a scene lazily
  the first time it clears the gate (`planner.ts:316`). The solver reports which units owe
  a decomposition, and the executor runs the family's decomposer, as the planner does
  today.
- **The solver stays free of path.ux.** Bound graphs are path.ux `Graph` objects. The
  solver receives an optional per-slot summary computed by `@vn/gengraph` (authored hash,
  whether the graph is the default, the authored hash of the last `done` run) instead of
  the graphs themselves.

## Target shape

### Packages

| Package                         | Holds                                                                                                                                                                                                                                                                | May import (new entries in bold)                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@vn/contracts` (new)           | The `contract` and `pins` functions and the `Contract`, `ContractArea` and `Subject` types. The generated `contracts.json` and its query functions sit in a subpath, `@vn/contracts/query`, so the renderer bundle can declare contracts without carrying the index. | nothing; every package and app may import it                                               |
| `@vn/constraint-solver` (new)   | `SlotKind`, `Family`, `SolverFacts` and `SlotState`, and the generic rules. Pure: no I/O, no path.ux, no VN vocabulary.                                                                                                                                              | `types`, `util`, `taskgraph`, `contracts`                                                  |
| `@vn/stills` (new)              | The stills family: slot addresses and kinds, enumeration, the keep set, reference binding, prompt composition, layout, sheet planning, the storyboard decomposer, the gate list.                                                                                     | `types`, `util`, `config`, `parse`, `model`, `store`, `taskgraph`, **`constraint-solver`** |
| `@vn/artgen`                    | What is left: adoption, on-demand and concept art, uploads, art notes, the I/O halves of takes and collection, and `validateProject`.                                                                                                                                | today's list, **`stills`**, **`constraint-solver`**                                        |
| `@vn/types`                     | Gains `NarrativeStructure`, and splits script types from production types (stage 4).                                                                                                                                                                                 | unchanged                                                                                  |
| `@vn/model`                     | The builder, plus the `branching` and `linear` narrative implementations.                                                                                                                                                                                            | unchanged                                                                                  |
| `@vn/gengraph`                  | Unchanged, plus `graphFacts`, which summarises bound graphs for the solver.                                                                                                                                                                                          | today's list, **`stills`**, **`constraint-solver`**                                        |
| `@vn/pipeline`, `@vn/scheduler` | The executor. The planner becomes a thin reader of solver state; runners dispatch through a host-side registry keyed by task kind.                                                                                                                                   | today's list, **`stills`**, **`constraint-solver`** (pipeline only)                        |

- `@vn/constraint-solver` sits below `@vn/stills`, which sits below `@vn/artgen`. Both new
  packages sit below `pipeline` and `authoring`, so both hosts and the desktop app can
  read derived state. `@vn/taskgraph` imports `types`, `util` and `store`, none of which
  imports the solver, so `constraint-solver → taskgraph` adds no cycle.
- Lintrix forbids `@vn/constraint-solver` from importing `@vn/model`, `@vn/config`,
  `@vn/stills`, `@vn/artgen`, `@vn/gengraph` and `@vn/providers`, and forbids `@vn/stills`
  from importing `@vn/artgen` and `@vn/providers`.
- The packages that import `@vn/artgen` today (`pipeline`, `gengraph`, `authoring`, the
  desktop) gain `@vn/stills` in the same commit that moves code into it, and import it
  directly. `@vn/artgen` does not re-export `@vn/stills`. `apps/authoring` imports nothing
  from `@vn/artgen` today and needs no entry.
- The CLI and the scheduler may not import `@vn/stills`. They reach `gateStatus` and
  `baseRefusal` through `@vn/pipeline`'s re-exports (`packages/pipeline/src/index.ts:6`,
  `planner.ts:225`), and stage 2 re-points those re-exports at `@vn/stills` rather than
  widening the CLI's or the scheduler's allow-list.
- `@vn/export` may import neither. Its host computes the unapproved list and passes it in
  as a parameter (stage 6e).
- **Allow-list entries in full.** `vn/element-types` is an allow-list, so every addition
  is spelled out:
    - `contracts` is added to `elements` and to every one of the 25 `allow` entries,
      including `types`, whose list is empty today.
    - `constraint-solver`: `types`, `util`, `taskgraph`, `contracts`.
    - `stills`: `types`, `util`, `config`, `parse`, `model`, `store`, `taskgraph`,
      `constraint-solver`, `contracts`.
    - `stills` is added to `artgen`, `gengraph`, `pipeline`, `authoring` and `desktop`;
      `constraint-solver` to `stills`, `artgen`, `gengraph`, `pipeline`, `authoring` and
      `desktop`.
- **Renderer-safe subpaths.** The renderer imports `@vn/artgen/layout` today
  (`apps/desktop/renderer/rules/page.ts:9`, `renderer/pathux/editors/page.ts:12`), and
  `@vn/gengraph`'s barrel imports `@vn/artgen/slotaddr` so that the renderer bundle never
  reaches `node:fs` (`packages/gengraph/src/index.ts:9`). The stills barrel would reach it
  through `prompts.ts` → `@vn/taskgraph` → `@vn/store`. So `@vn/stills` exposes
  `@vn/stills/layout` and `@vn/stills/slotaddr` as subpaths, registered in the package's
  `exports`, both tsconfigs' `paths`, and the `SUBPATHS` list in `scripts/aliases.mjs`.
- **Setup for each new package.** An entry in `jest.config.cjs`'s `PACKAGES`, the root
  `tsconfig.json` paths, and a workspace dependency in each consumer's `package.json`,
  which needs a `pnpm install`. The auto-mode classifier has refused `pnpm install` in
  this repo before, so the stage that adds a package may need the author to run it
  (`! pnpm install`).
- **Subpaths are files, not folders.** The jest mapper and `aliases.mjs` resolve `@vn/x/y`
  to `packages/x/src/y.ts` (`jest.config.cjs:76`), so a subpath entry is one file. That
  collides with `vn/element-types`, whose elements are folders. Stage 1 extends the rule
  so that an element may also name a single file, which lets
  `packages/taskgraph/src/write.ts` be both a subpath entry and an element.

### Interfaces

A sketch. Names are working names; the stage that introduces each type settles them.

```ts
/** What the solver itself reads. A family's own facts extend it. */
interface SolverFacts {
    /** The manifest. Absent means "no store": approval reads a sheet's mirror. */
    assets?: readonly Asset[];
    /** The latest record per task hash: the in-memory graph, so a dry run sees its requeues. */
    tasks: { get(hash: string): AnyTask | undefined };
    /** Bound-graph summaries keyed by slot. Absent means drift is not computed. */
    graphs?: ReadonlyMap<string, BoundGraphFact>;
}

/** One kind of slot a family declares; replaces the per-kind switches. */
interface SlotKind<F extends SolverFacts, B, I> {
    /** Slot address prefix (`plate`, `portrait`, `sheet`, `shot`); never respelled. */
    prefix: string;
    /** Task kind; enters the task hash, so it never changes once shipped. */
    task: TaskKind;
    key(binding: B): string;
    parse(key: string): B | undefined;
    label(binding: B): string;
    refs(binding: B, facts: F): readonly string[];
    /** The task inputs this slot would run with, or the sentence saying why there are none. */
    resolve(binding: B, facts: F): Decided<I>;
    /** Whether a person has approved what fills this slot. */
    approved(binding: B, facts: F): boolean;
    contracts?: readonly Contract[];
}

interface Family<F extends SolverFacts> {
    id: string;
    kinds: readonly SlotKind<F, unknown, unknown>[];
    /** Every binding the project implies and is live, with the unit each belongs to. */
    enumerate(facts: F): readonly { binding: unknown; unit?: string }[];
    /** Every binding whose art the collector keeps; wider than `enumerate`. */
    kept(facts: F): readonly unknown[];
    /** Live units whose slots do not exist yet, because they have not been decomposed. */
    owed(facts: F): readonly string[];
    /** The slots whose approval a unit waits for, before decomposing or planning. */
    gates(unit: string, facts: F): readonly string[];
}

/** What the solver answers per slot. */
interface SlotState {
    key: string;
    task: TaskKind;
    unit?: string;
    refs: readonly string[];
    taskHash?: string;
    inputs?: unknown;
    blocked?: string;
    status?: TaskStatus;
    pick?: string;
    candidates: readonly string[];
    approved: boolean;
    ready: boolean;
    suspended: boolean;
    drift: readonly DriftReason[];
}
```

- `solve(family, facts)` returns the slot states, the dependents index, the approval
  order, the owed units, the keep set, and any project-level refusal (an `unavailable`
  base root, a reference cycle).
- `ready` means: has an identity, its unit's gate is clear, and every upstream slot it
  needs is done. The planner adds exactly the ready slots' tasks.
- `TaskKind` stays the closed union until stage 7 opens it, so `SlotKind.task` is typed
  against it in the meantime.
- The authored `asset:<hash>` pin is not a `SlotKind`, because it has no task under it
  (`packages/artgen/src/slotgraph.ts:239`). The solver treats a ref to one as an opaque
  upstream, as `buildSlotGraph` does today.
- Retry eligibility is not a solver rule. `requeueAbandoned`
  (`packages/scheduler/src/scheduler.ts:202`) releases every `running` record, including
  superseded ones that belong to no slot, and `requeueFailed` is bounded by the planned
  hash set. Both stay in the executor.
- The runner and the default subgraph are not on `SlotKind`, because the solver must not
  import providers or gengraph. Stage 7 adds a host-side registry keyed by task kind in
  `@vn/pipeline`.

### Where facts are built

One builder per host, so two readers in one host cannot assemble different facts:

- `@vn/pipeline`: `waveFacts`, called by the planner on every wave from the in-memory
  `TaskGraph`, the manifest and `graphFacts`.
- The desktop's main process: `sessionFacts`, used by the document tree, the gate pane,
  the collector, adoption and the agent's tools.
- `@vn/artgen`: `storeFacts`, for its own callers that hold a store but no graphs
  (`repairCurrent`, adoption). It leaves `graphs` absent.
- The CLI reaches the solver only through `@vn/pipeline`, because it may not import
  `@vn/gengraph` (`lintrix.config.json`).

## Contracts as data

Contracts are strings in code rather than comments, so that a model can ask which
contracts apply to the thing it is looking at.

### Declaring a contract

Each declaration sits beside the code that enforces it, for example the per-unit gate's:

```ts
export const gatePerUnit = contract({
    id      : "gate.perUnit",
    rule: "A scene is not decomposed, and none of its shots is planned, until every character in scene.characters has an approved portrait.",
    prevents:
        "Paying to decompose and draw a scene whose cast may still change, including cast members no shot shows.",
    subjects: [
        "slot:shot",
        "task:shot_image",
        "module:packages/stills/src/gate.ts",
        "command:gate.approve",
    ],
    see     : ["docs/plans/archive/INDEX.md#initial-implementation"],
});
```

- `rule` says what holds, and `prevents` says what breaks without it. Both are plain
  string literals, so the index carries them verbatim. An optional `detail` holds anything
  longer (see "Keeping the index small").
- `subjects` names what the contract is attached to. The prefixes are a closed set:
    - `slot:` a slot address prefix, `task:` a task kind, `command:` a command id, `tool:`
      an authoring or debug agent tool name (agent tools are not commands, so a command id
      cannot name them);
    - `package:`, `module:` a repo-relative path, and `function:` a repo-relative path and
      an export (`packages/stills/src/gate.ts#gates`);
    - `file:` a project-relative path such as `state/tasks.jsonl`. Repo files and project
      files are different trees, so they keep different prefixes.
- `see` carries the plan links each section of the document has today, so a model can read
  the history without the document.
- Command definitions and `SlotKind` also take an optional `contracts` field holding
  declaration values, for the cases where the thing is the natural place to say it. The
  index merges both directions.
- The enforcing code's doc comment says what the code does, as usual, and does not restate
  the contract. The declaration names that code in a `module:` or `function:` subject,
  which lets a query find the contract from the code.
- Every contract in the document becomes a declaration, cross-package or not. A sub-bullet
  that only states that two code paths agree has no declaration, because it disappears
  with the second path.

### Typed ids

An id is `<area>.<name>`. TypeScript, two lintrix rules and the generator check it:

- **TypeScript checks the shape.** `ContractArea` is a closed union in `@vn/contracts`, of
  topics rather than packages: `identity`, `storage`, `log`, `gate`, `takes`, `collect`,
  `planning`, `graphs`, `script`, `prompts`, `execution`, `providers`. The `contract`
  function types its id as `` `${ContractArea}.${string}` ``, so an unknown area does not
  compile. Areas are topics so that an id survives its code moving between packages; the
  package is already in the `module:` subject.
- **A lintrix rule, `vn/contract-decl`, checks the binding.** The id is a string literal,
  the declaration is an exported `const`, and the const's name is the id with the dot
  removed and the name capitalised (`gate.perUnit` ↔ `gatePerUnit`). So the id can be
  derived from the identifier and the identifier from the id, and neither can drift. The
  rule also refuses a `contract(` call outside `packages/*/src/` and `apps/*/src/`, and in
  a test file.
- **Tests pin by value, not by string.** A test writes `describe(pins(gatePerUnit), …)`,
  which titles it `contract gate.perUnit`. `tsgo` refuses a pin of a contract that does
  not exist, and an editor rename updates every pin. A lintrix rule, `vn/contract-pins`,
  requires the argument to be an imported identifier with no alias, so the coverage scan
  can map `pins(gatePerUnit)` to its id by the naming rule alone.
- The generator refuses two declarations with one id. Ids are unique per repo, not per
  package.

### The index

- `pnpm gen:contracts` (`scripts/gen-contracts.mjs`) loads a TypeScript entry through
  `loadEntry`, the way `gen:uxmodel` does. The entry imports, by path, each package's
  `src/contracts.ts` and each app's (`apps/desktop/src/main/contracts.ts` for the
  desktop's session code, such as the collector's apply order), plus the desktop's command
  catalog, the authoring agent's tool registry, and the stills family's slot kinds. Each
  `contracts.ts` exports one array, and no barrel re-exports it, so the arrays' names
  cannot clash under `export *`.
- It checks every subject: the module or export exists, the command is registered, the
  tool exists, the slot prefix and the task kind are declared. Until stage 6a creates the
  stills slot kinds, `slot:` subjects are checked against the `RefBinding` kinds that
  `slotaddr.ts` parses. A test per package and app fails when a `contract(` call in its
  source is missing from its `contracts.ts`.
- It writes `packages/contracts/contracts.json`, and a jest test fails when the committed
  file differs from a regeneration, as `ux-model.json`'s does.
- The coverage test scans test sources for `pins(...)`, and fails when a declared contract
  has no pinning test.
- Every host reads the committed JSON rather than importing the declarations, so
  `vnauthor`, which may not import the pipeline, sees the same index as the desktop.

### Keeping the index small

At about 70 declarations (the 36 top-level bullets plus the sub-bullets that survive),
with `rule`, `prevents`, subjects and `see`, the full index is roughly 50 KB. That is
nothing to the bundles. It matters only when a model reads it, so each measure below
targets what a model reads:

- **Caps on the two short fields.** `vn/contract-decl` caps `rule` and `prevents` at 280
  characters each. Anything longer goes in `detail`, which no query returns unless asked.
  The cap also keeps each contract to one checkable statement.
- **Summary by default.** Every query returns summaries (id, `rule`, subjects) unless it
  asks for `full`, which adds `prevents`, `detail` and `see`. A summary is about 300
  bytes, so a query that matches 20 contracts returns about 6 KB.
- **A subject index in the file.** The JSON carries a precomputed `bySubject` map beside
  the contracts. `bySubject` matches exactly or by prefix, so `module:packages/stills/`
  lists everything attached to that package's files, and a lookup never needs the whole
  list in context.
- **A per-call cap.** The agent tool returns at most 20 contracts per call and says how
  many it left out, so a broad query is reported as cut rather than read as complete. In
  the debug agent, its output is charged to the run's byte `Budget`, which the host passes
  in as it does for the source tools (`packages/agentreport/src/sourcetools.ts:411`).
- **Shards, only if needed.** If the index passes 100 KB, the generator warns, and the
  file splits into a small `contracts.json` (summaries and the subject map) and one
  `contracts/<area>.json` per area for the full records. A model reading files then reads
  the small file and one shard. Splitting is not done up front, because one file is
  simpler for every host until the size makes it worth it.

### Who can query

- The debug agent gets a `query_contracts` tool in `@vn/agentreport`, beside
  `list_requests`. Contracts are facts about the code, not the author's data, so it needs
  no grant of its own. It is offered whenever the analyst runs a tool loop, which is when
  the author has granted source or request access. With neither granted, `analyze` makes
  one direct call with no tools (`packages/agentreport/src/analyze.ts:546`), and that path
  is left unchanged, so this plan does not turn every analysis into a loop.
- The authoring agent gets the same tool in `@vn/authoring`, read-only, so that when a
  tool refuses it, it can look up the rule behind the refusal by `tool:<name>` (decision
  13). The tool is deferred rather than always loaded (it stays out of `ALWAYS_LOADED`,
  `packages/authoring/src/loop.ts:274`), so the cached tool catalog does not change.
- A Claude Code session reads `packages/contracts/contracts.json`, or runs
  `pnpm contracts <query>`, which prints one summary line per match and the full record
  with `--full`. `CLAUDE.md` points at both in stage 9.

## Stages

Each stage lands green under `pnpm check`, `pnpm test` and `pnpm lint`, with
`prompthash.test.ts` unchanged. Each stage deletes the bullets of the contracts document
it moved, so the document only ever describes rules that still live there. The stages run
in order, one branch at a time, because each one edits the same document. The
`vn/element-types` allow-list is updated in the stage that adds or moves the import. A
contract is declared in the stage that puts its code in its final package.

### Stage 0: fix the slot graph's staging-sheet identity

The first item, landed on its own before any of the rest.

**Landed 2026-11-17 as `e80abfea`.** As built:

- `sheetKeys` moved into `packages/artgen/src/sheet.ts`, so the planner and `resolveSlot`
  call one function.
- `readAllShots` now copies each storyboard file's `sheets` onto its model scene
  (`syncSheets` in `packages/store/src/shots.ts`), so a group's seed and notes reach every
  caller that resolves identity against the model. Adoption and the desktop's scene
  coverage, which read a single storyboard, call `syncSheets` themselves. A reader that
  writes to the model it is given is unusual; stage 4's production map replaces it.
- Adoption and the desktop's three read-only lookups pass the manifest.
- `priceShotChanges` also prices the other members of a changed shot's group.
- Records already written under the wrong identity: adopted `done` records are harmless
  and re-adopting files them correctly, and `current` bits repair themselves on the next
  `repairCurrent`. Tombstones the collector wrote on failed or flagged staging-sheet
  members do not come back on their own; a restore script modelled on `restoreDone` was
  described but not written, because it matters only for a project where the collector ran
  over such members.

The plan as written before it landed:

- `resolveSlot` calls `shotInputs` without the sheet key (`slotgraph.ts:235`), while the
  planner passes it (`planner.ts:385`), and `prompts.ts:628` writes that key into
  `params.extra.sheet`. So the slot graph reports the wrong identity for every
  staging-sheet member today.
- Every reader of `resolveSlot` or `slotTaskHash` for those slots gets the wrong answer:
    - the document tree's status and `shotprice`;
    - `repairCurrent` (`packages/artgen/src/takes.ts:203`), which rewrites `current` bits;
    - the collector (`packages/artgen/src/collect.ts:168`), whose orphan pass (`:295`) can
      tombstone a staging-sheet member's real task record;
    - adoption (`adoptslot.ts:171`), so an existing project may already hold an adopted
      `done` record filed under the wrong hash;
    - the desktop's `session/asset.ts:502` and `session/gate.ts:351`.
- Fix `resolveSlot` to pass the key the planner passes, through the same `sheetKeys` call.
  Add a test with a staging-sheet group that asserts the slot graph's `taskHash` equals
  the planner's for every member, a collector case that must not treat a member's record
  as orphaned, and a sheet group in `slotagreement.test.ts` so the agreement test covers
  the case it missed.
- The commit states what happens to records already written under the wrong identity
  (adopted `done` records, `current` bits, tombstones): whether the next load repairs them
  or a migration is needed.
- The planner's hashes do not move, so `prompthash.test.ts` is untouched. The slot graph's
  sheet-member identities move, which is the fix.

### Stage 1: tooling and guards

**Landed 2026-11-18 on the `contracts` branch, as `ffd3bbd1` to `f5250170` and the commit
that adds this note.** As built:

- **A seventh `tasks.jsonl` writer** the table below missed: the desktop's `forget`
  (`apps/desktop/src/main/session/missing.ts:293`) tombstones every record whose output is
  the forgotten picture. It now imports `logTombstone` from `@vn/taskgraph/maintain` like
  the others.
- **The `done` contract names two verbatim writers, not one.** The collector's undo
  (`session/collect.ts`, formerly `:328`) puts back the records a collection tombstoned,
  and those can be `done`. It now goes through `logRestored`, which `restoreDone` also
  calls. The declaration (`log.doneWriters`) says the maintenance writers re-write a
  record the log already held, verbatim, or write `pending`.
- **Allow-lists.** There were 24 `allow` entries, not 25; with the three file elements
  (`taskgraph-write`, `taskgraph-maintain`, `artgen-adopt`) there are 27, and every one
  lists `contracts`, `debug2d`'s included. `taskgraph` may import `taskgraph-write`, for
  its own `contracts.ts`. `artgen-adopt` lists `taskgraph-maintain` as the plan says,
  although `adopt.ts` imports nothing from it today.
- **The repin.** `repinAdoption` in `adoptslot.ts` takes over swapping the pin in the
  previous node's inputs as well as the write, so the desktop no longer builds task
  inputs.
- **The oracle** has two fixtures beyond the four named: staging sheets resolved from a
  manifest, and a gate held by an unapproved character no shot shows. The pins are every
  task any wave planned, and a test checks that each fixture reaches its case.
- **The index.** Each record carries `declared`, the file whose const declares it. A
  `module:` query also matches the `function:` subjects in that file. `tool:` subjects are
  checked against `vnauthor`'s registry and the analyst's source, request and contract
  tools; the desktop-only agent tools (`show_me`, `ux_*`, history) and `submit_report` are
  not in the check. `slot:` is checked by probing `parseSlot`, which also reads `asset:`.
  Each `contracts.ts` exports `CONTRACTS`, imported by path in
  `scripts/contracts/entry.ts`. The staleness, listing and coverage tests are in
  `scripts/contracts/tests/`.
- **Commands** gained the optional `contracts` field, and the generator adds
  `command:<id>` to those contracts' subjects. `SlotKind`'s field waits for stage 6a.
- **The line-id contract** is pinned rather than newly refused: `insertLine` already
  allocates from the scene, so the stage adds the declaration and its test, not a refusal.
- **Naming.** The authoring tool's module is `tools/contractquery.ts`, because
  `contracts.ts` is reserved for a package's declaration list.
- **Docs.** `CLAUDE.md`'s core-ideas list and `docs/index.md` dropped "line ids" and point
  at `pnpm contracts`. `docs/reference/packages.md`, `CLAUDE.md`'s layering diagram and
  the command table are left for stage 9, which the plan gives them to.
- The vnauthor, desktop main and renderer bundles all build with `@vn/contracts`; the
  first two carry the index.

The plan as written before it landed:

- **Contracts as data.** Add `@vn/contracts`, the two lintrix rules, `pnpm gen:contracts`,
  the committed index, the staleness and coverage tests, `pnpm contracts <query>`, and the
  two agents' `query_contracts` tools. Declare one existing contract end to end, to prove
  the whole path: the declaration, a pinning test, the index entry, and a tool call that
  finds it by its `module:` subject. Use a contract whose code no later stage moves: "Line
  ids are allocated and stored, and a read never writes", in `@vn/scriptedit`. Confirm
  that `tsgo`, jest and the esbuild bundles for the desktop and `vnauthor` all import
  `@vn/contracts/query`'s JSON.
- **File elements in `vn/element-types`.** Extend the rule so an element may name a single
  `.ts` file as well as a folder, with the longest match still winning. Add tests to
  `scripts/lintrix/tests/rules.test.ts`.
- **Planner oracle.** Copy today's `planTasks` into a test-only oracle under
  `packages/pipeline/src/tests/`, together with the gate and sheet helpers it calls
  (`sceneUnblocked`, `approvedPortraitOf`, `sheetKeys`), so that stage 6 cannot end up
  comparing the solver with itself. Prompt composition stays live in the oracle; the
  pinned hashes guard it. Add pinned task hashes for fixtures that `prompthash.test.ts`
  does not cover: it runs only `SCRIPTS.linear` (`prompthash.test.ts:39`). The new
  fixtures cover manga pages, staging-sheet groups, outfit overrides and authored
  references. The oracle is deleted at the end of stage 6.
- **The task log's writers.** Six places write `state/tasks.jsonl` today:

    | Writer                                                 | Writes                         | Through                        |
    | ------------------------------------------------------ | ------------------------------ | ------------------------------ |
    | `@vn/scheduler`                                        | every status                   | `logTask`                      |
    | `packages/artgen/src/adopt.ts`                         | `done`                         | `logTask`                      |
    | `packages/gengraph/src/collect.ts`                     | tombstones                     | `logTombstone`                 |
    | `apps/desktop/src/main/session/collect.ts:290`, `:328` | tombstones, `restored` records | raw `appendJsonl(tasksLog, …)` |
    | `apps/desktop/src/main/session/missing.ts:232`         | `done`, restored from history  | `restoreDone`                  |
    | `apps/desktop/src/main/session/asset.ts:470`           | `pending`                      | `logTask`                      |

    `adopt` is reached from `adoptslot.ts`'s three callers and also directly from the
    desktop's repin (`apps/desktop/src/main/session/prompt.ts:405`), so the document's
    "three callers and no other" is already inaccurate.

- Changes:
    - Move the writers out of `log.ts` into two files, each a subpath entry.
      `packages/taskgraph/src/write.ts` (`@vn/taskgraph/write`) holds `logTask`, which can
      write any status. `packages/taskgraph/src/maintain.ts` (`@vn/taskgraph/maintain`)
      holds `logTombstone`, `logRestored`, `logRequeue` (writes `pending` only) and
      `restoreDone` (re-writes a record that was `done`, verbatim). Neither is re-exported
      from `@vn/taskgraph`.
    - Replace the desktop collector's raw `appendJsonl` calls with `logTombstone` and
      `logRestored`. A test fails if any file other than those two passes `tasksLog` to
      `appendJsonl`.
    - Export `packages/artgen/src/adopt.ts` as `@vn/artgen/adopt` and drop it from the
      barrel. Route the desktop's repin through an `adoptslot.ts` function instead of
      calling `adopt` directly.
    - Register file elements: `taskgraph-write` (`write.ts`) is importable from
      `scheduler` and `artgen-adopt` (`adopt.ts`) only, and `taskgraph-maintain`
      (`maintain.ts`) from `gengraph`, the desktop and `artgen-adopt`.
- **Contracts moved:** "A `done` record is written outside the scheduler by three callers
  and no other", restated as: outside the scheduler, `done` is written only by adoption,
  and re-written verbatim only by `restoreDone`.

### Stage 2: the `@vn/stills` package

**Landed 2026-11-18 on the `stills` branch, in the commit that adds this note.** As built:

- **`assetSlotLabel` went into `refcycle.ts`, not `slotaddr.ts`.** It calls `slotOf`,
  which lives in `refcycle.ts` and reads `SHEET_FRONT` from `prompts.ts`, which imports
  `@vn/taskgraph`. In `slotaddr.ts` it would have pulled that chain into the
  `@vn/stills/slotaddr` subpath, which `@vn/gengraph`'s barrel, and through it the
  renderer, imports.
- **`takes.ts`.** `angleOfTask` and `loggedTake` moved, into
  `packages/stills/src/takes.ts`. The rest stayed:
    - `openTakeDeps`, `migrateCurrent`, `repairCurrent`, `catchUpMirrors` and `acceptTake`
      read or write the store.
    - `acceptableTakes` writes nothing, but it reads through the `TakeDeps` store handle
      and shares the private `contextOf` and `prereqContextOf` with the functions that do
      I/O. Moving it would have meant moving `TakeDeps` and publishing both helpers.
    - `migrationPick` and `isSheet` are private helpers of `migrateCurrent` alone.
      `migrationPick` is a take-choosing rule, so stage 6d, which moves the take into the
      solver, should decide it again.
- **`keptSlots`** is exported from a new file, `packages/stills/src/kept.ts`.
- **Tests.** The tests of the moved files moved with them, as did `page.test.ts` and
  `seed.test.ts`, which test only `layout.ts` and `prompts.ts`. `gate.test.ts` was split:
  its second half drives `setArtNotes` and `repairCurrent` through a real project, so it
  stayed in `@vn/artgen` as `mirror.test.ts`. `prompthash.test.ts` is unchanged, and the
  oracle's import lines are the only change to it.
- **Allow-lists.** `stills` may import `types`, `util`, `config`, `parse`, `model`,
  `store`, `taskgraph` and `contracts`. `constraint-solver` is left off until stage 6
  creates the package. `stills` was added to `artgen`, `gengraph`, `pipeline`, `authoring`
  and `desktop`, all of which import it, and no other package needed it. Its
  `package.json` lists only what it imports: `types`, `util`, `config`, `model` and
  `taskgraph`.
- **Re-exports.** `@vn/pipeline` re-exports from `@vn/stills` where it re-exported a moved
  name from `@vn/artgen`: the gate in `index.ts`, the prompt builders in `prompts.ts`, the
  storyboard in `p5.ts`, `heldBy` in `repair.ts` and `proseHash` in `drift.ts`.
  `baseRefusal` stays in `@vn/artgen`, because `base.ts` is not on the list. The CLI and
  the scheduler import nothing new.
- **Setup.** `stills` is in `PACKAGES` and `SUBPATHS` in `scripts/aliases.mjs`, as
  `docs/guides/toolchain.md` asks of a new package, although `artgen` itself is not in
  that `PACKAGES` list. The `@vn/artgen/slotaddr` and `@vn/artgen/layout` subpaths are
  gone.
- **Contracts.** No declared subject named a moved file, so the index is unchanged.
- **Docs.** `packages.md`, `module-map.md`, `CLAUDE.md`'s diagram and layering rules, and
  the reference pages that named a moved function or subpath under `@vn/artgen` now name
  `@vn/stills`. Plans and research pages keep the paths they were written against.

The plan as written before it landed:

No behaviour change. It comes before the contracts are declared, so that each stills
contract is declared once, in its final package.

- **Whole files that move** from `packages/artgen/src/` to `packages/stills/src/`:
  `slotaddr`, `refs`, `resolve`, `upstream`, `prompts`, `chunks`, `layout`, `sheet`,
  `storyboard`, `subject`, `gate`, `coverage`, `condense`, `shotprice`, `refcycle`,
  `drift` (the prose hash), `overheld`, `prereq` and `slotgraph`. `slotgraph.ts` has no
  I/O, so it moves whole; stage 6 replaces it.
- **Parts of files that move:**
    - `assetSlotLabel` moves from `describe.ts` into `slotaddr.ts`. It is the only thing
      `prereq.ts` takes from `describe.ts`, and it is pure. The rest of `describe.ts`
      takes a `ChatBackend` and stays in `@vn/artgen`.
    - From `takes.ts`, the functions that do no I/O move, starting with `angleOfTask` and
      `loggedTake`. `repairCurrent` and `migrateCurrent`, which open the store and load
      the task graph, stay in `@vn/artgen`. The rule for every other function in the file
      is the same: it moves if it does no I/O.
    - From `collect.ts`, only `keptSlots` (`collect.ts:71`) moves, as the start of the
      stills family's `kept`. The rest of the file is `planAssetCollection`, which reads
      the disk itself, and stays. The apply half of collection is in `@vn/gengraph`
      (`packages/gengraph/src/collect.ts`) and the desktop, and does not move.
- `upstream.ts` moves here because `prereq.ts` needs it, and stage 6d moves it on to the
  solver. It is the one file that moves twice. `suspend.ts` stays in `@vn/artgen` until
  stage 6d and imports what it needs from `@vn/stills`.
- `@vn/stills` may not import `@vn/providers` or `@vn/artgen`. Each moved file's imports
  are checked against that before the move, and lintrix confirms it after.
- Every importer of a moved name imports it from `@vn/stills` in the same commit, or
  through `@vn/pipeline`'s re-exports for the CLI and the scheduler. `@vn/artgen` does not
  re-export it. The renderer's `@vn/artgen/layout` imports become `@vn/stills/layout`, and
  `@vn/gengraph`'s `@vn/artgen/slotaddr` becomes `@vn/stills/slotaddr`.
- Split files are real code changes, not moves, so the commit is reviewed function by
  function for those three files.
- `docs/reference/packages.md` and `CLAUDE.md`'s layering diagram gain `@vn/stills`.

### Stage 3: contracts that are not about the pipeline

**Landed 2026-11-18 on the `contracts3` branch, as `26a9d6bc` to `1b18b90f` and the commit
that adds this note.** As built:

- **25 declarations in eight packages**, one commit per package: `@vn/store`, `@vn/model`,
  `@vn/scriptedit`, `@vn/stills`, `@vn/gengraph`, `@vn/artgen`, `@vn/pipeline` and
  `@vn/providers`. With stage 1's two, the index holds 27, and `contracts.json` is 56 KB,
  below the 100 KB shard threshold.
- **Two claims were false**, and the declarations state what is true; behaviour is
  unchanged:
    - The reviewer bullet said `Shot.castOptional` "is part of the prompt, so setting it
      re-renders that frame". Only `shotSpec` reads it, so it is outside the task inputs
      and re-keys nothing. `prompts.reviewerSpec` says so, and a test pins it. The
      `story.requireCast` description and `packages/scriptedit/src/cast.ts`'s module
      comment repeat the false claim and are unchanged.
    - The P5 bullet said `decomposeScene` "requires that every line be assigned to exactly
      one shot". The system prompt asks for it, but the code only drops ids the scene does
      not have, falls back when no real line is bound, and gives an uncovered first line
      to the first shot. `prompts.decomposeByLineId` states that.
- **Bullets split across packages**, where the enforcing code is in more than one:
    - Entity discovery: `script.entityByTag` in `@vn/store`, where `entities.ts` is, and
      `script.entityIdMatchesFile` in `@vn/model`.
    - Each scene occupies one file: `script.sceneOneFile` in `@vn/model`, and
      `script.sceneSourcesOneLoad` and `script.sceneEditAllOrNothing` in `@vn/scriptedit`.
    - A heading edit: `identity.headingRekeysShots` in `@vn/stills` and
      `script.headingRestagesShots` in `@vn/scriptedit`.
    - Art direction: `prompts.artNotesAppended` in `@vn/stills`, where stage 2 moved the
      builders, and `prompts.artRungsShared` in `@vn/artgen`.
- **Sub-bullets kept in `detail`** rather than declared on their own: the staging sheet's
  forced-run refusal and run serialisation, the outfit's `usedOutfits` fan-out, and the
  art rungs' seed, image model and sheet-form writer. The staging sheet's sub-bullet that
  the planner, the runner, `gengraph.run` and `resolveSlot` key through one function only
  says two code paths agree, so it has no declaration.
- **Pins.** Most retitle an existing `describe` or move existing tests under a new one.
  New tests: `scriptedit/src/tests/sources.test.ts`, a 12-way concurrent write in
  `store/src/tests/assetremove.test.ts`, and the heading and `castOptional` tests in
  `stills/src/tests/prompts.test.ts`. The `@vn/stills` storyboard, art-notes and reviewer
  contracts are pinned in `pipeline/src/tests/pipeline.test.ts`, where their tests already
  were, so `@vn/pipeline` gained `@vn/contracts` in the stills commit.
- **`query_contracts`' index test** matched the line-id contract only on the first line of
  the answer. A `module:` query also matches `function:` subjects in that file, so
  `script.headingRestagesShots` now sorts first for `lineops.ts`; the test matches any
  line.
- **The scheduler half of `providers.modelIdRoutes`** is enforced by `vn/element-types`,
  not a test. The bullet's "imports `Task`, `deps`, and `status`" was loose, so the
  declaration states only that the allow-list keeps providers out.
- **Docs.** The "Seams" heading went with its only bullet, and its contents entry was
  removed by hand. Links retargeted to the declaring file: `asset-stores.md`,
  `story-bible.md`, `cli.md`, `manga-style.md`, `gen-graphs.md` (node types) and
  `desktop-app-editors-misc.md`. The archived `pathux-rich-editor-widgets.md` names the
  art-direction bullet in prose, not as a link, and is unchanged.

The plan as written before it landed:

- Move each bullet to a contract declaration and its tests in the package that owns it,
  then delete it. The list is the stage 3 rows of the disposition table.
- Every link into a deleted bullet's anchor is retargeted in the same commit;
  `pnpm check:doclinks` finds them.

### Stage 4: production data off `Scene`

**Landed 2026-11-18 on the `production` branch, as `ebcf380f` to `f5329400` and the commit
that adds this note.** As built:

- **The production map came first and the folders second**, the reverse of the plan's
  order. The `types-script` element cannot be green while `Scene` still names `Shot`, so
  the commit that moves the folders has to follow the one that empties `Scene`.
- **`ProjectModel.production` is a `Map<string, ProductionData>`**, like the model's other
  keyed collections. `ProductionData` is `{ shots, sheets? }`, the shape
  `work/shots/<sceneId>.json` holds, and `shotsOf(model, sceneId)` answers a scene's
  shots, or none. `ProjectModel` is never serialized or sent over IPC, so no file or IPC
  format changed: the shots files, `story.play.json`, the manifest and `SceneCoverage` are
  as they were.
- **A loader never writes into a model the planner plans from.** The builder leaves the
  map empty, and the planner fills a scene's entry the first time the scene clears the
  gate, as it used to fill `scene.shots`, so wave-by-wave behaviour and `firstCycle`'s
  reach are unchanged. A reader that wants every storyboard takes a copy:
    - `withProduction(paths, model)` in `@vn/store` returns `{ ...model, production }`.
    - `readProduction` returns the map and a `broken` set of scenes whose file will not
      parse. The collector, `validate.ts` and the document tree read `broken`, which
      replaces the `null` entries `readAllShots({ reportBroken })` used to return.
    - The exporter keeps a strict reader, `withSceneShots`, which throws on a bad file.
- **What replaced `readAllShots` and `syncSheets`.** Both are gone. `syncSheets` copied
  each file's `sheets` onto the shared model's scenes as a side effect of reading. The
  scheduler, the CLI and the desktop `loadProject` now hand `repairCurrent` a
  `withProduction` copy and leave the model the run plans from untouched. A few readers
  build a one-scene model of their own and write into it: `adoptslot.ts`, the desktop's
  `planSheet`, `coverageFromProject` and `locateRung`. Each of those models is local to
  the call.
- **`ctx.shots` is gone from every context**: `SlotGraphContext`, `SlotResolveContext`,
  `PrereqContext`, `OverHeldContext`, `TakeDeps`, `ArtNotesContext` and the desktop's
  `DocTreeInput` and `DerivePromptContext`. `usedOutfits`, `unapprovedTakes`, `keptSlots`
  and `buildPlayable` lose their shots argument, and `sheetGroups` and `sheetMembers` take
  a scene's shots rather than the scene.
- **No hash moved.** `prompthash.test.ts` passes unchanged against its baseline. The
  oracle passes with its fixtures staging the same storyboards in the production map, and
  `oracle.ts` was edited the way `planner.ts` was. No control's offer changed:
  `pnpm gen:uxmodel` regenerated `ux-model.json` byte for byte.
- **The types folders.** `entities.ts` is split into `assets.ts` (top level),
  `script/characters.ts`, `script/locations.ts`, `script/scenes.ts`, `production/shots.ts`
  and `production/storyboard.ts`. `schemas.ts` stays whole at the top level, because it
  mixes config, both layers and private helpers. The barrel exports the same names. Two
  lintrix elements, `types-script` and `types-production`, enforce the direction. Like
  every element rule they check one import statement at a time, so a script file importing
  a top-level file that names a production type would not be caught.
- **Three contracts.** `storage.storyboardKept` in `@vn/store`'s `shots.ts`, and
  `prompts.clauseList` and `prompts.refOnClause` in `@vn/types`' `prompt.ts`; `@vn/types`
  gained `contracts.ts` and a dependency on `@vn/contracts`. The index holds 30, and
  `contracts.json` is 63 KB.
    - The reference bullet called a ref with no binding "an upload". `prompt.addRef`
      attaches a concept by bare hash the same way, so the declaration says such a ref
      names an asset by hash.
    - The refusals for that contract (an unknown clause, the same pin twice) are in the
      desktop's `applyPromptEdit`, not in `@vn/stills`; the one refusal in `@vn/stills` is
      the cycle check, already `prompts.refsAcyclic`.
    - The storyboard bullet also held the `shot_form`, page, bubble and panel-box rules,
      which are not about persistence. They stay on the page under a bullet of their own.
- **For stage 5.** The production map holds an entry for every scene with a file,
  reachable or not, because `readProduction` walks `model.scenes`, as `readAllShots` did.
  The readers that should see only live scenes (`buildSlotGraph`, `usedOutfits`) walk
  `reachableScenes` and look each one up with `shotsOf`, so moving them to
  `narrative.live` is a change of iterator. The document tree and the collector iterate
  the map and are meant to see unreachable storyboards too.
- **For stage 6.** The planner's map is partial by design, and the one a reader gets from
  `withProduction` is full; the solver has to say which it reads, and the oracle compares
  wave by wave against the partial one. `shotsOf` returns the live array, and the planner
  stamps `image` and `proseHash` onto those shots in place before `writeShots`, so a
  solver that copies the storyboards must write the stamped copy back.

The plan as written before it landed: The workflows note's step 1.

- Move `Scene.shots` and `Scene.sheets` into `ProjectModel.production`, a map keyed by
  scene id, matching `work/shots/<sceneId>.json`.
- The planner's lazy decomposition writes into that map instead of assigning
  `scene.shots`. The slot graph reads the same map instead of its separate `ctx.shots`.
- About 148 references to `.shots` in 50 files and 22 to `.sheets` in 12 files, outside
  tests. The change is mechanical; `pnpm check` finds every site.
- Types: script types (characters, locations, scenes, lines) move to
  `packages/types/src/script/`, production types (shots, sheets, `ProductionData`) to
  `packages/types/src/production/`. Production may import script; script may not import
  production. `ProjectModel` stays in `packages/types/src/model.ts`, outside both folders,
  and imports both. The barrel stays outside both folders too.

### Stage 5: the narrative seam

**Landed 2026-11-18 on the `narrative` branch, as `4fb1d082` to `89212c2f` and the commit
that adds this note.** As built:

- **The interface has six members, not four.** `NarrativeStructure` is in
  `packages/types/src/script/narrative.ts`, with `NARRATIVE_ENGINES` and `SceneExits`:
    - `engine` is the closed union `NarrativeEngine` (`branching | linear`), like
      `TaskKind`; a storylet adapter widens it.
    - `entry` was added because each engine settles the entry its own way (`start:`, or
      the first listed scene), and `model.entry` is filled from it.
    - `exits(sceneId)` was added because the playable needs each scene's edges, and
      `linear` scenes have no markers to read them from. It is the adjacency query the
      workflows note deferred, and the playable, `toMermaid` and the screenplay export
      read it.
    - `scenes()` lists every scene the model holds, the live ones first in reading order,
      then the rest. For `branching` that is `topologicalOrder`, then the unreachable
      scenes in model order, which is what the document tree's `storyOrder` was; the tree
      now reads it.
- **`Diagnostic` moved** to its own top-level file, `diagnostic.ts`, so the script folder
  can name it without importing `model.ts`, which names production types.
- **How the model carries it.** `ProjectModel.narrative` is required. The builder fills
  `reachable` and `entry` from it, so their readers are unchanged. A hand-built model
  takes `liveOnly(live, rest)` from `@vn/testkit`, a stand-in structure in which the
  listed scenes are live in order; the testkit `model()` factory uses it, and the few test
  literals outside testkit's reach call it or `branchingNarrative`. The structure closes
  over the scenes map it was built from, so a copy of the model that replaces `scenes`
  keeps the old answer.
- **The engines** are `branchingNarrative` in `packages/model/src/branching.ts` (the entry
  check, `dangling_goto`, `unreachable_scene`, `successors`, `computeReachable`,
  `topologicalOrder`, all moved out of `build.ts` and `graph.ts`) and `linearNarrative` in
  `linear.ts`. `graph.ts` keeps only `toMermaid`. The builder's `narrativeOf` picks one.
  `unknown_location` stayed in the builder, since it is about the script. The narrative
  diagnostics are now reported together, ahead of `unknown_location`, instead of
  interleaved scene by scene; no test depended on the order.
- **Callers.** `reachableScenes` is gone. `liveScenes(model)` in `used.ts` replaces it and
  reads `narrative.live`, in model order, so the planner walks scenes in the order it
  always did. The planner, `decompose.ts`'s `decomposeAll` and `decomposeAllPreview`,
  `buildSlotGraph`, `usedOutfits` and the oracle call it; `gateStatus` calls
  `narrative.live` directly. The authoring agent's `story_graph` reads `model.reachable`
  rather than recomputing reachability. `doctree.ts`, `storygraph.ts`, `generated.ts`,
  `workspace.ts` and the CLI keep reading `model.reachable`.
- **Config.** `narrative` (an enum defaulting to `branching`) and `scenes` (a list of ids)
  are in the zod schema. Every check against the scenes is a model diagnostic, as `start:`
  is, so a mistake reaches the CLI, the desktop app and `vnauthor` through
  `model.diagnostics` and needs no new UI. Every caller of `modelFromInputs` passes its
  whole `ProjectConfig`, which satisfies the new `ModelConfig`.
- **Diagnostics, defaults kept.** Under `linear`: `missing_scene_list`,
  `unknown_listed_scene`, `duplicate_listed_scene`, `linear_branch_marker` and
  `linear_start` are errors, and `unlisted_scene` is a warning. A `scenes:` list under
  `branching` is the error `scenes_without_linear`, rather than being ignored. Two
  diagnostics go beyond the defaults the stage was given: the missing list, whose message
  names the scene ids to list, and the duplicate. The table is in
  [`../../guides/cli.md`](../../guides/cli.md#how-the-scenes-make-a-story).
- **The playable format did not change.** It already had a plain `next` edge;
  `buildPlayable` writes `choices` and `next` from `narrative.exits`.
- **Tests.** `SCRIPTS.listed` with `LISTED_ORDER` beside it, ids that sort differently
  from the list. `packages/model/src/tests/narrative.test.ts` covers both engines and the
  builder, and `packages/export/src/tests/linear.test.ts` runs a linear project through
  the mock pipeline and the exporter. `prompthash.test.ts` and the oracle pass unchanged.
  No command or rule module changed, so `ux-model.json` and the anchors are untouched.
- **Contracts.** `script.livenessFromNarrative` in `build.ts` and
  `script.linearOrderListed` in `linear.ts`. The contracts document stated no narrative
  rule, so no bullet moved; two wording changes there and in
  `planning.storyboardOnRequest` say "live" where they said "reachable". The index holds
  32, and `contracts.json` is 66 KB.
- **Left as they are under `linear`.** The Branches editor still draws and edits markers,
  which `linear` reports as errors; the workflows note's gating of editors by engine is
  not done. Deleting or renaming a scene does not edit `scenes:`, so the list is left
  naming the old id, which `unknown_listed_scene` reports. The desktop has no control for
  either key.
- **For stage 6.** The stills facts should read `narrative.live`, not `model.reachable`.
  Units stay scene ids: the solver need only accept the strings the family hands it.
  `readProduction` still fills an entry for every scene with a file, live or not, so the
  enumeration filters by `live` and the collector does not. `liveScenes` is in model
  order; a reader that wants reading order calls `narrative.scenes()`.

The plan as written before it landed: the workflows note's step 2.

- Add `NarrativeStructure` (`engine`, `scenes()`, `live(id)`, `diagnostics()`) to
  `@vn/types`, and move the branching code behind it in `@vn/model`: the markers'
  validation, `goto` checks and reachability.
- The builder fills `model.reachable` from `narrative.live`, so the readers of
  `model.reachable` that this stage does not touch keep working under every engine:
  `doctree.ts:174` and `:738`, `storygraph.ts:29`, the authoring `workspace.ts:269` and
  `generated.ts:137`, and the CLI's `commands.ts:289`, among others.
- Replace the production-side calls to `reachableScenes` with `narrative.live`:
  `planner.ts`, `decompose.ts`, the stills enumeration and `@vn/model`'s `used.ts`.
  `gateStatus` reads `model.reachable` directly (`packages/artgen/src/gate.ts:76` today,
  in `@vn/stills` by this stage) and moves to `narrative.live` too.
- Add `linear`, selected with `narrative: linear` in `project.yaml`. Scene order comes
  from an explicit `scenes:` list in `project.yaml`, not from file order, because the
  repo's rule is that a directory has no document order (the reason `start:` exists).
  Every listed scene is live, and the playable gives each scene a `next` edge to the
  following one.
- Test it with a new testkit script under a name that cannot be confused with the existing
  `SCRIPTS.linear`, which is a branching-engine script.
- `branching` stays the default, so no existing project changes.

### Stage 6: the constraint solver, with stills as its first family

**6a landed 2026-11-18 on the `solver` branch, as `e653980c` and `c350ec04` and the commit
that adds this note.** As built:

- **`SolverFacts`** is `{ assets?, tasks }`. `graphs` is left out until 6d defines
  `BoundGraphFact`.
- **`SlotKind<F, B, K extends TaskKind>`.** The sketch's `I` became the task kind `K`, and
  `resolve` answers `Decided<TaskInputs[K]>`, so a kind and its inputs stay correlated.
  The solver hashes with `taskHash(kind.task, inputs)`, which is what every branch of
  `slotTaskHash` does, so the stills kinds wrap `resolveSlot` and not `slotTaskHash`;
  `slotTaskHash` stays for its other callers. Three members go beyond the sketch:
    - `candidates(binding, facts)`, the manifest rows bound to the slot, newest first;
    - `pick(binding, facts)`, the row the slot holds, which 6d replaces with the solver's
      own rule;
    - a third argument to `approved`, `Held { pick?, rows }`, so the stills test reads the
      rows `candidates` already filtered instead of filtering the manifest again.
- **`Family<F>`** is `{ id, kinds, enumerate }`. `enumerate` returns `Slot<F>` records,
  `{ kind, binding, unit? }`, rather than bare bindings, because the solver cannot find a
  kind from an `unknown` binding. `slot(kind, binding, unit?)` builds one and type-checks
  the pairing. `owed`, `gates` and `kept` are not on the type: no 6a code needed them, so
  nothing is stubbed, and 6b, 6c and 6d add them.
- **`SlotState`** is `key`, `kind` (the prefix), `task`, `binding`, `label`, `unit?`,
  `refs`, `taskHash?`, `inputs?` (typed `TaskInputs[TaskKind]`), `blocked?`, `status?`,
  `pick?`, `candidates` and `approved`. `binding` and `label` are added because the slot
  graph's readers use them. `pick`, `candidates` and `approved` are real, computed through
  the kinds from `resolveBinding`, `candidatesFor` and `newestFirst` as `buildSlotGraph`
  computes them. `ready`, `suspended` and `drift` are not on the type; 6b to 6d add them.
- **`solve`** returns `Solution { slots, dependents, order }`. The owed units, the keep
  set and the project-level refusals belong to 6b and 6d.
- **`Decided`** moved to `packages/constraint-solver/src/family.ts`; `slotgraph.ts`
  re-exports it, so its importers did not change.
- **The stills family** is `packages/stills/src/family.ts`: `stillsFamily`, `StillsFacts`,
  and `plateKind`, `portraitKind`, `sheetKind` and `shotKind`, built by one factory over
  `slotKey`, `parseSlot`, `slotLabel`, `refsOfSlot`, `resolveSlot`, `candidatesFor` and
  `resolveBinding`. `StillsFacts` is the solver's facts plus `SlotGraphContext` without
  `assets` and `graph`, with `tasks` in place of `graph`, and with `assets` required, as
  `BindingContext` requires it. The enumeration is written out again rather than shared
  with `buildSlotGraph`, so the equality test compares two enumerations. A shot's unit is
  its scene id, and no other slot has one.
- **The equality test** is `packages/pipeline/src/tests/solveagreement.test.ts`.
    - It maps each `SlotState` to a `SlotNode` (dropping `kind`, `task`, `unit` and
      `inputs`, and renaming `pick` to `hash`) and compares the ordered lists with
      `toStrictEqual`, then the dependents and the order. The four dropped fields are
      checked on their own: `kind` is the binding's kind, `unit` is the scene id for a
      shot and absent otherwise, `task` and `inputs` equal `resolveSlot`'s plan, and
      `taskHash(task, inputs)` is the slot's hash.
    - It covers the six stage 1 fixtures before and after each of five planner waves, each
      with the fixture's manifest and with the oracle's `ROWS`, plus once with no task
      log. It also covers the five testkit scripts on disk (`listed` under
      `narrative: linear`) at four points: nothing drawn, halted at the gate, after
      approval and a full run, and after accepting everything. Each point is compared four
      ways: the planner's own model with its partial production map, the `withProduction`
      copy, that copy with an `angleOf`, and that copy with no task log.
    - Changing `heldAccepted` to ignore `accepted` fails five of its eleven tests.
    - The oracle's fixtures moved to
      `packages/pipeline/src/tests/__fixtures__/projects.ts` so both tests share them. The
      oracle's pins did not change.
- **The toy family** is in `packages/constraint-solver/src/tests/solve.test.ts`. A `seed`
  (`prompt_refine`) is drawn from nothing. A `sprout` (`vision_review`) belongs to a bed,
  its unit, and its inputs embed its seed's output, so it has no identity until the seed's
  task is done; it may also lean on other sprouts. The tests cover enumeration and the
  rule that the first enumeration of an address wins, identity and status, blocked
  reasons, a ref to an address no slot has, dependents, the upstream-first order, a cycle,
  and the take and approval passing through the kind.
- **Contracts.** Three, so the index holds 35 and `contracts.json` is 71 KB:
    - `identity.slotsBeforeTasks` in the solver's `solve.ts`, pinned by the toy family
      test.
    - `planning.sheetsOnlyWhenWorn` in `family.ts`, pinned by
      `packages/stills/src/tests/family.test.ts`. The gate sub-bullet is in its `detail`.
    - `takes.approvedMeansAccepted` in `family.ts`, pinned by the same file. No bullet was
      false, but its `detail` records the one case where the test differs from the gate's
      `approvedPortraitOf`: a portrait slot whose only row is accepted but not current is
      approved by the slot and not by the gate. `SlotNode.approved`'s doc comment still
      described an asymmetric test the code no longer has, and now says what the code
      does.
- **`SlotKind.contracts` is wired.** The generator imports `stillsFamily`, checks a
  `slot:` subject against the declared prefixes instead of probing `parseSlot` (so
  `slot:asset`, which no contract used, is no longer accepted), and adds `slot:<prefix>`
  to each contract a kind carries, as it adds `command:<id>` for commands. All four kinds
  carry the first and third contracts; plates, portraits and sheets also carry the second.
- **Allow-lists.** `constraint-solver` may import `types`, `util`, `taskgraph` and
  `contracts`. It imports only `types`, `taskgraph` and `contracts` today, and its
  `package.json` lists those three. A probe importing `model`, `config`, `stills`,
  `artgen`, `gengraph` and `providers` was refused six times and removed.
  `constraint-solver` was added to `stills` only. `solveagreement.test.ts` imports it from
  `@vn/pipeline`, but test files are exempt from `vn/element-types`, and a test-only
  import is not listed in `package.json` (as `@vn/testkit` is not), so `pipeline` gained
  no entry.
- **Setup.** `tsconfig.json` paths, `PACKAGES` in `jest.config.cjs` and
  `scripts/aliases.mjs`, the lintrix element, and the workspace dependency in
  `packages/stills/package.json`. `pnpm-lock.yaml` was edited by hand, and
  `pnpm install --offline --frozen-lockfile` accepts it. The package has no subpath.
- **Docs.** `packages.md`, `module-map.md` and `CLAUDE.md`'s diagram and layering rules
  gain the package.
- **For 6b:**
    - **No manifest is not an empty manifest.** `StillsFacts.assets` is required, so a
      caller without a store passes `[]`, and `resolveSlot` then finds no approved
      portrait in it. The planner without a manifest reads the sheet's mirror instead
      (`approvedPortraitOf(character, undefined)`), so it plans sheets and shots that the
      solver, given `[]`, reports as blocked. 6b has to make `assets` optional in
      `StillsFacts`, handing `undefined` to `resolveSlot` and `[]` to `candidatesFor`, or
      the wave-by-wave comparison fails on every fixture without a manifest.
    - **Identity is not readiness.** A slot's identity ignores the unit gate: in the
      `gated` fixture with a manifest, `held__1` resolves a hash the planner never plans,
      because Ren is unapproved. 6b's `ready` therefore needs the unit gate, which makes
      `Family.gates` a 6b requirement rather than a 6c one, unless 6b keeps the planner's
      `sceneUnblocked` check until 6c.
    - **The solver computes no `deps`.** The planner gives a shot task its plate task and
      its non-default sheet tasks as deps. Portraits are not deps, since a shot keys on
      the approved hash rather than the portrait task. `Task.deps` is not hashed, but
      `topoOrder` reads it, so 6b must derive the same list, from the refs' task hashes or
      as a kind method.
    - **Partial and full production maps.** `solve` reads whatever `model.production`
      holds and never fills it, so the planner's model gives shot slots only for scenes
      already decomposed. A `waveFacts` over that model matches the planner if the owed
      decompositions run before each wave is solved. Readers (6e) want the
      `withProduction` copy.
    - **In-place stamping.** The planner writes `shot.prompt`, `image` and `proseHash`
      onto the live `shotsOf` objects before `writeShots`. None of the three enters a
      shot's inputs, so stamping moves no identity, but the solver hands back no shot
      objects: the planner must keep stamping the model's own shots, by id, after reading
      the solver's answer.
    - **Cost.** Per slot, `solve` makes the calls `buildSlotGraph` makes, including the
      second `candidatesFor` inside `resolveBinding`. 6a measured no timing, so 6b's
      measurement starts from that parity.
    - `solveagreement.test.ts` goes with `buildSlotGraph` and `slotagreement.test.ts`. Its
      testkit-script half can be pointed at the planner instead.

**6b landed 2026-11-18 on the `planner` branch, as `d4a8ad8e` and `11f651be` and the
commit that adds this note.** As built:

- **The planner.** `planTasks` decomposes the scenes `stillsFamily.owed` lists that the P3
  gate has cleared, then adds the task of every slot `solve(stillsFamily, facts)` gives an
  identity, skipping a shot whose scene the gate holds. It stamps `prompt`, `image`,
  `proseHash` and the panel boxes on the model's own shots, found by id, and writes the
  shots file of every cleared live scene after the loop. The base refusal and the cycle
  check are unchanged. It builds its facts twice per wave, before and after decomposing,
  because the kinds memoise on the facts object.
- **Solver additions.**
    - `SlotKind.deps` (optional) and `SlotState.deps`: the task hashes a slot's task runs
      after, asked only of a slot that resolved.
    - `Family.owed`: the live units with no slots yet. `Solution` carries no `owed`,
      because the planner has to decompose before it solves, so it asks the family
      directly.
    - `SlotKind.pick` takes the rows `candidates` listed, so the manifest is not scanned
      twice per slot.
    - No `ready` field and no `Family.gates`; see the gate decision below.
- **Stills additions.**
    - `planSlot` answers a slot's resolved task and its deps from one walk, and
      `resolveSlot` is `planSlot` without the deps.
    - `StillsFacts.assets` is optional. With no manifest, `planSlot` reads each sheet's
      mirror for approval, and no slot holds a row.
    - `resolveSlot` used to refuse two slots the planner plans: the `day` plate of a
      location that declares no variants, and the sheet of an outfit a shot names that the
      character sheet does not author. Both now resolve, through `variantIds` (new in
      `@vn/model`'s `used.ts`) and `usedOutfits`.
    - The kinds memoise each slot's plan on the facts object (a `WeakMap`), and group the
      manifest once per facts object by the character, location or scene each row names,
      so `candidatesFor` filters a few rows instead of the whole manifest. Facts are
      therefore a snapshot, and `StillsFacts`'s doc comment says so.
    - `slotGraph` in `family.ts` answers `solve` in the `SlotGraph` shape, for the readers
      6e moves. `buildSlotGraph` is deleted.
- **Readers moved to `slotGraph`.** The document tree
  (`apps/desktop/src/main/session/docs.ts`), the gate pane (two calls in
  `session/gate.ts`), the Task Graph pane (`session/pipeline.ts`), takes (three calls in
  `packages/artgen/src/takes.ts`) and the gen-graph loader (`unrenderedBoundSlots` in
  `packages/pipeline/src/graphload.ts`). `validateProject` and the agent tools did not
  call `buildSlotGraph` directly.
- **Tests.**
    - `plannerwaves.test.ts` holds the planner equal to the oracle wave by wave, comparing
      each wave's `kind hash deps` lines and the shots both stamp. It covers the oracle's
      six fixtures, three of its own (a location with no variants, an outfit only a shot
      names, two characters cast in the reverse of the model's order), and every testkit
      script before and after approval, with and without `paths`. Reverting either
      `resolveSlot` change fails the matching fixture.
    - `slotplan.test.ts` replaces `slotagreement.test.ts` and `solveagreement.test.ts`. It
      keeps the agreement cases and stage 0's staging-sheet cases, against `solve`, and
      its testkit half checks that a reader's facts promise what the planner plans that
      wave, at four points per script.
    - The `buildSlotGraph` describe in `slotgraph.test.ts` is rewritten against `solve`,
      with one test holding `slotGraph` equal to it. The toy family gains `deps` and
      `owed`.
- **Setup.** `pipeline` may import `constraint-solver` (lintrix allow-list,
  `package.json`, `pnpm-lock.yaml` by hand; `pnpm install --offline --frozen-lockfile`
  accepts it).
- **Decisions.**
    - **The gate stays the planner's `sceneUnblocked` check.** Keeping it cost nothing:
      the planner filters a slot's `unit` through a per-wave memo of `sceneUnblocked`, and
      the same check gates decomposition. Adding `Family.gates` in 6b would have widened
      the stage without changing a hash.
    - **Deps come from `planSlot`, not from refs.** A shot's refs include the slots of
      references an author attached, which `Task.deps` has never held, and a slot address
      can lose its slot while its task is still done (a removed variant). `planSlot`
      computes the plate and sheet task hashes in the same walk that finds their outputs,
      as the planner did.
    - **The P2–P7 enumeration left `planner.ts` in the first commit.** `planTasks`'s body
      was that enumeration, so replacing it removed it; a dead copy would have been
      unreferenced code, and the oracle already holds the frozen copy for a revert. The
      second commit deleted `buildSlotGraph` and the agreement tests.
    - **The graph's insertion order changed.** The planner used to add each character's
      portrait and then its sheets; it now adds slots in the solver's order, so every
      portrait precedes every sheet, and sheets follow `usedOutfits`' order rather than
      `allCharacters`'. `graph.ready()` and so the pool's start order follow insertion
      order. Hashes, deps and stamps are unchanged, and no test depended on the order.
    - **Shots files are written after the loop.** The planner used to write each scene's
      file before decomposing the next scene, so a stop during a later decomposition no
      longer rewrites the earlier scenes' files that wave. The next pass writes them.
- **Timing.** Per wave, median of 51 runs, from a throwaway scratchpad script, on the
  largest testkit project (`branching`, approved and drawn, then from an empty graph) and
  a copy of `examples/mySampleRepo` (149 manifest rows). Before `pick` took the rows and
  the kinds memoised plans and grouped the manifest, the solver-based planner took 2.0x to
  2.4x master's time on the sample and 1.6x to 2.05x on `branching`. After them:

    | Project             | Wave | Tasks | Master  | 6b      | Ratio |
    | ------------------- | ---- | ----- | ------- | ------- | ----- |
    | branching, drawn    | 0    | 19    | 0.21 ms | 0.34 ms | 1.62  |
    | branching, drawn    | 1    | 19    | 0.20 ms | 0.32 ms | 1.60  |
    | branching, fresh    | 0    | 12    | 0.15 ms | 0.24 ms | 1.60  |
    | branching, fresh    | 1    | 19    | 0.20 ms | 0.33 ms | 1.65  |
    | branching, fresh    | 2    | 19    | 0.19 ms | 0.31 ms | 1.63  |
    | mySampleRepo, drawn | 0    | 27    | 0.62 ms | 0.95 ms | 1.53  |
    | mySampleRepo, drawn | 1    | 27    | 0.61 ms | 1.14 ms | 1.87  |
    | mySampleRepo, fresh | 0    | 17    | 0.40 ms | 0.62 ms | 1.55  |
    | mySampleRepo, fresh | 1    | 27    | 0.50 ms | 0.80 ms | 1.60  |
    | mySampleRepo, fresh | 2    | 27    | 0.51 ms | 0.76 ms | 1.49  |

    The other four testkit scripts land between 1.4x and 1.9x, except `orphan` (5 tasks,
    about 0.05 ms), where fixed per-wave cost puts it at 2.4x. The remaining cost is
    per-slot work the readers need and the planner discards: candidates, refs, labels and
    approval.

- **Contracts.** One, so the index holds 36 and `contracts.json` is 73 KB:
  `planning.incremental` in `packages/pipeline/src/planner.ts`, pinned by
  `plannerwaves.test.ts`. Its `detail` carries the `vngen cost` undercount and the deps
  rule. The `detail` of `takes.approvedMeansAccepted` and `planning.sheetsOnlyWhenWorn`,
  which named `buildSlotGraph`, is reworded.
- **For 6c:**
    - The gate to replace is `cleared` in `planTasks`: it filters decomposition and every
      slot with a `unit`. `plannerwaves.test.ts`'s "a gate held by a non-subject" fixture
      covers the case where a shot resolves while its scene is still gated.
    - Facts are snapshots. A builder that mutates the model or the task log between solves
      must build new facts, or the kinds answer from their memo.
    - `slotGraph` is a 6e wrapper. Its eight call sites, in five files, are listed above.
    - `SlotKind.pick` now takes the candidate rows; 6d replaces `pick` with the solver's
      own rule.
    - `oracle.ts` and `oracle.test.ts` still run, beside `plannerwaves.test.ts`, until 6e.

**6c landed 2026-11-18 on the `gate` branch, as `378aa8f5`, `b560d51f` and `244390cb` and
the commit that adds this note.** As built:

- **The solver's unit gate.**
    - `Family.gates(unit, facts)` lists the addresses of the slots a unit waits on.
      `SlotKind.clears` (optional) says whether a slot lets a unit that waits on it go
      ahead; a kind without it answers with `approved`.
    - `Solution.units` maps every unit a slot names or `Family.owed` lists to a
      `UnitGate`, `{ gates, holding, open }`, where `holding` is the gates that have not
      cleared.
    - `SlotState.ready` is true for a slot with an identity whose unit, if it has one, is
      open. The plan's third condition ("every upstream slot it needs is done") is already
      part of having an identity, in stills and in the toy family, so `ready` does not
      test it again.
    - `unitGates(family, facts)` answers `Solution.units` without resolving any slot. It
      enumerates, so it sees the same units, and asks only the gating slots' `candidates`,
      `pick` and `clears`. `solve` and `unitGates` share one function, and a test holds
      them equal.
    - A gating address is looked up among the enumerated slots, not parsed. An address the
      family does not enumerate holds the unit, which is how a cast member with no
      character sheet holds a scene.
    - The toy family's beds wait on seeds. The seed kind's `clears` is looser than its
      `approved` (any accepted row), so a test can tell which one the solver asked.
- **Stills' gates.** `stillsFamily.gates(sceneId)` lists the portrait of every member of
  `scene.characters`. The portrait kind's `clears` is `portraitClears`, which calls
  `approvedPortraitOf(character, rows)` over the manifest rows that name the character
  (the group `candidatesFor` already reads), or with `undefined` when the facts carry no
  manifest, so it reads the sheet's mirror. That keeps the gate's stricter reading.
  Removing `clears` from the portrait kind fails the oracle's fixtures that plan without a
  manifest.
- **The planner.** `planTasks` asks `unitGates` before decomposing, only when something is
  owed, and decomposes the open units. After decomposing it builds new facts, solves, and
  adds the task of every `ready` slot. The shots files it writes after the loop are those
  of the open units in `Solution.units`. Its facts come from `waveFacts`, new in
  `packages/pipeline/src/facts.ts`. `sceneUnblocked` is deleted.
- **`gateStatus`** moved from `gate.ts` to `family.ts`, because `gate.ts` cannot import
  the family (`family.ts` → `slotgraph.ts` → `gate.ts`). It reads
  `unitGates(stillsFamily, …)` and keeps `(model, assets)`; `@vn/pipeline` still
  re-exports it by name, so the CLI and the scheduler did not change. It has no config to
  give, so `StillsFacts.config` became optional: without it every slot's `resolve` refuses
  with `NO_CONFIG`, which the gate never asks. `PlanFacts` is `StillsFacts` with `config`
  required, the type each host's builder returns.
- **`usedOutfits` once.** The family computes it once per facts object (`wardrobe`), for
  the sheet enumeration and for `planSlot`, which takes it through a new optional
  `SlotResolveContext.outfits`. A `resolveSlot` caller that does not pass it computes it
  per call, as before.
- **`sheetSeeds`'s three callers** take their arguments from their host's one builder: the
  planner (through `planSlot` and `sheetKeys`) and the scheduled runner's `sheetSeedsFor`
  from `waveFacts`, and `gengraph.run` (`graphRunPlan`) and the sheet scaffold
  (`planSheet`) from the desktop's new `sessionFacts` in `session/core.ts`. The signature
  stays positional, because `oracle.ts` calls it that way and may not change.
- **Tests.**
    - `packages/pipeline/src/tests/plannergate.test.ts`, pinning `gate.perUnit`: a scene
      whose unapproved cast member is in no shot is neither decomposed nor planned until
      that member is approved; the oracle's "a gate held by a non-subject" fixture plans
      no shot for `held` with or without a manifest, while `held__1` has a task hash and
      is not ready; the gate opens only on a row both current and accepted, stays shut on
      an accepted row that is not current although the slot calls it approved, reads the
      mirror without a manifest and the lock whatever the slot holds; a cast member with
      no sheet holds the scene. `gateStatus` is compared with a copy of the walk it
      replaced over the oracle's fixtures (with no manifest, `ROWS` and an empty one), a
      scene left out of the story, and every testkit script at four points.
    - `apps/desktop/src/main/tests/sheetseeds.test.ts`: for a staging-sheet group on disk,
      the planner's `params.extra.sheet` on a member equals `sheetKey` of the runner's
      seeds, and `gengraph.run`'s sheet prompt and references equal the runner's.
    - `slotplan.test.ts`'s `promised` reads `ready` instead of a copy of the gate.
- **Behaviour visible to hosts.** None intended, and none found. `gateStatus` answers what
  the walk answered on every case the tests cover. The planner's hashes, deps, stamps and
  shots-file writes are unchanged. `SlotState` gains `ready` and `Solution` gains `units`,
  which `slotGraph` drops, so the document tree, the gate pane and the Task Graph pane
  receive the same `SlotNode`s.
- **Timing.** Per wave, from the 6b script: each run takes the median of 51 plans, and the
  table gives the median of three runs per side, master and 6c interleaved on one machine.
  This machine ran slower than 6b's did, so the master column is not comparable with 6b's
  table. Task counts match on every row.

    | Project             | Wave | Tasks | Master  | 6c      | Ratio |
    | ------------------- | ---- | ----- | ------- | ------- | ----- |
    | branching, drawn    | 0    | 19    | 0.82 ms | 0.79 ms | 0.96  |
    | branching, drawn    | 1    | 19    | 0.76 ms | 0.78 ms | 1.03  |
    | branching, fresh    | 0    | 12    | 0.52 ms | 0.55 ms | 1.06  |
    | branching, fresh    | 1    | 19    | 0.76 ms | 0.75 ms | 0.99  |
    | branching, fresh    | 2    | 19    | 0.68 ms | 0.62 ms | 0.91  |
    | mySampleRepo, drawn | 0    | 27    | 2.41 ms | 2.64 ms | 1.10  |
    | mySampleRepo, drawn | 1    | 27    | 2.26 ms | 2.33 ms | 1.03  |
    | mySampleRepo, fresh | 0    | 17    | 1.58 ms | 1.74 ms | 1.10  |
    | mySampleRepo, fresh | 1    | 27    | 2.08 ms | 2.15 ms | 1.03  |
    | mySampleRepo, fresh | 2    | 27    | 2.00 ms | 2.19 ms | 1.09  |

    Over every wave of all five testkit scripts and the sample, 6c takes 1.03x master's
    time. The extra `unitGates` call runs only on a wave with an owed scene (wave 0 of a
    fresh project), and `usedOutfits` is now computed once per facts object rather than
    once per sheet slot.

- **Contracts.** One, so the index holds 37 and `contracts.json` is 77 KB: `gate.perUnit`
  in `packages/stills/src/family.ts`, carried by the portrait and shot kinds and pinned by
  `plannergate.test.ts`. Its `detail` holds what the document's bullet said (the mirror,
  the lock, `repairCurrent`, the halted run, `holdPortrait`) and the four cases where the
  portrait slot's `approved` and the gate's `clears` differ: an only row accepted but not
  current, no manifest, a lock, and two current rows. The bullet is gone from
  `pipeline-contracts.md`, and `asset-stores.md` and `docs/index.md` no longer point at
  it. Reworded: `planning.incremental` (rule and detail), `planning.sheetsOnlyWhenWorn`
  and `takes.approvedMeansAccepted` (detail). `script.livenessFromNarrative` names
  `gateStatus` in `family.ts`.
- **For 6d:**
    - `clears` is a second approval test beside `approved`. If 6d's take rule makes the
      portrait slot's `approved` read currency the way `approvedPortraitOf` does, the two
      can merge and the four cases in `gate.perUnit`'s detail go away; until then the
      difference is deliberate.
    - `unitGates` enumerates every slot to find the units. The planner calls it only on a
      wave with something owed.
    - `sessionFacts` has two callers. The desktop's other solver readers (the eight
      `slotGraph` calls 6b lists) still assemble their own context; 6e moves them.
      `graphRunPlan` resolves its slot with no manifest, so a shot's portrait reference
      comes from the sheet's mirror there and from the row in the planner; the two agree
      while `AssetStore.accept` keeps the mirror, but 6e should pass `sessionFacts` to
      `resolveSlot` as well.
    - `oracle.ts` and `oracle.test.ts` still run, and still copy `sceneUnblocked`, until
      6e.

**6d landed 2026-11-19 on the `rules` branch, as `1de4f664`, `dc294c60`, `5febe95e`,
`44a8dcc6` and `0a39c0d6` and the commit that adds this note.** As built:

- **The take** (`1de4f664`).
    - `packages/constraint-solver/src/take.ts` holds `pick`, `newestFirst`, `loggedTake`,
      `lastRenderedAt` and `overHeld`, moved from `@vn/stills` (`refs.ts`, `slotgraph.ts`,
      `takes.ts`, and `overheld.ts`, which is deleted).
    - `solve` sorts a slot's candidates newest first and picks the take itself.
      `SlotKind.pick` is gone, and `SlotKind.candidates` returns rows in manifest order.
    - `overHeld(family, facts, identity?)` walks the manifest's current rows and asks the
      new `Family.slotOf` which slot each fills, so it still repairs a slot no enumeration
      lists, such as a deleted character's portrait. The optional `SlotKind.named` lists
      the hashes a family's own records name as a slot's take; the stills shot kind
      answers with every storyboard image, as the old first arm did. The third argument is
      the facts a slot's identity is resolved over, so `repairCurrent` still resolves
      identities over the manifest as it stood before its own holds.
    - `repairCurrent` and `validateAssets` call the solver's `overHeld`. Validation passes
      no config and no task log, so its report reads only the storyboards and the rows'
      stamps, as before.
    - `@vn/artgen` may import the solver (lintrix, `package.json`, `pnpm-lock.yaml` by
      hand; `pnpm install --offline --frozen-lockfile` accepts it).
- **The base-root refusal** (`dc294c60`). `refuse.ts` holds `baseRefusal`, moved from
  `@vn/artgen`'s `base.ts`, and `projectRefusal(facts)`. `SolverFacts.base` and
  `Solution.refusal` are new. A refused solve still states every identity and makes no
  slot ready. `planTasks` builds its facts with the base root (`waveFacts` takes `base`)
  and asks `projectRefusal` before decomposing, so it refuses as before. `@vn/artgen`'s
  `base.ts` and `@vn/pipeline`'s `planner.ts` re-export `baseRefusal` by name.
- **Suspension** (`5febe95e`). `suspend.ts` holds `suspensions(family, facts)`, the walk
  from `@vn/artgen`'s `suspend.ts` with its order, cycle guard and inherited sentence
  unchanged. The new `Family.drawnFrom` answers a row's upstream hashes and the sentence
  naming its own moved reference, if any. `SlotState.suspended` is true when the slot's
  take is in the list. The stills `drawnFrom` resolves a pinned slot's take over the rows
  grouped under its subject rather than the whole manifest.
- **The keep set** (`44a8dcc6`). `keep.ts` holds `keepSet(family, facts)`, answering
  `{ slots, tasks, outputs }` over the new `Family.kept`. `stillsFamily.kept` lists
  `keptSlots`, so the set is as wide as before. `planAssetCollection` reads it in place of
  its own loop over `keptSlots` and `resolveSlot`, with the same facts.
- **Drift** (`0a39c0d6`).
    - `drift.ts` holds `DriftReason`, `BoundGraphFact` and `boundDrift`. A drawn output
      node drifts when its authored hash differs from the one its last completed run
      recorded; one that never ran drifts when its graph is not the default one.
      `SolverFacts.graphs`, `SlotKind.drift` and `SlotState.drift` (the kind's reasons,
      then the graph's) are new.
    - `@vn/pipeline`'s `graphFacts(runtime, slots)` builds the facts, and `driftedTasks`,
      which `requeueDrifted` calls, decides through `graphFacts` and `boundDrift` instead
      of its own comparison.
    - `driftOf` moved from `@vn/pipeline`'s `drift.ts` to `@vn/stills`' `drift.ts`, and
      the stills shot kind's `drift` reports prose drift.
- **Decisions.**
    - **`clears` and `approved` stay separate.** Making the portrait slot's `approved`
      read `approvedPortraitOf` would change what the document tree and the gate pane show
      for a portrait in the four cases `gate.perUnit`'s detail lists (a locked character,
      no manifest, an accepted row that is not current, two current rows). The gate's
      answers would not move, but the panes' would, so the difference stays documented.
    - **Contracts with family vocabulary are declared outside the solver.** The solver's
      own declarations name no plate, sheet, shot, portrait or scene, even in their text.
      `takes.currencyExclusive` is declared in the stills family, `collect.unusedRemoved`
      in `@vn/artgen`'s `collect.ts` and `script.proseDriftReported` in stills'
      `drift.ts`, each with `function:` subjects on the solver code, as `gate.perUnit` is.
    - **Suspension and over-held walk manifest rows, not slot refs.** A row's history is
      the take it was drawn from, which its upstream slot may no longer hold, and the
      repair has to reach slots no enumeration lists. Walking slot refs would have changed
      both answers.
    - **`keepSet` is not a field of `Solution`.** It resolves slots `enumerate` does not
      list, which the planner would pay for on every wave and never read.
    - **`graphFacts` lives in `@vn/pipeline`, not `@vn/gengraph`.** It reads the
      slot→graph runtime the pipeline builds (`GraphRuntime`), and `@vn/gengraph` has no
      allow-list entry for the solver.
    - **No host's facts carry `graphs` yet.** `waveFacts` leaves them out, so the planner
      pays nothing for graph drift; the rule runs in production through `driftedTasks`.
- **Timing.** Per wave, from the 6c script: each run takes the median of 51 plans, and the
  table gives the median of three runs per side, master and 6d interleaved on one machine.
  The machine was busier than 6c's, and the testkit rows below 0.5 ms move by up to 0.2 ms
  between runs of the same side. Task counts match on every row.

    | Project             | Wave | Tasks | Master  | 6d      | Ratio |
    | ------------------- | ---- | ----- | ------- | ------- | ----- |
    | branching, drawn    | 0    | 19    | 0.40 ms | 0.42 ms | 1.05  |
    | branching, drawn    | 1    | 19    | 0.38 ms | 0.40 ms | 1.05  |
    | branching, fresh    | 0    | 12    | 0.29 ms | 0.29 ms | 1.00  |
    | branching, fresh    | 1    | 19    | 0.47 ms | 0.44 ms | 0.94  |
    | branching, fresh    | 2    | 19    | 0.34 ms | 0.37 ms | 1.09  |
    | mySampleRepo, drawn | 0    | 27    | 1.57 ms | 1.86 ms | 1.18  |
    | mySampleRepo, drawn | 1    | 27    | 1.30 ms | 1.66 ms | 1.28  |
    | mySampleRepo, fresh | 0    | 17    | 1.16 ms | 1.22 ms | 1.05  |
    | mySampleRepo, fresh | 1    | 27    | 1.48 ms | 1.54 ms | 1.04  |
    | mySampleRepo, fresh | 2    | 27    | 1.40 ms | 1.43 ms | 1.02  |

    Over every wave of all five testkit scripts and the sample, 6d takes 1.12x master's
    time; the highest single row is 1.68x (`diamond`, fresh, wave 1, 0.31 ms against 0.52
    ms). The added per-wave work is the suspension walk over the manifest and a prose hash
    per drawn shot, both inside `solve`.

- **Contracts.** Seven, so the index holds 44 and `contracts.json` is 103 KB, past the 100
  KB at which the generator warns:
    - `takes.currencyExclusive` (`@vn/stills` `family.ts`, every kind), pinned by
      `packages/stills/src/tests/overheld.test.ts`.
    - `storage.baseUnavailable` (solver `refuse.ts`), pinned by the toy family and
      `pipeline.test.ts`.
    - `takes.suspensionDerived` (solver `suspend.ts`), pinned by
      `packages/artgen/src/tests/suspend.test.ts`.
    - `collect.unusedRemoved` (`@vn/artgen` `collect.ts`) and `collect.applyOrder`
      (`@vn/gengraph` `collect.ts`), pinned by
      `packages/gengraph/src/tests/collect.test.ts`.
    - `graphs.editInvalidates` (solver `drift.ts`), pinned by the toy family and
      `graphdrift.test.ts`. Its `detail` carries the executor half (`requeueDrifted`, once
      per run, `RunSummary.redrawn`, the journal write that clears it).
    - `script.proseDriftReported` (stills `drift.ts`, the shot kind), pinned by
      `packages/pipeline/src/tests/drift.test.ts`.
    - Reworded: `takes.approvedMeansAccepted`'s subject names the solver's `pick`.
    - Removed bullets: the base root, the collector, currency, suspension, prose drift and
      graph drift. `asset-stores.md`, `gen-graphs.md`, `vnauthor.md` and
      `desktop-app-editors-story.md` name the contracts instead of linking to them.
- **Behaviour visible to hosts.** None intended, and none found. The planner's hashes,
  deps and stamps are unchanged (`plannerwaves.test.ts`, the oracle and
  `prompthash.test.ts` are untouched and pass). `SlotState` gains `suspended` and `drift`
  and `Solution` gains `refusal`, which `slotGraph` drops.
- **Wrappers left for 6e**, each returning what it returned before:
    - `suspendedAssets` and `suspensionMap` (`@vn/artgen`), read by the CLI's status
      through `@vn/pipeline`'s `prompts.ts`, and by the desktop's `suspensionsOf`
      (`session/core.ts`), which `session/gate.ts` and `session/asset.ts` call.
    - `driftOf` and `proseHash` re-exported from `@vn/pipeline`'s `drift.ts`, read by the
      document tree (`doctree.ts`), `driftedFrames` (`session/core.ts`) and Shot Coverage
      (`session/story.ts`), and by the planner's stamping.
    - `baseRefusal` re-exported from `@vn/artgen`'s `base.ts` and `@vn/pipeline`'s
      `planner.ts`, read by adoption, concept art, promotion, upload, the scheduler, the
      desktop's `session/asset.ts`, and `oracle.ts`.
    - `reportGraphs`' `drifted` list and `boundSlotsToDraw` (`graphload.ts`) still call
      `@vn/gengraph`'s `graphDrift`, which reports the edited arm only and over every
      output node, active or not.
- **For 6e:**
    - The readers above can read `SlotState.suspended` and `SlotState.drift` from one
      `solve`, with `graphFacts` passed as `SolverFacts.graphs` where graph drift is
      wanted. `sessionFacts` does not pass it yet.
    - `contracts.json` passed 100 KB. The plan's split into a summary file and one shard
      per area ("Keeping the index small") is now due.
    - `repairCurrent`'s first loop and `migrateCurrent` still read `slotGraph`.
    - Stage 8 can give `requeueDrifted` its own declaration and move the executor half out
      of `graphs.editInvalidates`' `detail`.
    - `oracle.ts` and `oracle.test.ts` still run until 6e.

**6e landed 2026-11-19 on the `readers` branch, as `ec1ee3eb`, `84cf47a0`, `c3feaff0`,
`cd2a5c9b`, `c4f17b4a` and `f69279f3` and the commit that adds this note.** As built:

- **Every reader solves** (`ec1ee3eb`).
    - `slotGraph` and its `SlotGraph` and `SlotNode` shapes are deleted from `@vn/stills`.
      Each former reader calls `solve(stillsFamily, facts)` and reads `SlotState`.
    - The document tree takes the solver's slots and order through `SlotsRead`
      (`doctree.ts`), and reads `kind` and `pick` where it read `binding.kind` and `hash`.
    - The gate pane's `approvable` and `approvedAssets` walk `Solution.order`.
    - The Task Graph pane keeps its wire shape: `SlotNode` moved to `shared/ipc.ts`
      unchanged, and `slotNodes` projects it from the solver's states, `pick` as `hash`.
    - `@vn/artgen`'s `migrateCurrent`, `repairCurrent`'s first loop, `catchUpMirrors` and
      `acceptableTakes` build their facts with one internal builder, `storeFacts`.
      `repairCurrent` still resolves identities over the manifest as read before its own
      holds, through a copy of those facts, since the kinds memoise on the object.
    - `unrenderedBoundSlots` (`@vn/pipeline` `graphload.ts`) solves over `waveFacts`,
      which takes an optional `angleOf`. The planner passes none, so its facts are
      unchanged.
    - On the desktop every reader builds its facts with `sessionFacts`, which now carries
      `angleOf` (`angleOfTask` over the task log), equivalent to the one the readers' own
      contexts built. `angleOf` changes no answer of `resolveSlot`, `sheetSeeds` or
      `planSheet`.
    - `graphRunPlan` resolves its slot over `sessionFacts`, so it reads the manifest as
      the planner does.
    - The desktop may import `@vn/constraint-solver` (lintrix, `package.json`,
      `pnpm-lock.yaml` by hand; `pnpm install --offline --frozen-lockfile` accepts it).
    - `validateProject` already read the solver's `overHeld` (6d). The agent tools that
      derive slot state reach it through `approvable`, `approvedAssets`, `acceptableTakes`
      and `repairCurrent`, which all solve now. The collector already read `keepSet` (6d),
      so row 115 needed nothing more.
- **The 6d wrappers are gone** (`84cf47a0`).
    - `@vn/artgen`'s `suspend.ts` is deleted. The desktop's `suspensionsOf` maps the
      solver's `suspensions` over `sessionFacts`; `vngen status` counts them over
      `waveFacts`. Suspension reads neither the task log nor the config, so both answers
      are the ones the wrapper gave.
    - `@vn/pipeline`'s `drift.ts` is deleted. The planner, the document tree,
      `driftedFrames` and Shot Coverage import `driftOf` and `proseHash` from
      `@vn/stills`.
    - `@vn/artgen`'s `base.ts` is deleted, and `planner.ts` no longer re-exports
      `baseRefusal`. Adoption, concept art, promotion, upload and the desktop's asset part
      import it from the solver.
    - The CLI and the scheduler may import neither the solver nor `@vn/stills`, so
      `@vn/pipeline`'s barrel re-exports `baseRefusal`, `suspensions`, `Suspension`,
      `stillsFamily`, `unapprovedTakes` and `UnapprovedTake` by name.
- **Export takes its list from the host** (`c3feaff0`). `unapprovedTakes` moved to
  `@vn/stills`' `unapproved.ts` unchanged, except that it takes manifest rows rather than
  the store, and it still walks every scene. `@vn/export` keeps `unapprovedSentence`,
  which takes the list. The desktop imports `unapprovedTakes` from `@vn/stills`;
  `vngen export` reaches it through `@vn/pipeline`. No import edge was added to
  `@vn/export`.
- **The oracle is deleted, in two commits.**
    - `cd2a5c9b` records what the oracle planned on master (`5bc32739`) in
      `packages/pipeline/src/tests/__fixtures__/waves/`: `fixtures.json` for the nine
      fixture cases, and one file per testkit script with its `before`, `after` and
      `drawn` runs. The recording was made twice on an untouched master checkout with
      identical output. In that commit `plannerwaves.test.ts` held both the planner and
      the oracle equal to the recording at every point.
    - `c4f17b4a` deletes `oracle.ts` and the oracle's half of each comparison.
      `oracle.test.ts` became `plannerpins.test.ts`: the pinned hashes and the "reaches
      what each fixture is named for" case are unchanged, and the six wave cases compare
      the planner with the recording, deps stripped.
    - No pinned hash or recorded wave moved, and `prompthash.test.ts` is untouched.
- **The index is sharded** (`f69279f3`).
    - `packages/contracts/contracts.json` holds the summaries (id, rule, subjects) and
      `bySubject`, 49 KB. `packages/contracts/contracts/<area>.json` holds the full
      records, one file per area in `CONTRACT_AREAS`, empty ones included: `script` 21 KB,
      `prompts` 13, `takes` 9, `graphs` 8, `identity` and `storage` 6 each, `collect` and
      `planning` 5 each, `providers` 4, `gate` 3, `log` 2, and `execution` empty.
    - `pnpm gen:contracts` writes the thirteen files through `splitIndex` and warns when
      the summary file passes 100 KB.
    - `@vn/contracts/query` imports the summary file and every shard and rebuilds the full
      index with `joinIndex`. Text search reads `prevents` and `detail`, so every host
      loads every shard; a model reading files reads the summary file and one shard.
    - The regeneration test compares all thirteen files, and checks that the joined index
      equals the unsplit one. Twelve `pnpm contracts` queries printed the same bytes
      before and after the split.
- **Decisions.**
    - **`driftOf` stays the reader of prose drift in three places.** The document tree's
      Stale branch, the approval queue's `driftedFrames` and Shot Coverage walk every
      scene, unreachable ones included, and key a frame by `shot.image`. Shot Coverage
      also shows `unknown` and `unrendered`. `SlotState.drift` covers the shot slots of
      live scenes only and reports `drifted` alone, so reading it would drop rows from all
      three.
    - **`graphDrift` stays behind `reportGraphs`' `drifted` list and `boundSlotsToDraw`.**
      `graphDrift` reports the edited arm only, over every output node, active or not,
      with an empty slot for an inactive one. `boundDrift` reports per bound slot, and
      also reports a slot drawn before its graph existed when the graph is not the default
      one. Moving either would change what `vngen status` prints and which slots
      `vngen cost` prices.
    - **`unapprovedTakes` keeps its own walk** rather than reading the solver's slots,
      because the playable carries every scene and the solver enumerates live ones.
- **Behaviour visible to hosts.**
    - `graphRunPlan` resolves its slot over the manifest, as the planner does. Before, it
      resolved without the manifest, so the approved portrait a sheet or a shot references
      was the hash the character sheet names, and a staging-sheet shot's sheet key was
      computed over no rows. The portrait answers differ only when the sheet's mirror
      disagrees with the accepted row, which `AssetStore.accept` and `catchUpMirrors`
      prevent. `graphRunPlan`'s seeds now match the planner's task inputs in both cases.
    - Nothing else. The panes, `vngen status`, the scheduler, the agent tools and the
      collector read the same answers. No control's offer changed: `ux-model.json` equals
      a regeneration, and no editor under `renderer/pathux/editors/` changed. The
      `story.export` command's notes name `@vn/stills`, and `pnpm gen:command-table` was
      run for it.
    - `vngen cost` still prices from `boundSlotsToDraw`, which misses the slots
      `boundDrift`'s second arm adds, so its total can be lower than what `requeueDrifted`
      redraws. That predates 6e.
- **Contracts.** None added; the index holds 44.
    - `takes.approvedMeansAccepted` names `SlotState` in place of `SlotNode`.
    - `takes.suspensionDerived` drops `@vn/artgen`'s `suspend.ts`.
    - `storage.baseUnavailable` names `adoptslot.ts` in place of `base.ts`.
    - `script.proseDriftReported` names the desktop's `session/story.ts` in place of
      `@vn/pipeline`'s `drift.ts`, and its detail says which readers call `driftOf`.
    - `takes.currencyExclusive`'s detail says `unapprovedTakes` is in `@vn/stills` and the
      host hands its list to `unapprovedSentence`.
    - Every contract keeps a pinning test; the coverage test passes.
- **Planner timing.** The planner's code path did not change: it imports `proseHash` from
  `@vn/stills` and builds its facts as before. No timing was taken.
- **Tests rewritten**, by tests and assertions:
    - `slotgraph.test.ts` lost its `slotGraph` case (1, 7); `slotnodes.test.ts` holds it
      against `slotNodes` (1, 7).
    - `suspend.test.ts` calls `suspensions` directly: 6 and 12, before and after.
    - `unapprovedTakes`' cases moved from `playable.test.ts` (3, 7) to
      `unapproved.test.ts` (3, 5) and one `unapprovedSentence` case (1, 2).
    - `plannerwaves.test.ts`: 14 and 38 before; 14 and 62 while it checked the oracle; 14
      and 38 after.
    - `oracle.test.ts` (13, 22) became `plannerpins.test.ts` (13, 22).
    - The index test gained a case for the joined index (one test, three assertions).
- **For 7:**
    - The CLI and the scheduler reach the solver and `@vn/stills` through six re-exports
      in `@vn/pipeline`'s barrel. Stage 7's host registry in `@vn/pipeline` is the place
      to decide whether they stay.
    - `sessionFacts` still carries no `graphs`, so no desktop surface shows graph drift
      from `SlotState.drift`. `reportGraphs` and `boundSlotsToDraw` still read
      `graphDrift`; moving them to `boundDrift` changes what `vngen status` and
      `vngen cost` report, and needs its own decision.
    - The desktop solves once per read (the tree, `approvable`, `approvedAssets`, the Task
      Graph pane, `suspensionsOf`), each over fresh `sessionFacts`. Nothing has measured
      whether a shared solve per session snapshot is worth it.
    - Every host loads every contract shard, because text search reads the full records.
      If the index grows, `search` could read the shards lazily.
    - Stage 8 can still give `requeueDrifted` its own declaration (from 6d's list).
    - `.claude/comment-audit-ledger.json` still lists the deleted `base.ts` and
      `pipeline/src/drift.ts`.

The plan as written before 6a landed:

The core of the plan. It runs as five commits, each green.

- **6a. Types and the generic loop.** Create `@vn/constraint-solver` with the interfaces
  above and a `solve` that does what `buildSlotGraph` does, but from the family. Implement
  the four stills slot kinds in `@vn/stills` by wrapping the existing `slotKey`,
  `refsOfSlot`, `resolveSlot` and `slotTaskHash` branches. A test asserts
  `solve(stills, facts)` equals `buildSlotGraph(ctx)` node for node over every testkit
  script and the stage 1 fixtures. `buildSlotGraph` is kept.
- **6b. The planner reads the solver.** `planTasks` runs the decomposer for owed units and
  adds the ready slots' tasks. A test asserts that the planner and the stage 1 oracle emit
  the same task hashes, wave by wave, over every fixture. Only then is the P2 to P7
  enumeration in `planner.ts` deleted, together with `buildSlotGraph` and
  `slotagreement.test.ts`. Tests that compare against `buildSlotGraph`, including stage
  0's staging-sheet test, are rewritten against `solve` in the same commit, so the
  contracts they pin keep a pinning test. Record planning time per wave on the largest
  testkit project and on `examples/mySampleRepo` before and after; if it is more than
  twice as slow, memoise per slot on the facts it reads before landing.
- **6c. The gate.** The gate becomes the generic unit rule, with stills' `gates` listing
  the portraits of `scene.characters`. `gateStatus` reads solver state, and its own scene
  walk is deleted. It keeps its `(model, assets)` signature for its two callers outside
  the solver's reach, the CLI (`apps/cli/src/commands.ts:327`) and the scheduler
  (`scheduler.ts:391`): `@vn/pipeline`'s re-export builds the facts and solves. Add a test
  where a scene's non-subject character is unapproved, which must keep both decomposition
  and the scene's shots unplanned. `usedOutfits` is computed once, inside the stills
  enumeration. `sheetSeeds` keeps its three callers (the planner, the scheduled runner,
  `gengraph.run`), but each now calls it with facts from its host's one builder, and a
  test asserts the three answers match for a sheet group.
- **6d. The remaining derivation rules.** Move into `@vn/constraint-solver` as generic
  rules: the take (the take-choosing functions stage 2 put in `@vn/stills`, and
  `overheld.ts`), suspension (`@vn/artgen`'s `suspend.ts` and `@vn/stills`'
  `upstream.ts`), the keep set, the base-root refusal (`base.ts`), and graph drift (from
  `BoundGraphFact`). Prose drift stays a stills rule that reports through
  `SlotState.drift`. Each generic file is rewritten against `SlotState` instead of
  `RefBinding`.
- **6e. Every reader uses the solver.** The document tree, the gate pane,
  `validateProject` and the agent's tools read one `solve` result. The collector reads the
  keep set, which stays as wide as `keptSlots` is today
  (`packages/artgen/src/collect.ts:66` before stage 2 moves it). Export's unapproved check
  takes the list as a parameter from its host, and keeps walking every scene, as
  `unapprovedTakes` (`packages/export/src/unapproved.ts:29`) does now. The stage 1 oracle
  is deleted.
- **Proof that the solver is family-neutral.** Its own tests define a toy family with two
  made-up slot kinds and a unit gate, and run every rule over it.

### Stage 7: the executor reads the slot kinds

**7 landed 2026-11-20 on the `executor` branch, as `c5af638c`, `ba6d2d7f`, `9f210ad0` and
`7b46e6d4` and the commit that adds this note.** As built:

- **The executor registry** (`c5af638c`).
    - `@vn/pipeline`'s `executors.ts` holds `EXECUTORS`, keyed by task kind. Each entry is
      an `Executor<K>`: `runner(config)`, which builds the kind's runner, and
      `cost(config)`, which answers its most image and review calls (`Calls`). A shot is
      `max_refine_attempts` image calls, each read by every reviewer; the other three
      kinds are one image call.
    - `createRunners` builds a `Map` of runners from the registry, and `costPreview` reads
      each pending task's line through `costOf`. Neither names a kind.
    - `runTask` moved from `runners.ts` into `executors.ts`. A kind with no runner gets
      the runner that fails the task with the same sentence as before:
      `no runner for task kind "<kind>" (<hash>)`. The four runners are now exported from
      `runners.ts` so the registry can name them.
    - The registry is in the host, not on `SlotKind`, because a runner reaches providers
      and generation graphs, which the solver and `@vn/stills` may not import.
- **`TaskKind` is opened** (`ba6d2d7f`).
    - `TaskKind` is `keyof TaskInputs`, and `TaskInputs` holds the input shapes of the
      four kinds the stills family declares. No kind name or input shape changed, so no
      hash moved: `prompthash.test.ts` is untouched, and `plannerpins.test.ts`,
      `plannerwaves.test.ts` and the recorded waves pass unchanged.
    - `EXECUTORS` is typed `{ readonly [K in TaskKind]: Executor<K> }`, so a declared kind
      with no executor does not compile.
    - `outfit_sheet`, `vision_review` and `prompt_refine` are now `RetiredTaskKind` in
      `@vn/types` and have no executor.
    - The contract index reads the task kinds a `task:` subject may name from the stills
      family's slot kinds instead of from a hand-written list.
- **`workflow:` and `Phase`** (`9f210ad0`).
    - `WORKFLOWS` (`['vn']`) and `Workflow` sit in `@vn/types`' `schemas.ts`, and
      `projectConfig` gains `workflow: z.enum(WORKFLOWS).default('vn')`. This follows the
      stage 5 pattern for `narrative:`: the schema in `@vn/types`, loaded by
      `@vn/config`'s `loadConfig`, documented in `docs/guides/cli.md`.
    - An unknown name is refused by `loadConfig` as
      `invalid project.yaml: workflow: Invalid enum value. Expected 'vn', received 'manga'`.
      That message names the key and the known workflows. A `project.yaml` without the key
      parses to `vn`.
    - `@vn/pipeline`'s `familyOf` (`workflows.ts`) maps each workflow to its family. It is
      typed over every `Workflow`, so a name with no family does not compile; `vn` maps to
      `stillsFamily`.
    - The planner, `boundSlotsToDraw`/`unrenderedBoundSlots` and `vngen status`'s
      suspension count reach the family through `familyOf(config.workflow)`. For every
      project today they get the same family as before.
    - `Phase` is deleted from `packages/types/src/model.ts`, together with `RunContext`,
      which only `Phase` named. Nothing implemented or imported either.
- **The cost fix** (`7b46e6d4`; approved by the user before the stage).
    - `boundSlotsToDraw` solves once over the task graph the dry run has just planned. It
      prices every bound slot that is unrendered, planned or not, or whose task is
      `pending`.
    - The dry run's own requeues are what leave a drawn task at `pending`:
      `requeueDrifted` (through `driftedTasks`, `graphFacts` and `boundDrift`, for both
      arms of drift), `requeueFailed` and `requeueAbandoned`. So the estimate reads the
      run's decision rather than repeating any comparison, and `graphDrift` is no longer
      read by the cost.
    - `RunSummary.redrawn` and "slots to draw" now agree.
    - Calling `driftedTasks` again after the dry run would not work: the dry run has
      already put those tasks back to `pending` in memory, and the planned set it bounds
      the requeue by is not in `RunSummary`.
- **Decisions.**
    - **`TaskKind` is opened at compile time, by interface augmentation.** A family in
      another package declares its kinds by augmenting `TaskInputs`
      (`declare module '@vn/types'`), which widens `TaskKind`. The registry's mapped type
      then fails until those kinds have executors. A runtime string registry would make
      `Task<K>`, `taskHash`, `makeTask`, `TaskGraph.add`, `SlotKind` and every
      `TaskInputs[K]` lookup untyped. The workflows note asks for this choice ("Keep it
      typed… workflows can be compiled-in modules").
    - **The stills family's kinds stay declared in `@vn/types`.** `@vn/taskgraph`,
      `@vn/artgen`, the desktop and the solver's tests name them, and none of them can
      import `@vn/stills`.
    - **Augmentation applies to the whole program.** The solver's toy family therefore
      cannot declare kinds of its own without adding them to `TaskKind` everywhere. It
      borrows `portrait` and `location_ref` (`SEED_TASK`, `SPROUT_TASK`), with the same
      assertions as before. The solver does nothing with a task kind but hash it and
      report it.
    - **A record of a retired kind keeps every answer it had.** A record of a retired kind
      in an older `tasks.jsonl` still loads, because `loadGraph` does not validate by
      kind. Running one fails with the old sentence. Such a record keeps these answers:
        - `costPreview` prices a pending `outfit_sheet` record at one image call
          (`RETIRED_COST`) and the other two at none, as before.
        - `slotOfTask` still files `outfit_sheet` under its sheet slot.
        - The desktop's `IMAGE_KINDS` (the count a style change re-keys) still counts it.
        - `validateProject` still skips `vision_review` and `prompt_refine` records.
        - The Task Graph pane's `subjectOf` still reads a `vision_review` record's
          `target`.
    - **`byKind` holds a retired kind only when a pending record has one.** The registered
      kinds start at zero in the old order. Every reader prints only non-zero entries (the
      CLI's preview, the desktop's `pipeline.run` check note), so no output changes. A
      pending `outfit_sheet` would print after `shot_image` rather than before it. Nothing
      in this repository has ever written a record of a retired kind (`git log -G` over
      every branch finds only test fixtures).
    - **`AssetKind` is untouched.** `outfit_sheet` is still an `AssetKind` and a manifest
      row kind; `refs.ts`, `refcycle.ts`, `resolve.ts`, `takes.ts`, `artnotes.ts`, the
      store's kind list and the desktop's labels read it as before.
    - **Five of the six barrel re-exports stay.** `stillsFamily` is no longer re-exported:
      the CLI reaches the family through `familyOf`. `baseRefusal`, `suspensions`,
      `Suspension`, `unapprovedTakes` and `UnapprovedTake` stay. They are derivation
      answers rather than executor concerns, and the CLI and the scheduler still may
      import neither the solver nor `@vn/stills`.
    - **`vngen status` is unchanged.** Its `drifted` list is still `graphDrift` through
      `reportGraphs`: the edited arm only, per output node (an inactive one with an empty
      slot), whatever the slot's task. Status and cost now answer different questions.
        - Status names every output whose graph was edited since it last ran.
        - Cost prices what the next run draws.
        - So status can list a drifted output that cost does not price, and cost can price
          a slot that status does not list. The status line's "the next run redraws it"
          was already not always true, and is left as it was.
- **Behaviour visible to hosts.**
    - **`vngen cost` and `vngen run --mock`.** Only "slots to draw" and "estimated"
      change, and only for a project that binds a generation graph to a slot that holds a
      picture.
        - Priced now and not before: a drawn slot bound to a non-default graph that has
          never drawn it (boundDrift's second arm), and a drawn bound slot whose task is
          `pending` for any other reason. That covers a retry the run will make, an
          interrupted task, and a task requeued by approve or regenerate. Before, such a
          task was counted under "drawn by a graph (counted by the graph estimate below)",
          but the estimate below did not price it.
        - Priced before and not now: a drawn slot whose edited graph `graphDrift` reports
          but whose task the run will not redraw. That covers a task failed past its
          attempt budget, one not in the current plan, and one not yet planned.
        - A refused or stopped dry run requeues nothing, so it prices only unrendered and
          already-pending slots.
    - **The desktop** shows no graph cost from `boundSlotsToDraw`, so nothing it shows
      changes. No command or control changed. `ux-model.json` equals a regeneration (the
      task-list situation keeps its `prompt_refine` card, cast), and no editor under
      `renderer/pathux/editors/` changed.
    - Nothing else: the hashes, the plans, the runs, the refusals and the status output
      are as they were.
- **Contracts.** None added; the index holds 44.
    - `graphs.editInvalidates` gains the subject
      `function:packages/pipeline/src/graphload.ts#boundSlotsToDraw`. Its `detail` now
      says the cost prices from the dry run's requeue and that `vngen status` lists
      `graphDrift`'s edited arm alone.
    - `planning.incremental`'s `vngen cost` sentence is about task counts, which did not
      change, and was left as it was.
    - Every contract keeps a pinning test.
- **Tests rewritten**, by tests and assertions, before and after:
    - `solve.test.ts` 19 and 58, `keep.test.ts` 4 and 7, `take.test.ts` 12 and 23: the
      same, with the toy family's task kinds swapped.
    - `taskgraph.test.ts` 8 and 15: the same. The top-level model-id case keeps its
      `prompt_refine` inputs through a cast.
    - The renderer's `taskGraph.test.ts` 48 and 89: the same. The review case is now about
      a record of a retired kind, cast.
    - New or grown: `executors.test.ts` 0 → 4 tests and 10 assertions; the CLI's
      `commands.test.ts` 29 and 123 → 31 and 129 (the two cost cases); `schemas.test.ts`
      15 and 27 → 17 and 29; `config.test.ts` 68 and 132 → 70 and 134.
    - The whole suite went from 419 suites and 5889 tests to 420 and 5899.
- `.claude/comment-audit-ledger.json` no longer lists the deleted `base.ts` and
  `pipeline/src/drift.ts`.
- **For 8:**
    - The retired kinds' remaining answers (`RETIRED_COST`, `slotOfTask`'s `outfit_sheet`
      case, `IMAGE_KINDS`, `validateProject`'s skip, `subjectOf`'s `target`) can be
      deleted once a decision says a record of one no longer needs the answer it had.
    - `slotOfTask`'s `bindingOf` still switches on kind names. The workflows note's step 3
      lists "the slot switch" with the registry, but `SlotKind` has no inverse from task
      inputs to a binding.
    - The desktop still names `stillsFamily` directly rather than
      `familyOf(config.workflow)`.
    - `familyOf` answers `Family<StillsFacts>`; a workflow whose family has different
      facts needs that type widened.
    - Stage 8 can give `requeueDrifted` its own declaration, which would carry the
      cost-reads-the-requeue sentence now in `graphs.editInvalidates`' detail.
    - Unchanged from 6e: one solve per desktop read rather than a shared solve per
      snapshot, and every host loading every contract shard.

The plan as written before it landed: the workflows note's step 3, in solver terms.

- Add the host-side registry in `@vn/pipeline`, keyed by task kind, with the runner and
  the cost line. `createRunners` and `costPreview` read it instead of switching on names.
- Open `TaskKind` from the closed union to the kinds the registered families declare. The
  three placeholder kinds (`outfit_sheet`, `vision_review`, `prompt_refine`) have no
  planner path and are dropped from the registry; a record of one in an existing log still
  loads, and fails with the current "no runner for task kind" message if run.
- Delete the unused `Phase` interface in `packages/types/src/model.ts`.
- Add `workflow:` to `project.yaml`, defaulting to `vn`, with a lookup from workflow to
  family. `vn` is the only workflow this plan registers.

### Stage 8: execution contracts

**8 landed 2026-11-20 on the `execution` branch, as `d292c397`, `d715d6f2`, `8d495764`,
`3c3ae19d` and the commit that adds this note.** As built:

- **Fourteen contracts added**; the index holds 58. Each is listed with the file that
  declares it and the test that pins it.
    - Row 24, "Content-addressed task graph" (`d292c397`):
        - `identity.taskHash`, `packages/taskgraph/src/hash.ts`, pinned by
          `taskgraph.test.ts`.
        - `log.lastWriterWins`, `packages/taskgraph/src/log.ts`, pinned by
          `resume.test.ts`.
        - `log.tombstoneRemoves`, `packages/taskgraph/src/log.ts`, pinned by
          `tombstone.test.ts`.
        - `execution.targetClosure`, `packages/scheduler/src/scheduler.ts`, pinned by
          `scheduler.test.ts`.
    - Row 303, "A terminal task records why, is retried once" (`d715d6f2`):
        - `execution.failureRecorded`, `scheduler.ts`, pinned by `scheduler.test.ts`.
        - `execution.retryBudget`, on `requeueFailed` in `scheduler.ts`, pinned by
          `scheduler.test.ts`.
        - `execution.abandonedReleased`, on `requeueAbandoned` in `scheduler.ts`, pinned
          by `scheduler.test.ts` and `stopping.test.ts`.
        - `execution.reportFromPlan`, `scheduler.ts`, pinned by the pipeline's
          `rerender.test.ts`.
        - `execution.stopAtRequest`, `scheduler.ts`, pinned by `stopping.test.ts`.
        - `execution.resumeFromJournal`, on `TaskRequests` in
          `packages/pipeline/src/requests.ts`, pinned by the pipeline's
          `requests.test.ts`.
        - `execution.taskLogDiagnostic`, on `TaskLogFile` in
          `packages/pipeline/src/tasklog.ts`, pinned by the scheduler's `tasklog.test.ts`.
        - `providers.transientRetry`, on `callWithRetry` in
          `packages/providers/src/backends/transient.ts`, pinned by `transient.test.ts`.
    - Row 692, the executor half (`8d495764`): `execution.redrawDrifted`, on
      `requeueDrifted` in `scheduler.ts`, pinned by the pipeline's `graphdrift.test.ts`.
    - Row 866, "P7 generate→critique→refine" (`8d495764`): `execution.refineLoop`, on
      `makeShotRunner` in `packages/pipeline/src/runners.ts`, pinned by
      `scheduler.test.ts`.
- **`prompthash.test.ts` is the hash guard, not the pin.** It is byte-identical and its
  baseline was not regenerated. `identity.taskHash` is pinned by `taskgraph.test.ts`,
  whose content-addressing block checks `taskHash` and `TaskGraph.add` directly.
  `plannerwaves.test.ts`, `plannerpins.test.ts` and
  `packages/pipeline/src/tests/__fixtures__/waves/` are unchanged.
- **Why two bullets became twelve contracts.** Each bold rule of the terminal-task bullet,
  and each sub-bullet of the task-graph bullet that states its own rule (tombstones,
  `RunOptions.only`, the replayed log), is one checkable statement, and the 280-character
  caps leave room for one statement per contract.
    - Every fact of the removed bullets and their sub-bullets is in a `rule`, `prevents`
      or `detail`. The defect story that opened the terminal-task bullet is in
      `execution.failureRecorded`'s detail.
    - No moved sub-bullet only said that two code paths agree, so none was dropped.
    - Two statements were corrected against the code. `TaskGraph.add` gives newer inputs
      to a `failed` node as well as a `pending` one, where the bullet said "a node that
      has not run yet"; `taskgraph.test.ts` gained a case for it. The task log's "nothing
      deletes a log" is kept for the file, and the detail adds that a file past
      `TASKLOG_MAX_BYTES` drops its oldest other execution.
- **What moved out of `graphs.editInvalidates`** into `execution.redrawDrifted`:
    - `requeueDrifted`'s requeue, once per run before the wave loop, and
      `RunSummary.redrawn`.
    - The journal write that clears the drift, including a redraw resumed from a cached
      answer, the empty `{varC}` example, and the first `done` record a newly bound graph
      writes.
    - A failed redraw being left to `requeueFailed`, and the requeue happening at run time
      because undo excludes `vngen/state/`.
    - `vngen cost` pricing a redraw from the dry run's requeue (`boundSlotsToDraw`).
    - The `requeueDrifted` and `boundSlotsToDraw` subjects.
    - `graphs.editInvalidates` keeps the drift rule, `vngen status`'s edited arm, the
      default-graph comparison and `authoredHashes`. Its rule's last sentence now names
      `execution.redrawDrifted`, and its detail ends by pointing there.
- **Where the declarations sit.**
    - `@vn/scheduler` gained `src/contracts.ts` and a dependency on `@vn/contracts`; the
      lintrix allow-list already had it. `pnpm-lock.yaml` was edited by hand for the new
      link, and `pnpm install --frozen-lockfile` accepted it.
    - Each declaration sits above the function it is on.
    - Two pipeline tests now import a contract from `@vn/scheduler` (`rerender.test.ts`,
      `graphdrift.test.ts`). Test files are outside `vn/element-types`, and both tests
      already ran the scheduler through the testkit.
- **Bullets removed.** The three bullets above, which empties the "Identity and storage",
  "Scheduling" and "Generation and review" sections; their TOC entries were removed by
  hand.
- **Docs retargeted.** No doc linked a removed anchor. `desktop-app-editors-pipeline.md`
  names `execution.taskLogDiagnostic` for the task log file; `gen-graphs.md` names
  `execution.redrawDrifted` beside `graphs.editInvalidates`; `module-map.md`'s
  `p5.ts`/`p6.ts` row describes the modules; `docs/index.md`'s row describes what the page
  still holds.
- **The retired task kinds keep their remaining answers** (decided before this stage):
  `RETIRED_COST`, `slotOfTask`'s `outfit_sheet` case, `IMAGE_KINDS`, `validateProject`'s
  skip and `subjectOf`'s `target` stay until the legacy runners are retired in their own
  plan (decision 7).
- **The desktop looks its family up through `familyOf(project.config.workflow)`**
  (`3c3ae19d`), at the five call sites in `session/core.ts`, `docs.ts`, `gate.ts` and
  `pipeline.ts`, which named `stillsFamily`. `familyOf('vn')` is `stillsFamily`, so
  nothing a host shows changed. The desktop's tests still solve `stillsFamily` directly.
- **Tests touched**, by tests and `expect` calls in the source, before and after:
    - `taskgraph.test.ts` 8 and 15 → 10 and 17 (the kind case and the `failed` case).
    - Wrapped or retitled, unchanged in count: `resume.test.ts` 1 and 4,
      `tombstone.test.ts` 7 and 15, `scheduler.test.ts` 15 and 71, `stopping.test.ts` 9
      and 49, the scheduler's `tasklog.test.ts` 2 and 10, `rerender.test.ts` 3 and 14,
      `graphdrift.test.ts` 8 and 25, the pipeline's `requests.test.ts` 1 and 5,
      `transient.test.ts` 21 and 55.
    - No assertion was changed or removed.
    - The whole suite went from 420 suites and 5899 tests to 420 and 5901.
- **What is left on the page: one bullet.** "A storyboard is single frames or manga pages,
  and a page's panels carry their own cast and lines", with its four sub-bullets
  (`shot_form`, the page shape and lettering, bubbles, `shotData.panelBoxes`).
    - Stage 4 split it off the storyboard bullet and left it on the page ("Page and bubble
      rules stay on the page"), and no stage was assigned it.
    - It has no single obvious home. Its rules live in `@vn/stills` (`decompSystem`,
      `buildPageChunks`, `letteredPagesNote`), `@vn/store` (`readShots`' refusals),
      `@vn/scriptedit` (`setBubbles`, `setPanels`), `@vn/pipeline` (`layoutReport`), the
      exporter and the desktop's `project.setShotForm`. It was left in place for a
      decision. Stage 9 cannot delete the page until it has moved.
- **For 9:**
    - Move the page bullet above, or decide where it goes.
    - Retarget the Markdown links `pnpm check:doclinks` will flag once the page is gone:
      `CLAUDE.md`, `docs/index.md` (two rows), `docs/guides/cli.md`,
      `docs/history/vn-generator-report.md`, this plan,
      `creating-shots-by-hand-and-by-agent.md`, `manga-style.md`, and the research notes
      `pipeline-contracts-into-code.md`, `codebase-migration-for-new-requirements.md`,
      `comparable-systems.md`, `manga-shot-composition.md`, `storylet-path-summaries.md`
      and `storylet-solver.md`.
    - Retarget the plain-text mentions a repo-wide search for `pipeline-contracts` finds:
      `.commentlintrc.json`, `.claude/skills/archive-plans/SKILL.md`,
      `scripts/prosestyle/fixtures/violations.txt`, `docs/plans/index.md`, the active
      plans `node-based-asset-generation.md`, `openrouter-as-a-fallback-transport.md` and
      `task-pane-logs.md`, the research notes `deleting-things.md`,
      `slots-as-asset-history.md` and `story-format-rules-and-a-scene-lint.md`, and six
      archived plans under `docs/plans/archive/`.
    - `CLAUDE.md`'s "Core ideas" paragraph (the stage 9 rewrite), and its gen-graphs
      sentence "the contracts doc keeps only their three invariants", which is already out
      of date: those invariants are contracts now.
    - Unchanged from stage 7: `slotOfTask`'s `bindingOf` switch, `familyOf`'s
      `Family<StillsFacts>` type, one solve per desktop read, and every host loading every
      contract shard.

The plan as written before it landed:

- Move the remaining execution bullets to contract declarations in `@vn/scheduler`,
  `@vn/pipeline` and `@vn/taskgraph`, per the disposition table.

### Stage 9: delete the document

**9 landed 2026-11-21 on the `retire-doc` branch, as `1123c379`, `cd85f7c9`, `7692dbdc`,
the commit that adds this note, and the commit after it that archives this plan.** As
built:

- **The last bullet became one contract, `prompts.pagePanels`** (`1123c379`), by the
  author's decision of one contract rather than one per sub-bullet. The index holds 59.
    - It is declared in `packages/stills/src/prompts.ts`, above `buildPageChunks`, and
      pinned by `page.test.ts`, whose page-prompt block is wrapped in
      `describe(pins(promptsPagePanels), …)`.
    - The area is `prompts`: the rule is about what reaches the decomposer's prompt and a
      page's prompt and hash, and what stays out of both (bubbles).
    - `rule` and `prevents` state the two halves in one sentence each, and `detail`
      carries the four sub-bullets (`shot_form`, the page shape and lettering, bubbles,
      `shotData.panelBoxes`).
    - The subjects reach seven packages and both hosts: `decompSystem` and `MAX_PANELS`,
      `buildShotChunks`, `matchPanels` and `LAYOUT_IOU` in `@vn/stills`; `PagePanel` and
      `PanelBubble` in `@vn/types`; `readShots` in `@vn/store`; `setBubbles`, `setPanels`
      and `letteredPagesNote` in `@vn/scriptedit`; `layoutReport` and the planner module
      in `@vn/pipeline`; `buildPlayable` in `@vn/export`; the commands
      `project.setShotForm`, `story.setPanels` and `story.setBubbles`; the tools
      `propose_storyboard` and `set_panels`; and `task:shot_image`. `buildPageChunks`
      itself is not exported, so the subject is `buildShotChunks`, which calls it.
    - `set_bubbles` is named as
      `function:packages/authoring/src/tools/storyboard.ts#setBubblesTool` rather than
      `tool:set_bubbles`, because the generator refused the `tool:` subject: the tool is
      defined and exported but `ALL_TOOLS` does not list it, so the agent's registry does
      not offer it. The detail says so.
- **Five statements were corrected against the code** on the way over:
    - Under `frames`, the decomposer's prompt is not free of the word "panel" when
      storyboard notes are set, because the notes bring the wider answer format and its
      optional `panels?` key. What holds is that `frames` adds no page vocabulary.
    - `readShots` does not report `line_in_no_panel`; it returns the lines in
      `LoadedShots.unpanelled`, and the planner logs the warning.
    - `letteredPagesNote` is in `@vn/scriptedit`, and `matchPanels` and `LAYOUT_IOU` are
      in `@vn/stills`, where the bullet's placement implied `@vn/stills` and
      `@vn/pipeline`.
    - `panelBoxes` is stamped from the matching reviewer's boxes or, when none matched,
      the first reviewer's.
    - It is stamped for a `needs_human` shot's last attempt as well as for a `done`
      output, where the bullet said "the accepted image".
- **The page was deleted** (`cd85f7c9`) and every reference retargeted.
    - `CLAUDE.md`'s "Pipeline contracts" bullet points at `contracts.json` and
      `pnpm contracts <query>`. "Core ideas" says where contracts are declared and
      indexed, restates the instruction as "query the contracts attached to a file,
      command or agent tool before changing it", and names `@vn/constraint-solver`. The
      gen-graphs sentence names the `graphs.*` contracts and `execution.redrawDrifted`.
    - `docs/index.md`'s row for the page became a row for
      `packages/contracts/contracts.json`.
    - A citation of the page as a whole now links `contracts.json`, in `cli.md`,
      `vn-generator-report.md`, `codebase-migration-for-new-requirements.md` and
      `comparable-systems.md`. A citation of one bullet names its contract id, as in
      `deleting-things.md` (`identity.taskHash`, `execution.retryBudget`,
      `execution.reportFromPlan`, `script.entityByTag`), `slots-as-asset-history.md`
      (`takes.suspensionDerived`, `takes.currencyExclusive`, `log.doneWriters`) and the
      storylet notes (`script.lineIdsAllocated`, `identity.taskHash`).
    - The active plans' mentions name the contract or the index: `manga-style.md`
      (`prompts.pagePanels`), `task-pane-logs.md`,
      `openrouter-as-a-fallback-transport.md`, `node-based-asset-generation.md` and
      `creating-shots-by-hand-and-by-agent.md`.
    - `pipeline-contracts-into-code.md` and `workflows-and-narrative-engines.md` gained
      status lines pointing at this plan. The other research notes only cited the page,
      and their status lines are about their own subjects, so they were left as they were.
    - This plan's own mentions of the page are kept, since they are the record of what it
      set out to delete; its opening link now points at `contracts.json`.
- **The three non-Markdown mentions**, each changed to keep its purpose:
    - `.commentlintrc.json` listed the page in `markdownFiles`, the whitelist of Markdown
      files commentlint reads as prose. The entry was removed. The prose now lives in
      contract strings, which commentlint does not read.
    - `.claude/skills/archive-plans/SKILL.md` cited "the pipeline-contracts pattern in
      `CLAUDE.md`" as the way a reference cites the plan behind a rule. It now names a
      contract's `see` field.
    - `scripts/prosestyle/fixtures/violations.txt`'s `backtick-01` needs a backticked
      documentation path to violate `backticks-non-code`. It now names
      `docs/reference/story-bible.md`, a page that exists. No grader checks the rule
      mechanically, and `fixtures.test.ts` passed unchanged.
- **Archived plans were left alone.** Six of them mention the page, all in plain text, as
  records of what they changed at the time; none links it, so nothing broke.
- **`packages.md` and the module map** (`7692dbdc`). `packages.md` already covered
  `@vn/constraint-solver` in its layering section and its table, and gained
  `@vn/contracts` in both. `module-map.md` had no stale mention, and gained a
  `@vn/contracts` section under layer 0.
- **Tests touched:** `page.test.ts` 8 tests and their `expect` calls, unchanged in count;
  one block wrapped. No assertion was changed or removed.
- **Left over:**
    - `set_bubbles` is missing from `ALL_TOOLS`, so the authoring agent cannot place
      bubbles, though `context.ts` and the `full-production` skill tell it to. Registering
      it changes the agent's tool catalog, so it was not done here.
    - `packages.md`'s "Four leaves share that same constrained allow-list" and
      `docs/index.md`'s summary of `packages.md` predate `@vn/gengraph` and
      `@vn/agentreport`; `CLAUDE.md` counts six.
    - `plannerwaves.test.ts` and `plannerpins.test.ts` cite this plan by its path before
      archiving. They are held byte-identical, so their doc comments were not updated.
    - Unchanged from stage 8: `slotOfTask`'s `bindingOf` switch, `familyOf`'s
      `Family<StillsFacts>` type, one solve per desktop read, every host loading every
      contract shard, and the retired task kinds' remaining answers (decision 7).

The plan as written before it landed:

- Runs only when the document has no contract bullets left; every earlier stage deleted
  its own.
- Delete `docs/reference/pipeline-contracts.md`.
- Retarget every remaining reference. `pnpm check:doclinks` finds the Markdown links; a
  repo-wide search for the file name finds the rest, which include `.commentlintrc.json`,
  `.claude/skills/archive-plans/SKILL.md` and
  `scripts/prosestyle/fixtures/violations.txt`.
- `CLAUDE.md`'s "Core ideas" paragraph becomes a pointer to `@vn/constraint-solver`,
  `packages/contracts/contracts.json` and `pnpm contracts <query>`. The instruction it
  gives today ("read the linked doc in full before changing the invariant it names") is
  restated as: query the contracts attached to a file or command before changing it.
  `docs/reference/packages.md` gains `@vn/constraint-solver` and `@vn/contracts`.
- Update the research notes' status lines to point at this plan.

## Contract disposition

One row per top-level bullet of the document, in its order, with the line it starts on
today. Every row also becomes a declaration; the last column says how the rule is
enforced.

| Line | Contract                                                        | Stage  | Form after the move                                                                                                 |
| ---- | --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| 24   | Content-addressed task graph                                    | 8      | Declared in `@vn/taskgraph`; `prompthash.test.ts`                                                                   |
| 65   | Assets content-addressed, two roots                             | 3      | Refused at the write in `@vn/store`                                                                                 |
| 76   | A base root without a manifest is `unavailable`; the run stops  | 6d     | Solver project-level refusal                                                                                        |
| 83   | A concept never gets a node                                     | 3      | `@vn/artgen` concept declaration and test                                                                           |
| 93   | `done` written by three callers                                 | 1      | Import rule on `@vn/taskgraph/write`, restated                                                                      |
| 115  | The collector removes what nothing uses                         | 6d, 6e | Solver keep set; apply order is its own declaration in the collector                                                |
| 162  | The gate blocks shot planning, reads the manifest row           | 6c     | Solver unit gate                                                                                                    |
| 189  | Incremental planning                                            | 6b     | Solver `ready`; the planner keeps only the per-wave loop                                                            |
| 195  | The graph enumerates slots, not task hashes                     | 6a     | Solver declaration; the toy family test                                                                             |
| 213  | Authoring earns a portrait or plate, not a sheet                | 6a     | Stills enumeration test                                                                                             |
| 227  | `SlotNode.approved` means one thing                             | 6a     | `SlotKind.approved`, one per kind; stills test                                                                      |
| 229  | Currency is exclusive per slot                                  | 6d     | Solver rule (`pick`); the write half stays in `adoptslot`                                                           |
| 287  | A storyboard is fetched only on request; a fallback never saved | 3      | Declared on `decomposeAll` in `@vn/pipeline`'s `decompose.ts`, not `p5.ts`, as built                                |
| 303  | A terminal task records why, is retried once                    | 8      | Executor declarations on `requeueFailed` and `requeueAbandoned`                                                     |
| 391  | An entity is found by its tag                                   | 3      | `@vn/store` declaration (`entities.ts` is there) and test; the id-matches-file half in `@vn/model`, as built        |
| 422  | Each scene occupies one file                                    | 3      | `@vn/model` (`sceneFromDoc`) and two in `@vn/scriptedit` (one load, all-or-nothing edits), as built                 |
| 453  | Shot decompositions are persisted                               | 4, 9   | `@vn/store` declaration; the production map. Page and bubble rules: `prompts.pagePanels` in `@vn/stills`, stage 9   |
| 520  | Reordering a shot means editing the prose                       | 3      | `@vn/scriptedit` declaration and test                                                                               |
| 536  | A character inherits what it wears                              | 3      | `@vn/model` declaration and test                                                                                    |
| 562  | Art direction is authored and appended                          | 3      | The builders' half in `@vn/stills`, the rungs' half in `@vn/artgen`, as built                                       |
| 600  | A prompt is a list of clauses                                   | 4      | Type in `@vn/types` (`PromptChunk`), declared once stage 4 has reorganised `src/`                                   |
| 632  | A reference attaches to a clause                                | 4      | Type in `@vn/types` (`ChunkRef`); its refusals are in the desktop's `applyPromptEdit`, as built                     |
| 643  | Suspension is derived transitively                              | 6d     | Solver rule                                                                                                         |
| 655  | The reference graph is acyclic at write time                    | 3      | Refused at the write (`refCycle`), declared in `@vn/stills`                                                         |
| 661  | Prose edits never invalidate art, so drift is reported          | 6d     | Stills drift rule reporting through `SlotState.drift`                                                               |
| 692  | Editing a gen graph invalidates its slots                       | 6d, 8  | Solver rule from `BoundGraphFact`; executor declaration on `requeueDrifted`                                         |
| 725  | A group node is identified by its key                           | 3      | `@vn/gengraph` declaration and test                                                                                 |
| 743  | A staging sheet is in every member's identity                   | 0, 3   | Stage 0's test; declared in `@vn/stills` in stage 3 and pinned by a test that a member's inputs carry the sheet key |
| 768  | A socket rename needs a migration                               | 3      | `@vn/gengraph` test                                                                                                 |
| 784  | A heading edit invalidates art                                  | 3      | Stills identity test, plus the restaging half in `@vn/scriptedit`, as built                                         |
| 807  | Line ids are allocated and stored                               | 1      | Refused at the write in `@vn/scriptedit`; the first declaration                                                     |
| 826  | The scene round-trip                                            | 3      | `@vn/model` round-trip test, where the serializer and the test are, as built                                        |
| 851  | P5 receives identified lines                                    | 3      | Stills decomposer declaration and test                                                                              |
| 866  | P7 generate→critique→refine                                     | 8      | Executor declaration on the shot runner                                                                             |
| 877  | The reviewer sees only `shotSpec`                               | 3      | `@vn/stills` `shotSpec` declaration and test                                                                        |
| 894  | Deterministic fallbacks                                         | 3      | `@vn/stills` declaration on `storyboard.ts` and test, as built; `@vn/providers` holds only the mocks                |
| 908  | Provider seams                                                  | 3      | `@vn/providers` declaration on `factory.ts` and test; the scheduler half is the lintrix allow-list, as built        |

Sub-bullets move with their bullet. A sub-bullet that only states that two code paths
agree is deleted when the second path is, and the stage's commit message says so.

## Decisions

| #   | Decision                                           | Choice                                                                                                                     |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | How a contract is written in code                  | Decided 2026-11-17: a `contract({...})` value with string fields, not a comment, so models can query it                    |
| 2   | Where the stills family lives                      | Decided 2026-11-17: a new `@vn/stills` package, created in stage 2                                                         |
| 3   | Solver package name                                | Decided 2026-11-17: `@vn/constraint-solver`                                                                                |
| 4   | Where decomposition runs                           | The executor runs the family's decomposer for units the solver says are owed                                               |
| 5   | How the solver sees bound graphs                   | An optional `BoundGraphFact` per slot from `@vn/gengraph`; the solver never sees path.ux                                   |
| 6   | Drift or identity for bound-graph edits            | Deferred to its own plan; this plan keeps drift and moves it into the solver                                               |
| 7   | Legacy runners                                     | Kept; retiring them is its own plan, after this one                                                                        |
| 8   | The gate's shape                                   | A generic rule over units, each gated by a family-listed set of slots                                                      |
| 9   | Retry eligibility                                  | Stays in the executor; it covers records that belong to no slot                                                            |
| 10  | What the solver reads                              | `SolverFacts` only; a family's own facts pass through it unread (`Family<F>`)                                              |
| 11  | `linear` scene order                               | An explicit `scenes:` list in `project.yaml`, never file order                                                             |
| 12  | Workflows, families and styles                     | Decided 2026-11-17: `workflow: vn` by default; a later `manga` workflow shares the stills family                           |
| 13  | Which agents can query contracts                   | Decided 2026-11-17: both the debug agent and the authoring agent, read-only                                                |
| 14  | Where hosts read contracts from                    | The committed `contracts.json`, never the declarations, so every host sees one index                                       |
| 15  | A `contracts.query` palette and CDP command        | Not in this plan; the JSON and `pnpm contracts` cover a Claude Code session                                                |
| 16  | Refusals that cite a contract id                   | Not in this plan; a later change can add an optional `contract` field to a refusal                                         |
| 17  | When the staging-sheet bug is fixed                | Decided 2026-11-17: first, as stage 0                                                                                      |
| 18  | Contract ids                                       | Topic areas in a closed TypeScript union; the const name derived from the id, checked by lintrix                           |
| 19  | Repo and project paths in subjects                 | Separate prefixes: `module:`/`function:` for the repo, `file:` for the project                                             |
| 20  | Index size                                         | Decided 2026-11-17: caps on `rule` and `prevents`, summaries by default, a subject map, a per-call cap; shards past 100 KB |
| 21  | When the debug agent offers `query_contracts`      | Whenever the analyst runs a tool loop; the no-grant single call stays as it is                                             |
| 22  | How the authoring agent finds a refusal's contract | A `tool:` subject prefix naming the agent tool, validated against the tool registry                                        |
| 23  | Contracts declared in the desktop's session code   | `apps/desktop/src/main/contracts.ts`, read by the generator like a package's                                               |
| 24  | A subpath entry that is also a lintrix element     | `vn/element-types` accepts a single file as an element (stage 1)                                                           |
| 25  | `@vn/contracts` in the renderer                    | The main entry carries no JSON; the index and queries are `@vn/contracts/query`                                            |

## Risks and the cost of undoing

- **Task identity.** Every stage keeps kind names and input shapes byte-identical. The
  guards are `prompthash.test.ts`, the stage 1 pinned fixtures (`plannerpins.test.ts`),
  and the oracle's recorded output. The oracle ran beside the planner through 6d; 6e
  recorded what it planned on master, wave by wave, in
  `packages/pipeline/src/tests/__fixtures__/waves/`, checked the recording against it, and
  deleted it. `plannerwaves.test.ts` holds the planner to the recording from then on. A
  stage that moves a planner hash does not land, and re-recording the files is never the
  fix.
- **Planning speed.** The solver runs once per wave over every slot. Stage 6b measures it
  and memoises if needed.
- **The `@vn/stills` move.** It touches every importer of the moved names in one commit,
  and `pnpm check` finds every site. Whole-file moves are reviewed as import diffs, but
  the split files (`takes.ts`, `collect.ts`, `describe.ts`) are code changes and are
  reviewed function by function.
- **The desktop's derived views.** The document tree, gate pane and Task Graph pane read
  the slot graph today. Stage 6e moves them to `solve`. The CDP anchor sweep and
  `gen:uxmodel` need re-running if a control's offer changes, which this plan does not
  intend.
- **Undoing:**
    - Stage 0 is a bug fix and is not undone.
    - Stage 1 reverts on its own only until another contract is declared, because every
      later declaration calls `contract()` from `@vn/contracts`, and stage 8 declares on
      `@vn/taskgraph/write`.
    - Stage 2 reverts on its own until stage 3 declares contracts in `@vn/stills`; after
      that, reverting it also moves those declarations back.
    - Stage 3 reverts on its own at any time: it adds declarations and tests and deletes
      document bullets, and reverting restores the bullets.
    - Stages 4 and 5 revert on their own only until stage 6 starts. After that, reverting
      either means reverting stage 6 first, because the stills facts read the production
      map and `narrative.live`.
    - Inside stage 6, 6a reverts on its own while `buildSlotGraph` and the planner's
      enumeration still exist. 6b is the point of no return. Reverting it means restoring
      about 120 lines of planner enumeration, `buildSlotGraph` and the agreement test. The
      oracle made that a copy rather than a rewrite until 6e deleted it; it is in git
      history at 5bc32739 (`packages/pipeline/src/tests/oracle.ts`).
    - Stages 7 to 9 revert cleanly in reverse order.

## Review

A fresh-context review on 2026-11-17 raised fifteen findings against the first draft. Each
is answered here. Stage numbers are this version's.

| #   | Finding                                                                                        | Resolution                                                                          |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | The disposition table covered 21 of 36 bullets, and the last stage would have deleted the rest | Fixed: one row per bullet; stage 9 runs only once no bullets remain                 |
| 2   | Four of six `tasks.jsonl` writers were named; raw `appendJsonl` and the barrel bypass a rule   | Fixed: six writers listed, two subpath entries, a grep test, `adopt` off the barrel |
| 3   | Gating edges between slots would plan shots while a non-subject character is unapproved        | Fixed: the gate is per unit, over `scene.characters`, and blocks decomposition      |
| 4   | `resolveSlot` omits the sheet key, so planning from the solver would move hashes               | Fixed: stage 0 repairs it first; the stage 1 oracle compares hashes through 6b      |
| 5   | `NarrativeStructure` in `@vn/model` is unreachable from the solver; `model.reachable` readers  | Fixed: the interface is in `@vn/types`; the builder fills `model.reachable`         |
| 6   | Retry eligibility covers records with no slot                                                  | Fixed: it stays in the executor (decision 9)                                        |
| 7   | The collector keeps more than the slot graph; export cannot import artgen                      | Fixed: a separate keep set; export takes its list as a parameter                    |
| 8   | Building facts was undecided (absent vs empty manifest, dry runs, CLI, `repairCurrent`)        | Fixed: optional fields with stated meaning, and one named builder per host          |
| 9   | Stage 4's import direction contradicted `ProjectModel`                                         | Fixed: production may import script; `ProjectModel` sits outside both folders       |
| 10  | Where sheet seeds come from in 6c was undecided                                                | Fixed: one function, three callers, facts from one builder per host, and a test     |
| 11  | VN assumptions leaked into the solver interfaces                                               | Fixed: `SolverFacts` plus `Family<F>`; units are opaque; `AssetKind` left for later |
| 12  | `linear`'s file order contradicts "a directory has no document order"                          | Fixed: an explicit `scenes:` list; testkit script named apart from `SCRIPTS.linear` |
| 13  | Undo and parallelism claims were optimistic                                                    | Fixed: stages run in order; undo section restated per stage                         |
| 14  | Two references to the document sit outside `check:doclinks`'s reach                            | Fixed: stage 9 adds a repo-wide search and names them                               |
| 15  | The `@contract` sentence may clash with the comment rules                                      | Moot: contracts became string values, not comments (decision 1)                     |

A second fresh-context review on 2026-11-17 covered the sections written after the first
one: families and styles, the packages and allow-lists, contracts as data, stage 0 and
stage 2, and the renumbering.

| #   | Finding                                                                                                                                                          | Resolution                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Stage 2's file list did not close, and its splits of `takes.ts`, `collect.ts` and `prereq.ts` did not match the code                                             | Fixed: `overheld` and `prereq` move whole, `assetSlotLabel` moves into `slotaddr`, only `keptSlots` leaves `collect.ts`, and a function of `takes.ts` moves when it does no I/O |
| 2   | The renderer imports `@vn/artgen/layout`, gengraph imports `@vn/artgen/slotaddr` to avoid `node:fs`, and `@vn/contracts` would carry its index into the renderer | Fixed: `@vn/stills/layout` and `@vn/stills/slotaddr` subpaths; the index sits in `@vn/contracts/query` (decision 25)                                                            |
| 3   | Stage 1's first declaration was on `refcycle.ts`, which stage 2 moves                                                                                            | Fixed: the first declaration is the line-id rule in `@vn/scriptedit`; `refCycle` is declared in stage 3                                                                         |
| 4   | Stage 1 cannot revert "at any time" once other declarations depend on it                                                                                         | Fixed: the undo section says when it can                                                                                                                                        |
| 5   | The CLI and the scheduler cannot import `@vn/stills`; `gateStatus`'s new signature was undecided                                                                 | Fixed: `@vn/pipeline`'s re-exports are re-pointed; `gateStatus` keeps `(model, assets)`                                                                                         |
| 6   | Stage 0 under-listed the readers of the wrong identity, and said nothing about records already written under it                                                  | Fixed: every reader listed, a collector test case, and the commit states what happens to existing records                                                                       |
| 7   | `slot:` subjects cannot be checked before 6a; the `asset:` pin has no task                                                                                       | Fixed: checked against `RefBinding` kinds until 6a; `asset:` is not a `SlotKind`                                                                                                |
| 8   | Rows 287, 600, 632 and 743 pointed at the wrong code or lost their pin in 6b                                                                                     | Fixed: rows re-pointed, and 6b rewrites the tests that compared against `buildSlotGraph`                                                                                        |
| 9   | The debug agent has no tools when nothing is granted; who passes the `Budget` was unstated                                                                       | Fixed: the tool is offered whenever a loop runs (decision 21); the host passes the `Budget`                                                                                     |
| 10  | Authoring-agent tools are not commands, so a refusal had no key to look up by                                                                                    | Fixed: a `tool:` subject prefix (decision 22); the tool is deferred, so the cached catalog is unchanged                                                                         |
| 11  | Contracts in the desktop's session code had nowhere to be declared or indexed                                                                                    | Fixed: `apps/desktop/src/main/contracts.ts` (decision 23); arrays are imported by path, never barrel-exported                                                                   |
| 12  | The allow-lists were incomplete, and `apps/authoring` was wrongly listed as importing artgen                                                                     | Fixed: every entry spelled out                                                                                                                                                  |
| 13  | Setup for new packages was unstated, and folder subpaths break the `src/<name>.ts` convention                                                                    | Fixed: the setup list, file subpaths, and file elements in `vn/element-types` (decision 24)                                                                                     |
| 14  | "Chosen per shot" overstated how styles are selected today                                                                                                       | Fixed: today's selectors named, and unchanged by this plan                                                                                                                      |
| 15  | Two file paths would be stale by the stage that cites them                                                                                                       | Fixed: both cite the path as it is today and say where the file will be                                                                                                         |
| 16  | The oracle calls live helpers that later stages turn into solver readers                                                                                         | Fixed: the oracle copies the gate and sheet helpers; prompt composition stays live, guarded by the pinned hashes                                                                |
| 17  | `upstream.ts` moves twice                                                                                                                                        | Kept, and stated: `prereq.ts` needs it in stage 2, and the solver takes it in 6d                                                                                                |
| 18  | Stage 2's risk was understated                                                                                                                                   | Fixed: split files are reviewed function by function                                                                                                                            |
| 19  | `workflow:` selects nothing while only `vn` exists                                                                                                               | Kept: the key fixes the name the manga workflow will use, at the cost of one config field                                                                                       |

# Pipeline contracts into code, shaped for more than one workflow

This plan moves every rule in
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md) into code and
then deletes that document. It does the move along the seams that
[`../research/workflows-and-narrative-engines.md`](../research/workflows-and-narrative-engines.md)
proposes, so the derivation code is extracted once, in a form a second workflow and a
second narrative engine can use, rather than extracted in its current VN shape and
reshaped later. The research behind it is
[`../research/pipeline-contracts-into-code.md`](../research/pipeline-contracts-into-code.md).

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

The workflows note's step 1.

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

The workflows note's step 2.

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

The workflows note's step 3, in solver terms.

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

- Move the remaining execution bullets to contract declarations in `@vn/scheduler`,
  `@vn/pipeline` and `@vn/taskgraph`, per the disposition table.

### Stage 9: delete the document

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
| 453  | Shot decompositions are persisted                               | 4      | `@vn/store` declaration; the production map                                                                         |
| 520  | Reordering a shot means editing the prose                       | 3      | `@vn/scriptedit` declaration and test                                                                               |
| 536  | A character inherits what it wears                              | 3      | `@vn/model` declaration and test                                                                                    |
| 562  | Art direction is authored and appended                          | 3      | The builders' half in `@vn/stills`, the rungs' half in `@vn/artgen`, as built                                       |
| 600  | A prompt is a list of clauses                                   | 4      | Type in `@vn/types` (`PromptChunk`), declared once stage 4 has reorganised `src/`                                   |
| 632  | A reference attaches to a clause                                | 4      | Type in `@vn/types` (`ChunkRef`) and the refusal in `@vn/stills`                                                    |
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
  guards are `prompthash.test.ts`, the stage 1 pinned fixtures, and the stage 1 oracle
  through stage 6. A stage that moves a planner hash does not land.
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
      about 120 lines of planner enumeration, `buildSlotGraph` and the agreement test; the
      oracle makes that a copy rather than a rewrite until 6e deletes it.
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

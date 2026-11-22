# Widening `familyOf`, and reading a task back into its slot through the family

Two follow-ups left over from the archived contracts plan
([`INDEX.md`](INDEX.md#contracts-into-code-and-workflows), stage 7's "For 8" list and
stage 9's "Left over" list). Neither changes what the pipeline does. Both remove a place
where `@vn/pipeline` assumes the stills family.

## The two problems

- `familyOf(workflow)` in `packages/pipeline/src/workflows.ts` answers
  `Family<StillsFacts>`. A workflow whose family reads other facts (a storyboard,
  animation or film family) cannot be registered without changing that signature and every
  caller's types.
    - The callers are the planner (`planner.ts`), `graphload.ts`, the CLI's `vngen status`
      (`apps/cli/src/commands.ts`), and five desktop call sites in
      `apps/desktop/src/main/session/` (`core.ts`, `docs.ts`, `gate.ts` twice,
      `pipeline.ts`).
    - Every caller passes facts from one of two builders: `waveFacts` in `@vn/pipeline`
      and `sessionFacts` in the desktop's `session/core.ts`. Both return `@vn/stills`'
      `PlanFacts`.
- `slotOfTask` in `packages/pipeline/src/graphrun.ts` turns a task into the address of the
  slot it fills by switching on task kind names (`bindingOf`): `portrait`, `location_ref`,
  `model_sheet`, the retired `outfit_sheet`, and `shot_image`. `SlotKind` has no inverse
  from a task's inputs to a binding, so the pipeline holds one of its own.
    - A shot task's inputs name the shot but not its scene, so the shot case reads the
      model (`sceneOfShot`).
    - `slotOfTask` is called by `boundGraph` and `driftedTasks` in the same file, and by
      the desktop's `invalidateBound` (`apps/desktop/src/main/session/asset.ts`).

## Design

### `familyOf` answers a family over the facts a host builds

- `@vn/pipeline` names the facts every host builds: `HostFacts`, in `workflows.ts`. It is
  `PlanFacts` today. `waveFacts` and the desktop's `sessionFacts` are retyped to return
  `HostFacts`, so widening `HostFacts` later reaches both builders.
- `familyOf(workflow)` answers `Family<HostFacts>`, and the registry is typed
  `{ readonly [W in Workflow]: Family<HostFacts> }`.
- There are two ways to register a family:
    - A family that reads only what `HostFacts` carries registers as it is. `stillsFamily`
      is one. `Family<StillsFacts>` is assignable to `Family<HostFacts>` because
      `HostFacts` extends `StillsFacts`, so `familyOf('vn')` is still the `stillsFamily`
      object, and `executors.test.ts`'s `toBe(stillsFamily)` holds.
    - A family whose facts carry fields of their own registers as
      `withFacts(family, build)`. `withFacts` is new in `@vn/constraint-solver`. `build`
      maps a host's facts to the family's own fields, and `withFacts` answers a
      `Family<HostFacts>` that hands the family the host's facts with `build`'s fields
      laid over them.
- What `withFacts` guarantees:
    - `build` is typed to answer only the family's own fields
      (`Omit<F, keyof SolverFacts>`). The facts the family sees are a copy of the host's
      facts with those fields added, so the solver's fields (`assets`, `tasks`, `base`,
      `graphs`) are the host's, and the solver and the family read the same manifest and
      task log. The host's other fields pass through as well, which is harmless.
    - `build` runs once per host facts object (a `WeakMap`), so a family that memoises on
      its facts object (as every stills kind does) still memoises for the life of one host
      facts object.
    - Every slot the wrapped family answers carries a wrapped kind. Each kind is wrapped
      once, so `kinds`, `enumerate`, `kept` and `slotOf` hand out the same kind objects.
- The callers' types do not change. They pass `waveFacts` or `sessionFacts`, which return
  `HostFacts`, and they never name a family's facts type.
- Why the builder sits in the registry: the host cannot know which facts the family wants
  without knowing the workflow, and each caller would otherwise have to branch on
  `config.workflow` to build them. Pairing each family with its builder in one entry keeps
  that branch in the one place that already maps a workflow to its family.
- Why `withFacts` exists although no second family does yet: without it, a second family's
  facts type would have to accept `HostFacts`, which is `@vn/stills`' `PlanFacts`. The new
  family's package would then import `@vn/stills` for its own facts type. `withFacts` lets
  the family declare facts of its own and leaves the mapping in `@vn/pipeline`, which
  already imports both. A family that needs data no host loads still needs `HostFacts` and
  both builders widened; `withFacts` does not remove that.

### The inverse lives on `SlotKind`

- `SlotKind` gains `fromInputs(inputs, facts)`, which reads a task's inputs back into the
  binding of the slot the task fills, or answers `undefined`.
    - The method is required, so a new kind cannot forget it.
    - Its inputs are typed `Partial<TaskInputs[K]>`, because the switch it replaces tested
      each field before using it, and a record in an older log may lack one.
    - It is declared with method syntax, like the other members. `K` appears in its
      parameter, and only method-parameter bivariance lets a `SlotKind<F, B, 'portrait'>`
      sit in `Family.kinds: SlotKind<F>[]`.
    - Its doc comment says it reads none of the solver's fields. A runner asks it with
      facts that hold no manifest and an empty task log (see below), while the desktop
      asks with full facts, and the two must agree.
- `SlotKind` gains an optional `retired: readonly string[]`, the names of task kinds that
  are no longer planned but whose records still fill a slot of this kind. `fromInputs`
  reads their inputs as this kind's own.
    - The stills sheet kind lists `outfit_sheet`, so an old log's `outfit_sheet` record
      still names its sheet slot (decision 7 of the archived plan keeps the retired kinds'
      answers).
    - The list is `string[]` rather than `RetiredTaskKind[]`. `RetiredTaskKind` is a
      closed alias of three stills kinds in `@vn/types`, so another family could not list
      its own retired kinds without editing it, and the solver would be naming the stills
      family's history.
- `@vn/constraint-solver` gains `taskSlot(family, task, facts)`.
    - It walks `family.kinds` in order and takes the first kind whose `task` is the task's
      kind or whose `retired` lists it. Each stills task kind belongs to exactly one kind.
    - It answers `{ kind, binding }` from that kind's `fromInputs`, or `undefined`. The
      slot carries no `unit`, because a task does not say which unit its slot is in.
- The stills kinds' `fromInputs` are the four cases of the old switch, moved without
  change. Each field is tested for truthiness, as before, so an empty string still reads
  as missing.
- The shot kind's `fromInputs` reads `facts.model` to find the scene. `sceneOfShot` moves
  from `graphrun.ts` into `@vn/stills`' `family.ts` and stays private to that file. It is
  not the renderer's `sceneOfShot` (`renderer/rules/selection.ts`, `taskGraph.ts`), which
  splits the shot id on `__`.
- `@vn/pipeline`'s `slotOfTask(task, facts: HostFacts)` asks
  `taskSlot(familyOf(facts.config.workflow), task, facts)` and answers the kind's
  `key(binding)`. Every stills kind's `key` is `slotKey`, so the address is the string the
  switch produced.
- `withFacts` wraps `fromInputs` and copies `retired` like every other kind member.

### How the model reaches the shot kind's inverse

- It arrives through the facts, like everything else a kind reads. The shot kind's
  `fromInputs` reads only `facts.model`.
- `boundGraph(task, deps)` and `driftedTasks(tasks, deps)` build
  `waveFacts({ model: deps.model, config: deps.config })`. `PlanFacts` requires the
  config, and `slotOfTask` reads the workflow from it, so `RunDeps` gains a required
  `config: ProjectConfig`.
    - Only the scheduler builds a `RunDeps` outside tests. It sets `config` to the same
      object it passes to `createRunners`, so the shot runner's closed-over config and
      `deps.config` are one object in every run.
    - `executors.test.ts` builds a `RunDeps` and gains the field. `graphrun.test.ts` casts
      a partial `RunDeps` only for its direct `runBoundGraph` call, which never reaches
      `boundGraph`; its other cases run through the scheduler.
    - The facts carry no task log and no manifest. `fromInputs` reads neither, by its
      contract.
    - Each call builds its facts from `deps.model` as it stands, as the switch read
      `deps.model` as it stood. The scheduler's `drawnByGraph` therefore builds one small
      object per pending task during a cost preview, which is negligible beside the walk
      over the storyboards that `sceneOfShot` already does.
- The desktop's `invalidateBound` passes `sessionFacts(project, project.model)`.
    - This is the same model it passed before. It is deliberately not `withShots`, because
      this change keeps behaviour.
    - **Known defect, kept:** `project.model`'s production map is empty
      (`packages/model/src/build.ts` builds it empty, and `loadProject` never fills it),
      so `invalidateBound` never resolves a `shot_image` task's slot. A regenerated shot
      whose slot a graph binds is not invalidated first, and its cached nodes may resume.
      Fixing it means passing `await withShots(project)` there. That is a behaviour
      change, so it was left for its own change, which made it after this plan landed;
      `graphrun.test.ts`'s "drawing a bound frame again" pins it.
    - `sessionFacts` copies the manifest that `fromInputs` does not read.
      `invalidateBound` runs once per requeue, so the copy is not worth a second builder.

## Alternatives rejected

- **Erase `Family<F>` behind closures** (`familyOf` answering `solve`, `suspensions`,
  `unitGates` and `owed` already bound to a facts builder). The callers also read `kinds`
  and pass the family to solver functions, so each would need a wrapper, and
  `familyOf('vn')` would stop being `stillsFamily`, which `executors.test.ts` asserts.
- **A generic `familyOf<W>` over a workflow-to-facts map.** The callers hold
  `config.workflow` as the whole `Workflow` union, so they would get a family over a union
  of facts. Each would have to narrow the union and build the matching facts, which is the
  branch on the workflow this change exists to avoid.
- **Answer `Family<SolverFacts>`.** TypeScript checks method parameters bivariantly, so
  this compiles, but it hands stills facts to any family without a check.
- **No `withFacts`; a second family derives its extra fields itself**, memoised on the
  facts object as the stills kinds memoise `usedOutfits`. That works, but the family's
  facts type must then accept `HostFacts`, so the family's package imports `@vn/stills`'
  `PlanFacts` (see the design above).
- **Give the inverse the `ProjectModel` rather than the facts.** The solver would then
  name the project model, which is a family's concern. `StillsFacts` carries the model,
  and `SolverFacts` does not.
- **A family-level `slotOfTask` method.** Each family would hold its own switch on task
  kinds. A per-kind method sits beside `resolve`, the function it inverts, and the solver
  does the lookup once for every family.
- **Pass the config to `boundGraph` and `driftedTasks` as an argument.** `EXECUTORS`
  already builds each runner from the config (`runner(config)`), and the three legacy
  entries ignore it (`() => runPortrait`). Threading it through would turn `runPortrait`,
  `runLocationRef` and `runModelSheet` into factories, which renames three exports, and
  would change the signatures of `boundGraph`, `driftedTasks` and the scheduler's exported
  `requeueDrifted`. `RunDeps.config` is one field set in one place.
- **Find the family from the task's kind rather than from the workflow.** Task kinds are
  unique across families, so this would work, but it does not remove the need for facts.
  It would also make `slotOfTask` answer for a task of a workflow the project is not.

## What changes where

- `@vn/constraint-solver`
    - `family.ts`: `SlotKind.fromInputs`, `SlotKind.retired`, `taskSlot`.
    - New `withfacts.ts`: `withFacts`. `index.ts` exports it.
    - `tests/garden.ts`'s two kinds gain `fromInputs`.
    - New tests: `withfacts.test.ts` (which, once the inverse lands, also covers the
      wrapped `fromInputs` and `retired`) and `taskslot.test.ts`.
- `@vn/stills`
    - `family.ts`: the four `fromInputs`, the sheet kind's `retired`, `sceneOfShot`.
    - New test: `frominputs.test.ts`, which covers each kind, including `outfit_sheet`.
- `@vn/pipeline`
    - `workflows.ts`: `HostFacts`, and the registry and `familyOf` typed over it.
    - `facts.ts`: `waveFacts` returns `HostFacts`.
    - `graphrun.ts`: `slotOfTask(task, facts)`, with no switch and no `sceneOfShot`.
      `boundGraph` and `driftedTasks` build the facts.
    - `pipeline.ts`: `RunDeps.config`.
    - Tests: new `workflows.test.ts` (whose toy kind gains `fromInputs` with the inverse)
      and `slotoftask.test.ts`. `executors.test.ts`'s `RunDeps` gains `config`, and no
      assertion changes.
- `@vn/scheduler`: `scheduler.ts` puts `config` on the `RunDeps` it builds.
- Desktop: `session/core.ts`'s `sessionFacts` returns `HostFacts`, and
  `session/asset.ts`'s `invalidateBound` passes `sessionFacts`.
- Lintrix allow-lists: unchanged. `@vn/constraint-solver` imports only what it imports
  today, and every other new import is already allowed.
- Docs:
    - `docs/reference/packages.md` (the solver paragraph).
    - `docs/reference/module-map.md` (the solver's table).
    - `docs/reference/gen-graphs.md` (the runner wrapper finds a task's slot).
    - `docs/guides/cli.md` (the `familyOf` sentence), if its wording needs it.
    - The research note `docs/research/workflows-and-narrative-engines.md`, whose step 3
      still lists "the slot switch": its status line gains a sentence.
    - The archived plan's "Left over" bullet.
    - `CLAUDE.md` names neither seam.
    - No contract's text or subjects name `familyOf`, `slotOfTask` or `bindingOf`
      (`pnpm contracts` finds none), so `pnpm gen:contracts` should leave `contracts.json`
      unchanged.

## How behaviour is shown to be unchanged

- `slotoftask.test.ts` is the main evidence.
    - It asserts the literal address for each kind (portrait, plate, sheet, retired
      `outfit_sheet`, shot), plus missing fields, empty-string fields, a shot in no
      storyboard and retired kinds no slot takes.
    - It was written and run green against the old switch before the switch was removed
      (six tests). Only its one call helper changes with the signature; its expectations
      do not.
- End-to-end coverage through `boundGraph` is partial. Portrait and shot graphs are bound
  and run (`graphrun.test.ts`, `graphdrift.test.ts`, `sheetrun.test.ts`, the CLI's
  bound-graph cases). Plates and model sheets reach `slotOfTask` only through the unit
  tests above.
- The frozen guards stay untouched: `prompthash.test.ts` (and its baseline),
  `plannerwaves.test.ts`, `plannerpins.test.ts` and `__fixtures__/waves/`. They guard task
  hashes and planner waves, which this change does not touch; they never reach
  `slotOfTask`. The final report includes their `git diff master --stat`, which should be
  empty.
- `pnpm gen:contracts` leaves `contracts.json` unchanged.
- The full gate (`pnpm check`, `pnpm lint`, `pnpm test`) passes on every commit. The suite
  total grows only by the new tests.

## Commits

1. This plan and its index row.
2. `familyOf` over `HostFacts`, both builders typed to return it, and `withFacts`, with
   their tests.
3. The inverse: `fromInputs`, `retired`, `taskSlot`, the stills kinds, `slotOfTask`
   through the family, and `RunDeps.config`, with their tests.
4. Docs, the archived plan's leftover bullet, and this plan marked shipped and archived.

## As shipped

- **Commits**, on the `family-seams` branch:
    - `98dcf053` adds this plan and its index row.
    - `00e4d2cc` adds `slotoftask.test.ts` on its own, against the old switch, so the next
      commit's diff shows its expectations unchanged. The plan had put the test in the
      inverse's commit.
    - `a6d4d28b` widens `familyOf` and adds `withFacts`.
    - `b68cc8bc` adds the inverse.
    - The last commit updates the docs and moves this plan into `archive/`.
- **Deviations from the text above:**
    - `graphrun.test.ts`'s cast `RunDeps` gained `config` as well. Once `config` was
      required, TypeScript refused the cast of `{ model, store, providers }` as a likely
      mistake. No assertion changed.
    - `executors.test.ts`'s `RunDeps` gained `config` as its last field, which leaves the
      other fields' alignment alone.
    - `stillsKind` takes each kind's inverse as a fourth argument, `from`.
- **Tests:** the suite went from 420 suites and 5895 passed (7 skipped) to 425 suites and
  5917 passed (7 skipped). The 22 new tests are `withfacts.test.ts` (5),
  `taskslot.test.ts` (4), `frominputs.test.ts` (5), `slotoftask.test.ts` (6) and
  `workflows.test.ts` (2). No existing assertion was changed or removed, and the frozen
  planner and hash tests are untouched.
- **Contracts and layering:** `pnpm gen:contracts` left `contracts.json` unchanged, and no
  lintrix allow-list changed.
- **Still switching on stills kind names, left alone because each answers a different
  question:**
    - `planner.ts` stamps a planned `shot_image` task's prompt and outcome onto its shot
      (`state.task === 'shot_image'`).
    - `executors.ts` keys the runner registry and `RETIRED_COST` by kind, which is a
      registry rather than a switch.
    - The desktop's `assetlabel.ts` (an asset's display name) and `assetprompt.ts` (its
      prompt clauses) switch on an asset's kind, `outfit_sheet` included.
      `session/core.ts` lists `IMAGE_KINDS` and `ACCEPTABLE`, and `session/asset.ts` and
      `gate.ts` single out `portrait` for the gate.
    - The renderer's `rules/taskGraph.ts` (`subjectOf`, `clusterKeyOf`) and
      `rules/selection.ts` read a task's inputs by field name, with their own
      `sceneOfShot`. That is the nearest to this change's purpose, but the renderer may
      reach `@vn/stills` only through `slotaddr` and `layout`, so it cannot call the
      family.
- **Known defect, fixed afterwards:** the desktop's `invalidateBound` resolved no
  `shot_image` task's slot, because `project.model` holds no storyboards. It now passes
  `withShots`, in its own commit after this plan landed.

## Review

A fresh-context agent attacked the plan before the work started. Each finding and what was
done with it:

- **`invalidateBound` keeps a real bug.** Accepted as a fact and recorded under "How the
  model reaches the shot kind's inverse" as a known defect. It is not fixed here, because
  the fix changes behaviour.
- **What `fromInputs` may read was unstated, so the scheduler and the desktop could
  disagree.** Fixed: its contract is that it reads none of the solver's fields, stated in
  this plan and in its doc comment.
- **`retired: RetiredTaskKind[]` names the stills family's history and is closed to other
  families.** Fixed: `retired` is `readonly string[]`.
- **The rejection of passing the config as an argument misdescribed `EXECUTORS`.** Fixed:
  the alternative now describes the code as it is (`runner(config)`, with the three legacy
  entries ignoring it) and gives the real cost. The two-configs question is answered: the
  scheduler passes one object to both.
- **`withFacts` has no consumer.** Answered in the design: without it, a second family's
  package would import `@vn/stills` for its facts type. Its limit (a family needing data
  no host loads still widens `HostFacts`) is stated.
- **`withFacts`' code copied the whole host, not only the solver's fields.** Fixed in the
  text, which now says the family sees a copy of the host's facts with `build`'s fields
  laid over them.
- **`HostFacts` was a name only.** Fixed: `waveFacts` and `sessionFacts` return
  `HostFacts`.
- **Commit 3 breaks the toy kind in commit 2's `workflows.test.ts`, and no test covered
  the wrapped `fromInputs`.** Fixed: both are listed under "What changes where".
- **The empty-string behaviour was not pinned.** Fixed: `slotoftask.test.ts` gained an
  empty-field case, run green against the old switch.
- **The evidence section overclaimed.** Fixed: it now says plates and sheets are covered
  by unit tests only, that the frozen guards never reach `slotOfTask`, and why
  `graphrun.test.ts`'s cast `RunDeps` is safe.
- **`fromInputs` needs method syntax.** Fixed: stated.
- **`taskSlot`'s return shape and duplicate claims were undecided.** Fixed: it answers
  `{ kind, binding }` with no unit, and the first kind in `family.kinds` wins.
- **`sceneOfShot` collides with the renderer's.** Fixed: the moved one stays private to
  `@vn/stills`' `family.ts`.
- **The docs list was incomplete.** Fixed: `gen-graphs.md` and the research note are
  listed.
- **Per-call facts objects and the manifest copy cost something.** Answered under "How the
  model reaches the shot kind's inverse": both are negligible at their call rates.
- **Undo cost.** Nothing persisted changes, so undoing is a code revert. The public
  surface it adds (`RunDeps.config`, `SlotKind.fromInputs`, `withFacts`, `taskSlot`, the
  new `slotOfTask` signature) is the cost. `RunDeps.config` lands in the same commit as
  the inverse because the inverse is its only reader.

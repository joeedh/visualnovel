# Slot history on the manifest row

Plan, 2026-09-20. Implements the model the owner chose in
[`../research/slots-as-asset-history.md`](../../research/slots-as-asset-history.md#decisions):
which take a slot holds and whether a human approved it become two bits on the manifest
row, `current` and `accepted`, and every surface reads them through one rule. The research
doc holds the findings and the twelve decisions; this plan holds the work. Where the two
disagree the research doc's decisions win and this plan is wrong.

<!-- toc -->

- [Goal](#goal)
- [Non-goals](#non-goals)
- [The model](#the-model)
- [Stage 0 — a take adopted across roots is visible to its slot](#stage-0--a-take-adopted-across-roots-is-visible-to-its-slot)
- [Stage 1 — the model lands](#stage-1--the-model-lands)
    - [1a. Types and store](#1a-types-and-store)
    - [1b. `@vn/artgen`](#1b-vnartgen)
    - [1c. Migration and repair](#1c-migration-and-repair)
    - [1d. Writers](#1d-writers)
    - [1e. Readers](#1e-readers)
    - [1f. Tests and regenerations](#1f-tests-and-regenerations)
- [Stage 2 — where an unapproved current take is refused](#stage-2--where-an-unapproved-current-take-is-refused)
- [Stage 3 — `Shot.status` leaves the storyboard file](#stage-3--shotstatus-leaves-the-storyboard-file)
- [Stage 4 — an interactive graph run files a take](#stage-4--an-interactive-graph-run-files-a-take)
- [Stage 5 — the portrait gate reads the row](#stage-5--the-portrait-gate-reads-the-row)
- [Stage 6 — docs](#stage-6--docs)
- [Crash windows](#crash-windows)
- [What it costs to undo](#what-it-costs-to-undo)
- [Review findings](#review-findings)
- [Finishing checklist](#finishing-checklist)

<!-- tocstop -->

## Goal

- One definition of "the take a slot holds": the manifest row with `current` set among the
  rows bound to the slot. Today there are six
  ([research §Six answers](../../research/slots-as-asset-history.md#six-answers-to-which-take-is-current)).
- `accepted` means one thing: a person approved this take. No runner sets it.
- A current, unapproved take is shown everywhere the author works and refused where the
  output leaves the app.
- The approval popup, the tree's _Awaiting approval_ group and the agent's
  `approve_assets` list at most one row per slot: the current take, when unapproved.
- The tree orders a slot's takes newest first, and can say so truthfully.

## Non-goals

- Deleting a take (decision 7; a separate plan).
- The reconcile pass for a base repo shared between projects (decision 5; lands with
  sharing, which has no UI today). This plan puts the fields a shared base needs on the
  row and stops there.
- Keeping a task's attempt history across adoption (finding 9). `store.write` overwrites
  `sourceTask` on an existing hash (`packages/store/src/assetstore.ts:147`), so a restored
  take's earlier attempts are not reachable from the row either; unchanged.
- The prose-drift half of `stale` (finding 13). Only the prompt half changes here.

## The model

Definitions the code will carry. Each is a sentence a reader can check a surface against.

- **Slot.** Unchanged: a `RefBinding` other than `asset:`, spelled by `slotKey`. Nothing
  on disk is keyed by it.
- **Take.** A manifest row bound to the slot through `satisfies`. For a `sheet:` slot the
  binding now carries `angle`, so the row alone says which of four sibling sheets it is.
- **Current.** `Asset.current === true`. At most one current row per slot; `hold` clears
  the others in the same write. A slot with no current row and exactly one candidate
  resolves to that candidate (`pick`'s sole-candidate rule, unchanged); with none or two
  it resolves to nothing and says so.
- **Accepted.** `Asset.accepted === true`. Set only by `asset.accept`, `asset.restore`,
  `gate.approve`, `vngen accept` and the testkit. Never cleared by a hold, so a superseded
  take keeps the bit as history.
- **Approved**, the predicate a surface asks about a take: `current ∧ accepted` for every
  kind but `portrait`, which stays on the gate until stage 5. `reference` and `concept`
  count as approved as today (nothing downstream consumes them).
- **Blessed basis**, the predicate a prerequisite check asks about a take's `refs`: the
  ref row's `accepted`, without `current`. A frame drawn from a plate that was approved
  and has since been superseded was still drawn from an approved plate; reading `approved`
  here would make the frame unapprovable with no way to approve the plate, since
  `asset.accept` refuses a non-current take.
- **Newest.** The row's `at`, stamped by every hold, meaning most recently held. A
  restored take is newest. Rows with no `at` (a migrated manifest) sort last in hash
  order, and the tree makes no recency claim for them.
- **Via.** How the bytes entered the slot: `run` | `graph` | `adopt` | `promote` |
  `upload` | `migrated`. Stamped on the row by the first hold and kept by later ones; a
  restore stamps `at` and records `via: 'restore'` on its attempt, so the row still says
  where the picture came from.
- **Current is a cache of the task log.** Where the slot's identity is `done`, its
  `output` is the current take and `repairCurrent` rewrites the bit to match. Where the
  identity is `needs_human` with an output, that output is current. Otherwise (`pending`
  after a re-key, `running`, `failed`) the row is authoritative, because that is the
  window decision 4 keeps the old take through. The planner never reads `current`; it
  keeps keying downstream tasks on `doneOutput`.
- **Per hash, not per slot.** A row serves every binding in `satisfies`.
  `hold(hash, slot)` sets one bit and clears the other rows _of that slot_; a row bound to
  two slots is current for both or neither, the limit `accepted` has today. A hold on such
  a row for one slot leaves the other slot's other rows untouched.

## Stage 0 — a take adopted across roots is visible to its slot

The bug the options review found, fixed first because stage 2's export refusal would
otherwise fire on every replaced frame. One commit, green on its own.

- Today: adopting a `reference` or `concept` onto a `shot:` writes a `shot_image` row to
  the project root while the base row keeps its kind; `AssetStore.manifest()` returns the
  base row (`packages/store/src/assetstore.ts:297-303`), and `candidatesFor(shot)` filters
  on `kind === 'shot_image'` (`packages/artgen/src/refs.ts:108-113`). The frame is not a
  candidate of its slot, the popup never lists it, `asset.accept` refuses it as an upload,
  and `AssetIndex.shotImage` cannot find it, so `asset.replace` on a frame blanks that
  frame in the playable. `packages/artgen/src/tests/adoptslot.test.ts:158-163` asserts the
  current behaviour in words.
- `manifest()` returns, for a hash held by both roots, the project row when its kind is a
  project kind (`shot_image`) and the base row otherwise.
- `accept`, `unaccept` and (from stage 1) `hold` route to the root that holds the row of
  the slot's kind, then fall through to whichever root holds the hash. The fall-through is
  what a legacy project needs: one written before the split keeps base kinds in
  `vngen/build/manifest.json` (`docs/reference/asset-stores.md:95-98`), and `rootFor`
  throws for a base kind when the base is `unavailable` (`assetstore.ts:314-322`). A flag
  write never consults `rootFor`; only a byte write does.
    - As built: one private rule, `rowRoot(hash)`, decides the row for a hash — the
      project row when it carries a project kind, else the base row when the base holds
      the hash, else the project row — and `get`, `manifest`, `manifestFileOf`, `accept`
      and `unaccept` all follow it. No caller passes a kind: the row `manifest()` shows is
      the row a flag write moves, so the two cannot disagree.
- The adoptslot test asserts the new answer. A session test (`session.test.ts`, "replacing
  a frame with a file") uploads a picture, `asset.replace`s a frame with it, accepts its
  prerequisites and then the frame, builds the playable, and asserts the frame names the
  upload. The accept step is there because the exporter reads `accepted` until stage 1e;
  before this stage `asset.accept` refused the frame as an upload.

## Stage 1 — the model lands

One stage, several commits on a branch, squashed or kept only where each commit is green
on its own. The parts cannot ship separately: dropping `accept`'s `supersede` parameter
breaks the shot runner, `acceptAsset` and `repairAccepted` (`runners.ts:306-310`,
`session/asset.ts:230`, `repair.ts:40`) the moment it lands, and a `pick` that reads
`current` while no runner writes it heads every regenerated slot with the old take until
the next open. So writers, readers, store and migration land together.

### 1a. Types and store

- `Asset` (`packages/types/src/entities.ts:398-428`): `current: boolean`, `at?: string`,
  `via?: TakeVia`. `AssetBinding` (`:388-395`): `angle?: string`. `AssetMeta`
  (`packages/types/src/model.ts:51-63`): unchanged apart from `satisfies` carrying
  `angle`; a write never sets `current`.
- `TaskAttempt` (`packages/types/src/tasks.ts:51-62`): `via?: TakeVia | 'restore'`.
- `packages/store/src/assetstore.ts`:
    - `write` preserves `current`, `at` and `via` across a rewrite of an existing hash, as
      it preserves `accepted` and `title` (`:154-157`).
    - `AssetRoot.hold(hash, supersede, stamp)` sets `current` and `at`, sets `via` when
      the row has none, clears `current` on every hash in `supersede`, one `persist`.
      Returns whether this root holds the hash.
    - `AssetRoot.accept(hash)` sets `accepted` and nothing else; the `supersede` parameter
      goes from the root, the store and the `AssetStore` interface (`model.ts:98`).
      `unaccept` unchanged.
    - `AssetStore.hold` and `accept` route as stage 0 says.
    - The manifest is not zod-parsed (`:99-102`); every reader treats an absent `current`
      as false.
    - As built: `Asset.current` is typed `current?: boolean` rather than
      `current: boolean`. Absent reads as false everywhere, `store.unstamped` (any row
      with the field absent) is what the migration keys on, and the thirty-odd test
      fixtures that build an `Asset` literal need no change. `write` stamps a new row
      `current: false`, so a manifest the new store has written is never mistaken for one
      owed a migration. `AssetStore` gains `unstamped` and `migrateTakes(decide)` for the
      migration's one write per root.
    - As built: `readAllShots(paths, model)` moved into `@vn/store` from the desktop
      session, since the scheduler, the CLI and `openTakeDeps` all needed it; the
      session's `readAllShots(project)` delegates to it.

### 1b. `@vn/artgen`

- `pick` (`refs.ts:64-69`): one current row wins; two decline; none falls to the sole
  candidate.
- `supersededBy` (`slotgraph.ts:252-259`) becomes `heldBy(asset, ctx)`: every other
  current row of every slot `asset` serves, over all of `satisfies` rather than `slotOf`'s
  `satisfies[0]` (`refcycle.ts:23-24`). The portrait exemption goes: a portrait's approval
  stays on the gate until stage 5, but its currency is a row bit from here. The sheet
  exemption goes with the angle on the binding; `angleOf(sourceTask)` stays as the
  fallback for a row written before the angle was stored.
- `candidatesFor` for `sheet:` filters on the binding's `angle` first and `angleOf` when
  the binding has none.
- `overAccepted` (`overaccept.ts`) becomes `overHeld`: two current rows in one slot keep,
  for a shot, the take the storyboard names; else the identity's `output` when `done`;
  else the newest `at`; else the lowest hash.
- `assetApproved` (`prereq.ts:54-67`): `current && accepted` on the default branch. The
  prerequisite walk (`prereqOf`, `:88-125`) reads the ref row's `accepted` alone — the
  blessed-basis predicate above — and its refusal sentence is unchanged.
- `acceptRefusal(asset, ctx)` beside `prereqRefusal`: the not-current refusal ("`<label>`
  is not the take `<slot>` holds; asset.restore(hash=…) brings it back and accepts it")
  and the prerequisite refusal, so the CLI and the testkit share the rule the desktop
  session applies today in `previewAccept` (`session/asset.ts:166-208`), which neither may
  import.
- `migrateCurrent` and `repairCurrent` live here, not in `@vn/pipeline`, because every
  host has to run them (1c) and `vnauthor` may not import the pipeline. `repair.ts` in
  `@vn/pipeline` becomes a re-export or goes.
    - As built: `takes.ts` holds both, plus `openTakeDeps(paths, model, config)`, which
      opens the store, replays the graph and reads every storyboard for a host that holds
      only the model and the paths (`vnauthor`'s `list_assets`). `repair.ts` in
      `@vn/pipeline` re-exports them and `heldBy`, for the scheduler and the CLI, which
      may not import `@vn/artgen`.
    - As built: `heldBy` releases nothing for a sheet whose angle neither the binding nor
      `angleOf` states, as `supersededBy` did: such a row could be any of the four, and
      releasing on that basis would drop a sibling of another angle. `candidatesFor` still
      lists it under the front slot for a caller with no task log, so a runner's hold on a
      new sheet — whose binding carries its angle — sees it and releases it.

### 1c. Migration and repair

- `migrateCurrent(deps)` runs once per manifest, keyed on the manifest having any row
  without a `current` field, and stamps `current: false` on every row it does not choose,
  so it is one-shot; logged once as `manifest.migrate`. Its inputs are the model, the
  manifest, the task log and the config. The storyboard files are not an input;
  `refreshShotData` rewrites `Shot.image` from the task on the next planning pass.
- For every slot the slot graph enumerates, in `slots.order`, the current row is:
    1. the identity's `output` when its task is `done`;
    2. else the identity's last attempt's `output` when it is `needs_human` (decision 3:
       the flawed frame holds);
    3. else the one accepted candidate;
    4. else the newest `at` among candidates, then the lowest hash, when there is more
       than one — never "nothing", because two accepted rows with a non-`done` identity
       would otherwise stay unresolved forever;
    5. else the sole candidate; else nothing.
- The chosen row gets `current`, `via: 'migrated'` and `at` from the identity's last
  attempt when there is one. A row bound to more than one slot is decided once, by the
  first slot in order that names it, and a later slot it serves takes it as its answer.
- Sheets: `angle` is backfilled onto the binding from `angleOf(sourceTask)` where the task
  is in the log. A sheet row with no task and no angle stays a candidate of no slot, as
  today (finding 12), and gets `current: false`.
- Portrait slots follow the same arms. A character whose sheet approves draft A while the
  identity's output is a later, unapproved draft B ends with B current and A accepted as
  history. Until stage 5 the gate still reads the sheet, so nothing changes for planning;
  stage 5 states what happens then.
- `repairCurrent(deps)` runs every open and every non-dry run where `repairAccepted` runs
  today (`scheduler.ts:333-341`, `session/core.ts:639`), and from the CLI's and
  `vnauthor`'s project load, which run nothing today (`apps/cli/src/commands.ts`,
  `packages/authoring/src/tools/assets.ts:92`): a CLI-only user who upgrades and runs
  `vngen export` before `vngen run` must not see every multi-take slot resolve to nothing.
  It rewrites `current` to the identity's `output` where the identity is `done`, to the
  last attempt's output where it is `needs_human`, and otherwise applies `overHeld`'s keep
  rule to any slot with two current rows. Its deps are `repairAccepted`'s plus `config`,
  since the identity comes from `resolveSlot`, and it always reads the storyboards rather
  than on demand.

### 1d. Writers

- Runners (`packages/pipeline/src/runners.ts`): plate, portrait and sheet hold their
  output after it is written (`generateAsset` at `:63`, `drawThroughGraph` at `:87`, the
  sheet's crop at `:193`) and before returning `done`, with `via: 'run'`, `at` from
  `deps.now`, and `heldBy` computed from `deps.store.manifest()` and the row's bindings —
  which is why the sheet binding must carry `angle`: `RunDeps`
  (`packages/pipeline/src/pipeline.ts:12-30`) carries no graph. The shot runner writes one
  row per attempt (`:280`) and holds only the clean one (`:310`) and, on `needs_human`,
  the last one (`:334`). `store.accept` at `:310` and its comment go.
- Plate, portrait and sheet runners push a `TaskAttempt` on success (`output`, `refs`,
  `prompt` where they have one, `at`, `via: 'run'`), so `lastRenderedAt` stops returning
  undefined for a first-try plate. The scheduler's failed-attempt push
  (`scheduler.ts:490-497`) is unchanged.
- `RunDeps.now` is optional and the testkit passes none
  (`packages/testkit/src/project.ts:219-242`); the testkit's `run` gains a `now` option so
  a test can observe `at`.
- `adoptSlot` (`packages/artgen/src/adoptslot.ts:254-296`): `AdoptSlotRequest` gains
  `via: 'adopt' | 'promote' | 'restore'` and `AdoptSlotDeps` gains `now?`. After the
  `store.write` it holds, stamping `via` on a row that has none, and `adoptionOf`
  (`adopt.ts:86-97`) writes `via` and `at` on the attempt it records. `asset.upload` that
  lands directly in a slot stamps `upload`.
    - As built: the request's `via` is
      `AdoptVia = 'adopt' | 'promote' | 'upload' | 'restore'`, required, so
      `asset.replace` on an upload stamps `upload` rather than `adopt`. `'restore'` is
      written on the attempt and never on the row, since the row keeps how the bytes first
      arrived. The desktop's `adoptAsset` takes the `via` as a fourth argument, defaulting
      to `'adopt'`.
- `promoteConcept` (`promote.ts:158-161`) passes `keepPrompt` (decision 9).
- `asset.restore` (`session/asset.ts:1001-1023`) adopts with `via: 'restore'`, then
  accepts. `asset.adopt` and `asset.replace` hold and do not accept.
- `acceptAsset` (`session/asset.ts:218-232`) refuses through `acceptRefusal` and drops the
  supersede. `unapproveAsset` unchanged.
- `asset.regenerate` (`session/asset.ts:379-384`): the orphan refusal becomes a sentence
  in the command — regenerating any take of a slot regenerates the slot (decision 4).
- `requeue` and `requeueDrifted` clear `output` and leave `current`, as today. A bound
  generation graph goes through the runner wrapper and inherits all of this.
    - As built: a scheduled graph draw stamps `via: 'run'` like any other runner output,
      since the runner wrapper is where the hold happens; `'graph'` is reserved for the
      interactive run stage 4 adds.
    - As built: `vngen approve` and the testkit's `approve` hold and then accept, as
      `gate.approve` does, through `heldBy` re-exported from `@vn/pipeline`. The CLI's
      `loadProject` and `vnauthor`'s `list_assets` run `repairCurrent` (1c); the other
      `vnauthor` asset tools open the store as they did, since they only look a hash up.

### 1e. Readers

Every surface that read `accepted` to answer "which one" reads `current`; every surface
that read it to answer "is it approved" reads `assetApproved`.

- `assetInfo` (`session/asset.ts:106-141`): `slot` and `newerTake` from the slot's current
  row rather than the identity's output; `AssetInfo` gains `current` and `approved`, and
  `apps/desktop/renderer/rules/assetview.ts:110` draws Accept/Un-approve from `approved`,
  not the raw flag. The prompt-staleness test at `:141` is skipped for a row whose `via`
  is `adopt` or `promote`, which have no derived prompt to have gone stale against.
- `approvable` (`session/gate.ts:108-160`): `current ∧ ¬approved`, drifted frames still
  excluded; one row per slot at most. `Approvable.settled` goes, with its readers:
  `packages/authoring/src/approve.ts:56-64`, `commands/pipeline.ts:258-272`,
  `renderer/pathux/chrome/approvals.ts:145`, `renderer/rules/situations/approvals.ts:29`,
  `commands/tests/approveandrun.test.ts:121,128`, and `ux-model.json:91` by regeneration.
- `approvedAssets`: `current ∧ approved` — for a portrait, the gate's answer until
  stage 5.
- `approveCharacter` (`gate.ts:64-99`) keeps writing the mirror `accepted` on the portrait
  row and now also holds it, so a draft chosen at the gate is current as well as approved.
- `doctree.ts` (`:329-381`, `:446-463`): the row head is the current take; the fold is
  ordered by `at` descending, rows without `at` last in hash order; the `accepted` badge
  reads `assetApproved`; _Awaiting approval_ uses `approvable`'s filter.
- `renderer/pathux/editors/nodes.ts:613-628` (Gen Graph pane's Show asset): the current
  take, not `candidates[0]`.
- `packages/authoring/src/tools/assets.ts` (`list_assets`, `approve_assets`): the same two
  predicates; `approve_assets` lists what `approvable` lists.
- `packages/export/src/playable.ts` `AssetIndex.shotImage`/`portrait`: the current take.
  Whether it is approved is stage 2's question.
- `pipeline.approveAndRun` (`commands/pipeline.ts:258-284`): the description's sentences
  about listing losing takes and the one-per-slot rule are rewritten; the pass approves
  what `approvable` lists and needs no skip rule. `command-table.md` regenerates.
- `attemptOutcome` (`renderer/rules/attempts.ts:81-87`) has only a `Task` in hand, so its
  `done → 'accepted'` label becomes `'kept'` (decision 12);
  `rules/tests/attempts.test.ts:152` follows.
- `docs/reference/document-tree.md` "newest first" becomes true.
- As built: `assetInfo` also carries `via` and `at`; `badgesOf` reads `approved`; the
  backlinks' `accepted` on a page asset reads `assetApproved`, so a portrait row whose
  flag is set reports the gate's answer. `asset.regenerate`'s description says that
  regenerating any take regenerates the slot, and `asset.accept`'s that only the current
  take can be accepted.

### 1f. Tests and regenerations

- `assetstore`: hold/accept/routing, legacy-root fall-through, `unavailable` base.
- `refs`/`slotgraph`: `pick` over `current`; `heldBy` over a two-slot row.
- `overaccept` renamed; the keep rule's four arms.
- Migration over a hand-built manifest in each shape: finding 3 (old accepted, new
  rendered → new current, old still accepted); finding 7 (`needs_human` → last attempt
  current); two accepted with a `pending` identity (arm 4); a two-slot row; a sheet with
  no task; a portrait with the sheet approving an older draft; a legacy project with base
  kinds in the build manifest; an `unavailable` base.
- Runners: each holds and none accepts; a regeneration leaves the old take accepted and
  not current; adopt/replace/restore/promote stamp `via`; `needs_human` holds; a plate's
  success attempt carries `at`.
- `gate`: popup contents after a regeneration (one row), after a restore (none), after a
  re-key (the old take, one row). `doctree`: fold order with a testkit clock.
    - As built: the popup is covered by `approvable` over an older take written beside the
      current one (not listed; `asset.accept` refuses it naming `asset.restore`) and by
      the restore test's before-and-after rows; fold order is pinned where it is decided,
      `buildSlotGraph`'s candidates (`newestFirst`), since the tree keeps that order.
- `session.test.ts:1398-1429` (run then export in one session) passes because the writers
  hold in the same commit.
- `pnpm gen:uxmodel` in the commit that drops `settled`; `command-table.md` regenerated
  with `approveAndRun`'s description.

## Stage 2 — where an unapproved current take is refused

- `buildPlayable` stays pure and projects current takes (stage 1e). Beside it,
  `unapprovedTakes(model, store, shots): {slot, hash}[]` in `@vn/export` lists every shot
  whose current take is unapproved and every cast character whose portrait is.
- `story.export`'s `check` (`commands/story.ts:1108-1116`) and `project.installPages`'s
  `check` (`commands/project.ts:461-493`) refuse when the list is non-empty, naming the
  first: "`shot:arrival/3` holds a take nobody has approved (`3f9a…`)". Their `run`s ask
  again and throw `VnError('UNAPPROVED', …)` with the same sentence, so `check` and `run`
  agree as the command system requires. The CLI's `export` prints the refusal. The in-app
  player (`session/pipeline.ts:18-27`) asks nothing. `site.ts:184`'s blank-frame fallback
  stays for a slot with no take at all.
- `vngen accept [dir] --hash=<h> | --all`: a new subcommand for non-portrait takes,
  through `acceptRefusal`, upstream first under `--all`. `vngen approve` stays
  portraits-only until stage 5 folds the two. The CLI is the only host where
  `vngen run && vngen export` has no other route to approval.
- `@vn/testkit`: `acceptAll()` beside `approveAll()` (`project.ts:280-297`), accepting
  every current unapproved take upstream first through the same rule. Every testkit test
  that exports calls it.
- Tests: the player builds with unapproved frames; `story.export`'s check refuses and its
  run throws the same sentence; CLI accept round trip; a testkit export after `acceptAll`.
- As built: the accept rule the CLI and the testkit share is `acceptableTakes(deps)`
  (every current unapproved non-portrait take, upstream first, with the refusal each would
  meet) and `acceptTake(deps, hash)` in `@vn/artgen`'s `takes.ts`, re-exported from
  `@vn/pipeline`; `vngen accept` with neither flag lists them. The session exposes
  `exportRefusal()` beside `exportPlayable()`, so both commands' `check`s ask one question
  and the run throws its answer. `unapprovedTakes` reads a portrait off the gate, as
  `assetBlessed` does until stage 5, and skips a character whose gate names an approved
  portrait, since that is what the playable shows for them.

## Stage 3 — `Shot.status` leaves the storyboard file

- Drop `status` from `Shot` (`packages/types/src/entities.ts:315`) and from `shotData` on
  write (`packages/store/src/shots.ts:224-238`); the schema (`schemas.ts:606`) makes the
  field `.optional()` on read so committed files parse. `refreshShotData`
  (`planner.ts:166-193`) and the runner (`runners.ts:311`, `:333`) stop writing it.
- The strip's CSS class (`renderer/pathux/editors/timeline.ts:605`) takes
  `shot.failure?.status ?? ''`; `story.ts:453` and `ipc.ts:464` drop the field.
- The field is required today, so every `Shot` literal carrying `status:` becomes an
  excess-property error: enumerate with
  `rg "status\s*:\s*'(accepted|generated|needs_human|prompted|pending)'"` across
  `packages/**/tests`, `apps/desktop/renderer/**` and `apps/desktop/src/shared/tests`
  (about twenty-five files, including `situations/page.ts:38`, `shotmenu.ts:22`,
  `linemenu.ts:21`, `page.test.ts:88,107,127`, `shots.test.ts:49`). The situations mean
  `pnpm gen:uxmodel` runs in this commit, and `timeline.ts` is an editor, so the anchor
  sweep is re-run.
- As built: about seventy literals across forty-five test and situation files, not
  twenty-five; `artgen/storyboard.ts` and `scriptedit/shotcreate.ts` stamped
  `status: 'pending'` on every new shot and stop. `readShots` writes `shotData` only when
  the shot has a `prompt` or an `image`, since `status` was the third thing that used to
  earn it a block. The legacy `status: 'accepted'` in `pipeline/src/tests/shots.test.ts`
  and `page.test.ts` stays as a read-only input, and the tests assert a rewrite drops it.
- As built: the re-swept `anchors.json` lists sixteen approvals-popup rows where the
  master sweep listed seventy-seven. The popup lists at most one row per slot since stage
  1, so the sixty-one that left were the older takes of slots that already hold a newer
  one; `asset.restore` gives way to `asset.accept` in the Asset pane for the same reason,
  and the `asset.replace` disagreement the master sweep recorded is no longer reported.
  The strays list differs by layout only.

## Stage 4 — an interactive graph run files a take

- `gengraph.run` (`session/gengraph.ts:377-440`) targeting a bound slot's active output,
  after the executor finishes: `store.write` the terminal picture with the task's metadata
  as `graphrun.ts` does, log the identity `done` with an attempt `via: 'graph'`, hold with
  `via: 'graph'`, write `Shot.image` for a shot. The writes are `adoptSlot`'s three plus
  the byte write, so the session needs `adoptSlot`'s deps in hand, which it has.
- The seeds come from `resolveSlot`'s inputs rather than `resolveBinding` over the
  manifest (`graphseeds.ts:58-76`), and the command's `check` runs `resolveSlot` and
  refuses when the identity cannot be stated, with `adoptSlot`'s sentences
  (`adoptslot.ts:147-166`). `graphseeds.ts:1-6`'s "an upstream picture not yet drawn is
  simply absent" is retired for a bound target: a record naming refs the graph did not
  draw from would forge provenance.
- Under `mock` (`gengraph.ts:386, 408`) the run stays journal-only: adoption refuses
  mock-marked bytes by name (`adoptslot.ts:188-193`), and so does this.
- Any other target — an unbound graph, a non-active output, an intermediate node — stays
  journal-only. The agent's `run_asset_graph` inherits the behaviour behind the same
  confirmation.
- `pnpm gen:uxmodel` and `command-table.md` regenerate for the changed `check`.
- Tests: a bound interactive run leaves the slot current and unapproved and the popup
  lists it; a following pipeline run resumes every node and renders nothing; an unbound
  run and a mock run write no row; a run whose identity cannot be stated refuses.
- As built: the writes live in `@vn/artgen` as
  `fileGraphDraw(deps, { bytes, ext, slot, prompt, modelId })`, beside `adoptSlot`, and
  the two share one private `file` routine; the session reads the terminal picture's bytes
  through `readDrawn` and its provenance through a new `drawOf` export in
  `packages/pipeline/src/graphrun.ts`. A portrait output is filed too, as a draft for the
  gate, which meant moving the `GATED_SLOT` refusal out of `resolve` and into adoption
  alone. `graphseeds.ts` became `graphRunPlan`, returning `Decided`;
  `GengraphPart.runTarget(slug, node)` is the one place the target, the seeds and the
  filed slot are decided, and the command's `check`, the agent host's `estimate` and
  `runGraph` all call it. A non-active output of a slot whose identity cannot be stated
  still runs unseeded, because it files nothing. The session under test is always `mock`,
  so the filed take is exercised through `fileGraphDraw` directly
  (`packages/artgen/src/tests/filedraw.test.ts`,
  `apps/desktop/src/main/tests/graphrun.test.ts`).

## Stage 5 — the portrait gate reads the row

Second stage of decision 8. Lands after stages 1–4, as its own commits.

- `accept` on a `portrait` row writes the mirror through
  `packages/store/src/worktree.ts:99-146`: `approved_portrait:` and `status: approved`
  onto `character.md`, and `approved.png`. `unaccept` on the row clears them, as
  `unapproveAsset` does today (`session/asset.ts:302-308`). `gate.approve`,
  `vngen approve` (now a synonym of `accept` for portraits), the testkit's `approve` and
  `vnauthor` all go through it. Choosing an older draft at the gate is a restore: hold,
  then accept.
- `edit_character` (`packages/authoring/src/tools/characters.ts:23,59-61`) and the
  desktop's `character.*` edit path can write `status: approved` straight into the sheet
  through `applyCharacterEdit` (`packages/model/src/serialize.ts:383`). `status` is
  removed from both edit schemas; `locked` is set through a `character.lock` command
  instead. A sheet-only `approved` on a project touched by an older tool is read as a
  mirror the row has not caught up with, and `repairCurrent` holds and accepts the sheet's
  hash when the row exists and no row of the slot is accepted — once.
- `isApproved(character, assets?)`: with a manifest, the portrait slot's current row is
  accepted, or `status: locked`; without one, the sheet's mirror. The mirror is a valid
  read because `accept` writes it in the same act, and it is what the pure-planning tests
  (`planner.ts:255-269`, `pipeline.test.ts`, `sheetkeys.test.ts`, `slotagreement.test.ts`)
  and the CLI's `status` use. `planTasks`'s `assets` stays optional for that reason.
- Readers that take the manifest: `sceneUnblocked`, `gateStatus`, `resolveSlot`
  (`slotgraph.ts:191`), `shotUpstream` (`:131`), `assetApproved`'s portrait branch, the
  planner's P4 and P5 gates (`planner.ts:300`, `:349`), `sheet.ts:206`, `concept.ts:62`,
  `graphseeds.ts:66,137`, `session/asset.ts:264-268`, `session/gate.ts:57`,
  `apps/cli/src/commands.ts:312,657`, `scheduler.ts:361,407,512`.
- `resolveBinding`'s `portrait` case reads the row like every other kind. The exporter's
  portrait fallback (`playable.ts:150-152`) goes.
- Behaviour change, stated: a portrait re-render (stage 1d holds it) makes the current
  portrait unapproved, so the gate closes until the author accepts the new draft or
  restores the old one. Sheets and shots already drawn stay done; nothing re-renders until
  a draft is accepted. Before this stage the gate keeps reading the sheet, so the change
  arrives with this stage, and the migration shape in 1c (approved A, later B) closes the
  gate on upgrade for that character until one click. `manifest.migrate` names each such
  character.
- `characters/<id>/candidates/` and the CLI sentence naming it are retired.
- Tests: the gate passes on an accepted current portrait and not on an accepted superseded
  one; a sheet mirror is written on accept and cleared on unaccept; `locked` holds without
  a row; a portrait re-render closes the gate and a restore reopens it; the sheet-only
  `approved` catch-up runs once.
- As built: the mirror is written by `AssetStore.accept` itself (`assetstore.ts`), which
  discovers the sheet through `discoverEntities` so a `wiki/` character is written where
  it lives, and only when the portrait row is current; `unaccept` clears it when the sheet
  names that hash, a `locked` sheet included. `approvedPortraitOf(character, assets?)` in
  `gate.ts` is the one reader, and `isApproved`, `sceneUnblocked`, `gateStatus`,
  `resolveSlot` (through a new optional `assets` on `SlotResolveContext`), `sheetSeeds`,
  the concept subject refs, the planner, the scheduler, the CLI and every session read go
  through it. `assetApproved` and `assetBlessed` lost their `model` argument, since a
  portrait now reads the same two bits. The lock command is
  `gate.lock(characterId, locked=true)` rather than the plan's `character.lock`: no
  `character.` namespace exists, and the gate is where the sheet's approval words are
  already owned; it refuses to lock an unapproved character and to unlock one that is not
  locked, and is palette-only. The exporter (`@vn/export`) may not import `@vn/artgen`, so
  `unapprovedTakes` keeps its own three-line read of the rule (current portrait row,
  `locked` exempt). `CharacterEdit` lost `status` for both hosts; `create_character` in
  `vnauthor` writes the template's `draft`. `packages/artgen/src/tests/gate.test.ts` and
  `store.test.ts` carry the tests, and the desktop's `session.test.ts` the lock; the
  fixtures in `prereq`, `slotgraph`, `refs`, `sheet`, `playable` and `slotagreement`
  gained the portrait row the sheet's hash had stood in for.

## Stage 6 — docs

Each sentence lands with the stage that makes it true; this list is the checklist.

- `docs/reference/pipeline-contracts.md`: **Acceptance is exclusive per slot** becomes
  **Currency is exclusive per slot**, with the repair rule and the blessed-basis predicate
  (stage 1); "the manifest records no render time" (`:161-163`) is retracted (stage 1);
  **`SlotNode.approved` means two things** collapses (stage 5); **the gate is a barrier**
  reads the row (stage 5); the adoption entry's "exactly once" (`:79-93`) names the three
  writers (stage 4); the `shotData` entry drops `status` (stage 3).
- `docs/reference/asset-stores.md`: the row fields, routing by kind with fall-through, the
  cross-root rule (stage 0), the sheet angle on the binding (stage 1).
- `docs/reference/gen-graphs.md:457-463` (stage 4); `docs/guides/cli.md` for `accept` and
  `export`'s refusal (stage 2); `docs/reference/document-tree.md` (stage 1);
  `docs/reference/command-table.md` and `command-namespaces.md` regenerate (stages 1, 4,
  5).
- `CLAUDE.md`'s one-line summaries under Core ideas and Command system follow the
  contracts doc.

## Crash windows

- Between a runner's `hold` and the scheduler's `logTask`: `current` is on new bytes and
  the task is `running`; restart puts `running` back to `pending`, the task re-runs, and
  the hold is rewritten. One re-render, no wrong state.
- Inside `adoptSlot` after `store.write` and before `logTask`: `current` moved, `output`
  still the old render; `repairCurrent` puts `current` back on the identity's output and
  the adoption is lost. The same window `Shot.image` has today.

## What it costs to undo

- Stage 0: a revert; nothing on disk changes shape.
- Stage 1: the added fields are ignored by the old reader (not zod-parsed), but a manifest
  written by the new code carries current-but-unaccepted frames the old exporter ships
  blank, the old popup lists, and the old `repairAccepted` un-accepts one of any pair of
  history-`accepted` rows. A revert therefore needs a reverse pass: accept every current
  row, clear `accepted` on every other. It is a script, not a rewrite, and it is the price
  of the one-way migration.
- Stage 2: a flag on two `check`s and a subcommand; a revert.
- Stage 3: removes a field old files still carry; undo is re-adding the writer.
- Stage 4: adds a writer; undo deletes it, and the rows it wrote stay valid.
- Stage 5: moves the gate's source. The sheet is a mirror written on every accept, so a
  revert reads sheets the new code kept true; the only loss is a sheet-only `approved`
  written by the catch-up, which the old code reads as approval anyway.

## Review findings

A fresh-context review of the first draft, per
[`../reference/conventions.md#plans`](../../reference/conventions.md#plans). Each finding
and what the plan does about it.

- **Stages 1–3 of the draft were not green on their own.** Removing `accept`'s `supersede`
  broke three callers assigned to later stages, and a `pick` reading `current` before any
  runner wrote it headed every regenerated slot with the old take within one `p.run()`
  (`session.test.ts:1398-1429`). Fixed: merged into one stage 1 with the reason stated.
- **`Approvable.settled` had five more readers than listed** and a committed
  `ux-model.json`. Fixed: listed, with the regeneration in the same commit.
- **`Shot.status` is a required field constructed in about twenty-five files**, not the
  three named. Fixed: the enumeration command, `gen:uxmodel` and the anchor sweep in that
  stage; `schemas.ts:606` is required today and becomes optional.
- **Making `planTasks`'s `assets` required breaks the pure-planning tests.** Fixed:
  `isApproved` takes an optional manifest and reads the sheet's mirror without one, since
  `accept` writes the mirror in the same act.
- **Decision 4's `asset.regenerate` consequence was dropped.** Fixed: 1d.
- **The migration ignored decision 3's `needs_human` rule.** Fixed: arm 2.
- **Decision 9 put the staleness exemption on the attempt's `via`, the draft on the
  row's**, and a later restore overwrote it. Fixed: `via` is the row's origin and never
  overwritten; restore records `via: 'restore'` on its attempt and stamps only `at`. The
  research doc's decision 9 wording is corrected to match.
- **Stage 5's claim that nothing writes the sheet directly was false**: `edit_character`
  can write `status: approved`. Fixed: `status` leaves the edit schemas, `character.lock`
  sets `locked`, and a sheet-only `approved` is caught up once.
- **`approvedAssets()` said `approved` where decision 2 says `accepted`.** Fixed: stated
  as `current ∧ approved` with the portrait reading named.
- **The migration never marked itself done**, because rows bound to no enumerable slot
  keep the trigger live. Fixed: `current: false` stamped on every untouched row.
- **Two accepted rows with a non-`done` identity ended with no current row, forever.**
  Fixed: arm 4.
- **Routing `hold`/`accept` by kind throws on a legacy project or an `unavailable` base**
  (`rootFor`, `assetstore.ts:314-322`). Fixed: route by kind, fall through to the root
  that holds the hash; a flag write never consults `rootFor`.
- **A row bound to two slots got an order-dependent answer**, and `heldBy` built on
  `slotOf` reads `satisfies[0]` only. Fixed: `heldBy` over all bindings; a multi-slot row
  is decided once.
- **The portrait fold un-approves a character on upgrade and on every re-render.**
  Recorded as intended behaviour with the reason (an unapproved current look is exactly
  what the P3 gate exists to stop spending on), named in `manifest.migrate`, and the
  restore is one click. The alternative, letting the sheet's approval pin `current` for
  portraits, is the "human beats machine" ranking the owner declined in decision 3.
- **The CLI and `vnauthor` never ran the repair.** Fixed: `migrateCurrent` and
  `repairCurrent` move to `@vn/artgen` so every host can call them, and both hosts do.
- **`RunDeps.now` is optional and the testkit passes none.** Fixed: a testkit `now`
  option.
- **`repairCurrent` needs `config` and the storyboards** for `resolveSlot`. Fixed: named
  in its deps.
- **`adoptSlot` had no clock and no `via` on its request.** Fixed: both named.
- **The accept rule lives in the desktop session**, which the CLI and testkit cannot
  import. Fixed: `acceptRefusal` in `@vn/artgen`.
- **`assetApproved = current ∧ accepted` made a frame unapprovable after its plate was
  regenerated**, with no way to approve the plate. Fixed: the blessed-basis predicate for
  prerequisites.
- **A throwing `buildPlayable` broke the `check`/`run` agreement of `story.export` and
  `project.installPages`.** Fixed: `buildPlayable` stays pure; `unapprovedTakes` feeds
  both `check`s and both `run`s.
- **`attemptOutcome` has no asset in hand.** Fixed: the label becomes `kept`, as decision
  12 allows.
- **`AssetInfo.accepted` is the raw flag and drives the editor's buttons.** Fixed:
  `current` and `approved` on `AssetInfo`, `assetview.ts:110` named.
- **A mock interactive run was undecided.** Fixed: journal-only under `mock`.
- **The draft's citations for the runner writes, `supersededBy`, the staleness line, the
  attempts test and the exporter fallback were off by a few lines, and "the two
  `attempts.ts` situations" named a file that does not exist.** Fixed.
- **Stage 5's reader list was short by nine sites.** Fixed.
- **"Stages 1–3 are a revert" was not honest.** Fixed: the reverse pass is stated.
- **`AssetStore.get(hash, root?)` added a parameter nothing calls.** Deleted.
- **`vngen approve --asset` collided with the existing `--hash`.** Fixed: a separate
  `vngen accept` subcommand until stage 5 folds the two.
- **Whether choosing an older draft at the gate is a restore, and whether `unaccept`
  clears the mirror**, were unstated. Fixed: both stated in stage 5.
- **Which stages regenerate `ux-model.json`, `anchors.json` and `command-table.md`** was
  unstated. Fixed: named per stage.

## Finishing checklist

Stages landed, each as its own green commit on the `slot-history` branch:

- [x] Stage 0 — cross-root adoption visible to its slot.
- [x] Stage 1 — the model.
- [x] Stage 2 — export refusal, `vngen accept`, `acceptAll`.
- [x] Stage 3 — `Shot.status` removed.
- [x] Stage 4 — interactive graph run files a take.
- [x] Stage 5 — portrait gate reads the row.

- [x] Comments audited in every file touched; no `CLAUDENOTE:` remains.
- [x] `docs/reference/pipeline-contracts.md`, `asset-stores.md`, `document-tree.md`,
      `gen-graphs.md`, `cli.md` and `CLAUDE.md`'s one-line summaries match the code.
- [x] `pnpm gen:uxmodel` run in every stage that touched a rule or a situation; the anchor
      sweep re-run after stages 3 and 5.
- [x] `docs/plans/index.md` row flipped and the file moved to `archive/`.

# Pipeline contracts

Lists the invariants of the generative pipeline that cost money or silently corrupt
provenance when they are broken. Each invariant is stated with the failure it prevents,
because most of them were written down after that failure happened.

These implement the system design in
[`../history/vn-generator-report.md`](../history/vn-generator-report.md).

The invariants are moving into code, each as a `contract({...})` declaration beside the
code that enforces it, and are deleted from this page as they move
([`../plans/contracts-into-code-and-workflows.md`](../plans/contracts-into-code-and-workflows.md)).
`pnpm contracts <query>` lists the ones already moved, and
`packages/contracts/contracts.json` holds them all. [`../../CLAUDE.md`](../../CLAUDE.md)
describes the package layering, and [`packages.md`](packages.md) describes it package by
package.

<!-- toc -->

- [Identity and storage](#identity-and-storage)
- [Scheduling](#scheduling)
- [Scenes, shots, and lines](#scenes-shots-and-lines)
- [Generation and review](#generation-and-review)
- [Seams](#seams)

<!-- tocstop -->

## Identity and storage

- **Content-addressed task graph.**
    - A task is identified by `sha256(kind, inputs)`, where inputs include the normalized
      prompt, ordered reference asset hashes, and params — but not the model id.
    - The model id is left out of the hash so that changing `models.image` in
      `project.yaml` does not re-key every task: a rendered slot keeps its picture, and
      the new model is used for slots not yet drawn, for a regenerate, and where a slot's
      own `model` override names it. A node that has not run yet takes the inputs of the
      latest planning pass (`TaskGraph.add`), so a pending task follows the project's
      current model; a `done` node keeps the inputs it ran with, and the asset records the
      model that drew it (`Asset.modelId`, always the author's spelling, never
      OpenRouter's) and, optionally, the key that carried the call (`Asset.transport`). A
      picture drawn through OpenRouter has the same identity as one drawn natively, so
      adding a vendor's key later redraws nothing.
    - `params` is `image_params` with the narrowest authored seed applied (`seedFor`) and,
      for a shot, its own `aspect` in place of the project's (`aspectFor`). Both return
      the project's params by identity when nothing was authored, so a project that
      authored neither hashes as it did before either field existed. The model id is
      resolved the same way (`modelFor`: the narrowest `imageModel` rung, else
      `models.image`) but, being outside the hash, changes nothing about identity.
    - A run can be narrowed to a set of targets. `RunOptions.only` restricts each wave to
      `closureOf(graph, targets)` — the targets and every task they depend on — so
      `asset.regenerate` and `pipeline.draw` draw one slot and what it still needs, and
      nothing else the plan holds. Planning is unchanged; only which ready tasks start is.
    - Identical work collapses to one node, so dedupe, resumability, and staleness come at
      no extra cost.
    - Every status transition is appended to `state/tasks.jsonl`. Replaying that log (last
      writer wins per hash) rebuilds the graph, so runs are crash-safe and resumable.
    - A tombstone takes a task out of the replayed graph. It is a full copy of the task's
      last record with `status: 'pending'`, no `output`, no `error`, and `removed: true`,
      written by `logTombstone` (`packages/taskgraph/src/maintain.ts`).
        - `loadGraph` leaves a hash out when its last record is a tombstone, so
          `vngen status` and the Task Graph pane stop counting it. A later task record for
          the same hash supersedes the tombstone, and the planner plans the task again.
        - The shape is the requeue's plus one field, so a build that predates tombstones
          replays one as a requeued task, with its `deps`. A bare `{ hash, removed }`
          record would reach that build's `topoOrder` with no `deps` array, and it would
          throw.
        - A line that does not parse still stops `readJsonl`, as any bad line does.
        - Plan:
          [`../plans/archive/deleting-things.md`](../plans/archive/deleting-things.md),
          stage 2.
- A base root that exists without a manifest is marked `unavailable`, and the run stops.
    - A checkout missing the base repo leaves the same state behind, and a check that only
      counts assets cannot distinguish it from "nothing generated yet".
    - The planner produces no plan when the root is `unavailable`, because every shot
      references a base plate.
    - The run reports a single sentence that names the root, rather than regenerating an
      approved library at cost.
- **The collector removes what nothing uses, and decides liveness per row.**
    - `collectProject` (`packages/gengraph/src/collect.ts`, over `planAssetCollection` in
      `@vn/artgen`) decides everything before anything is written; `applyCollection`
      applies it through a mover the host passes. `asset.collect` and the agent's
      `collect_unused_assets` are its two callers.
    - A row is kept when any of these holds:
        - its `satisfies` binds it to a slot the collector enumerates: plates and
          portraits as the slot graph enumerates them, sheets for every outfit a character
          defines or a scene names, and shots from **every** persisted storyboard, so an
          unwired scene keeps its frames;
        - its hash is the output, or an attempt's output, of an enumerated slot's task;
        - an `approved_portrait:`, a `Shot.image`, a pin, or a graph document or group
          definition names it (graph files are scanned as raw text for hashes, so one that
          does not parse still protects what it names);
        - it is a `concept` or a `reference`;
        - a kept row lists it in `refs`, transitively. Every take of a kept slot is kept,
          so a deleted character's portrait stays while an older frame drawn from it does.
    - A base row is a candidate only when its `sourceTask` is in this project's
      `tasks.jsonl`, so a shared `assets/` never loses another project's pictures.
    - It also removes files in an object folder no row lists, the journal and blob folder
      of a graph whose document is gone, and blobs no journal record names (with
      `oldAnswers`, blobs only superseded records name).
    - It tombstones each task whose output it removes, and each `failed` or `needs_human`
      slot task no enumerated slot names.
    - It refuses while an input fails to load, because a sheet that does not parse drops
      its entity from the model and that entity's art would look unused. A storyboard that
      does not parse keeps its scene's frames.
    - Order: tombstones, then both manifests, then the files, then graph state. A crash
      after the tombstones leaves files no row lists, which the next collection removes;
      base-row candidacy reads the raw latest records, tombstones included, so it can.
    - Undoing one re-appends each tombstoned task's replaced record with
      `restored: <ISO time>` added, which the graph reads as the record itself. How the
      desktop holds the files for that is in
      [`command-system.md`](command-system.md#a-sidecar-keeps-what-the-snapshot-cannot).
    - A base picture another project claims in `assets/claims/` is kept, and this
      project's own claim on one it no longer uses is dropped
      ([`repos-and-commits.md`](repos-and-commits.md#the-claims-ledger)).
    - `asset.recover` puts a collected picture back from git history and appends a copy of
      the last `done` record whose output is its hash, stamped `restored`, when that
      task's latest record is a tombstone. The copy restates a record the log already
      holds, so it is not a forged record: the picture it names is the one that task drew.
      ([`history-pane.md`](history-pane.md#missing-pictures))
    - Plan: [`../plans/archive/deleting-things.md`](../plans/archive/deleting-things.md),
      stages 7 and 8.

## Scheduling

- **The gate blocks shot planning, and reads the manifest row.**
    - The character-approval gate (P3) is not a task dependency. The planner enforces it
      by emitting shot tasks for a scene only once every character in that scene is
      approved.
    - A character is approved when the take their portrait slot holds is one a person
      accepted: `approvedPortraitOf(character, assets)` answers the current, accepted
      portrait row, and `isApproved`, `sceneUnblocked`, `gateStatus`, `resolveSlot` and
      the planner's P4 and P5 gates all read it. A re-render puts an unapproved draft in
      the slot, so the gate closes until the author accepts the draft or restores the
      approved take; nothing already drawn is touched.
    - The sheet is a mirror. `AssetStore.accept` on the portrait a slot holds writes
      `status: approved`, `approved_portrait:` and `approved.png` in the same act, and
      `unaccept` clears them when the sheet names that hash. A reader with no manifest in
      hand (a pure plan, `planTasks` without `assets`) reads the mirror, which is valid
      because nothing else writes it: `status` is not an editable field of a character,
      and a sheet an older tool approved by hand is caught up once by `repairCurrent`
      (hold and accept the hash it names, when that row exists and no row of the slot is
      accepted).
    - `status: locked`, set by `gate.lock`, is the one thing the sheet says on its own: it
      holds the character's approval with the hash the sheet names, whatever the slot
      comes to hold.
    - A `vngen run` halts at the gate with nothing left ready. Approving (`gate.approve`,
      `vngen approve`) holds the chosen portrait and accepts it, so choosing an older
      draft is a restore: `holdPortrait` logs the portrait task `done` with that draft
      when the log names other bytes, so the choice outlasts `repairCurrent`. The next
      `run` plans and executes the downstream work.
    - Scenes with no characters render immediately.
- **Incremental planning.**
    - The planner is called once per scheduler wave.
    - Tasks whose identity depends on an upstream output (a shot references its produced
      location plate) only appear after that upstream task is `done`.
    - `vngen cost` counts only the work that is plannable when it runs, and it undercounts
      tasks that become plannable after an earlier wave finishes.
- The graph enumerates slots rather than task hashes, because a `shot_image` hash is not
  known until its plate has rendered.
    - A `shot_image` hash cannot be computed until its plate has rendered, because
      `TaskInputs.shot_image.refs` embeds the upstream asset hashes and `taskHash` covers
      the whole inputs object.
    - So the project enumerates every picture it implies over the slot vocabulary that
      already exists in `@vn/stills`' `refcycle.ts`: `portrait:<id>`,
      `sheet:<id>/<outfit>/<angle>`, `plate:<loc>/<variant>`, `shot:<scene>/<shot>`.
      `refsOfSlot` supplies the edge rule. The planner attaches a real task identity only
      to the slots the project can currently state a task identity for.
    - `buildSlotGraph` and the planner must enumerate the same set. That is why
      `reachableScenes`/`allCharacters`/`usedOutfits`/`allLocationVariants` were lifted
      into `@vn/model`'s `used.ts`, and both sides call them. A test plans a mock project
      to exhaustion and asserts the two agree in both directions.
    - `SlotGraph.order` is topological, upstream first. Approval has to happen in that
      same order.
    - Never derive edges from `Task.deps`, which is documented as incomplete and is not
      hashed.
- Authoring a character or location produces a portrait or plate, because P2 and P3 plan
  every authored entity regardless of casting. It does not produce a model sheet, because
  P4 only fans out sheets for outfits actually used.
    - P2 and P3 enumerate over `allLocationVariants`/`allCharacters` (every authored
      location and character, cast or not) because a cast sheet is meant to be read and an
      author draws the cast before writing scenes for it.
    - P4 still fans out over `usedOutfits`, so an uncast character plans no sheets even
      once approved. A portrait takes one image call and a sheet takes three per outfit,
      and a sheet exists to be referenced by a shot that does not exist yet.
    - The gate is unchanged. `gateStatus` keeps its own reachable-scene walk, so an
      unapproved portrait for an uncast character halts nothing, and that portrait appears
      instead in the tree's _Awaiting approval_ branch.
    - Plan:
      [`../plans/archive/INDEX.md#drawing-a-character-before-a-scene-casts-them`](../plans/archive/INDEX.md#drawing-a-character-before-a-scene-casts-them).
- `SlotNode.approved` means one thing for every slot kind: the take the slot holds is
  accepted. A `portrait:` slot answers the same way, since the gate reads the row.
- **Currency is exclusive per slot.** A manifest row carries two bits. `current` says the
  slot holds this take; `accepted` says a person approved it. They are set by different
  acts and neither clears the other.
    - `pick` reads `current` and never `accepted`: one current candidate is the slot's
      take, two resolve to nothing (the slot reads as empty and everything drawn from it
      becomes unsettled), and a slot with a single candidate and no current row resolves
      to that candidate.
    - `AssetStore.hold(hash, supersede, stamp)` sets `current` on one row and clears it on
      the takes being replaced in the same manifest write; `heldBy` computes that list
      from every slot the row serves. It restamps `at` (the hold time) and writes `via`
      (`run | graph | adopt | promote | upload | migrated`) only where the row has none.
      `AssetStore.accept(hash)` sets `accepted` alone.
    - Every writer holds: the runners on a clean output and on the last output of a
      `needs_human` task (the flawed frame stays on screen), adoption, promotion, upload
      and restore through `adoptSlot`, and the gate and `vngen approve`, which hold and
      then accept. A run accepts nothing. A re-render leaves the approved take behind as
      history, `accepted` and not current.
    - Approved, for a plate, sheet or frame, is `assetApproved`: current and accepted. The
      prerequisite check reads `assetBlessed` — `accepted` alone — because a frame drawn
      from a plate that was approved and has since been superseded was still drawn from an
      approved plate. A portrait reads the same two bits. `acceptRefusal` refuses to
      accept a take its slot does not hold, naming `asset.restore`, which holds and then
      accepts.
    - A sheet binding written since takes were held carries its `angle`; an older row is
      told apart from its siblings through its task's inputs (`angleOf`), and a row with
      neither releases nothing when held, since four angles share one binding.
    - `current` is a cache of the task log. Where a slot's identity is `done`, its
      `output` is the take; where it is `needs_human`, its last output is; otherwise
      (`pending` after a re-key, `running`, `failed`) the row is authoritative.
      `repairCurrent` (`@vn/artgen`, re-exported from `@vn/pipeline`) runs on every open
      and every non-dry run, from the CLI's and `vnauthor`'s project load too: it rewrites
      the bit to what the log says and puts any slot left with two current rows back to
      one by `overHeld`'s keep rule (the storyboard's take for a shot, else the identity's
      output, else the newest `at`, else the lowest hash), logged as `manifest.repair`. A
      clean manifest is not written.
    - Validation is the one project read that skips the repair. `validateProject`
      (`@vn/gengraph/state`, with its asset half `validateAssets` in `@vn/artgen`) and the
      desktop's `readProject` open the manifests and the task log as they are on disk, so
      a slot with two current rows is reported rather than fixed. `project.validate` and
      the agent's `validate_project` write nothing.
    - `migrateCurrent` runs first, once per manifest, keyed on a row with no `current`
      field, and stamps every row: the identity's output, else the last `needs_human`
      output, else the one accepted candidate, else the newest by attempt time then lowest
      hash, else the sole candidate, with `via: 'migrated'`; every other row gets
      `current: false`. Logged as `manifest.migrate`, naming characters whose approved
      portrait is no longer the take the slot holds.
    - The row's `at` orders a slot's takes newest first (`newestFirst`); rows never
      stamped sort last, in hash order, and no surface may present one of those as the
      latest.
    - Publishing an unapproved current take is refused; watching one is not.
      `buildPlayable` projects what each slot holds and asks nothing, so the in-app player
      shows it; `unapprovedTakes` (`@vn/export`) lists every frame and cast portrait that
      would show unapproved, and `story.export`, `project.installPages` and `vngen export`
      refuse on the first of them with one sentence, the command's `check` and its `run`
      (`VnError('UNAPPROVED')`) alike. `vngen accept --hash | --all` and the testkit's
      `acceptAll` accept through `acceptTake`, the same rule `asset.accept` applies.
    - Plan:
      [`../plans/archive/slot-history-on-the-manifest-row.md`](../plans/archive/slot-history-on-the-manifest-row.md).
- **A storyboard is fetched only on an explicit request, and a fallback is never
  persisted.**
    - Once `work/shots/<sceneId>.json` is written it takes precedence permanently, and an
      absent file is the only signal meaning "decompose this scene". The batch reads that
      signal. A hand-placed first shot (`story.newShot`, the agent's
      `edit_scene op=newShot`, `write_storyboard`) writes the file and so removes the
      signal, which ends decomposition for that scene just as permanently.
    - `decomposeAll` (behind `vngen decompose` and `story.decomposeAll`) is additive and
      has no `force`. It skips a scene the model does not answer for and names that scene
      instead of writing `deterministicShots`. It refuses mock or unresolved keys by name.
    - `decomposeScene` returns a `source` and a `reason` instead of throwing for one
      reason: to make that last distinction reportable. Within one run, one scene at a
      time, a silent fallback means the deterministic-fallback contract is holding. Sixty
      scenes at once with a bad key would baseline the project permanently.
    - Plan:
      [`../plans/archive/INDEX.md#the-full-slot-graph-and-approving-upstream-first`](../plans/archive/INDEX.md#the-full-slot-graph-and-approving-upstream-first).
- **A terminal task records why, is retried once, and is reported from the live plan.**
  Each of the three rules fixes a separate defect. A `shot_image` failed, the reason
  existed only on a logger event nobody kept, the next run planned nothing for it, and the
  CLI printed `Gate cleared — all reachable shots generated.` over a scene with no art.
    - **The reason is persisted.** `Task.error` holds why a task reached a terminal
      non-`done` state. The scheduler passes `result.error` unconditionally, so `done`
      clears it and `needs_human` carries the P7 give-up sentence. A failure also pushes a
      `TaskAttempt` holding the same reason, so the failure appears in the causal chain
      FLOOR renders. The log line is a whole-node snapshot, so it already carries the
      field. Adding the field invalidates nothing, because `taskHash` covers `kind` and
      `inputs` and never covers mutable node state.
    - **A failed task is retried on the next run, bounded by `max_task_attempts`**
      (default 2, which allows one retry). This limit is separate from
      `max_refine_attempts`, which caps the P7 loop within a single run.
        - The requeue happens once, after the first planning pass and before the wave
          loop. Requeueing inside the loop would re-run a task against the same transient
          condition that just blocked it, and could spin.
        - The budget counts attempt records that carry an `error`. It never counts
          `attempts.length` (on a `needs_human` shot that field is a refine counter).
        - `needs_human` is never auto-retried, because it requests human attention rather
          than reporting a fault.
        - Every task the previous owner left at `running` returns to `pending` with
          `interrupted: true`, including superseded versions. Each wave intersects
          `ready()` with the current plan, even for an unrestricted run, so historical
          pending tasks cannot spend money. Recovery spends no failure budget.
        - A dry run requeues in memory and writes nothing, so `vngen cost` counts the
          retry that the dry run would perform and leaves no divergent log.
    - **The report is derived from the last planning pass, not from what this process
      happened to touch.**
        - `RunSummary.failed`/`needsHuman` are the live plan's terminal nodes, so a
          failure inherited from an earlier run still exits `vngen run` non-zero. A
          `needs_human` node does not, because that artifact exists and requires review.
        - Failed-task retries and the terminal report must intersect with the planned set.
          Nothing in production calls `TaskGraph.prune`, so `tasks.jsonl` accumulates
          orphaned nodes whenever a prompt or reference change rehashes a task, and a
          blind sweep would either pay again for art that no plan asks for or leave the
          exit code failing forever.
        - `vngen status` does not plan, so its counts include orphans.
    - **Stop takes effect before the next API request.** Requests already in flight
      settle, and their successful responses are written atomically under
      `vngen/state/requests/<execution-id>/` before the runner consumes them. An
      unfinished task returns to `pending`, marked interrupted, without a failure attempt.
      A task whose final request completed can finish its local bookkeeping. Provider
      backoff is interruptible; SDK retries are disabled in favor of the application's
      request-boundary retry policy.
    - The task's `checkpoint` identifies its execution journal. Resumption replays
      successful image and review responses, including independently completed parallel
      reviews, then makes only the remaining requests. Attempt-record indices prevent
      replay from duplicating refine attempts or overwriting failure records. Planning has
      its own resumable journal, and a stop cannot persist a fallback decomposition. Graph
      requests are scoped by node key and run key, alongside the graph's existing
      completed-node journal. Request arguments are hashed; binary responses remain
      binary. Changing task inputs or configuration starts a new execution, as does an
      explicit regeneration. Completed execution journals are removed after the terminal
      task record is durable; interrupted and failed executions retain them.
    - An immediate abort releases tasks without waiting for their requests. Late answers
      are fenced from response journals, attempt records, asset writes, slot holds and the
      task log.
    - **Each task keeps a diagnostic log, which is not provenance.** It lives at
      `vngen/state/tasklogs/<hash>.jsonl` and is gitignored, because it holds full model
      prompts and replies.
        - The log records provider retries, reviewer replies that did not parse, the error
          that stopped the task (with its causes), and every reviewer call in full: system
          prompt (stored once per file, by hash), prompt, image hashes, raw replies, error
          and duration. A reviewer's parsed verdict is not repeated there; it stays on
          `Task.attempts[n].reviews`.
        - Each entry carries its execution (`checkpoint.id`) and its 1-based attempt
          index. Appends are serialized per execution and drained by an abort like any
          other write.
        - Writes are best effort: a failed append never fails a task. Error text passes
          through `redactSecrets` (`@vn/util`) before it is written.
        - A reviewer call answered from the response journal is not made again, so it
          writes no second entry. A call that was re-made after a stop writes one, because
          it was a second paid call.
        - Nothing deletes a log. Clear finished deletes nothing, and a tombstone can be
          undone.
        - Producers reach the log through `withTaskLog` in `@vn/providers`, an
          `AsyncLocalStorage` scope the scheduler's `TaskLogFile` (`@vn/pipeline`) opens
          around each runner. The Tasks pane reads it through `pipeline:taskLog`.
    - Below these layers, the Gemini, Claude and OpenRouter backends retry a transient
      failure in place (429/5xx/transport, 3 attempts). They do not retry other failures:
      an unrecognized error is terminal by default, because three refusals cost three
      times what one refusal costs.
    - Plan:
      [`../plans/archive/INDEX.md#task-failure-visibility-and-retry`](../plans/archive/INDEX.md#task-failure-visibility-and-retry).

## Scenes, shots, and lines

- Shot decompositions are persisted rather than re-derived.
    - P5 is an LLM step, so re-running it would produce different shot ids (and therefore
      different task hashes) and regenerate art for no reason.
    - The planner writes each scene's decomposition to `work/shots/<sceneId>.json` and
      reads that file whenever it exists, calling `decomposeScene` only when no file
      exists. A file created by a hand-placed shot is read the same way, so placing the
      first shot for a scene by hand stops the planner from decomposing that scene.
    - (`decomposeScene` and its gauntlet are defined in `@vn/stills`' `storyboard.ts`,
      which holds generative policy shared with the agent's `propose_storyboard`.
      `propose_storyboard` cannot import the pipeline. `@vn/pipeline`'s `p5.ts` re-exports
      them.)
    - Every caller hands `decomposeScene` the project's `art_style`, `storyboard_notes`
      and `shot_form` (`storyboardStyle(config)`), which `decompSystem` places between the
      role and the answer format. A project that states none of them gets the prompt every
      earlier decomposition was made with. Because a decomposition is persisted, changing
      any of the three re-keys nothing; it reaches the next scene storyboarded.
    - `shot_form` (`frames`, the default, or `pages`) decides whether a new storyboard is
      single frames or manga pages of panels. Under `pages` the system prompt tells the
      model to make every shot a page and gains the page vocabulary (the template names
      with their panel counts, the camera vocabulary, the bound); under `frames` it never
      contains the word "panel", whatever the art style or the notes say, so the notes
      cannot turn frames into pages on their own. The notes bring the staging-sheet
      paragraph, and either brings the wider answer format. The agent's
      `propose_storyboard` reads the same field and takes a `form` argument that overrides
      it for one scene, which the agent passes only when the author explicitly asks for
      the other form. The desktop app writes the field through `project.setShotForm`, a
      dropdown on the Project pane.
    - The file is human-editable. A malformed file throws instead of being silently
      re-decomposed over.
    - Authored fields sit at the top level. Fields a run produced sit under `shotData`,
      which each pass rewrites wholesale. `tasks.jsonl` and `manifest.json` remain the
      authority, so the pipeline does not treat work as done when a shots file is restored
      from an old commit. `shotData` carries no `status`: whether a frame is drawn, held
      or approved is read from the manifest row (`current`, `accepted`) and the task log,
      and a file that still says `status` from before that change is parsed and never
      rewritten with it. The timeline colours a strip by `failure.status` alone.
    - Line ids the scene no longer contains are dropped with a warning. `buildShotPrompt`
      ignores `coversLines` on a frame, so coverage edits to a frame do not trigger a
      rehash. A page under `lettering: model` is the exception, below.
    - A shot with `panels` is a page: one image of several panels, each with an outline in
      page fractions, its own framing, camera and cast, and the lines it letters. A
      panel's subjects must be in the shot's `subjects`, or `readShots` refuses the file
      with `panel_subject_not_in_cast`; a covered line no panel letters is reported as
      `line_in_no_panel` and the page still renders. A page's prompt is built by
      `buildPageChunks`, and under `lettering: model` its lettered lines are in the prompt
      verbatim, so the text and its panel assignment are in the task hash: a coverage take
      on a page, or a line edit inside one, re-keys the page. Every host's coverage take
      says so through `letteredPagesNote`. `lettering` defaults to `runner`, since the
      Stage 2 live check found the default image model unfit for lettering and only the
      expensive ones fit; a project that wants the model to letter says so.
    - A panel's `bubbles` (`PanelBubble`: the line, an anchor, an optional tail, in page
      fractions) are authored and outside the prompt: no builder reads them, so
      `story.setBubbles` and the agent's `set_bubbles` (one rule, `setBubbles` in
      `@vn/scriptedit`) re-key nothing. A bubble's line must be one its panel letters;
      `readShots` drops a bubble whose line left the panel, and `setPanels` drops one
      whose line it moved to another panel, since the anchor was placed against the old
      one. The exporter copies them into the playable only under `lettering: runner`.
    - `shotData.panelBoxes` holds the panel boxes the reviewer measured on the accepted
      image, from `DefectReport.observed`, which the reviewer fills only for a page. It is
      derived, like `proseHash`, and a rerun that reports the same image leaves it alone.
      The runner matches every reviewer's boxes against the intended outlines
      (`matchPanels`, IoU at or above `LAYOUT_IOU`) and files a `layout` defect of its own
      only when none of them match, because a reviewer's measurement can be off while none
      invents a match for a wrong page; a page no reviewer measured gets no layout
      verdict. The boxes stamped are the matching reviewer's.
    - Dry runs read the file but never write it, so a real run never reuses a mock
      decomposition.
- **A prompt is a list of clauses.** An override edits that list rather than the prompt
  string.
    - Every builder in `@vn/stills` assembles a `PromptChunk[]`. Each clause is keyed,
      categorised, and carries an origin (a builder, or the document and field the
      sentence came from) that lets a surface offer a `⇱` to it. `renderPrompt` collapses
      that list with the same `.filter(Boolean).join(' ')` the flat builders used.
    - **Composes byte-identical prompts**: a project authoring no override composes the
      string character-for-character as it did before, so the feature leaves every
      existing task hash unchanged (packages/pipeline/src/tests/prompthash.test.ts pins
      the whole sorted list against a literal written before any of it).
    - An override is authored input, stored at the single rung that names the whole
      picture: `Character` for a portrait, the outfit entry for a sheet, the location
      variant for a plate, the `Shot` for a frame. It is never stored at a rung that only
      contributes a clause, so there is exactly one place to look.
    - Setting `mode` alone does not override the prompt: every mode falls back to the
      derived chunks when the shape it names is empty. Each writer calls
      `promptOverrideIsEmpty` to clear the key, so a sheet that was once edited does not
      keep an inert `prompt_override:`.
    - `TaskInputs.*.prompt` stays a flat string. `taskHash` hashes the whole inputs object
      with no allow-list, so a new key there would re-key every task in every project.
      `composePrompt` composes the prompt text, and a chunk reaches a hash only through
      that text.
    - Editing an override behaves like an art note rather than a scene edit. The edit is
      meant to cost money, and it re-keys precisely the tasks that rung reaches.
    - An agent-condensed prompt records the chunk list it condensed. When those chunks
      move, the prompt is held: `composePrompt` in `agent` mode returns the stored text
      unconditionally and never falls back to freshly rendered chunks, because falling
      back would re-render the asset the moment an unrelated note changed. The staleness
      is derived on read and reported on the pane, never stored and never silently
      resolved.
    - Plan:
      [`../plans/archive/INDEX.md#chunked-prompts`](../plans/archive/INDEX.md#chunked-prompts).
- **A reference attaches to a clause, pins a hash, and separately records its origin.**
    - A `ChunkRef` on a `PromptChunk` is evidence for that clause, so muting the clause
      also drops the reference.
    - A **linked** ref also carries a `RefBinding` naming the logical slot it was taken
      from (`plate:cafe/night`, `sheet:aiko/gala/front`, …). The ref and its binding stay
      separate on purpose: `refs` is inside the task hash, so pinning stops an upstream
      approval from silently re-rendering everything that points at it.
    - Authored refs are appended after the derived ones in `TaskInputs.refs`, because
      `canonicalJson` maps arrays positionally and any other order would re-key tasks that
      author none.
    - A ref with no binding is an upload. An upload pins itself and cannot drift.
- **Suspension is derived transitively and is never stored.**
    - When a slot moves, everything pinned to its old hash is suspended, along with
      everything downstream of that. The downstream walk carries a `visited` guard, so a
      cycle already on disk is reported rather than hanging. A suspended asset keeps its
      bytes, the run plans nothing new for it, and `asset.suspended` enumerates the
      suspended assets in dependency order.
    - A stored flag would have to be invalidated by every writer, and this design avoids
      that invalidation. A suspended asset refuses `accept` and `approve` by name, and
      `prompt.repin` clears the suspension.
    - `regenerate=false` re-approves. It swaps the pin, computes the newly-keyed task's
      identity from the state just written, and records the existing bytes as its output.
      Promotion rests on the same don't-forge-work bound.
- Editing a scene's prose never invalidates a frame's art, so drift has to be reported.
    - `buildShotPrompt` reads neither `coversLines` nor line text on a frame, because
      prose reaches only the P7 reviewer spec, which never enters a task's `inputs`.
      Retyping a covered line therefore rehashes nothing and re-renders nothing. The frame
      still illustrates words the scene no longer contains, and by default no check
      detects that. So the frame must be checked against the words it covers.
    - A page under `lettering: model` is the one exception: its lettered lines are in its
      prompt, so retyping one, or moving one between panels, re-keys the page. Drift on a
      page therefore only ever means a line that changed without changing the prompt,
      which under `lettering: runner` is every line.
    - `Shot.proseHash` records a hash of the covered lines' text at the moment the image
      was produced. The hash is persisted under `shotData`, is written only beside an
      image, and is stamped only when the bytes are new. A rerun that reports the same
      image therefore cannot re-baseline the prose beneath it or clear a drift nobody
      acted on.
    - `driftOf` (`packages/pipeline/src/drift.ts`) re-derives the comparison on every
      read. It returns `unrendered`, `current`, `drifted`, or `unknown`. A shot rendered
      before the field existed returns `unknown`, so it never reads as `current` or as
      `drifted`.
    - The value is derived rather than stored because `shotData` is rewritten wholesale
      each pass. A stored flag can be stale, restored from an old commit, or missed by an
      edit that took another path. The value is not the task hash, which is the hash prose
      cannot move.
    - The hash walks `scene.lines`, so reordering `coversLines` does not count as an edit
      while extending coverage does. The distinction turns on whether this frame
      illustrates the words it is against.
    - Every surface that can change prose must show the author the sentence before the
      commit (`story.setLineText`'s `check`) and the mark after the commit — see
      [`desktop-app-editors-story.md`](desktop-app-editors-story.md#shot-coverage).
    - Plan:
      [`../plans/archive/INDEX.md#line-editing-in-floor`](../plans/archive/INDEX.md#line-editing-in-floor).
- **Editing a generation graph invalidates the slots it draws. Editing prose does not.**
    - A bound graph runs the slot. Editing it never moves the task's hash, so the
      difference shows as drift instead.
    - `graphDrift` recomputes each active Output node's hash and compares it against the
      journal's last `done` record for that node. `requeueDrifted` (`@vn/scheduler`)
      returns every planned `done` or `needs_human` task whose bound graph has drifted to
      `pending`. It runs once per run, before the wave loop, and `RunSummary.redrawn`
      names the tasks it requeued.
    - A graph bound to a slot the built-in runner already drew has no `done` record for
      its output, so `graphDrift` reports nothing for it. `requeueDrifted` also requeues
      that slot's task, unless `isDefaultGraph` finds the graph equivalent to
      `defaultSlotGraph` for the slot, which draws what the built-in runner drew. The
      comparison uses authored hashes, so a default graph whose nodes were only moved or
      joined by unconnected nodes still counts as the default. The redraw writes the
      output's first `done` record, so it is asked for once.
    - Drift is measured on `authoredHashes`, which reads each host-seeded input (the
      derived prompt, task refs) as though nothing had been seeded onto it. It is not
      measured on the task's own `nodeHash`, because that hash includes the seeding and
      would report drift after every run whether or not anyone edited anything.
    - A successful redraw writes the graph's new authored hash into the journal, which
      clears the drift. That holds for a redraw the executor resumed from a cached answer
      as well as for one it drew: a node that resumes while its latest `done` record
      carries stale hashes writes a fresh `done` record under the current ones. Without
      that record an edit that leaves a node's output unchanged (adding an empty `{varC}`
      to a template) would keep the slot drifted and requeue it on every run. A failed
      redraw writes no such record, so the failure goes to `requeueFailed` and its own
      attempt budget rather than being requeued here forever.
    - The requeue happens at run time rather than at the graph write, because undo
      excludes `vngen/state/`. Undoing a graph edit restores the authored hash, so the
      drift disappears before anything is redrawn.
    - Reference: [`gen-graphs.md`](gen-graphs.md#identity-the-journal-and-drift). Plan:
      [`../plans/node-based-asset-generation.md`](../plans/node-based-asset-generation.md)
      (Stage 2; the plan overall is in progress).

## Generation and review

- **P7 generate→critique→refine loop** is folded into the `shot_image` runner (a
  documented deviation from the report's separate `vision_review`/`prompt_refine` nodes).
    - Each attempt generates, then every configured reviewer critiques against the shot
      spec and the verdicts are merged. A blocking verdict triggers a deterministic prompt
      refinement and another attempt. Attempts are capped at `config.max_refine_attempts`,
      after which the shot is flagged `needs_human`.
    - Every attempt is recorded on the task for provenance.
    - It also stops early when a refinement changes nothing. Refinement is deterministic,
      so an unchanged prompt means the critique repeated verbatim and the next attempt
      would issue the identical request. Spending the rest of the cap on that repeats the
      same request rather than refining it.

## Seams

- **Provider seams.**
    - The scheduler imports `Task`, `deps`, and `status`, and never imports a concrete
      provider.
    - Changing model ids in `project.yaml` swaps backends, and nothing else needs to
      change. A model id names its native vendor (`chatVendorFor`, `imageVendorOf` in
      `@vn/types`: a `<vendor>/<model>` id is OpenRouter's, `claude-…` is Anthropic's,
      anything else is Gemini's) and gains a transport from the keys that resolve
      (`chatRouteFor`, `imageRouteFor`): the native vendor's key when it resolves, else
      OpenRouter under the id's OpenRouter spelling (`openRouterIdFor`), else no route.
      Every table above the seam stays keyed by the native spelling (`nativeIdFor`). The
      image seam `createImageBackend` builds is a router that routes the `modelId` on each
      call's params, so a graph node naming another model draws with that model rather
      than the project's, and hands every result back under the id the caller sent. A
      model no key carries is refused with the `ConfigError` `missingRouteError` raises,
      naming both keys, before anything is paid for; `resolveRoutes` is the same refusal
      ahead of a run. An open conversation keeps the transport it started on, because the
      two APIs do not share a message format. Plan:
      [`../plans/openrouter-as-a-fallback-transport.md`](../plans/openrouter-as-a-fallback-transport.md).
    - Tests inject `RecordedChatBackend`/`StubImageBackend` (see `@vn/providers` `mock.ts`
      / `createMockProviders`) to exercise the contracts without network access. See
      [`../guides/testkit.md`](../guides/testkit.md).

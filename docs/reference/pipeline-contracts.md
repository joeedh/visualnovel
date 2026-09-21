# Pipeline contracts

Lists the invariants of the generative pipeline that cost money or silently corrupt
provenance when they are broken. Each invariant is stated with the failure it prevents,
because most of them were written down after that failure happened.

These implement the system design in
[`../history/vn-generator-report.md`](../history/vn-generator-report.md).
[`../../CLAUDE.md`](../../CLAUDE.md) describes the package layering, and
[`packages.md`](packages.md) describes it package by package.

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
- **Assets are content-addressed and stored in two separate roots.**
    - Image bytes are stored once per root. Base art (portraits, model sheets, location
      plates) is stored at `assets/objects/<hash>.<ext>`. Shot frames are stored at
      `vngen/build/assets/<hash>.<ext>`.
    - Each root's `manifest.json` indexes the provenance of the files under that root, so
      a base subtree that is its own git repo describes its own provenance.
    - Routing uses `AssetKind` and nothing else. Reads consult both; a hash both hold is a
      picture adopted across them, and the project row answers when it is a frame.
    - Manifest writes are serialized through a single-writer queue so parallel tasks don't
      race on the atomic rename (this matters on Windows).
    - Full statement: [`asset-stores.md`](asset-stores.md).
- A base root that exists without a manifest is marked `unavailable`, and the run stops.
    - A checkout missing the base repo leaves the same state behind, and a check that only
      counts assets cannot distinguish it from "nothing generated yet".
    - The planner produces no plan when the root is `unavailable`, because every shot
      references a base plate.
    - The run reports a single sentence that names the root, rather than regenerating an
      approved library at cost.
- A concept never gets a node in the graph, because `generateConcept` hashes the request
  rather than a planned task.
    - `generateConcept` writes an asset whose `sourceTask` is a hash of the request
      (prompt, params, refs) rather than a planned task.
    - Nothing consumes it. Every binding lookup outside the document tree filters by kind
      first, and the planner resolves a shot's plate by task hash rather than by manifest
      binding, so a concept bound to `{locationId: 'cafe'}` can never be mistaken for that
      location's plate.
    - A test covers this by checking that a project holding a concept plans exactly the
      tasks it planned before.
- **Adoption may write a `done` record outside the scheduler exactly once.**
    - `adoptSlot` logs a slot's own task `done` with the handed-in bytes as its output, so
      the next run adopts those bytes instead of rendering over them.
    - The identity is derived in the same call from the project as it stands, never from a
      passed hash. That bound makes this safe, because the identity can only mark done the
      one node whose output this image now is.
    - Adoption is refused in three cases: a `portrait:` slot (the P3 gate owns it),
      mock-marked bytes (mock art never becomes real output), and superseding a render
      that already holds the slot, which requires an explicit `replace` rather than a
      silent overwrite.
    - `promoteConcept` is one caller of this. Every other writer of a terminal record in
      the system ran that record itself.
    - Plans:
      [`../plans/archive/INDEX.md#adopting-an-uploaded-asset`](../plans/archive/INDEX.md#adopting-an-uploaded-asset),
      [`../plans/archive/INDEX.md#on-demand-concept-images`](../plans/archive/INDEX.md#on-demand-concept-images).

## Scheduling

- **The gate is a barrier.**
    - The character-approval gate (P3) is not a task dependency. The planner enforces it
      by emitting shot tasks for a scene only once every character in that scene is
      `approved`.
    - A `vngen run` halts at the gate with nothing left ready.
    - Approving (via `vngen approve`) flips `character.md`. The next `run` plans and
      executes the downstream work.
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
      already exists in `@vn/artgen`'s `refcycle.ts`: `portrait:<id>`,
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
- `SlotNode.approved` means two different things depending on the slot kind. This is
  deliberate.
    - A `portrait:` slot is approved when the character's `approvedPortrait` names it. The
      P3 gate makes this check and reads `approvedPortrait` from the model.
    - Every other slot is approved when the asset filling it has `accepted === true`.
    - The approval frontier exists to prevent conflating them.
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
      approved plate. A portrait's approval is the gate's until stage 5 of the
      slot-history plan. `acceptRefusal` refuses to accept a take its slot does not hold,
      naming `asset.restore`, which holds and then accepts.
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
      [`../plans/slot-history-on-the-manifest-row.md`](../plans/slot-history-on-the-manifest-row.md).
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
        - A planned task the log left at `running` is put back to `pending` at the same
          point, before the failed requeue. A run owns the graph while it lasts and hosts
          refuse a second run, so that state can only be a process that died mid-task;
          left alone, `ready()` never offers it again and `pipeline.draw` refuses it as
          "being drawn now". It spends no attempt budget, because no attempt was recorded.
        - A dry run requeues in memory and writes nothing, so `vngen cost` counts the
          retry that the dry run would perform and leaves no divergent log.
    - **The report is derived from the last planning pass, not from what this process
      happened to touch.**
        - `RunSummary.failed`/`needsHuman` are the live plan's terminal nodes, so a
          failure inherited from an earlier run still exits `vngen run` non-zero. A
          `needs_human` node does not, because that artifact exists and requires review.
        - Both the requeue and the report must intersect with the planned set. Nothing in
          production calls `TaskGraph.prune`, so `tasks.jsonl` accumulates orphaned nodes
          whenever a prompt or reference change rehashes a task, and a blind sweep would
          either pay again for art that no plan asks for or leave the exit code failing
          forever.
        - `vngen status` does not plan, so its counts include orphans.
    - Below these layers, the Gemini, Claude and OpenRouter backends retry a transient
      failure in place (429/5xx/transport, 3 attempts). They do not retry other failures:
      an unrecognized error is terminal by default, because three refusals cost three
      times what one refusal costs.
    - Plan:
      [`../plans/archive/INDEX.md#task-failure-visibility-and-retry`](../plans/archive/INDEX.md#task-failure-visibility-and-retry).

## Scenes, shots, and lines

- An entity is found by its tag, and the file it was found in accompanies it.
    - A character or set-location is any file whose front-matter declares
      `type: character` or `type: location`. Exactly three places are searched:
      `characters/<id>/character.md`, `locations/<id>.md`, and a walk of `wiki/**/*.md`.
    - In the two conventional directories the tag is implied by the directory and may be
      stated redundantly. Stating the tag for the other kind there raises an
      `entity_tag_conflict` error rather than overriding the directory, because a document
      changes kind only when the file moves.
    - In the wiki, a file is an entity only if it carries the tag. An untagged file
      belongs to the story bible and the walk skips it silently, which keeps the walk from
      treating every stray markdown file as an input.
    - Discovery yields an `EntityDoc` (`id`, `file`, parsed `doc`, raw `text`), and that
      path is the only location used to find the entity: `entityFile(docs, id)` is how
      `vngen approve`, the desktop session, testkit and `vnauthor`'s edit tools find their
      target, so a sheet filed in the wiki is edited and approved in the wiki. Rebuilding
      `characters/<id>/character.md` from an id failed, because it silently wrote a file
      that was not the one loaded.
    - `id:` stays in front-matter and must agree with the file's own name (the parent
      directory for a character sheet, the filename stem elsewhere). A mismatch raises an
      `entity_id_mismatch` error. Before this, `characters/ada/` could declare `id: ren`,
      which produced a character that no file on disk named.
    - When two files claim the same id, discovery emits a `duplicate_entity` warning
      naming both files, then prefers the conventional file over the wiki file, falling
      back to the lexicographically first path. The rule is fixed rather than a guess, and
      discovery reports every conflict it resolves.
    - Unparseable front-matter produces an `entity_file` diagnostic instead of throwing
      during the load. The diagnostic is an error under the conventional directories and a
      warning under the wiki, where the file was never known to be an entity. One
      hand-edited sheet must not fail the whole project load.
    - Plan:
      [`../plans/archive/INDEX.md#entity-discovery-by-meta-tag`](../plans/archive/INDEX.md#entity-discovery-by-meta-tag).
- **Each scene occupies one file, and the reader alone decides which files hold scenes.**
    - Authored scenes are `scenes/<id>.md`. The front matter is `scene: <id>` and nothing
      else, and the schema is closed, so a key the body owns (such as `next` or
      `location`) is an error. The body is a complete one-scene Fountain screenplay
      including its own heading.
    - The id comes from the filename and front-matter together, and the body cannot
      override it, so editing a file's prose does not rename it.
    - A directory has no document order, so `start:` in `project.yaml` names the entry
      scene rather than whichever file sorts first.
    - Nothing reads the older `screenplay/*.fountain` form. The old both-present error
      prevented a model built from one file while edits were written to the other, and
      that failure cannot happen once nothing builds scenes from the screenplay. A project
      holding a screenplay and no `scenes/` gets an error naming `vngen import`. A
      screenplay left beside chunks gets a warning to delete or rename it.
    - `loadInputs` (`packages/store/src/worktree.ts`) is the single place that decides,
      and that includes deciding which file is the leftover. It exports `findScreenplay`,
      which the importer calls too, so the file the reader complains about is the file the
      importer converts. Every writer takes its target list from the same `LoadedInputs`
      the model was built from, so no writer works from a different list.
    - Two further rules follow, and each one came from a failure:
        - a patch spanning several chunks is computed in full before anything is written
          (a splice refused on the third file must leave the first two exactly as they
          were), and
        - front-matter is spliced byte-exactly via `splitFrontMatter` rather than
          re-serialized, because re-serializing YAML silently drops the author's comments.
    - The plans are
      [`../plans/archive/INDEX.md#scene-chunk-files`](../plans/archive/INDEX.md#scene-chunk-files)
      and
      [`../plans/archive/INDEX.md#fountain-import-export`](../plans/archive/INDEX.md#fountain-import-export).
      The format itself is in
      [`fountain.md`](fountain.md#where-the-fountain-lives-project-specific).
- Shot decompositions are persisted rather than re-derived.
    - P5 is an LLM step, so re-running it would produce different shot ids (and therefore
      different task hashes) and regenerate art for no reason.
    - The planner writes each scene's decomposition to `work/shots/<sceneId>.json` and
      reads that file whenever it exists, calling `decomposeScene` only when no file
      exists. A file created by a hand-placed shot is read the same way, so placing the
      first shot for a scene by hand stops the planner from decomposing that scene.
    - (`decomposeScene` and its gauntlet are defined in `@vn/artgen`'s `storyboard.ts`,
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
      from an old commit.
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
- Reordering a shot means editing the prose, because a shot's order comes from the
  position of its lines.
    - `Shot` has no position field, because `sceneBeats` emits a `show` whenever the
      covering shot changes down `scene.lines`. Nothing needs renumbering, and no second
      ordering has to be kept in step with the prose.
    - `story.moveShot` therefore moves the block of lines the shot covers, and it writes
      through the same `@vn/scriptedit` path every other line edit takes.
    - A shot has a single position only if it is contiguous. If other shots draw inside
      the lines a shot covers, that shot is refused by name rather than interleaved
      silently.
    - The move changes no hash: ids stay the same, coverage stays the same, and every
      shot's covered lines keep their relative order. `proseHash` walks `scene.lines` in
      order, and that order is preserved within each shot, so no hash drifts and nothing
      re-renders.
    - Plan:
      [`../plans/archive/INDEX.md#shot-ordering-in-scenes`](../plans/archive/INDEX.md#shot-ordering-in-scenes).
- **A character inherits what it wears, and the inheritance chain is written down once.**
    - `outfitFor` (`packages/model/src/outfits.ts`) is the only function that resolves an
      outfit, and it checks three sources in order: a shot subject's own `outfit`, then
      the scene's `[[outfit: aiko=track]]` marker, then `character.defaultOutfit`.
    - A rung defers when a field is absent. A `ShotSubject` with no `outfit` inherits,
      which is why `deterministicShots` emits a shot without an `outfit`.
    - `ResolvedOutfit.origin` reports which rung answered, so a surface can name that rung
      instead of saying "inherited". `outfitText` falls back to the outfit id when nothing
      describes the outfit, so an author can name a wardrobe before writing any
      description of it.
    - This edit re-renders, unlike every other scene edit, and that is deliberate. The
      outfit is part of `buildShotPrompt`, so changing it rehashes exactly the shots it
      reaches and no others.
    - The sheet fan-out follows from the same function. `usedOutfits` in the planner is
      `{defaultOutfit} ∪ {scene markers} ∪ {shot overrides}` over reachable scenes, which
      is exactly `outfitFor`'s range over the model. A character that no reachable scene
      casts has no entry, so drawing every authored portrait does not also draw every
      authored turnaround. Authoring an outfit that nothing wears costs nothing, and a
      shot cannot depend on a sheet that nothing planned.
    - A subject out of its default takes that outfit's front sheet as a reference, and
      that reference depends on the subject's task. Only the front angle is used, because
      a frame needs the clothes rather than a turnaround. The reference reaches the
      planner a wave later than the marker did, in the same way that a shot waits on its
      location plate.
    - Plan:
      [`../plans/archive/INDEX.md#outfits-at-scene-and-shot-level`](../plans/archive/INDEX.md#outfits-at-scene-and-shot-level).
- **Art direction is authored and appended, and the re-render covers exactly what that
  direction reaches.**
    - `artNotes` is an optional free-text field at five rungs — `Character`, `Location`,
      `Shot`, each `Outfit`, each `LocationVariant`. The builders append it to what they
      derived, entity note first and the specific rung second, so the style preamble, the
      reference scaffolding and the closing "single illustrated frame" clause all survive.
    - The same five rungs carry an optional `seed` (`seedFor`, narrowest wins, in the
      hash) and an optional `imageModel` (`modelFor`, narrowest wins, outside the hash;
      front-matter key `image_model`). `art.setSeed` and `art.setModel` write them the way
      `art.setNotes` writes a note, and an empty value clears the rung back to inheriting.
      A slot a generation graph binds takes the graph node's own model and seed, so the
      override does not reach it.
    - The Wiki pane's sheet form is a second writer of the same keys, at every rung a
      sheet holds (`art_notes`, `seed`, `image_model` at the root and inside an outfit or
      a variant). It writes through `@vn/parse`'s front-matter codec rather than the
      `art.*` commands because those re-serialise the whole front matter and lose the
      author's comments, and the model reads the keys back identically from either writer;
      a blank box removes the key, so the byte-identical test below holds for a sheet
      edited through the form.
    - Setting a note costs money by design, like the outfit and unlike every scene edit.
      The note is in the prompt, so setting one re-keys precisely the tasks that rung
      reaches, and the next run re-renders them.
    - `buildShotPrompt` reads only `shot.artNotes`. An entity's note already appears in
      the plates and sheets that the shot references, so restating it here would repeat
      the same note twice.
    - Every builder ends in `.filter(Boolean).join(' ')`, so a project that authors no
      notes produces byte-identical prompts and re-keys nothing. The test worth having
      checks that byte-identical output, not the feature.
    - The agent reaches the same five rungs through the same refusals. `list_assets`,
      `art_notes` and `set_art_notes` share `@vn/artgen`'s rung parser and write path with
      the desktop's asset editor, and `describeAsset` (a plain vision question rather than
      the P7 `VisionReviewer`) lets the agent read a rendered asset back before proposing
      the next note. `regenerate_asset` is an injected `PipelineControl` capability that
      is always confirm-gated, and it refuses outright where the capability is absent (a
      bare REPL).
    - Plans:
      [`../plans/archive/INDEX.md#asset-names-and-the-asset-editor`](../plans/archive/INDEX.md#asset-names-and-the-asset-editor),
      [`../plans/archive/INDEX.md#agent-art-revision`](../plans/archive/INDEX.md#agent-art-revision).
- **A prompt is a list of clauses.** An override edits that list rather than the prompt
  string.
    - Every builder in `@vn/artgen` assembles a `PromptChunk[]`. Each clause is keyed,
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
- **The reference graph is kept acyclic at write time (over slots rather than hashes).**
    - `refCycle` runs in `prompt.addRef`'s precondition and refuses with the whole path
      named.
    - Hashes cannot cycle today, but bindings can. A cycle in this graph does not raise an
      error at run time. It leaves tasks that are never ready, so the run appears to do
      nothing.
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
- A node inside a group is identified by its key, not by its id alone.
    - Every graph's id counter starts at zero, so a node inside a group instance normally
      shares its id with a root node. `nodeKey` (`@vn/gengraph`'s `nodekey.ts`) names a
      node by its id chain from the root — `3/7` for node 7 inside instance 3 — and the
      hashes, the journal, the executor's target set and the cost walk are all keyed by
      it. A root node's key is its id, so keys in a graph with no groups are unchanged.
    - Every `node` prop on a `gengraph.*` command resolves through `resolveNodeKey`. The
      pane therefore writes an instance's override as `gengraph.setProp` on
      `<instance>/<id>`, and the agent's whole-graph rewrite keeps an instance under
      `group: <ref>`.
    - An edit inside an instance overrides a value. `decideGenEdit` refuses a structural
      edit there with the sentence `structuralEditsRefused` gives, because a structural
      edit belongs to the group's definition. Every `gengraph.*` editing command reaches
      that definition with its `group` prop and writes it as
      `vngen/work/graphs/lib/<ref>.json`. The renderer only reads that file.
    - See [`gen-graphs.md`](gen-graphs.md#groups) for the reference and
      [`../plans/archive/group-nodes-in-the-gen-graph-editor.md`](../plans/archive/group-nodes-in-the-gen-graph-editor.md)
      for the plan.
- **A staging sheet is in every member's identity, and is rerolled by its seed, never by
  force.**
    - A shot in a sheet group (`Shot.sheet`) carries
      `params.extra.sheet = sha256(sheet prompt, sheet ref hashes in order, group seed)`
      (`sheetKey` over `sheetSeeds`, in `@vn/artgen`), so anything the sheet is drawn from
      — the members and their order, each member's framing, cast and camera, the plate,
      the group's notes and seed — re-keys every member's task at once, and nothing else
      does. A shot outside a group carries no `extra`, so no pre-existing hash moved when
      the field arrived.
    - The seeds are derived from the project and the manifest, never from a task graph:
      the planner, the scheduled runner and `gengraph.run` call the same `sheetSeeds`, so
      the key the planner hashed is the sheet the runner seeds.
    - `gengraph.run` refuses `force` on a graph where a node feeds more than one output
      (`sharedAncestors`). The sheet feeds every member's crop and a crop spends nothing,
      so a forced run to one output would redraw the sheet for it alone while the other
      members' frames stayed cut from the old one, with nothing to re-key them. The reroll
      path is `story.setSheetGroup` changing the seed, which re-keys every member.
    - Every slot a graph binds shares the graph's one journal and one `Graph` object in a
      process, and `runBoundGraph` serialises the runs of one graph. Seeds are written
      onto the graph's own sockets, so two members running at once would read each other's
      prompt and references, and the sheet would be drawn once per member rather than once
      per group. The live check that found both is in
      [`manga-live-tests.md`](../research/manga-live-tests.md).
    - Reference: [`gen-graphs.md`](gen-graphs.md#slots-and-outputs). Plan:
      [`../plans/manga-style.md`](../plans/manga-style.md) (Decisions 14 to 17).
- **Renaming a node type's socket or prop requires a migration in the same commit.**
    - path.ux reconciles a loaded node against its definition by key. A file written
      before a rename loads with the old key kept as an orphaned socket, the link into
      that socket reaches nothing an author can see, and the renamed key sits at its
      default. The authored wiring is lost silently, and the hash changes, so the next run
      redraws the slot.
    - `migrateGraphJSON` (`@vn/gengraph/migrate`) replays the renames over the JSON before
      `readGraphFile` deserializes it, moving sockets, props, links, a group's forwarded
      rows, and the `{name}` tokens a template embeds.
    - A rename is declared as a `NodeMigration` on the type's `GenNodeSpec`.
      `registerGenNode` refuses a migration whose targets name nothing on the class or
      whose last step stops short of the declared `typeVersion`.
    - A rename takes two edits: bump `typeVersion`, and add the step that lands on it.
    - The file on disk keeps the old keys until something writes it back, which means the
      migration has to stay in place rather than being deleted a release later.
    - Reference: [`gen-graphs.md`](gen-graphs.md#node-types).
- **Editing a scene's heading invalidates art (unlike every other scene edit) and shows
  the cost before the edit runs.**
    - A location appears in a shot's task inputs twice (`buildShotPrompt` bakes
      `location.name` into the prompt, and the plate asset's hash leads the shot's
      `refs`). Rewriting a heading therefore rehashes every shot in the scene, and the
      next run re-renders them rather than reporting drift.
    - This inverts the contract stated above, so `ShotFallout` counts the case separately
      as `restaged` and never folds it into `drifted`.
    - `setHeading` (`packages/scriptedit/src/lineops.ts`) implements this. The heading is
      not a `SceneLine` but `location` + `locationVariant` + `headingPrefix`, which
      `headingOf` reassembles and `parseHeading` reads back, so no line id moves and no
      coverage changes.
    - It also restages every shot in the scene onto the new heading's variant, through the
      `relocated` channel on `LineOp`. `Shot.location` is a variant id persisted in
      `work/shots/<sceneId>.json`, and once written that value takes precedence
      permanently. The planner's `locationTask(…, shot.location, …)` `continue`s past a
      shot whose variant the new location does not declare, so that shot is skipped
      silently and permanently.
    - The prose still describes the old place, and nothing here fixes that. The op's own
      message says so and names the agent.
    - Surfaces display the cost rather than asking for confirmation: `story.setHeading` is
      deliberately not `confirm: true`, because a confirm command is never checked, and
      the check is what raises the warning.
- **Line ids are allocated and stored, and a read never writes.**
    - `Shot.coversLines` binds art to `${sceneId}:L<n>`, so an id derived from position
      re-points every shot below an inserted line. That re-pointing spends money and
      reports nothing.
    - `splitScenes` therefore prefers a `[[line: L4]]` note (a Fountain note leading the
      element it names) and allocates only for unmarked elements. Allocation starts from
      the scene's `[[nextline: 12]]` mark, raised past every id in use. A stale allocator
      is a bug, and it never justifies reusing an id.
    - Duplicate and dangling marks are `error` diagnostics.
    - Allocation happens in memory. Loading a project never allocates.
    - The `story.assignLineIds` command persists the ids (undoable,
      `apps/desktop/src/main/commands/story.ts` over `assignLineIds` in
      `packages/model/src/lineids.ts`). It patches surgically, adding only whole marker
      lines and re-parsing its own output, and it discards the patch unless the re-parse
      reproduces the same scenes line for line. A note inserted above a `CHARACTER` cue
      would turn that cue into action, and the lines below it would no longer parse as
      dialogue.
    - Plan:
      [`../plans/archive/INDEX.md#allocated-line-ids`](../plans/archive/INDEX.md#allocated-line-ids).
- Writing a scene to text and parsing it back returns the same scene:
  `parse(write(scene)) ≡ scene`.
    - `sceneToFountain` (`packages/model/src/serialize.ts`) writes from `Scene.lines`. It
      holds the same `fromDoc(toDoc(x)) ≡ x` round trip that the character and location
      serializers already hold, and a property test over the `@vn/testkit` scripts and
      hand-built scenes pins it the same way.
    - `Scene.body` was removed. Flattened prose cannot be separated back into its parts,
      because `NAME:` and an action paragraph containing a colon are the same string.
      Keeping the field would have encouraged a reconstruction it could not support.
    - The property holds because the model retains what Fountain says, which includes the
      heading's prefix, its time-of-day variant, and `transition`/`lyric`/`centered`
      lines. The location plate is generated from the variant, and reconstructing it
      turned `EXT. ROOFTOP - NIGHT` into `INT. ROOFTOP - DAY`.
    - `section`, `page_break` and dual dialogue remain dropped, and that is deliberate.
    - **Blank lines are structural.** A `[[…]]` marker line is not blank, so a cue always
      gets a blank line above it, nothing but a `[[line:]]` mark goes between a cue and
      its first dialogue line, and anything that could be read as another element is
      written in its forced form (`!`, `@`, `>`, `~`). `needsForcedAction` tests every
      alternative reading the parser has, not just the ones this writer's own layout would
      allow.
    - Byte-exactness is not achievable and is not a goal. The surgical patchers
      (`branchpatch.ts`, `lineids.ts`) still handle files the author wrote, because the
      formatting in those files is the author's.
    - Plan:
      [`../plans/archive/INDEX.md#lossless-scene-serialization`](../plans/archive/INDEX.md#lossless-scene-serialization).
- **P5 receives the scene as identified lines rather than prose.**
    - `coversLines` takes line ids, so `decomposeScene` enumerates the scene as
      `[<lineId>] <kind>/<speaker>: <text>` and requires that every line be assigned to
      exactly one shot.
    - Handing over flattened prose and a response template containing `"coversLines":[]`
      made the question unanswerable. The model copied the empty array, producing shots
      that were generated and never displayed.
    - `withCoverage` supplies the fallbacks. A decomposition that binds no real line falls
      back to the baseline, and an uncovered first line goes to the first shot, so a scene
      cannot open on a blank frame.
    - See
      [`../plans/archive/INDEX.md#shot-timeline-editor`](../plans/archive/INDEX.md#shot-timeline-editor).

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
- The reviewer sees only what `shotSpec` requests, not the scene's full contents.
    - `shotSpec` (`packages/pipeline/src/prompts.ts`) describes the shot's own framing,
      location and cast, and marks the prose of its covered lines as "context only".
      `spec.characters` determines who must be in frame, and an empty `spec.characters`
      means a missing character is not a defect.
    - `Shot.castOptional` exempts a shot that does have a cast from the same trap. The
      subjects stay on the shot, so the character sheets still reach the generator as
      references, but `shotSpec` hands the reviewer an empty `characters` and the
      description states that an absence is not a defect. Without `Shot.castOptional`, a
      frame the reviewer will never accept (a figure seen from behind, a crowd, a hand)
      spends the whole cap and lands on `needs_human`. The field is part of the prompt, so
      setting it re-renders that frame. `story.requireCast` writes the field, normally
      from the Shot Coverage strip.
    - Handing over the scene synopsis instead made every background plate fail for the
      characters the scene mentions but the shot never ordered. No plate could satisfy
      that request, so the loop used every attempt and ended at `needs_human`.
    - `shotSpec`'s output never enters a task's `inputs`, so nothing is rehashed.
- **Deterministic fallbacks.**
    - Text steps (P1 location enrichment, P5 shot decomposition) use the LLM with
      structured-output enforcement but fall back to a deterministic baseline when a step
      fails, so the whole pipeline runs end-to-end with mock providers and no API calls.
    - P5's baseline is one establishing shot carrying the scene's cast plus one medium
      shot per character. A scene with no cast gets a bare plate, because the establishing
      shot covers the narration and action beats, and those beats describe the characters
      doing things.
    - This changes the prompt, so it rehashes establishing tasks. Shots are persisted, so
      an existing project keeps its old decomposition until `vngen/work/shots/*.json` is
      deleted or edited.

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

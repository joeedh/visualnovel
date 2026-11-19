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

## Scheduling

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

- **A storyboard is single frames or manga pages, and a page's panels carry their own cast
  and lines.** That a storyboard is decomposed once and kept is `storage.storyboardKept`
  (`pnpm contracts storage.storyboardKept`).
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

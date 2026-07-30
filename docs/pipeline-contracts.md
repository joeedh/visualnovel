# Pipeline contracts

The load-bearing invariants of the generative pipeline — the ones that cost money or silently
corrupt provenance when they are broken. Each is stated with the failure it prevents, because
most of them were written down after that failure happened.

The system design these implement is [`vn-generator-report.md`](vn-generator-report.md); the
package layering that carries them is in [`../CLAUDE.md`](../CLAUDE.md).

<!-- toc -->

- [Identity and storage](#identity-and-storage)
- [Scheduling](#scheduling)
- [Scenes, shots, and lines](#scenes-shots-and-lines)
- [Generation and review](#generation-and-review)
- [Seams](#seams)

<!-- tocstop -->

## Identity and storage

- **Content-addressed task graph.** A task's identity is `sha256(kind, inputs)` where inputs
  include the normalized prompt, ordered reference asset hashes, model id, and params.
  Identical work collapses to one node → dedupe, resumability, and staleness for free. Every
  status transition is appended to `state/tasks.jsonl`; replaying it (last writer wins per
  hash) rebuilds the graph, which makes runs crash-safe and resumable.
- **Content-addressed asset store.** Image bytes are stored once at
  `build/assets/<hash>.<ext>`; `manifest.json` is the provenance index. Manifest writes are
  serialized through a single-writer queue so parallel tasks don't race on the atomic rename
  (this matters on Windows).

## Scheduling

- **Gate-as-barrier.** The character-approval gate (P3) is not a task dependency — it's
  enforced by the planner: shot tasks for a scene are only emitted once every character in
  that scene is `approved`. A `vngen run` naturally halts at the gate with nothing left ready.
  Approving (via `vngen approve`) flips `character.md`; the next `run` plans and executes the
  downstream work. Scenes with no characters render immediately.
- **Incremental planning.** The planner is called once per scheduler wave. Tasks whose
  identity depends on an upstream output (a shot references its produced location plate) only
  appear after that upstream task is `done`. Consequence: `vngen cost` is a snapshot of
  _currently-plannable_ work and undercounts tasks that only become plannable after an earlier
  wave finishes.
- **A terminal task records why, is retried once, and is reported from the live plan.** Three
  rules, each of which was a separate defect: a `shot_image` failed, the reason existed only on a
  logger event nobody kept, the next run planned nothing for it, and the CLI printed `Gate
  cleared — all reachable shots generated.` over a scene with no art. (1) **The reason is
  persisted.** `Task.error` holds why a task reached a terminal non-`done` state — the scheduler
  passes `result.error` unconditionally, so `done` clears it and `needs_human` carries the P7
  give-up sentence — and a failure also pushes a `TaskAttempt` bearing it, so the failure appears
  in the causal chain FLOOR renders. The log line is a whole-node snapshot, so it carries the
  field for free. Adding it invalidates nothing: `taskHash` covers `kind` and `inputs`, never
  mutable node state. (2) **A failed task is retried on the next run, bounded by
  `max_task_attempts`** (default 2 — one retry; orthogonal to `max_refine_attempts`, which caps
  the P7 loop _within_ one run). The requeue happens **once, after the first planning pass and
  before the wave loop** — requeueing inside the loop would re-run a task against the same
  transient condition it just lost to, and could spin. The budget counts **attempt records that
  carry an `error`**, never `attempts.length`, which on a `needs_human` shot is a refine counter.
  `needs_human` is never auto-retried: it is a request for a human, not a fault. A dry run
  requeues in memory and writes nothing, so `vngen cost` counts the retry it would perform
  without leaving a divergent log. (3) **The report is derived from the last planning pass, not
  from what this process happened to touch.** `RunSummary.failed`/`needsHuman` are the live plan's
  terminal nodes, so a failure inherited from an earlier run still exits `vngen run` non-zero
  (`needs_human` does not — that artifact exists and wants review). Both the requeue and the
  report **must** intersect with the planned set, because `TaskGraph.prune` is called by nothing
  in production: `tasks.jsonl` accumulates orphaned nodes whenever a prompt or reference change
  rehashes a task, and a blind sweep would either re-buy art nothing wants or fail the exit code
  forever. `vngen status` does not plan, so its counts _do_ include orphans. Below all of this,
  the Gemini and Claude backends retry a transient failure in place (429/5xx/transport, 3
  attempts) and refuse to retry anything else — an unrecognized error is terminal by default,
  since three refusals cost three times one refusal. Plan:
  [`plans/task-failure-visibility-and-retry.md`](plans/task-failure-visibility-and-retry.md).

## Scenes, shots, and lines

- **A scene is one file, and only the reader decides which files those are.** Authored scenes are
  `scenes/<id>.md`: front-matter that is `scene: <id>` and nothing else (a closed schema — a key
  the body owns, like `next` or `location`, is an error), over a body that is a complete one-scene
  Fountain screenplay including its own heading. The id comes from the filename and front-matter
  together and the body cannot override it, so a file cannot be renamed by editing its prose. A
  directory has no document order, which is why the entry scene is `start:` in `project.yaml`
  rather than whichever file sorts first. The older `screenplay/*.fountain` form is **not read at
  all**: the failure the old both-present error prevented — a model built from one file and edits
  written to the other — cannot happen once nothing builds scenes from the screenplay, so a project
  holding one and no `scenes/` gets an error naming `vngen import`, and one left beside chunks gets
  a warning to delete or rename it. `loadInputs` (`packages/store/src/worktree.ts`) is the single
  place that decides — including *which* file is that leftover, via the exported `findScreenplay`
  the importer calls too, so the file the reader complains about is the file the importer converts;
  every writer takes its target list from the same `LoadedInputs` the model was built from, so
  nothing gets a second opinion. Two further rules follow, and both were failures first: a patch
  spanning several chunks is **computed in full before anything is written** (a splice refused on
  the third file must leave the first two exactly as they were), and front-matter is spliced
  byte-exactly via `splitFrontMatter` rather than re-serialized, because re-serializing YAML
  silently drops the author's comments. Plans:
  [`plans/scene-chunk-files.md`](plans/scene-chunk-files.md) and
  [`plans/fountain-import-export.md`](plans/fountain-import-export.md); the format itself is in
  [`fountain.md`](fountain.md#where-the-fountain-lives-project-specific).
- **Shot decompositions are persisted, not re-derived.** P5 is an LLM step, so re-running it
  would produce different shot ids — hence different task hashes — and regenerate art for no
  reason. The planner writes each scene's decomposition to `work/shots/<sceneId>.json` and
  prefers it forever after; it only calls `decomposeScene` when no file exists. The file is
  human-editable, and a malformed one throws rather than being silently re-decomposed over.
  Authored fields sit at the top level; what a run produced is nested under **`shotData`** and
  rewritten wholesale each pass — `tasks.jsonl` and `manifest.json` stay the authority, so a
  shots file restored from an old commit cannot convince the pipeline that work is done. Line
  ids the scene no longer has are dropped with a warning, and since `buildShotPrompt`
  ignores `coversLines`, coverage edits rehash nothing. Dry runs read the file but never write
  it — a mock decomposition must not be left for a real run to reuse.
- **No edit to a scene invalidates art — which is why drift has to be reported.**
  `buildShotPrompt` reads neither `coversLines` nor line text (prose reaches only the P7 reviewer
  spec, which never enters a task's `inputs`), so retyping a covered line rehashes nothing and
  re-renders nothing: the frame goes on illustrating words the scene no longer contains, and by
  default nothing notices. So the frame is made answerable for its words. `Shot.proseHash` records a
  hash of the covered lines' text at the moment the image was produced — persisted under `shotData`,
  written **only beside an image**, and stamped only when the bytes are new, so a rerun that reports
  the same image cannot re-baseline the prose beneath it and silently clear a drift nobody acted on.
  `driftOf` (`packages/pipeline/src/drift.ts`) re-derives the comparison on every read: `unrendered`,
  `current`, `drifted`, or `unknown` for a shot rendered before the field existed, which must never
  read as either answer. Derived rather than stored because `shotData` is rewritten wholesale each
  pass — a flag can be stale, restored from an old commit, or missed by an edit that took another
  path — and **not** the task hash, which is precisely the hash prose cannot move. The hash walks
  `scene.lines`, so reordering `coversLines` is not an edit but extending coverage is: the question
  is whether this frame illustrates the words it is against. Every surface that can change prose owes
  the author the sentence before the commit (`story.setLineText`'s `check`) and the mark after it —
  see [`desktop-app.md`](desktop-app.md#coverage-timeline-floor). Plan:
  [`plans/line-editing-in-floor.md`](plans/line-editing-in-floor.md).
- **Line ids are allocated and written down, and reading never writes.** `Shot.coversLines`
  binds art to `${sceneId}:L<n>`, so an id derived from position silently re-points every shot
  below an inserted line — money spent, nothing reported. `splitScenes` therefore prefers a
  `[[line: L4]]` note (a Fountain note leading the element it names) and allocates only for
  unmarked elements, from the scene's `[[nextline: 12]]` mark raised past every id actually in
  use — a stale allocator is a bug, not a licence to reuse an id. Duplicate and dangling marks
  are `error` diagnostics. Allocation happens **in memory**: loading a project never touches
  it. Persisting is `story.assignLineIds` (undoable,
  `apps/desktop/src/main/commands/story.ts` over `assignLineIds` in
  `packages/model/src/lineids.ts`), a surgical patcher that adds only whole marker lines and
  re-parses its own output, discarding the patch unless it reproduces the same scenes line for
  line — a note above a `CHARACTER` cue would turn it into action and un-speak the dialogue
  below it. Plan: [`plans/allocated-line-ids.md`](plans/allocated-line-ids.md).
- **A scene survives a trip through text: `parse(write(scene)) ≡ scene`.** `sceneToFountain`
  (`packages/model/src/serialize.ts`) writes from `Scene.lines` — the sibling of the
  `fromDoc(toDoc(x)) ≡ x` the character/location serializers already give, and pinned the same
  way, by a property test over the `@vn/testkit` scripts and hand-built scenes. `Scene.body` is
  **gone**: flattened prose cannot be told back apart (`NAME:` and an action paragraph
  containing a colon are the same string), so keeping it invited exactly the reconstruction it
  could not support. What makes the property hold is that the model retains what Fountain says
  — the heading's prefix _and_ its time-of-day variant (the variant is what the location plate
  is generated from; reconstructing it turned `EXT. ROOFTOP - NIGHT` into `INT. ROOFTOP - DAY`),
  plus `transition`/`lyric`/`centered` lines. `section`, `page_break` and dual dialogue stay
  dropped, deliberately. **Blank lines are structural** and a `[[…]]` marker line is not blank,
  so a cue always gets a blank above it, nothing but a `[[line:]]` mark goes between a cue and
  its first dialogue line, and anything that could be read as another element is written in its
  forced form (`!`, `@`, `>`, `~`) — `needsForcedAction` tests every alternative reading the
  parser has, not just the ones this writer's own layout would allow. Byte-exactness is neither
  achievable nor wanted: the surgical patchers (`branchpatch.ts`, `lineids.ts`) still handle
  files the author wrote, because their formatting is theirs. Plan:
  [`plans/lossless-scene-serialization.md`](plans/lossless-scene-serialization.md).
- **P5 is shown the scene as identified lines, not prose.** `coversLines` asks for line ids, so
  `decomposeScene` enumerates the scene as `[<lineId>] <kind>/<speaker>: <text>` and requires
  every line be assigned to exactly one shot. Handing over flattened prose and a response
  template containing `"coversLines":[]` made the question unanswerable, and the model did the
  only thing it could — copied the empty array, producing shots that were generated and never
  displayed. `withCoverage` is the backstop: a decomposition binding no real line falls back to
  the baseline, and an uncovered first line goes to the first shot so a scene cannot open on a
  blank frame. See [`plans/shot-timeline-editor.md`](plans/shot-timeline-editor.md).

## Generation and review

- **P7 generate→critique→refine loop** is folded into the `shot_image` runner (a documented
  deviation from the report's separate `vision_review`/`prompt_refine` nodes). Each attempt
  generates, has every configured reviewer critique against the shot spec, and merges verdicts;
  a blocking verdict triggers a deterministic prompt refinement and another attempt, capped at
  `config.max_refine_attempts`, after which the shot is flagged `needs_human`. Every attempt is
  recorded on the task for provenance. It also **stops early when a refinement changes
  nothing** — refinement is deterministic, so an unchanged prompt means the critique repeated
  verbatim and the next attempt would issue the identical request; spending the rest of the cap
  on that is a re-roll, not a refinement.
- **The reviewer is told what the _shot_ ordered, not what the scene contains.** `shotSpec`
  (`packages/pipeline/src/prompts.ts`) describes the shot's own framing, location and cast, and
  demotes the prose of its covered lines to "context only"; `spec.characters` is the authority
  on who must be in frame, and an empty one says outright that a missing character is not a
  defect. Handing over the scene synopsis instead made every background plate fail for the
  characters the scene mentions but the shot never ordered — unsatisfiable, so the loop burned
  every attempt and landed on `needs_human`. `shotSpec`'s output never enters a task's
  `inputs`, so this rehashes nothing.
- **Deterministic fallbacks.** Text steps (P1 location enrichment, P5 shot decomposition) use
  the LLM with structured-output enforcement but fall back to a deterministic baseline on any
  failure, so the whole pipeline runs end-to-end with mock providers and no API calls. P5's
  baseline is one establishing shot **carrying the scene's cast** plus one medium shot per
  character; only a cast-less scene gets a bare plate, since the establishing shot covers the
  narration and action beats and those describe the characters doing things. Because this
  changes the prompt it rehashes establishing tasks — but shots are persisted, so an existing
  project keeps its old decomposition until `vngen/work/shots/*.json` is deleted or edited.

## Seams

- **Provider seams.** The scheduler never imports a concrete provider — only `Task`, `deps`,
  `status`. Backends are swapped purely by changing model ids in `project.yaml`. Tests inject
  `RecordedChatBackend`/`StubImageBackend` (see `@vn/providers` `mock.ts` /
  `createMockProviders`) to exercise the contracts without network — see
  [`testkit.md`](testkit.md).

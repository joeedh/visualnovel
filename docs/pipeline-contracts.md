# Pipeline contracts

The load-bearing invariants of the generative pipeline — the ones that cost money or silently
corrupt provenance when they are broken. Each is stated with the failure it prevents, because
most of them were written down after that failure happened.

The system design these implement is [`vn-generator-report.md`](vn-generator-report.md); the
package layering that carries them is in [`../CLAUDE.md`](../CLAUDE.md).

<!-- toc -->

- [Identity and storage](#identity-and-storage)
- [Scheduling](#scheduling)
- [Shots, lines, and the screenplay](#shots-lines-and-the-screenplay)
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

## Shots, lines, and the screenplay

- **Shot decompositions are persisted, not re-derived.** P5 is an LLM step, so re-running it
  would produce different shot ids — hence different task hashes — and regenerate art for no
  reason. The planner writes each scene's decomposition to `work/shots/<sceneId>.json` and
  prefers it forever after; it only calls `decomposeScene` when no file exists. The file is
  human-editable, and a malformed one throws rather than being silently re-decomposed over.
  Authored fields sit at the top level; what a run produced is nested under **`shotData`** and
  rewritten wholesale each pass — `tasks.jsonl` and `manifest.json` stay the authority, so a
  shots file restored from an old commit cannot convince the pipeline that work is done. Line
  ids the screenplay no longer has are dropped with a warning, and since `buildShotPrompt`
  ignores `coversLines`, coverage edits rehash nothing. Dry runs read the file but never write
  it — a mock decomposition must not be left for a real run to reuse.
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

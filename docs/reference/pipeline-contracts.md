# Pipeline contracts

The load-bearing invariants of the generative pipeline — the ones that cost money or silently
corrupt provenance when they are broken. Each is stated with the failure it prevents, because
most of them were written down after that failure happened.

The system design these implement is [`../history/vn-generator-report.md`](../history/vn-generator-report.md); the
package layering that carries them is in [`../../CLAUDE.md`](../../CLAUDE.md), package by package in
[`packages.md`](packages.md).

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
- **Content-addressed asset store, in two roots.** Image bytes are stored once per root —
  base art (portraits, model sheets, location plates) at `assets/objects/<hash>.<ext>`, shot
  frames at `vngen/build/assets/<hash>.<ext>` — and each root's `manifest.json` is the
  provenance index for its own bytes, so a base subtree that is its own git repo carries its
  own meaning. Routing is by `AssetKind` and nothing else; reads consult both, base first.
  Manifest writes are serialized through a single-writer queue so parallel tasks don't race on
  the atomic rename (this matters on Windows). Full statement:
  [`asset-stores.md`](asset-stores.md).
- **A base root that exists without a manifest is `unavailable`, and stops the run.** That is
  the shape a checkout missing the base repo leaves behind, and it is indistinguishable from
  "nothing generated yet" to anything that only counts assets. The planner plans **nothing**
  when it sees it — every shot references a base plate too — and the run reports one sentence
  naming the root instead of regenerating an approved library at cost.

- **A concept has no node in the graph, and that is the whole of its contract.**
  `generateConcept` writes an asset whose `sourceTask` is a hash of the request — prompt, params,
  refs — and never a task that was planned. Nothing consumes it: every binding lookup outside the
  document tree filters by kind first, and the planner resolves a shot's plate by **task hash**
  rather than by manifest binding, so a concept bound to `{locationId: 'cafe'}` can never be
  mistaken for that location's plate. The test that states this is that a project holding a concept
  plans exactly the tasks it planned before.
- **A `done` record may be written outside the scheduler exactly once, by adoption.** `adoptSlot`
  logs a slot's own task `done` with the handed-in bytes as its output, so the next run **adopts**
  the picture rather than rendering over it. The bound that makes this safe is that the identity is
  derived, in the same call, from the project as it stands — never from a passed hash — so it can
  only mark done the one node whose output this image now is. A `portrait:` slot is refused because
  the P3 gate owns it, mock-marked bytes are refused because mock art never becomes real output, and
  superseding a render that already holds the slot is a **declared** act (`replace`), not a silent
  one. `promoteConcept` is one caller of this; nothing else in the system writes a terminal record it
  did not run. Plans: [`../plans/archive/adopting-an-uploaded-asset.md`](../plans/archive/adopting-an-uploaded-asset.md),
  [`../plans/archive/on-demand-concept-images.md`](../plans/archive/on-demand-concept-images.md).

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
- **The whole graph is a graph of slots, not of task hashes.** A `shot_image` hash is unknowable
  until its plate has actually rendered, because `TaskInputs.shot_image.refs` embeds the upstream
  asset hashes and `taskHash` covers the whole inputs object. So "every picture this project
  implies" is enumerated over the **slot** vocabulary that already exists in
  `@vn/artgen`'s `refcycle.ts` — `portrait:<id>`, `sheet:<id>/<outfit>/<angle>`,
  `plate:<loc>/<variant>`, `shot:<scene>/<shot>` — with `refsOfSlot` as the edge rule and the
  planner's real task identity attached only to the slots the project can currently state one for.
  `buildSlotGraph` and the planner **must enumerate the same set**, which is why
  `reachableScenes`/`allCharacters`/`usedOutfits`/`allLocationVariants` were lifted into
  `@vn/model`'s `used.ts` and both sides call them; a test plans a mock project to exhaustion and
  asserts the two agree in both directions. `SlotGraph.order` is topological, upstream first —
  which is the order approval has to happen in. Never derive edges from `Task.deps`: it is
  documented as incomplete and is not hashed.
- **A portrait and a plate are owed to whoever authored a sheet; a model sheet is not.** P2 and P3
  enumerate over `allLocationVariants`/`allCharacters` — **every** authored location and character,
  cast or not — because a cast sheet exists to be looked at and an author draws the cast before
  writing scenes for it. P4 still fans out over `usedOutfits`, so an uncast character plans no
  sheets even once approved: a portrait is one image call, a sheet is three per outfit and exists to
  be referenced by a shot that does not exist yet. The gate is untouched — `gateStatus` keeps its
  own reachable-scene walk, so an uncast character's unapproved portrait halts nothing, and it
  surfaces instead in the tree's *Awaiting approval* branch. Plan:
  [`../plans/archive/drawing-a-character-before-a-scene-casts-them.md`](../plans/archive/drawing-a-character-before-a-scene-casts-them.md).
- **`SlotNode.approved` is two different things wearing one word, deliberately.** A `portrait:`
  slot is approved when the character's `approvedPortrait` names it — that is the P3 gate, read
  from the model — and every other slot when the asset filling it has `accepted === true`.
  Conflating them is the bug the approval frontier exists to prevent.
- **Acceptance is exclusive per slot.** `pick` returns nothing when two candidates for one slot are
  both `accepted`, so a slot in that state resolves to nothing, reads as empty, and un-settles
  everything drawn from it. `AssetStore.accept(hash, supersede)` therefore takes the takes being
  replaced and clears their flags in the same manifest write, and `supersededBy` computes that list
  from the slot the asset fills. The shot runner passes it when a clean attempt is accepted, and
  `session.acceptAsset` passes it when an author accepts one by hand. A `portrait:` supersedes
  nothing, because its slot answers to the gate rather than to `accepted`; a `sheet:` supersedes
  nothing without an `angleOf` lookup, because four angles of one outfit share one binding and are
  four pictures rather than four takes. Nothing in the manifest records when a picture was rendered
  — it is written hash-sorted — so a surface that cannot resolve a slot must say so rather than
  guess which take is newest.
- **Getting a storyboard is an explicit act, and a fallback is never persisted.**
  `work/shots/<sceneId>.json` wins forever once written and an **absent** file is the only signal
  meaning "decompose this scene" — a signal the batch reads and a hand-placed first shot
  (`story.newShot`, the agent's `edit_scene op=newShot`, `write_storyboard`) removes by writing
  the file, which ends decomposition for that scene just as permanently. `decomposeAll` (behind
  `vngen decompose` and `story.decomposeAll`) is additive with no `force`, skips a scene the model
  does not answer for and names it instead of writing `deterministicShots`, and refuses mock or
  unresolved keys by name. `decomposeScene` answering with a `source` and a `reason` instead of
  throwing exists solely to make that last distinction reportable: inside one
  run, one scene at a time, the silent fallback is the deterministic-fallback contract working;
  sixty scenes at once with a bad key would baseline the project permanently. Plan:
  [`../plans/archive/the-full-slot-graph-and-approving-upstream-first.md`](../plans/archive/the-full-slot-graph-and-approving-upstream-first.md).
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
  [`../plans/archive/task-failure-visibility-and-retry.md`](../plans/archive/task-failure-visibility-and-retry.md).

## Scenes, shots, and lines

- **An entity is found by its tag, and the file it was found in travels with it.** A character or
  set-location is whatever states `type: character` / `type: location` in its front-matter, across
  exactly three surfaces: `characters/<id>/character.md`, `locations/<id>.md`, and a walk of
  `wiki/**/*.md`. In the two conventional directories the tag is implied by the directory and may
  be stated redundantly; stating the _other_ kind there is an `entity_tag_conflict` error rather
  than an override, because moving the file is how a document changes kind. In the wiki the tag is
  the whole test — an untagged file is the story bible's own business and is passed over in
  silence, which is what keeps the walk from making every stray markdown file an input. Discovery
  yields an `EntityDoc` (`id`, `file`, parsed `doc`, raw `text`), and **that path is the only
  answer to "where does this entity live"**: `entityFile(docs, id)` is how `vngen approve`, the
  desktop session, testkit and `vnauthor`'s edit tools find their target, so a sheet filed in the
  wiki is edited and approved in the wiki. Rebuilding `characters/<id>/character.md` from an id was
  the failure — it silently wrote a file that was not the one loaded. `id:` stays in front-matter
  but **must agree with the file's own name** (the parent directory for a character sheet, the
  filename stem elsewhere), an `entity_id_mismatch` error otherwise; before this, `characters/ada/`
  declaring `id: ren` produced a character nothing on disk named. Two files claiming one id is a
  `duplicate_entity` warning naming both, resolved conventional-over-wiki then by lexicographically
  first path — never a guess and never silent. Unparseable front-matter is an `entity_file`
  diagnostic (error under the conventional directories, warning under the wiki, where the file was
  never known to be an entity) rather than a thrown load: one hand-edited sheet must not take the
  whole project down. Plan:
  [`../plans/archive/entity-discovery-by-meta-tag.md`](../plans/archive/entity-discovery-by-meta-tag.md).
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
  [`../plans/archive/scene-chunk-files.md`](../plans/archive/scene-chunk-files.md) and
  [`../plans/archive/fountain-import-export.md`](../plans/archive/fountain-import-export.md); the format itself is in
  [`fountain.md`](fountain.md#where-the-fountain-lives-project-specific).
- **Shot decompositions are persisted, not re-derived.** P5 is an LLM step, so re-running it
  would produce different shot ids — hence different task hashes — and regenerate art for no
  reason. The planner writes each scene's decomposition to `work/shots/<sceneId>.json` and
  prefers it forever after; it only calls `decomposeScene` when no file exists — and a file a
  hand-placed shot created is preferred exactly the same way, which is how making a first shot by
  hand ends decomposition for a scene. (`decomposeScene` and its gauntlet live in `@vn/artgen`'s
  `storyboard.ts` — generative policy shared with the agent's `propose_storyboard`, which cannot
  import the pipeline — and `@vn/pipeline`'s `p5.ts` re-exports them.) The file is
  human-editable, and a malformed one throws rather than being silently re-decomposed over.
  Authored fields sit at the top level; what a run produced is nested under **`shotData`** and
  rewritten wholesale each pass — `tasks.jsonl` and `manifest.json` stay the authority, so a
  shots file restored from an old commit cannot convince the pipeline that work is done. Line
  ids the scene no longer has are dropped with a warning, and since `buildShotPrompt`
  ignores `coversLines`, coverage edits rehash nothing. Dry runs read the file but never write
  it — a mock decomposition must not be left for a real run to reuse.
- **A shot's order is where its lines sit, so reordering one is a prose edit.** `Shot` has no
  position field — `sceneBeats` emits a `show` whenever the covering shot changes down
  `scene.lines` — so there is nothing to renumber and no second ordering to keep in step with the
  prose. `story.moveShot` therefore moves the **block of lines the shot covers**, through the same
  `@vn/scriptedit` write path every other line edit takes. Only a **contiguous** shot has a single
  position: one whose covered lines other shots draw inside is refused by name rather than
  silently interleaved. Nothing about the move reaches a hash — no id changes, no coverage
  changes, and every shot's covered lines keep their relative order — so nothing drifts
  (`proseHash` walks `scene.lines` in order, and that order is preserved within each shot) and
  nothing re-renders. Plan:
  [`../plans/archive/shot-ordering-in-scenes.md`](../plans/archive/shot-ordering-in-scenes.md).
- **What a character wears is inherited, and the chain is written down once.** `outfitFor`
  (`packages/model/src/outfits.ts`) is the only answer, in three rungs: a shot subject's own
  `outfit`, then the scene's `[[outfit: aiko=track]]` marker, then `character.defaultOutfit`.
  Absence is what makes a rung defer — a `ShotSubject` with no `outfit` inherits, which is why
  `deterministicShots` casts a shot without dressing it. `ResolvedOutfit.origin` reports which rung
  answered so a surface can say so instead of "inherited", and `outfitText` falls back to the
  outfit **id** when nothing describes it: that fallback is what lets an author name a wardrobe
  before writing a word of it. Unlike every other scene edit this one **does** re-render, and
  deliberately — the outfit is part of `buildShotPrompt`, so changing it rehashes exactly the
  shots it reaches and no others. The sheet fan-out follows from the same function: `usedOutfits`
  in the planner is `{defaultOutfit} ∪ {scene markers} ∪ {shot overrides}` over reachable scenes —
  and a character no reachable scene casts has **no entry at all**, which is what keeps drawing
  every authored portrait from also drawing every authored turnaround —
  which is exactly `outfitFor`'s range over the model, so authoring an outfit nothing wears costs
  nothing and a shot can never depend on a sheet nothing planned. A subject out of its default
  takes that outfit's **front** sheet as a reference and depends on its task — one angle, because a
  frame needs the clothes and not a turnaround — reaching the planner a wave later than the marker
  did, the same way a shot waits on its location plate. Plan:
  [`../plans/archive/outfits-at-scene-and-shot-level.md`](../plans/archive/outfits-at-scene-and-shot-level.md).
- **Art direction is authored, appended, and re-renders exactly what it reaches.** `artNotes` is an optional free-text
  field at five rungs — `Character`, `Location`, `Shot`, each `Outfit`, each `LocationVariant` — that
  the builders **append** to what they derived, entity note first and the specific rung second, so
  the style preamble, the reference scaffolding and the closing "single illustrated frame" clause all
  survive. Like the outfit, and unlike every scene edit, this one is meant to cost money: the note is
  in the prompt, so setting one re-keys precisely the tasks that rung reaches and the next run
  re-renders them. `buildShotPrompt` takes `shot.artNotes` **only** — an entity's note already
  reached the plates and sheets the shot references, and re-stating it would double the voice.
  Every builder ends in `.filter(Boolean).join(' ')`, so a project that authors no notes produces
  byte-identical prompts and re-keys nothing; that, not the feature, is the test worth having. The
  agent reaches the same five rungs through the same refusals — `list_assets`, `art_notes` and
  `set_art_notes` share `@vn/artgen`'s rung parser and write path with the desktop's asset editor,
  and `describeAsset` (a plain vision question, not the P7 `VisionReviewer`) lets it read a
  rendered asset back before proposing the next note; `regenerate_asset` is an injected
  `PipelineControl` capability, confirm-gated always, and refuses outright where the capability is
  absent (a bare REPL). Plans: [`../plans/archive/asset-names-and-the-asset-editor.md`](../plans/archive/asset-names-and-the-asset-editor.md),
  [`../plans/archive/agent-art-revision.md`](../plans/archive/agent-art-revision.md).
- **A prompt is a list of clauses, and an override edits the list rather than the string.** Every
  builder in `@vn/artgen` assembles a `PromptChunk[]` — each clause keyed, categorised, and carrying
  the origin (a builder, or the document and field the sentence came from) that lets a surface offer
  a `⇱` to it — and `renderPrompt` collapses that list with the same `.filter(Boolean).join(' ')` the
  flat builders used. **Byte-identity is the contract**: a project authoring no override composes
  character-for-character the string it composed before, which is why every existing task hash
  survives the feature (`packages/pipeline/src/tests/prompthash.test.ts` pins the whole sorted list
  against a literal written before any of it). An override is authored input, stored at the **one**
  rung that names the whole picture — `Character` for a portrait, the outfit entry for a sheet, the
  location variant for a plate, the `Shot` for a frame — never at a rung that only contributes a
  clause, so there is exactly one place to look. `mode` alone is not an override: every mode falls
  back to the derived chunks when the shape it names is empty, and `promptOverrideIsEmpty` is what
  each writer clears the key by, so a sheet that was once edited does not grow an inert
  `prompt_override:`. `TaskInputs.*.prompt` **stays a flat string** — `taskHash` hashes the whole
  inputs object with no allow-list, so a new key there would re-key every task in every project;
  `composePrompt` is the boundary and a chunk reaches a hash only through the text it composes.
  Editing one is like an art note and unlike a scene edit: it is meant to cost money, and re-keys
  precisely the tasks that rung reaches. An **agent-condensed** prompt records the chunk list it
  condensed, and when those chunks move it is **held** — `composePrompt` in `agent` mode returns the
  stored text unconditionally and never falls back to freshly rendered chunks, because falling back
  would re-render the asset the moment an unrelated note changed. The staleness is derived on read
  and reported on the pane, never stored and never silently resolved. Plan:
  [`../plans/archive/chunked-prompts.md`](../plans/archive/chunked-prompts.md).
- **A reference attaches to a clause, pins a hash, and separately remembers where it came from.**
  A `ChunkRef` on a `PromptChunk` is evidence for that clause, so muting the clause drops the
  reference with it — one authorial act, one meaning. A **linked** ref also carries a `RefBinding`
  naming the logical slot it was taken from (`plate:cafe/night`, `sheet:aiko/gala/front`, …), and
  the two are separate on purpose: `refs` is inside the task hash, so pinning is what stops an
  approval upstream from silently re-rendering everything that points at it. Authored refs are
  appended **after** the derived ones in `TaskInputs.refs`, because `canonicalJson` maps arrays
  positionally and any other order would re-key tasks that author none. A ref with **no** binding is
  an upload: it pins itself and can never drift.
- **Suspension is derived, transitive, and never stored.** When a slot moves, everything pinned to
  its old hash — and everything downstream of that, walked with a `visited` guard so a cycle already
  on disk is reported rather than hanging — is **suspended**: the bytes stay, the run plans nothing
  new, and the fact is enumerable in dependency order (`asset.suspended`). A stored flag would have
  to be invalidated by every writer, which is the failure this avoids; a suspended asset refuses
  `accept`/`approve` by name, and `prompt.repin` is how it clears. `regenerate=false` re-approves:
  it swaps the pin, computes the newly-keyed task's identity **from the state just written**, and
  records the existing bytes as its output — the same don't-forge-work bound promotion rests on.
- **The reference graph is kept acyclic at write time, over slots rather than hashes.** `refCycle`
  runs in `prompt.addRef`'s precondition and refuses with the whole path named. Hashes cannot cycle
  today, but bindings can, and a cycle in this graph does not error at run time — it leaves tasks
  that are never ready, which reads as a run that quietly does nothing.
- **No edit to a scene's _prose_ invalidates art — which is why drift has to be reported.**
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
  see [`desktop-app.md`](desktop-app.md#shot-coverage). Plan:
  [`../plans/archive/line-editing-in-floor.md`](../plans/archive/line-editing-in-floor.md).
- **Editing a generation graph invalidates the slots it draws — the opposite of the prose posture
  above.** A bound graph is the slot's runner: editing it never moves the task's hash, so the
  difference has to show as drift instead. `graphDrift` recomputes each active Output node's hash
  and compares it against the journal's last `done` record for that node; `requeueDrifted`
  (`@vn/scheduler`) puts every planned `done` or `needs_human` task whose bound graph has drifted
  back to `pending`, once per run and before the wave loop, and `RunSummary.redrawn` names them.
  Drift is measured on `authoredHashes` — each host-seeded input (the derived prompt, task refs)
  read as though nothing had been seeded onto it — rather than the task's own `nodeHash`, which
  includes that seeding and would report drift after every run whether or not anyone edited
  anything. A successful redraw clears the drift by writing the graph's new authored hash into the
  journal; a graph that fails writes no such record, so a failure is left to `requeueFailed` and
  its own attempt budget rather than requeued here forever. The requeue happens at run time rather
  than at the graph write, because undo excludes `vngen/state/`: undoing a graph edit restores the
  authored hash and the drift disappears before anything is redrawn. Plan:
  [`../plans/node-based-asset-generation.md`](../plans/node-based-asset-generation.md) (Stage 2;
  the plan overall is in progress).
- **A scene's heading is the one scene edit that _does_ invalidate art, and it is priced before it
  runs.** A location reaches a shot's task inputs twice — `buildShotPrompt` bakes `location.name`
  into the prompt, and the plate asset's hash leads the shot's `refs` — so rewriting a heading
  rehashes every shot in the scene and the next run **re-renders** them rather than reporting drift.
  That is the exact inverse of the contract above, so `ShotFallout` counts it separately: `restaged`,
  never folded into `drifted`. `setHeading` (`packages/scriptedit/src/lineops.ts`) is where it lives
  — the heading is not a `SceneLine` but `location` + `locationVariant` + `headingPrefix`, which
  `headingOf` reassembles and `parseHeading` reads back, so no line id moves and no coverage changes.
  It also **restages every shot in the scene** onto the new heading's variant, through the `relocated`
  channel on `LineOp`: `Shot.location` is a variant id persisted in `work/shots/<sceneId>.json`
  (which wins forever once written), and the planner's `locationTask(…, shot.location, …)` `continue`s
  past a shot whose variant the new location does not declare — skipping it in silence, permanently.
  What nothing here can fix is the prose, which still describes the old place; the op's own message
  says so and names the agent. Surfaces show the cost rather than confirming it: `story.setHeading`
  is deliberately not `confirm: true`, because a confirm command is never checked and the check
  **is** the warning.
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
  below it. Plan: [`../plans/archive/allocated-line-ids.md`](../plans/archive/allocated-line-ids.md).
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
  [`../plans/archive/lossless-scene-serialization.md`](../plans/archive/lossless-scene-serialization.md).
- **P5 is shown the scene as identified lines, not prose.** `coversLines` asks for line ids, so
  `decomposeScene` enumerates the scene as `[<lineId>] <kind>/<speaker>: <text>` and requires
  every line be assigned to exactly one shot. Handing over flattened prose and a response
  template containing `"coversLines":[]` made the question unanswerable, and the model did the
  only thing it could — copied the empty array, producing shots that were generated and never
  displayed. `withCoverage` is the backstop: a decomposition binding no real line falls back to
  the baseline, and an uncovered first line goes to the first shot so a scene cannot open on a
  blank frame. See [`../plans/archive/shot-timeline-editor.md`](../plans/archive/shot-timeline-editor.md).

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
  [`../guides/testkit.md`](../guides/testkit.md).

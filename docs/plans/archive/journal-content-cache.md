# The gen-graph journal resumes from any answer it already holds

Status: shipped. Follows the OpenRouter live check
([`openrouter-backend-and-the-image-model-default.md`](openrouter-backend-and-the-image-model-default.md)),
which recorded the redraw this plan removes.

## The problem

- A node resumes only when its **latest** journal record is `done` with the same
  `nodeHash` (`packages/gengraph/src/execute.ts`, the `prior` check). Replay keeps one
  `latest` and one `lastDone` record per node (`replayJournal`), and the hash is a field
  on the record rather than the key it is filed under.
- So a node whose model prop moves A → B → A redraws on the way back, although the A
  picture is still on disk: blobs are content-addressed under `state/graphs/<slug>/`, and
  nothing deletes them (`deleteGraphDoc` removes only the `.json` document).
- `state/tasks.jsonl` does not have this problem because it is keyed by content:
  `loadGraph` in `@vn/taskgraph` keeps the last record per task hash, so an earlier answer
  for the same inputs is found whatever ran in between.
- The cost is a paid image call per flip, and a re-run of everything below it.

## Decisions

### 1. Resume is keyed on what fed the node, computed during the run

- Each node gets a **run key** when the executor reaches it:
  `hashParts(type@version, resolved props, readInputs(node))`, where the props are read
  the way `nodeHash` reads them (an empty image-model prop replaced by the project's
  model) and the inputs are the socket values as they stand once upstream has been
  applied. A picture contributes its `{store, hash, ext}`; a prompt contributes its text.
  `hashParts` sorts object keys recursively, keeps array order and drops `undefined`
  fields, so a value reaches the key the same way whether it came from a socket default, a
  seeded input or an upstream `applyOutputs`.
- The cache is **per node, by run key**: the key is filed under the node's key (`nodeKey`,
  the `<instance>/<id>` chain), not project-wide. A node deleted and recreated, a pasted
  copy, or a re-made group instance starts with no answers although its blobs are on disk.
  That is the same scope the journal has today, and widening it is out of scope below.
- The static `nodeHash` hashes the **hash** of the node feeding an input, not what that
  node produced. That is why `executeGenGraph` carries a `reran` set and re-runs
  everything below a node that ran, and why a cache keyed on `nodeHash` alone is unsound
  (see Decision 5). A run key carries the produced value, so two runs of a node whose
  output is a function of its inputs and props were fed the same bytes. A node whose
  output comes from a service rather than its inputs (`GenSlotRef` reads the slot's
  current asset, `GenImageFile` reads a file) resumes on the key exactly as it resumes on
  its `nodeHash` today: a changed slot or file is invisible to both. Nothing changes for
  those nodes, and the soundness claim does not extend to them.
- The run key can only exist during the walk, never for a graph at rest. Nothing needs it
  at rest: the only readers of `graphHashes` are `executeGenGraph` and
  `invalidateGenGraph`, `graphDrift` reads `authoredHashes`, and `cost.ts` never opens the
  journal.
- `nodeHash` and `authoredHash` stay on every record, unchanged in meaning. `nodeHash` is
  still what `invalidateGenGraph` stamps and what a reader compares by eye; `authoredHash`
  is still what drift is measured on.
- The executor relies on every ancestor's outputs being applied to its sockets every run,
  whether the node ran or resumed, because a multi-source socket memoizes `getValue` and
  is only invalidated through `setValue`. `applyOutputs` does this today for both paths; a
  test pins it, since a graph object is reused across refine attempts and across the tasks
  one graph draws.

### 2. The journal indexes every `done` record a node has not retired

- `GraphJournal` gains
  `cached: ReadonlyMap<GraphId, ReadonlyMap<string, GraphJournalRecord>>` — per node, its
  `done` records that carry a `runKey`, by that key, latest writer winning per key.
- An `invalidated` record **retires every `done` record of that node whose `at` is not
  later than its own**. A force therefore retires every answer the node has ever given,
  not only its last one, which is what a force asks for. Without this rule a
  `gengraph.run` with `force`, or `PipelineControl.regenerate`, would resume the picture
  the author asked to replace, from a record older than the one it invalidated.
- The cutoff is by timestamp rather than by line position because git union-merges the
  journal across clones, and a merge can land another clone's older `done` line after this
  clone's `invalidated` line. Ordering by `at` makes the merge order irrelevant; two
  clocks that disagree by more than the real time between the old answer and the force are
  the residual exposure, and a record with an `at` that does not parse is retired as if it
  were old.
- A `failed` or `running` record leaves the map alone. A failure is not an answer and does
  not retire earlier answers, because the run key of the earlier answer says exactly what
  it was fed.
- `latest` and `lastDone` stay as they are: `latest` is what the migration rule reads
  (Decision 4), and `lastDone` is what drift reads.

### 3. Three copies of the journal update rule become one

- `execute.ts` (`write`) and `packages/pipeline/src/graphrun.ts` (`runBoundGraph`'s
  `record`) each hand-maintain `latest` and `lastDone` today, and `replayJournal`
  maintains them a third time. A third map means a third place to forget.
- Two exported functions carry the rule: `applyRecord(journal, record)` mutates the
  journal it is given and is the only place the rule is written, and `cloneJournal` copies
  one so a caller can advance a private view. `replayJournal` folds with `applyRecord`
  over a fresh journal; the executor and the runner wrapper clone and apply.
- Mutation rather than a persistent structure because a replay applies thousands of
  records and a copy per record would be O(nodes) each; the clone is what keeps a slot's
  binding from advancing the entry another slot shares (`indexGraphs` spreads one entry
  into a binding per slot, and `runBoundGraph` reassigns the binding's journal).
- The executor applies every record it writes, including the `invalidated` records a
  `force` writes at the start of the run, to its own clone before it consults `cached`. It
  cannot read `ctx.journal` as a snapshot the way it reads `latest` today, or a force
  would resume what it just retired.
- `GraphJournal` stays a plain readonly object rather than becoming a class, because a
  test builds one by hand and the runner wrapper passes one across a package boundary.

### 4. The resume rule

For each node in order, with `key` the run key just computed:

1. A node fed by a failed node is blocked, as now.
2. If `cached.get(node).get(key)` holds a record and its bytes exist (Decision 6), apply
   its output and skip the node. The node is marked **resumed**.
3. Otherwise, if the node's `latest` record is a `done` record **without a `runKey`**
   whose `nodeHash` matches, and every upstream node was resumed by this same step, apply
   its output and skip the node. This is today's rule, kept only for journals written
   before the run key existed. It requires a pure pre-key chain above the node: a node
   above it that ran, or that resumed through step 2, may have answered with bytes the old
   record was not drawn from, and the old record's `nodeHash` cannot tell.
4. Otherwise run the node and journal it as now, with `runKey` on the `running`, `done`
   and `failed` records.

- The `reran` set goes away. Step 2 is exact because the key names what fed the node; step
  3 is exact because it demands that nothing above the node moved.
- **A hit whose record carries a `nodeHash` or `authoredHash` different from the current
  values writes a fresh `done` record**: current hashes, the cached output, the run key,
  no `usage`. This is keyed on the hashes rather than on whether the hit was the latest
  record, because a latest record can be stale too: add `{varC}` to a template whose
  `varC` is empty and the template's output does not change, so every node below it hits
  its latest record while the output node's recorded `authoredHash` is the old one.
  Without the fresh record `graphDrift` would report that node drifted and
  `requeueDrifted` would requeue its task on every run, forever. With it, the contracts
  doc's "a successful redraw writes the graph's new authored hash" stays true for a redraw
  that resumed. A hit whose hashes already match writes nothing, as now. Nothing reads a
  record's `usage` yet, so the missing figure costs nothing.
- The output of a skipped node is applied to its sockets, so the node below it computes
  its run key from the cached bytes, which is what makes the key exact through a resumed
  chain.

### 5. Why not the smaller change

The one-line alternative is to index `done` records by `nodeHash` and take the latest
match. It is rejected because it resumes a stale picture in a sequence the current rule
handles:

- A feeds B; both done. Force: A is invalidated and redraws to a1′; B is stale and reruns,
  and fails. Flip A's model away and back.
- A resumes a1′ (its latest match, after the invalidation). B's latest `done` at its hash
  is b1, drawn from the old a1 — and B's hash did not move, because it hashes A's hash
  rather than A's output.
- Today B's latest record is the other model's, so B reruns. Under the hash index B would
  resume b1. Under the run key B's key names a1′, b1's names a1, and B runs.

The same argument is why step 3 of Decision 4 demands a pure pre-key chain: a pre-key
record for B says nothing about which of A's answers it was drawn from.

### 6. A hit verifies its bytes exist

- Resume today applies a record's output without looking, and a blob that has been cleaned
  away surfaces later as `readDrawn`'s throw in `graphrun.ts`. A wider hit window makes
  the check worth its cost. For each `GenImageRef` in a candidate's output: a `blob` ref
  is checked with `services.blobs.has(ref)`, an `asset` ref with
  `services.assets.has(ref)`. A candidate whose bytes are gone is treated as absent and
  the node runs.
- `has` is one `stat` — the ref carries `ext`, so `graphBlobFile` names the file and
  `exists` answers. It is added rather than reusing `read` because the refine loop runs
  the graph once per attempt and a graph with a dozen image nodes would otherwise read
  tens of megabytes to learn that nothing changed.

### 7. Format and version

- `GraphJournalRecord` gains `runKey?: string`, documented as present on every record the
  executor writes and absent on an `invalidated` record, which is written at rest
  (`invalidateGenGraph`, called by `gengraph.run` with `force` and by
  `PipelineControl.regenerate`) where no key exists.
- `GRAPH_JOURNAL_VERSION` becomes 2 so a reader can tell the two formats apart. It does
  not gate parsing: `parseRecord` keeps accepting any numeric `v`, and a `done` record
  enters `cached` if and only if it carries a `runKey`. A journal written by a newer app
  is read for the fields this one knows, as today, rather than read as a graph that never
  ran.
- A pre-key `done` record can only resume through step 3 of Decision 4. A graph that is
  not touched after the upgrade never runs, so nothing redraws because of the upgrade; the
  first run that touches it writes keyed records for every node that ran, and each node
  below the first keyed node runs once. That is the same cascade today's `reran` rule
  produces when the same upstream node runs.
- `journalRecord` keeps stamping the current version. The `nodeHash` field is not renamed
  and `authoredHash` is not touched, so `migrateGraphJSON` and the drift tests are
  unaffected.

### 8. The refine loop treats a repeated critique as a stall

- `makeShotRunner`'s loop stalls when a critique equals the one **immediately before it**.
  With resume on run keys, a critique that repeats one from two attempts back resumes the
  picture that critique produced instead of drawing a new one; the reviewers then answer
  as they did then, the next critique repeats the other one, and the loop pays reviewer
  calls until `max_refine_attempts` without a new roll. Today the redraw breaks the cycle
  by accident.
- The stall check compares the next critique (or the next refined prompt) against every
  one the task's attempts have already tried, not only the previous one. A repeat at any
  distance means the reviewers are going in circles, and `needs_human` with the existing
  sentence is the right answer. This makes the loop's cost bounded by the number of
  distinct critiques rather than by `max_refine_attempts` alone.

## Out of scope

- Sharing answers across graphs or across nodes. Blobs are stored per slug and
  invalidation is per node, so a project-wide cache needs a shared blob store and a
  different meaning for force. Neither is decided here.
- Two tasks drawn by one graph in the same wave advance separate in-memory journals and
  see each other's appends only on the next load. That is how it works today, and the
  cache does not change it.
- A cache for `vngen cost`. The estimate is the worst case over the whole graph by design
  and does not consult the journal.
- Pruning the journal or the blob store. Both stay append-only.
- Making `GenSlotRef` and `GenImageFile` notice that what they read changed.

## Staging

Each stage lands green under `pnpm check && pnpm test && pnpm lint`.

1. **The journal view and the shared update rule** (`journal.ts`, `journalfile.ts`,
   `execute.ts`, `graphrun.ts`, `services.ts`, `blobs.ts`). `runKey` on the record,
   version 2, `cached` on the journal with the timestamp cutoff, `applyRecord` and
   `cloneJournal`, `replayJournal` folded over them, the executor and the runner wrapper
   using them, `has` on the blob and asset services. The resume rule is unchanged in this
   stage, so the only visible change is the field on new records. Tests: replay builds
   `cached`; an `invalidated` record retires the `done` records at or before its `at` and
   leaves a later one; a `done` record without a key stays out; the runner's advanced
   journal equals a replay of what it appended; a clone does not advance its source.
2. **Run keys and the resume rule** (`execute.ts`, `hash.ts` for the prop-resolution
   helper the key shares with `nodeHash`). Steps 2 and 3 of Decision 4, the fresh `done`
   record on a hash mismatch, the bytes check, the `reran` set removed. Tests: the flip A
   → B → A resumes with no runtime call and writes a `done` record that clears drift;
   Decision 5's sequence runs B; a forced node runs although an older record matches; a
   regenerate's `invalidated` written at rest is honoured by the next run; identical
   upstream bytes let a downstream node resume where the `reran` rule used to run it; the
   `{varC}` template edit writes the new authored hash on the output node; a hit whose
   blob is gone runs; a pre-key journal resumes as a pure chain and runs below the first
   keyed node; a socket fed by two sources reads the resumed values.
3. **The refine loop** (`runners.ts`). The stall check over every earlier critique, with a
   test that cycles c1 → c2 → c1 and expects `needs_human` after the second c1 rather than
   a third draw.
4. **Docs.** `docs/reference/gen-graphs.md` ("Identity, the journal and drift" and
   "Running a graph": the run key, the `cached` view, what `invalidated` retires, and the
   "that is why the resume rule is correct" sentence replaced by the key), the contracts
   doc's drift entry (a redraw that resumed writes the authored hash too),
   `docs/plans/index.md`, this plan's As-shipped section, and the manga live-tests note
   that recorded the flip.

## Risks

- **Union merge across clones.** The timestamp cutoff removes line order from the
  invalidation rule, but two clones' clocks are the new dependency. An answer drawn on
  clone X survives a later force on clone Y when X's stamp is not earlier than Y's, so X's
  clock has to be ahead of Y's by at least the real time between X's draw and Y's force.
  Two sessions on two machines are hours apart and NTP keeps clocks within seconds, so the
  exposure is a clock that is wrong by hours, not skew. Today's rule has the mirror-image
  exposure (a merge can put an older `done` line last and resume it), so neither is
  strictly safer; the cutoff is the one that does not depend on which clone merged.
- **Memory.** `cached` holds every un-retired `done` record. Records carry the full prompt
  text (the `examples/test4` journals are 1–17 KB each), so this is megabytes at worst for
  a graph that has been run thousands of times.
- **A record written on a hit has no `usage`.** When something starts summing usage from
  the journal it must skip records without it, or the fresh record reads as a free draw.
  Noted in the record's doc comment.
- **The refine loop.** Decision 8 is what makes resumed pictures safe there. Without it
  the loop is bounded only by `max_refine_attempts` and every bounded attempt costs
  reviewer calls.

## Needs verification

- That no host reads `journal.latest` to decide anything other than what the executor
  decides. The grep at planning time found only `execute.ts`, `graphrun.ts` and `drift.ts`
  (`lastDone`).
- How far apart the two clones' clocks can be in practice, to size the exposure in
  Decision 2 against the real interval between an old answer and a force on the other
  clone.

## Review

A fresh-context agent reviewed the first draft. Its findings, and what each changed:

1. The cache is per node, not content-addressed like `tasks.jsonl`; a recreated node or
   re-made instance starts empty. **Fixed**: Decision 1 says so and Out of scope names the
   widening.
2. Two tasks drawn by one graph in the same wave advance separate in-memory journals.
   **Recorded** in Out of scope; pre-existing and unchanged.
3. The key relies on `applyOutputs` running for every ancestor every run, because a
   multi-source socket memoizes. **Fixed**: stated in Decision 1 with a test in Stage 2.
4. `hashParts` canonicalizes what the key needs (sorted keys, array order kept,
   `undefined` dropped). **Verified**; the item is removed from Needs verification.
5. Whether `journalWith` copies or mutates was undecided. **Fixed**: `applyRecord`
   mutates, `cloneJournal` copies, Decision 3 says why.
6. Refusing a v2 record without `runKey` would refuse every `invalidated` record written
   at rest, so a regenerate would resume the picture it asked to replace. **Fixed**:
   Decision 7 no longer gates parsing on the key; `cached` membership does.
7. Writing the fresh `done` record only on a non-latest hit leaves permanent drift when a
   latest record has a stale `authoredHash` (the `{varC}` case). **Fixed**: Decision 4
   keys the fresh record on a hash mismatch.
8. "One record per node" and `deleteGraph` were inaccurate. **Fixed** in The problem.
9. `cached` is more order-sensitive under union merge, not less. **Fixed**: the cutoff is
   by `at` (Decision 2), and Risks states the clock dependency honestly.
10. Whether a step-2 hit counts as "ran" for step 3. **Fixed**: step 3 needs a pure
    pre-key chain.
11. Whether the refine stall check changes. **Fixed**: Decision 8.
12. The executor must apply its own `invalidated` records before consulting `cached`.
    **Fixed** in Decision 3.
13. What happens with `v > 2`. **Fixed**: nothing gates on the version.
14. `GenSlotRef` and `GenImageFile` answer from services, so "same key, same bytes" is
    false for them. **Fixed**: Decision 1 qualifies the claim; behaviour for them is
    unchanged.
15. Step 3 after a step-2 hit resumes a stale pre-key picture. **Fixed**: same as 10.
16. The refine loop can cycle on resumed pictures. **Fixed**: Decision 8 and Stage 3.
17. `invalidated` at rest is sound once finding 6 is fixed. Agreed; a test in Stage 2
    covers it.
18. Seeded inputs reach the key as they reach `nodeHash`. Agreed.
19. Output nodes deliver a hit through `result.outputs`, and provenance reads the image
    node's cached record. Agreed.
20. Group instances: no new hole. Agreed.
21. Undo is cheap: today's `parseRecord` already reads v2 lines. Agreed.
22. Check existence with a `stat` rather than a read. **Fixed**: Decision 6 adds `has`.
23. Drop step 3 and `reran` in favour of a pure-chain migration rule. **Adopted** as
    Decision 4.
24. One fresh-record rule keyed on the hashes. **Adopted**; same as 7.

## As shipped

Four stages, one commit each, on the `journal-content-cache` branch. Every stage landed
green under `pnpm check && pnpm test && pnpm lint`. The Review section's numbering is
unchanged; the deviations below name the decisions they touch.

- **Stage 1** (`journal.ts`, `execute.ts`, `graphrun.ts`, `services.ts`, `blobs.ts`,
  `genservices.ts`, the mock services fixture). `runKey?` on the record,
  `GRAPH_JOURNAL_VERSION = 2` with parsing ungated, `cached` on the journal, `applyRecord`
  and `cloneJournal` with `replayJournal` and `emptyJournal` built on them, the executor
  and `runBoundGraph` cloning and applying, `has(ref)` on both services. Tests: replay
  builds `cached`; an invalidation retires the answers at or before its `at` and leaves a
  later one; a keyless `done` record stays out; a clone leaves its source alone;
  `applyRecord` equals replay; the runner wrapper's advanced journal equals a replay of
  what it appended; the blob store's `has` is a `stat`.
    - Deviation from Decision 2: `GraphJournal` also carries `invalidatedAt`, the parsed
      stamp of each node's latest `invalidated` record. Decision 2 says the cutoff is by
      timestamp so that a merge landing an older `done` line _after_ the `invalidated`
      line cannot resurrect it, and retiring only what `cached` holds at the moment the
      invalidation is applied would not achieve that. The second map is what holds a
      later-arriving `done` record to the same cutoff. An answer stamped exactly at the
      invalidation is retired if it was already filed and kept if it arrives after, which
      is what lets a test clock held still force a node and then file its redraw.
- **Stage 2** (`hash.ts`, `execute.ts`, `nodes/sockets.ts`, `nodes/runtimes.ts`,
  `graphrun.ts`). `nodeRunKey`, the three-step resume rule of Decision 4, the bytes check,
  the fresh `done` record, the `reran` set removed. All nine tests the Staging section
  lists, plus a forced node resuming its own redraw on the run after.
    - Deviation from the Staging section: `nodeRunKey` delegates to `nodeHash` rather than
      sharing a prop-resolution helper with it. The two are the same computation over
      different input parts, so the helper would have been the whole function.
    - Deviation from Decision 4: the fresh `done` record is written when the node's
      **latest `done` record** carries hashes different from the current ones, not when
      the hit's own record does. `graphDrift` reads `lastDone`, and in the flip A → B → A
      the hit's hashes already match the current ones while the latest record is B's;
      keying on the hit would have left the slot drifted forever, which is the outcome the
      plan's own test for the flip forbids. The `{varC}` case comes out the same under
      either reading.
    - The bytes check is applied to a step-3 (pre-key) candidate as well as to a step-2
      hit. Decision 6 names only the hit; the check costs one `stat` and a pre-key record
      is no more likely to have its blob.
    - `imageRefOf` is exported from `nodes/sockets.ts` and replaces the private copies in
      `runtimes.ts` and `graphrun.ts`, because the executor needed a third.
    - Three existing tests changed with the rule: a node below one that ran again now
      resumes when the redraw's bytes are identical, and the inherit test's second host
      shares the first's blob store rather than starting empty.
- **Stage 3** (`runners.ts`). The stall check compares the next critique, or the next
  refined prompt on the unbound path, against every one the task's attempts have tried.
  The test cycles the reviewers c1 → c2 → c1 through a bound graph with a cap of six and
  expects three attempts, three draws and `needs_human`.
- **Stage 4**. `gen-graphs.md` ("Identity, the journal and drift", `GenServices`, "Running
  a graph"), the contracts doc's drift entry, the index row, this section, and the note in
  `manga-live-tests.md`.
- **Needs verification**, resolved: no host reads `journal.latest` to decide anything but
  what the executor decides (`graphrun.ts` no longer reads it at all; `drift.ts` reads
  `lastDone`). The clock exposure was not measured. The first draft named the wrong
  quantity (the gap between a force and its redraw, which does not enter the rule); the
  quantity that matters is the real interval between an old answer and a force on another
  clone, and the Risks entry now says so.

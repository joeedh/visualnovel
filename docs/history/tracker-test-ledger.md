# Tracker rollout test ledger

Scope: opt-in command whitelist, reusable per-file provenance, commit invalidation, and
races. Each new test will be listed here with its purpose and final review decision.

Artifact retention: the root-level JSON reports and temporary measurement harnesses named
below were removed during repository cleanup. Their filenames identify historical runs;
the raw reports are no longer retained. Measurements below are historical summaries, not
reproducible evidence bundled with this repository. Permanent regression tests remain in
the source tree.

## Commit validation, 2026-10-23

Repository cleanup corrected artifact-retention claims and removed the temporary,
project-specific tracker benchmark. Formatting and lint fixes retain promise identity
checks while scheduling initialization before their cleanup callbacks can run.

Root and renderer typechecks, the complete lint command, the desktop production build, and
diff checks pass. The unrestricted full test run completed 390 suites: 389 passed, one
failed; 5,620 tests passed, six were skipped, and one failed. The failure was the
previously observed timestamp-sensitive scoped-undo round-trip at `undo.test.ts:406`. An
immediate rerun of the complete undo suite passed all 18 tests without code changes. The
initial sandboxed run executed no tests because Jest cache renames were denied. Temporary
test logs were removed after review.

## Real-drag watcher reproduction follow-up

Two visible-window runs used CDP mouse press/move/release events on actual bubble anchor
buttons (seed 20261023), not direct bubble-save calls. Each performed 60 drags, six queued
undo/redo pairs, six wiki writes, four panel edits, and coverage reads. Wiki writes were
started before selected drags to overlap the command queue; undo and redo were enqueued
together after selected pointer releases. All operations succeeded. Each run passed 64
settled UI/disk comparisons. Animation-frame monitoring compared anchor styles with the
current draft/model by line ID: 2,981 frames in opt-in mode and 3,259 in verification
mode, zero mismatches. This sampled monitoring does not prove absence of every possible
race.

No watcher setup error, runtime error, unnamed event, closed-tracker fallback, or tracker
mismatch occurred. Opt-in mode recorded 35 tracker uses, one agreeing verification sample,
and eight fallbacks (three no-dirty-witness, four guard-refresh, one
changed-during-check). Full verification recorded 37 agreements and ten fallbacks (two
no-dirty-witness, seven changed-during-check, one `repository operation: index.lock`).
Another 16/13 bubble commands respectively used Git while tracker preparation was
unavailable and have no tracker sample. The whitelist and fallback policy were unchanged.

| Median, milliseconds          | Opt-in tracker | Full verification |
| ----------------------------- | -------------: | ----------------: |
| Provenance                    |           20.4 |             108.2 |
| Save                          |           13.6 |               8.7 |
| Pre/post snapshots            |      1.9 / 4.2 |         1.4 / 4.1 |
| Queue wait                    |          0.017 |             0.018 |
| Renderer save through refresh |           78.8 |             145.5 |

Save-through-refresh p95 was 199.5/303.4 ms (nearest-rank percentile); maximum was
1,890.5/1,931.4 ms. Maximum queue wait was 1,692.6/1,715.7 ms when bubble edits waited
behind wiki writes. These are mixed-workload runs rather than isolated warm benchmarks. No
production code or permanent tests were added. The generic watcher failure remains
unreproduced; remaining observed long stalls came from command queue contention.

Evidence: `bubble-watcher-real-drags.json`, `bubble-watcher-real-drags-verify.json`, and
`bubble-watcher-real-drags-summary.json`. Starting heads were captured in
`bubble-watcher-drags-heads.json`: project1 `24ed8601bee8de2de68b9c1b7cdf0551cb906944`,
wiki `b297152f42f7377aad3d6166c46332910244327d`. The app was closed to drain deferred
writes before resetting both repositories to these heads. Both were verified clean,
including removal of the temporary wiki note. The temporary measurement harness was
deleted; the raw reports were subsequently removed during repository cleanup.

## Watcher fallback investigation

The old `watcher unavailable` reason conflated synchronous watch setup failures, runtime
watch errors, events without a filename, and explicitly closed trackers. Diagnostics now
distinguish these cases and include the watched path and error code or event type. All
four still refuse predictions; refreshing a baseline does not re-enable a failed watcher.
The command whitelist, Git fallback, and watcher failure policy are unchanged.

The historical failure did not recur during five 20-save page-editor bursts, deferred
commits, and three undo/redo pairs. A standalone watch probe also succeeded. Consequently
there is no confirmed root cause or claimed watcher-reliability/performance fix. The new
reasons make a future recurrence actionable without guessing or relaxing the guards.

One parameterized test definition (three cases) covers setup failure, emitted error, and
missing filename; each also checks that baseline refresh cannot bypass failure and that
explicit closure is reported distinctly. Review: one shared mock, no duplicate lifecycle
fixture. All 25 tracker and Git/command provenance-policy tests pass, along with both
typechecks, focused lint, main build, formatting, and diff checks. Initial failures were
in the test's module-spy fixture, corrected to spy on Node's mutable default export.

Live verification (`bubble-watcher-verify.json`): 19 agreements, one no-dirty-witness
fallback, zero mismatches. Final opt-in run (`bubble-watcher-final.json`), measured
without concurrent tests: 19 tracker uses and one no-dirty-witness fallback. Across 20
saves, median provenance time was 61.0 ms, save 30.5 ms, pre/post snapshots 4.8/10.2 ms,
queue wait 0.02 ms, and renderer save-through-refresh 137.0 ms. All drafts settled
successfully. These calls use the live page editor's `commitBubbles` path, not pointer
drags; do not compare directly with the earlier drag benchmark or claim a speedup. Earlier
diagnostic runs (`bubble-watcher-before.json`, `bubble-watcher-second.json`, and
`bubble-watcher-after-undo.json`) include test-suite contention and cumulative tracker
samples. Later bursts correctly fell back while guards refreshed after commits.

Saved heads in `bubble-watcher-heads.json`: project1
`24ed8601bee8de2de68b9c1b7cdf0551cb906944`, wiki
`b297152f42f7377aad3d6166c46332910244327d`. Original bubble positions were restored after
each burst. After closing the app and draining writes, project1 was reset to its saved
head; wiki never moved. Both repositories were verified clean. The temporary measurement
harness was deleted.

## Final consolidation review

Reviewed the rollout, prewarming, save, timing, and undo cases against their actual test
bodies. This review changes tests and this ledger only; earlier counts below describe
historical runs.

| Decision                                                         | Coverage and reason                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge two tracker dependency-race tests                          | One fixture now covers an audit racing a dependency write with an empty cache, recovery, overlapping audits with different dependency bytes, rejection of the older result, and same-size/same-mtime replacement outside watcher roots. All distinct assertions remain.                                                       |
| Remove command-stack membership-recheck test                     | Its membership logic lived in `fakeGit.provenance`, not the command stack. Retain the fresh-provenance delegation test, real Git repository-state tests, and policy setup-failure/recovery test.                                                                                                                              |
| Remove unused timing mock methods                                | Delete obsolete `isRepo`, `head`, and `isDirty` fake methods; the timing fixture measures the actual `provenance` boundary. All timing cases remain.                                                                                                                                                                          |
| Merge renderer draft-visibility cases and refresh stale fixtures | A single overlapping-save case now asserts immediate draft visibility, survival of the newer draft, narrow panel application, and one deferred coverage refresh. Fixtures return `BubbleSave` and route prewarm separately from coverage. Controlled timers preserve real microtask ordering and are cleared after each case. |
| Keep undo race and redo invalidation cases                       | Queued edits and history moves need distinct target sequences; a new edit must invalidate queued redo. Real scoped-undo tests separately preserve unrelated writes and refuse target-file drift or changed pre-snapshot input.                                                                                                |
| Keep external-change cases                                       | Scene and shots replacement, rename-retry guards, fresh UTF-8 reads, delayed renderer reads, newer drafts, and external invalidation each exercise a different boundary.                                                                                                                                                      |
| Keep Git fallback and lifecycle cases                            | Whitelist/default-off, clean and unsupported state, sampled mismatch, commit holds, cold setup, disposal, audit races, index flags, attributes/configuration, and environment changes are distinct safety conditions. Predictor tests and outer-policy tests protect different publication boundaries.                        |

Net reduction: three executed cases and one duplicate tracker fixture; no new test
definitions. No live-test harness is retained. The initial desktop run exposed five stale
fixture failures from the prior narrow-save/prewarm changes; these were corrected rather
than deleting their coverage. A follow-up exposed fake timers intercepting external
invalidation's microtask; that microtask now uses its real scheduling behavior.

Validation: all 341 tests across the complete Git, commands, and util projects pass. The
final desktop session, page rules, interaction, and save rerun passes all 166 tests.
Total: 507 passing tests across 32 suites. Both root and renderer typechecks, lint for all
four edited test files, formatting, and diff checks pass. No production code changed.

## Narrow bubble save follow-up

### Undo queue race fix

Undo/redo now resolve their candidate inside the serialized operation, after all earlier
queued commands complete. Deferred-commit flushing, drift checks, snapshot restoration,
and tracker policy retain their existing behavior.

One focused case was added to the existing command-stack suite: queue a save, two undos,
and two redos without awaiting between them, then assert each target sequence and final
state. The existing redo-branch invalidation case was extended to enqueue redo behind a
new edit. Review: one new test and one reused test, no duplicate fixture or live-test
harness retained.

Validation: all 198 command tests across 12 suites pass, along with root and renderer
typechecks, the desktop main build, focused lint, formatting, and diff checks. An initial
run hit the previously observed timestamp-sensitive scoped-snapshot test failure; that
test and the full undo suite passed in the final complete run.

The real-app reproducer queued a bubble save, undo, and redo without awaiting between them
for four rounds. Every operation succeeded, both history moves targeted that round's save,
and persisted bubble positions matched the requested state after redo. Evidence:
`bubble-undo-queue-fixed.json`. The temporary harness was removed. After closing the app
to drain deferred writes, project1 and wiki were restored to the saved heads listed below,
and both repositories were verified clean.

### Exploratory live stress run (no permanent test added)

Saved project1 HEAD `b7d2aa0e5bd23f22f863e08668ce1326b90fb3c3` and wiki HEAD
`b297152f42f7377aad3d6166c46332910244327d`; both worktrees were clean. Closed the app
after testing to drain deferred commits, restored both exact heads, and verified clean
status for both repositories. The test note and all test-generated commits were removed
from the checked-out histories. See `bubble-race-test-heads.json`.

The visible-window randomized run (seed 20261022) performed 30 real pointer drags, six
successful undo/redo pairs, wiki document writes, coverage reads, panel edits, and a
three-save overlapping burst. It passed 23 settled UI/disk comparisons and monitored 3,819
animation frames with zero unexpected position changes or DOM/model mismatches. Positions
were compared by line ID, since bubble arrays legitimately reorder. The initial
hidden-window attempt was excluded: animation frames were suspended and CDP pointer
dispatch was throttled. No performance claim uses that attempt.

Four further rounds interleaved three bubble saves with undo, redo, and a wiki write. All
four settled comparisons passed; another 1,043 frames showed no position anomalies.
However, all four pending-save undo requests refused; a separate fifth reproduction
captured the exact erroneous workspace-drift refusal in `bubble-race-undo-refusal.json`.
`CommandStack.undo()` selects its candidate before `move()` enters serialization, so a
queued save can make that candidate stale before the drift check. Redo then has nothing to
restore. This protects bytes but is an observable command-ordering bug. No production fix
was made in this testing-only turn; next step is resolving undo/redo candidates inside the
serialized operation.

Instrumented random-run bubble medians: save 12.7 ms, Git state 98.5 ms, pre/post
snapshots 2.0/6.3 ms, save-to-refresh 161.4 ms (p95 369.9 ms). Last 33 bubble samples
include the three overlapping saves. The tracker reported `watcher unavailable` and fell
back to authoritative Git; this generic reason does not identify the underlying watch
failure. Tracker policy was unchanged. Wiki writes took about 2.0–3.2 seconds. Under
deliberately queued mixed commands, median bubble queue wait was 1.07 seconds, maximum
3.27 seconds; median save-to-refresh was 1.23 seconds, maximum 3.66 seconds. These are
instrumented mixed-workload measurements, not an isolated warm-save benchmark.

Raw evidence: `bubble-race-live-results.json` and `bubble-race-interleave-results.json`.
Temporary harnesses were deleted; no permanent test or production implementation was
added.

`story.setBubbles` reads only the scene and shots, validates fresh bytes, patches only the
target panels' bubble fields, and returns a small panels result with content revisions.
Full coverage and its existing asset repair run after a 400 ms editing pause. Each new
save invalidates older coverage reads; external command invalidations still request a
reload. The tracker whitelist and Git fallback are unchanged.

| Test                                            | Purpose                                                                                                 | Review                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| Existing bubble session regression updated      | Compare the narrow result with persisted/fresh coverage, retain drift and frame refusal checks          | Reused                 |
| Fresh scene/shots with broken unrelated input   | Proves no full load, preserves external metadata and render fields, refuses a removed scene line        | One combined new case  |
| Scene/shots replacement while staging (2 cases) | Refuses external writes before replacement and cleans up temporary files                                | One parameterized test |
| Existing scoped undo integration extended       | Checks fresh input against the pre-snapshot, refusing a write that would create an incorrect undo point | Reused                 |
| Guarded rename retry                            | Rechecks after a transient lock; preserves the intervening edit and removes the temporary file          | One new case           |

Review complete: four new executed cases in three definitions, two existing tests
extended. Kept the two distinct external-file race cases in one parameterized test; reused
existing session and undo fixtures rather than adding duplicate suites. Atomic replacement
plus content checks is optimistic concurrency, not a filesystem compare-and-swap:
uncooperative writers can still race the final check/rename. The check runs again on each
rename retry. No watcher or timestamp cache authorizes a save.

Live artifacts: `bubble-save-narrow.json`, `bubble-save-narrow-repeat.json`, and
`bubble-save-narrow-final.json`. Each contains 16 real drags plus a restoration save.
Median save time was 8.36/8.18/8.09 ms versus the prior 53.6 ms (about 85% lower).
Save-to-refresh was 41.9/59.0/56.9 ms versus 84.5/96.4 ms previously. Each burst produced
one full coverage refresh, 48.6–52.2 ms, after the 400 ms idle delay; that cost is
deferred and coalesced, not eliminated. Scene reads took about 0.6 ms, shots reads 0.3–0.4
ms, validation under 0.05 ms, and guarded writes 6.4–6.8 ms.

Two live undos and two redos succeeded. Overlapping saves with an older coverage read kept
the latest draft visible immediately, after the first save, and after both saves. All
original bubbles were restored; no draft or pending writes remained. Temporary measurement
code was removed after use. Both typechecks, both desktop builds, and targeted
production-file lint passed.

The combined test run initially passed 258/260: two existing timestamp-sensitive scoped
undo tests failed (`reports the current scoped tree without holding it against pruning`
and `checkScoped/restoreScoped round-trip`). All 18 undo tests passed on isolated rerun,
then all 260 tests passed in the final combined run. Their timestamp-cache behavior and
expectations were not changed by this optimization.

## Bubble save breakdown follow-up

Instrumented per-invocation project loading (read, scene-shot reads, asset repair), shot
reading, bubble validation, persistence, and coverage response construction. The nested
phases overlap their parent `saveMs` and must not be summed with it.

Baseline from 16 real drags: save 56.7 ms, project load 42.1 ms (read 23.9, scene shots
6.9, repair 10.7), validation 0.05 ms, write 6.6 ms, coverage 6.1 ms. The dominant
project-read cost includes fresh reads of 173 wiki documents. A separate read-only probe
found wiki parsing below 0.3 ms; callback-based reads took 3.3–3.8 ms versus 4.3–6.3 ms
for the promise reader after warmup. `readText` now wraps the callback reader in its
existing async API. Every call still reads fresh bytes; no cache or skipped repair was
introduced. Parallel project/input loading experiments gave no clear gain alone and were
removed, preserving the original loading and failure order. Tracker policy and undo
snapshots are unchanged.

Final runs (`bubble-save-final.json`, `bubble-save-final-repeat.json`), each 16 real drags
followed by restoration, measured median save time 53.59/53.57 ms versus 56.73 ms before
(about 6% faster). Project load was 39.54/39.51 ms versus 42.11 ms. Save-to-refresh was
84.5/96.4 ms versus 93.0 ms: that end-to-end improvement is not consistent enough to claim
a win. Writes remained about 6.5 ms, coverage 6.0–6.4 ms, and repair 10.7–11.4 ms.
Nested-phase medians do not necessarily add to the parent's median.

| Test                                                                                   | Purpose                                                                                 | Review                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Fresh UTF-8 read after replacement and missing-file rejection                          | Protects content freshness, decoding, and error propagation through the callback reader | One combined new test retained; no cache or implementation-detail assertions |
| Existing command phase timing regression extended                                      | Nested save timings use the invocation timer without inflating total time               | Reused existing test, no duplicate fixture                                   |
| Existing session, entity discovery, scene, store, scoped undo, and command stack tests | Preserve validation, saved coverage, diagnostics, and individual undo points            | Reused existing coverage                                                     |

Review complete: one new test; one existing timing test extended. All 259 focused tests
passed, as did both typechecks and the main desktop build. Live verification performed two
individual undos followed by two redos, all successful; a fresh page reload confirmed the
original bubbles and zero pending writes. Temporary profiling/measurement scripts were
removed; raw measurements were subsequently removed during repository cleanup.

## Editor-open prewarming follow-up

| Test                                                   | Purpose                                                                                                                     | Review                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Coalesced editor prewarm and clean-first-edit fallback | One setup for overlapping opens, no repeated work, Git still authoritative for clean state, next dirty edit can use tracker | Retained as one combined test; one new executed case |
| Existing whitelist/declaration test extended           | Prewarm obeys opt-in/whitelist and prop validation, creates no command record                                               | Reused instead of adding duplicate whitelist tests   |
| Existing commit/disposal preparation races adapted     | Exercise prewarm entry point through the existing stale-publication checks                                                  | Reused both cases; no duplicate race fixture         |

Review complete: one new test, with existing policy and race coverage extended rather than
duplicated. The focused suite now has 145 cases. One pre-existing scoped undo test
(`checkScoped/restoreScoped round-trip`) failed once during the broad run and passed its
isolated rerun; no undo implementation or expectations were changed for this feature. The
final full rerun passed all 145 tests. Both typechecks and both desktop builds passed.

Live artifacts: `bubble-tracker-prewarm-fast.json`, `bubble-tracker-prewarm-repeat.json`,
and `bubble-tracker-prewarm-verify.json`. First edits after a fresh launch and editor open
took 193/182 ms, second edits 149/147 ms, and warm medians 110/93 ms (drags 3–24).
First-edit samples had cached guards but no dirty witness, so Git remained authoritative.
Full verification: 25 agreements, one fallback, no mismatches; one additional edit used
Git before preparation was ready and has no tracker sample. All original bubbles were
restored. The temporary measurement script was removed after use.

## Background initialization follow-up

| Test                                                     | Purpose                                                                                                                        | Review                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Cold requests during blocked discovery and guard refresh | Proves Git returns before setup or a later audit completes, repeated requests share preparation, then fast path becomes usable | Retained as one combined lifecycle test; no separate redundant refresh test                         |
| Commit/disposal during baseline loading (2 cases)        | Rejects stale background publication and prevents tracker resurrection after disposal                                          | Retained in one parameterized test: commit permits recovery, disposal permanently stops preparation |
| Failed setup retry                                       | Keeps Git authoritative through setup failure and permits later recovery                                                       | Retained; covers rejected creation promises and cleanup of failed cache entries                     |

Existing policy tests now explicitly await preparation when their subject is the warmed
tracker. Their assertions remain about policy and races, rather than incidental setup
timing. The cold-audit race matrix explicitly uses verification mode, where synchronous
guard audits remain intentional. Fast mode separately proves that missing guards trigger
Git fallback and background refresh. Test cleanup awaits outstanding preparation; an
initial Windows EBUSY failure exposed disposal clearing its job bookkeeping before jobs
drained, which is now fixed in production as well.

Follow-up review complete: four new executed cases in three definitions, reusing the
existing repository fixture. No redundant standalone tests remain. The combined focused
suite now contains 144 tests.

Final live runs: `bubble-tracker-background-final.json` and
`bubble-tracker-background-repeat.json` measured cold edits of 199/198 ms and warm-edit
medians of 107/88 ms (drags 3–24). Neither performed synchronous guard audits on the fast
path. `bubble-tracker-background-verify.json` recorded 24 agreements and no mismatches;
three additional edits used Git during preparation and have no tracker sample. All runs
crossed a deferred-commit boundary and restored the original bubbles. Temporary CDP
measurement code was removed after use; raw results were subsequently removed during
repository cleanup.

## Original whitelist rollout

| Test                                                                       | Purpose                                                                           | Review                                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Git: per-file witnesses and sampled/default/unsupported fallback           | Proves actual Git status calls are skipped only on eligible requests              | Retained as one integration test; pruned redundant empty-file-list assertion because the multiple-file case covers the same eligibility branch |
| Git: commit hold and in-flight invalidation                                | Prevents stale results during commits, checks baseline reset and disposal         | Retained; tests the outer policy after a prediction completes, distinct from races inside the predictor                                        |
| Git: sampled mismatch                                                      | Disables fast path across the Git instance                                        | Retained; verifies fallback returns Git's answer and subsequent calls cannot use predictions                                                   |
| Git: commit/reset/index flag/baseline replacement during audit (4 cases)   | Tests changed evidence inside a prediction window                                 | Condensed into one parameterized test; retained all four distinct transitions                                                                  |
| Commands: whitelist and declarations                                       | Requires host approval and uses invocation-specific files without an undo journal | Condensed default-off, whitelisted, unlisted, and undeclared behavior into one test                                                            |
| Commands: immediate/batch/self commits (3 cases, success and failure each) | Ensures holds are released on all commit paths                                    | One parameterized test; success/failure share fixtures and assertions                                                                          |

Review complete: 11 new executed cases in six test definitions across
`packages/git/src/tests/provenance-policy.test.ts` and
`packages/commands/src/tests/provenance-policy.test.ts`. No remaining case duplicates
another case's failure mode. Existing guard-cache tests remain relevant and unchanged. The
final focused suite includes 140 tests, including Git, tracker, command timing, origin,
and undo regressions.

Live checks (not permanent automated tests): 26 drags plus restoration in each mode,
including a deferred commit between drags 24 and 25. Full verification: 25 agreements, 2
fallbacks, zero mismatches. Fast path: 24 uses, 1 agreeing sample, 2 fallbacks. Both runs
restored the original bubbles. The temporary CDP measurement script was removed; raw
timing artifacts were subsequently removed during repository cleanup.

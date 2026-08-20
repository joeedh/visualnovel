# Plan: refine-loop inspector

**Status:** shipped. **Depends on:** [desktop renderer restructure](desktop-renderer-restructure.md).
**Size:** small — the cheapest item in [`../../research/graphThingsReport.md`](../../research/graphThingsReport.md) §6.

## Why

`shot_image` folds the whole P7 generate → critique → refine loop into one runner
(`packages/pipeline/src/runners.ts:100`), so the FLOOR task board shows a single node that
inexplicably made four image calls and then went `needs_human`. When a shot fails, the app
tells you `⚑ needs_human — max refine attempts reached` and nothing else
(`Floor.tsx:109`).

Everything needed to explain the failure is already fetched. `PipelineStatus.tasks` carries
full `Task` objects; each `TaskAttempt` (`packages/types/src/tasks.ts:51`) holds `prompt`,
`refs`, `output`, `reviews`, `error`, `at`. The current inspector renders that as
`→ a1b2c3d4` per row (`Floor.tsx:124`) and **drops `reviews` entirely** — which is the one
field that says why.

Three facts make this unusually cheap and unusually good:

- **Every attempt has a viewable image.** The runner calls `store.write` on every attempt
  and `store.accept` only on the clean one, so rejected frames are in the content-addressed
  store and already serveable over `vnasset://<hash>.<ext>`. The inspector can show the
  actual rejected images.
- **The prompt delta is exact, not inferred.** `refinePrompt`
  (`packages/pipeline/src/p6.ts:9`) strips any prior `Corrections:` clause and appends a new
  one built from each `Defect.suggestedFix`. The delta between attempt N and N+1 *is* that
  clause — no diffing heuristic needed.
- **Defects are structured.** `DefectReport { reviewer, defects: Defect[] }` with
  `severity: 'blocking' | 'major' | 'minor'`, `category`, `description`, `suggestedFix`.

## Scope

Replace the flat attempts list in the FLOOR inspector with the loop as it actually ran.
Read-only. No new IPC channel, no new command, no pipeline changes.

**Out of scope:** re-running a task from the UI, editing a prompt, per-reviewer
configuration, and anything on the other six task kinds (they have at most one attempt —
they render as a single frame and that is correct).

## Data plumbing

`TaskAttempt.reviews` is typed `unknown[]`, because it is read back from `tasks.jsonl` as
JSON on resume and the persisted type should not claim more than it can prove.

**Do not widen that type.** Validate at the boundary instead, per the repo convention:
in `apps/desktop/src/main/commands/pipeline.ts` (or wherever `pipeline:status` is
assembled), parse each attempt's `reviews` with the existing `defectReportSchema`
(`packages/types/src/schemas.ts:78`) and drop entries that fail. Add a narrowed
`reviews: DefectReport[]` to the desktop-side attempt shape in `src/shared/ipc.ts`.

A malformed review must degrade to "no critique recorded", never break the inspector — a
task that failed is exactly when the log is most likely to be ragged.

## Design

Extends the existing system; adds nothing. Attempts are machine work, so the whole panel
lives on the **cool** side: `--signal` for structure and hashes, `--mono` for ids,
`--prose` (Newsreader) for defect descriptions — reviewer critique is written language and
should read like it, which also separates it visually from the ids around it.

The one structural idea: **the loop reads as a vertical spine, not a list.** Attempts stack
downward; between consecutive attempts sits the correction that caused the next one. That
gap is the causal step, so it gets the visual weight — a hairline rule with the
`Corrections:` text on it — rather than the attempts themselves.

Numbered markers are appropriate here, unusually: the attempts genuinely are a sequence and
the number is the loop counter the runner used.

```
┌─ ATTEMPT 01 ─────────────── a1b2c3d4 ─┐
│  [ thumbnail — vnasset://a1b2c3d4.png ]│
│  ⬤ blocking  hair        wrong color   │   ← severity dot: vermilion / sodium / mist
│  ⬤ minor     framing     too centered  │
└────────────────────────────────────────┘
     │  ✎  Corrections: use auburn hair; tighten framing.
     ▼
┌─ ATTEMPT 02 ─────────────── e5f6a7b8 ─┐
│  [ thumbnail ]                    ✓ accepted
└────────────────────────────────────────┘
```

Severity maps onto tokens already in `tokens.css`: `blocking` → `--vermilion`,
`major` → `--sodium`, `minor` → `--mist`. Reviewer name is a small `--mono` tag when more
than one reviewer is configured, omitted when there is only one (no legend for a
one-element set).

Clicking a thumbnail opens the full frame. Reuse the existing `.overlay` treatment from
`GateOverlay` rather than introducing a second lightbox idiom.

## Files

```
renderer/rooms/floor/
  Inspector.tsx        thinner: header + delegate to AttemptLoop
  AttemptLoop.tsx      the spine
  attempts.ts          pure: group reviews, merge per attempt, compute the delta
  tests/attempts.test.ts
```

`attempts.ts` holds the logic worth testing:

- `mergeAttemptReviews(reviews)` → defects flattened across reviewers, deduped, sorted
  blocking-first. Mirror `mergeReports` from `@vn/providers` in *ordering* so the UI agrees
  with what the runner acted on; do not re-derive `blocking` differently.
- `correctionDelta(prev, next)` → the `Corrections:` clause `refinePrompt` added, or null.
  Must handle the strip-and-replace case (attempt 3's clause replaces attempt 2's, so a
  naive suffix diff is wrong).
- `attemptOutcome(task, attempt, index)` → `'accepted' | 'rejected' | 'failed'`. Only the
  last attempt of a `done` task is accepted; a `needs_human` task has none.

## As shipped

Five deviations, each forced by the recorded fixture run rather than chosen up front:

- **`attemptOutcome` has a fourth value, `'pending'`.** The plan's three assume the loop has
  ruled. A `running` task's last attempt has not been judged yet, and calling it `rejected`
  would assert a verdict the runner never reached.
- **`TaskAttempt` gained `outputExt`, stamped in main.** An attempt records only the output
  hash; the ext lives in the manifest. `vnasset://<hash>` with a guessed `png` silently
  mis-serves anything else, so `narrowTask` looks the ext up and the renderer builds a url
  only when it has both halves. This is also what makes the mock-run degradation clean: with
  no manifest entry there is no `outputExt`, so no `<img>` is emitted at all — placeholders,
  not broken images.
- **`promptRepeated(prev, next)`.** Observed live: when every reviewer repeats its critique
  verbatim, `refinePrompt` strips and re-appends an identical `Corrections:` clause, so two
  attempts share a byte-identical prompt (and produced the same output hash). `correctionDelta`
  is correctly null there, but an unexplained gap between two identical frames reads as a
  rendering bug — so the gap says *same critique — the prompt did not change*.
- **The defect dedupe is display-only, and diverges from the runner.** `mergeReports`
  (`packages/providers/src/review.ts:52`) only flatMaps and checks for a blocking severity —
  it does not dedupe, so a fix agreed on by two reviewers really does appear twice in the
  `Corrections:` clause. The UI collapses the pair and keeps both reviewer names; `blocking`
  is still computed exactly as the runner computes it.
- **The `needs_human` triage lives in `Inspector.tsx`, not the spine**, above the attempts
  rather than after them — the question "why did this stop" is asked before the loop is read.

## Verification

- `pnpm test` — the pure functions, including the strip-and-replace delta case, a verbatim
  multi-defect clause from the recorded run, and a malformed-`reviews` payload.
- Live: a mock run stores no image bytes, so no attempt resolves an `outputExt` and the
  panel renders `no stored frame` placeholders — structure only, zero `<img>` elements.
  Verified against a copy of the fixture with `build/assets` emptied.
- Live with real assets: neither approach in the original plan works. A hand-written
  `tasks.jsonl` cannot produce viewable frames (the bytes must exist in the store), and
  `templates/basic` must never carry fabricated provenance. What was used instead: a
  throwaway project built by `@vn/testkit` and driven through the **real** `runPipeline` with
  a scripted reviewer backend that blocks the first N attempts of chosen shots, plus an image
  backend emitting real PNG bytes. That yields genuine three-attempt `done` and `needs_human`
  tasks. One trap: `ShotSpec.location` is a **variant id**, not a location name, and every
  testkit location defaults to `variants: ['day']` — a reviewer policy keyed on the location
  name matches nothing and every shot comes out one-attempt.

```sh
# `byOwner` is an exact match on ids of the form `AttemptLoop/div.loop`, so the bare
# component name matches nothing. Match the prefix instead.
node scripts/vn-cdp.mjs --raw "window.__vnDebug.where(f => f.owner.id.startsWith('AttemptLoop')).table()"
```

## Risks

- **Multi-attempt tasks are rare in practice**, so this is easy to build against nothing and
  discover it is wrong later. Build the fixture first; do not defer it.
- **Mock runs write no image bytes**, so `vnasset://` 404s for every attempt. The empty
  state has to be a deliberate design, not an accident.

## Done

- [x] Attempts render as a causal spine with per-attempt defects and thumbnails
- [x] `reviews` validated at the main-process boundary; malformed data degrades gracefully
- [x] Correction delta shown between attempts, correct across the strip-and-replace case
- [x] `needs_human` explains itself: which defects survived, from which reviewer
- [x] Pure logic under test; `.tsx` holds no logic worth testing

# Plan: refine-loop inspector

**Status:** not started. **Depends on:** [desktop renderer restructure](desktop-renderer-restructure.md).
**Size:** small — the cheapest item in [`../research/graphThingsReport.md`](../research/graphThingsReport.md) §6.

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

## Verification

- `pnpm test` — the three pure functions, including the strip-and-replace delta case and a
  malformed-`reviews` payload.
- Live: a mock run produces no images, so the thumbnails will be empty by design. Confirm
  the panel degrades to structure-only rather than showing broken images.
- Live with real assets: run `examples/sample` non-mock far enough to get a multi-attempt
  shot, or hand-craft a `tasks.jsonl` fixture with a three-attempt task.

```sh
node scripts/vn-cdp.mjs --raw "window.__vnDebug.byOwner('AttemptLoop').table()"
```

## Risks

- **Multi-attempt tasks are rare in practice**, so this is easy to build against nothing and
  discover it is wrong later. Build the fixture first; do not defer it.
- **Mock runs write no image bytes**, so `vnasset://` 404s for every attempt. The empty
  state has to be a deliberate design, not an accident.

## Done

- [ ] Attempts render as a causal spine with per-attempt defects and thumbnails
- [ ] `reviews` validated at the main-process boundary; malformed data degrades gracefully
- [ ] Correction delta shown between attempts, correct across the strip-and-replace case
- [ ] `needs_human` explains itself: which defects survived, from which reviewer
- [ ] Pure logic under test; `.tsx` holds no logic worth testing

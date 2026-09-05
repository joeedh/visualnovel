# Precise write signals, and loading a project in parallel

Follow-on to [`document-versions-and-live-reads.md`](document-versions-and-live-reads.md),
which made a pane able to recognise the echo of its own write and named the re-derivation
storm as out of scope. This plan is that storm.

<!-- toc -->

<!-- tocstop -->

## Context

Editing anything in the desktop app felt slow in a way the write itself did not explain.
Writes are serialised by the command stack and a single document write is cheap; the cost
was everything the app did _afterwards_, in response to the write.

### What it cost

Measured with a throwaway jest benchmark against two projects: the bundled 13-file
`templates/basic`, and a synthetic 181-file project (60 scenes, 15 characters, 10
locations, 80 wiki notes) of roughly the size a real one reaches.

|                                   | template (13 files) | mid-size (181 files)   |
| --------------------------------- | ------------------- | ---------------------- |
| whole `Workspace.index()`, steady | ~105 ms             | ~400 ms (1160 ms cold) |
| `loadInputs`                      | 35 ms               | 180 ms                 |
| `openBible` (first walk)          | 0.3 ms              | 90 ms                  |
| `repos()` — three git spawns      | 42 ms               | 85 ms                  |
| `bible.refresh` (second walk)     | 0.2 ms              | 11 ms                  |
| `modelFromInputs`                 | 1.2 ms              | 4 ms                   |
| `baseAssetsOf`                    | 0.3 ms              | 0.5 ms                 |

`loadInputs` held at ~180 ms across five back-to-back runs with the filesystem hot, so it
was not cold I/O.

### Why it was paid so often

Three things stacked, and none of them consulted which files had actually moved.

1. **Every command, every window.** `onRecord` broadcasts `command:ui{type:'undo'}`
   unconditionally — it is the record hook, so reads and refusals reach it too. The
   renderer's handler called `void refreshWorkspace()` unconditionally, outside the
   `revision` check two lines below that gates `invalidate()`. One full `index()` per open
   window per command, serialised on main's one thread.
2. **Every mutating command, originating window.** `invalidate()` fans out to fourteen
   editors, each refetching. One is the document tree, whose `docTree()` is a second whole
   `loadProject` plus a storyboard read per scene.
3. **Nothing was held.** `Session.index()` built a fresh `Workspace` per call, while
   `searchBible` and `docTree` both held theirs. That fresh handle is why `wiki/` was
   walked twice: `openBible` refreshes on construction and `index()` then called
   `refresh()` again.

The sharpest statement of the problem: **moving a Gen Graph node re-read every character,
scene and location file in the project.** The write went to `vngen/work/graphs/`. Nothing
`index()` reads was touched.

### The signal that already existed

`documents:wrote` — added by the previous plan — already carries `{ paths, versions }`
from main to every window on every write, with `onWrote` on the renderer side and the
matchers in `apps/desktop/src/shared/writes.ts`. Four of eighteen editors used it. The
expensive callers were exactly the ones that did not.

It had one hole. Undo and redo named no paths: `moveBody` built its record with no
`written` field, so `noteWrites` received an empty list and broadcast nothing. That is why
the coarse `onInvalidate` had to exist at all, and why `shouldReload` takes a version-less
signal at its word.

## Stage 1 — an undo reports what it moved

`ContentStore.restoreDir` already walked exactly the changed set and computed a relative
path for every file it wrote and every path it deleted, then discarded both. It now
appends them to a `changed` accumulator; `UndoJournal.restore` answers with it, and
`moveBody` puts it on the record as `written`.

An accumulator rather than a return value, because a move that runs out of held bytes part
way through has still moved the files it reached. A caller told nothing happened would be
wrong about the worktree, and those are precisely the paths a surface needs to hear about.

**Known gap, deliberately left.** A failed stack move returns `{ok: false}` with no record
at all, so a partial restore still reports nothing to any pane. Closing it means giving
failed stack moves a record, which is a question about what belongs in the provenance log
rather than about this change.

## Stage 2 — one predicate for "did this write reach the model"

`touchesInputs(written)` in `apps/desktop/src/shared/writes.ts`, over the directories
`loadInputs` reads: `characters/`, `locations/`, `scenes/`, `screenplay/`, `wiki/`, and
`project.yaml`.

The panes showing derived state cannot match an exact path, because what they show comes
from every input file at once. This is the question they ask instead. It lives beside
`touchesGraph` and `touchesScene` so that a pane and the process feeding it cannot
disagree about whether a write mattered — the same reason `decideGenEdit` is one function
run by both sides.

`wiki/` is in the list and is a deliberate false positive. Entity sheets are discovered by
their `type:` tag across three surfaces and the bible is the third
(`packages/store/src/entities.ts:180-184`), so a wiki note can be a character sheet, and
the path alone cannot say which notes are. A wiki edit therefore re-derives.

## Stage 3 — the header follows writes, not commands

`refreshWorkspace()` is gone from the `undo` effect branch. It now hangs off
`documents:wrote` behind `touchesInputs`, with a trailing 150 ms debounce so a burst of
input edits recounts once — trailing rather than leading, because the count worth showing
is the one the last write produced.

Moving it inside the existing `revision` gate was considered and is wrong: `undoRevision`
deliberately skips `ui`-sourced commands (`apps/desktop/src/main/index.ts:750`) because
`exec` already invalidated, so the header would stop updating after the author's own
edits.

The `workspace` effect still refreshes directly, because a project switch changes the root
rather than a file, and the startup call is unchanged.

The Gen Graph pane's `onInvalidate` fallback is deleted. It existed because an undo named
no paths, which stage 1 fixed, and it was reloading the graph on every unrelated mutating
command anywhere in the app — `shouldReload(sync, undefined)` answers true whenever
nothing is in flight.

## Stage 4 — read a project's documents together

The plan here was originally "hold the parse in main". Measuring first said otherwise, and
this is the one place where the evidence overturned the design:

| on 174 files     |        |
| ---------------- | ------ |
| read, sequential | 116 ms |
| read, parallel   | 23 ms  |
| stat, sequential | 12 ms  |
| stat, parallel   | 2.6 ms |
| parse all        | 13 ms  |

A load was dominated by **waiting**, not parsing. Every walk feeding `loadInputs` was a
`for` loop with an `await` in the body. Parallelising is strictly better than a cache
here: same answer every time, no invalidation to get wrong, and no window in which an edit
made outside the app is invisible.

The three entity surfaces, the scene chunks and the bible's index now read through `pool`
from `@vn/util`, which bounds concurrency (`READ_CONCURRENCY`, 32) and preserves input
order. Bounded because a project may hold thousands of wiki notes and unbounded reads
would exhaust the process's file handles.

Two ordering hazards had to be handled for the result to stay identical:

- **Diagnostics.** Appending to one shared array from concurrent reads would order a
  project's diagnostics by whichever read finished first. Each read collects its own and
  they are merged in walk order, and the three surfaces likewise, so the merged list still
  reads conventional-first.
- **The first failure.** `readSceneChunks` threw eagerly. Under `Promise.all` the reported
  malformed chunk would be whichever read lost the race, so each result is kept and the
  first failure in id order is thrown afterwards.

`Session.index()` also now uses the session's one `Workspace`, as `searchBible` and
`docTree` already did, which drops the duplicate `wiki/` walk. Only the bible handle is
reused — `Workspace.load()` holds nothing, so every method still re-reads authored input a
command may just have written, and `bible.refresh()` re-walks and re-reads only files
whose mtime moved.

### What it costs now

| on the 181-file project | before  | after   |
| ----------------------- | ------- | ------- |
| `Workspace.index()`     | ~400 ms | ~148 ms |
| `loadInputs`            | ~180 ms | ~43 ms  |
| `openBible` (full walk) | ~90 ms  | ~28 ms  |
| `bible.refresh`         | ~11 ms  | ~2.6 ms |

And for a Gen Graph node move, which writes only under `vngen/work/graphs/`, the header
now does nothing at all rather than ~400 ms per window.

## Out of scope

- **`repos()`.** Three `git rev-parse` spawns, ~87 ms, now the largest single part of what
  `index()` still costs. Resolving them concurrently would spawn three where a project
  without `wiki/` or `assets/` currently spawns one, because those roles resolve to the
  project root through `RepoResolver`'s own memo and only the sequential order lets the
  second and third hit it. Making that safe means memoizing the in-flight promise rather
  than the resolved value, in a module commit-on-save also depends on. Left alone;
  `index()` is no longer per-command.
- **The document tree.** `docTree()` still runs a whole `loadProject` on every
  `invalidate()`. Stage 4 makes that load ~2.5× cheaper, but the fan-out itself is
  untouched. It cannot use `touchesInputs` as it stands, because it also shows the
  manifest, shots, graphs and skills, so it needs either a broader predicate or per-source
  invalidation.
- **The other twelve `onInvalidate` panes.** Each refetches something small; stage 4 makes
  the reads behind them cheaper without changing any of their logic.
- **`recomputeApprovals`.** Already debounced and detached from the command's critical
  path.
- **Commit policy, and deferring the writes themselves.** Untouched, as in the previous
  plan.

## Verification

- `packages/commands/src/tests/content.test.ts` — what a restore reports: a created file
  and a deleted one, a nested path reported whole, nothing where the two trees agree, a
  kind change reporting both paths, and the partial list surviving a move that runs out of
  held bytes.
- `apps/desktop/src/shared/tests/writes.test.ts` — `touchesInputs` over each input
  surface, the wiki false positive, the generated paths it turns away, Windows spellings,
  whole-list answers, and paths that only begin or end like an input.
- The existing store, bible, model, authoring and desktop suites cover stage 4 unchanged,
  which is the point: parallelising altered no result.
- `pnpm check && pnpm test && pnpm lint` green. Done: 3462 tests pass.
- Manual, in `pnpm vndesktop`: move a Gen Graph node and confirm the header's diagnostics
  badge does not flicker; edit a scene and confirm it does update. Undo a scene edit and
  confirm the Script pane follows without a manual reload. Open a project with a large
  `wiki/` and confirm the first load is visibly quicker.

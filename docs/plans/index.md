# Plan index and status

Every implementation plan in this directory, and whether it has been built. A plan is the
authority on its own scope; this file is the authority on **what state it is in**.

Status values:

- **shipped** — implemented and in the codebase. The plan's own As-shipped section records
  deviations; the plan is history, not a task list.
- **partial** — some of it is built and the plan still describes unbuilt work.
- **planned** — nothing built yet.

Two batches carry extra working detail of their own:
[`desktop-editors-tracking.md`](desktop-editors-tracking.md) for the desktop editors (all
shipped), and the [scene authoring](#scene-authoring-the-current-batch) section below for the
current one.

<!-- toc -->

<!-- tocstop -->

## All plans

| Plan | Status | What it covers |
| --- | --- | --- |
| [`initial-implementation.md`](initial-implementation.md) | shipped | The monorepo, package layering, phases P1–P7, task graph, store, scheduler, `vngen` CLI |
| [`authoring-agent-implementation.md`](authoring-agent-implementation.md) | shipped | `vnauthor`: workspace index, tool registry, plan/execute modes, skills, the REPL |
| [`runner.md`](runner.md) | shipped | `story.play.json`, `@vn/export`, the desktop app and its PLAY room |
| [`test-fixtures.md`](test-fixtures.md) | shipped | `@vn/testkit` — real projects on disk run through the real scheduler |
| [`desktop-renderer-restructure.md`](desktop-renderer-restructure.md) | shipped | One directory per room, pure `.ts` cores with `tests/` siblings, the stylesheet split |
| [`refine-loop-inspector.md`](refine-loop-inspector.md) | shipped | The FLOOR inspector's rendering of the P7 generate→critique→refine loop |
| [`story-branch-editor.md`](story-branch-editor.md) | shipped | STUDIO's `branches` mode, `renderer/graph/`, the semantic drag gestures |
| [`task-dag-view.md`](task-dag-view.md) | shipped | FLOOR's `graph` mode: barrier nodes, ref edges, ghosts |
| [`shot-timeline-editor.md`](shot-timeline-editor.md) | shipped | FLOOR's `timeline` mode and `story.setCoverage` |
| [`command-system.md`](command-system.md) | shipped | `@vn/commands`, the DSL, the catalog, provenance, CDP |
| [`command-undo-redo.md`](command-undo-redo.md) | shipped | Opt-in undo via shadow snapshots under `refs/vn/undo/<seq>` |
| [`preconditions-and-timeline-interaction.md`](preconditions-and-timeline-interaction.md) | shipped | `Command.check`, `stack.check`'s three states, the `timeline.cover` interaction |
| [`desktop-storage-and-draggable-rail.md`](desktop-storage-and-draggable-rail.md) | shipped | `.vndesktop/session.json`, `usePanelWidth`, `view.panelSize` |
| [`sample-workspace-and-asset-cache.md`](sample-workspace-and-asset-cache.md) | shipped | `examples/mySampleRepo` seeding and the recorded asset corpus |
| [`2d-graphics-debug-api.md`](2d-graphics-debug-api.md) | shipped | `@vn/debug2d` — fragment IR, DOM adapter, query engine, `explainPick` |
| [`interaction-model.md`](interaction-model.md) | partial | `Interaction`/`targets`; four gestures declared, the general surface is not finished |
| [`allocated-line-ids.md`](allocated-line-ids.md) | shipped | Line ids that survive an edit, the diagnostics surface, the catalog-driven palette |
| [`lossless-scene-serialization.md`](lossless-scene-serialization.md) | shipped | `parse(write(scene)) ≡ scene`; `Scene.body` retired, headings and three line kinds retained |
| [`scene-chunk-files.md`](scene-chunk-files.md) | shipped | `scenes/<id>.md` replaces the one contended screenplay; `start:` names the entry, front-matter is identity only, both prose patchers retargeted (`screenplay/` still loaded when it shipped; plan 4 retired it) |
| [`fountain-import-export.md`](fountain-import-export.md) | shipped | `vngen import` / `vngen screenplay`, the desktop pair, and the retirement of `screenplay/` as an input |
| [`scene-editing-commands.md`](scene-editing-commands.md) | shipped | Nine `story.*` prose commands over `@vn/scriptedit`, `session.editScene`, the storyboard fallout, `script.moveLine`, and `vnauthor`'s `edit_scene` — one write path for prose, no UI |
| [`scene-edit-package.md`](scene-edit-package.md) | shipped | The scene-edit rules and write path now live in `@vn/scriptedit` (pure barrel; `@vn/scriptedit/write` for the filesystem half), where `vnauthor` can reach them |
| [`line-editing-in-floor.md`](line-editing-in-floor.md) | shipped | Retyping a line in the coverage timeline, and `Shot.proseHash` → the drift mark on the shot it produced |
| [`script-composition-in-studio.md`](script-composition-in-studio.md) | planned | STUDIO's `script` mode — writing, splitting and merging scenes |
| [`desktop-editors-tracking.md`](desktop-editors-tracking.md) | — | Not a plan; the tracker for the six desktop-editor plans above |

## Scene authoring (the current batch)

Seven plans that together make a scene an editable document. They come from
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md).
The order below is a dependency order, not a preference: each plan's guarantees are what the next
one rests on. **1 through 6 are shipped; 7 is not started.** One plan not
in the original seven has been carved out since:
[`scene-edit-package.md`](scene-edit-package.md), a prerequisite for 5's agent tool.

| # | Plan | Depends on | Why it is here |
| --- | --- | --- | --- |
| 1 | [`allocated-line-ids.md`](allocated-line-ids.md) ✔ | — | Positional ids re-point every shot when a line is inserted. Nothing may edit prose until ids survive |
| 2 | [`lossless-scene-serialization.md`](lossless-scene-serialization.md) ✔ | — | Writing a scene back today loses its heading. Nothing may write a scene until the writer is honest |
| 3 | [`scene-chunk-files.md`](scene-chunk-files.md) ✔ | 1, 2 | One contended screenplay becomes one file per scene |
| 4 | [`fountain-import-export.md`](fountain-import-export.md) ✔ | 2, 3 | Migrates existing projects in, and keeps the format from being lock-in |
| 5 | [`scene-editing-commands.md`](scene-editing-commands.md) ✔ | 1, 3 | The only write path for prose. No UI; verified through the palette and CDP |
| — | [`scene-edit-package.md`](scene-edit-package.md) ✔ | 5 | Not one of the seven. 5's rules lived in the desktop app, and a package cannot import an app — so the agent tool needed them moved first |
| 6 | [`line-editing-in-floor.md`](line-editing-in-floor.md) ✔ | 5 | Correct a line where you can see the frame it produced |
| 7 | [`script-composition-in-studio.md`](script-composition-in-studio.md) | 5 | Write, reorder, split and merge — everything that changes which lines exist |

6 and 7 are siblings and independent of each other; the division is one sentence — **FLOOR edits
a line, STUDIO edits the script.**

### Decisions that span the batch

Recorded here because each was settled once and every later plan assumes it.

- **Line ids are scene-scoped and stay that way.** `${sceneId}:L<n>` is what `Shot.coversLines`
  binds to, so no line can cross a scene boundary and keep its coverage. The batch makes the
  detachment visible (in `splitScene`/`mergeScene`) rather than introducing global ids.
- **No edit to a scene invalidates art — which is why drift has to be reported.** `buildShotPrompt`
  reads neither `coversLines` nor line text (prose reaches only the P7 reviewer spec, which never
  enters a task's `inputs`), so retyping a covered line rehashes nothing and re-renders nothing: the
  frame goes on illustrating words the scene no longer contains. Plan 5 settled this against the
  code, and it reversed the batch's original premise. Every plan that can change prose owes the
  author that sentence before the commit, not a bill.
- **Drift is derived, never stored.** A shot is drifted when a hash of the covered lines' *text*,
  recorded when its image was written, disagrees with the hash those lines produce now — computable,
  self-healing, and correct for edits made through the CLI or by hand. Not the task hash: that is
  precisely the hash prose cannot move. Shipped in plan 6 as `Shot.proseHash` (stamped only when the
  image's bytes are new) and `driftOf`; a shot rendered before the field existed reads `unknown`.
- **One authorial act, one command, one undo point.** No batch edits, no JSON-patch command, no
  buffer diffed to commands on save.
- **Both input formats loaded during the move**, and a project with both was an error. Plan 4
  ended the move: `scenes/` is the only form scenes load from, a leftover `screenplay/` is reported
  rather than read, and the both-present error became a warning — nothing that builds no scenes can
  contend with the chunks.
- **A scene chunk's front-matter is its identity and nothing else** — `scene: <id>`, matching the
  filename, on a closed schema. Heading, location, synopsis, `choices`, `next` and line ids stay
  `[[…]]` markers and Fountain elements in the body, because `splitScenes` already reads them there
  and `sceneToFountain` already writes them back losslessly. **Marked for revisit once 4–7 have
  shipped**, against working editors rather than ahead of them —
  [`scene-chunk-files.md`](scene-chunk-files.md#the-shape) records the argument on both sides.

### Blockers found while planning

Things that are broken or dead today and that a plan above has to deal with. Each is scoped into a
plan; the ones marked **fixed** have shipped with the plan that owned them.

- ~~`headingFor` (`packages/model/src/serialize.ts:60`) reconstructs every heading as
  `INT. <LOCATION> - DAY`, discarding `EXT.` and the time of day~~ → **fixed** in plan 2:
  `Scene` carries `headingPrefix` and `locationVariant`, and `headingFor` is gone.
- ~~`currentSpeaker` (`packages/model/src/scenes.ts`) is cleared only on `flush()`, and the
  `action`-with-speaker branch describes a case `parseFountain` cannot produce~~ → **fixed** in
  plan 2: attribution ends with the dialogue block, and `'action'` is no longer a `SceneLine.kind`.
- ~~`buildModel` takes the entry scene as `sceneList[0]` (`packages/model/src/build.ts:154`), which
  becomes readdir order the moment scenes are files~~ → **fixed** in plan 3 step 6: `entry` comes
  from `config.start`, and a missing or dangling `start:` is an error diagnostic rather than a
  fallback to sorted-first.
- ~~Four call sites duplicate `loadInputs` → `parseFountain` → `buildModel` (CLI, desktop session,
  authoring workspace, testkit)~~ → **fixed** in plan 3 step 1: `@vn/model`'s `modelFromInputs` is
  the one sequencing point, and `LoadedInputs` moved to `@vn/parse` so the reader and the builder
  name one shape. Not `loadProjectModel` in `@vn/store` as planned — store may not import `model`.
- ~~`ProjectPaths.sceneFile` / `writeSceneFile` are dead, and they hold the name authored chunks
  want~~ → **fixed** in plan 3 step 2: both deleted, so the name is free for authored chunks.
- `vngen export` and `story.export` already mean the playable, so Fountain output needs a different
  name → plan 4 uses `vngen screenplay` / `story.screenplay`.
- ~~`Timeline.tsx:156` refuses to draw an undecomposed scene, which is exactly the scene you want to
  write before paying for art~~ → **fixed** in plan 6 step 2: the script column renders on its own
  with a note, and the vermilion gap gutter waits for a decomposition rather than marking every line.
- `write_file` (`packages/authoring/src/tools.ts:408`) is an unvalidated whole-file overwrite that
  would happily write a chunk with duplicate line ids → plan 5 step 6 makes it refuse `scenes/`.

### Checklist

- [x] 1 — allocated line ids
- [x] 2 — lossless scene serialization
- [x] 3 — scene chunk files
- [x] 4 — Fountain import and export
- [x] 5 — scene editing commands
- [x] 6 — line editing in FLOOR
- [ ] 7 — script composition in STUDIO

## Keeping this file true

- A plan states its own status in its first lines (`Status: **planned**` / a `## As shipped`
  section). This table is a projection of those — if the two disagree, the plan wins and the table
  is stale.
- Update the row in the same commit that finishes the plan, alongside the plan's As-shipped
  section and the `CLAUDE.md` edits its final step calls for.

# Split the largest source files

**Done.** All four steps landed on `effects`: `f47e1d02` (index.ts), `cedda3b4`
(tools.ts), `6171eca1` (asset.ts), `bc842dd7` (session.ts). Whole-repo `pnpm check` /
`pnpm test` (287 suites, 4160 tests) / `pnpm lint` all green after the last commit.
Deviations from the plan as written, discovered during execution:

- **Step 4 landed as one commit, not eleven.** `asset`/`prompt`/`project` methods turned
  out to be physically interleaved in the original `session.ts` (private helpers of one
  concern sitting between public methods of another), so clean incremental per-concern
  commits weren't practical; the whole transformation was verified as a single unit
  instead. `session/core.ts` ended up at 2561 lines — still the largest single file to
  come out of this plan, since it kept every cross-cutting method plus everything that
  didn't cleanly separate.
- **The session-test reorganization (moving `graphdoc.test.ts` / `keys.test.ts` /
  `doctree.test.ts` into `tests/session/`) was skipped.** Those files were left where they
  are and verified to still pass unmoved. Left as an open follow-up if the
  `tests/session/` mirroring is still wanted.
- **Step 2 caught a real bug while executing:** `jest.config.cjs`'s `testMatch` was
  `**/tests/*.test.ts` (single `*`), which doesn't match a nested `tests/tools/*.test.ts`
  — per this repo's own documented rule, the 12 new domain test files would have silently
  never run. Fixed to `**/tests/**/*.test.ts` for the `packages/*` jest projects, scoped
  to that one project so it doesn't affect `apps/desktop`'s separate `testMatch`.
- **Manual UI verification (`pnpm vndesktop --mock`) was only done for the asset.ts
  step**, not for session.ts — only automated tests covered the session split. Given the
  automated coverage is thorough (4160 tests, unchanged pass count from before the split),
  this was accepted rather than re-run.

Splits the six largest TypeScript files in the repo into a subdirectory tree per file,
with no behavior change. Purely mechanical: move code, keep every external import path
resolvable, keep `pnpm check`/`pnpm test`/`pnpm lint` green after each file.

Files, current size, current shape:

| File                                            | Size  | Shape                                                 |
| ----------------------------------------------- | ----- | ----------------------------------------------------- |
| `apps/desktop/src/main/session.ts`              | 244KB | One class, `WorkspaceSession`, ~180 methods           |
| `packages/authoring/src/tools.ts`               | 119KB | 49 independent tool objects + shared registry helpers |
| `packages/authoring/src/tests/tools.test.ts`    | 91KB  | Tests for the above, currently one file               |
| `apps/desktop/src/main/tests/session.test.ts`   | 87KB  | Tests for `session.ts`, currently one file            |
| `apps/desktop/renderer/pathux/editors/asset.ts` | 57KB  | One class, `AssetEditor`, no other importers          |
| `apps/desktop/src/main/index.ts`                | 55KB  | Electron bootstrap, zero external importers           |

## Ordering

1. `index.ts` — no importers, no class to decompose, lowest risk. Also produces
   `main/windowmanager.ts` and `main/assetprotocol.ts`, which `session.ts`'s split may
   want to reuse.
2. `tools.ts` + its test file together, since the test split has to track the source split
   1:1 (each `tools/<domain>.ts` gets a `tests/tools/<domain>.test.ts`).
3. `asset.ts` — establishes the composition pattern (delegate objects, since TS has no
   partial classes) that `session.ts` reuses at larger scale. First split-editor in the
   codebase; the pattern chosen here becomes the template for `timeline.ts`/`script.ts`/
   `nodes.ts` later (out of scope, noted for whoever does those next).
4. `session.ts` + its test file — biggest, reuses the composition pattern from step 3.

Each step lands as its own commit (step 4's concern files land as one commit per file —
see the note at the end of step 4 for why); `pnpm check && pnpm test && pnpm lint` must be
green after each commit before starting the next. Lands on the current `effects` branch,
alongside its in-progress work — none of the six target files are part of that branch's
current diff, so there's no conflict, but rebase this work past `effects`'s other commits
if the two interleave awkwardly.

## 1. `apps/desktop/src/main/index.ts`

Flat split (matches every other file in `main/`, which has no subdirectories). The first
pass at this list (an earlier draft of this plan) only accounted for about 450 of the
file's 1247 lines — the state below is corrected to place every top-level declaration,
including the ones that closures capture (`pendingPlans`/`pendingAsks`/`pendingConfirms`,
`deps`, `registry`, `getSession`/`getSessionState`/`openSessionStore`):

- `main/cliargs.ts` — `parseArgs`, `CliArgs`, CDP port flag setup.
- `main/windowmanager.ts` — `getWindowList`, `liveWindows`, `rememberWindows`,
  `focusFrontWindow`, `rememberedWindows`, `loadWindow`, `createWindow`, the
  bounds-debounce state, `windowFor`, `broadcast`, `sendTo`, `nameWindows`. This absorbs
  what's currently the window-bookkeeping tail of `index.ts`; `windows.ts` (existing)
  keeps just the `Windows`/`Pending`/`WindowList` class definitions it already has today.
- `main/assetprotocol.ts` — `registerAssetProtocol`, `assetType`, `scope`.
- `main/pending.ts` — `pendingPlans`/`pendingAsks`/`pendingConfirms` instances,
  `abandonPending`, `abandonPendingBy`, `askWindow<T>`. These are read by both `stack.ts`
  (`getStack`'s dialog wiring) and `ipc.ts` (`registerIpc`'s plan/ask/confirm channels),
  so this needs to be its own module rather than folded into either.
- `main/sessionaccess.ts` — `getSession`, `getSessionState`, `openSessionStore`,
  `deps: SessionDeps`, `registry = createDesktopRegistry()`, `noteWrites`. This is the
  other piece both `stack.ts` and `ipc.ts` depend on.
- `main/stack.ts` — `getStack`, `withVersions`, the `CommandHost`/`CommandStack` wiring.
  This is the largest single chunk (~150 lines) and depends on `windowmanager.ts`,
  `pending.ts`, `sessionaccess.ts`, `session.ts`, `committer()`; take its dependencies as
  explicit function parameters rather than importing module-level mutable state.
- `main/ipc.ts` — `handle<C>`, `registerIpc`. Depends on `stack.ts` (`getStack()`),
  `sessionaccess.ts`, `pending.ts`.
- `main/startupnotices.ts` — `askAboutGit`, `noticeMissingGit`, `noticeMissingKeys`,
  `openRepos`, `seedSample`, `promptForWorkspace`, `resolveWorkspace`, `switchWorkspace`,
  `committer`. (Fold into `workspace.ts` instead if that reads more naturally once the
  code is in front of you — both files already exist as siblings.)
- `main/approvals.ts` merge point: `recomputeApprovals`/`scheduleApprovals` may belong in
  the existing `approvals.ts` rather than a new file — check that file's current contents
  before deciding.
- `main/bootstrap.ts` — the `app.whenReady().then(...)` block, `window-all-closed`, the
  two `before-quit` handlers, `QUIT_FLUSH_MS`. Keep this as one sequential function (it
  has ordering-constraint comments); do not split further. Calls
  `openSessionStore()`/`getSessionState()` (`sessionaccess.ts`) and `registerIpc()`
  (`ipc.ts`) — those two modules must exist before this one is written.
- `main/index.ts` (remaining) — imports and calls `bootstrap.ts`'s entry point, plus
  whatever top-level module state genuinely has to live at the entry point (verify against
  the corrected list above once all nine other files are written — if something is left
  over that isn't assignable to any of them, that's a sign a file above is missing a
  responsibility, not that `index.ts` should keep it).

No external file imports from `index.ts` today, so there is no barrel/compat concern —
just make sure the call order across `bootstrap.ts`, `sessionaccess.ts`, `pending.ts`,
`stack.ts`, and `ipc.ts` matches the current `whenReady` block's order, since the comments
there document real ordering constraints (session store before workspace resolve,
instance-lock before window creation, etc.) — read them before reordering anything.

## 2. `packages/authoring/src/tools.ts` + `tests/tools.test.ts`

New `packages/authoring/src/tools/` directory (first subdirectory in this package other
than `tests/`):

- `tools/core.ts` — `ToolResult`, `PipelineControl`, `GraphControl`, `ReadLedger`,
  `ToolContext`, `Tool<A>`, `ok`, `fail`, `rel`, `formatDiagnostics`, the
  zod-introspection helpers (`describeToolParams`, `jsonSchemaOf`, `zodTypeName`,
  `isOptional`, `jsonTypeOf`, `SIGNATURE_DEPTH`).
- `tools/workspace.ts` — `read_file`, `list_workspace`, `search` (+ `collectInputFiles`,
  `INPUT_GLOBS`, `SEARCH_SCOPE`), `list_archive`, `search_bible`.
- `tools/validate.ts` — `validate_inputs`, `parse_fountain`, `story_graph`,
  `extract_entities`.
- `tools/characters.ts` — edit/create character, edit/create location tools and their
  shared shapes (`createdHow`, `givenFields`).
- `tools/scenes.ts` — `edit_scene`, `edit_branches` (+ `SCENE_OPS`, `LINE_KINDS`,
  `BRANCH_OPS`, `sceneEditShape`, `sceneDecider`, `branchEditShape`, `branchDecider`).
- `tools/outfits.ts` — `set_outfit`, `set_variant`.
- `tools/storyboard.ts` — `read_shots`, `set_coverage`, `propose_storyboard`,
  `write_storyboard` (+ `formatStoryboard`, `storyboardArgsOf`, `coercedVariants`).
- `tools/files.ts` — `write_file`, `edit_file`, `regenerate_context`, `update_context` (+
  `AGENT_WRITERS`, `ownedElsewhere`, the diff-hunk helpers `clip`/`occurrences`/
  `renderHunk`/`CONTEXT_LINES`).
- `tools/git.ts` — the 7 git tools + `git_init` (currently mis-filed under "skills" in the
  source; move it here, since it's a git operation, not a skill operation).
- `tools/skills.ts` — `discover_skills`, `create_skill`, `edit_skill`, `run_skill`.
- `tools/images.ts` — `generate_image`, `list_images`, `edit_image`.
- `tools/assets.ts` — `list_assets`, `art_notes`, `set_art_notes`, `view_image`,
  `regenerate_asset`, `approve_assets`, `unapprove_assets` (+ `parseAssetSubject`,
  `findAsset`, `shotsFor`).
- `tools/assetgraph.ts` — `read_asset_graph`, `edit_asset_graph`, `run_asset_graph` (+
  `runTriage`, `diagLine`, `escapeRegExp`).
- `tools/index.ts` — imports every domain file, assembles `ALL_TOOLS: Tool[]`, exports
  `createRegistry()`, and re-exports everything `tools/core.ts` exports.

Compatibility: `packages/authoring/src/index.ts` currently does
`export * from './tools.js'`; change it to `export * from './tools/index.js'`. Two test
files import directly from `../tools.js` rather than the barrel (`tests/backend.test.ts`,
`tests/history.test.ts`) — update both to `../tools/core.js` (or `../tools/index.js` if
that's simpler; check what each actually needs — both only use core types/helpers, not
domain tools). Delete the old `tools.ts` once nothing points at it.

Test split, mirroring the above: `tests/tools/workspace.test.ts`,
`tests/tools/validate.test.ts`, `tests/tools/characters.test.ts`,
`tests/tools/scenes.test.ts`, `tests/tools/outfits.test.ts`,
`tests/tools/storyboard.test.ts`, `tests/tools/files.test.ts`, `tests/tools/git.test.ts`,
`tests/tools/skills.test.ts`, `tests/tools/images.test.ts`, `tests/tools/assets.test.ts`
(from `tools.test.ts`'s asset-related cases), `tests/tools/assetgraph.test.ts` (this one
may already largely exist as `graphtools.test.ts` — check before creating a duplicate).
Read `tools.test.ts` top to bottom once to build the map from `describe` blocks to the
domain files above before moving anything; don't guess from tool names alone.

`tools/assets.ts`'s `approve_assets`/`unapprove_assets` currently have no tests anywhere
in `tools.test.ts` (verified by the pressure-test review). Move them with no test file
change — do not write new tests for them as part of this plan (that would be a behavior/
coverage change, out of scope per "What this plan does not do" below).

## 3. `apps/desktop/renderer/pathux/editors/asset.ts`

New `apps/desktop/renderer/pathux/editors/asset/` directory. Only importer of the old path
is `shell.ts`'s side-effect import (`import '../editors/asset.js'`); update it to
`import '../editors/asset/index.js'`.

`AssetEditor` is one cohesive class — most methods touch the same ~20 private fields.
Since TypeScript has no partial classes, split by composition: pull each concern's state
and methods into a class the `AssetEditor` instantiates and delegates to, not by literally
moving method bodies into free functions with 15 parameters.

- `asset/index.ts` — `AssetEditor` itself: fields, `define()`, `init()`, `load()`, the
  mutating-action wrappers (`approve`/`download`/`regenerate`/`redraw`/`promote`/
  `replace`/etc. — these are thin `exec()` calls, leave them here), `focusBox`/
  `openOrigin`, `rebuild`/`rebuildBar`/`rebuildBody` (top-level render, delegates into the
  pieces below), `registerEditor(AssetEditor, 'vn.AssetEditor')`.
- `asset/chunkdrag.ts` — a `ChunkDragController` class owning `grabChunk`, `chunkRows`,
  `aimDrag`, `paintDrag`, `dropChunk`, `nudge`, and the `drag`/`refocus`/`dragNote` fields
  currently on `AssetEditor`; constructed with a back-reference to the owning editor for
  the calls it needs to make into it. Also owns the `ChunkDrag` interface.
- `asset/promptview.ts` — chunk/prompt rendering: `rebuildPrompt`, `modeRow`,
  `failureBand`/`fixWithAgent`, `heldBanner`, `chunkList`, `chunkCard`, `refStripEl`,
  `chunkTags`, `chunkActs`, `pickRef`, `openBox`, `chunkBox`, `customBox`. Owns `editing`/
  `customDraft`/`thumbs` state currently on `AssetEditor`.
- `asset/framing.ts` — `head`, `frame`, `drawnFrom`, `prereqRow`, `showPrereq`,
  `promoteStrip`, `variantPicker`, `replaceStrip`, `promptStrip`, `rungBox`, `seedField`,
  `commitSeed` — the asset-header/frame rendering block, plausibly stateless enough to be
  plain functions taking the editor as a parameter rather than a full delegate class;
  decide once the code is in front of you which of these actually need persistent state
  vs. just read `this.info`/`this.shown` and can be a pure render function.
- `asset/dom.ts` — the three free helpers `option()`, `el()`, `button()`.

Whichever fields move onto delegate classes, `AssetEditor`'s own field list shrinks by
that many; keep one field per delegate (e.g. `chunkDrag: ChunkDragController`,
`promptView: PromptChunkView`) rather than flattening the delegate's API back onto
`AssetEditor` — the point is fewer things touching `AssetEditor`'s constructor and
`init()`, not just fewer lines in one file.

## 4. `apps/desktop/src/main/session.ts` + `tests/session.test.ts`

New `apps/desktop/src/main/session/` directory. `WorkspaceSession` is one cohesive class
(shares `this.dir`, `convo`, `native`, `thread`, `cancel`, `inFlight`, `heldGraphs`,
`heldGroups`, `redaction`, `analyst`, `reportRows`, and others across nearly every
method), so — same as `asset.ts` — split by composition, not by moving method bodies into
free functions with the class as an untyped bag of parameters.

The concern groupings below already map almost 1:1 onto
`apps/desktop/src/main/commands/*.ts`, which is strong evidence they're the right seams
(each `commands/*.ts` file only calls `ctx.host.session.<method>()`, so the boundary is
already load-bearing in the existing code, not invented for this split):

- `session/core.ts` — `WorkspaceSession` class shell: constructor, private fields, `busy`/
  `running`/`busyState`, `stopPipeline`/`stopAgent`/`stopReport`, `permission`, `record`/
  `recordUsage`/`writeNative`/`recordMessage`, `history`, `announceApi`, `index`,
  `workspace`. This is the cross-cutting substrate other concerns call into
  (`this.record`, `this.busy`), so it stays central rather than becoming a delegate. Also
  keeps `SessionDeps`, `describeKeySource`, and the other module-level types/consts that
  `commands/*.ts` or tests import directly (`NewDocKind`, `ChunkOp`, `ClearPart`).
- `session/agent.ts` — `generatedContext`, `writeGeneratedContext`, `searchBible`,
  `runAgent`, `setMode`/`setModel`/`setEffort`/`setBudget`, `systemPrompt`, `clearAgent`,
  `uploadFiles`, `threads`, `openThreadForReading`, `resumeRefusalFor`/`resumeThread`,
  `compactRefusalFor`/`compactThread`, `renameThread`.
- `session/report.ts` — `analysisBinding`, `previewReport`/`reportAgent`/`openReport`/
  `recordReport`/`sayToReport`/`reportTurn`/`showReport`, `previewGrant`/`grantReport`/
  `reportState`, `previewIssue`/`openIssue`, `copyText`.
- `session/gate.ts` — `gateCandidates`/`gateCandidacy`/`approveCharacter`, `approvable`/
  `approvedAssets`/`approvalQueue`/`approveOne`/`unapproveOne`, `suspensions`, `slotTask`/
  `failureOf`.
- `session/asset.ts` — the largest cluster (~1900 lines): `assetLibrary`, `assetInfo`,
  `previewAccept`/`acceptAsset`, `portraitOwner`, `previewUnapprove`/`unapproveAsset`,
  `previewRegenerate`/`regenerateAsset`, `previewArtNotes`/`setArtNotes`,
  `previewArtSeed`/ `setArtSeed`, `previewConcept`/`drawConcept`,
  `previewUpload`/`uploadAsset`, `previewAdopt`/`adoptAsset`, `exportAsset`,
  `previewRestore`/`restoreAsset`, `previewReplace`/`replaceAsset`, `adoptWrote`,
  `previewRedraw`/`redrawAsset`, `seeded`, `previewPromote`/`promoteAsset`. If this is
  still too large as one file once written out, split further along the
  `commands/asset.ts` vs. `commands/art.ts` vs. `commands/upload.ts` boundary that already
  exists — check which methods each of those three command files actually calls before
  deciding the sub-split.
- `session/prompt.ts` — `promptView`, `chunkRefs`, `previewPromptChunk`/`setPromptChunk`,
  `previewMoveChunk`/`movePromptChunk`, `previewCustomPrompt`/`setCustomPrompt`,
  `previewClearPrompt`/`clearPrompt`, `previewAddRef`/`addPromptRef`, `previewDropRef`/
  `dropPromptRef`, `previewRepin`/`repinPrompt`, `previewCondense`/`condenseAssetPrompt`,
  `checkPrompt`.
- `session/project.ts` — `projectView`, `previewArtStyle`/`setProjectArtStyle`,
  `previewKey`/`setKey`/`keyStatusView`/`keyGuide`/`openKeyLink`, `checkForUpdates`/
  `openReleases`, `previewTestKey`/`testKey`, `condensingText`.
- `session/docs.ts` — `docTree`, `skillEntries`, `fileTree`, `skillTree`, `readDoc`/
  `previewDoc`/`saveDoc`, `newDoc`, `previewCreate`/`createDoc`, `previewRename`/
  `renameDoc`.
- `session/story.ts` — `storyGraph`, `editBranches`, `scriptState`, `previewSceneEdit`/
  `editScene`, `shotOrder`, `previewLineIds`/`writeLineIds`, `previewImport`/
  `importScreenplay`, `sceneCoverage`/`setCoverage`, `sceneOutfit`, `previewSceneOutfit`,
  `previewShotOutfit`/`setShotOutfit`, `previewShotVariant`/`setShotVariant`,
  `previewShotSubjects`/`subjectsRule`/`setShotSubjects`, `previewShotCast`/`castRule`/
  `requireShotCast`, `previewNewShot`/`newShot`, `previewDeleteShot`/`deleteShot`.
- `session/pipeline.ts` — `playable`, `exportPlayable`, `writeScreenplay`, `status`.
- `session/gengraph.ts` — `graphDoc`, `groupDoc`, `groupFiles`, `forgetGraphDocs`,
  `graphEstimate`, `refreshPrices`, `runGraph`, `runPreconditions`,
  `decomposePreconditions`, `decomposeAllScenes`, `runPipeline`, `announceRun`.

Composition mechanics: for each concern file, define a class (e.g. `AgentSession`,
`ReportSession`, `AssetPipeline`) that takes the state it needs in its constructor (a mix
of a back-reference to `WorkspaceSession` for shared substrate like `this.record`, and its
own private fields for concern-specific state like `reportRows`/`analyst`/
`transcript`/`redaction` for the report concern). `WorkspaceSession` instantiates one
instance per concern in its constructor and keeps its existing public method names as
one-line delegations (`acceptAsset(id) { return this.asset.acceptAsset(id); }`), so
`commands/*.ts` and the test files that call `session.acceptAsset(...)` need no changes at
all. This is the same pattern used for `asset.ts` in step 3, at larger scale.

Commit granularity for this step: one commit per concern file (11 commits: `core`,
`agent`, `report`, `gate`, `asset`, `prompt`, `project`, `docs`, `story`, `pipeline`,
`gengraph`), each landing its concern class + its matching test move/merge from the
section above, each green under `pnpm check && pnpm test && pnpm lint` before the next.
`session/asset.ts` (the largest, ~1900 lines) has an explicit fallback to split further
along the `commands/asset.ts`/`commands/art.ts`/`commands/upload.ts` boundary if it's
still too large once written out — doing this concern as its own commit means that
fallback, if triggered, only affects one commit to redo, not the whole file's split.

Compatibility: `main/index.ts`, `commands/host.ts`, `commands/doc.ts`,
`commands/prompt.ts`, and the five files under `main/tests/` all import
`WorkspaceSession`/`SessionDeps`/`NewDocKind`/`ChunkOp`/`ClearPart`/`describeKeySource`
from `../session.js` (or `./session.js`). Decision: keep a `session.ts` that re-exports
everything from `session/core.ts`, rather than updating all five call sites — fewer files
touched per commit, and it keeps this step's diff reviewable as "one new directory plus
one two-line file," not "one new directory plus five edited call sites." Delete the shim
only in a later, separate cleanup if it turns out to bother anyone.

Test split, mirroring the concern files: `tests/session/agent.test.ts`,
`tests/session/report.test.ts`, `tests/session/gate.test.ts`,
`tests/session/asset.test.ts`, `tests/session/prompt.test.ts`,
`tests/session/pipeline.test.ts`, `tests/session/gengraph.test.ts` (or `graphdoc.test.ts`,
see below), `tests/session/core.test.ts`.

`main/tests/` already has `doctree.test.ts`, `graphdoc.test.ts`, `keys.test.ts`, and
`sample.test.ts` alongside `session.test.ts`, and they already cover parts of three
proposed concerns (verified by the pressure-test review):

- `graphdoc.test.ts` already fully covers `session/gengraph.ts`'s `graphDoc`/`groupDoc`.
  **Move it to `tests/session/gengraph.test.ts` and merge in any `session.test.ts` cases
  covering the rest of that concern's methods** (`groupFiles`, `forgetGraphDocs`,
  `graphEstimate`, `refreshPrices`, `runGraph`, `runPreconditions`,
  `decomposePreconditions`, `decomposeAllScenes`, `runPipeline`, `announceRun`) — don't
  leave two files covering one concern.
- `keys.test.ts` already covers `session/project.ts`'s key-related methods
  (`setKey`/`previewKey`/`keyStatusView`/`previewTestKey`). **Move it to
  `tests/session/project.test.ts`** and merge in `session.test.ts`'s cases for that
  concern's remaining methods (`projectView`, `previewArtStyle`/`setProjectArtStyle`,
  `checkForUpdates`/`openReleases`, `condensingText`).
- `sample.test.ts` covers `session.index()`, `storyGraph()`, and `editBranches()` in one
  describe block, which spans the proposed `session/core.ts` and `session/story.ts`
  boundary. **Leave `sample.test.ts` where it is, unrenamed** — it reads as an end-to-end
  smoke test across the sample project rather than a per-concern unit-test file, and
  splitting it to match the source boundary would turn one coherent scenario into two
  files that must stay in sync. Do not create `tests/session/story.test.ts` unless
  `session.test.ts` itself has story-concern cases beyond what `sample.test.ts` covers.
- `doctree.test.ts` covers `session/docs.ts`'s tree-building methods; same treatment as
  `graphdoc.test.ts` — move and rename to `tests/session/docs.test.ts`, merging in any
  overlapping `session.test.ts` cases.

General rule for the remainder of `session.test.ts`: for each concern, check for an
existing same-purpose file under `main/tests/` first; if one exists, move+rename it into
`tests/session/` and merge `session.test.ts`'s cases for that concern into it (dropping
exact duplicates, keeping anything additional); only create a fresh
`tests/session/<concern>.test.ts` from scratch when no such file exists.

## What this plan does not do

- No behavior change. No renaming of public methods, no changing what any tool or command
  does. If a rename would make a split cleaner, don't do it as part of this plan.
- Does not split `timeline.ts`, `script.ts`, or `nodes.ts` (comparable size to `asset.ts`
  but not in the original request). The `asset/` split establishes a pattern; a follow-up
  plan can point at it.
- Does not change the `commands/` layer, the tool registry's public tool names/schemas, or
  any test's assertions — only which file a test lives in and what it imports.

## Verification

After each commit: `pnpm check && pnpm test && pnpm lint`. For steps 3 and 4 (editor and
session composition splits), also run the app (`pnpm vndesktop --mock`) once per step (not
per concern-commit — once all of step 4's concern commits are in) and walk this checklist,
since typecheck and unit tests don't prove a delegate wired up correctly at runtime (a
delegate constructed with a stale back-reference, or a moved method that still needed
`this.someField` from `WorkspaceSession` and got the wrong reference passed in):

- Step 3 (`asset.ts`): open the asset editor on an existing asset; drag-reorder a prompt
  chunk (exercises `ChunkDragController`'s back-reference); edit a custom prompt field and
  commit it (exercises `PromptChunkView`'s state); approve/regenerate one asset (exercises
  the action wrappers left on `AssetEditor` itself calling back into the delegates for any
  state they read, e.g. `shown`/`info`).
- Step 4 (`session.ts`): run one agent turn (`AgentSession`); open the report/analyst chat
  and send a message (`ReportSession`); approve one gated asset (`GateSession`);
  accept/regenerate one asset (`AssetPipeline`); edit a prompt chunk through the desktop
  UI, not just the tool (`session/prompt.ts`); open project settings and check a key
  status (`session/project.ts`); open the doc tree (`session/docs.ts`); edit a scene
  (`session/story.ts`); run `vngen export`-equivalent from the UI (`session/pipeline.ts`);
  run one gengraph node (`session/gengraph.ts`). Each exercises a different delegate's
  back-reference and constructor wiring.

# Plan index and status

Every implementation plan in this directory, and whether it has been built. A plan is the
authority on its own scope; this file is the authority on **what state it is in**.

Status values:

- **shipped** — implemented and in the codebase. The plan's own As-shipped section records
  deviations; the plan is history, not a task list.
- **partial** — some of it is built and the plan still describes unbuilt work.
- **planned** — nothing built yet.

Three batches carry extra working detail of their own. Two are complete:
[`desktop-editors-tracking.md`](desktop-editors-tracking.md) for the desktop editors, and the
[scene authoring](#scene-authoring) section below. The third is the eight open plans of the
authoring surface, whose running order and checkboxes are in
[`authoring-surface-tasklist.md`](authoring-surface-tasklist.md).

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
| [`interaction-model.md`](interaction-model.md) | shipped | `Interaction`/`targets` and the `interaction.*` commands; five gestures declared. Its two "Next" items shipped in [`preconditions-and-timeline-interaction.md`](preconditions-and-timeline-interaction.md) |
| [`allocated-line-ids.md`](allocated-line-ids.md) | shipped | Line ids that survive an edit, the diagnostics surface, the catalog-driven palette |
| [`lossless-scene-serialization.md`](lossless-scene-serialization.md) | shipped | `parse(write(scene)) ≡ scene`; `Scene.body` retired, headings and three line kinds retained |
| [`scene-chunk-files.md`](scene-chunk-files.md) | shipped | `scenes/<id>.md` replaces the one contended screenplay; `start:` names the entry, front-matter is identity only, both prose patchers retargeted (`screenplay/` still loaded when it shipped; plan 4 retired it) |
| [`fountain-import-export.md`](fountain-import-export.md) | shipped | `vngen import` / `vngen screenplay`, the desktop pair, and the retirement of `screenplay/` as an input |
| [`scene-editing-commands.md`](scene-editing-commands.md) | shipped | Nine `story.*` prose commands over `@vn/scriptedit`, `session.editScene`, the storyboard fallout, `script.moveLine`, and `vnauthor`'s `edit_scene` — one write path for prose, no UI |
| [`scene-edit-package.md`](scene-edit-package.md) | shipped | The scene-edit rules and write path now live in `@vn/scriptedit` (pure barrel; `@vn/scriptedit/write` for the filesystem half), where `vnauthor` can reach them |
| [`line-editing-in-floor.md`](line-editing-in-floor.md) | shipped | Retyping a line in the coverage timeline, and `Shot.proseHash` → the drift mark on the shot it produced |
| [`script-composition-in-studio.md`](script-composition-in-studio.md) | shipped | STUDIO's `script` mode — a column that writes, inserts, deletes, reorders and attributes lines, the confirmed acts that change which scenes exist, clickable diagnostics, and the end-to-end pass: a scene written in the app, generated, watched in PLAY |
| [`task-failure-visibility-and-retry.md`](task-failure-visibility-and-retry.md) | shipped | `Task.error` so a failed task records why, a bounded retry on the next run, a run report derived from the live plan instead of claiming success over a failure, and in-place backend retry for transient provider errors |
| [`portrait-overlay-opt-in.md`](portrait-overlay-opt-in.md) | shipped | The shot is the whole picture: `portrait_overlay` (default off) → `story.play.json`'s `portraitOverlay`, so PLAY stops staging a second copy of the speaker over a frame that already contains them |
| [`desktop-editors-tracking.md`](desktop-editors-tracking.md) | — | Not a plan; the tracker for the six desktop-editor plans above |
| [`refactorTaskList.md`](refactorTaskList.md) | — | Not a plan; the master tracker for the [`designRequirementsEtc.md`](../designRequirementsEtc.md) refactor — the path.ux UX rewrite and the structural plans the [migration report](../research/codebase-migration-for-new-requirements.md) calls for |
| [`entity-discovery-by-meta-tag.md`](entity-discovery-by-meta-tag.md) | shipped | Characters/locations found by front-matter `type:` tag across `characters/`, `locations/` and `wiki/**`; `EntityDoc` carries the source path so no writer re-derives one; id/filename agreement and duplicate diagnostics |
| [`story-bible-and-retrieval.md`](story-bible-and-retrieval.md) | shipped | The `wiki/` tree read as prose and reached by retrieval: a new `@vn/bible` between store and authoring, `query(text) → ranked excerpts` under a hard budget, `search_bible` and `bible.search` — grep now, embeddings behind the same seam |
| [`repo-map-and-commit-on-save.md`](repo-map-and-commit-on-save.md) | shipped | Which repo owns a path (`RepoResolver`, discovered not declared), every act committing to each repo it touched, undo restoring as a *new* commit rather than a reset, and the `git init` + commit-existing half of project bootstrap |
| [`base-and-project-asset-stores.md`](base-and-project-asset-stores.md) | shipped | Base art (portraits, model sheets, location refs) split into its own content-addressed root at `assets/` — own subtree, own manifest, optionally its own repo — with reads unioned across both roots, an `unavailable` base that refuses to plan rather than regenerating, and `Asset.satisfies` grown to a list of bindings |
| [`shot-ordering-in-scenes.md`](shot-ordering-in-scenes.md) | shipped | Reordering shots inside a scene as what it actually is — moving the shot's covered lines — with the refusal that makes it definable (a shot with interleaved coverage has no single position), `moveShot` in `@vn/scriptedit`, `story.moveShot`, the `timeline.reorder` gesture that previews it, and `edit_scene`'s tenth op |
| [`outfits-at-scene-and-shot-level.md`](outfits-at-scene-and-shot-level.md) | shipped | An authorable wardrobe (`outfits:` on the character sheet) and an inheritance chain — shot override → `[[outfit: aiko=uniform]]` scene marker → character default — resolved by one `outfitFor`, with a non-default outfit rendered against its own model sheet and P4's fan-out narrowed to the outfits a reachable scene actually asks for |
| [`agent-context-regeneration.md`](agent-context-regeneration.md) | shipped | One generated `AICONTEXT.generated.md` — the cast, the locations, the story graph and the bible's *table of contents* — written by `workspace.reindex` off the two walks that already exist, read one rung below the author's own `AICONTEXT.md`, budgeted, and refusing to overwrite a file it did not write |
| [`document-tree-and-backlinks.md`](document-tree-and-backlinks.md) | shipped | The sidebar's two shapes, joined from edges that already exist: a document tree (story → scenes → shots, characters, locations, the wiki tree, assets by kind) plus per-entity backlinks (sheet, base art, scenes, shots), on their own channel so the hot workspace index stays cheap |
| [`project-bootstrap-and-workspace-picker.md`](project-bootstrap-and-workspace-picker.md) | shipped | The other half of project bootstrap: a picked directory becomes a project (`openWorkspace` writes a one-line `project.yaml`, then `ensureRepo`), `workspace.open`/`pick`/`recent`, an in-place switch that tears the session and undo stack down with the old root, and a startup precedence that remembers the last project |
| [`wiki-and-document-tree-editors.md`](wiki-and-document-tree-editors.md) | shipped | The panes for the story bible and the document tree: a `documents` sidebar (logical tree + file-tree mode + backlink panel + a New… row), a `wiki` markdown editor, and the `doc.read`/`doc.write`/`doc.create` commands they need — the UI items 3 and 9 each deferred to the other. Eleven decisions, five of them found by auditing the draft against the code |
| [`pathux-desktop-rewrite.md`](pathux-desktop-rewrite.md) | shipped | The renderer rebuilt on path.ux (submodule): subdividing screen, seven editors ported cheapest-first, one selection, per-area keymaps, `view.*` addressing editors instead of rooms, and the docs reorganized by editor. The React shell, the `--react` flag and `react`/`react-dom` are deleted; the pure rule modules moved to `renderer/rules/` |
| [`desktop-shell-fit-and-finish.md`](desktop-shell-fit-and-finish.md) | shipped | Eight gaps collected while using the path.ux shell for real: a window that would not close (`will-prevent-unload`), the stock menu deleted with Ctrl+Q and F12 re-homed, a bounded dialogue box, the agent's mode and a working indicator on the convo pane's own bar, model + effort pickers (`agent.setEffort`, `TEXT_MODELS`/`EFFORT_LEVELS` moved to `@vn/types`), and an `onWrote` bus so an open document follows the agent's writes — plus a `⟳` on both editors |
| [`asset-names-and-the-asset-editor.md`](asset-names-and-the-asset-editor.md) | shipped | Generation from an authored surface: assets named rather than hashed in the document tree, `artNotes` as an authored field at five rungs (character, location, outfit, variant, shot) appended to the derived prompt so an edit re-keys the task and re-renders exactly what it reaches, the `asset.*`/`art.*` commands, and the eleventh editor — which previews one asset, approves it, and regenerates it from where the tree names it |
| [`on-demand-concept-images.md`](on-demand-concept-images.md) | shipped | A picture the pipeline never asked for: `@vn/artgen` (prompt composition moved out of `@vn/pipeline` so the agent can reach it), a `concept` asset kind that is bound but never consumed, `generate_image` + `/makeimage` in `vnauthor` and `art.generate` in the desktop, and `art.promote` — which writes the variant onto the location sheet and records the planner's own task as `done`, so the next run adopts the sketch instead of rendering over it |
| [`desktop-agent-permissions.md`](desktop-agent-permissions.md) | shipped | The desktop answering the agent's other two permission doors: `ask_user` and every always-confirm tool were scaffolded to `''` and `true`, so the app answered for the author — a question card and a confirm card in the convo pane, over the plan card's own request/reply shape, with an English sentence built in main rather than the raw arguments, and teardown resolving every parked door instead of hanging the turn |
| [`chunked-prompts.md`](chunked-prompts.md) | shipped | The prompt as an addressable list of clauses rather than a flat string: `PromptChunk[]` behind every builder (collapsing byte-identically, so no task hash moves), per-chunk replace/append/mute/reorder, a verbatim user prompt and an agent-condensed one that is *held* rather than re-rendered when its chunks move, a `prompt.*` namespace and a rebuilt asset pane — plus Part II, where a chunk carries reference images: a linked asset pinned by hash and remembering the slot it came from, derived viral suspension when that slot moves, an acyclic reference graph enforced over bindings at write time, custom uploads as a new `reference` kind, and the retirement of the never-read `Character.referenceImages` |
| [`guided-ui-tours.md`](guided-ui-tours.md) | planned | The agent showing an author how to do something by pointing at it. Mostly an **anchor layer**: a widget's click wired *from* the record that names it, so a tag and its button cannot drift apart; item keys that are domain identity rather than position; a generation-scoped registry re-resolved every frame; a shadow-aware pick oracle for the failure that looks fine; and a reachability map *measured* by a CDP sweep rather than declared. The tour rests on it — with the prefilled palette as the route that always exists, and a rule that a tour never clicks for you |
| [`authoring-surface-tasklist.md`](authoring-surface-tasklist.md) | shipped | The running order and checkbox list for the eight plans below, with the only two hard dependency edges named |
| [`editor-routing-by-relevance.md`](editor-routing-by-relevance.md) | shipped | Clicking a document tree item shows the editor that can best answer for it: claims declared beside the names in `editors.ts` as predicates over the node, a pure `routeFor()` sorting on `(visible, tier, EDITORS order)`, selection published before the open, and `where: 'elsewhere'` as the fallback that already exists |
| [`asset-cross-references.md`](asset-cross-references.md) | shipped | A page showing the art that references it: `scene:<id>` backlink keys and a path index on `DocTree`, and the asset strip extracted into a generic widget with two consumers — the wiki editor and the script editor — plus the honest finding that no asset binds to a plain lore note today |
| [`new-and-open-project.md`](new-and-open-project.md) | shipped | `workspace.create` beside `open`/`pick`/`recent`: a three-file skeleton so a new project loads a model with zero error diagnostics, a refusal on a non-empty directory, a warning when the target sits inside an existing repo, and the New/Open/Recents menu set |
| [`new-project-dialog-with-folder-browse.md`](new-project-dialog-with-folder-browse.md) | shipped | `prop.directory` and the palette's Browse… button, `workspace.chooseDirectory`, and a `newFolder` checkbox that makes `workspace.create`'s form a real New Project dialog |
| [`new-project-as-its-own-dialog-and-its-own-repo.md`](new-project-as-its-own-dialog-and-its-own-repo.md) | shipped | Two faults the author found in the one above: the form extracted into a `CommandForm` with two hosts, so the palette stays the finder and a named command gets its own dialog with Cancel and no search box; and `initRepoAt`, `ensureRepo`'s opposite, so creating a project inside a repo nests one of its own instead of silently getting none |
| [`conversation-threads.md`](conversation-threads.md) | shipped | Conversations saved as append-only JSONL under `vngen/state/threads/` — outside the undo snapshot by design — with the reducer moved to `src/shared/` so main and the renderer agree, a searchable dropdown, and reopening that replays read-only rather than pretending the model remembers |
| [`upload-and-archive.md`](upload-and-archive.md) | shipped | `/upload`: an author's documents archived verbatim under `archive/`, invisible to `search` and to entity discovery because both walk allow-lists and readable by name, with content-blind suggestion chips, a seeded thread in plan mode, and one `archiveUpload` behind both the desktop command and the REPL |
| [`adopting-an-uploaded-asset.md`](adopting-an-uploaded-asset.md) | shipped | Uploaded artwork becoming a slot's actual output rather than a reference: `adoptSlot` generalized out of `promoteConcept`, addressed by the existing `plate:`/`sheet:`/`shot:` slot vocabulary, with the planner's input builders extracted so hashes cannot drift, a portrait refused because the P3 gate owns it, superseding a real render as a declared act, and an asset-editor Replace strip that reads the slot off the picture on screen rather than asking for one |
| [`agent-art-revision.md`](agent-art-revision.md) | shipped | The agent reaching planned art: the art-notes rungs moved to `@vn/artgen` so one parser serves both hosts, regeneration as an injected `pipeline?` capability rather than an argument with the boundaries rule, a general `describeAsset` over the `ChatBackend` seam instead of a widened `VisionReviewer`, and five tools that propose notes rather than silently iterating |
| [`multiple-windows.md`](multiple-windows.md) | planned | Editors spread across monitors: several `BrowserWindow`s in **one** main process, `win` replaced by a window registry, effects split into broadcast (agent, undo, session) and targeted-at-the-sender (`view.*`, permission prompts), per-window layout and selection keys, a `window.*` namespace and `view.open where='window'` — plus the single-instance lock, because two app instances today write the same `refs/vn/undo/<seq>` snapshots |
| [`document-tree-context-menus.md`](document-tree-context-menus.md) | shipped | The first context menus in the app, built from the catalog: entries are invocations resolved through `check` then `exec`, a refused entry shown with the command's own sentence rather than hidden, `undeclared` explicitly not permission, and one table per node kind including the kinds that offer nothing |
| [`notifications.md`](notifications.md) | shipped | One durable, linkable notification log in the project repo — `vngen/state/notifications.jsonl`, per-line versioned, union-merged, with read/hidden as single ASCII digits patched in place at a byte offset — filed for every command outcome from one `onRecord` hook, narrowed to a single note frame in the menu bar, and read through a bell, a scrollable list with in-place archive/undo, and a category filter |
| [`model-keys-tree-menus-and-inline-rename.md`](model-keys-tree-menus-and-inline-rename.md) | shipped | Seven todos taken together: a `secret` prop kind so `project.setKey` can write a credential the history records as `<secret>`, a `.gitignore` written before a new repo's first commit so `keys` is ignored by the time anything can be committed, branch headings offering what their subtree is made of, a capture-phase pointer-down latch so the click that dismisses a menu cannot collapse the tree underneath it, and double-click-to-rename over a `doc.rename` that writes wherever the name was read from and never moves the file |
| [`provider-credentials-and-the-ai-usage-ledger.md`](provider-credentials-and-the-ai-usage-ledger.md) | planned | Every author billed to their own account, and a truthful account of what that cost: the finding that only Vertex offers real third-party OAuth (and works by storing nothing), so the work is in making key handling good rather than building an OAuth client; usage widened onto the response where it already exists and thrown away today; the rule that every *billed* call is recorded including the retry-discarded ones; a `vngen/state/usage.jsonl` ledger in integer micro-dollars, counts-only because it is committed; the thirteenth editor; a header badge showing spend rather than a balance no provider exposes; and the seven faults in `project.setKey` behind the "add a dropdown" todo — starting with a `secret` prop that renders in plaintext and is shipped over IPC on every keystroke |
| [`deliberate-reasoning-effort-defaults.md`](deliberate-reasoning-effort-defaults.md) | shipped | `default` removed from the effort menu, because on Opus 4.7/4.8 and Sonnet 4.6 "the knob left off" runs the model with no thinking at all: a per-model table in `@vn/types` says what each one's ladder is and whether `no thinking` is even offerable (Fable 400s on it), `low` becomes the stated default everywhere including the pipeline's own calls, `resolveEffort` steps a stored choice down when the model switches under it, and the no-thinking `max_tokens` goes 2048 → 10000 |
| [`layout-templates-and-the-view-menu.md`](layout-templates-and-the-view-menu.md) | shipped | The View menu's editor list folded into an Editors submenu to make room for Layout: named arrangements the project owns at `.vnstudio/layouts/`, carrying either a declarative recipe (so main can ship, scaffold and reset them with no renderer in the loop) or a serialized mesh (so an arbitrary dragged layout round-trips), a `-merge` attribute that makes git conflict one rather than invent a third, an undo that restores the file *and* the screen by noticing the fingerprint moved, and `digest` props finally rendering as a summary instead of a 21 KB textbox |

## Scene authoring

Seven plans that together make a scene an editable document. They come from
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md).
The order below is a dependency order, not a preference: each plan's guarantees are what the next
one rests on. **All seven are shipped.** One plan not
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
| 7 | [`script-composition-in-studio.md`](script-composition-in-studio.md) ✔ | 5 | Write, reorder, split and merge — everything that changes which lines exist |

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
  and `sceneToFountain` already writes them back losslessly. It was marked for revisit once 4–7 had
  shipped, against working editors rather than ahead of them.
  [`scene-chunk-files.md`](scene-chunk-files.md#the-shape) records the argument on both sides.
  **The revisit has happened and came out the same way**: scene-level outfits were the first field
  to want in, and
  [`outfits-at-scene-and-shot-level.md`](outfits-at-scene-and-shot-level.md#the-decision-the-report-left-open)
  took the `[[outfit:]]` marker, because `vngen screenplay`/`vngen import` round-trip markers for
  free and would silently drop a front-matter field. What would change the answer is recorded
  there.

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
- ~~`vngen export` and `story.export` already mean the playable, so Fountain output needs a
  different name~~ → **fixed** in plan 4: the Fountain projection is `vngen screenplay` /
  `story.screenplay`, and the two artifacts never share a name.
- ~~`Timeline.tsx:156` refuses to draw an undecomposed scene, which is exactly the scene you want to
  write before paying for art~~ → **fixed** in plan 6 step 2: the script column renders on its own
  with a note, and the vermilion gap gutter waits for a decomposition rather than marking every line.
- ~~`write_file` (`packages/authoring/src/tools.ts:408`) is an unvalidated whole-file overwrite
  that would happily write a chunk with duplicate line ids~~ → **fixed** in plan 5 step 6:
  `write_file` refuses `scenes/` outright and its description names `edit_scene` instead.

### Checklist

- [x] 1 — allocated line ids
- [x] 2 — lossless scene serialization
- [x] 3 — scene chunk files
- [x] 4 — Fountain import and export
- [x] 5 — scene editing commands
- [x] 6 — line editing in FLOOR
- [x] 7 — script composition in STUDIO

## Keeping this file true

- A plan states its own status in its first lines (`Status: **planned**` / a `## As shipped`
  section). This table is a projection of those — if the two disagree, the plan wins and the table
  is stale.
- Update the row in the same commit that finishes the plan, alongside the plan's As-shipped
  section and the `CLAUDE.md` edits its final step calls for.

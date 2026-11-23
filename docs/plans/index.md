# Plan index and status

Lists every implementation plan in this directory and whether it has been built. A plan is
the authority on its own scope; this file is the authority on what state it is in.

Status values are:

- **shipped** — implemented and in the codebase. The plan's own As-shipped section records
  deviations. Read the plan as a record of what was done rather than as a task list.
- **partial** — some of the work is built and the plan still describes unbuilt work.
- **planned** — nothing is built yet.
- **superseded** — a later plan took the work over. The entry names that later plan.
- **in progress** and **done** appear where a plan has staged work, or where a plan was
  finished without an As-shipped section; **—** marks a tracker file that is not a plan.

A shipped plan's file lives in [`archive/`](archive); open plans and the tracker files
stay in this directory. This list indexes both, one line per plan, and moving a file the
moment its entry flips to shipped is part of flipping its entry (see
[`../reference/conventions.md`](../reference/conventions.md#plans)).

Three batches have extra working detail of their own. Two are complete:
[`desktop-editors-tracking.md`](desktop-editors-tracking.md) for the desktop editors, and
the [scene authoring](#scene-authoring) section below. The third batch is the eight plans
of the authoring surface, whose running order and checkboxes are in
[authoring-surface-tasklist](archive/INDEX.md#authoring-surface-tasklist).

<!-- toc -->

<!-- tocstop -->

## All plans

- **shipped**
  [`archive/INDEX.md#initial-implementation`](archive/INDEX.md#initial-implementation) —
  The monorepo, package layering, phases P1–P7, task graph, store, scheduler, `vngen` CLI.
- **shipped**
  [`archive/INDEX.md#authoring-agent-implementation`](archive/INDEX.md#authoring-agent-implementation)
  — `vnauthor`: workspace index, tool registry, plan/execute modes, skills, the REPL.
- **shipped** [`archive/INDEX.md#runner`](archive/INDEX.md#runner) — `story.play.json`,
  `@vn/export`, the desktop app and its PLAY room.
- **shipped** [`archive/INDEX.md#test-fixtures`](archive/INDEX.md#test-fixtures) —
  `@vn/testkit` — real projects on disk run through the real scheduler.
- **shipped**
  [`archive/INDEX.md#desktop-renderer-restructure`](archive/INDEX.md#desktop-renderer-restructure)
  — One directory per room, pure `.ts` cores with `tests/` siblings, the stylesheet split.
- **shipped**
  [`archive/INDEX.md#refine-loop-inspector`](archive/INDEX.md#refine-loop-inspector) — The
  FLOOR inspector's rendering of the P7 generate→critique→refine loop.
- **shipped**
  [`archive/INDEX.md#story-branch-editor`](archive/INDEX.md#story-branch-editor) —
  STUDIO's `branches` mode, `renderer/graph/`, the semantic drag gestures.
- **shipped** [`archive/INDEX.md#task-dag-view`](archive/INDEX.md#task-dag-view) — FLOOR's
  `graph` mode: barrier nodes, ref edges, ghosts.
- **shipped** [`archive/builtin-skills.md`](archive/builtin-skills.md) — A builtin skill
  catalog (project/user/builtin tiers), per-project enablement, cloning.
- **partial**
  [`scene-prose-guidance-and-context-precedence.md`](scene-prose-guidance-and-context-precedence.md)
  — Scene-writing guidance in the built-in prompt, `edit_scene` refusing an argument its
  op does not read, `AICONTEXT.md` as the author's standing rules, and truncation marks in
  the agent-report transcript. The code shipped; the live runs on `examples/dadsStory` are
  still owed.
- **shipped**
  [`archive/INDEX.md#shot-timeline-editor`](archive/INDEX.md#shot-timeline-editor) —
  FLOOR's `timeline` mode and `story.setCoverage`.
- **shipped** [`archive/INDEX.md#command-system`](archive/INDEX.md#command-system) —
  `@vn/commands`, the DSL, the catalog, provenance, CDP.
- **shipped** [`archive/INDEX.md#command-undo-redo`](archive/INDEX.md#command-undo-redo) —
  Opt-in undo via shadow snapshots under `refs/vn/undo/<seq>`.
- **shipped** [`archive/undo-refactor.md`](archive/undo-refactor.md) — Undo off git and
  onto an in-memory content-addressed store, plus the desktop file cache it shares.
- **shipped** [`archive/undo-checkpoints.md`](archive/undo-checkpoints.md) —
  `CommandStack.beginCheckpoint`/`endCheckpoint` group several commands into one undo
  point, scoped to a declared subtree with automatic rollback on failure.
- **shipped**
  [`archive/INDEX.md#preconditions-and-timeline-interaction`](archive/INDEX.md#preconditions-and-timeline-interaction)
  — `Command.check`, `stack.check`'s three states, the `timeline.cover` interaction.
- **shipped**
  [desktop-storage-and-draggable-rail](archive/INDEX.md#desktop-storage-and-draggable-rail)
  — `.vndesktop/session.json`, `usePanelWidth`, `view.panelSize`.
- **shipped**
  [`archive/INDEX.md#sample-workspace-and-asset-cache`](archive/INDEX.md#sample-workspace-and-asset-cache)
  — `examples/mySampleRepo` seeding and the recorded asset corpus.
- **shipped**
  [`archive/INDEX.md#2d-graphics-debug-api`](archive/INDEX.md#2d-graphics-debug-api) —
  `@vn/debug2d` — fragment IR, DOM adapter, query engine, `explainPick`.
- **shipped** [`archive/INDEX.md#interaction-model`](archive/INDEX.md#interaction-model) —
  `Interaction`/`targets` and the `interaction.*` commands; five gestures declared.
- **shipped** [`archive/INDEX.md#allocated-line-ids`](archive/INDEX.md#allocated-line-ids)
  — Line ids that survive an edit, the diagnostics surface, the catalog-driven palette.
- **shipped**
  [`archive/INDEX.md#lossless-scene-serialization`](archive/INDEX.md#lossless-scene-serialization)
  — `parse(write(scene)) ≡ scene`; `Scene.body` retired, headings and three line kinds
  retained.
- **shipped** [`archive/INDEX.md#scene-chunk-files`](archive/INDEX.md#scene-chunk-files) —
  `scenes/<id>.md` replaces the one contended screenplay; `start:` names the entry,
  front-matter is identity only, both prose patchers retargeted (`screenplay/` still
  loaded when it shipped; plan 4 retired it).
- **shipped**
  [`archive/INDEX.md#fountain-import-export`](archive/INDEX.md#fountain-import-export) —
  `vngen import` / `vngen screenplay`, the desktop pair, and the retirement of
  `screenplay/` as an input.
- **shipped**
  [`archive/INDEX.md#scene-editing-commands`](archive/INDEX.md#scene-editing-commands) —
  Nine `story.*` prose commands over `@vn/scriptedit`, `session.editScene`, the storyboard
  fallout, `script.moveLine`, and `vnauthor`'s `edit_scene` — one write path for prose, no
  UI.
- **shipped** [`archive/INDEX.md#scene-edit-package`](archive/INDEX.md#scene-edit-package)
  — The scene-edit rules and write path now live in `@vn/scriptedit` (pure barrel;
  `@vn/scriptedit/write` for the filesystem half), where `vnauthor` can reach them.
- **shipped**
  [`archive/INDEX.md#line-editing-in-floor`](archive/INDEX.md#line-editing-in-floor) —
  Retyping a line in the coverage timeline, and `Shot.proseHash` → the drift mark on the
  shot it produced.
- **shipped**
  [`archive/INDEX.md#script-composition-in-studio`](archive/INDEX.md#script-composition-in-studio)
  — STUDIO's `script` mode — a column that writes, inserts, deletes, reorders and
  attributes lines, the confirmed acts that change which scenes exist, clickable
  diagnostics, and the end-to-end pass: a scene written in the app.
- **shipped**
  [`archive/INDEX.md#task-failure-visibility-and-retry`](archive/INDEX.md#task-failure-visibility-and-retry)
  — `Task.error` so a failed task records why, a bounded retry on the next run, a run
  report derived from the live plan instead of claiming success over a failure, and
  in-place backend retry for transient provider errors.
- **shipped**
  [`archive/INDEX.md#portrait-overlay-opt-in`](archive/INDEX.md#portrait-overlay-opt-in) —
  The shot is the whole picture: `portrait_overlay` (default off) → `story.play.json`'s
  `portraitOverlay`, so PLAY stops staging a second copy of the speaker over a frame that
  already contains them.
- **—** [`desktop-editors-tracking.md`](desktop-editors-tracking.md) — Not a plan; the
  tracker for the desktop-editor plans in this list.
- **—** [`refactorTaskList.md`](refactorTaskList.md) — Not a plan; the master tracker for
  the [`../history/designRequirementsEtc.md`](../history/designRequirementsEtc.md)
  refactor.
- **shipped**
  [`archive/INDEX.md#entity-discovery-by-meta-tag`](archive/INDEX.md#entity-discovery-by-meta-tag)
  — Characters/locations found by front-matter `type:` tag across `characters/`,
  `locations/` and `wiki/**`; `EntityDoc` carries the source path so no writer re-derives
  one; id/filename agreement and duplicate diagnostics.
- **shipped**
  [`archive/INDEX.md#story-bible-and-retrieval`](archive/INDEX.md#story-bible-and-retrieval)
  — The `wiki/` tree read as prose and reached by retrieval: a new `@vn/bible` between
  store and authoring, `query(text) → ranked excerpts` under a hard budget, `search_bible`
  and `bible.search` — grep now.
- **shipped**
  [`archive/INDEX.md#repo-map-and-commit-on-save`](archive/INDEX.md#repo-map-and-commit-on-save)
  — Which repo owns a path (`RepoResolver`, discovered not declared), every act committing
  to each repo it touched, undo restoring as a _new_ commit rather than a reset, and the
  `git init` + commit-existing half of project bootstrap.
- **shipped**
  [`archive/INDEX.md#base-and-project-asset-stores`](archive/INDEX.md#base-and-project-asset-stores)
  — Base art (portraits, model sheets, location refs) split into its own content-addressed
  root at `assets/` — own subtree, own manifest, optionally its own repo — with reads
  unioned across both roots.
- **shipped**
  [`archive/INDEX.md#shot-ordering-in-scenes`](archive/INDEX.md#shot-ordering-in-scenes) —
  Reordering shots inside a scene as what it actually is — moving the shot's covered lines
  — with the refusal that makes it definable (a shot with interleaved coverage has no
  single position), `moveShot` in `@vn/scriptedit`.
- **shipped**
  [`archive/INDEX.md#outfits-at-scene-and-shot-level`](archive/INDEX.md#outfits-at-scene-and-shot-level)
  — An authorable wardrobe (`outfits:` on the character sheet) and an inheritance chain —
  shot override → `[[outfit: aiko=uniform]]` scene marker → character default — resolved
  by one `outfitFor`.
- **shipped**
  [`archive/INDEX.md#agent-context-regeneration`](archive/INDEX.md#agent-context-regeneration)
  — One generated `AICONTEXT.generated.md` — the cast, the locations, the story graph and
  the bible's _table of contents_ — written by `workspace.reindex` off the two walks that
  already exist.
- **shipped**
  [`archive/INDEX.md#document-tree-and-backlinks`](archive/INDEX.md#document-tree-and-backlinks)
  — The sidebar's two shapes, joined from edges that already exist: a document tree (story
  → scenes → shots, characters, locations, the wiki tree, assets by kind) plus per-entity
  backlinks (sheet, base art, scenes, shots).
- **shipped**
  [`archive/INDEX.md#project-bootstrap-and-workspace-picker`](archive/INDEX.md#project-bootstrap-and-workspace-picker)
  — The other half of project bootstrap: a picked directory becomes a project
  (`openWorkspace` writes a one-line `project.yaml`, then `ensureRepo`),
  `workspace.open`/`pick`/`recent`.
- **shipped**
  [`archive/INDEX.md#wiki-and-document-tree-editors`](archive/INDEX.md#wiki-and-document-tree-editors)
  — The panes for the story bible and the document tree: a `documents` sidebar (logical
  tree + file-tree mode + backlink panel + a New… row), a `wiki` markdown editor, and the
  `doc.read`/`doc.write`/`doc.create` commands they need.
- **shipped**
  [`archive/INDEX.md#pathux-desktop-rewrite`](archive/INDEX.md#pathux-desktop-rewrite) —
  The renderer rebuilt on path.ux (submodule): subdividing screen, seven editors ported
  cheapest-first, one selection, per-area keymaps, `view.*` addressing editors instead of
  rooms, and the docs reorganized by editor.
- **shipped**
  [`archive/INDEX.md#desktop-shell-fit-and-finish`](archive/INDEX.md#desktop-shell-fit-and-finish)
  — Eight gaps collected while using the path.ux shell for real: a window that would not
  close (`will-prevent-unload`), the stock menu deleted with Ctrl+Q and F12 re-homed, a
  bounded dialogue box.
- **shipped**
  [`archive/INDEX.md#asset-names-and-the-asset-editor`](archive/INDEX.md#asset-names-and-the-asset-editor)
  — Generation from an authored surface: assets named rather than hashed in the document
  tree.
- **shipped**
  [`archive/INDEX.md#on-demand-concept-images`](archive/INDEX.md#on-demand-concept-images)
  — A picture the pipeline never asked for: `@vn/artgen` (prompt composition moved out of
  `@vn/pipeline` so the agent can reach it), a `concept` asset kind that is bound but
  never consumed.
- **shipped**
  [`archive/INDEX.md#desktop-agent-permissions`](archive/INDEX.md#desktop-agent-permissions)
  — The desktop answering the agent's other two permission doors: `ask_user` and every
  always-confirm tool were scaffolded to `''` and `true`, so the app answered for the
  author — a question card and a confirm card in the convo pane.
- **shipped** [`archive/INDEX.md#chunked-prompts`](archive/INDEX.md#chunked-prompts) — The
  prompt as an addressable list of clauses rather than a flat string: `PromptChunk[]`
  behind every builder (collapsing byte-identically, so no task hash moves), per-chunk
  replace/append/mute/reorder.
- **shipped** [`archive/guided-ui-tours.md`](archive/guided-ui-tours.md) — The agent
  showing an author how to do something by pointing at it, on an **anchor layer** where a
  widget's click and the record naming it come from one `Offer`, so the two cannot drift
  apart. Pressure-tested by
  [`../research/pressure-test-guided-ui-tours.md`](../research/pressure-test-guided-ui-tours.md);
  as shipped, [`../reference/guided-tours.md`](../reference/guided-tours.md).
- **shipped** [authoring-surface-tasklist](archive/INDEX.md#authoring-surface-tasklist) —
  The running order and checkbox list for the eight plans of the authoring surface, with
  the only two hard dependency edges named.
- **shipped**
  [`archive/INDEX.md#editor-routing-by-relevance`](archive/INDEX.md#editor-routing-by-relevance)
  — Clicking a document tree item shows the editor that can best answer for it: claims
  declared beside the names in `editors.ts` as predicates over the node, a pure
  `routeFor()` sorting on `(visible, tier, EDITORS order)`.
- **shipped**
  [`archive/INDEX.md#asset-cross-references`](archive/INDEX.md#asset-cross-references) — A
  page showing the art that references it: `scene:<id>` backlink keys and a path index on
  `DocTree`, and the asset strip extracted into a generic widget with two consumers — the
  wiki editor and the script editor.
- **shipped**
  [`archive/INDEX.md#new-and-open-project`](archive/INDEX.md#new-and-open-project) —
  `workspace.create` beside `open`/`pick`/`recent`: a three-file skeleton so a new project
  loads a model with zero error diagnostics, a refusal on a non-empty directory, a warning
  when the target sits inside an existing repo.
- **shipped**
  [`archive/INDEX.md#new-project-dialog-with-folder-browse`](archive/INDEX.md#new-project-dialog-with-folder-browse)
  — `prop.directory` and the palette's Browse… button, `workspace.chooseDirectory`, and a
  `newFolder` checkbox that makes `workspace.create`'s form a real New Project dialog.
- **shipped**
  [`archive/INDEX.md#new-project-as-its-own-dialog-and-its-own-repo`](archive/INDEX.md#new-project-as-its-own-dialog-and-its-own-repo)
  — Two faults the author found in the new-project dialog above: the form extracted into a
  `CommandForm` with two hosts, so a named command gets its own dialog, and `initRepoAt`
  for the project's own repo.
- **shipped**
  [`archive/INDEX.md#conversation-threads`](archive/INDEX.md#conversation-threads) —
  Conversations saved as append-only JSONL under `vngen/state/threads/` — outside the undo
  snapshot by design — with the reducer moved to `src/shared/` so main and the renderer
  agree, a searchable dropdown.
- **shipped** [`archive/INDEX.md#upload-and-archive`](archive/INDEX.md#upload-and-archive)
  — `/upload`: an author's documents archived verbatim under `archive/`, invisible to
  `search` and to entity discovery because both walk allow-lists and readable by name,
  with content-blind suggestion chips.
- **shipped**
  [`archive/INDEX.md#adopting-an-uploaded-asset`](archive/INDEX.md#adopting-an-uploaded-asset)
  — Uploaded artwork becoming a slot's actual output rather than a reference: `adoptSlot`
  generalized out of `promoteConcept`, addressed by the existing `plate:`/`sheet:`/`shot:`
  slot vocabulary.
- **shipped** [`archive/INDEX.md#agent-art-revision`](archive/INDEX.md#agent-art-revision)
  — The agent reaching planned art: the art-notes rungs moved to `@vn/artgen` so one
  parser serves both hosts, regeneration as an injected `pipeline?` capability rather than
  an argument with the boundaries rule.
- **shipped**
  [`archive/needs-approval-icon-in-the-toolbar.md`](archive/needs-approval-icon-in-the-toolbar.md)
  — A toolbar dropdown next to the notification bell listing every asset
  `session.approvable()` returns — reusing the bell's own `ShellState` badge + IPC push +
  popup architecture.
- **shipped** [`archive/pathux-rich-editor.md`](archive/pathux-rich-editor.md) — The Wiki
  pane on path.ux's rich text editor: `MarkdownProvider` over a source-retaining session
  per document.
- **shipped**
  [`archive/pathux-rich-editor-widgets.md`](archive/pathux-rich-editor-widgets.md) — Stage
  2 of the rich editor, shipped: per-field custom controls inside path.ux's `FormControl`.
- **shipped** [`archive/wiki-submodule.md`](archive/wiki-submodule.md) — `wiki/` as a git
  submodule of the project: nested repos commit before the parent so the gitlink stays
  current, a detached submodule is put on a branch at open.
- **done** [`merging-a-conflicted-file.md`](merging-a-conflicted-file.md) — Merging a
  conflicted file in the History pane: a whole-file textarea with git's markers, or the
  agent's `resolve_conflict`; no side-by-side editor; a live Sonnet run over prose and
  JSON collisions.
- **planned** [`multiple-windows.md`](multiple-windows.md) — Editors spread across
  monitors: several `BrowserWindow`s in one main process, a window registry, effects split
  into broadcast and targeted ones, and a single-instance lock.
- **shipped**
  [`archive/INDEX.md#document-tree-context-menus`](archive/INDEX.md#document-tree-context-menus)
  — The first context menus in the app, built from the catalog: entries are invocations
  resolved through `check` then `exec`, a refused entry shown with the command's own
  sentence rather than hidden.
- **shipped** [`archive/INDEX.md#notifications`](archive/INDEX.md#notifications) — One
  durable, linkable notification log in the project repo —
  `vngen/state/notifications.jsonl`, per-line versioned, union-merged, with read/hidden as
  single ASCII digits patched in place at a byte offset.
- **shipped**
  [model-keys-tree-menus-and-inline-rename](archive/INDEX.md#model-keys-tree-menus-and-inline-rename)
  — Seven todos taken together: a `secret` prop kind so `project.setKey` can write a
  credential the history records as `<secret>`.
- **planned**
  [`provider-credentials-and-the-ai-usage-ledger.md`](provider-credentials-and-the-ai-usage-ledger.md)
  — Every author billed to their own account, with a `vngen/state/usage.jsonl` ledger of
  billed calls in integer micro-dollars, a header spend badge, and fixes to seven faults
  in `project.setKey`.
- **shipped**
  [`archive/INDEX.md#deliberate-reasoning-effort-defaults`](archive/INDEX.md#deliberate-reasoning-effort-defaults)
  — `default` removed from the effort menu, because on Opus 4.7/4.8 and Sonnet 4.6 "the
  knob left off" runs the model with no thinking at all.
- **shipped**
  [`archive/INDEX.md#reporting-a-difficult-agent`](archive/INDEX.md#reporting-a-difficult-agent)
  — Help ▸ Report a Difficult Agent…: the finding that a thread is a display log rather
  than an execution one (tool args and results dropped, every text clamped at 400) so the
  format is enriched first and old threads are joined.
- **shipped**
  [`archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it`](archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it)
  — A 400 that names a position is unreadable once the body is gone, so the body stops
  being gone: an always-on in-memory ring in `@vn/providers` bounded by bytes _and_ count
  (64 MB / 64 entries).
- **shipped**
  [`archive/INDEX.md#layout-templates-and-the-view-menu`](archive/INDEX.md#layout-templates-and-the-view-menu)
  — The View menu's editor list folded into an Editors submenu to make room for Layout:
  named arrangements the project owns at `.vnstudio/layouts/`.
- **shipped**
  [`archive/INDEX.md#the-full-slot-graph-and-approving-upstream-first`](archive/INDEX.md#the-full-slot-graph-and-approving-upstream-first)
  — Every picture the project implies, not just the wave the planner could hash.
- **shipped**
  [`archive/slot-history-on-the-manifest-row.md`](archive/slot-history-on-the-manifest-row.md)
  — Which take a slot holds and whether a human approved it become two bits on the
  manifest row, `current` and `accepted`: `pick` reads `current`, no runner accepts, the
  popup lists at most one row per slot.
- **planned** [`fast-mode-as-an-opt-in.md`](fast-mode-as-an-opt-in.md) — Anthropic fast
  mode as a per-conversation toggle, off by default and never inferred, offered only for
  an enumerated set of models, with the doubled rate stated in the tooltip.
- **shipped**
  [`archive/INDEX.md#prompt-caching-and-deferred-tool-loading`](archive/INDEX.md#prompt-caching-and-deferred-tool-loading)
  — Why a small project bills ~376k input tokens for one conversation, and the five
  workstreams that fix it: cache reads and writes split out of `TokenUsage` so the rest
  can be believed.
- **shipped** [`archive/INDEX.md#the-todos-sweep`](archive/INDEX.md#the-todos-sweep) — The
  author's running list worked through in one pass: the run-pipeline dialog and its busy
  icon, the recent-projects menu, popup borders and word wrap, a key-provider dropdown,
  the agent's running token total.
- **shipped**
  [`archive/INDEX.md#drawing-a-character-before-a-scene-casts-them`](archive/INDEX.md#drawing-a-character-before-a-scene-casts-them)
  — P2/P3 enumerate every authored location and character rather than only what a
  reachable scene names, so a cast sheet gets its portrait before a scene exists to put it
  in; P4 stays tied to `usedOutfits`.
- **shipped**
  [`archive/INDEX.md#improving-the-authoring-agent`](archive/INDEX.md#improving-the-authoring-agent)
  — What the adversarial read of `examples/test4` found, built: a per-turn **token
  budget** replacing the step count (checked between steps, warning the agent at 80%,
  naming the spend and the uncommitted files when it runs out).
- **shipped**
  [`archive/INDEX.md#superseded-assets-in-the-document-tree`](archive/INDEX.md#superseded-assets-in-the-document-tree)
  — The Assets branch asks the slot graph which take is current and files the rest under a
  collapsed `Superseded` child — undecided candidates all count as live, and an asset no
  slot mentions stays put.
- **shipped**
  [`archive/INDEX.md#shipping-the-app-tasklist`](archive/INDEX.md#shipping-the-app-tasklist)
  — The five plans between "it runs from a checkout" and "a stranger has it installed and
  updating", their running order, and the three real edges between them.
- **shipped**
  [`archive/INDEX.md#onboarding-editor-and-user-level-keys`](archive/INDEX.md#onboarding-editor-and-user-level-keys)
  — API keys above the project — a platform-native user config dir with `$VNAUTHOR_HOME`
  and a `~/.vnauthor` fallback read, appended as a fourth rung so a project's own key
  still wins.
- **shipped**
  [`archive/INDEX.md#packaging-the-desktop-app`](archive/INDEX.md#packaging-the-desktop-app)
  — electron-builder into an NSIS installer: what ships (only `dist/` plus the two SDKs
  `EXTERNAL` leaves unbundled, and never `pathux-types`), the hoisted install that keeps
  pnpm's symlinks out of the app image.
- **shipped**
  [`archive/INDEX.md#release-ci-workflow`](archive/INDEX.md#release-ci-workflow) — The two
  workflows this repo has never had: per-push check/test/lint with
  `submodules: recursive`, and a tag-triggered release that gates once, builds a matrix,
  asserts the tag against the version rather than writing it.
- **shipped**
  [`archive/INDEX.md#skills-editor-and-agent-authored-skills`](archive/INDEX.md#skills-editor-and-agent-authored-skills)
  — Skills made visible and writable: a Skills branch in the document tree that is drawn
  even when empty, because a created project has no `.aiagent/` at all and an absent
  branch teaches nobody. Pressure-tested:
  [`../research/pressure-test-skills-editor-plan.md`](../research/pressure-test-skills-editor-plan.md).
- **shipped**
  [`archive/INDEX.md#in-app-update-checks`](archive/INDEX.md#in-app-update-checks) —
  `app.checkForUpdates` as a registered command reading the releases feed and comparing
  semver — check-only first because `electron-updater` on macOS needs signing and fails
  silently without it; the notification rather than a modal.
- **shipped**
  [`archive/INDEX.md#auditing-the-api-key-instructions`](archive/INDEX.md#auditing-the-api-key-instructions)
  — Keeping `docs/api-keys.md` true: a per-vendor yaml block so the facts are
  machine-readable, a deterministic blocking link check because a moved console is the
  failure that actually happens.
- **planned** [`code-signing-and-notarization.md`](code-signing-and-notarization.md) —
  Deferred by decision, written down so it is not rediscovered: unsigned Windows is a
  dismissible papercut and unsigned macOS is a wall, what the three options cost, and the
  three triggers that make it worth doing.
- **shipped**
  [`archive/INDEX.md#gemini-estimated-cache-hit-rate`](archive/INDEX.md#gemini-estimated-cache-hit-rate)
  — Gemini's implicit cache reported in the tokens tooltip: `cachedContentTokenCount`
  carved out of `input` as `cacheRead`, a `cacheEstimated` flag riding the same wire so a
  matched-prefix count is never shown as a bill.
- **planned**
  [`four-chat-vendors-and-two-more-image-providers.md`](four-chat-vendors-and-two-more-image-providers.md)
  — Anthropic, Gemini, OpenAI and Grok behind one `ChatBackend`, and OpenAI Images plus
  BFL FLUX.2 behind one `ImageBackend`, with a vendor table in `@vn/types` and a neutral
  `ChatBlock` vocabulary.
- **shipped**
  [`openrouter-as-a-fallback-transport.md`](openrouter-as-a-fallback-transport.md) — The
  app runs on an OpenRouter key alone: a model keeps its native vendor and gains a
  _transport_ — the native key when it resolves, else OpenRouter when that key resolves
  and OpenRouter serves the model.
- **shipped**
  [`archive/INDEX.md#what-the-agent-knows-about-the-story-format`](archive/INDEX.md#what-the-agent-knows-about-the-story-format)
  — The authoring agent's knowledge of the story format, routed to the three places it can
  live.
- **shipped**
  [`archive/INDEX.md#publishing-a-vn-to-github-pages`](archive/INDEX.md#publishing-a-vn-to-github-pages)
  — A generated VN publishes to the web as a light novel: `renderSite` projects the
  playable into one static HTML page per scene with `choices` and `next` as links and no
  prose rewriting.
- **planned**
  [`creating-shots-by-hand-and-by-agent.md`](creating-shots-by-hand-and-by-agent.md) —
  Shot creation and coverage assignment as authorial acts: the coverage rules move into
  `@vn/scriptedit`, the Coverage editor offers `story.newShot`, and the agent gains
  `set_coverage` and `propose_storyboard`.
- **superseded**
  [`archive/INDEX.md#watching-and-stopping-an-agent-report`](archive/INDEX.md#watching-and-stopping-an-agent-report)
  — Superseded by
  [`archive/INDEX.md#the-debug-agent-as-a-conversation`](archive/INDEX.md#the-debug-agent-as-a-conversation),
  which carries its busy-state work and its fallback fix.
- **shipped**
  [`archive/INDEX.md#prompt-caching-for-the-report-analyst`](archive/INDEX.md#prompt-caching-for-the-report-analyst)
  — The report analyst joins the cached path: `analyzeWithTools` probes `chatConversation`
  the way `session.ts` and `vnauthor` already do.
- **shipped**
  [`archive/INDEX.md#the-debug-agent-as-a-conversation`](archive/INDEX.md#the-debug-agent-as-a-conversation)
  — The difficult-agent report stopped being a dialog that blocks and became an agent the
  author talks to: a Debug Agent pane opened as a popup from the Help menu and listed in
  neither of the two menus an author browses.
- **planned**
  [`refine-corrections-tool-schemas-shot-variants-and-commit-subjects.md`](refine-corrections-tool-schemas-shot-variants-and-commit-subjects.md)
  — Five findings from one `vnauthor` conversation in `examples/test4`: a refined frame
  can never be regenerated, a tool's real schema never reaches the model, `Shot.location`
  is a variant, a chat reply becomes a commit subject, and the report analyst asserts
  uncorroborated symptoms.
- **planned** [`asset-gallery-popup.md`](asset-gallery-popup.md) — A virtualized,
  searchable thumbnail grid in path.ux (`AssetGallery`), with an Attach… button in the
  asset editor so that picking a reference no longer means pasting a hash.
- **planned**
  [`recording-cache-misses-in-a-thread.md`](recording-cache-misses-in-a-thread.md) — A
  saved transcript records, per API call, whether the prompt cache was read as it should
  have been (`cold`, `hit`, `expired` or `miss`). Written from
  [`../research/tracking-cache-misses-in-transcripts.md`](../research/tracking-cache-misses-in-transcripts.md).
- **shipped**
  [`archive/INDEX.md#clustering-the-global-task-graph`](archive/INDEX.md#clustering-the-global-task-graph)
  — The task graph editor's overview stops handing `layoutGraph` the raw per-task graph,
  where one shared portrait fans out to every shot that refs it and blows a rank out to
  the shot count.
- **shipped**
  [`archive/remembering-ui-state-in-the-project.md`](archive/remembering-ui-state-in-the-project.md)
  — The arrangement an author left a project in moves out of the install-global
  `session.json` and into a gitignored `.vnstudio/session.json` beside the layout
  templates.
- **in progress** [`node-based-asset-generation.md`](node-based-asset-generation.md) —
  Stages 1 to 10 shipped. The node-based asset generator staged from
  [`../research/node-based-asset-generation.md`](../research/node-based-asset-generation.md)'s
  nine decisions: `@vn/gengraph`, an executor for bound graphs, `gengraph.*` commands,
  agent tools, the Gen Graph pane and plugins. As shipped:
  [`../reference/gen-graphs.md`](../reference/gen-graphs.md).
- **shipped**
  [`archive/resumable-threads-and-compaction.md`](archive/resumable-threads-and-compaction.md)
  — Reopening a saved conversation stops being a replay the model is never shown: the
  backend-native messages get a second file beside the display log (which clamps every
  text at 400 characters and so can never be replayed verbatim).
- **shipped**
  [`archive/group-nodes-in-the-gen-graph-editor.md`](archive/group-nodes-in-the-gen-graph-editor.md)
  — Groups in the Gen Graph pane, the desktop half of path.ux's
  [`group-node-authoring`](../../vendor/path.ux/documentation/plans/group-node-authoring.md)
  plan. As shipped:
  [`../reference/gen-graphs.md#groups`](../reference/gen-graphs.md#groups).
- **—** [`gengraph-editing-cost-tasklist.md`](gengraph-editing-cost-tasklist.md) — Not a
  plan; the tracker for the four plans that follow it, and the breakdown of what one
  node-property edit costs.
- **shipped** [`archive/deferring-commit-on-save.md`](archive/deferring-commit-on-save.md)
  — Commit-on-save batched across a run of consecutive edits instead of one commit per
  command, in `@vn/commands`: a `defersCommit` opt-in on the command definition.
  Pressure-tested:
  [`../research/pressure-test-deferring-commit-on-save.md`](../research/pressure-test-deferring-commit-on-save.md).
- **shipped**
  [`archive/gengraph-node-editor-data-api.md`](archive/gengraph-node-editor-data-api.md) —
  The Gen Graph pane stops drawing its own node rows: a `DataAPI` scoped to the graph on
  screen, installed on the view through `ctx.override({ api })` so two panes on different
  slugs each answer for their own graph. Pressure-tested:
  [`../research/pressure-test-gengraph-node-editor-data-api.md`](../research/pressure-test-gengraph-node-editor-data-api.md).
- **shipped**
  [`archive/document-versions-and-live-reads.md`](archive/document-versions-and-live-reads.md)
  — Per-document write versions, so a pane can tell the echo of its own write from a
  change somebody else made.
- **shipped** [`archive/precise-write-signals.md`](archive/precise-write-signals.md) —
  Precise write signals: the re-derivation storm that the document-versions plan named as
  out of scope.
- **shipped**
  [`archive/guided-tour-resolution-fixes.md`](archive/guided-tour-resolution-fixes.md) —
  Five fixes to the guided-tour layer, from a bug review of it.
- **planned**
  [`enforcing-prose-style-without-context-poisoning.md`](enforcing-prose-style-without-context-poisoning.md)
  — A tool that applies [`../reference/proseStyle.md`](../reference/proseStyle.md) to one
  Markdown file with a fresh-context model call per block, a deterministic splitter,
  rewrap and structural guard, and a diff written to a gitignored file.
- **shipped** [`manga-style.md`](archive/manga-style.md) — Colour manga beside the VN
  look, following
  [`../research/manga-shot-composition.md`](../research/manga-shot-composition.md). All
  five stages shipped (runner-drawn bubbles on 2026-09-17): page shots with panel
  polygons, model or runner-drawn lettering, and the sheet gen graph. Pressure-tested;
  nineteen findings recorded in the plan. The Page editor's brief, plan and critique are
  in [`manga-style-design.md`](manga-style-design.md).
- **shipped**
  [`archive/openrouter-backend-and-the-image-model-default.md`](archive/openrouter-backend-and-the-image-model-default.md)
  — OpenRouter as a built-in image backend beside Gemini, picked per call from the model
  id (`imageVendorOf`: a slash means OpenRouter).
- **shipped** [`archive/journal-content-cache.md`](archive/journal-content-cache.md) — The
  gen-graph journal resumes a node from any answer it already holds for the same inputs,
  keyed on a run key computed from what actually fed the node, so a model prop moved away
  and back does not redraw.
- **shipped**
  [`archive/one-offer-and-the-six-rule-modules.md`](archive/one-offer-and-the-six-rule-modules.md)
  — Plan 1 of the UX behaviour model batch: `Offer` grows to carry everything an anchor
  records (`label`, a required `tooltip`, `on`, `supplies`, `form`) so `ActOptions` is
  deleted, its refused branch carries path.ux's `Refusal`.
- **shipped**
  [`archive/the-ten-inline-editors-get-a-rule-module.md`](archive/the-ten-inline-editors-get-a-rule-module.md)
  — Plan 2 of the UX behaviour model batch: every anchor home gets a rule module with
  `controls(state)` over plain data, so the ten editors that build offers beside their DOM
  code.
- **shipped**
  [`archive/situations-and-the-derived-model.md`](archive/situations-and-the-derived-model.md)
  — Plan 3 of the UX behaviour model batch: a hand-written situation list per rule module
  (a named fixture of the module's state type).
- **shipped**
  [`archive/pseudo-commands-and-a-controls-effects.md`](archive/pseudo-commands-and-a-controls-effects.md)
  — Plan 4 of the UX behaviour model batch: a closed vocabulary of twelve effects.
- **shipped**
  [`archive/the-measured-tier-reads-tags.md`](archive/the-measured-tier-reads-tags.md) —
  Plan 7 of the UX behaviour model batch: the anchor layer's `AnchorDump` becomes a
  path.ux meta tag written by the same `writeTag` the derived tier calls, so both tiers
  name a control the same way.
- **shipped**
  [`archive/every-command-declares-what-it-touches.md`](archive/every-command-declares-what-it-touches.md)
  — Plan 8 of the UX behaviour model batch, and independent of every other row: an
  `affects` field on each of the 94 mutating command definitions, naming the subtrees the
  command may write.
- **shipped** [`site-speech-bubbles.md`](site-speech-bubbles.md) — Speech bubbles on the
  published GitHub Pages site: `renderSite` draws each page shot's `bubbles` over the
  figure the way the Play pane does.
- **—** [`ux-behaviour-model-tasklist.md`](ux-behaviour-model-tasklist.md) — Not a plan;
  the proposed split of
  [`../research/ux-behaviour-model.md`](../research/ux-behaviour-model.md) and its
  companion into eight plans, with the lint rules routed to the plan that makes each
  checkable. Nothing scheduled.
- **shipped** [`archive/agent-reads-the-ux-model.md`](archive/agent-reads-the-ux-model.md)
  — The agent as a reader of the derived UX model: `ux-model.json`, `anchors.json` and the
  catalog folded into a generated Markdown tree that the agent reads through `ux_list`,
  `ux_read` and `ux_search`.
- **shipped** [`archive/history-pane.md`](archive/history-pane.md) — The History pane over
  the project's git repositories, built from
  [`../research/git-editor-pane.md`](../research/git-editor-pane.md) in eight stages:
  `@vn/git` reads and writes. As shipped:
  [`../reference/history-pane.md`](../reference/history-pane.md).
- **shipped**
  [`archive/wiki-and-file-tree-editing.md`](archive/wiki-and-file-tree-editing.md) — The
  six "Wiki Subtree / File Tree Commands" todos in the documents pane: New folder and New
  file on folders in the Wiki branch and in file mode (both trees now show empty folders),
  marking several rows with Ctrl- and Shift-click.
- **shipped** [`archive/deleting-things.md`](archive/deleting-things.md) — Implements the
  decisions in `research/deleting-things.md`: a confirmation gate that asks, tombstones in
  `tasks.jsonl`, a read-only project validator.
- **shipped**
  [`archive/select-steps-finish-on-the-selection.md`](archive/select-steps-finish-on-the-selection.md)
  — A tour's `select` step finishes when the shared selection holds its subject, read
  through path.ux data paths; validated select kinds; the ring finds a subject's row by
  its selection field. As shipped:
  [`../reference/guided-tours.md`](../reference/guided-tours.md#advancing).
- **shipped**
  [`contracts-into-code-and-workflows`](archive/INDEX.md#contracts-into-code-and-workflows)
  — Moved every rule of the pipeline contracts page into code and deleted the page, along
  the seams of
  [`../research/workflows-and-narrative-engines.md`](../research/workflows-and-narrative-engines.md).
  Pressure-tested (fifteen findings); the plan is zipped, and the surviving design is in
  [`../reference/contracts.md`](../reference/contracts.md).
- **shipped**
  [`archive/family-facts-and-task-slot-inverse.md`](archive/family-facts-and-task-slot-inverse.md)
  — Two leftovers of the contracts plan: `familyOf` answers a family over `HostFacts`, the
  facts every host builds, so a second workflow's family registers with its own facts
  through `withFacts`.

## Scene authoring

Seven plans together make a scene an editable document. They come from
[`../research/scene-chunks-as-the-authored-unit.md`](../research/scene-chunks-as-the-authored-unit.md).
The order below is a dependency order rather than a preference, because each plan rests on
the guarantees of the one before it. All seven are shipped, and all seven boxes of the
batch's checklist are ticked. One plan outside the original seven has been carved out
since: [`archive/INDEX.md#scene-edit-package`](archive/INDEX.md#scene-edit-package) is a
prerequisite for 5's agent tool.

- 1 ✔ [`archive/INDEX.md#allocated-line-ids`](archive/INDEX.md#allocated-line-ids) —
  positional ids re-point every shot when a line is inserted, so nothing may edit prose
  until ids survive.
- 2 ✔
  [`archive/INDEX.md#lossless-scene-serialization`](archive/INDEX.md#lossless-scene-serialization)
  — writing a scene back lost its heading, so nothing may write a scene until the writer
  is honest.
- 3 ✔ [`archive/INDEX.md#scene-chunk-files`](archive/INDEX.md#scene-chunk-files) (after
  1, 2) — one contended screenplay becomes one file per scene.
- 4 ✔ [`archive/INDEX.md#fountain-import-export`](archive/INDEX.md#fountain-import-export)
  (after 2, 3) — migrates existing projects in and keeps the format from being lock-in.
- 5 ✔ [`archive/INDEX.md#scene-editing-commands`](archive/INDEX.md#scene-editing-commands)
  (after 1, 3) — the only write path for prose; no UI, verified through the palette and
  CDP.
- ✔ [`archive/INDEX.md#scene-edit-package`](archive/INDEX.md#scene-edit-package) (after 5)
  — not one of the seven: 5's rules lived in the desktop app, and a package cannot import
  an app, so the agent tool needed them moved first.
- 6 ✔ [`archive/INDEX.md#line-editing-in-floor`](archive/INDEX.md#line-editing-in-floor)
  (after 5) — correct a line where you can see the frame it produced.
- 7 ✔
  [`archive/INDEX.md#script-composition-in-studio`](archive/INDEX.md#script-composition-in-studio)
  (after 5) — write, reorder, split and merge: everything that changes which lines exist.

6 and 7 are siblings and independent of each other. FLOOR edits a line, and STUDIO edits
the script.

### Decisions that span the batch

These are recorded here because each was settled once and every later plan assumes it.

- **Line ids are scene-scoped and remain so.** `Shot.coversLines` binds to
  `${sceneId}:L<n>`, so no line can cross a scene boundary and keep its coverage. The
  batch makes the detachment visible (in `splitScene`/`mergeScene`) rather than
  introducing global ids.
- **No edit to a scene invalidates art, so drift has to be reported.** `buildShotPrompt`
  reads neither `coversLines` nor line text (prose reaches only the P7 reviewer spec,
  which never enters a task's `inputs`), so retyping a covered line rehashes nothing and
  re-renders nothing. The frame still illustrates words the scene no longer contains. Plan
  5 settled this against the code, and it reversed the batch's original premise. Every
  plan that can change prose must report the drift to the author before the commit.
- **Drift is derived, never stored.** A shot has drifted when the hash of the covered
  lines' text, recorded when its image was written, disagrees with the hash those lines
  produce now. That comparison is computable, self-healing, and correct for edits made
  through the CLI or by hand. It does not use the task hash, because prose cannot move the
  task hash. Plan 6 shipped it as `Shot.proseHash` (stamped only when the image's bytes
  are new) and `driftOf`; a shot rendered before the field existed reads `unknown`.
- **Each authorial act is one command and one undo point.** There are no batch edits, no
  JSON-patch command, and no buffer diffed to commands on save.
- Both input formats loaded during the move, and a project with both was an error. Plan 4
  ended the move: `scenes/` is the only form scenes load from, a leftover `screenplay/` is
  reported rather than read, and the both-present error became a warning, because a
  directory that builds no scenes cannot contend with the chunks.
- **A scene chunk's front-matter carries only `scene: <id>`** — matching the filename, on
  a closed schema. Heading, location, synopsis, `choices`, `next` and line ids stay
  `[[…]]` markers and Fountain elements in the body, because `splitScenes` already reads
  them there and `sceneToFountain` already writes them back losslessly. It was marked for
  revisit once 4–7 had shipped, against working editors rather than ahead of them.
  [`archive/INDEX.md#scene-chunk-files`](archive/INDEX.md#scene-chunk-files) records the
  argument on both sides. The revisit has happened and came out the same way: scene-level
  outfits were the first candidate field, and
  [`archive/INDEX.md#outfits-at-scene-and-shot-level`](archive/INDEX.md#outfits-at-scene-and-shot-level)
  took the `[[outfit:]]` marker, because `vngen screenplay`/`vngen import` round-trip
  markers for free and would silently drop a front-matter field. Two things would change
  the answer: a second field that has no reading as a marker (something positionless and
  structured, such as a per-scene render budget), or the Fountain projection being
  retired. Neither is true today.

### Blockers found while planning

All eight broken or dead items found while planning are fixed, each in the plan that owned
it:

- `headingFor` rebuilt every heading as `INT. <LOCATION> - DAY`, discarding `EXT.` and the
  time of day. Plan 2 gave `Scene` `headingPrefix` and `locationVariant` and deleted
  `headingFor`.
- `currentSpeaker` was cleared only on `flush()`, and an `action`-with-speaker branch
  described a case `parseFountain` cannot produce. Plan 2 ended attribution with the
  dialogue block, and `'action'` is no longer a `SceneLine.kind`.
- `buildModel` took the entry scene as `sceneList[0]`, so the entry followed readdir order
  once scenes were files. Plan 3 step 6 takes `entry` from `config.start`, and a missing
  or dangling `start:` is an error diagnostic.
- Four call sites duplicated `loadInputs` → `parseFountain` → `buildModel`. Plan 3 step 1
  made `@vn/model`'s `modelFromInputs` the one sequencing point (not `loadProjectModel` in
  `@vn/store`, which may not import `model`), and moved `LoadedInputs` to `@vn/parse`.
- `ProjectPaths.sceneFile` and `writeSceneFile` were dead code holding the name authored
  chunks require. Plan 3 step 2 deleted both.
- `vngen export` and `story.export` already mean the playable, so Fountain output needed
  another name. Plan 4 named it `vngen screenplay` and `story.screenplay`.
- `Timeline.tsx` refused to draw an undecomposed scene, which is the scene to write before
  paying for art. Plan 6 step 2 renders the script column on its own with a note.
- `write_file` was an unvalidated whole-file overwrite that could write a chunk with
  duplicate line ids. Plan 5 step 6 makes it refuse `scenes/`, and its description names
  `edit_scene`.

## Keeping this file true

- A plan states its own status in its first lines (`Status: **planned**` or a
  `## As shipped` section). This list restates the status each plan declares. If a plan
  and the list disagree, the plan wins and the list is stale.
- Update the plan's entry in the same commit that finishes the plan, alongside the plan's
  As-shipped section and the edits to `CLAUDE.md` that the plan's final step calls for.

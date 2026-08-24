# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository. This file lists the
packages, the invariants, and documentation.

Detailed as-shipped documentation lives in [`docs/`](docs). Follow the pointers rather
than duplicating them here.

## What this is

VN Generator is a pnpm/TypeScript monorepo that turns authored inputs (characters, a
branching Fountain screenplay, optional locations and reference images) into a deduped,
resumable pipeline of generated art assets plus a provenance manifest.

The design separates deterministic plumbing (parse, validate, dedupe, layout, schedule)
from generative steps (LLM and image-model calls). Package boundaries mirror that split
and are enforced by lint rules, so the input-side packages can be reused without pulling
in the generative pipeline.

- Docs index: [`docs/index.md`](docs/index.md)
- Design: [`docs/history/vn-generator-report.md`](docs/history/vn-generator-report.md)
- Pipeline contracts (the invariants below, in full):
  [`docs/reference/pipeline-contracts.md`](docs/reference/pipeline-contracts.md)
- Debugging guide: [`docs/guides/debugGuide.md`](docs/guides/debugGuide.md). Read it before
  debugging anything in this repo; it orders the tools cheapest-first and prefers evidence
  over reproduction.
- Out of scope: export to an external engine (Ren'Py, Ink, and the like). The generative
  pipeline core stops at a populated `build/` plus `manifest.json`. On top of that sit a
  small in-house playable (`vngen export` → `story.play.json`) and a desktop runner for
  watching a generated VN.

Alongside the pipeline is `vnauthor`, a plan-first conversational agent that helps an
author write and refine the inputs (characters, screenplay, locations). It lives entirely
on the input side, and a boundaries lint rule forbids it from importing the generative
pipeline.

## Setup

A fresh clone needs four steps, in this order (you can also run 'pnpm setup:all'; keep
it up to date with this list):

```bash
git submodule update --init --recursive   # vendor/path.ux, and the one it carries
pnpm install                              # Node >= 20, pnpm 10 (see packageManager)
pnpm --dir vendor/path.ux install         # path.ux has its own lockfile; the root install skips it
pnpm check:setup                               # fails by name if either of the two is still owed
```

Note: path.ux is a submodule with submodules wired into the build as a
vite alias; `pnpm check:setup`
(`scripts/check-submodules.mjs`, also the desktop build's first step) is needed to properly
surface errors. Checking out the submodule does not install its dependencies: path.ux is its own
project with its own lockfile, and it is not a pnpm workspace member, so the root install
skips it. Anyone who has built path.ux before tends to forget that step, because their
`node_modules` is already on disk. On a clean checkout the symptom is scores of "has no
exported member" errors inside `vendor/`, which name a symbol rather than the missing
install. `pnpm check:setup` also fails on this by name.
nstructjs is a submodule as well, at `vendor/nstructjs`, and the desktop app depends on it as
`link:../../vendor/nstructjs` rather than on the published package. It is used through the build
output it commits, so it needs no install of its own, and `pnpm check:setup` exempts it. path.ux
imports nstructjs too: the vite alias and the `nstructjs` path in `renderer/tsconfig.json` and
`pathux-types.tsconfig.json` redirect those imports to the submodule, so path.ux's own install of
the published package goes unused here.
Then `pnpm check && pnpm test && pnpm lint` should be green, and `pnpm build` bundles
everything. Details: [`docs/guides/toolchain.md`](docs/guides/toolchain.md), and
[`docs/reference/desktop-app.md`](docs/reference/desktop-app.md) for the submodule's role.

## Commands

Run from the repo root.

| Task                         | Command                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Typecheck (the gate)         | `pnpm check`                                                                  |
| Test (all)                   | `pnpm test`                                                                   |
| Test one package             | `pnpm exec jest --selectProjects @vn/taskgraph`                               |
| Lint (eslint + format check) | `pnpm lint`                                                                   |
| Auto-format                  | `pnpm format`                                                                 |
| Update docs TOCs             | `pnpm markdown-toc` (skips `docs/plans/**`)                                   |
| Check doc links              | `pnpm check:doclinks` (relative links + anchors; part of `pnpm lint`)         |
| Bundle everything            | `pnpm build` (turbo: `vngen`, `vnauthor`, and the desktop app)                |
| Run the CLI                  | `node apps/cli/dist/cli.js <cmd>` (or `pnpm vngen <cmd>`)                     |
| Run the authoring agent      | `node apps/authoring/dist/vnauthor.js [dir]` (or `pnpm vnauthor [dir]`)       |
| Run the desktop app          | `pnpm vndesktop [--mock]` (built app, CDP on 9222)                            |
| Package the desktop app      | `pnpm package` (installer) / `pnpm package:dir` (unpacked)                    |
| Smoke-test the packaged app  | `pnpm smoke` (runs the built binary; proves both SDKs and the source resolve) |
| Check the key-guide links    | `pnpm check:keylinks` (blocking in CI; `docs/guides/api-keys.md` only)        |
| Audit the key-guide wording  | `pnpm audit:keydocs [--dry-run]` (weekly, advisory, needs a key)              |

`pnpm check`, `pnpm test`, and `pnpm lint` should all be green before and after any change.

The toolchain's shape, and every deliberate deviation from the original plan, is documented
in [`docs/guides/toolchain.md`](docs/guides/toolchain.md). Four things cause enough mistakes
to repeat here:

- `pnpm check` runs two passes: the flat workspace check plus `pnpm check:renderer`,
  because `apps/desktop/renderer/**` lives outside `src/` and nothing else typechecks it.
- Tests must live in a `tests/` subfolder beside the code they cover. A `*.test.ts`
  anywhere else is silently never run.
- Internal packages are source-only (no per-package `dist`), so consumers import
  `src/index.ts` directly. esbuild transpiles; only `tsgo` type-checks.
- Imports use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).

## Architecture

### Package layering

The graph is acyclic, enforced by `eslint-plugin-boundaries` and `import/no-cycle`. What
each package is responsible for, and the rules behind this diagram, are in
[`docs/reference/packages.md`](docs/reference/packages.md).

```
types  util
  │     │
config  parse
  │     │ │
  │   model store ─ export scriptedit bible artgen   git ──── commands
  │     │   │  │  ╲     │
  │     │  taskgraph ╲  │
providers   │      ╲ ╲  │
  │  │      │       authoring ── authoring-app (vnauthor)
  └──┴── pipeline   │
            │       agentreport
        scheduler
            │
           cli
```

- The pipeline spine and the authoring branch are disjoint below `@vn/store`;
  they are not allowed to depend on each other.
  `@vn/authoring` reuses the input-side packages but must never import `@vn/pipeline` or
  `@vn/scheduler`. The boundaries rule checks each import statement rather than the
  transitive closure, so routing a forbidden import through an allowed leaf package still
  violates the design and must not be done.
- Five leaves share that constrained allow-list. `@vn/export`, `@vn/scriptedit`,
  `@vn/bible` and `@vn/artgen` are leaves because two hosts (the desktop app and
  `vnauthor`) must run the same rules, so the rules cannot live in either host.
  `@vn/agentreport` is a leaf because its one host is the desktop app; it additionally
  imports `@vn/commands` for the command records that transcripts do not contain.
- Two packages sit outside the graph. `@vn/debug2d` imports nothing from `packages/` and
  is dev-only in the renderer. `@vn/testkit` may import every layer, and nothing may
  import it.

### Core ideas

Core application contracts; breaking one costs money or corrupts provenance. See
[`docs/reference/pipeline-contracts.md`](docs/reference/pipeline-contracts.md) for
full details including failure modes. Read the pipeline-contracts doc in full before changing
bullet points, make sure to read any documents linked in the corresponding bullet point inside
the pipeline-contracts doc.

- **Content-addressed task graph.** Task identity is `sha256(kind, inputs)`. Replaying
  `state/tasks.jsonl` rebuilds the graph, which is what makes a run resumable.
- **Content-addressed asset store, in two roots.** Base art lives at `assets/`, shot
  frames at `vngen/build/assets/`.
  ([`docs/reference/asset-stores.md`](docs/reference/asset-stores.md))
- **Approval gate.** The P3 character-approval gate is a planner predicate rather than a
  task dependency. While the gate is closed, a run halts with no tasks ready.
- **Sheet planning.** Authoring a character sheet causes a portrait and a plate to be
  planned. A model sheet is planned only once a scene casts the character.
  ([`docs/plans/archive/drawing-a-character-before-a-scene-casts-them.md`](docs/plans/archive/drawing-a-character-before-a-scene-casts-them.md))
- **Incremental planning.** The planner runs once per wave, so `vngen cost` undercounts
  work that a later wave will unlock.
- **Slot graph.** The graph's nodes are slots (`portrait:`, `sheet:`, `plate:`, `shot:`),
  with edges from `refsOfSlot` rather than task hashes. Approval propagates upstream
  first, through `assetApproved`, `assetPrereqs` and `prereqRefusal`. The refusal sentence
  is kept identical in all three places.
  ([`docs/plans/archive/the-full-slot-graph-and-approving-upstream-first.md`](docs/plans/archive/the-full-slot-graph-and-approving-upstream-first.md))
- **Explicit decomposition.** A scene is decomposed only on an explicit request, and a
  fallback storyboard is never persisted. The only signal meaning "decompose this scene"
  is a missing `work/shots/<sceneId>.json`; placing a first shot by hand writes that file
  and ends decomposition the same way. A storyboard, once written, is never regenerated
  automatically, and a shot's order is determined by where its lines sit.
  ([`docs/plans/creating-shots-by-hand-and-by-agent.md`](docs/plans/creating-shots-by-hand-and-by-agent.md))
- **Failure records.** A terminal task records why it failed, is retried once, and is
  reported from the live plan.
- **Outfit inheritance.** `outfitFor` resolves shot override → the scene's `[[outfit:]]`
  marker → `character.defaultOutfit`. Changing an outfit re-renders, unlike other scene
  edits.
  ([`docs/plans/archive/outfits-at-scene-and-shot-level.md`](docs/plans/archive/outfits-at-scene-and-shot-level.md))
- **Art direction.** `artNotes` is an authored free-text field at five rungs, appended to
  the derived prompt; changing it deliberately re-renders. The agent reaches the same
  rungs and gets the same refusals. The image seed uses the same rungs and is resolved
  only in `seedFor`. Zero is a valid seed, so every presence test is `=== undefined`.
  ([`docs/plans/archive/asset-names-and-the-asset-editor.md`](docs/plans/archive/asset-names-and-the-asset-editor.md),
  [`docs/plans/archive/agent-art-revision.md`](docs/plans/archive/agent-art-revision.md))
- **Concept images.** A concept image sits outside the pipeline: it is never planned,
  consumed, exported, or `accepted`. Its prompt is authored rather than derived, so it is
  the one prompt an author may edit.
- **Adoption.** `adoptSlot` writes the only `done` record produced outside the scheduler.
  It records arbitrary bytes as a slot's output, cannot forge work, and refuses
  `portrait:` slots.
  ([`docs/plans/archive/adopting-an-uploaded-asset.md`](docs/plans/archive/adopting-an-uploaded-asset.md),
  [`docs/plans/archive/on-demand-concept-images.md`](docs/plans/archive/on-demand-concept-images.md))
- **Drift reporting.** A prose edit never invalidates art. Drift is reported instead, via
  `Shot.proseHash` with `driftOf` re-derived on every read. A scene's heading is the
  exception: `story.setHeading` re-renders the scene and restages every shot.
- **Line ids.** Line ids are allocated once and persisted, and reading never writes
  (`story.assignLineIds`).
- **Round-trip.** A scene survives a round-trip through text:
  `parse(write(scene)) ≡ scene`. Blank lines are structural, and each scene lives in
  exactly one file, so a writer patches the file the model was built from.
- **Entity discovery.** Entities are found by their meta tag, and each carries the file it
  was found in (`entityFile(docs, id)`). Conflicts produce diagnostics, never a throw.
  ([`docs/plans/archive/entity-discovery-by-meta-tag.md`](docs/plans/archive/entity-discovery-by-meta-tag.md))
- **Bible access.** The story bible is reached only by query. There is no whole-file API,
  which is what guarantees whole documents never enter a context window.
  ([`docs/reference/story-bible.md`](docs/reference/story-bible.md))
- **Refine loop.** P7 generate→critique→refine is folded into the `shot_image` runner,
  capped by `config.max_refine_attempts`. At the cap it flags `needs_human` rather than
  looping.
- **Provider seams.** P1 and P5 have deterministic fallbacks, and the scheduler never
  imports a concrete provider, so backends swap by changing model ids in `project.yaml`.

## CLI

```
vngen run | approve | status | graph | export | cost | import | screenplay   [dir]
```

Flags, `--mock` semantics, key resolution, the on-disk project layout, and the
`templates/basic` walkthrough: [`docs/guides/cli.md`](docs/guides/cli.md). Two things are
worth knowing before running anything. `--mock` writes no assets and needs no keys. In a
real project `vngen/` is committed, because it is the reproducible output of a run rather
than something to gitignore.

## Playable & desktop app

The pipeline is presentation-agnostic and stops at `manifest.json`. `@vn/export` projects
the model and manifest into a small in-house playable (`story.play.json`), and the Electron
app plays it. This is deliberately not an external DSL export.
Format: [`docs/reference/playable-format.md`](docs/reference/playable-format.md). The shell,
the canvas, the sixteen editors, the session store, the seeded workspace, and every
behaviour below in full: [`docs/reference/desktop-app.md`](docs/reference/desktop-app.md).
What persists where: [`docs/reference/desktopAppState.md`](docs/reference/desktopAppState.md).
The document tree, asset naming and `doc.rename`:
[`docs/reference/document-tree.md`](docs/reference/document-tree.md).

- One workspace is open at a time, and opening another tears the first down. Creating a
  workspace scaffolds files where opening does not, in its own dialog, into its own
  repository.
  ([`docs/plans/archive/new-and-open-project.md`](docs/plans/archive/new-and-open-project.md))
- Windows do not own state; one app instance owns the workspace and all of its
  windows. The `window.*` commands plus `view.open(where=window)` manage windows.
  Everything a window remembers is keyed by its index, `ctx.origin` records which window
  issued a command, and a socket lock refuses a second process on the same project.
  ([`docs/plans/multiple-windows.md`](docs/plans/multiple-windows.md))
- Model keys are written to gitignored files and recorded as `<secret>` (`project.setKey`,
  deliberately not undoable), at one of two scopes: this project, or every project on this
  machine. The Setup editor is registered but not listed (`offered: false`, below). It
  renders `docs/guides/api-keys.md` itself rather than a copy, and its only links out of
  the app open a URL taken from a field of that guide, never an arbitrary one.
  ([`docs/plans/archive/onboarding-editor-and-user-level-keys.md`](docs/plans/archive/onboarding-editor-and-user-level-keys.md))
- Layout templates belong to the project and are never git-merged. They live at
  `.vnstudio/layouts/<slug>.json`, marked `-merge`, and a conflicted template is refused by
  name.
  ([`docs/plans/archive/layout-templates-and-the-view-menu.md`](docs/plans/archive/layout-templates-and-the-view-menu.md))
- A conversation is stored as a thread, appended to `vngen/state/threads/<id>.jsonl`, with the
  model's own messages beside it at `<id>.native.jsonl`. A reopened thread is read-only until
  Continue, which is offered when the native log is present and refused by name when the bound
  model could not be sent what it holds. Compacting appends a summary to both logs and rewrites
  neither, and the agent reaches the turns a summary replaced through `search_history` and
  `read_history`.
  ([`docs/plans/archive/conversation-threads.md`](docs/plans/archive/conversation-threads.md),
  [`docs/plans/archive/resumable-threads-and-compaction.md`](docs/plans/archive/resumable-threads-and-compaction.md))
- Turn cost is reported as an event, and it counts API calls rather than turns. A missing
  receipt produces no total (never `0`), and a cache split may arrive marked as an
  estimate.
  ([`docs/plans/archive/gemini-estimated-cache-hit-rate.md`](docs/plans/archive/gemini-estimated-cache-hit-rate.md))
- Every notification is durable, and a single hook files all of them, to
  `vngen/state/notifications.jsonl`. Each line carries its own version because git
  union-merges the file.
  ([`docs/plans/archive/notifications.md`](docs/plans/archive/notifications.md))
- Non-scene documents are written as text, and only by `doc.*`. A conflicting save is
  refused by content, never mtime. `scenes/**` is refused outright, because prose belongs
  to `story.*`.
- A rename rewrites the field the name was read from and never moves the file. An id is
  derived from a name once, at creation, which is why a scene is deliberately not
  renamable.
- Assets are named, the Asset editor shows one, and the tree lists slots rather than
  pictures: one row per slot, with earlier takes folded under the one that replaced them.
  `asset.replace` reads the slot from the asset on screen rather than taking it as an
  argument.
  ([`docs/plans/archive/asset-names-and-the-asset-editor.md`](docs/plans/archive/asset-names-and-the-asset-editor.md))
- One shared widget, `renderAssetStrip`, answers "what was drawn from this document". It is
  shared by Documents, Wiki and Script, and a scene is one more subject for it.
  ([`docs/plans/archive/asset-cross-references.md`](docs/plans/archive/asset-cross-references.md))
- Uploaded documents are archived verbatim and read only by name. `archive/<stamp>-<slug>/`
  is invisible to `search`, the bible, and entity discovery.
  ([`docs/plans/archive/upload-and-archive.md`](docs/plans/archive/upload-and-archive.md))
- A bad conversation is diagnosed on the author's own key, and the fiction's names never
  leave the machine. Redaction is enforced at a code boundary rather than requested in a
  prompt, and nothing is posted automatically. "The debug agent" always means this one: the
  agent Help ▸ Report a Difficult Agent… runs (implemented in `@vn/agentreport`) to read the
  reported thread and draft the issue. `@vn/agentreport` and
  its plans also call it "the analyst"; the two names mean the same agent. It is not
  `vnauthor`, and it is not a debugging tool for this repository. It is a conversation in a
  popup pane rather than one call the app makes: the author answers it, grants source and
  request access part way through, stops a turn after the step it is on, and gets a fresh
  report card each time it revises one. `report.agent` stays as the headless one-shot that
  scripts and the API-fault seam use. The conversation is written down at
  `<userConfigDir>/debug-transcripts/`, ten deep with the oldest pruned as a new one starts,
  and a tool's result is never written there.
  ([`docs/reference/agent-report.md`](docs/reference/agent-report.md))
- Every API request is kept in memory, and its contents never reach the report. A bounded
  ring in `@vn/providers` (64 MB / 64 entries, always on) holds them, so a 400 that names a
  byte position can be read against the body it indexes. `faultKind` distinguishes a fault
  in the request from a dead connection or a bad key, and only the first kind opens the
  report dialog on its own. The analyst reads the ring by pointer, on the author's own key,
  and none of its contents are carried into what is filed.
  ([`docs/plans/archive/diagnosing-an-api-error-from-the-request-that-caused-it.md`](docs/plans/archive/diagnosing-an-api-error-from-the-request-that-caused-it.md))
- The app ships as an installer, and it checks for `git` at runtime rather than bundling
  it. `pnpm package` uses a hoisted scratch install, because pnpm's symlink farm does not
  survive into an app image, and `pnpm smoke` proves the two lazily-imported SDKs resolve
  in the built binary. The installer also carries the app's own source, unpacked at
  `<resourcesPath>/source`, for the debug agent to read; the packaging script copies
  `@vn/agentreport`'s `READABLE` manifest rather than a list of its own, and `pnpm smoke`
  checks that `sourceRoot()` finds it. On a machine without git the app still opens, and
  files a durable note explaining why saving does not work.
  ([`docs/plans/archive/packaging-the-desktop-app.md`](docs/plans/archive/packaging-the-desktop-app.md))
- A VN can be published to the web as a light novel, and the renderer is committed into the
  project. `renderSite` turns the playable into one HTML page per scene, with `choices` and
  `next` as links and no prose rewriting anywhere in the path. Every package here is
  `private: true`, so a CI runner cannot install one: `project.installPages` commits a
  dependency-free bundle of the renderer into the project alongside a workflow that runs it
  with plain `node`. The app commits and never pushes, the workflow force-pushes a
  `gh-pages` branch rather than deploying to Pages directly, and it refuses a branch that
  carries no `.vn-pages` marker. Serving that branch is a repository setting the app can neither
  make nor read, and skipping it fails quietly — the workflow goes green and the address 404s — so
  the confirmation, the notification, `project.pagesStatus` and the authoring agent's built-in
  prompt each name the setting.
  ([`docs/guides/github-pages.md`](docs/guides/github-pages.md))
- Nothing checks for an update until the author asks. Help ▸ Check for Updates… is the only
  trigger (`app.checkForUpdates`; nothing is scheduled and nothing is downloaded), and the
  notice it files links a command from a short allow-list rather than a URL. The app never
  opens an address it was handed, which matters most for a file git union-merges across
  clones.
  ([`docs/plans/archive/in-app-update-checks.md`](docs/plans/archive/in-app-update-checks.md))

The renderer is a path.ux screen mesh: panes subdivide the window, each showing one editor.
There is no React and no room vocabulary. path.ux is a git submodule at `vendor/path.ux`,
so a fresh clone needs `git submodule update --init --recursive` (`pnpm check:setup` reports
this by name). Six rules cause the most mistakes:

- The sixteen editors are named in one place (`apps/desktop/src/shared/editors.ts`), and
  `registerEditor(cls, 'vn.Name')` is the only way to register one, because a hand-written
  name string breaks under minification. That list also carries each editor's `claims`
  predicate, ranked in `renderer/pathux/route.ts`, and a `pins` field for the one selection
  an editor can be pinned to. `pins` is declared once, and `registerEditor` splices in the
  struct fields that persist it.
- `offered: false` makes an editor registered but not listed: reachable by `view.open`, the
  palette, and saved layouts, but absent from the two menus an author browses editors in.
  `OFFERED_EDITOR_IDS` narrows View ▸ Editors. path.ux's `setAreaMenuFilter`, installed
  once by the shell, keeps unoffered editors out of the pane header's own dropdown, which
  path.ux builds from its registry rather than from ours. This is deliberately not
  `AreaFlags.HIDDEN`: hidden describes the editor itself, while not-listed describes this
  application's menus. Three editors carry the flag. Setup will stop being a pane once a
  preferences window exists to hold it, System Prompt exists for inspecting a
  misbehaving turn rather than for day-to-day work, and Debug Agent is somewhere Help sends
  the author rather than somewhere they arrange a window to keep.
- `src/shared/` is in the browser bundle, so everything it imports must be node-free.
  Neither `tsgo` pass catches a violation; only `vite build` does.
- Raw DOM surfaces go in the shadow root via `VnEditor.appendSurface`, each with its own
  sheet via `adoptStyle`. The import order in `styles/index.css` determines the cascade
  order, and `tokens.css` defines the design tokens (no new accent hues).
- Pure logic goes in `.ts` files with a `tests/` sibling, and the editor stays thin
  rendering. The jest desktop project is node-only, so surfaces are verified live over CDP.
- A mid-gesture verdict must match the verdict that would apply on commit, layout changes
  on commit, and an editor with an open text row stops its own keydown events.

## Command system

Every desktop action is a registered command rather than a bespoke IPC channel. A command
has typed properties, a string DSL (`namespace.command(a='x' b=1)`), git-stamped
provenance, and one JSON catalog. Full write-up:
[`docs/reference/command-system.md`](docs/reference/command-system.md).

- `@vn/commands` is the framework. The desktop app owns the commands, in
  `apps/desktop/src/main/commands/`, as thin wrappers over `WorkspaceSession`.
- Commands are the only write path, for scene prose, branch markers and
  `work/shots/<sceneId>.json` alike. `vnauthor` runs the same rules and gets the same
  refusals.
- Props are declarative specs rather than zod, and `coerceProps` is the single validation
  authority. `prop.secret` marks a string that must never be persisted; it is redacted at
  `digestProps`, the one projection every record passes through.
- A mutating command declares its refusal before it runs. `stack.check` answers `accept`,
  `refuse` or `undeclared`, and an `undeclared` answer is not treated as permission.
- The palette, the menu bar, right-click menus and CDP all reach the same registry. The
  agent does not. The agent's tools share the commands' decisions rather than their
  transport: a tool like `edit_scene` calls the same `@vn/scriptedit` rule its `story.*`
  counterpart does, but no tool invokes the registry, and wiring the tool loop through it
  is an unshipped follow-on
  ([`docs/reference/command-system.md`](docs/reference/command-system.md#from-the-agent)).
  A command whose decision has no tool wrapper (`story.decomposeAll`, for one) is therefore
  unreachable to the agent in either host. A right-click entry invokes the registry rather
  than running a bespoke callback: it is checked before it is drawn, and a refusal is shown
  rather than hidden. The palette (finding a command) and the dialog (filling in its props)
  are two hosts of the same `CommandForm` (`openCommandDialog(id, props)`).
  ([`docs/plans/archive/document-tree-context-menus.md`](docs/plans/archive/document-tree-context-menus.md))
- Provenance, undo and commits are each opt-in: `vngen/state/commands.jsonl` for
  provenance; shadow-snapshot undo, which refuses to run rather than guessing when the
  worktree has drifted; and per-repo commit-on-save.
  ([`docs/reference/repos-and-commits.md`](docs/reference/repos-and-commits.md))
- `view.*` commands run in main and push a `command:ui` effect naming an editor, never a
  room. Main answers optimistically, and the mesh returns a correction.
- CDP is opt-in in the app and on by default in the developer launchers, through
  `VN_CDP_PORT` on `127.0.0.1`. `node scripts/vn-cdp.mjs "workspace.index()"`.

## The four satellite areas

- **`vnauthor`** — a plan-first, git-backed authoring agent. Plan mode is read-only, each
  approved plan produces one commit, and edits round-trip through `@vn/model`'s
  serializers. The generated half of its context is a map of what exists, not the content
  itself. The request is shaped for prompt caching, and the native path is the default: a
  byte-stable prefix, four `cache_control` breakpoints, and anything that changes
  mid-conversation appended as a `{"role":"system"}` message rather than edited in place. A
  turn is bounded by a per-turn token ceiling checked between steps rather than by a step
  count. Long documents are changed in part: `edit_file` runs against a per-conversation
  read ledger, `insertLines` covers a run of prose, and the create tools take the edit
  tools' whole field set. `create_skill` and `edit_skill` write a `SKILL.md` and nothing
  else, and both raw writers refuse every other path under `.aiagent/skills/`, so any
  script `run_skill` asks to confirm was put there by a person. The turns a decision hangs
  on (plans, verdicts, shortlists, refused arguments) are recorded in the durable thread,
  which is what `report.agent` reads. The author's own words authorize approval:
  `approve_assets` takes no arguments, a second and smaller model reads what the author
  typed (never text the agent wrote) against the host's list, and the author confirms the
  result.
  [`docs/reference/vnauthor.md`](docs/reference/vnauthor.md),
  [`docs/plans/archive/prompt-caching-and-deferred-tool-loading.md`](docs/plans/archive/prompt-caching-and-deferred-tool-loading.md),
  [`docs/plans/archive/improving-the-authoring-agent.md`](docs/plans/archive/improving-the-authoring-agent.md),
  [`docs/plans/archive/skills-editor-and-agent-authored-skills.md`](docs/plans/archive/skills-editor-and-agent-authored-skills.md).
- **`@vn/bible`** — retrieval over `wiki/`. `query` is budgeted and is the only entry
  point. A missing `wiki/` yields an empty bible, not an error.
  [`docs/reference/story-bible.md`](docs/reference/story-bible.md).
- **`@vn/testkit`** — real projects on disk through the real scheduler with mock providers.
  Nothing may import it, and mock art carries a marker the real backend refuses.
  [`docs/guides/testkit.md`](docs/guides/testkit.md).
- **`@vn/debug2d`** — source-agnostic 2D debugging for the renderer. Zero deps and
  dev-only, so `vite build` drops it. [`docs/guides/debugGuide.md`](docs/guides/debugGuide.md).

## Conventions

- **Secrets.** The `keys/` directory is gitignored (the generated `vngen/` tree is not).
  API key values must never be logged or committed. `project.yaml` records only model ids
  and env-var names. `resolveKeys` throws errors naming the source (env var or file), never
  the value.
- **Key resolution.** A key resolves from four places, and the first answer wins: the env
  var named in `project.yaml`, the project's own `keys/`, the enclosing repo root's
  `keys/`, then the user-level directory. A project carrying its own key therefore wins
  over the machine's, and a set environment variable wins over a file that was just
  written, which explains why the app can keep asking for a key that was just saved.
  ([`docs/guides/api-keys.md`](docs/guides/api-keys.md))
- **User-level state.** User-level state lives in one directory, outside any repo:
  `%LOCALAPPDATA%\vnauthor` on Windows, `~/Library/Application Support/vnauthor` on macOS,
  and `$XDG_CONFIG_HOME/vnauthor` (or `~/.config/vnauthor` when that is unset) on Linux,
  all from `userConfigDir` in `@vn/config`. `$VNAUTHOR_HOME` overrides it, which keeps the
  platform branch testable; jest sets it per worker. A pre-existing `~/.vnauthor` is still
  read when the native directory is absent, but never written. The directory is Local
  rather than Roaming deliberately, because an API key should not follow the user to
  another machine. Any future settings system writes there too, so settings and keys never
  split across two homes.
- **Imports** use explicit `.js` extensions on relative paths (ESM +
  `verbatimModuleSyntax`). jest's `moduleNameMapper` strips them; esbuild and `tsgo`
  resolve them.
- **Validation at the boundary.** Parse files and machine-consumed LLM output through the
  zod schemas in `@vn/types` so malformed data never reaches the deterministic core.
- Keep new packages inside the layering graph above; the boundaries lint rule will reject
  an illegal cross-layer import.

Where plans and research are filed, how docs are kept honest, and the checklist a plan
passes before it counts as finished are all in
[`docs/reference/conventions.md`](docs/reference/conventions.md). The four conventions
below stay here because they are rules you need while the work is happening.

### Comments

- **Comments are plain declarative prose — no epigrams.** State the constraint or decision
  directly: "An empty answer is deliberate and is passed to the model as-is", not "Empty is an
  answer — silence, said out loud." If a sentence needs a second read to parse, rewrite it.
  The same rule applies to this file and the prose in `docs/`. Specific patterns to catch:
  - **Inverted syntax and personification** — the sentence performs rather than informs.
  - **Metaphorical equations** — "The leak scan is the refusal", "what ships is identity",
    "the project as commands". The connector word varies — do not get hung up on "is"
    versus "as". Say what happens instead: "Refuses if the leak scan finds a known name
    still in the body."
  - **Fragment openers that defer the subject** — "The redactor to scan a report with: the one
    that wrote it, else one built from the project as it stands." Lead with a complete sentence
    and name each case as you reach it.
  - **Double negatives** — "the palette cannot be relied on not to". State the positive claim.
  - **Pronouns and ellipses that point outside the sentence** — "the second case", "asking
    twice is how…" — each sentence should carry its own referents.
  - **"Clause A, else B" constructions** — "Resolve a push's destination: the named window
    when it still exists, else the focused window falling back to the most recently focused
    one." Spell out the cases as ordinary sentences instead: "Pushes to the named window if it
    still exists. Otherwise pushes to the focused window, or the most recently focused window
    if none is focused."
  - **Adverbs hung off the end of a noun phrase** — "the next pointerdown anywhere", "the
    handler above". The adverb postmodifies the noun, but the reader cannot tell on first pass
    whether it attaches to the noun or to the clause's verb, and an event or API name coined
    from a verb ("pointerdown") re-parses as a clause when an adverb follows it. Attach the
    qualification to a verb, or state it as its own fact: "the listener is on `window`".
  - **Non-assertive words under a definite** — "any", "anywhere", "ever" range over
    alternatives, so they fight a definite description that names exactly one thing. "A press
    anywhere dismisses it" reads fine; "the next pointerdown anywhere" does not.
  - **Rhetorical emphasis** — `**bold**` and `*italics*` in a comment mark the sentence the
    author found most interesting, not the one the reader needs first. Put the load-bearing
    claim in the first sentence and drop the markup.
  - **A head noun that is not what the code is** — a module of commands documented as "The
    prompt an asset is generated from, as commands" asserts that the module is a prompt, then
    retracts it through a preposition. Lead with the head noun that names the declaration —
    "Commands for the prompt an asset is generated from" — and demote the rest to a
    complement. A trailing ", as X" or ", in the form of X" is the same metaphorical equation
    above smuggled in through an adjunct.
- **Reserve backticks for code symbols.** Backticks belong on identifiers, types, commands,
  and file globs the reader will type. A file path cited as a reference —
  `(docs/plans/archive/chunked-prompts.md §5)` — does not, because marking it up gives it the
  same weight as the identifiers around it and dilutes them.
- **A comment describes the code directly beneath it.** A comment placed above an `if` is read
  as a caption for the branch it guards, so one that explains the opposite case belongs on the
  `else`, or should be reworded to describe the test itself. Misplacing a comment this way is a
  correctness bug, not a style one.
- **Delete commented-out code — never leave it as commentary.** Git history holds it. A
  commented-out call, import or block explains nothing about the code that survives, and it
  goes stale silently because nothing type-checks it.
- **Never restate what the code already says.** `inputs: {}, //tool properties` and
  `case keymap.Escape: //esc` add a maintenance burden and no information. A comment earns its
  place by giving a reason, a constraint, or a consequence.
- **Cite a named constant rather than its value.** A comment saying "thirty seconds" beside
  `LINGER_MS` is wrong the first time the constant changes; write `` `LINGER_MS` ``.
- **Rename instead of commenting a name.** If the sentence's work is translating an
  identifier — what `snapMode` means, what a bare `-1` means — rename the identifier or
  introduce a named constant, then delete the sentence. Comment a name only when the name
  cannot be fixed. Try to avoid names longer than three words or 25 characters
  (10 characters or less is preferred).
- **Comment the consequence, not the arguments.** Options passed at a call site (`capture`,
  `passive`, a flag, a lifetime) are already on screen. Say what the reader cannot see: what
  the call does to everything around it. "Does not inhibit the event from reaching other
  consumers" earns its line; "registered `passive` so it cannot call `preventDefault`" does not.
- **State facts; do not defend the design.** Rationale belongs in a comment only when a reader
  looking at the surrounding code still could not derive it — an ordering constraint, a platform
  quirk, a decision with a live alternative. "Why this is the good version" and "what would go
  wrong under the naive one" are commit-message material.
- **Bracket a subordinate alternative rather than fencing it with commas.** Parentheses mark the
  material as skippable, so the reader gets a complete sentence either way; paired commas leave
  it unclear whether the second comma closes an interpolation or opens a new clause. Write
  "Dropping onto itself (or onto a neighbor it would split against) is not a rip". Drop any comma
  that would follow the closing bracket — it separates the subject from its verb.
- **A doc comment continues its declaration; it does not restate it.** Prefer a noun phrase or a
  bare predicate — "Pointer ids currently down.", "Detected via the presence of multiple pointer
  ids." — to a full sentence that re-supplies the subject the declaration already names. A doc
  comment that reads as a standalone paragraph is usually rationale in disguise.
- **An inline `//` note is a fragment with no terminal period; a `/** … \*/` doc comment is a
  punctuated sentence.\*\* One line each, unless the fact genuinely needs two.
- **Non-doc comments use `//`.** Doc comments use proper `/** … */` brackets. Don't use
  `/* … */` for ordinary inline commentary.
- **Non-doc comments are at most 3 lines.** A longer block comment is allowed sparingly —
  budget roughly one per 500 lines of a file — for genuinely load-bearing context that
  can't be stated in three lines.
- **Doc comments stay reasonably concise.** Say what the thing is and any non-obvious
  contract; don't restate the signature or narrate the implementation.
- **Temporary comments are marked `CLAUDENOTE:`.** Any scratch/working comment Claude
  writes gets that prefix, and all of them must be removed before the final commit of a
  plan (or at the end of the plan, whichever comes first).

### Plans

- A plan is pressure-tested by a fresh-context agent once it is written, before the work
  starts. Hand the finished `docs/plans/<name>.md` to a subagent that has not seen the
  conversation that produced it, and ask it to attack the plan: what does it assume
  without stating, what does it contradict in the code or in `docs/`, what does it leave
  undecided, and what would it cost to undo. The reviewer must be a separate context,
  because the author's context already holds the reasoning the plan is supposed to carry on
  its own, so an agent that helped write the plan cannot tell a stated decision from a
  remembered one.
- The plan is then updated to answer what came back: each finding is either fixed, or
  recorded in the plan with the reason it is wrong. If a review's findings leave no trace
  in the file, treat the review as not done.

### Git history

- `master` is linear. It has no merge commits, and a branch lands by rebasing. Rebase the
  branch onto `master` (`git rebase master`, or `git pull --rebase` where a remote is
  involved), then land it from the master checkout with `git merge --ff-only <branch>`.
  `--ff-only` verifies the rebase happened rather than merely guarding against surprises:
  if it refuses, rebase again rather than falling back to a plain `git merge`. Set
  `pull.rebase true` so a routine pull cannot introduce a merge commit either. A worktree's
  branch lands the same way, with `ExitWorktree` and `action: "keep"` first, because the
  merge must run from the master checkout rather than from inside the worktree.
- Squash a branch that is one idea; keep the stages of a branch that is several. A fix, a
  small feature, a docs pass: one commit, squashed on the way in. A plan implemented in
  reviewable stages keeps those stages, because each is a commit a reader would want to
  land on. The noise made along the way (`wip`, `fix typo`, `address review`, `oops`) is
  always squashed. Fold each into the commit it repairs with `git commit --fixup <sha>`
  while working, then collapse them before landing with
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash master`. It is spelled that way because
  an agent session has no interactive editor, and because a fixup is a note to the rebase
  rather than a commit anyone reads.
- Every commit on `master` is green under `pnpm check`, `pnpm test` and `pnpm lint`, so
  that `git bisect` always lands on a buildable tree and `git log -p <file>` reads as that
  file's history. A stage that only compiles once the next stage arrives belongs in the
  next stage.
- Rewrite only what nobody else has. Rebasing, squashing and `--fixup` are for a branch
  still in hand; once history is published and someone could have pulled it, it is
  append-only.

### Tooltips

- Every interactive UI element carries a tooltip — no exceptions. Buttons, checkboxes,
  text fields, menu and palette entries, tree rows, thumbnails, drag handles, icon-only
  controls: if the author can click, type into, or drag it, it says what it does on
  hover. A control shipped without one is an unfinished control.
- Say what it does, not what it is named. "Leave this clause out of the prompt" beats
  "Mute". Where the label already says everything (a plain `OK`), the tooltip adds the
  consequence instead of repeating the word.
- A disabled control's tooltip states why it refused. When a command declined through
  `stack.check`, show that sentence verbatim — a greyed control that will not say why is
  the same bug as a hidden one.
- Tooltips are set through two mechanisms. A path.ux widget takes `.description`; a raw DOM
  node in an `appendSurface` root takes `.title`. Command-backed controls default to the
  registry's own text (the entry's `title`, a prop's `description`), so a command with a
  vague description is fixed in the definition rather than papered over at the call site. A
  pane tab uses neither mechanism: it is painted on the docker's canvas, so its tooltip
  comes from `define().description`, which `registerEditor` splices in from `EDITORS`'s
  `what` — the same sentence View ▸ Editors shows.

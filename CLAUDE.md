# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository. This file is the map:
what the packages are, what the invariants are, and where each area is written up in full.
Detailed as-shipped documentation lives in [`docs/`](docs) — follow the pointers rather than
duplicating them here.

## What this is

**VN Generator** — a pnpm/TypeScript monorepo that turns authored inputs (characters, a
branching Fountain screenplay, optional locations + reference images) into a **deduped,
resumable pipeline of generated art assets plus a provenance manifest**.

The design separates **deterministic plumbing** (parse, validate, dedupe, layout,
schedule) from **generative steps** (LLM / image-model calls). Package boundaries mirror
that split and are enforced by lint rules, so the input-side packages can be reused
without pulling in the generative pipeline.

- Docs index: [`docs/index.md`](docs/index.md)
- Design: [`docs/history/vn-generator-report.md`](docs/history/vn-generator-report.md)
- Pipeline contracts (the invariants below, in full):
  [`docs/reference/pipeline-contracts.md`](docs/reference/pipeline-contracts.md)
- Debugging guide: [`docs/guides/debugGuide.md`](docs/guides/debugGuide.md) — read this before debugging
  anything in this repo; tools ordered cheapest-first, evidence over reproduction
- **Out of scope:** _external_ engine export (Ren'Py/Ink/etc.). The generative pipeline core
  stops at a populated `build/` + `manifest.json`. On top of that sit a small in-house
  **playable** (`vngen export` → `story.play.json`) and a **desktop runner** for actually
  watching a generated VN.

Alongside the pipeline is **`vnauthor`**, a plan-first conversational agent that helps an
author write and refine the _inputs_ (characters, screenplay, locations). It lives entirely
on the input side; a boundaries lint rule forbids it from importing the generative pipeline.

## Setup

A fresh clone needs four steps, in this order:

```bash
git submodule update --init --recursive   # vendor/path.ux, and the one it carries
pnpm install                              # Node >= 20, pnpm 10 (see packageManager)
pnpm --dir vendor/path.ux install         # path.ux has its own lockfile; the root install skips it
pnpm doctor                               # fails by name if either of the two is still owed
```

The renderer compiles path.ux from source through a vite alias, so a missing submodule
surfaces as an unresolvable import far from its cause; `pnpm doctor`
(`scripts/check-submodules.mjs`, also the desktop build's first step) names the fix directly.
**A checked-out submodule is not an installed one:** path.ux is its own project with its own
lockfile, and it is not a pnpm workspace member, so the root install does not install its
dependencies. That step is easy to forget for anyone who has built path.ux before, because
their `node_modules` is already on disk. On a clean checkout the symptom is scores of "has no
exported member" errors _inside_ `vendor/`, which name a symbol rather than the missing
install. `pnpm doctor` also fails on this by name.
Then `pnpm check && pnpm test && pnpm lint` should be green; `pnpm build` bundles everything.
Details: [`docs/guides/toolchain.md`](docs/guides/toolchain.md), and
[`docs/reference/desktop-app.md`](docs/reference/desktop-app.md) for the submodule's role.

## Commands

Run from the repo root.

| Task                         | Command                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Typecheck (the gate)         | `pnpm check`                                                            |
| Test (all)                   | `pnpm test`                                                             |
| Test one package             | `pnpm exec jest --selectProjects @vn/taskgraph`                         |
| Lint (eslint + format check) | `pnpm lint`                                                             |
| Auto-format                  | `pnpm format`                                                           |
| Update docs TOCs             | `pnpm markdown-toc` (skips `docs/plans/**`)                             |
| Check doc links              | `pnpm check:doclinks` (relative links + anchors; part of `pnpm lint`)   |
| Bundle everything            | `pnpm build` (turbo: `vngen`, `vnauthor`, and the desktop app)          |
| Run the CLI                  | `node apps/cli/dist/cli.js <cmd>` (or `pnpm vngen <cmd>`)               |
| Run the authoring agent      | `node apps/authoring/dist/vnauthor.js [dir]` (or `pnpm vnauthor [dir]`) |
| Run the desktop app          | `pnpm vndesktop [--mock]` (built app, CDP on 9222)                      |
| Package the desktop app      | `pnpm package` (installer) / `pnpm package:dir` (unpacked)              |
| Smoke-test the packaged app  | `pnpm smoke` (runs the built binary; proves both SDKs resolve)          |
| Check the key-guide links    | `pnpm check:keylinks` (blocking in CI; `docs/guides/api-keys.md` only)  |
| Audit the key-guide wording  | `pnpm audit:keydocs [--dry-run]` (weekly, advisory, needs a key)        |

`pnpm check`, `pnpm test`, and `pnpm lint` should all be green before and after any change.

The toolchain's shape — and every deliberate deviation from the original plan — is documented
in [`docs/guides/toolchain.md`](docs/guides/toolchain.md). Four things cause enough mistakes
to repeat here:

- `pnpm check` is **two** passes: the flat workspace check plus `pnpm check:renderer`, because
  `apps/desktop/renderer/**` lives outside `src/` and nothing else typechecks it.
- **Tests must live in a `tests/` subfolder** beside the code they cover; a `*.test.ts`
  anywhere else is silently never run.
- Internal packages are **source-only** (no per-package `dist`) — consumers import
  `src/index.ts` directly. esbuild transpiles; only `tsgo` type-checks.
- Imports use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).

## Architecture

### Package layering

Acyclic, enforced by `eslint-plugin-boundaries` + `import/no-cycle`. What each package is
responsible for, and the rules behind this diagram, are in
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

- **The pipeline spine and the authoring branch are disjoint below `@vn/store`** —
  `@vn/authoring` reuses the input-side packages but **must never import `@vn/pipeline` or
  `@vn/scheduler`**. The boundaries rule checks each import statement, not the transitive
  closure, so routing a forbidden import through an allowed leaf package still violates the
  design and must not be done.
- **Five leaves share that constrained allow-list.** `@vn/export`, `@vn/scriptedit`, `@vn/bible`
  and `@vn/artgen` are leaves because two hosts (the desktop app and `vnauthor`) must run the
  same rules, so the rules cannot live in either host. `@vn/agentreport` is a leaf because its
  one host is the desktop app; it additionally imports `@vn/commands` for the command records
  that transcripts do not contain.
- **Two packages sit outside the graph.** `@vn/debug2d` imports nothing from `packages/` and is
  dev-only in the renderer; `@vn/testkit` may import every layer and **nothing may import it**.

### Core ideas

Each bullet names a contract; breaking one costs money or corrupts provenance. **Nearly every
one is stated in full — with the failure it prevents — in
[`docs/reference/pipeline-contracts.md`](docs/reference/pipeline-contracts.md); read that, or the
plan a bullet links, before changing any of them.** These lines tell you a contract exists;
they are not enough to act on.

- **Content-addressed task graph.** Task identity is `sha256(kind, inputs)`; replaying
  `state/tasks.jsonl` rebuilds the graph, which is what makes a run resumable.
- **Content-addressed asset store, in two roots** — base art at `assets/`, shot frames at
  `vngen/build/assets/`. ([`docs/reference/asset-stores.md`](docs/reference/asset-stores.md))
- **Gate-as-barrier.** The P3 character-approval gate is a planner predicate, not a task
  dependency: while the gate is closed, a run halts with no tasks ready.
- **Authoring a character sheet earns a portrait and a plate; a model sheet is only planned
  once a scene casts the character.**
  ([`docs/plans/archive/drawing-a-character-before-a-scene-casts-them.md`](docs/plans/archive/drawing-a-character-before-a-scene-casts-them.md))
- **Incremental planning.** The planner runs once per wave, so `vngen cost` undercounts work
  that a later wave will unlock.
- **The graph is a graph of slots, not of task hashes** (`portrait:`/`sheet:`/`plate:`/
  `shot:`, edges by `refsOfSlot`), and **approval propagates upstream first** —
  `assetApproved`, `assetPrereqs`, `prereqRefusal`, with the refusal sentence kept identical
  in all three places.
  ([`docs/plans/archive/the-full-slot-graph-and-approving-upstream-first.md`](docs/plans/archive/the-full-slot-graph-and-approving-upstream-first.md))
- **Decomposing a scene is an explicit act, and a fallback is never persisted.** A missing
  `work/shots/<sceneId>.json` is the only signal meaning "decompose this scene"; placing a
  first shot by hand writes that file and ends decomposition the same way. A storyboard, once
  written, is never regenerated automatically, and **a shot's order is determined by where its
  lines sit**.
  ([`docs/plans/creating-shots-by-hand-and-by-agent.md`](docs/plans/creating-shots-by-hand-and-by-agent.md))
- **A terminal task records why it failed, is retried once, and is reported from the live plan.**
- **Outfits are inherited** — `outfitFor` resolves shot override → the scene's `[[outfit:]]`
  marker → `character.defaultOutfit`. Unlike other scene edits, changing an outfit **does**
  re-render.
  ([`docs/plans/archive/outfits-at-scene-and-shot-level.md`](docs/plans/archive/outfits-at-scene-and-shot-level.md))
- **Art direction is an authored field, and changing it deliberately re-renders** — `artNotes`
  is free text at five rungs, **appended** to the derived prompt; the agent reaches the same
  rungs and gets the same refusals. **The image seed rides the same rungs** and is resolved
  only in `seedFor`; zero is a valid seed, so every presence test is `=== undefined`.
  ([`docs/plans/archive/asset-names-and-the-asset-editor.md`](docs/plans/archive/asset-names-and-the-asset-editor.md),
  [`docs/plans/archive/agent-art-revision.md`](docs/plans/archive/agent-art-revision.md))
- **A concept image sits outside the pipeline** — never planned, consumed, exported, or
  `accepted`. Its prompt is authored rather than derived, so it is the one prompt an author
  may edit.
- **Adoption is the only `done` record written outside the scheduler** — `adoptSlot` records
  arbitrary bytes as a slot's output; it cannot forge work, and it refuses `portrait:` slots.
  ([`docs/plans/archive/adopting-an-uploaded-asset.md`](docs/plans/archive/adopting-an-uploaded-asset.md),
  [`docs/plans/archive/on-demand-concept-images.md`](docs/plans/archive/on-demand-concept-images.md))
- **No _prose_ edit invalidates art; drift is reported instead** — `Shot.proseHash`, with
  `driftOf` re-derived on every read. **The exception is a scene's heading**:
  `story.setHeading` re-renders the scene and restages every shot.
- **Line ids are allocated once and persisted, and reading never writes**
  (`story.assignLineIds`).
- **A scene survives a round-trip through text: `parse(write(scene)) ≡ scene`.** Blank lines
  are structural, and each scene lives in exactly one file — a writer patches the file the
  model was built from.
- **Entities are found by their meta tag, and each carries the file it was found in** —
  `entityFile(docs, id)`; conflicts produce diagnostics, never a throw.
  ([`docs/plans/archive/entity-discovery-by-meta-tag.md`](docs/plans/archive/entity-discovery-by-meta-tag.md))
- **The story bible is reached only by query** — there is no whole-file API, and that absence
  is what guarantees whole documents never enter a context window.
  ([`docs/reference/story-bible.md`](docs/reference/story-bible.md))
- **P7 generate→critique→refine is folded into the `shot_image` runner**, capped by
  `config.max_refine_attempts`; at the cap it flags `needs_human` rather than looping.
- **Deterministic fallbacks** in P1/P5, and **provider seams** — the scheduler never imports a
  concrete provider, so backends swap by changing model ids in `project.yaml`.

## CLI

```
vngen run | approve | status | graph | export | cost | import | screenplay   [dir]
```

Flags, `--mock` semantics, key resolution, the on-disk project layout, and the
`templates/basic` walkthrough: [`docs/guides/cli.md`](docs/guides/cli.md). Two things worth
knowing before running anything: `--mock` writes no assets and needs no keys, and in a real
project `vngen/` is **committed** — it is the reproducible output of a run, not something to
gitignore.

## Playable & desktop app

The pipeline is presentation-agnostic — it stops at `manifest.json`. `@vn/export` projects the
model + manifest into a small in-house **playable** (`story.play.json`), and the Electron app
plays it. This is deliberately **not** an external DSL export.
Format: [`docs/reference/playable-format.md`](docs/reference/playable-format.md). The app — shell, canvas, the fifteen
editors, the session store, the seeded workspace, and every behaviour below in full:
[`docs/reference/desktop-app.md`](docs/reference/desktop-app.md); what persists where:
[`docs/reference/desktopAppState.md`](docs/reference/desktopAppState.md); the document tree, asset naming and
`doc.rename`: [`docs/reference/document-tree.md`](docs/reference/document-tree.md).

- **One workspace is open at a time, and opening another tears the first down. Creating a
  workspace scaffolds files where opening does not**, in its own dialog, into its own
  repository. ([`docs/plans/archive/new-and-open-project.md`](docs/plans/archive/new-and-open-project.md))
- **A window is a renderer, not an app instance, and one app instance owns a workspace** —
  the `window.*` commands plus `view.open(where=window)`; everything a window remembers is
  keyed by its index; `ctx.origin` records which window issued a command; and a socket lock
  refuses a second process on the same project.
  ([`docs/plans/multiple-windows.md`](docs/plans/multiple-windows.md))
- **Model keys are written to files git cannot see and recorded as `<secret>`**
  (`project.setKey`, deliberately not undoable), at one of two scopes: this project, or every
  project on this machine. **The Setup editor is named but not listed** (`offered: false`,
  below): it renders `docs/guides/api-keys.md` itself rather than a copy, and its only links
  out of the app open a URL taken from a _field_ of that guide, never an arbitrary one.
  ([`docs/plans/archive/onboarding-editor-and-user-level-keys.md`](docs/plans/archive/onboarding-editor-and-user-level-keys.md))
- **Layout templates belong to the project and are never git-merged** —
  `.vnstudio/layouts/<slug>.json`, marked `-merge`; a conflicted template is refused by name.
  ([`docs/plans/archive/layout-templates-and-the-view-menu.md`](docs/plans/archive/layout-templates-and-the-view-menu.md))
- **A conversation is a thread**, appended to `vngen/state/threads/<id>.jsonl`; a reopened
  thread is read-only. ([`docs/plans/archive/conversation-threads.md`](docs/plans/archive/conversation-threads.md))
- **Turn cost travels as an event and counts API calls, not turns.** No receipt means
  **no total** — never `0` — and a cache split may arrive marked as an estimate.
  ([`docs/plans/archive/gemini-estimated-cache-hit-rate.md`](docs/plans/archive/gemini-estimated-cache-hit-rate.md))
- **Every notification is durable, and one hook files them all** —
  `vngen/state/notifications.jsonl`, versioned per line because git union-merges the file.
  ([`docs/plans/archive/notifications.md`](docs/plans/archive/notifications.md))
- **Non-scene documents are written as text, and only by `doc.*`.** A conflicting save is
  refused by **content**, never mtime; `scenes/**` is refused outright, because prose belongs
  to `story.*`.
- **A rename rewrites the field the name was read from and never moves the file.** An id is
  derived from a name once, at creation, which is why a scene is deliberately not renamable.
- **Assets are named, one pane answers for each, and the tree lists slots rather than
  pictures** — one row per slot, with earlier takes folded under the one that replaced them;
  `asset.replace` reads the slot from the asset on screen rather than taking it as an argument.
  ([`docs/plans/archive/asset-names-and-the-asset-editor.md`](docs/plans/archive/asset-names-and-the-asset-editor.md))
- **"What was drawn from this document" is one shared widget, and a scene is a subject like
  any other** — `renderAssetStrip`, shared by Documents, Wiki and Script.
  ([`docs/plans/archive/asset-cross-references.md`](docs/plans/archive/asset-cross-references.md))
- **Uploaded documents are archived verbatim and read only by name** — `archive/<stamp>-<slug>/`
  is invisible to `search`, the bible, and entity discovery.
  ([`docs/plans/archive/upload-and-archive.md`](docs/plans/archive/upload-and-archive.md))
- **A bad conversation is diagnosed on the author's own key, and the fiction's names never
  leave the machine** — redaction is enforced at a boundary, not requested in a prompt, and
  nothing is posted automatically.
  ([`docs/reference/agent-report.md`](docs/reference/agent-report.md))
- **Every API request is kept in memory, and its contents never reach the report** — a bounded
  ring in `@vn/providers` (64 MB / 64 entries, always on), so a 400 that names a byte position
  can be read against the body it indexes. `faultKind` distinguishes a fault in the request
  from a dead connection or a bad key, and only the first kind opens the report dialog on its
  own. The analyst reads the ring by pointer, on the author's own key; none of its contents
  are carried into what is filed.
  ([`docs/plans/archive/diagnosing-an-api-error-from-the-request-that-caused-it.md`](docs/plans/archive/diagnosing-an-api-error-from-the-request-that-caused-it.md))
- **The app ships as an installer, and `git` is a runtime dependency it checks for rather than
  bundles** — `pnpm package` uses a hoisted scratch install (pnpm's symlink farm does not
  survive into an app image), and `pnpm smoke` proves the two lazily-imported SDKs resolve in
  the built binary. On a machine without git the app still **opens**, and files a durable note
  explaining why saving does not work.
  ([`docs/plans/archive/packaging-the-desktop-app.md`](docs/plans/archive/packaging-the-desktop-app.md))
- **A VN publishes to the web as a light novel, and the renderer travels with the project** —
  `renderSite` turns the playable into one HTML page per scene, with `choices` and `next` as
  links and no prose rewriting anywhere in the path. Every package here is `private: true`, so a
  CI runner cannot install one: `project.installPages` commits a dependency-free bundle of the
  renderer into the project alongside a workflow that runs it with plain `node`. **The app
  commits and never pushes**, the workflow force-pushes a `gh-pages` branch rather than deploying
  to Pages directly, and it refuses a branch that carries no `.vn-pages` marker.
  ([`docs/guides/github-pages.md`](docs/guides/github-pages.md))
- **Nothing checks for an update until asked, and an update notice links a command, not a
  URL.** Help ▸ Check for Updates… is the only trigger (`app.checkForUpdates`; nothing is
  scheduled and nothing is downloaded), and the notice it files links a **command** from a
  short allow-list rather than a URL — the rule that the app never opens an address it was
  handed matters most for a file git union-merges across clones.
  ([`docs/plans/archive/in-app-update-checks.md`](docs/plans/archive/in-app-update-checks.md))

The renderer is a **path.ux screen mesh** — panes subdivide the window, each showing one editor;
no React, no room vocabulary. path.ux is a git submodule at `vendor/path.ux`, so a fresh clone
needs `git submodule update --init --recursive` (`pnpm doctor` reports this by name). Six rules
cause the most mistakes:

- **The fifteen editors are named in one place** (`apps/desktop/src/shared/editors.ts`), and
  **`registerEditor(cls, 'vn.Name')`** is the only way to register one — a hand-written name
  string breaks under minification. That list also carries each editor's `claims` predicate,
  ranked in `renderer/pathux/route.ts`, and a `pins` field for the one selection an editor can
  be **pinned** to — declared once; `registerEditor` splices in the struct fields that persist
  it.
- **`offered: false` means named but not listed** — reachable by `view.open`, the palette, and
  saved layouts, but absent from the two menus an author _browses_ editors in.
  `OFFERED_EDITOR_IDS` narrows View ▸ Editors; path.ux's **`setAreaMenuFilter`**, installed
  once by the shell, keeps unoffered editors out of the pane header's own dropdown, which
  path.ux builds from its registry rather than from ours. This is deliberately not
  `AreaFlags.HIDDEN`: hidden is a property of the editor, not-listed is a property of this
  application. Two editors carry the flag: Setup, which stops being a pane at all once a
  preferences window exists to hold it, and System Prompt, which is a place to look when a
  turn misbehaves rather than a place to work.
- **`src/shared/` is in the browser bundle**, so everything it imports must be node-free;
  neither `tsgo` pass catches a violation — only `vite build` does.
- **Raw DOM surfaces go in the shadow root via `VnEditor.appendSurface`**, each with its own
  sheet via `adoptStyle`; the import order in `styles/index.css` IS the cascade order, and
  `tokens.css` is the design contract (no new accent hues).
- **Pure logic goes in `.ts` files with a `tests/` sibling; the editor stays thin rendering.**
  The jest desktop project is node-only, so surfaces are verified live over CDP.
- **A mid-gesture verdict must match the verdict that would apply on commit**; layout changes
  on commit; and **an editor with an open text row stops its own keydown events**.

## Command system

Every desktop action is a **registered command** rather than a bespoke IPC channel: typed
properties, a string DSL (`namespace.command(a='x' b=1)`), git-stamped provenance, one JSON
catalog. Full write-up: [`docs/reference/command-system.md`](docs/reference/command-system.md).

- **`@vn/commands` is the framework; the desktop app owns the commands**, in
  `apps/desktop/src/main/commands/` as thin wrappers over `WorkspaceSession`.
- **Commands are the only write path** — for scene prose, branch markers and
  `work/shots/<sceneId>.json` alike. `vnauthor` runs the same rules and gets the same refusals.
- **Props are declarative specs, not zod**; `coerceProps` is the single validation authority,
  and **`prop.secret` marks a string that must never be persisted** — it is redacted at
  `digestProps`, the one projection every record passes through.
- **A mutating command declares its refusal before it runs** — `stack.check` answers `accept` |
  `refuse` | `undeclared`, and the absence of a check is not permission.
- **The palette, the menu bar, right-click menus and CDP all reach the same registry — the
  agent does not.** The agent's tools share the commands' **decisions**, never their transport:
  a tool like `edit_scene` calls the same `@vn/scriptedit` rule its `story.*` counterpart does,
  but no tool invokes the registry, and wiring the tool loop through it is an unshipped
  follow-on ([`docs/reference/command-system.md`](docs/reference/command-system.md#from-the-agent)).
  A command whose decision has no tool wrapper — `story.decomposeAll`, for one — is therefore
  unreachable to the agent in either host. A right-click entry is an _invocation_, never a
  callback: it is checked before it is drawn, and a refusal is **shown** rather than hidden.
  Finding a command and filling in its props are two hosts over one `CommandForm`
  (`openCommandDialog(id, props)`).
  ([`docs/plans/archive/document-tree-context-menus.md`](docs/plans/archive/document-tree-context-menus.md))
- **Provenance, undo and commits are each opt-in** — `vngen/state/commands.jsonl`;
  shadow-snapshot undo that **refuses rather than guesses** when the worktree has drifted; and
  per-repo commit-on-save.
  ([`docs/reference/repos-and-commits.md`](docs/reference/repos-and-commits.md))
- **`view.*` commands run in main** and push a `command:ui` effect naming an **editor**, never
  a room; main answers optimistically and the mesh returns a correction.
- **CDP is opt-in in the app and on by default in the developer launchers** — `VN_CDP_PORT`,
  `127.0.0.1`. `node scripts/vn-cdp.mjs "workspace.index()"`.

## The four satellite areas

- **`vnauthor`** — a plan-first, git-backed authoring agent: plan mode is read-only, each
  approved plan produces one commit, edits round-trip through `@vn/model`'s serializers, and
  the generated half of its context is a **map, not content**. **The request is a conversation
  shaped for caching, and the native path is the default** — a byte-stable prefix, four
  `cache_control` breakpoints, and anything that changes mid-conversation is **appended as a
  `{"role":"system"}` message** rather than edited in place. **A turn is bounded by what it
  spends** — a per-turn token ceiling checked between steps, not a step count — and **long
  documents are changed in part**: `edit_file` runs against a per-conversation read ledger,
  `insertLines` covers a run of prose, and the create tools take the edit tools' whole field
  set. **A skill the agent writes is prose** — `create_skill`/`edit_skill` write a `SKILL.md`,
  and both raw writers refuse every other path under `.aiagent/skills/`, so any script
  `run_skill` asks to confirm was put there by a person. The turns a decision hangs on —
  plans, verdicts, shortlists, refused arguments — are recorded in the durable thread, which
  is what `report.agent` reads.
  **Approval is authorized by the author's own words**: `approve_assets` takes no arguments; a
  second, smaller model reads what the author typed — never text the agent wrote — against the
  host's list, and the author confirms the result.
  [`docs/reference/vnauthor.md`](docs/reference/vnauthor.md),
  [`docs/plans/archive/prompt-caching-and-deferred-tool-loading.md`](docs/plans/archive/prompt-caching-and-deferred-tool-loading.md),
  [`docs/plans/archive/improving-the-authoring-agent.md`](docs/plans/archive/improving-the-authoring-agent.md),
  [`docs/plans/archive/skills-editor-and-agent-authored-skills.md`](docs/plans/archive/skills-editor-and-agent-authored-skills.md).
- **`@vn/bible`** — retrieval over `wiki/`. `query` is budgeted and is the only entry point; a
  missing `wiki/` is an empty bible, not an error.
  [`docs/reference/story-bible.md`](docs/reference/story-bible.md).
- **`@vn/testkit`** — real projects on disk through the real scheduler with mock providers.
  Nothing may import it, and mock art is **marked** art the real backend refuses.
  [`docs/guides/testkit.md`](docs/guides/testkit.md).
- **`@vn/debug2d`** — source-agnostic 2D debugging for the renderer. Zero deps and dev-only, so
  `vite build` drops it. [`docs/guides/debugGuide.md`](docs/guides/debugGuide.md).

## Conventions

- **Secrets.** The `keys/` directory is gitignored (the generated `vngen/` tree is not). API
  key _values_ must never be logged or committed. `project.yaml` records only model ids and
  env-var names.
  `resolveKeys` throws errors naming the _source_ (env var / file), never the value.
- **A key resolves from four places, and the first answer wins** — the env var named in
  `project.yaml`, the project's own `keys/`, the enclosing repo root's `keys/`, then the
  user-level directory. A project carrying its own key therefore wins over the machine's, and
  a set environment variable wins over a file that was just written — which answers "why is it
  still asking me". ([`docs/guides/api-keys.md`](docs/guides/api-keys.md))
- **User-level state lives in one directory, outside any repo** — `%LOCALAPPDATA%\vnauthor`
  on Windows, `~/Library/Application Support/vnauthor` on macOS, `$XDG_CONFIG_HOME/vnauthor`
  (else `~/.config/vnauthor`) on Linux, all from `userConfigDir` in `@vn/config`.
  `$VNAUTHOR_HOME` overrides it — that override keeps the platform branch testable, and jest
  sets it per worker. A pre-existing `~/.vnauthor` is still _read_ when the native directory is
  absent, but never written. The directory is Local rather than Roaming deliberately: an API
  key should not follow the user to another machine. **Any future settings system writes there
  too**, so settings and keys never split across two homes.
- **Imports** use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).
  jest's `moduleNameMapper` strips them; esbuild and `tsgo` resolve them.
- **Validation at the boundary.** Parse files and machine-consumed LLM output through the
  zod schemas in `@vn/types` so malformed data never reaches the deterministic core.
- Keep new packages inside the layering graph above; the boundaries lint rule will reject
  an illegal cross-layer import.

**Where plans and research are filed, how docs are kept honest, and the checklist a plan passes
before it counts as finished: [`docs/reference/conventions.md`](docs/reference/conventions.md).** The
four conventions below stay here because they are rules you need while the work is happening.

### Comments

- **Comments are plain declarative prose — no epigrams.** State the constraint or decision
  directly: "An empty answer is deliberate and is passed to the model as-is", not "Empty is an
  answer — silence, said out loud." If a sentence needs a second read to parse, rewrite it.
  The same rule applies to this file and the prose in `docs/`. Specific patterns to catch:
  - **Inverted syntax and personification** — the sentence performs rather than informs.
  - **Metaphorical equations** — "The leak scan is the refusal", "what ships is identity".
    Say what happens instead: "Refuses if the leak scan finds a known name still in the body."
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
- **A comment that explains a name is a renaming request.** If the sentence's work is
  translating an identifier — what `snapMode` means, what a bare `-1` means — rename the
  identifier or introduce a named constant, then delete the sentence. Comment a name only when
  the name cannot be fixed. Try to avoid names longer then three words or 25 characters
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

- **A plan is pressure-tested by a fresh-context agent once it is written, before the work
  starts.** Hand the finished `docs/plans/<name>.md` to a subagent that has not seen the
  conversation that produced it, and ask it to attack the plan: what does it assume without
  stating, what does it contradict in the code or in `docs/`, what does it leave undecided,
  and what would it cost to undo. The reviewer must be a _separate_ context — the author's
  context already holds the reasoning the plan is supposed to carry on its own, so an agent
  that helped write the plan cannot tell a stated decision from a remembered one.
- **The plan is then updated to answer what came back** — each finding is either fixed, or
  recorded in the plan with the reason it is wrong. A review whose findings leave no trace in
  the file did not happen.

### Git history

- **`master` is linear — it has no merge commits, and a branch lands by rebasing.** Rebase the
  branch onto `master` (`git rebase master`, or `git pull --rebase` where a remote is
  involved), then land it from the master checkout with `git merge --ff-only <branch>`.
  `--ff-only` is the check, not a precaution: if it refuses, the rebase was not done — rebase
  again rather than falling back to a plain `git merge`. Set `pull.rebase true` so a routine
  pull cannot introduce a merge commit either. A worktree's branch lands the same way —
  `ExitWorktree` with `action: "keep"` first, because a worktree cannot merge itself.
- **Squash a branch that is one idea; keep the stages of a branch that is several.** A fix, a
  small feature, a docs pass: one commit, squashed on the way in. A plan implemented in
  reviewable stages keeps those stages, because each is a commit a reader would want to land
  on. What is _always_ squashed is the noise made along the way — `wip`, `fix typo`,
  `address review`, `oops`. Fold each into the commit it repairs with `git commit --fixup <sha>`
  while working, then collapse them before landing with
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash master` — spelled that way because an agent
  session has no interactive editor, and because a fixup is a note to the rebase rather than a
  commit anyone reads.
- **Every commit on `master` is green** — `pnpm check`, `pnpm test`, `pnpm lint` — because a
  linear history's payoff is that `git bisect` always lands on a buildable tree and
  `git log -p <file>` reads as that file's story. A stage that only compiles once the next
  stage arrives belongs in the next stage.
- **Rewrite only what nobody else has.** Rebasing, squashing and `--fixup` are for a branch
  still in hand; once history is published and someone could have pulled it, it is append-only.

### Tooltips

- **Every interactive UI element carries a tooltip — no exceptions.** Buttons, checkboxes,
  text fields, menu and palette entries, tree rows, thumbnails, drag handles, icon-only
  controls: if the author can click, type into, or drag it, it says what it does on hover.
  A control shipped without one is an unfinished control.
- **Say what it does, not what it is named.** "Leave this clause out of the prompt" beats
  "Mute". Where the label already says everything (a plain `OK`), the tooltip adds the
  consequence instead of repeating the word.
- **A disabled control's tooltip is its refusal.** When a command declined through
  `stack.check`, show that sentence verbatim — a greyed control that will not say why is the
  same bug as a hidden one.
- **Two mechanisms, one rule.** A path.ux widget takes `.description`; a raw DOM node in an
  `appendSurface` root takes `.title`. Command-backed controls default to the registry's own
  text (the entry's `title`, a prop's `description`), so a command with a vague description is
  fixed in the definition rather than papered over at the call site. **A pane tab is neither
  mechanism**: it is painted on the docker's canvas, so its tooltip comes from
  `define().description`, which `registerEditor` splices in from `EDITORS`'s `what` — the same
  sentence View ▸ Editors shows.

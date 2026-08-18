# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository. This file is the map:
what the packages are, what the invariants are, and where the full write-up of each area
lives. Deep as-shipped detail is in [`docs/`](docs) — follow the pointers rather than
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
- Design: [`docs/vn-generator-report.md`](docs/vn-generator-report.md)
- Pipeline contracts (the invariants below, in full):
  [`docs/pipeline-contracts.md`](docs/pipeline-contracts.md)
- Debugging guide: [`docs/debugGuide.md`](docs/debugGuide.md) — read this before debugging
  anything in this repo; tools ordered cheapest-first, evidence over reproduction
- **Out of scope:** _external_ engine export (Ren'Py/Ink/etc.). The generative pipeline core
  stops at a populated `build/` + `manifest.json`. On top of that sits a small, in-house
  **playable** (`vngen export` → `story.play.json`) and a **desktop runner** to actually
  watch a generated VN.

Alongside the pipeline is **`vnauthor`**, a plan-first conversational agent that helps an
author write and refine the _inputs_ (characters, screenplay, locations). It lives entirely
on the input side and is forbidden — by a boundaries lint rule — from importing the
generative pipeline.

## Setup

A fresh clone needs three steps, in this order:

```bash
git submodule update --init --recursive   # vendor/path.ux, and the one it carries
pnpm install                              # Node >= 20, pnpm 10 (see packageManager)
pnpm doctor                               # fails by name if a submodule is still missing
```

The renderer compiles path.ux from source through a vite alias, so a missing submodule
surfaces as an unresolvable import a long way from its cause — `pnpm doctor`
(`scripts/check-submodules.mjs`, also the desktop build's first step) names the fix instead.
Then `pnpm check && pnpm test && pnpm lint` should be green; `pnpm build` bundles everything.
Details: [`docs/toolchain.md`](docs/toolchain.md), and
[`docs/desktop-app.md`](docs/desktop-app.md) for the submodule's role.

## Commands

Run from the repo root.

| Task                         | Command                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Typecheck (the gate)         | `pnpm check`                                                            |
| Test (all)                   | `pnpm test`                                                             |
| Test one package             | `pnpm exec jest --selectProjects @vn/taskgraph`                         |
| Lint (eslint + format check) | `pnpm lint`                                                             |
| Auto-format                  | `pnpm format`                                                           |
| Update docs TOCs             | `pnpm markdown-toc` (skips `docs/plans/*.md`)                           |
| Bundle everything            | `pnpm build` (turbo: `vngen`, `vnauthor`, and the desktop app)          |
| Run the CLI                  | `node apps/cli/dist/cli.js <cmd>` (or `pnpm vngen <cmd>`)               |
| Run the authoring agent      | `node apps/authoring/dist/vnauthor.js [dir]` (or `pnpm vnauthor [dir]`) |
| Run the desktop app          | `pnpm vndesktop [--mock]` (built app, CDP on 9222)                      |

`pnpm check`, `pnpm test`, and `pnpm lint` should all be green before and after any change.

The toolchain's shape — and every deliberate deviation from the original plan — is
[`docs/toolchain.md`](docs/toolchain.md). Four things bite often enough to repeat here:

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
[`docs/packages.md`](docs/packages.md).

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
  `@vn/scheduler`**, and **the boundaries rule is per import statement, not transitive**, so
  reaching the pipeline through a leaf is not a loophole.
- **Five leaves share that constrained allow-list** — `@vn/export`, `@vn/scriptedit`, `@vn/bible`
  and `@vn/artgen` because two hosts (the desktop app and `vnauthor`) must run the same rules, so
  the rules can live in neither; `@vn/agentreport` because its one host is the desktop app, and it
  additionally reaches `@vn/commands` for the acting record a transcript lacks.
- **Two packages sit outside the graph.** `@vn/debug2d` imports nothing from `packages/` and is
  dev-only in the renderer; `@vn/testkit` may import every layer and **nothing may import it**.

### Core ideas

Each is a contract that costs money or corrupts provenance when broken. **Nearly every one below
is stated in full — with the failure it prevents — in
[`docs/pipeline-contracts.md`](docs/pipeline-contracts.md); read that, or the plan a bullet links
instead, before changing any of them.** These lines exist so you know a contract is there, not so
you can act on it.

- **Content-addressed task graph.** Identity is `sha256(kind, inputs)`; replaying
  `state/tasks.jsonl` rebuilds the graph, which is what makes a run resumable.
- **Content-addressed asset store, in two roots** — base art at `assets/`, shot frames at
  `vngen/build/assets/`. ([`docs/asset-stores.md`](docs/asset-stores.md))
- **Gate-as-barrier.** The P3 character-approval gate is a planner predicate, not a task
  dependency: a run halts with nothing ready.
- **A portrait and a plate are owed to whoever authored a sheet; a model sheet is not.**
  ([`docs/plans/drawing-a-character-before-a-scene-casts-them.md`](docs/plans/drawing-a-character-before-a-scene-casts-them.md))
- **Incremental planning.** The planner runs once per wave, so `vngen cost` undercounts what a
  later wave unlocks.
- **The whole graph is a graph of slots, not of task hashes** (`portrait:`/`sheet:`/`plate:`/
  `shot:`, edges by `refsOfSlot`), and **approval flows upstream first** — `assetApproved`,
  `assetPrereqs`, `prereqRefusal`, one sentence in three places.
  ([`docs/plans/the-full-slot-graph-and-approving-upstream-first.md`](docs/plans/the-full-slot-graph-and-approving-upstream-first.md))
- **Decomposing every scene is an explicit act, and a fallback is never persisted** — an absent
  `work/shots/<sceneId>.json` is the only signal meaning "decompose this". A decomposition, once
  written, wins forever, and **a shot's order is where its lines sit**.
- **A terminal task records why, is retried once, and is reported from the live plan.**
- **What a character wears is inherited** — `outfitFor`: shot override → the scene's
  `[[outfit:]]` marker → `character.defaultOutfit`. Unlike other scene edits it **does** re-render.
  ([`docs/plans/outfits-at-scene-and-shot-level.md`](docs/plans/outfits-at-scene-and-shot-level.md))
- **Art direction is an authored field, and it deliberately re-renders** — `artNotes`, free text
  at five rungs, **appended** to what was derived; the agent reaches the same rungs through the
  same refusals. **The image seed rides those same rungs**, resolved only in `seedFor`; zero is a
  seed, so every test is `=== undefined`.
  ([`docs/plans/asset-names-and-the-asset-editor.md`](docs/plans/asset-names-and-the-asset-editor.md),
  [`docs/plans/agent-art-revision.md`](docs/plans/agent-art-revision.md))
- **A concept is a picture the pipeline never asked for** — never planned, consumed, exported or
  `accepted`, and its prompt is authored, so it is the one prompt an author may edit.
- **Adoption is the one `done` record written outside the scheduler** — `adoptSlot` makes any
  bytes any slot's output; it cannot forge work, and refuses a `portrait:`.
  ([`docs/plans/adopting-an-uploaded-asset.md`](docs/plans/adopting-an-uploaded-asset.md),
  [`docs/plans/on-demand-concept-images.md`](docs/plans/on-demand-concept-images.md))
- **No _prose_ edit invalidates art, so drift is reported instead** — `Shot.proseHash`, `driftOf`
  re-derived on every read. **A scene's heading is the exception**: `story.setHeading` re-renders
  the scene and restages every shot.
- **Line ids are allocated and written down, and reading never writes** (`story.assignLineIds`).
- **A scene survives a trip through text: `parse(write(scene)) ≡ scene`**, blank lines are
  structural, and **one scene, one file** — a writer patches the file the model was built from.
- **An entity is found by its tag, and the file it was found in travels with it** —
  `entityFile(docs, id)`; conflicts are diagnostics, never a throw.
  ([`docs/plans/entity-discovery-by-meta-tag.md`](docs/plans/entity-discovery-by-meta-tag.md))
- **The story bible is reached by query, never pasted** — no whole-file API, and that absence is
  the guarantee. ([`docs/story-bible.md`](docs/story-bible.md))
- **P7 generate→critique→refine is folded into the `shot_image` runner**, capped by
  `config.max_refine_attempts`, flagging `needs_human` rather than looping.
- **Deterministic fallbacks** in P1/P5, and **provider seams** — the scheduler never imports a
  concrete provider, so backends swap by changing model ids in `project.yaml`.

## CLI

```
vngen run | approve | status | graph | export | cost | import | screenplay   [dir]
```

Flags, `--mock` semantics, key resolution, the on-disk project layout, and the
`templates/basic` walkthrough: [`docs/cli.md`](docs/cli.md). Two things worth knowing before
running anything: `--mock` writes no assets and needs no keys, and in a real project `vngen/` is
**committed** — it is the reproducible output of a run, not something to gitignore.

## Playable & desktop app

The pipeline is presentation-agnostic — it stops at `manifest.json`. `@vn/export` projects the
model + manifest into a small in-house **playable** (`story.play.json`), and the Electron app
plays it. This is deliberately **not** an external DSL export.
Format: [`docs/playable-format.md`](docs/playable-format.md). The app — shell, canvas, the twelve
editors, the session store, the seeded workspace, and every behaviour below in full:
[`docs/desktop-app.md`](docs/desktop-app.md); what persists where:
[`docs/desktopAppState.md`](docs/desktopAppState.md); the document tree, asset naming and
`doc.rename`: [`docs/document-tree.md`](docs/document-tree.md).

- **One workspace at a time, and opening another is a teardown** — but **creating one scaffolds
  where opening does not**, in its own dialog, into its own repository.
  ([`docs/plans/new-and-open-project.md`](docs/plans/new-and-open-project.md))
- **A model key is written to a file git cannot see, and recorded as `<secret>`**
  (`project.setKey`, deliberately not undoable).
- **A layout template is an arrangement the project owns, and it is never merged** —
  `.vnstudio/layouts/<slug>.json`, marked `-merge`; a conflicted one is refused by name.
  ([`docs/plans/layout-templates-and-the-view-menu.md`](docs/plans/layout-templates-and-the-view-menu.md))
- **A conversation is a thread**, appended to `vngen/state/threads/<id>.jsonl`; reopening one is
  read-only. ([`docs/plans/conversation-threads.md`](docs/plans/conversation-threads.md))
- **What a turn cost travels as an event, and it counts calls rather than turns** — no receipt
  means **no total**, never `0`, and a cache split may arrive marked an estimate.
  ([`docs/plans/gemini-estimated-cache-hit-rate.md`](docs/plans/gemini-estimated-cache-hit-rate.md))
- **Every notification is durable, and one hook files them all** —
  `vngen/state/notifications.jsonl`, versioned per line because git union-merges it.
  ([`docs/plans/notifications.md`](docs/plans/notifications.md))
- **A document that is not a scene is written as text, and only by `doc.*`** — refused by
  **content**, never mtime; `scenes/**` is refused outright, because prose is `story.*`.
- **A rename writes where the name was read from, and never moves the file** — an id is derived
  from a name once, at creation, so a scene is deliberately not renamable.
- **An asset is named, one pane answers for it, and an older take is filed rather than listed**
  under `superseded:<kind>`; `asset.replace` reads the slot off the asset on screen rather than
  being told it.
  ([`docs/plans/asset-names-and-the-asset-editor.md`](docs/plans/asset-names-and-the-asset-editor.md))
- **What was drawn from a document is one widget, and a scene is a subject like any other** —
  `renderAssetStrip`, shared by Documents, Wiki and Script.
  ([`docs/plans/asset-cross-references.md`](docs/plans/asset-cross-references.md))
- **An uploaded document is archived verbatim and read only by name** — `archive/<stamp>-<slug>/`,
  invisible to `search`, the bible and entity discovery.
  ([`docs/plans/upload-and-archive.md`](docs/plans/upload-and-archive.md))
- **A bad conversation is diagnosed on the author's own key, and the fiction's names never leave
  with it** — redaction is a boundary rather than a prompt, and nothing is posted.
  ([`docs/plans/reporting-a-difficult-agent.md`](docs/plans/reporting-a-difficult-agent.md))

The renderer is a **path.ux screen mesh** — panes subdivide the window, each showing one editor;
no React, no room vocabulary. path.ux is a git submodule at `vendor/path.ux`, so a fresh clone
needs `git submodule update --init --recursive` (`pnpm doctor` says so by name). Five rules bite
hardest:

- **The twelve editors are named in one place** (`apps/desktop/src/shared/editors.ts`), and
  **`registerEditor(cls, 'vn.Name')`** is the only way to register one — a hand-written name is
  minified. That list also carries each editor's `claims` predicate, ranked in
  `renderer/pathux/route.ts`.
- **`src/shared/` is in the browser bundle**, so what it imports must be node-free; neither
  `tsgo` pass catches a violation, only `vite build`.
- **A raw DOM surface goes in the shadow root via `VnEditor.appendSurface`** with its own sheet
  via `adoptStyle`; `styles/index.css` import order IS cascade order, and `tokens.css` is the
  design contract (no new accent hues).
- **Pure logic goes in `.ts` with a `tests/` sibling; the editor stays thin rendering** — the jest
  desktop project is node-only, so surfaces are verified live over CDP.
- **A mid-gesture verdict must be the verdict that would happen**, layout changes on commit, and
  **an editor with an open text row stops its own keydown**.

## Command system

Every desktop action is a **registered command** rather than a bespoke IPC channel: typed
properties, a string DSL (`namespace.command(a='x' b=1)`), git-stamped provenance, one JSON
catalog. Full write-up: [`docs/command-system.md`](docs/command-system.md).

- **`@vn/commands` is the framework; the desktop app owns the commands**, in
  `apps/desktop/src/main/commands/` as thin wrappers over `WorkspaceSession`.
- **Commands are the only write path** — scene prose, branch markers and
  `work/shots/<sceneId>.json` alike. `vnauthor` runs the same rules and gets the same refusals.
- **Props are declarative specs, not zod**; `coerceProps` is the single validation authority, and
  **`prop.secret` is a string that says never write this down**, redacted at `digestProps`, the
  one projection every record passes through.
- **A mutating command declares its refusal before it runs** — `stack.check` answers `accept` |
  `refuse` | `undeclared`, and absence of a check is not permission.
- **The palette, the menu bar, right-click menus, the agent and CDP all reach the same registry.**
  A right-click entry is an _invocation_, never a callback: checked before it is drawn, and a
  refusal is **shown** rather than hidden. Finding a command and filling it in are two hosts over
  one `CommandForm` (`openCommandDialog(id, props)`).
  ([`docs/plans/document-tree-context-menus.md`](docs/plans/document-tree-context-menus.md))
- **Provenance, undo and commits are each opt-in** — `vngen/state/commands.jsonl`, shadow-snapshot
  undo that **refuses rather than guesses** when the worktree drifted, and per-repo commit-on-save.
  ([`docs/repos-and-commits.md`](docs/repos-and-commits.md))
- **`view.*` commands run in main** and push a `command:ui` effect naming an **editor**, never a
  room; main answers optimistically and the mesh returns a correction.
- **CDP is opt-in in the app and on by default in the developer launchers** — `VN_CDP_PORT`,
  `127.0.0.1`. `node scripts/vn-cdp.mjs "workspace.index()"`.

## The four satellite areas

- **`vnauthor`** — plan-first, git-backed authoring agent: plan mode is read-only, one commit per
  approved plan, edits round-trip through `@vn/model`'s serializers, and the generated half of its
  context is a **map, not content**. **The request is a conversation shaped to be cached, and the
  native path is the default** — a byte-stable prefix, four `cache_control` breakpoints, and
  anything that changes mid-conversation **appended as a `{"role":"system"}` message** rather than
  edited in. [`docs/vnauthor.md`](docs/vnauthor.md),
  [`docs/plans/prompt-caching-and-deferred-tool-loading.md`](docs/plans/prompt-caching-and-deferred-tool-loading.md).
- **`@vn/bible`** — retrieval over `wiki/`. `query` is budgeted and is the only door; a missing
  `wiki/` is an empty bible, not an error. [`docs/story-bible.md`](docs/story-bible.md).
- **`@vn/testkit`** — real projects on disk through the real scheduler with mock providers.
  Nothing may import it, and mock art is **marked** art the real backend refuses.
  [`docs/testkit.md`](docs/testkit.md).
- **`@vn/debug2d`** — source-agnostic 2D debugging for the renderer. Zero deps and dev-only, so
  `vite build` drops it. [`docs/debugGuide.md`](docs/debugGuide.md).

## Conventions

- **Secrets.** The `keys/` directory is gitignored (the generated `vngen/` tree is not). API
  key _values_ must never be logged or committed. `project.yaml` records only model ids and
  env-var names.
  `resolveKeys` throws errors naming the _source_ (env var / file), never the value.
- **Imports** use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).
  jest's `moduleNameMapper` strips them; esbuild and `tsgo` resolve them.
- **Validation at the boundary.** Parse files and machine-consumed LLM output through the
  zod schemas in `@vn/types` so malformed data never reaches the deterministic core.
- Keep new packages inside the layering graph above; the boundaries lint rule will reject
  an illegal cross-layer import.

**Comment style, where plans and research are filed, how docs are kept honest, and the checklist
a plan passes before it counts as finished: [`docs/conventions.md`](docs/conventions.md).** The
two conventions below stay here because they are rules you need while the work is happening.

### Git history

- **`master` is linear — it has no merge commits, and a branch lands by rebasing.** Rebase the
  branch onto `master` (`git rebase master`, or `git pull --rebase` where a remote is involved),
  then land it from the master checkout with `git merge --ff-only <branch>`. `--ff-only` is not a
  precaution, it is the check: if it refuses, the rebase was not done, so rebase again rather than
  reaching for a plain `git merge`. Set `pull.rebase true` so a routine pull cannot weave one in
  either. A worktree's branch lands the same way — `ExitWorktree` with `action: "keep"` first,
  because a worktree cannot merge itself.
- **Squash a branch that is one idea; keep the steps of a branch that is several.** A fix, a small
  feature, a docs pass — one commit, squashed on the way in. A plan implemented in reviewable
  stages keeps those stages, because each is a step a reader would want to land on. What is
  _always_ squashed is the noise the branch made getting there — `wip`, `fix typo`,
  `address review`, `oops`. Fold each into the commit it repairs with `git commit --fixup <sha>`
  while working, then collapse them before landing with
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash master` — spelt that way because an agent
  session has no interactive editor, and because a fixup is a note to the rebase rather than a
  commit anyone reads.
- **Every commit on `master` is green** — `pnpm check`, `pnpm test`, `pnpm lint` — because a linear
  history's whole payoff is that `git bisect` lands on a buildable tree and `git log -p <file>`
  reads as the story of that file. A stage that only compiles once the next stage arrives belongs
  in the next stage.
- **Rewrite only what nobody else has.** Rebasing, squashing and `--fixup` are for a branch still
  in hand; once history is published and someone could have pulled it, it is append-only.

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
  fixed in the definition rather than papered over at the call site. **A pane tab is neither**: it
  is painted on the docker's canvas, so its sentence comes from `define().description`, which
  `registerEditor` splices in from `EDITORS`'s `what` — the same sentence View ▸ Editors offers.

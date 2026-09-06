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
- Debugging guide: [`docs/guides/debugGuide.md`](docs/guides/debugGuide.md). Read it
  before debugging anything in this repo; it orders the tools cheapest-first and prefers
  evidence over reproduction.
- Out of scope: export to an external engine (Ren'Py, Ink, and the like). The generative
  pipeline core stops at a populated `build/` plus `manifest.json`. On top of that sit a
  small in-house playable (`vngen export` → `story.play.json`) and a desktop runner for
  watching a generated VN.

Alongside the pipeline is `vnauthor`, a plan-first conversational agent that helps an
author write and refine the inputs (characters, screenplay, locations). It lives entirely
on the input side, and a boundaries lint rule forbids it from importing the generative
pipeline.

## Setup

A fresh clone needs four steps, in this order (you can also run 'pnpm setup:all'; keep it
up to date with this list):

```bash
git submodule update --init --recursive   # vendor/path.ux, and the one it carries
pnpm install                              # Node >= 20, pnpm 10 (see packageManager)
pnpm --dir vendor/path.ux install         # path.ux has its own lockfile; the root install skips it
pnpm check:setup                               # fails by name if either of the two is still owed
```

path.ux is a submodule that carries submodules of its own, wired into the build as a vite
alias, and needs its own install separately from the root's — `pnpm check:setup`
(`scripts/check-submodules.mjs`, also the desktop build's first step) fails by name when
either step is still owed. nstructjs is a submodule too, at `vendor/nstructjs`, but the
desktop app depends on it via `link:../../vendor/nstructjs` and uses only its committed
build output, so it needs no install of its own and `pnpm check:setup` exempts it. Then
`pnpm check && pnpm test && pnpm lint` should be green, and `pnpm build` bundles
everything. [`docs/guides/toolchain.md`](docs/guides/toolchain.md) covers why each choice
is made and the exact failure symptoms, and
[`docs/reference/desktop-app.md`](docs/reference/desktop-app.md) covers the submodule's
role.

## Commands

Run from the repo root.

| Task                         | Command                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Typecheck (the gate)         | `pnpm check`                                                                            |
| Test (all)                   | `pnpm test`                                                                             |
| Test one package             | `pnpm exec jest --selectProjects @vn/taskgraph`                                         |
| Lint (eslint + format check) | `pnpm lint`                                                                             |
| Eslint only, with fixes      | `pnpm lint:eslint`                                                                      |
| Eslint only, no fixes        | `pnpm lint:eslint:check`                                                                |
| Auto-format                  | `pnpm format`                                                                           |
| Update docs TOCs             | `pnpm markdown-toc` (skips `docs/plans/**`)                                             |
| Check doc links              | `pnpm check:doclinks` (relative links + anchors; part of `pnpm lint`)                   |
| Bundle everything            | `pnpm build` (turbo: `vngen`, `vnauthor`, and the desktop app)                          |
| Run the CLI                  | `node apps/cli/dist/cli.js <cmd>` (or `pnpm vngen <cmd>`)                               |
| Run the authoring agent      | `node apps/authoring/dist/vnauthor.js [dir]` (or `pnpm vnauthor [dir]`)                 |
| Run the desktop app          | `pnpm vndesktop [--mock]` (built app, CDP on 9222)                                      |
| Package the desktop app      | `pnpm package` (installer) / `pnpm package:dir` (unpacked)                              |
| Smoke-test the packaged app  | `pnpm smoke` (runs the built binary; proves both SDKs and the source resolve)           |
| Check the key-guide links    | `pnpm check:keylinks` (blocking in CI; `docs/guides/api-keys.md` only)                  |
| Audit the key-guide wording  | `pnpm audit:keydocs [--dry-run]` (weekly, advisory, needs a key)                        |
| Lint comment prose           | `pnpm lint:comments` (part of `pnpm lint`; `commentlint <file>...` for one file)        |
| Propose a prose-style pass   | `pnpm prose:style --file docs/<page>.md` (advisory, needs a key; writes `.prosestyle/`) |

`pnpm check`, `pnpm test`, and `pnpm lint` should all be green before and after any
change.

The toolchain's shape, and every deliberate deviation from the original plan, is
documented in [`docs/guides/toolchain.md`](docs/guides/toolchain.md). Four things cause
enough mistakes to repeat here:

- `pnpm check` runs two passes: the flat workspace check plus `pnpm check:renderer`,
  because `apps/desktop/renderer/**` lives outside `src/` and nothing else typechecks it.
- `pnpm lint`'s eslint step runs through `eslint-dispatcher` (`@pathtx/eslint-dispatcher`)
  rather than calling `eslint` directly. It walks the repo itself, batches files across a
  worker pool, and caches per-file results under `.eslintcache/`, keyed on file content +
  config + eslint version, so a re-run only re-lints what changed. `pnpm lint:eslint` runs
  it with `--fix`; `pnpm lint:eslint:check` runs it without. Delete `.eslintcache/` to
  force a full re-lint.
- Tests must live in a `tests/` subfolder beside the code they cover. A `*.test.ts`
  anywhere else is silently never run.
- Internal packages are source-only (no per-package `dist`), so consumers import
  `src/index.ts` directly. esbuild transpiles; only `tsgo` type-checks.
- Imports use explicit `.js` extensions on relative paths (ESM + `verbatimModuleSyntax`).

## Architecture

- **Module map**: docs/reference/module-map.md

### Package layering

The graph is acyclic, enforced by `eslint-plugin-boundaries` and `import/no-cycle`. What
each package is responsible for, and the rules behind this diagram, are in
[`docs/reference/packages.md`](docs/reference/packages.md).

```
types  util
  │     │
config  parse
  │     │ │
  │   model store ─ export scriptedit bible artgen gengraph   git ──── commands
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

- The pipeline spine and the authoring branch are disjoint below `@vn/store`; they are not
  allowed to depend on each other. `@vn/authoring` reuses the input-side packages but must
  never import `@vn/pipeline` or `@vn/scheduler`. The boundaries rule checks each import
  statement rather than the transitive closure, so routing a forbidden import through an
  allowed leaf package still violates the design and must not be done.
- Six leaves share that constrained allow-list. `@vn/export`, `@vn/scriptedit`,
  `@vn/bible`, `@vn/artgen` and `@vn/gengraph` are leaves because two hosts (the desktop
  app and `vnauthor`) must run the same rules, so the rules cannot live in either host.
  `@vn/gengraph` has a third host in `@vn/pipeline`, which runs a bound graph, and it is
  forbidden from importing the pipeline or the scheduler for the same reason `@vn/artgen`
  is. `@vn/agentreport` is a leaf because its one host is the desktop app; it additionally
  imports `@vn/commands` for the command records that transcripts do not contain.
- Two packages sit outside the graph. `@vn/debug2d` imports nothing from `packages/` and
  is dev-only in the renderer. `@vn/testkit` may import every layer, and nothing may
  import it.

### Core ideas

The core application contracts — the ones that cost money or corrupt provenance when
broken — are written up in full in
[`docs/reference/pipeline-contracts.md`](docs/reference/pipeline-contracts.md), each with
the failure it prevents and a link to the plan that established it. Read the linked doc in
full, and any doc it links in turn, before changing the invariant it names. Look there
for: the content-addressed task graph and asset store, the P3 approval gate, sheet
planning, incremental planning, the slot graph, explicit decomposition, failure records,
outfit inheritance, art direction (including the agent's own art-revision tools), concept
images, adoption, prose drift reporting, generation-graph drift, line ids, the scene
round-trip, entity discovery, the P7 refine loop, and provider seams. Story-bible access
is the one core idea documented on its own, in
[`docs/reference/story-bible.md`](docs/reference/story-bible.md), because it has no
pipeline-contract failure mode of its own — only the query-only access rule. Generation
graphs — `@vn/gengraph`, the `gengraph.*` commands, the run journal, groups, the Gen Graph
pane and plugins — are written up end to end in
[`docs/reference/gen-graphs.md`](docs/reference/gen-graphs.md); the contracts doc keeps
only their three invariants.

## CLI

```
vngen run | approve | status | graph | export | cost | import | screenplay   [dir]
```

[`docs/guides/cli.md`](docs/guides/cli.md) documents the flags, `--mock` semantics, key
resolution, the on-disk project layout, and the `templates/basic` walkthrough. Two things
are worth knowing before running anything. `--mock` writes no assets and needs no keys. In
a real project `vngen/` is committed, because it is the reproducible output of a run
rather than something to gitignore.

## Playable & desktop app

The pipeline is presentation-agnostic and stops at `manifest.json`. `@vn/export` projects
the model and manifest into a small in-house playable (`story.play.json`), which the
Electron app in `apps/desktop` plays — deliberately not an external DSL export. The app's
cross-cutting invariants (workspace/window lifecycle, keys, layout templates, threads,
notifications, asset naming, the debug agent, packaging, GitHub Pages publishing, updates)
and its path.ux renderer rules live in
[`docs/reference/desktop-app.md`](docs/reference/desktop-app.md#application-invariants),
which also covers the shell, the canvas, and the sixteen editors in full.
[`docs/reference/playable-format.md`](docs/reference/playable-format.md) specifies the
playable format, [`docs/reference/desktopAppState.md`](docs/reference/desktopAppState.md)
records what persists where, and
[`docs/reference/document-tree.md`](docs/reference/document-tree.md) covers the document
tree, asset naming and `doc.rename`. Showing an editor to the author is always `view.open`
/ `view.focus`, reached through `exec` or pushed as a `command:ui` effect, never through
the pane rules directly:
[`docs/guides/showEditorPaneGuide.md`](docs/guides/showEditorPaneGuide.md) is how to call
it correctly, and
[`docs/reference/swappingPaneEditors.md`](docs/reference/swappingPaneEditors.md) is the
pure pane-choice logic (`panes.ts`) it calls into. An editor the app decides to show — a
shot double-clicked in Shot Coverage, an asset clicked in the tree — lands in the biggest
pane that is neither the document tree nor a conversation, and never covers the pane the
author is navigating from. That rule lives in `sparing` in `panes.ts`; a surface must not
pick a pane of its own.

Every control an editor draws also records what pressing it would run, through `act()` in
`renderer/pathux/tour/anchors.ts` — one `Offer` wires the click and the record together,
so the two cannot drift apart. That layer is what lets the app point at itself, and a
guided tour rides on it.
[`docs/reference/guided-tours.md`](docs/reference/guided-tours.md) covers both, including
the committed `anchors.json` and the CDP sweep that measures it, which must be re-run
after touching `apps/desktop/renderer/pathux/editors/**`.

Picking an asset out of the whole manifest — **Attach…** on a prompt clause — goes through
path.ux's gallery popup rather than a bespoke browser.
[`docs/reference/asset-picker.md`](docs/reference/asset-picker.md) is the app's half of
it: the `asset.list` snapshot behind the entries, the `vnasset://` decode that feeds the
thumbnail cache, and why the picked value only ever reaches `prompt.addRef` as a hash. The
widget itself is documented in path.ux, at
[`vendor/path.ux/documentation/gallery.md`](vendor/path.ux/documentation/gallery.md).

## Command system

Every desktop action is a registered command rather than a bespoke IPC channel. A command
has typed properties, a string DSL (`namespace.command(a='x' b=1)`), git-stamped
provenance, and one JSON catalog.
[`docs/reference/command-system.md`](docs/reference/command-system.md) is the full
write-up.

- `@vn/commands` is the framework. The desktop app owns the commands, in
  `apps/desktop/src/main/commands/`, as thin wrappers over `WorkspaceSession`.
- Commands are the only write path, for scene prose, branch markers and
  `work/shots/<sceneId>.json` alike. `vnauthor` runs the same rules and gets the same
  refusals.
- Props are declarative specs rather than zod, and `coerceProps` is the single validation
  authority; `prop.secret` marks a string redacted at `digestProps` and never persisted.
- A mutating command declares its refusal before it runs, via `stack.check` (`accept` /
  `refuse` / `undeclared`); `undeclared` is not treated as permission.
- The palette, the menu bar, right-click menus and CDP all reach the same registry; the
  agent does not. An agent tool like `edit_scene` shares the underlying rule its `story.*`
  counterpart uses, without invoking the registry, so a command with no tool wrapper
  (`story.decomposeAll`, for one) is unreachable to the agent in either host.
  ([`docs/reference/command-system.md#from-the-agent`](docs/reference/command-system.md#from-the-agent),
  [`docs/plans/archive/INDEX.md#document-tree-context-menus`](docs/plans/archive/INDEX.md#document-tree-context-menus))
- Provenance, undo and commits are each opt-in: `vngen/state/commands.jsonl` for
  provenance, undo over an in-memory content-addressed snapshot of the document tree (no
  git, and no history across a restart), and per-repo commit-on-save. A command sent once
  per frame declares `defersCommit`, and a run of them commits once.
  ([`docs/reference/repos-and-commits.md`](docs/reference/repos-and-commits.md),
  [`docs/reference/command-system.md`](docs/reference/command-system.md))
- `view.*` commands run in main and push a `command:ui` effect naming an editor, never a
  room; main answers optimistically, and the mesh returns a correction.
- CDP is opt-in in the app and on by default in the developer launchers, through
  `VN_CDP_PORT` on `127.0.0.1`. `node scripts/vn-cdp.mjs "workspace.index()"`.

## The four satellite areas

- **`vnauthor`** — a plan-first, git-backed authoring agent. Plan mode is read-only, each
  approved plan produces one commit, edits round-trip through `@vn/model`'s serializers,
  and approval is authorized only by the author's own typed words, never agent-written
  text. [`docs/reference/vnauthor.md`](docs/reference/vnauthor.md),
  [`docs/plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading`](docs/plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading),
  [`docs/plans/archive/INDEX.md#improving-the-authoring-agent`](docs/plans/archive/INDEX.md#improving-the-authoring-agent),
  [`docs/plans/archive/INDEX.md#skills-editor-and-agent-authored-skills`](docs/plans/archive/INDEX.md#skills-editor-and-agent-authored-skills).
- **`@vn/bible`** — retrieval over `wiki/`. `query` is budgeted and is the only entry
  point. A missing `wiki/` yields an empty bible, not an error.
  [`docs/reference/story-bible.md`](docs/reference/story-bible.md).
- **`@vn/testkit`** — real projects on disk through the real scheduler with mock
  providers. Nothing may import it, and mock art carries a marker the real backend
  refuses. [`docs/guides/testkit.md`](docs/guides/testkit.md).
- **`@vn/debug2d`** — source-agnostic 2D debugging for the renderer. Zero deps and
  dev-only, so `vite build` drops it.
  [`docs/guides/debugGuide.md`](docs/guides/debugGuide.md).

## Conventions

- **Secrets.** The `keys/` directory is gitignored (the generated `vngen/` tree is not).
  API key values must never be logged or committed. `project.yaml` records only model ids
  and env-var names. `resolveKeys` throws errors naming the source (env var or file),
  never the value.
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

Comments are prose, so the Prose rules below govern them as well. The rules in this
section are the ones that apply only to code.

- **A comment describes the code directly beneath it.** Placing a comment above an `if`
  captions the branch it guards, so a comment explaining the opposite case belongs on the
  `else`, or should be reworded to describe the test itself. Misplacing a comment this way
  breaks correctness, not just style.
- **Delete commented-out code — never leave it as commentary.** Git history holds it. A
  commented-out call, import or block explains nothing about the code that survives, and
  it goes stale silently because nothing type-checks it.
- **Never restate what the code already says.** `inputs: {}, //tool properties` and
  `case keymap.Escape: //esc` add a maintenance burden and no information. A comment earns
  its place by giving a reason, a constraint, or a consequence.
- **Cite a named constant rather than its value.** A comment saying "thirty seconds"
  beside `LINGER_MS` is wrong the first time the constant changes; write
  `` `LINGER_MS` ``.
- **Rename instead of commenting a name.** If the sentence's work is translating an
  identifier — what `snapMode` means, what a bare `-1` means — rename the identifier or
  introduce a named constant, then delete the sentence. Comment a name only when the name
  cannot be fixed. Try to avoid names longer than three words or 25 characters (10
  characters or less is preferred).
- **Comment the consequence, not the arguments.** Options passed at a call site
  (`capture`, `passive`, a flag, a lifetime) are already on screen. State what the reader
  cannot see: what the call does to everything around it. Write "Does not inhibit the
  event from reaching other consumers", not "registered `passive` so it cannot call
  `preventDefault`".
- **State facts; do not defend the design.** Rationale belongs in a comment only when a
  reader looking at the surrounding code still could not derive it — an ordering
  constraint, a platform quirk, a decision with a live alternative. Explaining why this
  approach beats a naive one, or what would go wrong under that naive approach, belongs in
  the commit message instead.
- **A doc comment continues its declaration; it does not restate it.** Do not re-supply
  the subject the declaration already names, and do not narrate the signature. A field or
  property takes a noun phrase or a bare predicate — "Pointer ids currently down.",
  "Detected via the presence of multiple pointer ids." A class, function or method takes a
  predicate, because the reader needs to know what it does — "Draws the links beneath the
  node frames in screen space." A headless noun phrase over a class or a function is a
  fragment opener; do not use one. A doc comment that reads as a standalone paragraph is
  usually rationale in disguise.
- **Inline notes and doc comments are punctuated differently.** An inline `//` note is a
  fragment with no terminal period; a `/** … */` doc comment is a punctuated sentence. One
  line each, unless the fact genuinely needs two.
- **Non-doc comments use `//`.** Doc comments use proper `/** … */` brackets. Don't use
  `/* … */` for ordinary inline commentary.
- **Non-doc comments are at most 3 lines.** A longer block comment is allowed sparingly —
  budget roughly one per 500 lines of a file — for genuinely load-bearing context that
  can't be stated in three lines.
- **Doc comments stay reasonably concise.** Cover the declaration's purpose and any
  non-obvious contract; don't restate the signature or narrate the implementation.
- **Temporary comments are marked `CLAUDENOTE:`.** Any scratch/working comment Claude
  writes gets that prefix, and all of them must be removed before the final commit of a
  plan (or at the end of the plan, whichever comes first).

`pnpm lint:comments` runs `commentlint` (config at `.commentlintrc.json`, which excludes
`vendor/path.ux` and `vendor/nstructjs`) over the prose rules above, and `pnpm lint` calls
it as its last step. `commentlint <file>...` checks specific files directly; a path named
that way is scanned even if the config's `exclude` would otherwise prune it, since a file
named outright is read as the caller having already decided.

#### Prose

See ['docs/reference/proseStyle.md'](docs/reference/proseStyle.md).

### Plans

- A plan is pressure-tested by a fresh-context agent once it is written, before the work
  starts. Hand the finished `docs/plans/<name>.md` to a subagent that has not seen the
  conversation that produced it, and ask it to attack the plan: what does it assume
  without stating, what does it contradict in the code or in `docs/`, what does it leave
  undecided, and what would it cost to undo. The reviewer must be a separate context,
  because the author's context already holds the reasoning the plan is supposed to carry
  on its own, so an agent that helped write the plan cannot tell a stated decision from a
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
  `pull.rebase true` so a routine pull cannot introduce a merge commit either. A
  worktree's branch lands the same way, with `ExitWorktree` and `action: "keep"` first,
  because the merge must run from the master checkout rather than from inside the
  worktree.
- Squash a branch that is one idea; keep the stages of a branch that is several. A fix, a
  small feature, a docs pass: one commit, squashed on the way in. A plan implemented in
  reviewable stages keeps those stages, because each is a commit a reader would want to
  land on. The noise made along the way (`wip`, `fix typo`, `address review`, `oops`) is
  always squashed. Fold each into the commit it repairs with `git commit --fixup <sha>`
  while working, then collapse them before landing with
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash master`. It is spelled that way
  because an agent session has no interactive editor, and because a fixup is a note to the
  rebase rather than a commit anyone reads.
- Every commit on `master` is green under `pnpm check`, `pnpm test` and `pnpm lint`, so
  that `git bisect` always lands on a buildable tree and `git log -p <file>` reads as that
  file's history. A stage that only compiles once the next stage arrives belongs in the
  next stage.
- Only rewrite history nobody else has pulled yet. Rebasing, squashing and `--fixup` are
  for a branch still in hand; once history is published and someone could have pulled it,
  treat it as append-only.

### Tooltips

- Every interactive UI element carries a tooltip — no exceptions. Buttons, checkboxes,
  text fields, menu and palette entries, tree rows, thumbnails, drag handles, icon-only
  controls: if the author can click, type into, or drag it, it says what it does on hover.
  A control shipped without one is an unfinished control.
- Describe what a control does rather than naming it. Write "Leave this clause out of the
  prompt" rather than "Mute". Where the label already says everything (a plain `OK`), the
  tooltip adds the consequence instead of repeating the word.
- A disabled control's tooltip states why it refused. When a command declined through
  `stack.check`, show that sentence verbatim — a greyed control that will not say why is
  the same bug as a hidden one.
- Tooltips are set through two mechanisms. A path.ux widget takes `.description`; a raw
  DOM node in an `appendSurface` root takes `.title`. Command-backed controls default to
  the registry's own text (the entry's `title`, a prop's `description`), so a command with
  a vague description is fixed in the definition rather than papered over at the call
  site. A pane tab uses neither mechanism: it is painted on the docker's canvas, so its
  tooltip comes from `define().description`, which `registerEditor` splices in from
  `EDITORS`'s `what` — the same sentence View ▸ Editors shows.

## Euphemeral UI data (saveUIData/loadUIData)

See
[vendor\path.ux\scripts\core\base\ui_savedata.ts](vendor\path.ux\scripts\core\base\ui_savedata.ts)

Path.ux has a system to store 'euphemeral' data, such as:

- Scroll position
- Expanded/collapsed state of trees
- Open/closed state of panels
- Last selected item in a list
- etc.

UIBase subclasses can override saveData and loadData methods, they should be
fault-tolerant.

The typical pattern to use is:

```ts
// note: the second parameter is currently unused but is required
const data = saveUIData(widget, "something");
// reinitialize widget
loadUIData(widget, data);
```

saveUIData is implemented using a simple DOM path system and is meant to fail gracefully
if e.g. the widget's subtree has reconfigured.

The base pathux editor class (Area) uses this system to save and load the state of widgets
in area editors in its STRUCT script.

# The desktop app

<!-- toc -->

- [Application invariants](#application-invariants)

<!-- tocstop -->

`apps/desktop` is an Electron app whose renderer is a path.ux screen mesh: a window subdivides into
panes, and each pane shows one editor over one `WorkspaceSession`. There are no rooms and no
modes-within-rooms; the author splits the window and puts the editors they want side by side. Every
action the app can take is a registered command ([`command-system.md`](command-system.md)).
[`desktopAppState.md`](desktopAppState.md) covers what the app persists and where, and
[`playable-format.md`](playable-format.md) covers what it plays.
[`../plans/archive/INDEX.md#pathux-desktop-rewrite`](../plans/archive/INDEX.md#pathux-desktop-rewrite)
records the rewrite that got here step by step, with its traps written down.

This page covers the cross-cutting invariants. The rest of the app is split by concern:

- [`desktop-app-shell.md`](desktop-app-shell.md) — covers the path.ux renderer rules, running and
  building the app, the renderer's file layout, the shell (window, header, menus, selection, keyboard,
  the palette), layout templates, and the graph canvas the two graph editors share.
- [`desktop-app-editors-story.md`](desktop-app-editors-story.md) — covers the writing editors:
  Branches, Script, Convo, and Shot Coverage.
- [`desktop-app-editors-pipeline.md`](desktop-app-editors-pipeline.md) — covers the pipeline
  editors: Tasks/Task Graph/Inspector, Gen Graph, Play, Asset. The Gen Graph pane is described in
  full, along with the graphs it edits, in [`gen-graphs.md`](gen-graphs.md#the-gen-graph-pane).
- [`desktop-app-editors-misc.md`](desktop-app-editors-misc.md) — the remaining document and
  settings editors: Wiki, Skills, Documents, Project, System Prompt, Setup, Debug Agent.
- [`desktop-app-state.md`](desktop-app-state.md) — the state the shell persists between runs (the
  two `session.json` files), which project opens at launch, and the seeded sample workspace.

## Application invariants

The pipeline is presentation-agnostic and stops at `manifest.json`. `@vn/export` projects the model
and manifest into a small in-house playable (`story.play.json`), and this app plays it. The format is
deliberately in-house rather than an export to an external DSL.
[`playable-format.md`](playable-format.md) specifies the format.
[`desktopAppState.md`](desktopAppState.md) records what persists where, and
[`document-tree.md`](document-tree.md) covers the document tree, asset naming and `doc.rename`.

- Only one workspace is open at a time, and opening another tears the first down. Creating a
  workspace scaffolds files into its own repository; opening a workspace does not.
  ([`../plans/archive/INDEX.md#new-and-open-project`](../plans/archive/INDEX.md#new-and-open-project))
- A window does not hold state. One app instance owns the workspace and all of its windows, which
  are managed through `window.*` and `view.open(where=window)`.
  ([`../plans/multiple-windows.md`](../plans/multiple-windows.md))
- Model keys are written to gitignored files and recorded as `<secret>`. `project.setKey` is
  deliberately not undoable. A key is scoped to this project or to every project on this machine.
  ([`../plans/archive/INDEX.md#onboarding-editor-and-user-level-keys`](../plans/archive/INDEX.md#onboarding-editor-and-user-level-keys))
- Layout templates belong to the project and are never git-merged. Each template lives at
  `.vnstudio/layouts/<slug>.json`, and a template that will not parse is refused by name.
  ([`../plans/archive/INDEX.md#layout-templates-and-the-view-menu`](../plans/archive/INDEX.md#layout-templates-and-the-view-menu))
- A conversation is stored as a thread at `vngen/state/threads/<id>.jsonl`. A reopened thread is
  read-only until Continue. Compacting appends a summary to the log and does not rewrite it.
  ([`../plans/archive/INDEX.md#conversation-threads`](../plans/archive/INDEX.md#conversation-threads),
  [`../plans/archive/resumable-threads-and-compaction.md`](../plans/archive/resumable-threads-and-compaction.md))
- The event that reports turn cost counts API calls rather than turns. A missing receipt produces no
  total (never `0`).
  ([`../plans/archive/INDEX.md#gemini-estimated-cache-hit-rate`](../plans/archive/INDEX.md#gemini-estimated-cache-hit-rate))
- Every notification is durable, filed by a single hook to `vngen/state/notifications.jsonl`, one
  version per line because git union-merges the file. The bell's list draws one page of
  `NOTIFICATION_PAGE` rows and a `Show N more` button. The log is append-only and never pruned, so
  building a row per entry made opening the bell slow on an old project. `notificationPage` in
  `src/shared/notify.ts` holds the whole paging rule, and the header shows `X of Y` while a page is
  short of the end.
  ([`../plans/archive/INDEX.md#notifications`](../plans/archive/INDEX.md#notifications))
- Only `doc.*` writes non-scene documents, and it writes them as text. `scenes/**` is refused
  outright, because `story.*` writes the prose.
- A rename rewrites the field the name was read from and never moves the file. A scene derives its
  id from its name once, at creation, so a scene cannot be renamed.
- Assets have names, and the tree lists slots rather than pictures. Each slot gets one row, and
  earlier takes are folded under the take that replaced them.
  ([`../plans/archive/INDEX.md#asset-names-and-the-asset-editor`](../plans/archive/INDEX.md#asset-names-and-the-asset-editor))
- The shared widget `renderAssetStrip` shows what was drawn from a document. Documents, Wiki, Script
  and Scene all use it.
  ([`../plans/archive/INDEX.md#asset-cross-references`](../plans/archive/INDEX.md#asset-cross-references))
- Uploaded documents are archived verbatim at `archive/<stamp>-<slug>/`. The archived copies are
  excluded from `search`, the bible, and entity discovery.
  ([`../plans/archive/INDEX.md#upload-and-archive`](../plans/archive/INDEX.md#upload-and-archive))
- A bad conversation is diagnosed on the author's own key, and the fiction's names never leave the
  machine. "The debug agent" (implemented in `@vn/agentreport`, also called "the analyst") is the
  popup-pane conversation that Help ▸ Report a Difficult Agent… opens. It is not `vnauthor`, and it is
  not a debugging tool for this repository. `report.agent` is a separate headless one-shot that
  scripts and the API-fault seam use. ([`agent-report.md`](agent-report.md))
- `@vn/providers` keeps every API request in a bounded in-memory ring that never reaches the report,
  so a 400 that names a byte position can be read against the body it indexes.
  ([`../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it`](../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it))
- The app ships as an installer and checks for `git` at runtime rather than bundling it. On a
  machine without git, the app still opens and records a durable note explaining why saving does not
  work.
  ([`../plans/archive/INDEX.md#packaging-the-desktop-app`](../plans/archive/INDEX.md#packaging-the-desktop-app))
- `renderSite` publishes a VN to the web as a light novel: it turns the playable into one HTML page
  per scene, and `project.installPages` commits a dependency-free renderer bundle plus a workflow that
  force-pushes `gh-pages` with plain `node`. Serving that branch is controlled by a repository setting
  that the app can neither make nor read. ([`../guides/github-pages.md`](../guides/github-pages.md))
- The app checks for an update only when the author selects Help ▸ Check for Updates…
  (`app.checkForUpdates`), and it never opens an address supplied to it.
  ([`../plans/archive/INDEX.md#in-app-update-checks`](../plans/archive/INDEX.md#in-app-update-checks))

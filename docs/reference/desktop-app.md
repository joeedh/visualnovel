# The desktop app

<!-- toc -->

- [Application invariants](#application-invariants)

<!-- tocstop -->

`apps/desktop` is an Electron app whose renderer is a **path.ux screen mesh**: a window
subdivides into panes, and each pane shows one **editor** over one `WorkspaceSession`. There are
no rooms and no modes-within-rooms — the author splits the window and puts the editors they want
side by side. Every action the app can take is a registered command
([`command-system.md`](command-system.md)); what it persists and where is
[`desktopAppState.md`](desktopAppState.md); what it plays is
[`playable-format.md`](playable-format.md). The rewrite that got here, step by step and with its
traps written down, is [`../plans/archive/pathux-desktop-rewrite.md`](../plans/archive/pathux-desktop-rewrite.md).

This page covers the cross-cutting invariants. The rest of the app is split by concern:

- [`desktop-app-shell.md`](desktop-app-shell.md) — the path.ux renderer rules, running and
  building the app, the renderer's file layout, the shell (window, header, menus, selection,
  keyboard, the palette), layout templates, and the graph canvas the two graph editors share.
- [`desktop-app-editors-story.md`](desktop-app-editors-story.md) — the writing editors: Branches,
  Script, Convo, Shot Coverage.
- [`desktop-app-editors-pipeline.md`](desktop-app-editors-pipeline.md) — the pipeline editors:
  Tasks/Task Graph/Inspector, Gen Graph, Play, Asset.
- [`desktop-app-editors-misc.md`](desktop-app-editors-misc.md) — the remaining document and
  settings editors: Wiki, Skills, Documents, Project, System Prompt, Setup, Debug Agent.
- [`desktop-app-state.md`](desktop-app-state.md) — what the shell remembers between runs (the two
  `session.json` files), which project opens at launch, and the seeded sample workspace.

## Application invariants

The pipeline is presentation-agnostic and stops at `manifest.json`. `@vn/export` projects
the model and manifest into a small in-house playable (`story.play.json`), and this app
plays it — deliberately not an external DSL export.
[`playable-format.md`](playable-format.md) specifies the format.
[`desktopAppState.md`](desktopAppState.md) records what persists where, and
[`document-tree.md`](document-tree.md) covers the document tree, asset naming and
`doc.rename`.

- One workspace is open at a time; opening another tears the first down. Creating a
  workspace scaffolds files, into its own repository, where opening does not.
  ([`../plans/archive/new-and-open-project.md`](../plans/archive/new-and-open-project.md))
- Windows do not own state; one app instance owns the workspace and all of its windows,
  managed through `window.*` and `view.open(where=window)`.
  ([`../plans/multiple-windows.md`](../plans/multiple-windows.md))
- Model keys are written to gitignored files and recorded as `<secret>` (`project.setKey`,
  deliberately not undoable), scoped to this project or to every project on this machine.
  ([`../plans/archive/onboarding-editor-and-user-level-keys.md`](../plans/archive/onboarding-editor-and-user-level-keys.md))
- Layout templates belong to the project and are never git-merged, living at
  `.vnstudio/layouts/<slug>.json`; a template that will not parse is refused by name.
  ([`../plans/archive/layout-templates-and-the-view-menu.md`](../plans/archive/layout-templates-and-the-view-menu.md))
- A conversation is stored as a thread at `vngen/state/threads/<id>.jsonl`; a reopened
  thread is read-only until Continue, and compacting appends a summary to the log without
  rewriting it.
  ([`../plans/archive/conversation-threads.md`](../plans/archive/conversation-threads.md),
  [`../plans/archive/resumable-threads-and-compaction.md`](../plans/archive/resumable-threads-and-compaction.md))
- Turn cost is reported as an event counting API calls rather than turns; a missing receipt
  produces no total (never `0`).
  ([`../plans/archive/gemini-estimated-cache-hit-rate.md`](../plans/archive/gemini-estimated-cache-hit-rate.md))
- Every notification is durable, filed by a single hook to
  `vngen/state/notifications.jsonl`, one version per line because git union-merges the file.
  ([`../plans/archive/notifications.md`](../plans/archive/notifications.md))
- Non-scene documents are written as text, and only by `doc.*`; `scenes/**` is refused
  outright, because prose belongs to `story.*`.
- A rename rewrites the field the name was read from and never moves the file; a scene's id
  is derived from its name once, at creation, which is why a scene is not renamable.
- Assets are named, and the tree lists slots rather than pictures: one row per slot, with
  earlier takes folded under the one that replaced them.
  ([`../plans/archive/asset-names-and-the-asset-editor.md`](../plans/archive/asset-names-and-the-asset-editor.md))
- One shared widget, `renderAssetStrip`, answers "what was drawn from this document",
  shared by Documents, Wiki, Script and Scene.
  ([`../plans/archive/asset-cross-references.md`](../plans/archive/asset-cross-references.md))
- Uploaded documents are archived verbatim at `archive/<stamp>-<slug>/`, invisible to
  `search`, the bible, and entity discovery.
  ([`../plans/archive/upload-and-archive.md`](../plans/archive/upload-and-archive.md))
- A bad conversation is diagnosed on the author's own key, and the fiction's names never
  leave the machine. "The debug agent" (implemented in `@vn/agentreport`, also called "the
  analyst") is the popup-pane conversation Help ▸ Report a Difficult Agent… opens — not
  `vnauthor`, and not a debugging tool for this repository. `report.agent` is the separate
  headless one-shot scripts and the API-fault seam use.
  ([`agent-report.md`](agent-report.md))
- Every API request is kept in a bounded in-memory ring in `@vn/providers`, never reaching
  the report, so a 400 that names a byte position can be read against the body it indexes.
  ([`../plans/archive/diagnosing-an-api-error-from-the-request-that-caused-it.md`](../plans/archive/diagnosing-an-api-error-from-the-request-that-caused-it.md))
- The app ships as an installer and checks for `git` at runtime rather than bundling it; on
  a machine without git it still opens and files a durable note explaining why saving does
  not work.
  ([`../plans/archive/packaging-the-desktop-app.md`](../plans/archive/packaging-the-desktop-app.md))
- A VN can be published to the web as a light novel: `renderSite` turns the playable into
  one HTML page per scene, and `project.installPages` commits a dependency-free renderer
  bundle plus a workflow that force-pushes `gh-pages` with plain `node`. Serving that branch
  is a repository setting the app can neither make nor read.
  ([`../guides/github-pages.md`](../guides/github-pages.md))
- Nothing checks for an update until the author asks, via Help ▸ Check for Updates…
  (`app.checkForUpdates`); the app never opens an address it was handed.
  ([`../plans/archive/in-app-update-checks.md`](../plans/archive/in-app-update-checks.md))

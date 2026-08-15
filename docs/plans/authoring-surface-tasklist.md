# Authoring surface — tasklist

Status: **planned**

The eight plans below cover every open item in `todos.md` as of 2026-08-15. This page is the
running order and the checkbox list; each plan states its own decisions and acceptance criteria and
is the authority on its own work.

| # | Plan | Covers (`todos.md`) |
| --- | --- | --- |
| 1 | [`editor-routing-by-relevance.md`](editor-routing-by-relevance.md) | clicking a document tree item shows the right editor |
| 2 | [`asset-cross-references.md`](asset-cross-references.md) | the wiki page shows assets that reference it |
| 3 | [`new-and-open-project.md`](new-and-open-project.md) | New / Open / Recent project menu entries |
| 4 | [`conversation-threads.md`](conversation-threads.md) | saved, searchable conversation threads |
| 5 | [`upload-and-archive.md`](upload-and-archive.md) | `/upload`, the archive, the suggestions, the menu entry |
| 6 | [`adopting-an-uploaded-asset.md`](adopting-an-uploaded-asset.md) | uploading cleaned-up artwork as a slot's output |
| 7 | [`agent-art-revision.md`](agent-art-revision.md) | the agent edits art notes, regenerates, reads the picture back |
| 8 | [`document-tree-context-menus.md`](document-tree-context-menus.md) | the three right-click menus |

## Order

Only two edges are real, and both are hard:

- **4 before 5.** "Activate or create a conversation editor **in a new thread**" has no meaning
  until threads exist.
- **1 before 8.** The context menus' "and open the asset editor automatically" is the routing rule,
  not a second hardcoded `view.open`.

Everything else is independent, so the order below is chosen to put shared plumbing first and to
keep each wave's acceptance testable on its own.

```
wave A   1 editor routing        3 new/open project      6 adopting an upload
wave B   2 cross-references      4 threads               7 agent art revision
wave C   8 context menus         5 upload & archive
```

Wave A is three unrelated pieces of foundation: the routing function the shell keeps needing, the
project lifecycle, and the `*Inputs` extraction that makes adoption safe. Wave B builds on A or on
nothing. Wave C is the two features that consume the rest.

## The list

### 1 — Editor routing by relevance

- [x] Claims declared beside the names in `apps/desktop/src/shared/editors.ts`, as predicates over
      a node rather than a `DocNodeKind` map
- [x] Pure `routeFor()` in `apps/desktop/renderer/pathux/route.ts`, sorting on
      `(visible, tier, EDITORS order)`
- [x] `pathux/tests/route.test.ts`
- [x] Selection published **before** the open, so a two-field subject (a shot) arrives whole
- [x] `documents.ts` row click routes through it; `where: 'elsewhere'` covers the no-pane case
- [x] Docs: `docs/document-tree.md`, `docs/desktop-app.md`

### 2 — Asset cross-references

- [x] `DocTree` gains `pathIndex` and `scene:<id>` backlink keys; `linksFor`/`bindsTo` gain the
      `{sceneId}` case
- [x] Extract `assetGroups` + the thumbnail cell into `renderer/pathux/assetstrip.ts`, over generic
      groups
- [x] Wiki editor consumes it
- [x] Script editor consumes it — the second consumer is what proves the widget is generic
- [x] Honest empty state: no asset binds to a plain lore note today, and the sentence says so
- [x] Docs: `docs/document-tree.md`, `docs/desktop-app.md`

### 3 — New, Open and Recent project

- [x] `inspectCreate` / `createWorkspace` in `apps/desktop/src/main/workspace.ts`
- [x] Three-file skeleton (`project.yaml` with `start: opening`, `scenes/opening.md`,
      `wiki/index.md`) — not a copy of `examples/sample`
- [x] `workspace.create` command, with the non-empty refusal and the inside-a-repo warning
- [x] `workspace.test.ts`: the created project loads a model with **zero** error diagnostics
- [x] Menu: New Project…, Open Project…, a Recents submenu built from `workspace.recent`
- [x] Docs: `docs/desktop-app.md`, `docs/repos-and-commits.md`, `CLAUDE.md`

### 4 — Conversation threads

- [x] Move the reducer to `apps/desktop/src/shared/convo.ts`; both processes reduce identically
- [x] `apps/desktop/src/main/threads.ts`: the JSONL log at `vngen/state/threads/<id>.jsonl`,
      append-only including the superseding `title` record
- [x] `threads.test.ts`: round-trip, retitle, corrupt last line, ordering
- [x] `session.runAgent` opens lazily and appends as it emits; `clearAgent` closes
- [x] `agent.threads` / `newThread` / `openThread` / `renameThread`
- [x] The searchable dropdown — `startMenu(menu, x, y, true)` — and the read-only replay banner
- [x] Docs: `docs/desktopAppState.md` (two "lost on restart" rows), `docs/desktop-app.md`,
      `docs/vnauthor.md`, `CLAUDE.md`

### 5 — `/upload` and the archive

*Depends on 4.*

- [x] `packages/authoring/src/archive.ts`: `archiveUpload`, `uploadSuggestions`, `ARCHIVE_DIR`
- [x] `list_archive` tool; `INPUT_GLOBS` left exactly as it is
- [x] `archive.test.ts`, including the test that `search` finds nothing an archived file contains
      while `read_file` reads it
- [x] `upload.files` / `upload.pick` commands, `confirm: true`; forced plan mode, new thread,
      seeded message
- [x] Suggestion chips that **fill** the composer; the 600ms border flash
- [x] Menu: Upload Files…
- [x] REPL `/upload <paths…>`
- [x] Docs: `docs/vnauthor.md`, `docs/desktop-app.md`, `docs/story-bible.md`, `CLAUDE.md`

### 6 — Adopting an uploaded picture

- [ ] Extract `portraitInputs` / `modelSheetInputs` / `shotInputs` into
      `packages/artgen/src/prompts.ts`; the planner calls them — **hashes unchanged**
- [ ] `packages/artgen/src/adoptslot.ts`: `adoptionForSlot` / `adoptSlot`, addressed by
      `RefBinding` through the existing `parseSlot` vocabulary
- [ ] `replace` on `AdoptRequest`, honoured at the one `ALREADY_RENDERED` site
- [ ] `promoteConcept` rewritten as a caller, its tests unchanged
- [ ] `asset.adopt`; `asset.upload` gains `slot=''`
- [ ] The asset editor's Replace-with-a-file strip, and the supersede confirm sentence
- [ ] Docs: `docs/asset-stores.md`, `docs/desktop-app.md`, `CLAUDE.md`

### 7 — The agent revises art

- [ ] Move `apps/desktop/src/main/artnotes.ts` → `packages/artgen/src/artnotes.ts` with its tests;
      behaviour byte-identical
- [ ] `packages/artgen/src/setnotes.ts`, and `session.setArtNotes` delegating to it
- [ ] `packages/artgen/src/describe.ts` — `describeAsset` over the `ChatBackend` seam, **not** a
      widened `VisionReviewer`
- [ ] `ToolContext.pipeline?: PipelineControl`, wired by the desktop, refused by name in the REPL
- [ ] Tools: `list_assets`, `art_notes`, `set_art_notes`, `view_image`, `regenerate_asset`
- [ ] `regenerate_asset` always-confirm sentence in `apps/desktop/src/main/toolconfirm.ts`
- [ ] Docs: `docs/vnauthor.md`, `docs/packages.md`, `CLAUDE.md`

### 8 — Document tree context menus

*Depends on 1.*

- [ ] `apps/desktop/renderer/pathux/contextmenu.ts`: entries are invocations, resolved through
      `check` then `exec`
- [ ] Refused entries render `⃠ Label` and report the command's own sentence; `undeclared` is not
      permission
- [ ] `entriesWithVerdicts` unit-tested in `pathux/tests/contextmenu.test.ts`
- [ ] `menuFor(node)` in `pathux/doctree.ts` — the table, including the kinds that offer nothing
- [ ] `documents.ts` wires `contextmenu`: prevent default, publish selection, open
- [ ] The asset editor's header uses the same builder
- [ ] Docs: `docs/command-system.md`, `docs/document-tree.md`, `CLAUDE.md`

## Closing out

Each plan is finished under the repo's own rule: comments audited, every `CLAUDENOTE:` gone, the
`docs/` pages it names updated, its row in [`index.md`](index.md) moved to **shipped**, and the
matching `[ ]:` in `todos.md` checked — wording, ordering and whitespace left alone.

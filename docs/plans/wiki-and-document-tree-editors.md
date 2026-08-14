# Wiki and document-tree editors

Status: **planned**. Item 12 of [`refactorTaskList.md`](refactorTaskList.md). The panes for the
backends that items 3 and 9 shipped — a sidebar that draws the document tree and the file tree, a
backlink panel behind a character, and a markdown editor for the story bible — plus the read and
write commands they need, which do not exist yet.

<!-- toc -->

<!-- tocstop -->

## Why

Two shipped plans each deferred this UI to the other, and neither was wrong about its own scope.

[`pathux-desktop-rewrite.md`](pathux-desktop-rewrite.md#what-carries-over-what-dies):

> Future editors (wiki/bible, document tree sidebar, backlink panel, project picker) are named
> here so they have a declared home, but they belong to their backend items (3, 9, 10 in the task
> list) and are out of scope.

[`document-tree-and-backlinks.md`](document-tree-and-backlinks.md#out-of-scope):

> **The sidebar itself.** This item ships the shape and the channels; the pane that draws them
> belongs to item 1, which names a document-tree sidebar as a future editor with a declared home.

So the shapes, the channels and the ranking policy are built and tested, and nothing draws any of
them. Of the four future editors named in the rewrite, only the project picker landed (`Open
Project…` in the app menu). This plan owns the other three, and the tracker gets a row so the
ping-pong cannot happen again.

It is also the largest remaining gap against the requirements, which are unusually specific here
([`../designRequirementsEtc.md`](../designRequirementsEtc.md) §Authoring):

> The user uses the UX to edit the story bible. … The user creates a new character, the app
> initializes it with a template. There is a sidebar with a logical document tree; it will have a
> mode for a full file tree to view every file, but the default local document tree shows the story
> bible file tree, assets, and the script tree … In addition there is a tree for characters,
> clicking on it shows a panel with links to the character's story bible file, base assets, and
> which scenes and shots it appears in. … Anyway the user can edit the markdown of the character in
> the app. The user saves it, then creates a story notes markdown file and saves that. Saving files
> also commits to git.

Every noun in that paragraph exists as a shape today. None of it is on screen.

## What is already built

| Piece | Where | State |
| --- | --- | --- |
| Bible index + ranked, budgeted `query()` | `@vn/bible` | shipped, no UI |
| `bible.search` | `commands/bible.ts` | shipped; reachable from the palette, CDP, and `search_bible` |
| Logical document tree (`DocTree`, `DocNode`, capped branches) | `main/doctree.ts`, `workspace.doctree` | shipped, no UI |
| Full file tree | `workspace.filetree` | shipped, no UI |
| Per-entity backlinks (`EntityLinks`: sheet, wiki, assets, scenes, shots) | `DocTree.backlinks`, keyed by node id | shipped, no UI |
| Character/location templates | `newCharacterDoc`, `newLocationDoc` in `@vn/model` | shipped, called by nothing in the app |
| Entity round-trip + edit | `characterFromDoc` / `characterToDoc` / `applyCharacterEdit` | shipped |
| Commit-on-save, per owning repo | `Committer`, wired in `main/index.ts:315` | shipped |

## What is missing

**No command reads a file's text.** All 48 commands project the model, the manifest or the tree;
none returns the bytes of `wiki/history.md`. An editor cannot open a document.

**No command writes an authored markdown document.** `story.*` writes scene prose and `gate.approve`
writes an approved portrait into `character.md`, but there is no path for "the author edited this
markdown file and saved it". Commands are the only write path, so this is a command-shaped hole,
not something an editor may work around.

**No editor draws a tree, a backlink panel or a markdown file.** `EDITORS` has eight entries; none
of them is the sidebar or the wiki.

## Decisions to settle

Recorded here with a leaning, in the shape [the migration
report](../research/codebase-migration-for-new-requirements.md#decisions-a-plan-must-settle-collected)
uses. Each is settled before the step that depends on it.

| # | Decision | Leaning |
| --- | --- | --- |
| 1 | Sidebar as a pane, or as path.ux sidebar panels on every editor | **A pane** — a ninth editor, `documents` |
| 2 | Does the wiki editor read through `@vn/bible` | **No.** A new `doc.read`; `Bible` never grows a whole-file API |
| 3 | Character sheets: raw markdown or a structured form | **Raw markdown**, re-parsed on save, diagnostics shown |
| 4 | Which namespace writes a document | **A new `doc.*`** — it spans `wiki/`, `characters/`, `locations/` |
| 5 | What a save does when the file moved underneath | **Refuse**, in undo's spirit — never guess |
| 6 | Where the backlink panel lives | **In the documents editor**, under the tree |

### 1. The sidebar is a pane

The requirements say "there is a sidebar", and path.ux does have real sidebar panels per area. Make
it an editor anyway. `apps/desktop/src/shared/editors.ts` is the vocabulary `view.open`/`view.focus`
speak, the palette offers, the agent drives and a stored layout names; a pane is persisted by the
`pathux.layout` blob that already exists and can be split, torn out or docked anywhere. Per-editor
sidebar panels would need a second addressing vocabulary and a second persistence story to be
scriptable at all. A left-hand pane the author splits once satisfies the requirement and costs
nothing new.

Two editors get added, taking the list to ten: `documents` (the tree and the backlinks) and `wiki`
(one markdown document). Both must be added to `EDITORS` **and** registered under matching area
names — the shell warns at boot when the two disagree, and `registerEditor(cls, 'vn.Name')` is
mandatory, because `loadSTRUCT` answers an unknown struct or area name by silently falling back to
the first registered class.

### 2. Reading a file is not a hole in the bible's guarantee

`@vn/bible` deliberately has no whole-file API, and that absence is what keeps the bible out of the
agent's context window ([`../story-bible.md`](../story-bible.md)). A human reading their own note on
screen is not that, and `docs/story-bible.md` already anticipates it: "a surface wanting a whole file
opens it itself."

The rule this plan must not break is narrower than "nobody reads a file": it is that **the read must
not go through `Bible`**. The moment the interface grows `read()`, the guarantee stops being a
property of the code. So the wiki editor reads through a new `doc.read` command against the
workspace, and `@vn/bible` is untouched by this plan.

### 3. Raw markdown, re-parsed on save

The requirements say the author edits the markdown, so the editor is a text surface, not a form over
`Character`. That risks a save that breaks the round-trip or drops `outfits:`. The rule:

- Front-matter that will not parse at all → **refuse the save** and say so. Identity lives there, and
  a file whose front-matter is gone is a file the model can no longer place.
- Front-matter that parses but fails the entity schema → **save, and show the diagnostic.** An author
  mid-thought must not be trapped by a half-typed field, and `loadInputs` already reports a mistagged
  or malformed sheet as a diagnostic rather than throwing.

That split is the same one `loadInputs` draws, so the editor is not inventing a policy.

### 4. `doc.*`, not `wiki.*`

The documents this reaches are `wiki/**`, `characters/<id>/character.md` and `locations/<id>.md` — a
character tagged `type:` under `wiki/` is authored in either place, per [entity discovery by meta
tag](entity-discovery-by-meta-tag.md). `wiki.write` would be a lie about half of them. Three
commands:

- `doc.read(path)` — non-mutating; the bytes of one workspace text file, bounded, with the mtime it
  was read at.
- `doc.write(path, text, seenAt)` — mutating, **undoable**, committed by the `Committer` into
  whichever repo owns the path.
- `doc.create(kind, id)` — `character` | `location` | `note`; writes the template and returns the
  path. Mutating, undoable.

All three refuse a path outside the workspace, and `doc.write`/`doc.create` refuse `scenes/**`
outright — prose has exactly one write path and this is not it. `write_file` in `@vn/authoring`
already sets that precedent and its refusal names `edit_scene`; these name `story.*`.

### 5. A save over a moved file refuses

`gate.approve` writes `character.md` too, and the agent can write any of these files. The editor
therefore holds no authoritative buffer: `doc.read` returns the mtime it read, `doc.write` carries it
back as `seenAt`, and a mismatch is a refusal with a sentence — the same choice undo makes when the
worktree has drifted. Cheap, honest, and it never merges.

### 6. The backlink panel is part of the documents editor

The Inspector is the other candidate, but its subject is `ui.taskHash` — machine identity, a
different axis from the authored selection. Clicking a character in the tree should not have to
travel through a second pane to answer "which scenes is she in". The panel is a section under the
tree, fed by `DocTree.backlinks[nodeId]`, which is already keyed exactly that way.

## Steps

Cheapest-first, each independently shippable and verifiable. Steps 1 and 5 are backend; 2–4, 6 are
editors. Independent of the React shell's deletion, but easier after it — one shell to keep in sync
instead of two.

### 1. `doc.read`

The read command and the session method behind it. Bounded (refuse a file over ~1 MB by name rather
than shipping it over IPC), text only, workspace-relative path in and out. Nothing draws it yet — it
is verified through the palette and `vn-cdp.mjs`, which is how `workspace.doctree` was debugged
before any sidebar existed.

### 2. The `documents` editor — document-tree mode

The ninth editor. `workspace.doctree` on open and after a `command:ui` write effect; the five
branches (Story → scenes → shots, Characters, Locations, Wiki, Assets by kind) as an expand/collapse
tree. Clicking a node publishes the authored selection — `ui.sceneId`, `ui.shotId`, `ui.characterId`
— which every other editor already observes, so the tree steers the app without knowing what is open.

The rules go in a pure `pathux/doctree.ts` with a `tests/` sibling: flatten a `DocNode[]` plus an
expansion set into rows, toggle, and the `kind → selection field` mapping. A `more` node is inert and
says how many were dropped — the cap is in the shape, and a truncated branch must not be drawable as
a complete one.

### 3. File-tree mode

A toggle in the editor header, backed by `workspace.filetree`. Same row-flattening core, different
source. Remembered per pane, so a torn-out sidebar keeps its mode.

### 4. The backlink panel

Under the tree, fed by `DocTree.backlinks[selectedNodeId]`: the sheet, the wiki file when the sheet
lives under `wiki/`, base assets by kind with their accepted state, the scenes and the shots. Each
row navigates — a scene row publishes `ui.sceneId`, an asset row opens it, the sheet row opens the
`wiki` editor on it.

### 5. `doc.write` and `doc.create`

The write path, with the refusals decision 4 and 5 name, `undoable: true` so the shadow-snapshot
journal covers them, and no `commitsItself`, so the `Committer` makes the commit — which is what
makes "saving files also commits to git" true without new machinery.

`doc.create` uses `newCharacterDoc` / `newLocationDoc` for the two entity kinds and a title-only stub
for a note, and picks the conventional home (`characters/<id>/character.md`,
`locations/<id>.md`, `wiki/<id>.md`) — the same homes `loadInputs` creates into today.

### 6. The `wiki` editor

The tenth editor: one markdown document as a raw text surface in the shadow root, with its own sheet
via `adoptStyle`. Opens on the tree's selection, saves on Ctrl+S and on blur, shows the diagnostics
decision 3 describes on a footer line, and stops its own keydown — the screen keymap is a
bubble-phase window listener, so otherwise `/` opens the palette mid-sentence.

No markdown preview in this step; see [Out of scope](#out-of-scope).

### 7. Docs and tracker

[`../desktop-app.md`](../desktop-app.md) gets its two new editor sections; [`../story-bible.md`](../story-bible.md)
gets the sentence about why a human surface may read a whole file when the agent may not;
[`../document-tree.md`](../document-tree.md) loses its "no UI yet" framing; the `doc.*` commands land
in [`../command-system.md`](../command-system.md); `CLAUDE.md`'s editor count and command count move.
This plan's row, [`index.md`](index.md) and [`refactorTaskList.md`](refactorTaskList.md) get marked.

## Out of scope

- **Rendered markdown preview.** A split preview is a want, not a requirement, and the editor is
  useful without it. It can land later behind a header toggle with no shape changes.
- **The "generate character assets" button** the requirements describe next to the character file.
  That is gate and pipeline surface — it belongs with the one gate surface the rewrite plan names,
  not with a document editor.
- **Editing scenes here.** `scenes/<id>.md` is refused by `doc.write`. The Script editor owns prose.
- **Embeddings.** `@vn/bible`'s ranking is behind `query()` and swappable without a caller changing;
  nothing in this plan makes that harder or easier.
- **A search results pane.** `bible.search` is reachable from the palette and returns `file:line`
  excerpts. A pane that lists them and jumps into the wiki editor is an obvious follow-on and is
  deliberately not bundled here.

## Acceptance

Demonstrated live in the shell, against `examples/mySampleRepo`: split a `documents` pane; the tree
shows the story, cast, locations, wiki and assets; click a character and the panel lists her sheet,
her base art, and the scenes and shots she is in; create a character from the tree and the template
opens in the `wiki` editor; type, save, and `git log` in the owning repo shows the commit; switch to
file-tree mode and the new file is there; `bible.search` from the palette finds a phrase typed into a
new note. Save over a file changed underneath refuses with a sentence. `pnpm check`, `pnpm test`,
`pnpm lint`, `pnpm build` green.

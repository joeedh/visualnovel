# Wiki and document-tree editors

Status: **shipped** — see [What shipped, and where it deviated](#what-shipped-and-where-it-deviated).
Item 12 of [`refactorTaskList.md`](../refactorTaskList.md). The
panes for the backends that items 3 and 9 shipped — a sidebar that draws the document tree and the
file tree, a backlink panel behind a character, and a markdown editor for the story bible — plus the
read and write commands they need, which did not exist.

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
([`../designRequirementsEtc.md`](../../designRequirementsEtc.md) §Authoring):

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
| Character/location templates | `newCharacterDoc(name)`, `newLocationDoc(name)` in `@vn/model` | shipped; called by the agent's `create_character` / `create_location`, by no surface |
| Read/write of an arbitrary workspace file, with both refusals | `read_file` / `write_file` in `@vn/authoring` (`tools.ts`) | shipped as **agent tools only**; reachable from the desktop solely through `agent.run` |
| Entity round-trip + edit | `characterFromDoc` / `characterToDoc` / `applyCharacterEdit` | shipped |
| Commit-on-save, per owning repo | `Committer`, wired in `main/index.ts:315` | shipped |

## What is missing

**No _command_ reads a file's text.** All 48 commands project the model, the manifest or the tree;
none returns the bytes of `wiki/history.md`. An editor cannot open a document — only the agent can,
and only by being asked in English.

**No _command_ writes an authored markdown document.** `story.*` writes scene prose and
`gate.approve` writes an approved portrait into `character.md`, but there is no path for "the author
edited this markdown file and saved it". Commands are the only write path, so this is a
command-shaped hole, not something an editor may work around.

**But the rules are not missing.** `read_file`/`write_file` already implement both refusals this
plan needs — outside-the-workspace via `resolveInWorkspace`, and `scenes/` via `guardedBy`, whose
message names `edit_scene`. So steps 1 and 2 **promote** that pair to commands and share its
guards; they do not reimplement them. `read_file` has no size bound today, which is a bug to fix
once, in the shared place, rather than to avoid only in the new command.

**No editor draws a tree, a backlink panel or a markdown file.** `EDITORS` has eight entries; none
of them is the sidebar or the wiki.

## Decisions to settle

Recorded here with a leaning, in the shape [the migration
report](../../research/codebase-migration-for-new-requirements.md#decisions-a-plan-must-settle-collected)
uses. Each is settled before the step that depends on it. Decisions 7–11 came out of the audit:
each is a place where a step named a mechanism the code does not have.

| # | Decision | Leaning |
| --- | --- | --- |
| 1 | Sidebar as a pane, or as path.ux sidebar panels on every editor | **A pane** — a tenth editor, `documents`, beside the ninth, `wiki` |
| 2 | Does the wiki editor read through `@vn/bible` | **No.** A new `doc.read`; `Bible` never grows a whole-file API |
| 3 | Character sheets: raw markdown or a structured form | **Raw markdown**, re-parsed on save, dispatched by `type:` tag |
| 4 | Which namespace writes a document | **A new `doc.*`**, over the agent tools' guards — it spans `wiki/`, `characters/`, `locations/` |
| 5 | What a save does when the file changed underneath | **Refuse on a content-hash mismatch** — the idiom undo and drift both already use |
| 6 | Where the backlink panel lives | **In the documents editor**, under the tree |
| 7 | How a pane learns a write happened | **`onExec`**, plus the `undo` effect. There is no write effect to listen for |
| 8 | How an editor names the document it is showing | **A fifth selection field, `ui.docPath`**, and `view.open` grows an optional subject |
| 9 | How a whole document is recorded in the provenance log | **A digest.** `props` and `invocation` store `sha256` + byte length, never the text |
| 10 | When a save happens | **Ctrl+S only.** Blur marks dirty; it does not commit |
| 11 | Where a pane's own mode is remembered | **`registerEditor` gains an optional `fields`** — nothing else can extend a closed struct |

### 1. The sidebar is a pane

The requirements say "there is a sidebar", and §UX says it in the editor's own vocabulary:

> Each editor can optionally have a header …, a footer, and **sidebar panels**.

Make it an editor anyway — but for one reason, not two. **Persistence is not the reason.**
`Area.STRUCT` already carries `panelLayout` and `saved_uidata`
(`vendor/path.ux/scripts/screen/ScreenArea.ts:650-657`), `VnEditor` inherits it, per-panel widget
state is id-keyed (`dock_panels.ts:842`), and the whole thing round-trips inside the `pathux.layout`
blob `persist.ts` already saves and restores. Placement, size, collapse, float rect and tab grouping
would all be free. (The legacy `SideBar` on `simple.Editor` _is_ unreachable — `VnEditor extends
Area` — so the supported hooks are `definePanels`/`makePanels`.)

The reason is **addressing**. `apps/desktop/src/shared/editors.ts` is the vocabulary
`view.open`/`view.focus` speak, the palette offers, the agent drives and a stored layout names. A
panel id is class-scoped, has no DataAPI path and no command, so "open the document tree" would have
to resolve an (area instance, panel id) pair that nothing else in the app names — a second
addressing vocabulary for one surface. A left-hand pane the author splits once satisfies the
requirement and costs nothing new.

§UX's sentence is satisfied later, not contradicted: sidebar panels remain the right tool for
_secondary_ surfaces inside an editor, and this plan's backlink panel (decision 6) is one candidate
if it ever wants to collapse independently.

Two editors get added, taking the list to ten: `documents` (the tree and the backlinks) and `wiki`
(one markdown document). Each is **three** edits, not two, and the third is the easy one to miss:

1. an entry in `EDITORS` (`shared/editors.ts`),
2. `registerEditor(cls, 'vn.Name')` in the editor module — mandatory, because `loadSTRUCT` answers
   an unknown struct _or_ area name by silently falling back to the first registered class,
3. an **import of that module in `pathux/shell.ts`**, purely for the registration side effect.
   Without it the editor exists, `EDITORS` advertises it, and every `view.open` on it answers "This
   build has no X editor" (`pathux/view.ts:43`).

The boot check that is supposed to catch this is weaker than it reads: `shell.ts:189-195` reports
only ids in `EDITORS` that nothing registered, is `console.warn`, and has no test. The reverse
mistake — registered but absent from `EDITORS` — is silent, yet the editor still appears in path.ux's
own area-switcher `+` menu (`area_base.ts:34-59` enumerates `areaclasses` and skips only
`AreaFlags.HIDDEN`). Step 3 makes the check bidirectional and puts a test behind it.

### 2. Reading a file is not a hole in the bible's guarantee

`@vn/bible` deliberately has no whole-file API, and that absence is what keeps the bible out of the
agent's context window ([`../story-bible.md`](../../story-bible.md)). A human reading their own note on
screen is not that, and `CLAUDE.md` already anticipates it: "a surface wanting a whole file opens it
itself."

The rule this plan must not break is narrower than "nobody reads a file": it is that **the read must
not go through `Bible`**. The moment the interface grows `read()`, the guarantee stops being a
property of the code. So the wiki editor reads through a new `doc.read` command against the
workspace, and `@vn/bible` is untouched by this plan.

### 3. Raw markdown, re-parsed on save, dispatched by tag

The requirements say the author edits the markdown, so the editor is a text surface, not a form over
`Character`. That risks a save that breaks the round-trip or drops `outfits:`. Three rules:

- Front-matter that will not parse at all → **refuse the save** and say so. Identity lives there, and
  a file whose front-matter is gone is a file the model can no longer place.
- Front-matter that parses but fails the entity schema → **save, and show the diagnostic.** An author
  mid-thought must not be trapped by a half-typed field, and `loadInputs` already reports a mistagged
  or malformed sheet as a diagnostic rather than throwing.
- Front-matter that **drops a `type:` tag the file had when it was read** → **refuse.** Under
  [entity discovery by meta tag](entity-discovery-by-meta-tag.md) the tag _is_ the entity: deleting
  it removes the character from the model and breaks every backlink, which is an entity deletion
  wearing an edit's clothes. Deleting an entity is a real act and should look like one.

The first two are the same split `loadInputs` draws, so the editor is not inventing a policy. The
third is the price of the tag rule — and it is why **dispatch is by the tag in the incoming text, not
by the directory the file sits in**. A character filed under `wiki/**` is a character; a note under
`characters/` that carries no tag is a note.

### 4. `doc.*`, not `wiki.*` — over the guards that already exist

The documents this reaches are `wiki/**`, `characters/<id>/character.md` and `locations/<id>.md` — a
character tagged `type:` under `wiki/` is authored in either place. `wiki.write` would be a lie about
half of them. Three commands:

- `doc.read(path)` — non-mutating; the bytes of one workspace text file, bounded, with the content
  hash it was read at.
- `doc.write(path, text, seenHash)` — mutating, **undoable**, committed by the `Committer` into
  whichever repo owns the path.
- `doc.create(kind, name)` — `character` | `location` | `note`; writes the template and returns the
  path. Mutating, undoable. **`name`, not `id`**: `newCharacterDoc(name)` derives the id as
  `slug(name)`, and the two scaffolders must not disagree about which is authoritative.

All three refuse a path outside the workspace, and `doc.write`/`doc.create` refuse `scenes/**`
outright — prose has exactly one write path and this is not it. Both refusals are **the same code**
`write_file` runs (`resolveInWorkspace`, `guardedBy`), lifted to where both callers reach it, with
the refusal message naming `story.*` or `edit_scene` depending on who asked. Two implementations of
"refuse `scenes/`" would drift, which is the argument `@vn/scriptedit` was extracted on.

`doc.create` shares one scaffolder with `create_character`/`create_location` for the same reason: one
authorial act, one answer. Note the "template" is thin — `id`, `name`, an empty body — which is what
"the app initializes it with a template" gets today; enriching it is a separate, uncontroversial
change to `@vn/model` that both callers inherit.

### 5. A save over a changed file refuses — by content, not by clock

`gate.approve` writes `character.md` too, and the agent can write any of these files. The editor
therefore holds no authoritative buffer: `doc.read` returns `sha256` of the bytes it read,
`doc.write` carries it back as `seenHash`, and a mismatch is a refusal with a sentence.

**Not mtime.** Undo compares git **tree shas** (`undo.check` → `writeTree`/`treeOf`), and drift
compares `Shot.proseHash` re-derived on read; both are content. A timestamp moves for reasons that
are not edits — `writeFileAtomic` renames a temp file over the target, and `applyTree` restores via
`git read-tree -u --reset`, rewriting every file — so an mtime check would make one undo turn every
open buffer un-saveable with bytes that never changed. That is the "never guess" rule inverted into
"always refuse". Identical content is not a conflict; changed content is.

### 6. The backlink panel is part of the documents editor

The Inspector is the other candidate, but its subject is `ui.taskHash` — machine identity, a
different axis from the authored selection. Clicking a character in the tree should not have to
travel through a second pane to answer "which scenes is she in". The panel is a section under the
tree, fed by `DocTree.backlinks[nodeId]`, which is already keyed exactly that way.

### 7. A pane learns about a write from `onExec`, not from an effect

There is no write effect to listen for. `UiEffect` has exactly four variants — `palette`, `view`,
`undo`, `workspace` (`shared/ipc.ts:69-92`) — and the `undo` effect, though pushed after every
command, carries a `revision` that "counts undo/redo moves **only**"; the bridge answers it by
refetching `workspace:index` alone.

The two shipped idioms are `onExec` (`pathux/bridge.ts:61`, which `agent.ts` already uses) and each
editor bumping a private `revision` after its own exec. The `documents` editor therefore refetches on
**any** `ok` outcome from a mutating command, plus on the `undo` effect for undo/redo. That is
deliberately coarse — a tree is cheap and correctness beats precision here.

Rejected: adding `{ type: 'invalidate'; what: 'doctree' }` to `UiEffect`. It is a `shared/ipc.ts`
shape change plus a main-side decision about which commands invalidate what, to save a refetch that
already costs one `loadProject` the session caches. If the coarse refetch measures badly, that is
the escape hatch, and it is a follow-on rather than a prerequisite.

### 8. The selection grows a fifth field, `ui.docPath`

`ShellState` holds `sceneId`, `shotId`, `characterId`, `taskHash` and nothing else, and
`pathux/persist.ts:27` states the invariant outright:

> Selection is three ids and nothing else — a widget binds to `ui.*`, never to a document.

That comment was written when no editor had a document. It is now the thing in the way: without a
document slot the wiki editor's subject is unrepresentable, "the sheet row opens the `wiki` editor on
it" has no channel, and a location node has nothing to publish either (there is no `ui.locationId`).

So the invariant is **amended, not ignored** — the comment is rewritten in the same commit. Adding
`ui.docPath` is four synchronized edits (`state.ts`, `api.ts`'s path registration, `persist.ts`'s
`StoredSelection` + save/restore + watch list, and `selection.ts`), which is exactly why it is a
decision rather than a step detail. A path, not an id: the document is the workspace-relative path,
because that is what `DocNode.path` and `EntityLinks.sheet` already carry.

`view.open`/`view.focus` grow an **optional** subject prop alongside `editor` + `where`, so
"open the wiki editor on `wiki/history.md`" is one invocation. Without it the agent can only open the
editor and then set the selection, which is two acts for one intent and races.

`OpenWhere` also grows `'left'` (and `'above'`): it is `'here' | 'right' | 'below'` today, and the
whole case for a pane rests on scriptability — an agent that cannot say "documents on the left" makes
that case weaker for no reason.

### 9. A document is recorded in the log as a digest

`CommandRecord.props` is persisted verbatim to `vngen/state/commands.jsonl`, and `invocation` is
`formatCommand(id, props)`, which quotes and `\n`-escapes every string. No existing mutator carries a
document — `story.setLineText` carries one line. A 50 KB note would therefore cost ~100 KB of append
per save, and `invocation` would stop being what `CLAUDE.md` sells it as: a copy-pasteable repro
line.

So the prop spec gains a **`digest`** flag. A digested prop is recorded as `sha256` + byte length and
rendered by the DSL as `text=<sha256:ab12…+51200>`; the bytes live in the file and in the undo
snapshot, which is where a document belongs. The command still receives the real value — this is a
projection at record time only, in `@vn/commands`, so any future bulk prop inherits it.

A digested invocation is not re-executable, which is honest: replaying a 50 KB overwrite from a log
line was never going to be the recovery path. Undo is.

### 10. Save is Ctrl+S; blur marks dirty

The requirement is "The user saves it" — an explicit act. Save-on-blur would make it implicit, and
implicit is expensive here: every `doc.write` is `undoable`, so it captures pre **and** post trees
with `git add -A` in every owned repo, and the `Committer` then commits `-A` per repo. That is a
commit and two whole-worktree snapshots per focus change.

So: Ctrl+S saves, a dirty badge shows unsaved state, and closing a dirty pane prompts. Autosave, if
it is ever wanted, is a draft file that is not a command — not a `doc.write` on a timer.

### 11. Per-pane state needs `registerEditor` to grow `fields`

`registerEditor` closes the struct — `cls.STRUCT = nstructjs.STRUCT.inherit(cls, VnEditor,
structName) + '\n}'` (`pathux/editor.ts:105-110`) — and no shipped editor declares a field of its
own. CLAUDE.md forbids registering by hand, so "remembered per pane" has no mechanism today.

`registerEditor(cls, name, fields?)` splices declarations before the closing brace, with a
round-trip test (write a screen, read it back, assert the field survived) — which is the change that
keeps the "never by hand" rule intact instead of making the first editor with state break it. The
file-tree toggle is then a real per-pane field, so a torn-out sidebar genuinely keeps its mode.

If that proves fiddly, the fallback is a shell-global session key and the requirement is met more
weakly; step 5 says which one shipped.

## Steps

Reordered so each step is genuinely shippable on its own. The old order put the backlink panel
third, though it depends on the write path, the wiki editor and decision 8. Steps 1–2 are backend;
3–6 are editors. Independent of the React shell's deletion, and easier now that it has happened —
one shell to keep in sync instead of two.

Steps 3–6 all touch `renderer/api.ts`'s `fallback` `DesktopApi`, which switches on channel name and
is used whenever `window.api` is absent (the browser design preview). It has **no** branch for
`workspace:doctree` or `workspace:filetree` today — they fall through to `default:
Promise.resolve(undefined)`, harmless only because nothing draws them. Every new channel gets a
fallback branch in the step that introduces it, or the preview breaks the moment the editor calls it.

### 1. `doc.read`

The read command and the session method behind it. Bounded (refuse a file over ~1 MB by name rather
than shipping it over IPC), text only, workspace-relative path in and out, `sha256` of the bytes out
alongside the text. The bound and the two refusals are lifted to a shared helper that `read_file`
then uses too, closing its unbounded read in the same move.

Nothing draws it yet — it is verified through the palette and `vn-cdp.mjs`, which is how
`workspace.doctree` was debugged before any sidebar existed. Main-side tests for the refusals: a path
outside the workspace, a file over the bound, a binary file, a missing file.

### 2. `doc.write` and `doc.create`

The write path, with the refusals decisions 3, 4 and 5 name, `undoable: true` so the shadow-snapshot
journal covers them, and no `commitsItself`, so the `Committer` makes the commit — which is what
makes "saving files also commits to git" true without new machinery. `text` is declared `digest` per
decision 9, which lands in `@vn/commands` in this step with its own test.

`doc.create(kind, name)` shares `newCharacterDoc` / `newLocationDoc` with the agent's create tools
and adds a title-only stub for a note, picking the conventional home
(`characters/<id>/character.md`, `locations/<id>.md`, `wiki/<id>.md`).

Tests are main-side (the desktop jest project is node-only, so this is where the cheap coverage is)
and concentrate on the refusals, because that is where the risk is: `scenes/**`, outside the
workspace, a stale `seenHash`, unparseable front-matter, a dropped `type:` tag, and `doc.create` over
an existing path.

### 3. The `wiki` editor

The ninth editor, and the one that demonstrates the requirement's core sentence end-to-end: open a
markdown file, type, Ctrl+S, see the commit. One document as a raw text surface in the shadow root
with its own sheet via `adoptStyle`, the diagnostics of decision 3 on a footer line, a dirty badge,
and its own keydown stopped — the screen keymap is a bubble-phase window listener, so otherwise `/`
opens the palette mid-sentence.

Shell seams land here, because this is their first consumer: `ui.docPath` (decision 8, four
synchronized edits plus the rewritten `persist.ts` comment), the optional subject on
`view.open`/`view.focus`, `'left'`/`'above'` on `OpenWhere`, and the bidirectional boot check with a
test behind it (decision 1). Until step 4 the editor is opened by `view.open(editor='wiki'
subject='wiki/history.md')` from the palette or CDP — which is also how the seam gets verified before
a tree exists.

No markdown preview; see [Out of scope](#out-of-scope).

### 4. The `documents` editor — document-tree mode

The tenth editor. `workspace.doctree` on open, refetched per decision 7. The five branches (Story →
scenes → shots, Characters, Locations, Wiki, Assets by kind) as an expand/collapse tree. Clicking a
node publishes the authored selection — `ui.sceneId`, `ui.shotId`, `ui.characterId`, and now
`ui.docPath` — which every other editor already observes, so the tree steers the app without knowing
what is open.

The rules go in a pure `pathux/doctree.ts` with a `tests/` sibling: flatten a `DocNode[]` plus an
expansion set into rows, toggle, and the `kind → selection field` mapping. A `more` node is inert and
says how many were dropped — the cap is in the shape, and a truncated branch must not be drawable as
a complete one.

### 5. File-tree mode

A toggle in the editor header, backed by `workspace.filetree`. Same row-flattening core, different
source. Remembered per pane via decision 11's `fields`; if that lands as a shell-global key instead,
this step says so.

### 6. The backlink panel

Under the tree, fed by `DocTree.backlinks[selectedNodeId]`: the sheet, the wiki file when the sheet
lives under `wiki/`, base assets by kind with their accepted state, the scenes and the shots. Each
row navigates — a scene row publishes `ui.sceneId`, an asset row opens it, the sheet row opens the
`wiki` editor on it (which is why this step follows 3 and 8).

**The `vnasset://` handler must learn the base root first.** It resolves `ProjectPaths.assetFile` →
`vngen/build/assets/` only, while base art — portraits and model sheets, exactly what a character's
backlinks are — lives at `assets/objects/` behind `baseAssetFile`. Every current `vnasset://`
consumer shows shot frames or task outputs, so nobody has hit this. `EntityLinks.assets[].base`
already says which root an entry is in, so the fallback is small; without it, this panel lists hashes
without images.

### 7. Docs and tracker

[`../desktop-app.md`](../../desktop-app.md) gets its two new editor sections **and** its "all eight"
count at `:122`; [`../story-bible.md`](../../story-bible.md) gets the sentence about why a human surface
may read a whole file when the agent may not; [`../document-tree.md`](../../document-tree.md) loses its
"no UI yet" framing; the `doc.*` commands land in
[`../command-system.md`](../archive/command-system.md) — whose "Forty-seven, in nine namespaces" at `:252` is
**already stale** against 48 and becomes **51 in ten namespaces** — plus its per-namespace list;
[`../desktopAppState.md`](../../desktopAppState.md) gains `ui.docPath` in category 2 and the per-pane
mode field if decision 11 lands that way; `CLAUDE.md`'s editor count (`:307`) and command count move.
This plan's row, [`index.md`](../index.md) and [`refactorTaskList.md`](../refactorTaskList.md) get marked.

## Out of scope

- **Rendered markdown preview.** A split preview is a want, not a requirement, and the editor is
  useful without it. It can land later behind a header toggle with no shape changes.
- **The "generate character assets" button** the requirements describe next to the character file.
  That is gate and pipeline surface, not a document editor's — and the gate surface it would sit on
  **shipped** with item 1, which now has no open row to receive it. So it gets its own:
  [`refactorTaskList.md`](../refactorTaskList.md) item 13. A pointer at a finished item is exactly the
  ping-pong this plan exists to end.
- **Editing scenes here.** `scenes/<id>.md` is refused by `doc.write`. The Script editor owns prose.
- **Embeddings.** `@vn/bible`'s ranking is behind `query()` and swappable without a caller changing;
  nothing in this plan makes that harder or easier.
- **A search results pane.** `bible.search` is reachable from the palette and returns `file:line`
  excerpts. A pane that lists them and jumps into the wiki editor is an obvious follow-on and is
  deliberately not bundled here.
- **A `doctree` invalidation effect.** Decision 7's escape hatch, deliberately not taken up front.

## Acceptance

Demonstrated live in the shell, against `examples/mySampleRepo`: split a `documents` pane on the
**left**; the tree shows the story, cast, locations, wiki and assets; click a character and the panel
lists her sheet, her base art **with thumbnails**, and the scenes and shots she is in; create a
character from the tree and the template opens in the `wiki` editor; type, Ctrl+S, and `git log` in
the owning repo shows one commit; switch to file-tree mode, tear the pane out, and the mode survives;
the new file is in the tree without a remount; `bible.search` from the palette finds a phrase typed
into a new note. Save over a file changed underneath refuses with a sentence — and save over a file
merely _rewritten identically_ (undo, then save) succeeds. `commands.jsonl` shows the save as a
digest, not as the document. `pnpm check`, `pnpm test`, `pnpm lint`, `pnpm build` green.

## What shipped, and where it deviated

All seven steps landed, and Acceptance was run live against `examples/mySampleRepo` in full: the
pane on the left, the five branches, Aiko's panel with her sheet, model sheets and portrait, the
sheet row opening the `wiki` editor, Ctrl+S taking a commit, the changed-underneath refusal, the
identical-rewrite save succeeding, the FILES/DOCUMENTS toggle surviving a tear-out, a created
character appearing in the tree with no remount, and `bible.search` finding a phrase typed into a
new note. `commands.jsonl` records the save as `<sha256:bcded73b562b+566>`.

Three things are not what the steps said:

- **Decision 10's "closing a dirty pane prompts" became a module-level `drafts` map** keyed by path,
  plus a `beforeunload` guard. `UIBase.on_remove()` cannot veto its own removal — path.ux has already
  decided by the time it runs — so a prompt there could only have been a prompt *after* the pane was
  gone. Keeping the draft is the better answer anyway: a pane torn out and reopened comes back to the
  unsaved text, and the only thing that can lose it is a reload, which `beforeunload` warns about.
- **Step 6's "an asset row opens it" became an in-place enlargement.** No editor shows a bare image,
  and a second window for a portrait is a worse answer than a bigger tile — so a thumbnail clicked
  grows to the panel's width (`.dt-thumb.big`) and clicked again shrinks back.
- **A New… row landed in the documents editor that no step names.** Acceptance requires creating a
  character from the tree, and `doc.create` shipped in step 2 with no surface — the steps simply
  never said which pane calls it. path.ux has no prompt or dialog helper, so it is a kind select and
  a name box in the pane's own shadow root, opened from the header, committing on Enter and opening
  what it wrote. A refusal leaves the row up over the name that earned it.

## What the audit changed

The first draft was pressure-tested against the code before any of it was built. Eighteen findings;
the five that changed the plan's shape became decisions 7–11, each one a mechanism a step had named
that does not exist: a write effect to refresh on, a selection slot for a document, an unclosed
struct to hang per-pane state on, a provenance log that could hold a document, and an mtime check
that would have made one undo lock every open buffer.

Three findings were corrections of fact rather than of design, and are worth keeping visible because
each was an argument resting on something untrue: decision 1 originally rested partly on path.ux
having no per-panel persistence, which it has; `newCharacterDoc` was described as called by nothing,
when the agent's create tools call it; and the refusals `doc.*` needs were framed as new work, when
`write_file` already implements both. The conclusions survived in each case — the reasoning did not,
and a plan whose reasons are wrong is a plan that gets re-litigated during the build.

The rest were sharpenings folded into the steps: the fallback `DesktopApi` branch every new channel
needs, `OpenWhere` lacking `'left'`, `vnasset://` not reaching the base root, the one-directional
untested boot check, the third registration edit in `shell.ts`, the step reorder, the missing tests
for the refusals, and the doc targets step 7 had not counted.

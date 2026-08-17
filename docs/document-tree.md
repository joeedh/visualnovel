# Document tree and backlinks

The sidebar's two shapes, as shipped: a **logical document tree** over what a project *is*, and
per-entity **backlinks** answering "what is this character attached to". Both come off one channel,
`workspace:doctree`; a second channel, `workspace:filetree`, serves the tree's other mode — every
file actually on disk.

The pane that draws them is the `documents` editor
([`desktop-app.md`](desktop-app.md#documents)); this page is the shape underneath it. Plan and the
reasoning behind each decision:
[`plans/document-tree-and-backlinks.md`](plans/document-tree-and-backlinks.md).

<!-- toc -->

- [What it is](#what-it-is)
- [The five branches](#the-five-branches)
- [Contracts](#contracts)
- [The file tree](#the-file-tree)
- [Where it lives](#where-it-lives)
- [Right-click menus](#right-click-menus)
- [Renaming in place](#renaming-in-place)
- [Deliberately absent](#deliberately-absent)

<!-- tocstop -->

## What it is

**A join, not a new source of truth.** Every edge the tree draws already exists on disk: entity
sheets carry the file they were discovered in ([entity discovery by tag](plans/entity-discovery-by-meta-tag.md)),
`Scene.characters` names the cast, `ShotSubject.characterId` names who is in frame,
`Asset.satisfies` names what a byte-stream is for, and `Bible.files()` names the wiki. This module
walks them once and shapes the result; it reads nothing else and writes nothing at all.

**Identity, not content.** A node says what it is, what to call it, and where it lives. No prose,
no excerpt, no image bytes — so the tree can be shipped over IPC whole, and a large project costs a
manifest parse rather than a corpus.

## The five branches

```
Story          scene:<id>            → shot:<sceneId>/<shotId>
Characters     character:<id>
Locations      location:<id>
Wiki           wikidir:<rel>         → wiki:<rel>
Assets         assetkind:<kind>      → asset:<hash>
```

- **Story** lists every scene in model order, each carrying its `scenes/<id>.md` path and its
  persisted shots as children. A scene with no `work/shots/<id>.json` has **no children at all** —
  not an empty list — because "not decomposed yet" and "decomposed into nothing" are different
  facts. A storyboard that will not parse badges that one scene `unreadable` rather than failing the
  whole sidebar.
- **Characters** and **Locations** come off the built model, each labelled by name and pathed to
  whichever file the `type:` tag was found in — `characters/aiko/character.md`, or
  `wiki/cast/aiko.md` if that is where the author filed it.
- **Wiki** is `Bible.files()` nested back into directories. Path, title, nothing else.
- **Assets** groups `AssetStore.manifest()` by `AssetKind`, each group labelled `base` or `project`
  by the same routing rule the store writes with (`isBaseKind`). The label describes what the asset
  *is*, so a legacy project whose base art is still indexed in the project manifest still groups
  correctly. A leaf is named, not hashed — see below. **Concepts** is one of those groups, and the
  only one the pipeline never plans: an `art.generate` sketch has no task in the graph, and the tree
  is the one place it is visible at all.

## Contracts

- **A node id is `kind:key`, and it is the join key.** `scene:greet`, `shot:greet/s1`,
  `character:aiko`, `wiki:history/the-war.md`, `asset:<hash>`. The backlink map is keyed by the same
  string, so a panel is a lookup rather than a second convention — and expansion state persists
  against these ids, which is why `character:aiko` must not become a path when the sheet moves.
- **An asset is named, and the hash is what a collision costs.** `labelAssets`
  (`apps/desktop/src/main/assetlabel.ts`, pure) turns the manifest's bindings into display names —
  `Aiko`, `Aiko — uniform / front`, `Café Mori — night`, `greet · s2`. The angle on a model sheet
  comes from the **task**, not the binding (`satisfies` binds only `{characterId, outfit}`, which
  four sheets share). Two assets landing on the same words *both* keep a `(hash8)` suffix, so a
  label is never quietly ambiguous, and one nothing in the model claims falls back to `hash8.ext`
  rather than inventing a name for bytes whose character has been deleted.
- **A concept is named by what was asked for.** It is the one kind whose name was *authored* rather
  than derived — the sentence itself, cut at a word boundary, after the subject it bound to:
  `Kōsei High — an aerial shot of the high school`. It is also the one kind that may legitimately
  bind to nothing, so it answers before a binding is required: unbound it is the title alone,
  titleless it is the entity it names, and with neither it falls back to the hash like any other
  orphan.
- **An asset node carries no `path`.** It is bytes in a content-addressed store, not a document —
  and a `path` is what the pane routes to the `wiki` editor, which would then `doc.read` a PNG.
  Clicking one names `ui.assetHash` instead and opens the `asset` editor.
- **A node carries identity, never a click action.** It would be tidy to ship the command
  invocation a click runs, the way an interaction target does — but selection is renderer state
  (`ui.sceneId`, `ui.shotId`, `ui.characterId`, `ui.docPath`, `ui.assetHash`), not something main
  decides, and *which editor is open* is something only the mesh knows. So the pane maps a node to
  a selection itself (`selectionForNode`) and then to an editor (`routeFor` in
  `pathux/route.ts`, over the `claims` each editor declares beside its name), and the tree stays a
  shape any surface can draw. The claim table is in
  [`desktop-app.md`](desktop-app.md#documents); what a click does stays the shell's business.
- **Paths are workspace-relative with `/` separators**, like the generated project map's — they are
  shown to a human, and an absolute path in a serialized shape is unportable.
- **A cap is a number in the shape.** A branch over its cap (50 by default) ends in one `more` node
  whose label counts the remainder, so a truncated branch can never be drawn as a complete one.
- **Backlinks come from the same walk.** `EntityLinks` gives an entity's sheet, its `wiki` path when
  that sheet lives under `wiki/`, its assets (with `accepted` and `base`), its scenes and its shots.
  An entity with no art gets an empty list, never a missing key.
- **A scene is a subject too, under `scene:<id>`.** Same shape, same walk: what illustrates a scene
  is the same question asked of a different key, and it is what lets a pane showing prose show the
  frames drawn from it. Only a scene's assets carry `shotId` — the shot the matched binding named —
  because for a character one frame can satisfy several, and the strip that groups by shot is the
  scene's.
- **`pathIndex` is the inverse of the key convention.** Workspace-relative document path → backlink
  key, one entry per entity sheet and per scene file, written by the loop that already knows both.
  A surface holding only a path — an open editor knows its document and nothing else — looks the
  key up rather than re-deriving one. A file that is not a subject is simply absent, and absence is
  the honest answer: no asset binds to a lore note. A path is claimed by the first subject
  discovered in it, because two `type:` tags in one file is a conflict the model already reports as
  a diagnostic and the index must not silently pick a winner.
- **"Which wiki notes mention Aiko" is a search, not a backlink.** The panel links the character's
  *own* sheet, because the tag index already knows that. Every other note that says her name is what
  `bible.search` finds — ranked and budgeted. Precomputing it would be a second, unbudgeted index
  over the one tree that was deliberately given a budget; see [`story-bible.md`](story-bible.md).

## The file tree

`workspace:filetree` is a separate walk answering a different question. It shares nothing with the
document tree but the `DocNode` type: every file under the workspace root, directories first,
`.git` and `node_modules` excluded, capped per level and bounded at 5000 files overall. It does
**not** consult git — a project that is not a repo still has files, and `.gitignore` semantics are
not what "view every file" asks for.

## Where it lives

| Piece | Where |
| ----- | ----- |
| Shapes (`DocNode`, `EntityLinks`, `DocTree`) | `apps/desktop/src/shared/ipc.ts` |
| The projection (`buildDocTree`, `fileTree`) — pure | `apps/desktop/src/main/doctree.ts` |
| Asset display names (`assetLabel`, `labelAssets`) — pure | `apps/desktop/src/main/assetlabel.ts` |
| The reads (one `loadProject`, one `readShots` per scene, `bible.files()`) | `WorkspaceSession.docTree()` / `.fileTree()` |
| Channels | `workspace:doctree`, `workspace:filetree` |
| Commands | `workspace.doctree`, `workspace.filetree` (non-mutating, no props) |

It sits in the desktop's main process rather than `@vn/authoring` because the walk needs
`AssetStore` and the persisted storyboards, neither of which `Workspace` opens, and exactly one
surface consumes the result. The commands exist so the palette and `scripts/vn-cdp.mjs` can read
the same tree the sidebar draws — which is how the shape got debugged before the sidebar existed,
and how it is still checked without one open.

## Right-click menus

Right-clicking a row opens a menu of **commands**, gated by `stack.check` before it is drawn. The
entries are a pure table, `menuFor(node)` in `renderer/pathux/doctree.ts`, so what a kind offers is
testable without a DOM; resolving a verdict into a drawn item is `renderer/pathux/contextmenu.ts`,
and opening the path.ux menu is `renderer/pathux/showmenu.ts`. The full write-up, including why an
entry is an invocation rather than a callback, is in
[`command-system.md`](command-system.md#from-a-right-click) and
[`plans/document-tree-context-menus.md`](plans/document-tree-context-menus.md).

| node kind | entries |
| --- | --- |
| `location` | New reference shot… · Art notes… · Open sheet elsewhere |
| `character` | New concept image… · Art notes… · Open sheet elsewhere |
| `branch:wiki`, `wikidir` | New wiki page… · New character sheet… · New location sheet… |
| `branch:characters` | New character sheet… |
| `branch:locations` | New location sheet… |
| `branch:story` | New scene… · Export Fountain |
| `asset` | Regenerate… · Accept · Approve as a portrait… · Promote to a plate… · Open in the Asset editor |
| `scene` | Assign line ids · New scene… · Export Fountain |
| `shot` | Set coverage… · Set outfit… |
| `branch:assets`, `assetkind`, `wiki`, `dir`, `file`, `more` | none — no menu opens at all |

Four things this table settles:

- **A right-click selects but does not open.** The menu acts on the node under the cursor, so the
  selection is published first — otherwise "Regenerate" and whatever the asset pane happens to be
  showing could disagree about which asset is meant. Routing to an editor stays the left click's
  job.
- **A branch heading offers what its subtree is made of**, because that is where an author reaches
  for "another one of these"; and a scene's menu is a **superset** of the story branch's, so the
  same two acts are in the same words wherever the pointer was. `branch:assets` is the one heading
  that offers nothing on purpose: an asset is rendered from a subject, never authored from a name.
- **Every act an asset has is offered, and each command refuses itself.** `asset.accept` refuses a
  portrait by naming `gate.approve` and a concept by naming `art.promote`; the menu shows all four
  with their refusals rather than guessing which applies. There is no _reject_: rejecting a
  candidate is approving a different one, and inventing the command inside a menu would be
  designing the gate through a menu.
- **A kind with nothing to offer is named, not skipped.** A wiki note is the interesting one —
  nothing binds to it, and `doc.write` needs the text, so its only act is the one a plain click
  already performs. `branch:wiki` is the exception among the headings, because it is a place: it is
  the "top level wiki tree" an author right-clicks, and the `wikidir:` nodes below it are the
  folders inside, which a flat `wiki/` never has at all.

**A right-click never moves the tree.** The gesture itself is innocent — Chromium fires no `click`
for button 2 — but path.ux closes a menu on **mouse-up**, so the click that dismisses one used to
land on whatever row the pointer was resting over and select or collapse it. `showmenu.ts` exports
`menuIsOpen()`, and the tree latches it at capture-phase **pointer-down**, which is the last moment
a menu is still open; the `click` that follows is swallowed. It self-clears in every case: escaped,
nothing was ever latched; taken from the menu, the pointer-down landed in the popup.

The asset editor's own header carries the same `asset` entries behind a `⋯` button, from the same
table — which is the check that `menuFor` is node-shaped rather than tree-shaped.

## Renaming in place

Double-clicking a row whose node names a document lets the author retype its name over the label.
Enter commits, Escape and blur abort, and a name that did not change writes nothing.

What is renamable is `renameOf(node)` in the pure `doctree.ts` — a `character`, `location` or
`wiki` node **carrying a path**, answering with the two props `doc.rename` takes, so the surface
never assembles them. An entity with no sheet of its own has nowhere to write the name. A **scene
is deliberately not renamable**: its label is its id, and its id is its filename, the config's
`start:` and every `[[goto:]]` pointing at it — one of those is a rename and the rest are a
refactor.

Two things behind the gesture:

- **The double click is counted, not listened for.** The first click selects, which rebuilds the
  rows — so the element both clicks landed on is gone before a `dblclick` could be dispatched. Two
  clicks on the same **node id** within 500 ms is the gesture, and the row is found again by
  `data-id`.
- **The rename is a command like any other.** `doc.rename` is `mutating` and `undoable`, so it
  commits, records and undoes through the same journal as `doc.write`; `renameInText` in
  `src/main/rename.ts` decides where the name lives — `name:` for a sheet, and for anything else
  wherever the title was **read** from (front-matter `title:`, else the first H1, else a heading is
  added), because writing anywhere else would leave the tree showing the old name. **The file never
  moves**: the id is derived from a name once, at creation.

## Deliberately absent

- **An agent backlink tool** — `vnauthor` authors inputs and stops at them; shots and assets are
  pipeline output.
- **Filesystem watching** — both trees are reads, refetched after a write like `story:graph`.
- **Moving and deleting through the tree** — a drag in a sidebar would have to dispatch the `story.*`
  commands that own those refusals, not open a new write path. Renaming is the one editing gesture
  the tree has, and it is that rule kept rather than broken: it is a registered command with its own
  check, reached from a double-click instead of the palette.
- **A menu entry that is not a command** — if an act is worth a right-click it is worth being in
  the palette, the catalog and the provenance log.

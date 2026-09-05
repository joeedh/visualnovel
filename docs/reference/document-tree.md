# Document tree and backlinks

The sidebar has two shapes: a logical document tree over what a project is, and per-entity
backlinks that show what a character is attached to. One channel, `workspace:doctree`,
serves both. A second channel, `workspace:filetree`, serves the tree's other mode, which
lists every file on disk.

The `documents` editor draws the pane
([`desktop-app-editors-misc.md`](desktop-app-editors-misc.md#documents)), and this page
describes what underlies it. The plan and the reasoning behind each decision are in
[`../plans/archive/INDEX.md#document-tree-and-backlinks`](../plans/archive/INDEX.md#document-tree-and-backlinks).

<!-- toc -->

- [What it is](#what-it-is)
- [The seven branches](#the-seven-branches)
- [Contracts](#contracts)
- [The file tree](#the-file-tree)
- [Where it lives](#where-it-lives)
- [Right-click menus](#right-click-menus)
- [Renaming in place](#renaming-in-place)
- [Opening a shot's frame](#opening-a-shots-frame)
- [Deliberately absent](#deliberately-absent)

<!-- tocstop -->

## What it is

The tree joins records that already exist rather than adding a source of truth. Every edge
the tree draws already exists on disk: entity sheets carry the file they were discovered
in ([entity discovery by tag](../plans/archive/INDEX.md#entity-discovery-by-meta-tag)),
`Scene.characters` names the cast, `ShotSubject.characterId` names who is in frame,
`Asset.satisfies` names what a byte-stream is for, and `Bible.files()` names the wiki.
This module walks them once and builds the tree from what it finds; it reads nothing else
and writes nothing at all.

A node records its kind, its label, and its location. It holds no prose, no excerpt, and
no image bytes. The whole tree can therefore be shipped over IPC, and a large project
requires parsing a manifest rather than a corpus.

## The seven branches

```
Story              scene:<id>            → shot:<sceneId>/<shotId>
Characters         character:<id>
Locations          location:<id>
Wiki               wikidir:<rel>         → wiki:<rel>
Skills             skill:<id>
Unapproved assets  unapproved:waiting    → asset:<hash>
                   unapproved:unrendered → slot:<slotKey>
Stale assets       asset:<hash>
Assets             assetkind:<kind>      → asset:<hash>  (one per slot)
                                         → asset:<hash>  (its earlier takes)
```

- **Story** lists every scene in model order. Each scene shows its `scenes/<id>.md` path
  and holds its persisted shots as children. A scene with no `work/shots/<id>.json` has no
  children rather than an empty list, because a scene that has not been decomposed differs
  from a scene decomposed into no shots. If a storyboard does not parse, that scene is
  badged `unreadable` and the sidebar does not fail.
- Characters and Locations come from the built model. Each is labelled by name and carries
  the path of the file the `type:` tag was found in, such as
  `characters/aiko/character.md` (or `wiki/cast/aiko.md` if that is where the author filed
  it).
- **Wiki** nests `Bible.files()` back into directories. Each entry contains a path and a
  title and nothing else.
- **Skills** lists the playbooks under `.aiagent/skills/` as one leaf each. Each leaf is
  labelled by the skill's `name:`, points at its `SKILL.md`, carries a `script` badge when
  a person has given it one to run, and shows its `description:` on hover. Each skill is
  drawn as a leaf with no file children, because a skill is one thing with an id, a name
  and a description, at the same granularity as a character, and the contents of the
  directory are the Skills pane's own tree. Skills is the only branch drawn when it is
  empty, and this deliberately breaks the rule that Unapproved assets follows: a skill has
  to be findable before one exists, and the heading's own right-click menu is the only
  always-reachable way to make the first skill. `skeleton()` writes no `.aiagent/` at all,
  so every project created in the app starts here, and an absent branch would hide the
  feature from exactly the authors who have not read this file. The caller still decides.
  An undefined `DocTreeInput.skills` means the caller did not look, and leaves the branch
  out.
- **Unapproved assets** groups the two branches around it, which together cover everything
  still to be done before the project has a finished set of pictures. The
  [slot graph](../plans/archive/INDEX.md#the-full-slot-graph-and-approving-upstream-first)
  makes the two groups disjoint by construction. "Awaiting approval" lists rendered bytes
  that nobody has approved, reusing the same `asset:<hash>` ids the Assets branch uses, so
  selection, routing and the right-click menu work here with no renderer change. "Not yet
  rendered" lists slots with zero candidates. The group is not called "unresolved",
  because `pick` declines whenever the answer is not certain, and a slot holding three
  drafts would then be listed as unrendered while its three drafts sat in the other group.
  Both groups walk `SlotGraph.order`, upstream before downstream, so the top of each list
  holds the work that can be done now. A project with nothing outstanding has no branch at
  all rather than an empty one, and a caller that did not pass a slot graph gets no branch
  either. A drifted frame is left out of "Awaiting approval" and filed under Stale assets
  instead, because it needs a redraw rather than approval, and approving it would accept a
  picture of something the scene no longer describes. The menu bar's pending-approval
  dropdown and the agent's `approve_assets` both list from `session.approvable()`, which
  applies the same filter, so the two views cannot disagree.
- **Stale assets** lists the frames whose scene has changed since they were drawn.
  `driftOf` is re-derived on every read, as it is for every other reading of drift. The
  rows reuse the `asset:<hash>` ids and are ordered by name, because drift itself defines
  no order, and the branch is absent when nothing has drifted. The branch sits between
  Unapproved and Assets because the branches on both sides list work that remains to be
  done.
- **Assets** groups `AssetStore.manifest()` by `AssetKind`, and labels each group `base`
  or `project` by the same routing rule the store writes with (`isBaseKind`). The label
  describes what the asset is, so a legacy project whose base art is still indexed in the
  project manifest still groups correctly. A leaf carries a name rather than a hash (see
  below). Concepts is one of those groups, and the pipeline never plans it, because an
  `art.generate` sketch has no task in the graph. Concepts appear only in the tree. Within
  a group the rows are slots rather than pictures (see the contract below). The groups
  (and the rows inside each of them) are alphabetical by the name on the row, compared
  with digit runs read as numbers so `Shot 10` follows `Shot 9`.

## Contracts

- **A node id is `kind:key`, and it serves as the join key.** Ids look like `scene:greet`,
  `shot:greet/s1`, `character:aiko`, `wiki:history/the-war.md`, and `asset:<hash>`. The
  backlink map uses the same string as its key, so a panel finds its backlinks with a
  lookup instead of a second convention. Expansion state persists against these ids, so
  `character:aiko` must not become a path when the sheet moves.
- **Each row in the Assets branch stands for a slot, and its children are the takes that
  slot has held.** A project that re-rendered a portrait four times has four pictures
  called `Aiko`, told apart only by the `(hash8)` that a label collision adds. Those four
  pictures produce one row, which shows the picture filling the slot now. The other three
  sit underneath it, newest first, and start collapsed, because `defaultExpanded` opens
  only the roots. The rows are alphabetical. `SlotGraph.order` still decides which of two
  slots claiming one picture keeps it, and the topology answers no other question here. A
  row opens on `SlotNode.hash` where the slot resolved, and on the newest candidate where
  it
- **An asset gets a display name, and colliding names get a hash suffix.** `labelAssets`
  (`apps/desktop/src/main/assetlabel.ts`, a pure function) turns the manifest's bindings
  into display names — `Aiko`, `Aiko — uniform / front`, `Café Mori — night`,
  `greet · s2`. The angle on a model sheet comes from the task, not the binding
  (`satisfies` binds only `{characterId, outfit}`, which four sheets share). If two assets
  land on the same words, each keeps a `(hash8)` suffix, so every ambiguous label carries
  its hash. An asset that nothing in the model claims falls back to `hash8.ext`, so bytes
  whose character has been deleted do not get an invented name.
- **A concept is named by what was asked for.** A concept is the one kind whose name is
  authored rather than derived. The name is the authored sentence cut at a word boundary,
  and it follows the subject the concept binds to, as in
  `Kōsei High — an aerial shot of the high school`. A concept is also the one kind that
  may bind to nothing, so it produces a name before a binding is required. An unbound
  concept takes its name from the title alone. A titleless concept takes its name from the
  entity it names. A concept with neither falls back to the hash, like any other orphan.
- **A `slot` node is a row with no backing data.** It carries no path and no hash, only
  the address (`slot:plate:cafe/night`) and a sentence explaining why the graph reports it
  as blocked (or stating that nothing has been drawn for it yet). The Task Graph editor
  `claims` it `primary` and is the only editor that can describe an image with no bytes;
  every other editor requires a document or a hash.
- **An asset node carries no `path`.** The node holds bytes in a content-addressed store
  rather than a document. The pane routes a `path` to the `wiki` editor, which would then
  `doc.read` a PNG. Clicking an asset node names `ui.assetHash` instead and opens the
  `asset` editor.
- **A row drawn by a generation graph also names that graph.** Both a `slot` row and an
  `asset` row that a slot claims carry `boundGraph`, the slug of the graph whose active
  output binds the address (set only while exactly one graph claims it). Clicking either
  publishes `ui.graphSlug`, so an open Gen Graph pane shows that graph. Clicking publishes
  `ui.graphSlug` and does nothing else: `EDITORS` has the Gen Graph editor claim the
  `slot` row and not the `asset` row, since `routeFor` ranks a visible claimant above a
  hidden one, and an open Gen Graph pane would otherwise receive clicks on pictures
  instead of the Asset editor. [`gen-graphs.md`](gen-graphs.md#slots-and-outputs)
  describes what a graph is and how one binds a slot.
- **A node identifies a selection, not a click action.** Shipping the command invocation a
  click runs (the way an interaction target does) would be tidy, but selection is renderer
  state (`ui.sceneId`, `ui.shotId`, `ui.characterId`, `ui.docPath`, `ui.assetHash`) rather
  than state main sets, and only the mesh holds which editor is open. So the pane maps a
  node to a selection itself (`selectionForNode`) and then to an editor (`routeFor` in
  `pathux/route.ts`, over the `claims` each editor declares beside its name), and the tree
  remains a shape any surface can draw. The claim table is in
  [`desktop-app-editors-misc.md`](desktop-app-editors-misc.md#documents), and the shell
  defines what a click does.
- **Paths are workspace-relative with `/` separators**, matching the paths in the
  generated project map. These paths are shown to a human, and an absolute path in a
  serialized shape is unportable.
- **A cap limits how many rows a branch draws, and the dropped rows become children of the
  `more` node.** A branch over its cap (50 by default) ends in one `more` node whose label
  counts what was dropped, so a truncated branch is always drawn as truncated. That node
  holds the dropped rows as its children, so the count names rows the reader can still
  open. The cap limits what a tree draws before expansion, not what it stores.
  `flattenTree` expands a `more` node at its own depth. The dropped rows are siblings of
  the rows above them, so opening one continues the list rather than nesting a copy of the
  branch inside itself.
- **The search box filters the tree already fetched instead of requesting another one.**
  `filterTree` (`renderer/pathux/doctree/doctree.ts`, "pure" (no side effects)) keeps the
  nodes whose labels contain the typed text, matched case-insensitively, along with the
  branches above them. A node that matches keeps its whole subtree and is not opened, so a
  scene found by name can still be drilled into. A node kept only for what sits under it
  is pruned to the matches and opened, so that those matches are visible rather than
  hidden behind a closed twisty. The branches it opens are added to the ones the author
  had open rather than replacing them, and the query is not persisted, because a project
  that reopened showing only the three matching rows would look like a project that had
  lost its files. Wherever the walk reaches a counted `more` node, it splices that node
  away and searches its children in its place. The cap limits what is drawn at rest, and
  filtering searches past the cap. Filtering runs locally because the whole tree is
  already fetched, and a round trip per keystroke would return results more slowly than
  the author types.
- **Backlinks are collected during the same walk.** `EntityLinks` holds an entity's sheet,
  its `wiki` path when that sheet lives under `wiki/`, its assets (with `accepted` and
  `base`), its scenes and its shots. An entity with no art gets an empty list rather than
  a missing key.
- **A scene is a subject too, under `scene:<id>`.** A scene has the same shape and is
  walked the same way, so resolving what illustrates a scene runs the same query against a
  different key. A pane showing prose can therefore show the frames drawn from that prose.
  Only a scene's assets carry `shotId`, which holds the shot the matched binding named.
  One frame can satisfy several shots for a character, and the strip that groups by shot
  belongs to the scene.
- **`pathIndex` inverts the key convention.** It maps a workspace-relative document path
  to a backlink key, with one entry per entity sheet and per scene file, and the loop that
  already has both the path and the key writes it. A surface that holds only a path (an
  open editor has its document path and nothing else) looks the key up rather than
  re-deriving one. A file that is not a subject is absent from the index, and that absence
  is the correct result because no asset binds to a lore note. The first subject
  discovered in a file claims that path, because two `type:` tags in one file is a
  conflict that the model already reports as a diagnostic, and the index must not choose
  between the two tags silently.
- **Other wiki notes that mention Aiko are found by search, not by backlink.** The panel
  links the character's own sheet, because the tag index already records that link.
  `bible.search` finds every other note that says her name, ranked and budgeted.
  Precomputing that result would add a second, unbudgeted index over the one tree that was
  deliberately given a budget; see [`story-bible.md`](story-bible.md).

## The file tree

`workspace:filetree` is a separate walk that serves a different purpose. It shares only
the `DocNode` type with the document tree. It lists every file under the workspace root,
directories first, excludes `.git` and `node_modules`, caps entries per level, and stops
at 5000 files overall. It does not consult git, because a project that is not a repo still
has files, and `.gitignore` semantics do not match a request to view every file.

`workspace:skilltree` runs the same walk over `.aiagent/skills` alone, and it is
deliberately not a filter over the project-wide walk. That walk stops at 5000 files across
the whole project, so on a large project `.aiagent` could be truncated away, and the
Skills pane would then draw an empty directory without giving a reason. A filter would
also ship the entire project's file list to paint a dozen rows. `fileTree`'s third
argument prefixes every id and path while the structure still comes from the walked paths,
so the rows come out `file:.aiagent/skills/<id>/SKILL.md`. Those paths are
workspace-relative, and `selectionForNode` and `nodeIsSelected` already act on
workspace-relative paths, so no new rule is needed. The walk returns `[]` when there is no
skills directory at all, and every new project starts in that state.

## Where it lives

| Piece                                                                                           | Where                                                                                     |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Shapes (`DocNode`, `EntityLinks`, `DocTree`)                                                    | `apps/desktop/src/shared/ipc.ts`                                                          |
| The projection (`buildDocTree`, `fileTree`) — pure                                              | `apps/desktop/src/main/doctree.ts`                                                        |
| Asset display names (`assetLabel`, `labelAssets`) — pure                                        | `apps/desktop/src/main/assetlabel.ts`                                                     |
| The reads (one `loadProject`, one `readShots` per scene, `bible.files()`, one `discoverSkills`) | `WorkspaceSession.docTree()` / `.fileTree()`                                              |
| The skills walk (`walkFiles` under `.aiagent/skills`)                                           | `WorkspaceSession.skillTree()`                                                            |
| Channels                                                                                        | `workspace:doctree`, `workspace:filetree`, `workspace:skilltree`                          |
| Commands                                                                                        | `workspace.doctree`, `workspace.filetree`, `workspace.skilltree` (non-mutating, no props) |

It sits in the desktop's main process rather than `@vn/authoring` because the walk needs
`AssetStore` and the persisted storyboards (neither of which `Workspace` opens), and
exactly one surface consumes the result. The commands exist so the palette and
`scripts/vn-cdp.mjs` can read the same tree the sidebar draws. The shape was debugged
through those commands before the sidebar existed, and the tree is still checked through
them when no sidebar is open.

## Right-click menus

Right-clicking a row opens a menu of commands, and `stack.check` gates the menu before it
is drawn. `menuFor(node)` in `renderer/pathux/doctree/doctree.ts` holds the entries in a
"pure" (side-effect-free) table, so the entries a kind offers can be tested without a DOM.
`renderer/pathux/chrome/contextmenu.ts` resolves a verdict into a drawn item, and
`renderer/pathux/chrome/showmenu.ts` opens the path.ux menu. The full write-up (including
why an entry is an invocation rather than a callback) is in
[`command-system.md`](command-system.md#from-a-right-click) and
[`../plans/archive/INDEX.md#document-tree-context-menus`](../plans/archive/INDEX.md#document-tree-context-menus).

| node kind                                                   | entries                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `location`                                                  | New reference shot… · Art notes… · Open sheet elsewhere                                                                                                              |
| `character`                                                 | New concept image… · Art notes… · Open sheet elsewhere                                                                                                               |
| `branch:wiki`, `wikidir`                                    | New wiki page… · New character sheet… · New location sheet…                                                                                                          |
| `branch:characters`                                         | New character sheet…                                                                                                                                                 |
| `branch:locations`                                          | New location sheet…                                                                                                                                                  |
| `branch:story`                                              | New scene… · Export Fountain                                                                                                                                         |
| `branch:skills`                                             | New skill… · Ask the agent for a skill…                                                                                                                              |
| `asset`                                                     | Regenerate… · Accept · Approve as a portrait… · Promote to a plate… · Create a graph for this slot (only where a slot claims the picture) · Open in the Asset editor |
| `scene`                                                     | Assign line ids · New scene… · Export Fountain                                                                                                                       |
| `shot`                                                      | Set coverage… · Set outfit…                                                                                                                                          |
| `slot`                                                      | Upload a file for this… · Adopt an asset for this… · Create a graph for this slot · Run pipeline…                                                                    |
| `skill`                                                     | Open in the Skills pane · Ask the agent to change this skill…                                                                                                        |
| `branch:assets`, `assetkind`, `wiki`, `dir`, `file`, `more` | none — no menu opens at all                                                                                                                                          |

This table lists the following:

- **A right-click selects a node without opening it.** The menu acts on the node under the
  cursor, so the selection is published first. Otherwise "Regenerate" could act on an
  asset other than the one the pane is showing. A left click routes to an editor.
- **A branch heading lists what its subtree is made of**, because an author looking for
  another item of the same kind reads the heading. A scene's menu is a superset of the
  story branch's menu, so the same two acts appear in the same words in both menus.
  `branch:assets` is the one heading that lists nothing, and it lists nothing
  deliberately, because an asset is rendered from a subject rather than authored from a
  name. `branch:skills` matters most of the four, because it is the heading drawn even
  when the subtree is empty. It is always reachable, so an author uses it to make a
  project's first skill. Both of its entries are forms, because the menu supplies neither
  a name nor a sentence.
- **The menu offers every act an asset supports, and each command supplies its own
  refusal.** `asset.accept` refuses a portrait by naming `gate.approve` and refuses a
  concept by naming `art.promote`; the menu lists all four commands with their refusals
  instead of selecting the one that applies. There is no reject command, because rejecting
  a candidate is the same act as approving a different one, and adding such a command
  inside a menu would design the gate through a menu.
- **A row shows approval in one direction at a time.** A row whose picture is already
  approved shows `asset.unapprove` instead of the three ways to approve. The direction
  comes from `DocNode.approved`, which is separate from the `accepted` badge, since a
  drifted picture is still approved while carrying the `stale` badge. Listing both
  directions would force the author to trigger a refusal to learn which command applies to
  their picture. `shot` rows carry the flag too, so the frame a shot stands for can be
  approved from the row that names it. The Asset editor's approve button follows the same
  rule, through `approveAction` in `renderer/rules/assetview.ts`.
- **Every row addressed by an id has a copy action.** The id appears on screen but is not
  selectable, and an author needs it elsewhere: a scene id goes into the agent, a shot id
  into a command, a hash into a prompt. Each row kind has one `app.copy` entry, worded for
  the thing that row names. A scene row also has an _Edit in the agent…_ action, which
  runs `agent.run` as a form prefilled with `edit <sceneId> `, so the author finishes a
  first sentence rather than sending a turn already written.
- **A slot is right-clicked as a picture far more often than as a `slot` row.** A `slot`
  row is drawn only under Unapproved ▸ Not yet rendered, and only for a slot with no
  candidates at all; everywhere else the Assets branch draws the picture that fills the
  slot. _Create a graph for this slot_ is therefore offered from both kinds of row, and an
  `asset` row carries the address it fills in `slot` so the entry can read that address. A
  picture that no slot claims (a concept, an upload, a base asset) carries no address, so
  the entry is not offered.
- **A kind with no actions is named rather than skipped.** No binding targets a wiki note,
  and `doc.write` needs the text, so the only action for that kind is the one a plain
  click already performs. `branch:wiki` is the exception among the headings because it
  names a location. An author right-clicks the "top level wiki tree", and the `wikidir:`
  nodes below that heading are the folders inside the tree, which a flat `wiki/` does not
  have.
- **A skill's second entry opens a form rather than sending a turn.** _Ask the agent to
  change this skill…_ opens `agent.run` pre-filled with `Edit the "<name>" skill: ` and
  does not send it. The author would only have to interrupt a turn that said "change this
  skill" without saying how. The agent needs only the skill's name in the sentence,
  because `discover_skills` already lists the skills.

A right-click never moves the tree. Chromium fires no `click` for button 2, so the gesture
raises no event on its own, but path.ux closes a menu on mouse-up, so the click that
dismisses one used to land on whatever row the pointer rested over and select or collapse
that row. `showmenu.ts` exports `menuIsOpen()`, and the tree latches its result at
capture-phase pointer-down, which is the last moment a menu is still open. The `click`
that follows is swallowed. The latch clears in every case. If the menu was escaped,
nothing was ever latched. If an item was taken from the menu, the pointer-down landed in
the popup.

The asset editor's own header carries the same `asset` entries behind a `⋯` button, drawn
from the same table. Both menus read that one table, which shows that `menuFor` is
node-shaped rather than tree-shaped.

## Renaming in place

Double-clicking a row whose node names a document lets the author retype the document's
name over the label. Enter commits the edit, Escape and blur abort it, and an unchanged
name is not written.

`renameOf(node)` in the pure `doctree.ts` decides what is renamable. A `character`,
`location` or `wiki` node that carries a path is renamable, and `renameOf` returns the two
props `doc.rename` takes, so the surface never assembles them. An entity with no sheet of
its own has no file to hold the name. A scene is deliberately not renamable. Its label is
its id, and that id is also its filename, the value of the config's `start:` and the
target of every `[[goto:]]` pointing at it. Changing one of these is a rename, and
changing the rest is a refactor.

Skills are also excluded, for a different reason. A skill has a path and a label, so it
appears renamable. But `renameInText` writes `name:` only for a sheet; for anything else
it writes to wherever the title was read from, which for a `SKILL.md` is a `title:` key
that nothing reads. A skill's label is its `name:` key, and its id is the directory, which
no rewrite of the file could move. Renaming a skill goes through `edit_skill` or the
Skills pane.

Two things underlie the gesture:

- **Counts two clicks rather than handling a `dblclick` event.** The first click selects,
  which rebuilds the rows, so the element both clicks landed on is gone before a
  `dblclick` could be dispatched. Two clicks on the same node id within 500 ms count as a
  double click, and the row is found again by `data-id`.
- **Renaming runs as an ordinary command.** `doc.rename` is `mutating` and `undoable`, so
  it commits, records and undoes through the same journal as `doc.write`. `renameInText`
  in `src/main/rename.ts` decides where the new name is written. A sheet keeps its name in
  `name:`. Anything else keeps it wherever the title was read from, which is front-matter
  `title:` if present and otherwise the first H1; if neither is present, a heading is
  added. Writing anywhere else would leave the tree showing the old name. The file never
  moves, because the id is derived from a name once, at creation.

## Opening a shot's frame

Double-clicking a shot under its scene shows, in the Asset editor, the frame that shot was
drawn as. The gesture is counted the same way as the rename described above, and the
double-click runs on the branch of `onSecondClick` that handles a node claimed by neither
a rename nor a sheet.

The hash comes from the storyboard's own `Shot.image`, carried onto the node as
`DocNode.hash` in `storyBranch`. The tree does not choose the hash, because a slot can
hold several takes and `EntityLinks.assets` lists all of them, so a choice made there
would risk opening a picture the runner would not show. A shot with no frame yet carries
no hash, so its tooltip offers no double-click and the gesture does nothing. The Shot
Coverage editor handles the same double-click the same way, reading `CoverageShot.image`
(the same field projected for the strip).

## Deliberately absent

- **An agent backlink tool** — `vnauthor` authors inputs and stops at them. The pipeline
  produces shots and assets.
- **Filesystem watching** — reads both trees, and a write refetches them, as `story:graph`
  does.
- **Moving and deleting through the tree** — a drag in a sidebar would have to dispatch
  the `story.*` commands that own those refusals, rather than open a new write path.
  Renaming is the only editing gesture the tree has, and it follows that rule. It is a
  registered command with its own check, reached from a double-click instead of the
  palette.
- **A menu entry that is not a command** — an action that appears in a right-click menu
  also belongs in the palette, the catalog and the provenance log.

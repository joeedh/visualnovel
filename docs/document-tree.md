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
  invocation a click runs, the way an interaction target does — but there is no such command:
  selection is renderer state (`ui.sceneId`, `ui.shotId`, `ui.characterId`, `ui.docPath`,
  `ui.assetHash`), not
  something main decides. So the pane maps a node to a selection itself, and the tree stays a
  shape any surface can draw. What a click does stays the shell's business.
- **Paths are workspace-relative with `/` separators**, like the generated project map's — they are
  shown to a human, and an absolute path in a serialized shape is unportable.
- **A cap is a number in the shape.** A branch over its cap (50 by default) ends in one `more` node
  whose label counts the remainder, so a truncated branch can never be drawn as a complete one.
- **Backlinks come from the same walk.** `EntityLinks` gives an entity's sheet, its `wiki` path when
  that sheet lives under `wiki/`, its assets (with `accepted` and `base`), its scenes and its shots.
  An entity with no art gets an empty list, never a missing key.
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

## Deliberately absent

- **An agent backlink tool** — `vnauthor` authors inputs and stops at them; shots and assets are
  pipeline output.
- **Filesystem watching** — both trees are reads, refetched after a write like `story:graph`.
- **Editing through the tree** — rename, move and delete are `story.*` commands with their own
  refusals; a drag in a sidebar would dispatch those, not open a new write path. The pane's one
  authored act is creation, and it is the existing `doc.create` rather than a tree-shaped write.

# Document tree and backlinks

The sidebar's two shapes, as shipped: a **logical document tree** over what a project *is*, and
per-entity **backlinks** answering "what is this character attached to". Both come off one channel,
`workspace:doctree`; a second channel, `workspace:filetree`, serves the tree's other mode — every
file actually on disk.

Plan and the reasoning behind each decision:
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
  correctly.

## Contracts

- **A node id is `kind:key`, and it is the join key.** `scene:greet`, `shot:greet/s1`,
  `character:aiko`, `wiki:history/the-war.md`, `asset:<hash>`. The backlink map is keyed by the same
  string, so a panel is a lookup rather than a second convention — and expansion state persists
  against these ids, which is why `character:aiko` must not become a path when the sheet moves.
- **A node carries identity, never a click action.** It would be tidy to ship the command
  invocation a click runs, the way an interaction target does — but there is no such command:
  `view.*` switches rooms and modes, and nothing selects a scene or a shot. Inventing a selection
  vocabulary here would bind the tree to a shell the [path.ux rewrite](plans/pathux-desktop-rewrite.md)
  replaces. What a click does stays the shell's business.
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
| The reads (one `loadProject`, one `readShots` per scene, `bible.files()`) | `WorkspaceSession.docTree()` / `.fileTree()` |
| Channels | `workspace:doctree`, `workspace:filetree` |
| Commands | `workspace.doctree`, `workspace.filetree` (non-mutating, no props) |

It sits in the desktop's main process rather than `@vn/authoring` because the walk needs
`AssetStore` and the persisted storyboards, neither of which `Workspace` opens, and exactly one
surface consumes the result. The commands exist so the palette and `scripts/vn-cdp.mjs` can read
the tree the sidebar reads — which is how the shape gets debugged before any sidebar exists.

## Deliberately absent

- **The sidebar itself** — this ships the shape and the channels; the pane belongs to the
  [desktop rewrite](plans/pathux-desktop-rewrite.md).
- **An agent backlink tool** — `vnauthor` authors inputs and stops at them; shots and assets are
  pipeline output.
- **Filesystem watching** — both trees are reads, refetched after a write like `story:graph`.
- **Editing through the tree** — rename, move and delete are `story.*` commands with their own
  refusals; a drag in a sidebar would dispatch those, not open a new write path.

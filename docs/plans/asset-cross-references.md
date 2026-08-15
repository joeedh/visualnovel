# The assets that reference a document, as one reusable strip

Status: **planned**

## Context

`todos.md`:

> the wiki editor for a page should show assets that reference it. we may need a generic
> cross-reference asset viewer widget, that way we can reuse it in other places like the script
> editor.

Half of this already exists and is stranded in one file. `apps/desktop/src/main/doctree.ts`
computes `EntityLinks` for every character and location — sheet path, wiki path, the bound assets
with display labels and `accepted`/`base` flags, the scenes and the shots — and
`editors/documents.ts` renders it: `assetGroups(links)` buckets the assets by kind and a private
`assetCell` draws each thumbnail. Nothing outside the documents pane can reach either.

The other half is a real gap. `DocTree.backlinks` is keyed by **node id** (`character:aiko`), and
the wiki editor holds a **path** (`wiki/cast/aiko.md`). There is no map between them, so an editor
that knows which document it has open cannot ask what is attached to it.

One thing must be said plainly before the widget is built, because it decides the scope: **no
asset references a plain wiki note today.** Every binding in the manifest is `{characterId}`,
`{locationId, variant?}` or `{sceneId, shotId}`; a prompt chunk's `⇱` origin
(`renderer/rules/promptview.ts`) points at the *document a clause came from*, and that document is
always an entity sheet. So "the assets that reference this page" is a true and useful answer for
an entity sheet — including one filed under `wiki/**`, which entity discovery has supported since
[`entity-discovery-by-meta-tag.md`](entity-discovery-by-meta-tag.md) — and is honestly **empty**
for a lore note. The strip says so rather than pretending, and that emptiness is the feature: it
is how an author sees that a page nothing draws from is a page nothing draws from.

## Decisions this plan settles

- **The widget takes groups, not an entity.** `renderAssetStrip(groups, handlers)` over
  `{ title: string; assets: EntityLinks['assets'] }[]`. A host that knows how to find assets for
  its own subject supplies them; the widget knows nothing about characters, scenes or the
  manifest. That is what makes the second consumer cheap and keeps the first one honest.
- **It lives beside the other pure renderer helpers and owns its DOM.**
  `apps/desktop/renderer/pathux/assetstrip.ts`, built with the `el` helpers in `pathux/dom.ts`,
  appended through `VnEditor.appendSurface` by whichever editor hosts it, carrying its own sheet
  via `adoptStyle`. Document CSS does not cross a shadow boundary, so a widget that assumes a
  global stylesheet renders unstyled in the second pane that uses it.
- **The bucketing rule moves with it.** `assetGroups` is pure and already has the right shape;
  it moves from `editors/documents.ts` to `pathux/doctree.ts`'s neighbourhood (it is a tree rule)
  or directly into `assetstrip.ts`. Either way, exactly one implementation — two copies of the
  kind order is how a strip in Wiki starts disagreeing with the strip in Documents.
- **A click routes, it does not hardcode.** Every cell calls the routing rule from
  [`editor-routing-by-relevance.md`](editor-routing-by-relevance.md) with a synthetic
  `{kind: 'asset'}` node, so a thumbnail in the wiki pane and a thumbnail in the documents pane
  land in the same place, decided once.
- **`DocTree` gains a path index, not a second backlink map.** `pathIndex: Record<string, string>`
  — workspace-relative document path → backlink key. Built in the same loop that already knows
  both (`buildDocTree` has `characterFiles`/`locationFiles` in hand), costs one entry per entity,
  and means the wiki editor needs no convention of its own for turning a path into an id.
- **Scene backlinks are the second key, added by the same walk.** `linksFor` already iterates
  every scene and shot; giving it a `{sceneId}` binding case and writing `backlinks['scene:<id>']`
  is a dozen lines and is what makes the script-editor consumer possible at all. `bindsTo` gains
  the scene case alongside the character and location ones.
- **The strip is read-only.** No accept, no regenerate, no delete. Those are the asset editor's
  and the context menu's job ([`document-tree-context-menus.md`](document-tree-context-menus.md));
  a cross-reference view that also mutates is two features wearing one coat, and it would need
  `stack.check` plumbing in every host.

## Stage 1 — the edges

`apps/desktop/src/main/doctree.ts`:

1. `linksFor` takes `{ sceneId: string }` as a third binding shape; `bindsTo` learns it (an asset
   whose `satisfies` names that `sceneId`). `scenes`/`shots` for a scene binding are the scene
   itself and its own shots — the field stays populated rather than special-cased empty.
2. `buildDocTree` writes `backlinks['scene:<id>']` for every scene in the model.
3. `buildDocTree` writes `pathIndex`, mapping each discovered `EntityDoc` path to its
   `character:`/`location:` key, and each `scenes/<id>.md` to its `scene:` key. Paths are
   workspace-relative with `/` separators — `relPath` already normalizes.
4. `DocTree` in `src/shared/ipc.ts` gains `pathIndex`, documented as "the inverse of the key
   convention, so a surface holding a path need not re-derive one".

Tests: `apps/desktop/src/main/tests/doctree.test.ts` (existing) gains cases for a scene key, for
an entity sheet filed under `wiki/**` appearing in `pathIndex`, and for a lore note appearing in
neither.

## Stage 2 — the widget

New `apps/desktop/renderer/pathux/assetstrip.ts`:

```ts
export interface AssetStripGroup { title: string; assets: EntityLinks['assets'][number][] }
export interface AssetStripHandlers { onPick(hash: string): void }
export function renderAssetStrip(
  root: HTMLElement,
  groups: AssetStripGroup[],
  handlers: AssetStripHandlers,
): void;
```

- One `<div>` per group with a heading, a flex row of cells inside it.
- A cell is the thumbnail (`asset://` or whatever protocol `assetCell` uses today — reuse it
  verbatim rather than reinventing the URL), the display label, and a badge for `accepted` /
  `base`. The existing markup is already right; this stage is a move plus a callback parameter.
- Empty groups are dropped; an empty group list renders one muted sentence, supplied by the host
  (`"Nothing draws from this page."` in Wiki, `"No frames for this scene yet."` in Script).
- `styles/assetstrip.css`, appended **at the end** of `styles/index.css` — import order is
  cascade order.

`editors/documents.ts` becomes the first caller: delete `assetCell` and the inline group markup,
call `renderAssetStrip`. Nothing about the documents pane should look different afterwards, and
that is the acceptance test for this stage.

## Stage 3 — the wiki consumer

`editors/wiki.ts`:

- On open and on `⟳`, look up `pathIndex[docPath]` and then `backlinks[key]`; render the strip
  under the editor, collapsed to a header row when empty so it never pushes the text out of view.
- The `onWrote` bus already makes an open document follow the agent's writes
  ([`desktop-shell-fit-and-finish.md`](desktop-shell-fit-and-finish.md)); the strip refreshes on
  the same signal, because generating a portrait while a character sheet is open should make the
  portrait appear.
- A document with no key (a lore note, a `README.md`) renders the empty sentence. It does **not**
  fall back to `bible.search` for mentions — that is ranked, budgeted retrieval and it is a
  different question.

## Stage 4 — the script consumer

`editors/script.ts` gains the same strip for the open scene, from `backlinks['scene:<id>']`,
grouped by shot rather than by kind (`title: shot.id`), so an author writing a line can see the
frames that illustrate the block it sits in. This is the second consumer the todo asks for and the
justification for the widget being generic; it is also the stage to drop if the strip crowds the
column — the first three stages stand on their own.

## Stage 5 — documentation

- `docs/document-tree.md`: `pathIndex` and the scene backlink key, in the `kind:key` contract
  section.
- `docs/desktop-app.md`: one paragraph per consumer under Wiki and Script.
- `CLAUDE.md`: the document-tree bullet gains the sentence that backlinks are also keyed by scene
  and reachable by path.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- The documents pane's backlink panel is visually unchanged after the extraction.
- Opening a character sheet in Wiki — whether it lives in `characters/` or under `wiki/**` —
  shows its portraits and model sheets; clicking one opens the asset editor via the routing rule.
- Opening a lore note shows the empty sentence, not an error and not a stale strip from the
  previously open document.

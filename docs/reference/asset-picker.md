# The asset picker

<!-- toc -->

- [What it is](#what-it-is)
- [Where the entries come from](#where-the-entries-come-from)
- [Decoding a thumbnail](#decoding-a-thumbnail)
- [Opening it](#opening-it)
- [What confirming runs](#what-confirming-runs)
- [Scope](#scope)
- [Where the pieces are](#where-the-pieces-are)

<!-- tocstop -->

## What it is

**Attach…** on any prompt clause in the asset editor opens a searchable grid of every asset in
the project and attaches the one the author picks as a reference image for that clause.

The grid itself is not this repo's. It is path.ux's `AssetGallery` / `pickAssetPopup`, which
knows nothing about assets, manifests or `vnasset://` — a host describes each entry and supplies
a thunk that decodes its thumbnail. path.ux's own write-up of the widget, its cache and its
keyboard model is
[`vendor/path.ux/documentation/gallery.md`](../../vendor/path.ux/documentation/gallery.md). This
document is the desktop app's half: where the entries come from, how the pixels are decoded, and
what confirming actually runs.

## Where the entries come from

The picker takes a snapshot of the manifest when it opens, in one command round trip.

- `asset.list` (`apps/desktop/src/main/commands/asset.ts`) is read-only and takes no props. It
  answers with the whole manifest as `AssetListing[]`.
- `WorkspaceSession.assetLibrary` builds those rows. The display name is `labelAssets`
  (`apps/desktop/src/main/assetlabel.ts`) resolved over the whole manifest at once — the same
  names the document tree draws, so the picker calls a picture what the rest of the app calls it.
- `AssetListing` (`apps/desktop/src/shared/ipc.ts`) is deliberately thin: `hash`, `ext`, `kind`,
  `label`, `accepted`, and `slot` when the asset fills one. `asset.info` remains the detailed
  read for a single asset; a picker that needed everything about every asset would pay for it on
  every open.
- `galleryItem` (`apps/desktop/renderer/pathux/assetthumb.ts`) projects one row into the widget's
  item shape. The search box matches the label, the hash, and the tags — which are the kind, the
  slot, and the literal `accepted` — so typing `portrait`, a slot address, or `accepted` narrows
  the grid.

The list is a snapshot rather than a subscription. The choice is over what exists at the moment
the popup opens, and the popup is short-lived.

## Decoding a thumbnail

`loadAssetThumb` (`apps/desktop/renderer/pathux/assetthumb.ts`) is the `GalleryItem.image` thunk,
so a decode happens only when a cell is bound to that item — a few dozen of them, not the whole
manifest.

- The bytes come from `vnasset://<hash>.<ext>`, the app's only image-loading path, served in
  `apps/desktop/src/main/index.ts` out of both asset roots
  ([`asset-stores.md`](asset-stores.md)). Requests are answered from the file cache, which never
  has to revalidate: a stored asset's name is the hash of its own contents.
- The response is checked before it reaches the decoder. A hash the store has no bytes for
  answers `404` with a body that is not an image, and `createImageBitmap` would report that as a
  corrupt picture rather than a missing one.
- The decode downscales, through `createImageBitmap(blob, {resizeWidth, resizeQuality})`. Assets
  are commonly 1024×1024; a 200-entry cache of undecimated frames is most of a gigabyte of
  pixels, and the cells are 96 CSS pixels wide.

The asset editor holds its own `ThumbnailCache` rather than using the shared one, so reopening
the picker in that pane redraws from what it already decoded, and closing the pane releases the
bitmaps with it.

## Opening it

`pickRef` in `apps/desktop/renderer/pathux/editors/asset.ts` opens the popup and awaits it.

The Attach button is a raw DOM node in an `appendSurface` root, not a path.ux widget, so it
cannot be the popup's owner: the editor is, and the button contributes only the corner to open
at, through `pickAssetPopup`'s `at` argument. This is the general shape for any surface in this
app that draws with raw DOM — see the shadow-root surfaces section of
[`desktop-app.md`](desktop-app.md).

Dismissal is a press outside the popup, or Escape, or Cancel; the pointer leaving it does not
close it, since the author reads the rest of the screen while choosing. The dismissing press is
consumed rather than passed through, so it does not also land on whatever was under the popup.

## What confirming runs

Confirming resolves with the chosen item and `pickRef` runs `prompt.addRef` with its hash,
through the same act record the button was drawn from — so the picker adds a value to a command
the UI had already declared, rather than reaching a second write path
([`command-system.md`](command-system.md)).

The button records itself with `supplies: ['ref']`, which tells the anchor layer that the act is
deliberately incomplete: `ref` is the blank the author is on their way to filling in, so a tour
or the anchor sweep does not ask `stack.check` about it as though it were ready to run
([`guided-tours.md`](guided-tours.md)).

## Scope

Three limits are deliberate rather than unfinished.

- **Hash only.** `prompt.addRef`'s `ref` prop also accepts a slot address
  (`portrait:<character>` and the like), which resolves to whatever fills that slot at generation
  time. The picker only ever names a concrete asset, so a slot-address ref stays reachable
  through the command palette and the agent alone.
- **One at a time.** `prompt.addRef` attaches one reference per call, and the picker is
  single-select to match.
- **No live list.** See above: the manifest is read once per open.

## Where the pieces are

| Path | What it holds |
| ---- | ------------- |
| `apps/desktop/src/main/commands/asset.ts` | `asset.list` |
| `apps/desktop/src/main/session.ts` | `assetLibrary`, over `labelAssets` |
| `apps/desktop/src/shared/ipc.ts` | `AssetListing` |
| `apps/desktop/renderer/pathux/assetthumb.ts` | `assetThumbUrl`, `loadAssetThumb`, `galleryItem` |
| `apps/desktop/renderer/rules/promptview.ts` | the `attach` clause act and `REF_SUPPLIES` |
| `apps/desktop/renderer/pathux/editors/asset.ts` | `pickRef`, and the pane's `ThumbnailCache` |
| `vendor/path.ux/scripts/widgets/ui_gallery.ts` | the widget, its cache, and `pickAssetPopup` |

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

**Attach…** on any prompt clause in the asset editor opens a searchable grid of every asset in the
project and attaches the asset the author picks as a reference image for that clause. The command form
shows the same grid when the author chooses **Pick…** on a `hash` or `ref` prop, so a command reached
from the palette does not ask the author to type a hash
([`command-system.md`](command-system.md#from-the-palette-or-from-a-commands-own-dialog)).

The grid does not live in this repo. It comes from path.ux's `AssetGallery` / `pickAssetPopup`, which
knows nothing about assets, manifests or `vnasset://` — a host describes each entry and supplies a thunk
that decodes its thumbnail. path.ux's own write-up of the widget, its cache and its keyboard model is
[`vendor/path.ux/documentation/gallery.md`](../../vendor/path.ux/documentation/gallery.md). This
document covers the desktop app's half: where the entries come from, how the pixels are decoded, and
what confirming an entry runs.

## Where the entries come from

The picker takes a snapshot of the manifest when it opens, in one command round trip.

- `asset.list` (`apps/desktop/src/main/commands/asset.ts`) is read-only and takes no props. It returns
  the whole manifest as `AssetListing[]`.
- `WorkspaceSession.assetLibrary` builds those rows. `labelAssets`
  (`apps/desktop/src/main/assetlabel.ts`) resolves the display name over the whole manifest at once. The
  document tree draws those same names, so the picker shows a picture under the name the rest of the app
  uses.
- `AssetListing` (`apps/desktop/src/shared/ipc.ts`) carries only `hash`, `ext`, `kind`, `label`,
  `accepted`, and `slot` when the asset fills one. The detailed read for a single asset stays in
  `asset.info`, because a picker that needed everything about every asset would repeat that read every
  time it opens.
- `galleryItem` (`apps/desktop/renderer/pathux/assets/assetthumb.ts`) projects one row into the
  widget's item shape. The search box matches the label, the hash, and the tags. The tags are the kind,
  the slot, and the literal `accepted`, so typing `portrait`, a slot address, or `accepted` narrows the
  grid.

The popup reads the list once when it opens and does not update it afterwards. The choice covers what
exists at that moment, and the popup is short-lived.

## Decoding a thumbnail

`loadAssetThumb` (`apps/desktop/renderer/pathux/assets/assetthumb.ts`) is the `GalleryItem.image` thunk,
so a decode happens only when a cell is bound to that item. A few dozen items are bound at a time, not
the whole manifest.

- The bytes come from `vnasset://<hash>.<ext>`, which is the app's only image-loading path and is
  served in `apps/desktop/src/main/index.ts` out of both asset roots
  ([`asset-stores.md`](asset-stores.md)). Requests are answered from the file cache and never
  revalidated, because a stored asset's name is the hash of its own contents.
- The response is checked before it reaches the decoder. A request for a hash the store has no bytes
  for returns `404` with a body that is not an image, and `createImageBitmap` would report that as a
  corrupt picture rather than a missing one.
- The decode downscales through `createImageBitmap(blob, {resizeWidth, resizeQuality})`. Assets are
  commonly 1024×1024 and the cells are 96 CSS pixels wide, so a 200-entry cache of undecimated frames
  holds most of a gigabyte of pixels.

The asset editor holds its own `ThumbnailCache` rather than using the shared one. Reopening the picker
in that pane redraws from the bitmaps that cache already decoded, and closing the pane releases those
bitmaps.

## Opening it

`pickRef` in apps/desktop/renderer/pathux/editors/asset.ts opens the popup and awaits it, and
`CommandForm.pickAsset` does the same from a command form.

The Attach button is a raw DOM node in an `appendSurface` root, not a path.ux widget, so it cannot own
the popup. The editor owns the popup, and the button supplies only the corner where the popup opens,
through `pickAssetPopup`'s `at` argument. Every surface in this app that draws with raw DOM follows this
shape — see the shadow-root surfaces section of [`desktop-app.md`](desktop-app.md).

The popup closes on a press outside it, on Escape, or on Cancel. The pointer leaving the popup does not
close it, since the author reads the rest of the screen while choosing. The dismissing press is consumed
rather than passed through, so it does not also land on whatever was under the popup.

## What confirming runs

Confirming resolves with the chosen item, and `pickRef` runs `prompt.addRef` with its hash through the
same act record the button was drawn from. The picker therefore adds a value to a command the UI had
already declared instead of using a second write path ([`command-system.md`](command-system.md)).

The button records `supplies: ['ref']`, which tells the anchor layer that the entry is deliberately
incomplete. The author fills in `ref` later, so a tour or the anchor sweep does not check it with
`stack.check` as though it were ready to run ([`guided-tours.md`](guided-tours.md)).

## Scope

Three limits are deliberate, not unfinished work.

- **Hash only.** `prompt.addRef`'s `ref` prop also accepts a slot address (`portrait:<character>` and
  the like), which resolves to whatever fills that slot at generation time. The picker only ever names a
  concrete asset, so only the command palette and the agent can reach a slot-address ref.
- **One at a time.** `prompt.addRef` attaches one reference per call, and the picker is
  single-select to match.
- **No live list.** As stated above, the manifest is read once per open.

## Where the pieces are

| Path | What it holds |
| ---- | ------------- |
| `apps/desktop/src/main/commands/asset.ts` | `asset.list` |
| `apps/desktop/src/main/session.ts` | `assetLibrary`, over `labelAssets` |
| `apps/desktop/src/shared/ipc.ts` | `AssetListing` |
| `apps/desktop/renderer/pathux/assets/assetthumb.ts` | `assetThumbUrl`, `loadAssetThumb`, `galleryItem` |
| `apps/desktop/renderer/rules/promptview.ts` | the `attach` clause act and `REF_SUPPLIES` |
| `apps/desktop/renderer/pathux/editors/asset.ts` | `pickRef`, and the pane's `ThumbnailCache` |
| `apps/desktop/renderer/pathux/commands/commandform.ts` | `pickAsset`, and the form's own `ThumbnailCache` |
| `apps/desktop/renderer/rules/vocabulary.ts` | `picksAnAsset` — which props get the button |
| `vendor/path.ux/scripts/gallery/` | the widget, its cache, and `pickAssetPopup` |

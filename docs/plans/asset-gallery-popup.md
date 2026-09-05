# Asset gallery popup

Status: **planned**

## Context

- Today, attaching a reference image to a prompt clause means typing or pasting a raw
  asset hash (or a slot address) into a text prop — `prompt.addRef`'s
  `ref: prop.string(...)` (apps/desktop/src/main/commands/prompt.ts:206). No renderer
  surface calls this command yet: `chunkActs()` in
  apps/desktop/renderer/pathux/editors/asset.ts:969 offers Mute/Replace/Append on a clause
  but no Attach, and `refStripEl()` (asset.ts:899) can only detach a ref
  (`prompt.dropRef`), via a `×` on each chip. This plan specifies what an Attach action
  opens.
- Fix this with a reusable, virtualized, searchable thumbnail-grid widget, sketched
  earlier in this conversation. It recycles pooled DOM nodes (not canvas) on scroll, so
  hover, click and tooltip stay native, and a search bar filters a caller-supplied
  `GalleryItem[]`.
- This plan adds what the sketch did not cover: keyboard navigation, a global thumbnail
  cache, an explicit active/confirm selection model, and a full theme spec. It then stages
  the build and names the one concrete consumer.

## Scope

- **Build in `vendor/path.ux`** as a new widget alongside `ListBox`. The widget carries no
  VN-specific dependency and matches the abstract `GalleryItem` contract. It lives at
  `scripts/widgets/ui_gallery.ts` and is documented at `documentation/gallery.md`,
  following the `ListBox` precedent.
- **Wire into the desktop app** at exactly one call site. An "Attach…" button in
  `chunkActs()` calls `prompt.addRef` with the picked hash.
- **Explicitly out of scope.** Wiring the popup into the asset editor's Replace strip,
  into `assetAdopt`, or into any other hash-entry point is out of scope, and is written
  down here so it is recorded rather than rediscovered later as a gap. Those are
  follow-ons once this integration proves the widget out. A second consumer is also the
  first real test of the abstract `GalleryItem` contract.

## Carried over from the sketch

- Uses pooled DOM nodes (`AssetThumb`) positioned absolutely via `transform` and recycled
  on scroll (not a canvas) because tooltips, hover and click must stay native per the
  tooltip rule in CLAUDE.md.
- `GalleryItem.image` accepts a thunk (`() => Promise<HTMLImageElement | ImageBitmap>`) as
  well as a resolved value, because decoding a whole asset library eagerly up front does
  not scale.
- `pickAssetPopup()` returns a `Promise<GalleryItem | undefined>`. This follows the
  `VectorPopupButton` and `ColorPicker` popup pattern, which path.ux already provides.

Correction from the pressure-test pass: this plan cites `ListBox`
(vendor/path.ux/scripts/widgets/ui_listbox.ts) throughout as precedent, but
`ListBox.addItem` (line 616) creates one permanent real DOM `ListItem` per entry, with no
pooling and no virtualization. path.ux contains no virtualization precedent, so the
pool/scroll/rebind mechanism in this plan is designed from zero rather than adapted from
something proven. `ListBox` remains the right precedent for the event pattern (`"change"`,
manual `addItem`-style API) and for the keyboard-nav shape (its `onkeydown` Up/Down
handling), but not for virtualization or for typed theming: the `static define()` of
`ListBox` and `ListItem` (lines 48, 235) declares no `theme` block and still reads untyped
`getDefault("ListActive")`. scripts/widgets/ui_button.ts is the widget that demonstrates
the typed `static define().theme` pattern this plan uses; cite that instead when
justifying the theming approach.

## Keyboard navigation

- Arrow keys move a focus cursor. Up and Down move by one row (± `columns`), Left and
  Right move by one cell, and the cursor clamps at the grid edges instead of wrapping.
- Home jumps to the first item and End jumps to the last; PageUp and PageDown move by one
  viewport's worth of rows.
- Pressing Enter on the focused cell confirms it, the same as a double-click.
- Moving focus must scroll the viewport to keep the focused index inside the pool's bound
  range before rebinding. The focused cell must always be a real, bindable pool node;
  otherwise arrow-key navigation does nothing once the cursor scrolls past the overscan
  window.
- Type-ahead-to-jump is not built. The search bar already does substring filtering, and a
  second "jump by typing" gesture would give two ways to do the same thing. Leaving it out
  is deliberate.
- **Roving tabindex**: only the currently-focused pool node carries `tabindex="0"`; every
  other pool node is `-1`. A per-cell tab stop would tie native DOM tab order to whichever
  pool slot an item occupies, and that slot changes on every scroll. A roving tabindex is
  the only arrangement that keeps tab order stable under recycling.

## Active item and confirm

Each cell carries three independent states, and they composite. A cell can be hovered and
focused and active at once:

- **hover** — the mouse moves over the cell (as `ListItem` already does).
- **focus** — the keyboard cursor (new; `ListItem` has no equivalent).
- **active** — Holds the current selection, which survives scrolling it out of view.
  `AssetGallery.active: GalleryItem | undefined`.

Events follow the DOM-event direction path.ux is already moving in (`ListBox`'s
`"change"`):

- `"change"` fires when `active` changes (a click, or Enter on the focused cell). The
  event detail is `{id, item}`. An inline-hosted gallery (e.g. a future "select an image,
  see a preview elsewhere" panel) needs only this event.
- `"confirm"` fires on double-click, Enter, or an explicit OK button. This is the
  "downstream use" signal the user asked for. `pickAssetPopup()` listens for `"confirm"`
  (not `"change"`) before it resolves and closes, and its popup wrapper gains an OK/Cancel
  footer rather than closing on the first click, since "select, then press OK" is one of
  the two stated use cases.
- A single click sets `active` and fires `"change"` without confirming. The original
  sketch fired one event on click and treated that event as both a change and a
  confirmation.

## Global thumbnail cache

- **Problem**: `AssetThumb.bindItem`'s async branch does not memoize. Scrolling back over
  an item already seen redecodes the image, and so does reopening the popup.
- `ThumbnailCache` is a small LRU keyed by `GalleryItem.id` that stores decoded
  `ImageBitmap`s and is shared across every `AssetThumb` and every `AssetGallery` instance
  in the process. It lives in path.ux next to the gallery rather than in the desktop app,
  as a generic id → async-image cache with no `vnasset://` knowledge.
- `cache.get(id, loader): Promise<ImageBitmap>` coalesces concurrent requests for the same
  id through an in-flight-promise map. Fast scrolling can request the same id twice before
  the first decode finishes, and without coalescing that runs two decodes.
- Bounded by entry count (default 200) rather than bytes. Eviction calls `.close()` on the
  dropped `ImageBitmap`, which releases the decoded bitmap's memory cheaply and precisely.
  Measuring decoded byte size for a byte bound is not worth it here.
- The cache is held in memory and is not persisted across app restarts. `vnasset://` reads
  are local and fast enough that a disk-backed cache would add invalidation complexity for
  no real win.
- The desktop's loader is `() => decodeImageBitmapFrom(`vnasset://${hash}.${ext}`)`. Other
  hosts (path.ux's own tests, a future non-VN host) can pass a synthetic loader.

## Theming

Adds a new `AssetThumb` style class, because path.ux has no existing class that fits:
`ListItem`'s two-state highlight/active model is missing a third, non-exclusive focus
state, and cells need a real box model that list rows do not have. The class is declared
via `static define().theme` with typed `t.*` tokens:

| Key                | Purpose                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `background-color` | idle cell fill                                                                                     |
| `highlight`        | mouseover fill                                                                                     |
| `active`           | selected fill (composable with focus/hover)                                                        |
| `focusRing`        | keyboard-focus outline — a ring, not a fill, so it stays visible when the same cell is also active |
| `border`           | `{color, width}` around the cell                                                                   |
| `margin`           | space between cells (the sketch's `gap` becomes this)                                              |
| `padding`          | inset between the cell border and the thumbnail image                                              |

- Regenerate `generated/themes.ts` / `generated/themes.json` (`pnpm run gen:themes`) as
  part of this work, and run `pnpm run gen:themes --strict` + `pnpm run typecheck:themes`
  before landing.
- `border` as a `{color, width}` structured token, and numeric `margin`/`padding`, have no
  sibling in `theme.ts` today. Every existing `border` value there is a plain CSS
  shorthand string, such as `border: "none"`. The `t.*` schema in `theme_schema.ts`
  structurally supports nested sub-records, which `disabled` and `highlight` already use,
  so this is buildable. It is a new theme-key shape rather than a reuse of an established
  one, so this note flags it instead of introducing it silently.

## Submodule staging

`vendor/path.ux` is currently checked out on `master`, the default branch that both the
root CLAUDE.md's submodule rule and path.ux's own CLAUDE.md call out: "do not silently
commit or advance the submodule's shared default branch. Ask the user whether they want to
commit and/or push the submodule's default branch (and bump the gitlink) before doing so."
Stages 1–3 below are entirely inside `vendor/path.ux`, so:

- Do the path.ux work on a feature branch inside the submodule
  (`git -C vendor/path.ux checkout -b asset-gallery`), not directly on its `master`.
- Commit there as work lands. The parent repo's gitlink moves only when the submodule
  checkout's `HEAD` moves, so the parent stays clean and can be committed independently in
  the meantime.
- Stage 4 needs the gitlink bumped so the desktop app can import the new widget. Before
  landing it, ask the user whether to merge the feature branch to path.ux's `master`, push
  it to path.ux's own origin, and bump the parent's gitlink. The rule above forbids this
  repo from doing that silently.

## Staged implementation

1.  1. **path.ux — spike, then cache + cell.** **Done.** Before writing `ThumbnailCache`
       for real, spike whether
       `createImageBitmap(await (await fetch('vnasset://<hash>.<ext>')).blob())` decodes
       cleanly from the `vnasset` custom protocol in the Electron renderer. No
       `ImageBitmap` usage exists in this codebase today, so this is unverified rather
       than merely unbuilt. `vnasset` is already registered with
       `{standard: true, secure: true, supportFetchAPI: true, stream: true}` in
       apps/desktop/src/main/index.ts, which helps, but confirm the decode before the
       cache is designed around `ImageBitmap`. If it fails, the cache falls back to
       caching `HTMLImageElement`s (decoded via a plain `<img src>` load). The `.close()`
       eviction hook is `ImageBitmap`-only and would then become "just drop the
       reference." Then build `GalleryItem`, `ThumbnailCache` (LRU, coalescing,
       evict-on-count) and `AssetThumb` (bind/hover/focus/

    **Spike result (2026-09-01, run over CDP against the built app on a copy of
    `examples/mySampleRepo`).** `createImageBitmap` decodes cleanly from `vnasset://` for
    assets in both roots (base art under `assets/objects/` and shot frames under
    `vngen/build/assets/`), returning a bitmap whose `.close()` is a real function, so the
    eviction hook stands and the `HTMLImageElement` fallback is not needed. The cache and
    the loader are built around two findings:
    - A request for a missing hash returns `404` with an empty `text/html` body rather
      than failing the fetch, and `createImageBitmap` then throws
      `InvalidStateError: The source image could not be decoded`. The desktop loader
      checks `res.ok` and throws a named error, so the decode step never reports the
      failure.
    - `createImageBitmap(blob, {resizeWidth, resizeQuality})` works over the same
      protocol. Sample assets are 1024×1024, so an unresized 200-entry cache would hold
      roughly 840 MB of decoded pixels; the desktop loader decodes to a thumbnail width
      instead.

2.  2. **path.ux — virtualized grid.** **Done.** `AssetGalleryGrid` sizes its pool from
       the measured viewport, rebinds on scroll, and handles keyboard navigation with a
       roving tabindex that scrolls the target into view before rebinding. The grid has no
       in-repo precedent (see the `ListBox` correction above), so budget real iteration
       time here rather than treating it as a port. A Playwright DOM test covers scroll,
       arrow-key navigation, and a resize-triggered pool resize.
3.  3. **path.ux — outer widget.** **Done.** Builds `AssetGallery` (search bar and grid,
       `active`/`"change"`/`"confirm"`) and `pickAssetPopup()` with its OK/Cancel footer.
       Register the theme keys, run `gen:themes`. Write `documentation/gallery.md`.
4.  4. **Desktop — data + wiring.** **Done.** This stage owns two things that earlier
       drafts of this plan glossed over:
    - **`searchTags` needs real name resolution, not a spare field.** `Asset`
      (packages/types/src/entities.ts) has `kind` and `satisfies: AssetBinding[]`, and no
      `label`. The human-readable name shown today (`RefChip.label`, resolved in
      apps/desktop/renderer/rules/promptview.ts:265-289) is computed per-clause-ref by
      resolving `AssetBinding.characterId`/`locationId` against the live `ProjectModel`.
      Building `GalleryItem[]` for the whole manifest means generalizing that resolution
      to run over every manifest entry up front, rather than reading a field that doesn't
      exist. This is real work rather than data plumbing, so scope it before starting
      stage 4.
    - **The `vnasset://` loader is desktop-only and has no module yet.** A small function
      (name TBD at write time, e.g.
      `loadAssetThumb(hash: string, ext: string): Promise<ImageBitmap>`) wraps the
      fetch/decode spiked in stage 1. It lives in the desktop renderer near `asset.ts`
      rather than in path.ux, because `ThumbnailCache` stays loader-agnostic per its
      design above, and it is passed as each `GalleryItem.image` thunk. Add an "Attach…"
      button to `chunkActs()` that opens `pickAssetPopup()` and, on resolve, calls
      `prompt.addRef` with the picked hash. Note: `prompt.addRef`'s `ref` prop also
      accepts a slot address (`portrait:<character>`, etc.), not just a hash. This button
      only ever supplies a hash, so slot-address refs remain reachable solely through the
      command palette/agent, not through this UI. The limit is accepted (see Open
      questions), not an oversight.

    **Result.** The name resolution turned out to exist already: `labelAssets`
    (`apps/desktop/src/main/assetlabel.ts`) names the whole manifest at once, and is what
    the document tree draws from. So the work was exposing it to the renderer rather than
    writing it. That took a new `AssetListing` shape, `WorkspaceSession.assetLibrary()`
    behind it, and a read-only `asset.list` command that the renderer reaches through
    `exec`. The loader landed in `apps/desktop/renderer/pathux/assetthumb.ts`, which holds
    `assetThumbUrl`, `loadAssetThumb` and `galleryItem`. `loadAssetThumb` checks `res.ok`
    before decoding, per the stage-1 spike, and decodes at a thumbnail width.
    `galleryItem` projects one listing into the widget's item shape.

    Placing the popup needed one change in path.ux. The Attach button is a raw DOM node in
    an `appendSurface` root rather than a widget, so `pickAssetPopup` takes an `at`
    argument of client coordinates, and the editor passes the button's own rect.

5.  5. **Verify in the running app.** Done. Open a project with a real asset library
       (`pnpm run` skill); confirm scroll performance, search, and full keyboard nav, and
       run the attach flow from start to finish.

    **Result** (over CDP, against the built app on a 70-asset copy of the sample project,
    with the Aiko portrait open in the asset pane):
    - Clicking Attach on the `style` clause opened the popup, which held all 70 items
      behind a pool of 27 cells in 3 columns. Every one of the 27 cells painted a decoded
      thumbnail rather than an empty cell.
    - Scrolling the grid across 40 frames moved `firstBoundIndex` from 0 to 51 over 18
      distinct rebinds while `poolSize` stayed 27 and the whole grid held 139 DOM nodes.
      The 40 frames took 639 ms, which tracks the vsync cadence rather than a missed frame
      budget.
    - Arrow keys moved by one cell and by one row, End jumped to item 69 and rebound the
      pool to start at 54, Home returned to 0, and Up and Left clamped there instead of
      wrapping.
    - The search box narrowed 70 items to 2 on `portrait`, to 27 on `accepted`, and to
      none on a string that matches nothing. Clearing the box restored all 70 items.
    - Pressing Enter on the focused cell closed the popup and ran
      `prompt.addRef(hash='6f41ba9a…' chunk='style' ref='05e0b18a…')`, which answered
      `Attached 05e0b18a to "style"`.

## Open questions

These questions are unresolved on purpose. The pressure-test pass or the user answers
them, rather than this document:

- **Pool/overscan sizing.** The starting value is 2 overscan rows on each side. Profile
  that value against a real asset count (a project can have hundreds of generated frames)
  before relying on it.
- **Manual vs. data-path-backed items.** `ListBox` supports both manual `addItem` and a
  live `DataList` binding. This plan builds manual `setItems()` only, because the one
  known consumer (`prompt.addRef`) requires a snapshot at popup-open time rather than a
  live-updating list. Revisit if a second consumer needs live updates.
- **Multi-select.** The one known consumer attaches one ref per call, so this plan covers
  single-select only. Attaching several refs at once is a real future feature, but this
  plan does not build it.
- **Slot-address refs stay hash-only through this UI.** `prompt.addRef`'s `ref` prop
  accepts a slot address as well as a hash; the gallery only ever picks a concrete asset,
  so it only ever supplies a hash. Typing a slot address by hand remains the only way to
  attach one through the command palette or the agent. This stays as it is unless a
  consumer specifically asks to attach whatever currently fills a slot.

## Pressure-test findings (fresh-context review, folded in above)

This review was run under the plan convention in docs/reference/conventions.md before work
started. All six findings were fixed in place (see the sections above). The findings are
recorded here so that the review is not lost:

1.  1. The original staging did not address the submodule commit-boundary rule. The new
       Submodule staging section fixes this.
2.  2. `searchTags from label/...` assumed an `Asset.label` field that does not exist.
       Stage 4 fixes this and names the real resolution path (`RefChip.label` /
       `promptview.ts`).
3.  3. `decodeImageBitmapFrom` was invented with no file, signature, or owning stage.
       Stage 4 fixes this by defining it as desktop-side glue with a named shape.
4.  4. `ImageBitmap` decode over the `vnasset://` custom protocol was asserted but never
       verified, and nothing in the codebase uses `ImageBitmap` today. The fix adds an
       explicit spike at the start of stage 1, with a named fallback if the spike fails.
5.  5. `ListBox` was cited as a virtualization precedent, but it only demonstrates
       permanent one-DOM-node-per-item rows. A correction under "Carried over from the
       sketch," redirects the typed-theme citation to `ui_button.ts` and flags stage 2 as
       built from zero.
6.  6. The `border`/`margin`/`padding` theme tokens have no sibling shape in `theme.ts`. A
       one-line flag under Theming fixes this. The gap is not blocking, because
       `theme_schema.ts` already supports nested records.

## As shipped

The change landed on 2026-09-01 on a worktree branch in five commits: three in
`vendor/path.ux`, then the gitlink bump and the desktop wiring in the parent.

**In path.ux**, `documentation/gallery.md` is the write-up. It is linked from
`documentation/index.md` and the widgets list in path.ux's own `CLAUDE.md`.

- `scripts/widgets/ui_gallery.ts` exports `GalleryItem`, `ThumbnailCache` (plus
  `sharedThumbnailCache`), `AssetThumb`, `AssetGalleryGrid`, `AssetGallery`,
  `pickAssetPopup`, and the two events (`GalleryChangeEvent`, `GalleryConfirmEvent`). All
  of these are exported through the `pathux` barrel.
- `scripts/core/theme.ts` — holds the `assetgallery` and `assetthumb` style classes.
- `tests/thumbnail_cache.test.ts` holds 8 vitest cases over eviction, coalescing and
  release, and `playwright/gallery.spec.ts` holds 6 DOM cases over pooling, scrolling,
  keys, selection, search and re-columning. The example app has a Gallery tab that the
  Playwright specs drive.

**In the desktop app:**

- `AssetListing` (`src/shared/ipc.ts`), `WorkspaceSession.assetLibrary()`, and the
  read-only `asset.list` command over that method.
- `renderer/pathux/assetthumb.ts` — `assetThumbUrl`, `loadAssetThumb`, `galleryItem`, with
  jest coverage in `renderer/pathux/tests/assetthumb.test.ts`.
- `renderer/rules/promptview.ts` holds a fifth clause act, `attach`, and `pickRef` in
  `renderer/pathux/editors/asset.ts` backs it.
- `anchors.json` was re-swept. It moves 40 → 47 anchored commands and gains seven strays,
  both from master commits it had not been measured against rather than from this work.

Three things are worth carrying forward:

- **The popup needed an `at` argument.** The Attach button is a raw DOM node in an
  `appendSurface` root, so `screen.popup`'s owner-corner placement put the popup in the
  wrong place. `PickAssetArgs.at` takes client coordinates instead.
- **Observe dismissal on `remove`, not `end`.** `makePopup`'s Escape and outside-click
  handlers call a local `end` closure, so replacing `popup.end` has no effect. Every
  teardown path calls `container.remove()`.
- **The name that stage 4 was scoped for already existed.** `labelAssets` names the whole
  manifest, so half of the stage exposed a name that was already there rather than
  building one. Pressure-test finding 2, which the stage came from, was still right that
  `Asset.label` does not exist; that gap sits one layer further along than the plan
  assumed.

The Open questions say that three things are unbuilt: multi-select, a live
data-path-backed item list, and slot-address refs through this UI.

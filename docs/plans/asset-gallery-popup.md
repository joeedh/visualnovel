# Asset gallery popup

Status: **planned**

## Context

- Today, attaching a reference image to a prompt clause means typing or pasting a raw asset
  hash (or a slot address) into a text prop — `prompt.addRef`'s `ref: prop.string(...)`
  (`apps/desktop/src/main/commands/prompt.ts:206`). No renderer surface calls this command yet:
  `chunkActs()` in `apps/desktop/renderer/pathux/editors/asset.ts:969` offers Mute/Replace/Append
  on a clause but no Attach, and `refStripEl()` (`asset.ts:899`) can only *detach* a ref
  (`prompt.dropRef`), via a `×` on each chip. This plan gives that button something to open.
- The fix is a reusable, virtualized, searchable thumbnail-grid widget, sketched earlier in this
  conversation: pooled DOM nodes (not canvas) recycled on scroll, so hover/click/tooltip stay
  native, plus a search bar filtering a caller-supplied `GalleryItem[]`.
- This plan adds the three things the sketch didn't cover: keyboard navigation, a global
  thumbnail cache, an explicit active/confirm selection model, and a full theme spec — then
  stages the build and names the one concrete consumer.

## Scope

- **Build in `vendor/path.ux`**, as a new widget alongside `ListBox` — zero VN-specific
  dependency, matching `GalleryItem` as an abstract contract. Lives at
  `scripts/widgets/ui_gallery.ts`, documented at `documentation/gallery.md` per the `ListBox`
  precedent.
- **Wire into the desktop app** at exactly one call site: an "Attach…" button in `chunkActs()`
  calling `prompt.addRef` with the picked hash.
- **Explicitly out of scope**, named so it isn't rediscovered as a gap: wiring the popup into
  the asset editor's Replace strip, into `assetAdopt`, or into any other hash-entry point. Those
  are follow-ons once this integration proves the widget out — a second consumer is also the
  first real test of the abstract `GalleryItem` contract.

## Carried over from the sketch

- Pooled DOM nodes (`AssetThumb`), absolutely positioned via `transform`, recycled on scroll —
  not a canvas — because tooltips, hover and click all need to stay native per the tooltip rule
  in `CLAUDE.md`.
- `GalleryItem.image` accepts a thunk (`() => Promise<HTMLImageElement | ImageBitmap>`) as well
  as a resolved value, since eager decoding for a whole asset library up front doesn't scale.
- `pickAssetPopup()` returns a `Promise<GalleryItem | undefined>`, mirroring the
  `VectorPopupButton` / `ColorPicker` popup pattern already in path.ux.

**Correction from the pressure-test pass**: `ListBox` (`vendor/path.ux/scripts/widgets/
ui_listbox.ts`) is cited throughout this plan as precedent, but `ListBox.addItem` (line 616)
creates one permanent real DOM `ListItem` per entry — it does no pooling and no virtualization.
There is **no existing virtualization precedent anywhere in path.ux**; the pool/scroll/rebind
mechanism in this plan is designed from zero, not adapted from something proven. `ListBox` is
still the right precedent for the *event* pattern (`"change"`, manual `addItem`-style API) and
for the keyboard-nav shape (its `onkeydown` Up/Down handling), just not for virtualization or
for typed theming — `ListBox`/`ListItem`'s `static define()` (lines 48, 235) declare no `theme`
block and still read untyped `getDefault("ListActive")`. For the typed `static define().theme`
pattern this plan uses, `scripts/widgets/ui_button.ts` is the widget that actually demonstrates
it; cite that instead when justifying the theming approach.

## Keyboard navigation

- Arrow keys move a **focus** cursor: Up/Down by one row (± `columns`), Left/Right by one cell,
  clamped rather than wrapping at grid edges.
- Home/End jump to the first/last item; PageUp/PageDown move by one viewport's worth of rows.
- Enter on the focused cell confirms, the same as a double-click.
- Moving focus must scroll the viewport to keep the focused index inside the pool's bound range
  *before* rebinding — the focused cell has to always be a real, bindable pool node, or arrow-key
  nav silently does nothing once the cursor scrolls past the overscan window.
- No type-ahead-to-jump: the search bar already does substring filtering, and a second,
  overlapping "jump by typing" gesture would just be two ways to do the same thing. Deliberately
  not building it.
- **Roving tabindex**: only the currently-focused pool node carries `tabindex="0"`; every other
  pool node is `-1`. A per-cell tab stop would put native DOM tab order at the mercy of which
  *pool slot* an item happens to occupy, which changes on every scroll — roving tabindex is the
  only version of this that's stable under recycling.

## Active item and confirm

Three independent states per cell, composited (not mutually exclusive — a cell can be hovered
*and* focused *and* active at once):

- **hover** — mouse over the cell (as `ListItem` already does).
- **focus** — the keyboard cursor (new; `ListItem` has no equivalent).
- **active** — the current selection, survives scrolling it out of view. `AssetGallery.active:
  GalleryItem | undefined`.

Events, mirroring the DOM-event direction path.ux is already moving in (`ListBox`'s `"change"`):

- `"change"` fires when `active` changes (click, or Enter on the focused cell). Detail:
  `{id, item}`. An inline-hosted gallery (e.g. a future "select an image, see a preview
  elsewhere" panel) only ever needs this event.
- `"confirm"` fires on double-click, Enter, or an explicit OK button — the "downstream use"
  signal the user asked for. `pickAssetPopup()` listens for `"confirm"` (not `"change"`) before
  it resolves and closes, and its popup wrapper grows an OK/Cancel footer rather than closing on
  the first click, since "select, then press OK" is one of the two stated use cases.
- Single click sets `active` and fires `"change"` only; it does **not** confirm. This is a
  change from the original sketch, which fired one event on click and treated it as both.

## Global thumbnail cache

- **Problem**: `AssetThumb.bindItem`'s async branch has no memoization — scrolling back over an
  item already seen, or reopening the popup, redecodes the image every time.
- `ThumbnailCache`: a small LRU keyed by `GalleryItem.id`, storing decoded `ImageBitmap`s,
  shared across every `AssetThumb` and every `AssetGallery` instance in the process — lives in
  path.ux next to the gallery (generic id → async-image cache, no `vnasset://` knowledge), not
  in the desktop app.
- `cache.get(id, loader): Promise<ImageBitmap>` coalesces concurrent requests for the same id
  through an in-flight-promise map — a fast scroll can ask for the same id twice before the
  first decode finishes, and without coalescing that's two decodes.
- Bounded by **entry count** (default 200), not bytes: eviction calls `.close()` on the dropped
  `ImageBitmap`, which is a cheap, precise release of the decoded bitmap's memory. Measuring
  decoded byte size for a byte-bound isn't worth it here.
- In-memory only, not persisted across app restarts — `vnasset://` reads are local and fast
  enough that a disk-backed cache would add invalidation complexity for no real win.
- The desktop's loader is `() => decodeImageBitmapFrom(`vnasset://${hash}.${ext}`)`; anything
  else (path.ux's own tests, a future non-VN host) can pass a synthetic loader.

## Theming

New `AssetThumb` style class (path.ux has no existing class that fits — `ListItem`'s two-state
highlight/active model is missing a third, non-exclusive focus state, and cells need a real box
model that list rows don't). Declared via `static define().theme` with typed `t.*` tokens:

| Key | Purpose |
| --- | --- |
| `background-color` | idle cell fill |
| `highlight` | mouseover fill |
| `active` | selected fill (composable with focus/hover) |
| `focusRing` | keyboard-focus outline — a ring, not a fill, so it stays visible when the same cell is also active |
| `border` | `{color, width}` around the cell |
| `margin` | space between cells (the sketch's `gap` becomes this) |
| `padding` | inset between the cell border and the thumbnail image |

- Regenerate `generated/themes.ts` / `generated/themes.json` (`pnpm run gen:themes`) as part of
  this work, and run `pnpm run gen:themes --strict` + `pnpm run typecheck:themes` before landing.
- `border` as a `{color, width}` structured token, and numeric `margin`/`padding`, have no
  sibling in `theme.ts` today — every existing `border` value there is a plain CSS shorthand
  string (e.g. `border: "none"`). `theme_schema.ts`'s `t.*` schema structurally supports nested
  sub-records (already used for `disabled`/`highlight`), so this is buildable, but it's a new
  theme-key shape, not a reuse of an established one — flagged rather than introduced silently.

## Submodule staging

`vendor/path.ux` is currently checked out on `master` — the same default branch the root
`CLAUDE.md`'s submodule rule and path.ux's own `CLAUDE.md` both call out: *"do not silently
commit or advance the submodule's shared default branch. Ask the user whether they want to
commit and/or push the submodule's default branch (and bump the gitlink) before doing so."*
Stages 1–3 below are entirely inside `vendor/path.ux`, so:

- Do the path.ux work on a feature branch inside the submodule (`git -C vendor/path.ux checkout
  -b asset-gallery`), not directly on its `master`.
- Commit there as work lands; the parent repo's gitlink only moves when the submodule checkout's
  `HEAD` does, so the parent stays clean to commit independently in the meantime.
- Before landing stage 4 (which needs the gitlink bumped so the desktop app can import the new
  widget), ask the user whether to merge the feature branch to path.ux's `master`, push it to
  path.ux's own origin, and bump the parent's gitlink — per the rule above, this repo does not
  do that silently.

## Staged implementation

1. **path.ux — spike, then cache + cell.** **Done.** Before writing `ThumbnailCache` for real: spike
   whether `createImageBitmap(await (await fetch('vnasset://<hash>.<ext>')).blob())` actually
   decodes cleanly from the `vnasset` custom protocol in the Electron renderer. No `ImageBitmap`
   usage exists anywhere in this codebase today, so this is unverified, not just unbuilt — favorable
   groundwork exists (`vnasset` is already registered with `{standard: true, secure: true,
   supportFetchAPI: true, stream: true}` in `apps/desktop/src/main/index.ts`), but confirm it
   before the cache is designed around `ImageBitmap`. If it fails, the cache falls back to
   caching `HTMLImageElement`s (decoded via a plain `<img src>` load) instead — the `.close()`
   eviction hook is `ImageBitmap`-only and would need to become "just drop the reference."
   Then: `GalleryItem`, `ThumbnailCache` (LRU, coalescing, evict-on-count), `AssetThumb`
   (bind/hover/focus/active states, tooltip, theme-driven border/padding/margin). Vitest
   coverage for the cache's eviction and coalescing logic in isolation — no DOM needed for that
   part.

   **Spike result (2026-09-01, run over CDP against the built app on a copy of
   `examples/mySampleRepo`).** `createImageBitmap` decodes cleanly from `vnasset://` for assets
   in both roots — base art under `assets/objects/` and shot frames under `vngen/build/assets/`
   — returning a bitmap whose `.close()` is a real function, so the eviction hook stands and the
   `HTMLImageElement` fallback is not needed. Two findings the cache and the loader are built
   around:
   - A missing hash answers `404` with an empty `text/html` body rather than failing the fetch,
     and `createImageBitmap` then throws `InvalidStateError: The source image could not be
     decoded`. The desktop loader checks `res.ok` and throws a named error instead of letting
     the decode report the failure.
   - `createImageBitmap(blob, {resizeWidth, resizeQuality})` works over the same protocol.
     Sample assets are 1024×1024, so an unresized 200-entry cache would hold roughly 840 MB of
     decoded pixels; the desktop loader decodes to a thumbnail width instead.
2. **path.ux — virtualized grid.** **Done.** `AssetGalleryGrid`: pool sizing off measured viewport,
   scroll→rebind, roving-tabindex keyboard nav with scroll-into-view-before-rebind. This has no
   in-repo precedent (see the `ListBox` correction above), so budget real iteration time here,
   not a port. Playwright DOM test covering scroll, arrow-key nav, and a resize-triggered pool
   resize.
3. **path.ux — outer widget.** **Done.** `AssetGallery` (search bar + grid, `active`/`"change"`/
   `"confirm"`), `pickAssetPopup()` with its OK/Cancel footer. Register the theme keys, run
   `gen:themes`. Write `documentation/gallery.md`.
4. **Desktop — data + wiring.** **Done.** Two things this stage owns that earlier drafts of this
   plan glossed over:
   - **`searchTags` needs real name resolution, not a spare field.** `Asset`
     (`packages/types/src/entities.ts`) has `kind` and `satisfies: AssetBinding[]` — no `label`.
     The human-readable name shown today (`RefChip.label`, resolved in
     `apps/desktop/renderer/rules/promptview.ts:265-289`) is computed per-clause-ref by
     resolving `AssetBinding.characterId`/`locationId` against the live `ProjectModel`. Building
     `GalleryItem[]` for the whole manifest means generalizing that resolution to run over every
     manifest entry up front, not reading a field that doesn't exist. This is real work, not
     data plumbing — scope it before starting stage 4.
   - **The `vnasset://` loader is desktop-only glue and needs a real home.** A small function
     (name TBD at write time, e.g. `loadAssetThumb(hash: string, ext: string):
     Promise<ImageBitmap>`) wrapping the fetch/decode spiked in stage 1 lives in the desktop
     renderer (near `asset.ts`, not in path.ux — `ThumbnailCache` stays loader-agnostic per its
     design above) and is what gets passed as each `GalleryItem.image` thunk.
   Add an "Attach…" button to `chunkActs()` that opens `pickAssetPopup()` and, on resolve, calls
   `prompt.addRef` with the picked hash. Note: `prompt.addRef`'s `ref` prop also accepts a slot
   address (`portrait:<character>`, etc.), not just a hash — this button only ever supplies a
   hash, so slot-address refs remain reachable solely through the command palette/agent, not
   through this UI. That's an accepted scope limit (see Open questions), not an oversight.

   **Result.** The name resolution turned out to exist already: `labelAssets`
   (`apps/desktop/src/main/assetlabel.ts`) names the whole manifest at once, and is what the
   document tree draws from. So the work was exposing it to the renderer rather than writing it —
   a new `AssetListing` shape, `WorkspaceSession.assetLibrary()` behind it, and a read-only
   `asset.list` command the renderer reaches through `exec`. The loader landed as
   `apps/desktop/renderer/pathux/assetthumb.ts`, holding `assetThumbUrl`, `loadAssetThumb` (which
   checks `res.ok` before decoding, per the stage-1 spike, and decodes at a thumbnail width) and
   `galleryItem`, which projects one listing into the widget's item shape.

   Placing the popup needed one change back in path.ux: the Attach button is a raw DOM node in an
   `appendSurface` root rather than a widget, so `pickAssetPopup` grew an `at` argument taking
   client coordinates, and the editor passes the button's own rect.
5. **Verify in the running app.** **Done.** Open a project with a real asset library (`pnpm run`
   skill); confirm scroll performance, search, full keyboard nav, and the attach flow end to end.

   **Result** (over CDP, against the built app on a 70-asset copy of the sample project, with the
   Aiko portrait open in the asset pane):
   - Clicking Attach on the `style` clause opened the popup holding all 70 items behind a pool of
     27 cells in 3 columns, and every one of the 27 painted a decoded thumbnail rather than an
     empty cell.
   - Scrolling the grid across 40 frames moved `firstBoundIndex` from 0 to 51 over 18 distinct
     rebinds while `poolSize` stayed 27 and the whole grid held 139 DOM nodes; the 40 frames took
     639 ms, which is the vsync cadence rather than a frame budget being missed.
   - Arrow keys moved by one cell and by one row, End jumped to item 69 and rebound the pool to
     start at 54, Home returned to 0, and Up and Left clamped there instead of wrapping.
   - The search box narrowed 70 items to 2 on `portrait`, to 27 on `accepted`, to none on a
     string nothing matches, and back to 70 when cleared.
   - Enter on the focused cell closed the popup and ran
     `prompt.addRef(hash='6f41ba9a…' chunk='style' ref='05e0b18a…')`, which answered
     `Attached 05e0b18a to "style"`.

## Open questions

Left unresolved on purpose — for the pressure-test pass or the user, not guessed at here:

- **Pool/overscan sizing.** Starting value: 2 overscan rows each side. Needs profiling against a
  real asset count (a project can have hundreds of generated frames) before it's trusted.
- **Manual vs. data-path-backed items.** `ListBox` supports both manual `addItem` and a live
  `DataList` binding; this plan builds manual `setItems()` only, since the one known consumer
  (`prompt.addRef`) wants a snapshot at popup-open time, not a live-updating list. Revisit if a
  second consumer needs live updates.
- **Multi-select.** The one known consumer attaches one ref per call, so this plan is
  single-select only. Multi-select (attach several at once) is a real future want but not built
  here.
- **Slot-address refs stay hash-only through this UI.** `prompt.addRef`'s `ref` prop accepts a
  slot address as well as a hash; the gallery only ever picks a concrete asset, so it only ever
  supplies a hash. Typing a slot address by hand remains the only way to attach one through the
  command palette or the agent. Not revisited unless a consumer specifically wants "attach
  whatever currently fills this slot."

## Pressure-test findings (fresh-context review, folded in above)

Run per `docs/reference/conventions.md`'s plan convention before work started. All six findings
were fixed in place (see the sections above); recorded here so the review itself isn't lost:

1. Submodule commit-boundary rule was unaddressed by the original staging → fixed with the new
   **Submodule staging** section.
2. `searchTags from label/...` assumed an `Asset.label` field that doesn't exist → fixed in
   stage 4, naming the real resolution path (`RefChip.label` / `promptview.ts`).
3. `decodeImageBitmapFrom` was invented with no file, signature, or owning stage → fixed in
   stage 4 as desktop-side glue with a named shape.
4. `ImageBitmap` decode over the `vnasset://` custom protocol was asserted, never verified, and
   nothing in the codebase uses `ImageBitmap` today → fixed by adding an explicit spike at the
   start of stage 1, with a named fallback if it fails.
5. `ListBox` was cited as virtualization precedent but only demonstrates permanent one-DOM-node-
   per-item rows → fixed with a correction under "Carried over from the sketch," redirecting the
   typed-theme citation to `ui_button.ts` and flagging stage 2 as built from zero.
6. The `border`/`margin`/`padding` theme tokens have no sibling shape in `theme.ts` → fixed with
   a one-line flag under Theming; not blocking, `theme_schema.ts` already supports nested
   records.

## As shipped

Landed 2026-09-01, on a worktree branch, in five commits — three in `vendor/path.ux`, then the
gitlink bump and the desktop wiring in the parent.

**In path.ux** (`documentation/gallery.md` is the write-up; linked from `documentation/index.md`
and the widgets list in path.ux's own `CLAUDE.md`):

- `scripts/widgets/ui_gallery.ts` — `GalleryItem`, `ThumbnailCache` (+ `sharedThumbnailCache`),
  `AssetThumb`, `AssetGalleryGrid`, `AssetGallery`, `pickAssetPopup`, and the two events
  (`GalleryChangeEvent`, `GalleryConfirmEvent`). Exported through the `pathux` barrel.
- `scripts/core/theme.ts` — the `assetgallery` and `assetthumb` style classes.
- `tests/thumbnail_cache.test.ts` (8 vitest cases over eviction, coalescing and release) and
  `playwright/gallery.spec.ts` (6 DOM cases over pooling, scrolling, keys, selection, search and
  re-columning). The example app grew a Gallery tab for the Playwright specs to drive.

**In the desktop app:**

- `AssetListing` (`src/shared/ipc.ts`), `WorkspaceSession.assetLibrary()`, and the read-only
  `asset.list` command over it.
- `renderer/pathux/assetthumb.ts` — `assetThumbUrl`, `loadAssetThumb`, `galleryItem`, with jest
  coverage in `renderer/pathux/tests/assetthumb.test.ts`.
- A fifth clause act, `attach`, in `renderer/rules/promptview.ts`, and `pickRef` in
  `renderer/pathux/editors/asset.ts` behind it.
- `anchors.json` re-swept. It moves 40 → 47 anchored commands and gains seven strays, both from
  master commits it had not been measured against rather than from this work.

Three things worth carrying forward:

- **The popup needed an `at` argument.** The Attach button is a raw DOM node in an
  `appendSurface` root, so `screen.popup`'s owner-corner placement put the popup in the wrong
  place. `PickAssetArgs.at` takes client coordinates instead.
- **Dismissal is observed on `remove`, not `end`.** `makePopup`'s Escape and outside-click
  handlers call a local `end` closure, so overriding `popup.end` sees nothing; every teardown
  path does funnel through `container.remove()`.
- **The name resolution stage 4 was scoped for already existed.** `labelAssets` names the whole
  manifest, so that half of the stage was exposure rather than construction. The finding it came
  from (pressure-test finding 2) was still right that `Asset.label` does not exist — it just
  landed one layer further along than the plan assumed.

Left unbuilt, as the Open questions say: multi-select, a live data-path-backed item list, and
slot-address refs through this UI.

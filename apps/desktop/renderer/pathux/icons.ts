/**
 * The app's own icons, added alongside path.ux's sheet.
 *
 * An id is **allocated asynchronously and may never arrive**: `iconmanager.addCustomIcon` calls
 * `regenIcons()` synchronously, which draws the tile from an image that has not decoded yet, and
 * blob encoding is async on top — registering eagerly yields a blank tile. So registration waits
 * on `decode()`, the id starts at `-1`, and every caller is expected to draw a text button while
 * it still is. A decode that never lands costs a glyph, not a control.
 */
import { iconmanager, setIconMap } from 'pathux';

/** Ids allocated for this app's icons. `-1` until — and if — the image decodes. */
export const VN_ICONS: { filter: number } = { filter: -1 };

/** A funnel, drawn to the sheet's 32px tile. Inline so nothing is fetched at runtime. */
const FILTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<path d="M5 7h22l-8.5 10v7l-5 3v-10z" fill="none" stroke="black" stroke-width="2.5" ' +
  'stroke-linejoin="round"/></svg>';

/**
 * Start registering the custom icons. Returns immediately; the ids land later. Called from
 * `installIcons`, which must stay synchronous — the first header built needs an icon manager.
 */
export function registerCustomIcons(): void {
  const image = new Image(32, 32);
  image.src = `data:image/svg+xml;utf8,${encodeURIComponent(FILTER_SVG)}`;
  void image
    .decode()
    .then(() => {
      VN_ICONS.filter = iconmanager.addCustomIcon('vn-filter', image);
      setIconMap({ VN_FILTER: VN_ICONS.filter });
    })
    .catch(() => {
      // Left at -1 on purpose: callers fall back to a labelled button.
      console.warn('the filter icon did not decode; falling back to a text button');
    });
}

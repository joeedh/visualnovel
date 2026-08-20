/**
 * The app's own icons, added alongside path.ux's sheet.
 *
 * An id is allocated asynchronously and may never arrive. `iconmanager.addCustomIcon` calls
 * `regenIcons()` synchronously, which draws the tile from an image that has not decoded yet, and
 * blob encoding is async on top, so registering eagerly yields a blank tile. Registration
 * therefore waits on `decode()`, the id starts at `-1`, and every caller is expected to draw a
 * text button while the id is still `-1`. A decode that never lands costs a glyph, not a control.
 */
import { iconmanager, setIconMap } from 'pathux';

/** Ids allocated for this app's icons. Each stays `-1` until its image decodes. */
export const VN_ICONS: { filter: number; collapse: number; pin: number } = {
  filter: -1,
  collapse: -1,
  pin: -1,
};

/** A funnel, drawn to the sheet's 32px tile. Inline so nothing is fetched at runtime. */
const FILTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<path d="M5 7h22l-8.5 10v7l-5 3v-10z" fill="none" stroke="black" stroke-width="2.5" ' +
  'stroke-linejoin="round"/></svg>';

/**
 * Two chevrons closing onto a line: everything above folds down and everything below folds up,
 * which is what collapsing a whole tree looks like. Drawn to the same 32px tile.
 */
const COLLAPSE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<g fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round">' +
  '<path d="M9 5l7 7 7-7"/><path d="M4 16h24"/><path d="M9 27l7-7 7 7"/>' +
  '</g></svg>';

/**
 * A drawing pin seen from the side, head up and point down, matching the shape of Blender's pin
 * so an author who knows one recognises the other. Same 32px tile.
 */
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<g fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round">' +
  '<path d="M12 4h8v8l4 5H8l4-5z"/><path d="M16 17v11"/>' +
  '</g></svg>';

/** One icon to register: what to call it, the name a `setIconMap` entry uses, and its drawing. */
const CUSTOM: { key: keyof typeof VN_ICONS; name: string; map: string; svg: string }[] = [
  { key: 'filter', name: 'vn-filter', map: 'VN_FILTER', svg: FILTER_SVG },
  { key: 'collapse', name: 'vn-collapse', map: 'VN_COLLAPSE', svg: COLLAPSE_SVG },
  { key: 'pin', name: 'vn-pin', map: 'VN_PIN', svg: PIN_SVG },
];

/**
 * Start registering the custom icons. Returns immediately; the ids land later. Called from
 * `installIcons`, which must stay synchronous — the first header built needs an icon manager.
 *
 * Each icon lands on its own: one that fails to decode costs its own glyph and nothing else, and
 * the map is rewritten with what has arrived so far rather than waiting for the whole set.
 */
export function registerCustomIcons(): void {
  const map: Record<string, number> = {};
  let outstanding = CUSTOM.length;
  const settle = (): void => {
    if (--outstanding > 0) return;
    settled = true;
    for (const waiter of waiting.splice(0)) waiter();
  };
  for (const icon of CUSTOM) {
    const image = new Image(32, 32);
    image.src = `data:image/svg+xml;utf8,${encodeURIComponent(icon.svg)}`;
    void image
      .decode()
      .then(() => {
        VN_ICONS[icon.key] = iconmanager.addCustomIcon(icon.name, image);
        map[icon.map] = VN_ICONS[icon.key];
        setIconMap({ ...map });
      })
      .catch(() => {
        // Left at -1 on purpose: callers fall back to a labelled button.
        console.warn(`the ${icon.name} icon did not decode; falling back to a text button`);
      })
      .finally(settle);
  }
}

/** Whether every icon has landed or failed. Nothing changes after this. */
let settled = false;
const waiting: (() => void)[] = [];

/**
 * Run `cb` once the ids have stopped changing — every icon has decoded or given up.
 *
 * A bar rebuilt on every update picks the icon up by itself. A control built once in `init()` is
 * built before the first `decode()` resolves, so its text fallback would otherwise be permanent.
 * Registering after everything has settled runs `cb` straight away.
 */
export function whenIconsSettled(cb: () => void): void {
  if (settled) cb();
  else waiting.push(cb);
}

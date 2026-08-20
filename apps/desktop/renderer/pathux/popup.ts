/**
 * Shared chrome for the screen popups — the command palette, the command dialog, and the report
 * preview.
 *
 * path.ux hands back a plain container, so without this a dialog is a box the same colour as the
 * pane behind it and nothing says where it ends. The size is a **cap, not a size**: a fixed pixel
 * width is wider than the window on a small screen, and one long description or a check note of
 * several lines stretches the box until it fills it. Both are bounded here, once, so a popup can
 * only ever be as big as there is room for.
 */
import type { Container } from 'pathux';

/** How much of the window a popup may take before it starts scrolling instead of growing. */
const MARGIN = 24;

/** The gap kept below a popup, so its last row is never flush with the bottom edge. */
const BOTTOM = 48;

/** The breathing room inside a popup's border. path.ux hands back a container with none. */
const PAD = 20;

/** The border. Two pixels of `--sodium`, either side. */
const BORDER = 2;

/**
 * What the border and the padding take off a popup's width. Prose is wrapped to a pixel width
 * (`paragraph`), so it has to be told what is actually left inside the box.
 */
export const INSET = (PAD + BORDER) * 2;

/** Only what is read off the screen. Its `size` is a path.ux vector, not an array. */
interface Screenish {
  size: { 0: number; 1: number };
}

/**
 * Bound a popup to the window and give it a border of its own. `setCSSAfter` because path.ux
 * rewrites a container's box from the theme on every `flushUpdate`, which drops a plain write.
 */
export function stylePopup(popup: Container, screen: Screenish, width: number, top: number): void {
  const room = Math.max(240, (screen.size[0] ?? width) - MARGIN * 2);
  const tall = Math.max(200, (screen.size[1] ?? 600) - top - BOTTOM);

  popup.style['width'] = `${Math.min(width, room)}px`;
  popup.setCSSAfter(() => {
    popup.style['maxWidth'] = `${room}px`;
    popup.style['maxHeight'] = `${tall}px`;
    popup.style['overflowY'] = 'auto';
    // Never sideways: prose is wrapped to `INSET` by `paragraph`, so anything still too wide is
    // a widget that would not have been readable at the end of a scrollbar either.
    popup.style['overflowX'] = 'hidden';
    popup.style['padding'] = `${PAD}px`;
    // The width above is the whole box, border and padding included, which is what the cap means.
    popup.style['boxSizing'] = 'border-box';
    popup.style['border'] = `${BORDER}px solid var(--sodium, #f4a24c)`;
    popup.style['borderRadius'] = 'var(--r-soft, 10px)';
    popup.style['boxShadow'] = 'var(--shadow, 0 18px 50px -22px rgba(0, 0, 0, 0.8))';
  });
}

/** Where a popup of this width starts, so it is centred and never off the left edge. */
export function popupLeft(screen: Screenish, width: number): number {
  const room = Math.max(240, (screen.size[0] ?? width) - MARGIN * 2);
  return Math.max(
    MARGIN / 2,
    Math.round((screen.size[0] ?? width) / 2 - Math.min(width, room) / 2),
  );
}

/**
 * Run `closed` once, whenever this popup goes away — however it went.
 *
 * It hooks `remove` rather than `end`, and that is the whole point. `Screen._popup` keeps its own
 * closure over the real `end` and hands Escape, the click-outside watcher and `_ondestroy` *that*
 * one, so a module that overrode the `end` property is never told: the box disappears and the
 * `let open` guarding it stays set, which is a palette that stops answering `/` and a menu entry
 * that opens nothing for the rest of the session. Every one of those paths finishes at `remove()`,
 * which is only ever reached through the property — so this is the hook that cannot be walked past.
 */
export function onPopupClosed(popup: Container, closed: () => void): void {
  const remove = popup.remove.bind(popup);
  let done = false;
  popup.remove = (...args: [boolean?]) => {
    if (!done) {
      done = true;
      closed();
    }
    // Forwarded with the arity it was called with: path.ux's own wrapper reads `arguments.length`
    // to tell "close this popup" from "detach this element", and a defaulted argument is a lie.
    if (args.length === 0) remove();
    else remove(args[0]);
  };
}

/**
 * Outlines a pane once, so an author can see where a command they did not click sent the view.
 *
 * Drawn as a throwaway overlay on `document.body` rather than as a class on the pane, because a
 * pane is a path.ux `ScreenArea` whose children paint over its own border and whose sheet lives
 * in a shadow root this file does not own. An absolutely positioned sibling is subject to
 * neither, and the Web Animations API means it needs no stylesheet at all.
 */
const FLASH_MS = 600;

export function flashRect(rect: { x: number; y: number; width: number; height: number }): void {
  if (rect.width <= 0 || rect.height <= 0) return;
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position     : 'fixed',
    left         : `${rect.x}px`,
    top          : `${rect.y}px`,
    width        : `${rect.width}px`,
    height       : `${rect.height}px`,
    pointerEvents: 'none',
    zIndex       : '9000',
    borderRadius : '4px',
    boxSizing    : 'border-box',
  });
  document.body.appendChild(overlay);

  // Amber, the colour the header uses for the author's own actions. Two pulses rather than one
  // fade, because a single pulse reads as a rendering glitch
  const animation = overlay.animate(
    [
      { boxShadow: 'inset 0 0 0 2px rgba(244, 162, 76, 0.95)' },
      { boxShadow: 'inset 0 0 0 2px rgba(244, 162, 76, 0.15)' },
      { boxShadow: 'inset 0 0 0 2px rgba(244, 162, 76, 0.95)' },
      { boxShadow: 'inset 0 0 0 2px rgba(244, 162, 76, 0)' },
    ],
    { duration: FLASH_MS, easing: 'ease-out' },
  );
  // The timeout is the backstop. A window that is not being painted does not tick a main-thread
  // animation, so `finish` would not fire until the app came forward, leaving the outline over
  // the pane until then
  const done = (): void => overlay.remove();
  animation.addEventListener('finish', done);
  animation.addEventListener('cancel', done);
  setTimeout(done, FLASH_MS + 100);
}

/** How long {@link holdRect} keeps pulsing before it takes itself down. */
const HOLD_MS = 6000;

/**
 * Outlines a pane and keeps pulsing it for `HOLD_MS`, or until the returned function is called.
 * Drawn the same way as {@link flashRect}, in the vermilion the refusal palette uses, because
 * this outline marks a pane that stopped something — a quit refused over its unsaved draft —
 * rather than one a command sent the author to.
 */
export function holdRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): () => void {
  if (rect.width <= 0 || rect.height <= 0) return () => {};
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position     : 'fixed',
    left         : `${rect.x}px`,
    top          : `${rect.y}px`,
    width        : `${rect.width}px`,
    height       : `${rect.height}px`,
    pointerEvents: 'none',
    zIndex       : '9000',
    borderRadius : '4px',
    boxSizing    : 'border-box',
  });
  document.body.appendChild(overlay);
  const animation = overlay.animate(
    [
      { boxShadow: 'inset 0 0 0 3px rgba(229, 83, 75, 0.95)' },
      { boxShadow: 'inset 0 0 0 3px rgba(229, 83, 75, 0.25)' },
      { boxShadow: 'inset 0 0 0 3px rgba(229, 83, 75, 0.95)' },
    ],
    { duration: 1200, iterations: Infinity, easing: 'ease-in-out' },
  );
  let down = false;
  const done = (): void => {
    if (down) return;
    down = true;
    animation.cancel();
    overlay.remove();
  };
  setTimeout(done, HOLD_MS);
  return done;
}

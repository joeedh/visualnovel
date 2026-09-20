/**
 * The window zoom steps, the way a desktop browser's Ctrl+plus and Ctrl+minus step through
 * them. Zoom scales every CSS pixel, so text and widgets grow together and the mesh relays out
 * for the new `devicePixelRatio`. Pure and shared, so main steps the factor and the menu can say
 * what the next step is.
 */

/** The factors offered, in order. `1` is the unzoomed window. */
export const ZOOM_STEPS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
];

/** The three moves a zoom command makes. */
export const ZOOM_MOVES = ['in', 'out', 'reset'] as const;
export type ZoomMove = (typeof ZOOM_MOVES)[number];

/** The install-level session key the factor is remembered under, so every window opens at it. */
export const ZOOM_KEY = 'vn.zoom';

/** The index of the step nearest `factor`, so a factor set outside the table still steps from it. */
function nearest(factor: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i]! - factor) < Math.abs(ZOOM_STEPS[best]! - factor)) best = i;
  }
  return best;
}

/** The factor after `move` from `factor`: the next step up or down, clamped, or `1`. */
export function zoomAfter(factor: number, move: ZoomMove): number {
  if (move === 'reset') return 1;
  const at = nearest(factor);
  const next = move === 'in' ? Math.min(at + 1, ZOOM_STEPS.length - 1) : Math.max(at - 1, 0);
  return ZOOM_STEPS[next]!;
}

/** `125%`, for a menu row or a note. */
export function zoomLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

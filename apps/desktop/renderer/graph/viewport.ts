/**
 * Pan/zoom for a graph canvas. The viewport is a similarity transform applied in screen
 * space — `screen = world * scale + translate` — which is exactly what an SVG
 * `translate(tx,ty) scale(s)` does, so the numbers here and the numbers in the DOM cannot
 * drift apart.
 *
 * All functions are pure and return a new viewport; nothing mutates.
 */
import type { Point, Rect, Size } from './types.js';

export interface Viewport {
  /** Screen-space translation applied after scaling. */
  x: number;
  y: number;
  scale: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export const DEFAULT_ZOOM: ZoomLimits = { min: 0.2, max: 2.5 };

export const IDENTITY: Viewport = { x: 0, y: 0, scale: 1 };

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

export function toScreen(vp: Viewport, p: Point): Point {
  return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
}

export function toWorld(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

/**
 * Convert a screen-space distance to world units. Hit slop is authored in screen pixels, so that
 * a target is equally easy to hit at every zoom level, and it must be divided by the scale before
 * it meets world geometry.
 */
export const screenToWorldDistance = (vp: Viewport, px: number): number => px / vp.scale;

/** Pan by a screen-space delta (a pointer drag is already in screen units). */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy };
}

/**
 * Zoom about a screen point. The world point under the cursor stays under the cursor.
 */
export function zoomAt(
  vp: Viewport,
  screenPoint: Point,
  factor: number,
  limits: ZoomLimits = DEFAULT_ZOOM,
): Viewport {
  const scale = clamp(vp.scale * factor, limits.min, limits.max);
  if (scale === vp.scale) return vp;
  const ratio = scale / vp.scale;
  return {
    scale,
    x: screenPoint.x - (screenPoint.x - vp.x) * ratio,
    y: screenPoint.y - (screenPoint.y - vp.y) * ratio,
  };
}

export interface FitOptions {
  padding?: number;
  limits?: ZoomLimits;
  /** Cap for the fit scale. Fitting one small node to a large window shouldn't magnify it. */
  maxScale?: number;
}

/**
 * The viewport that centres `content` inside a `viewport`-sized surface. An empty or
 * degenerate box centres at scale 1 rather than dividing by zero.
 */
export function fit(content: Rect, surface: Size, opts: FitOptions = {}): Viewport {
  const { padding = 48, limits = DEFAULT_ZOOM, maxScale = 1 } = opts;
  const availW = Math.max(1, surface.width - padding * 2);
  const availH = Math.max(1, surface.height - padding * 2);

  const raw =
    content.width > 0 && content.height > 0
      ? Math.min(availW / content.width, availH / content.height)
      : 1;
  const scale = clamp(Math.min(raw, maxScale), limits.min, limits.max);

  return {
    scale,
    x: surface.width / 2 - (content.x + content.width / 2) * scale,
    y: surface.height / 2 - (content.y + content.height / 2) * scale,
  };
}

/** The SVG transform for a `<g>` wrapping world-space content. */
export const transformOf = (vp: Viewport): string =>
  `translate(${vp.x} ${vp.y}) scale(${vp.scale})`;

/**
 * The same transform for an HTML layer. It has to be built separately: CSS `translate()` needs
 * units and a comma, and the parser drops a CSS transform it rejects without reporting an error,
 * leaving the layer at world coordinates.
 */
export const cssTransformOf = (vp: Viewport): string =>
  `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`;

/**
 * A wheel event's zoom factor. Trackpads emit many small deltas and mice a few large ones, so
 * this is exponential in the delta rather than linear — the same gesture covers the same
 * range on both.
 */
export const wheelFactor = (deltaY: number): number => Math.exp(-deltaY / 400);

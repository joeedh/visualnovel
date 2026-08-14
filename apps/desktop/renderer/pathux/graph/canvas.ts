/**
 * The shared graph surface as plain DOM: two co-transformed layers — SVG for wires, HTML for
 * nodes and labels — plus pan, zoom and pick routing. It is the port of
 * `renderer/graph/Canvas.tsx`, and it takes the pure modules with it unchanged: layout,
 * routing, hit-testing and the viewport algebra all still live in `renderer/graph/` with
 * their own tests, so this file is glue and nothing else.
 *
 * Nodes are HTML rather than SVG because they are typeset material (an index card, a choice
 * label in italic prose) and SVG text has no line wrapping. Both layers carry the *same*
 * viewport transform, so a wire and the card it touches cannot drift apart.
 *
 * All interaction resolves through `pick`, one source of truth for "what is under the
 * pointer" — the node layer is `pointer-events: none`, and a node element that needs a real
 * DOM target (a button on a card) opts that one element back in.
 *
 * It is deliberately **not** a path.ux widget. Widgets are chrome; this is a viewport onto
 * world-space geometry with a transform of its own, and wrapping it in a `UIBase` would add a
 * second layout pass that has nothing to say about it. An editor owns one and appends
 * `element`. There is no teardown to remember: every listener is on `element` and the
 * `ResizeObserver` watches only `element`, so all of it is collectible with the area itself.
 */
import { pick, type Pick, type PickOptions } from '../../graph/hit.js';
import {
  DEFAULT_ZOOM,
  IDENTITY,
  cssTransformOf,
  fit,
  panBy,
  transformOf,
  wheelFactor,
  zoomAt,
  type Viewport,
  type ZoomLimits,
} from '../../graph/viewport.js';
import { TOKENS, alpha } from '../tokens.js';
import type { EdgeRoute } from '../../graph/edges.js';
import type { GraphLayout } from '../../graph/layout.js';
import type { LaidOutNode, Point, Size } from '../../graph/types.js';

const SVG = 'http://www.w3.org/2000/svg';

/** How a wire is stroked. The canvas has no vocabulary for `EdgeRoute.kind` — the caller does. */
export interface EdgeStyle {
  stroke: string;
  width?: number;
  dash?: string;
  opacity?: number;
}

export interface CanvasContent {
  layout: GraphLayout;
  edges: EdgeRoute[];
  /** One element per node, positioned by the canvas. Return null to draw nothing. */
  renderNode: (node: LaidOutNode) => HTMLElement | null;
  /** Optional per-edge label, centred on the route's anchor. */
  renderLabel?: (edge: EdgeRoute) => HTMLElement | null;
}

export interface CanvasOptions {
  zoom?: ZoomLimits;
  pickOptions?: PickOptions;
  edgeStyle?: (edge: EdgeRoute) => EdgeStyle;
  onPick?: (hit: Pick, event: PointerEvent) => void;
  /** Fires on mount and on every resize, so the owner can fit content to the surface. */
  onSurfaceChange?: (size: Size) => void;
}

const DEFAULT_EDGE: EdgeStyle = { stroke: TOKENS.mistDim, width: 1.5 };

/** Marker ids are document-unique per instance, so two canvases cannot share an arrowhead. */
let markerSeq = 0;

export class GraphCanvas {
  readonly element: HTMLDivElement;

  private readonly wires: SVGSVGElement;
  private readonly wireGroup: SVGGElement;
  private readonly layer: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private readonly opts: CanvasOptions;
  /** `url(#…)` for this instance's arrowhead. */
  private readonly arrow: string;

  private content: CanvasContent | undefined;
  private overlay: Element | undefined;
  private view: Viewport = IDENTITY;
  private pan: { pointerId: number; x: number; y: number } | undefined;

  /** The surface's own size, once it has one. Fitting needs it and mount order does not give it. */
  surface: Size | undefined;

  constructor(opts: CanvasOptions = {}) {
    this.opts = opts;

    this.element = document.createElement('div');
    Object.assign(this.element.style, {
      position: 'relative',
      overflow: 'hidden',
      background: TOKENS.inkSunken,
      // A faint plotting grid, so panning an empty region still reads as movement.
      backgroundImage: `radial-gradient(circle at 1px 1px, ${TOKENS.inkLineSoft} 1px, transparent 0)`,
      backgroundSize: '32px 32px',
      cursor: 'grab',
      touchAction: 'none',
      userSelect: 'none',
    });

    this.wires = document.createElementNS(SVG, 'svg');
    Object.assign(this.wires.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      overflow: 'visible',
    });
    const markerId = `vn-graph-arrow-${++markerSeq}`;
    const defs = document.createElementNS(SVG, 'defs');
    const marker = document.createElementNS(SVG, 'marker');
    marker.setAttribute('id', markerId);
    marker.setAttribute('viewBox', '0 0 8 8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '4');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const head = document.createElementNS(SVG, 'path');
    head.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
    head.setAttribute('fill', TOKENS.mistDim);
    marker.appendChild(head);
    defs.appendChild(marker);
    this.wires.appendChild(defs);
    this.arrow = `url(#${markerId})`;

    this.wireGroup = document.createElementNS(SVG, 'g');
    this.wires.appendChild(this.wireGroup);
    this.element.appendChild(this.wires);

    this.layer = document.createElement('div');
    Object.assign(this.layer.style, {
      position: 'absolute',
      inset: '0',
      transformOrigin: '0 0',
      pointerEvents: 'none',
    });
    this.element.appendChild(this.layer);

    // React's wheel handler is passive, so `preventDefault` there is a no-op and the window (or
    // Electron's own zoom) eats the gesture. Native and non-passive is the only way to own it.
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerup', this.onPointerEnd);
    this.element.addEventListener('lostpointercapture', this.onPointerEnd);

    this.observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (!box) return;
      this.surface = { width: box.width, height: box.height };
      this.opts.onSurfaceChange?.(this.surface);
    });
    this.observer.observe(this.element);
  }

  get viewport(): Viewport {
    return this.view;
  }

  set viewport(next: Viewport) {
    if (next === this.view) return;
    this.view = next;
    this.applyTransform();
  }

  /** Replace what is drawn. Cheap enough to call per change: a task graph is tens of nodes. */
  setContent(content: CanvasContent): void {
    this.content = content;
    this.draw();
  }

  /** World-space extras above the wires and below the nodes — a gate rule, a ghost edge. */
  setOverlay(element: Element | undefined): void {
    this.overlay = element;
    this.draw();
  }

  /** Centre the laid-out content in the surface. A no-op until the surface has a size. */
  fitToContent(maxScale = 1): void {
    const bounds = this.content?.layout.bounds;
    if (!bounds || !this.surface || this.content?.layout.nodes.length === 0) return;
    this.viewport = fit(bounds, this.surface, { limits: this.opts.zoom ?? DEFAULT_ZOOM, maxScale });
  }

  private draw(): void {
    this.wireGroup.textContent = '';
    this.layer.textContent = '';
    if (!this.content) return;

    const { layout, edges, renderNode, renderLabel } = this.content;
    const style = this.opts.edgeStyle;

    for (const edge of edges) {
      const path = document.createElementNS(SVG, 'path');
      const look = style?.(edge) ?? DEFAULT_EDGE;
      path.setAttribute('d', edge.path);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', look.stroke);
      path.setAttribute('stroke-width', String(look.width ?? 1.5));
      if (look.dash) path.setAttribute('stroke-dasharray', look.dash);
      // A back edge is the same relation drawn the wrong way up the ranks; fading it says so
      // without inventing a second colour for it.
      const opacity = look.opacity ?? (edge.back ? 0.55 : 1);
      if (opacity !== 1) path.setAttribute('opacity', String(opacity));
      path.setAttribute('marker-end', this.arrow);
      this.wireGroup.appendChild(path);
    }

    if (this.overlay) this.layer.appendChild(this.overlay);

    for (const node of layout.nodes) {
      const content = renderNode(node);
      if (!content) continue;
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'absolute',
        left: `${node.x}px`,
        top: `${node.y}px`,
        width: `${node.width}px`,
        height: `${node.height}px`,
      });
      box.appendChild(content);
      this.layer.appendChild(box);
    }

    if (renderLabel) {
      for (const edge of edges) {
        const content = renderLabel(edge);
        if (!content) continue;
        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'absolute',
          left: `${edge.labelAnchor.x}px`,
          top: `${edge.labelAnchor.y}px`,
          transform: 'translate(-50%, -50%)',
          maxWidth: '220px',
          padding: '1px 6px',
          background: alpha(TOKENS.inkSunken, 0.92),
          color: TOKENS.paper,
          fontFamily: TOKENS.prose,
          fontStyle: 'italic',
          fontSize: '13px',
          lineHeight: '1.25',
          textAlign: 'center',
        });
        box.appendChild(content);
        this.layer.appendChild(box);
      }
    }

    this.applyTransform();
  }

  private applyTransform(): void {
    this.wireGroup.setAttribute('transform', transformOf(this.view));
    this.layer.style.transform = cssTransformOf(this.view);
  }

  private local(clientX: number, clientY: number): Point {
    const box = this.element.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const at = this.local(event.clientX, event.clientY);
    this.viewport = zoomAt(
      this.view,
      at,
      wheelFactor(event.deltaY),
      this.opts.zoom ?? DEFAULT_ZOOM,
    );
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const at = this.local(event.clientX, event.clientY);
    const hit = this.content
      ? pick(this.content.layout, this.content.edges, at, this.view, this.opts.pickOptions)
      : ({ type: 'background' } as Pick);

    this.opts.onPick?.(hit, event);
    if (hit.type !== 'background' || event.defaultPrevented) return;

    // The drag is armed before the capture is asked for: capture is an optimisation (it keeps
    // the pan alive off the element), and a browser that refuses it must not cost panning.
    this.pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.element.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.pan;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.viewport = panBy(this.view, event.clientX - drag.x, event.clientY - drag.y);
    this.pan = { ...drag, x: event.clientX, y: event.clientY };
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const drag = this.pan;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.pan = undefined;
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
  };
}

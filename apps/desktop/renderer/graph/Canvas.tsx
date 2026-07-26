/**
 * The thin shell around the pure graph modules: two co-transformed layers — an SVG one for
 * wires, an HTML one for nodes and labels — plus pan, zoom, and pick routing.
 *
 * Nodes are HTML rather than SVG because they are typeset material (index cards, a choice
 * label in italic prose) and SVG text has no line wrapping. Both layers carry the *same*
 * viewport transform, so a wire and the card it touches cannot drift apart.
 *
 * All interaction resolves through `pick`, one source of truth for "what is under the
 * pointer" — the node layer is `pointer-events: none` and a caller that needs a real DOM
 * target (an inline label editor, say) opts that one element back in.
 */
import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { pick, type Pick, type PickOptions } from './hit.js';
import {
  cssTransformOf,
  panBy,
  transformOf,
  wheelFactor,
  zoomAt,
  type Viewport,
  type ZoomLimits,
} from './viewport.js';
import type { EdgeRoute } from './edges.js';
import type { GraphLayout } from './layout.js';
import type { LaidOutNode, Point, Size } from './types.js';

export interface CanvasProps {
  layout: GraphLayout;
  edges: EdgeRoute[];
  viewport: Viewport;
  onViewportChange: (next: Viewport) => void;
  renderNode: (node: LaidOutNode) => ReactNode;
  /** Optional per-edge label; return null to leave the wire bare. */
  renderLabel?: (edge: EdgeRoute) => ReactNode;
  onPick?: (hit: Pick, event: PointerEvent<HTMLDivElement>) => void;
  /** Fires on mount and on every resize, so the caller can fit content to the surface. */
  onSurface?: (size: Size) => void;
  /** World-space extras drawn above the wires and below the nodes — a ghost edge, a marquee. */
  overlay?: ReactNode;
  zoom?: ZoomLimits;
  pickOptions?: PickOptions;
  className?: string;
}

const localPoint = (element: HTMLElement, clientX: number, clientY: number): Point => {
  const box = element.getBoundingClientRect();
  return { x: clientX - box.left, y: clientY - box.top };
};

export function Canvas(props: CanvasProps): JSX.Element {
  const { layout, edges, viewport, onViewportChange, renderNode, renderLabel } = props;
  const surface = useRef<HTMLDivElement | null>(null);
  const pan = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  // React's wheel handler is passive, so preventDefault there is a no-op and the page (or
  // Electron's zoom) eats the gesture. This has to be a native non-passive listener.
  const latest = useRef({ viewport, onViewportChange, zoom: props.zoom });
  latest.current = { viewport, onViewportChange, zoom: props.zoom };
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const { viewport: vp, onViewportChange: emit, zoom } = latest.current;
      const at = localPoint(element, event.clientX, event.clientY);
      emit(
        zoom
          ? zoomAt(vp, at, wheelFactor(event.deltaY), zoom)
          : zoomAt(vp, at, wheelFactor(event.deltaY)),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const { onSurface } = props;
  useEffect(() => {
    const element = surface.current;
    if (!element || !onSurface) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) onSurface({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onSurface]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const element = surface.current;
      if (!element || event.button !== 0) return;
      const at = localPoint(element, event.clientX, event.clientY);
      const hit = pick(layout, edges, at, viewport, props.pickOptions);
      props.onPick?.(hit, event);
      if (hit.type !== 'background' || event.defaultPrevented) return;
      element.setPointerCapture(event.pointerId);
      pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    },
    [edges, layout, props, viewport],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const drag = pan.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      onViewportChange(panBy(viewport, event.clientX - drag.x, event.clientY - drag.y));
      pan.current = { ...drag, x: event.clientX, y: event.clientY };
    },
    [onViewportChange, viewport],
  );

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const drag = pan.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pan.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const transform = transformOf(viewport);

  return (
    <div
      ref={surface}
      className={props.className ? `graph-canvas ${props.className}` : 'graph-canvas'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
    >
      <svg className="graph-wires" aria-hidden="true">
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        <g transform={transform}>
          {edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.path}
              className={`graph-wire kind-${edge.kind ?? 'plain'}${edge.back ? ' back' : ''}`}
              markerEnd="url(#graph-arrow)"
            />
          ))}
        </g>
      </svg>

      <div className="graph-layer" style={{ transform: cssTransformOf(viewport) }}>
        {props.overlay}
        {layout.nodes.map((node) => (
          <div
            key={node.id}
            className="graph-node"
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
          >
            {renderNode(node)}
          </div>
        ))}
        {renderLabel
          ? edges.map((edge) => {
              const content = renderLabel(edge);
              if (!content) return null;
              return (
                <div
                  key={`label-${edge.id}`}
                  className="graph-label"
                  style={{ left: edge.labelAnchor.x, top: edge.labelAnchor.y }}
                >
                  {content}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}

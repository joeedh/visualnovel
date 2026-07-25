/**
 * One resizable-panel abstraction for both orientations. The panel's width lives in the
 * desktop session store under `panel.<saveId>.width`; the container declares its own grid
 * track in terms of `--panel-w`, which is what lets a left-edge rail and a right-edge
 * inspector share this hook unchanged.
 */
import {
  useCallback,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useSessionValue } from '../session';

/** Arrow-key nudge, and the coarser Shift-arrow one. */
const STEP = 8;
const BIG_STEP = 32;

export interface PanelWidthOptions {
  defaultWidth: number;
  min: number;
  max: number;
  /** Which edge of the panel the handle sits on — i.e. which way a drag grows it. */
  edge: 'left' | 'right';
}

export type ResizeHandleProps = ComponentPropsWithoutRef<'div'>;

export interface PanelWidth {
  width: number;
  /** Spread onto the grid container; pairs with `grid-template-columns: var(--panel-w, …)`. */
  trackStyle: CSSProperties;
  handleProps: ResizeHandleProps;
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

export function usePanelWidth(saveId: string, opts: PanelWidthOptions): PanelWidth {
  const { defaultWidth, min, max, edge } = opts;
  const [saved, persist] = useSessionValue(`panel.${saveId}.width`, defaultWidth);
  // While dragging the width is local: one persist happens on release, not per pointermove.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const width = clamp(dragWidth ?? saved, min, max);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
      setDragWidth(width);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      const dx = event.clientX - start.startX;
      const next = edge === 'left' ? start.startWidth + dx : start.startWidth - dx;
      setDragWidth(clamp(next, min, max));
    },
    [edge, min, max],
  );

  // Both `pointerup` and `lostpointercapture` land here; the ref guard makes the second a
  // no-op, so a drag persists exactly once however it ended.
  const onPointerEnd = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragWidth(null);
      persist(width);
    },
    [persist, width],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const step = event.shiftKey ? BIG_STEP : STEP;
      const towardsRight = event.key === 'ArrowRight';
      const delta = (towardsRight ? step : -step) * (edge === 'left' ? 1 : -1);
      persist(clamp(width + delta, min, max));
    },
    [edge, min, max, persist, width],
  );

  const dragging = dragWidth !== null;

  return {
    width,
    trackStyle: { '--panel-w': `${width}px` } as CSSProperties,
    handleProps: {
      className: dragging ? 'dragging' : undefined,
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-label': `Resize ${saveId} panel`,
      tabIndex: 0,
      title: 'Drag to resize · double-click to reset',
      style: edge === 'left' ? { left: width } : { right: width },
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onLostPointerCapture: onPointerEnd,
      onKeyDown,
      onDoubleClick: () => persist(defaultWidth),
    },
  };
}

/** A wide hit target around a thin visible line; styling lives in `.resize-handle`. */
export function ResizeHandle(props: ResizeHandleProps): JSX.Element {
  const { className, ...rest } = props;
  return <div className={className ? `resize-handle ${className}` : 'resize-handle'} {...rest} />;
}

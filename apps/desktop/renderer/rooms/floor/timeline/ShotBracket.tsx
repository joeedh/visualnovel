import type { Edge, Segment, ShotSpan } from './coverage.js';

/**
 * One contiguous run of a shot's coverage. A shot with holes draws several of these; only the
 * outermost two carry drag handles, because the edge being dragged is the *shot's* first or
 * last line — an interior hole belongs to whichever shot interleaves with this one, and the
 * author did not point at it.
 */
export function ShotBracket(props: {
  span: ShotSpan;
  segment: Segment;
  first: boolean;
  last: boolean;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onGrab: (edge: Edge) => void;
}): JSX.Element {
  const { shot } = props.span;
  const src = shot.image ? `vnasset://${shot.image.hash}.${shot.image.ext}` : null;
  const cast = shot.subjects.length ? shot.subjects.join(' · ') : 'plate';

  return (
    <div
      className={`tl-shot ${shot.status}${props.selected ? ' sel' : ''}${props.dragging ? ' dragging' : ''}`}
      style={{
        gridColumn: props.span.lane + 2,
        gridRow: `${props.segment.from + 1} / ${props.segment.to + 2}`,
      }}
      onClick={props.onSelect}
    >
      {props.first ? (
        <>
          <Handle edge="start" onGrab={props.onGrab} />
          <div className="tl-head">
            <span className="fr">{shot.framing}</span>
            <span className="cast">{cast}</span>
          </div>
          {src ? (
            <img className="tl-frame" src={src} alt={shot.id} draggable={false} />
          ) : (
            // A shot that has not rendered yet is the normal pre-run state, not a fault.
            <div className="tl-frame none">no frame</div>
          )}
          <div className="tl-id">{shot.id}</div>
        </>
      ) : (
        <div className="tl-cont" title={shot.id}>
          ⋯ {shot.framing}
        </div>
      )}
      {props.last && <Handle edge="end" onGrab={props.onGrab} />}
    </div>
  );
}

function Handle(props: { edge: Edge; onGrab: (edge: Edge) => void }): JSX.Element {
  return (
    <button
      className={`tl-edge ${props.edge}`}
      aria-label={`Drag the ${props.edge === 'start' ? 'first' : 'last'} covered line`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onGrab(props.edge);
      }}
    />
  );
}

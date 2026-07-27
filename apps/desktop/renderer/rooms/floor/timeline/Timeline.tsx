/**
 * The coverage strip: a scene's screenplay down the page, and the shots that illustrate it as
 * brackets beside it.
 *
 * Vertical because screenplays are vertical — the script column is authored material
 * (`--prose`, sodium) and the brackets are machine output (`--mono`, signal), the split the app
 * already uses everywhere else. A line no shot covers gets a vermilion gutter: it renders with
 * no image in the playable, and revealing that is what this editor is for.
 *
 * Dragging a bracket's edge previews through `shared/coverage`, the same rule `story.setCoverage`
 * runs in main, and commits **one** command on release — a drag is continuous, its commit is not.
 * The preview is drawn *over* the strip and never applied to it: the brackets hold their lanes
 * for the whole gesture and only the ghost moves.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';
import { setCoverage } from '../../../../src/shared/coverage';
import { ShotBracket } from './ShotBracket';
import { previewOf, resolveDrag, spansFor, type Edge } from './coverage.js';
import type { SceneCoverage, StoryGraph } from '../../../../src/shared/ipc';

interface Drag {
  shotId: string;
  edge: Edge;
  /** What the drop asks for; `null` when it changes nothing. Drawn even when refused. */
  lines: string[] | null;
  /** Whether `setCoverage` would accept it. A refused drop is drawn and never committed. */
  ok: boolean;
}

interface Notice {
  tone: 'ok' | 'refused' | 'preview';
  text: string;
}

export function Timeline(): JSX.Element {
  const [story, setStory] = useState<StoryGraph | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [data, setData] = useState<SceneCoverage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void api.invoke('story:graph').then((graph) => {
      setStory(graph);
      setSceneId((current) => current ?? graph.start ?? graph.scenes[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!sceneId) return;
    setNotice(null);
    void api.invoke('story:coverage', sceneId).then(setData);
  }, [sceneId]);

  const cov = useMemo(() => spansFor(data?.lines ?? [], data?.shots ?? []), [data]);

  // The drop drawn over the strip, never applied to it: re-deriving coverage per pointer move
  // re-lanes shots the author never touched. The strip changes on release, like a splice.
  const ghost = useMemo(
    () => (drag?.lines ? previewOf(cov, drag.shotId, drag.lines) : null),
    [cov, drag],
  );

  // Only for a drop that would be accepted: tinting rows a refused claim cannot take would
  // promise an edit that is not going to happen.
  const marks = useMemo(() => {
    const m = new Map<number, 'claim' | 'release'>();
    if (!ghost || !drag?.ok) return m;
    for (const i of ghost.released) m.set(i, 'release');
    for (const i of ghost.claimed) m.set(i, 'claim');
    return m;
  }, [ghost, drag]);

  const preview = useCallback(
    (shotId: string, edge: Edge, target: number): Drag => {
      const lines = resolveDrag(cov, shotId, edge, target);
      if (!lines) return { shotId, edge, lines: null, ok: false };
      const order = cov.rows.map((r) => r.line.id);
      const op = setCoverage(data?.shots ?? [], { shot: shotId, lines, lineOrder: order });
      setNotice(
        op.ok ? { tone: 'preview', text: op.message } : { tone: 'refused', text: op.error },
      );
      return { shotId, edge, lines, ok: op.ok };
    },
    [cov, data],
  );

  // Window-level, so a drag that leaves the strip still tracks and still releases.
  useEffect(() => {
    if (!drag || !sceneId) return;
    const onMove = (e: PointerEvent): void => {
      const target = rowUnder(e.clientX, e.clientY);
      if (target !== null) setDrag(preview(drag.shotId, drag.edge, target));
    };
    const onUp = (): void => {
      const pending = drag;
      setDrag(null);
      // A drop that changes nothing takes its preview with it, rather than leaving a sentence
      // on screen describing an edit that did not happen. A *refused* one keeps its reason.
      if (!pending.lines) {
        setNotice(null);
        return;
      }
      if (!pending.ok) return;
      void api
        .invoke('command:exec', {
          id: 'story.setCoverage',
          props: { scene: sceneId, shot: pending.shotId, lines: pending.lines.join(',') },
          source: 'ui',
        })
        .then((outcome) => {
          if (!outcome.ok) {
            setNotice({ tone: 'refused', text: outcome.error });
            return;
          }
          if (outcome.data) setData(outcome.data as SceneCoverage);
          setNotice({ tone: 'ok', text: outcome.record.message ?? 'Coverage updated.' });
        });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, preview, sceneId]);

  const scenes = story?.scenes ?? [];

  return (
    <div className="timeline">
      <div className="tl-bar">
        <span className="tt">COVERAGE</span>
        <select
          className="tl-scene"
          value={sceneId ?? ''}
          onChange={(e) => setSceneId(e.target.value)}
        >
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} · {s.location}
            </option>
          ))}
        </select>
        <span className="ct">
          {cov.spans.length} shot(s) · {cov.gaps.length} uncovered
          {cov.overlaps.length ? ` · ${cov.overlaps.length} overlapping` : ''}
        </span>
        {notice && <span className={`tl-notice ${notice.tone}`}>{notice.text}</span>}
      </div>

      {!data ? (
        <div className="insp-empty tl-empty">Loading…</div>
      ) : !data.decomposed ? (
        <div className="insp-empty tl-empty">
          {data.sceneId} has no decomposition yet — run the pipeline past the gate.
        </div>
      ) : (
        <div className="tl-body">
          <div
            className={`tl-grid${drag ? ' dragging' : ''}`}
            style={{
              gridTemplateColumns: `minmax(0, 1.3fr) repeat(${Math.max(cov.lanes, 1)}, minmax(130px, 0.6fr))`,
            }}
          >
            {/* A full-width hit band per row, behind everything: a drag lives in the bracket
                columns, so the pointer is rarely over the script when it needs a row. It also
                carries the preview tint, since a released row keeps its bracket until release. */}
            {cov.rows.map((row) => (
              <div
                key={`band:${row.line.id}`}
                className={`tl-band${marks.has(row.index) ? ` ${marks.get(row.index)!}` : ''}`}
                data-line-index={row.index}
                style={{ gridColumn: '1 / -1', gridRow: row.index + 1 }}
              />
            ))}
            {cov.rows.map((row) => (
              <div
                key={row.line.id}
                className={`tl-line ${row.line.kind}${row.shots.length === 0 ? ' gap' : ''}${row.shots.length > 1 ? ' over' : ''}`}
                style={{ gridColumn: 1, gridRow: row.index + 1 }}
              >
                {row.line.speaker && <div className="who">{row.line.speaker}</div>}
                <div className="text">{row.line.text}</div>
              </div>
            ))}
            {cov.spans.flatMap((span) =>
              span.segments.map((segment, i) => (
                <ShotBracket
                  key={`${span.shot.id}#${i}`}
                  span={span}
                  segment={segment}
                  first={i === 0}
                  last={i === span.segments.length - 1}
                  selected={span.shot.id === selected}
                  dragging={drag?.shotId === span.shot.id}
                  onSelect={() => setSelected(span.shot.id)}
                  onGrab={(edge) => setDrag({ shotId: span.shot.id, edge, lines: null, ok: false })}
                />
              )),
            )}
            {/* Drawn last and above the brackets: the ghost is what release would produce, in
                the dragged shot's existing lane. A refused drop is still drawn — the reason is
                in the notice, and a ghost that vanished would read as the drag having stopped. */}
            {ghost?.segments.map((segment) => (
              <div
                key={`ghost:${segment.from}`}
                className={`tl-ghost${drag?.ok ? '' : ' refused'}`}
                style={{
                  gridColumn: ghost.lane + 2,
                  gridRow: `${segment.from + 1} / ${segment.to + 2}`,
                }}
              />
            ))}
          </div>
          {cov.orphans.length > 0 && (
            <div className="tl-orphans">
              <span className="tt">COVERS NOTHING</span>
              {/* Real, paid-for shots the runner will never display — the other half of a gap. */}
              {cov.orphans.map((s) => (
                <span key={s.id} className="orph">
                  {s.id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Which script row the pointer is over, read from the DOM rather than from measured geometry. */
function rowUnder(x: number, y: number): number | null {
  const hit = document.elementFromPoint(x, y)?.closest('[data-line-index]');
  const index = hit?.getAttribute('data-line-index');
  return index === null || index === undefined ? null : Number(index);
}

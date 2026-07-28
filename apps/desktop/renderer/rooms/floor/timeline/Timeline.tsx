/**
 * The coverage strip: a scene's screenplay down the page, and the shots that illustrate it as
 * brackets beside it.
 *
 * Vertical because screenplays are vertical — the script column is authored material
 * (`--prose`, sodium) and the brackets are machine output (`--mono`, signal), the split the app
 * already uses everywhere else. A line no shot covers gets a vermilion gutter: it renders with
 * no image in the playable, and revealing that is what this editor is for.
 *
 * Dragging a bracket's edge is the `timeline.cover` interaction: the grab asks it to judge every
 * line of the scene at once, and each pointer move reads that answer off by row rather than
 * re-deciding. So the sentence shown mid-drag, the drop that is allowed, and the one an agent is
 * told about through `interaction.targets` are one verdict — and the commit is `verdict.invoke`
 * verbatim, **one** command on release. A drag is continuous; its commit is not.
 *
 * The preview is drawn *over* the strip and never applied to it: the brackets hold their lanes
 * for the whole gesture and only the ghost moves. Geometry still comes from `resolveDrag`, since
 * a verdict says whether and why, not where — and a refused drop is drawn too.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';
import {
  resolveDrag,
  spansFor,
  type Coverage,
  type Edge,
} from '../../../../src/shared/coverage.js';
import { handleId, timelineCover } from '../../../../src/shared/interactions.js';
import { ShotBracket } from './ShotBracket';
import { previewOf } from './coverage.js';
import type { Verdict } from '@vn/commands';
import type { SceneCoverage, StoryGraph } from '../../../../src/shared/ipc';

interface Drag {
  shotId: string;
  edge: Edge;
  /** Every line's verdict, judged once when the handle was grabbed. Keyed by line id. */
  verdicts: Map<string, Verdict>;
  /** What the drop asks for; `null` when it changes nothing. Drawn even when refused. */
  lines: string[] | null;
  /** The verdict for the row under the pointer; `null` where the drop is not a candidate. */
  verdict: Verdict | null;
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
    if (!ghost || !drag?.verdict?.accept) return m;
    for (const i of ghost.released) m.set(i, 'release');
    for (const i of ghost.claimed) m.set(i, 'claim');
    return m;
  }, [ghost, drag]);

  // Window-level, so a drag that leaves the strip still tracks and still releases.
  useEffect(() => {
    if (!drag || !sceneId) return;
    const onMove = (e: PointerEvent): void => {
      const row = rowUnder(e.clientX, e.clientY);
      if (row === null) return;
      const next = atRow(drag, cov, row);
      setDrag(next);
      setNotice(noticeOf(next));
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
      // The drop commits the verdict's own invocation — not a second construction of it.
      if (!pending.verdict?.accept) return;
      void api
        .invoke('command:exec', { ...pending.verdict.invoke, source: 'ui' })
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
  }, [cov, drag, sceneId]);

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
                  onGrab={(edge) => setDrag(grab(data, span.shot.id, edge))}
                />
              )),
            )}
            {/* Drawn last and above the brackets: the ghost is what release would produce, in
                the dragged shot's existing lane. A refused drop is still drawn — the reason is
                in the notice, and a ghost that vanished would read as the drag having stopped. */}
            {ghost?.segments.map((segment) => (
              <div
                key={`ghost:${segment.from}`}
                className={`tl-ghost${drag?.verdict?.accept ? '' : ' refused'}`}
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

/**
 * The gesture, judged in full at the moment the handle is picked up. `targets` is synchronous and
 * pure, so this is one call rather than one per pointer move — and it is the same call
 * `interaction.targets` makes in main.
 */
function grab(data: SceneCoverage | null, shotId: string, edge: Edge): Drag {
  const verdicts = timelineCover.targets(
    { sceneId: data?.sceneId ?? '', lines: data?.lines ?? [], shots: data?.shots ?? [] },
    handleId(shotId, edge),
  );
  return {
    shotId,
    edge,
    verdicts: new Map(verdicts.map((v) => [v.target, v])),
    lines: null,
    verdict: null,
  };
}

/**
 * The drag re-aimed at one row. `resolveDrag` supplies the geometry the ghost needs — a verdict
 * says whether and why, not where — and the verdict for that row supplies everything else.
 */
function atRow(drag: Drag, coverage: Coverage, row: number): Drag {
  const lines = resolveDrag(coverage, drag.shotId, drag.edge, row);
  const verdict = drag.verdicts.get(coverage.rows[row]?.line.id ?? '');
  // A row `targets` did not judge is a row the drop would not change; there is nothing to draw.
  if (!lines || !verdict) return { ...drag, lines: null, verdict: null };
  return { ...drag, lines, verdict };
}

/** The verdict's own sentence, so the author reads what the command would have said. */
function noticeOf(drag: Drag): Notice | null {
  if (!drag.verdict) return null;
  return drag.verdict.accept
    ? { tone: 'preview', text: drag.verdict.note }
    : { tone: 'refused', text: drag.verdict.reason };
}

/** Which script row the pointer is over, read from the DOM rather than from measured geometry. */
function rowUnder(x: number, y: number): number | null {
  const hit = document.elementFromPoint(x, y)?.closest('[data-line-index]');
  const index = hit?.getAttribute('data-line-index');
  return index === null || index === undefined ? null : Number(index);
}

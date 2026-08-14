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
 *
 * A line's text is also editable in place, which is the one thing here that costs nothing and
 * should: no prose reaches a shot's task inputs, so retyping a covered line re-renders nothing and
 * the frame goes on illustrating words the scene no longer contains. So the editor asks
 * `story.setLineText`'s own precondition as the author types and shows that sentence before the
 * commit — the count of stranded frames comes from the command, never from this file.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api';
import {
  resolveDrag,
  spansFor,
  type Coverage,
  type Edge,
} from '../../../../src/shared/coverage.js';
import { handleId, timelineCover, timelineReorder } from '../../../../src/shared/interactions.js';
import {
  commitOf,
  noticeForCheck,
  noticeForVerdict,
  type Notice,
} from '../../../../src/shared/lineedit.js';
import { ShotBracket } from './ShotBracket';
import { OutfitStrip } from './OutfitStrip';
import { insertionRow, previewOf, shotDropTarget } from './coverage.js';
import { GRAB_BLOCKED, canEdit, canGrab } from './editing.js';
import { staleCount } from './drift.js';
import { outfitInvocation, outfitRows, type OutfitRow } from './wardrobe.js';
import type { Verdict } from '@vn/commands';
import type { CoverageLine, SceneCoverage, StoryGraph } from '../../../../src/shared/ipc';

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

/** The other gesture over the same brackets: dragging one bodily to another position. */
interface Reorder {
  shotId: string;
  /** Every insertion point's verdict, judged once on the grab. Keyed by `TOP` or a shot id. */
  verdicts: Map<string, Verdict>;
  /** The insertion point under the pointer, and its verdict where it is a candidate. */
  target: string;
  verdict: Verdict | null;
}

export function Timeline(): JSX.Element {
  const [story, setStory] = useState<StoryGraph | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [data, setData] = useState<SceneCoverage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [reorder, setReorder] = useState<Reorder | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Enter and Escape finish the edit themselves rather than delegating to `blur()`, which does
  // nothing when the textarea is not the active element — so blur is the click-away path only, and
  // this says the edit is already settled and a late blur must not commit it a second time.
  const settled = useRef(false);
  const mode = { editing, dragging: drag !== null || reorder !== null };

  useEffect(() => {
    void api.invoke('story:graph').then((graph) => {
      setStory(graph);
      setSceneId((current) => current ?? graph.start ?? graph.scenes[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!sceneId) return;
    setNotice(null);
    setEditing(null);
    void api.invoke('story:coverage', sceneId).then(setData);
  }, [sceneId]);

  const cov = useMemo(() => spansFor(data?.lines ?? [], data?.shots ?? []), [data]);
  const stale = staleCount(data?.shots ?? []);
  const wardrobe = useMemo(() => outfitRows(data, selected), [data, selected]);

  // The drop drawn over the strip, never applied to it: re-deriving coverage per pointer move
  // re-lanes shots the author never touched. The strip changes on release, like a splice.
  const ghost = useMemo(
    () => (drag?.lines ? previewOf(cov, drag.shotId, drag.lines) : null),
    [cov, drag],
  );

  // The row a reorder drop would insert above; `null` unless the pointer is over a candidate.
  const dropRow = reorder?.verdict
    ? insertionRow(cov.spans, reorder.target, cov.rows.length)
    : null;

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

  // The reorder's own window-level pass. Same shape as the coverage drag — judge on the grab, read
  // the answer off per pointer move, commit the verdict's own invocation once on release — but the
  // targets are the other shots, so the row under the pointer resolves to an insertion point.
  useEffect(() => {
    if (!reorder || !sceneId) return;
    const onMove = (e: PointerEvent): void => {
      const row = rowUnder(e.clientX, e.clientY);
      if (row === null) return;
      const target = shotDropTarget(cov.spans, row);
      const verdict = target === reorder.shotId ? null : (reorder.verdicts.get(target) ?? null);
      setReorder({ ...reorder, target, verdict });
      setNotice(verdict ? noticeForVerdict(verdict) : null);
    };
    const onUp = (): void => {
      const pending = reorder;
      setReorder(null);
      if (!pending.verdict) {
        setNotice(null);
        return;
      }
      if (!pending.verdict.accept) return;
      void api
        .invoke('command:exec', { ...pending.verdict.invoke, source: 'ui' })
        .then((outcome) => {
          if (!outcome.ok) {
            setNotice({ tone: 'refused', text: outcome.error });
            return;
          }
          setNotice({ tone: 'ok', text: outcome.record.message ?? 'Shot moved.' });
          // The scene chunk was rewritten, so the strip is re-read rather than patched: the lines
          // moved, and their lanes are derived from where they sit.
          void api.invoke('story:coverage', sceneId).then(setData);
        });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [cov, reorder, sceneId]);

  // The precondition, asked as the author types. `story.setLineText`'s own note is where the count
  // of frames that will go on illustrating the old prose comes from, so the warning before the
  // commit and the message after it are one sentence rather than two guesses.
  useEffect(() => {
    if (editing === null) return;
    const line = cov.rows.find((row) => row.line.id === editing)?.line;
    const invocation = line ? commitOf(line, draft) : null;
    if (!invocation) {
      setNotice(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api.invoke('command:check', invocation).then((check) => {
        if (live) setNotice(noticeForCheck(check));
      });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cov, draft, editing]);

  const openEditor = (line: CoverageLine): void => {
    if (!canEdit(mode)) return;
    settled.current = false;
    setEditing(line.id);
    setDraft(line.text);
    setNotice(null);
  };

  const commit = (line: CoverageLine): void => {
    setEditing(null);
    const invocation = commitOf(line, draft);
    // A click in and a click away is not an authorial act: no record, no undo point, no notice.
    if (!invocation) {
      setNotice(null);
      return;
    }
    void api.invoke('command:exec', { ...invocation, source: 'ui' }).then((outcome) => {
      if (!outcome.ok) {
        // The draft is still in state, so reopening hands back what the author typed alongside
        // the command's own reason for refusing it — "a line cannot be empty", most often.
        setNotice({ tone: 'refused', text: outcome.error });
        setEditing(line.id);
        settled.current = false;
        return;
      }
      setNotice({ tone: 'ok', text: outcome.record.message ?? 'Line retyped.' });
      // Re-read rather than patch the strip: the chunk was rewritten and a shots file may have
      // been too, so what comes back is what the loader says. Line ids survive, so nothing re-lanes.
      if (sceneId) void api.invoke('story:coverage', sceneId).then(setData);
    });
  };

  /**
   * A row's select, committed. The two levels write different files — the marker goes to the scene
   * chunk, the override to the storyboard — so the strip is re-read rather than patched, and the
   * command's own sentence is what the author is told either way.
   */
  const setOutfit = (row: OutfitRow, outfit: string): void => {
    const invocation = outfitInvocation(row, outfit);
    void api.invoke('command:exec', { ...invocation, source: 'ui' }).then((outcome) => {
      if (!outcome.ok) {
        setNotice({ tone: 'refused', text: outcome.error });
        return;
      }
      setNotice({ tone: 'ok', text: outcome.record.message ?? 'Outfit set.' });
      if (sceneId) void api.invoke('story:coverage', sceneId).then(setData);
    });
  };

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
          {/* An undecomposed scene has no shots and therefore no uncovered lines worth
              counting — every line is uncovered, which is a pre-run state and not a gap. */}
          {data && !data.decomposed
            ? 'no shots yet'
            : `${cov.spans.length} shot(s) · ${cov.gaps.length} uncovered${
                cov.overlaps.length ? ` · ${cov.overlaps.length} overlapping` : ''
              }${stale ? ` · ${stale} on old prose` : ''}`}
        </span>
        {notice && <span className={`tl-notice ${notice.tone}`}>{notice.text}</span>}
      </div>

      {!data ? (
        <div className="insp-empty tl-empty">Loading…</div>
      ) : (
        <div className="tl-body">
          {/* Not a refusal to draw anything: correcting a line is exactly what an author wants
              to do *before* paying for art, so the script renders with no bracket columns. */}
          {!data.decomposed && (
            <div className="tl-note">
              {data.sceneId} has no shots yet — they appear once a run gets past the character gate.
            </div>
          )}
          <div
            className={`tl-grid${mode.dragging ? ' dragging' : ''}`}
            style={{
              gridTemplateColumns: `minmax(0, 1.3fr)${cov.lanes ? ` repeat(${cov.lanes}, minmax(130px, 0.6fr))` : ''}`,
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
                // A gap means "this line renders with no image"; before a decomposition exists
                // that is true of every line and says nothing, so the gutter waits for shots.
                className={`tl-line ${row.line.kind}${data.decomposed && row.shots.length === 0 ? ' gap' : ''}${row.shots.length > 1 ? ' over' : ''}`}
                style={{ gridColumn: 1, gridRow: row.index + 1 }}
              >
                {/* Not editable here: changing who says a line changes its kind, hence this
                    row's shape and the exporter's beat type. `story.setSpeaker` is STUDIO's. */}
                {row.line.speaker && <div className="who">{row.line.speaker}</div>}
                {editing === row.line.id ? (
                  // The sizer carries the draft as `content`, so the row grows as you type and the
                  // brackets follow — they are placed by grid row, not by measured pixels.
                  <div className="text tl-grow" data-value={draft}>
                    <textarea
                      autoFocus
                      value={draft}
                      spellCheck
                      aria-label={`Retype ${row.line.id}`}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        // A line is a string, so Enter has nothing to insert — it finishes.
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          settled.current = true;
                          commit(row.line);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          settled.current = true;
                          setEditing(null);
                          setNotice(null);
                        }
                      }}
                      onBlur={() => {
                        if (settled.current) return;
                        commit(row.line);
                      }}
                    />
                  </div>
                ) : (
                  <div className="text" onClick={() => openEditor(row.line)}>
                    {row.line.text}
                  </div>
                )}
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
                  dragging={drag?.shotId === span.shot.id || reorder?.shotId === span.shot.id}
                  onSelect={() => setSelected(span.shot.id)}
                  onGrab={(edge) => {
                    // The handle's pointerdown is prevented, so it never takes focus off an open
                    // editor — which means the drag has to be refused rather than the editor
                    // silently committed under it. See `canGrab`.
                    if (!canGrab(mode)) return setNotice(GRAB_BLOCKED);
                    setDrag(grab(data, span.shot.id, edge));
                  }}
                  onReorder={() => {
                    if (!canGrab(mode)) return setNotice(GRAB_BLOCKED);
                    setReorder(grabShot(data, span.shot.id));
                  }}
                />
              )),
            )}
            {/* The reorder's whole preview: where the shot would land. The brackets themselves
                hold still — a shot's position is where its lines sit, so a live preview would
                have to move the prose too, and layout changes on commit. */}
            {dropRow !== null && (
              <div
                className={`tl-drop${reorder?.verdict?.accept ? '' : ' refused'}${
                  dropRow >= cov.rows.length ? ' end' : ''
                }`}
                style={{
                  gridColumn: '1 / -1',
                  gridRow: Math.min(dropRow, Math.max(cov.rows.length - 1, 0)) + 1,
                }}
              />
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
          {/* Below the grid, not beside it: the wardrobe is per-scene and per-selected-shot, so it
              has no row to sit on, and a column would compete with the brackets for width. */}
          <OutfitStrip rows={wardrobe} shot={selected} onSet={setOutfit} />
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
 * The reorder, judged in full when the bracket is picked up — `timeline.reorder`'s targets are the
 * other shots, so this is one call for the whole gesture. The shot starts aimed at itself, which is
 * not a target, so a click that never moves resolves to no verdict and commits nothing.
 */
function grabShot(data: SceneCoverage | null, shotId: string): Reorder {
  const verdicts = timelineReorder.targets(
    { sceneId: data?.sceneId ?? '', lines: data?.lines ?? [], shots: data?.shots ?? [] },
    shotId,
  );
  return {
    shotId,
    verdicts: new Map(verdicts.map((v) => [v.target, v])),
    target: shotId,
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

/** Nothing to say where the drop is not a candidate; otherwise the verdict's own sentence. */
function noticeOf(drag: Drag): Notice | null {
  return drag.verdict ? noticeForVerdict(drag.verdict) : null;
}

/** Which script row the pointer is over, read from the DOM rather than from measured geometry. */
function rowUnder(x: number, y: number): number | null {
  const hit = document.elementFromPoint(x, y)?.closest('[data-line-index]');
  const index = hit?.getAttribute('data-line-index');
  return index === null || index === undefined ? null : Number(index);
}

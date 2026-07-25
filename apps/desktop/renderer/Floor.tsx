import { useEffect, useState } from 'react';
import { api } from './api';
import { ResizeHandle, usePanelWidth } from './Resizable';
import type { GateCandidate, PipelineStatus, Task } from '../src/shared/ipc';

/** The Production Floor: task board, the approval-gate barrier, and a per-task inspector. */
export function Floor(props: {
  status: PipelineStatus | null;
  runPipeline: () => void;
  refresh: () => void;
  busy: boolean;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [gateFor, setGateFor] = useState<string | null>(null);
  const inspector = usePanelWidth('floor.inspector', {
    defaultWidth: 320,
    min: 220,
    max: 640,
    edge: 'right',
  });
  const tasks = props.status?.tasks ?? [];
  const running = tasks.filter((t) => t.status === 'running').length;
  const sel = tasks.find((t) => t.hash === selected) ?? null;

  return (
    <div className="floor">
      <div className="floorbar">
        <div className="title">Production Floor</div>
        <div className="sub">
          {tasks.length} tasks · {running} running
          {props.status?.blockedOnGate ? ' · blocked on gate' : ''}
        </div>
        <div className="spacer" />
        <button className="runbtn" onClick={props.runPipeline} disabled={props.busy}>
          ▸ run to next gate
        </button>
      </div>
      <div className="floor-body" style={inspector.trackStyle}>
        <div className="floor-main">
          {props.status?.gatePending.map((c) => (
            <div className="gatebar" key={c}>
              <span className="gt">⟂ GATE</span>
              <span className="who">
                awaiting portrait approval for <b>{c}</b>
              </span>
              <button className="gate-cta" onClick={() => setGateFor(c)}>
                RESOLVE →
              </button>
            </div>
          ))}
          <div className="tasks">
            {tasks.map((t) => (
              <div
                className={`task${t.hash === selected ? ' sel' : ''}`}
                key={t.hash}
                onClick={() => setSelected(t.hash)}
              >
                <div className="row">
                  <span className="kind">{t.kind}</span>
                  <span className="h">{t.hash.slice(0, 8)}</span>
                </div>
                <span className={`st ${t.status}`}>
                  <span className="d" />
                  {t.status}
                </span>
              </div>
            ))}
            {tasks.length === 0 && (
              <div className="insp-empty">No tasks yet — run the pipeline.</div>
            )}
          </div>
        </div>
        <ResizeHandle {...inspector.handleProps} />
        <Inspector task={sel} />
      </div>
      {gateFor && (
        <GateOverlay
          characterId={gateFor}
          onClose={() => setGateFor(null)}
          onApproved={() => {
            setGateFor(null);
            props.refresh();
          }}
        />
      )}
    </div>
  );
}

function Inspector(props: { task: Task | null }): JSX.Element {
  const t = props.task;
  if (!t) {
    return (
      <aside className="inspector">
        <div className="strip-head">INSPECTOR</div>
        <div className="insp-empty">Select a task to inspect its attempts.</div>
      </aside>
    );
  }
  return (
    <aside className="inspector">
      <div className="insp-kind">{t.kind}</div>
      <div className="insp-hash">{t.hash}</div>
      <div className="insp-row">
        <span>status</span>
        <b className={`st ${t.status}`}>{t.status}</b>
      </div>
      <div className="insp-row">
        <span>deps</span>
        <b>{t.deps.length}</b>
      </div>
      <div className="insp-row">
        <span>attempts</span>
        <b>{t.attempts.length}</b>
      </div>
      {t.status === 'needs_human' && (
        <div className="triage">⚑ needs_human — max refine attempts reached</div>
      )}
      <div className="strip-head">ATTEMPTS · generate → critique → refine</div>
      {t.attempts.length === 0 ? (
        <div className="insp-empty">No attempts recorded yet.</div>
      ) : (
        t.attempts.map((a, i) => (
          <div className="attempt" key={i}>
            <div className="frame">
              <span className="no">{String(a.attempt ?? i + 1).padStart(2, '0')}</span>
            </div>
            <div className="notes">
              {a.error ? (
                <div className="err">{a.error}</div>
              ) : (
                <div className="okline">{a.output ? `→ ${a.output.slice(0, 8)}` : 'generated'}</div>
              )}
            </div>
          </div>
        ))
      )}
    </aside>
  );
}

function GateOverlay(props: {
  characterId: string;
  onClose: () => void;
  onApproved: () => void;
}): JSX.Element {
  const [cands, setCands] = useState<GateCandidate[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    void api.invoke('gate:candidates', props.characterId).then(setCands);
  }, [props.characterId]);

  const approve = async () => {
    if (!sel) return;
    await api.invoke('gate:approve', { characterId: props.characterId, hash: sel });
    props.onApproved();
  };

  const backdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) props.onClose();
  };

  return (
    <div className="overlay" onClick={backdrop}>
      <div className="choicebox">
        <div className="ch-head">
          <span className="gt">⟂ GATE</span>
          <span className="for">
            approve a portrait for <b>{props.characterId}</b>
          </span>
          <button className="x" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {cands === null ? (
          <div className="empty-cands">Loading candidates…</div>
        ) : cands.length === 0 ? (
          <div className="empty-cands">No generated portraits yet — run the pipeline first.</div>
        ) : (
          <div className="cand-grid">
            {cands.map((c) => (
              <div
                key={c.hash}
                className={`cand${sel === c.hash ? ' sel' : ''}`}
                onClick={() => setSel(c.hash)}
              >
                <div className="pic" />
                <div className="ch-row">
                  ▸ {c.hash.slice(0, 8)}
                  {c.accepted ? ' ✓' : ''}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="ch-foot">
          <span className="help">writes approved_portrait → status: approved → unblocks shots</span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            style={{ background: 'var(--sodium)', borderColor: 'var(--sodium)' }}
            onClick={approve}
            disabled={!sel}
          >
            Approve selection
          </button>
        </div>
      </div>
    </div>
  );
}

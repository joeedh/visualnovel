import { useState } from 'react';
import { ResizeHandle, usePanelWidth } from '../../ui/Resizable';
import { GateOverlay } from './GateOverlay';
import { Inspector } from './Inspector';
import { TaskBoard } from './TaskBoard';
import { TaskGraphView } from './TaskGraphView';
import { Timeline } from './timeline/Timeline';
import type { PipelineStatus } from '../../../src/shared/ipc';
import type { FloorMode } from '../rooms';

/**
 * The Production Floor: the tasks — as a list or as a DAG — the approval gate, and a per-task
 * inspector. The two task surfaces share one selection and one inspector; the list is better
 * for scanning, the graph for structure, so neither replaces the other.
 *
 * `timeline` is a third surface over different material — a scene's lines against the shots
 * covering them — so it takes the full width and the task inspector goes away with it.
 */
export function Floor(props: {
  status: PipelineStatus | null;
  mode: FloorMode;
  setMode: (mode: FloorMode) => void;
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
        <div className="seg" role="group" aria-label="Task view">
          {(['list', 'graph', 'timeline'] as const).map((m) => (
            <button
              key={m}
              className={props.mode === m ? 'on' : ''}
              onClick={() => props.setMode(m)}
              aria-pressed={props.mode === m}
            >
              {m}
            </button>
          ))}
        </div>
        <button className="runbtn" onClick={props.runPipeline} disabled={props.busy}>
          ▸ run to next gate
        </button>
      </div>
      <div
        className={`floor-body${props.mode === 'timeline' ? ' wide' : ''}`}
        style={inspector.trackStyle}
      >
        <div className={`floor-main${props.mode === 'list' ? '' : ' asgraph'}`}>
          {props.mode === 'timeline' ? (
            <Timeline />
          ) : props.mode === 'graph' ? (
            // The gate is drawn *in* the graph, so the bars below would be a second UI for it.
            <TaskGraphView
              status={props.status}
              selected={selected}
              onSelect={setSelected}
              onResolve={setGateFor}
            />
          ) : (
            <>
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
              <TaskBoard tasks={tasks} selected={selected} onSelect={setSelected} />
            </>
          )}
        </div>
        {props.mode !== 'timeline' && (
          <>
            <ResizeHandle {...inspector.handleProps} />
            <Inspector task={sel} />
          </>
        )}
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

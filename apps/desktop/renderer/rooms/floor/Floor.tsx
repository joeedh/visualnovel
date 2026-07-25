import { useState } from 'react';
import { ResizeHandle, usePanelWidth } from '../../ui/Resizable';
import { GateOverlay } from './GateOverlay';
import { Inspector } from './Inspector';
import { TaskBoard } from './TaskBoard';
import type { PipelineStatus } from '../../../src/shared/ipc';

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
          <TaskBoard tasks={tasks} selected={selected} onSelect={setSelected} />
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

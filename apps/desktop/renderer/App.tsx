import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, isLive, onAgentEvent } from './api';
import type {
  AgentMode,
  PipelineStatus,
  Plan,
  PlanRequest,
  Task,
  WorkspaceIndex,
} from '../src/shared/ipc';

type Room = 'studio' | 'floor';

/** A rendered line in the conversation feed. */
interface FeedItem {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'blocked';
  text: string;
}

let feedSeq = 0;

export function App(): JSX.Element {
  const [room, setRoom] = useState<Room>('studio');
  const [mode, setMode] = useState<AgentMode>('plan');
  const [index, setIndex] = useState<WorkspaceIndex | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [dboxLine, setDboxLine] = useState(
    isLive
      ? 'Workspace loaded. Tell me what to change — I plan first, you approve, then I edit and commit.'
      : 'Design preview (no Electron bridge). Live data appears when launched as the desktop app.',
  );
  const [planReq, setPlanReq] = useState<PlanRequest | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pushFeed = useCallback((role: FeedItem['role'], text: string) => {
    setFeed((f) => [...f, { id: ++feedSeq, role, text }]);
  }, []);

  // Load workspace index + pipeline status once.
  useEffect(() => {
    void api.invoke('workspace:index').then(setIndex);
    void api.invoke('pipeline:status').then(setStatus);
  }, []);

  // Subscribe to the agent event stream.
  useEffect(() => {
    return onAgentEvent((event) => {
      switch (event.type) {
        case 'tool':
          pushFeed('tool', event.tool);
          break;
        case 'message':
          setDboxLine(event.text);
          break;
        case 'final':
          setDboxLine(event.text);
          break;
        case 'mode':
          setMode(event.mode);
          break;
        case 'blocked':
          pushFeed('blocked', `${event.tool} blocked — ${event.reason}`);
          break;
      }
    });
  }, [pushFeed]);

  // Subscribe to plan-approval requests.
  useEffect(() => {
    return api.on('permission:plan', (req) => setPlanReq(req));
  }, []);

  const send = useCallback(async () => {
    const text = inputRef.current?.value.trim();
    if (!text || busy) return;
    inputRef.current!.value = '';
    pushFeed('user', text);
    setBusy(true);
    try {
      const result = await api.invoke('agent:run', text);
      if (result) setDboxLine(result.final);
    } finally {
      setBusy(false);
    }
  }, [busy, pushFeed]);

  const toggleMode = useCallback(async () => {
    const next: AgentMode = mode === 'plan' ? 'execute' : 'plan';
    const applied = await api.invoke('agent:setMode', next);
    setMode(applied ?? next);
  }, [mode]);

  const decidePlan = useCallback(
    (approved: boolean) => {
      if (!planReq) return;
      void api.invoke('plan:decision', { id: planReq.id, decision: { approved } });
      if (approved) setMode('execute');
      setPlanReq(null);
    },
    [planReq],
  );

  const runPipeline = useCallback(async () => {
    setBusy(true);
    try {
      await api.invoke('pipeline:run', { mock: !isLive || true });
      setStatus(await api.invoke('pipeline:status'));
    } finally {
      setBusy(false);
    }
  }, []);

  // Shift-Tab toggles mode (the REPL's gesture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        void toggleMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMode]);

  return (
    <div className="app">
      <Topbar
        room={room}
        setRoom={setRoom}
        mode={mode}
        toggleMode={toggleMode}
        title={index?.title}
      />
      {room === 'studio' ? (
        <Studio
          index={index}
          feed={feed}
          dboxLine={dboxLine}
          planReq={planReq}
          decidePlan={decidePlan}
          inputRef={inputRef}
          send={send}
          busy={busy}
        />
      ) : (
        <Floor status={status} runPipeline={runPipeline} busy={busy} />
      )}
    </div>
  );
}

function Topbar(props: {
  room: Room;
  setRoom: (r: Room) => void;
  mode: AgentMode;
  toggleMode: () => void;
  title?: string;
}): JSX.Element {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="glyph">
          VN<b>STUDIO</b>
        </span>
      </div>
      <div className="project">
        <span>project</span>
        <b>{props.title ?? '—'}</b>
      </div>
      <nav className="rooms">
        <button
          className={`room${props.room === 'studio' ? ' active' : ''}`}
          onClick={() => props.setRoom('studio')}
        >
          STUDIO
        </button>
        <button
          className={`room cool${props.room === 'floor' ? ' active' : ''}`}
          onClick={() => props.setRoom('floor')}
        >
          FLOOR
        </button>
      </nav>
      <div className="spacer" />
      <span className={`badge-live${isLive ? ' live' : ''}`}>{isLive ? 'live' : 'preview'}</span>
      <div className="mode">
        <button className={props.mode === 'plan' ? 'on warm' : ''} onClick={props.toggleMode}>
          <span className="dot" />
          PLAN
        </button>
        <button className={props.mode === 'execute' ? 'on' : ''} onClick={props.toggleMode}>
          <span className="dot" />
          EXECUTE
        </button>
      </div>
    </header>
  );
}

const SWATCH: Record<string, string> = {
  approved: 'linear-gradient(135deg,#d98a6b,#7a3f4e)',
  candidates: 'linear-gradient(135deg,#5b7fa3,#2c3a52)',
};

function Studio(props: {
  index: WorkspaceIndex | null;
  feed: FeedItem[];
  dboxLine: string;
  planReq: PlanRequest | null;
  decidePlan: (approved: boolean) => void;
  inputRef: RefObject<HTMLInputElement>;
  send: () => void;
  busy: boolean;
}): JSX.Element {
  const idx = props.index;
  return (
    <div className="studio">
      <aside className="rail">
        <div className="rail-group">
          <div className="rail-head">
            CAST <span className="ct">{idx?.characters.length ?? 0}</span>
          </div>
          {idx?.characters.map((c) => (
            <div className="rail-item" key={c.id}>
              <span className="swatch" style={{ background: SWATCH[c.status] }} />
              <span className="nm">{c.name}</span>
              <span className={`pip ${c.status}`}>{c.status}</span>
            </div>
          ))}
        </div>
        <div className="rail-group">
          <div className="rail-head">
            SETS <span className="ct">{idx?.locations.length ?? 0}</span>
          </div>
          {idx?.locations.map((l) => (
            <div className="rail-item" key={l.id}>
              <span
                className="swatch"
                style={{ background: 'linear-gradient(135deg,#e0a857,#6b4f8a)' }}
              />
              <span className="nm">{l.name}</span>
            </div>
          ))}
        </div>
        <div className="rail-group">
          <div className="rail-head">
            SCENES <span className="ct">{idx?.scenes.length ?? 0}</span>
          </div>
          {idx?.scenes.map((s) => (
            <div className="scene-row" key={s.id}>
              <span className={s.reachable ? 'ok' : 'un'}>{s.reachable ? '◆' : '◇'}</span>
              <span className="nm">{s.id}</span>
            </div>
          ))}
        </div>
      </aside>

      <div className="convo">
        <div className="transcript">
          {props.feed.length === 0 && !props.planReq && (
            <div className="empty-hint">
              Ask vnauthor to change a character, scene, or location.
            </div>
          )}
          {props.feed.map((item) =>
            item.role === 'user' ? (
              <div className="turn-user" key={item.id}>
                <div className="who">AUTHOR</div>
                <div className="bubble">{item.text}</div>
              </div>
            ) : item.role === 'tool' ? (
              <div className="action" key={item.id}>
                <span className="verb">{item.text}</span>
              </div>
            ) : item.role === 'blocked' ? (
              <div className="action blocked" key={item.id}>
                <span className="verb">{item.text}</span>
              </div>
            ) : (
              <div className="action" key={item.id}>
                <span>{item.text}</span>
              </div>
            ),
          )}
          {props.planReq && <PlanCard plan={props.planReq.plan} decide={props.decidePlan} />}
        </div>

        <div className="stage">
          <div className="dbox">
            <div className="nameplate">VNAUTHOR</div>
            <div className="line">{props.dboxLine}</div>
          </div>
          <div className="composer">
            <input
              ref={props.inputRef}
              placeholder="Reply to vnauthor, or ask for a change…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') props.send();
              }}
            />
            <button className="send" onClick={props.send} disabled={props.busy} aria-label="Send">
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanCard(props: { plan: Plan; decide: (approved: boolean) => void }): JSX.Element {
  return (
    <div className="plan">
      <div className="plan-head">PROPOSED PLAN</div>
      <div className="plan-body">
        <div className="plan-sum">{props.plan.summary}</div>
        <ol className="plan-steps">
          {props.plan.steps.map((s, i) => (
            <li key={i}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <div className="plan-acts">
          <button className="btn" onClick={() => props.decide(false)}>
            Reject
          </button>
          <button className="btn primary" onClick={() => props.decide(true)}>
            Approve →
          </button>
        </div>
      </div>
    </div>
  );
}

function Floor(props: {
  status: PipelineStatus | null;
  runPipeline: () => void;
  busy: boolean;
}): JSX.Element {
  const tasks: Task[] = props.status?.tasks ?? [];
  const running = tasks.filter((t) => t.status === 'running').length;
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
      <div className="tasks">
        {tasks.map((t) => (
          <div className="task" key={t.hash}>
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
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, isLive, onAgentEvent } from './api';
import { Palette } from './Palette';
import { Floor } from './Floor';
import { Runner } from './Runner';
import type {
  AgentMode,
  PipelineStatus,
  Plan,
  PlanRequest,
  WorkspaceIndex,
} from '../src/shared/ipc';

type Room = 'studio' | 'floor' | 'play';

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
  const [model, setModelState] = useState('claude-opus-4-8');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pushFeed = useCallback((role: FeedItem['role'], text: string) => {
    setFeed((f) => [...f, { id: ++feedSeq, role, text }]);
  }, []);

  const loadStatus = useCallback(() => {
    void api.invoke('pipeline:status').then(setStatus);
  }, []);

  // Load workspace index + pipeline status once.
  useEffect(() => {
    void api.invoke('workspace:index').then(setIndex);
    loadStatus();
  }, [loadStatus]);

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

  const setModel = useCallback(async (id: string) => {
    const applied = await api.invoke('agent:setModel', id);
    setModelState(applied ?? id);
  }, []);

  const clearConvo = useCallback(async () => {
    await api.invoke('agent:clear');
    setFeed([]);
    setMode('plan');
    setDboxLine('Conversation cleared. Back to plan mode.');
  }, []);

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

  // Shift-Tab toggles mode (the REPL's gesture); "/" opens the palette; Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        void toggleMode();
      } else if (e.key === '/' && !/^(input|textarea)$/i.test(tag)) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
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
        model={model}
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
          openPalette={() => setPaletteOpen(true)}
          setRoom={setRoom}
        />
      ) : room === 'floor' ? (
        <Floor status={status} runPipeline={runPipeline} refresh={loadStatus} busy={busy} />
      ) : (
        <Runner />
      )}
      {paletteOpen && (
        <Palette
          currentModel={model}
          mode={mode}
          onModel={setModel}
          onToggleMode={toggleMode}
          onClear={clearConvo}
          onClose={() => setPaletteOpen(false)}
        />
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
  model: string;
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
        <button
          className={`room${props.room === 'play' ? ' active' : ''}`}
          onClick={() => props.setRoom('play')}
        >
          PLAY
        </button>
      </nav>
      <div className="spacer" />
      <span className="badge-live mono" title="text model (open the palette with /)">
        {props.model}
      </span>
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
  openPalette: () => void;
  setRoom: (r: Room) => void;
}): JSX.Element {
  const idx = props.index;

  // Drop a targeted starter into the composer and focus it, so the next agent
  // turn is scoped to the picked entity. The composer is uncontrolled (ref-driven).
  const seed = (text: string) => {
    const el = props.inputRef.current;
    if (!el) return;
    el.value = text;
    el.focus();
    el.setSelectionRange(text.length, text.length);
  };

  return (
    <div className="studio">
      <aside className="rail">
        <div className="rail-group">
          <div className="rail-head">
            CAST <span className="ct">{idx?.characters.length ?? 0}</span>
          </div>
          {idx?.characters.map((c) => (
            <div className="rail-item" key={c.id}>
              <button
                className="rail-face"
                onClick={() => seed(`Refine ${c.name}'s character — `)}
                title={`Ask vnauthor to revise ${c.name}`}
              >
                <span className="swatch" style={{ background: SWATCH[c.status] }} />
                <span className="nm">{c.name}</span>
              </button>
              {c.status === 'candidates' ? (
                <button
                  className="rail-jump"
                  onClick={() => props.setRoom('floor')}
                  title="Portraits awaiting approval — go to the gate"
                >
                  gate →
                </button>
              ) : (
                <span className={`pip ${c.status}`}>{c.status}</span>
              )}
            </div>
          ))}
        </div>
        <div className="rail-group">
          <div className="rail-head">
            SETS <span className="ct">{idx?.locations.length ?? 0}</span>
          </div>
          {idx?.locations.map((l) => (
            <button
              className="rail-item pick"
              key={l.id}
              onClick={() => seed(`Refine the ${l.name} location — `)}
              title={`Ask vnauthor to revise ${l.name}`}
            >
              <span
                className="swatch"
                style={{ background: 'linear-gradient(135deg,#e0a857,#6b4f8a)' }}
              />
              <span className="nm">{l.name}</span>
            </button>
          ))}
        </div>
        <div className="rail-group">
          <div className="rail-head">
            SCENES <span className="ct">{idx?.scenes.length ?? 0}</span>
          </div>
          {idx?.scenes.map((s) => (
            <button
              className="scene-row pick"
              key={s.id}
              onClick={() => seed(`Revise scene ${s.id} — `)}
              title={`Ask vnauthor to revise scene ${s.id}`}
            >
              <span className={s.reachable ? 'ok' : 'un'}>{s.reachable ? '◆' : '◇'}</span>
              <span className="nm">{s.id}</span>
            </button>
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
              name="composer"
              placeholder="Reply to vnauthor, or ask for a change…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') props.send();
              }}
            />
            <button
              className="cmdbtn"
              onClick={props.openPalette}
              title="Commands & skills (/)"
              aria-label="Commands and skills"
            >
              /
            </button>
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

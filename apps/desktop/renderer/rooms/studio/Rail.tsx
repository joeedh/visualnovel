import type { Room, StudioMode, WorkspaceIndex } from '../../../src/shared/ipc';

const SWATCH: Record<string, string> = {
  approved: 'linear-gradient(135deg,#d98a6b,#7a3f4e)',
  candidates: 'linear-gradient(135deg,#5b7fa3,#2c3a52)',
};

/** The workspace rail: cast, sets and scenes, each row seeding a scoped agent turn. */
export function Rail(props: {
  index: WorkspaceIndex | null;
  seed: (text: string) => void;
  setRoom: (r: Room) => void;
  mode: StudioMode;
  setMode: (mode: StudioMode) => void;
}): JSX.Element {
  const idx = props.index;
  return (
    <aside className="rail">
      <div className="rail-group">
        <div className="rail-head">
          CAST <span className="ct">{idx?.characters.length ?? 0}</span>
        </div>
        {idx?.characters.map((c) => (
          <div className="rail-item" key={c.id}>
            <button
              className="rail-face"
              onClick={() => props.seed(`Refine ${c.name}'s character — `)}
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
            onClick={() => props.seed(`Refine the ${l.name} location — `)}
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
          <button
            className={`rail-mode${props.mode === 'branches' ? ' on' : ''}`}
            onClick={() => props.setMode(props.mode === 'branches' ? 'convo' : 'branches')}
            title={props.mode === 'branches' ? 'Back to the conversation' : 'Edit the branches'}
          >
            {props.mode === 'branches' ? 'convo' : 'branches'}
          </button>
        </div>
        {idx?.scenes.map((s) => (
          <button
            className="scene-row pick"
            key={s.id}
            onClick={() => props.seed(`Revise scene ${s.id} — `)}
            title={`Ask vnauthor to revise scene ${s.id}`}
          >
            <span className={s.reachable ? 'ok' : 'un'}>{s.reachable ? '◆' : '◇'}</span>
            <span className="nm">{s.id}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

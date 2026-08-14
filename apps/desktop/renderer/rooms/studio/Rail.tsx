import { diagnosticScene } from './diagnostics.js';
import type { WorkspaceIndex } from '../../../src/shared/ipc';
import type { Room, StudioMode } from '../rooms';

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
  openScene: (scene: string) => void;
}): JSX.Element {
  const idx = props.index;
  const diagnostics = idx?.diagnostics ?? [];
  const sceneIds = (idx?.scenes ?? []).map((s) => s.id);
  return (
    <aside className="rail">
      {/* First, and only when there are any: an id that aliases or names no line is the kind
          of thing the rest of the rail looks perfectly healthy in spite of. */}
      {diagnostics.length > 0 && (
        <div className="rail-group">
          <div className="rail-head">
            DIAGNOSTICS <span className="ct">{diagnostics.length}</span>
          </div>
          {diagnostics.map((d, i) => {
            const key = `${d.code}:${d.where ?? ''}:${i}`;
            const at = diagnosticScene(d, sceneIds);
            const body = (
              <>
                <span className="code">{d.code}</span>
                <span className="msg">{d.message}</span>
              </>
            );
            // A diagnostic that names a scene is a way into it: the report becomes navigation.
            // One that doesn't — a character sheet, a `start:` naming nothing — stays a row.
            return at ? (
              <button
                className={`diag ${d.severity} at`}
                key={key}
                onClick={() => props.openScene(at)}
                title={`Open ${at} in the script column`}
              >
                {body}
              </button>
            ) : (
              <div className={`diag ${d.severity}`} key={key}>
                {body}
              </div>
            );
          })}
        </div>
      )}
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
          {/* Both editors, each toggling back to the conversation — a single button cycling three
              modes would make "the branches" two clicks away half the time. */}
          <span className="rail-modes">
            {(['branches', 'script'] as const).map((m) => (
              <button
                key={m}
                className={`rail-mode${props.mode === m ? ' on' : ''}`}
                onClick={() => props.setMode(props.mode === m ? 'convo' : m)}
                aria-pressed={props.mode === m}
                title={
                  props.mode === m
                    ? 'Back to the conversation'
                    : m === 'branches'
                      ? 'Edit the branches'
                      : 'Write the script'
                }
              >
                {m}
              </button>
            ))}
          </span>
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

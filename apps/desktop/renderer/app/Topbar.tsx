import { isLive } from '../api';
import type { AgentMode, Diagnostic, Room, UndoState } from '../../src/shared/ipc';

/** The room nav plus the badges that say which project, model and mode are live. */
export function Topbar(props: {
  room: Room;
  setRoom: (r: Room) => void;
  mode: AgentMode;
  toggleMode: () => void;
  title?: string;
  model: string;
  diagnostics: Diagnostic[];
  undo: UndoState;
  onUndo: () => void;
  onRedo: () => void;
}): JSX.Element {
  // Errors displace warnings in the badge: one count, and the worse one wins it.
  const errors = props.diagnostics.filter((d) => d.severity === 'error').length;
  const shown = errors || props.diagnostics.length;
  const label = `${shown} ${errors ? 'error' : 'warning'}${shown === 1 ? '' : 's'}`;
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
      {/* The tooltip names the exact invocation, so undo is never a leap of faith. */}
      <div className="undo">
        <button
          disabled={!props.undo.canUndo}
          onClick={props.onUndo}
          title={props.undo.undoLabel ? `Undo ${props.undo.undoLabel}` : 'Nothing to undo'}
        >
          ⟲
        </button>
        <button
          disabled={!props.undo.canRedo}
          onClick={props.onRedo}
          title={props.undo.redoLabel ? `Redo ${props.undo.redoLabel}` : 'Nothing to redo'}
        >
          ⟳
        </button>
      </div>
      {/* Visible from FLOOR and PLAY too: the rail lists them, but an error found while
          watching the pipeline should not need a room change to be noticed at all. */}
      {props.diagnostics.length > 0 && (
        <span
          className={`badge-live diag-count${errors ? ' bad' : ''}`}
          title={`${props.diagnostics.length} workspace diagnostic(s) — listed in the STUDIO rail`}
        >
          {label}
        </span>
      )}
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

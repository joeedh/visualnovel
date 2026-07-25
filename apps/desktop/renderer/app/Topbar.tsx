import { isLive } from '../api';
import type { AgentMode, Room } from '../../src/shared/ipc';

/** The room nav plus the badges that say which project, model and mode are live. */
export function Topbar(props: {
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

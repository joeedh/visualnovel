import { ResizeHandle, usePanelWidth } from '../../ui/Resizable';
import { Convo } from './Convo';
import { Rail } from './Rail';
import { BranchEditor } from './branch/BranchEditor';
import type { Agent } from '../../app/useAgent';
import type { Room, StudioMode, WorkspaceIndex } from '../../../src/shared/ipc';

/**
 * STUDIO: the authored side — a workspace rail beside either the vnauthor conversation or the
 * branch editor. Both are the *same* column, so wiring two scenes and then asking the agent to
 * write what goes between them is one continuous gesture rather than a trip to another room.
 */
export function Studio(props: {
  index: WorkspaceIndex | null;
  agent: Agent;
  mode: StudioMode;
  setMode: (mode: StudioMode) => void;
  openPalette: () => void;
  setRoom: (r: Room) => void;
}): JSX.Element {
  const rail = usePanelWidth('studio.rail', {
    defaultWidth: 212,
    min: 150,
    max: 520,
    edge: 'left',
  });

  // Drop a targeted starter into the composer and focus it, so the next agent
  // turn is scoped to the picked entity. The composer is uncontrolled (ref-driven).
  const seed = (text: string) => {
    const el = props.agent.inputRef.current;
    if (!el) return;
    el.value = text;
    el.focus();
    el.setSelectionRange(text.length, text.length);
  };

  return (
    <div className="studio" style={rail.trackStyle}>
      <Rail
        index={props.index}
        seed={seed}
        setRoom={props.setRoom}
        mode={props.mode}
        setMode={props.setMode}
      />
      <ResizeHandle {...rail.handleProps} />
      <Convo
        agent={props.agent}
        openPalette={props.openPalette}
        {...(props.mode === 'branches' ? { surface: <BranchEditor seed={seed} /> } : {})}
      />
    </div>
  );
}

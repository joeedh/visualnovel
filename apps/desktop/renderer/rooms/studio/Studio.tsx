import { useState } from 'react';
import { ResizeHandle, usePanelWidth } from '../../ui/Resizable';
import { Convo } from './Convo';
import { Rail } from './Rail';
import { BranchEditor } from './branch/BranchEditor';
import { ScriptEditor } from './script/ScriptEditor';
import type { Agent } from '../../app/useAgent';
import type { Room, StudioMode, WorkspaceIndex } from '../../../src/shared/ipc';

/**
 * STUDIO: the authored side — a workspace rail beside the vnauthor conversation, the branch
 * editor, or the script editor. All three are the *same* column, so wiring two scenes, writing
 * what goes between them and asking the agent to revise it is one continuous gesture rather than
 * a trip to another room.
 *
 * The scene selection lives here rather than in either editor, because `branches` and `script`
 * are two views of one scene: picking a card and switching mode has to land on that scene.
 */
export function Studio(props: {
  index: WorkspaceIndex | null;
  agent: Agent;
  mode: StudioMode;
  setMode: (mode: StudioMode) => void;
  openPalette: () => void;
  setRoom: (r: Room) => void;
  /** Called after either editor writes, so the rail's diagnostics are the current ones. */
  onEdit: () => void;
}): JSX.Element {
  const [scene, setScene] = useState<string | null>(null);
  const rail = usePanelWidth('studio.rail', {
    defaultWidth: 212,
    min: 150,
    max: 520,
    edge: 'left',
  });

  /**
   * Open a scene in the column — the selection and the mode together, because a diagnostic points
   * at prose and `convo` has no prose in it. Its only caller is the rail's diagnostics group; the
   * two editors already share the selection.
   */
  const openScene = (id: string): void => {
    setScene(id);
    props.setMode('script');
  };

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
        openScene={openScene}
      />
      <ResizeHandle {...rail.handleProps} />
      <Convo
        agent={props.agent}
        openPalette={props.openPalette}
        {...(props.mode === 'branches'
          ? {
              surface: (
                <BranchEditor seed={seed} scene={scene} onScene={setScene} onEdit={props.onEdit} />
              ),
            }
          : props.mode === 'script'
            ? {
                surface: (
                  <ScriptEditor
                    scene={scene}
                    onScene={setScene}
                    cast={props.index?.characters ?? []}
                    onEdit={props.onEdit}
                  />
                ),
              }
            : {})}
      />
    </div>
  );
}

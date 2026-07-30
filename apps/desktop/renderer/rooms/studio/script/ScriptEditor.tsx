/**
 * The script editor: STUDIO's third main surface, and the one where prose gets written.
 *
 * A column rather than a panel in the branch editor — the cards there are sized for structure and
 * the canvas under them pans and zooms, which makes a worse text editor than a page. It shares the
 * room's scene selection with `branches`, so clicking a card and switching here is how you get
 * from the shape of the story to its words.
 *
 * Read-only at this step: every gesture that changes which lines exist arrives in the later steps
 * of `docs/plans/script-composition-in-studio.md`, and each one terminates in a `story.*` command.
 * There is no buffer here to diff — the model is a list of lines.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { localLineId } from './script.js';
import type { SceneCoverage, StoryGraph } from '../../../../src/shared/ipc';

export function ScriptEditor(props: {
  /** The room's scene selection, shared with `branches`. `null` until the graph is known. */
  scene: string | null;
  onScene: (sceneId: string) => void;
}): JSX.Element {
  const [story, setStory] = useState<StoryGraph | null>(null);
  const [data, setData] = useState<SceneCoverage | null>(null);

  // The selection belongs to the room, so an absent one is filled in *there* rather than kept as
  // a local default the branch editor would never see.
  useEffect(() => {
    void api.invoke('story:graph').then((graph) => {
      setStory(graph);
      const first = graph.start ?? graph.scenes[0]?.id;
      if (!props.scene && first) props.onScene(first);
    });
  }, []);

  useEffect(() => {
    if (!props.scene) return;
    void api.invoke('story:coverage', props.scene).then(setData);
  }, [props.scene]);

  const scenes = story?.scenes ?? [];
  // Only when it is the scene now selected: prose under another scene's heading, for the one
  // frame between the click and the read, would be prose the author might start editing.
  const shown = data && data.sceneId === props.scene ? data : null;

  if (story && scenes.length === 0) {
    return (
      <div className="script empty">
        <p className="invite">
          No scenes yet. Ask vnauthor for the opening scene below, or make one in the branch editor
          — this column is where you write it.
        </p>
      </div>
    );
  }

  return (
    <div className="script">
      <div className="script-bar">
        <span className="tt">SCRIPT</span>
        <select
          className="sc-scene"
          aria-label="Scene"
          value={props.scene ?? ''}
          onChange={(e) => props.onScene(e.target.value)}
        >
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} · {s.location}
            </option>
          ))}
        </select>
        <span className="ct">{shown ? `${shown.lines.length} line(s)` : ''}</span>
      </div>

      {!shown ? (
        <div className="sc-note">Loading…</div>
      ) : shown.lines.length === 0 ? (
        <div className="sc-note">{shown.sceneId} has no lines yet.</div>
      ) : (
        <div className="sc-page">
          {/* The heading as the scene's own slugline, so the column reads as a screenplay page
              rather than as a list that happens to be in order. */}
          <div className="sc-heading">{shown.location}</div>
          {shown.lines.map((line) => (
            <div className={`sc-line ${line.kind}`} key={line.id}>
              <span className="lid" title={line.id}>
                {localLineId(line.id)}
              </span>
              <div className="sc-body">
                {line.speaker && <div className="who">{line.speaker}</div>}
                <div className="text">{line.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

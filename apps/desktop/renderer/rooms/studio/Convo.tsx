import { PlanCard } from './PlanCard';
import type { ReactNode } from 'react';
import type { Agent } from '../../app/useAgent';

/**
 * STUDIO's main column: the transcript, the vnauthor dialogue box, and the composer.
 *
 * `surface` swaps out the transcript — and only the transcript. The stage below it is the same
 * element either way, so switching to the branch editor never costs you what you were typing.
 */
export function Convo(props: {
  agent: Agent;
  openPalette: () => void;
  surface?: ReactNode;
}): JSX.Element {
  const { feed, planReq, decidePlan, dboxLine, inputRef, send, busy } = props.agent;
  return (
    <div className="convo">
      {props.surface ?? (
        <div className="transcript">
          {feed.length === 0 && !planReq && (
            <div className="empty-hint">
              Ask vnauthor to change a character, scene, or location.
            </div>
          )}
          {feed.map((item) =>
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
          {planReq && <PlanCard plan={planReq.plan} decide={decidePlan} />}
        </div>
      )}

      <div className="stage">
        <div className="dbox">
          <div className="nameplate">VNAUTHOR</div>
          <div className="line">{dboxLine}</div>
        </div>
        <div className="composer">
          <input
            ref={inputRef}
            name="composer"
            placeholder="Reply to vnauthor, or ask for a change…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
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
          <button className="send" onClick={() => void send()} disabled={busy} aria-label="Send">
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

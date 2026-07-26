import { AttemptLoop } from './AttemptLoop';
import { survivingDefects } from './attempts';
import type { Task } from '../../../src/shared/ipc';

/** Why the loop gave up, named — not just that it did. */
function Triage(props: { task: Task }): JSX.Element {
  const survived = survivingDefects(props.task);
  return (
    <div className="triage">
      <div className="tri-head">
        ⚑ needs_human — still blocking after {props.task.attempts.length} attempts
      </div>
      {survived.length === 0 ? (
        <p className="tri-line">No blocking defect was recorded on the last attempt.</p>
      ) : (
        <ul className="tri-list">
          {survived.map((d, i) => (
            <li key={i}>
              <b>{d.category}</b> — {d.description}
              <span className="who">{d.reviewers.join(' + ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Per-task detail: identity, dependency count, and the generate → critique → refine loop. */
export function Inspector(props: { task: Task | null }): JSX.Element {
  const t = props.task;
  if (!t) {
    return (
      <aside className="inspector">
        <div className="strip-head">INSPECTOR</div>
        <div className="insp-empty">Select a task to inspect its attempts.</div>
      </aside>
    );
  }
  return (
    <aside className="inspector">
      <div className="insp-kind">{t.kind}</div>
      <div className="insp-hash">{t.hash}</div>
      <div className="insp-row">
        <span>status</span>
        <b className={`st ${t.status}`}>{t.status}</b>
      </div>
      <div className="insp-row">
        <span>deps</span>
        <b>{t.deps.length}</b>
      </div>
      <div className="insp-row">
        <span>attempts</span>
        <b>{t.attempts.length}</b>
      </div>
      {t.status === 'needs_human' && <Triage task={t} />}
      <div className="strip-head">ATTEMPTS · generate → critique → refine</div>
      {t.attempts.length === 0 ? (
        <div className="insp-empty">
          {t.kind === 'shot_image'
            ? 'No attempts recorded yet.'
            : 'This kind runs in a single pass — it records no per-attempt critique.'}
        </div>
      ) : (
        <AttemptLoop task={t} />
      )}
    </aside>
  );
}

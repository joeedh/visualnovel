import { AttemptLoop } from './AttemptLoop';
import { triageOf, type TriageSummary } from './attempts';
import type { Task } from '../../../src/shared/ipc';

/** Why the loop gave up, named — not just that it did. */
function Triage(props: { triage: TriageSummary }): JSX.Element {
  const { headline, defects, reason } = props.triage;
  return (
    <div className="triage">
      <div className="tri-head">{headline}</div>
      {reason !== null ? (
        <p className="tri-line">{reason}</p>
      ) : (
        <ul className="tri-list">
          {defects.map((d, i) => (
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
  const triage = t ? triageOf(t) : null;
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
      {triage && <Triage triage={triage} />}
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

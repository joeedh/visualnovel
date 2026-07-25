import type { Task } from '../../../src/shared/ipc';

/** Per-task detail: identity, dependency count, and the generate → critique → refine attempts. */
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
      {t.status === 'needs_human' && (
        <div className="triage">⚑ needs_human — max refine attempts reached</div>
      )}
      <div className="strip-head">ATTEMPTS · generate → critique → refine</div>
      {t.attempts.length === 0 ? (
        <div className="insp-empty">No attempts recorded yet.</div>
      ) : (
        t.attempts.map((a, i) => (
          <div className="attempt" key={i}>
            <div className="frame">
              <span className="no">{String(a.attempt ?? i + 1).padStart(2, '0')}</span>
            </div>
            <div className="notes">
              {a.error ? (
                <div className="err">{a.error}</div>
              ) : (
                <div className="okline">{a.output ? `→ ${a.output.slice(0, 8)}` : 'generated'}</div>
              )}
            </div>
          </div>
        ))
      )}
    </aside>
  );
}

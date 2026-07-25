import type { Task } from '../../../src/shared/ipc';

/** The task list: one card per node of the content-addressed graph. */
export function TaskBoard(props: {
  tasks: Task[];
  selected: string | null;
  onSelect: (hash: string) => void;
}): JSX.Element {
  return (
    <div className="tasks">
      {props.tasks.map((t) => (
        <div
          className={`task${t.hash === props.selected ? ' sel' : ''}`}
          key={t.hash}
          onClick={() => props.onSelect(t.hash)}
        >
          <div className="row">
            <span className="kind">{t.kind}</span>
            <span className="h">{t.hash.slice(0, 8)}</span>
          </div>
          <span className={`st ${t.status}`}>
            <span className="d" />
            {t.status}
          </span>
        </div>
      ))}
      {props.tasks.length === 0 && (
        <div className="insp-empty">No tasks yet — run the pipeline.</div>
      )}
    </div>
  );
}

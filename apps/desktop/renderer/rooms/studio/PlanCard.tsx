import type { Plan } from '../../../src/shared/ipc';

/** A proposed plan awaiting approval — the gate between plan mode and execute mode. */
export function PlanCard(props: { plan: Plan; decide: (approved: boolean) => void }): JSX.Element {
  return (
    <div className="plan">
      <div className="plan-head">PROPOSED PLAN</div>
      <div className="plan-body">
        <div className="plan-sum">{props.plan.summary}</div>
        <ol className="plan-steps">
          {props.plan.steps.map((s, i) => (
            <li key={i}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <div className="plan-acts">
          <button className="btn" onClick={() => props.decide(false)}>
            Reject
          </button>
          <button className="btn primary" onClick={() => props.decide(true)}>
            Approve →
          </button>
        </div>
      </div>
    </div>
  );
}

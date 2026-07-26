import { Fragment, useState } from 'react';
import {
  attemptOutcome,
  correctionDelta,
  mergeAttemptReviews,
  promptRepeated,
  type AttemptOutcome,
  type MergedDefect,
} from './attempts';
import type { Task, TaskAttempt } from '../../../src/shared/ipc';

const VERDICT: Record<AttemptOutcome, string> = {
  accepted: '✓ accepted',
  rejected: '✕ rejected',
  failed: '⚠ failed',
  pending: '· in flight',
};

/** Every attempt's bytes are in the store — only the clean one was `accept`ed, not the only one. */
function shotUrl(a: TaskAttempt): string | undefined {
  return a.output && a.outputExt ? `vnasset://${a.output}.${a.outputExt}` : undefined;
}

function DefectRow(props: { defect: MergedDefect; showReviewer: boolean }): JSX.Element {
  const d = props.defect;
  return (
    <li className={`dfct ${d.severity}`}>
      <div className="dfct-top">
        <span className="dot" />
        <span className="sev">{d.severity}</span>
        <span className="cat">{d.category}</span>
        {props.showReviewer && <span className="rev">{d.reviewers.join(' + ')}</span>}
      </div>
      <p className="desc">{d.description}</p>
    </li>
  );
}

/** One iteration: what was generated, and what the reviewers said about it. */
function AttemptCard(props: {
  attempt: TaskAttempt;
  index: number;
  outcome: AttemptOutcome;
  showReviewer: boolean;
  onZoom: (url: string) => void;
}): JSX.Element {
  const a = props.attempt;
  const { defects } = mergeAttemptReviews(a.reviews);
  const url = shotUrl(a);
  return (
    <article className={`att ${props.outcome}`}>
      <header className="att-head">
        <span className="n">ATTEMPT {String(a.attempt ?? props.index + 1).padStart(2, '0')}</span>
        <span className="verdict">{VERDICT[props.outcome]}</span>
        <span className="h">{a.output ? a.output.slice(0, 8) : '—'}</span>
      </header>
      {url ? (
        <button className="att-shot" onClick={() => props.onZoom(url)} title="open full frame">
          <img src={url} alt={`attempt ${a.attempt} output`} />
        </button>
      ) : (
        <div className="att-shot none">no stored frame</div>
      )}
      {a.error && <div className="att-err">{a.error}</div>}
      {a.reviews.length === 0 ? (
        <div className="att-note">no critique recorded</div>
      ) : defects.length === 0 ? (
        <div className="att-note clean">no defects reported</div>
      ) : (
        <ul className="defects">
          {defects.map((d, i) => (
            <DefectRow key={i} defect={d} showReviewer={props.showReviewer} />
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * The generate → critique → refine loop as a vertical spine. The causal step is the gap
 * between two attempts — the `Corrections:` clause `refinePrompt` built from the critique —
 * so the gap carries the weight rather than the attempts themselves.
 */
export function AttemptLoop(props: { task: Task }): JSX.Element {
  const [zoom, setZoom] = useState<string | null>(null);
  const attempts = props.task.attempts;
  const reviewers = new Set(attempts.flatMap((a) => a.reviews.map((r) => r.reviewer)));

  return (
    <div className="loop">
      {attempts.map((a, i) => {
        const prev = i > 0 ? attempts[i - 1] : undefined;
        const delta = correctionDelta(prev, a);
        return (
          <Fragment key={i}>
            {i > 0 && (
              <div className={`step${delta ? '' : ' bare'}`}>
                {delta ? (
                  <p className="fix">
                    <span className="pen">✎</span> {delta}
                  </p>
                ) : (
                  <p className="fix none">
                    {promptRepeated(prev, a)
                      ? 'same critique — the prompt did not change'
                      : 'no correction recorded'}
                  </p>
                )}
              </div>
            )}
            <AttemptCard
              attempt={a}
              index={i}
              outcome={attemptOutcome(props.task, a, i)}
              showReviewer={reviewers.size > 1}
              onZoom={setZoom}
            />
          </Fragment>
        );
      })}
      {zoom && (
        <div
          className="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setZoom(null);
          }}
        >
          <img className="lightbox" src={zoom} alt="attempt output, full size" />
        </div>
      )}
    </div>
  );
}

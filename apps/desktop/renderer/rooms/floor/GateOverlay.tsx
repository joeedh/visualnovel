import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { GateCandidate } from '../../../src/shared/ipc';

/** The approval gate, as a modal: pick one candidate portrait and accept it. */
export function GateOverlay(props: {
  characterId: string;
  onClose: () => void;
  onApproved: () => void;
}): JSX.Element {
  const [cands, setCands] = useState<GateCandidate[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    void api.invoke('gate:candidates', props.characterId).then(setCands);
  }, [props.characterId]);

  const approve = async () => {
    if (!sel) return;
    await api.invoke('gate:approve', { characterId: props.characterId, hash: sel });
    props.onApproved();
  };

  const backdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) props.onClose();
  };

  return (
    <div className="overlay" onClick={backdrop}>
      <div className="choicebox">
        <div className="ch-head">
          <span className="gt">⟂ GATE</span>
          <span className="for">
            approve a portrait for <b>{props.characterId}</b>
          </span>
          <button className="x" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {cands === null ? (
          <div className="empty-cands">Loading candidates…</div>
        ) : cands.length === 0 ? (
          <div className="empty-cands">No generated portraits yet — run the pipeline first.</div>
        ) : (
          <div className="cand-grid">
            {cands.map((c) => (
              <div
                key={c.hash}
                className={`cand${sel === c.hash ? ' sel' : ''}`}
                onClick={() => setSel(c.hash)}
              >
                <div className="pic" />
                <div className="ch-row">
                  ▸ {c.hash.slice(0, 8)}
                  {c.accepted ? ' ✓' : ''}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="ch-foot">
          <span className="help">writes approved_portrait → status: approved → unblocks shots</span>
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            style={{ background: 'var(--sodium)', borderColor: 'var(--sodium)' }}
            onClick={approve}
            disabled={!sel}
          >
            Approve selection
          </button>
        </div>
      </div>
    </div>
  );
}

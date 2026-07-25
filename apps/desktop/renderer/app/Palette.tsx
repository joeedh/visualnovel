import { useState } from 'react';
import type { AgentMode } from '../../src/shared/ipc';

/** Curated text models (mirrors apps/authoring TEXT_MODELS); any id is also valid. */
const MODELS: { id: string; prov: string }[] = [
  { id: 'claude-opus-4-8', prov: 'Anthropic' },
  { id: 'claude-sonnet-4-6', prov: 'Anthropic' },
  { id: 'claude-haiku-4-5', prov: 'Anthropic' },
  { id: 'claude-fable-5', prov: 'Anthropic' },
  { id: 'gemini-2.5-pro', prov: 'Google' },
  { id: 'gemini-2.5-flash', prov: 'Google' },
];

/** Command + skills palette (the `/` menu). `/model` opens an inline model picker. */
export function Palette(props: {
  currentModel: string;
  mode: AgentMode;
  onModel: (id: string) => void;
  onToggleMode: () => void;
  onClear: () => void;
  onClose: () => void;
}): JSX.Element {
  const [view, setView] = useState<'root' | 'model'>('root');
  const backdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) props.onClose();
  };
  return (
    <div className="overlay" onClick={backdrop}>
      <div className="palette">
        {view === 'root' ? (
          <>
            <div className="pal-search">
              <span className="p">›</span>
              <span>Run a command or skill…</span>
            </div>
            <div className="pal-list">
              <div className="pal-group">SKILLS · .aiagent/skills</div>
              <div className="pal-row">
                <span className="nm">new-character</span>
                <span className="ds">Scaffold a character folder + front-matter</span>
                <span className="tag warm">run script</span>
              </div>
              <div className="pal-row">
                <span className="nm">tighten-prose</span>
                <span className="ds">Trim purple description in a scene</span>
              </div>
              <div className="pal-group">COMMANDS</div>
              <div className="pal-row" onClick={() => setView('model')}>
                <span className="nm">/model</span>
                <span className="ds">Switch the text model — hot-swaps the backend</span>
                <span className="tag">{props.currentModel || '—'}</span>
              </div>
              <div
                className="pal-row"
                onClick={() => {
                  props.onToggleMode();
                  props.onClose();
                }}
              >
                <span className="nm">/mode</span>
                <span className="ds">Toggle plan ⇄ execute (or Shift-Tab)</span>
                <span className="tag warm">{props.mode}</span>
              </div>
              <div
                className="pal-row"
                onClick={() => {
                  props.onClear();
                  props.onClose();
                }}
              >
                <span className="nm">/clear</span>
                <span className="ds">Reset conversation, back to plan mode</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="pal-search">
              <span className="p">/model</span>
              <span>switch the text model — keeps the conversation</span>
            </div>
            <div className="pal-list">
              {MODELS.map((m) => (
                <div
                  key={m.id}
                  className={`model-row${m.id === props.currentModel ? ' cur' : ''}`}
                  onClick={() => {
                    props.onModel(m.id);
                    props.onClose();
                  }}
                >
                  <span className="prov">{m.prov}</span>
                  <span className="mn">{m.id}</span>
                  {m.id === props.currentModel && <span className="cur-tag">current</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

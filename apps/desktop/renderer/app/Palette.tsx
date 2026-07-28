import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { blankProps, fieldText, fieldValue, filterCommands } from './catalog';
import type { AgentMode, CatalogEntry, CommandCheck, PropValue } from '../../src/shared/ipc';

/** Curated text models (mirrors apps/authoring TEXT_MODELS); any id is also valid. */
const MODELS: { id: string; prov: string }[] = [
  { id: 'claude-opus-4-8', prov: 'Anthropic' },
  { id: 'claude-sonnet-4-6', prov: 'Anthropic' },
  { id: 'claude-haiku-4-5', prov: 'Anthropic' },
  { id: 'claude-fable-5', prov: 'Anthropic' },
  { id: 'gemini-2.5-pro', prov: 'Google' },
  { id: 'gemini-2.5-flash', prov: 'Google' },
];

const SKILLS = [
  { id: 'new-character', ds: 'Scaffold a character folder + front-matter', script: true },
  { id: 'tighten-prose', ds: 'Trim purple description in a scene', script: false },
];

/**
 * A precondition's answer, inline. `undeclared` renders as **nothing at all**: a command that
 * states no precondition has not said yes, and a tick here would invent an assurance.
 */
function Verdict(props: { check: CommandCheck | null }): JSX.Element | null {
  const check = props.check;
  if (!check || check.state === 'undeclared') return null;
  return (
    <div className={`pal-verdict ${check.state}`}>
      <span className="mk">{check.state === 'accept' ? '✓' : '✕'}</span>
      <span className="tx">{check.message}</span>
    </div>
  );
}

/**
 * Command + skills palette (the `/` menu). The command list is the **live** registry over
 * `command:catalog`, never the generated `commands.json`, so the palette cannot offer a command
 * the app no longer has. Execution goes over `command:exec` — the same stack `window.vn.exec`
 * and CDP reach — so provenance, undo and history are identical whoever ran it.
 */
export function Palette(props: {
  currentModel: string;
  mode: AgentMode;
  onModel: (id: string) => void;
  onToggleMode: () => void;
  onClear: () => void;
  onClose: () => void;
  /** A mutating command landed: the shell re-reads the workspace it just changed. */
  onRan: () => void;
}): JSX.Element {
  const [view, setView] = useState<'root' | 'model' | 'props'>('root');
  const [commands, setCommands] = useState<CatalogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);
  const [values, setValues] = useState<Record<string, PropValue>>({});
  const [check, setCheck] = useState<CommandCheck | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Bumped after every execution: a command that just ran changed what its own precondition
  // would now answer, and leaving the old verdict up would describe work already done.
  const [ran, setRan] = useState(0);

  useEffect(() => {
    void api.invoke('command:catalog').then((catalog) => setCommands(catalog.commands));
  }, []);

  // Re-asked on every edit, so the verdict describes what is currently typed. Stale answers are
  // dropped rather than allowed to land after a newer one.
  useEffect(() => {
    if (!chosen?.checkable) return setCheck(null);
    let live = true;
    void api.invoke('command:check', { id: chosen.id, props: values }).then((result) => {
      if (live) setCheck(result);
    });
    return () => {
      live = false;
    };
  }, [chosen, values, ran]);

  const shown = useMemo(() => filterCommands(commands, query), [commands, query]);
  const skills = SKILLS.filter((s) => s.id.includes(query.trim().toLowerCase()));

  // Highlighting a row is not navigating to it: `select` only arms the check, so the verdict is
  // there to read before the click that opens the form or runs the command.
  const select = (entry: CatalogEntry): void => {
    setChosen(entry);
    setValues(blankProps(entry));
    setOutcome(null);
    setConfirming(false);
  };

  // The props are passed rather than read from state: a click focuses the row first, and the
  // `select` that fires would not have landed by the time this reads them.
  const run = async (entry: CatalogEntry, invoked: Record<string, PropValue>): Promise<void> => {
    if (entry.confirm && !confirming) return setConfirming(true);
    setConfirming(false);
    setOutcome('running…');
    const result = await api.invoke('command:exec', { id: entry.id, props: invoked, source: 'ui' });
    setOutcome(result.ok ? result.record.message : result.error);
    setRan((n) => n + 1);
    if (result.ok && entry.mutating) props.onRan();
  };

  const backdrop = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) props.onClose();
  };

  if (view === 'model') {
    return (
      <div className="overlay" onClick={backdrop}>
        <div className="palette">
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
        </div>
      </div>
    );
  }

  if (view === 'props' && chosen) {
    return (
      <div className="overlay" onClick={backdrop}>
        <div className="palette">
          <div className="pal-search">
            <span className="p">{chosen.id}</span>
            <span>{chosen.title}</span>
          </div>
          <div className="pal-list">
            <div className="pal-desc">{chosen.description}</div>
            {chosen.props.map((p) => (
              <label className="pal-field" key={p.name}>
                <span className="fn">
                  {p.name}
                  {p.required && <b className="req">*</b>}
                </span>
                {p.kind === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={Boolean(values[p.name])}
                    onChange={(e) =>
                      setValues({ ...values, [p.name]: fieldValue(p, e.target.checked) })
                    }
                  />
                ) : p.kind === 'enum' ? (
                  <select
                    value={String(values[p.name] ?? '')}
                    onChange={(e) =>
                      setValues({ ...values, [p.name]: fieldValue(p, e.target.value) })
                    }
                  >
                    {(p.values ?? []).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={p.kind === 'number' ? 'number' : 'text'}
                    value={fieldText(values[p.name] ?? '')}
                    onChange={(e) =>
                      setValues({ ...values, [p.name]: fieldValue(p, e.target.value) })
                    }
                  />
                )}
                <span className="fd">{p.description}</span>
              </label>
            ))}
            <Verdict check={check} />
            {outcome && <div className="pal-outcome mono">{outcome}</div>}
            <div className="pal-actions">
              <button className="ghost" onClick={() => setView('root')}>
                back
              </button>
              <button
                className={confirming ? 'go warm' : 'go'}
                onClick={() => void run(chosen, values)}
              >
                {confirming ? 'confirm — run it' : 'run'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onClick={backdrop}>
      <div className="palette">
        <div className="pal-search">
          <span className="p">›</span>
          <input
            autoFocus
            value={query}
            placeholder="Run a command or skill…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="pal-list">
          {skills.length > 0 && <div className="pal-group">SKILLS · .aiagent/skills</div>}
          {skills.map((s) => (
            <div className="pal-row" key={s.id}>
              <span className="nm">{s.id}</span>
              <span className="ds">{s.ds}</span>
              {s.script && <span className="tag warm">run script</span>}
            </div>
          ))}
          <div className="pal-group">SESSION</div>
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
          <div className="pal-group">
            COMMANDS <span className="ct">{shown.length}</span>
          </div>
          {shown.map((entry) => (
            <div key={entry.id}>
              <button
                className={`pal-row${chosen?.id === entry.id ? ' on' : ''}`}
                title={entry.description}
                onFocus={() => select(entry)}
                onMouseEnter={() => chosen?.id !== entry.id && select(entry)}
                onClick={() =>
                  entry.props.length > 0 ? setView('props') : void run(entry, blankProps(entry))
                }
              >
                <span className="nm">{entry.id}</span>
                <span className="ds">{entry.title}</span>
                {entry.mutating && <span className="tag warm">writes</span>}
              </button>
              {chosen?.id === entry.id && (
                <>
                  <Verdict check={check} />
                  {outcome && <div className="pal-outcome mono">{outcome}</div>}
                  {entry.confirm && confirming && (
                    <div className="pal-outcome mono">click again to confirm</div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

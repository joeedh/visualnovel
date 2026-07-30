/**
 * The script editor: STUDIO's third main surface, and the one where prose gets written.
 *
 * A column rather than a panel in the branch editor — the cards there are sized for structure and
 * the canvas under them pans and zooms, which makes a worse text editor than a page. It shares the
 * room's scene selection with `branches`, so clicking a card and switching here is how you get
 * from the shape of the story to its words.
 *
 * Every gesture terminates in a `story.*` command, and *which* one is `script.ts`'s decision — this
 * file opens editors, runs what it is told to run, and moves the caret. There is no buffer here to
 * diff: the model is a list of lines.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
import {
  insertOf,
  keyAct,
  localLineId,
  nextEditing,
  scriptRows,
  type Continue,
  type Editing,
} from './script.js';
import { commitOf, noticeForCheck, type Notice } from '../../../../src/shared/lineedit.js';
import type { Invocation } from '@vn/commands';
import type { CoverageLine, SceneCoverage, StoryGraph } from '../../../../src/shared/ipc';

export function ScriptEditor(props: {
  /** The room's scene selection, shared with `branches`. `null` until the graph is known. */
  scene: string | null;
  onScene: (sceneId: string) => void;
}): JSX.Element {
  const [story, setStory] = useState<StoryGraph | null>(null);
  const [data, setData] = useState<SceneCoverage | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  // Set by a key that already acted, so the blur it causes cannot commit the same draft twice.
  const settled = useRef(false);

  // The selection belongs to the room, so an absent one is filled in *there* rather than kept as
  // a local default the branch editor would never see.
  useEffect(() => {
    void api.invoke('story:graph').then((graph) => {
      setStory(graph);
      const first = graph.start ?? graph.scenes[0]?.id;
      if (!props.scene && first) props.onScene(first);
    });
  }, []);

  useEffect(() => {
    if (!props.scene) return;
    setEditing(null);
    setNotice(null);
    void api.invoke('story:coverage', props.scene).then(setData);
  }, [props.scene]);

  const scenes = story?.scenes ?? [];
  // Only when it is the scene now selected: prose under another scene's heading, for the one
  // frame between the click and the read, would be prose the author might start editing.
  const shown = data && data.sceneId === props.scene ? data : null;

  // The precondition, asked as the author types — the count of frames that will go on illustrating
  // the old prose comes from the command's own `check`, so the warning before the commit and the
  // message after it are one sentence rather than two guesses.
  useEffect(() => {
    if (!editing || !shown) return;
    const invocation =
      editing.row === 'line'
        ? commitOf(editing.line, draft)
        : insertOf(shown, editing.after, draft);
    if (!invocation) {
      // A preview describes a draft that no longer says anything; an ok/refused sentence describes
      // something that happened, and it stays until the next act.
      setNotice((n) => (n?.tone === 'preview' ? null : n));
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api.invoke('command:check', invocation).then((check) => {
        if (live) setNotice(noticeForCheck(check));
      });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, editing, shown]);

  const open = (row: { editing: Editing; draft: string }): void => {
    settled.current = false;
    setEditing(row.editing);
    setDraft(row.draft);
  };

  const openLine = (line: CoverageLine): void => {
    open({ editing: { row: 'line', line }, draft: line.text });
    setNotice(null);
  };

  const compose = (after: string): void => {
    open({ editing: { row: 'new', after }, draft: '' });
    setNotice(null);
  };

  /**
   * Run an act: its commands in order, stopping at the first refusal, then re-read the scene and
   * put the editor where the act said it goes. A refusal reopens the row the author was in, so the
   * draft comes back beside the command's own reason for turning it down.
   */
  const act = async (from: Editing, steps: Invocation[], then: Continue): Promise<void> => {
    setEditing(null);
    let ran = false;
    for (const step of steps) {
      const outcome = await api.invoke('command:exec', { ...step, source: 'ui' });
      if (!outcome.ok) {
        setNotice({ tone: 'refused', text: outcome.error });
        settled.current = false;
        setEditing(from);
        return;
      }
      setNotice({ tone: 'ok', text: outcome.record.message ?? 'Done.' });
      ran = true;
    }
    // Re-read rather than patch: the chunk was rewritten and a shots file may have been too, so
    // what comes back is what the loader says.
    let lines = shown?.lines ?? [];
    if (ran && props.scene) {
      const fresh = await api.invoke('story:coverage', props.scene);
      setData(fresh);
      lines = fresh.lines;
    }
    const next = nextEditing(lines, from, then);
    if (next) open(next);
  };

  const commit = (from: Editing): void => {
    if (!shown) return;
    const invocation =
      from.row === 'line' ? commitOf(from.line, draft) : insertOf(shown, from.after, draft);
    // A click in and a click away is not an authorial act: no record, no undo point, no notice.
    if (!invocation) {
      setEditing(null);
      setNotice((n) => (n?.tone === 'preview' ? null : n));
      return;
    }
    void act(from, [invocation], { open: 'none' });
  };

  const editor = (row: Editing, label: string): JSX.Element => (
    // The sizer carries the draft as `content`, so the row grows as you type without anything
    // being measured — no frame exists where the layout disagrees with the caret.
    <div className="text sc-grow" data-value={draft}>
      <textarea
        autoFocus
        value={draft}
        spellCheck
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (!shown) return;
          const box = e.currentTarget;
          const outcome = keyAct(
            shown,
            row,
            { text: draft, start: box.selectionStart, end: box.selectionEnd },
            e.key,
          );
          if (outcome.act === 'type') return;
          e.preventDefault();
          settled.current = true;
          if (outcome.act === 'discard') {
            setEditing(null);
            setNotice(null);
            return;
          }
          void act(row, outcome.steps, outcome.then);
        }}
        onBlur={() => {
          if (settled.current) return;
          commit(row);
        }}
      />
    </div>
  );

  if (story && scenes.length === 0) {
    return (
      <div className="script empty">
        <p className="invite">
          No scenes yet. Ask vnauthor for the opening scene below, or make one in the branch editor
          — this column is where you write it.
        </p>
      </div>
    );
  }

  return (
    <div className="script">
      <div className="script-bar">
        <span className="tt">SCRIPT</span>
        <select
          className="sc-scene"
          aria-label="Scene"
          value={props.scene ?? ''}
          onChange={(e) => props.onScene(e.target.value)}
        >
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} · {s.location}
            </option>
          ))}
        </select>
        <span className="ct">{shown ? `${shown.lines.length} line(s)` : ''}</span>
        {notice && <span className={`sc-notice ${notice.tone}`}>{notice.text}</span>}
      </div>

      {!shown ? (
        <div className="sc-note">Loading…</div>
      ) : (
        <div className="sc-page">
          {/* The heading as the scene's own slugline, so the column reads as a screenplay page
              rather than as a list that happens to be in order. */}
          <div className="sc-heading">{shown.location}</div>
          {shown.lines.length === 0 && editing === null && (
            <button type="button" className="sc-start" onClick={() => compose('')}>
              {shown.sceneId} has no lines yet — write the first one.
            </button>
          )}
          {scriptRows(shown.lines, editing).map((row) =>
            'compose' in row ? (
              <div className="sc-line new" key="compose">
                <span className="lid">+</span>
                <div className="sc-body">
                  {editor({ row: 'new', after: row.compose }, 'Write a new line')}
                </div>
              </div>
            ) : (
              <div className={`sc-line ${row.line.kind}`} key={row.line.id}>
                <span className="lid" title={row.line.id}>
                  {localLineId(row.line.id)}
                </span>
                <div className="sc-body">
                  {/* Not editable here: changing who says a line changes its kind, hence the
                      exporter's beat type. That is `story.setSpeaker`, a later step. */}
                  {row.line.speaker && <div className="who">{row.line.speaker}</div>}
                  {editing?.row === 'line' && editing.line.id === row.line.id ? (
                    editor(editing, `Retype ${row.line.id}`)
                  ) : (
                    <div className="text" onClick={() => openLine(row.line)}>
                      {row.line.text}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          {shown.lines.length > 0 && (
            <button
              type="button"
              className="sc-add"
              onClick={() => compose(shown.lines[shown.lines.length - 1]?.id ?? '')}
            >
              + line
            </button>
          )}
        </div>
      )}
    </div>
  );
}

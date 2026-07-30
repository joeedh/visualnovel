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
 *
 * A line's cue is the second thing on a row, and the only edit here that changes what *kind* of
 * line it is: `story.setSpeaker` turns narration into dialogue and back, and the exporter's beat
 * type follows. It is a choice off the project's cast rather than a name to type, so the column
 * cannot mint a cue nothing in `characters/` answers to.
 *
 * The acts that change which *scenes* exist — split, merge, continue — are confirmed rather than
 * run, because each detaches shots from the lines they cover and only the command can say how many.
 * So the strip that opens shows that command's own `check`, and the second gesture is the act.
 *
 * Dragging a line by its gutter is the `script.moveLine` interaction, and this surface is its first
 * consumer — the gesture was declared and tested before any of this existed. The grab asks it to
 * judge every insertion point at once; each pointer move reads that answer off by row rather than
 * re-deciding, and the drop runs `verdict.invoke` verbatim. So the sentence shown mid-drag, the drop
 * that is allowed, and what `interaction.targets` tells an agent are one verdict.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { isSpeakable } from '@vn/scriptedit';
import { api } from '../../../api';
import {
  canContinue,
  checkOf,
  continueFrom,
  cueChoices,
  cueLabel,
  dropTarget,
  insertOf,
  keyAct,
  localLineId,
  mergeTarget,
  moveStateOf,
  nextEditing,
  proposeSceneId,
  scriptRows,
  setSpeakerOf,
  splitBoundaries,
  stepsOf,
  type CastMember,
  type Continue,
  type CueChoice,
  type Editing,
  type Pending,
  type RowBox,
} from './script.js';
import { TOP, scriptMoveLine } from '../../../../src/shared/interactions.js';
import {
  commitOf,
  noticeForCheck,
  noticeForVerdict,
  type Notice,
} from '../../../../src/shared/lineedit.js';
import type { Invocation, Verdict } from '@vn/commands';
import type { CoverageLine, SceneCoverage, StoryGraph } from '../../../../src/shared/ipc';

interface Drag {
  /** The line being carried. */
  line: string;
  /** Every insertion point's verdict, judged once on the grab. Keyed by `TOP` or a line id. */
  verdicts: Map<string, Verdict>;
  /** The insertion point under the pointer; `null` before the first move. */
  target: string | null;
  /** The verdict there, or `null` where the drop would reorder nothing. */
  verdict: Verdict | null;
}

export function ScriptEditor(props: {
  /** The room's scene selection, shared with `branches`. `null` until the graph is known. */
  scene: string | null;
  onScene: (sceneId: string) => void;
  /** The project's cast, as the cue picker offers it. Empty until the index has loaded. */
  cast: readonly CastMember[];
}): JSX.Element {
  const [story, setStory] = useState<StoryGraph | null>(null);
  const [data, setData] = useState<SceneCoverage | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The line whose cue picker is open, if any. Not part of `Editing`: attribution is a different
  // command with no draft, and opening it must not look like the row is being retyped.
  const [attributing, setAttributing] = useState<string | null>(null);
  // A structural act, asked for and not yet confirmed. Separate from `editing` because it is not
  // prose: what is being edited in the strip is the command's own props.
  const [pending, setPending] = useState<Pending | null>(null);
  // Set by a key that already acted, so the blur it causes cannot commit the same draft twice.
  const settled = useRef(false);
  const page = useRef<HTMLDivElement | null>(null);

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
    setDrag(null);
    setAttributing(null);
    setPending(null);
    setNotice(null);
    void api.invoke('story:coverage', props.scene).then(setData);
  }, [props.scene]);

  const scenes = story?.scenes ?? [];
  // Only when it is the scene now selected: prose under another scene's heading, for the one
  // frame between the click and the read, would be prose the author might start editing.
  const shown = data && data.sceneId === props.scene ? data : null;
  // Which structural acts this scene can be offered at all. Each is its command's own rule read
  // ahead of time — the column doesn't put a button where the command would only refuse.
  const cuts = new Set(shown ? splitBoundaries(shown.lines) : []);
  const absorb = story && shown ? mergeTarget(story, shown.sceneId) : null;
  const continuable = !!(story && shown && canContinue(story, shown.sceneId));

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

  // What a structural act would cost, from the command's own `check`. This is the whole reason a
  // split or a merge is confirmed rather than run: the shots that detach are named before the act,
  // and re-asked as the author edits the id it would create.
  useEffect(() => {
    if (!pending || !props.scene) return;
    const invocation = checkOf(pending, props.scene);
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
  }, [pending, props.scene]);

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
   * draft comes back beside the command's own reason for turning it down — `from` is `null` for an
   * act no editor started, like a drop, which has no draft to hand back.
   */
  const act = async (
    from: Editing | null,
    steps: Invocation[],
    then: Continue,
  ): Promise<boolean> => {
    setEditing(null);
    let ran = false;
    for (const step of steps) {
      const outcome = await api.invoke('command:exec', { ...step, source: 'ui' });
      if (!outcome.ok) {
        setNotice({ tone: 'refused', text: outcome.error });
        if (from) {
          settled.current = false;
          setEditing(from);
        }
        return false;
      }
      setNotice({ tone: 'ok', text: outcome.record.message ?? 'Done.' });
      // Every `story.*` command answers with the rebuilt graph, so the scene list and the
      // structural affordances are never a beat behind a split that added a scene.
      if (outcome.data) setStory(outcome.data as StoryGraph);
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
    return ran;
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

  /**
   * Pick a line up by its gutter. Every insertion point is judged here, once — a drag that
   * re-asked per pointer move could change its mind about a drop the author is already over.
   */
  const grab = (line: CoverageLine, e: React.PointerEvent): void => {
    if (!shown) return;
    // Keeps the gesture from also being a text selection or a focus change.
    e.preventDefault();
    setEditing(null);
    setAttributing(null);
    setNotice(null);
    const judged = scriptMoveLine.targets(moveStateOf(shown), line.id);
    setDrag({
      line: line.id,
      verdicts: new Map(judged.map((v) => [v.target, v])),
      target: null,
      verdict: null,
    });
  };

  // Window-level, so a drag that leaves the column still tracks and still releases.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent): void => {
      const target = dropTarget(rowBoxes(page.current), e.clientY);
      // A row `targets` did not judge is a drop that would reorder nothing: no rule, no sentence.
      const verdict = drag.verdicts.get(target) ?? null;
      setDrag({ ...drag, target, verdict });
      setNotice(verdict ? noticeForVerdict(verdict) : null);
    };
    const onUp = (): void => {
      const pending = drag;
      setDrag(null);
      // A drop that changes nothing takes its sentence with it; a refused one keeps its reason.
      if (!pending.verdict) {
        setNotice(null);
        return;
      }
      if (!pending.verdict.accept) return;
      // The verdict's own invocation, not a second construction of it.
      void act(null, [pending.verdict.invoke], { open: 'none' });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, shown]);

  /** The insertion rule, drawn where the drop would land. Refused drops are drawn too. */
  const dropRule = (at: string): JSX.Element | null =>
    drag?.target === at && drag.verdict ? (
      <div className={`sc-drop ${drag.verdict.accept ? 'accept' : 'refuse'}`} />
    ) : null;

  /**
   * Ask for a structural act. Nothing is written: the strip opens with the command's own account of
   * what it would cost, and the author confirms or cancels.
   */
  const propose = (next: Pending): void => {
    setEditing(null);
    setAttributing(null);
    setNotice(null);
    setPending(next);
  };

  const cancel = (): void => {
    setPending(null);
    setNotice(null);
  };

  /** Commit the pending act. A new scene is one the author asked for in order to write in it. */
  const confirm = async (): Promise<void> => {
    if (!pending || !props.scene) return;
    const asked = pending;
    setPending(null);
    const ran = await act(null, stepsOf(asked, props.scene), { open: 'none' });
    if (ran && asked.act === 'scene') props.onScene(asked.scene);
  };

  /**
   * Pick who says a line. `story.setSpeaker` is the one edit here that changes a line's `kind` —
   * and with it the beat type the exporter writes — which is why it is a deliberate choice off a
   * closed list rather than a field to type a name into.
   */
  const attribute = (line: CoverageLine, cue: string, choices: CueChoice[]): void => {
    setAttributing(null);
    // Re-picking the cue the line already carries is not an authorial act: no record, no undo
    // point. It is also the only way to leave a narration line alone, which `setSpeaker` refuses.
    if (choices.find((c) => c.current)?.cue === cue) return;
    void act(null, [setSpeakerOf(line.id, cue)], { open: 'none' });
  };

  /**
   * A line's cue slot: what it says now, and the picker it opens. Only the kinds `setSpeaker` acts
   * on get one — its own predicate answers that, so a row can't offer an edit it would refuse.
   */
  const cue = (line: CoverageLine): JSX.Element | null => {
    if (!isSpeakable(line.kind)) return null;
    if (attributing !== line.id) {
      return (
        <button
          type="button"
          className={`who${line.speaker ? '' : ' none'}`}
          onClick={() => {
            setAttributing(line.id);
            setNotice(null);
          }}
        >
          {cueLabel(props.cast, line.speaker) || 'who?'}
        </button>
      );
    }
    const choices = cueChoices(props.cast, line.speaker);
    return (
      <select
        className="who picking"
        autoFocus
        aria-label={`Who says ${line.id}`}
        value={choices.find((c) => c.current)?.cue ?? ''}
        onChange={(e) => attribute(line, e.target.value, choices)}
        onBlur={() => setAttributing(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setAttributing(null);
        }}
      >
        {choices.map((c, i) => (
          <option key={`${i}:${c.cue}`} value={c.cue}>
            {c.label}
          </option>
        ))}
      </select>
    );
  };

  /**
   * The pending act's strip: what it would do, the props still being chosen, and the two gestures
   * that end it. Its sentence is in the bar, beside every other thing a command has said.
   */
  const strip = (): JSX.Element | null => {
    if (!pending || !shown) return null;
    const keys = (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') void confirm();
      if (e.key === 'Escape') cancel();
    };
    return (
      <div className={`sc-pend ${pending.act}`}>
        {pending.act === 'split' && (
          <>
            <span className="what">
              Split at {localLineId(pending.at)} — that line and the rest become
            </span>
            <input
              className="sc-prop"
              aria-label="The new scene's id"
              autoFocus
              value={pending.into}
              onChange={(e) => setPending({ ...pending, into: e.target.value })}
              onKeyDown={keys}
            />
          </>
        )}
        {pending.act === 'merge' && (
          <span className="what">
            Absorb {pending.absorbed} into {shown.sceneId} — its lines are renumbered
          </span>
        )}
        {pending.act === 'scene' && (
          <>
            <span className="what">New scene, continued to from {shown.sceneId}:</span>
            <input
              className="sc-prop"
              aria-label="The new scene's id"
              autoFocus
              value={pending.scene}
              onChange={(e) => setPending({ ...pending, scene: e.target.value })}
              onKeyDown={keys}
            />
            <input
              className="sc-prop wide"
              aria-label="The new scene's heading"
              value={pending.heading}
              onChange={(e) => setPending({ ...pending, heading: e.target.value })}
              onKeyDown={keys}
            />
          </>
        )}
        <button type="button" className="go" onClick={() => void confirm()}>
          {pending.act === 'split' ? 'Split' : pending.act === 'merge' ? 'Merge' : 'Write it'}
        </button>
        <button type="button" className="no" onClick={cancel}>
          Cancel
        </button>
      </div>
    );
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
        <div className={`sc-page${drag ? ' dragging' : ''}`} ref={page}>
          {/* The heading as the scene's own slugline, so the column reads as a screenplay page
              rather than as a list that happens to be in order. */}
          <div className="sc-heading">{shown.location}</div>
          {shown.lines.length === 0 && editing === null && (
            <button type="button" className="sc-start" onClick={() => compose('')}>
              {shown.sceneId} has no lines yet — write the first one.
            </button>
          )}
          {dropRule(TOP)}
          {scriptRows(shown.lines, editing).map((row) =>
            'compose' in row ? (
              <div className="sc-line new" key="compose">
                <span className="lid">+</span>
                <div className="sc-body">
                  {editor({ row: 'new', after: row.compose }, 'Write a new line')}
                </div>
              </div>
            ) : (
              <Fragment key={row.line.id}>
                <div
                  className={`sc-line ${row.line.kind}${drag?.line === row.line.id ? ' carried' : ''}`}
                  data-line={row.line.id}
                >
                  {/* The gutter is the handle: it is already the row's name, and a line's name is
                      what a move is about. */}
                  <span
                    className="lid"
                    title={row.line.id}
                    onPointerDown={(e) => grab(row.line, e)}
                  >
                    {localLineId(row.line.id)}
                  </span>
                  <div className="sc-body">
                    {cue(row.line)}
                    {editing?.row === 'line' && editing.line.id === row.line.id ? (
                      editor(editing, `Retype ${row.line.id}`)
                    ) : (
                      <div className="text" onClick={() => openLine(row.line)}>
                        {row.line.text}
                      </div>
                    )}
                  </div>
                  {/* A boundary is a property of the row below it, so the affordance lives on the
                      row rather than between rows: "the second half starts here". */}
                  {cuts.has(row.line.id) && pending === null && (
                    <button
                      type="button"
                      className="sc-cut"
                      onClick={() =>
                        propose({
                          act: 'split',
                          at: row.line.id,
                          into: proposeSceneId(
                            shown.sceneId,
                            scenes.map((s) => s.id),
                          ),
                        })
                      }
                    >
                      split here
                    </button>
                  )}
                </div>
                {pending?.act === 'split' && pending.at === row.line.id && strip()}
                {dropRule(row.line.id)}
              </Fragment>
            ),
          )}
          <div className="sc-struct">
            {shown.lines.length > 0 && (
              <button
                type="button"
                className="sc-add"
                onClick={() => compose(shown.lines[shown.lines.length - 1]?.id ?? '')}
              >
                + line
              </button>
            )}
            {absorb && (
              <button
                type="button"
                className="sc-add"
                onClick={() => propose({ act: 'merge', absorbed: absorb })}
              >
                merge {absorb} in
              </button>
            )}
            {continuable && (
              <button
                type="button"
                className="sc-add"
                onClick={() =>
                  propose(
                    continueFrom(
                      shown.sceneId,
                      shown.location,
                      scenes.map((s) => s.id),
                    ),
                  )
                }
              >
                + scene after this one
              </button>
            )}
          </div>
          {pending && pending.act !== 'split' && strip()}
        </div>
      )}
    </div>
  );
}

/**
 * The rendered line rows, measured. The only DOM read the drag does — `dropTarget` decides which
 * insertion point they mean, and it is tested in node against boxes like these.
 */
function rowBoxes(page: HTMLElement | null): RowBox[] {
  const rows = page?.querySelectorAll<HTMLElement>('[data-line]') ?? [];
  return [...rows].map((el) => {
    const box = el.getBoundingClientRect();
    return { id: el.dataset.line ?? '', top: box.top, bottom: box.bottom };
  });
}

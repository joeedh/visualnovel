import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { Beat, Playable, PlayableScene } from '../src/shared/ipc';

/** A content-addressed asset ref, as it appears in the playable. */
interface Ref {
  hash: string;
  ext: string;
}

/** A position in the playthrough: which scene and how far into its frames. */
interface Pos {
  sceneId: string;
  frameIndex: number;
}

/**
 * A textual beat with the accumulated stage state at that point: `show` beats are folded
 * into the frame that follows them, so advancing one frame reveals one line of dialogue or
 * narration while the background/portrait carry over.
 */
interface Frame {
  bg?: Ref;
  /** Last speaker so far — drives which portrait is on stage (persists through narration). */
  portraitWho?: string;
  /** Set only when this frame is spoken dialogue (drives the nameplate). */
  speaker?: string;
  text: string;
}

/** Fold a scene's beats into displayable frames. */
function framesOf(scene: PlayableScene | undefined): Frame[] {
  if (!scene) return [];
  const frames: Frame[] = [];
  let bg: Ref | undefined;
  let lastWho: string | undefined;
  for (const beat of scene.beats as Beat[]) {
    if (beat.type === 'show') {
      bg = beat.image;
    } else if (beat.type === 'say') {
      lastWho = beat.who;
      frames.push({ bg, portraitWho: lastWho, speaker: beat.who, text: beat.text });
    } else {
      frames.push({ bg, portraitWho: lastWho, text: beat.text });
    }
  }
  return frames;
}

/** `vnasset://<hash>.<ext>` — resolved by the main process from the content-addressed store. */
function assetUrl(ref?: Ref): string | undefined {
  return ref ? `vnasset://${ref.hash}.${ref.ext}` : undefined;
}

/** The playthrough view: replays a scene's beats, follows choices/next, saves to localStorage. */
export function Runner(): JSX.Element {
  const [play, setPlay] = useState<Playable | null>(null);
  // The whole navigation stack; the last element is the current position (drives Back).
  const [history, setHistory] = useState<Pos[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api.invoke('story:play').then((p) => {
      setPlay(p);
      if (p.start) setHistory([{ sceneId: p.start, frameIndex: 0 }]);
    });
  }, []);

  const cur = history[history.length - 1] ?? null;
  const scene = play && cur ? play.scenes[cur.sceneId] : undefined;
  const frames = useMemo(() => framesOf(scene), [scene]);

  const saveKey = play ? `vn.runner.save.${play.title}` : 'vn.runner.save';

  const go = useCallback((next: Pos) => setHistory((h) => [...h, next]), []);

  const advance = useCallback(() => {
    if (!play || !cur || !scene) return;
    if (cur.frameIndex < frames.length) {
      go({ sceneId: cur.sceneId, frameIndex: cur.frameIndex + 1 });
      return;
    }
    // At the scene-end panel: a click follows the linear `next` when there's no choice to make.
    if (!scene.choices.length && scene.next) go({ sceneId: scene.next, frameIndex: 0 });
  }, [play, cur, scene, frames.length, go]);

  const back = useCallback(() => {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  }, []);

  const reset = useCallback(() => {
    if (play?.start) setHistory([{ sceneId: play.start, frameIndex: 0 }]);
    setNotice('Restarted from the beginning.');
  }, [play]);

  const save = useCallback(() => {
    try {
      localStorage.setItem(saveKey, JSON.stringify(history));
      setNotice('Saved.');
    } catch {
      setNotice('Could not save.');
    }
  }, [history, saveKey]);

  const load = useCallback(() => {
    try {
      const raw = localStorage.getItem(saveKey);
      if (!raw) return setNotice('No save found.');
      const parsed = JSON.parse(raw) as Pos[];
      if (Array.isArray(parsed) && parsed.length) {
        setHistory(parsed);
        setNotice('Loaded.');
      }
    } catch {
      setNotice('Could not load.');
    }
  }, [saveKey]);

  // Keyboard: advance on Space/Enter/→, rewind on ←/Backspace. Ignore while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (/^(input|textarea)$/i.test(tag)) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, back]);

  if (!play) return <div className="runner empty">Loading the playable…</div>;
  if (!cur || !play.start)
    return <div className="runner empty">No entry scene — this project has no playable story.</div>;
  if (!scene)
    return (
      <div className="runner">
        <RunnerBar
          play={play}
          canBack={history.length > 1}
          onBack={back}
          onSave={save}
          onLoad={load}
          onReset={reset}
          notice={notice}
        />
        <div className="stage-vn missing">
          Missing scene <b>{cur.sceneId}</b> — the story graph points somewhere that doesn't exist.
        </div>
      </div>
    );

  const atEnd = cur.frameIndex >= frames.length;
  const frame = atEnd ? frames[frames.length - 1] : frames[cur.frameIndex];
  const bgUrl = assetUrl(frame?.bg);
  const portraitRef = frame?.portraitWho ? play.characters[frame.portraitWho]?.portrait : undefined;
  const portraitUrl = assetUrl(portraitRef);
  const speakerName = frame?.speaker ? (play.characters[frame.speaker]?.name ?? frame.speaker) : '';

  return (
    <div className="runner">
      <RunnerBar
        play={play}
        canBack={history.length > 1}
        onBack={back}
        onSave={save}
        onLoad={load}
        onReset={reset}
        notice={notice}
        scene={cur.sceneId}
      />
      <div className={`stage-vn${atEnd ? ' at-end' : ''}`} onClick={advance} role="presentation">
        <div className="scenery">
          {bgUrl ? (
            <img className="bg" src={bgUrl} alt="" draggable={false} />
          ) : (
            <div className="bg placeholder">
              <span>no background yet</span>
            </div>
          )}
          {portraitUrl && (
            <img className="portrait" src={portraitUrl} alt={speakerName} draggable={false} />
          )}
        </div>

        {!atEnd && frame && (
          <div className="dbox-vn">
            {frame.speaker && <div className="who">{speakerName}</div>}
            <div className={`line${frame.speaker ? '' : ' narration'}`}>{frame.text}</div>
            <div className="advance-hint">click or press space ▸</div>
          </div>
        )}

        {atEnd && (
          <SceneEnd
            scene={scene}
            characters={play.characters}
            onChoice={(goto) => go({ sceneId: goto, frameIndex: 0 })}
            onContinue={advance}
          />
        )}
      </div>
    </div>
  );
}

function RunnerBar(props: {
  play: Playable;
  canBack: boolean;
  onBack: () => void;
  onSave: () => void;
  onLoad: () => void;
  onReset: () => void;
  notice: string | null;
  scene?: string;
}): JSX.Element {
  return (
    <div className="runnerbar">
      <div className="title">Runner</div>
      <div className="sub">
        {props.play.title}
        {props.scene ? ` · ${props.scene}` : ''}
      </div>
      {props.notice && <span className="notice">{props.notice}</span>}
      <div className="spacer" />
      <button className="rbtn" onClick={props.onBack} disabled={!props.canBack}>
        ◂ Back
      </button>
      <button className="rbtn" onClick={props.onSave}>
        Save
      </button>
      <button className="rbtn" onClick={props.onLoad}>
        Load
      </button>
      <button className="rbtn" onClick={props.onReset}>
        Reset
      </button>
    </div>
  );
}

function SceneEnd(props: {
  scene: PlayableScene;
  characters: Playable['characters'];
  onChoice: (goto: string) => void;
  onContinue: () => void;
}): JSX.Element {
  const { scene } = props;
  if (scene.choices.length) {
    return (
      <div className="scene-end" onClick={(e) => e.stopPropagation()}>
        <div className="prompt">What do you do?</div>
        <div className="choices-vn">
          {scene.choices.map((c, i) => (
            <button key={i} className="choice-vn" onClick={() => props.onChoice(c.goto)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (scene.next) {
    return (
      <div className="scene-end">
        <button className="choice-vn continue" onClick={props.onContinue}>
          Continue ▸
        </button>
      </div>
    );
  }
  return (
    <div className="scene-end" onClick={(e) => e.stopPropagation()}>
      <div className="the-end">The End</div>
    </div>
  );
}

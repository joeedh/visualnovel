import { HotKey, KeyMap, type Container } from 'pathux';
import { api } from '../../api.js';
import type { Playable, PlayableScene } from '../../../src/shared/ipc.js';
import { notify, onInvalidate } from '../app/bridge.js';
import { centered } from '../widgets/dom.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import {
  advance,
  assetUrl,
  back,
  choose,
  framesOf,
  jumpTo,
  parseSave,
  samePos,
  saveKeyOf,
  startOf,
  type Frame,
  type Pos,
} from '../play/playback.js';
import { TOKENS, alpha } from '../app/tokens.js';

/**
 * The playthrough editor: the React `Runner` with its rules lifted out to `play/playback.ts`
 * and its markup rebuilt as plain DOM inside a path.ux area.
 *
 * The stage is raw DOM rather than widgets on purpose — it is one image, one text box and a
 * few buttons, and path.ux guards non-widget children throughout `ui_base`, so a `<div>` in a
 * Container is a supported thing to do. The chrome (Back/Save/Load/Reset) is built from widgets,
 * so it themes and lays out with every other header in the shell.
 *
 * The frame carries the shot it came from, so watching the story moves `ui.sceneId`/`ui.shotId`
 * and every other editor follows along. The React runner could not do that: it could show a
 * frame but never say where in the story that frame was. It follows the same two fields the other
 * way as well, so a scene or a shot picked anywhere else jumps the playthrough there.
 */
export class PlayEditor extends VnEditor {
  private bar!: Container;
  private stage!: HTMLDivElement;

  private play: Playable | undefined;
  /** Why there is no playable. A project without one is the normal case. */
  private failure = '';
  /** The whole navigation stack; the last entry is where we are, and Back pops it. */
  private history: Pos[] = [];
  private notice = '';
  /** What the bar and stage last drew, so a redraw happens on a change and not on a tick. */
  private drawn = '';
  /** The shared selection this pane has already answered, so only a foreign move jumps it. */
  private followed = '';
  /** The playthrough position last published, so a redraw that did not move publishes nothing. */
  private published = '';
  /** Bumped on every re-read, so a reload redraws even though the position did not move. */
  private revision = 0;

  static override define() {
    return {
      tagname : 'vn-play-editor-x',
      areaname: 'play',
      icon    : -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.stage = document.createElement('div');
    Object.assign(this.stage.style, {
      position  : 'relative',
      overflow  : 'hidden',
      background: TOKENS.inkSunken,
      cursor    : 'pointer',
      fontFamily: TOKENS.sans,
      color     : TOKENS.paper,
    });
    this.stage.title = 'Click anywhere to advance to the next line';
    this.stage.addEventListener('click', () => this.stepForward());
    this.appendSurface(this.stage);

    // This keymap runs ahead of the screen keymap, and path.ux already declines to route a
    // keystroke that landed in a textbox, so nothing here needs to sniff the target's tag.
    this.keymap = new KeyMap([
      new HotKey('Space', [], () => this.stepForward(), 'Advance'),
      new HotKey('Enter', [], () => this.stepForward(), 'Advance'),
      new HotKey('Right', [], () => this.stepForward(), 'Advance'),
      new HotKey('Left', [], () => this.go(back(this.history)), 'Back'),
      new HotKey('Backspace', [], () => this.go(back(this.history)), 'Back'),
    ]);

    // The playable is built from the model and the store rather than read from a file, so a shot
    // made or rendered since the last read is a re-read away. Coming back on screen re-reads for
    // the same reason: what changed while the pane was away is unknowable from here.
    this.watch(
      () => onInvalidate(() => void this.reload()),
      () => void this.reload(),
    );

    void this.loadPlayable();
  }

  override update() {
    super.update();

    const selection = this.selectionKey();
    if (selection !== this.followed) this.follow(selection);
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  /**
   * A project with no `story.play.json`, or with no project open at all, counts as an ordinary
   * state rather than a crash, so this puts the reason on the stage where an author reading it
   * can act on it.
   */
  private async loadPlayable(): Promise<void> {
    try {
      this.play = await api.invoke('story:play');
      this.history = this.opening(this.play);
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
    }
    this.rebuild();
  }

  /**
   * Re-read the playable and stay where the playthrough is. A shot made, moved or re-rendered
   * changes which image a frame carries rather than how many frames a scene has, because a `show`
   * beat folds into the line after it — so the position survives. A scene that has gone since is
   * the one case that starts over.
   */
  private async reload(): Promise<void> {
    let play: Playable;
    try {
      play = await api.invoke('story:play');
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      this.rebuild();
      return;
    }
    this.play = play;
    this.failure = '';
    const cur = this.history[this.history.length - 1];
    if (!cur || !play.scenes[cur.sceneId]) this.history = this.opening(play);
    this.revision += 1;
    this.rebuild();
  }

  /** Where a fresh read starts: what the rest of the app is looking at, or the story's own start. */
  private opening(play: Playable): Pos[] {
    const at = jumpTo(play, this.ui.sceneId, this.ui.shotId);
    return at ? [at] : startOf(play);
  }

  /** Everything both halves draw, in one string. */
  private stateKey(): string {
    const cur = this.history[this.history.length - 1];
    return [
      this.play?.title ?? '',
      this.failure,
      this.revision,
      this.history.length,
      cur?.sceneId ?? '',
      cur?.frameIndex ?? -1,
      this.notice,
    ].join('|');
  }

  private selectionKey(): string {
    return `${this.ui.sceneId}|${this.ui.shotId}`;
  }

  /**
   * Jump to a scene or a shot picked elsewhere — in the document tree, in Shot Coverage, in the
   * task graph. The jump is pushed onto the history rather than replacing it, so Back retraces the
   * way it retraces a choice.
   *
   * A scene the playable does not have is said rather than followed: the story is exported from
   * the model as it stands, so a scene with no beats yet is an ordinary pre-run state.
   */
  private follow(selection: string): void {
    this.followed = selection;
    if (!this.play || !this.ui.sceneId) return;

    const to = jumpTo(this.play, this.ui.sceneId, this.ui.shotId);
    if (!to) {
      this.notice = `${this.ui.sceneId} has nothing to play yet.`;
      this.rebuild();
      return;
    }
    if (samePos(this.history[this.history.length - 1], to)) return;
    this.history = [...this.history, to];
    this.notice = '';
    this.rebuild();
  }

  /** One frame on, or off the end of the scene onto whatever follows it. */
  private stepForward(): void {
    if (this.play) this.go(advance(this.play, this.history));
  }

  /**
   * Move to a new position. `advance`/`back` hand back the same array when there is nowhere to
   * go, so identity is the test for "nothing happened" and a redraw is skipped.
   */
  private go(next: Pos[]): void {
    if (!this.play || next === this.history) return;
    this.history = next;
    this.notice = '';
    this.rebuild();
  }

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.rebuildBar();
    this.rebuildStage();
    this.publishSelection();
  }

  /**
   * The playthrough position, as the shell's one selection. Pushed only when the playthrough
   * itself moved: a `notifyChange` per frame would rebuild every other editor for nothing, and a
   * redraw that did not move would publish the played position over a scene the author has just
   * selected somewhere else.
   */
  private publishSelection(): void {
    const cur = this.history[this.history.length - 1];
    const at = `${cur?.sceneId ?? ''}|${cur?.frameIndex ?? -1}`;
    if (at === this.published) return;
    this.published = at;

    const sceneId = cur?.sceneId ?? '';
    const shotId = this.currentFrame()?.shotId ?? '';
    // Recorded whether or not it is pushed, because either way this is the selection the pane is
    // now answering, and `update` would otherwise read its own move as a foreign one.
    this.followed = `${sceneId}|${shotId}`;
    if (this.ui.sceneId === sceneId && this.ui.shotId === shotId) return;

    this.ui.sceneId = sceneId;
    this.ui.shotId = shotId;
    this.announce();
  }

  private scene(): PlayableScene | undefined {
    const cur = this.history[this.history.length - 1];
    return this.play && cur ? this.play.scenes[cur.sceneId] : undefined;
  }

  /** The frame on stage. At the scene-end panel the last frame stays up behind it. */
  private currentFrame(): Frame | undefined {
    const cur = this.history[this.history.length - 1];
    if (!cur) return undefined;
    const frames = framesOf(this.scene());
    return cur.frameIndex >= frames.length ? frames[frames.length - 1] : frames[cur.frameIndex];
  }

  private rebuildBar(): void {
    const cur = this.history[this.history.length - 1];

    this.bar.clear();
    this.bar.label(this.play?.title ?? 'Loading…').style['padding'] = '0px 8px';
    if (cur) this.bar.label(cur.sceneId).style['padding'] = '0px 8px';
    if (this.notice) this.bar.label(this.notice).style['padding'] = '0px 8px';

    const backBtn = this.bar.button('◂ Back', () => this.go(back(this.history)));
    backBtn.disabled = this.history.length < 2;
    backBtn.description =
      this.history.length < 2
        ? 'You are at the beginning; there is nothing to step back to.'
        : 'Step back to the scene before this one';

    this.bar.button('Save', () => this.save()).description =
      'Remember where you are, so Load comes back here';
    this.bar.button('Load', () => this.load()).description = 'Jump back to where Save left off';
    this.bar.button('Reset', () => {
      if (!this.play) return;
      this.history = startOf(this.play);
      this.notice = 'Restarted from the beginning.';
      this.rebuild();
    }).description = 'Start the story again from its first scene';

    this.bar.flushUpdate();
  }

  private save(): void {
    try {
      localStorage.setItem(saveKeyOf(this.play), JSON.stringify(this.history));
      this.notice = 'Saved.';
    } catch {
      this.notice = 'Could not save.';
    }
    this.rebuild();
  }

  private load(): void {
    const saved = parseSave(localStorage.getItem(saveKeyOf(this.play)));
    if (!saved) {
      notify({ category: 'workspace', level: 'warn', message: 'No save found for this project.' });
      return;
    }
    this.history = saved;
    this.notice = 'Loaded.';
    this.rebuild();
  }

  private rebuildStage(): void {
    this.stage.textContent = '';

    if (this.failure) return void this.stage.appendChild(centered(this.failure));
    if (!this.play) return void this.stage.appendChild(centered('Loading the playable…'));

    const cur = this.history[this.history.length - 1];
    if (!cur) {
      return void this.stage.appendChild(
        centered('No entry scene — this project has no playable story.'),
      );
    }

    const scene = this.scene();
    if (!scene) {
      return void this.stage.appendChild(
        centered(
          `Missing scene ${cur.sceneId} — the story graph points somewhere that isn't there.`,
        ),
      );
    }

    const frames = framesOf(scene);
    const atEnd = cur.frameIndex >= frames.length;
    const frame = this.currentFrame();

    this.stage.appendChild(this.scenery(frame));
    if (!atEnd && frame) this.stage.appendChild(this.dialogue(frame));
    if (atEnd) this.stage.appendChild(this.sceneEnd(scene));
  }

  /** The background, and the portrait over it when the project opted in. */
  private scenery(frame: Frame | undefined): HTMLElement {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      position      : 'absolute',
      inset         : '0',
      display       : 'flex',
      alignItems    : 'center',
      justifyContent: 'center',
    });

    const bgUrl = assetUrl(frame?.bg);
    if (bgUrl) {
      const img = document.createElement('img');
      img.src = bgUrl;
      img.draggable = false;
      Object.assign(img.style, { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' });
      wrap.appendChild(img);
    } else {
      const empty = document.createElement('div');
      empty.textContent = 'no background yet';
      Object.assign(empty.style, { color: TOKENS.mistDim, fontFamily: TOKENS.mono });
      wrap.appendChild(empty);
    }

    // A shot prompt names its own subjects, so the frame already shows the cast; staging a
    // portrait on top of it is the project's opt-in, not the runner's default.
    const portrait =
      this.play?.portraitOverlay && frame?.portraitWho
        ? this.play.characters[frame.portraitWho]?.portrait
        : undefined;
    const portraitUrl = assetUrl(portrait);
    if (portraitUrl) {
      const img = document.createElement('img');
      img.src = portraitUrl;
      img.draggable = false;
      Object.assign(img.style, {
        position : 'absolute',
        bottom   : '0',
        left     : '4%',
        maxHeight: '78%',
        objectFit: 'contain',
      });
      wrap.appendChild(img);
    }

    return wrap;
  }

  private dialogue(frame: Frame): HTMLElement {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position  : 'absolute',
      left      : '0',
      right     : '0',
      bottom    : '0',
      padding   : '14px 18px 10px',
      background: alpha(TOKENS.ink, 0.86),
      borderTop : `1px solid ${TOKENS.inkLine}`,
    });

    if (frame.speaker) {
      const who = document.createElement('div');
      who.textContent = this.play?.characters[frame.speaker]?.name ?? frame.speaker;
      Object.assign(who.style, {
        color        : TOKENS.sodium,
        fontFamily   : TOKENS.disp,
        fontSize     : '13px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        marginBottom : '4px',
      });
      box.appendChild(who);
    }

    const line = document.createElement('div');
    line.textContent = frame.text;
    Object.assign(line.style, {
      fontFamily: TOKENS.prose,
      fontSize  : '18px',
      lineHeight: '1.5',
      color     : frame.speaker ? TOKENS.paper : TOKENS.mist,
      fontStyle : frame.speaker ? 'normal' : 'italic',
    });
    box.appendChild(line);

    const hint = document.createElement('div');
    hint.textContent = 'click or press space ▸';
    Object.assign(hint.style, {
      marginTop : '6px',
      textAlign : 'right',
      color     : TOKENS.mistDim,
      fontFamily: TOKENS.mono,
      fontSize  : '11px',
    });
    box.appendChild(hint);

    return box;
  }

  /** The end-of-scene panel: the choices, the linear continuation, or the end of the story. */
  private sceneEnd(scene: PlayableScene): HTMLElement {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position      : 'absolute',
      inset         : '0',
      display       : 'flex',
      flexDirection : 'column',
      alignItems    : 'center',
      justifyContent: 'center',
      gap           : '10px',
      background    : alpha(TOKENS.ink, 0.72),
    });

    if (scene.choices.length) {
      // The panel stops the click, so a choice is the only way on. A click that reached the
      // stage would advance instead.
      panel.addEventListener('click', (e) => e.stopPropagation());
      const prompt = document.createElement('div');
      prompt.textContent = 'What do you do?';
      Object.assign(prompt.style, {
        color        : TOKENS.mist,
        fontFamily   : TOKENS.disp,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        fontSize     : '12px',
      });
      panel.appendChild(prompt);

      for (const choice of scene.choices) {
        panel.appendChild(
          this.choiceButton(
            choice.label,
            `Take this branch — the story goes on at ${choice.goto}`,
            () => this.go(choose(this.history, choice.goto)),
          ),
        );
      }
      return panel;
    }

    if (scene.next) {
      panel.appendChild(
        this.choiceButton('Continue ▸', 'Play on to the scene this one leads to', () =>
          this.go(advance(this.play as Playable, this.history)),
        ),
      );
      return panel;
    }

    panel.addEventListener('click', (e) => e.stopPropagation());
    const end = document.createElement('div');
    end.textContent = 'The End';
    Object.assign(end.style, {
      fontFamily   : TOKENS.disp,
      fontSize     : '28px',
      letterSpacing: '0.14em',
      color        : TOKENS.sodium,
    });
    panel.appendChild(end);
    return panel;
  }

  private choiceButton(label: string, tip: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = tip;
    Object.assign(btn.style, {
      padding     : '8px 18px',
      minWidth    : '180px',
      cursor      : 'pointer',
      color       : TOKENS.paper,
      background  : TOKENS.inkRaised,
      border      : `1px solid ${TOKENS.inkLine}`,
      borderRadius: `${TOKENS.radiusChrome}px`,
      fontFamily  : TOKENS.sans,
      fontSize    : '14px',
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }
}

registerEditor(PlayEditor, 'vn.PlayEditor');

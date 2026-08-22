import type { Container, MenuTemplate } from 'pathux';
import { isSpeakable } from '@vn/scriptedit';
import { api } from '../../api.js';
import { commitOf, noticeForCheck, type Notice } from '../../../src/shared/lineedit.js';
import { TOP } from '../../../src/shared/interactions.js';
import {
  canContinue,
  checkOf,
  composedCueText,
  continueFrom,
  cueChoices,
  cueSlotText,
  dropTarget,
  insertOf,
  keyAct,
  localLineId,
  mergeTarget,
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
} from '../../rules/script.js';
import { ASSETSTRIP_CSS, renderAssetStrip } from '../assetstrip.js';
import { shotGroups } from '../doctree.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openCommandDialog } from '../dialog.js';
import { assetNode, openNode } from '../open.js';
import type { VnScreen } from '../screen.js';
import { aim, dropOf, grabLine, lineMenu, noticeOf, type Drag } from '../script.js';
import { menuIsOpen, showContextMenu } from '../showmenu.js';
import type { VnContext } from '../context.js';
import { onInvalidate, onWrote, refreshWorkspace } from '../bridge.js';
import { touchesScene } from '../../../src/shared/writes.js';
import SCRIPT_CSS from '../../styles/script.css?inline';
import type { Invocation } from '@vn/commands';
import type { CoverageLine, DocTree, SceneCoverage, StoryGraph } from '../../../src/shared/ipc.js';

/**
 * The frame `script.css` does not supply. That sheet is imported as-is because it is still the
 * React column's sheet and one copy is the point, so only two things are added here: a reset,
 * because the page's own does not cross the shadow boundary, and the notice, which was the bar's
 * right edge and here is a strip above the page (a path.ux label cannot carry the tone colours).
 */
const SURFACE_CSS = `
* { box-sizing: border-box; }
.script.sc-surface {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ink);
  color: var(--paper);
}
.sc-surface > .sc-notice {
  flex: none;
  margin-left: 0;
  padding: 7px 22px;
  min-height: 27px;
  border-bottom: 1px solid var(--ink-line);
  background: var(--ink-sunken);
}
.sc-surface > .sc-page { flex: 1 1 auto; }
.sc-surface > .sc-note { flex: none; }
.sc-surface > .sc-frames {
  flex: none;
  max-height: 26%;
  overflow: auto;
  border-top: 1px solid var(--ink-line);
  background: var(--ink-sunken);
}
.sc-surface.empty { align-items: center; justify-content: center; padding: 40px; }
`;

const INVITE =
  'No scenes yet. Make one in the branch editor, or ask vnauthor for the opening scene — ' +
  'this pane is where you write it.';

/**
 * A scene with no art is the ordinary state of a scene being written, so this says so rather than
 * leaving a blank band under the page that reads as something failing to load.
 */
const EMPTY = 'No frames for this scene yet.';

/**
 * The script pane: a scene as a screenplay page, and the surface where prose gets written. Ported
 * from STUDIO's `ScriptEditor`, and the last of the three gesture editors.
 *
 * Everything it decides is imported: `script.ts` for what a keystroke means, what a row is, and
 * which structural acts this scene can be offered at all; `lineedit.ts` for what a draft is as a
 * line; `pathux/script.ts` for the drag. This file opens editors, runs what it is told to run, and
 * moves the caret. There is no buffer here to diff — the model is a list of lines.
 *
 * Two things change in the port, both because the shell has them and the room did not. The scene
 * being written is the shared `ui.sceneId`, so a card picked in the branch pane opens here and a
 * line moved here is the coverage the timeline pane redraws. An open row also has to stop its own
 * keystrokes: the shell keymap is a window listener, so otherwise `/` opens the palette in the
 * middle of a sentence.
 *
 * Under the page sits what has been drawn from the scene, gathered by shot rather than by kind:
 * the frames beside the prose they illustrate, so an author writing a line can see what the block
 * it sits in already looks like. It is the same widget the wiki pane draws, and it is read-only
 * here too — a picture is picked from here, never accepted or regenerated.
 */
export class ScriptEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;
  private page: HTMLDivElement | undefined;
  private noticeEl: HTMLElement | undefined;
  /** The frames drawn from this scene. Not `strip` — that word is already the pending act's. */
  private frames!: HTMLDivElement;

  /** The tree the frames are read out of. One fetch per invalidation, not one per scene. */
  private tree: DocTree | undefined;

  private story: StoryGraph | undefined;
  private data: SceneCoverage | undefined;
  private cast: CastMember[] = [];
  private failure = '';
  private drawn = '';
  /** The scene `data` is for, or the one a fetch in flight will make it for. Not `data.sceneId`. */
  private loading = '';
  /** Bumped on every load, so a reload redraws even when nothing about the selection moved. */
  private revision = 0;

  private editing: Editing | null = null;
  private draft = '';
  // Set by a key that already acted, so the blur it causes cannot commit the same draft twice.
  private settled = false;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;

  private drag: Drag | null = null;
  private dropEl: HTMLElement | undefined;
  // The line whose cue picker is open. Not part of `Editing`: attribution is a different command
  // with no draft, and opening it must not look like the row is being retyped.
  private attributing: string | null = null;
  // A structural act, asked for and not yet confirmed. Separate from `editing` because it is not
  // prose: what is being edited in the strip is the command's own props.
  private pending: Pending | null = null;
  private notice: Notice | null = null;
  // Latched at pointer-down when a context menu is up; see `armDismissLatch`.
  private dismissing = false;

  static override define() {
    return {
      tagname: 'vn-script-editor-x',
      areaname: 'script',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.adoptStyle(SCRIPT_CSS + SURFACE_CSS);
    this.adoptStyle(ASSETSTRIP_CSS);
    this.surface = el('div', 'script sc-surface') as HTMLDivElement;
    this.appendSurface(this.surface);
    this.armDismissLatch();

    // Outlives the page it sits under: `rebuildSurface` empties the surface on every redraw, and
    // frames rebuilt with it would flicker for a keystroke that only moved the caret.
    this.frames = el('div', 'sc-frames') as HTMLDivElement;

    // The scene on screen can be rewritten by something that is not this pane — the agent in
    // execute mode is the usual one. A page nobody is in the middle of follows; one with an open
    // row or a held line does not, because re-reading would take the draft with it. That is what
    // `⟳` is for.
    this.watch(
      () =>
        onWrote((paths) => {
          if (this.editing || this.pending || this.drag) return;
          if (touchesScene(paths, this.ui.sceneId)) void this.loadScene();
        }),
      // Coming back on screen, the pane cannot know which paths moved while it was away, so it
      // re-reads the scene on the same terms the watch would have.
      () => {
        if (!this.editing && !this.pending && !this.drag) void this.loadScene();
      },
    );

    // Rendering a shot is not a write to the scene file, so the frames follow the coarser signal:
    // a frame generated while its scene is open should appear under the prose that ordered it.
    this.watch(
      () => onInvalidate(() => void this.loadTree()),
      () => void this.loadTree(),
    );
    void this.loadTree();

    void this.load();
  }

  /**
   * Swallow the click that dismisses a context menu. path.ux closes a menu on mouse-up, so the
   * `click` that follows reaches the page as an ordinary first one — and this page opens a line
   * editor on the text it lands over. A right-click that retypes the line under it is exactly what
   * a right-click must not do.
   *
   * Pointer-down is the only moment the question can be asked, because the menu is gone by click
   * time. Both listeners are capture-phase on the surface, so one latch covers every row and button
   * under it, and the latch is assigned per pointer-down so a gesture that never clicks cannot arm
   * it.
   */
  private armDismissLatch(): void {
    this.surface.addEventListener(
      'pointerdown',
      () => {
        this.dismissing = menuIsOpen();
      },
      true,
    );
    this.surface.addEventListener(
      'click',
      (event) => {
        if (!this.dismissing) return;
        this.dismissing = false;
        event.stopPropagation();
        event.preventDefault();
      },
      true,
    );
  }

  override update() {
    super.update();

    // Never mid-gesture: the insertion point under the pointer is read from the DOM, so rebuilding
    // the page under a held line would replace the rows the drag is aimed at.
    if (this.drag) return;
    // A scene picked anywhere else in the shell arrives as a changed `ui.sceneId` and nothing
    // else, so the page has to notice it needs different prose.
    if (this.story && this.ui.sceneId && this.ui.sceneId !== this.loading)
      return void this.loadScene();
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  /**
   * What a redraw depends on. Deliberately not the draft or a pending act's props: those change on
   * every keystroke, and `update` runs every frame — a rebuild there would take the caret out of
   * the field being typed into.
   */
  private stateKey(): string {
    const editing =
      this.editing === null
        ? ''
        : this.editing.row === 'line'
          ? `L:${this.editing.line.id}`
          : `N:${this.editing.after}`;
    const pending = this.pending
      ? `${this.pending.act}:${this.pending.act === 'split' ? this.pending.at : ''}`
      : '';
    return [
      this.failure,
      this.revision,
      this.ui.sceneId,
      editing,
      this.attributing ?? '',
      pending,
    ].join('|');
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      this.story = await api.invoke('story:graph');
      // The cue picker offers the project's cast and nothing else, so the column cannot mint a
      // cue no character answers to.
      this.cast = (await api.invoke('workspace:index')).characters.map((c) => ({
        id: c.id,
        name: c.name,
      }));
      const known = this.story.scenes.some((s) => s.id === this.ui.sceneId);
      if (!known) {
        this.ui.sceneId = this.story.start ?? this.story.scenes[0]?.id ?? '';
        this.announce();
      }
      await this.loadScene();
      this.failure = '';
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      this.rebuild();
    }
  }

  /** Re-read the page. Every write path ends here: the chunk was rewritten, so nothing is patched. */
  private async loadScene(): Promise<void> {
    const sceneId = this.ui.sceneId;
    if (!sceneId) return void this.rebuild();
    this.loading = sceneId;
    this.data = await api.invoke('story:coverage', sceneId);
    this.editing = null;
    this.attributing = null;
    this.pending = null;
    this.revision += 1;
    this.rebuild();
  }

  /**
   * Refetch the tree the frames are read out of. A failure is swallowed: the pane's job is the
   * prose, and a backlink panel that could not be built is not news an author can act on
   * mid-sentence.
   */
  private async loadTree(): Promise<void> {
    try {
      this.tree = await api.invoke('workspace:doctree');
    } catch {
      this.tree = undefined;
    }
    this.paintFrames();
  }

  /** The scene now being written, or `null` while a fetch for another one is in flight. */
  private get shown(): SceneCoverage | null {
    // Prose under another scene's heading (for the one frame between the click and the read) is
    // prose the author might start editing.
    return this.data && this.data.sceneId === this.ui.sceneId ? this.data : null;
  }

  // -------------------------------------------------------------------------
  // The bar
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.rebuildBar();
    this.rebuildSurface();
  }

  private rebuildBar(): void {
    this.bar.clear();
    this.bar.label('SCRIPT').style['padding'] = '0px 8px';

    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined.
    const scenes = this.story?.scenes ?? [];
    const menu: MenuTemplate = scenes.map((s) => [
      `${s.id} · ${s.location}`,
      () => this.openScene(s.id),
      undefined,
      undefined,
      `Edit ${s.id}, set in ${s.location}.`,
      s.id,
    ]) as MenuTemplate;
    const picker = this.bar.menu(this.ui.sceneId || 'scene…', menu);
    picker.description = 'Which scene this editor shows. Every pane follows the choice.';
    this.pinToggle(this.bar);

    const shown = this.shown;
    const count = this.bar.label(this.failure || (shown ? `${shown.lines.length} line(s)` : ''));
    count.style['padding'] = '0px 8px';
    count.description = this.failure
      ? 'Why this scene could not be read.'
      : 'How many lines this scene has, headings and blank lines included.';
    const reload = this.bar.button('⟳', () => void this.load());
    reload.description = 'Re-read this scene from disk';
    this.bar.flushUpdate();
  }

  private openScene(sceneId: string): void {
    if (sceneId === this.ui.sceneId) return;
    this.ui.sceneId = sceneId;
    this.notice = null;
    this.announce();
  }

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  private rebuildSurface(): void {
    this.surface.textContent = '';
    this.surface.className = 'script sc-surface';
    this.page = undefined;
    this.dropEl = undefined;

    if (this.failure) {
      this.surface.appendChild(el('div', 'sc-note', this.failure));
      return;
    }
    // A project with no scenes has nothing to open, so it says where a scene comes from.
    if (this.story && this.story.scenes.length === 0) {
      this.surface.className = 'script sc-surface empty';
      this.surface.appendChild(el('p', 'invite', INVITE));
      return;
    }

    // Above the scroll, not inside it: a refusal that scrolled away with the page would be a
    // sentence about an edit the author is still making.
    this.noticeEl = el('div', 'sc-notice');
    this.surface.appendChild(this.noticeEl);
    this.paintNotice();

    const shown = this.shown;
    if (!shown) {
      this.surface.appendChild(el('div', 'sc-note', 'Loading…'));
      return;
    }

    const page = el('div', 'sc-page') as HTMLDivElement;
    this.page = page;
    this.surface.appendChild(page);

    // The heading as the scene's own slugline, so the pane reads as a screenplay page rather than
    // as a list that happens to be in order. It is also where the scene is moved from, because the
    // heading gives the location. The dialog rechecks on every keystroke, so the price of the move
    // is on screen before it is made.
    const heading = el('button', 'sc-heading', shown.heading);
    heading.title =
      'Move this scene somewhere else by rewriting its heading. Its rendered shots are drawn ' +
      'again — the dialog says how many — and the prose is left describing the old place.';
    heading.addEventListener('click', () =>
      openCommandDialog('story.setHeading', { scene: shown.sceneId, heading: shown.heading }),
    );
    page.appendChild(heading);

    if (shown.lines.length === 0 && this.editing === null) {
      const start = el(
        'button',
        'sc-start',
        `${shown.sceneId} has no lines yet — write the first one.`,
      );
      start.title = 'Open a box and write the first line of this scene';
      start.addEventListener('click', () => this.compose(''));
      page.appendChild(start);
    }

    const cuts = new Set(splitBoundaries(shown.lines));
    for (const row of scriptRows(shown.lines, this.editing)) {
      if ('compose' in row) {
        // `scriptRows` emits a composer only for the open `new` row, so `this.editing` is the row
        // it describes. It is passed by identity, which is how a late `check` knows it is current.
        if (this.editing?.row !== 'new') continue;
        const box = el('div', 'sc-line new');
        const plus = el('span', 'lid', '+');
        plus.title = 'A line that does not exist yet — it is written when you press Enter';
        box.appendChild(plus);
        const body = el('div', 'sc-body');
        // The row states who it will be attributed to before it exists. Nothing here can change
        // that (`setSpeaker` needs a line), but a composer that said nothing is how an author ends
        // up with a scene of narration wondering where the speaker went.
        const after = this.editing.after;
        const cue = composedCueText(this.cast, shown.lines.find((l) => l.id === after) ?? null);
        const hint = el('span', 'who hint', cue.label);
        hint.title = cue.title;
        body.appendChild(hint);
        body.appendChild(this.lineEditor(this.editing, 'Write a new line'));
        box.appendChild(body);
        page.appendChild(box);
        continue;
      }
      page.appendChild(this.lineRow(shown, row.line, row.at, cuts.has(row.line.id)));
      if (this.pending?.act === 'split' && this.pending.at === row.line.id) {
        page.appendChild(this.strip(shown, this.pending));
      }
    }

    page.appendChild(this.structure(shown));
    if (this.pending && this.pending.act !== 'split') {
      page.appendChild(this.strip(shown, this.pending));
    }

    // Below the page rather than inside it: the frames are about the whole scene, and art that
    // scrolled away with the prose would be gone exactly when a long scene needs it most.
    this.surface.appendChild(this.frames);
    this.paintFrames();
  }

  /**
   * What has been drawn from the open scene, gathered by the shot each frame illustrates. The
   * backlink key is the scene's own id — `pathIndex` is for a pane that holds a path, and this one
   * holds a scene.
   */
  private paintFrames(): void {
    // A surface showing a failure, a loading note or the invite has no page to hang art under, and
    // `rebuildSurface` is what puts the row back when there is one again.
    if (this.frames.parentNode !== this.surface) return;
    const links = this.tree?.backlinks[`scene:${this.ui.sceneId}`];
    renderAssetStrip(this.frames, links ? shotGroups(links, this.ui.sceneId) : [], EMPTY, {
      onPick: (hash) => this.openAsset(hash),
    });
  }

  /** Pick a frame: the shell's selection moves to it, and the routing rule says where it opens. */
  private openAsset(hash: string): void {
    this.ui.assetHash = hash;
    this.announce();
    openNode(this.ctx?.screen as VnScreen | undefined, assetNode(hash));
  }

  private lineRow(scene: SceneCoverage, line: CoverageLine, at: number, cut: boolean): HTMLElement {
    const box = el('div', `sc-line ${line.kind}`);
    box.dataset['line'] = line.id;
    box.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void showContextMenu(
        this.ctx as VnContext,
        event.clientX,
        event.clientY,
        line.id,
        lineMenu(scene, line.id),
      );
    });

    // The gutter numbers the page the way an author reads it back, counting from the heading. The
    // stable id is in the tooltip instead: it is what a refusal names, but it stops matching the
    // count as soon as a line is inserted, so it cannot be the number on screen.
    const lid = el('span', 'lid', String(at));
    lid.title = `Line ${at} of this scene, ${line.id} — drag this handle to move it`;
    lid.addEventListener('pointerdown', (event) => this.grab(scene, line, event));
    box.appendChild(lid);

    const body = el('div', 'sc-body');
    const cue = this.cueSlot(line);
    if (cue) body.appendChild(cue);

    const editing = this.editing;
    if (editing?.row === 'line' && editing.line.id === line.id) {
      body.appendChild(this.lineEditor(editing, `Retype ${line.id}`));
    } else {
      const text = el('div', 'text', line.text);
      text.title = 'Click to retype this line';
      text.addEventListener('click', () => this.openLine(line));
      body.appendChild(text);
    }
    box.appendChild(body);

    // A boundary is a property of the row below it, so the button sits on the row rather than
    // between rows, marking where the second half starts.
    if (cut && this.pending === null) {
      const split = el('button', 'sc-cut', 'split here');
      split.title = 'Start a second scene at this line, and name it before anything is written';
      split.addEventListener('click', () =>
        this.propose({
          act: 'split',
          at: line.id,
          into: proposeSceneId(
            scene.sceneId,
            (this.story?.scenes ?? []).map((s) => s.id),
          ),
        }),
      );
      box.appendChild(split);
    }
    return box;
  }

  /**
   * A line's cue slot: what it says now, and the picker it opens. Only the kinds `setSpeaker` acts
   * on get one — its own predicate answers that, so a row can't offer an edit it would refuse.
   */
  private cueSlot(line: CoverageLine): HTMLElement | null {
    if (!isSpeakable(line.kind)) return null;

    if (this.attributing !== line.id) {
      const button = el('button', `who${line.speaker ? '' : ' none'}`);
      const { label, title } = cueSlotText(this.cast, line.speaker);
      button.textContent = label;
      button.title = title;
      button.addEventListener('click', () => {
        this.attributing = line.id;
        this.notice = null;
        this.rebuild();
      });
      return button;
    }

    const choices = cueChoices(this.cast, line.speaker);
    const select = document.createElement('select');
    select.className = 'who picking';
    select.setAttribute('aria-label', `Who says ${line.id}`);
    select.title = 'Who says this line — picking nobody makes it narration';
    for (const [i, choice] of choices.entries()) {
      const option = document.createElement('option');
      option.value = choice.cue;
      option.textContent = choice.label;
      option.title = choice.cue
        ? `Attribute the line to ${choice.label}`
        : 'Nobody: leave it as narration';
      // Two cast members can share a cue, so the option is addressed by its position.
      option.dataset['at'] = String(i);
      select.appendChild(option);
    }
    select.value = choices.find((c) => c.current)?.cue ?? '';
    select.addEventListener('change', () => this.attribute(line, select.value, choices));
    select.addEventListener('blur', () => this.closePicker());
    select.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') this.closePicker();
    });
    queueMicrotask(() => select.focus());
    return select;
  }

  /**
   * The open row. The sizer's `::after` echoes the draft, so the row grows as you type without
   * anything being measured — no frame exists where the layout disagrees with the caret.
   */
  private lineEditor(row: Editing, label: string): HTMLElement {
    const sizer = el('div', 'text sc-grow');
    sizer.dataset['value'] = this.draft;

    const input = document.createElement('textarea');
    input.value = this.draft;
    input.spellcheck = true;
    input.setAttribute('aria-label', label);
    input.title = `${label} — Enter writes it, Escape leaves the line alone`;
    // Without a placeholder an empty composer is an empty row, and nothing on screen says a line
    // is being written.
    if (row.row === 'new') input.placeholder = 'Write the line, then Enter';
    input.addEventListener('input', () => {
      this.draft = input.value;
      sizer.dataset['value'] = this.draft;
      this.scheduleCheck(row);
    });
    input.addEventListener('keydown', (event) => {
      // The shell's keymap is a window listener in the bubble phase and path.ux's own textbox
      // guard only knows its own widgets, so an open row has to stop the event itself.
      event.stopPropagation();
      const scene = this.shown;
      if (!scene) return;
      const outcome = keyAct(
        scene,
        row,
        { text: this.draft, start: input.selectionStart, end: input.selectionEnd },
        event.key,
      );
      if (outcome.act === 'type') return;
      event.preventDefault();
      this.settled = true;
      if (outcome.act === 'discard') {
        this.editing = null;
        this.notice = null;
        this.rebuild();
        return;
      }
      void this.act(row, outcome.steps, outcome.then);
    });
    input.addEventListener('blur', () => {
      if (this.settled) return;
      this.commit(row);
    });

    sizer.appendChild(input);
    queueMicrotask(() => input.focus());
    return sizer;
  }

  /** Everything that adds to the scene: a line, and the two acts that change where it ends. */
  private structure(scene: SceneCoverage): HTMLElement {
    const box = el('div', 'sc-struct');
    const scenes = this.story?.scenes ?? [];

    if (scene.lines.length > 0) {
      const add = el('button', 'sc-add', '+ line');
      add.title = 'Write another line at the end of this scene';
      const last = scene.lines[scene.lines.length - 1]?.id ?? '';
      add.addEventListener('click', () => this.compose(last));
      box.appendChild(add);
    }

    // Each of these is its command's own rule read ahead of time — the pane doesn't put a button
    // where the command would only refuse.
    const absorb = this.story ? mergeTarget(this.story, scene.sceneId) : null;
    if (absorb) {
      const merge = el('button', 'sc-add', `merge ${absorb} in`);
      merge.title = `Take ${absorb}'s lines into this scene and delete its file`;
      merge.addEventListener('click', () => this.propose({ act: 'merge', absorbed: absorb }));
      box.appendChild(merge);
    }

    if (this.story && canContinue(this.story, scene.sceneId)) {
      const cont = el('button', 'sc-add', '+ scene after this one');
      cont.title = 'Write a new scene and make this one continue into it';
      cont.addEventListener('click', () =>
        this.propose(
          continueFrom(
            scene.sceneId,
            scene.location,
            scenes.map((s) => s.id),
          ),
        ),
      );
      box.appendChild(cont);
    }
    return box;
  }

  /**
   * The pending act's strip: what it would do, the props still being chosen, and the two gestures
   * that end it. Its sentence is in the notice, beside everything else a command has said.
   */
  private strip(scene: SceneCoverage, pending: Pending): HTMLElement {
    const box = el('div', `sc-pend ${pending.act}`);
    const keys = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.confirm();
      if (event.key === 'Escape') this.cancel();
    };
    // The strip's own props: typed into without a rebuild, so the field keeps the caret. `stateKey`
    // deliberately does not read them.
    const prop = (label: string, value: string, wide: boolean, set: (v: string) => void) => {
      const input = document.createElement('input');
      input.className = `sc-prop${wide ? ' wide' : ''}`;
      input.setAttribute('aria-label', label);
      input.title = `${label}. Enter confirms the act, Escape abandons it.`;
      input.value = value;
      input.addEventListener('input', () => {
        set(input.value);
        this.scheduleActCheck();
      });
      input.addEventListener('keydown', keys);
      box.appendChild(input);
      return input;
    };

    let focus: HTMLElement | undefined;
    if (pending.act === 'split') {
      box.appendChild(
        el('span', 'what', `Split at ${localLineId(pending.at)} — that line and the rest become`),
      );
      focus = prop("The new scene's id", pending.into, false, (v) => (pending.into = v));
    } else if (pending.act === 'merge') {
      box.appendChild(
        el(
          'span',
          'what',
          `Absorb ${pending.absorbed} into ${scene.sceneId} — its lines are renumbered`,
        ),
      );
    } else {
      box.appendChild(el('span', 'what', `New scene, continued to from ${scene.sceneId}:`));
      focus = prop("The new scene's id", pending.scene, false, (v) => (pending.scene = v));
      prop("The new scene's heading", pending.heading, true, (v) => (pending.heading = v));
    }

    const go = el(
      'button',
      'go',
      pending.act === 'split' ? 'Split' : pending.act === 'merge' ? 'Merge' : 'Write it',
    );
    go.title =
      pending.act === 'split'
        ? 'Cut the scene here and write the tail as its own file'
        : pending.act === 'merge'
          ? 'Fold that scene into this one and delete the file it came from'
          : 'Write the new scene and point this one at it';
    go.addEventListener('click', () => void this.confirm());
    box.appendChild(go);

    const no = el('button', 'no', 'Cancel');
    no.title = 'Abandon this act. Nothing is written.';
    no.addEventListener('click', () => this.cancel());
    box.appendChild(no);

    if (focus) queueMicrotask(() => focus.focus());
    return box;
  }

  // -------------------------------------------------------------------------
  // Moving a line
  // -------------------------------------------------------------------------

  /**
   * Pick a line up by its gutter. Every insertion point is judged at the grab, because re-asking
   * per pointer move could reverse the verdict for a drop the author is already over.
   */
  private grab(scene: SceneCoverage, line: CoverageLine, event: PointerEvent): void {
    // The gutter is inside a row that opens a menu, and a right-click there must not also pick the
    // line up — a drag that never sees a matching `pointerup` would hold the page open forever.
    if (event.button !== 0) return;
    // Keeps the gesture from also being a text selection or a focus change.
    event.preventDefault();
    this.settled = true;
    this.editing = null;
    this.attributing = null;
    this.notice = null;
    this.rebuild();

    this.drag = grabLine(scene, line.id);
    this.page?.classList.add('dragging');
    const carried = this.page?.querySelector(`[data-line="${line.id}"]`);
    carried?.classList.add('carried');

    // Window-level, so a drag that leaves the pane still tracks and still releases.
    const onMove = (move: PointerEvent): void => {
      if (!this.drag) return;
      this.drag = aim(this.drag, dropTarget(this.rowBoxes(), move.clientY));
      this.say(noticeOf(this.drag));
      this.paintDrop();
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const pending = this.drag;
      this.drag = null;
      this.page?.classList.remove('dragging');
      carried?.classList.remove('carried');
      this.dropEl?.remove();
      this.dropEl = undefined;
      // A drop with no verdict clears the notice. A refused drop keeps the reason it was given.
      if (!pending?.verdict) return this.say(null);
      const invoke = dropOf(pending);
      if (invoke) void this.act(null, [invoke], { open: 'none' });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /**
   * The rendered rows, measured. The only DOM read the drag does — `dropTarget` decides which
   * insertion point they mean, and it is tested in node against boxes like these.
   */
  private rowBoxes(): RowBox[] {
    const rows = this.page?.querySelectorAll<HTMLElement>('[data-line]') ?? [];
    return [...rows].map((node) => {
      const box = node.getBoundingClientRect();
      return { id: node.dataset['line'] ?? '', top: box.top, bottom: box.bottom };
    });
  }

  /** The insertion rule, drawn where the drop would land. Refused drops are drawn too. */
  private paintDrop(): void {
    this.dropEl?.remove();
    this.dropEl = undefined;
    const drag = this.drag;
    if (!drag?.verdict || !this.page) return;

    const rule = el('div', `sc-drop ${drag.verdict.accept ? 'accept' : 'refuse'}`);
    const after =
      drag.over === TOP ? null : this.page.querySelector(`[data-line="${drag.over ?? ''}"]`);
    if (after) after.insertAdjacentElement('afterend', rule);
    else this.page.querySelector('.sc-heading')?.insertAdjacentElement('afterend', rule);
    this.dropEl = rule;
  }

  // -------------------------------------------------------------------------
  // Writes — every one of them a command, and every one of them re-reads the page
  // -------------------------------------------------------------------------

  private openLine(line: CoverageLine): void {
    this.notice = null;
    this.open({ editing: { row: 'line', line }, draft: line.text });
  }

  private compose(after: string): void {
    this.notice = null;
    this.open({ editing: { row: 'new', after }, draft: '' });
  }

  /**
   * Open a row. It deliberately does not clear the notice: the continuation an act opens carries
   * on from that act, and what the command said about it is still the last thing that happened.
   * A row the author opens is a new act, so `openLine`/`compose` clear it themselves.
   */
  private open(row: { editing: Editing; draft: string }): void {
    this.settled = false;
    this.editing = row.editing;
    this.draft = row.draft;
    this.rebuild();
  }

  /**
   * Ask the command's own `check` as the author types. The count of frames that will go on
   * illustrating the old prose comes from that check, so the warning before the commit and the
   * message after it are one sentence rather than two guesses.
   */
  private scheduleCheck(row: Editing): void {
    clearTimeout(this.checkTimer);
    const invocation = this.invocationFor(row);
    // A preview describes a draft that no longer says anything; an ok/refused sentence describes
    // something that happened, and it stays until the next act.
    if (!invocation) {
      if (this.notice?.tone === 'preview') this.say(null);
      return;
    }
    this.checkTimer = setTimeout(() => {
      void api.invoke('command:check', invocation).then((check) => {
        if (this.editing === row) this.say(noticeForCheck(check));
      });
    }, 180);
  }

  /** `scheduleCheck` for a structural act: the shots that detach are named before it runs. */
  private scheduleActCheck(): void {
    clearTimeout(this.checkTimer);
    const pending = this.pending;
    const scene = this.ui.sceneId;
    if (!pending || !scene) return;
    this.checkTimer = setTimeout(() => {
      void api.invoke('command:check', checkOf(pending, scene)).then((check) => {
        if (this.pending === pending) this.say(noticeForCheck(check));
      });
    }, 180);
  }

  private invocationFor(row: Editing): Invocation | null {
    const scene = this.shown;
    if (!scene) return null;
    return row.row === 'line'
      ? commitOf(row.line, this.draft)
      : insertOf(scene, row.after, this.draft);
  }

  private commit(row: Editing): void {
    const invocation = this.invocationFor(row);
    // A click in and a click away is not an authorial act: no record, no undo point, no notice.
    if (!invocation) {
      this.editing = null;
      if (this.notice?.tone === 'preview') this.notice = null;
      this.rebuild();
      return;
    }
    void this.act(row, [invocation], { open: 'none' });
  }

  /**
   * Run an act: its commands in order, stopping at the first refusal, then re-read the scene and
   * put the editor where the act said it goes. A refusal reopens the row the author was in, so the
   * draft comes back beside the command's own reason for turning it down — `from` is `null` for an
   * act no editor started, like a drop, which has no draft to hand back.
   */
  private async act(from: Editing | null, steps: Invocation[], then: Continue): Promise<boolean> {
    this.editing = null;
    let ran = false;
    for (const step of steps) {
      const outcome = await api.invoke('command:exec', { ...step, source: 'ui' });
      if (!outcome.ok) {
        this.notice = { tone: 'refused', text: outcome.error };
        if (from) {
          this.settled = false;
          this.editing = from;
        }
        this.rebuild();
        return false;
      }
      this.notice = { tone: 'ok', text: outcome.record.message ?? 'Done.' };
      // Every `story.*` command answers with the rebuilt graph, so the scene list and the
      // structural affordances are never a beat behind a split that added a scene.
      if (outcome.data) this.story = outcome.data as StoryGraph;
      ran = true;
    }

    // Re-read rather than patch: the chunk was rewritten and a shots file may have been too, so
    // what comes back is what the loader says.
    let lines = this.shown?.lines ?? [];
    if (ran && this.ui.sceneId) {
      await this.loadScene();
      lines = this.shown?.lines ?? [];
      void refreshWorkspace();
    }
    const next = nextEditing(lines, from, then);
    if (next) this.open(next);
    else this.rebuild();
    return ran;
  }

  /**
   * Pick who says a line. `story.setSpeaker` is the one edit here that changes a line's `kind` —
   * and with it the beat type the exporter writes — which is why it is a deliberate choice off a
   * closed list rather than a field to type a name into.
   */
  private attribute(line: CoverageLine, cue: string, choices: CueChoice[]): void {
    this.attributing = null;
    // Re-picking the cue the line already carries is not an authorial act: no record, no undo
    // point. It is also the only way to leave a narration line alone, which `setSpeaker` refuses.
    if (choices.find((c) => c.current)?.cue === cue) return void this.rebuild();
    void this.act(null, [setSpeakerOf(line.id, cue)], { open: 'none' });
  }

  private closePicker(): void {
    if (this.attributing === null) return;
    this.attributing = null;
    this.rebuild();
  }

  /**
   * Ask for a structural act. Nothing is written: the strip opens with the command's own account
   * of what it would cost, and the author confirms or cancels.
   */
  private propose(next: Pending): void {
    this.editing = null;
    this.attributing = null;
    this.notice = null;
    this.pending = next;
    this.rebuild();
    this.scheduleActCheck();
  }

  private cancel(): void {
    this.pending = null;
    this.notice = null;
    this.rebuild();
  }

  /** Commit the pending act. */
  private async confirm(): Promise<void> {
    const asked = this.pending;
    const scene = this.ui.sceneId;
    if (!asked || !scene) return;
    this.pending = null;
    const ran = await this.act(null, stepsOf(asked, scene), { open: 'none' });
    // The scene the author asked for is the one they meant to write in, so the pane follows it.
    if (ran && asked.act === 'scene') this.openScene(asked.scene);
  }

  private say(notice: Notice | null): void {
    this.notice = notice;
    this.paintNotice();
  }

  private paintNotice(): void {
    if (!this.noticeEl) return;
    this.noticeEl.className = `sc-notice${this.notice ? ` ${this.notice.tone}` : ''}`;
    this.noticeEl.textContent = this.notice?.text ?? '';
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(ScriptEditor, 'vn.ScriptEditor');

import type { Container, MenuTemplate } from 'pathux';
import { api } from '../../api.js';
import { spansFor, type Edge } from '@vn/scriptedit';
import type { Coverage, ShotSpan } from '../../../src/shared/ipc.js';
import { commitOf, noticeForCheck, type Notice } from '../../../src/shared/lineedit.js';
import {
  BUSY_DELAY_MS,
  SETTLED,
  WRITE_PENDING,
  beginWrite,
  busyLabel,
  revealBusy,
  type Busy,
} from '../../rules/timeline/busy.js';
import { insertionRow, previewOf } from '../../rules/timeline/coverage.js';
import { driftTag, staleCount } from '../../rules/timeline/drift.js';
import { canEdit, canGrab, grabRefusal } from '../../rules/timeline/editing.js';
import {
  INHERIT,
  outfitInvocation,
  outfitRows,
  shadowedMarker,
  sourceLabel,
  type OutfitRow,
} from '../../rules/timeline/wardrobe.js';
import type { VnContext } from '../context.js';
import { openCommandDialog } from '../dialog.js';
import { VnEditor, registerEditor } from '../editor.js';
import { showContextMenu } from '../showmenu.js';
import {
  aimCreate,
  aimDrag,
  aimReorder,
  grabEdge,
  grabGutter,
  grabShot,
  noticeOf,
  type Create,
  type Drag,
  type Reorder,
} from '../timeline.js';
import STRIP_CSS from '../../styles/timeline.css?inline';
import type { Invocation } from '@vn/commands';
import type { CoverageLine, SceneCoverage, StoryGraph } from '../../../src/shared/ipc.js';

/**
 * The frame around `timeline.css`, which is imported as-is because the React strip's sheet is kept
 * as a single copy. Covers what the room supplied and the pane does not: the reset that does not
 * cross the shadow boundary, and the notice, which was a member of FLOOR's bar and here is a strip
 * above the script (a path.ux label cannot carry the tone colours).
 */
const SURFACE_CSS = `
* { box-sizing: border-box; }
.tl-surface {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ink);
  color: var(--paper);
}
.tl-surface > .tl-notice {
  flex: none;
  margin-left: 0;
  padding: 7px 22px;
  min-height: 27px;
  border-bottom: 1px solid var(--ink-line);
  background: var(--ink-sunken);
}
.tl-surface > .tl-body { flex: 1 1 auto; }
/* A write in flight: the notice row becomes an indeterminate bar carrying the command's name. */
.tl-surface > .tl-notice.busy { position: relative; overflow: hidden; }
.tl-surface > .tl-notice.busy::after {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 28%;
  background: var(--ink-line);
  opacity: 0.55;
  animation: tl-busy 1.1s linear infinite;
}
@keyframes tl-busy {
  from { transform: translateX(-100%); }
  to { transform: translateX(460%); }
}
/* The gutter cell: its own element at the row's left edge, so its pointerdown is never a
   click-to-edit's — no two gestures share a pointerdown. */
.tl-grid .tl-line { position: relative; }
.tl-grid .tl-gutter {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 9px;
  cursor: ns-resize;
  touch-action: none;
}
.tl-grid .tl-gutter:hover { background: var(--ink-line); }
/* The two doors out of an undecomposed scene. */
.tl-note .tl-doors { display: inline-flex; gap: 8px; margin-left: 10px; vertical-align: middle; }
.tl-note .tl-door {
  background: var(--ink-sunken);
  color: var(--paper);
  border: 1px solid var(--ink-line);
  border-radius: 3px;
  padding: 2px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.tl-note .tl-door:disabled { opacity: 0.5; cursor: default; }
`;

/**
 * The coverage strip: a scene's screenplay down the page, and the shots that illustrate it as
 * brackets beside it. The port of FLOOR's `Timeline`, the first editor here with semantic drags,
 * and so the one that proves the pane world's two gesture rulings.
 *
 * All four pure halves are imported, not rewritten: `coverage.ts` for the ghost geometry,
 * `drift.ts` for the wording, `editing.ts` for which gesture may start, `wardrobe.ts` for the
 * outfit rows. The gesture state machine is `pathux/timeline.ts`, which is the one piece the
 * React version left untested inside its `.tsx`.
 *
 * Two things change in the port, both because the shell has them and the room did not. The scene
 * being read and the shot being inspected are the shared `ui.sceneId`/`ui.shotId`, so a shot
 * picked in the task graph opens its scene here. The surface carries a real stylesheet rather
 * than inline style, because the auto-growing line editor is a `::after` pseudo-element and the
 * drag handles are `:hover` states, and neither has an inline form.
 */
export class TimelineEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;
  private body!: HTMLDivElement;

  private story: StoryGraph | undefined;
  private data: SceneCoverage | undefined;
  private coverage: Coverage = spansFor([], []);
  private failure = '';
  private drawn = '';
  /** The scene `data` holds or is being fetched for. Not `data.sceneId`, which lags a fetch. */
  private loading = '';
  /** Bumped on every load, so a reload redraws even when nothing about the selection moved. */
  private revision = 0;

  private drag: Drag | null = null;
  private reorder: Reorder | null = null;
  private create: Create | null = null;
  private notice: Notice | null = null;

  /** The write in flight, if any (`busy.ts`). The timer reveals the bar after `BUSY_DELAY_MS`. */
  private busy: Busy = SETTLED;
  private busyTimer: ReturnType<typeof setTimeout> | undefined;

  /** The line id whose editor is open, and the text in it. */
  private editing: string | null = null;
  private draft = '';
  // Enter and Escape finish the edit themselves rather than calling `blur()`, which does nothing
  // when the textarea is not the active element. Blur is therefore the click-away path only, and
  // this flag marks the edit settled so a late blur leaves it alone
  private settled = false;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;

  /** The overlay nodes, held so a pointer move repaints them without rebuilding the strip. */
  private grid: HTMLDivElement | undefined;
  private bands = new Map<number, HTMLElement>();
  private overlay: HTMLElement[] = [];
  private noticeEl: HTMLElement | undefined;

  static override define() {
    return {
      tagname: 'vn-timeline-editor-x',
      areaname: 'timeline',
      uiname: 'Coverage',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.adoptStyle(STRIP_CSS + SURFACE_CSS);
    this.surface = document.createElement('div');
    this.surface.className = 'tl-surface';
    this.appendSurface(this.surface);

    void this.load();
  }

  override update() {
    super.update();

    // Never mid-gesture: the row under the pointer is read from the DOM, so rebuilding the strip
    // under a held handle would replace the nodes the drag is aimed at. A selection changed by
    // the drop itself is picked up on release, when the strip reloads anyway.
    if (this.drag || this.reorder || this.create) return;
    // A scene picked elsewhere in the shell (a shot clicked in the task list, a branch followed in
    // STUDIO) arrives as a changed `ui.sceneId` and nothing else, so the strip has to refetch.
    // Redrawing on that alone would draw the old scene's coverage under the new scene's name.
    if (this.story && this.ui.sceneId && this.ui.sceneId !== this.loading)
      return void this.loadScene();
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  private stateKey(): string {
    const ui = this.ui;
    return [this.failure, this.revision, ui.sceneId, ui.shotId, this.editing ?? ''].join('|');
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      this.story = await api.invoke('story:graph');
      // The shell's scene, not one of this editor's own: a shot picked anywhere else opens here.
      // A remembered id the graph no longer has falls back rather than showing an empty strip.
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

  /** Re-read the strip. Every write path ends here: a chunk was rewritten, so nothing is patched. */
  private async loadScene(): Promise<void> {
    const sceneId = this.ui.sceneId;
    if (!sceneId) return;
    this.loading = sceneId;
    this.data = await api.invoke('story:coverage', sceneId);
    this.coverage = spansFor(this.data.lines, this.data.shots);
    this.editing = null;
    this.revision += 1;
    this.rebuild();
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
    this.bar.label('COVERAGE').style['padding'] = '0px 8px';

    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined.
    const scenes = this.story?.scenes ?? [];
    const menu: MenuTemplate = scenes.map((s) => [
      `${s.id} · ${s.location}`,
      () => this.openScene(s.id),
      undefined,
      undefined,
      `Show the shot coverage of ${s.id}, set in ${s.location}.`,
      s.id,
    ]) as MenuTemplate;
    const picker = this.bar.menu(this.ui.sceneId || 'scene…', menu);
    picker.description = 'Which scene this timeline covers. Every pane follows the choice.';
    this.pinToggle(this.bar);

    const summary = this.bar.label(this.summary());
    summary.style['padding'] = '0px 8px';
    summary.description =
      'Shots in this scene, lines no shot covers, and shots drawn from prose that has since changed.';
    // A door into `story.newShot` for a scene with no gaps: the gutter drag needs a row to sweep,
    // and a scene whose every line is covered still takes a hand-placed shot, which claims its
    // lines off the shots that hold them.
    const add = this.bar.button('+ shot', () =>
      openCommandDialog('story.newShot', { scene: this.ui.sceneId }),
    );
    add.description =
      'Place a shot by hand over lines you name — a new frame to render. Opens the command, priced before it runs.';
    const refresh = this.bar.button('Refresh', () => void this.load());
    refresh.description = 'Re-read the shots and their images from disk.';
    this.bar.flushUpdate();
  }

  private summary(): string {
    if (this.failure) return this.failure;
    // An undecomposed scene has no shots and therefore no uncovered lines worth counting — every
    // line is uncovered, which is a pre-run state and not a gap.
    if (this.data && !this.data.decomposed) return 'no shots yet';
    const cov = this.coverage;
    const stale = staleCount(this.data?.shots ?? []);
    return (
      `${cov.spans.length} shot(s) · ${cov.gaps.length} uncovered` +
      (cov.overlaps.length ? ` · ${cov.overlaps.length} overlapping` : '') +
      (stale ? ` · ${stale} on old prose` : '')
    );
  }

  /** Publishes the scene and nothing more; `update` does the reading, however it changed. */
  private openScene(sceneId: string): void {
    if (sceneId === this.ui.sceneId) return;
    this.ui.sceneId = sceneId;
    this.notice = null;
    this.announce();
  }

  // -------------------------------------------------------------------------
  // The strip
  // -------------------------------------------------------------------------

  private rebuildSurface(): void {
    this.surface.textContent = '';
    this.bands.clear();
    this.overlay = [];
    this.grid = undefined;

    // Above the scroll, not inside it: a refusal that scrolled away with the script would be a
    // sentence about a gesture the author is still making.
    this.noticeEl = el('div', 'tl-notice');
    this.surface.appendChild(this.noticeEl);
    this.paintNotice();

    this.body = el('div', 'tl-body') as HTMLDivElement;
    this.surface.appendChild(this.body);

    if (this.failure) return void this.body.appendChild(el('div', 'tl-note', this.failure));
    if (!this.data) return void this.body.appendChild(el('div', 'tl-empty', 'Loading…'));

    // An undecomposed scene still renders its script, with no bracket columns: correcting a line
    // is what an author wants to do before paying for art.
    if (!this.data.decomposed) {
      this.body.appendChild(this.undecomposedNote(this.data));
    }

    this.grid = this.buildGrid(this.data);
    this.body.appendChild(this.grid);
    this.body.appendChild(this.wardrobe(this.data));

    if (this.coverage.orphans.length > 0) {
      const box = el('div', 'tl-orphans');
      box.appendChild(el('span', 'tt', 'COVERS NOTHING'));
      // Real, paid-for shots the runner will never display, because they cover no line
      for (const s of this.coverage.orphans) box.appendChild(el('span', 'orph', s.id));
      this.body.appendChild(box);
    }
  }

  /**
   * The undecomposed scene's note, with the two doors out of it: decompose (the model reads the
   * scene and storyboards it) or place the first shot by hand (which ends decomposition for this
   * scene). Both are invocations, checked before they are drawn — a door that would be refused is
   * disabled with the refusal as its tooltip, never hidden. Both open the command dialog rather
   * than running: one is `confirm: true`, and the other has a field the author is here to fill in.
   */
  private undecomposedNote(data: SceneCoverage): HTMLElement {
    const note = el(
      'div',
      'tl-note',
      `${data.sceneId} has no shots yet — decompose it, or place the first shot by hand. `,
    );
    const doors = el('span', 'tl-doors');
    note.appendChild(doors);
    // The same prefill the dialog opens with, so the check's verdict is the verdict of this door.
    const byHand = { scene: data.sceneId, lines: data.lines[0]?.id ?? '' };
    doors.appendChild(
      this.door(
        'decompose',
        'story.decomposeAll',
        {},
        'Ask the writing model to storyboard every scene that has none — one model call per scene, priced in the dialog before it runs.',
      ),
    );
    doors.appendChild(
      this.door(
        'place a shot by hand',
        'story.newShot',
        byHand,
        `Create the storyboard for ${data.sceneId} yourself, one shot at a time — which ends decomposition for this scene.`,
      ),
    );
    return note;
  }

  /** One door: a button over one command, checked before it is drawn. */
  private door(
    label: string,
    id: string,
    props: Record<string, string>,
    does: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'tl-door';
    button.textContent = label;
    button.disabled = true;
    button.title = does;
    void api.invoke('command:check', { id, props }).then((check) => {
      if (check.state === 'refuse') {
        // A disabled control's tooltip is its refusal — the door stays visible and says why.
        button.title = check.message;
        return;
      }
      button.disabled = false;
      button.addEventListener('click', () => openCommandDialog(id, props));
    });
    return button;
  }

  private buildGrid(data: SceneCoverage): HTMLDivElement {
    const cov = this.coverage;
    const grid = el('div', 'tl-grid') as HTMLDivElement;
    grid.style.gridTemplateColumns = `minmax(0, 1.3fr)${
      cov.lanes ? ` repeat(${cov.lanes}, minmax(130px, 0.6fr))` : ''
    }`;

    // A full-width hit band per row, behind everything: a drag lives in the bracket columns, so
    // the pointer is rarely over the script when it needs a row. It also carries the preview
    // tint, since a released row keeps its bracket until release.
    for (const row of cov.rows) {
      const band = el('div', 'tl-band');
      band.dataset['lineIndex'] = String(row.index);
      band.style.gridColumn = '1 / -1';
      band.style.gridRow = String(row.index + 1);
      this.bands.set(row.index, band);
      grid.appendChild(band);
    }

    for (const row of cov.rows) grid.appendChild(this.lineRow(data, row.line, row));
    for (const span of cov.spans) {
      span.segments.forEach((segment, i) => {
        grid.appendChild(
          this.bracket(span, segment, i === 0, i === span.segments.length - 1, span.shot.id),
        );
      });
    }
    return grid;
  }

  private lineRow(
    data: SceneCoverage,
    line: CoverageLine,
    row: { index: number; shots: readonly unknown[] },
  ): HTMLElement {
    // A gap means "this line renders with no image"; before a decomposition exists that is true
    // of every line and says nothing, so the gutter waits for shots.
    const gap = data.decomposed && row.shots.length === 0 ? ' gap' : '';
    const over = row.shots.length > 1 ? ' over' : '';
    const box = el('div', `tl-line ${line.kind}${gap}${over}`);
    box.style.gridColumn = '1';
    box.style.gridRow = String(row.index + 1);

    // The creation gesture's grab, as its own element: the prose cell keeps click-to-edit, so no
    // two gestures share a pointerdown. Dragging along it sweeps lines into a new shot.
    const gutter = el('div', 'tl-gutter');
    gutter.title =
      'Drag along this edge to sweep lines into a new shot — a new frame to render, priced as you drag.';
    gutter.addEventListener('pointerdown', (event) => {
      // Prevented for the same reason the drag handles prevent theirs: the gutter must never take
      // focus off an open editor, so a blocked grab is refused aloud rather than committing a
      // half-typed line.
      event.preventDefault();
      event.stopPropagation();
      if (!canGrab(this.mode())) return this.say(grabRefusal(this.mode()));
      this.beginCreate(line.id);
    });
    box.appendChild(gutter);

    // Not editable here: changing who says a line changes its kind, hence this row's shape and
    // the exporter's beat type. `story.setSpeaker` is STUDIO's.
    if (line.speaker) box.appendChild(el('div', 'who', line.speaker));

    if (this.editing === line.id) box.appendChild(this.lineEditor(line));
    else {
      const text = el('div', 'text', line.text);
      text.title = 'Click to retype this line';
      text.addEventListener('click', () => this.openEditor(line));
      box.appendChild(text);
    }
    return box;
  }

  /**
   * The open row. The sizer carries the draft as `content`, so the row grows as you type and the
   * brackets follow — they are placed by grid row, not by measured pixels.
   */
  private lineEditor(line: CoverageLine): HTMLElement {
    const sizer = el('div', 'text tl-grow');
    sizer.dataset['value'] = this.draft;

    const input = document.createElement('textarea');
    input.value = this.draft;
    input.spellcheck = true;
    input.setAttribute('aria-label', `Retype ${line.id}`);
    input.title = `Retype ${line.id} — Enter writes it, Escape leaves the line alone`;
    input.addEventListener('input', () => {
      this.draft = input.value;
      sizer.dataset['value'] = this.draft;
      this.scheduleCheck(line);
    });
    input.addEventListener('keydown', (event) => {
      // The shell's keymap is a window listener in the bubble phase and path.ux's own textbox
      // guard only knows its own widgets, so an open row has to stop the event itself — without
      // this, `/` opens the palette in the middle of a sentence.
      event.stopPropagation();
      // A line is a string, so Enter has nothing to insert — it finishes.
      if (event.key === 'Enter') {
        event.preventDefault();
        this.settled = true;
        void this.commit(line);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.settled = true;
        this.editing = null;
        this.notice = null;
        this.rebuild();
      }
    });
    input.addEventListener('blur', () => {
      if (this.settled) return;
      void this.commit(line);
    });

    sizer.appendChild(input);
    queueMicrotask(() => input.focus());
    return sizer;
  }

  /**
   * One contiguous run of a shot's coverage. A shot with holes draws several of these; only the
   * outermost two carry drag handles, because the edge being dragged is the shot's first or
   * last line. An interior hole belongs to whichever shot interleaves with this one.
   */
  private bracket(
    span: ShotSpan,
    segment: { from: number; to: number },
    first: boolean,
    last: boolean,
    shotId: string,
  ): HTMLElement {
    const shot = span.shot;
    const stale = driftTag(shot.drift);
    const selected = this.ui.shotId === shotId ? ' sel' : '';
    const box = el('div', `tl-shot ${shot.status}${stale ? ` ${stale.state}` : ''}${selected}`);
    box.dataset['shotId'] = shotId;
    box.style.gridColumn = String(span.lane + 2);
    box.style.gridRow = `${segment.from + 1} / ${segment.to + 2}`;

    if (first) {
      box.appendChild(this.handle(shotId, 'start'));
      const head = el('div', 'tl-head');
      head.appendChild(el('span', 'fr', shot.framing));
      head.appendChild(
        el('span', 'cast', shot.subjects.length ? shot.subjects.join(' · ') : 'plate'),
      );
      // The frame is still what the runner will show, so the mark goes on the head rather than
      // over the image — this says the words moved, not that the art is invalid.
      if (stale) {
        const tag = el('span', `drift ${stale.state}`, stale.label);
        tag.title = stale.title;
        head.appendChild(tag);
      }
      box.appendChild(head);

      if (shot.image) {
        const img = document.createElement('img');
        img.className = 'tl-frame';
        img.src = `vnasset://${shot.image.hash}.${shot.image.ext}`;
        img.alt = shot.id;
        img.draggable = false;
        box.appendChild(img);
      } else {
        // A shot that has not rendered yet is the normal pre-run state, not a fault.
        box.appendChild(el('div', 'tl-frame none', 'no frame'));
      }
      box.appendChild(el('div', 'tl-id', shot.id));
    } else {
      const cont = el('div', 'tl-cont', `⋯ ${shot.framing}`);
      cont.title = shot.id;
      box.appendChild(cont);
    }

    if (last) box.appendChild(this.handle(shotId, 'end'));

    box.title = `${shotId} — click to select it, drag to move it among the other shots`;
    // The drag handles prevent their pointerdown and a bracket does not, because a bracket is
    // also the click target that selects a shot, and a grab that never moves must read as a click.
    box.addEventListener('pointerdown', () => {
      if (!canGrab(this.mode())) return this.say(grabRefusal(this.mode()));
      this.select(shotId);
      this.beginReorder(shotId);
    });
    // A right-click offers the commands about this one shot, each checked before it is drawn, with
    // a refusal (deleting the last shot, say) shown rather than hidden.
    box.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void showContextMenu(this.ctx as VnContext, event.clientX, event.clientY, shotId, [
        {
          label: 'Delete this shot',
          id: 'story.deleteShot',
          props: { scene: this.ui.sceneId, shot: shotId },
        },
      ]);
    });
    return box;
  }

  private handle(shotId: string, edge: Edge): HTMLElement {
    const button = document.createElement('button');
    button.className = `tl-edge ${edge}`;
    const which = edge === 'start' ? 'first' : 'last';
    button.setAttribute('aria-label', `Drag the ${which} covered line`);
    button.title = `Drag to move the ${which} line this shot covers`;
    button.addEventListener('pointerdown', (event) => {
      // Prevented so it never takes focus off an open editor — which means the drag has to be
      // refused rather than the editor silently committed under it. See `canGrab`.
      event.preventDefault();
      event.stopPropagation();
      if (!canGrab(this.mode())) return this.say(grabRefusal(this.mode()));
      this.beginDrag(shotId, edge);
    });
    return button;
  }

  private wardrobe(data: SceneCoverage): HTMLElement {
    const box = el('div', 'tl-wardrobe');
    const shotId = this.ui.shotId;
    const rows = outfitRows(data, shotId || null);
    if (rows.length === 0) return box;

    box.appendChild(
      this.wardrobeSection(
        'WEARING',
        'for the whole scene',
        rows.filter((r) => r.level === 'scene'),
      ),
    );
    if (shotId) {
      const shotRows = rows.filter((r) => r.level === 'shot');
      box.appendChild(
        this.wardrobeSection(
          'IN THIS SHOT',
          shotRows.length ? shotId : `${shotId} frames nobody`,
          shotRows,
        ),
      );
    }
    return box;
  }

  private wardrobeSection(title: string, note: string, rows: OutfitRow[]): HTMLElement {
    const section = el('div', 'wd-section');
    const head = el('div', 'wd-head');
    head.appendChild(el('span', 'tt', title));
    head.appendChild(el('span', 'ct', note));
    section.appendChild(head);
    for (const row of rows) section.appendChild(this.wardrobeRow(row));
    return section;
  }

  private wardrobeRow(row: OutfitRow): HTMLElement {
    const line = el('div', 'wd-row');
    line.appendChild(el('span', 'who', row.character));

    const select = document.createElement('select');
    select.className = 'wd-pick';
    const where = row.level === 'scene' ? 'in the scene' : 'in this shot';
    select.setAttribute('aria-label', `What ${row.character} wears ${where}`);
    // Changing the outfit re-renders: the outfit is in the shot prompt, unlike other scene edits.
    select.title = `Dress ${row.character} ${where}. Every frame they appear in is drawn again.`;
    // The fallback is named in the option itself: "inherit" alone makes the author open the
    // other level to find out what they would be inheriting.
    select.appendChild(option(INHERIT, `inherit — ${sourceLabel(row.inherits)}`));
    for (const outfit of row.outfits) select.appendChild(option(outfit, outfit));
    select.value = row.value;
    select.addEventListener('change', () => void this.setOutfit(row, select.value));
    line.appendChild(select);

    const shadowed = shadowedMarker(row);
    line.appendChild(
      shadowed
        ? el(
            'span',
            'wd-shadow',
            `hides the scene’s “${shadowed}” — clear it to let the marker through`,
          )
        : el('span', 'wd-from', sourceLabel(row.effective)),
    );
    return line;
  }

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  private mode() {
    return {
      editing: this.editing,
      dragging: this.drag !== null || this.reorder !== null || this.create !== null,
      pending: this.busy.pending,
    };
  }

  private select(shotId: string): void {
    if (this.ui.shotId === shotId) return;
    this.ui.shotId = shotId;
    this.announce();
  }

  private beginDrag(shotId: string, edge: Edge): void {
    this.drag = grabEdge(this.data ?? null, shotId, edge);
    this.startGesture();
  }

  private beginReorder(shotId: string): void {
    this.reorder = grabShot(this.data ?? null, shotId);
    this.startGesture();
  }

  private beginCreate(lineId: string): void {
    this.create = grabGutter(this.data ?? null, lineId);
    this.startGesture();
  }

  /** Window-level, so a gesture that leaves the strip still tracks and still releases. */
  private startGesture(): void {
    this.grid?.classList.add('dragging');
    // The one bracket the gesture is about, marked so its own handles stay lit while the pointer
    // is nowhere near them. Toggled on the node rather than rebuilt: the strip holds still.
    const held = this.grid?.querySelectorAll<HTMLElement>(
      `[data-shot-id="${this.drag?.shotId ?? this.reorder?.shotId ?? ''}"]`,
    );
    held?.forEach((node) => node.classList.add('dragging'));
    const onMove = (event: PointerEvent): void => {
      const row = this.rowUnder(event.clientX, event.clientY);
      if (row === null) return;
      if (this.drag) this.drag = aimDrag(this.drag, this.coverage, row);
      else if (this.reorder) this.reorder = aimReorder(this.reorder, this.coverage.spans, row);
      else if (this.create) this.create = aimCreate(this.create, this.coverage, row);
      this.notice = noticeOf(this.drag ?? this.reorder ?? this.create ?? { verdict: null });
      this.paintGesture();
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const pending = this.drag ?? this.reorder ?? this.create;
      const wasDrag = this.drag !== null;
      const wasCreate = this.create !== null;
      this.drag = null;
      this.reorder = null;
      this.create = null;
      this.grid?.classList.remove('dragging');
      held?.forEach((node) => node.classList.remove('dragging'));
      this.paintGesture();
      // A drop that changes nothing clears its preview, rather than leaving a sentence on screen
      // describing an edit that did not happen. A refused drop keeps its reason.
      if (!pending || (wasDrag && !(pending as Drag).lines)) {
        this.say(null);
        return;
      }
      if (!pending.verdict) return void this.say(null);
      if (!pending.verdict.accept) return;
      void this.run(
        pending.verdict.invoke,
        wasDrag ? 'Updating coverage' : wasCreate ? 'Making shot' : 'Moving shot',
        wasDrag ? 'Coverage updated.' : wasCreate ? 'Shot made.' : 'Shot moved.',
      );
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Which script row the pointer is over, read from the DOM rather than from measured geometry. */
  private rowUnder(x: number, y: number): number | null {
    const root = this.container.shadow as ShadowRoot;
    const hit = root.elementFromPoint(x, y)?.closest('[data-line-index]');
    const index = hit?.getAttribute('data-line-index');
    return index === null || index === undefined ? null : Number(index);
  }

  /**
   * The proposal, drawn over the committed strip and never applied to it: re-deriving coverage
   * per pointer move re-lanes shots the author never touched. The strip changes on release.
   */
  private paintGesture(): void {
    for (const node of this.overlay) node.remove();
    this.overlay = [];
    for (const band of this.bands.values()) band.classList.remove('claim', 'release');
    this.paintNotice();
    if (!this.grid) return;

    if (this.drag) {
      const ghost = this.drag.lines
        ? previewOf(this.coverage, this.drag.shotId, this.drag.lines)
        : null;
      if (!ghost) return;
      // Only for a drop that would be accepted: tinting rows a refused claim cannot take would
      // promise an edit that is not going to happen.
      if (this.drag.verdict?.accept) {
        for (const i of ghost.released) this.bands.get(i)?.classList.add('release');
        for (const i of ghost.claimed) this.bands.get(i)?.classList.add('claim');
      }
      // Still drawn when refused — the reason is in the notice, and a ghost that vanished would
      // read as the drag having stopped.
      for (const segment of ghost.segments) {
        const node = el('div', `tl-ghost${this.drag.verdict?.accept ? '' : ' refused'}`);
        node.style.gridColumn = String(ghost.lane + 2);
        node.style.gridRow = `${segment.from + 1} / ${segment.to + 2}`;
        this.overlay.push(node);
        this.grid.appendChild(node);
      }
      return;
    }

    if (this.create) {
      // The sweep's preview is the rows themselves: the shot does not exist yet, so there is no
      // bracket to ghost — the claim tint says which lines the drop would cover. Only for a drop
      // that would be accepted; a refused sweep keeps its reason in the notice and tints nothing.
      if (!this.create.lines || !this.create.verdict?.accept) return;
      const swept = new Set(this.create.lines);
      for (const row of this.coverage.rows) {
        if (swept.has(row.line.id)) this.bands.get(row.index)?.classList.add('claim');
      }
      return;
    }

    if (!this.reorder?.verdict) return;
    // The reorder's whole preview: where the shot would land. The brackets themselves hold still
    // — a shot's position is where its lines sit, so a live preview would have to move the prose
    // too, and layout changes on commit.
    const rows = this.coverage.rows.length;
    const at = insertionRow(this.coverage.spans, this.reorder.target, rows);
    const node = el(
      'div',
      `tl-drop${this.reorder.verdict.accept ? '' : ' refused'}${at >= rows ? ' end' : ''}`,
    );
    node.style.gridColumn = '1 / -1';
    node.style.gridRow = String(Math.min(at, Math.max(rows - 1, 0)) + 1);
    this.overlay.push(node);
    this.grid.appendChild(node);
  }

  // -------------------------------------------------------------------------
  // Writes — every one of them a command, and every one of them re-reads the strip
  // -------------------------------------------------------------------------

  private openEditor(line: CoverageLine): void {
    // Mid-write the refusal is spoken: the author clicked squarely on a line and gets the
    // sentence. Mid-drag (`canEdit`, below) it is silent, because the click landed nowhere by
    // design.
    if (this.busy.pending) return this.say(WRITE_PENDING);
    if (!canEdit(this.mode())) return;
    this.settled = false;
    this.editing = line.id;
    this.draft = line.text;
    this.notice = null;
    this.rebuild();
  }

  /**
   * The precondition, asked as the author types. `story.setLineText`'s own note is where the count
   * of frames that will go on illustrating the old prose comes from, so the warning before the
   * commit and the message after it are one sentence rather than two guesses.
   */
  private scheduleCheck(line: CoverageLine): void {
    clearTimeout(this.checkTimer);
    const invocation = commitOf(line, this.draft);
    if (!invocation) return this.say(null);
    this.checkTimer = setTimeout(() => {
      void api.invoke('command:check', invocation).then((check) => {
        if (this.editing === line.id) this.say(noticeForCheck(check));
      });
    }, 180);
  }

  private async commit(line: CoverageLine): Promise<void> {
    this.editing = null;
    const invocation = commitOf(line, this.draft);
    // A click in and a click away is not an authorial act: no record, no undo point, no notice.
    if (!invocation) {
      this.notice = null;
      this.rebuild();
      return;
    }
    this.beginBusy('Retyping line');
    const outcome = await api.invoke('command:exec', { ...invocation, source: 'ui' });
    this.settleBusy();
    if (!outcome.ok) {
      // The draft is still held, so reopening hands back what the author typed alongside the
      // command's own reason for refusing it — "a line cannot be empty", most often.
      this.editing = line.id;
      this.settled = false;
      this.notice = { tone: 'refused', text: outcome.error };
      this.rebuild();
      return;
    }
    this.notice = { tone: 'ok', text: outcome.record.message ?? 'Line retyped.' };
    await this.loadScene();
  }

  /**
   * A wardrobe row's select, committed. The two levels write different files — the marker goes to
   * the scene chunk, the override to the storyboard — so the strip is re-read rather than patched,
   * and the command's own sentence is what the author is told either way.
   */
  private async setOutfit(row: OutfitRow, outfit: string): Promise<void> {
    await this.run(outfitInvocation(row, outfit), 'Setting outfit', 'Outfit set.');
  }

  /**
   * Every command this surface sends goes through here (retyping excepted — its refusal path
   * reopens the editor). `progress` is what the bar says while the write is in flight; `fallback`
   * is the outcome when the command's record carries no message. The bar resolves into the
   * outcome notice — one row, changing tone — rather than a second surface appearing.
   */
  private async run(invocation: Invocation, progress: string, fallback: string): Promise<void> {
    this.beginBusy(progress);
    const outcome = await api.invoke('command:exec', { ...invocation, source: 'ui' });
    this.settleBusy();
    if (!outcome.ok) return this.say({ tone: 'refused', text: outcome.error });
    this.notice = { tone: 'ok', text: outcome.record.message ?? fallback };
    await this.loadScene();
  }

  /**
   * The write has been sent. The lock is immediate — a grab, a retype or a wardrobe pick would
   * be judged against rows the landing is about to replace — but the bar waits out
   * {@link BUSY_DELAY_MS}, so a fast command never flashes. {@link WRITE_PENDING} becomes every
   * locked control's tooltip, because a control that will not act has to say why on hover.
   */
  private beginBusy(title: string): void {
    this.busy = beginWrite(title);
    this.lockSurface();
    clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      this.busy = revealBusy(this.busy);
      this.paintNotice();
    }, BUSY_DELAY_MS);
  }

  private settleBusy(): void {
    clearTimeout(this.busyTimer);
    this.busy = SETTLED;
    this.unlockSurface();
  }

  /** Swap every tooltip for the refusal, keeping the words to hand back. Selects also disable. */
  private lockSurface(): void {
    for (const node of this.surface.querySelectorAll<HTMLElement>('[title]')) {
      node.dataset['idleTitle'] = node.title;
      node.title = WRITE_PENDING.text;
    }
    for (const pick of this.surface.querySelectorAll<HTMLSelectElement>('select')) {
      pick.disabled = true;
      pick.title = WRITE_PENDING.text;
    }
  }

  /** Undo the lock in place: a refused command leaves the strip standing, so nothing rebuilds it. */
  private unlockSurface(): void {
    for (const node of this.surface.querySelectorAll<HTMLElement>('[title]')) {
      const idle = node.dataset['idleTitle'];
      if (idle === undefined) continue;
      node.title = idle;
      delete node.dataset['idleTitle'];
    }
    for (const pick of this.surface.querySelectorAll<HTMLSelectElement>('select')) {
      pick.disabled = false;
    }
  }

  private say(notice: Notice | null): void {
    this.notice = notice;
    this.paintNotice();
  }

  private paintNotice(): void {
    if (!this.noticeEl) return;
    const label = busyLabel(this.busy);
    if (label !== null) {
      this.noticeEl.className = 'tl-notice busy';
      this.noticeEl.textContent = label;
      return;
    }
    this.noticeEl.className = `tl-notice${this.notice ? ` ${this.notice.tone}` : ''}`;
    this.noticeEl.textContent = this.notice?.text ?? '';
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

registerEditor(TimelineEditor, 'vn.TimelineEditor');

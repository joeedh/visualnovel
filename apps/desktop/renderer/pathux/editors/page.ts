/**
 * The Page editor: one page shot, its panels drawn over the render (or over a pale sheet before
 * one), the reviewer's measured boxes under them, the shot's lines in a column beside it, and the
 * selected panel's framing, camera, cast and notes. Every edit is `story.setPanels` with the
 * whole list; the page is edited on the page, and the column only says which panel it is about.
 */
import { KeyMap, type Container } from 'pathux';
import type { Invocation } from '@vn/commands';
import { boxOf } from '@vn/artgen/layout';
import { SHOT_FRAMINGS, type PagePanel } from '@vn/types';
import { api } from '../../api.js';
import type { CoverageLine, CoverageShot, SceneCoverage } from '../../../src/shared/ipc.js';
import type { Notice } from '../../../src/shared/lineedit.js';
import {
  BUSY_DELAY_MS,
  SETTLED,
  WRITE_PENDING,
  beginWrite,
  busyLabel,
  revealBusy,
  type Busy,
} from '../../rules/timeline/busy.js';
import {
  LAYOUTS,
  boxesOf,
  cameraAction,
  castAction,
  cornerAction,
  enterLetters,
  framingAction,
  inLayout,
  layoutAction,
  lineAction,
  notesAction,
  pageLines,
  panelAction,
  panelOfLine,
  panelsProps,
  selectedPanel,
  shotOf,
  subjectFieldAction,
  summaryOf,
  verdictOf,
  withCast,
  withCorner,
  withCornerAfter,
  withPanel,
  withoutCorner,
  type Layout,
  type PageState,
} from '../../rules/page.js';
import { sceneOfShot } from '../../rules/selection.js';
import { exec, onInvalidate } from '../app/bridge.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { hotkeys } from '../app/keymap.js';
import { gestureState } from '../interactions/gestures.js';
import { aimLine, grabLine, letterNotice, type Letter } from '../interactions/page.js';
import { coverState } from '../interactions/timeline.js';
import { redrawing, watchKeymap, type AnchorPass } from '../tour/anchors.js';
import PAGE_CSS from '../../styles/page.css?inline';

const SVG = 'http://www.w3.org/2000/svg';
/** How far an arrow key moves a corner, as a fraction of the page; Shift multiplies by four. */
const NUDGE = 0.005;
const NUDGE_SHIFT = 0.02;
/** How long a run of arrow presses is left to settle before the moved corners are written. */
const NUDGE_SETTLE_MS = 300;
/** Below this width the column drops under the page. */
const NARROW_PX = 640;
/** A panel keeps at least this many corners; Delete refuses below it. */
const MIN_CORNERS = 3;
/** The aspect a frame's layout glyphs are drawn at, which is the project default for a page. */
const PAGE_ASPECT = '3:4';

type Corner = { panel: number; corner: number };

export class PageEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;

  private data: SceneCoverage | undefined;
  /** The scene `data` holds or is being fetched for. */
  private loading = '';
  private failure = '';
  private drawn = '';
  private revision = 0;

  private selected: number | null = null;
  /** The shot the selection belongs to. */
  private shown = '';
  /** The corner with keyboard focus, which the arrow keys move. */
  private held: Corner | null = null;
  /**
   * The panel list as the pointer or the keys have moved it, ahead of the write. Null while the
   * page shows what is on disk.
   */
  private draft: PagePanel[] | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;

  private letter: Letter | null = null;
  private notice: Notice | null = null;
  private busy: Busy = SETTLED;
  private busyTimer: ReturnType<typeof setTimeout> | undefined;

  private pageEl: HTMLDivElement | undefined;
  /** The page's width over its height, which `fitPage` sizes the page by. */
  private pageRatio = 0.75;
  private paint: SVGSVGElement | undefined;
  private noticeEl: HTMLElement | undefined;
  /** Watches the surface for the narrow breakpoint and the stage for the page's fit. */
  private fit: ResizeObserver | undefined;

  private headPass: AnchorPass = redrawing('page', 'head');
  private pagePass: AnchorPass = redrawing('page', 'page');
  private sidePass: AnchorPass = redrawing('page', 'side');

  static override define() {
    return {
      tagname : 'vn-page-editor-x',
      areaname: 'page',
      icon    : -1,
    };
  }

  override init() {
    super.init();
    this.bar = (this.header as Container).row();
    this.bar.label('PAGE').style['padding'] = '0px 8px';
    this.pinToggle(this.bar);
    this.bar.flushUpdate();

    this.adoptStyle(PAGE_CSS);
    this.surface = document.createElement('div');
    this.surface.className = 'pg-surface';
    this.appendSurface(this.surface);

    this.fit = new ResizeObserver(() => {
      this.surface.classList.toggle('narrow', this.surface.clientWidth < NARROW_PX);
      this.fitPage();
    });
    this.fit.observe(this.surface);

    this.keymap = new KeyMap(
      hotkeys('page', {
        'Nudge left'        : () => this.nudge(-NUDGE, 0),
        'Nudge right'       : () => this.nudge(NUDGE, 0),
        'Nudge up'          : () => this.nudge(0, -NUDGE),
        'Nudge down'        : () => this.nudge(0, NUDGE),
        'Nudge left by two' : () => this.nudge(-NUDGE_SHIFT, 0),
        'Nudge right by two': () => this.nudge(NUDGE_SHIFT, 0),
        'Nudge up by two'   : () => this.nudge(0, -NUDGE_SHIFT),
        'Nudge down by two' : () => this.nudge(0, NUDGE_SHIFT),
        'Remove corner'     : () => this.removeCorner(),
        Deselect            : () => this.selectPanel(null),
      }),
    );
    watchKeymap('page', () => this.keymap);

    // The agent and the palette rewrite storyboards without this pane, and a run replaces the
    // render, so the page is re-read on every invalidate and on coming back on screen.
    this.watch(
      () => onInvalidate(() => void this.load()),
      () => void this.load(),
    );
    void this.load();
  }

  override update() {
    super.update();
    // Never mid-gesture: the panel under the pointer is read from the DOM
    if (this.letter || this.draft) return;
    this.follow();
    const scene = this.ui.shotId ? sceneOfShot(this.ui.shotId) : '';
    if (scene !== this.loading) return void this.load();
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  /** A different shot is a different page, whose panels the old selection says nothing about. */
  private follow(): void {
    if (this.ui.shotId === this.shown) return;
    this.shown = this.ui.shotId;
    this.selected = null;
    this.held = null;
  }

  private stateKey(): string {
    return [this.failure, this.revision, this.ui.shotId, this.selected ?? ''].join('|');
  }

  private state(): PageState {
    return {
      sceneId : this.data?.sceneId ?? '',
      shots   : this.data?.shots ?? [],
      shotId  : this.ui.shotId,
      lines   : this.data?.lines ?? [],
      selected: this.selected,
    };
  }

  private shot(): CoverageShot | undefined {
    return shotOf(this.state());
  }

  /** The panels on screen: the draft while a corner is moving, else the storyboard's. */
  private panelList(): PagePanel[] {
    return this.draft ?? this.shot()?.panels ?? [];
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    const shotId = this.ui.shotId;
    const sceneId = shotId ? sceneOfShot(shotId) : '';
    this.loading = sceneId;
    this.follow();
    if (!sceneId) {
      this.data = undefined;
      this.revision += 1;
      return this.rebuild();
    }
    try {
      this.data = await api.invoke('story:coverage', sceneId);
      this.failure = '';
    } catch (err) {
      this.data = undefined;
      this.failure = err instanceof Error ? err.message : String(err);
    }
    gestureState('page', 'page', () => coverState(this.data ?? null));
    const count = this.shot()?.panels?.length ?? 0;
    if (this.selected !== null && this.selected >= count) this.selected = null;
    this.draft = null;
    this.revision += 1;
    this.rebuild();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.surface.replaceChildren();
    this.fit?.disconnect();
    this.fit?.observe(this.surface);
    this.headPass = redrawing('page', 'head');
    this.pagePass = redrawing('page', 'page');
    this.sidePass = redrawing('page', 'side');
    this.pageEl = undefined;
    this.paint = undefined;
    this.noticeEl = undefined;

    const shot = this.shot();
    if (!shot) {
      const why = this.failure
        ? this.failure
        : !this.ui.shotId
          ? 'No shot is selected. Click a shot in the document tree or in Shot Coverage; a page shot opens here.'
          : `${this.ui.shotId} is not in ${sceneOfShot(this.ui.shotId)}'s storyboard any more.`;
      this.surface.appendChild(el('div', 'pg-empty', why));
      return;
    }

    this.surface.appendChild(this.head(shot));
    this.noticeEl = el('div', 'pg-notice');
    this.surface.appendChild(this.noticeEl);
    this.paintNotice();

    const body = el('div', 'pg-body');
    const stage = el('div', 'pg-stage');
    stage.appendChild(this.page(shot));
    body.appendChild(stage);
    body.appendChild(this.side(shot));
    this.surface.appendChild(body);
    this.fit?.observe(stage);
    this.fitPage();
  }

  /** Size the page to the largest box of its ratio the stage has room for. */
  private fitPage(): void {
    const page = this.pageEl;
    const stage = page?.parentElement;
    if (!page || !stage) return;
    const style = getComputedStyle(stage);
    const availW =
      stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availH =
      stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    let width = availW;
    let height = width / this.pageRatio;
    if (height > availH) {
      height = availH;
      width = height * this.pageRatio;
    }
    page.style.width = `${width}px`;
    page.style.height = `${height}px`;
  }

  private head(shot: CoverageShot): HTMLElement {
    const head = el('div', 'pg-head');
    head.appendChild(el('span', 'pg-name', shot.id));
    head.appendChild(el('span', 'pg-summary', summaryOf(shot)));

    const row = el('div', 'pg-layouts');
    const state = this.state();
    for (const layout of LAYOUTS) {
      const offer = layoutAction(state, layout);
      const button = document.createElement('button');
      button.className = `pg-glyph${inLayout(shot.panels ?? [], layout) ? ' current' : ''}`;
      // A frame's glyphs are drawn at the page aspect it would take, not the frame's own
      button.appendChild(glyph(layout, shot.panels ? shot.aspect : PAGE_ASPECT));
      this.headPass.act(button, offer, () => {
        if (offer.ok) void this.run({ id: offer.id, props: offer.props }, 'Laying out');
      });
      row.appendChild(button);
    }
    head.appendChild(row);

    const verdict = verdictOf(shot);
    const sentence = el('span', `pg-verdict${shot.image && !shot.layout ? ' quiet' : ''}`, verdict);
    head.appendChild(sentence);
    return head;
  }

  /** The page: the render or a sheet, the paint layer, one hit area per panel, the corners. */
  private page(shot: CoverageShot): HTMLElement {
    const page = el('div', 'pg-page') as HTMLDivElement;
    const [w, h] = shot.aspect.split(':').map(Number);
    this.pageRatio = w && h ? w / h : 0.75;
    if (shot.image) {
      const img = document.createElement('img');
      img.src = `vnasset://${shot.image.hash}.${shot.image.ext}`;
      img.alt = shot.id;
      img.draggable = false;
      page.appendChild(img);
    } else {
      page.appendChild(el('div', 'pg-sheet'));
    }

    const paint = document.createElementNS(SVG, 'svg');
    paint.setAttribute('class', 'pg-paint');
    paint.setAttribute('viewBox', '0 0 1 1');
    paint.setAttribute('preserveAspectRatio', 'none');
    page.appendChild(paint);
    this.paint = paint;
    this.pageEl = page;
    this.repaint();
    return page;
  }

  /**
   * Redraw the paint layer, the hit areas, the numbers and the corners from the current panels.
   * Called on every corner move, so it rebuilds only the page's own children.
   */
  private repaint(): void {
    const page = this.pageEl;
    const paint = this.paint;
    if (!page || !paint) return;
    const shot = this.shot();
    if (!shot) return;
    const panels = this.panelList();
    const state = this.state();

    paint.replaceChildren();
    for (const box of boxesOf(shot)) {
      const rect = document.createElementNS(SVG, 'rect');
      rect.setAttribute('class', 'box');
      rect.setAttribute('x', String(box.x));
      rect.setAttribute('y', String(box.y));
      rect.setAttribute('width', String(box.w));
      rect.setAttribute('height', String(box.h));
      paint.appendChild(rect);
    }
    panels.forEach((panel, i) => {
      const poly = document.createElementNS(SVG, 'polygon');
      const drop =
        this.letter?.panel === i ? (this.letter.verdict?.accept ? ' drop' : ' refused') : '';
      poly.setAttribute('class', `outline${this.selected === i ? ' sel' : ''}${drop}`);
      poly.setAttribute('points', panel.shape.map(([x, y]) => `${x},${y}`).join(' '));
      paint.appendChild(poly);
    });

    for (const old of page.querySelectorAll('.pg-hit, .pg-num, .pg-corner')) old.remove();
    this.pagePass = redrawing('page', 'page');
    panels.forEach((panel, i) => {
      // The hit area is the panel's bounding box with the outline as its clip, so its rect is
      // the panel's and a click at the rect's centre is a click on that panel
      const hit = el('div', 'pg-hit');
      hit.tabIndex = 0;
      hit.dataset['panel'] = String(i);
      const box = boxOf(panel.shape);
      const w = Math.max(box.w, 1e-6);
      const h = Math.max(box.h, 1e-6);
      hit.style.left = pct(box.x);
      hit.style.top = pct(box.y);
      hit.style.width = pct(box.w);
      hit.style.height = pct(box.h);
      hit.style.clipPath = `polygon(${panel.shape
        .map(([x, y]) => `${pct((x - box.x) / w)} ${pct((y - box.y) / h)}`)
        .join(', ')})`;
      this.pagePass.act(hit, panelAction(i), () => this.selectPanel(i));
      hit.addEventListener('dblclick', (event) => this.addCorner(i, event));
      page.appendChild(hit);

      const first = panel.shape[0]!;
      const num = el(
        'div',
        `pg-num${this.selected === null || this.selected === i ? '' : ' dim'}`,
        String(i + 1),
      );
      num.style.left = pct(first[0]);
      num.style.top = pct(first[1]);
      page.appendChild(num);
    });

    const sel = this.selected;
    if (sel !== null && panels[sel]) {
      panels[sel].shape.forEach(([x, y], j) => {
        const corner = document.createElement('button');
        corner.className = `pg-corner${this.held?.panel === sel && this.held.corner === j ? ' held' : ''}`;
        corner.style.left = pct(x);
        corner.style.top = pct(y);
        corner.setAttribute('aria-label', `Corner ${j + 1} of panel ${sel + 1}`);
        this.pagePass.record(corner, cornerAction(state, sel, j));
        corner.addEventListener('focus', () => {
          this.held = { panel: sel, corner: j };
        });
        corner.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          corner.focus();
          this.dragCorner(sel, j);
        });
        page.appendChild(corner);
      });
    }
  }

  private side(shot: CoverageShot): HTMLElement {
    const side = el('div', 'pg-side');
    const state = this.state();
    const panels = shot.panels ?? [];

    const lines = el('section', 'pg-lines');
    lines.appendChild(el('h3', '', 'Lines'));
    pageLines(state).forEach((line, index) => {
      lines.appendChild(this.lineRow(state, line, index, panelOfLine(panels, line.id)));
    });
    if (pageLines(state).length === 0) {
      lines.appendChild(el('div', 'hint', 'This shot covers no lines.'));
    }
    side.appendChild(lines);

    const panel = el('section', 'pg-panel');
    const chosen = selectedPanel(state);
    if (!chosen || this.selected === null) {
      panel.appendChild(el('h3', '', 'Panel'));
      panel.appendChild(
        el(
          'div',
          'hint',
          panels.length === 0
            ? 'Pick a layout above to make this frame a page.'
            : 'Select a panel on the page to edit its framing, camera and cast.',
        ),
      );
    } else {
      this.panelFields(panel, shot, chosen, this.selected);
    }
    side.appendChild(panel);
    return side;
  }

  private lineRow(
    state: PageState,
    line: CoverageLine,
    index: number,
    panel: number | null,
  ): HTMLElement {
    const offer = lineAction(state, line);
    const row = el('div', `pg-line${offer.ok ? '' : ' refused'}`);
    row.tabIndex = 0;
    row.appendChild(el('span', 'idx', String(index + 1)));
    const text = el('span', '');
    if (line.speaker) text.appendChild(el('span', 'who', line.speaker));
    text.appendChild(el('span', 'text', line.text));
    row.appendChild(text);
    if (panel === null) {
      row.appendChild(el('span', 'none'));
      row.appendChild(el('span', 'gap', 'no panel letters this line'));
    } else {
      row.appendChild(el('span', 'in', String(panel + 1)));
    }
    // Recorded rather than acted: the row is grabbed on pointerdown, and Enter is its own key
    this.sidePass.record(row, offer);
    if (!offer.ok) return row;
    row.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.dragLine(row, line.id);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const panels = enterLetters(this.state(), line.id);
      if (!panels) return this.say({ tone: 'refused', text: 'Select a panel first.' });
      void this.commitPanels(panels, 'Lettering');
    });
    return row;
  }

  private panelFields(
    section: HTMLElement,
    shot: CoverageShot,
    panel: PagePanel,
    index: number,
  ): void {
    const state = this.state();
    section.appendChild(el('h3', '', `Panel ${index + 1}`));

    const framingRow = el('div', 'row');
    framingRow.appendChild(el('span', '', 'Framing'));
    const framing = document.createElement('select');
    for (const f of SHOT_FRAMINGS) framing.appendChild(option(f, f));
    framing.value = panel.framing;
    this.sidePass.record(framing, framingAction(state));
    framing.addEventListener('change', () => {
      const next = framing.value as PagePanel['framing'];
      void this.commitPanels(withPanel(this.panelList(), index, { framing: next }), 'Reframing');
    });
    framingRow.appendChild(framing);
    section.appendChild(framingRow);

    const cameraRow = el('div', 'row');
    cameraRow.appendChild(el('span', '', 'Camera'));
    const camera = document.createElement('input');
    camera.value = panel.camera ?? '';
    camera.placeholder = 'low angle, over the shoulder…';
    this.sidePass.record(camera, cameraAction(state));
    this.commitOnBlur(camera, () => {
      const value = camera.value.trim();
      if (value === (panel.camera ?? '')) return null;
      return withPanel(this.panelList(), index, value ? { camera: value } : { camera: undefined });
    });
    cameraRow.appendChild(camera);
    section.appendChild(cameraRow);

    const castRow = el('div', 'row');
    castRow.appendChild(el('span', '', 'Cast'));
    const cast = el('div', 'pg-cast');
    if (shot.subjects.length === 0) cast.appendChild(el('span', 'hint', 'nobody in this shot'));
    for (const characterId of shot.subjects) {
      const present = panel.subjects.some((s) => s.characterId === characterId);
      const label = el('label', present ? 'on' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = present;
      label.appendChild(box);
      label.appendChild(document.createTextNode(characterId));
      const offer = castAction(state, characterId);
      this.sidePass.record(label, offer);
      box.addEventListener('change', () => {
        void this.commitPanels(
          withCast(this.panelList(), index, characterId, box.checked),
          box.checked ? 'Casting' : 'Uncasting',
        );
      });
      cast.appendChild(label);
    }
    castRow.appendChild(cast);
    section.appendChild(castRow);

    for (const subject of panel.subjects) {
      for (const field of ['pose', 'expression'] as const) {
        const row = el('div', 'pg-subject');
        row.appendChild(el('span', '', `${subject.characterId} ${field}`));
        const input = document.createElement('input');
        input.value = subject[field] ?? '';
        this.sidePass.record(input, subjectFieldAction(state, subject.characterId, field));
        this.commitOnBlur(input, () => {
          const value = input.value.trim();
          if (value === (subject[field] ?? '')) return null;
          const subjects = this.panelList()[index]!.subjects.map((s) =>
            s.characterId === subject.characterId ? { ...s, [field]: value || undefined } : s,
          );
          return withPanel(this.panelList(), index, { subjects });
        });
        row.appendChild(input);
        section.appendChild(row);
      }
    }

    const notesRow = el('div', 'row');
    notesRow.appendChild(el('span', '', 'Art notes'));
    const notes = document.createElement('textarea');
    notes.value = panel.artNotes ?? '';
    this.sidePass.record(notes, notesAction(state));
    this.commitOnBlur(notes, () => {
      const value = notes.value.trim();
      if (value === (panel.artNotes ?? '')) return null;
      return withPanel(
        this.panelList(),
        index,
        value ? { artNotes: value } : { artNotes: undefined },
      );
    });
    notesRow.appendChild(notes);
    section.appendChild(notesRow);
  }

  /** A field committed on blur or Ctrl+S; `next` answers null when nothing changed. */
  private commitOnBlur(
    field: HTMLInputElement | HTMLTextAreaElement,
    next: () => PagePanel[] | null,
  ): void {
    const commit = (): void => {
      const panels = next();
      if (panels) void this.commitPanels(panels, 'Writing panel');
    };
    field.addEventListener('blur', commit);
    (field as HTMLElement).addEventListener('keydown', (event) => {
      if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commit();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Selection, corners and keys
  // -------------------------------------------------------------------------

  private selectPanel(index: number | null): void {
    if (this.selected === index) return;
    this.selected = index;
    this.held = null;
    this.rebuild();
  }

  /** Where a client point falls on the page, as page fractions, clamped to it. */
  private fraction(x: number, y: number): [number, number] {
    const rect = this.pageEl!.getBoundingClientRect();
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    return [clamp((x - rect.left) / rect.width), clamp((y - rect.top) / rect.height)];
  }

  private dragCorner(panel: number, corner: number): void {
    this.held = { panel, corner };
    let moved = false;
    const onMove = (event: PointerEvent): void => {
      moved = true;
      this.draft = withCorner(
        this.panelList(),
        panel,
        corner,
        this.fraction(event.clientX, event.clientY),
      );
      this.repaint();
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const draft = this.draft;
      if (!moved || !draft) {
        this.draft = null;
        return;
      }
      void this.commitPanels(draft, 'Moving corner');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** An arrow key: the focused corner moves at once, and the write follows the last press. */
  private nudge(dx: number, dy: number): void {
    const at = this.held;
    if (!at) return;
    const point = this.panelList()[at.panel]?.shape[at.corner];
    if (!point) return;
    this.draft = withCorner(this.panelList(), at.panel, at.corner, [point[0] + dx, point[1] + dy]);
    this.repaint();
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      if (this.draft) void this.commitPanels(this.draft, 'Moving corner');
    }, NUDGE_SETTLE_MS);
  }

  private removeCorner(): void {
    const at = this.held;
    if (!at) return;
    const panel = this.panelList()[at.panel];
    if (!panel) return;
    if (panel.shape.length <= MIN_CORNERS) {
      return this.say({
        tone: 'refused',
        text: `Panel ${at.panel + 1} keeps at least ${MIN_CORNERS} corners.`,
      });
    }
    this.held = null;
    void this.commitPanels(withoutCorner(this.panelList(), at.panel, at.corner), 'Removing corner');
  }

  /** A double-click on a panel adds a corner on whichever of its edges is nearest the click. */
  private addCorner(panel: number, event: MouseEvent): void {
    const shape = this.panelList()[panel]?.shape;
    if (!shape) return;
    const [px, py] = this.fraction(event.clientX, event.clientY);
    let best = 0;
    let nearest = Infinity;
    shape.forEach((a, i) => {
      const b = shape[(i + 1) % shape.length]!;
      const d = distanceToSegment(px, py, a, b);
      if (d < nearest) {
        nearest = d;
        best = i;
      }
    });
    this.selected = panel;
    void this.commitPanels(withCornerAfter(this.panelList(), panel, best), 'Adding corner');
  }

  // -------------------------------------------------------------------------
  // The line drag
  // -------------------------------------------------------------------------

  private dragLine(row: HTMLElement, lineId: string): void {
    this.letter = grabLine(this.data ?? null, this.ui.shotId, lineId);
    row.classList.add('held');
    this.pageEl?.classList.add('dragging');
    const onMove = (event: PointerEvent): void => {
      if (!this.letter) return;
      this.letter = aimLine(this.letter, this.panelUnder(event.clientX, event.clientY));
      this.notice = letterNotice(this.letter);
      this.paintNotice();
      this.repaint();
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const pending = this.letter;
      this.letter = null;
      row.classList.remove('held');
      this.pageEl?.classList.remove('dragging');
      this.repaint();
      if (!pending?.verdict) return void this.say(null);
      if (!pending.verdict.accept) return;
      void this.run(pending.verdict.invoke, 'Lettering');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private panelUnder(x: number, y: number): number | null {
    const root = this.container.shadow as ShadowRoot;
    const hit = root.elementFromPoint(x, y)?.closest<HTMLElement>('[data-panel]');
    const index = hit?.dataset['panel'];
    return index === undefined ? null : Number(index);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private commitPanels(panels: PagePanel[], progress: string): Promise<void> {
    const props = panelsProps(this.state(), panels);
    return this.run({ id: 'story.setPanels', props }, progress);
  }

  /** Every write goes through here; the outcome's own sentence is what the author reads. */
  private async run(invocation: Invocation, progress: string): Promise<void> {
    this.beginBusy(progress);
    const outcome = await exec(invocation.id, invocation.props);
    this.settleBusy();
    if (!outcome.ok) {
      this.draft = null;
      this.repaint();
      return this.say({ tone: 'refused', text: outcome.error });
    }
    this.notice = { tone: 'ok', text: outcome.record.message ?? 'Page written.' };
    await this.load();
  }

  private beginBusy(title: string): void {
    this.busy = beginWrite(title);
    for (const node of this.surface.querySelectorAll<HTMLElement>('[title]')) {
      node.dataset['idleTitle'] = node.title;
      node.title = WRITE_PENDING.text;
    }
    clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      this.busy = revealBusy(this.busy);
      this.paintNotice();
    }, BUSY_DELAY_MS);
  }

  private settleBusy(): void {
    clearTimeout(this.busyTimer);
    this.busy = SETTLED;
    for (const node of this.surface.querySelectorAll<HTMLElement>('[title]')) {
      const idle = node.dataset['idleTitle'];
      if (idle === undefined) continue;
      node.title = idle;
      delete node.dataset['idleTitle'];
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
      this.noticeEl.className = 'pg-notice busy';
      this.noticeEl.textContent = label;
      return;
    }
    this.noticeEl.className = `pg-notice${this.notice ? ` ${this.notice.tone}` : ''}`;
    this.noticeEl.textContent = this.notice?.text ?? '';
  }
}

/** A layout's outlines as one small SVG at the page's aspect. */
function glyph(layout: Layout, aspect: string): SVGSVGElement {
  const [w, h] = aspect.split(':').map(Number);
  const width = w && h ? w / h : 0.75;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} 1`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.aspectRatio = String(width);
  for (const shape of layout.shapes) {
    const poly = document.createElementNS(SVG, 'polygon');
    poly.setAttribute('points', shape.map(([x, y]) => `${x * width},${y}`).join(' '));
    svg.appendChild(poly);
  }
  return svg;
}

const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;

function distanceToSegment(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return Math.hypot(px - x, py - y);
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

registerEditor(PageEditor, 'vn.PageEditor');

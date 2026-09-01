import type { Button, Container } from 'pathux';
import { api } from '../../api.js';
import { seed } from '../agent.js';
import { handleAnchor, routeEdges, type EdgeRoute } from '../../graph/edges.js';
import { edgeAt, nodeAt, type Pick as GraphPick } from '../../graph/hit.js';
import { layoutGraph, type GraphLayout } from '../../graph/layout.js';
import { toWorld } from '../../graph/viewport.js';
import {
  asInvocation,
  deleteSceneIntent,
  newSceneIntent,
  proposeScene,
  selectionAfterDelete,
  type NewScene,
} from '../../rules/branch/compose.js';
import { grabAt } from '../../rules/branch/grab.js';
import { CARD, branchGraph, type BranchGraph } from '../../rules/branch/graph.js';
import { DURATION, tweenLayout } from '../../rules/branch/tween.js';
import { branchState, relabel, type BranchState } from '../../../src/shared/interactions.js';
import { noticeForCheck, type Notice } from '../../../src/shared/lineedit.js';
import {
  GRAB,
  aim,
  cardMenu,
  commitOf,
  grabArrow,
  grabCard,
  grabHandle,
  newChoiceEdge,
  noticeOf,
  type Drag,
} from '../branch.js';
import { pickOracle, redrawing } from '../anchors.js';
import { exec, refreshWorkspace } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { GraphCanvas, type EdgeStyle } from '../graph/canvas.js';
import { menuIsOpen, showContextMenu } from '../showmenu.js';
import { TOKENS } from '../tokens.js';
import BRANCH_CSS from '../../styles/branch.css?inline';
import type { VnContext } from '../context.js';
import type { Invocation } from '@vn/commands';
import type { LaidOutNode, Point } from '../../graph/types.js';
import type { StoryEdge, StoryGraph, StoryScene } from '../../../src/shared/ipc.js';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The frame around `branch.css`, which is imported as-is and carries the cards, the labels and the
 * drag overlays. This supplies the reset that does not cross the shadow boundary, and the column,
 * which was the room's `grid-template-rows` and here has to beat that rule on specificity rather
 * than replace it.
 */
const SURFACE_CSS = `
* { box-sizing: border-box; }
.branch.branch-surface {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ink);
  color: var(--paper);
}
.branch-surface > .branch-canvas { flex: 1 1 auto; }
.branch-surface > .branch-line { flex: none; }
.branch-surface > .branch-name {
  flex: none;
  padding: 7px 14px;
  border-bottom: 1px solid var(--ink-line);
  background: var(--ink-raised);
}
.branch-surface > .invite { display: none; }
.branch-surface.empty > .branch-canvas { display: none; }
.branch-surface.empty > .invite { display: block; margin: auto; padding: 0px 40px; }
`;

/** Anchor fallback for the one frame where a dragged node has left the layout mid-reload. */
const ZERO: LaidOutNode = { id: '', width: 0, height: 0, x: 0, y: 0, rank: 0, order: 0 };

const EMPTY_GRAPH: BranchGraph = { graph: { nodes: [], edges: [] }, stubs: new Set() };
const EMPTY_STATE: BranchState = { scenes: new Map(), edges: [] };

const HINT =
  'Drag a card’s ⌄ handle onto another scene to wire it; drop a card on a wire to splice it in.';

const INVITE =
  'No scenes yet. Ask vnauthor for the opening scene, or make an empty one here and write it in ' +
  'the script column — either way it appears as a card you can wire the rest of the story to.';

/**
 * The branch editor: scenes drawn as index cards, wired together. The port of STUDIO's
 * `BranchEditor` onto the same `GraphCanvas` the task DAG uses.
 *
 * Position is not semantic here, since a `Scene` has no `x`/`y`, so a drag rewires the story
 * rather than moving anything. All three drags read their verdict from `pathux/branch.ts`, which
 * asks the same `branchops` the command will run, so the refusal shown mid-drag is the refusal the
 * commit would give.
 *
 * Two things change in the port. The selected scene is the shared `ui.sceneId`, so a card clicked
 * here is the scene the coverage strip opens. A claimed gesture calls `preventDefault()`, which is
 * `GraphCanvas`'s protocol for a pointer another handler has taken; without it the canvas would pan
 * underneath an unwire drag, the one gesture that starts over empty background.
 */
export class BranchEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;
  private canvas!: GraphCanvas;
  private overlayHost!: HTMLDivElement;
  private lineEl!: HTMLDivElement;
  private namerEl: HTMLElement | undefined;

  private story: StoryGraph | null = null;
  private state: BranchState = EMPTY_STATE;
  private stubs: ReadonlySet<string> = EMPTY_GRAPH.stubs;
  private edges: EdgeRoute[] = [];
  private sceneById = new Map<string, StoryScene>();
  private edgeById = new Map<string, StoryEdge>();

  /** The two ends of the relayout tween: `target` is where it is going, `layout` where it is. */
  private target: GraphLayout = layoutGraph(EMPTY_GRAPH.graph);
  private layout: GraphLayout = this.target;
  private frame: number | undefined;

  private failure = '';
  private drawn = '';
  /** Bumped on every load, so a reload redraws even when nothing about the selection moved. */
  private revision = 0;
  /** Fit once, when the first layout meets a sized surface. Fitting again would undo panning. */
  private fitted = false;

  private selected: string | null = null;
  private drag: Drag | null = null;
  private notice: Notice | null = null;
  /** A scene the author asked for but has not yet written; editing it changes the command's own props. */
  private naming: NewScene | null = null;

  /** The open label editor, held across redraws: an `<input>` keeps its value, not its focus. */
  private editing: string | null = null;
  private labelInput: HTMLInputElement | undefined;
  private settled = false;
  /** True across the one `paint` that re-parents the open input — see its `blur` handler. */
  private repainting = false;

  static override define() {
    return {
      tagname: 'vn-branch-editor-x',
      areaname: 'branches',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();
    this.adoptStyle(BRANCH_CSS + SURFACE_CSS);

    this.surface = el('div', 'branch branch-surface') as HTMLDivElement;

    this.canvas = new GraphCanvas({
      edgeStyle: wireStyle,
      pickOptions: { edgeSlop: 10 },
      onPick: (hit, event) => this.onPick(hit, event),
      onSurfaceChange: () => this.fitOnce(),
    });
    // The canvas's own `pickAt`, so a tour asking whether a ring lands on its node gets the
    // answer the pointer would get rather than a second reading of the same geometry.
    pickOracle('branches', (nodeId, x, y) => {
      const hit = this.canvas.pickAt(x, y);
      return hit.type === 'node' && hit.node.id === nodeId;
    });
    this.canvas.element.className = 'branch-canvas';
    // On the canvas rather than on a card: the node layer takes no pointer events, so a card is
    // never the target of an event the canvas did not resolve.
    this.canvas.element.addEventListener('contextmenu', (event) => this.openMenu(event));
    this.surface.appendChild(this.canvas.element);

    this.surface.appendChild(el('p', 'invite', INVITE));
    this.lineEl = el('div', 'branch-line idle', HINT) as HTMLDivElement;
    this.surface.appendChild(this.lineEl);

    // One host for every world-space extra, mutated in place: `GraphCanvas.draw` re-appends it
    // after clearing, so a pointer move can repaint the overlay without rebuilding the content.
    this.overlayHost = el('div') as HTMLDivElement;
    Object.assign(this.overlayHost.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
    });
    this.canvas.setOverlay(this.overlayHost);

    this.appendSurface(this.surface);
    void this.load();
  }

  override update() {
    super.update();

    // No redraw mid-gesture: the drag is aimed at the nodes and routes this frame's layout produced
    if (this.drag) return;
    if (this.stateKey() !== this.drawn) this.redraw();
  }

  private stateKey(): string {
    return [this.failure, this.revision, this.ui.sceneId, this.selected ?? ''].join('|');
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      this.story = await api.invoke('story:graph');
      this.failure = '';
    } catch (err) {
      this.story = null;
      this.failure = err instanceof Error ? err.message : String(err);
    }
    this.rebuild();
  }

  /** Re-derive everything the graph implies, then animate from wherever the last layout got to. */
  private rebuild(): void {
    const story = this.story;
    this.state = story ? branchState(story) : EMPTY_STATE;
    this.sceneById = new Map((story?.scenes ?? []).map((s) => [s.id, s]));
    this.edgeById = new Map((story?.edges ?? []).map((e) => [e.id, e]));

    const { graph, stubs } = story ? branchGraph(story) : EMPTY_GRAPH;
    this.stubs = stubs;
    this.target = layoutGraph(graph);
    this.revision += 1;
    this.editing = null;
    this.labelInput = undefined;

    this.startTween();
    this.redraw();
    this.fitOnce();
  }

  /**
   * The relayout, animated from the positions on screen rather than from the ones the previous
   * target started at — a second rewire mid-animation continues from what the author can see.
   */
  private startTween(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;

    const base = this.layout;
    if (reducedMotion() || base.nodes.length === 0) {
      this.layout = this.target;
      this.route();
      return;
    }

    const start = performance.now();
    const step = (now: number): void => {
      this.layout = tweenLayout(base, this.target, (now - start) / DURATION);
      this.route();
      this.paint();
      this.frame = this.layout === this.target ? undefined : requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private route(): void {
    this.edges = routeEdges(this.layout, branchGraph(this.story ?? EMPTY_STORY).graph.edges);
  }

  private fitOnce(): void {
    if (this.fitted || this.target.nodes.length === 0 || !this.canvas.surface) return;
    this.fitted = true;
    this.canvas.fitToContent();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private redraw(): void {
    this.drawn = this.stateKey();
    this.rebuildBar();
    this.syncNamer();
    this.surface.classList.toggle('empty', this.story?.scenes.length === 0);
    this.paint();
    this.paintNotice();
  }

  /** Content and overlay together: a gesture repaints both, and only these two. */
  private paint(): void {
    this.repainting = true;
    this.paintOverlay();
    const nodes = redrawing('branches', 'nodes');
    this.canvas.setContent({
      layout: this.layout,
      edges: this.edges,
      renderNode: (node) => this.renderNode(node),
      renderLabel: (edge) => this.renderLabel(edge),
      // The scene a card names, so a step that wants another scene on screen can ring the card
      // that puts one there. A shot left over from another scene is dropped, which is what
      // `selectionForNode` does for the same click in the document tree.
      onNode: (node, box) =>
        nodes.pickItem(node.id, box, 'scene', node.id, {
          sceneId: node.id,
          ...(this.ui.shotId.startsWith(`${node.id}__`) ? {} : { shotId: '' }),
        }),
    });
    // Re-appended by every draw, so the caret is restored rather than kept: an input's value and
    // selection survive being moved in the DOM, its focus does not.
    this.labelInput?.focus();
    this.repainting = false;
  }

  private rebuildBar(): void {
    const scenes = this.story?.scenes.length ?? 0;
    const edges = this.story?.edges.length ?? 0;
    const dead = this.story?.scenes.filter((s) => !s.reachable).length ?? 0;

    this.bar.clear();
    this.bar.label('BRANCHES').style['padding'] = '0px 8px';
    this.bar.label(
      this.failure
        ? this.failure
        : `${scenes} scenes · ${edges} edges${dead > 0 ? ` · ${dead} unreachable` : ''}`,
    ).style['padding'] = '0px 8px';

    const anchors = redrawing('branches', 'bar');
    if (!this.naming) {
      // The button that opens the naming row, not the row's own Write it: this is where writing a
      // scene starts, and both the id and the heading are typed after it.
      anchors.act(
        this.bar.button('+ scene', () => {}),
        { ok: true, id: 'story.newScene', props: {}, label: '+ scene' },
        () => this.startNaming(),
        { supplies: ['scene', 'heading'] },
      ).description = 'Name a new scene and add it to the graph, unconnected';
      const scene = this.ui.sceneId;
      if (scene && this.sceneById.has(scene)) {
        const remove = this.bar.button(`delete ${scene}`, () => void this.deleteScene(scene));
        remove.description = `Remove ${scene} and the shots that illustrate it`;
        // Asked as the button is drawn rather than on hover, so a scene something still points at
        // is greyed and says why in the command's own words without being reached for first.
        this.askDelete(scene, remove);
      }
    }

    this.bar.button('Fit', () => {
      this.fitted = false;
      this.fitOnce();
    }).description = 'Zoom out until the whole graph is on screen';
    this.bar.button('Refresh', () => void this.load()).description =
      'Re-read the scenes and their connections from disk';
    this.bar.flushUpdate();
  }

  private renderNode(node: LaidOutNode): HTMLElement {
    const scene = this.sceneById.get(node.id);
    if (!scene) return stubCard(node.id);
    const wiring = this.drag?.kind === 'connect' ? this.drag : null;
    return sceneCard(
      scene,
      this.story?.start === scene.id,
      this.ui.sceneId === scene.id || wiring?.scene === scene.id || wiring?.over === scene.id,
    );
  }

  private renderLabel(route: EdgeRoute): HTMLElement | null {
    const edge = this.edgeById.get(route.id);
    if (!edge) return null;
    if (this.editing === edge.id) return this.labelInput ?? null;
    if (!edge.label) return null;

    const label = el('button', `edge-label${edge.id === this.selected ? ' sel' : ''}`, edge.label);
    label.title = 'Rename this choice';
    // Listens on `pointerdown` rather than `click` and stops it before the canvas picks: a redraw
    // between down and up would take the click with it
    label.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.openLabel(edge);
    });
    return label;
  }

  /**
   * The three world-space overlays: which wires would take the carried card, the ghost wire being
   * pulled, and the endpoint of the selected edge, a disc showing that its arrowhead can be
   * grabbed.
   */
  private paintOverlay(): void {
    this.overlayHost.textContent = '';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'branch-overlay');
    svg.setAttribute('aria-hidden', 'true');
    this.overlayHost.appendChild(svg);

    const drag = this.drag;
    if (drag?.kind === 'splice') {
      for (const route of this.edges) {
        const verdict = drag.verdicts.get(route.id);
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', route.path);
        path.setAttribute(
          'class',
          `verdict ${verdict && !verdict.accept ? 'refuse' : 'accept'}${
            drag.over === route.id ? ' over' : ''
          }`,
        );
        svg.appendChild(path);
      }
      const carried = this.sceneById.get(drag.scene);
      if (carried) {
        // The original stays put: a splice rewires the story, it does not move the scene.
        const ghost = el('div', 'carried-card');
        Object.assign(ghost.style, {
          left: `${drag.at.x - CARD.width / 2}px`,
          top: `${drag.at.y - CARD.height / 2}px`,
          width: `${CARD.width}px`,
          height: `${CARD.height}px`,
        });
        ghost.appendChild(sceneCard(carried, false, false, true));
        this.overlayHost.appendChild(ghost);
      }
    }

    if (drag?.kind === 'connect') {
      const from = handleAnchor(this.layout.byId.get(drag.scene) ?? ZERO);
      const line = document.createElementNS(SVG, 'line');
      line.setAttribute('class', 'ghost-wire');
      line.setAttribute('x1', String(from.x));
      line.setAttribute('y1', String(from.y));
      line.setAttribute('x2', String(drag.at.x));
      line.setAttribute('y2', String(drag.at.y));
      svg.appendChild(line);
    }

    if (this.selected && !drag) {
      const end = this.edges.find((r) => r.id === this.selected)?.points.at(-1);
      if (end) {
        const dot = document.createElementNS(SVG, 'circle');
        dot.setAttribute('class', 'endpoint');
        dot.setAttribute('cx', String(end.x));
        dot.setAttribute('cy', String(end.y));
        dot.setAttribute('r', '5');
        svg.appendChild(dot);
      }
    }
  }

  private paintNotice(): void {
    const line = this.drag ? (noticeOf(this.drag) ?? this.notice) : this.notice;
    this.lineEl.className = `branch-line ${line?.tone ?? 'idle'}`;
    this.lineEl.textContent = line?.text ?? HINT;
  }

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  private worldAt(clientX: number, clientY: number): Point {
    const box = this.canvas.element.getBoundingClientRect();
    return toWorld(this.canvas.viewport, { x: clientX - box.left, y: clientY - box.top });
  }

  private onPick(hit: GraphPick, event: PointerEvent): void {
    // The wrangler closes a menu on mouse-up, so pointer-down is the last moment this can be
    // asked. Without it the click that dismisses a card's own menu would grab the card under it.
    // `preventDefault` is the canvas's protocol for a taken pointer, so it does not pan either.
    if (menuIsOpen()) return event.preventDefault();
    this.settleLabel();
    const world = this.worldAt(event.clientX, event.clientY);
    const scale = this.canvas.viewport.scale;

    // The two small targets are resolved from their own discs, before `pick`'s answer — see
    // `rules/branch/grab.ts` for why neither can be reached through it.
    const grabbed = grabAt(this.layout.nodes, this.edges, world, GRAB / scale, this.stubs);
    if (grabbed?.kind === 'connect') {
      event.preventDefault();
      return this.begin(grabHandle(this.state, grabbed.scene, world));
    }
    if (grabbed) {
      event.preventDefault();
      this.selected = grabbed.edge;
      return this.begin(grabArrow(this.state, grabbed.edge, world));
    }

    if (hit.type === 'node') {
      if (this.stubs.has(hit.node.id)) return;
      event.preventDefault();
      return this.begin(grabCard(this.state, hit.node.id, world));
    }
    this.selected = hit.type === 'edge' ? hit.edge.id : null;
    this.redraw();
  }

  /**
   * The commands a card carries. A scene is selected first, because Go to script opens the script
   * on the shared selection — `view.open` carries one subject string and a scene does not use it.
   * A right-click over the background offers nothing: it names no card.
   */
  private openMenu(event: MouseEvent): void {
    event.preventDefault();
    const node = nodeAt(this.layout, this.worldAt(event.clientX, event.clientY));
    if (!node) return;
    const stub = this.stubs.has(node.id);
    if (!stub) this.selectScene(node.id);
    const entries = cardMenu(node.id, stub);
    void showContextMenu(this.ctx as VnContext, event.clientX, event.clientY, node.id, entries);
  }

  /** The listeners are on `window`, so a gesture leaving the canvas still tracks and releases. */
  private begin(drag: Drag): void {
    this.drag = drag;
    this.paintGesture();

    const onMove = (event: PointerEvent): void => {
      if (!this.drag) return;
      this.drag = aim(this.drag, {
        at: this.worldAt(event.clientX, event.clientY),
        node: this.nodeUnder(event),
        edge: this.edgeUnder(event),
        away: this.awayFromArrow(event),
        scale: this.canvas.viewport.scale,
      });
      this.paintGesture();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      this.drag = null;
      finish();
      this.paintGesture();
    };
    const onUp = (): void => {
      const pending = this.drag;
      this.drag = null;
      finish();
      this.paintGesture();
      if (!pending) return;
      // A press that never travelled counts as a click, which selects the scene. The selection is
      // shared, so the coverage strip and the script column follow it
      if (pending.kind === 'press') return this.openScene(pending.scene);
      const invoke = commitOf(pending);
      // A refused drop keeps the reason already on screen. A drop over nothing clears the preview
      // instead
      if (!invoke) return void (pending.verdict ? undefined : this.say(null));
      const opening = pending.kind === 'connect' ? newChoiceEdge(this.state, pending.scene) : null;
      void this.run(invoke, 'Story rewired.').then((ok) => {
        if (ok && opening) this.openLabel(this.edgeById.get(opening));
      });
    };
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
  }

  private nodeUnder(event: PointerEvent): string | null {
    const node = nodeAt(this.layout, this.worldAt(event.clientX, event.clientY));
    return node && !this.stubs.has(node.id) ? node.id : null;
  }

  private edgeUnder(event: PointerEvent): string | null {
    const at = this.worldAt(event.clientX, event.clientY);
    return edgeAt(this.edges, at, GRAB / this.canvas.viewport.scale)?.edge.id ?? null;
  }

  /** How far, in screen pixels, the pointer has pulled the grabbed arrowhead off its target. */
  private awayFromArrow(event: PointerEvent): number {
    const drag = this.drag;
    if (drag?.kind !== 'unwire') return 0;
    const end = this.edges.find((r) => r.id === drag.edge)?.points.at(-1);
    if (!end) return 0;
    const at = this.worldAt(event.clientX, event.clientY);
    return Math.hypot(at.x - end.x, at.y - end.y) * this.canvas.viewport.scale;
  }

  private paintGesture(): void {
    this.paint();
    this.paintNotice();
  }

  // -------------------------------------------------------------------------
  // Writes — every one of them a command
  // -------------------------------------------------------------------------

  /**
   * A click on a card selects the scene and seeds a composer scoped to it. Both are reads, and the
   * seed is text in a field rather than a turn. The seed is written even when the selection did not
   * move, so clicking the card that is already open asks about it again.
   */
  private openScene(sceneId: string): void {
    seed(`Revise scene ${sceneId} — `);
    this.selectScene(sceneId);
  }

  /** Move the shared selection onto a card, which is what every other surface follows. */
  private selectScene(sceneId: string): void {
    if (this.ui.sceneId === sceneId) return;
    this.ui.sceneId = sceneId;
    this.announce();
    this.redraw();
  }

  /** What removing the selected scene would cost, from `deleteScene`'s own `check`. */
  private askDelete(scene: string, button: Button): void {
    const step = asInvocation(deleteSceneIntent(scene));
    void api.invoke('command:check', step).then((check) => {
      const refused = check.state === 'refuse';
      button.disabled = refused;
      // Its own pass, keyed on the scene: the answer lands after the bar is drawn, and the anchor
      // has to carry the refusal the button ends up wearing rather than the offer it was drawn on.
      redrawing('branches', 'delete').act(
        button,
        refused
          ? { ok: false, id: step.id, reason: check.message }
          : { ok: true, ...step, label: `delete ${scene}` },
        () => void this.deleteScene(scene),
      );
      const notice = noticeForCheck(check);
      if (!notice) return;
      button.description = notice.text;
    });
  }

  /**
   * Remove the selected scene and move the selection off it, because every other editor shares
   * that selection and would otherwise open a scene that no longer exists. `this.story` is still
   * the pre-delete graph when the selection moves, so it says which scenes are left.
   */
  private async deleteScene(scene: string): Promise<void> {
    const before = this.story;
    if (!(await this.run(asInvocation(deleteSceneIntent(scene)), `Removed ${scene}.`))) return;
    this.ui.sceneId = selectionAfterDelete(before, scene) ?? '';
    this.announce();
    this.redraw();
  }

  private startNaming(): void {
    this.naming = proposeScene(this.story);
    this.redraw();
    this.namerEl?.querySelector('input')?.focus();
  }

  /** Write the named scene, then select it. */
  private async write(): Promise<void> {
    const asked = this.naming;
    if (!asked) return;
    this.naming = null;
    if (!(await this.run(asInvocation(newSceneIntent(asked)), `Wrote ${asked.scene}.`))) {
      this.redraw();
      return;
    }
    this.ui.sceneId = asked.scene;
    this.announce();
    this.redraw();
  }

  /**
   * The strip that names a scene before it exists. It is not on the canvas because a card with no
   * scene behind it has no position, and position is not semantic here.
   */
  private syncNamer(): void {
    if (!this.naming) {
      this.namerEl?.remove();
      this.namerEl = undefined;
      return;
    }
    if (this.namerEl) return;

    const box = el('div', 'branch-name');
    const keys = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Enter') void this.write();
      if (event.key === 'Escape') {
        this.naming = null;
        this.redraw();
      }
    };
    const field = (className: string, label: string, value: string, set: (v: string) => void) => {
      const input = el('input', className) as HTMLInputElement;
      input.setAttribute('aria-label', label);
      input.title = `${label}. Enter writes the scene, Escape gives up.`;
      input.value = value;
      input.addEventListener('input', () => set(input.value));
      input.addEventListener('keydown', keys);
      box.appendChild(input);
    };

    field('np', "The new scene's id", this.naming.scene, (v) => {
      if (this.naming) this.naming.scene = v;
    });
    field('np wide', "The new scene's heading", this.naming.heading, (v) => {
      if (this.naming) this.naming.heading = v;
    });

    const go = el('button', 'go', 'Write it');
    go.title = 'Create the scene file and put it on the graph, connected to nothing';
    // Its own pass: the row appears and vanishes without the bar being redrawn, and a detached
    // node is dropped from the live set rather than reported as scrolled away.
    redrawing('branches', 'naming').record(go, {
      ok: true,
      ...asInvocation(newSceneIntent(this.naming)),
    });
    go.addEventListener('click', () => void this.write());
    const no = el('button', 'no', 'Cancel');
    no.title = 'Abandon the new scene. Nothing is written.';
    no.addEventListener('click', () => {
      this.naming = null;
      this.redraw();
    });
    box.appendChild(go);
    box.appendChild(no);

    this.namerEl = box;
    this.surface.insertBefore(box, this.surface.firstChild);
  }

  private openLabel(edge: StoryEdge | undefined): void {
    if (!edge) return;
    this.settled = false;
    this.editing = edge.id;
    this.selected = edge.id;

    const input = el('input', 'edge-input') as HTMLInputElement;
    input.title = 'What this choice reads as in the game. Enter renames it, Escape leaves it.';
    input.value = edge.label ?? '';
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    // Enter and Escape finish the edit themselves; `blur()` does nothing when the input is not the
    // active element, so blur is the click-away path only and must not commit a settled edit twice.
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') this.commitLabel(edge, input.value);
      if (event.key === 'Escape') this.closeLabel();
    });
    // Click-away commits, as a text field should. `paint` re-parents this input and a removal
    // costs it the focus, so a blur raised by our own redraw is not the author leaving it.
    input.addEventListener('blur', () => {
      if (!this.settled && !this.repainting) this.commitLabel(edge, input.value);
    });
    this.labelInput = input;
    this.redraw();
  }

  /** Finish an open label the way clicking away from it does, keeping what was typed. */
  private settleLabel(): void {
    const edge = this.editing ? this.edgeById.get(this.editing) : undefined;
    if (edge && this.labelInput) this.commitLabel(edge, this.labelInput.value);
    else this.closeLabel();
  }

  private closeLabel(): void {
    if (!this.editing) return;
    this.settled = true;
    this.editing = null;
    this.labelInput = undefined;
    this.redraw();
  }

  private commitLabel(edge: StoryEdge, text: string): void {
    const trimmed = text.trim();
    this.closeLabel();
    if (!trimmed || trimmed === edge.label) return;
    const decision = relabel(this.state.scenes, edge, trimmed);
    if (!decision.ok) return this.say({ tone: 'refused', text: decision.reason });
    void this.run({ id: decision.intent.id, props: decision.intent.props }, decision.intent.note);
  }

  private async run(invocation: Invocation, fallback: string): Promise<boolean> {
    // Goes through the bridge rather than `command:exec`: connecting two cards rewrites a scene,
    // and every surface watching for that (the document tree first of all) hears it from `exec`'s
    // invalidate. Invoking the channel directly writes the file and notifies nothing
    const outcome = await exec(invocation.id, invocation.props);
    if (!outcome.ok) {
      this.say({ tone: 'refused', text: outcome.error });
      return false;
    }
    this.notice = { tone: 'ok', text: outcome.record.message ?? fallback };
    // `story.*` commands answer with the rebuilt graph, so reachability is never a beat behind.
    if (outcome.data) this.story = outcome.data as StoryGraph;
    else await this.load();
    this.rebuild();
    void refreshWorkspace();
    return true;
  }

  private say(notice: Notice | null): void {
    this.notice = notice;
    this.paintNotice();
  }
}

/** The empty graph, so `route` has something to project when nothing has loaded. */
const EMPTY_STORY: StoryGraph = { scenes: [], edges: [], diagnostics: [] };

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Draws a `next` the runner will never follow struck through, because it is inert, not gone. */
function wireStyle(edge: EdgeRoute): EdgeStyle {
  if (edge.kind === 'inert') {
    return { stroke: TOKENS.mistDim, width: 1, dash: '3 4', opacity: 0.45 };
  }
  if (edge.kind === 'choice') return { stroke: TOKENS.sodium, width: 2, opacity: 0.75 };
  return { stroke: TOKENS.mistDim, width: 1 };
}

/**
 * One scene as an index card. The id is machine-side, the synopsis is authored, and the cast line
 * says who is in the scene without opening it.
 */
function sceneCard(
  scene: StoryScene,
  entry: boolean,
  selected: boolean,
  ghost = false,
): HTMLElement {
  const classes = ['scene-card'];
  if (!scene.reachable) classes.push('dead');
  if (entry) classes.push('entry');
  if (selected) classes.push('sel');
  if (ghost) classes.push('carried');

  const box = el('article', classes.join(' '));
  const acts = 'click to select it, right-click to open its script, drag it to lay the graph out';
  box.title = scene.reachable
    ? `${scene.id} — ${acts}`
    : `${scene.id} — nothing reaches this scene; ${acts}`;

  const head = el('header');
  head.appendChild(el('span', 'id', scene.id));
  head.appendChild(el('span', 'loc', scene.location));
  box.appendChild(head);

  const synopsis = el('p', 'synopsis');
  if (scene.synopsis) synopsis.textContent = scene.synopsis;
  else synopsis.appendChild(el('span', 'unwritten', 'no synopsis'));
  box.appendChild(synopsis);

  const foot = el('footer');
  foot.appendChild(el('span', 'cast', scene.characters.join(' · ') || '—'));
  foot.appendChild(el('span', 'lines', `${scene.lines}L`));
  box.appendChild(foot);

  const handle = el('span', 'handle');
  handle.setAttribute('aria-hidden', 'true');
  box.appendChild(handle);
  return box;
}

/** The stand-in for a `goto` with no scene behind it. Never a drop target — there is no scene. */
function stubCard(id: string): HTMLElement {
  const box = el('div', 'scene-stub');
  box.title = `${id} — no scene by that name; right-click to write it`;
  box.appendChild(el('span', 'id', id));
  box.appendChild(el('span', 'tag', 'unwritten'));
  return box;
}

function el(tag: string, className = '', text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(BranchEditor, 'vn.BranchEditor');

import type { Container } from 'pathux';
import { api } from '../../api.js';
import { routeEdges } from '../../graph/edges.js';
import { layoutGraph, type GraphLayout } from '../../graph/layout.js';
import {
  BARRIER_ID,
  taskGraphOf,
  type TaskGraphModel,
  type TaskNodeView,
} from '../../rules/taskGraph.js';
import { card, dot, mono, row, stamp, statusColour, subject } from '../dom.js';
import { VnEditor, registerEditor } from '../editor.js';
import { GraphCanvas, type EdgeStyle } from '../graph/canvas.js';
import { isSelected, selectionForTask, type Selection } from '../selection.js';
import { openPalette } from '../palette.js';
import { TOKENS, alpha } from '../tokens.js';
import type { EdgeRoute } from '../../graph/edges.js';
import type { Pick as GraphPick } from '../../graph/hit.js';
import type { LaidOutNode } from '../../graph/types.js';
import type { PipelineStatus, StoryGraph } from '../../../src/shared/ipc.js';

/**
 * The pipeline as a DAG. The derivation is untouched — `rules/taskGraph.ts` still says
 * what the gate barrier, the ref edges and the ghost clusters are, and its tests still pin
 * them — so this editor is the React `TaskGraphView`'s markup rebuilt on `GraphCanvas` and
 * nothing more.
 *
 * The gate is drawn as a rule across the layout rather than as a node with wires, because it is
 * not a dependency: it is a planner predicate, and a wire would claim a coupling the data does
 * not have. Its *position* is a real rank, though — see `taskGraphOf`.
 *
 * Selection is the shell's, not the editor's: clicking a shot task moves `ui.shotId`/`ui.sceneId`
 * and clicking a character task moves `ui.characterId`, and the highlight is derived back out of
 * those ids — so a shot picked here is the shot the runner plays, and vice versa.
 */
export class TaskGraphEditor extends VnEditor {
  private bar!: Container;
  private canvas!: GraphCanvas;

  private status: PipelineStatus | undefined;
  /** The story graph is what makes ghosts derivable; without it the view is merely quieter. */
  private story: StoryGraph | null = null;
  private failure = '';

  private model: TaskGraphModel | undefined;
  private layout: GraphLayout | undefined;
  private routes: EdgeRoute[] = [];

  /** Fit once, when the first layout meets a sized surface — never again, or panning fights back. */
  private fitted = false;
  private drawn = '';

  static override define() {
    return {
      tagname: 'vn-graph-editor-x',
      areaname: 'taskgraph',
      uiname: 'Task Graph',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.canvas = new GraphCanvas({
      edgeStyle: wireStyle,
      onPick: (hit) => this.onPick(hit),
      onSurfaceChange: () => this.fitOnce(),
    });
    this.appendSurface(this.canvas.element);

    void this.load();
  }

  override update() {
    super.update();

    // The selection can move in any editor, and the highlight is derived from it.
    if (this.stateKey() !== this.drawn) this.redraw();
  }

  private async load(): Promise<void> {
    try {
      const [status, story] = await Promise.all([
        api.invoke('pipeline:status'),
        api.invoke('story:graph'),
      ]);
      this.status = status;
      this.story = story;
      this.failure = '';
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
    }
    this.rebuild();
  }

  /** Recompute the derivation, then the layout, then draw. */
  private rebuild(): void {
    const status = this.status;
    if (status) {
      this.model = taskGraphOf(status, this.story);
      this.layout = layoutGraph(this.model.graph);
      this.routes = routeEdges(this.layout, this.model.edges);
    }
    this.fitted = false;
    this.redraw();
    this.fitOnce();
  }

  private fitOnce(): void {
    if (this.fitted || !this.layout || this.layout.nodes.length === 0 || !this.canvas.surface) {
      return;
    }
    this.fitted = true;
    this.canvas.fitToContent();
  }

  /** The shared selection alone — `ShellState` carries header facts a graph has no use for. */
  private selection(): Selection {
    const ui = this.ui;
    return {
      sceneId: ui.sceneId,
      shotId: ui.shotId,
      characterId: ui.characterId,
      docPath: ui.docPath,
      assetHash: ui.assetHash,
    };
  }

  private stateKey(): string {
    const ui = this.ui;
    return [
      this.failure,
      this.status?.tasks.length ?? -1,
      this.model?.ghosts.length ?? -1,
      ui.sceneId,
      ui.shotId,
      ui.characterId,
    ].join('|');
  }

  private redraw(): void {
    this.drawn = this.stateKey();
    this.rebuildBar();

    const layout = this.layout;
    if (!layout) return;

    this.canvas.setOverlay(this.gateRule(layout));
    this.canvas.setContent({
      layout,
      edges: this.routes,
      renderNode: (node) => this.renderNode(node),
    });
  }

  private rebuildBar(): void {
    const ghosts = this.model?.ghosts.length ?? 0;
    const tasks = this.status?.tasks.length ?? 0;

    this.bar.clear();
    this.bar.label('TASK GRAPH').style['padding'] = '0px 8px';
    this.bar.label(
      this.failure
        ? this.failure
        : `${tasks} task${tasks === 1 ? '' : 's'}${ghosts > 0 ? ` · ${ghosts} not yet planned` : ''}`,
    ).style['padding'] = '0px 8px';

    this.bar.button('Fit', () => {
      this.fitted = false;
      this.fitOnce();
    });
    this.bar.button('Refresh', () => void this.load());
    this.bar.flushUpdate();
  }

  /**
   * The gate as a rule across the whole graph, overhanging the bounds so it reads as spanning
   * rather than as one more node's width.
   */
  private gateRule(layout: GraphLayout): SVGSVGElement | undefined {
    const gate = this.model?.barrier ? layout.byId.get(BARRIER_ID) : undefined;
    if (!gate) return undefined;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    Object.assign(svg.style, { position: 'absolute', inset: '0', overflow: 'visible' });
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const y = gate.y + gate.height / 2;
    line.setAttribute('x1', String(layout.bounds.x - RULE_OVERHANG));
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(layout.bounds.x + layout.bounds.width + RULE_OVERHANG));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', alpha(TOKENS.sodium, 0.45));
    line.setAttribute('stroke-dasharray', '7 6');
    svg.appendChild(line);
    return svg;
  }

  private onPick(hit: GraphPick): void {
    if (hit.type !== 'node') return;
    const view = this.model?.nodes.get(hit.node.id);
    // Only real tasks are addressable: a ghost is a cluster of work that does not exist yet,
    // and the barrier's own affordance is the approve button drawn on it.
    if (view?.kind !== 'task') return;

    // The hash moves for every task, including the ones that name no scene or character: the
    // inspector's subject is the task itself, so a click on an export is still worth something.
    this.ui.taskHash = view.task.hash;

    const current = this.selection();
    const next = selectionForTask(view.task, current);
    // The rule hands back the same object when a task names nothing selectable, so identity is
    // the test for "this click changed nothing" in the authored ids.
    if (next !== current) {
      this.ui.sceneId = next.sceneId;
      this.ui.shotId = next.shotId;
      this.ui.characterId = next.characterId;
    }
    this.announce();
  }

  private renderNode(node: LaidOutNode): HTMLElement | null {
    const view = this.model?.nodes.get(node.id);
    if (!view) return null;
    if (view.kind === 'barrier') return this.gateNode(view.pending);
    if (view.kind === 'ghost') return ghostNode(view);
    return taskNode(view, isSelected(view, this.selection()));
  }

  private gateNode(pending: string[]): HTMLElement {
    const box = nodeCard();
    Object.assign(box.style, {
      flexDirection: 'row',
      alignItems: 'center',
      gap: '10px',
      padding: '0px 12px',
      border: `1px dashed ${alpha(TOKENS.sodium, 0.55)}`,
      background: TOKENS.ink,
    });

    box.appendChild(stamp('⟂ GATE', TOKENS.sodium));
    // The gate is an inference, not an edge — say so on it rather than in a legend.
    box.appendChild(mono('derived', TOKENS.mistDim, 9.5));

    for (const character of pending) {
      const cta = document.createElement('button');
      cta.textContent = `${character} →`;
      cta.title = `Approve a portrait for ${character}`;
      Object.assign(cta.style, {
        // The node layer is `pointer-events: none`; this is the one element that needs a real
        // DOM target, so it opts itself back in.
        pointerEvents: 'auto',
        marginLeft: 'auto',
        maxWidth: '96px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        padding: '3px 9px',
        color: TOKENS.paper,
        background: TOKENS.inkRaised,
        border: `1px solid ${TOKENS.inkLine}`,
        borderRadius: `${TOKENS.radiusChrome}px`,
        fontFamily: TOKENS.mono,
        fontSize: '11px',
      });
      cta.addEventListener('click', (event) => {
        event.stopPropagation();
        this.resolve(character);
      });
      box.appendChild(cta);
    }
    return box;
  }

  /**
   * The gate's one affordance: name the character in the shared selection, then open the
   * approval command on them. `gate.approve` also needs the candidate hash — which portrait is
   * the author's judgement, not the graph's — so the palette's form is where it is answered,
   * and this editor writes nothing.
   */
  private resolve(characterId: string): void {
    this.ui.characterId = characterId;
    this.announce();
    openPalette('gate.approve', { characterId });
  }
}

/** How far past the outermost node the gate rule runs, so it reads as spanning the graph. */
const RULE_OVERHANG = 64;

/** Solid is what the scheduler orders on; dashed is what actually fed the prompt. */
function wireStyle(edge: EdgeRoute): EdgeStyle {
  if (edge.kind === 'dep') return { stroke: TOKENS.signalDeep, width: 1.5 };
  if (edge.kind === 'ref') return { stroke: TOKENS.mistDim, width: 1, dash: '4 4' };
  if (edge.kind === 'ghost') return { stroke: TOKENS.inkLine, width: 1, dash: '2 5' };
  return { stroke: TOKENS.mistDim, width: 1.5 };
}

/** A node fills the box the layout gave it, unlike a card in a list. */
function nodeCard(): HTMLDivElement {
  const box = card();
  box.style.height = '100%';
  return box;
}

function taskNode(view: Extract<TaskNodeView, { kind: 'task' }>, selected: boolean): HTMLElement {
  const colour = statusColour(view.task.status);
  const box = nodeCard();
  box.style.borderLeft = `2px solid ${colour}`;
  if (selected) {
    box.style.borderColor = TOKENS.signal;
    box.style.boxShadow = `0 0 0 1px ${TOKENS.signalDeep}`;
    box.style.borderLeftColor = colour;
  }

  const head = row();
  head.appendChild(dot(colour));
  head.appendChild(mono(view.task.kind, TOKENS.mist));
  const hash = mono(view.task.hash.slice(0, 8), TOKENS.mistDim);
  hash.style.marginLeft = 'auto';
  head.appendChild(hash);

  box.appendChild(head);
  box.appendChild(subject(view.subject, TOKENS.paper));
  return box;
}

/**
 * Work the planner cannot emit yet, drawn as an approximate cluster — hatched and dashed, so
 * it never reads as a node that might turn out not to exist.
 */
function ghostNode(view: Extract<TaskNodeView, { kind: 'ghost' }>): HTMLElement {
  const box = nodeCard();
  Object.assign(box.style, {
    border: `1px dashed ${view.ghost.gated ? alpha(TOKENS.sodium, 0.4) : TOKENS.inkLine}`,
    background: `repeating-linear-gradient(135deg, ${alpha(TOKENS.signal, 0.04)} 0 8px, transparent 8px 16px)`,
  });

  const head = row();
  head.appendChild(mono('not yet planned', TOKENS.mistDim));
  if (view.ghost.count !== undefined) {
    const count = mono(`~${view.ghost.count}`, TOKENS.mistDim);
    count.style.marginLeft = 'auto';
    head.appendChild(count);
  }

  box.appendChild(head);
  box.appendChild(subject(view.ghost.label, TOKENS.mistDim));
  return box;
}

registerEditor(TaskGraphEditor, 'vn.TaskGraphEditor');

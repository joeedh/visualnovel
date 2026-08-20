import type { Check, Container } from 'pathux';
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
import { openCommandDialog } from '../dialog.js';
import { TOKENS, alpha } from '../tokens.js';
import type { EdgeRoute } from '../../graph/edges.js';
import type { Pick as GraphPick } from '../../graph/hit.js';
import type { LaidOutNode } from '../../graph/types.js';
import type { PipelineStatus, SlotNode, StoryGraph } from '../../../src/shared/ipc.js';

/**
 * The pipeline as a DAG. The derivation lives in `rules/taskGraph.ts` — what the gate barrier is,
 * what the ref edges are, and which slots the planner has not filed work for yet — so this editor
 * is only markup over `GraphCanvas`.
 *
 * The gate is drawn as a rule across the layout rather than as a node with wires, because it is a
 * planner predicate rather than a dependency and a wire would claim a coupling the data does not
 * have. Its position is a real rank, though — see `taskGraphOf`.
 *
 * Selection belongs to the shell, not to this editor: clicking a shot task moves
 * `ui.shotId`/`ui.sceneId` and clicking a character task moves `ui.characterId`, and the
 * highlight is derived back out of those ids, so a shot picked here is the shot the runner plays.
 */
export class TaskGraphEditor extends VnEditor {
  private bar!: Container;
  private canvas!: GraphCanvas;

  private status: PipelineStatus | undefined;
  /** Read only by the barrier's un-approved-after-planning case, which is undetectable without it. */
  private story: StoryGraph | null = null;
  private failure = '';

  private model: TaskGraphModel | undefined;
  private layout: GraphLayout | undefined;
  private routes: EdgeRoute[] = [];

  /**
   * Straighten the columns as well as ordering them. A view setting, not a model one — the graph
   * is identical either way, so this persists with the pane rather than with the project.
   */
  tidy = false;

  /** Fit once, when the first layout meets a sized surface; refitting later would undo panning. */
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
      this.layout = layoutGraph(this.model.graph, { tidy: this.tidy });
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
      this.model?.unplanned.length ?? -1,
      ui.sceneId,
      ui.shotId,
      ui.characterId,
      this.tidy ? 'tidy' : 'plain',
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
    const unplanned = this.model?.unplanned.length ?? 0;
    const tasks = this.status?.tasks.length ?? 0;

    this.bar.clear();
    this.bar.label('TASK GRAPH').style['padding'] = '0px 8px';
    this.bar.label(
      this.failure
        ? this.failure
        : `${tasks} task${tasks === 1 ? '' : 's'}${unplanned > 0 ? ` · ${unplanned} not yet planned` : ''}`,
    ).style['padding'] = '0px 8px';

    const tidy = this.bar.check(undefined, 'Tidy') as Check;
    tidy.checked = this.tidy;
    tidy.description =
      'Straighten the columns so edges run more directly. The graph itself is unchanged — only where it is drawn.';
    tidy.on_change = (next: unknown) => {
      this.tidy = next === true;
      // A relayout, not a redraw: the coordinates themselves are what changes.
      this.rebuild();
    };

    this.bar.button('Fit', () => {
      this.fitted = false;
      this.fitOnce();
    }).description = 'Zoom out until the whole graph is on screen';
    this.bar.button('Refresh', () => void this.load()).description =
      'Re-read the task log and replan what is ready';
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
    // A slot is a picture with a real address, so it moves the selection the way a task does. The
    // barrier's own affordance is the approve button drawn on it, so clicking it does nothing here.
    if (view?.kind === 'slot') return this.pickSlot(view.slot);
    if (view?.kind !== 'task') return;

    // The hash moves for every task, including the ones that name no scene or character, because
    // the inspector's subject is the task itself and a click on an export still selects one.
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

  /**
   * A slot names a subject the way a task does, without a task hash because there is no task. The
   * asset hash moves too when something already fills the slot, so clicking an unapproved picture
   * here opens it in the asset editor rather than only highlighting a box.
   */
  private pickSlot(slot: SlotNode): void {
    const binding = slot.binding;
    if (binding.kind === 'shot') {
      this.ui.sceneId = binding.sceneId;
      this.ui.shotId = binding.shotId;
    } else if (binding.kind === 'portrait' || binding.kind === 'sheet') {
      this.ui.characterId = binding.characterId;
    }
    if (slot.hash) this.ui.assetHash = slot.hash;
    this.announce();
  }

  private renderNode(node: LaidOutNode): HTMLElement | null {
    const view = this.model?.nodes.get(node.id);
    if (!view) return null;
    if (view.kind === 'barrier') return this.gateNode(view.pending);
    if (view.kind === 'slot') return slotNode(view);
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
    // The gate is an inference rather than an edge, and the node says so in place of a legend.
    box.appendChild(mono('derived', TOKENS.mistDim, 9.5));

    for (const character of pending) {
      const cta = document.createElement('button');
      cta.textContent = `${character} →`;
      cta.title = `Approve a portrait for ${character}`;
      Object.assign(cta.style, {
        // The node layer is `pointer-events: none`, and this button is the one element that needs
        // a real DOM target.
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
   * The gate's one affordance: put the character in the shared selection, then open the approval
   * command on them. `gate.approve` also needs the candidate hash, and which portrait to approve
   * is the author's judgement rather than the graph's, so the command's own dialog asks for it and
   * this editor writes nothing.
   */
  private resolve(characterId: string): void {
    this.ui.characterId = characterId;
    this.announce();
    openCommandDialog('gate.approve', { characterId });
  }
}

/** How far past the outermost node the gate rule runs, so it reads as spanning the graph. */
const RULE_OVERHANG = 64;

/**
 * Solid edges are the dependencies the scheduler orders on; dashed edges are the refs that fed
 * the prompt.
 */
function wireStyle(edge: EdgeRoute): EdgeStyle {
  if (edge.kind === 'dep') return { stroke: TOKENS.signalDeep, width: 1.5 };
  if (edge.kind === 'ref') return { stroke: TOKENS.mistDim, width: 1, dash: '4 4' };
  if (edge.kind === 'slot') return { stroke: TOKENS.inkLine, width: 1, dash: '2 5' };
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
 * A picture the project implies that no task has been filed for. It is hatched and dashed so it
 * never reads as work in flight, and it is labelled with its own subject because it stands for one
 * picture with a real address rather than for a cluster.
 */
function slotNode(view: Extract<TaskNodeView, { kind: 'slot' }>): HTMLElement {
  const slot = view.slot;
  const box = nodeCard();
  Object.assign(box.style, {
    border: `1px dashed ${slot.blocked ? alpha(TOKENS.sodium, 0.4) : TOKENS.inkLine}`,
    background: `repeating-linear-gradient(135deg, ${alpha(TOKENS.signal, 0.04)} 0 8px, transparent 8px 16px)`,
  });

  const head = row();
  head.appendChild(
    mono(slot.candidates.length ? 'awaiting approval' : 'not yet planned', TOKENS.mistDim),
  );
  if (slot.candidates.length > 1) {
    const count = mono(`${slot.candidates.length} drafts`, TOKENS.mistDim);
    count.style.marginLeft = 'auto';
    head.appendChild(count);
  }

  box.appendChild(head);
  box.appendChild(subject(slot.label, TOKENS.mistDim));
  return box;
}

registerEditor(TaskGraphEditor, 'vn.TaskGraphEditor', ['tidy : bool']);

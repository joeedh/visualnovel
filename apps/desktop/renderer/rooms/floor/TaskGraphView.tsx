/**
 * FLOOR's other surface: the same tasks as a DAG. Thin by design — the layout, routing and
 * hit-testing come from `renderer/graph/`, and everything the graph knows that `Task[]` does
 * not say is derived in `taskGraph.ts`.
 *
 * The gate is drawn as a rule across the whole layout rather than as a node with wires, because
 * it is not a dependency: it is a planner predicate, and a wire would claim a coupling the data
 * doesn't have. The rule's *position* is a real rank, though — see `taskGraphOf`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { Canvas } from '../../graph/Canvas';
import { routeEdges } from '../../graph/edges.js';
import { layoutGraph } from '../../graph/layout.js';
import { fit, IDENTITY, type Viewport } from '../../graph/viewport.js';
import { BARRIER_ID, taskGraphOf, type TaskNodeView } from './taskGraph.js';
import type { Pick as GraphPick } from '../../graph/hit.js';
import type { LaidOutNode, Size } from '../../graph/types.js';
import type { PipelineStatus, StoryGraph } from '../../../src/shared/ipc';

const EMPTY: PipelineStatus = { tasks: [], gatePending: [], blockedOnGate: false };
/** How far past the outermost node the gate rule runs, so it reads as spanning the graph. */
const RULE_OVERHANG = 64;

export function TaskGraphView(props: {
  status: PipelineStatus | null;
  selected: string | null;
  onSelect: (hash: string) => void;
  onResolve: (characterId: string) => void;
}): JSX.Element {
  const [story, setStory] = useState<StoryGraph | null>(null);
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [surface, setSurface] = useState<Size | null>(null);

  // The story graph is what makes the ghosts derivable; without it the view is still correct,
  // just silent about work that isn't plannable yet.
  useEffect(() => {
    void api.invoke('story:graph').then(setStory);
  }, []);

  const model = useMemo(() => taskGraphOf(props.status ?? EMPTY, story), [props.status, story]);
  const layout = useMemo(() => layoutGraph(model.graph), [model.graph]);
  const routes = useMemo(() => routeEdges(layout, model.edges), [layout, model.edges]);

  const fitted = useRef(false);
  const refit = useCallback(
    (size: Size | null) => {
      if (!size || layout.nodes.length === 0) return;
      setViewport(fit(layout.bounds, size, { maxScale: 1 }));
    },
    [layout],
  );
  useEffect(() => {
    if (fitted.current || !surface || layout.nodes.length === 0) return;
    fitted.current = true;
    refit(surface);
  }, [layout, refit, surface]);

  const onPick = useCallback(
    (hit: GraphPick): void => {
      if (hit.type !== 'node') return;
      const view = model.nodes.get(hit.node.id);
      // Only real tasks are addressable: a ghost is a cluster of work that doesn't exist yet,
      // and the barrier's own affordance is the RESOLVE button on it.
      if (view?.kind === 'task') props.onSelect(view.id);
    },
    [model, props],
  );

  const renderNode = useCallback(
    (node: LaidOutNode) => {
      const view = model.nodes.get(node.id);
      if (!view) return null;
      return (
        <TaskNode view={view} selected={view.id === props.selected} onResolve={props.onResolve} />
      );
    },
    [model, props.selected, props.onResolve],
  );

  const gate = model.barrier ? layout.byId.get(BARRIER_ID) : undefined;
  const ghosts = model.ghosts.length;

  if (layout.nodes.length === 0) {
    return <div className="insp-empty tg-empty">No tasks yet — run the pipeline.</div>;
  }

  return (
    <div className="taskgraph">
      <div className="tg-bar">
        <span className="tt">TASK GRAPH</span>
        <span className="ct">
          {props.status?.tasks.length ?? 0} tasks
          {ghosts > 0 ? ` · ${ghosts} not yet planned` : ''}
        </span>
        <button className="ghost" onClick={() => refit(surface)} title="Fit to view">
          ⤢
        </button>
      </div>
      <Canvas
        className="tg-canvas"
        layout={layout}
        edges={routes}
        viewport={viewport}
        onViewportChange={setViewport}
        onSurface={setSurface}
        onPick={onPick}
        renderNode={renderNode}
        overlay={
          gate ? (
            <svg className="tg-overlay" aria-hidden="true">
              <line
                className="gate-rule"
                x1={layout.bounds.x - RULE_OVERHANG}
                y1={gate.y + gate.height / 2}
                x2={layout.bounds.x + layout.bounds.width + RULE_OVERHANG}
                y2={gate.y + gate.height / 2}
              />
            </svg>
          ) : null
        }
      />
    </div>
  );
}

function TaskNode(props: {
  view: TaskNodeView;
  selected: boolean;
  onResolve: (characterId: string) => void;
}): JSX.Element {
  const { view } = props;

  if (view.kind === 'barrier') {
    return (
      <div className="tg-gate">
        <span className="gt">⟂ GATE</span>
        {/* The gate is an inference, not an edge — say so on it rather than in a legend. */}
        <span className="derived">derived</span>
        {view.pending.map((c) => (
          <button
            key={c}
            className="gate-cta"
            title={`Approve a portrait for ${c}`}
            onClick={() => props.onResolve(c)}
          >
            {c} →
          </button>
        ))}
      </div>
    );
  }

  if (view.kind === 'ghost') {
    return (
      <div className={`tg-node ghost${view.ghost.gated ? ' gated' : ''}`}>
        <div className="row">
          <span className="kind">not yet planned</span>
          {view.ghost.count !== undefined && <span className="h">~{view.ghost.count}</span>}
        </div>
        <div className="subj">{view.ghost.label}</div>
      </div>
    );
  }

  return (
    <div className={`tg-node ${view.task.status}${props.selected ? ' sel' : ''}`}>
      <div className="row">
        <span className="d" />
        <span className="kind">{view.task.kind}</span>
        <span className="h">{view.task.hash.slice(0, 8)}</span>
      </div>
      <div className="subj">{view.subject}</div>
    </div>
  );
}
